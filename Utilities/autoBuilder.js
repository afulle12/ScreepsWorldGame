// LLM: Read docs/codex.js before reviewing or changing this file.
// autoBuilder.js
// Console globals: autoBuilder
// Example: autoBuilder() - Run or query automated base building and layout planner
//  1.  Block exit-adjacent (range 1) tiles (engine-forbidden for
//      construction) and pre-block the source, mineral, and controller
//      tiles: they are walkable terrain but unbuildable engine objects, so
//      no placer may ever target them. Build the range 2-4 exit buffer and
//      fold it into `blocked` for non-defensive structures so the perimeter
//      defense keeps its room.
//  2.  Pick a storage anchor (or honor Memory.autoBuilder.anchorOverrides).
//  3.  Place the core cluster: storage, terminal, factory, primary spawn.
//  4.  Source pods (STRICT): for each source, the container sits directly
//      between the spawn and the source on a cardinal line (spawn at
//      source+2d, container at source+d) with exactly 2 links at Chebyshev
//      range 1 of the container. A harvester standing on the container is
//      adjacent to the source, the spawn, and both links. All four
//      directions are tried; the fully-valid direction whose spawn is
//      closest to the anchor wins. If no direction is fully valid,
//      deriveLayout fails for the room. Pods are infrastructure: exempt
//      from the exit buffer, and fully blocked before the second source is
//      computed so nothing can collide with them.
//  5.  placeLinks adds the storage link (storage's range-1 ring) and the
//      controller link (within range 2 of the controller, matching
//      linkManager's recipient classification). plan.link is assembled in
//      RCL-staged order [s1 link, storage link, s2 link, controller link,
//      s1 link 2, s2 link 2] so the RCL 5 cap of 2 is a working
//      donor -> storage flow.
//  6.  The mineral container is found via findNearestWalkableInfra (never
//      on the mineral tile); the extractor sits on the mineral.
//  7.  placeTowerRing drops up to 6 towers in the cheb-2 ring of the anchor
//      with a spiral fallback.
//  8.  placeExtensionGrid fills 60 extensions on the anchor's checkerboard
//      parity (~50% density) in all directions around the core. Same-parity
//      tiles are never orthogonally adjacent, so every extension keeps
//      N/S/E/W walkable corridors; diagonal adjacency is legal because
//      Screeps has no corner-cutting movement rule. Extensions are placed
//      before labs so they claim a ring around the core/tower cluster.
//  9.  placeLabCluster places 10 labs in a 3x4 circumnavigable grid. It is
//      run after the extension grid so the lab cluster lands in an open
//      pocket beyond the extension ring, never inside the extension footprint.
//  10. placeFarStructures places nuker and powerSpawn in far corners;
//      placeObserver picks the closest walkable tile to the anchor that is
//      within OBSERVER_MAX_DIST (Euclidean) of the storage and at least
//      OBSERVER_MIN_CHEB+1 Chebyshev from every other building, so the
//      observer sits in a quiet pocket near the core instead of a far
//      corner. Falls back to the closest cheb-clear tile (with a warning)
//      if no candidate satisfies both constraints.
//  11. stripExitBuffer opens the range 2-4 zone for defense; infrastructure
//      tiles that landed in the buffer are re-blocked first so later
//      placers can never claim them.
//  12. placeRampartsAndWalls emits the exit-defense band (core/lab boxes
//      are intentionally commented out; see placeRampartsAndWalls).
//  12.5 placeTunnels adds STRUCTURE_TUNNEL pairs across wall bands that
//      the connector-road BFS cannot cross. The placer is adaptive: it
//      finds the section pair with the fewest edge-disjoint paths, places
//      a tunnel across the wall band separating them, re-verifies, and
//      repeats until every section pair has at least TUNNEL_MIN_PATHS
//      disjoint path (hard floor: 1 way in/out of every area) — ideally
//      TUNNEL_TARGET_PATHS (2, for resilience). There is no hardcoded
//      tunnel count cap; the algorithm places as many as the terrain
//      requires, bounded only by a defensive runtime safety guard. Each
//      tunnel is two adjacent STRUCTURE_TUNNEL tiles bridging a wall.
//  13. placeConnectorRoads draws road tiles so that every pair of major
//      sections (anchor, s1, s2, controller, lab centroid, mineral) has
//      at least 2 edge-disjoint walkable paths, using tunnel teleport
//      edges when natural BFS paths are blocked by walls. The BFS forbids
//      tiles claimed by planned impassable structures (containers and
//      ramparts stay walkable), so drawn roads actually connect for creeps.
//  14. verifyConnectivity counts disjoint paths with the same movement
//      model and records honest warnings on the plan when terrain is too
//      hostile to satisfy the 2-ways-in/out invariant even with tunnels.
//      autoBuilder.status surfaces them.
//  15. placeSwampRoads / placeExtensionGapRoads emit swamp-only roads in
//      the 5x5 core box and on the four cardinal gaps around each extension.
//      Diagonal gaps remain passable without roads because Screeps has no
//      corner-cutting movement rule.
//   autoBuilder.preview(roomName)            Show the layout as letters; auto-clears after 30 ticks
//   autoBuilder.clearPreview(roomName)       Manually clear a preview (erases visuals + memory)
//   autoBuilder.clearAllPreviews()           Clear every active preview in one call
//   autoBuilder.plan(roomName)               Print the full RCL 1-8 plan as text
//   autoBuilder.diff(roomName)               Show what's missing vs the plan
//   autoBuilder.buildRoom(targetRoom, sourceRoom)  Pre-flight + start (claim if needed, then RCL-staged build)
//   autoBuilder.cancel(roomName)             Stop everything for this room
//   autoBuilder.status(roomName)             Show current state (quick phase check)
//   autoBuilder.diagnose(roomName)           Deep-dive state: engine, memory, plan, emit gates, remote builders
//   autoBuilder.rebuild(roomName)            Re-emit missing sites from the cached plan
//   autoBuilder.setAnchor(roomName, x, y)    Override the auto-picked storage anchor
//   autoBuilder.allowUnderfilled(roomName)   Allow a layout with <60 extensions (hard-fail override)
//   autoBuilder.debugTunnels(roomName, true|false) Heap-only verbose tunnel diagnostics
//   Memory.autoBuilder.progress[roomName]  = durable emitted keys / last emission attempt RCL / last emit tick
//   Memory.autoBuilder.anchorOverrides[roomName] = durable anchor override
//   Memory.autoBuilder.cancelled[roomName] = durable cancellation marker
//   heap.autoBuilder.plans[roomName]         = transient layout cache, rebuilt on RCL change or explicit console command
//   heap.autoBuilder.previews[roomName]      = transient visual state
//   heap.autoBuilder.buildOps[roomName]      = transient build operation state
//   heap.autoBuilder.errors[roomName]        = transient last error message
var getRoomState = require("getRoomState");
var roleClaimbot = require("roleClaimbot");
var spawnManager = require("spawnManager");
var util = require("util");
var memoryManager = require("memoryManager");
var heap = memoryManager.heap;
var compactedAutoMemoryRoot = null;
var PREVIEW_TTL = 30;
var AUTO_BUILDER_MIN_BUCKET = 5e3;
var AUTO_BUILDER_MIN_FREE_CPU = 12;
function shouldDeferForCpu() {
  if (!Game || !Game.cpu) return false;
  var e = typeof Game.cpu.bucket === "number" ? Game.cpu.bucket : 1e4;
  var r = typeof Game.cpu.getUsed === "function" ? Game.cpu.getUsed() : 0;
  var t = typeof Game.cpu.limit === "number" ? Game.cpu.limit : 20;
  return e < AUTO_BUILDER_MIN_BUCKET || t - r < AUTO_BUILDER_MIN_FREE_CPU;
}

var EXTENSION_RING_INNER = 3;
var EXTENSION_RING_OUTER = 11;
var EXTENSION_RING_MAX = 25;
var EXTENSION_CAP = 60;
var LAB_MIN_RING_GAP = 1;
var REQUIRED_DISJOINT_PATHS = 2;
var TUNNEL_TARGET_PATHS = 2;
var TUNNEL_MIN_PATHS = 1;
var TUNNEL_SAFETY_MAX = 4;
var TUNNEL_MAX_EXTRA_SECTIONS = 2;
var OBSERVER_MAX_DIST = 20;
var OBSERVER_MIN_CHEB = 4;
var BFS_MAX_NODES = 3e3;
var RCL_SITE_CAPS = {};
RCL_SITE_CAPS[1] = 1;
RCL_SITE_CAPS[2] = 1;
RCL_SITE_CAPS[3] = 2;
RCL_SITE_CAPS[4] = 3;
RCL_SITE_CAPS[5] = 4;
RCL_SITE_CAPS[6] = 4;
RCL_SITE_CAPS[7] = 5;
RCL_SITE_CAPS[8] = 10;
var RCL_STRUCTURES = {};
RCL_STRUCTURES[1] = {
  spawn: 1,
  container: 5,
  road: 2500,
  tunnel: 2
};
RCL_STRUCTURES[2] = {
  spawn: 1,
  extension: 5,
  container: 5,
  rampart: 2500,
  wall: 2500,
  road: 2500,
  tunnel: 2
};
RCL_STRUCTURES[3] = {
  spawn: 1,
  extension: 10,
  tower: 1,
  container: 5,
  rampart: 2500,
  wall: 2500,
  road: 2500,
  tunnel: 2
};
RCL_STRUCTURES[4] = {
  spawn: 1,
  extension: 20,
  tower: 1,
  storage: 1,
  container: 5,
  rampart: 2500,
  wall: 2500,
  road: 2500,
  tunnel: 2
};
RCL_STRUCTURES[5] = {
  spawn: 1,
  extension: 30,
  tower: 2,
  link: 2,
  storage: 1,
  container: 5,
  rampart: 2500,
  wall: 2500,
  road: 2500,
  tunnel: 2
};
RCL_STRUCTURES[6] = {
  spawn: 1,
  extension: 40,
  tower: 2,
  link: 3,
  lab: 3,
  storage: 1,
  terminal: 1,
  extractor: 1,
  container: 5,
  rampart: 2500,
  wall: 2500,
  road: 2500,
  tunnel: 2
};
RCL_STRUCTURES[7] = {
  spawn: 2,
  extension: 50,
  tower: 3,
  link: 4,
  lab: 6,
  storage: 1,
  terminal: 1,
  extractor: 1,
  container: 5,
  rampart: 2500,
  wall: 2500,
  road: 2500,
  tunnel: 2
};
RCL_STRUCTURES[8] = {
  spawn: 3,
  extension: 60,
  tower: 6,
  link: 6,
  lab: 10,
  storage: 1,
  terminal: 1,
  extractor: 1,
  nuker: 1,
  powerSpawn: 1,
  observer: 1,
  factory: 1,
  container: 5,
  rampart: 2500,
  wall: 2500,
  road: 2500,
  tunnel: 2
};
var VISUAL_LETTERS = {
  spawn: "S",
  extension: "E",
  tower: "T",
  lab: "L",
  storage: "$",
  terminal: "^",
  factory: "F",
  link: "K",
  nuker: "N",
  powerSpawn: "P",
  observer: "O",
  extractor: "X",
  container: "C",
  rampart: "R",
  wall: "W",
  road: ".",
  tunnel: "Y"
};
var VISUAL_COLORS = {
  spawn: "#ffffff",
  extension: "#888888",
  tower: "#ff4444",
  lab: "#00ffff",
  storage: "#ffff00",
  terminal: "#ff8800",
  factory: "#aa44ff",
  link: "#4488ff",
  nuker: "#880000",
  powerSpawn: "#886600",
  observer: "#44ff44",
  extractor: "#666666",
  container: "#996633",
  rampart: "#4444ff",
  wall: "#4444ff",
  road: "#888888",
  tunnel: "#ff00ff"
};
var STRUCTURE_ORDER = [ "spawn", "extension", "storage", "terminal", "tower", "link", "lab", "extractor", "container", "factory", "nuker", "powerSpawn", "observer", "rampart", "wall", "road", "tunnel" ];
function compactCompletedProgress(e) {
  if (!e || !e.emitted || typeof e.emitted !== "object") return false;
  var r = e.emitted;
  var t = {};
  var n = false;
  for (var a in r) {
    if (!Object.prototype.hasOwnProperty.call(r, a)) continue;
    var i = /^stageDone_(\d+)$/.exec(a);
    if (i && r[a]) t[i[1]] = true;
  }
  for (var o in r) {
    if (!Object.prototype.hasOwnProperty.call(r, o)) continue;
    var l = /^(\d+)_/.exec(o);
    if (l && t[l[1]]) {
      delete r[o];
      n = true;
    }
  }
  return n;
}

function compactPersistedAutoMemory(e) {
  if (!e || typeof e !== "object") return false;
  var r = false;
  var t = [ "plans", "previews", "buildOps", "errors" ];
  for (var n = 0; n < t.length; n++) {
    var a = t[n];
    if (e[a] !== undefined) {
      delete e[a];
      r = true;
    }
  }
  var i = e.progress || {};
  for (var o in i) {
    if (!Object.prototype.hasOwnProperty.call(i, o)) continue;
    if (compactCompletedProgress(i[o])) r = true;
  }
  return r;
}

function ensureAutoMemory() {
  if (!Memory.autoBuilder) Memory.autoBuilder = {};
  if (!Memory.autoBuilder.progress) Memory.autoBuilder.progress = {};
  if (!Memory.autoBuilder.anchorOverrides) Memory.autoBuilder.anchorOverrides = {};
  if (!Memory.autoBuilder.cancelled) Memory.autoBuilder.cancelled = {};
  if (compactedAutoMemoryRoot !== Memory.autoBuilder) {
    if (compactPersistedAutoMemory(Memory.autoBuilder)) memoryManager.requestSave();
    compactedAutoMemoryRoot = Memory.autoBuilder;
  }
}

function ensureHeap() {
  if (!heap.autoBuilder) heap.autoBuilder = {};
  if (!heap.autoBuilder.plans) heap.autoBuilder.plans = {};
  if (!heap.autoBuilder.previews) heap.autoBuilder.previews = {};
  if (!heap.autoBuilder.buildOps) heap.autoBuilder.buildOps = {};
  if (!heap.autoBuilder.errors) heap.autoBuilder.errors = {};
  return heap.autoBuilder;
}

function getProgress(e) {
  ensureAutoMemory();
  return Memory.autoBuilder.progress[e] || null;
}

function setProgress(e, r) {
  ensureAutoMemory();
  compactCompletedProgress(r);
  Memory.autoBuilder.progress[e] = r;
}

function getPlan(e) {
  return ensureHeap().plans[e] || null;
}

function setPlan(e, r) {
  ensureHeap().plans[e] = r;
}

function getBuildOp(e) {
  return ensureHeap().buildOps[e] || null;
}

function setBuildOp(e, r) {
  ensureHeap().buildOps[e] = r;
}

function setError(e, r) {
  ensureHeap().errors[e] = r;
}

function automaticRCLDue(e) {
  var r = Game.rooms[e];
  if (!r || !r.controller) return false;
  var t = getProgress(e);
  var n = r.controller.level;
  if (!t || t.lastRCL !== n || !t.emitted) return true;
  var a = getPlan(e);
  if (!a || !a.layout) return true;
  if (n >= 6) {
    var i = r.find(FIND_MINERALS);
    var o = i.length > 0 ? i[0].pos : null;
    var l = a.layout.mineralContainer;
    if (o && (!l || Math.max(Math.abs(l.x - o.x), Math.abs(l.y - o.y)) !== 1)) {
      setPlan(e, null);
      return true;
    }
    if (o && l) {
      var u = r.lookForAt(LOOK_STRUCTURES, l.x, l.y);
      var s = r.lookForAt(LOOK_CONSTRUCTION_SITES, l.x, l.y);
      var f = false;
      for (var v = 0; v < u.length; v++) {
        if (u[v].structureType === STRUCTURE_CONTAINER) {
          f = true;
          break;
        }
      }
      if (!f) {
        for (var c = 0; c < s.length; c++) {
          if (s[c].structureType === STRUCTURE_CONTAINER) {
            f = true;
            break;
          }
        }
      }
      if (!f) {
        var d = "6_" + STRUCTURE_CONTAINER + "_" + l.x + "_" + l.y;
        delete t.emitted["stageDone_6"];
        delete t.emitted[d];
        if (a.emitted) {
          delete a.emitted["stageDone_6"];
          delete a.emitted[d];
        }
        setProgress(e, t);
        memoryManager.requestSave();
        return true;
      }
    }
  }
  for (var y = 1; y <= n; y++) {
    if (!t.emitted["stageDone_" + y]) return true;
  }
  return false;
}

function getTerrain(e) {
  return Game.map.getRoomTerrain(e);
}

function getExitTiles(e) {
  var r = Game.rooms[e];
  if (!r) return [];
  var t = [];
  var n = [ FIND_EXIT_TOP, FIND_EXIT_RIGHT, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT ];
  for (var a = 0; a < n.length; a++) {
    var i = r.find(n[a]);
    for (var o = 0; o < i.length; o++) {
      t.push({
        x: i[o].x,
        y: i[o].y
      });
    }
  }
  return t;
}

