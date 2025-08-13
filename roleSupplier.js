// Toggle logging for supplier task table here:
const SUPPLIER_LOGGING_ENABLED = false;
const SUPPLIER_CONTAINER_CATEGORY_LOGGING = false;

// Toggle to enable or disable the supplier role
const SUPPLIER_ENABLED = true;  // Set to false to disable

// --- CONFIGURABLE HYBRID CONTAINER RANGES ---
const HYBRID_MIN = 750;
const HYBRID_MAX = 1250;

// --- IDLE CONFIGURATION ---
const IDLE_DURATION = 10; // Ticks to idle when no tasks available

// --- OPTIMIZATION: Pre-calculate and cache room state for the tick ---
if (!global.roomState) global.roomState = {};

// NEW: integrate with terminalManager to gate terminal_balance when transfers are in progress
const terminalManager = require('terminalManager');

// Integer task priorities (lower number = higher priority)
function getTaskPriorityValue(taskType) {
    switch (taskType) {
        case 'spawn': return 20;
        case 'extension': return 10;
        case 'tower': return 30;
        case 'link_fill': return 34;
        case 'link_drain': return 5;
        case 'link': return 36;
        case 'container_empty': return 40;
        case 'materials_drain_energy': return 45;
        case 'container_balance': return 46;
        case 'container_drain': return 50;
        case 'materials_empty': return 55;
        case 'terminal_balance': return 60; // balance terminal energy around 20k
        default: return 70;
    }
}

// Helper move wrapper: reusePath, scaled maxOps, skip if fatigued, reroute when stuck
function smartMove(creep, target, extraOpts = {}) {
    if (creep.fatigue > 0) return OK;

    // Mark that we attempted to move this tick
    creep.memory.lastTriedMoveTick = Game.time;

    const targetPos = target.pos || target;
    const dist = creep.pos.getRangeTo(targetPos);
    const maxOps = Math.min(2000, Math.max(200, dist * 50));

    const inReroute = Game.time < (creep.memory.rerouteUntil || 0);

    const moveOpts = {
        // During reroute: force fresh pathing; otherwise use a modest reuse
        reusePath: inReroute ? 0 : Math.min(10, Math.max(3, Math.floor(dist / 2))),
        // Avoid creeps when rerouting or when close to the destination
        //ignoreCreeps: !(inReroute || dist <= 5),
        maxOps,
        heuristicWeight: 1.2,
        ...extraOpts
    };

    const res = creep.moveTo(targetPos, moveOpts);

    // If no path found, trigger a short reroute window and drop cached path
    if (res === ERR_NO_PATH && !inReroute) {
        creep.memory.rerouteUntil = Game.time + 3;
        if (creep.memory._move) delete creep.memory._move;
    }

    return res;
}

