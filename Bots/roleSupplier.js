// roleSupplier.js
// Unified single-state-machine supplier with per-room task scanner.

const SUPPLIER_ENABLED = true;
const SUPPLIER_DEBUG   = false;

// Tuning
const IDLE_SLEEP_TICKS           = 16;
const IDLE_SHORT_SLEEP           = 2;
const LINK_FILL_THRESHOLD        = 100;
const LINK_DRAIN_THRESHOLD       = 600;
const DONOR_DRAIN_THRESHOLD      = 200;
const POWER_SPAWN_FILL_THRESHOLD = 1000;
const ASSIGNMENT_TTL             = 75;   // ticks WITHOUT PROGRESS (refreshed on every successful withdraw/transfer)
const NO_PATH_TTL                = 6;
const AVOID_PAIR_TTL             = 5;
const EXT_ROUTE_SKIP_LIMIT       = 8;
const EXT_ROUTE_RECOMPUTE_TICKS  = 200;
const TERMINAL_TARGET            = 20000;
const TERMINAL_MIN               = 19500;
const TERMINAL_MAX               = 20500;

const getRoomState    = require("getRoomState");
const factoryManager  = require("factoryManager");
const labManager      = require("labManager");
const storageManager  = require("storageManager");
const terminalManager = require("terminalManager");

// ─── PRIORITIES ────────────────────────────────────────────────────────────────
// Lower number = higher priority.  Extensions are back in the table.
const TASK_PRIORITY = {
    spawn:                20,
    extension:            10,
    tower:                30,
    link_drain:           19,
    link_fill:            36,
    power_spawn_fill:     37,
    container_empty:      40,
    materials_drain_energy: 45,
    container_drain:      50,
    terminal_balance:     60,
    lab_unload:           55,
    lab_load:             56,
    market_lab_stage:     57,
    factory_input:        58,
    factory_output:       59,
    factory_drain:        61,
    terminal_stock:       68,
    dropped_pickup:       70,
};

// ─── UTILITY ───────────────────────────────────────────────────────────────────
function cheb(a, b) {
    var dx = a.x - b.x; if (dx < 0) dx = -dx;
    var dy = a.y - b.y; if (dy < 0) dy = -dy;
    return dx > dy ? dx : dy;
}

function sup_say(creep, msg) { if (SUPPLIER_DEBUG) creep.say(msg); }

// ─── HEAP ──────────────────────────────────────────────────────────────────────
function getHeap(name) {
    if (!global._supHeap) global._supHeap = {};
    if (!global._supHeap[name]) {
        global._supHeap[name] = {
            stuckCount: 0, lastPos: null, lastTriedMoveTick: 0,
            rerouteUntil: 0, noPathCount: 0, fetchSourceId: null,
            avoidPairs: [],
            lastCompletedTick: 0, lastCompletedType: null,
            lastCompletedTaskId: null, lastCompletedTargetId: null,
            consecutiveIdlePicks: 0,
            extRoute: null, extRouteTick: 0,
        };
    }
    return global._supHeap[name];
}

function pruneHeap() {
    if (!global._supHeap || global._supHeapTick === Game.time) return;
    global._supHeapTick = Game.time;
    var names = Object.keys(global._supHeap);
    for (var i = 0; i < names.length; i++) {
        if (!Game.creeps[names[i]]) delete global._supHeap[names[i]];
    }
    // Also prune the extension waypoint cache for rooms we can't see
    if (global._extWpMapCache) {
        for (var roomName in global._extWpMapCache) {
            if (!Game.rooms[roomName]) delete global._extWpMapCache[roomName];
        }
    }
}

// ─── AVOID PAIRS (heap) ───────────────────────────────────────────────────────
function pruneAvoids(h) {
    var a = h.avoidPairs, kept = [];
    for (var i = 0; i < a.length; i++) {
        if (Game.time <= a[i].until) kept.push(a[i]);
    }
    h.avoidPairs = kept;
}

function addAvoid(h, type, taskId, targetId) {
    h.avoidPairs.push({ type: type, taskId: taskId, targetId: targetId || taskId, until: Game.time + AVOID_PAIR_TTL - 1 });
}

function isAvoided(h, type, taskId, targetId) {
    var a = h.avoidPairs, tt = targetId || taskId;
    for (var i = 0; i < a.length; i++) {
        var it = a[i];
        if (Game.time > it.until) continue;
        if (it.type === type && it.taskId === taskId && (it.targetId || it.taskId) === tt) return true;
    }
    return false;
}

function hasActiveAvoids(h) {
    var a = h.avoidPairs;
    for (var i = 0; i < a.length; i++) {
        if (Game.time <= a[i].until) return true;
    }
    return false;
}

// ─── PACKED ASSIGNMENT ─────────────────────────────────────────────────────────
function packAssignment(a) {
    if (!a) return null;
    return a.type + '|' + a.taskId + '|' + (a.targetId || '') + '|' +
           (a.amount || 0) + '|' + (a.assignedTick || 0) + '|' +
           (a.extra || '');
}

function unpackAssignment(raw) {
    if (!raw) return null;
    var p = raw.split('|');
    return {
        type: p[0], taskId: p[1], targetId: p[2] || null,
        amount: +p[3] || 0, assignedTick: +p[4] || 0,
        extra: p[5] || ''
    };
}

// Per-tick cache so we only unpack once
function getAssignment(creep) {
    var h = getHeap(creep.name);
    if (h._aTick === Game.time) return h._aCache;
    h._aCache = unpackAssignment(creep.memory.a);
    h._aTick = Game.time;
    return h._aCache;
}

function setAssignment(creep, a) {
    var h = getHeap(creep.name);
    creep.memory.a = packAssignment(a);
    h._aCache = a;
    h._aTick = Game.time;
    // Bust the claim cache so other creeps see this
    if (global._taskClaimCache) delete global._taskClaimCache[creep.room.name];
}

function clearAssignment(creep, reason, shouldAvoid) {
    var a = getAssignment(creep);
    var h = getHeap(creep.name);
    if (shouldAvoid && a && a.type) {
        addAvoid(h, a.type, a.taskId, a.targetId);
        h.lastCompletedTick = Game.time;
        h.lastCompletedType = a.type;
        h.lastCompletedTaskId = a.taskId;
        h.lastCompletedTargetId = a.targetId;
    }
    setAssignment(creep, null);
    creep.memory.s = "idle";
    h.noPathCount = 0;
    h.fetchSourceId = null;
    delete creep.memory.sl;
    delete creep.memory._move;
    if (SUPPLIER_DEBUG) console.log("[SUP] " + creep.name + " clear: " + reason);
}

// Mark progress on the current assignment so the TTL only fires for tasks
// that are genuinely stalled, not for long multi-trip jobs (terminal balance,
// power spawn fill, big tower top-ups) that are actively making round trips.
function refreshProgress(creep, a) {
    if (!a) return;
    a.assignedTick = Game.time;
    setAssignment(creep, a);
}

// ─── MOVEMENT ──────────────────────────────────────────────────────────────────
function smartMove(creep, target, extraOpts) {
    var h = getHeap(creep.name);
    if (creep.fatigue > 0) return ERR_TIRED;
    if (h.lastTriedMoveTick === Game.time) return ERR_BUSY;

    var pos = target.pos || target;
    var dist = cheb(creep.pos, pos);
    var inReroute = Game.time < h.rerouteUntil;
    var opts = {
        reusePath: inReroute ? 0 : Math.min(10, Math.max(3, dist >> 1)),
        maxOps: Math.min(2000, Math.max(200, dist * 50)),
        heuristicWeight: 1.2,
        range: 1
    };
    if (extraOpts) { for (var k in extraOpts) opts[k] = extraOpts[k]; }

    h.lastTriedMoveTick = Game.time;
    var res = creep.moveTo(pos, opts);
    if (res === ERR_NO_PATH && !inReroute) {
        h.rerouteUntil = Game.time + 3;
        delete creep.memory._move;
    }
    return res;
}

// ─── ROOM VIEW (cached per tick, lazy validation) ──────────────────────────────
function ensureRoomStateInit() {
    if (getRoomState && typeof getRoomState.init === "function") {
        if (global._rsInitTick !== Game.time) {
            getRoomState.init();
            global._rsInitTick = Game.time;
        }
    }
}

function getRoomView(room) {
    if (global._rvTick !== Game.time) { global._rvTick = Game.time; global._rvCache = {}; }
    if (global._rvCache[room.name]) return global._rvCache[room.name];

    ensureRoomStateInit();
    var base = getRoomState.get(room.name);
    if (!base) return null;

    var sbt = base.structuresByType || {};

    function resolve(type, filter) {
        var arr = sbt[type] || [];
        if (!filter) return arr;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            if (filter(arr[i])) out.push(arr[i]);
        }
        return out;
    }

    var view = {
        roomName:     room.name,
        controller:   room.controller,
        storage:      room.storage,
        terminal:     room.terminal,
        containers:   resolve(STRUCTURE_CONTAINER),
        spawns:       resolve(STRUCTURE_SPAWN,       function(s) { return s.my; }),
        extractors:   resolve(STRUCTURE_EXTRACTOR,   function(e) { return e.my; }),
        sources:      base.sources || [],
        towers:       resolve(STRUCTURE_TOWER,        function(t) { return t.my; }),
        links:        resolve(STRUCTURE_LINK,         function(l) { return l.my; }),
        extensions:   resolve(STRUCTURE_EXTENSION,    function(e) { return e.my; }),
        labs:         resolve(STRUCTURE_LAB,          function(l) { return l.my; }),
        powerSpawns:  resolve(STRUCTURE_POWER_SPAWN,  function(s) { return s.my; }),
        nukers:       resolve(STRUCTURE_NUKER,        function(n) { return n.my; }),
        factory:      resolve(STRUCTURE_FACTORY,     function(f) { return f.my; })[0] || null,
        suppliers:    (base.myCreeps || []).filter(function(c) { return c.memory && c.memory.role === "supplier"; }),
        towerFillers: (base.myCreeps || []).filter(function(c) { return c.memory && c.memory.role === "towerFiller"; }),
    };

    global._rvCache[room.name] = view;
    return view;
}

// ─── CONTAINER LABELING ────────────────────────────────────────────────────────
function ensureContainerLabels(room, view) {
    if (!view) return;
    var mem = room.memory;
    if (!mem.containerLabels) mem.containerLabels = {};

    var cKey = view.containers.map(function(c) { return c.id; }).sort().join(',') + ':' +
               view.links.map(function(l) { return l.id; }).sort().join(',');

    if (mem._clKey === cKey && Game.time % 1000 !== 0) return;

    var labels = {}, blacklist = {};
    var srcLinks = {};
    for (var si = 0; si < view.sources.length; si++) {
        for (var li = 0; li < view.links.length; li++) {
            if (cheb(view.links[li].pos, view.sources[si].pos) <= 2) {
                srcLinks[view.sources[si].id] = true; break;
            }
        }
    }

    for (var i = 0; i < view.containers.length; i++) {
        var c = view.containers[i];
        if (c.pos.findInRange(view.extractors, 1).length > 0) {
            labels[c.id] = "materials";
        } else if (view.controller && cheb(c.pos, view.controller.pos) <= 2) {
            labels[c.id] = "recipient";
        } else if (c.pos.findInRange(view.sources, 4).length > 0) {
            labels[c.id] = "donor";
            for (var s2 = 0; s2 < view.sources.length; s2++) {
                if (cheb(c.pos, view.sources[s2].pos) <= 2 && srcLinks[view.sources[s2].id]) {
                    blacklist[c.id] = true; break;
                }
            }
        } else {
            labels[c.id] = "recipient";
        }
    }

    mem.containerLabels = labels;
    mem.linkServedBlacklist = blacklist;
    mem._clKey = cKey;
}

function getLabel(room, id) { return (room.memory.containerLabels || {})[id]; }
function isLinkServed(room, id) { return (room.memory.linkServedBlacklist || {})[id] === true; }

// ─── CLAIM CACHE ───────────────────────────────────────────────────────────────
// Lets us check "is another supplier already on this task?" in O(1).
function getClaimCache(view) {
    if (global._taskClaimTick !== Game.time) {
        global._taskClaimTick = Game.time;
        global._taskClaimCache = {};
    }
    if (global._taskClaimCache[view.roomName]) return global._taskClaimCache[view.roomName];

    var claims = {};  // "type|taskId|targetId" → creepName
    for (var i = 0; i < view.suppliers.length; i++) {
        var s = view.suppliers[i];
        var a = getAssignment(s);
        if (a && a.type) {
            claims[a.type + '|' + a.taskId + '|' + (a.targetId || '')] = s.name;
        }
    }
    global._taskClaimCache[view.roomName] = claims;
    return claims;
}

function isClaimed(view, creep, type, taskId, targetId) {
    var c = getClaimCache(view);
    var owner = c[type + '|' + taskId + '|' + (targetId || '')];
    return owner && owner !== creep.name;
}

function getFactoryTaskResource(a) {
    return parseExtra(a && a.extra, "res") || parseExtra(a && a.extra, "resource");
}

function getMarketLabStageResource(a) {
    return parseExtra(a && a.extra, "res") || parseExtra(a && a.extra, "resource");
}

function getLabTaskResource(a) {
    return parseExtra(a && a.extra, "res") || parseExtra(a && a.extra, "resource");
}

function getLabTaskLabId(a) {
    return parseExtra(a && a.extra, "lab");
}

function getTerminalStockResource(a) {
    return parseExtra(a && a.extra, "res") || parseExtra(a && a.extra, "resource");
}

function getCarriedFactoryInputResource(creep, recipe) {
    if (!creep || !recipe || !recipe.inputs) return null;
    var keys = Object.keys(creep.store);
    for (var i = 0; i < keys.length; i++) {
        var res = keys[i];
        if ((creep.store[res] || 0) <= 0) continue;
        if (recipe.inputs[res] !== undefined) return res;
    }
    return null;
}

function recoverFactoryInputAssignment(creep, view) {
    if (!creep || !view || !view.factory) return false;

    var activeOrder = getActiveFactoryOrder(view.roomName);
    if (!activeOrder) return false;

    var recipe = factoryManager.getRecipe(activeOrder.product);
    if (!recipe || !recipe.inputs) return false;

    var carriedRes = getCarriedFactoryInputResource(creep, recipe);
    if (!carriedRes) return false;

    var desiredTaskId = activeOrder.id + ':' + carriedRes;
    var curA = getAssignment(creep);
    if (curA && curA.type !== 'factory_input') return false;
    if (curA && curA.type === 'factory_input' && curA.taskId === desiredTaskId && curA.targetId === view.factory.id) {
        return false;
    }

    setAssignment(creep, {
        type: 'factory_input',
        taskId: desiredTaskId,
        targetId: view.factory.id,
        amount: creep.store[carriedRes] || 0,
        assignedTick: Game.time,
        extra: 'res=' + carriedRes + (activeOrder.reservationProgram ? ',program=' + activeOrder.reservationProgram : '')
    });
    creep.memory.s = 'delivering';
    delete creep.memory.sl;
    return true;
}

function findTerminalOpById(opId) {
    var ops = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
    for (var i = 0; i < ops.length; i++) {
        if (ops[i] && ops[i].id === opId) return ops[i];
    }
    return null;
}

