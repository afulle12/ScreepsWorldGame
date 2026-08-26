// LLM: Read docs/codex.js before reviewing or changing this file.
// stockpileManager.js
// Console globals: stockpileStatus, stockpileJobs, stockpileActive, stockpileEnable, stockpileDisable, stockpileMode
// Examples:
//   stockpileStatus()     - Show strategic stockpile targets and deficits
//   stockpileJobs()       - Show active jobs tree, transfers, and boost requests

const storageManager = require("storageManager");
const getRoomState = require("getRoomState");
const marketPricing = require("marketPricing");
const memoryManager = require("memoryManager");

const PROGRAM = "stockpileManager";
const EMPIRE_PROGRAM = PROGRAM + "Empire";
const ROOM_PROGRAM = PROGRAM;
const MEMORY_KEY = "stockpileManager";
const MODE_OBSERVE = "observe";
const MODE_RESERVE = "reserve";
const MODE_ACTIVE = "active";
const PLAN_INTERVAL = 50;
const MAX_JOBS_PER_RUN = 4;
// Roots drain at MAX_JOBS_PER_RUN per run but intake is 4 per plan cycle, so the
// backlog is otherwise unbounded. Capping it is lossless: calculateDeficits()
// rebuilds any root we decline to create once a slot frees up.
const MAX_ACTIVE_ROOT_JOBS = 16;
const MAX_RECIPE_DEPTH = 5;
const REACTION_BATCH = typeof LAB_REACTION_AMOUNT === "number" ? LAB_REACTION_AMOUNT : 5;
const GHODIUM_ROOM_TARGET = 15000;
const GHODIUM_EXTERNAL_FLOOR = 10000;
const BATTERY_ROOM_TARGET = 10000;
const OVERFLOW_STORAGE_THRESHOLD = 800000;
const OVERFLOW_BATCH_SIZE = 10000;
const MAX_OVERFLOW_TRANSFERS_PER_RUN = 2;
const BUY_RECORD_GRACE = 10;
const JOB_RETENTION_TICKS = 1000;
const TERMINAL_COMPACT_DELAY = 50;
const LAST_RESULT_MAX = 60;
const MEMORY_VERSION = 3;

const X_COMPOUNDS = [
  "XGHO2",
  "XGH2O",
  "XKHO2",
  "XKH2O",
  "XLH2O",
  "XLHO2",
  "XUHO2",
  "XUH2O",
  "XZH2O",
  "XZHO2",
];

const EMPIRE_TARGETS = {
  OH: 2000,
  ZK: 2000,
  UL: 2000,
  ops: 5000,
};

for (let i = 0; i < X_COMPOUNDS.length; i++) EMPIRE_TARGETS[X_COMPOUNDS[i]] = 12000;

function ensureMemory() {
  if (!Memory[MEMORY_KEY]) {
    Memory[MEMORY_KEY] = {
      v: MEMORY_VERSION,
      enabled: false,
      mode: MODE_OBSERVE,
      requests: {},
      jobs: {},
      transfers: {},
      nextId: 1,
      lastRun: 0,
      lastPlan: 0,
    };
    memoryManager.requestSave();
  }
  const mem = Memory[MEMORY_KEY];
  if (typeof mem.v !== "number") mem.v = 1;
  if (typeof mem.enabled !== "boolean") mem.enabled = false;
  if ([MODE_OBSERVE, MODE_RESERVE, MODE_ACTIVE].indexOf(mem.mode) < 0) mem.mode = MODE_OBSERVE;
  if (!mem.requests || typeof mem.requests !== "object") mem.requests = {};
  if (!mem.jobs || typeof mem.jobs !== "object") mem.jobs = {};
  if (!mem.transfers || typeof mem.transfers !== "object") mem.transfers = {};
  if (typeof mem.nextId !== "number" || mem.nextId < 1) mem.nextId = 1;
  if (typeof mem.lastRun !== "number") mem.lastRun = 0;
  if (typeof mem.lastPlan !== "number") mem.lastPlan = 0;
  if (mem.v < MEMORY_VERSION) migrateMemory(mem);
  return mem;
}

function migrateMemory(mem) {
  if (mem.v < 2) migrateV2(mem);
  if (mem.v < 3) migrateV3(mem);
  mem.v = MEMORY_VERSION;
  memoryManager.requestSave();
}

// v1 -> v2: drop the never-written targets map, collapse stored route trees to the
// handful of fields execution reads, derive handoff program names, and omit defaults.
// Scope inference is folded in here so it stops re-running every tick -- and so it
// never re-infers a scope that v2 already resolved into the omitted empire default.
function migrateV2(mem) {
  delete mem.targets;
  const scopes = {};
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (job && (job.scope === "room" || job.scope === "empire")) scopes[id] = job.scope;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const id in mem.jobs) {
      const job = mem.jobs[id];
      if (!job || scopes[id]) continue;
      if (pass === 0 && job.parentId && mem.jobs[job.parentId]) continue;
      scopes[id] = (job.parentId && scopes[job.parentId])
        || (inferLegacyJobScope(job, mem) ? "room" : "empire");
    }
  }
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (!job) continue;
    if (scopes[id] === "room") job.scope = "room";
    else delete job.scope;
    job.route = trimRoute(job.route);
    delete job.handoffProgram;
    if (!job.parentId) delete job.parentId;
    if (!job.fulfilled) delete job.fulfilled;
    if (job.children && !job.children.length) delete job.children;
    if (job.lastResult) job.lastResult = shortResult(job.lastResult);
  }
  for (const id in mem.transfers) {
    if (mem.transfers[id]) delete mem.transfers[id].id;
  }
  mem.v = 2;
}

// v2 -> v3: created is redundant because the job id encodes its creation tick.
function migrateV3(mem) {
  for (const id in mem.jobs) {
    if (mem.jobs[id]) delete mem.jobs[id].created;
  }
  mem.v = 3;
}

function inferLegacyJobScope(job, mem) {
  if (!job || !job.roomName) return false;
  for (const id in mem.requests) {
    const request = mem.requests[id];
    if (request && request.active !== false && request.roomName === job.roomName && request.compound === job.resource) return true;
  }
  const boostOrders = Memory.boostManager && Memory.boostManager.orders && Memory.boostManager.orders[job.roomName] || {};
  for (const role in boostOrders) {
    const order = boostOrders[role];
    if (order && order.active && !order.stopping && order.boosts && order.boosts[job.resource]) return true;
  }
  const nukeOrder = Memory.nukeFillOrders && Memory.nukeFillOrders[job.roomName];
  if (job.resource === "G" && nukeOrder && !nukeOrder.completed) return true;
  if (job.resource === "G" && isRcl8(job.roomName)) return true;
  if (job.resource === "battery" && hasFactory(job.roomName)) return true;
  return false;
}

function ownedRoomNames() {
  try {
    if (getRoomState && typeof getRoomState.ownedNames === "function") {
      return getRoomState.ownedNames().slice();
    }
  } catch (e) {}
  const names = [];
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room && room.controller && room.controller.my) names.push(roomName);
  }
  return names;
}

function roomState(roomName) {
  try {
    return getRoomState.get(roomName);
  } catch (e) {
    return null;
  }
}

function storeAmount(store, resource) {
  if (!store) return 0;
  if (typeof store.getUsedCapacity === "function") return store.getUsedCapacity(resource) || 0;
  return store[resource] || 0;
}

function reservationAmount(block, program) {
  const reservations = block && Array.isArray(block.reservations) ? block.reservations : [];
  let amount = 0;
  for (let i = 0; i < reservations.length; i++) {
    if (reservations[i] && reservations[i].program === program) amount += reservations[i].amount || 0;
  }
  return amount;
}

function resourceInfo(roomName, resource) {
  let info = null;
  try {
    info = storageManager.storageFind(roomName, resource);
  } catch (e) {}
  const room = Game.rooms[roomName];
  const terminal = info && info.terminal ? info.terminal : {};
  const storage = info && info.storage ? info.storage : {};
  const terminalTotal = typeof terminal.total === "number"
    ? terminal.total
    : storeAmount(room && room.terminal && room.terminal.store, resource);
  const storageTotal = typeof storage.total === "number"
    ? storage.total
    : storeAmount(room && room.storage && room.storage.store, resource);
  const terminalReserved = terminal.reserved || 0;
  const storageReserved = storage.reserved || 0;
  const ownEmpireTerminal = reservationAmount(terminal, EMPIRE_PROGRAM);
  const ownRoomTerminal = reservationAmount(terminal, ROOM_PROGRAM);
  const ownEmpireStorage = reservationAmount(storage, EMPIRE_PROGRAM);
  const ownRoomStorage = reservationAmount(storage, ROOM_PROGRAM);
  const ownTerminal = ownEmpireTerminal + ownRoomTerminal;
  const ownStorage = ownEmpireStorage + ownRoomStorage;
  return {
    terminal: { total: terminalTotal, reserved: terminalReserved, own: ownTerminal, empireOwn: ownEmpireTerminal, roomOwn: ownRoomTerminal },
    storage: { total: storageTotal, reserved: storageReserved, own: ownStorage, empireOwn: ownEmpireStorage, roomOwn: ownRoomStorage },
    total: terminalTotal + storageTotal,
    reserved: terminalReserved + storageReserved,
    own: ownTerminal + ownStorage,
    availableToStockpile:
      Math.max(0, terminalTotal - terminalReserved + ownTerminal) +
      Math.max(0, storageTotal - storageReserved + ownStorage),
  };
}