function blockExitAdjacents(e, r) {
  for (var t = 0; t < r.length; t++) {
    var n = r[t];
    for (var a = -1; a <= 1; a++) {
      for (var i = -1; i <= 1; i++) {
        var o = n.x + a;
        var l = n.y + i;
        if (o < 1 || o > 48 || l < 1 || l > 48) continue;
        blockTile(e, o, l);
      }
    }
  }
}

function buildExitBuffer(e) {
  var r = {};
  for (var t = 0; t < e.length; t++) {
    var n = e[t];
    for (var a = -4; a <= 4; a++) {
      for (var i = -4; i <= 4; i++) {
        var o = Math.abs(a);
        var l = Math.abs(i);
        var u = o > l ? o : l;
        if (u < 2 || u > 4) continue;
        var s = n.x + a;
        var f = n.y + i;
        if (s < 1 || s > 48 || f < 1 || f > 48) continue;
        r[tileKey(s, f)] = true;
      }
    }
  }
  return r;
}

function applyExitBuffer(e, r) {
  for (var t in r) {
    if (!r.hasOwnProperty(t)) continue;
    e[t] = true;
  }
}

function stripExitBuffer(e, r) {
  for (var t in r) {
    if (!r.hasOwnProperty(t)) continue;
    delete e[t];
  }
}

function groupExitTiles(e) {
  var r = [];
  var t = {};
  for (var n = 0; n < e.length; n++) {
    var a = e[n];
    var i = tileKey(a.x, a.y);
    if (t[i]) continue;
    var o = [ a ];
    var l = [];
    t[i] = true;
    while (o.length > 0) {
      var u = o.pop();
      l.push(u);
      for (var s = 0; s < e.length; s++) {
        var f = e[s];
        if (f.x === u.x && f.y === u.y) continue;
        if (Math.abs(f.x - u.x) + Math.abs(f.y - u.y) !== 1) continue;
        var v = tileKey(f.x, f.y);
        if (t[v]) continue;
        t[v] = true;
        o.push(f);
      }
    }
    r.push(l);
  }
  return r;
}

function isWall(e, r, t) {
  if (r < 1 || r > 48 || t < 1 || t > 48) return true;
  var n = getTerrain(e).get(r, t);
  return n === TERRAIN_MASK_WALL;
}

function isSwamp(e, r, t) {
  if (r < 1 || r > 48 || t < 1 || t > 48) return false;
  var n = getTerrain(e).get(r, t);
  return n === TERRAIN_MASK_SWAMP;
}

function isWalkableTile(e, r, t) {
  return !isWall(e, r, t);
}

function buildWallSet(e) {
  var r = {};
  var t = getTerrain(e);
  for (var n = 0; n <= 49; n++) {
    for (var a = 0; a <= 49; a++) {
      if (t.get(n, a) === TERRAIN_MASK_WALL) {
        r[a * 50 + n] = true;
      }
    }
  }
  return r;
}

function tileKey(e, r) {
  return e + "," + r;
}

function posFromKey(e) {
  var r = e.split(",");
  return {
    x: parseInt(r[0], 10),
    y: parseInt(r[1], 10)
  };
}

function dist(e, r) {
  var t = e.x - r.x;
  var n = e.y - r.y;
  return Math.sqrt(t * t + n * n);
}

function manhattan(e, r) {
  return Math.abs(e.x - r.x) + Math.abs(e.y - r.y);
}

function blockTile(e, r, t) {
  e[tileKey(r, t)] = true;
}

function isBlocked(e, r, t) {
  return !!e[tileKey(r, t)];
}

function findNearestWalkable(e, r, t, n, a) {
  if (!a) a = 8;
  for (var i = 0; i <= a; i++) {
    for (var o = -i; o <= i; o++) {
      for (var l = -i; l <= i; l++) {
        if (Math.abs(o) !== i && Math.abs(l) !== i) continue;
        var u = r + o;
        var s = t + l;
        if (u < 1 || u > 48 || s < 1 || s > 48) continue;
        if (!isWalkableTile(e, u, s)) continue;
        if (isBlocked(n, u, s)) continue;
        return {
          x: u,
          y: s
        };
      }
    }
  }
  return null;
}

function isBlockedInfra(e, r, t, n) {
  var a = tileKey(t, n);
  if (!e[a]) return false;
  return !r[a];
}

function findNearestWalkableInfra(e, r, t, n, a, i) {
  if (!i) i = 8;
  for (var o = 1; o <= i; o++) {
    for (var l = -o; l <= o; l++) {
      for (var u = -o; u <= o; u++) {
        if (Math.abs(l) !== o && Math.abs(u) !== o) continue;
        var s = r + l;
        var f = t + u;
        if (s < 1 || s > 48 || f < 1 || f > 48) continue;
        if (!isWalkableTile(e, s, f)) continue;
        if (isBlockedInfra(n, a, s, f)) continue;
        return {
          x: s,
          y: f
        };
      }
    }
  }
  return null;
}

function bfsShortestPath(e, r, t, n, a, i) {
  if (!r || !t) return null;
  if (r.x === t.x && r.y === t.y) return [ {
    x: r.x,
    y: r.y
  } ];
  function key(e, r) {
    return r * 50 + e;
  }
  var o = key(r.x, r.y);
  var l = key(t.x, t.y);
  if (a) {
    if (a[o]) return null;
    if (a[l]) return null;
  } else {
    if (isWall(e, r.x, r.y)) return null;
    if (isWall(e, t.x, t.y)) return null;
  }
  var u = {};
  u[o] = -1;
  var s = [ o ];
  var f = 0;
  while (f < s.length) {
    if (f >= BFS_MAX_NODES) return null;
    var v = s[f++];
    if (v === l) {
      var c = [];
      var d = v;
      while (d >= 0) {
        var y = d % 50;
        var p = (d - y) / 50;
        c.push({
          x: y,
          y: p
        });
        d = u[d];
      }
      c.reverse();
      return c;
    }
    var h = v % 50;
    var m = (v - h) / 50;
    for (var g = -1; g <= 1; g++) {
      var x = h + g;
      if (x < 0 || x > 49) continue;
      for (var R = -1; R <= 1; R++) {
        if (g === 0 && R === 0) continue;
        var T = m + R;
        if (T < 0 || T > 49) continue;
        var S = T * 50 + x;
        if (a && a[S]) continue;
        if (u[S] !== undefined) continue;
        if (n && n[S]) continue;
        u[S] = v;
        s.push(S);
      }
    }
    if (i && i[v] !== undefined) {
      var b = i[v];
      if (b !== v && u[b] === undefined) {
        if (!a || !a[b]) {
          if (!n || !n[b]) {
            u[b] = v;
            s.push(b);
          }
        }
      }
    }
  }
  return null;
}

function countEdgeDisjointPaths(e, r, t, n, a, i, o, l) {
  if (!i) i = REQUIRED_DISJOINT_PATHS;
  if (!a) a = {};
  function edgeKey(e, r) {
    if (e < r) return e + "|" + r;
    return r + "|" + e;
  }
  function isEdgeUsed(e, r) {
    return !!a[edgeKey(e, r)];
  }
  function markEdges(e) {
    for (var r = 0; r < e.length - 1; r++) {
      var t = key(e[r].x, e[r].y);
      var n = key(e[r + 1].x, e[r + 1].y);
      a[edgeKey(t, n)] = true;
    }
  }
  function key(e, r) {
    return r * 50 + e;
  }
  var u = key(r.x, r.y);
  var s = key(t.x, t.y);
  var f = 0;
  for (var v = 0; v < i; v++) {
    if (o) {
      if (o[u] || o[s]) break;
    } else {
      if (isWall(e, r.x, r.y) || isWall(e, t.x, t.y)) break;
    }
    var c = {};
    c[u] = -1;
    var d = [ u ];
    var y = 0;
    var p = null;
    while (y < d.length) {
      if (y >= BFS_MAX_NODES) break;
      var h = d[y++];
      if (h === s) {
        p = h;
        break;
      }
      var m = h % 50;
      var g = (h - m) / 50;
      for (var x = -1; x <= 1; x++) {
        var R = m + x;
        if (R < 0 || R > 49) continue;
        for (var T = -1; T <= 1; T++) {
          if (x === 0 && T === 0) continue;
          var S = g + T;
          if (S < 0 || S > 49) continue;
          var b = S * 50 + R;
          if (o && o[b]) continue;
          if (isEdgeUsed(h, b)) continue;
          if (c[b] !== undefined) continue;
          if (n && n[b]) continue;
          c[b] = h;
          d.push(b);
        }
      }
      if (l && l[h] !== undefined) {
        var E = l[h];
        if (E !== h && !isEdgeUsed(h, E) && c[E] === undefined) {
          if (!o || !o[E]) {
            if (!n || !n[E]) {
              c[E] = h;
              d.push(E);
            }
          }
        }
      }
    }
    if (!p) break;
    var w = [];
    var _ = p;
    while (_ >= 0) {
      var C = _ % 50;
      var k = (_ - C) / 50;
      w.push({
        x: C,
        y: k
      });
      _ = c[_];
    }
    w.reverse();
    markEdges(w);
    f++;
  }
  return f;
}

function bfsDistanceMap(e, r) {
  var t = new Array(2500);
  for (var n = 0; n < 2500; n++) t[n] = Infinity;
  function key(e, r) {
    return r * 50 + e;
  }
  var a = key(r.x, r.y);
  if (isWall(e, r.x, r.y)) return t;
  t[a] = 0;
  var i = [ a ];
  var o = [];
  var l = 0, u = 0;
  while (l < i.length || u < o.length) {
    var s, f;
    if (u < o.length) {
      s = o[u++];
      f = t[s];
    } else {
      s = i[l++];
      f = t[s];
    }
    var v = s % 50;
    var c = (s - v) / 50;
    for (var d = -1; d <= 1; d++) {
      var y = v + d;
      if (y < 0 || y > 49) continue;
      for (var p = -1; p <= 1; p++) {
        if (d === 0 && p === 0) continue;
        var h = c + p;
        if (h < 0 || h > 49) continue;
        if (isWall(e, y, h)) continue;
        var m = h * 50 + y;
        var g = isSwamp(e, y, h) ? 5 : 1;
        var x = f + g;
        if (x < t[m]) {
          t[m] = x;
          if (g === 1) i.push(m); else o.push(m);
        }
      }
    }
  }
  return t;
}

function canFitCore(e, r, t, n) {
  var a = [ {
    x: r,
    y: t
  }, {
    x: r + 1,
    y: t - 2
  }, {
    x: r,
    y: t - 2
  } ];
  for (var i = 0; i < a.length; i++) {
    var o = a[i];
    if (o.x < 1 || o.x > 48 || o.y < 1 || o.y > 48) return false;
    if (!isWalkableTile(e, o.x, o.y)) return false;
    if (n && isBlocked(n, o.x, o.y)) return false;
  }
  return true;
}

function anchorCost(e, r, t) {
  var n = 0;
  for (var a = -2; a <= 2; a++) {
    for (var i = -2; i <= 2; i++) {
      if (isSwamp(e, r + a, t + i)) n += 2;
      if (isWall(e, r + a, t + i)) n += 10;
    }
  }
  return n;
}

function pickStorageAnchor(e, r, t, n, a) {
  var i = Math.round((r.x + t.x) / 2);
  var o = Math.round((r.y + t.y) / 2);
  var l = [];
  for (var u = -6; u <= 6; u += 3) {
    for (var s = -6; s <= 6; s += 3) {
      var f = i + u;
      var v = o + s;
      if (f < 3 || f > 46 || v < 3 || v > 46) continue;
      if (!canFitCore(e, f, v, a)) continue;
      l.push({
        x: f,
        y: v,
        cost: anchorCost(e, f, v)
      });
    }
  }
  if (l.length === 0) return null;
  var c = buildWallSet(e);
  function key(e, r) {
    return r * 50 + e;
  }
  function floodComponent(e) {
    var r = {};
    var t = key(e.x, e.y);
    if (c[t]) return r;
    var n = [ t ];
    var a = 0;
    r[t] = true;
    while (a < n.length) {
      if (a >= BFS_MAX_NODES) break;
      var i = n[a++];
      var o = i % 50;
      var l = (i - o) / 50;
      for (var u = -1; u <= 1; u++) {
        var s = o + u;
        if (s < 0 || s > 49) continue;
        for (var f = -1; f <= 1; f++) {
          if (u === 0 && f === 0) continue;
          var v = l + f;
          if (v < 0 || v > 49) continue;
          var d = v * 50 + s;
          if (c[d]) continue;
          if (r[d]) continue;
          r[d] = true;
          n.push(d);
        }
      }
    }
    return r;
  }
  var d = [];
  d.push(floodComponent(r));
  d.push(floodComponent(t));
  var y = n ? floodComponent(n) : null;
  function inComponent(e, r) {
    return e && e[key(r.x, r.y)];
  }
  for (var p = 0; p < l.length; p++) {
    var h = l[p];
    var m = floodComponent(h);
    h.connectScore = 0;
    if (y && inComponent(m, n)) h.connectScore += 4;
    if (inComponent(m, r)) h.connectScore += 1;
    if (inComponent(m, t)) h.connectScore += 1;
  }
  var g = l.filter(function(e) {
    return e.connectScore >= 4;
  });
  var x = g.length > 0 ? g : l;
  x.sort(function(e, r) {
    if (r.connectScore !== e.connectScore) return r.connectScore - e.connectScore;
    return e.cost - r.cost;
  });
  return x[0];
}

