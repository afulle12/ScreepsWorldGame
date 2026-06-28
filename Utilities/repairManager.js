// repairManager.js
// Unified repair planning layer. Computes room repair/nuke plans and
// exposes console commands; existing repair roles and spawn logic
// remain authoritative until migration is complete.
//
// ── REPAIR ROLES ─────────────────────────────────────────────────────
//   repairer      — generic task executor for repairManager plans
//   repairBot     — legacy road/container repairer (bodies & spawn
//                   logic in spawnManager.js:777, 1882-1947)
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
//     targetOverrides, buildingCache, lastRealHostileTick }
//   Memory.repairPlan[roomName]           — compact plan
//   Memory.repairSpawnRequests[roomName]  — pending spawn requests
//   Memory.spawnPause.repairer            — { rooms, global }
//   Memory.repairBotCooldown[roomName]    — legacy repairBot cooldown
//   global._repairPlanCache[roomName]     — live plan cache

var getRoomState = require('getRoomState');
var defenseMonitor = require('defenseMonitor');

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
var ROAD_EMERGENCY_FRACTION = 0.30;
var CONTAINER_EMERGENCY_FRACTION = 0.30;
var WALL_EMERGENCY_HITS = 1000000;
var RAMPART_EMERGENCY_HITS = 1000000;
var CRITICAL_RAMPART_EMERGENCY_HITS = 5000000;
var WAR_EMERGENCY_HITS = 9000000;

var REPAIR_TIERS = {
  PEACE: 1,
  PEACE_EMERGENCY: 2,
  WAR: 3,
  WAR_EMERGENCY: 4
};

// Keep these defaults aligned with the existing spawnManager / role modules
// until those constants are exported and this module can import them directly.
var WALLREPAIR_THRESHOLD_BY_RCL = [0, 0, 10000, 50000, 200000, 1000000, 5000000, 10000000, 50000000];
var RCL_TOWER_CAP = [0, 0, 10000, 50000, 200000, 1000000, 1000000, 1000000, 1000000];
var CRITICAL_RAMPART_TOWER_CAP = 10500000;
var RAMPARTBOT_EXTERNAL_TARGET = 50000000;
var RAMPARTBOT_PERIMETER_RANGE = 3;
var ROAD_DONE_THRESHOLD = 0.99;
var CONTAINER_DONE_HITS = 244000;

var RAMPART_TARGETS = {};
RAMPART_TARGETS[STRUCTURE_SPAWN] = 60500000;
RAMPART_TARGETS[STRUCTURE_TERMINAL] = 60500000;
RAMPART_TARGETS[STRUCTURE_STORAGE] = 60500000;
RAMPART_TARGETS[STRUCTURE_TOWER] = 5500000;
RAMPART_TARGETS[STRUCTURE_LINK] = 5500000;
RAMPART_TARGETS[STRUCTURE_NUKER] = 10500000;
RAMPART_TARGETS[STRUCTURE_FACTORY] = 5500000;
RAMPART_TARGETS[STRUCTURE_LAB] = 5500000;
RAMPART_TARGETS[STRUCTURE_POWER_SPAWN] = 10500000;
RAMPART_TARGETS[STRUCTURE_OBSERVER] = 5500000;

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
  defenseRepair: true,
  repairBot: true
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
    Memory.repairManager.rooms[roomName] = { inaccessible: {}, targetOverrides: {} };
  }
  if (!Memory.repairManager.rooms[roomName].inaccessible) Memory.repairManager.rooms[roomName].inaccessible = {};
  if (!Memory.repairManager.rooms[roomName].targetOverrides) Memory.repairManager.rooms[roomName].targetOverrides = {};
  return Memory.repairManager.rooms[roomName];
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
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c.memory || !REPAIRER_ROLES[c.memory.role]) continue;
    var anchor = c.memory.homeRoom || c.memory.assignedRoom || null;
    if (anchor !== roomName) continue;
    delete c.memory.task;
    delete c.memory.targetId;
  }
}

function bodyCost(body) {
  var cost = 0;
  for (var i = 0; i < body.length; i++) {
    var p = body[i];
    if (p === WORK) cost += 100;
    else if (p === CARRY || p === MOVE) cost += 50;
    else if (p === ATTACK) cost += 80;
    else if (p === RANGED_ATTACK) cost += 150;
    else if (p === HEAL) cost += 250;
    else if (p === CLAIM) cost += 600;
    else if (p === TOUGH) cost += 10;
  }
  return cost;
}

