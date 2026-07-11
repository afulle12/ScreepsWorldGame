// LLM: Read llmcontext.js before reviewing or changing this file.
// roomSuspender.js
// =================================================================
// Per-room CPU suspension. When bucket is low, temporarily suspend
// "low-risk" owned rooms by stopping their towers and idling their
// home-room creeps. State and global systems (getRoomState, defense,
// scans, market) keep running so we can detect when to resume.
//
// SUSPENSION SCOPE
//   - Towers in suspended rooms do nothing.
//   - Home-room creeps idle.
//   - Exception: role 'harvester' continues running while
//     room.energyAvailable >= HARVESTER_ENERGY_FLOOR.
//
// RESUME TRIGGERS (immediate, every tick for suspended rooms)
//   - Hostile creeps visible in room (same-tick tower fire).
//   - Bucket recovered above RESUME_BUCKET.
//   - Eligibility lost: tower/road health dropped, hard-blocking
//     room activity appeared, deposit harvester present, or power creep present.
//
// ELIGIBILITY FOR SUSPENSION (must all be true)
//   - Owned, visible room.
//   - No hostiles.
//   - No hard-blocking activity touching the room (military operations,
//     power creeps, deposits, or critical repairs).
//   - All towers >= 50% hits (rooms with zero towers are NOT eligible).
//   - Sampled roads >= 50% hits (capped sample for CPU).
//   - No deposit harvester in or assigned to the room.
//   - No power creep in the room.
//   - Bucket below SUSPEND_BUCKET.
//   - Suspension order: idle rooms, mineral extraction rooms, then active-job
//     rooms. Factory/lab orders are soft priority within those tiers.
//
// Public API
//   run()                          - call once per tick, before towers
//   isSuspended(roomName)          - true if room is currently suspended
//   shouldIdleCreep(creep)         - true if this creep should be skipped
//   getSuspendedRooms()            - array of suspended room names
//
// Console helpers
//   roomSuspendStatus()            - one-shot status string
//   roomSuspendPlan()              - full current suspension queue and exclusions
//   forceSuspendRoom(roomName)     - manual suspend
//   forceResumeRoom(roomName)      - manual resume
// =================================================================

'use strict';

const getRoomState = require('getRoomState');

const SUSPEND_BUCKET         = 2800;
const RESUME_BUCKET          = 3500;
const MIN_STRUCTURE_HEALTH   = 0.50;
const HARVESTER_ENERGY_FLOOR = 3000;
const VITALS_TTL             = 25;
const ROAD_SAMPLE_CAP        = 100;
const ADAPT_SAMPLE_TICKS     = 25;
const CPU_PRESSURE_RATIO     = 0.90;
const MINERAL_EXTRACTION_PENALTY = 100;
const ACTIVE_JOB_PENALTY     = 200;
const SOFT_FACTORY_PENALTY   = 20;
const SOFT_LAB_PENALTY       = 20;

