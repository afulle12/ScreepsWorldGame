// LLM: Read docs/codex.js before reviewing or changing this file.
// marketPriceAdjustment.js
// Console globals: marketPriceAdjustment, marketPriceAdjustmentStatus, cancelMarketPriceAdjustment, oneTimePriceAdjustment, oneTimePriceAdjustmentStatus, cancelOneTimePriceAdjustment
// Example: marketPriceAdjustment('run') - Run automated order price adjustments
// Example: marketPriceAdjustmentStatus() - Show price adjustment configuration and status
// Example: cancelMarketPriceAdjustment() - Cancel scheduled automatic price adjustments
// Example: oneTimePriceAdjustment('orderId', 0.25) - Perform immediate single price change
// Example: oneTimePriceAdjustmentStatus() - View pending one-time price adjustments
// Example: cancelOneTimePriceAdjustment('orderId') - Cancel pending one-time price adjustment
//   marketPriceAdjustment(
//       'W1N1', 'W2N2', 'silicon', 8000,
//       { dailyIncreasePct: 0.02, maxDailyShare: 0.10,
//         ordersPerDay: 3, minSpreadPct: 0.01 }
//   )
//   marketPriceAdjustmentStatus()
//   cancelMarketPriceAdjustment()
//   oneTimePriceAdjustment('W1N1', 'W2N2', 'silicon', 1000, 0.250, 'sell')
//   oneTimePriceAdjustment('W1N1', 'W2N2', 'silicon', 1000, 0.250, 'buy')
//   oneTimePriceAdjustmentStatus()
//   cancelOneTimePriceAdjustment()
var memoryManager = require("memoryManager");
var storage = memoryManager.storage;
var pricing = require("marketPricing");
var storageManager = require("storageManager");
var terminalManager = require("terminalManager");
var creditLedger = require("creditLedger");
var autoTraderSellPolicy = require("autoTraderSellPolicy");
var labCommodityPolicy = require("labCommodityPolicy");
var util = require("util");
var DATASET = "marketPriceAdjustment";
var PROGRAM = "marketPriceAdjustment";
var VERSION = 1;
var HISTORY_DAYS = 14;
var TARGET_HISTORY_DAYS = 3;
var MAX_ORDERS_PER_DAY = 10;
var MAX_DEAL_VERIFY_CHECKS = 10;
var MAX_REBALANCE_CHECKS = 30;
var MAX_ORDER_CAPTURE_CHECKS = 10;
var MAX_ONE_TIME_ORDER_CAPTURE_CHECKS = 10;
var MAX_ONE_TIME_DEAL_VERIFY_CHECKS = 10;
var ONE_TIME_DEAL_VERIFY_TIMEOUT = 50;
var ONE_TIME_PRICE_EPSILON = .001;
var ONE_TIME_PRICE_MIN_MULTIPLIER = .5;
var ONE_TIME_PRICE_MAX_MULTIPLIER = 1.5;
var DEFAULTS = {
  dailyIncreasePct: .02,
  maxDailyShare: .1,
  ordersPerDay: 3,
  minSpreadPct: .01,
  priceJitterPct: .1
};
storage.register(DATASET, {
  path: "Memory.marketPriceAdjustment",
  owner: "marketPriceAdjustment.js",
  mutability: "mutable"
});
function finiteNumber(e) {
  return typeof e === "number" && isFinite(e);
}

function configuredSellFloor(e) {
  return autoTraderSellPolicy && typeof autoTraderSellPolicy.getFloor === "function" ? autoTraderSellPolicy.getFloor(e) : 0;
}

function applyConfiguredSellFloor(e, r) {
  if (autoTraderSellPolicy && typeof autoTraderSellPolicy.applyFloor === "function") {
    return autoTraderSellPolicy.applyFloor(e, r);
  }
  return r;
}

function utcDayKey(e) {
  return (e || new Date).toISOString().slice(0, 10);
}

function nextUtcDay(e) {
  return utcDayKey(new Date(Date.parse(e + "T00:00:00Z") + 864e5));
}

function utcMinute() {
  var e = new Date;
  return e.getUTCHours() * 60 + e.getUTCMinutes();
}

function completeHistory(e) {
  var r = utcDayKey();
  var t = Game.market.getHistory(e) || [];
  var a = [];
  for (var n = 0; n < t.length; n++) {
    var i = t[n];
    if (!i || typeof i.date !== "string" || i.date >= r) continue;
    if (!finiteNumber(i.avgPrice) || i.avgPrice <= 0) continue;
    if (!finiteNumber(i.volume) || i.volume <= 0) continue;
    a.push({
      date: i.date,
      avgPrice: i.avgPrice,
      volume: i.volume
    });
  }
  a.sort(function(e, r) {
    return e.date.localeCompare(r.date);
  });
  return a;
}

function weightedHistory(e) {
  var r = 0;
  var t = 0;
  for (var a = 0; a < e.length; a++) {
    r += e[a].volume;
    t += e[a].avgPrice * e[a].volume;
  }
  return {
    volume: r,
    average: r > 0 ? t / r : null
  };
}

function averageVolume(e) {
  if (!e.length) return null;
  var r = 0;
  for (var t = 0; t < e.length; t++) r += e[t].volume;
  return r / e.length;
}

function normalizeOptions(e) {
  e = e || {};
  var r = {
    dailyIncreasePct: DEFAULTS.dailyIncreasePct,
    maxDailyShare: DEFAULTS.maxDailyShare,
    ordersPerDay: DEFAULTS.ordersPerDay,
    minSpreadPct: DEFAULTS.minSpreadPct,
    priceJitterPct: DEFAULTS.priceJitterPct
  };
  if (finiteNumber(e.dailyIncreasePct)) {
    r.dailyIncreasePct = Math.max(.01, Math.min(.05, e.dailyIncreasePct));
  }
  if (finiteNumber(e.maxDailyShare)) {
    r.maxDailyShare = Math.max(.001, Math.min(1, e.maxDailyShare));
  }
  if (finiteNumber(e.ordersPerDay)) {
    r.ordersPerDay = Math.max(1, Math.min(MAX_ORDERS_PER_DAY, Math.floor(e.ordersPerDay)));
  }
  if (finiteNumber(e.minSpreadPct)) {
    r.minSpreadPct = Math.max(0, Math.min(.25, e.minSpreadPct));
  }
  if (finiteNumber(e.priceJitterPct)) {
    r.priceJitterPct = Math.max(0, Math.min(.1, e.priceJitterPct));
  }
  return r;
}

function ensureMemory() {
  var e = storage.ensure(DATASET, function() {
    return {
      v: VERSION,
      nextId: 1,
      operation: null,
      oneTimeOperation: null
    };
  });
  if (typeof e.v !== "number") e.v = VERSION;
  if (typeof e.nextId !== "number" || e.nextId < 1) e.nextId = 1;
  if (e.operation !== null && typeof e.operation !== "object") e.operation = null;
  if (e.oneTimeOperation !== null && typeof e.oneTimeOperation !== "object") {
    e.oneTimeOperation = null;
  }
  if (e.operation && typeof e.operation.dayCount !== "number") {
    e.operation.dayCount = Array.isArray(e.operation.days) ? e.operation.days.length : 0;
  }
  if (e.operation) {
    if (typeof e.operation.totalAtoB !== "number") e.operation.totalAtoB = 0;
    if (typeof e.operation.totalBtoA !== "number") e.operation.totalBtoA = 0;
    if (e.operation.rebalance === undefined) e.operation.rebalance = null;
  }
  return e;
}

function ownedTerminal(e) {
  var r = Game.rooms[e];
  return !!(r && r.controller && r.controller.my && r.terminal);
}

function availableResource(e, r) {
  var t = storageManager.storageFind(e, r);
  var a = t && t.combined ? t.combined.available : 0;
  if (typeof terminalManager.getRoomAvailableOutsideTerminal !== "function") {
    return a;
  }
  var n = terminalManager.getRoomAvailableOutsideTerminal(e, r);
  var i = t && t.storage ? t.storage.total : 0;
  return a + Math.max(0, n - i);
}

