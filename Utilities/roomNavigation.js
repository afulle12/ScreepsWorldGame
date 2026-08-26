// LLM: Read docs/codex.js before reviewing or changing this file.
// roomNavigation.js
var util = require("util");
var iff = require("iff");
var DEFAULT_OBSERVER_RANGE = 10;
var DEFAULT_MAX_HIGHWAY_ROUTES = 16;
var DEFAULT_MATRIX_CACHE_TTL = 1;
var matrixCache = {
  tick: -1,
  entries: {}
};
var observerCache = {
  tick: -1,
  observers: []
};
var exitMatrixCache = {};
function normalizeRoomName(e) {
  return typeof e === "string" ? e.toUpperCase() : e;
}

function getRoomSectorType(e) {
  if (util.getRoomSectorType) return util.getRoomSectorType(e);
  var r = /^[WE](\d+)[NS](\d+)$/.exec(e || "");
  if (!r) return null;
  var t = parseInt(r[1], 10) % 10;
  var o = parseInt(r[2], 10) % 10;
  if (t === 0 && o === 0) return "intersection";
  if (t === 0 || o === 0) return "highway";
  if (t >= 4 && t <= 6 && o >= 4 && o <= 6) return "sourceKeeper";
  return null;
}

function isHighwayRoom(e) {
  var r = getRoomSectorType(e);
  return r === "highway" || r === "intersection";
}

function isSourceKeeperRoom(e) {
  return getRoomSectorType(e) === "sourceKeeper";
}

function isRoomAdjacentToHighway(e) {
  var r = /^[WE](\d+)[NS](\d+)$/.exec(e || "");
  if (!r) return false;
  var t = parseInt(r[1], 10) % 10;
  var o = parseInt(r[2], 10) % 10;
  return t === 1 || t === 9 || o === 1 || o === 9;
}

function areInSameSector(e, r) {
  var t = /^([WE])(\d+)([NS])(\d+)$/.exec(e || "");
  var o = /^([WE])(\d+)([NS])(\d+)$/.exec(r || "");
  if (!t || !o) return false;
  if (t[1] !== o[1] || t[3] !== o[3]) return false;
  return Math.floor(parseInt(t[2], 10) / 10) === Math.floor(parseInt(o[2], 10) / 10) && Math.floor(parseInt(t[4], 10) / 10) === Math.floor(parseInt(o[4], 10) / 10);
}

function getSectorName(e) {
  var r = /^([WE])(\d+)([NS])(\d+)$/.exec(e || "");
  if (!r) return null;
  return r[1] + Math.floor(parseInt(r[2], 10) / 10) * 10 + r[3] + Math.floor(parseInt(r[4], 10) / 10) * 10;
}

function exitKeyForDirection(e) {
  if (e === "N") return FIND_EXIT_TOP;
  if (e === "E") return FIND_EXIT_RIGHT;
  if (e === "S") return FIND_EXIT_BOTTOM;
  if (e === "W") return FIND_EXIT_LEFT;
  return -1;
}

function directionForExitKey(e) {
  if (String(e) === String(FIND_EXIT_TOP)) return "N";
  if (String(e) === String(FIND_EXIT_RIGHT)) return "E";
  if (String(e) === String(FIND_EXIT_BOTTOM)) return "S";
  if (String(e) === String(FIND_EXIT_LEFT)) return "W";
  return null;
}

function getOppositeEdge(e) {
  if (util.getOppositeEdge) return util.getOppositeEdge(e);
  var r = {
    N: "S",
    S: "N",
    E: "W",
    W: "E"
  };
  return r[e] || null;
}

function getRoomNeighbors(e) {
  var r = [];
  var t = Game.map.describeExits(e);
  if (!t) return r;
  for (var o in t) {
    var a = t[o];
    var n = directionForExitKey(o);
    if (a && n) r.push({
      room: a,
      direction: n
    });
  }
  return r;
}

function getAdjacentRoom(e, r) {
  var t = Game.map.describeExits(e);
  if (!t) return null;
  return t[exitKeyForDirection(r)] || null;
}

function getExitDirection(e, r) {
  var t = Game.map.describeExits(e);
  if (!t) return null;
  for (var o in t) {
    if (t[o] === r) return directionForExitKey(o);
  }
  return null;
}

function getEntryDirection(e, r) {
  var t = getExitDirection(e, r);
  return getOppositeEdge(t);
}

function areRoomsAdjacent(e, r) {
  if (!e || !r) return false;
  if (e === r) return true;
  return !!getExitDirection(e, r);
}

function roomManhattanDistance(e, r) {
  if (util.roomManhattanDistance) return util.roomManhattanDistance(e, r);
  var t = /^[WE](\d+)[NS](\d+)$/.exec(e || "");
  var o = /^[WE](\d+)[NS](\d+)$/.exec(r || "");
  if (!t || !o) return Infinity;
  return Math.abs(parseInt(t[1], 10) - parseInt(o[1], 10)) + Math.abs(parseInt(t[2], 10) - parseInt(o[2], 10));
}

function getPathNodeRoom(e) {
  return typeof e === "string" ? e : e && e.room;
}

function deduplicateRooms(e) {
  var r = {};
  var t = [];
  for (var o = 0; o < (e || []).length; o++) {
    var a = e[o] || [];
    for (var n = 0; n < a.length; n++) {
      var i = getPathNodeRoom(a[n]);
      if (i && !r[i]) {
        r[i] = true;
        t.push(i);
      }
    }
  }
  return t;
}

function getObservers(e) {
  e = e || {};
  var r = typeof e.minRcl === "number" ? e.minRcl : 8;
  var t = typeof e.range === "number" ? e.range : DEFAULT_OBSERVER_RANGE;
  if (observerCache.tick !== Game.time || observerCache.range !== t || observerCache.minRcl !== r) {
    observerCache = {
      tick: Game.time,
      range: t,
      minRcl: r,
      observers: []
    };
    for (var o in Game.rooms) {
      var a = Game.rooms[o];
      if (!a.controller || !a.controller.my || a.controller.level < r) continue;
      var n = a.find(FIND_MY_STRUCTURES, {
        filter: {
          structureType: STRUCTURE_OBSERVER
        }
      });
      for (var i = 0; i < n.length; i++) {
        observerCache.observers.push({
          observer: n[i],
          roomName: o
        });
      }
    }
  }
  return observerCache.observers;
}

