// LLM: Read docs/codex.js before reviewing or changing this file.
// roleRemoteSupplier.js
// Role dispatch: memory.role === 'remoteSupplier' -> roleRemoteSupplier.run(creep).
// Example: require('roleRemoteSupplier').run(creep);
// Example: require('roleRemoteSupplier').run(creep);
//   'extensions'  Load full carry from homeRoom, travel to targetRoom,
//                 fill extensions then spawns. Any leftover energy is
//                 dumped into storage if present.
//   'storage'     Load memory.amountNeeded energy when set (otherwise fill carry
//                 capacity) from homeRoom, travel to targetRoom, deposit
//                 into storage until it reaches 7500 or creep is empty.
var util = require("util");
var getRoomState = require("getRoomState");
var scanner = require("scanner");
var STORAGE_TARGET = 7500;
var OBSERVER_RANGE = 10;
var MAX_RECOMPUTES = 5;
var SCAN_TIMEOUT = 60;
var SCAN_HOLD_TICKS = 15;
var ROUTE_CACHE_TTL = 1500;
function _structuresByType(e, r) {
  if (!e) return [];
  var t = getRoomState.get(e.name);
  if (t && t.structuresByType && t.structuresByType[r]) {
    return t.structuresByType[r];
  }
  return [];
}

function _filterEnergyStore(e, r) {
  var t = [];
  for (var o = 0; o < e.length; o++) {
    var a = e[o];
    if (!a || !a.store) continue;
    if (r) {
      if (a.store.getFreeCapacity(RESOURCE_ENERGY) > 0) t.push(a);
    } else if (a.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      t.push(a);
    }
  }
  return t;
}