function terminalAmount(e, r) {
  var t = Game.rooms[e];
  return t && t.terminal && t.terminal.store ? t.terminal.store[r] || 0 : 0;
}

function orderRemaining(e) {
  return util.getOrderRemaining(e);
}

function roundPrice(e) {
  return Math.max(.001, Math.round(e * 1e3) / 1e3);
}

function shuffledPrices(e, r, t, a) {
  var n = Math.max(.001, e * t.minSpreadPct);
  var i = null;
  for (var o = 0; o < 100; o++) {
    var s = [];
    var u = true;
    for (var l = 0; l < r; l++) {
      var m = (Math.random() * 2 - 1) * t.priceJitterPct;
      var c = roundPrice(e * (1 + m));
      for (var d = 0; d < s.length; d++) {
        if (Math.abs(c - s[d]) < n) {
          u = false;
          break;
        }
      }
      if (!u) break;
      s.push(c);
    }
    if (!u) continue;
    s.sort(function(e, r) {
      return e - r;
    });
    var f = 0;
    for (var p = 0; p < s.length; p++) f += s[p];
    f /= s.length;
    if (f > a) return s;
    i = s;
  }
  return i && weightedPrice(i) > a ? i : null;
}

function weightedPrice(e) {
  var r = 0;
  for (var t = 0; t < e.length; t++) r += e[t];
  return e.length > 0 ? r / e.length : 0;
}

function allocateAmounts(e, r) {
  r = Math.max(1, Math.min(r, e));
  var t = [];
  var a = [];
  var n = 0;
  var i = 0;
  for (var o = 0; o < r; o++) {
    var s = .5 + Math.random();
    a.push(s);
    n += s;
  }
  for (var u = 0; u < r; u++) {
    var l = Math.max(1, Math.floor(e * a[u] / n));
    t.push(l);
    i += l;
  }
  while (i < e) {
    var m = Math.floor(Math.random() * r);
    t[m]++;
    i++;
  }
  while (i > e) {
    var c = Math.floor(Math.random() * r);
    if (t[c] <= 1) continue;
    t[c]--;
    i--;
  }
  if (r > 1 && e >= r + 1) {
    var d = true;
    for (var f = 1; f < r; f++) {
      if (t[f] !== t[0]) {
        d = false;
        break;
      }
    }
    if (d && t[0] > 1) {
      t[0]--;
      t[1]++;
    }
  }
  return t;
}

function weightedOrderPrice(e, r) {
  var t = 0;
  var a = 0;
  for (var n = 0; n < e.length; n++) {
    t += r[n];
    a += e[n] * r[n];
  }
  return t > 0 ? a / t : null;
}

function projectedAverage(e, r, t, a) {
  var n = 0;
  var i = e * r;
  for (var o = 0; o < t.length; o++) {
    n += a[o];
    i += t[o] * a[o];
  }
  return r + n > 0 ? i / (r + n) : null;
}

function findTerminalOperation(e, r, t, a) {
  var n = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
  for (var i = n.length - 1; i >= 0; i--) {
    var o = n[i];
    if (o && o.type === "toTerminal" && o.roomName === e && o.resourceType === r && o.amount === t && o.created === a) {
      return o;
    }
  }
  return null;
}

function findIncomingDeal(e) {
  var r = Game.market && Game.market.incomingTransactions || [];
  var t = 0;
  for (var a = 0; a < r.length; a++) {
    var n = r[a];
    if (!n || n.time < e.tick) continue;
    if (n.to === e.buyer && n.resourceType === e.resource && n.order && n.order.id === e.orderId) {
      t += n.amount || 0;
      if (t >= e.amount) return {
        amount: e.amount
      };
    }
  }
  return null;
}

function findExternalFill(e, r, t, a, n) {
  var i = Game.market && Game.market.outgoingTransactions || [];
  var o = 0;
  for (var s = 0; s < i.length; s++) {
    var u = i[s];
    if (!u || u.time < r || !u.order || u.order.id !== e || u.from !== t || u.resourceType !== n || u.to === a) continue;
    o += u.amount || 0;
  }
  return o;
}

function oneTimeIsTerminal(e) {
  return !!(e && [ "completed", "cancelled", "failed", "paused", "ambiguous" ].indexOf(e.state) >= 0);
}

function oneTimeIsActive(e) {
  return !!(e && !oneTimeIsTerminal(e));
}

function oneTimeOrderType(e) {
  return e.direction === "sell" ? ORDER_SELL : ORDER_BUY;
}

function oneTimeOrderRoom(e) {
  return e.direction === "sell" ? e.seller : e.buyer;
}

function oneTimeDealRoom(e) {
  return e.direction === "sell" ? e.buyer : e.seller;
}

function oneTimeOrderMatches(e, r) {
  if (!e || !r) return false;
  return r.type === oneTimeOrderType(e) && r.resourceType === e.resource && r.roomName === oneTimeOrderRoom(e) && r.totalAmount === e.amount && Math.abs(r.price - e.price) < .0015 && r.created === e.orderCreatedTick;
}

function oneTimePriceGuard(e, r, t) {
  if (r === "sell") {
    var a = configuredSellFloor(e);
    if (a > 0 && t + ONE_TIME_PRICE_EPSILON < a) {
      return "price " + t.toFixed(3) + " is below the configured sell floor " + a.toFixed(3);
    }
  }
  var n = null;
  try {
    n = pricing.getBook(e);
  } catch (e) {}
  if (n) {
    if (r === "sell" && n.bestBid !== null && t <= n.bestBid + ONE_TIME_PRICE_EPSILON) {
      return "sell price " + t.toFixed(3) + " is at or below the external best bid " + n.bestBid.toFixed(3);
    }
    if (r === "buy" && n.bestAsk !== null && t >= n.bestAsk - ONE_TIME_PRICE_EPSILON) {
      return "buy price " + t.toFixed(3) + " is at or above the external best ask " + n.bestAsk.toFixed(3);
    }
  }
  var i = null;
  try {
    var o = pricing.getPriceProfile(e);
    i = o && o.marketPrice;
  } catch (e) {}
  if (typeof i === "number" && i > 0) {
    if (r === "sell" && t < i * ONE_TIME_PRICE_MIN_MULTIPLIER) {
      return "sell price is below 50% of the canonical market price (" + i.toFixed(3) + ")";
    }
    if (r === "buy" && t > i * ONE_TIME_PRICE_MAX_MULTIPLIER) {
      return "buy price is above 150% of the canonical market price (" + i.toFixed(3) + ")";
    }
  }
  return null;
}

function findOneTimeExternalFill(e) {
  var r = 0;
  var t;
  var a;
  var n;
  if (e.direction === "sell") {
    t = Game.market && Game.market.outgoingTransactions || [];
    for (a = 0; a < t.length; a++) {
      n = t[a];
      if (!n || n.time < e.orderCreatedTick || !n.order || n.order.id !== e.orderId || n.from !== e.seller || n.to === e.buyer || n.resourceType !== e.resource) continue;
      r += n.amount || 0;
    }
  } else {
    t = Game.market && Game.market.incomingTransactions || [];
    for (a = 0; a < t.length; a++) {
      n = t[a];
      if (!n || n.time < e.orderCreatedTick || !n.order || n.order.id !== e.orderId || n.to !== e.buyer || n.from === e.seller || n.resourceType !== e.resource) continue;
      r += n.amount || 0;
    }
  }
  return r;
}

function releaseOneTimeReservation(e) {
  if (!e || e.reservationReleased) return;
  storageManager.unReserve(e.seller, e.resource, "terminal", e.reservationProgram);
  e.reservationReleased = true;
}

function cancelOneTimeOrder(e) {
  if (!e || !Game.market) return;
  var r = {};
  var t;
  if (e.orderId) {
    var a = Game.market.getOrderById(e.orderId);
    if (a && orderRemaining(a) > 0) Game.market.cancelOrder(e.orderId);
    r[e.orderId] = true;
  }
  if (!e.createAttempted || !Game.market.orders) return;
  for (t in Game.market.orders) {
    if (r[t]) continue;
    var n = Game.market.orders[t];
    if (oneTimeOrderMatches(e, n) && orderRemaining(n) > 0) {
      Game.market.cancelOrder(t);
    }
  }
}

