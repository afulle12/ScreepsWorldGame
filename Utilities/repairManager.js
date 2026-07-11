// LLM: Read llmcontext.js before reviewing or changing this file.
// repairManager.js
// Unified repair planning layer. Computes room repair/nuke plans and
// exposes console commands; existing repair roles and spawn logic
// remain authoritative until migration is complete.
//
// ── REPAIR ROLES ─────────────────────────────────────────────────────
//   repairer      — generic task executor for repairManager plans
//   wallRepair    — legacy wall/rampart repairer
//   rampartBot    — rampart-only repairer
//   defenseRepair — emergency repair during attacks
//
// ── CONSOLE COMMANDS ─────────────────────────────────────────────────
//   repairPlan(roomName?)          — show plan per room (tier, items,
//                                    tower queue, spawn requests)
//   repairStatus(roomName?)        — show active/idle repairer count
//   repairDispatch(roomName?)      — show pending spawn requests
//   repairSize(opts)               — sizeDispatch({ totalHits, ... })
//   repairCacheBuildings(roomName) — snapshot rebuildable ruins
//   repairCacheStatus(roomName)    — show cached ruin count/age
//   repairForgetCache(roomName)    — drop ruin cache
//   repairDestroyCached(roomName, type?, "CONFIRM")
//                                — destroy cached structures
//   repairRebuildMissing(roomName) — recreate construction sites from
//                                    cache
//   repairNukePlan(roomName)       — show active nuke tier breakdown
//   repairSetTarget(roomName, type, hits)
//                                — override wall/rampart target HP
//   repairResetTargets(roomName?)  — clear target overrides
//   repairSuggestBoost(roomName)   — recommend LH2O/XLH2O
//   repairCleanup()                — drop all repair memory + compact
//   repairCompactPlans(roomName?)  — compact memory + rebuild plans
//   repairCompactMemory()          — compact live creep/req memory
//   repairPause(roomName?)         — pause repairer spawning
//   repairResume(roomName?)        — resume repairer spawning
//   repairMaxHeal(roomName?, opts?) — enable max-heal mode
//     repairMaxHeal('E9N47')              — enable persistently
//     repairMaxHeal('E9N47', false)       — disable
//     repairMaxHeal('E9N47', 5000)        — enable for 5000 ticks
//     repairMaxHeal()                     — list active max-heal rooms
//     repairMax('E9N47')                  — alias for repairMaxHeal
//     While enabled: 3 repairers, towers unleashed, towers repair
//     walls/ramparts (95% HP cap), and tower fillers spawn without
//     hostiles (fill to 95%).
//   requestTaskBoost(roomName, taskId, compound, parts)
//                                — queue a boost for a task
//
//   Legacy (deprecated):
//     orderWallRepair / cancelWallRepair / wallRepairStatus
//     wallRepairOverview / pauseWallRepair / resumeWallRepair
//     pauseRampartBot / resumeRampartBot
//
// ── MEMORY ───────────────────────────────────────────────────────────
//   Memory.repairManager.rooms[roomName]  — { inaccessible,
//     targetOverrides, buildingCache, lastRealHostileTick, maxHeal,
//     maxHealUntil }
//   Memory.repairPlan[roomName]           — compact plan
//   Memory.repairSpawnRequests[roomName]  — pending spawn requests
//   Memory.spawnPause.repairer            — { rooms, global }
//   global._repairPlanCache[roomName]     — live plan cache

var getRoomState = require('getRoomState');
var defenseMonitor = require('defenseMonitor');
var roomSuspender = require('roomSuspender');
var util = require('util');

var MAX_PARALLEL_REPAIRERS = 4;
var REQUEST_TTL = 100;
var EXTRA_REPAIR_STORAGE_MIN = 300000;
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
var BASELINE_HITS_PER_LIFE = 3000000;
var NUKE_GROUND_ZERO_DAMAGE = 10000000;
var NUKE_SPLASH_DAMAGE = 5000000;
var NUKE_SAFETY_MARGIN = 500000;
var HOSTILE_FREE_FOR_MINERAL_REBUILD = 20000;
var PEACETIME_EMERGENCY_FRACTION = 0.10;
var PEACETIME_EMERGENCY_TICKS = 1000;
var ROAD_EMERGENCY_FRACTION = 0.30;
var CONTAINER_EMERGENCY_FRACTION = 0.30;
var WALL_EMERGENCY_HITS = 1000000;
var RAMPART_EMERGENCY_HITS = 1000000;
var CRITICAL_RAMPART_EMERGENCY_HITS = 5000000;
var REPAIR_TIERS = {
  PEACE: 1,
  PEACE_EMERGENCY: 1,
  WAR: 2,
  WAR_EMERGENCY: 3
};

// Keep these defaults aligned with the existing spawnManager / role modules
// until those constants are exported and this module can import them directly.
var WALLREPAIR_THRESHOLD_BY_RCL = [0, 0, 10000, 50000, 200000, 1000000, 5000000, 10000000, 50000000];
var RCL_TOWER_CAP = [0, 0, 10000, 50000, 200000, 1000000, 1000000, 1000000, 1000000];
var CRITICAL_RAMPART_TOWER_CAP = 10500000;
var RAMPARTBOT_EXTERNAL_TARGET = 50000000;
var RAMPARTBOT_PERIMETER_RANGE = 3;
var ROAD_REPAIR_TRIGGER = 0.50;
var ROAD_REPAIR_TARGET = 0.80;
var DEFENSE_REPAIR_TRIGGER_RATIO = 0.90;
var DEFENSE_REPAIR_TARGET_RATIO = 0.97;
var CONTAINER_DONE_HITS = 244000;
var TOWER_REPAIR_MAX_RATIO = 0.95;

// Target rampart hits keyed by the structure type the rampart protects
// (dominant structure within range 1). Single source of truth — exported
// via module.exports.constants; towerManager and roleRepairer import these
// instead of redefining them.
const RAMPART_TARGETS = {
  [STRUCTURE_SPAWN]: 60500000,
  [STRUCTURE_TERMINAL]: 60500000,
  [STRUCTURE_STORAGE]: 60500000,
  [STRUCTURE_TOWER]: 5500000,
  [STRUCTURE_LINK]: 5500000,
  [STRUCTURE_NUKER]: 10500000,
  [STRUCTURE_FACTORY]: 5500000,
  [STRUCTURE_LAB]: 5500000,
  [STRUCTURE_POWER_SPAWN]: 10500000,
  [STRUCTURE_OBSERVER]: 5500000
};

// Per-structure-type tower repair cap for non-critical ramparts. When a
// rampart's target is 5.5M (tower, lab, link, factory, observer), towers
// are allowed to assist up to this cap rather than being limited to the
// 1M RCL_TOWER_CAP (which would skip them entirely and leave all repair
// to creeps). Entries must match the 5.5M tier of RAMPART_TARGETS above.
const TOWER_REPAIR_CAP_BY_TYPE = {
  [STRUCTURE_TOWER]: 5500000,
  [STRUCTURE_LAB]: 5500000,
  [STRUCTURE_LINK]: 5500000,
  [STRUCTURE_FACTORY]: 5500000,
  [STRUCTURE_OBSERVER]: 5500000
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
  1: 'core-survival',
  2: 'core-economy',
  3: 'defense',
  4: 'strategic',
  5: 'support',
  6: 'barrier'
};

var REBUILD_TYPES = [
  STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_TOWER,
  STRUCTURE_LINK, STRUCTURE_LAB, STRUCTURE_FACTORY, STRUCTURE_NUKER,
  STRUCTURE_POWER_SPAWN, STRUCTURE_OBSERVER, STRUCTURE_EXTRACTOR,
  STRUCTURE_EXTENSION, STRUCTURE_CONTAINER
];

var REPAIRER_ROLES = {
  repairer: true,
  wallRepair: true,
  rampartBot: true,
  defenseRepair: true
};

if (!global._repairPlanCache) global._repairPlanCache = {};

function ensureMemory() {
  if (!Memory.repairManager) Memory.repairManager = { rooms: {} };
  if (!Memory.repairManager.rooms) Memory.repairManager.rooms = {};
  if (!Memory.repairPlan) Memory.repairPlan = {};
  if (!Memory.repairSpawnRequests) Memory.repairSpawnRequests = {};
}

function roomMem(roomName) {
  ensureMemory();
  if (!Memory.repairManager.rooms[roomName]) {
    Memory.repairManager.rooms[roomName] = { inaccessible: {}, targetOverrides: {}, roadRepairTargets: {} };
  }
  var rm = Memory.repairManager.rooms[roomName];
  if (!rm.inaccessible) rm.inaccessible = {};
  if (!rm.targetOverrides) rm.targetOverrides = {};
  if (!rm.roadRepairTargets) rm.roadRepairTargets = {};
  if (rm.maxHealUntil && Game.time >= rm.maxHealUntil) {
    delete rm.maxHeal;
    delete rm.maxHealUntil;
  }
  return rm;
}

function isMaxHeal(roomName) {
  var rm = roomMem(roomName);
  if (rm.maxHeal) return true;
  if (rm.maxHealUntil && Game.time < rm.maxHealUntil) return true;
  return false;
}

function isOwnedVisibleRoom(roomName) {
  var room = Game.rooms[roomName];
  return !!(room && room.controller && room.controller.my);
}

function ownedVisibleRooms() {
  var rooms = [];
  for (var roomName in Game.rooms) {
    if (isOwnedVisibleRoom(roomName)) rooms.push(roomName);
  }
  return rooms;
}

