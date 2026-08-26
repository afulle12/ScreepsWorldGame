// LLM: Read docs/codex.js before reviewing or changing this file.
// labCommodityRouter.js
// Console globals: labCommodityStatus, reconcileRestrictedOpportunisticRequests
// Example: labCommodityStatus('E1N1') - Display lab commodity router status and queues
// Example: reconcileRestrictedOpportunisticRequests('E1N1') - Reconcile opportunistic lab requests
// Example: labCommodityStatus();
var policy = require("labCommodityPolicy");
var pricing = require("marketPricing");
var util = require("util");
var opportunisticSell = require("opportunisticSell");
var storageManager = require("storageManager");
var terminalManager = require("terminalManager");
var memoryManager = require("memoryManager");
var MAX_ENTRIES_PER_RUN = 3;
var MAX_CONVERSION_BATCH = 3e3;
var MIGRATION_PENDING_TICKS = 200;
var QUEUE_ENTRY_TTL = 2e4;
var QUEUE_SCAN_INTERVAL = 100;
var lastQueuePruneTick = 0;
var QUEUE_KEY = "labCommodityQueue";
var CURSOR_KEY = "labCommodityQueueCursor";
var MIGRATION_KEY = "labCommodityOrderMigration";
var queueKeysTick = -1;
var queueKeysCache = null;
function ensureMemory() {
  if (!Memory.autoTrader) Memory.autoTrader = {
    enabled: true,
    lastRun: 0,
    jobsStarted: []
  };
  if (!Memory.autoTrader[QUEUE_KEY] || typeof Memory.autoTrader[QUEUE_KEY] !== "object" || Array.isArray(Memory.autoTrader[QUEUE_KEY])) {
    Memory.autoTrader[QUEUE_KEY] = {};
  }
  if (!Memory.autoTrader.labCommoditySourceIndex || typeof Memory.autoTrader.labCommoditySourceIndex !== "object" || Array.isArray(Memory.autoTrader.labCommoditySourceIndex)) {
    Memory.autoTrader.labCommoditySourceIndex = {};
  }
  if (!Memory.autoTrader.labCommodityOperationIndex || typeof Memory.autoTrader.labCommodityOperationIndex !== "object" || Array.isArray(Memory.autoTrader.labCommodityOperationIndex)) {
    Memory.autoTrader.labCommodityOperationIndex = {};
  }
  if (Memory.autoTrader[CURSOR_KEY] !== null && typeof Memory.autoTrader[CURSOR_KEY] !== "string") {
    Memory.autoTrader[CURSOR_KEY] = null;
  }
  return Memory.autoTrader[QUEUE_KEY];
}

function queueKey(e, r) {
  return e + "|" + r;
}

function availableAmount(e, r) {
  var t = Game.rooms[e];
  if (!t) return 0;
  var o = 0;
  var a = storageManager.storageFind(e, r);
  var n = a && a.terminal;
  var i = a && a.storage;
  if (n && typeof n.available === "number") o += n.available; else o += t.terminal && t.terminal.store ? t.terminal.store[r] || 0 : 0;
  if (i && typeof i.available === "number") o += i.available; else o += t.storage && t.storage.store ? t.storage.store[r] || 0 : 0;
  return Math.max(0, o);
}

function energyPrice() {
  var e = pricing.getStatusEnergyPrice();
  return e > 0 ? e : 0;
}

function quoteValue(e, r, t, o) {
  if (!(r > 0)) return null;
  var a = pricing.getConversionExitQuote(e, r, t);
  if (!a || !(a.price > 0)) return null;
  var n = a.source === "LIVE_BID" || a.source === "CROSSED_BID" || a.method === "LIVE_BID" || a.method === "CROSSED_BID";
  if (o && !n) return null;
  return {
    value: a.price * r - (a.transferEnergy || 0) * energyPrice(),
    price: a.price,
    transferEnergy: a.transferEnergy || 0,
    live: n
  };
}

