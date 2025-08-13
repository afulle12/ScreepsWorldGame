const BUILDER_LOGGING = false;
const BUILDER_LOG_INTERVAL = 5;
const JOB_QUEUE_REFRESH_INTERVAL = 5; // Rebuild queue every 5 ticks (adjust for your needs)
const MAX_JOBS_PER_PRIORITY_PER_ROOM = 20; // Suggestion #3: cap jobs per priority per room

// == TASK PRIORITIES ==
const PRIORITIES = [
  {
    type: 'repair',
    filter: function(s) {
      return (
        s.structureType !== STRUCTURE_CONTAINER &&
        s.structureType !== STRUCTURE_WALL &&
        s.structureType !== STRUCTURE_RAMPART &&
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
    targetFinder: function(room) { return room.find(FIND_CONSTRUCTION_SITES); },
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

// == PER-TICK ROOM CACHE (Suggestion #5) ==
function getRoomCache(room) {
  if (!global._roomCache || global._roomCache.time !== Game.time) {
    global._roomCache = { time: Game.time, rooms: {} };
  }
  let rc = global._roomCache.rooms[room.name];
  if (!rc) {
    rc = {
      structures: room.find(FIND_STRUCTURES),
      constructionSites: room.find(FIND_CONSTRUCTION_SITES),
      dropped: room.find(FIND_DROPPED_RESOURCES)
    };
    global._roomCache.rooms[room.name] = rc;
  }
  return rc;
}

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
      best.push({ it, u });
      if (worstIdx === -1 || u > best[worstIdx].u) worstIdx = best.length - 1;
    } else if (u < best[worstIdx].u) {
      best[worstIdx] = { it, u };
      // recompute worst
      let wi = 0;
      for (let j = 1; j < best.length; j++) if (best[j].u > best[wi].u) wi = j;
      worstIdx = wi;
    }
  }
  best.sort(function(a, b) { return a.u - b.u; });
  return best.map(x => x.it);
}

// == GLOBAL JOB QUEUE GENERATION (Suggestions #3, #5) ==
function buildGlobalJobQueue() {
  var jobs = [];
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    const rc = getRoomCache(room);

    for (var i = 0; i < PRIORITIES.length; i++) {
      var prio = PRIORITIES[i];
      if ((prio.type === 'repair' || prio.type === 'reinforce') &&
          (!room.controller || !room.controller.my)) {
        continue;
      }

      // Use cached finds
      var candidates;
      if (prio.type === 'build') {
        candidates = rc.constructionSites;
      } else {
        candidates = rc.structures.filter(prio.filter);
      }

      // Keep only top-K most urgent (avoid full sort)
      var targets = selectTopKByUrgency(candidates, MAX_JOBS_PER_PRIORITY_PER_ROOM, prio.urgency);

      for (var t = 0; t < targets.length; t++) {
        var target = targets[t];
        jobs.push({
          roomName: room.name,
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
  console.log('└────────────────────────────┴──────────────┴──────────────┘');
}

// == FIND IDLE SPOT NEAR ROAD (unchanged) ==
function findIdleSpotNearRoad(creep) {
  var road = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_ROAD; }
  });
  if (!road) return null;

  var positions = [];
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = road.pos.x + dx;
      var y = road.pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      var pos = new RoomPosition(x, y, road.pos.roomName);
      var structs = pos.lookFor(LOOK_STRUCTURES);
      var hasRoad = false;
      var hasObs = false;
      for (var i = 0; i < structs.length; i++) {
        var s = structs[i];
        if (s.structureType === STRUCTURE_ROAD) hasRoad = true;
        if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) hasObs = true;
      }
      var hasCreep = pos.lookFor(LOOK_CREEPS).length > 0;
      var terrain = pos.lookFor(LOOK_TERRAIN)[0];
      if (terrain === 'wall' || hasRoad || hasCreep || hasObs) continue;
      positions.push(pos);
    }
  }

  if (positions.length) {
    return creep.pos.findClosestByPath(positions);
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

// == ENERGY ACQUISITION (Suggestion #1 and #5) ==
function acquireEnergy(creep) {
  // Reuse cached energy target if valid
  if (creep.memory.energyTargetId) {
    var t = Game.getObjectById(creep.memory.energyTargetId);
    if (t) {
      // Structure withdraw
      if (t.structureType && t.store && t.store[RESOURCE_ENERGY] > 0) {
        if (!creep.pos.inRangeTo(t, 1)) {
          creep.moveTo(t, { range: 1, reusePath: 15 });
          return true;
        }
        var wr = creep.withdraw(t, RESOURCE_ENERGY);
        if (wr === OK) return true;
      }
      // Dropped pickup
      if (!t.structureType && t.resourceType === RESOURCE_ENERGY) {
        if (!creep.pos.inRangeTo(t, 1)) {
          creep.moveTo(t, { range: 1, reusePath: 15 });
          return true;
        }
        var pk = creep.pickup(t);
        if (pk === OK) return true;
      }
    }
    // Clear invalid/empty target and reselect
    delete creep.memory.energyTargetId;
  }

  // Prefer containers/storage (cheap withdraw)
  var rc = getRoomCache(creep.room);
  var stores = [];
  for (var i = 0; i < rc.structures.length; i++) {
    var s = rc.structures[i];
    if ((s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) &&
        s.store && s.store[RESOURCE_ENERGY] > 0) {
      stores.push(s);
    }
  }
  if (stores.length) {
    var pickStore = creep.pos.findClosestByRange(stores);
    if (pickStore) {
      creep.memory.energyTargetId = pickStore.id;
      return acquireEnergy(creep);
    }
  }

  // Then sizeable dropped energy (avoid 2-tile room edge)
  var drops = [];
  for (var d = 0; d < rc.dropped.length; d++) {
    var r = rc.dropped[d];
    if (r.resourceType === RESOURCE_ENERGY && r.amount > 50 && !isNearRoomEdge(r.pos, 2)) {
      drops.push(r);
    }
  }
  if (drops.length) {
    var pickDrop = creep.pos.findClosestByRange(drops);
    if (pickDrop) {
      creep.memory.energyTargetId = pickDrop.id;
      return acquireEnergy(creep);
    }
  }

  // Last resort: harvest
  var src = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (src) {
    if (!creep.pos.inRangeTo(src, 1)) creep.moveTo(src, { range: 1, reusePath: 15 });
    else creep.harvest(src);
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
          creep.moveTo(spot);
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
            creep.moveTo(target, { range: workRange, reusePath: 15 });
          } else {
            creep.build(target);
          }
          break;
        }
        case 'repair':
        case 'reinforce': {
          var repairRange = 3;
          if (!creep.pos.inRangeTo(target, repairRange)) {
            creep.moveTo(target, { range: repairRange, reusePath: 15 });
          } else {
            creep.repair(target);
          }
          break;
        }
        case 'idle':
        default: {
          var idle = findIdleSpotNearRoad(creep);
          if (idle && !creep.pos.isEqualTo(idle)) {
            creep.moveTo(idle, { visualizePathStyle: { stroke: '#888888' } });
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