function marketSellReserved(roomName, resource) {
  let amount = 0;
  let info = null;
  try {
    info = storageManager.storageFind(roomName, resource);
  } catch (e) {}
  const buildings = ["terminal", "storage"];
  for (let i = 0; i < buildings.length; i++) {
    const reservations = info && info[buildings[i]] && info[buildings[i]].reservations;
    if (!Array.isArray(reservations)) continue;
    for (let r = 0; r < reservations.length; r++) {
      const reservation = reservations[r];
      if (!reservation || reservation.program === ROOM_PROGRAM || reservation.program === EMPIRE_PROGRAM) continue;
      amount += reservation.amount || 0;
    }
  }
  return amount;
}

function collectMarketCommitments(rooms) {
  const result = {};
  let marketLab = null;
  let marketRefine = null;
  try {
    marketLab = require("marketLab");
  } catch (e) {}
  try {
    marketRefine = require("marketRefine");
  } catch (e) {}
  for (let i = 0; i < rooms.length; i++) {
    const roomName = rooms[i];
    const roomCommitments = {};
    let lab = null;
    let refine = null;
    try {
      if (marketLab && typeof marketLab.getCommittedSaleOutputs === "function") lab = marketLab.getCommittedSaleOutputs(roomName);
    } catch (e) {}
    try {
      if (marketRefine && typeof marketRefine.getCommittedSaleOutputs === "function") refine = marketRefine.getCommittedSaleOutputs(roomName);
    } catch (e) {}
    for (const resource in lab || {}) {
      if (lab[resource] > 0) roomCommitments[resource] = (roomCommitments[resource] || 0) + lab[resource];
    }
    for (const resource in refine || {}) {
      if (refine[resource] > 0) roomCommitments[resource] = (roomCommitments[resource] || 0) + refine[resource];
    }
    if (Object.keys(roomCommitments).length > 0) result[roomName] = roomCommitments;
  }
  return result;
}

function setReservation(roomName, resource, building, amount, program) {
  program = program || PROGRAM;
  if (amount > 0) return storageManager.reserve(roomName, resource, building, program, amount);
  storageManager.unReserve(roomName, resource, building, program);
  return { ok: true };
}

function reserveFloor(roomName, resource, target, commitments) {
  const info = resourceInfo(roomName, resource);
  const rawTerminalFree = Math.max(0, info.terminal.total - info.terminal.reserved + info.terminal.roomOwn);
  const rawStorageFree = Math.max(0, info.storage.total - info.storage.reserved + info.storage.roomOwn);
  const committed = commitments && commitments[roomName] && commitments[roomName][resource] || 0;
  const shield = Math.max(0, committed - marketSellReserved(roomName, resource));
  const terminalFree = Math.max(0, rawTerminalFree - Math.min(shield, rawTerminalFree));
  const storageFree = Math.max(0, rawStorageFree - Math.max(0, shield - rawTerminalFree));
  const desired = Math.min(Math.max(0, target), terminalFree + storageFree);
  const terminalAmount = Math.min(desired, terminalFree);
  const storageAmount = desired - terminalAmount;
  const terminalResult = setReservation(roomName, resource, "terminal", terminalAmount, ROOM_PROGRAM);
  if (!terminalResult.ok) return terminalResult;
  const storageResult = setReservation(roomName, resource, "storage", storageAmount, ROOM_PROGRAM);
  if (!storageResult.ok) {
    storageManager.unReserve(roomName, resource, "terminal", ROOM_PROGRAM);
    return storageResult;
  }
  return { ok: true, amount: desired };
}

function clearReservation(roomName, resource) {
  storageManager.unReserve(roomName, resource, "terminal", EMPIRE_PROGRAM);
  storageManager.unReserve(roomName, resource, "storage", EMPIRE_PROGRAM);
  storageManager.unReserve(roomName, resource, "terminal", ROOM_PROGRAM);
  storageManager.unReserve(roomName, resource, "storage", ROOM_PROGRAM);
}

function clearStaleReservations() {
  const records = storageManager.getReservationRecords();
  const stale = {};
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.program !== ROOM_PROGRAM && record.program !== EMPIRE_PROGRAM) continue;
    stale[record.roomName + "|" + record.material] = true;
  }
  for (const key in stale) {
    const parts = key.split("|");
    clearReservation(parts[0], parts[1]);
  }
}

function getNukers(roomName) {
  const state = roomState(roomName);
  const type = typeof STRUCTURE_NUKER !== "undefined" ? STRUCTURE_NUKER : "nuker";
  if (state && state.structuresByType && Array.isArray(state.structuresByType[type])) {
    return state.structuresByType[type];
  }
  const room = Game.rooms[roomName];
  if (!room || typeof FIND_STRUCTURES === "undefined" || typeof STRUCTURE_NUKER === "undefined") return [];
  return room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_NUKER } });
}

function nukerG(roomName) {
  const nukers = getNukers(roomName);
  let amount = 0;
  for (let i = 0; i < nukers.length; i++) {
    const nuker = nukers[i];
    amount += storeAmount(nuker && nuker.store, "G");
    if (nuker && !nuker.store) amount += nuker.ghodium || 0;
  }
  return amount;
}

function addDemand(map, roomName, resource, amount) {
  if (!(amount > 0)) return;
  if (!map[roomName]) map[roomName] = {};
  map[roomName][resource] = (map[roomName][resource] || 0) + amount;
}

function setDemandMax(map, roomName, resource, amount) {
  if (!(amount > 0)) return;
  if (!map[roomName]) map[roomName] = {};
  map[roomName][resource] = Math.max(map[roomName][resource] || 0, amount);
}

function externalBuyPending(roomName, resource) {
  try {
    const opportunisticBuy = require("opportunisticBuy");
    if (!opportunisticBuy) return 0;
    const request = typeof opportunisticBuy.getRequest === "function"
      ? opportunisticBuy.getRequest(roomName, resource)
      : typeof opportunisticBuy.getRequestByKey === "function" ? opportunisticBuy.getRequestByKey(roomName + "_" + resource) : null;
    return request && request.remaining > 0 ? request.remaining : 0;
  } catch (e) {
    return 0;
  }
}

function boostLabStock(order, compound) {
  const boost = order && order.boosts && order.boosts[compound];
  if (!boost) return 0;
  const labIds = Array.isArray(boost.labIds) ? boost.labIds : boost.labId ? [boost.labId] : [];
  if (!Game.getObjectById) return 0;
  let amount = 0;
  for (let i = 0; i < labIds.length; i++) {
    const lab = Game.getObjectById(labIds[i]);
    if (lab && lab.mineralType === compound) amount += lab.mineralAmount || 0;
  }
  return amount;
}

function boostPendingAmount(order, compound) {
  let amount = 0;
  const pending = order && order.pendingBuyOrders || {};
  for (const id in pending) {
    const record = pending[id];
    if (!record || (record.resourceType && record.resourceType !== compound)) continue;
    const requested = record.totalAmount || record.amount || 0;
    amount += Math.max(0, requested - (record.fulfilled || 0));
  }
  const orderIds = order && order.buyOrderIds || {};
  const orderId = orderIds[compound];
  if (orderId && Game.market && Game.market.orders && Game.market.orders[orderId]) {
    const marketOrder = Game.market.orders[orderId];
    amount += typeof marketOrder.remainingAmount === "number" ? marketOrder.remainingAmount : marketOrder.amount || 0;
  }
  return amount;
}

