// LLM: Read docs/codex.js before reviewing or changing this file.
// repairManager.js
// Console globals: orderWallRepair, cancelWallRepair, pauseWallRepair, resumeWallRepair, pauseRampartBot, resumeRampartBot, repairStatus, repairPlan, repairMax, repairSize, repairSetTarget, repairResetTargets, repairMaxHeal, repairNukePlan, repairPause, repairResume, repairSuggestBoost, requestTaskBoost, repairDispatch, repairCacheStatus, repairForgetCache, repairDestroyCached, repairCacheBuildings, repairRebuildMissing, repairCompactPlans, repairCompactMemory, repairCleanup, repairCheckBreach, wallRepairOverview, wallRepairStatus
// Example: orderWallRepair('E1N1', 10000000) - Set wall/rampart repair hitpoint target
// Example: cancelWallRepair('E1N1') - Cancel wall repair order for room
// Example: pauseWallRepair('E1N1') - Pause wall repairers in room
// Example: resumeWallRepair('E1N1') - Resume wall repairers in room
// Example: pauseRampartBot('E1N1') - Pause rampart repair bots in room
// Example: resumeRampartBot('E1N1') - Resume rampart repair bots in room
// Example: repairStatus('E1N1') - Show repair targets, progress, and active builders
// Example: repairPlan('E1N1') - Inspect planned repair targets and priorities
// Example: repairMax('E1N1') - Set repair target to maximum allowed hits
// Example: repairSize('E1N1') - Query or adjust repair bot body size allocation
// Example: repairSetTarget('E1N1', 'structureId', 5000000) - Set target hits for specific structure
// Example: repairResetTargets('E1N1') - Reset structure repair targets to default
// Example: repairMaxHeal('E1N1') - Calculate max tower heal capacity in room
// Example: repairNukePlan('E1N1') - Generate defensive rampart repair plan against incoming nuke
// Example: repairPause('E1N1') - Pause all repair operations for room
// Example: repairResume('E1N1') - Resume all repair operations for room
// Example: repairSuggestBoost('E1N1') - Evaluate boost recommendations for repairers
// Example: requestTaskBoost('E1N1', 'LH2O') - Request boost compound for repair task
// Example: repairDispatch('E1N1') - Trigger immediate repair task dispatch cycle
// Example: repairCacheStatus('E1N1') - Display cached repair structure metadata
// Example: repairForgetCache('E1N1') - Clear cached repair structure data
// Example: repairDestroyCached('E1N1') - Purge stale destroyed structures from cache
// Example: repairCacheBuildings('E1N1') - Force rebuild cached building records
// Example: repairRebuildMissing('E1N1') - Rebuild missing repair target plans
// Example: repairCheckBreach('E1N1') - Check perimeter breach state and BFS diagnostics
// Example: repairCompactPlans('E1N1') - Compact repair plan memory structures
// Example: repairCompactMemory('E1N1') - Prune expired repair state from Memory
// Example: repairCleanup('E1N1') - Clean up completed and orphaned repair jobs
// Example: wallRepairOverview() - Display empire-wide wall and rampart hitpoint summary
// Example: wallRepairStatus('E1N1') - View detailed wall repair progress in room
//   repairPlan(roomName?)      Plan per room: tier, items, tower queue, spawn requests.
//   repairStatus(roomName?)    Active/idle repairer count.
//   repairDispatch(roomName?)  Pending spawn requests.
//   repairSize(opts)           sizeDispatch({ totalHits, ... }).
//   repairCacheBuildings(roomName) / repairCacheStatus(roomName) /
//     repairForgetCache(roomName)  Snapshot, inspect, or drop the
//     rebuildable-ruin cache.
//   repairDestroyCached(roomName, type?, "CONFIRM")  Destroy cached structures.
//   repairRebuildMissing(roomName)  Recreate construction sites from cache.
//   repairCheckBreach(roomName)  Inspect perimeter breach state and BFS diagnostics.
//   repairNukePlan(roomName)   Active nuke tier breakdown.
//   repairSetTarget(roomName, type, hits) / repairResetTargets(roomName?)
//     Override, or clear, wall/rampart target HP.
//   repairSuggestBoost(roomName)  Recommend LH2O/XLH2O.
//   repairCleanup()             Drop all repair memory + compact.
//   repairCompactPlans(roomName?)  Compact memory + rebuild plans.
//   repairCompactMemory()       Compact live creep/req memory.
//   repairPause(roomName?) / repairResume(roomName?)  Pause/resume spawning.
//   repairMaxHeal(roomName?, opts?)  Max-heal mode: repairMaxHeal('E9N47')
//     enables persistently, (…, false) disables, (…, 5000) enables for 5000
//     ticks, () with no args lists active rooms; repairMax is an alias.
//     While enabled: 3 repairers, towers unleashed, towers repair
//     walls/ramparts (95% HP cap), tower fillers spawn without hostiles
//     (fill to 95%).
//   requestTaskBoost(roomName, taskId, compound, parts)  Queue a task boost.
//   Legacy (deprecated): orderWallRepair/cancelWallRepair/wallRepairStatus,
//     wallRepairOverview/pauseWallRepair/resumeWallRepair,
//     pauseRampartBot/resumeRampartBot.
//   Memory.repairManager.rooms[roomName] = { inaccessible, targetOverrides,
//     buildingCache, lastRealHostileTick, maxHeal, maxHealUntil,
//     peaceEmergencyUntil, breachEmergencyUntil }
//   Memory.repairPlan[roomName]           compact plan
//   Memory.repairSpawnRequests[roomName]  pending spawn requests
//   Memory.repairSpawnLastTick[roomName]  last successful repairer spawn
//   Memory.spawnPause.repairer            { rooms, global }
//   global._repairPlanCache[roomName]     live plan cache
//   global._repairBreachCache[roomName]   live perimeter scan cache
var getRoomState = require("getRoomState");
var defenseMonitor = require("defenseMonitor");
var roomSuspender = require("roomSuspender");
var util = require("util");
var MAX_PARALLEL_REPAIRERS = 4;
var MAX_MAINTENANCE_ITEMS = 16;
var EXTRA_REPAIR_STORAGE_MIN = 3e5;
var MIN_PEACE_REPAIR_CREEP_HITS = 1e5;
var REPAIRER_REPLACEMENT_TTL = 100;
var REPAIR_SPAWN_INTERVAL_TICKS = 10;
var REPAIR_BODY_DOWNSIZE_AFTER_TICKS = 20;
var REPAIRER_OUTAGE_RECHECK_TICKS = 50;
var REPAIR_BODY_MIN_CAPACITY_RATIO = .6;
var INACCESSIBLE_RETRY_TICKS = 500;
var PEACETIME_SCAN_INTERVAL = 300;
var WARTIME_SCAN_INTERVAL = 50;
var TOWER_ENERGY_RESERVE = 1500;
var TOWER_REPAIR_LIMIT_WITH_HOSTILES = 1;
var TOWER_REPAIR_LIMIT_DURING_NUKE = 1;
var PLAN_FRESH_TTL = 5;
var MAX_SERIALIZED_TOWER_QUEUE = 100;
var BODY_MIN_COST = 250;
var BODY_MAX_COST = 3150;
var SPAWN_RESERVE = 100;
var BASELINE_HITS_PER_LIFE = 3e6;
var NUKE_GROUND_ZERO_DAMAGE = 1e7;
var NUKE_SPLASH_DAMAGE = 5e6;
var NUKE_SAFETY_MARGIN = 5e5;
var HOSTILE_FREE_FOR_MINERAL_REBUILD = 2e4;
var PEACETIME_EMERGENCY_FRACTION = .1;
var PEACETIME_EMERGENCY_TICKS = 1e3;
var CORE_PROTECTED_STRUCTURE_TYPES = [ STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_TOWER, STRUCTURE_LAB, STRUCTURE_FACTORY, STRUCTURE_NUKER, STRUCTURE_POWER_SPAWN ];
var BREACH_MIN_RCL = 3;
var BREACH_RECHECK_TICKS = 25;
var BREACH_MAX_NODES = 3000;
var bfsVisited = new Uint32Array(2500);
var bfsQueue = new Uint16Array(2500);
var bfsStamp = 0;
var ROAD_EMERGENCY_FRACTION = .3;
var CONTAINER_EMERGENCY_FRACTION = .3;
var WALL_EMERGENCY_HITS = 1e6;
var RAMPART_EMERGENCY_HITS = 1e6;
var CRITICAL_RAMPART_EMERGENCY_HITS = 5e6;
var REPAIR_TIERS = {
  PEACE: 1,
  PEACE_EMERGENCY: 2,
  WAR: 2,
  WAR_EMERGENCY: 3
};
var WALLREPAIR_THRESHOLD_BY_RCL = [ 0, 0, 1e4, 5e4, 2e5, 1e6, 5e6, 1e7, 5e7 ];
var RCL_TOWER_CAP = [ 0, 0, 1e4, 5e4, 2e5, 1e6, 1e6, 1e6, 1e6 ];
var CRITICAL_RAMPART_TOWER_CAP = 105e5;
var RAMPART_UNPROTECTED_TARGET = 5e7;
var RAMPART_UNMAPPED_BUILDING_TARGET = 55e5;
var RAMPARTBOT_PERIMETER_RANGE = 3;
var ROAD_REPAIR_TRIGGER = .5;
var ROAD_REPAIR_TARGET = .8;
var DEFENSE_REPAIR_TRIGGER_RATIO = .9;
var DEFENSE_REPAIR_TARGET_RATIO = .97;
var CONTAINER_DONE_HITS = 244e3;
var TOWER_REPAIR_MAX_RATIO = .95;
const RAMPART_TARGETS = {
  [STRUCTURE_SPAWN]: 605e5,
  [STRUCTURE_TERMINAL]: 605e5,
  [STRUCTURE_STORAGE]: 605e5,
  [STRUCTURE_TOWER]: 55e5,
  [STRUCTURE_LINK]: 55e5,
  [STRUCTURE_NUKER]: 105e5,
  [STRUCTURE_FACTORY]: 55e5,
  [STRUCTURE_LAB]: 55e5,
  [STRUCTURE_POWER_SPAWN]: 105e5,
  [STRUCTURE_OBSERVER]: 55e5
};
const TOWER_REPAIR_CAP_BY_TYPE = {
  [STRUCTURE_TOWER]: 55e5,
  [STRUCTURE_LAB]: 55e5,
  [STRUCTURE_LINK]: 55e5,
  [STRUCTURE_FACTORY]: 55e5,
  [STRUCTURE_OBSERVER]: 55e5
};
var NUKE_TIER_BY_TYPE = {};
NUKE_TIER_BY_TYPE[STRUCTURE_SPAWN] = 1;
NUKE_TIER_BY_TYPE[STRUCTURE_STORAGE] = 2;
NUKE_TIER_BY_TYPE[STRUCTURE_TERMINAL] = 2;
NUKE_TIER_BY_TYPE[STRUCTURE_TOWER] = 3;
NUKE_TIER_BY_TYPE[STRUCTURE_NUKER] = 4;
NUKE_TIER_BY_TYPE[STRUCTURE_POWER_SPAWN] = 4;
NUKE_TIER_BY_TYPE[STRUCTURE_FACTORY] = 4;
NUKE_TIER_BY_TYPE[STRUCTURE_LAB] = 4;
NUKE_TIER_BY_TYPE[STRUCTURE_LINK] = 4;
NUKE_TIER_BY_TYPE[STRUCTURE_OBSERVER] = 5;
NUKE_TIER_BY_TYPE[STRUCTURE_CONTAINER] = 5;
var NUKE_TIER_NAMES = {
  1: "core-survival",
  2: "core-economy",
  3: "defense",
  4: "strategic",
  5: "support",
  6: "barrier"
};
var REBUILD_TYPES = [ STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_TOWER, STRUCTURE_LINK, STRUCTURE_LAB, STRUCTURE_FACTORY, STRUCTURE_NUKER, STRUCTURE_POWER_SPAWN, STRUCTURE_OBSERVER, STRUCTURE_EXTRACTOR, STRUCTURE_EXTENSION, STRUCTURE_CONTAINER ];
var REPAIRER_ROLES = {
  repairer: true,
  wallRepair: true,
  rampartBot: true,
  defenseRepair: true
};
if (!global._repairPlanCache) global._repairPlanCache = {};
if (!global._repairAssignmentTick) global._repairAssignmentTick = {};
if (!global._repairBreachCache) global._repairBreachCache = {};
function ensureMemory() {
  if (!Memory.repairManager) Memory.repairManager = {
    rooms: {}
  };
  if (!Memory.repairManager.rooms) Memory.repairManager.rooms = {};
  if (!Memory.repairPlan) Memory.repairPlan = {};
  if (!Memory.repairSpawnRequests) Memory.repairSpawnRequests = {};
}