function buyCost(e, r, t) {
  var o = pricing.executableBuyQuote(e, r, t);
  if (!o || !(o.price > 0)) return null;
  return o.price * r + (o.transferEnergy || 0) * energyPrice();
}

function inputCost(e, r, t) {
  var o = Math.min(r, availableAmount(t, e));
  var a = 0;
  if (o > 0) {
    var n = quoteValue(e, o, t, false);
    if (!n) return null;
    a += n.value;
  }
  var i = r - o;
  if (i > 0) {
    var u = buyCost(e, i, t);
    if (u === null) return null;
    a += u;
  }
  return a;
}

function routeCandidates(e, r, t) {
  var o = [];
  var a = pricing.getRestrictedDirectQuote ? pricing.getRestrictedDirectQuote(r, t, e) : null;
  if (a && a.executableAmount > 0) {
    var n = a.totalValue - (a.transferEnergy || 0) * energyPrice();
    o.push({
      type: "direct",
      net: n,
      amount: a.executableAmount
    });
  }
  var i = policy.reactionInputs(r);
  if (i) {
    var u = quoteValue(i[0], t, e, false);
    var s = quoteValue(i[1], t, e, false);
    if (u && s) {
      o.push({
        type: "reverse",
        net: u.value + s.value,
        amount: t,
        compound: r,
        outputQuotes: [ u, s ]
      });
    }
  }
  var c = policy.forwardRoutes(r);
  for (var l = 0; l < c.length; l++) {
    var m = c[l];
    var d = quoteValue(m.product, t, e, false);
    var p = inputCost(m.other, t, e);
    if (!d || p === null) continue;
    o.push({
      type: "forward",
      net: d.value - p,
      amount: t,
      product: m.product,
      other: m.other,
      reagents: m.reagents,
      otherCost: p
    });
  }
  return o;
}

function chooseRoute(e, r, t) {
  var o = routeCandidates(e, r, t);
  if (o.length === 0) return null;
  o.sort(function(e, r) {
    if (r.net !== e.net) return r.net - e.net;
    var t = {
      direct: 3,
      reverse: 2,
      forward: 1
    };
    return t[r.type] - t[e.type];
  });
  return o[0].net > 0 ? o[0] : null;
}

function quoteExit(e, r, t) {
  if (!policy.isTwoLetterLabProduct(r) || !(t > 0)) return null;
  var o = chooseRoute(e, r, t);
  if (!o) return null;
  return {
    type: o.type,
    net: o.net,
    amount: o.amount,
    product: o.product || null,
    other: o.other || null,
    compound: o.compound || null,
    reagents: o.reagents || null
  };
}

function reserveInput(e, r, t, o) {
  var a = storageManager.storageFind(e, r);
  var n = a && a.terminal ? a.terminal : {};
  var i = a && a.storage ? a.storage : {};
  var u = Math.max(0, (n.total || 0) - (n.reserved || 0));
  var s = Math.max(0, (i.total || 0) - (i.reserved || 0));
  var c = Math.min(t, u);
  var l = t - c;
  if (c + Math.min(l, s) < t) return false;
  var m = c > 0 ? storageManager.reserve(e, r, "terminal", o, c) : null;
  if (c > 0 && (!m || !m.ok)) return false;
  var d = l > 0 ? storageManager.reserve(e, r, "storage", o, l) : null;
  if (l > 0 && (!d || !d.ok)) {
    if (c > 0) storageManager.unReserve(e, r, "terminal", o);
    return false;
  }
  return true;
}

function releaseInput(e, r, t) {
  storageManager.unReserve(e, r, "terminal", t);
  storageManager.unReserve(e, r, "storage", t);
}