function externalDemands(rooms) {
  const requiredByRoom = {};
  const pendingByRoom = {};
  const root = Memory.boostManager && Memory.boostManager.orders || {};
  for (const roomName in root) {
    const roomOrders = root[roomName] || {};
    for (const role in roomOrders) {
      const order = roomOrders[role];
      if (!order || !order.active || order.stopping || !order.boosts) continue;
      const batchSize = order.batchSize || 0;
      for (const compound in order.boosts) {
        const boost = order.boosts[compound];
        const required = batchSize * (boost && boost.parts || 0) * 30;
        const needed = Math.max(0, required - boostLabStock(order, compound));
        addDemand(requiredByRoom, roomName, compound, needed);
      }
    }
  }
  for (const roomName in requiredByRoom) {
    for (const compound in requiredByRoom[roomName]) {
      let pending = externalBuyPending(roomName, compound);
      const roomOrders = root[roomName] || {};
      for (const role in roomOrders) {
        const order = roomOrders[role];
        if (!order || !order.active || order.stopping || !order.boosts || !order.boosts[compound]) continue;
        pending = Math.max(pending, boostPendingAmount(order, compound));
      }
      setDemandMax(pendingByRoom, roomName, compound, pending);
    }
  }
  const nukeOrders = Memory.nukeFillOrders || {};
  for (const roomName in nukeOrders) {
    const order = nukeOrders[roomName];
    if (!order || order.completed || !order.buyRequested || !(order.ghodiumTarget > 0)) continue;
    const pending = Math.max(0, order.ghodiumTarget - nukerG(roomName) - resourceInfo(roomName, "G").total);
    setDemandMax(pendingByRoom, roomName, "G", Math.max(pending, externalBuyPending(roomName, "G")));
  }
  const requiredByResource = {};
  for (let i = 0; i < rooms.length; i++) {
    const roomDemand = requiredByRoom[rooms[i]] || {};
    for (const resource in roomDemand) requiredByResource[resource] = (requiredByResource[resource] || 0) + roomDemand[resource];
  }
  return {
    requiredByRoom: requiredByRoom,
    pendingByRoom: pendingByRoom,
    requiredByResource: requiredByResource,
  };
}

function isRcl8(roomName) {
  const state = roomState(roomName);
  return !!(state && state.controller && state.controller.level >= 8 && getNukers(roomName).length > 0);
}

function hasFactory(roomName) {
  const state = roomState(roomName);
  const type = typeof STRUCTURE_FACTORY !== "undefined" ? STRUCTURE_FACTORY : "factory";
  return !!(state && state.structuresByType && Array.isArray(state.structuresByType[type]) && state.structuresByType[type].length > 0);
}

function getFactories(roomName) {
  const state = roomState(roomName);
  const type = typeof STRUCTURE_FACTORY !== "undefined" ? STRUCTURE_FACTORY : "factory";
  if (state && state.structuresByType && Array.isArray(state.structuresByType[type])) return state.structuresByType[type];
  const room = Game.rooms[roomName];
  if (!room || typeof FIND_STRUCTURES === "undefined") return [];
  return room.find(FIND_STRUCTURES, { filter: { structureType: type } });
}

function getRoomTargets(roomName, mem, demand) {
  const targets = {};
  if (isRcl8(roomName)) targets.G = Math.max(GHODIUM_EXTERNAL_FLOOR, GHODIUM_ROOM_TARGET - nukerG(roomName));
  if (hasFactory(roomName)) targets.battery = BATTERY_ROOM_TARGET;
  for (const id in mem.requests) {
    const request = mem.requests[id];
    if (!request || request.active === false || request.roomName !== roomName) continue;
    if (request.compound && request.amount > 0) targets[request.compound] = Math.max(targets[request.compound] || 0, request.amount);
  }
  const roomDemand = demand && demand.requiredByRoom && demand.requiredByRoom[roomName] || {};
  for (const resource in roomDemand) targets[resource] = Math.max(targets[resource] || 0, roomDemand[resource]);
  return targets;
}

function allManagedResources(rooms, demand) {
  const resources = Object.keys(EMPIRE_TARGETS);
  resources.push("G", "battery");
  const extra = demand && demand.requiredByResource || {};
  for (const resource in extra) if (resources.indexOf(resource) < 0) resources.push(resource);
  const mem = ensureMemory();
  for (let i = 0; i < rooms.length; i++) {
    const roomTargets = getRoomTargets(rooms[i], mem, demand);
    for (const resource in roomTargets) if (resources.indexOf(resource) < 0) resources.push(resource);
  }
  return resources;
}

function roomTargetsByRoom(rooms, mem, demand) {
  const result = {};
  for (let i = 0; i < rooms.length; i++) result[rooms[i]] = getRoomTargets(rooms[i], mem, demand);
  return result;
}

function reserveEmpireTarget(resource, target, rooms, commitments) {
  let remaining = target;
  for (let i = 0; i < rooms.length; i++) {
    const roomName = rooms[i];
    const info = resourceInfo(roomName, resource);
    const rawTerminalFree = Math.max(0, info.terminal.total - info.terminal.reserved + info.terminal.empireOwn);
    const rawStorageFree = Math.max(0, info.storage.total - info.storage.reserved + info.storage.empireOwn);
    const committed = commitments && commitments[roomName] && commitments[roomName][resource] || 0;
    const shield = Math.max(0, committed - marketSellReserved(roomName, resource));
    const terminalFree = Math.max(0, rawTerminalFree - Math.min(shield, rawTerminalFree));
    const storageFree = Math.max(0, rawStorageFree - Math.max(0, shield - rawTerminalFree));
    const amount = Math.min(remaining, terminalFree + storageFree);
    const terminalAmount = Math.min(amount, terminalFree);
    const result = setReservation(roomName, resource, "terminal", terminalAmount, EMPIRE_PROGRAM);
    if (!result.ok) continue;
    const storageResult = setReservation(roomName, resource, "storage", amount - terminalAmount, EMPIRE_PROGRAM);
    if (!storageResult.ok) {
      if (terminalAmount > 0) storageManager.unReserve(roomName, resource, "terminal", EMPIRE_PROGRAM);
      continue;
    }
    remaining -= amount;
  }
  return target - remaining;
}

function reconcileReservations() {
  const mem = ensureMemory();
  const rooms = ownedRoomNames();
  const demand = externalDemands(rooms);
  const targetsByRoom = roomTargetsByRoom(rooms, mem, demand);
  const resources = allManagedResources(rooms, demand);
  const commitments = collectMarketCommitments(rooms);
  clearStaleReservations();
  for (let i = 0; i < rooms.length; i++) {
    for (let r = 0; r < resources.length; r++) clearReservation(rooms[i], resources[r]);
  }
  const localTotals = {};
  for (let i = 0; i < rooms.length; i++) {
    const roomName = rooms[i];
    const roomTargets = targetsByRoom[roomName];
    for (const resource in roomTargets) {
      reserveFloor(roomName, resource, roomTargets[resource], commitments);
      localTotals[resource] = (localTotals[resource] || 0) + roomTargets[resource];
    }
  }
  for (const resource in EMPIRE_TARGETS) {
    const localTarget = Math.min(EMPIRE_TARGETS[resource], localTotals[resource] || 0);
    reserveEmpireTarget(resource, EMPIRE_TARGETS[resource] - localTarget, rooms, commitments);
  }
  memoryManager.requestSave();
}

function roomPhysicalTotal(roomName, resource) {
  const info = resourceInfo(roomName, resource);
  let total = info.total;
  if (resource === "G") total += nukerG(roomName);
  if (resource === "battery") {
    const factories = getFactories(roomName);
    for (let i = 0; i < factories.length; i++) total += storeAmount(factories[i] && factories[i].store, resource);
  }
  return total;
}

function empirePhysicalTotal(resource, rooms) {
  let total = 0;
  for (let i = 0; i < rooms.length; i++) total += roomPhysicalTotal(rooms[i], resource);
  return total;
}

function pendingAmount(resource, roomName) {
  const mem = ensureMemory();
  let total = 0;
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (!job || job.parentId || job.resource !== resource || job.state === "done" || job.state === "failed") continue;
    if (roomName && (job.scope || "empire") !== "room") continue;
    if (!roomName && (job.scope || "empire") === "room") continue;
    if (roomName && job.roomName !== roomName) continue;
    total += Math.max(0, job.amount - (job.fulfilled || 0));
  }
  return total;
}

function calculateDeficits() {
  const mem = ensureMemory();
  const rooms = ownedRoomNames();
  const demand = externalDemands(rooms);
  const targetsByRoom = roomTargetsByRoom(rooms, mem, demand);
  const deficits = [];
  const localTargets = {};
  const residualPhysical = {};
  const residualPending = {};
  for (let i = 0; i < rooms.length; i++) {
    const roomName = rooms[i];
    const roomTargets = targetsByRoom[roomName];
    const resources = Object.keys(roomTargets);
    for (const resource in EMPIRE_TARGETS) if (resources.indexOf(resource) < 0) resources.push(resource);
    for (let r = 0; r < resources.length; r++) {
      const resource = resources[r];
      const roomTarget = roomTargets[resource] || 0;
      const target = resource === "G" && isRcl8(roomName) ? GHODIUM_ROOM_TARGET : roomTargets[resource];
      const physical = roomPhysicalTotal(roomName, resource);
      const externalPending = demand.pendingByRoom[roomName] && demand.pendingByRoom[roomName][resource] || 0;
      const localPending = pendingAmount(resource, roomName) + externalPending;
      if (target > 0) {
        const deficit = Math.max(0, target - physical - localPending);
        if (deficit > 0) deficits.push({ scope: "room", roomName: roomName, resource: resource, target: target, physical: physical, deficit: deficit });
      }
      if (Object.prototype.hasOwnProperty.call(EMPIRE_TARGETS, resource)) {
        localTargets[resource] = (localTargets[resource] || 0) + roomTarget;
        residualPhysical[resource] = (residualPhysical[resource] || 0) + Math.max(0, physical - roomTarget);
        residualPending[resource] = (residualPending[resource] || 0) + Math.max(0, localPending - Math.max(0, roomTarget - physical));
      }
    }
  }
  for (const resource in EMPIRE_TARGETS) {
    const target = Math.max(0, EMPIRE_TARGETS[resource] - Math.min(EMPIRE_TARGETS[resource], localTargets[resource] || 0));
    const physical = residualPhysical[resource] || 0;
    const pending = residualPending[resource] || 0;
    const deficit = Math.max(0, target - physical - pending - pendingAmount(resource));
    if (deficit > 0) deficits.push({ scope: "empire", resource: resource, target: target, physical: physical, deficit: deficit });
  }
  return deficits;
}

