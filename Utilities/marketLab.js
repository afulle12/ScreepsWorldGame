/**
 * marketLab.js
 *
 * Consolidated lab market operations (replaces marketLabForward.js + marketLabReverse.js).
 *
 *   FORWARD: Buy reagents -> Combine in labs -> Sell compound
 *   REVERSE: Buy compound -> Break down in labs -> Sell reagents
 *
 * STATE MACHINE (both directions):
 *   BUYING -> WAITING -> PROCESSING -> SELLING -> removed from queue
 *
 * CONSOLE COMMANDS (signatures preserved):
 *   labForward()                          Show all forward ops
 *   labForward('E3N46')                   Show forward ops in a room
 *   labForward('E3N46', 'ZO')             Queue forward op for ZO in E3N46
 *   labForward('ZO')                      Queue forward op (auto-pick room)
 *   labForward('stop'|'reset'|'check' ...)
 *
 *   labReverse(...)                       Same shape, plus an optional
 *   labReverse('E3N46', 'ZO', maxPrice)   max-buy-price for reverse buys.
 *   stopAllLab()                          Cancels all labs
 */

var opportunisticBuy = require('opportunisticBuy');
var getRoomState     = require('getRoomState');
var marketBuyer      = require('marketBuy');
var storageManager   = require('storageManager');

// ===== Buy-path dispatcher shims =====
// Delegate to marketRefine's globals (set there in v3) so the cheap/stable path
// uses marketBuy and the expensive/volatile path uses opportunisticBuy. The
// functions return safe fallbacks if marketRefine hasn't loaded yet.
function labShouldUseMarketBuy(output, input, ceiling) {
    if (typeof global.marketRefineShouldUseMarketBuy === 'function')
        return !!global.marketRefineShouldUseMarketBuy(output, input, ceiling);
    return false;
}
function labComputeBid(input, ceiling) {
    if (typeof global.marketRefineComputeBidPrice === 'function')
        return global.marketRefineComputeBidPrice(input, ceiling);
    return (typeof ceiling === 'number' && ceiling > 0) ? ceiling : 0.001;
}
// Top-up threshold: if marketBuy fills <25% of the gap after one reaction window,
// fire a one-shot opportunistic deal for the rest so the lab doesn't stall.
var LAB_MARKETBUY_TOPUP_RATIO = 0.25;
var LAB_MARKETBUY_TOPUP_GATE  = 50;  // min ticks between top-up checks per op

// =========================================================================
// CONSTANTS
// =========================================================================

var LAB_CAPACITY        = 3000;
var LAB_REACTION_AMOUNT = 5;
var DEFAULT_BATCH_SIZE  = 3000;
var MAX_BATCH_SIZE      = 3000;

var STATE_BUYING     = 'BUYING';
var STATE_WAITING    = 'WAITING';
var STATE_PROCESSING = 'PROCESSING';
var STATE_STAGING    = 'STAGING';
var STATE_SELLING    = 'SELLING';

var DIR_FORWARD = 'forward';
var DIR_REVERSE = 'reverse';

var MEMORY_VERSION = 2;
var SELLING_GRACE_TICKS = 200;  // wait at most this long for output evacuation before selling anyway
var STAGING_GRACE_TICKS = 200;  // wait for supplier/lab evacuation before accepting partial output

// =========================================================================
// MEMORY ACCESS + MIGRATION
// =========================================================================

function memKey(direction) {
    return direction === DIR_FORWARD ? 'marketLabForward' : 'marketLabReverse';
}

function migrateOperation(op, direction) {
    if (!op || typeof op !== 'object') return;

    // Legacy forward used 'buyRequestsCreated' (plural).
    if (op.buyRequestsCreated !== undefined && op.buyRequestCreated === undefined) {
        op.buyRequestCreated = op.buyRequestsCreated;
        delete op.buyRequestsCreated;
    }
    // Legacy reverse used 'sellOrdersCreated' (plural).
    if (op.sellOrdersCreated !== undefined && op.sellOrderCreated === undefined) {
        op.sellOrderCreated = op.sellOrdersCreated;
        delete op.sellOrdersCreated;
    }
    // Legacy reverse used 'breakdownStarted'.
    if (op.breakdownStarted !== undefined && op.reactionStarted === undefined) {
        op.reactionStarted = op.breakdownStarted;
        delete op.breakdownStarted;
    }
    // Salvage flag from legacy forward.
    if (op.salvageMode === undefined) op.salvageMode = false;
    if (!op.direction) op.direction = direction;
}

function ensureMemory(direction) {
    var key = memKey(direction);
    if (!Memory[key]) {
        Memory[key] = { rooms: {}, version: MEMORY_VERSION };
    }
    if (!Memory[key].rooms) {
        // Handle very old reverse format that had .operations instead of .rooms.
        if (Memory[key].operations) {
            Memory[key].rooms = {};
            for (var rn in Memory[key].operations) {
                var legacyOp = Memory[key].operations[rn];
                if (legacyOp && legacyOp.active) {
                    Memory[key].rooms[rn] = [legacyOp];
                }
            }
            delete Memory[key].operations;
        } else {
            Memory[key].rooms = {};
        }
    }
    if (Memory[key].version !== MEMORY_VERSION) {
        for (var roomName in Memory[key].rooms) {
            var queue = Memory[key].rooms[roomName];
            if (Array.isArray(queue)) {
                for (var i = 0; i < queue.length; i++) {
                    migrateOperation(queue[i], direction);
                }
            }
        }
        Memory[key].version = MEMORY_VERSION;
    }
    return Memory[key];
}

function ensureRoomQueue(direction, roomName) {
    var mem = ensureMemory(direction);
    if (!mem.rooms[roomName]) mem.rooms[roomName] = [];
    return mem.rooms[roomName];
}

function getRoomQueues(roomName) {
    var fwd = (Memory.marketLabForward && Memory.marketLabForward.rooms && Memory.marketLabForward.rooms[roomName]) || [];
    var rev = (Memory.marketLabReverse && Memory.marketLabReverse.rooms && Memory.marketLabReverse.rooms[roomName]) || [];
    return { forward: fwd, reverse: rev };
}

// =========================================================================
// LAB / ROOM HELPERS
// =========================================================================

function getLabsInRoom(roomName) {
    var rs = getRoomState.get(roomName);
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_LAB]) {
        return rs.structuresByType[STRUCTURE_LAB];
    }
    var room = Game.rooms[roomName];
    if (!room) return [];
    return room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });
}

function checkLabsContaminated(roomName) {
    var labs = getLabsInRoom(roomName);
    for (var i = 0; i < labs.length; i++) {
        if ((labs[i].mineralAmount || 0) > 0) return true;
    }
    return false;
}

