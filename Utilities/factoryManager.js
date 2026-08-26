// LLM: Read docs/codex.js before reviewing or changing this file.
// factoryManager.js
// Console globals: orderFactory, cancelFactoryOrder, factoryOrders, listFactoryOrders, showFactories, showAllFactories
// Example: orderFactory('E1N1', RESOURCE_BATTERY, 1000) - Queue factory production order
// Example: cancelFactoryOrder('E1N1', RESOURCE_BATTERY) - Cancel factory production order
// Example: factoryOrders('E1N1') - View active and queued factory orders for room
// Example: listFactoryOrders('E1N1') - List detailed factory order history
// Example: showFactories('E1N1') - Display factory level, cooldown, and storage in room
// Example: showAllFactories() - Display factory status across all empire rooms
//   per room -- a new order for the same room queues behind any
//   in-progress one. Refuses immediately if the room lacks resources for
//   the full amount. E.g. orderFactory('W1N1', 'Oxidant', 1000);
//   orderFactory('W1N1', 'Zynthium bar', 500) queues after it;
//   orderFactory('W2N3', RESOURCE_WIRE, 'max') runs concurrently in W2N3;
//   orderFactory('W1N1', RESOURCE_ENERGY, 5000) decompresses batteries;
//   orderFactory('W1N1', RESOURCE_UTRIUM, 'max') decompresses max utrium bars.
//   ('W1N1_XO_1234567'), all of a room's orders ('W1N1'), or one product in
//   a room ('W1N1', 'Oxidant').
//   backward-compatible alias.
//   order (product/phase/progress/age), queue length, factory stock (total
//   + top 3 resources), needs-supplier flag.
var storageManager = require("storageManager");
var getRoomState = require("getRoomState");
var roomSuspender = require("roomSuspender");
var memoryManager = require("memoryManager");
var economics = require("economics");
var FACTORY_COMPLETIONS_VERSION = 1;
var FACTORY_COMPLETIONS_CAP = 500;
function v2Enabled(e) {
  var r = Game.rooms[e];
  return !!(r && r.controller && r.controller.my);
}

var FACTORY_BROKEN_ORDER_TICKS = 2e4;
var FACTORY_PARTIAL_FALLBACK_TICKS = 100;
function recoverLegacyFailedOrders() {
  var e = false;
  for (var r = 0; r < Memory.factoryOrders.length; r++) {
    var o = Memory.factoryOrders[r];
    if (!o || typeof o !== "object") continue;
    var t = o.status === "failed" || o.status === "error" || o.phase === "failed" || o.phase === "error";
    if (!t) continue;
    releaseOrderReservations(o);
    o.broken = true;
    o.brokenReason = o.brokenReason || "recovered legacy failure state";
    var a = Game.rooms[o.room];
    var n = a ? findFactory(a) : null;
    if (!factoryHasAnyStock(n)) {
      o.status = "cancelled";
      o.phase = "cancelled";
    } else {
      o.status = "active";
      o.phase = "unloading";
    }
    o.lastProgressTick = Game.time;
    e = true;
  }
  if (e) memoryManager.requestSave();
}

function effectiveAvailable(e, r) {
  var o = countInRoom(e, r);
  if (!v2Enabled(e.name)) return o;
  var t = storageManager.storageFind(e.name, r);
  var a = findFactory(e);
  if (a && a.store && (a.store[r] || 0) > 0) {
    o = Math.max(0, o - (a.store[r] || 0));
  }
  if (t && t.combined && typeof t.combined.reserved === "number") {
    return Math.max(0, o - t.combined.reserved);
  }
  return o;
}

function releaseOrderReservations(e) {
  if (!e || !e.reservationProgram) return;
  var r = getRecipe(e.product);
  if (!r) return;
  for (var o in r.inputs) {
    storageManager.unReserve(e.room, o, "terminal", e.reservationProgram);
    storageManager.unReserve(e.room, o, "storage", e.reservationProgram);
  }
}