function findObserverForRoom(e, r) {
  r = r || {};
  var t = typeof r.range === "number" ? r.range : DEFAULT_OBSERVER_RANGE;
  var o = getObservers(r);
  var a = null;
  for (var n = 0; n < o.length; n++) {
    var i = Game.map.getRoomLinearDistance(o[n].roomName, e);
    if (i > t) continue;
    if (!a || i < a.distance) {
      a = {
        observer: o[n].observer,
        roomName: o[n].roomName,
        distance: i
      };
    }
  }
  return a;
}

function getAllObservers(e) {
  var r = [];
  var t = getObservers(e);
  for (var o = 0; o < t.length; o++) {
    r.push({
      observer: t[o].observer,
      roomName: t[o].roomName
    });
  }
  return r;
}

function canAnyObserverReach(e, r) {
  return !!findObserverForRoom(e, r);
}

function isMyRoom(e) {
  var r = Game.rooms[e];
  return !!(r && r.controller && r.controller.my);
}

function checkRoomSafety(e, r) {
  r = r || {};
  if (!e) return {
    safe: false,
    reason: "no_vision"
  };
  if (e.controller && e.controller.my) return {
    safe: true,
    reason: "owned_by_us"
  };
  if (e.controller && e.controller.owner) {
    var t = e.controller.owner.username;
    var o = r.isFriendlyUsername ? r.isFriendlyUsername(t) : iff.isFriendlyUsername(t);
    if (!o) return {
      safe: false,
      reason: "owned_by_hostile_" + t
    };
    return {
      safe: true,
      reason: "owned_by_friendly_" + t
    };
  }
  if (e.controller && e.controller.reservation) {
    var a = e.controller.reservation.username;
    var n = r.isFriendlyUsername ? r.isFriendlyUsername(a) : iff.isFriendlyUsername(a);
    if (!n) {
      var i = e.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(e) {
          return e.structureType === STRUCTURE_TOWER;
        }
      });
      if (i.length > 0) {
        return {
          safe: false,
          reason: "hostile_towers_" + i.length
        };
      }
    }
  }
  var s = e.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_TOWER;
    }
  });
  if (s.length > 0) {
    return {
      safe: false,
      reason: "hostile_towers_" + s.length
    };
  }
  return {
    safe: true,
    reason: "unowned_no_threats"
  };
}

function getRoomFromArgument(e) {
  return typeof e === "string" ? Game.rooms[e] : e;
}

function cloneMatrix(e) {
  return e && typeof e.clone === "function" ? e.clone() : e;
}

function matrixOptionsKey(e) {
  return [ e.includeTerrain ? 1 : 0, e.blockObstacles ? 1 : 0, typeof e.roadCost === "number" ? e.roadCost : "", e.blockCreeps ? 1 : 0, e.selfId || "" ].join("|");
}

function buildCostMatrix(e, r) {
  r = r || {};
  var t = getRoomFromArgument(e);
  var o = t ? t.name : typeof e === "string" ? e : null;
  if (!o) return new PathFinder.CostMatrix;
  var a = typeof r.cacheTtl === "number" ? r.cacheTtl : DEFAULT_MATRIX_CACHE_TTL;
  var n = o + "|" + matrixOptionsKey(r);
  if (a > 0) {
    var i = matrixCache.entries[n];
    if (i && Game.time - i.tick < a) return cloneMatrix(i.matrix);
  }
  var s = new PathFinder.CostMatrix;
  if (t && r.includeTerrain) {
    var l = t.getTerrain();
    for (var u = 0; u < 50; u++) {
      for (var f = 0; f < 50; f++) {
        if (l.get(u, f) === TERRAIN_MASK_WALL) s.set(u, f, 255);
      }
    }
  }
  if (t) {
    var m = t.find(FIND_STRUCTURES);
    for (var c = 0; c < m.length; c++) {
      var v = m[c];
      if (v.structureType === STRUCTURE_ROAD && typeof r.roadCost === "number") {
        s.set(v.pos.x, v.pos.y, r.roadCost);
      } else if (v.structureType === STRUCTURE_WALL) {
        s.set(v.pos.x, v.pos.y, 255);
      } else if (v.structureType === STRUCTURE_RAMPART && !v.my && !v.isPublic) {
        s.set(v.pos.x, v.pos.y, 255);
      } else if (r.blockObstacles && OBSTACLE_OBJECT_TYPES.indexOf(v.structureType) !== -1) {
        s.set(v.pos.x, v.pos.y, 255);
      }
    }
    if (r.blockCreeps) {
      var R = t.find(FIND_CREEPS);
      for (var d = 0; d < R.length; d++) {
        if (R[d].id !== r.selfId) s.set(R[d].pos.x, R[d].pos.y, 255);
      }
    }
  }
  if (a > 0) {
    matrixCache.tick = Game.time;
    matrixCache.entries[n] = {
      tick: Game.time,
      matrix: s
    };
  }
  return cloneMatrix(s);
}

function buildExitConstrainedMatrix(e) {
  var r = exitMatrixCache[e];
  var t = roomNavigation._EXIT_MATRIX_TTL;
  if (r && Game.time - r.tick < t) return r.matrix;
  var o = buildCostMatrix(e, {
    includeTerrain: true,
    blockObstacles: false,
    cacheTtl: t
  });
  exitMatrixCache[e] = {
    tick: Game.time,
    matrix: o
  };
  return o;
}

function filterPassableTiles(e, r, t) {
  if (!e || !r || r.length === 0) return [];
  t = t || {};
  var o = e.getTerrain();
  var a = {};
  var n = e.find(FIND_STRUCTURES);
  for (var i = 0; i < n.length; i++) {
    var s = n[i];
    var l = s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic || t.blockObstacles && OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1;
    if (l) a[s.pos.x + ":" + s.pos.y] = true;
  }
  var u = [];
  for (var f = 0; f < r.length; f++) {
    var m = r[f];
    if (o.get(m.x, m.y) === TERRAIN_MASK_WALL) continue;
    if (a[m.x + ":" + m.y]) continue;
    u.push(m);
  }
  return u;
}

