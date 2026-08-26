// LLM: Read docs/codex.js before reviewing or changing this file.
// roomSuspender.js
// Console globals: roomSuspendStatus, roomSuspendPlan, getSuspendedRooms, forceSuspendRoom, forceResumeRoom
// Example: roomSuspendStatus() - Display suspension status across all rooms
// Example: roomSuspendPlan() - Inspect full room suspension planning metrics
// Example: getSuspendedRooms() - Return array of currently suspended room names
// Example: forceSuspendRoom('E1N1') - Force room into suspended low-CPU mode
// Example: forceResumeRoom('E1N1') - Resume suspended room to active processing
"use strict";
const getRoomState = require("getRoomState");
const memoryManager = require("memoryManager");
const heap = memoryManager.heap;
const SUSPEND_BUCKET = 2800;
const RESUME_BUCKET = 3500;
const MIN_STRUCTURE_HEALTH = .5;
const CONTAINER_RESUME_PCT = .4;
const CONTAINER_ENTRY_PCT = .75;
const CONTAINER_RESUME_HITS = 1e5;
const CONTAINER_ENTRY_HITS = 187.5e3;
const ROAD_RESUME_PCT = .35;
const ROAD_ENTRY_PCT = .65;
const RAMPART_RESUME_HITS_RCL2 = 1e4;
const RAMPART_RESUME_HITS_RCL3 = 25e3;
const RAMPART_ENTRY_HITS_RCL2 = 1e4;
const RAMPART_ENTRY_HITS_RCL3 = 6e4;
const HARVESTER_ENERGY_FLOOR = 3e3;
const VITALS_TTL = 25;
const ADAPT_SAMPLE_TICKS = 25;
const CPU_PRESSURE_RATIO = .9;
const MINERAL_EXTRACTION_PENALTY = 100;
const ACTIVE_JOB_PENALTY = 200;
const SOFT_FACTORY_PENALTY = 20;
const SOFT_LAB_PENALTY = 20;
const NON_RCL8_PENALTY = 10;
const NON_RCL8_ORDER_PENALTY = 30;
const CONSTRUCTION_PENALTY = 10;
const TOWER_DEGRADATION_PENALTY = 10;
const CONTAINER_DEGRADATION_PENALTY = 20;
const ROAD_DEGRADATION_PENALTY = 20;
const RAMPART_DEGRADATION_PENALTY = 20;
const MILITARY_ROLES = {
  attacker: true,
  harasser: true,
  healer: true,
  towerDrain: true,
  drainDemolisher: true,
  demolition: true,
  contestedDemolisher: true,
  quad: true,
  controllerAttacker: true,
  skAttacker: true,
  thief: true,
  claimbot: true
};
let depositHarvesterRoomsTick = -1;
let depositHarvesterRooms = {};
let roomActivityRoomsTick = -1;
let roomActivityRooms = {};
let roomActivityFlagsTick = -1;
let roomActivityFlags = {};
function ensureMemory() {
  let e = false;
  if (!Memory.suspendedRooms) {
    Memory.suspendedRooms = {};
    e = true;
  }
  if (!Memory.roomSuspenderControl) {
    Memory.roomSuspenderControl = {};
    e = true;
  }
  if (e) memoryManager.requestSave();
}

function getVitalsCache() {
  if (!heap.roomSuspenderVitals) {
    const e = Memory.roomSuspenderVitals;
    heap.roomSuspenderVitals = e && typeof e === "object" ? e : {};
    if (e !== undefined) {
      delete Memory.roomSuspenderVitals;
      memoryManager.requestSave();
    }
  }
  return heap.roomSuspenderVitals;
}

function getSampleCache() {
  if (!heap.roomSuspenderSample) heap.roomSuspenderSample = {};
  return heap.roomSuspenderSample;
}

function getOwnedRooms() {
  return getRoomState.ownedNames().slice();
}

function pruneOldRooms(e) {
  let o = false;
  for (const r in Memory.suspendedRooms) {
    if (!e[r]) {
      delete Memory.suspendedRooms[r];
      o = true;
    }
  }
  const r = getVitalsCache();
  for (const o in r) if (!e[o]) delete r[o];
  return o;
}

function hasHostilesNow(e) {
  const o = getRoomState.get(e);
  return !!(o && o.hostiles && o.hostiles.length > 0);
}

function hasEconomyCreepGap(e) {
  const o = getRoomState.creepIndex();
  const r = o && o.byHomeRoom && o.byHomeRoom[e];
  if (!r || r.length === 0) return false;
  let t = false;
  let n = false;
  let s = false;
  for (let e = 0; e < r.length; e++) {
    const o = r[e] && r[e].memory && r[e].memory.role;
    if (o === "harvester") t = true; else if (o === "supplier") n = true; else if (o === "hd" || o === "staticDistributor" || o === "comboBot") {
      s = true;
    }
  }
  return t && !n && !s;
}