const MILITARY_ROLES = {
  attacker: true,
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

// -----------------------------------------------------------------
// Memory
// -----------------------------------------------------------------

function ensureMemory() {
  if (!Memory.suspendedRooms)     Memory.suspendedRooms     = {};
  if (!Memory.roomSuspenderVitals) Memory.roomSuspenderVitals = {};
  if (!Memory.roomSuspenderControl) Memory.roomSuspenderControl = {};
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

function getOwnedRooms() {
  return getRoomState.ownedNames().slice();
}

function pruneOldRooms(ownedSet) {
  for (const rn in Memory.suspendedRooms) {
    if (!ownedSet[rn]) delete Memory.suspendedRooms[rn];
  }
  for (const rn in Memory.roomSuspenderVitals) {
    if (!ownedSet[rn]) delete Memory.roomSuspenderVitals[rn];
  }
}

function hasHostilesNow(roomName) {
  const rs = getRoomState.get(roomName);
  return !!(rs && rs.hostiles && rs.hostiles.length > 0);
}

function markRoomFlag(roomName, flag) {
  if (!roomName) return;
  if (!roomActivityFlags[roomName]) roomActivityFlags[roomName] = {};
  roomActivityFlags[roomName][flag] = true;
}

function markCreepRooms(creep, flag) {
  if (!creep || !creep.memory) return;
  if (creep.room) markRoomFlag(creep.room.name, flag);
  markRoomFlag(creep.memory.homeRoom, flag);
  markRoomFlag(creep.memory.assignedRoom, flag);
  markRoomFlag(creep.memory.targetRoom, flag);
}

function markMilitaryCreepRoom(creep) {
  const memory = creep.memory;
  const homeRoom = memory.homeRoom || memory.spawnRoom || memory.rallyRoom ||
    memory.assignedRoom || memory.orderRoom;

  // Claimbots have no recorded origin, so only protect a room while one is in it.
  markRoomFlag(homeRoom || (creep.room && creep.room.name), 'militaryOperation');
}

function isOperationalMilitaryOrder(order) {
  return order && !order.dryRun && order.status !== 'failed' &&
    order.status !== 'dryrun_complete';
}

function buildRoomActivityFlags() {
  if (roomActivityFlagsTick === Game.time) return roomActivityFlags;
  roomActivityFlagsTick = Game.time;
  roomActivityFlags = {};

  const idx = getRoomState.creepIndex();
  const creeps = idx && idx.all ? idx.all : [];
  for (let i = 0; i < creeps.length; i++) {
    const creep = creeps[i];
    if (!creep || !creep.memory) continue;
    const role = creep.memory.role;
    if (role === 'extractor' || role === 'extractorAssistant' || role === 'comboBot') {
      markCreepRooms(creep, 'mineralActivity');
    } else if (role === 'depositHarvester') {
      markCreepRooms(creep, 'depositHarvester');
    }
    if (MILITARY_ROLES[role]) markMilitaryCreepRoom(creep);
  }

  if (Memory.depositObserver && Memory.depositObserver.jobs) {
    const jobs = Memory.depositObserver.jobs;
    for (const id in jobs) {
      const job = jobs[id];
      if (!job || job.completed) continue;
      markRoomFlag(job.homeRoom, 'depositHarvester');
      markRoomFlag(job.roomName, 'depositHarvester');
    }
  }

  if (Memory.marketLabReverse && Memory.marketLabReverse.rooms) {
    for (const roomName in Memory.marketLabReverse.rooms) {
      const q = Memory.marketLabReverse.rooms[roomName];
      if (!q) continue;
      for (let i = 0; i < q.length; i++) {
        if (q[i] && q[i].state !== 'SELLING') {
          markRoomFlag(roomName, 'lab');
          break;
        }
      }
    }
  }
  if (Memory.marketLabForward && Memory.marketLabForward.rooms) {
    for (const roomName in Memory.marketLabForward.rooms) {
      const q = Memory.marketLabForward.rooms[roomName];
      if (!q) continue;
      for (let i = 0; i < q.length; i++) {
        if (q[i] && q[i].state !== 'SELLING') {
          markRoomFlag(roomName, 'lab');
          break;
        }
      }
    }
  }

  if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
    for (let i = 0; i < Memory.factoryOrders.length; i++) {
      const order = Memory.factoryOrders[i];
      if (!order || !order.room) continue;
      if (order.status === 'done' || order.status === 'cancelled') continue;
      markRoomFlag(order.room, 'factory');
    }
  }

  // Military orders keep their origin room awake for spawning, boosts, rallying,
  // and replacement units. Target, route, and observer rooms are intentionally
  // not marked here.
  if (Memory.attackOrders) {
    for (const key in Memory.attackOrders) {
      const order = Memory.attackOrders[key];
      if (order) markRoomFlag(order.spawnRoom, 'militaryOperation');
    }
  }
  if (Memory.towerDrainOps && Memory.towerDrainOps.operations) {
    const operations = Memory.towerDrainOps.operations;
    for (const key in operations) {
      const operation = operations[key];
      if (isOperationalMilitaryOrder(operation)) {
        markRoomFlag(operation.homeRoom, 'militaryOperation');
      }
    }
  }
  if (Memory.demolitionOrders) {
    for (const key in Memory.demolitionOrders) {
      const order = Memory.demolitionOrders[key];
      if (order) markRoomFlag(order.homeRoom, 'militaryOperation');
    }
  }
  if (Memory.contestedDemolisherOrders) {
    for (const key in Memory.contestedDemolisherOrders) {
      const order = Memory.contestedDemolisherOrders[key];
      if (isOperationalMilitaryOrder(order)) {
        markRoomFlag(order.homeRoom, 'militaryOperation');
      }
    }
  }
  if (Memory.squadOrders) {
    for (const key in Memory.squadOrders) {
      const order = Memory.squadOrders[key];
      if (order) markRoomFlag(order.homeRoom, 'militaryOperation');
    }
  }
  if (Memory.controllerAttackOrders) {
    for (const key in Memory.controllerAttackOrders) {
      const order = Memory.controllerAttackOrders[key];
      if (order) markRoomFlag(order.homeRoom, 'militaryOperation');
    }
  }
  if (Memory.skAttackOrders) {
    for (const key in Memory.skAttackOrders) {
      const order = Memory.skAttackOrders[key];
      if (order && order.active !== false) {
        markRoomFlag(order.spawnRoom, 'militaryOperation');
      }
    }
  }
  if (Memory.thiefOrders) {
    for (const key in Memory.thiefOrders) {
      const order = Memory.thiefOrders[key];
      if (order) markRoomFlag(order.homeRoom, 'militaryOperation');
    }
  }

  if (Memory.marketRefine && Memory.marketRefine.ops) {
    for (let i = 0; i < Memory.marketRefine.ops.length; i++) {
      if (Memory.marketRefine.ops[i] && Memory.marketRefine.ops[i].room) {
        markRoomFlag(Memory.marketRefine.ops[i].room, 'activeJob');
      }
    }
  }
  if (Memory.localRefine && Memory.localRefine.ops) {
    for (let i = 0; i < Memory.localRefine.ops.length; i++) {
      if (Memory.localRefine.ops[i] && Memory.localRefine.ops[i].room) {
        markRoomFlag(Memory.localRefine.ops[i].room, 'activeJob');
      }
    }
  }
  if (Memory.marketArbitrage) {
    const ma = Memory.marketArbitrage;
    if (ma.operations) {
      for (const roomName in ma.operations) {
        if (ma.operations[roomName]) markRoomFlag(roomName, 'activeJob');
      }
    }
    if (ma.selfArbPending) {
      for (const roomName in ma.selfArbPending) {
        if (ma.selfArbPending[roomName]) markRoomFlag(roomName, 'activeJob');
      }
    }
    if (ma.buffered && Array.isArray(ma.buffered)) {
      for (let i = 0; i < ma.buffered.length; i++) {
        if (ma.buffered[i] && ma.buffered[i].roomName) markRoomFlag(ma.buffered[i].roomName, 'activeJob');
      }
    }
    if (ma.groups) {
      for (const key in ma.groups) {
        const g = ma.groups[key];
        if (!g || !g.members) continue;
        if (g.createdTick && Game.time - g.createdTick > 1000) continue;
        if (Array.isArray(g.members)) {
          for (let i = 0; i < g.members.length; i++) {
            if (typeof g.members[i] === 'string') markRoomFlag(g.members[i], 'activeJob');
            else if (g.members[i] && g.members[i].roomName) markRoomFlag(g.members[i].roomName, 'activeJob');
          }
        } else {
          for (const roomName in g.members) {
            if (g.members[roomName]) markRoomFlag(roomName, 'activeJob');
          }
        }
      }
    }
  }

  return roomActivityFlags;
}

function hasFlag(roomName, flag) {
  const flags = buildRoomActivityFlags();
  return !!(flags[roomName] && flags[roomName][flag]);
}

function hasLabOrder(roomName) {
  return hasFlag(roomName, 'lab');
}

function hasFactoryOrder(roomName) {
  return hasFlag(roomName, 'factory');
}

function hasHardActiveJob(roomName) {
  return hasFlag(roomName, 'activeJob');
}

function hasMilitaryOperation(roomName) {
  return hasFlag(roomName, 'militaryOperation');
}

function getRoomActivityRooms() {
  if (roomActivityRoomsTick === Game.time) return roomActivityRooms;
  roomActivityRoomsTick = Game.time;
  roomActivityRooms = {};
  const flags = buildRoomActivityFlags();
  for (const roomName in flags) {
    if (flags[roomName].mineralActivity) roomActivityRooms[roomName] = true;
  }
  return roomActivityRooms;
}

function hasDepositHarvester(roomName) {
  if (depositHarvesterRoomsTick !== Game.time) {
    depositHarvesterRoomsTick = Game.time;
    depositHarvesterRooms = {};
    const flags = buildRoomActivityFlags();
    for (const rn in flags) {
      if (flags[rn].depositHarvester) depositHarvesterRooms[rn] = true;
    }
  }
  return !!depositHarvesterRooms[roomName];
}

function hasPowerCreepInRoom(roomName) {
  const rs = getRoomState.get(roomName);
  if (rs && rs.myPowerCreeps && rs.myPowerCreeps.length > 0) return true;
  for (const name in Game.powerCreeps) {
    const pc = Game.powerCreeps[name];
    if (pc && pc.ticksToLive && pc.room && pc.room.name === roomName) return true;
  }
  return false;
}

function hasPowerCreepAssigned(roomName) {
  if (hasPowerCreepInRoom(roomName)) return true;
  if (!Memory.operators) return false;
  for (const name in Memory.operators) {
    const cfg = Memory.operators[name];
    const pc = Game.powerCreeps[name];
    if (cfg && cfg.homeRoom === roomName && pc && pc.ticksToLive) return true;
  }
  return false;
}

function isMineralExtractionActive(roomName) {
  const activeRooms = getRoomActivityRooms();
  if (!activeRooms[roomName]) return false;

  const room = Game.rooms[roomName];
  if (!room) return false;
  const rs = getRoomState.get(roomName);
  if (!rs || !rs.minerals || rs.minerals.length === 0) return false;

  let hasLiveMineral = false;
  for (let i = 0; i < rs.minerals.length; i++) {
    if (rs.minerals[i] && rs.minerals[i].mineralAmount > 0) {
      hasLiveMineral = true;
      break;
    }
  }
  if (!hasLiveMineral) return false;

  const extractors = (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTRACTOR]) || [];
  for (let j = 0; j < extractors.length; j++) {
    if (extractors[j] && extractors[j].my) return true;
  }
  return false;
}