function getBlockedLookup(e, r) {
  r = r || {};
  var t = {};
  if (!e) return t;
  var o = e.find(FIND_STRUCTURES);
  for (var a = 0; a < o.length; a++) {
    var n = o[a];
    var i = n.structureType === STRUCTURE_WALL || n.structureType === STRUCTURE_RAMPART && !n.my && !n.isPublic || r.blockObstacles !== false && OBSTACLE_OBJECT_TYPES.indexOf(n.structureType) !== -1;
    if (i) t[n.pos.x + ":" + n.pos.y] = true;
  }
  return t;
}

function analyzeRoomEdges(e, r) {
  if (!e) return null;
  r = r || {};
  var t = e.getTerrain();
  var o = getBlockedLookup(e, r);
  var a = !!r.requireDepthOne;
  function walkable(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return false;
    if (t.get(e, r) === TERRAIN_MASK_WALL) return false;
    return !o[e + ":" + r];
  }
  var n = {
    N: {
      walkableTiles: [],
      totalWalkable: 0
    },
    S: {
      walkableTiles: [],
      totalWalkable: 0
    },
    E: {
      walkableTiles: [],
      totalWalkable: 0
    },
    W: {
      walkableTiles: [],
      totalWalkable: 0
    }
  };
  var i;
  var s;
  for (i = 1; i <= 48; i++) {
    if (walkable(i, 0) && (!a || walkable(i, 1))) n.N.walkableTiles.push(i);
    if (walkable(i, 49) && (!a || walkable(i, 48))) n.S.walkableTiles.push(i);
  }
  for (s = 1; s <= 48; s++) {
    if (walkable(49, s) && (!a || walkable(48, s))) n.E.walkableTiles.push(s);
    if (walkable(0, s) && (!a || walkable(1, s))) n.W.walkableTiles.push(s);
  }
  n.N.totalWalkable = n.N.walkableTiles.length;
  n.S.totalWalkable = n.S.walkableTiles.length;
  n.E.totalWalkable = n.E.walkableTiles.length;
  n.W.totalWalkable = n.W.walkableTiles.length;
  return n;
}

function analyzeApproachDepth(e) {
  if (!e) return null;
  var r = e.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic;
    }
  });
  if (r.length === 0) return {
    N: 50,
    S: 50,
    E: 50,
    W: 50
  };
  var t = {
    N: 50,
    S: 50,
    E: 50,
    W: 50
  };
  for (var o = 0; o < r.length; o++) {
    var a = r[o].pos;
    if (a.y < t.N) t.N = a.y;
    if (49 - a.y < t.S) t.S = 49 - a.y;
    if (a.x < t.W) t.W = a.x;
    if (49 - a.x < t.E) t.E = 49 - a.x;
  }
  return t;
}

function isPassableStart(e, r, t, o) {
  if (!r) return false;
  if (e) {
    var a = e.getTerrain();
    if (a.get(r.x, r.y) === TERRAIN_MASK_WALL) return false;
    if (filterPassableTiles(e, [ r ], {
      blockObstacles: !!(o && o.blockObstacles)
    }).length === 0) return false;
  }
  return !t || t.get(r.x, r.y) < 255;
}

function getPassableEntryTiles(e, r, t, o, a) {
  var n = [];
  if (e && typeof t === "number" && t >= 0) {
    n = e.find(t) || [];
  } else if (typeof util.edgeWalkableTiles === "function") {
    var i = util.edgeWalkableTiles(r, t);
    for (var s = 0; s < i.length; s++) {
      n.push(new RoomPosition(i[s].x, i[s].y, r));
    }
  }
  if (!e) return n;
  var l = filterPassableTiles(e, n, {
    blockObstacles: !!(a && a.blockObstacles)
  });
  var u = [];
  for (var f = 0; f < l.length; f++) {
    if (isPassableStart(e, l[f], o, a)) u.push(l[f]);
  }
  return u;
}

function getStartPosition(e, r, t, o, a) {
  a = a || {};
  var n = Game.rooms[e];
  var i = a.entryStrategy || "random";
  if (a.startPos) {
    return isPassableStart(n, a.startPos, o, a) ? a.startPos : null;
  }
  if (r && (typeof t !== "number" || t < 0)) return null;
  if (i === "center" || !r) {
    if (i !== "owned") {
      var s = new RoomPosition(25, 25, e);
      if (isPassableStart(n, s, o, a)) return s;
    }
  }
  if (i === "median" || i === "owned") {
    var l = getPassableEntryTiles(n, e, t, o, a);
    if (l.length > 0) {
      return l[Math.floor(l.length / 2)];
    }
  }
  if (i === "owned" && n) {
    var u = n.getTerrain();
    var f = n.find(FIND_MY_CREEPS);
    if (f.length > 0) return f[0].pos;
    var m = n.find(FIND_MY_SPAWNS);
    var c = [ [ 0, -1 ], [ 0, 1 ], [ -1, 0 ], [ 1, 0 ], [ -1, -1 ], [ 1, -1 ], [ -1, 1 ], [ 1, 1 ] ];
    for (var v = 0; v < m.length; v++) {
      for (var R = 0; R < c.length; R++) {
        var d = m[v].pos.x + c[R][0];
        var g = m[v].pos.y + c[R][1];
        if (d < 1 || d > 48 || g < 1 || g > 48) continue;
        if (u.get(d, g) !== TERRAIN_MASK_WALL && o.get(d, g) < 255) {
          return new RoomPosition(d, g, e);
        }
      }
    }
    for (var h = 1; h <= 48; h++) {
      for (var p = 1; p <= 48; p++) {
        if (u.get(h, p) !== TERRAIN_MASK_WALL && o.get(h, p) < 255) {
          return new RoomPosition(h, p, e);
        }
      }
    }
  }
  if (i === "random") {
    var b = getPassableEntryTiles(n, e, t, o, a);
    if (b.length > 0) {
      return b[Math.floor(Math.random() * b.length)];
    }
  }
  if (n && typeof t === "number" && t >= 0) {
    var y = getPassableEntryTiles(n, e, t, o, a);
    if (y.length > 0) return y[Math.floor(y.length / 2)];
  }
  if (!r && n) {
    for (var d = 1; d <= 48; d++) {
      for (var g = 1; g <= 48; g++) {
        var T = new RoomPosition(d, g, e);
        if (isPassableStart(n, T, o, a)) return T;
      }
    }
  }
  return null;
}

