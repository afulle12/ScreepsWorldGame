// LLM: Read docs/codex.js before reviewing or changing this file.
// marketRefine.js
// Console globals: marketRefine, marketRefineStatus, cancelMarketRefine, cancelLastMarketRefine, cancelAllMarketRefine, abortMarketRefine, cancelFactoryOrder, marketRefineOutcomes, marketRefineForceList, marketRefineComputeBidPrice, marketRefineShouldUseMarketBuy, marketRefineDebugBuyDecision, marketRefineDebugOpBuy
// Example: marketRefine('E1N1', 'XGH2O', 3000) - Execute market-driven commodity refinement
// Example: marketRefineStatus('E1N1') - View active refinement queues and progress
// Example: cancelMarketRefine('E1N1', 'opId') - Cancel specific market refinement operation
// Example: cancelLastMarketRefine('E1N1') - Cancel most recently queued refinement operation
// Example: cancelAllMarketRefine('E1N1') - Cancel all pending refinement operations
// Example: abortMarketRefine('E1N1') - Immediately abort active refinement operations
// Example: cancelFactoryOrder('E1N1', 'orderId') - Cancel linked factory order for refinement
// Example: marketRefineOutcomes() - Display profit/loss outcomes of past refinements
// Example: marketRefineForceList() - Print list of forced refinement commodities
// Example: marketRefineComputeBidPrice('XGH2O') - Calculate target buy bid for refinement input
// Example: marketRefineShouldUseMarketBuy('XGH2O') - Check if inputs should be bought from market
// Example: marketRefineDebugBuyDecision('XGH2O') - Trace buy vs produce refinement decision
// Example: marketRefineDebugOpBuy('E1N1', 'XGH2O') - Trace opportunistic refinement buying
//   marketRefine('W1N1', 'Zynthium bar')
//   marketRefine('W1N1', RESOURCE_COMPOSITE)
//   marketRefine('W1N1', RESOURCE_COMPOSITE, { utrium_bar: 330, zynthium_bar: 79 })  // max prices
//   marketRefineStatus() / marketRefineStatus('op_id')  List ops / details.
//   cancelMarketRefine('op_id')  Cancel op + linked marketBuy orders.
//   cancelLastMarketRefine()     Cancel the most recent op.
//   abortMarketRefine(room, product)  Cancel a still-buying op and sell back
//     acquired inputs.
//   marketRefineDebugOpBuy()     Print detected opportunisticBuy methods.
//   marketRefineOutcomes(n)      Last n recorded outcomes (default 20).
//   cancelAllMarketRefine()
// longer break-even -> cancel; margin alive -> passivate (marketBuy.js
var getRoomState = require("getRoomState");
var marketBuyer = require("marketBuy");
var pricing = require("marketPricing");
var util = require("util");
var memoryManager = require("memoryManager");
var storageManager = require("storageManager");
var factorySlots = require("factorySlots");
var marketBatchBuy = require("marketBatchBuy");
var marketEconomics = require("marketEconomics");
var factoryManager = require("factoryManager");
var labCommodityPolicy = require("labCommodityPolicy");
var labCommodityRouter = require("labCommodityRouter");
var MEMORY_VERSION = 2;
function getOpBuy() {
  var e = global.opportunisticBuy;
  if (!e) {
    try {
      e = require("opportunisticBuy");
    } catch (r) {
      e = null;
    }
  }
  return e;
}

function opBuyMethodsString() {
  var e = getOpBuy();
  if (!e) return "(not found)";
  var r = [];
  for (var t in e) {
    if (typeof e[t] === "function") r.push(t + "()"); else r.push(t + ":" + typeof e[t]);
  }
  if (typeof e === "function") r.unshift("(callable export)");
  return r.join(", ");
}

function ensureMemory() {
  if (!Memory.marketRefine) Memory.marketRefine = {
    v: MEMORY_VERSION,
    ops: [],
    outcomes: []
  };
  if (!Array.isArray(Memory.marketRefine.ops)) Memory.marketRefine.ops = [];
  if (!Array.isArray(Memory.marketRefine.outcomes)) Memory.marketRefine.outcomes = [];
  if (!Memory.marketRefine.scheduler || typeof Memory.marketRefine.scheduler !== "object") {
    Memory.marketRefine.scheduler = {
      nextOpId: null
    };
    memoryManager.requestSave();
  } else if (!Object.prototype.hasOwnProperty.call(Memory.marketRefine.scheduler, "nextOpId")) {
    Memory.marketRefine.scheduler.nextOpId = null;
    memoryManager.requestSave();
  }
  if (Memory.marketRefine.v !== MEMORY_VERSION) {
    for (var e = 0; e < Memory.marketRefine.ops.length; e++) {
      var r = Memory.marketRefine.ops[e];
      if (!r) continue;
      delete r.lastUpdate;
      delete r.buyRequestCreated;
      if (r.inputs && r.inputs.length > 0) {
        delete r.input;
        delete r.targetBuy;
        delete r.price;
      }
      Memory.marketRefine.ops[e] = memoryManager.compactMarketRefineOperation(r);
    }
    Memory.marketRefine.v = MEMORY_VERSION;
    memoryManager.requestSave();
  } else {
    memoryManager.hydrateMarketRefineRoot(Memory.marketRefine);
  }
}

var OUTCOMES_HISTORY_CAP = 60;
var SELL_RETRY_TICKS = 10;
var STALE_SELLING_TICKS = 1e5;
function recordOutcome(e, r, t) {
  ensureMemory();
  Memory.marketRefine.outcomes.push({
    id: e.id,
    room: e.room,
    output: e.output,
    status: r,
    reason: t || e.failReason || null,
    started: e.started,
    tick: Game.time,
    jobId: e.jobId || null
  });
  if (Memory.marketRefine.outcomes.length > OUTCOMES_HISTORY_CAP) {
    Memory.marketRefine.outcomes = Memory.marketRefine.outcomes.slice(-OUTCOMES_HISTORY_CAP);
  }
  e._outcomeRecorded = true;
  if (e.handoffReservationProgram && e.handoffResource && r !== "done") {
    storageManager.unReserve(e.room, e.handoffResource, "terminal", e.handoffReservationProgram);
    storageManager.unReserve(e.room, e.handoffResource, "storage", e.handoffReservationProgram);
  }
  if (e.jobId) {
    try {
      var o = require("marketEconomics");
      if (r === "done") o.phase(e.jobId, "selling");
      o.finish(e.jobId, r === "done" ? "done" : r, t || e.failReason || null);
    } catch (e) {}
  }
  memoryManager.requestSave();
}

function releaseProductionState(e) {
  var r = [ "inputs", "input", "targetBuy", "price", "baseInputCount", "useMarketBuy", "factoryCreated", "factoryStarted", "factoryRetryTick" ];
  var t = false;
  for (var o = 0; o < r.length; o++) {
    if (e[r[o]] !== undefined) {
      delete e[r[o]];
      t = true;
    }
  }
  if (t) memoryManager.requestSave();
}

function normalizeOutput(e) {
  if (e && typeof e !== "string") return e;
  var r = (e || "").trim().toUpperCase();
  var t = {
    OXIDANT: RESOURCE_OXIDANT,
    REDUCTANT: RESOURCE_REDUCTANT,
    "ZYNTHIUM BAR": RESOURCE_ZYNTHIUM_BAR,
    ZYNTHIUM_BAR: RESOURCE_ZYNTHIUM_BAR,
    "LEMERGIUM BAR": RESOURCE_LEMERGIUM_BAR,
    LEMERGIUM_BAR: RESOURCE_LEMERGIUM_BAR,
    "UTRIUM BAR": RESOURCE_UTRIUM_BAR,
    UTRIUM_BAR: RESOURCE_UTRIUM_BAR,
    "KEANIUM BAR": RESOURCE_KEANIUM_BAR,
    KEANIUM_BAR: RESOURCE_KEANIUM_BAR,
    "GHODIUM MELT": RESOURCE_GHODIUM_MELT,
    GHODIUM_MELT: RESOURCE_GHODIUM_MELT,
    PURIFIER: RESOURCE_PURIFIER,
    COMPOSITE: RESOURCE_COMPOSITE,
    CRYSTAL: RESOURCE_CRYSTAL,
    LIQUID: RESOURCE_LIQUID,
    WIRE: RESOURCE_WIRE,
    CELL: RESOURCE_CELL,
    ALLOY: RESOURCE_ALLOY,
    CONDENSATE: RESOURCE_CONDENSATE,
    TUBE: RESOURCE_TUBE,
    FIXTURES: RESOURCE_FIXTURES,
    FRAME: RESOURCE_FRAME,
    HYDRAULICS: RESOURCE_HYDRAULICS,
    MACHINE: RESOURCE_MACHINE,
    PHLEGM: RESOURCE_PHLEGM,
    TISSUE: RESOURCE_TISSUE,
    MUSCLE: RESOURCE_MUSCLE,
    ORGANOID: RESOURCE_ORGANOID,
    ORGANISM: RESOURCE_ORGANISM,
    SWITCH: RESOURCE_SWITCH,
    TRANSISTOR: RESOURCE_TRANSISTOR,
    MICROCHIP: RESOURCE_MICROCHIP,
    CIRCUIT: RESOURCE_CIRCUIT,
    DEVICE: RESOURCE_DEVICE,
    CONCENTRATE: RESOURCE_CONCENTRATE,
    EXTRACT: RESOURCE_EXTRACT,
    SPIRIT: RESOURCE_SPIRIT,
    EMANATION: RESOURCE_EMANATION,
    ESSENCE: RESOURCE_ESSENCE,
    UTRIUM: RESOURCE_UTRIUM,
    LEMERGIUM: RESOURCE_LEMERGIUM,
    ZYNTHIUM: RESOURCE_ZYNTHIUM,
    KEANIUM: RESOURCE_KEANIUM,
    GHODIUM: RESOURCE_GHODIUM,
    OXYGEN: RESOURCE_OXYGEN,
    HYDROGEN: RESOURCE_HYDROGEN,
    CATALYST: RESOURCE_CATALYST
  };
  if (t[r]) return t[r];
  if (global[r]) return global[r];
  return e;
}