function roomMem(e, r) {
  if (r) {
    var t = Memory.repairManager && Memory.repairManager.rooms;
    return t && t[e] || {};
  }
  ensureMemory();
  if (!Memory.repairManager.rooms[e]) {
    Memory.repairManager.rooms[e] = {
      inaccessible: {},
      targetOverrides: {},
      roadRepairTargets: {}
    };
  }
  var a = Memory.repairManager.rooms[e];
  if (!a.inaccessible) a.inaccessible = {};
  if (!a.targetOverrides) a.targetOverrides = {};
  if (!a.roadRepairTargets) a.roadRepairTargets = {};
  if (a.maxHealUntil && Game.time >= a.maxHealUntil) {
    delete a.maxHeal;
    delete a.maxHealUntil;
  }
  return a;
}

function isMaxHeal(e, r) {
  var t = roomMem(e, r);
  if (t.maxHeal) return true;
  if (t.maxHealUntil && Game.time < t.maxHealUntil) return true;
  return false;
}

function isOwnedVisibleRoom(e) {
  var r = Game.rooms[e];
  return !!(r && r.controller && r.controller.my);
}

function ownedVisibleRooms() {
  var e = [];
  for (var r in Game.rooms) {
    if (isOwnedVisibleRoom(r)) e.push(r);
  }
  return e;
}

function clearVisibleUnownedRepairWork(e) {
  var r = Game.rooms[e];
  if (!r || r.controller && r.controller.my) return;
  ensureMemory();
  delete Memory.repairPlan[e];
  delete Memory.repairSpawnRequests[e];
  if (Memory.repairSpawnLastTick) delete Memory.repairSpawnLastTick[e];
  if (global._repairPlanCache) delete global._repairPlanCache[e];
  if (global._repairBreachCache) delete global._repairBreachCache[e];
  if (Memory.towers) delete Memory.towers[e];
  if (Memory.defense && Memory.defense.repairOrders) delete Memory.defense.repairOrders[e];
  var t = Memory.repairManager.rooms && Memory.repairManager.rooms[e];
  if (t) {
    delete t.inaccessible;
    delete t.roadRepairTargets;
    if (t.maxHealUntil && Game.time >= t.maxHealUntil) {
      delete t.maxHeal;
      delete t.maxHealUntil;
    }
    if (t.lastRealHostileTick && Game.time - t.lastRealHostileTick >= HOSTILE_FREE_FOR_MINERAL_REBUILD) {
      delete t.lastRealHostileTick;
    }
    if (!t.targetOverrides || Object.keys(t.targetOverrides).length === 0) delete t.targetOverrides;
    if (!t.buildingCache && !t.targetOverrides && !t.maxHeal && !t.maxHealUntil && !t.lastRealHostileTick) {
      delete Memory.repairManager.rooms[e];
    }
  }
  var a = getRoomState.creepIndex();
  var i = a && a.all ? a.all : [];
  for (var n = 0; n < i.length; n++) {
    var o = i[n];
    if (!o.memory || !REPAIRER_ROLES[o.memory.role]) continue;
    var s = o.memory.homeRoom || o.memory.assignedRoom || null;
    if (s !== e) continue;
    delete o.memory.task;
    delete o.memory.targetId;
    delete o.memory.route;
  }
}

var bodyCost = util.bodyCost;
function compactBody(e) {
  var r = {};
  for (var t = 0; t < e.length; t++) r[e[t]] = (r[e[t]] || 0) + 1;
  return r;
}

function computeBody(e, r) {
  e = Math.min(BODY_MAX_COST, Math.max(BODY_MIN_COST, e || BODY_MIN_COST));
  var t = 1.5;
  var a = 1;
  if (r === "road") {
    t = 1;
    a = .5;
  } else if (r === "plain") {
    t = 2;
    a = 1;
  }
  var i = 0, n = 0, o = 0;
  for (var s = 1; s <= 50; s++) {
    var u = Math.max(1, Math.round(s / t));
    var l = Math.max(1, Math.ceil((s + u) * a));
    if (s + u + l > 50) break;
    var R = s * 100 + u * 50 + l * 50;
    if (R > e) break;
    i = s;
    n = u;
    o = l;
  }
  if (i === 0) return [ WORK, CARRY, MOVE, MOVE ];
  var m = [];
  for (var c = 0; c < i; c++) m.push(WORK);
  for (var p = 0; p < n; p++) m.push(CARRY);
  for (var f = 0; f < o; f++) m.push(MOVE);
  return m;
}

function sizeDispatch(e) {
  e = e || {};
  var r = e.totalHits || 0;
  var t = e.maxSingleHits || r || 0;
  var a = e.availableEnergy || BODY_MIN_COST;
  var i = e.movementProfile || "mixed";
  var n = typeof e.urgency === "number" ? e.urgency : .2;
  var o = typeof e.towerFraction === "number" ? e.towerFraction : 0;
  var s = r * (1 - o);
  var u = Math.max(1, Math.ceil(t / BASELINE_HITS_PER_LIFE));
  var l = 1;
  if (n > .7) l = Math.max(2, Math.ceil(n * u)); else if (n > .4) l = Math.max(1, Math.ceil(n * u));
  l = Math.min(l, MAX_PARALLEL_REPAIRERS);
  var R = Math.max(BODY_MIN_COST, a - SPAWN_RESERVE);
  var m = computeBody(R, i);
  var c = 0;
  for (var p = 0; p < m.length; p++) if (m[p] === WORK) c++;
  return {
    body: m,
    cost: bodyCost(m),
    count: l,
    hitsPerTick: c * 100,
    estimatedTicks: c > 0 ? Math.ceil(s / (l * c * 100)) : 0
  };
}

function isRealHostile(e) {
  if (!e || !e.owner) return false;
  var r = e.owner.username;
  if (r === "Invader" || r === "Source Keeper") return false;
  if (!e.body || e.body.length === 0) return false;
  for (var t = 0; t < e.body.length; t++) {
    if (e.body[t].type !== MOVE) return true;
  }
  return false;
}

function hasGlobalScannerWarPlayer() {
  var e = Memory.playerMonitor && Memory.playerMonitor.players;
  if (!e) return false;
  for (var r in e) {
    if (e[r] && e[r].status === "WAR") return true;
  }
  return false;
}

function isPerimeter(e) {
  return e.x <= RAMPARTBOT_PERIMETER_RANGE || e.x >= 49 - RAMPARTBOT_PERIMETER_RANGE || e.y <= RAMPARTBOT_PERIMETER_RANGE || e.y >= 49 - RAMPARTBOT_PERIMETER_RANGE;
}

function isMineralContainer(e, r) {
  if (!e || !r || !r.minerals) return false;
  for (var t = 0; t < r.minerals.length; t++) {
    var a = r.minerals[t];
    if (a && e.pos.inRangeTo(a.pos, 2)) return true;
  }
  return false;
}

// The old shape rescanned every structure in the room for each rampart, which
// is O(ramparts x structures) and was this module's largest CPU item. Index the
// room's structures by packed position once per tick instead; the result is a
// pure function of the room's structures, so read-only callers share the memo.
function rampartCoverIndex(e, r) {
  var t = global._repairRampartInfo;
  if (!t || t.tick !== Game.time) {
    t = {
      tick: Game.time,
      rooms: {}
    };
    global._repairRampartInfo = t;
  }
  var a = t.rooms[e];
  if (a) return a;
  a = {};
  var i = r && r.structuresByType ? r.structuresByType : {};
  for (var n in i) {
    if (n === STRUCTURE_RAMPART) continue;
    var o = i[n] || [];
    var s = RAMPART_TARGETS[n] || 0;
    for (var u = 0; u < o.length; u++) {
      var l = o[u];
      if (!l || !l.pos || l.pos.roomName !== e) continue;
      var R = l.pos.y * 50 + l.pos.x;
      var m = a[R];
      if (!m) m = a[R] = {
        target: 0,
        type: null
      };
      if (s > m.target) {
        m.target = s;
        m.type = n;
      }
    }
  }
  t.rooms[e] = a;
  return a;
}

function getRampartTarget(e, r, t) {
  var i = e && e.pos && e.pos.roomName;
  var n = rampartCoverIndex(i, r)[e.pos.y * 50 + e.pos.x];
  var o, s;
  if (!n) {
    o = RAMPART_UNPROTECTED_TARGET;
    s = null;
  } else if (n.target === 0) {
    o = RAMPART_UNMAPPED_BUILDING_TARGET;
    s = null;
  } else {
    o = n.target;
    s = n.type;
  }
  var u = RAMPART_HITS_MAX[t] || 0;
  if (u > 0 && o > u) o = u;
  return {
    target: o,
    type: s
  };
}

function getWallTarget(e, r, t) {
  var a = roomMem(e, t);
  if (a.targetOverrides && a.targetOverrides[STRUCTURE_WALL]) return a.targetOverrides[STRUCTURE_WALL];
  return WALLREPAIR_THRESHOLD_BY_RCL[r] || 0;
}

function towerCapFor(e, r) {
  if (e.type === STRUCTURE_WALL) return RCL_TOWER_CAP[r] || 0;
  if (e.type === STRUCTURE_RAMPART) {
    if (e.criticalRampart) return CRITICAL_RAMPART_TOWER_CAP;
    if (e.protectedStructureType && TOWER_REPAIR_CAP_BY_TYPE[e.protectedStructureType]) {
      return TOWER_REPAIR_CAP_BY_TYPE[e.protectedStructureType];
    }
    return RCL_TOWER_CAP[r] || 0;
  }
  return e.target || 0;
}

function towerRepairTarget(e) {
  var r = e.target || 0;
  if (e.hitsMax) r = Math.min(r, Math.floor(e.hitsMax * TOWER_REPAIR_MAX_RATIO));
  return r;
}

function roadTriggerHits(e) {
  return Math.floor((e.hitsMax || 0) * ROAD_REPAIR_TRIGGER);
}

function roadTargetHits(e) {
  return Math.floor((e.hitsMax || 0) * ROAD_REPAIR_TARGET);
}

function buildItems(e, r, t, a) {
  var i = [];
  var n = r && r.structuresByType ? r.structuresByType : {};
  var o = getWallTarget(e, t, a);
  var s = roomMem(e, a);
  var u = s.roadRepairTargets || {};
  if (a) {
    var l = {};
    for (var R in u) l[R] = u[R];
    u = l;
  }
  var m = {};
  var c = n[STRUCTURE_WALL] || [];
  for (var p = 0; p < c.length; p++) {
    var f = c[p];
    var T = Math.floor(o * DEFENSE_REPAIR_TARGET_RATIO);
    if (!f || typeof f.hits !== "number" || f.hits >= Math.floor(o * DEFENSE_REPAIR_TRIGGER_RATIO)) continue;
    i.push({
      id: f.id,
      type: STRUCTURE_WALL,
      x: f.pos.x,
      y: f.pos.y,
      hits: f.hits,
      target: T
    });
  }
  var E = n[STRUCTURE_RAMPART] || [];
  for (var v = 0; v < E.length; v++) {
    var _ = E[v];
    if (!_ || !_.my || typeof _.hits !== "number") continue;
    var g = getRampartTarget(_, r, t);
    var d = g.target;
    var A = Math.floor(d * DEFENSE_REPAIR_TARGET_RATIO);
    if (d <= 0 || _.hits >= Math.floor(d * DEFENSE_REPAIR_TRIGGER_RATIO)) continue;
    i.push({
      id: _.id,
      type: STRUCTURE_RAMPART,
      x: _.pos.x,
      y: _.pos.y,
      hits: _.hits,
      target: A,
      criticalRampart: d >= CRITICAL_RAMPART_TOWER_CAP,
      protectedStructureType: g.type
    });
  }
  var y = n[STRUCTURE_ROAD] || [];
  for (var h = 0; h < y.length; h++) {
    var M = y[h];
    if (!M || typeof M.hits !== "number" || !M.hitsMax) continue;
    m[M.id] = true;
    var P = roadTriggerHits(M);
    var C = roadTargetHits(M);
    if (M.hits < P) u[M.id] = 1; else if (M.hits >= C) delete u[M.id];
    if (u[M.id]) {
      i.push({
        id: M.id,
        type: STRUCTURE_ROAD,
        x: M.pos.x,
        y: M.pos.y,
        hits: M.hits,
        hitsMax: M.hitsMax,
        target: C
      });
    }
  }
  for (var I in u) if (!m[I]) delete u[I];
  if (!a) s.roadRepairTargets = u;
  var S = n[STRUCTURE_CONTAINER] || [];
  for (var U = 0; U < S.length; U++) {
    var N = S[U];
    if (!N || typeof N.hits !== "number") continue;
    if (N.hits < CONTAINER_DONE_HITS) i.push({
      id: N.id,
      type: STRUCTURE_CONTAINER,
      x: N.pos.x,
      y: N.pos.y,
      hits: N.hits,
      hitsMax: N.hitsMax || 25e4,
      target: CONTAINER_DONE_HITS,
      mineralContainer: isMineralContainer(N, r)
    });
  }
  return i;
}