function markRoomFlag(e, o) {
  if (!e) return;
  if (!roomActivityFlags[e]) roomActivityFlags[e] = {};
  roomActivityFlags[e][o] = true;
}

function markCreepRooms(e, o) {
  if (!e || !e.memory) return;
  if (e.room) markRoomFlag(e.room.name, o);
  markRoomFlag(e.memory.homeRoom, o);
  markRoomFlag(e.memory.assignedRoom, o);
  markRoomFlag(e.memory.targetRoom, o);
}

function markMilitaryCreepRoom(e) {
  const o = e.memory;
  const r = o.homeRoom || o.spawnRoom || o.rallyRoom || o.assignedRoom || o.orderRoom;
  markRoomFlag(r || e.room && e.room.name, "militaryOperation");
}

function isOperationalMilitaryOrder(e) {
  return e && !e.dryRun && e.status !== "failed" && e.status !== "dryrun_complete";
}

function buildRoomActivityFlags() {
  if (roomActivityFlagsTick === Game.time) return roomActivityFlags;
  roomActivityFlagsTick = Game.time;
  roomActivityFlags = {};
  const e = getRoomState.creepIndex();
  const o = e && e.all ? e.all : [];
  for (let e = 0; e < o.length; e++) {
    const r = o[e];
    if (!r || !r.memory) continue;
    const t = r.memory.role;
    if (t === "extractor" || t === "extractorAssistant" || t === "comboBot") {
      markCreepRooms(r, "mineralActivity");
    } else if (t === "depositHarvester") {
      markCreepRooms(r, "depositHarvester");
    }
    if (MILITARY_ROLES[t]) markMilitaryCreepRoom(r);
  }
  if (Memory.depositObserver && Memory.depositObserver.jobs) {
    const e = Memory.depositObserver.jobs;
    for (const o in e) {
      const r = e[o];
      if (!r || r.completed) continue;
      markRoomFlag(r.homeRoom, "depositHarvester");
      markRoomFlag(r.roomName, "depositHarvester");
    }
  }
  const r = require("marketLab");
  const t = r && typeof r.getOperations === "function" ? r.getOperations() : [];
  for (let e = 0; e < t.length; e++) {
    const o = t[e];
    if (o && o.room && o.state !== "SELLING") {
      markRoomFlag(o.room, "lab");
    }
  }
  const n = require("factoryManager");
  const s = n && typeof n.getOrders === "function" ? n.getOrders() : [];
  for (let e = 0; e < s.length; e++) {
    const o = s[e];
    if (!o || !o.room) continue;
    if (o.status === "done" || o.status === "cancelled") continue;
    markRoomFlag(o.room, "factory");
  }
  if (Memory.attackOrders) {
    for (const e in Memory.attackOrders) {
      const o = Memory.attackOrders[e];
      if (o) markRoomFlag(o.spawnRoom, "militaryOperation");
    }
  }
  if (Memory.healOrders) {
    for (const e in Memory.healOrders) {
      const o = Memory.healOrders[e];
      if (o) markRoomFlag(o.spawnRoom, "militaryOperation");
    }
  }
  if (Memory.towerDrainOps && Memory.towerDrainOps.operations) {
    const e = Memory.towerDrainOps.operations;
    for (const o in e) {
      const r = e[o];
      if (isOperationalMilitaryOrder(r)) {
        markRoomFlag(r.homeRoom, "militaryOperation");
      }
    }
  }
  if (Memory.demolitionOrders) {
    for (const e in Memory.demolitionOrders) {
      const o = Memory.demolitionOrders[e];
      if (o) markRoomFlag(o.homeRoom, "militaryOperation");
    }
  }
  if (Memory.contestedDemolisherOrders) {
    for (const e in Memory.contestedDemolisherOrders) {
      const o = Memory.contestedDemolisherOrders[e];
      if (isOperationalMilitaryOrder(o)) {
        markRoomFlag(o.homeRoom, "militaryOperation");
      }
    }
  }
  if (Memory.squadOrders) {
    for (const e in Memory.squadOrders) {
      const o = Memory.squadOrders[e];
      if (o) markRoomFlag(o.homeRoom, "militaryOperation");
    }
  }
  if (Memory.controllerAttackOrders) {
    for (const e in Memory.controllerAttackOrders) {
      const o = Memory.controllerAttackOrders[e];
      if (o) markRoomFlag(o.homeRoom, "militaryOperation");
    }
  }
  if (Memory.skAttackOrders) {
    for (const e in Memory.skAttackOrders) {
      const o = Memory.skAttackOrders[e];
      if (o && o.active !== false) {
        markRoomFlag(o.spawnRoom, "militaryOperation");
      }
    }
  }
  if (Memory.thiefOrders) {
    for (const e in Memory.thiefOrders) {
      const o = Memory.thiefOrders[e];
      if (o) markRoomFlag(o.homeRoom, "militaryOperation");
    }
  }
  const i = require("marketRefine");
  const a = i && typeof i.getOperations === "function" ? i.getOperations() : [];
  for (let e = 0; e < a.length; e++) {
    if (a[e] && a[e].room) {
      markRoomFlag(a[e].room, "activeJob");
    }
  }
  const m = require("localRefine");
  const c = m && typeof m.getOperations === "function" ? m.getOperations() : [];
  for (let e = 0; e < c.length; e++) {
    if (c[e] && c[e].room) {
      markRoomFlag(c[e].room, "activeJob");
    }
  }
  if (Memory.marketArbitrage) {
    const e = Memory.marketArbitrage;
    if (e.operations) {
      for (const o in e.operations) {
        if (e.operations[o]) markRoomFlag(o, "activeJob");
      }
    }
    if (e.selfArbPending) {
      for (const o in e.selfArbPending) {
        if (e.selfArbPending[o]) markRoomFlag(o, "activeJob");
      }
    }
    if (e.buffered && Array.isArray(e.buffered)) {
      for (let o = 0; o < e.buffered.length; o++) {
        if (e.buffered[o] && e.buffered[o].roomName) markRoomFlag(e.buffered[o].roomName, "activeJob");
      }
    }
    if (e.groups) {
      for (const o in e.groups) {
        const r = e.groups[o];
        if (!r || !r.members) continue;
        if (r.createdTick && Game.time - r.createdTick > 1e3) continue;
        if (Array.isArray(r.members)) {
          for (let e = 0; e < r.members.length; e++) {
            if (typeof r.members[e] === "string") markRoomFlag(r.members[e], "activeJob"); else if (r.members[e] && r.members[e].roomName) markRoomFlag(r.members[e].roomName, "activeJob");
          }
        } else {
          for (const e in r.members) {
            if (r.members[e]) markRoomFlag(e, "activeJob");
          }
        }
      }
    }
  }
  return roomActivityFlags;
}