function clearVisibleUnownedRepairWork(roomName) {
  var room = Game.rooms[roomName];
  if (!room || (room.controller && room.controller.my)) return;
  ensureMemory();
  delete Memory.repairPlan[roomName];
  delete Memory.repairSpawnRequests[roomName];
  if (global._repairPlanCache) delete global._repairPlanCache[roomName];
  if (Memory.towers) delete Memory.towers[roomName];
  if (Memory.defense && Memory.defense.repairOrders) delete Memory.defense.repairOrders[roomName];
  var idx = getRoomState.creepIndex();
  var creeps = idx && idx.all ? idx.all : [];
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    if (!c.memory || !REPAIRER_ROLES[c.memory.role]) continue;
    var anchor = c.memory.homeRoom || c.memory.assignedRoom || null;
    if (anchor !== roomName) continue;
    delete c.memory.task;
    delete c.memory.targetId;
    delete c.memory.route;
  }
}

var bodyCost = util.bodyCost;

function compactBody(body) {
  var counts = {};
  for (var i = 0; i < body.length; i++) counts[body[i]] = (counts[body[i]] || 0) + 1;
  return counts;
}

function computeBody(budget, movementProfile) {
  budget = Math.min(BODY_MAX_COST, Math.max(BODY_MIN_COST, budget || BODY_MIN_COST));
  var workCarryRatio = 1.5;
  var moveMultiplier = 1.0;
  if (movementProfile === 'road') { workCarryRatio = 1.0; moveMultiplier = 0.5; }
  else if (movementProfile === 'plain') { workCarryRatio = 2.0; moveMultiplier = 1.0; }

  var bestWork = 0, bestCarry = 0, bestMove = 0;
  for (var work = 1; work <= 50; work++) {
    var carry = Math.max(1, Math.round(work / workCarryRatio));
    var move = Math.max(1, Math.ceil((work + carry) * moveMultiplier));
    if (work + carry + move > 50) break;
    var cost = work * 100 + carry * 50 + move * 50;
    if (cost > budget) break;
    bestWork = work;
    bestCarry = carry;
    bestMove = move;
  }

  if (bestWork === 0) return [WORK, CARRY, MOVE, MOVE];
  var body = [];
  for (var i = 0; i < bestWork; i++) body.push(WORK);
  for (var j = 0; j < bestCarry; j++) body.push(CARRY);
  for (var k = 0; k < bestMove; k++) body.push(MOVE);
  return body;
}

function sizeDispatch(opts) {
  opts = opts || {};
  var totalHits = opts.totalHits || 0;
  var maxSingleHits = opts.maxSingleHits || totalHits || 0;
  var availableEnergy = opts.availableEnergy || BODY_MIN_COST;
  var movementProfile = opts.movementProfile || 'mixed';
  var urgency = typeof opts.urgency === 'number' ? opts.urgency : 0.2;
  var towerFraction = typeof opts.towerFraction === 'number' ? opts.towerFraction : 0;
  var creepHits = totalHits * (1 - towerFraction);
  var serialNeeded = Math.max(1, Math.ceil(maxSingleHits / BASELINE_HITS_PER_LIFE));
  var count = 1;
  if (urgency > 0.7) count = Math.max(2, Math.ceil(urgency * serialNeeded));
  else if (urgency > 0.4) count = Math.max(1, Math.ceil(urgency * serialNeeded));
  count = Math.min(count, MAX_PARALLEL_REPAIRERS);
  var budget = Math.max(BODY_MIN_COST, availableEnergy - SPAWN_RESERVE);
  var body = computeBody(budget, movementProfile);
  var workParts = 0;
  for (var i = 0; i < body.length; i++) if (body[i] === WORK) workParts++;
  return {
    body: body,
    cost: bodyCost(body),
    count: count,
    hitsPerTick: workParts * 100,
    estimatedTicks: workParts > 0 ? Math.ceil(creepHits / (count * workParts * 100)) : 0
  };
}

function isRealHostile(creep) {
  if (!creep || !creep.owner) return false;
  var owner = creep.owner.username;
  if (owner === 'Invader' || owner === 'Source Keeper') return false;
  if (!creep.body || creep.body.length === 0) return false;
  for (var i = 0; i < creep.body.length; i++) {
    if (creep.body[i].type !== MOVE) return true;
  }
  return false;
}

function hasGlobalScannerWarPlayer() {
  var players = Memory.playerMonitor && Memory.playerMonitor.players;
  if (!players) return false;
  for (var playerName in players) {
    if (players[playerName] && players[playerName].status === 'WAR') return true;
  }
  return false;
}

function isPerimeter(pos) {
  return pos.x <= RAMPARTBOT_PERIMETER_RANGE || pos.x >= 49 - RAMPARTBOT_PERIMETER_RANGE ||
    pos.y <= RAMPARTBOT_PERIMETER_RANGE || pos.y >= 49 - RAMPARTBOT_PERIMETER_RANGE;
}

function isMineralContainer(container, rs) {
  if (!container || !rs || !rs.minerals) return false;
  for (var i = 0; i < rs.minerals.length; i++) {
    var mineral = rs.minerals[i];
    if (mineral && container.pos.inRangeTo(mineral.pos, 2)) return true;
  }
  return false;
}

function getRampartTarget(rampart, rs, rcl) {
  var maxTarget = 0;
  var maxType = null;
  var sbt = rs && rs.structuresByType ? rs.structuresByType : {};
  for (var type in RAMPART_TARGETS) {
    var arr = sbt[type] || [];
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (s && rampart.pos.getRangeTo(s.pos) <= 1 && RAMPART_TARGETS[type] > maxTarget) {
        maxTarget = RAMPART_TARGETS[type];
        maxType = type;
      }
    }
  }
  if (maxTarget === 0 && isPerimeter(rampart.pos)) maxTarget = RAMPARTBOT_EXTERNAL_TARGET;
  var cap = RAMPART_HITS_MAX[rcl] || 0;
  if (cap > 0 && maxTarget > cap) maxTarget = cap;
  return { target: maxTarget, type: maxType };
}

function getWallTarget(roomName, rcl) {
  var rm = roomMem(roomName);
  if (rm.targetOverrides && rm.targetOverrides[STRUCTURE_WALL]) return rm.targetOverrides[STRUCTURE_WALL];
  return WALLREPAIR_THRESHOLD_BY_RCL[rcl] || 0;
}

function towerCapFor(item, rcl) {
  if (item.type === STRUCTURE_WALL) return RCL_TOWER_CAP[rcl] || 0;
  if (item.type === STRUCTURE_RAMPART) {
    if (item.criticalRampart) return CRITICAL_RAMPART_TOWER_CAP;
    if (item.protectedStructureType && TOWER_REPAIR_CAP_BY_TYPE[item.protectedStructureType]) {
      return TOWER_REPAIR_CAP_BY_TYPE[item.protectedStructureType];
    }
    return RCL_TOWER_CAP[rcl] || 0;
  }
  return item.target || 0;
}

function towerRepairTarget(item) {
  var target = item.target || 0;
  if (item.hitsMax) target = Math.min(target, Math.floor(item.hitsMax * TOWER_REPAIR_MAX_RATIO));
  return target;
}

function roadTriggerHits(road) {
  return Math.floor((road.hitsMax || 0) * ROAD_REPAIR_TRIGGER);
}

function roadTargetHits(road) {
  return Math.floor((road.hitsMax || 0) * ROAD_REPAIR_TARGET);
}

function buildItems(roomName, rs, rcl) {
  var items = [];
  var sbt = rs && rs.structuresByType ? rs.structuresByType : {};
  var wallTarget = getWallTarget(roomName, rcl);
  var rm = roomMem(roomName);
  var activeRoads = rm.roadRepairTargets || {};
  var seenRoads = {};

  var walls = sbt[STRUCTURE_WALL] || [];
  for (var wi = 0; wi < walls.length; wi++) {
    var wall = walls[wi];
    var wallRepairTarget = Math.floor(wallTarget * DEFENSE_REPAIR_TARGET_RATIO);
    if (!wall || typeof wall.hits !== 'number' || wall.hits >= Math.floor(wallTarget * DEFENSE_REPAIR_TRIGGER_RATIO)) continue;
    items.push({ id: wall.id, type: STRUCTURE_WALL, x: wall.pos.x, y: wall.pos.y, hits: wall.hits, target: wallRepairTarget });
  }

  var ramparts = sbt[STRUCTURE_RAMPART] || [];
  for (var ri = 0; ri < ramparts.length; ri++) {
    var ramp = ramparts[ri];
    if (!ramp || !ramp.my || typeof ramp.hits !== 'number') continue;
    var info = getRampartTarget(ramp, rs, rcl);
    var target = info.target;
    var rampRepairTarget = Math.floor(target * DEFENSE_REPAIR_TARGET_RATIO);
    if (target <= 0 || ramp.hits >= Math.floor(target * DEFENSE_REPAIR_TRIGGER_RATIO)) continue;
    items.push({ id: ramp.id, type: STRUCTURE_RAMPART, x: ramp.pos.x, y: ramp.pos.y, hits: ramp.hits, target: rampRepairTarget, criticalRampart: target >= CRITICAL_RAMPART_TOWER_CAP, protectedStructureType: info.type });
  }

  var roads = sbt[STRUCTURE_ROAD] || [];
  for (var ro = 0; ro < roads.length; ro++) {
    var road = roads[ro];
    if (!road || typeof road.hits !== 'number' || !road.hitsMax) continue;
    seenRoads[road.id] = true;
    var roadTrigger = roadTriggerHits(road);
    var roadTarget = roadTargetHits(road);
    if (road.hits < roadTrigger) activeRoads[road.id] = 1;
    else if (road.hits >= roadTarget) delete activeRoads[road.id];
    if (activeRoads[road.id]) {
      items.push({ id: road.id, type: STRUCTURE_ROAD, x: road.pos.x, y: road.pos.y, hits: road.hits, hitsMax: road.hitsMax, target: roadTarget });
    }
  }
  for (var rid in activeRoads) if (!seenRoads[rid]) delete activeRoads[rid];
  rm.roadRepairTargets = activeRoads;

  var containers = sbt[STRUCTURE_CONTAINER] || [];
  for (var ci = 0; ci < containers.length; ci++) {
    var c = containers[ci];
    if (!c || typeof c.hits !== 'number') continue;
    if (c.hits < CONTAINER_DONE_HITS) items.push({ id: c.id, type: STRUCTURE_CONTAINER, x: c.pos.x, y: c.pos.y, hits: c.hits, hitsMax: c.hitsMax || 250000, target: CONTAINER_DONE_HITS, mineralContainer: isMineralContainer(c, rs) });
  }

  return items;
}

