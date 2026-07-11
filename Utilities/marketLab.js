// LLM: Read llmcontext.js before reviewing or changing this file.
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
 *   labForward('E3N46', 'ZO', {Z: 10, O: 50})  Optional reagent buy ceilings.
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
var memoryManager    = require('memoryManager');
var storageManager   = require('storageManager');
var terminalManager  = require('terminalManager');
var pricing          = require('marketPricing');

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

var MEMORY_VERSION = 3;
var MAX_QUEUE_PER_ROOM = 10;
var SELLING_GRACE_TICKS = 200;  // wait at most this long for output evacuation before selling anyway
var STAGING_GRACE_TICKS = 200;  // wait for supplier/lab evacuation before accepting partial output
var SELLING_REARM_GRACE_TICKS = 50;  // wait this long in SELLING before rearming if every tracked order is stale but terminal still holds output
var BUYING_TIMEOUT_TICKS = 2000;
var WAITING_RUN_INTERVAL = 3;
var PROCESSING_RUN_INTERVAL = 3;
var STAGING_RUN_INTERVAL = 5;
var BUYING_POLL_INTERVAL = 5;
var SELLING_SETUP_INTERVAL = 5;
var SELLING_DRAIN_INTERVAL = 10;

var tickCacheTick = -1;
var labsByRoomCache = {};
var roomReadyCache = {};
var creepResourceCache = {};
var ownedSellOrderCache = {};
var marketSellRequestsByResource = {};
var operationRunCache = {};

function ensureTickCache() {
    if (tickCacheTick === Game.time) return;
    tickCacheTick = Game.time;
    labsByRoomCache = {};
    roomReadyCache = {};
    creepResourceCache = {};
    ownedSellOrderCache = {};
    marketSellRequestsByResource = {};
}

function invalidateOwnedSellOrderCache() {
    ownedSellOrderCache = {};
    marketSellRequestsByResource = {};
}

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
    delete op.active;
    delete op.roomName;
    delete op.sink;
    delete op._lastMarketLabRun;
    delete op._lastRunState;
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
        requestSave();
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
    ensureTickCache();
    if (labsByRoomCache[roomName]) return labsByRoomCache[roomName];

    var rs = getRoomState.get(roomName);
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_LAB]) {
        labsByRoomCache[roomName] = rs.structuresByType[STRUCTURE_LAB];
        return labsByRoomCache[roomName];
    }
    var room = Game.rooms[roomName];
    if (!room) {
        labsByRoomCache[roomName] = [];
        return labsByRoomCache[roomName];
    }
    labsByRoomCache[roomName] = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });
    return labsByRoomCache[roomName];
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

function requestSave() {
    if (memoryManager && typeof memoryManager.requestSave === 'function') memoryManager.requestSave();
}

function operationClaimsInput(op, resourceType) {
    if (!op || op._completed || op._failed || op._finalized) return false;
    if (op.state !== STATE_BUYING && op.state !== STATE_WAITING
            && !(op.state === STATE_PROCESSING && !op.reactionStarted)) return false;
    if (op.direction === DIR_REVERSE) return op.targetCompound === resourceType;
    return op.reagents && (op.reagents[0] === resourceType || op.reagents[1] === resourceType);
}

function getInputAvailableForOp(op, roomName, resourceType) {
    var queues = getRoomQueues(roomName);
    var ordered = queues.forward.concat(queues.reverse).filter(function(other) {
        return operationClaimsInput(other, resourceType);
    });
    ordered.sort(function(a, b) {
        var tickDiff = (a.tickStarted || 0) - (b.tickStarted || 0);
        if (tickDiff !== 0) return tickDiff;
        var aId = a.id || '';
        var bId = b.id || '';
        return aId < bId ? -1 : (aId > bId ? 1 : 0);
    });

    var claimed = 0;
    for (var i = 0; i < ordered.length; i++) {
        if (ordered[i] === op) break;
        claimed += ordered[i].batchSize || DEFAULT_BATCH_SIZE;
    }
    return Math.max(0, countInRoom(roomName, resourceType) - claimed);
}

// Record the outcome of a marketLab op back into the autoTrader history so
// the same Memory.autoTrader.jobsStarted entry that started this op shows
// [done] on completion or [FAILED: <reason>] on failure. Matches the most
// recent jobsStarted entry of the right type/room/compound that does not
// already have a status, preferring entries with a tick <= the op's start.
function recordAutoTraderLabOutcome(direction, roomName, op, status, reason) {
    if (!Memory.autoTrader || !Array.isArray(Memory.autoTrader.jobsStarted)) return;
    var targetType = direction === DIR_FORWARD ? 'forward' : 'reverse';
    var opStartedTick = op.tickStarted || op.sellingStartTick || 0;
    var bestIdx = -1;
    var bestScore = -1;
    for (var i = Memory.autoTrader.jobsStarted.length - 1; i >= 0; i--) {
        var job = Memory.autoTrader.jobsStarted[i];
        if (!job) continue;
        if (job.type !== targetType) continue;
        if (job.room !== roomName) continue;
        if (job.compound !== op.targetCompound) continue;
        if (job.status) continue; // already finalized
        if (typeof job.tick !== 'number') continue;
        // Score: prefer entries started at or before the op's own start tick,
        // and prefer the most recent such entry.
        var score = (job.tick <= opStartedTick) ? 1000 : 0;
        score += i;
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }
    if (bestIdx < 0) return;
    var entry = Memory.autoTrader.jobsStarted[bestIdx];
    entry.status = status;
    entry.finishedTick = Game.time;
    if (reason) entry.reason = String(reason).slice(0, 200);
    if (op.id) entry.marketOpId = op.id;
}

// Reservation-aware stock for a room: terminal + storageManager-unreserved
// amount outside the terminal, minus any other program's reservations on the
// terminal/storage for that resource. Mirrors marketSell.getRoomTotalAvailable
// closely but is safe to call from marketLab without a circular import.
function getUnreservedTotalAvailable(roomName, resourceType) {
    var room = Game.rooms[roomName];
    if (!room) return 0;

    var total = 0;
    if (room.terminal && room.terminal.store && room.terminal.store[resourceType]) {
        total += room.terminal.store[resourceType];
    }
    if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === 'function') {
        total += terminalManager.getRoomAvailableOutsideTerminal(roomName, resourceType) || 0;
    }

    var info = storageManager.storageFind(roomName, resourceType);
    if (info && info.combined && typeof info.combined.reserved === 'number') {
        total = Math.max(0, total - info.combined.reserved);
    }
    return total;
}