function getLabOrder(roomName) {
    var rm = Memory.labOrders && Memory.labOrders[roomName];
    return rm && rm.active ? rm.active : null;
}

function getMarketLabLayout(room, order) {
    if (!room || !order || !labManager) return null;
    if (order.type === 'breakdown' && typeof labManager.getBreakdownLayout === 'function') {
        return labManager.getBreakdownLayout(room);
    }
    if (typeof labManager.getLayout === 'function') return labManager.getLayout(room);
    return null;
}

function getLayoutLabs(layout) {
    var labs = [], seen = {};
    if (!layout || !layout.groups) return labs;
    function add(lab) {
        if (!lab || seen[lab.id]) return;
        seen[lab.id] = true;
        labs.push(lab);
    }
    for (var g = 0; g < layout.groups.length; g++) {
        var group = layout.groups[g];
        add(group.in1);
        add(group.in2);
        for (var i = 0; i < group.outs.length; i++) add(group.outs[i]);
    }
    return labs;
}

function labHasMineral(lab) {
    return lab && (lab.mineralAmount || 0) > 0 && lab.mineralType;
}

function chooseLabLoadSource(room, resourceType, reservationProgram) {
    if (!room || !resourceType) return null;
    var storage = room.storage;
    var terminal = room.terminal;
    var terminalAvail = terminal ? (terminal.store[resourceType] || 0) : 0;
    var storageAvail = storage ? (storage.store[resourceType] || 0) : 0;
    var terminalReserved = reservationProgram ? getProgramReserved(room.name, resourceType, reservationProgram, 'terminal') : 0;
    var storageReserved = reservationProgram ? getProgramReserved(room.name, resourceType, reservationProgram, 'storage') : 0;

    if (reservationProgram && terminalReserved > 0 && terminalAvail > 0) return terminal;
    if (reservationProgram && storageReserved > 0 && storageAvail > 0) return storage;
    if (terminalAvail > 0) return terminal;
    if (storageAvail > 0) return storage;
    return null;
}

function getProgramReserved(roomName, material, program, building) {
    if (!roomName || !material || !program || !building) return 0;
    var info = storageManager.storageFind(roomName, material);
    var bucket = info && info[building] && Array.isArray(info[building].reservations)
        ? info[building].reservations : [];
    for (var i = 0; i < bucket.length; i++) {
        if (bucket[i] && bucket[i].program === program) return bucket[i].amount || 0;
    }
    return 0;
}

function consumeProgramReservation(roomName, material, program, building, amount) {
    if (!roomName || !material || !program || !building || !amount) return;
    storageManager.consume(roomName, material, building, program, amount);
}

function getActiveFactoryOrder(roomName) {
    var orders = Memory.factoryOrders || [];
    for (var i = 0; i < orders.length; i++) {
        var order = orders[i];
        if (order && order.room === roomName && order.status === "active") return order;
    }
    return null;
}

function chooseFactorySink(room) {
    if (!room) return null;
    if (room.storage && room.storage.store.getFreeCapacity() > 0) return room.storage;
    if (room.terminal && room.terminal.store.getFreeCapacity() > 0) return room.terminal;
    return null;
}

function chooseFactorySource(room, resourceType, reservationProgram) {
    if (!room || !resourceType) return null;

    var storage = room.storage;
    var terminal = room.terminal;
    var storageAvail = storage ? (storage.store[resourceType] || 0) : 0;
    var terminalAvail = terminal ? (terminal.store[resourceType] || 0) : 0;
    var storageReserved = reservationProgram ? getProgramReserved(room.name, resourceType, reservationProgram, 'storage') : 0;
    var terminalReserved = reservationProgram ? getProgramReserved(room.name, resourceType, reservationProgram, 'terminal') : 0;

    if (reservationProgram && storageReserved > 0 && storageAvail > 0) return storage;
    if (reservationProgram && terminalReserved > 0 && terminalAvail > 0) return terminal;
    if (storageAvail > 0) return storage;
    if (terminalAvail > 0) return terminal;
    return null;
}

function factoryCycleInputTotal(factory, recipe) {
    if (!factory || !factory.store || !recipe || !recipe.inputs) return 0;
    var total = 0;
    for (var res in recipe.inputs) total += factory.store[res] || 0;
    return total;
}

function factoryCycleTargetTotal(order, recipe) {
    if (!order || !recipe || !recipe.inputs) return 0;
    var batches = Math.max(0, order.cycleBatches || 0);
    var total = 0;
    for (var res in recipe.inputs) total += (recipe.inputs[res] || 0) * batches;
    return total;
}

function factoryInputLoadBudget(factory, order, recipe) {
    var remainingInput = Math.max(0, factoryCycleTargetTotal(order, recipe) - factoryCycleInputTotal(factory, recipe));
    var free = factory && factory.store && factory.store.getFreeCapacity ? (factory.store.getFreeCapacity() || 0) : remainingInput;
    return Math.max(0, Math.min(remainingInput, free));
}

function factoryInputDeficit(factory, order, recipe, resourceType) {
    if (!factory || !factory.store || !order || !recipe || !recipe.inputs || recipe.inputs[resourceType] === undefined) return 0;
    var need = (recipe.inputs[resourceType] || 0) * Math.max(0, order.cycleBatches || 0);
    return Math.max(0, need - (factory.store[resourceType] || 0));
}

// ─── ENERGY CAPACITY HELPER ────────────────────────────────────────────────────
function getEnergyCapacity(creep) {
    return creep.store.getCapacity(RESOURCE_ENERGY) ||
           creep.store.getCapacity() ||
           (creep.store.getFreeCapacity() + creep.store.getUsedCapacity()) || 0;
}

// ─── EXTENSION WAYPOINT CACHE (room level, recomputed when empties change) ─────
function getExtWpMap(room, emptyExts) {
    var roomName = room.name;
    if (!global._extWpMapCache) global._extWpMapCache = {};
    if (!global._extWpMapCache[roomName]) global._extWpMapCache[roomName] = {};

    // Build a stable key from sorted ids
    var key = emptyExts.map(e => e.id).sort().join(',');
    if (global._extWpMapCache[roomName].key === key) return global._extWpMapCache[roomName].map;

    var map = {};
    var candidates = {};
    var terrain = room.getTerrain();

    for (var i = 0; i < emptyExts.length; i++) {
        var ext = emptyExts[i];
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                var x = ext.pos.x + dx, y = ext.pos.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

                // Lightweight passability: reject tiles with any non‑road, non‑container structure
                var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
                var blocked = false;
                for (var si = 0; si < structs.length; si++) {
                    var st = structs[si].structureType;
                    if (st !== STRUCTURE_ROAD && st !== STRUCTURE_CONTAINER) {
                        blocked = true; break;
                    }
                }
                if (blocked) continue;

                var tileKey = x + ',' + y;
                if (!candidates[tileKey]) candidates[tileKey] = [];
                candidates[tileKey].push(ext.id);
            }
        }
    }

    if (Object.keys(candidates).length === 0) {
        // Fallback: every extension becomes its own waypoint
        for (var j = 0; j < emptyExts.length; j++) {
            var id = emptyExts[j].id;
            map[id] = { x: emptyExts[j].pos.x, y: emptyExts[j].pos.y };
        }
    } else {
        // Greedy set cover: pick the tile that serves the most uncovered extensions
        var uncovered = emptyExts.map(e => e.id);
        while (uncovered.length > 0) {
            var bestKey = null, bestCount = 0;
            for (var cKey in candidates) {
                var covered = [];
                var ids = candidates[cKey];
                for (var k = 0; k < ids.length; k++) {
                    if (uncovered.indexOf(ids[k]) !== -1) covered.push(ids[k]);
                }
                if (covered.length > bestCount || (covered.length === bestCount && bestKey === null)) {
                    bestCount = covered.length;
                    bestKey = cKey;
                }
            }
            if (!bestKey) break;

            var parts = bestKey.split(',');
            var wp = { x: +parts[0], y: +parts[1] };
            var served = candidates[bestKey].filter(function(id) { return uncovered.indexOf(id) !== -1; });
            for (var s = 0; s < served.length; s++) {
                map[served[s]] = wp;
                var idx = uncovered.indexOf(served[s]);
                if (idx !== -1) uncovered.splice(idx, 1);
            }
        }
        // Any leftover (shouldn't happen) → own position
        for (var u = 0; u < uncovered.length; u++) {
            var fallExt = Game.getObjectById(uncovered[u]);
            if (fallExt) map[uncovered[u]] = { x: fallExt.pos.x, y: fallExt.pos.y };
        }
    }

    global._extWpMapCache[roomName] = { key: key, map: map };
    return map;
}

// ════════════════════════════════════════════════════════════════════════════════
//  TASK SCANNER — runs ONCE per room per tick, returns sorted task list
// ════════════════════════════════════════════════════════════════════════════════
// Each task: { type, taskId, targetId, amount, priority, extra? }
// "extra" carries type-specific metadata (minDrainEnergy, minCapacity, etc.)