function cancelOneTimeStage(e) {
  if (!e || !e.stageOpId || typeof terminalManager.cancelOperation !== "function") return;
  var r = findTransferOperation(e.stageOpId);
  if (r && r.status !== "completed" && r.status !== "failed") {
    terminalManager.cancelOperation(e.stageOpId);
  }
}

function findOneTimeTransfer(e) {
  var r = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
  for (var t = r.length - 1; t >= 0; t--) {
    var a = r[t];
    if (!a || a.type !== "transfer" || a.fromRoom !== e.buyer || a.toRoom !== e.seller || a.resourceType !== e.resource || a.amount !== e.amount || a.created !== e.transferRequestedTick) continue;
    return a;
  }
  return null;
}

function stopOneTime(e, r, t, a) {
  if (!e) return;
  cancelOneTimeOrder(e);
  cancelOneTimeStage(e);
  releaseOneTimeReservation(e);
  e.state = r;
  e.reason = t;
  e.completedTick = Game.time;
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.stop");
  console.log("[OneTimePriceAdjustment] " + e.id + " " + r + ": " + t);
  if (a) notify("[OneTimePriceAdjustment] " + e.resource + ": " + t);
}

function stageOneTime(e) {
  var r = terminalAmount(e.seller, e.resource);
  if (r < e.amount) {
    if (e.stageOpId) {
      var t = findTransferOperation(e.stageOpId);
      if (!t) {
        stopOneTime(e, "failed", "seller staging operation disappeared", true);
        return;
      }
      if (t.status === "failed") {
        stopOneTime(e, "failed", "seller staging operation failed", true);
        return;
      }
      if (t.status !== "completed") return;
      if (terminalAmount(e.seller, e.resource) < e.amount) {
        stopOneTime(e, "failed", "seller staging completed without enough stock", true);
        return;
      }
    } else {
      var a = e.amount - r;
      var n = terminalManager.getRoomAvailableOutsideTerminal(e.seller, e.resource);
      if (n < a) {
        stopOneTime(e, "failed", "seller has insufficient stock to stage " + a + " " + e.resource, true);
        return;
      }
      if (typeof terminalManager.init === "function") terminalManager.init();
      var i = terminalManager.storageToTerminal(e.seller, e.resource, a);
      var o = findTerminalOperation(e.seller, e.resource, a, Game.time);
      if (!o) {
        stopOneTime(e, "failed", "could not track seller staging operation: " + i, true);
        return;
      }
      e.stageOpId = o.id;
      memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.stage");
      return;
    }
  }
  if (!e.sellerReserved) {
    var s = storageManager.reserve(e.seller, e.resource, "terminal", e.reservationProgram, e.amount);
    if (!s || !s.ok) {
      e.reservationChecks = (e.reservationChecks || 0) + 1;
      if (e.reservationChecks > MAX_ONE_TIME_DEAL_VERIFY_CHECKS) {
        stopOneTime(e, "failed", "could not reserve seller terminal stock: " + (s && s.reason || "unknown"), true);
      } else {
        memoryManager.requestSave();
      }
      return;
    }
    e.sellerReserved = true;
    memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.reserve");
  }
  e.state = "posting";
}

function postOneTimeOrder(e) {
  if (e && labCommodityPolicy.isTwoLetterLabProduct(e.resource) && oneTimeOrderType(e) === ORDER_SELL) {
    stopOneTime(e, "cancelled", "restricted two-letter product cannot use passive SELL orders", true);
    return;
  }
  if (e.direction === "sell") e.price = applyConfiguredSellFloor(e.resource, e.price);
  var r = oneTimePriceGuard(e.resource, e.direction, e.price);
  if (r) {
    stopOneTime(e, "failed", r, true);
    return;
  }
  if (e.createAttempted) {
    e.state = "capturing";
    return;
  }
  var t = pricing.FEE * e.price * e.amount;
  if (creditLedger.available() < t) return;
  if (Game.market.orders && Object.keys(Game.market.orders).length + 1 > 300) return;
  e.createAttempted = true;
  e.orderCreatedTick = Game.time;
  e.captureChecks = 0;
  e.state = "capturing";
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.orderIntent");
  var a = Game.market.createOrder({
    type: oneTimeOrderType(e),
    resourceType: e.resource,
    price: e.price,
    totalAmount: e.amount,
    roomName: oneTimeOrderRoom(e)
  });
  if (a !== OK) {
    e.createAttempted = false;
    e.orderCreatedTick = null;
    e.state = "posting";
    if (a === ERR_FULL || a === ERR_NOT_ENOUGH_RESOURCES) return;
    stopOneTime(e, "failed", "createOrder failed: " + a, true);
    return;
  }
  creditLedger.commit(t);
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.order");
}

function captureOneTimeOrder(e) {
  if (e.orderId) {
    e.state = "dealing";
    return;
  }
  var r = Game.market.orders || {};
  var t = [];
  var a = [];
  for (var n in r) {
    var i = r[n];
    if (!oneTimeOrderMatches(e, i)) continue;
    t.push(n);
    try {
      if (require("marketAttribution").isAdjustmentOrder(n)) a.push(n);
    } catch (e) {}
  }
  if (a.length === 1) e.orderId = a[0]; else if (a.length > 1 || t.length > 1) {
    stopOneTime(e, "paused", "multiple matching orders made capture ambiguous", true);
    return;
  } else if (t.length === 1) e.orderId = t[0];
  if (e.orderId) {
    e.state = "dealing";
    memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.capture");
    return;
  }
  e.captureChecks = (e.captureChecks || 0) + 1;
  if (e.captureChecks > MAX_ONE_TIME_ORDER_CAPTURE_CHECKS) {
    stopOneTime(e, "paused", "order ID capture timed out", true);
  } else {
    memoryManager.requestSave();
  }
}

function findOneTimeLiveOrder(e) {
  if (!e || !Game.market || !Game.market.orders) return null;
  if (e.orderId) return Game.market.getOrderById(e.orderId);
  for (var r in Game.market.orders) {
    var t = Game.market.orders[r];
    if (oneTimeOrderMatches(e, t)) return t;
  }
  return null;
}

function enforceOneTimeSellFloor(e) {
  if (!e || e.direction !== "sell") return true;
  if (e && labCommodityPolicy.isTwoLetterLabProduct(e.resource) && oneTimeOrderType(e) === ORDER_SELL) {
    stopOneTime(e, "cancelled", "restricted two-letter product cannot use passive SELL orders", true);
    return false;
  }
  var r = configuredSellFloor(e && e.resource);
  if (!(r > 0) || !e || !(e.price < r)) return true;
  if (!e.createAttempted) {
    e.price = r;
    memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.floor");
    return true;
  }
  var t = findOneTimeLiveOrder(e);
  if (!t) return true;
  if (!(orderRemaining(t) > 0)) return true;
  if (t.price + ONE_TIME_PRICE_EPSILON >= r) {
    e.price = t.price;
    memoryManager.requestSave();
    return true;
  }
  var a = pricing.FEE * (r - t.price) * orderRemaining(t);
  if (creditLedger.available() < a) {
    stopOneTime(e, "paused", "insufficient credits to raise adjustment order to sell floor " + r.toFixed(3), true);
    return false;
  }
  var n = Game.market.changeOrderPrice(t.id, r);
  if (n !== OK) {
    stopOneTime(e, "paused", "could not raise adjustment order to sell floor " + r.toFixed(3) + ": " + n, true);
    return false;
  }
  if (a > 0) creditLedger.commit(a);
  e.orderId = t.id;
  e.price = r;
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.floorRepair");
  console.log("[OneTimePriceAdjustment] Raised " + e.id + " order " + t.id + " to configured sell floor " + r.toFixed(3));
  return true;
}