function getRoomState(room) {
    const roomName = room.name;
    if (!global.roomState[roomName] || global.roomState[roomName].tick !== Game.time) {
        // Single find call for all structures
        const allStructures = room.find(FIND_STRUCTURES);

        // Filter structures into categories
        const containers = [];
        const spawns = [];
        const extractors = [];
        const towers = [];
        const links = [];
        const extensions = [];

        for (const structure of allStructures) {
            switch (structure.structureType) {
                case STRUCTURE_CONTAINER:
                    containers.push(structure);
                    break;
                case STRUCTURE_SPAWN:
                    if (structure.my) spawns.push(structure);
                    break;
                case STRUCTURE_EXTRACTOR:
                    if (structure.my) extractors.push(structure);
                    break;
                case STRUCTURE_TOWER:
                    towers.push(structure);
                    break;
                case STRUCTURE_LINK:
                    links.push(structure);
                    break;
                case STRUCTURE_EXTENSION:
                    extensions.push(structure);
                    break;
            }
        }

        const sources = room.find(FIND_SOURCES);

        const state = {
            tick: Game.time,
            containers: containers,
            sources: sources,
            spawns: spawns,
            extractors: extractors,
            controller: room.controller,
            storage: room.storage,
            terminal: room.terminal,
            towers: towers,
            links: links,
            extensions: extensions,
            suppliers: room.find(FIND_MY_CREEPS, { filter: c => c.memory.role === 'supplier' }),
            containerLabels: {},
            tasks: [],
            assigned: {}
        };

        // --- Container Labeling (persist in room.memory) ---
        const mem = room.memory;
        if (!mem.containerLabels) mem.containerLabels = {};
        if (!mem.containerLabelMeta) mem.containerLabelMeta = {};

        const currentMeta = {
            containerIds: containers.map(c => c.id).sort(),
            spawnIds: spawns.map(s => s.id).sort(),
            extractorIds: extractors.map(e => e.id).sort(),
            sourceIds: sources.map(s => s.id).sort(),
            controllerId: state.controller ? state.controller.id : null
        };

        const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

        let recomputeLabels =
            !mem.containerLabelMeta ||
            !arraysEqual(mem.containerLabelMeta.containerIds || [], currentMeta.containerIds) ||
            !arraysEqual(mem.containerLabelMeta.spawnIds || [], currentMeta.spawnIds) ||
            !arraysEqual(mem.containerLabelMeta.extractorIds || [], currentMeta.extractorIds) ||
            !arraysEqual(mem.containerLabelMeta.sourceIds || [], currentMeta.sourceIds) ||
            mem.containerLabelMeta.controllerId !== currentMeta.controllerId ||
            (Game.time % 1000 === 0); // periodic refresh

        if (recomputeLabels) {
            const labels = {};
            for (const c of containers) {
                const isMaterials = extractors.some(ex => ex.pos.getRangeTo(c.pos) === 1);
                if (isMaterials) {
                    labels[c.id] = 'materials';
                } else {
                    const isDonor = sources.some(src => src.pos.getRangeTo(c.pos) <= 4);
                    const isRecipient =
                        (state.controller && state.controller.pos.getRangeTo(c.pos) <= 2) ||
                        spawns.some(sp => sp.pos.getRangeTo(c.pos) <= 5);
                    const label = (!isDonor && isRecipient) ? 'recipient'
                                : (isDonor && !isRecipient) ? 'donor'
                                : 'hybrid';
                    labels[c.id] = label;
                }
            }
            mem.containerLabels = labels;
            mem.containerLabelMeta = currentMeta;
        }

        state.containerLabels = mem.containerLabels;

        // Compute categorized container lists from persisted labels
        const donors = [];
        const hybrids = [];
        const recipients = [];
        const materials = [];

        for (const c of containers) {
            const label = mem.containerLabels[c.id];
            if (label === 'donor') donors.push(c);
            else if (label === 'hybrid') hybrids.push(c);
            else if (label === 'recipient') recipients.push(c);
            else if (label === 'materials') materials.push(c);
        }

        // --- Task Generation ---
        // Basic fill tasks using pre-filtered arrays
        const basicFillSpecs = [
            { type: 'spawn', list: spawns, filter: s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'extension', list: extensions, filter: s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
            { type: 'tower', list: towers, filter: s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && (s.store[RESOURCE_ENERGY] / s.store.getCapacity(RESOURCE_ENERGY)) < 0.75 }
        ];

        for (const spec of basicFillSpecs) {
            const structs = spec.list.filter(spec.filter);
            for (const s of structs) {
                const need = s.store.getFreeCapacity(RESOURCE_ENERGY);
                if (need > 0) {
                    state.tasks.push({
                        id: s.id,
                        type: spec.type,
                        pos: s.pos,
                        need,
                        assigned: 0,
                        maxAssign: 1,
                        priority: getTaskPriorityValue(spec.type)
                    });
                }
            }
            if (spec.type === 'tower' && state.tasks.length) break;
        }

        // Link logic - Only work with links within 2 range of storage
        if (state.storage) {
            const storageLinks = state.links.filter(l => l.pos.inRangeTo(state.storage.pos, 2));
            for (const link of storageLinks) {
                if (state.controller && link.pos.getRangeTo(state.controller.pos) <= 2) continue;

                // Skip links within 2 range of any source
                const isNearSource = state.sources.some(src => src.pos.getRangeTo(link.pos) <= 2);
                if (isNearSource) continue;

                const linkEnergy = link.store[RESOURCE_ENERGY];
                const LINK_FILL_THRESHOLD = 150, LINK_DRAIN_THRESHOLD = 475;
                if (linkEnergy < LINK_FILL_THRESHOLD && state.storage.store[RESOURCE_ENERGY] > 0) {
                    const amount = Math.min(LINK_DRAIN_THRESHOLD - linkEnergy, state.storage.store[RESOURCE_ENERGY], link.store.getFreeCapacity(RESOURCE_ENERGY));
                    if (amount > 0) state.tasks.push({
                        id: state.storage.id,
                        type: 'link_fill',
                        pos: state.storage.pos,
                        need: amount,
                        assigned: 0,
                        maxAssign: 1,
                        transferTargetId: link.id,
                        transferTargetPos: link.pos,
                        priority: getTaskPriorityValue('link_fill')
                    });
                } else if (linkEnergy > LINK_DRAIN_THRESHOLD) {
                    const amount = Math.min(linkEnergy - LINK_FILL_THRESHOLD, state.storage.store.getFreeCapacity(RESOURCE_ENERGY));
                    if (amount > 0) state.tasks.push({
                        id: link.id,
                        type: 'link_drain',
                        pos: link.pos,
                        need: amount,
                        assigned: 0,
                        maxAssign: 1,
                        transferTargetId: state.storage.id,
                        transferTargetPos: state.storage.pos,
                        priority: getTaskPriorityValue('link_drain')
                    });
                }
            }
        }

        // Materials container logic
        for (const c of materials) {
            if (c.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                const drainTarget = state.storage || state.towers.find(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                if (drainTarget) state.tasks.push({
                    id: c.id,
                    type: 'materials_drain_energy',
                    pos: c.pos,
                    need: c.store.getUsedCapacity(RESOURCE_ENERGY),
                    assigned: 0,
                    maxAssign: 1,
                    transferTargetId: drainTarget.id,
                    transferTargetPos: drainTarget.pos,
                    priority: getTaskPriorityValue('materials_drain_energy')
                });
            }
            const totalMinerals = c.store.getUsedCapacity() - c.store.getUsedCapacity(RESOURCE_ENERGY);
            if (totalMinerals >= 200) {
                const emptyTarget = state.storage || state.terminal;
                if (emptyTarget) {
                    state.tasks.push({
                        id: c.id,
                        type: 'materials_empty',
                        pos: c.pos,
                        need: totalMinerals,
                        assigned: 0,
                        maxAssign: 1,
                        transferTargetId: emptyTarget.id,
                        transferTargetPos: emptyTarget.pos,
                        minCapacityRequired: Math.ceil(totalMinerals * 0.5),
                        priority: getTaskPriorityValue('materials_empty')
                    });
                }
            }
        }

        // Donor → Hybrid/Recipient/Storage/Tower  (balancing + forced empty)
        for (const donor of donors) {
            const donorEnergy = donor.store.getUsedCapacity(RESOURCE_ENERGY);
            if (donorEnergy <= 0) continue;

            /* ---------- balancing tasks (pick best single target to avoid task explosion) ---------- */
            let bestTarget = null;
            let bestNeed = 0;
            let bestRange = Infinity;

            // Hybrids under min
            for (const h of hybrids) {
                const energy = h.store.getUsedCapacity(RESOURCE_ENERGY);
                if (energy < HYBRID_MIN) {
                    const need = Math.min(HYBRID_MIN - energy, donorEnergy, h.store.getFreeCapacity(RESOURCE_ENERGY));
                    const range = donor.pos.getRangeTo(h.pos);
                    if (need > 0 && (need > bestNeed || (need === bestNeed && range < bestRange))) {
                        bestNeed = need;
                        bestRange = range;
                        bestTarget = { id: h.id, type: 'hybrid', obj: h, need };
                    }
                }
            }

            // Recipients not full
            for (const r of recipients) {
                const energy = r.store.getUsedCapacity(RESOURCE_ENERGY);
                const cap = r.store.getCapacity(RESOURCE_ENERGY);
                if (energy < cap) {
                    const need = Math.min(cap - energy, donorEnergy, r.store.getFreeCapacity(RESOURCE_ENERGY));
                    const range = donor.pos.getRangeTo(r.pos);
                    if (need > 0 && (need > bestNeed || (need === bestNeed && range < bestRange))) {
                        bestNeed = need;
                        bestRange = range;
                        bestTarget = { id: r.id, type: 'recipient', obj: r, need };
                    }
                }
            }

            // Storage if available
            if (!bestTarget && state.storage && state.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                bestTarget = {
                    id: state.storage.id, type: 'storage', obj: state.storage,
                    need: Math.min(donorEnergy, state.storage.store.getFreeCapacity(RESOURCE_ENERGY))
                };
            }

            // Towers if no storage
            if (!bestTarget && !state.storage) {
                const needyTowers = state.towers.filter(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                if (needyTowers.length) {
                    const t = donor.pos.findClosestByRange(needyTowers);
                    bestTarget = {
                        id: t.id, type: 'container_drain', obj: t,
                        need: Math.min(donorEnergy, t.store.getFreeCapacity(RESOURCE_ENERGY))
                    };
                }
            }

            if (bestTarget) {
                state.tasks.push({
                    id: donor.id,
                    type: bestTarget.type === 'container_drain' ? 'container_drain' : 'container_balance',
                    pos: donor.pos,
                    need: bestTarget.need,
                    assigned: 0,
                    maxAssign: bestTarget.type === 'container_drain' ? 1 : 5,
                    transferTargetId: bestTarget.id,
                    transferTargetPos: bestTarget.obj.pos,
                    priority: getTaskPriorityValue(bestTarget.type === 'container_drain' ? 'container_drain' : 'container_balance')
                });
            }

            /* ---------- forced empty task ---------- */
            let forcedTarget = null;
            if (state.storage && state.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                forcedTarget = state.storage;
            } else {
                const needyTower = state.towers.find(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
                if (needyTower) forcedTarget = needyTower;
            }
            if (forcedTarget) {
                state.tasks.push({
                    id: donor.id,
                    type: 'container_drain',
                    pos: donor.pos,
                    need: donorEnergy,
                    assigned: 0,
                    maxAssign: 1,
                    transferTargetId: forcedTarget.id,
                    transferTargetPos: forcedTarget.pos,
                    priority: getTaskPriorityValue('container_drain')
                });
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
                targets.forEach(t => state.tasks.push({
                    id: hybrid.id,
                    type: t.type === 'container_drain' ? 'container_drain' : 'container_balance',
                    pos: hybrid.pos,
                    need: t.need,
                    assigned: 0,
                    maxAssign: 1,
                    transferTargetId: t.id,
                    transferTargetPos: t.obj.pos,
                    priority: getTaskPriorityValue(t.type === 'container_drain' ? 'container_drain' : 'container_balance')
                }));
            } else if (energy < HYBRID_MIN && state.storage && state.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                const amount = Math.min(HYBRID_MIN - energy, hybrid.store.getFreeCapacity(RESOURCE_ENERGY), state.storage.store.getUsedCapacity(RESOURCE_ENERGY));
                if (amount > 0) state.tasks.push({
                    id: state.storage.id,
                    type: 'container_balance',
                    pos: state.storage.pos,
                    need: amount,
                    assigned: 0,
                    maxAssign: 1,
                    transferTargetId: hybrid.id,
                    transferTargetPos: hybrid.pos,
                    priority: getTaskPriorityValue('container_balance')
                });
            }
        });

        // Recipients when no donor/hybrid → storage/hybrids
        const donorOrHybridHasEnergy = donors.some(d => d.store.getUsedCapacity(RESOURCE_ENERGY) > 0) || hybrids.some(h => h.store.getUsedCapacity(RESOURCE_ENERGY) > HYBRID_MIN);
        recipients.forEach(r => {
            const rEnergy = r.store.getUsedCapacity(RESOURCE_ENERGY);
            const cap = r.store.getCapacity(RESOURCE_ENERGY);
            if (rEnergy < cap) {
                const sourcesList = [];
                if (!donorOrHybridHasEnergy) {
                    if (state.storage && state.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) sourcesList.push({ id: state.storage.id, type: 'storage', obj: state.storage, available: state.storage.store.getUsedCapacity(RESOURCE_ENERGY) });
                    hybrids.forEach(h => {
                        const he = h.store.getUsedCapacity(RESOURCE_ENERGY);
                        if (he > HYBRID_MIN) sourcesList.push({ id: h.id, type: 'hybrid', obj: h, available: he - HYBRID_MIN });
                    });
                }
                sourcesList.forEach(src => {
                    const amt = Math.min(cap - rEnergy, src.available, r.store.getFreeCapacity(RESOURCE_ENERGY));
                    if (amt > 0) state.tasks.push({
                        id: src.id,
                        type: 'container_balance',
                        pos: src.obj.pos,
                        need: amt,
                        assigned: 0,
                        maxAssign: 1,
                        transferTargetId: r.id,
                        transferTargetPos: r.pos,
                        priority: getTaskPriorityValue('container_balance')
                    });
                });
            }
        });

        // Any other container with energy → storage
        state.containers.forEach(c => {
            if (!['donor', 'hybrid', 'recipient', 'materials'].includes(state.containerLabels[c.id])) {
                const amt = c.store.getUsedCapacity(RESOURCE_ENERGY);
                if (amt > 0 && state.storage && state.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    state.tasks.push({
                        id: c.id,
                        type: 'container_empty',
                        pos: c.pos,
                        need: amt,
                        assigned: 0,
                        maxAssign: 1,
                        targetId: state.storage.id,
                        priority: getTaskPriorityValue('container_empty')
                    });
                }
            }
        });

        // --- Terminal balance (maintain ~20k energy within 19.5k–20.5k) ---
        // Valid only if both storage and terminal exist, and no active transfer involves this room.
        if (state.storage && state.terminal) {
            const roomBusy = terminalManager && typeof terminalManager.isRoomBusyWithTransfer === 'function'
                ? terminalManager.isRoomBusyWithTransfer(room.name)
                : false;

            if (!roomBusy) {
                const term = state.terminal;
                const stor = state.storage;

                const TARGET = 20000;
                const MIN = 19500;
                const MAX = 20500;

                const termEnergy = term.store.getUsedCapacity(RESOURCE_ENERGY);

                // If terminal has too much energy, move excess to storage
                if (termEnergy > MAX && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    const amount = Math.min(termEnergy - TARGET, stor.store.getFreeCapacity(RESOURCE_ENERGY));
                    if (amount > 0) {
                        state.tasks.push({
                            id: term.id, // source: terminal
                            type: 'terminal_balance',
                            pos: term.pos,
                            need: amount,
                            assigned: 0,
                            maxAssign: 1,
                            transferTargetId: stor.id, // destination: storage
                            transferTargetPos: stor.pos,
                            priority: getTaskPriorityValue('terminal_balance')
                        });
                    }
                }

                // If terminal has too little energy, pull from storage
                if (termEnergy < MIN && stor.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    const amount = Math.min(
                        TARGET - termEnergy,
                        stor.store.getUsedCapacity(RESOURCE_ENERGY),
                        term.store.getFreeCapacity(RESOURCE_ENERGY)
                    );
                    if (amount > 0) {
                        state.tasks.push({
                            id: stor.id, // source: storage
                            type: 'terminal_balance',
                            pos: stor.pos,
                            need: amount,
                            assigned: 0,
                            maxAssign: 1,
                            transferTargetId: term.id, // destination: terminal
                            transferTargetPos: term.pos,
                            priority: getTaskPriorityValue('terminal_balance')
                        });
                    }
                }
            }
        }

        // Sort tasks by priority first, then need (descending)
        state.tasks.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return b.need - a.need;
        });

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
    return global.roomState[roomName];
}

// Optional: small helper to try stepping aside to break face-to-face jams
function tryStepAside(creep) {
    const terrain = creep.room.getTerrain();
    // Directions in Screeps: 1..8 = TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT
    const dirs = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

    // Light shuffle to avoid bias
    for (let i = dirs.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = dirs[i]; dirs[i] = dirs[j]; dirs[j] = tmp;
    }

    const dx = [0, 1, 1, 1, 0, -1, -1, -1];
    const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

    for (const dir of dirs) {
        const idx = dir - 1;
        const x = creep.pos.x + dx[idx];
        const y = creep.pos.y + dy[idx];

        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        // Skip tiles with blocking structures or creeps
        const hasCreep = creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0;
        if (hasCreep) continue;

        const hasBlocker = creep.room.lookForAt(LOOK_STRUCTURES, x, y).some(s =>
            s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER
        );
        if (hasBlocker) continue;

        // Mark that we attempted to move this tick
        creep.memory.lastTriedMoveTick = Game.time;

        // Move one step to the side
        creep.move(dir);
        return true;
    }
    return false;
}

const roleSupplier = {
    /** @param {Creep} creep **/
    run: function (creep) {
        if (!SUPPLIER_ENABLED) {
            if (Game.time % 5 === 0) creep.say('Supplier disabled');
            return;
        }

        // Early idle check - minimal CPU usage
        if (creep.memory.nextCheckTick && Game.time < creep.memory.nextCheckTick) {
            creep.say('💤 idle');
            return;
        }

        // --- ENHANCED ANTI-STUCK & REROUTE LOGIC (TTL-based) ---
        if (creep.memory.lastPos) {
            // Don't count as stuck while fatigued
            if (creep.fatigue === 0) {
                const moved = creep.pos.x !== creep.memory.lastPos.x || creep.pos.y !== creep.memory.lastPos.y;
                // Only count as stuck if we attempted a move last tick
                const triedMoveLastTick = creep.memory.lastTriedMoveTick === (Game.time - 1);

                if (!moved && triedMoveLastTick) {
                    creep.memory.stuckCount = (creep.memory.stuckCount || 0) + 1;
                } else if (moved) {
                    creep.memory.stuckCount = 0;
                }
                // If we didn't try to move last tick, don't increment stuckCount
            }
        } else {
            creep.memory.stuckCount = 0;
        }
        creep.memory.lastPos = { x: creep.pos.x, y: creep.pos.y };

        // Start or extend reroute window when stuck (but don't step aside if we're intentionally in range)
        if ((creep.memory.stuckCount || 0) >= 2) {
            let shouldStepAside = true;
            const a = creep.memory.assignment;

            if (a) {
                if (creep.memory.state === 'delivering') {
                    const t = Game.getObjectById(a.transferTargetId || a.taskId);
                    if (t && creep.pos.getRangeTo(t.pos) <= 1) {
                        shouldStepAside = false; // already in range to transfer
                    }
                } else if (creep.memory.state === 'fetching') {
                    // For explicit source-withdraw tasks, being adjacent is expected
                    if (a.type && (a.type.indexOf('container') === 0 || a.type === 'link_drain' || a.type.indexOf('materials') === 0 || a.type === 'terminal_balance')) {
                        const s = Game.getObjectById(a.taskId);
                        if (s && creep.pos.getRangeTo(s.pos) <= 1) {
                            shouldStepAside = false; // already in range to withdraw
                        }
                    }
                    // Extra guard: if any adjacent structure has energy we can withdraw, don't step aside
                    if (shouldStepAside && creep.store.getFreeCapacity() > 0) {
                        const nearby = creep.pos.findInRange(FIND_STRUCTURES, 1, {
                            filter: function (s) {
                                if (!s.store) return false;
                                const cap = s.store.getUsedCapacity(RESOURCE_ENERGY);
                                return cap && cap > 0;
                            }
                        });
                        if (nearby && nearby.length > 0) shouldStepAside = false;
                    }
                } else if (creep.memory.state === 'delivering_energy') {
                    const t = creep.room.storage;
                    if (t && creep.pos.getRangeTo(t.pos) <= 1) {
                        shouldStepAside = false;
                    }
                }
            }

            if (shouldStepAside) {
                // Try a small lateral move to break face-to-face jams
                tryStepAside(creep);

                // Reroute for N ticks to actually follow the detour
                const REROUTE_TICKS = 5;
                creep.memory.rerouteUntil = Math.max(Game.time + REROUTE_TICKS, creep.memory.rerouteUntil || 0);

                // Drop cached path so we don't reuse the old, blocked one
                if (creep.memory._move) delete creep.memory._move;

                // Note: later say() calls may overwrite this
                creep.say('🔄 reroute');
                creep.memory.stuckCount = 0;
            } else {
                // We're purposefully holding position to act; don't treat as stuck
                creep.memory.stuckCount = 0;
            }
        }

        // Expire reroute window
        if (creep.memory.rerouteUntil && Game.time >= creep.memory.rerouteUntil) {
            delete creep.memory.rerouteUntil;
        }

        // Cache store values to avoid repeated calls
        const storeCache = {
            freeCapacity: creep.store.getFreeCapacity(),
            usedCapacity: creep.store.getUsedCapacity(),
            energyUsed: creep.store.getUsedCapacity(RESOURCE_ENERGY)
        };

        // Get room state once at the beginning
        const roomState = getRoomState(creep.room);
        const tasks = roomState.tasks;

        // --- PRIORITY MINERALS DROP-OFF LOGIC (OPTIMIZED) ---
        let mineralType = null;
        for (const resourceType in creep.store) {
            if (resourceType !== RESOURCE_ENERGY && creep.store[resourceType] > 0) {
                mineralType = resourceType;
                break;
            }
        }

        if (mineralType) {
            // Use cached storage/terminal from room state instead of findClosestByPath
            let depositTarget = null;

            // Check storage first
            if (roomState.storage && roomState.storage.store.getFreeCapacity(mineralType) > 0) {
                depositTarget = roomState.storage;
            } else if (roomState.terminal && roomState.terminal.store.getFreeCapacity(mineralType) > 0) {
                depositTarget = roomState.terminal;
            }

            if (depositTarget) {
                creep.say('💎 deposit');
                if (creep.transfer(depositTarget, mineralType) === ERR_NOT_IN_RANGE) {
                    smartMove(creep, depositTarget);
                }
                return;
            } else {
                creep.say('⚠️ full!');
                return;
            }
        }

        // --- VALIDATE OR PICK ASSIGNMENT ---
        // 1. Improved object validation
        if (creep.memory.assignment) {
            const a = creep.memory.assignment;
            const task = tasks.find(t => t.id === a.taskId && t.type === a.type);

            const srcObj = Game.getObjectById(a.taskId);
            const dstObj = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : srcObj;

            let shouldClearAssignment = false;

            if (!task || !srcObj) {
                shouldClearAssignment = true;
            } else if (a.transferTargetId && !dstObj) {
                shouldClearAssignment = true;
            } else if (dstObj && dstObj.store && typeof dstObj.store.getFreeCapacity === 'function') {
                const dstObjFull = dstObj.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
                if (dstObjFull && !['link_drain', 'materials_drain_energy', 'materials_empty'].includes(a.type)) {
                    shouldClearAssignment = true;
                }
            }

            if (shouldClearAssignment) {
                if (a.taskId) roomState.assigned[a.taskId] = (roomState.assigned[a.taskId] || 1) - 1;
                creep.memory.assignment = null;
            }
        }

        // 2. Priority-tier-only task selection
        if (!creep.memory.assignment) {
            let bestTask = null;
            let bestNeed = -1;
            let bestDistance = Infinity;
            let bestPriority = null;

            for (const task of tasks) {
                const assigned = roomState.assigned[task.id] || 0;
                if (assigned >= task.maxAssign) continue;

                if (bestPriority === null) bestPriority = task.priority;
                if (task.priority > bestPriority) break; // only evaluate the top priority tier

                const need = task.need;
                const distance = creep.pos.getRangeTo(task.pos);

                if (need > bestNeed || (need === bestNeed && distance < bestDistance)) {
                    bestNeed = need;
                    bestDistance = distance;
                    bestTask = task;
                }
            }

            if (bestTask) {
                creep.memory.assignment = {
                    taskId: bestTask.id,
                    type: bestTask.type,
                    transferTargetId: bestTask.transferTargetId,
                    amount: bestTask.need
                };
                roomState.assigned[bestTask.id] = (roomState.assigned[bestTask.id] || 0) + 1;
                const isWithdraw = bestTask.type.indexOf('container') === 0 ||
                                   bestTask.type === 'link_drain' ||
                                   bestTask.type.indexOf('materials') === 0 ||
                                   bestTask.type === 'terminal_balance'; // treat terminal_balance as withdraw-from-source
                if (bestTask.type === 'materials_empty' && storeCache.energyUsed > 0) {
                    creep.memory.state = 'delivering_energy';
                } else {
                    creep.memory.state = isWithdraw || storeCache.energyUsed === 0 ? 'fetching' : 'delivering';
                }
            } else {
                // No tasks available - improved idling
                if (!creep.memory.nextCheckTick) {
                    creep.memory.nextCheckTick = Game.time + IDLE_DURATION;
                }
                if (Game.time < creep.memory.nextCheckTick) {
                    creep.say('💤 idle');
                    return;
                } else {
                    delete creep.memory.nextCheckTick;
                }
            }
        }

        // 3. Execute action
        if (creep.memory.assignment) {
            if (creep.memory.state === 'fetching' && storeCache.freeCapacity === 0) {
                creep.memory.state = 'delivering';
            }

            if (creep.memory.state === 'delivering' && storeCache.usedCapacity === 0) {
                if (creep.memory.assignment.taskId) roomState.assigned[creep.memory.assignment.taskId]--;
                creep.memory.assignment = null;
                return;
            }

            // Handle delivering energy for materials_empty task
            if (creep.memory.state === 'delivering_energy') {
                creep.say('⚡ drop energy');
                const target = roomState.storage;

                if (target && target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    const res = creep.transfer(target, RESOURCE_ENERGY);
                    if (res === ERR_NOT_IN_RANGE) {
                        smartMove(creep, target);
                    } else if (res === OK || res === ERR_FULL) {
                        creep.memory.state = 'fetching';
                    } else if (res !== OK) {
                        console.log(creep.name + ': Energy transfer failed with code ' + res + ' to ' + (target && target.id));
                        if (creep.memory.assignment.taskId) roomState.assigned[creep.memory.assignment.taskId]--;
                        creep.memory.assignment = null;
                    }
                } else {
                    creep.memory.state = 'fetching';
                }
                return;
            }

            if (creep.memory.state === 'fetching') {
                creep.say('🔄 fetch');
                const a = creep.memory.assignment;
                let source;

                if (a.type.indexOf('container') === 0 || a.type === 'link_drain' || a.type.indexOf('materials') === 0 || a.type === 'terminal_balance') {
                    source = Game.getObjectById(a.taskId);
                } else {
                    // Prefer Storage if it has energy
                    if (roomState.storage && roomState.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                        source = roomState.storage;
                    } else {
                        // Consider containers with energy (exclude controller-adjacent)
                        const energyContainers = roomState.containers.filter(c => {
                            const e = c.store.getUsedCapacity(RESOURCE_ENERGY);
                            if (e <= 0) return false;
                            if (roomState.controller && c.pos.getRangeTo(roomState.controller.pos) <= 2) return false;
                            return true;
                        });

                        if (energyContainers.length > 0) {
                            // 1) Prefer containers that can fill us in one go (closest among those)
                            const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
                            const canFill = energyContainers.filter(c => c.store.getUsedCapacity(RESOURCE_ENERGY) >= free);

                            if (canFill.length > 0) {
                                source = creep.pos.findClosestByRange(canFill);
                            } else {
                                // 2) Otherwise, pick by simple energy-per-distance heuristic
                                let best = null;
                                let bestScore = -Infinity;
                                for (const c of energyContainers) {
                                    const energy = c.store.getUsedCapacity(RESOURCE_ENERGY);
                                    const dist = Math.max(1, creep.pos.getRangeTo(c.pos));
                                    const score = energy / dist;
                                    if (score > bestScore) {
                                        bestScore = score;
                                        best = c;
                                    }
                                }
                                source = best || creep.pos.findClosestByRange(energyContainers);
                            }
                        }
                    }
                }

                if (source) {
                    let resType = RESOURCE_ENERGY, amt;
                    if (a.type === 'materials_empty') {
                        for (const r in source.store) {
                            if (r !== RESOURCE_ENERGY) { resType = r; break; }
                        }
                    } else if (a.type === 'link_drain' && a.amount) {
                        amt = Math.min(a.amount, creep.store.getFreeCapacity());
                    } else if (a.type === 'materials_drain_energy') {
                        resType = RESOURCE_ENERGY;
                    }

                    const withdrawResult = creep.withdraw(source, resType, amt);
                    if (withdrawResult === ERR_NOT_IN_RANGE) {
                        smartMove(creep, source);
                    } else if (withdrawResult !== OK && withdrawResult !== ERR_FULL) {
                        console.log(creep.name + ': Withdraw failed with code ' + withdrawResult + ' from ' + (source && source.id));
                        if (a.taskId) roomState.assigned[a.taskId]--;
                        creep.memory.assignment = null;
                    }
                } else {
                    if (a.taskId) roomState.assigned[a.taskId]--;
                    creep.memory.assignment = null;
                }
            } else if (creep.memory.state === 'delivering') {
                creep.say('🚚 deliver');
                const a = creep.memory.assignment;

                const targetId = a.transferTargetId || a.taskId;
                const target = Game.getObjectById(targetId);

                if (target) {
                    let resType = RESOURCE_ENERGY, amt;
                    if (a.type === 'materials_empty') {
                        for (const r in creep.store) {
                            if (r !== RESOURCE_ENERGY && creep.store[r] > 0) { resType = r; break; }
                        }
                    } else if (a.type === 'link_fill' && a.amount) {
                        amt = Math.min(a.amount, creep.store.getUsedCapacity(RESOURCE_ENERGY));
                    }

                    const res = creep.transfer(target, resType, amt);
                    if (res === ERR_NOT_IN_RANGE) {
                        smartMove(creep, target);
                    } else if (res === OK || res === ERR_FULL) {
                        if (a.taskId) roomState.assigned[a.taskId]--;
                        creep.memory.assignment = null;
                    } else if (res !== OK) {
                        console.log(creep.name + ': Transfer failed with code ' + res + ' to ' + (target && target.id));
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
            const tasks = roomState.tasks;
            tasks.forEach(t => {
                let supNames = assignmentMap[t.id] || [];
                let source = 'auto', dest = '---';
                if (['container_balance', 'link_fill', 'link_drain', 'materials_drain_energy', 'materials_empty', 'terminal_balance'].includes(t.type)) {
                    let srcObj = Game.getObjectById(t.id);
                    let dstObj = Game.getObjectById(t.transferTargetId);
                    source = srcObj ? srcObj.structureType.substring(0, 4) + ':' + t.id.slice(-4) : 'ERR';
                    dest = dstObj ? dstObj.structureType.substring(0, 4) + ':' + t.transferTargetId.slice(-4) : 'ERR';
                } else if (t.sourceId) {
                    let srcObj = Game.getObjectById(t.sourceId);
                    source = srcObj ? (srcObj.structureType === STRUCTURE_STORAGE ? 'stor' : 'cont:' + t.sourceId.slice(-4)) : 'ERR';
                    dest = t.id.slice(-4);
                } else if (['container_empty', 'container_drain'].includes(t.type)) {
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
                    pos: (t.pos.x + ',' + t.pos.y).padEnd(4),
                    need: String(t.need).padEnd(4),
                    assigned: ((supNames.length + '/' + t.maxAssign)).padEnd(7),
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
                    assigned: ((idle.length + '/∞')).padEnd(7),
                    suppliers: idle.join(',').padEnd(19),
                    source: 'none'.padEnd(9),
                    destination: '---'.padEnd(11)
                });
            }
            if (rows.length) {
                console.log('\n🚚 SUPPLIER TASKS - ' + creep.room.name + ' (Tick ' + Game.time + ')');
                console.log('┌──────────────────────┬────────┬──────┬──────┬─────────┬─────────────────────┬───────────┬─────────────┐');
                console.log('│ Type                 │ ID     │ Pos  │ Need │ Assign  │ Suppliers           │ Source    │ Destination │');
                console.log('├──────────────────────┼────────┼──────┼──────┼─────────┼─────────────────────┼───────────┴─────────────┤');
                rows.forEach(r => {
                    console.log('│ ' + r.type + ' │ ' + r.id + ' │ ' + r.pos + ' │ ' + r.need + ' │ ' + r.assigned + ' │ ' + r.suppliers + ' │ ' + r.source + ' │ ' + r.destination + ' │');
                });
                console.log('└──────────────────────┴────────┴──────┴──────┴─────────┴─────────────────────┴───────────┴─────────────┘');
            } else {
                console.log('🚚 ' + creep.room.name + ': No supplier tasks available');
            }
        }
    }
};

module.exports = roleSupplier;