function buildMaintenanceItems(e, r, t, a, i) {
  var n = [];
  var o = {};
  for (var s = 0; s < a.length; s++) o[a[s].id] = true;
  var u = r && r.structuresByType ? r.structuresByType : {};
  var l = getWallTarget(e, t, i);
  var R = u[STRUCTURE_WALL] || [];
  for (var m = 0; m < R.length; m++) {
    var c = R[m];
    if (!c || o[c.id] || typeof c.hits !== "number" || typeof c.hitsMax !== "number" || l <= 0 || c.hits >= l) continue;
    n.push({
      id: c.id,
      type: STRUCTURE_WALL,
      x: c.pos.x,
      y: c.pos.y,
      hits: c.hits,
      hitsMax: c.hitsMax,
      target: l,
      deficit: l - c.hits,
      source: "creep",
      maintenance: true,
      towerCap: 0,
      peerCount: 1
    });
  }
  var p = u[STRUCTURE_RAMPART] || [];
  for (var f = 0; f < p.length; f++) {
    var T = p[f];
    if (!T || !T.my || o[T.id] || typeof T.hits !== "number" || typeof T.hitsMax !== "number" || T.hits >= T.hitsMax) continue;
    var E = getRampartTarget(T, r, t);
    if (E.target <= 0 || T.hits >= E.target) continue;
    n.push({
      id: T.id,
      type: STRUCTURE_RAMPART,
      x: T.pos.x,
      y: T.pos.y,
      hits: T.hits,
      hitsMax: T.hitsMax,
      target: E.target,
      deficit: E.target - T.hits,
      source: "creep",
      maintenance: true,
      criticalRampart: E.target >= CRITICAL_RAMPART_TOWER_CAP,
      protectedStructureType: E.type,
      towerCap: 0,
      peerCount: 1
    });
  }
  n.sort(function(e, r) {
    var t = e.target > 0 ? e.hits / e.target : 1;
    var a = r.target > 0 ? r.hits / r.target : 1;
    if (t !== a) return t - a;
    return e.hits - r.hits;
  });
  if (n.length > MAX_MAINTENANCE_ITEMS) n.length = MAX_MAINTENANCE_ITEMS;
  return n;
}

function classifyItems(e, r, t) {
  var a = false;
  var i = t.structuresByType && t.structuresByType[STRUCTURE_TOWER] || [];
  for (var n = 0; n < i.length; n++) {
    if (i[n].my && i[n].store[RESOURCE_ENERGY] >= TOWER_ENERGY_RESERVE) {
      a = true;
      break;
    }
  }
  var o = {};
  for (var s = 0; s < e.length; s++) o[e[s].type] = (o[e[s].type] || 0) + 1;
  for (var u = 0; u < e.length; u++) {
    var l = e[u];
    l.towerCap = towerCapFor(l, r);
    l.deficit = Math.max(0, l.target - l.hits);
    l.peerCount = o[l.type] || 1;
    if (l.type === STRUCTURE_ROAD || l.type === STRUCTURE_CONTAINER) l.source = "tower"; else if (l.target > l.towerCap) l.source = "creep"; else if (!a) l.source = "creep"; else if (l.peerCount >= 10) l.source = "tower"; else l.source = "both";
    if (l.source === "tower") l.target = towerRepairTarget(l);
  }
  return e;
}

// buildPlan and shouldBypassPlanCache both need the room's full item set, and
// building it twice per tick doubled the structure walk for no benefit. The set
// is derived purely from this tick's room state, so one build serves both.
// classifyItems only writes towerCap/deficit/peerCount/source/target, none of
// which the bypass probe's isPeacetimeEmergencyItem check reads.
function repairItemSet(e, r, t, a) {
  var i = global._repairItemSetCache;
  if (!i || i.tick !== Game.time) {
    i = {
      tick: Game.time,
      rooms: {}
    };
    global._repairItemSetCache = i;
  }
  var n = a ? e + "#ro" : e;
  var o = i.rooms[n];
  if (o) return o;
  var s = classifyItems(buildItems(e, r, t, a), t, r);
  o = {
    items: s,
    stats: computeStats(s),
    maintenance: buildMaintenanceItems(e, r, t, s, a)
  };
  i.rooms[n] = o;
  return o;
}

function towerPriority(e) {
  if (e.type === STRUCTURE_CONTAINER) return 1;
  if (e.type === STRUCTURE_ROAD) return 2;
  if (e.type === STRUCTURE_RAMPART && e.criticalRampart && e.hits < CRITICAL_RAMPART_TOWER_CAP) return 3;
  if (e.hits < 1e6) return 4;
  return 5;
}

function isBorderPos(e) {
  return e && (e.x === 0 || e.x === 49 || e.y === 0 || e.y === 49);
}

function buildHealQueue(e) {
  var r = [];
  var t = e && e.myPowerCreeps || [];
  for (var a = 0; a < t.length; a++) {
    var i = t[a];
    if (!i || !i.name || typeof i.hits !== "number" || !i.hitsMax) continue;
    if (i.hits >= i.hitsMax) continue;
    r.push({
      name: i.name,
      val: i.hits / i.hitsMax,
      border: isBorderPos(i.pos) ? 1 : 0
    });
  }
  r.sort(function(e, r) {
    if (e.border !== r.border) return e.border - r.border;
    return e.val - r.val;
  });
  return r;
}

function compactHealQueue(e) {
  var r = [];
  for (var t = 0; t < e.length; t++) {
    var a = e[t];
    r.push([ a.name, a.val, a.border ]);
  }
  return r;
}

function writeHealQueue(e, r, t) {
  var a = buildHealQueue(t);
  if (r) {
    r.healQueue = a;
    r.healQueueTick = Game.time;
  }
  var i = Memory.repairPlan && Memory.repairPlan[e];
  if (i) {
    i.hq = compactHealQueue(a);
    i.hqt = Game.time;
  }
  return a;
}

function buildTowerQueue(e, r) {
  var t = [];
  for (var a = 0; a < e.length; a++) {
    var i = e[a];
    var n = i.type === STRUCTURE_WALL || i.type === STRUCTURE_RAMPART;
    if (!r) {
      if (i.source !== "tower" && i.source !== "both") continue;
      if (n && i.source !== "tower") continue;
    }
    if (!n && i.source !== "tower" && i.source !== "both") continue;
    var o = towerRepairTarget(i);
    if (o > 0 && i.hits >= o) continue;
    var s = r ? maxHealTowerPriority(i) : towerPriority(i);
    t.push({
      id: i.id,
      pri: s,
      val: i.hits,
      border: i.x === 0 || i.x === 49 || i.y === 0 || i.y === 49 ? 1 : 0,
      target: o
    });
  }
  t.sort(function(e, r) {
    if (e.pri !== r.pri) return e.pri - r.pri;
    if (e.border !== r.border) return e.border - r.border;
    return e.val - r.val;
  });
  return t;
}

function maxHealTowerPriority(e) {
  if (e.type === STRUCTURE_CONTAINER) return 1;
  if (e.type === STRUCTURE_ROAD) return 2;
  if (e.type === STRUCTURE_RAMPART && e.criticalRampart) return 3;
  if (e.type === STRUCTURE_RAMPART) return 4;
  if (e.type === STRUCTURE_WALL) return 5;
  return 6;
}

function compactTowerQueue(e) {
  var r = [];
  var t = Math.min(e.length, MAX_SERIALIZED_TOWER_QUEUE);
  for (var a = 0; a < t; a++) {
    var i = e[a];
    r.push([ i.id, i.pri, i.val, i.border, i.target ]);
  }
  return r;
}

function compactRequests(e) {
  var r = [];
  for (var t = 0; t < e.length; t++) {
    var a = e[t];
    r.push({
      k: a.kind,
      p: a.priority,
      t: a.tier || 0,
      c: a.bodyCost,
      n: a.count,
      w: a.totalWork || 0
    });
  }
  return r;
}

function compactNukePlan(e) {
  if (!e || !e.active) return null;
  var r = [];
  for (var t = 0; t < e.tiers.length; t++) {
    var a = e.tiers[t];
    r.push([ a.tier, a.targets.length, a.totalWork ]);
  }
  return {
    a: 1,
    e: e.eta,
    l: e.landingTick,
    ts: r
  };
}

function compactPlan(e) {
  return {
    t: e.tick,
    c: e.cadence,
    rt: e.repairTier,
    s: {
      th: e.stats.totalHits,
      tw: e.stats.towerHits,
      ch: e.stats.creepHits,
      mh: e.stats.maxSingleHits,
      n: e.stats.structureCount
    },
    tq: compactTowerQueue(e.towerQueue),
    hq: compactHealQueue(e.healQueue || []),
    hqt: e.healQueueTick || e.tick,
    w: e.workList ? e.workList.length : 0,
    mw: e.maintenanceItems ? e.maintenanceItems.length : 0,
    a: e.assignments || {},
    tp: {
      l: e.towerPolicy && e.towerPolicy.repairTowerLimit,
      r: e.towerPolicy && e.towerPolicy.reservePerTower,
      m: e.towerPolicy && e.towerPolicy.maxHeal ? 1 : 0,
      s: e.towerPolicy && e.towerPolicy.spreadTargets ? 1 : 0
    },
    n: compactNukePlan(e.nukePlan),
    m: e.medianRequests ? e.medianRequests.length : 0,
    rq: compactRequests(e.requests || [])
  };
}

function writePlan(e, r) {
  global._repairPlanCache[e] = r;
  Memory.repairPlan[e] = compactPlan(r);
}

function planTick(e) {
  return e ? e.tick || e.t || 0 : 0;
}

function isCompactPlan(e) {
  return !!(e && e.t !== undefined && e.s && e.tq !== undefined);
}

function getNukes(e) {
  try {
    return e.find(FIND_NUKES) || [];
  } catch (e) {
    return [];
  }
}

function nukeDamageAt(e, r) {
  var t = 0;
  var a = null;
  for (var i = 0; i < e.length; i++) {
    var n = e[i];
    var o = Math.max(Math.abs(n.pos.x - r.x), Math.abs(n.pos.y - r.y));
    if (o === 0) t += NUKE_GROUND_ZERO_DAMAGE; else if (o <= 2) t += NUKE_SPLASH_DAMAGE; else continue;
    if (a === null || n.timeToLand < a) a = n.timeToLand;
  }
  return {
    damage: t,
    eta: a
  };
}

function isProtectedNukeStructure(e, r) {
  if (!e || !NUKE_TIER_BY_TYPE[e.structureType]) return false;
  if (e.structureType === STRUCTURE_CONTAINER && isMineralContainer(e, r)) return false;
  return true;
}

function findRampartAt(e, r) {
  var t = r.structuresByType && r.structuresByType[STRUCTURE_RAMPART] || [];
  for (var a = 0; a < t.length; a++) {
    var i = t[a];
    if (i && i.pos.x === e.x && i.pos.y === e.y && i.pos.roomName === e.roomName) return i;
  }
  return null;
}

