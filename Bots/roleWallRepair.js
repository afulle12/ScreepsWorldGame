// roleWallRepair.js
//
// Wall & rampart repairer driven by Memory.wallRepairOrders[roomName].
//
// Repairs walls/ramparts in 1M-hit increments. All walls are brought to the
// next million above the current floor before advancing to the next tier,
// keeping defences balanced rather than maxing individual walls.
//
// ── Console Commands ──────────────────────────────────────────────────────────
//
// orderWallRepair(roomName, threshold, count?, interiorIncluded?)
//   Creates or replaces a wall/rampart repair order for a room.
//   Ex: orderWallRepair('W1N1', 10000000)
//   Ex: orderWallRepair('W1N1', 10000000, 3, true)
//
// wallRepairStatus(roomName?)
//   Shows queue size, active creep count, current step, and % near threshold.
//   Omit roomName to show all rooms.
//   Ex: wallRepairStatus('W1N1')
//   Ex: wallRepairStatus()
//
// wallRepairOverview()
//   Summary of all active orders: walls near target across every room.
//   Ex: wallRepairOverview()
//
// cancelWallRepair(roomName)
//   Cancels the repair order for a room and clears its transient queue.
//   Ex: cancelWallRepair('W1N1')
//
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_NAME = 'wallRepair';

// Centralized room vision provider
const getRoomStateCentral = require('getRoomState');

// Step size for incremental repair tiers
const STEP_SIZE = 1000000; // 1M

// How many ticks before a skipped (unreachable) wall is retried
const SKIP_RETRY_TICKS = 20;

// ── Module-level transient state (never serialised to Memory) ─────────────────
var _transient = {};

function getTransient(roomName) {
  if (!_transient[roomName]) {
    _transient[roomName] = { queue: [], skipped: {}, needsRebuild: false };
  }
  return _transient[roomName];
}

// ─────────────────────────────────────────────────────────────────────────────
var REPAIR_TYPES = [STRUCTURE_WALL, STRUCTURE_RAMPART];
var PERIMETER_RANGE = 3;

function isPerimeter(pos) {
  return pos.x <= PERIMETER_RANGE || pos.x >= 49 - PERIMETER_RANGE ||
         pos.y <= PERIMETER_RANGE || pos.y >= 49 - PERIMETER_RANGE;
}

// Uses stepThreshold so creeps only repair to the current tier, not the final target.
function shouldRepair(struct, order) {
  if (!struct || struct.hits >= order.stepThreshold) return false;
  if (struct.structureType === STRUCTURE_RAMPART && !struct.my) return false;
  if (!order.interiorIncluded && !isPerimeter(struct.pos)) return false;
  return true;
}

// ── Step threshold calculation ────────────────────────────────────────────────
// Returns the next full million above the lowest wall in the provided array,
// always rounding up (so exactly 1M → 2M), capped at the final threshold.
function computeStepThreshold(walls, threshold) {
  var minHits = Infinity;
  for (var i = 0; i < walls.length; i++) {
    if (walls[i].hits < minHits) minHits = walls[i].hits;
  }
  if (!isFinite(minHits)) return threshold;
  var step = (Math.floor(minHits / STEP_SIZE) + 1) * STEP_SIZE;
  return Math.min(step, threshold);
}

// ── Candidate gathering ───────────────────────────────────────────────────────
// Returns all wall/rampart structures below the final threshold that pass the
// interior and ownership filters. Does NOT filter by stepThreshold — that is
// done separately when building the queue.
function gatherCandidates(roomName, order) {
  var base = getRoomStateCentral && typeof getRoomStateCentral.get === 'function'
    ? getRoomStateCentral.get(roomName) : null;
  if (!base || !base.structuresByType) return [];

  var candidates = [];
  for (var tp = 0; tp < REPAIR_TYPES.length; tp++) {
    var arr = base.structuresByType[REPAIR_TYPES[tp]];
    if (!arr) continue;
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (!s) continue;
      if (s.structureType === STRUCTURE_RAMPART && !s.my) continue;
      if (!order.interiorIncluded && !isPerimeter(s.pos)) continue;
      if (s.hits < order.threshold) candidates.push(s);
    }
  }
  return candidates;
}

