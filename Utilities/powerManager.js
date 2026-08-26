// LLM: Read docs/codex.js before reviewing or changing this file.
// powerManager.js
// Console globals: powerStatus, powerUpgradeToLevel, cancelPowerUpgrade, freePowerLevels
// Example: powerStatus() - Show power creep status, levels, ops and power bank processing
// Example: powerUpgradeToLevel('E1N1', 5) - Set target power level upgrade for room
// Example: cancelPowerUpgrade('E1N1') - Cancel scheduled power upgrade for room
// Example: freePowerLevels() - Display unassigned account power levels
//   powerUpgradeToLevel(level)
//   cancelPowerUpgrade()
//   powerStatus()
//   freePowerLevels()
const opportunisticBuy = require("opportunisticBuy");
const getRoomState = require("getRoomState");
const roomSuspender = require("roomSuspender");
const pricing = require("marketPricing");
const memoryManager = require("memoryManager");
const economics = require("economics");
const PROCESS_INTERVAL = 50;
const PURCHASE_TRANCHE = 1e3;
const POWER_SPAWN_REBUY_FLOOR = 100;
const POWER_REQUEST_STALL_TICKS = 100;
const PRICE_CAP_MULTIPLIER = 1.25;
const BUY_OPTS = {
  queue: "powerUpgrade",
  opId: "global",
  product: "gpl",
  direction: "buy",
  includeTransferCost: true,
  externalOnly: true
};
function findPowerSpawns(e) {
  const r = getRoomState.get(e.name);
  const t = r && r.structuresByType;
  const o = t && t[STRUCTURE_POWER_SPAWN] || [];
  return o.filter(e => e.my);
}

function eligibleRooms() {
  const e = [];
  const r = getRoomState.ownedNames().slice().sort();
  for (let t = 0; t < r.length; t++) {
    const o = Game.rooms[r[t]];
    if (!o || !o.storage || !o.terminal) continue;
    if (roomSuspender.shouldAvoidRoomWork(o.name)) continue;
    const n = findPowerSpawns(o);
    if (n.length === 0) continue;
    e.push({
      room: o,
      powerSpawns: n
    });
  }
  return e;
}

function cumulativePower(e) {
  const r = typeof POWER_LEVEL_MULTIPLY === "number" ? POWER_LEVEL_MULTIPLY : 1e3;
  const t = typeof POWER_LEVEL_POW === "number" ? POWER_LEVEL_POW : 2;
  if (t === 2) {
    return e * (e + 1) * (2 * e + 1) / 6 * r;
  }
  let o = 0;
  for (let n = 1; n <= e; n++) o += Math.pow(n, t) * r;
  return o;
}

function powerNeededForTarget(e) {
  if (!(e > Game.gpl.level)) return 0;
  return Math.max(0, cumulativePower(e) - cumulativePower(Game.gpl.level) - Game.gpl.progress);
}

function roomPower(e) {
  const r = e.room;
  let t = (r.storage.store[RESOURCE_POWER] || 0) + (r.terminal.store[RESOURCE_POWER] || 0);
  for (let r = 0; r < e.powerSpawns.length; r++) {
    t += e.powerSpawns[r].store[RESOURCE_POWER] || 0;
  }
  const o = getRoomState.creepIndex().all;
  for (let e = 0; e < o.length; e++) {
    if (o[e].room && o[e].room.name === r.name) {
      t += o[e].store[RESOURCE_POWER] || 0;
    }
  }
  return t;
}

function getActiveRequest(e) {
  for (let r = 0; r < e.length; r++) {
    const t = opportunisticBuy.getRequest(e[r].room.name, RESOURCE_POWER, BUY_OPTS);
    if (t && !t.stopAfterPending) return t;
  }
  const r = opportunisticBuy && typeof opportunisticBuy.getActiveRequestRecords === "function" ? opportunisticBuy.getActiveRequestRecords() : [];
  for (let e = 0; e < r.length; e++) {
    const t = r[e];
    if (t && t.queue === BUY_OPTS.queue && t.opId === BUY_OPTS.opId && t.resourceType === RESOURCE_POWER && !t.stopAfterPending) return t;
  }
  return null;
}