function buildNukePlan(e, r) {
  var t = Game.rooms[e];
  if (!t) return {
    active: false,
    tiers: []
  };
  var a = getNukes(t);
  if (!a.length) return {
    active: false,
    tiers: []
  };
  var i = {};
  var n = null;
  var o = r.structuresByType || {};
  function addTarget(e, r, t, a) {
    if (!i[e]) i[e] = {
      tier: e,
      name: NUKE_TIER_NAMES[e],
      totalWork: 0,
      targets: []
    };
    var n = typeof r.hits === "number" ? r.hits : 0;
    var o = Math.max(0, t - n);
    if (o <= 0) return;
    i[e].targets.push({
      id: r.id,
      x: r.pos.x,
      y: r.pos.y,
      type: r.structureType,
      currentHits: n,
      targetHits: t,
      reason: a
    });
    i[e].totalWork += o;
  }
  for (var s in o) {
    var u = o[s] || [];
    for (var l = 0; l < u.length; l++) {
      var R = u[l];
      if (!R || !R.pos) continue;
      var m = nukeDamageAt(a, R.pos);
      if (m.damage <= 0) continue;
      if (n === null || m.eta < n) n = m.eta;
      if (isProtectedNukeStructure(R, r)) {
        var c = NUKE_TIER_BY_TYPE[R.structureType];
        var p = findRampartAt(R.pos, r);
        var f = m.damage + NUKE_SAFETY_MARGIN;
        if (p) addTarget(c, p, f, m.damage >= NUKE_GROUND_ZERO_DAMAGE ? "direct" : "splash"); else if (c <= 4) {
          i[c] = i[c] || {
            tier: c,
            name: NUKE_TIER_NAMES[c],
            totalWork: 0,
            targets: []
          };
          i[c].targets.push({
            id: null,
            x: R.pos.x,
            y: R.pos.y,
            type: STRUCTURE_RAMPART,
            currentHits: 0,
            targetHits: f,
            reason: "buildRampart"
          });
          i[c].totalWork += f;
        }
      } else if (R.structureType === STRUCTURE_WALL) {
        addTarget(6, R, m.damage + NUKE_SAFETY_MARGIN, m.damage >= NUKE_GROUND_ZERO_DAMAGE ? "direct-wall" : "splash-wall");
      } else if (R.structureType === STRUCTURE_RAMPART && isPerimeter(R.pos)) {
        addTarget(6, R, m.damage + NUKE_SAFETY_MARGIN, m.damage >= NUKE_GROUND_ZERO_DAMAGE ? "direct-barrier" : "splash-barrier");
      }
    }
  }
  var T = [];
  for (var E in i) T.push(i[E]);
  T.sort(function(e, r) {
    return e.tier - r.tier;
  });
  return {
    active: T.length > 0,
    eta: n,
    landingTick: n === null ? null : Game.time + n,
    tiers: T
  };
}

function computeStats(e) {
  var r = 0, t = 0, a = 0, i = 0;
  for (var n = 0; n < e.length; n++) {
    var o = e[n].deficit || 0;
    r += o;
    if (o > i) i = o;
    if (e[n].source === "tower") t += o; else if (e[n].source === "creep") a += o; else if (e[n].source === "both") {
      t += Math.min(o, Math.max(0, e[n].towerCap - e[n].hits));
      a += o;
    }
  }
  return {
    totalHits: r,
    towerHits: t,
    creepHits: a,
    maxSingleHits: i,
    structureCount: e.length
  };
}

function buildRequestPreview(e, r, t, a, i, n, o, s, u) {
  var l = r.energyCapacityAvailable || r.energyAvailable || BODY_MIN_COST;
  var R = [];
  if (i && i.active) {
    var m = 0;
    for (var c = 0; c < i.tiers.length && m < MAX_PARALLEL_REPAIRERS; c++) {
      var p = i.tiers[c];
      if (!p.targets.length) continue;
      var f = sizeDispatch({
        totalHits: p.totalWork,
        maxSingleHits: p.totalWork,
        availableEnergy: l,
        movementProfile: "mixed",
        urgency: 1,
        towerFraction: 0
      });
      R.push({
        kind: "nuke",
        priority: 5,
        tier: p.tier,
        bodyCost: f.cost,
        count: Math.min(f.count, MAX_PARALLEL_REPAIRERS - m),
        totalWork: p.totalWork
      });
      m += R[R.length - 1].count;
    }
    return R;
  }
  var T = n === "PEACE" ? MIN_PEACE_REPAIR_CREEP_HITS : 1;
  var E = s ? sortRepairItems(t, s).length > 0 : a.creepHits >= T;
  if (a.creepHits >= T || s && E || u && u.length > 0) {
    var v = sizeDispatch({
      totalHits: a.creepHits,
      maxSingleHits: a.maxSingleHits,
      availableEnergy: l,
      movementProfile: "mixed",
      urgency: .4,
      towerFraction: 0
    });
    R.push({
      kind: "baseline",
      priority: 6,
      bodyCost: v.cost,
      count: 1,
      totalWork: a.creepHits
    });
    var _ = desiredRepairerCount({
      repairTier: n,
      maxHeal: s
    });
    var g = Math.max(0, _ - 1);
    if (g > 0) R.push({
      kind: "extra",
      priority: 7,
      bodyCost: v.cost,
      count: g,
      totalWork: a.creepHits,
      blockedIfStorageBelow: EXTRA_REPAIR_STORAGE_MIN
    });
  }
  return R;
}

function isRepairerRetiring(e) {
  return !!(e && !e.spawning && typeof e.ticksToLive === "number" && e.ticksToLive <= REPAIRER_REPLACEMENT_TTL);
}

function repairerSpawnPhase(e) {
  var r = 0;
  e = String(e || "");
  for (var t = 0; t < e.length; t++) {
    r = r * 31 + e.charCodeAt(t) >>> 0;
  }
  return r % REPAIR_SPAWN_INTERVAL_TICKS;
}

function shouldAttemptRepairerSpawn(e) {
  return Game.time % REPAIR_SPAWN_INTERVAL_TICKS === repairerSpawnPhase(e);
}

function repairerBelongsToRoom(e, r) {
  if (!e || !e.memory || !REPAIRER_ROLES[e.memory.role]) return false;
  var t = e.memory.homeRoom || e.memory.assignedRoom || null;
  if (e.memory.role === "repairer") return t === r;
  return (t || e.room && e.room.name) === r;
}

function getRepairers(e) {
  var r = [];
  var t = getRoomState.creepIndex();
  var a = t && t.all ? t.all : [];
  for (var i = 0; i < a.length; i++) {
    var n = a[i];
    if (repairerBelongsToRoom(n, e)) r.push(n);
  }
  return r;
}

function getRepairerOccupancy(e) {
  // Called three times per room per tick (deficit probe, outage probe, request
  // writer) and each call walks the whole creep index. Spawn state cannot
  // change mid-tick, so one pass per room per tick is equivalent.
  var _c = global._repairOccupancyCache;
  if (!_c || _c.tick !== Game.time) {
    _c = {
      tick: Game.time,
      rooms: {}
    };
    global._repairOccupancyCache = _c;
  }
  if (_c.rooms[e]) return _c.rooms[e];
  var r = {};
  var t = {};
  var a = {};
  var i = getRoomState.creepIndex();
  var n = i && i.all ? i.all : [];
  for (var o = 0; o < n.length; o++) {
    var s = n[o];
    if (!repairerBelongsToRoom(s, e)) continue;
    r[s.name] = true;
    if (s.spawning) t[s.name] = true;
    if (isRepairerRetiring(s)) a[s.name] = true;
  }
  var u = getRoomState.get(e);
  var l = u && u.structuresByType && u.structuresByType[STRUCTURE_SPAWN] || [];
  for (var R = 0; R < l.length; R++) {
    var m = l[R];
    if (!m || !m.my || !m.spawning) continue;
    var c = m.spawning.name;
    var p = Memory.creeps && Memory.creeps[c];
    if (!p || !REPAIRER_ROLES[p.role]) continue;
    var f = p.homeRoom || p.assignedRoom || null;
    if (f !== e) continue;
    r[c] = true;
    t[c] = true;
  }
  return _c.rooms[e] = {
    total: Object.keys(r).length,
    spawning: Object.keys(t).length,
    retiring: Object.keys(a).length
  };
}

function getPendingRepairerCount(e) {
  var r = Memory.repairSpawnRequests && Memory.repairSpawnRequests[e] || [];
  var t = 0;
  for (var a = 0; a < r.length; a++) if (!r[a].spawned && !r[a].s) t++;
  return t;
}

// Single source of truth for "does this room have repair work?". The request
// writer, the cache-bypass check and the compact-plan reader all route through
// here; a bypass check that omitted medianRequests/nukePlan could not see work
// the request writer acted on, so plans went stale for a whole cadence.
function repairWorkPresent(e) {
  var r = (e.repairTier || "PEACE") === "PEACE" ? MIN_PEACE_REPAIR_CREEP_HITS : 1;
  return !!((e.creepHits || 0) >= r || e.nukeActive || (e.medianCount || 0) > 0 || e.maxHealWork || (e.maintenanceCount || 0) > 0);
}

function planHasRepairWork(e) {
  if (!e) return false;
  if (e.stats) {
    return repairWorkPresent({
      repairTier: e.repairTier,
      creepHits: e.stats.creepHits,
      nukeActive: !!(e.nukePlan && e.nukePlan.active),
      medianCount: e.medianRequests ? e.medianRequests.length : 0,
      maxHealWork: !!(e.maxHeal && sortRepairItems(e.items || [], e.maxHeal).length > 0),
      maintenanceCount: e.maintenanceItems ? e.maintenanceItems.length : 0
    });
  }
  if (!e.s) return false;
  return repairWorkPresent({
    repairTier: e.rt,
    creepHits: e.s.ch,
    nukeActive: !!(e.n && e.n.a),
    medianCount: e.m,
    maxHealWork: !!(e.tp && e.tp.m) && e.w > 0,
    maintenanceCount: e.mw
  });
}

function hasUncoveredRepairerDeficit(e, r) {
  if (!planHasRepairWork(r)) return false;
  var t = desiredRepairerCount(r);
  var a = getRepairerOccupancy(e);
  return a.total + getPendingRepairerCount(e) < t;
}

// A room with no work legitimately holds zero repairers, which at the cache
// layer is indistinguishable from a stale plan wrongly reporting no work.
// Re-derive from live structures on a phase-staggered interval whenever a room
// is completely uncovered, bounding an outage to this many ticks rather than a
// full peacetime cadence.
function hasRepairerOutage(e) {
  if (getPendingRepairerCount(e) > 0) return false;
  if (getRepairerOccupancy(e).total > 0) return false;
  return Game.time % REPAIRER_OUTAGE_RECHECK_TICKS === repairerSpawnPhase(e);
}

function isRoadOrContainer(e) {
  return e.type === STRUCTURE_ROAD || e.type === STRUCTURE_CONTAINER;
}

function sortRepairItems(e, r) {
  var t = [];
  for (var a = 0; a < e.length; a++) {
    var i = e[a];
    if (r) {
      if (!isRoadOrContainer(i)) t.push(i);
    } else if (i.source === "creep" || i.source === "both") t.push(i);
  }
  t.sort(function(e, r) {
    if (!!e.maintenance !== !!r.maintenance) return e.maintenance ? 1 : -1;
    var t = Math.floor(e.x / 10) * 10 + Math.floor(e.y / 10);
    var a = Math.floor(r.x / 10) * 10 + Math.floor(r.y / 10);
    if (t !== a) return t - a;
    if (e.type !== r.type) return e.type < r.type ? -1 : 1;
    return e.hits - r.hits;
  });
  return t;
}

function filterRepairItems(e, r, t) {
  var a = [];
  for (var i = 0; i < e.length; i++) {
    var n = e[i];
    if (!n) continue;
    if (t) {
      if (!isRoadOrContainer(n) && r(n)) a.push(n);
    } else if ((n.source === "creep" || n.source === "both") && r(n)) a.push(n);
  }
  return sortRepairItems(a, t);
}

function isWallOrRampart(e) {
  return e && (e.type === STRUCTURE_WALL || e.type === STRUCTURE_RAMPART);
}

function shardItems(e, r, t) {
  var a = [];
  for (var i = 0; i < e.length; i++) {
    if (i % t !== r) continue;
    a.push(e[i].id);
  }
  return {
    structureIds: a
  };
}

function hasImminentCollapse(e, r) {
  for (var t = 0; t < e.length; t++) {
    var a = e[t];
    if (!a) continue;
    if (a.type === STRUCTURE_ROAD && typeof a.hitsMax === "number") {
      if (a.hits < a.hitsMax * ROAD_EMERGENCY_FRACTION) return true;
      continue;
    }
    if (a.type === STRUCTURE_CONTAINER) {
      if (a.hits < Math.floor(25e4 * CONTAINER_EMERGENCY_FRACTION)) return true;
      continue;
    }
    if (r < 7) continue;
    if (a.type === STRUCTURE_WALL) {
      if (a.hits < WALL_EMERGENCY_HITS) return true;
      continue;
    }
    if (a.type === STRUCTURE_RAMPART) {
      var i = a.criticalRampart ? CRITICAL_RAMPART_EMERGENCY_HITS : RAMPART_EMERGENCY_HITS;
      if (a.hits < i) return true;
    }
  }
  return false;
}