function findSuitableRoom() {
    var roomNames = getRoomState.ownedNames();
    for (var i = 0; i < roomNames.length; i++) {
        var roomName = roomNames[i];
        var state = getRoomState.get(roomName);
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
    ensureTickCache();
    if (roomReadyCache.hasOwnProperty(roomName)) return roomReadyCache[roomName];

    var state = getRoomState.get(roomName);
    var ready = !!(state
                  && state.isOwned
                  && state.terminal
                  && state.structuresByType
                  && state.structuresByType[STRUCTURE_LAB]
                  && state.structuresByType[STRUCTURE_LAB].length >= 3);
    roomReadyCache[roomName] = ready;
    return ready;
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
    for (var k = 0; k < outputs.length; k++) {
        if (countResourceInRoomCreeps(roomName, outputs[k]) > 0) return false;
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
        direction:           direction,
        origin:              'marketLab',
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
        if (maxPrice && typeof maxPrice === 'object') {
            op.maxReagentPrices = maxPrice;
        }
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

function getMarketSellRequestsFor(roomName, resourceType) {
    ensureTickCache();
    var key = roomName + '|' + resourceType;
    if (marketSellRequestsByResource.hasOwnProperty(key)) return marketSellRequestsByResource[key];

    var matches = [];
    var requests = (Memory.marketSell && Array.isArray(Memory.marketSell.requests)) ? Memory.marketSell.requests : [];
    for (var i = 0; i < requests.length; i++) {
        var req = requests[i];
        if (!req) continue;
        if (req.roomName !== roomName) continue;
        if (req.resourceType !== resourceType) continue;
        matches.push(req);
    }
    marketSellRequestsByResource[key] = matches;
    return matches;
}

function isMarketSellRequestActive(roomName, resourceType, amount, createdTick) {
    var requests = getMarketSellRequestsFor(roomName, resourceType);
    for (var i = 0; i < requests.length; i++) {
        var req = requests[i];
        if (req.orderId && Game.market && Game.market.orders && Game.market.orders[req.orderId]) {
            var liveOrder = Game.market.orders[req.orderId];
            if (typeof liveOrder.remainingAmount === 'number' && liveOrder.remainingAmount > 0) return true;
        }
        if (typeof amount === 'number' && (req.amount || 0) < amount) continue;
        if (typeof createdTick === 'number' && req.created !== createdTick) continue;
        return true;
    }
    return false;
}

function getActiveMarketSellRequest(roomName, resourceType, amount) {
    var requests = getMarketSellRequestsFor(roomName, resourceType);
    for (var i = 0; i < requests.length; i++) {
        var req = requests[i];
        if (req.orderId && Game.market && Game.market.orders && Game.market.orders[req.orderId]) {
            var liveOrder = Game.market.orders[req.orderId];
            if (typeof liveOrder.remainingAmount === 'number' && liveOrder.remainingAmount > 0) {
                if (typeof amount !== 'number'
                    || liveOrder.remainingAmount >= amount
                    || (req.amount || 0) >= amount) {
                    return req;
                }
            }
        }
        if (typeof amount === 'number' && (req.amount || 0) < amount) continue;
        if (req.created === Game.time) return req;
    }
    return null;
}

// Sum up how much of `resourceType` in `roomName` is already covered by
// existing marketSell requests. Counts each live order's remainingAmount
// once (deduped by orderId). For requests without an orderId, only counts
// same-tick entries (avoids perpetuating coverage for stale requests that
// never produced an order, which would otherwise make setup look complete
// when nothing is actually selling).
function getMarketSellCoveredAmount(roomName, resourceType) {
    var requests = getMarketSellRequestsFor(roomName, resourceType);
    var covered = 0;
    var seenOrders = {};
    for (var i = 0; i < requests.length; i++) {
        var req = requests[i];

        if (req.orderId && Game.market && Game.market.orders && Game.market.orders[req.orderId]) {
            if (seenOrders[req.orderId]) continue;
            seenOrders[req.orderId] = true;
            var order = Game.market.orders[req.orderId];
            if (typeof order.remainingAmount === 'number' && order.remainingAmount > 0) {
                covered += order.remainingAmount;
                continue;
            }
        }

        if (req.orderId) continue; // attached but order is fully drained — not coverage

        // No orderId yet: count only requests that were just created this
        // tick (they are in flight and will resolve on the next sync).
        if (req.created === Game.time && typeof req.amount === 'number' && req.amount > 0) {
            covered += req.amount;
        }
    }
    return covered;
}

// Find the id of our own active SELL order for (roomName, resourceType) that
// is large enough to satisfy `requiredAmount`. Used as a fallback when
// marketSell has already extended an existing order but the matching
// Memory.marketSell.requests entry is not yet visible this tick.
function findLiveOwnedSellOrder(roomName, resourceType, requiredAmount) {
    if (!Game.market || !Game.market.orders) return null;
    ensureTickCache();
    var cacheKey = roomName + '|' + resourceType + '|' + (typeof requiredAmount === 'number' ? requiredAmount : 'any');
    if (ownedSellOrderCache.hasOwnProperty(cacheKey)) return ownedSellOrderCache[cacheKey];

    var bestId = null;
    var bestRemaining = -1;
    for (var id in Game.market.orders) {
        var order = Game.market.orders[id];
        if (!order || order.type !== ORDER_SELL) continue;
        if (order.roomName !== roomName) continue;
        if (order.resourceType !== resourceType) continue;
        if (typeof order.remainingAmount !== 'number' || order.remainingAmount <= 0) continue;
        if (typeof requiredAmount === 'number' && order.remainingAmount < requiredAmount) continue;

        var ownerRoom = Game.rooms[order.roomName];
        if (!ownerRoom || !ownerRoom.controller || !ownerRoom.controller.my) continue;

        if (order.remainingAmount > bestRemaining) {
            bestRemaining = order.remainingAmount;
            bestId = id;
        }
    }
    ownedSellOrderCache[cacheKey] = bestId;
    return bestId;
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
    ensureTickCache();
    var roomCache = creepResourceCache[roomName];
    if (!roomCache) {
        roomCache = {};
        creepResourceCache[roomName] = roomCache;
    }
    if (roomCache.hasOwnProperty(resource)) return roomCache[resource];

    var total = 0;
    var idx = getRoomState.creepIndex();
    var creeps = idx && idx.all ? idx.all : [];
    for (var i = 0; i < creeps.length; i++) {
        var creep = creeps[i];
        if (!creep || !creep.room || creep.room.name !== roomName || !creep.store) continue;
        total += creep.store[resource] || 0;
    }
    roomCache[resource] = total;
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
    if (!op.buyingStartedTick) {
        op.buyingStartedTick = op.tickStarted || Game.time;
        requestSave();
    }
    if (Game.time - op.buyingStartedTick > BUYING_TIMEOUT_TICKS) {
        op._failed = true;
        op._failureReason = 'buying timed out after ' + BUYING_TIMEOUT_TICKS + ' ticks';
        requestSave();
        return;
    }
    if (op.direction === DIR_FORWARD) {
        runBuyingForward(op, roomName);
    } else {
        runBuyingReverse(op, roomName);
    }
    // Check for stalled marketBuy orders and fire a one-shot top-up if needed.
    if (!op._failed) maybeTopUpLabMarketBuy(op, roomName);
}

function runBuyingForward(op, roomName) {
    var r1 = getInputAvailableForOp(op, roomName, op.reagents[0]);
    var r2 = getInputAvailableForOp(op, roomName, op.reagents[1]);

    if (r1 >= op.batchSize && r2 >= op.batchSize) {
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound + ': reagents acquired.');
        opportunisticBuy.cancelRequest(roomName, op.reagents[0], { queue: 'lab', opId: op.id });
        opportunisticBuy.cancelRequest(roomName, op.reagents[1], { queue: 'lab', opId: op.id });
        cancelTrackedMarketBuyOrders(op, roomName, op.reagents[0]);
        cancelTrackedMarketBuyOrders(op, roomName, op.reagents[1]);
        op.buyRequestCreated      = false;
        op.initialReagentAmounts  = [r1, r2];
        moveToProcessingOrWaiting(op, roomName);
        return;
    }

    recoverMissingBuyRequests(op, roomName, op.reagents);
    if (op.buyRequestCreated) return;

    var requestsCreated = 0;
    for (var k = 0; k < op.reagents.length; k++) {
        var reagent    = op.reagents[k];
        var currentAmt = getInputAvailableForOp(op, roomName, reagent);
        if (currentAmt >= op.batchSize) continue;

        var maxPrice = op.maxReagentPrices && op.maxReagentPrices[reagent] > 0
            ? op.maxReagentPrices[reagent]
            : pricing.getAvg48h(reagent);
        if (maxPrice === null) continue;

        var amountNeeded = op.batchSize - currentAmt;
        if (labShouldUseMarketBuy(op.targetCompound, reagent, maxPrice)) {
            var bid = labComputeBid(reagent, maxPrice);
            if (bid === null) {
                console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                            ': ask floor for ' + reagent + ' exceeds ceiling ' + maxPrice.toFixed(3) +
                            ' - skipping marketBuy, falling back to opportunisticBuy');
                opportunisticBuy.setup(roomName, reagent, amountNeeded, maxPrice,
                                       { queue: 'lab', product: op.targetCompound, direction: op.direction, opId: op.id });
                requestsCreated++;
            } else {
                var msg = marketBuyer.marketBuy(roomName, reagent, amountNeeded, bid,
                                                 { product: op.targetCompound, room: roomName, ceiling: maxPrice, queue: 'lab', opId: op.id });
                if (marketBuyCreationAccepted(msg)) {
                    trackMarketBuyForLab(op, reagent, maxPrice);
                    requestsCreated++;
                    requestSave();
                }
                console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                            ': marketBuy for ' + amountNeeded + ' ' + reagent +
                            ' @ ' + bid.toFixed(3) + ' (ceiling ' + maxPrice.toFixed(3) + '): ' + msg);
            }
        } else {
            opportunisticBuy.setup(roomName, reagent, amountNeeded, maxPrice,
                                   { queue: 'lab', product: op.targetCompound, direction: op.direction, opId: op.id });
            console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                        ': opportunisticBuy for ' + amountNeeded + ' ' + reagent +
                        ' @ ' + maxPrice.toFixed(3));
            requestsCreated++;
        }
    }
    if (requestsCreated > 0) {
        op.buyRequestCreated = true;
        requestSave();
    }
}