var OUTPUT_TO_INPUT = {};
OUTPUT_TO_INPUT[RESOURCE_OXIDANT] = RESOURCE_OXYGEN;
OUTPUT_TO_INPUT[RESOURCE_REDUCTANT] = RESOURCE_HYDROGEN;
OUTPUT_TO_INPUT[RESOURCE_PURIFIER] = RESOURCE_CATALYST;
OUTPUT_TO_INPUT[RESOURCE_ZYNTHIUM_BAR] = RESOURCE_ZYNTHIUM;
OUTPUT_TO_INPUT[RESOURCE_LEMERGIUM_BAR] = RESOURCE_LEMERGIUM;
OUTPUT_TO_INPUT[RESOURCE_UTRIUM_BAR] = RESOURCE_UTRIUM;
OUTPUT_TO_INPUT[RESOURCE_KEANIUM_BAR] = RESOURCE_KEANIUM;
OUTPUT_TO_INPUT[RESOURCE_GHODIUM_MELT] = RESOURCE_GHODIUM;
var DEFAULT_BUY_AMOUNT = 6e3;
var RECIPE_BATCH_MULTIPLIER = 12;
var OP_EXPIRY_TICKS = 1e5;
var RANGE_GATE = .2;
var MARKET_BUY_FORCE_LIST = {
  [RESOURCE_BIOMASS]: true,
  [RESOURCE_METAL]: true,
  [RESOURCE_SILICON]: true,
  [RESOURCE_MIST]: true
};
function shouldUseMarketSell() {
  return false;
}

function isForceMarketBuy(e) {
  return !!MARKET_BUY_FORCE_LIST[e];
}

function shouldUseMarketBuy(e, r, t, o) {
  if (MARKET_BUY_FORCE_LIST[r]) return true;
  if (r === RESOURCE_ENERGY) return false;
  var a = pricing.chooseBuyMethod(r, t, {
    rangeGate: RANGE_GATE,
    amount: o
  });
  return a && a.method === "order";
}

function computeCompetitiveBid(e, r, t) {
  var o = pricing.chooseBuyMethod(e, r, {
    rangeGate: RANGE_GATE,
    forceOrder: !!MARKET_BUY_FORCE_LIST[e],
    amount: t
  });
  if (!o || o.method !== "order" || !(o.suggestedBid > 0)) return null;
  if (typeof r === "number" && r > 0 && o.suggestedBid > r + 5e-4) return null;
  return Math.max(.001, Math.round(o.suggestedBid * 1e3) / 1e3);
}

function getRecipeInputs(e, r) {
  if (COMMODITIES && COMMODITIES[e]) {
    var t = COMMODITIES[e];
    var o = t.components || {};
    var a = [];
    for (var n in o) {
      if (!o.hasOwnProperty(n)) continue;
      if (n === RESOURCE_ENERGY && e !== RESOURCE_BATTERY) continue;
      var u = o[n] * (r || RECIPE_BATCH_MULTIPLIER);
      a.push({
        resource: n,
        amount: u
      });
    }
    if (a.length > 0) return a;
  }
  if (OUTPUT_TO_INPUT[e]) {
    return [ {
      resource: OUTPUT_TO_INPUT[e],
      amount: DEFAULT_BUY_AMOUNT
    } ];
  }
  return null;
}

function failOp(e, r, t) {
  var o = "[MarketRefine] FAILED: " + e.id + " (" + e.output + " in " + e.room + ") - " + r;
  if (t) o += " | " + t;
  console.log(o);
  e.phase = "failed";
  e.failReason = r;
  e.failTick = Game.time;
  recordOutcome(e, "failed", t ? r + ": " + t : r);
}

function computeCeiling(e) {
  var r = pricing.getInputBuyQuote(e, 0);
  if (r && r.price > 0) return r.price;
  var t = pricing.getPriceProfile(e);
  if (t && typeof t.buyPrice === "number" && isFinite(t.buyPrice) && t.buyPrice > 0) {
    return t.buyPrice;
  }
  if (t && typeof t.theoreticalPrice === "number" && isFinite(t.theoreticalPrice) && t.theoreticalPrice > 0) {
    return t.theoreticalPrice;
  }
  return 0;
}

function factoryOpBuyOpts(e, r, t) {
  return {
    queue: "factory",
    product: e || null,
    opId: r || null,
    jobId: t || null
  };
}

function findFactoryOpBuyRequestKeys(e, r, t) {
  var o = [];
  var a = getOpBuy();
  var n = a && typeof a.getActiveRequestEntries === "function" ? a.getActiveRequestEntries() : [];
  for (var u = 0; u < n.length; u++) {
    var i = n[u].key;
    var s = n[u].request;
    if (!s || s.roomName !== e || s.resourceType !== r) continue;
    if ((s.queue || "default") !== "factory") continue;
    if (t && s.opId && s.opId !== t) continue;
    o.push(i);
  }
  return o;
}

function invokeOpportunisticBuy(e, r, t, o, a, n, u) {
  var i = getOpBuy();
  if (!i) return "[MarketRefine] ERROR: opportunisticBuy module not available.";
  var s = factoryOpBuyOpts(a, n, u);
  memoryManager.requestSave();
  try {
    if (typeof i.setup === "function") return i.setup(e, r, t, o, s);
    if (typeof i.requestBuy === "function") return i.requestBuy(e, r, t, o);
    if (typeof i.addRequest === "function") return i.addRequest(e, r, t, o);
    if (typeof i.request === "function") return i.request(e, r, t, o);
    if (typeof i.enqueue === "function") return i.enqueue(e, r, t, o);
    if (typeof i.queue === "function") return i.queue(e, r, t, o);
    if (typeof i.buy === "function") return i.buy(e, r, t, o);
    if (typeof i === "function") return i(e, r, t, o);
  } catch (e) {
    return "[MarketRefine] ERROR invoking opportunisticBuy: " + e;
  }
  return "[MarketRefine] ERROR: Unknown opportunisticBuy API; methods: " + opBuyMethodsString();
}

function cancelOpBuyRequest(e, r, t) {
  var o = findFactoryOpBuyRequestKeys(e, r, t);
  if (o.length === 0) return;
  var a = getOpBuy();
  for (var n = 0; n < o.length; n++) {
    if (a && typeof a.cancelRequestByKey === "function") a.cancelRequestByKey(o[n]);
  }
  memoryManager.requestSave();
  console.log("[MarketRefine] Cancelled " + o.length + " opportunisticBuy request(s) for " + r + " in " + e + (t ? " (op " + t + ")" : ""));
}

function hasActiveOpBuyRequest(e, r, t) {
  var o = findFactoryOpBuyRequestKeys(e, r, t);
  var a = getOpBuy();
  for (var n = 0; n < o.length; n++) {
    var u = a && typeof a.getRequestByKey === "function" ? a.getRequestByKey(o[n]) : null;
    if (u && u.remaining > 0) return true;
  }
  return false;
}

function createOpportunisticBuyForInput(e, r, t, o, a, n) {
  var u = invokeOpportunisticBuy(e, r.resource, t, r.maxPrice, o, a, n);
  if (hasActiveOpBuyRequest(e, r.resource, a)) return true;
  console.log("[MarketRefine] Failed to create opportunisticBuy for " + r.resource + " in " + e + " (op " + a + "): " + u);
  return false;
}

function cancelInputProcurement(e, r, t, o) {
  for (var a = 0; a < r.length; a++) {
    var n = r[a];
    if (n.useOwned) {
      if (n.handoffReservationProgram) {
        storageManager.unReserve(e, n.resource, "terminal", n.handoffReservationProgram);
        storageManager.unReserve(e, n.resource, "storage", n.handoffReservationProgram);
      }
      continue;
    }
    if (n.useMarketSell) continue;
    if (n.useMarketBuy) {
      marketBuyer.cancelOrderFor(e, n.resource, o, "factory", t);
    } else if (n.useBatch && n.batchBuyJobId) {
      var u = marketBatchBuy.find(n.batchBuyJobId);
      if (u && (u.state === marketBatchBuy.STATE_QUEUED || u.state === marketBatchBuy.STATE_PENDING)) {
        marketBatchBuy.cancel(n.batchBuyJobId, o || "factory input cancellation");
      }
    } else if (hasActiveOpBuyRequest(e, n.resource, t)) {
      cancelOpBuyRequest(e, n.resource, t);
    }
  }
}

function forEachBatchJob(e, r) {
  if (!e || !Array.isArray(e.batchBuyIds)) return;
  for (var t = 0; t < e.batchBuyIds.length; t++) {
    var o = marketBatchBuy.find(e.batchBuyIds[t]);
    if (o) r(o);
  }
}

function getBatchReservationAmount(e, r) {
  var t = 0;
  forEachBatchJob(e, function(e) {
    if (e.resourceType !== r) return;
    t += marketBatchBuy.getReservationAmount(e.id) || 0;
  });
  return t;
}

