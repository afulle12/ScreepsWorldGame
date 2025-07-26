const BUILDER_LOGGING = false;
const BUILDER_LOG_INTERVAL = 5;
const JOB_QUEUE_REFRESH_INTERVAL = 5; // Rebuild queue every 5 ticks (adjust for your needs)

// == TASK PRIORITIES ==
const PRIORITIES = [
  {
    type: 'repair',
    filter: s =>
      (s.structureType !== STRUCTURE_CONTAINER &&
       s.structureType !== STRUCTURE_WALL &&
       s.structureType !== STRUCTURE_RAMPART) &&
      (s.hits / s.hitsMax < 0.25) &&
      s.hits < s.hitsMax,
    label: 'Repair <25%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
  {
    type: 'build',
    filter: s => true,
    targetFinder: room => room.find(FIND_CONSTRUCTION_SITES),
    label: 'Build',
    need: s => `${s.progress}/${s.progressTotal}`,
    urgency: s => -s.progress,
  },
  {
    type: 'repair',
    filter: s =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.hits / s.hitsMax < 0.75 &&
      s.hits < s.hitsMax,
    label: 'Repair Container <75%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
  {
    type: 'repair',
    filter: s =>
      s.structureType === STRUCTURE_ROAD &&
      s.hits / s.hitsMax < 0.75 &&
      s.hits / s.hitsMax >= 0.25 &&
      s.hits < s.hitsMax,
    label: 'Repair Road <75%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
];

// == GLOBAL JOB QUEUE GENERATION ==
function buildGlobalJobQueue() {
  let jobs = [];
  for (let roomName in Game.rooms) {
    let room = Game.rooms[roomName];
    for (let prio of PRIORITIES) {
      if ((prio.type === 'repair' || prio.type === 'reinforce') && 
          (!room.controller || !room.controller.my)) {
        continue;
      }
      let targets = prio.targetFinder
        ? prio.targetFinder(room)
        : room.find(FIND_STRUCTURES, { filter: prio.filter });
      targets.sort((a, b) => prio.urgency(a) - prio.urgency(b));
      for (let t of targets) {
        jobs.push({
          roomName: room.name,
          type: prio.type,
          label: prio.label,
          id: t.id,
          pos: { x: t.pos.x, y: t.pos.y },
          need: prio.need ? prio.need(t) : '',
          urgency: prio.urgency ? prio.urgency(t) : 0,
          assigned: []
        });
      }
    }
  }
  return jobs;
}

// == ASSIGNMENTS ==
function getAssignments() {
  let assignments = {};
  for (let name in Game.creeps) {
    let creep = Game.creeps[name];
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
    let jobs = Memory._builderJobs || [];
    for (let job of jobs) {
      job.assigned = Memory._builderAssignments[job.id] || [];
    }

    Memory._builderDataTick = Game.time;
  }
}

// == LOGGING (SLIGHTLY OPTIMIZED) ==
function logBuilderTasks(room, jobs, assignments) {
  console.log(`🔨 BUILDER TASKS - ${room.name} (Tick ${Game.time})`);
  console.log('┌──────────────────────┬────────┬────────────────┬─────────────┬──────────────────────────────┐');
  console.log('│      Type            │   ID   │      Pos       │    Need     │   Assigned                  │');
  console.log('├──────────────────────┼────────┼────────────────┼─────────────┼──────────────────────────────┤');
  if (jobs.length === 0) {
    console.log('│                  No builder jobs available this tick.                                      │');
  } else {
    for (let job of jobs) {
      let type = job.label.padEnd(20);
      let id = job.id.slice(-6).padEnd(6);
      let pos = `${job.roomName}:${job.pos.x},${job.pos.y}`.padEnd(14);
      let need = (job.need || '').padEnd(11);
      let assigned = (job.assigned.length ? job.assigned.join(',') : '').padEnd(28);
      console.log(`│ ${type} │ ${id} │ ${pos} │ ${need} │ ${assigned} │`);
    }
  }
  console.log('└──────────────────────┴────────┴────────────────┴─────────────┴──────────────────────────────┘');

  console.log('Builder Status:');
  console.log('┌────────────────────────────┬──────────────┬──────────────┐');
  console.log('│    Name                    │   Task       │   Target     │');
  console.log('├────────────────────────────┼──────────────┼──────────────┤');
  let builders = _.filter(Game.creeps, c => c.memory.role === 'builder' && c.room.name === room.name);
  if (!builders.length) {
    console.log('│               No builder creeps in this room.              │');
  } else {
    for (let creep of builders) {
      let name = creep.name.padEnd(26);
      let task = (creep.memory.task && creep.memory.task.label ? creep.memory.task.label : 'Idle').padEnd(12);
      let tgt = (creep.memory.task && creep.memory.task.targetId ? creep.memory.task.targetId.slice(-6) : '').padEnd(12);
      console.log(`│ ${name} │ ${task} │ ${tgt} │`);
    }
  }
  console.log('└────────────────────────────┴──────────────┴──────────────┘');
}

// == FIND IDLE SPOT NEAR ROAD (OPTIMIZED) ==
function findIdleSpotNearRoad(creep) {
  let road = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_ROAD
  });
  if (!road) return null;

  const positions = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = road.pos.x + dx;
      const y = road.pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      const pos = new RoomPosition(x, y, road.pos.roomName);
      const structs = pos.lookFor(LOOK_STRUCTURES);
      const hasRoad = structs.some(s => s.structureType === STRUCTURE_ROAD);
      const hasCreep = pos.lookFor(LOOK_CREEPS).length > 0;
      const hasObs = structs.some(s => OBSTACLE_OBJECT_TYPES.includes(s.structureType));
      const terrain = pos.lookFor(LOOK_TERRAIN)[0];
      if (terrain === 'wall' || hasRoad || hasCreep || hasObs) continue;
      positions.push(pos);
    }
  }

  if (positions.length) {
    return creep.pos.findClosestByPath(positions);
  }
  return null;
}


