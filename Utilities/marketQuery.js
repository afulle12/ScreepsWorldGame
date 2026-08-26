// LLM: Read docs/codex.js before reviewing or changing this file.
// marketQuery.js
// Console globals: marketPrice
// Example: marketPrice(RESOURCE_ENERGY) - Query current buy and sell prices for resource
//   marketPrice('energy')                // 48h avg (approx.)
//   marketPrice('RESOURCE_ENERGY')       // 48h avg (approx.)
//   marketPrice('UO', 'sell')            // Top 5 sells for UO
//   marketPrice('keanium', 'buy')        // Top 5 buys for keanium
//   weighted by volume, because Screeps history is daily granularity.
//   as strings (e.g. 'RESOURCE_ENERGY'). If you already pass the constant
//   value (e.g. RESOURCE_ENERGY), that works too.
(function registerMarketPriceGlobal() {
  var r = require("util");
  var e = require("marketPricing");
  function resolveResource(r) {
    if (typeof r === "string" && typeof RESOURCES_ALL !== "undefined") {
      if (RESOURCES_ALL.indexOf(r) !== -1) return r;
      var e = global[r];
      if (typeof e === "string" && RESOURCES_ALL.indexOf(e) !== -1) {
        return e;
      }
      var t = r.toLowerCase();
      if (RESOURCES_ALL.indexOf(t) !== -1) return t;
      if (t === "keanium") return RESOURCE_KEANIUM;
      if (t === "utrium") return RESOURCE_UTRIUM;
      if (t === "lemergium") return RESOURCE_LEMERGIUM;
      if (t === "zynthium") return RESOURCE_ZYNTHIUM;
      if (t === "oxygen") return RESOURCE_OXYGEN;
      if (t === "hydrogen") return RESOURCE_HYDROGEN;
      if (t === "catalyst") return RESOURCE_CATALYST;
      if (t === "power") return RESOURCE_POWER;
      return r;
    }
    return r;
  }
  function formatPrice(r) {
    return typeof r === "number" ? r.toFixed(3) : String(r);
  }
  function formatOrderLine(e, t) {
    var n = e.id;
    var i = formatPrice(e.price);
    var o = r.getOrderRemaining(e);
    var a = e.roomName || "N/A";
    return "#" + t + " " + i + " | amt=" + o + " | room=" + a + " | " + n;
  }
  function getAvg48hString(r) {
    var t = e.getHistDays(r) || [];
    if (t.length === 0) {
      return "[Market] No history for " + r;
    }
    var n = e.getAvg48h(r);
    if (n === null) {
      return "[Market] No usable history for " + r;
    }
    var i = t[t.length - 1];
    var o = t.length >= 2 ? t[t.length - 2] : null;
    var a = (i && i.volume || 0) + (o && o.volume || 0);
    return "[Market] " + r + " 48h avg (approx): " + formatPrice(n) + " (volume: " + a + ", days=" + (o ? 2 : 1) + ")";
  }
  function getTopOrdersString(e, t) {
    var n = t === "buy" ? ORDER_BUY : ORDER_SELL;
    var i = r.marketOrders(e, n, 0);
    var o = [];
    for (var a = 0; a < i.length; a++) {
      var u = i[a];
      var f = r.getOrderRemaining(u);
      if (f > 0) o.push(u);
    }
    o.sort(function(r, e) {
      if (t === "buy") return e.price - r.price;
      return r.price - e.price;
    });
    if (o.length === 0) {
      return "[Market] No " + t + " orders found for " + e;
    }
    var s = o.slice(0, 5);
    var g = [];
    g.push("[Market] " + e + " | top " + (t === "buy" ? "buy" : "sell") + " orders:");
    for (var l = 0; l < s.length; l++) {
      g.push("  " + formatOrderLine(s[l], l + 1));
    }
    return g.join("\n");
  }
  global.marketPrice = function(r, e) {
    if (!r) {
      return "Usage: marketPrice('resource', mode)\n" + " - mode omitted or 'avg'  -> 48h avg price (approx.)\n" + " - mode 'buy'             -> top 5 buy orders (highest first)\n" + " - mode 'sell'            -> top 5 sell orders (lowest first)\n" + "Examples:\n" + "  marketPrice('energy')\n" + "  marketPrice('RESOURCE_ENERGY')\n" + "  marketPrice('UO', 'sell')\n" + "  marketPrice('keanium', 'buy')";
    }
    var t = resolveResource(r);
    var n = (e || "avg") + "";
    n = n.toLowerCase();
    if (n === "avg" || n === "average" || n === "mean") {
      return getAvg48hString(t);
    } else if (n === "buy") {
      return getTopOrdersString(t, "buy");
    } else if (n === "sell") {
      return getTopOrdersString(t, "sell");
    } else {
      return "[Market] Unknown mode '" + n + "'. Use 'avg', 'buy', or 'sell'.";
    }
  };
})();
