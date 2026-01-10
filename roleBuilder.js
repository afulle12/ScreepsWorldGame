// roleBuilder.js
// Notes:
// - All direct room.find calls replaced with getRoomState reads.
// - No optional chaining used.
// - Initializes getRoomState once per tick before queue generation.
// - In-room navigation avoids room edges; builders step inward if sitting on an edge.
// - Pathing wrapper uses maxRooms: 1 and edge penalties to prevent edge pulsing.

var getRoomState = require('getRoomState');

const BUILDER_LOGGING = false;
const BUILDER_LOG_INTERVAL = 5;
const JOB_QUEUE_REFRESH_INTERVAL = 5; // Rebuild queue every 5 ticks (adjust for your needs)
const MAX_JOBS_PER_PRIORITY_PER_ROOM = 20; // Suggestion #3: cap jobs per priority per room

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
    label: 'Repair <25%',
    need: function(s) { return s.hits + '/' + s.hitsMax; },
    urgency: function(s) { return s.hits; }
  },
  {
    type: 'build',
    filter: function(s) { return true; },
    // Use getRoomState instead of room.find
    targetFinder: function(room) {
      var rs = getRoomState.get(room.name);
      return rs && rs.constructionSites ? rs.constructionSites : [];
    },
    label: 'Build',
    need: function(s) { return s.progress + '/' + s.progressTotal; },
    urgency: function(s) { return -s.progress; }
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
    label: 'Repair Container <75%',
    need: function(s) { return s.hits + '/' + s.hitsMax; },
    urgency: function(s) { return s.hits; }
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
    label: 'Repair Road <75%',
    need: function(s) { return s.hits + '/' + s.hitsMax; },
    urgency: function(s) { return s.hits; }
  }
];

// == UTILITY: select top-K by urgency without full sort (Suggestion #3) ==
// NOTE: smaller urgency value means "more urgent" (as in original sort)
function selectTopKByUrgency(items, k, urgencyFn) {
  if (!items || !items.length) return [];
  if (items.length <= k) {
    return items.slice().sort(function(a, b) { return urgencyFn(a) - urgencyFn(b); });
  }
  let best = [];
  let worstIdx = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const u = urgencyFn(it);
    if (best.length < k) {
      best.push({ it: it, u: u });
      if (worstIdx === -1 || u > best[worstIdx].u) worstIdx = best.length - 1;
    } else if (u < best[worstIdx].u) {
      best[worstIdx] = { it: it, u: u };
      // recompute worst
      let wi = 0;
      for (let j = 1; j < best.length; j++) if (best[j].u > best[wi].u) wi = j;
      worstIdx = wi;
    }
  }
  best.sort(function(a, b) { return a.u - b.u; });
  return best.map(function(x) { return x.it; });
}

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

// Helper: choose closest by range using getRangeTo (avoid findClosestByRange/profiler recursion)
function closestByRange(creepPos, list) {
  var best = null;
  var bestR = 999;
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    var pos = (o.pos && o.pos.x !== undefined) ? o.pos : o;
    var r = creepPos.getRangeTo(pos);
    if (r < bestR) {
      bestR = r;
      best = o;
    }
  }
  return best;
}

// == GLOBAL JOB QUEUE GENERATION (Suggestions #3, #5) ==
function buildGlobalJobQueue() {
  var jobs = [];
  for (var roomName in Game.rooms) {
    if (!Game.rooms.hasOwnProperty(roomName)) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue; // only rooms we own or have creeps in are cached

    for (var i = 0; i < PRIORITIES.length; i++) {
      var prio = PRIORITIES[i];
      if ((prio.type === 'repair' || prio.type === 'reinforce') &&
          (!rs.controller || !rs.controller.my)) {
        continue;
      }

      var candidates;
      if (prio.type === 'build') {
        candidates = rs.constructionSites || [];
      } else {
        var allStructures = rs.structuresByType ? flattenStructures(rs.structuresByType) : [];
        candidates = [];
        for (var sIdx = 0; sIdx < allStructures.length; sIdx++) {
          var s = allStructures[sIdx];
          if (prio.filter(s)) candidates.push(s);
        }
      }

      var targets = selectTopKByUrgency(candidates, MAX_JOBS_PER_PRIORITY_PER_ROOM, prio.urgency);

      for (var t = 0; t < targets.length; t++) {
        var target = targets[t];
        jobs.push({
          roomName: rs.name,
          type: prio.type,
          label: prio.label,
          id: target.id,
          pos: { x: target.pos.x, y: target.pos.y },
          need: prio.need ? prio.need(target) : '',
          urgency: prio.urgency ? prio.urgency(target) : 0,
          assigned: []
        });
      }
    }
  }
  return jobs;
}

