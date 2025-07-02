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
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.hits / s.hitsMax < 0.75 && s.hits < s.hitsMax,
        label: 'Repair Container <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'repair',
        filter: s =>
            s.structureType === STRUCTURE_ROAD &&
            (s.hits / s.hitsMax < 0.75) &&
            (s.hits / s.hitsMax >= 0.25) &&
            s.hits < s.hitsMax,
        label: 'Repair Road <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'repair',
        filter: s =>
            ![STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType) &&
            (s.hits / s.hitsMax < 0.75) &&
            (s.hits / s.hitsMax >= 0.25) &&
            s.hits < s.hitsMax,
        label: 'Repair Other <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'reinforce',
        filter: s =>
            (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
            s.hits < 100000,
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
        urgency: r => -r.amount,
    },
];

// == JOB QUEUE BUILDER ==
function buildJobQueue(room) {
    let jobs = [];
    for (let prio of PRIORITIES) {
        let targets = prio.targetFinder
            ? prio.targetFinder(room)
            : room.find(FIND_STRUCTURES, { filter: prio.filter });
        targets.sort((a, b) => prio.urgency(a) - prio.urgency(b));
        for (let t of targets) {
            jobs.push({
                type: prio.type,
                label: prio.label,
                id: t.id,
                pos: `${t.pos.x},${t.pos.y}`,
                need: prio.need ? prio.need(t) : '',
                urgency: prio.urgency ? prio.urgency(t) : 0,
                assigned: [],
                structureType: t.structureType || (t.structureType === undefined && t.structureType), // for construction sites
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
            if (!assignments[creep.memory.task.targetId]) assignments[creep.memory.task.targetId] = [];
            assignments[creep.memory.task.targetId].push(creep.name);
        }
    }
    return assignments;
}

// == LOGGING ==
function logBuilderTasks(room, jobs, assignments) {
    console.log(`🔨 BUILDER TASKS - ${room.name} (Tick ${Game.time})`);
    // Job Table
    console.log('┌──────────────────────┬────────┬─────────┬─────────────┬──────────────────────────────┐');
    console.log('│      Type            │   ID   │  Pos    │    Need     │   Assigned                  │');
    console.log('├──────────────────────┼────────┼─────────┼─────────────┼──────────────────────────────┤');
    if (jobs.length === 0) {
        const msg = 'No builder jobs available this tick.';
        const width = 58;
        const pad = Math.max(0, Math.floor((width - msg.length) / 2));
        const line = '│' + ' '.repeat(pad) + msg + ' '.repeat(Math.max(0, width - msg.length - pad)) + '│';
        console.log(line);
    } else {
        for (let job of jobs) {
            let type = job.label.padEnd(20);
            let id = job.id.substring(job.id.length - 6).padEnd(6);
            let pos = job.pos.padEnd(7);
            let need = (job.need || '').padEnd(11);
            let assignedList = (assignments[job.id] || []);
            let assigned = assignedList.length > 0 ? assignedList.join(',') : '';
            assigned = assigned.padEnd(28);
            console.log(`│ ${type} │ ${id} │ ${pos} │ ${need} │ ${assigned} │`);
        }
    }
    console.log('└──────────────────────┴────────┴─────────┴─────────────┴──────────────────────────────┘');

    // Builder Status Table
    let builders = _.filter(Game.creeps, c => c.memory.role === 'builder' && c.room.name === room.name);
    console.log('Builder Status:');
    console.log('┌────────────────────────────┬──────────────┬──────────────┐');
    console.log('│    Name                    │   Task       │   Target     │');
    console.log('├────────────────────────────┼──────────────┼──────────────┤');
    if (builders.length === 0) {
        const msg = 'No builder creeps in this room.';
        const width = 44;
        const pad = Math.max(0, Math.floor((width - msg.length) / 2));
        const line = '│' + ' '.repeat(pad) + msg + ' '.repeat(Math.max(0, width - msg.length - pad)) + '│';
        console.log(line);
    } else {
        for (let creep of builders) {
            let name = creep.name.padEnd(26);
            let task = (creep.memory.task && creep.memory.task.label ? creep.memory.task.label : 'Idle').padEnd(12);
            let tgt = (creep.memory.task && creep.memory.task.targetId ? creep.memory.task.targetId.substring(creep.memory.task.targetId.length - 6) : '').padEnd(12);
            console.log(`│ ${name} │ ${task} │ ${tgt} │`);
        }
    }
    console.log('└────────────────────────────┴──────────────┴──────────────┘');
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

// == ENERGY ACQUISITION LOGIC ==
function acquireEnergy(creep) {
    // Only withdraw from containers or storage, NOT spawns
    let source = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: s =>
            ((s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
             s.store && s.store[RESOURCE_ENERGY] > 0)
    });
    if (!source) {
        // Withdraw from extensions only (not spawns)
        source = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: s =>
                (s.structureType === STRUCTURE_EXTENSION &&
                 (
                    (s.store && s.store[RESOURCE_ENERGY] > 0) ||
                    (typeof s.energy === 'number' && s.energy > 0)
                 ))
        });
    }
    if (source) {
        let result = creep.withdraw(source, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
        }
        if (result === OK || result === ERR_NOT_IN_RANGE) {
            return true;
        }
    }
    let energySource = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
    if (energySource) {
        let result = creep.harvest(energySource);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(energySource, { visualizePathStyle: { stroke: '#ffaa00' } });
        }
        return true;
    }
    return false;
}

