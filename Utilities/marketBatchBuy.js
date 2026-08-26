// LLM: Read docs/codex.js before reviewing or changing this file.
// marketBatchBuy.js
// Console globals: marketBatchBuy
// Example: marketBatchBuy(RESOURCE_ENERGY, 50000, 10) - Execute batched market buy orders
// Example: require('marketBatchBuy').getOpenJobs();
var memoryManager = require("memoryManager");
var pricing = require("marketPricing");
var creditLedger = require("creditLedger");
var util = require("util");
var storageManager = require("storageManager");
var storageVfs = require("storageVfs");
var MEMORY_VERSION = 1;
var CONFIRMATION_TIMEOUT_TICKS = 60;
var HISTORY_CAP = 20;
var QUEUED_BLOCK_TIMEOUT_TICKS = 1500;
var QUEUED_BLOCK_STALE_TICKS = 200;
var MIN_BATCH_INCREMENT = typeof LAB_REACTION_AMOUNT === "number" && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
var MIN_PARTIAL_BATCH_RATIO = .25;
var STATE_QUEUED = "QUEUED";
var STATE_PENDING = "PENDING";
var STATE_DONE = "DONE";
var STATE_FAILED = "FAILED";
var STATE_CANCELLED = "CANCELLED";
var hydratedMemoryRoot = null;
function requestSave() {
  if (memoryManager && typeof memoryManager.requestSave === "function") memoryManager.requestSave();
}

function requestImmediateSave(e) {
  if (memoryManager && typeof memoryManager.requestImmediateSave === "function") {
    memoryManager.requestImmediateSave(e);
  }
}

function ensureMemory() {
  if (!Memory.marketBatchBuy || Memory.marketBatchBuy.v !== MEMORY_VERSION) {
    Memory.marketBatchBuy = {
      v: MEMORY_VERSION,
      jobs: [],
      history: []
    };
    requestSave();
  }
  if (!Array.isArray(Memory.marketBatchBuy.jobs)) Memory.marketBatchBuy.jobs = [];
  if (!Array.isArray(Memory.marketBatchBuy.history)) Memory.marketBatchBuy.history = [];
  if (hydratedMemoryRoot !== Memory.marketBatchBuy && memoryManager && typeof memoryManager.hydrateMarketBatchBuyRoot === "function") {
    if (memoryManager.hydrateMarketBatchBuyRoot(Memory.marketBatchBuy)) requestSave();
    hydratedMemoryRoot = Memory.marketBatchBuy;
  }
  trimHistory(Memory.marketBatchBuy);
  return Memory.marketBatchBuy;
}

function historyJobReferenced(e) {
  if (!e) return false;
  var r = require("marketLab");
  var a = r && typeof r.getOperations === "function" ? r.getOperations() : [];
  for (var o = 0; o < a.length; o++) {
    var t = a[o];
    if (!t || t.state === "SELLING") continue;
    if (Array.isArray(t.batchBuyIds) && t.batchBuyIds.indexOf(e) !== -1) return true;
  }
  var i = require("marketRefine");
  var n = require("localRefine");
  var c = [];
  if (i && typeof i.getOperations === "function") {
    c = c.concat(i.getOperations());
  }
  if (n && typeof n.getOperations === "function") {
    c = c.concat(n.getOperations());
  }
  for (var s = 0; s < c.length; s++) {
    var u = c[s];
    if (!u) continue;
    if (u.phase === "selling" || u.phase === "done" || u.phase === "failed") continue;
    if (u.batchBuyIds && u.batchBuyIds.indexOf(e) !== -1) return true;
    var m = u.inputs;
    if (!Array.isArray(m)) continue;
    for (var d = 0; d < m.length; d++) {
      if (m[d] && m[d].batchBuyJobId === e) return true;
    }
  }
  return false;
}