function classifyItems(items, rcl, rs) {
  var towerHasEnergy = false;
  var towers = (rs.structuresByType && rs.structuresByType[STRUCTURE_TOWER]) || [];
  for (var ti = 0; ti < towers.length; ti++) {
    if (towers[ti].my && towers[ti].store[RESOURCE_ENERGY] >= TOWER_ENERGY_RESERVE) { towerHasEnergy = true; break; }
  }

  var typeCounts = {};
  for (var i = 0; i < items.length; i++) typeCounts[items[i].type] = (typeCounts[items[i].type] || 0) + 1;

  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    item.towerCap = towerCapFor(item, rcl);
    item.deficit = Math.max(0, item.target - item.hits);
    item.peerCount = typeCounts[item.type] || 1;
    if (item.type === STRUCTURE_ROAD || item.type === STRUCTURE_CONTAINER) item.source = 'tower';
    else if (item.target > item.towerCap) item.source = 'creep';
    else if (!towerHasEnergy) item.source = 'creep';
    else if (item.peerCount >= 10) item.source = 'tower';
    else item.source = 'both';
    if (item.source === 'tower') item.target = towerRepairTarget(item);
  }
  return items;
}

function towerPriority(item) {
  if (item.type === STRUCTURE_CONTAINER) return 1;
  if (item.type === STRUCTURE_ROAD) return 2;
  if (item.type === STRUCTURE_RAMPART && item.criticalRampart && item.hits < CRITICAL_RAMPART_TOWER_CAP) return 3;
  if (item.hits < 1000000) return 4;
  return 5;
}

function isBorderPos(pos) {
  return pos && (pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49);
}

function buildHealQueue(rs) {
  var q = [];
  var pcs = (rs && rs.myPowerCreeps) || [];
  for (var i = 0; i < pcs.length; i++) {
    var pc = pcs[i];
    if (!pc || !pc.name || typeof pc.hits !== 'number' || !pc.hitsMax) continue;
    if (pc.hits >= pc.hitsMax) continue;
    q.push({ name: pc.name, val: pc.hits / pc.hitsMax, border: isBorderPos(pc.pos) ? 1 : 0 });
  }
  q.sort(function(a, b) {
    if (a.border !== b.border) return a.border - b.border;
    return a.val - b.val;
  });
  return q;
}

function compactHealQueue(queue) {
  var out = [];
  for (var i = 0; i < queue.length; i++) {
    var q = queue[i];
    out.push([q.name, q.val, q.border]);
  }
  return out;
}

function writeHealQueue(roomName, plan, rs) {
  var healQueue = buildHealQueue(rs);
  if (plan) {
    plan.healQueue = healQueue;
    plan.healQueueTick = Game.time;
  }
  var compact = Memory.repairPlan && Memory.repairPlan[roomName];
  if (compact) {
    compact.hq = compactHealQueue(healQueue);
    compact.hqt = Game.time;
  }
  return healQueue;
}

function buildTowerQueue(items, maxHeal) {
  var q = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var isDefense = it.type === STRUCTURE_WALL || it.type === STRUCTURE_RAMPART;
    if (!maxHeal) {
      if (it.source !== 'tower' && it.source !== 'both') continue;
      if (isDefense && it.source !== 'tower') continue;
    }
    if (!isDefense && it.source !== 'tower' && it.source !== 'both') continue;
    var target = towerRepairTarget(it);
    if (target > 0 && it.hits >= target) continue;
    var pri = maxHeal ? maxHealTowerPriority(it) : towerPriority(it);
    q.push({ id: it.id, pri: pri, val: it.hits, border: (it.x === 0 || it.x === 49 || it.y === 0 || it.y === 49) ? 1 : 0, target: target });
  }
  q.sort(function(a, b) {
    if (a.pri !== b.pri) return a.pri - b.pri;
    if (a.border !== b.border) return a.border - b.border;
    return a.val - b.val;
  });
  return q;
}

function maxHealTowerPriority(item) {
  if (item.type === STRUCTURE_CONTAINER) return 1;
  if (item.type === STRUCTURE_ROAD) return 2;
  if (item.type === STRUCTURE_RAMPART && item.criticalRampart) return 3;
  if (item.type === STRUCTURE_RAMPART) return 4;
  if (item.type === STRUCTURE_WALL) return 5;
  return 6;
}

function compactTowerQueue(queue) {
  var out = [];
  var limit = Math.min(queue.length, MAX_SERIALIZED_TOWER_QUEUE);
  for (var i = 0; i < limit; i++) {
    var q = queue[i];
    out.push([q.id, q.pri, q.val, q.border, q.target]);
  }
  return out;
}

function expandTowerQueue(queue) {
  var out = [];
  if (!queue) return out;
  for (var i = 0; i < queue.length; i++) {
    var q = queue[i];
    if (Array.isArray(q)) out.push({ id: q[0], pri: q[1], val: q[2], border: q[3] });
    else out.push(q);
  }
  return out;
}

function compactRequests(requests) {
  var out = [];
  for (var i = 0; i < requests.length; i++) {
    var r = requests[i];
    out.push({ k: r.kind, p: r.priority, t: r.tier || 0, c: r.bodyCost, n: r.count, w: r.totalWork || 0 });
  }
  return out;
}

function compactNukePlan(nukePlan) {
  if (!nukePlan || !nukePlan.active) return null;
  var tiers = [];
  for (var i = 0; i < nukePlan.tiers.length; i++) {
    var t = nukePlan.tiers[i];
    tiers.push([t.tier, t.targets.length, t.totalWork]);
  }
  return { a: 1, e: nukePlan.eta, l: nukePlan.landingTick, ts: tiers };
}

function compactPlan(plan) {
  return {
    t: plan.tick,
    c: plan.cadence,
    rt: plan.repairTier,
    s: {
      th: plan.stats.totalHits,
      tw: plan.stats.towerHits,
      ch: plan.stats.creepHits,
      mh: plan.stats.maxSingleHits,
      n: plan.stats.structureCount
    },
    tq: compactTowerQueue(plan.towerQueue),
    hq: compactHealQueue(plan.healQueue || []),
    hqt: plan.healQueueTick || plan.tick,
    w: plan.workList ? plan.workList.length : 0,
    a: plan.assignments || {},
    tp: {
      l: plan.towerPolicy && plan.towerPolicy.repairTowerLimit,
      r: plan.towerPolicy && plan.towerPolicy.reservePerTower,
      m: plan.towerPolicy && plan.towerPolicy.maxHeal ? 1 : 0,
      s: plan.towerPolicy && plan.towerPolicy.spreadTargets ? 1 : 0
    },
    n: compactNukePlan(plan.nukePlan),
    m: plan.medianRequests ? plan.medianRequests.length : 0,
    rq: compactRequests(plan.requests || [])
  };
}

function writePlan(roomName, plan) {
  global._repairPlanCache[roomName] = plan;
  Memory.repairPlan[roomName] = compactPlan(plan);
}

function planTick(plan) {
  return plan ? (plan.tick || plan.t || 0) : 0;
}

function isCompactPlan(plan) {
  return !!(plan && plan.t !== undefined && plan.s && plan.tq !== undefined);
}

function getNukes(room) {
  try { return room.find(FIND_NUKES) || []; } catch (e) { return []; }
}

function nukeDamageAt(nukes, pos) {
  var total = 0;
  var earliest = null;
  for (var i = 0; i < nukes.length; i++) {
    var nuke = nukes[i];
    var range = Math.max(Math.abs(nuke.pos.x - pos.x), Math.abs(nuke.pos.y - pos.y));
    if (range === 0) total += NUKE_GROUND_ZERO_DAMAGE;
    else if (range <= 2) total += NUKE_SPLASH_DAMAGE;
    else continue;
    if (earliest === null || nuke.timeToLand < earliest) earliest = nuke.timeToLand;
  }
  return { damage: total, eta: earliest };
}

function isProtectedNukeStructure(s, rs) {
  if (!s || !NUKE_TIER_BY_TYPE[s.structureType]) return false;
  if (s.structureType === STRUCTURE_CONTAINER && isMineralContainer(s, rs)) return false;
  return true;
}

function findRampartAt(pos, rs) {
  var ramps = (rs.structuresByType && rs.structuresByType[STRUCTURE_RAMPART]) || [];
  for (var i = 0; i < ramps.length; i++) {
    var r = ramps[i];
    if (r && r.pos.x === pos.x && r.pos.y === pos.y && r.pos.roomName === pos.roomName) return r;
  }
  return null;
}