function getRepairHardBlockReason(roomName) {
  const repairManager = require('repairManager');
  if (repairManager && repairManager.isMaxHeal && repairManager.isMaxHeal(roomName)) return 'maxHeal';

  const rm = Memory.repairManager && Memory.repairManager.rooms && Memory.repairManager.rooms[roomName];
  if (!rm) return null;
  if (rm.maxRepair) return 'maxRepair';
  if (rm.maxRepairUntil && Game.time < rm.maxRepairUntil) return 'maxRepair';
  return null;
}

function getHardBlockReason(roomName) {
  if (!Game.rooms[roomName]) return 'notVisible';
  const repairReason = getRepairHardBlockReason(roomName);
  if (repairReason) return repairReason;
  if (hasHostilesNow(roomName)) return 'hostiles';
  if (hasPowerCreepAssigned(roomName)) return 'powerCreep';
  if (hasDepositHarvester(roomName)) return 'depositHarvester';
  if (hasMilitaryOperation(roomName)) return 'militaryOperation';
  return null;
}

function computeVitals(roomName) {
  const vitals = {
    tick:        Game.time,
    towerMinPct: 1,
    roadMinPct:  1,
    towerCount:  0,
    hasTowers:   false
  };

  const room = Game.rooms[roomName];
  if (!room) return vitals;

  const rs = getRoomState.get(roomName);
  if (rs && rs.structuresByType) {
    const towers = rs.structuresByType[STRUCTURE_TOWER] || [];
    if (towers.length > 0) {
      vitals.hasTowers  = true;
      vitals.towerCount = towers.length;
      let minPct = 1;
      for (let i = 0; i < towers.length; i++) {
        const t = towers[i];
        if (!t || !t.hitsMax) continue;
        const pct = t.hits / t.hitsMax;
        if (pct < minPct) minPct = pct;
      }
      vitals.towerMinPct = minPct;
    }

    const roads = rs.structuresByType[STRUCTURE_ROAD] || [];
    if (roads.length > 0) {
      let minPct = 1;
      const cap = Math.min(roads.length, ROAD_SAMPLE_CAP);
      for (let i = 0; i < cap; i++) {
        const r = roads[i];
        if (!r || !r.hitsMax) continue;
        const pct = r.hits / r.hitsMax;
        if (pct < minPct) minPct = pct;
      }
      vitals.roadMinPct = minPct;
    }
  }

  return vitals;
}