function trimHistory(e) {
  if (!e || !Array.isArray(e.history) || e.history.length <= HISTORY_CAP) return false;
  var r = {};
  var a = 0;
  var o = [];
  for (var t = 0; t < e.history.length; t++) {
    var i = e.history[t];
    if (i && historyJobReferenced(i.id)) {
      r[i.id] = true;
      a++;
    } else {
      o.push(i);
    }
  }
  var n = Math.max(0, HISTORY_CAP - a);
  var c = o.slice(-n);
  var s = {};
  for (var u = 0; u < c.length; u++) {
    if (c[u] && c[u].id) s[c[u].id] = true;
  }
  var m = [];
  for (var d = 0; d < e.history.length; d++) {
    var l = e.history[d];
    if (l && (r[l.id] || s[l.id])) m.push(l);
  }
  if (m.length === e.history.length) return false;
  e.history = m;
  requestSave();
  return true;
}

function makeId(e, r) {
  return "bb_" + e + "_" + r + "_" + Game.time + "_" + Math.random().toString(36).substr(2, 7);
}

function findJob(e) {
  var r = ensureMemory();
  for (var a = 0; a < r.jobs.length; a++) {
    if (r.jobs[a] && r.jobs[a].id === e) return r.jobs[a];
  }
  for (var o = r.history.length - 1; o >= 0; o--) {
    if (r.history[o] && r.history[o].id === e) return r.history[o];
  }
  return null;
}

function isOpen(e) {
  return !!(e && (e.state === STATE_QUEUED || e.state === STATE_PENDING));
}

function moveToHistory(e) {
  var r = ensureMemory();
  for (var a = r.jobs.length - 1; a >= 0; a--) {
    if (r.jobs[a] && r.jobs[a].id === e.id) r.jobs.splice(a, 1);
  }
  r.history.push(memoryManager.compactMarketBatchBuyJob(e));
  trimHistory(r);
}

function reservationProgramFor(e) {
  if (!e) return null;
  if (!e.reservationProgram) e.reservationProgram = "marketBatchBuy_" + e.id;
  return e.reservationProgram;
}

function releaseCapacity(e) {
  if (!e || !e.capacityLockId) return;
  try {
    storageVfs.unlockCapacity(e.capacityLockId);
  } catch (e) {}
  e.capacityLockId = null;
}

function recordCapacityDelivery(e, r) {
  if (!e || !(r >= 0)) return;
  var a = typeof e.capacityDelivered === "number" ? e.capacityDelivered : 0;
  var o = Math.max(0, r - a);
  e.capacityDelivered = r;
  if (!e.capacityLockId) return;
  try {
    if (o > 0) {
      var t = storageVfs.reduceCapacity(e.capacityLockId, o);
      if (!t.ok || t.remainingCapacity === 0) e.capacityLockId = null;
    } else {
      var i = storageVfs.touchCapacity(e.capacityLockId, storageVfs.TTL_QUEUED);
      if (!i.ok) e.capacityLockId = null;
    }
  } catch (e) {}
}

function getReservationAmount(e) {
  if (!e || !e.roomName || !e.resourceType) return 0;
  var r = reservationProgramFor(e);
  var a = storageManager.storageFind(e.roomName, e.resourceType);
  var o = 0;
  var t = a ? [ a.terminal, a.storage ] : [];
  for (var i = 0; i < t.length; i++) {
    var n = t[i] && t[i].reservations || [];
    for (var c = 0; c < n.length; c++) {
      if (n[c] && n[c].program === r) {
        o += n[c].amount || 0;
      }
    }
  }
  return o;
}

function isOrderReserved(e) {
  if (!e) return false;
  var r = ensureMemory();
  for (var a = 0; a < r.jobs.length; a++) {
    var o = r.jobs[a];
    if (o && isOpen(o) && o.orderId === e) return true;
  }
  return false;
}

function reserveDeliveredMaterial(e) {
  if (!e || !(e.amount > 0)) return {
    ok: false,
    reason: "invalid batch amount"
  };
  var r = Game.rooms[e.roomName];
  var a = r && r.terminal;
  var o = a && a.store ? a.store[e.resourceType] || 0 : 0;
  var t = Math.min(e.amount, e.deliveredAmount > 0 ? e.deliveredAmount : e.amount);
  if (o < t) {
    return {
      ok: false,
      pending: true,
      reason: "terminal has " + o + "/" + t
    };
  }
  var i = reservationProgramFor(e);
  var n = storageManager.reserve(e.roomName, e.resourceType, "terminal", i, t);
  if (!n || !n.ok) return n || {
    ok: false,
    reason: "batch reservation failed"
  };
  e.reservationTick = Game.time;
  delete e.reservationPending;
  return {
    ok: true
  };
}