function checkRoomTraversal(e, r, t, o) {
  o = o || {};
  var a = typeof util.getEntryDirection === "function" ? util.getEntryDirection(r, e) : exitKeyForDirection(getEntryDirection(r, e));
  var n = Game.map.findExit(e, t);
  if (a < 0 || n === ERR_NO_PATH || n === ERR_INVALID_ARGS) {
    return o.returnResult ? {
      passable: false,
      incomplete: true,
      reason: "invalid_exit"
    } : false;
  }
  var i = buildCostMatrix(e, {
    blockObstacles: !!o.blockObstacles,
    roadCost: o.roadCost,
    blockCreeps: !!o.blockCreeps,
    selfId: o.selfId,
    cacheTtl: o.cacheTtl
  });
  var s = getStartPosition(e, r, a, i, o);
  if (!s) return o.returnResult ? {
    passable: false,
    incomplete: true,
    reason: "no_entry_tile"
  } : false;
  var l = typeof util.getEdgeGoals === "function" ? util.getEdgeGoals(e, n) : [];
  if (l.length === 0) return o.returnResult ? {
    passable: false,
    incomplete: true,
    reason: "no_exit_tiles"
  } : false;
  var u = PathFinder.search(s, l, {
    plainCost: typeof o.plainCost === "number" ? o.plainCost : 2,
    swampCost: typeof o.swampCost === "number" ? o.swampCost : 2,
    maxOps: typeof o.maxOps === "number" ? o.maxOps : 4e3,
    maxRooms: 1,
    roomCallback: function(r) {
      return r === e ? i : false;
    }
  });
  if (o.returnResult) {
    return {
      passable: !u.incomplete,
      incomplete: !!u.incomplete,
      result: u
    };
  }
  return !u.incomplete;
}

function checkRoomPassability(e, r, t, o) {
  o = o || {};
  if (!e) return {
    passable: false,
    reason: "no_vision",
    availableExits: []
  };
  var a = r ? Game.map.findExit(e.name, r) : -1;
  var n = t ? Game.map.findExit(e.name, t) : -1;
  if (t && (n === ERR_NO_PATH || n === ERR_INVALID_ARGS)) {
    return {
      passable: false,
      reason: "no_exit_to_" + t,
      availableExits: []
    };
  }
  var i = buildCostMatrix(e, {
    blockObstacles: o.blockObstacles !== false,
    roadCost: o.roadCost,
    blockCreeps: !!o.blockCreeps,
    selfId: o.selfId,
    cacheTtl: o.cacheTtl
  });
  if (r && (a === ERR_NO_PATH || a === ERR_INVALID_ARGS || a < 0)) {
    return {
      passable: false,
      reason: "no_entry_from_" + r,
      availableExits: []
    };
  }
  var s = {
    entryStrategy: r ? o.entryStrategy || "median" : o.entryStrategy || "center",
    startPos: o.startPos,
    blockObstacles: o.blockObstacles !== false
  };
  if (!r && o.ownedStart) s.entryStrategy = "owned";
  var l = getStartPosition(e.name, r, a, i, s);
  if (!l) return {
    passable: false,
    reason: "no_start_tile",
    availableExits: []
  };
  var u = [ FIND_EXIT_TOP, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT, FIND_EXIT_RIGHT ];
  var f = [ "N", "S", "W", "E" ];
  var m = [];
  var c = false;
  for (var v = 0; v < u.length; v++) {
    var R = e.find(u[v]);
    if (R.length === 0) continue;
    var d = [];
    for (var g = 0; g < R.length; g++) d.push({
      pos: R[g],
      range: 0
    });
    var h = PathFinder.search(l, d, {
      plainCost: typeof o.plainCost === "number" ? o.plainCost : 2,
      swampCost: typeof o.swampCost === "number" ? o.swampCost : 10,
      maxRooms: 1,
      maxOps: typeof o.maxOps === "number" ? o.maxOps : 5e3,
      roomCallback: function(r) {
        return r === e.name ? i : false;
      }
    });
    if (!h.incomplete) {
      m.push(f[v]);
      if (u[v] === n) c = true;
    }
  }
  if (!t && m.length > 0) {
    return {
      passable: true,
      reason: "any_exit_passable",
      availableExits: m
    };
  }
  if (c) return {
    passable: true,
    reason: "ok",
    availableExits: m
  };
  if (m.length > 0) {
    return {
      passable: false,
      reason: "intended_path_blocked",
      availableExits: m,
      partiallyPassable: true
    };
  }
  return {
    passable: false,
    reason: "all_exits_blocked",
    availableExits: []
  };
}

function checkTransitPassability(e, r, t, o) {
  o = o || {};
  var a = {};
  if (!e || !r) return a;
  t = t || [];
  var n = [ "N", "S", "E", "W" ];
  var i = buildCostMatrix(e, {
    blockObstacles: o.blockObstacles !== false,
    roadCost: o.roadCost,
    cacheTtl: o.cacheTtl
  });
  for (var s = 0; s < n.length; s++) {
    for (var l = 0; l < n.length; l++) {
      if (s === l) continue;
      var u = n[s];
      var f = n[l];
      var m = u + "->" + f;
      if (t.indexOf(u) !== -1 || t.indexOf(f) !== -1) {
        a[m] = false;
        continue;
      }
      var c = r[u].walkableTiles || [];
      var v = r[f].walkableTiles || [];
      if (c.length === 0 || v.length === 0) {
        a[m] = false;
        continue;
      }
      var R = [ 0 ];
      if (c.length > 1) R.push(c.length - 1);
      if (c.length > 2) R.push(Math.floor(c.length / 2));
      if (c.length > 4) {
        R.push(Math.floor(c.length / 4));
        R.push(Math.floor(c.length * 3 / 4));
      }
      var d = exitKeyForDirection(f);
      var g = e.find(d);
      var h = [];
      for (var p = 0; p < g.length; p++) h.push({
        pos: g[p],
        range: 0
      });
      var b = false;
      for (var y = 0; y < R.length && !b; y++) {
        var T = c[R[y]];
        var E;
        if (u === "N") E = new RoomPosition(T, 0, e.name); else if (u === "S") E = new RoomPosition(T, 49, e.name); else if (u === "E") E = new RoomPosition(49, T, e.name); else E = new RoomPosition(0, T, e.name);
        var x = PathFinder.search(E, h, {
          plainCost: typeof o.plainCost === "number" ? o.plainCost : 2,
          swampCost: typeof o.swampCost === "number" ? o.swampCost : 10,
          maxRooms: 1,
          maxOps: typeof o.maxOps === "number" ? o.maxOps : 3e3,
          roomCallback: function() {
            return i;
          }
        });
        if (!x.incomplete) b = true;
      }
      a[m] = b;
    }
  }
  return a;
}