function getAvailableInRoom(roomName, resource) {
  return resourceInfo(roomName, resource).availableToStockpile;
}

function findRecipe(resource) {
  if (typeof REACTIONS === "undefined" || !REACTIONS) return null;
  for (const first in REACTIONS) {
    const row = REACTIONS[first];
    if (!row) continue;
    for (const second in row) {
      if (row[second] === resource) return [first, second];
    }
  }
  return null;
}

function roomLabs(roomName) {
  const state = roomState(roomName);
  const type = typeof STRUCTURE_LAB !== "undefined" ? STRUCTURE_LAB : "lab";
  if (state && state.structuresByType && Array.isArray(state.structuresByType[type])) return state.structuresByType[type];
  const room = Game.rooms[roomName];
  if (!room || typeof FIND_STRUCTURES === "undefined") return [];
  return room.find(FIND_STRUCTURES, { filter: { structureType: type } });
}

function roomSupportsProduction(resource, roomName) {
  const room = Game.rooms[roomName];
  if (!room || !room.terminal) return false;
  const recipe = findRecipe(resource);
  if (!recipe) return true;
  const labs = roomLabs(roomName);
  if (labs.length < 3) return false;
  const requiresAdvanced = resource.indexOf("X") >= 0 || recipe[0].indexOf("X") >= 0 || recipe[1].indexOf("X") >= 0;
  try {
    if (requiresAdvanced) {
      const pipeline = require("labReactionPipeline");
      if (!pipeline || typeof pipeline.roomSupportsAdvanced !== "function" || !pipeline.roomSupportsAdvanced(room, labs).ok) return false;
    }
    const labManager = require("labManager");
    const layout = labManager && typeof labManager.getLayout === "function" ? labManager.getLayout(room) : null;
    return !!(layout && Array.isArray(layout.groups) && layout.groups.length > 0);
  } catch (e) {
    return false;
  }
}

function estimateReplacementCost(resource, amount) {
  if (!marketPricing || typeof marketPricing.getInputBuyQuote !== "function") return Infinity;
  const quote = marketPricing.getInputBuyQuote(resource, amount, {
    allowTheoretical: false,
    allowPassive: true,
  });
  return quote && quote.price > 0 ? quote.price * amount : Infinity;
}

function copyRoute(route) {
  if (!route) return route;
  const result = Object.assign({}, route);
  if (route.quote) result.quote = Object.assign({}, route.quote);
  if (route.inputs) result.inputs = route.inputs.map(copyRoute);
  return result;
}

// cheapestRoute returns a full recipe tree; only the fields below survive into
// Memory. Nested subtrees are dropped because each child job stores its own route.
function trimRoute(route) {
  if (!route) return route;
  const trimmed = { kind: route.kind };
  const price = routePrice(route);
  const ceiling = routeCeiling(route);
  if (price > 0) trimmed.price = price;
  if (ceiling > 0 && ceiling !== price) trimmed.effectivePrice = ceiling;
  if (route.kind === "make" && Array.isArray(route.inputs)) {
    trimmed.inputs = [];
    for (let i = 0; i < route.inputs.length; i++) {
      const input = route.inputs[i];
      if (!input) continue;
      const slim = { resource: input.resource };
      const inputPrice = routePrice(input);
      if (inputPrice > 0) slim.price = inputPrice;
      if (input.childId) slim.childId = input.childId;
      trimmed.inputs.push(slim);
    }
  }
  return trimmed;
}

// Accessors read either the trimmed shape or a legacy quote-carrying route.
function routePrice(route) {
  if (!route) return 0;
  if (route.price > 0) return route.price;
  return route.quote && route.quote.price > 0 ? route.quote.price : 0;
}

function routeCeiling(route) {
  if (!route) return 0;
  if (route.effectivePrice > 0) return route.effectivePrice;
  if (route.quote && route.quote.effectivePrice > 0) return route.quote.effectivePrice;
  return routePrice(route);
}

function handoffProgramFor(job) {
  if (!job) return null;
  if (job.handoffProgram) return job.handoffProgram;
  return job.parentId ? "stockpileHandoff_" + job.id : null;
}

function inputHandoffProgram(input) {
  if (!input) return null;
  if (input.handoffProgram) return input.handoffProgram;
  return input.childId ? "stockpileHandoff_" + input.childId : null;
}

function shortResult(text) {
  const value = String(text);
  return value.length > LAST_RESULT_MAX ? value.slice(0, LAST_RESULT_MAX) : value;
}

function quoteBuy(resource, amount, roomName) {
  if (!(amount > 0) || !marketPricing || typeof marketPricing.executableBuyQuote !== "function") return null;
  const requested = Math.ceil(amount);
  const quote = marketPricing.executableBuyQuote(resource, requested, roomName);
  if (!quote || quote.amount < requested) return null;
  const energyPrice = typeof marketPricing.getStatusEnergyPrice === "function" ? marketPricing.getStatusEnergyPrice() : 0;
  const rawTotal = (quote.price || 0) * requested;
  const total = rawTotal + (quote.transferEnergy || 0) * energyPrice;
  return {
    amount: requested,
    requested: requested,
    complete: true,
    price: rawTotal / requested,
    total: total,
    rawTotal: rawTotal,
    effectivePrice: total / requested,
    transferEnergy: quote.transferEnergy || 0,
    source: "EXECUTABLE_ASK",
  };
}

function cheapestRoute(resource, amount, roomName, stack, depth, cache, allowInventory) {
  stack = stack || {};
  depth = depth || 0;
  cache = cache || {};
  if (typeof allowInventory !== "boolean") allowInventory = true;
  const normalized = Math.max(REACTION_BATCH, Math.ceil(amount / REACTION_BATCH) * REACTION_BATCH);
  const key = resource + "|" + normalized;
  if (stack[key] || depth > MAX_RECIPE_DEPTH) return { kind: "unavailable", resource: resource, amount: normalized, cost: Infinity };
  const cacheKey = roomName + "|" + key + "|" + (allowInventory ? "inventory" : "acquire");
  if (cache[cacheKey]) return copyRoute(cache[cacheKey]);
  const available = getAvailableInRoom(roomName, resource);
  let best = allowInventory && available >= normalized
    ? { kind: "inventory", resource: resource, amount: normalized, cost: estimateReplacementCost(resource, normalized) }
    : null;
  const nextStack = Object.assign({}, stack);
  nextStack[key] = true;
  const buy = quoteBuy(resource, normalized, roomName);
  if (buy && buy.complete) {
    const buyRoute = { kind: "buy", resource: resource, amount: normalized, cost: buy.total, quote: buy };
    if (!best || buyRoute.cost < best.cost) best = buyRoute;
  }
  const recipe = findRecipe(resource);
  if (recipe) {
    const left = cheapestRoute(recipe[0], normalized, roomName, nextStack, depth + 1, cache, true);
    const right = cheapestRoute(recipe[1], normalized, roomName, nextStack, depth + 1, cache, true);
    if (left.cost < Infinity && right.cost < Infinity) {
      const make = {
        kind: "make",
        resource: resource,
        amount: normalized,
        cost: left.cost + right.cost,
        inputs: [left, right],
      };
      if (!best || make.cost < best.cost) best = make;
    }
  }
  if (best) {
    cache[cacheKey] = best;
    return copyRoute(best);
  }
  if (marketPricing && typeof marketPricing.passiveBuyPrice === "function") {
    const passive = marketPricing.passiveBuyPrice(resource);
    if (passive > 0) {
      const quote = { amount: normalized, requested: normalized, complete: false, price: passive, total: passive * normalized, effectivePrice: passive, source: "POSTED_BUY" };
      const pending = { kind: "buy", resource: resource, amount: normalized, cost: quote.total, pending: true, quote: quote };
      cache[cacheKey] = pending;
      return copyRoute(pending);
    }
  }
  const unavailable = { kind: "unavailable", resource: resource, amount: normalized, cost: Infinity };
  cache[cacheKey] = unavailable;
  return unavailable;
}

function nextId(prefix) {
  const mem = ensureMemory();
  const id = prefix + Game.time.toString(36) + "_" + mem.nextId.toString(36);
  mem.nextId++;
  return id;
}

function activeJobFor(resource, roomName) {
  const mem = ensureMemory();
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (!job || job.parentId || job.resource !== resource || job.roomName !== roomName) continue;
    if (job.state !== "done" && job.state !== "failed") return job;
  }
  return null;
}

