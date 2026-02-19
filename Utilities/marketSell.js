// marketSell.js
//
// Usage:
// - Post a sell order using dynamic pricing:
//      marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000)
// - Post a sell order at a fixed price:
//      marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000, 2.75)
//
// Behavior:
// 1) Validates room ownership, terminal existence, resource type, and amount.
// 2) Ensures the room (terminal + other structures in the room) has at least AMOUNT available,
//    otherwise fails without creating an order.
// 3) Pricing:
//    - If price is provided, uses it as-is.
//    - If price is not provided:
//      - Calculates the 2-day average price from Game.market.getHistory.
//      - Looks up the current lowest external SELL order (not from a room you own) with remaining >= 1000
//        and sets your price to 0.1 credits below it.
//      - This undercut price is capped at 150% of the calculated historical average to prevent
//        listing at manipulated/unrealistic prices.
//      - If no such orders exist, sets price to 105% of the 2-day average from Game.market.getHistory.
//    - Price is clamped to a minimum of 0.001 to avoid invalid values.
// 4) After a successful order is created, it will request an in-room move into the terminal by calling
//    terminalManager.storageToTerminal(roomName, resourceType, needed).
//    The computation is reservation-aware: terminal stock already committed by existing SELL orders in the
//    same room for the same resource is treated as reserved, so only unreserved terminal stock is counted.
//    This reuses terminalManager’s local move ops and terminal bot; no hooks are installed.
// 5) Sync/Cleanup:
//    - Automatically runs whenever marketSell() or status() is called.
//    - Strictly syncs with Game.market.orders.
//    - Cancels your SELL orders that have 0 remaining amount (frees order slots).
//    - Requests are deleted from memory if the corresponding market order no longer exists or has 0 remaining amount.
//
// Requirements:
// - terminalManager.js (provided by you) must be present and export the terminalManager object.
// - No optional chaining is used.
// - Exactly the console API described is exported to global.

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

    // Cancel OUR SELL orders that are fully depleted (remainingAmount === 0)
    // Frees up market order slots when at the 300 order cap.
    cancelZeroRemainingSellOrders: function() {
        if (!Game.market || !Game.market.orders) return 0;

        var canceled = 0;
        var myOrders = Game.market.orders;

        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;

            if (typeof o.remainingAmount === 'number' && o.remainingAmount === 0) {
                var result = Game.market.cancelOrder(id);
                if (result === OK) canceled++;
            }
        }

        return canceled;
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

        // Calculate historical average FIRST.
        // We need this for the 150% cap logic even if we are undercutting.
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

        // If we found valid orders, use the lowest price (Undercutting Strategy)
        if (validOrders.length > 0) {
            var bestPrice = validOrders[0].price;
            var p = bestPrice - 0.1;

            // Limit price to 150% of the historical average.
            // This prevents listing at unrealistic prices if the market is being manipulated.
            var maxPrice = avg * 1.5;
            if (p > maxPrice) {
                p = maxPrice;
            }

            return Math.max(p, 0.001);
        }

        // No valid orders with >= 1000 units - fall back to historical average (Fallback Strategy)
        var price = avg * 1.05;
        return Math.max(price, 0.001);
    },

    // How much of resourceType in the terminal is already committed by existing SELL orders
    getExistingSellReservations: function(roomName, resourceType) {
        var reserved = 0;

        var myOrders = Game.market && Game.market.orders ? Game.market.orders : null;
        if (!myOrders) return 0;

        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;
            if (o.roomName !== roomName) continue;
            if (o.resourceType !== resourceType) continue;
            if (typeof o.remainingAmount !== 'number' || o.remainingAmount <= 0) continue;

            reserved += o.remainingAmount;
        }

        // Don't reserve more than exists in the terminal
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal ? room.terminal : null;
        var haveInTerminal = (terminal && terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;

        if (reserved > haveInTerminal) reserved = haveInTerminal;
        return reserved;
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

    // Helper: find the id of our own SELL order created this tick with given parameters.
    findOrderId: function(roomName, resourceType, amount, price, createdTick) {
        if (!Game.market || !Game.market.orders) return null;
        var myOrders = Game.market.orders;
        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;
            if (o.roomName !== roomName) continue;
            if (o.resourceType !== resourceType) continue;
            if (typeof o.totalAmount !== 'number' || typeof o.price !== 'number') continue;
            if (o.totalAmount !== amount) continue;
            if (o.price !== price) continue;
            if (typeof createdTick === 'number') {
                if (typeof o.created !== 'number') continue;
                if (o.created !== createdTick) continue;
            }
            return id;
        }
        return null;
    },

    // Main API: marketSell('ROOM#', RESOURCE, AMOUNT[, price])
    marketSell: function(roomName, resourceType, amount, price) {
        this.ensureMemory();

        // Auto-cleanup before adding new request to prevent memory bloat
        this.cleanup();

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

        // If we're at the order cap, try freeing slots by canceling empty SELL orders
        if (Game.market && Game.market.orders && Object.keys(Game.market.orders).length >= 300) {
            this.cancelZeroRemainingSellOrders();
        }

        // Create the order
        var result = Game.market.createOrder({
            type: ORDER_SELL,
            resourceType: resourceType,
            price: finalPrice,
            totalAmount: amount,
            roomName: roomName
        });

        // If we failed due to ERR_FULL, try one more time after clearing empty SELL orders
        if (result === ERR_FULL) {
            this.cancelZeroRemainingSellOrders();
            result = Game.market.createOrder({
                type: ORDER_SELL,
                resourceType: resourceType,
                price: finalPrice,
                totalAmount: amount,
                roomName: roomName
            });
        }

        if (result !== OK) {
            return '[MarketSell] Failed to create SELL order: ' + result + ' (room ' + roomName + ', ' + resourceType + ' x ' + amount + ' @ ' + finalPrice + ')';
        }

        // After success: schedule a one-time local move into the terminal (reservation-aware)
        var haveInTerminal = (terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;

        var outsideAvailable = 0;
        if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === 'function') {
            outsideAvailable = terminalManager.getRoomAvailableOutsideTerminal(roomName, resourceType) || 0;
        }

        // Terminal stock already committed by prior SELL orders in this room for this resource
        var reservedInTerminal = this.getExistingSellReservations(roomName, resourceType);

        // What's truly free in the terminal right now
        var unreservedInTerminal = Math.max(0, haveInTerminal - reservedInTerminal);

        // What we can cover right now for this new order (unreserved terminal + outside)
        var coverableNow = Math.min(amount, unreservedInTerminal + outsideAvailable);

        // How much we need to move from storage into terminal to reach coverableNow
        var need = Math.max(0, coverableNow - unreservedInTerminal);

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

        // Find the created market order id
        var orderId = this.findOrderId(roomName, resourceType, amount, finalPrice, Game.time);

        // Track this marketSell request
        var entry = {
            id: 'marketsell_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            price: finalPrice,
            created: Game.time
        };
        if (tmOpId) entry.tmOpId = tmOpId;
        if (orderId) entry.orderId = orderId;

        Memory.marketSell.requests.push(entry);

        var msg = '[MarketSell] Created SELL order from ' + roomName + ': ' + amount + ' ' + resourceType + ' @ ' + finalPrice.toFixed(3);
        if (need > 0) {
            msg += ' | scheduled to move ' + need + ' into terminal' + (tmOpId ? (' (op ' + tmOpId + ')') : '');
        } else {
            msg += ' | terminal already has target amount (unreserved: ' + unreservedInTerminal + ')';
        }
        return msg;
    },

    // Convenience helpers for console
    status: function() {
        this.ensureMemory();

        // Sync with live orders first
        this.cleanup();

        var list = Memory.marketSell.requests;
        if (!list || list.length === 0) return '[MarketSell] No active marketSell orders.';

        console.log('=== MARKET SELL REQUESTS (' + list.length + ' active) ===');
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

            // Get live order details if possible
            var liveInfo = '';
            if (r.orderId && Game.market.orders[r.orderId]) {
                var o = Game.market.orders[r.orderId];
                liveInfo = ' | REMAINING: ' + o.remainingAmount + '/' + o.totalAmount;
            } else {
                liveInfo = ' | [Order not found/sold]';
            }

            console.log(
                '  ' + r.id +
                ' | room: ' + r.roomName +
                ' | res: ' + r.resourceType +
                ' | order: ' + r.amount + ' @ ' + (typeof r.price === 'number' ? r.price.toFixed(3) : r.price) +
                ' | created: ' + (r.created || '-') +
                (r.orderId ? (' | orderId: ' + r.orderId) : '') +
                liveInfo +
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
    },

    // Strict Sync Logic:
    // Only keeps requests where the corresponding Market Order exists AND has > 0 remaining.
    cleanup: function() {
        this.ensureMemory();

        // Clear empty SELL orders from the market (frees order slots)
        this.cancelZeroRemainingSellOrders();

        var list = Memory.marketSell.requests;
        var myOrders = Game.market.orders;
        var keep = [];
        var removed = 0;

        for (var i = 0; i < list.length; i++) {
            var req = list[i];

            // 1. Always keep requests created THIS tick to prevent race conditions during creation
            if (req.created === Game.time) {
                keep.push(req);
                continue;
            }

            // 2. Ensure we have an orderId
            if (!req.orderId) {
                // Try to find it one last time
                var foundId = this.findOrderId(req.roomName, req.resourceType, req.amount, req.price, req.created);
                if (foundId) {
                    req.orderId = foundId;
                } else {
                    // If not found and it's older than 10 ticks, it likely failed or sold instantly/vanished.
                    if ((Game.time - (req.created || 0)) > 10) {
                        removed++;
                        continue;
                    }
                    // Grace period for very recent requests that might be lagging
                    keep.push(req);
                    continue;
                }
            }

            // 3. Check against live Game.market.orders
            var order = myOrders[req.orderId];

            if (!order) {
                // Order is completely gone (cancelled or fully sold and wiped from market)
                removed++;
                continue;
            }

            if (order.remainingAmount <= 0) {
                // Order exists but is fully sold (remaining is 0)
                removed++;
                continue;
            }

            // Order is live and has stock remaining. Keep it.
            keep.push(req);
        }

        Memory.marketSell.requests = keep;
        return '[MarketSell] Sync: Pruned ' + removed + ' completed/invalid requests. Active: ' + keep.length;
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
global.marketSellCleanup = function() {
    return marketSeller.cleanup();
};

module.exports = marketSeller;