function requestObserverScan(e, r) {
  if (typeof r === "function") return r(e);
  if (r && typeof r.request === "function") return r.request(e);
  return false;
}

function routeOptionsFromLegacyArgs(e, r) {
  if (e && !Array.isArray(e) && typeof e === "object") return e;
  return {
    bannedRooms: e || [],
    allowedRooms: r || []
  };
}

function isAllowedRoom(e, r) {
  var t = r.allowedRooms || [];
  for (var o = 0; o < t.length; o++) {
    if (normalizeRoomName(t[o]) === normalizeRoomName(e)) return true;
  }
  return false;
}

function findRawRoute(e, r, t) {
  t = t || {};
  e = normalizeRoomName(e);
  r = normalizeRoomName(r);
  if (e === r) return [];
  var o = t.bannedRooms || [];
  var a = t.blockedEdges || {};
  var n = t.roomStatus || {};
  var i = t.routeCallback;
  var s = Game.map.findRoute(e, r, {
    routeCallback: function(e, s) {
      e = normalizeRoomName(e);
      s = normalizeRoomName(s);
      if (o.indexOf(e) !== -1) return Infinity;
      if (a[s + ":" + e]) return Infinity;
      if (isAllowedRoom(e, t)) return 1;
      if (e === r && t.allowTarget === true) {
        if (i) return i(e, s);
        if (typeof t.routeCost === "function") return t.routeCost(e, s);
        return typeof t.targetCost === "number" ? t.targetCost : 1;
      }
      if (t.isCoverable && !t.isCoverable(e)) return Infinity;
      if (t.isRoomAllowed && !t.isRoomAllowed(e, s)) return Infinity;
      var l = n[e];
      if (l && (l.blocked === true || l.hostile === true) && t.allowBlockedRooms !== true) return Infinity;
      if (i) return i(e, s);
      if (typeof t.routeCost === "function") return t.routeCost(e, s);
      return 1;
    }
  });
  return s;
}

function findLinearRoute(e, r, t, o) {
  var a = routeOptionsFromLegacyArgs(t, o);
  if (normalizeRoomName(e) === normalizeRoomName(r)) {
    return [ normalizeRoomName(e) ];
  }
  var n = findRawRoute(e, r, a);
  if (n === ERR_NO_PATH || !Array.isArray(n) || n.length === 0) return null;
  return [ normalizeRoomName(e) ].concat(n.map(function(e) {
    return typeof e === "string" ? e : e.room;
  }));
}

function highwayRouteOptions(e) {
  e = e || {};
  return {
    bannedRooms: e.bannedRooms || [],
    allowedRooms: e.allowedRooms || [],
    blockedEdges: e.blockedEdges || {},
    isCoverable: e.isCoverable,
    isRoomAllowed: e.isRoomAllowed,
    allowTarget: e.allowTarget !== false,
    routeCost: function(r) {
      if (e.bannedRooms && e.bannedRooms.indexOf(r) !== -1) return Infinity;
      if (typeof e.roomCost === "function") return e.roomCost(r);
      var t = typeof e.highwayCost === "number" ? e.highwayCost : 1;
      var o = typeof e.interiorCost === "number" ? e.interiorCost : 2.5;
      return isHighwayRoom(r) ? t : o;
    }
  };
}

function highwayRouteCost(e, r, t) {
  t = t || {};
  if (e === r) return 0;
  var o = findRawRoute(e, r, highwayRouteOptions(t));
  if (!Array.isArray(o) || o.length === 0) return Infinity;
  var a = highwayRouteOptions(t);
  var n = 0;
  var i = e;
  for (var s = 0; s < o.length; s++) {
    var l = typeof o[s] === "string" ? o[s] : o[s].room;
    var u = a.routeCost(l, i);
    if (u === Infinity) return Infinity;
    n += u;
    i = l;
  }
  return n;
}

function findHighwayRoute(e, r, t) {
  var o = findRawRoute(e, r, highwayRouteOptions(t));
  if (!Array.isArray(o) || o.length === 0) return null;
  return [ normalizeRoomName(e) ].concat(o.map(function(e) {
    return typeof e === "string" ? e : e.room;
  }));
}

function calculateTotalPathLength(e, r, t, o) {
  o = o || {};
  var a = findRawRoute(e, r, o);
  if (!Array.isArray(a) || a === ERR_NO_PATH) return Infinity;
  return a.length + t;
}

function selectBestCrossSectorRoute(e, r, t, o) {
  o = o || {};
  if (!t || t.length === 0) return null;
  var a = null;
  for (var n = 0; n < t.length; n++) {
    var i = t[n];
    var s = i[i.length - 1];
    var l = getPathNodeRoom(s);
    var u = i.length - 1;
    var f = calculateTotalPathLength(e, l, u, {
      routeCost: o.routeCost,
      allowTarget: o.allowTarget === true
    });
    if (f === Infinity) continue;
    var m = null;
    var c = f;
    if (r && o.approachDepth) {
      var v = getPathNodeRoom(i[0]);
      var R = getExitDirection(v, r);
      m = R ? getOppositeEdge(R) : null;
      if (m && o.approachDepth[m] !== undefined) {
        c -= o.approachDepth[m] * (typeof o.approachBonus === "number" ? o.approachBonus : .5);
      }
    }
    if (!a || c < a.effectiveLength) {
      a = {
        path: i,
        highwayEntry: l,
        totalLength: f,
        effectiveLength: c,
        entryEdge: m
      };
    }
  }
  return a;
}