// ── Queue rebuild ─────────────────────────────────────────────────────────────
// Called at the start of the tick after needsRebuild is set. Advances
// stepThreshold to the next tier and repopulates the queue. Marks the order
// complete if no candidates remain below the final threshold.
function rebuildQueue(roomName, order) {
  var t = getTransient(roomName);
  t.needsRebuild = false;
  t.skipped = {};

  if (!Game.rooms[roomName]) return;

  var candidates = gatherCandidates(roomName, order);

  if (candidates.length === 0) {
    order.completedAt = Game.time;
    order.active = false;
    return;
  }

  order.stepThreshold = computeStepThreshold(candidates, order.threshold);

  // Sort ascending so the lowest walls are first in the queue.
  candidates.sort(function(a, b) { return a.hits - b.hits; });

  t.queue = [];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].hits < order.stepThreshold) t.queue.push(candidates[i].id);
  }
}

// ── Edge-avoid CostMatrix cache ───────────────────────────────────────────────
var CACHE_REFRESH_TICKS = 25;
if (!global._edgeAvoidCache) global._edgeAvoidCache = {};

function getEdgeAvoidCacheEntry(roomName) {
  if (!global._edgeAvoidCache[roomName]) {
    global._edgeAvoidCache[roomName] = { builtAt: 0, matrix: null };
  }
  return global._edgeAvoidCache[roomName];
}

function buildEdgeAvoidMatrixFor(room) {
  var matrix = new PathFinder.CostMatrix();
  for (var x = 0; x < 50; x++) { matrix.set(x, 0, 255); matrix.set(x, 49, 255); }
  for (var y = 0; y < 50; y++) { matrix.set(0, y, 255); matrix.set(49, y, 255); }
  if (!room) return matrix;

  var structs = [];
  if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
    var base = getRoomStateCentral.get(room.name);
    if (base && base.structuresByType) {
      for (var t in base.structuresByType) {
        var arr = base.structuresByType[t];
        if (arr && arr.length) {
          for (var i = 0; i < arr.length; i++) structs.push(arr[i]);
        }
      }
    }
  }
  for (var i2 = 0; i2 < structs.length; i2++) {
    var s = structs[i2];
    if (s.structureType === STRUCTURE_ROAD) {
      matrix.set(s.pos.x, s.pos.y, 1);
    } else if (s.structureType === STRUCTURE_RAMPART) {
      // Enemy/non-public ramparts are impassable; own and public ramparts are
      // walkable — do NOT set a cost so the terrain default applies.
      if (!s.my && !s.isPublic) matrix.set(s.pos.x, s.pos.y, 255);
    } else if (s.structureType === STRUCTURE_WALL) {
      // Walls are repair targets, not navigation obstacles. Leave the tile at
      // its terrain cost so PathFinder can route adjacent to them.
    } else if (s.structureType !== STRUCTURE_CONTAINER) {
      matrix.set(s.pos.x, s.pos.y, 255);
    }
  }
  return matrix;
}

function getEdgeAvoidMatrix(roomName) {
  var entry = getEdgeAvoidCacheEntry(roomName);
  if (!entry.matrix || Game.time - entry.builtAt >= CACHE_REFRESH_TICKS) {
    entry.matrix = buildEdgeAvoidMatrixFor(Game.rooms[roomName]);
    entry.builtAt = Game.time;
  }
  return entry.matrix;
}

// ── Stuck detection ───────────────────────────────────────────────────────────
var STUCK_THRESHOLD = 5;
function updateStuckCounter(creep) {
  if (!creep.memory._stk) creep.memory._stk = { x: creep.pos.x, y: creep.pos.y, r: creep.pos.roomName, n: 0 };
  var s = creep.memory._stk;
  if (s.x === creep.pos.x && s.y === creep.pos.y && s.r === creep.pos.roomName) s.n++;
  else { s.x = creep.pos.x; s.y = creep.pos.y; s.r = creep.pos.roomName; s.n = 0; }
  return s.n >= STUCK_THRESHOLD;
}
function consumeStuck(creep) {
  var stuck = updateStuckCounter(creep);
  if (stuck) creep.memory._stk.n = 0;
  return stuck;
}

