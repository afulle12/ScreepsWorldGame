/**
 * marketLabForward.js
 * 
 * Buy reagents -> Combine in labs -> Sell compound
 * 
 * SUPPORTS MULTIPLE CONCURRENT OPERATIONS PER ROOM:
 * - BUYING: Multiple can run in parallel
 * - WAITING: Queued, waiting for labs to be free
 * - PROCESSING: Only ONE at a time (using labs)
 * - SELLING: Multiple can run in parallel
 * 
 * CONSOLE COMMANDS:
 *   labForward()                      - Show status of ALL active operations
 *   labForward('E3N46')               - Show status for specific room
 *   labForward('E3N46', 'ZO')         - Start/queue operation to CREATE ZO in room E3N46
 *   labForward('ZO')                  - Start operation to create ZO (auto-selects room)
 *   labForward('stop')                - Stop ALL operations
 *   labForward('stop', 'E3N46')       - Stop all operations in specific room
 *   labForward('stop', 'E3N46', 'ZO') - Stop specific compound in room
 *   labForward('reset')               - Full reset (clears all memory)
 *   labForward('check', 'E3N46')      - Check batch size for room
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
    if (!Memory.marketLabForward) {
        Memory.marketLabForward = { rooms: {} };
    }
    if (!Memory.marketLabForward.rooms) {
        Memory.marketLabForward.rooms = {};
    }
}

function ensureRoomQueue(roomName) {
    ensureMemory();
    if (!Memory.marketLabForward.rooms[roomName]) {
        Memory.marketLabForward.rooms[roomName] = [];
    }
    return Memory.marketLabForward.rooms[roomName];
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

function createOperation(roomName, compound, reagents) {
    var batchInfo = calculateBatchSize(roomName);
    
    return {
        active: true,
        roomName: roomName,
        targetCompound: compound,
        reagents: reagents,
        state: STATE_BUYING,
        tickStarted: Game.time,
        buyRequestsCreated: false,
        reactionStarted: false,
        sellOrderCreated: false,
        initialReagentAmounts: [0, 0],
        batchSize: batchInfo.batchSize,
        outputLabCount: batchInfo.outputLabCount
    };
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

function isValidCompoundOutput(compound) {
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
    // Also check if labReverse is processing in this room
    if (Memory.marketLabReverse && Memory.marketLabReverse.rooms && Memory.marketLabReverse.rooms[roomName]) {
        var reverseQueue = Memory.marketLabReverse.rooms[roomName];
        for (var i = 0; i < reverseQueue.length; i++) {
            if (reverseQueue[i].state === STATE_PROCESSING) {
                return true;
            }
        }
    }
    return false;
}

function getStatusForRoom(roomName) {
    ensureMemory();
    var queue = Memory.marketLabForward.rooms[roomName];
    
    if (!queue || queue.length === 0) {
        return '[labForward] No active operations in ' + roomName;
    }
    
    var lines = [];
    lines.push('[labForward] ' + roomName + ': ' + queue.length + ' operation(s)');
    
    for (var i = 0; i < queue.length; i++) {
        var op = queue[i];
        lines.push('');
        lines.push('  [' + (i + 1) + '] ' + op.reagents.join(' + ') + ' -> ' + op.targetCompound + ' (' + op.state + ')');
        lines.push('      Batch: ' + op.batchSize + ' (' + op.outputLabCount + ' labs)');
        lines.push('      Age: ' + (Game.time - op.tickStarted) + ' ticks');
        
        if (op.state === STATE_BUYING) {
            var r1 = countInRoom(roomName, op.reagents[0]);
            var r2 = countInRoom(roomName, op.reagents[1]);
            lines.push('      ' + op.reagents[0] + ': ' + r1 + '/' + op.batchSize);
            lines.push('      ' + op.reagents[1] + ': ' + r2 + '/' + op.batchSize);
        }
        if (op.state === STATE_WAITING) {
            lines.push('      Waiting for labs to be free...');
        }
        if (op.state === STATE_PROCESSING) {
            var r1 = countInRoom(roomName, op.reagents[0]);
            var r2 = countInRoom(roomName, op.reagents[1]);
            var compoundAmt = countInRoom(roomName, op.targetCompound);
            
            // Count reagents in labs
            var r1InLabs = 0;
            var r2InLabs = 0;
            var compoundInLabs = 0;
            var room = Game.rooms[roomName];
            if (room) {
                var labs = room.find(FIND_STRUCTURES, {
                    filter: function(s) { return s.structureType === STRUCTURE_LAB; }
                });
                for (var j = 0; j < labs.length; j++) {
                    if (labs[j].mineralType === op.reagents[0]) {
                        r1InLabs += labs[j].mineralAmount || 0;
                    }
                    if (labs[j].mineralType === op.reagents[1]) {
                        r2InLabs += labs[j].mineralAmount || 0;
                    }
                    if (labs[j].mineralType === op.targetCompound) {
                        compoundInLabs += labs[j].mineralAmount || 0;
                    }
                }
            }
            
            lines.push('      ' + op.reagents[0] + ': ' + r1 + ' (labs: ' + r1InLabs + ')');
            lines.push('      ' + op.reagents[1] + ': ' + r2 + ' (labs: ' + r2InLabs + ')');
            lines.push('      ' + op.targetCompound + ': ' + compoundAmt + '/' + op.batchSize + ' (labs: ' + compoundInLabs + ')');
            
            var labOrderActive = Memory.labOrders && Memory.labOrders[roomName] && Memory.labOrders[roomName].active;
            lines.push('      Lab order: ' + (labOrderActive ? 'active' : 'NONE'));
        }
        if (op.state === STATE_SELLING) {
            var compoundAmt = countInRoom(roomName, op.targetCompound);
            lines.push('      ' + op.targetCompound + ': ' + compoundAmt);
        }
    }
    
    return lines.join('\n');
}

function getAllStatus() {
    ensureMemory();
    var rooms = Memory.marketLabForward.rooms;
    var activeRooms = [];
    
    for (var roomName in rooms) {
        if (rooms[roomName] && rooms[roomName].length > 0) {
            activeRooms.push(roomName);
        }
    }
    
    if (activeRooms.length === 0) {
        return '[labForward] No active operations.';
    }
    
    var lines = ['[labForward] ' + activeRooms.length + ' room(s) with operations:'];
    
    for (var i = 0; i < activeRooms.length; i++) {
        lines.push('');
        lines.push(getStatusForRoom(activeRooms[i]));
    }
    
    return lines.join('\n');
}

function startOperation(roomName, compound) {
    ensureMemory();
    
    if (!isValidCompoundOutput(compound)) {
        return '[labForward] Invalid compound (not craftable): ' + compound;
    }

    var reagents = findReagents(compound);
    if (reagents.length !== 2) {
        return '[labForward] Could not find reagents for: ' + compound;
    }

    if (!roomName) {
        roomName = findSuitableRoom();
    }

    if (!roomName) {
        return '[labForward] No suitable room found (need terminal + 3 labs)';
    }

    if (!roomHasLabsAndTerminal(roomName)) {
        return '[labForward] Room ' + roomName + ' does not have terminal + 3 labs';
    }

    var queue = ensureRoomQueue(roomName);
    
    // Check if same compound is already queued (but allow if it's selling - can queue another)
    for (var i = 0; i < queue.length; i++) {
        if (queue[i].targetCompound === compound && queue[i].state !== STATE_SELLING) {
            return '[labForward] ' + compound + ' is already queued/processing in ' + roomName;
        }
    }

    var op = createOperation(roomName, compound, reagents);
    queue.push(op);

    return '[labForward] Queued: ' + reagents.join(' + ') + ' -> ' + compound + ' in ' + roomName + 
           ' (batch: ' + op.batchSize + ', position: ' + queue.length + ')';
}

function stopOperation(roomName, compound) {
    ensureMemory();
    
    if (!roomName) {
        // Stop all operations in all rooms
        var stopped = 0;
        for (var rn in Memory.marketLabForward.rooms) {
            var queue = Memory.marketLabForward.rooms[rn];
            for (var i = 0; i < queue.length; i++) {
                var op = queue[i];
                if (op.buyRequestsCreated) {
                    opportunisticBuy.cancelRequest(rn, op.reagents[0]);
                    opportunisticBuy.cancelRequest(rn, op.reagents[1]);
                }
                stopped++;
            }
        }
        Memory.marketLabForward.rooms = {};
        return '[labForward] Stopped ' + stopped + ' operation(s) in all rooms.';
    }
    
    var queue = Memory.marketLabForward.rooms[roomName];
    if (!queue || queue.length === 0) {
        return '[labForward] No operations in ' + roomName;
    }
    
    if (!compound) {
        // Stop all in room
        var stopped = 0;
        for (var i = 0; i < queue.length; i++) {
            var op = queue[i];
            if (op.buyRequestsCreated) {
                opportunisticBuy.cancelRequest(roomName, op.reagents[0]);
                opportunisticBuy.cancelRequest(roomName, op.reagents[1]);
            }
            stopped++;
        }
        Memory.marketLabForward.rooms[roomName] = [];
        return '[labForward] Stopped ' + stopped + ' operation(s) in ' + roomName;
    }
    
    // Stop specific compound
    for (var i = queue.length - 1; i >= 0; i--) {
        if (queue[i].targetCompound === compound) {
            var op = queue[i];
            if (op.buyRequestsCreated) {
                opportunisticBuy.cancelRequest(roomName, op.reagents[0]);
                opportunisticBuy.cancelRequest(roomName, op.reagents[1]);
            }
            queue.splice(i, 1);
            return '[labForward] Stopped ' + compound + ' in ' + roomName;
        }
    }
    
    return '[labForward] ' + compound + ' not found in ' + roomName;
}

function resetMemory() {
    ensureMemory();
    
    for (var roomName in Memory.marketLabForward.rooms) {
        var queue = Memory.marketLabForward.rooms[roomName];
        for (var i = 0; i < queue.length; i++) {
            var op = queue[i];
            if (op.buyRequestsCreated) {
                opportunisticBuy.cancelRequest(roomName, op.reagents[0]);
                opportunisticBuy.cancelRequest(roomName, op.reagents[1]);
            }
        }
    }

    Memory.marketLabForward = { rooms: {} };
    return '[labForward] Memory reset.';
}

global.labForward = function(arg1, arg2, arg3) {
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
            return '[labForward] Usage: labForward(\'check\', \'roomName\')';
        }
        var batchInfo = calculateBatchSize(arg2);
        return '[labForward] ' + arg2 + ': ' + batchInfo.outputLabCount + ' output labs, batch size = ' + batchInfo.batchSize;
    }
    
    var isRoomName = (Game.rooms[arg1] !== undefined) || (/^[EW]\d+[NS]\d+$/.test(arg1));
    
    if (isRoomName && !arg2) {
        return getStatusForRoom(arg1);
    }
    
    if (isRoomName && arg2) {
        return startOperation(arg1, arg2);
    }
    
    return startOperation(null, arg1);
};


module.exports = {
    run: function() {
        ensureMemory();
        
        var rooms = Memory.marketLabForward.rooms;
        
        for (var roomName in rooms) {
            var queue = rooms[roomName];
            if (!queue || queue.length === 0) continue;
            
            if (!roomHasLabsAndTerminal(roomName)) {
                console.log('[labForward] Room ' + roomName + ' lost critical structures. Clearing queue.');
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
                
                // BUYING STATE - Buy both reagents
                if (op.state === STATE_BUYING) {
                    var r1Amount = countInRoom(roomName, op.reagents[0]);
                    var r2Amount = countInRoom(roomName, op.reagents[1]);

                    // Check if we have enough of both reagents
                    if (r1Amount >= op.batchSize && r2Amount >= op.batchSize) {
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Reagents acquired. Moving to queue.');
                        opportunisticBuy.cancelRequest(roomName, op.reagents[0]);
                        opportunisticBuy.cancelRequest(roomName, op.reagents[1]);
                        op.buyRequestsCreated = false;
                        op.initialReagentAmounts = [r1Amount, r2Amount];
                        
                        // Check if we can start processing immediately
                        if (!isRoomProcessing(roomName)) {
                            op.state = STATE_PROCESSING;
                            console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Starting processing.');
                        } else {
                            op.state = STATE_WAITING;
                            console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Labs busy, waiting.');
                        }
                        continue;
                    }

                    if (!op.buyRequestsCreated) {
                        var requestsCreated = 0;
                        
                        for (var k = 0; k < op.reagents.length; k++) {
                            var reagent = op.reagents[k];
                            var currentAmt = countInRoom(roomName, reagent);
                            
                            if (currentAmt < op.batchSize) {
                                var maxPriceStr = global.marketPrice(reagent);
                                var maxPrice = parseMarketPrice(maxPriceStr);

                                if (!isNaN(maxPrice)) {
                                    var amountNeeded = op.batchSize - currentAmt;
                                    opportunisticBuy.setup(roomName, reagent, amountNeeded, maxPrice);
                                    console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Buy request for ' + amountNeeded + ' ' + reagent);
                                    requestsCreated++;
                                }
                            }
                        }
                        
                        if (requestsCreated > 0) {
                            op.buyRequestsCreated = true;
                        }
                    }
                }
                
                // WAITING STATE
                else if (op.state === STATE_WAITING) {
                    if (!isRoomProcessing(roomName)) {
                        op.state = STATE_PROCESSING;
                        op.reactionStarted = false;
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Labs free, starting processing.');
                    }
                }
                
                // PROCESSING STATE - Run the reaction
                else if (op.state === STATE_PROCESSING) {
                    var r1Amount = countInRoom(roomName, op.reagents[0]);
                    var r2Amount = countInRoom(roomName, op.reagents[1]);
                    var compoundAmount = countInRoom(roomName, op.targetCompound);

                    var labOrderActive = Memory.labOrders && 
                                         Memory.labOrders[roomName] && 
                                         Memory.labOrders[roomName].active;
                    
                    var hasProcessableReagents = false;
                    var r1InLabs = 0;
                    var r2InLabs = 0;
                    var compoundInLabs = 0;
                    var room = Game.rooms[roomName];
                    var LAB_REACTION_AMOUNT = 5;
                    
                    if (room) {
                        var labs = room.find(FIND_STRUCTURES, {
                            filter: function(s) { return s.structureType === STRUCTURE_LAB; }
                        });
                        for (var j = 0; j < labs.length; j++) {
                            if (labs[j].mineralType === op.reagents[0]) {
                                var amt = labs[j].mineralAmount || 0;
                                r1InLabs += amt;
                                if (amt >= LAB_REACTION_AMOUNT) {
                                    hasProcessableReagents = true;
                                }
                            }
                            if (labs[j].mineralType === op.reagents[1]) {
                                var amt = labs[j].mineralAmount || 0;
                                r2InLabs += amt;
                                if (amt >= LAB_REACTION_AMOUNT) {
                                    hasProcessableReagents = true;
                                }
                            }
                            if (labs[j].mineralType === op.targetCompound) {
                                compoundInLabs += labs[j].mineralAmount || 0;
                            }
                        }
                    }

                    var totalReagentsAnywhere = r1Amount + r2Amount + r1InLabs + r2InLabs;
                    var totalCompoundAnywhere = compoundAmount + compoundInLabs;

                    // SUCCESS CHECK: If we've produced the target amount, we're done!
                    if (compoundAmount >= op.batchSize) {
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + 
                                    ': Target reached! ' + compoundAmount + '/' + op.batchSize + '. Moving to sell.');
                        // Set lab order to evacuation mode so labbot cleans up
                        if (labOrderActive && Memory.labOrders[roomName].active) {
                            Memory.labOrders[roomName].active.evacuating = true;
                            Memory.labOrders[roomName].active.remaining = 0;
                            console.log('[labForward] ' + roomName + ': Triggered lab evacuation.');
                        }
                        op.state = STATE_SELLING;
                        op.reactionStarted = false;
                        continue;
                    }

                    // If no reagents exist anywhere, we're done (ran out of materials)
                    if (totalReagentsAnywhere === 0) {
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + 
                                    ': No reagents remaining. Moving to sell. (produced ' + compoundAmount + ')');
                        // Set lab order to evacuation mode so labbot cleans up any remaining product
                        if (labOrderActive && Memory.labOrders[roomName].active) {
                            Memory.labOrders[roomName].active.evacuating = true;
                            Memory.labOrders[roomName].active.remaining = 0;
                        }
                        op.state = STATE_SELLING;
                        op.reactionStarted = false;
                        continue;
                    }

                    // Restart if needed (significant amount in terminal but no lab order)
                    if (!labOrderActive && !hasProcessableReagents && (r1Amount > 100 || r2Amount > 100)) {
                        var amountToProcess = Math.min(r1Amount, r2Amount);
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Restarting reaction (' + amountToProcess + ').');
                        global.orderLabs(roomName, op.targetCompound, amountToProcess);
                        op.reactionStarted = true;
                        continue;
                    }

                    // Reaction is complete when:
                    // 1. Lab order is no longer active
                    // 2. AND terminal reagents are low (< 100 each)
                    // 3. AND no lab has processable reagent amounts
                    var reactionComplete = !labOrderActive && (r1Amount < 100 && r2Amount < 100) && !hasProcessableReagents;

                    if (reactionComplete) {
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + 
                                    ': Processing complete. Moving to sell. (produced ' + compoundAmount + ')');
                        // Set lab order to evacuation mode so labbot cleans up any remaining product
                        if (labOrderActive && Memory.labOrders[roomName].active) {
                            Memory.labOrders[roomName].active.evacuating = true;
                            Memory.labOrders[roomName].active.remaining = 0;
                        }
                        op.state = STATE_SELLING;
                        op.reactionStarted = false;
                        continue;
                    }

                    if (!op.reactionStarted) {
                        var amountToProcess = Math.min(
                            op.initialReagentAmounts[0] || r1Amount,
                            op.initialReagentAmounts[1] || r2Amount
                        );
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Starting reaction for ' + amountToProcess);
                        global.orderLabs(roomName, op.targetCompound, amountToProcess);
                        op.reactionStarted = true;
                    }
                }
                
                // SELLING STATE - Sell the compound
                else if (op.state === STATE_SELLING) {
                    if (!op.sellOrderCreated) {
                        var compoundAmount = countInRoom(roomName, op.targetCompound);

                        // Wait for compound to arrive in terminal
                        var expectedCompound = Math.min(op.initialReagentAmounts[0] || op.batchSize, op.initialReagentAmounts[1] || op.batchSize);
                        var minToSell = Math.min(expectedCompound * 0.5, 1000);
                        
                        var ticksInSelling = Game.time - (op.sellingStartTick || Game.time);
                        if (!op.sellingStartTick) {
                            op.sellingStartTick = Game.time;
                        }
                        
                        var shouldProceed = compoundAmount >= minToSell || ticksInSelling > 200 || (compoundAmount > 0 && ticksInSelling > 50);

                        if (!shouldProceed) {
                            if (Game.time % 100 === 0) {
                                console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Waiting for compound (' + 
                                    compoundAmount + ', waiting ' + ticksInSelling + ' ticks)');
                            }
                            continue;
                        }

                        if (compoundAmount > 0) {
                            console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Creating sell order for ' + compoundAmount);
                            global.marketSell(roomName, op.targetCompound, compoundAmount);
                        }
                        op.sellOrderCreated = true;
                        continue;
                    }

                    var compoundLeft = countInRoom(roomName, op.targetCompound);

                    if (compoundLeft === 0) {
                        console.log('[labForward] ' + roomName + '/' + op.targetCompound + ': Complete!');
                        queue.splice(i, 1);
                    }
                }
            }
        }
    }
};