function hasFlag(e, o) {
  const r = buildRoomActivityFlags();
  return !!(r[e] && r[e][o]);
}

function hasLabOrder(e) {
  return hasFlag(e, "lab");
}

function hasAnyLabOrder(e) {
  const o = Memory.labOrders && Memory.labOrders[e];
  if (o && (o.active || Array.isArray(o.queue) && o.queue.length > 0)) return true;
  return hasLabOrder(e);
}

function hasFactoryOrder(e) {
  return hasFlag(e, "factory");
}

function hasHardActiveJob(e) {
  return hasFlag(e, "activeJob");
}

function hasMilitaryOperation(e) {
  return hasFlag(e, "militaryOperation");
}

function getRoomActivityRooms() {
  if (roomActivityRoomsTick === Game.time) return roomActivityRooms;
  roomActivityRoomsTick = Game.time;
  roomActivityRooms = {};
  const e = buildRoomActivityFlags();
  for (const o in e) {
    if (e[o].mineralActivity) roomActivityRooms[o] = true;
  }
  return roomActivityRooms;
}

function hasDepositHarvester(e) {
  if (depositHarvesterRoomsTick !== Game.time) {
    depositHarvesterRoomsTick = Game.time;
    depositHarvesterRooms = {};
    const e = buildRoomActivityFlags();
    for (const o in e) {
      if (e[o].depositHarvester) depositHarvesterRooms[o] = true;
    }
  }
  return !!depositHarvesterRooms[e];
}

function hasPowerCreepInRoom(e) {
  const o = getRoomState.get(e);
  if (o && o.myPowerCreeps && o.myPowerCreeps.length > 0) return true;
  for (const o in Game.powerCreeps) {
    const r = Game.powerCreeps[o];
    if (r && r.ticksToLive && r.room && r.room.name === e) return true;
  }
  return false;
}

function hasPowerCreepAssigned(e) {
  if (hasPowerCreepInRoom(e)) return true;
  if (!Memory.operators) return false;
  for (const o in Memory.operators) {
    const r = Memory.operators[o];
    const t = Game.powerCreeps[o];
    if (r && r.homeRoom === e && t && t.ticksToLive) return true;
  }
  return false;
}

