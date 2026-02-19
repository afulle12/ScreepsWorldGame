// roleWallRepair.js
//
// Wall repairer that works off a per-room order in Memory.wallRepairOrders[roomName].
// - Repairs STRUCTURE_WALL up to `threshold`
// - Uses Storage (or containers), else harvests
// - Skips unreachable wall segments and removes them from the order
// - Avoids standing on room edges (x/y = 0 or 49)
// - One creep per active order; respawn handled by main's spawn manager
// orderWallRepair('W1N1', 500000)
// wallRepairStatus('W1N1')
// cancelWallRepair('W1N1')

const ROLE_NAME = 'wallRepair';

// Centralized room vision provider
const getRoomStateCentral = require('getRoomState');

// -----------------------------------------------------------------------------
// Renewal settings
// -----------------------------------------------------------------------------
var RENEW_TRIGGER_TTL = 100; // If below this and carrying no energy, attempt renew
var RENEW_TARGET_TTL = 200;  // Renew until at least this TTL, then resume work

// -----------------------------------------------------------------------------
// Edge-avoid CostMatrix cache (refresh every 25 ticks)
// -----------------------------------------------------------------------------
var CACHE_REFRESH_TICKS = 25;
if (!global._edgeAvoidCache) {
  global._edgeAvoidCache = {};
}

function getEdgeAvoidCacheEntry(roomName) {
  var entry = global._edgeAvoidCache[roomName];
  if (!entry) {
    entry = { builtAt: 0, matrix: null };
    global._edgeAvoidCache[roomName] = entry;
  }
  return entry;
}

function buildEdgeAvoidMatrixFor(room) {
  var matrix = new PathFinder.CostMatrix();

  // Block room edges
  var x;
  var y;
  for (x = 0; x < 50; x++) {
    matrix.set(x, 0, 255);
    matrix.set(x, 49, 255);
  }
  for (y = 0; y < 50; y++) {
    matrix.set(0, y, 255);
    matrix.set(49, y, 255);
  }

  // If no vision, return edge-only matrix
  if (!room) {
    return matrix;
  }

  // Single pass over structures via centralized vision
  var base = null;
  var structsByType = null;
  var structs = [];
  if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
    base = getRoomStateCentral.get(room.name);
    if (base && base.structuresByType) {
      structsByType = base.structuresByType;
      for (var t in structsByType) {
        var arr = structsByType[t];
        if (arr && arr.length) {
          for (var i = 0; i < arr.length; i++) {
            structs.push(arr[i]);
          }
        }
      }
    }
  }

  for (var i2 = 0; i2 < structs.length; i2++) {
    var s = structs[i2];

    if (s.structureType === STRUCTURE_ROAD) {
      // Prefer roads slightly
      matrix.set(s.pos.x, s.pos.y, 1);
    } else if (s.structureType === STRUCTURE_RAMPART) {
      // Only block hostile, non-public ramparts
      if (!s.my && !s.isPublic) {
        matrix.set(s.pos.x, s.pos.y, 255);
      }
    } else if (s.structureType !== STRUCTURE_CONTAINER) {
      // Block non-walkables (leave containers walkable)
      matrix.set(s.pos.x, s.pos.y, 255);
    }
  }

  return matrix;
}

function getEdgeAvoidMatrix(roomName) {
  var entry = getEdgeAvoidCacheEntry(roomName);
  if (!entry.matrix || Game.time - entry.builtAt >= CACHE_REFRESH_TICKS) {
    var room = Game.rooms[roomName];
    entry.matrix = buildEdgeAvoidMatrixFor(room);
    entry.builtAt = Game.time;
  }
  return entry.matrix;
}

// Assigned-room helper (pins the creep to one room)
function getAssignedRoom(creep) {
  if (!creep.memory.taskRoom) {
    creep.memory.taskRoom = creep.room.name;
  }
  return creep.memory.taskRoom;
}

// Move options that avoid room edges for pathfinding
function edgeAvoidMoveOpts(creep, lockRoomName) {
  var roomName = lockRoomName || creep.room.name;
  return {
    reusePath: 15,
    maxRooms: 1,
    plainCost: 2,
    swampCost: 10,
    roomCallback: function(rn) {
      if (rn !== roomName) {
        return false;
      }
      return getEdgeAvoidMatrix(roomName);
    }
  };
}