function compactBody(body) {
  var counts = {};
  for (var i = 0; i < body.length; i++) counts[body[i]] = (counts[body[i]] || 0) + 1;
  return counts;
}

function computeBody(budget, movementProfile) {
  budget = Math.min(BODY_MAX_COST, Math.max(BODY_MIN_COST, budget || BODY_MIN_COST));
  var workCarryRatio = 1.5;
  var moveMultiplier = 0.75;
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
  var sbt = rs && rs.structuresByType ? rs.structuresByType : {};
  for (var type in RAMPART_TARGETS) {
    var arr = sbt[type] || [];
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (s && rampart.pos.getRangeTo(s.pos) <= 1 && RAMPART_TARGETS[type] > maxTarget) {
        maxTarget = RAMPART_TARGETS[type];
      }
    }
  }
  if (maxTarget === 0 && isPerimeter(rampart.pos)) maxTarget = RAMPARTBOT_EXTERNAL_TARGET;
  var cap = RAMPART_HITS_MAX[rcl] || 0;
  if (cap > 0 && maxTarget > cap) maxTarget = cap;
  return maxTarget;
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
    return RCL_TOWER_CAP[rcl] || 0;
  }
  return item.target || 0;
}

function buildItems(roomName, rs, rcl) {
  var items = [];
  var sbt = rs && rs.structuresByType ? rs.structuresByType : {};
  var wallTarget = getWallTarget(roomName, rcl);

  var walls = sbt[STRUCTURE_WALL] || [];
  for (var wi = 0; wi < walls.length; wi++) {
    var wall = walls[wi];
    if (!wall || typeof wall.hits !== 'number' || wall.hits >= wallTarget) continue;
    items.push({ id: wall.id, type: STRUCTURE_WALL, x: wall.pos.x, y: wall.pos.y, hits: wall.hits, target: wallTarget });
  }

  var ramparts = sbt[STRUCTURE_RAMPART] || [];
  for (var ri = 0; ri < ramparts.length; ri++) {
    var ramp = ramparts[ri];
    if (!ramp || !ramp.my || typeof ramp.hits !== 'number') continue;
    var target = getRampartTarget(ramp, rs, rcl);
    if (target <= 0 || ramp.hits >= target) continue;
    items.push({ id: ramp.id, type: STRUCTURE_RAMPART, x: ramp.pos.x, y: ramp.pos.y, hits: ramp.hits, target: target, criticalRampart: target >= CRITICAL_RAMPART_TOWER_CAP });
  }

  var roads = sbt[STRUCTURE_ROAD] || [];
  for (var ro = 0; ro < roads.length; ro++) {
    var road = roads[ro];
    if (!road || typeof road.hits !== 'number' || !road.hitsMax) continue;
    var roadTarget = Math.floor(road.hitsMax * ROAD_DONE_THRESHOLD);
    if (road.hits < roadTarget) items.push({ id: road.id, type: STRUCTURE_ROAD, x: road.pos.x, y: road.pos.y, hits: road.hits, hitsMax: road.hitsMax, target: roadTarget });
  }

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
    if (item.target > item.towerCap) item.source = 'creep';
    else if (!towerHasEnergy) item.source = 'creep';
    else if (item.peerCount >= 10) item.source = 'tower';
    else item.source = 'both';
  }
  return items;
}

function towerPriority(item) {
  if (item.type === STRUCTURE_CONTAINER) return 1;
  if (item.type === STRUCTURE_ROAD) return 2;
  if (item.type !== STRUCTURE_WALL && item.type !== STRUCTURE_RAMPART) return 3;
  if (item.hits < 1000000) return 4;
  if (item.type === STRUCTURE_RAMPART && item.criticalRampart && item.hits < CRITICAL_RAMPART_TOWER_CAP) return 5;
  return 6;
}

function buildTowerQueue(items) {
  var q = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.source !== 'tower' && it.source !== 'both') continue;
    q.push({ id: it.id, pri: towerPriority(it), val: it.hits, border: (it.x === 0 || it.x === 49 || it.y === 0 || it.y === 49) ? 1 : 0 });
  }
  q.sort(function(a, b) {
    if (a.pri !== b.pri) return a.pri - b.pri;
    if (a.border !== b.border) return a.border - b.border;
    return a.val - b.val;
  });
  return q;
}