function scanRoomTasks(room, view) {
    if (global._scanTick !== Game.time) { global._scanTick = Game.time; global._scanCache = {}; }
    if (global._scanCache[room.name]) return global._scanCache[room.name];

    ensureContainerLabels(room, view);
    var tasks = [];

    function emit(t) { if (t) tasks.push(t); }

    var rcl8 = view.controller && view.controller.level >= 8;

    // ── SPAWNS ──────────────────────────────────────────────────────────────
    for (var si = 0; si < view.spawns.length; si++) {
        var sp = view.spawns[si];
        var spFree = sp.store.getFreeCapacity(RESOURCE_ENERGY);
        if (spFree <= 0) continue;
        if (rcl8 && (sp.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
        var nearSrc = false;
        for (var s2 = 0; s2 < view.sources.length; s2++) {
            if (cheb(sp.pos, view.sources[s2].pos) <= 2) { nearSrc = true; break; }
        }
        if (nearSrc) continue;
        tasks.push({ type: "spawn", taskId: sp.id, targetId: sp.id,
                      amount: spFree, priority: TASK_PRIORITY.spawn });
    }

    // ── EXTENSIONS (single task — route handles ordering) ───────────────────
    var emptyExtCount = 0, totalExtNeed = 0;
    var emptyExts = [];
    for (var ei = 0; ei < view.extensions.length; ei++) {
        var ext = view.extensions[ei];
        var free = ext.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (free <= 0) continue;
        if (rcl8 && (ext.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
        emptyExtCount++;
        totalExtNeed += free;
        emptyExts.push(ext);
    }
    if (emptyExtCount > 0) {
        if (!view._extWpMap) view._extWpMap = getExtWpMap(room, emptyExts);
        view._emptyExts = emptyExts;
        tasks.push({ type: "extension", taskId: "ext_" + room.name, targetId: null,
                      amount: totalExtNeed, priority: TASK_PRIORITY.extension });
    }

    // ── TOWERS ──────────────────────────────────────────────────────────────
    if (view.towerFillers.length === 0) {
        for (var ti = 0; ti < view.towers.length; ti++) {
            var tw = view.towers[ti];
            var twFree = tw.store.getFreeCapacity(RESOURCE_ENERGY);
            var twRatio = (tw.store[RESOURCE_ENERGY] || 0) / tw.store.getCapacity(RESOURCE_ENERGY);
            if (twFree <= 0 || twRatio >= 0.75) continue;
            tasks.push({ type: "tower", taskId: tw.id, targetId: tw.id,
                          amount: twFree, priority: TASK_PRIORITY.tower });
        }
    }

    // ── LINKS (fill / drain — only storage-adjacent hub link) ───────────────
    if (view.storage) {
        var stor = view.storage;
        var storE = stor.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

        linkScan: for (var li = 0; li < view.links.length; li++) {
            var lnk = view.links[li];
            if (cheb(lnk.pos, stor.pos) > 2) continue;
            if (view.controller && cheb(lnk.pos, view.controller.pos) <= 2) continue;
            for (var ls = 0; ls < view.sources.length; ls++) {
                if (cheb(view.sources[ls].pos, lnk.pos) <= 2) continue linkScan;
            }

            var lnkE = lnk.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

            if (lnkE > LINK_DRAIN_THRESHOLD && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                var drainAmt = Math.min(lnkE - LINK_FILL_THRESHOLD, stor.store.getFreeCapacity(RESOURCE_ENERGY));
                if (drainAmt > 0) {
                    tasks.push({ type: "link_drain", taskId: lnk.id, targetId: stor.id,
                                  amount: drainAmt, priority: TASK_PRIORITY.link_drain });
                }
            }

            if (lnkE < LINK_FILL_THRESHOLD && storE >= 500) {
                var fillAmt = Math.min(LINK_DRAIN_THRESHOLD - lnkE, storE,
                                        lnk.store.getFreeCapacity(RESOURCE_ENERGY));
                if (fillAmt > 100) {
                    tasks.push({ type: "link_fill", taskId: stor.id, targetId: lnk.id,
                                  amount: fillAmt, priority: TASK_PRIORITY.link_fill });
                }
            }
        }
    }

    // ── POWER SPAWNS ────────────────────────────────────────────────────────
    for (var pi = 0; pi < view.powerSpawns.length; pi++) {
        var ps = view.powerSpawns[pi];
        if ((ps.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= POWER_SPAWN_FILL_THRESHOLD) {
            tasks.push({ type: "power_spawn_fill", taskId: ps.id, targetId: ps.id,
                          amount: ps.store.getFreeCapacity(RESOURCE_ENERGY),
                          priority: TASK_PRIORITY.power_spawn_fill });
        }
    }

    // ── CONTAINERS ──────────────────────────────────────────────────────────
    var labels = room.memory.containerLabels || {};
    var donors = [], materials = [];
    for (var ci = 0; ci < view.containers.length; ci++) {
        var cn = view.containers[ci], lb = labels[cn.id];
        if (lb === "donor") donors.push(cn);
        else if (lb === "materials") materials.push(cn);
    }

    for (var di = 0; di < donors.length; di++) {
        var don = donors[di];
        var donE = don.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (donE < DONOR_DRAIN_THRESHOLD) continue;
        if (isLinkServed(room, don.id)) continue;

        var drainTgt = null;
        if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            drainTgt = view.storage;
        } else {
            for (var cj = 0; cj < view.containers.length; cj++) {
                var tgt = view.containers[cj];
                if (tgt.id === don.id) continue;
                var tgtL = labels[tgt.id];
                if (tgtL === "donor" || tgtL === "materials") continue;
                if (tgt.store.getFreeCapacity(RESOURCE_ENERGY) > 0) { drainTgt = tgt; break; }
            }
        }
        if (!drainTgt) continue;

        tasks.push({ type: "container_drain", taskId: don.id, targetId: drainTgt.id,
                      amount: Math.min(donE, drainTgt.store.getFreeCapacity(RESOURCE_ENERGY)),
                      priority: TASK_PRIORITY.container_drain,
                      extra: "mde=" + DONOR_DRAIN_THRESHOLD });
    }

    if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        for (var ce = 0; ce < view.containers.length; ce++) {
            var co = view.containers[ce], coL = labels[co.id];
            if (coL === "materials") continue;
            if (coL === "donor") {
                if ((co.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= DONOR_DRAIN_THRESHOLD) continue;
                if (isLinkServed(room, co.id)) continue;
            }
            if (isLinkServed(room, co.id)) continue;
            var coE = co.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
            if (coE < 50) continue;
            tasks.push({ type: "container_empty", taskId: co.id, targetId: view.storage.id,
                          amount: coE, priority: TASK_PRIORITY.container_empty });
        }
    }

    for (var mi = 0; mi < materials.length; mi++) {
        var mc = materials[mi];
        var mcE = mc.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (mcE <= 0) continue;
        var mTgt = null;
        if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) mTgt = view.storage;
        else {
            for (var mti = 0; mti < view.towers.length; mti++) {
                if (view.towers[mti].store.getFreeCapacity(RESOURCE_ENERGY) > 0) { mTgt = view.towers[mti]; break; }
            }
        }
        if (!mTgt) break;
        tasks.push({ type: "materials_drain_energy", taskId: mc.id, targetId: mTgt.id,
                      amount: mcE, priority: TASK_PRIORITY.materials_drain_energy });
    }

    // ── TERMINAL BALANCE ────────────────────────────────────────────────────
    if (view.storage && view.terminal) {
        var tE = view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var roomBusy = terminalManager && typeof terminalManager.isRoomBusyWithTransfer === "function"
                       && terminalManager.isRoomBusyWithTransfer(view.roomName);

        if (tE > TERMINAL_MAX && !roomBusy && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            tasks.push({ type: "terminal_balance", taskId: view.terminal.id, targetId: view.storage.id,
                          amount: Math.min(tE - TERMINAL_TARGET, view.storage.store.getFreeCapacity(RESOURCE_ENERGY)),
                          priority: TASK_PRIORITY.terminal_balance });
        }
        if (tE < TERMINAL_MIN && view.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            var tbAmt = Math.min(TERMINAL_TARGET - tE,
                                  view.storage.store.getUsedCapacity(RESOURCE_ENERGY),
                                  view.terminal.store.getFreeCapacity(RESOURCE_ENERGY));
            if (tbAmt > 0) {
                tasks.push({ type: "terminal_balance", taskId: view.storage.id, targetId: view.terminal.id,
                              amount: tbAmt, priority: TASK_PRIORITY.terminal_balance });
            }
        }
    }

    // ── TERMINAL STOCK (small local moves via supplier) ─────────────────────
    if (view.storage && view.terminal && terminalManager && typeof terminalManager.getSupplierTasks === "function") {
        var supplierTasks = terminalManager.getSupplierTasks(view.roomName);
        for (var sti = 0; sti < supplierTasks.length; sti++) {
            var st = supplierTasks[sti];
            if (!st || st.amount <= 0) continue;
            var stOp = findTerminalOpById(st.opId);
            if (!stOp || stOp.status === 'completed' || stOp.status === 'failed') continue;
            var stRemaining = Math.max(0, stOp.amount - (stOp.amountMoved || 0));
            if (stRemaining <= 0) continue;

            var stSource = st.type === 'toTerminal' ? view.storage : view.terminal;
            var stTarget = st.type === 'toTerminal' ? view.terminal : view.storage;
            if (!stSource || !stTarget || !stSource.store || !stTarget.store) continue;

            var stAvailable = stSource.store.getUsedCapacity(st.resourceType) || 0;
            var stFree = stTarget.store.getFreeCapacity(st.resourceType) || 0;
            if (stAvailable <= 0 || stFree <= 0) continue;

            var stAmt = Math.min(stRemaining, stAvailable, stFree);
            if (stAmt <= 0) continue;
            tasks.push({
                type: 'terminal_stock',
                taskId: stSource.id,
                targetId: stTarget.id,
                amount: stAmt,
                priority: TASK_PRIORITY.terminal_stock,
                extra: 'res=' + st.resourceType + ',op=' + st.opId + ',program=' + (st.reservationProgram || '') + ',type=' + st.type
            });
        }
    }

    // ── MARKET LAB ACTIVE ORDER LOGISTICS ─────────────────────────────────
    // Lab manager owns the exact load/unload jobs for marketLab-origin orders.
    if (labManager && typeof labManager.getSupplierLabTasks === "function") {
        var labTasks = labManager.getSupplierLabTasks(view.roomName) || [];
        for (var lt = 0; lt < labTasks.length; lt++) tasks.push(labTasks[lt]);
    }

    // ── MARKET LAB STAGING ───────────────────────────────────────────────
    if (view.storage && view.terminal) {
        var marketLabQueues = [];
        if (Memory.marketLabForward && Memory.marketLabForward.rooms && Memory.marketLabForward.rooms[view.roomName]) {
            marketLabQueues.push(Memory.marketLabForward.rooms[view.roomName]);
        }
        if (Memory.marketLabReverse && Memory.marketLabReverse.rooms && Memory.marketLabReverse.rooms[view.roomName]) {
            marketLabQueues.push(Memory.marketLabReverse.rooms[view.roomName]);
        }

        for (var qi = 0; qi < marketLabQueues.length; qi++) {
            var queue = marketLabQueues[qi];
            for (var oi = 0; oi < queue.length; oi++) {
                var op = queue[oi];
                if (!op || op.state !== 'STAGING' || !op.expectedOutputs) continue;

                for (var res in op.expectedOutputs) {
                    if (!op.expectedOutputs.hasOwnProperty(res)) continue;
                    var expected = op.expectedOutputs[res] || 0;
                    if (expected <= 0) continue;

                    var stageProgram = op.stageReservationProgram || null;
                    var terminalHave = view.terminal.store[res] || 0;
                    var storageHave = view.storage.store[res] || 0;
                    var reserved = stageProgram ? getProgramReserved(view.roomName, res, stageProgram, 'storage') : 0;
                    var remaining = Math.max(0, expected - terminalHave);
                    var free = view.terminal.store.getFreeCapacity(res) || 0;
                    var amount = Math.min(remaining, storageHave, free);
                    if (amount <= 0) continue;

                    tasks.push({
                        type: 'market_lab_stage',
                        taskId: 'market_lab_stage:' + op.id + ':' + res,
                        targetId: view.terminal.id,
                        amount: amount,
                        priority: TASK_PRIORITY.market_lab_stage,
                        extra: 'res=' + res + ',op=' + op.id + (stageProgram ? ',program=' + stageProgram : '') + ',reserved=' + reserved
                    });
                }
            }
        }
    }

    // ── FACTORY LOGISTICS ──────────────────────────────────────────────────
    if (view.factory) {
        var factory = view.factory;
        var activeOrder = getActiveFactoryOrder(view.roomName);
        var sink = chooseFactorySink(room);

        if (activeOrder) {
            var recipe = factoryManager.getRecipe(activeOrder.product);
            var phase = activeOrder.phase || "loading";
            if (recipe && recipe.inputs) {
                if (phase === "loading") {
                    var cycleBatches = activeOrder.cycleBatches || 0;
                    for (var storedResLoad in factory.store) {
                        if ((factory.store[storedResLoad] || 0) <= 0) continue;
                        if (!sink) break;

                        var excess = 0;
                        var keepAmount = 0;
                        if (recipe.inputs[storedResLoad] !== undefined && recipe.inputs[storedResLoad] > 0) {
                            var targetInput = (recipe.inputs[storedResLoad] || 0) * cycleBatches;
                            keepAmount = targetInput;
                            excess = Math.max(0, (factory.store[storedResLoad] || 0) - targetInput);
                            if (excess <= 0) continue;
                        } else {
                            excess = factory.store[storedResLoad] || 0;
                        }

                        tasks.push({
                            type: "factory_drain",
                            taskId: activeOrder.id + ":loaddrain:" + storedResLoad,
                            targetId: sink.id,
                            amount: excess,
                            priority: TASK_PRIORITY.factory_input - 1,
                            extra: "res=" + storedResLoad + ",keep=" + keepAmount
                        });
                    }

                    var loadBudget = factoryInputLoadBudget(factory, activeOrder, recipe);
                    for (var resType in recipe.inputs) {
                        var perBatch = recipe.inputs[resType] || 0;
                        if (perBatch <= 0 || cycleBatches <= 0 || loadBudget <= 0) continue;
                        var need = perBatch * cycleBatches;
                        var have = factory.store[resType] || 0;
                        var deficit = Math.max(0, need - have);
                        if (deficit <= 0) continue;
                        var src = chooseFactorySource(room, resType, activeOrder.reservationProgram);
                        var srcAvailable = src ? (src.store[resType] || 0) : 0;
                        if (srcAvailable <= 0) continue;
                        var loadAmount = Math.min(deficit, srcAvailable, loadBudget);
                        if (loadAmount <= 0) continue;

                        tasks.push({
                            type: "factory_input",
                            taskId: activeOrder.id + ":" + resType,
                            targetId: factory.id,
                            amount: loadAmount,
                            priority: TASK_PRIORITY.factory_input,
                            extra: "res=" + resType + (activeOrder.reservationProgram ? ",program=" + activeOrder.reservationProgram : "")
                        });
                        loadBudget -= loadAmount;
                    }
                } else if (phase === "unloading") {
                    if ((factory.store[activeOrder.product] || 0) > 0 && sink) {
                        tasks.push({
                            type: "factory_output",
                            taskId: activeOrder.id + ":product",
                            targetId: sink.id,
                            amount: factory.store[activeOrder.product] || 0,
                            priority: TASK_PRIORITY.factory_output,
                            extra: "res=" + activeOrder.product
                        });
                    }

                    for (var storedRes in factory.store) {
                        if ((factory.store[storedRes] || 0) <= 0) continue;
                        if (storedRes === activeOrder.product) continue;
                        if (!sink) break;
                        tasks.push({
                            type: "factory_drain",
                            taskId: activeOrder.id + ":drain:" + storedRes,
                            targetId: sink.id,
                            amount: factory.store[storedRes] || 0,
                            priority: TASK_PRIORITY.factory_drain,
                            extra: "res=" + storedRes
                        });
                    }
                }
            }
        } else if (sink) {
            for (var drainRes in factory.store) {
                if ((factory.store[drainRes] || 0) <= 0) continue;
                tasks.push({
                    type: "factory_drain",
                    taskId: factory.id + ":" + drainRes,
                    targetId: sink.id,
                    amount: factory.store[drainRes] || 0,
                    priority: TASK_PRIORITY.factory_drain,
                    extra: "res=" + drainRes
                });
            }
        }
    }

    // ── DROPPED ENERGY (cleanup near storage) ───────────────────────────────
    if (view.storage) {
        var roomBase = getRoomState.get(room.name);
        var droppedList = (roomBase && roomBase.dropped) || [];
        for (var dpi = 0; dpi < droppedList.length; dpi++) {
            var drop = droppedList[dpi];
            if (!drop) continue;
            try {
                if (drop.resourceType !== RESOURCE_ENERGY) continue;
                if ((drop.amount || 0) < 50) continue;
                if (cheb(drop.pos, view.storage.pos) > 4) continue;
                if (!view.storage.store.getFreeCapacity ||
                    view.storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue;
                tasks.push({ type: "dropped_pickup", taskId: drop.id, targetId: view.storage.id,
                              amount: drop.amount, priority: TASK_PRIORITY.dropped_pickup });
            } catch (e) {
                // Cached Resource object went stale (decayed/picked up) before this tick.
                continue;
            }
        }
    }

    // ── SORT BY PRIORITY ────────────────────────────────────────────────────
    var custom = room.memory.supplierPriorities;
    tasks.sort(function(a, b) {
        var pa = (custom && custom[a.type] != null) ? custom[a.type] : a.priority;
        var pb = (custom && custom[b.type] != null) ? custom[b.type] : b.priority;
        return pa - pb;
    });

    global._scanCache[room.name] = tasks;
    return tasks;
}

// ════════════════════════════════════════════════════════════════════════════════
//  TASK PICKER — pick highest-priority unclaimed task for this creep
// ════════════════════════════════════════════════════════════════════════════════

function pickTask(creep, view, h) {
    var tasks = scanRoomTasks(creep.room, view);
    var energyUsed = creep.store.getUsedCapacity(RESOURCE_ENERGY);

    for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (isClaimed(view, creep, t.type, t.taskId, t.targetId)) continue;
        if (isAvoided(h, t.type, t.taskId, t.targetId)) continue;

        // Assign it
        var a = {
            type: t.type, taskId: t.taskId, targetId: t.targetId,
            amount: t.amount, assignedTick: Game.time, extra: t.extra || ''
        };
        setAssignment(creep, a);
        h.consecutiveIdlePicks = 0;

        // Determine initial state
        if (t.type === "extension") {
            // Build route immediately, decide fetch vs deliver based on energy
            h.extRoute = buildExtensionRoute(creep, view);
            h.extRouteTick = Game.time;
            creep.memory.s = energyUsed > 0 ? "delivering" : "fetching";
        } else if (t.type === "factory_input") {
            creep.memory.s = creep.store.getUsedCapacity() > 0 ? "delivering" : "fetching";
        } else if (t.type === "factory_output" || t.type === "factory_drain") {
            creep.memory.s = creep.store.getUsedCapacity() > 0 ? "delivering" : "fetching";
        } else if (t.type === "market_lab_stage" || t.type === "terminal_stock") {
            creep.memory.s = creep.store.getUsedCapacity() > 0 ? "delivering" : "fetching";
        } else if (t.type === "lab_unload" || t.type === "lab_load") {
            creep.memory.s = creep.store.getUsedCapacity() > 0 ? "delivering" : "fetching";
        } else if (isWithdrawTask(t.type)) {
            // Withdraw-type: if already carrying enough for a delivery task, deliver
            if (shouldDeliverImmediately(t.type, energyUsed)) {
                creep.memory.s = "delivering";
            } else {
                creep.memory.s = "fetching";
            }
        } else {
            // Transfer-type: need energy first
            creep.memory.s = energyUsed > 0 ? "delivering" : "fetching";
        }

        sup_say(creep, creep.memory.s === "fetching" ? "🔄" : "🚚");
        return true;
    }

    // Nothing to do — idle
    if (energyUsed > 0) {
        if (tryFallbackDump(creep, view)) return false;
    }
    h.consecutiveIdlePicks = (h.consecutiveIdlePicks || 0) + 1;
    creep.memory.s = "idle";
    delete creep.memory._move;

    if (!hasActiveAvoids(h) && h.consecutiveIdlePicks >= 3) {
        creep.memory.sl = Game.time + IDLE_SLEEP_TICKS;
    } else {
        creep.memory.sl = Game.time + IDLE_SHORT_SLEEP;
    }
    sup_say(creep, "💤");
    return false;
}

var WITHDRAW_TASKS = {
    container_empty: true, container_drain: true,     materials_drain_energy: true, link_drain: true, link_fill: true,
    terminal_balance: true, dropped_pickup: true
};

function isWithdrawTask(type) { return WITHDRAW_TASKS[type] === true; }

function shouldDeliverImmediately(type, energyUsed) {
    if (type === "link_fill" && energyUsed > 0) return true;
    if (type === "terminal_balance" && energyUsed > 0) return true;
    return false;
}

// ════════════════════════════════════════════════════════════════════════════════
//  EXTENSION ROUTE (optimal capacity split, seeded from depot, no dribble-filling)
// ════════════════════════════════════════════════════════════════════════════════

function nnOrder(nodes, startPos) {
    var remaining = nodes.slice(), order = [], cur = startPos;
    while (remaining.length > 0) {
        var bestIdx = 0, bestDist = cheb(cur, remaining[0].pos);
        for (var j = 1; j < remaining.length; j++) {
            var d = cheb(cur, remaining[j].pos);
            if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        var picked = remaining.splice(bestIdx, 1)[0];
        order.push(picked);
        cur = picked.pos;
    }
    return order;
}

function nodeById(nodes, id) {
    for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
    return null;
}

function buildExtensionRoute(creep, view) {
    var emptyExts = view._emptyExts;

    // FIX: Populate _emptyExts if missing (occurs when no supplier called scanRoomTasks this tick)
    if (!emptyExts) {
        emptyExts = [];
        var rcl8 = view.controller && view.controller.level >= 8;
        for (var ei = 0; ei < view.extensions.length; ei++) {
            var ext = view.extensions[ei];
            var free = ext.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
            if (free <= 0) continue;
            if (rcl8 && (ext.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
            emptyExts.push(ext);
        }
        view._emptyExts = emptyExts;
        if (emptyExts.length > 0 && !view._extWpMap) {
            view._extWpMap = getExtWpMap(creep.room, emptyExts);
        }
    }

    if (emptyExts.length === 0) return [];

    var wpMap = view._extWpMap;
    function posOf(e) { return (wpMap && wpMap[e.id]) ? wpMap[e.id] : e.pos; }

    // Build nodes: id, pos (waypoint if available), cap (free capacity)
    var nodes = [];
    for (var i = 0; i < emptyExts.length; i++) {
        var e = emptyExts[i];
        nodes.push({
            id: e.id,
            pos: posOf(e),
            cap: e.store.getFreeCapacity(RESOURCE_ENERGY) || (e.store.getCapacity(RESOURCE_ENERGY) || 200)
        });
    }

    var fullCap = getEnergyCapacity(creep);
    if (fullCap <= 0) return nodes.map(function(n){ return n.id; });

    // No storage to refuel at: just NN from current position
    if (!view.storage) return nnOrder(nodes, creep.pos).map(function(n){ return n.id; });
    var depot = view.storage.pos;

    // 1) NN tour seeded from the DEPOT (storage), not the creep's scattered
    //    field position. Runs start at storage, so this keeps segments
    //    spatially coherent and radiating outward from the depot.
    var order = nnOrder(nodes, depot);
    var n = order.length;

    // 2) Optimal capacity split (Prins' "Split"): given the fixed visiting
    //    order, choose trip boundaries that minimize total depot round-trips.
    //    Each trip starts full at storage and carries <= fullCap.
    var cost = new Array(n + 1), prev = new Array(n + 1);
    cost[0] = 0;
    for (var b = 1; b <= n; b++) { cost[b] = Infinity; prev[b] = -1; }

    for (var s = 0; s < n; s++) {
        var load = 0, tripCost = 0;
        for (var j = s; j < n; j++) {
            load += order[j].cap;
            if (load > fullCap && j > s) break;          // can't extend this trip
            if (j === s) {
                tripCost = cheb(depot, order[j].pos) * 2; // out and back
            } else {
                tripCost += cheb(order[j-1].pos, order[j].pos)
                          + cheb(order[j].pos, depot)
                          - cheb(order[j-1].pos, depot);
            }
            if (cost[s] + tripCost < cost[j + 1]) {
                cost[j + 1] = cost[s] + tripCost;
                prev[j + 1] = s;
            }
        }
    }

    // Reconstruct trip start indices (in ascending order).
    var bounds = [], k = n;
    while (k > 0) { bounds.push(prev[k]); k = prev[k]; }
    bounds.reverse();

    // 3) Emit route with REFUEL at each trip start.
    var route = [];
    for (var t = 0; t < bounds.length; t++) {
        route.push("REFUEL");
        var start = bounds[t];
        var end = (t + 1 < bounds.length) ? bounds[t + 1] : n;
        for (var m = start; m < end; m++) route.push(order[m].id);
    }

    // 4) Drop the leading refuel only if we already hold enough for the whole
    //    first trip — otherwise refuel first (avoids dribble-filling).
    if (route[0] === "REFUEL") {
        var need = 0;
        for (var f = 1; f < route.length && route[f] !== "REFUEL"; f++) {
            var fn = nodeById(nodes, route[f]);
            if (fn) need += fn.cap;
        }
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) >= need) route.shift();
    }

    return route;
}

// ════════════════════════════════════════════════════════════════════════════════
//  VALIDATION — is the current assignment still worth doing?
// ════════════════════════════════════════════════════════════════════════════════

function isAssignmentDone(creep, view, a, h) {
    if (!a || !a.type) return true;

    var src = Game.getObjectById(a.taskId);
    var dst = a.targetId ? Game.getObjectById(a.targetId) : src;
    var factoryRes = getFactoryTaskResource(a);

    if (a.type === "factory_input") {
        var factoryIn = dst;
        if (!factoryIn || !factoryIn.store || !factoryRes) return true;
        var orderIn = getActiveFactoryOrder(view.roomName);
        if (!orderIn) return true;
        if ((orderIn.phase || "loading") !== "loading") return true;
        var recipeIn = factoryManager.getRecipe(orderIn.product);
        if (!recipeIn || !recipeIn.inputs || recipeIn.inputs[factoryRes] === undefined) return true;
        var needIn = (recipeIn.inputs[factoryRes] || 0) * Math.max(0, orderIn.cycleBatches || 0);
        return (factoryIn.store[factoryRes] || 0) >= needIn;
    }

    if (a.type === "factory_output") {
        var factoryOut = view.factory;
        if (!factoryOut || !factoryOut.store || !factoryRes) return true;
        var orderOut = getActiveFactoryOrder(view.roomName);
        if (!orderOut || (orderOut.phase || "loading") !== "unloading") return true;
        return (factoryOut.store[factoryRes] || 0) <= 0;
    }

    if (a.type === "factory_drain") {
        var factoryDrain = view.factory;
        if (!factoryDrain || !factoryDrain.store) return true;
        var orderDrain = getActiveFactoryOrder(view.roomName);
        if (!orderDrain) return true;
        if (orderDrain && (orderDrain.phase || "loading") === "processing") return true;
        var drainRes = factoryRes;
        if (!drainRes) {
            for (var k in factoryDrain.store) {
                if ((factoryDrain.store[k] || 0) > 0) { drainRes = k; break; }
            }
        }
        if (!drainRes) return true;
        var keepDrain = parseExtra(a.extra, "keep");
        if (keepDrain !== null) return (factoryDrain.store[drainRes] || 0) <= (+keepDrain || 0);
        return (factoryDrain.store[drainRes] || 0) <= 0;
    }

    if (a.type === "market_lab_stage") {
        var stageRes = getMarketLabStageResource(a);
        var stageProgram = parseExtra(a.extra, "program");
        if (!view.storage || !stageRes || !stageProgram) return true;
        var stageReserved = getProgramReserved(view.roomName, stageRes, stageProgram, 'storage');
        return stageReserved <= 0 && (creep.store[stageRes] || 0) <= 0;
    }

    if (a.type === "lab_unload") {
        var unloadRes = getLabTaskResource(a);
        var unloadLab = Game.getObjectById(getLabTaskLabId(a));
        return (!unloadLab || !labHasMineral(unloadLab)) && (!unloadRes || (creep.store[unloadRes] || 0) <= 0);
    }

    if (a.type === "lab_load") {
        var loadRes = getLabTaskResource(a);
        var loadLab = Game.getObjectById(getLabTaskLabId(a));
        if (!loadLab || !loadRes) return true;
        if (loadLab.mineralType && loadLab.mineralType !== loadRes) return true;
        if ((a.amount || 0) <= 0) return true;
        var loadTargetAmt = +parseExtra(a.extra, "target") || 0;
        if (loadTargetAmt > 0 && (loadLab.mineralAmount || 0) >= loadTargetAmt) return true;
        var order = getLabOrder(view.roomName);
        if (!order || order.origin !== 'marketLab' || order.evacuating || order.needsPreEvacuation) return true;
        if ((creep.store[loadRes] || 0) > 0) return false;
        return (loadLab.store.getFreeCapacity(loadRes) || 0) <= 0;
    }

    // Extension: done when route is empty and no empties remain
    if (a.type === "extension") {
        var route = h.extRoute;
        if (route && route.length > 0) return false;
        // Check if any extension still needs energy
        var rcl8 = view.controller && view.controller.level >= 8;
        for (var ei = 0; ei < view.extensions.length; ei++) {
            var ext = view.extensions[ei];
            if ((ext.store.getFreeCapacity(RESOURCE_ENERGY) || 0) <= 0) continue;
            // At RCL 8, partially-filled extensions don't count
            if (rcl8 && (ext.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
            return false;
        }
        return true;
    }

    // FIX: fallback_dump previously fell through to "return false", so after
    // dumping, the creep flipped back to "fetching", withdrew from storage,
    // and re-delivered to the same storage in a loop until the TTL fired.
    if (a.type === "fallback_dump") {
        return creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0 ||
               !dst || !dst.store || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    if (!src) return true;

    if (a.type === "spawn" || a.type === "power_spawn_fill") {
        return !dst || !dst.store || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }
    if (a.type === "tower") {
        return !dst || !dst.store ||
               (dst.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= dst.store.getCapacity(RESOURCE_ENERGY) * 0.9;
    }
    if (a.type === "link_fill") {
        if (!dst || !dst.store) return true;
        return Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, dst.store.getCapacity(RESOURCE_ENERGY))
               - (dst.store.getUsedCapacity(RESOURCE_ENERGY) || 0)) <= 0;
    }
    if (a.type === "link_drain") {
        if ((creep.store[RESOURCE_ENERGY] || 0) > 0) return false;
        return !src.store || (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= LINK_FILL_THRESHOLD;
    }
    if (a.type === "container_drain" || a.type === "container_empty" || a.type === "materials_drain_energy") {
        var srcE = src.store ? (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        if (a.type === "container_drain" && a.extra) {
            var mde = parseExtra(a.extra, "mde");
            if (mde && srcE < +mde) return true;
        }
        return srcE <= 0 || !dst || !dst.store || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }
    if (a.type === "terminal_balance") {
        if (!view.storage || !view.terminal) return true;
        var tE = view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (a.taskId === view.terminal.id) return tE < TERMINAL_MAX;
        if (a.taskId === view.storage.id) return tE > TERMINAL_MIN;
        return true;
    }
    if (a.type === "terminal_stock") {
        var opIdDone = parseExtra(a.extra, 'op');
        if (!opIdDone) return true;
        var opDone = findTerminalOpById(opIdDone);
        if (!opDone || opDone.status === 'completed' || opDone.status === 'failed') return true;
        var movedDone = opDone.amountMoved || 0;
        return movedDone >= opDone.amount;
    }
    if (a.type === "dropped_pickup") {
        if (!src || (src.amount || 0) <= 0) return true;
        return !dst || !dst.store || dst.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
    }

    return false;
}

// Completion check that accounts for the transfer we just issued THIS tick.
// Store objects don't update until end of tick, so isAssignmentDone() can't
// see the energy we just sent — this simulates it for fill-type targets.
// Returns true/false, or null to fall back to isAssignmentDone().
function simulateFillDone(a, view, target, sent) {
    if (!target || !target.store) return true;
    var tE = (target.store.getUsedCapacity(RESOURCE_ENERGY) || 0) + sent;
    var cap = target.store.getCapacity(RESOURCE_ENERGY) || 0;

    if (a.type === "market_lab_stage") {
        var stageRes = getMarketLabStageResource(a);
        var stageTarget = view.terminal;
        if (!stageTarget || !stageTarget.store || !stageRes) return true;
        var stageNeed = a.amount || 0;
        if (stageNeed <= 0) return true;
        var stageProgram = parseExtra(a.extra, "program");
        if (!stageProgram) return true;
        return getProgramReserved(view.roomName, stageRes, stageProgram, 'storage') <= 0;
    }

    if (a.type === "lab_load") {
        var loadRes = getLabTaskResource(a);
        var loadTarget = target;
        if (!loadTarget || !loadTarget.store || !loadRes) return true;
        var loadTargetAmt = +parseExtra(a.extra, "target") || 0;
        if (loadTargetAmt <= 0) return true;
        return Math.max(0, (loadTarget.store[loadRes] || 0) + sent) >= loadTargetAmt;
    }

    if (a.type === "factory_input") {
        var inputRes = getFactoryTaskResource(a);
        var factoryIn = target;
        var orderIn = getActiveFactoryOrder(view.roomName);
        if (!factoryIn || !factoryIn.store || !inputRes || !orderIn) return true;
        if ((orderIn.phase || "loading") !== "loading") return true;
        var recipeIn = factoryManager.getRecipe(orderIn.product);
        if (!recipeIn || !recipeIn.inputs || recipeIn.inputs[inputRes] === undefined) return true;
        var needIn = (recipeIn.inputs[inputRes] || 0) * Math.max(0, orderIn.cycleBatches || 0);
        return Math.max(0, (factoryIn.store[inputRes] || 0) + sent) >= needIn;
    }

    if (a.type === "factory_output" || a.type === "factory_drain") {
        var outRes = getFactoryTaskResource(a);
        var factoryOut = view.factory;
        if (!factoryOut || !factoryOut.store || !outRes) return true;
        var orderOut = getActiveFactoryOrder(view.roomName);
        if (a.type === "factory_output" && (!orderOut || (orderOut.phase || "loading") !== "unloading")) return true;
        if (a.type === "factory_drain" && !orderOut) return true;
        if (a.type === "factory_drain" && orderOut && (orderOut.phase || "loading") === "processing") return true;
        var keepOut = parseExtra(a.extra, "keep");
        if (keepOut !== null) return Math.max(0, (factoryOut.store[outRes] || 0) - sent) <= (+keepOut || 0);
        return Math.max(0, (factoryOut.store[outRes] || 0) - sent) <= 0;
    }

    if (a.type === "spawn" || a.type === "power_spawn_fill") {
        return tE >= cap;
    }
    if (a.type === "tower") {
        return tE >= cap * 0.9;
    }
    if (a.type === "link_fill") {
        return Math.min(LINK_DRAIN_THRESHOLD, cap) - tE <= 0;
    }
    if (a.type === "terminal_balance") {
        if (view.terminal && a.targetId === view.terminal.id) return tE > TERMINAL_MIN;
        // terminal -> storage direction: completion depends on the terminal
        // (the source), whose store already reflects last tick's withdrawal.
        if (view.terminal) return (view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < TERMINAL_MAX;
        return true;
    }
    if (a.type === "terminal_stock") {
        var opIdSim = parseExtra(a.extra, 'op');
        if (!opIdSim) return true;
        var opSim = findTerminalOpById(opIdSim);
        if (!opSim || opSim.status === 'completed' || opSim.status === 'failed') return true;
        var movedSim = (opSim.amountMoved || 0) + sent;
        return movedSim >= opSim.amount;
    }
    if (a.type === "container_drain" || a.type === "container_empty" ||
        a.type === "link_drain" || a.type === "materials_drain_energy") {
        // Source-side data is fresh (our withdrawal applied last tick); the
        // only stale piece is the dump target's free space, shrunk by `sent`.
        var srcObj = Game.getObjectById(a.taskId);
        var srcE = (srcObj && srcObj.store) ? (srcObj.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        if (a.type === "link_drain" && srcE <= LINK_FILL_THRESHOLD) return true;
        if (a.type === "container_drain") {
            var mde = parseExtra(a.extra, "mde");
            if (mde && srcE < +mde) return true;
        }
        return srcE <= 0 ||
               (target.store.getFreeCapacity(RESOURCE_ENERGY) || 0) - sent <= 0;
    }
    if (a.type === "dropped_pickup") {
        var srcP = Game.getObjectById(a.taskId);
        if (!srcP || (srcP.amount || 0) <= 0) return true;
        return (target.store.getFreeCapacity(RESOURCE_ENERGY) || 0) - sent <= 0;
    }
    return null;
}

function parseExtra(extra, key) {
    if (!extra) return null;
    var parts = extra.split(",");
    for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split("=");
        if (kv[0] === key) return kv[1];
    }
    return null;
}

function findNextLabUnloadTask(creep, view, currentAssignment, resourceType) {
    if (!creep || !view || !currentAssignment || !resourceType) return null;
    if (!view.terminal || !view.terminal.store) return null;
    if ((view.terminal.store.getFreeCapacity(resourceType) || 0) <= 0) return null;

    var tasks = scanRoomTasks(creep.room, view);
    for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (!t || t.type !== 'lab_unload') continue;
        if (t.taskId === currentAssignment.taskId) continue;
        if (isClaimed(view, creep, t.type, t.taskId, t.targetId)) continue;
        if (isAvoided(getHeap(creep.name), t.type, t.taskId, t.targetId)) continue;
        if (getLabTaskResource(t) !== resourceType) continue;

        var labId = getLabTaskLabId(t);
        var lab = labId ? Game.getObjectById(labId) : null;
        if (!lab || !lab.mineralType || lab.mineralType !== resourceType) continue;
        if ((lab.mineralAmount || 0) <= 0) continue;

        return t;
    }
    return null;
}

function dumpAll(creep, room) {
    if (!room) room = creep.room;
    var keys = Object.keys(creep.store);
    for (var i = 0; i < keys.length; i++) {
        var res = keys[i];
        if ((creep.store[res] || 0) <= 0) continue;
        if (room.storage && room.storage.store.getFreeCapacity(res) > 0) {
            creep.transfer(room.storage, res);
            return;
        }
        if (room.terminal && room.terminal.store.getFreeCapacity(res) > 0) {
            creep.transfer(room.terminal, res);
            return;
        }
        break;
    }
}

function dumpResource(creep, room, resourceType) {
    if (!room) room = creep.room;
    if (!resourceType || (creep.store[resourceType] || 0) <= 0) return false;
    var target = null;
    if (room.storage && room.storage.store.getFreeCapacity(resourceType) > 0) target = room.storage;
    else if (room.terminal && room.terminal.store.getFreeCapacity(resourceType) > 0) target = room.terminal;
    if (!target) return false;
    if (cheb(creep.pos, target.pos) > 1) {
        smartMove(creep, target);
        return true;
    }
    return creep.transfer(target, resourceType) === OK;
}

function dumpEnergy(creep, room) {
    return dumpResource(creep, room, RESOURCE_ENERGY);
}

function dumpNonEnergy(creep, room, keepResource) {
    if (!room) room = creep.room;
    var keys = Object.keys(creep.store);
    for (var i = 0; i < keys.length; i++) {
        var res = keys[i];
        if (res === RESOURCE_ENERGY || res === keepResource || (creep.store[res] || 0) <= 0) continue;
        if (dumpResource(creep, room, res)) return true;
    }
    return false;
}

function onlyCarriesResource(creep, resourceType) {
    var keys = Object.keys(creep.store);
    for (var i = 0; i < keys.length; i++) {
        var res = keys[i];
        if ((creep.store[res] || 0) <= 0) continue;
        if (res !== resourceType) return false;
    }
    return true;
}

function storeSignature(creep) {
    var keys = Object.keys(creep.store).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
        var amt = creep.store[keys[i]] || 0;
        if (amt > 0) parts.push(keys[i] + ':' + amt);
    }
    return parts.join(',');
}

function deliveryNoProgressWatchdog(creep, a, h) {
    if (!a || creep.memory.s !== "delivering") {
        h.deliveryWatchKey = null;
        h.deliveryWatchCount = 0;
        return false;
    }

    var target = Game.getObjectById(a.targetId || a.taskId);
    if (!target || !target.pos || cheb(creep.pos, target.pos) > 1) {
        h.deliveryWatchKey = null;
        h.deliveryWatchCount = 0;
        return false;
    }

    var key = creep.memory.a + '|' + creep.memory.s + '|' +
              creep.pos.roomName + ':' + creep.pos.x + ':' + creep.pos.y + '|' +
              storeSignature(creep);

    if (h.deliveryWatchKey === key) {
        h.deliveryWatchCount = (h.deliveryWatchCount || 0) + 1;
    } else {
        h.deliveryWatchKey = key;
        h.deliveryWatchCount = 0;
    }

    if (h.deliveryWatchCount >= 3) {
        clearAssignment(creep, "delivery no progress", true);
        h.deliveryWatchKey = null;
        h.deliveryWatchCount = 0;
        return true;
    }

    return false;
}

function cleanupCargoForTask(creep, a) {
    var hasEnergy = (creep.store[RESOURCE_ENERGY] || 0) > 0;
    var hasNonEnergy = hasNonEnergyCarry(creep);

    if (a && a.type && a.type.indexOf('factory_') === 0) {
        var factoryRes = getFactoryTaskResource(a);
        if (hasEnergy) {
            // Don't dump energy when the factory task itself is for energy
            // (e.g. Composite, Oxidant, Battery). Otherwise we withdraw from
            // storage and immediately dump it back in a loop.
            if (factoryRes !== RESOURCE_ENERGY) {
                if (dumpEnergy(creep, creep.room)) return true;
                clearAssignment(creep, "factory cargo blocked", true);
                return true;
            }
        }
        if (hasNonEnergy) {
            if (factoryRes && onlyCarriesResource(creep, factoryRes)) return false;
            if (dumpNonEnergy(creep, creep.room, factoryRes)) return true;
            clearAssignment(creep, "factory cargo blocked", true);
            return true;
        }
        return false;
    }

    if (a && a.type === 'market_lab_stage') {
        var stageRes = getMarketLabStageResource(a);
        if (hasEnergy) {
            if (dumpEnergy(creep, creep.room)) return true;
            clearAssignment(creep, "stage cargo blocked", true);
            return true;
        }
        if (hasNonEnergy) {
            if (stageRes && onlyCarriesResource(creep, stageRes)) return false;
            if (dumpNonEnergy(creep, creep.room, stageRes)) return true;
            clearAssignment(creep, "stage cargo blocked", true);
            return true;
        }
        return false;
    }

    if (a && (a.type === 'lab_load' || a.type === 'lab_unload')) {
        var labRes = getLabTaskResource(a);
        if (hasEnergy) {
            if (dumpEnergy(creep, creep.room)) return true;
            clearAssignment(creep, "lab cargo blocked", true);
            return true;
        }
        if (hasNonEnergy) {
            if (labRes && onlyCarriesResource(creep, labRes)) return false;
            if (dumpNonEnergy(creep, creep.room, labRes)) return true;
            clearAssignment(creep, "lab cargo blocked", true);
            return true;
        }
        return false;
    }

    if (a && a.type === 'terminal_stock') {
        var stockCargoRes = getTerminalStockResource(a);
        if (hasEnergy) {
            if (dumpEnergy(creep, creep.room)) return true;
            clearAssignment(creep, "terminal stock cargo blocked", true);
            return true;
        }
        if (hasNonEnergy) {
            if (stockCargoRes && onlyCarriesResource(creep, stockCargoRes)) return false;
            if (dumpNonEnergy(creep, creep.room, stockCargoRes)) return true;
            clearAssignment(creep, "terminal stock cargo blocked", true);
            return true;
        }
        return false;
    }

    if (hasNonEnergy) {
        if (dumpNonEnergy(creep, creep.room)) return true;
        clearAssignment(creep, "cargo blocked", true);
        return true;
    }

    return false;
}

function hasNonEnergyCarry(creep) {
    var keys = Object.keys(creep.store);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i] !== RESOURCE_ENERGY && creep.store[keys[i]] > 0) return true;
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════════
//  STATE MACHINE EXECUTORS
// ════════════════════════════════════════════════════════════════════════════════

// ── FETCH STATE ─────────────────────────────────────────────────────────────
function executeFetch(creep, a, view, h) {
    if (creep.store.getFreeCapacity() === 0) {
        creep.memory.s = "delivering";
        return;
    }

    // --- Extension: fetch = go to storage (or any energy source as fallback) ---
    if (a.type === "extension") {
        var stor = view.storage;
        var refSrc = (stor && (stor.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0)
                     ? stor
                     : findEnergySource(creep, view, h);
        if (!refSrc) {
            // No refuel source anywhere. If we still carry something, keep
            // working the route with what we have instead of abandoning it.
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                creep.memory.s = "delivering";
                return;
            }
            clearAssignment(creep, "ext: no energy source", true);
            return;
        }
        if (creep.pos.isNearTo(refSrc)) {
            delete creep.memory._move;
            creep.withdraw(refSrc, RESOURCE_ENERGY);
            creep.memory.s = "delivering";
            refreshProgress(creep, a);
            var route = h.extRoute;
            // FIX: consume the REFUEL sentinel NOW — we just refueled. Without
            // this, the deliver state sees the sentinel next tick and bounces
            // straight back to fetching, wasting two ticks per refuel stop.
            while (route && route.length > 0 && route[0] === "REFUEL") route.shift();
            // Pipeline: move toward the first route extension this same tick
            if (route) {
                for (var pi = 0; pi < route.length; pi++) {
                    if (route[pi] === "REFUEL") break;
                    var peek = Game.getObjectById(route[pi]);
                    if (peek) {
                        var wpm = view._extWpMap;
                        var pp = (wpm && wpm[peek.id]) ? wpm[peek.id] : peek.pos;
                        if (cheb(creep.pos, pp) > 1) smartMove(creep, pp);
                        break;
                    }
                }
            }
        } else {
            smartMove(creep, refSrc);
        }
        return;
    }

    // --- Dropped pickup: fetch the pile with creep.pickup(), then deliver to storage ---
    if (a.type === "dropped_pickup") {
        var pile = Game.getObjectById(a.taskId);
        if (!pile || (pile.amount || 0) <= 0) {
            // Pile gone — if carrying energy, deliver it; otherwise abandon
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                creep.memory.s = "delivering"; return;
            }
            clearAssignment(creep, "drop gone", true); return;
        }
        if (cheb(creep.pos, pile.pos) > 1) { smartMove(creep, pile); return; }
        delete creep.memory._move;
        var pRes = creep.pickup(pile);
        if (pRes === OK) {
            creep.memory.s = "delivering";
            refreshProgress(creep, a);
            if (view.storage && cheb(creep.pos, view.storage.pos) > 1)
                smartMove(creep, view.storage);
        } else if (pRes === ERR_FULL) {
            creep.memory.s = "delivering";
        } else if (pRes !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "pickup err " + pRes, true);
        }
        return;
    }

    if (a.type === "lab_unload") {
        var unloadRes = getLabTaskResource(a);
        var unloadLab = Game.getObjectById(getLabTaskLabId(a));
        if (!unloadLab || !unloadLab.store || !unloadRes) {
            clearAssignment(creep, "lab unload source gone", true);
            return;
        }

        if (creep.store.getUsedCapacity() > 0) {
            if ((creep.store[unloadRes] || 0) > 0) {
                if (creep.store.getFreeCapacity() <= 0) {
                    creep.memory.s = "delivering";
                    return;
                }
            } else {
                dumpNonEnergy(creep, creep.room, unloadRes);
                return;
            }
        }

        if ((unloadLab.store[unloadRes] || 0) <= 0) {
            if ((creep.store[unloadRes] || 0) > 0 && creep.store.getFreeCapacity() > 0) {
                var nextUnloadEmpty = findNextLabUnloadTask(creep, view, a, unloadRes);
                if (nextUnloadEmpty) {
                    setAssignment(creep, {
                        type: nextUnloadEmpty.type,
                        taskId: nextUnloadEmpty.taskId,
                        targetId: nextUnloadEmpty.targetId,
                        amount: nextUnloadEmpty.amount,
                        assignedTick: Game.time,
                        extra: nextUnloadEmpty.extra || ''
                    });
                    h.fetchSourceId = getLabTaskLabId(nextUnloadEmpty);
                    creep.memory.s = "fetching";
                    delete creep.memory._move;
                    var nextLabEmpty = Game.getObjectById(getLabTaskLabId(nextUnloadEmpty));
                    if (nextLabEmpty && cheb(creep.pos, nextLabEmpty.pos) > 1) smartMove(creep, nextLabEmpty);
                    return;
                }
            }

            if ((creep.store[unloadRes] || 0) > 0) {
                creep.memory.s = "delivering";
                if (view.terminal && cheb(creep.pos, view.terminal.pos) > 1) smartMove(creep, view.terminal);
                return;
            }

            clearAssignment(creep, "lab unload empty", true);
            return;
        }

        h.fetchSourceId = unloadLab.id;
        if (cheb(creep.pos, unloadLab.pos) > 1) { smartMove(creep, unloadLab); return; }
        delete creep.memory._move;

        var unloadAmt = Math.min(a.amount || unloadLab.store[unloadRes] || 0, unloadLab.store[unloadRes] || 0, creep.store.getFreeCapacity());
        var unloadCode = creep.withdraw(unloadLab, unloadRes, unloadAmt);
        if (unloadCode === OK || unloadCode === ERR_FULL) {
            refreshProgress(creep, a);
            if (creep.store.getFreeCapacity() > 0) {
                var nextUnload = findNextLabUnloadTask(creep, view, a, unloadRes);
                if (nextUnload) {
                    setAssignment(creep, {
                        type: nextUnload.type,
                        taskId: nextUnload.taskId,
                        targetId: nextUnload.targetId,
                        amount: nextUnload.amount,
                        assignedTick: Game.time,
                        extra: nextUnload.extra || ''
                    });
                    h.fetchSourceId = getLabTaskLabId(nextUnload);
                    creep.memory.s = "fetching";
                    delete creep.memory._move;
                    var nextLab = Game.getObjectById(getLabTaskLabId(nextUnload));
                    if (nextLab && cheb(creep.pos, nextLab.pos) > 1) smartMove(creep, nextLab);
                    return;
                }
            }

            creep.memory.s = "delivering";
            if (view.terminal && cheb(creep.pos, view.terminal.pos) > 1) smartMove(creep, view.terminal);
        } else if (unloadCode === ERR_NOT_ENOUGH_RESOURCES) {
            if ((creep.store[unloadRes] || 0) > 0 && creep.store.getFreeCapacity() > 0) {
                var nextUnloadMissing = findNextLabUnloadTask(creep, view, a, unloadRes);
                if (nextUnloadMissing) {
                    setAssignment(creep, {
                        type: nextUnloadMissing.type,
                        taskId: nextUnloadMissing.taskId,
                        targetId: nextUnloadMissing.targetId,
                        amount: nextUnloadMissing.amount,
                        assignedTick: Game.time,
                        extra: nextUnloadMissing.extra || ''
                    });
                    h.fetchSourceId = getLabTaskLabId(nextUnloadMissing);
                    creep.memory.s = "fetching";
                    delete creep.memory._move;
                    return;
                }
            }

            if ((creep.store[unloadRes] || 0) > 0) {
                creep.memory.s = "delivering";
                if (view.terminal && cheb(creep.pos, view.terminal.pos) > 1) smartMove(creep, view.terminal);
                return;
            }

            clearAssignment(creep, "lab unload empty", true);
        } else if (unloadCode !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "lab unload withdraw err " + unloadCode, true);
        }
        return;
    }

    if (a.type === "lab_load") {
        var loadRes = getLabTaskResource(a);
        var loadLab = Game.getObjectById(getLabTaskLabId(a));
        if (!loadLab || !loadLab.store || !loadRes) {
            clearAssignment(creep, "lab load target gone", true);
            return;
        }

        if (creep.store.getUsedCapacity() > 0) {
            if ((creep.store[loadRes] || 0) > 0) creep.memory.s = "delivering";
            else dumpNonEnergy(creep, creep.room, loadRes);
            return;
        }

        if (loadLab.mineralType && loadLab.mineralType !== loadRes) {
            clearAssignment(creep, "lab load blocked", true);
            return;
        }

        var loadProgram = parseExtra(a.extra, "program");
        var loadSource = chooseLabLoadSource(creep.room, loadRes, loadProgram);
        if (!loadSource || !loadSource.store) {
            clearAssignment(creep, "lab load source empty", true);
            return;
        }

        h.fetchSourceId = loadSource.id;
        if (cheb(creep.pos, loadSource.pos) > 1) { smartMove(creep, loadSource); return; }
        delete creep.memory._move;

        var loadAvailable = loadSource.store[loadRes] || 0;
        var loadFree = creep.store.getFreeCapacity();
        var loadAmt = Math.min(a.amount || loadAvailable, loadAvailable, loadFree);
        var loadCode = creep.withdraw(loadSource, loadRes, loadAmt);
        if (loadCode === OK || loadCode === ERR_FULL) {
            creep.memory.s = "delivering";
            refreshProgress(creep, a);
            if (loadProgram && (loadSource.structureType === STRUCTURE_STORAGE || loadSource.structureType === STRUCTURE_TERMINAL)) {
                consumeProgramReservation(creep.room.name, loadRes, loadProgram,
                    loadSource.structureType === STRUCTURE_STORAGE ? 'storage' : 'terminal',
                    Math.min(loadAmt, loadAvailable));
            }
            if (loadLab && cheb(creep.pos, loadLab.pos) > 1) smartMove(creep, loadLab);
        } else if (loadCode === ERR_NOT_ENOUGH_RESOURCES) {
            clearAssignment(creep, "lab load source empty", true);
        } else if (loadCode !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "lab load withdraw err " + loadCode, true);
        }
        return;
    }

    if (a.type === "market_lab_stage") {
        var stageRes = getMarketLabStageResource(a);
        var stageSource = view.storage;
        if (!stageRes || !stageSource || !stageSource.store) {
            clearAssignment(creep, "market lab stage source gone", true);
            return;
        }

        if (creep.store.getUsedCapacity() > 0) {
            if ((creep.store[stageRes] || 0) > 0) {
                creep.memory.s = "delivering";
            } else {
                dumpNonEnergy(creep, creep.room, stageRes);
            }
            return;
        }

        h.fetchSourceId = stageSource.id;
        if (cheb(creep.pos, stageSource.pos) > 1) { smartMove(creep, stageSource); return; }
        delete creep.memory._move;

        var stageAvailable = stageSource.store.getUsedCapacity(stageRes) || 0;
        var stageFree = creep.store.getFreeCapacity();
        var stageAmt = Math.min(a.amount || stageAvailable, stageAvailable, stageFree);
        var stageCode = creep.withdraw(stageSource, stageRes, stageAmt);
        if (stageCode === OK || stageCode === ERR_FULL) {
            creep.memory.s = "delivering";
            refreshProgress(creep, a);
            if (view.terminal && cheb(creep.pos, view.terminal.pos) > 1) smartMove(creep, view.terminal);
            if (a.extra) {
                var stageProgram = parseExtra(a.extra, "program");
                var stageReserved = stageProgram ? getProgramReserved(creep.room.name, stageRes, stageProgram, 'storage') : 0;
                if (stageProgram && stageReserved > 0) {
                    consumeProgramReservation(creep.room.name, stageRes, stageProgram, 'storage', Math.min(stageAmt, stageAvailable, stageReserved));
                }
            }
        } else if (stageCode === ERR_NOT_ENOUGH_RESOURCES) {
            clearAssignment(creep, "market lab stage empty", true);
        } else if (stageCode !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "market lab stage withdraw err " + stageCode, true);
        }
        return;
    }

    if (a.type === "terminal_stock") {
        var stockRes = getTerminalStockResource(a);
        var stockSource = Game.getObjectById(a.taskId);
        if (!stockRes || !stockSource || !stockSource.store) {
            clearAssignment(creep, "terminal stock source gone", true);
            return;
        }

        if (creep.store.getUsedCapacity() > 0) {
            if ((creep.store[stockRes] || 0) > 0) {
                creep.memory.s = "delivering";
            } else {
                dumpNonEnergy(creep, creep.room, stockRes);
            }
            return;
        }

        var stockAvailable = stockSource.store.getUsedCapacity(stockRes) || 0;
        if (stockAvailable <= 0) {
            clearAssignment(creep, "terminal stock source empty", true);
            return;
        }

        h.fetchSourceId = stockSource.id;
        if (cheb(creep.pos, stockSource.pos) > 1) { smartMove(creep, stockSource); return; }
        delete creep.memory._move;

        var stockFree = creep.store.getFreeCapacity();
        var stockAmt = Math.min(a.amount || stockAvailable, stockAvailable, stockFree);
        var stockCode = creep.withdraw(stockSource, stockRes, stockAmt);
        if (stockCode === OK || stockCode === ERR_FULL) {
            creep.memory.s = "delivering";
            refreshProgress(creep, a);
            var stockProgram = parseExtra(a.extra, 'program');
            if (stockProgram) {
                var stockSourceType = stockSource.structureType === STRUCTURE_STORAGE ? 'storage' : 'terminal';
                var stockReserved = getProgramReserved(creep.room.name, stockRes, stockProgram, stockSourceType);
                if (stockReserved > 0) {
                    consumeProgramReservation(creep.room.name, stockRes, stockProgram, stockSourceType, Math.min(stockAmt, stockAvailable, stockReserved));
                }
            }
            var stockTarget = Game.getObjectById(a.targetId);
            if (stockTarget && cheb(creep.pos, stockTarget.pos) > 1) smartMove(creep, stockTarget);
        } else if (stockCode === ERR_NOT_ENOUGH_RESOURCES) {
            clearAssignment(creep, "terminal stock empty", true);
        } else if (stockCode !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "terminal stock withdraw err " + stockCode, true);
        }
        return;
    }

    if (a.type === "factory_input") {
        var inputRes = getFactoryTaskResource(a);
        var inputFactory = Game.getObjectById(a.targetId);
        if (!inputFactory || !inputFactory.store || !inputRes) {
            clearAssignment(creep, "factory input target gone", true);
            return;
        }

        if (creep.store.getUsedCapacity() > 0) {
            if ((creep.store[inputRes] || 0) > 0) {
                creep.memory.s = "delivering";
            } else {
                dumpNonEnergy(creep, creep.room, inputRes);
            }
            return;
        }

        var inputProgram = parseExtra(a.extra, "program");
        source = chooseFactorySource(creep.room, inputRes, inputProgram);
        if (!source) {
            clearAssignment(creep, "factory input source empty", true);
            return;
        }

        var fetchOrder = getActiveFactoryOrder(view.roomName);
        var fetchRecipe = fetchOrder ? factoryManager.getRecipe(fetchOrder.product) : null;
        var fetchDeficit = factoryInputDeficit(inputFactory, fetchOrder, fetchRecipe, inputRes);
        if (fetchDeficit <= 0) {
            clearAssignment(creep, "factory input satisfied", true);
            return;
        }

        h.fetchSourceId = source.id;
        if (cheb(creep.pos, source.pos) > 1) { smartMove(creep, source); return; }
        delete creep.memory._move;

        var inputAvailable = source.store.getUsedCapacity(inputRes) || 0;
        var inputFree = creep.store.getFreeCapacity();
        var inputAmt = Math.min(a.amount || inputAvailable, inputAvailable, inputFree, fetchDeficit);
        var inputResCode = creep.withdraw(source, inputRes, inputAmt);
        if (inputResCode === OK || inputResCode === ERR_FULL) {
            creep.memory.s = "delivering";
            refreshProgress(creep, a);
            if (inputProgram && (source.structureType === STRUCTURE_STORAGE || source.structureType === STRUCTURE_TERMINAL)) {
                consumeProgramReservation(creep.room.name, inputRes, inputProgram,
                    source.structureType === STRUCTURE_STORAGE ? 'storage' : 'terminal',
                    Math.min(inputAmt, inputAvailable));
            }
            var inputFactoryPos = Game.getObjectById(a.targetId);
            if (inputFactoryPos && cheb(creep.pos, inputFactoryPos.pos) > 1) smartMove(creep, inputFactoryPos);
        } else if (inputResCode === ERR_NOT_ENOUGH_RESOURCES) {
            clearAssignment(creep, "factory input empty", true);
        } else if (inputResCode !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "factory input withdraw err " + inputResCode, true);
        }
        return;
    }

    if (a.type === "factory_output" || a.type === "factory_drain") {
        var outRes = getFactoryTaskResource(a);
        var outFactory = view.factory;
        var outSink = Game.getObjectById(a.targetId);
        if (!outFactory || !outFactory.store || !outRes || !outSink || !outSink.store) {
            clearAssignment(creep, "factory output target gone", true);
            return;
        }

        if (creep.store.getUsedCapacity() > 0) {
            if ((creep.store[outRes] || 0) > 0) {
                creep.memory.s = "delivering";
            } else {
                dumpNonEnergy(creep, creep.room, outRes);
            }
            return;
        }

        source = outFactory;
        h.fetchSourceId = source.id;
        if (cheb(creep.pos, source.pos) > 1) { smartMove(creep, source); return; }
        delete creep.memory._move;

        var outAvailable = source.store.getUsedCapacity(outRes) || 0;
        var outFree = creep.store.getFreeCapacity();
        var outAmt = Math.min(a.amount || outAvailable, outAvailable, outFree);
        var outResCode = creep.withdraw(source, outRes, outAmt);
        if (outResCode === OK || outResCode === ERR_FULL) {
            creep.memory.s = "delivering";
            refreshProgress(creep, a);
            if (outSink && cheb(creep.pos, outSink.pos) > 1) smartMove(creep, outSink);
        } else if (outResCode === ERR_NOT_ENOUGH_RESOURCES) {
            clearAssignment(creep, "factory output empty", true);
        } else if (outResCode !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "factory output withdraw err " + outResCode, true);
        }
        return;
    }

    // --- Standard fetch: determine source ---
    var source = null;

    if (isWithdrawTask(a.type)) {
        // Withdraw tasks: source IS the taskId
        source = Game.getObjectById(a.taskId);
        if (!source || (source.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= 0) {
            // FIX: don't abandon while holding a load — deliver it first.
            // (e.g. the container got emptied by someone else mid-task)
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                creep.memory.s = "delivering";
                return;
            }
            clearAssignment(creep, "fetch src empty", true);
            return;
        }
    } else {
        // Transfer tasks: find energy source
        source = findEnergySource(creep, view, h);
        if (!source) {
            // FIX: no refuel source, but if we're carrying anything, deliver
            // it instead of dropping the task (this is what made fills "stop"
            // when storage dipped under 500 with containers empty).
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                creep.memory.s = "delivering";
                return;
            }
            clearAssignment(creep, "no energy source", true);
            return;
        }
        h.fetchSourceId = source.id;
    }

    // Compute withdraw amount
    var amt = null;
    var available = source.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var free = creep.store.getFreeCapacity();

    if (a.type === "link_drain") {
        var maxDrain = Math.max(0, available - LINK_FILL_THRESHOLD);
        if (maxDrain <= 0) {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) { creep.memory.s = "delivering"; return; }
            clearAssignment(creep, "link drained enough", true);
            return;
        }
        amt = Math.min(a.amount || maxDrain, maxDrain, free);
    } else if (a.type === "link_fill") {
        var lnk = Game.getObjectById(a.targetId);
        if (!lnk) { clearAssignment(creep, "link gone", true); return; }
        var maxFill = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, lnk.store.getCapacity(RESOURCE_ENERGY))
                      - (lnk.store.getUsedCapacity(RESOURCE_ENERGY) || 0));
        if (maxFill <= 0) { clearAssignment(creep, "link full", true); return; }
        amt = Math.min(a.amount || available, available, free, maxFill);
    } else if (a.type === "terminal_balance") {
        amt = Math.min(a.amount || available, available, free);
    } else {
        amt = Math.min(available, free);
    }

    if (cheb(creep.pos, source.pos) > 1) { smartMove(creep, source); return; }
    delete creep.memory._move;

    var wRes = amt != null ? creep.withdraw(source, RESOURCE_ENERGY, amt) : creep.withdraw(source, RESOURCE_ENERGY);
    if (wRes === OK || wRes === ERR_FULL) {
        creep.memory.s = "delivering";
        refreshProgress(creep, a);
        // Pipeline: the move intent is still free this tick — start walking
        // toward the delivery target immediately instead of standing still.
        var dlv = Game.getObjectById(a.targetId || a.taskId);
        if (dlv && dlv.id !== source.id && cheb(creep.pos, dlv.pos) > 1) smartMove(creep, dlv);
    } else if (wRes === ERR_NOT_ENOUGH_RESOURCES) {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) { creep.memory.s = "delivering"; return; }
        clearAssignment(creep, "not enough res", true);
    } else if (wRes !== ERR_NOT_IN_RANGE) {
        clearAssignment(creep, "withdraw err " + wRes, true);
    }
}