function stageForDirectSale(e, r, t) {
  var o = Game.rooms[e];
  if (!o || !o.terminal || !(t > 0)) return null;
  var a = storageManager.storageFind(e, r);
  var n = a && a.terminal && typeof a.terminal.available === "number" ? a.terminal.available : o.terminal.store[r] || 0;
  var i = Math.max(0, t - n);
  if (i > 0 && typeof terminalManager.storageToTerminal === "function") {
    var u = terminalManager.storageToTerminal(e, r, i);
    return u && u.opId ? u.opId : null;
  }
  return null;
}

function activeConversion(e) {
  if (!e || !e.operationId) return false;
  var r = require("marketLab");
  var t = r && typeof r.getRoomOperations === "function" ? r.getRoomOperations(e.roomName) : [];
  for (var o = 0; o < t.length; o++) {
    if (t[o] && t[o].id === e.operationId) return true;
  }
  return false;
}

function findQueueEntry(e, r, t, o) {
  var a = ensureMemory();
  var n = Memory.autoTrader.labCommodityOperationIndex;
  var i = n[e] || n[r];
  if (i && a[i]) {
    var u = a[i];
    if ((!e || u.operationId === e) && (!r || u.jobId === r) && (!t || u.roomName === t) && (!o || u.resourceType === o)) {
      return {
        key: i,
        entry: u
      };
    }
  }
  for (var s in a) {
    var c = a[s];
    if (!c) continue;
    if (t && c.roomName !== t) continue;
    if (o && c.resourceType !== o) continue;
    if (e && c.operationId === e || r && c.jobId === r) {
      if (e) n[e] = s;
      if (r) n[r] = s;
      return {
        key: s,
        entry: c
      };
    }
  }
  return null;
}

function hasPendingSource(e) {
  if (!e) return false;
  var r = ensureMemory();
  var t = Memory.autoTrader.labCommoditySourceIndex;
  var o = t[e];
  var a = o && r[o];
  if (a && (a.sourceOperationId === e || a.sourceOperations && a.sourceOperations[e])) return true;
  for (var n in r) {
    var i = r[n];
    if (!i) continue;
    if (i.sourceOperationId === e || i.sourceOperations && i.sourceOperations[e]) {
      t[e] = n;
      return true;
    }
  }
  if (o) delete t[e];
  return false;
}

function removeQueueEntry(e) {
  var r = ensureMemory();
  var t = r[e];
  if (t && t.sourceOperations) {
    for (var o in t.sourceOperations) {
      if (Memory.autoTrader.labCommoditySourceIndex[o] === e) {
        delete Memory.autoTrader.labCommoditySourceIndex[o];
      }
    }
  }
  if (t && t.sourceOperationId && Memory.autoTrader.labCommoditySourceIndex[t.sourceOperationId] === e) {
    delete Memory.autoTrader.labCommoditySourceIndex[t.sourceOperationId];
  }
  if (t && t.operationId && Memory.autoTrader.labCommodityOperationIndex[t.operationId] === e) {
    delete Memory.autoTrader.labCommodityOperationIndex[t.operationId];
  }
  if (t && t.jobId && Memory.autoTrader.labCommodityOperationIndex[t.jobId] === e) {
    delete Memory.autoTrader.labCommodityOperationIndex[t.jobId];
  }
  delete r[e];
}

function markConversionStarted(e, r) {
  var t = findQueueEntry(e, r);
  if (!t) return false;
  t.entry.reactionStarted = true;
  memoryManager.requestSave();
  return true;
}