function startOneTimeDeal(e) {
  if (e.dealAttempted) {
    if (!e.pendingDeal) stopOneTime(e, "ambiguous", "deal attempt has no verification record", true);
    return;
  }
  var r = Game.market.getOrderById(e.orderId);
  if (!r || !oneTimeOrderMatches(e, r) || orderRemaining(r) < e.amount) {
    var t = findOneTimeExternalFill(e);
    var a = t > 0 ? "external fill detected for order " + e.orderId : "order disappeared or no longer has the requested amount";
    stopOneTime(e, "paused", a, true);
    return;
  }
  var n = oneTimeDealRoom(e);
  var i = Game.rooms[n];
  var o = i && i.terminal;
  if (!i || !i.controller || !i.controller.my || !o) {
    stopOneTime(e, "paused", "deal room no longer has an owned terminal", true);
    return;
  }
  if (o.cooldown > 0 || util.wasTerminalUsed(n)) return;
  var s = Game.rooms[e.buyer];
  var u = s && s.terminal;
  if (!u || u.store.getFreeCapacity(e.resource) < e.amount) return;
  var l = util.calcTransactionCost(e.amount, n, oneTimeOrderRoom(e));
  var m = l + (e.resource === RESOURCE_ENERGY ? e.amount : 0);
  if ((o.store[RESOURCE_ENERGY] || 0) < m) return;
  if (e.direction === "buy" && (o.store[e.resource] || 0) < e.amount) return;
  var c = 0;
  if (s && s.terminal && s.terminal.store) {
    c = s.terminal.store[e.resource] || 0;
  }
  e.dealAttempted = true;
  e.pendingDeal = {
    orderId: e.orderId,
    amount: e.amount,
    tick: Game.time,
    buyer: e.buyer,
    seller: e.seller,
    resource: e.resource,
    preAmount: c,
    verifyChecks: 0
  };
  e.state = "verifying";
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.dealIntent");
  var d = Game.market.deal(e.orderId, e.amount, n);
  if (d !== OK) {
    e.pendingDeal = null;
    e.dealAttempted = false;
    stopOneTime(e, "failed", "deal failed for order " + e.orderId + ": " + d, true);
    return;
  }
  util.markTerminalUsed(n);
  releaseOneTimeReservation(e);
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.deal");
}

function startOneTimeReturn(e) {
  if (e.transferOperationId) return;
  if (e.transferAttempted) {
    var r = findOneTimeTransfer(e);
    if (r) e.transferOperationId = r.id; else stopOneTime(e, "failed", "return transfer disappeared before tracking", true);
    return;
  }
  if (hasActiveTransfer(e.buyer, e.seller, e.resource)) {
    stopOneTime(e, "failed", "an existing return transfer uses the same route and resource", true);
    return;
  }
  if (typeof terminalManager.init === "function") terminalManager.init();
  e.transferAttempted = true;
  e.transferRequestedTick = Game.time;
  e.state = "transferring";
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.transferIntent");
  var t = terminalManager.transferStuff(e.buyer, e.seller, e.resource, e.amount, PROGRAM);
  var a = findOneTimeTransfer(e);
  if (!a) {
    stopOneTime(e, "failed", "return transfer was not created: " + t, true);
    return;
  }
  e.transferOperationId = a.id;
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.transfer");
}

function serviceOneTimeDeal(e) {
  if (!e.pendingDeal) {
    if (e.dealAttempted) {
      stopOneTime(e, "ambiguous", "deal attempt has no verification record", true);
    } else {
      startOneTimeDeal(e);
    }
    return;
  }
  var r = findIncomingDeal(e.pendingDeal);
  if (!r) {
    e.pendingDeal.verifyChecks = (e.pendingDeal.verifyChecks || 0) + 1;
    if (e.pendingDeal.verifyChecks > MAX_ONE_TIME_DEAL_VERIFY_CHECKS || Game.time - e.pendingDeal.tick >= ONE_TIME_DEAL_VERIFY_TIMEOUT) {
      stopOneTime(e, "ambiguous", "deal confirmation timed out; no return transfer issued", true);
    } else {
      memoryManager.requestSave();
    }
    return;
  }
  e.pendingDeal = null;
  e.purchaseConfirmed = true;
  e.purchaseConfirmedTick = Game.time;
  e.state = "transferring";
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.confirm");
  startOneTimeReturn(e);
}

function serviceOneTimeReturn(e) {
  if (!e.transferOperationId) {
    startOneTimeReturn(e);
    return;
  }
  var r = findTransferOperation(e.transferOperationId);
  if (!r) {
    stopOneTime(e, "failed", "return transfer operation disappeared", true);
    return;
  }
  if (r.status === "failed") {
    stopOneTime(e, "failed", "return transfer failed: " + (r.error || "unknown"), true);
    return;
  }
  if (r.status !== "completed") return;
  e.state = "completed";
  e.completedTick = Game.time;
  e.reason = null;
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.complete");
  var t = "[OneTimePriceAdjustment] Complete " + e.id + ": " + e.amount + " " + e.resource + " via " + e.direction + " order at " + e.price.toFixed(3);
  console.log(t);
  notify(t);
}

function runOneTime(e) {
  var r = e.oneTimeOperation;
  if (!r || oneTimeIsTerminal(r)) return;
  if (!enforceOneTimeSellFloor(r)) return;
  if (r.pendingDeal || r.state === "verifying") {
    serviceOneTimeDeal(r);
  } else if (r.state === "staging") {
    stageOneTime(r);
  } else if (r.state === "posting") {
    postOneTimeOrder(r);
  } else if (r.state === "capturing") {
    captureOneTimeOrder(r);
  } else if (r.state === "dealing") {
    startOneTimeDeal(r);
  } else if (r.state === "transferring") {
    serviceOneTimeReturn(r);
  } else {
    stopOneTime(r, "failed", "unknown one-time state: " + r.state, true);
  }
}

function notify(e) {
  try {
    Game.notify(e, 0);
  } catch (e) {}
}

function releaseReservation(e) {
  if (!e || !e.batch) return;
  var r = e.batch;
  storageManager.unReserve(r.seller, e.resource, "terminal", PROGRAM);
}

function cancelBatchOrders(e) {
  var r = e && (e.batch || e.cleanupBatch);
  if (!r || !Array.isArray(r.orders)) return;
  for (var t = 0; t < r.orders.length; t++) {
    var a = r.orders[t];
    if (!a) continue;
    if (a.id) {
      var n = Game.market.getOrderById(a.id);
      if (n && orderRemaining(n) > 0) Game.market.cancelOrder(a.id);
      continue;
    }
    if (!a.accepted || a.createdTick === null) continue;
    for (var i in Game.market.orders) {
      var o = Game.market.orders[i];
      if (!o || o.type !== ORDER_SELL || o.resourceType !== e.resource || o.roomName !== r.seller || o.created !== a.createdTick || o.totalAmount !== a.amount) continue;
      var s = false;
      try {
        s = require("marketAttribution").isAdjustmentOrder(i);
      } catch (e) {}
      if (!s && Math.abs(o.price - a.price) >= .001) continue;
      if (orderRemaining(o) > 0) Game.market.cancelOrder(i);
    }
  }
}

function cancelStageOperation(e) {
  var r = e && (e.batch || e.cleanupBatch);
  if (!r || !r.stageOpId || !terminalManager.cancelOperation) return;
  terminalManager.cancelOperation(r.stageOpId);
}

function failOperation(e, r, t) {
  if (e.batch) e.cleanupBatch = e.batch;
  cancelBatchOrders(e);
  cancelStageOperation(e);
  releaseReservation(e);
  e.state = "paused";
  e.reason = r;
  e.rebalance = null;
  e.batch = null;
  memoryManager.requestImmediateSave("marketPriceAdjustment.pause");
  console.log("[MarketPriceAdjustment] Paused " + e.id + ": " + r);
  if (t) notify("[MarketPriceAdjustment] Paused " + e.resource + ": " + r);
}