function calculateBatchSize(roomName) {
    var labs = getLabsInRoom(roomName);
    if (labs.length < 3) {
        return { batchSize: DEFAULT_BATCH_SIZE, outputLabCount: 1 };
    }

    var bestOutputCount = 0;
    for (var i = 0; i < labs.length; i++) {
        for (var j = i + 1; j < labs.length; j++) {
            var a = labs[i];
            var b = labs[j];
            var outputCount = 0;
            for (var k = 0; k < labs.length; k++) {
                if (k === i || k === j) continue;
                var l = labs[k];
                if (a.pos.inRangeTo(l, 2) && b.pos.inRangeTo(l, 2)) outputCount++;
            }
            if (outputCount > bestOutputCount) bestOutputCount = outputCount;
        }
    }
    if (bestOutputCount === 0) {
        return { batchSize: DEFAULT_BATCH_SIZE, outputLabCount: 1 };
    }
    return {
        batchSize:      Math.min(bestOutputCount * LAB_CAPACITY, MAX_BATCH_SIZE),
        outputLabCount: bestOutputCount
    };
}

function findReagents(compound) {
    for (var r1 in REACTIONS) {
        for (var r2 in REACTIONS[r1]) {
            if (REACTIONS[r1][r2] === compound) return [r1, r2];
        }
    }
    return [];
}

function isValidCompound(compound) {
    for (var r1 in REACTIONS) {
        for (var r2 in REACTIONS[r1]) {
            if (REACTIONS[r1][r2] === compound) return true;
        }
    }
    return false;
}

function countInRoom(roomName, resourceType) {
    var roomState = getRoomState.get(roomName);
    if (!roomState || !roomState.terminal) return 0;
    var store = roomState.terminal.store;
    if (!store) return 0;
    return store.getUsedCapacity(resourceType) || 0;
}

function parseMarketPrice(priceString) {
    if (typeof priceString !== 'string') return NaN;
    var parts = priceString.split(':');
    if (parts.length < 2) return NaN;
    var match = parts[1].trim().match(/^(\d+\.\d+)/);
    return (match && match[1]) ? parseFloat(match[1]) : NaN;
}

function findSuitableRoom() {
    var allRooms = getRoomState.all();
    for (var roomName in allRooms) {
        var state = allRooms[roomName];
        if (!state.controller || !state.controller.my) continue;
        if (state.terminal
            && state.structuresByType
            && state.structuresByType[STRUCTURE_LAB]
            && state.structuresByType[STRUCTURE_LAB].length >= 3) {
            return roomName;
        }
    }
    return null;
}

function roomHasLabsAndTerminal(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.terminal) return false;
    if (!state.structuresByType || !state.structuresByType[STRUCTURE_LAB]) return false;
    return state.structuresByType[STRUCTURE_LAB].length >= 3;
}

/**
 * True if labManager has any active OR queued order for this room.
 * This is the authoritative signal that the shared lab hardware is busy,
 * independent of marketLab's own per-op state (which can desync across
 * labManager's multi-tick run interval).
 */
function labManagerBusy(roomName) {
    return !!(Memory.labOrders
              && Memory.labOrders[roomName]
              && (Memory.labOrders[roomName].active
                  || (Memory.labOrders[roomName].queue
                      && Memory.labOrders[roomName].queue.length > 0)));
}

/**
 * True if ANY operation (forward or reverse) is currently in PROCESSING.
 * Labs can only handle one job at a time across both directions.
 */
function isRoomProcessing(roomName) {
    var q = getRoomQueues(roomName);
    for (var i = 0; i < q.forward.length; i++) {
        if (q.forward[i].state === STATE_PROCESSING) return true;
    }
    for (var j = 0; j < q.reverse.length; j++) {
        if (q.reverse[j].state === STATE_PROCESSING) return true;
    }
    return false;
}

/**
 * Is this resource reserved by some OTHER queued operation in this room?
 * Used in SELLING to avoid selling reagents/compound that another op is about
 * to use.  An op never blocks itself.
 */
function isResourceReservedByOtherOp(roomName, resource, currentOp) {
    var q = getRoomQueues(roomName);
    var lists = [q.forward, q.reverse];
    for (var li = 0; li < lists.length; li++) {
        var list = lists[li];
        for (var i = 0; i < list.length; i++) {
            var op = list[i];
            if (!op || op === currentOp) continue;
            if (op.targetCompound === resource) return true;
            if (op.reagents && (op.reagents[0] === resource || op.reagents[1] === resource)) return true;
        }
    }
    return false;
}

/**
 * True once the primary output has fully landed in the terminal — i.e. no
 * output remains in any lab AND no creep in the room is still carrying it.
 *
 * Forward output = the compound.
 * Reverse output = the two reagents.
 *
 * This check prevents runSelling from snapshotting the terminal amount while
 * the labBot is still ferrying product from the output labs to the terminal,
 * which would cause the remainder to be stranded unsold.
 *
 * Bounded by SELLING_GRACE_TICKS in the caller so a stuck creep can't stall
 * the op indefinitely.
 */
function isOutputEvacuated(op, roomName) {
    var room = Game.rooms[roomName];
    if (!room) return true; // no vision — don't stall the op

    var outputs = (op.direction === DIR_FORWARD)
        ? [op.targetCompound]
        : op.reagents.slice();

    // 1. No output may remain in any lab.
    var labs = getLabsInRoom(roomName);
    for (var i = 0; i < labs.length; i++) {
        var mt = labs[i].mineralType;
        if (mt && outputs.indexOf(mt) >= 0 && (labs[i].mineralAmount || 0) > 0) {
            return false;
        }
    }

    // 2. No creep in the room may still be carrying output (in-transit case).
    // We scan all creeps rather than filtering by role because the labBot role
    // string is not defined in this module. The bounded grace timeout ensures
    // an unrelated creep holding the resource can't hang the op forever.
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (creep.room.name !== roomName) continue;
        for (var k = 0; k < outputs.length; k++) {
            if ((creep.store[outputs[k]] || 0) > 0) return false;
        }
    }

    return true;
}

// =========================================================================
// OPERATION FACTORY
// =========================================================================

function createOperation(direction, roomName, compound, reagents, maxPrice) {
    var batchInfo = calculateBatchSize(roomName);
    var opId = tagFor(direction) + '_' + roomName + '_' + compound + '_' + Game.time + '_' + Math.random().toString(36).substr(2, 6);

    var op = {
        id:                  opId,
        active:              true,
        direction:           direction,
        roomName:            roomName,
        origin:              'marketLab',
        sink:                'storage',
        targetCompound:      compound,
        reagents:            reagents,
        state:               STATE_BUYING,
        tickStarted:         Game.time,
        buyRequestCreated:   false,
        reactionStarted:     false,
        sellOrderCreated:    false,
        salvageMode:         false,
        batchSize:           batchInfo.batchSize,
        outputLabCount:      batchInfo.outputLabCount,
        expectedOutputs:     null,
        stageReservationProgram: null
    };

    if (direction === DIR_FORWARD) {
        op.initialReagentAmounts = [0, 0];
    } else {
        op.initialCompoundAmount = 0;
        if (typeof maxPrice === 'number' && maxPrice > 0) {
            op.maxBuyPrice = maxPrice;
        }
    }

    return op;
}

