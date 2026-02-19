/**
 * marketLabReverse.js
 * 
 * Buy compound -> Break down in labs -> Sell reagents
 * 
 * SUPPORTS MULTIPLE CONCURRENT OPERATIONS PER ROOM:
 * - BUYING: Multiple can run in parallel
 * - WAITING: Queued, waiting for labs to be free
 * - PROCESSING: Only ONE at a time (using labs)
 * - SELLING: Multiple can run in parallel
 * 
 * CONSOLE COMMANDS:
 *   labReverse()                    - Show status of ALL active operations
 *   labReverse('E3N46')             - Show status for specific room
 *   labReverse('E3N46', 'ZO')       - Start/queue operation for ZO in room E3N46
 *   labReverse('E3N46', 'ZO', 50)   - Start operation with max buy price of 50 credits
 *   labReverse('ZO')                - Start operation for ZO (auto-selects room)
 *   labReverse('stop')              - Stop ALL operations
 *   labReverse('stop', 'E3N46')     - Stop all operations in specific room
 *   labReverse('stop', 'E3N46', 'ZO') - Stop specific compound in room
 *   labReverse('reset')             - Full reset (clears all memory)
 *   labReverse('check', 'E3N46')    - Check batch size for room
 */

var opportunisticBuy = require('opportunisticBuy');
var getRoomState = require('getRoomState');

var LAB_CAPACITY = 3000;
var DEFAULT_BATCH_SIZE = 3000;

// States
var STATE_BUYING = 'BUYING';
var STATE_WAITING = 'WAITING';
var STATE_PROCESSING = 'PROCESSING';
var STATE_SELLING = 'SELLING';

function ensureMemory() {
    if (!Memory.marketLabReverse) {
        Memory.marketLabReverse = { rooms: {} };
    }
    if (!Memory.marketLabReverse.rooms) {
        // Migrate from old format
        if (Memory.marketLabReverse.operations) {
            Memory.marketLabReverse.rooms = {};
            for (var roomName in Memory.marketLabReverse.operations) {
                var oldOp = Memory.marketLabReverse.operations[roomName];
                if (oldOp && oldOp.active) {
                    Memory.marketLabReverse.rooms[roomName] = [oldOp];
                }
            }
            delete Memory.marketLabReverse.operations;
        } else {
            Memory.marketLabReverse.rooms = {};
        }
    }
}

function ensureRoomQueue(roomName) {
    ensureMemory();
    if (!Memory.marketLabReverse.rooms[roomName]) {
        Memory.marketLabReverse.rooms[roomName] = [];
    }
    return Memory.marketLabReverse.rooms[roomName];
}

function calculateBatchSize(roomName) {
    var room = Game.rooms[roomName];
    if (!room) {
        return { batchSize: DEFAULT_BATCH_SIZE, outputLabCount: 1, inputPair: null };
    }
    
    var labs = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });
    
    if (labs.length < 3) {
        return { batchSize: DEFAULT_BATCH_SIZE, outputLabCount: 1, inputPair: null };
    }
    
    var bestIn1 = null;
    var bestIn2 = null;
    var bestOutputCount = 0;
    
    for (var i = 0; i < labs.length; i++) {
        for (var j = i + 1; j < labs.length; j++) {
            var a = labs[i];
            var b = labs[j];
            
            var outputCount = 0;
            for (var k = 0; k < labs.length; k++) {
                if (k === i || k === j) continue;
                var l = labs[k];
                if (a.pos.inRangeTo(l, 2) && b.pos.inRangeTo(l, 2)) {
                    outputCount++;
                }
            }
            
            if (outputCount > bestOutputCount) {
                bestOutputCount = outputCount;
                bestIn1 = a;
                bestIn2 = b;
            }
        }
    }
    
    if (bestOutputCount === 0) {
        return { batchSize: DEFAULT_BATCH_SIZE, outputLabCount: 1, inputPair: null };
    }
    
    return {
        batchSize: bestOutputCount * LAB_CAPACITY,
        outputLabCount: bestOutputCount,
        inputPair: [bestIn1, bestIn2]
    };
}

