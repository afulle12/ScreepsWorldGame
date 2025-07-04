// Toggle logging for supplier task table here:
const SUPPLIER_LOGGING_ENABLED = false;
const SUPPLIER_CONTAINER_CATEGORY_LOGGING = false;

// --- CONFIGURABLE HYBRID CONTAINER RANGES ---
const HYBRID_MIN = 750;
const HYBRID_MAX = 1250;

const roleSupplier = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // --- ANTI-STUCK LOGIC ---
        if (creep.memory.lastPos && creep.pos.isEqualTo(creep.memory.lastPos.x, creep.memory.lastPos.y)) {
            creep.memory.stuckCount = (creep.memory.stuckCount || 0) + 1;
        } else {
            creep.memory.stuckCount = 0;
        }
        creep.memory.lastPos = { x: creep.pos.x, y: creep.pos.y };

        let moveOpts = { reusePath: 5, ignoreCreeps: true };
        if (creep.memory.stuckCount >= 3) {
            moveOpts.reusePath = 0;
            moveOpts.ignoreCreeps = false;
            creep.say('🔄 unstuck');
            creep.memory.stuckCount = 0;
        }

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
            if (taskType === 'link_fill') return 3.4;
            if (taskType === 'link_drain') return 3.4;
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
                else label = 'hybrid';

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
                        tasks.push({
                            id: s.id, type: TASK_PRIORITIES[p].type, pos: s.pos, need: need, assigned: 0, maxAssign: 1
                        });
                    }
                }
                if (TASK_PRIORITIES[p].type === 'tower' && tasks.length > 0) {
                    break;
                }
            }

            // --- NEW: Conditional Link Logic ---
            if (creep.room.storage) {
                const storageLinks = creep.room.find(FIND_STRUCTURES, {
                    filter: s => s.structureType === STRUCTURE_LINK && s.pos.inRangeTo(creep.room.storage.pos, 3)
                });

                // If storage links exist, ONLY manage them. Do not create generic fill tasks for other links.
                if (storageLinks.length > 0) {
                    for (const link of storageLinks) {
                        const linkEnergy = link.store[RESOURCE_ENERGY];
                        const LINK_FILL_THRESHOLD = 150;
                        const LINK_DRAIN_THRESHOLD = 475;

                        if (linkEnergy < LINK_FILL_THRESHOLD && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
                            const amountNeeded = Math.min(LINK_DRAIN_THRESHOLD - linkEnergy, creep.room.storage.store[RESOURCE_ENERGY], link.store.getFreeCapacity(RESOURCE_ENERGY));
                            if (amountNeeded > 0) {
                                tasks.push({
                                    id: creep.room.storage.id, type: 'link_fill', pos: creep.room.storage.pos, need: amountNeeded, assigned: 0, maxAssign: 1, transferTargetId: link.id, transferTargetPos: link.pos
                                });
                            }
                        }
                        else if (linkEnergy > LINK_DRAIN_THRESHOLD) {
                            const amountToMove = Math.min(linkEnergy - LINK_FILL_THRESHOLD, creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY));
                            if (amountToMove > 0) {
                                tasks.push({
                                    id: link.id, type: 'link_drain', pos: link.pos, need: amountToMove, assigned: 0, maxAssign: 1, transferTargetId: creep.room.storage.id, transferTargetPos: creep.room.storage.pos
                                });
                            }
                        }
                    }
                } else {
                    // Fallback: No storage links exist, so fill any link that needs energy.
                    const allLinks = creep.room.find(FIND_STRUCTURES, {
                        filter: s => s.structureType === STRUCTURE_LINK && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                    });
                    for (let link of allLinks) {
                        tasks.push({
                            id: link.id, type: 'link', pos: link.pos, need: link.store.getFreeCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1
                        });
                    }
                }
            } else {
                // Fallback: No storage exists, so fill any link that needs energy.
                const allLinks = creep.room.find(FIND_STRUCTURES, {
                    filter: s => s.structureType === STRUCTURE_LINK && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                });
                for (let link of allLinks) {
                    tasks.push({
                        id: link.id, type: 'link', pos: link.pos, need: link.store.getFreeCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1
                    });
                }
            }

            // ... (rest of container logic is unchanged)
            const containers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
            let donors = [], hybrids = [], recipients = [];
            for (let c of containers) {
                if (containerLabels[c.id] === 'donor') donors.push(c);
                else if (containerLabels[c.id] === 'hybrid') hybrids.push(c);
                else if (containerLabels[c.id] === 'recipient') recipients.push(c);
            }
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
                            maxAssign: 5,
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

            if (!taskStillExists || !primaryObject || !targetObject || (targetObject.store && targetObject.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && assignment.type !== 'link_drain')) {
                creep.memory.assignment = null;
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
                        amount: bestTask.need
                    };
                    const isWithdrawTask = bestTask.type.startsWith('container') || bestTask.type === 'link_drain';
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
            if (creep.memory.state === 'fetching' && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                creep.memory.state = 'delivering';
            }
            if (creep.memory.state === 'delivering' && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                creep.memory.assignment = null;
                return;
            }

            if (creep.memory.state === 'fetching') {
                creep.say('🔄 fetch');
                let assignment = creep.memory.assignment;
                let sourceObject;

                if (assignment.type.startsWith('container') || assignment.type === 'link_drain') {
                    sourceObject = Game.getObjectById(assignment.taskId);
                } else {
                    sourceObject = creep.pos.findClosestByRange(FIND_STRUCTURES, {
                        filter: s => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                    });
                }

                if (sourceObject) {
                    let amountToWithdraw = undefined;
                    if (assignment.type === 'link_drain' && assignment.amount) {
                        amountToWithdraw = Math.min(assignment.amount, creep.store.getFreeCapacity(RESOURCE_ENERGY));
                    }

                    if (creep.withdraw(sourceObject, RESOURCE_ENERGY, amountToWithdraw) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(sourceObject, { ...moveOpts, visualizePathStyle: { stroke: '#ffaa00' } });
                    }
                }
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
                    let amountToTransfer = undefined;
                    if (assignment.type === 'link_fill' && assignment.amount) {
                        amountToTransfer = Math.min(assignment.amount, creep.store[RESOURCE_ENERGY]);
                    }

                    const transferResult = creep.transfer(deliverTargetObject, RESOURCE_ENERGY, amountToTransfer);
                    if (transferResult === ERR_NOT_IN_RANGE) {
                        creep.moveTo(deliverTargetObject, { ...moveOpts, visualizePathStyle: { stroke: '#ffffff' } });
                    } else if (transferResult === OK || transferResult === ERR_FULL) {
                        creep.memory.assignment = null;
                    }
                } else {
                    creep.memory.assignment = null;
                }
            }
        }
        // IDLE BEHAVIOR REMOVED

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

                if (task.type === 'container_balance' || task.type === 'link_fill' || task.type === 'link_drain') {
                    let srcObj = Game.getObjectById(task.id);
                    let dstObj = Game.getObjectById(task.transferTargetId);
                    if (srcObj) {
                        let srcType = srcObj.structureType.substring(0, 4);
                        sourceInfo = `${srcType}:${task.id.slice(-4)}`;
                    } else { sourceInfo = 'ERR'; }
                    if (dstObj) {
                        let dstType = dstObj.structureType.substring(0, 4);
                        destInfo = `${dstType}:${task.transferTargetId.slice(-4)}`;
                    } else { destInfo = 'ERR'; }
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

module.exports = roleSupplier;
