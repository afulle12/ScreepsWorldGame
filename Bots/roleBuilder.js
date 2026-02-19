// roleBuilder.js
// Notes:
// - All direct room.find calls replaced with getRoomState reads.
// - No optional chaining used.
// - Initializes getRoomState once per tick before job selection.
// - In-room navigation avoids room edges; builders step inward if sitting on an edge.
// - Pathing wrapper uses maxRooms: 1 and edge penalties to prevent edge pulsing.
// - Job selection: prioritize spawn construction, then closest job to storage > spawn > creep.
// - When building ramparts, task isn't complete until rampart reaches 50k hits.

var getRoomState = require('getRoomState');

const BUILDER_LOGGING = false;
const BUILDER_LOG_INTERVAL = 5;
const RAMPART_REINFORCE_TARGET = 100000;

// == TASK PRIORITIES ==
const PRIORITIES = [
  {
    type: 'repair',
    filter: function(s) {
      // Ramparts: repair only until they reach 1000 hits
      if (s.structureType === STRUCTURE_RAMPART) {
        return s.hits < 1000;
      }

      // Other structures: original criteria
      return (
        s.structureType !== STRUCTURE_CONTAINER &&
        s.structureType !== STRUCTURE_WALL &&
        (s.hits / s.hitsMax < 0.25) &&
        s.hits < s.hitsMax
      );
    },
    label: 'Repair <25%'
  },
  {
    type: 'build',
    filter: function(s) { return true; },
    label: 'Build'
  },
  {
    type: 'repair',
    filter: function(s) {
      return (
        s.structureType === STRUCTURE_CONTAINER &&
        s.hits / s.hitsMax < 0.75 &&
        s.hits < s.hitsMax
      );
    },
    label: 'Repair Container <75%'
  },
  {
    type: 'repair',
    filter: function(s) {
      return (
        s.structureType === STRUCTURE_ROAD &&
        s.hits / s.hitsMax < 0.75 &&
        s.hits / s.hitsMax >= 0.25 &&
        s.hits < s.hitsMax
      );
    },
    label: 'Repair Road <75%'
  }
];

// Helper: flatten structuresByType map into an array
function flattenStructures(structuresByType) {
  var out = [];
  for (var t in structuresByType) {
    if (!structuresByType.hasOwnProperty(t)) continue;
    var arr = structuresByType[t];
    for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  }
  return out;
}

// Helper: choose closest by range using getRangeTo
function closestByRange(pos, list) {
  var best = null;
  var bestR = Infinity;
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    var oPos = (o.pos && o.pos.x !== undefined) ? o.pos : o;
    var r = pos.getRangeTo(oPos);
    if (r < bestR) {
      bestR = r;
      best = o;
    }
  }
  return best;
}

// == FIND BEST JOB ==
function findBestJob(creep) {
  var rs = getRoomState.get(creep.room.name);
  if (!rs) return null;

  // Get all candidate targets
  var candidates = [];

  // Collect all structures for repair checks
  var allStructures = rs.structuresByType ? flattenStructures(rs.structuresByType) : [];

  for (var i = 0; i < PRIORITIES.length; i++) {
    var prio = PRIORITIES[i];

    // Skip repair/reinforce in unowned rooms
    if ((prio.type === 'repair' || prio.type === 'reinforce') &&
        (!rs.controller || !rs.controller.my)) {
      continue;
    }

    var targets;
    if (prio.type === 'build') {
      targets = rs.constructionSites || [];
    } else {
      targets = [];
      for (var sIdx = 0; sIdx < allStructures.length; sIdx++) {
        var s = allStructures[sIdx];
        if (prio.filter(s)) targets.push(s);
      }
    }

    for (var t = 0; t < targets.length; t++) {
      candidates.push({
        target: targets[t],
        type: prio.type,
        label: prio.label
      });
    }
  }

  if (!candidates.length) return null;

  // Check for spawn construction sites - always prioritize these first
  for (var sp = 0; sp < candidates.length; sp++) {
    var c = candidates[sp];
    if (c.type === 'build' && c.target.structureType === STRUCTURE_SPAWN) {
      return c;
    }
  }

  // Determine reference point: storage > spawn > creep position
  var referencePos = null;

  // Try storage first
  var storages = (rs.structuresByType && rs.structuresByType[STRUCTURE_STORAGE]) || [];
  if (storages.length > 0) {
    referencePos = storages[0].pos;
  }

  // Then try spawn
  if (!referencePos) {
    var spawns = (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) || [];
    if (spawns.length > 0) {
      referencePos = spawns[0].pos;
    }
  }

  // Fall back to creep position
  if (!referencePos) {
    referencePos = creep.pos;
  }

  // Find closest candidate to reference point
  var best = null;
  var bestDist = Infinity;

  for (var j = 0; j < candidates.length; j++) {
    var cand = candidates[j];
    var dist = referencePos.getRangeTo(cand.target.pos);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }

  return best;
}