function setExpectedOutputs(op, outputs) {
    op.expectedOutputs = outputs || null;
}

function getExpectedOutputs(op) {
    return op && op.expectedOutputs ? op.expectedOutputs : null;
}

function getRoomStorage(roomName) {
    var room = Game.rooms[roomName];
    return room && room.storage ? room.storage : null;
}

function reserveStagingOutputs(op, roomName) {
    if (!op || !op.stageReservationProgram) return true;

    var storage = getRoomStorage(roomName);
    if (!storage || !storage.store) return false;

    var outputs = getExpectedOutputs(op);
    if (!outputs) return true;

    var terminal = Game.rooms[roomName] && Game.rooms[roomName].terminal ? Game.rooms[roomName].terminal : null;
    var ok = true;

    for (var res in outputs) {
        if (!outputs.hasOwnProperty(res)) continue;
        var expected = outputs[res] || 0;
        if (expected <= 0) continue;

        var terminalHave = (terminal && terminal.store) ? (terminal.store[res] || 0) : 0;
        var desired = Math.max(0, expected - terminalHave);
        if (desired <= 0) {
            storageManager.unReserve(roomName, res, 'storage', op.stageReservationProgram);
            continue;
        }

        var storageHave = storage.store[res] || 0;
        var reserveAmt = Math.min(desired, storageHave);
        if (reserveAmt <= 0) {
            storageManager.unReserve(roomName, res, 'storage', op.stageReservationProgram);
            ok = false;
            continue;
        }

        var rv = storageManager.reserve(roomName, res, 'storage', op.stageReservationProgram, reserveAmt);
        if (!rv || !rv.ok) ok = false;
    }

    return ok;
}

function clearStagingReservations(op, roomName) {
    if (!op || !op.stageReservationProgram) return;
    var outputs = getExpectedOutputs(op);
    if (!outputs) return;

    for (var res in outputs) {
        if (!outputs.hasOwnProperty(res)) continue;
        storageManager.unReserve(roomName, res, 'storage', op.stageReservationProgram);
    }
}

function isMarketSellRequestActive(roomName, resourceType, amount, createdTick) {
    if (!Memory.marketSell || !Array.isArray(Memory.marketSell.requests)) return false;
    for (var i = 0; i < Memory.marketSell.requests.length; i++) {
        var req = Memory.marketSell.requests[i];
        if (!req) continue;
        if (req.roomName !== roomName) continue;
        if (req.resourceType !== resourceType) continue;
        if (req.amount !== amount) continue;
        if (typeof createdTick === 'number' && req.created !== createdTick) continue;
        return true;
    }
    return false;
}

function getActiveMarketSellRequest(roomName, resourceType, amount) {
    if (!Memory.marketSell || !Array.isArray(Memory.marketSell.requests)) return null;
    for (var i = 0; i < Memory.marketSell.requests.length; i++) {
        var req = Memory.marketSell.requests[i];
        if (!req) continue;
        if (req.roomName !== roomName) continue;
        if (req.resourceType !== resourceType) continue;
        if (req.amount !== amount) continue;
        if (req.orderId && Game.market && Game.market.orders && Game.market.orders[req.orderId]) return req;
        if (req.created === Game.time) return req;
    }
    return null;
}

function getStagingNeed(op, roomName, resource) {
    var outputs = getExpectedOutputs(op);
    if (!outputs || !outputs.hasOwnProperty(resource)) return 0;
    var expected = outputs[resource] || 0;
    if (expected <= 0) return 0;

    var room = Game.rooms[roomName];
    if (!room || !room.terminal) return expected;
    var haveTerminal = room.terminal.store[resource] || 0;
    return Math.max(0, expected - haveTerminal);
}

function countResourceInLabs(roomName, resource) {
    var labs = getLabsInRoom(roomName);
    var total = 0;
    for (var i = 0; i < labs.length; i++) {
        if (labs[i].mineralType === resource) total += labs[i].mineralAmount || 0;
    }
    return total;
}

function countResourceInRoomCreeps(roomName, resource) {
    var total = 0;
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (!creep || !creep.room || creep.room.name !== roomName || !creep.store) continue;
        total += creep.store[resource] || 0;
    }
    return total;
}

function getStagingAvailability(roomName, resource) {
    var room = Game.rooms[roomName];
    var terminal = room && room.terminal && room.terminal.store ? (room.terminal.store[resource] || 0) : 0;
    var storage = room && room.storage && room.storage.store ? (room.storage.store[resource] || 0) : 0;
    var labs = countResourceInLabs(roomName, resource);
    var creeps = countResourceInRoomCreeps(roomName, resource);
    return { terminal: terminal, storage: storage, labs: labs, creeps: creeps, pending: storage + labs + creeps };
}

function getStorageReservationAmount(roomName, resource, program) {
    if (!program) return 0;
    var info = storageManager.storageFind(roomName, resource);
    var reservations = info && info.storage && Array.isArray(info.storage.reservations) ? info.storage.reservations : [];
    for (var i = 0; i < reservations.length; i++) {
        if (reservations[i] && reservations[i].program === program) return reservations[i].amount || 0;
    }
    return 0;
}

function tagFor(direction) {
    return direction === DIR_FORWARD ? 'labForward' : 'labReverse';
}
function shortTagFor(direction) {
    return direction === DIR_FORWARD ? 'fwd' : 'rev';
}

// =========================================================================
// STATE: BUYING
// =========================================================================

function runBuying(op, roomName) {
    if (op.direction === DIR_FORWARD) {
        runBuyingForward(op, roomName);
    } else {
        runBuyingReverse(op, roomName);
    }
    // Check for stalled marketBuy orders and fire a one-shot top-up if needed.
    maybeTopUpLabMarketBuy(op, roomName);
}

function runBuyingForward(op, roomName) {
    var r1 = countInRoom(roomName, op.reagents[0]);
    var r2 = countInRoom(roomName, op.reagents[1]);

    if (r1 >= op.batchSize && r2 >= op.batchSize) {
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound + ': reagents acquired.');
        opportunisticBuy.cancelRequest(roomName, op.reagents[0]);
        opportunisticBuy.cancelRequest(roomName, op.reagents[1]);
        cancelTrackedMarketBuyOrders(op, roomName, op.reagents[0]);
        cancelTrackedMarketBuyOrders(op, roomName, op.reagents[1]);
        op.buyRequestCreated      = false;
        op.initialReagentAmounts  = [r1, r2];
        moveToProcessingOrWaiting(op, roomName);
        return;
    }

    if (op.buyRequestCreated) return;

    var requestsCreated = 0;
    for (var k = 0; k < op.reagents.length; k++) {
        var reagent    = op.reagents[k];
        var currentAmt = countInRoom(roomName, reagent);
        if (currentAmt >= op.batchSize) continue;

        var maxPriceStr = global.marketPrice(reagent);
        var maxPrice    = parseMarketPrice(maxPriceStr);
        if (isNaN(maxPrice)) continue;

        var amountNeeded = op.batchSize - currentAmt;
        if (labShouldUseMarketBuy(op.targetCompound, reagent, maxPrice)) {
            var bid = labComputeBid(reagent, maxPrice);
            if (bid === null) {
                console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                            ': ask floor for ' + reagent + ' exceeds ceiling ' + maxPrice.toFixed(3) +
                            ' - skipping marketBuy, falling back to opportunisticBuy');
                opportunisticBuy.setup(roomName, reagent, amountNeeded, maxPrice);
            } else {
                var msg = marketBuyer.marketBuy(roomName, reagent, amountNeeded, bid,
                                                { product: op.targetCompound, room: roomName, ceiling: maxPrice });
                trackMarketBuyForLab(op, reagent, maxPrice);
                console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                            ': marketBuy for ' + amountNeeded + ' ' + reagent +
                            ' @ ' + bid.toFixed(3) + ' (ceiling ' + maxPrice.toFixed(3) + '): ' + msg);
            }
        } else {
            opportunisticBuy.setup(roomName, reagent, amountNeeded, maxPrice);
            console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                        ': opportunisticBuy for ' + amountNeeded + ' ' + reagent +
                        ' @ ' + maxPrice.toFixed(3));
        }
        requestsCreated++;
    }
    if (requestsCreated > 0) op.buyRequestCreated = true;
}