function createOperation(roomName, compound, reagents, maxPrice) {
    var batchInfo = calculateBatchSize(roomName);
    
    var op = {
        active: true,
        roomName: roomName,
        targetCompound: compound,
        reagents: reagents,
        state: STATE_BUYING,
        tickStarted: Game.time,
        buyRequestCreated: false,
        breakdownStarted: false,
        sellOrdersCreated: false,
        initialCompoundAmount: 0,
        batchSize: batchInfo.batchSize,
        outputLabCount: batchInfo.outputLabCount,
        lastBreakdownStartTick: 0
    };
    
    // Store max price if provided (used instead of marketPrice lookup)
    if (typeof maxPrice === 'number' && maxPrice > 0) {
        op.maxBuyPrice = maxPrice;
    }
    
    return op;
}

function findReagents(compound) {
    var result = [];
    for (var r1 in REACTIONS) {
        for (var r2 in REACTIONS[r1]) {
            if (REACTIONS[r1][r2] === compound) {
                result.push(r1);
                result.push(r2);
                return result;
            }
        }
    }
    return result;
}

function isValidCompoundInput(RES) {
    for (var r1 in REACTIONS) {
        for (var r2 in REACTIONS[r1]) {
            if (REACTIONS[r1][r2] === RES) return true;
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
    var pricePart = parts[1].trim();
    var priceMatch = pricePart.match(/^(\d+\.\d+)/);
    if (priceMatch && priceMatch[1]) {
        return parseFloat(priceMatch[1]);
    }
    return NaN;
}

function findSuitableRoom() {
    ensureMemory();
    var allRooms = getRoomState.all();
    
    for (var roomName in allRooms) {
        var state = allRooms[roomName];
        if (!state.controller || !state.controller.my) continue;
        if (state.terminal && state.structuresByType && state.structuresByType[STRUCTURE_LAB] && state.structuresByType[STRUCTURE_LAB].length >= 3) {
            return roomName;
        }
    }
    return null;
}

function roomHasLabsAndTerminal(roomName) {
    var state = getRoomState.get(roomName);
    if (!state) return false;
    if (!state.terminal) return false;
    if (!state.structuresByType || !state.structuresByType[STRUCTURE_LAB]) return false;
    return state.structuresByType[STRUCTURE_LAB].length >= 3;
}

function isRoomProcessing(roomName) {
    var queue = ensureRoomQueue(roomName);
    for (var i = 0; i < queue.length; i++) {
        if (queue[i].state === STATE_PROCESSING) {
            return true;
        }
    }
    // Also check if labForward is processing in this room
    if (Memory.marketLabForward && Memory.marketLabForward.rooms && Memory.marketLabForward.rooms[roomName]) {
        var forwardQueue = Memory.marketLabForward.rooms[roomName];
        for (var j = 0; j < forwardQueue.length; j++) {
            if (forwardQueue[j].state === STATE_PROCESSING) {
                return true;
            }
        }
    }
    return false;
}

function getStatusForRoom(roomName) {
    ensureMemory();
    var queue = Memory.marketLabReverse.rooms[roomName];
    
    if (!queue || queue.length === 0) {
        return '[labReverse] No active operations in ' + roomName;
    }
    
    var lines = [];
    lines.push('[labReverse] ' + roomName + ': ' + queue.length + ' operation(s)');
    
    for (var i = 0; i < queue.length; i++) {
        var op = queue[i];
        lines.push('');
        lines.push('  [' + (i + 1) + '] ' + op.targetCompound + ' (' + op.state + ')');
        lines.push('      Reagents: ' + op.reagents.join(' + '));
        lines.push('      Batch: ' + op.batchSize + ' (' + op.outputLabCount + ' labs)');
        if (op.maxBuyPrice) {
            lines.push('      Max buy price: ' + op.maxBuyPrice.toFixed(3));
        }
        lines.push('      Age: ' + (Game.time - op.tickStarted) + ' ticks');
        
        if (op.state === STATE_BUYING) {
            var current = countInRoom(roomName, op.targetCompound);
            lines.push('      Progress: ' + current + '/' + op.batchSize);
        }
        if (op.state === STATE_WAITING) {
            lines.push('      Waiting for labs to be free...');
        }
        if (op.state === STATE_PROCESSING) {
            var compoundLeft = countInRoom(roomName, op.targetCompound);
            var r1 = countInRoom(roomName, op.reagents[0]);
            var r2 = countInRoom(roomName, op.reagents[1]);
            
            // Count compound in labs and check for processable amounts
            var totalInLabs = 0;
            var processableLabs = 0;
            var LAB_REACTION_AMOUNT = 5;
            var room = Game.rooms[roomName];
            if (room) {
                var labs = room.find(FIND_STRUCTURES, {
                    filter: function(s) { return s.structureType === STRUCTURE_LAB; }
                });
                for (var j = 0; j < labs.length; j++) {
                    if (labs[j].mineralType === op.targetCompound) {
                        var amt = labs[j].mineralAmount || 0;
                        totalInLabs += amt;
                        if (amt >= LAB_REACTION_AMOUNT) {
                            processableLabs++;
                        }
                    }
                }
            }
            
            lines.push('      Terminal: ' + compoundLeft + ', Labs: ' + totalInLabs + ' (' + processableLabs + ' processable)');
            lines.push('      ' + op.reagents[0] + ': ' + r1 + ', ' + op.reagents[1] + ': ' + r2);
            
            var labOrderActive = Memory.labOrders && Memory.labOrders[roomName] && Memory.labOrders[roomName].active;
            lines.push('      Lab order: ' + (labOrderActive ? 'active' : 'NONE'));
        }
        if (op.state === STATE_SELLING) {
            var r1Sell = countInRoom(roomName, op.reagents[0]);
            var r2Sell = countInRoom(roomName, op.reagents[1]);
            lines.push('      ' + op.reagents[0] + ': ' + r1Sell + ', ' + op.reagents[1] + ': ' + r2Sell);
        }
    }
    
    return lines.join('\n');
}

function getAllStatus() {
    ensureMemory();
    var rooms = Memory.marketLabReverse.rooms;
    var activeRooms = [];
    
    for (var roomName in rooms) {
        if (rooms[roomName] && rooms[roomName].length > 0) {
            activeRooms.push(roomName);
        }
    }
    
    if (activeRooms.length === 0) {
        return '[labReverse] No active operations.';
    }
    
    var lines = ['[labReverse] ' + activeRooms.length + ' room(s) with operations:'];
    
    for (var i = 0; i < activeRooms.length; i++) {
        lines.push('');
        lines.push(getStatusForRoom(activeRooms[i]));
    }
    
    return lines.join('\n');
}

function startOperation(roomName, compound, maxPrice) {
    ensureMemory();
    
    if (!isValidCompoundInput(compound)) {
        return '[labReverse] Invalid compound: ' + compound;
    }

    var reagents = findReagents(compound);
    if (reagents.length !== 2) {
        return '[labReverse] Could not find reagents for: ' + compound;
    }

    if (!roomName) {
        roomName = findSuitableRoom();
    }

    if (!roomName) {
        return '[labReverse] No suitable room found (need terminal + 3 labs)';
    }

    if (!roomHasLabsAndTerminal(roomName)) {
        return '[labReverse] Room ' + roomName + ' does not have terminal + 3 labs';
    }

    var queue = ensureRoomQueue(roomName);
    
    // Check if same compound is already queued (but allow if it's selling - can queue another)
    for (var i = 0; i < queue.length; i++) {
        if (queue[i].targetCompound === compound && queue[i].state !== STATE_SELLING) {
            return '[labReverse] ' + compound + ' is already queued/processing in ' + roomName;
        }
    }

    var op = createOperation(roomName, compound, reagents, maxPrice);
    queue.push(op);

    var priceInfo = op.maxBuyPrice ? ' (max price: ' + op.maxBuyPrice.toFixed(3) + ')' : '';
    return '[labReverse] Queued: ' + compound + ' -> ' + reagents.join(' + ') + ' in ' + roomName + 
           ' (batch: ' + op.batchSize + ', position: ' + queue.length + ')' + priceInfo;
}

function stopOperation(roomName, compound) {
    ensureMemory();
    
    if (!roomName) {
        // Stop all operations in all rooms
        var stopped = 0;
        for (var rn in Memory.marketLabReverse.rooms) {
            var queue = Memory.marketLabReverse.rooms[rn];
            for (var i = 0; i < queue.length; i++) {
                var op = queue[i];
                if (op.buyRequestCreated) {
                    opportunisticBuy.cancelRequest(rn, op.targetCompound);
                }
                stopped++;
            }
        }
        Memory.marketLabReverse.rooms = {};
        return '[labReverse] Stopped ' + stopped + ' operation(s) in all rooms.';
    }
    
    var queue = Memory.marketLabReverse.rooms[roomName];
    if (!queue || queue.length === 0) {
        return '[labReverse] No operations in ' + roomName;
    }
    
    if (!compound) {
        // Stop all in room
        var stopped = 0;
        for (var i = 0; i < queue.length; i++) {
            var op = queue[i];
            if (op.buyRequestCreated) {
                opportunisticBuy.cancelRequest(roomName, op.targetCompound);
            }
            stopped++;
        }
        Memory.marketLabReverse.rooms[roomName] = [];
        return '[labReverse] Stopped ' + stopped + ' operation(s) in ' + roomName;
    }
    
    // Stop specific compound
    for (var i = queue.length - 1; i >= 0; i--) {
        if (queue[i].targetCompound === compound) {
            var op = queue[i];
            if (op.buyRequestCreated) {
                opportunisticBuy.cancelRequest(roomName, op.targetCompound);
            }
            queue.splice(i, 1);
            return '[labReverse] Stopped ' + compound + ' in ' + roomName;
        }
    }
    
    return '[labReverse] ' + compound + ' not found in ' + roomName;
}

function resetMemory() {
    ensureMemory();
    
    for (var roomName in Memory.marketLabReverse.rooms) {
        var queue = Memory.marketLabReverse.rooms[roomName];
        for (var i = 0; i < queue.length; i++) {
            var op = queue[i];
            if (op.buyRequestCreated) {
                opportunisticBuy.cancelRequest(roomName, op.targetCompound);
            }
        }
    }

    Memory.marketLabReverse = { rooms: {} };
    return '[labReverse] Memory reset.';
}

global.labReverse = function(arg1, arg2, arg3) {
    ensureMemory();
    
    if (!arg1) {
        return getAllStatus();
    }
    
    if (arg1 === 'stop') {
        return stopOperation(arg2, arg3);
    }
    
    if (arg1 === 'reset') {
        return resetMemory();
    }
    
    if (arg1 === 'check') {
        if (!arg2) {
            return '[labReverse] Usage: labReverse(\'check\', \'roomName\')';
        }
        var batchInfo = calculateBatchSize(arg2);
        return '[labReverse] ' + arg2 + ': ' + batchInfo.outputLabCount + ' output labs, batch size = ' + batchInfo.batchSize;
    }
    
    var isRoomName = (Game.rooms[arg1] !== undefined) || (/^[EW]\d+[NS]\d+$/.test(arg1));
    
    if (isRoomName && !arg2) {
        return getStatusForRoom(arg1);
    }
    
    if (isRoomName && arg2) {
        // arg3 can be maxPrice (number) for starting operations
        var maxPrice = (typeof arg3 === 'number') ? arg3 : null;
        return startOperation(arg1, arg2, maxPrice);
    }
    
    // Single argument compound - no max price option here
    return startOperation(null, arg1);
};


module.exports = {
    run: function() {
        ensureMemory();
        
        var rooms = Memory.marketLabReverse.rooms;
        
        for (var roomName in rooms) {
            var queue = rooms[roomName];
            if (!queue || queue.length === 0) continue;
            
            if (!roomHasLabsAndTerminal(roomName)) {
                console.log('[labReverse] Room ' + roomName + ' lost critical structures. Clearing queue.');
                rooms[roomName] = [];
                continue;
            }
            
            // Process each operation in queue
            for (var i = queue.length - 1; i >= 0; i--) {
                var op = queue[i];
                
                // Repair missing batchSize
                if (!op.batchSize) {
                    var batchInfo = calculateBatchSize(roomName);
                    op.batchSize = batchInfo.batchSize;
                    op.outputLabCount = batchInfo.outputLabCount;
                }
                
                // BUYING STATE
                if (op.state === STATE_BUYING) {
                    var currentAmount = countInRoom(roomName, op.targetCompound);

                    if (currentAmount >= op.batchSize) {
                        console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Batch acquired (' + currentAmount + '). Moving to queue.');
                        opportunisticBuy.cancelRequest(roomName, op.targetCompound);
                        op.buyRequestCreated = false;
                        op.initialCompoundAmount = currentAmount;
                        
                        // Check if we can start processing immediately
                        if (!isRoomProcessing(roomName)) {
                            op.state = STATE_PROCESSING;
                            console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Starting processing.');
                        } else {
                            op.state = STATE_WAITING;
                            console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Labs busy, waiting.');
                        }
                        continue;
                    }

                    if (!op.buyRequestCreated) {
                        var maxPrice;
                        
                        // Use stored maxBuyPrice if available, otherwise fall back to marketPrice
                        if (op.maxBuyPrice) {
                            maxPrice = op.maxBuyPrice;
                        } else {
                            var maxPriceStr = global.marketPrice(op.targetCompound);
                            maxPrice = parseMarketPrice(maxPriceStr);
                        }

                        if (!isNaN(maxPrice) && maxPrice > 0) {
                            var amountNeeded = op.batchSize - currentAmount;
                            opportunisticBuy.setup(roomName, op.targetCompound, amountNeeded, maxPrice);
                            op.buyRequestCreated = true;
                            console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Buy request for ' + amountNeeded + ' (max ' + maxPrice.toFixed(3) + ')');
                        }
                    }
                }
                
                // WAITING STATE
                else if (op.state === STATE_WAITING) {
                    if (!isRoomProcessing(roomName)) {
                        op.state = STATE_PROCESSING;
                        op.breakdownStarted = false;
                        console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Labs free, starting processing.');
                    }
                }
                
                // PROCESSING STATE
                else if (op.state === STATE_PROCESSING) {
                    var compoundAmount = countInRoom(roomName, op.targetCompound);
                    var reagent1Amount = countInRoom(roomName, op.reagents[0]);
                    var reagent2Amount = countInRoom(roomName, op.reagents[1]);

                    var labOrderActive = Memory.labOrders && 
                                         Memory.labOrders[roomName] && 
                                         Memory.labOrders[roomName].active;
                    
                    var hasProcessableAmount = false;
                    var totalInLabs = 0;
                    var room = Game.rooms[roomName];
                    var LAB_REACTION_AMOUNT = 5;
                    
                    if (room) {
                        var labs = room.find(FIND_STRUCTURES, {
                            filter: function(s) { return s.structureType === STRUCTURE_LAB; }
                        });
                        for (var j = 0; j < labs.length; j++) {
                            if (labs[j].mineralType === op.targetCompound) {
                                var amt = labs[j].mineralAmount || 0;
                                totalInLabs += amt;
                                if (amt >= LAB_REACTION_AMOUNT) {
                                    hasProcessableAmount = true;
                                }
                            }
                        }
                    }

                    var totalCompoundAnywhere = compoundAmount + totalInLabs;

                    // If no compound exists anywhere, we're done
                    if (totalCompoundAnywhere === 0) {
                        console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': No compound remaining anywhere. Moving to sell.');
                        op.state = STATE_SELLING;
                        op.breakdownStarted = false;
                        continue;
                    }

                    // If lab order is active, let it run - don't interfere
                    if (labOrderActive) {
                        continue;
                    }

                    // Lab order is NOT active. Check why:

                    // If compound still in terminal and no lab order, start/restart ONE order
                    // for the FULL remaining amount and let labManager handle it completely
                    // Throttle restarts to once per 100 ticks to prevent rapid-fire calls
                    if (compoundAmount > 100 && !hasProcessableAmount) {
                        if (!op.lastBreakdownStartTick || (Game.time - op.lastBreakdownStartTick) > 100) {
                            console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Starting breakdown (' + compoundAmount + ' in terminal).');
                            global.breakdownLabs(roomName, op.targetCompound, compoundAmount);
                            op.breakdownStarted = true;
                            op.lastBreakdownStartTick = Game.time;
                        }
                        continue;
                    }

                    // Breakdown is complete when:
                    // 1. Lab order is no longer active
                    // 2. Terminal compound is low (< 100)
                    // 3. No lab has a processable amount (>= 5)
                    var breakdownComplete = (compoundAmount < 100) && !hasProcessableAmount;

                    if (breakdownComplete) {
                        console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Processing complete (labs: ' + totalInLabs + '). Moving to sell.');
                        op.state = STATE_SELLING;
                        op.breakdownStarted = false;
                        continue;
                    }
                }
                
                // SELLING STATE
                else if (op.state === STATE_SELLING) {
                    if (!op.sellOrdersCreated) {
                        var reagent1Amount = countInRoom(roomName, op.reagents[0]);
                        var reagent2Amount = countInRoom(roomName, op.reagents[1]);

                        var hasReagents = reagent1Amount > 0 || reagent2Amount > 0;
                        
                        var expectedReagents = op.initialCompoundAmount || op.batchSize;
                        var minToSell = Math.min(expectedReagents * 0.5, 1000);
                        var hasEnough = reagent1Amount >= minToSell || reagent2Amount >= minToSell;
                        
                        var ticksInSelling = Game.time - (op.sellingStartTick || Game.time);
                        if (!op.sellingStartTick) {
                            op.sellingStartTick = Game.time;
                        }
                        
                        var shouldProceed = hasEnough || ticksInSelling > 200 || (hasReagents && ticksInSelling > 50);

                        if (!shouldProceed) {
                            if (Game.time % 100 === 0) {
                                console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Waiting for reagents (' + 
                                    op.reagents[0] + ': ' + reagent1Amount + ', ' + 
                                    op.reagents[1] + ': ' + reagent2Amount + 
                                    ', waiting ' + ticksInSelling + ' ticks)');
                            }
                            continue;
                        }

                        console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Creating sell orders.');
                        for (var k = 0; k < op.reagents.length; k++) {
                            var resType = op.reagents[k];
                            var amountInStore = countInRoom(roomName, resType);
                            if (amountInStore > 0) {
                                global.marketSell(roomName, resType, amountInStore);
                                console.log('[labReverse] ' + roomName + ': Sell ' + amountInStore + ' ' + resType);
                            }
                        }
                        op.sellOrdersCreated = true;
                        continue;
                    }

                    var allSold = true;
                    for (var k = 0; k < op.reagents.length; k++) {
                        if (countInRoom(roomName, op.reagents[k]) > 0) {
                            allSold = false;
                            break;
                        }
                    }

                    if (allSold) {
                        console.log('[labReverse] ' + roomName + '/' + op.targetCompound + ': Complete!');
                        queue.splice(i, 1);
                    }
                }
            }
        }
    }
};