function findEnergySource(creep, view, h) {
    // Try cached source first
    if (h.fetchSourceId) {
        var cached = Game.getObjectById(h.fetchSourceId);
        if (cached && cached.store && (cached.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0 &&
            !(cached.structureType === STRUCTURE_CONTAINER && isLinkServed(creep.room, cached.id))) {
            return cached;
        }
        h.fetchSourceId = null;
    }

    // Storage first
    if (view.storage && view.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 500) return view.storage;

    // Containers with energy
    var containers = [];
    for (var i = 0; i < view.containers.length; i++) {
        var c = view.containers[i];
        var e = c.store.getUsedCapacity(RESOURCE_ENERGY);
        if (e <= 0) continue;
        if (view.controller && cheb(c.pos, view.controller.pos) <= 2) continue;
        if (isLinkServed(creep.room, c.id)) continue;
        containers.push(c);
    }
    if (containers.length > 0) {
        var freeE = creep.store.getFreeCapacity(RESOURCE_ENERGY);
        var canFill = [];
        for (var j = 0; j < containers.length; j++) {
            if (containers[j].store.getUsedCapacity(RESOURCE_ENERGY) >= freeE) canFill.push(containers[j]);
        }
        return canFill.length > 0 ? creep.pos.findClosestByRange(canFill) : creep.pos.findClosestByRange(containers);
    }

    // Terminal
    if (view.terminal && view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return view.terminal;

    return null;
}

// ── DELIVER STATE ───────────────────────────────────────────────────────────
function executeDeliver(creep, a, view, h) {
    if (creep.store.getUsedCapacity() === 0) {
        // Nothing to deliver — back to fetch or done
        if (a.type === "extension") {
            // Route may have more — refuel needed
            if (h.extRoute && h.extRoute.length > 0) {
                creep.memory.s = "fetching";
                if (view.storage && cheb(creep.pos, view.storage.pos) > 1) {
                    smartMove(creep, view.storage);
                }
                return;
            }
            // Check for new empties (spawn may have fired mid-route)
            h.extRoute = buildExtensionRoute(creep, view);
            h.extRouteTick = Game.time;
            if (h.extRoute.length > 0) {
                creep.memory.s = "fetching";
                if (view.storage && cheb(creep.pos, view.storage.pos) > 1) {
                    smartMove(creep, view.storage);
                }
                return;
            }
            clearAssignment(creep, "ext all full", true);
            return;
        }
        // For any task that still has work to do, go fetch instead of
        // abandoning — covers towers, spawns, power-spawns, link-fill,
        // container-drain, etc. when the creep arrives empty due to a
        // same-tick re-pick or other edge case.
        if (!isAssignmentDone(creep, view, a, h)) {
            creep.memory.s = "fetching";
            return;
        }
        clearAssignment(creep, "nothing to deliver", true);
        return;
    }

    if (a.type === "lab_unload") {
        var unloadRes = getLabTaskResource(a);
        var unloadTarget = view.terminal;
        if (!unloadRes || !unloadTarget || !unloadTarget.store) {
            clearAssignment(creep, "lab unload target missing", true);
            return;
        }
        if ((creep.store[unloadRes] || 0) <= 0) {
            clearAssignment(creep, "lab unload empty", true);
            return;
        }
        if (cheb(creep.pos, unloadTarget.pos) > 1) { smartMove(creep, unloadTarget); return; }
        delete creep.memory._move;

        var unloadCarried = creep.store[unloadRes] || 0;
        var unloadFree = unloadTarget.store.getFreeCapacity(unloadRes) || unloadCarried;
        var unloadSent = Math.min(unloadCarried, unloadFree);
        var unloadTransfer = creep.transfer(unloadTarget, unloadRes, unloadSent);
        if (unloadTransfer === OK) {
            refreshProgress(creep, a);
            if (isAssignmentDone(creep, view, a, h)) {
                clearAssignment(creep, "lab unload complete", true);
            } else if (unloadCarried - unloadSent <= 0) {
                creep.memory.s = "fetching";
            }
        } else if (unloadTransfer === ERR_FULL) {
            clearAssignment(creep, "lab unload target full", true);
        } else if (unloadTransfer !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "lab unload transfer err " + unloadTransfer, true);
        }
        return;
    }

    if (a.type === "lab_load") {
        var loadRes = getLabTaskResource(a);
        var loadTarget = Game.getObjectById(a.targetId || getLabTaskLabId(a));
        if (!loadRes || !loadTarget || !loadTarget.store) {
            clearAssignment(creep, "lab load target missing", true);
            return;
        }
        if ((creep.store[loadRes] || 0) <= 0) {
            clearAssignment(creep, "lab load empty", true);
            return;
        }
        if (loadTarget.mineralType && loadTarget.mineralType !== loadRes) {
            clearAssignment(creep, "lab load target blocked", true);
            return;
        }
        if (cheb(creep.pos, loadTarget.pos) > 1) { smartMove(creep, loadTarget); return; }
        delete creep.memory._move;

        var loadCarried = creep.store[loadRes] || 0;
        var loadFree = loadTarget.store.getFreeCapacity(loadRes) || loadCarried;
        var loadSent = Math.min(loadCarried, loadFree, a.amount || loadCarried);
        var loadTransfer = creep.transfer(loadTarget, loadRes, loadSent);
        if (loadTransfer === OK) {
            a.amount = Math.max(0, (a.amount || 0) - loadSent);
            setAssignment(creep, a);
            refreshProgress(creep, a);
            var loadDone = simulateFillDone(a, view, loadTarget, loadSent);
            if (loadDone === true) {
                clearAssignment(creep, "lab load target met", true);
                return;
            }
            if (parseExtra(a.extra, "record") === "1" && labManager && typeof labManager.recordDelivery === 'function') {
                labManager.recordDelivery(creep.room.name, loadRes, loadSent);
            }
            if (isAssignmentDone(creep, view, a, h)) {
                clearAssignment(creep, "lab load complete", true);
            } else if (loadCarried - loadSent <= 0) {
                creep.memory.s = "fetching";
            }
        } else if (loadTransfer === ERR_FULL) {
            clearAssignment(creep, "lab load target full", true);
        } else if (loadTransfer !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "lab load transfer err " + loadTransfer, true);
        }
        return;
    }

    if (a.type === "market_lab_stage") {
        var stageRes = getMarketLabStageResource(a);
        var stageTarget = Game.getObjectById(a.targetId);
        if (!stageRes || !stageTarget || !stageTarget.store) {
            clearAssignment(creep, "market lab stage target missing", true);
            return;
        }

        if ((creep.store[stageRes] || 0) <= 0) {
            clearAssignment(creep, "market lab stage empty", true);
            return;
        }

        if (cheb(creep.pos, stageTarget.pos) > 1) {
            smartMove(creep, stageTarget);
            return;
        }
        delete creep.memory._move;

        var stageCarried = creep.store[stageRes] || 0;
        var stageFree = stageTarget.store.getFreeCapacity(stageRes) || stageCarried;
        if (stageFree <= 0) {
            clearAssignment(creep, "market lab stage target full", true);
            return;
        }
        var stageSent = Math.min(stageCarried, stageFree);
        var stageTransfer = creep.transfer(stageTarget, stageRes, stageSent);
        if (stageTransfer === ERR_FULL) {
            clearAssignment(creep, "market lab stage full", true);
            return;
        }
        if (stageTransfer === OK) {
            refreshProgress(creep, a);
            var stageDone = simulateFillDone(a, view, stageTarget, stageSent);
            if (stageDone === null) stageDone = isAssignmentDone(creep, view, a, h);
            if (stageDone) { clearAssignment(creep, "market lab stage complete", true); return; }
            if (stageCarried - stageSent <= 0) creep.memory.s = "fetching";
        } else if (stageTransfer !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "market lab stage transfer err " + stageTransfer, true);
        }
        return;
    }

    if (a.type === "terminal_stock") {
        var stockResD = getTerminalStockResource(a);
        var stockTargetD = Game.getObjectById(a.targetId);
        if (!stockResD || !stockTargetD || !stockTargetD.store) {
            clearAssignment(creep, "terminal stock target missing", true);
            return;
        }

        if ((creep.store[stockResD] || 0) <= 0) {
            clearAssignment(creep, "terminal stock empty", true);
            return;
        }

        if (cheb(creep.pos, stockTargetD.pos) > 1) {
            smartMove(creep, stockTargetD);
            return;
        }
        delete creep.memory._move;

        var stockCarried = creep.store[stockResD] || 0;
        var stockFreeD = stockTargetD.store.getFreeCapacity(stockResD) || stockCarried;
        if (stockFreeD <= 0) {
            clearAssignment(creep, "terminal stock target full", true);
            return;
        }
        var stockSent = Math.min(stockCarried, stockFreeD);
        var stockTransfer = creep.transfer(stockTargetD, stockResD, stockSent);
        if (stockTransfer === ERR_FULL) {
            clearAssignment(creep, "terminal stock full", true);
            return;
        }
        if (stockTransfer === OK) {
            refreshProgress(creep, a);
            // Credit operation progress so terminalManager can complete the op.
            var stockOpId = parseExtra(a.extra, 'op');
            var stockType = parseExtra(a.extra, 'type');
            var stockProgram = parseExtra(a.extra, 'program');
            if (stockOpId) {
                var stockOp = findTerminalOpById(stockOpId);
                if (stockOp) {
                    if (typeof stockOp.amountMoved !== 'number') stockOp.amountMoved = 0;
                    stockOp.amountMoved += stockSent;
                    if (stockProgram && terminalManager && typeof terminalManager.consumeOperationStock === 'function') {
                        var stockDestBuilding = stockType === 'toTerminal' ? 'terminal' : 'storage';
                        terminalManager.consumeOperationStock(stockOp, creep.room.name, stockResD, stockDestBuilding, stockSent, stockProgram);
                    }
                }
            }
            var stockDone = simulateFillDone(a, view, stockTargetD, stockSent);
            if (stockDone === null) stockDone = isAssignmentDone(creep, view, a, h);
            if (stockDone) { clearAssignment(creep, "terminal stock complete", true); return; }
            if (stockCarried - stockSent <= 0) creep.memory.s = "fetching";
        } else if (stockTransfer !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "terminal stock transfer err " + stockTransfer, true);
        }
        return;
    }

    // --- Extension route delivery ---
    if (a.type === "extension") {
        executeExtensionDeliver(creep, a, view, h);
        return;
    }

    // --- Determine target and resource type ---
    if (a.type === "factory_input" || a.type === "factory_output" || a.type === "factory_drain") {
        var factoryRes = getFactoryTaskResource(a);
        var factory = view.factory;
        var target = Game.getObjectById(a.targetId);

        if (!factoryRes || !factory || !target || !target.store) {
            clearAssignment(creep, "factory target missing", true);
            return;
        }

        if (cheb(creep.pos, target.pos) > 1) {
            smartMove(creep, target);
            return;
        }
        delete creep.memory._move;

        if (a.type === "factory_input") {
            if ((creep.store[factoryRes] || 0) <= 0) {
                clearAssignment(creep, "factory input empty", true);
                return;
            }

            var inputOrder = getActiveFactoryOrder(view.roomName);
            var inputRecipe = inputOrder ? factoryManager.getRecipe(inputOrder.product) : null;
            var inputDeficit = factoryInputDeficit(target, inputOrder, inputRecipe, factoryRes);
            if (inputDeficit <= 0) {
                clearAssignment(creep, "factory input satisfied", true);
                return;
            }

            var inputCarried = creep.store[factoryRes] || 0;
            var inputFree = target.store.getFreeCapacity ? (target.store.getFreeCapacity(factoryRes) || 0) : inputCarried;
            if (inputFree <= 0) {
                creep.memory.s = "delivering";
                return;
            }
            var inputSent = Math.min(inputCarried, inputFree, inputDeficit);
            var inputTransfer = creep.transfer(target, factoryRes, inputSent);
            if (inputTransfer === ERR_FULL) {
                creep.memory.s = "delivering";
                return;
            }
            if (inputTransfer === OK) {
                refreshProgress(creep, a);
                var inputDone = simulateFillDone(a, view, target, inputSent);
                if (inputDone === null) inputDone = isAssignmentDone(creep, view, a, h);
                if (inputDone && (creep.store[factoryRes] || 0) <= 0) { clearAssignment(creep, "task complete", true); return; }
                if ((creep.store[factoryRes] || 0) > 0) creep.memory.s = "delivering";
                else if (inputDone) { clearAssignment(creep, "task complete", true); return; }
                else creep.memory.s = "fetching";
            } else if (inputTransfer !== ERR_NOT_IN_RANGE) {
                if ((creep.store[factoryRes] || 0) > 0) {
                    creep.memory.s = "delivering";
                    return;
                }
                clearAssignment(creep, "factory input transfer err " + inputTransfer, true);
            }
            return;
        }

        if ((creep.store[factoryRes] || 0) <= 0) {
            clearAssignment(creep, "factory output empty", true);
            return;
        }

        var outputCarried = creep.store[factoryRes] || 0;
        var outputFree = target.store.getFreeCapacity(factoryRes) || outputCarried;
        var outputSent = Math.min(outputCarried, outputFree);
        var outputTransfer = creep.transfer(target, factoryRes, outputSent);
        if (outputTransfer === ERR_FULL) {
            clearAssignment(creep, "factory sink full", true);
            return;
        }
        if (outputTransfer === OK) {
            refreshProgress(creep, a);
            var outputDone = simulateFillDone(a, view, target, outputSent);
            if (outputDone === null) outputDone = isAssignmentDone(creep, view, a, h);
            if (outputDone) { clearAssignment(creep, "task complete", true); return; }
            if (outputCarried - outputSent <= 0) creep.memory.s = "fetching";
        } else if (outputTransfer !== ERR_NOT_IN_RANGE) {
            clearAssignment(creep, "factory transfer err " + outputTransfer, true);
        }
        return;
    }

    var target = Game.getObjectById(a.targetId || a.taskId);
    if (!target) { clearAssignment(creep, "target gone", true); return; }

    var resType = RESOURCE_ENERGY;

    // Check target capacity
    if (target.store && target.store.getFreeCapacity && target.store.getFreeCapacity(resType) <= 0) {
        clearAssignment(creep, "target full", true);
        return;
    }

    // Move + transfer
    if (cheb(creep.pos, target.pos) > 1) {
        var mv = smartMove(creep, target);
        if (mv === ERR_NO_PATH && Game.time >= h.rerouteUntil) {
            h.noPathCount = (h.noPathCount || 0) + 1;
            if (h.noPathCount >= NO_PATH_TTL) clearAssignment(creep, "no path", true);
        } else { h.noPathCount = 0; }
        return;
    }
    delete creep.memory._move;

    // Compute transfer amount for link_fill
    var amt = null;
    if (a.type === "link_fill") {
        var lCap = target.store.getCapacity(RESOURCE_ENERGY);
        var lE = target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var maxFill = Math.max(0, Math.min(LINK_DRAIN_THRESHOLD, lCap) - lE);
        if (maxFill <= 0) { clearAssignment(creep, "link filled", true); return; }
        amt = Math.min(a.amount || creep.store.getUsedCapacity(RESOURCE_ENERGY), maxFill,
                       creep.store.getUsedCapacity(RESOURCE_ENERGY));
    }

    var res = amt != null ? creep.transfer(target, resType, amt) : creep.transfer(target, resType);

    if (res === ERR_FULL) {
        // Fresh info straight from the intent: target genuinely has no room.
        clearAssignment(creep, "target full", true);
        return;
    }

    if (res === OK) {
        refreshProgress(creep, a);

        // Store data is stale until end of tick — simulate what we just sent
        // so we can keep the shuttle moving without dead ticks or premature
        // clears.
        var carried = creep.store.getUsedCapacity(resType) || 0;
        var tFree = (target.store && target.store.getFreeCapacity)
                    ? (target.store.getFreeCapacity(resType) || 0) : carried;
        var sent = Math.min(carried, tFree);
        if (amt != null) sent = Math.min(sent, amt);
        var leftAfter = carried - sent;

        // Fallback dump completes as soon as the load is gone
        if (a.type === "fallback_dump") {
            if (leftAfter <= 0) clearAssignment(creep, "dump complete", true);
            return;
        }

        var done = simulateFillDone(a, view, target, sent);
        if (done === null) done = isAssignmentDone(creep, view, a, h);
        if (done) {
            clearAssignment(creep, "task complete", true);
            return; // same-tick re-pick in run() takes over
        }

        if (leftAfter > 0) return; // still holding more for this target — keep delivering

        // Empty after this transfer but the task ISN'T finished — go fetch
        // the next load right away, and use the still-free move intent to
        // start walking back to the source this same tick.
        creep.memory.s = "fetching";
        var nextSrc = null;
        if (isWithdrawTask(a.type)) {
            nextSrc = Game.getObjectById(a.taskId);
        } else if (view.storage && (view.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) {
            nextSrc = view.storage;
        } else {
            nextSrc = findEnergySource(creep, view, h);
        }
        if (nextSrc && nextSrc.id !== target.id && cheb(creep.pos, nextSrc.pos) > 1) {
            smartMove(creep, nextSrc);
        }
        return;
    }

    if (res !== ERR_NOT_IN_RANGE) {
        clearAssignment(creep, "transfer err " + res, true);
    }
}