function edgeAvoidMoveOpts(creep, lockRoomName) {
  var roomName = lockRoomName || creep.room.name;
  var stuck = consumeStuck(creep);
  return {
    reusePath: stuck ? 1 : 15,
    ignoreCreeps: !stuck,
    maxRooms: 1,
    plainCost: 20,
    swampCost: 40,
    roomCallback: function(rn) { return rn === roomName ? getEdgeAvoidMatrix(roomName) : false; }
  };
}

function edgeAvoidCostCallback(lockRoomName) {
  return function(rn, matrix) {
    if (rn !== lockRoomName) return;
    var cached = getEdgeAvoidMatrix(lockRoomName);
    for (var x = 0; x < 50; x++) {
      for (var y = 0; y < 50; y++) {
        var val = cached.get(x, y);
        if (val) matrix.set(x, y, val);
      }
    }
  };
}

function stayOffEdges(creep) {
  if (creep.pos.x === 0) creep.move(RIGHT);
  else if (creep.pos.x === 49) creep.move(LEFT);
  if (creep.pos.y === 0) creep.move(BOTTOM);
  else if (creep.pos.y === 49) creep.move(TOP);
}

function getAssignedRoom(creep) {
  if (!creep.memory.taskRoom) creep.memory.taskRoom = creep.room.name;
  return creep.memory.taskRoom;
}

// ── No-path wait ─────────────────────────────────────────────────────────────
var WAIT_TICKS = 5;
function startWait(creep) { creep.say('⏳'); creep.memory._waitUntil = Game.time + WAIT_TICKS; }
function isWaiting(creep) {
  if (creep.memory._waitUntil && Game.time < creep.memory._waitUntil) return true;
  delete creep.memory._waitUntil;
  return false;
}

// ── Target selection ──────────────────────────────────────────────────────────
function selectNextTarget(creep, order) {
  var roomName = getAssignedRoom(creep);
  var t = getTransient(roomName);

  var claimed = {};
  for (var n in Game.creeps) {
    var other = Game.creeps[n];
    if (other.name !== creep.name && other.memory.role === ROLE_NAME && other.memory.targetId) {
      claimed[other.memory.targetId] = true;
    }
  }

  for (var qi = 0; qi < t.queue.length; qi++) {
    var id = t.queue[qi];
    var wall = Game.getObjectById(id);

    // Wall is gone or already repaired to this tier — remove permanently.
    if (!wall || !shouldRepair(wall, order)) { t.queue.splice(qi, 1); qi--; continue; }

    if (claimed[id]) continue;

    // Skip walls that recently failed a reachability check; retry after
    // SKIP_RETRY_TICKS to recover from transient pathfinding failures without
    // permanently orphaning reachable walls.
    if (t.skipped[id] && Game.time - t.skipped[id] < SKIP_RETRY_TICKS) continue;

    var moveOpts = edgeAvoidMoveOpts(creep);
    var res = PathFinder.search(creep.pos, { pos: wall.pos, range: 3 },
      { maxRooms: 1, roomCallback: moveOpts.roomCallback });
    if (res.incomplete) {
      var res2 = PathFinder.search(creep.pos, { pos: wall.pos, range: 5 },
        { maxRooms: 1, roomCallback: moveOpts.roomCallback });
      if (res2.incomplete) {
        // Mark as temporarily skipped but keep in queue for retry.
        t.skipped[id] = Game.time;
        continue;
      }
    }

    // Clear any stale skip record now that we have a path.
    delete t.skipped[id];
    creep.memory.targetId = id;
    return wall;
  }
  creep.memory.targetId = null;
  return null;
}