function deriveLayout(e) {
  if (shouldDeferForCpu()) return null;
  var r = Game.rooms[e];
  if (!r) return null;
  var t = r.find(FIND_SOURCES);
  if (t.length < 2) return null;
  var n = {
    x: t[0].pos.x,
    y: t[0].pos.y
  };
  var a = {
    x: t[1].pos.x,
    y: t[1].pos.y
  };
  var i = r.find(FIND_MINERALS);
  var o = i.length > 0 ? {
    x: i[0].pos.x,
    y: i[0].pos.y
  } : null;
  var l = r.controller;
  var u = l ? {
    x: l.pos.x,
    y: l.pos.y
  } : null;
  var s = {};
  var f = getExitTiles(e);
  blockExitAdjacents(s, f);
  blockTile(s, n.x, n.y);
  blockTile(s, a.x, a.y);
  if (o) blockTile(s, o.x, o.y);
  if (u) blockTile(s, u.x, u.y);
  var v = buildExitBuffer(f);
  applyExitBuffer(s, v);
  var c = {};
  function blockInfra(e, r) {
    var t = tileKey(e, r);
    if (v[t]) c[t] = true;
    s[t] = true;
  }
  var d;
  ensureAutoMemory();
  if (Memory.autoBuilder.anchorOverrides[e]) {
    var y = Memory.autoBuilder.anchorOverrides[e];
    d = {
      x: y.x,
      y: y.y
    };
    if (!canFitCore(e, d.x, d.y, s)) {
      return null;
    }
  } else {
    d = pickStorageAnchor(e, n, a, u, s);
  }
  if (!d) return null;
  var p = {
    x: d.x,
    y: d.y
  };
  var h = {
    x: d.x + 1,
    y: d.y - 2
  };
  var m = {
    x: d.x,
    y: d.y - 2
  };
  blockTile(s, p.x, p.y);
  blockTile(s, h.x, h.y);
  blockTile(s, m.x, m.y);
  var g = placePrimarySpawn(e, d, s);
  if (!g) return null;
  blockTile(s, g.x, g.y);
  var x = [ n, a ];
  var R = [];
  for (var T = 0; T < x.length; T++) {
    var S = x[T];
    var b = placeSourceLayout(e, S, s, v, d);
    if (!b) {
      console.log("[autoBuilder] deriveLayout failed for " + e + ": source at " + S.x + "," + S.y + " cannot fit a strict spawn/container/2-link pod on any cardinal line.");
      return null;
    }
    blockInfra(b.container.x, b.container.y);
    blockInfra(b.spawn.x, b.spawn.y);
    for (var E = 0; E < b.links.length; E++) {
      blockInfra(b.links[E].x, b.links[E].y);
    }
    R.push(b);
  }
  var w = [ g, R[0].spawn, R[1].spawn ];
  var _ = placeLinks(e, p, u, s, v);
  if (_.storageLink) blockInfra(_.storageLink.x, _.storageLink.y);
  if (_.ctrlLink) blockInfra(_.ctrlLink.x, _.ctrlLink.y);
  function cheb(e, r) {
    return Math.max(Math.abs(e.x - r.x), Math.abs(e.y - r.y));
  }
  var C = cheb(n, p) >= cheb(a, p) ? 0 : 1;
  var k = 1 - C;
  var A = [];
  if (R[C].links[0]) A.push(R[C].links[0]);
  if (_.storageLink) A.push(_.storageLink);
  if (R[k].links[0]) A.push(R[k].links[0]);
  if (_.ctrlLink) A.push(_.ctrlLink);
  if (R[0].links[1]) A.push(R[0].links[1]);
  if (R[1].links[1]) A.push(R[1].links[1]);
  var O = [ R[0].container, R[1].container ];
  var B = null;
  if (o) {
    B = findNearestWalkableInfra(e, o.x, o.y, s, v, 1);
    if (!B) {
      console.log("[autoBuilder] deriveLayout failed for " + e + ": no walkable, unoccupied tile in range 1 of mineral at " + o.x + "," + o.y + " for the extractor container.");
      return null;
    }
    O.push(B);
    blockInfra(B.x, B.y);
  }
  var U = o ? {
    x: o.x,
    y: o.y
  } : null;
  var M = placeTowerRing(e, d, s);
  for (var N = 0; N < M.length; N++) blockTile(s, M[N].x, M[N].y);
  var L = placeExtensionGrid(e, d, s);
  var I = L.extensions;
  for (var P = 0; P < I.length; P++) blockTile(s, I[P].x, I[P].y);
  var W = ensureCoreConnectivity(e, d, I, s, O, [ n, a ], u, o);
  if (W.removedExtensions.length > 0) {
    console.log("[autoBuilder] " + e + ": removed " + W.removedExtensions.length + " extension(s) to preserve core connectivity: " + W.removedExtensions.map(function(e) {
      return "(" + e.x + "," + e.y + ")";
    }).join(" "));
  }
  var D = L.maxRing + LAB_MIN_RING_GAP;
  var F = placeLabCluster(e, d, s, D);
  if (!F || F.length < 10) {
    console.log("[autoBuilder] deriveLayout failed for " + e + ": could not place all 10 labs.");
    return null;
  }
  for (var G = 0; G < F.length; G++) blockTile(s, F[G].x, F[G].y);
  var K = [].concat([ p, h, m ], w, M, F, A, O, I);
  if (U) K.push(U);
  var X = placeFarStructures(e, d, I, F, s, K);
  if (X.nuker) blockTile(s, X.nuker.x, X.nuker.y);
  if (X.powerSpawn) blockTile(s, X.powerSpawn.x, X.powerSpawn.y);
  if (X.observer) blockTile(s, X.observer.x, X.observer.y);
  stripExitBuffer(s, v);
  for (var j in c) {
    if (!c.hasOwnProperty(j)) continue;
    s[j] = true;
  }
  var H = placeRampartsAndWalls(e, d, F, s, f);
  var V = O.concat(H.ramparts || []);
  var Y = buildMovementForbidSet(s, V);
  var q = placeTunnels(e, d, n, a, u, F, o, I, s, Y, v, V, H.ramparts || [], H.walls || []);
  var Q = q.tunnels;
  var J = [];
  var $ = {};
  for (var z = 0; z < Q.length; z++) {
    J.push(Q[z].entrance);
    J.push(Q[z].exit);
    $[tileKey(Q[z].entrance.x, Q[z].entrance.y)] = true;
    $[tileKey(Q[z].exit.x, Q[z].exit.y)] = true;
  }
  if (J.length > 0) {
    var Z = [];
    for (var ee = 0; ee < (H.ramparts || []).length; ee++) {
      var re = H.ramparts[ee];
      if ($[tileKey(re.x, re.y)]) {
        delete s[tileKey(re.x, re.y)];
      } else {
        Z.push(re);
      }
    }
    H.ramparts = Z;
    var te = [];
    for (var ne = 0; ne < (H.walls || []).length; ne++) {
      var ae = H.walls[ne];
      if ($[tileKey(ae.x, ae.y)]) {
        delete s[tileKey(ae.x, ae.y)];
      } else {
        te.push(ae);
      }
    }
    H.walls = te;
  }
  if (J.length > 0) {
    V = V.concat(J);
    Y = buildMovementForbidSet(s, V);
  }
  var ie = buildTeleportPairs(Q);
  var oe = placeConnectorRoads(e, d, n, a, u, F, o, s, Y, ie);
  var le = verifyConnectivity(e, d, n, a, u, F, o, Y, ie);
  if (q.warnings && q.warnings.length > 0) {
    le = le.concat(q.warnings);
  }
  if (X.warnings && X.warnings.length > 0) {
    le = le.concat(X.warnings);
  }
  var ue = placeSwampRoads(e, d, s);
  var se = placeExtensionGapRoads(e, d, I, s);
  return {
    storage: p,
    terminal: h,
    factory: m,
    spawn: w,
    tower: M,
    extension: I,
    lab: F,
    link: A,
    nuker: X.nuker || null,
    powerSpawn: X.powerSpawn || null,
    observer: X.observer || null,
    container: O,
    mineralContainer: B,
    extractor: U,
    rampart: H.ramparts || [],
    wall: H.walls || [],
    road: ue.concat(se).concat(oe),
    tunnel: J,
    warnings: le
  };
}

function placePrimarySpawn(e, r, t) {
  var n = [ {
    x: r.x,
    y: r.y
  }, {
    x: r.x + 1,
    y: r.y - 2
  }, {
    x: r.x,
    y: r.y - 2
  } ];
  var a = [];
  for (var i = 0; i < n.length; i++) {
    var o = n[i];
    for (var l = -1; l <= 1; l++) {
      for (var u = -1; u <= 1; u++) {
        if (l === 0 && u === 0) continue;
        var s = o.x + l;
        var f = o.y + u;
        if (s < 1 || s > 48 || f < 1 || f > 48) continue;
        if (!isWalkableTile(e, s, f)) continue;
        if (isBlocked(t, s, f)) continue;
        if (Math.max(Math.abs(s - r.x), Math.abs(f - r.y)) < 2) continue;
        var v = dist({
          x: s,
          y: f
        }, {
          x: r.x,
          y: r.y
        });
        a.push({
          x: s,
          y: f,
          d: v
        });
      }
    }
  }
  if (a.length === 0) return null;
  a.sort(function(e, r) {
    return e.d - r.d;
  });
  return a[0];
}

var SOURCE_POD_DIRECTIONS = [ {
  dx: 0,
  dy: -1
}, {
  dx: 1,
  dy: 0
}, {
  dx: 0,
  dy: 1
}, {
  dx: -1,
  dy: 0
} ];
function placeSourceLayout(e, r, t, n, a) {
  function tileFree(r, a) {
    if (r < 1 || r > 48 || a < 1 || a > 48) return false;
    if (!isWalkableTile(e, r, a)) return false;
    if (isBlockedInfra(t, n, r, a)) return false;
    return true;
  }
  var i = null;
  var o = Infinity;
  for (var l = 0; l < SOURCE_POD_DIRECTIONS.length; l++) {
    var u = SOURCE_POD_DIRECTIONS[l];
    var s = {
      x: r.x + u.dx,
      y: r.y + u.dy
    };
    var f = {
      x: r.x + 2 * u.dx,
      y: r.y + 2 * u.dy
    };
    if (!tileFree(s.x, s.y)) continue;
    if (!tileFree(f.x, f.y)) continue;
    var v = u.dx === 0 ? {
      dx: 1,
      dy: 0
    } : {
      dx: 0,
      dy: 1
    };
    var c = [ {
      x: s.x + v.dx,
      y: s.y + v.dy
    }, {
      x: s.x - v.dx,
      y: s.y - v.dy
    }, {
      x: r.x + v.dx,
      y: r.y + v.dy
    }, {
      x: r.x - v.dx,
      y: r.y - v.dy
    }, {
      x: f.x + v.dx,
      y: f.y + v.dy
    }, {
      x: f.x - v.dx,
      y: f.y - v.dy
    } ];
    var d = [];
    for (var y = 0; y < c.length && d.length < 2; y++) {
      var p = c[y];
      if (!tileFree(p.x, p.y)) continue;
      d.push({
        x: p.x,
        y: p.y
      });
    }
    if (d.length < 2) continue;
    var h = a ? dist(f, a) : 0;
    if (h < o) {
      o = h;
      i = {
        container: s,
        spawn: f,
        links: d
      };
    }
  }
  return i;
}

function placeTowerRing(e, r, t) {
  var n = [];
  var a = [ {
    dx: -2,
    dy: -2,
    weight: 1
  }, {
    dx: 2,
    dy: -2,
    weight: 1
  }, {
    dx: -2,
    dy: 2,
    weight: 1
  }, {
    dx: 2,
    dy: 2,
    weight: 1
  }, {
    dx: -2,
    dy: 0,
    weight: 1
  }, {
    dx: 2,
    dy: 0,
    weight: 1
  }, {
    dx: 0,
    dy: -2,
    weight: 1
  }, {
    dx: 0,
    dy: 2,
    weight: 1
  } ];
  function tryPlace(a, i) {
    var o = r.x + a;
    var l = r.y + i;
    if (o < 1 || o > 48 || l < 1 || l > 48) return false;
    if (!isWalkableTile(e, o, l)) return false;
    if (isBlocked(t, o, l)) return false;
    for (var u = 0; u < n.length; u++) {
      if (n[u].x === o && n[u].y === l) return false;
    }
    n.push({
      x: o,
      y: l
    });
    blockTile(t, o, l);
    return true;
  }
  for (var i = 0; i < a.length && n.length < 6; i++) {
    tryPlace(a[i].dx, a[i].dy);
  }
  if (n.length < 6) {
    for (var o = 2; o <= 6 && n.length < 6; o++) {
      var l = [];
      for (var u = -o; u <= o; u++) {
        for (var s = -o; s <= o; s++) {
          if (Math.abs(u) !== o && Math.abs(s) !== o) continue;
          var f = r.x + u;
          var v = r.y + s;
          if (f < 1 || f > 48 || v < 1 || v > 48) continue;
          if (!isWalkableTile(e, f, v)) continue;
          if (isBlocked(t, f, v)) continue;
          var c = false;
          for (var d = 0; d < n.length; d++) {
            if (n[d].x === f && n[d].y === v) {
              c = true;
              break;
            }
          }
          if (c) continue;
          var y = dist({
            x: f,
            y: v
          }, r);
          l.push({
            x: f,
            y: v,
            d: y
          });
        }
      }
      l.sort(function(e, r) {
        return e.d - r.d;
      });
      for (var p = 0; p < l.length && n.length < 6; p++) {
        n.push({
          x: l[p].x,
          y: l[p].y
        });
        blockTile(t, l[p].x, l[p].y);
      }
    }
  }
  return n;
}

//   Memory.autoBuilder.singleQuadrantExtensions["E1N47"] = true;
function rawBfsDistanceMap(e, r) {
  var t = new Array(2500);
  for (var n = 0; n < 2500; n++) t[n] = Infinity;
  function key(e, r) {
    return r * 50 + e;
  }
  var a = key(r.x, r.y);
  if (isWall(e, r.x, r.y)) return t;
  t[a] = 0;
  var i = [ a ];
  var o = 0;
  while (o < i.length) {
    if (o >= BFS_MAX_NODES) break;
    var l = i[o++];
    var u = l % 50;
    var s = (l - u) / 50;
    for (var f = -1; f <= 1; f++) {
      var v = u + f;
      if (v < 0 || v > 49) continue;
      for (var c = -1; c <= 1; c++) {
        if (f === 0 && c === 0) continue;
        var d = s + c;
        if (d < 0 || d > 49) continue;
        if (isWall(e, v, d)) continue;
        var y = d * 50 + v;
        var p = t[l] + 1;
        if (p < t[y]) {
          t[y] = p;
          i.push(y);
        }
      }
    }
  }
  return t;
}

var EXTENSION_MAX_TRAVEL_DIST = 24;
function placeExtensionGrid(e, r, t) {
  var n = [];
  var a = 0;
  var i = (r.x + r.y) % 2;
  var o = buildWallSet(e);
  var l = rawBfsDistanceMap(e, r);
  function isWallTile(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return true;
    return !!o[r * 50 + e];
  }
  function travelDistance(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return Infinity;
    return l[r * 50 + e];
  }
  function isReservedForCore(e, t) {
    var n = Math.abs(e - r.x) > Math.abs(t - r.y) ? Math.abs(e - r.x) : Math.abs(t - r.y);
    return n < 2;
  }
  function candidateOk(e, r) {
    if (e < 1 || e > 48 || r < 1 || r > 48) return false;
    if ((e + r) % 2 !== i) return false;
    if (isWallTile(e, r)) return false;
    if (isBlocked(t, e, r)) return false;
    if (isReservedForCore(e, r)) return false;
    if (travelDistance(e, r) > EXTENSION_MAX_TRAVEL_DIST) return false;
    return true;
  }
  function quadrant(e, t) {
    var n = e - r.x;
    var a = t - r.y;
    if (n >= 0 && a < 0) return "ne";
    if (n >= 0 && a >= 0) return "se";
    if (n < 0 && a >= 0) return "sw";
    return "nw";
  }
  var u = Memory.autoBuilder && Memory.autoBuilder.singleQuadrantExtensions && Memory.autoBuilder.singleQuadrantExtensions[e];
  var s = null;
  if (u) {
    var f = {
      ne: 0,
      se: 0,
      sw: 0,
      nw: 0
    };
    for (var v = EXTENSION_RING_INNER; v <= EXTENSION_RING_MAX; v++) {
      for (var c = -v; c <= v; c++) {
        for (var d = -v; d <= v; d++) {
          if (Math.abs(c) !== v && Math.abs(d) !== v) continue;
          var y = r.x + c;
          var p = r.y + d;
          if (!candidateOk(y, p)) continue;
          f[quadrant(y, p)]++;
        }
      }
    }
    s = "ne";
    var h = f.ne;
    if (f.se > h) {
      s = "se";
      h = f.se;
    }
    if (f.sw > h) {
      s = "sw";
      h = f.sw;
    }
    if (f.nw > h) {
      s = "nw";
      h = f.nw;
    }
  }
  function inChosenQuad(e, r) {
    if (!s) return true;
    return quadrant(e, r) === s;
  }
  for (var v = EXTENSION_RING_INNER; v <= EXTENSION_RING_MAX && n.length < EXTENSION_CAP; v++) {
    var m = [];
    for (var c = -v; c <= v; c++) {
      for (var d = -v; d <= v; d++) {
        if (Math.abs(c) !== v && Math.abs(d) !== v) continue;
        var y = r.x + c;
        var p = r.y + d;
        if (!candidateOk(y, p)) continue;
        if (!inChosenQuad(y, p)) continue;
        m.push({
          x: y,
          y: p,
          d: travelDistance(y, p)
        });
      }
    }
    m.sort(function(e, r) {
      return e.d - r.d;
    });
    for (var g = 0; g < m.length && n.length < EXTENSION_CAP; g++) {
      var x = m[g];
      n.push({
        x: x.x,
        y: x.y
      });
      blockTile(t, x.x, x.y);
      if (v > a) a = v;
    }
  }
  if (n.length < EXTENSION_CAP) {
    ensureHeap();
    var R = heap.autoBuilder.allowUnderfilled && heap.autoBuilder.allowUnderfilled[e];
    if (!R) {
      var T = "autoBuilder: cannot place " + EXTENSION_CAP + " extensions in room " + e + " (placed " + n.length + "). " + 'Run autoBuilder.allowUnderfilled("' + e + '") to accept fewer.';
      if (!Memory.autoBuilder.planWarnings) Memory.autoBuilder.planWarnings = {};
      Memory.autoBuilder.planWarnings[e] = T;
      throw new Error(T);
    }
  }
  return {
    extensions: n,
    maxRing: a
  };
}