function runBuyingReverse(op, roomName) {
    var currentAmount = getInputAvailableForOp(op, roomName, op.targetCompound);

    if (currentAmount >= op.batchSize) {
        console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                    ': batch acquired (' + currentAmount + ').');
        opportunisticBuy.cancelRequest(roomName, op.targetCompound, { queue: 'lab', opId: op.id });
        cancelTrackedMarketBuyOrders(op, roomName, op.targetCompound);
        op.buyRequestCreated     = false;
        op.initialCompoundAmount = currentAmount;
        moveToProcessingOrWaiting(op, roomName);
        return;
    }

    recoverMissingBuyRequests(op, roomName, [op.targetCompound]);
    if (op.buyRequestCreated) return;

    var maxPrice;
    if (op.maxBuyPrice) {
        maxPrice = op.maxBuyPrice;
    } else {
        maxPrice = pricing.getAvg48h(op.targetCompound);
    }
    if (!(maxPrice > 0)) return;

    var amountNeeded = op.batchSize - currentAmount;
    if (labShouldUseMarketBuy(op.targetCompound, op.targetCompound, maxPrice)) {
        var bid = labComputeBid(op.targetCompound, maxPrice);
        if (bid === null) {
            console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                        ': ask floor exceeds ceiling ' + maxPrice.toFixed(3) +
                        ' - skipping marketBuy, falling back to opportunisticBuy');
            opportunisticBuy.setup(roomName, op.targetCompound, amountNeeded, maxPrice,
                                   { queue: 'lab', product: op.targetCompound, direction: op.direction, opId: op.id });
            op.buyRequestCreated = true;
            requestSave();
        } else {
            var msg = marketBuyer.marketBuy(roomName, op.targetCompound, amountNeeded, bid,
                                             { product: op.targetCompound, room: roomName, ceiling: maxPrice, queue: 'lab', opId: op.id });
            if (marketBuyCreationAccepted(msg)) {
                trackMarketBuyForLab(op, op.targetCompound, maxPrice);
                op.buyRequestCreated = true;
                requestSave();
            }
            console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                        ': marketBuy for ' + amountNeeded + ' @ ' + bid.toFixed(3) +
                        ' (ceiling ' + maxPrice.toFixed(3) + '): ' + msg);
        }
    } else {
        opportunisticBuy.setup(roomName, op.targetCompound, amountNeeded, maxPrice,
                               { queue: 'lab', product: op.targetCompound, direction: op.direction, opId: op.id });
        op.buyRequestCreated = true;
        requestSave();
        console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                    ': opportunisticBuy for ' + amountNeeded + ' @ ' + maxPrice.toFixed(3));
    }
}