// ── Energy refill ─────────────────────────────────────────────────────────────
function refill(creep) {
  var assignedRoom = getAssignedRoom(creep);
  if (creep.room.name !== assignedRoom) return;

  var room = creep.room;
  if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.pos.getRangeTo(room.storage) > 1) {
      var r = creep.moveTo(room.storage, edgeAvoidMoveOpts(creep, assignedRoom));
      if (r === ERR_NO_PATH) startWait(creep);
    } else creep.withdraw(room.storage, RESOURCE_ENERGY);
    return;
  }

  var base = null, containers = [];
  if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
    base = getRoomStateCentral.get(assignedRoom);
    if (base && base.structuresByType && base.structuresByType[STRUCTURE_CONTAINER]) {
      for (var i = 0; i < base.structuresByType[STRUCTURE_CONTAINER].length; i++) {
        var s = base.structuresByType[STRUCTURE_CONTAINER][i];
        if (s && s.store && s.store[RESOURCE_ENERGY] > 0) containers.push(s);
      }
    }
  }
  if (containers.length > 0) {
    var container = creep.pos.findClosestByRange(containers);
    if (creep.pos.getRangeTo(container) > 1) {
      var r2 = creep.moveTo(container, edgeAvoidMoveOpts(creep, assignedRoom));
      if (r2 === ERR_NO_PATH) startWait(creep);
    } else creep.withdraw(container, RESOURCE_ENERGY);
    return;
  }

  var activeSources = base && base.sources ? base.sources.filter(function(s) { return s && s.energy > 0; }) : [];
  if (activeSources.length > 0) {
    var src = creep.pos.findClosestByPath(activeSources, { maxRooms: 1, costCallback: edgeAvoidCostCallback(assignedRoom) });
    if (src) {
      if (creep.harvest(src) === ERR_NOT_IN_RANGE) {
        var r3 = creep.moveTo(src, edgeAvoidMoveOpts(creep, assignedRoom));
        if (r3 === ERR_NO_PATH) startWait(creep);
      }
    } else startWait(creep);
  } else startWait(creep);
}

// ── Main work loop ────────────────────────────────────────────────────────────
function work(creep) {
  if (Memory.cpuStats && Memory.cpuStats.average > 25) { creep.say('💤'); return; }
  if (isWaiting(creep)) return;

  var assignedRoom = getAssignedRoom(creep);
  if (creep.room.name !== assignedRoom) {
    stayOffEdges(creep);
    creep.moveTo(new RoomPosition(25, 25, assignedRoom), { reusePath: 10, maxRooms: 2, plainCost: 20, swampCost: 40,
      roomCallback: function(rn) { return getEdgeAvoidMatrix(rn); } });
    return;
  }
  stayOffEdges(creep);

  var order = getOrder(assignedRoom);
  if (!order || order.active === false) {
    var waitSpot = creep.room.storage ? creep.room.storage.pos : new RoomPosition(25, 25, assignedRoom);
    if (!creep.pos.inRangeTo(waitSpot, 3)) creep.moveTo(waitSpot, edgeAvoidMoveOpts(creep, assignedRoom));
    return;
  }

  // ── Pending rebuild from previous tick's queue drain ─────────────────────
  var t = getTransient(assignedRoom);
  if (t.needsRebuild) {
    rebuildQueue(assignedRoom, order);
    // rebuildQueue may have marked the order inactive if all walls are done.
    if (!order.active) {
      var waitSpot2 = creep.room.storage ? creep.room.storage.pos : new RoomPosition(25, 25, assignedRoom);
      if (!creep.pos.inRangeTo(waitSpot2, 3)) creep.moveTo(waitSpot2, edgeAvoidMoveOpts(creep, assignedRoom));
      return;
    }
  }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) creep.memory.working = false;
  else creep.memory.working = true;

  if (!creep.memory.working) { refill(creep); return; }

  // ── Queue drain detection ─────────────────────────────────────────────────
  // If the queue is empty here, flag for rebuild next tick and idle near spawn.
  if (t.queue.length === 0) {
    t.needsRebuild = true;
    var spawnsHere = [];
    var base = getRoomStateCentral && typeof getRoomStateCentral.get === 'function' ? getRoomStateCentral.get(assignedRoom) : null;
    if (base && base.structuresByType && base.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < base.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = base.structuresByType[STRUCTURE_SPAWN][i];
        if (sp && sp.my) spawnsHere.push(sp);
      }
    }
    if (spawnsHere.length > 0) {
      var spawn = creep.pos.findClosestByRange(spawnsHere);
      if (spawn) creep.moveTo(spawn, edgeAvoidMoveOpts(creep, assignedRoom));
    }
    return;
  }

  var target = null;
  if (creep.memory.targetId) {
    target = Game.getObjectById(creep.memory.targetId);
    if (!target || !shouldRepair(target, order)) { creep.memory.targetId = null; target = selectNextTarget(creep, order); }
  } else target = selectNextTarget(creep, order);

  if (!target) return;

  if (creep.pos.inRangeTo(target.pos, 3)) creep.repair(target);
  if (!creep.pos.inRangeTo(target.pos, 3)) {
    if (creep.fatigue === 0) {
      var moveOpts = edgeAvoidMoveOpts(creep, assignedRoom);
      moveOpts.range = 3;
      var mr = creep.moveTo(target, moveOpts);
      if (mr === ERR_NO_PATH) startWait(creep);
    }
    return;
  }

  // Wall has reached this tier's step threshold — release and let queue drain
  // naturally. When the last wall in the queue is released, needsRebuild fires
  // and the next tick advances to the next tier.
  if (target.hits >= order.stepThreshold) {
    creep.memory.targetId = null;
    var idx = t.queue.indexOf(target.id);
    if (idx !== -1) t.queue.splice(idx, 1);
  }
}

