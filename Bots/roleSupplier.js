// roleSupplier.js
// Purpose: Supplier role using cached room view from getRoomState.js to reduce CPU.
// OPTIMIZATIONS APPLIED:
// - "True Idle": Sleeps efficiently ONLY if room is truly empty (no avoids active).
// - Native Search: Uses findClosestByRange (C++) instead of Array.sort (JS).
// - Labeled breaks/continues: For clean nested loop exits without flag variables.
// - Lookup tables: Pre-computed type checks at module load (O(1) vs switch).
// - Assignment caching: Per-tick cache of supplier assignments.
// - Distance pre-computation: Avoid getRangeTo in sort comparators.
// - Object.keys(): Faster than for...in for store iteration.
// - Global priority order: Cached once per tick instead of per-room memory.

const SUPPLIER_ENABLED = true;
const SUPPLIER_DEBUG = false;
const SUPPLIER_IDLE_TICKS = 16;
const LINK_FILL_THRESHOLD = 200;
const LINK_DRAIN_THRESHOLD = 600;
const DONOR_DRAIN_THRESHOLD = 200;
const POWER_SPAWN_FILL_THRESHOLD = 1000;
const ASSIGNMENT_TTL = 75;
const NO_PATH_DELIVER_TTL = 6;
const AVOID_PAIR_TTL = 5;

const getRoomState = require("getRoomState");
const terminalManager = require("terminalManager");

// --- PRE-COMPUTED LOOKUP TABLES (runs once at module load) ---
const WITHDRAW_TYPES = {
    "container_empty": true,
    "container_drain": true,
    "materials_drain_energy": true,
    "materials_empty": true,
    "link_drain": true,
    "link_fill": true,
    "terminal_balance": true
};

const CONTAINER_TYPES = {
    "container_empty": true,
    "container_drain": true,
    "materials_drain_energy": true,
    "materials_empty": true
};

const TASK_PRIORITY = {
    "spawn": 10,
    "extension": 10,
    "tower": 30,
    "power_spawn_fill": 37,
    "link_drain": 29,
    "link_fill": 36,
    "container_empty": 40,
    "materials_drain_energy": 45,
    "container_drain": 50,
    "materials_empty": 55,
    "terminal_balance": 60,
    "idle": 100
};

const ALL_TASKS = [
    "spawn", "extension", "tower", "power_spawn_fill",
    "link_drain", "link_fill", "container_empty",
    "materials_drain_energy", "container_drain", "materials_empty",
    "terminal_balance", "idle"
];

// --- HELPER FUNCTIONS ---
function isWithdrawType(type) {
    return type ? WITHDRAW_TYPES[type] === true : false;
}

function doTransfer(creep, target, resourceType, amount) {
    return amount != null ? creep.transfer(target, resourceType, amount) : creep.transfer(target, resourceType);
}

function doWithdraw(creep, target, resourceType, amount) {
    return amount != null ? creep.withdraw(target, resourceType, amount) : creep.withdraw(target, resourceType);
}

function getCreepEnergyCapacity(creep) {
    var cap = creep.store.getCapacity(RESOURCE_ENERGY);
    if (cap == null) cap = creep.store.getCapacity();
    if (cap == null) cap = creep.store.getFreeCapacity() + creep.store.getUsedCapacity();
    return cap || 0;
}

// --- AVOID-PAIR HELPERS ---
function pruneAvoidPairs(creep) {
    if (!creep.memory.avoidPairs) return;
    var arr = creep.memory.avoidPairs;
    var kept = [];
    for (var i = 0; i < arr.length; i++) {
        if (Game.time <= arr[i].until) kept.push(arr[i]);
    }
    creep.memory.avoidPairs = kept;
}

function addAvoidPair(creep, assignment, ttl) {
    if (!assignment || !assignment.type || !assignment.taskId) return;
    if (!creep.memory.avoidPairs) creep.memory.avoidPairs = [];
    creep.memory.avoidPairs.push({
        type: assignment.type,
        taskId: assignment.taskId,
        transferTargetId: assignment.transferTargetId || assignment.taskId,
        until: Game.time + (ttl || 1)
    });
}

function isPairAvoided(creep, type, taskId, transferTargetId) {
    var arr = creep.memory.avoidPairs;
    if (!arr || !arr.length) return false;
    var tt = transferTargetId || taskId;
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (Game.time > it.until) continue;
        if (it.type !== type) continue;
        if (it.taskId !== taskId) continue;
        var itt = it.transferTargetId || it.taskId;
        if (itt !== tt) continue;
        return true;
    }
    return false;
}

function matchesAvoid(avoid, type, taskId, transferTargetId) {
    if (!avoid) return false;
    if (avoid.type !== type) return false;
    var at = avoid.transferTargetId || avoid.taskId;
    var tt = transferTargetId || taskId;
    return avoid.taskId === taskId && at === tt;
}

// --- ASSIGNMENT MANAGEMENT ---
function clearAssignment(creep, opts) {
    opts = opts || {};
    var a = creep.memory.assignment;

    if ((opts.justCompleted || opts.avoid) && a && a.type && a.taskId) {
        creep.memory.lastCompletedTick = Game.time;
        creep.memory.lastCompletedType = a.type;
        creep.memory.lastCompletedTaskId = a.taskId;
        creep.memory.lastCompletedTargetId = a.transferTargetId || a.taskId;
        addAvoidPair(creep, a, AVOID_PAIR_TTL);
    }

    creep.memory.assignment = null;
    delete creep.memory.noPathDeliver;
    delete creep.memory.nextCheckTick;
    delete creep.memory.extOpportunistic;
    delete creep.memory.sleepUntil;

    if (SUPPLIER_DEBUG && opts && opts.reason) {
        console.log("[SUP] " + creep.name + " clearAssignment (" + opts.reason + ") t=" + Game.time);
    }
}

// --- MOVEMENT ---
function smartMove(creep, target, extraOpts) {
    if (creep.fatigue > 0) return ERR_TIRED;
    if (creep.memory.lastTriedMoveTick === Game.time) return ERR_BUSY;

    var targetPos = target.pos || target;
    var dist = creep.pos.getRangeTo(targetPos);
    var maxOps = Math.min(2000, Math.max(200, dist * 50));
    var inReroute = Game.time < (creep.memory.rerouteUntil || 0);

    var moveOpts = {
        reusePath: inReroute ? 0 : Math.min(10, Math.max(3, Math.floor(dist / 2))),
        maxOps: maxOps,
        heuristicWeight: 1.2
    };
    if (extraOpts) {
        for (var k in extraOpts) moveOpts[k] = extraOpts[k];
    }

    creep.memory.lastTriedMoveTick = Game.time;
    var res = creep.moveTo(targetPos, moveOpts);

    if (res === ERR_NO_PATH && !inReroute) {
        creep.memory.rerouteUntil = Game.time + 3;
        if (creep.memory._move) delete creep.memory._move;
    }
    return res;
}

// --- ROOM STATE HELPERS ---
function ensureGetRoomStateInit() {
    if (getRoomState && typeof getRoomState.init === "function") {
        if (global.__supplierLastRoomStateInitTick !== Game.time) {
            getRoomState.init();
            global.__supplierLastRoomStateInitTick = Game.time;
        }
    }
}

