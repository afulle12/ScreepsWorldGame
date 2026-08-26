// LLM: Read docs/codex.js before reviewing or changing this file.
// marketAttribution.js
const memoryManager = require("memoryManager");
const pricing = require("marketPricing");
const util = require("util");
const VERSION = 3;
const PRICE_TOL = .0015;
const PENDING_TTL = 50;
const DEAL_TTL = 3e3;
const DEAL_SOURCES_MAX = 200;
const ORDER_GRACE = 3e3;
const PRUNE_INTERVAL = 500;
const SKIP_FRAMES = {
  marketAttribution: true,
  "screeps-profiler": true,
  main: true,
  runtime: true,
  eval: true
};
function mem() {
  if (!Memory.marketAttribution || typeof Memory.marketAttribution !== "object" || typeof Memory.marketAttribution.v === "number" && Memory.marketAttribution.v > VERSION) {
    Memory.marketAttribution = {
      v: VERSION,
      orders: {},
      pending: [],
      dealSources: {}
    };
    seed(Memory.marketAttribution);
    memoryManager.requestSave();
  }
  const e = Memory.marketAttribution;
  if (typeof e.v !== "number") e.v = 1;
  if (e.v < VERSION) {
    if (!e.orders || typeof e.orders !== "object") e.orders = {};
    if (!Array.isArray(e.pending)) e.pending = [];
    if (!e.dealSources || typeof e.dealSources !== "object") e.dealSources = {};
    if (Array.isArray(e.deals)) {
      for (let r = 0; r < e.deals.length; r++) {
        const t = e.deals[r];
        if (t && t.i) e.dealSources[t.i] = [ [ t.s, t.t ] ];
      }
    }
    for (const r in e.orders) {
      const t = e.orders[r];
      if (!t || isDefaultSource(t.s, null)) delete e.orders[r];
    }
    for (const r in e.dealSources) {
      const t = e.dealSources[r];
      if (Array.isArray(t)) continue;
      e.dealSources[r] = t && t.s ? [ [ t.s, t.t ] ] : [];
    }
    for (let r = e.pending.length - 1; r >= 0; r--) {
      const t = e.pending[r];
      const n = t && t.y === ORDER_SELL ? "sell" : "buy";
      if (!t || isDefaultSource(t.s, n)) e.pending.splice(r, 1);
    }
    delete e.deals;
    e.v = VERSION;
    memoryManager.requestSave();
  }
  if (!e.orders || typeof e.orders !== "object") e.orders = {};
  if (!Array.isArray(e.pending)) e.pending = [];
  if (!e.dealSources || typeof e.dealSources !== "object") e.dealSources = {};
  return e;
}

function seed(e) {
  var r = Game.market && Game.market.orders || {};
  var t = require("marketBuy");
  var n = t && typeof t.getManagedOrderRecords === "function" ? t.getManagedOrderRecords() : {};
  for (var o in n) {
    if (r[o]) e.orders[o] = {
      s: "marketBuy",
      t: Game.time
    };
  }
  var i = require("marketSell");
  var u = i && typeof i.getRequests === "function" ? i.getRequests() : [];
  for (var s = 0; s < u.length; s++) {
    var a = u[s];
    var c = a && a.orderId;
    if (c && r[c]) e.orders[c] = {
      s: "marketSell",
      t: Game.time
    };
  }
}

function isDefaultSource(e, r) {
  if (!e || e === "untagged") return true;
  if (r === "sell") return e === "marketSell" || e === "opportunisticSell" || e === "marketUpdate";
  if (r === "buy") return e === "marketBuy" || e === "opportunisticBuy" || e === "marketSell" || e === "marketUpdate";
  return e === "marketBuy" || e === "marketSell" || e === "opportunisticBuy" || e === "opportunisticSell" || e === "marketUpdate";
}

function callerModule() {
  const e = (new Error).stack || "";
  const r = e.split("\n");
  for (let e = 1; e < r.length; e++) {
    const t = /([A-Za-z0-9_$-]+)(?:\.js)?:\d+:\d+/.exec(r[e]);
    if (!t) continue;
    const n = t[1];
    if (SKIP_FRAMES[n]) continue;
    if (n.indexOf("_console") === 0) return "console";
    return n;
  }
  return null;
}

function logicalSource(e, r, t) {
  if (t === "sell") {
    if (e === null || e === "untagged" || e === "marketSell" || e === "opportunisticSell" || e === "marketUpdate") {
      return productClass(r) + "-sales";
    }
    return e;
  }
  if (e === null || e === "untagged" || e === "marketBuy" || e === "opportunisticBuy" || e === "marketSell" || e === "marketUpdate") {
    return buyPurpose(null, r);
  }
  return e;
}

function orderFee(e, r) {
  if (!(e > 0) || !(r > 0) || !isFinite(e) || !isFinite(r)) return 0;
  return pricing.FEE * e * r;
}

function recordFee(e, r, t, n, o) {
  if (!(n > 0)) return;
  require("dailyFinance").recordFee(logicalSource(e, r, t), n);
  if (e === "marketPriceAdjustment") {
    require("economics").record(e, o, r, {
      fee: n
    });
  }
}