function isPowerRequest(e) {
  return !!(e && e.queue === BUY_OPTS.queue && e.opId === BUY_OPTS.opId && e.resourceType === RESOURCE_POWER);
}

function isStalledPurchase(e) {
  if (!isPowerRequest(e) || e.stopAfterPending || e.pending) return false;
  const r = typeof e.lastProgressTick === "number" ? e.lastProgressTick : e.createdAt || Game.time;
  return Game.time - r >= POWER_REQUEST_STALL_TICKS;
}

function hasPurchaseForRoom(e, r) {
  for (let t = 0; t < e.length; t++) {
    const o = e[t];
    if (!isPowerRequest(o) || o.roomName !== r) continue;
    if (!o.stopAfterPending && (o.remaining || 0) > 0) return true;
    if (o.pending && typeof o.pending.expected === "number") return true;
  }
  return false;
}

function committedPurchaseForRoom(e, r) {
  let t = 0;
  for (let o = 0; o < e.length; o++) {
    const n = e[o];
    if (!isPowerRequest(n) || n.roomName !== r) continue;
    const s = n.pending && n.pending.expected || 0;
    t += n.stopAfterPending ? s : Math.max(n.remaining || 0, s);
  }
  return t;
}

function balancedPowerLevel(e, r) {
  const t = e.reduce((e, r) => e + r, 0);
  const o = Math.max(0, r - t);
  let n = 0;
  let s = PURCHASE_TRANCHE;
  for (let r = 0; r < 8; r++) {
    const r = (n + s) / 2;
    let t = 0;
    for (let o = 0; o < e.length; o++) {
      t += Math.max(0, r - e[o]);
    }
    if (t <= o) n = r; else s = r;
  }
  return n;
}

function cancelPurchases() {
  const e = opportunisticBuy && typeof opportunisticBuy.getActiveRequestRecords === "function" ? opportunisticBuy.getActiveRequestRecords() : [];
  const r = [];
  for (let t = 0; t < e.length; t++) {
    const o = e[t];
    if (o && o.queue === BUY_OPTS.queue && o.opId === BUY_OPTS.opId && o.resourceType === RESOURCE_POWER) r.push(o.roomName);
  }
  for (let e = 0; e < r.length; e++) {
    opportunisticBuy.cancelRequest(r[e], RESOURCE_POWER, Object.assign({
      settlePending: true
    }, BUY_OPTS));
  }
}

function clearPowerBotRequests() {
  const e = Memory.spawnRequests || {};
  for (const r in e) {
    if (e[r] && e[r].needPowerBot) {
      e[r].needPowerBot = false;
    }
  }
}

function finishUpgrade(e) {
  cancelPurchases();
  clearPowerBotRequests();
  delete Memory.powerUpgrade;
  memoryManager.requestSave();
  if (e) console.log("[PowerUpgrade] " + e);
}

function updateEligibleRoomMemory(e, r) {
  const t = r.map(e => e.room.name);
  const o = e.rooms || [];
  if (o.length === t.length && o.every((e, r) => e === t[r])) return;
  e.rooms = t;
  memoryManager.requestSave();
}

function updatePrice(e) {
  let r = pricing.getAvg48h(RESOURCE_POWER);
  let t = "48h weighted average";
  if (!(r > 0)) {
    r = pricing.getAvg7d(RESOURCE_POWER);
    t = "7d weighted average";
  }
  const o = pricing.getStatusEnergyPrice();
  e.priceCap = r > 0 ? r * PRICE_CAP_MULTIPLIER : null;
  e.priceSource = r > 0 ? t : "unavailable";
  e.energyPrice = o > 0 ? o : null;
  return e.priceCap > 0 && e.energyPrice > 0;
}

function pendingPurchasePower(e) {
  let r = 0;
  for (let t = 0; t < e.length; t++) {
    const o = e[t];
    if (!o || o.queue !== BUY_OPTS.queue || o.opId !== BUY_OPTS.opId || o.resourceType !== RESOURCE_POWER) continue;
    const n = o.pending && o.pending.expected || 0;
    r += o.stopAfterPending ? n : Math.max(o.remaining || 0, n);
  }
  return r;
}