function ensureCoreConnectivity(e, r, t, n, a, i, o, l) {
  var u = [];
  if (!t || t.length === 0) return {
    removedExtensions: u
  };
  var s = buildWallSet(e);
  var f = {};
  if (a) {
    for (var v = 0; v < a.length; v++) {
      if (a[v]) f[tileKey(a[v].x, a[v].y)] = true;
    }
  }
  function isImpassable(e, r) {
    if (s[r * 50 + e]) return true;
    if (isBlocked(n, e, r) && !f[tileKey(e, r)]) return true;
    return false;
  }
  var c = {};
  var d = {};
  for (var y = 0; y < t.length; y++) {
    var p = t[y];
    var h = p.y * 50 + p.x;
    c[h] = true;
    d[tileKey(p.x, p.y)] = y;
  }
  function key(e, r) {
    return r * 50 + e;
  }
  var m = [];
  for (var g = 0; g < i.length; g++) if (i[g]) m.push({
    label: "source",
    p: i[g]
  });
  if (o) m.push({
    label: "controller",
    p: o
  });
  if (l) m.push({
    label: "mineral",
    p: l
  });
  if (m.length === 0) return {
    removedExtensions: u
  };
  function computeReachable(e) {
    var r = {};
    var t = key(e.x, e.y);
    if (s[t]) return r;
    var n = [ t ];
    var a = 0;
    r[t] = 0;
    while (a < n.length) {
      if (a >= BFS_MAX_NODES) break;
      var i = n[a++];
      var o = i % 50;
      var l = (i - o) / 50;
      for (var u = -1; u <= 1; u++) {
        var f = o + u;
        if (f < 0 || f > 49) continue;
        for (var v = -1; v <= 1; v++) {
          if (u === 0 && v === 0) continue;
          var d = l + v;
          if (d < 0 || d > 49) continue;
          var y = d * 50 + f;
          if (s[y]) continue;
          if (c[y]) continue;
          if (r[y] !== undefined) continue;
          if (isImpassable(f, d)) continue;
          r[y] = r[i] + 1;
          n.push(y);
        }
      }
    }
    return r;
  }
  function findBridgeExtensions(e, r) {
    var n = [];
    for (var a = 0; a < t.length; a++) {
      var i = t[a];
      var o = false;
      var l = false;
      var u = Infinity;
      var s = Infinity;
      for (var f = -1; f <= 1 && !(o && l); f++) {
        var v = i.x + f;
        if (v < 0 || v > 49) continue;
        for (var c = -1; c <= 1 && !(o && l); c++) {
          if (f === 0 && c === 0) continue;
          var d = i.y + c;
          if (d < 0 || d > 49) continue;
          if (isImpassable(v, d)) continue;
          var y = key(v, d);
          if (e[y] !== undefined) {
            o = true;
            if (e[y] < u) u = e[y];
          }
          if (r[y] !== undefined) {
            l = true;
            if (r[y] < s) s = r[y];
          }
        }
      }
      if (o && l) {
        n.push({
          index: a,
          x: i.x,
          y: i.y,
          cost: u + s
        });
      }
    }
    return n;
  }
  var x = 0;
  while (x < 20) {
    x++;
    var R = computeReachable(r);
    var T = true;
    var S = null;
    for (var b = 0; b < m.length; b++) {
      var E = m[b];
      if (R[key(E.p.x, E.p.y)] !== undefined) continue;
      T = false;
      var w = computeReachable(E.p);
      var _ = findBridgeExtensions(R, w);
      if (_.length === 0) continue;
      _.sort(function(e, r) {
        return e.cost - r.cost;
      });
      var C = _[0];
      if (!S || C.cost < S.cost) {
        S = C;
      }
    }
    if (T) break;
    if (!S) break;
    var k = t[S.index];
    u.push(k);
    t.splice(S.index, 1);
    delete c[key(k.x, k.y)];
    delete d[tileKey(k.x, k.y)];
    delete n[tileKey(k.x, k.y)];
  }
  return {
    removedExtensions: u
  };
}

//        L              L L L L         L L L L              L
//       L L              L L L           L L                L L
//      L L L              L L           L L L            L L L
//     L L L L              L           L L L L          L L L L
//   (bottom-left)      (bottom-right)   (top-left)       (top-right)
function placeLabCluster(e, r, t, n) {
  if (n === undefined || n === null) n = 0;
  var a = bfsDistanceMap(e, r);
  function pathDist(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return Infinity;
    return a[r * 50 + e];
  }
  function chebFromAnchor(e, t) {
    var n = Math.abs(e - r.x);
    var a = Math.abs(t - r.y);
    return n > a ? n : a;
  }
  var i = [];
  i.push([ {
    x: 0,
    y: 0
  }, {
    x: 0,
    y: 1
  }, {
    x: 1,
    y: 1
  }, {
    x: 0,
    y: 2
  }, {
    x: 1,
    y: 2
  }, {
    x: 2,
    y: 2
  }, {
    x: 0,
    y: 3
  }, {
    x: 1,
    y: 3
  }, {
    x: 2,
    y: 3
  }, {
    x: 3,
    y: 3
  } ]);
  i.push([ {
    x: 3,
    y: 0
  }, {
    x: 2,
    y: 1
  }, {
    x: 3,
    y: 1
  }, {
    x: 1,
    y: 2
  }, {
    x: 2,
    y: 2
  }, {
    x: 3,
    y: 2
  }, {
    x: 0,
    y: 3
  }, {
    x: 1,
    y: 3
  }, {
    x: 2,
    y: 3
  }, {
    x: 3,
    y: 3
  } ]);
  i.push([ {
    x: 0,
    y: 0
  }, {
    x: 1,
    y: 0
  }, {
    x: 2,
    y: 0
  }, {
    x: 3,
    y: 0
  }, {
    x: 0,
    y: 1
  }, {
    x: 1,
    y: 1
  }, {
    x: 2,
    y: 1
  }, {
    x: 0,
    y: 2
  }, {
    x: 1,
    y: 2
  }, {
    x: 0,
    y: 3
  } ]);
  i.push([ {
    x: 0,
    y: 0
  }, {
    x: 1,
    y: 0
  }, {
    x: 2,
    y: 0
  }, {
    x: 3,
    y: 0
  }, {
    x: 1,
    y: 1
  }, {
    x: 2,
    y: 1
  }, {
    x: 3,
    y: 1
  }, {
    x: 2,
    y: 2
  }, {
    x: 3,
    y: 2
  }, {
    x: 3,
    y: 3
  } ]);
  var o = null;
  var l = Infinity;
  for (var u = -20; u <= 20; u++) {
    for (var s = -20; s <= 20; s++) {
      var f = r.x + u;
      var v = r.y + s;
      if (f < 1 || f > 45 || v < 1 || v > 45) continue;
      for (var c = 0; c < i.length; c++) {
        var d = i[c];
        var y = [];
        var p = 0;
        var h = true;
        for (var m = 0; m < d.length && h; m++) {
          var g = f + d[m].x;
          var x = v + d[m].y;
          if (g < 1 || g > 48 || x < 1 || x > 48) {
            h = false;
            break;
          }
          if (!isWalkableTile(e, g, x)) {
            h = false;
            break;
          }
          if (isBlocked(t, g, x)) {
            h = false;
            break;
          }
          if (chebFromAnchor(g, x) < n) {
            h = false;
            break;
          }
          var R = pathDist(g, x);
          if (R === Infinity) {
            h = false;
            break;
          }
          y.push({
            x: g,
            y: x
          });
          p += R;
        }
        if (!h || y.length < 10) continue;
        if (p < l) {
          l = p;
          o = y;
        }
      }
    }
  }
  if (o) return o;
  var T = [];
  var S = Math.max(n, 6);
  for (var b = S; b <= 20 && T.length < 10; b++) {
    for (var u = -b; u <= b && T.length < 10; u++) {
      for (var s = -b; s <= b && T.length < 10; s++) {
        if (Math.abs(u) > b || Math.abs(s) > b) continue;
        var E = r.x + u;
        var w = r.y + s;
        if (E < 1 || E > 48 || w < 1 || w > 48) continue;
        if (chebFromAnchor(E, w) < n) continue;
        if (!isWalkableTile(e, E, w)) continue;
        if (isBlocked(t, E, w)) continue;
        T.push({
          x: E,
          y: w
        });
      }
    }
  }
  if (T.length < 10) return null;
  return T;
}

//   [s1 link, storage link, s2 link, controller link, s1 link 2, s2 link 2]
function placeLinks(e, r, t, n, a) {
  function findStorageLink() {
    var t = [ {
      dx: 0,
      dy: -1
    }, {
      dx: 1,
      dy: 0
    }, {
      dx: 0,
      dy: 1
    }, {
      dx: -1,
      dy: 0
    }, {
      dx: 1,
      dy: -1
    }, {
      dx: 1,
      dy: 1
    }, {
      dx: -1,
      dy: 1
    }, {
      dx: -1,
      dy: -1
    } ];
    for (var i = 0; i < t.length; i++) {
      var o = r.x + t[i].dx;
      var l = r.y + t[i].dy;
      if (o < 1 || o > 48 || l < 1 || l > 48) continue;
      if (!isWalkableTile(e, o, l)) continue;
      if (isBlockedInfra(n, a, o, l)) continue;
      return {
        x: o,
        y: l
      };
    }
    return findNearestWalkableInfra(e, r.x, r.y, n, a, 2);
  }
  var i = findStorageLink();
  var o = null;
  if (t) {
    o = findNearestWalkableInfra(e, t.x, t.y, n, a, 2);
  }
  return {
    storageLink: i,
    ctrlLink: o
  };
}

function placeFarStructures(e, r, t, n, a, i) {
  var o = {
    nuker: null,
    powerSpawn: null,
    observer: null
  };
  var l = [];
  var u = r.x;
  var s = r.y;
  var f = r.y;
  if (t && t.length > 0) {
    for (var v = 0; v < t.length; v++) {
      if (t[v].x > u) u = t[v].x;
      if (t[v].y < s) s = t[v].y;
      if (t[v].y > f) f = t[v].y;
    }
  }
  function cheb(e, r) {
    return Math.max(Math.abs(e.x - r.x), Math.abs(e.y - r.y));
  }
  function tooCloseToLabs(e, r) {
    if (!n || n.length === 0) return false;
    for (var t = 0; t < n.length; t++) {
      if (cheb({
        x: e,
        y: r
      }, n[t]) <= 3) return true;
    }
    return false;
  }
  function isAdjacentToAnyExtension(e, r) {
    if (!t || t.length === 0) return false;
    for (var n = 0; n < t.length; n++) {
      if (cheb({
        x: e,
        y: r
      }, t[n]) <= 1) return true;
    }
    return false;
  }
  var c = [];
  if (t && t.length > 0) {
    var d = u;
    for (var v = 0; v < t.length; v++) {
      if (t[v].x < d) d = t[v].x;
    }
    var y = d - 1;
    var p = u + 1;
    var h = s - 1;
    var m = f + 1;
    if (y < 1) y = 1;
    if (p > 48) p = 48;
    if (h < 1) h = 1;
    if (m > 48) m = 48;
    for (var g = y; g <= p; g++) {
      c.push({
        x: g,
        y: h
      });
      c.push({
        x: g,
        y: m
      });
    }
    for (var x = h + 1; x <= m - 1; x++) {
      c.push({
        x: y,
        y: x
      });
      c.push({
        x: p,
        y: x
      });
    }
  }
  function validBoundaryTile(r, t) {
    if (r < 1 || r > 48 || t < 1 || t > 48) return false;
    if (!isWalkableTile(e, r, t)) return false;
    if (isBlocked(a, r, t)) return false;
    if (!isAdjacentToAnyExtension(r, t)) return false;
    if (tooCloseToLabs(r, t)) return false;
    return true;
  }
  var R = [];
  for (var T = 0; T < c.length; T++) {
    var S = c[T];
    if (!validBoundaryTile(S.x, S.y)) continue;
    R.push({
      x: S.x,
      y: S.y,
      d: dist(S, r)
    });
  }
  R.sort(function(e, r) {
    return e.d - r.d;
  });
  var b = null;
  var E = null;
  if (R.length > 0) {
    b = {
      x: R[0].x,
      y: R[0].y
    };
    for (var T = 1; T < R.length; T++) {
      var S = R[T];
      if (S.x === b.x && S.y === b.y) continue;
      if (cheb(S, b) <= 1) continue;
      E = {
        x: S.x,
        y: S.y
      };
      break;
    }
    if (!E) {
      for (var T = 1; T < R.length; T++) {
        var S = R[T];
        if (S.x === b.x && S.y === b.y) continue;
        E = {
          x: S.x,
          y: S.y
        };
        break;
      }
    }
  }
  if (!b) {
    var w = u + 1;
    if (w >= 1 && w <= 48) {
      for (var _ = s - 1; _ <= f + 1 && !b; _++) {
        if (_ < 1 || _ > 48) continue;
        if (!isWalkableTile(e, w, _)) continue;
        if (isBlocked(a, w, _)) continue;
        b = {
          x: w,
          y: _
        };
      }
    }
    if (!b) {
      b = findNearestWalkable(e, w, Math.round((s + f) / 2), a, 4);
    }
  }
  if (!E) {
    var C = b && b.x ? b.x + 1 : u + 1;
    E = findNearestWalkable(e, C, Math.round((s + f) / 2), a, 4);
  }
  o.nuker = b;
  o.powerSpawn = E;
  var k = placeObserver(e, r, a, i);
  o.observer = k.observer;
  if (k.warning) l.push(k.warning);
  o.warnings = l;
  return o;
}

function placeObserver(e, r, t, n) {
  var a = {};
  function markCheb(e, r, t) {
    for (var n = -t; n <= t; n++) {
      var i = e + n;
      if (i < 0 || i > 49) continue;
      for (var o = -t; o <= t; o++) {
        var l = r + o;
        if (l < 0 || l > 49) continue;
        a[l * 50 + i] = true;
      }
    }
  }
  if (n) {
    for (var i = 0; i < n.length; i++) {
      var o = n[i];
      if (!o) continue;
      markCheb(o.x, o.y, OBSERVER_MIN_CHEB);
    }
  }
  var l = null;
  var u = Infinity;
  var s = null;
  var f = Infinity;
  for (var v = 1; v <= 48; v++) {
    for (var c = 1; c <= 48; c++) {
      if (!isWalkableTile(e, v, c)) continue;
      if (isBlocked(t, v, c)) continue;
      if (a[c * 50 + v]) continue;
      var d = dist({
        x: v,
        y: c
      }, r);
      if (d < f) {
        f = d;
        s = {
          x: v,
          y: c
        };
      }
      if (d < OBSERVER_MAX_DIST && d < u) {
        u = d;
        l = {
          x: v,
          y: c
        };
      }
    }
  }
  if (l) {
    return {
      observer: l,
      warning: null
    };
  }
  if (s) {
    return {
      observer: s,
      warning: "observer: no candidate within dist<" + OBSERVER_MAX_DIST + " of storage and cheb>" + OBSERVER_MIN_CHEB + " from every building; " + "fell back to closest cheb-clear tile at (" + s.x + "," + s.y + "), dist=" + f.toFixed(1)
    };
  }
  var y = [ {
    x: 5,
    y: 5
  }, {
    x: 44,
    y: 5
  }, {
    x: 5,
    y: 44
  }, {
    x: 44,
    y: 44
  } ];
  y.sort(function(e, t) {
    return dist(t, r) - dist(e, r);
  });
  for (var p = 0; p < y.length; p++) {
    var h = findNearestWalkable(e, y[p].x, y[p].y, t, 5);
    if (h) {
      return {
        observer: h,
        warning: "observer: no cheb>" + OBSERVER_MIN_CHEB + " tile exists; fell back to far corner at (" + h.x + "," + h.y + ")"
      };
    }
  }
  return {
    observer: null,
    warning: "observer: no valid placement found anywhere in the room"
  };
}

