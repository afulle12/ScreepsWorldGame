// Toggle logging for supplier task table here:
const SUPPLIER_LOGGING_ENABLED = false;
const SUPPLIER_CONTAINER_CATEGORY_LOGGING = false;

// --- CONFIGURABLE HYBRID CONTAINER RANGES ---
const HYBRID_MIN = 750;
const HYBRID_MAX = 1250;

module.exports = {
    run: function(creep) {
        // --- CONSTANTS ---
        const TASK_PRIORITIES = [
            { type: 'spawn', filter: s => s.structureType === STRUCTURE_SPAWN && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'extension', filter: s => s.structureType === STRUCTURE_EXTENSION && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'tower', filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && (s.store[RESOURCE_ENERGY] / s.store.getCapacity(RESOURCE_ENERGY)) < 0.75 },
            { type: 'link', filter: s => s.structureType === STRUCTURE_LINK && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'storage', filter: s => s.structureType === STRUCTURE_STORAGE && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 }
        ];

        function getTaskPriorityValue(taskType) {
            if (taskType === 'spawn') return 1;
            if (taskType === 'extension') return 2;
            if (taskType === 'tower') return 3;
            if (taskType === 'link') return 3.5;
            if (taskType === 'container_balance') return 3.6;
            if (taskType === 'container_empty') return 4;
            if (taskType === 'storage') return 5;
            if (taskType === 'container_drain') return 6;
            return 7;
        }

        // --- CONTAINER LABELING ---
        if (!Memory.containerLabels) Memory.containerLabels = {};
        if (!Memory.containerLabels[creep.room.name] || Memory.containerLabels[creep.room.name].tick !== Game.time) {
            const containers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
            const sources = creep.room.find(FIND_SOURCES);
            const spawns = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
            const controller = creep.room.controller;

            let labels = {};
            let donors = [], hybrids = [], recipients = [];
            for (let c of containers) {
                let isDonor = sources.some(src => src.pos.getRangeTo(c.pos) <= 4);
                let isRecipient = false;
                if (controller && controller.pos.getRangeTo(c.pos) <= 5) isRecipient = true;
                if (spawns.some(spawn => spawn.pos.getRangeTo(c.pos) <= 5)) isRecipient = true;

                let label;
                if (isDonor && !isRecipient) label = 'donor';
                else if (!isDonor && isRecipient) label = 'recipient';
                else label = 'hybrid'; // (neither or both)

                labels[c.id] = label;
                if (label === 'donor') donors.push(c);
                else if (label === 'hybrid') hybrids.push(c);
                else if (label === 'recipient') recipients.push(c);
            }
            Memory.containerLabels[creep.room.name] = { tick: Game.time, labels: labels };

            if (SUPPLIER_CONTAINER_CATEGORY_LOGGING) {
                let log = `\n🏷️ Container Categories for room ${creep.room.name} (Tick ${Game.time}):\n`;
                log += `Donors: ${donors.length ? donors.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
                log += `Hybrids: ${hybrids.length ? hybrids.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
                log += `Recipients: ${recipients.length ? recipients.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
                console.log(log);
            }
        }
        const containerLabels = Memory.containerLabels[creep.room.name].labels;

        const allRoomSuppliers = _.filter(Game.creeps, c => c.memory.role === 'supplier' && c.room.name === creep.room.name);
        let assignedCounts = {};
        for (let sCreep of allRoomSuppliers) {
            if (sCreep.memory.assignment && sCreep.memory.assignment.taskId) {
                let tId = sCreep.memory.assignment.taskId;
                assignedCounts[tId] = (assignedCounts[tId] || 0) + 1;
            }
        }

        // --- TASK DISCOVERY ---
        if (!Memory.supplierTasks) Memory.supplierTasks = {};
        if (!Memory.supplierTasks[creep.room.name] || Memory.supplierTasks[creep.room.name].tick !== Game.time) {
            let tasks = [];

            for (let p = 0; p < TASK_PRIORITIES.length; p++) {
                if (TASK_PRIORITIES[p].type === 'link') continue;
                let structs = creep.room.find(FIND_STRUCTURES, { filter: TASK_PRIORITIES[p].filter });
                for (let s of structs) {
                    let need = s.store.getFreeCapacity(RESOURCE_ENERGY);
                    if (need > 0) {
                        let maxAssign = 1;
                        tasks.push({
                            id: s.id, type: TASK_PRIORITIES[p].type, pos: s.pos, need: need, assigned: 0, maxAssign: maxAssign
                        });
                    }
                }
                if (TASK_PRIORITIES[p].type === 'tower' && tasks.length > 0) {
                    break;
                }
            }
            const links = creep.room.find(FIND_STRUCTURES, {
                filter: s =>
                    s.structureType === STRUCTURE_LINK &&
                    s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
                    (
                        (creep.room.storage && s.pos.getRangeTo(creep.room.storage.pos) <= 2) ||
                        creep.room.find(FIND_MY_STRUCTURES, { filter: sp => sp.structureType === STRUCTURE_SPAWN && s.pos.getRangeTo(sp.pos) <= 2 }).length > 0
                    )
            });
            for (let link of links) {
                tasks.push({
                    id: link.id, type: 'link', pos: link.pos, need: link.store.getFreeCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1
                });
            }
            const containers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
            let donors = [], hybrids = [], recipients = [];
            for (let c of containers) {
                if (containerLabels[c.id] === 'donor') donors.push(c);
                else if (containerLabels[c.id] === 'hybrid') hybrids.push(c);
                else if (containerLabels[c.id] === 'recipient') recipients.push(c);
            }
            // 1. Donor containers: should be empty
            for (let donor of donors) {
                let donorEnergy = donor.store.getUsedCapacity(RESOURCE_ENERGY);
                if (donorEnergy > 0) {
                    let targets = [];
                    for (let hybrid of hybrids) {
                        let hybridEnergy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                        if (hybridEnergy < HYBRID_MIN) {
                            targets.push({
                                id: hybrid.id, type: 'hybrid', obj: hybrid, need: Math.min(HYBRID_MIN - hybridEnergy, donorEnergy, hybrid.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    for (let recipient of recipients) {
                        let recipientEnergy = recipient.store.getUsedCapacity(RESOURCE_ENERGY);
                        let recipientCapacity = recipient.store.getCapacity(RESOURCE_ENERGY);
                        if (recipientEnergy < recipientCapacity) {
                            targets.push({
                                id: recipient.id, type: 'recipient', obj: recipient, need: Math.min(recipientCapacity - recipientEnergy, donorEnergy, recipient.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    if (targets.length === 0 && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        targets.push({
                            id: creep.room.storage.id, type: 'storage', obj: creep.room.storage, need: Math.min(donorEnergy, creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY))
                        });
                    }
                    if (targets.length === 0 && !creep.room.storage) {
                        const towers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                        if (towers.length > 0) {
                            let closestTower = donor.pos.findClosestByRange(towers);
                            targets.push({
                                id: closestTower.id, type: 'container_drain', obj: closestTower, need: Math.min(donorEnergy, closestTower.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    for (let target of targets) {
                        tasks.push({
                            id: donor.id,
                            type: target.type === 'container_drain' ? 'container_drain' : 'container_balance',
                            pos: donor.pos,
                            need: target.need,
                            assigned: 0,
                            maxAssign: 5, // MODIFIED: Allow multiple suppliers to be assigned to a single donor container
                            transferTargetId: target.id,
                            transferTargetPos: target.obj.pos
                        });
                    }
                }
            }
            for (let hybrid of hybrids) {
                let hybridEnergy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                if (hybridEnergy > HYBRID_MAX) {
                    let excess = hybridEnergy - HYBRID_MAX;
                    let targets = [];
                    for (let recipient of recipients) {
                        let recipientEnergy = recipient.store.getUsedCapacity(RESOURCE_ENERGY);
                        let recipientCapacity = recipient.store.getCapacity(RESOURCE_ENERGY);
                        if (recipientEnergy < recipientCapacity) {
                            targets.push({
                                id: recipient.id, type: 'recipient', obj: recipient, need: Math.min(recipientCapacity - recipientEnergy, excess, recipient.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    for (let otherHybrid of hybrids) {
                        if (otherHybrid.id === hybrid.id) continue;
                        let otherHybridEnergy = otherHybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                        if (otherHybridEnergy < HYBRID_MIN) {
                            targets.push({
                                id: otherHybrid.id, type: 'hybrid', obj: otherHybrid, need: Math.min(HYBRID_MIN - otherHybridEnergy, excess, otherHybrid.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    if (targets.length === 0 && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        targets.push({
                            id: creep.room.storage.id, type: 'storage', obj: creep.room.storage, need: Math.min(excess, creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY))
                        });
                    }
                    if (targets.length === 0 && !creep.room.storage) {
                        const towers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                        if (towers.length > 0) {
                            let closestTower = hybrid.pos.findClosestByRange(towers);
                            targets.push({
                                id: closestTower.id, type: 'container_drain', obj: closestTower, need: Math.min(excess, closestTower.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    for (let target of targets) {
                        tasks.push({
                            id: hybrid.id, type: target.type === 'container_drain' ? 'container_drain' : 'container_balance', pos: hybrid.pos, need: target.need, assigned: 0, maxAssign: 1, transferTargetId: target.id, transferTargetPos: target.obj.pos
                        });
                    }
                }
                else if (hybridEnergy < HYBRID_MIN && creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    let amount = Math.min(HYBRID_MIN - hybridEnergy, hybrid.store.getFreeCapacity(RESOURCE_ENERGY), creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY));
                    if (amount > 0) {
                        tasks.push({
                            id: creep.room.storage.id, type: 'container_balance', pos: creep.room.storage.pos, need: amount, assigned: 0, maxAssign: 1, transferTargetId: hybrid.id, transferTargetPos: hybrid.pos
                        });
                    }
                }
            }
            let donorOrHybridHasEnergy = donors.some(d => d.store.getUsedCapacity(RESOURCE_ENERGY) > 0) || hybrids.some(h => h.store.getUsedCapacity(RESOURCE_ENERGY) > HYBRID_MIN);
            for (let recipient of recipients) {
                let recipientEnergy = recipient.store.getUsedCapacity(RESOURCE_ENERGY);
                let recipientCapacity = recipient.store.getCapacity(RESOURCE_ENERGY);
                if (recipientEnergy < recipientCapacity) {
                    let sources = [];
                    if (!donorOrHybridHasEnergy) {
                        if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                            sources.push({
                                id: creep.room.storage.id, type: 'storage', obj: creep.room.storage, available: creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY)
                            });
                        }
                        for (let hybrid of hybrids) {
                            let hybridEnergy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                            if (hybridEnergy > HYBRID_MIN) {
                                sources.push({
                                    id: hybrid.id, type: 'hybrid', obj: hybrid, available: hybridEnergy - HYBRID_MIN
                                });
                            }
                        }
                    }
                    for (let source of sources) {
                        let amount = Math.min(recipientCapacity - recipientEnergy, source.available, recipient.store.getFreeCapacity(RESOURCE_ENERGY));
                        if (amount > 0) {
                            tasks.push({
                                id: source.id, type: 'container_balance', pos: source.obj.pos, need: amount, assigned: 0, maxAssign: 1, transferTargetId: recipient.id, transferTargetPos: recipient.pos
                            });
                        }
                    }
                }
            }
            for (let c of containers) {
                if (containerLabels[c.id] && (containerLabels[c.id] === 'donor' || containerLabels[c.id] === 'hybrid' || containerLabels[c.id] === 'recipient')) continue;
                let amount = c.store.getUsedCapacity(RESOURCE_ENERGY);
                if (amount > 0 && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    tasks.push({
                        id: c.id, type: 'container_empty', pos: c.pos, need: amount, assigned: 0, maxAssign: 1, targetId: creep.room.storage.id
                    });
                }
            }

            tasks = _.sortBy(tasks, t => getTaskPriorityValue(t.type));
            Memory.supplierTasks[creep.room.name] = { tick: Game.time, tasks: tasks };
        }
        const tasks = Memory.supplierTasks[creep.room.name].tasks;

        // --- REFACTORED LOGIC FLOW ---

        // 1. VALIDATE CURRENT ASSIGNMENT
        if (creep.memory.assignment) {
            let assignment = creep.memory.assignment;
            let taskStillExists = tasks.some(t => t.id === assignment.taskId && t.type === assignment.type);
            let primaryObject = Game.getObjectById(assignment.taskId);
            let targetObject = assignment.transferTargetId ? Game.getObjectById(assignment.transferTargetId) : primaryObject;

            if (!taskStillExists || !primaryObject || !targetObject || (targetObject.store && targetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0)) {
                creep.memory.assignment = null; // Invalidate task
            }
        }

        // 2. FIND NEW ASSIGNMENT IF NEEDED
        if (!creep.memory.assignment) {
            let potentialTasks = [];
            let currentHighestPriorityValue = Infinity;

            for (let task of tasks) {
                let currentAssignedToTask = assignedCounts[task.id] || 0;
                if (currentAssignedToTask >= task.maxAssign) continue;

                let taskPriorityValue = getTaskPriorityValue(task.type);
                if (taskPriorityValue < currentHighestPriorityValue) {
                    currentHighestPriorityValue = taskPriorityValue;
                    potentialTasks = [task];
                } else if (taskPriorityValue === currentHighestPriorityValue) {
                    potentialTasks.push(task);
                }
            }

            if (potentialTasks.length > 0) {
                let bestTask = creep.pos.findClosestByRange(potentialTasks.map(t => ({...t, pos: new RoomPosition(t.pos.x, t.pos.y, t.pos.roomName)})));
                if (bestTask) {
                    creep.memory.assignment = {
                        taskId: bestTask.id,
                        type: bestTask.type,
                        transferTargetId: bestTask.transferTargetId,
                    };
                    // Determine initial state based on carry capacity
                    const isWithdrawTask = bestTask.type.startsWith('container');
                    if (isWithdrawTask || creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                        creep.memory.state = 'fetching';
                    } else {
                        creep.memory.state = 'delivering';
                    }
                }
            }
        }

        // 3. EXECUTE ACTION BASED ON STATE
        if (creep.memory.assignment) {
            // State transition logic
            if (creep.memory.state === 'fetching' && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                creep.memory.state = 'delivering';
            }
            if (creep.memory.state === 'delivering' && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                // Finished delivering, clear assignment to get a new one next tick
                creep.memory.assignment = null;
                // We return here to allow re-assignment logic to run fresh on the next tick
                return;
            }

            // Action logic
            if (creep.memory.state === 'fetching') {
                creep.say('🔄 fetch');
                let assignment = creep.memory.assignment;
                let sourceObject;

                // For balance/empty tasks, the source is the primary task object
                if (assignment.type === 'container_balance' || assignment.type === 'container_empty' || assignment.type === 'container_drain') {
                    sourceObject = Game.getObjectById(assignment.taskId);
                } else { // For fill tasks, find the most convenient source
                    sourceObject = creep.pos.findClosestByRange(FIND_STRUCTURES, {
                        filter: s => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                    });
                }

                if (sourceObject) {
                    if (creep.withdraw(sourceObject, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(sourceObject, { visualizePathStyle: { stroke: '#ffaa00' } });
                    }
                }
                // If no sourceObject, the creep will wait, which is acceptable.
            }
            else if (creep.memory.state === 'delivering') {
                creep.say('🚚 deliver');
                let assignment = creep.memory.assignment;
                let deliverTargetObject;

                if (assignment.transferTargetId) {
                    deliverTargetObject = Game.getObjectById(assignment.transferTargetId);
                } else {
                    deliverTargetObject = Game.getObjectById(assignment.taskId);
                }

                if (deliverTargetObject) {
                    const transferResult = creep.transfer(deliverTargetObject, RESOURCE_ENERGY);
                    if (transferResult === ERR_NOT_IN_RANGE) {
                        creep.moveTo(deliverTargetObject, { visualizePathStyle: { stroke: '#ffffff' } });
                    } else if (transferResult === OK || transferResult === ERR_FULL) {
                        // If target becomes full, clear assignment to find a new task
                        creep.memory.assignment = null;
                    }
                } else {
                    // Target is gone, invalidate assignment
                    creep.memory.assignment = null;
                }
            }
        } else {
            // 4. TRUE IDLE BEHAVIOR (RALLY)
            creep.say('💤 idle');
            let rallyPoint = creep.room.storage;
            if (!rallyPoint) {
                const spawns = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
                if (spawns.length > 0) {
                    rallyPoint = spawns[0];
                }
            }

            if (rallyPoint && !creep.pos.inRangeTo(rallyPoint, 3)) {
                creep.moveTo(rallyPoint, { visualizePathStyle: { stroke: '#888888', opacity: 0.5, lineStyle: 'dashed' }, range: 3 });
            }
        }

        // --- LOGGING ---
        if (SUPPLIER_LOGGING_ENABLED && allRoomSuppliers[0] === creep && Game.time % 5 === 0) {
            let assignmentMap = {};
            allRoomSuppliers.forEach(s => {
                if (s.memory.assignment && s.memory.assignment.taskId) {
                    let assign = s.memory.assignment;
                    let taskId = assign.taskId;
                    if (!assignmentMap[taskId]) assignmentMap[taskId] = [];
                    let shortName = s.name.slice(-4);
                    assignmentMap[taskId].push(shortName);
                }
            });

            let rows = [];
            tasks.forEach((task) => {
                let assignedSuppliers = assignmentMap[task.id] || [];
                let shortId = task.id.slice(-6);
                let supplierNames = assignedSuppliers.length > 0 ? assignedSuppliers.join(',') : 'none';
                let sourceInfo = 'auto'; let destInfo = '---';

                if (task.type === 'container_balance') {
                    sourceInfo = 'src:' + task.id.slice(-4);
                    destInfo = 'dst:' + (task.transferTargetId ? task.transferTargetId.slice(-4) : 'ERR');
                } else if (task.sourceId) {
                    let srcObj = Game.getObjectById(task.sourceId);
                    if (srcObj) sourceInfo = (srcObj.structureType === STRUCTURE_STORAGE ? 'stor' : 'cont:' + task.sourceId.slice(-4)); else sourceInfo = 'ERR';
                    destInfo = task.id.slice(-4);
                } else if (task.type === 'container_empty' || task.type === 'container_drain') {
                    sourceInfo = 'cont:' + task.id.slice(-4);
                    if (task.targetId) {
                        let tgtObj = Game.getObjectById(task.targetId);
                        if (tgtObj) destInfo = (tgtObj.structureType === STRUCTURE_STORAGE ? 'stor' : (tgtObj.structureType === STRUCTURE_TOWER ? 'towr:' : 'cont:') + task.targetId.slice(-4)); else destInfo = 'ERR';
                    }
                } else { destInfo = task.id.slice(-4); }

                rows.push({
                    type: task.type, id: shortId, pos: `${task.pos.x},${task.pos.y}`, need: task.need.toString(),
                    assigned: `${assignedSuppliers.length}/${task.maxAssign}`, suppliers: supplierNames,
                    source: sourceInfo, destination: destInfo
                });
            });
            let idleSuppliers = allRoomSuppliers.filter(s => !s.memory.assignment).map(s => s.name.slice(-4));
            if (idleSuppliers.length > 0) {
                rows.push({ type: 'IDLE', id: '------', pos: '---', need: '---', assigned: `${idleSuppliers.length}/∞`, suppliers: idleSuppliers.join(','), source: 'none', destination: '---' });
            }

            if (rows.length > 0) {
                console.log(`\n🚚 SUPPLIER TASKS - ${creep.room.name} (Tick ${Game.time})`);
                console.log('┌──────────────────────┬────────┬──────┬──────┬─────────┬─────────────────────┬───────────┬─────────────┐');
                console.log('│      Type            │   ID   │ Pos  │ Need │ Assign  │      Suppliers      │  Source   │ Destination │');
                console.log('├──────────────────────┼────────┼──────┼──────┼─────────┼─────────────────────┼───────────┼─────────────┤');
                rows.forEach(row => {
                    let type = row.type.padEnd(20); let id = row.id.padEnd(6); let pos = row.pos.padEnd(4);
                    let need = row.need.padEnd(4); let assigned = row.assigned.padEnd(7);
                    let suppliers = row.suppliers.length > 19 ? row.suppliers.substring(0, 16) + '...' : row.suppliers.padEnd(19);
                    let source = row.source.padEnd(9); let destination = row.destination.padEnd(11);
                    console.log(`│ ${type} │ ${id} │ ${pos} │ ${need} │ ${assigned} │ ${suppliers} │ ${source} │ ${destination} │`);
                });
                console.log('└──────────────────────┴────────┴──────┴──────┴─────────┴─────────────────────┴───────────┴─────────────┘');
            } else { console.log(`🚚 ${creep.room.name}: No supplier tasks available`); }
        }
    }
};
