// Toggle logging for supplier task table here:
const SUPPLIER_LOGGING_ENABLED = false;
const SUPPLIER_CONTAINER_CATEGORY_LOGGING = false;

// Toggle to enable or disable the supplier role
const SUPPLIER_ENABLED = true;  // Set to false to disable

// --- CONFIGURABLE HYBRID CONTAINER RANGES ---
const HYBRID_MIN = 750;
const HYBRID_MAX = 1250;

// --- OPTIMIZATION: Pre-calculate and cache room state for the tick ---
if (!global.roomState) global.roomState = {};

function getRoomState(room) {
    const roomName = room.name;
    if (!global.roomState[roomName] || global.roomState[roomName].tick !== Game.time) {
        const state = {
            tick: Game.time,
            containers: room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER }),
            sources: room.find(FIND_SOURCES),
            spawns: room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN }),
            extractors: room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTRACTOR }),
            controller: room.controller,
            storage: room.storage,
            terminal: room.terminal,
            towers: room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }),
            links: room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LINK }),
            suppliers: room.find(FIND_MY_CREEPS, { filter: c => c.memory.role === 'supplier' }),
            containerLabels: {},
            tasks: [],
            assigned: {}          // running counter: taskId -> current assignments
        };

        // --- Container Labeling ---
        const donors = [], hybrids = [], recipients = [], materials = [];
        for (const c of state.containers) {
            const isMaterials = state.extractors.some(ex => ex.pos.getRangeTo(c.pos) === 1);
            if (isMaterials) {
                state.containerLabels[c.id] = 'materials';
                materials.push(c);
            } else {
                const isDonor = state.sources.some(src => src.pos.getRangeTo(c.pos) <= 4);
                const isRecipient = (state.controller && state.controller.pos.getRangeTo(c.pos) <= 2) ||
                                    state.spawns.some(sp => sp.pos.getRangeTo(c.pos) <= 5);
                const label = (!isDonor && isRecipient) ? 'recipient'
                            : (isDonor && !isRecipient) ? 'donor'
                            : 'hybrid';
                state.containerLabels[c.id] = label;
                if (label === 'donor') donors.push(c);
                if (label === 'hybrid') hybrids.push(c);
                if (label === 'recipient') recipients.push(c);
            }
        }

        // --- Task Generation ---
        const TASK_PRIORITIES = [
            { type: 'spawn', filter: s => s.structureType === STRUCTURE_SPAWN && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'extension', filter: s => s.structureType === STRUCTURE_EXTENSION && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'tower', filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && (s.store[RESOURCE_ENERGY] / s.store.getCapacity(RESOURCE_ENERGY)) < 0.75 },
            { type: 'link', filter: s => s.structureType === STRUCTURE_LINK && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            //{ type: 'storage', filter: s => s.structureType === STRUCTURE_STORAGE && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 }
        ];

        function getTaskPriorityValue(taskType) {
            switch (taskType) {
                case 'spawn': return 1;
                case 'extension': return 2;
                case 'tower': return 3;
                case 'link_fill': return 3.4;
                case 'link_drain': return 3.4;
                case 'link': return 3.5;
                case 'container_balance': return 3.6;
                case 'container_empty': return 4;
                case 'materials_empty': return 5.5;
                case 'materials_drain_energy': return 4.5;
                //case 'storage': return 6;
                case 'container_drain': return 5;
                default: return 7;
            }
        }

        // Basic fill tasks
        for (const p of TASK_PRIORITIES) {
            if (p.type === 'link') continue;
            const structs = room.find(FIND_STRUCTURES, { filter: p.filter });
            for (const s of structs) {
                const need = s.store.getFreeCapacity(RESOURCE_ENERGY);
                if (need > 0) {
                    state.tasks.push({ id: s.id, type: p.type, pos: s.pos, need, assigned: 0, maxAssign: 1 });
                }
            }
            if (p.type === 'tower' && state.tasks.length) break;
        }

        // Link logic
        if (state.storage) {
            const storageLinks = state.links.filter(l => l.pos.inRangeTo(state.storage.pos, 3));
            for (const link of storageLinks) {
                if (state.controller && link.pos.getRangeTo(state.controller.pos) <= 2) continue;
                const linkEnergy = link.store[RESOURCE_ENERGY];
                const LINK_FILL_THRESHOLD = 150, LINK_DRAIN_THRESHOLD = 475;
                if (linkEnergy < LINK_FILL_THRESHOLD && state.storage.store[RESOURCE_ENERGY] > 0) {
                    const amount = Math.min(LINK_DRAIN_THRESHOLD - linkEnergy, state.storage.store[RESOURCE_ENERGY], link.store.getFreeCapacity(RESOURCE_ENERGY));
                    if (amount > 0) state.tasks.push({ id: state.storage.id, type: 'link_fill', pos: state.storage.pos, need: amount, assigned: 0, maxAssign: 1, transferTargetId: link.id, transferTargetPos: link.pos });
                } else if (linkEnergy > LINK_DRAIN_THRESHOLD) {
                    const amount = Math.min(linkEnergy - LINK_FILL_THRESHOLD, state.storage.store.getFreeCapacity(RESOURCE_ENERGY));
                    if (amount > 0) state.tasks.push({ id: link.id, type: 'link_drain', pos: link.pos, need: amount, assigned: 0, maxAssign: 1, transferTargetId: state.storage.id, transferTargetPos: state.storage.pos });
                }
            }
        } else {
            const allLinks = state.links.filter(l => l.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            for (const link of allLinks) {
                if (state.controller && link.pos.getRangeTo(state.controller.pos) <= 2) continue;
                state.tasks.push({ id: link.id, type: 'link', pos: link.pos, need: link.store.getFreeCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1 });
            }
        }

        // Materials container logic
        for (const c of materials) {
            if (c.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                const drainTarget = state.storage || state.towers.find(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                if (drainTarget) state.tasks.push({ id: c.id, type: 'materials_drain_energy', pos: c.pos, need: c.store.getUsedCapacity(RESOURCE_ENERGY), assigned: 0, maxAssign: 1, transferTargetId: drainTarget.id, transferTargetPos: drainTarget.pos });
            }
            const totalMinerals = c.store.getUsedCapacity() - c.store.getUsedCapacity(RESOURCE_ENERGY);
            if (totalMinerals >= 200) {
                const emptyTarget = state.storage || state.terminal;
                if (emptyTarget) state.tasks.push({ id: c.id, type: 'materials_empty', pos: c.pos, need: totalMinerals, assigned: 0, maxAssign: 1, transferTargetId: emptyTarget.id, transferTargetPos: emptyTarget.pos });
            }
        }

        // Donor → Hybrid/Recipient/Storage/Tower
        // Donor → Hybrid/Recipient/Storage/Tower  (balancing + forced empty)
        for (const donor of donors) {
            const donorEnergy = donor.store.getUsedCapacity(RESOURCE_ENERGY);
            if (donorEnergy <= 0) continue;

            /* ---------- balancing tasks ---------- */
            const targets = [];
            hybrids.forEach(h => {
                const energy = h.store.getUsedCapacity(RESOURCE_ENERGY);
                if (energy < HYBRID_MIN) targets.push({ id: h.id, type: 'hybrid', obj: h, need: Math.min(HYBRID_MIN - energy, donorEnergy, h.store.getFreeCapacity(RESOURCE_ENERGY)) });
            });
            recipients.forEach(r => {
                const energy = r.store.getUsedCapacity(RESOURCE_ENERGY);
                const cap = r.store.getCapacity(RESOURCE_ENERGY);
                if (energy < cap) targets.push({ id: r.id, type: 'recipient', obj: r, need: Math.min(cap - energy, donorEnergy, r.store.getFreeCapacity(RESOURCE_ENERGY)) });
            });
            if (!targets.length && state.storage && state.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) targets.push({ id: state.storage.id, type: 'storage', obj: state.storage, need: Math.min(donorEnergy, state.storage.store.getFreeCapacity(RESOURCE_ENERGY)) });
            if (!targets.length && !state.storage) {
                const towers = state.towers.filter(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                if (towers.length) {
                    const t = donor.pos.findClosestByRange(towers);
                    targets.push({ id: t.id, type: 'container_drain', obj: t, need: Math.min(donorEnergy, t.store.getFreeCapacity(RESOURCE_ENERGY)) });
                }
            }

            /* push balancing tasks */
            targets.forEach(t => state.tasks.push({ id: donor.id, type: t.type === 'container_drain' ? 'container_drain' : 'container_balance', pos: donor.pos, need: t.need, assigned: 0, maxAssign: t.type === 'container_balance' ? 5 : 1, transferTargetId: t.id, transferTargetPos: t.obj.pos }));

            /* ---------- forced empty task ---------- */
            let target = null;
            if (state.storage && state.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                target = state.storage;
            } else {
                const needyTower = state.towers.find(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                if (needyTower) target = needyTower;
            }
            if (target) {
                state.tasks.push({ id: donor.id, type: 'container_drain', pos: donor.pos, need: donorEnergy, assigned: 0, maxAssign: 1, transferTargetId: target.id, transferTargetPos: target.pos });
            }
        }


        // Hybrid overflow/underflow
        hybrids.forEach(hybrid => {
            const energy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
            if (energy > HYBRID_MAX) {
                const excess = energy - HYBRID_MAX;
                const targets = [];
                recipients.forEach(r => {
                    const rEnergy = r.store.getUsedCapacity(RESOURCE_ENERGY);
                    const cap = r.store.getCapacity(RESOURCE_ENERGY);
                    if (rEnergy < cap) targets.push({ id: r.id, type: 'recipient', obj: r, need: Math.min(cap - rEnergy, excess, r.store.getFreeCapacity(RESOURCE_ENERGY)) });
                });
                hybrids.forEach(oh => {
                    if (oh.id === hybrid.id) return;
                    const oe = oh.store.getUsedCapacity(RESOURCE_ENERGY);
                    if (oe < HYBRID_MIN) targets.push({ id: oh.id, type: 'hybrid', obj: oh, need: Math.min(HYBRID_MIN - oe, excess, oh.store.getFreeCapacity(RESOURCE_ENERGY)) });
                });
                if (!targets.length && state.storage && state.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) targets.push({ id: state.storage.id, type: 'storage', obj: state.storage, need: Math.min(excess, state.storage.store.getFreeCapacity(RESOURCE_ENERGY)) });
                if (!targets.length && !state.storage) {
                    const towers = state.towers.filter(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                    if (towers.length) {
                        const t = hybrid.pos.findClosestByRange(towers);
                        targets.push({ id: t.id, type: 'container_drain', obj: t, need: Math.min(excess, t.store.getFreeCapacity(RESOURCE_ENERGY)) });
                    }
                }
                targets.forEach(t => state.tasks.push({ id: hybrid.id, type: t.type === 'container_drain' ? 'container_drain' : 'container_balance', pos: hybrid.pos, need: t.need, assigned: 0, maxAssign: 1, transferTargetId: t.id, transferTargetPos: t.obj.pos }));
            } else if (energy < HYBRID_MIN && state.storage && state.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                const amount = Math.min(HYBRID_MIN - energy, hybrid.store.getFreeCapacity(RESOURCE_ENERGY), state.storage.store.getUsedCapacity(RESOURCE_ENERGY));
                if (amount > 0) state.tasks.push({ id: state.storage.id, type: 'container_balance', pos: state.storage.pos, need: amount, assigned: 0, maxAssign: 1, transferTargetId: hybrid.id, transferTargetPos: hybrid.pos });
            }
        });

        // Recipients when no donor/hybrid → storage/hybrids
        const donorOrHybridHasEnergy = donors.some(d => d.store.getUsedCapacity(RESOURCE_ENERGY) > 0) || hybrids.some(h => h.store.getUsedCapacity(RESOURCE_ENERGY) > HYBRID_MIN);
        recipients.forEach(r => {
            const rEnergy = r.store.getUsedCapacity(RESOURCE_ENERGY);
            const cap = r.store.getCapacity(RESOURCE_ENERGY);
            if (rEnergy < cap) {
                const sources = [];
                if (!donorOrHybridHasEnergy) {
                    if (state.storage && state.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) sources.push({ id: state.storage.id, type: 'storage', obj: state.storage, available: state.storage.store.getUsedCapacity(RESOURCE_ENERGY) });
                    hybrids.forEach(h => {
                        const he = h.store.getUsedCapacity(RESOURCE_ENERGY);
                        if (he > HYBRID_MIN) sources.push({ id: h.id, type: 'hybrid', obj: h, available: he - HYBRID_MIN });
                    });
                }
                sources.forEach(src => {
                    const amt = Math.min(cap - rEnergy, src.available, r.store.getFreeCapacity(RESOURCE_ENERGY));
                    if (amt > 0) state.tasks.push({ id: src.id, type: 'container_balance', pos: src.obj.pos, need: amt, assigned: 0, maxAssign: 1, transferTargetId: r.id, transferTargetPos: r.pos });
                });
            }
        });

        // Any other container with energy → storage
        state.containers.forEach(c => {
            if (!['donor','hybrid','recipient','materials'].includes(state.containerLabels[c.id])) {
                const amt = c.store.getUsedCapacity(RESOURCE_ENERGY);
                if (amt > 0 && state.storage && state.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    state.tasks.push({ id: c.id, type: 'container_empty', pos: c.pos, need: amt, assigned: 0, maxAssign: 1, targetId: state.storage.id });
                }
            }
        });

        state.tasks.sort((a, b) => getTaskPriorityValue(a.type) - getTaskPriorityValue(b.type));
        global.roomState[roomName] = state;

        if (SUPPLIER_CONTAINER_CATEGORY_LOGGING) {
            let log = `\n🏷️ Container Categories for room ${room.name} (Tick ${Game.time}):\n`;
            log += `Donors: ${donors.length ? donors.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
            log += `Hybrids: ${hybrids.length ? hybrids.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
            log += `Recipients: ${recipients.length ? recipients.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
            log += `Materials: ${materials.length ? materials.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
            console.log(log);
        }
    }
    return global.roomState[room.name];
}

const roleSupplier = {
    /** @param {Creep} creep **/
    run: function(creep) {
        if (!SUPPLIER_ENABLED) {
            if (Game.time % 5 === 0) creep.say('Supplier disabled');
            return;
        }

        // --- ANTI-STUCK & REROUTE LOGIC ---
        if (creep.memory.lastPos && creep.pos.isEqualTo(creep.memory.lastPos.x, creep.memory.lastPos.y)) {
            creep.memory.stuckCount = (creep.memory.stuckCount || 0) + 1;
        } else {
            if (creep.memory.rerouting) delete creep.memory.rerouting;
            creep.memory.stuckCount = 0;
        }
        creep.memory.lastPos = { x: creep.pos.x, y: creep.pos.y };
        const moveOpts = {
            reusePath: creep.memory.rerouting ? 0 : 5,
            ignoreCreeps: false   // safer traffic
        };
        if (creep.memory.stuckCount >= 3) {
            creep.memory.rerouting = true;
            creep.say('🔄 reroute');
            creep.memory.stuckCount = 0;
        }

        // --- PRIORITY MINERALS DROP-OFF LOGIC ---
        let mineralType = null;
        for (const resourceType in creep.store) {
            if (resourceType !== RESOURCE_ENERGY && creep.store[resourceType] > 0) {
                mineralType = resourceType;
                break;
            }
        }
        if (mineralType) {
            const depositTarget = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                filter: (s) => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL) && s.store.getFreeCapacity(mineralType) > 0
            });
            if (depositTarget) {
                creep.say('💎 deposit');
                if (creep.transfer(depositTarget, mineralType) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(depositTarget, { ...moveOpts, visualizePathStyle: { stroke: '#cc00cc' } });
                }
                return;
            } else {
                creep.say('⚠️ full!');
                return;
            }
        }

        const roomState = getRoomState(creep.room);
        const tasks = roomState.tasks;

        // --- VALIDATE OR PICK ASSIGNMENT ---
        // 1. Validate current assignment
        if (creep.memory.assignment) {
            const a = creep.memory.assignment;
            const task = tasks.find(t => t.id === a.taskId && t.type === a.type);
            const srcObj = Game.getObjectById(a.taskId);
            const dstObj = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : srcObj;
            if (!task || !srcObj || !dstObj || (dstObj.store && dstObj.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && !['link_drain','materials_drain_energy','materials_empty'].includes(a.type))) {
                if (a.taskId) roomState.assigned[a.taskId] = (roomState.assigned[a.taskId] || 1) - 1;
                creep.memory.assignment = null;
            }
        }

        // 2. Pick new assignment if needed
        if (!creep.memory.assignment) {
            let bestTask = null;
            let bestDist = Infinity;
            for (const t of tasks) {
                const assigned = roomState.assigned[t.id] || 0;
                if (assigned >= t.maxAssign) continue;
                const dist = creep.pos.getRangeTo(t.pos.x, t.pos.y);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestTask = t;
                }
            }
            if (bestTask) {
                creep.memory.assignment = { taskId: bestTask.id, type: bestTask.type, transferTargetId: bestTask.transferTargetId, amount: bestTask.need };
                roomState.assigned[bestTask.id] = (roomState.assigned[bestTask.id] || 0) + 1;
                const isWithdraw = bestTask.type.startsWith('container') || bestTask.type === 'link_drain' || bestTask.type.startsWith('materials');
                creep.memory.state = isWithdraw || creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ? 'fetching' : 'delivering';
            }
        }

        // 3. Execute action
        if (creep.memory.assignment) {
            if (creep.memory.state === 'fetching' && creep.store.getFreeCapacity() === 0) creep.memory.state = 'delivering';
            if (creep.memory.state === 'delivering' && creep.store.getUsedCapacity() === 0) {
                if (creep.memory.assignment.taskId) roomState.assigned[creep.memory.assignment.taskId]--;
                creep.memory.assignment = null;
                return;
            }

            if (creep.memory.state === 'fetching') {
                creep.say('🔄 fetch');
                const a = creep.memory.assignment;
                const source = a.type.startsWith('container') || a.type === 'link_drain' || a.type.startsWith('materials') ? Game.getObjectById(a.taskId) : creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: s => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 });
                if (source) {
                    let resType = RESOURCE_ENERGY, amt;
                    if (a.type === 'materials_empty') {
                        for (const r in source.store) if (r !== RESOURCE_ENERGY) { resType = r; break; }
                    } else if (a.type === 'link_drain' && a.amount) amt = Math.min(a.amount, creep.store.getFreeCapacity(RESOURCE_ENERGY));
                    else if (a.type === 'materials_drain_energy') resType = RESOURCE_ENERGY;
                    if (creep.withdraw(source, resType, amt) === ERR_NOT_IN_RANGE) creep.moveTo(source, { ...moveOpts, visualizePathStyle: { stroke: '#ffaa00' } });
                }
            } else if (creep.memory.state === 'delivering') {
                creep.say('🚚 deliver');
                const a = creep.memory.assignment;
                const target = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : Game.getObjectById(a.taskId);
                if (target) {
                    let resType = RESOURCE_ENERGY, amt;
                    if (a.type === 'materials_empty') {
                        for (const r in creep.store) if (r !== RESOURCE_ENERGY && creep.store[r] > 0) { resType = r; break; }
                    } else if (a.type === 'link_fill' && a.amount) amt = Math.min(a.amount, creep.store.getUsedCapacity(RESOURCE_ENERGY));
                    const res = creep.transfer(target, resType, amt);
                    if (res === ERR_NOT_IN_RANGE) creep.moveTo(target, { ...moveOpts, visualizePathStyle: { stroke: '#ffffff' } });
                    else if (res === OK || res === ERR_FULL) {
                        if (a.taskId) roomState.assigned[a.taskId]--;
                        creep.memory.assignment = null;
                    }
                } else {
                    if (a.taskId) roomState.assigned[a.taskId]--;
                    creep.memory.assignment = null;
                }
            }
        }

        // --- LOGGING (unchanged) ---
        // --- LOGGING ---
        if (SUPPLIER_LOGGING_ENABLED && roomState.suppliers[0] === creep && Game.time % 5 === 0) {
            let assignmentMap = {};
            roomState.suppliers.forEach(s => {
                if (s.memory.assignment && s.memory.assignment.taskId) {
                    let id = s.memory.assignment.taskId;
                    assignmentMap[id] = assignmentMap[id] || [];
                    assignmentMap[id].push(s.name.slice(-4));
                }
            });
            let rows = [];
            tasks.forEach(t => {
                let supNames = assignmentMap[t.id] || [];
                let source = 'auto', dest = '---';
                if (['container_balance','link_fill','link_drain','materials_drain_energy','materials_empty'].includes(t.type)) {
                    let srcObj = Game.getObjectById(t.id);
                    let dstObj = Game.getObjectById(t.transferTargetId);
                    source = srcObj ? srcObj.structureType.substring(0,4) + ':' + t.id.slice(-4) : 'ERR';
                    dest   = dstObj ? dstObj.structureType.substring(0,4) + ':' + t.transferTargetId.slice(-4) : 'ERR';
                } else if (t.sourceId) {
                    let srcObj = Game.getObjectById(t.sourceId);
                    source = srcObj ? (srcObj.structureType === STRUCTURE_STORAGE ? 'stor' : 'cont:' + t.sourceId.slice(-4)) : 'ERR';
                    dest = t.id.slice(-4);
                } else if (['container_empty','container_drain'].includes(t.type)) {
                    source = 'cont:' + t.id.slice(-4);
                    if (t.targetId) {
                        let tgt = Game.getObjectById(t.targetId);
                        if (tgt) {
                            dest = (tgt.structureType === STRUCTURE_STORAGE ? 'stor' : tgt.structureType === STRUCTURE_TOWER ? 'towr:' + t.targetId.slice(-4) : 'cont:' + t.targetId.slice(-4));
                        } else dest = 'ERR';
                    }
                } else dest = t.id.slice(-4);

                rows.push({
                    type: t.type.padEnd(20),
                    id: t.id.slice(-6).padEnd(6),
                    pos: `${t.pos.x},${t.pos.y}`.padEnd(4),
                    need: t.need.toString().padEnd(4),
                    assigned: `${supNames.length}/${t.maxAssign}`.padEnd(7),
                    suppliers: (supNames.join(',') || 'none').padEnd(19),
                    source: source.padEnd(9),
                    destination: dest.padEnd(11)
                });
            });
            let idle = roomState.suppliers.filter(s => !s.memory.assignment).map(s => s.name.slice(-4));
            if (idle.length) {
                rows.push({
                    type: 'IDLE'.padEnd(20),
                    id: '------',
                    pos: '---',
                    need: '---',
                    assigned: `${idle.length}/∞`.padEnd(7),
                    suppliers: idle.join(',').padEnd(19),
                    source: 'none'.padEnd(9),
                    destination: '---'.padEnd(11)
                });
            }
            if (rows.length) {
                console.log(`\n🚚 SUPPLIER TASKS - ${creep.room.name} (Tick ${Game.time})`);
                console.log('┌──────────────────────┬────────┬──────┬──────┬─────────┬─────────────────────┬───────────┬─────────────┐');
                console.log('│ Type                 │ ID     │ Pos  │ Need │ Assign  │ Suppliers           │ Source    │ Destination │');
                console.log('├──────────────────────┼────────┼──────┼──────┼─────────┼─────────────────────┼───────────┴─────────────┤');
                rows.forEach(r => {
                    console.log(`│ ${r.type} │ ${r.id} │ ${r.pos} │ ${r.need} │ ${r.assigned} │ ${r.suppliers} │ ${r.source} │ ${r.destination} │`);
                });
                console.log('└──────────────────────┴────────┴──────┴──────┴─────────┴─────────────────────┴───────────┴─────────────┘');
            } else {
                console.log(`🚚 ${creep.room.name}: No supplier tasks available`);
            }
        }
    }
};

module.exports = roleSupplier;