/**
 * marketLab.js
 *
 * Consolidated lab market operations (replaces marketLabForward.js + marketLabReverse.js).
 *
 *   FORWARD: Buy reagents -> Combine in labs -> Sell compound
 *   REVERSE: Buy compound -> Break down in labs -> Sell reagents
 *
 * KEY CHANGES FROM THE OLD MODULES:
 *   - No restart logic.  Each operation runs ONE lab order during PROCESSING,
 *     then moves to SELLING regardless of leftover material.  Any surplus
 *     reagents/compound left in the terminal are sold off via salvage mode
 *     in SELLING (skipping resources reserved by other queued ops).
 *
 *   - Backwards compatible with autoTrader and the existing console flows:
 *     keeps Memory.marketLabForward.rooms[roomName] and
 *     Memory.marketLabReverse.rooms[roomName] populated with ops that expose
 *     `targetCompound`, `state`, and `reagents`.
 *
 *   - Field names normalised across directions:
 *       buyRequestCreated, reactionStarted, sellOrderCreated
 *     Legacy field names from older saves (buyRequestsCreated /
 *     sellOrdersCreated / breakdownStarted) are migrated on first read.
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
 */

var opportunisticBuy = require('opportunisticBuy');
var getRoomState     = require('getRoomState');

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
var STATE_SELLING    = 'SELLING';

var DIR_FORWARD = 'forward';
var DIR_REVERSE = 'reverse';

var MEMORY_VERSION = 2;
var SELLING_GRACE_TICKS = 200;  // wait at most this long for output before bailing out

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

// =========================================================================
// OPERATION FACTORY
// =========================================================================

function createOperation(direction, roomName, compound, reagents, maxPrice) {
    var batchInfo = calculateBatchSize(roomName);

    var op = {
        active:              true,
        direction:           direction,
        roomName:            roomName,
        targetCompound:      compound,
        reagents:            reagents,
        state:               STATE_BUYING,
        tickStarted:         Game.time,
        buyRequestCreated:   false,
        reactionStarted:     false,
        sellOrderCreated:    false,
        salvageMode:         false,
        batchSize:           batchInfo.batchSize,
        outputLabCount:      batchInfo.outputLabCount
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
}

function runBuyingForward(op, roomName) {
    var r1 = countInRoom(roomName, op.reagents[0]);
    var r2 = countInRoom(roomName, op.reagents[1]);

    if (r1 >= op.batchSize && r2 >= op.batchSize) {
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound + ': reagents acquired.');
        opportunisticBuy.cancelRequest(roomName, op.reagents[0]);
        opportunisticBuy.cancelRequest(roomName, op.reagents[1]);
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
        opportunisticBuy.setup(roomName, reagent, amountNeeded, maxPrice);
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                    ': buy request for ' + amountNeeded + ' ' + reagent);
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
    opportunisticBuy.setup(roomName, op.targetCompound, amountNeeded, maxPrice);
    op.buyRequestCreated = true;
    console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                ': buy request for ' + amountNeeded + ' @ ' + maxPrice.toFixed(3));
}

function moveToProcessingOrWaiting(op, roomName) {
    var tag = shortTagFor(op.direction);
    if (!isRoomProcessing(roomName)) {
        op.state = STATE_PROCESSING;
        console.log('[marketLab ' + tag + '] ' + roomName + '/' + op.targetCompound + ': starting processing.');
    } else {
        op.state = STATE_WAITING;
        console.log('[marketLab ' + tag + '] ' + roomName + '/' + op.targetCompound + ': labs busy, waiting.');
    }
}

// =========================================================================
// STATE: WAITING
// =========================================================================

function runWaiting(op, roomName) {
    if (isRoomProcessing(roomName)) return;

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

    // Guard: give labManager at least a few ticks to activate the order
    // before we conclude it's finished. This prevents a false-done on the
    // tick immediately after breakdownLabs/orderLabs is called.
    var ticksSinceStart = Game.time - (op.reactionStartedTick || op.tickStarted);
    if (ticksSinceStart < 3) return;   // ← the key guard

    var tag = shortTagFor(op.direction);
    console.log('[marketLab ' + tag + '] ' + roomName + '/' + op.targetCompound +
                ': lab order complete, moving to sell.');
    op.state       = STATE_SELLING;
    op.salvageMode = true;
}

