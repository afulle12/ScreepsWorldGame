// LLM: Read docs/codex.js before reviewing or changing this file.
// roleSupplier.js
// Role dispatch: memory.role === 'supplier' -> roleSupplier.run(creep).
// Example: require('roleSupplier').run(creep);
// Example: require('roleSupplier').run(creep);
const SUPPLIER_ENABLED = true;
const SUPPLIER_DEBUG = false;
const IDLE_SLEEP_TICKS = 16;
const IDLE_SHORT_SLEEP = 2;
const LINK_TOTAL_TARGET = 750;
const LINK_FILL_DEADBAND = 200;
const DONOR_DRAIN_THRESHOLD = 200;
const CONTAINER_RESELECT_ENERGY = 50;
const POWER_SPAWN_POWER_TRIGGER = 2;
const POWER_SPAWN_POWER_LOAD = 98;
const POWER_SPAWN_ENERGY_TRIGGER = 200;
const ASSIGNMENT_TTL = 75;
const MAX_TRAVEL_WITHOUT_ACTION = 250;
const NO_PATH_TTL = 6;
const AVOID_PAIR_TTL = 5;
const LOW_TTL_WINDDOWN = 200;
const EXT_ROUTE_SKIP_LIMIT = 8;
const EXT_ROUTE_RECOMPUTE_TICKS = 200;
const TERMINAL_TARGET = 2e4;
const TERMINAL_MIN = 19500;
const TERMINAL_MAX = 20500;
const getRoomState = require("getRoomState");
const factoryManager = require("factoryManager");
const labManager = require("labManager");
const marketLab = require("marketLab");
const memoryManager = require("memoryManager");
const storageManager = require("storageManager");
const terminalManager = require("terminalManager");
const permanentRoomFacts = require("permanentRoomFacts");
const SUPPLIER_WAYPOINT_SEGMENT_LENGTH = 40;
const TASK_PRIORITY = {
  spawn: 20,
  extension: 10,
  tower: 30,
  link_drain: 19,
  link_fill: 36,
  power_spawn_power: 37,
  power_spawn_energy: 38,
  container_empty: 40,
  materials_drain_energy: 45,
  container_drain: 50,
  terminal_balance: 60,
  lab_unload: 55,
  lab_load: 56,
  market_lab_stage: 57,
  factory_input: 58,
  factory_output: 59,
  factory_drain: 61,
  terminal_stock: 68,
  dropped_pickup: 70,
  tombstone_pickup: 70,
  ruin_pickup: 70
};
function effectivePriority(e, r) {
  if (!r) return 999;
  var t = e.memory.supplierPriorities;
  if (t && t[r.type] != null) return t[r.type];
  return r.priority != null ? r.priority : TASK_PRIORITY[r.type] != null ? TASK_PRIORITY[r.type] : 999;
}

function cheb(e, r) {
  var t = e.x - r.x;
  if (t < 0) t = -t;
  var a = e.y - r.y;
  if (a < 0) a = -a;
  return t > a ? t : a;
}

function sup_say(e, r) {
  if (SUPPLIER_DEBUG) e.say(r);
}

function isLowTtlWinddown(e) {
  var r = e && e.room && e.room.controller;
  return !!(r && r.level <= 7 && typeof e.ticksToLive === "number" && e.ticksToLive < LOW_TTL_WINDDOWN);
}

function isValidRoomName(e) {
  return typeof e === "string" && /^[WE]\d+[NS]\d+$/.test(e);
}

function getHeap(e) {
  if (!global._supHeap) global._supHeap = {};
  if (!global._supHeap[e]) {
    global._supHeap[e] = {
      stuckCount: 0,
      lastPos: null,
      lastMovedTick: 0,
      lastTriedMoveTick: 0,
      rerouteUntil: 0,
      noPathCount: 0,
      fetchSourceId: null,
      avoidPairs: [],
      lastCompletedTick: 0,
      lastCompletedType: null,
      lastCompletedTaskId: null,
      lastCompletedTargetId: null,
      consecutiveIdlePicks: 0,
      extRoute: null,
      extRouteTick: 0,
      labLoadRoute: null,
      routeTargetKey: null,
      routeMoveCalls: 0,
      lastPathProbeUntil: 0
    };
  }
  return global._supHeap[e];
}

function pruneHeap() {
  if (!global._supHeap || global._supHeapTick === Game.time) return;
  global._supHeapTick = Game.time;
  var e = Object.keys(global._supHeap);
  for (var r = 0; r < e.length; r++) {
    if (!Game.creeps[e[r]]) delete global._supHeap[e[r]];
  }
  if (global._extWpMapCache) {
    for (var t in global._extWpMapCache) {
      if (!Game.rooms[t]) delete global._extWpMapCache[t];
    }
  }
  if (memoryManager.heap.supplierWaypoints) {
    for (var a in memoryManager.heap.supplierWaypoints) {
      if (!Game.creeps[a]) delete memoryManager.heap.supplierWaypoints[a];
    }
  }
}

function pruneAvoids(e) {
  var r = e.avoidPairs, t = [];
  for (var a = 0; a < r.length; a++) {
    if (Game.time <= r[a].until) t.push(r[a]);
  }
  e.avoidPairs = t;
}

function addAvoid(e, r, t, a) {
  e.avoidPairs.push({
    type: r,
    taskId: t,
    targetId: a || t,
    until: Game.time + AVOID_PAIR_TTL - 1
  });
}

function isAvoided(e, r, t, a) {
  var o = e.avoidPairs, i = a || t;
  for (var n = 0; n < o.length; n++) {
    var s = o[n];
    if (Game.time > s.until) continue;
    if (s.type === r && s.taskId === t && (s.targetId || s.taskId) === i) return true;
  }
  return false;
}

function hasActiveAvoids(e) {
  var r = e.avoidPairs;
  for (var t = 0; t < r.length; t++) {
    if (Game.time <= r[t].until) return true;
  }
  return false;
}

function packAssignment(e) {
  if (!e) return null;
  return e.type + "|" + e.taskId + "|" + (e.targetId || "") + "|" + (e.amount || 0) + "|" + (e.assignedTick || 0) + "|" + (e.extra || "") + "|" + (e.startedTick || 0);
}

function unpackAssignment(e) {
  if (!e) return null;
  var r = e.split("|");
  return {
    type: r[0],
    taskId: r[1],
    targetId: r[2] || null,
    amount: +r[3] || 0,
    assignedTick: +r[4] || 0,
    extra: r[5] || "",
    startedTick: +r[6] || 0
  };
}

function getAssignment(e) {
  var r = getHeap(e.name);
  if (r._aTick === Game.time) return r._aCache;
  r._aCache = unpackAssignment(e.memory.a);
  r._aTick = Game.time;
  return r._aCache;
}

function setAssignment(e, r) {
  var t = getHeap(e.name);
  if (r && !r.startedTick) r.startedTick = Game.time;
  e.memory.a = packAssignment(r);
  t._aCache = r;
  t._aTick = Game.time;
  if (global._taskClaimCache) delete global._taskClaimCache[e.room.name];
}

function clearAssignment(e, r, t) {
  var a = getAssignment(e);
  var o = getHeap(e.name);
  if (t && a && a.type) {
    addAvoid(o, a.type, a.taskId, a.targetId);
    o.lastCompletedTick = Game.time;
    o.lastCompletedType = a.type;
    o.lastCompletedTaskId = a.taskId;
    o.lastCompletedTargetId = a.targetId;
  }
  if (a && a.type === "extension") {
    o.extRoute = null;
    o.extRouteTick = 0;
  }
  setAssignment(e, null);
  e.memory.s = "idle";
  o.noPathCount = 0;
  o.fetchSourceId = null;
  if (!a || a.type === "lab_load") o.labLoadRoute = null;
  delete e.memory.sl;
  delete e.memory._move;
  delete e.memory.ff;
  clearSupplierWaypoints(e.name);
  if (SUPPLIER_DEBUG) console.log("[SUP] " + e.name + " clear: " + r);
}

function refreshProgress(e, r) {
  if (!r) return;
  r.assignedTick = Game.time;
  setAssignment(e, r);
}

function getSupplierWaypointCache() {
  if (!memoryManager.heap.supplierWaypoints) memoryManager.heap.supplierWaypoints = {};
  return memoryManager.heap.supplierWaypoints;
}

function clearSupplierWaypoints(e) {
  var r = getSupplierWaypointCache();
  if (r[e]) delete r[e];
}

function supplierCostCallback(e) {
  var r = new PathFinder.CostMatrix;
  var t = Game.rooms[e];
  if (!t) return r;
  var a = t.getTerrain();
  for (var o = 0; o < 50; o++) {
    for (var i = 0; i < 50; i++) {
      if (a.get(o, i) === TERRAIN_MASK_WALL) {
        r.set(o, i, 255);
      }
    }
  }
  var n = t.find(FIND_STRUCTURES);
  for (var s = 0; s < n.length; s++) {
    var u = n[s];
    if (!u) continue;
    if (u.structureType === STRUCTURE_ROAD) {
      r.set(u.pos.x, u.pos.y, 1);
    } else if (u.structureType === STRUCTURE_CONTAINER) {} else if (u.structureType === STRUCTURE_RAMPART) {
      if (!u.my && !u.isPublic) r.set(u.pos.x, u.pos.y, 255);
    } else if (u.structureType === STRUCTURE_WALL || OBSTACLE_OBJECT_TYPES.indexOf(u.structureType) !== -1) {
      r.set(u.pos.x, u.pos.y, 255);
    }
  }
  return r;
}

function getCurrentSupplierWaypoint(e) {
  var r = getSupplierWaypointCache();
  var t = r[e.name];
  if (!t || !Array.isArray(t.waypoints) || t.waypoints.length === 0) {
    return null;
  }
  while (t.waypoints.length > 0) {
    var a = t.waypoints[0];
    if (!a || typeof a.x !== "number" || typeof a.y !== "number" || !a.roomName) {
      t.waypoints.shift();
      continue;
    }
    var o = new RoomPosition(a.x, a.y, a.roomName);
    if (e.pos.isNearTo(o)) {
      t.waypoints.shift();
      continue;
    }
    return o;
  }
  clearSupplierWaypoints(e.name);
  return null;
}

function moveToSupplierWaypoint(e, r, t) {
  var a = getHeap(e.name);
  var o = {};
  if (t) {
    for (var i in t) o[i] = t[i];
  }
  o.reusePath = 5;
  o.maxOps = 500;
  o.range = 0;
  a.lastTriedMoveTick = Game.time;
  if (e.fatigue === 0) e.moveTo(r, o);
}

function buildSupplierWaypointsAndMove(e, r, t) {
  var a = r.pos || r;
  var o = cheb(e.pos, a);
  var i = t && t.maxOps || Math.min(2e3, Math.max(200, o * 50));
  var n = PathFinder.search(e.pos, {
    pos: a,
    range: t && typeof t.range === "number" ? t.range : 1
  }, {
    maxOps: i,
    plainCost: 2,
    swampCost: 10,
    roomCallback: supplierCostCallback
  });
  if (n.incomplete || !n.path || n.path.length === 0) return false;
  if (n.path.length <= SUPPLIER_WAYPOINT_SEGMENT_LENGTH) return false;
  var s = [];
  for (var u = SUPPLIER_WAYPOINT_SEGMENT_LENGTH; u < n.path.length; u += SUPPLIER_WAYPOINT_SEGMENT_LENGTH) {
    var l = n.path[u];
    if (l.x === a.x && l.y === a.y && l.roomName === a.roomName) continue;
    s.push({
      x: l.x,
      y: l.y,
      roomName: l.roomName
    });
  }
  if (s.length === 0) return false;
  var c = getSupplierWaypointCache();
  c[e.name] = {
    waypoints: s,
    created: {
      x: e.pos.x,
      y: e.pos.y,
      roomName: e.room.name,
      time: Game.time
    }
  };
  var m = getCurrentSupplierWaypoint(e);
  if (m) {
    moveToSupplierWaypoint(e, m, t);
    return true;
  }
  return false;
}

function moveToWithSupplierWaypoints(e, r, t) {
  var a = r.pos || r;
  var o = getSupplierWaypointCache();
  var i = o[e.name];
  if (i && Array.isArray(i.waypoints) && i.waypoints.length > 0) {
    if (i.created) {
      var n = i.created;
      var s = Math.max(Math.abs(e.pos.x - n.x), Math.abs(e.pos.y - n.y));
      if (e.room.name === n.roomName && s > SUPPLIER_WAYPOINT_SEGMENT_LENGTH * 2) {
        clearSupplierWaypoints(e.name);
        return buildSupplierWaypointsAndMove(e, a, t) || fallbackSupplierMoveTo(e, a, t);
      }
    }
    var u = getCurrentSupplierWaypoint(e);
    if (!u) {
      clearSupplierWaypoints(e.name);
      return fallbackSupplierMoveTo(e, a, t);
    }
    moveToSupplierWaypoint(e, u, t);
    return true;
  }
  return buildSupplierWaypointsAndMove(e, a, t) || fallbackSupplierMoveTo(e, a, t);
}

function fallbackSupplierMoveTo(e, r, t) {
  var a = r.pos || r;
  var o = getHeap(e.name);
  o.lastTriedMoveTick = Game.time;
  if (e.fatigue === 0) e.moveTo(a, t);
  return true;
}

function smartMove(e, r, t) {
  var a = getHeap(e.name);
  if (e.fatigue > 0) return ERR_TIRED;
  if (a.lastTriedMoveTick === Game.time) return ERR_BUSY;
  var o = r && (r.pos || r);
  if (!o || !Number.isInteger(o.x) || !Number.isInteger(o.y) || o.x < 0 || o.x > 49 || o.y < 0 || o.y > 49) {
    return ERR_INVALID_TARGET;
  }
  var i = o.roomName || e.room.name;
  if (!isValidRoomName(i)) return ERR_INVALID_TARGET;
  var n = o.roomName ? o : new RoomPosition(o.x, o.y, i);
  var s = cheb(e.pos, n);
  var u = !n.roomName || n.roomName === e.room.name ? getRoomState.get(e.room.name) : null;
  var l = u && u.permanentFacts ? permanentRoomFacts.estimateTravel(u.permanentFacts, e.pos, n) : s;
  var c = Math.max(s, l);
  var m = Game.time < a.rerouteUntil;
  var p = (n.roomName || e.room.name) + ":" + n.x + ":" + n.y;
  if (a.routeTargetKey !== p) {
    a.routeTargetKey = p;
    a.routeMoveCalls = 0;
    a.lastPathProbeUntil = 0;
  } else {
    a.routeMoveCalls++;
  }
  var f = getSupplierWaypointCache()[e.name];
  var g = f && Array.isArray(f.waypoints) && f.waypoints.length > 0;
  var d = !g && Game.time >= a.lastPathProbeUntil && (c > SUPPLIER_WAYPOINT_SEGMENT_LENGTH || s > 12 && a.routeMoveCalls >= 12);
  if ((g || d) && !m) {
    var y = {
      reusePath: Math.min(10, Math.max(3, c >> 1)),
      maxOps: Math.min(2e3, Math.max(200, c * 50)),
      heuristicWeight: 1.2,
      range: 1
    };
    if (t) {
      for (var v in t) y[v] = t[v];
    }
    if (!g) a.lastPathProbeUntil = Game.time + 25;
    a.lastTriedMoveTick = Game.time;
    return moveToWithSupplierWaypoints(e, n, y) ? OK : ERR_NO_PATH;
  }
  var R = {
    reusePath: m ? 0 : Math.min(10, Math.max(3, c >> 1)),
    maxOps: Math.min(2e3, Math.max(200, c * 50)),
    heuristicWeight: 1.2,
    range: 1
  };
  if (t) {
    for (var E in t) R[E] = t[E];
  }
  a.lastTriedMoveTick = Game.time;
  var _ = e.moveTo(n, R);
  if (_ === ERR_NO_PATH && !m) {
    a.rerouteUntil = Game.time + 3;
    delete e.memory._move;
  }
  return _;
}

function ensureRoomStateInit() {
  if (getRoomState && typeof getRoomState.init === "function") {
    if (global._rsInitTick !== Game.time) {
      getRoomState.init();
      global._rsInitTick = Game.time;
    }
  }
}