function isMineralExtractionActive(e) {
  const o = getRoomActivityRooms();
  if (!o[e]) return false;
  const r = Game.rooms[e];
  if (!r) return false;
  const t = getRoomState.get(e);
  if (!t || !t.minerals || t.minerals.length === 0) return false;
  let n = false;
  for (let e = 0; e < t.minerals.length; e++) {
    if (t.minerals[e] && t.minerals[e].mineralAmount > 0) {
      n = true;
      break;
    }
  }
  if (!n) return false;
  const s = t.structuresByType && t.structuresByType[STRUCTURE_EXTRACTOR] || [];
  for (let e = 0; e < s.length; e++) {
    if (s[e] && s[e].my) return true;
  }
  return false;
}

function getRepairHardBlockReason(e) {
  const o = require("repairManager");
  if (o && o.isMaxHeal && o.isMaxHeal(e)) return "maxHeal";
  const r = Memory.repairManager && Memory.repairManager.rooms && Memory.repairManager.rooms[e];
  if (!r) return null;
  if (r.maxRepair) return "maxRepair";
  if (r.maxRepairUntil && Game.time < r.maxRepairUntil) return "maxRepair";
  return null;
}

function hasActivePowerUpgrade(e) {
  const o = Memory.powerUpgrade;
  if (!o || !(o.targetLevel > Game.gpl.level)) return false;
  if (Array.isArray(o.rooms) && o.rooms.indexOf(e) >= 0) return true;
  const r = Game.rooms[e];
  if (!r || !r.storage || !r.terminal) return false;
  const t = getRoomState.get(e);
  const n = t && t.structuresByType && t.structuresByType[STRUCTURE_POWER_SPAWN] || [];
  for (let e = 0; e < n.length; e++) {
    if (n[e] && n[e].my) return true;
  }
  return false;
}

function getHardBlockReason(e) {
  if (!Game.rooms[e]) return "notVisible";
  if (hasActivePowerUpgrade(e)) return "powerUpgrade";
  const o = getRepairHardBlockReason(e);
  if (o) return o;
  if (hasHostilesNow(e)) return "hostiles";
  if (hasPowerCreepAssigned(e)) return "powerCreep";
  if (hasDepositHarvester(e)) return "depositHarvester";
  if (hasMilitaryOperation(e)) return "militaryOperation";
  if (hasAnyLabOrder(e)) return "labOrder";
  return null;
}

function getRampartThresholds(e) {
  const o = Game.rooms[e];
  const r = o && o.controller && o.controller.level || 0;
  const t = r <= 2 ? RAMPART_RESUME_HITS_RCL2 : RAMPART_RESUME_HITS_RCL3;
  const n = r <= 2 ? RAMPART_ENTRY_HITS_RCL2 : RAMPART_ENTRY_HITS_RCL3;
  let s = 0;
  if (typeof RAMPART_HITS_MAX !== "undefined" && RAMPART_HITS_MAX[r]) s = RAMPART_HITS_MAX[r];
  return {
    resumeHits: s > 0 ? Math.min(t, s) : t,
    entryHits: s > 0 ? Math.min(n, s) : n
  };
}

function getBreachStateForRoom(e, o) {
  const r = Game.rooms[e];
  if (!r || !o) return {
    breached: false,
    unavailable: true
  };
  try {
    const t = require("repairManager");
    if (!t || typeof t.getBreachState !== "function") return {
      breached: false,
      unavailable: true
    };
    return t.getBreachState(e, o, r.controller && r.controller.level || 0) || {
      breached: false,
      unavailable: true
    };
  } catch (t) {
    return {
      breached: false,
      unavailable: true
    };
  }
}

function computeVitals(e) {
  const o = {
    tick: Game.time,
    towerMinPct: null,
    roadMinPct: null,
    containerMinPct: null,
    containerMinHits: null,
    rampartMinHits: null,
    towerCount: 0,
    roadCount: 0,
    containerCount: 0,
    rampartCount: 0,
    hasTowers: false,
    breachState: null
  };
  const r = Game.rooms[e];
  if (!r) return o;
  const t = getRoomState.get(e);
  if (!t || !t.structuresByType) {
    o.breachState = getBreachStateForRoom(e, t);
    return o;
  }

  const n = t.structuresByType[STRUCTURE_TOWER] || [];
  let s = null;
  for (let e = 0; e < n.length; e++) {
    const r = n[e];
    if (!r || r.my === false) continue;
    o.hasTowers = true;
    o.towerCount++;
    if (!r.hitsMax || typeof r.hits !== "number") continue;
    const t = r.hits / r.hitsMax;
    if (s === null || t < s) s = t;
  }
  o.towerMinPct = s;

  const a = t.structuresByType[STRUCTURE_ROAD] || [];
  o.roadCount = a.length;
  let i = null;
  for (let e = 0; e < a.length; e++) {
    const r = a[e];
    if (!r || !r.hitsMax || typeof r.hits !== "number") continue;
    const t = r.hits / r.hitsMax;
    if (i === null || t < i) i = t;
  }
  o.roadMinPct = i;

  const m = t.structuresByType[STRUCTURE_CONTAINER] || [];
  o.containerCount = m.length;
  let c = null;
  let p = null;
  for (let e = 0; e < m.length; e++) {
    const r = m[e];
    if (!r || typeof r.hits !== "number") continue;
    if (c === null || r.hits < c) c = r.hits;
    if (r.hitsMax > 0) {
      const t = r.hits / r.hitsMax;
      if (p === null || t < p) p = t;
    }
  }
  o.containerMinHits = c;
  o.containerMinPct = p;

  const u = t.structuresByType[STRUCTURE_RAMPART] || [];
  let l = null;
  for (let e = 0; e < u.length; e++) {
    const r = u[e];
    if (!r || r.my === false) continue;
    o.rampartCount++;
    if (typeof r.hits !== "number") continue;
    if (l === null || r.hits < l) l = r.hits;
  }
  o.rampartMinHits = l;
  o.breachState = getBreachStateForRoom(e, t);
  return o;
}