// Cost callback for findClosestByPath (API shape: (roomName, costMatrix))
function edgeAvoidCostCallback(lockRoomName) {
  return function(rn, matrix) {
    if (rn !== lockRoomName) {
      return;
    }
    var cached = getEdgeAvoidMatrix(lockRoomName);
    var x;
    var y;
    var val;
    for (x = 0; x < 50; x++) {
      for (y = 0; y < 50; y++) {
        val = cached.get(x, y);
        if (val) {
          matrix.set(x, y, val);
        }
      }
    }
  };
}

function stayOffEdges(creep) {
  // Nudge inside the room if standing on edge
  if (creep.pos.x === 0) {
    creep.move(RIGHT);
  } else if (creep.pos.x === 49) {
    creep.move(LEFT);
  }

  if (creep.pos.y === 0) {
    creep.move(BOTTOM);
  } else if (creep.pos.y === 49) {
    creep.move(TOP);
  }
}

// Ensure order object is sane
function getOrder(roomName) {
  if (!Memory.wallRepairOrders) {
    Memory.wallRepairOrders = {};
  }
  var order = Memory.wallRepairOrders[roomName];
  if (order) {
    return order;
  }
  return null;
}

function selectNextTarget(creep, order) {
  // Drop targets already above threshold or missing
  while (order.queue && order.queue.length > 0) {
    var id = order.queue[0];
    var wall = Game.getObjectById(id);
    if (!wall || wall.hits >= order.threshold) {
      order.queue.shift();
      continue;
    }

    // Check reachability (within range 3) while avoiding edges
    var res = PathFinder.search(
      creep.pos,
      { pos: wall.pos, range: 3 },
      { maxRooms: 1, roomCallback: edgeAvoidMoveOpts(creep).roomCallback }
    );

    if (res.incomplete) {
      // Mark skipped and pop it from the queue
      if (!order.skipped) {
        order.skipped = {};
      }
      order.skipped[id] = Game.time;
      order.queue.shift();
      continue;
    }

    // Assign target
    creep.memory.targetId = id;
    return wall;
  }

  // No valid target
  creep.memory.targetId = null;
  return null;
}

function refill(creep) {
  // If we ever ended up outside our assigned room, do not refill here. Go home.
  var assignedRoom = getAssignedRoom(creep);
  if (creep.room.name !== assignedRoom) {
    return;
  }

  // Prefer Storage, then containers, else harvest
  var room = creep.room;
  if (room.storage && room.storage.store && room.storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.pos.getRangeTo(room.storage) > 1) {
      creep.moveTo(room.storage, edgeAvoidMoveOpts(creep, assignedRoom));
    } else {
      creep.withdraw(room.storage, RESOURCE_ENERGY);
    }
    return;
  }

  // Centralized: containers with energy
  var base = null;
  var containers = [];
  if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
    base = getRoomStateCentral.get(assignedRoom);
    if (base && base.structuresByType && base.structuresByType[STRUCTURE_CONTAINER]) {
      var arr = base.structuresByType[STRUCTURE_CONTAINER];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (s && s.store && s.store[RESOURCE_ENERGY] > 0) {
          containers.push(s);
        }
      }
    }
  }

  var container = null;
  if (containers.length > 0) {
    container = creep.pos.findClosestByRange(containers);
  }

  if (container) {
    if (creep.pos.getRangeTo(container) > 1) {
      creep.moveTo(container, edgeAvoidMoveOpts(creep, assignedRoom));
    } else {
      creep.withdraw(container, RESOURCE_ENERGY);
    }
    return;
  }

  // Harvest as a fallback using centralized sources (active only)
  var activeSources = [];
  if (base && base.sources && base.sources.length > 0) {
    for (var j = 0; j < base.sources.length; j++) {
      var srcObj = base.sources[j];
      if (srcObj && srcObj.energy > 0) {
        activeSources.push(srcObj);
      }
    }
  }

  if (activeSources.length > 0) {
    var src = creep.pos.findClosestByPath(activeSources, {
      maxRooms: 1,
      costCallback: edgeAvoidCostCallback(assignedRoom)
    });
    if (src) {
      if (creep.harvest(src) === ERR_NOT_IN_RANGE) {
        creep.moveTo(src, edgeAvoidMoveOpts(creep, assignedRoom));
      }
    }
  }
}