function releaseReservation(e, r) {
  var a = findJob(e);
  if (!a) return {
    ok: false,
    removed: 0,
    reason: "batch job not found"
  };
  releaseCapacity(a);
  var o = reservationProgramFor(a);
  var t = storageManager.unReserve(a.roomName, a.resourceType, "terminal", o);
  var i = storageManager.unReserve(a.roomName, a.resourceType, "storage", o);
  var n = (t.removed || 0) + (i.removed || 0);
  if (n > 0) {
    a.reservationReleasedTick = Game.time;
    if (r) a.reservationReleaseReason = String(r).slice(0, 160);
    requestSave();
  }
  return {
    ok: n > 0,
    removed: n
  };
}

function reserveJob(e) {
  var r = findJob(e);
  if (!r || r.state !== STATE_DONE) {
    return {
      ok: false,
      reason: "batch job is not complete"
    };
  }
  var a = reserveDeliveredMaterial(r);
  if (a.ok) requestSave();
  return a;
}

function failJob(e, r) {
  if (!e || !isOpen(e)) return;
  releaseCapacity(e);
  e.state = STATE_FAILED;
  e.failedTick = Game.time;
  e.reason = String(r || "batch purchase failed").slice(0, 240);
  moveToHistory(e);
  requestImmediateSave("marketBatchBuy.failed");
  console.log("[BatchBuy] FAILED " + e.id + ": " + e.reason);
}

function finishJob(e) {
  var r = reserveDeliveredMaterial(e);
  if (!r.ok) {
    e.reservationPending = true;
    e.reservationReason = r.reason || "batch material is not reservable yet";
    requestSave();
    return false;
  }
  e.state = STATE_DONE;
  e.confirmedTick = Game.time;
  var a = Math.min(e.amount, e.deliveredAmount > 0 ? e.deliveredAmount : e.amount);
  e.fulfilled = a;
  recordCapacityDelivery(e, a);
  releaseCapacity(e);
  if (e.economicsJobId) {
    try {
      var o = require("marketEconomics");
      var t = e.energyPrice || pricing.getStatusEnergyPrice() || 0;
      o.recordBuy(e.economicsJobId, e.resourceType, a, e.ownOrder ? 0 : a * e.orderPrice, e.energyCost || 0, (e.energyCost || 0) * t);
      if (e.ownOrder && typeof o.recordOwnedOpportunity === "function") {
        o.recordOwnedOpportunity(e.economicsJobId, e.resourceType, a, a * e.orderPrice);
      }
    } catch (e) {}
  }
  moveToHistory(e);
  requestImmediateSave("marketBatchBuy.confirmed");
  console.log("[BatchBuy] CONFIRMED " + a + "/" + e.amount + " " + e.resourceType + " in " + e.roomName + " @ " + e.orderPrice.toFixed(3) + " (" + e.energyCost + " energy)");
  return true;
}

function findIncomingTransaction(e) {
  var r = Game.market && Game.market.incomingTransactions;
  if (!r) return null;
  for (var a = 0; a < r.length; a++) {
    var o = r[a];
    if (!o || o.time < e.pending.tick) continue;
    if (o.to !== e.roomName || o.resourceType !== e.resourceType) continue;
    if (!(o.amount > 0)) continue;
    if (o.order && o.order.id && o.order.id !== e.orderId) continue;
    return o;
  }
  return null;
}