// == LOGGING ==
function logBuilderTasks(room, creep) {
  console.log('🔨 BUILDER STATUS - ' + room.name + ' (Tick ' + Game.time + ')');
  console.log('┌────────────────────────────┬──────────────┬──────────────┐');
  console.log('│    Name                    │   Task       │   Target     │');
  console.log('├────────────────────────────┼──────────────┼──────────────┤');

  var builders = _.filter(Game.creeps, function(c) {
    return c.memory.role === 'builder' && c.room.name === room.name;
  });

  if (!builders.length) {
    console.log('│               No builder creeps in this room.              │');
  } else {
    for (var b = 0; b < builders.length; b++) {
      var c = builders[b];
      var name = (c.name + '                          ').slice(0, 26);
      var task = (c.memory.task && c.memory.task.label ? c.memory.task.label : 'Idle');
      task = (task + '            ').slice(0, 12);
      var tgt = (c.memory.task && c.memory.task.targetId ? c.memory.task.targetId.slice(-6) : '');
      tgt = (tgt + '            ').slice(0, 12);
      console.log('│ ' + name + ' │ ' + task + ' │ ' + tgt + ' │');
    }
  }
  console.log('└────────────────────────────┴──────────────┴──────────────┘');
}

// == FIND IDLE SPOT NEAR ROAD ==
function findIdleSpotNearRoad(creep) {
  var rs = getRoomState.get(creep.room.name);
  var roads = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_ROAD]) ? rs.structuresByType[STRUCTURE_ROAD] : [];
  var road = null;
  if (roads.length > 0) {
    road = creep.pos.findClosestByPath(roads);
  }
  if (!road) return null;

  var positions = [];
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = road.pos.x + dx;
      var y = road.pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      var pos = new RoomPosition(x, y, road.pos.roomName);

      // Avoid positions too close to room edge
      if (isNearRoomEdge(pos, 1)) continue;

      var structs = pos.lookFor(LOOK_STRUCTURES);
      var hasRoad = false;
      var hasObs = false;
      for (var i = 0; i < structs.length; i++) {
        var s = structs[i];
        if (s.structureType === STRUCTURE_ROAD) hasRoad = true;
        if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) hasObs = true;
      }
      var hasCreep = pos.lookFor(LOOK_CREEPS).length > 0;
      var terrain = pos.lookFor(LOOK_TERRAIN);
      // lookFor returns an array, check first element
      if ((terrain[0] === 'wall') || hasRoad || hasCreep || hasObs) continue;
      positions.push(pos);
    }
  }

  if (positions.length) {
    return closestByRange(creep.pos, positions);
  }
  return null;
}

// == Helper: is a position within N tiles of the room edge? ==
function isNearRoomEdge(pos, margin) {
  margin = margin || 2;
  return (
    pos.x < margin ||
    pos.x > 49 - margin ||
    pos.y < margin ||
    pos.y > 49 - margin
  );
}

