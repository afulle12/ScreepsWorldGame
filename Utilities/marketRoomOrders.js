// marketRoomOrders.js
// Purpose: Console command(s) to list your active market orders per owned room.
// Usage:
//   - In console: listRoomMarketOrders()                 -> lists for all owned rooms
//   - In console: listRoomMarketOrders('W1N1')           -> lists only for a specific owned room
// Notes:
//   - This module uses Game.market.orders (your orders) and filters by order.roomName.
//   - Optional chaining is NOT used in this file (Screeps does not support it).
//   - Output is printed to console and the function returns a structured result for programmatic use.
//
// References:
//   - Game.market is the global market interface【1】.
//   - Orders are tied to the room/terminal they were created from【2】.
//   - getAllOrders is slow and intended for global queries; not used here【1】.

function listRoomMarketOrders(targetRoomName) {
  var results = {};

  // Collect my orders from Game.market.orders (hash keyed by order id).
  var myOrdersObj = Game.market && Game.market.orders ? Game.market.orders : {};
  var myOrdersArr = [];
  for (var oid in myOrdersObj) {
    if (myOrdersObj[oid]) {
      myOrdersArr.push(myOrdersObj[oid]);
    }
  }

  // Iterate owned rooms and group active orders by room
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;
    if (targetRoomName && roomName !== targetRoomName) continue;

    var roomOrders = [];
    for (var i = 0; i < myOrdersArr.length; i++) {
      var o = myOrdersArr[i];
      if (!o) continue;

      // Filter by the room the order is tied to
      if (o.roomName === roomName) {
        // Consider orders "active" if they have remaining amount, and either no 'active' flag or it's true
        var isActiveFlag = (typeof o.active === 'undefined') ? true : !!o.active;
        var hasRemaining = (typeof o.remainingAmount === 'number') ? (o.remainingAmount > 0) : true;

        if (isActiveFlag && hasRemaining) {
          roomOrders.push({
            id: o.id,
            type: o.type,                 // ORDER_BUY or ORDER_SELL
            resourceType: o.resourceType, // e.g. RESOURCE_ENERGY
            price: o.price,
            remainingAmount: o.remainingAmount,
            totalAmount: o.totalAmount,
            created: o.created
          });
        }
      }
    }

    // Sort for readability: type, resourceType, then price desc
    roomOrders.sort(function(a, b) {
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      if (a.resourceType !== b.resourceType) return a.resourceType < b.resourceType ? -1 : 1;
      return b.price - a.price;
    });

    // Console output summary
    console.log("Room " + roomName + " - Active orders: " + roomOrders.length);
    for (var j = 0; j < roomOrders.length; j++) {
      var it = roomOrders[j];
      console.log(
        "  [" + it.type + "] " + it.resourceType +
        " | price: " + it.price +
        " | remaining: " + it.remainingAmount +
        " | total: " + it.totalAmount +
        " | id: " + it.id
      );
    }

    results[roomName] = roomOrders;
  }

  return results;
}

module.exports = {
  listRoomMarketOrders: listRoomMarketOrders
};
