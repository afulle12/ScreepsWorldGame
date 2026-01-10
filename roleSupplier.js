// roleSupplier.js
// Purpose: Supplier role using cached room view from getRoomState.js to reduce CPU.
// OPTIMIZATIONS:
// - "True Idle": Sleeps efficiently ONLY if room is truly empty (no avoids active).
// - Native Search: Uses findClosestByRange (C++) instead of Array.sort (JS).
// - Intent Preservation: Strict checks to prevent failed intents.
// - Single Scan: Scans once per tick maximum; state updates wait for fresh data next tick.

// Toggle logging for supplier task table here:
const SUPPLIER_LOGGING_ENABLED = false;
const SUPPLIER_CONTAINER_CATEGORY_LOGGING = false;
const SUPPLIER_DEBUG = false; // set creep.memory.debug = true to enable per-creep debug

// Toggle to enable or disable the supplier role
const SUPPLIER_ENABLED = true;  // Set to false to disable

// --- TRUE IDLE WINDOW (ticks) ---
const SUPPLIER_IDLE_TICKS = 16;

// --- LINK THRESHOLDS ---
const LINK_FILL_THRESHOLD = 200;
const LINK_DRAIN_THRESHOLD = 600;

// --- DONOR DRAIN THRESHOLD ---
const DONOR_DRAIN_THRESHOLD = 200;

// --- POWER SPAWN THRESHOLD ---
const POWER_SPAWN_FILL_THRESHOLD = 2000;

// --- ASSIGNMENT SAFETY ---
const ASSIGNMENT_TTL = 75;      // Ticks after which we force-clear a stuck assignment
const NO_PATH_DELIVER_TTL = 6; // If we can't path to the delivery target for this many ticks, drop task

// --- PAIR AVOIDANCE (to let room view catch up) ---
const AVOID_PAIR_TTL = 5;

// Integration: cached per-room view (structures, sources, creeps, etc.)
const getRoomState = require("getRoomState");

// Integrate with terminalManager to gate terminal_balance when transfers are in progress
const terminalManager = require("terminalManager");

// Integer task priorities (lower number = higher priority)
function getTaskPriorityValue(taskType) {
    switch (taskType) {
        case "spawn": return 10;       // Highest priority: fill spawn first
        case "extension": return 20;
        case "tower": return 30;
        case "power_spawn_fill": return 32; // Fill power spawn if low
        case "link_drain": return 35;
        case "link_fill": return 36;
        case "container_empty": return 40;
        case "materials_drain_energy": return 45;
        case "container_drain": return 50;
        case "materials_empty": return 55;
        case "terminal_balance": return 60; // balance terminal energy around 20k
        case "idle": return 100; // LOWEST PRIORITY: Sleep
        default: return 99;
    }
}

// Classify task types that are true withdraw-tasks (taskId is the source)
function isWithdrawType(type) {
    if (!type) return false;
    if (type.indexOf("container") === 0) return true; // container_empty, container_drain
    if (type.indexOf("materials") === 0) return true; // materials_drain_energy, materials_empty
    if (type === "link_drain") return true;
    if (type === "link_fill") return true; // taskId = storage (withdraw), deliver to link
    if (type === "terminal_balance") return true; // withdraw from terminal or storage depending side
    return false;
}

// Helpers to avoid passing explicit undefined amounts
function doTransfer(creep, target, resourceType, amount) {
    if (amount != null) return creep.transfer(target, resourceType, amount);
    return creep.transfer(target, resourceType);
}
function doWithdraw(creep, target, resourceType, amount) {
    if (amount != null) return creep.withdraw(target, resourceType, amount);
    return creep.withdraw(target, resourceType);
}

// Helper to determine the creep's effective energy capacity
function getCreepEnergyCapacity(creep) {
    var cap = creep.store.getCapacity(RESOURCE_ENERGY);
    if (cap == null) cap = creep.store.getCapacity();
    if (cap == null) cap = creep.store.getFreeCapacity() + creep.store.getUsedCapacity();
    return cap || 0;
}

// Persistent avoid-pair helpers
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

// Centralized clear to avoid stale state/flags
function clearAssignment(creep, opts) {
    opts = opts || {};
    var a = creep.memory.assignment;

    // If just completed or failure explicitly requested avoid, track it
    if ((opts.justCompleted || opts.avoid) && a && a.type && a.taskId) {
        creep.memory.lastCompletedTick = Game.time;
        creep.memory.lastCompletedType = a.type;
        creep.memory.lastCompletedTaskId = a.taskId;
        creep.memory.lastCompletedTargetId = a.transferTargetId || a.taskId;

        // Add persistent avoid. If it was a path failure, this ensures we don't Deep Sleep next tick.
        addAvoidPair(creep, a, AVOID_PAIR_TTL);
    }

    creep.memory.assignment = null;
    delete creep.memory.noPathDeliver;
    delete creep.memory.nextCheckTick;
    delete creep.memory.extOpportunistic; // ensure opportunistic flag cleared
    delete creep.memory.sleepUntil; // Clear sleep

    // NOTE: We do NOT set creep.memory.state here.
    // We let the next tick's logic determine the correct state based on fresh store data.

    if ((SUPPLIER_DEBUG || creep.memory.debug) && opts && opts.reason) {
        console.log("[SUP] " + creep.name + " clearAssignment (" + opts.reason + ") t=" + Game.time);
    }
}

// Helper move wrapper: always attempt movement; record lastTriedMoveTick
function smartMove(creep, target, extraOpts) {
    extraOpts = extraOpts || {};

    if (creep.fatigue > 0) {
        return ERR_TIRED;
    }

    // Guard: avoid double move intents in the same tick
    if (creep.memory.lastTriedMoveTick === Game.time) {
        return ERR_BUSY;
    }

    var targetPos = target.pos || target;
    var dist = creep.pos.getRangeTo(targetPos);
    var maxOps = Math.min(2000, Math.max(200, dist * 50));
    var inReroute = Game.time < (creep.memory.rerouteUntil || 0);

    var moveOpts = {
        reusePath: inReroute ? 0 : Math.min(10, Math.max(3, Math.floor(dist / 2))),
        maxOps: maxOps,
        heuristicWeight: 1.2
    };
    for (var k in extraOpts) moveOpts[k] = extraOpts[k];

    // Mark that we are attempting to move this tick
    creep.memory.lastTriedMoveTick = Game.time;

    var res = creep.moveTo(targetPos, moveOpts);
    if (res === ERR_NO_PATH && !inReroute) {
        creep.memory.rerouteUntil = Game.time + 3;
        if (creep.memory._move) delete creep.memory._move;
    }
    return res;
}

