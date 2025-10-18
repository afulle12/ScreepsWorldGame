// marketSell.js
//
// Usage:
// - Post a sell order using dynamic pricing:
//     marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000)
// - Post a sell order at a fixed price:
//     marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000, 2.75)
//
// Behavior:
// 1) Validates room ownership, terminal existence, resource type, and amount.
// 2) Ensures the room (terminal + other structures in the room) has at least AMOUNT available,
//    otherwise fails without creating an order.
// 3) Pricing:
//    - If price is provided, uses it as-is.
//    - If price is not provided:
//      - Looks up the current lowest external SELL order (not from a room you own) with remaining >= 1000
//        and sets your price to 0.1 credits below it.
//      - If no such orders exist, sets price to 105% of the 2-day average from Game.market.getHistory.
//    - Price is clamped to a minimum of 0.001 to avoid invalid values.
// 4) After a successful order is created, it will request in-room collection of the resource into the
//    terminal by installing a focused hook into terminalManager.getResourceNeeded that adds your market
//    gather needs. This does NOT alter any other terminalManager behavior and uses no optional chaining.
// 5) Completion latch: once the terminal reaches the target at least once, the gather op is marked
//    'completed' and will never top off again, even if market sales reduce the stock later.
//
// Requirements:
// - terminalManager.js (provided by you) must be present and export the terminalManager object.
// - No optional chaining is used.
// - Exactly the console API described is exported to global.
//
// Screeps API references used:
// - Game.market.getAllOrders (slow; used only on explicit command)
// - Game.market.getHistory (to compute 2-day average)
// - Game.market.createOrder (to post the sell order)
//
// Measurement system: not applicable.
// Time format: not applicable.

var terminalManager = require('terminalManager');