function getRoomView(e) {
  if (global._rvTick !== Game.time) {
    global._rvTick = Game.time;
    global._rvCache = {};
  }
  if (global._rvCache[e.name]) return global._rvCache[e.name];
  ensureRoomStateInit();
  var r = getRoomState.get(e.name);
  if (!r) return null;
  var t = r.structuresByType || {};
  function resolve(e, r) {
    var a = t[e] || [];
    if (!r) return a;
    var o = [];
    for (var i = 0; i < a.length; i++) {
      if (r(a[i])) o.push(a[i]);
    }
    return o;
  }
  var a = {
    roomName: e.name,
    controller: e.controller,
    storage: e.storage,
    terminal: e.terminal,
    containers: resolve(STRUCTURE_CONTAINER),
    spawns: resolve(STRUCTURE_SPAWN, function(e) {
      return e.my;
    }),
    extractors: resolve(STRUCTURE_EXTRACTOR, function(e) {
      return e.my;
    }),
    sources: r.sources || [],
    towers: resolve(STRUCTURE_TOWER, function(e) {
      return e.my;
    }),
    links: resolve(STRUCTURE_LINK, function(e) {
      return e.my;
    }),
    extensions: resolve(STRUCTURE_EXTENSION, function(e) {
      return e.my;
    }),
    labs: resolve(STRUCTURE_LAB, function(e) {
      return e.my;
    }),
    powerSpawns: resolve(STRUCTURE_POWER_SPAWN, function(e) {
      return e.my;
    }),
    nukers: resolve(STRUCTURE_NUKER, function(e) {
      return e.my;
    }),
    factory: resolve(STRUCTURE_FACTORY, function(e) {
      return e.my;
    })[0] || null,
    suppliers: (r.myCreeps || []).filter(function(e) {
      return e.memory && e.memory.role === "supplier";
    }),
    towerFillers: (r.myCreeps || []).filter(function(e) {
      return e.memory && e.memory.role === "towerFiller" && !e.spawning;
    })
  };
  global._rvCache[e.name] = a;
  return a;
}

function ensureContainerLabels(e, r) {
  if (!r) return;
  var t = e.memory;
  if (!t.containerLabels) t.containerLabels = {};
  var a = r.containers.map(function(e) {
    return e.id;
  }).sort().join(",") + ":" + r.links.map(function(e) {
    return e.id;
  }).sort().join(",");
  var o = t._clKey !== a;
  var i = t.layoutVersion;
  if (!o && typeof i === "number" && Game.time % 1e3 !== 0) return;
  var n = {}, s = {};
  var u = {};
  for (var l = 0; l < r.sources.length; l++) {
    for (var c = 0; c < r.links.length; c++) {
      if (cheb(r.links[c].pos, r.sources[l].pos) <= 2) {
        u[r.sources[l].id] = true;
        break;
      }
    }
  }
  for (var m = 0; m < r.containers.length; m++) {
    var p = r.containers[m];
    if (p.pos.findInRange(r.extractors, 1).length > 0) {
      n[p.id] = "materials";
    } else if (r.controller && cheb(p.pos, r.controller.pos) <= 2) {
      n[p.id] = "recipient";
    } else if (p.pos.findInRange(r.sources, 4).length > 0) {
      n[p.id] = "donor";
      for (var f = 0; f < r.sources.length; f++) {
        if (cheb(p.pos, r.sources[f].pos) <= 2 && u[r.sources[f].id]) {
          s[p.id] = true;
          break;
        }
      }
    } else {
      n[p.id] = "recipient";
    }
  }
  t.containerLabels = n;
  t.linkServedBlacklist = s;
  t._clKey = a;
  if (typeof i !== "number") t.layoutVersion = 1; else if (o) t.layoutVersion = i + 1;
  if (t.layoutVersion !== i) memoryManager.requestSave();
}

function isLinkServed(e, r) {
  return (e.memory.linkServedBlacklist || {})[r] === true;
}

function getClaimCache(e) {
  if (global._taskClaimTick !== Game.time) {
    global._taskClaimTick = Game.time;
    global._taskClaimCache = {};
  }
  if (global._taskClaimCache[e.roomName]) return global._taskClaimCache[e.roomName];
  var r = {};
  for (var t = 0; t < e.suppliers.length; t++) {
    var a = e.suppliers[t];
    var o = getAssignment(a);
    if (o && o.type) {
      r[o.type + "|" + o.taskId + "|" + (o.targetId || "")] = a.name;
    }
    var i = getHeap(a.name).labLoadRoute;
    if (i) {
      for (var n = 0; n < i.length; n++) {
        var s = i[n];
        r["lab_load|" + s.taskId + "|" + (s.targetId || "")] = a.name;
      }
    }
  }
  global._taskClaimCache[e.roomName] = r;
  return r;
}

function isClaimed(e, r, t, a, o) {
  var i = getClaimCache(e);
  var n = i[t + "|" + a + "|" + (o || "")];
  return n && n !== r.name;
}

function getFactoryTaskResource(e) {
  return parseExtra(e && e.extra, "res") || parseExtra(e && e.extra, "resource");
}

function factoryFetchKey(e, r) {
  if (!e || !r) return null;
  return e.type + "|" + e.taskId + "|" + (e.targetId || "") + "|" + r;
}

function markFactoryFetched(e, r, t) {
  var a = factoryFetchKey(r, t);
  if (a) e.memory.ff = a;
}

function hasFactoryFetched(e, r, t) {
  var a = factoryFetchKey(r, t);
  return !!(a && e.memory.ff === a);
}

function getMarketLabStageResource(e) {
  return parseExtra(e && e.extra, "res") || parseExtra(e && e.extra, "resource");
}

function getLabTaskResource(e) {
  return parseExtra(e && e.extra, "res") || parseExtra(e && e.extra, "resource");
}

function getLabTaskLabId(e) {
  return parseExtra(e && e.extra, "lab");
}

function getTerminalStockResource(e) {
  return parseExtra(e && e.extra, "res") || parseExtra(e && e.extra, "resource");
}

function getCarriedFactoryInputResource(e, r) {
  if (!e || !r || !r.inputs) return null;
  var t = Object.keys(e.store);
  for (var a = 0; a < t.length; a++) {
    var o = t[a];
    if ((e.store[o] || 0) <= 0) continue;
    if (r.inputs[o] !== undefined) return o;
  }
  return null;
}

function recoverFactoryInputAssignment(e, r) {
  if (!e || !r || !r.factory) return false;
  var t = getActiveFactoryOrder(r.roomName);
  if (!t) return false;
  var a = factoryManager.getRecipe(t.product);
  if (!a || !a.inputs) return false;
  if ((t.phase || "loading") !== "loading") return false;
  var o = getCarriedFactoryInputResource(e, a);
  if (!o) return false;
  if (factoryInputDeficit(r.factory, t, a, o) <= 0) return false;
  var i = t.id + ":" + o;
  var n = getAssignment(e);
  if (n && n.type !== "factory_input") return false;
  if (n && n.type === "factory_input" && n.taskId === i && n.targetId === r.factory.id) {
    return false;
  }
  setAssignment(e, {
    type: "factory_input",
    taskId: i,
    targetId: r.factory.id,
    amount: e.store[o] || 0,
    assignedTick: Game.time,
    extra: "res=" + o + (t.reservationProgram ? ",program=" + t.reservationProgram : "")
  });
  e.memory.s = "delivering";
  delete e.memory.sl;
  return true;
}

function findTerminalOpById(e) {
  var r = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
  for (var t = 0; t < r.length; t++) {
    if (r[t] && r[t].id === e) return r[t];
  }
  return null;
}

function getLabOrder(e) {
  return labManager && typeof labManager.getActiveOrder === "function" ? labManager.getActiveOrder(e) : null;
}

function labHasMineral(e) {
  return e && (e.mineralAmount || 0) > 0 && e.mineralType;
}

function chooseLabLoadSource(e, r, t) {
  if (!e || !r) return null;
  var a = e.storage;
  var o = e.terminal;
  var i = getLabLoadSourceAvailable(e.name, r, t, o);
  var n = getLabLoadSourceAvailable(e.name, r, t, a);
  var s = t ? getProgramReserved(e.name, r, t, "terminal") : 0;
  var u = t ? getProgramReserved(e.name, r, t, "storage") : 0;
  if (t && s > 0 && i > 0) return o;
  if (t && u > 0 && n > 0) return a;
  if (i > 0) return o;
  if (n > 0) return a;
  return null;
}

function getProgramReserved(e, r, t, a) {
  if (!e || !r || !t || !a) return 0;
  var o = storageManager.storageFind(e, r);
  var i = o && o[a] && Array.isArray(o[a].reservations) ? o[a].reservations : [];
  for (var n = 0; n < i.length; n++) {
    if (i[n] && i[n].program === t) return i[n].amount || 0;
  }
  return 0;
}

function getLabLoadSourceAvailable(e, r, t, a) {
  if (!e || !r || !a || !a.store) return 0;
  var o = a.store[r] || 0;
  var i = a.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage";
  var n = storageManager.storageFind(e, r);
  var s = n && n[i];
  var u = s ? s.reserved || 0 : 0;
  var l = Math.max(0, o - u);
  return Math.min(o, l + getProgramReserved(e, r, t, i));
}

function consumeProgramReservation(e, r, t, a, o) {
  if (!e || !r || !t || !a || !o) return;
  storageManager.consume(e, r, a, t, o);
}

function getActiveFactoryOrder(e) {
  var r = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
  for (var t = 0; t < r.length; t++) {
    var a = r[t];
    if (a && a.room === e && a.status === "active") return a;
  }
  return null;
}

function chooseFactorySink(e) {
  if (!e) return null;
  if (e.storage && e.storage.store.getFreeCapacity() > 0) return e.storage;
  if (e.terminal && e.terminal.store.getFreeCapacity() > 0) return e.terminal;
  return null;
}

function chooseFactorySource(e, r, t) {
  if (!e || !r) return null;
  var a = e.storage;
  var o = e.terminal;
  var i = a ? a.store[r] || 0 : 0;
  var n = o ? o.store[r] || 0 : 0;
  var s = t ? getProgramReserved(e.name, r, t, "storage") : 0;
  var u = t ? getProgramReserved(e.name, r, t, "terminal") : 0;
  if (t && s > 0 && i > 0) return a;
  if (t && u > 0 && n > 0) return o;
  if (i > 0) return a;
  if (n > 0) return o;
  return null;
}

function factoryCycleInputTotal(e, r) {
  if (!e || !e.store || !r || !r.inputs) return 0;
  var t = 0;
  for (var a in r.inputs) t += e.store[a] || 0;
  return t;
}

function factoryCycleRemainingBatches(e) {
  if (!e) return 0;
  return Math.max(0, (e.cycleBatches || 0) - (e.cycleBatchesQueued || 0));
}

function factoryCycleTargetTotal(e, r) {
  if (!e || !r || !r.inputs) return 0;
  var t = factoryCycleRemainingBatches(e);
  var a = 0;
  for (var o in r.inputs) a += (r.inputs[o] || 0) * t;
  return a;
}

function factoryInputLoadBudget(e, r, t) {
  var a = Math.max(0, factoryCycleTargetTotal(r, t) - factoryCycleInputTotal(e, t));
  var o = e && e.store && e.store.getFreeCapacity ? e.store.getFreeCapacity() || 0 : a;
  return Math.max(0, Math.min(a, o));
}

function factoryInputDeficit(e, r, t, a) {
  if (!e || !e.store || !r || !t || !t.inputs || t.inputs[a] === undefined) return 0;
  var o = (t.inputs[a] || 0) * factoryCycleRemainingBatches(r);
  return Math.max(0, o - (e.store[a] || 0));
}

function getEnergyCapacity(e) {
  return e.store.getCapacity(RESOURCE_ENERGY) || e.store.getCapacity() || e.store.getFreeCapacity() + e.store.getUsedCapacity() || 0;
}

function getControllerLink(e) {
  if (!e || !e.controller || !e.links) return null;
  for (var r = 0; r < e.links.length; r++) {
    if (cheb(e.links[r].pos, e.controller.pos) <= 2) return e.links[r];
  }
  return null;
}

function getStorageLinkTarget(e, r) {
  if (!r || !r.store) return 0;
  var t = getControllerLink(e);
  var a = 0;
  if (t) {
    a = Math.max(0, LINK_TOTAL_TARGET - (t.store.getUsedCapacity(RESOURCE_ENERGY) || 0));
  }
  var o = r.store.getCapacity(RESOURCE_ENERGY);
  return typeof o === "number" ? Math.min(a, o) : a;
}

function isPowerUpgradeTask(e) {
  return e === "power_spawn_power" || e === "power_spawn_energy";
}

function getPowerUpgradeResource(e) {
  if (!e) return null;
  if (e.type === "power_spawn_power") return RESOURCE_POWER;
  if (e.type === "power_spawn_energy") return RESOURCE_ENERGY;
  return null;
}

function isPowerUpgradeActive(e) {
  var r = Memory.powerUpgrade;
  return !!(r && r.targetLevel > Game.gpl.level && r.rooms && r.rooms.indexOf(e) >= 0);
}

function getExtWpMap(e, r) {
  var t = e.name;
  if (!global._extWpMapCache) global._extWpMapCache = {};
  if (!global._extWpMapCache[t]) global._extWpMapCache[t] = {};
  var a = r.map(e => e.id).sort().join(",");
  if (global._extWpMapCache[t].key === a) return global._extWpMapCache[t].map;
  var o = {};
  var i = {};
  var n = e.getTerrain();
  for (var s = 0; s < r.length; s++) {
    var u = r[s];
    for (var l = -1; l <= 1; l++) {
      for (var c = -1; c <= 1; c++) {
        if (l === 0 && c === 0) continue;
        var m = u.pos.x + l, p = u.pos.y + c;
        if (m < 0 || m > 49 || p < 0 || p > 49) continue;
        if (n.get(m, p) === TERRAIN_MASK_WALL) continue;
        var f = e.lookForAt(LOOK_STRUCTURES, m, p);
        var g = false;
        for (var d = 0; d < f.length; d++) {
          var y = f[d].structureType;
          if (y !== STRUCTURE_ROAD && y !== STRUCTURE_CONTAINER) {
            g = true;
            break;
          }
        }
        if (g) continue;
        var v = m + "," + p;
        if (!i[v]) i[v] = [];
        i[v].push(u.id);
      }
    }
  }
  if (Object.keys(i).length === 0) {
    for (var R = 0; R < r.length; R++) {
      var E = r[R].id;
      o[E] = {
        x: r[R].pos.x,
        y: r[R].pos.y
      };
    }
  } else {
    var _ = r.map(e => e.id);
    while (_.length > 0) {
      var h = null, T = 0;
      for (var k in i) {
        var C = [];
        var b = i[k];
        for (var I = 0; I < b.length; I++) {
          if (_.indexOf(b[I]) !== -1) C.push(b[I]);
        }
        if (C.length > T || C.length === T && h === null) {
          T = C.length;
          h = k;
        }
      }
      if (!h) break;
      var O = h.split(",");
      var S = {
        x: +O[0],
        y: +O[1]
      };
      var U = i[h].filter(function(e) {
        return _.indexOf(e) !== -1;
      });
      for (var N = 0; N < U.length; N++) {
        o[U[N]] = S;
        var A = _.indexOf(U[N]);
        if (A !== -1) _.splice(A, 1);
      }
    }
    for (var L = 0; L < _.length; L++) {
      var G = Game.getObjectById(_[L]);
      if (G) o[_[L]] = {
        x: G.pos.x,
        y: G.pos.y
      };
    }
  }
  global._extWpMapCache[t] = {
    key: a,
    map: o
  };
  return o;
}

