// terminalManager.js

// Usage Examples:
// Buy 10000 energy for room E1S1 at max 0.5 credits per unit (no spawn by default for console)
// marketBuy('E1S1', 'energy', 10000, 0.5)
// Allow spawning a terminal bot for this buy
// marketBuy('E1S1', 'energy', 10000, 0.5, 'spawn')

// Sell 5000 hydrogen from E2S2 at minimum 2.0 credits per unit (no spawn by default for console)
// marketSell('E2S2', 'hydrogen', 5000, 2.0)
// Explicitly disable spawn (same as default for console)
// marketSell('E2S2', 'hydrogen', 5000, 2.0, 'nospawn')
// Allow spawning a terminal bot for this sell
// marketSell('E2S2', 'hydrogen', 5000, 2.0, 'spawn')

// Transfer 3000 energy from E1S1 to E3S3 (unchanged behavior)
// transferStuff('E1S1', 'E3S3', 'energy', 3000)

// Check status of all operations
// terminalStatus()

// Cancel a specific operation
// cancelTerminalOperation('buy_12345_abc123def')

// Manual removal of order:
//Game.market.cancelOrder('689935328f8e150012474d27');

// Manual listing of orders:
//for (var id in Game.market.orders) {
//    var o = Game.market.orders[id];
//    if (o.type === ORDER_SELL &&
//        o.roomName === 'E3N46' &&
//        o.resourceType === RESOURCE_ZYNTHIUM_BAR) {
//        console.log('SELL', id, 'price', o.price, 'remaining', o.remainingAmount, 'active', o.active);
//    }
//}
// terminalManager.js
// terminalManager.js
// NOTE:
// - No optional chaining used, compatible with Screeps runtime.
// - Respects per-room max bot cap across alive, spawning, and pending requests.
// - A single terminal bot can now switch to ENERGY when needed to complete transfers.
// terminalManager.js
// Terminal Manager
// - Hard cap: exactly one terminal bot per room (alive + spawning + requested)
// - Terminal bot auto-switches to ENERGY when needed (single bot can finish transfers)
// - Terminal bots are reusable: they watch for new operations and pick them up automatically
// - Terminal bots respect per-operation spawn policy for console commands (marketBuy/marketSell)
// - No optional chaining; Screeps API compatible