function settleConversion(e, r, t) {
  if (!e || !e.conversionOnly) return false;
  var o = findQueueEntry(e.id || e.operationId, e.jobId, r, e.conversionResource || e.handoffInputResource);
  if (!o) return false;
  var a = o.entry;
  var n = !!(e.reactionStarted || a.reactionStarted);
  var i = availableAmount(a.roomName, a.resourceType);
  var u = i;
  var s = getDirectSaleRequest(a);
  var c = !!(s && ((s.remaining || 0) > 0 || s.pending));
  var l = c ? Math.max(1, s.remaining || 0) : 0;
  var m = Math.max(u, l);
  var d = n ? "conversion " + t + " residual inventory" : "conversion " + t + " before reaction";
  var p = a.sourceOperations;
  removeQueueEntry(o.key);
  if (u > 0) enqueue(a.roomName, a.resourceType, u, d);
  if ((u > 0 || c) && (p || c)) {
    var f = ensureMemory();
    var v = queueKey(a.roomName, a.resourceType);
    var y = f[v];
    if (!y) {
      y = f[v] = {
        roomName: a.roomName,
        resourceType: a.resourceType,
        amount: 0,
        reason: d,
        created: Game.time
      };
    }
    if (c) {
      y.directSale = true;
      y.route = "direct";
      y.amount = Math.max(y.amount || 0, l);
    }
    if (p && typeof p === "object" && !Array.isArray(p)) {
      y.sourceOperations = {};
      var g = m;
      for (var b in p) {
        if (!(g > 0)) break;
        var I = p[b];
        var O = I && typeof I === "object" ? I.amount : g;
        O = Math.min(O > 0 ? O : g, g);
        if (!(O > 0)) continue;
        y.sourceOperations[b] = {
          jobId: I && typeof I === "object" ? I.jobId : I,
          amount: O
        };
        Memory.autoTrader.labCommoditySourceIndex[b] = v;
        g -= O;
      }
      if (Object.keys(y.sourceOperations).length === 0) {
        delete y.sourceOperations;
      }
    }
  }
  memoryManager.requestImmediateSave("labCommodityRouter.settleConversion");
  return true;
}

function cancelPassiveOrders(e, r) {
  var t = 0;
  var o = Game.market && Game.market.orders || {};
  var a = require("marketSell");
  var n = activeArbitrageOrderIds();
  for (var i in o) {
    var u = o[i];
    if (!u || u.type !== ORDER_SELL || u.roomName !== e || u.resourceType !== r || !(util.getOrderRemaining(u) > 0)) continue;
    if (n[i]) continue;
    if (Game.market.cancelOrder(i) !== OK) continue;
    t++;
    if (a && typeof a.cancelGather === "function") {
      a.cancelGather(i);
    }
  }
  if (t > 0) {
    if (a && typeof a.syncReservations === "function") {
      a.syncReservations();
    }
    console.log("[LabCommodityRouter] Cancelled " + t + " passive SELL order(s) for " + r + " in " + e + ".");
  }
  return t;
}

function activeArbitrageOrderIds() {
  var e = {};
  var r = Memory.marketArbitrage;
  if (!r) return e;
  var t = r.operations || {};
  for (var o in t) {
    var a = t[o];
    if (a && a.sellOrderId) e[a.sellOrderId] = true;
  }
  var n = r.selfArbPending || {};
  for (var i in n) {
    var u = n[i];
    if (u && u.ourSellOrderId) e[u.ourSellOrderId] = true;
  }
  if (r.accountOp && r.accountOp.sellOrderId) e[r.accountOp.sellOrderId] = true;
  return e;
}