var marketSeller = {

    // Install a minimal hook so terminalManager bots will collect our resource into the terminal
    // based on our market gather operations stored in Memory.marketSell.operations.
    installGetResourceNeededHook: function() {
        if (!terminalManager) return;
        if (terminalManager._marketSellHookInstalled) return;

        if (typeof terminalManager.getResourceNeeded !== 'function') return;

        terminalManager._marketSell_originalGetResourceNeeded = terminalManager.getResourceNeeded;
        terminalManager.getResourceNeeded = function(roomName, resourceType) {
            // Base from terminalManager (transfers, etc.)
            var base = terminalManager._marketSell_originalGetResourceNeeded(roomName, resourceType);

            // Add marketSell gather needs by contributing the full target.
            // terminalManager.runCollectBot subtracts terminal stock once when computing
            // actual deficit (actuallyNeeded = totalNeeded - inTerminal), so do NOT subtract here.
            var extra = 0;
            var ops = (Memory.marketSell && Array.isArray(Memory.marketSell.operations)) ? Memory.marketSell.operations : [];
            for (var i = 0; i < ops.length; i++) {
                var op = ops[i];
                if (!op) continue;
                if (op.roomName !== roomName) continue;
                if (op.resourceType !== resourceType) continue;
                if (op.status === 'completed' || op.status === 'cancelled') continue;
                if (typeof op.expires === 'number' && Game.time > op.expires) continue;

                var target = (typeof op.target === 'number') ? op.target : 0;
                if (target > 0) extra += target;
            }

            return base + extra;
        };

        terminalManager._marketSellHookInstalled = true;
    },

    ensureMemory: function() {
        if (!Memory.marketSell) {
            Memory.marketSell = { operations: [] };
        } else if (!Array.isArray(Memory.marketSell.operations)) {
            Memory.marketSell.operations = [];
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
    // - If a lowest external SELL order with remaining >= 1000 exists, price = that.price - 0.1
    // - Else price = 1.05 * avgPrice over last 2 days from Market history
    // - Clamp to 0.001 minimum
    computePrice: function(resourceType) {
        // Get all sell orders for this resource
        var orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType });

        // Build set of our rooms to filter out our own orders
        var myRooms = {};
        for (var rn in Game.rooms) {
            var r = Game.rooms[rn];
            if (r && r.controller && r.controller.my) {
                myRooms[rn] = true;
            }
        }

        // Filter for valid external orders with >= 1000 remaining
        var validOrders = [];
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (!o || o.type !== ORDER_SELL) continue;
            if (typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
            if (o.roomName && myRooms[o.roomName]) continue;
            if (typeof o.price !== 'number') continue;

            validOrders.push(o);
        }

        // Sort by price (lowest to highest)
        validOrders.sort(function(a, b) {
            return a.price - b.price;
        });

        // If we found valid orders, use the lowest price
        if (validOrders.length > 0) {
            var bestPrice = validOrders[0].price;
            var p = bestPrice - 0.1;
            return Math.max(p, 0.001);
        }

        // No valid orders with >= 1000 units - fall back to historical average
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
        var price = avg * 1.05;
        return Math.max(price, 0.001);
    },

    // Create a gather op so terminal bots move resource into the terminal up to "target".
    createGatherOp: function(roomName, resourceType, targetAmount) {
        this.ensureMemory();
        // If already an op for same room/res, update it to the higher target.
        var ops = Memory.marketSell.operations;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;
            if (op.roomName === roomName && op.resourceType === resourceType &&
                op.status !== 'cancelled' && op.status !== 'completed') {
                op.target = Math.max(op.target || 0, targetAmount);
                op.expires = Game.time + 10000;
                return op.id;
            }
        }

        var newOp = {
            id: 'marketsell_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            resourceType: resourceType,
            target: targetAmount,
            status: 'active',
            created: Game.time,
            expires: Game.time + 10000
        };
        Memory.marketSell.operations.push(newOp);
        return newOp.id;
    },

    // Cleanup + proactively request bots while deficits exist.
    // Completion latch: once we ever reach the target, mark completed and stop forever.
    run: function() {
        this.installGetResourceNeededHook();
        this.ensureMemory();

        var ops = Memory.marketSell.operations;
        for (var i = ops.length - 1; i >= 0; i--) {
            var op = ops[i];
            if (!op) { ops.splice(i, 1); continue; }

            var room = Game.rooms[op.roomName];
            var terminal = room && room.terminal ? room.terminal : null;
            var have = (terminal && terminal.store && terminal.store[op.resourceType]) ? terminal.store[op.resourceType] : 0;

            // Expire if never completed and expired by time
            if (op.status !== 'completed' && typeof op.expires === 'number' && Game.time > op.expires) {
                ops.splice(i, 1);
                continue;
            }

            // Completion latch
            if (op.status !== 'completed' && have >= (op.target || 0)) {
                op.status = 'completed';
                op.completedAt = Game.time;
            }

            // Active ops: request a bot if deficit and outside supply exists
            if (op.status !== 'completed') {
                if (room && terminal && op.target > 0) {
                    var deficit = Math.max(0, op.target - have);
                    if (deficit > 0 &&
                        terminalManager &&
                        typeof terminalManager.getRoomAvailableOutsideTerminal === 'function' &&
                        typeof terminalManager.requestBot === 'function') {

                        var outside = terminalManager.getRoomAvailableOutsideTerminal(op.roomName, op.resourceType) || 0;
                        if (outside > 0) {
                            // requestBot enforces one-bot cap and avoids duplicate requests
                            terminalManager.requestBot(op.roomName, 'collect', op.resourceType, op.id);
                        }
                    }
                }
                continue;
            }

            // Completed ops: auto-clean after a grace period to keep Memory tidy (no top-offs after sales)
            if (typeof op.completedAt === 'number' && (Game.time - op.completedAt) > 2000) {
                ops.splice(i, 1);
            }
        }
    },

    // Main API: marketSell('ROOM#', RESOURCE, AMOUNT[, price])
    marketSell: function(roomName, resourceType, amount, price) {
        this.installGetResourceNeededHook();
        this.ensureMemory();

        // Basic validations
        if (!terminalManager || typeof terminalManager.validateResource !== 'function' || !terminalManager.validateResource(resourceType)) {
            return '[MarketSell] Invalid resource type: ' + resourceType;
        }
        if (!amount || amount <= 0) {
            return '[MarketSell] Invalid amount: ' + amount;
        }

        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) {
            return '[MarketSell] Invalid room: ' + roomName + '. Must be a room you own.';
        }

        var terminal = room.terminal;
        if (!terminal) {
            return '[MarketSell] Room ' + roomName + ' has no terminal.';
        }

        // Ensure the room really has enough total stock
        var totalAvailable = this.getRoomTotalAvailable(roomName, resourceType);
        if (totalAvailable < amount) {
            return '[MarketSell] Not enough ' + resourceType + ' in room ' + roomName + ' to cover order: have ' + totalAvailable + '/' + amount;
        }

        // Determine price (if not explicitly provided)
        var finalPrice = price;
        if (typeof finalPrice !== 'number') {
            finalPrice = this.computePrice(resourceType);
        }
        if (finalPrice < 0.001) finalPrice = 0.001;

        // Create the order
        var result = Game.market.createOrder({
            type: ORDER_SELL,
            resourceType: resourceType,
            price: finalPrice,
            totalAmount: amount,
            roomName: roomName
        });

        if (result !== OK) {
            return '[MarketSell] Failed to create SELL order: ' + result + ' (room ' + roomName + ', ' + resourceType + ' x ' + amount + ' @ ' + finalPrice + ')';
        }

        // After success: schedule in-room gather to bring up to min(amount, totalAvailable) into the terminal
        var haveInTerminal = (terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;
        var targetInTerminal = Math.min(amount, totalAvailable);
        if (haveInTerminal < targetInTerminal) {
            this.createGatherOp(roomName, resourceType, targetInTerminal);
        }

        return '[MarketSell] Created SELL order from ' + roomName + ': ' + amount + ' ' + resourceType + ' @ ' + finalPrice.toFixed(3);
    },

    // Convenience helpers for console
    status: function() {
        this.ensureMemory();
        var ops = Memory.marketSell.operations;
        if (!ops || ops.length === 0) return '[MarketSell] No active gather ops.';
        console.log('=== MARKET SELL GATHER OPS ===');
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            var room = Game.rooms[op.roomName];
            var terminal = room && room.terminal ? room.terminal : null;
            var have = (terminal && terminal.store && terminal.store[op.resourceType]) ? terminal.store[op.resourceType] : 0;
            console.log(
                '  ' + op.id +
                ' | room: ' + op.roomName +
                ' | res: ' + op.resourceType +
                ' | target: ' + op.target +
                ' | term: ' + have +
                ' | status: ' + (op.status || 'active') +
                ' | created: ' + (op.created || '-') +
                ' | expires: ' + (op.expires || '-')
            );
        }
        return '[MarketSell] Status printed.';
    },

    cancelGather: function(id) {
        this.ensureMemory();
        var ops = Memory.marketSell.operations;
        for (var i = ops.length - 1; i >= 0; i--) {
            if (ops[i] && ops[i].id === id) {
                ops.splice(i, 1);
                return '[MarketSell] Cancelled gather op: ' + id;
            }
        }
        return '[MarketSell] Gather op not found: ' + id;
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====
global.marketSell = function(roomName, resourceType, amount, price) {
    return marketSeller.marketSell(roomName, resourceType, amount, price);
};
global.marketSellStatus = function() {
    return marketSeller.status();
};
global.cancelMarketSellGather = function(id) {
    return marketSeller.cancelGather(id);
};

// Optional: call this once per tick from your main loop for cleanup and bot requests.
// marketSeller.run();

module.exports = marketSeller;