// ── EXTENSION DELIVERY (route following with move+fill pipelining) ──────────
function executeExtensionDeliver(creep, a, view, h) {
    var route = h.extRoute;
    if (!route || route.length === 0) {
        route = buildExtensionRoute(creep, view);
        h.extRoute = route;
        h.extRouteTick = Game.time;
        if (route.length === 0) {
            clearAssignment(creep, "ext all full", true);
            return;
        }
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.s = "fetching";
            return;
        }
    }

    // Stale route guard
    if (h.extRouteTick && Game.time - h.extRouteTick > EXT_ROUTE_RECOMPUTE_TICKS) {
        route = buildExtensionRoute(creep, view);
        h.extRoute = route;
        h.extRouteTick = Game.time;
        if (route.length === 0) { clearAssignment(creep, "ext stale recompute empty", true); return; }
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) { creep.memory.s = "fetching"; return; }
    }

    // Advance past full/dead extensions (at RCL 8, also skip partially-filled)
    var rcl8 = view.controller && view.controller.level >= 8;
    var skipped = 0;
    while (route.length > 0 && route[0] !== "REFUEL") {
        var head = Game.getObjectById(route[0]);
        if (head && head.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            if (!rcl8 || (head.store.getUsedCapacity(RESOURCE_ENERGY) || 0) === 0) break;
        }
        route.shift();
        skipped++;
        if (skipped >= EXT_ROUTE_SKIP_LIMIT) {
            route = buildExtensionRoute(creep, view);
            h.extRoute = route;
            h.extRouteTick = Game.time;
            return;
        }
    }

    if (route.length === 0) {
        route = buildExtensionRoute(creep, view);
        h.extRoute = route;
        h.extRouteTick = Game.time;
        if (route.length === 0) { clearAssignment(creep, "ext done", true); return; }
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) { creep.memory.s = "fetching"; return; }
        return;
    }

    // REFUEL sentinel → switch to fetch
    if (route[0] === "REFUEL") {
        route.shift(); // consume sentinel
        creep.memory.s = "fetching";
        if (view.storage && cheb(creep.pos, view.storage.pos) > 1) {
            smartMove(creep, view.storage);
        }
        return;
    }

    // Fill the head extension
    var target = Game.getObjectById(route[0]);
    if (!target) { route.shift(); return; }

    // Use the waypoint position for this extension if available
    var wpMap = view._extWpMap;
    var targetPos = (wpMap && wpMap[target.id]) ? wpMap[target.id] : target.pos;

    if (cheb(creep.pos, targetPos) > 1) {
        smartMove(creep, targetPos);
        return;
    }
    delete creep.memory._move;

    var energyHave = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    var energyNeed = target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    // FIX: only detour to refuel if the creep can actually carry more.
    // A creep whose total capacity is smaller than one extension's need used
    // to bounce fetch<->deliver forever here without ever transferring.
    if (energyHave < energyNeed && creep.store.getFreeCapacity() > 0) {
        route.unshift("REFUEL");  // re-insert so we return here after refuel
        creep.memory.s = "fetching";
        if (view.storage && cheb(creep.pos, view.storage.pos) > 1) {
            smartMove(creep, view.storage);
        }
        return;
    }

    var res = creep.transfer(target, RESOURCE_ENERGY);
    if (res === OK || res === ERR_FULL) {
        route.shift();

        // Partial fill (creep at max capacity but smaller than the extension's
        // need): queue this extension again after a refuel.
        if (res === OK && energyHave < energyNeed) {
            route.unshift(target.id);
            route.unshift("REFUEL");
            creep.memory.s = "fetching";
            if (view.storage && cheb(creep.pos, view.storage.pos) > 1) {
                smartMove(creep, view.storage);
            }
            return;
        }

        refreshProgress(creep, a);

        var energyAfter = creep.store.getUsedCapacity(RESOURCE_ENERGY) - energyNeed;
        // Move only if the immediate next extension is out of reach
        var shouldMove = false;
        var moveTarget = null;
        if (route.length > 0) {
            if (route[0] === "REFUEL") {
                if (view.storage && cheb(creep.pos, view.storage.pos) > 1) {
                    shouldMove = true;
                    moveTarget = view.storage;
                }
            } else {
                var nextExt = Game.getObjectById(route[0]);
                if (nextExt) {
                    var nextWp = (wpMap && wpMap[nextExt.id]) ? wpMap[nextExt.id] : nextExt.pos;
                    if (cheb(creep.pos, nextWp) > 1) {
                        shouldMove = true;
                        moveTarget = nextWp;
                    }
                }
            }
        }
        if (shouldMove && moveTarget) {
            smartMove(creep, moveTarget);
        }
    }
}