function getVitals(e) {
  const o = getVitalsCache();
  const r = o[e];
  if (r && Game.time - r.tick < VITALS_TTL) {
    return r;
  }
  const t = computeVitals(e);
  o[e] = t;
  return t;
}

function getBreachSafetyReason(e) {
  const o = e && e.breachState;
  if (!o) return "breachUnknown";
  if (o.unavailable || o.truncated) return "breachUnknown";
  if (o.breached) return "breach";
  return null;
}

function hasContainerDamage(o, r) {
  if (!o.containerCount) return false;
  if (o.containerMinPct === null || o.containerMinHits === null) return true;
  if (r) return o.containerMinPct < CONTAINER_RESUME_PCT || o.containerMinHits < CONTAINER_RESUME_HITS;
  return o.containerMinPct < CONTAINER_ENTRY_PCT || o.containerMinHits < CONTAINER_ENTRY_HITS;
}

function hasRoadDamage(o, r) {
  if (!o.roadCount) return false;
  if (o.roadMinPct === null) return true;
  return o.roadMinPct < (r ? ROAD_RESUME_PCT : ROAD_ENTRY_PCT);
}

function hasRampartDamage(e, o, r) {
  if (!o.rampartCount) return false;
  if (o.rampartMinHits === null) return true;
  const t = getRampartThresholds(e);
  return o.rampartMinHits < (r ? t.resumeHits : t.entryHits);
}

function getIneligibilityReason(e) {
  if (!Game.rooms[e]) return "notVisible";
  const o = getHardBlockReason(e);
  if (o) return o;
  if (hasEconomyCreepGap(e)) return "economyCreepGap";
  const r = getVitals(e);
  if (!r.hasTowers) return "noTowers";
  if (r.towerMinPct === null || r.towerMinPct < MIN_STRUCTURE_HEALTH) return "towerDamage";
  const t = isSuspended(e);
  const n = getBreachSafetyReason(r);
  if (n) return n;
  if (hasRampartDamage(e, r, t)) return "rampartDamage";
  if (hasContainerDamage(r, t)) return "containerDamage";
  if (hasRoadDamage(r, t)) return "roadDamage";
  return null;
}

function isEligibleForSuspension(e) {
  return !getIneligibilityReason(e);
}

function isRcl8(e) {
  const o = Game.rooms[e];
  return !!(o && o.controller && o.controller.level >= 8);
}

function hasConstructionSites(e) {
  const o = getRoomState.get(e);
  return !!(o && o.constructionSites && o.constructionSites.length > 0);
}

function getSuspensionPriority(e) {
  let o = 0;
  const r = isMineralExtractionActive(e);
  const t = hasHardActiveJob(e);
  const n = hasFactoryOrder(e);
  const s = hasLabOrder(e);
  const i = n || s;
  const a = !isRcl8(e);
  const m = hasConstructionSites(e);
  if (r) o += MINERAL_EXTRACTION_PENALTY;
  if (t) o += ACTIVE_JOB_PENALTY;
  if (n) o += SOFT_FACTORY_PENALTY;
  if (s) o += SOFT_LAB_PENALTY;
  if (a) o += NON_RCL8_PENALTY;
  if (a && i) o += NON_RCL8_ORDER_PENALTY;
  if (m) o += CONSTRUCTION_PENALTY;
  const c = getVitals(e);
  if (c.towerMinPct !== null) o += Math.round(Math.max(0, 1 - c.towerMinPct) * TOWER_DEGRADATION_PENALTY);
  if (c.containerMinPct !== null) o += Math.round(Math.max(0, 1 - c.containerMinPct) * CONTAINER_DEGRADATION_PENALTY);
  if (c.roadMinPct !== null) o += Math.round(Math.max(0, 1 - c.roadMinPct) * ROAD_DEGRADATION_PENALTY);
  if (c.rampartMinHits !== null) {
    const t = getRampartThresholds(e).entryHits;
    const n = Math.max(0, Math.min(1, (t * 2 - c.rampartMinHits) / t));
    o += Math.round(n * RAMPART_DEGRADATION_PENALTY);
  }
  return o;
}