function reconcileExistingRestrictedSellOrdersOnce() {
  if (!Game.market || !Game.market.orders) return 0;
  ensureMemory();
  var e = Memory.autoTrader;
  var r = e[MIGRATION_KEY];
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    r = e[MIGRATION_KEY] = {
      version: 0,
      pending: {},
      cancelled: 0
    };
  }
  if (!r.pending || typeof r.pending !== "object" || Array.isArray(r.pending)) r.pending = {};
  var t = activeArbitrageOrderIds();
  var o = false;
  var a = 0;
  var n = true;
  if (r.version < 1) {
    var i = require("marketSell");
    var u = null;
    try {
      u = require("marketEconomics");
    } catch (e) {}
    for (var s in Game.market.orders) {
      var c = Game.market.orders[s];
      if (!c || c.type !== ORDER_SELL || !(util.getOrderRemaining(c) > 0) || !policy.isTwoLetterLabProduct(c.resourceType) || !c.roomName || t[s]) continue;
      if (Game.market.cancelOrder(s) !== OK) {
        n = false;
        continue;
      }
      a++;
      r.cancelled = (r.cancelled || 0) + 1;
      var l = queueKey(c.roomName, c.resourceType);
      if (!r.pending[l] || typeof r.pending[l] !== "object" || Array.isArray(r.pending[l])) {
        r.pending[l] = {
          amount: 0,
          created: Game.time
        };
      }
      r.pending[l].amount += util.getOrderRemaining(c);
      if (i && typeof i.cancelGather === "function") i.cancelGather(s);
      if (u && typeof u.releaseSellOrderLots === "function") {
        u.releaseSellOrderLots(s);
      }
      o = true;
    }
    if (n) {
      r.version = 1;
      o = true;
    }
  }
  var m = require("marketSell");
  if (a > 0 && m && typeof m.syncReservations === "function") {
    m.syncReservations();
  }
  var d = 0;
  for (var p in r.pending) {
    var f = p.split("|");
    var v = r.pending[p];
    if (typeof v === "number") {
      v = r.pending[p] = {
        amount: v,
        created: Game.time
      };
      o = true;
    }
    if (f.length !== 2 || !v || typeof v !== "object" || Array.isArray(v) || !(v.amount > 0)) {
      delete r.pending[p];
      o = true;
      continue;
    }
    if (Game.time - (v.created || Game.time) > MIGRATION_PENDING_TICKS) {
      delete r.pending[p];
      o = true;
      continue;
    }
    var y = availableAmount(f[0], f[1]);
    var g = Math.min(v.amount, y);
    if (g > 0) {
      enqueue(f[0], f[1], g, "restricted SELL order migration");
      v.amount -= g;
      d += g;
      o = true;
    }
    if (v.amount <= 0) {
      delete r.pending[p];
      o = true;
    }
  }
  if (o) memoryManager.requestImmediateSave("labCommodityRouter.orderMigration");
  return a + d;
}

function getDirectSaleRequest(e) {
  var r = Memory.opportunisticSell && Memory.opportunisticSell.requests;
  return r && r[e.roomName + "_" + e.resourceType];
}

function getSourceSellMetadata(e, r) {
  var t = e && e.sourceOperations;
  if (!t || typeof t !== "object" || Array.isArray(t) || !(r > 0)) return null;
  var o = {};
  var a = r;
  for (var n in t) {
    var i = t[n];
    var u = i && typeof i === "object" ? i.jobId : null;
    var s = i && typeof i === "object" ? i.amount : a;
    var c = Math.min(a, s > 0 ? s : a);
    if (!u || !(c > 0)) continue;
    o[u] = (o[u] || 0) + c;
    a -= c;
    if (!(a > 0)) break;
  }
  var l = [];
  for (var m in o) {
    l.push({
      jobId: m,
      amount: o[m]
    });
  }
  return l.length > 0 ? {
    jobAllocations: l
  } : null;
}

function setupDirectSale(e, r) {
  var t = stageForDirectSale(e.roomName, e.resourceType, r);
  var o = getSourceSellMetadata(e, r);
  opportunisticSell.setup(e.roomName, e.resourceType, r, true, undefined, o || undefined, true, t);
  e.directSale = true;
  e.amount = r;
  e.route = "direct";
  if (t) e.stagingOpId = t;
  memoryManager.requestSave();
  return false;
}