function compactTowerQueue(queue) {
  var out = [];
  var limit = Math.min(queue.length, MAX_SERIALIZED_TOWER_QUEUE);
  for (var i = 0; i < limit; i++) {
    var q = queue[i];
    out.push([q.id, q.pri, q.val, q.border]);
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
    tp: {
      l: plan.towerPolicy && plan.towerPolicy.repairTowerLimit,
      r: plan.towerPolicy && plan.towerPolicy.reservePerTower
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

function buildRequestPreview(roomName, room, items, stats, nukePlan, repairTier) {
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
  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
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

function sortRepairItems(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.source === 'creep' || it.source === 'both') out.push(it);
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

function classifyRepairTier(roomName, rs, rcl, items, roomUnderAttack, nukePlan, stats) {
  var imminentCollapse = hasImminentCollapse(items, rcl);

  if (nukePlan && nukePlan.active) return 'WAR_EMERGENCY';
  if (roomUnderAttack) return imminentCollapse ? 'WAR_EMERGENCY' : 'WAR';
  if (imminentCollapse) return 'PEACE_EMERGENCY';
  if (stats && stats.creepHits >= WAR_EMERGENCY_HITS) return 'PEACE_EMERGENCY';
  return 'PEACE';
}

function extraCountForTier(tier) {
  var cap = REPAIR_TIERS[tier] || 1;
  return Math.max(0, Math.min(MAX_PARALLEL_REPAIRERS - 1, cap - 1));
}

function buildTargetTask(roomName, items, shardIndex, shardCount) {
  var shard = shardItems(items, shardIndex, shardCount);
  return { k: 'target', r: roomName, i: shard.structureIds };
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
      items.push({ id: t.id, tier: tier.tier, hits: t.currentHits, target: t.targetHits, x: t.x, y: t.y });
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
  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
    if (!creep || !creep.memory || creep.memory.role !== 'repairer') continue;
    if (creep.memory.homeRoom || creep.memory.assignedRoom) continue;
    creep.memory.homeRoom = creep.room.name;
    creep.memory.assignedRoom = creep.room.name;
    console.log('[RepairManager] Adopted unanchored repairer ' + creep.name + ' into ' + creep.room.name);
  }
}

function taskSize(task) {
  if (!task) return 0;
  if (task.i) return task.i.length;
  if (task.structureIds) return task.structureIds.length;
  if (task.c) return task.c.length;
  if (task.clusterIds) return task.clusterIds.length;
  return 0;
}

function taskKind(task) {
  return task ? (task.k || task.kind) : null;
}

function compactTask(task) {
  if (!task) return task;
  var kind = task.k || task.kind;
  if (kind === 'median') return buildMedianTask(task.homeRoom || task.r, task.clusterIds || task.c || []);
  var ids = task.structureIds || task.i || [];
  if (kind === 'nuke') return { k: 'nuke', r: task.homeRoom || task.r, i: ids };
  return { k: 'target', r: task.homeRoom || task.r, i: ids };
}

function compactLiveRepairMemory() {
  var creeps = 0;
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
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
  var tier = plan && plan.repairTier ? plan.repairTier : 'PEACE';
  return Math.min(MAX_PARALLEL_REPAIRERS, REPAIR_TIERS[tier] || 1);
}

function assignRepairerTasks(roomName, plan) {
  var repairers = getRepairers(roomName);
  if (!repairers.length) return;
  repairers.sort(function(a, b) { return a.name < b.name ? -1 : 1; });
  var normalItems = sortRepairItems(plan.items);
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
    } else task = buildTargetTask(roomName, normalItems, i % shardCount, shardCount);
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
  var needsWork = plan.stats.creepHits > 0 || (plan.nukePlan && plan.nukePlan.active) || (plan.medianRequests && plan.medianRequests.length > 0);
  if (!needsWork) { Memory.repairSpawnRequests[roomName] = []; return; }

  var desired = desiredRepairerCount(plan);
  var missing = Math.max(0, desired - existing - pending);
  if (missing <= 0) return;

  var newReqs = [];
  for (var i = 0; i < missing; i++) {
    var slot = existing + pending + i;
    var kind = slot === 0 ? 'baseline' : 'extra';
    var priority = plan.nukePlan && plan.nukePlan.active ? 5 : (kind === 'baseline' ? 6 : 7);
    var sized = sizeDispatch({
      totalHits: Math.max(plan.stats.creepHits, 1),
      maxSingleHits: Math.max(plan.stats.maxSingleHits, 1),
      availableEnergy: room.energyCapacityAvailable || room.energyAvailable || BODY_MIN_COST,
      movementProfile: 'mixed',
      urgency: plan.nukePlan && plan.nukePlan.active ? 1.0 : (roomUnderAttack ? 0.9 : 0.4),
      towerFraction: 0
    });
    var task;
    if (plan.nukePlan && plan.nukePlan.active) task = buildNukeTask(roomName, plan.nukePlan, slot % desired, desired);
    else if (plan.medianRequests && plan.medianRequests.length && slot < plan.medianRequests.length) {
      task = buildMedianTask(roomName, plan.medianRequests[slot].clusterIds || []);
    } else task = buildTargetTask(roomName, sortRepairItems(plan.items), slot % desired, desired);
    if (taskSize(task) === 0) continue;
    newReqs.push({
      id: roomName + '_' + kind + '_' + slot,
      role: 'repairer',
      kind: kind,
      priority: priority,
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
  if (!force && isCompactPlan(prev) && planTick(prev) && Game.time - planTick(prev) < cadence) {
    var cached = global._repairPlanCache[roomName];
    if (cached && cached.repairTier) {
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
  var towerQueue = buildTowerQueue(items);
  var medianRequests = (Memory.defense && Memory.defense.repairOrders && Memory.defense.repairOrders[roomName]) || [];
  var roomUnderAttack = shouldUseWarCadence(roomName, room, rs, nukePlan);
  var repairTier = classifyRepairTier(roomName, rs, rcl, items, roomUnderAttack, nukePlan, stats);
  stats.repairTier = repairTier;
  var requests = buildRequestPreview(roomName, room, items, stats, nukePlan, repairTier);
  var repairTowerLimit = roomUnderAttack ? TOWER_REPAIR_LIMIT_WITH_HOSTILES : null;
  if (nukePlan.active) repairTowerLimit = TOWER_REPAIR_LIMIT_DURING_NUKE;

  var plan = {
    tick: Game.time,
    roomName: roomName,
    cadence: cadence,
    items: items,
    towerQueue: towerQueue,
    towerPolicy: { repairTowerLimit: repairTowerLimit, reservePerTower: TOWER_ENERGY_RESERVE, allowRepairDuringHostiles: true },
    nukePlan: nukePlan,
    medianRequests: medianRequests,
    requests: requests,
    stats: stats,
    repairTier: repairTier,
    planFreshTtl: PLAN_FRESH_TTL
  };
  if (!Memory.towers) Memory.towers = {};
  if (nukePlan.active || realHostile) Memory.towers[roomName] = 1;
  else delete Memory.towers[roomName];
  assignRepairerTasks(roomName, plan);
  writeSpawnRequests(roomName, room, plan, roomUnderAttack);
  writePlan(roomName, plan);
  return plan;
}

function run() {
  ensureMemory();
  adoptUnanchoredRepairers();
  for (var roomName in Game.rooms) buildPlan(roomName, false);
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
    lines.push(rn + ' tick:' + p.tick + ' cadence:' + p.cadence + ' tier:' + p.repairTier + ' items:' + p.items.length + ' towerQ:' + p.towerQueue.length + ' creepHits:' + formatNumber(p.stats.creepHits));
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
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      var anchor = c.memory && (c.memory.homeRoom || c.memory.assignedRoom) || null;
      if (c.memory.role === 'repairer' && anchor === rn) {
        if (c.memory.task) active++;
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
  delete Memory.repairBotCooldown;
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
  sizeDispatch: sizeDispatch,
  computeBody: computeBody,
  bodyCost: bodyCost,
  constants: {
    MAX_PARALLEL_REPAIRERS: MAX_PARALLEL_REPAIRERS,
    EXTRA_REPAIR_STORAGE_MIN: EXTRA_REPAIR_STORAGE_MIN,
    PLAN_FRESH_TTL: PLAN_FRESH_TTL
  }
};