// ── Console commands ──────────────────────────────────────────────────────────
function getOrder(roomName) {
  if (!Memory.wallRepairOrders) Memory.wallRepairOrders = {};
  return Memory.wallRepairOrders[roomName] || null;
}

global.orderWallRepair = function(roomName, threshold, count, interiorIncluded) {
  if (!roomName || !threshold) return 'Usage: orderWallRepair(roomName, threshold, count?, interiorIncluded?)';
  count = Math.max(1, Math.floor(count || 1));
  interiorIncluded = !!interiorIncluded;

  if (!Memory.wallRepairOrders) Memory.wallRepairOrders = {};
  var room = Game.rooms[roomName];
  var originId = room && room.storage ? room.storage.id : null;
  var prevSerial = (Memory.wallRepairOrders[roomName] && Memory.wallRepairOrders[roomName]._serial) || 0;

  // Gather candidates to determine starting step threshold.
  var tempOrder = { threshold: threshold, interiorIncluded: interiorIncluded };
  var candidates = room ? gatherCandidates(roomName, tempOrder) : [];
  var initialStep = candidates.length > 0
    ? computeStepThreshold(candidates, threshold)
    : Math.min(STEP_SIZE, threshold);

  Memory.wallRepairOrders[roomName] = {
    active: true,
    threshold: threshold,
    stepThreshold: initialStep,
    count: count,
    interiorIncluded: interiorIncluded,
    originId: originId,
    createdAt: Game.time,
    completedAt: null,
    _manual: true,
    _serial: prevSerial
  };

  var order = Memory.wallRepairOrders[roomName];
  var t = getTransient(roomName);
  t.queue = [];
  t.skipped = {};
  t.needsRebuild = false;

  // Populate initial queue: only walls below the first step threshold.
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].hits < order.stepThreshold) t.queue.push(candidates[i].id);
  }

  return 'Wall/rampart repair ordered for ' + roomName +
    ' — threshold:' + threshold +
    ', step:' + initialStep +
    ', creeps:' + count +
    ', interior:' + interiorIncluded +
    ', queued:' + t.queue.length + ' [manual]';
};