function findBuyRecord(job) {
  try {
    const marketBuyer = require("marketBuy");
    return marketBuyer.getOrderRecordFor(job.roomName, job.resource, "stockpile", job.id);
  } catch (e) {
    return null;
  }
}

function findOpportunisticRequest(job) {
  try {
    const opportunisticBuy = require("opportunisticBuy");
    if (!opportunisticBuy || typeof opportunisticBuy.getRequest !== "function") return null;
    return opportunisticBuy.getRequest(job.roomName, job.resource, { queue: "stockpile", opId: job.id });
  } catch (e) {
    return null;
  }
}

function releaseHandoffReservation(job) {
  const program = handoffProgramFor(job);
  if (!program) return;
  storageManager.unReserve(job.roomName, job.resource, "terminal", program);
  storageManager.unReserve(job.roomName, job.resource, "storage", program);
}

function cancelJobWork(job, reason) {
  if (!job) return;
  try {
    const opportunisticBuy = require("opportunisticBuy");
    if (opportunisticBuy && typeof opportunisticBuy.cancelRequest === "function") {
      opportunisticBuy.cancelRequest(job.roomName, job.resource, { queue: "stockpile", opId: job.id, settlePending: true });
    }
  } catch (e) {}
  try {
    const marketBuyer = require("marketBuy");
    if (marketBuyer && typeof marketBuyer.cancelOrderFor === "function") {
      marketBuyer.cancelOrderFor(job.roomName, job.resource, reason || "stockpile job failed", "stockpile", job.id);
    }
  } catch (e) {}
  if (job.operationId) {
    try {
      const marketLab = require("marketLab");
      if (marketLab && typeof marketLab.cancelOperation === "function") {
        marketLab.cancelOperation("forward", job.roomName, job.operationId, reason || "stockpile job failed");
      }
    } catch (e) {}
  }
}

function failJob(job, reason) {
  if (!job || job.state === "done") return;
  if (job.state === "failed") {
    cancelJobWork(job, reason);
    releaseHandoffReservation(job);
    return;
  }
  const mem = ensureMemory();
  for (let i = 0; i < (job.children || []).length; i++) {
    const child = mem.jobs[job.children[i]];
    if (!child) continue;
    if (child.state === "done") releaseHandoffReservation(child);
    else failJob(child, "parent job failed: " + job.id);
  }
  cancelJobWork(job, reason);
  releaseHandoffReservation(job);
  job.state = "failed";
  job.lastResult = shortResult(reason || "stockpile job failed");
  job.updated = Game.time;
}

function completeJob(job) {
  if (!job) return;
  const mem = ensureMemory();
  for (let i = 0; i < (job.children || []).length; i++) {
    const child = mem.jobs[job.children[i]];
    if (child) releaseHandoffReservation(child);
  }
  job.state = "done";
  job.updated = Game.time;
}

function queueBuy(job) {
  const amount = Math.max(0, job.amount - (job.fulfilled || 0));
  if (!(amount > 0)) return false;
  const estimated = routePrice(job.route);
  const price = estimated > 0
    ? estimated
    : marketPricing && typeof marketPricing.passiveBuyPrice === "function" ? marketPricing.passiveBuyPrice(job.resource) : 0;
  if (!(price > 0)) return false;
  const energyPrice = marketPricing && typeof marketPricing.getStatusEnergyPrice === "function" ? marketPricing.getStatusEnergyPrice() : 0;
  const ceiling = estimated > 0 ? routeCeiling(job.route) : price;
  try {
    const opportunisticBuy = require("opportunisticBuy");
    if (opportunisticBuy && typeof opportunisticBuy.setup === "function") {
      opportunisticBuy.setup(job.roomName, job.resource, amount, ceiling, {
        queue: "stockpile",
        opId: job.id,
        jobId: job.id,
        product: job.resource,
        includeTransferCost: true,
        energyPrice: energyPrice,
      });
      if (findOpportunisticRequest(job)) {
        job.purchaseQueue = "opportunisticBuy";
        job.lastResult = "opportunistic buy queued";
        job.updated = Game.time;
        memoryManager.requestSave();
        return true;
      }
    }
  } catch (e) {}
  const marketBuyer = require("marketBuy");
  const result = marketBuyer.marketBuy(job.roomName, job.resource, amount, price, {
    queue: "stockpile",
    opId: job.id,
    jobId: job.id,
    room: job.roomName,
    product: job.resource,
    ceiling: price,
  });
  job.purchaseQueue = "marketBuy";
  job.lastResult = shortResult(result);
  job.updated = Game.time;
  memoryManager.requestSave();
  return String(result).indexOf("Invalid") < 0 && String(result).indexOf("No canonical") < 0;
}

function reserveHandoffOutput(job, amount) {
  if (!job.parentId || !(amount > 0)) return true;
  if (roomPhysicalTotal(job.roomName, job.resource) < (job.baseline || 0) + amount) return false;
  const info = resourceInfo(job.roomName, job.resource);
  const terminalFree = Math.max(0, info.terminal.total - info.terminal.reserved);
  const terminalAmount = Math.min(amount, terminalFree);
  const storageAmount = amount - terminalAmount;
  if (terminalAmount + Math.min(amount - terminalAmount, Math.max(0, info.storage.total - info.storage.reserved)) < amount) return false;
  const program = handoffProgramFor(job);
  const terminalResult = terminalAmount > 0 ? storageManager.reserve(job.roomName, job.resource, "terminal", program, terminalAmount) : { ok: true };
  if (!terminalResult.ok) return false;
  const storageResult = storageAmount > 0 ? storageManager.reserve(job.roomName, job.resource, "storage", program, storageAmount) : { ok: true };
  if (!storageResult.ok) {
    if (terminalAmount > 0) storageManager.unReserve(job.roomName, job.resource, "terminal", program);
    return false;
  }
  return true;
}

function operationExists(job) {
  try {
    const marketLab = require("marketLab");
    const operations = marketLab.getOperations();
    for (let i = 0; i < operations.length; i++) if (operations[i] && operations[i].id === job.operationId) return true;
  } catch (e) {}
  return false;
}

function queueProduction(job) {
  const marketLab = require("marketLab");
  const economics = require("marketEconomics");
  if (!job.economicsJobId) {
    job.economicsJobId = economics.mintJobId();
    economics.start(job.economicsJobId, {
      kind: "stockpileProduction",
      room: job.roomName,
      product: job.resource,
    });
    economics.phase(job.economicsJobId, "queued");
  }
  const recipe = findRecipe(job.resource);
  if (!recipe) return false;
  const maxPrices = {};
  const handoffInputPrograms = {};
  const inputs = job.route && job.route.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (!input || !input.resource) continue;
    const price = routePrice(input);
    if (price > 0) maxPrices[input.resource] = price;
    const program = inputHandoffProgram(input);
    if (program) handoffInputPrograms[input.resource] = program;
  }
  const options = {
    stockpile: true,
    batchSize: job.amount,
    handoff: !!job.parentId,
    handoffResource: job.resource,
    handoffAmount: job.amount,
    handoffReservationProgram: handoffProgramFor(job),
    handoffInputPrograms: handoffInputPrograms,
  };
  const result = typeof marketLab.startStockpileOperation === "function"
    ? marketLab.startStockpileOperation("forward", job.roomName, job.resource, maxPrices, job.economicsJobId, options)
    : null;
  if (!result || !result.ok || !result.operationId) {
    job.lastResult = shortResult(result && result.message ? result.message : "stockpile operation queue unavailable");
    return false;
  }
  job.operationId = result.operationId;
  job.state = "producing";
  job.updated = Game.time;
  economics.link(job.economicsJobId, "marketLab", result.operationId);
  if (result.state === "PENDING") {
    const queueState = marketLab && typeof marketLab.getRoomQueueState === "function" ? marketLab.getRoomQueueState(job.roomName) : null;
    const pending = queueState && Array.isArray(queueState.pending) ? queueState.pending : [];
    let position = pending.length;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i] && pending[i].id === result.operationId) {
        position = i;
        break;
      }
    }
    job.lastResult = "queued in " + job.roomName + " behind " + Math.max(0, position) + " op(s)";
    economics.phase(job.economicsJobId, "pending");
  } else {
    economics.phase(job.economicsJobId, "buying");
  }
  memoryManager.requestSave();
  return true;
}