//  TASK SCANNER — runs ONCE per room per tick, returns sorted task list
function scanRoomTasks(e, r, t) {
  if (global._scanTick !== Game.time) {
    global._scanTick = Game.time;
    global._scanCache = {};
  }
  if (!t && global._scanCache[e.name]) return global._scanCache[e.name];
  ensureContainerLabels(e, r);
  var a = [];
  function emit(e) {
    if (e) a.push(e);
  }
  var o = r.controller && r.controller.level >= 8;
  for (var i = 0; i < r.spawns.length; i++) {
    var n = r.spawns[i];
    var s = n.store.getFreeCapacity(RESOURCE_ENERGY);
    if (s <= 0) continue;
    if (o && !t && (n.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
    var u = false;
    for (var l = 0; l < r.sources.length; l++) {
      if (cheb(n.pos, r.sources[l].pos) <= 2) {
        u = true;
        break;
      }
    }
    if (u) continue;
    a.push({
      type: "spawn",
      taskId: n.id,
      targetId: n.id,
      amount: s,
      priority: TASK_PRIORITY.spawn
    });
  }
  var c = 0, m = 0;
  var p = [];
  for (var f = 0; f < r.extensions.length; f++) {
    var g = r.extensions[f];
    var d = g.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    if (d <= 0) continue;
    if (o && !t && (g.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
    c++;
    m += d;
    p.push(g);
  }
  if (c > 0) {
    if (!r._extWpMap) r._extWpMap = getExtWpMap(e, p);
    r._emptyExts = p;
    a.push({
      type: "extension",
      taskId: "ext_" + e.name,
      targetId: null,
      amount: m,
      priority: TASK_PRIORITY.extension
    });
  }
  if (r.towerFillers.length === 0) {
    for (var y = 0; y < r.towers.length; y++) {
      var v = r.towers[y];
      var R = v.store.getFreeCapacity(RESOURCE_ENERGY);
      var E = (v.store[RESOURCE_ENERGY] || 0) / v.store.getCapacity(RESOURCE_ENERGY);
      if (R <= 0 || E >= .75) continue;
      a.push({
        type: "tower",
        taskId: v.id,
        targetId: v.id,
        amount: R,
        priority: TASK_PRIORITY.tower
      });
    }
  }
  if (r.storage) {
    var _ = r.storage;
    var h = _.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    e: for (var T = 0; T < r.links.length; T++) {
      var k = r.links[T];
      if (cheb(k.pos, _.pos) > 2) continue;
      if (r.controller && cheb(k.pos, r.controller.pos) <= 2) continue;
      for (var C = 0; C < r.sources.length; C++) {
        if (cheb(r.sources[C].pos, k.pos) <= 2) continue e;
      }
      var b = k.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
      var I = getStorageLinkTarget(r, k);
      var O = I - b;
      if (O < 0 && _.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        var S = Math.min(-O, _.store.getFreeCapacity(RESOURCE_ENERGY));
        if (S > 0) {
          a.push({
            type: "link_drain",
            taskId: k.id,
            targetId: _.id,
            amount: S,
            priority: TASK_PRIORITY.link_drain
          });
        }
      }
      if (O > LINK_FILL_DEADBAND) {
        var U = Math.min(O, h, k.store.getFreeCapacity(RESOURCE_ENERGY));
        if (U > 0) {
          a.push({
            type: "link_fill",
            taskId: _.id,
            targetId: k.id,
            amount: U,
            priority: TASK_PRIORITY.link_fill
          });
        }
      }
    }
  }
  if (isPowerUpgradeActive(e.name)) {
    var N = (r.storage ? r.storage.store[RESOURCE_POWER] || 0 : 0) + (r.terminal ? r.terminal.store[RESOURCE_POWER] || 0 : 0);
    for (var A = 0; A < r.powerSpawns.length; A++) {
      var L = r.powerSpawns[A];
      var G = L.store.getUsedCapacity(RESOURCE_POWER) || 0;
      if (G <= POWER_SPAWN_POWER_TRIGGER && N > 0) {
        var x = Math.min(POWER_SPAWN_POWER_LOAD, N, L.store.getFreeCapacity(RESOURCE_POWER));
        if (x > 0) {
          a.push({
            type: "power_spawn_power",
            taskId: L.id,
            targetId: L.id,
            amount: x,
            priority: TASK_PRIORITY.power_spawn_power
          });
        }
      }
      if ((L.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < POWER_SPAWN_ENERGY_TRIGGER && L.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        a.push({
          type: "power_spawn_energy",
          taskId: L.id,
          targetId: L.id,
          amount: L.store.getFreeCapacity(RESOURCE_ENERGY),
          priority: TASK_PRIORITY.power_spawn_energy
        });
      }
    }
  }
  var M = e.memory.containerLabels || {};
  var P = [], F = [];
  for (var w = 0; w < r.containers.length; w++) {
    var Y = r.containers[w], W = M[Y.id];
    if (W === "donor") P.push(Y); else if (W === "materials") F.push(Y);
  }
  for (var D = 0; D < P.length; D++) {
    var B = P[D];
    var K = B.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (K < DONOR_DRAIN_THRESHOLD) continue;
    if (isLinkServed(e, B.id)) continue;
    var H = null;
    if (r.storage && r.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      H = r.storage;
    } else {
      for (var j = 0; j < r.containers.length; j++) {
        var V = r.containers[j];
        if (V.id === B.id) continue;
        var X = M[V.id];
        if (X === "donor" || X === "materials") continue;
        if (V.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          H = V;
          break;
        }
      }
    }
    if (!H) continue;
    a.push({
      type: "container_drain",
      taskId: B.id,
      targetId: H.id,
      amount: Math.min(K, H.store.getFreeCapacity(RESOURCE_ENERGY)),
      priority: TASK_PRIORITY.container_drain,
      extra: "mde=" + DONOR_DRAIN_THRESHOLD
    });
  }
  if (r.storage && r.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    for (var q = 0; q < r.containers.length; q++) {
      var z = r.containers[q], J = M[z.id];
      if (J === "materials") continue;
      if (J === "donor") {
        if ((z.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= DONOR_DRAIN_THRESHOLD) continue;
        if (isLinkServed(e, z.id)) continue;
      }
      if (isLinkServed(e, z.id)) continue;
      var Q = z.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
      if (Q < 50) continue;
      a.push({
        type: "container_empty",
        taskId: z.id,
        targetId: r.storage.id,
        amount: Q,
        priority: TASK_PRIORITY.container_empty
      });
    }
  }
  for (var $ = 0; $ < F.length; $++) {
    var Z = F[$];
    var ee = Z.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (ee <= 0) continue;
    var re = null;
    if (r.storage && r.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) re = r.storage; else {
      for (var te = 0; te < r.towers.length; te++) {
        if (r.towers[te].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          re = r.towers[te];
          break;
        }
      }
    }
    if (!re) break;
    a.push({
      type: "materials_drain_energy",
      taskId: Z.id,
      targetId: re.id,
      amount: ee,
      priority: TASK_PRIORITY.materials_drain_energy
    });
  }
  if (r.storage && r.terminal) {
    var ae = r.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var oe = terminalManager && typeof terminalManager.isRoomBusyWithTransfer === "function" && terminalManager.isRoomBusyWithTransfer(r.roomName);
    if (ae > TERMINAL_MAX && !oe && r.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      a.push({
        type: "terminal_balance",
        taskId: r.terminal.id,
        targetId: r.storage.id,
        amount: Math.min(ae - TERMINAL_TARGET, r.storage.store.getFreeCapacity(RESOURCE_ENERGY)),
        priority: TASK_PRIORITY.terminal_balance
      });
    }
    if (ae < TERMINAL_MIN && r.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      var ie = Math.min(TERMINAL_TARGET - ae, r.storage.store.getUsedCapacity(RESOURCE_ENERGY), r.terminal.store.getFreeCapacity(RESOURCE_ENERGY));
      if (ie > 0) {
        a.push({
          type: "terminal_balance",
          taskId: r.storage.id,
          targetId: r.terminal.id,
          amount: ie,
          priority: TASK_PRIORITY.terminal_balance
        });
      }
    }
  }
  if (r.storage && r.terminal && terminalManager && typeof terminalManager.getSupplierTasks === "function") {
    var ne = terminalManager.getSupplierTasks(r.roomName);
    for (var se = 0; se < ne.length; se++) {
      var ue = ne[se];
      if (!ue || ue.amount <= 0) continue;
      var le = findTerminalOpById(ue.opId);
      if (!le || le.status === "completed" || le.status === "failed") continue;
      var ce = Math.max(0, le.amount - (le.amountMoved || 0));
      if (ce <= 0) continue;
      var me = ue.type === "toTerminal" ? r.storage : r.terminal;
      var pe = ue.type === "toTerminal" ? r.terminal : r.storage;
      if (!me || !pe || !me.store || !pe.store) continue;
      var fe = me.store.getUsedCapacity(ue.resourceType) || 0;
      var ge = pe.store.getFreeCapacity(ue.resourceType) || 0;
      if (fe <= 0 || ge <= 0) continue;
      var de = Math.min(ce, fe, ge);
      if (de <= 0) continue;
      a.push({
        type: "terminal_stock",
        taskId: me.id,
        targetId: pe.id,
        amount: de,
        priority: TASK_PRIORITY.terminal_stock,
        extra: "res=" + ue.resourceType + ",op=" + ue.opId + ",program=" + (ue.reservationProgram || "") + ",type=" + ue.type
      });
    }
  }
  if (labManager && typeof labManager.getSupplierLabTasks === "function") {
    var ye = labManager.getSupplierLabTasks(r.roomName) || [];
    for (var ve = 0; ve < ye.length; ve++) a.push(ye[ve]);
  }
  if (r.storage && r.terminal) {
    var Re = marketLab && typeof marketLab.getRoomOperations === "function" ? marketLab.getRoomOperations(r.roomName) : [];
    for (var Ee = 0; Ee < Re.length; Ee++) {
      var _e = Re[Ee];
      if (!_e || _e.state !== "STAGING" || !_e.expectedOutputs) continue;
      for (var he in _e.expectedOutputs) {
        if (!_e.expectedOutputs.hasOwnProperty(he)) continue;
        var Te = _e.expectedOutputs[he] || 0;
        if (Te <= 0) continue;
        var ke = _e.stageReservationProgram || null;
        var Ce = r.terminal.store[he] || 0;
        var be = r.storage.store[he] || 0;
        var Ie = ke ? getProgramReserved(r.roomName, he, ke, "storage") : 0;
        var Oe = Math.max(0, Te - Ce);
        var d = r.terminal.store.getFreeCapacity(he) || 0;
        var Se = Math.min(Oe, be, d);
        if (Se <= 0) continue;
        a.push({
          type: "market_lab_stage",
          taskId: "market_lab_stage:" + _e.id + ":" + he,
          targetId: r.terminal.id,
          amount: Se,
          priority: TASK_PRIORITY.market_lab_stage,
          extra: "res=" + he + ",op=" + _e.id + (ke ? ",program=" + ke : "") + ",reserved=" + Ie
        });
      }
    }
  }
  if (r.factory) {
    var Ue = r.factory;
    var Ne = getActiveFactoryOrder(r.roomName);
    var Ae = chooseFactorySink(e);
    if (Ne) {
      var Le = factoryManager.getRecipe(Ne.product);
      var Ge = Ne.phase || "loading";
      if (Ge === "loading" && Le && Le.inputs) {
        var xe = factoryCycleRemainingBatches(Ne);
        for (var Me in Ue.store) {
          if ((Ue.store[Me] || 0) <= 0) continue;
          if (!Ae) break;
          var Pe = 0;
          var Fe = 0;
          if (Le.inputs[Me] !== undefined && Le.inputs[Me] > 0) {
            var we = (Le.inputs[Me] || 0) * xe;
            Fe = we;
            Pe = Math.max(0, (Ue.store[Me] || 0) - we);
            if (Pe <= 0) continue;
          } else {
            Pe = Ue.store[Me] || 0;
          }
          a.push({
            type: "factory_drain",
            taskId: Ne.id + ":loaddrain:" + Me,
            targetId: Ae.id,
            amount: Pe,
            priority: TASK_PRIORITY.factory_input - 1,
            extra: "res=" + Me + ",keep=" + Fe
          });
        }
        var Ye = factoryInputLoadBudget(Ue, Ne, Le);
        for (var We in Le.inputs) {
          var De = Le.inputs[We] || 0;
          if (De <= 0 || xe <= 0 || Ye <= 0) continue;
          var Be = De * xe;
          var Ke = Ue.store[We] || 0;
          var He = Math.max(0, Be - Ke);
          if (He <= 0) continue;
          var je = chooseFactorySource(e, We, Ne.reservationProgram);
          var Ve = je ? je.store[We] || 0 : 0;
          if (Ve <= 0) continue;
          var Xe = Math.min(He, Ve, Ye);
          if (Xe <= 0) continue;
          a.push({
            type: "factory_input",
            taskId: Ne.id + ":" + We,
            targetId: Ue.id,
            amount: Xe,
            priority: TASK_PRIORITY.factory_input,
            extra: "res=" + We + (Ne.reservationProgram ? ",program=" + Ne.reservationProgram : "")
          });
          Ye -= Xe;
        }
      } else if (Ge === "unloading") {
        if ((Ue.store[Ne.product] || 0) > 0 && Ae) {
          a.push({
            type: "factory_output",
            taskId: Ne.id + ":product",
            targetId: Ae.id,
            amount: Ue.store[Ne.product] || 0,
            priority: TASK_PRIORITY.factory_output,
            extra: "res=" + Ne.product
          });
        }
        for (var qe in Ue.store) {
          if ((Ue.store[qe] || 0) <= 0) continue;
          if (qe === Ne.product) continue;
          if (!Ae) break;
          a.push({
            type: "factory_drain",
            taskId: Ne.id + ":drain:" + qe,
            targetId: Ae.id,
            amount: Ue.store[qe] || 0,
            priority: TASK_PRIORITY.factory_drain,
            extra: "res=" + qe
          });
        }
      }
    } else if (Ae) {
      for (var ze in Ue.store) {
        if ((Ue.store[ze] || 0) <= 0) continue;
        a.push({
          type: "factory_drain",
          taskId: Ue.id + ":" + ze,
          targetId: Ae.id,
          amount: Ue.store[ze] || 0,
          priority: TASK_PRIORITY.factory_drain,
          extra: "res=" + ze
        });
      }
    }
  }
  if (r.storage) {
    var Je = getRoomState.get(e.name);
    var Qe = Je && Je.dropped || [];
    for (var $e = 0; $e < Qe.length; $e++) {
      var Ze = Qe[$e];
      if (!Ze) continue;
      try {
        if ((Ze.amount || 0) < 50) continue;
        if (cheb(Ze.pos, r.storage.pos) > 10) continue;
        if (!r.storage.store.getFreeCapacity || r.storage.store.getFreeCapacity(Ze.resourceType) <= 0) continue;
        a.push({
          type: "dropped_pickup",
          taskId: Ze.id,
          targetId: r.storage.id,
          amount: Ze.amount,
          priority: TASK_PRIORITY.dropped_pickup,
          extra: "res=" + Ze.resourceType
        });
      } catch (e) {
        continue;
      }
    }
    var er = Je && Je.tombstones || [];
    for (var rr = 0; rr < er.length; rr++) {
      var tr = er[rr];
      if (!tr || !tr.store) continue;
      if (cheb(tr.pos, r.storage.pos) > 10) continue;
      for (var ar in tr.store) {
        var or = tr.store[ar] || 0;
        if (or < 50) continue;
        try {
          if (!r.storage.store.getFreeCapacity || r.storage.store.getFreeCapacity(ar) <= 0) continue;
          a.push({
            type: "tombstone_pickup",
            taskId: tr.id + ":" + ar,
            targetId: r.storage.id,
            amount: or,
            priority: TASK_PRIORITY.tombstone_pickup,
            extra: "src=" + tr.id + ",res=" + ar
          });
        } catch (e) {
          continue;
        }
      }
    }
    var ir = typeof FIND_RUINS !== "undefined" && e.find ? e.find(FIND_RUINS) : Je && Je.ruins || [];
    for (var nr = 0; nr < ir.length; nr++) {
      var sr = ir[nr];
      if (!sr || !sr.store) continue;
      if (cheb(sr.pos, r.storage.pos) > 10) continue;
      for (var ur in sr.store) {
        var lr = sr.store[ur] || 0;
        if (lr < 50) continue;
        try {
          if (!r.storage.store.getFreeCapacity || r.storage.store.getFreeCapacity(ur) <= 0) continue;
          a.push({
            type: "ruin_pickup",
            taskId: sr.id + ":" + ur,
            targetId: r.storage.id,
            amount: lr,
            priority: TASK_PRIORITY.ruin_pickup,
            extra: "src=" + sr.id + ",res=" + ur
          });
        } catch (e) {
          continue;
        }
      }
    }
  }
  a.sort(function(r, t) {
    return effectivePriority(e, r) - effectivePriority(e, t);
  });
  if (!t) global._scanCache[e.name] = a;
  return a;
}

function isLabLoadRouteTask(e, r) {
  if (!e || !r) return false;
  for (var t = 0; t < e.length; t++) {
    var a = e[t];
    if (a && a.taskId === r.taskId && (a.targetId || "") === (r.targetId || "")) return true;
  }
  return false;
}

function shouldReprioritize(e, r, t, a) {
  if (!a || !a.type) return false;
  var o = scanRoomTasks(e.room, r, false);
  var i = effectivePriority(e.room, a);
  var n = a.type + "|" + a.taskId + "|" + (a.targetId || "");
  for (var s = 0; s < o.length; s++) {
    var u = o[s];
    if (u.type + "|" + u.taskId + "|" + (u.targetId || "") === n) {
      i = effectivePriority(e.room, u);
      break;
    }
  }
  var l = false;
  for (var c = 0; c < o.length; c++) {
    var m = o[c];
    var p = m.type + "|" + m.taskId + "|" + (m.targetId || "");
    if (p === n) {
      l = true;
      continue;
    }
    if (a.type === "lab_load" && m.type === "lab_load" && isLabLoadRouteTask(t.labLoadRoute, m)) continue;
    if (effectivePriority(e.room, m) >= i) continue;
    if (isClaimed(r, e, m.type, m.taskId, m.targetId)) continue;
    if (isAvoided(t, m.type, m.taskId, m.targetId)) continue;
    return true;
  }
  if (a.type === "lab_load" && isLabLoadRouteTask(t.labLoadRoute, a)) return false;
  return !l && !isClaimed(r, e, a.type, a.taskId, a.targetId);
}

//  TASK PICKER — pick highest-priority unclaimed task for this creep
function pickTask(e, r, t) {
  var a = r.controller && r.controller.level >= 8;
  var o = e.memory._windDownPick === Game.time && r.controller && r.controller.level <= 7;
  var i = o && !a;
  var n = scanRoomTasks(e.room, r, i);
  if (o) {
    n = n.filter(function(e) {
      return e.type === "spawn" || e.type === "extension" || e.type === "tower";
    });
    delete e.memory._windDownPick;
  }
  var s = e.store.getUsedCapacity(RESOURCE_ENERGY);
  for (var u = 0; u < n.length; u++) {
    var l = n[u];
    if (isClaimed(r, e, l.type, l.taskId, l.targetId)) continue;
    if (isAvoided(t, l.type, l.taskId, l.targetId)) continue;
    var c = {
      type: l.type,
      taskId: l.taskId,
      targetId: l.targetId,
      amount: l.amount,
      assignedTick: Game.time,
      extra: l.extra || ""
    };
    if (l.type === "power_spawn_energy") {
      c.amount = Math.min(c.amount, getEnergyCapacity(e));
    }
    if (l.type === "lab_load") {
      t.labLoadRoute = buildLabLoadRoute(e, r, c);
    } else {
      t.labLoadRoute = null;
    }
    setAssignment(e, c);
    t.consecutiveIdlePicks = 0;
    if (isPowerUpgradeTask(l.type)) {
      var m = getPowerUpgradeResource(l);
      e.memory.s = (e.store[m] || 0) > 0 ? "delivering" : "fetching";
    } else if (l.type === "extension") {
      t.extRoute = buildExtensionRoute(e, r);
      t.extRouteTick = Game.time;
      e.memory.s = s > 0 ? "delivering" : "fetching";
    } else if (l.type === "factory_input" || l.type === "factory_output" || l.type === "factory_drain") {
      var p = parseExtra(l.extra || "", "res");
      e.memory.s = p && (e.store[p] || 0) > 0 ? "delivering" : "fetching";
    } else if (l.type === "market_lab_stage" || l.type === "terminal_stock") {
      e.memory.s = e.store.getUsedCapacity() > 0 ? "delivering" : "fetching";
    } else if (l.type === "lab_unload") {
      e.memory.s = e.store.getUsedCapacity() > 0 ? "delivering" : "fetching";
    } else if (l.type === "lab_load") {
      var f = t.labLoadRoute;
      var g = getLabTaskResource(c);
      var d = shouldTopOffLabLoad(e, c, f);
      e.memory.s = d ? "fetching" : g && (e.store[g] || 0) > 0 ? "delivering" : "fetching";
    } else if (l.type === "dropped_pickup" || l.type === "tombstone_pickup" || l.type === "ruin_pickup") {
      var y = getPickupResource(l);
      e.memory.s = y && (e.store[y] || 0) > 0 ? "delivering" : "fetching";
    } else if (isWithdrawTask(l.type)) {
      if (shouldDeliverImmediately(l.type, s)) {
        e.memory.s = "delivering";
      } else {
        e.memory.s = "fetching";
      }
    } else {
      e.memory.s = s > 0 ? "delivering" : "fetching";
    }
    sup_say(e, e.memory.s === "fetching" ? "🔄" : "🚚");
    return true;
  }
  if (s > 0) {
    if (tryFallbackDump(e, r)) return false;
  }
  t.consecutiveIdlePicks = (t.consecutiveIdlePicks || 0) + 1;
  e.memory.s = "idle";
  delete e.memory._move;
  if (!hasActiveAvoids(t) && t.consecutiveIdlePicks >= 3) {
    e.memory.sl = Game.time + IDLE_SLEEP_TICKS;
  } else {
    e.memory.sl = Game.time + IDLE_SHORT_SLEEP;
  }
  sup_say(e, "💤");
  return false;
}

var WITHDRAW_TASKS = {
  container_empty: true,
  container_drain: true,
  materials_drain_energy: true,
  link_drain: true,
  link_fill: true,
  terminal_balance: true,
  dropped_pickup: true,
  tombstone_pickup: true,
  ruin_pickup: true
};
function isWithdrawTask(e) {
  return WITHDRAW_TASKS[e] === true;
}

function getPickupSourceId(e) {
  if (!e) return null;
  if (e.type === "tombstone_pickup" || e.type === "ruin_pickup") return parseExtra(e.extra, "src") || e.taskId.split(":")[0];
  return e.taskId;
}

function getPickupResource(e) {
  if (!e || e.type !== "dropped_pickup" && e.type !== "tombstone_pickup" && e.type !== "ruin_pickup") return null;
  return parseExtra(e.extra, "res") || (e.type === "dropped_pickup" ? RESOURCE_ENERGY : null);
}

function getAssignmentResource(e) {
  return getPickupResource(e) || RESOURCE_ENERGY;
}

function shouldDeliverImmediately(e, r) {
  if (e === "link_fill" && r > 0) return true;
  if (e === "terminal_balance" && r > 0) return true;
  return false;
}

//  EXTENSION ROUTE (optimal capacity split, seeded from depot, no dribble-filling)
function nnOrder(e, r) {
  var t = e.slice(), a = [], o = r;
  while (t.length > 0) {
    var i = 0, n = cheb(o, t[0].pos);
    for (var s = 1; s < t.length; s++) {
      var u = cheb(o, t[s].pos);
      if (u < n) {
        n = u;
        i = s;
      }
    }
    var l = t.splice(i, 1)[0];
    a.push(l);
    o = l.pos;
  }
  return a;
}

function nodeById(e, r) {
  for (var t = 0; t < e.length; t++) if (e[t].id === r) return e[t];
  return null;
}

function buildExtensionRoute(e, r) {
  var t = r._emptyExts;
  if (!t) {
    t = [];
    var a = r.controller && r.controller.level >= 8;
    for (var o = 0; o < r.extensions.length; o++) {
      var i = r.extensions[o];
      var n = i.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      if (n <= 0) continue;
      if (a && (i.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
      t.push(i);
    }
    r._emptyExts = t;
    if (t.length > 0 && !r._extWpMap) {
      r._extWpMap = getExtWpMap(e.room, t);
    }
  }
  if (t.length === 0) return [];
  var s = r._extWpMap;
  function posOf(e) {
    return s && s[e.id] ? s[e.id] : e.pos;
  }
  var u = [];
  for (var l = 0; l < t.length; l++) {
    var c = t[l];
    u.push({
      id: c.id,
      pos: posOf(c),
      cap: c.store.getFreeCapacity(RESOURCE_ENERGY) || c.store.getCapacity(RESOURCE_ENERGY) || 200
    });
  }
  var m = getEnergyCapacity(e);
  if (m <= 0) return u.map(function(e) {
    return e.id;
  });
  if (!r.storage) return nnOrder(u, e.pos).map(function(e) {
    return e.id;
  });
  var p = r.storage.pos;
  //    field position. Runs start at storage, so this keeps segments
  //    spatially coherent and radiating outward from the depot.
    var f = nnOrder(u, p);
  var g = f.length;
  //    order, choose trip boundaries that minimize total depot round-trips.
  //    Each trip starts full at storage and carries <= fullCap.
    var d = new Array(g + 1), y = new Array(g + 1);
  d[0] = 0;
  for (var v = 1; v <= g; v++) {
    d[v] = Infinity;
    y[v] = -1;
  }
  for (var R = 0; R < g; R++) {
    var E = 0, _ = 0;
    for (var h = R; h < g; h++) {
      E += f[h].cap;
      if (E > m && h > R) break;
      if (h === R) {
        _ = cheb(p, f[h].pos) * 2;
      } else {
        _ += cheb(f[h - 1].pos, f[h].pos) + cheb(f[h].pos, p) - cheb(f[h - 1].pos, p);
      }
      if (d[R] + _ < d[h + 1]) {
        d[h + 1] = d[R] + _;
        y[h + 1] = R;
      }
    }
  }
  var T = [], k = g;
  while (k > 0) {
    T.push(y[k]);
    k = y[k];
  }
  T.reverse();
  var C = [];
  for (var b = 0; b < T.length; b++) {
    C.push("REFUEL");
    var I = T[b];
    var O = b + 1 < T.length ? T[b + 1] : g;
    for (var S = I; S < O; S++) C.push(f[S].id);
  }
  //    first trip — otherwise refuel first (avoids dribble-filling).
    if (C[0] === "REFUEL") {
    var U = 0;
    for (var N = 1; N < C.length && C[N] !== "REFUEL"; N++) {
      var A = nodeById(u, C[N]);
      if (A) U += A.cap;
    }
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) >= U) C.shift();
  }
  return C;
}

function buildLabLoadRoute(e, r, t) {
  var a = getLabTaskResource(t);
  if (!a) return [];
  var o = parseExtra(t.extra, "program") || "";
  var i = [ {
    taskId: t.taskId,
    targetId: t.targetId,
    amount: t.amount || 0,
    extra: t.extra || ""
  } ];
  var n = {};
  n[t.taskId + "|" + (t.targetId || "")] = true;
  var s = scanRoomTasks(e.room, r);
  var u = [];
  for (var l = 0; l < s.length; l++) {
    var c = s[l];
    if (!c || c.type !== "lab_load" || (c.amount || 0) <= 0) continue;
    var m = c.taskId + "|" + (c.targetId || "");
    if (n[m]) continue;
    if (isClaimed(r, e, c.type, c.taskId, c.targetId)) continue;
    if (isAvoided(getHeap(e.name), c.type, c.taskId, c.targetId)) continue;
    if (getLabTaskResource(c) !== a) continue;
    if ((parseExtra(c.extra, "program") || "") !== o) continue;
    var p = Game.getObjectById(c.targetId || getLabTaskLabId(c));
    if (!p || !p.store) continue;
    if (p.mineralType && p.mineralType !== a) continue;
    if ((p.store.getFreeCapacity(a) || 0) <= 0) continue;
    u.push({
      task: c,
      pos: p.pos
    });
  }
  var f = Game.getObjectById(t.targetId || getLabTaskLabId(t));
  var g = nnOrder(u, f ? f.pos : e.pos);
  for (var d = 0; d < g.length; d++) {
    var y = g[d].task;
    i.push({
      taskId: y.taskId,
      targetId: y.targetId,
      amount: y.amount || 0,
      extra: y.extra || ""
    });
  }
  return i;
}

function ensureLabLoadRoute(e, r, t) {
  var a = getHeap(e.name);
  var o = a.labLoadRoute;
  if (!o || o.length === 0 || o[0].taskId !== t.taskId || o[0].targetId !== t.targetId) {
    o = buildLabLoadRoute(e, r, t);
    a.labLoadRoute = o;
    if (global._taskClaimCache) delete global._taskClaimCache[e.room.name];
  }
  return o;
}

function getLabLoadRouteNeed(e) {
  var r = 0;
  for (var t = 0; e && t < e.length; t++) {
    r += Math.max(0, e[t].amount || 0);
  }
  return r;
}

function shouldTopOffLabLoad(e, r, t, a, o) {
  if (!e || !r || !t || t.length === 0) return false;
  var i = getLabTaskResource(r);
  var n = i ? typeof a === "number" ? a : e.store[i] || 0 : 0;
  var s = typeof o === "number" ? o : e.store.getFreeCapacity();
  if (!i || n <= 0 || s <= 0) return false;
  var u = getLabLoadRouteNeed(t);
  if (u <= n) return false;
  var l = parseExtra(r.extra, "program") || "";
  var c = chooseLabLoadSource(e.room, i, l);
  return !!(c && getLabLoadSourceAvailable(e.room.name, i, l, c) > 0);
}

function advanceLabLoadRoute(e, r) {
  if (r.labLoadRoute && r.labLoadRoute.length > 0) r.labLoadRoute.shift();
  if (!r.labLoadRoute || r.labLoadRoute.length === 0) {
    clearAssignment(e, "lab load route complete", true);
    return null;
  }
  var t = r.labLoadRoute[0];
  var a = {
    type: "lab_load",
    taskId: t.taskId,
    targetId: t.targetId,
    amount: t.amount,
    assignedTick: Game.time,
    extra: t.extra || ""
  };
  setAssignment(e, a);
  return a;
}

//  VALIDATION — is the current assignment still worth doing?
function isAssignmentDone(e, r, t, a) {
  if (!t || !t.type) return true;
  var o = Game.getObjectById(getPickupSourceId(t));
  var i = t.targetId ? Game.getObjectById(t.targetId) : o;
  var n = getFactoryTaskResource(t);
  if (isPowerUpgradeTask(t.type)) {
    if (!isPowerUpgradeActive(r.roomName)) return true;
    var s = getPowerUpgradeResource(t);
    if (!i || !i.store || !s || (t.amount || 0) <= 0) return true;
    if (i.store.getFreeCapacity(s) <= 0) return true;
    if ((e.store[s] || 0) > 0) return false;
    if (s === RESOURCE_POWER) {
      var u = (r.storage ? r.storage.store[RESOURCE_POWER] || 0 : 0) + (r.terminal ? r.terminal.store[RESOURCE_POWER] || 0 : 0);
      return u <= 0;
    }
    return false;
  }
  if (t.type === "factory_input") {
    var l = i;
    if (!l || !l.store || !n) return true;
    var c = getActiveFactoryOrder(r.roomName);
    if (!c) return true;
    if ((c.phase || "loading") !== "loading") return true;
    var m = factoryManager.getRecipe(c.product);
    if (!m || !m.inputs || m.inputs[n] === undefined) return true;
    var p = (m.inputs[n] || 0) * factoryCycleRemainingBatches(c);
    return (l.store[n] || 0) >= p;
  }
  if (t.type === "factory_output") {
    var f = r.factory;
    if (!f || !f.store || !n) return true;
    var g = getActiveFactoryOrder(r.roomName);
    if (!g || (g.phase || "loading") !== "unloading") return true;
    return (f.store[n] || 0) <= 0;
  }
  if (t.type === "factory_drain") {
    var d = r.factory;
    if (!d || !d.store) return true;
    var y = getActiveFactoryOrder(r.roomName);
    if (y && [ "processing", "ready", "loadingPending", "unloadingPending" ].indexOf(y.phase || "loading") >= 0) return true;
    var v = n;
    if (!v) {
      for (var R in d.store) {
        if ((d.store[R] || 0) > 0) {
          v = R;
          break;
        }
      }
    }
    if (!v) return true;
    if ((e.store[v] || 0) > 0) return false;
    var E = parseExtra(t.extra, "keep");
    if (E !== null) return (d.store[v] || 0) <= (+E || 0);
    return (d.store[v] || 0) <= 0;
  }
  if (t.type === "market_lab_stage") {
    var _ = getMarketLabStageResource(t);
    var h = parseExtra(t.extra, "program");
    if (!r.storage || !_ || !h) return true;
    var T = getProgramReserved(r.roomName, _, h, "storage");
    return T <= 0 && (e.store[_] || 0) <= 0;
  }
  if (t.type === "lab_unload") {
    var k = getLabTaskResource(t);
    var C = Game.getObjectById(getLabTaskLabId(t));
    return (!C || !labHasMineral(C)) && (!k || (e.store[k] || 0) <= 0);
  }
  if (t.type === "lab_load") {
    var b = getLabTaskResource(t);
    if (!b) return true;
    var I = getLabOrder(r.roomName);
    var O = I && (I.origin === "marketLab" || I.marketOpId);
    var S = parseExtra(t.extra, "pipeline");
    var U = I && I.type === "pipeline" && S && String(S) === String(I.pipelineId);
    if (I && I.type === "pipeline") {
      if (!U || I.evacuating || I.needsPreEvacuation) return true;
    } else if (!O || I.evacuating || I.needsPreEvacuation) return true;
    if (a.labLoadRoute && a.labLoadRoute.length > 0) return false;
    var N = Game.getObjectById(getLabTaskLabId(t));
    if (!N) return true;
    if (N.mineralType && N.mineralType !== b) return true;
    if ((t.amount || 0) <= 0) return true;
    var A = +parseExtra(t.extra, "target") || 0;
    if (A > 0 && (N.mineralAmount || 0) >= A) return true;
    if ((e.store[b] || 0) > 0) return false;
    return (N.store.getFreeCapacity(b) || 0) <= 0;
  }
  if (t.type === "extension") {
    var L = a.extRoute;
    if (L && L.length > 0) return false;
    var G = r.controller && r.controller.level >= 8;
    for (var x = 0; x < r.extensions.length; x++) {
      var M = r.extensions[x];
      if ((M.store.getFreeCapacity(RESOURCE_ENERGY) || 0) <= 0) continue;
      if (G && (M.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) continue;
      return false;
    }
    return true;
  }
  if (t.type === "fallback_dump") {
    return e.store.getUsedCapacity(RESOURCE_ENERGY) <= 0 || !i || !i.store || i.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
  }
  if (t.type === "dropped_pickup" || t.type === "tombstone_pickup" || t.type === "ruin_pickup") {
    var P = getPickupResource(t);
    if (!P) return true;
    if (!i || !i.store || i.store.getFreeCapacity(P) <= 0) return true;
    var F = t.type === "dropped_pickup" ? o && o.amount || 0 : o && o.store && o.store[P] || 0;
    return F <= 0 && (e.store[P] || 0) <= 0;
  }
  if (!o) return true;
  if (t.type === "spawn") {
    return !i || !i.store || i.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
  }
  if (t.type === "tower") {
    return !i || !i.store || (i.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= i.store.getCapacity(RESOURCE_ENERGY) * .9;
  }
  if (t.type === "link_fill") {
    if (!i || !i.store) return true;
    return getStorageLinkTarget(r, i) - (i.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= LINK_FILL_DEADBAND;
  }
  if (t.type === "link_drain") {
    if ((e.store[RESOURCE_ENERGY] || 0) > 0) return false;
    return !o.store || (o.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= getStorageLinkTarget(r, o);
  }
  if (t.type === "container_drain" || t.type === "container_empty" || t.type === "materials_drain_energy") {
    var w = o.store ? o.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
    if (t.type === "container_drain" && t.extra) {
      var Y = parseExtra(t.extra, "mde");
      if (Y && w < +Y) return true;
    }
    return w <= 0 || !i || !i.store || i.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
  }
  if (t.type === "terminal_balance") {
    if (!r.storage || !r.terminal) return true;
    var W = r.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (t.taskId === r.terminal.id) return W < TERMINAL_MAX;
    if (t.taskId === r.storage.id) return W > TERMINAL_MIN;
    return true;
  }
  if (t.type === "terminal_stock") {
    var D = parseExtra(t.extra, "op");
    if (!D) return true;
    var B = findTerminalOpById(D);
    if (!B || B.status === "completed" || B.status === "failed") return true;
    var K = B.amountMoved || 0;
    return K >= B.amount;
  }
  return false;
}

function simulateFillDone(e, r, t, a) {
  if (!t || !t.store) return true;
  var o = (t.store.getUsedCapacity(RESOURCE_ENERGY) || 0) + a;
  var i = t.store.getCapacity(RESOURCE_ENERGY) || 0;
  if (isPowerUpgradeTask(e.type)) {
    if (!isPowerUpgradeActive(r.roomName)) return true;
    var n = getPowerUpgradeResource(e);
    if (!n || (e.amount || 0) <= 0) return true;
    return t.store.getFreeCapacity(n) - a <= 0;
  }
  if (e.type === "market_lab_stage") {
    var s = getMarketLabStageResource(e);
    var u = r.terminal;
    if (!u || !u.store || !s) return true;
    var l = e.amount || 0;
    if (l <= 0) return true;
    var c = parseExtra(e.extra, "program");
    if (!c) return true;
    return getProgramReserved(r.roomName, s, c, "storage") <= 0;
  }
  if (e.type === "lab_load") {
    var m = getLabTaskResource(e);
    var p = t;
    if (!p || !p.store || !m) return true;
    var f = +parseExtra(e.extra, "target") || 0;
    if (f <= 0) {
      return (p.store.getFreeCapacity(m) || 0) - a <= 0 || (e.amount || 0) <= 0;
    }
    return Math.max(0, (p.store[m] || 0) + a) >= f;
  }
  if (e.type === "factory_input") {
    var g = getFactoryTaskResource(e);
    var d = t;
    var y = getActiveFactoryOrder(r.roomName);
    if (!d || !d.store || !g || !y) return true;
    if ((y.phase || "loading") !== "loading") return true;
    var v = factoryManager.getRecipe(y.product);
    if (!v || !v.inputs || v.inputs[g] === undefined) return true;
    var R = (v.inputs[g] || 0) * factoryCycleRemainingBatches(y);
    return Math.max(0, (d.store[g] || 0) + a) >= R;
  }
  if (e.type === "factory_output" || e.type === "factory_drain") {
    var E = getFactoryTaskResource(e);
    var _ = r.factory;
    if (!_ || !_.store || !E) return true;
    var h = getActiveFactoryOrder(r.roomName);
    if (e.type === "factory_output" && (!h || (h.phase || "loading") !== "unloading")) return true;
    if (e.type === "factory_drain" && h && [ "processing", "ready", "loadingPending", "unloadingPending" ].indexOf(h.phase || "loading") >= 0) return true;
    var T = parseExtra(e.extra, "keep");
    if (T !== null) return Math.max(0, (_.store[E] || 0) - a) <= (+T || 0);
    return Math.max(0, (_.store[E] || 0) - a) <= 0;
  }
  if (e.type === "spawn") {
    return o >= i;
  }
  if (e.type === "tower") {
    return o >= i * .9;
  }
  if (e.type === "link_fill") {
    return getStorageLinkTarget(r, t) - o <= LINK_FILL_DEADBAND;
  }
  if (e.type === "terminal_balance") {
    if (r.terminal && e.targetId === r.terminal.id) return o > TERMINAL_MIN;
    if (r.terminal) return (r.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < TERMINAL_MAX;
    return true;
  }
  if (e.type === "terminal_stock") {
    var k = parseExtra(e.extra, "op");
    if (!k) return true;
    var C = findTerminalOpById(k);
    if (!C || C.status === "completed" || C.status === "failed") return true;
    var b = (C.amountMoved || 0) + a;
    return b >= C.amount;
  }
  if (e.type === "container_drain" || e.type === "container_empty" || e.type === "link_drain" || e.type === "materials_drain_energy") {
    var I = Game.getObjectById(e.taskId);
    var O = I && I.store ? I.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
    if (e.type === "link_drain" && O <= getStorageLinkTarget(r, I)) return true;
    if (e.type === "container_drain") {
      var S = parseExtra(e.extra, "mde");
      if (S && O < +S) return true;
    }
    return O <= 0 || (t.store.getFreeCapacity(RESOURCE_ENERGY) || 0) - a <= 0;
  }
  if (e.type === "dropped_pickup" || e.type === "tombstone_pickup" || e.type === "ruin_pickup") {
    var U = Game.getObjectById(getPickupSourceId(e));
    var N = getPickupResource(e);
    if (!N || !U) return true;
    var A = e.type === "dropped_pickup" ? U.amount || 0 : U.store && U.store[N] || 0;
    return A <= 0 || (t.store.getFreeCapacity(N) || 0) - a <= 0;
  }
  return null;
}

function parseExtra(e, r) {
  if (!e) return null;
  var t = e.split(",");
  for (var a = 0; a < t.length; a++) {
    var o = t[a].split("=");
    if (o[0] === r) return o[1];
  }
  return null;
}

function findNextLabUnloadTask(e, r, t, a) {
  if (!e || !r || !t || !a) return null;
  if (!r.terminal || !r.terminal.store) return null;
  if ((r.terminal.store.getFreeCapacity(a) || 0) <= 0) return null;
  var o = scanRoomTasks(e.room, r);
  for (var i = 0; i < o.length; i++) {
    var n = o[i];
    if (!n || n.type !== "lab_unload") continue;
    if (n.taskId === t.taskId) continue;
    if (isClaimed(r, e, n.type, n.taskId, n.targetId)) continue;
    if (isAvoided(getHeap(e.name), n.type, n.taskId, n.targetId)) continue;
    if (getLabTaskResource(n) !== a) continue;
    var s = getLabTaskLabId(n);
    var u = s ? Game.getObjectById(s) : null;
    if (!u || !u.mineralType || u.mineralType !== a) continue;
    if ((u.mineralAmount || 0) <= 0) continue;
    return n;
  }
  return null;
}

function dumpAll(e, r) {
  if (!r) r = e.room;
  var t = Object.keys(e.store);
  for (var a = 0; a < t.length; a++) {
    var o = t[a];
    if ((e.store[o] || 0) <= 0) continue;
    return dumpResource(e, r, o);
  }
  return false;
}

function dumpResource(e, r, t) {
  if (!r) r = e.room;
  if (!t || (e.store[t] || 0) <= 0) return false;
  var a = null;
  if (r.storage && r.storage.store.getFreeCapacity(t) > 0) a = r.storage; else if (r.terminal && r.terminal.store.getFreeCapacity(t) > 0) a = r.terminal;
  if (!a) return false;
  if (cheb(e.pos, a.pos) > 1) {
    smartMove(e, a);
    return true;
  }
  return e.transfer(a, t) === OK;
}

function dumpEnergy(e, r) {
  return dumpResource(e, r, RESOURCE_ENERGY);
}

function dumpNonEnergy(e, r, t) {
  if (!r) r = e.room;
  var a = Object.keys(e.store);
  for (var o = 0; o < a.length; o++) {
    var i = a[o];
    if (i === RESOURCE_ENERGY || i === t || (e.store[i] || 0) <= 0) continue;
    if (dumpResource(e, r, i)) return true;
  }
  return false;
}

function dumpIncompatibleCargo(e, r, t) {
  if (!r) r = e.room;
  var a = Object.keys(e.store);
  for (var o = 0; o < a.length; o++) {
    var i = a[o];
    if (i === t || (e.store[i] || 0) <= 0) continue;
    if (dumpResource(e, r, i)) return true;
  }
  return false;
}

function onlyCarriesResource(e, r) {
  var t = Object.keys(e.store);
  for (var a = 0; a < t.length; a++) {
    var o = t[a];
    if ((e.store[o] || 0) <= 0) continue;
    if (o !== r) return false;
  }
  return true;
}

function storeSignature(e) {
  var r = Object.keys(e.store).sort();
  var t = [];
  for (var a = 0; a < r.length; a++) {
    var o = e.store[r[a]] || 0;
    if (o > 0) t.push(r[a] + ":" + o);
  }
  return t.join(",");
}

function deliveryNoProgressWatchdog(e, r, t) {
  if (!r || e.memory.s !== "delivering") {
    t.deliveryWatchKey = null;
    t.deliveryWatchCount = 0;
    return false;
  }
  var a = Game.getObjectById(r.targetId || r.taskId);
  if (!a || !a.pos || cheb(e.pos, a.pos) > 1) {
    t.deliveryWatchKey = null;
    t.deliveryWatchCount = 0;
    return false;
  }
  if (e.store.getUsedCapacity() === 0) {
    t.deliveryWatchKey = null;
    t.deliveryWatchCount = 0;
    return false;
  }
  var o = e.memory.a + "|" + e.memory.s + "|" + e.pos.roomName + ":" + e.pos.x + ":" + e.pos.y + "|" + storeSignature(e);
  if (t.deliveryWatchKey === o) {
    t.deliveryWatchCount = (t.deliveryWatchCount || 0) + 1;
  } else {
    t.deliveryWatchKey = o;
    t.deliveryWatchCount = 0;
  }
  if (t.deliveryWatchCount >= 3) {
    clearAssignment(e, "delivery no progress", false);
    t.deliveryWatchKey = null;
    t.deliveryWatchCount = 0;
    return true;
  }
  return false;
}

function cleanupCargoForTask(e, r) {
  var t = (e.store[RESOURCE_ENERGY] || 0) > 0;
  var a = hasNonEnergyCarry(e);
  if (r && isPowerUpgradeTask(r.type)) {
    var o = getPowerUpgradeResource(r);
    if (onlyCarriesResource(e, o)) return false;
    if (o !== RESOURCE_ENERGY && t) {
      if (dumpEnergy(e, e.room)) return true;
      clearAssignment(e, "power upgrade cargo blocked", true);
      return true;
    }
    if (a) {
      if (dumpNonEnergy(e, e.room, o)) return true;
      clearAssignment(e, "power upgrade cargo blocked", true);
      return true;
    }
    return false;
  }
  if (r && r.type === "factory_input") {
    var i = getFactoryTaskResource(r);
    if (t) {
      if (i !== RESOURCE_ENERGY) {
        if (dumpEnergy(e, e.room)) return true;
        clearAssignment(e, "factory cargo blocked", true);
        return true;
      }
    }
    if (a) {
      if (i && onlyCarriesResource(e, i)) return false;
      if (dumpNonEnergy(e, e.room, i)) return true;
      clearAssignment(e, "factory cargo blocked", true);
      return true;
    }
    return false;
  }
  if (r && (r.type === "factory_output" || r.type === "factory_drain")) {
    var n = getFactoryTaskResource(r);
    if (e.store.getUsedCapacity() <= 0) return false;
    if (n && onlyCarriesResource(e, n) && hasFactoryFetched(e, r, n)) return false;
    if (n && (e.store[n] || 0) > 0) {
      if (dumpResource(e, e.room, n)) return true;
    }
    if (dumpAll(e, e.room)) return true;
    clearAssignment(e, "factory cargo blocked", true);
    return true;
  }
  if (r && r.type === "market_lab_stage") {
    var s = getMarketLabStageResource(r);
    if (t) {
      if (dumpEnergy(e, e.room)) return true;
      clearAssignment(e, "stage cargo blocked", true);
      return true;
    }
    if (a) {
      if (s && onlyCarriesResource(e, s)) return false;
      if (dumpNonEnergy(e, e.room, s)) return true;
      clearAssignment(e, "stage cargo blocked", true);
      return true;
    }
    return false;
  }
  if (r && (r.type === "lab_load" || r.type === "lab_unload")) {
    var u = getLabTaskResource(r);
    if (t && !(r.type === "lab_load" && u === RESOURCE_ENERGY)) {
      if (dumpEnergy(e, e.room)) return true;
      clearAssignment(e, "lab cargo blocked", true);
      return true;
    }
    if (a) {
      if (u && onlyCarriesResource(e, u)) return false;
      if (dumpNonEnergy(e, e.room, u)) return true;
      clearAssignment(e, "lab cargo blocked", true);
      return true;
    }
    return false;
  }
  if (r && r.type === "terminal_stock") {
    var l = getTerminalStockResource(r);
    if (t && l !== RESOURCE_ENERGY) {
      if (dumpEnergy(e, e.room)) return true;
      clearAssignment(e, "terminal stock cargo blocked", true);
      return true;
    }
    if (a) {
      if (l && onlyCarriesResource(e, l)) return false;
      if (dumpNonEnergy(e, e.room, l)) return true;
      clearAssignment(e, "terminal stock cargo blocked", true);
      return true;
    }
    return false;
  }
  if (r && (r.type === "dropped_pickup" || r.type === "tombstone_pickup" || r.type === "ruin_pickup")) {
    var c = getPickupResource(r);
    if (!c) {
      clearAssignment(e, "pickup resource missing", true);
      return true;
    }
    if (!onlyCarriesResource(e, c)) {
      if (dumpIncompatibleCargo(e, e.room, c)) return true;
      clearAssignment(e, "pickup cargo blocked", true);
      return true;
    }
    return false;
  }
  if (a) {
    if (dumpNonEnergy(e, e.room)) return true;
    clearAssignment(e, "cargo blocked", true);
    return true;
  }
  return false;
}

function hasNonEnergyCarry(e) {
  var r = Object.keys(e.store);
  for (var t = 0; t < r.length; t++) {
    if (r[t] !== RESOURCE_ENERGY && e.store[r[t]] > 0) return true;
  }
  return false;
}

//  STATE MACHINE EXECUTORS
function executeFetch(e, r, t, a) {
  if (isPowerUpgradeTask(r.type)) {
    executePowerUpgradeFetch(e, r, t, a);
    return;
  }
  if (e.store.getFreeCapacity() === 0) {
    e.memory.s = "delivering";
    return;
  }
  if (r.type === "extension") {
    var o = t.storage;
    var i = o && (o.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0 ? o : findEnergySource(e, t, a);
    if (!i) {
      if (e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        e.memory.s = "delivering";
        return;
      }
      clearAssignment(e, "ext: no energy source", true);
      return;
    }
    if (e.pos.isNearTo(i)) {
      delete e.memory._move;
      e.withdraw(i, RESOURCE_ENERGY);
      e.memory.s = "delivering";
      refreshProgress(e, r);
      var n = a.extRoute;
      while (n && n.length > 0 && n[0] === "REFUEL") n.shift();
      if (n) {
        for (var s = 0; s < n.length; s++) {
          if (n[s] === "REFUEL") break;
          var u = Game.getObjectById(n[s]);
          if (u) {
            var l = t._extWpMap;
            var c = l && l[u.id] ? l[u.id] : u.pos;
            if (cheb(e.pos, c) > 1) smartMove(e, c);
            break;
          }
        }
      }
    } else {
      smartMove(e, i);
    }
    return;
  }
  if (r.type === "dropped_pickup" || r.type === "tombstone_pickup" || r.type === "ruin_pickup") {
    var m = getPickupResource(r);
    var p = Game.getObjectById(getPickupSourceId(r));
    var f = r.type === "dropped_pickup" ? p && p.amount || 0 : p && p.store && p.store[m] || 0;
    if (!p || !m || f <= 0) {
      if (m && (e.store[m] || 0) > 0) {
        e.memory.s = "delivering";
        return;
      }
      clearAssignment(e, "pickup source gone", true);
      return;
    }
    if (cheb(e.pos, p.pos) > 1) {
      smartMove(e, p);
      return;
    }
    delete e.memory._move;
    var g;
    if (r.type === "dropped_pickup") {
      g = e.pickup(p);
    } else {
      var d = Math.min(r.amount || f, f, e.store.getFreeCapacity());
      g = d > 0 ? e.withdraw(p, m, d) : ERR_FULL;
    }
    if (g === OK) {
      e.memory.s = "delivering";
      refreshProgress(e, r);
      if (t.storage && cheb(e.pos, t.storage.pos) > 1) smartMove(e, t.storage);
    } else if (g === ERR_FULL) {
      if (e.store[m] || 0) e.memory.s = "delivering"; else clearAssignment(e, "pickup full", true);
    } else if (g === ERR_NOT_ENOUGH_RESOURCES) {
      if (e.store[m] || 0) e.memory.s = "delivering"; else clearAssignment(e, "pickup empty", true);
    } else if (g !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "pickup err " + g, true);
    }
    return;
  }
  if (r.type === "lab_unload") {
    var y = getLabTaskResource(r);
    var v = Game.getObjectById(getLabTaskLabId(r));
    if (!v || !v.store || !y) {
      clearAssignment(e, "lab unload source gone", true);
      return;
    }
    if (e.store.getUsedCapacity() > 0) {
      if ((e.store[y] || 0) > 0) {
        if (e.store.getFreeCapacity() <= 0) {
          e.memory.s = "delivering";
          return;
        }
      } else {
        dumpNonEnergy(e, e.room, y);
        return;
      }
    }
    if ((v.store[y] || 0) <= 0) {
      if ((e.store[y] || 0) > 0 && e.store.getFreeCapacity() > 0) {
        var R = findNextLabUnloadTask(e, t, r, y);
        if (R) {
          setAssignment(e, {
            type: R.type,
            taskId: R.taskId,
            targetId: R.targetId,
            amount: R.amount,
            assignedTick: Game.time,
            extra: R.extra || ""
          });
          a.fetchSourceId = getLabTaskLabId(R);
          e.memory.s = "fetching";
          delete e.memory._move;
          var E = Game.getObjectById(getLabTaskLabId(R));
          if (E && cheb(e.pos, E.pos) > 1) smartMove(e, E);
          return;
        }
      }
      if ((e.store[y] || 0) > 0) {
        e.memory.s = "delivering";
        if (t.terminal && cheb(e.pos, t.terminal.pos) > 1) smartMove(e, t.terminal);
        return;
      }
      clearAssignment(e, "lab unload empty", true);
      return;
    }
    a.fetchSourceId = v.id;
    if (cheb(e.pos, v.pos) > 1) {
      smartMove(e, v);
      return;
    }
    delete e.memory._move;
    var _ = Math.min(r.amount || v.store[y] || 0, v.store[y] || 0, e.store.getFreeCapacity());
    var h = e.withdraw(v, y, _);
    if (h === OK || h === ERR_FULL) {
      refreshProgress(e, r);
      if (e.store.getFreeCapacity() > 0) {
        var T = findNextLabUnloadTask(e, t, r, y);
        if (T) {
          setAssignment(e, {
            type: T.type,
            taskId: T.taskId,
            targetId: T.targetId,
            amount: T.amount,
            assignedTick: Game.time,
            extra: T.extra || ""
          });
          a.fetchSourceId = getLabTaskLabId(T);
          e.memory.s = "fetching";
          delete e.memory._move;
          var k = Game.getObjectById(getLabTaskLabId(T));
          if (k && cheb(e.pos, k.pos) > 1) smartMove(e, k);
          return;
        }
      }
      e.memory.s = "delivering";
      if (t.terminal && cheb(e.pos, t.terminal.pos) > 1) smartMove(e, t.terminal);
    } else if (h === ERR_NOT_ENOUGH_RESOURCES) {
      if ((e.store[y] || 0) > 0 && e.store.getFreeCapacity() > 0) {
        var C = findNextLabUnloadTask(e, t, r, y);
        if (C) {
          setAssignment(e, {
            type: C.type,
            taskId: C.taskId,
            targetId: C.targetId,
            amount: C.amount,
            assignedTick: Game.time,
            extra: C.extra || ""
          });
          a.fetchSourceId = getLabTaskLabId(C);
          e.memory.s = "fetching";
          delete e.memory._move;
          return;
        }
      }
      if ((e.store[y] || 0) > 0) {
        e.memory.s = "delivering";
        if (t.terminal && cheb(e.pos, t.terminal.pos) > 1) smartMove(e, t.terminal);
        return;
      }
      clearAssignment(e, "lab unload empty", true);
    } else if (h !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "lab unload withdraw err " + h, true);
    }
    return;
  }
  if (r.type === "lab_load") {
    var b = ensureLabLoadRoute(e, t, r);
    if (!b || b.length === 0) {
      clearAssignment(e, "lab load route empty", true);
      return;
    }
    var I = getLabTaskResource(r);
    var O = Game.getObjectById(getLabTaskLabId(r));
    while (!I || !O || !O.store || (r.amount || 0) <= 0 || O.mineralType && O.mineralType !== I || (O.store.getFreeCapacity(I) || 0) <= 0) {
      r = advanceLabLoadRoute(e, a);
      if (!r) return;
      I = getLabTaskResource(r);
      O = Game.getObjectById(getLabTaskLabId(r));
    }
    var S = parseExtra(r.extra, "program");
    var U = getLabLoadRouteNeed(a.labLoadRoute);
    var N = e.store[I] || 0;
    var A = chooseLabLoadSource(e.room, I, S);
    var L = A ? getLabLoadSourceAvailable(e.room.name, I, S, A) : 0;
    var G = N > 0 && e.store.getFreeCapacity() > 0 && U > N && L > 0;
    if (e.store.getUsedCapacity() > 0 && !G) {
      if (N > 0) e.memory.s = "delivering"; else dumpNonEnergy(e, e.room, I);
      return;
    }
    if (!A || !A.store) {
      clearAssignment(e, "lab load source empty", true);
      return;
    }
    a.fetchSourceId = A.id;
    if (cheb(e.pos, A.pos) > 1) {
      smartMove(e, A);
      return;
    }
    delete e.memory._move;
    var x = e.store.getFreeCapacity();
    var M = Math.min(Math.max(0, U - N), L, x);
    if (M <= 0) {
      if (N > 0) e.memory.s = "delivering"; else clearAssignment(e, "lab load has no available amount", true);
      return;
    }
    var P = e.withdraw(A, I, M);
    if (P === OK) {
      e.memory.s = "delivering";
      refreshProgress(e, r);
      if (S && (A.structureType === STRUCTURE_STORAGE || A.structureType === STRUCTURE_TERMINAL)) {
        consumeProgramReservation(e.room.name, I, S, A.structureType === STRUCTURE_STORAGE ? "storage" : "terminal", Math.min(M, L));
      }
      if (O && cheb(e.pos, O.pos) > 1) smartMove(e, O);
    } else if (P === ERR_FULL) {
      if ((e.store[I] || 0) > 0) {
        e.memory.s = "delivering";
        if (O && cheb(e.pos, O.pos) > 1) smartMove(e, O);
      }
    } else if (P === ERR_NOT_ENOUGH_RESOURCES) {
      a.fetchSourceId = null;
      e.memory.s = "fetching";
    } else if (P !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "lab load withdraw err " + P, true);
    }
    return;
  }
  if (r.type === "market_lab_stage") {
    var F = getMarketLabStageResource(r);
    var w = t.storage;
    if (!F || !w || !w.store) {
      clearAssignment(e, "market lab stage source gone", true);
      return;
    }
    if (e.store.getUsedCapacity() > 0) {
      if ((e.store[F] || 0) > 0) {
        e.memory.s = "delivering";
      } else {
        dumpNonEnergy(e, e.room, F);
      }
      return;
    }
    a.fetchSourceId = w.id;
    if (cheb(e.pos, w.pos) > 1) {
      smartMove(e, w);
      return;
    }
    delete e.memory._move;
    var Y = w.store.getUsedCapacity(F) || 0;
    var W = e.store.getFreeCapacity();
    var D = Math.min(r.amount || Y, Y, W);
    var B = e.withdraw(w, F, D);
    if (B === OK || B === ERR_FULL) {
      e.memory.s = "delivering";
      refreshProgress(e, r);
      if (t.terminal && cheb(e.pos, t.terminal.pos) > 1) smartMove(e, t.terminal);
      if (r.extra) {
        var K = parseExtra(r.extra, "program");
        var H = K ? getProgramReserved(e.room.name, F, K, "storage") : 0;
        if (K && H > 0) {
          consumeProgramReservation(e.room.name, F, K, "storage", Math.min(D, Y, H));
        }
      }
    } else if (B === ERR_NOT_ENOUGH_RESOURCES) {
      clearAssignment(e, "market lab stage empty", true);
    } else if (B !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "market lab stage withdraw err " + B, true);
    }
    return;
  }
  if (r.type === "terminal_stock") {
    var j = getTerminalStockResource(r);
    var V = Game.getObjectById(r.taskId);
    if (!j || !V || !V.store) {
      clearAssignment(e, "terminal stock source gone", true);
      return;
    }
    if (e.store.getUsedCapacity() > 0) {
      if ((e.store[j] || 0) > 0) {
        e.memory.s = "delivering";
      } else {
        dumpNonEnergy(e, e.room, j);
      }
      return;
    }
    var X = V.store.getUsedCapacity(j) || 0;
    if (X <= 0) {
      clearAssignment(e, "terminal stock source empty", true);
      return;
    }
    a.fetchSourceId = V.id;
    if (cheb(e.pos, V.pos) > 1) {
      smartMove(e, V);
      return;
    }
    delete e.memory._move;
    var q = e.store.getFreeCapacity();
    var z = Math.min(r.amount || X, X, q);
    var J = e.withdraw(V, j, z);
    if (J === OK || J === ERR_FULL) {
      e.memory.s = "delivering";
      refreshProgress(e, r);
      var Q = parseExtra(r.extra, "program");
      if (Q) {
        var $ = V.structureType === STRUCTURE_STORAGE ? "storage" : "terminal";
        var Z = getProgramReserved(e.room.name, j, Q, $);
        if (Z > 0) {
          consumeProgramReservation(e.room.name, j, Q, $, Math.min(z, X, Z));
        }
      }
      var ee = Game.getObjectById(r.targetId);
      if (ee && cheb(e.pos, ee.pos) > 1) smartMove(e, ee);
    } else if (J === ERR_NOT_ENOUGH_RESOURCES) {
      clearAssignment(e, "terminal stock empty", true);
    } else if (J !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "terminal stock withdraw err " + J, true);
    }
    return;
  }
  if (r.type === "factory_input") {
    var re = getFactoryTaskResource(r);
    var te = Game.getObjectById(r.targetId);
    if (!te || !te.store || !re) {
      clearAssignment(e, "factory input target gone", true);
      return;
    }
    if (e.store.getUsedCapacity() > 0) {
      if ((e.store[re] || 0) > 0) {
        e.memory.s = "delivering";
      } else {
        dumpNonEnergy(e, e.room, re);
      }
      return;
    }
    var ae = parseExtra(r.extra, "program");
    Ee = chooseFactorySource(e.room, re, ae);
    if (!Ee) {
      clearAssignment(e, "factory input source empty", true);
      return;
    }
    var oe = getActiveFactoryOrder(t.roomName);
    var ie = oe ? factoryManager.getRecipe(oe.product) : null;
    var ne = factoryInputDeficit(te, oe, ie, re);
    if (ne <= 0) {
      clearAssignment(e, "factory input satisfied", true);
      return;
    }
    a.fetchSourceId = Ee.id;
    if (cheb(e.pos, Ee.pos) > 1) {
      smartMove(e, Ee);
      return;
    }
    delete e.memory._move;
    var se = Ee.store.getUsedCapacity(re) || 0;
    var ue = e.store.getFreeCapacity();
    var le = Math.min(r.amount || se, se, ue, ne);
    var ce = e.withdraw(Ee, re, le);
    if (ce === OK || ce === ERR_FULL) {
      e.memory.s = "delivering";
      refreshProgress(e, r);
      if (ae && (Ee.structureType === STRUCTURE_STORAGE || Ee.structureType === STRUCTURE_TERMINAL)) {
        consumeProgramReservation(e.room.name, re, ae, Ee.structureType === STRUCTURE_STORAGE ? "storage" : "terminal", Math.min(le, se));
      }
      var me = Game.getObjectById(r.targetId);
      if (me && cheb(e.pos, me.pos) > 1) smartMove(e, me);
    } else if (ce === ERR_NOT_ENOUGH_RESOURCES) {
      clearAssignment(e, "factory input empty", true);
    } else if (ce !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "factory input withdraw err " + ce, true);
    }
    return;
  }
  if (r.type === "factory_output" || r.type === "factory_drain") {
    var pe = getFactoryTaskResource(r);
    var fe = t.factory;
    var ge = Game.getObjectById(r.targetId);
    if (!fe || !fe.store || !pe || !ge || !ge.store) {
      clearAssignment(e, "factory output target gone", true);
      return;
    }
    if (e.store.getUsedCapacity() > 0) {
      if ((e.store[pe] || 0) > 0) {
        e.memory.s = "delivering";
      } else {
        dumpNonEnergy(e, e.room, pe);
      }
      return;
    }
    Ee = fe;
    a.fetchSourceId = Ee.id;
    if (cheb(e.pos, Ee.pos) > 1) {
      smartMove(e, Ee);
      return;
    }
    delete e.memory._move;
    var de = Ee.store.getUsedCapacity(pe) || 0;
    if (r.type === "factory_drain") {
      de = Math.max(0, de - (+parseExtra(r.extra, "keep") || 0));
    }
    if (de <= 0) {
      clearAssignment(e, "factory drained to keep", true);
      return;
    }
    var ye = e.store.getFreeCapacity();
    var ve = Math.min(r.amount || de, de, ye);
    var Re = e.withdraw(Ee, pe, ve);
    if (Re === OK) {
      markFactoryFetched(e, r, pe);
      e.memory.s = "delivering";
      refreshProgress(e, r);
      if (ge && cheb(e.pos, ge.pos) > 1) smartMove(e, ge);
    } else if (Re === ERR_FULL) {
      e.memory.s = "delivering";
    } else if (Re === ERR_NOT_ENOUGH_RESOURCES) {
      clearAssignment(e, "factory output empty", true);
    } else if (Re !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "factory output withdraw err " + Re, true);
    }
    return;
  }
  var Ee = null;
  if (isWithdrawTask(r.type)) {
    Ee = Game.getObjectById(r.taskId);
    if (!Ee || (Ee.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= 0) {
      if (e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        e.memory.s = "delivering";
        return;
      }
      clearAssignment(e, "fetch src empty", true);
      return;
    }
  } else {
    Ee = findEnergySource(e, t, a);
    if (!Ee) {
      if (e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        e.memory.s = "delivering";
        return;
      }
      clearAssignment(e, "no energy source", true);
      return;
    }
    a.fetchSourceId = Ee.id;
  }
  var _e = null;
  var he = Ee.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  var Te = e.store.getFreeCapacity();
  if (r.type === "link_drain") {
    var ke = getStorageLinkTarget(t, Ee);
    var Ce = Math.max(0, he - ke);
    if (Ce <= 0) {
      if (e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        e.memory.s = "delivering";
        return;
      }
      clearAssignment(e, "link drained enough", true);
      return;
    }
    _e = Math.min(r.amount || Ce, Ce, Te);
  } else if (r.type === "link_fill") {
    var be = Game.getObjectById(r.targetId);
    if (!be) {
      clearAssignment(e, "link gone", true);
      return;
    }
    var Ie = getStorageLinkTarget(t, be);
    var Oe = Math.max(0, Ie - (be.store.getUsedCapacity(RESOURCE_ENERGY) || 0));
    if (Oe <= LINK_FILL_DEADBAND) {
      clearAssignment(e, "link fill within deadband", true);
      return;
    }
    _e = Math.min(r.amount || he, he, Te, Oe);
  } else if (r.type === "terminal_balance") {
    _e = Math.min(r.amount || he, he, Te);
  } else {
    _e = Math.min(he, Te);
  }
  if (cheb(e.pos, Ee.pos) > 1) {
    smartMove(e, Ee);
    return;
  }
  delete e.memory._move;
  var Se = _e != null ? e.withdraw(Ee, RESOURCE_ENERGY, _e) : e.withdraw(Ee, RESOURCE_ENERGY);
  if (Se === OK || Se === ERR_FULL) {
    e.memory.s = "delivering";
    refreshProgress(e, r);
    var Ue = Game.getObjectById(r.targetId || r.taskId);
    if (Ue && Ue.id !== Ee.id && cheb(e.pos, Ue.pos) > 1) smartMove(e, Ue);
  } else if (Se === ERR_NOT_ENOUGH_RESOURCES) {
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      e.memory.s = "delivering";
      return;
    }
    clearAssignment(e, "not enough res", true);
  } else if (Se !== ERR_NOT_IN_RANGE) {
    clearAssignment(e, "withdraw err " + Se, true);
  }
}

function findPowerSource(e, r) {
  if (r.fetchSourceId) {
    var t = Game.getObjectById(r.fetchSourceId);
    if (t && t.store && (t.store[RESOURCE_POWER] || 0) > 0) return t;
    r.fetchSourceId = null;
  }
  if (e.storage && (e.storage.store[RESOURCE_POWER] || 0) > 0) return e.storage;
  if (e.terminal && (e.terminal.store[RESOURCE_POWER] || 0) > 0) return e.terminal;
  return null;
}

function executePowerUpgradeFetch(e, r, t, a) {
  if (!isPowerUpgradeActive(t.roomName)) {
    clearAssignment(e, "power upgrade inactive", false);
    return;
  }
  var o = getPowerUpgradeResource(r);
  if ((e.store[o] || 0) > 0 || e.store.getFreeCapacity() <= 0) {
    e.memory.s = "delivering";
    return;
  }
  var i = o === RESOURCE_POWER ? findPowerSource(t, a) : findEnergySource(e, t, a, 50);
  if (!i) {
    clearAssignment(e, "no power upgrade source", true);
    return;
  }
  a.fetchSourceId = i.id;
  if (cheb(e.pos, i.pos) > 1) {
    smartMove(e, i);
    return;
  }
  var n = Math.min(r.amount || 0, i.store.getUsedCapacity(o) || 0, e.store.getFreeCapacity());
  if (n <= 0) {
    clearAssignment(e, "power upgrade source empty", true);
    return;
  }
  var s = e.withdraw(i, o, n);
  if (s === OK || s === ERR_FULL) {
    e.memory.s = "delivering";
    refreshProgress(e, r);
    var u = Game.getObjectById(r.targetId);
    if (u && cheb(e.pos, u.pos) > 1) smartMove(e, u);
  } else if (s !== ERR_NOT_IN_RANGE) {
    clearAssignment(e, "power upgrade withdraw err " + s, true);
  }
}

function findEnergySource(e, r, t, a) {
  var o = typeof a === "number" ? a : 500;
  if (t.fetchSourceId) {
    var i = Game.getObjectById(t.fetchSourceId);
    if (i && i.store && (i.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0 && !(i.structureType === STRUCTURE_CONTAINER && isLinkServed(e.room, i.id)) && (i.structureType !== STRUCTURE_CONTAINER || i.store.getUsedCapacity(RESOURCE_ENERGY) >= CONTAINER_RESELECT_ENERGY)) {
      return i;
    }
    t.fetchSourceId = null;
  }
  if (r.storage) {
    var n = r.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var s = typeof a === "number" ? n >= o : n > 500;
    if (s) return r.storage;
  }
  var u = [];
  for (var l = 0; l < r.containers.length; l++) {
    var c = r.containers[l];
    var m = c.store.getUsedCapacity(RESOURCE_ENERGY);
    if (m <= 0) continue;
    if (r.controller && cheb(c.pos, r.controller.pos) <= 2) continue;
    if (isLinkServed(e.room, c.id)) continue;
    u.push(c);
  }
  if (u.length > 0) {
    var p = u[0];
    var f = p.store.getUsedCapacity(RESOURCE_ENERGY);
    var g = cheb(e.pos, p.pos);
    for (var d = 0; d < u.length; d++) {
      var y = u[d].store.getUsedCapacity(RESOURCE_ENERGY);
      var v = cheb(e.pos, u[d].pos);
      if (y > f || y === f && v < g) {
        p = u[d];
        f = y;
        g = v;
      }
    }
    return p;
  }
  if (r.terminal && r.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return r.terminal;
  return null;
}

function executeDeliver(e, r, t, a) {
  if (isPowerUpgradeTask(r.type)) {
    executePowerUpgradeDeliver(e, r, t, a);
    return;
  }
  if (e.store.getUsedCapacity() === 0) {
    if (r.type === "extension") {
      if (a.extRoute && a.extRoute.length > 0) {
        e.memory.s = "fetching";
        if (t.storage && cheb(e.pos, t.storage.pos) > 1) {
          smartMove(e, t.storage);
        }
        return;
      }
      a.extRoute = buildExtensionRoute(e, t);
      a.extRouteTick = Game.time;
      if (a.extRoute.length > 0) {
        e.memory.s = "fetching";
        if (t.storage && cheb(e.pos, t.storage.pos) > 1) {
          smartMove(e, t.storage);
        }
        return;
      }
      clearAssignment(e, "ext all full", true);
      return;
    }
    if (!isAssignmentDone(e, t, r, a)) {
      e.memory.s = "fetching";
      return;
    }
    clearAssignment(e, "nothing to deliver", true);
    return;
  }
  if (r.type === "lab_unload") {
    var o = getLabTaskResource(r);
    var i = t.terminal;
    if (!o || !i || !i.store) {
      clearAssignment(e, "lab unload target missing", true);
      return;
    }
    if ((e.store[o] || 0) <= 0) {
      clearAssignment(e, "lab unload empty", true);
      return;
    }
    if (cheb(e.pos, i.pos) > 1) {
      smartMove(e, i);
      return;
    }
    delete e.memory._move;
    var n = e.store[o] || 0;
    var s = i.store.getFreeCapacity(o) || n;
    var u = Math.min(n, s);
    var l = e.transfer(i, o, u);
    if (l === OK) {
      refreshProgress(e, r);
      var c = getLabOrder(t.roomName);
      if (c && c.type === "production" && o === c.product && labManager && typeof labManager.recordDelivery === "function") {
        labManager.recordDelivery(t.roomName, o, u);
      }
      if (isAssignmentDone(e, t, r, a)) {
        clearAssignment(e, "lab unload complete", true);
      } else if (n - u <= 0) {
        e.memory.s = "fetching";
      }
    } else if (l === ERR_FULL) {
      clearAssignment(e, "lab unload target full", true);
    } else if (l !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "lab unload transfer err " + l, true);
    }
    return;
  }
  if (r.type === "lab_load") {
    var m = ensureLabLoadRoute(e, t, r);
    if (!m || m.length === 0) {
      clearAssignment(e, "lab load route empty", true);
      return;
    }
    var p = getLabTaskResource(r);
    var f = Game.getObjectById(r.targetId || getLabTaskLabId(r));
    while (!p || !f || !f.store || (r.amount || 0) <= 0 || f.mineralType && f.mineralType !== p || (f.store.getFreeCapacity(p) || 0) <= 0) {
      r = advanceLabLoadRoute(e, a);
      if (!r) return;
      p = getLabTaskResource(r);
      f = Game.getObjectById(r.targetId || getLabTaskLabId(r));
    }
    if ((e.store[p] || 0) <= 0) {
      e.memory.s = "fetching";
      var g = chooseLabLoadSource(e.room, p, parseExtra(r.extra, "program"));
      if (g && cheb(e.pos, g.pos) > 1) smartMove(e, g);
      return;
    }
    if (cheb(e.pos, f.pos) > 1) {
      smartMove(e, f);
      return;
    }
    delete e.memory._move;
    var d = e.store[p] || 0;
    var y = f.store.getFreeCapacity(p) || d;
    var v = r.amount || 0;
    var R = Math.min(d, y, v || d);
    var E = e.transfer(f, p, R);
    if (E === OK) {
      r.amount = Math.max(0, v - R);
      a.labLoadRoute[0].amount = r.amount;
      setAssignment(e, r);
      refreshProgress(e, r);
      if (parseExtra(r.extra, "record") === "1" && labManager && typeof labManager.recordDelivery === "function") {
        labManager.recordDelivery(e.room.name, p, R);
      }
      var _ = simulateFillDone(r, t, f, R);
      if (r.amount <= 0 || _ === true) {
        var h = advanceLabLoadRoute(e, a);
        if (!h) return;
        var T = d - R;
        e.memory.s = T > 0 ? "delivering" : "fetching";
        var k = T > 0 ? Game.getObjectById(h.targetId || getLabTaskLabId(h)) : chooseLabLoadSource(e.room, getLabTaskResource(h), parseExtra(h.extra, "program"));
        if (k && cheb(e.pos, k.pos) > 1) smartMove(e, k);
        return;
      }
      if (d - R <= 0) {
        e.memory.s = "fetching";
        var C = chooseLabLoadSource(e.room, p, parseExtra(r.extra, "program"));
        if (C && cheb(e.pos, C.pos) > 1) smartMove(e, C);
      } else {
        e.memory.s = "delivering";
      }
    } else if (E === ERR_FULL) {
      var b = advanceLabLoadRoute(e, a);
      if (b) {
        var I = e.store[p] || 0;
        e.memory.s = I > 0 ? "delivering" : "fetching";
        var O = I > 0 ? Game.getObjectById(b.targetId || getLabTaskLabId(b)) : chooseLabLoadSource(e.room, getLabTaskResource(b), parseExtra(b.extra, "program"));
        if (O && cheb(e.pos, O.pos) > 1) smartMove(e, O);
      }
    } else if (E !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "lab load transfer err " + E, true);
    }
    return;
  }
  if (r.type === "market_lab_stage") {
    var S = getMarketLabStageResource(r);
    var U = Game.getObjectById(r.targetId);
    if (!S || !U || !U.store) {
      clearAssignment(e, "market lab stage target missing", true);
      return;
    }
    if ((e.store[S] || 0) <= 0) {
      clearAssignment(e, "market lab stage empty", true);
      return;
    }
    if (cheb(e.pos, U.pos) > 1) {
      smartMove(e, U);
      return;
    }
    delete e.memory._move;
    var N = e.store[S] || 0;
    var A = U.store.getFreeCapacity(S) || N;
    if (A <= 0) {
      clearAssignment(e, "market lab stage target full", true);
      return;
    }
    var L = Math.min(N, A);
    var G = e.transfer(U, S, L);
    if (G === ERR_FULL) {
      clearAssignment(e, "market lab stage full", true);
      return;
    }
    if (G === OK) {
      refreshProgress(e, r);
      var x = simulateFillDone(r, t, U, L);
      if (x === null) x = isAssignmentDone(e, t, r, a);
      if (x) {
        clearAssignment(e, "market lab stage complete", true);
        return;
      }
      if (N - L <= 0) e.memory.s = "fetching";
    } else if (G !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "market lab stage transfer err " + G, true);
    }
    return;
  }
  if (r.type === "terminal_stock") {
    var M = getTerminalStockResource(r);
    var P = Game.getObjectById(r.targetId);
    if (!M || !P || !P.store) {
      clearAssignment(e, "terminal stock target missing", true);
      return;
    }
    if ((e.store[M] || 0) <= 0) {
      clearAssignment(e, "terminal stock empty", true);
      return;
    }
    if (cheb(e.pos, P.pos) > 1) {
      smartMove(e, P);
      return;
    }
    delete e.memory._move;
    var F = e.store[M] || 0;
    var w = P.store.getFreeCapacity(M) || F;
    if (w <= 0) {
      clearAssignment(e, "terminal stock target full", true);
      return;
    }
    var Y = Math.min(F, w);
    var W = e.transfer(P, M, Y);
    if (W === ERR_FULL) {
      clearAssignment(e, "terminal stock full", true);
      return;
    }
    if (W === OK) {
      refreshProgress(e, r);
      var D = parseExtra(r.extra, "op");
      var B = parseExtra(r.extra, "type");
      var K = parseExtra(r.extra, "program");
      if (D) {
        var H = findTerminalOpById(D);
        if (H) {
          if (typeof H.amountMoved !== "number") H.amountMoved = 0;
          H.amountMoved += Y;
          if (K && terminalManager && typeof terminalManager.consumeOperationStock === "function") {
            var j = B === "toTerminal" ? "terminal" : "storage";
            terminalManager.consumeOperationStock(H, e.room.name, M, j, Y, K);
          }
        }
      }
      var V = simulateFillDone(r, t, P, Y);
      if (V === null) V = isAssignmentDone(e, t, r, a);
      if (V) {
        clearAssignment(e, "terminal stock complete", true);
        return;
      }
      if (F - Y <= 0) e.memory.s = "fetching";
    } else if (W !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "terminal stock transfer err " + W, true);
    }
    return;
  }
  if (r.type === "extension") {
    executeExtensionDeliver(e, r, t, a);
    return;
  }
  if (r.type === "factory_input" || r.type === "factory_output" || r.type === "factory_drain") {
    var X = getFactoryTaskResource(r);
    var q = t.factory;
    var z = Game.getObjectById(r.targetId);
    if (!X || !q || !z || !z.store) {
      clearAssignment(e, "factory target missing", true);
      return;
    }
    if (cheb(e.pos, z.pos) > 1) {
      smartMove(e, z);
      return;
    }
    delete e.memory._move;
    if (r.type === "factory_input") {
      if ((e.store[X] || 0) <= 0) {
        clearAssignment(e, "factory input empty", true);
        return;
      }
      var J = getActiveFactoryOrder(t.roomName);
      if (!J || (J.phase || "loading") !== "loading") {
        clearAssignment(e, "factory not loading", true);
        return;
      }
      var Q = factoryManager.getRecipe(J.product);
      var $ = factoryInputDeficit(z, J, Q, X);
      if ($ <= 0) {
        clearAssignment(e, "factory input satisfied", true);
        return;
      }
      var Z = e.store[X] || 0;
      var ee = z.store.getFreeCapacity ? z.store.getFreeCapacity(X) || 0 : Z;
      if (ee <= 0) {
        e.memory.s = "delivering";
        return;
      }
      var re = Math.min(Z, ee, $);
      var te = e.transfer(z, X, re);
      if (te === ERR_FULL) {
        e.memory.s = "delivering";
        return;
      }
      if (te === OK) {
        refreshProgress(e, r);
        var ae = simulateFillDone(r, t, z, re);
        if (ae === null) ae = isAssignmentDone(e, t, r, a);
        if (ae && (e.store[X] || 0) <= 0) {
          clearAssignment(e, "task complete", true);
          return;
        }
        if ((e.store[X] || 0) > 0) e.memory.s = "delivering"; else if (ae) {
          clearAssignment(e, "task complete", true);
          return;
        } else e.memory.s = "fetching";
      } else if (te !== ERR_NOT_IN_RANGE) {
        if ((e.store[X] || 0) > 0) {
          e.memory.s = "delivering";
          return;
        }
        clearAssignment(e, "factory input transfer err " + te, true);
      }
      return;
    }
    if ((e.store[X] || 0) <= 0) {
      clearAssignment(e, "factory output empty", true);
      return;
    }
    if ((r.type === "factory_output" || r.type === "factory_drain") && !hasFactoryFetched(e, r, X)) {
      if (dumpResource(e, e.room, X)) return;
      clearAssignment(e, "factory output cargo not fetched", true);
      return;
    }
    var oe = e.store[X] || 0;
    var ie = z.store.getFreeCapacity(X) || oe;
    var ne = Math.min(oe, ie);
    var se = e.transfer(z, X, ne);
    if (se === ERR_FULL) {
      clearAssignment(e, "factory sink full", true);
      return;
    }
    if (se === OK) {
      refreshProgress(e, r);
      var ue = isAssignmentDone(e, t, r, a);
      if (ue) {
        clearAssignment(e, "task complete", true);
        return;
      }
      if (oe - ne <= 0) {
        delete e.memory.ff;
        e.memory.s = "fetching";
      }
    } else if (se !== ERR_NOT_IN_RANGE) {
      clearAssignment(e, "factory transfer err " + se, true);
    }
    return;
  }
  var z = Game.getObjectById(r.targetId || r.taskId);
  if (!z) {
    clearAssignment(e, "target gone", true);
    return;
  }
  var le = getAssignmentResource(r);
  if (z.store && z.store.getFreeCapacity && z.store.getFreeCapacity(le) <= 0) {
    clearAssignment(e, "target full", true);
    return;
  }
  if (cheb(e.pos, z.pos) > 1) {
    var ce = smartMove(e, z);
    if (ce === ERR_NO_PATH && Game.time >= a.rerouteUntil) {
      a.noPathCount = (a.noPathCount || 0) + 1;
      if (a.noPathCount >= NO_PATH_TTL) clearAssignment(e, "no path", true);
    } else {
      a.noPathCount = 0;
    }
    return;
  }
  delete e.memory._move;
  var me = null;
  if (r.type === "link_fill") {
    var pe = z.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var fe = Math.max(0, getStorageLinkTarget(t, z) - pe);
    if (fe <= LINK_FILL_DEADBAND) {
      clearAssignment(e, "link fill within deadband", true);
      return;
    }
    me = Math.min(r.amount || e.store.getUsedCapacity(RESOURCE_ENERGY), fe, e.store.getUsedCapacity(RESOURCE_ENERGY));
  }
  var ge = me != null ? e.transfer(z, le, me) : e.transfer(z, le);
  if (ge === ERR_FULL) {
    clearAssignment(e, "target full", true);
    return;
  }
  if (ge === OK) {
    refreshProgress(e, r);
    var de = e.store.getUsedCapacity(le) || 0;
    var ye = z.store && z.store.getFreeCapacity ? z.store.getFreeCapacity(le) || 0 : de;
    var ve = Math.min(de, ye);
    if (me != null) ve = Math.min(ve, me);
    var Re = de - ve;
    if (r.type === "fallback_dump") {
      if (Re <= 0) clearAssignment(e, "dump complete", true);
      return;
    }
    var Ee = simulateFillDone(r, t, z, ve);
    if (Ee === null) Ee = isAssignmentDone(e, t, r, a);
    if (Ee) {
      clearAssignment(e, "task complete", true);
      return;
    }
    if (Re > 0) return;
    e.memory.s = "fetching";
    var _e = null;
    if (isWithdrawTask(r.type)) {
      _e = Game.getObjectById(getPickupSourceId(r));
    } else if (t.storage && (t.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) {
      _e = t.storage;
    } else {
      _e = findEnergySource(e, t, a);
    }
    if (_e && _e.id !== z.id && cheb(e.pos, _e.pos) > 1) {
      smartMove(e, _e);
    }
    return;
  }
  if (ge !== ERR_NOT_IN_RANGE) {
    clearAssignment(e, "transfer err " + ge, true);
  }
}

function executePowerUpgradeDeliver(e, r, t, a) {
  if (!isPowerUpgradeActive(t.roomName)) {
    clearAssignment(e, "power upgrade inactive", false);
    return;
  }
  var o = getPowerUpgradeResource(r);
  var i = e.store[o] || 0;
  if (i <= 0) {
    e.memory.s = "fetching";
    return;
  }
  var n = Game.getObjectById(r.targetId);
  if (!n || !n.store) {
    clearAssignment(e, "power spawn gone", true);
    return;
  }
  if (cheb(e.pos, n.pos) > 1) {
    smartMove(e, n);
    return;
  }
  var s = Math.min(r.amount || 0, i, n.store.getFreeCapacity(o) || 0);
  if (s <= 0) {
    clearAssignment(e, "power spawn task complete", true);
    return;
  }
  var u = e.transfer(n, o, s);
  if (u === OK) {
    r.amount = Math.max(0, (r.amount || 0) - s);
    refreshProgress(e, r);
    e.memory.s = r.amount <= 0 ? "delivering" : "fetching";
  } else if (u === ERR_FULL) {
    clearAssignment(e, "power spawn full", true);
  } else if (u !== ERR_NOT_IN_RANGE) {
    clearAssignment(e, "power upgrade transfer err " + u, true);
  }
}

function executeExtensionDeliver(e, r, t, a) {
  var o = a.extRoute;
  if (!o || o.length === 0) {
    o = buildExtensionRoute(e, t);
    a.extRoute = o;
    a.extRouteTick = Game.time;
    if (o.length === 0) {
      clearAssignment(e, "ext all full", true);
      return;
    }
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.memory.s = "fetching";
      return;
    }
  }
  if (a.extRouteTick && Game.time - a.extRouteTick > EXT_ROUTE_RECOMPUTE_TICKS) {
    o = buildExtensionRoute(e, t);
    a.extRoute = o;
    a.extRouteTick = Game.time;
    if (o.length === 0) {
      clearAssignment(e, "ext stale recompute empty", true);
      return;
    }
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.memory.s = "fetching";
      return;
    }
  }
  var i = t.controller && t.controller.level >= 8;
  var n = 0;
  while (o.length > 0 && o[0] !== "REFUEL") {
    var s = Game.getObjectById(o[0]);
    if (s && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      if (!i || (s.store.getUsedCapacity(RESOURCE_ENERGY) || 0) === 0) break;
    }
    o.shift();
    n++;
    if (n >= EXT_ROUTE_SKIP_LIMIT) {
      o = buildExtensionRoute(e, t);
      a.extRoute = o;
      a.extRouteTick = Game.time;
      return;
    }
  }
  if (o.length === 0) {
    o = buildExtensionRoute(e, t);
    a.extRoute = o;
    a.extRouteTick = Game.time;
    if (o.length === 0) {
      clearAssignment(e, "ext done", true);
      return;
    }
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.memory.s = "fetching";
      return;
    }
    return;
  }
  if (o[0] === "REFUEL") {
    o.shift();
    e.memory.s = "fetching";
    if (t.storage && cheb(e.pos, t.storage.pos) > 1) {
      smartMove(e, t.storage);
    }
    return;
  }
  var u = Game.getObjectById(o[0]);
  if (!u) {
    o.shift();
    return;
  }
  var l = t._extWpMap;
  var c = l && l[u.id] ? l[u.id] : u.pos;
  if (cheb(e.pos, u.pos) > 1) {
    smartMove(e, c, {
      range: 0
    });
    return;
  }
  delete e.memory._move;
  var m = e.store.getUsedCapacity(RESOURCE_ENERGY);
  var p = u.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  if (m < p && e.store.getFreeCapacity() > 0) {
    o.unshift("REFUEL");
    e.memory.s = "fetching";
    if (t.storage && cheb(e.pos, t.storage.pos) > 1) {
      smartMove(e, t.storage);
    }
    return;
  }
  var f = e.transfer(u, RESOURCE_ENERGY);
  if (f === OK || f === ERR_FULL) {
    o.shift();
    if (f === OK && m < p) {
      o.unshift(u.id);
      o.unshift("REFUEL");
      e.memory.s = "fetching";
      if (t.storage && cheb(e.pos, t.storage.pos) > 1) {
        smartMove(e, t.storage);
      }
      return;
    }
    refreshProgress(e, r);
    var g = e.store.getUsedCapacity(RESOURCE_ENERGY) - p;
    var d = false;
    var y = null;
    if (o.length > 0) {
      if (o[0] === "REFUEL") {
        if (t.storage && cheb(e.pos, t.storage.pos) > 1) {
          d = true;
          y = t.storage;
        }
      } else {
        var v = Game.getObjectById(o[0]);
        if (v) {
          var R = l && l[v.id] ? l[v.id] : v.pos;
          if (cheb(e.pos, R) > 1) {
            d = true;
            y = R;
          }
        }
      }
    }
    if (d && y) {
      smartMove(e, y);
    }
  }
}

function tryFallbackDump(e, r) {
  var t = e.store.getUsedCapacity(RESOURCE_ENERGY);
  if (t === 0) return false;
  var a = null;
  if (r.storage && r.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if ((r.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 5e3) a = r.storage;
  }
  if (!a && r.terminal && r.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) a = r.terminal;
  if (!a) {
    for (var o = 0; o < r.containers.length; o++) {
      if (r.containers[o].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        a = r.containers[o];
        break;
      }
    }
  }
  if (!a) return false;
  setAssignment(e, {
    type: "fallback_dump",
    taskId: a.id,
    targetId: a.id,
    amount: t,
    assignedTick: Game.time,
    extra: ""
  });
  e.memory.s = "delivering";
  sup_say(e, "📦");
  return true;
}

function tryStepAside(e, r) {
  var t = e.room.getTerrain();
  var a = [ TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT ];
  for (var o = a.length - 1; o > 0; o--) {
    var i = Math.random() * (o + 1) | 0;
    var n = a[o];
    a[o] = a[i];
    a[i] = n;
  }
  var s = [ 0, 1, 1, 1, 0, -1, -1, -1 ];
  var u = [ -1, -1, 0, 1, 1, 1, 0, -1 ];
  for (var l = 0; l < a.length; l++) {
    var c = a[l] - 1;
    var m = e.pos.x + s[c], p = e.pos.y + u[c];
    if (m <= 0 || m >= 49 || p <= 0 || p >= 49) continue;
    if (t.get(m, p) === TERRAIN_MASK_WALL) continue;
    if (e.room.lookForAt(LOOK_CREEPS, m, p).length > 0) continue;
    var f = e.room.lookForAt(LOOK_STRUCTURES, m, p);
    var g = false;
    for (var d = 0; d < f.length; d++) {
      if (f[d].structureType !== STRUCTURE_ROAD && f[d].structureType !== STRUCTURE_CONTAINER) {
        g = true;
        break;
      }
    }
    if (g) continue;
    r.lastTriedMoveTick = Game.time;
    e.move(a[l]);
    return true;
  }
  return false;
}

//  MAIN RUN
var roleSupplier = {
  run: function(e) {
    if (!SUPPLIER_ENABLED) return;
    pruneHeap();
    var r = getHeap(e.name);
    if (e.memory.s === "idle" && e.memory.sl && Game.time < e.memory.sl) {
      return;
    }
    if (e.ticksToLive < 100) {
      if (e.store.getUsedCapacity() > 0) {
        var t = Object.keys(e.store)[0] || RESOURCE_ENERGY;
        var a = e.room.storage || e.room.terminal;
        if (a) {
          if (e.transfer(a, t) === ERR_NOT_IN_RANGE) smartMove(e, a);
        } else {
          e.drop(t);
        }
        return;
      }
      e.suicide();
      return;
    }
    pruneAvoids(r);
    if (!e.memory.s) e.memory.s = "idle";
    var o = e.memory.assignedRoom;
    var i = e.memory.homeRoom;
    var n = isValidRoomName(o) ? o : isValidRoomName(i) ? i : e.room.name;
    if (o !== n) e.memory.assignedRoom = n;
    if (!isValidRoomName(i)) e.memory.homeRoom = n;
    if (n && e.room.name !== n) {
      delete e.memory._move;
      var s = e.room.findExitTo(n);
      if (s > 0) {
        var u = e.pos.findClosestByRange(s);
        if (u) {
          r.lastTriedMoveTick = Game.time;
          e.moveTo(u, {
            reusePath: 5,
            maxOps: 500
          });
        }
      }
      return;
    }
    if (r.lastPos) {
      var l = e.pos.x !== r.lastPos.x || e.pos.y !== r.lastPos.y || e.room.name !== r.lastPos.rn;
      if (l) {
        r.stuckCount = 0;
        r.lastMovedTick = Game.time;
      } else if (e.fatigue === 0 && r.lastTriedMoveTick === Game.time - 1) {
        r.stuckCount++;
      }
    } else {
      r.stuckCount = 0;
    }
    r.lastPos = {
      x: e.pos.x,
      y: e.pos.y,
      rn: e.room.name
    };
    if (r.stuckCount >= 2) {
      var c = true;
      var m = getAssignment(e);
      if (m) {
        var p = e.memory.s === "delivering" ? Game.getObjectById(m.targetId || m.taskId) : isWithdrawTask(m.type) ? Game.getObjectById(m.taskId) : null;
        if (p && cheb(e.pos, p.pos) <= 1) c = false;
      }
      if (c) {
        tryStepAside(e, r);
        r.rerouteUntil = Math.max(Game.time + 5, r.rerouteUntil || 0);
        delete e.memory._move;
      }
      r.stuckCount = 0;
    }
    if (r.rerouteUntil && Game.time >= r.rerouteUntil) r.rerouteUntil = 0;
    var f = getRoomView(e.room);
    if (!f) return;
    recoverFactoryInputAssignment(e, f);
    var g = null;
    var d = Object.keys(e.store);
    for (var y = 0; y < d.length; y++) {
      if (d[y] !== RESOURCE_ENERGY && e.store[d[y]] > 0) {
        g = d[y];
        break;
      }
    }
    if (g) {
      var v = getAssignment(e);
      if (!v) {
        var R = null;
        if (f.storage && f.storage.store.getFreeCapacity(g) > 0) R = f.storage; else if (f.terminal && f.terminal.store.getFreeCapacity(g) > 0) R = f.terminal;
        if (R) {
          if (cheb(e.pos, R.pos) > 1) {
            smartMove(e, R);
            return;
          }
          delete e.memory._move;
          e.transfer(R, g);
          return;
        }
        return;
      }
    }
    var E = getAssignment(e);
    if (E && isPowerUpgradeTask(E.type) && !isPowerUpgradeActive(f.roomName)) {
      clearAssignment(e, "power upgrade inactive", false);
      E = null;
    }
    if (deliveryNoProgressWatchdog(e, E, r)) return;
    if (cleanupCargoForTask(e, E)) return;
    var _ = E;
    if (_ && _.assignedTick && Game.time - _.assignedTick > ASSIGNMENT_TTL) {
      var h = Game.time - (_.startedTick || _.assignedTick);
      var T = r.lastMovedTick && Game.time - r.lastMovedTick <= 2;
      if (T && h <= MAX_TRAVEL_WITHOUT_ACTION) {
        refreshProgress(e, _);
      } else {
        clearAssignment(e, "TTL", true);
        _ = null;
      }
    }
    if (_ && _.assignedTick !== Game.time && isAssignmentDone(e, f, _, r)) {
      clearAssignment(e, "done", true);
      _ = null;
    }
    if (isLowTtlWinddown(e) && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      if (_ && _.type !== "extension" && _.type !== "spawn" && _.type !== "tower") {
        clearAssignment(e, "low-ttl switch to ext/spawn/tower", false);
        _ = null;
      }
      if (!_) e.memory._windDownPick = Game.time;
    }
    if (!_ || e.memory.s === "idle") {
      if (_ && e.memory.s === "idle" && e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (tryFallbackDump(e, f)) return;
      }
      delete e.memory.sl;
      if (!pickTask(e, f, r)) return;
      _ = getAssignment(e);
      if (!_) return;
      if (cleanupCargoForTask(e, _)) return;
    }
    var k = e.memory.s === "delivering";
    if (e.memory.s === "fetching") {
      executeFetch(e, _, f, r);
    } else if (e.memory.s === "delivering") {
      executeDeliver(e, _, f, r);
    } else {
      var C = getPowerUpgradeResource(_) || RESOURCE_ENERGY;
      e.memory.s = e.store.getUsedCapacity(C) > 0 ? "delivering" : "fetching";
    }
    var b = getAssignment(e);
    if (k && e.memory.s === "fetching" && b && !e.store.getUsedCapacity()) {
      if (shouldReprioritize(e, f, r, b)) {
        clearAssignment(e, "reprioritize at fetch boundary", false);
        _ = null;
        e.memory.s = "idle";
      }
    }
    //    is spent but the move intent is still free. Pick a new task and
    //    start executing it so we don't waste the move. ──────────────────
        if (e.memory.s === "idle" && !getAssignment(e)) {
      if (pickTask(e, f, r)) {
        _ = getAssignment(e);
        if (_) {
          if (cleanupCargoForTask(e, _)) return;
          if (e.memory.s === "fetching") {
            executeFetch(e, _, f, r);
          } else if (e.memory.s === "delivering") {
            executeDeliver(e, _, f, r);
          }
        }
      }
    }
  }
};
module.exports = roleSupplier;
