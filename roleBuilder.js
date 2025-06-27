const BUILDER_LOGGING = false;
const BUILDER_LOG_INTERVAL = 5;

// == TASK PRIORITIES ==
const PRIORITIES = [
    {
        type: 'repair',
        filter: s =>
            (s.structureType !== STRUCTURE_CONTAINER &&
             s.structureType !== STRUCTURE_WALL &&
             s.structureType !== STRUCTURE_RAMPART) &&
            (s.structureType === STRUCTURE_ROAD || (s.hits / s.hitsMax < 0.25)) &&
            s.hits < s.hitsMax,
        label: 'Repair <25%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits, // lower is more urgent
    },
    {
        type: 'build',
        filter: s => true,
        targetFinder: room => room.find(FIND_CONSTRUCTION_SITES),
        label: 'Build',
        need: s => `${s.progress}/${s.progressTotal}`,
        urgency: s => s.progress, // lower is more urgent
    },
    {
        type: 'repair',
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.hits / s.hitsMax < 0.75 && s.hits < s.hitsMax,
        label: 'Repair Container <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'repair',
        filter: s => s.structureType === STRUCTURE_ROAD && s.hits / s.hitsMax < 0.75 && s.hits < s.hitsMax,
        label: 'Repair Road <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'repair',
        filter: s =>
            ![STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType) &&
            s.hits / s.hitsMax < 0.75 &&
            s.hits < s.hitsMax,
        label: 'Repair Other <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'reinforce',
        filter: s =>
            (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
            s.hits < 20000,
        label: 'Reinforce <20k',
        need: s => `${s.hits}/20000`,
        urgency: s => s.hits,
    },
    {
        type: 'collect',
        filter: r => r.amount > 50,
        targetFinder: room => room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 50 }),
        label: 'Collect >50',
        need: r => `${r.amount}`,
        urgency: r => -r.amount, // higher is more urgent, so use negative for descending sort
    },
];

// == JOB QUEUE BUILDER ==
function buildJobQueue(room) {
    let jobs = [];
    for (let prio of PRIORITIES) {
        let targets = prio.targetFinder
            ? prio.targetFinder(room)
            : room.find(FIND_STRUCTURES, { filter: prio.filter });
        // Sort by urgency within this priority
        targets.sort((a, b) => prio.urgency(a) - prio.urgency(b));
        for (let t of targets) {
            jobs.push({
                type: prio.type,
                label: prio.label,
                id: t.id,
                pos: `${t.pos.x},${t.pos.y}`,
                need: prio.need ? prio.need(t) : '',
                urgency: prio.urgency ? prio.urgency(t) : 0,
                assigned: null, // to be filled later
            });
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
            assignments[creep.memory.task.targetId] = creep.name;
        }
    }
    return assignments;
}

// == LOGGING ==
function logBuilderTasks(room, jobs, assignments) {
    console.log(`\n🔨 BUILDER TASKS - ${room.name} (Tick ${Game.time})`);
    console.log('┌──────────────────────┬────────┬─────────┬─────────────┬───────────────┐');
    console.log('│      Type            │   ID   │  Pos    │    Need     │   Assigned    │');
    console.log('├──────────────────────┼────────┼─────────┼─────────────┼───────────────┤');
    for (let job of jobs) {
        let type = job.label.padEnd(20);
        let id = job.id.substring(job.id.length - 6).padEnd(6);
        let pos = job.pos.padEnd(7);
        let need = (job.need || '').padEnd(11);
        let assigned = (assignments[job.id] || '').padEnd(13);
        console.log(`│ ${type} │ ${id} │ ${pos} │ ${need} │ ${assigned} │`);
    }
    console.log('└──────────────────────┴────────┴─────────┴─────────────┴───────────────┘');
}

// == FIND ADJACENT NON-ROAD POSITION ==
function findIdleSpotNearRoad(creep) {
    let road = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_ROAD
    });
    if (!road) return null;

    let positions = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            let x = road.pos.x + dx;
            let y = road.pos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            let pos = new RoomPosition(x, y, road.pos.roomName);
            let structures = creep.room.lookForAt(LOOK_STRUCTURES, pos);
            let hasRoad = structures.some(s => s.structureType === STRUCTURE_ROAD);
            let hasCreep = creep.room.lookForAt(LOOK_CREEPS, pos).length > 0;
            let hasObstacle = structures.some(s => OBSTACLE_OBJECT_TYPES.includes(s.structureType));
            if (!hasRoad && !hasCreep && !hasObstacle) {
                positions.push(pos);
            }
        }
    }
    if (positions.length > 0) {
        positions.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
        return positions[0];
    }
    return null;
}