function processJob(job) {
  if (!job || job.state === "done" || job.state === "failed") return;
  job.updated = Game.time;
  if (!job.route || job.route.kind === "unavailable") {
    failJob(job, "no executable buy or production route");
    return;
  }
  if (job.route.kind === "buy") {
    if (job.fulfilled >= job.amount) {
      if (reserveHandoffOutput(job, job.amount)) {
        completeJob(job);
        return;
      }
      job.state = "delivering";
    }
    const opportunisticRequest = findOpportunisticRequest(job);
    if (opportunisticRequest) {
      job.fulfilled = Math.max(job.fulfilled || 0, opportunisticRequest.fulfilled || 0);
      if (job.fulfilled >= job.amount) {
        if (reserveHandoffOutput(job, job.amount)) {
          completeJob(job);
          return;
        }
        job.state = "delivering";
      } else {
        job.state = "buying";
      }
      return;
    }
    const record = findBuyRecord(job);
    if (record) {
      const marketBuyer = require("marketBuy");
      job.fulfilled = Math.max(job.fulfilled || 0, marketBuyer.getFulfilled(record) || record.fulfilledFinal || 0);
      if (job.fulfilled >= job.amount) {
        if (reserveHandoffOutput(job, job.amount)) {
          completeJob(job);
          return;
        }
        job.state = "delivering";
      } else {
        if (record.done || record.cancelled) {
          delete job.purchaseQueue;
          job.state = "queued";
        } else {
          job.state = "buying";
          return;
        }
      }
    }
    const delivered = Math.max(0, roomPhysicalTotal(job.roomName, job.resource) - (job.baseline || 0));
    if (delivered > (job.fulfilled || 0)) {
      job.fulfilled = Math.min(job.amount, delivered);
      if (job.fulfilled >= job.amount && reserveHandoffOutput(job, job.amount)) completeJob(job);
      if (job.state === "done") return;
    }
    if (job.state === "delivering") return;
    const currentRequest = findOpportunisticRequest(job);
    const currentRecord = findBuyRecord(job);
    if (!currentRequest && !currentRecord && job.purchaseQueue) {
      if (!job.purchaseMissingSince) job.purchaseMissingSince = Game.time;
      if (Game.time - job.purchaseMissingSince >= BUY_RECORD_GRACE) {
        delete job.purchaseQueue;
        delete job.purchaseMissingSince;
        job.state = "queued";
        job.lastResult = "purchase record disappeared; retrying";
      }
    } else {
      delete job.purchaseMissingSince;
    }
    if (job.state !== "buying") {
      if (queueBuy(job)) job.state = "buying";
    }
    return;
  }
  if (job.route.kind !== "make") {
    if (job.route.kind === "inventory" && job.parentId) completeJob(job);
    else failJob(job, "stockpile root cannot consume existing inventory as output");
    return;
  }
  if (job.children) {
    for (let i = 0; i < job.children.length; i++) {
      const child = ensureMemory().jobs[job.children[i]];
      if (!child) {
        failJob(job, "missing child job " + job.children[i]);
        return;
      }
      if (child.state === "failed") {
        failJob(job, "child job failed: " + child.id);
        return;
      }
      if (child.state !== "done") {
        processJob(child);
        if (child.state !== "done") return;
      }
    }
  }
  if (!job.operationId) {
    queueProduction(job);
    return;
  }
  if (operationExists(job)) {
    job.state = "producing";
    return;
  }
  if (roomPhysicalTotal(job.roomName, job.resource) >= (job.baseline || 0) + job.amount) {
    if (reserveHandoffOutput(job, job.amount)) completeJob(job);
    return;
  }
  failJob(job, "marketLab operation disappeared before delivering output");
}

function createJob(resource, amount, roomName, parentId, depth, scope) {
  const mem = ensureMemory();
  const route = (depth || 0) > MAX_RECIPE_DEPTH
    ? { kind: "unavailable", resource: resource, amount: Math.ceil(amount / REACTION_BATCH) * REACTION_BATCH, cost: Infinity }
    : cheapestRoute(resource, amount, roomName, {}, 0, null, !!parentId);
  const id = nextId("sj");
  const job = {
    id: id,
    resource: resource,
    amount: Math.ceil(amount / REACTION_BATCH) * REACTION_BATCH,
    roomName: roomName,
    state: "queued",
    baseline: roomPhysicalTotal(roomName, resource),
    updated: Game.time,
  };
  if (scope === "room") job.scope = "room";
  if (parentId) job.parentId = parentId;
  mem.jobs[id] = job;
  if (route.kind === "make" && route.inputs) {
    const children = [];
    for (let i = 0; i < route.inputs.length; i++) {
      const input = route.inputs[i];
      if (!input || input.kind === "inventory") continue;
      const child = createJob(input.resource, input.amount, roomName, id, (depth || 0) + 1, job.scope);
      children.push(child.id);
      input.childId = child.id;
    }
    if (children.length) job.children = children;
  }
  job.route = trimRoute(route);
  return job;
}

function chooseRoom(resource, preferredRoom, amount) {
  let marketLab = null;
  try {
    marketLab = require("marketLab");
  } catch (e) {}
  function queueState(roomName) {
    try {
      return marketLab && typeof marketLab.getRoomQueueState === "function" ? marketLab.getRoomQueueState(roomName) : null;
    } catch (e) {
      return null;
    }
  }
  function hasSlot(roomName) {
    const state = queueState(roomName);
    return !state || state.slotsFree > 0;
  }
  if (preferredRoom) {
    if (roomWorkBlocked(preferredRoom) || !Game.rooms[preferredRoom] || !Game.rooms[preferredRoom].terminal) return null;
    if (!hasSlot(preferredRoom)) return null;
    const preferredRoute = cheapestRoute(resource, amount || REACTION_BATCH, preferredRoom, {}, 0, null, false);
    if (preferredRoute.kind === "unavailable" || preferredRoute.kind === "make" && !roomSupportsProduction(resource, preferredRoom)) return null;
    return preferredRoom;
  }
  const candidates = [];
  const rooms = ownedRoomNames();
  for (let i = 0; i < rooms.length; i++) if (candidates.indexOf(rooms[i]) < 0) candidates.push(rooms[i]);
  let bestRoom = null;
  let bestCost = Infinity;
  let bestQueue = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const roomName = candidates[i];
    if (roomWorkBlocked(roomName) || !Game.rooms[roomName] || !Game.rooms[roomName].terminal) continue;
    if (!hasSlot(roomName)) continue;
    const route = cheapestRoute(resource, amount || REACTION_BATCH, roomName, {}, 0, null, false);
    if (route.kind === "make" && !roomSupportsProduction(resource, roomName)) continue;
    if (route.kind === "unavailable") continue;
    const state = queueState(roomName);
    const queueLength = state && Array.isArray(state.pending) ? state.pending.length : 0;
    const costClose = bestRoom !== null && route.cost <= bestCost * 1.05;
    let choose = bestRoom === null || route.cost < bestCost && !costClose;
    if (costClose) {
      choose = queueLength < bestQueue || queueLength === bestQueue && (route.cost < bestCost || roomName < bestRoom);
    }
    if (choose) {
      bestRoom = roomName;
      bestCost = route.cost;
      bestQueue = queueLength;
    }
  }
  return bestRoom;
}

function processExistingJobs() {
  const mem = ensureMemory();
  const ids = Object.keys(mem.jobs);
  let processed = 0;
  for (let i = 0; i < ids.length && processed < MAX_JOBS_PER_RUN; i++) {
    const job = mem.jobs[ids[i]];
    if (!job || job.parentId || job.state === "done" || job.state === "failed" || roomWorkBlocked(job.roomName)) continue;
    processJob(job);
    processed++;
  }
  if (processed > 0) memoryManager.requestSave();
  return processed;
}

// Done/failed jobs linger for JOB_RETENTION_TICKS as a debugging trail; strip the
// execution payload once nothing will read it again so the trail stays cheap.
function compactTerminalJobs(mem) {
  let changed = false;
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (!job || (job.state !== "done" && job.state !== "failed")) continue;
    if (Game.time - (job.updated || Game.time) < TERMINAL_COMPACT_DELAY) continue;
    if (!job.route && !job.baseline && !job.fulfilled
      && !job.economicsJobId && !job.operationId && !job.purchaseQueue && !job.purchaseMissingSince) continue;
    delete job.route;
    delete job.baseline;
    delete job.fulfilled;
    delete job.economicsJobId;
    delete job.operationId;
    delete job.purchaseQueue;
    delete job.purchaseMissingSince;
    if (job.state === "done") delete job.lastResult;
    changed = true;
  }
  return changed;
}

function pruneJobs() {
  const mem = ensureMemory();
  const referenced = {};
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    for (let i = 0; job && i < (job.children || []).length; i++) referenced[job.children[i]] = true;
  }
  let changed = false;
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (!job || referenced[id] || (job.state !== "done" && job.state !== "failed")) continue;
    if (Game.time - (job.updated || Game.time) < JOB_RETENTION_TICKS) continue;
    delete mem.jobs[id];
    changed = true;
  }
  if (changed) memoryManager.requestSave();
  return changed;
}

function activeRootJobs(mem) {
  let count = 0;
  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (!job || job.parentId || job.state === "done" || job.state === "failed") continue;
    count++;
  }
  return count;
}

