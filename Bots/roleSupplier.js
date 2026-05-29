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
const ASSIGNMENT_TTL             = 75;
const NO_PATH_TTL                = 6;
const AVOID_PAIR_TTL             = 5;
const EXT_ROUTE_SKIP_LIMIT       = 8;
const EXT_ROUTE_RECOMPUTE_TICKS  = 200;
const TERMINAL_TARGET            = 20000;
const TERMINAL_MIN               = 19500;
const TERMINAL_MAX               = 20500;

const getRoomState    = require("getRoomState");
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
    //materials_empty:      55,
    terminal_balance:     60,
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
        powerSpawns:  resolve(STRUCTURE_POWER_SPAWN,  function(s) { return s.my; }),
        nukers:       resolve(STRUCTURE_NUKER,        function(n) { return n.my; }),
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
        } else if (t.type === "materials_empty" && energyUsed > 0) {
            // Need to dump energy before fetching minerals
            creep.memory.s = "delivering";
            a.extra = (a.extra ? a.extra + "," : "") + "dump_energy";
            setAssignment(creep, a);
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
    container_empty: true, container_drain: true, materials_drain_energy: true,
    materials_empty: true, link_drain: true, link_fill: true,
    terminal_balance: true
};

function isWithdrawTask(type) { return WITHDRAW_TASKS[type] === true; }

function shouldDeliverImmediately(type, energyUsed) {
    if (type === "link_fill" && energyUsed > 0) return true;
    if (type === "terminal_balance" && energyUsed > 0) return true;
    return false;
}

// ════════════════════════════════════════════════════════════════════════════════
//  EXTENSION ROUTE (greedy nearest-neighbor, with waypoint-aware positions)
// ════════════════════════════════════════════════════════════════════════════════

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
    var extMap = {};
    for (var i = 0; i < emptyExts.length; i++) {
        var ext = emptyExts[i];
        extMap[ext.id] = {
            pos: (wpMap && wpMap[ext.id]) ? wpMap[ext.id] : ext.pos,
            cap: ext.store.getCapacity(RESOURCE_ENERGY) || 200
        };
    }

    // Greedy nearest-neighbor tour using waypoint positions
    var remaining = emptyExts.map(function(e) { return e.id; });
    var rawRoute = [];
    var cur = creep.pos;
    while (remaining.length > 0) {
        var bestIdx = 0, bestDist = cheb(cur, extMap[remaining[0]].pos);
        for (var j = 1; j < remaining.length; j++) {
            var d = cheb(cur, extMap[remaining[j]].pos);
            if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        var pickedId = remaining.splice(bestIdx, 1)[0];
        rawRoute.push(pickedId);
        cur = extMap[pickedId].pos;
    }

    if (!view.storage) return rawRoute;

    // Insert REFUEL sentinels where the creep would run out of energy
    var storagePos = view.storage.pos;
    var fullCap    = getEnergyCapacity(creep);

    if (fullCap <= 0) return rawRoute;

    var energy     = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    var result     = [];
    var segStart   = 0;
    var segOrigin  = creep.pos;
    var ri         = 0;

    var refuelCount = 0;
    var maxRefuels  = rawRoute.length + 1;

    while (ri < rawRoute.length) {
        var id = rawRoute[ri];
        var ed = extMap[id];
        if (!ed) { ri++; continue; }

        if (energy >= ed.cap) {
            result.push(id);
            energy -= ed.cap;
            ri++;
            continue;
        }

        refuelCount++;
        if (refuelCount > maxRefuels) {
            while (ri < rawRoute.length) { result.push(rawRoute[ri]); ri++; }
            break;
        }

        // Find cheapest insertion point for the REFUEL sentinel
        var lastPos = result.length > segStart
            ? extMap[result[result.length - 1]].pos : segOrigin;
        var bestOverhead = cheb(lastPos, storagePos) + cheb(storagePos, ed.pos) - cheb(lastPos, ed.pos);
        var bestJ = result.length;

        var jStart = (segOrigin === storagePos) ? segStart + 1 : segStart;
        for (var j = jStart; j < result.length; j++) {
            var pPos = (j === segStart) ? segOrigin : extMap[result[j - 1]].pos;
            var nPos = extMap[result[j]].pos;
            var overhead = cheb(pPos, storagePos) + cheb(storagePos, nPos) - cheb(pPos, nPos);
            if (overhead < bestOverhead) { bestOverhead = overhead; bestJ = j; }
        }

        result.splice(bestJ, 0, "REFUEL");
        segStart  = bestJ + 1;
        segOrigin = storagePos;
        energy    = fullCap;
        for (var k = segStart; k < result.length; k++) {
            if (result[k] !== "REFUEL" && extMap[result[k]]) energy -= extMap[result[k]].cap;
        }
    }

    return result;
}