// == MAIN BUILDER LOGIC ==
const roleBuilder = {
    run: function(creep) {
        // Mining-until-full state logic
        if (creep.memory.filling && creep.store.getFreeCapacity() === 0) {
            creep.memory.filling = false;
        }
        if (!creep.memory.filling && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.filling = true;
        }

        if (creep.memory.filling) {
            // Only mine or withdraw until full, then resume job
            if (!acquireEnergy(creep)) {
                let idleSpot = findIdleSpotNearRoad(creep);
                if (idleSpot && !creep.pos.isEqualTo(idleSpot)) {
                    creep.moveTo(idleSpot, { visualizePathStyle: { stroke: '#888888' } });
                }
            }
            // Do not process jobs while filling
            // Logging still runs below
        } else {
            // Normal job logic
            if (!Memory._builderJobs || Memory._builderJobsTick !== Game.time || Memory._builderJobsRoom !== creep.room.name) {
                let jobs = buildJobQueue(creep.room);
                let assignments = getAssignments();
                for (let job of jobs) {
                    job.assigned = assignments[job.id] || [];
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

            // === WALL BUILDERS: Assign each builder to a different wall site ===
            function assignWallBuildJob() {
                // Find all build jobs for walls
                let wallBuildJobs = jobs.filter(j =>
                    j.type === 'build' &&
                    Game.getObjectById(j.id) &&
                    Game.getObjectById(j.id).structureType === STRUCTURE_WALL
                );
                // Find unassigned wall jobs
                let unassignedWallJobs = wallBuildJobs.filter(j => (assignments[j.id] || []).length === 0);
                if (unassignedWallJobs.length > 0) {
                    return unassignedWallJobs[0];
                }
                // If all wall sites are assigned, allow doubling up
                if (wallBuildJobs.length > 0) {
                    // Find wall with the fewest builders
                    return _.min(wallBuildJobs, j => (assignments[j.id] || []).length);
                }
                return null;
            }

            if (!task || !task.targetId || !(assignments[task.targetId] || []).includes(creep.name) || needsUnassign) {
                let myJob = null;
                // Prefer wall build jobs if available and not already assigned to this creep
                let wallBuildJob = assignWallBuildJob();
                if (wallBuildJob) {
                    myJob = wallBuildJob;
                } else {
                    // Otherwise, assign the first available job not already assigned to this creep
                    myJob = jobs.find(j => !(assignments[j.id] || []).includes(creep.name));
                }
                if (myJob) {
                    creep.memory.task = {
                        type: myJob.type,
                        targetId: myJob.id,
                        label: myJob.label
                    };
                    if (!assignments[myJob.id]) assignments[myJob.id] = [];
                    assignments[myJob.id].push(creep.name);
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
                        creep.memory.filling = true;
                        break;
                    }
                    if (creep.repair(target) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
                    }
                    break;

                case 'build':
                    if (!target || target.progress >= target.progressTotal) {
                        delete creep.memory.task;
                        break;
                    }
                    if (creep.store[RESOURCE_ENERGY] === 0) {
                        creep.memory.filling = true;
                        break;
                    }
                    if (creep.build(target) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
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
                                (s.structureType === STRUCTURE_EXTENSION ||
                                 s.structureType === STRUCTURE_CONTAINER ||
                                 s.structureType === STRUCTURE_STORAGE) &&
                                (
                                    (s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0) ||
                                    (typeof s.energyCapacity === 'number' && s.energy < s.energyCapacity)
                                )
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
        }

        // == LOGGING ==
        if (
            BUILDER_LOGGING &&
            Game.time % BUILDER_LOG_INTERVAL === 0 &&
            creep.name === _.first(_.sortBy(_.filter(Game.creeps, c => c.memory.role === 'builder' && c.room.name === creep.room.name), c => c.name)).name
        ) {
            // Always use latest jobs/assignments for logging
            if (!Memory._builderJobs || Memory._builderJobsTick !== Game.time || Memory._builderJobsRoom !== creep.room.name) {
                let jobs = buildJobQueue(creep.room);
                let assignments = getAssignments();
                for (let job of jobs) {
                    job.assigned = assignments[job.id] || [];
                }
                Memory._builderJobs = jobs;
                Memory._builderAssignments = assignments;
                Memory._builderJobsTick = Game.time;
                Memory._builderJobsRoom = creep.room.name;
            }
            logBuilderTasks(creep.room, Memory._builderJobs, Memory._builderAssignments);
        }
    }
};

module.exports = roleBuilder;
