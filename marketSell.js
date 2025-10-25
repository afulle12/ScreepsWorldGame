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
// 4) After a successful order is created, it will request an in-room move into the terminal by calling
//    terminalManager.storageToTerminal(roomName, resourceType, needed), where needed equals
//    min(order amount, total available in-room) minus what is already in the terminal.
//    This reuses terminalManager’s local move ops and terminal bot; no hooks are installed.
// 5) Completion latch: handled by terminalManager’s local operation (toTerminal). We only schedule once.
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

    // Minimal memory for tracking marketSell -> terminalManager local op linkage
    ensureMemory: function() {
        if (!Memory.marketSell) {
            Memory.marketSell = { requests: [] };
        } else if (!Array.isArray(Memory.marketSell.requests)) {
            Memory.marketSell.requests = [];
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

    // Link the just-created toTerminal op (created this tick) so we can show/cancel later.
    tryLinkLocalOp: function(roomName, resourceType, amount) {
        if (!Memory.terminalManager || !Array.isArray(Memory.terminalManager.operations)) return null;
        var ops = Memory.terminalManager.operations;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;
            if (op.type !== 'toTerminal') continue;
            if (op.roomName !== roomName) continue;
            if (op.resourceType !== resourceType) continue;
            if (op.amount !== amount) continue;
            if (op.created !== Game.time) continue;
            return op.id;
        }
        return null;
    },

    // Main API: marketSell('ROOM#', RESOURCE, AMOUNT[, price])
    marketSell: function(roomName, resourceType, amount, price) {
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

        // After success: schedule a one-time local move into the terminal
        var haveInTerminal = (terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;
        var targetInTerminal = Math.min(amount, totalAvailable);
        var need = Math.max(0, targetInTerminal - haveInTerminal);
        var tmOpId = null;

        if (need > 0) {
            // Call terminalManager's local move (toTerminal). This will be handled by its bot.
            if (typeof terminalManager.storageToTerminal === 'function') {
                terminalManager.storageToTerminal(roomName, resourceType, need);
                // Try to link the operation created this tick so we can show/cancel it later.
                tmOpId = this.tryLinkLocalOp(roomName, resourceType, need);
            } else {
                console.log('[MarketSell] Warning: terminalManager.storageToTerminal not available.');
            }
        }

        // Track this marketSell request for status/cancel convenience
        var entry = {
            id: 'marketsell_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            price: finalPrice,
            created: Game.time
        };
        if (tmOpId) entry.tmOpId = tmOpId;
        Memory.marketSell.requests.push(entry);

        var msg = '[MarketSell] Created SELL order from ' + roomName + ': ' + amount + ' ' + resourceType + ' @ ' + finalPrice.toFixed(3);
        if (need > 0) {
            msg += ' | scheduled to move ' + need + ' into terminal' + (tmOpId ? (' (op ' + tmOpId + ')') : '');
        } else {
            msg += ' | terminal already has target amount';
        }
        return msg;
    },

    // Convenience helpers for console
    status: function() {
        this.ensureMemory();
        var list = Memory.marketSell.requests;
        if (!list || list.length === 0) return '[MarketSell] No recent marketSell requests. Use terminalStatus() for details on local ops.';

        console.log('=== MARKET SELL REQUESTS ===');
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            var progress = '';
            if (r.tmOpId && Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) {
                var ops = Memory.terminalManager.operations;
                for (var j = 0; j < ops.length; j++) {
                    var op = ops[j];
                    if (op && op.id === r.tmOpId) {
                        var moved = op.amountMoved || 0;
                        if (moved < 0) moved = 0;
                        if (moved > op.amount) moved = op.amount;
                        progress = ' | toTerminal: ' + moved + '/' + op.amount + ' (' + (op.status || '-') + ')';
                        break;
                    }
                }
            }
            console.log(
                '  ' + r.id +
                ' | room: ' + r.roomName +
                ' | res: ' + r.resourceType +
                ' | order: ' + r.amount + ' @ ' + (typeof r.price === 'number' ? r.price.toFixed(3) : r.price) +
                ' | created: ' + (r.created || '-') +
                (r.tmOpId ? (' | tmOp: ' + r.tmOpId) : '') +
                progress
            );
        }
        return '[MarketSell] Status printed.';
    },

    cancelGather: function(id) {
        this.ensureMemory();
        var list = Memory.marketSell.requests;
        for (var i = list.length - 1; i >= 0; i--) {
            var r = list[i];
            if (r && r.id === id) {
                if (r.tmOpId && terminalManager && typeof terminalManager.cancelOperation === 'function') {
                    terminalManager.cancelOperation(r.tmOpId);
                }
                list.splice(i, 1);
                return '[MarketSell] Cancelled associated local move and removed request: ' + id;
            }
        }
        return '[MarketSell] Request not found: ' + id;
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

// Optional: marketSeller no longer needs a per-tick run loop.

module.exports = marketSeller;