function bfsFindHighwayPaths(e, r, t, o) {
  o = o || {};
  if (typeof t !== "number") t = DEFAULT_MAX_HIGHWAY_ROUTES;
  var a = [];
  var n = {};
  var i = o.startEntryDir || null;
  var s = [ {
    room: e,
    path: [ {
      room: e,
      entryDir: i,
      exitDir: null
    } ]
  } ];
  n[e + "|" + (i || "")] = true;
  if (r) n[r + "|"] = true;
  if (e !== r && isHighwayRoom(e)) {
    a.push(s[0].path);
    if (a.length >= t) return a;
  }
  while (s.length > 0 && a.length < t) {
    var l = s.shift();
    var u = getRoomNeighbors(l.room);
    for (var f = 0; f < u.length; f++) {
      var m = u[f];
      var c = m.room;
      if (r && c === r) continue;
      var v = getOppositeEdge(m.direction);
      var R = c + "|" + (v || "");
      if (n[R]) continue;
      if (o.canReachRoom && !o.canReachRoom(c)) continue;
      if (o.isRoomAllowed && !o.isRoomAllowed(c, l.room)) continue;
      n[R] = true;
      var d = [];
      for (var g = 0; g < l.path.length; g++) {
        var h = l.path[g];
        if (g === l.path.length - 1) {
          d.push({
            room: h.room,
            entryDir: h.entryDir,
            exitDir: m.direction
          });
        } else {
          d.push(h);
        }
      }
      d.push({
        room: c,
        entryDir: v,
        exitDir: null
      });
      if (isHighwayRoom(c)) {
        a.push(d);
        if (a.length >= t) break;
      } else {
        s.push({
          room: c,
          path: d
        });
      }
    }
  }
  if (o.log) o.log("BFS found " + a.length + " paths from " + e);
  return a;
}

function invalidatePathsContainingRoom(e, r) {
  var t = [];
  var o = [];
  for (var a = 0; a < (e || []).length; a++) {
    var n = e[a];
    var i = false;
    for (var s = 0; s < n.length; s++) {
      if (getPathNodeRoom(n[s]) === r) {
        i = true;
        break;
      }
    }
    if (i) o.push(n); else t.push(n);
  }
  return {
    remaining: t,
    invalidated: o
  };
}

function invalidatePathsWithBlockedExit(e, r, t) {
  var o = [];
  var a = [];
  t = t || [];
  for (var n = 0; n < (e || []).length; n++) {
    var i = e[n];
    var s = false;
    for (var l = 0; l < i.length; l++) {
      var u = i[l];
      if (typeof u === "object" && u.room === r && (u.entryDir && t.indexOf(u.entryDir) !== -1 || u.exitDir && t.indexOf(u.exitDir) !== -1)) {
        s = true;
        break;
      }
    }
    if (s) a.push(i); else o.push(i);
  }
  return {
    remaining: o,
    invalidated: a
  };
}

function validateRouteTraversal(e, r) {
  r = r || {};
  var t = [];
  if (!Array.isArray(e) || e.length < 3) return t;
  var o = r.includeStart ? 0 : 1;
  var a = r.includeEnd ? e.length - 1 : e.length - 2;
  for (var n = o; n <= a; n++) {
    if (!checkRoomTraversal(e[n], e[n - 1], e[n + 1], r)) t.push(e[n]);
  }
  return t;
}

function validateRoomSequence(e) {
  if (!Array.isArray(e) || e.length < 2) return {
    valid: true
  };
  for (var r = 0; r < e.length - 1; r++) {
    if (!areRoomsAdjacent(e[r], e[r + 1])) {
      return {
        valid: false,
        breakIndex: r,
        from: e[r],
        to: e[r + 1]
      };
    }
  }
  return {
    valid: true
  };
}

function repairRoute(e, r, t) {
  if (!Array.isArray(e) || e.length < 2) return e;
  t = t || {};
  var o = [ e[0] ];
  for (var a = 0; a < e.length - 1; a++) {
    var n = e[a];
    var i = e[a + 1];
    if (areRoomsAdjacent(n, i)) {
      o.push(i);
      continue;
    }
    var s = findRawRoute(n, i, {
      allowTarget: true,
      targetCost: 1,
      routeCost: t.routeCost || function() {
        return 1;
      },
      bannedRooms: t.bannedRooms || []
    });
    if (!Array.isArray(s) || s.length === 0) return null;
    for (var l = 0; l < s.length; l++) {
      var u = typeof s[l] === "string" ? s[l] : s[l].room;
      if (u !== n && o[o.length - 1] !== u) o.push(u);
    }
  }
  return o;
}

function getRoomsNeedingScan(e, r) {
  r = r || {};
  var t = [];
  var o = r.roomStatus || {};
  var a = typeof r.now === "number" ? r.now : Game.time;
  var n = typeof r.cacheTicks === "number" ? r.cacheTicks : 0;
  for (var i = 0; i < (e || []).length; i++) {
    var s = getPathNodeRoom(e[i]);
    if (r.isOwnedRoom && r.isOwnedRoom(s)) continue;
    if (r.excludeTarget && s === r.targetRoom) continue;
    var l = o[s];
    var u = n === 0 ? !!l : !!(l && typeof l.lastScan === "number" && a - l.lastScan < n);
    if (!u) t.push(s);
  }
  return t;
}

function isOnIntendedExitEdge(e, r) {
  var t = typeof r === "number" ? directionForExitKey(r) : r;
  if (t === "N") return e.y === 0;
  if (t === "S") return e.y === 49;
  if (t === "E") return e.x === 49;
  if (t === "W") return e.x === 0;
  return false;
}

function roomsOrthogonallyAdjacent(e, r) {
  return areRoomsAdjacent(e, r) && e !== r;
}

function pickRecoveryRoom(e, r) {
  var t = null;
  var o = -1;
  for (var a = 0; a < r.length; a++) {
    if (roomsOrthogonallyAdjacent(e, r[a]) && a > o) {
      o = a;
      t = r[a];
    }
  }
  return t;
}

function pickNearestRouteRoom(e, r) {
  var t = null;
  var o = Infinity;
  var a = -1;
  for (var n = 0; n < r.length; n++) {
    var i = Game.map.getRoomLinearDistance(e, r[n]);
    if (typeof i !== "number") continue;
    if (i < o || i === o && n > a) {
      t = r[n];
      o = i;
      a = n;
    }
  }
  return t;
}