// ─── FALLBACK DUMP ──────────────────────────────────────────────────────────
function tryFallbackDump(creep, view) {
    var energyUsed = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (energyUsed === 0) return false;

    var target = null;
    if (view.storage && view.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        // FIX: Use getFreeCapacity so storage is selected when it has room available,
        // not when it's nearly empty (original buggy logic inverted the intent)
        if ((view.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 5000) target = view.storage;
    }
    if (!target && view.terminal && view.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) target = view.terminal;
    if (!target) {
        for (var i = 0; i < view.containers.length; i++) {
            if (view.containers[i].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                target = view.containers[i]; break;
            }
        }
    }
    if (!target) return false;

    // Set a dump assignment
    setAssignment(creep, {
        type: "fallback_dump", taskId: target.id, targetId: target.id,
        amount: energyUsed, assignedTick: Game.time, extra: ''
    });
    creep.memory.s = "delivering";
    sup_say(creep, "📦");
    return true;
}

// ─── STEP ASIDE ─────────────────────────────────────────────────────────────
function tryStepAside(creep, h) {
    var terrain = creep.room.getTerrain();
    var dirs = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
    // Shuffle
    for (var i = dirs.length - 1; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var tmp = dirs[i]; dirs[i] = dirs[j]; dirs[j] = tmp;
    }
    var dx = [0, 1, 1, 1, 0, -1, -1, -1];
    var dy = [-1, -1, 0, 1, 1, 1, 0, -1];

    for (var di = 0; di < dirs.length; di++) {
        var idx = dirs[di] - 1;
        var x = creep.pos.x + dx[idx], y = creep.pos.y + dy[idx];
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0) continue;
        var structs = creep.room.lookForAt(LOOK_STRUCTURES, x, y);
        var blocked = false;
        for (var si = 0; si < structs.length; si++) {
            if (structs[si].structureType !== STRUCTURE_ROAD && structs[si].structureType !== STRUCTURE_CONTAINER) {
                blocked = true; break;
            }
        }
        if (blocked) continue;
        h.lastTriedMoveTick = Game.time;
        creep.move(dirs[di]);
        return true;
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════════
//  MAIN RUN
// ════════════════════════════════════════════════════════════════════════════════

var roleSupplier = {
    run: function(creep) {
        if (!SUPPLIER_ENABLED) return;
        pruneHeap();
        var h = getHeap(creep.name);

        // ── IDLE SLEEP GATE ────────────────────────────────────────────────
        if (creep.memory.s === "idle" && creep.memory.sl && Game.time < creep.memory.sl) {
            return;  // Sleeping — zero CPU
        }

        // ── LOW TTL → DUMP AND DIE ────────────────────────────────────────
        if (creep.ticksToLive < 100) {
            if (creep.store.getUsedCapacity() > 0) {
                var dumpKey = Object.keys(creep.store)[0] || RESOURCE_ENERGY;
                var dumpTgt = creep.room.storage || creep.room.terminal;
                if (dumpTgt) {
                    if (creep.transfer(dumpTgt, dumpKey) === ERR_NOT_IN_RANGE) smartMove(creep, dumpTgt);
                } else { creep.drop(dumpKey); }
                return;
            }
            creep.suicide();
            return;
        }

        pruneAvoids(h);
        if (!creep.memory.s) creep.memory.s = "idle";

        // ── ROOM CONTAINMENT ───────────────────────────────────────────────
        var home = creep.memory.assignedRoom || creep.memory.homeRoom;
        if (home && creep.room.name !== home) {
            delete creep.memory._move;
            var exit = creep.room.findExitTo(home);
            if (exit > 0) {
                var ePos = creep.pos.findClosestByRange(exit);
                if (ePos) { h.lastTriedMoveTick = Game.time; creep.moveTo(ePos, { reusePath: 5, maxOps: 500 }); }
            }
            return;
        }

        // ── ANTI-STUCK ─────────────────────────────────────────────────────
        if (h.lastPos && creep.fatigue === 0) {
            var moved = creep.pos.x !== h.lastPos.x || creep.pos.y !== h.lastPos.y || creep.room.name !== h.lastPos.rn;
            if (!moved && h.lastTriedMoveTick === Game.time - 1) h.stuckCount++;
            else if (moved) h.stuckCount = 0;
        } else { h.stuckCount = 0; }
        h.lastPos = { x: creep.pos.x, y: creep.pos.y, rn: creep.room.name };

        if (h.stuckCount >= 2) {
            // Only step aside if not adjacent to our target
            var shouldStep = true;
            var curA = getAssignment(creep);
            if (curA) {
                var stuckTarget = (creep.memory.s === "delivering")
                    ? Game.getObjectById(curA.targetId || curA.taskId)
                    : (isWithdrawTask(curA.type) ? Game.getObjectById(curA.taskId) : null);
                if (stuckTarget && cheb(creep.pos, stuckTarget.pos) <= 1) shouldStep = false;
            }
            if (shouldStep) {
                tryStepAside(creep, h);
                h.rerouteUntil = Math.max(Game.time + 5, h.rerouteUntil || 0);
                delete creep.memory._move;
            }
            h.stuckCount = 0;
        }
        if (h.rerouteUntil && Game.time >= h.rerouteUntil) h.rerouteUntil = 0;

        // ── BUILD VIEW ─────────────────────────────────────────────────────
        var view = getRoomView(creep.room);
        if (!view) return;

        // If we are already carrying a factory input resource, keep that cargo
        // attached to the factory task so it cannot fall through to the generic
        // storage dump path when the assignment changes mid-route.
        recoverFactoryInputAssignment(creep, view);

        // ── PRIORITY: DEPOSIT NON-ENERGY MINERALS ──────────────────────────
        // If carrying minerals and NOT on a mineral pickup task, deposit immediately.
        var mineralType = null;
        var sKeys = Object.keys(creep.store);
        for (var ki = 0; ki < sKeys.length; ki++) {
            if (sKeys[ki] !== RESOURCE_ENERGY && creep.store[sKeys[ki]] > 0) { mineralType = sKeys[ki]; break; }
        }
        if (mineralType) {
            var curAM = getAssignment(creep);
            if (!curAM) {
                var depTgt = null;
                if (view.storage && view.storage.store.getFreeCapacity(mineralType) > 0) depTgt = view.storage;
                else if (view.terminal && view.terminal.store.getFreeCapacity(mineralType) > 0) depTgt = view.terminal;
                if (depTgt) {
                    if (cheb(creep.pos, depTgt.pos) > 1) { smartMove(creep, depTgt); return; }
                    delete creep.memory._move;
                    creep.transfer(depTgt, mineralType);
                    return;
                }
                return; // Can't deposit — wait
            }
        }

        // Cargo policy: clear incompatible cargo before attempting tasks.
        var currentAssignment = getAssignment(creep);
        if (deliveryNoProgressWatchdog(creep, currentAssignment, h)) return;
        if (cleanupCargoForTask(creep, currentAssignment)) return;

        // ── VALIDATE / PICK ASSIGNMENT ─────────────────────────────────────
        var a = currentAssignment;

        // TTL check — assignedTick is refreshed on every successful withdraw
        // or transfer, so this now only fires for tasks making NO progress.
        if (a && a.assignedTick && Game.time - a.assignedTick > ASSIGNMENT_TTL) {
            clearAssignment(creep, "TTL", true);
            a = null;
        }

        // Completion check (skip on tick assigned/progressed — store data for
        // intents issued that tick is stale)
        if (a && a.assignedTick !== Game.time && isAssignmentDone(creep, view, a, h)) {
            // Keep factory_input assignments alive while we still carry the
            // matching resource. Otherwise the creep can abandon a valid
            // load mid-route and dump it back to storage before reaching the
            // factory.
            if (a.type === "factory_input") {
                var carriedFactoryRes = getFactoryTaskResource(a);
                if (carriedFactoryRes && (creep.store[carriedFactoryRes] || 0) > 0) {
                    creep.memory.s = "delivering";
                } else {
                    clearAssignment(creep, "done", true);
                    a = null;
                }
            } else {
                clearAssignment(creep, "done", true);
                a = null;
            }
        }

        // Pick new task if idle
        if (!a || creep.memory.s === "idle") {
            // Try fallback dump first if carrying energy with nothing to do
            if (a && creep.memory.s === "idle" && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                if (tryFallbackDump(creep, view)) return;
            }
            delete creep.memory.sl;
            if (!pickTask(creep, view, h)) return; // idle, sleeping
            a = getAssignment(creep);
            if (!a) return;
            if (cleanupCargoForTask(creep, a)) return;
        }

        // ── EXECUTE STATE ──────────────────────────────────────────────────
        if (creep.memory.s === "fetching") {
            executeFetch(creep, a, view, h);
        } else if (creep.memory.s === "delivering") {
            executeDeliver(creep, a, view, h);
        } else {
            // Unknown state — reset
            creep.memory.s = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ? "delivering" : "fetching";
        }

        // ── SAME-TICK RE-PICK: if the task just completed, the transfer intent
        //    is spent but the move intent is still free. Pick a new task and
        //    start executing it so we don't waste the move. ──────────────────
        if (creep.memory.s === "idle" && !getAssignment(creep)) {
            if (pickTask(creep, view, h)) {
                a = getAssignment(creep);
                if (a) {
                    if (cleanupCargoForTask(creep, a)) return;
                    if (creep.memory.s === "fetching") {
                        executeFetch(creep, a, view, h);
                    } else if (creep.memory.s === "delivering") {
                        executeDeliver(creep, a, view, h);
                    }
                }
            }
        }
    }
};

module.exports = roleSupplier;