module.exports = {
  run: function(e) {
    var r = e.memory.mission || "extensions";
    if (e.memory.working && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.memory.working = false;
      e.say("🏠");
      _clearExitCache(e);
    }
    if (!e.memory.working && e.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && e.room.name === e.memory.homeRoom) {
      e.memory.working = true;
      e.say(r === "storage" ? "📦" : "🔌");
      _clearExitCache(e);
    }
    if (!e.memory.working && r === "storage" && e.memory.amountNeeded) {
      var t = e.store.getUsedCapacity(RESOURCE_ENERGY);
      var o = Math.min(e.store.getCapacity(RESOURCE_ENERGY), e.memory.amountNeeded);
      if (t >= o) {
        e.memory.working = true;
        e.say("📦");
        _clearExitCache(e);
      }
    }
    if (e.memory.working) {
      if (r === "storage") {
        this._fillStorage(e);
      } else {
        this._fillExtensions(e);
      }
    } else {
      this._loadEnergy(e, r);
    }
  },
  _loadEnergy: function(e, r) {
    var t = e.memory.homeRoom;
    if (e.room.name !== t) {
      _followRoute(e, t);
      return;
    }
    var o = e.room;
    var a = null;
    if (o.storage && o.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      a = o.storage;
    } else if (o.terminal && o.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 5e3) {
      a = o.terminal;
    } else {
      var n = _filterEnergyStore(_structuresByType(o, STRUCTURE_CONTAINER), false);
      if (n.length > 0) {
        a = e.pos.findClosestByRange(n);
      }
    }
    if (!a) {
      if (Game.time % 20 === 0) {
        console.log("[RemoteSupplier] " + e.name + ": No energy source in " + t);
      }
      return;
    }
    var i = undefined;
    if (r === "storage" && e.memory.amountNeeded) {
      var m = e.store.getUsedCapacity(RESOURCE_ENERGY);
      var l = Math.min(e.store.getFreeCapacity(RESOURCE_ENERGY), e.memory.amountNeeded - m);
      if (l <= 0) {
        e.memory.working = true;
        return;
      }
      i = l;
    }
    var s = i !== undefined ? e.withdraw(a, RESOURCE_ENERGY, i) : e.withdraw(a, RESOURCE_ENERGY);
    if (s === ERR_NOT_IN_RANGE) {
      e.moveTo(a, {
        reusePath: 10,
        visualizePathStyle: {
          stroke: "#aaffaa"
        }
      });
    }
  },
  _fillExtensions: function(e) {
    if (e.room.name !== e.memory.targetRoom) {
      _followRoute(e, e.memory.targetRoom);
      return;
    }
    var r = _filterEnergyStore(_structuresByType(e.room, STRUCTURE_EXTENSION), true);
    var t = null;
    if (r.length > 0) {
      t = e.pos.findClosestByRange(r);
    } else {
      var o = _filterEnergyStore(_structuresByType(e.room, STRUCTURE_SPAWN), true);
      if (o.length > 0) t = e.pos.findClosestByRange(o);
    }
    if (!t) {
      var a = _filterEnergyStore(_structuresByType(e.room, STRUCTURE_STORAGE), true);
      if (a.length > 0) {
        var n = e.transfer(a[0], RESOURCE_ENERGY);
        if (n === ERR_NOT_IN_RANGE) e.moveTo(a[0], {
          reusePath: 5
        });
        return;
      }
      e.memory.working = false;
      e.say("✅");
      this._signalComplete(e, "extensions");
      return;
    }
    var i = e.transfer(t, RESOURCE_ENERGY);
    if (i === ERR_NOT_IN_RANGE) {
      e.moveTo(t, {
        reusePath: 5,
        visualizePathStyle: {
          stroke: "#ffaaaa"
        }
      });
    }
  },
  _fillStorage: function(e) {
    if (e.room.name !== e.memory.targetRoom) {
      _followRoute(e, e.memory.targetRoom);
      return;
    }
    var r = _filterEnergyStore(_structuresByType(e.room, STRUCTURE_STORAGE), true);
    if (r.length === 0) {
      e.memory.working = false;
      e.say("✅");
      this._signalComplete(e, "storage");
      return;
    }
    var t = r[0];
    var o = t.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (o >= STORAGE_TARGET) {
      e.memory.working = false;
      e.say("✅");
      this._signalComplete(e, "storage");
      return;
    }
    var a = STORAGE_TARGET - o;
    var n = e.store.getUsedCapacity(RESOURCE_ENERGY);
    var i = Math.min(n, a);
    if (i <= 0) {
      e.memory.working = false;
      this._signalComplete(e, "storage");
      return;
    }
    var m = e.transfer(t, RESOURCE_ENERGY, i);
    if (m === ERR_NOT_IN_RANGE) {
      e.moveTo(t, {
        reusePath: 10,
        visualizePathStyle: {
          stroke: "#aaaaff"
        }
      });
    } else if (m === OK && n - i <= 0) {
      e.memory.working = false;
      e.say("✅");
      this._signalComplete(e, "storage");
    } else if (m !== OK) {
      console.log("[RemoteSupplier] " + e.name + ": transfer to storage returned " + m);
    }
  },
  _signalComplete: function(e, r) {
    if (!Memory.remoteSupplyComplete) Memory.remoteSupplyComplete = {};
    var t = e.memory.homeRoom + "->" + e.memory.targetRoom + ":" + r;
    Memory.remoteSupplyComplete[t] = {
      homeRoom: e.memory.homeRoom,
      targetRoom: e.memory.targetRoom,
      mission: r,
      completedAt: Game.time
    };
  }
};
//   phase:        'idle' | 'pending' | 'ready' | 'failed'
//   route:        string[]   homeRoom -> targetRoom
//   routeBack:    string[]   targetRoom -> homeRoom
//   toScan:       string[]   rooms still needing observer scan + traversal check
//   pending:      { room, requestedTick } | null
//   blocked:      string[]   rooms confirmed impassable
//   attempts:     number     recompute count
function _routeStateKey(e) {
  return (e.memory.homeRoom || "?") + "->" + (e.memory.targetRoom || "?") + ":" + (e.memory.mission || "extensions");
}