function runBuyingReverse(op, roomName) {
    var currentAmount = countInRoom(roomName, op.targetCompound);

    if (currentAmount >= op.batchSize) {
        console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                    ': batch acquired (' + currentAmount + ').');
        opportunisticBuy.cancelRequest(roomName, op.targetCompound);
        cancelTrackedMarketBuyOrders(op, roomName, op.targetCompound);
        op.buyRequestCreated     = false;
        op.initialCompoundAmount = currentAmount;
        moveToProcessingOrWaiting(op, roomName);
        return;
    }

    if (op.buyRequestCreated) return;

    var maxPrice;
    if (op.maxBuyPrice) {
        maxPrice = op.maxBuyPrice;
    } else {
        maxPrice = parseMarketPrice(global.marketPrice(op.targetCompound));
    }
    if (isNaN(maxPrice) || maxPrice <= 0) return;

    var amountNeeded = op.batchSize - currentAmount;
    if (labShouldUseMarketBuy(op.targetCompound, op.targetCompound, maxPrice)) {
        var bid = labComputeBid(op.targetCompound, maxPrice);
        if (bid === null) {
            console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                        ': ask floor exceeds ceiling ' + maxPrice.toFixed(3) +
                        ' - skipping marketBuy, falling back to opportunisticBuy');
            opportunisticBuy.setup(roomName, op.targetCompound, amountNeeded, maxPrice);
            op.buyRequestCreated = true;
        } else {
            var msg = marketBuyer.marketBuy(roomName, op.targetCompound, amountNeeded, bid,
                                            { product: op.targetCompound, room: roomName, ceiling: maxPrice });
            trackMarketBuyForLab(op, op.targetCompound, maxPrice);
            op.buyRequestCreated = true;
            console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                        ': marketBuy for ' + amountNeeded + ' @ ' + bid.toFixed(3) +
                        ' (ceiling ' + maxPrice.toFixed(3) + '): ' + msg);
        }
    } else {
        opportunisticBuy.setup(roomName, op.targetCompound, amountNeeded, maxPrice);
        op.buyRequestCreated = true;
        console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                    ': opportunisticBuy for ' + amountNeeded + ' @ ' + maxPrice.toFixed(3));
    }
}

// ===== marketBuy tracking (mirror of marketRefine's op-level pattern) =====
// Per-op state lives on the op object so it survives across ticks until the op
// transitions out of BUYING. Fields are lazy-initialized.
function trackMarketBuyForLab(op, resource, ceiling) {
    if (!op.useMarketBuy)       op.useMarketBuy       = {};
    if (!op.marketBuyCeilings)  op.marketBuyCeilings  = {};
    if (!op.marketBuyLastCheck) op.marketBuyLastCheck = {};
    op.useMarketBuy[resource]      = true;
    op.marketBuyCeilings[resource] = ceiling;
}

function cancelTrackedMarketBuyOrders(op, roomName, resource) {
    if (!op.useMarketBuy || !op.useMarketBuy[resource]) return;
    try { marketBuyer.cancelOrderFor(roomName, resource, 'lab op acquired: ' + op.targetCompound); }
    catch (e) { /* order may already be gone */ }
    op.useMarketBuy[resource] = false;
}

function cancelAllTrackedMarketBuyOrders(op, roomName) {
    if (!op.useMarketBuy) return;
    for (var res in op.useMarketBuy) {
        if (!op.useMarketBuy.hasOwnProperty(res)) continue;
        if (op.useMarketBuy[res]) cancelTrackedMarketBuyOrders(op, roomName, res);
    }
}

// One-shot opportunistic top-up when a marketBuy order is stalling. Gated on a
// per-op tick to avoid spamming. Fired only once per (op, resource): we set
// op.marketBuyToppedUp[resource] = true to dedupe.
function maybeTopUpLabMarketBuy(op, roomName) {
    if (!op.useMarketBuy) return;
    if (Game.time - (op.lastTopUpCheck || 0) < LAB_MARKETBUY_TOPUP_GATE) return;
    op.lastTopUpCheck = Game.time;
    if (!op.marketBuyToppedUp) op.marketBuyToppedUp = {};

    for (var resource in op.useMarketBuy) {
        if (!op.useMarketBuy.hasOwnProperty(resource)) continue;
        if (!op.useMarketBuy[resource]) continue;
        if (op.marketBuyToppedUp[resource]) continue;

        var rec = marketBuyer.getOrderRecordFor(roomName, resource);
        if (!rec || rec.done || rec.cancelled) {
            op.marketBuyToppedUp[resource] = true;
            continue;
        }
        var need = op.batchSize - countInRoom(roomName, resource);
        if (need <= 0) {
            op.marketBuyToppedUp[resource] = true;
            continue;
        }
        var got = marketBuyer.getFulfilled(rec);
        if (got >= need * LAB_MARKETBUY_TOPUP_RATIO) {
            op.marketBuyToppedUp[resource] = true;
            continue;
        }
        var ceiling = (op.marketBuyCeilings && op.marketBuyCeilings[resource]) || parseMarketPrice(global.marketPrice(resource));
        if (!(ceiling > 0)) continue;
        var topUpAmt = Math.max(0, need - got);
        if (topUpAmt <= 0) continue;
        opportunisticBuy.setup(roomName, resource, topUpAmt, ceiling);
        op.marketBuyToppedUp[resource] = true;
        console.log('[marketLab] ' + roomName + '/' + op.targetCompound +
                    ' marketBuy stalled at ' + got + '/' + need + ' for ' + resource +
                    ' - opportunistic top-up queued for ' + topUpAmt + ' @ ' + ceiling.toFixed(3));
    }
}