// Utility: shallow array equality
function arraysEqual(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// --------- Micro-scan Helpers (no global room-wide tasks cache) ---------

// Init getRoomState once per tick
function ensureGetRoomStateInit() {
    if (getRoomState && typeof getRoomState.init === "function") {
        if (global.__supplierLastRoomStateInitTick !== Game.time) {
            getRoomState.init();
            global.__supplierLastRoomStateInitTick = Game.time;
        }
    }
}

// Lightweight view for only what we need
function getRoomView(room) {
    ensureGetRoomStateInit();
    var base = getRoomState.get(room.name);
    if (!base) return null;

    var structuresByType = base.structuresByType || {};
    var containers = structuresByType[STRUCTURE_CONTAINER] || [];
    var spawns = (structuresByType[STRUCTURE_SPAWN] || []).filter(function (s) { return s.my; });
    var extractors = (structuresByType[STRUCTURE_EXTRACTOR] || []).filter(function (e) { return e.my; });
    var towers = (structuresByType[STRUCTURE_TOWER] || []).filter(function (t) { return t.my; });
    var links = (structuresByType[STRUCTURE_LINK] || []).filter(function (l) { return l.my; });
    var extensions = (structuresByType[STRUCTURE_EXTENSION] || []).filter(function (e) { return e.my; });
    var powerSpawns = (structuresByType[STRUCTURE_POWER_SPAWN] || []).filter(function (s) { return s.my; });
    var nukers = (structuresByType[STRUCTURE_NUKER] || []).filter(function (n) { return n.my; });
    var sources = base.sources || [];
    var suppliers = (base.myCreeps || []).filter(function (c) { return c.memory && c.memory.role === "supplier"; });

    return {
        roomName: room.name,
        controller: room.controller,
        storage: room.storage,
        terminal: room.terminal,
        containers: containers,
        spawns: spawns,
        extractors: extractors,
        sources: sources,
        towers: towers,
        links: links,
        extensions: extensions,
        powerSpawns: powerSpawns,
        nukers: nukers,
        suppliers: suppliers
    };
}

// Persisted container labeling (recomputed only when topology changes / periodic)
function ensureContainerLabels(room, view) {
    if (!view) return;

    var mem = room.memory;
    if (!mem.containerLabels) mem.containerLabels = {};
    if (!mem.containerLabelMeta) mem.containerLabelMeta = {};

    var currentMeta = {
        containerIds: view.containers.map(function (c) { return c.id; }).sort(),
        spawnIds: view.spawns.map(function (s) { return s.id; }).sort(),
        extractorIds: view.extractors.map(function (e) { return e.id; }).sort(),
        sourceIds: view.sources.map(function (s) { return s.id; }).sort(),
        controllerId: view.controller ? view.controller.id : null
    };

    var recomputeLabels =
        !mem.containerLabelMeta ||
        !arraysEqual(mem.containerLabelMeta.containerIds || [], currentMeta.containerIds) ||
        !arraysEqual(mem.containerLabelMeta.spawnIds || [], currentMeta.spawnIds) ||
        !arraysEqual(mem.containerLabelMeta.extractorIds || [], currentMeta.extractorIds) ||
        !arraysEqual(mem.containerLabelMeta.sourceIds || [], currentMeta.sourceIds) ||
        mem.containerLabelMeta.controllerId !== currentMeta.controllerId ||
        (Game.time % 1000 === 0); // periodic refresh

    if (recomputeLabels) {
        var labels = {};
        for (var ci = 0; ci < view.containers.length; ci++) {
            var c = view.containers[ci];

            // Materials: extractor adjacent (range == 1)
            var nearbyExtractors = c.pos.findInRange(view.extractors, 1);
            var isMaterials = nearbyExtractors.length > 0;

            if (isMaterials) {
                labels[c.id] = "materials";
            } else {
                // Donor: near sources (<= 4)
                var nearbySources = c.pos.findInRange(view.sources, 4);
                var isDonor = nearbySources.length > 0;

                // Recipient: near controller (<= 2)
                var isRecipient = false;
                if (view.controller && c.pos.getRangeTo(view.controller.pos) <= 2) {
                    isRecipient = true;
                }

                if (isRecipient) {
                    labels[c.id] = "recipient";
                } else if (isDonor) {
                    labels[c.id] = "donor";
                } else {
                    labels[c.id] = "recipient";
                }
            }
        }
        mem.containerLabels = labels;
        mem.containerLabelMeta = currentMeta;

        if (SUPPLIER_CONTAINER_CATEGORY_LOGGING) {
            console.log("Updated container labels for Room " + room.name);
        }
    }
}

function getContainerBuckets(room, view) {
    ensureContainerLabels(room, view);
    var labels = room.memory.containerLabels || {};
    var donors = [];
    var recipients = [];
    var materials = [];
    var others = [];
    for (var i = 0; i < view.containers.length; i++) {
        var c = view.containers[i];
        var l = labels[c.id];
        if (l === "donor") donors.push(c);
        else if (l === "recipient") recipients.push(c);
        else if (l === "materials") materials.push(c);
        else others.push(c);
    }
    return { donors: donors, recipients: recipients, materials: materials, others: others };
}

const ALL_TASK_TYPES = [
    "spawn", "extension", "tower", "power_spawn_fill",
    "link_drain", "link_fill",
    "container_empty",
    "materials_drain_energy", "container_drain", "materials_empty",
    "terminal_balance",
    "idle" // Added IDLE to list
];

function computePriorityOrder(room) {
    var mapping = room.memory.supplierPriorities;
    if (!mapping) mapping = {};
    var list = ALL_TASK_TYPES.slice();
    list.sort(function (a, b) {
        var pa = mapping[a] != null ? mapping[a] : getTaskPriorityValue(a);
        var pb = mapping[b] != null ? mapping[b] : getTaskPriorityValue(b);
        return pa - pb;
    });
    room.memory.supplierPriorityOrder = list;
    room.memory.supplierPriorityOrderLast = Game.time;
    return list;
}

function getPriorityOrder(room) {
    var order = room.memory.supplierPriorityOrder;
    if (!order || !order.length || (Game.time - (room.memory.supplierPriorityOrderLast || 0) > 250)) {
        return computePriorityOrder(room);
    }
    // Safety check if new task types added
    if (order.length !== ALL_TASK_TYPES.length) {
        return computePriorityOrder(room);
    }
    return order;
}

function isTakenByOtherSupplier(view, creep, type, taskId, transferTargetId) {
    for (var i = 0; i < view.suppliers.length; i++) {
        var s = view.suppliers[i];
        if (!s.memory) continue;
        if (s.name === creep.name) continue;
        var a = s.memory.assignment;
        if (!a) continue;
        if (a.type !== type) continue;
        if (a.taskId !== taskId) continue;
        var aTgt = a.transferTargetId || null;
        var tgt = transferTargetId || null;
        if (aTgt !== tgt) continue;
        return true;
    }
    return false;
}

function pickBestByNeedThenDistance(structs, getNeedFn, creep) {
    var best = null, bestNeed = -1, bestDist = Infinity;
    for (var i = 0; i < structs.length; i++) {
        var s = structs[i];
        var need = getNeedFn(s);
        if (need <= 0) continue;
        var dist = creep.pos.getRangeTo(s.pos);
        if (need > bestNeed || (need === bestNeed && dist < bestDist)) {
            best = s; bestNeed = need; bestDist = dist;
        }
    }
    return { target: best, need: bestNeed };
}

// Avoid-pair helper for current-tick avoid
function matchesAvoid(avoid, type, taskId, transferTargetId) {
    if (!avoid) return false;
    if (avoid.type !== type) return false;
    var at = avoid.transferTargetId || avoid.taskId;
    var tt = transferTargetId || taskId;
    return avoid.taskId === taskId && at === tt;
}

// OPTIMIZED: Cache extension list per tick to avoid repeated filtering
function getCachedExtensionList(view) {
    if (global.__supplierExtensionCacheTick !== Game.time) {
        global.__supplierExtensionCacheTick = Game.time;
        global.__supplierExtensionCache = {};
    }
    if (!global.__supplierExtensionCache) {
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
            validExtensions.push({
                id: ext.id,
                pos: ext.pos,
                freeCapacity: freeCapacity
            });
        }
        global.__supplierExtensionCache[cacheKey] = validExtensions;
    }
    return global.__supplierExtensionCache[cacheKey];
}