function _getRouteState(e) {
  if (!Memory.remoteSupplierRoutes) Memory.remoteSupplierRoutes = {};
  var r = _routeStateKey(e);
  var t = e.memory._rs;
  var o = Memory.remoteSupplierRoutes[r];
  if (o && o.lastUsed && Game.time - o.lastUsed > ROUTE_CACHE_TTL) {
    delete Memory.remoteSupplierRoutes[r];
    o = null;
  }
  if (!o) {
    o = Memory.remoteSupplierRoutes[r] = {
      phase: "idle",
      route: null,
      routeBack: null,
      toScan: [],
      pending: null,
      blocked: [],
      attempts: 0
    };
  }
  o.lastUsed = Game.time;
  if (t && t !== o && t.route && !o.route) {
    o.phase = t.phase || "idle";
    o.route = t.route || null;
    o.routeBack = t.routeBack || (t.route ? t.route.slice().reverse() : null);
    o.toScan = t.toScan || [];
    o.pending = t.pending || null;
    o.blocked = t.blocked || [];
    o.attempts = t.attempts || 0;
  }
  e.memory._rs = {
    key: r
  };
  return o;
}

function _resetRouteState(e) {
  var r = _routeStateKey(e);
  if (Memory.remoteSupplierRoutes) delete Memory.remoteSupplierRoutes[r];
  delete e.memory._rs;
}

function _tickRouteState(e) {
  var r = _getRouteState(e);
  if (r.phase === "idle") {
    _initRoute(e, r);
    return;
  }
  if (r.phase === "pending") {
    _scanTick(e, r);
    return;
  }
}

function _initRoute(e, r) {
  var t = e.memory.homeRoom;
  var o = e.memory.targetRoom;
  if (!t || !o) {
    r.phase = "failed";
    return;
  }
  var a = _computeRoute(t, o, r.blocked);
  if (!a) {
    console.log("[RemoteSupplier] " + e.name + ": findRoute failed " + t + " -> " + o + ". Marking failed.");
    r.phase = "failed";
    return;
  }
  r.route = a;
  r.routeBack = a.slice().reverse();
  r.toScan = [];
  for (var n = 1; n < a.length - 1; n++) {
    var i = a[n];
    var m = Game.rooms[i];
    var l = m && m.controller && m.controller.my;
    if (!l) r.toScan.push(i);
  }
  if (r.toScan.length === 0) {
    r.phase = "ready";
    console.log("[RemoteSupplier] " + e.name + ": route ready (all rooms owned): " + a.join(" -> "));
    return;
  }
  r.phase = "pending";
  r.pending = null;
  console.log("[RemoteSupplier] " + e.name + ": route computed, scanning " + r.toScan.length + " room(s): " + a.join(" -> "));
}

function _scanTick(e, r) {
  if (r.pending) {
    var t = r.pending.room;
    var o = Game.rooms[t];
    var a = "remoteSupplier:" + e.name;
    if (o) {
      scanner.observe.consume(t, a);
      var n = r.route.indexOf(t);
      var i = n > 0 ? r.route[n - 1] : null;
      var m = n < r.route.length - 1 ? r.route[n + 1] : null;
      var l = i && m ? _checkRoomTraversal(t, i, m) : true;
      if (l) {
        var s = r.toScan.indexOf(t);
        if (s !== -1) r.toScan.splice(s, 1);
        r.pending = null;
      } else {
        console.log("[RemoteSupplier] " + e.name + ": room " + t + " failed traversal check. Recomputing route.");
        r.blocked.push(t);
        r.pending = null;
        r.attempts++;
        if (r.attempts > MAX_RECOMPUTES) {
          console.log("[RemoteSupplier] " + e.name + ": exhausted recompute attempts. Route failed.");
          r.phase = "failed";
          return;
        }
        _recomputeRoute(e, r);
        return;
      }
    } else if (Game.time - r.pending.requestedTick >= SCAN_TIMEOUT) {
      console.log("[RemoteSupplier] " + e.name + ": scan timeout for " + t + " — route validation failed.");
      scanner.observe.cancel(t, a);
      r.pending = null;
      r.phase = "failed";
      return;
    } else {
      scanner.observe.request(t, a, scanner.observe.PRI.MONITOR, {
        untilConsumed: true,
        holdTicks: SCAN_HOLD_TICKS
      });
      return;
    }
  }
  if (r.toScan.length === 0) {
    r.phase = "ready";
    console.log("[RemoteSupplier] " + e.name + ": route validated and ready: " + r.route.join(" -> "));
    return;
  }
  var u = r.toScan[0];
  if (Game.rooms[u]) {
    var f = r.route.indexOf(u);
    var R = f > 0 ? r.route[f - 1] : null;
    var c = f < r.route.length - 1 ? r.route[f + 1] : null;
    var p = R && c ? _checkRoomTraversal(u, R, c) : true;
    if (p) {
      r.toScan.shift();
    } else {
      console.log("[RemoteSupplier] " + e.name + ": room " + u + " (natural vision) failed traversal. Recomputing.");
      r.blocked.push(u);
      r.toScan.shift();
      r.attempts++;
      if (r.attempts > MAX_RECOMPUTES) {
        r.phase = "failed";
        return;
      }
      _recomputeRoute(e, r);
    }
    return;
  }
  var g = "remoteSupplier:" + e.name;
  if (!scanner.observe.request(u, g, scanner.observe.PRI.MONITOR, {
    untilConsumed: true,
    holdTicks: SCAN_HOLD_TICKS
  })) {
    console.log("[RemoteSupplier] " + e.name + ": no observer in range of " + u + " — route validation failed.");
    r.phase = "failed";
    return;
  }
  r.pending = {
    room: u,
    requestedTick: Game.time
  };
}