function moveToProcessingOrWaiting(op, roomName) {
    var tag = shortTagFor(op.direction);
    if (!isRoomProcessing(roomName) && !labManagerBusy(roomName)) {
        op.state = STATE_PROCESSING;
        console.log('[marketLab ' + tag + '] ' + roomName + '/' + op.targetCompound + ': starting processing.');
    } else {
        op.state = STATE_WAITING;
        console.log('[marketLab ' + tag + '] ' + roomName + '/' + op.targetCompound + ': labs busy, waiting.');
    }
}

function runStaging(op, roomName) {
    if (!op.stageStartTick) op.stageStartTick = Game.time;

    if (!op.stageReservationProgram) {
        op.stageReservationProgram = 'marketLabStage_' + op.id;
    }

    reserveStagingOutputs(op, roomName);

    var outputs = getExpectedOutputs(op);
    if (!outputs) {
        op.state = STATE_SELLING;
        op.salvageMode = true;
        op.sellingStartTick = Game.time;
        runSelling(op, roomName);
        return;
    }

    var allStaged = true;
    var hasPendingSource = false;

    for (var res in outputs) {
        if (!outputs.hasOwnProperty(res)) continue;
        var need = getStagingNeed(op, roomName, res);
        if (need <= 0) continue;

        allStaged = false;
        var availability = getStagingAvailability(roomName, res);
        if (availability.pending > 0) {
            hasPendingSource = true;
            continue;
        }
    }

    if (!allStaged) {
        if (hasPendingSource || (Game.time - op.stageStartTick) < STAGING_GRACE_TICKS) return;

        var room = Game.rooms[roomName];
        if (!room || !room.terminal || !room.terminal.store) return;

        for (var outRes in outputs) {
            if (!outputs.hasOwnProperty(outRes)) continue;
            var expected = outputs[outRes] || 0;
            if (expected <= 0) continue;
            var terminalHave = room.terminal.store[outRes] || 0;
            if (terminalHave < expected) {
                console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                            ': partial staging ' + outRes + ' ' + terminalHave + '/' + expected +
                            ' - no remaining source, selling available output.');
                outputs[outRes] = terminalHave;
            }
        }
    }

    clearStagingReservations(op, roomName);
    op.state = STATE_SELLING;
    op.salvageMode = true;
    op.sellingStartTick = Game.time;
    runSelling(op, roomName);
}

// =========================================================================
// STATE: WAITING
// =========================================================================

function runWaiting(op, roomName) {
    if (isRoomProcessing(roomName)) return;
    if (labManagerBusy(roomName)) return;

    if (checkLabsContaminated(roomName)) {
        var hasActiveLabOrder = !!(Memory.labOrders
                                   && Memory.labOrders[roomName]
                                   && Memory.labOrders[roomName].active);
        if (!hasActiveLabOrder) {
            var labManager = require('labManager');
            if (labManager.queueCleanup(roomName)) {
                console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                            ': labs contaminated, cleanup queued — staying WAITING.');
            }
        }
        return;
    }

    op.state           = STATE_PROCESSING;
    op.reactionStarted = false;
    console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                ': labs free, starting processing.');
}

// =========================================================================
// STATE: PROCESSING  (single-shot — no restart)
// =========================================================================

function runProcessing(op, roomName) {
    var labOrderActive = !!(Memory.labOrders
                            && Memory.labOrders[roomName]
                            && Memory.labOrders[roomName].active);

    if (!op.reactionStarted) {
        if (op.direction === DIR_FORWARD) {
            startForwardLabOrder(op, roomName);
        } else {
            startReverseLabOrder(op, roomName);
        }
        return;
    }

    if (labOrderActive) return;

    // labManager runs on a multi-tick interval and can transiently null its
    // active order mid-update before shifting its queue. Requiring the room
    // to be fully idle (no active AND no queued order) prevents an op from
    // declaring itself done during that window and letting a second op
    // promote into a half-finished lab.
    if (labManagerBusy(roomName)) return;

    // Guard: give labManager at least a full run interval (+slack) to
    // activate and progress the order before we conclude it's finished.
    // This prevents a false-done on the ticks immediately after
    // breakdownLabs/orderLabs is called.
    var ticksSinceStart = Game.time - (op.reactionStartedTick || op.tickStarted);
    if (ticksSinceStart < 5) return;   // survive a full manager cycle (interval 3 + slack)

    var tag = shortTagFor(op.direction);
    console.log('[marketLab ' + tag + '] ' + roomName + '/' + op.targetCompound +
                ': lab order complete, moving to staging.');
    op.state       = STATE_STAGING;
    op.salvageMode = true;
    op.stageStartTick = Game.time;
}

function startForwardLabOrder(op, roomName) {
    var r1 = countInRoom(roomName, op.reagents[0]);
    var r2 = countInRoom(roomName, op.reagents[1]);

    // Use initial amounts if we recorded them (more accurate immediately
    // after BUYING), otherwise fall back to current terminal counts.
    var r1Initial = (op.initialReagentAmounts && op.initialReagentAmounts[0]) || r1;
    var r2Initial = (op.initialReagentAmounts && op.initialReagentAmounts[1]) || r2;
    // Cap to the configured batch size so pre-existing terminal surplus above
    // the batch doesn't get pulled into a single oversized lab order.
    var amountToProcess = Math.min(r1Initial, r2Initial, op.batchSize);

    if (amountToProcess < LAB_REACTION_AMOUNT) {
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                    ': insufficient reagents to react, moving directly to sell.');
        op.state       = STATE_SELLING;
        op.salvageMode = true;
        return;
    }

    console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                ': starting reaction for ' + amountToProcess);
    var outputs = {};
    outputs[op.targetCompound] = amountToProcess;
    setExpectedOutputs(op, outputs);
    op.stageReservationProgram = 'marketLabStage_' + op.id;
    global.orderLabs(roomName, op.targetCompound, amountToProcess, {
        origin: 'marketLab',
        sink: 'terminal',
        marketOpId: op.id
    });
    op.reactionStarted     = true;
    op.reactionStartedTick = Game.time;
}

function startReverseLabOrder(op, roomName) {
    // Cap to the configured batch size so pre-existing terminal surplus above
    // the batch doesn't get pulled into a single oversized breakdown order.
    var compoundAmount = Math.min(countInRoom(roomName, op.targetCompound), op.batchSize);
    if (compoundAmount < LAB_REACTION_AMOUNT) {
        op.state = STATE_SELLING;
        op.salvageMode = true;
        return;
    }
    console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                ': starting breakdown for ' + compoundAmount);
    var outputs = {};
    outputs[op.reagents[0]] = compoundAmount;
    outputs[op.reagents[1]] = compoundAmount;
    setExpectedOutputs(op, outputs);
    op.stageReservationProgram = 'marketLabStage_' + op.id;
    global.breakdownLabs(roomName, op.targetCompound, compoundAmount, {
        origin: 'marketLab',
        sink: 'terminal',
        marketOpId: op.id
    });
    op.reactionStarted     = true;
    op.reactionStartedTick = Game.time;
}

// =========================================================================
// STATE: SELLING
// =========================================================================