function isPeacetimeEmergencyItem(e, r) {
  if (!e) return false;
  if (e.type === STRUCTURE_ROAD || e.type === STRUCTURE_CONTAINER) {
    return !!e.hitsMax && e.hits <= e.hitsMax * PEACETIME_EMERGENCY_FRACTION;
  }
  if (r < 7) return false;
  if (e.type === STRUCTURE_WALL) return e.hits < WALL_EMERGENCY_HITS;
  if (e.type === STRUCTURE_RAMPART) {
    var t = e.criticalRampart ? CRITICAL_RAMPART_EMERGENCY_HITS : RAMPART_EMERGENCY_HITS;
    return e.hits < t;
  }
  return false;
}

function breachCpuNow() {
  return Game.cpu && typeof Game.cpu.getUsed === "function" ? Game.cpu.getUsed() : 0;
}

function finishBreachResult(e, r) {
  e.cpuUsed = Math.max(0, breachCpuNow() - r);
  return e;
}

function isRoomPerimeterBreached(e, r, t) {
  var a = breachCpuNow();
  if (t < BREACH_MIN_RCL) return finishBreachResult({
    breached: false,
    skipped: "rcl",
    seedCount: 0,
    nodesVisited: 0
  }, a);
  if (r && r.controller && r.controller.safeMode) return finishBreachResult({
    breached: false,
    skipped: "safeMode",
    seedCount: 0,
    nodesVisited: 0
  }, a);
  var i = r && r.structuresByType || {};
  var n = i[STRUCTURE_WALL] || [];
  var o = i[STRUCTURE_RAMPART] || [];
  if (!n.length && !o.length) return finishBreachResult({
    breached: false,
    skipped: "noBarrier",
    seedCount: 0,
    nodesVisited: 0
  }, a);

  var s = {};
  var u = {};
  var l = typeof OBSTACLE_OBJECT_TYPES === "undefined" ? [] : OBSTACLE_OBJECT_TYPES;
  for (var R = 0; R < l.length; R++) u[l[R]] = true;
  for (var m in i) {
    if (!i.hasOwnProperty(m)) continue;
    var c = i[m] || [];
    for (var p = 0; p < c.length; p++) {
      var f = c[p];
      if (!f || !f.pos) continue;
      var T = f.pos.x;
      var E = f.pos.y;
      if (T < 0 || T >= 50 || E < 0 || E >= 50) continue;
      var v = f.structureType || m;
      var _ = v === STRUCTURE_WALL;
      if (v === STRUCTURE_RAMPART) _ = f.my === true && f.isPublic !== true; else if (v !== STRUCTURE_ROAD && v !== STRUCTURE_CONTAINER && u[v]) _ = true;
      if (_) s[E * 50 + T] = 1;
    }
  }

  bfsStamp++;
  if (bfsStamp > 4294967295) {
    bfsVisited.fill(0);
    bfsStamp = 1;
  }
  var g = null;
  function isTerrainWall(x, y) {
    if (!g) g = Game.map.getRoomTerrain(e);
    return !!(g && g.get && (g.get(x, y) & TERRAIN_MASK_WALL));
  }
  var dX = [ -1, 0, 1, -1, 1, -1, 0, 1 ];
  var dY = [ -1, -1, -1, 0, 0, 1, 1, 1 ];
  var A = 0;
  var y = 0;
  var h = 0;
  var M = 0;
  for (var P = 0; P < CORE_PROTECTED_STRUCTURE_TYPES.length; P++) {
    var C = i[CORE_PROTECTED_STRUCTURE_TYPES[P]] || [];
    for (var I = 0; I < C.length; I++) {
      var S = C[I];
      if (!S || !S.pos) continue;
      for (var U = 0; U < dX.length; U++) {
        var N = S.pos.x + dX[U];
        var b = S.pos.y + dY[U];
        if (N < 0 || N >= 50 || b < 0 || b >= 50) continue;
        var w = b * 50 + N;
        if (bfsVisited[w] === bfsStamp || s[w]) continue;
        if (isTerrainWall(N, b)) continue;
        bfsVisited[w] = bfsStamp;
        bfsQueue[y++] = w;
        A++;
        M++;
        if (N === 0 || N === 49 || b === 0 || b === 49) return finishBreachResult({
          breached: true,
          x: N,
          y: b,
          seedCount: A,
          nodesVisited: M
        }, a);
      }
    }
  }
  var H = 0;
  while (H < y) {
    if (M >= BREACH_MAX_NODES) return finishBreachResult({
      breached: false,
      truncated: true,
      seedCount: A,
      nodesVisited: M
    }, a);
    var V = bfsQueue[H++];
    var O = V % 50;
    var k = (V / 50) | 0;
    for (var x = 0; x < dX.length; x++) {
      var q = O + dX[x];
      var L = k + dY[x];
      if (q < 0 || q >= 50 || L < 0 || L >= 50) continue;
      var B = L * 50 + q;
      if (bfsVisited[B] === bfsStamp || s[B]) continue;
      if (isTerrainWall(q, L)) continue;
      bfsVisited[B] = bfsStamp;
      bfsQueue[y++] = B;
      M++;
      if (q === 0 || q === 49 || L === 0 || L === 49) return finishBreachResult({
        breached: true,
        x: q,
        y: L,
        seedCount: A,
        nodesVisited: M
      }, a);
    }
  }
  return finishBreachResult({
    breached: false,
    seedCount: A,
    nodesVisited: M
  }, a);
}

function getBreachState(e, r, t) {
  if (!global._repairBreachCache) global._repairBreachCache = {};
  var a = global._repairBreachCache[e];
  if (a && Game.time - a.tick < BREACH_RECHECK_TICKS) return a;
  var i = isRoomPerimeterBreached(e, r, t);
  a = {
    tick: Game.time,
    breached: !!i.breached,
    x: i.x,
    y: i.y,
    skipped: i.skipped,
    truncated: !!i.truncated,
    seedCount: i.seedCount || 0,
    nodesVisited: i.nodesVisited || 0,
    cpuUsed: i.cpuUsed || 0
  };
  global._repairBreachCache[e] = a;
  return a;
}

function hasPeacetimeEmergency(e, r, t, a, s) {
  var i = roomMem(e, a);
  var n = i.peaceEmergencyUntil || 0;
  var o = i.breachEmergencyUntil || 0;
  var found = false;
  for (var u = 0; u < r.length; u++) {
    if (isPeacetimeEmergencyItem(r[u], t)) {
      found = true;
      break;
    }
  }
  if (found) {
    if (!a) i.peaceEmergencyUntil = Game.time + PEACETIME_EMERGENCY_TICKS;
    return true;
  }
  var l = getBreachState(e, s, t);
  if (l.breached) {
    if (!a) i.breachEmergencyUntil = Game.time + PEACETIME_EMERGENCY_TICKS;
    return true;
  }
  if (n && Game.time < n) return true;
  if (n && !a) delete i.peaceEmergencyUntil;
  if (o && Game.time < o) return true;
  if (o && !a) delete i.breachEmergencyUntil;
  return false;
}

function classifyRepairTier(e, r, t, a, i, n, o, s) {
  var u = hasImminentCollapse(a, t);
  if (n && n.active) return "WAR_EMERGENCY";
  if (i) return u ? "WAR_EMERGENCY" : "WAR";
  if (hasPeacetimeEmergency(e, a, t, s, r)) return "PEACE_EMERGENCY";
  return "PEACE";
}

function shouldBypassPlanCache(e, r, t, a, i, n, o2) {
  var o = roomMem(e, a);
  if (o.peaceEmergencyUntil && Game.time < o.peaceEmergencyUntil) return true;
  var priorBreach = global._repairBreachCache && global._repairBreachCache[e];
  var breachState = getBreachState(e, r, t);
  if (breachState.breached && (!priorBreach || !priorBreach.breached)) return true;
  var s = r && r.structuresByType;
  if (!s) return false;
  var S = repairItemSet(e, r, t, a);
  var u = S.items;
  for (var l = 0; l < u.length; l++) {
    if (isPeacetimeEmergencyItem(u[l], t)) return true;
  }
  var R = S.stats;
  var m = i && (i.repairTier || i.rt) || "PEACE";
  var p = S.maintenance;
  var c = Memory.defense && Memory.defense.repairOrders && Memory.defense.repairOrders[e] || [];
  var f = repairWorkPresent({
    repairTier: m,
    creepHits: R.creepHits,
    nukeActive: !!(o2 && o2.active),
    medianCount: c.length,
    maxHealWork: !!(n && sortRepairItems(u, n).length > 0),
    maintenanceCount: p.length
  });
  return f !== planHasRepairWork(i);
}

function buildTargetTask(e, r, t, a, i) {
  var n = shardItems(sortRepairItems(r, i), t, a);
  return {
    k: "target",
    r: e,
    i: n.structureIds
  };
}

function buildWallsTask(e, r, t, a, i) {
  var n = filterRepairItems(r, isWallOrRampart, i);
  var o = shardItems(n, t, a);
  return {
    k: "walls",
    r: e,
    i: o.structureIds
  };
}

function buildRepairTaskForSlot(e, r, t, a, i) {
  if (a <= 1) return buildTargetTask(e, r, 0, 1, i);
  if (t === 0) return buildTargetTask(e, r, 0, 1, i);
  if (t === 1) return buildWallsTask(e, r, 0, 1, i);
  var n = Math.max(1, a - 1);
  var o = t > 1 ? t - 1 : 0;
  return buildWallsTask(e, r, o, n, i);
}

function collectNukeTargets(e, r) {
  var t = [];
  if (!e || !e.active) return t;
  for (var a = 0; a < e.tiers.length; a++) {
    var i = e.tiers[a];
    if (r && i.tier > r) continue;
    for (var n = 0; n < i.targets.length; n++) {
      var o = i.targets[n];
      if (!o.id) continue;
      t.push({
        id: o.id,
        type: o.type,
        tier: i.tier,
        hits: o.currentHits,
        target: o.targetHits,
        x: o.x,
        y: o.y
      });
    }
  }
  t.sort(function(e, r) {
    if (e.tier !== r.tier) return e.tier - r.tier;
    var t = e.target > 0 ? e.hits / e.target : 1;
    var a = r.target > 0 ? r.hits / r.target : 1;
    return t - a;
  });
  return t;
}

function buildNukeTask(e, r, t, a) {
  var i = collectNukeTargets(r);
  var n = [];
  for (var o = 0; o < i.length; o++) {
    if (o % a !== t) continue;
    n.push(i[o].id);
  }
  return {
    k: "nuke",
    r: e,
    i: n
  };
}

function buildMedianTask(e, r) {
  return {
    k: "median",
    r: e,
    c: r || []
  };
}

function adoptUnanchoredRepairers() {
  var e = getRoomState.creepIndex();
  var r = e && e.all ? e.all : [];
  for (var t = 0; t < r.length; t++) {
    var a = r[t];
    if (!a || !a.memory || a.memory.role !== "repairer") continue;
    if (a.memory.homeRoom || a.memory.assignedRoom) continue;
    a.memory.homeRoom = a.room.name;
    a.memory.assignedRoom = a.room.name;
    console.log("[RepairManager] Adopted unanchored repairer " + a.name + " into " + a.room.name);
  }
}

function taskSize(e) {
  if (!e) return 0;
  if (e.i) return e.i.length + (e.s && e.s.length || 0);
  if (e.structureIds) return e.structureIds.length;
  if (e.c) return e.c.length;
  if (e.clusterIds) return e.clusterIds.length;
  return 0;
}

function taskKind(e) {
  return e ? e.k || e.kind : null;
}

function isWarAssignmentMode(e) {
  return !!(e && (e.nukePlan && e.nukePlan.active || e.repairTier === "WAR" || e.repairTier === "WAR_EMERGENCY"));
}

function assignmentLimitForItem(e, r) {
  if (!r) return 1;
  if (!e) return 1;
  if (e.type === STRUCTURE_RAMPART && (e.criticalRampart || e.nukeTier <= 2)) return MAX_PARALLEL_REPAIRERS;
  if (e.type === STRUCTURE_RAMPART || e.type === STRUCTURE_CONTAINER) return 2;
  return 1;
}