// == MAIN BUILDER LOGIC ==
const roleBuilder = {
    run: function(creep) {
        if (!Memory._builderJobs || Memory._builderJobsTick !== Game.time || Memory._builderJobsRoom !== creep.room.name) {
            let jobs = buildJobQueue(creep.room);
            let assignments = getAssignments();
            for (let job of jobs) {
                job.assigned = assignments[job.id] || null;
            }
            Memory._builderJobs = jobs;
            Memory._builderAssignments = assignments;
            Memory._builderJobsTick = Game.time;
            Memory._builderJobsRoom = creep.room.name;
        }
        let jobs = Memory._builderJobs;
        let assignments = Memory._builderAssignments;

        let task = creep.memory.task;
        let target = task && task.targetId ? Game.getObjectById(task.targetId) : null;
        let needsUnassign = false;

        if (task && task.targetId) {
            if (
                (task.type === 'repair' || task.type === 'reinforce') &&
                (!target || target.hits === undefined || target.hits >= target.hitsMax)
            ) {
                needsUnassign = true;
            }
            if (task.type === 'build' && (!target || target.progress >= target.progressTotal)) {
                needsUnassign = true;
            }
            if (task.type === 'collect' && (!target || target.amount < 1)) {
                needsUnassign = true;
            }
        }
        if (!task || !task.targetId || assignments[task.targetId] !== creep.name || needsUnassign) {
            // Find the first unassigned job in priority order (jobs are already sorted by urgency)
            let myJob = jobs.find(j => !assignments[j.id]);
            if (myJob) {
                creep.memory.task = {
                    type: myJob.type,
                    targetId: myJob.id,
                    label: myJob.label
                };
                assignments[myJob.id] = creep.name;
                task = creep.memory.task;
                target = task.targetId ? Game.getObjectById(task.targetId) : null;
            } else {
                creep.memory.task = { type: 'idle', targetId: null, label: 'Idle' };
                task = creep.memory.task;
                target = null;
            }
        }

        // == EXECUTE TASK ==
        switch (task.type) {
            case 'repair':
            case 'reinforce':
                if (!target || target.hits === undefined || target.hits >= target.hitsMax) {
                    delete creep.memory.task;
                    break;
                }
                if (creep.store[RESOURCE_ENERGY] === 0) {
                    let source = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                        filter: s =>
                            (s.structureType === STRUCTURE_STORAGE ||
                             s.structureType === STRUCTURE_CONTAINER ||
                             s.structureType === STRUCTURE_EXTENSION ||
                             s.structureType === STRUCTURE_SPAWN) &&
                            s.store[RESOURCE_ENERGY] > 0
                    });
                    if (source) {
                        if (creep.withdraw(source, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
                        }
                    }
                } else {
                    if (creep.repair(target) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
                    }
                }
                break;

            case 'build':
                if (!target || target.progress >= target.progressTotal) {
                    delete creep.memory.task;
                    break;
                }
                if (creep.store[RESOURCE_ENERGY] === 0) {
                    let source = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                        filter: s =>
                            (s.structureType === STRUCTURE_STORAGE ||
                             s.structureType === STRUCTURE_CONTAINER ||
                             s.structureType === STRUCTURE_EXTENSION ||
                             s.structureType === STRUCTURE_SPAWN) &&
                            s.store[RESOURCE_ENERGY] > 0
                    });
                    if (source) {
                        if (creep.withdraw(source, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
                        }
                    }
                } else {
                    if (creep.build(target) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
                    }
                }
                break;

            case 'collect':
                if (!target || target.amount < 1) {
                    delete creep.memory.task;
                    break;
                }
                if (creep.store.getFreeCapacity() === 0) {
                    let deposit = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                        filter: s =>
                            (s.structureType === STRUCTURE_SPAWN ||
                             s.structureType === STRUCTURE_EXTENSION ||
                             s.structureType === STRUCTURE_CONTAINER ||
                             s.structureType === STRUCTURE_STORAGE) &&
                            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                    });
                    if (deposit) {
                        if (creep.transfer(deposit, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(deposit, { visualizePathStyle: { stroke: '#00ff00' } });
                        }
                    }
                } else {
                    if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, { visualizePathStyle: { stroke: '#ffaa00' } });
                    }
                }
                break;

            case 'idle':
            default:
                let idleSpot = findIdleSpotNearRoad(creep);
                if (idleSpot && !creep.pos.isEqualTo(idleSpot)) {
                    creep.moveTo(idleSpot, { visualizePathStyle: { stroke: '#888888' } });
                }
                break;
        }

        // == LOGGING ==
        if (
            BUILDER_LOGGING &&
            Game.time % BUILDER_LOG_INTERVAL === 0 &&
            creep.name === _.first(_.sortBy(_.filter(Game.creeps, c => c.memory.role === 'builder'), c => c.name)).name
        ) {
            logBuilderTasks(creep.room, jobs, assignments);
        }
    }
};

module.exports = roleBuilder;