function runSelling(op, roomName) {
    if (!op.sellingStartTick) op.sellingStartTick = Game.time;

    // Defensive: cancel any marketBuy orders still tracked from the BUYING
    // phase. The happy path cancels them in runBuying{Forward,Reverse}, but
    // external aborts / salvageMode transitions can land us in SELLING with
    // tracked orders still live.
    cancelAllTrackedMarketBuyOrders(op, roomName);

    if (!op.sellOrderCreated) {
        // Don't snapshot the sell amount until the labBot has finished moving
        // output out of the labs (and out of its own carry) into the terminal.
        // countInRoom() only sees the terminal, so placing the order before
        // evacuation completes sells only what has arrived so far and strands
        // the in-transit remainder (e.g. 500 of 3000 GH).
        // Bounded by SELLING_GRACE_TICKS so a stuck creep can't hang the op.
        if (!isOutputEvacuated(op, roomName)
                && (Game.time - op.sellingStartTick) < SELLING_GRACE_TICKS) {
            return;
        }

        op.sellRequestInfo = [];
        if (op.direction === DIR_FORWARD) {
            placeForwardSellOrders(op, roomName);
        } else {
            placeReverseSellOrders(op, roomName);
        }

        if (op.origin === 'marketLab') {
            var outputs = getExpectedOutputs(op) || {};
            var expectedCount = 0;
            for (var res in outputs) {
                if (!outputs.hasOwnProperty(res)) continue;
                if ((outputs[res] || 0) > 0) expectedCount++;
            }
            if (!op.sellRequestInfo || op.sellRequestInfo.length < expectedCount) {
                console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                            ': sell order setup incomplete, will retry.');
                return;
            }
        }

        op.sellOrderCreated = true;
        return;
    }

    // Wait for terminals to drain.
    if (isOperationDrained(op, roomName)) {
        console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                    (op.salvageMode ? ': salvage complete.' : ': complete.'));
        op._completed = true;
    }
}

function placeForwardSellOrders(op, roomName) {
    var outputs = getExpectedOutputs(op);
    var compoundAmount = outputs && outputs[op.targetCompound] ? outputs[op.targetCompound] : countInRoom(roomName, op.targetCompound);

    if (compoundAmount > 0) {
        var amt = Math.min(compoundAmount, MAX_BATCH_SIZE);
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound + ': sell order ' + amt);
        var existing = getActiveMarketSellRequest(roomName, op.targetCompound, amt);
        if (existing) {
            op.sellRequestInfo = [{ resource: op.targetCompound, amount: amt, created: existing.created || Game.time }];
        } else {
            var result = global.marketSell(roomName, op.targetCompound, amt);
            if (typeof result === 'string' && result.indexOf('Created SELL order') !== -1) {
                op.sellRequestInfo = [{ resource: op.targetCompound, amount: amt, created: Game.time }];
            }
        }
    }

    // Salvage: sell any reagent surplus that no other op is waiting on.
    // MarketLab-origin orders stage only their expected output; do not
    // opportunistically sell unrelated stock from the room.
    if (op.salvageMode && op.origin !== 'marketLab') {
        for (var k = 0; k < op.reagents.length; k++) {
            var reagent = op.reagents[k];
            if (isResourceReservedByOtherOp(roomName, reagent, op)) continue;
            var leftover = countInRoom(roomName, reagent);
            if (leftover <= 0) continue;
            var sellAmt = Math.min(leftover, MAX_BATCH_SIZE);
            console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                        ': salvage — sell ' + sellAmt + ' surplus ' + reagent);
            global.marketSell(roomName, reagent, sellAmt);
        }
    }
}

function placeReverseSellOrders(op, roomName) {
    var outputs = getExpectedOutputs(op);
    for (var k = 0; k < op.reagents.length; k++) {
        var reagent = op.reagents[k];
        if (op.origin !== 'marketLab' && isResourceReservedByOtherOp(roomName, reagent, op)) continue;
        var amt = outputs && outputs[reagent] ? outputs[reagent] : countInRoom(roomName, reagent);
        if (amt <= 0) continue;
        var sellAmt = Math.min(amt, MAX_BATCH_SIZE);
        console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                    ': sell ' + sellAmt + ' ' + reagent);
        var existing = getActiveMarketSellRequest(roomName, reagent, sellAmt);
        if (existing) {
            if (!op.sellRequestInfo) op.sellRequestInfo = [];
            op.sellRequestInfo.push({ resource: reagent, amount: sellAmt, created: existing.created || Game.time });
        } else {
            var result = global.marketSell(roomName, reagent, sellAmt);
            if (typeof result === 'string' && result.indexOf('Created SELL order') !== -1) {
                if (!op.sellRequestInfo) op.sellRequestInfo = [];
                op.sellRequestInfo.push({ resource: reagent, amount: sellAmt, created: Game.time });
            }
        }
    }

    // Salvage: leftover compound that wasn't broken down also gets sold off
    // (unless another op needs it).
    if (op.salvageMode && op.origin !== 'marketLab') {
        var compoundLeft = countInRoom(roomName, op.targetCompound);
        if (compoundLeft > 0 && !isResourceReservedByOtherOp(roomName, op.targetCompound, op)) {
            var sellCompoundAmt = Math.min(compoundLeft, MAX_BATCH_SIZE);
            console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                        ': salvage — sell ' + sellCompoundAmt + ' unbroken ' + op.targetCompound);
            global.marketSell(roomName, op.targetCompound, sellCompoundAmt);
        }
    }
}

function isOperationDrained(op, roomName) {
    if (op.origin === 'marketLab' && Array.isArray(op.sellRequestInfo) && op.sellRequestInfo.length > 0) {
        for (var s = 0; s < op.sellRequestInfo.length; s++) {
            var req = op.sellRequestInfo[s];
            if (!req) continue;
            if (isMarketSellRequestActive(roomName, req.resource, req.amount, req.created)) return false;
        }
        return true;
    }

    // Forward primary output is the compound; reverse primary outputs are reagents.
    var primaryResources = (op.direction === DIR_FORWARD)
        ? [op.targetCompound]
        : op.reagents.slice();

    for (var i = 0; i < primaryResources.length; i++) {
        if (countInRoom(roomName, primaryResources[i]) > 0) return false;
    }

    if (op.salvageMode) {
        var salvageList = (op.direction === DIR_FORWARD) ? op.reagents : [op.targetCompound];
        for (var j = 0; j < salvageList.length; j++) {
            var r = salvageList[j];
            if (isResourceReservedByOtherOp(roomName, r, op)) continue;
            if (countInRoom(roomName, r) > 0) return false;
        }
    }

    return true;
}

// =========================================================================
// OPERATION DRIVER
// =========================================================================

