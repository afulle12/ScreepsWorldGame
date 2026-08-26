// LLM: Read docs/codex.js before reviewing or changing this file.
// marketUpdate.js
// Console globals: marketUpdate, marketUpdateStatus
// Example: marketUpdate() - Trigger market pricing and order cache refresh
// Example: marketUpdateStatus() - Display market update scheduler status and timing
//   marketUpdate.run()         - every tick from the main loop (self-throttles)
//   marketUpdateStatus()       - console status
//   marketUpdate.forceRun()    - immediate pass
// Requires: marketBuy.js, marketPricing.js, autoTraderSellPolicy.js
var marketBuyer = require("marketBuy");
var pricing = require("marketPricing");
var util = require("util");
var autoTraderSellPolicy = require("autoTraderSellPolicy");
var labCommodityPolicy = require("labCommodityPolicy");
var memoryManager = require("memoryManager");
var storage = memoryManager.storage;
var labCommodityRouter = require("labCommodityRouter");
storage.register("marketUpdate.schedule", {
  path: "Memory.marketUpdate",
  owner: "marketUpdate.js",
  mutability: "mutable"
});
var UPDATE_INTERVAL = 100;
var ENABLE_SELL_UPDATES = true;
function isLiquidationOrder(e) {
  var r = Memory.marketSell && Memory.marketSell.requests || [];
  for (var t = 0; t < r.length; t++) {
    if (r[t] && r[t].orderId === e && r[t].liquidate) return true;
  }
  return false;
}

function runSellSide() {
  var e = 0;
  var r = [];
  var t = {};
  var i = {};
  for (var a in Game.rooms) {
    var o = Game.rooms[a];
    if (o && o.controller && o.controller.my) i[a] = true;
  }
  var n = Game.market.orders;
  for (var u in n) {
    var c = n[u];
    if (!c || c.type !== ORDER_SELL) continue;
    if (labCommodityPolicy.isTwoLetterLabProduct(c.resourceType)) continue;
    try {
      if (require("marketPriceAdjustment").isProtectedOrder(u)) continue;
    } catch (e) {}
    if (!c.roomName || !i[c.roomName]) continue;
    if (util.getOrderRemaining(c) <= 0) continue;
    var l = pricing.getPriceProfile(c.resourceType);
    var m = l && l.postedSellPrice;
    var s = autoTraderSellPolicy && typeof autoTraderSellPolicy.getFloor === "function" ? autoTraderSellPolicy.getFloor(c.resourceType) : 0;
    if (!(m > 0) && s > 0) m = s;
    if (!(m > 0)) continue;
    if (s > 0 && m < s) continue;
    if (!isLiquidationOrder(u) && pricing && typeof pricing.applyBestBidGap === "function") {
      m = pricing.applyBestBidGap(c.resourceType, m);
    }
    var d = c.price;
    if (m >= d) continue;
    m = Math.max(.001, Math.round(m * 1e3) / 1e3);
    if (d <= m) continue;
    var p = Game.market.changeOrderPrice(u, m);
    if (p === OK) {
      memoryManager.requestSave();
      e++;
      if (!t[c.resourceType]) {
        t[c.resourceType] = true;
        r.push(c.resourceType);
      }
    }
  }
  if (e > 0) {
    console.log("[marketUpdate] Updated " + e + " orders: " + r.join(", "));
  }
}

function ensureMemory() {
  var e = storage.ensure("marketUpdate.schedule", function() {
    return {
      lastRunTick: null
    };
  });
  if (e.lastRunTick !== null && typeof e.lastRunTick !== "number") {
    e.lastRunTick = null;
    memoryManager.requestSave();
  }
  return e;
}

var marketUpdater = {
  run: function() {
    if (labCommodityRouter && typeof labCommodityRouter.reconcileExistingRestrictedSellOrdersOnce === "function") {
      labCommodityRouter.reconcileExistingRestrictedSellOrdersOnce();
    }
    var e = ensureMemory();
    if (e.lastRunTick !== null && e.lastRunTick <= Game.time && Game.time - e.lastRunTick < UPDATE_INTERVAL) return;
    this.forceRun(true);
    e.lastRunTick = Game.time;
    memoryManager.requestSave();
  },
  forceRun: function(e) {
    if (!e && labCommodityRouter && typeof labCommodityRouter.reconcileExistingRestrictedSellOrdersOnce === "function") {
      labCommodityRouter.reconcileExistingRestrictedSellOrdersOnce();
    }
    if (ENABLE_SELL_UPDATES) runSellSide();
  },
  status: function() {
    var e = ensureMemory();
    var r = e.lastRunTick === null || e.lastRunTick > Game.time ? 0 : Math.max(0, UPDATE_INTERVAL - (Game.time - e.lastRunTick));
    var t = [ "=== MARKET UPDATE STATUS ===" ];
    t.push("Managed BUY repricing: owned by marketBuy.js");
    t.push("Sell-side updates: " + (ENABLE_SELL_UPDATES ? "ON" : "OFF (re-raise ratchet)"));
    t.push("Next pass in: " + r + " ticks");
    t.push("");
    var i = typeof marketBuyer.getManagedOrderRecords === "function" ? marketBuyer.getManagedOrderRecords() : {};
    var a = 0;
    for (var o in i) {
      var n = i[o];
      if (!n || n.done || n.cancelled) continue;
      var u = Game.market.orders[o];
      if (!u) {
        t.push("  " + o + " | MISSING");
        a++;
        continue;
      }
      var c = "-";
      if (n.job && n.job.product) {
        var l = pricing.inputCeilings(n.job.product, 20);
        if (l && typeof l[n.resource] === "number") {
          var m = l[n.resource];
          if (typeof n.jobCeiling === "number" && n.jobCeiling > 0) m = Math.min(m, n.jobCeiling);
          c = m.toFixed(3);
        }
      }
      t.push("  " + o + " | " + n.resource + " | price " + u.price.toFixed(3) + " | hardCap " + c + " | rem " + util.getOrderRemaining(u) + "/" + n.trancheTotal + " | repriceFees " + (n.repriceFees || 0).toFixed(1) + " (budget left " + marketBuyer.repriceBudgetRemaining(o).toFixed(1) + ")" + " | " + (n.passive ? "PASSIVE" : "active") + " | product " + (n.job && n.job.product ? n.job.product : "-"));
      a++;
    }
    if (a === 0) t.push("  (no managed buy orders)");
    console.log(t.join("\n"));
    return "[marketUpdate] Status printed.";
  }
};
global.marketUpdate = {
  run: function() {
    return marketUpdater.run();
  },
  forceRun: function() {
    return marketUpdater.forceRun();
  },
  status: function() {
    return marketUpdater.status();
  }
};
global.marketUpdateStatus = function() {
  return marketUpdater.status();
};
module.exports = marketUpdater;