function processDeficits() {
  const mem = ensureMemory();
  const deficits = calculateDeficits();
  let active = activeRootJobs(mem);
  let started = 0;
  for (let i = 0; i < deficits.length && started < MAX_JOBS_PER_RUN; i++) {
    if (active >= MAX_ACTIVE_ROOT_JOBS) break;
    const entry = deficits[i];
    const roomName = chooseRoom(entry.resource, entry.roomName, Math.min(entry.deficit, 3000));
    if (!roomName) continue;
    if (activeJobFor(entry.resource, roomName)) continue;
    const job = createJob(entry.resource, Math.min(entry.deficit, 3000), roomName, null, 0, entry.scope);
    processJob(job);
    active++;
    started++;
  }
  if (started > 0) memoryManager.requestSave();
  return deficits;
}

function storageUsed(roomName) {
  const room = Game.rooms[roomName];
  const store = room && room.storage && room.storage.store;
  if (!store) return 0;
  if (typeof store.getUsedCapacity === "function") return store.getUsedCapacity() || 0;
  let amount = 0;
  for (const resource in store) if (typeof store[resource] === "number") amount += store[resource];
  return amount;
}

function storeFree(store, resource) {
  if (!store || typeof store.getFreeCapacity !== "function") return 0;
  return Math.max(0, store.getFreeCapacity(resource));
}

function roomHasHostiles(roomName) {
  const state = roomState(roomName);
  return !!(state && Array.isArray(state.hostiles) && state.hostiles.length > 0);
}

function roomWorkBlocked(roomName) {
  if (roomHasHostiles(roomName)) return true;
  try {
    const roomSuspender = require("roomSuspender");
    return !!(roomSuspender && typeof roomSuspender.shouldAvoidRoomWork === "function" && roomSuspender.shouldAvoidRoomWork(roomName));
  } catch (e) {
    return false;
  }
}

function terminalOperations() {
  return Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
}

function activeOverflowTransfer(source, resource) {
  const mem = ensureMemory();
  for (const id in mem.transfers) {
    const transfer = mem.transfers[id];
    if (transfer && transfer.fromRoom === source && (resource === "__any__" || transfer.resource === resource) && transfer.status !== "completed" && transfer.status !== "failed") return true;
  }
  const operations = terminalOperations();
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    if (operation && operation.type === "transfer" && operation.fromRoom === source && (resource === "__any__" ? operation.accountingSource === "stockpileOverflow" : operation.resourceType === resource) && operation.status !== "completed" && operation.status !== "failed") return true;
  }
  return false;
}

function findOverflowDestination(source, resource, rooms) {
  let best = null;
  let bestFree = 0;
  for (let i = 0; i < rooms.length; i++) {
    const roomName = rooms[i];
    if (roomName === source || roomWorkBlocked(roomName)) continue;
    const room = Game.rooms[roomName];
    if (!room || !room.terminal || !room.storage) continue;
    let incoming = 0;
    const operations = terminalOperations();
    for (let o = 0; o < operations.length; o++) {
      const operation = operations[o];
      if (!operation || operation.type !== "transfer" || operation.toRoom !== roomName || operation.resourceType !== resource || operation.status === "completed" || operation.status === "failed") continue;
      incoming += Math.max(0, (operation.amount || 0) - (operation.amountTransferred || 0));
    }
    const free = Math.max(0, storeFree(room.terminal.store, resource) - incoming);
    if (free > bestFree) {
      best = roomName;
      bestFree = free;
    }
  }
  return best;
}

function reconcileOverflowTransfers() {
  const mem = ensureMemory();
  const operations = terminalOperations();
  let changed = false;
  for (const id in mem.transfers) {
    const transfer = mem.transfers[id];
    if (!transfer) {
      delete mem.transfers[id];
      changed = true;
      continue;
    }
    let operation = null;
    for (let i = 0; i < operations.length; i++) {
      if (operations[i] && ((transfer.terminalOpId && operations[i].id === transfer.terminalOpId) || (!transfer.terminalOpId && operations[i].type === "transfer" && operations[i].fromRoom === transfer.fromRoom && operations[i].toRoom === transfer.toRoom && operations[i].resourceType === transfer.resource))) {
        operation = operations[i];
        break;
      }
    }
    if (operation) {
      if (transfer.terminalOpId !== operation.id) {
        transfer.terminalOpId = operation.id;
        changed = true;
      }
      const status = operation.status || "pending";
      if (transfer.status !== status) {
        transfer.status = status;
        changed = true;
      }
      if (operation.status === "completed" || operation.status === "failed") {
        delete mem.transfers[id];
        changed = true;
      }
    } else if (Game.time - (transfer.created || Game.time) > 100) {
      delete mem.transfers[id];
      changed = true;
    }
  }
  return changed;
}

function queueOverflowTransfer(source, destination, resource, amount) {
  let result;
  try {
    const terminalManager = require("terminalManager");
    if (!terminalManager || typeof terminalManager.transferStuff !== "function") return false;
    result = terminalManager.transferStuff(source, destination, resource, amount, "stockpileOverflow");
  } catch (e) {
    return false;
  }
  if (typeof result !== "string" || /Invalid|Insufficient|No terminal|Cannot|Waiting/.test(result)) return false;
  const operations = terminalOperations();
  let operation = null;
  for (let i = operations.length - 1; i >= 0; i--) {
    const candidate = operations[i];
    if (candidate && candidate.type === "transfer" && candidate.fromRoom === source && candidate.toRoom === destination && candidate.resourceType === resource && candidate.status !== "completed" && candidate.status !== "failed") {
      operation = candidate;
      break;
    }
  }
  const mem = ensureMemory();
  const id = nextId("ov");
  mem.transfers[id] = {
    fromRoom: source,
    toRoom: destination,
    resource: resource,
    amount: amount,
    terminalOpId: operation && operation.id || null,
    status: operation && operation.status || "queued",
    created: Game.time,
  };
  memoryManager.requestSave();
  return true;
}

function processOverflow() {
  const reconciled = reconcileOverflowTransfers();
  const rooms = ownedRoomNames();
  let created = 0;
  for (let i = 0; i < rooms.length && created < MAX_OVERFLOW_TRANSFERS_PER_RUN; i++) {
    const source = rooms[i];
    const excess = storageUsed(source) - OVERFLOW_STORAGE_THRESHOLD;
    if (excess <= 0 || roomWorkBlocked(source) || activeOverflowTransfer(source, "__any__")) continue;
    let available;
    try {
      available = storageManager.getUnreserved(source);
    } catch (e) {
      available = null;
    }
    const storage = available && available.storage || {};
    const candidates = [];
    for (const resource in storage) {
      const amount = storage[resource] || 0;
      if (resource === (typeof RESOURCE_ENERGY !== "undefined" ? RESOURCE_ENERGY : "energy") || amount <= 0 || activeOverflowTransfer(source, resource)) continue;
      candidates.push({ resource: resource, amount: amount });
    }
    candidates.sort(function(a, b) { return b.amount - a.amount; });
    for (let c = 0; c < candidates.length && created < MAX_OVERFLOW_TRANSFERS_PER_RUN; c++) {
      const candidate = candidates[c];
      const destination = findOverflowDestination(source, candidate.resource, rooms);
      if (!destination) continue;
      const amount = Math.min(OVERFLOW_BATCH_SIZE, Math.floor(excess), candidate.amount);
      if (amount <= 0 || queueOverflowTransfer(source, destination, candidate.resource, amount)) {
        if (amount > 0) created++;
        if (amount > 0) break;
      }
    }
  }
  if (created > 0 || reconciled) memoryManager.requestSave();
  return created;
}

function status() {
  const mem = ensureMemory();
  const deficits = calculateDeficits();
  return {
    enabled: mem.enabled,
    mode: mem.mode,
    targets: Object.assign({}, EMPIRE_TARGETS),
    deficits: deficits,
    jobs: Object.keys(mem.jobs).length,
    transfers: Object.keys(mem.transfers).length,
    lastRun: mem.lastRun,
    lastPlan: mem.lastPlan,
  };
}

function parseJobsOptions(options) {
  if (typeof options === "boolean") return { all: options };
  if (typeof options === "string") return { room: options };
  if (options && typeof options === "object") return options;
  return {};
}

function formatJobLine(job, mem) {
  const amountStr = typeof job.amount === "number" ? job.amount.toLocaleString() : job.amount;
  const stateStr = (job.state || "unknown").toUpperCase();
  const roomStr = job.roomName ? " @ " + job.roomName : "";
  const scopeStr = job.scope === "room" ? " (room)" : "";

  const extras = [];
  if (job.operationId) extras.push("lab op #" + job.operationId);
  if (job.purchaseQueue && Array.isArray(job.purchaseQueue) && job.purchaseQueue.length > 0) {
    extras.push(job.purchaseQueue.length + " buy order" + (job.purchaseQueue.length > 1 ? "s" : ""));
  }
  if (job.state === "queued" && job.children && job.children.length > 0) {
    let pendingChildren = 0;
    for (let i = 0; i < job.children.length; i++) {
      const child = mem.jobs && mem.jobs[job.children[i]];
      if (child && child.state !== "done") pendingChildren++;
    }
    if (pendingChildren > 0) {
      extras.push("waiting on " + pendingChildren + " sub-job" + (pendingChildren > 1 ? "s" : ""));
    }
  }
  if (job.lastResult && (job.state === "failed" || job.state === "queued")) {
    extras.push(job.lastResult);
  }

  const extraStr = extras.length > 0 ? " (" + extras.join(", ") + ")" : "";
  return job.id + " [" + stateStr + "] " + amountStr + " " + job.resource + roomStr + scopeStr + extraStr;
}