const terminalManager = {

    // ===== INITIALIZATION =====
    init() {
        if (!Memory.terminalManager) {
            Memory.terminalManager = {
                operations: [],
                bots: [],
                settings: {
                    emailNotifications: true,
                    botBodyType: 'supplier',
                    maxBotsPerRoom: 1,
                    // Set true only if you do NOT run terminalBots from your main loop by role
                    runBotsFromManager: false
                }
            };
        } else {
            if (!Memory.terminalManager.settings) Memory.terminalManager.settings = {};
            if (typeof Memory.terminalManager.settings.emailNotifications !== 'boolean') Memory.terminalManager.settings.emailNotifications = true;
            if (!Memory.terminalManager.settings.botBodyType) Memory.terminalManager.settings.botBodyType = 'supplier';
            if (typeof Memory.terminalManager.settings.maxBotsPerRoom !== 'number') Memory.terminalManager.settings.maxBotsPerRoom = 1;
            if (typeof Memory.terminalManager.settings.runBotsFromManager !== 'boolean') Memory.terminalManager.settings.runBotsFromManager = false;
            if (!Array.isArray(Memory.terminalManager.operations)) Memory.terminalManager.operations = [];
            if (!Array.isArray(Memory.terminalManager.bots)) Memory.terminalManager.bots = [];
        }
        if (this.lastLogTick === undefined) this.lastLogTick = 0;
    },

    // ===== MAIN LOOP FUNCTION =====
    run() {
        this.init();

        if (Game.time % 10 === 0) {
            this.manageMarketOrders();
        }

        this.processOperations();
        this.manageBots();
        this.cleanupCompletedOperations();
    },

    // ===== MARKET ORDER MANAGEMENT =====
    manageMarketOrders() {
        const shouldLog = Game.time % 100 === 0;

        if (shouldLog) {
            console.log('[Market] Managing market orders...');
        }

        this.cleanupStaleMarketOperations();
        this.fulfillExistingOrders(shouldLog);
        // this.createNewOrdersIfNeeded(shouldLog);
    },

    fulfillExistingOrders(shouldLog) {
        if (shouldLog !== true) shouldLog = false;
        const actualOrders = Game.market.orders;

        var hasAny = false;
        for (var k in actualOrders) { hasAny = true; break; }
        if (!hasAny) {
            if (shouldLog) console.log('[Market] No active market orders');
            return;
        }

        for (const orderId in actualOrders) {
            const order = actualOrders[orderId];
            if (order.type === ORDER_SELL && order.remainingAmount > 0) {
                const room = Game.rooms[order.roomName];
                if (room && room.terminal) {
                    const available = room.terminal.store[order.resourceType] || 0;

                    if (shouldLog) {
                        console.log('[Market] Order ' + orderId + ': ' + order.resourceType + ' in ' + order.roomName);
                        console.log('[Market] - Remaining: ' + order.remainingAmount + ', In terminal: ' + available);
                    }

                    if (available < order.remainingAmount && shouldLog) {
                        console.log('[Market] Order ' + orderId + ' needs ' + (order.remainingAmount - available) + ' more ' + order.resourceType);
                    }
                }
            }
        }
    },

    createNewOrdersIfNeeded(shouldLog) {
        if (shouldLog !== true) shouldLog = false;
        for (const roomName in Game.rooms) {
            this.checkRoomForNewOrders(roomName, shouldLog);
        }
    },

    checkRoomForNewOrders(roomName, shouldLog) {
        if (shouldLog !== true) shouldLog = false;
        const room = Game.rooms[roomName];
        if (!room || !room.terminal) return;

        for (var i = 0; i < RESOURCES_ALL.length; i++) {
            var resourceType = RESOURCES_ALL[i];
            if (resourceType === RESOURCE_ENERGY) continue;

            const available = room.terminal.store[resourceType] || 0;
            if (available < 1000) continue;

            const hasExistingOrder = this.hasExistingOrderForResource(roomName, resourceType);

            if (hasExistingOrder) {
                if (shouldLog) {
                    console.log('[Market] Room ' + roomName + ' already has sell order for ' + resourceType);
                }
            } else {
                console.log('[Market] Creating new sell order: ' + available + ' ' + resourceType + ' in ' + roomName);
                this.createSellOrder(roomName, resourceType, available);
            }
        }
    },

    hasExistingOrderForResource(roomName, resourceType) {
        const actualOrders = Game.market.orders;

        for (const orderId in actualOrders) {
            const order = actualOrders[orderId];
            if (order.type === ORDER_SELL &&
                order.roomName === roomName &&
                order.resourceType === resourceType &&
                order.remainingAmount > 0) {
                return true;
            }
        }
        return false;
    },

    getRoomTotalAvailable(roomName, resourceType) {
        const room = Game.rooms[roomName];
        if (!room) return 0;

        let total = 0;

        const terminal = room.terminal;
        if (terminal && terminal.store[resourceType]) total += terminal.store[resourceType];

        const storage = room.storage;
        if (storage && storage.store[resourceType]) total += storage.store[resourceType];

        const factories = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY });
        if (factories.length > 0 && factories[0].store && factories[0].store[resourceType]) total += factories[0].store[resourceType];

        const containers = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER && (s.store[resourceType] || 0) > 0
        });
        for (let i = 0; i < containers.length; i++) total += containers[i].store[resourceType];

        const labs = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_LAB && (s.store[resourceType] || 0) > 0
        });
        for (let j = 0; j < labs.length; j++) total += labs[j].store[resourceType];

        return total;
    },

    cleanupStaleRequests() {
        const requests = Memory.terminalManager.bots;

        for (let i = requests.length - 1; i >= 0; i--) {
            const request = requests[i];

            // If a live bot exists in that room, drop extra requests (hard cap 1)
            const aliveInRoom = this.getAllTerminalBots().some(b => b.memory.terminalRoom === request.roomName);
            if (aliveInRoom && (request.status === 'requested' || request.status === 'spawning')) {
                requests.splice(i, 1);
                continue;
            }

            // Fast remove if no longer needed OR not enough left to fetch in-room
            if (request.status === 'requested' || request.status === 'spawning') {
                const room = Game.rooms[request.roomName];
                const term = room && room.terminal;
                const have = term && term.store && term.store[request.resourceType] ? term.store[request.resourceType] : 0;
                const need = Math.max(0, this.getResourceNeeded(request.roomName, request.resourceType) - have);
                const outside = this.getRoomAvailableOutsideTerminal(request.roomName, request.resourceType);
                if (need <= 0 || outside < need) {
                    requests.splice(i, 1);
                    continue;
                }
            }

            if (request.status === 'completed' && (Game.time - request.created) > 100) {
                requests.splice(i, 1);
                continue;
            }

            if (request.status === 'spawning' && request.botName && !Game.creeps[request.botName]) {
                console.log('[Terminal] Cleaning up failed spawn request: ' + request.id);
                requests.splice(i, 1);
                continue;
            }

            if ((Game.time - request.created) > 500) {
                console.log('[Terminal] Cleaning up stale request: ' + request.id + ' (age: ' + (Game.time - request.created) + ' ticks)');
                requests.splice(i, 1);
                continue;
            }

            if (request.status === 'spawning' && request.botName && Game.creeps[request.botName]) {
                request.status = 'completed';
            }
        }
    },

    shouldLogMarketStatus() {
        const shouldLog = (Game.time - this.lastLogTick) >= 100;
        if (shouldLog) this.lastLogTick = Game.time;
        return shouldLog;
    },

    createSellOrder(roomName, resourceType, amount) {
        const history = Game.market.getHistory(resourceType);
        if (!history || history.length === 0) return;

        const avgPrice = history[history.length - 1].avgPrice;
        const sellPrice = Math.max(0.001, avgPrice * 0.9);

        const maxOrderSize = 10000;
        const orderAmount = Math.min(amount, maxOrderSize);

        const result = Game.market.createOrder({
            type: ORDER_SELL,
            resourceType: resourceType,
            price: sellPrice,
            totalAmount: orderAmount,
            roomName: roomName
        });

        if (result === OK) {
            console.log('[Market] Created sell order: ' + orderAmount + ' ' + resourceType + ' at ' + sellPrice + ' credits in ' + roomName);

            const operation = {
                id: 'sell_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
                type: 'marketSell',
                roomName: roomName,
                resourceType: resourceType,
                amount: orderAmount,
                minPrice: sellPrice,
                status: 'pending',
                created: Game.time,
                orderId: null,
                amountSold: 0,
                targetAmount: orderAmount,
                allowSpawn: true // manager-created ops remain automatic
            };

            Memory.terminalManager.operations.push(operation);

            const room = Game.rooms[roomName];
            const term = room && room.terminal;
            const inTerm = term && term.store[resourceType] ? term.store[resourceType] : 0;
            if (inTerm < orderAmount) {
                this.requestBot(roomName, 'collect', resourceType, operation.id);
            }
        } else {
            console.log('[Market] Failed to create sell order: ' + result);
        }
    },

    // ===== CONSOLE HELPERS =====
    checkMarketOrderStatus() {
        this.manageMarketOrders();
        return '[Market] Checked market orders this tick.';
    },

    // ===== CONSOLE COMMANDS =====

    marketBuy(roomName, resourceType, amount, maxPrice, spawnFlag) {
        if (maxPrice === undefined) maxPrice = null;

        const allowSpawn = (spawnFlag === 'spawn');

        if (!this.validateRoom(roomName)) {
            return '[Terminal] Invalid room: ' + roomName + '. Must be a room you own with a terminal.';
        }

        if (!this.validateResource(resourceType)) {
            return '[Terminal] Invalid resource type: ' + resourceType;
        }

        if (!amount || amount <= 0) {
            return '[Terminal] Invalid amount: ' + amount + '. Must be positive.';
        }

        const operation = {
            id: 'buy_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            type: 'marketBuy',
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            maxPrice: maxPrice,
            status: 'pending',
            created: Game.time,
            orderId: null,
            amountReceived: 0,
            allowSpawn: allowSpawn // console-level spawn policy (default false)
        };

        Memory.terminalManager.operations.push(operation);

        console.log('[Terminal] Market buy order created: ' + amount + ' ' + resourceType + ' for ' + roomName + ' (max price: ' + (maxPrice || 'market rate') + ', spawn: ' + (allowSpawn ? 'yes' : 'no') + ')');
        return '[Terminal] Market buy order created: ' + amount + ' ' + resourceType + ' for ' + roomName;
    },

    marketSell(roomName, resourceType, amount, minPrice, spawnFlag) {
        if (minPrice === undefined) minPrice = null;

        const allowSpawn = (spawnFlag === 'spawn');

        if (!this.validateRoom(roomName)) {
            return '[Terminal] Invalid room: ' + roomName + '. Must be a room you own with a terminal.';
        }

        if (!this.validateResource(resourceType)) {
            return '[Terminal] Invalid resource type: ' + resourceType;
        }

        if (!amount || amount <= 0) {
            return '[Terminal] Invalid amount: ' + amount + '. Must be positive.';
        }

        var existingOrder = null;
        var myOrders = Game.market.orders;
        for (var id in myOrders) {
            var order = myOrders[id];
            if (order.type === ORDER_SELL &&
                order.resourceType === resourceType &&
                order.roomName === roomName &&
                order.active) {
                existingOrder = order;
                break;
            }
        }
        if (existingOrder) {
            return '[Terminal] Already have active sell order for ' + resourceType + ' in ' + roomName;
        }

        const totalInRoom = this.getRoomTotalAvailable(roomName, resourceType);
        if (totalInRoom < amount) {
            return '[Terminal] Not enough ' + resourceType + ' in ' + roomName + '. Have: ' + totalInRoom + ', Need: ' + amount;
        }

        const operation = {
            id: 'sell_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            type: 'marketSell',
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            minPrice: minPrice,
            status: 'pending',
            created: Game.time,
            orderId: null,
            amountSold: 0,
            allowSpawn: allowSpawn // console-level spawn policy (default false)
        };

        Memory.terminalManager.operations.push(operation);

        const room = Game.rooms[roomName];
        const term = room && room.terminal;
        const inTerm = term && term.store[resourceType] ? term.store[resourceType] : 0;
        if (inTerm < amount) {
            // Respect per-op spawn policy by passing operation.id
            this.requestBot(roomName, 'collect', resourceType, operation.id);
            console.log('[Terminal] Market sell order created: ' + amount + ' ' + resourceType + ' from ' + roomName + ' (min price: ' + (minPrice || 'market rate') + ', spawn: ' + (allowSpawn ? 'yes' : 'no') + ')');
        } else {
            console.log('[Terminal] Market sell order created: ' + amount + ' ' + resourceType + ' from ' + roomName + ' (min price: ' + (minPrice || 'market rate') + ') — terminal has enough, no bot requested');
        }

        return '[Terminal] Market sell order created: ' + amount + ' ' + resourceType + ' from ' + roomName;
    },

    transferStuff(fromRoom, toRoom, resourceType, amount) {
        // Unchanged behavior per request
        if (!this.validateResource(resourceType)) {
            return '[Terminal] Invalid resource type: ' + resourceType;
        }

        if (!amount || amount <= 0) {
            return '[Terminal] Invalid amount: ' + amount + '. Must be positive.';
        }

        if (!Game.rooms[fromRoom] || !Game.rooms[fromRoom].controller || !Game.rooms[fromRoom].controller.my) {
            return '[Terminal] Invalid source room: ' + fromRoom + '. Must be a room you own.';
        }

        const sourceTerminal = Game.rooms[fromRoom].terminal;
        if (!sourceTerminal) {
            return '[Terminal] No terminal in source room: ' + fromRoom;
        }

        const have = sourceTerminal.store[resourceType] || 0;
        if (have < amount) {
            console.log('[Terminal] Scheduling transfer with short terminal stock in ' + fromRoom + ': have ' + have + '/' + amount + ' ' + resourceType + '. A bot will be requested as needed.');
        }

        const destRoom = Game.rooms[toRoom];
        let destHasTerminal = false;
        if (destRoom) destHasTerminal = !!destRoom.terminal;
        else destHasTerminal = true;

        if (!destHasTerminal) {
            return '[Terminal] No terminal visible in destination room: ' + toRoom;
        }

        const operation = {
            id: 'transfer_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            type: 'transfer',
            fromRoom: fromRoom,
            toRoom: toRoom,
            resourceType: resourceType,
            amount: amount,
            status: 'pending',
            created: Game.time,
            amountTransferred: 0
        };

        Memory.terminalManager.operations.push(operation);

        console.log('[Terminal] Transfer order created: ' + amount + ' ' + resourceType + ' from ' + fromRoom + ' to ' + toRoom);
        return '[Terminal] Transfer order created: ' + amount + ' ' + resourceType + ' from ' + fromRoom + ' to ' + toRoom;
    },

    status() {
        const operations = Memory.terminalManager.operations;

        if (operations.length === 0) {
            return '[Terminal] No active operations.';
        }

        console.log('=== TERMINAL MANAGER STATUS ===');
        console.log('Active operations: ' + operations.length);

        for (const op of operations) {
            let statusText = '';
            switch (op.type) {
                case 'marketBuy':
                    statusText = 'BUY: ' + op.amount + ' ' + op.resourceType + ' for ' + op.roomName + ' (' + (op.amountReceived || 0) + '/' + op.amount + ' received)';
                    break;
                case 'marketSell':
                    statusText = 'SELL: ' + op.amount + ' ' + op.resourceType + ' from ' + op.roomName + ' (' + (op.amountSold || 0) + '/' + op.amount + ' sold)';
                    break;
                case 'transfer':
                    statusText = 'TRANSFER: ' + op.amount + ' ' + op.resourceType + ' from ' + op.fromRoom + ' to ' + op.toRoom + ' (' + (op.amountTransferred || 0) + '/' + op.amount + ' transferred)';
                    break;
            }
            console.log('  ' + op.id + ': ' + statusText + ' [' + op.status + ']' + (op.allowSpawn === false ? ' [nospawn]' : ''));
        }

        const bots = this.getAllTerminalBots();
        console.log('Active terminal bots: ' + bots.length);
        for (const bot of bots) {
            console.log('  ' + bot.name + ': ' + (bot.memory.terminalTask || 'idle') + ' in ' + ((bot.room && bot.room.name) || bot.memory.terminalRoom));
        }

        return '[Terminal] Status displayed in console.';
    },

    cancelOperation(operationId) {
        const operations = Memory.terminalManager.operations;
        const index = operations.findIndex(op => op.id === operationId);

        if (index === -1) {
            return '[Terminal] Operation not found: ' + operationId;
        }

        const operation = operations[index];

        if (operation.orderId) {
            const result = Game.market.cancelOrder(operation.orderId);
            if (result === OK) {
                console.log('[Terminal] Cancelled market order ' + operation.orderId);
            }
        }

        operations.splice(index, 1);
        console.log('[Terminal] Cancelled operation: ' + operationId);
        return '[Terminal] Cancelled operation: ' + operationId;
    },

    // ===== OPERATION PROCESSING =====
    processOperations() {
        const operations = Memory.terminalManager.operations;

        for (const operation of operations) {
            switch (operation.type) {
                case 'marketBuy':
                    if (this.processMarketBuy) this.processMarketBuy(operation);
                    break;
                case 'marketSell':
                    this.processMarketSell(operation);
                    break;
                case 'transfer':
                    this.processTransfer(operation);
                    break;
            }
        }
    },

    processMarketBuy(operation) {
        if (operation._lastRun === Game.time) return;
        operation._lastRun = Game.time;

        var room = Game.rooms[operation.roomName];
        var terminal = room && room.terminal;
        if (!terminal) {
            operation.status = 'failed';
            operation.error = 'No terminal in room';
            return;
        }

        var remaining = operation.amount - (operation.amountReceived || 0);
        if (remaining <= 0) {
            operation.status = 'completed';
            return;
        }

        if (operation.orderId) {
            var ord = Game.market.orders[operation.orderId];
            if (!ord) {
                operation.amountReceived = operation.amount;
                operation.status = 'completed';
            } else {
                operation.amountReceived = operation.amount - ord.remainingAmount;
                if (operation.amountReceived >= operation.amount) {
                    operation.status = 'completed';
                }
            }
            return;
        }

        if (operation.status === 'creating') {
            var foundId = null;
            var myOrders = Game.market.orders;
            for (var id in myOrders) {
                var o = myOrders[id];
                if (o.type === ORDER_BUY &&
                    o.resourceType === operation.resourceType &&
                    o.roomName === operation.roomName &&
                    o.price === operation._pendingPrice &&
                    o.totalAmount === operation._pendingTotal) {
                    foundId = id;
                    break;
                }
            }
            if (foundId) {
                operation.orderId = foundId;
                operation.status = 'active';
            }
            return;
        }

        if (operation.status === 'pending' || operation.status === 'dealing') {
            var sellOrders = Game.market.getAllOrders({
                type: ORDER_SELL,
                resourceType: operation.resourceType
            });

            if (operation.maxPrice != null) {
                var filtered = [];
                for (var i = 0; i < sellOrders.length; i++) {
                    if (sellOrders[i].price <= operation.maxPrice) filtered.push(sellOrders[i]);
                }
                sellOrders = filtered;
            }

            sellOrders.sort(function(a, b) { return a.price - b.price; });

            operation.status = 'dealing';

            for (var i2 = 0; i2 < sellOrders.length; i2++) {
                var order = sellOrders[i2];

                var amountToBuy = Math.min(remaining, order.remainingAmount, 2000);
                if (amountToBuy <= 0) continue;

                var fromRoom = order.roomName || operation.roomName;
                var energyCost = Game.market.calcTransactionCost(amountToBuy, fromRoom, operation.roomName);

                var energyAvailable = terminal.store[RESOURCE_ENERGY] || 0;
                if (energyAvailable < energyCost) {
                    this.requestBot(operation.roomName, 'collect', RESOURCE_ENERGY, operation.id);
                    operation.status = 'waiting';
                    operation.error = 'Waiting for energy for market deal';
                    return;
                }

                var result = Game.market.deal(order.id, amountToBuy, operation.roomName);
                if (result === OK) {
                    operation.amountReceived = (operation.amountReceived || 0) + amountToBuy;

                    if (operation.amountReceived >= operation.amount) {
                        operation.status = 'completed';
                        this.sendNotification('Market buy completed via deals: ' + operation.amount + ' ' + operation.resourceType + ' to ' + operation.roomName);
                        return;
                    }
                    return;
                } else {
                    if (result === ERR_TIRED) return;
                    if (result === ERR_NOT_ENOUGH_RESOURCES) {
                        operation.status = 'failed';
                        operation.error = 'Insufficient credits or terminal energy to deal';
                        return;
                    }
                }
            }
        }

        var existingId = null;
        var myOrders2 = Game.market.orders;
        for (var id2 in myOrders2) {
            var o2 = myOrders2[id2];
            if (o2.type === ORDER_BUY &&
                o2.resourceType === operation.resourceType &&
                o2.roomName === operation.roomName &&
                o2.remainingAmount > 0) {
                existingId = id2;
                break;
            }
        }
        if (existingId) {
            operation.orderId = existingId;
            operation.status = 'active';
            return;
        }

        var price = operation.maxPrice;
        if (price == null) {
            var currentBuys = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: operation.resourceType });
            var currentSells = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: operation.resourceType });

            if (currentBuys.length > 0) {
                var bestBuy = 0;
                for (var j = 0; j < currentBuys.length; j++) {
                    if (currentBuys[j].price > bestBuy) bestBuy = currentBuys[j].price;
                }
                price = bestBuy + 0.001;
            } else if (currentSells.length > 0) {
                var minSell = currentSells[0].price;
                for (var k = 1; k < currentSells.length; k++) {
                    if (currentSells[k].price < minSell) minSell = currentSells[k].price;
                }
                price = Math.max(0.001, minSell - 0.001);
            } else {
                price = 1;
            }
        }

        var fee = price * remaining * 0.05;
        if (Game.market.credits < fee) {
            operation.status = 'failed';
            operation.error = 'Insufficient credits for 5% buy order fee';
            return;
        }

        var result2 = Game.market.createOrder({
            type: ORDER_BUY,
            resourceType: operation.resourceType,
            price: price,
            totalAmount: remaining,
            roomName: operation.roomName
        });

        if (result2 === OK) {
            operation.status = 'creating';
            operation._pendingPrice = price;
            operation._pendingTotal = remaining;
            operation._createdTick = Game.time;
            return;
        } else {
            operation.status = 'failed';
            operation.error = 'Failed to create buy order: ' + result2;
            return;
        }
    },

    processTransfer(operation) {
        const sourceRoom = Game.rooms[operation.fromRoom];

        if (!sourceRoom) {
            operation.status = 'failed';
            operation.error = 'Source room not accessible';
            return;
        }

        const sourceTerminal = sourceRoom.terminal;
        if (!sourceTerminal) {
            operation.status = 'failed';
            operation.error = 'No terminal in source room';
            return;
        }

        const remaining = operation.amount - (operation.amountTransferred || 0);

        if (remaining <= 0) {
            if (operation.status !== 'completed') {
                operation.status = 'completed';
                console.log('[Terminal] Transfer completed: ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom);
                this.sendNotification('Transfer completed: ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom);
            }
            return;
        }

        const transferCost = Game.market.calcTransactionCost(remaining, operation.fromRoom, operation.toRoom);

        if (operation.resourceType === RESOURCE_ENERGY) {
            const energyInTerminal = sourceTerminal.store[RESOURCE_ENERGY] || 0;
            const requiredEnergyTotal = remaining + transferCost;
            if (energyInTerminal < requiredEnergyTotal) {
                this.requestBot(operation.fromRoom, 'collect', RESOURCE_ENERGY, operation.id);
                operation.status = 'waiting';
                operation.error = 'Waiting for energy';
                return;
            }
        } else {
            const available = sourceTerminal.store[operation.resourceType] || 0;
            if (available < remaining) {
                this.requestBot(operation.fromRoom, 'collect', operation.resourceType, operation.id);
                operation.status = 'waiting';
                operation.error = 'Waiting for resources';
                return;
            }

            const energyAvailable = sourceTerminal.store[RESOURCE_ENERGY] || 0;
            if (energyAvailable < transferCost) {
                this.requestBot(operation.fromRoom, 'collect', RESOURCE_ENERGY, operation.id);
                operation.status = 'waiting';
                operation.error = 'Waiting for energy';
                return;
            }
        }

        const result = sourceTerminal.send(operation.resourceType, remaining, operation.toRoom);
        if (result === OK) {
            operation.amountTransferred = operation.amount;
            operation.status = 'completed';
            console.log('[Terminal] Transferred ' + remaining + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom + ' (cost: ' + transferCost + ' energy)');
            this.sendNotification('Transfer completed: ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom);
        } else {
            console.log('[Terminal] Transfer failed: ' + result);
            if (result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_NOT_ENOUGH_ENERGY) {
                if (operation.resourceType !== RESOURCE_ENERGY) {
                    if ((sourceTerminal.store[operation.resourceType] || 0) < remaining) {
                        this.requestBot(operation.fromRoom, 'collect', operation.resourceType, operation.id);
                    }
                    if ((sourceTerminal.store[RESOURCE_ENERGY] || 0) < transferCost) {
                        this.requestBot(operation.fromRoom, 'collect', RESOURCE_ENERGY, operation.id);
                    }
                } else {
                    this.requestBot(operation.fromRoom, 'collect', RESOURCE_ENERGY, operation.id);
                }
                operation.status = 'waiting';
                operation.error = 'Insufficient resources/energy, waiting';
            }
        }
    },

    processMarketSell(operation) {
        if (operation._lastRun === Game.time) return;
        operation._lastRun = Game.time;

        var room = Game.rooms[operation.roomName];
        var terminal = room && room.terminal;
        if (!terminal) {
            operation.status = 'failed';
            operation.error = 'No terminal in room';
            return;
        }

        var remaining = operation.amount - (operation.amountSold || 0);
        if (remaining <= 0) {
            operation.status = 'completed';
            return;
        }

        var available = terminal.store[operation.resourceType] || 0;
        if (available < remaining) {
            this.requestBot(operation.roomName, 'collect', operation.resourceType, operation.id);
            operation.status = 'waiting';
            operation.error = 'Waiting for resources';
            return;
        }

        if (operation.status === 'creating') {
            var foundId = null;
            var myOrdersCreating = Game.market.orders;
            for (var idC in myOrdersCreating) {
                var oc = myOrdersCreating[idC];
                if (oc.type === ORDER_SELL &&
                    oc.resourceType === operation.resourceType &&
                    oc.roomName === operation.roomName) {
                    if (operation._pendingPrice != null && operation._pendingTotal != null) {
                        if (oc.price === operation._pendingPrice && oc.totalAmount === operation._pendingTotal) {
                            foundId = idC;
                            break;
                        }
                    } else {
                        foundId = idC;
                        break;
                    }
                }
            }
            if (foundId) {
                operation.orderId = foundId;
                operation.status = 'active';
            }
            return;
        }

        if (operation.status === 'pending' || operation.status === 'dealing' || operation.status === 'waiting') {
            var buyOrders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: operation.resourceType });
            if (buyOrders.length > 0) {
                buyOrders.sort(function(a, b) { return b.price - a.price; });
                operation.status = 'dealing';

                for (var i = 0; i < buyOrders.length; i++) {
                    var bo = buyOrders[i];
                    if (operation.minPrice && bo.price < operation.minPrice) continue;

                    var amountToSell = Math.min(remaining, bo.remainingAmount, 1000);
                    if (amountToSell <= 0) continue;

                    var energyCost = Game.market.calcTransactionCost(amountToSell, operation.roomName, bo.roomName);
                    var energyAvailable = terminal.store[RESOURCE_ENERGY] || 0;
                    if (energyAvailable < energyCost) {
                        this.requestBot(operation.roomName, 'collect', RESOURCE_ENERGY, operation.id);
                        operation.status = 'waiting';
                        operation.error = 'Waiting for energy for market deal';
                        return;
                    }

                    var dealResult = Game.market.deal(bo.id, amountToSell, operation.roomName);
                    if (dealResult === OK) {
                        operation.amountSold = (operation.amountSold || 0) + amountToSell;
                        if (operation.amountSold >= operation.amount) {
                            operation.status = 'completed';
                            this.sendNotification('Market sell completed via deals: ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.roomName);
                            return;
                        }
                        return;
                    } else {
                        if (dealResult === ERR_TIRED) return;
                    }
                }
            }
        }

        if (!operation.orderId) {
            var myOrders = Game.market.orders;
            for (var id in myOrders) {
                var o = myOrders[id];
                if (o.type === ORDER_SELL &&
                    o.resourceType === operation.resourceType &&
                    o.roomName === operation.roomName &&
                    o.remainingAmount > 0) {
                    operation.orderId = id;
                    operation.status = 'active';
                    break;
                }
            }
            if (operation.orderId) {
                var ord = Game.market.orders[operation.orderId];
                operation.amountSold = operation.amount - ord.remainingAmount;
                return;
            }
        }

        if (!operation.orderId && operation.status !== 'active') {
            var price = operation.minPrice;
            if (price == null) {
                var currentBuys = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: operation.resourceType });
                var currentSells = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: operation.resourceType });

                if (currentBuys.length > 0) {
                    var bestBuy = 0;
                    for (var j = 0; j < currentBuys.length; j++) {
                        if (currentBuys[j].price > bestBuy) bestBuy = currentBuys[j].price;
                    }
                    price = bestBuy + 0.001;
                } else if (currentSells.length > 0) {
                    var minSell = currentSells[0].price;
                    for (var k = 1; k < currentSells.length; k++) {
                        if (currentSells[k].price < minSell) minSell = currentSells[k].price;
                    }
                    price = Math.max(0.001, minSell - 0.001);
                } else {
                    price = 1;
                }
            }

            var amountToList = remaining;
            var createResult = Game.market.createOrder({
                type: ORDER_SELL,
                resourceType: operation.resourceType,
                price: price,
                totalAmount: amountToList,
                roomName: operation.roomName
            });

            if (createResult === OK) {
                operation.status = 'creating';
                operation._pendingPrice = price;
                operation._pendingTotal = amountToList;
                operation._createdTick = Game.time;
                return;
            } else {
                console.log('[Terminal] Failed to create sell order: ' + createResult);
                if (createResult === ERR_NOT_ENOUGH_RESOURCES) {
                    operation.status = 'failed';
                    operation.error = 'Insufficient credits to create sell order';
                }
                return;
            }
        }

        if (operation.orderId) {
            var ord2 = Game.market.orders[operation.orderId];
            if (!ord2) {
                operation.status = 'completed';
                operation.amountSold = operation.amount;
                this.sendNotification('Market sell completed: ' + operation.amount + ' ' + operation.resourceType + ' sold from ' + operation.roomName);
            } else {
                operation.amountSold = operation.amount - ord2.remainingAmount;
            }
        }
    },

    // ===== BOT MANAGEMENT =====
    manageBots() {
        // Remove dead bot requests pointing to dead creeps
        const bots = Memory.terminalManager.bots;
        for (let i = bots.length - 1; i >= 0; i--) {
            if (bots[i].botName && !Game.creeps[bots[i].botName]) {
                bots.splice(i, 1);
            }
        }

        this.cleanupStaleRequests();
        this.processSpawnRequests();

        if (Memory.terminalManager.settings.runBotsFromManager) {
            const activeBots = this.getAllTerminalBots();
            for (const bot of activeBots) {
                this.runBot(bot);
            }
        }
    },

    cleanupStaleMarketOperations() {
        const actualOrders = Game.market.orders;
        const operations = Memory.terminalManager.operations;

        for (let i = operations.length - 1; i >= 0; i--) {
            const operation = operations[i];
            if (operation.type === 'marketSell' && operation.orderId) {
                if (!actualOrders[operation.orderId]) {
                    console.log('[Market] Removing stale operation for cancelled order: ' + operation.orderId);
                    operations.splice(i, 1);
                }
            }
        }
    },

    // Hard cap: exactly one bot per room, counting alive + spawning + requested
    getInFlightTerminalBotCount(roomName) {
        const alive = this.getAllTerminalBots().filter(b => b.memory.terminalRoom === roomName).length;

        let spawning = 0;
        let requested = 0;
        const requests = Memory.terminalManager.bots || [];
        for (let i = 0; i < requests.length; i++) {
            const r = requests[i];
            if (r.roomName !== roomName) continue;
            if (r.status === 'spawning') spawning++;
            if (r.status === 'requested') requested++;
        }

        return alive + spawning + requested;
    },

    // Updated to accept optional operationId; if provided and the operation has allowSpawn === false, do not spawn.
    requestBot(roomName, task, resourceType, operationId) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) return false;

        // Enforce per-operation spawn policy when an operation context is provided.
        if (operationId) {
            var ops = (Memory.terminalManager && Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
            var op = null;
            for (var iop = 0; iop < ops.length; iop++) {
                if (ops[iop].id === operationId) { op = ops[iop]; break; }
            }
            if (op && op.allowSpawn === false) {
                return false;
            }
        }
        // If no operationId, preserve legacy behavior (used by transferStuff and other legacy calls).

        // 1) Calculate net need and bail if nothing is needed
        const needed = this.getResourceNeeded(roomName, resourceType);
        const have = (room.terminal && room.terminal.store && room.terminal.store[resourceType]) ? room.terminal.store[resourceType] : 0;
        const netNeeded = Math.max(0, needed - have);
        if (netNeeded <= 0) {
            return false;
        }

        // 1b) Ensure there is enough supply in-room (outside terminal) to fully satisfy the need
        const outside = this.getRoomAvailableOutsideTerminal(roomName, resourceType);
        if (outside < netNeeded) {
            // Not enough to complete the order/transfer; do not create a bot request
            return false;
        }

        // 2) Hard cap: exactly one per room
        const maxBots = 1;
        const inFlight = this.getInFlightTerminalBotCount(roomName);
        if (inFlight >= maxBots) {
            return false;
        }

        // 3) If any alive bot exists in the room, skip (it will pick up the job)
        const existingBot = this.getAllTerminalBots().find(function(bot) { return bot.memory.terminalRoom === roomName; });
        if (existingBot) {
            return false;
        }

        // 4) If a request already exists for the room, skip
        const existingRequest = (Memory.terminalManager.bots || []).find(function(req) {
            return req.roomName === roomName && (req.status === 'requested' || req.status === 'spawning');
        });
        if (existingRequest) {
            return false;
        }

        const newRequest = {
            id: 'bot_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            task: task,
            resourceType: resourceType,
            status: 'requested',
            created: Game.time
        };
        if (operationId) newRequest.operationId = operationId;

        Memory.terminalManager.bots.push(newRequest);
        console.log('[Terminal] Requested bot for ' + task + ' ' + resourceType + ' in ' + roomName + ' (needed: ' + netNeeded + ', outside: ' + outside + (operationId ? (', op: ' + operationId) : '') + ')');
        return true;
    },

    processSpawnRequests() {
        const requests = (Memory.terminalManager.bots || []).filter(function(req) { return req.status === 'requested'; });

        for (let idx = 0; idx < requests.length; idx++) {
            const request = requests[idx];
            const room = Game.rooms[request.roomName];
            if (!room) continue;

            // If an alive bot exists now, drop this request (hard cap)
            const aliveBot = this.getAllTerminalBots().find(function(b) { return b.memory.terminalRoom === request.roomName; });
            if (aliveBot) {
                request.status = 'completed';
                continue;
            }

            // Re-check net need before committing to spawn
            const terminal = room.terminal;
            const have = terminal && terminal.store && terminal.store[request.resourceType] ? terminal.store[request.resourceType] : 0;
            const need = Math.max(0, this.getResourceNeeded(request.roomName, request.resourceType) - have);
            if (need <= 0) {
                request.status = 'completed';
                continue;
            }

            // Ensure there's enough outside the terminal to fully satisfy the need
            const outside = this.getRoomAvailableOutsideTerminal(request.roomName, request.resourceType);
            if (outside < need) {
                request.status = 'completed';
                continue;
            }

            // Hard cap check again
            const maxBots = 1;
            const inFlight = this.getInFlightTerminalBotCount(request.roomName);
            if (inFlight > maxBots) {
                continue;
            }

            // Find available spawn
            const spawn = room.find(FIND_MY_SPAWNS, { filter: function(s) { return !s.spawning; } })[0];
            if (!spawn) continue;

            const body = this.getCreepBody('supplier', spawn.room.energyAvailable);
            const cost = this.bodyCost(body);
            if (cost > spawn.room.energyAvailable) continue;

            const name = 'TerminalBot_' + request.roomName + '_' + Game.time;
            const memory = {
                role: 'terminalBot',
                terminalTask: request.task,
                terminalRoom: request.roomName,
                terminalResource: request.resourceType,
                terminalRequestId: request.id
            };

            const result = spawn.spawnCreep(body, name, { memory: memory });
            if (result === OK) {
                request.status = 'spawning';
                request.botName = name;

                // Link to a relevant operation if any
                const operations = Memory.terminalManager.operations;
                if (request.operationId) {
                    for (let i = 0; i < operations.length; i++) {
                        if (operations[i].id === request.operationId) {
                            operations[i].botId = name;
                            console.log('[Terminal] Linked bot ' + name + ' to operation ' + operations[i].id);
                            break;
                        }
                    }
                } else {
                    // Fallback matching logic
                    for (let i2 = 0; i2 < operations.length; i2++) {
                        const op = operations[i2];
                        const matchesRoom = (op.roomName === request.roomName || op.fromRoom === request.roomName);
                        const matchesRes = (op.resourceType === request.resourceType);
                        const statusOk = (op.status === 'waiting' || op.status === 'pending' || op.status === 'dealing');
                        if (matchesRoom && matchesRes && statusOk && !op.botId) {
                            op.botId = name;
                            console.log('[Terminal] Linked bot ' + name + ' to operation ' + op.id);
                            break;
                        }
                    }
                }

                console.log('[Terminal] Spawning terminal bot: ' + name + ' for ' + request.task + ' ' + request.resourceType);
            }
        }
    },

    // SAFE BOT RUNNER WRAPPER (use this if your main loop calls runTerminalBot)
    runTerminalBot(creep) {
        const roomName = creep.memory.terminalRoom || (creep.room && creep.room.name);
        if (!roomName) {
            creep.say('no room');
            return;
        }
        if (!creep.memory.terminalRoom) {
            creep.memory.terminalRoom = roomName;
        }

        const room = Game.rooms[roomName];
        if (!room) {
            creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 20 });
            creep.say('home');
            return;
        }

        const terminal = room.terminal;
        if (!terminal) {
            creep.say('no term');
            return;
        }

        if (creep.memory.role !== 'terminalBot') {
            creep.memory.role = 'terminalBot';
        }

        const task = creep.memory.terminalTask || 'collect';
        const resourceType = creep.memory.terminalResource || RESOURCE_ENERGY;

        switch (task) {
            case 'collect':
            default:
                this.runCollectBot(creep, room.name, resourceType);
                break;
        }
    },

    runBot(creep) {
        this.runTerminalBot(creep);
    },

    // Returns next needed resource for the room based on active operations (non-energy prioritized)
    findNextNeededResourceForRoom(roomName) {
        const room = Game.rooms[roomName];
        const terminal = room && room.terminal;
        if (!terminal) return null;

        let bestResource = null;
        let bestDeficit = 0;
        let energyNeeded = 0;

        const ops = (Memory.terminalManager && Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];

        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op.status === 'completed' || op.status === 'failed') continue;

            if (op.type === 'transfer' && op.fromRoom === roomName) {
                const remaining = Math.max(0, op.amount - (op.amountTransferred || 0));
                if (remaining > 0) {
                    if (op.resourceType === RESOURCE_ENERGY) {
                        const cost = Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                        const required = remaining + cost;
                        const termE = terminal.store[RESOURCE_ENERGY] || 0;
                        const deficitE = Math.max(0, required - termE);
                        if (deficitE > 0) energyNeeded += deficitE;
                    } else {
                        const termHave = terminal.store[op.resourceType] || 0;
                        const deficit = Math.max(0, remaining - termHave);
                        if (deficit > bestDeficit) {
                            bestDeficit = deficit;
                            bestResource = op.resourceType;
                        }
                        // Energy for the transfer cost
                        const cost = Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                        const termE = terminal.store[RESOURCE_ENERGY] || 0;
                        const eDef = Math.max(0, cost - termE);
                        energyNeeded += eDef;
                    }
                }
            }

            if (op.type === 'marketSell' && op.roomName === roomName) {
                const remaining = Math.max(0, op.amount - (op.amountSold || 0));
                if (remaining > 0) {
                    const termHave = terminal.store[op.resourceType] || 0;
                    const deficit = Math.max(0, remaining - termHave);
                    if (deficit > bestDeficit) {
                        bestDeficit = deficit;
                        bestResource = op.resourceType;
                    }
                }
            }
        }

        if (bestResource) return bestResource;
        if (energyNeeded > 0) return RESOURCE_ENERGY;
        return null;
    },

    runCollectBot(creep, roomName, resourceType) {
        const room = Game.rooms[roomName];
        if (!room) {
            creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 20 });
            creep.say('home');
            return;
        }

        const terminal = room.terminal;
        if (!terminal) {
            creep.say('no term');
            return;
        }

        if (!creep.memory.waitingState) {
            creep.memory.waitingState = { isWaiting: false, lastResourceCheck: 0, waitStartTime: 0 };
        }

        // 0) If carrying anything at all, deliver to terminal first
        const used = creep.store.getUsedCapacity();
        if (used > 0) {
            if (creep.pos.isNearTo(terminal)) {
                // Transfer everything we carry
                for (const res in creep.store) {
                    const amt = creep.store[res] || 0;
                    if (amt > 0) {
                        creep.transfer(terminal, res);
                        break; // transfer one per tick (keeps CPU and intents in check)
                    }
                }
            } else {
                creep.moveTo(terminal, { reusePath: 10, visualizePathStyle: { stroke: '#00ff00' } });
            }
            return;
        }

        // 1) Determine need for current resource
        const totalNeeded = this.getResourceNeeded(roomName, resourceType);
        const inTerminal = terminal.store[resourceType] || 0;
        const actuallyNeeded = Math.max(0, totalNeeded - inTerminal);

        // 2) If current resource not needed, pick the next best needed resource (non-energy first)
        if (actuallyNeeded <= 0) {
            const nextRes = this.findNextNeededResourceForRoom(roomName);
            if (nextRes) {
                if (creep.memory.terminalResource !== nextRes) {
                    creep.memory.terminalResource = nextRes;
                    delete creep.memory.sourceId;
                    creep.say(nextRes === RESOURCE_ENERGY ? 'E' : nextRes);
                }
                // continue this tick; next loop will handle fetching
            } else {
                // Nothing to do: park out of the way
                const spot = this.getWaitingSpot(room);
                if (spot && !creep.pos.isEqualTo(spot)) {
                    creep.moveTo(spot, { reusePath: 20 });
                }
                creep.say('Idle');
                return;
            }
        }

        // Update resourceType in case we just switched
        resourceType = creep.memory.terminalResource || resourceType;

        // 3) Use cached source if available
        let source = null;
        if (creep.memory.sourceId) {
            source = Game.getObjectById(creep.memory.sourceId);
            if (!source) delete creep.memory.sourceId;
        }

        // 4) Periodically refresh/choose source (CPU-friendly)
        const shouldCheck = (Game.time - creep.memory.waitingState.lastResourceCheck >= 10) || !source;
        if (shouldCheck) {
            creep.memory.waitingState.lastResourceCheck = Game.time;

            const sources = this.findResourceSources(room, resourceType);
            if (sources.length > 0) {
                const best = sources[0];
                creep.memory.sourceId = best.structure.id;
                source = best.structure;
                creep.memory.waitingState.isWaiting = false;
            } else {
                if (!creep.memory.waitingState.isWaiting) {
                    creep.memory.waitingState.isWaiting = true;
                    creep.memory.waitingState.waitStartTime = Game.time;
                }
            }
        }

        // 5) Act on the source every tick
        if (source) {
            if (creep.pos.isNearTo(source)) {
                const totalNeededNow = this.getResourceNeeded(roomName, resourceType);
                const inTermNow = terminal.store[resourceType] || 0;
                const needNow = Math.max(0, totalNeededNow - inTermNow);

                const availableAtSource = (source.store && (source.store[resourceType] || 0)) || 0;
                const withdrawAmount = Math.min(creep.store.getFreeCapacity(), availableAtSource, needNow);

                if (withdrawAmount > 0) {
                    const res = creep.withdraw(source, resourceType, withdrawAmount);
                    if (res !== OK && res !== ERR_FULL && res !== ERR_NOT_ENOUGH_RESOURCES) {
                        delete creep.memory.sourceId;
                    }
                } else {
                    delete creep.memory.sourceId;
                }
            } else {
                creep.moveTo(source, { reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
                creep.say('get');
            }
        } else {
            // No source yet: park out of the way
            const waitingSpot = this.getWaitingSpot(room);
            if (waitingSpot && !creep.pos.isEqualTo(waitingSpot)) {
                creep.moveTo(waitingSpot, { reusePath: 20 });
            }
            creep.say('wait');
        }
    },

    findResourceSources(room, resourceType) {
        const sources = [];

        if (room.storage && (room.storage.store[resourceType] || 0) > 0) {
            sources.push({
                structure: room.storage,
                amount: room.storage.store[resourceType],
                type: 'storage',
                priority: 1
            });
        }

        // Include factory as a valid source
        const factories = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_FACTORY && (s.store && (s.store[resourceType] || 0) > 0); }
        });
        for (let f = 0; f < factories.length; f++) {
            const fac = factories[f];
            sources.push({
                structure: fac,
                amount: fac.store[resourceType],
                type: 'factory',
                priority: 2
            });
        }

        const containers = room.find(FIND_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_CONTAINER && (s.store && (s.store[resourceType] || 0) > 0); }
        });
        for (let i = 0; i < containers.length; i++) {
            const container = containers[i];
            sources.push({
                structure: container,
                amount: container.store[resourceType],
                type: 'container',
                priority: 2
            });
        }

        const labs = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_LAB && (s.store && (s.store[resourceType] || 0) > 0); }
        });
        for (let i2 = 0; i2 < labs.length; i2++) {
            const lab = labs[i2];
            sources.push({
                structure: lab,
                amount: lab.store[resourceType],
                type: 'lab',
                priority: 3
            });
        }

        sources.sort(function(a, b) {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return b.amount - a.amount;
        });

        return sources;
    },

    getWaitingSpot(room) {
        const terrain = room.getTerrain();

        const corners = [
            { x: 2, y: 2 },
            { x: 47, y: 2 },
            { x: 2, y: 47 },
            { x: 47, y: 47 }
        ];

        for (let i = 0; i < corners.length; i++) {
            const corner = corners[i];
            if (terrain.get(corner.x, corner.y) !== TERRAIN_MASK_WALL) {
                const pos = room.getPositionAt(corner.x, corner.y);
                if (pos) {
                    const creeps = pos.lookFor(LOOK_CREEPS);
                    if (creeps.length === 0) {
                        return pos;
                    }
                }
            }
        }

        return null;
    },

    cleanupCompletedOperations() {
        if (Game.time % 100 === 0) {
            const operations = Memory.terminalManager.operations;
            const myOrders = Game.market.orders;

            for (let i = operations.length - 1; i >= 0; i--) {
                const operation = operations[i];
                let shouldRemove = false;

                if (operation.type === 'marketSell') {
                    if (operation.orderId) {
                        const actualOrder = myOrders[operation.orderId];
                        if (!actualOrder) {
                            operation.status = 'completed';
                            operation.amountSold = operation.amount;
                        } else {
                            operation.amountSold = operation.amount - actualOrder.remainingAmount;
                        }
                    }

                    if ((operation.status === 'completed' || operation.status === 'failed') &&
                        (Game.time - operation.created) > 1000) {
                        shouldRemove = true;
                    }
                }

                if (operation.type === 'transfer' &&
                    (operation.status === 'completed' || operation.status === 'failed') &&
                    (Game.time - operation.created) > 1000) {
                    shouldRemove = true;
                }

                if (operation.type === 'marketBuy' &&
                    (operation.status === 'completed' || operation.status === 'failed') &&
                    (Game.time - operation.created) > 1000) {
                    shouldRemove = true;
                }

                if (shouldRemove) {
                    operations.splice(i, 1);
                }
            }
        }
    },

    // ===== UTILITY FUNCTIONS =====
    validateRoom(roomName) {
        const room = Game.rooms[roomName];
        return room && room.controller && room.controller.my && room.terminal;
    },

    validateResource(resourceType) {
        const validResources = [
            RESOURCE_ENERGY, RESOURCE_POWER,
            RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM,
            RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST,
            RESOURCE_HYDROXIDE, RESOURCE_ZYNTHIUM_KEANITE, RESOURCE_UTRIUM_LEMERGITE,
            RESOURCE_UTRIUM_HYDRIDE, RESOURCE_UTRIUM_OXIDE, RESOURCE_KEANIUM_HYDRIDE,
            RESOURCE_KEANIUM_OXIDE, RESOURCE_LEMERGIUM_HYDRIDE, RESOURCE_LEMERGIUM_OXIDE,
            RESOURCE_ZYNTHIUM_HYDRIDE, RESOURCE_ZYNTHIUM_OXIDE, RESOURCE_GHODIUM_HYDRIDE,
            RESOURCE_GHODIUM_OXIDE, RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
            RESOURCE_CATALYZED_KEANIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
            RESOURCE_CATALYZED_LEMERGIUM_ACID, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
            RESOURCE_CATALYZED_ZYNTHIUM_ACID, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
            RESOURCE_CATALYZED_GHODIUM_ACID, RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
            RESOURCE_UTRIUM_BAR, RESOURCE_LEMERGIUM_BAR, RESOURCE_ZYNTHIUM_BAR,
            RESOURCE_KEANIUM_BAR, RESOURCE_GHODIUM_MELT, RESOURCE_OXIDANT,
            RESOURCE_REDUCTANT, RESOURCE_PURIFIER, RESOURCE_BATTERY,
            RESOURCE_COMPOSITE, RESOURCE_CRYSTAL, RESOURCE_LIQUID,
            RESOURCE_WIRE, RESOURCE_SWITCH, RESOURCE_TRANSISTOR,
            RESOURCE_MICROCHIP, RESOURCE_CIRCUIT, RESOURCE_DEVICE,
            RESOURCE_CELL, RESOURCE_PHLEGM, RESOURCE_TISSUE,
            RESOURCE_MUSCLE, RESOURCE_ORGANOID, RESOURCE_ORGANISM,
            RESOURCE_ALLOY, RESOURCE_TUBE, RESOURCE_FIXTURES,
            RESOURCE_FRAME, RESOURCE_HYDRAULICS, RESOURCE_MACHINE,
            RESOURCE_CONDENSATE, RESOURCE_CONCENTRATE, RESOURCE_EXTRACT,
            RESOURCE_SPIRIT, RESOURCE_EMANATION, RESOURCE_ESSENCE,
            RESOURCE_UTRIUM_ACID, RESOURCE_UTRIUM_ALKALIDE,
            RESOURCE_KEANIUM_ACID, RESOURCE_KEANIUM_ALKALIDE,
            RESOURCE_LEMERGIUM_ACID, RESOURCE_LEMERGIUM_ALKALIDE,
            RESOURCE_ZYNTHIUM_ACID, RESOURCE_ZYNTHIUM_ALKALIDE,
            RESOURCE_GHODIUM_ACID, RESOURCE_GHODIUM_ALKALIDE
        ];
        return validResources.indexOf(resourceType) !== -1;
    },

    getAllTerminalBots() {
        return _.filter(Game.creeps, function(creep) {
            return creep.memory.role === 'terminalBot' &&
                typeof creep.memory.terminalRoom === 'string' &&
                typeof creep.memory.terminalTask === 'string';
        });
    },

    // Returns how much of resourceType is needed in roomName's terminal across active operations
    getResourceNeeded(roomName, resourceType) {
        let needed = 0;
        const ops = (Memory.terminalManager && Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];

        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op.status === 'completed' || op.status === 'failed') continue;

            if (op.type === 'marketSell' &&
                op.roomName === roomName &&
                op.resourceType === resourceType) {
                const remaining = Math.max(0, op.amount - (op.amountSold || 0));
                needed += remaining;
                continue;
            }

            if (op.type === 'transfer' &&
                op.fromRoom === roomName) {
                const remaining = Math.max(0, op.amount - (op.amountTransferred || 0));

                if (op.resourceType === resourceType) {
                    needed += remaining;
                }

                if (resourceType === RESOURCE_ENERGY && remaining > 0) {
                    needed += Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                }
            }
        }

        return needed;
    },

    isRoomBusyWithTransfer(roomName) {
        const ops = (Memory.terminalManager && Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op.type === 'transfer' &&
                op.status !== 'completed' &&
                op.status !== 'failed' &&
                (op.fromRoom === roomName || op.toRoom === roomName)) return true;
        }
        return false;
    },

    sendNotification(message) {
        if (Memory.terminalManager.settings.emailNotifications) {
            Game.notify(message);
        }
        console.log('[Terminal Notification] ' + message);
    },

    bodyCost(body) {
        const BODYPART_COST = {
            move: 50, work: 100, attack: 80, carry: 50, heal: 250,
            ranged_attack: 150, tough: 10, claim: 600
        };
        let total = 0;
        for (let i = 0; i < body.length; i++) total += BODYPART_COST[body[i]];
        return total;
    },

    getCreepBody(role, energy) {
        const bodyConfigs = {
            supplier: {
                200:  [CARRY, CARRY, MOVE, MOVE],
                300:  [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
                400:  [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
                600:  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
                //900:  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
                //1200: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
            }
        };

        const configs = bodyConfigs[role] || bodyConfigs.supplier;
        const tiers = Object.keys(configs).map(function(x){ return Number(x); }).sort(function(a, b){ return a - b; });
        let bestTier = tiers[0];

        for (let i = 0; i < tiers.length; i++) {
            const tier = tiers[i];
            if (energy >= tier) bestTier = tier;
            else break;
        }

        return configs[bestTier];
    },

    // New helper: amount available in-room outside the terminal
    getRoomAvailableOutsideTerminal(roomName, resourceType) {
        const room = Game.rooms[roomName];
        if (!room) return 0;

        let total = 0;

        const storage = room.storage;
        if (storage && storage.store && storage.store[resourceType]) {
            total += storage.store[resourceType];
        }

        const containers = room.find(FIND_STRUCTURES, {
            filter: function(s) {
                return s.structureType === STRUCTURE_CONTAINER && s.store && (s.store[resourceType] || 0) > 0;
            }
        });
        for (let i = 0; i < containers.length; i++) {
            total += containers[i].store[resourceType];
        }

        const labs = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) {
                return s.structureType === STRUCTURE_LAB && s.store && (s.store[resourceType] || 0) > 0;
            }
        });
        for (let j = 0; j < labs.length; j++) {
            total += labs[j].store[resourceType];
        }

        const factories = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) {
                return s.structureType === STRUCTURE_FACTORY && s.store && (s.store[resourceType] || 0) > 0;
            }
        });
        if (factories.length > 0) {
            total += factories[0].store[resourceType] || 0;
        }

        return total;
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====

global.marketBuy = function(roomName, resourceType, amount, maxPrice, spawnFlag) {
    return terminalManager.marketBuy(roomName, resourceType, amount, maxPrice, spawnFlag);
};

global.marketSell = function(roomName, resourceType, amount, minPrice, spawnFlag) {
    return terminalManager.marketSell(roomName, resourceType, amount, minPrice, spawnFlag);
};

global.transferStuff = function(fromRoom, toRoom, resourceType, amount) {
    return terminalManager.transferStuff(fromRoom, toRoom, resourceType, amount);
};

global.terminalStatus = function() {
    return terminalManager.status();
};

global.cancelTerminalOperation = function(operationId) {
    return terminalManager.cancelOperation(operationId);
};

global.checkMarketStatus = function() {
    return terminalManager.checkMarketOrderStatus();
};

module.exports = terminalManager;