// ════════════════════════════════════════════════════════════════════════════════
//  VALIDATION — is the current assignment still worth doing?
// ════════════════════════════════════════════════════════════════════════════════

function isAssignmentDone(creep, view, a, h) {
    if (!a || !a.type) return true;

    var src = Game.getObjectById(a.taskId);
    var dst = a.targetId ? Game.getObjectById(a.targetId) : src;

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
    if (a.type === "materials_empty") {
        if (!src.store) return true;
        return (src.store.getUsedCapacity() || 0) - (src.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < 1000;
    }
    if (a.type === "terminal_balance") {
        if (!view.storage || !view.terminal) return true;
        var tE = view.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (a.taskId === view.terminal.id) return tE < TERMINAL_MAX;
        if (a.taskId === view.storage.id) return tE > TERMINAL_MIN;
        return true;
    }

    return false;
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

    // --- Extension: fetch = go to storage ---
    if (a.type === "extension") {
        var stor = view.storage;
        if (!stor || (stor.store.getUsedCapacity(RESOURCE_ENERGY) || 0) === 0) {
            clearAssignment(creep, "ext: storage empty", true);
            return;
        }
        if (creep.pos.isNearTo(stor)) {
            delete creep.memory._move;
            creep.withdraw(stor, RESOURCE_ENERGY);
            creep.memory.s = "delivering";
            // Move toward first route extension after refill
            var route = h.extRoute;
            if (route && route.length > 0) {
                for (var pi = 0; pi < route.length; pi++) {
                    if (route[pi] === "REFUEL") break;
                    var peek = Game.getObjectById(route[pi]);
                    if (peek && cheb(creep.pos, peek.pos) > 1) {
                        smartMove(creep, peek);
                        break;
                    }
                }
            }
        } else {
            smartMove(creep, stor);
        }
        return;
    }

    // --- Materials empty: fetch minerals, not energy ---
    if (a.type === "materials_empty") {
        var matSrc = Game.getObjectById(a.taskId);
        if (!matSrc) { clearAssignment(creep, "mat src gone", true); return; }
        var resType = null;
        var sk = Object.keys(matSrc.store);
        for (var i = 0; i < sk.length; i++) {
            if (sk[i] !== RESOURCE_ENERGY && matSrc.store[sk[i]] > 0) { resType = sk[i]; break; }
        }
        if (!resType) { clearAssignment(creep, "mat no minerals", true); return; }

        if (cheb(creep.pos, matSrc.pos) > 1) { smartMove(creep, matSrc); return; }
        delete creep.memory._move;
        var wr = creep.withdraw(matSrc, resType);
        if (wr === OK || wr === ERR_FULL) creep.memory.s = "delivering";
        else if (wr !== ERR_NOT_IN_RANGE) clearAssignment(creep, "mat withdraw err " + wr, true);
        return;
    }

    // --- Standard fetch: determine source ---
    var source = null;

    if (isWithdrawTask(a.type)) {
        // Withdraw tasks: source IS the taskId
        source = Game.getObjectById(a.taskId);
        if (!source || (source.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= 0) {
            clearAssignment(creep, "fetch src empty", true);
            return;
        }
    } else {
        // Transfer tasks: find energy source
        source = findEnergySource(creep, view, h);
        if (!source) { clearAssignment(creep, "no energy source", true); return; }
        h.fetchSourceId = source.id;
    }

    // Compute withdraw amount
    var amt = null;
    var available = source.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var free = creep.store.getFreeCapacity();

    if (a.type === "link_drain") {
        var maxDrain = Math.max(0, available - LINK_FILL_THRESHOLD);
        if (maxDrain <= 0) { clearAssignment(creep, "link drained enough", true); return; }
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
    } else if (wRes === ERR_NOT_ENOUGH_RESOURCES) {
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

    // --- Materials empty: dump energy first ---
    if (a.type === "materials_empty" && a.extra && a.extra.indexOf("dump_energy") >= 0) {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            // Energy dumped, strip flag and switch to fetch minerals
            a.extra = a.extra.replace(/,?dump_energy/, "");
            setAssignment(creep, a);
            creep.memory.s = "fetching";
            return;
        }
        var dumpTgt = view.storage || view.terminal;
        if (!dumpTgt || dumpTgt.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
            clearAssignment(creep, "no dump target", true); return;
        }
        if (cheb(creep.pos, dumpTgt.pos) > 1) { smartMove(creep, dumpTgt); return; }
        delete creep.memory._move;
        creep.transfer(dumpTgt, RESOURCE_ENERGY);
        return;
    }

    // --- Extension route delivery ---
    if (a.type === "extension") {
        executeExtensionDeliver(creep, a, view, h);
        return;
    }

    // --- Determine target and resource type ---
    var target = Game.getObjectById(a.targetId || a.taskId);
    if (!target) { clearAssignment(creep, "target gone", true); return; }

    var resType = RESOURCE_ENERGY;
    if (a.type === "materials_empty") {
        var found = false;
        var ck = Object.keys(creep.store);
        for (var i = 0; i < ck.length; i++) {
            if (ck[i] !== RESOURCE_ENERGY && creep.store[ck[i]] > 0) { resType = ck[i]; found = true; break; }
        }
        if (!found) {
            if (!isAssignmentDone(creep, view, a, h)) { creep.memory.s = "fetching"; return; }
            clearAssignment(creep, "materials done", true); return;
        }
    }

    // Check target capacity
    if (target.store && target.store.getFreeCapacity && target.store.getFreeCapacity(resType) <= 0) {
        // Try alternate target for mineral types
        if (a.type === "materials_empty") {
            var alt = null;
            if (view.storage && view.storage.id !== target.id && view.storage.store.getFreeCapacity(resType) > 0) alt = view.storage;
            else if (view.terminal && view.terminal.id !== target.id && view.terminal.store.getFreeCapacity(resType) > 0) alt = view.terminal;
            if (alt) { a.targetId = alt.id; setAssignment(creep, a); return; }
        }
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

    if (res === OK || res === ERR_FULL) {
        if (isAssignmentDone(creep, view, a, h)) {
            clearAssignment(creep, "task complete", true);
        } else if (creep.store.getUsedCapacity() === 0 ||
                   (a.type === "materials_empty" || a.type === "terminal_balance")) {
            creep.memory.s = "fetching";
        }
    } else if (res !== ERR_NOT_IN_RANGE) {
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
        tryOpportunisticFill(creep, route, view);
        smartMove(creep, targetPos);
        return;
    }
    delete creep.memory._move;

    var energyHave = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    var energyNeed = target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    if (energyHave < energyNeed) {
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

// ── OPPORTUNISTIC FILL: while walking toward route head, fill any adjacent
//    route extension we happen to pass by.
//    Note: RCL8 guard is intentionally absent here. The scanner prevents
//    dispatching a supplier specifically for partial extensions at RCL8, but
//    if the creep is already adjacent while en route, filling them is free. ──
function tryOpportunisticFill(creep, route, view) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return false;

    for (var i = 1; i < route.length; i++) {
        if (route[i] === "REFUEL") break; // don't look past refuel boundaries
        var ext = Game.getObjectById(route[i]);
        if (!ext) continue;
        if (cheb(creep.pos, ext.pos) > 1) continue;
        if ((ext.store.getFreeCapacity(RESOURCE_ENERGY) || 0) <= 0) continue;

        // Adjacent and needs energy — fill it now
        var res = creep.transfer(ext, RESOURCE_ENERGY);
        if (res === OK || res === ERR_FULL) {
            route.splice(i, 1); // remove from route since we just filled it
            return true;
        }
        break; // only one transfer intent per tick
    }
    return false;
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

        // ── PRIORITY: DEPOSIT NON-ENERGY MINERALS ──────────────────────────
        // If carrying minerals and NOT on a mineral pickup task, deposit immediately.
        var mineralType = null;
        var sKeys = Object.keys(creep.store);
        for (var ki = 0; ki < sKeys.length; ki++) {
            if (sKeys[ki] !== RESOURCE_ENERGY && creep.store[sKeys[ki]] > 0) { mineralType = sKeys[ki]; break; }
        }
        if (mineralType) {
            var curAM = getAssignment(creep);
            if (!curAM || curAM.type !== "materials_empty") {
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

        // ── VALIDATE / PICK ASSIGNMENT ─────────────────────────────────────
        var a = getAssignment(creep);

        // TTL check
        if (a && a.assignedTick && Game.time - a.assignedTick > ASSIGNMENT_TTL) {
            clearAssignment(creep, "TTL", true);
            a = null;
        }

        // Completion check (skip on tick assigned — just validated by scanner)
        if (a && a.assignedTick !== Game.time && isAssignmentDone(creep, view, a, h)) {
            clearAssignment(creep, "done", true);
            a = null;
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