function startForwardLabOrder(op, roomName) {
    var r1 = countInRoom(roomName, op.reagents[0]);
    var r2 = countInRoom(roomName, op.reagents[1]);

    // Use initial amounts if we recorded them (more accurate immediately
    // after BUYING), otherwise fall back to current terminal counts.
    var r1Initial = (op.initialReagentAmounts && op.initialReagentAmounts[0]) || r1;
    var r2Initial = (op.initialReagentAmounts && op.initialReagentAmounts[1]) || r2;
    var amountToProcess = Math.min(r1Initial, r2Initial);

    if (amountToProcess < LAB_REACTION_AMOUNT) {
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                    ': insufficient reagents to react, moving directly to sell.');
        op.state       = STATE_SELLING;
        op.salvageMode = true;
        return;
    }

    console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound +
                ': starting reaction for ' + amountToProcess);
    global.orderLabs(roomName, op.targetCompound, amountToProcess);
    op.reactionStarted = true;
}

function startReverseLabOrder(op, roomName) {
    var compoundAmount = countInRoom(roomName, op.targetCompound);
    if (compoundAmount < LAB_REACTION_AMOUNT) {
        op.state = STATE_SELLING;
        op.salvageMode = true;
        return;
    }
    console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                ': starting breakdown for ' + compoundAmount);
    global.breakdownLabs(roomName, op.targetCompound, compoundAmount);
    op.reactionStarted     = true;
    op.reactionStartedTick = Game.time;  // ← record when we fired it
}

// =========================================================================
// STATE: SELLING
// =========================================================================

function runSelling(op, roomName) {
    if (!op.sellingStartTick) op.sellingStartTick = Game.time;

    if (!op.sellOrderCreated) {
        if (op.direction === DIR_FORWARD) {
            placeForwardSellOrders(op, roomName);
        } else {
            placeReverseSellOrders(op, roomName);
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
    var compoundAmount = countInRoom(roomName, op.targetCompound);

    if (compoundAmount > 0) {
        var amt = Math.min(compoundAmount, MAX_BATCH_SIZE);
        console.log('[marketLab fwd] ' + roomName + '/' + op.targetCompound + ': sell order ' + amt);
        global.marketSell(roomName, op.targetCompound, amt);
    }

    // Salvage: sell any reagent surplus that no other op is waiting on.
    if (op.salvageMode) {
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
    for (var k = 0; k < op.reagents.length; k++) {
        var reagent = op.reagents[k];
        if (isResourceReservedByOtherOp(roomName, reagent, op)) continue;
        var amt = countInRoom(roomName, reagent);
        if (amt <= 0) continue;
        var sellAmt = Math.min(amt, MAX_BATCH_SIZE);
        console.log('[marketLab rev] ' + roomName + '/' + op.targetCompound +
                    ': sell ' + sellAmt + ' ' + reagent);
        global.marketSell(roomName, reagent, sellAmt);
    }

    // Salvage: leftover compound that wasn't broken down also gets sold off
    // (unless another op needs it).
    if (op.salvageMode) {
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

function stopOperation(direction, roomName, compound) {
    var mem = ensureMemory(direction);
    var tag = tagFor(direction);

    if (!roomName) {
        var stoppedAll = 0;
        for (var rn in mem.rooms) {
            var q = mem.rooms[rn];
            for (var i = 0; i < q.length; i++) cancelBuyForOp(direction, rn, q[i]);
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
        for (var j = 0; j < queue.length; j++) cancelBuyForOp(direction, roomName, queue[j]);
        mem.rooms[roomName] = [];
        return '[' + tag + '] Stopped ' + stopped + ' op(s) in ' + roomName;
    }

    for (var k = queue.length - 1; k >= 0; k--) {
        if (queue[k].targetCompound === compound) {
            cancelBuyForOp(direction, roomName, queue[k]);
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
        for (var i = 0; i < queue.length; i++) cancelBuyForOp(direction, roomName, queue[i]);
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
        } else if (op.state === STATE_SELLING) {
            lines.push('      ' + op.targetCompound + ': ' + countInRoom(roomName, op.targetCompound));
            lines.push('      ' + op.reagents[0] + ': ' + countInRoom(roomName, op.reagents[0]));
            lines.push('      ' + op.reagents[1] + ': ' + countInRoom(roomName, op.reagents[1]));
            lines.push('      Waiting in sell: ' + (Game.time - (op.sellingStartTick || Game.time)) + ' ticks');
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