function tryFinishOrderIfDone(order, room) {
  // Lightweight check first
  if (order.queue && order.queue.length > 0) {
    return false;
  }

  // Double-check room for any walls below threshold (centralized)
  var base = null;
  var walls = [];
  if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
    base = getRoomStateCentral.get(room.name);
    if (base && base.structuresByType && base.structuresByType[STRUCTURE_WALL]) {
      var arr = base.structuresByType[STRUCTURE_WALL];
      for (var i = 0; i < arr.length; i++) {
        var w = arr[i];
        if (w && w.hits < order.threshold) {
          walls.push(w);
        }
      }
    }
  }

  if (walls.length === 0) {
    order.completedAt = Game.time;
    order.active = false;
    return true;
  }

  // Rebuild queue if needed (this helps if queue was emptied by towers or others)
  // Sort by range to origin
  var origin = Game.getObjectById(order.originId);
  var originPos;
  if (origin) {
    originPos = origin.pos;
  } else {
    originPos = new RoomPosition(25, 25, room.name);
  }

  walls.sort(function(a, b) {
    var da = originPos.getRangeTo(a.pos);
    var db = originPos.getRangeTo(b.pos);
    return da - db;
  });
  order.queue = walls.map(function(w2) { return w2.id; });
  return false;
}

// -----------------------------------------------------------------------------
// Renewal helpers
// -----------------------------------------------------------------------------
function getLiveOwnedSpawnsInRoom(roomName) {
  var base = null;
  var live = [];
  if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
    base = getRoomStateCentral.get(roomName);
  }
  var arrS = base && base.structuresByType ? base.structuresByType[STRUCTURE_SPAWN] : null;
  if (arrS && arrS.length > 0) {
    for (var i = 0; i < arrS.length; i++) {
      var s = Game.getObjectById(arrS[i].id); // Live object needed for actions/pos【1】
      if (s && s.my) {
        live.push(s);
      }
    }
  }
  return live;
}

function handleRenew(creep) {
  var assignedRoom = getAssignedRoom(creep);

  // Start renewing if below trigger and empty, or continue if already renewing
  var wantsRenew = (typeof creep.ticksToLive === 'number' &&
                    creep.ticksToLive < RENEW_TRIGGER_TTL &&
                    creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) || creep.memory.renewing;

  if (!wantsRenew) {
    return false; // not handling this tick
  }

  // Pick/validate renew target
  var spawn = null;
  if (creep.memory.renewSpawnId) {
    spawn = Game.getObjectById(creep.memory.renewSpawnId);
  }
  if (!spawn) {
    var spawns = getLiveOwnedSpawnsInRoom(assignedRoom);
    if (spawns.length === 0) {
      // No spawn available; abort renew and let normal logic proceed
      creep.memory.renewing = false;
      delete creep.memory.renewSpawnId;
      return false;
    }
    spawn = creep.pos.findClosestByRange(spawns);
    if (spawn) {
      creep.memory.renewing = true;
      creep.memory.renewSpawnId = spawn.id;
    } else {
      creep.memory.renewing = false;
      delete creep.memory.renewSpawnId;
      return false;
    }
  }

  // If we already have enough TTL, stop renewing and resume work
  if (typeof creep.ticksToLive === 'number' && creep.ticksToLive >= RENEW_TARGET_TTL) {
    creep.memory.renewing = false;
    delete creep.memory.renewSpawnId;
    return false;
  }

  // Move to spawn and attempt renewal (renew is performed by the spawn)【2】
  if (!creep.pos.isNearTo(spawn)) {
    var moveOpts = edgeAvoidMoveOpts(creep, assignedRoom);
    moveOpts.range = 1;
    creep.moveTo(spawn, moveOpts);
    return true; // handled this tick
  }

  var rc = spawn.renewCreep(creep); // Renewing removes all boosts【2】
  if (rc === OK) {
    // Keep renewing until target TTL
    return true;
  }

  // If couldn't renew (busy, not enough energy, etc.), wait and try again
  // Alternatively, you can abort on certain codes if desired.
  return true;
}