function reconcilePending(e) {
  if (!e || e.state !== STATE_PENDING || !e.pending) return;
  var r = Game.rooms[e.roomName];
  var a = r && r.terminal;
  var o = findIncomingTransaction(e);
  if (o) e.deliveredAmount = Math.min(e.amount, o.amount);
  var t = !!e.pending.confirmed || !!o;
  if (!t && a) {
    var i = e.pending.preAmount || 0;
    var n = a.store[e.resourceType] || 0;
    t = n - i >= e.amount;
    if (t) e.deliveredAmount = e.amount;
  }
  recordCapacityDelivery(e, Math.min(e.amount, e.deliveredAmount || 0));
  if (t) {
    e.pending.confirmed = true;
    if (finishJob(e)) {
      if (e.cancelAfterPending) {
        e.reason = "purchase confirmed after owner cancellation; input remains available for sell-back";
        releaseReservation(e.id, "owner cancelled before purchase confirmation");
        requestImmediateSave("marketBatchBuy.cancelledPending");
      }
      return;
    }
  }
  if (Game.time - e.pending.tick > CONFIRMATION_TIMEOUT_TICKS) {
    e.state = STATE_FAILED;
    e.failedTick = Game.time;
    e.reason = e.pending.confirmed ? "delivery confirmed but the material left the terminal before it could be reserved" + (e.reservationReason ? " (" + e.reservationReason + ")" : "") : "deal confirmation timed out; transaction held for manual reconciliation";
    e.ambiguous = !e.pending.confirmed;
    releaseCapacity(e);
    moveToHistory(e);
    requestImmediateSave("marketBatchBuy.ambiguous");
    console.log("[BatchBuy] " + (e.ambiguous ? "AMBIGUOUS " : "UNRESERVABLE ") + e.id + ": " + e.reason);
  }
}

function operationBuysResource(e, r) {
  if (!e || e._completed || e._failed || e._finalized) return false;
  if (e.state !== "BUYING" && e.state !== "WAITING" && !(e.state === "PROCESSING" && !e.reactionStarted)) return false;
  if (e.direction === "reverse") return e.targetCompound === r;
  return e.reagents && (e.reagents[0] === r || e.reagents[1] === r);
}

function hasActiveCommodityBuy(e, r) {
  var a = require("marketLab");
  var o = a && typeof a.getRoomOperations === "function" ? a.getRoomOperations(e) : [];
  for (var t = 0; t < o.length; t++) {
    if (operationBuysResource(o[t], r)) return true;
  }
  var i = require("marketRefine");
  var n = i && typeof i.getOperations === "function" ? i.getOperations() : [];
  for (var c = 0; c < n.length; c++) {
    var s = n[c];
    if (!s || s.room !== e || s.phase !== "buying" || !Array.isArray(s.inputs)) continue;
    for (var u = 0; u < s.inputs.length; u++) {
      if (s.inputs[u] && s.inputs[u].resource === r && !s.inputs[u].useMarketSell) return true;
    }
  }
  var m = require("opportunisticBuy");
  var d = m && typeof m.getActiveRequestRecords === "function" ? m.getActiveRequestRecords() : [];
  for (var l = 0; l < d.length; l++) {
    var f = d[l];
    if (!f || f.roomName !== e || f.resourceType !== r) continue;
    if ((f.remaining || 0) > 0 || f.pending && typeof f.pending.expected === "number") return true;
  }
  return false;
}

function create(e) {
  e = e || {};
  if (!e.roomName || !e.resourceType || !(e.amount > 0) || !e.orderId || !(e.orderPrice > 0) || !e.orderRoomName) {
    return {
      ok: false,
      reason: "invalid batch purchase specification"
    };
  }
  if (hasActiveCommodityBuy(e.roomName, e.resourceType)) {
    return {
      ok: false,
      reason: "room already has an active buy for " + e.resourceType
    };
  }
  var r = ensureMemory();
  for (var a = 0; a < r.jobs.length; a++) {
    var o = r.jobs[a];
    if (o && isOpen(o) && e.ownerId && o.ownerId === e.ownerId && o.resourceType === e.resourceType) {
      return {
        ok: true,
        id: o.id,
        existing: true,
        job: o
      };
    }
  }
  var t = e.id || makeId(e.roomName, e.resourceType);
  var i = {
    id: t,
    state: STATE_QUEUED,
    roomName: e.roomName,
    resourceType: e.resourceType,
    amount: Math.floor(e.amount),
    orderId: e.orderId,
    orderRoomName: e.orderRoomName,
    orderPrice: e.orderPrice,
    maxPrice: typeof e.maxPrice === "number" ? e.maxPrice : e.orderPrice,
    energyCost: Math.max(0, Math.floor(e.energyCost || 0)),
    energyPrice: e.energyPrice > 0 ? e.energyPrice : pricing.getStatusEnergyPrice() || 0,
    totalCredits: Math.max(0, Math.floor(e.amount * e.orderPrice)),
    queue: e.queue || "default",
    ownerId: e.ownerId || null,
    economicsJobId: e.economicsJobId || null,
    reservationProgram: e.reservationProgram || "marketBatchBuy_" + t,
    createdTick: Game.time,
    attempts: 0,
    fulfilled: 0
  };
  if (!(i.amount > 0)) return {
    ok: false,
    reason: "batch amount rounds to zero"
  };
  i = memoryManager.compactMarketBatchBuyJob(i);
  r.jobs.push(i);
  requestImmediateSave("marketBatchBuy.created");
  console.log("[BatchBuy] QUEUED " + i.amount + " " + i.resourceType + " in " + i.roomName + " from " + i.orderRoomName + " @ " + i.orderPrice.toFixed(3));
  return {
    ok: true,
    id: i.id,
    job: i
  };
}