function completeOperation(e, r) {
  releaseReservation(e);
  cancelBatchOrders(e);
  e.state = "complete";
  e.completedTick = Game.time;
  e.finalAverage = r.average;
  e.batch = null;
  memoryManager.requestImmediateSave("marketPriceAdjustment.complete");
  var t = "[MarketPriceAdjustment] Complete " + e.resource + " in " + e.dayCount + " day(s): 72h avg " + r.average.toFixed(3) + " / target " + e.targetPrice.toFixed(3) + " | moved " + e.totalMoved + " units";
  console.log(t);
  notify(t);
}

function findTransferOperation(e) {
  var r = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
  for (var t = 0; t < r.length; t++) {
    if (r[t] && r[t].id === e) return r[t];
  }
  return null;
}

function hasActiveTransfer(e, r, t) {
  var a = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
  for (var n = 0; n < a.length; n++) {
    var i = a[n];
    if (!i || i.type !== "transfer" || i.fromRoom !== e || i.toRoom !== r || i.resourceType !== t) continue;
    if (i.status !== "completed" && i.status !== "failed") return true;
  }
  return false;
}

function beginRebalance(e, r, t, a, n) {
  var i = Math.abs((e.totalAtoB || 0) - (e.totalBtoA || 0));
  if (i <= 0) {
    if (t) {
      e.state = t;
      e.reason = a || null;
      memoryManager.requestImmediateSave("marketPriceAdjustment.finalize");
      if (n) notify("[MarketPriceAdjustment] " + a);
    } else {
      completeOperation(e, r);
    }
    return;
  }
  var o = (e.totalAtoB || 0) > (e.totalBtoA || 0) ? e.roomB : e.roomA;
  var s = o === e.roomA ? e.roomB : e.roomA;
  if (hasActiveTransfer(o, s, e.resource)) {
    failOperation(e, "an existing transfer already uses the rebalance route", true);
    return;
  }
  var u = terminalManager.transferStuff(o, s, e.resource, i, PROGRAM);
  if (typeof u !== "string" || u.indexOf("created") < 0 && u.indexOf("Created") < 0 && u.indexOf("Merged") < 0) {
    failOperation(e, "could not rebalance " + i + " " + e.resource + ": " + u, true);
    return;
  }
  var l = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
  var m = null;
  for (var c = l.length - 1; c >= 0; c--) {
    if (l[c] && l[c].type === "transfer" && l[c].fromRoom === o && l[c].toRoom === s && l[c].resourceType === e.resource && l[c].created === Game.time) {
      m = l[c];
      break;
    }
  }
  if (!m) {
    failOperation(e, "rebalance transfer was accepted without a trackable operation", true);
    return;
  }
  e.rebalance = {
    fromRoom: o,
    toRoom: s,
    amount: i,
    operationId: m.id,
    createdTick: Game.time,
    checks: 0,
    history: r,
    finalState: t || null,
    finalReason: a || null,
    notifyUser: !!n
  };
  e.state = "rebalancing";
  memoryManager.requestImmediateSave("marketPriceAdjustment.rebalance");
}

function serviceRebalance(e) {
  var r = e.rebalance;
  var t = findTransferOperation(r.operationId);
  if (t && t.status === "completed") {
    var a = r.history;
    e.rebalance = null;
    if (r.finalState) {
      e.state = r.finalState;
      e.reason = r.finalReason || null;
      e.completedTick = Game.time;
      memoryManager.requestImmediateSave("marketPriceAdjustment.finalize");
      if (r.notifyUser) notify("[MarketPriceAdjustment] " + e.reason);
    } else {
      completeOperation(e, a);
    }
    return;
  }
  if (t && t.status === "failed") {
    failOperation(e, "rebalance transfer failed", true);
    return;
  }
  r.checks = (r.checks || 0) + 1;
  if (!t && r.checks > MAX_REBALANCE_CHECKS) {
    failOperation(e, "rebalance transfer disappeared before completion", true);
  } else if (!t) {
    memoryManager.requestSave();
  }
}

function finalizeWithoutFurtherTrading(e, r, t, a) {
  if (e.batch) e.cleanupBatch = e.batch;
  cancelBatchOrders(e);
  cancelStageOperation(e);
  releaseReservation(e);
  e.batch = null;
  e.cancelRequested = false;
  var n = Math.abs((e.totalAtoB || 0) - (e.totalBtoA || 0));
  if (n > 0) {
    e.state = "paused";
    e.reason = t;
    beginRebalance(e, completeHistory(e.resource), r, t, a);
    if (e.state === "rebalancing") {
      memoryManager.requestImmediateSave("marketPriceAdjustment.finalize");
      return;
    }
    if (e.state === "paused" && e.reason !== t) return;
  }
  e.state = r;
  e.reason = t;
  e.completedTick = Game.time;
  memoryManager.requestImmediateSave("marketPriceAdjustment.finalize");
  if (a) notify("[MarketPriceAdjustment] " + t);
}

function createBatch(e, r, t) {
  var a = e.options;
  var n = configuredSellFloor(e.resource);
  var i = Math.min(e.targetPrice, r.average * (1 + a.dailyIncreasePct));
  if (n > 0) i = Math.max(i, n);
  var o = Math.floor(e.baselineDailyVolume * a.maxDailyShare);
  if (o < 1) return {
    error: "daily volume cap is below one unit"
  };
  var s = Math.min(a.ordersPerDay, o);
  var u = shuffledPrices(i, s, a, r.average);
  if (!u || u.length !== s) return {
    error: "could not generate a useful price ladder"
  };
  for (var l = 0; l < u.length; l++) {
    u[l] = applyConfiguredSellFloor(e.resource, u[l]);
  }
  var m = allocateAmounts(o, s);
  var c = weightedOrderPrice(u, m);
  var d = null;
  if (c > i) {
    d = Math.ceil(r.volume * (i - r.average) / (c - i));
  }
  var f = d === null ? o : Math.min(o, Math.max(s, d));
  m = null;
  c = null;
  for (var p = 0; p < 20; p++) {
    m = allocateAmounts(f, s);
    c = weightedOrderPrice(u, m);
    if (c > r.average) break;
  }
  if (!(c > r.average)) {
    return {
      error: "generated price ladder would not raise the current average"
    };
  }
  var v = {
    day: t,
    seller: e.seller,
    buyer: e.buyer,
    goal: i,
    currentAverage: r.average,
    currentVolume: r.volume,
    dailyCap: o,
    effectivePrice: c,
    projectedAverage: projectedAverage(r.average, r.volume, u, m),
    plannedTotal: f,
    state: "staging",
    stageRequested: false,
    stageOpId: null,
    orders: [],
    nextOrderIndex: 0,
    pendingDeal: null,
    createdTick: Game.time
  };
  for (var g = 0; g < u.length; g++) {
    v.orders.push({
      price: u[g],
      amount: m[g],
      id: null,
      accepted: false,
      createdTick: null
    });
  }
  return {
    batch: v
  };
}

function stageBatch(e) {
  var r = e.batch;
  var t = r.orders[r.nextOrderIndex];
  if (!t) {
    finishBatch(e);
    return;
  }
  var a = terminalAmount(r.seller, e.resource);
  if (a < t.amount) {
    if (!r.stageRequested) {
      var n = t.amount - a;
      var i = terminalManager.storageToTerminal(r.seller, e.resource, n);
      var o = findTerminalOperation(r.seller, e.resource, n, Game.time);
      if (!o) {
        failOperation(e, "could not stage " + n + " " + e.resource + " in " + r.seller + ": " + i, true);
        return;
      }
      r.stageRequested = true;
      r.stageOpId = o.id;
      memoryManager.requestSave();
      return;
    }
    var s = null;
    if (r.stageOpId) {
      var u = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
      for (var l = 0; l < u.length; l++) {
        if (u[l] && u[l].id === r.stageOpId) {
          s = u[l];
          break;
        }
      }
    }
    if (!s) {
      r.stageRequested = false;
      r.stageOpId = null;
      memoryManager.requestSave();
    } else if (s.status === "failed") {
      failOperation(e, "terminal staging failed", true);
    } else if (s && s.status === "completed" && terminalAmount(r.seller, e.resource) < t.amount) {
      failOperation(e, "terminal staging completed without enough stock", true);
    }
    return;
  }
  var m = storageManager.reserve(r.seller, e.resource, "terminal", PROGRAM, t.amount);
  if (!m || !m.ok) {
    failOperation(e, "could not reserve seller terminal stock: " + (m && m.reason || "unknown"), true);
    return;
  }
  var c = Game.rooms[r.buyer];
  var d = c && c.terminal;
  if (!d) {
    failOperation(e, "buyer terminal is no longer visible", true);
    return;
  }
  if (d.store.getFreeCapacity(e.resource) < t.amount) return;
  var f = util.calcTransactionCost(t.amount, r.buyer, r.seller);
  if ((d.store[RESOURCE_ENERGY] || 0) < f) return;
  r.state = "posting";
  memoryManager.requestImmediateSave("marketPriceAdjustment.post");
  postBatchOrders(e);
}

