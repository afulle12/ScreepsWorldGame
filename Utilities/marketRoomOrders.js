// LLM: Read docs/codex.js before reviewing or changing this file.
// marketRoomOrders.js
// Console globals: listRoomMarketOrders
// Example: listRoomMarketOrders('E1N1') - List all market orders originating from room
//   - listRoomMarketOrders()                 -> lists for all owned rooms
//   - listRoomMarketOrders('W1N1')           -> lists only for a specific owned room
//   - This module uses Game.market.orders (your orders) and filters by order.roomName.
//   - Optional chaining is NOT used in this file (Screeps does not support it).
//   - Output is printed to console and the function returns a structured result for programmatic use.
//   - Game.market is the global market interface【1】.
//   - Orders are tied to the room/terminal they were created from【2】.
//   - getAllOrders is slow and intended for global queries; not used here【1】.
var util = require("util");
function listRoomMarketOrders(e) {
  var r = {};
  var t = Game.market && Game.market.orders ? Game.market.orders : {};
  var o = [];
  for (var i in t) {
    if (t[i]) {
      o.push(t[i]);
    }
  }
  for (var a in Game.rooms) {
    var n = Game.rooms[a];
    if (!n || !n.controller || !n.controller.my) continue;
    if (e && a !== e) continue;
    var u = [];
    for (var m = 0; m < o.length; m++) {
      var s = o[m];
      if (!s) continue;
      if (s.roomName === a) {
        var c = typeof s.active === "undefined" ? true : !!s.active;
        var l = util.getOrderRemaining(s) > 0;
        if (c && l) {
          u.push({
            id: s.id,
            type: s.type,
            resourceType: s.resourceType,
            price: s.price,
            remainingAmount: util.getOrderRemaining(s),
            totalAmount: s.totalAmount,
            created: s.created
          });
        }
      }
    }
    u.sort(function(e, r) {
      if (e.type !== r.type) return e.type < r.type ? -1 : 1;
      if (e.resourceType !== r.resourceType) return e.resourceType < r.resourceType ? -1 : 1;
      return r.price - e.price;
    });
    console.log("Room " + a + " - Active orders: " + u.length);
    for (var p = 0; p < u.length; p++) {
      var d = u[p];
      console.log("  [" + d.type + "] " + d.resourceType + " | price: " + d.price + " | remaining: " + d.remainingAmount + " | total: " + d.totalAmount + " | id: " + d.id);
    }
    r[a] = u;
  }
  return r;
}

global.listRoomMarketOrders = listRoomMarketOrders;
module.exports = {
  listRoomMarketOrders: listRoomMarketOrders
};