function getVitals(roomName) {
  const cached = Memory.roomSuspenderVitals[roomName];
  if (cached && Game.time - cached.tick < VITALS_TTL) {
    return cached;
  }
  const fresh = computeVitals(roomName);
  Memory.roomSuspenderVitals[roomName] = fresh;
  return fresh;
}

function getIneligibilityReason(roomName) {
  if (!Game.rooms[roomName]) return 'notVisible';
  const hardBlock = getHardBlockReason(roomName);
  if (hardBlock) return hardBlock;

  const v = getVitals(roomName);
  if (!v.hasTowers) return 'noTowers';
  if (v.towerMinPct < MIN_STRUCTURE_HEALTH) return 'towerDamage';
  if (v.roadMinPct  < MIN_STRUCTURE_HEALTH) return 'roadDamage';

  return null;
}

function isEligibleForSuspension(roomName) {
  return !getIneligibilityReason(roomName);
}

function getSuspensionPriority(roomName) {
  let score = 0;
  if (isMineralExtractionActive(roomName)) score += MINERAL_EXTRACTION_PENALTY;
  if (hasHardActiveJob(roomName)) score += ACTIVE_JOB_PENALTY;
  if (hasFactoryOrder(roomName)) score += SOFT_FACTORY_PENALTY;
  if (hasLabOrder(roomName)) score += SOFT_LAB_PENALTY;
  return score;
}