function getCpuAverage() {
  const e = heap.cpuStats;
  if (e && typeof e.average === "number") return e.average;
  if (e && e.history && e.history.length > 0) {
    let o = 0;
    for (let r = 0; r < e.history.length; r++) o += e.history[r];
    return o / e.history.length;
  }
  return Game.cpu.getUsed();
}

function isUnderCpuPressure() {
  if (Game.cpu.bucket >= RESUME_BUCKET) return false;
  if (Game.cpu.bucket < SUSPEND_BUCKET) return true;
  const e = Game.cpu.limit;
  return getCpuAverage() >= e * CPU_PRESSURE_RATIO;
}

function buildSuspendCandidates(e) {
  const o = [];
  for (let r = 0; r < e.length; r++) {
    const t = e[r];
    if (isSuspended(t)) continue;
    if (!isEligibleForSuspension(t)) continue;
    o.push({
      roomName: t,
      score: getSuspensionPriority(t),
      mineralExtraction: isMineralExtractionActive(t),
      activeJob: hasHardActiveJob(t),
      factory: hasFactoryOrder(t),
      lab: hasLabOrder(t),
      nonRcl8: !isRcl8(t),
      construction: hasConstructionSites(t)
    });
  }
  o.sort(function(e, o) {
    if (e.score !== o.score) return e.score - o.score;
    return e.roomName < o.roomName ? -1 : e.roomName > o.roomName ? 1 : 0;
  });
  return o;
}

function canSuspendAnotherRoom() {
  const e = Memory.roomSuspenderControl;
  if (!e.lastActionTick) return true;
  if (Game.time - e.lastActionTick < ADAPT_SAMPLE_TICKS) return false;
  return isUnderCpuPressure();
}

function suspend(e, o) {
  Memory.suspendedRooms[e] = {
    at: Game.time,
    reason: o || "bucket",
    priority: getSuspensionPriority(e),
    cpuBefore: getCpuAverage(),
    bucketBefore: Game.cpu.bucket
  };
  Memory.roomSuspenderControl.lastActionTick = Game.time;
  Memory.roomSuspenderControl.lastRoom = e;
  Memory.roomSuspenderControl.sampleUntil = Game.time + ADAPT_SAMPLE_TICKS;
  Memory.roomSuspenderControl.cpuBefore = getCpuAverage();
  Memory.roomSuspenderControl.bucketBefore = Game.cpu.bucket;
  console.log("[RoomSuspender] SUSPEND " + e + " reason=" + (o || "bucket") + " bucket=" + Game.cpu.bucket + " cpuAvg=" + getCpuAverage().toFixed(2));
  memoryManager.requestSave();
}

function unsuspend(e) {
  if (Memory.suspendedRooms[e]) {
    console.log("[RoomSuspender] RESUME " + e + " after " + (Game.time - (Memory.suspendedRooms[e].at || Game.time)) + " ticks (bucket=" + Game.cpu.bucket + ")");
    delete Memory.suspendedRooms[e];
    memoryManager.requestSave();
  }
}

function isSuspended(e) {
  return !!(Memory.suspendedRooms && Memory.suspendedRooms[e]);
}

function shouldIdleCreep(e) {
  const o = e.room ? e.room.name : null;
  if (!o || !isSuspended(o)) return false;
  if (e.memory.role === "harvester") {
    const e = Game.rooms[o];
    if (e) {
      var r = Math.min(HARVESTER_ENERGY_FLOOR, e.energyCapacityAvailable || 0);
      if (e.energyAvailable >= r) {
        return false;
      }
    }
  }
  return true;
}

function canRunSuspendedHarvester(e) {
  if (!e || e.memory.role !== "harvester") return false;
  const o = e.room ? e.room.name : null;
  if (!o || !isSuspended(o)) return false;
  const r = Game.rooms[o];
  if (!r) return false;
  var t = Math.min(HARVESTER_ENERGY_FLOOR, r.energyCapacityAvailable || 0);
  return r.energyAvailable >= t;
}

function getSuspendedRooms() {
  if (!Memory.suspendedRooms) return [];
  return Object.keys(Memory.suspendedRooms);
}

function formatPct(e) {
  return typeof e === "number" ? (e * 100).toFixed(1) + "%" : "-";
}