global.wallRepairStatus = function(roomName) {
  if (!Memory.wallRepairOrders) return 'No wall repair orders exist.';

  var rooms = roomName ? [roomName] : Object.keys(Memory.wallRepairOrders);
  var lines = [];
  var totalWalls = 0, totalNearTarget = 0;

  for (var ri = 0; ri < rooms.length; ri++) {
    var rn = rooms[ri];
    var order = Memory.wallRepairOrders[rn];
    if (!order) continue;

    var alive = 0;
    for (var n in Game.creeps) {
      var c = Game.creeps[n];
      if (c.memory.role === ROLE_NAME && c.memory.taskRoom === rn) alive++;
    }

    var wallCount = 0, nearTargetCount = 0;
    var room = Game.rooms[rn];
    if (room) {
      var structs = room.find(FIND_STRUCTURES, {
        filter: function(s) {
          return s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART;
        }
      });
      for (var i = 0; i < structs.length; i++) {
        var s = structs[i];
        if (!order.interiorIncluded && !isPerimeter(s.pos)) continue;
        wallCount++;
        if (s.hits >= order.threshold - 500000) nearTargetCount++;
      }
    }

    totalWalls += wallCount;
    totalNearTarget += nearTargetCount;

    var t = getTransient(rn);
    var pct = wallCount > 0 ? Math.round((nearTargetCount / wallCount) * 100) : 0;
    var status = order.active ? 'ON' : 'OFF';
    var stepM = order.stepThreshold ? Math.round(order.stepThreshold / 1000000) + 'M' : '?';
    lines.push(rn + ' [' + status + '] step:' + stepM + ' ' + alive + '/c ' + t.queue.length + '/q ' + pct + '%');
  }

  var overallPct = totalWalls > 0 ? Math.round((totalNearTarget / totalWalls) * 100) : 0;
  lines.unshift('Overall: ' + totalNearTarget + '/' + totalWalls + ' (' + overallPct + '%) within .5M');
  return lines.join('\n');
};

global.wallRepairOverview = function() {
  if (!Memory.wallRepairOrders) return 'No wall repair orders exist.';
  var roomNames = Object.keys(Memory.wallRepairOrders);
  if (roomNames.length === 0) return 'No wall repair orders exist.';

  var totalWalls = 0, totalNearTarget = 0, roomSummaries = [];

  for (var rn in Memory.wallRepairOrders) {
    var order = Memory.wallRepairOrders[rn];
    if (!order || !order.active) continue;

    var nearTargetCount = 0, wallCount = 0;
    var room = Game.rooms[rn];
    if (!room) { roomSummaries.push(rn + ': [no vision]'); continue; }

    var structs = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART; }
    });

    for (var i = 0; i < structs.length; i++) {
      var s = structs[i];
      if (!order.interiorIncluded && !isPerimeter(s.pos)) continue;
      wallCount++;
      if (s.hits >= order.threshold - 500000) nearTargetCount++;
    }

    totalWalls += wallCount;
    totalNearTarget += nearTargetCount;
    var pct = wallCount > 0 ? Math.round((nearTargetCount / wallCount) * 100) : 0;
    var stepM = order.stepThreshold ? Math.round(order.stepThreshold / 1000000) + 'M' : '?';
    roomSummaries.push(rn + ': ' + nearTargetCount + '/' + wallCount +
      ' (' + pct + '%) within .5M of ' + order.threshold +
      ' [step: ' + stepM + ']');
  }

  var overallPct = totalWalls > 0 ? Math.round((totalNearTarget / totalWalls) * 100) : 0;
  var lines = [
    '=== Wall Repair Overview ===',
    'Overall: ' + totalNearTarget + '/' + totalWalls + ' (' + overallPct + '%) within .5M of target',
    '',
    roomSummaries.join('\n')
  ];
  return lines.join('\n');
};

global.cancelWallRepair = function(roomName) {
  if (!Memory.wallRepairOrders || !Memory.wallRepairOrders[roomName]) return 'No order for ' + roomName;
  delete Memory.wallRepairOrders[roomName];
  delete _transient[roomName];
  return 'Wall repair order cancelled for ' + roomName;
};
// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { role: ROLE_NAME, run: function(creep) { work(creep); } };