function releaseBatchReservations(e, r) {
  var t = false;
  forEachBatchJob(e, function(e) {
    var o = marketBatchBuy.releaseReservation(e.id, r || "production handoff");
    if (o && o.removed > 0) t = true;
  });
  return t;
}

function restoreBatchReservations(e) {
  var r = true;
  forEachBatchJob(e, function(e) {
    if (e.state !== marketBatchBuy.STATE_DONE) return;
    var t = marketBatchBuy.reserve(e.id);
    if (!t || !t.ok) r = false;
  });
  return r;
}

function callOrderFactory(e, r, t) {
  if (typeof orderFactory === "function") {
    return orderFactory(e, r, t);
  }
  try {
    var o = require("factoryManager");
    if (o && typeof o.orderFactory === "function") {
      return o.orderFactory(e, r, t);
    }
  } catch (e) {}
  return "[MarketRefine] ERROR: orderFactory not available.";
}

function callMarketSell(e, r, t, o, a) {
  if (labCommodityPolicy.isTwoLetterLabProduct(r)) {
    labCommodityRouter.enqueue(e, r, t, "marketRefine cleanup");
    return "[MarketRefine] Two-letter lab product conversion queued.";
  }
  var n = global.marketSell;
  if (!n) {
    try {
      n = require("marketSell");
    } catch (e) {
      n = null;
    }
  }
  if (!n) return "[MarketRefine] ERROR: marketSell not available.";
  try {
    if (typeof n.marketSell === "function") return n.marketSell(e, r, t, o, a);
    if (typeof n.sell === "function") return n.sell(e, r, t, o, a);
    if (typeof n.run === "function") return n.run(e, r, t, o, a);
    if (typeof n === "function") return n(e, r, t, o, a);
  } catch (e) {
    return "[MarketRefine] ERROR invoking marketSell: " + e;
  }
  return "[MarketRefine] ERROR: Unknown marketSell API.";
}

function hasOwnedSellLot(e) {
  if (!e || !marketEconomics || typeof marketEconomics.hasSellLotForJob !== "function") return false;
  try {
    return !!marketEconomics.hasSellLotForJob(e);
  } catch (e) {
    return false;
  }
}

function sellOrderBaseline(e, r) {
  var t = Game.market && Game.market.orders;
  var o = t && t[e];
  if (!o) return null;
  var a = 0;
  var n = Game.market.outgoingTransactions || [];
  for (var u = 0; u < n.length; u++) {
    var i = n[u];
    if (!i || !i.order || i.order.id !== e) continue;
    if (typeof i.time === "number" && i.time < (r || 0)) continue;
    a += i.amount || 0;
  }
  return util.getOrderRemaining(o) + a;
}

function findLegacySellOrder(e, r) {
  if (!e || !e.room || !e.output || !Game.market || !Game.market.orders) return null;
  var t = {};
  var o = Game.market.orders;
  var a = require("marketSell");
  var n = a && typeof a.getRequests === "function" ? a.getRequests() : [];
  var u = e.sellPostedTick || 0;
  function add(r, a) {
    if (!r || !o[r]) return;
    var n = o[r];
    if (n.type !== ORDER_SELL || n.roomName !== e.room || n.resourceType !== e.output || !(util.getOrderRemaining(n) > 0)) return;
    if (!t[r] || t[r].score < a) {
      t[r] = {
        id: r,
        score: a
      };
    }
  }
  var i = marketEconomics && typeof marketEconomics.getOrderLots === "function" ? marketEconomics.getOrderLots() : {};
  for (var s in i) {
    var c = i[s];
    if (!c || !Array.isArray(c.lots)) continue;
    for (var f = 0; f < c.lots.length; f++) {
      if (c.lots[f] && c.lots[f].jobId === e.jobId && c.lots[f].remaining > 0) {
        add(s, 100);
        break;
      }
    }
  }
  for (var l = 0; l < n.length; l++) {
    var d = n[l];
    if (!d || !d.orderId || d.roomName !== e.room || d.resourceType !== e.output) continue;
    var m = 0;
    if (e.jobId && d.jobId === e.jobId) m += 100;
    if (d.created === u) m += 50; else if (u && Math.abs((d.created || 0) - u) <= 5) m += 20;
    if (typeof r === "number" && d.amount === r) m += 20; else if (typeof r === "number" && d.amount >= r) m += 5;
    if (m > 0) add(d.orderId, m);
  }
  var p = null;
  var R = false;
  for (var y in t) {
    var O = t[y];
    if (!p || O.score > p.score) {
      p = O;
      R = false;
    } else if (O.score === p.score) {
      R = true;
    }
  }
  if (!p || R || p.score < 20) return null;
  p.baseline = sellOrderBaseline(p.id, u);
  return p;
}

function recoverLegacySellOrder(e, r) {
  if (!e || e.sellOrderId) return false;
  var t = findLegacySellOrder(e, r);
  if (!t) return false;
  e.sellOrderId = t.id;
  if (t.baseline !== null) e.sellOrderRemainingAtPost = t.baseline; else delete e.sellOrderRemainingAtPost;
  console.log("[MarketRefine] Recovered legacy sell order " + t.id + " for " + e.id);
  memoryManager.requestSave();
  return true;
}

function callMarketBuy(e, r, t, o, a, n, u, i) {
  try {
    var s = marketBuyer.marketBuy(e, r, t, o, {
      product: n,
      room: e,
      ceiling: a,
      queue: "factory",
      opId: u || null,
      jobId: i || null
    });
    var c = typeof s === "string" && s.indexOf("Created BUY order") >= 0;
    if (c) memoryManager.requestSave();
    return {
      ok: c,
      message: s
    };
  } catch (e) {
    return {
      ok: false,
      message: "[MarketRefine] ERROR invoking marketBuy: " + e
    };
  }
}

function getOwnBuyRecord(e, r) {
  var t = marketBuyer.getOrderRecordFor(e.room, r, "factory", e.id || null);
  if (t) return t;
  var o = marketBuyer.getOrderRecordFor(e.room, r, "factory");
  return o && !o.opId ? o : null;
}

function pollMarketBuyOrderId(e, r) {
  var t = getOwnBuyRecord(e, r.resource);
  if (t && t.orderId && !r.marketBuyOrderId) {
    r.marketBuyOrderId = t.orderId;
  }
  return t;
}

function roomOwned(e) {
  var r = getRoomState.get(e);
  return !!(r && r.controller && r.controller.my);
}

function roomHasTerminal(e) {
  var r = getRoomState.get(e);
  return !!(r && r.terminal);
}

function countInRoom(e, r) {
  var t = getRoomState.get(e);
  if (!t) return 0;
  var o = 0;
  function add(e) {
    if (e && e.store && e.store[r]) o += e.store[r];
  }
  add(t.storage);
  add(t.terminal);
  var a = t.structuresByType || {};
  var n = a[STRUCTURE_FACTORY] || [];
  if (n.length > 0) add(n[0]);
  return o;
}

function countUnreservedInput(e, r) {
  var t = storageManager.storageFind(e, r);
  if (t && t.combined && typeof t.combined.available === "number") {
    return Math.max(0, t.combined.available);
  }
  return countInRoom(e, r);
}