function runOperation(op, roomName) {
    // Defensive: backfill batchSize / direction if missing (legacy save).
    if (!op.batchSize) {
        var batchInfo = calculateBatchSize(roomName);
        op.batchSize      = batchInfo.batchSize;
        op.outputLabCount = batchInfo.outputLabCount;
    }
    if (!op.direction) op.direction = DIR_FORWARD;

    switch (op.state) {
        case STATE_BUYING:     runBuying(op, roomName);     break;
        case STATE_WAITING:    runWaiting(op, roomName);    break;
        case STATE_PROCESSING: runProcessing(op, roomName); break;
        case STATE_STAGING:    runStaging(op, roomName);    break;
        case STATE_SELLING:    runSelling(op, roomName);    break;
        default:
            console.log('[marketLab] ' + roomName + '/' + op.targetCompound +
                        ': unknown state ' + op.state + ', resetting to SELLING');
            op.state       = STATE_SELLING;
            op.salvageMode = true;
            break;
    }
}

function processDirection(direction) {
    var mem = ensureMemory(direction);
    var tag = shortTagFor(direction);

    for (var roomName in mem.rooms) {
        var queue = mem.rooms[roomName];
        if (!queue || queue.length === 0) continue;

        if (!roomHasLabsAndTerminal(roomName)) {
            console.log('[marketLab ' + tag + '] room ' + roomName + ' lost critical structures, clearing queue.');
            for (var qi = 0; qi < queue.length; qi++) cancelStagingForOp(roomName, queue[qi]);
            mem.rooms[roomName] = [];
            continue;
        }

        for (var i = queue.length - 1; i >= 0; i--) {
            var op = queue[i];
            runOperation(op, roomName);
            if (op._completed) queue.splice(i, 1);
        }
    }
}

// =========================================================================
// PUBLIC API used by console commands
// =========================================================================

function startOperation(direction, roomName, compound, maxPrice) {
    if (!isValidCompound(compound)) {
        return '[' + tagFor(direction) + '] Invalid compound: ' + compound;
    }
    var reagents = findReagents(compound);
    if (reagents.length !== 2) {
        return '[' + tagFor(direction) + '] Could not find reagents for ' + compound;
    }

    if (!roomName) roomName = findSuitableRoom();
    if (!roomName) {
        return '[' + tagFor(direction) + '] No suitable room (need terminal + 3 labs)';
    }
    if (!roomHasLabsAndTerminal(roomName)) {
        return '[' + tagFor(direction) + '] Room ' + roomName + ' lacks terminal + 3 labs';
    }

    var queue = ensureRoomQueue(direction, roomName);
    for (var i = 0; i < queue.length; i++) {
        if (queue[i].targetCompound === compound && queue[i].state !== STATE_SELLING) {
            return '[' + tagFor(direction) + '] ' + compound +
                   ' is already queued/processing in ' + roomName;
        }
    }

    var op = createOperation(direction, roomName, compound, reagents, maxPrice);
    queue.push(op);

    var arrow = direction === DIR_FORWARD
        ? (reagents.join(' + ') + ' -> ' + compound)
        : (compound + ' -> ' + reagents.join(' + '));
    var priceInfo = op.maxBuyPrice ? ' (max ' + op.maxBuyPrice.toFixed(3) + ')' : '';
    return '[' + tagFor(direction) + '] Queued: ' + arrow + ' in ' + roomName +
           ' (batch: ' + op.batchSize + ', position: ' + queue.length + ')' + priceInfo;
}

function cancelBuyForOp(direction, roomName, op) {
    if (!op.buyRequestCreated) return;
    if (direction === DIR_FORWARD) {
        opportunisticBuy.cancelRequest(roomName, op.reagents[0]);
        opportunisticBuy.cancelRequest(roomName, op.reagents[1]);
    } else {
        opportunisticBuy.cancelRequest(roomName, op.targetCompound);
    }
}

function cancelStagingForOp(roomName, op) {
    if (!op || !op.stageReservationProgram) return;
    clearStagingReservations(op, roomName);
    op.stageReservationProgram = null;
}

function stopOperation(direction, roomName, compound) {
    var mem = ensureMemory(direction);
    var tag = tagFor(direction);

    if (!roomName) {
        var stoppedAll = 0;
        for (var rn in mem.rooms) {
            var q = mem.rooms[rn];
            for (var i = 0; i < q.length; i++) {
                cancelBuyForOp(direction, rn, q[i]);
                cancelStagingForOp(rn, q[i]);
            }
            stoppedAll += q.length;
        }
        mem.rooms = {};
        return '[' + tag + '] Stopped ' + stoppedAll + ' op(s) in all rooms.';
    }

    var queue = mem.rooms[roomName];
    if (!queue || queue.length === 0) {
        return '[' + tag + '] No operations in ' + roomName;
    }

    if (!compound) {
        var stopped = queue.length;
        for (var j = 0; j < queue.length; j++) {
            cancelBuyForOp(direction, roomName, queue[j]);
            cancelStagingForOp(roomName, queue[j]);
        }
        mem.rooms[roomName] = [];
        return '[' + tag + '] Stopped ' + stopped + ' op(s) in ' + roomName;
    }

    for (var k = queue.length - 1; k >= 0; k--) {
        if (queue[k].targetCompound === compound) {
            cancelBuyForOp(direction, roomName, queue[k]);
            cancelStagingForOp(roomName, queue[k]);
            queue.splice(k, 1);
            return '[' + tag + '] Stopped ' + compound + ' in ' + roomName;
        }
    }
    return '[' + tag + '] ' + compound + ' not found in ' + roomName;
}

function resetMemory(direction) {
    var mem = ensureMemory(direction);
    for (var roomName in mem.rooms) {
        var queue = mem.rooms[roomName];
        for (var i = 0; i < queue.length; i++) {
            cancelBuyForOp(direction, roomName, queue[i]);
            cancelStagingForOp(roomName, queue[i]);
        }
    }
    Memory[memKey(direction)] = { rooms: {}, version: MEMORY_VERSION };
    return '[' + tagFor(direction) + '] Memory reset.';
}

// =========================================================================
// STATUS DISPLAY
// =========================================================================