function _recomputeRoute(e, r) {
  var t = e.memory.homeRoom;
  var o = e.memory.targetRoom;
  var a = _computeRoute(t, o, r.blocked);
  if (!a) {
    console.log("[RemoteSupplier] " + e.name + ": no alternative route avoiding " + r.blocked.join(", "));
    r.phase = "failed";
    return;
  }
  r.route = a;
  r.routeBack = a.slice().reverse();
  var n = {};
  for (var i = 0; i < r.toScan.length; i++) {
    n[r.toScan[i]] = true;
  }
  r.toScan = [];
  for (var m = 1; m < a.length - 1; m++) {
    var l = a[m];
    var s = Game.rooms[l];
    var u = s && s.controller && s.controller.my;
    if (u) continue;
    if (r.blocked.indexOf(l) !== -1) continue;
    r.toScan.push(l);
  }
  r.pending = null;
  console.log("[RemoteSupplier] " + e.name + ": recomputed route (attempt " + r.attempts + "): " + a.join(" -> ") + " | scan queue: " + r.toScan.length + " room(s)");
  if (r.toScan.length === 0) {
    r.phase = "ready";
    console.log("[RemoteSupplier] " + e.name + ": recomputed route validated immediately.");
  }
}

function _computeRoute(e, r, t) {
  var o = {};
  if (t) {
    for (var a = 0; a < t.length; a++) {
      o[t[a]] = true;
    }
  }
  var n = Game.map.findRoute(e, r, {
    routeCallback: function(e) {
      if (o[e]) return Infinity;
      var r = Game.rooms[e];
      if (r && r.controller && r.controller.owner && !r.controller.my) {
        return Infinity;
      }
      return 1;
    }
  });
  if (!n || n === ERR_NO_PATH || n.length === 0) {
    n = Game.map.findRoute(e, r, {
      routeCallback: function(e) {
        return o[e] ? Infinity : 1;
      }
    });
  }
  if (!n || n === ERR_NO_PATH || n.length === 0) return null;
  var i = [ e ];
  for (var m = 0; m < n.length; m++) {
    i.push(n[m].room);
  }
  return i;
}