function getCpuAverage() {
  const cpuStats = require('memoryManager').heap.cpuStats;
  if (cpuStats && typeof cpuStats.average === 'number') return cpuStats.average;
  if (cpuStats && cpuStats.history && cpuStats.history.length > 0) {
    let total = 0;
    for (let i = 0; i < cpuStats.history.length; i++) total += cpuStats.history[i];
    return total / cpuStats.history.length;
  }
  return Game.cpu.getUsed();
}

function isUnderCpuPressure() {
  if (Game.cpu.bucket >= RESUME_BUCKET) return false;
  if (Game.cpu.bucket < SUSPEND_BUCKET) return true;
  const limit = Game.cpu.limit || 20;
  return getCpuAverage() >= limit * CPU_PRESSURE_RATIO;
}

function buildSuspendCandidates(owned) {
  const candidates = [];
  for (let i = 0; i < owned.length; i++) {
    const roomName = owned[i];
    if (isSuspended(roomName)) continue;
    if (!isEligibleForSuspension(roomName)) continue;
    candidates.push({
      roomName: roomName,
      score: getSuspensionPriority(roomName),
      mineralExtraction: isMineralExtractionActive(roomName),
      activeJob: hasHardActiveJob(roomName),
      factory: hasFactoryOrder(roomName),
      lab: hasLabOrder(roomName)
    });
  }
  candidates.sort(function(a, b) {
    if (a.score !== b.score) return a.score - b.score;
    return a.roomName < b.roomName ? -1 : (a.roomName > b.roomName ? 1 : 0);
  });
  return candidates;
}