function buildNukePlan(roomName, rs) {
  var room = Game.rooms[roomName];
  if (!room) return { active: false, tiers: [] };
  var nukes = getNukes(room);
  if (!nukes.length) return { active: false, tiers: [] };

  var tiers = {};
  var earliest = null;
  var sbt = rs.structuresByType || {};

  function addTarget(tier, obj, targetHits, reason) {
    if (!tiers[tier]) tiers[tier] = { tier: tier, name: NUKE_TIER_NAMES[tier], totalWork: 0, targets: [] };
    var hits = typeof obj.hits === 'number' ? obj.hits : 0;
    var work = Math.max(0, targetHits - hits);
    if (work <= 0) return;
    tiers[tier].targets.push({ id: obj.id, x: obj.pos.x, y: obj.pos.y, type: obj.structureType, currentHits: hits, targetHits: targetHits, reason: reason });
    tiers[tier].totalWork += work;
  }

  for (var type in sbt) {
    var arr = sbt[type] || [];
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (!s || !s.pos) continue;
      var d = nukeDamageAt(nukes, s.pos);
      if (d.damage <= 0) continue;
      if (earliest === null || d.eta < earliest) earliest = d.eta;

      if (isProtectedNukeStructure(s, rs)) {
        var tier = NUKE_TIER_BY_TYPE[s.structureType];
        var ramp = findRampartAt(s.pos, rs);
        var target = d.damage + NUKE_SAFETY_MARGIN;
        if (ramp) addTarget(tier, ramp, target, d.damage >= NUKE_GROUND_ZERO_DAMAGE ? 'direct' : 'splash');
        else if (tier <= 4) {
          tiers[tier] = tiers[tier] || { tier: tier, name: NUKE_TIER_NAMES[tier], totalWork: 0, targets: [] };
          tiers[tier].targets.push({ id: null, x: s.pos.x, y: s.pos.y, type: STRUCTURE_RAMPART, currentHits: 0, targetHits: target, reason: 'buildRampart' });
          tiers[tier].totalWork += target;
        }
      } else if (s.structureType === STRUCTURE_WALL) {
        addTarget(6, s, d.damage + NUKE_SAFETY_MARGIN, d.damage >= NUKE_GROUND_ZERO_DAMAGE ? 'direct-wall' : 'splash-wall');
      } else if (s.structureType === STRUCTURE_RAMPART && isPerimeter(s.pos)) {
        addTarget(6, s, d.damage + NUKE_SAFETY_MARGIN, d.damage >= NUKE_GROUND_ZERO_DAMAGE ? 'direct-barrier' : 'splash-barrier');
      }
    }
  }

  var list = [];
  for (var k in tiers) list.push(tiers[k]);
  list.sort(function(a, b) { return a.tier - b.tier; });
  return { active: list.length > 0, eta: earliest, landingTick: earliest === null ? null : Game.time + earliest, tiers: list };
}

function computeStats(items) {
  var totalHits = 0, towerHits = 0, creepHits = 0, maxSingleHits = 0;
  for (var i = 0; i < items.length; i++) {
    var d = items[i].deficit || 0;
    totalHits += d;
    if (d > maxSingleHits) maxSingleHits = d;
    if (items[i].source === 'tower') towerHits += d;
    else if (items[i].source === 'creep') creepHits += d;
    else if (items[i].source === 'both') { towerHits += Math.min(d, Math.max(0, items[i].towerCap - items[i].hits)); creepHits += d; }
  }
  return { totalHits: totalHits, towerHits: towerHits, creepHits: creepHits, maxSingleHits: maxSingleHits, structureCount: items.length };
}

function buildRequestPreview(roomName, room, items, stats, nukePlan, repairTier, medianRequests) {
  var available = room.energyCapacityAvailable || room.energyAvailable || BODY_MIN_COST;
  var reqs = [];
  if (nukePlan && nukePlan.active) {
    var slotCount = 0;
    for (var ti = 0; ti < nukePlan.tiers.length && slotCount < MAX_PARALLEL_REPAIRERS; ti++) {
      var tier = nukePlan.tiers[ti];
      if (!tier.targets.length) continue;
      var sized = sizeDispatch({ totalHits: tier.totalWork, maxSingleHits: tier.totalWork, availableEnergy: available, movementProfile: 'mixed', urgency: 1.0, towerFraction: 0 });
      reqs.push({ kind: 'nuke', priority: 5, tier: tier.tier, bodyCost: sized.cost, count: Math.min(sized.count, MAX_PARALLEL_REPAIRERS - slotCount), totalWork: tier.totalWork });
      slotCount += reqs[reqs.length - 1].count;
    }
    return reqs;
  }

  if (stats.creepHits > 0) {
    var baseline = sizeDispatch({ totalHits: stats.creepHits, maxSingleHits: stats.maxSingleHits, availableEnergy: available, movementProfile: 'mixed', urgency: 0.4, towerFraction: 0 });
    reqs.push({ kind: 'baseline', priority: 6, bodyCost: baseline.cost, count: 1, totalWork: stats.creepHits });
    var extras = extraCountForTier(repairTier);
    if (extras > 0) reqs.push({ kind: 'extra', priority: 7, bodyCost: baseline.cost, count: extras, totalWork: stats.creepHits, blockedIfStorageBelow: EXTRA_REPAIR_STORAGE_MIN });
  }
  return reqs;
}

function getRepairers(roomName) {
  var list = [];
  var idx = getRoomState.creepIndex();
  var creeps = idx && idx.all ? idx.all : [];
  for (var i = 0; i < creeps.length; i++) {
    var creep = creeps[i];
    if (!creep.memory || !REPAIRER_ROLES[creep.memory.role]) continue;
    var anchor = creep.memory.homeRoom || creep.memory.assignedRoom || null;
    if (creep.memory.role === 'repairer') {
      if (anchor === roomName) list.push(creep);
      continue;
    }
    if ((anchor || creep.room.name) === roomName) list.push(creep);
  }
  return list;
}

function getPendingRepairerCount(roomName) {
  var reqs = (Memory.repairSpawnRequests && Memory.repairSpawnRequests[roomName]) || [];
  var count = 0;
  for (var i = 0; i < reqs.length; i++) if (!reqs[i].spawned && !reqs[i].s) count++;
  return count;
}

function isRoadOrContainer(item) {
  return item.type === STRUCTURE_ROAD || item.type === STRUCTURE_CONTAINER;
}

function sortRepairItems(items, maxHeal) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (maxHeal) { if (!isRoadOrContainer(it)) out.push(it); }
    else if (it.source === 'creep' || it.source === 'both') out.push(it);
  }
  out.sort(function(a, b) {
    var ac = Math.floor(a.x / 10) * 10 + Math.floor(a.y / 10);
    var bc = Math.floor(b.x / 10) * 10 + Math.floor(b.y / 10);
    if (ac !== bc) return ac - bc;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.hits - b.hits;
  });
  return out;
}

function filterRepairItems(items, predicate, maxHeal) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item) continue;
    if (maxHeal) { if (!isRoadOrContainer(item) && predicate(item)) out.push(item); }
    else if ((item.source === 'creep' || item.source === 'both') && predicate(item)) out.push(item);
  }
  return sortRepairItems(out, maxHeal);
}

function isWallOrRampart(item) {
  return item && (item.type === STRUCTURE_WALL || item.type === STRUCTURE_RAMPART);
}

function shardItems(items, shardIndex, shardCount) {
  var ids = [];
  for (var i = 0; i < items.length; i++) {
    if (i % shardCount !== shardIndex) continue;
    ids.push(items[i].id);
  }
  return { structureIds: ids };
}

function hasImminentCollapse(items, rcl) {
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item) continue;

    if (item.type === STRUCTURE_ROAD && typeof item.hitsMax === 'number') {
      if (item.hits < item.hitsMax * ROAD_EMERGENCY_FRACTION) return true;
      continue;
    }

    if (item.type === STRUCTURE_CONTAINER) {
      if (item.hits < Math.floor(250000 * CONTAINER_EMERGENCY_FRACTION)) return true;
      continue;
    }

    if (rcl < 7) continue;

    if (item.type === STRUCTURE_WALL) {
      if (item.hits < WALL_EMERGENCY_HITS) return true;
      continue;
    }

    if (item.type === STRUCTURE_RAMPART) {
      var threshold = item.criticalRampart ? CRITICAL_RAMPART_EMERGENCY_HITS : RAMPART_EMERGENCY_HITS;
      if (item.hits < threshold) return true;
    }
  }
  return false;
}

function hasPeacetimeEmergency(roomName, items) {
  var rm = roomMem(roomName);
  var activeUntil = rm.peaceEmergencyUntil || 0;
  var found = false;

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || !item.hitsMax) continue;
    if (item.type !== STRUCTURE_ROAD && item.type !== STRUCTURE_CONTAINER) continue;
    if (item.hits <= item.hitsMax * PEACETIME_EMERGENCY_FRACTION) {
      found = true;
      break;
    }
  }

  if (found) {
    rm.peaceEmergencyUntil = Game.time + PEACETIME_EMERGENCY_TICKS;
    return true;
  }

  if (activeUntil && Game.time < activeUntil) return true;
  if (activeUntil) delete rm.peaceEmergencyUntil;
  return false;
}

function classifyRepairTier(roomName, rs, rcl, items, roomUnderAttack, nukePlan, stats) {
  var imminentCollapse = hasImminentCollapse(items, rcl);

  if (nukePlan && nukePlan.active) return 'WAR_EMERGENCY';
  if (roomUnderAttack) return imminentCollapse ? 'WAR_EMERGENCY' : 'WAR';
  if (hasPeacetimeEmergency(roomName, items)) return 'PEACE_EMERGENCY';
  return 'PEACE';
}

function shouldBypassCacheForPeacetimeEmergency(roomName, rs) {
  var rm = roomMem(roomName);
  if (rm.peaceEmergencyUntil && Game.time < rm.peaceEmergencyUntil) return true;

  var sbt = rs && rs.structuresByType;
  if (!sbt) return false;
  var types = [STRUCTURE_ROAD, STRUCTURE_CONTAINER];
  for (var ti = 0; ti < types.length; ti++) {
    var arr = sbt[types[ti]] || [];
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (s && s.hitsMax && s.hits <= s.hitsMax * PEACETIME_EMERGENCY_FRACTION) return true;
    }
  }
  return false;
}

function extraCountForTier(tier) {
  var cap = REPAIR_TIERS[tier] || 1;
  return Math.max(0, Math.min(MAX_PARALLEL_REPAIRERS - 1, cap - 1));
}

function buildTargetTask(roomName, items, shardIndex, shardCount, maxHeal) {
  var shard = shardItems(sortRepairItems(items, maxHeal), shardIndex, shardCount);
  return { k: 'target', r: roomName, i: shard.structureIds };
}