function assignmentPriority(e, r) {
  if (!e) return 99;
  if (e.maintenance) return 60;
  if (e.nukeTier) return e.nukeTier;
  var t = isWarAssignmentMode(r);
  if (t) {
    if (e.type === STRUCTURE_RAMPART && e.criticalRampart) return 10;
    if (e.type === STRUCTURE_WALL || e.type === STRUCTURE_RAMPART) return 20;
    if (e.type === STRUCTURE_CONTAINER) return 30;
    if (e.type === STRUCTURE_ROAD) return 40;
    return 50;
  }
  if (e.type === STRUCTURE_CONTAINER) return 10;
  if (e.type === STRUCTURE_ROAD) return 20;
  if (e.type === STRUCTURE_RAMPART && e.criticalRampart) return 30;
  if (e.type === STRUCTURE_WALL || e.type === STRUCTURE_RAMPART) return 40;
  return 50;
}

function buildAssignmentWorkList(e) {
  var r = [];
  if (e.nukePlan && e.nukePlan.active) {
    var t = collectNukeTargets(e.nukePlan);
    for (var a = 0; a < t.length; a++) {
      var i = t[a];
      if (!i.id) continue;
      r.push({
        id: i.id,
        type: i.type || STRUCTURE_RAMPART,
        x: i.x,
        y: i.y,
        hits: i.hits,
        target: i.target,
        deficit: Math.max(0, i.target - i.hits),
        nukeTier: i.tier,
        source: "creep",
        criticalRampart: i.tier <= 2
      });
    }
  } else {
    for (var n = 0; n < e.items.length; n++) {
      var o = e.items[n];
      if (!o) continue;
      if (e.maxHeal) {
        if (isRoadOrContainer(o)) continue;
      } else if (o.source !== "creep" && o.source !== "both") continue;
      r.push(o);
    }
    var s = e.maintenanceItems || [];
    for (var u = 0; u < s.length; u++) {
      if (s[u]) r.push(s[u]);
    }
  }
  r.sort(function(r, t) {
    var a = assignmentPriority(r, e);
    var i = assignmentPriority(t, e);
    if (a !== i) return a - i;
    var n = r.target > 0 ? (r.hits || 0) / r.target : 1;
    var o = t.target > 0 ? (t.hits || 0) / t.target : 1;
    if (n !== o) return n - o;
    if ((r.deficit || 0) !== (t.deficit || 0)) return (t.deficit || 0) - (r.deficit || 0);
    return (r.hits || 0) - (t.hits || 0);
  });
  return r;
}

function indexItemsById(e) {
  var r = {};
  for (var t = 0; t < e.length; t++) r[e[t].id] = e[t];
  return r;
}

function clearCreepAssignment(e, r) {
  if (e && e.memory) {
    delete e.memory.task;
    delete e.memory.targetId;
    delete e.memory.route;
    delete e.memory.releaseRepairTarget;
    delete e.memory.repairMaintenance;
  }
  if (r && e) delete r[e.name];
}

function assignmentRoute(e, r) {
  if (r && r.memory && r.memory.route && r.memory.route.length) return r.memory.route;
  return e && e.r || [];
}

function assignmentHead(e, r) {
  if (!e) return null;
  if (e.k === "r") {
    var t = assignmentRoute(e, r);
    return t.length ? t[0] : null;
  }
  return e.i || null;
}

function isAssignmentValid(e, r, t, a) {
  if (!e || !t || !t.memory) return false;
  if (!t.memory.targetId) return false;
  var i = assignmentHead(e, t);
  if (!i || t.memory.targetId !== i) return false;
  if (e.k === "r") {
    var n = assignmentRoute(e, t);
    for (var o = 0; o < n.length; o++) {
      var s = r[n[o]];
      if (s && s.type === STRUCTURE_ROAD) return true;
    }
    return false;
  }
  var u = r[e.i];
  if (!u) return false;
  if (!!e.m !== !!u.maintenance) return false;
  if (u.type === STRUCTURE_WALL || u.type === STRUCTURE_RAMPART) return true;
  return u.hits < u.target || a;
}

function countAssignedItems(e, r) {
  var t = {};
  for (var a in e) {
    var i = e[a];
    if (!i) continue;
    if (i.k === "r") {
      var n = i.r || [];
      for (var o = 0; o < n.length; o++) if (r[n[o]]) t[n[o]] = (t[n[o]] || 0) + 1;
    } else if (i.i && r[i.i]) t[i.i] = (t[i.i] || 0) + 1;
  }
  return t;
}

function findNextAssignment(e, r, t, a) {
  for (var i = 0; i < r.length; i++) {
    var n = r[i];
    if (!n) continue;
    if ((t[n.id] || 0) >= assignmentLimitForItem(n, a)) continue;
    return {
      k: "s",
      i: n.id,
      m: n.maintenance ? 1 : 0
    };
  }
  return null;
}

function applyAssignment(e, r, t) {
  delete e.memory.task;
  delete e.memory.releaseRepairTarget;
  if (!r) return clearCreepAssignment(e, t);
  if (r.k === "r") {
    e.memory.route = r.r || [];
    e.memory.targetId = e.memory.route[0] || r.i || null;
    t[e.name] = {
      k: "r",
      i: e.memory.targetId,
      r: e.memory.route
    };
  } else {
    delete e.memory.route;
    e.memory.targetId = r.i;
    if (r.m) e.memory.repairMaintenance = 1; else delete e.memory.repairMaintenance;
    t[e.name] = {
      k: "s",
      i: r.i,
      m: r.m ? 1 : 0
    };
  }
}

function compactTask(e) {
  if (!e) return e;
  var r = e.k || e.kind;
  if (r === "median") return buildMedianTask(e.homeRoom || e.r, e.clusterIds || e.c || []);
  var t = e.structureIds || e.i || [];
  if (r === "nuke") return {
    k: "nuke",
    r: e.homeRoom || e.r,
    i: t
  };
  if (r === "walls") return {
    k: "walls",
    r: e.homeRoom || e.r,
    i: t
  };
  if (r === "roads-first") return {
    k: "roads-first",
    r: e.homeRoom || e.r,
    i: t,
    s: e.secondaryIds || e.s || []
  };
  return {
    k: "target",
    r: e.homeRoom || e.r,
    i: t
  };
}

function compactLiveRepairMemory() {
  var e = 0;
  var r = getRoomState.creepIndex();
  var t = r && r.all ? r.all : [];
  for (var a = 0; a < t.length; a++) {
    var i = t[a];
    if (!i.memory || !REPAIRER_ROLES[i.memory.role] || !i.memory.task) continue;
    i.memory.task = compactTask(i.memory.task);
    e++;
  }
  var n = 0;
  if (Memory.repairSpawnRequests) {
    for (var o in Memory.repairSpawnRequests) {
      var s = Memory.repairSpawnRequests[o] || [];
      for (var a = 0; a < s.length; a++) {
        if (s[a].task) s[a].task = compactTask(s[a].task);
        if (s[a].body && !s[a].b) {
          s[a].b = compactBody(s[a].body);
          delete s[a].body;
        }
        if (typeof s[a].at !== "number") {
          if (typeof s[a].createdAt === "number") s[a].at = s[a].createdAt; else if (typeof s[a].ct === "number") s[a].at = s[a].ct;
        }
        if (s[a].createdAt !== undefined) delete s[a].createdAt;
        if (typeof s[a].ct !== "number" && typeof s[a].at === "number") s[a].ct = s[a].at;
        if (s[a].homeRoom && !s[a].r) {
          s[a].r = s[a].homeRoom;
          delete s[a].homeRoom;
        }
        n++;
      }
    }
  }
  return {
    creeps: e,
    requests: n
  };
}

function desiredRepairerCount(e) {
  if (e && (e.maxHeal || e.tp && e.tp.m)) return 3;
  var r = e && (e.repairTier || e.rt) ? e.repairTier || e.rt : "PEACE";
  return Math.min(MAX_PARALLEL_REPAIRERS, REPAIR_TIERS[r] || 1);
}

function assignRepairerTargets(e, r) {
  global._repairAssignmentTick[e] = Game.time;
  var t = getRepairers(e);
  var a = Memory.repairPlan[e] || (Memory.repairPlan[e] = {});
  var i = a.a || a.assignments || {};
  var n = buildAssignmentWorkList(r);
  r.workList = n;
  if (!t.length) {
    a.a = {};
    r.assignments = {};
    return;
  }
  t.sort(function(e, r) {
    var t = e.memory && e.memory.role === "repairer" ? 1 : 0;
    var a = r.memory && r.memory.role === "repairer" ? 1 : 0;
    if (t !== a) return t - a;
    return e.name < r.name ? -1 : 1;
  });
  var o = indexItemsById(n);
  var s = {};
  var u = isWarAssignmentMode(r);
  for (var l = 0; l < t.length; l++) {
    var R = t[l];
    s[R.name] = true;
    if (R.memory.role === "repairer" && !R.memory.homeRoom && !R.memory.assignedRoom) {
      R.memory.homeRoom = e;
      R.memory.assignedRoom = e;
      console.log("[RepairManager] Adopted repairer " + R.name + " into " + e);
    }
  }
  for (var m in i) {
    if (!s[m] || !Game.creeps[m]) delete i[m];
  }
  for (var c = 0; c < t.length; c++) {
    var p = t[c];
    var f = i[p.name];
    var T = p.memory && p.memory.releaseRepairTarget;
    if (f && T && (f.i === T || f.r && f.r.indexOf(T) !== -1)) {
      clearCreepAssignment(p, i);
    } else if (f && isAssignmentValid(f, o, p, u)) {
      applyAssignment(p, f, i);
    } else {
      clearCreepAssignment(p, i);
    }
  }
  var E = countAssignedItems(i, o);
  for (var v = 0; v < t.length; v++) {
    var _ = t[v];
    if (i[_.name]) continue;
    var g = findNextAssignment(_, n, E, u);
    if (!g) {
      clearCreepAssignment(_, i);
      continue;
    }
    applyAssignment(_, g, i);
    if (g.k === "r") {
      for (var d = 0; d < g.r.length; d++) E[g.r[d]] = (E[g.r[d]] || 0) + 1;
    } else E[g.i] = (E[g.i] || 0) + 1;
  }
  a.a = i;
  r.assignments = i;
  r.workList = n;
}

function assignRepairerTasks(e, r) {
  assignRepairerTargets(e, r);
}

function ensureCreepAssignment(e) {
  if (!e || !e.memory) return null;
  var r = e.memory.homeRoom || e.memory.assignedRoom || e.room.name;
  var t = Game.rooms[r];
  if (!t || !t.controller || !t.controller.my) return null;
  if (global._repairAssignmentTick[r] !== Game.time) {
    var a = buildPlan(r, false);
    if (!a) return null;
    if (global._repairAssignmentTick[r] !== Game.time) assignRepairerTargets(r, a);
  }
  return e.memory.targetId || null;
}

function downsizeStalledRequest(e, r) {
  if (!r || typeof e.cost !== "number") return;
  if (Game.time - e.at < REPAIR_BODY_DOWNSIZE_AFTER_TICKS) return;
  var t = Math.min(r.energyCapacityAvailable || e.cost, BODY_MAX_COST);
  var a = Math.max(BODY_MIN_COST, Math.floor(t * REPAIR_BODY_MIN_CAPACITY_RATIO));
  var i = Math.max(a, r.energyAvailable || 0);
  if (i >= e.cost) return;
  var n = computeBody(i, "mixed");
  var o = bodyCost(n);
  if (o >= e.cost) return;
  e.b = compactBody(n);
  if (e.body) delete e.body;
  e.cost = o;
}