function reconcileRestrictedOpportunisticRequests() {
  var e = Memory.opportunisticSell && Memory.opportunisticSell.requests;
  if (!e) return 0;
  var r = 0;
  for (var t in e) {
    var o = e[t];
    if (!o || !policy.isTwoLetterLabProduct(o.resourceType)) continue;
    if (o.pending) continue;
    var a = pricing.getRestrictedDirectQuote ? pricing.getRestrictedDirectQuote(o.resourceType, o.remaining || 1, o.roomName) : null;
    var n = a && a.executableAmount > 0;
    var i = a && a.executableAmount >= (o.remaining || 0);
    if (!n || !i) {
      var u = o.roomName;
      var s = o.resourceType;
      var c = queueKey(u, s);
      var l = ensureMemory();
      var m = l[c];
      if (m && m.directSale) {
        delete m.directSale;
        delete m.route;
        if (m.stagingOpId) delete m.stagingOpId;
      }
      var d = opportunisticSell.cancelRequest(u, s);
      r++;
      var p = availableAmount(u, s);
      if (p > 0) {
        enqueue(u, s, p, "restricted sale reconciliation fallback");
      }
    }
  }
  if (r > 0) {
    memoryManager.requestImmediateSave("labCommodityRouter.reconcileRestrictedRequests");
    console.log("[LabCommodityRouter] Reconciled " + r + " restricted direct-sale requests without live buyers.");
  }
  return r;
}

function status() {
  var e = ensureMemory();
  var r = [ "[LabCommodityRouter] Restricted-product status" ];
  var t = 0;
  var o = 0;
  for (var a in e) {
    var n = e[a];
    if (!n) continue;
    t++;
    o += n.amount || 0;
    r.push("  " + n.roomName + " " + n.resourceType + " amount=" + (n.amount || 0) + " route=" + (n.route || "pending") + " operation=" + (n.operationId || "-") + " started=" + (n.reactionStarted ? "yes" : "no"));
  }
  var i = Memory.autoTrader && Memory.autoTrader[MIGRATION_KEY];
  if (i) r.push("  migration version=" + (i.version || 0) + " pending=" + Object.keys(i.pending || {}).length + " cancelled=" + (i.cancelled || 0));
  r.push("  entries=" + t + " queuedAmount=" + o);
  console.log(r.join("\n"));
  return "[LabCommodityRouter] Status printed.";
}

function cancelUncapturedOperation(e, r, t, o) {
  if (!e || typeof e.getRoomOperations !== "function" || typeof e.cancelOperation !== "function") return false;
  var a = e.getRoomOperations(t.roomName) || [];
  for (var n = a.length - 1; n >= 0; n--) {
    var i = a[n];
    if (!i || i.targetCompound !== o || i.tickStarted !== Game.time) continue;
    var u = e.cancelOperation(r.type, t.roomName, i.id, "lab commodity router could not capture operation id");
    return u && u.status !== "missing";
  }
  return false;
}

function startConversion(e, r) {
  var t = require("marketLab");
  var o = require("marketEconomics");
  var a = r.amount;
  var n = e.reservationProgram || "labCommodityConversion_" + String(e.roomName + "|" + e.resourceType).replace(/[^a-zA-Z0-9_]/g, "_");
  if (!reserveInput(e.roomName, e.resourceType, a, n)) return false;
  var i = o.mintJobId();
  o.start(i, {
    kind: "labCommodityConversion",
    room: e.roomName,
    product: r.type === "reverse" ? e.resourceType : r.product,
    expectedNetProfit: r.net,
    expectedElapsedTicks: 1,
    expectedCreditsPerTick: r.net
  });
  o.phase(i, "queued");
  var u = null;
  if (r.type === "forward") {
    u = {};
    var s = pricing.executableBuyQuote(r.other, a, e.roomName);
    var c = pricing.getPriceProfile(r.other);
    u[r.other] = s && s.price > 0 ? s.price : c && c.buyPrice > 0 ? c.buyPrice : undefined;
  }
  var l = {
    conversionOnly: true,
    conversionResource: e.resourceType,
    conversionRoute: r.type,
    conversionAllowPurchase: r.type === "forward",
    batchSize: a,
    handoffInputResource: e.resourceType,
    handoffInputAmount: a,
    handoffInputProgram: n
  };
  var m = r.type === "reverse" ? e.resourceType : r.product;
  var d = t.startAutoOperation(r.type, e.roomName, m, u, i, l);
  var p = r.type === "forward" ? "[labForward] Queued:" : "[labReverse] Queued:";
  if (typeof d !== "string" || d.indexOf(p) !== 0) {
    releaseInput(e.roomName, e.resourceType, n);
    o.finish(i, "refused", "" + d);
    return false;
  }
  var f = typeof t.getNewestOperationId === "function" ? t.getNewestOperationId(r.type, e.roomName, m, Game.time) : null;
  if (!f) {
    cancelUncapturedOperation(t, r, e, m);
    releaseInput(e.roomName, e.resourceType, n);
    o.finish(i, "refused", "operation id was not captured");
    return false;
  }
  o.link(i, "marketLab", f);
  o.phase(i, "buying");
  e.operationId = f;
  e.jobId = i;
  Memory.autoTrader.labCommodityOperationIndex[f] = queueKey(e.roomName, e.resourceType);
  Memory.autoTrader.labCommodityOperationIndex[i] = queueKey(e.roomName, e.resourceType);
  e.reservationProgram = n;
  e.route = r.type;
  e.amount = a;
  memoryManager.requestSave();
  return true;
}