function buildWallsTask(roomName, items, shardIndex, shardCount, maxHeal) {
  var wallItems = filterRepairItems(items, isWallOrRampart, maxHeal);
  var shard = shardItems(wallItems, shardIndex, shardCount);
  return { k: 'walls', r: roomName, i: shard.structureIds };
}

function buildRepairTaskForSlot(roomName, items, slot, desired, maxHeal) {
  if (desired <= 1) return buildTargetTask(roomName, items, 0, 1, maxHeal);
  if (slot === 0) return buildTargetTask(roomName, items, 0, 1, maxHeal);
  if (slot === 1) return buildWallsTask(roomName, items, 0, 1, maxHeal);
  var wallShardCount = Math.max(1, desired - 1);
  var wallShardIndex = slot > 1 ? slot - 1 : 0;
  return buildWallsTask(roomName, items, wallShardIndex, wallShardCount, maxHeal);
}

function collectNukeTargets(nukePlan, tierLimit) {
  var items = [];
  if (!nukePlan || !nukePlan.active) return items;
  for (var ti = 0; ti < nukePlan.tiers.length; ti++) {
    var tier = nukePlan.tiers[ti];
    if (tierLimit && tier.tier > tierLimit) continue;
    for (var j = 0; j < tier.targets.length; j++) {
      var t = tier.targets[j];
      if (!t.id) continue;
      items.push({ id: t.id, type: t.type, tier: tier.tier, hits: t.currentHits, target: t.targetHits, x: t.x, y: t.y });
    }
  }
  items.sort(function(a, b) {
    if (a.tier !== b.tier) return a.tier - b.tier;
    var ar = a.target > 0 ? a.hits / a.target : 1;
    var br = b.target > 0 ? b.hits / b.target : 1;
    return ar - br;
  });
  return items;
}

function buildNukeTask(roomName, nukePlan, shardIndex, shardCount) {
  var items = collectNukeTargets(nukePlan);
  var ids = [];
  for (var i = 0; i < items.length; i++) {
    if (i % shardCount !== shardIndex) continue;
    ids.push(items[i].id);
  }
  return { k: 'nuke', r: roomName, i: ids };
}

function buildMedianTask(roomName, clusterIds) {
  return { k: 'median', r: roomName, c: clusterIds || [] };
}

function adoptUnanchoredRepairers() {
  var idx = getRoomState.creepIndex();
  var creeps = idx && idx.all ? idx.all : [];
  for (var i = 0; i < creeps.length; i++) {
    var creep = creeps[i];
    if (!creep || !creep.memory || creep.memory.role !== 'repairer') continue;
    if (creep.memory.homeRoom || creep.memory.assignedRoom) continue;
    creep.memory.homeRoom = creep.room.name;
    creep.memory.assignedRoom = creep.room.name;
    console.log('[RepairManager] Adopted unanchored repairer ' + creep.name + ' into ' + creep.room.name);
  }
}

function taskSize(task) {
  if (!task) return 0;
  if (task.i) return task.i.length + ((task.s && task.s.length) || 0);
  if (task.structureIds) return task.structureIds.length;
  if (task.c) return task.c.length;
  if (task.clusterIds) return task.clusterIds.length;
  return 0;
}

function taskKind(task) {
  return task ? (task.k || task.kind) : null;
}

function isWarAssignmentMode(plan) {
  return !!(plan && ((plan.nukePlan && plan.nukePlan.active) || plan.repairTier === 'WAR' || plan.repairTier === 'WAR_EMERGENCY'));
}

function assignmentLimitForItem(item, warMode) {
  if (!warMode) return 1;
  if (!item) return 1;
  if (item.type === STRUCTURE_RAMPART && (item.criticalRampart || item.nukeTier <= 2)) return MAX_PARALLEL_REPAIRERS;
  if (item.type === STRUCTURE_RAMPART || item.type === STRUCTURE_CONTAINER) return 2;
  return 1;
}

function assignmentPriority(item, plan) {
  if (!item) return 99;
  if (item.nukeTier) return item.nukeTier;
  var warMode = isWarAssignmentMode(plan);
  if (warMode) {
    if (item.type === STRUCTURE_RAMPART && item.criticalRampart) return 10;
    if (item.type === STRUCTURE_WALL || item.type === STRUCTURE_RAMPART) return 20;
    if (item.type === STRUCTURE_CONTAINER) return 30;
    if (item.type === STRUCTURE_ROAD) return 40;
    return 50;
  }
  if (item.type === STRUCTURE_CONTAINER) return 10;
  if (item.type === STRUCTURE_ROAD) return 20;
  if (item.type === STRUCTURE_RAMPART && item.criticalRampart) return 30;
  if (item.type === STRUCTURE_WALL || item.type === STRUCTURE_RAMPART) return 40;
  return 50;
}

function buildAssignmentWorkList(plan) {
  var list = [];
  if (plan.nukePlan && plan.nukePlan.active) {
    var nukeItems = collectNukeTargets(plan.nukePlan);
    for (var n = 0; n < nukeItems.length; n++) {
      var ni = nukeItems[n];
      if (!ni.id) continue;
      list.push({ id: ni.id, type: ni.type || STRUCTURE_RAMPART, x: ni.x, y: ni.y, hits: ni.hits, target: ni.target, deficit: Math.max(0, ni.target - ni.hits), nukeTier: ni.tier, source: 'creep', criticalRampart: ni.tier <= 2 });
    }
  } else {
    for (var i = 0; i < plan.items.length; i++) {
      var item = plan.items[i];
      if (!item) continue;
      if (plan.maxHeal) { if (isRoadOrContainer(item)) continue; }
      else if (item.source !== 'creep' && item.source !== 'both') continue;
      list.push(item);
    }
  }
  list.sort(function(a, b) {
    var ap = assignmentPriority(a, plan);
    var bp = assignmentPriority(b, plan);
    if (ap !== bp) return ap - bp;
    if ((a.deficit || 0) !== (b.deficit || 0)) return (b.deficit || 0) - (a.deficit || 0);
    return (a.hits || 0) - (b.hits || 0);
  });
  return list;
}

function indexItemsById(items) {
  var out = {};
  for (var i = 0; i < items.length; i++) out[items[i].id] = items[i];
  return out;
}

function clearCreepAssignment(creep, assignments) {
  if (creep && creep.memory) {
    delete creep.memory.task;
    delete creep.memory.targetId;
    delete creep.memory.route;
    delete creep.memory.releaseRepairTarget;
  }
  if (assignments && creep) delete assignments[creep.name];
}

function assignmentRoute(assignment, creep) {
  if (creep && creep.memory && creep.memory.route && creep.memory.route.length) return creep.memory.route;
  return assignment && assignment.r || [];
}

function assignmentHead(assignment, creep) {
  if (!assignment) return null;
  if (assignment.k === 'r') {
    var route = assignmentRoute(assignment, creep);
    return route.length ? route[0] : null;
  }
  return assignment.i || null;
}

function isAssignmentValid(assignment, itemById, creep, warMode) {
  if (!assignment || !creep || !creep.memory) return false;
  if (!creep.memory.targetId) return false;
  var head = assignmentHead(assignment, creep);
  if (!head || creep.memory.targetId !== head) return false;
  if (assignment.k === 'r') {
    var route = assignmentRoute(assignment, creep);
    for (var i = 0; i < route.length; i++) {
      var roadItem = itemById[route[i]];
      if (roadItem && roadItem.type === STRUCTURE_ROAD) return true;
    }
    return false;
  }
  var item = itemById[assignment.i];
  if (!item) return false;
  if (item.type === STRUCTURE_WALL || item.type === STRUCTURE_RAMPART) return true;
  return item.hits < item.target || warMode;
}

function countAssignedItems(assignments, itemById) {
  var counts = {};
  for (var name in assignments) {
    var a = assignments[name];
    if (!a) continue;
    if (a.k === 'r') {
      var route = a.r || [];
      for (var i = 0; i < route.length; i++) if (itemById[route[i]]) counts[route[i]] = (counts[route[i]] || 0) + 1;
    } else if (a.i && itemById[a.i]) counts[a.i] = (counts[a.i] || 0) + 1;
  }
  return counts;
}

function findNextAssignment(creep, workList, counts, warMode) {
  for (var i = 0; i < workList.length; i++) {
    var item = workList[i];
    if (!item) continue;
    if ((counts[item.id] || 0) >= assignmentLimitForItem(item, warMode)) continue;
    return { k: 's', i: item.id };
  }
  return null;
}

function applyAssignment(creep, assignment, assignments) {
  delete creep.memory.task;
  delete creep.memory.releaseRepairTarget;
  if (!assignment) return clearCreepAssignment(creep, assignments);
  if (assignment.k === 'r') {
    creep.memory.route = assignment.r || [];
    creep.memory.targetId = creep.memory.route[0] || assignment.i || null;
    assignments[creep.name] = { k: 'r', i: creep.memory.targetId, r: creep.memory.route };
  } else {
    delete creep.memory.route;
    creep.memory.targetId = assignment.i;
    assignments[creep.name] = { k: 's', i: assignment.i };
  }
}

function compactTask(task) {
  if (!task) return task;
  var kind = task.k || task.kind;
  if (kind === 'median') return buildMedianTask(task.homeRoom || task.r, task.clusterIds || task.c || []);
  var ids = task.structureIds || task.i || [];
  if (kind === 'nuke') return { k: 'nuke', r: task.homeRoom || task.r, i: ids };
  if (kind === 'walls') return { k: 'walls', r: task.homeRoom || task.r, i: ids };
  if (kind === 'roads-first') return { k: 'roads-first', r: task.homeRoom || task.r, i: ids, s: task.secondaryIds || task.s || [] };
  return { k: 'target', r: task.homeRoom || task.r, i: ids };
}