function _followRoute(e, r) {
  _tickRouteState(e);
  var t = _getRouteState(e);
  if (!t) return;
  if (t.phase === "failed") {
    if (Game.time % 20 === 0) {
      console.log("[RemoteSupplier] " + e.name + ": route failed — creep stuck. Consider cancelling order.");
    }
    return;
  }
  if (t.phase !== "ready") {
    if (Game.time % 10 === 0) {
      e.say("🔍");
    }
    return;
  }
  var o = r === e.memory.targetRoom;
  var a = o ? t.route : t.routeBack;
  var n = e.room.name;
  if (n === r) return;
  if (util.isOnRoomEdge(e.pos)) {
    e.moveTo(new RoomPosition(25, 25, n), {
      reusePath: 3,
      maxOps: 2e3,
      maxRooms: 1
    });
    return;
  }
  var i = -1;
  for (var m = 0; m < a.length; m++) {
    if (a[m] === n) {
      i = m;
      break;
    }
  }
  if (i === -1) {
    console.log("[RemoteSupplier] " + e.name + ": off route in " + n + ", resetting route state.");
    _resetRouteState(e);
    delete e.memory._exitCache;
    return;
  }
  var l = i + 1;
  if (l >= a.length) {
    e.moveTo(new RoomPosition(25, 25, r), {
      reusePath: 5
    });
    return;
  }
  var s = a[l];
  var u = e.memory._exitCache;
  if (!u || u.nextRoom !== s) {
    var f = Game.map.findExit(n, s);
    if (f < 0) {
      console.log("[RemoteSupplier] " + e.name + ": no exit from " + n + " to " + s + " — resetting route.");
      _resetRouteState(e);
      delete e.memory._exitCache;
      return;
    }
    var R = e.pos.findClosestByRange(f);
    if (!R) {
      e.moveTo(new RoomPosition(25, 25, r), {
        reusePath: 5
      });
      return;
    }
    e.memory._exitCache = {
      nextRoom: s,
      x: R.x,
      y: R.y
    };
    u = e.memory._exitCache;
  }
  e.moveTo(new RoomPosition(u.x, u.y, n), {
    reusePath: 20,
    maxOps: 2e3,
    maxRooms: 1,
    visualizePathStyle: {
      stroke: "#ffffff",
      opacity: .2
    }
  });
}

function _clearExitCache(e) {
  delete e.memory._exitCache;
}

var _getEntryDirection = util.getEntryDirection;
var _getEdgeGoals = util.getEdgeGoals;
function _pickRandomEdgeTile(e, r) {
  var t = util.edgeWalkableTiles(e, r);
  if (t.length === 0) return null;
  var o = t[Math.floor(t.length / 2)];
  return new RoomPosition(o.x, o.y, e);
}

function _buildRoomCostMatrix(e) {
  var r = new PathFinder.CostMatrix;
  var t = getRoomState.get(e);
  var o = t && t.structuresByType;
  if (!o) {
    var a = Game.rooms[e];
    if (!a) return r;
    var n = a.find(FIND_STRUCTURES);
    for (var i = 0; i < n.length; i++) {
      var m = n[i];
      if (m.structureType === STRUCTURE_WALL) {
        r.set(m.pos.x, m.pos.y, 255);
      } else if (m.structureType === STRUCTURE_RAMPART && !m.my && !m.isPublic) {
        r.set(m.pos.x, m.pos.y, 255);
      }
    }
    return r;
  }
  var l = o[STRUCTURE_WALL] || [];
  for (var s = 0; s < l.length; s++) {
    if (l[s]) r.set(l[s].pos.x, l[s].pos.y, 255);
  }
  var u = o[STRUCTURE_RAMPART] || [];
  for (var f = 0; f < u.length; f++) {
    var R = u[f];
    if (R && !R.my && !R.isPublic) r.set(R.pos.x, R.pos.y, 255);
  }
  return r;
}

function _checkRoomTraversal(e, r, t) {
  var o = _getEntryDirection(r, e);
  var a = Game.map.findExit(e, t);
  if (o < 0 || a < 0) return false;
  var n = _pickRandomEdgeTile(e, o);
  if (!n) return false;
  var i = _getEdgeGoals(e, a);
  if (i.length === 0) return false;
  var m = PathFinder.search(n, i, {
    plainCost: 2,
    swampCost: 10,
    maxOps: 4e3,
    maxRooms: 1,
    roomCallback: function(r) {
      if (r !== e) return false;
      return _buildRoomCostMatrix(r);
    }
  });
  return !m.incomplete;
}