function getCachedExitTarget(e, r, t) {
  t = t || {};
  var o = t.exitTargetKey || "_exitTarget";
  var a = e.room.findExitTo(r);
  var n = e.memory[o];
  var i = a >= 0 ? e.room.find(a) : [];
  if (n && n.roomName === e.room.name && n.exitDir === a && (!n.nextRoom || n.nextRoom === r) && typeof n.x === "number" && typeof n.y === "number") {
    var s = new RoomPosition(n.x, n.y, e.room.name);
    var l = filterPassableTiles(e.room, [ s ], {
      blockObstacles: !!t.blockObstacles
    });
    var u = false;
    for (var f = 0; f < i.length; f++) {
      if (i[f].x === s.x && i[f].y === s.y) {
        u = true;
        break;
      }
    }
    if (u && l.length > 0) return s;
  }
  var m = filterPassableTiles(e.room, i, {
    blockObstacles: !!t.blockObstacles
  });
  if (m.length === 0) return null;
  var c = e.pos.findClosestByPath(m, {
    ignoreCreeps: t.ignoreCreeps === true,
    maxRooms: 1,
    maxOps: typeof t.maxOps === "number" ? t.maxOps : 2e3,
    costCallback: t.costCallback || function(r) {
      return r === e.room.name ? buildExitConstrainedMatrix(r) : false;
    }
  }) || e.pos.findClosestByRange(m);
  if (!c) return null;
  e.memory[o] = {
    x: c.x,
    y: c.y,
    roomName: e.room.name,
    exitDir: a,
    nextRoom: r
  };
  return c;
}

function findRoomExitPath(e, r, t) {
  t = t || {};
  var o = e.room.name;
  var a = e.room.findExitTo(r);
  if (a === ERR_NO_PATH || a === ERR_INVALID_ARGS || a < 0) {
    return {
      exitDir: a,
      result: null,
      path: []
    };
  }
  var n = e.room.find(a);
  if (n.length === 0) return {
    exitDir: a,
    result: null,
    path: []
  };
  var i = [];
  for (var s = 0; s < n.length; s++) i.push({
    pos: n[s],
    range: 0
  });
  var l = PathFinder.search(e.pos, i, {
    maxRooms: typeof t.maxRooms === "number" ? t.maxRooms : 1,
    maxOps: typeof t.maxOps === "number" ? t.maxOps : 2e3,
    plainCost: typeof t.plainCost === "number" ? t.plainCost : 2,
    swampCost: typeof t.swampCost === "number" ? t.swampCost : 10,
    roomCallback: function(r) {
      if (r !== o) return false;
      if (t.roomCallback) return t.roomCallback(r, e);
      return buildCostMatrix(o, {
        blockObstacles: true,
        roadCost: 1,
        blockCreeps: true,
        selfId: e.id,
        cacheTtl: 1
      });
    }
  });
  return {
    exitDir: a,
    result: l,
    path: l.path || []
  };
}

function moveResultOrOk(e) {
  return typeof e === "number" ? e : OK;
}

function followRoomRoute(e, r, t) {
  t = t || {};
  if (!Array.isArray(r) || r.length === 0) return ERR_NOT_FOUND;
  var o = r.map(getPathNodeRoom);
  var a = e.room.name;
  var n = t.goalRoom || o[o.length - 1];
  if (a === n) return OK;
  var i = o.indexOf(a);
  var s;
  if (i >= 0) {
    s = o[i + 1];
    if (!s) return OK;
    if (t.routeKey) e.memory[t.routeKey + "Index"] = i;
  } else {
    s = pickRecoveryRoom(a, o);
    if (!s) {
      var l = pickNearestRouteRoom(a, o);
      if (!l) return ERR_NOT_FOUND;
      if (!t.allowUnconstrainedRecovery) return ERR_NOT_FOUND;
      return moveResultOrOk(e.moveTo(new RoomPosition(25, 25, l), {
        reusePath: t.reusePath || 20
      }));
    }
  }
  var u = e.room.findExitTo(s);
  if (u === ERR_NO_PATH || u === ERR_INVALID_ARGS || u < 0) return ERR_NO_PATH;
  if (typeof util.isOnRoomEdge === "function" && util.isOnRoomEdge(e.pos) && !isOnIntendedExitEdge(e.pos, u)) {
    return moveResultOrOk(e.moveTo(new RoomPosition(25, 25, a), {
      maxRooms: 1,
      reusePath: 0
    }));
  }
  var f = getCachedExitTarget(e, s, t);
  if (!f) {
    if (!t.allowUnconstrainedRecovery) return ERR_NO_PATH;
    return moveResultOrOk(e.moveTo(new RoomPosition(25, 25, s), {
      reusePath: t.reusePath || 20,
      maxOps: t.maxOps || 2e3
    }));
  }
  var m = {
    reusePath: typeof t.reusePath === "number" ? t.reusePath : 20,
    maxOps: typeof t.maxOps === "number" ? t.maxOps : 2e3,
    maxRooms: 1
  };
  if (t.ignoreCreeps !== undefined) m.ignoreCreeps = t.ignoreCreeps;
  return moveResultOrOk(e.moveTo(f, m));
}

function validateEdgeLive(e, r) {
  var t = Game.rooms[e];
  if (!t) return true;
  var o = Game.map.findExit(e, r);
  if (o === ERR_NO_PATH || o === ERR_INVALID_ARGS) return false;
  var a = filterPassableTiles(t, t.find(o));
  return a.length > 0;
}

function validateCachedRoute(e, r, t, o) {
  var a = e.map(function(e) {
    return normalizeRoomName(getPathNodeRoom(e));
  });
  r = normalizeRoomName(r);
  t = normalizeRoomName(t);
  var n = a.indexOf(r);
  if (n < 0 || a[a.length - 1] !== t) return false;
  var i = o.roomStatus || {};
  var s = o.blockedEdges || {};
  for (var l = n; l < a.length; l++) {
    var u = a[l];
    var f = l > 0 ? a[l - 1] : null;
    if (o.bannedRooms && o.bannedRooms.indexOf(u) !== -1) return false;
    if (!isAllowedRoom(u, o)) {
      if (o.isCoverable && !o.isCoverable(u)) return false;
      if (o.isRoomAllowed && !o.isRoomAllowed(u, f)) return false;
      if (o.routeCallback && o.routeCallback(u, f) === Infinity) return false;
      var m = i[u];
      if (!m && o.requireRoomStatus) return false;
      if (m && (m.hostile === true || m.blocked === true)) return false;
    }
    if (l < a.length - 1) {
      if (!areRoomsAdjacent(u, a[l + 1])) return false;
      var c = u + ":" + a[l + 1];
      if (s[c]) return false;
      if (o.liveEdgeCheck !== false && Game.rooms[u] && !validateEdgeLive(u, a[l + 1])) return false;
    }
  }
  return true;
}