// == ENERGY ACQUISITION (SLIGHT TWEAKS FOR EFFICIENCY) ==
function acquireEnergy(creep) {
  // 1) Largest dropped resources first (sort by amount for better priority)
  let dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 25
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      creep.moveTo(dropped);
    }
    return true;
  }

  // 2) Containers / Storage with energy
  let src = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: s =>
      (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
      s.store[RESOURCE_ENERGY] > 0
  });
  if (src) {
    if (creep.withdraw(src, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(src);
    }
    return true;
  }

  // 3) Harvest from active source
  let src2 = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (src2) {
    if (creep.harvest(src2) === ERR_NOT_IN_RANGE) {
      creep.moveTo(src2);
    }
    return true;
  }

  return false;
}

// == MAIN BUILDER ROLE ==
const roleBuilder = {
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
        let spot = findIdleSpotNearRoad(creep);
        if (spot && !creep.pos.isEqualTo(spot)) {
          creep.moveTo(spot);
        }
      }
      return;
    }

    // Work logic
    let jobs = Memory._builderJobs || [];
    let task = creep.memory.task || {};
    let target = task.targetId ? Game.getObjectById(task.targetId) : null;

    // Unassign completed/invalid tasks
    let done = false;
    if (task.type === 'build' && (!target || target.progress >= target.progressTotal)) done = true;
    if ((task.type === 'repair' || task.type === 'reinforce') && (!target || target.hits >= target.hitsMax)) done = true;
    if (done) {
      delete creep.memory.task;
      task = {};
      target = null;
    }

    // Assign new task if idle
    if (!task.targetId) {
      let avail = jobs.filter(j => !j.assigned.includes(creep.name));
      if (avail.length) {
        avail.sort((a, b) => {
          let da = Game.map.getRoomLinearDistance(creep.room.name, a.roomName, true) * 50 + // Approximate room dist (50 tiles/room)
                   Math.abs(creep.pos.x - a.pos.x) + Math.abs(creep.pos.y - a.pos.y);
          let db = Game.map.getRoomLinearDistance(creep.room.name, b.roomName, true) * 50 +
                   Math.abs(creep.pos.x - b.pos.x) + Math.abs(creep.pos.y - b.pos.y);
          return da - db || a.urgency - b.urgency;
        });
        let job = avail[0];
        creep.memory.task = {
          type: job.type,
          targetId: job.id,
          label: job.label,
          roomName: job.roomName
        };
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
        case 'build':
          if (creep.build(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
          }
          break;
        case 'repair':
        case 'reinforce':
          if (creep.repair(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
          }
          break;
        case 'idle':
        default:
          let idle = findIdleSpotNearRoad(creep);
          if (idle && !creep.pos.isEqualTo(idle)) {
            creep.moveTo(idle, { visualizePathStyle: { stroke: '#888888' } });
          }
          break;
      }
    }

    // Optional logging (only for first builder in room)
    if (BUILDER_LOGGING && (Game.time % BUILDER_LOG_INTERVAL) === 0) {
      const roomJobs = (Memory._builderJobs || []).filter(j => j.roomName === creep.room.name);
      logBuilderTasks(creep.room, roomJobs, Memory._builderAssignments);
    }
  }
};

module.exports = roleBuilder;