function getRoomView(room) {
    ensureGetRoomStateInit();
    var base = getRoomState.get(room.name);
    if (!base) return null;

    var structuresByType = base.structuresByType || {};
    return {
        roomName: room.name,
        controller: room.controller,
        storage: room.storage,
        terminal: room.terminal,
        containers: structuresByType[STRUCTURE_CONTAINER] || [],
        spawns: (structuresByType[STRUCTURE_SPAWN] || []).filter(function(s) { return s.my; }),
        extractors: (structuresByType[STRUCTURE_EXTRACTOR] || []).filter(function(e) { return e.my; }),
        sources: base.sources || [],
        towers: (structuresByType[STRUCTURE_TOWER] || []).filter(function(t) { return t.my; }),
        links: (structuresByType[STRUCTURE_LINK] || []).filter(function(l) { return l.my; }),
        extensions: (structuresByType[STRUCTURE_EXTENSION] || []).filter(function(e) { return e.my; }),
        powerSpawns: (structuresByType[STRUCTURE_POWER_SPAWN] || []).filter(function(s) { return s.my; }),
        nukers: (structuresByType[STRUCTURE_NUKER] || []).filter(function(n) { return n.my; }),
        suppliers: (base.myCreeps || []).filter(function(c) { return c.memory && c.memory.role === "supplier"; })
    };
}

// --- CONTAINER LABELING ---
function ensureContainerLabels(room, view) {
    if (!view) return;
    var mem = room.memory;
    if (!mem.containerLabels) mem.containerLabels = {};

    var ids = view.containers.map(function(c) { return c.id; }).sort().join(',');
    if (mem.containerLabelIds !== ids || Game.time % 1000 === 0) {
        var labels = {};
        for (var i = 0; i < view.containers.length; i++) {
            var c = view.containers[i];
            if (c.pos.findInRange(view.extractors, 1).length > 0) {
                labels[c.id] = "materials";
            } else if (view.controller && c.pos.getRangeTo(view.controller.pos) <= 2) {
                labels[c.id] = "recipient";
            } else if (c.pos.findInRange(view.sources, 4).length > 0) {
                labels[c.id] = "donor";
            } else {
                labels[c.id] = "recipient";
            }
        }
        mem.containerLabels = labels;
        mem.containerLabelIds = ids;
    }
}

function getContainerBuckets(room, view) {
    ensureContainerLabels(room, view);
    var labels = room.memory.containerLabels || {};
    var donors = [], recipients = [], materials = [];

    for (var i = 0; i < view.containers.length; i++) {
        var c = view.containers[i];
        var label = labels[c.id];
        if (label === "donor") donors.push(c);
        else if (label === "materials") materials.push(c);
        else recipients.push(c);
    }
    return { donors: donors, recipients: recipients, materials: materials };
}

// --- PRIORITY ORDER (Global cache instead of per-room memory) ---
function getPriorityOrder(room) {
    // Check for per-room custom priorities first
    var customMapping = room.memory.supplierPriorities;
    
    // If no custom mapping, use global cache
    if (!customMapping || Object.keys(customMapping).length === 0) {
        if (global.__supplierPriorityOrder && 
            global.__supplierPriorityOrderTick === Game.time) {
            return global.__supplierPriorityOrder;
        }
        
        var list = ALL_TASKS.slice();
        list.sort(function(a, b) {
            return TASK_PRIORITY[a] - TASK_PRIORITY[b];
        });
        
        global.__supplierPriorityOrder = list;
        global.__supplierPriorityOrderTick = Game.time;
        return list;
    }
    
    // Room has custom priorities - compute for this room (rare case)
    var list = ALL_TASKS.slice();
    list.sort(function(a, b) {
        var pa = customMapping[a] != null ? customMapping[a] : TASK_PRIORITY[a];
        var pb = customMapping[b] != null ? customMapping[b] : TASK_PRIORITY[b];
        return pa - pb;
    });
    return list;
}

// --- CACHED SUPPLIER ASSIGNMENT LOOKUP (per-tick) ---
function getSupplierAssignmentCache(view) {
    if (global.__supplierAssignmentCacheTick !== Game.time) {
        global.__supplierAssignmentCacheTick = Game.time;
        global.__supplierAssignmentCache = {};
    }

    var cacheKey = view.roomName;
    if (!global.__supplierAssignmentCache[cacheKey]) {
        var assignments = {};
        for (var i = 0; i < view.suppliers.length; i++) {
            var s = view.suppliers[i];
            var a = s.memory && s.memory.assignment;
            if (a && a.type && a.taskId) {
                // Nested structure: type -> taskId -> transferTargetId -> creepName
                if (!assignments[a.type]) assignments[a.type] = {};
                if (!assignments[a.type][a.taskId]) assignments[a.type][a.taskId] = {};
                assignments[a.type][a.taskId][a.transferTargetId || '_'] = s.name;
            }
        }
        global.__supplierAssignmentCache[cacheKey] = assignments;
    }
    return global.__supplierAssignmentCache[cacheKey];
}

function isTakenByOtherSupplier(view, creep, type, taskId, transferTargetId) {
    var cache = getSupplierAssignmentCache(view);
    var typeCache = cache[type];
    if (!typeCache) return false;
    var taskCache = typeCache[taskId];
    if (!taskCache) return false;
    var owner = taskCache[transferTargetId || '_'];
    return owner && owner !== creep.name;
}

// --- UTILITY ---
function pickBestByNeedThenDistance(structs, getNeedFn, creep) {
    var best = null, bestNeed = -1, bestDist = Infinity;
    for (var i = 0; i < structs.length; i++) {
        var s = structs[i];
        var need = getNeedFn(s);
        if (need <= 0) continue;
        var dist = creep.pos.getRangeTo(s.pos);
        if (need > bestNeed || (need === bestNeed && dist < bestDist)) {
            best = s;
            bestNeed = need;
            bestDist = dist;
        }
    }
    return { target: best, need: bestNeed };
}

// --- CACHED EXTENSION LIST ---
function getCachedExtensionList(view) {
    if (global.__supplierExtensionCacheTick !== Game.time) {
        global.__supplierExtensionCacheTick = Game.time;
        global.__supplierExtensionCache = {};
    }

    var cacheKey = view.roomName;
    if (!global.__supplierExtensionCache[cacheKey]) {
        var list = view.extensions || [];
        var validExtensions = [];
        for (var i = 0; i < list.length; i++) {
            var ext = list[i];
            if (!ext.my) continue;
            var freeCapacity = ext.store.getFreeCapacity(RESOURCE_ENERGY);
            if (freeCapacity <= 0) continue;
            validExtensions.push({ id: ext.id, pos: ext.pos, freeCapacity: freeCapacity });
        }
        global.__supplierExtensionCache[cacheKey] = validExtensions;
    }
    return global.__supplierExtensionCache[cacheKey];
}