function marketBuyCreationAccepted(result) {
    if (result === OK || result === true || result === 'queued') return true;
    if (result && typeof result === 'object') return !!(result.ok || result.created || result.queued);
    if (typeof result !== 'string') return false;
    var text = result.toLowerCase();
    if (text.indexOf('already') >= 0 || text.indexOf('exists') >= 0
            || text.indexOf('refus') >= 0 || text.indexOf('fail') >= 0
            || text.indexOf('error') >= 0 || text.indexOf('invalid') >= 0
            || text.indexOf('cannot') >= 0) return false;
    return text.indexOf('created') >= 0 || text.indexOf('queued') >= 0 || text.indexOf('placed') >= 0;
}

function getManagedBuyRecord(op, roomName, resource) {
    try { return marketBuyer.getOrderRecordFor(roomName, resource, 'lab', op.id); }
    catch (e) { return null; }
}

function recoverMissingBuyRequests(op, roomName, resources) {
    if (!op.buyRequestCreated) return;
    for (var i = 0; i < resources.length; i++) {
        var resource = resources[i];
        if (getInputAvailableForOp(op, roomName, resource) >= op.batchSize) continue;
        var opts = { queue: 'lab', opId: op.id };
        var opportunistic = typeof opportunisticBuy.getRequest === 'function'
            ? opportunisticBuy.getRequest(roomName, resource, opts)
            : null;
        var managed = getManagedBuyRecord(op, roomName, resource);
        if (opportunistic || (managed && !managed.done && !managed.cancelled)) continue;
        if (op.useMarketBuy) op.useMarketBuy[resource] = false;
        if (op.marketBuyToppedUp) op.marketBuyToppedUp[resource] = false;
        op.buyRequestCreated = false;
        requestSave();
        return;
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
    try { marketBuyer.cancelOrderFor(roomName, resource, 'lab op acquired: ' + op.targetCompound, 'lab', op.id); }
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

        var rec = getManagedBuyRecord(op, roomName, resource);
        if (!rec || rec.done || rec.cancelled) {
            op.marketBuyToppedUp[resource] = true;
            continue;
        }
        var need = op.batchSize - getInputAvailableForOp(op, roomName, resource);
        if (need <= 0) {
            op.marketBuyToppedUp[resource] = true;
            continue;
        }
        var got = marketBuyer.getFulfilled(rec);
        if (got >= need * LAB_MARKETBUY_TOPUP_RATIO) {
            op.marketBuyToppedUp[resource] = true;
            continue;
        }
        var ceiling = (op.marketBuyCeilings && op.marketBuyCeilings[resource]) || pricing.getAvg48h(resource);
        if (!(ceiling > 0)) continue;
        var topUpAmt = need;
        if (topUpAmt <= 0) continue;
        opportunisticBuy.setup(roomName, resource, topUpAmt, ceiling,
                               { queue: 'lab', product: op.targetCompound, direction: op.direction, opId: op.id });
        op.marketBuyToppedUp[resource] = true;
        requestSave();
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
    requestSave();
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
        requestSave();
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
    requestSave();
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
    requestSave();
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
    requestSave();
}

function labOrderStarted(result) {
    return typeof result === 'string'
        && (result.indexOf('[Labs] Started') === 0 || result.indexOf('[Labs] Queued') === 0);
}

function failLabOrderStart(op, roomName, result) {
    var reason = 'lab order start failed: ' + (result || 'no result');
    op._failed = true;
    op._failureReason = reason;
    console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                ': ' + reason + '. Op removed from queue.');
    requestSave();
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
                    ': insufficient claimed reagents to react, failing operation.');
        op._failed = true;
        op._failureReason = 'insufficient claimed reagents to start reaction';
        requestSave();
        return;
    }

    console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                ': starting reaction for ' + amountToProcess);
    var outputs = {};
    outputs[op.targetCompound] = amountToProcess;
    setExpectedOutputs(op, outputs);
    op.stageReservationProgram = 'marketLabStage_' + op.id;
    var result = global.orderLabs(roomName, op.targetCompound, amountToProcess, {
        origin: 'marketLab',
        sink: 'terminal',
        marketOpId: op.id
    });
    if (!labOrderStarted(result)) {
        failLabOrderStart(op, roomName, result);
        return;
    }
    op.reactionStarted     = true;
    op.reactionStartedTick = Game.time;
    requestSave();
}

function startReverseLabOrder(op, roomName) {
    // Cap to the configured batch size so pre-existing terminal surplus above
    // the batch doesn't get pulled into a single oversized breakdown order.
    var compoundAmount = Math.min(countInRoom(roomName, op.targetCompound), op.batchSize);
    if (compoundAmount < LAB_REACTION_AMOUNT) {
        op._failed = true;
        op._failureReason = 'insufficient claimed compound to start breakdown';
        requestSave();
        return;
    }
    console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                ': starting breakdown for ' + compoundAmount);
    var outputs = {};
    outputs[op.reagents[0]] = compoundAmount;
    outputs[op.reagents[1]] = compoundAmount;
    setExpectedOutputs(op, outputs);
    op.stageReservationProgram = 'marketLabStage_' + op.id;
    var result = global.breakdownLabs(roomName, op.targetCompound, compoundAmount, {
        origin: 'marketLab',
        sink: 'terminal',
        marketOpId: op.id
    });
    if (!labOrderStarted(result)) {
        failLabOrderStart(op, roomName, result);
        return;
    }
    op.reactionStarted     = true;
    op.reactionStartedTick = Game.time;
    requestSave();
}

