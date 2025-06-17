module.exports = {
    run: function(creep) {
        // --- CONSTANTS ---
        const TASK_PRIORITIES = [
            { type: 'spawn', filter: s => s.structureType === STRUCTURE_SPAWN && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'extension', filter: s => s.structureType === STRUCTURE_EXTENSION && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'tower', filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && (s.store[RESOURCE_ENERGY] / s.store.getCapacity(RESOURCE_ENERGY)) < 0.75 },
            { type: 'storage', filter: s => s.structureType === STRUCTURE_STORAGE && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 }
        ];

        function getTaskPriorityValue(taskType) {
            if (taskType === 'spawn') return 1;
            if (taskType === 'extension') return 2;
            if (taskType === 'tower') return 3;
            if (taskType === 'link') return 3.5;
            if (taskType === 'container_transfer') return 3.6;
            if (taskType === 'container_fill' || taskType === 'container_empty') return 4;
            if (taskType === 'storage') return 5;
            if (taskType === 'container_drain') return 6;
            return 7;
        }

        const allRoomSuppliers = _.filter(Game.creeps, c => c.memory.role === 'supplier' && c.room.name === creep.room.name);
        let assignedCounts = {};
        for (let sCreep of allRoomSuppliers) {
            if (sCreep.memory.assignment && sCreep.memory.assignment.taskId) {
                let tId = sCreep.memory.assignment.taskId;
                assignedCounts[tId] = (assignedCounts[tId] || 0) + 1;
            }
        }

        if (!Memory.supplierTasks) Memory.supplierTasks = {};
        if (!Memory.supplierTasks[creep.room.name] || Memory.supplierTasks[creep.room.name].tick !== Game.time) {
            let tasks = [];
            // --- TASK DISCOVERY LOGIC (remains the same as your provided code) ---
            for (let p = 0; p < TASK_PRIORITIES.length; p++) {
                let structs = creep.room.find(FIND_STRUCTURES, { filter: TASK_PRIORITIES[p].filter });
                for (let s of structs) {
                    let need = s.store.getFreeCapacity(RESOURCE_ENERGY);
                    if (need > 0) {
                        tasks.push({ id: s.id, type: TASK_PRIORITIES[p].type, pos: s.pos, need: need, assigned: 0, maxAssign: 1 });
                    }
                }
                if (TASK_PRIORITIES[p].type === 'tower' && tasks.length > 0) break;
            }
            if (creep.room.storage && creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN }).length > 0) {
                const spawns = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
                const links = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LINK && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && (s.store[RESOURCE_ENERGY] / s.store.getCapacity(RESOURCE_ENERGY)) < 0.75 });
                if (links.length > 0) {
                    let closestLink = _.min(links, l => creep.room.storage.pos.getRangeTo(l));
                    if (closestLink.id !== _.max(links, l => spawns[0].pos.getRangeTo(l)).id && closestLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        tasks.push({ id: closestLink.id, type: 'link', pos: closestLink.pos, need: closestLink.store.getFreeCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1 });
                    }
                }
            }
            const allContainers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
            let potentialSourceContainers = [], potentialTargetContainers = [];
            if (allContainers.length > 0) {
                allContainers.forEach(c => {
                    let pF = c.store.getUsedCapacity(RESOURCE_ENERGY) / c.store.getCapacity(RESOURCE_ENERGY);
                    if (pF > 0.75 && c.store.getUsedCapacity(RESOURCE_ENERGY) > 0) potentialSourceContainers.push(c);
                    else if (pF < 0.5 && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) potentialTargetContainers.push(c);
                });
                const harvesters = _.filter(Game.creeps, c => c.memory.role === 'harvester' && c.room.name === creep.room.name);
                potentialTargetContainers = potentialTargetContainers.filter(cont => !harvesters.some(h => h.pos.getRangeTo(cont.pos) <= 3));
                let availableSourceContainers = [...potentialSourceContainers], availableTargetContainers = [...potentialTargetContainers];
                for (let sI = availableSourceContainers.length - 1; sI >= 0; sI--) {
                    if (availableTargetContainers.length === 0) break;
                    let sC = availableSourceContainers[sI], bestT = null, bestTI = -1, cD = Infinity;
                    for (let tI = 0; tI < availableTargetContainers.length; tI++) {
                        let dist = sC.pos.getRangeTo(availableTargetContainers[tI].pos);
                        if (dist < cD) { cD = dist; bestT = availableTargetContainers[tI]; bestTI = tI; }
                    }
                    if (bestT) {
                        tasks.push({ id: sC.id, type: 'container_transfer', pos: sC.pos, need: sC.store.getUsedCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1, transferTargetId: bestT.id, transferTargetPos: bestT.pos });
                        availableSourceContainers.splice(sI, 1); availableTargetContainers.splice(bestTI, 1);
                    }
                }
                if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    availableTargetContainers.forEach(t => tasks.push({ id: t.id, type: 'container_fill', pos: t.pos, need: t.store.getFreeCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1, sourceId: creep.room.storage.id }));
                }
                if (creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    availableSourceContainers.forEach(s => {
                        let amt = s.store.getUsedCapacity(RESOURCE_ENERGY);
                        tasks.push({ id: s.id, type: 'container_empty', pos: s.pos, need: amt, assigned: 0, maxAssign: (amt >= 250 ? Math.min(2, Math.ceil(amt / creep.store.getCapacity(RESOURCE_ENERGY))) : 1), targetId: creep.room.storage.id });
                    });
                }
            }
            if (!creep.room.storage && allContainers.length > 0) {
                let fC = _.max(allContainers, c => c.store.getUsedCapacity(RESOURCE_ENERGY));
                if (fC && fC.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    const availTowers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                    if (availTowers.length > 0) tasks.push({ id: fC.id, type: 'container_drain', pos: fC.pos, need: fC.store.getUsedCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1, targetId: fC.pos.findClosestByRange(availTowers).id });
                }
            }
            tasks = _.sortBy(tasks, t => getTaskPriorityValue(t.type));
            Memory.supplierTasks[creep.room.name] = { tick: Game.time, tasks: tasks };
        }

        let tasksInMemory = Memory.supplierTasks[creep.room.name].tasks;

        // --- SUPPLIER ASSIGNMENT & VALIDATION (remains largely the same) ---
        if (!creep.memory.assignment || !creep.memory.assignment.taskId) {
            let potentialTasks = [];
            let currentHighestPriorityValue = Infinity;
            for (let task of tasksInMemory) {
                let currentAssignedToTask = assignedCounts[task.id] || 0;
                if (currentAssignedToTask >= task.maxAssign) continue;
                let taskPriorityValue = getTaskPriorityValue(task.type);
                if (taskPriorityValue < currentHighestPriorityValue) {
                    currentHighestPriorityValue = taskPriorityValue; potentialTasks = [task];
                } else if (taskPriorityValue === currentHighestPriorityValue) {
                    potentialTasks.push(task);
                } else if (taskPriorityValue > currentHighestPriorityValue) break;
            }
            if (potentialTasks.length > 0) {
                let bestTask = _.min(potentialTasks, t => creep.pos.getRangeTo(t.pos));
                if (bestTask) creep.memory.assignment = { taskId: bestTask.id, type: bestTask.type, sourceId: bestTask.sourceId, targetId: bestTask.targetId, transferTargetId: bestTask.transferTargetId };
                else creep.memory.assignment = null;
            } else creep.memory.assignment = null;
        } else {
            let assignment = creep.memory.assignment;
            let taskStillExists = tasksInMemory.find(t => t.id === assignment.taskId && t.type === assignment.type);
            let pO = Game.getObjectById(assignment.taskId), dO, sO;
            if (assignment.type === 'container_transfer') {
                dO = Game.getObjectById(assignment.transferTargetId); sO = pO;
                if (!taskStillExists || !sO || !dO || (sO.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) || dO.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.assignment = null;
            } else if (assignment.type === 'container_empty' || assignment.type === 'container_drain') {
                dO = Game.getObjectById(assignment.targetId); sO = pO;
                if (!taskStillExists || !sO || !dO || (sO.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) || dO.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.assignment = null;
            } else if (assignment.type === 'container_fill') {
                dO = pO; sO = Game.getObjectById(assignment.sourceId);
                if (!taskStillExists || !dO || !sO || (sO.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) || dO.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.assignment = null;
            } else { // spawn, extension, tower, storage
                dO = pO;
                if (!taskStillExists || !dO || (dO.store && dO.store.getFreeCapacity(RESOURCE_ENERGY) === 0)) creep.memory.assignment = null;
            }
        }
        // --- END SUPPLIER ASSIGNMENT & VALIDATION ---

        // --- DISPLAY SUPPLIER TASK TABLE (remains the same) ---
        if (allRoomSuppliers[0] === creep && Game.time % 5 === 0) {
            // ... (table display logic as provided)
            let assignmentMap = {};
            allRoomSuppliers.forEach(s => { if (s.memory.assignment && s.memory.assignment.taskId) { let assign = s.memory.assignment; let taskId = assign.taskId; if (!assignmentMap[taskId]) assignmentMap[taskId] = []; assignmentMap[taskId].push(s.name.slice(-4)); }});
            let rows = [];
            tasksInMemory.forEach((task) => {
                let assignedSuppliers = assignmentMap[task.id] || []; let shortId = task.id.slice(-6); let supplierNames = assignedSuppliers.length > 0 ? assignedSuppliers.join(',') : 'none'; let sourceInfo = 'auto'; let destInfo = '---';
                if (task.type === 'container_transfer') { sourceInfo = 'ctS:' + task.id.slice(-4); destInfo = 'ctT:' + (task.transferTargetId ? task.transferTargetId.slice(-4) : 'ERR'); }
                else if (task.sourceId) { let srcObj = Game.getObjectById(task.sourceId); if (srcObj) sourceInfo = (srcObj.structureType === STRUCTURE_STORAGE ? 'stor' : 'cont:' + task.sourceId.slice(-4)); else sourceInfo = 'ERR'; destInfo = task.id.slice(-4); }
                else if (task.type === 'container_empty' || task.type === 'container_drain') { sourceInfo = 'cont:' + task.id.slice(-4); if (task.targetId) { let tgtObj = Game.getObjectById(task.targetId); if (tgtObj) destInfo = (tgtObj.structureType === STRUCTURE_STORAGE ? 'stor' : (tgtObj.structureType === STRUCTURE_TOWER ? 'towr:' : 'cont:') + task.targetId.slice(-4)); else destInfo = 'ERR'; }}
                else { destInfo = task.id.slice(-4); }
                rows.push({ type: task.type, id: shortId, pos: `${task.pos.x},${task.pos.y}`, need: task.need.toString(), assigned: `${assignedSuppliers.length}/${task.maxAssign}`, suppliers: supplierNames, source: sourceInfo, destination: destInfo });
            });
            let idleSuppliers = allRoomSuppliers.filter(s => !s.memory.assignment).map(s => s.name.slice(-4));
            if (idleSuppliers.length > 0) rows.push({ type: 'IDLE', id: '------', pos: '---', need: '---', assigned: `${idleSuppliers.length}/∞`, suppliers: idleSuppliers.join(','), source: 'none', destination: '---' });
            if (rows.length > 0) {
                console.log(`\n🚚 SUPPLIER TASKS - ${creep.room.name} (Tick ${Game.time})`);
                console.log('┌─────────────────┬────────┬──────┬──────┬─────────┬─────────────────────┬───────────┬─────────────┐');
                console.log('│      Type       │   ID   │ Pos  │ Need │ Assign  │      Suppliers      │  Source   │ Destination │');
                console.log('├─────────────────┼────────┼──────┼──────┼─────────┼─────────────────────┼───────────┼─────────────┤');
                rows.forEach(row => { let type = row.type.padEnd(15); let id = row.id.padEnd(6); let pos = row.pos.padEnd(4); let need = row.need.padEnd(4); let assigned = row.assigned.padEnd(7); let suppliers = row.suppliers.length > 19 ? row.suppliers.substring(0, 16) + '...' : row.suppliers.padEnd(19); let source = row.source.padEnd(9); let destination = row.destination.padEnd(11); console.log(`│ ${type} │ ${id} │ ${pos} │ ${need} │ ${assigned} │ ${suppliers} │ ${source} │ ${destination} │`); });
                console.log('└─────────────────┴────────┴──────┴──────┴─────────┴─────────────────────┴───────────┴─────────────┘');
            } else console.log(`🚚 ${creep.room.name}: No supplier tasks available`);
        }
        // --- END DISPLAY SUPPLIER TASK TABLE ---

        let currentAssignment = creep.memory.assignment; // Use this for state determination

        // --- NEW: STATE DETERMINATION ---
        if (currentAssignment && currentAssignment.taskId) {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) { // Creep is EMPTY
                creep.memory.state = 'fetching';
            } else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) { // Creep is FULL
                creep.memory.state = 'delivering';
            } else { // Creep is PARTIALLY FULL
                // For direct delivery tasks, if creep has energy, it should deliver.
                if (currentAssignment.type === 'spawn' ||
                    currentAssignment.type === 'extension' ||
                    currentAssignment.type === 'tower' ||
                    currentAssignment.type === 'storage' || // Filling storage from an external source
                    currentAssignment.type === 'link') {
                    creep.memory.state = 'delivering';
                }
                // For tasks involving a pickup then delivery, if partially full, continue fetching.
                else if (currentAssignment.type === 'container_transfer' ||
                         currentAssignment.type === 'container_empty' ||
                         currentAssignment.type === 'container_drain' ||
                         currentAssignment.type === 'container_fill') {
                    creep.memory.state = 'fetching';
                }
                // Fallback for any other assigned task type if partially full
                else {
                    creep.memory.state = 'fetching'; // Default to fetching
                }
            }
        } else { // NO ASSIGNMENT
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                creep.memory.state = 'delivering'; // Has energy, try general delivery
            } else {
                creep.memory.state = 'fetching'; // No energy, try general fetching
            }
        }
        // --- END NEW STATE DETERMINATION ---


        // --- FETCHING ---
        if (creep.memory.state === 'fetching') {
            // Check if creep is full or if it's a storage task and has some energy (can start delivering to storage early)
            if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 ||
               (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && currentAssignment && currentAssignment.type === 'storage')) {
                creep.memory.state = 'delivering';
                // Fall through to delivering logic in the same tick if state changed
            } else {
                let sourceToWithdraw = null;
                if (currentAssignment) {
                    if (currentAssignment.type === 'container_transfer' || currentAssignment.type === 'container_empty' || currentAssignment.type === 'container_drain') {
                        sourceToWithdraw = Game.getObjectById(currentAssignment.taskId);
                    } else if (currentAssignment.type === 'container_fill') {
                        sourceToWithdraw = Game.getObjectById(currentAssignment.sourceId);
                    }
                }

                if (sourceToWithdraw) {
                    if (!sourceToWithdraw || sourceToWithdraw.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                        creep.memory.assignment = null; // Source empty/gone, clear assignment
                        return; // Re-evaluate next tick
                    }
                    if (creep.withdraw(sourceToWithdraw, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(sourceToWithdraw, { visualizePathStyle: { stroke: (currentAssignment.type === 'container_drain' ? '#ff6600' : '#ffaa00') } });
                    }
                    return; // Action taken
                }

                // General fetching if no specific assigned source
                if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    let generalContainers = creep.room.find(FIND_STRUCTURES, {
                        filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
                                     (!tasksInMemory.some(t => t.type === 'container_transfer' && t.id === s.id && (assignedCounts[t.id] || 0) > 0))
                    });
                    let supplierFetchTargets = {}; // Recalculate for general fetching context
                    allRoomSuppliers.forEach(s => { if (s.memory.assignment && s.id !== creep.id) { let fSId = null; if (s.memory.assignment.type === 'container_empty' || s.memory.assignment.type === 'container_drain' || s.memory.assignment.type === 'container_transfer') fSId = s.memory.assignment.taskId; else if (s.memory.assignment.type === 'container_fill') fSId = s.memory.assignment.sourceId; else if (s.memory.state === 'fetching' && s.memory.targetId) { let tO = Game.getObjectById(s.memory.targetId); if (tO && tO.structureType === STRUCTURE_CONTAINER) fSId = s.memory.targetId; } if (fSId) supplierFetchTargets[fSId] = (supplierFetchTargets[fSId] || 0) + 1; }});
                    generalContainers = generalContainers.filter(c => !(c.store.getUsedCapacity(RESOURCE_ENERGY) < 250 && (supplierFetchTargets[c.id] || 0) >= 1));

                    let generalStorage = (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) ? [creep.room.storage] : [];
                    let generalDropped = creep.room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > Math.min(50, creep.store.getFreeCapacity(RESOURCE_ENERGY)) });
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
                } else { // Creep became full during general fetch
                    creep.memory.state = 'delivering';
                }
                return; // Action taken or state potentially changed
            }
        }

        // --- DELIVERING ---
        if (creep.memory.state === 'delivering') {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                creep.memory.state = 'fetching';
                // For container_transfer, assignment is NOT cleared here.
                // For other tasks, if creep is empty, assignment might be cleared if target was also met.
                if (currentAssignment && currentAssignment.type !== 'container_transfer') {
                    creep.memory.assignment = null;
                }
                return; // State changed, re-evaluate next tick
            }

            if (!currentAssignment || !currentAssignment.taskId) {
                // General delivery if no specific assignment
                if (creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    if (creep.transfer(creep.room.storage, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(creep.room.storage, { visualizePathStyle: { stroke: '#ffffff' } });
                } else {
                    let anyNonFull = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, { filter: (s) => (s.structureType == STRUCTURE_EXTENSION || s.structureType == STRUCTURE_SPAWN || s.structureType == STRUCTURE_TOWER) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                    if (anyNonFull) { if (creep.transfer(anyNonFull, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(anyNonFull, { visualizePathStyle: { stroke: '#ffffff' } }); }
                    else { const spawns = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN }); if (spawns.length > 0) creep.moveTo(spawns[0], { visualizePathStyle: { stroke: '#888888' }, range: 2 });}
                }
                return; // Action taken
            }

            let deliverTargetObject;
            if (currentAssignment.type === 'container_transfer') {
                deliverTargetObject = Game.getObjectById(currentAssignment.transferTargetId);
            } else if (currentAssignment.type === 'container_empty' || currentAssignment.type === 'container_drain') {
                deliverTargetObject = Game.getObjectById(currentAssignment.targetId);
            } else { // spawn, extension, tower, storage, link, container_fill
                deliverTargetObject = Game.getObjectById(currentAssignment.taskId);
            }

            // Special handling for container_drain if its original tower target is full
            if (currentAssignment.type === 'container_drain' && deliverTargetObject && deliverTargetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                const availableTowers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 });
                if (availableTowers.length > 0) {
                    let newTower = creep.pos.findClosestByRange(availableTowers);
                    creep.memory.assignment.targetId = newTower.id; // Update assignment
                    deliverTargetObject = newTower; // Update current target
                } else { creep.memory.assignment = null; return; } // No other towers, clear assignment
            }

            if (!deliverTargetObject || (deliverTargetObject.store && deliverTargetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0)) {
                creep.memory.assignment = null; // Target is full or gone, clear assignment
                return; // Re-evaluate next tick
            }

            const transferResult = creep.transfer(deliverTargetObject, RESOURCE_ENERGY);
            if (transferResult === ERR_NOT_IN_RANGE) {
                creep.moveTo(deliverTargetObject, { visualizePathStyle: { stroke: (currentAssignment.type === 'container_drain' ? '#ff9900' : '#ffffff') } });
            } else if (transferResult === OK) {
                // If target is now full, clear assignment (even for container_transfer, the pair is done for this load)
                if (deliverTargetObject.store && deliverTargetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                   creep.memory.assignment = null;
                }
                // If creep becomes empty, state will change to 'fetching' at the start of the next 'delivering' block or next tick.
            }
            return; // Action taken
        }
    }
};