// == Helper: nudge off room edges (single-step inward) ==
function nudgeOffRoomEdge(creep) {
  if (creep.pos.y === 0) {
    var mv = creep.move(BOTTOM);
    if (mv === OK) return true;
    if (creep.pos.x > 0 && creep.move(BOTTOM_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(BOTTOM_RIGHT) === OK) return true;
  } else if (creep.pos.y === 49) {
    var mv2 = creep.move(TOP);
    if (mv2 === OK) return true;
    if (creep.pos.x > 0 && creep.move(TOP_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(BOTTOM_RIGHT) === OK) return true;
  } else if (creep.pos.x === 0) {
    var mv3 = creep.move(RIGHT);
    if (mv3 === OK) return true;
    if (creep.pos.y > 0 && creep.move(TOP_RIGHT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(BOTTOM_RIGHT) === OK) return true;
  } else if (creep.pos.x === 49) {
    var mv4 = creep.move(LEFT);
    if (mv4 === OK) return true;
    if (creep.pos.y > 0 && creep.move(TOP_LEFT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(BOTTOM_LEFT) === OK) return true;
  }
  return false;
}

// == Pathing: discourage edge tiles for in-room navigation ==
function applyEdgePenalty(roomName, costMatrix) {
  for (var x = 0; x < 50; x++) {
    costMatrix.set(x, 0, 255);
    costMatrix.set(x, 49, 255);
    var c1 = costMatrix.get(x, 1);
    var c48 = costMatrix.get(x, 48);
    costMatrix.set(x, 1, Math.max(c1, 10));
    costMatrix.set(x, 48, Math.max(c48, 10));
  }
  for (var y = 0; y < 50; y++) {
    costMatrix.set(0, y, 255);
    costMatrix.set(49, y, 255);
    var c2 = costMatrix.get(1, y);
    var c47 = costMatrix.get(48, y);
    costMatrix.set(1, y, Math.max(c2, 10));
    costMatrix.set(48, y, Math.max(c47, 10));
  }
}

// == Wrapper: in-room move that avoids edges unless target is on the edge ==
function moveToWithinRoom(creep, target, opts) {
  if (isNearRoomEdge(creep.pos, 1)) {
    if (nudgeOffRoomEdge(creep)) return;
  }

  var mopts = opts || {};
  mopts.maxRooms = 1;

  var targetOnEdge = false;
  if (target && target.pos && target.pos.roomName === creep.room.name) {
    targetOnEdge = isNearRoomEdge(target.pos, 1);
  }

  mopts.costCallback = function(roomName, costMatrix) {
    if (roomName === creep.room.name && !targetOnEdge) {
      applyEdgePenalty(roomName, costMatrix);
    }
  };

  creep.moveTo(target, mopts);
}

// == ENERGY ACQUISITION ==
function acquireEnergy(creep) {
  var rs = getRoomState.get(creep.room.name);
  var need = creep.store.getFreeCapacity(RESOURCE_ENERGY);

  var storArr = [];
  var contArr = [];
  if (rs && rs.structuresByType) {
    storArr = rs.structuresByType[STRUCTURE_STORAGE] || [];
    contArr = rs.structuresByType[STRUCTURE_CONTAINER] || [];
  }

  var hasStorage = storArr.length > 0;

  var storageWithEnergy = [];
  for (var si = 0; si < storArr.length; si++) {
    var st = storArr[si];
    if (st && st.store && st.store[RESOURCE_ENERGY] > 0) {
      storageWithEnergy.push(st);
    }
  }
  var hasStorageWithEnergy = storageWithEnergy.length > 0;
  var storageEmptyMode = hasStorage && !hasStorageWithEnergy;

  // Reuse cached energy target if valid
  if (creep.memory.energyTargetId) {
    var t = Game.getObjectById(creep.memory.energyTargetId);

    if (t && t.pos && t.pos.roomName && t.pos.roomName !== creep.room.name) {
      delete creep.memory.energyTargetId;
      t = null;
    }

    if (t) {
      if (hasStorageWithEnergy && (!t.structureType || t.structureType !== STRUCTURE_STORAGE)) {
        delete creep.memory.energyTargetId;
        t = null;
      } else if (storageEmptyMode) {
        delete creep.memory.energyTargetId;
        t = null;
      }
    }

    if (t) {
      if (t.structureType && t.store && t.store[RESOURCE_ENERGY] > 0) {
        if (!creep.pos.inRangeTo(t, 1)) {
          moveToWithinRoom(creep, t, { range: 1, reusePath: 15 });
          return true;
        }
        var wr = creep.withdraw(t, RESOURCE_ENERGY);
        if (wr === OK) return true;
        if (wr === ERR_NOT_ENOUGH_RESOURCES || wr === ERR_INVALID_TARGET) {
          delete creep.memory.energyTargetId;
        }
        return true;
      }

      if (!t.structureType && t.resourceType === RESOURCE_ENERGY && t.amount > 0) {
        if (!creep.pos.inRangeTo(t, 1)) {
          moveToWithinRoom(creep, t, { range: 1, reusePath: 15 });
          return true;
        }
        var pk = creep.pickup(t);
        if (pk === OK) return true;
        if (pk === ERR_INVALID_TARGET) {
          delete creep.memory.energyTargetId;
        }
        return true;
      }
    }

    delete creep.memory.energyTargetId;
  }

  // === SELECTION PHASE ===

  // 1) Storage with energy - always use this first
  if (hasStorageWithEnergy) {
    var storesRich = [];
    for (var rsi = 0; rsi < storageWithEnergy.length; rsi++) {
      var ss = storageWithEnergy[rsi];
      if (ss.store && ss.store[RESOURCE_ENERGY] >= need) {
        storesRich.push(ss);
      }
    }
    var poolStore = storesRich.length ? storesRich : storageWithEnergy;
    var pickStore = closestByRange(creep.pos, poolStore);
    if (pickStore) {
      creep.memory.energyTargetId = pickStore.id;
      return true;
    }
  }

  // 2) Storage exists but empty - harvest directly
  if (storageEmptyMode) {
    var srcEmptyMode = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
    if (srcEmptyMode) {
      if (!creep.pos.inRangeTo(srcEmptyMode, 1)) {
        moveToWithinRoom(creep, srcEmptyMode, { range: 1, reusePath: 15 });
      } else {
        creep.harvest(srcEmptyMode);
      }
      return true;
    }
    return false;
  }

  // 3) No storage - use containers, then dropped, then harvest

  // Containers
  var contWithEnergy = [];
  for (var ci = 0; ci < contArr.length; ci++) {
    var c = contArr[ci];
    if (c && c.store && c.store[RESOURCE_ENERGY] > 0) {
      contWithEnergy.push(c);
    }
  }
  if (contWithEnergy.length) {
    var contRich = [];
    for (var cri = 0; cri < contWithEnergy.length; cri++) {
      var cc = contWithEnergy[cri];
      if (cc.store && cc.store[RESOURCE_ENERGY] >= need) {
        contRich.push(cc);
      }
    }
    var poolCont = contRich.length ? contRich : contWithEnergy;
    var pickCont = closestByRange(creep.pos, poolCont);
    if (pickCont) {
      creep.memory.energyTargetId = pickCont.id;
      return true;
    }
  }

  // Dropped energy (avoid room edges)
  var dropsAny = [];
  var dropped = (rs && rs.dropped) ? rs.dropped : [];
  for (var d = 0; d < dropped.length; d++) {
    var rsrc = dropped[d];
    if (rsrc && rsrc.resourceType === RESOURCE_ENERGY && !isNearRoomEdge(rsrc.pos, 2)) {
      dropsAny.push(rsrc);
    }
  }
  if (dropsAny.length) {
    var dropsRich = [];
    for (var di = 0; di < dropsAny.length; di++) {
      if (dropsAny[di].amount >= need) dropsRich.push(dropsAny[di]);
    }

    var poolDrops;
    if (dropsRich.length) {
      poolDrops = dropsRich;
    } else {
      poolDrops = [];
      for (var fj = 0; fj < dropsAny.length; fj++) {
        if (dropsAny[fj].amount > 50) {
          poolDrops.push(dropsAny[fj]);
        }
      }
      if (!poolDrops.length) {
        poolDrops = dropsAny;
      }
    }

    if (poolDrops.length) {
      var pickDrop = closestByRange(creep.pos, poolDrops);
      if (pickDrop) {
        creep.memory.energyTargetId = pickDrop.id;
        return true;
      }
    }
  }

  // Last resort: harvest
  var src = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (src) {
    if (!creep.pos.inRangeTo(src, 1)) {
      moveToWithinRoom(creep, src, { range: 1, reusePath: 15 });
    } else {
      creep.harvest(src);
    }
    return true;
  }

  return false;
}

// == MAIN BUILDER ROLE ==
var roleBuilder = {
  run: function(creep) {
    // Initialize room state once per tick
    getRoomState.init();

    // State machine
    if (creep.memory.filling && creep.store.getFreeCapacity() === 0) {
      creep.memory.filling = false;
    }
    if (!creep.memory.filling && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.filling = true;
    }

    if (creep.memory.filling) {
      if (!acquireEnergy(creep)) {
        var spot = findIdleSpotNearRoad(creep);
        if (spot && !creep.pos.isEqualTo(spot)) {
          moveToWithinRoom(creep, spot, { reusePath: 15 });
        }
      }
      return;
    }

    // Work logic
    var task = creep.memory.task || {};
    var target = task.targetId ? Game.getObjectById(task.targetId) : null;

    // Unassign completed/invalid tasks
    var done = false;

    if (task.type === 'build') {
      if (!target) {
        // Construction site gone - check if it became a rampart needing reinforcement
        if (task.structureType === STRUCTURE_RAMPART && task.targetPos) {
          var pos = new RoomPosition(task.targetPos.x, task.targetPos.y, task.targetPos.roomName);
          var structs = pos.lookFor(LOOK_STRUCTURES);
          var newRampart = null;
          for (var si = 0; si < structs.length; si++) {
            if (structs[si].structureType === STRUCTURE_RAMPART) {
              newRampart = structs[si];
              break;
            }
          }
          if (newRampart && newRampart.hits < RAMPART_REINFORCE_TARGET) {
            // Transition to reinforcing the newly built rampart
            creep.memory.task = {
              type: 'reinforce',
              targetId: newRampart.id,
              label: 'Reinforce Rampart'
            };
            task = creep.memory.task;
            target = newRampart;
          } else {
            done = true;
          }
        } else {
          done = true;
        }
      } else if (target.progress >= target.progressTotal) {
        done = true;
      }
    }

    if (task.type === 'repair' && (!target || target.hits >= target.hitsMax)) done = true;

    if (task.type === 'reinforce') {
      if (!target) {
        done = true;
      } else if (target.structureType === STRUCTURE_RAMPART && target.hits >= RAMPART_REINFORCE_TARGET) {
        done = true;
      } else if (target.hits >= target.hitsMax) {
        done = true;
      }
    }

    if (done) {
      delete creep.memory.task;
      task = {};
      target = null;
    }

    // Assign new task if idle
    if (!task.targetId) {
      var job = findBestJob(creep);

      if (job) {
        var newTask = {
          type: job.type,
          targetId: job.target.id,
          label: job.label
        };
        // Store position and structure type for build tasks (needed for rampart transition)
        if (job.type === 'build' && job.target.pos) {
          newTask.structureType = job.target.structureType;
          newTask.targetPos = {
            x: job.target.pos.x,
            y: job.target.pos.y,
            roomName: job.target.pos.roomName
          };
        }
        creep.memory.task = newTask;
      } else {
        creep.memory.task = { type: 'idle', targetId: null, label: 'Idle' };
      }

      task = creep.memory.task;
      target = task.targetId ? Game.getObjectById(task.targetId) : null;
    }

    // Execute task
    if (!target && task.type !== 'idle') {
      delete creep.memory.task;
    } else {
      switch (task.type) {
        case 'build': {
          var workRange = 3;
          if (!creep.pos.inRangeTo(target, workRange)) {
            moveToWithinRoom(creep, target, { range: workRange, reusePath: 15 });
          } else {
            creep.build(target);
          }
          break;
        }
        case 'repair':
        case 'reinforce': {
          var repairRange = 3;
          if (!creep.pos.inRangeTo(target, repairRange)) {
            moveToWithinRoom(creep, target, { range: repairRange, reusePath: 15 });
          } else {
            creep.repair(target);
          }
          break;
        }
        case 'idle':
        default: {
          var idle = findIdleSpotNearRoad(creep);
          if (idle && !creep.pos.isEqualTo(idle)) {
            moveToWithinRoom(creep, idle, { visualizePathStyle: { stroke: '#888888' }, reusePath: 15 });
          }
          break;
        }
      }
    }

    // Optional logging
    if (BUILDER_LOGGING && (Game.time % BUILDER_LOG_INTERVAL) === 0) {
      logBuilderTasks(creep.room, creep);
    }
  }
};

module.exports = roleBuilder;