function trackedSellOrdersStillLive(op, roomName) {
    if (!op || !Array.isArray(op.sellRequestInfo) || op.sellRequestInfo.length === 0) return false;
    if (!Game.market || !Game.market.orders) return false;

    var checked = 0;
    for (var i = 0; i < op.sellRequestInfo.length; i++) {
        var req = op.sellRequestInfo[i];
        if (!req || req.unavailable || (req.amount || 0) <= 0) continue;
        if (!req.orderId) return false;

        if (!isTrackedSellPending(req, roomName)) return false;
        checked++;
    }
    return checked > 0;
}

// =========================================================================
// STATE: SELLING
// =========================================================================

function runSelling(op, roomName) {
    if (!op.sellingStartTick) op.sellingStartTick = Game.time;

    // Defensive one-shot cleanup for marketBuy orders still tracked from BUYING.
    if (!op.marketBuysCancelled) {
        cancelAllTrackedMarketBuyOrders(op, roomName);
        op.marketBuysCancelled = true;
    }

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
            var handledCount = 0;
            var unavailableCount = 0;
            var unresolved = false;
            if (Array.isArray(op.sellRequestInfo)) {
                for (var si = 0; si < op.sellRequestInfo.length; si++) {
                    var entry = op.sellRequestInfo[si];
                    if (!entry) continue;
                    if (entry.unavailable) {
                        // Recorded as unavailable only when no sellable stock
                        // remains in the room (terminal + outside, after
                        // reservations). Counted as both handled (so we
                        // don't loop forever) AND unavailable (so we can
                        // distinguish a clean completion from a partial
                        // sell that was blocked by another program).
                        handledCount++;
                        unavailableCount++;
                        continue;
                    }
                    if ((entry.amount || 0) <= 0) continue;

                    if (entry.orderId) {
                        handledCount++;
                        continue;
                    }

                    // No orderId: only count as handled if the marketSell
                    // request is still verifiably live (otherwise we'd never
                    // escape the loop for stale "already covered" entries).
                    if (isMarketSellRequestActive(roomName, entry.resource, entry.amount, entry.created)) {
                        handledCount++;
                        continue;
                    }
                    if (findLiveOwnedSellOrder(roomName, entry.resource, entry.amount)) {
                        handledCount++;
                        continue;
                    }
                }
            }
            if (handledCount < expectedCount) {
                // Some expected resources were not even attempted (no entry at
                // all) — this happens when the source stock for that resource
                // is zero. Treat it as handled too if the room has no stock.
                for (var outRes in outputs) {
                    if (!outputs.hasOwnProperty(outRes)) continue;
                    if ((outputs[outRes] || 0) <= 0) continue;
                    var hasEntry = false;
                    for (var sei = 0; sei < op.sellRequestInfo.length; sei++) {
                        if (op.sellRequestInfo[sei] && op.sellRequestInfo[sei].resource === outRes) {
                            hasEntry = true;
                            break;
                        }
                    }
                    if (!hasEntry && countInRoom(roomName, outRes) <= 0) handledCount++;
                }
            }
            if (handledCount < expectedCount) {
                unresolved = true;
            }
            if (!unresolved && unavailableCount > 0) {
                // Strict failure: even if all expected resources are accounted
                // for, any unavailable slot means the op didn't fully sell its
                // expected output. Mark the op as failed, splice it out, and
                // record the outcome so autoTrader('history') shows it as
                // [FAILED: ...] instead of [done].
                if (!op._failed) {
                    var missingNames = [];
                    if (Array.isArray(op.sellRequestInfo)) {
                        for (var fi = 0; fi < op.sellRequestInfo.length; fi++) {
                            var fe = op.sellRequestInfo[fi];
                            if (fe && fe.unavailable) missingNames.push(fe.resource);
                        }
                    }
                    var reason = unavailableCount + ' expected resource(s) fully reserved: ' + missingNames.join(', ');
                    op._failed = true;
                    op._failureReason = reason;
                    console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                                ': sell setup FAILED — ' + reason + '. Op removed from queue.');
                    requestSave();
                }
                return;
            }
            if (unresolved) {
                var detail = op._lastSellResult || 'no marketSell result captured';
                console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                            ': sell order setup incomplete, will retry. last result: ' + detail);
                return;
            }
        }

        op.sellOrderCreated = true;
        requestSave();
        return;
    }

    if (trackedSellOrdersStillLive(op, roomName)) return;

    // Wait for terminals to drain. If isOperationDrained returned false but
    // every tracked sell request has gone stale (no live order, no live
    // request, only terminal stock remaining), rearm the setup so we don't
    // hang forever with a satisfied-looking op and unsold resources.
    if (isOperationDrained(op, roomName)) {
        console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                    (op.salvageMode ? ': salvage complete.' : ': complete.'));
        op._completed = true;
        requestSave();
        return;
    }

    if (op.origin === 'marketLab'
            && Array.isArray(op.sellRequestInfo)
            && op.sellRequestInfo.length > 0
            && hasStockWithoutLiveOrder(op, roomName)) {
        var age = Game.time - (op.sellingStartTick || Game.time);
        if (age >= SELLING_REARM_GRACE_TICKS) {
            console.log('[marketLab ' + shortTagFor(op.direction) + '] ' + roomName + '/' + op.targetCompound +
                        ': all sell orders inactive but terminal still holds expected output. Rearming sell setup (age ' + age + ' ticks).');
            op.sellOrderCreated = false;
            op.sellRequestInfo  = [];
            requestSave();
        }
    }
}

function hasStockWithoutLiveOrder(op, roomName) {
    if (!Array.isArray(op.sellRequestInfo) || op.sellRequestInfo.length === 0) return false;
    for (var i = 0; i < op.sellRequestInfo.length; i++) {
        var req = op.sellRequestInfo[i];
        if (!req) continue;

        if (isTrackedSellPending(req, roomName)) return false;
        if (getTrackedAllocationRemaining(req, roomName) <= 0) return false;
    }
    return true;
}

function makeSellTrackingEntry(roomName, resource, amount, created, orderId, unavailable) {
    var order = orderId && Game.market && Game.market.orders ? Game.market.orders[orderId] : null;
    return {
        resource: resource,
        amount: amount,
        created: created,
        orderId: orderId || null,
        orderStartRemaining: order && typeof order.remainingAmount === 'number' ? order.remainingAmount : null,
        unavailable: !!unavailable,
        stockBaseline: Math.max(0, countInRoom(roomName, resource) - amount)
    };
}