function ensurePatched() {
  const e = Game.market;
  if (e._attrWrapped) return;
  const r = e.deal;
  e.deal = function(t) {
    const n = r.apply(e, arguments);
    if (n === OK) {
      const e = callerModule() || "untagged";
      if (!isDefaultSource(e, null)) {
        const r = mem();
        if (!Array.isArray(r.dealSources[t])) r.dealSources[t] = [];
        r.dealSources[t].push([ e, Game.time ]);
        memoryManager.requestImmediateSave("marketAttribution.deal");
      }
    }
    return n;
  };
  const t = e.createOrder;
  e.createOrder = function(r) {
    const n = t.apply(e, arguments);
    if (n === OK && r && typeof r === "object") {
      const e = callerModule() || "untagged";
      mem().pending.push({
        s: e,
        y: r.type,
        r: r.resourceType,
        p: r.price,
        a: r.totalAmount,
        m: r.roomName || null,
        f: orderFee(r.price, r.totalAmount),
        t: Game.time
      });
      memoryManager.requestImmediateSave("marketAttribution.createOrder");
    }
    return n;
  };
  const n = e.extendOrder;
  e.extendOrder = function(r, t) {
    const o = e.orders && e.orders[r];
    const i = n.apply(e, arguments);
    if (i === OK && o) {
      recordFee(callerModule() || "untagged", o.resourceType, o.type === ORDER_SELL ? "sell" : "buy", orderFee(o.price, t), o.roomName);
    }
    return i;
  };
  const o = e.changeOrderPrice;
  e.changeOrderPrice = function(r, t) {
    const n = e.orders && e.orders[r];
    const i = n && n.price;
    const u = o.apply(e, arguments);
    if (u === OK && n && t > i) {
      recordFee(callerModule() || "untagged", n.resourceType, n.type === ORDER_SELL ? "sell" : "buy", orderFee(t - i, util.getOrderRemaining(n)), n.roomName);
    }
    return u;
  };
  e._attrWrapped = true;
}

function capture() {
  const e = mem();
  if (e.pending.length === 0) return;
  const r = Game.market.orders || {};
  for (const t in r) {
    if (e.orders[t]) continue;
    const n = r[t];
    for (let r = 0; r < e.pending.length; r++) {
      const o = e.pending[r];
      if (o.y === n.type && o.r === n.resourceType && (o.m || null) === (n.roomName || null) && o.a === n.totalAmount && Math.abs(o.p - n.price) < PRICE_TOL) {
        e.orders[t] = {
          s: o.s,
          t: Game.time
        };
        recordFee(o.s, o.r, o.y === ORDER_SELL ? "sell" : "buy", o.f === undefined ? orderFee(o.p, o.a) : o.f, n.roomName || o.m);
        e.pending.splice(r, 1);
        break;
      }
    }
    if (e.pending.length === 0) break;
  }
  for (let r = e.pending.length - 1; r >= 0; r--) {
    if (Game.time - e.pending[r].t > PENDING_TTL) e.pending.splice(r, 1);
  }
}

function prune() {
  if (Game.time % PRUNE_INTERVAL !== 0) return;
  const e = mem();
  const r = Game.market.orders || {};
  for (const t in e.orders) {
    if (r[t]) e.orders[t].t = Game.time; else if (Game.time - e.orders[t].t > ORDER_GRACE) delete e.orders[t];
  }
  const t = e.dealSources;
  const n = [];
  for (const e in t) {
    const r = t[e];
    if (!Array.isArray(r)) {
      delete t[e];
      continue;
    }
    while (r.length && Game.time - (r[0][1] || 0) > DEAL_TTL) r.shift();
    if (!r.length) delete t[e]; else n.push({
      id: e,
      t: r[0][1] || 0
    });
  }
  n.sort(function(e, r) {
    return e.t - r.t;
  });
  while (n.length > DEAL_SOURCES_MAX) delete t[n.shift().id];
}

const BASE_MINERALS = {
  H: 1,
  O: 1,
  U: 1,
  L: 1,
  K: 1,
  Z: 1,
  X: 1
};
const DEPOSITS = {
  mist: 1,
  biomass: 1,
  metal: 1,
  silicon: 1
};
function productClass(e) {
  if (e === RESOURCE_ENERGY || e === RESOURCE_BATTERY) return "energy";
  if (e === RESOURCE_POWER || e === RESOURCE_OPS) return "power";
  if (DEPOSITS[e]) return "deposits";
  if (BASE_MINERALS[e]) return "minerals";
  if (typeof REACTION_TIME !== "undefined" && REACTION_TIME[e] !== undefined) return "compounds";
  if (typeof COMMODITIES !== "undefined" && COMMODITIES[e] !== undefined) return "commodities";
  return "other";
}

function buyPurpose(e, r) {
  if (e === "factory") return "factory-inputs";
  if (e === "lab") return "lab-inputs";
  return productClass(r) + "-buys";
}

function attribute(e, r, t) {
  const n = require("marketBuy");
  const o = n && typeof n.getManagedOrderRecords === "function" ? n.getManagedOrderRecords() : {};
  const i = o && e ? o[e] : null;
  if (i) return buyPurpose(i.queue, r);
  const u = mem();
  const s = e && u.orders[e];
  let a = s ? s.s : null;
  if (!a && e && Array.isArray(u.dealSources[e]) && u.dealSources[e].length) {
    const r = u.dealSources[e].pop();
    a = r && r[0];
    if (u.dealSources[e].length === 0) delete u.dealSources[e];
    memoryManager.requestImmediateSave("marketAttribution.consumeDeal");
  }
  return logicalSource(a, r, t);
}

function sourceOf(e) {
  if (!e) return null;
  const r = mem();
  const t = r.orders[e];
  if (t) return t.s;
  const n = r.dealSources[e];
  if (Array.isArray(n) && n.length) return n[n.length - 1][0];
  return null;
}

function isAdjustmentOrder(e) {
  return sourceOf(e) === "marketPriceAdjustment";
}

function run() {
  mem();
  ensurePatched();
  capture();
  prune();
}

module.exports = {
  run: run,
  sourceOf: sourceOf,
  isAdjustmentOrder: isAdjustmentOrder,
  attribute: attribute
};