function managePurchase(e, r, t) {
  let o = opportunisticBuy && typeof opportunisticBuy.getActiveRequestRecords === "function" ? opportunisticBuy.getActiveRequestRecords().filter(isPowerRequest) : [];
  const n = getActiveRequest(r);
  if (n) {
    if (isStalledPurchase(n)) {
      opportunisticBuy.cancelRequest(n.roomName, RESOURCE_POWER, BUY_OPTS);
      o = opportunisticBuy.getActiveRequestRecords().filter(isPowerRequest);
    } else if (!r.some(e => e.room.name === n.roomName)) {
      opportunisticBuy.cancelRequest(n.roomName, RESOURCE_POWER, Object.assign({
        settlePending: true
      }, BUY_OPTS));
      o = opportunisticBuy.getActiveRequestRecords().filter(isPowerRequest);
    } else {
      return;
    }
  }
  if (t <= 0 || r.length === 0) return;
  const s = r.map(roomPower);
  const i = s.reduce((e, r) => e + r, 0);
  const a = pendingPurchasePower(o);
  const c = r.map((e, r) => s[r] + committedPurchaseForRoom(o, e.room.name));
  const u = r.length * PURCHASE_TRANCHE;
  const l = t >= u;
  const p = c.reduce((e, r) => e + Math.min(r, PURCHASE_TRANCHE), 0);
  const m = l ? p : i + a;
  const g = l ? u : Math.min(t, u);
  if (m >= g) return;
  const R = l ? PURCHASE_TRANCHE : balancedPowerLevel(c, g);
  let P = 0;
  if (e.purchaseCursor) {
    const t = r.findIndex(r => r.room.name === e.purchaseCursor);
    if (t >= 0) P = (t + 1) % r.length;
  }
  let d = -1;
  for (let e = 0; e < r.length; e++) {
    const t = (P + e) % r.length;
    const n = l ? c[t] < POWER_SPAWN_REBUY_FLOOR : c[t] < R;
    if (!n) continue;
    if (hasPurchaseForRoom(o, r[t].room.name)) continue;
    d = t;
    break;
  }
  if (d < 0) return;
  const E = Math.max(0, PURCHASE_TRANCHE - s[d]);
  const f = l ? Math.max(0, PURCHASE_TRANCHE - c[d]) : Math.max(0, Math.ceil(R - c[d]));
  if (!updatePrice(e)) return;
  const w = Math.min(PURCHASE_TRANCHE, E, f, g - m);
  if (w <= 0) return;
  opportunisticBuy.setup(r[d].room.name, RESOURCE_POWER, w, e.priceCap, Object.assign({
    energyPrice: e.energyPrice
  }, BUY_OPTS));
  e.purchaseCursor = r[d].room.name;
  memoryManager.requestSave();
}

function processPower(e) {
  if (Game.time % PROCESS_INTERVAL !== 0) return;
  for (let r = 0; r < e.length; r++) {
    const t = e[r].powerSpawns;
    for (let e = 0; e < t.length; e++) {
      const r = t[e];
      if ((r.store[RESOURCE_POWER] || 0) >= 1 && (r.store[RESOURCE_ENERGY] || 0) >= 50) {
        r.processPower();
      }
    }
  }
}

function alertForNewPowerCreep() {
  if (!Memory._lastGplAlertLevel) Memory._lastGplAlertLevel = 0;
  const e = Object.keys(Game.powerCreeps).length;
  if (Game.gpl.level <= e || Game.gpl.level <= Memory._lastGplAlertLevel) return;
  Memory._lastGplAlertLevel = Game.gpl.level;
  const r = "GPL " + Game.gpl.level + " reached! You have " + e + " Power Creep(s). Create a new power creep when ready.";
  console.log("[PowerUpgrade] " + r);
  Game.notify(r);
  memoryManager.requestSave();
}