// == ASSIGNMENTS ==
function getAssignments() {
  var assignments = {};
  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
    if (creep.memory.role === 'builder' && creep.memory.task && creep.memory.task.targetId) {
      if (!assignments[creep.memory.task.targetId]) {
        assignments[creep.memory.task.targetId] = [];
      }
      assignments[creep.memory.task.targetId].push(creep.name);
    }
  }
  return assignments;
}

// == GLOBAL UPDATE (CALL ONCE PER TICK) ==
function updateGlobalBuilderData() {
  // Ensure room state is initialized once per tick
  getRoomState.init();

  if (!Memory._builderDataTick || Memory._builderDataTick !== Game.time) {
    // Refresh assignments every tick (cheap, as creep count is low)
    Memory._builderAssignments = getAssignments();

    // Refresh jobs less often
    if (!Memory._builderJobsTick || Game.time - Memory._builderJobsTick >= JOB_QUEUE_REFRESH_INTERVAL) {
      Memory._builderJobs = buildGlobalJobQueue();
      Memory._builderJobsTick = Game.time;
    }

    // Apply assignments to jobs
    var jobs = Memory._builderJobs || [];
    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j];
      job.assigned = Memory._builderAssignments[job.id] || [];
    }

    Memory._builderDataTick = Game.time;
  }
}

// == LOGGING (SLIGHTLY OPTIMIZED) ==
function logBuilderTasks(room, jobs, assignments) {
  console.log('🔨 BUILDER TASKS - ' + room.name + ' (Tick ' + Game.time + ')');
  console.log('┌──────────────────────┬────────┬────────────────┬─────────────┬──────────────────────────────┐');
  console.log('│      Type            │   ID   │      Pos       │    Need     │   Assigned                  │');
  console.log('├──────────────────────┼────────┼────────────────┼─────────────┼──────────────────────────────┤');
  if (jobs.length === 0) {
    console.log('│                  No builder jobs available this tick.                                      │');
  } else {
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var type = (job.label + '                    ').slice(0, 20);
      var id = (job.id.slice(-6) + '      ').slice(0, 6);
      var pos = (job.roomName + ':' + job.pos.x + ',' + job.pos.y + '              ').slice(0, 14);
      var need = ((job.need || '') + '           ').slice(0, 11);
      var assigned = ((job.assigned.length ? job.assigned.join(',') : '') + '                            ').slice(0, 28);
      console.log('│ ' + type + ' │ ' + id + ' │ ' + pos + ' │ ' + need + ' │ ' + assigned + ' │');
    }
  }
  console.log('└──────────────────────┴────────┴────────────────┴─────────────┴──────────────────────────────┘');

  console.log('Builder Status:');
  console.log('┌────────────────────────────┬──────────────┬──────────────┐');
  console.log('│    Name                    │   Task       │   Target     │');
  console.log('├────────────────────────────┼──────────────┼──────────────┤');
  var builders = _.filter(Game.creeps, function(c) { return c.memory.role === 'builder' && c.room.name === room.name; });
  if (!builders.length) {
    console.log('│               No builder creeps in this room.              │');
  } else {
    for (var b = 0; b < builders.length; b++) {
      var creep = builders[b];
      var name = (creep.name + '                          ').slice(0, 26);
      var task = (creep.memory.task && creep.memory.task.label ? creep.memory.task.label : 'Idle');
      task = (task + '            ').slice(0, 12);
      var tgt = (creep.memory.task && creep.memory.task.targetId ? creep.memory.task.targetId.slice(-6) : '');
      tgt = (tgt + '            ').slice(0, 12);
      console.log('│ ' + name + ' │ ' + task + ' │ ' + tgt + ' │');
    }
  }
  console.log('└────────────────────────────┴──────────────┘');
}

