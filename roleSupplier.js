// Toggle logging for supplier task table here:
const SUPPLIER_LOGGING_ENABLED = false;
// Toggle logging for container categories here:
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

            // --- LOGGING CONTAINER CATEGORIES ---
            if (SUPPLIER_CONTAINER_CATEGORY_LOGGING) {
                let log = `\n🏷️ Container Categories for room ${creep.room.name} (Tick ${Game.time}):\n`;
                log += `Donors: ${donors.length ? donors.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
                log += `Hybrids: ${hybrids.length ? hybrids.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
                log += `Recipients: ${recipients.length ? recipients.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
                console.log(log);
            }
        }
        const containerLabels = Memory.containerLabels[creep.room.name].labels;

        // Get all suppliers in the current room and calculate current task assignments
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

            // Standard structure priorities (except link, which is handled below)
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

            // --- LINK FILLING LOGIC ---
            // Only fill links that are near storage or spawn (within 2 squares)
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
                    id: link.id,
                    type: 'link',
                    pos: link.pos,
                    need: link.store.getFreeCapacity(RESOURCE_ENERGY),
                    assigned: 0,
                    maxAssign: 1
                });
            }

            // --- CONTAINER BALANCING LOGIC ---
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
                    // Try to move energy to hybrids (if below HYBRID_MIN) or recipients (if not full), else to storage
                    let targets = [];
                    // Hybrids needing energy
                    for (let hybrid of hybrids) {
                        let hybridEnergy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                        if (hybridEnergy < HYBRID_MIN) {
                            targets.push({
                                id: hybrid.id,
                                type: 'hybrid',
                                obj: hybrid,
                                need: Math.min(HYBRID_MIN - hybridEnergy, donorEnergy, hybrid.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    // Recipients needing energy
                    for (let recipient of recipients) {
                        let recipientEnergy = recipient.store.getUsedCapacity(RESOURCE_ENERGY);
                        let recipientCapacity = recipient.store.getCapacity(RESOURCE_ENERGY);
                        if (recipientEnergy < recipientCapacity) {
                            targets.push({
                                id: recipient.id,
                                type: 'recipient',
                                obj: recipient,
                                need: Math.min(recipientCapacity - recipientEnergy, donorEnergy, recipient.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    // If no hybrid/recipient needs energy, send to storage
                    if (targets.length === 0 && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        targets.push({
                            id: creep.room.storage.id,
                            type: 'storage',
                            obj: creep.room.storage,
                            need: Math.min(donorEnergy, creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY))
                        });
                    }
                    // If no storage, use container_drain (to tower)
                    if (targets.length === 0 && !creep.room.storage) {
                        const towers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                        if (towers.length > 0) {
                            let closestTower = donor.pos.findClosestByRange(towers);
                            targets.push({
                                id: closestTower.id,
                                type: 'container_drain',
                                obj: closestTower,
                                need: Math.min(donorEnergy, closestTower.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    // Create tasks for each target
                    for (let target of targets) {
                        tasks.push({
                            id: donor.id,
                            type: target.type === 'container_drain' ? 'container_drain' : 'container_balance',
                            pos: donor.pos,
                            need: target.need,
                            assigned: 0,
                            maxAssign: 1,
                            transferTargetId: target.id,
                            transferTargetPos: target.obj.pos
                        });
                    }
                }
            }

            // 2. Hybrid containers: keep between HYBRID_MIN and HYBRID_MAX
            for (let hybrid of hybrids) {
                let hybridEnergy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                // If too much energy, move to storage or recipient/hybrid containers needing energy
                if (hybridEnergy > HYBRID_MAX) {
                    let excess = hybridEnergy - HYBRID_MAX;
                    let targets = [];
                    // Recipients needing energy
                    for (let recipient of recipients) {
                        let recipientEnergy = recipient.store.getUsedCapacity(RESOURCE_ENERGY);
                        let recipientCapacity = recipient.store.getCapacity(RESOURCE_ENERGY);
                        if (recipientEnergy < recipientCapacity) {
                            targets.push({
                                id: recipient.id,
                                type: 'recipient',
                                obj: recipient,
                                need: Math.min(recipientCapacity - recipientEnergy, excess, recipient.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    // Hybrids below HYBRID_MIN
                    for (let otherHybrid of hybrids) {
                        if (otherHybrid.id === hybrid.id) continue;
                        let otherHybridEnergy = otherHybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                        if (otherHybridEnergy < HYBRID_MIN) {
                            targets.push({
                                id: otherHybrid.id,
                                type: 'hybrid',
                                obj: otherHybrid,
                                need: Math.min(HYBRID_MIN - otherHybridEnergy, excess, otherHybrid.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    // If no hybrid/recipient needs energy, send to storage
                    if (targets.length === 0 && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        targets.push({
                            id: creep.room.storage.id,
                            type: 'storage',
                            obj: creep.room.storage,
                            need: Math.min(excess, creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY))
                        });
                    }
                    // If no storage, use container_drain (to tower)
                    if (targets.length === 0 && !creep.room.storage) {
                        const towers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                        if (towers.length > 0) {
                            let closestTower = hybrid.pos.findClosestByRange(towers);
                            targets.push({
                                id: closestTower.id,
                                type: 'container_drain',
                                obj: closestTower,
                                need: Math.min(excess, closestTower.store.getFreeCapacity(RESOURCE_ENERGY))
                            });
                        }
                    }
                    for (let target of targets) {
                        tasks.push({
                            id: hybrid.id,
                            type: target.type === 'container_drain' ? 'container_drain' : 'container_balance',
                            pos: hybrid.pos,
                            need: target.need,
                            assigned: 0,
                            maxAssign: 1,
                            transferTargetId: target.id,
                            transferTargetPos: target.obj.pos
                        });
                    }
                }
                // If too little energy, pull from storage (if available)
                else if (hybridEnergy < HYBRID_MIN && creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    let amount = Math.min(HYBRID_MIN - hybridEnergy, hybrid.store.getFreeCapacity(RESOURCE_ENERGY), creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY));
                    if (amount > 0) {
                        tasks.push({
                            id: creep.room.storage.id,
                            type: 'container_balance',
                            pos: creep.room.storage.pos,
                            need: amount,
                            assigned: 0,
                            maxAssign: 1,
                            transferTargetId: hybrid.id,
                            transferTargetPos: hybrid.pos
                        });
                    }
                }
            }

            // 3. Recipient containers: keep full
            for (let recipient of recipients) {
                let recipientEnergy = recipient.store.getUsedCapacity(RESOURCE_ENERGY);
                let recipientCapacity = recipient.store.getCapacity(RESOURCE_ENERGY);
                if (recipientEnergy < recipientCapacity) {
                    // Pull from storage or hybrids (if above HYBRID_MIN)
                    let sources = [];
                    if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                        sources.push({
                            id: creep.room.storage.id,
                            type: 'storage',
                            obj: creep.room.storage,
                            available: creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY)
                        });
                    }
                    for (let hybrid of hybrids) {
                        let hybridEnergy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
                        if (hybridEnergy > HYBRID_MIN) {
                            sources.push({
                                id: hybrid.id,
                                type: 'hybrid',
                                obj: hybrid,
                                available: hybridEnergy - HYBRID_MIN
                            });
                        }
                    }
                    for (let source of sources) {
                        let amount = Math.min(recipientCapacity - recipientEnergy, source.available, recipient.store.getFreeCapacity(RESOURCE_ENERGY));
                        if (amount > 0) {
                            tasks.push({
                                id: source.id,
                                type: 'container_balance',
                                pos: source.obj.pos,
                                need: amount,
                                assigned: 0,
                                maxAssign: 1,
                                transferTargetId: recipient.id,
                                transferTargetPos: recipient.pos
                            });
                        }
                    }
                }
            }

            // 4. Container emptying to storage (if above 0 and not a donor, hybrid, or recipient task)
            for (let c of containers) {
                if (containerLabels[c.id] && (containerLabels[c.id] === 'donor' || containerLabels[c.id] === 'hybrid' || containerLabels[c.id] === 'recipient')) continue;
                let amount = c.store.getUsedCapacity(RESOURCE_ENERGY);
                if (amount > 0 && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    tasks.push({
                        id: c.id,
                        type: 'container_empty',
                        pos: c.pos,
                        need: amount,
                        assigned: 0,
                        maxAssign: 1,
                        targetId: creep.room.storage.id
                    });
                }
            }

            tasks = _.sortBy(tasks, t => getTaskPriorityValue(t.type));
            Memory.supplierTasks[creep.room.name] = { tick: Game.time, tasks: tasks };
        }

        // --- SUPPLIER ASSIGNMENT ---
        let tasks = Memory.supplierTasks[creep.room.name].tasks;

        // --- MODIFIED: On assignment, check if we have enough energy to deliver ---
        if (!creep.memory.assignment || !creep.memory.assignment.taskId) {
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
                } else if (taskPriorityValue > currentHighestPriorityValue) {
                    break;
                }
            }

            if (potentialTasks.length > 0) {
                let bestTask = _.min(potentialTasks, t => creep.pos.getRangeTo(t.pos));
                if (bestTask) {
                    // If this is a delivery-type task, check if we have enough energy to deliver
                    let needsEnergy = false;
                    let required = bestTask.need || 0;
                    // For container_balance, container_empty, container_drain, storage, etc.
                    if (
                        bestTask.type === 'container_balance' ||
                        bestTask.type === 'container_empty' ||
                        bestTask.type === 'container_drain' ||
                        bestTask.type === 'storage' ||
                        bestTask.type === 'spawn' ||
                        bestTask.type === 'extension' ||
                        bestTask.type === 'tower' ||
                        bestTask.type === 'link'
                    ) {
                        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) < required) {
                            needsEnergy = true;
                        }
                    }
                    // Assign the task
                    creep.memory.assignment = {
                        taskId: bestTask.id,
                        type: bestTask.type,
                        sourceId: bestTask.sourceId,
                        targetId: bestTask.targetId,
                        transferTargetId: bestTask.transferTargetId,
                        needsEnergy: needsEnergy,
                        required: required
                    };
                    // If needs energy, force fetching state
                    creep.memory.state = needsEnergy ? 'fetching' : 'delivering';
                    // Reset idle ticks if coming from idle
                    creep.memory.idleTicks = 0;
                    return;
                } else {
                    creep.memory.assignment = null;
                }
            } else {
                creep.memory.assignment = null;
            }
        } else { // Validate existing assignment
            let assignment = creep.memory.assignment;
            let taskStillExistsInList = tasks.find(t => t.id === assignment.taskId && t.type === assignment.type);
            let primaryObject = Game.getObjectById(assignment.taskId);
            let deliveryObject, sourceObject;

            if (assignment.type === 'container_balance') {
                deliveryObject = Game.getObjectById(assignment.transferTargetId);
                sourceObject = primaryObject;
                if (!taskStillExistsInList || !sourceObject || !deliveryObject) {
                    creep.memory.assignment = null;
                } else if (sourceObject.store && sourceObject.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    creep.memory.assignment = null;
                } else if (deliveryObject.store && deliveryObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                    creep.memory.assignment = null;
                }
            } else if (assignment.type === 'container_empty' || assignment.type === 'container_drain') {
                deliveryObject = Game.getObjectById(assignment.targetId || assignment.transferTargetId);
                sourceObject = primaryObject;
                if (!taskStillExistsInList || !sourceObject || !deliveryObject) {
                    creep.memory.assignment = null;
                } else if (sourceObject.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    creep.memory.assignment = null;
                } else if (deliveryObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                    creep.memory.assignment = null;
                }
            } else {
                deliveryObject = primaryObject;
                if (!taskStillExistsInList || !deliveryObject || (deliveryObject.store && deliveryObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0)) {
                    creep.memory.assignment = null;
                }
            }
        }

        // --- SAY TASK STATUS (ADDED) ---
        {
            let sayText = '';
            let assignment = creep.memory.assignment;
            if (!assignment || !assignment.taskId) {
                sayText = 'idle';
            } else {
                let shortId = assignment.taskId ? assignment.taskId.slice(-4) : '';
                let state = creep.memory.state || '';
                let taskType = assignment.type || '';
                // Compose a short status string
                if (state === 'fetching') {
                    sayText = '🔄 ' + (taskType[0] ? taskType[0].toUpperCase() : '') + taskType.slice(1, 3) + ' ' + shortId;
                } else if (state === 'delivering') {
                    sayText = '🚚 ' + (taskType[0] ? taskType[0].toUpperCase() : '') + taskType.slice(1, 3) + ' ' + shortId;
                } else if (state === 'idle') {
                    sayText = 'idle';
                } else {
                    sayText = state;
                }
            }
            creep.say(sayText, true);
        }

        // DISPLAY SUPPLIER TASK TABLE
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

        // --- STATE MACHINE ---
        // Add idle state if not present
        if (!creep.memory.state) creep.memory.state = 'fetching';
        let assignment = creep.memory.assignment; // Re-fetch from memory after potential validation changes

        // --- IDLE STATE ---
        if ((!assignment || !assignment.taskId) && (!creep.memory.state || creep.memory.state === 'idle')) {
            // If just entered idle, initialize counter
            if (creep.memory.state !== 'idle') {
                creep.memory.state = 'idle';
                creep.memory.idleTicks = 1;
            } else {
                creep.memory.idleTicks = (creep.memory.idleTicks || 0) + 1;
            }

            // If a new assignment appeared, break idle immediately
            if (assignment && assignment.taskId) {
                creep.memory.state = 'fetching';
                creep.memory.idleTicks = 0;
                // Continue to fetching/delivering logic below
            } else if (creep.memory.idleTicks < 3) {
                // Stay stationary for idle ticks
                return;
            } else {
                // After 3 ticks, reset idleTicks and check for new assignment next tick
                creep.memory.idleTicks = 0;
                // Remain idle if no assignment, or will be assigned next tick
                return;
            }
        }

        // --- FETCHING ---
        if (creep.memory.state === 'fetching') {
            // If we have an assignment and it requires energy, and we have enough, go to delivering
            if (
                assignment &&
                assignment.needsEnergy &&
                creep.store.getUsedCapacity(RESOURCE_ENERGY) >= (assignment.required || 0)
            ) {
                creep.memory.state = 'delivering';
            }
            // If full or have enough for assignment, deliver
            else if (
                creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 ||
                (assignment && assignment.required && creep.store.getUsedCapacity(RESOURCE_ENERGY) >= assignment.required)
            ) {
                creep.memory.state = 'delivering';
            } else {
                let sourceToWithdraw = null;
                if (assignment) {
                    if (assignment.type === 'container_balance' || assignment.type === 'container_empty' || assignment.type === 'container_drain') {
                        sourceToWithdraw = Game.getObjectById(assignment.taskId);
                    }
                    // For link, fetch from storage or container, NOT the link itself
                    else if (assignment.type === 'link') {
                        if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                            sourceToWithdraw = creep.room.storage;
                        } else {
                            let containers = creep.room.find(FIND_STRUCTURES, {
                                filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                            });
                            if (containers.length > 0) {
                                sourceToWithdraw = creep.pos.findClosestByRange(containers);
                            }
                        }
                    }
                }

                if (sourceToWithdraw) {
                    if (!sourceToWithdraw || sourceToWithdraw.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                        creep.memory.assignment = null;
                        return;
                    }
                    if (creep.withdraw(sourceToWithdraw, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(sourceToWithdraw, { visualizePathStyle: { stroke: '#ffaa00' } });
                    }
                    return;
                }

                if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    let generalContainers = creep.room.find(FIND_STRUCTURES, {
                        filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
                                     (!tasks.some(t => t.type === 'container_balance' && t.id === s.id && (assignedCounts[t.id] || 0) > 0))
                    });

                    let supplierFetchTargets = {};
                    allRoomSuppliers.forEach(s => {
                        if (s.memory.assignment && s.id !== creep.id) {
                            let fetchSourceId = null;
                            if (s.memory.assignment.type === 'container_empty' || s.memory.assignment.type === 'container_drain') {
                                fetchSourceId = s.memory.assignment.taskId;
                            } else if (s.memory.assignment.type === 'container_balance') {
                                fetchSourceId = s.memory.assignment.taskId;
                            } else if (s.memory.state === 'fetching' && s.memory.targetId) {
                                let targetObj = Game.getObjectById(s.memory.targetId);
                                if (targetObj && targetObj.structureType === STRUCTURE_CONTAINER) {
                                   fetchSourceId = s.memory.targetId;
                                }
                            }
                            if (fetchSourceId) {
                                supplierFetchTargets[fetchSourceId] = (supplierFetchTargets[fetchSourceId] || 0) + 1;
                            }
                        }
                    });

                    generalContainers = generalContainers.filter(container => {
                        let energyAmount = container.store.getUsedCapacity(RESOURCE_ENERGY);
                        let currentTargeters = supplierFetchTargets[container.id] || 0;
                        if (energyAmount < 250 && currentTargeters >= 1) {
                            return false;
                        }
                        return true;
                    });

                    let generalStorage = (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) ? [creep.room.storage] : [];
                    let generalDropped = creep.room.find(FIND_DROPPED_RESOURCES, {
                        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > Math.min(50, creep.store.getFreeCapacity(RESOURCE_ENERGY))
                    });
                    let fetchOrder = [...generalDropped, ...generalContainers, ...generalStorage];
                    let fetchTarget = creep.pos.findClosestByRange(fetchOrder.filter(s => s));

                    if (fetchTarget) {
                        if (fetchTarget.amount) { if (creep.pickup(fetchTarget) === ERR_NOT_IN_RANGE) creep.moveTo(fetchTarget, { visualizePathStyle: { stroke: '#ffaa00' } }); }
                        else { if (creep.withdraw(fetchTarget, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(fetchTarget, { visualizePathStyle: { stroke: '#ffaa00' } }); }
                    } else {
                        const spawns = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
                        if (spawns.length > 0) creep.moveTo(spawns[0], { visualizePathStyle: { stroke: '#888888' }, range: 2 });
                        else if (creep.room.storage) creep.moveTo(creep.room.storage, { visualizePathStyle: { stroke: '#888888' }, range: 2 });
                    }
                } else {
                    creep.memory.state = 'delivering';
                }
                return;
            }
        }

        // --- DELIVERING ---
        if (creep.memory.state === 'delivering') {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                creep.memory.state = 'fetching';
                if (assignment && assignment.type !== 'container_balance') {
                    creep.memory.assignment = null;
                }
                return;
            }

            if (!assignment || !assignment.taskId) {
                if (creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    if (creep.transfer(creep.room.storage, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(creep.room.storage, { visualizePathStyle: { stroke: '#ffffff' } });
                } else {
                    let anyNonFull = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
                        filter: (s) => (s.structureType == STRUCTURE_EXTENSION || s.structureType == STRUCTURE_SPAWN || s.structureType == STRUCTURE_TOWER) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                    });
                    if (anyNonFull) { if (creep.transfer(anyNonFull, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(anyNonFull, { visualizePathStyle: { stroke: '#ffffff' } }); }
                    else { const spawns = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN }); if (spawns.length > 0) creep.moveTo(spawns[0], { visualizePathStyle: { stroke: '#888888' }, range: 2 });}
                }
                return;
            }

            let deliverTargetObject;
            if (assignment.type === 'container_balance') {
                deliverTargetObject = Game.getObjectById(assignment.transferTargetId);
            } else if (assignment.type === 'container_empty' || assignment.type === 'container_drain') {
                deliverTargetObject = Game.getObjectById(assignment.targetId || assignment.transferTargetId);
            } else {
                deliverTargetObject = Game.getObjectById(assignment.taskId);
            }

            if (assignment.type === 'container_drain' && deliverTargetObject && deliverTargetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                const availableTowers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                if (availableTowers.length > 0) {
                    let newTower = creep.pos.findClosestByRange(availableTowers);
                    creep.memory.assignment.targetId = newTower.id;
                    deliverTargetObject = newTower;
                } else { creep.memory.assignment = null; return; }
            }

            if (!deliverTargetObject || (deliverTargetObject.store && deliverTargetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0)) {
                creep.memory.assignment = null;
                return;
            }

            const transferResult = creep.transfer(deliverTargetObject, RESOURCE_ENERGY);
            if (transferResult === ERR_NOT_IN_RANGE) {
                creep.moveTo(deliverTargetObject, { visualizePathStyle: { stroke: (assignment.type === 'container_drain' ? '#ff9900' : '#ffffff') } });
            } else if (transferResult === OK) {
                if (deliverTargetObject.store && deliverTargetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                    creep.memory.assignment = null;
                }
            }
            return;
        }
    }
};