function cancel(e, r) {
  var a = findJob(e);
  if (!a || !isOpen(a)) return false;
  if (a.state === STATE_PENDING) {
    a.cancelAfterPending = true;
    a.reason = String(r || "cancelled").slice(0, 240);
    requestImmediateSave("marketBatchBuy.cancelAfterPending");
    return true;
  }
  releaseCapacity(a);
  a.state = STATE_CANCELLED;
  a.cancelledTick = Game.time;
  a.reason = String(r || "cancelled").slice(0, 240);
  moveToHistory(a);
  requestSave();
  return true;
}

function blockJob(e, r) {
  if (e.blockedReason !== r) {
    e.blockedReason = r;
    e.blockedSince = Game.time;
  }
  e.blockedTick = Game.time;
  requestSave();
}

function noteContention(e, r) {
  if (!e.blockedSince) e.blockedReason = r;
}

function clearBlock(e) {
  if (e.blockedReason || e.blockedSince) {
    delete e.blockedReason;
    delete e.blockedSince;
    delete e.blockedTick;
  }
}

function processJob(e) {
  if (!e || e.state !== STATE_QUEUED) return;
  if (e.blockedSince && Game.time - (e.blockedTick || e.blockedSince) > QUEUED_BLOCK_STALE_TICKS) {
    clearBlock(e);
  } else if (e.blockedSince && Game.time - e.blockedSince > QUEUED_BLOCK_TIMEOUT_TICKS) {
    failJob(e, "batch purchase blocked for " + (Game.time - e.blockedSince) + " ticks: " + e.blockedReason);
    return;
  }
  var r = Game.rooms[e.roomName];
  var a = r && r.terminal;
  if (!r || !a || !r.controller || !r.controller.my) {
    blockJob(e, "destination room is not visible or not owned");
    return;
  }
  if (a.cooldown > 0 || util.wasTerminalUsed(e.roomName)) {
    noteContention(e, "terminal already used this tick or on cooldown");
    return;
  }
  var o = Game.market.getOrderById(e.orderId);
  if (!o || o.type !== ORDER_SELL || o.resourceType !== e.resourceType || o.roomName !== e.orderRoomName) {
    failJob(e, "sell order disappeared");
    return;
  }
  var t = util.getOrderRemaining(o);
  if (t < e.amount) {
    var i = e.requestedAmount > 0 ? e.requestedAmount : e.amount;
    var n = Math.floor(t / MIN_BATCH_INCREMENT) * MIN_BATCH_INCREMENT;
    if (n < Math.ceil(i * MIN_PARTIAL_BATCH_RATIO)) {
      failJob(e, "sell order has only " + t + " left of the requested " + i);
      return;
    }
    if (n !== e.amount) {
      e.requestedAmount = i;
      e.amount = n;
      releaseCapacity(e);
      requestSave();
      console.log("[BatchBuy] RESIZED " + e.id + " " + e.resourceType + " " + i + " -> " + n + " (order has " + t + " left)");
    }
  }
  if (o.price > e.maxPrice + 5e-4) {
    failJob(e, "sell order repriced above batch ceiling");
    return;
  }
  if (o.roomName === e.roomName) {
    failJob(e, "sell order is in the destination room; use local inventory instead of a self-transfer");
    return;
  }
  var c = e.amount;
  var s = a.store.getFreeCapacity ? a.store.getFreeCapacity() : 0;
  if (s < c) {
    blockJob(e, "terminal has " + s + " free capacity, needs " + c);
    return;
  }
  if (e.capacityLockId) {
    var u = storageVfs.touchCapacity(e.capacityLockId, storageVfs.TTL_QUEUED);
    if (!u.ok) e.capacityLockId = null;
  }
  if (!e.capacityLockId) {
    var m = storageVfs.lockCapacity("/rooms/" + e.roomName + "/terminal/" + e.resourceType, {
      program: "marketBatchBuy",
      ownerId: e.capacityOwnerId || e.id,
      capacity: c,
      ttl: storageVfs.TTL_QUEUED
    });
    if (!m.ok) {
      blockJob(e, "terminal capacity lock refused: " + (m.reason || "no free capacity"));
      return;
    }
    e.capacityLockId = m.capacityLockId;
    e.capacityOwnerId = e.capacityOwnerId || e.id;
  }
  var d = util.calcTransactionCost(c, e.roomName, o.roomName);
  var l = a.store[RESOURCE_ENERGY] || 0;
  if (d > l) {
    blockJob(e, "terminal has " + l + " energy, transfer needs " + d);
    return;
  }
  var f = !!(util.getMyRooms && util.getMyRooms()[o.roomName]);
  var y = c * o.price;
  if (!f && creditLedger.available() < y) {
    blockJob(e, "needs " + Math.ceil(y) + " credits, ledger has " + Math.floor(creditLedger.available()));
    return;
  }
  e.attempts = (e.attempts || 0) + 1;
  var v = a.store[e.resourceType] || 0;
  var p = Game.market.deal(o.id, c, e.roomName);
  if (p !== OK) {
    releaseCapacity(e);
    if (p === ERR_NOT_FOUND || p === ERR_INVALID_ARGS) {
      failJob(e, "deal rejected because the sell order is no longer valid (" + p + ")");
    }
    return;
  }
  if (!f) creditLedger.commit(y);
  e.ownOrder = f;
  e.orderPrice = o.price;
  e.totalCredits = y;
  e.energyCost = d;
  e.pending = {
    tick: Game.time,
    preAmount: v,
    expected: c
  };
  e.state = STATE_PENDING;
  clearBlock(e);
  util.markTerminalUsed(e.roomName);
  requestImmediateSave("marketBatchBuy.deal");
  console.log("[BatchBuy] DEAL " + c + " " + e.resourceType + " in " + e.roomName + " from " + o.roomName + " @ " + o.price.toFixed(3) + " (" + d + " energy)" + (f ? " [OWN ROOM]" : ""));
}

function run() {
  var e = ensureMemory();
  for (var r = e.jobs.length - 1; r >= 0; r--) reconcilePending(e.jobs[r]);
  var a = e.jobs.slice().sort(function(e, r) {
    return (e.createdTick || 0) - (r.createdTick || 0);
  });
  for (var o = 0; o < a.length; o++) processJob(a[o]);
}

function getOpenJobs(e) {
  var r = ensureMemory();
  return r.jobs.filter(function(r) {
    return r && isOpen(r) && (!e || r.queue === e);
  });
}

module.exports = {
  create: create,
  cancel: cancel,
  find: findJob,
  reserve: reserveJob,
  releaseReservation: releaseReservation,
  getReservationAmount: function(e) {
    return getReservationAmount(findJob(e));
  },
  isOrderReserved: isOrderReserved,
  run: run,
  getOpenJobs: getOpenJobs,
  STATE_QUEUED: STATE_QUEUED,
  STATE_PENDING: STATE_PENDING,
  STATE_DONE: STATE_DONE,
  STATE_FAILED: STATE_FAILED,
  STATE_CANCELLED: STATE_CANCELLED
};
global.marketBatchBuy = module.exports;