function startFactoryOrder(e, r, t) {
  var o = callOrderFactory(e, r, t);
  var a = null;
  if (typeof o === "string") {
    var n = o.match(/\[#([^\]]+)\]/);
    if (n && n[1]) a = n[1];
  }
  return {
    message: o,
    orderId: a
  };
}

function marketSellAccepted(e) {
  return typeof e === "string" && (e.indexOf("Created SELL order") >= 0 || e.indexOf("extended existing") >= 0);
}

function targetOutputForInputs(e, r) {
  if (typeof COMMODITIES === "undefined" || !COMMODITIES[e]) return 0;
  var t = COMMODITIES[e];
  var o = Infinity;
  for (var a = 0; a < r.length; a++) {
    var n = t.components && t.components[r[a].resource];
    if (n > 0) o = Math.min(o, Math.floor(r[a].amount / n));
  }
  if (o === Infinity || o <= 0) return 0;
  return o * (t.amount || 1);
}

function findFactoryOrderById(e) {
  return factoryManager.getOrderById(e);
}

function isLiveFactoryOrder(e) {
  return factoryManager && typeof factoryManager.isLiveOrder === "function" ? factoryManager.isLiveOrder(e) : !!(e && e.status !== "done" && e.status !== "cancelled");
}

function findCompletedFactoryOrderById(e) {
  return factoryManager.getCompletedOrderById(e);
}

function anyFactoryOrderAfter(e, r, t) {
  return factoryManager.hasOrderAfter(e, r, t);
}

function reconcileFactoryState(e) {
  if (!e || e.phase !== "refining" || !e.factoryStarted) return false;
  var r = e.factoryOrderId ? findFactoryOrderById(e.factoryOrderId) : null;
  var t = e.factoryOrderId ? isLiveFactoryOrder(r) : anyFactoryOrderAfter(e.room, e.output, e.factoryCreated || e.started);
  if (r && typeof r.progressOut === "number" && r.progressOut > (e.factoryProgressOut || 0)) {
    e.factoryProgressOut = r.progressOut;
  }
  if (t) return false;
  if (e.factoryOrderId) {
    var o = findCompletedFactoryOrderById(e.factoryOrderId);
    if (o && typeof o.progressOut === "number" && o.progressOut > (e.factoryProgressOut || 0)) {
      e.factoryProgressOut = o.progressOut;
    }
  }
  if ((!e.factoryProgressOut || e.factoryProgressOut <= 0) && e.outputBaseAtFactoryStart !== undefined && e.outputBaseAtFactoryStart !== null) {
    var a = Math.max(0, countInRoom(e.room, e.output) - e.outputBaseAtFactoryStart);
    if (a > 0) {
      e.factoryProgressOut = a;
      console.log("[MarketRefine] Inferred production for " + e.id + ": " + a + " " + e.output + " (room stock vs baseline; order history unavailable)");
    }
  }
  e.outputBaseAtFactoryStart = countInRoom(e.room, e.output);
  e.phase = "selling";
  releaseProductionState(e);
  if (e.jobId) {
    try {
      require("marketEconomics").phase(e.jobId, "delivering");
      e._phase = "delivering";
    } catch (e) {}
  }
  memoryManager.requestSave();
  return true;
}

function getInputAcquired(e, r) {
  var t = countInRoom(e.room, r.resource);
  if (r.useOwned) return Math.max(0, t);
  t = countUnreservedInput(e.room, r.resource);
  var o = typeof r.baseAvailable === "number" ? r.baseAvailable : typeof r.baseCount === "number" ? r.baseCount : 0;
  var a = t - o;
  a = a > 0 ? a : 0;
  if (r.useBatch && r.batchBuyJobId) {
    var n = marketBatchBuy.find(r.batchBuyJobId);
    var u = e.phase === "buying" || e.phase === "refining" && !e.factoryStarted;
    if (n && n.state === marketBatchBuy.STATE_DONE && u && !(marketBatchBuy.getReservationAmount(r.batchBuyJobId) > 0)) {
      marketBatchBuy.reserve(r.batchBuyJobId);
    }
    a = Math.max(a, marketBatchBuy.getReservationAmount(r.batchBuyJobId) || 0);
    if (n && n.state === marketBatchBuy.STATE_DONE) {
      a = Math.max(a, n.fulfilled || n.amount || 0);
    }
  }
  if (r.useMarketBuy) pollMarketBuyOrderId(e, r);
  return a;
}

function ensureMarketBuyOrder(e, r) {
  if (!r.useMarketBuy) return true;
  var t = getOwnBuyRecord(e, r.resource);
  var o = false;
  if (t && !t.done && !t.cancelled) {
    if (!t.orderId) o = true; else if (Game.market.orders[t.orderId]) o = true;
  }
  if (o) return true;
  var a = getInputAcquired(e, r);
  var n = Math.max(0, r.amount - a);
  if (n <= 0) return true;
  console.log("[MarketRefine] marketBuy order for " + r.resource + " in " + e.room + " is missing/cancelled (op " + e.id + "). Recreating for remaining " + n + ".");
  var u = computeCompetitiveBid(r.resource, r.maxPrice, n);
  if (u === null) {
    console.log("[MarketRefine] Cannot recreate marketBuy for " + r.resource + " in " + e.room + ": no passive bid under ceiling " + r.maxPrice.toFixed(3) + ". Falling back to opportunisticBuy.");
    r.useMarketBuy = false;
    if (t && t.orderId) marketBuyer.cancelOrderById(t.orderId, "recreate fallback", t.opId || null); else marketBuyer.cancelOrderFor(e.room, r.resource, "recreate fallback", "factory", e.id || null);
    createOpportunisticBuyForInput(e.room, r, n, e.output, e.id, e.jobId);
    return false;
  }
  var i = callMarketBuy(e.room, r.resource, n, u, r.maxPrice, e.output, e.id, e.jobId);
  if (i.ok) {
    console.log("[MarketRefine] Recreated marketBuy for " + r.resource + " in " + e.room + ": " + n + " @ " + u.toFixed(3) + " (ceiling " + r.maxPrice.toFixed(3) + ")");
    r.marketBuyOrderId = null;
    return true;
  }
  console.log("[MarketRefine] Failed to recreate marketBuy for " + r.resource + " in " + e.room + ": " + i.message + ". Falling back to opportunisticBuy.");
  r.useMarketBuy = false;
  if (t && t.orderId) marketBuyer.cancelOrderById(t.orderId, "recreate fallback", t.opId || null); else marketBuyer.cancelOrderFor(e.room, r.resource, "recreate fallback", "factory", e.id || null);
  createOpportunisticBuyForInput(e.room, r, n, e.output, e.id, e.jobId);
  return false;
}

function ensureOpportunisticBuyRequest(e, r) {
  if (r.useMarketBuy || r.useMarketSell) return true;
  var t = getInputAcquired(e, r);
  var o = Math.max(0, r.amount - t);
  if (o <= 0 || hasActiveOpBuyRequest(e.room, r.resource, e.id)) return true;
  console.log("[MarketRefine] opportunisticBuy request for " + r.resource + " in " + e.room + " is missing (op " + e.id + "). Recreating for remaining " + o + ".");
  return createOpportunisticBuyForInput(e.room, r, o, e.output, e.id, e.jobId);
}

function expireOp(e, r) {
  var t = Game.time - e.started;
  var o = r || "Expired after " + t + " ticks (phase=" + e.phase + ")";
  var a = [];
  var n = [];
  var u = pricing.breakEvenInputCeilings(e.output);
  releaseBatchReservations(e, "marketRefine expiry/sell-back");
  if (e.inputs && e.inputs.length > 0) {
    for (var i = 0; i < e.inputs.length; i++) {
      var s = e.inputs[i];
      var c = s.useMarketSell || shouldUseMarketSell(e.output, s.resource);
      if (c) {} else if (s.useMarketBuy) {
        var f = pollMarketBuyOrderId(e, s);
        var l = f ? f.opId || null : e.id || null;
        var d = u ? u[s.resource] : null;
        var m = s.marketBuyOrderId ? Game.market.orders[s.marketBuyOrderId] : null;
        var p = typeof d !== "number" || !(d > 0) || m && m.price > d;
        if (s.marketBuyOrderId) {
          if (p) {
            marketBuyer.cancelOrderById(s.marketBuyOrderId, "op expiry, break-even dead", l);
            console.log("[MarketRefine] Cancelled marketBuy order " + s.marketBuyOrderId + " (break-even dead) for " + s.resource + " in " + e.room);
          } else {
            marketBuyer.passivateOrder(s.marketBuyOrderId, e.output);
            console.log("[MarketRefine] Passivated marketBuy order " + s.marketBuyOrderId + " (break-even viable) for " + s.resource + " in " + e.room);
          }
        } else {
          marketBuyer.cancelOrderFor(e.room, s.resource, "op expiry, no captured id", "factory", l);
        }
      } else if (s.useBatch && s.batchBuyJobId) {
        marketBatchBuy.cancel(s.batchBuyJobId, "factory operation expired");
      } else {
        if (hasActiveOpBuyRequest(e.room, s.resource, e.id)) {
          cancelOpBuyRequest(e.room, s.resource, e.id);
        }
      }
      var R = countInRoom(e.room, s.resource);
      var y = typeof s.baseCount === "number" ? s.baseCount : 0;
      var O = R - y;
      if (O > 0) {
        var v = callMarketSell(e.room, s.resource, O);
        if (marketSellAccepted(v)) a.push(O + " " + s.resource); else n.push(s.resource + ": " + v);
      }
    }
  } else {
    var g = e.input;
    if (g && g !== "(multi)") {
      var E = shouldUseMarketSell(e.output, g);
      if (!E && !e.useMarketBuy) {
        if (hasActiveOpBuyRequest(e.room, g, e.id)) {
          cancelOpBuyRequest(e.room, g, e.id);
        }
      } else if (e.useMarketBuy) {
        marketBuyer.cancelOrderFor(e.room, g, "legacy op expiry", "factory", null);
      }
      var h = countInRoom(e.room, g);
      var I = typeof e.baseInputCount === "number" ? e.baseInputCount : 0;
      var k = h - I;
      if (k > 0) {
        var M = callMarketSell(e.room, g, k);
        if (marketSellAccepted(M)) a.push(k + " " + g); else n.push(g + ": " + M);
      }
    }
  }
  var B = a.length > 0 ? "Selling acquired inputs: " + a.join(", ") : "No acquired inputs to sell";
  if (n.length > 0) B += " | marketSell refused: " + n.join("; ");
  failOp(e, o, B);
}

var startMarketRefine = global.marketRefine = function(e, r, t, o) {
  var a = o && o.jobId ? o.jobId : null;
  ensureMemory();
  getRoomState.init();
  if (typeof e !== "string" || !e) {
    return "[MarketRefine] Provide a valid room name.";
  }
  if (!roomOwned(e)) {
    return "[MarketRefine] Room not owned or not visible: " + e;
  }
  if (!roomHasTerminal(e)) {
    return "[MarketRefine] Room " + e + " has no terminal.";
  }
  var n = normalizeOutput(r);
  if (Memory.marketRefine && Array.isArray(Memory.marketRefine.ops)) {
    for (var u = 0; u < Memory.marketRefine.ops.length; u++) {
      var i = Memory.marketRefine.ops[u];
      if (i && i.room === e && i.output === n && i.phase !== "selling" && i.phase !== "done" && i.phase !== "error" && i.phase !== "failed") {
        reconcileFactoryState(i);
        if (i.phase === "selling") continue;
        return "[MarketRefine] " + n + " is already active in " + e + " (" + (i.phase || "unknown") + ").";
      }
    }
  }
  var s = factorySlots.refusal(e, "MarketRefine");
  if (s) return s;
  if (n === RESOURCE_BATTERY) {
    return "[MarketRefine] Refused battery production: marketRefine does not acquire energy. Use localRefine with local energy.";
  }
  var c = getRecipeInputs(n);
  if (!c || c.length === 0) {
    return "[MarketRefine] Unsupported output: " + r + ". Must be a valid COMMODITIES product or compressed resource.";
  }
  var f = "mref_" + e + "_" + n + "_" + Game.time;
  var l = !!(o && o.batchMode);
  var d = o && o.handoff ? o.handoff : null;
  var m = o && o.handoffInput ? o.handoffInput : null;
  var p = {};
  if (l && Array.isArray(o.batchPurchases)) {
    for (var R = 0; R < o.batchPurchases.length; R++) {
      var y = o.batchPurchases[R];
      if (y && y.resource) p[y.resource] = y;
    }
  }
  var O = o && o.batchInputAmounts || {};
  var v = [];
  for (var g = 0; g < c.length; g++) {
    var E = c[g];
    var h = p[E.resource];
    var I = l && O[E.resource] > 0 ? Math.floor(O[E.resource]) : E.amount;
    var k = t && typeof t[E.resource] === "number" ? t[E.resource] : computeCeiling(E.resource);
    if (!(typeof k === "number" && isFinite(k) && k > 0)) {
      return "[MarketRefine] No canonical BUY-side price is available for " + E.resource + "; provide an explicit max price or wait for market/theoretical data.";
    }
    if (l && !h) {
      return "[MarketRefine] Batch plan is missing a purchase for " + E.resource + ".";
    }
    var M = d || m;
    var B = !!(m && m.resource === E.resource);
    var S = !B && shouldUseMarketSell(n, E.resource);
    var b = !B && !h && !S && shouldUseMarketBuy(n, E.resource, k, I);
    if (!S && !b && hasActiveOpBuyRequest(e, E.resource)) {
      return "[MarketRefine] ERROR: Active opportunisticBuy request already exists for " + E.resource + " in " + e + ". Cancel it first or wait for completion.";
    }
    v.push({
      resource: E.resource,
      amount: I,
      ceiling: k,
      useMS: S,
      useMB: b,
      useOwned: B,
      useBatch: !!h,
      batchPurchase: h || null
    });
  }
  var T = [];
  var U = [];
  var _ = [];
  for (var C = 0; C < v.length; C++) {
    var A = v[C];
    var P = countInRoom(e, A.resource);
    var F = countUnreservedInput(e, A.resource);
    var L = {
      resource: A.resource,
      amount: A.amount,
      maxPrice: A.ceiling,
      useOwned: false,
      baseCount: P,
      baseAvailable: F,
      useMarketSell: A.useMS,
      useMarketBuy: A.useMB,
      useBatch: A.useBatch,
      batchBuyJobId: null,
      marketBuyOrderId: null
    };
    if (A.useOwned) {
      L.useOwned = true;
      L.handoffReservationProgram = o && o.handoffReservationProgram || null;
      L.handoffResource = A.resource;
      L.handoffAmount = A.amount;
      _.push(A.resource + " x" + A.amount + " (via chained handoff)");
    } else if (A.useBatch) {
      var q = A.batchPurchase;
      if (typeof marketBuyer.cancelOrdersForProduct === "function") {
        marketBuyer.cancelOrdersForProduct(e, A.resource, n, "direct batch purchase superseded managed buy", "factory");
      }
      var N = marketBatchBuy.create({
        roomName: e,
        resourceType: A.resource,
        amount: A.amount,
        orderId: q.orderId,
        orderRoomName: q.orderRoomName,
        orderPrice: q.orderPrice,
        maxPrice: q.maxPrice || q.orderPrice,
        energyCost: q.energyCost,
        energyPrice: q.energyPrice,
        queue: "factory",
        ownerId: f,
        economicsJobId: a || null
      });
      if (!N.ok) {
        cancelInputProcurement(e, T, f, "op aborted: batch setup failed");
        memoryManager.requestSave();
        return "[MarketRefine] Aborted " + n + " in " + e + ": failed to create batch purchase for " + A.resource + ". " + N.reason;
      }
      L.batchBuyJobId = N.id;
      U.push(N.id);
      _.push(A.resource + " x" + A.amount + " @" + q.orderPrice.toFixed(3) + " (via batch)");
    } else if (A.useMS) {
      cancelInputProcurement(e, T, f, "op aborted: local energy required");
      memoryManager.requestSave();
      return "[MarketRefine] Refused energy acquisition for " + n + ". Use localRefine with local energy.";
    } else if (A.useMB) {
      var x = computeCompetitiveBid(A.resource, A.ceiling, A.amount);
      L.bidPrice = x;
      if (x === null) {
        cancelInputProcurement(e, T, f, "op aborted: passive bid unavailable");
        memoryManager.requestSave();
        return "[MarketRefine] Refused " + n + " in " + e + ": no passive bid for " + A.resource + " under ceiling " + A.ceiling.toFixed(3) + " (no profitable bid available).";
      }
      var G = callMarketBuy(e, A.resource, A.amount, x, A.ceiling, n, f, a);
      if (G.ok) {
        _.push(A.resource + " x" + A.amount + " @" + x.toFixed(3) + " (via marketBuy, ceiling " + A.ceiling.toFixed(3) + ", id pending)");
      } else if (("" + G.message).indexOf("already exists") >= 0) {
        cancelInputProcurement(e, T, f, "op aborted: input conflict");
        memoryManager.requestSave();
        return "[MarketRefine] Aborted " + n + " in " + e + ": live marketBuy order already exists for " + A.resource + ". Will retry once it clears. (" + G.message + ")";
      } else {
        console.log("[MarketRefine] marketBuy failed for " + A.resource + ", falling back to opportunisticBuy: " + G.message);
        L.useMarketBuy = false;
        if (!createOpportunisticBuyForInput(e, L, A.amount, n, f, a)) {
          cancelInputProcurement(e, T, f, "op aborted: opportunistic setup failed");
          memoryManager.requestSave();
          return "[MarketRefine] Aborted " + n + " in " + e + ": failed to create opportunisticBuy for " + A.resource + ".";
        }
        _.push(A.resource + " x" + A.amount + " @" + A.ceiling.toFixed(3) + " (fallback opportunistic)");
      }
    } else {
      if (!createOpportunisticBuyForInput(e, L, A.amount, n, f, a)) {
        cancelInputProcurement(e, T, f, "op aborted: opportunistic setup failed");
        memoryManager.requestSave();
        return "[MarketRefine] Aborted " + n + " in " + e + ": failed to create opportunisticBuy for " + A.resource + ".";
      }
      _.push(A.resource + " x" + A.amount + " @" + A.ceiling.toFixed(3));
    }
    T.push(L);
  }
  var Y = countInRoom(e, n);
  var D = targetOutputForInputs(n, T);
  if (D <= 0) {
    cancelInputProcurement(e, T, f, "op aborted: incomplete recipe batch");
    memoryManager.requestSave();
    return "[MarketRefine] ERROR: Acquired recipe quantities do not form a complete batch of " + n + ".";
  }
  var j = {
    id: f,
    room: e,
    handoff: !!d,
    handoffResource: M && M.resource || null,
    handoffAmount: M && M.amount || 0,
    handoffInput: !!m,
    handoffReservationProgram: o && o.handoffReservationProgram || null,
    output: n,
    inputs: T,
    baseOutputCount: Y,
    phase: "buying",
    started: Game.time,
    targetOutput: D,
    jobId: a,
    batchMode: l,
    batchBuyIds: U
  };
  Memory.marketRefine.ops.push(memoryManager.compactMarketRefineOperation(j));
  memoryManager.requestSave();
  return "[MarketRefine] Started " + f + " | buying: " + _.join(", ") + " -> refine " + D + " " + n + " -> sell.";
};
global.marketRefineStatus = function(e) {
  ensureMemory();
  var r = Memory.marketRefine.ops;
  if (!r || r.length === 0) return "[MarketRefine] No ops.";
  if (e) {
    for (var t = 0; t < r.length; t++) {
      var o = r[t];
      if (o && o.id === e) {
        var a = [];
        a.push("[" + o.id + "] room=" + o.room + " phase=" + o.phase);
        var n = Game.time - (o.started || 0);
        var u = OP_EXPIRY_TICKS - n;
        a.push("  age=" + n + " ticks" + (o.phase === "buying" ? " | expires in " + (u > 0 ? u : 0) + " ticks" : " | no expiry (inputs acquired)"));
        if (o.inputs && o.inputs.length > 0) {
          for (var i = 0; i < o.inputs.length; i++) {
            var s = o.inputs[i];
            var c = getInputAcquired(o, s);
            var f = "";
            if (s.useMarketBuy) {
              var l = getOwnBuyRecord(o, s.resource);
              if (l && l.orderId) {
                var d = Game.market.orders[l.orderId];
                if (l.done) f = " [order DONE " + (l.fulfilledFinal || 0) + "/" + l.target + "]"; else if (l.cancelled) f = " [order CANCELLED " + (l.fulfilledFinal || 0) + "/" + l.target + "]"; else if (d) f = " [orderFill=" + marketBuyer.getFulfilled(l) + "/" + l.target + " rem=" + util.getOrderRemaining(d) + " cap=" + l.trancheTotal + (l.passive ? " PASSIVE" : "") + "]"; else f = " [order missing]";
              } else if (l) {
                f = " [order id pending]";
              } else {
                f = " [no managed order]";
              }
            }
            var m = s.useMarketSell ? " (via marketSell)" : s.useMarketBuy ? " (via marketBuy)" : "";
            a.push("  input: " + s.resource + " target=" + s.amount + " price=" + s.maxPrice + " acquired=" + c + " current=" + countInRoom(o.room, s.resource) + m + f);
          }
        } else {
          a.push("  input: " + o.input + " target=" + o.targetBuy + " price=" + o.price);
          a.push("  baseInput=" + (o.baseInputCount || 0) + " currentInput=" + countInRoom(o.room, o.input));
        }
        a.push("  output: " + o.output + (o.factoryOrderId ? " orderId=" + o.factoryOrderId : ""));
        a.push("  baseOutput=" + o.baseOutputCount + " currentOutput=" + countInRoom(o.room, o.output));
        if (o.failReason) {
          a.push("  FAILURE: " + o.failReason + " (tick " + (o.failTick || "?") + ")");
        }
        return a.join("\n");
      }
    }
    return "[MarketRefine] Op not found: " + e;
  }
  var p = [];
  for (var R = 0; R < r.length; R++) {
    var y = r[R];
    if (!y) continue;
    var O = Game.time - (y.started || 0);
    var v = OP_EXPIRY_TICKS - O;
    var g = y.phase === "buying" ? " age=" + O + (v < 1e4 ? " EXPIRES IN " + Math.max(0, v) : "") : " age=" + O;
    var E = y.phase === "failed" ? " FAILED: " + (y.failReason || "?") : "";
    if (y.inputs && y.inputs.length > 0) {
      var h = [];
      for (var I = 0; I < y.inputs.length; I++) {
        h.push(y.inputs[I].resource + (y.inputs[I].useMarketBuy ? "*" : ""));
      }
      p.push("[" + y.id + "] " + y.room + " " + h.join("+") + " -> " + y.output + " | phase=" + y.phase + g + E);
    } else {
      p.push("[" + y.id + "] " + y.room + " " + y.input + " -> " + y.output + " | phase=" + y.phase + g + E);
    }
  }
  p.push("(* = via marketBuy standing order)");
  return p.join("\n");
};
global.marketRefineOutcomes = function(e, r) {
  ensureMemory();
  var t = Memory.marketRefine.outcomes;
  if (!t || t.length === 0) return "[MarketRefine] No recorded outcomes yet.";
  var o = null, a = 20;
  if (typeof e === "string") o = e; else if (typeof e === "number") a = e;
  if (typeof r === "number") a = r;
  var n = t;
  if (o) n = n.filter(function(e) {
    return e.room === o;
  });
  if (n.length === 0) return "[MarketRefine] No recorded outcomes" + (o ? " for " + o : "") + ".";
  var u = n.slice(-a);
  var i = [ "[MarketRefine] Last " + u.length + " of " + n.length + " outcome(s):", "" ];
  for (var s = 0; s < u.length; s++) {
    var c = u[s];
    var f = Game.time - c.tick;
    var l = c.status === "failed" ? "FAILED" : c.status === "cancelled" ? "CANCELLED" : "done";
    var d = c.reason ? " - " + c.reason : "";
    i.push("  [" + f + " ticks ago] " + l + ": " + c.output + " in " + c.room + d);
  }
  return i.join("\n");
};
global.cancelMarketRefine = function(e) {
  ensureMemory();
  var r = Memory.marketRefine.ops;
  for (var t = 0; t < r.length; t++) {
    var o = r[t];
    if (o && o.id === e) {
      if (o.phase === "buying") {
        expireOp(o, "Cancelled by console command");
        r.splice(t, 1);
        return "[MarketRefine] Cancelled op " + e + " and listed acquired inputs.";
      }
      var a = o.outputBaseAtFactoryStart !== null && o.outputBaseAtFactoryStart !== undefined ? o.outputBaseAtFactoryStart : o.baseOutputCount || 0;
      var n = countInRoom(o.room, o.output) - a;
      if (n > 0) {
        var u = callMarketSell(o.room, o.output, n, undefined, o.jobId ? {
          jobId: o.jobId
        } : null);
        if (!marketSellAccepted(u)) {
          return "[MarketRefine] Could not safely cancel " + e + ": produced output could not be listed: " + u;
        }
      }
      if (o.factoryOrderId && typeof global.cancelFactoryOrder === "function") {
        global.cancelFactoryOrder(o.factoryOrderId);
      }
      if (o.inputs && o.inputs.length > 0) {
        for (var i = 0; i < o.inputs.length; i++) {
          var s = o.inputs[i];
          if (s.useMarketBuy) {
            var c = pollMarketBuyOrderId(o, s);
            var f = c ? c.opId || null : o.id || null;
            if (s.marketBuyOrderId) marketBuyer.cancelOrderById(s.marketBuyOrderId, "op cancelled", f); else marketBuyer.cancelOrderFor(o.room, s.resource, "op cancelled", "factory", f);
          } else if (s.useBatch && s.batchBuyJobId) {
            marketBatchBuy.releaseReservation(s.batchBuyJobId, "marketRefine cancellation");
          } else if (!s.useMarketSell && hasActiveOpBuyRequest(o.room, s.resource, o.id)) {
            cancelOpBuyRequest(o.room, s.resource, o.id);
          }
        }
      }
      recordOutcome(o, "cancelled", "Cancelled by console command");
      r.splice(t, 1);
      return "[MarketRefine] Cancelled op " + e + " and linked factory/buy work.";
    }
  }
  return "[MarketRefine] Op not found: " + e;
};
global.cancelLastMarketRefine = function() {
  ensureMemory();
  var e = Memory.marketRefine.ops;
  if (!e || e.length === 0) return "[MarketRefine] No ops to cancel.";
  var r = e[e.length - 1];
  var t = r && r.id ? r.id : null;
  if (!t) return "[MarketRefine] Last op missing id.";
  return cancelMarketRefine(t);
};
var abortMarketRefine = global.abortMarketRefine = function(e, r) {
  ensureMemory();
  var t = Memory.marketRefine.ops;
  for (var o = t.length - 1; o >= 0; o--) {
    var a = t[o];
    if (!a) continue;
    var n = r === undefined ? a.id === e : a.room === e && a.output === r;
    if (!n) continue;
    if (a.phase !== "buying") {
      return "[MarketRefine] " + a.id + " not in buying phase (phase=" + a.phase + "); not aborted.";
    }
    expireOp(a, "Aborted: no longer profitable (break-even failed)");
    t.splice(o, 1);
    return "[MarketRefine] Aborted " + a.id + " (cancelled/passivated buys, sold back acquired inputs).";
  }
  return "[MarketRefine] No matching buying op to abort.";
};
global.marketRefineDebugOpBuy = function() {
  return "[marketRefine] opportunisticBuy methods: " + opBuyMethodsString();
};
global.marketRefineShouldUseMarketBuy = shouldUseMarketBuy;
global.marketRefineComputeBidPrice = computeCompetitiveBid;
global.marketRefineDebugBuyDecision = function(e, r, t) {
  var o = pricing.getBook(r);
  var a = pricing.getPriceProfile(r);
  var n = marketBuyer.computePassiveBuyPrice(RESOURCE_ENERGY);
  var u = a && a.marketPrice !== null ? a.marketPrice : t;
  var i = shouldUseMarketBuy(null, r, t);
  var s = computeCompetitiveBid(r, t);
  var c = MARKET_BUY_FORCE_LIST[r] ? " [FORCED]" : "";
  return "[marketRefine debug] " + r + " | energyBuy=" + (typeof n === "number" ? n.toFixed(3) : String(n)) + " | value=" + (typeof u === "number" ? u.toFixed(3) : String(u)) + " | bestBid=" + (o.bestBid === null ? "null" : o.bestBid.toFixed(3)) + " | bestAsk=" + (o.bestAsk === null ? "null" : o.bestAsk.toFixed(3)) + " | range7d=" + pricing.getRange7d(r) + " | trend7d=" + pricing.getTrend7d(r) + " | useMarketBuy=" + i + c + " | bidPrice=" + (typeof s === "number" ? s.toFixed(3) : String(s));
};
global.marketRefineForceList = function(e, r) {
  if (!e) {
    var t = [];
    for (var o in MARKET_BUY_FORCE_LIST) {
      if (MARKET_BUY_FORCE_LIST.hasOwnProperty(o) && MARKET_BUY_FORCE_LIST[o]) t.push(o);
    }
    return "[marketRefine forceList] " + (t.length ? t.join(", ") : "(empty)");
  }
  if (e === "reset") {
    delete MARKET_BUY_FORCE_LIST[RESOURCE_BIOMASS];
    delete MARKET_BUY_FORCE_LIST[RESOURCE_METAL];
    delete MARKET_BUY_FORCE_LIST[RESOURCE_SILICON];
    delete MARKET_BUY_FORCE_LIST[RESOURCE_MIST];
    MARKET_BUY_FORCE_LIST[RESOURCE_BIOMASS] = true;
    MARKET_BUY_FORCE_LIST[RESOURCE_METAL] = true;
    MARKET_BUY_FORCE_LIST[RESOURCE_SILICON] = true;
    MARKET_BUY_FORCE_LIST[RESOURCE_MIST] = true;
    return "[marketRefine forceList] reset to defaults: biomass, metal, silicon, mist";
  }
  if (!r) return '[marketRefine forceList] Usage: action="add"|"remove"|"reset", resource=RESOURCE_X';
  if (e === "add") {
    MARKET_BUY_FORCE_LIST[r] = true;
    return "[marketRefine forceList] added " + r;
  }
  if (e === "remove") {
    delete MARKET_BUY_FORCE_LIST[r];
    return "[marketRefine forceList] removed " + r;
  }
  return "[marketRefine forceList] Unknown action: " + e + ". Use add|remove|reset";
};
global.cancelAllMarketRefine = function() {
  if (!Memory.marketRefine || !Array.isArray(Memory.marketRefine.ops)) {
    return "[MarketRefine] Nothing to cancel.";
  }
  var e = Memory.marketRefine.ops.map(function(e) {
    return e ? e.id : null;
  });
  var r = [];
  for (var t = 0; t < e.length; t++) {
    var o = null, a = null;
    for (var n = 0; n < Memory.marketRefine.ops.length; n++) {
      if (Memory.marketRefine.ops[n] && Memory.marketRefine.ops[n].id === e[t]) {
        o = Memory.marketRefine.ops[n];
        a = o.phase;
        break;
      }
    }
    if (!o) continue;
    if (a === "buying") r.push(abortMarketRefine(o.id)); else r.push(cancelMarketRefine(o.id));
  }
  return r.length ? r.join("\n") : "[MarketRefine] No ops cancelled.";
};
function run(e) {
  ensureMemory();
  getRoomState.init();
  var r = Memory.marketRefine.ops;
  var t = typeof e === "number" && isFinite(e);
  var o = t ? Game.cpu.getUsed() + Math.max(0, e) : null;
  var a = null;
  var n = t ? 0 : r.length - 1;
  var u = 0;
  if (t) {
    a = [];
    for (var i = r.length - 1; i >= 0; i--) {
      if (r[i]) a.push({
        id: r[i].id || null,
        ref: r[i]
      });
    }
    var s = Memory.marketRefine.scheduler;
    if (s.nextOpId) {
      for (var c = 0; c < a.length; c++) {
        if (a[c].id === s.nextOpId) {
          n = c;
          break;
        }
      }
    }
  }
  while (t ? n < a.length : n >= 0) {
    if (t && u > 0 && Game.cpu.getUsed() >= o) break;
    var f = t ? a[n++] : null;
    var l = t ? r.indexOf(f.ref) : n--;
    if (t && l < 0) continue;
    if (t) {
      var d = a.length > 0 ? a[n % a.length] : null;
      Memory.marketRefine.scheduler.nextOpId = d && d.id ? d.id : null;
    }
    u++;
    var m = r[l];
    if (!m) {
      r.splice(l, 1);
      continue;
    }
    if (m.phase === "done" || m.phase === "error" || m.phase === "failed") {
      if (m.phase === "error" && !m._outcomeRecorded) {
        recordOutcome(m, "failed", m.failReason || "error");
      }
      r.splice(l, 1);
      continue;
    }
    if (m.phase === "buying") {
      if (m.jobId && m._phase !== "buying") {
        try {
          require("marketEconomics").phase(m.jobId, "buying");
          m._phase = "buying";
        } catch (e) {}
      }
      var p = true;
      if (m.inputs && m.inputs.length > 0) {
        for (var R = 0; R < m.inputs.length; R++) {
          var y = m.inputs[R];
          if (y.useOwned) {
            if (countInRoom(m.room, y.resource) < y.amount) p = false;
          } else if (y.useBatch) {
            var O = y.batchBuyJobId ? marketBatchBuy.find(y.batchBuyJobId) : null;
            if (!O) {
              failOp(m, "Batch purchase missing", y.resource + " has no batch job");
              p = false;
              break;
            }
            if (O.state === marketBatchBuy.STATE_FAILED || O.state === marketBatchBuy.STATE_CANCELLED) {
              failOp(m, "Batch purchase failed", y.resource + ": " + (O.reason || O.state));
              p = false;
              break;
            }
            if (O.state === marketBatchBuy.STATE_DONE && O.fulfilled > 0 && O.fulfilled < (O.requestedAmount || O.amount)) {
              ensureOpportunisticBuyRequest(m, y);
            }
          } else if (y.useMarketBuy) ensureMarketBuyOrder(m, y); else ensureOpportunisticBuyRequest(m, y);
          var v = getInputAcquired(m, y);
          if (v < y.amount) {
            p = false;
          }
        }
      } else {
        var g = countUnreservedInput(m.room, m.input);
        var E = g - (m.baseInputCount || 0);
        if (E < 0) E = 0;
        if (E < m.targetBuy) {
          p = false;
        }
      }
      if (p) {
        if (m.inputs && m.inputs.length > 0) {
          for (var h = 0; h < m.inputs.length; h++) {
            var I = m.inputs[h];
            if (I.useMarketBuy) {
              marketBuyer.cancelOrderFor(m.room, I.resource, "target acquired", "factory", m.id);
            } else if (I.useOwned) {
              if (I.handoffReservationProgram) {
                storageManager.unReserve(m.room, I.resource, "terminal", I.handoffReservationProgram);
                storageManager.unReserve(m.room, I.resource, "storage", I.handoffReservationProgram);
              }
            } else if (I.useBatch) {} else if (hasActiveOpBuyRequest(m.room, I.resource, m.id)) {
              cancelOpBuyRequest(m.room, I.resource, m.id);
            }
          }
        }
        m.phase = "refining";
        if (m.jobId) try {
          require("marketEconomics").phase(m.jobId, "producing");
          m._phase = "producing";
        } catch (e) {}
        memoryManager.requestSave();
        continue;
      }
      var k = Game.time - (m.started || 0);
      if (k > OP_EXPIRY_TICKS) {
        expireOp(m);
        r.splice(l, 1);
        continue;
      }
      continue;
    }
    if (m.phase === "refining") {
      if (!m.factoryStarted) {
        if (m.factoryRetryTick && Game.time < m.factoryRetryTick) continue;
        if (m.inputs && m.inputs.length > 0) {
          var M = true;
          for (var B = 0; B < m.inputs.length; B++) {
            if (m.inputs[B].useOwned) {
              if (countInRoom(m.room, m.inputs[B].resource) < m.inputs[B].amount) {
                M = false;
                break;
              }
              continue;
            }
            if (getInputAcquired(m, m.inputs[B]) < m.inputs[B].amount) {
              M = false;
              break;
            }
          }
          if (!M) {
            m.phase = "buying";
            memoryManager.requestSave();
            continue;
          }
        }
        if (!(m.targetOutput > 0)) {
          m.targetOutput = targetOutputForInputs(m.output, m.inputs || []);
          if (!(m.targetOutput > 0)) {
            failOp(m, "Cannot determine exact factory target", "Legacy operation has no complete-batch target");
            continue;
          }
        }
        var S = releaseBatchReservations(m, "factory reservation handoff");
        if (m.handoffReservationProgram && m.handoffResource) {
          storageManager.unReserve(m.room, m.handoffResource, "terminal", m.handoffReservationProgram);
          storageManager.unReserve(m.room, m.handoffResource, "storage", m.handoffReservationProgram);
        }
        var b;
        try {
          b = startFactoryOrder(m.room, m.output, m.targetOutput);
        } catch (e) {
          if (S) restoreBatchReservations(m);
          throw e;
        }
        var T = typeof b.message === "string" ? b.message : "";
        if (T.indexOf("Insufficient unreserved inputs") >= 0) {
          if (S) restoreBatchReservations(m);
          m.phase = "buying";
          m.factoryRetryTick = Game.time + 10;
          console.log("[MarketRefine] Factory inputs became reserved for " + m.id + "; returning to buying.");
          memoryManager.requestSave();
          continue;
        }
        if (T.indexOf("REFUSED") >= 0 || T.indexOf("Unknown") >= 0 || T.indexOf("unsupported") >= 0) {
          failOp(m, "Factory refused order", T);
          var U = [];
          if (m.inputs && m.inputs.length > 0) {
            for (var _ = 0; _ < m.inputs.length; _++) {
              var C = m.inputs[_];
              var A = countInRoom(m.room, C.resource);
              var P = typeof C.baseCount === "number" ? C.baseCount : 0;
              var F = A - P;
              if (F > 0) {
                var L = callMarketSell(m.room, C.resource, F);
                if (marketSellAccepted(L)) U.push(F + " " + C.resource); else console.log("[MarketRefine] marketSell refused sell-back for " + C.resource + ": " + L);
              }
            }
          }
          if (U.length > 0) {
            console.log("[MarketRefine] Selling back inputs for failed op " + m.id + ": " + U.join(", "));
          }
          continue;
        }
        if (T.indexOf("ERROR") >= 0) {
          failOp(m, "Factory order error", T);
          continue;
        }
        if (T.indexOf("Order accepted") < 0) {
          failOp(m, "Factory order was not accepted", T || "Empty factory response");
          continue;
        }
        m.factoryOrderId = b.orderId || null;
        if (m.jobId && m.factoryOrderId) {
          factoryManager.annotateOrder(m.factoryOrderId, {
            jobId: m.jobId
          });
        }
        m.factoryCreated = Game.time;
        m.factoryStarted = true;
        delete m.factoryRetryTick;
        m.outputBaseAtFactoryStart = countInRoom(m.room, m.output);
        m.factoryProgressOut = 0;
        if (m.jobId) {
          try {
            var q = require("marketEconomics");
            q.link(m.jobId, "factory", m.factoryOrderId);
            if (m._phase !== "producing") q.phase(m.jobId, "producing");
            m._phase = "producing";
          } catch (e) {}
        }
        memoryManager.requestSave();
        continue;
      }
      reconcileFactoryState(m);
      continue;
    }
    if (m.phase === "selling") {
      releaseProductionState(m);
      if (m.handoff && m.handoffResource && m.handoffAmount > 0) {
        var N = Game.rooms[m.room];
        if (!N) continue;
        var x = N && (N.terminal && N.terminal.store[m.handoffResource] || 0) + (N.storage && N.storage.store[m.handoffResource] || 0);
        if (x < m.handoffAmount) continue;
        m.phase = "done";
        recordOutcome(m, "done", "handoff ready: " + m.handoffAmount + " " + m.handoffResource);
        continue;
      }
      if (m.nextSellTick && Game.time < m.nextSellTick) continue;
      var G = countInRoom(m.room, m.output);
      var Y = m.outputBaseAtFactoryStart !== null && m.outputBaseAtFactoryStart !== undefined ? m.outputBaseAtFactoryStart : m.baseOutputCount;
      var D = typeof m.factoryProgressOut === "number" ? m.factoryProgressOut : 0;
      if (D <= 0 && m.factoryOrderId) {
        var j = findCompletedFactoryOrderById(m.factoryOrderId);
        if (j && typeof j.progressOut === "number") D = j.progressOut;
      }
      if (D <= 0) {
        var K = Math.max(0, G - Y);
        if (K > 0) {
          D = K;
          console.log("[MarketRefine] Recovered production for " + m.id + ": " + K + " " + m.output + " (physical stock vs baseline; progress tracking lost)");
        }
      }
      if (D <= 0) {
        var w = G - Y;
        failOp(m, "No output produced", "Expected " + m.output + " in " + m.room + " but produced=" + D + " delta=" + w + " (current=" + G + ", base=" + Y + ")");
        continue;
      }
      var H = D;
      if (H <= 0) {
        failOp(m, "No output produced", "Expected " + m.output + " in " + m.room + " but produced=" + D + " current=" + G + " base=" + Y);
        continue;
      }
      if (m.sellPosted) {
        var J = m.sellAmount || H;
        var X = false;
        if (!m.sellOrderId) recoverLegacySellOrder(m, J);
        var Z = Game.time - (m.sellPostedTick || m.started || Game.time);
        if (Z >= STALE_SELLING_TICKS && !hasOwnedSellLot(m.jobId)) {
          failOp(m, "Stale selling operation", "no economics-owned sell lot or reliable order link after " + Z + " ticks");
          continue;
        }
        var V = 0;
        if (m.sellOrderId && Game.market && Game.market.orders && Game.market.orders[m.sellOrderId]) {
          var W = util.getOrderRemaining(Game.market.orders[m.sellOrderId]);
          V = Math.max(0, (m.sellOrderRemainingAtPost || 0) - W);
        } else if (m.sellOrderId) {
          X = true;
          var Q = Game.market.outgoingTransactions || [];
          for (var z = 0; z < Q.length; z++) {
            var $ = Q[z];
            if (!$ || !$.order || $.order.id !== m.sellOrderId) continue;
            if (typeof $.time === "number" && $.time < (m.sellPostedTick || 0)) continue;
            V += $.amount || 0;
          }
        } else {}
        if (V >= J) {
          m.phase = "done";
          recordOutcome(m, "done", J + " " + m.output + " produced and sold");
        } else if (X) {
          var ee = Math.max(0, J - V);
          m.sellPosted = false;
          m.sellOrderId = null;
          m.sellOrderRemainingAtPost = null;
          m.sellAmount = ee;
          m.nextSellTick = Game.time + SELL_RETRY_TICKS;
          m.sellRetryCount = (m.sellRetryCount || 0) + 1;
          if (m.sellRetryCount >= 10) {
            var re = countInRoom(m.room, m.output);
            if (re <= 0) {
              failOp(m, "Sell order persistently missing and no stock remains", "retried " + m.sellRetryCount + " times; order keeps disappearing");
              continue;
            }
            m.sellAmount = re;
            m.sellRetryCount = 0;
            console.log("[MarketRefine] Reset retry counter for " + m.id + "; switching to physical stock amount (" + re + " " + m.output + ")");
          }
          console.log("[MarketRefine] Sell order disappeared for " + m.id + "; retrying " + ee + " " + m.output + " after " + V + " sold.");
          memoryManager.requestSave();
        }
        continue;
      }
      var te = pricing.passiveSellPrice(m.output);
      if (!(te > 0)) {
        m.sellAttempts = (m.sellAttempts || 0) + 1;
        m.nextSellTick = Game.time + SELL_RETRY_TICKS;
        memoryManager.requestSave();
        continue;
      }
      var oe = {
        minPrice: te
      };
      if (m.jobId) oe.jobId = m.jobId;
      var ae = callMarketSell(m.room, m.output, H, undefined, oe);
      if (marketSellAccepted(ae)) {
        m.sellPosted = true;
        m.sellAmount = H;
        m.sellPostedTick = Game.time;
        if (m.jobId) {
          try {
            var ne = require("marketEconomics");
            if (m._phase !== "selling") ne.phase(m.jobId, "selling");
            m._phase = "selling";
          } catch (e) {}
        }
        var ue = typeof ae === "string" ? ae.match(/orderId\s+([A-Za-z0-9]+)/) : null;
        if (!ue && typeof ae === "string" && ae.indexOf("extended existing") >= 0) {
          var ie = Game.market.orders || {};
          for (var se in ie) {
            var ce = ie[se];
            if (ce && ce.type === ORDER_SELL && ce.roomName === m.room && ce.resourceType === m.output && util.getOrderRemaining(ce) > 0) {
              ue = [ null, se ];
              break;
            }
          }
        }
        m.sellOrderId = ue ? ue[1] : null;
        if (!m.sellOrderId) {
          var fe = Game.market.orders || {};
          for (var le in fe) {
            var de = fe[le];
            if (de && de.type === ORDER_SELL && de.roomName === m.room && de.resourceType === m.output && util.getOrderRemaining(de) > 0) {
              m.sellOrderId = le;
              break;
            }
          }
        }
        if (m.sellOrderId && Game.market.orders[m.sellOrderId]) {
          m.sellOrderRemainingAtPost = util.getOrderRemaining(Game.market.orders[m.sellOrderId]);
        } else {
          m.sellOrderRemainingAtPost = null;
        }
        memoryManager.requestSave();
      } else {
        m.sellAttempts = (m.sellAttempts || 0) + 1;
        m.nextSellTick = Game.time + SELL_RETRY_TICKS;
        memoryManager.requestSave();
      }
      continue;
    }
  }
  if (t && r.length === 0) Memory.marketRefine.scheduler.nextOpId = null;
  if (t) memoryManager.requestSave();
}

function getOperations() {
  ensureMemory();
  const e = 5e3;
  if (Array.isArray(Memory.marketRefine.ops)) {
    Memory.marketRefine.ops = Memory.marketRefine.ops.filter(function(r) {
      if (!r) return false;
      if (r.phase === "selling" && Game.time - (r.started || Game.time) > e) {
        return false;
      }
      return true;
    });
  }
  return Memory.marketRefine.ops.map(function(e) {
    return e && typeof e === "object" ? Object.create(e) : null;
  });
}

function getSoldOutputAmount(e) {
  if (!e) return 0;
  var r = 0;
  if (e.jobId && marketEconomics && typeof marketEconomics.get === "function") {
    try {
      var t = marketEconomics.get(e.jobId);
      var o = t && t.output && t.output[e.output];
      r = o && o.sold || 0;
    } catch (e) {}
  }
  if (r > 0) return r;
  if (!e.sellPosted || !(e.sellAmount > 0)) return 0;
  if (e.sellOrderId && Game.market && Game.market.orders && Game.market.orders[e.sellOrderId]) {
    var a = util.getOrderRemaining(Game.market.orders[e.sellOrderId]);
    if (typeof e.sellOrderRemainingAtPost === "number") return Math.max(0, e.sellOrderRemainingAtPost - a);
  }
  if (e.sellOrderId) {
    var n = 0;
    var u = Game.market && Game.market.outgoingTransactions || [];
    for (var i = 0; i < u.length; i++) {
      var s = u[i];
      if (!s || !s.order || s.order.id !== e.sellOrderId) continue;
      if (typeof s.time === "number" && s.time < (e.sellPostedTick || 0)) continue;
      n += s.amount || 0;
    }
    return n;
  }
  return 0;
}

function getCommittedSaleOutputs(e) {
  var r = {};
  var t = getOperations();
  for (var o = 0; o < t.length; o++) {
    var a = t[o];
    if (!a || a.room !== e || a.phase === "done" || a.phase === "failed" || a.phase === "error" || a.phase === "cancelled") continue;
    var n = Math.max(0, (a.targetOutput || 0) - getSoldOutputAmount(a));
    if (a.handoff) n = Math.max(0, n - (a.handoffAmount || 0));
    if (n > 0) r[a.output] = (r[a.output] || 0) + n;
  }
  return r;
}

function getOperation(e) {
  if (!e) return null;
  var r = getOperations();
  for (var t = 0; t < r.length; t++) {
    if (r[t] && r[t].id === e) return r[t];
  }
  return null;
}

function getOutcome(e) {
  if (!e) return null;
  ensureMemory();
  var r = Memory.marketRefine.outcomes || [];
  for (var t = r.length - 1; t >= 0; t--) {
    if (r[t] && r[t].id === e) return r[t];
  }
  return null;
}

function getOutcomes() {
  ensureMemory();
  return (Memory.marketRefine.outcomes || []).map(function(e) {
    return e ? Object.create(e) : e;
  });
}

module.exports = {
  run: run,
  start: startMarketRefine,
  abort: abortMarketRefine,
  isForceMarketBuy: isForceMarketBuy,
  getOperations: getOperations,
  getCommittedSaleOutputs: getCommittedSaleOutputs,
  getOperation: getOperation,
  getOutcome: getOutcome,
  getOutcomes: getOutcomes
};