function placeRampartsAndWalls(e, r, t, n, a) {
  var i = [];
  var o = [];
  var l = {};
  var u = {};
  function isRampartAt(e, r) {
    for (var t = 0; t < i.length; t++) {
      if (i[t].x === e && i[t].y === r) return true;
    }
    return false;
  }
  function hasExistingWallAt(r, t) {
    var n = tileKey(r, t);
    if (u[n] !== undefined) return u[n];
    var a = Game.rooms[e];
    var i = a.lookForAt(LOOK_STRUCTURES, r, t);
    for (var o = 0; o < i.length; o++) {
      if (i[o].structureType === STRUCTURE_WALL) {
        u[n] = true;
        return true;
      }
    }
    var l = a.lookForAt(LOOK_CONSTRUCTION_SITES, r, t);
    for (var s = 0; s < l.length; s++) {
      if (l[s].structureType === STRUCTURE_WALL) {
        u[n] = true;
        return true;
      }
    }
    u[n] = false;
    return false;
  }
  function hasExistingRampartAt(r, t) {
    var n = tileKey(r, t);
    if (l[n] !== undefined) return l[n];
    var a = Game.rooms[e];
    var i = a.lookForAt(LOOK_STRUCTURES, r, t);
    for (var o = 0; o < i.length; o++) {
      if (i[o].structureType === STRUCTURE_RAMPART) {
        l[n] = true;
        return true;
      }
    }
    var u = a.lookForAt(LOOK_CONSTRUCTION_SITES, r, t);
    for (var s = 0; s < u.length; s++) {
      if (u[s].structureType === STRUCTURE_RAMPART) {
        l[n] = true;
        return true;
      }
    }
    l[n] = false;
    return false;
  }
  function computeBoundingBox(e, r) {
    if (!r) r = 1;
    var t = 49, n = 49, a = 0, i = 0;
    for (var o = 0; o < e.length; o++) {
      if (e[o].x < t) t = e[o].x;
      if (e[o].y < n) n = e[o].y;
      if (e[o].x > a) a = e[o].x;
      if (e[o].y > i) i = e[o].y;
    }
    return {
      minX: Math.max(1, t - r),
      minY: Math.max(1, n - r),
      maxX: Math.min(48, a + r),
      maxY: Math.min(48, i + r)
    };
  }
  function placeBoxRamparts(r) {
    for (var t = r.minX; t <= r.maxX; t++) {
      for (var a = r.minY; a <= r.maxY; a++) {
        if (t > r.minX && t < r.maxX && a > r.minY && a < r.maxY) continue;
        if (t < 1 || t > 48 || a < 1 || a > 48) continue;
        if (!isWalkableTile(e, t, a)) continue;
        if (isBlocked(n, t, a)) continue;
        if (hasExistingWallAt(t, a) || hasExistingRampartAt(t, a)) continue;
        i.push({
          x: t,
          y: a
        });
      }
    }
  }
  function placePerimeterWalls(r, t) {
    if (!t) t = 2;
    var a = {
      minX: Math.max(1, r.minX - t),
      minY: Math.max(1, r.minY - t),
      maxX: Math.min(48, r.maxX + t),
      maxY: Math.min(48, r.maxY + t)
    };
    for (var i = a.minX; i <= a.maxX; i++) {
      for (var l = a.minY; l <= a.maxY; l++) {
        if (i > a.minX && i < a.maxX && l > a.minY && l < a.maxY) continue;
        if (i < 1 || i > 48 || l < 1 || l > 48) continue;
        if (!isWalkableTile(e, i, l)) continue;
        if (isBlocked(n, i, l)) continue;
        if (isRampartAt(i, l) || hasExistingRampartAt(i, l)) continue;
        o.push({
          x: i,
          y: l
        });
      }
    }
  }
  function placeExitDefenses(t) {
    if (!t || t.length === 0) return;
    var a = {};
    for (var l = 0; l < t.length; l++) {
      a[tileKey(t[l].x, t[l].y)] = true;
    }
    function tooCloseToExit(e, r) {
      for (var t = -2; t <= 2; t++) {
        for (var n = -2; n <= 2; n++) {
          if (a[tileKey(e + t, r + n)]) {
            var i = Math.abs(t);
            var o = Math.abs(n);
            var l = i > o ? i : o;
            if (l < 2) return true;
          }
        }
      }
      return false;
    }
    var u = groupExitTiles(t);
    for (var s = 0; s < u.length; s++) {
      var f = u[s];
      var v = [];
      var c = {};
      for (var d = 0; d < f.length; d++) {
        var y = f[d];
        for (var p = -2; p <= 2; p++) {
          for (var h = -2; h <= 2; h++) {
            var m = Math.abs(p);
            var g = Math.abs(h);
            var x = m > g ? m : g;
            if (x !== 2) continue;
            var R = y.x + p;
            var T = y.y + h;
            if (R < 1 || R > 48 || T < 1 || T > 48) continue;
            if (tooCloseToExit(R, T)) continue;
            var S = tileKey(R, T);
            if (c[S]) continue;
            c[S] = true;
            if (!isWalkableTile(e, R, T)) continue;
            if (isBlocked(n, R, T)) continue;
            if (hasExistingRampartAt(R, T)) continue;
            if (hasExistingWallAt(R, T)) continue;
            v.push({
              x: R,
              y: T
            });
          }
        }
      }
      if (v.length === 0) continue;
      var b = v[0];
      var E = dist(b, r);
      for (var w = 1; w < v.length; w++) {
        var _ = dist(v[w], r);
        if (_ < E) {
          b = v[w];
          E = _;
        }
      }
      i.push(b);
      for (var w = 0; w < v.length; w++) {
        var C = v[w];
        if (C.x === b.x && C.y === b.y) continue;
        if (isRampartAt(C.x, C.y)) continue;
        o.push(C);
      }
    }
  }
  //   var labBox = computeBoundingBox(labs, 1);
  //   placeBoxRamparts(labBox);
  //   placePerimeterWalls(labBox, 1);
    placeExitDefenses(a);
  for (var s = 0; s < i.length; s++) {
    blockTile(n, i[s].x, i[s].y);
  }
  for (var f = 0; f < o.length; f++) {
    blockTile(n, o[f].x, o[f].y);
  }
  return {
    ramparts: i,
    walls: o
  };
}

function snapSectionCenter(e, r, t, n) {
  for (var a = 0; a <= 2; a++) {
    for (var i = -a; i <= a; i++) {
      for (var o = -a; o <= a; o++) {
        if (Math.abs(i) !== a && Math.abs(o) !== a) continue;
        var l = e + i;
        var u = r + o;
        if (l < 0 || l > 49 || u < 0 || u > 49) continue;
        var s = u * 50 + l;
        if (t && t[s]) continue;
        if (n && n[s]) continue;
        return {
          x: l,
          y: u
        };
      }
    }
  }
  return {
    x: e,
    y: r
  };
}

function buildMovementForbidSet(e, r) {
  var t = {};
  if (r) {
    for (var n = 0; n < r.length; n++) {
      if (r[n]) t[tileKey(r[n].x, r[n].y)] = true;
    }
  }
  var a = {};
  for (var i in e) {
    if (!e.hasOwnProperty(i)) continue;
    if (t[i]) continue;
    var o = posFromKey(i);
    a[o.y * 50 + o.x] = true;
  }
  return a;
}

function getExtensionClusters(e, r) {
  if (!e || e.length === 0) return [];
  var t = e.slice();
  var n = [];
  function key(e, r) {
    return r * 50 + e;
  }
  function floodCluster(e) {
    var n = [ e ];
    var a = {};
    a[key(e.x, e.y)] = true;
    var i = [ {
      x: e.x,
      y: e.y
    } ];
    var o = 0;
    while (o < i.length) {
      if (o >= BFS_MAX_NODES) break;
      var l = i[o++];
      for (var u = -1; u <= 1; u++) {
        var s = l.x + u;
        if (s < 0 || s > 49) continue;
        for (var f = -1; f <= 1; f++) {
          if (u === 0 && f === 0) continue;
          var v = l.y + f;
          if (v < 0 || v > 49) continue;
          var c = key(s, v);
          if (r[c]) continue;
          if (a[c]) continue;
          a[c] = true;
          i.push({
            x: s,
            y: v
          });
        }
      }
    }
    for (var d = t.length - 1; d >= 0; d--) {
      var y = t[d];
      if (a[key(y.x, y.y)]) {
        n.push(y);
        t.splice(d, 1);
      }
    }
    return n;
  }
  while (t.length > 0) {
    var a = t.pop();
    n.push(floodCluster(a));
  }
  return n;
}

function buildTeleportPairs(e) {
  var r = {};
  if (!e) return r;
  for (var t = 0; t < e.length; t++) {
    var n = e[t];
    if (!n || !n.entrance || !n.exit) continue;
    var a = n.entrance.y * 50 + n.entrance.x;
    var i = n.exit.y * 50 + n.exit.x;
    r[a] = i;
    r[i] = a;
  }
  return r;
}

function findTunnelWindow(e, r, t, n, a, i, o, l) {
  //  - a' is on the a-side of the wall band separating a from b
  //  - b' is on the b-side
  //  - chebyshev(a', b') <= 1 (engine adjacency rule for STRUCTURE_TUNNEL)
  //  - both tiles are >= 1 from any exit (engine rule, already enforced
  //    by blocked)
  //  - a' and b' are not blocked by a non-defense structure. They may
  //    overlap planned ramparts/walls because tunnels are intentional
  //    breaches; the caller will remove those defensive tiles.
  //  - there is at least one terrain wall tile between a' and b' —
  //    otherwise this is not a tunnel, just a walkable pair on the same
  //    side of the room.
  function key(e, r) {
    return r * 50 + e;
  }
  function floodFrom(e) {
    var r = {};
    var t = key(e.x, e.y);
    if (a[t]) return r;
    var n = [ t ];
    var i = 0;
    r[t] = 0;
    while (i < n.length) {
      if (i >= BFS_MAX_NODES) break;
      var o = n[i++];
      var l = o % 50;
      var u = (o - l) / 50;
      for (var s = -1; s <= 1; s++) {
        var f = l + s;
        if (f < 0 || f > 49) continue;
        for (var v = -1; v <= 1; v++) {
          if (s === 0 && v === 0) continue;
          var c = u + v;
          if (c < 0 || c > 49) continue;
          var d = c * 50 + f;
          if (a[d]) continue;
          if (r[d] !== undefined) continue;
          r[d] = r[o] + 1;
          n.push(d);
        }
      }
    }
    return r;
  }
  var u = floodFrom(r);
  if (u[key(t.x, t.y)] !== undefined) {
    return null;
  }
  var s = u;
  var f = floodFrom(t);
  l("findTunnelWindow: reachA=" + Object.keys(s).length + " reachB=" + Object.keys(f).length);
  function hasWallBetween(e, r, t, n) {
    var i = Math.min(e, t), o = Math.max(e, t);
    var l = Math.min(r, n), u = Math.max(r, n);
    for (var s = i; s <= o; s++) {
      for (var f = l; f <= u; f++) {
        if (a[key(s, f)]) return true;
      }
    }
    return false;
  }
  var v = null;
  var c = Infinity;
  for (var d in s) {
    if (!s.hasOwnProperty(d)) continue;
    var y = d % 50;
    var p = (d - y) / 50;
    if (a[d]) continue;
    if (isBlocked(n, y, p) && !o[tileKey(y, p)]) continue;
    var h = s[d];
    for (var m = -1; m <= 1; m++) {
      var g = y + m;
      if (g < 0 || g > 49) continue;
      for (var x = -1; x <= 1; x++) {
        if (m === 0 && x === 0) continue;
        var R = p + x;
        if (R < 0 || R > 49) continue;
        var T = R * 50 + g;
        if (f[T] === undefined) continue;
        if (a[T]) continue;
        if (isBlocked(n, g, R) && !o[tileKey(g, R)]) continue;
        if (!hasWallBetween(y, p, g, R)) continue;
        var S = h + f[T];
        if (S < c) {
          c = S;
          v = {
            entrance: {
              x: y,
              y: p
            },
            exit: {
              x: g,
              y: R
            }
          };
        }
      }
    }
  }
  return v;
}

function placeTunnels(e, r, t, n, a, i, o, l, u, s, f, v, c, d) {
  var y = [];
  var p = [];
  var h = buildWallSet(e);
  var m = heap.autoBuilder && heap.autoBuilder.debugTunnels && heap.autoBuilder.debugTunnels[e];
  function log(r) {
    if (m) console.log("[autoBuilder tunnels " + e + "] " + r);
  }
  var g = {};
  var x = {};
  if (c) {
    for (var R = 0; R < c.length; R++) {
      var T = tileKey(c[R].x, c[R].y);
      g[T] = true;
      x[T] = {
        type: "rampart",
        x: c[R].x,
        y: c[R].y
      };
    }
  }
  if (d) {
    for (var S = 0; S < d.length; S++) {
      var b = tileKey(d[S].x, d[S].y);
      g[b] = true;
      x[b] = {
        type: "wall",
        x: d[S].x,
        y: d[S].y
      };
    }
  }
  log("defense tiles: ramparts=" + (c ? c.length : 0) + " walls=" + (d ? d.length : 0));
  var E = null;
  if (i && i.length > 0) {
    var w = 0, _ = 0;
    for (var C = 0; C < i.length; C++) {
      w += i[C].x;
      _ += i[C].y;
    }
    E = {
      x: Math.round(w / i.length),
      y: Math.round(_ / i.length)
    };
  }
  var k = [ {
    label: "anchor",
    p: r
  }, {
    label: "s1",
    p: t
  }, {
    label: "s2",
    p: n
  } ];
  if (a) k.push({
    label: "controller",
    p: a
  });
  if (E) k.push({
    label: "labs",
    p: E
  });
  if (o) k.push({
    label: "mineral",
    p: o
  });
  var A = getExtensionClusters(l, h);
  for (var O = 0; O < A.length; O++) {
    var B = A[O];
    if (B.length === 0) continue;
    var U = 0, M = 0;
    for (var N = 0; N < B.length; N++) {
      U += B[N].x;
      M += B[N].y;
    }
    k.push({
      label: "extensions" + O,
      p: {
        x: Math.round(U / B.length),
        y: Math.round(M / B.length)
      }
    });
  }
  for (var L = 0; L < k.length; L++) {
    k[L].p = snapSectionCenter(k[L].p.x, k[L].p.y, h, s);
  }
  log("section centers: " + k.map(function(e) {
    return e.label + "(" + e.p.x + "," + e.p.y + ")";
  }).join(", "));
  function isWallTile(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return true;
    return !!h[r * 50 + e];
  }
  var I = [];
  var P = s;
  function findWorstPair(r, t) {
    var n = null;
    for (var a = 0; a < k.length; a++) {
      for (var i = a + 1; i < k.length; i++) {
        var o = k[a].p;
        var l = k[i].p;
        if (!o || !l) continue;
        if (isWallTile(o.x, o.y) || isWallTile(l.x, l.y)) continue;
        if (o.x === l.x && o.y === l.y) continue;
        var u = a + "-" + i;
        if (t && t[u]) continue;
        var s = countEdgeDisjointPaths(e, o, l, P, null, TUNNEL_TARGET_PATHS, h, r);
        if (s < TUNNEL_TARGET_PATHS) {
          if (!n || s < n.count) {
            n = {
              i: a,
              j: i,
              count: s,
              a: o,
              b: l,
              labelA: k[a].label,
              labelB: k[i].label
            };
          }
        }
      }
    }
    return n;
  }
  var W = {};
  var D = 0;
  while (D < TUNNEL_SAFETY_MAX) {
    D++;
    var F = buildTeleportPairs(y);
    var G = findWorstPair(F, W);
    if (!G) break;
    log("iteration " + D + ": worst pair " + G.labelA + " -> " + G.labelB + " has " + G.count + " disjoint paths");
    var K = findTunnelWindow(e, G.a, G.b, u, h, f, g, log);
    if (!K) {
      //  - the pair is already at TUNNEL_MIN_PATHS (skip, acceptable)
      //  - no wall separates the pair (failure is due to impassable
      //    structures, not walls — a tunnel can't help)
      //  - no walkable adjacent window exists across the wall band
      log("no tunnel window found for " + G.labelA + " -> " + G.labelB);
      W[G.i + "-" + G.j] = true;
      if (G.count < TUNNEL_MIN_PATHS) {
        p.push("sections " + G.labelA + "(" + G.a.x + "," + G.a.y + ") and " + G.labelB + "(" + G.b.x + "," + G.b.y + ") have only " + G.count + " disjoint path(s) and no tunnel can be placed; " + "layout is degraded — consider relocating the anchor via autoBuilder.setAnchor");
      }
      continue;
    }
    log("placed tunnel at (" + K.entrance.x + "," + K.entrance.y + ") -> (" + K.exit.x + "," + K.exit.y + ")");
    blockTile(u, K.entrance.x, K.entrance.y);
    blockTile(u, K.exit.x, K.exit.y);
    I.push(K.entrance);
    I.push(K.exit);
    y.push(K);
    var X = (v || []).concat(I);
    P = buildMovementForbidSet(u, X);
  }
  log("finished: placed " + y.length + " tunnel(s), warnings=" + p.length);
  return {
    tunnels: y,
    warnings: p
  };
}