// --- TASK FINDERS ---
function findSpawnFill(view, creep, avoid) {
    var candidates = [];
    for (var i = 0; i < view.spawns.length; i++) {
        var s = view.spawns[i];
        if (!s.my) continue;
        if (s.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue;
        if (matchesAvoid(avoid, "spawn", s.id, s.id)) continue;
        candidates.push(s);
    }
    if (candidates.length === 0) return null;

    var pick = pickBestByNeedThenDistance(candidates, function(s) {
        return s.store.getFreeCapacity(RESOURCE_ENERGY);
    }, creep);

    if (!pick.target) return null;
    return { type: "spawn", taskId: pick.target.id, amount: pick.need };
}

function findExtensionFill(view, creep, avoid) {
    var cachedList = getCachedExtensionList(view);
    if (cachedList.length === 0) return null;

    var candidates = [];
    for (var i = 0; i < cachedList.length; i++) {
        var extData = cachedList[i];
        if (matchesAvoid(avoid, "extension", extData.id, extData.id)) continue;
        if (isTakenByOtherSupplier(view, creep, "extension", extData.id, extData.id)) continue;

        var obj = Game.getObjectById(extData.id);
        if (obj && obj.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            candidates.push(obj);
        }
    }
    if (candidates.length === 0) return null;

    // CPU WIN: Native search (C++) is much faster than JS sort
    var best = creep.pos.findClosestByRange(candidates);
    if (!best) return null;

    return {
        type: "extension",
        taskId: best.id,
        amount: best.store.getFreeCapacity(RESOURCE_ENERGY)
    };
}

function findTowerFill(view, creep, avoid) {
    var candidates = [];
    for (var i = 0; i < view.towers.length; i++) {
        var t = view.towers[i];
        if (!t.my) continue;
        var free = t.store.getFreeCapacity(RESOURCE_ENERGY);
        var ratio = (t.store[RESOURCE_ENERGY] || 0) / t.store.getCapacity(RESOURCE_ENERGY);
        if (free <= 0 || ratio >= 0.75) continue;
        if (matchesAvoid(avoid, "tower", t.id, t.id)) continue;
        candidates.push(t);
    }
    if (candidates.length === 0) return null;

    var pick = pickBestByNeedThenDistance(candidates, function(t) {
        return t.store.getFreeCapacity(RESOURCE_ENERGY);
    }, creep);

    if (!pick.target) return null;
    return { type: "tower", taskId: pick.target.id, amount: pick.need };
}

function findPowerSpawnFill(view, creep, avoid) {
    var candidates = [];
    for (var i = 0; i < view.powerSpawns.length; i++) {
        var ps = view.powerSpawns[i];
        var used = ps.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (used <= POWER_SPAWN_FILL_THRESHOLD) {
            if (matchesAvoid(avoid, "power_spawn_fill", ps.id, ps.id)) continue;
            candidates.push(ps);
        }
    }
    if (candidates.length === 0) return null;

    var pick = pickBestByNeedThenDistance(candidates, function(ps) {
        return ps.store.getFreeCapacity(RESOURCE_ENERGY);
    }, creep);

    if (!pick.target) return null;
    return { type: "power_spawn_fill", taskId: pick.target.id, amount: pick.need };
}

// OPTIMIZED: Uses labeled continue to skip source-adjacent links cleanly
function findLinkFill(view, creep, avoid) {
    if (!view.storage) return null;
    var storage = view.storage;
    var storageEnergy = storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (storageEnergy < 500) return null;

    var list = view.links;

    // LABELED LOOP: Clean exit when link is near a source
    linkLoop: for (var i = 0; i < list.length; i++) {
        var link = list[i];
        if (!link.my) continue;
        if (!link.pos.inRangeTo(storage.pos, 2)) continue;
        if (view.controller && link.pos.getRangeTo(view.controller.pos) <= 2) continue;

        // Check if link is near any source - use labeled continue for clean exit
        for (var s = 0; s < view.sources.length; s++) {
            if (view.sources[s].pos.getRangeTo(link.pos) <= 2) {
                continue linkLoop; // Skip directly to next link
            }
        }

        var linkEnergy = link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (linkEnergy < LINK_FILL_THRESHOLD) {
            if (matchesAvoid(avoid, "link_fill", storage.id, link.id)) continue;

            var maxFillAmount = Math.min(
                LINK_DRAIN_THRESHOLD - linkEnergy,
                storageEnergy,
                link.store.getFreeCapacity(RESOURCE_ENERGY)
            );

            if (maxFillAmount > 100) {
                return {
                    type: "link_fill",
                    taskId: storage.id,
                    transferTargetId: link.id,
                    amount: maxFillAmount
                };
            }
        }
    }
    return null;
}

// OPTIMIZED: Uses labeled continue for source-adjacent link check
function findLinkDrain(view, creep, avoid) {
    if (!view.storage) return null;
    var storage = view.storage;
    var storageFree = storage.store.getFreeCapacity(RESOURCE_ENERGY);
    if (storageFree <= 0) return null;

    var list = view.links;

    // LABELED LOOP: Clean exit when link is near a source
    linkLoop: for (var i = 0; i < list.length; i++) {
        var link = list[i];
        if (!link.my) continue;
        if (!link.pos.inRangeTo(storage.pos, 2)) continue;
        if (view.controller && link.pos.getRangeTo(view.controller.pos) <= 2) continue;

        // Check source proximity with labeled continue
        for (var s = 0; s < view.sources.length; s++) {
            if (view.sources[s].pos.getRangeTo(link.pos) <= 2) {
                continue linkLoop;
            }
        }

        var linkEnergy = link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (linkEnergy > LINK_DRAIN_THRESHOLD) {
            if (matchesAvoid(avoid, "link_drain", link.id, storage.id)) continue;
            var amount = Math.min(linkEnergy - LINK_FILL_THRESHOLD, storageFree);
            if (amount > 0) {
                return {
                    type: "link_drain",
                    taskId: link.id,
                    transferTargetId: storage.id,
                    amount: amount
                };
            }
        }
    }
    return null;
}

function findMaterialsDrainEnergy(room, view, creep, avoid) {
    var buckets = getContainerBuckets(room, view);
    var mats = buckets.materials;
    if (!mats || mats.length === 0) return null;

    var best = null;
    var most = 0;
    for (var i = 0; i < mats.length; i++) {
        var c = mats[i];
        var e = c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (e <= 0) continue;

        var drainTarget = null;
        if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            drainTarget = view.storage;
        } else {
            for (var ti = 0; ti < view.towers.length; ti++) {
                var t = view.towers[ti];
                if (t.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    drainTarget = t;
                    break;
                }
            }
        }
        if (!drainTarget) break;

        if (matchesAvoid(avoid, "materials_drain_energy", c.id, drainTarget.id)) continue;
        if (e > most) {
            most = e;
            best = { cont: c, tgt: drainTarget };
        }
    }
    if (!best) return null;
    return {
        type: "materials_drain_energy",
        taskId: best.cont.id,
        transferTargetId: best.tgt.id,
        amount: most
    };
}