// ---- per-type micro-scans (now support "avoid" to return next-best candidate) ----
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

    // Small number of spawns, simple logic ok
    var pick = pickBestByNeedThenDistance(candidates, function (s) {
        return s.store.getFreeCapacity(RESOURCE_ENERGY);
    }, creep);

    if (!pick.target) return null;
    return { type: "spawn", taskId: pick.target.id, amount: pick.need };
}

// OPTIMIZED: Uses findClosestByRange (C++) instead of Array.sort (JS)
function findExtensionFill(view, creep, avoid) {
    var cachedList = getCachedExtensionList(view);
    if (cachedList.length === 0) return null;

    var candidates = [];
    for (var i = 0; i < cachedList.length; i++) {
        var extData = cachedList[i];
        // Re-check dynamic conditions that cache doesn't cover (avoid, taken)
        if (matchesAvoid(avoid, "extension", extData.id, extData.id)) continue;

        // Is it taken?
        if (isTakenByOtherSupplier(view, creep, "extension", extData.id, extData.id)) continue;

        // Note: we need the object for findClosestByRange
        var obj = Game.getObjectById(extData.id);
        if (obj && obj.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            candidates.push(obj);
        }
    }

    if (candidates.length === 0) return null;

    // CPU WIN: Native search is much faster than JS sort for distance
    var best = creep.pos.findClosestByRange(candidates);

    if (!best) return null;
    return {
        type: "extension",
        taskId: best.id,
        amount: best.store.getFreeCapacity(RESOURCE_ENERGY)
    };
}

function findTowerFill(view, creep, avoid) {
    var list = view.towers || [];
    var candidates = [];
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.my) continue;
        var free = t.store.getFreeCapacity(RESOURCE_ENERGY);
        var ratio = (t.store[RESOURCE_ENERGY] || 0) / t.store.getCapacity(RESOURCE_ENERGY);
        if (free <= 0 || ratio >= 0.75) continue;
        if (matchesAvoid(avoid, "tower", t.id, t.id)) continue;
        candidates.push(t);
    }

    if (candidates.length === 0) return null;

    var pick = pickBestByNeedThenDistance(candidates, function (t) {
        return t.store.getFreeCapacity(RESOURCE_ENERGY);
    }, creep);

    if (!pick.target) return null;
    return { type: "tower", taskId: pick.target.id, amount: pick.need };
}

function findPowerSpawnFill(view, creep, avoid) {
    var list = view.powerSpawns || [];
    var candidates = [];

    for (var i = 0; i < list.length; i++) {
        var ps = list[i];
        var used = ps.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (used <= POWER_SPAWN_FILL_THRESHOLD) {
            if (matchesAvoid(avoid, "power_spawn_fill", ps.id, ps.id)) continue;
            candidates.push(ps);
        }
    }

    if (candidates.length === 0) return null;

    var pick = pickBestByNeedThenDistance(candidates, function (ps) {
        return ps.store.getFreeCapacity(RESOURCE_ENERGY);
    }, creep);

    if (!pick.target) return null;
    return { type: "power_spawn_fill", taskId: pick.target.id, amount: pick.need };
}

function findLinkFill(view, creep, avoid) {
    if (!view.storage) return null;
    var storage = view.storage;

    var storageEnergy = storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (storageEnergy < 500) return null;

    var list = view.links || [];
    for (var i = 0; i < list.length; i++) {
        var link = list[i];
        if (!link.my) continue;
        if (!link.pos.inRangeTo(storage.pos, 2)) continue;
        if (view.controller && link.pos.getRangeTo(view.controller.pos) <= 2) continue;

        // Is it a source link?
        var nearSource = false;
        for (var s = 0; s < view.sources.length; s++) {
            if (view.sources[s].pos.getRangeTo(link.pos) <= 2) { nearSource = true; break; }
        }
        if (nearSource) continue;

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

function findLinkDrain(view, creep, avoid) {
    if (!view.storage) return null;
    var storage = view.storage;
    var storageFree = storage.store.getFreeCapacity(RESOURCE_ENERGY);
    if (storageFree <= 0) return null;
    var list = view.links || [];
    for (var i = 0; i < list.length; i++) {
        var link = list[i];
        if (!link.my) continue;
        if (!link.pos.inRangeTo(storage.pos, 2)) continue;
        if (view.controller && link.pos.getRangeTo(view.controller.pos) <= 2) continue;
        var nearSource = false;
        for (var s = 0; s < view.sources.length; s++) {
            if (view.sources[s].pos.getRangeTo(link.pos) <= 2) { nearSource = true; break; }
        }
        if (nearSource) continue;

        var linkEnergy = link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (linkEnergy > LINK_DRAIN_THRESHOLD) {
            if (matchesAvoid(avoid, "link_drain", link.id, storage.id)) continue;
            var amount = Math.min(linkEnergy - LINK_FILL_THRESHOLD, storageFree);
            if (amount > 0) {
                return { type: "link_drain", taskId: link.id, transferTargetId: storage.id, amount: amount };
            }
        }
    }
    return null;
}

function findMaterialsDrainEnergy(room, view, creep, avoid) {
    var buckets = getContainerBuckets(room, view);
    var mats = buckets.materials;
    if (!mats || mats.length === 0) return null;

    var best = null; var most = 0;
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
                if (t.store.getFreeCapacity(RESOURCE_ENERGY) > 0) { drainTarget = t; break; }
            }
        }
        if (!drainTarget) break;

        if (matchesAvoid(avoid, "materials_drain_energy", c.id, drainTarget.id)) continue;

        if (e > most) { most = e; best = { cont: c, tgt: drainTarget }; }
    }
    if (!best) return null;
    return { type: "materials_drain_energy", taskId: best.cont.id, transferTargetId: best.tgt.id, amount: most };
}

function findMaterialsEmpty(room, view, creep, avoid) {
    var buckets = getContainerBuckets(room, view);
    var mats = buckets.materials;
    if (!mats || mats.length === 0) return null;

    for (var i = 0; i < mats.length; i++) {
        var mc = mats[i];
        var totalUsed = mc.store.getUsedCapacity() || 0;
        var energyUsed = mc.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var totalMinerals = totalUsed - energyUsed;
        if (totalMinerals >= 1000) {
            var target = null;

            if (view.storage) {
                for (var r in mc.store) {
                    if (r !== RESOURCE_ENERGY && (mc.store[r] || 0) > 0 && view.storage.store.getFreeCapacity(r) > 0) {
                        target = view.storage; break;
                    }
                }
            }
            if (!target && view.terminal) {
                for (var r2 in mc.store) {
                    if (r2 !== RESOURCE_ENERGY && (mc.store[r2] || 0) > 0 && view.terminal.store.getFreeCapacity(r2) > 0) {
                        target = view.terminal; break;
                    }
                }
            }
            if (!target) continue;

            if (matchesAvoid(avoid, "materials_empty", mc.id, target.id)) continue;
            return {
                type: "materials_empty",
                taskId: mc.id,
                transferTargetId: target.id,
                amount: totalMinerals,
                minCapacityRequired: Math.ceil(totalMinerals * 0.5)
            };
        }
    }
    return null;
}