global.powerUpgradeToLevel = function(e) {
  const r = Number(e);
  if (!Number.isInteger(r) || r < 0) {
    return "ERROR: powerUpgradeToLevel(level) requires a non-negative integer.";
  }
  cancelPurchases();
  if (r <= Game.gpl.level) {
    finishUpgrade("Target GPL " + r + " is already reached.");
    memoryManager.requestImmediateSave("powerManager.setReachedTarget");
    return "Power upgrade inactive: GPL " + Game.gpl.level + " already meets target " + r + ".";
  }
  Memory.powerUpgrade = {
    targetLevel: r,
    rooms: []
  };
  delete Memory.power;
  clearPowerBotRequests();
  memoryManager.requestImmediateSave("powerManager.setTarget");
  return "Power upgrade target set to GPL " + r + ". Eligible rooms will be allocated automatically.";
};
global.cancelPowerUpgrade = function() {
  const e = !!Memory.powerUpgrade;
  cancelPurchases();
  clearPowerBotRequests();
  delete Memory.powerUpgrade;
  delete Memory.power;
  memoryManager.requestImmediateSave("powerManager.cancel");
  return e ? "Power upgrade cancelled." : "No active power upgrade.";
};
global.freePowerLevels = function() {
  //   1 GPL per level gained on an existing Power Creep, and
  //   1 GPL to create a new 0-level Power Creep.
  let e = 0;
  let r = 0;
  for (const t in Game.powerCreeps) {
    const o = Game.powerCreeps[t];
    const n = o && typeof o.level === "number" ? o.level : 0;
    r += n;
    e += n + 1;
  }
  const t = Math.max(0, Game.gpl.level - e);
  return t + " unoccupied GPL slot(s) (GPL " + Game.gpl.level + ", " + Object.keys(Game.powerCreeps).length + " Power Creep(s) at total level " + r + ", " + e + " GPL consumed).";
};
global.powerStatus = function() {
  const e = Memory.powerUpgrade;
  const r = [ "GPL " + Game.gpl.level + " progress: " + Game.gpl.progress + "/" + Game.gpl.progressTotal ];
  const t = economics.powerProcessingSummary();
  r.push("Today GPL processing: " + t.power + " power + " + t.energy + " energy | replacement cost " + Math.round(t.cost) + " credits" + " (power " + Math.round(t.powerCost) + ", energy " + Math.round(t.energyCost) + ")");
  if (!e) {
    r.push("No active power upgrade.");
    return r.join("\n");
  }
  const o = eligibleRooms();
  const n = powerNeededForTarget(e.targetLevel);
  const s = getActiveRequest(o);
  r.push("Target: GPL " + e.targetLevel + " | Remaining: " + n + " power");
  const i = n * economics.POWER_PROCESS_ENERGY;
  const a = economics.value(RESOURCE_POWER, n) + economics.value(RESOURCE_ENERGY, i);
  r.push("Estimated remaining input cost: " + Math.round(a) + " credits (" + n + " power + " + i + " energy)");
  r.push("Price cap: " + (e.priceCap > 0 ? e.priceCap.toFixed(3) : "waiting") + " (" + (e.priceSource || "not assessed") + ", transfer energy included)");
  r.push("Next processing tick: " + (Game.time + (PROCESS_INTERVAL - Game.time % PROCESS_INTERVAL) % PROCESS_INTERVAL));
  for (let e = 0; e < o.length; e++) {
    r.push(o[e].room.name + ": " + roomPower(o[e]) + "/" + PURCHASE_TRANCHE + " power reserve");
  }
  if (o.length === 0) r.push("No eligible rooms (power spawn + storage + terminal required).");
  if (s) {
    const e = s.pending && s.pending.expected || 0;
    r.push("Buying in " + s.roomName + ": " + s.remaining + " remaining" + (e ? ", " + e + " pending settlement" : ""));
  }
  return r.join("\n");
};
function run() {
  alertForNewPowerCreep();
  if (Memory.powerUpgrade || Memory.power) clearPowerBotRequests();
  const e = Memory.powerUpgrade;
  if (!e) return;
  if (!(e.targetLevel > Game.gpl.level)) {
    finishUpgrade("Target GPL " + e.targetLevel + " reached.");
    return;
  }
  const r = eligibleRooms();
  updateEligibleRoomMemory(e, r);
  const t = powerNeededForTarget(e.targetLevel);
  managePurchase(e, r, t);
  processPower(r);
}

module.exports = {
  run: run,
  isRoomActive: function(e) {
    const r = Memory.powerUpgrade;
    return !!(r && r.targetLevel > Game.gpl.level && r.rooms && r.rooms.indexOf(e) >= 0);
  }
};