function postBatchOrders(e) {
  if (e && labCommodityPolicy.isTwoLetterLabProduct(e.resource)) {
    failOperation(e, "restricted two-letter product cannot use passive SELL orders", true);
    return;
  }
  var r = e.batch;
  var t = r.orders[r.nextOrderIndex];
  if (!t) {
    finishBatch(e);
    return;
  }
  t.price = applyConfiguredSellFloor(e.resource, t.price);
  var a = pricing.FEE * t.price * t.amount;
  if (creditLedger.available() < a) return;
  if (Game.market.orders && Object.keys(Game.market.orders).length + 1 > 300) return;
  t.createdTick = Game.time;
  var n = Game.market.createOrder({
    type: ORDER_SELL,
    resourceType: e.resource,
    price: t.price,
    totalAmount: t.amount,
    roomName: r.seller
  });
  if (n !== OK) {
    if (n === ERR_FULL || n === ERR_NOT_ENOUGH_RESOURCES) return;
    failOperation(e, "createOrder failed: " + n, true);
    return;
  }
  t.accepted = true;
  creditLedger.commit(a);
  r.state = "capturing";
  memoryManager.requestImmediateSave("marketPriceAdjustment.orders");
}

function captureBatchOrders(e) {
  var r = e.batch;
  var t = r.orders[r.nextOrderIndex];
  if (!t) {
    finishBatch(e);
    return;
  }
  if (!t.id) {
    var a = null;
    for (var n in Game.market.orders) {
      var i = Game.market.orders[n];
      if (!i || i.type !== ORDER_SELL || i.resourceType !== e.resource) continue;
      if (i.roomName !== r.seller || i.created !== t.createdTick) continue;
      if (i.totalAmount !== t.amount || Math.abs(i.price - t.price) >= .001) continue;
      if (a === null) a = n;
      try {
        if (require("marketAttribution").isAdjustmentOrder(n)) {
          t.id = n;
          break;
        }
      } catch (e) {}
    }
    if (!t.id) t.id = a;
  }
  if (!t.id) {
    t.captureChecks = (t.captureChecks || 0) + 1;
    if (t.captureChecks > MAX_ORDER_CAPTURE_CHECKS) {
      failOperation(e, "order ID capture timed out", true);
    } else {
      memoryManager.requestSave();
    }
    return;
  }
  r.state = "dealing";
  memoryManager.requestSave();
}

function serviceDeal(e) {
  var r = e.batch;
  if (r.pendingDeal) {
    var t = findIncomingDeal(r.pendingDeal);
    if (t) {
      var a = r.pendingDeal.amount;
      e.totalMoved += a;
      if (r.seller === e.roomA) e.totalAtoB += a; else e.totalBtoA += a;
      releaseReservation(e);
      r.pendingDeal = null;
      if (e.cancelRequested) {
        finalizeWithoutFurtherTrading(e, "cancelled", "cancelled by console after deal confirmation", true);
        return;
      }
      r.nextOrderIndex++;
      memoryManager.requestImmediateSave("marketPriceAdjustment.confirm");
      if (r.nextOrderIndex >= r.orders.length) {
        finishBatch(e);
      } else {
        r.stageRequested = false;
        r.stageOpId = null;
        r.state = "staging";
        memoryManager.requestSave();
      }
      return;
    } else {
      r.pendingDeal.verifyChecks = (r.pendingDeal.verifyChecks || 0) + 1;
      if (r.pendingDeal.verifyChecks > MAX_DEAL_VERIFY_CHECKS) {
        if (e.cancelRequested) {
          finalizeWithoutFurtherTrading(e, "cancelled", "cancelled after deal confirmation timeout", true);
        } else {
          failOperation(e, "deal confirmation became ambiguous for order " + r.pendingDeal.orderId, true);
        }
        return;
      }
      memoryManager.requestSave();
      return;
    }
  }
  if (r.nextOrderIndex >= r.orders.length) {
    finishBatch(e);
    return;
  }
  var n = r.orders[r.nextOrderIndex];
  var i = Game.market.getOrderById(n.id);
  if (!i || orderRemaining(i) < n.amount) {
    var o = findExternalFill(n.id, n.createdTick, r.seller, r.buyer, e.resource);
    var s = o > 0 ? "external fill detected for adjustment order " + n.id : "adjustment order was filled or disappeared before our deal";
    finalizeWithoutFurtherTrading(e, "paused", s, true);
    return;
  }
  var u = Game.rooms[r.buyer];
  var l = u && u.terminal;
  if (!l || l.cooldown > 0 || util.wasTerminalUsed(r.buyer)) return;
  var m = util.calcTransactionCost(n.amount, r.buyer, r.seller);
  if ((l.store[RESOURCE_ENERGY] || 0) < m || l.store.getFreeCapacity(e.resource) < n.amount) return;
  var c = Game.market.deal(n.id, n.amount, r.buyer);
  if (c !== OK) {
    failOperation(e, "deal failed for order " + n.id + ": " + c, true);
    return;
  }
  util.markTerminalUsed(r.buyer);
  r.pendingDeal = {
    orderId: n.id,
    amount: n.amount,
    price: n.price,
    tick: Game.time,
    buyer: r.buyer,
    seller: r.seller,
    resource: e.resource,
    verifyChecks: 0
  };
  memoryManager.requestImmediateSave("marketPriceAdjustment.deal");
}

function finishBatch(e) {
  var r = e.batch;
  releaseReservation(e);
  var t = completeHistory(e.resource);
  e.days.push({
    day: r.day,
    goal: r.goal,
    currentAverage: r.currentAverage,
    projectedAverage: r.projectedAverage,
    effectivePrice: r.effectivePrice,
    moved: r.plannedTotal,
    orders: r.orders.length,
    seller: r.seller,
    buyer: r.buyer
  });
  if (e.days.length > 30) e.days.shift();
  e.dayCount++;
  e.lastActionUtcDay = r.day;
  e.nextUtcDay = nextUtcDay(r.day);
  var a = e.seller;
  e.seller = e.buyer;
  e.buyer = a;
  e.batch = null;
  e.state = "scheduled";
  memoryManager.requestImmediateSave("marketPriceAdjustment.dailyComplete");
  console.log("[MarketPriceAdjustment] Completed " + r.orders.length + " order(s) for " + r.day + ": " + r.plannedTotal + " " + e.resource + " | projected 72h average " + r.projectedAverage.toFixed(3) + " | observed history " + (t.average === null ? "-" : t.average.toFixed(3)));
}

function findBatchLiveOrder(e, r, t) {
  if (!e || !r || !t || !Game.market) return null;
  if (r.id) return Game.market.getOrderById(r.id);
  var a = Game.market.orders || {};
  for (var n in a) {
    var i = a[n];
    if (!i || i.type !== ORDER_SELL || i.resourceType !== t || i.roomName !== e.seller || i.created !== r.createdTick || i.totalAmount !== r.amount) continue;
    if (Math.abs(i.price - r.price) < .0015) return i;
  }
  return null;
}

