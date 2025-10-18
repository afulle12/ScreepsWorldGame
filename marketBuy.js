var terminalManager = require('terminalManager');


// *   Examples:
// *     marketBuy('E12S34', RESOURCE_ENERGY, 10000)
// *     marketBuy('W5N6', RESOURCE_POWER, 500, 15.5)
var marketBuyer = {

    // Install a minimal hook so terminalManager bots will collect credits into the terminal
    // based on our market buy operations stored in Memory.marketBuy.operations.
    installGetResourceNeededHook: function() {
        if (!terminalManager) return;
        if (terminalManager._marketBuyHookInstalled) return;

        if (typeof terminalManager.getResourceNeeded !== 'function') return;

        terminalManager._marketBuy_originalGetResourceNeeded = terminalManager.getResourceNeeded;
        terminalManager.getResourceNeeded = function(roomName, resourceType) {
            // Base from terminalManager (transfers, etc.)
            var base = terminalManager._marketBuy_originalGetResourceNeeded(roomName, resourceType);

            // Add marketBuy gather needs for credits
            var extra = 0;
            var ops = (Memory.marketBuy && Array.isArray(Memory.marketBuy.operations)) ? Memory.marketBuy.operations : [];
            for (var i = 0; i < ops.length; i++) {
                var op = ops[i];
                if (!op) continue;
                if (op.roomName !== roomName) continue;
                if (op.status === 'completed' || op.status === 'cancelled') continue;
                if (typeof op.expires === 'number' && Game.time > op.expires) continue;

                // Only track credit needs for buy operations
                if (resourceType === RESOURCE_ENERGY) {
                    var room = Game.rooms[roomName];
                    var terminal = room && room.terminal ? room.terminal : null;
                    var haveCredits = 0;
                    if (room && room.terminal && room.terminal.store && room.terminal.store[RESOURCE_ENERGY]) {
                        haveCredits = room.terminal.store[RESOURCE_ENERGY];
                    }

                    var needForThisOp = Math.max(0, op.targetCredits - haveCredits);
                    if (needForThisOp > 0) extra += needForThisOp;
                }
            }

            return base + extra;
        };

        terminalManager._marketBuyHookInstalled = true;
    },

    ensureMemory: function() {
        if (!Memory.marketBuy) {
            Memory.marketBuy = { operations: [] };
        } else if (!Array.isArray(Memory.marketBuy.operations)) {
            Memory.marketBuy.operations = [];
        }
    },

    // Compute how much of resourceType exists in the room total = terminal + outside terminal.
    getRoomTotalAvailable: function(roomName, resourceType) {
        var room = Game.rooms[roomName];
        if (!room) return 0;

        var total = 0;

        var terminal = room.terminal;
        if (terminal && terminal.store && terminal.store[resourceType]) {
            total += terminal.store[resourceType];
        }

        // Use terminalManager helper for everything outside the terminal.
        if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === 'function') {
            total += terminalManager.getRoomAvailableOutsideTerminal(roomName, resourceType) || 0;
        }

        return total;
    },

    // Determine dynamic price if not provided by caller.
    // Rule:
    // - If a highest external BUY order with remaining >= 1000 exists, price = that.price + 0.1
    // - Else price = 95% * avgPrice over last 2 days from Market history
    // - Clamp to 0.001 minimum
    computeBuyPrice: function(resourceType) {
        // Get all buy orders for this resource
        var orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType });

        // Build set of our rooms to filter out our own orders
        var myRooms = {};
        for (var rn in Game.rooms) {
            var r = Game.rooms[rn];
            if (r && r.controller && r.controller.my) {
                myRooms[rn] = true;
            }
        }

        // Filter for valid external orders with ≥1000 remaining
        var validOrders = [];
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (!o || o.type !== ORDER_BUY) continue;
            if (typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
            if (o.roomName && myRooms[o.roomName]) continue;
            if (typeof o.price !== 'number') continue;

            validOrders.push(o);
        }

        // Sort by price (highest to lowest)
        validOrders.sort(function(a, b) {
            return b.price - a.price;
        });

        // If we found valid orders, use the highest price + 0.1
        if (validOrders.length > 0) {
            var bestPrice = validOrders[0].price;
            var p = bestPrice + 0.1;
            return Math.max(p, 0.001);
        }

        // No valid orders with ≥1000 units - fall back to historical average
        var hist = Game.market.getHistory(resourceType) || [];
        var count = 0;
        var sum = 0;

        if (hist.length >= 1) {
            var h1 = hist[hist.length - 1];
            if (h1 && typeof h1.avgPrice === 'number') { sum += h1.avgPrice; count++; }
        }
        if (hist.length >= 2) {
            var h2 = hist[hist.length - 2];
            if (h2 && typeof h2.avgPrice === 'number') { sum += h2.avgPrice; count++; }
        }

        var avg = (count > 0) ? (sum / count) : 1;
        var price = avg * 0.95; // 5% below average to be competitive
        return Math.max(price, 0.001);
    },

    // Create a gather op so terminal bots move credits into the terminal up to "targetCredits".
    createGatherOp: function(roomName, resourceType, amount, price) {
        this.ensureMemory();
        var targetCredits = amount * price;

        // If already an op for same room, update it to the higher credit target.
        var ops = Memory.marketBuy.operations;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;
            if (op.roomName === roomName &&
                op.status !== 'cancelled' && op.status !== 'completed') {
                op.targetCredits = Math.max(op.targetCredits || 0, targetCredits);
                op.expires = Game.time + 10000;
                return op.id;
            }
        }

        var newOp = {
            id: 'marketbuy_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            price: price,
            targetCredits: targetCredits,
            status: 'active',
            created: Game.time,
            expires: Game.time + 10000
        };
        Memory.marketBuy.operations.push(newOp);
        return newOp.id;
    },

    // Cleanup expired/completed gather ops (callable from your main loop if you wish).
    run: function() {
        this.installGetResourceNeededHook();
        this.ensureMemory();

        var ops = Memory.marketBuy.operations;
        for (var i = ops.length - 1; i >= 0; i--) {
            var op = ops[i];
            if (!op) { ops.splice(i, 1); continue; }

            var remove = false;

            // Expiry
            if (typeof op.expires === 'number' && Game.time > op.expires) {
                remove = true;
            }

            // Completed if terminal holds enough credits now
            if (!remove) {
                var room = Game.rooms[op.roomName];
                var terminal = room && room.terminal ? room.terminal : null;
                var haveCredits = 0;
                if (terminal && terminal.store && terminal.store[RESOURCE_ENERGY]) {
                    haveCredits = terminal.store[RESOURCE_ENERGY];
                }
                if (haveCredits >= (op.targetCredits || 0)) remove = true;
            }

            if (remove) ops.splice(i, 1);
        }
    },

    // Main API: marketBuy('ROOM#', RESOURCE, AMOUNT[, price])
    marketBuy: function(roomName, resourceType, amount, price) {
        this.installGetResourceNeededHook();
        this.ensureMemory();

        // Basic validations
        if (!terminalManager || typeof terminalManager.validateResource !== 'function' || !terminalManager.validateResource(resourceType)) {
            return '[MarketBuy] Invalid resource type: ' + resourceType;
        }
        if (!amount || amount <= 0) {
            return '[MarketBuy] Invalid amount: ' + amount;
        }

        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) {
            return '[MarketBuy] Invalid room: ' + roomName + '. Must be a room you own.';
        }

        var terminal = room.terminal;
        if (!terminal) {
            return '[MarketBuy] Room ' + roomName + ' has no terminal.';
        }

        // Determine price (if not explicitly provided)
        var finalPrice = price;
        if (typeof finalPrice !== 'number') {
            finalPrice = this.computeBuyPrice(resourceType); // uses getAllOrders + getHistory【2】【1】
        }
        if (finalPrice < 0.001) finalPrice = 0.001;

        // Create the order
        var result = Game.market.createOrder({
            type: ORDER_BUY,
            resourceType: resourceType,
            price: finalPrice,
            totalAmount: amount,
            roomName: roomName
        }); // uses Game.market API【3】【2】

        if (result !== OK) {
            return '[MarketBuy] Failed to create BUY order: ' + result + ' (room ' + roomName + ', ' + resourceType + ' x ' + amount + ' @ ' + finalPrice + ')';
        }

        // After success: schedule in-room gather to ensure enough credits in terminal
        var targetCredits = amount * finalPrice;
        var haveCredits = 0;
        if (terminal.store && terminal.store[RESOURCE_ENERGY]) {
            haveCredits = terminal.store[RESOURCE_ENERGY];
        }
        if (haveCredits < targetCredits) {
            this.createGatherOp(roomName, resourceType, amount, finalPrice);
        }

        return '[MarketBuy] Created BUY order from ' + roomName + ': ' + amount + ' ' + resourceType + ' @ ' + finalPrice.toFixed(3);
    },

    // Convenience helpers for console
    status: function() {
        this.ensureMemory();
        var ops = Memory.marketBuy.operations;
        if (!ops || ops.length === 0) return '[MarketBuy] No active gather ops.';
        console.log('=== MARKET BUY GATHER OPS ===');
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            var room = Game.rooms[op.roomName];
            var terminal = room && room.terminal ? room.terminal : null;
            var haveCredits = 0;
            if (terminal && terminal.store && terminal.store[RESOURCE_ENERGY]) {
                haveCredits = terminal.store[RESOURCE_ENERGY];
            }
            console.log(
                '  ' + op.id +
                ' | room: ' + op.roomName +
                ' | res: ' + op.resourceType +
                ' | amount: ' + op.amount +
                ' | price: ' + op.price.toFixed(3) +
                ' | credits: ' + haveCredits + '/' + op.targetCredits +
                ' | status: ' + (op.status || 'active') +
                ' | expires: ' + (op.expires || '-')
            );
        }
        return '[MarketBuy] Status printed.';
    },

    cancelGather: function(id) {
        this.ensureMemory();
        var ops = Memory.marketBuy.operations;
        for (var i = ops.length - 1; i >= 0; i--) {
            if (ops[i] && ops[i].id === id) {
                ops.splice(i, 1);
                return '[MarketBuy] Cancelled gather op: ' + id;
            }
        }
        return '[MarketBuy] Gather op not found: ' + id;
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====
global.marketBuy = function(roomName, resourceType, amount, price) {
    return marketBuyer.marketBuy(roomName, resourceType, amount, price);
};
global.marketBuyStatus = function() {
    return marketBuyer.status();
};
global.cancelMarketBuyGather = function(id) {
    return marketBuyer.cancelGather(id);
};

// Optional: call this once per tick from your main loop for cleanup.
// marketBuyer.run();

module.exports = marketBuyer;