function findContainerDrain(room, view, creep, avoid) {
    var buckets = getContainerBuckets(room, view);
    var donors = buckets.donors || [];
    if (donors.length === 0) return null;

    var creepCapacity = getCreepEnergyCapacity(creep);

    donors.sort(function (a, b) {
        var energyA = a.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var energyB = b.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (energyA !== energyB) return energyB - energyA;
        return creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos);
    });

    var labels = room.memory.containerLabels || {};

    for (var i = 0; i < donors.length; i++) {
        var d = donors[i];
        var e = d.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

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
            if (label === "materials") continue;
            if (label === "donor") continue;
            var free = tgt.store.getFreeCapacity(RESOURCE_ENERGY);
            if (free > 0) {
                targets.push({
                    target: tgt,
                    priority: 2,
                    free: free
                });
            }
        }

        targets.sort(function (a, b) {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return b.free - a.free;
        });

        if (targets.length === 0) continue;

        for (var k = 0; k < targets.length; k++) {
            var t = targets[k].target;
            if (matchesAvoid(avoid, "container_drain", d.id, t.id)) continue;
            var amt = Math.min(e, t.store.getFreeCapacity(RESOURCE_ENERGY));

            return {
                type: "container_drain",
                taskId: d.id,
                transferTargetId: t.id,
                amount: amt,
                minDrainEnergy: creepCapacity
            };
        }
    }

    return null;
}

// OPTIMIZED: Uses findClosestByRange (C++) instead of Array.sort (JS)
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

    // CPU WIN: Closest is more efficient than highest energy
    var best = creep.pos.findClosestByRange(candidates);

    if (best) {
        return {
            type: "container_empty",
            taskId: best.id,
            transferTargetId: storage.id,
            amount: best.store.getUsedCapacity(RESOURCE_ENERGY)
        };
    }

    return null;
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
    if (roomBusy && termEnergy > MAX) {
        return null;
    }

    if (termEnergy > MAX && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        if (matchesAvoid(avoid, "terminal_balance", term.id, stor.id)) return null;
        var amountOut = Math.min(termEnergy - TARGET, stor.store.getFreeCapacity(RESOURCE_ENERGY));
        if (amountOut > 0) return { type: "terminal_balance", taskId: term.id, transferTargetId: stor.id, amount: amountOut };
    }
    if (termEnergy < MIN && stor.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (matchesAvoid(avoid, "terminal_balance", stor.id, term.id)) return null;
        var amountIn = Math.min(
            TARGET - termEnergy,
            stor.store.getUsedCapacity(RESOURCE_ENERGY),
            term.store.getFreeCapacity(RESOURCE_ENERGY)
        );
        if (amountIn > 0) return { type: "terminal_balance", taskId: stor.id, transferTargetId: term.id, amount: amountIn };
    }
    return null;
}

// --- NEW IDLE TASK ---
function findIdle(view, creep) {
    return {
        type: "idle",
        taskId: "idle_sleep",
        amount: 0
    };
}

function findTaskForType(room, view, creep, type, avoid) {
    var task = null;

    if (type === "idle") task = findIdle(view, creep);
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

    if (!task) return null;

    // Check taken status (except idle)
    if (type !== "idle") {
        if (isTakenByOtherSupplier(view, creep, task.type, task.taskId, task.transferTargetId)) return null;
        if (isPairAvoided(creep, task.type, task.taskId, task.transferTargetId)) return null;
    }

    return task;
}