function enforceBatchSellFloor(e) {
  if (e && labCommodityPolicy.isTwoLetterLabProduct(e.resource)) {
    failOperation(e, "restricted two-letter product cannot use passive SELL orders", true);
    return false;
  }
  var r = configuredSellFloor(e && e.resource);
  var t = e && e.batch;
  if (!(r > 0) || !t || !Array.isArray(t.orders)) return true;
  var a = false;
  if (!(e.targetPrice >= r)) {
    e.targetPrice = r;
    a = true;
  }
  if (!(t.goal >= r)) {
    t.goal = r;
    a = true;
  }
  for (var n = 0; n < t.orders.length; n++) {
    var i = t.orders[n];
    if (!i) continue;
    var o = findBatchLiveOrder(t, i, e.resource);
    if (o && orderRemaining(o) > 0 && o.price + ONE_TIME_PRICE_EPSILON < r) {
      var s = pricing.FEE * (r - o.price) * orderRemaining(o);
      if (creditLedger.available() < s) {
        failOperation(e, "insufficient credits to raise adjustment order to sell floor " + r.toFixed(3), true);
        return false;
      }
      var u = Game.market.changeOrderPrice(o.id, r);
      if (u !== OK) {
        failOperation(e, "could not raise adjustment order to sell floor " + r.toFixed(3) + ": " + u, true);
        return false;
      }
      if (s > 0) creditLedger.commit(s);
      i.id = o.id;
      i.price = r;
      a = true;
      console.log("[MarketPriceAdjustment] Raised order " + o.id + " to configured sell floor " + r.toFixed(3));
    } else if (i.price < r && (!i.accepted || o)) {
      i.price = r;
      a = true;
    }
  }
  if (a) memoryManager.requestImmediateSave("marketPriceAdjustment.floorRepair");
  return true;
}

function run() {
  var e = ensureMemory();
  runOneTime(e);
  var r = e.operation;
  if (!r) return;
  if (r.state === "complete" || r.state === "cancelled" || r.state === "paused") {
    if (r.cleanupBatch) {
      cancelBatchOrders(r);
      cancelStageOperation(r);
    }
    return;
  }
  if (r.rebalance) {
    serviceRebalance(r);
    return;
  }
  if (r.batch && !enforceBatchSellFloor(r)) return;
  if (r.batch) {
    if (r.batch.state === "staging") stageBatch(r); else if (r.batch.state === "posting") postBatchOrders(r); else if (r.batch.state === "capturing") captureBatchOrders(r); else if (r.batch.state === "dealing") serviceDeal(r);
    return;
  }
  var t = utcDayKey();
  if (t < r.nextUtcDay || utcMinute() < 1) return;
  if (r.lastActionUtcDay === t) return;
  var a = completeHistory(r.resource);
  if (a.length < TARGET_HISTORY_DAYS) {
    failOperation(r, "fewer than " + TARGET_HISTORY_DAYS + " completed history days", true);
    return;
  }
  var n = weightedHistory(a.slice(-TARGET_HISTORY_DAYS));
  if (n.average >= r.targetPrice * .95) {
    beginRebalance(r, n);
    return;
  }
  var i = createBatch(r, n, t);
  if (i.error) {
    failOperation(r, i.error, true);
    return;
  }
  r.batch = i.batch;
  r.state = "active";
  memoryManager.requestImmediateSave("marketPriceAdjustment.plan");
}

function start(e, r, t, a, n) {
  var i = ensureMemory();
  if (i.operation && [ "complete", "cancelled", "paused" ].indexOf(i.operation.state) < 0) {
    return "[MarketPriceAdjustment] An operation is already active: " + i.operation.id;
  }
  if (typeof e !== "string" || typeof r !== "string" || e === r) {
    return "[MarketPriceAdjustment] Two distinct room names are required.";
  }
  if (!ownedTerminal(e) || !ownedTerminal(r)) {
    return "[MarketPriceAdjustment] Both rooms must be owned and have terminals.";
  }
  if (!terminalManager.validateResource(t)) {
    return "[MarketPriceAdjustment] Invalid terminal resource: " + t;
  }
  if (labCommodityPolicy.isTwoLetterLabProduct(t)) {
    return "[MarketPriceAdjustment] Two-letter lab products must not use passive SELL orders.";
  }
  a = Number(a);
  if (!finiteNumber(a) || a <= 0) {
    return "[MarketPriceAdjustment] targetPrice must be greater than zero.";
  }
  a = applyConfiguredSellFloor(t, a);
  var o = completeHistory(t);
  if (o.length < TARGET_HISTORY_DAYS) {
    return "[MarketPriceAdjustment] Need at least " + TARGET_HISTORY_DAYS + " completed history days.";
  }
  var s = o.slice(-HISTORY_DAYS);
  var u = averageVolume(s);
  if (!(u > 0)) {
    return "[MarketPriceAdjustment] Could not calculate a 14-day volume baseline.";
  }
  var l = availableResource(e, t);
  var m = availableResource(r, t);
  if (l <= 0 && m <= 0) {
    return "[MarketPriceAdjustment] Neither room has available " + t + " stock.";
  }
  var c = normalizeOptions(n);
  var d = l > 0 ? e : r;
  var f = d === e ? r : e;
  var p = "mpa:" + Game.time + ":" + i.nextId++;
  i.operation = {
    v: VERSION,
    id: p,
    roomA: e,
    roomB: r,
    seller: d,
    buyer: f,
    resource: t,
    targetPrice: a,
    options: c,
    baselineDailyVolume: u,
    baselineDays: s.length,
    baselineLastDate: s[s.length - 1].date,
    nextUtcDay: nextUtcDay(utcDayKey()),
    lastActionUtcDay: null,
    state: "scheduled",
    batch: null,
    rebalance: null,
    days: [],
    dayCount: 0,
    totalMoved: 0,
    totalAtoB: 0,
    totalBtoA: 0,
    createdTick: Game.time,
    reason: null
  };
  memoryManager.requestImmediateSave("marketPriceAdjustment.start");
  var v = "[MarketPriceAdjustment] Scheduled " + p + ": " + t + " target " + a.toFixed(3) + " starting " + i.operation.nextUtcDay + " | baseline volume " + u.toFixed(1) + "/day" + " | daily share " + (c.maxDailyShare * 100).toFixed(1) + "%";
  return v;
}

function startOneTime(e, r, t, a, n, i) {
  var o = ensureMemory();
  if (i !== "buy" && i !== "sell") {
    return '[OneTimePriceAdjustment] direction is required and must be "buy" or "sell".';
  }
  if (i === "sell" && labCommodityPolicy.isTwoLetterLabProduct(t)) {
    return "[OneTimePriceAdjustment] Two-letter lab products must not use passive SELL orders.";
  }
  if (o.oneTimeOperation && oneTimeIsActive(o.oneTimeOperation)) {
    return "[OneTimePriceAdjustment] A one-time operation is already active: " + o.oneTimeOperation.id;
  }
  if (typeof e !== "string" || typeof r !== "string" || e === r) {
    return "[OneTimePriceAdjustment] Seller and buyer must be distinct room names.";
  }
  if (!ownedTerminal(e) || !ownedTerminal(r)) {
    return "[OneTimePriceAdjustment] Both rooms must be owned and have terminals.";
  }
  if (!terminalManager.validateResource(t)) {
    return "[OneTimePriceAdjustment] Invalid terminal resource: " + t;
  }
  a = Number(a);
  n = Number(n);
  if (!finiteNumber(a) || a <= 0 || Math.floor(a) !== a) {
    return "[OneTimePriceAdjustment] amount must be a positive finite integer.";
  }
  if (!finiteNumber(n) || n <= 0) {
    return "[OneTimePriceAdjustment] price must be a positive finite number.";
  }
  if (i === "sell") n = applyConfiguredSellFloor(t, n);
  var s = oneTimePriceGuard(t, i, n);
  if (s) return "[OneTimePriceAdjustment] Refusing order: " + s + ".";
  var u = availableResource(e, t);
  if (u < a) {
    return "[OneTimePriceAdjustment] Seller has only " + u + " available " + t + "; requested " + a + ".";
  }
  if (typeof terminalManager.init === "function") terminalManager.init();
  var l = "mpa:one:" + Game.time + ":" + o.nextId++;
  o.oneTimeOperation = {
    v: VERSION,
    id: l,
    seller: e,
    buyer: r,
    resource: t,
    amount: a,
    price: n,
    direction: i,
    state: "staging",
    stageOpId: null,
    sellerReserved: false,
    reservationReleased: false,
    reservationProgram: PROGRAM + ".oneTime." + l,
    reservationChecks: 0,
    createAttempted: false,
    orderCreatedTick: null,
    captureChecks: 0,
    orderId: null,
    dealAttempted: false,
    pendingDeal: null,
    purchaseConfirmed: false,
    transferAttempted: false,
    transferRequestedTick: null,
    transferOperationId: null,
    createdTick: Game.time,
    completedTick: null,
    reason: null
  };
  memoryManager.requestImmediateSave("marketPriceAdjustment.oneTime.start");
  var m = "[OneTimePriceAdjustment] Started " + l + ": " + a + " " + t + " from " + e + " to " + r + " using " + i + " order at " + n.toFixed(3);
  return m;
}