// -----------------------------------------------------------------------------
// Main work loop
// -----------------------------------------------------------------------------
function work(creep) {
  var assignedRoom = getAssignedRoom(creep);

  // If out of assigned room, return immediately and do nothing else
  if (creep.room.name !== assignedRoom) {
    stayOffEdges(creep);
    var dest = new RoomPosition(25, 25, assignedRoom);
    // Allow crossing one border to get back
    creep.moveTo(dest, { reusePath: 10, maxRooms: 2 });
    return;
  }

  // Hard block standing on edges
  stayOffEdges(creep);

  // If low TTL and empty, renew first before doing anything else
  if (handleRenew(creep)) {
    return;
  }

  var order = getOrder(assignedRoom);
  if (!order || order.active === false) {
    // Idle near storage or center (in assigned room only)
    var waitSpot = creep.room.storage ? creep.room.storage.pos : new RoomPosition(25, 25, assignedRoom);
    if (!creep.pos.inRangeTo(waitSpot, 3)) {
      creep.moveTo(waitSpot, edgeAvoidMoveOpts(creep, assignedRoom));
    }
    return;
  }

  // Energy state
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = false;
  } else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
  }

  if (!creep.memory.working) {
    refill(creep);
    return;
  }

  // Make sure order still needs work
  if (tryFinishOrderIfDone(order, creep.room)) {
    // Optional: recycle self when done (only in assigned room)
    var base = null;
    var spawnsHere = [];
    if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
      base = getRoomStateCentral.get(assignedRoom);
      if (base && base.structuresByType && base.structuresByType[STRUCTURE_SPAWN]) {
        var arrS = base.structuresByType[STRUCTURE_SPAWN];
        for (var i = 0; i < arrS.length; i++) {
          var sp = arrS[i];
          if (sp && sp.my) {
            spawnsHere.push(sp);
          }
        }
      }
    }

    if (spawnsHere && spawnsHere.length > 0) {
      var spawn = creep.pos.findClosestByRange(spawnsHere);
      if (spawn) {
        creep.moveTo(spawn, edgeAvoidMoveOpts(creep, assignedRoom));
      }
    }
    return;
  }

  // Ensure we have a valid target
  var target = null;
  if (creep.memory.targetId) {
    target = Game.getObjectById(creep.memory.targetId);
    if (!target || target.hits >= order.threshold) {
      // Clear and pick next
      creep.memory.targetId = null;
      target = selectNextTarget(creep, order);
    }
  } else {
    target = selectNextTarget(creep, order);
  }

  if (!target) {
    // No current target; re-check completion soon
    if (Game.time % 25 === 0) {
      tryFinishOrderIfDone(order, creep.room);
    }
    return;
  }

  // Move within repair range and repair
  var inRange = creep.pos.inRangeTo(target.pos, 3);
  if (!inRange) {
    var moveOpts = edgeAvoidMoveOpts(creep, assignedRoom);
    moveOpts.range = 3;
    creep.moveTo(target, moveOpts);
    return;
  }

  var res = creep.repair(target);
  if (res === ERR_NOT_IN_RANGE) {
    var moveOpts2 = edgeAvoidMoveOpts(creep, assignedRoom);
    moveOpts2.range = 3;
    creep.moveTo(target, moveOpts2);
  } else if (res === OK) {
    // If we topped it off this tick, clear target next tick
    if (target.hits >= order.threshold) {
      creep.memory.targetId = null;
      // Remove from head if still there
      if (order.queue && order.queue.length > 0 && order.queue[0] === target.id) {
        order.queue.shift();
      }
    }
  } else {
    // If we cannot repair, skip this one
    creep.memory.targetId = null;
    if (!order.skipped) {
      order.skipped = {};
    }
    order.skipped[target.id] = Game.time;
    // Also remove from queue if at head
    if (order.queue && order.queue.length > 0 && order.queue[0] === target.id) {
      order.queue.shift();
    }
  }
}

module.exports = {
  role: ROLE_NAME,
  run: function(creep) {
    work(creep);
  }
};