function renderJobSubtree(jobId, mem, prefix, isLast, lines, visited, showAll) {
  if (visited[jobId]) return;
  visited[jobId] = true;
  const job = mem.jobs && mem.jobs[jobId];
  if (!job) return;

  const branch = isLast ? "└── " : "├── ";
  lines.push(prefix + branch + formatJobLine(job, mem));

  const children = (job.children || []).filter(function(cid) {
    const c = mem.jobs && mem.jobs[cid];
    if (!c) return false;
    if (!showAll && c.state === "failed" && job.state === "done") return false;
    return true;
  });

  const nextPrefix = prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < children.length; i++) {
    renderJobSubtree(children[i], mem, nextPrefix, i === children.length - 1, lines, visited, showAll);
  }
}

function jobsText(options) {
  const opts = parseJobsOptions(options);
  const mem = ensureMemory();
  const showAll = !!opts.all;
  const filterRoom = opts.room || null;

  const lines = [];
  const rootJobIds = [];
  const visited = {};

  for (const id in mem.jobs) {
    const job = mem.jobs[id];
    if (!job) continue;
    if (filterRoom && job.roomName !== filterRoom) continue;
    const isRoot = !job.parentId || !mem.jobs[job.parentId];
    if (isRoot) {
      if (showAll || (job.state !== "done" && job.state !== "failed")) {
        rootJobIds.push(id);
      }
    }
  }

  const activeTransfers = [];
  for (const id in mem.transfers) {
    const t = mem.transfers[id];
    if (!t) continue;
    if (filterRoom && t.fromRoom !== filterRoom && t.toRoom !== filterRoom) continue;
    if (showAll || (t.status !== "completed" && t.status !== "failed")) {
      activeTransfers.push({ id: id, transfer: t });
    }
  }

  const activeRequests = [];
  for (const id in mem.requests) {
    const r = mem.requests[id];
    if (!r) continue;
    if (filterRoom && r.roomName !== filterRoom) continue;
    if (showAll || r.active !== false) {
      activeRequests.push({ id: id, request: r });
    }
  }

  const activeJobCount = activeRootJobs(mem);
  lines.push("[Stockpile Active Work] mode=" + mem.mode + " | " + activeJobCount + " active root job" + (activeJobCount === 1 ? "" : "s") + " | " + activeTransfers.length + " transfer" + (activeTransfers.length === 1 ? "" : "s"));

  if (rootJobIds.length === 0 && activeTransfers.length === 0 && activeRequests.length === 0) {
    lines.push("  No active jobs or transfers.");
    return lines.join("\n");
  }

  if (rootJobIds.length > 0) {
    lines.push("");
    lines.push("-- Jobs --");
    for (let i = 0; i < rootJobIds.length; i++) {
      const rootId = rootJobIds[i];
      const job = mem.jobs[rootId];
      if (!job) continue;
      visited[rootId] = true;
      lines.push("* " + formatJobLine(job, mem));
      const children = (job.children || []).filter(function(cid) { return !!mem.jobs[cid]; });
      for (let c = 0; c < children.length; c++) {
        renderJobSubtree(children[c], mem, "  ", c === children.length - 1, lines, visited, showAll);
      }
    }
  }

  if (activeTransfers.length > 0) {
    lines.push("");
    lines.push("-- Inter-Room Transfers --");
    for (let i = 0; i < activeTransfers.length; i++) {
      const entry = activeTransfers[i];
      const t = entry.transfer;
      const amountStr = typeof t.amount === "number" ? t.amount.toLocaleString() : t.amount;
      const statusStr = (t.status || "queued").toUpperCase();
      const opStr = t.terminalOpId ? " (terminal op: #" + t.terminalOpId + ")" : "";
      lines.push("* " + entry.id + " [" + statusStr + "] " + amountStr + " " + t.resource + ": " + t.fromRoom + " -> " + t.toRoom + opStr);
    }
  }

  if (activeRequests.length > 0) {
    lines.push("");
    lines.push("-- Boost Requests --");
    for (let i = 0; i < activeRequests.length; i++) {
      const entry = activeRequests[i];
      const r = entry.request;
      const amountStr = typeof r.amount === "number" ? r.amount.toLocaleString() : r.amount;
      const prioStr = r.priority ? ", priority: " + r.priority : "";
      lines.push("* " + r.roomName + ": " + amountStr + " " + r.compound + " (active: " + (r.active !== false) + prioStr + ")");
    }
  }

  return lines.join("\n");
}

function statusText(options) {
  const value = status();
  const verbose = options === true || (options && (options.verbose || options.all));
  const lines = [
    "[Stockpile] enabled=" + value.enabled + " mode=" + value.mode + " jobs=" + value.jobs,
  ];
  for (let i = 0; i < value.deficits.length; i++) {
    const d = value.deficits[i];
    lines.push("  " + d.resource + " " + d.deficit + " short (" + d.physical + "/" + d.target + ")" + (d.roomName ? " in " + d.roomName : ""));
  }
  if (value.deficits.length === 0) lines.push("  no target deficits");
  if (verbose) {
    lines.push("");
    lines.push(jobsText(options));
  }
  return lines.join("\n");
}

function requestBoost(roomName, compound, amount, options) {
  if (!roomName || !compound || !(amount > 0)) return { ok: false, reason: "invalid request" };
  const mem = ensureMemory();
  const id = roomName + "|" + compound;
  mem.requests[id] = {
    roomName: roomName,
    compound: compound,
    amount: Math.ceil(amount),
    priority: options && options.priority || "normal",
    active: true,
    updated: Game.time,
  };
  memoryManager.requestSave();
  return { ok: true, id: id, amount: mem.requests[id].amount };
}

function cancelBoost(roomName, compound) {
  const mem = ensureMemory();
  const id = roomName + "|" + compound;
  if (!mem.requests[id]) return false;
  delete mem.requests[id];
  memoryManager.requestSave();
  return true;
}

function run() {
  const mem = ensureMemory();
  mem.lastRun = Game.time;
  if (compactTerminalJobs(mem)) memoryManager.requestSave();
  if (!mem.enabled) return status();
  if (mem.mode === MODE_ACTIVE) {
    processExistingJobs();
    pruneJobs();
  }
  if (Game.time - mem.lastPlan < PLAN_INTERVAL) return status();
  mem.lastPlan = Game.time;
  if (mem.mode === MODE_RESERVE || mem.mode === MODE_ACTIVE) reconcileReservations();
  if (mem.mode === MODE_ACTIVE) {
    processDeficits();
    processOverflow();
  }
  return status();
}

global.stockpileStatus = statusText;
global.stockpileJobs = jobsText;
global.stockpileActive = jobsText;
global.stockpileEnable = function() {
  const mem = ensureMemory();
  mem.enabled = true;
  mem.mode = MODE_RESERVE;
  memoryManager.requestSave();
  return "[Stockpile] enabled in reserve mode";
};
global.stockpileDisable = function() {
  const mem = ensureMemory();
  clearStaleReservations();
  const rooms = ownedRoomNames();
  const resources = allManagedResources(rooms, externalDemands(rooms));
  for (let i = 0; i < rooms.length; i++) {
    for (let r = 0; r < resources.length; r++) clearReservation(rooms[i], resources[r]);
  }
  mem.enabled = false;
  memoryManager.requestSave();
  return "[Stockpile] disabled; existing jobs are left intact";
};
global.stockpileMode = function(mode) {
  const mem = ensureMemory();
  if ([MODE_OBSERVE, MODE_RESERVE, MODE_ACTIVE].indexOf(mode) < 0) return "[Stockpile] mode must be observe, reserve, or active";
  mem.mode = mode;
  mem.enabled = mode !== MODE_OBSERVE;
  memoryManager.requestSave();
  return "[Stockpile] mode=" + mode;
};

module.exports = {
  run: run,
  status: status,
  getStatus: status,
  statusText: statusText,
  jobs: jobsText,
  jobsText: jobsText,
  requestBoost: requestBoost,
  cancelBoost: cancelBoost,
  calculateDeficits: calculateDeficits,
  reconcileReservations: reconcileReservations,
  collectMarketCommitments: collectMarketCommitments,
  processJob: processJob,
  processOverflow: processOverflow,
  cheapestRoute: cheapestRoute,
  EMPIRE_TARGETS: EMPIRE_TARGETS,
  X_COMPOUNDS: X_COMPOUNDS,
  GHODIUM_ROOM_TARGET: GHODIUM_ROOM_TARGET,
  BATTERY_ROOM_TARGET: BATTERY_ROOM_TARGET,
};