function processEntry(e, r) {
  if (!r || !r.roomName || !r.resourceType) return true;
  if (activeConversion(r)) return false;
  var t = false;
  if (r.directSale) {
    var o = getDirectSaleRequest(r);
    if (o && o.pending) {
      return false;
    }
    var a = pricing.getRestrictedDirectQuote ? pricing.getRestrictedDirectQuote(r.resourceType, r.amount || 1, r.roomName) : null;
    if (!o || !a || a.executableAmount <= 0) {
      if (o && !o.pending && typeof opportunisticSell.cancelRequest === "function") {
        opportunisticSell.cancelRequest(r.roomName, r.resourceType);
      }
      t = true;
      delete r.directSale;
      delete r.route;
      if (r.stagingOpId) delete r.stagingOpId;
      memoryManager.requestSave();
    } else {
      return false;
    }
  }
  if (r.operationId) {
    var n = null;
    if (r.jobId) {
      try {
        n = require("marketEconomics").get(r.jobId);
      } catch (e) {}
    }
    if (n && (n.status === "active" || n.status === "selling")) return false;
    releaseInput(r.roomName, r.resourceType, r.reservationProgram);
    var i = settleConversion({
      id: r.operationId,
      jobId: r.jobId,
      conversionOnly: true,
      conversionResource: r.resourceType,
      handoffInputResource: r.resourceType,
      handoffInputAmount: r.amount,
      reactionStarted: r.reactionStarted
    }, r.roomName, n && n.status === "done" ? "completed" : "failed");
    if (!i) removeQueueEntry(e);
    memoryManager.requestSave();
    return true;
  }
  cancelPassiveOrders(r.roomName, r.resourceType);
  var u = availableAmount(r.roomName, r.resourceType);
  if (!(u > 0)) {
    if (!t && r.sourceOperations && Object.keys(r.sourceOperations).length > 0) return false;
    removeQueueEntry(e);
    return true;
  }
  var s = policy.processableAmount(u);
  var c = policy.remainderAmount(u);
  if (s < policy.MIN_REACTION_AMOUNT) {
    var l = pricing.getRestrictedDirectQuote ? pricing.getRestrictedDirectQuote(r.resourceType, u, r.roomName) : null;
    if (l && l.executableAmount > 0) {
      return setupDirectSale(r, l.executableAmount);
    }
    return false;
  }
  var m = Math.min(s, MAX_CONVERSION_BATCH);
  var d = chooseRoute(r.roomName, r.resourceType, m);
  if (!d) return false;
  if (d.type === "direct") {
    return setupDirectSale(r, d.amount);
  }
  if (c > 0) {
    var p = pricing.getRestrictedDirectQuote ? pricing.getRestrictedDirectQuote(r.resourceType, c, r.roomName) : null;
    if (p && p.executableAmount > 0) {
      var f = stageForDirectSale(r.roomName, r.resourceType, p.executableAmount);
      var v = getSourceSellMetadata(r, p.executableAmount);
      opportunisticSell.setup(r.roomName, r.resourceType, p.executableAmount, true, undefined, v || undefined, true, f);
    }
  }
  return startConversion(r, d);
}