// OPTIMIZED: Uses labeled continue and Object.keys for store iteration
function findMaterialsEmpty(room, view, creep, avoid) {
    var buckets = getContainerBuckets(room, view);
    var mats = buckets.materials;
    if (!mats || mats.length === 0) return null;

    // LABELED LOOP for clean multi-level continue
    matLoop: for (var i = 0; i < mats.length; i++) {
        var mc = mats[i];
        var totalUsed = mc.store.getUsedCapacity() || 0;
        var energyUsed = mc.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var totalMinerals = totalUsed - energyUsed;
        if (totalMinerals < 1000) continue;

        var target = null;
        // Object.keys is faster than for...in
        var storeKeys = Object.keys(mc.store);

        // Check storage first
        if (view.storage) {
            for (var ki = 0; ki < storeKeys.length; ki++) {
                var r = storeKeys[ki];
                if (r !== RESOURCE_ENERGY && (mc.store[r] || 0) > 0 && view.storage.store.getFreeCapacity(r) > 0) {
                    target = view.storage;
                    break;
                }
            }
        }

        // Check terminal if no storage target
        if (!target && view.terminal) {
            for (var ki2 = 0; ki2 < storeKeys.length; ki2++) {
                var r2 = storeKeys[ki2];
                if (r2 !== RESOURCE_ENERGY && (mc.store[r2] || 0) > 0 && view.terminal.store.getFreeCapacity(r2) > 0) {
                    target = view.terminal;
                    break;
                }
            }
        }

        if (!target) continue matLoop;
        if (matchesAvoid(avoid, "materials_empty", mc.id, target.id)) continue matLoop;

        return {
            type: "materials_empty",
            taskId: mc.id,
            transferTargetId: target.id,
            amount: totalMinerals,
            minCapacityRequired: Math.ceil(totalMinerals * 0.5)
        };
    }
    return null;
}

// OPTIMIZED: Pre-compute distances before sorting to avoid repeated getRangeTo in comparator
function findContainerDrain(room, view, creep, avoid) {
    var buckets = getContainerBuckets(room, view);
    var donors = buckets.donors || [];
    if (donors.length === 0) return null;

    var creepCapacity = getCreepEnergyCapacity(creep);

    // Pre-compute energy and distance for each donor (avoids O(n log n) getRangeTo calls)
    var donorData = [];
    for (var i = 0; i < donors.length; i++) {
        var d = donors[i];
        donorData.push({
            container: d,
            energy: d.store.getUsedCapacity(RESOURCE_ENERGY) || 0,
            dist: creep.pos.getRangeTo(d.pos)
        });
    }

    // Sort using pre-computed values
    donorData.sort(function(a, b) {
        if (a.energy !== b.energy) return b.energy - a.energy;
        return a.dist - b.dist;
    });

    var labels = room.memory.containerLabels || {};

    for (var di = 0; di < donorData.length; di++) {
        var data = donorData[di];
        var d = data.container;
        var e = data.energy;

        var minRequired = Math.max(DONOR_DRAIN_THRESHOLD, creepCapacity || 0);
        if (e < minRequired) continue;

        var targets = [];
        if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            targets.push({
                target: view.storage,
                priority: 1,
                free: view.storage.store.getFreeCapacity(RESOURCE_ENERGY)
            });
        }

        for (var j = 0; j < view.containers.length; j++) {
            var tgt = view.containers[j];
            if (tgt.id === d.id) continue;
            var label = labels[tgt.id];
            if (label === "materials" || label === "donor") continue;
            var free = tgt.store.getFreeCapacity(RESOURCE_ENERGY);
            if (free > 0) {
                targets.push({ target: tgt, priority: 2, free: free });
            }
        }

        targets.sort(function(a, b) {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return b.free - a.free;
        });

        for (var k = 0; k < targets.length; k++) {
            var t = targets[k].target;
            if (matchesAvoid(avoid, "container_drain", d.id, t.id)) continue;

            return {
                type: "container_drain",
                taskId: d.id,
                transferTargetId: t.id,
                amount: Math.min(e, t.store.getFreeCapacity(RESOURCE_ENERGY)),
                minDrainEnergy: creepCapacity
            };
        }
    }
    return null;
}

