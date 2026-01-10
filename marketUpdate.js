// marketUpdate.js
//
// Usage:
// - Call marketUpdater.run() every tick from your main loop
// - Console commands:
//     marketUpdate.run() - force run the update immediately
//     marketUpdate.status() - show status of market updates
//
// Behavior:
// 1) Every 1000 ticks:
//    a) Checks all current sell orders that belong to rooms we own
//    b) For each order:
//       - If we're not the cheapest, update our price to be 0.1 credits below
//         the cheapest external order (with remaining >= 1000)
//    c) Ensures price is clamped to minimum of 0.001
//    d) Additional clamp: do not lower below 80% of the 48h average market price
//       (as exposed by marketQuery.js via global.marketPrice)
//
// Requirements:
// - No optional chaining is used
//
// Screeps API references used:
// - Game.market.getAllOrders (to get all market orders)
// - Game.market.changeOrderPrice (to update existing order prices)
//
// Dependencies:
// - Expects global.marketPrice(resource, 'avg') from marketQuery.js to be registered.

var marketUpdater = {
    // Configuration
    minAvgMultiplier: 0.80, // floor = 80% of 48h avg
    _avgCache: null,

    // Main function to be called every tick
    run: function() {
        // Run every 1000 ticks
        if (Game.time % 1000 !== 0) {
            return;
        }

        this.updateSellOrders();
    },

    // Force run the update immediately (for console use)
    forceRun: function() {
        this.updateSellOrders();
    },

    // Update all our sell orders to ensure optimal pricing
    updateSellOrders: function() {
        // Get all orders
        var allOrders = Game.market.getAllOrders();
        if (!allOrders || !Array.isArray(allOrders)) {
            return;
        }

        // Build set of our rooms
        var myRooms = {};
        for (var roomName in Game.rooms) {
            var room = Game.rooms[roomName];
            if (room && room.controller && room.controller.my) {
                myRooms[roomName] = true;
            }
        }

        // Find our sell orders
        var mySellOrders = [];
        for (var i = 0; i < allOrders.length; i++) {
            var order = allOrders[i];
            if (!order) continue;
            if (order.type !== ORDER_SELL) continue;
            if (!order.roomName) continue;
            if (!myRooms[order.roomName]) continue;
            if (order.remainingAmount <= 0) continue;

            mySellOrders.push(order);
        }

        // Simple per-tick cache for avg prices
        this._avgCache = { tick: Game.time, data: {} };

        // Process each of our sell orders
        for (var j = 0; j < mySellOrders.length; j++) {
            var myOrder = mySellOrders[j];
            this.updateSingleSellOrder(myOrder, allOrders, myRooms);
        }
    },

    // Update a single sell order if needed
    updateSingleSellOrder: function(myOrder, allOrders, myRooms) {
        // Find the cheapest external sell order for the same resource type
        var cheapestExternalPrice = this.findCheapestExternalPrice(myOrder.resourceType, allOrders, myRooms);

        // If no external orders found, nothing to do
        if (cheapestExternalPrice === null) {
            return;
        }

        // Compute floor based on marketQuery's 48h average (80% of avg)
        var minAllowed = this.getMinAllowedPrice(myOrder.resourceType);

        // Now we only adjust price downward if needed
        var targetPrice = cheapestExternalPrice - 0.1;

        // Clamp to floors
        if (typeof minAllowed === 'number') {
            if (targetPrice < minAllowed) targetPrice = minAllowed;
        }
        if (targetPrice < 0.001) targetPrice = 0.001; // Absolute safety minimum

        // If our price is already lower or equal to target, no need to update
        if (myOrder.price <= targetPrice) {
            return;
        }

        // Update the order price
        var result = Game.market.changeOrderPrice(myOrder.id, targetPrice);
        if (result === OK) {
            var floorInfo = typeof minAllowed === 'number' ? (' (floor=' + minAllowed.toFixed(3) + ')') : '';
            console.log('[MarketUpdate] Updated order ' + myOrder.id + ': ' + myOrder.resourceType +
                        ' price from ' + myOrder.price.toFixed(3) + ' to ' + targetPrice.toFixed(3) + floorInfo);
        } else {
            console.log('[MarketUpdate] Failed to update order ' + myOrder.id + ': error ' + result);
        }
    },

    // Determine min allowed price = 80% of 48h avg (from marketQuery.js)
    getMinAllowedPrice: function(resourceType) {
        var avg = this.getAvg48hPrice(resourceType);
        if (typeof avg === 'number' && avg > 0) {
            return Math.max(0.001, avg * this.minAvgMultiplier);
        }
        return 0.001; // fallback if no avg available
    },

    // Pull and cache the 48h average price from global.marketPrice(resource, 'avg')
    getAvg48hPrice: function(resourceType) {
        // Use per-tick cache
        if (this._avgCache && this._avgCache.tick === Game.time) {
            var cached = this._avgCache.data[resourceType];
            if (typeof cached === 'number') return cached;
        }

        if (typeof global !== 'undefined' && global && typeof global.marketPrice === 'function') {
            var s = global.marketPrice(resourceType, 'avg');
            var avg = this._parseAvgFromString(s);
            if (typeof avg === 'number') {
                if (this._avgCache && this._avgCache.tick === Game.time) {
                    this._avgCache.data[resourceType] = avg;
                }
                return avg;
            }
        } else {
            // Optional: log once per tick if missing
            if (!this._warnedMissingMarketPrice || this._warnedMissingMarketPrice !== Game.time) {
                console.log('[MarketUpdate] Warning: global.marketPrice is not available; using 0.001 floor.');
                this._warnedMissingMarketPrice = Game.time;
            }
        }
        return null;
    },

    // Extract numeric avg from the formatted string returned by marketQuery.js
    _parseAvgFromString: function(s) {
        if (typeof s !== 'string') return null;

        // Typical format:
        // "[Market] <resource> 48h avg (approx): 1.234 (volume: 123, days=2)"
        var m = s.match(/approx\):\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (!m) {
            // Fallback more permissive pattern: find the first number after a colon
            m = s.match(/:\s*([0-9]+(?:\.[0-9]+)?)/);
        }
        if (m && m[1]) {
            var val = parseFloat(m[1]);
            if (!isNaN(val)) return val;
        }
        return null;
    },

    // Find the cheapest external sell order for a resource type
    findCheapestExternalPrice: function(resourceType, allOrders, myRooms) {
        var cheapestPrice = null;

        for (var i = 0; i < allOrders.length; i++) {
            var order = allOrders[i];
            if (!order) continue;

            // Skip if not a sell order for our resource type
            if (order.type !== ORDER_SELL || order.resourceType !== resourceType) {
                continue;
            }

            // Skip if it's one of our orders
            if (order.roomName && myRooms[order.roomName]) {
                continue;
            }

            // Skip if remaining amount is less than 1000
            if (typeof order.remainingAmount !== 'number' || order.remainingAmount < 1000) {
                continue;
            }

            // Skip if price is not a number
            if (typeof order.price !== 'number') {
                continue;
            }

            // Update cheapest price if this order is cheaper
            if (cheapestPrice === null || order.price < cheapestPrice) {
                cheapestPrice = order.price;
            }
        }

        return cheapestPrice;
    },

    // Show status information
    status: function() {
        console.log('=== MARKET UPDATE STATUS ===');
        console.log('Next update in: ' + (1000 - (Game.time % 1000)) + ' ticks');

        // Get all orders
        var allOrders = Game.market.getAllOrders();
        if (!allOrders || !Array.isArray(allOrders)) {
            console.log('[MarketUpdate] Failed to get market orders for status');
            return;
        }

        // Build set of our rooms
        var myRooms = {};
        for (var roomName in Game.rooms) {
            var room = Game.rooms[roomName];
            if (room && room.controller && room.controller.my) {
                myRooms[roomName] = true;
            }
        }

        // Find our sell orders
        var mySellOrders = [];
        for (var i = 0; i < allOrders.length; i++) {
            var order = allOrders[i];
            if (!order) continue;
            if (order.type !== ORDER_SELL) continue;
            if (!order.roomName) continue;
            if (!myRooms[order.roomName]) continue;
            if (order.remainingAmount <= 0) continue;

            mySellOrders.push(order);
        }

        console.log('Our sell orders: ' + mySellOrders.length);
        for (var j = 0; j < mySellOrders.length; j++) {
            var order2 = mySellOrders[j];
            console.log('  ' + order2.id + ' | ' + order2.resourceType + ' | ' + order2.price.toFixed(3) + ' | ' + order2.remainingAmount);
        }

        return '[MarketUpdate] Status displayed';
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====
global.marketUpdate = {
    run: function() { return marketUpdater.run(); },
    forceRun: function() { return marketUpdater.forceRun(); },
    status: function() { return marketUpdater.status(); }
};

module.exports = marketUpdater;