const RECIPES = Object.freeze({
  [RESOURCE_OXIDANT]: {
    inputs: {
      [RESOURCE_OXYGEN]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_REDUCTANT]: {
    inputs: {
      [RESOURCE_HYDROGEN]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_ZYNTHIUM_BAR]: {
    inputs: {
      [RESOURCE_ZYNTHIUM]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_LEMERGIUM_BAR]: {
    inputs: {
      [RESOURCE_LEMERGIUM]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_UTRIUM_BAR]: {
    inputs: {
      [RESOURCE_UTRIUM]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_KEANIUM_BAR]: {
    inputs: {
      [RESOURCE_KEANIUM]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_GHODIUM_MELT]: {
    inputs: {
      [RESOURCE_GHODIUM]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_PURIFIER]: {
    inputs: {
      [RESOURCE_CATALYST]: 500,
      [RESOURCE_ENERGY]: 200
    },
    out: 100,
    cooldown: 20
  },
  [RESOURCE_BATTERY]: {
    inputs: {
      [RESOURCE_ENERGY]: 600
    },
    out: 50,
    cooldown: 10
  },
  [RESOURCE_UTRIUM]: {
    inputs: {
      [RESOURCE_UTRIUM_BAR]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_LEMERGIUM]: {
    inputs: {
      [RESOURCE_LEMERGIUM_BAR]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_ZYNTHIUM]: {
    inputs: {
      [RESOURCE_ZYNTHIUM_BAR]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_KEANIUM]: {
    inputs: {
      [RESOURCE_KEANIUM_BAR]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_GHODIUM]: {
    inputs: {
      [RESOURCE_GHODIUM_MELT]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_OXYGEN]: {
    inputs: {
      [RESOURCE_OXIDANT]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_HYDROGEN]: {
    inputs: {
      [RESOURCE_REDUCTANT]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_CATALYST]: {
    inputs: {
      [RESOURCE_PURIFIER]: 100,
      [RESOURCE_ENERGY]: 200
    },
    out: 500,
    cooldown: 20
  },
  [RESOURCE_ENERGY]: {
    inputs: {
      [RESOURCE_BATTERY]: 50
    },
    out: 500,
    cooldown: 10
  },
  [RESOURCE_WIRE]: {
    inputs: {
      [RESOURCE_UTRIUM_BAR]: 20,
      [RESOURCE_SILICON]: 100,
      [RESOURCE_ENERGY]: 40
    },
    out: 20,
    cooldown: 8
  },
  [RESOURCE_CELL]: {
    inputs: {
      [RESOURCE_LEMERGIUM_BAR]: 20,
      [RESOURCE_BIOMASS]: 100,
      [RESOURCE_ENERGY]: 40
    },
    out: 20,
    cooldown: 8
  },
  [RESOURCE_ALLOY]: {
    inputs: {
      [RESOURCE_ZYNTHIUM_BAR]: 20,
      [RESOURCE_METAL]: 100,
      [RESOURCE_ENERGY]: 40
    },
    out: 20,
    cooldown: 8
  },
  [RESOURCE_CONDENSATE]: {
    inputs: {
      [RESOURCE_KEANIUM_BAR]: 20,
      [RESOURCE_MIST]: 100,
      [RESOURCE_ENERGY]: 40
    },
    out: 20,
    cooldown: 8
  },
  [RESOURCE_COMPOSITE]: {
    level: 1,
    inputs: {
      [RESOURCE_UTRIUM_BAR]: 20,
      [RESOURCE_ZYNTHIUM_BAR]: 20,
      [RESOURCE_ENERGY]: 20
    },
    out: 20,
    cooldown: 50
  },
  [RESOURCE_CRYSTAL]: {
    level: 2,
    inputs: {
      [RESOURCE_LEMERGIUM_BAR]: 6,
      [RESOURCE_KEANIUM_BAR]: 6,
      [RESOURCE_PURIFIER]: 6,
      [RESOURCE_ENERGY]: 45
    },
    out: 6,
    cooldown: 21
  },
  [RESOURCE_LIQUID]: {
    level: 3,
    inputs: {
      [RESOURCE_OXIDANT]: 12,
      [RESOURCE_REDUCTANT]: 12,
      [RESOURCE_GHODIUM_MELT]: 12,
      [RESOURCE_ENERGY]: 90
    },
    out: 12,
    cooldown: 60
  }
});
function getRecipe(e) {
  if (RECIPES[e]) return RECIPES[e];
  if (typeof COMMODITIES !== "undefined" && COMMODITIES[e]) {
    var r = COMMODITIES[e];
    return {
      inputs: r.components || {},
      out: r.amount || 1,
      level: typeof r.level === "number" ? r.level : undefined,
      cooldown: r.cooldown || 20
    };
  }
  return null;
}

function ensureMemory() {
  if (!Memory.factoryOrders) Memory.factoryOrders = [];
  recoverLegacyFailedOrders();
  var e = Memory.factoryOrderHistory;
  if (!e || e.v !== FACTORY_COMPLETIONS_VERSION || !Array.isArray(e.c)) {
    var r = Array.isArray(e) ? e : [];
    var o = [];
    for (var t = 0; t < r.length; t++) {
      var a = r[t];
      if (a && a.id) o.push([ a.id, a.progressOut || 0 ]);
    }
    Memory.factoryOrderHistory = {
      v: FACTORY_COMPLETIONS_VERSION,
      c: o.slice(-FACTORY_COMPLETIONS_CAP)
    };
    memoryManager.requestSave();
  }
}

function recordCompletedOrder(e) {
  ensureMemory();
  if (!e) return;
  Memory.factoryOrderHistory.c.push([ e.id, e.progressOut || 0 ]);
  if (Memory.factoryOrderHistory.c.length > FACTORY_COMPLETIONS_CAP) {
    Memory.factoryOrderHistory.c = Memory.factoryOrderHistory.c.slice(-FACTORY_COMPLETIONS_CAP);
  }
  memoryManager.requestImmediateSave("factoryManager.completeOrder");
}

function getOrders() {
  ensureMemory();
  return Memory.factoryOrders.map(function(e) {
    return e && typeof e === "object" ? Object.create(e) : null;
  });
}

function findStoredOrderById(e) {
  if (!e) return null;
  for (var r = 0; r < Memory.factoryOrders.length; r++) {
    if (Memory.factoryOrders[r] && Memory.factoryOrders[r].id === e) return Memory.factoryOrders[r];
  }
  return null;
}

function getOrderById(e) {
  ensureMemory();
  var r = findStoredOrderById(e);
  return r && typeof r === "object" ? Object.create(r) : null;
}

function isLiveOrder(e) {
  return !!(e && e.status !== "done" && e.status !== "cancelled" && e.status !== "failed" && e.status !== "error" && e.phase !== "done" && e.phase !== "cancelled" && e.phase !== "failed" && e.phase !== "error");
}

function getCompletedOrderById(e) {
  if (!e) return null;
  ensureMemory();
  var r = Memory.factoryOrderHistory && Memory.factoryOrderHistory.c || [];
  for (var o = 0; o < r.length; o++) {
    var t = r[o];
    if (Array.isArray(t) && t[0] === e) {
      return {
        id: t[0],
        progressOut: t[1] || 0
      };
    }
    if (t && t.id === e) return t;
  }
  return null;
}

function hasOrderAfter(e, r, o) {
  var t = getOrders();
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    if (isLiveOrder(n) && n.room === e && n.product === r && typeof n.created === "number" && n.created >= o) return true;
  }
  return false;
}

function annotateOrder(e, r) {
  if (!e || !r || typeof r !== "object") return false;
  ensureMemory();
  var o = findStoredOrderById(e);
  if (!o) return false;
  for (var t in r) o[t] = r[t];
  memoryManager.requestSave();
  return true;
}

function findFactory(e) {
  if (!e) return null;
  var r = getRoomState.get(e.name);
  var o = r && r.structuresByType && r.structuresByType[STRUCTURE_FACTORY] || [];
  for (var t = 0; t < o.length; t++) {
    if (o[t].my) return o[t];
  }
  return null;
}

function roomOwned(e) {
  return !!(e && e.controller && e.controller.my);
}

function countInRoom(e, r) {
  var o = 0;
  function add(e) {
    if (e && e.store) o += e.store[r] || 0;
  }
  add(e.storage);
  add(e.terminal);
  add(findFactory(e));
  return o;
}

function normalizeProduct(e) {
  if (e && (RECIPES[e] || typeof COMMODITIES !== "undefined" && COMMODITIES[e])) return e;
  if (typeof e === "string") {
    var r = e.trim().toUpperCase();
    var o = {
      ENERGY: RESOURCE_ENERGY,
      RESOURCE_ENERGY: RESOURCE_ENERGY,
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
      BATTERY: RESOURCE_BATTERY,
      UTRIUM: RESOURCE_UTRIUM,
      LEMERGIUM: RESOURCE_LEMERGIUM,
      ZYNTHIUM: RESOURCE_ZYNTHIUM,
      KEANIUM: RESOURCE_KEANIUM,
      GHODIUM: RESOURCE_GHODIUM,
      OXYGEN: RESOURCE_OXYGEN,
      HYDROGEN: RESOURCE_HYDROGEN,
      CATALYST: RESOURCE_CATALYST,
      WIRE: RESOURCE_WIRE,
      CELL: RESOURCE_CELL,
      ALLOY: RESOURCE_ALLOY,
      CONDENSATE: RESOURCE_CONDENSATE,
      COMPOSITE: RESOURCE_COMPOSITE,
      CRYSTAL: RESOURCE_CRYSTAL,
      LIQUID: RESOURCE_LIQUID
    };
    if (o[r]) return o[r];
    if (global[r]) return global[r];
  }
  return null;
}

function batchesFor(e, r) {
  return Math.ceil(e / r.out);
}

function hasMatchingFactoryEffect(e, r) {
  if (!e || !e.effects) return false;
  for (var o = 0; o < e.effects.length; o++) {
    var t = e.effects[o];
    if (t.effect === PWR_OPERATE_FACTORY && t.level === r && (t.ticksRemaining === undefined || t.ticksRemaining > 0)) return true;
  }
  return false;
}

function enoughForOneBatchInFactory(e, r) {
  var o = getRecipe(r);
  if (!o) return false;
  if (o.level) {
    if ((e.level || 0) !== o.level || !hasMatchingFactoryEffect(e, o.level)) return false;
  }
  for (var t in o.inputs) {
    var a = o.inputs[t] || 0;
    var n = e.store && e.store[t] || 0;
    if (n < a) return false;
  }
  return true;
}

function recipeInputTotal(e) {
  var r = 0;
  if (!e || !e.inputs) return r;
  for (var o in e.inputs) r += e.inputs[o] || 0;
  return r;
}

function factoryCapacity(e) {
  if (!e || !e.store || typeof e.store.getCapacity !== "function") return 0;
  return e.store.getCapacity() || 0;
}

function remainingBatchesForOrder(e, r) {
  if (!e || !r) return 0;
  return Math.ceil(Math.max(0, (e.requested || 0) - (e.progressOut || 0)) / Math.max(1, r.out || 1));
}

function maxBatchesPerCycle(e, r, o) {
  var t = factoryCapacity(e);
  var a = recipeInputTotal(r);
  var n = r ? r.out || 0 : 0;
  if (t <= 0 || a <= 0 || n <= 0) return 0;
  if (a + n > t) return 0;
  var i = Math.min(Math.floor((t - n) / a), Math.floor((t - a) / n));
  if (o != null) i = Math.min(i, o);
  return i;
}

function factoryHasNonInputStock(e, r, o) {
  if (!e || !e.store) return false;
  var t = r && r.inputs ? r.inputs : {};
  for (var a in e.store) {
    if ((e.store[a] || 0) <= 0) continue;
    if (a === o) continue;
    if (t[a] !== undefined && t[a] > 0) continue;
    return true;
  }
  return false;
}

function factoryHasAnyStock(e) {
  if (!e || !e.store) return false;
  for (var r in e.store) {
    if ((e.store[r] || 0) > 0) return true;
  }
  return false;
}

function factoryStockTotal(e) {
  if (!e || !e.store) return 0;
  var r = 0;
  for (var o in e.store) r += e.store[o] || 0;
  return r;
}

function prepareCycle(e, r, o) {
  var t = remainingBatchesForOrder(e, o);
  if (t <= 0) return false;
  var a = maxBatchesPerCycle(r, o, t);
  if (a <= 0) return false;
  e.phase = "loading";
  e.cycleBatches = a;
  e.cycleBatchesQueued = 0;
  e.cycleOutputTarget = a * (o.out || 1);
  delete e.cycleProductBaseline;
  e.cycleStartedTick = Game.time;
  e.lastProgressTick = Game.time;
  return true;
}

function recordProducedBatches(e, r, o) {
  if (!e || !r || !(o > 0)) return;
  var t = (r.out || 1) * o;
  var a = {};
  for (var n in r.inputs) a[n] = (r.inputs[n] || 0) * o;
  economics.recordProduction("factory", e.room, e.product, t, a);
  if (e.jobId) {
    try {
      require("marketEconomics").recordProduction(e.jobId, e.product, t, a);
    } catch (e) {}
  }
  e.cycleBatchesQueued = (e.cycleBatchesQueued || 0) + o;
  e.progressOut = (e.progressOut || 0) + t;
  e.lastProduceTick = Game.time;
  e.lastProgressTick = Game.time;
  memoryManager.requestSave();
}

function reconcileProducedBatches(e, r, o) {
  if (!e || !r || !o || r.cycleProductBaseline === undefined) return 0;
  var t = e.store[r.product] || 0;
  var a = Math.floor(Math.max(0, t - r.cycleProductBaseline) / (o.out || 1));
  var n = r.cycleBatchesQueued || 0;
  var i = Math.min(r.cycleBatches || a, a) - n;
  if (i > 0) recordProducedBatches(r, o, i);
  return Math.max(0, i);
}

function prepareProcessingWitness(e, r) {
  if (r.cycleProductBaseline === undefined) {
    r.cycleProductBaseline = e.store[r.product] || 0;
    memoryManager.requestSave();
  }
  r.phase = "ready";
}

function advanceToUnloading(e) {
  e.phase = memoryManager.willSave() ? "unloading" : "unloadingPending";
  memoryManager.requestSave();
}

function advanceToLoading(e) {
  if (memoryManager.willSave()) {
    e.phase = "loading";
    delete e.cycleProductBaseline;
  } else {
    e.phase = "loadingPending";
  }
  memoryManager.requestSave();
}

function resizeCycleToFit(e, r, o) {
  if (!e || !e.cycleBatches) return;
  var t = remainingBatchesForOrder(e, o);
  var a = maxBatchesPerCycle(r, o, t);
  if (a <= 0 || a >= e.cycleBatches) return;
  e.cycleBatches = a;
  e.cycleOutputTarget = a * (o.out || 1);
  if ((e.cycleBatchesQueued || 0) > a) {
    e.cycleBatchesQueued = a;
  }
}

function cycleRemainingBatches(e) {
  return Math.max(0, (e.cycleBatches || 0) - (e.cycleBatchesQueued || 0));
}

function completeBatchesInFactory(e, r) {
  if (!e || !e.store || !r || !r.inputs) return 0;
  var o = Infinity;
  var t = false;
  for (var a in r.inputs) {
    var n = r.inputs[a] || 0;
    if (n <= 0) continue;
    t = true;
    o = Math.min(o, Math.floor((e.store[a] || 0) / n));
  }
  return t && o !== Infinity ? o : 0;
}

function fallbackToLoadedFactoryBatches(e, r, o, t) {
  var a = cycleRemainingBatches(o);
  var n = completeBatchesInFactory(r, t);
  if (a <= 0 || n <= 0 || n >= a) return false;
  if (supplierActiveForRoom(o.room)) return false;
  if (rawBatchesForRoom(e, t) >= a) return false;
  var i = o.lastProgressTick || o.cycleStartedTick || o.created || Game.time;
  if (Game.time - i < FACTORY_PARTIAL_FALLBACK_TICKS) return false;
  o.cycleBatches = (o.cycleBatchesQueued || 0) + n;
  o.cycleOutputTarget = o.cycleBatches * (t.out || 1);
  console.log("[Factory] Partial cycle fallback for " + o.id + " in " + o.room + ": processing " + n + " ready batch(es); remaining inputs unavailable");
  return true;
}

function cycleInputsLoaded(e, r, o) {
  if (!e || !e.store || !r || !o) return false;
  if (!r.cycleBatches) return false;
  if (factoryHasNonInputStock(e, o, r.product)) return false;
  var t = cycleRemainingBatches(r);
  if (t <= 0) return false;
  for (var a in o.inputs) {
    var n = (o.inputs[a] || 0) * t;
    var i = e.store[a] || 0;
    if (i < n) return false;
  }
  if (e.store.getFreeCapacity && (e.store.getFreeCapacity() || 0) < (o.out || 0)) return false;
  return true;
}

function tryProduce(e, r) {
  if (!e || e.cooldown) return false;
  if (!enoughForOneBatchInFactory(e, r.product)) return false;
  var o = e.produce(r.product);
  if (o === OK) {
    var t = getRecipe(r.product);
    if (t) recordProducedBatches(r, t, 1);
    return true;
  }
  if (Game.time % 10 === 0) {
    console.log("[Factory] produce() failed for " + r.product + " in " + r.room + ": " + o + " (cooldown=" + e.cooldown + ", level=" + (e.level || 0) + ")");
  }
  return false;
}

function markBrokenOrder(e, r) {
  if (!e) return;
  e.broken = true;
  e.brokenReason = r || "stuck";
  e.phase = "unloading";
  e.lastProgressTick = Game.time;
  releaseOrderReservations(e);
  memoryManager.requestImmediateSave("factoryManager.breakOrder");
  console.log("[Factory] BROKEN order " + e.id + " in " + e.room + ": " + e.brokenReason);
}

function markActivePerRoom() {
  var e = _.groupBy(Memory.factoryOrders, function(e) {
    return e.room;
  });
  for (var r in e) {
    var o = false;
    var t = e[r];
    for (var a = 0; a < t.length; a++) {
      var n = t[a];
      if (!isLiveOrder(n)) continue;
      if (!o) {
        if (n.status !== "active") n.status = "active";
        o = true;
      } else {
        if (n.status !== "queued") n.status = "queued";
      }
    }
  }
}

function supplierActiveForRoom(e) {
  return _.some(getRoomState.creepIndex().all, function(r) {
    if (!r.memory || r.memory.role !== "supplier") return false;
    if (r.memory.homeRoom !== e) return false;
    if (!r.memory.a) return false;
    return r.memory.a.indexOf("factory_input|") === 0 || r.memory.a.indexOf("factory_output|") === 0 || r.memory.a.indexOf("factory_drain|") === 0;
  });
}

function factoryNeedsWork(e) {
  ensureMemory();
  var r = _.find(Memory.factoryOrders, function(r) {
    return r.room === e && r.status === "active";
  });
  if (!r) return false;
  var o = Game.rooms[e];
  if (!o) return false;
  var t = findFactory(o);
  if (!t) return false;
  var a = getRecipe(r.product);
  if (!a) return false;
  if (r.status !== "active") return false;
  if (r.broken) return false;
  var n = remainingBatchesForOrder(r, a);
  if (n <= 0) return false;
  if (r.phase === "ready" || r.phase === "loadingPending" || r.phase === "unloadingPending") return false;
  if (r.phase === "processing" && cycleInputsLoaded(t, r, a)) {
    return false;
  }
  return !supplierActiveForRoom(e);
}

function orderSummary(e) {
  return "[#" + e.id + "] " + e.room + " -> " + e.product + " | requested: " + e.requested + ", producedOut: " + (e.progressOut || 0) + ", phase: " + (e.phase || "unknown") + ", status: " + e.status;
}

function maxBatchesForRoom(e, r) {
  var o = Infinity;
  for (var t in r.inputs) {
    var a = r.inputs[t] || 0;
    if (a <= 0) continue;
    var n = effectiveAvailable(e, t);
    var i = Math.floor(n / a);
    if (i < o) o = i;
  }
  if (o === Infinity) return 0;
  return o;
}

function rawBatchesForRoom(e, r) {
  var o = Infinity;
  for (var t in r.inputs) {
    var a = r.inputs[t] || 0;
    if (a <= 0) continue;
    o = Math.min(o, Math.floor(countInRoom(e, t) / a));
  }
  return o === Infinity ? 0 : o;
}

global.orderFactory = function(e, r, o) {
  ensureMemory();
  if (o === undefined) o = 100;
  var t = Game.rooms[e];
  if (!t || !roomOwned(t)) return "[Factory] Invalid or not-owned room: " + e;
  var a = normalizeProduct(r);
  var n = a ? getRecipe(a) : null;
  if (!n) return "[Factory] Unknown or unsupported product: " + r;
  var i = findFactory(t);
  if (!i) return "[Factory] No Factory in " + e + ". Build one at RCL7.";
  if (n.level && (i.level || 0) !== n.level) {
    return "[Factory] REFUSED: Factory in " + e + " requires exact level " + n.level + " for " + a + " (current level " + (i.level || 0) + ").";
  }
  var c = recipeInputTotal(n) + (n.out || 0);
  if (factoryCapacity(i) < c) {
    return "[Factory] REFUSED: Factory capacity in " + e + " is too small for one batch of " + a;
  }
  var s;
  var u = typeof o === "string" && o.trim().toLowerCase() === "max";
  if (u) {
    s = maxBatchesForRoom(t, n);
    if (s <= 0) {
      return "[Factory] REFUSED: Not enough inputs in " + e + " for one batch of " + a;
    }
    o = s * n.out;
  } else {
    s = batchesFor(o, n);
  }
  var f = {};
  for (var l in n.inputs) f[l] = (n.inputs[l] || 0) * s;
  var R = [];
  for (var d in f) {
    var E = countInRoom(t, d);
    var m = f[d];
    if (E < m) R.push(d + " " + E + "/" + m);
  }
  if (R.length > 0) {
    return "[Factory] REFUSED: Missing inputs in " + e + " -> " + R.join(", ");
  }
  var O = e + "_" + a + "_" + Game.time;
  var y = {
    id: O,
    room: e,
    product: a,
    requested: o,
    status: "queued",
    created: Game.time,
    phase: "loading",
    cycleBatches: 0,
    cycleBatchesQueued: 0,
    cycleOutputTarget: 0,
    progressOut: 0,
    lastProduceTick: 0,
    lastProgressTick: 0
  };
  if (v2Enabled(e)) {
    y.reservationProgram = "factoryManager_" + a + "_" + O + "_" + Math.random().toString(36).substr(2, 6);
    var v = [];
    var p = true;
    for (var g in f) {
      var S = storageManager.storageFind(e, g);
      var U = S.terminal.total - S.terminal.reserved;
      var M = S.storage.total - S.storage.reserved;
      var m = f[g];
      if (U + M < m) {
        p = false;
        break;
      }
      var C = Math.min(m, U);
      var _ = m - C;
      if (C > 0) {
        var h = storageManager.reserve(e, g, "terminal", y.reservationProgram, C);
        v.push({
          r: g,
          b: "terminal"
        });
        if (!h.ok) {
          p = false;
          break;
        }
      }
      if (_ > 0) {
        var I = storageManager.reserve(e, g, "storage", y.reservationProgram, _);
        v.push({
          r: g,
          b: "storage"
        });
        if (!I.ok) {
          p = false;
          break;
        }
      }
    }
    if (!p) {
      for (var T = 0; T < v.length; T++) {
        storageManager.unReserve(e, v[T].r, v[T].b, y.reservationProgram);
      }
      delete y.reservationProgram;
      return "[Factory] REFUSED: Insufficient unreserved inputs in " + e + " for " + a;
    }
  }
  Memory.factoryOrders.push(y);
  memoryManager.requestImmediateSave("factoryManager.createOrder");
  markActivePerRoom();
  return "[Factory] Order accepted. " + orderSummary(y);
};
global.cancelFactoryOrder = function(e, r) {
  ensureMemory();
  if (!Memory.factoryOrders.length) return "[Factory] No orders.";
  var o = 0;
  function cancelOne(e) {
    if (e.reservationProgram) releaseOrderReservations(e);
    o++;
  }
  if (r) {
    var t = normalizeProduct(r);
    Memory.factoryOrders = Memory.factoryOrders.filter(function(r) {
      var o = (r.id === e || r.room === e) && r.product === t;
      if (o) cancelOne(r);
      return !o;
    });
  } else {
    Memory.factoryOrders = Memory.factoryOrders.filter(function(r) {
      var o = r.id === e || r.room === e;
      if (o) cancelOne(r);
      return !o;
    });
  }
  markActivePerRoom();
  if (o) memoryManager.requestImmediateSave("factoryManager.cancelOrder");
  return o ? "[Factory] Cancelled " + o + " order(s)." : "[Factory] No matching orders.";
};
global.factoryOrders = function(e) {
  return global.listFactoryOrders(e);
};
global.listFactoryOrders = function(e) {
  ensureMemory();
  var r = Memory.factoryOrders;
  if (!r.length) return "[Factory] No active orders.";
  if (e) {
    r = r.filter(function(r) {
      return r.room === e;
    });
    if (!r.length) return "[Factory] No active orders in " + e + ".";
  }
  return r.map(orderSummary).join("\n");
};
global.showFactories = function(e) {
  if (typeof e !== "string") return "[Factory] Usage: showFactories(roomName)";
  ensureMemory();
  var r = Game.rooms[e];
  if (!r || !roomOwned(r)) return "[Factory] " + e + " — no vision or not owned";
  var o = findFactory(r);
  var t = [];
  if (!o) {
    t.push("factory: none");
  } else {
    var a = factoryStockTotal(o);
    var n = [];
    if (o.store) {
      for (var i in o.store) {
        var c = o.store[i] || 0;
        if (c > 0) n.push([ i, c ]);
      }
    }
    n.sort(function(e, r) {
      return r[1] - e[1];
    });
    var s = n.slice(0, 3).map(function(e) {
      return e[0] + ":" + e[1];
    }).join(", ") || "—";
    t.push("factory stock: " + a + " (top: " + s + ")");
  }
  var u = Memory.factoryOrders.filter(function(r) {
    return r.room === e;
  });
  var f = _.find(u, function(e) {
    return e.status === "active";
  });
  var l = _.filter(u, function(e) {
    return e.status === "queued";
  }).length;
  if (f) {
    var R = f.phase || "unknown";
    var d = f.progressOut || 0;
    var E = f.requested || 0;
    var m = f.broken ? " (BROKEN)" : "";
    var O = "Active: " + f.product + " [" + R + "]" + m + " | progress " + d + "/" + E;
    var y = f.cycleStartedTick || f.created;
    if (y) {
      O += " | age " + (Game.time - y) + "/" + FACTORY_BROKEN_ORDER_TICKS;
    }
    t.push(O);
  } else {
    t.push("Active: none");
  }
  t.push("Queue: " + l);
  var v = factoryNeedsWork(e);
  t.push("Needs supplier: " + (v ? "YES" : "NO"));
  return "[Factory] " + e + " — " + t.join(" | ");
};
global.showAllFactories = function() {
  ensureMemory();
  var e = getRoomState.ownedNames();
  var r = [];
  for (var o = 0; o < e.length; o++) {
    r.push(global.showFactories(e[o]));
  }
  return r.length ? r.join("\n") : "[Factory] No owned rooms";
};
function run() {
  ensureMemory();
  markActivePerRoom();
  var e = _.groupBy(Memory.factoryOrders.filter(function(e) {
    return e.status === "active";
  }), function(e) {
    return e.room;
  });
  for (var r in e) {
    var o = Game.rooms[r];
    if (!o || !roomOwned(o)) continue;
    if (roomSuspender.shouldAvoidRoomWork(r)) continue;
    var t = e[r][0];
    var a = getRecipe(t.product);
    var n = findFactory(o);
    if (!n) continue;
    if (!a) {
      markBrokenOrder(t, "no recipe for " + t.product);
      continue;
    }
    if ((t.phase === "processing" || t.phase === "loadingPending" || t.phase === "unloadingPending") && t.cycleProductBaseline !== undefined) {
      reconcileProducedBatches(n, t, a);
    } else if (t.phase === "processing" && t.cycleProductBaseline === undefined) {
      t.cycleProductBaseline = Math.max(0, (n.store[t.product] || 0) - (t.cycleBatchesQueued || 0) * (a.out || 1));
      t.phase = "ready";
      memoryManager.requestSave();
    }
    if (!t.phase) t.phase = "loading";
    if (!t.lastProgressTick) t.lastProgressTick = Game.time;
    if (!t.broken) {
      var i = Game.time - (t.lastProgressTick || t.created || Game.time);
      if (i > FACTORY_BROKEN_ORDER_TICKS) {
        markBrokenOrder(t, "no progress for " + i + " ticks");
      } else if (i > 1e3 && Game.time % 100 === 0) {
        console.log("[Factory] Order " + t.id + " (" + t.room + " -> " + t.product + ") stalled in phase " + (t.phase || "loading") + " for " + i + " ticks");
      }
    }
    if (t.broken) {
      t.phase = "unloading";
      if (!factoryHasAnyStock(n)) {
        t.status = "cancelled";
      }
      continue;
    }
    var c = remainingBatchesForOrder(t, a);
    if (c <= 0) {
      if (!factoryHasAnyStock(n)) {
        t.status = "done";
      } else if (t.phase !== "unloading") {
        advanceToUnloading(t);
      }
      continue;
    }
    if (t.phase === "loadingPending" && memoryManager.willSave()) {
      t.phase = "loading";
      delete t.cycleProductBaseline;
    }
    if (t.phase === "loading") {
      if (!supplierActiveForRoom(r) && !factoryHasAnyStock(n) && rawBatchesForRoom(o, a) <= 0) {
        markBrokenOrder(t, "insufficient accessible inputs for remaining production");
        t.status = "cancelled";
        memoryManager.requestSave();
        continue;
      }
      if (!t.cycleBatches && !prepareCycle(t, n, a)) {
        if (factoryHasAnyStock(n)) {
          t.phase = "unloading";
        }
        continue;
      }
      resizeCycleToFit(t, n, a);
      fallbackToLoadedFactoryBatches(o, n, t, a);
      if (t.cycleBatches && cycleRemainingBatches(t) <= 0) {
        advanceToUnloading(t);
      } else if (cycleInputsLoaded(n, t, a)) {
        prepareProcessingWitness(n, t);
      } else if (!supplierActiveForRoom(r) && rawBatchesForRoom(o, a) <= 0) {
        markBrokenOrder(t, "insufficient accessible inputs for remaining production");
      }
    }
    if (t.phase === "ready" && memoryManager.willSave()) {
      t.phase = "processing";
    }
    if (t.phase === "processing") {
      if (cycleRemainingBatches(t) <= 0) {
        advanceToUnloading(t);
      } else if (n.store.getFreeCapacity && (n.store.getFreeCapacity() || 0) < (a.out || 0)) {
        advanceToLoading(t);
        continue;
      } else {
        tryProduce(n, t);
        if (!supplierActiveForRoom(r) && rawBatchesForRoom(o, a) <= 0 && !enoughForOneBatchInFactory(n, t.product)) {
          markBrokenOrder(t, "insufficient accessible inputs for remaining production");
        }
        if (cycleRemainingBatches(t) <= 0) {
          advanceToUnloading(t);
        }
        if (a && !supplierActiveForRoom(r) && maxBatchesForRoom(o, a) <= 0 && !factoryHasAnyStock(n) && (t.progressOut || 0) > 0) {
          advanceToUnloading(t);
        }
      }
    }
    if (t.phase === "unloadingPending" && memoryManager.willSave()) {
      t.phase = "unloading";
    }
    if (t.phase === "unloading") {
      var s = factoryStockTotal(n);
      if (t.unloadStock === undefined || s < t.unloadStock) {
        t.lastProgressTick = Game.time;
      }
      t.unloadStock = s;
      if (!factoryHasAnyStock(n)) {
        delete t.unloadStock;
        if ((t.progressOut || 0) >= t.requested) {
          t.status = "done";
        } else if (prepareCycle(t, n, a)) {
          if (!supplierActiveForRoom(r) && rawBatchesForRoom(o, a) <= 0) {
            markBrokenOrder(t, "insufficient accessible inputs for remaining production");
            t.status = "cancelled";
            memoryManager.requestSave();
          } else {
            t.phase = "loading";
          }
        } else {
          t.status = "done";
        }
      }
    }
  }
  var u = Memory.factoryOrders.length;
  Memory.factoryOrders = Memory.factoryOrders.filter(function(e) {
    if (e.status === "done" || e.status === "cancelled") {
      recordCompletedOrder(e);
      releaseOrderReservations(e);
      return false;
    }
    return true;
  });
  if (Memory.factoryOrders.length !== u) {
    markActivePerRoom();
  }
}

module.exports = {
  run: run,
  RECIPES: RECIPES,
  getRecipe: getRecipe,
  getOrders: getOrders,
  getOrderById: getOrderById,
  isLiveOrder: isLiveOrder,
  getCompletedOrderById: getCompletedOrderById,
  hasOrderAfter: hasOrderAfter,
  annotateOrder: annotateOrder
};