// == FIND IDLE SPOT NEAR ROAD (uses getRoomState for roads) ==
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
      var terrain = pos.lookFor(LOOK_TERRAIN); // Screeps API returns a string here
      if (terrain === 'wall' || hasRoad || hasCreep || hasObs) continue;
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
  margin = margin || 2; // default to 2 tiles
  return (
    pos.x < margin ||
    pos.x > 49 - margin ||
    pos.y < margin ||
    pos.y > 49 - margin
  );
}

// == Helper: nudge off room edges (single-step inward) ==
function nudgeOffRoomEdge(creep) {
  // If we're exactly on an outer border tile, take a single step inward.
  // This avoids cross-room pulsing when we are not intentionally exiting.
  if (creep.pos.y === 0) {
    var mv = creep.move(BOTTOM);
    if (mv === OK) return true;
    if (creep.pos.x > 0 && creep.move(BOTTOM_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(BOTTOM_RIGHT) === OK) return true;
  } else if (creep.pos.y === 49) {
    var mv2 = creep.move(TOP);
    if (mv2 === OK) return true;
    if (creep.pos.x > 0 && creep.move(TOP_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(TOP_RIGHT) === OK) return true;
  } else if (creep.pos.x === 0) {
    var mv3 = creep.move(RIGHT);
    if (mv3 === OK) return true;
    if (creep.pos.y > 0 && creep.move(BOTTOM_RIGHT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(TOP_RIGHT) === OK) return true;
  } else if (creep.posx === 49) {
    var mv4 = creep.move(LEFT);
    if (mv4 === OK) return true;
    if (creep.pos.y > 0 && creep.move(BOTTOM_LEFT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(TOP_LEFT) === OK) return true;
  }
  return false;
}

// == Pathing: discourage edge tiles for in-room navigation ==
function applyEdgePenalty(roomName, costMatrix) {
  // Penalize the outer ring heavily and inner ring lightly to keep routes away from borders.
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
  // If sitting on an edge, step inward first to prevent room pulsing.
  if (isNearRoomEdge(creep.pos, 1)) {
    if (nudgeOffRoomEdge(creep)) return;
  }

  var mopts = opts || {};
  mopts.maxRooms = 1; // never leave the room for normal builder navigation

  var targetOnEdge = false;
  // If target is an object in same room, check its edge status
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

// == ENERGY ACQUISITION (no recursion; avoid findClosestByRange) ==
function acquireEnergy(creep) {
  var rs = getRoomState.get(creep.room.name);
  var need = creep.store.getFreeCapacity(RESOURCE_ENERGY);

  // Get storage and containers in the room
  var storArr = [];
  var contArr = [];
  if (rs && rs.structuresByType) {
    storArr = rs.structuresByType[STRUCTURE_STORAGE] || [];
    contArr = rs.structuresByType[STRUCTURE_CONTAINER] || [];
  }

  var hasStorage = storArr.length > 0;

  // Determine storage state
  var storageWithEnergy = [];
  for (var si = 0; si < storArr.length; si++) {
    var st = storArr[si];
    if (st && st.store && st.store[RESOURCE_ENERGY] > 0) {
      storageWithEnergy.push(st);
    }
  }
  var hasStorageWithEnergy = storageWithEnergy.length > 0;
  var storageEmptyMode = hasStorage && !hasStorageWithEnergy;

  // Reuse cached energy target if valid and allowed by current priority rules
  if (creep.memory.energyTargetId) {
    var t = Game.getObjectById(creep.memory.energyTargetId);

    // Ensure cached energy target is in the same room; otherwise clear it
    if (t && t.pos && t.pos.roomName && t.pos.roomName !== creep.room.name) {
      delete creep.memory.energyTargetId;
      t = null;
    }

    // Enforce new priority rules on cached targets
    if (t) {
      // If storage in room has energy, only storage is allowed as a cached target
      if (hasStorageWithEnergy && (!t.structureType || t.structureType !== STRUCTURE_STORAGE)) {
        delete creep.memory.energyTargetId;
        t = null;
      }
      // If there is storage but it's empty, we always harvest: clear any cached target
      else if (storageEmptyMode) {
        delete creep.memory.energyTargetId;
        t = null;
      }
    }

    if (t) {
      // Structure withdraw
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
        return true; // attempted this tick
      }
      // Dropped pickup
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
        return true; // attempted this tick
      }
    }

    // Clear invalid/empty target; continue to selection below
    delete creep.memory.energyTargetId;
  }

  // === SELECTION PHASE ===

  // 1) If there is storage with energy, always use storage (ignore containers/drops/harvest)
  if (hasStorageWithEnergy) {
    var storesAny = storageWithEnergy;
    var storesRich = [];
    for (var rsi = 0; rsi < storesAny.length; rsi++) {
      var ss = storesAny[rsi];
      if (ss.store && ss.store[RESOURCE_ENERGY] >= need) {
        storesRich.push(ss);
      }
    }
    var poolStore = storesRich.length ? storesRich : storesAny;
    var pickStore = closestByRange(creep.pos, poolStore);
    if (pickStore) {
      creep.memory.energyTargetId = pickStore.id;
      return true;
    }
  }

  // 2) If there is storage in the room but all storages are empty,
  //    ALWAYS harvest directly (do not use containers or dropped energy).
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

  // 3) No storage exists in the room: use containers, then dropped, then harvest.

  // Containers first
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

  // Then sizeable dropped energy (avoid 2-tile room edge)
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
      // Prefer medium+ piles, but if nothing qualifies, just use all
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

  // Last resort: harvest (using FIND_SOURCES_ACTIVE)
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
    // Update global data once per tick (safe to call per creep; check prevents redundancy)
    updateGlobalBuilderData();

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
    var jobs = Memory._builderJobs || [];
    var task = creep.memory.task || {};
    var target = task.targetId ? Game.getObjectById(task.targetId) : null;

    // Unassign completed/invalid tasks
    var done = false;
    if (task.type === 'build' && (!target || target.progress >= target.progressTotal)) done = true;
    if ((task.type === 'repair' || task.type === 'reinforce') && (!target || target.hits >= target.hitsMax)) done = true;
    if (done) {
      delete creep.memory.task;
      task = {};
      target = null;
    }

    // Assign new task if idle (Suggestion #4: prefer same-room and one-pass best pick)
    if (!task.targetId) {
      var avail = jobs.filter(function(j) { return j.assigned.indexOf(creep.name) === -1; });

      // Prefer same-room jobs first
      var pools = [];
      var sameRoom = avail.filter(function(j) { return j.roomName === creep.room.name; });
      if (sameRoom.length) pools.push(sameRoom);
      if (avail.length) pools.push(avail); // fallback to all

      var chosen = null;
      var bestScore = Infinity;
      var bestUrg = Infinity;

      for (var p = 0; p < pools.length && !chosen; p++) {
        var pool = pools[p];
        for (var idx = 0; idx < pool.length; idx++) {
          var a = pool[idx];
          var score;
          if (a.roomName === creep.room.name) {
            // Cheaper estimate inside same room
            score = Math.abs(creep.pos.x - a.pos.x) + Math.abs(creep.pos.y - a.pos.y);
          } else {
            // Coarse room distance only (cheaper than full calc/sort)
            score = Game.map.getRoomLinearDistance(creep.room.name, a.roomName, true) * 50;
          }
          // Tie-break by urgency (smaller is more urgent)
          if (score < bestScore || (score === bestScore && a.urgency < bestUrg)) {
            bestScore = score;
            bestUrg = a.urgency;
            chosen = a;
          }
        }
        if (chosen && pool === sameRoom) break; // stick with same-room if found
      }

      if (chosen) {
        creep.memory.task = {
          type: chosen.type,
          targetId: chosen.id,
          label: chosen.label,
          roomName: chosen.roomName
        };
      } else {
        creep.memory.task = { type: 'idle', targetId: null, label: 'Idle' };
      }

      task = creep.memory.task;
      target = task.targetId ? Game.getObjectById(task.targetId) : null;
    }

    // Execute task (Suggestion #2: pre-check inRange and use range:3 + reusePath)
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

    // Optional logging (only for first builder in room)
    if (BUILDER_LOGGING && (Game.time % BUILDER_LOG_INTERVAL) === 0) {
      var roomJobs = (Memory._builderJobs || []).filter(function(j) { return j.roomName === creep.room.name; });
      logBuilderTasks(creep.room, roomJobs, Memory._builderAssignments);
    }
  }
};

module.exports = roleBuilder;