function canSuspendAnotherRoom() {
  const ctrl = Memory.roomSuspenderControl;
  if (!ctrl.lastActionTick) return true;
  if (Game.time - ctrl.lastActionTick < ADAPT_SAMPLE_TICKS) return false;
  return isUnderCpuPressure();
}

function suspend(roomName, reason) {
  Memory.suspendedRooms[roomName] = {
    at:          Game.time,
    reason:      reason || 'bucket',
    lastChecked: Game.time,
    priority:    getSuspensionPriority(roomName),
    cpuBefore:   getCpuAverage(),
    bucketBefore: Game.cpu.bucket
  };

  Memory.roomSuspenderControl.lastActionTick = Game.time;
  Memory.roomSuspenderControl.lastRoom = roomName;
  Memory.roomSuspenderControl.sampleUntil = Game.time + ADAPT_SAMPLE_TICKS;
  Memory.roomSuspenderControl.cpuBefore = getCpuAverage();
  Memory.roomSuspenderControl.bucketBefore = Game.cpu.bucket;
}

function unsuspend(roomName) {
  if (Memory.suspendedRooms[roomName]) {
    delete Memory.suspendedRooms[roomName];
  }
}

function isSuspended(roomName) {
  return !!(Memory.suspendedRooms && Memory.suspendedRooms[roomName]);
}

function getCreepHomeRoom(creep) {
  if (creep.memory.homeRoom)     return creep.memory.homeRoom;
  if (creep.memory.assignedRoom) return creep.memory.assignedRoom;
  if (creep.memory.orderRoom)    return creep.memory.orderRoom;
  if (creep.room)                return creep.room.name;
  return null;
}

function shouldIdleCreep(creep) {
  const current = creep.room ? creep.room.name : null;

  // A creep idles only when it is actually standing in a suspended room.
  // A creep whose home is suspended but is currently elsewhere runs normally.
  if (!current || !isSuspended(current)) return false;

  // Current room is suspended. Harvester exception: keep renewing while
  // spawn + extensions still have >= HARVESTER_ENERGY_FLOOR.
  if (creep.memory.role === 'harvester') {
    const room = Game.rooms[current];
    if (room) {
      var floor = Math.min(HARVESTER_ENERGY_FLOOR, room.energyCapacityAvailable || 0);
      if (room.energyAvailable >= floor) {
        return false;
      }
    }
  }

  return true;
}

function canRunSuspendedHarvester(creep) {
  if (!creep || creep.memory.role !== 'harvester') return false;
  const current = creep.room ? creep.room.name : null;
  if (!current || !isSuspended(current)) return false;
  const room = Game.rooms[current];
  if (!room) return false;
  var floor = Math.min(HARVESTER_ENERGY_FLOOR, room.energyCapacityAvailable || 0);
  return room.energyAvailable >= floor;
}

function getSuspendedRooms() {
  if (!Memory.suspendedRooms) return [];
  return Object.keys(Memory.suspendedRooms);
}

// -----------------------------------------------------------------
// Main tick entry point
// -----------------------------------------------------------------