function isTrackedSellPending(req, roomName) {
    if (!req || req.unavailable || (req.amount || 0) <= 0) return false;
    var order = req.orderId && Game.market && Game.market.orders ? Game.market.orders[req.orderId] : null;
    if (order && typeof order.remainingAmount === 'number' && order.remainingAmount > 0) {
        if (typeof req.orderStartRemaining === 'number'
                && req.orderStartRemaining - order.remainingAmount >= req.amount) return false;
        return true;
    }
    return isMarketSellRequestActive(roomName, req.resource, req.amount, req.created);
}

function getTrackedAllocationRemaining(req, roomName) {
    if (!req || (req.amount || 0) <= 0) return 0;
    if (typeof req.stockBaseline !== 'number') return countInRoom(roomName, req.resource);
    return Math.min(req.amount, Math.max(0, countInRoom(roomName, req.resource) - req.stockBaseline));
}

function placeForwardSellOrders(op, roomName) {
    var outputs = getExpectedOutputs(op);
    var compoundAmount = outputs && outputs[op.targetCompound] ? outputs[op.targetCompound] : countInRoom(roomName, op.targetCompound);

    if (compoundAmount > 0) {
        // Cap to reservation-aware available amount so we don't keep trying to
        // sell a quantity marketSell can never accept (e.g. terminal has 3000
        // compound but 2000 is reserved by a different program).
        var available = getUnreservedTotalAvailable(roomName, op.targetCompound);
        var amt = Math.max(0, Math.min(compoundAmount, available, MAX_BATCH_SIZE));
        if (amt <= 0) {
            if (!op.sellRequestInfo) op.sellRequestInfo = [];
            op.sellRequestInfo.push(makeSellTrackingEntry(roomName, op.targetCompound, 0, Game.time, null, true));
            console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                        ': sell ' + compoundAmount + ' deferred, only ' + available + ' unreserved available.');
            return;
        }
        var covered = getMarketSellCoveredAmount(roomName, op.targetCompound);
        var alreadyInfo = null;
        if (covered >= amt) {
            var coveredReq = getActiveMarketSellRequest(roomName, op.targetCompound, amt);
            alreadyInfo = makeSellTrackingEntry(roomName, op.targetCompound, amt,
                                                (coveredReq && coveredReq.created) || Game.time,
                                                (coveredReq && coveredReq.orderId) || null, false);
        }
        var remaining = amt - covered;
        if (remaining < 0) remaining = 0;

        if (alreadyInfo) {
            op.sellRequestInfo = [alreadyInfo];
            if (remaining === 0) {
                console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                            ': sell ' + amt + ' already covered by existing marketSell request(s).');
            }
        }

        if (remaining > 0) {
            console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                        ': sell order ' + remaining + ' (target ' + amt + ', covered ' + covered + ', expected ' + compoundAmount + ')');
            var existing = getActiveMarketSellRequest(roomName, op.targetCompound, remaining);
            if (existing) {
                if (!op.sellRequestInfo) op.sellRequestInfo = [];
                op.sellRequestInfo.push(makeSellTrackingEntry(roomName, op.targetCompound, remaining,
                                                              existing.created || Game.time, existing.orderId || null, false));
            } else {
                var result = global.marketSell(roomName, op.targetCompound, remaining);
                invalidateOwnedSellOrderCache();
                requestSave();
                op._lastSellResult = (typeof result === 'string') ? result : String(result);
                if (typeof result === 'string' &&
                    (result.indexOf('Created SELL order') !== -1 || result.indexOf('extended existing') !== -1)) {
                    var created = getActiveMarketSellRequest(roomName, op.targetCompound, remaining);
                    if (!op.sellRequestInfo) op.sellRequestInfo = [];
                    if (created) {
                        op.sellRequestInfo.push(makeSellTrackingEntry(roomName, op.targetCompound, remaining,
                                                                      created.created || Game.time, created.orderId || null, false));
                    } else {
                        var liveOrderId = findLiveOwnedSellOrder(roomName, op.targetCompound, remaining);
                        op.sellRequestInfo.push(makeSellTrackingEntry(roomName, op.targetCompound, remaining,
                                                                      Game.time, liveOrderId, false));
                    }
                }
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
            invalidateOwnedSellOrderCache();
            requestSave();
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
        // Cap the sell target to what is actually sellable: marketSell
        // subtracts storageManager reservations, so an expected amount of
        // 3000 Z when only 2000 Z is unreserved would fail forever and spam
        // "setup incomplete" retries.
        var available = getUnreservedTotalAvailable(roomName, reagent);
        var target = Math.max(0, Math.min(amt, available, MAX_BATCH_SIZE));
        if (target <= 0) {
            // Nothing of this reagent is sellable right now (it's all reserved
            // or already moved into the terminal for a different buyer).
            // Record an empty entry so runSelling()'s expectedCount check sees
            // the slot as handled and the op can advance.
            if (!op.sellRequestInfo) op.sellRequestInfo = [];
            op.sellRequestInfo.push(makeSellTrackingEntry(roomName, reagent, 0, Game.time, null, true));
            console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                        ': sell ' + amt + ' ' + reagent + ' deferred, only ' + available + ' unreserved available.');
            continue;
        }
        var sellAmt = target;
        var covered = getMarketSellCoveredAmount(roomName, reagent);
        var remaining = sellAmt - covered;
        if (remaining < 0) remaining = 0;
        if (covered >= sellAmt) {
            var coveredReq = getActiveMarketSellRequest(roomName, reagent, sellAmt);
            var coveredOrderId = (coveredReq && coveredReq.orderId) || findLiveOwnedSellOrder(roomName, reagent, sellAmt) || null;
            if (!op.sellRequestInfo) op.sellRequestInfo = [];
            op.sellRequestInfo.push(makeSellTrackingEntry(roomName, reagent, sellAmt,
                                                          (coveredReq && coveredReq.created) || Game.time,
                                                          coveredOrderId, false));
            console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                        ': sell ' + sellAmt + ' ' + reagent + ' already covered by existing marketSell request(s).');
            continue;
        }
        console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                    ': sell ' + remaining + ' ' + reagent + ' (target ' + sellAmt + ', covered ' + covered + ', expected ' + amt + ')');
        var existing = getActiveMarketSellRequest(roomName, reagent, remaining);
        if (existing) {
            if (!op.sellRequestInfo) op.sellRequestInfo = [];
            op.sellRequestInfo.push(makeSellTrackingEntry(roomName, reagent, remaining,
                                                          existing.created || Game.time, existing.orderId || null, false));
        } else {
            var result = global.marketSell(roomName, reagent, remaining);
            invalidateOwnedSellOrderCache();
            requestSave();
            op._lastSellResult = (typeof result === 'string') ? result : String(result);
            if (typeof result === 'string' &&
                (result.indexOf('Created SELL order') !== -1 || result.indexOf('extended existing') !== -1)) {
                if (!op.sellRequestInfo) op.sellRequestInfo = [];
                var recorded = getActiveMarketSellRequest(roomName, reagent, remaining);
                if (recorded) {
                    op.sellRequestInfo.push(makeSellTrackingEntry(roomName, reagent, remaining,
                                                                  recorded.created || Game.time, recorded.orderId || null, false));
                } else {
                    var liveOrderId = findLiveOwnedSellOrder(roomName, reagent, remaining);
                    op.sellRequestInfo.push(makeSellTrackingEntry(roomName, reagent, remaining,
                                                                  Game.time, liveOrderId, false));
                }
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
            invalidateOwnedSellOrderCache();
            requestSave();
        }
    }
}