function writeSpawnRequests(e, r, t, a, fromCache) {
  if (!Memory.repairSpawnRequests) Memory.repairSpawnRequests = {};
  var i = Memory.repairSpawnRequests[e] || [];
  for (var n = i.length - 1; n >= 0; n--) {
    var o = i[n];
    if (!o || o.spawned || o.s) {
      i.splice(n, 1);
      continue;
    }
    if (o.task) o.task = compactTask(o.task);
    if (typeof o.at !== "number") {
      if (typeof o.createdAt === "number") o.at = o.createdAt; else if (typeof o.ct === "number") o.at = o.ct; else o.at = Game.time;
    }
    if (o.createdAt !== undefined) delete o.createdAt;
    o.ct = Game.time;
    downsizeStalledRequest(o, r);
  }
  var s = getRepairerOccupancy(e);
  var u = t.maxHeal;
  var R = u && sortRepairItems(t.items || [], u).length > 0;
  var m = t.maintenanceItems || [];
  var c = repairWorkPresent({
    repairTier: t.repairTier,
    creepHits: t.stats.creepHits,
    nukeActive: !!(t.nukePlan && t.nukePlan.active),
    medianCount: t.medianRequests ? t.medianRequests.length : 0,
    maxHealWork: !!R,
    maintenanceCount: m.length
  });
  if (!c) {
    // Only a freshly built plan may retire pending requests. A cached plan can
    // be a full cadence out of date, and wiping on its say-so resets request
    // age every tick -- which starves the spawn-phase age fallback and can
    // leave a room uncovered indefinitely.
    if (fromCache) return;
    Memory.repairSpawnRequests[e] = [];
    return;
  }
  var p = desiredRepairerCount(t);
  var f = Math.max(0, s.total - s.retiring);
  var T = Math.max(0, p - f);
  i.sort(function(e, r) {
    return (e.priority || 99) - (r.priority || 99);
  });
  if (i.length > T) i.splice(T);
  for (var E = 0; E < i.length; E++) {
    i[E].kind = E === 0 ? "baseline" : "extra";
    i[E].priority = t.nukePlan && t.nukePlan.active ? 5 : E === 0 ? 6 : 7;
    i[E].emergency = t.repairTier !== "PEACE" ? 1 : u ? 1 : 0;
    i[E].maxHeal = u ? 1 : 0;
  }
  var v = i.length;
  var _ = Math.max(0, T - v);
  Memory.repairSpawnRequests[e] = i;
  if (_ <= 0) return;
  var g = [];
  for (var d = 0; d < _; d++) {
    var A = f + v + d;
    var y = A === 0 ? "baseline" : "extra";
    var h = t.nukePlan && t.nukePlan.active ? 5 : y === "baseline" ? 6 : 7;
    var M = Math.max(t.stats.creepHits, 1);
    var P = Math.max(t.stats.maxSingleHits, 1);
    if (u) {
      var C = 0;
      var I = 0;
      for (var S = 0; S < t.items.length; S++) {
        var U = t.items[S];
        if (!U || typeof U.deficit !== "number") continue;
        C += U.deficit;
        if (U.deficit > I) I = U.deficit;
      }
      if (C > M) M = C;
      if (I > P) P = I;
    }
    var N = sizeDispatch({
      totalHits: M,
      maxSingleHits: P,
      availableEnergy: r.energyCapacityAvailable || r.energyAvailable || BODY_MIN_COST,
      movementProfile: "mixed",
      urgency: t.nukePlan && t.nukePlan.active ? 1 : a ? .9 : u ? .7 : .4,
      towerFraction: 0
    });
    var b;
    if (t.nukePlan && t.nukePlan.active) b = buildNukeTask(e, t.nukePlan, A % p, p); else if (t.medianRequests && t.medianRequests.length && A < t.medianRequests.length) {
      b = buildMedianTask(e, t.medianRequests[A].clusterIds || []);
    } else {
      var O = (t.items || []).slice();
      for (var k = 0; k < m.length; k++) O.push(m[k]);
      b = buildRepairTaskForSlot(e, O, A, p, u);
    }
    if (taskSize(b) === 0) continue;
    g.push({
      id: e + "_" + y + "_" + A,
      role: "repairer",
      kind: y,
      priority: h,
      emergency: t.repairTier !== "PEACE" ? 1 : u ? 1 : 0,
      maxHeal: u ? 1 : 0,
      b: compactBody(N.body),
      cost: N.cost,
      at: Game.time,
      ct: Game.time,
      r: e,
      task: b
    });
  }
  for (var w = 0; w < g.length; w++) i.push(g[w]);
  Memory.repairSpawnRequests[e] = i;
}

function shouldUseWarCadence(e, r, t, a) {
  if (a && a.active) return true;
  if (hasGlobalScannerWarPlayer()) return true;
  var i = t.hostiles || [];
  for (var n = 0; n < i.length; n++) if (isRealHostile(i[n])) return true;
  var o = Memory.defense && Memory.defense.knownHostiles && Memory.defense.knownHostiles[e];
  return o && o.length > 0;
}

function buildPlan(e, r, t) {
  t = t || {};
  var a = !!t.readOnly;
  if (!a) ensureMemory();
  var i = Game.rooms[e];
  if (!i || !i.controller || !i.controller.my) {
    if (!a) clearVisibleUnownedRepairWork(e);
    return null;
  }
  var n = getRoomState.get(e);
  if (!n || !n.structuresByType) return null;
  var o = i.controller.level;
  var s = isMaxHeal(e, a);
  var u = buildNukePlan(e, n);
  var l = shouldUseWarCadence(e, i, n, u);
  var R = s ? REPAIR_SPAWN_INTERVAL_TICKS : l ? WARTIME_SCAN_INTERVAL : PEACETIME_SCAN_INTERVAL;
  var m = Memory.repairPlan && Memory.repairPlan[e];
  var c = global._repairPlanCache && global._repairPlanCache[e];
  var p = c && c.maxHeal !== undefined ? !!c.maxHeal : !!(m && m.tp && m.tp.m);
  // The bypass probe rebuilds the room's item set, so only pay for it when a
  // fresh plan actually exists to reuse -- a stale or missing plan is rebuilt
  // below no matter what the probe would have said.
  if (!a && !r && c && c.repairTier && isCompactPlan(m) && planTick(m) && Game.time - planTick(m) < R) {
    var f = p !== s;
    var E = f || hasUncoveredRepairerDeficit(e, c || m) || hasRepairerOutage(e) || shouldBypassPlanCache(e, n, o, a, c || m, s, u);
    if (!E) {
      writeHealQueue(e, c, n);
      assignRepairerTasks(e, c);
      writeSpawnRequests(e, i, c, l, true);
      return c;
    }
  }
  var v = roomMem(e, a);
  var _ = false;
  var g = n.hostiles || [];
  for (var d = 0; d < g.length; d++) if (isRealHostile(g[d])) {
    _ = true;
    break;
  }
  if (_ && !a) v.lastRealHostileTick = Game.time;
  var itemSet = repairItemSet(e, n, o, a);
  var A = itemSet.items;
  var y = itemSet.maintenance;
  var h = Object.assign({}, itemSet.stats);
  var M = buildTowerQueue(A, s);
  var P = buildHealQueue(n);
  var C = Memory.defense && Memory.defense.repairOrders && Memory.defense.repairOrders[e] || [];
  var I = classifyRepairTier(e, n, o, A, l, u, h, a);
  h.repairTier = I;
  var S = buildRequestPreview(e, i, A, h, u, I, C, s, y);
  var U = l ? TOWER_REPAIR_LIMIT_WITH_HOSTILES : null;
  if (u.active) U = TOWER_REPAIR_LIMIT_DURING_NUKE;
  var N = {
    tick: Game.time,
    roomName: e,
    cadence: R,
    items: A,
    maintenanceItems: y,
    towerQueue: M,
    healQueue: P,
    healQueueTick: Game.time,
    towerPolicy: {
      repairTowerLimit: U,
      reservePerTower: TOWER_ENERGY_RESERVE,
      allowRepairDuringHostiles: true,
      maxHeal: s,
      spreadTargets: I === "PEACE_EMERGENCY"
    },
    nukePlan: u,
    medianRequests: C,
    requests: S,
    stats: h,
    repairTier: I,
    maxHeal: s,
    planFreshTtl: PLAN_FRESH_TTL
  };
  if (!a) {
    if (!Memory.towers) Memory.towers = {};
    if (u.active || _ || s || I === "PEACE_EMERGENCY") Memory.towers[e] = 1; else delete Memory.towers[e];
    assignRepairerTasks(e, N);
    writeSpawnRequests(e, i, N, l);
    writePlan(e, N);
  }
  return N;
}

function run() {
  ensureMemory();
  adoptUnanchoredRepairers();
  for (var e in Game.rooms) {
    if (roomSuspender.shouldAvoidRoomWork(e)) continue;
    buildPlan(e, false);
  }
}

function formatNumber(e) {
  if (e === null || e === undefined) return "0";
  if (e >= 1e6) return (e / 1e6).toFixed(1) + "M";
  if (e >= 1e3) return Math.round(e / 1e3) + "k";
  return String(Math.round(e));
}

function breachCheckText(e) {
  if (!e) return "Usage: repairCheckBreach(roomName)";
  var r = Game.rooms[e];
  if (!r || !r.controller || !r.controller.my) return "No owned room for " + e;
  var t = getRoomState.get(e);
  if (!t) return "No room state for " + e;
  var a = getBreachState(e, t, r.controller.level);
  var i = a.x === undefined ? "none" : a.x + "," + a.y;
  return e + " breached:" + a.breached + (a.skipped ? " skipped:" + a.skipped : "") + " seeds:" + a.seedCount + " exit:" + i + " nodes:" + a.nodesVisited + "/" + BREACH_MAX_NODES + " cpu:" + a.cpuUsed + (a.truncated ? " truncated:true" : "");
}

function planText(e) {
  var r = e ? [ e ] : ownedVisibleRooms();
  var t = [ "=== Repair Plan ===" ];
  for (var a = 0; a < r.length; a++) {
    var i = r[a];
    if (!isOwnedVisibleRoom(i)) {
      if (e) t.push(i + ": no owned controller");
      continue;
    }
    var n = buildPlan(i, true, {
      readOnly: true
    });
    if (!n) continue;
    var o = getRepairerOccupancy(i);
    var s = getPendingRepairerCount(i);
    t.push(i + " tick:" + n.tick + " cadence:" + n.cadence + " tier:" + n.repairTier + " mode:" + (n.maxHeal ? "MAX_HEAL" : "normal") + " items:" + n.items.length + " towerQ:" + n.towerQueue.length + " healQ:" + (n.healQueue && n.healQueue.length || 0) + " creepHits:" + formatNumber(n.stats.creepHits) + " repairers:" + o.total + " spawning:" + o.spawning + " pending:" + s);
    var breach = getBreachState(i, getRoomState.get(i), Game.rooms[i].controller.level);
    if (breach.breached) t.push("  BREACH exit:" + breach.x + "," + breach.y + " seeds:" + breach.seedCount + " nodes:" + breach.nodesVisited);
    if (n.nukePlan && n.nukePlan.active) t.push("  NUKE eta:" + n.nukePlan.eta + " tiers:" + n.nukePlan.tiers.length);
    for (var u = 0; u < n.requests.length; u++) t.push("  request " + n.requests[u].kind + " p" + n.requests[u].priority + " x" + n.requests[u].count + " cost:" + n.requests[u].bodyCost + " work:" + formatNumber(n.requests[u].totalWork));
  }
  return t.join("\n");
}

function statusText(e) {
  var r = [ "=== Repair Status ===" ];
  var t = e ? [ e ] : ownedVisibleRooms();
  for (var a = 0; a < t.length; a++) {
    var i = t[a];
    if (!isOwnedVisibleRoom(i)) {
      if (e) r.push(i + ": no owned controller");
      continue;
    }
    var n = 0, o = 0;
    var s = getRoomState.creepIndex();
    var u = s && s.all ? s.all : [];
    for (var l = 0; l < u.length; l++) {
      var R = u[l];
      if (R.spawning || !repairerBelongsToRoom(R, i)) continue;
      if (R.memory.role === "repairer" || REPAIRER_ROLES[R.memory.role]) {
        if (R.memory.targetId) n++; else o++;
      }
    }
    var m = getRepairerOccupancy(i);
    var c = getPendingRepairerCount(i);
    var p = Memory.repairPlan && Memory.repairPlan[i];
    r.push(i + " repairers:" + (n + o + m.spawning) + " idle:" + o + " spawning:" + m.spawning + " pending:" + c + " tier:" + (p ? p.rt || p.tier || "unknown" : "none") + " planAge:" + (p ? Game.time - planTick(p) : "none"));
  }
  return r.join("\n");
}

function dispatchText(e) {
  var r = [ "=== Repair Dispatch ===" ];
  var t = e ? [ e ] : ownedVisibleRooms();
  for (var a = 0; a < t.length; a++) {
    if (!isOwnedVisibleRoom(t[a])) {
      clearVisibleUnownedRepairWork(t[a]);
      if (e) r.push(t[a] + ": no owned controller");
      continue;
    }
    buildPlan(t[a], true);
    var i = Memory.repairSpawnRequests && Memory.repairSpawnRequests[t[a]] || [];
    var n = getRepairerOccupancy(t[a]);
    var o = global._repairPlanCache && global._repairPlanCache[t[a]];
    var s = o ? desiredRepairerCount(o) : 0;
    r.push(t[a] + ": live:" + n.total + " spawning:" + n.spawning + " desired:" + s + " pending:" + getPendingRepairerCount(t[a]));
    if (!i.length) r.push("  no requests");
    for (var u = 0; u < i.length; u++) {
      r.push("  " + i[u].kind + " p" + i[u].priority + " cost:" + i[u].cost + " ids:" + taskSize(i[u].task) + (i[u].blockedReason ? " blocked:" + i[u].blockedReason : ""));
    }
  }
  return r.join("\n");
}