function getStatusForRoom(direction, roomName) {
    ensureMemory(direction);
    var queue = Memory[memKey(direction)].rooms[roomName];
    var tag   = tagFor(direction);

    if (!queue || queue.length === 0) {
        return '[' + tag + '] No active operations in ' + roomName;
    }

    var lines = [];
    lines.push('[' + tag + '] ' + roomName + ': ' + queue.length + ' operation(s)');

    for (var i = 0; i < queue.length; i++) {
        var op = queue[i];
        var arrow = direction === DIR_FORWARD
            ? (op.reagents.join(' + ') + ' -> ' + op.targetCompound)
            : (op.targetCompound + ' -> ' + op.reagents.join(' + '));

        lines.push('');
        lines.push('  [' + (i + 1) + '] ' + arrow + ' (' + op.state + ')');
        lines.push('      Batch: ' + op.batchSize + ' (' + op.outputLabCount + ' labs)');
        lines.push('      Age:   ' + (Game.time - op.tickStarted) + ' ticks');
        if (op.salvageMode) lines.push('      Salvage: yes');
        if (op.maxBuyPrice) lines.push('      Max buy: ' + op.maxBuyPrice.toFixed(3));

        if (op.state === STATE_BUYING) {
            if (direction === DIR_FORWARD) {
                lines.push('      ' + op.reagents[0] + ': ' + countInRoom(roomName, op.reagents[0]) + '/' + op.batchSize);
                lines.push('      ' + op.reagents[1] + ': ' + countInRoom(roomName, op.reagents[1]) + '/' + op.batchSize);
            } else {
                lines.push('      Progress: ' + countInRoom(roomName, op.targetCompound) + '/' + op.batchSize);
            }
        } else if (op.state === STATE_WAITING) {
            lines.push('      Waiting for labs to be free...');
        } else if (op.state === STATE_PROCESSING) {
            var labOrderActive = !!(Memory.labOrders && Memory.labOrders[roomName] && Memory.labOrders[roomName].active);
            lines.push('      Lab order:      ' + (labOrderActive ? 'active' : 'NONE'));
            lines.push('      reactionStarted: ' + (op.reactionStarted ? 'YES' : 'NO'));
            if (direction === DIR_FORWARD) {
                lines.push('      ' + op.reagents[0] + ': ' + countInRoom(roomName, op.reagents[0]));
                lines.push('      ' + op.reagents[1] + ': ' + countInRoom(roomName, op.reagents[1]));
                lines.push('      ' + op.targetCompound + ': ' + countInRoom(roomName, op.targetCompound));
            } else {
                lines.push('      ' + op.targetCompound + ': ' + countInRoom(roomName, op.targetCompound));
                lines.push('      ' + op.reagents[0] + ': ' + countInRoom(roomName, op.reagents[0]));
                lines.push('      ' + op.reagents[1] + ': ' + countInRoom(roomName, op.reagents[1]));
            }
        } else if (op.state === STATE_STAGING) {
            var outputs = getExpectedOutputs(op);
            lines.push('      Staging to terminal');
            if (outputs) {
                for (var res in outputs) {
                    if (!outputs.hasOwnProperty(res)) continue;
                    var have = getStagingAvailability(roomName, res);
                    var missing = Math.max(0, (outputs[res] || 0) - have.terminal);
                    var reserved = getStorageReservationAmount(roomName, res, op.stageReservationProgram);
                    lines.push('      ' + res + ': storage ' + have.storage + ', terminal ' + have.terminal + ' / ' + outputs[res] +
                               ', labs ' + have.labs + ', creeps ' + have.creeps + ', missing ' + missing + ', reserved ' + reserved);
                }
            }
            if (op.stageStartTick) lines.push('      Staging age: ' + (Game.time - op.stageStartTick) + '/' + STAGING_GRACE_TICKS + ' ticks');
            if (op.stageReservationProgram) lines.push('      Stage reserve: ' + op.stageReservationProgram);
        } else if (op.state === STATE_SELLING) {
            var ticksWaiting = Game.time - (op.sellingStartTick || Game.time);
            var evacuated = isOutputEvacuated(op, roomName);
            lines.push('      ' + op.targetCompound + ': ' + countInRoom(roomName, op.targetCompound));
            lines.push('      ' + op.reagents[0] + ': ' + countInRoom(roomName, op.reagents[0]));
            lines.push('      ' + op.reagents[1] + ': ' + countInRoom(roomName, op.reagents[1]));
            lines.push('      Evacuation complete: ' + (evacuated ? 'yes' : 'no (waiting up to ' + (SELLING_GRACE_TICKS - ticksWaiting) + ' more ticks)'));
            lines.push('      Sell order placed: ' + (op.sellOrderCreated ? 'yes' : 'no'));
            lines.push('      Waiting in sell: ' + ticksWaiting + ' ticks');
        }
    }
    return lines.join('\n');
}

function getAllStatus(direction) {
    ensureMemory(direction);
    var rooms = Memory[memKey(direction)].rooms;
    var tag   = tagFor(direction);

    var activeRooms = [];
    for (var rn in rooms) {
        if (rooms[rn] && rooms[rn].length > 0) activeRooms.push(rn);
    }
    if (activeRooms.length === 0) return '[' + tag + '] No active operations.';

    var lines = ['[' + tag + '] ' + activeRooms.length + ' room(s) with operations:'];
    for (var i = 0; i < activeRooms.length; i++) {
        lines.push('');
        lines.push(getStatusForRoom(direction, activeRooms[i]));
    }
    return lines.join('\n');
}

// =========================================================================
// GLOBAL CONSOLE COMMANDS
// =========================================================================

function makeCommand(direction) {
    var tag = tagFor(direction);
    return function(arg1, arg2, arg3) {
        ensureMemory(direction);

        if (!arg1)            return getAllStatus(direction);
        if (arg1 === 'stop')  return stopOperation(direction, arg2, arg3);
        if (arg1 === 'reset') return resetMemory(direction);

        if (arg1 === 'check') {
            if (!arg2) return '[' + tag + '] Usage: ' + tag + "('check', 'roomName')";
            var b = calculateBatchSize(arg2);
            return '[' + tag + '] ' + arg2 + ': ' + b.outputLabCount +
                   ' output labs, batch size = ' + b.batchSize;
        }

        var isRoomName = (Game.rooms[arg1] !== undefined) || (/^[EW]\d+[NS]\d+$/.test(arg1));

        if (isRoomName && !arg2) {
            return getStatusForRoom(direction, arg1);
        }
        if (isRoomName && arg2) {
            // arg3 (numeric) is optional maxPrice for reverse buys; ignored for forward
            var maxPrice = (typeof arg3 === 'number') ? arg3 : null;
            return startOperation(direction, arg1, arg2, maxPrice);
        }

        // Single argument: treat as compound, auto-pick room.
        return startOperation(direction, null, arg1, null);
    };
}

global.labForward = makeCommand(DIR_FORWARD);
global.labReverse = makeCommand(DIR_REVERSE);
global.stopAllLab = function() {
  var f = labForward('stop');
  var r = labReverse('stop');
  return f + '\n' + r;
};

// =========================================================================
// MODULE EXPORT
// =========================================================================
//
// run()         - processes BOTH directions in a single call (preferred entry).
// runForward()  - processes forward ops only (used by the marketLabForward
//                 stub so the CPU profiler attributes correctly).
// runReverse()  - processes reverse ops only (mirror of the above).
//
// All three are safe to call multiple times per tick; only the first call
// for a given (direction, tick) does work.

module.exports = {
    run: function() {
        module.exports.runForward();
        module.exports.runReverse();
    },

    runForward: function() {
        if (Memory._marketLabFwdTick === Game.time) return;
        Memory._marketLabFwdTick = Game.time;
        ensureMemory(DIR_FORWARD);
        processDirection(DIR_FORWARD);
    },

    runReverse: function() {
        if (Memory._marketLabRevTick === Game.time) return;
        Memory._marketLabRevTick = Game.time;
        ensureMemory(DIR_REVERSE);
        processDirection(DIR_REVERSE);
    }
};