function isOperationDrained(op, roomName) {
    if (op.origin === 'marketLab' && getExpectedOutputs(op)
            && (!Array.isArray(op.sellRequestInfo) || op.sellRequestInfo.length === 0)) return true;
    if (op.origin === 'marketLab' && Array.isArray(op.sellRequestInfo) && op.sellRequestInfo.length > 0) {
        for (var s = 0; s < op.sellRequestInfo.length; s++) {
            var req = op.sellRequestInfo[s];
            if (!req) continue;

            // Direct live-order check: if we recorded an orderId and it's still
            // in Game.market.orders with remainingAmount > 0, the op is not
            // drained regardless of what the request book says.
            if (isTrackedSellPending(req, roomName)) return false;

            // No live order, no request — but the resource is still sitting in
            // the terminal. The op must not declare itself done. Let
            // runSelling() notice the lack of an order and rearm on the next
            // pass instead of hanging here.
            if (getTrackedAllocationRemaining(req, roomName) > 0) return false;
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

function getOperationRunInterval(op) {
    if (!op || !op.state) return 1;
    if (op.state === STATE_BUYING) return op.buyRequestCreated ? BUYING_POLL_INTERVAL : 1;
    if (op.state === STATE_WAITING) return WAITING_RUN_INTERVAL;
    if (op.state === STATE_PROCESSING) return op.reactionStarted ? PROCESSING_RUN_INTERVAL : 1;
    if (op.state === STATE_STAGING) return STAGING_RUN_INTERVAL;
    if (op.state === STATE_SELLING) return op.sellOrderCreated ? SELLING_DRAIN_INTERVAL : SELLING_SETUP_INTERVAL;
    return 1;
}

function shouldSkipOperationThisTick(op) {
    if (!op) return true;
    if (!op.state) return false;
    var cached = operationRunCache[op.id];
    if (!cached || cached.state !== op.state) return false;

    var interval = getOperationRunInterval(op);
    if (interval <= 1) return false;

    return (Game.time - cached.tick) < interval;
}

// =========================================================================
// OPERATION DRIVER
// =========================================================================

function runOperation(op, roomName) {
    if (shouldSkipOperationThisTick(op)) return;
    operationRunCache[op.id] = { tick: Game.time, state: op.state };

    // Defensive: backfill batchSize / direction if missing (legacy save).
    if (!op.batchSize) {
        var batchInfo = calculateBatchSize(roomName);
        op.batchSize      = batchInfo.batchSize;
        op.outputLabCount = batchInfo.outputLabCount;
        requestSave();
    }
    if (!op.direction) {
        op.direction = DIR_FORWARD;
        requestSave();
    }

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
            requestSave();
            break;
    }
}

function processDirection(direction) {
    var mem = ensureMemory(direction);
    var tag = shortTagFor(direction);

    for (var roomName in mem.rooms) {
        var queue = mem.rooms[roomName];
        if (!queue || queue.length === 0) {
            delete mem.rooms[roomName];
            continue;
        }

        if (!roomHasLabsAndTerminal(roomName)) {
            console.log('[marketLab ' + tag + '] room ' + roomName + ' lost critical structures, clearing queue.');
            for (var qi = 0; qi < queue.length; qi++) {
                if (!queue[qi].direction) queue[qi].direction = direction;
                finalizeOperation(queue[qi], roomName, 'failed', 'room lost terminal or required labs');
            }
            delete mem.rooms[roomName];
            requestSave();
            continue;
        }

        for (var i = queue.length - 1; i >= 0; i--) {
            var op = queue[i];
            runOperation(op, roomName);
            if (op._completed || op._failed) {
                finalizeOperation(op, roomName, op._completed ? 'completed' : 'failed',
                                  op._completed ? (op.salvageMode ? 'salvage' : 'drained') : op._failureReason);
                queue.splice(i, 1);
                delete operationRunCache[op.id];
                requestSave();
            }
        }
        if (queue.length === 0) delete mem.rooms[roomName];
    }
}

function hasQueuedOperations(mem) {
    if (!mem || !mem.rooms) return false;
    for (var roomName in mem.rooms) {
        var queue = mem.rooms[roomName];
        if (queue && queue.length > 0) return true;
    }
    return false;
}

function findBuyingOperation(direction, compound) {
    var mem = ensureMemory(direction);
    for (var roomName in mem.rooms) {
        var queue = mem.rooms[roomName];
        if (!queue) continue;
        for (var i = 0; i < queue.length; i++) {
            var op = queue[i];
            if (op && op.targetCompound === compound && op.state === STATE_BUYING) {
                return { roomName: roomName, op: op };
            }
        }
    }
    return null;
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
    if (queue.length >= MAX_QUEUE_PER_ROOM) {
        return '[' + tagFor(direction) + '] Queue limit reached in ' + roomName +
               ' (' + MAX_QUEUE_PER_ROOM + ' operations)';
    }
    for (var i = 0; i < queue.length; i++) {
        if (queue[i].targetCompound === compound) {
            return '[' + tagFor(direction) + '] ' + compound +
                   ' is already queued/processing in ' + roomName;
        }
    }

    var buyingOp = findBuyingOperation(direction, compound);
    if (buyingOp) {
        return '[' + tagFor(direction) + '] ' + compound +
               ' is already buying in ' + buyingOp.roomName;
    }

    var op = createOperation(direction, roomName, compound, reagents, maxPrice);
    queue.push(op);
    requestSave();

    var arrow = direction === DIR_FORWARD
        ? (reagents.join(' + ') + ' -> ' + compound)
        : (compound + ' -> ' + reagents.join(' + '));
    var priceInfo = op.maxBuyPrice ? ' (max ' + op.maxBuyPrice.toFixed(3) + ')' : '';
    return '[' + tagFor(direction) + '] Queued: ' + arrow + ' in ' + roomName +
           ' (batch: ' + op.batchSize + ', position: ' + queue.length + ')' + priceInfo;
}

function cancelBuyForOp(direction, roomName, op) {
    var opts = { queue: 'lab', opId: op.id };
    if (direction === DIR_FORWARD) {
        if (opportunisticBuy.getRequest(roomName, op.reagents[0], opts)) {
            opportunisticBuy.cancelRequest(roomName, op.reagents[0], opts);
        }
        if (opportunisticBuy.getRequest(roomName, op.reagents[1], opts)) {
            opportunisticBuy.cancelRequest(roomName, op.reagents[1], opts);
        }
    } else {
        if (opportunisticBuy.getRequest(roomName, op.targetCompound, opts)) {
            opportunisticBuy.cancelRequest(roomName, op.targetCompound, opts);
        }
    }
    cancelAllTrackedMarketBuyOrders(op, roomName);
    op.buyRequestCreated = false;
}

function cancelStagingForOp(roomName, op) {
    if (!op || !op.stageReservationProgram) return;
    clearStagingReservations(op, roomName);
    op.stageReservationProgram = null;
}

function finalizeOperation(op, roomName, outcome, reason) {
    if (!op || op._finalized) return;
    op._finalized = true;
    cancelBuyForOp(op.direction || DIR_FORWARD, roomName, op);
    cancelStagingForOp(roomName, op);
    if (outcome === 'completed') {
        op._completed = true;
        recordAutoTraderLabOutcome(op.direction, roomName, op, 'completed', reason);
    } else {
        op._failed = outcome === 'failed';
        recordAutoTraderLabOutcome(op.direction, roomName, op, outcome === 'cancelled' ? 'cancelled' : 'failed', reason);
    }
    requestSave();
}

function stopOperation(direction, roomName, compound) {
    var mem = ensureMemory(direction);
    var tag = tagFor(direction);

    if (!roomName) {
        var stoppedAll = 0;
        for (var rn in mem.rooms) {
            var q = mem.rooms[rn];
            for (var i = 0; i < q.length; i++) {
                if (!q[i].direction) q[i].direction = direction;
                finalizeOperation(q[i], rn, 'cancelled', 'stopped by operator');
            }
            stoppedAll += q.length;
        }
        mem.rooms = {};
        requestSave();
        return '[' + tag + '] Stopped ' + stoppedAll + ' op(s) in all rooms.';
    }

    var queue = mem.rooms[roomName];
    if (!queue || queue.length === 0) {
        return '[' + tag + '] No operations in ' + roomName;
    }

    if (!compound) {
        var stopped = queue.length;
        for (var j = 0; j < queue.length; j++) {
            if (!queue[j].direction) queue[j].direction = direction;
            finalizeOperation(queue[j], roomName, 'cancelled', 'stopped by operator');
        }
        delete mem.rooms[roomName];
        requestSave();
        return '[' + tag + '] Stopped ' + stopped + ' op(s) in ' + roomName;
    }

    for (var k = queue.length - 1; k >= 0; k--) {
        if (queue[k].targetCompound === compound) {
            if (!queue[k].direction) queue[k].direction = direction;
            finalizeOperation(queue[k], roomName, 'cancelled', 'stopped by operator');
            queue.splice(k, 1);
            requestSave();
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
            if (!queue[i].direction) queue[i].direction = direction;
            finalizeOperation(queue[i], roomName, 'cancelled', 'memory reset by operator');
        }
    }
    Memory[memKey(direction)] = { rooms: {}, version: MEMORY_VERSION };
    requestSave();
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
        if (op.maxReagentPrices) {
            var priceParts = [];
            for (var priceRes in op.maxReagentPrices) {
                if (!op.maxReagentPrices.hasOwnProperty(priceRes)) continue;
                priceParts.push(priceRes + ':' + op.maxReagentPrices[priceRes].toFixed(3));
            }
            if (priceParts.length > 0) lines.push('      Max buys: ' + priceParts.join(', '));
        }

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
            if (Array.isArray(op.sellRequestInfo) && op.sellRequestInfo.length > 0) {
                for (var sri = 0; sri < op.sellRequestInfo.length; sri++) {
                    var sReq = op.sellRequestInfo[sri];
                    if (!sReq) continue;
                    var liveInfo = '';
                    if (sReq.orderId && Game.market && Game.market.orders && Game.market.orders[sReq.orderId]) {
                        var lOrd = Game.market.orders[sReq.orderId];
                        liveInfo = ' live=' + (lOrd.remainingAmount || 0) + '/' + (lOrd.totalAmount || '?');
                    } else {
                        liveInfo = ' no-live-order';
                    }
                    lines.push('      Sell req: ' + sReq.resource + ' x ' + sReq.amount + ' orderId=' + (sReq.orderId || 'null') + liveInfo);
                }
            } else {
                lines.push('      Sell req: <none>');
            }
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
            // arg3 is optional: numeric maxPrice for reverse, reagent price map for forward.
            var maxPrice = (typeof arg3 === 'number' || (arg3 && typeof arg3 === 'object')) ? arg3 : null;
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
        var mem = ensureMemory(DIR_FORWARD);
        if (!hasQueuedOperations(mem)) return;
        processDirection(DIR_FORWARD);
    },

    runReverse: function() {
        if (Memory._marketLabRevTick === Game.time) return;
        Memory._marketLabRevTick = Game.time;
        var mem = ensureMemory(DIR_REVERSE);
        if (!hasQueuedOperations(mem)) return;
        processDirection(DIR_REVERSE);
    }
};