function cacheBuildings(e) {
  var r = Game.rooms[e];
  if (!r) return "No vision for " + e;
  var t = roomMem(e);
  var a = [];
  var i = {};
  for (var n = 0; n < REBUILD_TYPES.length; n++) i[REBUILD_TYPES[n]] = true;
  var o = r.find(FIND_RUINS);
  for (var s = 0; s < o.length; s++) {
    var u = o[s];
    var l = u.structure;
    if (!l || !i[l.structureType]) continue;
    var R = r.lookForAt(LOOK_STRUCTURES, u.pos.x, u.pos.y).some(function(e) {
      return e.structureType === l.structureType;
    });
    if (!R) a.push({
      type: l.structureType,
      x: u.pos.x,
      y: u.pos.y
    });
  }
  t.buildingCache = {
    updatedAt: Game.time,
    structures: a
  };
  return "Cached " + a.length + " ruined structures for " + e;
}

function cacheStatus(e) {
  var r = roomMem(e);
  if (!r.buildingCache) return "No ruin cache for " + e;
  return e + " cachedRuins:" + r.buildingCache.structures.length + " updated:" + r.buildingCache.updatedAt;
}

function forgetCache(e) {
  var r = roomMem(e);
  delete r.buildingCache;
  return "Forgot ruin cache for " + e;
}

function destroyCached(e, r, t) {
  if (t !== "CONFIRM") return 'Usage: repairDestroyCached(roomName, type?, "CONFIRM")';
  var a = Game.rooms[e];
  if (!a) return "No vision for " + e;
  var i = roomMem(e);
  if (!i.buildingCache) return "No ruin cache for " + e;
  var n = 0;
  for (var o = 0; o < i.buildingCache.structures.length; o++) {
    var s = i.buildingCache.structures[o];
    if (r && s.type !== r) continue;
    var u = a.lookForAt(LOOK_STRUCTURES, s.x, s.y);
    for (var l = 0; l < u.length; l++) {
      var R = u[l];
      if (R.structureType === s.type && R.my && typeof R.destroy === "function") {
        if (R.destroy() === OK) n++;
      }
    }
  }
  return "Destroyed " + n + " cached structures in " + e;
}

function rebuildMissing(e) {
  var r = Game.rooms[e];
  if (!r) return "No vision for " + e;
  var t = roomMem(e);
  if (!t.buildingCache) return "No ruin cache for " + e;
  var a = 0, i = 0;
  var n = getRoomState.get(e);
  var o = t.lastRealHostileTick || 0;
  for (var s = 0; s < t.buildingCache.structures.length; s++) {
    var u = t.buildingCache.structures[s];
    var l = r.lookForAt(LOOK_STRUCTURES, u.x, u.y).some(function(e) {
      return e.structureType === u.type;
    });
    if (l) continue;
    var R = r.lookForAt(LOOK_CONSTRUCTION_SITES, u.x, u.y).some(function(e) {
      return e.structureType === u.type;
    });
    if (R) continue;
    if (u.type === STRUCTURE_CONTAINER && n) {
      var m = {
        pos: new RoomPosition(u.x, u.y, e)
      };
      if (isMineralContainer(m, n) && Game.time - o < HOSTILE_FREE_FOR_MINERAL_REBUILD) {
        i++;
        continue;
      }
    }
    var c = r.createConstructionSite(u.x, u.y, u.type);
    if (c === OK) a++;
  }
  return "Created " + a + " construction sites in " + e + (i ? ", skipped mineral containers:" + i : "");
}

function nukePlanText(e) {
  var r = buildPlan(e, true);
  if (!r || !r.nukePlan || !r.nukePlan.active) return "No active nuke plan for " + e;
  var t = [ "=== Nuke Plan " + e + " eta:" + r.nukePlan.eta + " ===" ];
  for (var a = 0; a < r.nukePlan.tiers.length; a++) {
    var i = r.nukePlan.tiers[a];
    t.push("T" + i.tier + " " + i.name + " targets:" + i.targets.length + " work:" + formatNumber(i.totalWork));
  }
  return t.join("\n");
}

function setTarget(e, r, t) {
  if (!e || !r || !t) return "Usage: repairSetTarget(roomName, type, hits)";
  var a = roomMem(e);
  a.targetOverrides[r] = Math.max(1, Math.floor(t));
  buildPlan(e, true);
  return "Repair target override set for " + e + " / " + r + " = " + a.targetOverrides[r];
}

function resetTargets(e) {
  if (e) {
    var r = roomMem(e);
    r.targetOverrides = {};
    buildPlan(e, true);
    return "Repair target overrides reset for " + e;
  }
  ensureMemory();
  for (var t in Memory.repairManager.rooms) {
    Memory.repairManager.rooms[t].targetOverrides = {};
  }
  return "Repair target overrides reset globally";
}

function suggestBoost(e) {
  var r = buildPlan(e, true);
  if (!r) return "No repair plan for " + e;
  if (r.nukePlan && r.nukePlan.active) {
    return e + ": nuke plan active, suggest XLH2O for task tier 1/2 repairers if labs are ready.";
  }
  if (r.stats.creepHits >= 9e6) return e + ": heavy repair work (" + formatNumber(r.stats.creepHits) + "), suggest XLH2O if available.";
  if (r.stats.creepHits >= 3e6) return e + ": moderate repair work (" + formatNumber(r.stats.creepHits) + "), suggest LH2O if available.";
  return e + ": no boost suggested.";
}

function cleanup() {
  var e = compactLiveRepairMemory();
  delete Memory.wallRepairOrders;
  delete Memory.repairPlan;
  delete Memory.repairSpawnRequests;
  delete Memory.repairSpawnLastTick;
  if (global._repairPlanCache) global._repairPlanCache = {};
  if (global._repairBreachCache) global._repairBreachCache = {};
  if (Memory.defense) delete Memory.defense.repairOrders;
  if (Memory.spawnPause) {
    delete Memory.spawnPause.wallRepair;
    delete Memory.spawnPause.rampartBot;
  }
  for (var r in Memory) {
    if (r.indexOf("rampartBotCooldown_") === 0 || r.indexOf("repairSuggestedBoost_") === 0) delete Memory[r];
  }
  return "Repair manager cleanup complete. Compacted creeps:" + e.creeps + " requests:" + e.requests;
}

function compactPlansNow(e) {
  ensureMemory();
  var r = compactLiveRepairMemory();
  var t = e ? [ e ] : Object.keys(Game.rooms);
  var a = 0;
  for (var i = 0; i < t.length; i++) {
    if (buildPlan(t[i], true)) a++;
  }
  return "Compacted repair plans for " + a + " rooms. Compacted creeps:" + r.creeps + " requests:" + r.requests;
}

function compactRepairMemoryNow() {
  var e = compactLiveRepairMemory();
  return "Compacted repair memory. Creeps:" + e.creeps + " requests:" + e.requests;
}

function installGlobals() {
  global.repairCheckBreach = breachCheckText;
  global.repairPlan = function(e) {
    return planText(e);
  };
  global.repairStatus = function(e) {
    return statusText(e);
  };
  global.repairDispatch = function(e) {
    return dispatchText(e);
  };
  global.repairSize = function(e) {
    return JSON.stringify(sizeDispatch(e || {}));
  };
  global.repairCacheBuildings = cacheBuildings;
  global.repairCacheStatus = cacheStatus;
  global.repairForgetCache = forgetCache;
  global.repairDestroyCached = destroyCached;
  global.repairRebuildMissing = rebuildMissing;
  global.repairNukePlan = nukePlanText;
  global.repairSetTarget = setTarget;
  global.repairResetTargets = resetTargets;
  global.repairSuggestBoost = suggestBoost;
  global.repairCleanup = cleanup;
  global.repairCompactPlans = compactPlansNow;
  global.repairCompactMemory = compactRepairMemoryNow;
  global.repairPause = function(e) {
    if (!Memory.spawnPause) Memory.spawnPause = {};
    if (!Memory.spawnPause.repairer) Memory.spawnPause.repairer = {
      rooms: {}
    };
    if (e) {
      Memory.spawnPause.repairer.rooms[e] = true;
      return "Repair paused for " + e;
    }
    Memory.spawnPause.repairer.global = true;
    return "Repair paused globally";
  };
  global.repairResume = function(e) {
    if (!Memory.spawnPause || !Memory.spawnPause.repairer) return "Repair was not paused";
    if (e) {
      delete Memory.spawnPause.repairer.rooms[e];
      return "Repair resumed for " + e;
    }
    delete Memory.spawnPause.repairer.global;
    return "Repair resumed globally";
  };
  global.repairMaxHeal = function(e, r) {
    if (e === undefined || e === null) {
      ensureMemory();
      var t = [ "=== Max Heal Rooms ===" ];
      var a = false;
      for (var i in Memory.repairManager.rooms) {
        if (isMaxHeal(i)) {
          a = true;
          var n = Memory.repairManager.rooms[i];
          var o = n.maxHealUntil ? " (until tick " + n.maxHealUntil + ")" : " (persistent)";
          t.push(i + o);
        }
      }
      if (!a) t.push("No rooms have max-heal enabled.");
      return t.join("\n");
    }
    if (r === false) {
      var s = roomMem(e);
      delete s.maxHeal;
      delete s.maxHealUntil;
      if (Memory.towers) delete Memory.towers[e];
      buildPlan(e, true);
      return "Max heal DISABLED for " + e;
    }
    if (typeof r === "number" && r > 0) {
      var u = roomMem(e);
      u.maxHeal = true;
      u.maxHealUntil = Game.time + r;
      if (!Memory.towers) Memory.towers = {};
      Memory.towers[e] = 1;
      buildPlan(e, true);
      return "Max heal ENABLED for " + e + " for " + r + " ticks (until " + u.maxHealUntil + ")";
    }
    var l = roomMem(e);
    l.maxHeal = true;
    delete l.maxHealUntil;
    if (!Memory.towers) Memory.towers = {};
    Memory.towers[e] = 1;
    buildPlan(e, true);
    return "Max heal ENABLED for " + e + " (persistent)";
  };
  global.repairMax = global.repairMaxHeal;
  global.requestTaskBoost = function(e, r, t, a) {
    if (!global.boost) return "boostManager global.boost is not available";
    var i = {};
    i[t] = a || 21;
    var n = computeBody(BODY_MAX_COST, "mixed");
    return global.boost(e, "task_" + r, i, n);
  };
  global.orderWallRepair = function(e) {
    return setTarget(e);
  };
  global.cancelWallRepair = function(e) {
    return resetTargets(e);
  };
  global.wallRepairStatus = function(e) {
    return statusText(e);
  };
  global.wallRepairOverview = function() {
    return planText();
  };
  global.pauseWallRepair = global.repairPause;
  global.resumeWallRepair = global.repairResume;
  global.pauseRampartBot = global.repairPause;
  global.resumeRampartBot = global.repairResume;
}

installGlobals();
module.exports = {
  run: run,
  buildPlan: buildPlan,
  ensureCreepAssignment: ensureCreepAssignment,
  repairerSpawnPhase: repairerSpawnPhase,
  shouldAttemptRepairerSpawn: shouldAttemptRepairerSpawn,
  sizeDispatch: sizeDispatch,
  computeBody: computeBody,
  bodyCost: bodyCost,
  isMaxHeal: isMaxHeal,
  getRampartTarget: getRampartTarget,
  isRoomPerimeterBreached: isRoomPerimeterBreached,
  getBreachState: getBreachState,
  shouldBypassPlanCache: shouldBypassPlanCache,
  constants: {
    MAX_PARALLEL_REPAIRERS: MAX_PARALLEL_REPAIRERS,
    EXTRA_REPAIR_STORAGE_MIN: EXTRA_REPAIR_STORAGE_MIN,
    REPAIRER_REPLACEMENT_TTL: REPAIRER_REPLACEMENT_TTL,
    REPAIR_SPAWN_INTERVAL_TICKS: REPAIR_SPAWN_INTERVAL_TICKS,
    PLAN_FRESH_TTL: PLAN_FRESH_TTL,
    RAMPART_TARGETS: RAMPART_TARGETS,
    TOWER_REPAIR_CAP_BY_TYPE: TOWER_REPAIR_CAP_BY_TYPE,
    BREACH_MIN_RCL: BREACH_MIN_RCL,
    BREACH_RECHECK_TICKS: BREACH_RECHECK_TICKS,
    BREACH_MAX_NODES: BREACH_MAX_NODES
  }
};