function placeConnectorRoads(e, r, t, n, a, i, o, l, u, s) {
  var f = [];
  var v = null;
  if (i && i.length > 0) {
    var c = 0, d = 0;
    for (var y = 0; y < i.length; y++) {
      c += i[y].x;
      d += i[y].y;
    }
    v = {
      x: Math.round(c / i.length),
      y: Math.round(d / i.length)
    };
  }
  var p = [ r, t, n ];
  if (a) p.push(a);
  if (v) p.push(v);
  if (o) p.push(o);
  var h = buildWallSet(e);
  for (var m = 0; m < p.length; m++) {
    p[m] = snapSectionCenter(p[m].x, p[m].y, h, u);
  }
  function isWallTile(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return true;
    return !!h[r * 50 + e];
  }
  function key(e, r) {
    return r * 50 + e;
  }
  var g = {};
  function commitPath(r) {
    if (!r) return;
    for (var t = 0; t < r.length; t++) {
      var n = r[t];
      if (isWallTile(n.x, n.y)) continue;
      if (isBlocked(l, n.x, n.y)) continue;
      if (!isSwamp(e, n.x, n.y)) continue;
      var a = tileKey(n.x, n.y);
      if (g[a]) continue;
      g[a] = true;
    }
  }
  function bfsCheapestPath(e, r, t) {
    var n = key(e.x, e.y);
    var a = key(r.x, r.y);
    if (h[n] || h[a]) return null;
    var i = {};
    var o = {};
    i[n] = 0;
    var l = [ n ];
    var f = 0;
    var v = null;
    while (f < l.length) {
      if (f >= BFS_MAX_NODES) break;
      var c = -1, d = Infinity;
      for (var y = f; y < l.length; y++) {
        if (i[l[y]] < d) {
          d = i[l[y]];
          c = y;
        }
      }
      if (c < 0) break;
      var p = l[c];
      l[c] = l[f];
      l[f] = p;
      f++;
      if (p === a) {
        v = p;
        break;
      }
      var m = p % 50;
      var x = (p - m) / 50;
      for (var R = -1; R <= 1; R++) {
        var T = m + R;
        if (T < 0 || T > 49) continue;
        for (var S = -1; S <= 1; S++) {
          if (R === 0 && S === 0) continue;
          var b = x + S;
          if (b < 0 || b > 49) continue;
          var E = b * 50 + T;
          if (h[E]) continue;
          var w = Math.min(p, E) + "|" + Math.max(p, E);
          if (t && t[w]) continue;
          if (u && u[E]) continue;
          var _ = g[tileKey(T, b)] ? 0 : 1;
          var C = i[p] + _;
          if (i[E] === undefined || C < i[E]) {
            i[E] = C;
            o[E] = p;
            l.push(E);
          }
        }
      }
      if (s && s[p] !== undefined) {
        var k = s[p];
        if (k !== p) {
          if (!h[k] && (!u || !u[k])) {
            var A = Math.min(p, k) + "|" + Math.max(p, k);
            if (!t || !t[A]) {
              var O = g[tileKey(k % 50, Math.floor(k / 50))] ? 0 : 1;
              var B = i[p] + O;
              if (i[k] === undefined || B < i[k]) {
                i[k] = B;
                o[k] = p;
                l.push(k);
              }
            }
          }
        }
      }
    }
    if (!v) return null;
    var U = [];
    var M = v;
    while (M !== undefined && M >= 0) {
      var N = M % 50;
      var L = (M - N) / 50;
      U.push({
        x: N,
        y: L
      });
      M = o[M];
    }
    U.reverse();
    return U;
  }
  var x = [];
  for (var R = 0; R < p.length; R++) {
    if (p[R] && !isWallTile(p[R].x, p[R].y)) x.push(p[R]);
  }
  if (x.length < 2) return f;
  var T = [];
  for (var S = 0; S < x.length; S++) {
    for (var b = S + 1; b < x.length; b++) {
      var E = bfsCheapestPath(x[S], x[b], null);
      var w = E ? E.length : Infinity;
      T.push({
        i: S,
        j: b,
        a: x[S],
        b: x[b],
        len: w
      });
    }
  }
  T.sort(function(e, r) {
    return e.len - r.len;
  });
  var _ = [];
  for (var S = 0; S < x.length; S++) _.push(S);
  function find(e) {
    while (_[e] !== e) {
      _[e] = _[_[e]];
      e = _[e];
    }
    return e;
  }
  function union(e, r) {
    _[find(e)] = find(r);
  }
  var C = [];
  for (var k = 0; k < T.length; k++) {
    var A = T[k];
    if (A.len === Infinity) continue;
    if (find(A.i) === find(A.j)) continue;
    union(A.i, A.j);
    C.push(A);
    if (C.length >= x.length - 1) break;
  }
  for (var k = 0; k < C.length; k++) {
    var A = C[k];
    var O = bfsCheapestPath(A.a, A.b, null);
    if (O) commitPath(O);
  }
  for (var k = 0; k < C.length; k++) {
    var A = C[k];
    var B = countEdgeDisjointPaths(e, A.a, A.b, u, null, 2, h, s);
    if (B >= 2) continue;
    var U = {};
    for (var M in g) {
      if (!g.hasOwnProperty(M)) continue;
      var N = posFromKey(M);
      var L = key(N.x, N.y);
      for (var I = -1; I <= 1; I++) {
        for (var P = -1; P <= 1; P++) {
          if (I === 0 && P === 0) continue;
          var W = N.x + I, D = N.y + P;
          if (W < 0 || W > 49 || D < 0 || D > 49) continue;
          var F = key(W, D);
          U[Math.min(L, F) + "|" + Math.max(L, F)] = true;
        }
      }
    }
    var G = bfsCheapestPath(A.a, A.b, null);
    if (G) {
      for (var K = 0; K < G.length - 1; K++) {
        var X = key(G[K].x, G[K].y);
        var j = key(G[K + 1].x, G[K + 1].y);
        U[Math.min(X, j) + "|" + Math.max(X, j)] = true;
      }
    }
    var H = bfsCheapestPath(A.a, A.b, U);
    if (H) commitPath(H);
  }
  var V = Object.keys(g);
  for (var Y = 0; Y < V.length; Y++) {
    var N = posFromKey(V[Y]);
    f.push(N);
    blockTile(l, N.x, N.y);
  }
  return f;
}

function verifyConnectivity(e, r, t, n, a, i, o, l, u) {
  var s = [];
  var f = null;
  if (i && i.length > 0) {
    var v = 0, c = 0;
    for (var d = 0; d < i.length; d++) {
      v += i[d].x;
      c += i[d].y;
    }
    f = {
      x: Math.round(v / i.length),
      y: Math.round(c / i.length)
    };
  }
  var y = [ {
    label: "anchor",
    p: r
  }, {
    label: "s1",
    p: t
  }, {
    label: "s2",
    p: n
  } ];
  if (a) y.push({
    label: "controller",
    p: a
  });
  if (f) y.push({
    label: "labs",
    p: f
  });
  if (o) y.push({
    label: "mineral",
    p: o
  });
  var p = buildWallSet(e);
  function isWallTile(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return true;
    return !!p[r * 50 + e];
  }
  for (var h = 0; h < y.length; h++) {
    var m = y[h];
    m.p = snapSectionCenter(m.p.x, m.p.y, p, l);
  }
  for (var g = 0; g < y.length; g++) {
    for (var x = g + 1; x < y.length; x++) {
      var R = y[g].p;
      var T = y[x].p;
      if (!R || !T) continue;
      if (isWallTile(R.x, R.y) || isWallTile(T.x, T.y)) continue;
      if (R.x === T.x && R.y === T.y) continue;
      var S = countEdgeDisjointPaths(e, R, T, l, null, REQUIRED_DISJOINT_PATHS, p, u);
      if (S < REQUIRED_DISJOINT_PATHS) {
        s.push("sections " + y[g].label + "(" + R.x + "," + R.y + ") and " + y[x].label + "(" + T.x + "," + T.y + ") have only " + S + " disjoint path(s); required " + REQUIRED_DISJOINT_PATHS);
      }
    }
  }
  return s;
}

function placeSwampRoads(e, r, t) {
  var n = [];
  for (var a = -5; a <= 5; a++) {
    for (var i = -5; i <= 5; i++) {
      var o = r.x + a;
      var l = r.y + i;
      if (o < 1 || o > 48 || l < 1 || l > 48) continue;
      if (!isSwamp(e, o, l)) continue;
      if (isBlocked(t, o, l)) continue;
      n.push({
        x: o,
        y: l
      });
      blockTile(t, o, l);
    }
  }
  return n;
}

function placeExtensionGapRoads(e, r, t, n) {
  var a = [];
  var i = {};
  for (var o = 0; o < t.length; o++) {
    i[tileKey(t[o].x, t[o].y)] = true;
  }
  var l = [ {
    dx: 1,
    dy: 0
  }, {
    dx: -1,
    dy: 0
  }, {
    dx: 0,
    dy: 1
  }, {
    dx: 0,
    dy: -1
  } ];
  for (var u = 0; u < t.length; u++) {
    var s = t[u];
    for (var f = 0; f < l.length; f++) {
      var v = l[f];
      var c = s.x + v.dx;
      var d = s.y + v.dy;
      if (c < 1 || c > 48 || d < 1 || d > 48) continue;
      if (!isSwamp(e, c, d)) continue;
      if (i[tileKey(c, d)]) continue;
      if (isBlocked(n, c, d)) continue;
      a.push({
        x: c,
        y: d
      });
      blockTile(n, c, d);
    }
  }
  return a;
}

function computeRCLStage(e, r) {
  var t = RCL_STRUCTURES[r];
  if (!t) return [];
  var n = [];
  for (var a = 0; a < STRUCTURE_ORDER.length; a++) {
    var i = STRUCTURE_ORDER[a];
    var o = t[i] || 0;
    if (o <= 0) continue;
    if (i === "tunnel" && r < 3) continue;
    var l = e[i];
    if (!l) continue;
    if (!Array.isArray(l)) l = [ l ];
    var u = 0;
    for (var s = 0; s < l.length && u < o; s++) {
      if (!l[s]) continue;
      if (e.mineralContainer && l[s].x === e.mineralContainer.x && l[s].y === e.mineralContainer.y) continue;
      n.push({
        x: l[s].x,
        y: l[s].y,
        type: categoryToStructureType(i),
        stage: r
      });
      u++;
    }
  }
  if (r >= 6 && e.mineralContainer) {
    n.push({
      x: e.mineralContainer.x,
      y: e.mineralContainer.y,
      type: STRUCTURE_CONTAINER,
      stage: 6
    });
  }
  return n;
}

function categoryToStructureType(e) {
  var r = {
    spawn: STRUCTURE_SPAWN,
    extension: STRUCTURE_EXTENSION,
    tower: STRUCTURE_TOWER,
    lab: STRUCTURE_LAB,
    storage: STRUCTURE_STORAGE,
    terminal: STRUCTURE_TERMINAL,
    factory: STRUCTURE_FACTORY,
    link: STRUCTURE_LINK,
    nuker: STRUCTURE_NUKER,
    powerSpawn: STRUCTURE_POWER_SPAWN,
    observer: STRUCTURE_OBSERVER,
    extractor: STRUCTURE_EXTRACTOR,
    container: STRUCTURE_CONTAINER,
    rampart: STRUCTURE_RAMPART,
    wall: STRUCTURE_WALL,
    road: STRUCTURE_ROAD,
    tunnel: typeof STRUCTURE_TUNNEL !== "undefined" ? STRUCTURE_TUNNEL : "tunnel"
  };
  return r[e] || e;
}

function getOrRefreshPlan(e, r) {
  var t = getPlan(e);
  if (r && shouldDeferForCpu()) return t;
  var n = Game.rooms[e];
  var a = n && n.controller ? n.controller.level : 0;
  var i = getProgress(e);
  var o = false;
  if (r) {
    o = true;
  } else if (!t || !t.layout || hasLegacyLayoutKeys(t.layout)) {
    o = true;
  } else if (t.rcl !== a) {
    o = true;
  }
  if (o) {
    var l = deriveLayout(e);
    if (!l) return null;
    var u = i && i.emitted ? i.emitted : {};
    var s = {};
    for (var f in u) {
      if (!u.hasOwnProperty(f)) continue;
      if (f.indexOf("stageDone_") === 0 || /^\d+$/.test(f)) continue;
      s[f] = u[f];
    }
    t = {
      layout: l,
      emitted: s,
      lastEmitTick: i ? i.lastEmitTick : 0,
      derivedAt: Game.time,
      rcl: a,
      status: t ? t.status : "preview"
    };
    setPlan(e, t);
  }
  return t;
}

function recordProgress(e, r, t) {
  var n = getProgress(e) || {
    emitted: {}
  };
  if (!n.emitted) n.emitted = {};
  for (var a in t) {
    if (t.hasOwnProperty(a)) n.emitted[a] = true;
  }
  n.lastEmitTick = Game.time;
  n.lastRCL = r;
  setProgress(e, n);
}

function emitSites(e) {
  if (shouldDeferForCpu()) return;
  var r = Game.rooms[e];
  if (!r || !r.controller) return;
  var t = r.controller.level;
  var n = getBuildOp(e);
  if (!n || n.phase !== "building") return;
  var a = getProgress(e) || {
    emitted: {}
  };
  if (!a.emitted) a.emitted = {};
  var i = getOrRefreshPlan(e);
  if (!i) {
    setError(e, "Could not derive layout for " + e + " (strict source pod may not fit); build stalled.");
    return;
  }
  if (n.lastFullAt && Game.time - n.lastFullAt < 1e3) {
    console.log("[autoBuilder] " + e + " throttled: construction site cap reached at tick " + n.lastFullAt + ", resuming in " + (n.lastFullAt + 1e3 - Game.time) + " ticks.");
    return;
  }
  if (!i.emitted) i.emitted = {};
  var o = RCL_SITE_CAPS[t] || 5;
  var l = 0;
  var u = {};
  var s = false;
  var f = false;
  for (var v = 1; v <= t && !f; v++) {
    var c = "stageDone_" + v;
    if (i.emitted[c]) continue;
    var d = computeRCLStage(i.layout, v);
    if (d.length === 0) {
      i.emitted[c] = true;
      u[c] = true;
      continue;
    }
    var y = true;
    for (var p = 0; p < d.length; p++) {
      if (l >= o) {
        y = false;
        s = true;
        break;
      }
      var h = d[p];
      var m = v + "_" + h.type + "_" + h.x + "_" + h.y;
      if (h.type === STRUCTURE_RAMPART) {
        var g = false;
        var x = r.lookForAt(LOOK_STRUCTURES, h.x, h.y);
        for (var R = 0; R < x.length; R++) {
          if (x[R].structureType === STRUCTURE_WALL) {
            g = true;
            break;
          }
        }
        if (!g) {
          var T = r.lookForAt(LOOK_CONSTRUCTION_SITES, h.x, h.y);
          for (var S = 0; S < T.length; S++) {
            if (T[S].structureType === STRUCTURE_WALL) {
              g = true;
              break;
            }
          }
        }
        if (g) {
          var b = r.lookForAt(LOOK_CONSTRUCTION_SITES, h.x, h.y);
          for (var E = 0; E < b.length; E++) {
            if (b[E].structureType === STRUCTURE_RAMPART && b[E].my && typeof b[E].remove === "function") {
              b[E].remove();
            }
          }
          i.emitted[m] = true;
          u[m] = true;
          continue;
        }
      }
      if (h.type === STRUCTURE_WALL) {
        var w = false;
        var _ = r.lookForAt(LOOK_STRUCTURES, h.x, h.y);
        for (var C = 0; C < _.length; C++) {
          if (_[C].structureType === STRUCTURE_RAMPART) {
            w = true;
            break;
          }
        }
        if (!w) {
          var k = r.lookForAt(LOOK_CONSTRUCTION_SITES, h.x, h.y);
          for (var A = 0; A < k.length; A++) {
            if (k[A].structureType === STRUCTURE_RAMPART) {
              w = true;
              break;
            }
          }
        }
        if (w) {
          var O = r.lookForAt(LOOK_CONSTRUCTION_SITES, h.x, h.y);
          for (var B = 0; B < O.length; B++) {
            if (O[B].structureType === STRUCTURE_WALL && O[B].my && typeof O[B].remove === "function") {
              O[B].remove();
            }
          }
          i.emitted[m] = true;
          u[m] = true;
          continue;
        }
      }
      if (i.emitted[m]) continue;
      y = false;
      var U = r.lookForAt(LOOK_STRUCTURES, h.x, h.y);
      var M = false;
      for (var N = 0; N < U.length; N++) {
        var L = U[N].structureType;
        if (L === h.type || h.type === STRUCTURE_WALL && L === STRUCTURE_RAMPART || h.type === STRUCTURE_RAMPART && L === STRUCTURE_WALL) {
          M = true;
          break;
        }
      }
      if (M) {
        i.emitted[m] = true;
        u[m] = true;
        continue;
      }
      var I = r.lookForAt(LOOK_CONSTRUCTION_SITES, h.x, h.y);
      var P = false;
      for (var W = 0; W < I.length; W++) {
        if (I[W].structureType === h.type) {
          P = true;
          break;
        }
      }
      if (P) {
        i.emitted[m] = true;
        u[m] = true;
        continue;
      }
      var D = r.createConstructionSite(h.x, h.y, h.type);
      if (D === OK) {
        i.emitted[m] = true;
        u[m] = true;
        l++;
        i.lastEmitTick = Game.time;
        if (n.lastFullAt) {
          delete n.lastFullAt;
          setBuildOp(e, n);
        }
      } else if (D === ERR_FULL) {
        n.lastFullAt = Game.time;
        setBuildOp(e, n);
        s = true;
        f = true;
        break;
      } else if (D === ERR_INVALID_ARGS || D === ERR_RCL_NOT_ENOUGH || D === ERR_INVALID_TARGET) {
        i.emitted[m] = true;
        u[m] = true;
        console.log("[autoBuilder] Skipping " + h.type + " at " + h.x + "," + h.y + " in " + e + ": createConstructionSite returned " + D);
      } else if (D === ERR_NOT_OWNER) {
        setError(e, "Lost ownership of " + e + " during build; aborting.");
        n.phase = "error";
        n.status = "error";
        setBuildOp(e, n);
        console.log("[autoBuilder] " + e + " aborted: ERR_NOT_OWNER at " + h.x + "," + h.y);
        return;
      }
    }
    if (y) {
      i.emitted[c] = true;
      u[c] = true;
    }
  }
  if (Object.keys(u).length > 0) {
    recordProgress(e, t, u);
    memoryManager.requestSave();
  } else if (a.lastRCL !== t) {
    a.lastRCL = t;
    setProgress(e, a);
    memoryManager.requestSave();
  }
  if (l > 0) {
    console.log("[autoBuilder] Emitted " + l + " sites for " + e + " at RCL " + t);
  }
  if (!s && i.emitted["stageDone_" + t] && t >= 8) {
    n.phase = "complete";
    n.status = "complete";
    setBuildOp(e, n);
    console.log("[autoBuilder] " + e + " RCL 8 build complete.");
  }
}