function compactLiveRepairMemory() {
  var creeps = 0;
  var idx = getRoomState.creepIndex();
  var list = idx && idx.all ? idx.all : [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!c.memory || !REPAIRER_ROLES[c.memory.role] || !c.memory.task) continue;
    c.memory.task = compactTask(c.memory.task);
    creeps++;
  }
  var reqs = 0;
  if (Memory.repairSpawnRequests) {
    for (var rn in Memory.repairSpawnRequests) {
      var arr = Memory.repairSpawnRequests[rn] || [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].task) arr[i].task = compactTask(arr[i].task);
        if (arr[i].body && !arr[i].b) { arr[i].b = compactBody(arr[i].body); delete arr[i].body; }
        if (arr[i].createdAt && !arr[i].ct) { arr[i].ct = arr[i].createdAt; delete arr[i].createdAt; }
        if (arr[i].homeRoom && !arr[i].r) { arr[i].r = arr[i].homeRoom; delete arr[i].homeRoom; }
        reqs++;
      }
    }
  }
  return { creeps: creeps, requests: reqs };
}

function desiredRepairerCount(plan) {
  if (plan && plan.maxHeal) return 3;
  var tier = plan && plan.repairTier ? plan.repairTier : 'PEACE';
  return Math.min(MAX_PARALLEL_REPAIRERS, REPAIR_TIERS[tier] || 1);
}

function assignRepairerTargets(roomName, plan) {
  var repairers = getRepairers(roomName);
  var compact = Memory.repairPlan[roomName] || (Memory.repairPlan[roomName] = {});
  var assignments = compact.a || compact.assignments || {};
  var workList = buildAssignmentWorkList(plan);
  plan.workList = workList;
  if (!repairers.length) {
    compact.a = {};
    plan.assignments = {};
    return;
  }
  repairers.sort(function(a, b) {
    var ar = a.memory && a.memory.role === 'repairer' ? 1 : 0;
    var br = b.memory && b.memory.role === 'repairer' ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.name < b.name ? -1 : 1;
  });
  var itemById = indexItemsById(workList);
  var activeRepairers = {};
  var warMode = isWarAssignmentMode(plan);

  for (var i = 0; i < repairers.length; i++) {
    var creep = repairers[i];
    activeRepairers[creep.name] = true;
    if (creep.memory.role === 'repairer' && !creep.memory.homeRoom && !creep.memory.assignedRoom) {
      creep.memory.homeRoom = roomName;
      creep.memory.assignedRoom = roomName;
      console.log('[RepairManager] Adopted repairer ' + creep.name + ' into ' + roomName);
    }
  }

  for (var name in assignments) {
    if (!activeRepairers[name] || !Game.creeps[name]) delete assignments[name];
  }

  for (var v = 0; v < repairers.length; v++) {
    var vc = repairers[v];
    var current = assignments[vc.name];
    var releaseId = vc.memory && vc.memory.releaseRepairTarget;
    if (current && releaseId && (current.i === releaseId || (current.r && current.r.indexOf(releaseId) !== -1))) {
      clearCreepAssignment(vc, assignments);
    } else if (current && isAssignmentValid(current, itemById, vc, warMode)) {
      applyAssignment(vc, current, assignments);
    } else {
      clearCreepAssignment(vc, assignments);
    }
  }

  var counts = countAssignedItems(assignments, itemById);
  for (var a = 0; a < repairers.length; a++) {
    var ac = repairers[a];
    if (assignments[ac.name]) continue;
    var next = findNextAssignment(ac, workList, counts, warMode);
    if (!next) {
      clearCreepAssignment(ac, assignments);
      continue;
    }
    applyAssignment(ac, next, assignments);
    if (next.k === 'r') {
      for (var r = 0; r < next.r.length; r++) counts[next.r[r]] = (counts[next.r[r]] || 0) + 1;
    } else counts[next.i] = (counts[next.i] || 0) + 1;
  }

  compact.a = assignments;
  plan.assignments = assignments;
  plan.workList = workList;
}

function assignRepairerTasks(roomName, plan) {
  assignRepairerTargets(roomName, plan);
}

function ensureCreepAssignment(creep) {
  if (!creep || !creep.memory) return null;
  var roomName = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
  var room = Game.rooms[roomName];
  if (!room || !room.controller || !room.controller.my) return null;
  var plan = buildPlan(roomName, false);
  if (!plan) return null;
  assignRepairerTargets(roomName, plan);
  return creep.memory.targetId || null;
}

function assignLegacyRepairerTasks(roomName, plan) {
  var repairers = getRepairers(roomName);
  if (!repairers.length) return;
  repairers.sort(function(a, b) {
    var ar = a.memory && a.memory.role === 'repairer' ? 1 : 0;
    var br = b.memory && b.memory.role === 'repairer' ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.name < b.name ? -1 : 1;
  });
  var nukeActive = plan.nukePlan && plan.nukePlan.active;
  var medianRequests = plan.medianRequests || [];
  var desired = desiredRepairerCount(plan);
  var shardCount = Math.max(1, Math.min(repairers.length, desired));
  for (var i = 0; i < repairers.length; i++) {
    var creep = repairers[i];
    if (creep.memory.role === 'repairer' && !creep.memory.homeRoom && !creep.memory.assignedRoom) {
      creep.memory.homeRoom = roomName;
      creep.memory.assignedRoom = roomName;
      console.log('[RepairManager] Adopted repairer ' + creep.name + ' into ' + roomName);
    }
    if (i >= desired) {
      delete creep.memory.task;
      delete creep.memory.targetId;
      continue;
    }
    var task;
    if (nukeActive) task = buildNukeTask(roomName, plan.nukePlan, i % shardCount, shardCount);
    else if (medianRequests.length && i < medianRequests.length) {
      task = buildMedianTask(roomName, medianRequests[i].clusterIds || []);
    } else task = buildRepairTaskForSlot(roomName, plan.items, i, desired, plan.maxHeal);
    if (taskSize(task) === 0) {
      delete creep.memory.task;
      delete creep.memory.targetId;
    } else {
      delete creep.memory.repairQueue;
      delete creep.memory.repairThresholds;
      delete creep.memory.energySourceId;
      delete creep.memory.clusterIds;
      delete creep.memory.repairId;
      delete creep.memory.targetId;
      creep.memory.task = task;
      creep.memory.homeRoom = roomName;
      creep.memory.assignedRoom = roomName;
    }
  }
}

function writeSpawnRequests(roomName, room, plan, roomUnderAttack) {
  if (!Memory.repairSpawnRequests) Memory.repairSpawnRequests = {};
  var current = Memory.repairSpawnRequests[roomName] || [];
  for (var c = current.length - 1; c >= 0; c--) {
    if (Game.time - (current[c].ct || current[c].createdAt || Game.time) > REQUEST_TTL || current[c].spawned || current[c].s) current.splice(c, 1);
    else if (current[c].task) current[c].task = compactTask(current[c].task);
  }
  Memory.repairSpawnRequests[roomName] = current;
  var existing = getRepairers(roomName).length;
  var pending = getPendingRepairerCount(roomName);
  var maxHeal = plan.maxHeal;
  var hasAnyWork = plan.stats.creepHits > 0
    || (plan.nukePlan && plan.nukePlan.active)
    || (plan.medianRequests && plan.medianRequests.length > 0)
    || (maxHeal && plan.items && plan.items.length > 0);
  if (!hasAnyWork) { Memory.repairSpawnRequests[roomName] = []; return; }

  var desired = desiredRepairerCount(plan);
  var missing = Math.max(0, desired - existing - pending);
  if (missing <= 0) return;

  var newReqs = [];
  for (var i = 0; i < missing; i++) {
    var slot = existing + pending + i;
    var kind = slot === 0 ? 'baseline' : 'extra';
    var priority = plan.nukePlan && plan.nukePlan.active ? 5 : (kind === 'baseline' ? 6 : 7);
    var totalWork = Math.max(plan.stats.creepHits, 1);
    var maxSingle = Math.max(plan.stats.maxSingleHits, 1);
    if (maxHeal) {
      var sumHits = 0;
      var maxHit = 0;
      for (var hi = 0; hi < plan.items.length; hi++) {
        var it = plan.items[hi];
        if (!it || typeof it.deficit !== 'number') continue;
        sumHits += it.deficit;
        if (it.deficit > maxHit) maxHit = it.deficit;
      }
      if (sumHits > totalWork) totalWork = sumHits;
      if (maxHit > maxSingle) maxSingle = maxHit;
    }
    var sized = sizeDispatch({
      totalHits: totalWork,
      maxSingleHits: maxSingle,
      availableEnergy: room.energyCapacityAvailable || room.energyAvailable || BODY_MIN_COST,
      movementProfile: 'mixed',
      urgency: plan.nukePlan && plan.nukePlan.active ? 1.0 : (roomUnderAttack ? 0.9 : (maxHeal ? 0.7 : 0.4)),
      towerFraction: 0
    });
    var task;
    if (plan.nukePlan && plan.nukePlan.active) task = buildNukeTask(roomName, plan.nukePlan, slot % desired, desired);
    else if (plan.medianRequests && plan.medianRequests.length && slot < plan.medianRequests.length) {
      task = buildMedianTask(roomName, plan.medianRequests[slot].clusterIds || []);
    } else task = buildRepairTaskForSlot(roomName, plan.items, slot, desired, maxHeal);
    if (taskSize(task) === 0) continue;
    newReqs.push({
      id: roomName + '_' + kind + '_' + slot,
      role: 'repairer',
      kind: kind,
      priority: priority,
      emergency: plan.repairTier !== 'PEACE' ? 1 : (maxHeal ? 1 : 0),
      maxHeal: maxHeal ? 1 : 0,
      b: compactBody(sized.body),
      cost: sized.cost,
      ct: Game.time,
      r: roomName,
      task: task
    });
  }

  for (var n = 0; n < newReqs.length; n++) current.push(newReqs[n]);
  Memory.repairSpawnRequests[roomName] = current;
}