// Validate current assignment directly against live objects and thresholds
function validateAssignment(creep, view, a) {
    if (!a || !a.type || !a.taskId) return false;

    // Idle is always valid
    if (a.type === "idle") return true;

    var srcObj = Game.getObjectById(a.taskId);
    var dstObj = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : Game.getObjectById(a.taskId);

    if (!srcObj) return false;
    if (a.transferTargetId && !dstObj) return false;

    var withdrawKind = isWithdrawType(a.type);

    if (!withdrawKind) {
        if (!dstObj || !dstObj.store || typeof dstObj.store.getFreeCapacity !== "function") return false;
        if (a.type !== "materials_empty" && a.type !== "fallback_dump") {
            if (dstObj.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return false;
        }
        if (a.type === "spawn" || a.type === "extension" || a.type === "tower") {
            if (!dstObj.my) return false;
        }
        if (a.type === "power_spawn_fill") {
            if (!dstObj.my) return false;
        }
        if (a.type === "fallback_dump" && dstObj.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return false;
    }

    if (withdrawKind) {
        if (a.type === "materials_empty") {
            var totalUsedME = srcObj.store.getUsedCapacity() || 0;
            var energyUsedME = srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            var totalMineralsME = totalUsedME - energyUsedME;
            if (totalMineralsME < 1000) return false;
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

            var srcEnergy = srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            if (srcEnergy < 100) return false;
        } else if (a.type === "terminal_balance") {
            if (!view.storage || !view.terminal) return false;
            var term = view.terminal;
            var stor = view.storage;
            var MIN = 19500;
            var MAX = 20500;
            var termEnergy = term.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            if (a.taskId === term.id) {
                if (!(termEnergy > MAX && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0)) return false;
            } else if (a.taskId === stor.id) {
                if (!(termEnergy < MIN && stor.store.getUsedCapacity(RESOURCE_ENERGY) > 0)) return false;
            } else return false;
        } else if (a.type === "container_drain") {
            var availableDrain = srcObj.store && typeof srcObj.store.getUsedCapacity === "function"
                ? (srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0)
                : 0;
            if (availableDrain <= 0) return false;
            if (a.minDrainEnergy != null && availableDrain < a.minDrainEnergy) return false;
        } else {
            var available = srcObj.store && typeof srcObj.store.getUsedCapacity === "function"
                ? (srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0)
                : 0;
            if (available <= 0) return false;
        }
    }

    return true;
}

// Completion predicate to clear finished assignments quickly
function isTaskComplete(view, a) {
    if (!a || !a.type || !a.taskId) return true;
    if (a.type === "idle") return false; // Idle checks are handled by sleep timer

    var src = Game.getObjectById(a.taskId);
    var dst = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : Game.getObjectById(a.taskId);

    if (!src) return true;

    if (a.type === "tower") {
        if (!dst || !dst.store || typeof dst.store.getCapacity !== "function" || typeof dst.store.getUsedCapacity !== "function") {
            return true;
        }
        var towerCapacity = dst.store.getCapacity(RESOURCE_ENERGY) || 0;
        if (towerCapacity === 0) return true;
        var towerEnergy = dst.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        return towerEnergy >= towerCapacity * 0.9;
    }

    if (a.type === "spawn" || a.type === "extension" || a.type === "power_spawn_fill") {
        if (!dst || !dst.store || typeof dst.store.getFreeCapacity !== "function") return true;
        return dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (a.type === "fallback_dump") {
        if (!dst || !dst.store || typeof dst.store.getFreeCapacity !== "function") return true;
        return dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (a.type === "link_fill") {
        if (!dst || !dst.store) return true;
        var cap = dst.store.getCapacity(RESOURCE_ENERGY);
        var e = dst.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var need = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, cap) - e);
        return need <= 0;
    }

    if (a.type === "link_drain") {
        if (!src.store) return true;
        var se = src.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        return se <= LINK_FILL_THRESHOLD;
    }

    if (a.type === "container_drain") {
        if (!dst || !dst.store || typeof dst.store.getFreeCapacity !== "function") return true;
        var srcE = src.store && src.store.getUsedCapacity ? (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        if (a.minDrainEnergy != null && srcE < a.minDrainEnergy) return true;
        return srcE <= 0 || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (a.type === "container_empty") {
        if (!dst || !dst.store || typeof dst.store.getFreeCapacity !== "function") return true;
        var srcE2 = src.store && src.store.getUsedCapacity ? (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        return srcE2 <= 0 || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (a.type === "materials_drain_energy") {
        if (!dst || !dst.store || typeof dst.store.getFreeCapacity !== "function") return true;
        var e3 = src.store && src.store.getUsedCapacity ? (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        return e3 <= 0 || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (a.type === "materials_empty") {
        if (!src.store) return true;
        var totalUsedMEc = src.store.getUsedCapacity() || 0;
        var energyUsedMEc = src.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var totalMineralsMEc = totalUsedMEc - energyUsedMEc;
        return totalMineralsMEc < 1000;
    }

    if (a.type === "terminal_balance") {
        if (!view.storage || !view.terminal) return true;
        var teBal = view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var termObj = view.terminal;
        var storObj = view.storage;
        if (a.taskId === termObj.id) {
            return teBal < 20500;
        }
        if (a.taskId === storObj.id) {
            return teBal > 19500;
        }
        return true;
    }

    return false;
}

function tryStepAside(creep) {
    var terrain = creep.room.getTerrain();
    var dirs = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

    for (var i = dirs.length - 1; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var tmp = dirs[i]; dirs[i] = dirs[j]; dirs[j] = tmp;
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

        var hasCreep = creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0;
        if (hasCreep) continue;

        var structsHere = creep.room.lookForAt(LOOK_STRUCTURES, x, y);
        var hasBlocker = false;
        for (var si = 0; si < structsHere.length; si++) {
            var s = structsHere[si];
            if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER) {
                hasBlocker = true; break;
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
    if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        return view.storage;
    }
    if (view.terminal && view.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        return view.terminal;
    }

    var containersWithSpace = [];
    for (var i = 0; i < view.containers.length; i++) {
        var c = view.containers[i];
        if (c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            containersWithSpace.push(c);
        }
    }
    if (containersWithSpace.length > 0) {
        return creep.pos.findClosestByRange(containersWithSpace);
    }
    return null;
}

function shouldStartDelivering(view, picked, storeCache) {
    if (!picked || !picked.type) return false;
    if (!storeCache || (storeCache.energyUsed || 0) <= 0) return false;

    if (picked.type === "link_fill") return true;

    if (picked.type === "terminal_balance" && view.storage && picked.taskId === view.storage.id) return true;

    return false;
}

// OPTIMIZED: Simplified assignment picker - takes FIRST valid task in strict priority order
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

    // FIXED: Strict priority enforcement - take first valid task, period
    for (var oi = 0; oi < typeOrder.length; oi++) {
        var tType = typeOrder[oi];

        if (tType.indexOf("container") === 0 || tType.indexOf("materials") === 0) {
            ensureContainerLabels(creep.room, view);
        }

        var avoidForType = (avoid && avoid.type === tType) ? avoid : null;
        var candidate = findTaskForType(creep.room, view, creep, tType, avoidForType);

        if (candidate) {
            picked = candidate;
            break; // Take the FIRST valid task in strict priority order
        }
    }

    // Fallback dump logic (only if no tasks found and not idle)
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
                    var storageEnergy = view.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                    if (storageEnergy > 5000) {
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

    // Assign picked (could be "idle")
    if (picked) {
        creep.memory.assignment = {
            taskId: picked.taskId,
            type: picked.type,
            transferTargetId: picked.transferTargetId,
            amount: picked.amount,
            assignedTick: Game.time
        };
        if (picked.minDrainEnergy != null) {
            creep.memory.assignment.minDrainEnergy = picked.minDrainEnergy;
        }
        if (picked.minCapacityRequired != null) {
            creep.memory.assignment.minCapacityRequired = picked.minCapacityRequired;
        }

        if (creep.memory.nextCheckTick) delete creep.memory.nextCheckTick;

        // --- IDLE LOGIC UPDATE ---
        if (picked.type === "idle") {
            creep.memory.state = "idle";

            // CHECK: Are we idling because we avoided everything (e.g. bad paths), or because room is empty?
            var hasActiveAvoids = false;
            if (creep.memory.avoidPairs && creep.memory.avoidPairs.length > 0) {
                for (var aInd = 0; aInd < creep.memory.avoidPairs.length; aInd++) {
                    if (Game.time <= creep.memory.avoidPairs[aInd].until) {
                        hasActiveAvoids = true;
                        break;
                    }
                }
            }

            if (!hasActiveAvoids) {
                // Room is truly empty (or we aren't avoiding anything). Deep Sleep.
                creep.memory.sleepUntil = Game.time + SUPPLIER_IDLE_TICKS;
                creep.say("💤");
            } else {
                // We have active avoids (e.g. no path). Do NOT deep sleep.
                // Just stay idle this tick and retry next tick when path/avoid might clear.
                creep.say("⏳");
            }
            return false;
        }

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
                if (creep.memory.state === "fetching") creep.say("🔄 fetch");
                else creep.say("🚚 deliver");
            }
        }

        if (SUPPLIER_DEBUG || creep.memory.debug) {
            var aDbg = creep.memory.assignment;
            console.log("[SUP] " + creep.name + " picked type=" + aDbg.type + " src=" + aDbg.taskId.slice(-6) +
                " dst=" + ((aDbg.transferTargetId && aDbg.transferTargetId.slice(-6)) || "--") +
                " state=" + creep.memory.state + " t=" + Game.time);
        }
        return true;
    }

    return false;
}

const roleSupplier = {
    /** @param {Creep} creep **/
    run: function (creep) {
        if (!SUPPLIER_ENABLED) {
            if (Game.time % 5 === 0) creep.say("Disabled");
            return;
        }

        // --- 1. IDLE SLEEP GATE (CPU SAVER) ---
        // If we are assigned "idle" and the sleep timer is active, return immediately.
        if (creep.memory.assignment && creep.memory.assignment.type === "idle") {
            if (creep.memory.sleepUntil && Game.time < creep.memory.sleepUntil) {
                return; // Near 0 CPU cost
            }
            // Wake up!
            creep.memory.assignment = null;
            delete creep.memory.sleepUntil;
        }

        // --- TASK 2: SUICIDE LOGIC IF LOW TTL ---
        if (creep.ticksToLive < 100) {
            creep.say("☠️ retiring");
            if (creep.store.getUsedCapacity() > 0) {
                // Determine resource type to drop
                var carryType = Object.keys(creep.store)[0];
                var dumpTarget = creep.room.storage || creep.room.terminal;

                if (dumpTarget) {
                    if (doTransfer(creep, dumpTarget, carryType) === ERR_NOT_IN_RANGE) {
                        smartMove(creep, dumpTarget);
                    }
                } else {
                    // No storage/terminal? Just drop it to free up capacity for suicide
                    creep.drop(carryType);
                }
                return; // Stop standard execution
            } else {
                creep.suicide();
                return; // Stop execution
            }
        }
        // ----------------------------------------

        pruneAvoidPairs(creep);

        if (!creep.memory.state) {
            creep.memory.state = "idle";
        }

        // --- ENHANCED ANTI-STUCK & REROUTE LOGIC (TTL-based) ---
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
                    if (a0.type && (a0.type.indexOf("container") === 0 || a0.type === "link_drain" || a0.type.indexOf("materials") === 0 || a0.type === "terminal_balance" || a0.type === "link_fill")) {
                        var s0 = Game.getObjectById(a0.taskId);
                        if (s0 && creep.pos.getRangeTo(s0.pos) <= 1) shouldStepAside = false;
                    }
                    if (shouldStepAside && creep.store.getFreeCapacity() > 0) {
                        var nearby = creep.pos.findInRange(FIND_STRUCTURES, 1, {
                            filter: function (s) {
                                if (!s.store) return false;
                                var cap = s.store.getUsedCapacity(RESOURCE_ENERGY);
                                return cap && cap > 0;
                            }
                        });
                        if (nearby && nearby.length > 0) shouldStepAside = false;
                    }
                } else if (creep.memory.state === "delivering_energy") {
                    var tStor = creep.room.storage;
                    if (tStor && creep.pos.getRangeTo(tStor.pos) <= 1) shouldStepAside = false;
                }
            }

            if (shouldStepAside) {
                var stepped = tryStepAside(creep);
                if (!stepped) {
                    // Block further moves this tick to avoid double move intents
                    creep.memory.lastTriedMoveTick = Game.time;
                    return;
                }
                var REROUTE_TICKS = 5;
                creep.memory.rerouteUntil = Math.max(Game.time + REROUTE_TICKS, creep.memory.rerouteUntil || 0);
                if (creep.memory._move) delete creep.memory._move;
                creep.say("🔄 reroute");
                creep.memory.stuckCount = 0;
            } else {
                creep.memory.stuckCount = 0;
            }
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

        // --- PRIORITY MINERALS DROP-OFF LOGIC (OPTIMIZED) ---
        var mineralType = null;
        for (var resourceType in creep.store) {
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
                // Change: pre-check range, move first, then transfer to avoid repeated ERR_NOT_IN_RANGE checks
                if (creep.pos.getRangeTo(depositTarget) > 1) {
                    smartMove(creep, depositTarget);
                    return;
                }
                var depRes = doTransfer(creep, depositTarget, mineralType, null);
                if (depRes !== OK && depRes !== ERR_FULL) {
                    console.log(creep.name + ": Mineral transfer failed code " + depRes + " to " + (depositTarget && depositTarget.id));
                }
                return;
            } else {
                creep.say("⚠️ full!");
                return;
            }
        }

        // --- OPPORTUNISTIC ADJACENT EXTENSION FILL (next tick after primary transfer) ---
        if (creep.memory.assignment &&
            creep.memory.assignment.type === "extension" &&
            creep.memory.state === "delivering" &&
            creep.memory.extOpportunistic) {

            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                var nearbyExtensions = creep.pos.findInRange(FIND_STRUCTURES, 1, {
                    filter: function (s) {
                        if (!s || !s.my) return false;
                        if (s.structureType !== STRUCTURE_EXTENSION) return false;
                        return s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                    }
                });
                if (nearbyExtensions && nearbyExtensions.length > 0) {
                    var nextExt = nearbyExtensions[0];
                    var tx = doTransfer(creep, nextExt, RESOURCE_ENERGY, null);
                    if (tx === ERR_NOT_IN_RANGE) {
                        smartMove(creep, nextExt); // should rarely happen; safety
                    }
                    // After performing an opportunistic transfer, end the tick early to avoid clearing now.
                    return;
                }
            }
            // No opportunistic target or no energy; clear flag and continue normal completion flow
            delete creep.memory.extOpportunistic;
        }

        // --- COMPLETION + TTL GUARDS BEFORE ANY ACTION ---
        if (creep.memory.assignment) {
            var aChk = creep.memory.assignment;

            if (aChk.assignedTick && Game.time - aChk.assignedTick > ASSIGNMENT_TTL) {
                clearAssignment(creep, { reason: "TTL expired", avoid: true });
            } else {
                if (isTaskComplete(view, aChk)) {
                    clearAssignment(creep, { justCompleted: true, reason: "pre-action complete" });
                }
            }
        }

        // --- VALIDATE EXISTING ASSIGNMENT ---
        if (creep.memory.assignment) {
            if (!validateAssignment(creep, view, creep.memory.assignment)) {
                clearAssignment(creep, { reason: "validation failed", avoid: true });
            }
        }

        // Always try to have an assignment before acting
        attemptPickAssignment(creep, view, storeCache);

        // Execute action if we have one (and it's not idle/sleeping)
        if (creep.memory.assignment && creep.memory.assignment.type !== "idle") {
            var inReroute = Game.time < (creep.memory.rerouteUntil || 0);

            switch (creep.memory.state) {
                case "delivering_energy": {
                    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                        if (creep.memory.assignment && creep.memory.assignment.type === "materials_empty") {
                            creep.memory.state = "fetching";
                        } else {
                            clearAssignment(creep, { justCompleted: true, reason: "energy dropped" });
                        }
                        break;
                    }

                    var targetDE = null;
                    if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        targetDE = view.storage;
                    } else if (view.terminal && view.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        targetDE = view.terminal;
                    }

                    creep.say("⚡ drop energy");
                    if (!targetDE) {
                        if (creep.memory.assignment && creep.memory.assignment.type === "materials_empty") {
                            clearAssignment(creep, { reason: "no capacity to drop energy", avoid: true });
                        } else {
                            clearAssignment(creep, { justCompleted: true, reason: "no capacity to drop energy" });
                        }
                        break;
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
                        break;
                    }

                    var resDE = doTransfer(creep, targetDE, RESOURCE_ENERGY, null);
                    if (resDE === OK || resDE === ERR_FULL) {
                        if (creep.memory.assignment && creep.memory.assignment.type === "materials_empty") {
                            creep.memory.state = "fetching";
                            creep.say("🔄 fetch");
                        } else {
                            clearAssignment(creep, { justCompleted: true, reason: "drop energy OK/FULL" });
                        }
                    } else if (resDE === ERR_NOT_IN_RANGE) {
                        smartMove(creep, targetDE);
                    } else {
                        console.log(creep.name + ": Energy transfer failed with code " + resDE + " to " + (targetDE && targetDE.id));
                        clearAssignment(creep, { reason: "drop energy transfer error " + resDE, avoid: true });
                    }
                    break;
                }

                case "fetching": {
                    if (creep.memory.assignment &&
                        creep.memory.assignment.type === "container_drain" &&
                        creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                        creep.memory.state = "delivering";
                        creep.say("⚡ dump");
                        break;
                    }

                    if (creep.store.getFreeCapacity() === 0) {
                        creep.memory.state = "delivering";
                        break;
                    }

                    creep.say("🔄 fetch");
                    var aF = creep.memory.assignment;
                    var source = null;

                    if (aF.type === "link_fill") {
                        source = Game.getObjectById(aF.taskId);
                        var storageEnergy = source.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                        if (storageEnergy < 100) {
                            clearAssignment(creep, { reason: "link_fill: storage low on energy", avoid: true });
                            break;
                        }
                    }
                    else if (aF.type.indexOf("container") === 0 || aF.type === "link_drain" || aF.type.indexOf("materials") === 0 || aF.type === "terminal_balance") {
                        source = Game.getObjectById(aF.taskId);
                    }
                    else {
                        if (view.storage && view.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 1000) {
                            source = view.storage;
                        } else {
                            var energyContainers = [];
                            for (var ci4 = 0; ci4 < view.containers.length; ci4++) {
                                var c4 = view.containers[ci4];
                                var e4 = c4.store.getUsedCapacity(RESOURCE_ENERGY);
                                if (e4 <= 0) continue;
                                if (view.controller && c4.pos.getRangeTo(view.controller.pos) <= 2) continue;
                                energyContainers.push(c4);
                            }

                            if (energyContainers.length > 0) {
                                var freeE = creep.store.getFreeCapacity(RESOURCE_ENERGY);
                                var canFill = [];
                                for (var fi = 0; fi < energyContainers.length; fi++) {
                                    if (energyContainers[fi].store.getUsedCapacity(RESOURCE_ENERGY) >= freeE) canFill.push(energyContainers[fi]);
                                }

                                if (canFill.length > 0) {
                                    source = creep.pos.findClosestByRange(canFill);
                                } else {
                                    // Fallback to simple closest
                                    source = creep.pos.findClosestByRange(energyContainers);
                                }
                            }

                            // 3c) Terminal fallback (no reserve)
                            if (!source && view.terminal && view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                                source = view.terminal;
                            }

                            // 3d) Nuker fallback (no reserve)
                            // Only if terminal has NO energy and storage is NOT healthy (<= 1000),
                            // and we still don't have a source from containers/terminal.
                            var terminalEnergyNow = 0;
                            if (view.terminal && view.terminal.store && typeof view.terminal.store.getUsedCapacity === "function") {
                                terminalEnergyNow = view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                            }

                            var storageEnergyNow = 0;
                            if (view.storage && view.storage.store && typeof view.storage.store.getUsedCapacity === "function") {
                                storageEnergyNow = view.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                            }

                            if (!source && terminalEnergyNow === 0 && storageEnergyNow <= 1000 && view.nukers && view.nukers.length > 0) {
                                var nukerCandidates = [];
                                for (var ni = 0; ni < view.nukers.length; ni++) {
                                    var nk = view.nukers[ni];
                                    if (!nk || !nk.store) continue;
                                    if ((nk.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= 0) continue;
                                    nukerCandidates.push(nk);
                                }
                                if (nukerCandidates.length > 0) {
                                    source = creep.pos.findClosestByRange(nukerCandidates);
                                }
                            }
                        }
                    }

                    var maxFillNow_forFetch = null;
                    if (aF.type === "link_fill") {
                        var targetLinkForFetch = Game.getObjectById(aF.transferTargetId);
                        if (!targetLinkForFetch) { clearAssignment(creep, { reason: "link_fill fetch: missing link", avoid: true }); break; }
                        var linkEnergyNow = targetLinkForFetch.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                        var linkCapNow = targetLinkForFetch.store.getCapacity(RESOURCE_ENERGY);
                        maxFillNow_forFetch = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, linkCapNow) - linkEnergyNow);
                        if (maxFillNow_forFetch <= 0) { clearAssignment(creep, { justCompleted: true, reason: "link already filled at fetch" }); break; }
                    }

                    if (source) {
                        var resType = RESOURCE_ENERGY;
                        var amt = null;

                        if (aF.type === "materials_empty") {
                            var picked = false;
                            if (source.store) {
                                for (var r in source.store) {
                                    if (r !== RESOURCE_ENERGY && source.store[r] > 0) { resType = r; picked = true; break; }
                                }
                            }
                            if (!picked) { clearAssignment(creep, { reason: "materials_empty no minerals", avoid: true }); break; }
                        } else {
                            resType = RESOURCE_ENERGY;
                        }

                        var available = source.store && typeof source.store.getUsedCapacity === "function"
                            ? (source.store.getUsedCapacity(resType) || 0)
                            : 0;

                        if (available <= 0) { clearAssignment(creep, { reason: "fetch source empty", avoid: true }); break; }

                        var freeCap = creep.store.getFreeCapacity();

                        if (aF.type === "link_drain") {
                            var maxDrainNow = Math.max(0, available - LINK_FILL_THRESHOLD);
                            if (maxDrainNow <= 0) { clearAssignment(creep, { justCompleted: true, reason: "link_drain already below threshold" }); break; }
                            var capAmtLD = aF.amount != null ? aF.amount : maxDrainNow;
                            amt = Math.min(capAmtLD, maxDrainNow, freeCap);
                        } else if (aF.type === "link_fill") {
                            var capAmtLF = aF.amount != null ? aF.amount : available;
                            amt = Math.min(capAmtLF, available, freeCap, maxFillNow_forFetch);
                            if (amt <= 0) { clearAssignment(creep, { justCompleted: true, reason: "link_fill no amount to fetch" }); break; }
                        } else if (aF.type === "terminal_balance") {
                            var capAmtTB = aF.amount != null ? aF.amount : available;
                            amt = Math.min(capAmtTB, available, freeCap);
                        } else {
                            amt = Math.min(available, freeCap);
                        }

                        if (creep.pos.getRangeTo(source) > 1) {
                            smartMove(creep, source);
                            break;
                        }

                        var availableNow = source.store && typeof source.store.getUsedCapacity === "function"
                            ? (source.store.getUsedCapacity(resType) || 0)
                            : 0;
                        if (availableNow <= 0) {
                            clearAssignment(creep, { reason: "fetch source empty at range", avoid: true });
                            break;
                        }

                        var withdrawResult = doWithdraw(creep, source, resType, amt);
                        if (withdrawResult === ERR_NOT_IN_RANGE) {
                            smartMove(creep, source);
                        } else if (withdrawResult === ERR_NOT_ENOUGH_RESOURCES) {
                            clearAssignment(creep, { reason: "withdraw not enough", avoid: true });
                        } else if (withdrawResult === OK || withdrawResult === ERR_FULL) {
                            creep.memory.state = "delivering";
                        } else {
                            console.log(creep.name + ": Withdraw failed with code " + withdrawResult + " from " + (source && source.id));
                            clearAssignment(creep, { reason: "withdraw error " + withdrawResult, avoid: true });
                        }
                    } else {
                        clearAssignment(creep, { reason: "no source", avoid: true });
                    }
                    break;
                }

                case "delivering": {
                    if (creep.store.getUsedCapacity() === 0) { clearAssignment(creep, { reason: "nothing to deliver" }); break; }

                    var aD = creep.memory.assignment;
                    var targetId2 = aD.transferTargetId || aD.taskId;
                    var target2 = Game.getObjectById(targetId2);

                    creep.say("🚚 deliver");
                    if (!target2) { clearAssignment(creep, { reason: "missing delivery target", avoid: true }); break; }

                    var resTypeD2 = RESOURCE_ENERGY;
                    if (aD.type === "materials_empty") {
                        var foundRes2 = false;
                        for (var r2 in creep.store) {
                            if (r2 !== RESOURCE_ENERGY && creep.store[r2] > 0) { resTypeD2 = r2; foundRes2 = true; break; }
                        }
                        if (!foundRes2) {
                            if (isTaskComplete(view, aD)) {
                                clearAssignment(creep, { justCompleted: true, reason: "materials below threshold (no cargo)" });
                            } else {
                                creep.memory.state = "fetching";
                                creep.say("🔄 fetch");
                            }
                            break;
                        }
                    }

                    if (target2.store && typeof target2.store.getFreeCapacity === "function") {
                        var freeNow2 = target2.store.getFreeCapacity(resTypeD2);
                        if (freeNow2 <= 0) {
                            if (aD.type === "materials_empty") {
                                var alt = null;
                                if (view.storage && (!target2 || target2.id !== view.storage.id) && view.storage.store.getFreeCapacity(resTypeD2) > 0) alt = view.storage;
                                if (!alt && view.terminal && (!target2 || target2.id !== view.terminal.id) && view.terminal.store.getFreeCapacity(resTypeD2) > 0) alt = view.terminal;

                                if (alt) {
                                    creep.memory.assignment.transferTargetId = alt.id;
                                } else {
                                    clearAssignment(creep, { reason: "no capacity for minerals", avoid: true });
                                }
                            } else if (aD.type === "fallback_dump") {
                                clearAssignment(creep, { justCompleted: true, reason: "fallback target full" });
                            } else {
                                clearAssignment(creep, { justCompleted: true, reason: "target has no free capacity" });
                            }
                            break;
                        }
                    }

                    var rng = creep.pos.getRangeTo(target2);
                    if (rng > 1) {
                        var mv2 = smartMove(creep, target2);
                        if (mv2 === ERR_NO_PATH && !inReroute) {
                            creep.memory.noPathDeliver = (creep.memory.noPathDeliver || 0) + 1;
                            if (creep.memory.noPathDeliver >= NO_PATH_DELIVER_TTL) {
                                clearAssignment(creep, { reason: "no path delivering", avoid: true });
                            }
                        } else {
                            creep.memory.noPathDeliver = 0;
                        }
                        break;
                    }

                    if (target2.store && typeof target2.store.getFreeCapacity === "function") {
                        var freeRightNow = target2.store.getFreeCapacity(resTypeD2);
                        if (freeRightNow <= 0) {
                            if (aD.type === "materials_empty") {
                                var alt2 = null;
                                if (view.storage && (!target2 || target2.id !== view.storage.id) && view.storage.store.getFreeCapacity(resTypeD2) > 0) alt2 = view.storage;
                                if (!alt2 && view.terminal && (!target2 || target2.id !== view.terminal.id) && view.terminal.store.getFreeCapacity(resTypeD2) > 0) alt2 = view.terminal;

                                if (alt2) {
                                    creep.memory.assignment.transferTargetId = alt2.id;
                                } else {
                                    clearAssignment(creep, { reason: "target full at range (minerals)", avoid: true });
                                }
                            } else if (aD.type === "fallback_dump") {
                                clearAssignment(creep, { justCompleted: true, reason: "fallback full at range" });
                            } else {
                                clearAssignment(creep, { justCompleted: true, reason: "target full at range" });
                            }
                            break;
                        }
                    }

                    var amtD2 = null;
                    if (aD.type === "link_fill") {
                        var linkCapD2 = target2.store.getCapacity(RESOURCE_ENERGY);
                        var linkEnergyD2 = target2.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                        var maxFillNowD2 = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, linkCapD2) - linkEnergyD2);
                        if (maxFillNowD2 <= 0) { clearAssignment(creep, { justCompleted: true, reason: "link filled at delivery" }); break; }
                        var plannedD2 = aD.amount != null ? aD.amount : creep.store.getUsedCapacity(RESOURCE_ENERGY);
                        amtD2 = Math.min(plannedD2, maxFillNowD2, creep.store.getUsedCapacity(RESOURCE_ENERGY));
                    }

                    var resTx = doTransfer(creep, target2, resTypeD2, amtD2);
                    if (resTx === OK || resTx === ERR_FULL) {
                        // Opportunistic extension chain: keep the assignment one more tick and try nearby extensions
                        if (aD.type === "extension") {
                            creep.memory.extOpportunistic = true;
                            // Keep state 'delivering' and do not clear; next tick the opportunistic block will attempt a neighbor
                            break;
                        }

                        var taskFinished = isTaskComplete(view, aD);
                        if (taskFinished || aD.type === "fallback_dump") {
                            clearAssignment(creep, { justCompleted: true, reason: "transfer complete" });
                        } else {
                            var shouldFetch = false;

                            if (aD.type === "materials_empty" || aD.type === "terminal_balance") {
                                shouldFetch = true;
                            } else if (creep.store.getUsedCapacity() === 0) {
                                shouldFetch = true;
                            }

                            if (shouldFetch) {
                                creep.memory.state = "fetching";
                                creep.say("🔄 fetch");
                            } else {
                                creep.memory.state = "delivering";
                            }
                        }
                    } else if (resTx === ERR_NOT_IN_RANGE) {
                        smartMove(creep, target2);
                    } else {
                        console.log(creep.name + ": Transfer failed with code " + resTx + " to " + (target2 && target2.id));
                        clearAssignment(creep, { reason: "transfer error " + resTx, avoid: true });
                    }
                    break;
                }

                case "idle": {
                    // This state should now be handled by the sleep gate at the top
                    clearAssignment(creep, { reason: "unexpected idle state" });
                    break;
                }

                default: {
                    creep.memory.state = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ? "fetching" : "delivering";
                    break;
                }
            }
        }

        // --- LOGGING (kept minimal and optional) ---
        if (SUPPLIER_LOGGING_ENABLED && Game.time % 10 === 0) {
            if (creep.memory.assignment) {
                var a = creep.memory.assignment;
                console.log("🚚 " + creep.room.name + " [" + creep.name + "] " + a.type + " task: src=" + a.taskId.slice(-6) + " dst=" + ((a.transferTargetId && a.transferTargetId.slice(-6)) || "--") + " state=" + creep.memory.state);
            } else {
                console.log("🚚 " + creep.room.name + " [" + creep.name + "] idle");
            }
        }
    }
};

module.exports = roleSupplier;