function drawPreviewVisuals(e) {
  var r = getPlan(e);
  if (!r || !r.layout) return;
  var t = new RoomVisual(e);
  t.clear();
  var n = r.layout;
  for (var a in VISUAL_LETTERS) {
    if (!VISUAL_LETTERS.hasOwnProperty(a)) continue;
    var i = n[a];
    if (!i) continue;
    if (!Array.isArray(i)) i = [ i ];
    var o = VISUAL_LETTERS[a];
    var l = VISUAL_COLORS[a];
    for (var u = 0; u < i.length; u++) {
      var s = i[u];
      if (!s) continue;
      t.text(o, s.x, s.y, {
        color: l,
        font: .5,
        opacity: .85
      });
    }
  }
  if (n.tunnel && n.tunnel.length >= 2) {
    for (var f = 0; f < n.tunnel.length; f += 2) {
      var v = n.tunnel[f];
      var c = n.tunnel[f + 1];
      if (!v || !c) continue;
      t.line(v.x, v.y, c.x, c.y, {
        color: "#ff00ff",
        width: .3,
        opacity: .9
      });
      t.circle(v.x, v.y, {
        radius: .4,
        fill: "transparent",
        stroke: "#ff00ff",
        strokeWidth: .15,
        opacity: .9
      });
      t.circle(c.x, c.y, {
        radius: .4,
        fill: "transparent",
        stroke: "#ff00ff",
        strokeWidth: .15,
        opacity: .9
      });
    }
  }
}

function hasLegacyLayoutKeys(e) {
  var r = [ "towers", "extensions", "labs", "links", "containers", "ramparts", "walls", "roads", "spawns" ];
  for (var t = 0; t < r.length; t++) {
    if (e[r[t]] !== undefined) return true;
  }
  return false;
}

function clearPreview(e) {
  ensureHeap().previews[e] = null;
  var r = new RoomVisual(e);
  r.clear();
  return "Preview cleared for " + e + ".";
}

function drawPreview(e) {
  var r = getOrRefreshPlan(e, true);
  if (!r) return "Could not derive layout for " + e + ". Check terrain and source positions.";
  drawPreviewVisuals(e);
  ensureHeap().previews[e] = {
    expiresAt: Game.time + PREVIEW_TTL,
    lastDrawn: Game.time
  };
  return "Preview drawn for " + e + ". Auto-clears at tick " + (Game.time + PREVIEW_TTL) + ".";
}

function tickPreviews() {
  var e = ensureHeap().previews;
  for (var r in e) {
    var t = e[r];
    if (!t) {
      delete e[r];
      continue;
    }
    if (Game.time >= t.expiresAt) {
      clearPreview(r);
      continue;
    }
    if (Game.time > t.lastDrawn) {
      t.lastDrawn = Game.time;
      drawPreviewVisuals(r);
    }
  }
}

function preflightCheck(e) {
  var r = getRoomState.get(e);
  if (!r) {
    return "No data for " + e + ". Ensure an observer has vision, or a creep is in the room.";
  }
  if (!r.structuresByType) {
    return "No structure data for " + e + ".";
  }
  var t = 0;
  var n = [];
  for (var a in r.structuresByType) {
    if (!r.structuresByType.hasOwnProperty(a)) continue;
    if (a === STRUCTURE_WALL || a === STRUCTURE_RAMPART || a === STRUCTURE_CONTROLLER) continue;
    var i = r.structuresByType[a];
    if (i && i.length > 0) {
      t += i.length;
      if (n.length < 5) n.push(a + ":" + i.length);
    }
  }
  if (t > 0) {
    if (!(Memory.autoBuilder.progress || {})[e]) {
      return "Refused: " + e + " has " + t + " non-wall/rampart structures (" + n.join(", ") + "). autoBuilder only handles greenfield construction.";
    }
  }
  if (r.controller && r.controller.owner) {
    var o = r.controller.owner;
    var l = "";
    var u = Object.keys(Game.spawns);
    if (u.length > 0) l = Game.spawns[u[0]].owner.username;
    if (o !== l && l) {
      return "Refused: " + e + " is owned by " + o + ". autoBuilder will not build on enemy territory.";
    }
  }
  return null;
}

function findClosestOwnedRoomWithFreeSpawn(e) {
  var r = getRoomState.ownedNames();
  if (!r || r.length === 0) return null;
  var t = null;
  var n = Infinity;
  for (var a = 0; a < r.length; a++) {
    var i = r[a];
    var o = Game.map.findRoute(i, e);
    if (o === ERR_NO_PATH || !o) continue;
    var l = o.length;
    if (l < n) {
      var u = Game.rooms[i];
      if (!u) continue;
      var s = u.find(FIND_MY_SPAWNS);
      var f = false;
      for (var v = 0; v < s.length; v++) {
        if (!s[v].spawning) {
          f = true;
          break;
        }
      }
      if (f) {
        n = l;
        t = i;
      }
    }
  }
  return t;
}

function startClaimFlow(e, r) {
  if (!r) {
    r = findClosestOwnedRoomWithFreeSpawn(e);
    if (!r) return "No owned room with a free spawn found within range of " + e + ".";
  }
  var t = roleClaimbot.spawn(r, e);
  console.log("[autoBuilder] Claim spawn: " + t);
  if (typeof t !== "string" || t.indexOf("✅") !== 0) {
    var n = "Could not spawn claimer for " + e + ": " + t;
    setError(e, n);
    return n;
  }
  var a = getBuildOp(e) || {};
  a.phase = "claiming";
  a.sourceRoom = r;
  a.startedAt = Game.time;
  a.status = "claiming";
  a.claimerName = null;
  setBuildOp(e, a);
  return "Claimer spawning from " + r + " to " + e + ".";
}

function monitorClaimFlow(e) {
  var r = getBuildOp(e);
  if (!r || r.phase !== "claiming") return;
  var t = getRoomState.get(e);
  if (!t) return;
  if (t.owned) {
    console.log("[autoBuilder] " + e + " claimed successfully. Starting remote builder.");
    startRemoteBuildFlow(e, r.sourceRoom);
    return;
  }
  if (t.controller && t.controller.reservation && t.controller.reservation.username) {
    var n = "";
    var a = Object.keys(Game.spawns);
    if (a.length > 0) n = Game.spawns[a[0]].owner.username;
    if (t.controller.reservation.username === n) {
      if (Game.time - r.startedAt > 1500) {
        console.log("[autoBuilder] " + e + " reserved by us for 1500+ ticks. Spawning another claimer.");
        startClaimFlow(e, r.sourceRoom);
        r.startedAt = Game.time;
        setBuildOp(e, r);
      }
    }
  }
  if (Game.time - r.startedAt > 3e3) {
    setError(e, "Claim timed out after 3000 ticks for " + e);
    r.phase = "error";
    r.status = "error";
    setBuildOp(e, r);
    delete ensureHeap().previews[e];
    console.log("[autoBuilder] Claim timed out for " + e);
  }
}

function startRemoteBuildFlow(e, r) {
  global.remoteBuilder(r, e, 1);
  markAutoBuilderRemoteOrder(r, e);
  console.log("[autoBuilder] Remote builder ordered: " + r + " -> " + e);
  var t = getBuildOp(e);
  t.phase = "remote_build";
  t.status = "remote_build";
  t.remoteBuildStartedAt = Game.time;
  setBuildOp(e, t);
}

function ensureRemoteBuilderDuringBuild(e) {
  var r = getBuildOp(e);
  if (!r) return;
  var t = Game.rooms[e];
  if (!t || !t.controller || !t.controller.my) return;
  if (t.controller.level >= 4) {
    retireAutoBuilderRemoteOrder(e, r);
    return;
  }
  if (r.lastRemoteBuilderCheck && Game.time - r.lastRemoteBuilderCheck < 50) return;
  r.lastRemoteBuilderCheck = Game.time;
  setBuildOp(e, r);
  var n = t.find(FIND_CONSTRUCTION_SITES);
  if (n.length === 0) return;
  var a = r.sourceRoom;
  if (!a || a === "N/A") {
    a = findClosestOwnedRoomWithFreeSpawn(e);
    if (!a) return;
    r.sourceRoom = a;
    setBuildOp(e, r);
  }
  if (!Memory.remoteBuilderOrders) Memory.remoteBuilderOrders = {};
  var i = a + "->" + e;
  var o = Memory.remoteBuilderOrders[i];
  if (o && o.count >= 1) return;
  global.remoteBuilder(a, e, 1);
  markAutoBuilderRemoteOrder(a, e);
  console.log("[autoBuilder] Ensured remote builder for " + e + " from " + a + " (RCL " + t.controller.level + ", " + n.length + " sites)");
}

function markAutoBuilderRemoteOrder(e, r) {
  if (!e || !r || !Memory.remoteBuilderOrders) return;
  var t = e + "->" + r;
  var n = Memory.remoteBuilderOrders[t];
  if (!n) return;
  n.autoBuilder = true;
  n.updatedAt = Game.time;
}

function retireAutoBuilderRemoteOrder(e, r) {
  var t = Game.rooms[e];
  if (!t || !t.controller || t.controller.level < 4) return false;
  if (!Memory.remoteBuilderOrders) return false;
  var n = r && r.sourceRoom;
  var a = false;
  for (var i in Memory.remoteBuilderOrders) {
    if (!Memory.remoteBuilderOrders.hasOwnProperty(i)) continue;
    var o = Memory.remoteBuilderOrders[i];
    if (!o || o.targetRoom !== e) continue;
    if (o.autoBuilder === true || n && i === n + "->" + e) {
      delete Memory.remoteBuilderOrders[i];
      a = true;
    }
  }
  if (a) {
    console.log("[autoBuilder] Retired remote builder order for " + e + " at RCL " + t.controller.level + ".");
  }
  return a;
}

function monitorRemoteBuildFlow(e) {
  var r = getBuildOp(e);
  if (!r || r.phase !== "remote_build") return;
  var t = Game.rooms[e];
  if (!t || !t.controller) return;
  if (t.controller.level >= 1 && t.controller.my) {
    console.log("[autoBuilder] " + e + " reached RCL 1. Starting staged build.");
    r.phase = "building";
    r.status = "building";
    setBuildOp(e, r);
    emitSites(e);
  }
}

function run() {
  tickPreviews();
  var e = ensureHeap();
  if (!e._lastRecoveryScan || Game.time - e._lastRecoveryScan > 50) {
    e._lastRecoveryScan = Game.time;
    for (var r in Game.rooms) {
      if (e.buildOps[r]) continue;
      var t = Game.rooms[r];
      if (!t || !t.controller || !t.controller.my) continue;
      ensureAutoMemory();
      if (Memory.autoBuilder.cancelled[r]) continue;
      var n = getProgress(r);
      if (!n) continue;
      if (!automaticRCLDue(r)) continue;
      setBuildOp(r, {
        phase: "building",
        sourceRoom: r,
        startedAt: Game.time,
        status: "recovered"
      });
    }
  }
  for (var a in e.buildOps) {
    var i = e.buildOps[a];
    if (!i) continue;
    switch (i.phase) {
     case "claiming":
      monitorClaimFlow(a);
      break;
     case "remote_build":
      monitorRemoteBuildFlow(a);
      break;
     case "building":
      ensureRemoteBuilderDuringBuild(a);
      if (automaticRCLDue(a)) {
        emitSites(a);
      }
      break;
     case "complete":
     case "error":
     case "cancelled":
      break;
    }
  }
}