function findContainerEmpty(room, view, creep, avoid) {
    if (!view.storage) return null;
    var storage = view.storage;
    if (storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;

    var labels = room.memory.containerLabels || {};
    var candidates = [];

    for (var i = 0; i < view.containers.length; i++) {
        var c = view.containers[i];
        var l = labels[c.id];
        if (l === "materials") continue;
        if (l === "donor" && (c.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= DONOR_DRAIN_THRESHOLD) continue;

        var e = c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (e <= 0) continue;
        if (matchesAvoid(avoid, "container_empty", c.id, storage.id)) continue;

        candidates.push(c);
    }
    if (candidates.length === 0) return null;

    // CPU WIN: Native search is faster
    var best = creep.pos.findClosestByRange(candidates);
    if (!best) return null;

    return {
        type: "container_empty",
        taskId: best.id,
        transferTargetId: storage.id,
        amount: best.store.getUsedCapacity(RESOURCE_ENERGY)
    };
}

function findTerminalBalance(view, creep, avoid) {
    if (!view.storage || !view.terminal) return null;

    var term = view.terminal;
    var stor = view.storage;
    var TARGET = 20000;
    var MIN = 19500;
    var MAX = 20500;

    var termEnergy = term.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

    var roomBusy = false;
    if (terminalManager && typeof terminalManager.isRoomBusyWithTransfer === "function") {
        roomBusy = terminalManager.isRoomBusyWithTransfer(view.roomName);
    }
    if (roomBusy && termEnergy > MAX) return null;

    if (termEnergy > MAX && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        if (matchesAvoid(avoid, "terminal_balance", term.id, stor.id)) return null;
        var amountOut = Math.min(termEnergy - TARGET, stor.store.getFreeCapacity(RESOURCE_ENERGY));
        if (amountOut > 0) {
            return {
                type: "terminal_balance",
                taskId: term.id,
                transferTargetId: stor.id,
                amount: amountOut
            };
        }
    }

    if (termEnergy < MIN && stor.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (matchesAvoid(avoid, "terminal_balance", stor.id, term.id)) return null;
        var amountIn = Math.min(
            TARGET - termEnergy,
            stor.store.getUsedCapacity(RESOURCE_ENERGY),
            term.store.getFreeCapacity(RESOURCE_ENERGY)
        );
        if (amountIn > 0) {
            return {
                type: "terminal_balance",
                taskId: stor.id,
                transferTargetId: term.id,
                amount: amountIn
            };
        }
    }
    return null;
}

function findIdle() {
    return { type: "idle", taskId: "idle_sleep", amount: 0 };
}

function findTaskForType(room, view, creep, type, avoid, labelsComputed) {
    // Lazy container label computation
    if (CONTAINER_TYPES[type] && !labelsComputed.done) {
        ensureContainerLabels(room, view);
        labelsComputed.done = true;
    }

    var task = null;
    if (type === "idle") task = findIdle();
    else if (type === "spawn") task = findSpawnFill(view, creep, avoid);
    else if (type === "extension") task = findExtensionFill(view, creep, avoid);
    else if (type === "tower") task = findTowerFill(view, creep, avoid);
    else if (type === "power_spawn_fill") task = findPowerSpawnFill(view, creep, avoid);
    else if (type === "link_fill") task = findLinkFill(view, creep, avoid);
    else if (type === "link_drain") task = findLinkDrain(view, creep, avoid);
    else if (type === "materials_drain_energy") task = findMaterialsDrainEnergy(room, view, creep, avoid);
    else if (type === "materials_empty") task = findMaterialsEmpty(room, view, creep, avoid);
    else if (type === "container_drain") task = findContainerDrain(room, view, creep, avoid);
    else if (type === "container_empty") task = findContainerEmpty(room, view, creep, avoid);
    else if (type === "terminal_balance") task = findTerminalBalance(view, creep, avoid);

    if (!task || type === "idle") return task;

    if (isTakenByOtherSupplier(view, creep, task.type, task.taskId, task.transferTargetId)) return null;
    if (isPairAvoided(creep, task.type, task.taskId, task.transferTargetId)) return null;

    return task;
}

// --- VALIDATION ---
function validateAssignment(creep, view, a) {
    if (!a || !a.type || !a.taskId) return false;
    if (a.type === "idle") return true;

    var srcObj = Game.getObjectById(a.taskId);
    var dstObj = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : srcObj;

    if (!srcObj) return false;
    if (a.transferTargetId && !dstObj) return false;

    var withdrawKind = isWithdrawType(a.type);

    if (!withdrawKind) {
        if (!dstObj || !dstObj.store || typeof dstObj.store.getFreeCapacity !== "function") return false;
        if (a.type !== "materials_empty" && a.type !== "fallback_dump") {
            if (dstObj.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return false;
        }
        if ((a.type === "spawn" || a.type === "extension" || a.type === "tower" || a.type === "power_spawn_fill") && !dstObj.my) {
            return false;
        }
        if (a.type === "fallback_dump" && dstObj.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return false;
    }

    if (withdrawKind) {
        if (a.type === "materials_empty") {
            var totalUsedME = srcObj.store.getUsedCapacity() || 0;
            var energyUsedME = srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            if (totalUsedME - energyUsedME < 1000) return false;
        } else if (a.type === "link_drain") {
            var linkEnergy = srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            if (linkEnergy <= LINK_FILL_THRESHOLD) return false;
            if (!dstObj || dstObj.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return false;
        } else if (a.type === "link_fill") {
            if (!dstObj || !dstObj.my) return false;
            var cap = dstObj.store.getCapacity(RESOURCE_ENERGY);
            var e2 = dstObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            var maxFillNow = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, cap) - e2);
            if (maxFillNow <= 0) return false;
            if ((srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < 100) return false;
        } else if (a.type === "terminal_balance") {
            if (!view.storage || !view.terminal) return false;
            var termEnergy = view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            if (a.taskId === view.terminal.id) {
                if (!(termEnergy > 20500 && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0)) return false;
            } else if (a.taskId === view.storage.id) {
                if (!(termEnergy < 19500 && view.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0)) return false;
            } else return false;
        } else if (a.type === "container_drain") {
            var availableDrain = srcObj.store && srcObj.store.getUsedCapacity
                ? (srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
            if (availableDrain <= 0) return false;
            if (a.minDrainEnergy != null && availableDrain < a.minDrainEnergy) return false;
        } else {
            var available = srcObj.store && srcObj.store.getUsedCapacity
                ? (srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
            if (available <= 0) return false;
        }
    }
    return true;
}

function isTaskComplete(view, a) {
    if (!a || !a.type || !a.taskId) return true;
    if (a.type === "idle") return false;

    var src = Game.getObjectById(a.taskId);
    var dst = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : src;

    if (!src) return true;

    if (a.type === "tower") {
        if (!dst || !dst.store) return true;
        var towerCapacity = dst.store.getCapacity(RESOURCE_ENERGY) || 0;
        if (towerCapacity === 0) return true;
        var towerEnergy = dst.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        return towerEnergy >= towerCapacity * 0.9;
    }

    if (a.type === "spawn" || a.type === "extension" || a.type === "power_spawn_fill" || a.type === "fallback_dump") {
        return !dst || !dst.store || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (a.type === "link_fill") {
        if (!dst || !dst.store) return true;
        var cap = dst.store.getCapacity(RESOURCE_ENERGY);
        var e = dst.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        return Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, cap) - e) <= 0;
    }

    if (a.type === "link_drain") {
        return !src.store || (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= LINK_FILL_THRESHOLD;
    }

    if (a.type === "container_drain" || a.type === "container_empty" || a.type === "materials_drain_energy") {
        if (!dst || !dst.store) return true;
        var srcE = src.store && src.store.getUsedCapacity ? (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        if (a.type === "container_drain" && a.minDrainEnergy != null && srcE < a.minDrainEnergy) return true;
        return srcE <= 0 || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (a.type === "materials_empty") {
        if (!src.store) return true;
        var totalUsedMEc = src.store.getUsedCapacity() || 0;
        var energyUsedMEc = src.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        return totalUsedMEc - energyUsedMEc < 1000;
    }

    if (a.type === "terminal_balance") {
        if (!view.storage || !view.terminal) return true;
        var teBal = view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (a.taskId === view.terminal.id) return teBal < 20500;
        if (a.taskId === view.storage.id) return teBal > 19500;
        return true;
    }

    return false;
}

// --- STEP ASIDE ---
function tryStepAside(creep) {
    var terrain = creep.room.getTerrain();
    var dirs = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

    // Shuffle directions
    for (var i = dirs.length - 1; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var tmp = dirs[i];
        dirs[i] = dirs[j];
        dirs[j] = tmp;
    }

    var dx = [0, 1, 1, 1, 0, -1, -1, -1];
    var dy = [-1, -1, 0, 1, 1, 1, 0, -1];

    for (var di = 0; di < dirs.length; di++) {
        var dir = dirs[di];
        var idx = dir - 1;
        var x = creep.pos.x + dx[idx];
        var y = creep.pos.y + dy[idx];

        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0) continue;

        var structsHere = creep.room.lookForAt(LOOK_STRUCTURES, x, y);
        var hasBlocker = false;
        for (var si = 0; si < structsHere.length; si++) {
            var s = structsHere[si];
            if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER) {
                hasBlocker = true;
                break;
            }
        }
        if (hasBlocker) continue;

        creep.memory.lastTriedMoveTick = Game.time;
        creep.move(dir);
        return true;
    }
    return false;
}

function findFallbackDumpTarget(view, creep) {
    if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return view.storage;
    if (view.terminal && view.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return view.terminal;

    var containersWithSpace = [];
    for (var i = 0; i < view.containers.length; i++) {
        var c = view.containers[i];
        if (c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) containersWithSpace.push(c);
    }
    return containersWithSpace.length > 0 ? creep.pos.findClosestByRange(containersWithSpace) : null;
}

function shouldStartDelivering(view, picked, storeCache) {
    if (!picked || !storeCache || (storeCache.energyUsed || 0) <= 0) return false;
    if (picked.type === "link_fill") return true;
    if (picked.type === "terminal_balance" && view.storage && picked.taskId === view.storage.id) return true;
    return false;
}

// --- ASSIGNMENT PICKER ---
function attemptPickAssignment(creep, view, storeCache) {
    if (creep.memory.assignment) return true;

    if (!storeCache) {
        storeCache = {
            freeCapacity: creep.store.getFreeCapacity(),
            usedCapacity: creep.store.getUsedCapacity(),
            energyUsed: creep.store.getUsedCapacity(RESOURCE_ENERGY)
        };
    }

    var typeOrder = getPriorityOrder(creep.room);

    var avoid = null;
    if (creep.memory.lastCompletedTick === Game.time && creep.memory.lastCompletedType && creep.memory.lastCompletedTaskId) {
        avoid = {
            type: creep.memory.lastCompletedType,
            taskId: creep.memory.lastCompletedTaskId,
            transferTargetId: creep.memory.lastCompletedTargetId
        };
    }

    var picked = null;
    var labelsComputed = { done: false };

    // Take FIRST valid task in strict priority order
    for (var oi = 0; oi < typeOrder.length; oi++) {
        var tType = typeOrder[oi];
        var avoidForType = (avoid && avoid.type === tType) ? avoid : null;
        var candidate = findTaskForType(creep.room, view, creep, tType, avoidForType, labelsComputed);
        if (candidate) {
            picked = candidate;
            break;
        }
    }

    // Fallback dump logic
    if (!picked || picked.type === "idle") {
        if (storeCache.energyUsed > 0) {
            var dumpTarget = findFallbackDumpTarget(view, creep);
            if (dumpTarget) {
                var avoidFallback = false;
                if (dumpTarget.id === (view.storage && view.storage.id)) {
                    if (creep.memory.lastCompletedType &&
                        (creep.memory.lastCompletedType === "link_drain" ||
                         creep.memory.lastCompletedType === "container_empty" ||
                         creep.memory.lastCompletedType === "materials_drain_energy")) {
                        avoidFallback = true;
                    }
                    if ((view.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 5000) {
                        avoidFallback = true;
                    }
                }

                if (!avoidFallback) {
                    creep.memory.assignment = {
                        taskId: dumpTarget.id,
                        type: "fallback_dump",
                        transferTargetId: dumpTarget.id,
                        amount: storeCache.energyUsed,
                        assignedTick: Game.time
                    };
                    creep.memory.state = "delivering";
                    creep.say("📦 dump");
                    return true;
                }
            }
        }
    }

    // Assign picked task
    if (picked) {
        creep.memory.assignment = {
            taskId: picked.taskId,
            type: picked.type,
            transferTargetId: picked.transferTargetId,
            amount: picked.amount,
            assignedTick: Game.time
        };
        if (picked.minDrainEnergy != null) creep.memory.assignment.minDrainEnergy = picked.minDrainEnergy;
        if (picked.minCapacityRequired != null) creep.memory.assignment.minCapacityRequired = picked.minCapacityRequired;
        if (creep.memory.nextCheckTick) delete creep.memory.nextCheckTick;

        // Handle idle
        if (picked.type === "idle") {
            creep.memory.state = "idle";
            var hasActiveAvoids = false;
            if (creep.memory.avoidPairs) {
                for (var aInd = 0; aInd < creep.memory.avoidPairs.length; aInd++) {
                    if (Game.time <= creep.memory.avoidPairs[aInd].until) {
                        hasActiveAvoids = true;
                        break;
                    }
                }
            }
            if (!hasActiveAvoids) {
                creep.memory.sleepUntil = Game.time + SUPPLIER_IDLE_TICKS;
                creep.say("💤");
            } else {
                creep.say("⏳");
            }
            return false;
        }

        // Set state based on task type
        if (picked.type === "materials_empty" && storeCache.energyUsed > 0) {
            creep.memory.state = "delivering_energy";
            creep.say("⚡ drop energy");
        } else {
            var withdrawTask = isWithdrawType(picked.type);
            if (withdrawTask) {
                if (shouldStartDelivering(view, picked, storeCache)) {
                    creep.memory.state = "delivering";
                    creep.say("🚚 deliver");
                } else {
                    creep.memory.state = "fetching";
                    creep.say("🔄 fetch");
                }
            } else {
                creep.memory.state = storeCache.energyUsed === 0 ? "fetching" : "delivering";
                creep.say(creep.memory.state === "fetching" ? "🔄 fetch" : "🚚 deliver");
            }
        }
        return true;
    }
    return false;
}

// ============================================
// MAIN RUN FUNCTION
// ============================================
const roleSupplier = {
    run: function(creep) {
        if (!SUPPLIER_ENABLED) {
            if (Game.time % 5 === 0) creep.say("Disabled");
            return;
        }

        // --- IDLE SLEEP GATE (CPU SAVER) ---
        if (creep.memory.assignment && creep.memory.assignment.type === "idle") {
            if (creep.memory.sleepUntil && Game.time < creep.memory.sleepUntil) {
                return; // Near 0 CPU cost
            }
            creep.memory.assignment = null;
            delete creep.memory.sleepUntil;
        }

        // --- SUICIDE LOGIC IF LOW TTL ---
        if (creep.ticksToLive < 100) {
            creep.say("☠️ retiring");
            if (creep.store.getUsedCapacity() > 0) {
                var storeKeys = Object.keys(creep.store);
                var carryType = storeKeys.length > 0 ? storeKeys[0] : RESOURCE_ENERGY;
                var dumpTarget = creep.room.storage || creep.room.terminal;
                if (dumpTarget) {
                    if (doTransfer(creep, dumpTarget, carryType) === ERR_NOT_IN_RANGE) {
                        smartMove(creep, dumpTarget);
                    }
                } else {
                    creep.drop(carryType);
                }
                return;
            }
            creep.suicide();
            return;
        }

        pruneAvoidPairs(creep);
        if (!creep.memory.state) creep.memory.state = "idle";

        // --- ANTI-STUCK LOGIC ---
        if (creep.memory.lastPos) {
            if (creep.fatigue === 0) {
                var moved = creep.pos.x !== creep.memory.lastPos.x ||
                            creep.pos.y !== creep.memory.lastPos.y ||
                            creep.room.name !== creep.memory.lastPos.roomName;
                var triedMoveLastTick = creep.memory.lastTriedMoveTick === (Game.time - 1);
                if (!moved && triedMoveLastTick) {
                    creep.memory.stuckCount = (creep.memory.stuckCount || 0) + 1;
                } else if (moved) {
                    creep.memory.stuckCount = 0;
                }
            }
        } else {
            creep.memory.stuckCount = 0;
        }
        creep.memory.lastPos = { x: creep.pos.x, y: creep.pos.y, roomName: creep.room.name };

        if ((creep.memory.stuckCount || 0) >= 2) {
            var shouldStepAside = true;
            var a0 = creep.memory.assignment;

            if (a0) {
                if (creep.memory.state === "delivering") {
                    var t0 = Game.getObjectById(a0.transferTargetId || a0.taskId);
                    if (t0 && creep.pos.getRangeTo(t0.pos) <= 1) shouldStepAside = false;
                } else if (creep.memory.state === "fetching") {
                    if (isWithdrawType(a0.type)) {
                        var s0 = Game.getObjectById(a0.taskId);
                        if (s0 && creep.pos.getRangeTo(s0.pos) <= 1) shouldStepAside = false;
                    }
                    if (shouldStepAside && creep.store.getFreeCapacity() > 0) {
                        var nearby = creep.pos.findInRange(FIND_STRUCTURES, 1, {
                            filter: function(s) {
                                return s.store && (s.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0;
                            }
                        });
                        if (nearby && nearby.length > 0) shouldStepAside = false;
                    }
                } else if (creep.memory.state === "delivering_energy") {
                    if (creep.room.storage && creep.pos.getRangeTo(creep.room.storage.pos) <= 1) {
                        shouldStepAside = false;
                    }
                }
            }

            if (shouldStepAside) {
                if (!tryStepAside(creep)) {
                    creep.memory.lastTriedMoveTick = Game.time;
                    return;
                }
                creep.memory.rerouteUntil = Math.max(Game.time + 5, creep.memory.rerouteUntil || 0);
                if (creep.memory._move) delete creep.memory._move;
                creep.say("🔄 reroute");
            }
            creep.memory.stuckCount = 0;
        }

        if (creep.memory.rerouteUntil && Game.time >= creep.memory.rerouteUntil) {
            delete creep.memory.rerouteUntil;
        }

        // Cache store values
        var storeCache = {
            freeCapacity: creep.store.getFreeCapacity(),
            usedCapacity: creep.store.getUsedCapacity(),
            energyUsed: creep.store.getUsedCapacity(RESOURCE_ENERGY)
        };

        var view = getRoomView(creep.room);
        if (!view) {
            creep.say("no view");
            return;
        }

        // --- PRIORITY MINERALS DROP-OFF ---
        var mineralType = null;
        var creepStoreKeys = Object.keys(creep.store);
        for (var csi = 0; csi < creepStoreKeys.length; csi++) {
            var resourceType = creepStoreKeys[csi];
            if (resourceType !== RESOURCE_ENERGY && creep.store[resourceType] > 0) {
                mineralType = resourceType;
                break;
            }
        }

        if (mineralType) {
            var depositTarget = null;
            if (view.storage && view.storage.store.getFreeCapacity(mineralType) > 0) {
                depositTarget = view.storage;
            } else if (view.terminal && view.terminal.store.getFreeCapacity(mineralType) > 0) {
                depositTarget = view.terminal;
            }

            if (depositTarget) {
                creep.say("💎 deposit");
                if (creep.pos.getRangeTo(depositTarget) > 1) {
                    smartMove(creep, depositTarget);
                    return;
                }
                doTransfer(creep, depositTarget, mineralType, null);
                return;
            }
            creep.say("⚠️ full!");
            return;
        }

        // --- OPPORTUNISTIC ADJACENT EXTENSION FILL ---
        if (creep.memory.assignment &&
            creep.memory.assignment.type === "extension" &&
            creep.memory.state === "delivering" &&
            creep.memory.extOpportunistic) {

            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                var nearbyExtensions = creep.pos.findInRange(FIND_STRUCTURES, 1, {
                    filter: function(s) {
                        return s && s.my && s.structureType === STRUCTURE_EXTENSION &&
                               s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                    }
                });
                if (nearbyExtensions && nearbyExtensions.length > 0) {
                    doTransfer(creep, nearbyExtensions[0], RESOURCE_ENERGY, null);
                    return;
                }
            }
            delete creep.memory.extOpportunistic;
        }

        // --- COMPLETION + TTL GUARDS ---
        if (creep.memory.assignment) {
            var aChk = creep.memory.assignment;
            if (aChk.assignedTick && Game.time - aChk.assignedTick > ASSIGNMENT_TTL) {
                clearAssignment(creep, { reason: "TTL expired", avoid: true });
            } else if (isTaskComplete(view, aChk)) {
                clearAssignment(creep, { justCompleted: true, reason: "pre-action complete" });
            }
        }

        // --- VALIDATE EXISTING ASSIGNMENT ---
        if (creep.memory.assignment) {
            if (!validateAssignment(creep, view, creep.memory.assignment)) {
                clearAssignment(creep, { reason: "validation failed", avoid: true });
            }
        }

        // Pick assignment
        attemptPickAssignment(creep, view, storeCache);

        // --- EXECUTE ACTION ---
        if (creep.memory.assignment && creep.memory.assignment.type !== "idle") {
            var inReroute = Game.time < (creep.memory.rerouteUntil || 0);

            // Cache assignment objects once
            var execAssignment = creep.memory.assignment;
            var execSrcObj = Game.getObjectById(execAssignment.taskId);
            var execDstObj = execAssignment.transferTargetId
                ? Game.getObjectById(execAssignment.transferTargetId)
                : execSrcObj;

            switch (creep.memory.state) {
                case "delivering_energy":
                    executeDeliveringEnergy(creep, view, execAssignment, inReroute);
                    break;

                case "fetching":
                    executeFetching(creep, view, execAssignment, execSrcObj, execDstObj);
                    break;

                case "delivering":
                    executeDelivering(creep, view, execAssignment, execDstObj, inReroute);
                    break;

                case "idle":
                    clearAssignment(creep, { reason: "unexpected idle state" });
                    break;

                default:
                    creep.memory.state = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ? "fetching" : "delivering";
                    break;
            }
        }
    }
};

// --- STATE EXECUTION FUNCTIONS ---
function executeDeliveringEnergy(creep, view, execA, inReroute) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        if (execA.type === "materials_empty") {
            creep.memory.state = "fetching";
        } else {
            clearAssignment(creep, { justCompleted: true, reason: "energy dropped" });
        }
        return;
    }

    var targetDE = null;
    if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        targetDE = view.storage;
    } else if (view.terminal && view.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        targetDE = view.terminal;
    }

    creep.say("⚡ drop energy");
    if (!targetDE) {
        clearAssignment(creep, { reason: "no capacity to drop energy", avoid: execA.type === "materials_empty" });
        return;
    }

    if (creep.pos.getRangeTo(targetDE) > 1) {
        var mv = smartMove(creep, targetDE);
        if (mv === ERR_NO_PATH && !inReroute) {
            creep.memory.noPathDeliver = (creep.memory.noPathDeliver || 0) + 1;
            if (creep.memory.noPathDeliver >= NO_PATH_DELIVER_TTL) {
                clearAssignment(creep, { reason: "no path delivering_energy", avoid: true });
            }
        } else {
            creep.memory.noPathDeliver = 0;
        }
        return;
    }

    var resDE = doTransfer(creep, targetDE, RESOURCE_ENERGY, null);
    if (resDE === OK || resDE === ERR_FULL) {
        if (execA.type === "materials_empty") {
            creep.memory.state = "fetching";
            creep.say("🔄 fetch");
        } else {
            clearAssignment(creep, { justCompleted: true, reason: "drop energy OK/FULL" });
        }
    } else if (resDE !== ERR_NOT_IN_RANGE) {
        clearAssignment(creep, { reason: "drop energy transfer error " + resDE, avoid: true });
    }
}

function executeFetching(creep, view, execA, execSrcObj, execDstObj) {
    if (execA.type === "container_drain" && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        creep.memory.state = "delivering";
        creep.say("⚡ dump");
        return;
    }

    if (creep.store.getFreeCapacity() === 0) {
        creep.memory.state = "delivering";
        return;
    }

    creep.say("🔄 fetch");
    var source = null;

    if (execA.type === "link_fill") {
        source = execSrcObj;
        if (source && (source.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < 100) {
            clearAssignment(creep, { reason: "link_fill: storage low on energy", avoid: true });
            return;
        }
    } else if (isWithdrawType(execA.type)) {
        source = execSrcObj;
    } else {
        // Find energy source
        if (view.storage && view.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 1000) {
            source = view.storage;
        } else {
            var energyContainers = [];
            for (var ci = 0; ci < view.containers.length; ci++) {
                var c = view.containers[ci];
                var e = c.store.getUsedCapacity(RESOURCE_ENERGY);
                if (e <= 0) continue;
                if (view.controller && c.pos.getRangeTo(view.controller.pos) <= 2) continue;
                energyContainers.push(c);
            }

            if (energyContainers.length > 0) {
                var freeE = creep.store.getFreeCapacity(RESOURCE_ENERGY);
                var canFill = [];
                for (var fi = 0; fi < energyContainers.length; fi++) {
                    if (energyContainers[fi].store.getUsedCapacity(RESOURCE_ENERGY) >= freeE) {
                        canFill.push(energyContainers[fi]);
                    }
                }
                source = canFill.length > 0 ? creep.pos.findClosestByRange(canFill) : creep.pos.findClosestByRange(energyContainers);
            }

            if (!source && view.terminal && view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                source = view.terminal;
            }

            if (!source && view.nukers && view.nukers.length > 0) {
                var termE = view.terminal ? (view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
                var storE = view.storage ? (view.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
                if (termE === 0 && storE <= 1000) {
                    var nukerCands = [];
                    for (var ni = 0; ni < view.nukers.length; ni++) {
                        if (view.nukers[ni].store && (view.nukers[ni].store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) {
                            nukerCands.push(view.nukers[ni]);
                        }
                    }
                    if (nukerCands.length > 0) source = creep.pos.findClosestByRange(nukerCands);
                }
            }
        }
    }

    if (!source) {
        clearAssignment(creep, { reason: "no source", avoid: true });
        return;
    }

    var resType = RESOURCE_ENERGY;
    var amt = null;

    if (execA.type === "materials_empty") {
        var picked = false;
        var srcKeys = Object.keys(source.store);
        for (var ski = 0; ski < srcKeys.length; ski++) {
            if (srcKeys[ski] !== RESOURCE_ENERGY && source.store[srcKeys[ski]] > 0) {
                resType = srcKeys[ski];
                picked = true;
                break;
            }
        }
        if (!picked) {
            clearAssignment(creep, { reason: "materials_empty no minerals", avoid: true });
            return;
        }
    }

    var available = source.store && source.store.getUsedCapacity ? (source.store.getUsedCapacity(resType) || 0) : 0;
    if (available <= 0) {
        clearAssignment(creep, { reason: "fetch source empty", avoid: true });
        return;
    }

    var freeCap = creep.store.getFreeCapacity();

    if (execA.type === "link_drain") {
        var maxDrainNow = Math.max(0, available - LINK_FILL_THRESHOLD);
        if (maxDrainNow <= 0) {
            clearAssignment(creep, { justCompleted: true, reason: "link_drain already below threshold" });
            return;
        }
        amt = Math.min(execA.amount != null ? execA.amount : maxDrainNow, maxDrainNow, freeCap);
    } else if (execA.type === "link_fill") {
        var linkEnergyNow = execDstObj ? (execDstObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        var linkCapNow = execDstObj ? execDstObj.store.getCapacity(RESOURCE_ENERGY) : 0;
        var maxFillNow = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, linkCapNow) - linkEnergyNow);
        if (maxFillNow <= 0) {
            clearAssignment(creep, { justCompleted: true, reason: "link already filled at fetch" });
            return;
        }
        amt = Math.min(execA.amount != null ? execA.amount : available, available, freeCap, maxFillNow);
        if (amt <= 0) {
            clearAssignment(creep, { justCompleted: true, reason: "link_fill no amount to fetch" });
            return;
        }
    } else if (execA.type === "terminal_balance") {
        amt = Math.min(execA.amount != null ? execA.amount : available, available, freeCap);
    } else {
        amt = Math.min(available, freeCap);
    }

    if (creep.pos.getRangeTo(source) > 1) {
        smartMove(creep, source);
        return;
    }

    var withdrawResult = doWithdraw(creep, source, resType, amt);
    if (withdrawResult === OK || withdrawResult === ERR_FULL) {
        creep.memory.state = "delivering";
    } else if (withdrawResult === ERR_NOT_ENOUGH_RESOURCES) {
        clearAssignment(creep, { reason: "withdraw not enough", avoid: true });
    } else if (withdrawResult !== ERR_NOT_IN_RANGE) {
        clearAssignment(creep, { reason: "withdraw error " + withdrawResult, avoid: true });
    }
}

function executeDelivering(creep, view, execA, execDstObj, inReroute) {
    if (creep.store.getUsedCapacity() === 0) {
        clearAssignment(creep, { reason: "nothing to deliver" });
        return;
    }

    var target = execDstObj;
    creep.say("🚚 deliver");

    if (!target) {
        clearAssignment(creep, { reason: "missing delivery target", avoid: true });
        return;
    }

    var resTypeD = RESOURCE_ENERGY;
    if (execA.type === "materials_empty") {
        var foundRes = false;
        var cKeys = Object.keys(creep.store);
        for (var ck = 0; ck < cKeys.length; ck++) {
            if (cKeys[ck] !== RESOURCE_ENERGY && creep.store[cKeys[ck]] > 0) {
                resTypeD = cKeys[ck];
                foundRes = true;
                break;
            }
        }
        if (!foundRes) {
            if (isTaskComplete(view, execA)) {
                clearAssignment(creep, { justCompleted: true, reason: "materials below threshold (no cargo)" });
            } else {
                creep.memory.state = "fetching";
                creep.say("🔄 fetch");
            }
            return;
        }
    }

    if (target.store && target.store.getFreeCapacity && target.store.getFreeCapacity(resTypeD) <= 0) {
        if (execA.type === "materials_empty") {
            var alt = null;
            if (view.storage && view.storage.id !== target.id && view.storage.store.getFreeCapacity(resTypeD) > 0) {
                alt = view.storage;
            } else if (view.terminal && view.terminal.id !== target.id && view.terminal.store.getFreeCapacity(resTypeD) > 0) {
                alt = view.terminal;
            }
            if (alt) {
                creep.memory.assignment.transferTargetId = alt.id;
            } else {
                clearAssignment(creep, { reason: "no capacity for minerals", avoid: true });
            }
        } else {
            clearAssignment(creep, { justCompleted: true, reason: "target full" });
        }
        return;
    }

    if (creep.pos.getRangeTo(target) > 1) {
        var mv = smartMove(creep, target);
        if (mv === ERR_NO_PATH && !inReroute) {
            creep.memory.noPathDeliver = (creep.memory.noPathDeliver || 0) + 1;
            if (creep.memory.noPathDeliver >= NO_PATH_DELIVER_TTL) {
                clearAssignment(creep, { reason: "no path delivering", avoid: true });
            }
        } else {
            creep.memory.noPathDeliver = 0;
        }
        return;
    }

    var amtD = null;
    if (execA.type === "link_fill") {
        var linkCapD = target.store.getCapacity(RESOURCE_ENERGY);
        var linkEnergyD = target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var maxFillNowD = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, linkCapD) - linkEnergyD);
        if (maxFillNowD <= 0) {
            clearAssignment(creep, { justCompleted: true, reason: "link filled at delivery" });
            return;
        }
        amtD = Math.min(
            execA.amount != null ? execA.amount : creep.store.getUsedCapacity(RESOURCE_ENERGY),
            maxFillNowD,
            creep.store.getUsedCapacity(RESOURCE_ENERGY)
        );
    }

    var resTx = doTransfer(creep, target, resTypeD, amtD);
    if (resTx === OK || resTx === ERR_FULL) {
        if (execA.type === "extension") {
            creep.memory.extOpportunistic = true;
            return;
        }
        if (isTaskComplete(view, execA) || execA.type === "fallback_dump") {
            clearAssignment(creep, { justCompleted: true, reason: "transfer complete" });
        } else if (execA.type === "materials_empty" || execA.type === "terminal_balance" || creep.store.getUsedCapacity() === 0) {
            creep.memory.state = "fetching";
            creep.say("🔄 fetch");
        }
    } else if (resTx !== ERR_NOT_IN_RANGE) {
        clearAssignment(creep, { reason: "transfer error " + resTx, avoid: true });
    }
}

module.exports = roleSupplier;