function formatHits(e) {
  if (typeof e !== "number") return "-";
  if (e >= 1e6) return (e / 1e6).toFixed(1) + "M";
  if (e >= 1e3) return Math.round(e / 1e3) + "k";
  return String(Math.round(e));
}

function formatBreach(e) {
  const o = e && e.breachState;
  if (!o || o.unavailable) return "unknown";
  if (o.truncated) return "unknown(truncated)";
  if (o.breached) {
    const r = o.x === undefined ? "" : "@" + o.x + "," + o.y;
    return "true" + r;
  }
  return o.skipped ? "false(" + o.skipped + ")" : "false";
}

function formatVitals(e) {
  const o = getVitals(e);
  return "tower=" + formatPct(o.towerMinPct) + " container=" + formatPct(o.containerMinPct) + "/" + formatHits(o.containerMinHits) + " rampart=" + formatHits(o.rampartMinHits) + " road=" + formatPct(o.roadMinPct) + " breach=" + formatBreach(o);
}

function run() {
  ensureMemory();
  const e = getOwnedRooms();
  const o = {};
  for (let r = 0; r < e.length; r++) o[e[r]] = true;
  if (pruneOldRooms(o)) memoryManager.requestSave();
  const r = Memory.roomSuspenderControl;
  const t = getSampleCache();
  if (r.sampleUntil && Game.time >= r.sampleUntil && t.sampleRecordedTick !== r.sampleUntil) {
    t.sampleRecordedTick = r.sampleUntil;
    t.cpuAfter = getCpuAverage();
    t.bucketAfter = Game.cpu.bucket;
  }
  for (const e in Memory.suspendedRooms) {
    if (!o[e]) {
      unsuspend(e);
      continue;
    }
    if (!Game.rooms[e]) {
      unsuspend(e);
      continue;
    }
    if (hasActivePowerUpgrade(e)) {
      unsuspend(e);
      continue;
    }
    if (Game.cpu.bucket >= RESUME_BUCKET) {
      unsuspend(e);
      continue;
    }
    if (hasHostilesNow(e)) {
      unsuspend(e);
      continue;
    }
    if (!isEligibleForSuspension(e)) {
      unsuspend(e);
      continue;
    }
  }
  if (isUnderCpuPressure() && canSuspendAnotherRoom()) {
    const o = buildSuspendCandidates(e);
    if (o.length > 0) {
      const e = o[0];
      const r = "pressure:p" + e.score + (e.mineralExtraction ? ":mineralExtraction" : "") + (e.activeJob ? ":activeJob" : "") + (e.factory ? ":factory" : "") + (e.lab ? ":lab" : "") + (e.nonRcl8 ? ":nonRcl8" : "") + (e.construction ? ":construction" : "");
      suspend(e.roomName, r);
    }
  }
}

function status() {
  ensureMemory();
  const e = getSuspendedRooms();
  const o = Memory.roomSuspenderControl || {};
  const r = getSampleCache();
  const t = [ "[RoomSuspender] Bucket=" + Game.cpu.bucket + " CPUavg=" + getCpuAverage().toFixed(2) + " suspended=" + (e.length ? e.join(",") : "none") ];
  t.push("  control: lastRoom=" + (o.lastRoom || "-") + " sampleUntil=" + (o.sampleUntil || "-") + " cpu " + (o.cpuBefore !== undefined ? o.cpuBefore.toFixed(2) : "?") + " -> " + (r.cpuAfter !== undefined ? r.cpuAfter.toFixed(2) : "?") + " bucket " + (o.bucketBefore !== undefined ? o.bucketBefore : "?") + " -> " + (r.bucketAfter !== undefined ? r.bucketAfter : "?"));
  for (const o of e) {
    const r = Memory.suspendedRooms[o];
    t.push("  " + o + ": reason=" + (r ? r.reason : "?") + " priority=" + (r && r.priority !== undefined ? r.priority : getSuspensionPriority(o)) + " " + formatVitals(o) + " hardBlock=" + (getHardBlockReason(o) || "-") + " factory=" + hasFactoryOrder(o) + " lab=" + hasLabOrder(o) + " host=" + hasHostilesNow(o));
  }
  const s = getOwnedRooms();
  const i = buildSuspendCandidates(s);
  if (i.length > 0) {
    const e = i.slice(0, 5).map(function(e) {
      return e.roomName + "(p" + e.score + (e.mineralExtraction ? ",mineralExtraction" : "") + (e.activeJob ? ",activeJob" : "") + (e.factory ? ",factory" : "") + (e.lab ? ",lab" : "") + (e.nonRcl8 ? ",nonRcl8" : "") + (e.construction ? ",construction" : "") + " " + formatVitals(e.roomName) + ")";
    });
    t.push("  next candidates: " + e.join(" "));
  } else {
    t.push("  next candidates: none");
  }
  const a = [];
  const c = [];
  for (let e = 0; e < s.length; e++) {
    const o = s[e];
    if (isSuspended(o)) continue;
    const r = getHardBlockReason(o);
    if (r) a.push(o + "(" + r + " " + formatVitals(o) + ")");
    const t = getIneligibilityReason(o);
    if (t && t !== r) c.push(o + "(" + t + " " + formatVitals(o) + ")");
  }
  t.push("  hard-blocked: " + (a.length ? a.join(" ") : "none"));
  t.push("  safety-excluded: " + (c.length ? c.join(" ") : "none"));
  return t.join("\n");
}