global.autoBuilder = {
  preview: function(e) {
    if (!e) return 'Usage: autoBuilder.preview("roomName")';
    return drawPreview(e);
  },
  clearPreview: function(e) {
    if (!e) return 'Usage: autoBuilder.clearPreview("roomName")';
    return clearPreview(e);
  },
  clearAllPreviews: function() {
    var e = ensureHeap();
    var r = Object.keys(e.previews);
    for (var t = 0; t < r.length; t++) clearPreview(r[t]);
    return "Cleared " + r.length + " preview(s): " + r.join(", ");
  },
  plan: function(e) {
    if (!e) return 'Usage: autoBuilder.plan("roomName")';
    var r = getOrRefreshPlan(e, true);
    if (!r) return "Could not derive layout for " + e + ".";
    var t = [ "=== autoBuilder Plan: " + e + " ===" ];
    for (var n in VISUAL_LETTERS) {
      if (!VISUAL_LETTERS.hasOwnProperty(n)) continue;
      var a = r.layout[n];
      if (!a) continue;
      if (!Array.isArray(a)) a = [ a ];
      if (a.length === 0) continue;
      var i = [];
      for (var o = 0; o < a.length; o++) {
        if (a[o]) i.push("(" + a[o].x + "," + a[o].y + ")");
      }
      t.push("  " + n + " (" + a.length + "): " + i.join(" "));
    }
    t.push("");
    t.push("RCL staging (cumulative sites allowed at each RCL):");
    for (var l = 1; l <= 8; l++) {
      var u = computeRCLStage(r.layout, l);
      t.push("  RCL " + l + ": " + u.length + " sites");
    }
    var s = t.join("\n");
    return s;
  },
  diff: function(e) {
    if (!e) return 'Usage: autoBuilder.diff("roomName")';
    var r = getOrRefreshPlan(e, true);
    if (!r) return "Could not derive layout for " + e + ".";
    var t = getRoomState.get(e);
    if (!t || !t.structuresByType) return "No room state for " + e + ".";
    var n = {};
    for (var a in t.structuresByType) {
      if (!t.structuresByType.hasOwnProperty(a)) continue;
      var i = t.structuresByType[a];
      for (var o = 0; o < i.length; o++) {
        var l = tileKey(i[o].pos.x, i[o].pos.y);
        n[l] = a;
      }
    }
    var u = [ "=== autoBuilder Diff: " + e + " ===" ];
    var s = [];
    var f = [];
    for (var v in VISUAL_LETTERS) {
      if (!VISUAL_LETTERS.hasOwnProperty(v)) continue;
      var c = r.layout[v];
      if (!c) continue;
      if (!Array.isArray(c)) c = [ c ];
      var d = categoryToStructureType(v);
      for (var o = 0; o < c.length; o++) {
        if (!c[o]) continue;
        var l = tileKey(c[o].x, c[o].y);
        var y = n[l] === d || (d === STRUCTURE_WALL || d === STRUCTURE_RAMPART) && (n[l] === STRUCTURE_WALL || n[l] === STRUCTURE_RAMPART);
        if (!y) {
          s.push(v + " at (" + c[o].x + "," + c[o].y + ")");
        }
      }
    }
    for (var l in n) {
      if (!n.hasOwnProperty(l)) continue;
      var p = false;
      for (var h in VISUAL_LETTERS) {
        if (!VISUAL_LETTERS.hasOwnProperty(h)) continue;
        var m = r.layout[h];
        if (!m) continue;
        if (!Array.isArray(m)) m = [ m ];
        for (var g = 0; g < m.length; g++) {
          if (!m[g]) continue;
          if (tileKey(m[g].x, m[g].y) === l) {
            p = true;
            break;
          }
        }
        if (p) break;
      }
      if (!p) {
        var x = posFromKey(l);
        f.push(n[l] + " at (" + x.x + "," + x.y + ")");
      }
    }
    if (s.length === 0 && f.length === 0) {
      u.push("  Room matches the plan exactly.");
    } else {
      if (s.length > 0) {
        u.push("  Missing (" + s.length + "):");
        for (var R = 0; R < Math.min(s.length, 20); R++) u.push("    - " + s[R]);
        if (s.length > 20) u.push("    ... and " + (s.length - 20) + " more");
      }
      if (f.length > 0) {
        u.push("  Extra (" + f.length + "):");
        for (var T = 0; T < Math.min(f.length, 20); T++) u.push("    + " + f[T]);
        if (f.length > 20) u.push("    ... and " + (f.length - 20) + " more");
      }
    }
    var S = u.join("\n");
    return S;
  },
  buildRoom: function(e, r) {
    if (!e) return 'Usage: autoBuilder.buildRoom("targetRoom", "sourceRoom")';
    var t = preflightCheck(e);
    if (t) {
      setError(e, t);
      return t;
    }
    var n = getOrRefreshPlan(e, true);
    if (!n) {
      var a = "Could not derive layout for " + e + ". Check terrain and source positions.";
      setError(e, a);
      return a;
    }
    ensureAutoMemory();
    delete Memory.autoBuilder.cancelled[e];
    drawPreview(e);
    var i = getRoomState.get(e);
    if (i && i.owned) {
      if (!getProgress(e)) {
        setProgress(e, {
          emitted: {},
          lastEmitTick: 0
        });
        memoryManager.requestSave();
      }
      setBuildOp(e, {
        phase: "building",
        sourceRoom: r || "N/A",
        startedAt: Game.time,
        status: "building"
      });
      emitSites(e);
      return "Plan computed for owned room " + e + ". Preview shown for 30 ticks. Building started.";
    }
    var o = startClaimFlow(e, r);
    return "Plan computed for unowned room " + e + ". Preview shown for 30 ticks. " + o;
  },
  cancel: function(e) {
    if (!e) return 'Usage: autoBuilder.cancel("roomName")';
    var r = ensureHeap();
    var t = r.buildOps[e];
    if (t) {
      t.phase = "cancelled";
      t.status = "cancelled";
    }
    ensureAutoMemory();
    Memory.autoBuilder.cancelled[e] = true;
    if (Memory.remoteBuilderOrders) {
      for (var n in Memory.remoteBuilderOrders) {
        if (!Memory.remoteBuilderOrders.hasOwnProperty(n)) continue;
        if (Memory.remoteBuilderOrders[n].targetRoom === e) {
          delete Memory.remoteBuilderOrders[n];
        }
      }
    }
    for (var a in Game.creeps) {
      var i = Game.creeps[a];
      if (!i || !i.memory) continue;
      if ((i.memory.role === "claimbot" || i.memory.role === "remoteBuilder") && i.memory.targetRoom === e) {
        i.memory.autoBuilderCancelled = true;
      }
    }
    delete r.previews[e];
    return "autoBuilder cancelled for " + e + ".";
  },
  status: function(e) {
    var r = ensureHeap();
    if (!e) {
      if (!r.buildOps) return "No active autoBuilder operations.";
      var t = [ "=== autoBuilder Status ===" ];
      for (var n in r.buildOps) {
        var a = r.buildOps[n];
        if (!a) continue;
        t.push("  " + n + ": phase=" + a.phase + " status=" + a.status + " source=" + (a.sourceRoom || "N/A") + " started=" + a.startedAt);
      }
      var i = t.join("\n");
      return i;
    }
    var a = getBuildOp(e);
    if (!a) return "No active operation for " + e + ".";
    var o = getPlan(e);
    var l = getProgress(e);
    var u = "";
    if (o && o.emitted) {
      var s = [];
      for (var f = 1; f <= 8; f++) if (o.emitted["stageDone_" + f]) s.push("RCL" + f);
      u = " stages done: " + (s.length > 0 ? s.join(",") : "none");
    }
    var v = automaticRCLDue(e);
    var c = e + ": phase=" + a.phase + " status=" + a.status + " source=" + (a.sourceRoom || "N/A") + " started=" + a.startedAt + u;
    c += "\n  automaticRCLDue: " + v + (v ? "" : " (current RCL sites placed)");
    if (o && o.layout && o.layout.warnings && o.layout.warnings.length > 0) {
      c += "\n  Connectivity warnings (" + o.layout.warnings.length + "):";
      for (var d = 0; d < o.layout.warnings.length; d++) {
        c += "\n    - " + o.layout.warnings[d];
      }
    } else {
      c += "\n  Connectivity: OK (2 disjoint paths between every major section pair)";
    }
    return c;
  },
  diagnose: function(e) {
    if (!e) return 'Usage: autoBuilder.diagnose("roomName")';
    var r = [ "=== autoBuilder Diagnose: " + e + " ===" ];
    var t = Game.rooms[e];
    var n = t && t.controller ? t.controller.level : -1;
    var a = t && t.controller ? t.controller.my : false;
    var i = ensureHeap();
    var o = getBuildOp(e);
    var l = getPlan(e);
    var u = getProgress(e);
    if (!t || !t.controller) {
      r.push("");
      r.push("[Engine]");
      r.push("  state: NO VISION");
      console.log(r.join("\n"));
      return r.join("\n");
    }
    r.push("");
    r.push("[Engine]");
    r.push("  rcl: " + n);
    r.push("  my: " + a);
    var s = t.find(FIND_CONSTRUCTION_SITES);
    r.push("  sites: " + s.length);
    var f = t.find(FIND_MY_STRUCTURES);
    r.push("  myStructures: " + f.length);
    var v = t.find(FIND_MY_SPAWNS);
    r.push("  spawns: " + v.length);
    var c = 0, d = 0, y = 0, p = 0, h = 0;
    var m = 0, g = 0, x = 0, R = 0, T = 0;
    for (var S = 0; S < f.length; S++) {
      var b = f[S].structureType;
      if (b === STRUCTURE_EXTENSION) c++; else if (b === STRUCTURE_TOWER) d++; else if (b === STRUCTURE_ROAD) y++; else if (b === STRUCTURE_WALL) p++; else if (b === STRUCTURE_RAMPART) h++; else if (b === STRUCTURE_CONTAINER) m++; else if (b === STRUCTURE_LINK) g++; else if (b === STRUCTURE_LAB) x++; else if (b === STRUCTURE_STORAGE) R++; else if (b === STRUCTURE_TERMINAL) T++;
    }
    r.push("  built: extension=" + c + " container=" + m + " road=" + y + " rampart=" + h + " wall=" + p + " tower=" + d + " link=" + g + " lab=" + x + " storage=" + R + " terminal=" + T);
    if (t.controller) {
      var E = Math.round(t.controller.progress / t.controller.progressTotal * 100);
      r.push("  controllerProg: " + t.controller.progress + " / " + t.controller.progressTotal + " (" + E + "%)");
      r.push("  controllerDowngrade: " + t.controller.ticksToDowngrade);
    }
    r.push("");
    r.push("[Memory.progress]");
    if (!u || !u.emitted) {
      r.push("  (none)");
    } else {
      r.push("  lastRCL: " + (u.lastRCL !== undefined ? u.lastRCL : "?"));
      r.push("  lastEmitTick: " + (u.lastEmitTick || 0));
      r.push("  gameTime: " + Game.time);
      var w = u.lastEmitTick ? Game.time - u.lastEmitTick : -1;
      r.push("  ticksSinceEmit: " + w);
      var _ = u.emitted || {};
      var C = Object.keys(_);
      r.push("  emittedCount: " + C.length);
      var k = [];
      var A = {};
      var O = {};
      var B = {};
      for (var U = 0; U < C.length; U++) {
        var M = C[U];
        if (M.indexOf("stageDone_") === 0) {
          k.push(M);
          var N = /^stageDone_(\d+)$/.exec(M);
          if (N) A[N[1]] = true;
        } else {
          var L = M.split("_");
          if (L.length >= 3) {
            var I = L[0];
            var P = L.slice(1, L.length - 2).join("_");
            O[I] = (O[I] || 0) + 1;
            B[P] = (B[P] || 0) + 1;
          }
        }
      }
      r.push("  stageDone: [" + k.join(", ") + "]");
      var W = [];
      for (var D in O) {
        if (O.hasOwnProperty(D) && !A[D]) {
          W.push("RCL" + D + "=" + O[D]);
        }
      }
      var F = Object.keys(A).sort(function(e, r) {
        return Number(e) - Number(r);
      });
      for (var G = 0; G < F.length; G++) {
        W.push("RCL" + F[G] + "=complete");
      }
      r.push("  perStage: { " + W.join(", ") + " }");
      var K = [];
      for (var X in B) {
        if (B.hasOwnProperty(X)) K.push(X + "=" + B[X]);
      }
      if (K.length > 0) r.push("  perType: { " + K.join(", ") + " }");
    }
    r.push("");
    r.push("[heap.buildOps]");
    if (!o) {
      r.push("  NO BUILD OP");
    } else {
      r.push("  phase: " + o.phase);
      r.push("  status: " + (o.status || "-"));
      r.push("  sourceRoom: " + (o.sourceRoom || "-"));
      r.push("  startedAt: " + (o.startedAt || 0));
      if (o.lastRemoteBuilderCheck) r.push("  lastRemoteBuilderCheck: " + o.lastRemoteBuilderCheck);
      if (o.remoteBuildStartedAt) r.push("  remoteBuildStartedAt: " + o.remoteBuildStartedAt);
      if (o.lastFullAt) r.push("  lastFullAt: " + o.lastFullAt + " (resumes in " + Math.max(0, o.lastFullAt + 1e3 - Game.time) + " ticks)");
    }
    r.push("");
    r.push("[heap.plans]");
    if (!l || !l.layout) {
      r.push("  NO PLAN");
    } else {
      r.push("  planRcl: " + l.rcl);
      r.push("  derivedAt: " + (l.derivedAt || 0));
      r.push("  age: " + (Game.time - (l.derivedAt || 0)));
      var j = Object.keys(l.emitted || {});
      r.push("  planEmittedCount: " + j.length);
      var H = [];
      for (var V = 1; V <= 8; V++) {
        if (l.emitted["stageDone_" + V]) H.push("RCL" + V);
      }
      r.push("  planStageDone: [" + H.join(", ") + "]");
      var Y = l.layout;
      var q = [ "spawn", "extension", "container", "road", "rampart", "wall", "tower", "link", "lab", "storage", "terminal", "factory", "nuker", "powerSpawn", "observer", "extractor", "tunnel" ];
      var Q = [];
      for (var J = 0; J < q.length; J++) {
        var $ = q[J];
        var z = Y[$];
        if (!z) continue;
        var Z = Array.isArray(z) ? z.length : z ? 1 : 0;
        if (Z > 0) Q.push($ + "=" + Z);
      }
      r.push("  layoutCounts: { " + Q.join(", ") + " }");
      var ee = Y.warnings && Y.warnings.length || 0;
      r.push("  layoutWarnings: " + ee);
    }
    r.push("");
    r.push("[Refresh decision]");
    var re = "";
    var te = !!(u && u.emitted && u.emitted["stageDone_" + n]);
    if (!automaticRCLDue(e)) {
      re = "current-RCL-complete (idle until RCL change)";
    } else if (!l || !l.layout) {
      re = te ? "no-plan (stageDone, idle until RCL change)" : "no-plan";
    } else if (hasLegacyLayoutKeys(l.layout)) {
      re = te ? "legacy-keys (stageDone, idle until RCL change)" : "legacy-keys";
    } else if (l.rcl !== n) {
      re = "rcl-mismatch (" + l.rcl + "->" + n + ")";
    } else {
      re = "up-to-date";
    }
    r.push("  wouldRefresh: " + (re !== "up-to-date" && re.indexOf("idle until RCL change") === -1));
    r.push("  reason: " + re);
    r.push("");
    r.push("[Emit decision]");
    if (!automaticRCLDue(e)) {
      r.push("  wouldEmit: false");
      r.push("  gateReason: current RCL construction sites already placed");
    } else if (!l || !l.layout) {
      r.push("  wouldEmit: false");
      r.push("  gateReason: no-plan");
    } else if (!t || !t.controller) {
      r.push("  wouldEmit: false");
      r.push("  gateReason: no-vision");
    } else if (!o || o.phase !== "building") {
      r.push("  wouldEmit: false");
      r.push("  gateReason: phase=" + (o ? o.phase : "no-op"));
    } else {
      var ne = RCL_SITE_CAPS[n] || 5;
      r.push("  wouldEmit: true");
      r.push("  rcl: " + n);
      r.push("  cap: " + ne);
      var ae = [];
      for (var ie = 1; ie <= n; ie++) {
        if (!l.emitted["stageDone_" + ie]) ae.push(ie);
      }
      r.push("  pendingStages: [" + ae.join(", ") + "]");
      var oe = null;
      for (var le = 1; le <= n && !oe; le++) {
        if (l.emitted["stageDone_" + le]) continue;
        var ue = computeRCLStage(l.layout, le);
        for (var se = 0; se < ue.length; se++) {
          var fe = ue[se];
          var ve = fe.stage + "_" + fe.type + "_" + fe.x + "_" + fe.y;
          if (!l.emitted[ve]) {
            oe = {
              key: ve,
              type: fe.type,
              x: fe.x,
              y: fe.y,
              stage: fe.stage
            };
            break;
          }
        }
      }
      if (oe) {
        r.push("  firstPendingSite: " + oe.key + " (" + oe.type + " at " + oe.x + "," + oe.y + ", RCL" + oe.stage + ")");
      } else {
        r.push("  firstPendingSite: (all emitted)");
      }
      var ce = [];
      if (n > 0) {
        var de = computeRCLStage(l.layout, n);
        for (var ye = 0; ye < de.length && ce.length < 15; ye++) {
          var pe = de[ye];
          var he = pe.stage + "_" + pe.type + "_" + pe.x + "_" + pe.y;
          if (!l.emitted[he]) ce.push(pe.type + "(" + pe.x + "," + pe.y + ")");
        }
      }
      if (ce.length > 0) {
        r.push("  pendingAtRCL" + n + " (first 15): [" + ce.join(", ") + "]");
      }
    }
    r.push("");
    r.push("[Remote builder]");
    var me = o ? o.sourceRoom : null;
    if (!me || me === "N/A") {
      me = findClosestOwnedRoomWithFreeSpawn(e);
    }
    if (!me) {
      r.push("  sourceRoom: none");
      r.push("  closestOwnedWithFreeSpawn: none");
    } else {
      r.push("  sourceRoom: " + me);
      var ge = me + "->" + e;
      var xe = (Memory.remoteBuilderOrders || {})[ge];
      if (xe) {
        r.push("  order: " + ge + " count=" + (xe.count || 0) + " created=" + (xe.createdAt || 0));
      } else {
        r.push("  order: none for " + ge);
      }
      var Re = getRoomState.creepIndex();
      var Te = Re && Re.all ? Re.all : [];
      var Se = 0;
      for (var be = 0; be < Te.length; be++) {
        var Ee = Te[be];
        if (Ee && Ee.memory && Ee.memory.role === "remoteBuilder" && Ee.memory.targetRoom === e && Ee.memory.homeRoom === me) {
          Se++;
        }
      }
      r.push("  living: " + Se);
      if (xe && xe.count >= 1 && Se === 0) {
        r.push("  ** WARNING: order count>=1 but no living builders");
      }
      var we = o && o.lastRemoteBuilderCheck ? Game.time - o.lastRemoteBuilderCheck : -1;
      r.push("  throttleAge: " + we);
      if (we >= 0 && we < 50) {
        r.push("  wouldSendNew: false (throttled, " + (50 - we) + "t remaining)");
      } else if (xe && xe.count >= 1) {
        r.push("  wouldSendNew: false (order exists with count>=1)");
      } else {
        r.push("  wouldSendNew: true");
      }
    }
    r.push("");
    r.push("[Memory flags]");
    var _e = (Memory.autoBuilder.anchorOverrides || {})[e];
    r.push("  anchorOverride: " + (_e ? "(" + _e.x + "," + _e.y + ")" : "none"));
    r.push("  singleQuadrantExtensions: " + !!(Memory.autoBuilder.singleQuadrantExtensions || {})[e]);
    var Ce = (Memory.autoBuilder.planWarnings || {})[e];
    r.push("  planWarnings: " + (Ce ? Ce : "none"));
    var ke = r.join("\n");
    return ke;
  },
  rebuild: function(e) {
    if (!e) return 'Usage: autoBuilder.rebuild("roomName")';
    var r = getPlan(e);
    if (!r || !r.layout) {
      r = getOrRefreshPlan(e, true);
      if (!r) {
        return "Could not re-derive layout for " + e + ". Run autoBuilder.buildRoom() first.";
      }
    }
    setProgress(e, {
      emitted: {},
      lastEmitTick: 0
    });
    var t = getOrRefreshPlan(e, true);
    if (!t) return "Could not derive layout for " + e + ".";
    t.status = "rebuilding";
    setPlan(e, t);
    var n = getBuildOp(e) || {};
    n.phase = "building";
    n.status = "rebuilding";
    setBuildOp(e, n);
    emitSites(e);
    return "Rebuild started for " + e + ". Sites will be emitted as RCL allows.";
  },
  setAnchor: function(e, r, t) {
    if (!e || r === undefined || t === undefined) return 'Usage: autoBuilder.setAnchor("roomName", x, y)';
    ensureAutoMemory();
    Memory.autoBuilder.anchorOverrides[e] = {
      x: r,
      y: t
    };
    return "Anchor override set for " + e + " at (" + r + "," + t + "). Re-run autoBuilder.buildRoom() to apply.";
  },
  allowUnderfilled: function(e) {
    if (!e) return 'Usage: autoBuilder.allowUnderfilled("roomName")';
    var r = ensureHeap();
    if (!r.allowUnderfilled) r.allowUnderfilled = {};
    r.allowUnderfilled[e] = true;
    delete r.plans[e];
    return "Underfilled extension layout allowed for " + e + " (heap only). Re-run autoBuilder.buildRoom() to re-plan.";
  },
  debugTunnels: function(e, r) {
    if (!e) return 'Usage: autoBuilder.debugTunnels("roomName", true|false)';
    var t = ensureHeap();
    if (!t.debugTunnels) t.debugTunnels = {};
    t.debugTunnels[e] = r !== false;
    return "Tunnel debugging " + (t.debugTunnels[e] ? "enabled" : "disabled") + " for " + e + " (heap only).";
  }
};
module.exports = {
  run: run,
  deriveLayout: deriveLayout,
  computeRCLStage: computeRCLStage,
  emitSites: emitSites,
  preflightCheck: preflightCheck,
  drawPreview: drawPreview,
  clearPreview: clearPreview
};