function enqueue(e, r, t, o, a, n) {
  if (!policy.isTwoLetterLabProduct(r) || !(t > 0)) return false;
  var i = ensureMemory();
  var u = queueKey(e, r);
  var s = i[u];
  if (!s) {
    s = i[u] = {
      roomName: e,
      resourceType: r,
      amount: 0,
      reason: o || "inventory",
      created: Game.time
    };
  }
  s.amount = Math.max(s.amount || 0, t);
  s.t = Game.time;
  if (o) s.reason = o;
  if (a) {
    if (!s.sourceOperations || typeof s.sourceOperations !== "object" || Array.isArray(s.sourceOperations)) s.sourceOperations = {};
    s.sourceOperations[a] = {
      jobId: n || null,
      amount: t
    };
    Memory.autoTrader.labCommoditySourceIndex[a] = u;
  }
  memoryManager.requestSave();
  return true;
}

function pruneStaleQueueEntries(e) {
  if (Game.time - lastQueuePruneTick < QUEUE_SCAN_INTERVAL) return 0;
  lastQueuePruneTick = Game.time;
  var __removed = 0;
  var __keys = Object.keys(e);
  for (var __i = 0; __i < __keys.length; __i++) {
    var __entry = e[__keys[__i]];
    var __touched = __entry && (__entry.t || __entry.created);
    if (!__entry || Game.time - (__touched || 0) > QUEUE_ENTRY_TTL) {
      removeQueueEntry(__keys[__i]);
      __removed++;
    }
  }
  var __src = Memory.autoTrader.labCommoditySourceIndex;
  for (var __sid in __src) {
    if (!e[__src[__sid]]) {
      delete __src[__sid];
      __removed++;
    }
  }
  var __ops = Memory.autoTrader.labCommodityOperationIndex;
  for (var __oid in __ops) {
    if (!e[__ops[__oid]]) {
      delete __ops[__oid];
      __removed++;
    }
  }
  if (__removed > 0) {
    queueKeysTick = -1;
    memoryManager.requestSave();
  }
  return __removed;
}

function process() {
  reconcileRestrictedOpportunisticRequests();
  var e = ensureMemory();
  pruneStaleQueueEntries(e);
  if (queueKeysTick !== Game.time || !Array.isArray(queueKeysCache)) {
    queueKeysTick = Game.time;
    queueKeysCache = Object.keys(e);
  }
  var r = queueKeysCache;
  var t = 0;
  var o = 0;
  if (r.length === 0) return 0;
  var a = Memory.autoTrader[CURSOR_KEY];
  var n = a ? r.indexOf(a) + 1 : 0;
  if (n <= 0 || n >= r.length) n = 0;
  for (var i = 0; i < r.length && o < MAX_ENTRIES_PER_RUN; i++) {
    var u = (n + i) % r.length;
    o++;
    Memory.autoTrader[CURSOR_KEY] = r[u];
    if (processEntry(r[u], e[r[u]])) t++;
  }
  if (o > 0) memoryManager.requestSave();
  return t;
}

module.exports = {
  enqueue: enqueue,
  process: process,
  chooseRoute: chooseRoute,
  quoteExit: quoteExit,
  hasPendingSource: hasPendingSource,
  markConversionStarted: markConversionStarted,
  settleConversion: settleConversion,
  reconcileExistingRestrictedSellOrdersOnce: reconcileExistingRestrictedSellOrdersOnce,
  reconcileRestrictedOpportunisticRequests: reconcileRestrictedOpportunisticRequests,
  status: status,
  availableAmount: availableAmount
};
global.labCommodityStatus = status;
global.reconcileRestrictedOpportunisticRequests = reconcileRestrictedOpportunisticRequests;