function run() {
  ensureMemory();

  const owned = getOwnedRooms();
  const ownedSet = {};
  for (let i = 0; i < owned.length; i++) ownedSet[owned[i]] = true;
  pruneOldRooms(ownedSet);

  const ctrl = Memory.roomSuspenderControl;
  if (ctrl.sampleUntil && Game.time >= ctrl.sampleUntil && ctrl.sampleRecordedTick !== ctrl.sampleUntil) {
    ctrl.sampleRecordedTick = ctrl.sampleUntil;
    ctrl.cpuAfter = getCpuAverage();
    ctrl.bucketAfter = Game.cpu.bucket;
  }

  // Phase 1: immediate resume checks for currently suspended rooms.
  for (const roomName in Memory.suspendedRooms) {
    if (!ownedSet[roomName]) {
      unsuspend(roomName);
      continue;
    }
    if (!Game.rooms[roomName]) {
      unsuspend(roomName);
      continue;
    }
    if (Game.cpu.bucket >= RESUME_BUCKET) {
      unsuspend(roomName);
      continue;
    }
    if (hasHostilesNow(roomName)) {
      unsuspend(roomName);
      continue;
    }
    if (!isEligibleForSuspension(roomName)) {
      unsuspend(roomName);
      continue;
    }
    Memory.suspendedRooms[roomName].lastChecked = Game.time;
  }

  // Phase 2: suspend at most one room, then sample CPU before taking more.
  if (isUnderCpuPressure() && canSuspendAnotherRoom()) {
    const candidates = buildSuspendCandidates(owned);
    if (candidates.length > 0) {
      const pick = candidates[0];
      const reason = 'pressure:p' + pick.score +
        (pick.mineralExtraction ? ':mineralExtraction' : '') +
        (pick.activeJob ? ':activeJob' : '') +
        (pick.factory ? ':factory' : '') + (pick.lab ? ':lab' : '');
      suspend(pick.roomName, reason);
    }
  }
}

// -----------------------------------------------------------------
// Console helpers
// -----------------------------------------------------------------

function status() {
  ensureMemory();
  const suspended = getSuspendedRooms();
  const ctrl = Memory.roomSuspenderControl || {};
  const lines = [
    '[RoomSuspender] Bucket=' + Game.cpu.bucket +
      ' CPUavg=' + getCpuAverage().toFixed(2) +
      ' suspended=' + (suspended.length ? suspended.join(',') : 'none')
  ];
  lines.push(
    '  control: lastRoom=' + (ctrl.lastRoom || '-') +
    ' sampleUntil=' + (ctrl.sampleUntil || '-') +
    ' cpu ' + (ctrl.cpuBefore !== undefined ? ctrl.cpuBefore.toFixed(2) : '?') +
    ' -> ' + (ctrl.cpuAfter !== undefined ? ctrl.cpuAfter.toFixed(2) : '?') +
    ' bucket ' + (ctrl.bucketBefore !== undefined ? ctrl.bucketBefore : '?') +
    ' -> ' + (ctrl.bucketAfter !== undefined ? ctrl.bucketAfter : '?')
  );
  for (const rn of suspended) {
    const v = Memory.roomSuspenderVitals[rn];
    const entry = Memory.suspendedRooms[rn];
    lines.push(
      '  ' + rn + ': reason=' + (entry ? entry.reason : '?') +
      ' priority=' + (entry && entry.priority !== undefined ? entry.priority : getSuspensionPriority(rn)) +
      ' tower=' + (v ? v.towerMinPct.toFixed(2) : '?') +
      ' road=' + (v ? v.roadMinPct.toFixed(2) : '?') +
      ' hardBlock=' + (getHardBlockReason(rn) || '-') +
      ' factory=' + hasFactoryOrder(rn) +
      ' lab=' + hasLabOrder(rn) +
      ' host=' + hasHostilesNow(rn)
    );
  }

  const owned = getOwnedRooms();
  const candidates = buildSuspendCandidates(owned);
  if (candidates.length > 0) {
    const show = candidates.slice(0, 5).map(function(c) {
      return c.roomName + '(p' + c.score +
        (c.mineralExtraction ? ',mineralExtraction' : '') +
        (c.activeJob ? ',activeJob' : '') +
        (c.factory ? ',factory' : '') + (c.lab ? ',lab' : '') + ')';
    });
    lines.push('  next candidates: ' + show.join(' '));
  } else {
    lines.push('  next candidates: none');
  }

  const blocked = [];
  for (let i = 0; i < owned.length; i++) {
    const rn = owned[i];
    if (isSuspended(rn)) continue;
    const reason = getHardBlockReason(rn);
    if (reason) blocked.push(rn + '(' + reason + ')');
  }
  lines.push('  hard-blocked: ' + (blocked.length ? blocked.join(' ') : 'none'));
  return lines.join('\n');
}