function shouldUseWarCadence(roomName, room, rs, nukePlan) {
  if (nukePlan && nukePlan.active) return true;
  if (hasGlobalScannerWarPlayer()) return true;
  var hostiles = rs.hostiles || [];
  for (var i = 0; i < hostiles.length; i++) if (isRealHostile(hostiles[i])) return true;
  var known = Memory.defense && Memory.defense.knownHostiles && Memory.defense.knownHostiles[roomName];
  return known && known.length > 0;
}

function buildPlan(roomName, force) {
  ensureMemory();
  var room = Game.rooms[roomName];
  if (!room || !room.controller || !room.controller.my) {
    clearVisibleUnownedRepairWork(roomName);
    return null;
  }
  var rs = getRoomState.get(roomName);
  if (!rs || !rs.structuresByType) return null;
  var rcl = room.controller.level;
  var nukePlan = buildNukePlan(roomName, rs);
  var cadence = shouldUseWarCadence(roomName, room, rs, nukePlan) ? WARTIME_SCAN_INTERVAL : PEACETIME_SCAN_INTERVAL;
  var prev = Memory.repairPlan[roomName];
  var bypassCache = !force && !shouldUseWarCadence(roomName, room, rs, nukePlan) && shouldBypassCacheForPeacetimeEmergency(roomName, rs);
  if (!force && !bypassCache && isCompactPlan(prev) && planTick(prev) && Game.time - planTick(prev) < cadence) {
    var cached = global._repairPlanCache[roomName];
    if (cached && cached.repairTier) {
      writeHealQueue(roomName, cached, rs);
      assignRepairerTasks(roomName, cached);
      writeSpawnRequests(roomName, room, cached, shouldUseWarCadence(roomName, room, rs, nukePlan));
      return cached;
    }
  }

  var rm = roomMem(roomName);
  var realHostile = false;
  var hostiles = rs.hostiles || [];
  for (var hi = 0; hi < hostiles.length; hi++) if (isRealHostile(hostiles[hi])) { realHostile = true; break; }
  if (realHostile) rm.lastRealHostileTick = Game.time;

  var items = classifyItems(buildItems(roomName, rs, rcl), rcl, rs);
  var stats = computeStats(items);
  var maxHeal = isMaxHeal(roomName);
  var towerQueue = buildTowerQueue(items, maxHeal);
  var healQueue = buildHealQueue(rs);
  var medianRequests = (Memory.defense && Memory.defense.repairOrders && Memory.defense.repairOrders[roomName]) || [];
  var roomUnderAttack = shouldUseWarCadence(roomName, room, rs, nukePlan);
  var repairTier = classifyRepairTier(roomName, rs, rcl, items, roomUnderAttack, nukePlan, stats);
  stats.repairTier = repairTier;
  var requests = buildRequestPreview(roomName, room, items, stats, nukePlan, repairTier, medianRequests);
  var repairTowerLimit = roomUnderAttack ? TOWER_REPAIR_LIMIT_WITH_HOSTILES : null;
  if (nukePlan.active) repairTowerLimit = TOWER_REPAIR_LIMIT_DURING_NUKE;

  var plan = {
    tick: Game.time,
    roomName: roomName,
    cadence: cadence,
    items: items,
    towerQueue: towerQueue,
    healQueue: healQueue,
    healQueueTick: Game.time,
    towerPolicy: { repairTowerLimit: repairTowerLimit, reservePerTower: TOWER_ENERGY_RESERVE, allowRepairDuringHostiles: true, maxHeal: maxHeal, spreadTargets: repairTier === 'PEACE_EMERGENCY' },
    nukePlan: nukePlan,
    medianRequests: medianRequests,
    requests: requests,
    stats: stats,
    repairTier: repairTier,
    maxHeal: maxHeal,
    planFreshTtl: PLAN_FRESH_TTL
  };
  if (!Memory.towers) Memory.towers = {};
  if (nukePlan.active || realHostile || maxHeal || repairTier === 'PEACE_EMERGENCY') Memory.towers[roomName] = 1;
  else delete Memory.towers[roomName];
  assignRepairerTasks(roomName, plan);
  writeSpawnRequests(roomName, room, plan, roomUnderAttack);
  writePlan(roomName, plan);
  return plan;
}

function run() {
  ensureMemory();
  adoptUnanchoredRepairers();
  for (var roomName in Game.rooms) {
    if (roomSuspender.shouldAvoidRoomWork(roomName)) continue;
    buildPlan(roomName, false);
  }
}

function formatNumber(n) {
  if (n === null || n === undefined) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n));
}

function planText(roomName) {
  ensureMemory();
  var rooms = roomName ? [roomName] : ownedVisibleRooms();
  var lines = ['=== Repair Plan ==='];
  for (var i = 0; i < rooms.length; i++) {
    var rn = rooms[i];
    if (!isOwnedVisibleRoom(rn)) {
      clearVisibleUnownedRepairWork(rn);
      if (roomName) lines.push(rn + ': no owned controller');
      continue;
    }
    var p = buildPlan(rn, true);
    if (!p) continue;
    lines.push(rn + ' tick:' + p.tick + ' cadence:' + p.cadence + ' tier:' + p.repairTier + ' items:' + p.items.length + ' towerQ:' + p.towerQueue.length + ' healQ:' + ((p.healQueue && p.healQueue.length) || 0) + ' creepHits:' + formatNumber(p.stats.creepHits));
    if (p.nukePlan && p.nukePlan.active) lines.push('  NUKE eta:' + p.nukePlan.eta + ' tiers:' + p.nukePlan.tiers.length);
    for (var r = 0; r < p.requests.length; r++) lines.push('  request ' + p.requests[r].kind + ' p' + p.requests[r].priority + ' x' + p.requests[r].count + ' cost:' + p.requests[r].bodyCost + ' work:' + formatNumber(p.requests[r].totalWork));
  }
  return lines.join('\n');
}

function statusText(roomName) {
  var lines = ['=== Repair Status ==='];
  var rooms = roomName ? [roomName] : ownedVisibleRooms();
  for (var i = 0; i < rooms.length; i++) {
    var rn = rooms[i];
    if (!isOwnedVisibleRoom(rn)) {
      clearVisibleUnownedRepairWork(rn);
      if (roomName) lines.push(rn + ': no owned controller');
      continue;
    }
    var active = 0, idle = 0;
    var idx = getRoomState.creepIndex();
    var creeps = idx && idx.all ? idx.all : [];
    for (var ci = 0; ci < creeps.length; ci++) {
      var c = creeps[ci];
      var anchor = c.memory && (c.memory.homeRoom || c.memory.assignedRoom) || null;
      if (c.memory.role === 'repairer' && anchor === rn) {
        if (c.memory.targetId) active++;
        else idle++;
      }
    }
    var p = Memory.repairPlan && Memory.repairPlan[rn];
    lines.push(rn + ' repairers:' + active + ' idle:' + idle + ' tier:' + (p ? (p.rt || p.tier || 'unknown') : 'none') + ' planAge:' + (p ? Game.time - planTick(p) : 'none'));
  }
  return lines.join('\n');
}

function dispatchText(roomName) {
  var lines = ['=== Repair Dispatch ==='];
  var rooms = roomName ? [roomName] : ownedVisibleRooms();
  for (var i = 0; i < rooms.length; i++) {
    if (!isOwnedVisibleRoom(rooms[i])) {
      clearVisibleUnownedRepairWork(rooms[i]);
      if (roomName) lines.push(rooms[i] + ': no owned controller');
      continue;
    }
    buildPlan(rooms[i], true);
    var reqs = (Memory.repairSpawnRequests && Memory.repairSpawnRequests[rooms[i]]) || [];
    lines.push(rooms[i] + ':');
    if (!reqs.length) lines.push('  no requests');
    for (var r = 0; r < reqs.length; r++) {
      lines.push('  ' + reqs[r].kind + ' p' + reqs[r].priority + ' cost:' + reqs[r].cost +
        ' ids:' + taskSize(reqs[r].task) +
        (reqs[r].blockedReason ? ' blocked:' + reqs[r].blockedReason : ''));
    }
  }
  return lines.join('\n');
}

function cacheBuildings(roomName) {
  var room = Game.rooms[roomName];
  if (!room) return 'No vision for ' + roomName;
  var rm = roomMem(roomName);
  var structures = [];
  var set = {};
  for (var i = 0; i < REBUILD_TYPES.length; i++) set[REBUILD_TYPES[i]] = true;
  var all = room.find(FIND_RUINS);
  for (var j = 0; j < all.length; j++) {
    var ruin = all[j];
    var s = ruin.structure;
    if (!s || !set[s.structureType]) continue;
    var present = room.lookForAt(LOOK_STRUCTURES, ruin.pos.x, ruin.pos.y).some(function(live) { return live.structureType === s.structureType; });
    if (!present) structures.push({ type: s.structureType, x: ruin.pos.x, y: ruin.pos.y });
  }
  rm.buildingCache = { updatedAt: Game.time, structures: structures };
  return 'Cached ' + structures.length + ' ruined structures for ' + roomName;
}

function cacheStatus(roomName) {
  var rm = roomMem(roomName);
  if (!rm.buildingCache) return 'No ruin cache for ' + roomName;
  return roomName + ' cachedRuins:' + rm.buildingCache.structures.length + ' updated:' + rm.buildingCache.updatedAt;
}

function forgetCache(roomName) {
  var rm = roomMem(roomName);
  delete rm.buildingCache;
  return 'Forgot ruin cache for ' + roomName;
}