function suspensionPlan() {
  ensureMemory();
  const e = getOwnedRooms();
  const o = Memory.roomSuspenderControl || {};
  const r = isUnderCpuPressure();
  const t = o.lastActionTick ? Math.max(0, ADAPT_SAMPLE_TICKS - (Game.time - o.lastActionTick)) : 0;
  const n = [ "[RoomSuspender plan] tick=" + Game.time + " bucket=" + Game.cpu.bucket + " cpuAvg=" + getCpuAverage().toFixed(2) + " pressure=" + r + " cooldown=" + t ];
  const s = getSuspendedRooms().sort(function(e, o) {
    return Memory.suspendedRooms[e].at - Memory.suspendedRooms[o].at || (e < o ? -1 : e > o ? 1 : 0);
  });
  n.push("  disabled now (" + s.length + "):");
  if (s.length === 0) {
    n.push("    none");
  } else {
    for (let e = 0; e < s.length; e++) {
      const o = s[e];
      const r = Memory.suspendedRooms[o];
      n.push("    " + (e + 1) + ". " + o + " since=" + r.at + " reason=" + r.reason + " " + formatVitals(o));
    }
  }
  const i = buildSuspendCandidates(e);
  n.push("  suspension order if pressure continues (" + i.length + "):");
  if (i.length === 0) {
    n.push("    none");
  } else {
    for (let e = 0; e < i.length; e++) {
      const o = i[e];
      n.push("    " + (e + 1) + ". " + o.roomName + " priority=" + o.score + (o.mineralExtraction ? " mineralExtraction" : "") + (o.activeJob ? " activeJob" : "") + (o.factory ? " factory" : "") + (o.lab ? " lab" : "") + (o.nonRcl8 ? " nonRcl8" : "") + (o.construction ? " construction" : "") + " " + formatVitals(o.roomName));
    }
  }
  const a = [];
  for (let o = 0; o < e.length; o++) {
    const r = e[o];
    if (isSuspended(r)) continue;
    const t = getIneligibilityReason(r);
    if (t) a.push({
      roomName: r,
      reason: t
    });
  }
  a.sort(function(e, o) {
    return e.roomName < o.roomName ? -1 : e.roomName > o.roomName ? 1 : 0;
  });
  n.push("  hard-excluded now, until their condition changes (" + a.length + "):");
  if (a.length === 0) {
    n.push("    none");
  } else {
    for (let e = 0; e < a.length; e++) {
      n.push("    " + a[e].roomName + ": " + a[e].reason + " " + formatVitals(a[e].roomName));
    }
  }
  n.push("  note: mineral extraction, active jobs, and non-RCL 8 rooms are ranked after idle rooms, not excluded.");
  return n.join("\n");
}

global.roomSuspendStatus = status;
global.roomSuspendPlan = suspensionPlan;
global.getSuspendedRooms = getSuspendedRooms;
global.forceSuspendRoom = function(e) {
  ensureMemory();
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "Not an owned room: " + e;
  }
  const o = getHardBlockReason(e);
  if (o) return "Refusing to suspend " + e + ": hard-blocked by " + o;
  const r = getBreachSafetyReason(getVitals(e));
  if (r === "breach") return "Refusing to suspend " + e + ": hard-blocked by breach";
  suspend(e, "manual");
  return "Suspended: " + e;
};
global.forceResumeRoom = function(e) {
  ensureMemory();
  unsuspend(e);
  return "Resumed: " + e;
};
module.exports = {
  run: run,
  isSuspended: isSuspended,
  shouldIdleCreep: shouldIdleCreep,
  canRunSuspendedHarvester: canRunSuspendedHarvester,
  getSuspendedRooms: getSuspendedRooms,
  getHardBlockReason: getHardBlockReason,
  getIneligibilityReason: getIneligibilityReason,
  getVitals: getVitals,
  getSuspensionPriority: getSuspensionPriority,
  suspensionPlan: suspensionPlan,
  shouldAvoidRoomWork: function(e) {
    return isSuspended(e);
  }
};