function ensureRoute(e, r, t, o, a, n, i) {
  var s = routeOptionsFromLegacyArgs(a, n);
  if (i) {
    for (var l in i) s[l] = i[l];
  }
  s.bannedRooms = s.bannedRooms || [];
  s.allowedRooms = s.allowedRooms || [];
  s.roomStatus = s.roomStatus || {};
  s.blockedEdges = s.blockedEdges || {};
  s.requireRoomStatus = s.requireRoomStatus !== false;
  r = normalizeRoomName(r);
  t = normalizeRoomName(t);
  var u = o + "Index";
  if (r === t) {
    e.memory[o] = [ r ];
    delete e.memory[u];
    return e.memory[o];
  }
  var f = e.memory[o];
  if (Array.isArray(f) && f.length > 0 && validateCachedRoute(f, r, t, s)) {
    e.memory[u] = f.map(getPathNodeRoom).indexOf(r);
    return f;
  }
  if (f) {
    delete e.memory[o];
    delete e.memory[u];
  }
  var m = findLinearRoute(r, t, s);
  if (!m || m.length === 0) return null;
  var c = {
    bannedRooms: s.bannedRooms,
    roomStatus: s.roomStatus,
    blockedEdges: s.blockedEdges,
    requireRoomStatus: s.requireRoomStatus,
    allowedRooms: s.allowedRooms,
    liveEdgeCheck: s.liveEdgeCheck,
    isCoverable: s.isCoverable,
    isRoomAllowed: s.isRoomAllowed
  };
  for (var v = 0; v < m.length; v++) {
    var R = m[v];
    if (c.bannedRooms.indexOf(R) !== -1) return null;
    if (!isAllowedRoom(R, c)) {
      if (c.isCoverable && !c.isCoverable(R)) return null;
      if (c.isRoomAllowed && !c.isRoomAllowed(R, v > 0 ? m[v - 1] : null)) return null;
      var d = c.roomStatus[R];
      if (!d) {
        if (s.onMissingVision) s.onMissingVision(R); else if (s.requestObserverScan) requestObserverScan(R, s.requestObserverScan);
        return null;
      }
      if (d.hostile === true || d.blocked === true) return null;
    }
    if (v < m.length - 1) {
      var g = R + ":" + m[v + 1];
      if (c.blockedEdges[g]) return null;
      if (s.liveEdgeCheck !== false && Game.rooms[R] && !validateEdgeLive(R, m[v + 1])) {
        c.blockedEdges[g] = true;
        return null;
      }
    }
  }
  e.memory[o] = m;
  e.memory[u] = 0;
  return m;
}

var roomNavigation = {
  DEBUG: false,
  _EXIT_MATRIX_TTL: 5,
  normalizeRoomName: normalizeRoomName,
  isHighwayRoom: isHighwayRoom,
  isSourceKeeperRoom: isSourceKeeperRoom,
  isRoomAdjacentToHighway: isRoomAdjacentToHighway,
  areInSameSector: areInSameSector,
  getSectorName: getSectorName,
  getRoomNeighbors: getRoomNeighbors,
  getAdjacentRoom: getAdjacentRoom,
  getExitDirection: getExitDirection,
  getEntryDirection: getEntryDirection,
  getOppositeEdge: getOppositeEdge,
  areRoomsAdjacent: areRoomsAdjacent,
  roomManhattanDistance: roomManhattanDistance,
  findObserverForRoom: findObserverForRoom,
  getAllObservers: getAllObservers,
  canAnyObserverReach: canAnyObserverReach,
  isMyRoom: isMyRoom,
  checkRoomSafety: checkRoomSafety,
  buildCostMatrix: buildCostMatrix,
  buildExitConstrainedMatrix: buildExitConstrainedMatrix,
  filterPassableTiles: filterPassableTiles,
  checkRoomTraversal: checkRoomTraversal,
  checkRoomPassability: checkRoomPassability,
  checkTransitPassability: checkTransitPassability,
  analyzeRoomEdges: analyzeRoomEdges,
  analyzeApproachDepth: analyzeApproachDepth,
  validateRouteTraversal: validateRouteTraversal,
  requestObserverScan: requestObserverScan,
  getRoomsNeedingScan: getRoomsNeedingScan,
  findRawRoute: findRawRoute,
  findLinearRoute: findLinearRoute,
  findHighwayRoute: findHighwayRoute,
  highwayRouteCost: highwayRouteCost,
  getRoomRouteCost: function(e, r, t) {
    if (typeof t === "string") t = {
      targetRoom: t
    };
    t = t || {};
    if (t.targetRoom && t.targetRoom === e && t.allowTarget !== false) return 1;
    if (r && r[e]) return Infinity;
    if (isHighwayRoom(e)) return 1;
    if (isSourceKeeperRoom(e)) return 2;
    var o = Game.rooms[e];
    var a = t.isFriendlyUsername || iff.isFriendlyUsername;
    if (o && o.controller) {
      if (o.controller.my) return 1;
      if (o.controller.owner) return a(o.controller.owner.username) ? 1 : Infinity;
      if (o.controller.reservation) return a(o.controller.reservation.username) ? 1 : 3;
    }
    var n = Memory.roomRegistry && Memory.roomRegistry.rooms && Memory.roomRegistry.rooms[e];
    if (n && n.o && Game.time - n.t <= 5e3) {
      return a(n.o) ? 1 : Infinity;
    }
    return 1.5;
  },
  bfsFindHighwayPaths: bfsFindHighwayPaths,
  deduplicateRooms: deduplicateRooms,
  getPathNodeRoom: getPathNodeRoom,
  calculateTotalPathLength: calculateTotalPathLength,
  selectBestCrossSectorRoute: selectBestCrossSectorRoute,
  invalidatePathsContainingRoom: invalidatePathsContainingRoom,
  invalidatePathsWithBlockedExit: invalidatePathsWithBlockedExit,
  validateRoomSequence: validateRoomSequence,
  repairRoute: repairRoute,
  isOnIntendedExitEdge: isOnIntendedExitEdge,
  pickRecoveryRoom: pickRecoveryRoom,
  pickNearestRouteRoom: pickNearestRouteRoom,
  getCachedExitTarget: getCachedExitTarget,
  validateEdgeLive: validateEdgeLive,
  findRoomExitPath: findRoomExitPath,
  followRoomRoute: followRoomRoute,
  ensureRoute: ensureRoute,
  _exitMatrixCache: exitMatrixCache
};
module.exports = roomNavigation;