function destroyCached(roomName, type, confirm) {
  if (confirm !== 'CONFIRM') return 'Usage: repairDestroyCached(roomName, type?, "CONFIRM")';
  var room = Game.rooms[roomName];
  if (!room) return 'No vision for ' + roomName;
  var rm = roomMem(roomName);
  if (!rm.buildingCache) return 'No ruin cache for ' + roomName;
  var destroyed = 0;
  for (var i = 0; i < rm.buildingCache.structures.length; i++) {
    var e = rm.buildingCache.structures[i];
    if (type && e.type !== type) continue;
    var structs = room.lookForAt(LOOK_STRUCTURES, e.x, e.y);
    for (var j = 0; j < structs.length; j++) {
      var s = structs[j];
      if (s.structureType === e.type && s.my && typeof s.destroy === 'function') {
        if (s.destroy() === OK) destroyed++;
      }
    }
  }
  return 'Destroyed ' + destroyed + ' cached structures in ' + roomName;
}

function rebuildMissing(roomName) {
  var room = Game.rooms[roomName];
  if (!room) return 'No vision for ' + roomName;
  var rm = roomMem(roomName);
  if (!rm.buildingCache) return 'No ruin cache for ' + roomName;
  var made = 0, skippedMineral = 0;
  var rs = getRoomState.get(roomName);
  var lastReal = rm.lastRealHostileTick || 0;
  for (var i = 0; i < rm.buildingCache.structures.length; i++) {
    var e = rm.buildingCache.structures[i];
    var present = room.lookForAt(LOOK_STRUCTURES, e.x, e.y).some(function(s) { return s.structureType === e.type; });
    if (present) continue;
    var sitePresent = room.lookForAt(LOOK_CONSTRUCTION_SITES, e.x, e.y).some(function(s) { return s.structureType === e.type; });
    if (sitePresent) continue;
    if (e.type === STRUCTURE_CONTAINER && rs) {
      var fake = { pos: new RoomPosition(e.x, e.y, roomName) };
      if (isMineralContainer(fake, rs) && Game.time - lastReal < HOSTILE_FREE_FOR_MINERAL_REBUILD) { skippedMineral++; continue; }
    }
    var res = room.createConstructionSite(e.x, e.y, e.type);
    if (res === OK) made++;
  }
  return 'Created ' + made + ' construction sites in ' + roomName + (skippedMineral ? ', skipped mineral containers:' + skippedMineral : '');
}

function nukePlanText(roomName) {
  var p = buildPlan(roomName, true);
  if (!p || !p.nukePlan || !p.nukePlan.active) return 'No active nuke plan for ' + roomName;
  var lines = ['=== Nuke Plan ' + roomName + ' eta:' + p.nukePlan.eta + ' ==='];
  for (var i = 0; i < p.nukePlan.tiers.length; i++) {
    var t = p.nukePlan.tiers[i];
    lines.push('T' + t.tier + ' ' + t.name + ' targets:' + t.targets.length + ' work:' + formatNumber(t.totalWork));
  }
  return lines.join('\n');
}

function setTarget(roomName, type, hits) {
  if (!roomName || !type || !hits) return 'Usage: repairSetTarget(roomName, type, hits)';
  var rm = roomMem(roomName);
  rm.targetOverrides[type] = Math.max(1, Math.floor(hits));
  buildPlan(roomName, true);
  return 'Repair target override set for ' + roomName + ' / ' + type + ' = ' + rm.targetOverrides[type];
}

function resetTargets(roomName) {
  if (roomName) {
    var rm = roomMem(roomName);
    rm.targetOverrides = {};
    buildPlan(roomName, true);
    return 'Repair target overrides reset for ' + roomName;
  }
  ensureMemory();
  for (var rn in Memory.repairManager.rooms) {
    Memory.repairManager.rooms[rn].targetOverrides = {};
  }
  return 'Repair target overrides reset globally';
}

function suggestBoost(roomName) {
  var p = buildPlan(roomName, true);
  if (!p) return 'No repair plan for ' + roomName;
  if (p.nukePlan && p.nukePlan.active) {
    return roomName + ': nuke plan active, suggest XLH2O for task tier 1/2 repairers if labs are ready.';
  }
  if (p.stats.creepHits >= 9000000) return roomName + ': heavy repair work (' + formatNumber(p.stats.creepHits) + '), suggest XLH2O if available.';
  if (p.stats.creepHits >= 3000000) return roomName + ': moderate repair work (' + formatNumber(p.stats.creepHits) + '), suggest LH2O if available.';
  return roomName + ': no boost suggested.';
}

function cleanup() {
  var compacted = compactLiveRepairMemory();
  delete Memory.wallRepairOrders;
  delete Memory.repairPlan;
  delete Memory.repairSpawnRequests;
  if (global._repairPlanCache) global._repairPlanCache = {};
  if (Memory.defense) delete Memory.defense.repairOrders;
  if (Memory.spawnPause) { delete Memory.spawnPause.wallRepair; delete Memory.spawnPause.rampartBot; }
  for (var k in Memory) {
    if (k.indexOf('rampartBotCooldown_') === 0 || k.indexOf('repairSuggestedBoost_') === 0) delete Memory[k];
  }
  return 'Repair manager cleanup complete. Compacted creeps:' + compacted.creeps + ' requests:' + compacted.requests;
}

function compactPlansNow(roomName) {
  ensureMemory();
  var compacted = compactLiveRepairMemory();
  var rooms = roomName ? [roomName] : Object.keys(Game.rooms);
  var rebuilt = 0;
  for (var i = 0; i < rooms.length; i++) {
    if (buildPlan(rooms[i], true)) rebuilt++;
  }
  return 'Compacted repair plans for ' + rebuilt + ' rooms. Compacted creeps:' + compacted.creeps + ' requests:' + compacted.requests;
}

function compactRepairMemoryNow() {
  var compacted = compactLiveRepairMemory();
  return 'Compacted repair memory. Creeps:' + compacted.creeps + ' requests:' + compacted.requests;
}

function installGlobals() {
  global.repairPlan = function(roomName) { return planText(roomName); };
  global.repairStatus = function(roomName) { return statusText(roomName); };
  global.repairDispatch = function(roomName) { return dispatchText(roomName); };
  global.repairSize = function(opts) { return JSON.stringify(sizeDispatch(opts || {})); };
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
  global.repairPause = function(roomName) {
    if (!Memory.spawnPause) Memory.spawnPause = {};
    if (!Memory.spawnPause.repairer) Memory.spawnPause.repairer = { rooms: {} };
    if (roomName) { Memory.spawnPause.repairer.rooms[roomName] = true; return 'Repair paused for ' + roomName; }
    Memory.spawnPause.repairer.global = true; return 'Repair paused globally';
  };
  global.repairResume = function(roomName) {
    if (!Memory.spawnPause || !Memory.spawnPause.repairer) return 'Repair was not paused';
    if (roomName) { delete Memory.spawnPause.repairer.rooms[roomName]; return 'Repair resumed for ' + roomName; }
    delete Memory.spawnPause.repairer.global; return 'Repair resumed globally';
  };
  global.repairMaxHeal = function(roomName, opts) {
    if (roomName === undefined || roomName === null) {
      ensureMemory();
      var lines = ['=== Max Heal Rooms ==='];
      var any = false;
      for (var rn in Memory.repairManager.rooms) {
        if (isMaxHeal(rn)) {
          any = true;
          var rm = Memory.repairManager.rooms[rn];
          var exp = rm.maxHealUntil ? ' (until tick ' + rm.maxHealUntil + ')' : ' (persistent)';
          lines.push(rn + exp);
        }
      }
      if (!any) lines.push('No rooms have max-heal enabled.');
      return lines.join('\n');
    }
    if (opts === false) {
      var r = roomMem(roomName);
      delete r.maxHeal;
      delete r.maxHealUntil;
      if (Memory.towers) delete Memory.towers[roomName];
      buildPlan(roomName, true);
      return 'Max heal DISABLED for ' + roomName;
    }
    if (typeof opts === 'number' && opts > 0) {
      var r2 = roomMem(roomName);
      r2.maxHeal = true;
      r2.maxHealUntil = Game.time + opts;
      if (!Memory.towers) Memory.towers = {};
      Memory.towers[roomName] = 1;
      buildPlan(roomName, true);
      return 'Max heal ENABLED for ' + roomName + ' for ' + opts + ' ticks (until ' + r2.maxHealUntil + ')';
    }
    var r3 = roomMem(roomName);
    r3.maxHeal = true;
    delete r3.maxHealUntil;
    if (!Memory.towers) Memory.towers = {};
    Memory.towers[roomName] = 1;
    buildPlan(roomName, true);
    return 'Max heal ENABLED for ' + roomName + ' (persistent)';
  };
  global.repairMax = global.repairMaxHeal;
  global.requestTaskBoost = function(roomName, taskId, compound, parts) {
    if (!global.boost) return 'boostManager global.boost is not available';
    var compounds = {}; compounds[compound] = parts || 21;
    var body = computeBody(BODY_MAX_COST, 'mixed');
    return global.boost(roomName, 'task_' + taskId, compounds, body);
  };
  global.orderWallRepair = function() { return 'orderWallRepair is replaced by repairManager. Use repairPlan(), repairSetTarget(), and repairDispatch().'; };
  global.cancelWallRepair = function() { return 'cancelWallRepair is replaced by repairPause(roomName) or repairResetTargets(roomName).'; };
  global.wallRepairStatus = function(roomName) { return statusText(roomName); };
  global.wallRepairOverview = function() { return planText(); };
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
  sizeDispatch: sizeDispatch,
  computeBody: computeBody,
  bodyCost: bodyCost,
  isMaxHeal: isMaxHeal,
  constants: {
    MAX_PARALLEL_REPAIRERS: MAX_PARALLEL_REPAIRERS,
    EXTRA_REPAIR_STORAGE_MIN: EXTRA_REPAIR_STORAGE_MIN,
    PLAN_FRESH_TTL: PLAN_FRESH_TTL,
    RAMPART_TARGETS: RAMPART_TARGETS,
    TOWER_REPAIR_CAP_BY_TYPE: TOWER_REPAIR_CAP_BY_TYPE
  }
};