function suspensionPlan() {
  ensureMemory();
  const owned = getOwnedRooms();
  const ctrl = Memory.roomSuspenderControl || {};
  const pressure = isUnderCpuPressure();
  const cooldownRemaining = ctrl.lastActionTick
    ? Math.max(0, ADAPT_SAMPLE_TICKS - (Game.time - ctrl.lastActionTick))
    : 0;
  const lines = [
    '[RoomSuspender plan] tick=' + Game.time +
      ' bucket=' + Game.cpu.bucket +
      ' cpuAvg=' + getCpuAverage().toFixed(2) +
      ' pressure=' + pressure +
      ' cooldown=' + cooldownRemaining
  ];

  const suspended = getSuspendedRooms().sort(function(a, b) {
    return Memory.suspendedRooms[a].at - Memory.suspendedRooms[b].at ||
      (a < b ? -1 : (a > b ? 1 : 0));
  });
  lines.push('  disabled now (' + suspended.length + '):');
  if (suspended.length === 0) {
    lines.push('    none');
  } else {
    for (let i = 0; i < suspended.length; i++) {
      const roomName = suspended[i];
      const entry = Memory.suspendedRooms[roomName];
      lines.push('    ' + (i + 1) + '. ' + roomName +
        ' since=' + entry.at + ' reason=' + entry.reason);
    }
  }

  const candidates = buildSuspendCandidates(owned);
  lines.push('  suspension order if pressure continues (' + candidates.length + '):');
  if (candidates.length === 0) {
    lines.push('    none');
  } else {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      lines.push('    ' + (i + 1) + '. ' + candidate.roomName +
        ' priority=' + candidate.score +
        (candidate.mineralExtraction ? ' mineralExtraction' : '') +
        (candidate.activeJob ? ' activeJob' : '') +
        (candidate.factory ? ' factory' : '') +
        (candidate.lab ? ' lab' : ''));
    }
  }

  const excluded = [];
  for (let i = 0; i < owned.length; i++) {
    const roomName = owned[i];
    if (isSuspended(roomName)) continue;
    const reason = getIneligibilityReason(roomName);
    if (reason) excluded.push({ roomName: roomName, reason: reason });
  }
  excluded.sort(function(a, b) {
    return a.roomName < b.roomName ? -1 : (a.roomName > b.roomName ? 1 : 0);
  });
  lines.push('  hard-excluded now, until their condition changes (' + excluded.length + '):');
  if (excluded.length === 0) {
    lines.push('    none');
  } else {
    for (let i = 0; i < excluded.length; i++) {
      lines.push('    ' + excluded[i].roomName + ': ' + excluded[i].reason);
    }
  }
  lines.push('  note: mineral extraction and active jobs are ranked after idle rooms, not excluded.');
  return lines.join('\n');
}

global.roomSuspendStatus = status;
global.roomSuspendPlan = suspensionPlan;
global.getSuspendedRooms = getSuspendedRooms;
global.forceSuspendRoom = function(roomName) {
  ensureMemory();
  if (!Game.rooms[roomName] || !Game.rooms[roomName].controller || !Game.rooms[roomName].controller.my) {
    return 'Not an owned room: ' + roomName;
  }
  const hardBlock = getHardBlockReason(roomName);
  if (hardBlock) return 'Refusing to suspend ' + roomName + ': hard-blocked by ' + hardBlock;
  suspend(roomName, 'manual');
  return 'Suspended: ' + roomName;
};
global.forceResumeRoom = function(roomName) {
  ensureMemory();
  unsuspend(roomName);
  return 'Resumed: ' + roomName;
};

module.exports = {
  run:              run,
  isSuspended:      isSuspended,
  shouldIdleCreep:  shouldIdleCreep,
  canRunSuspendedHarvester: canRunSuspendedHarvester,
  getSuspendedRooms: getSuspendedRooms,
  getHardBlockReason: getHardBlockReason,
  suspensionPlan:   suspensionPlan,
  shouldAvoidRoomWork: function(roomName) {
    return isSuspended(roomName);
  }
};