function isOneTimePriceAdjustmentOrder(e) {
  if (!e) return false;
  var r = ensureMemory();
  var t = r.oneTimeOperation;
  if (!t || !t.createAttempted) return false;
  if (t.orderId === e) return true;
  var a = Game.market && Game.market.orders && Game.market.orders[e];
  return !!(a && oneTimeOrderMatches(t, a));
}

function isProtectedOrder(e) {
  try {
    if (require("marketAttribution").isAdjustmentOrder(e)) return true;
  } catch (e) {}
  var r = ensureMemory();
  var t = r.oneTimeOperation;
  if (t && t.createAttempted) {
    if (t.orderId === e) return true;
    var a = Game.market && Game.market.orders && Game.market.orders[e];
    if (a && oneTimeOrderMatches(t, a)) return true;
  }
  var n = r.operation;
  var i = n && (n.batch || n.cleanupBatch);
  if (!i || !Array.isArray(i.orders)) return false;
  for (var o = 0; o < i.orders.length; o++) {
    if (i.orders[o] && i.orders[o].id === e) return true;
    var s = i.orders[o];
    var u = Game.market && Game.market.orders && Game.market.orders[e];
    if (s && s.accepted && s.createdTick !== null && u && u.type === ORDER_SELL && u.resourceType === n.resource && u.roomName === i.seller && u.created === s.createdTick && u.totalAmount === s.amount) return true;
  }
  return false;
}

function isSelfTradeTransaction(e) {
  if (!e || !e.order || !e.order.id || !e.resourceType) return false;
  if (!require("marketAttribution").isAdjustmentOrder(e.order.id)) return false;
  var r = require("getRoomState");
  if (r.isOwned(e.from) && r.isOwned(e.to) && e.from !== e.to) {
    return true;
  }
  var t = ensureMemory().operation;
  if (!t || t.resource !== e.resourceType) return false;
  return e.from === t.roomA && e.to === t.roomB || e.from === t.roomB && e.to === t.roomA;
}

function oneTimeStatusLines(e) {
  if (!e) return [];
  var r = e.transferOperationId ? findTransferOperation(e.transferOperationId) : null;
  return [ "[OneTimePriceAdjustment] " + e.id + " | " + e.state, "  seller=" + e.seller + " buyer=" + e.buyer + " | " + e.amount + " " + e.resource, "  direction=" + e.direction + " | price=" + e.price.toFixed(3) + " | order=" + (e.orderId || (e.createAttempted ? "capturing" : "not-created")), "  purchase=" + (e.purchaseConfirmed ? "confirmed" : "unconfirmed") + " | return=" + (r ? r.status : e.transferAttempted ? "pending" : "not-requested") ].concat(e.reason ? [ "  reason=" + e.reason ] : []);
}

function oneTimeStatus() {
  var e = ensureMemory().oneTimeOperation;
  var r = e ? oneTimeStatusLines(e).join("\n") : "[OneTimePriceAdjustment] No operation.";
  return r;
}

function status() {
  var e = ensureMemory();
  var r = e.operation;
  if (!r) {
    if (e.oneTimeOperation) return oneTimeStatus();
    var t = "[MarketPriceAdjustment] No operation.";
    return t;
  }
  var a = [ "[MarketPriceAdjustment] " + r.id + " | " + r.state, "  " + r.resource + " target=" + r.targetPrice.toFixed(3) + " | rooms " + r.roomA + "<->" + r.roomB, "  seller=" + r.seller + " buyer=" + r.buyer + " | next UTC day=" + r.nextUtcDay, "  baseline volume=" + r.baselineDailyVolume.toFixed(1) + " over " + r.baselineDays + " day(s)" + " | daily cap=" + Math.floor(r.baselineDailyVolume * r.options.maxDailyShare), "  days=" + r.dayCount + " | total moved=" + r.totalMoved + " | A->B=" + (r.totalAtoB || 0) + " | B->A=" + (r.totalBtoA || 0) ];
  if (r.rebalance) {
    a.push("  rebalance=" + r.rebalance.fromRoom + "->" + r.rebalance.toRoom + " | " + r.rebalance.amount + " " + r.resource + " | transfer=" + r.rebalance.operationId);
  }
  if (r.batch) {
    a.push("  batch=" + r.batch.day + " " + r.batch.state + " | " + r.batch.plannedTotal + " units" + " | goal=" + r.batch.goal.toFixed(3) + " | projected=" + r.batch.projectedAverage.toFixed(3));
    for (var n = 0; n < r.batch.orders.length; n++) {
      var i = r.batch.orders[n];
      a.push("    order " + (n + 1) + ": " + i.amount + " @ " + i.price.toFixed(3) + " | " + (i.id || "pending"));
    }
  }
  if (r.reason) a.push("  reason=" + r.reason);
  if (e.oneTimeOperation) a = a.concat(oneTimeStatusLines(e.oneTimeOperation));
  var o = a.join("\n");
  return o;
}

function cancel() {
  var e = ensureMemory();
  if (!e.operation) return "[MarketPriceAdjustment] No operation to cancel.";
  var r = e.operation;
  if (r.state === "complete" || r.state === "cancelled") {
    return "[MarketPriceAdjustment] Operation is already " + r.state + ".";
  }
  if (r.rebalance) {
    return "[MarketPriceAdjustment] Cancellation deferred until rebalancing completes.";
  }
  if (r.batch && r.batch.pendingDeal) {
    r.cancelRequested = true;
    memoryManager.requestImmediateSave("marketPriceAdjustment.cancelRequest");
    return "[MarketPriceAdjustment] Cancellation deferred until the pending deal is confirmed.";
  }
  finalizeWithoutFurtherTrading(r, "cancelled", "cancelled by console", false);
  var t = "[MarketPriceAdjustment] Cancelled " + r.id;
  return t;
}

function cancelOneTime() {
  var e = ensureMemory();
  var r = e.oneTimeOperation;
  if (!r) return "[OneTimePriceAdjustment] No operation to cancel.";
  if (oneTimeIsTerminal(r)) {
    return "[OneTimePriceAdjustment] Operation is already " + r.state + ".";
  }
  if (r.pendingDeal || r.transferAttempted) {
    return "[OneTimePriceAdjustment] Cancellation is deferred until the irreversible market or return-transfer step completes.";
  }
  stopOneTime(r, "cancelled", "cancelled by console", false);
  var t = "[OneTimePriceAdjustment] Cancelled " + r.id;
  return t;
}

global.marketPriceAdjustment = start;
global.marketPriceAdjustmentStatus = status;
global.cancelMarketPriceAdjustment = cancel;
global.oneTimePriceAdjustment = startOneTime;
global.oneTimePriceAdjustmentStatus = oneTimeStatus;
global.cancelOneTimePriceAdjustment = cancelOneTime;
module.exports = {
  start: start,
  startOneTime: startOneTime,
  run: run,
  status: status,
  oneTimeStatus: oneTimeStatus,
  cancel: cancel,
  cancelOneTime: cancelOneTime,
  isOneTimePriceAdjustmentOrder: isOneTimePriceAdjustmentOrder,
  isProtectedOrder: isProtectedOrder,
  isSelfTradeTransaction: isSelfTradeTransaction
};
