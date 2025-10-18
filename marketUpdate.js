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
//
// Requirements:
// - No optional chaining is used
//
// Screeps API references used:
// - Game.market.getAllOrders (to get all market orders)【1】【2】
// - Game.market.changeOrderPrice (to update existing order prices)【1】【2】

var marketUpdater = {
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

        // Process each of our sell orders
        for (var i = 0; i < mySellOrders.length; i++) {
            var myOrder = mySellOrders[i];
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

        // REMOVED: Price increase logic (per user request)
        // Now we only adjust price downward if needed

        // Check if we need to lower our price
        var targetPrice = cheapestExternalPrice - 0.1;
        targetPrice = Math.max(targetPrice, 0.001); // Ensure minimum price

        // If our price is already lower or equal to target, no need to update
        if (myOrder.price <= targetPrice) {
            return;
        }

        // Update the order price
        var result = Game.market.changeOrderPrice(myOrder.id, targetPrice);
        if (result === OK) {
            console.log(`[MarketUpdate] Updated order ${myOrder.id}: ${myOrder.resourceType} price from ${myOrder.price.toFixed(3)} to ${targetPrice.toFixed(3)}`);
        } else {
            console.log(`[MarketUpdate] Failed to update order ${myOrder.id}: error ${result}`);
        }
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
        console.log(`Next update in: ${1000 - (Game.time % 1000)} ticks`); // Changed from 127 to 1000

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

        console.log(`Our sell orders: ${mySellOrders.length}`);
        for (var i = 0; i < mySellOrders.length; i++) {
            var order = mySellOrders[i];
            console.log(`  ${order.id} | ${order.resourceType} | ${order.price.toFixed(3)} | ${order.remainingAmount}`);
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
