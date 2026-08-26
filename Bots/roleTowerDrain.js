// LLM: Read docs/codex.js before reviewing or changing this file.
// roleTowerDrain.js
// Role dispatch: roleTowerDrain.runCreep(powerCreep, Memory.operators[name]).
// Console globals: wideScan, testPlayerRoutes, testPlayerRoutesStatus, testPlayerRoutesCancel, testPlayerRoutesSetTargets, orderTowerDrain, orderBulldozer, orderDrainDemolisher, testDrainDemolisher, cancelTowerDrainOrder, setTowerDrainCount, addTowerDrainUnits, addBulldozerUnits, updateBulldozerBodies, updateDrainDemolisherBodies, getTowerDrainStatus, clearFailedTowerDrains, getCreepMemoryForLane, testTowerDrain, testBulldozer, debugPassability, debugTowerDrainRoute, debugTowerDrainSector, debugTowerDrainBFS
// Example: wideScan('W1N1', 5) - Run wide-area tower drain candidate scan
// Example: testPlayerRoutes('PlayerName', 'E2N46') - Batch-test drain routes to player rooms
// Example: testPlayerRoutesStatus() - View route batch testing progress
// Example: testPlayerRoutesCancel() - Cancel active route testing
// Example: testPlayerRoutesSetTargets(['E2N46']) - Set candidate rooms for drain testing
// Example: orderTowerDrain('W1N1', 'W2N2', 1) - Order tower drain creep to exhaust enemy towers
// Example: orderBulldozer('W1N1', 'W2N2', 1) - Order bulldozer creep to breach defenses
// Example: orderDrainDemolisher('W1N1', 'W2N2', 1) - Order combined drain/demolisher creep
// Example: testDrainDemolisher('W1N1', 'W2N2') - Test drain demolisher viability against room
// Example: cancelTowerDrainOrder('W1N1') - Cancel tower drain order for room
// Example: setTowerDrainCount('W1N1', 2) - Update desired tower drain creep count
// Example: addTowerDrainUnits('W1N1', 1) - Increment active tower drain creeps
// Example: addBulldozerUnits('W1N1', 1) - Increment active bulldozer creeps
// Example: updateBulldozerBodies('W1N1', [TOUGH, WORK, MOVE]) - Update bulldozer body configuration
// Example: updateDrainDemolisherBodies('W1N1', [TOUGH, HEAL, MOVE]) - Update drain body config
// Example: getTowerDrainStatus('W1N1') - View active tower drain operation status
// Example: clearFailedTowerDrains() - Clear failed tower drain records
// Example: getCreepMemoryForLane('W1N1', 'lane1') - Query memory configuration for drain lane
// Example: testTowerDrain('W1N1', 'W2N2') - Simulate tower damage and healing ratio
// Example: testBulldozer('W1N1', 'W2N2') - Simulate bulldozer breach and tower mitigation
// Example: debugPassability('W1N1', 'W2N2') - Inspect terrain passability along drain route
// Example: debugTowerDrainRoute('W1N1', 'W2N2') - Display step-by-step route and exit points
// Example: debugTowerDrainSector('W1N1') - Analyze sector tower coverage and safe spots
// Example: debugTowerDrainBFS('W1N1', 'W2N2') - Run breadth-first search path analysis for drain
// Example: require('roleTowerDrain').runCreep(powerCreep, Memory.operators[name]);
//   edge: 'N'/'S'/'E'/'W', omit to auto-derive.
//   body: 'long' (9T/1A/25M/15H), a custom ordered spec like '10t5w25m10h'
//     (aliases t=TOUGH w=WORK m=MOVE c=CARRY a=ATTACK r=RANGED_ATTACK
//     h=HEAL cl=CLAIM, order preserved so front-loaded TOUGH stays in
//     front), or omit for the standard body.
//   extraPart: 'work' replaces ATTACK with 1 WORK (dismantle at range 1);
//     'rangedAttack' replaces it with 1 RANGED_ATTACK (range 3); falsy/
//     omitted keeps ATTACK.
//   e.g. orderTowerDrain('E1S1','E2S1',2,'N','long','work')
//   using 4-position rest stops. testBulldozer(...) dry-runs it.
//   `count` paired 25W/25M workers + parked 25H/25M healers. With a target
//   {x,y}, edge is derived and the near-edge non-owned structure there is
//   dismantled; without one it's untargeted -- generic drain lanes,
//   dismantles whatever is adjacent. testDrainDemolisher(...) dry-runs it.
//   ops to the current body definition.
//   rooms. testPlayerRoutesSetTargets([...]) sets targets manually;
//   testPlayerRoutesStatus() / testPlayerRoutesCancel() check/stop it.
const OBSERVER_RANGE = 10;
const SCAN_TIMEOUT_TICKS = 120;
const SCAN_MAX_RETRIES = 3;
const SCAN_OBSERVER_HOLD_TICKS = 15;
const MAX_CROSS_SECTOR_ROUTES = 16;
const CROSS_SECTOR_PROGRESS_INTERVAL = 10;
const BULLDOZER_BODY_SPEC = "20w20m1r9h";
const DRAIN_DEMOLISHER_BODY_SPEC = "25w25m";
const DRAIN_DEMOLISHER_MAX_PAIRS = 3;
function verboseRoutingLog(e) {
  if (Memory.debug && Memory.debug.verboseRouting) console.log(e);
}

let _tickCache = {
  tick: 0
};
function getTickCache() {
  if (_tickCache.tick !== Game.time) {
    _tickCache = {
      tick: Game.time
    };
  }
  return _tickCache;
}

function cachedFind(e, o) {
  const t = getTickCache();
  const r = e.name + "_f" + o;
  if (t[r] === undefined) {
    t[r] = e.find(o);
  }
  return t[r];
}

function getCachedCostMatrix(e) {
  const o = getTickCache();
  const t = e.name + "_cm";
  if (o[t]) return o[t];
  const r = new PathFinder.CostMatrix;
  const n = cachedFind(e, FIND_STRUCTURES);
  for (var a = 0; a < n.length; a++) {
    const e = n[a];
    if (e.structureType === STRUCTURE_ROAD) {
      r.set(e.pos.x, e.pos.y, 1);
    } else if (e.structureType === STRUCTURE_WALL) {
      r.set(e.pos.x, e.pos.y, 255);
    } else if (e.structureType === STRUCTURE_RAMPART) {
      if (!e.my && !e.isPublic) {
        r.set(e.pos.x, e.pos.y, 255);
      }
    } else if (OBSTACLE_OBJECT_TYPES.indexOf(e.structureType) !== -1) {
      r.set(e.pos.x, e.pos.y, 255);
    }
  }
  o[t] = r;
  return r;
}

function getCachedCostMatrixWithCreeps(e, o) {
  const t = getTickCache();
  const r = e.name + "_cmc_" + o;
  if (t[r]) return t[r];
  const n = getCachedCostMatrix(e);
  const a = n.clone ? n.clone() : new PathFinder.CostMatrix;
  if (!n.clone) {
    const o = cachedFind(e, FIND_STRUCTURES);
    for (var s = 0; s < o.length; s++) {
      const e = o[s];
      if (e.structureType === STRUCTURE_ROAD) {
        a.set(e.pos.x, e.pos.y, 1);
      } else if (e.structureType === STRUCTURE_WALL) {
        a.set(e.pos.x, e.pos.y, 255);
      } else if (e.structureType === STRUCTURE_RAMPART) {
        if (!e.my && !e.isPublic) a.set(e.pos.x, e.pos.y, 255);
      } else if (OBSTACLE_OBJECT_TYPES.indexOf(e.structureType) !== -1) {
        a.set(e.pos.x, e.pos.y, 255);
      }
    }
  }
  const i = cachedFind(e, FIND_CREEPS);
  for (var l = 0; l < i.length; l++) {
    if (i[l].id !== o) {
      a.set(i[l].pos.x, i[l].pos.y, 255);
    }
  }
  t[r] = a;
  return a;
}

const iff = require("iff");
const util = require("util");
const getRoomState = require("getRoomState");
const scanner = require("scanner");
const roomNavigation = require("roomNavigation");
function isSourceKeeperRoom(e) {
  return roomNavigation.isSourceKeeperRoom(e);
}

function isHighwayRoom(e) {
  return roomNavigation.isHighwayRoom(e);
}

function areInSameSector(e, o) {
  return roomNavigation.areInSameSector(e, o);
}

function getSectorName(e) {
  return roomNavigation.getSectorName(e);
}

function getRoomRouteCost(e, o) {
  return roomNavigation.getRoomRouteCost(e, o, {
    isFriendlyUsername: iff.isFriendlyUsername
  });
}

function initMemory() {
  if (!Memory.towerDrainOps) {
    Memory.towerDrainOps = {
      operations: {},
      scanState: {
        activeRoom: null,
        requestedTick: 0,
        deadline: 0,
        opKey: null,
        purpose: null,
        source: null
      }
    };
  }
  if (!Memory.towerDrainOps.operations) Memory.towerDrainOps.operations = {};
  if (!Memory.towerDrainOps.scanState) {
    Memory.towerDrainOps.scanState = {
      activeRoom: null,
      requestedTick: 0,
      deadline: 0,
      opKey: null,
      purpose: null,
      source: null
    };
  }
}

function clearScanState(e) {
  if (!e) return;
  if (e.activeRoom) scanner.observe.cancel(e.activeRoom, e.source || "towerDrain:" + e.opKey);
  e.activeRoom = null;
  e.requestedTick = 0;
  e.deadline = 0;
  e.opKey = null;
  e.purpose = null;
  e.source = null;
}

function findObserverForRoom(e) {
  return roomNavigation.findObserverForRoom(e, {
    range: OBSERVER_RANGE,
    minRcl: 8
  });
}

function getAllObservers() {
  return roomNavigation.getAllObservers({
    range: OBSERVER_RANGE,
    minRcl: 8
  });
}

function canAnyObserverReach(e) {
  return roomNavigation.canAnyObserverReach(e, {
    range: OBSERVER_RANGE,
    minRcl: 8
  });
}

function isMyRoom(e) {
  return roomNavigation.isMyRoom(e);
}

function checkRoomSafety(e) {
  return roomNavigation.checkRoomSafety(e, {
    isFriendlyUsername: iff.isFriendlyUsername
  });
}

function buildCostMatrix(e) {
  return roomNavigation.buildCostMatrix(e, {
    blockObstacles: true,
    cacheTtl: 1
  });
}

function checkRoomPassability(e, o, t) {
  const r = !!(e && e.controller && e.controller.my);
  return roomNavigation.checkRoomPassability(e, o, t, {
    blockObstacles: true,
    entryStrategy: o ? "median" : r ? "owned" : "center",
    ownedStart: !o && r,
    plainCost: 2,
    swampCost: 10,
    maxOps: 5e3,
    cacheTtl: 1
  });
}

function analyzeRoomEdges(e) {
  return roomNavigation.analyzeRoomEdges(e, {
    blockObstacles: true,
    requireDepthOne: true
  });
}

function getEntryEdge(e, o) {
  const t = Game.map.findExit(e, o);
  if (t === FIND_EXIT_TOP) return "S";
  if (t === FIND_EXIT_BOTTOM) return "N";
  if (t === FIND_EXIT_LEFT) return "E";
  if (t === FIND_EXIT_RIGHT) return "W";
  return null;
}

const getOppositeEdge = util.getOppositeEdge;
function getRoomNeighbors(e) {
  return roomNavigation.getRoomNeighbors(e);
}

function getDirectionBetweenRooms(e, o) {
  return roomNavigation.getExitDirection(e, o);
}

function bfsFindHighwayPaths(e, o, t) {
  return roomNavigation.bfsFindHighwayPaths(e, o, t || MAX_CROSS_SECTOR_ROUTES, {
    canReachRoom: canAnyObserverReach,
    log: function(o) {
      verboseRoutingLog("[TowerDrain] " + o + " to highways from " + e);
    }
  });
}

function deduplicateRooms(e) {
  return roomNavigation.deduplicateRooms(e);
}

function getPathNodeRoom(e) {
  return roomNavigation.getPathNodeRoom(e);
}

function selectBestCrossSectorRoute(e, o) {
  return roomNavigation.selectBestCrossSectorRoute(e, null, o, {
    routeCost: function(e) {
      return getRoomRouteCost(e, null);
    }
  });
}

function computeLanes(e) {
  const o = e.entryEdge;
  const t = e.targetRoom;
  const r = e.safeRoom;
  const n = e.maxDrainers;
  if (!e.scanData) {
    console.log("[TowerDrain] Cannot compute lanes: no scan data");
    return false;
  }
  const a = e.scanData.targetEdges ? e.scanData.targetEdges[o] : null;
  const s = a ? a.walkableTiles : [];
  const i = getOppositeEdge(o);
  const l = e.scanData.safeEdges ? e.scanData.safeEdges[i] : null;
  const c = l ? l.walkableTiles : [];
  verboseRoutingLog("[TowerDrain] Target edge " + o + " has " + s.length + " walkable tiles");
  verboseRoutingLog("[TowerDrain] Safe edge " + i + " has " + c.length + " walkable tiles");
  let u = [];
  for (var g = 0; g < s.length; g++) {
    const e = s[g];
    if (c.indexOf(e) !== -1) {
      u.push(e);
    }
  }
  verboseRoutingLog("[TowerDrain] " + u.length + " tiles walkable on both sides");
  const m = Game.map.getRoomTerrain(t);
  const f = Game.map.getRoomTerrain(r);
  const d = [];
  for (var R = 0; R < u.length; R++) {
    const e = u[R];
    let t, r, n, a;
    if (o === "N") {
      t = e;
      r = 1;
      n = e;
      a = 48;
    } else if (o === "S") {
      t = e;
      r = 48;
      n = e;
      a = 1;
    } else if (o === "E") {
      t = 48;
      r = e;
      n = 1;
      a = e;
    } else {
      t = 1;
      r = e;
      n = 48;
      a = e;
    }
    if (m.get(t, r) === TERRAIN_MASK_SWAMP) {
      continue;
    }
    if (f.get(n, a) === TERRAIN_MASK_SWAMP) {
      continue;
    }
    d.push(e);
  }
  if (d.length < u.length) {
    verboseRoutingLog("[TowerDrain] Filtered " + (u.length - d.length) + " swamp positions (attack or heal)");
  }
  if (d.length > 0) {
    u = d;
  } else {
    console.log("[TowerDrain] WARNING: ALL drain/heal positions are on swamp - no safe lanes available");
  }
  if (u.length === 0) {
    console.log("[TowerDrain] ERROR: No tiles walkable on both sides of edge " + o);
    return false;
  }
  if (e.targetPos) {
    const t = o === "E" || o === "W" ? e.targetPos.y : e.targetPos.x;
    const r = [ t, t - 1, t + 1 ];
    const a = [];
    for (var h = 0; h < r.length; h++) {
      const t = r[h];
      if (u.indexOf(t) === -1) continue;
      const n = buildPositions(o, t);
      if (n.drainPos.x === e.targetPos.x && n.drainPos.y === e.targetPos.y) continue;
      a.push(t);
    }
    if (a.length === 0) {
      console.log("[TowerDrain] ERROR: No walkable drain tiles adjacent to target (" + e.targetPos.x + "," + e.targetPos.y + ") on edge " + o);
      return false;
    }
    e.lanes = {};
    let s = 1;
    for (var D = 0; D < a.length && s <= n; D++) {
      const t = buildPositions(o, a[D]);
      t.targetPos = e.targetPos;
      e.lanes[String(s)] = t;
      verboseRoutingLog("[TowerDrain] Targeted lane " + s + " at coord " + a[D] + ": drain=" + JSON.stringify(t.drainPos) + ", heal=" + JSON.stringify(t.healPos));
      s++;
    }
    const i = Object.keys(e.lanes).length;
    if (i < n) {
      console.log("[TowerDrain] WARNING: Only " + i + " targeted lanes fit around (" + e.targetPos.x + "," + e.targetPos.y + ") (requested " + n + ")");
    }
    return i > 0;
  }
  u.sort(function(e, o) {
    return Math.abs(e - 25) - Math.abs(o - 25);
  });
  function buildPositions(e, o) {
    let n, a, s, i;
    if (e === "W") {
      n = {
        x: 0,
        y: o,
        roomName: t
      };
      a = {
        x: 1,
        y: o,
        roomName: t
      };
      s = {
        x: 49,
        y: o,
        roomName: r
      };
      i = {
        x: 48,
        y: o,
        roomName: r
      };
    } else if (e === "E") {
      n = {
        x: 49,
        y: o,
        roomName: t
      };
      a = {
        x: 48,
        y: o,
        roomName: t
      };
      s = {
        x: 0,
        y: o,
        roomName: r
      };
      i = {
        x: 1,
        y: o,
        roomName: r
      };
    } else if (e === "N") {
      n = {
        x: o,
        y: 0,
        roomName: t
      };
      a = {
        x: o,
        y: 1,
        roomName: t
      };
      s = {
        x: o,
        y: 49,
        roomName: r
      };
      i = {
        x: o,
        y: 48,
        roomName: r
      };
    } else {
      n = {
        x: o,
        y: 49,
        roomName: t
      };
      a = {
        x: o,
        y: 48,
        roomName: t
      };
      s = {
        x: o,
        y: 0,
        roomName: r
      };
      i = {
        x: o,
        y: 1,
        roomName: r
      };
    }
    return {
      attackEdgePos: n,
      attackRestPos: a,
      healEdgePos: s,
      healRestPos: i,
      drainPos: a,
      healPos: i
    };
  }
  const p = {};
  let T = 1;
  e.lanes = {};
  for (var y = 0; y < u.length && T <= n; y++) {
    const t = u[y];
    if (p[t] || p[t - 1] || p[t + 1]) continue;
    const r = buildPositions(o, t);
    e.lanes[String(T)] = r;
    p[t] = true;
    verboseRoutingLog("[TowerDrain] Lane " + T + " at coord " + t + ": drain=" + JSON.stringify(r.drainPos) + ", heal=" + JSON.stringify(r.healPos));
    T++;
  }
  const w = Object.keys(e.lanes).length;
  if (w < n) {
    console.log("[TowerDrain] WARNING: Only found " + w + " valid lanes (requested " + n + ")");
  }
  return w > 0;
}

function parseTowerDrainBodySpec(e) {
  if (typeof e !== "string") return null;
  const o = e.toLowerCase().replace(/\s+/g, "");
  if (!o) return null;
  const t = {
    w: WORK,
    m: MOVE,
    c: CARRY,
    a: ATTACK,
    r: RANGED_ATTACK,
    h: HEAL,
    t: TOUGH,
    cl: CLAIM
  };
  const r = [];
  const n = /(\d+)(cl|[wmcarht])/g;
  let a;
  let s = "";
  while ((a = n.exec(o)) !== null) {
    s += a[0];
    const e = parseInt(a[1], 10);
    const o = t[a[2]];
    if (!o || e <= 0) return null;
    for (var i = 0; i < e; i++) r.push(o);
    if (r.length > 50) return null;
  }
  if (s !== o || r.length === 0) return null;
  return r;
}

function getTowerDrainBodyLabel(e) {
  if (e && e.variant === "bulldozer") return "bulldozer (20W/20M/1RA/9H)";
  if (e && e.variant === "drainDemolisher") return "drain demolisher (25W/25M + paired 25H/25M healer)";
  if (e && e.bodySpec) return "custom (" + e.bodySpec + ")";
  return (e && e.longRange ? "long-range (9T/1A/25M/15H)" : "standard") + (e && e.extraPart ? " (ATTACK->" + e.extraPart + ")" : "");
}

function getBulldozerOptions(e) {
  return {
    dryRun: !!e,
    longRange: false,
    extraPart: null,
    body: parseTowerDrainBodySpec(BULLDOZER_BODY_SPEC),
    bodySpec: BULLDOZER_BODY_SPEC,
    variant: "bulldozer"
  };
}

function getDrainDemolisherOptions(e, o) {
  return {
    dryRun: !!e,
    longRange: false,
    extraPart: null,
    body: parseTowerDrainBodySpec(DRAIN_DEMOLISHER_BODY_SPEC),
    bodySpec: DRAIN_DEMOLISHER_BODY_SPEC,
    variant: "drainDemolisher",
    targetPos: o || null
  };
}

function orderTowerDrain(e, o, t, r, n, a) {
  const s = {
    longRange: n === "long"
  };
  if (n && n !== "long" && n !== "standard") {
    s.body = parseTowerDrainBodySpec(n);
    if (!s.body) {
      console.log("[TowerDrain] Invalid body option: " + n + '. Use "long", "standard", or a custom spec like "10t5w25m10h".');
      return ERR_INVALID_ARGS;
    }
    s.bodySpec = n.toLowerCase().replace(/\s+/g, "");
  }
  if (a !== undefined && a !== null && a !== "" && a !== "work" && a !== "rangedAttack") {
    console.log("[TowerDrain] Invalid extraPart: " + a + '. Use "work" or "rangedAttack".');
    return ERR_INVALID_ARGS;
  }
  if (s.body && a) {
    console.log("[TowerDrain] Cannot combine custom body spec with extraPart. Put all desired parts in the body spec.");
    return ERR_INVALID_ARGS;
  }
  s.extraPart = a || null;
  initMemory();
  if (r) {
    r = r.toUpperCase();
    if ([ "N", "S", "E", "W" ].indexOf(r) === -1) {
      console.log("[TowerDrain] Invalid preferredEdge: " + r + ". Use N, S, E, or W.");
      return ERR_INVALID_ARGS;
    }
    console.log("[TowerDrain] Preferred entry edge: " + r);
  }
  const i = Game.rooms[e];
  if (!i) {
    console.log("[TowerDrain] Cannot start: no vision of home room " + e);
    return ERR_NOT_FOUND;
  }
  if (!i.controller || !i.controller.my) {
    console.log("[TowerDrain] Cannot start: " + e + " is not owned");
    return ERR_INVALID_TARGET;
  }
  if (!i.storage) {
    console.log("[TowerDrain] Cannot start: " + e + " has no storage");
    return ERR_INVALID_TARGET;
  }
  const l = i.find(FIND_MY_SPAWNS);
  if (l.length === 0) {
    console.log("[TowerDrain] Cannot start: " + e + " has no spawns");
    return ERR_INVALID_TARGET;
  }
  const c = findObserverForRoom(o);
  if (!c) {
    console.log("[TowerDrain] Cannot start: no RCL 8 room with observer within " + OBSERVER_RANGE + " of " + o);
    return ERR_NOT_FOUND;
  }
  const u = e + "->" + o;
  if (Memory.towerDrainOps.operations[u]) {
    const e = Memory.towerDrainOps.operations[u];
    if (e.status === "failed" || e.status === "dryrun_complete") {
      console.log("[TowerDrain] Clearing " + e.status + " operation " + u + (e.failReason ? " (reason: " + e.failReason + ")" : ""));
      delete Memory.towerDrainOps.operations[u];
    } else {
      console.log("[TowerDrain] Operation " + u + " already exists (status: " + e.status + ")");
      return ERR_NAME_EXISTS;
    }
  }
  let g = null;
  if (r) {
    g = getAdjacentRoom(o, r);
    if (!g) {
      console.log("[TowerDrain] Cannot determine safe room for edge " + r);
      return ERR_INVALID_ARGS;
    }
    console.log("[TowerDrain] Required safe room for " + r + " entry: " + g);
  }
  const m = areInSameSector(e, o);
  console.log("[TowerDrain] Origin sector: " + getSectorName(e) + ", Target sector: " + getSectorName(o));
  console.log("[TowerDrain] Same sector: " + m);
  console.log("[TowerDrain] Body type: " + getTowerDrainBodyLabel(s));
  if (m) {
    return orderTowerDrainSameSector(e, o, t, r, g, c, u, s);
  } else {
    return orderTowerDrainCrossSector(e, o, t, r, g, c, u, s);
  }
}

function orderTowerDrainSameSector(e, o, t, r, n, a, s, i) {
  if (!i) i = {};
  let l;
  if (n) {
    const c = Game.map.findRoute(e, n, {
      routeCallback: function(e, o) {
        return getRoomRouteCost(e, null);
      }
    });
    if (!c || c === ERR_NO_PATH) {
      console.log("[TowerDrain] Cannot find route from " + e + " to required safe room " + n);
      console.log("[TowerDrain] Falling back to cross-sector routing...");
      return orderTowerDrainCrossSector(e, o, t, r, n, a, s, i);
    }
    const u = Game.map.findExit(n, o);
    if (u === ERR_NO_PATH || u === ERR_INVALID_ARGS) {
      console.log("[TowerDrain] Required safe room " + n + " is not adjacent to target " + o);
      return ERR_INVALID_ARGS;
    }
    l = c.slice();
    l.push({
      room: o,
      exit: u
    });
  } else {
    l = Game.map.findRoute(e, o, {
      routeCallback: function(e, o) {
        return getRoomRouteCost(e, null);
      }
    });
  }
  if (!l || l === ERR_NO_PATH || l.length === 0) {
    console.log("[TowerDrain] Cannot find direct route from " + e + " to " + o);
    console.log("[TowerDrain] Falling back to cross-sector routing...");
    return orderTowerDrainCrossSector(e, o, t, r, n, a, s, i);
  }
  const c = [ e ];
  for (var u = 0; u < l.length; u++) {
    if (l[u] && l[u].room) {
      c.push(l[u].room);
    }
  }
  const g = n || (c.length >= 2 ? c[c.length - 2] : e);
  const m = c.slice().reverse();
  const f = [];
  for (var d = 1; d < c.length; d++) {
    const e = c[d];
    if (!isMyRoom(e)) {
      f.push(e);
    }
  }
  Memory.towerDrainOps.operations[s] = {
    homeRoom: e,
    targetRoom: o,
    safeRoom: g,
    route: c,
    routeBack: m,
    maxDrainers: t,
    creeps: [],
    status: "scanning",
    entryEdge: r || null,
    preferredEdge: r || null,
    lanes: {},
    observerRoom: a.roomName,
    dryRun: !!i.dryRun,
    longRange: !!i.longRange,
    extraPart: i.extraPart || null,
    body: i.body || null,
    bodySpec: i.bodySpec || null,
    variant: i.variant || null,
    targetPos: i.targetPos || null,
    crossSector: false,
    scanData: {
      roomsToScan: f,
      scannedRooms: {},
      routePassability: {},
      targetEdges: null,
      safeEdges: null
    }
  };
  console.log("[TowerDrain] Created SAME-SECTOR operation " + s);
  console.log("[TowerDrain] Route: " + c.join(" -> "));
  console.log("[TowerDrain] Safe room: " + g);
  if (r) {
    console.log("[TowerDrain] Entry edge (forced): " + r);
  }
  if (i.longRange) {
    console.log("[TowerDrain] Long-range body: 9T/1A/25M/15H (5170e)");
  }
  if (i.extraPart) {
    console.log("[TowerDrain] Replaced ATTACK with: " + i.extraPart);
  }
  if (i.variant === "bulldozer") {
    console.log("[TowerDrain] Variant: bulldozer (20W/20M/1RA/9H)");
  } else if (i.bodySpec) {
    console.log("[TowerDrain] Custom body: " + i.bodySpec);
  }
  console.log("[TowerDrain] Observer in: " + a.roomName + " (distance " + a.distance + ")");
  console.log("[TowerDrain] Rooms to scan: " + f.join(", "));
  return OK;
}

function orderTowerDrainCrossSector(e, o, t, r, n, a, s, i) {
  if (!i) i = {};
  let l;
  if (n) {
    l = n;
  } else if (r) {
    l = getAdjacentRoom(o, r);
  } else {
    const t = [ "N", "S", "E", "W" ];
    for (var c = 0; c < t.length; c++) {
      const n = getAdjacentRoom(o, t[c]);
      if (n && n !== e) {
        l = n;
        r = t[c];
        break;
      }
    }
  }
  if (!l) {
    console.log("[TowerDrain] Cannot determine safe room for cross-sector routing");
    return ERR_INVALID_ARGS;
  }
  console.log("[TowerDrain] Cross-sector operation: safe room = " + l);
  const u = bfsFindHighwayPaths(l, o, MAX_CROSS_SECTOR_ROUTES);
  if (u.length === 0) {
    console.log("[TowerDrain] BFS found no paths to highways from " + l);
    return ERR_NO_PATH;
  }
  console.log("[TowerDrain] Found " + u.length + " candidate paths to highways");
  const g = deduplicateRooms(u);
  if (g.indexOf(o) === -1) {
    g.push(o);
  }
  Memory.towerDrainOps.operations[s] = {
    homeRoom: e,
    targetRoom: o,
    safeRoom: l,
    route: null,
    routeBack: null,
    maxDrainers: t,
    creeps: [],
    status: "scanning",
    entryEdge: r || null,
    preferredEdge: r || null,
    lanes: {},
    observerRoom: a.roomName,
    dryRun: !!i.dryRun,
    longRange: !!i.longRange,
    extraPart: i.extraPart || null,
    body: i.body || null,
    bodySpec: i.bodySpec || null,
    variant: i.variant || null,
    targetPos: i.targetPos || null,
    crossSector: true,
    scanData: {
      roomsToScan: g,
      scannedRooms: {},
      routePassability: {},
      targetEdges: null,
      safeEdges: null,
      candidatePaths: u,
      validPaths: [],
      invalidatedPaths: [],
      lastProgressTick: Game.time
    }
  };
  console.log("[TowerDrain] Created CROSS-SECTOR operation " + s);
  console.log("[TowerDrain] Safe room: " + l);
  console.log("[TowerDrain] Entry edge: " + (r || "TBD"));
  console.log("[TowerDrain] Candidate paths: " + u.length);
  console.log("[TowerDrain] Total rooms to scan: " + g.length);
  if (i.longRange) {
    console.log("[TowerDrain] Long-range body: 9T/1A/25M/15H (5170e)");
  }
  if (i.extraPart) {
    console.log("[TowerDrain] Replaced ATTACK with: " + i.extraPart);
  }
  if (i.variant === "bulldozer") {
    console.log("[TowerDrain] Variant: bulldozer (20W/20M/1RA/9H)");
  } else if (i.bodySpec) {
    console.log("[TowerDrain] Custom body: " + i.bodySpec);
  }
  return OK;
}

function cancelTowerDrainOrder(e, o) {
  initMemory();
  const t = e + "->" + o;
  const r = Memory.towerDrainOps.operations[t];
  if (!r) {
    console.log("[TowerDrain] Operation " + t + " does not exist");
    return ERR_NOT_FOUND;
  }
  for (var n = 0; n < r.creeps.length; n++) {
    const e = Game.creeps[r.creeps[n]];
    if (e) {
      e.suicide();
    }
  }
  delete Memory.towerDrainOps.operations[t];
  if (Memory.towerDrainOps.scanState && Memory.towerDrainOps.scanState.opKey === t) {
    clearScanState(Memory.towerDrainOps.scanState);
  }
  if (Memory.towerDrainProgress) {
    delete Memory.towerDrainProgress[t];
  }
  console.log("[TowerDrain] Cancelled operation " + t);
  return OK;
}

function setTowerDrainCount(e, o, t) {
  initMemory();
  t = parseInt(t, 10);
  if (!t || t < 1) {
    console.log("[TowerDrain] Invalid count: " + t + ". Use a positive integer.");
    return ERR_INVALID_ARGS;
  }
  const r = e + "->" + o;
  const n = Memory.towerDrainOps.operations[r];
  if (!n) {
    console.log("[TowerDrain] Operation " + r + " does not exist");
    return ERR_NOT_FOUND;
  }
  if (n.status !== "ready" && n.status !== "active") {
    console.log("[TowerDrain] Operation " + r + " is not ready/active (status: " + n.status + ")");
    return ERR_BUSY;
  }
  const a = n.maxDrainers || 0;
  const s = Object.keys(n.lanes || {}).length;
  const i = n.lanes || {};
  n.maxDrainers = t;
  if (s < t) {
    if (!computeLanes(n)) {
      n.maxDrainers = a;
      n.lanes = i;
      console.log("[TowerDrain] Could not compute enough lanes for " + r + "; count restored to " + a);
      return ERR_NO_PATH;
    }
  }
  const l = Object.keys(n.lanes || {}).length;
  console.log("[TowerDrain] Updated " + r + " count " + a + " -> " + t + " | lanes: " + l + "/" + t + " | body: " + getTowerDrainBodyLabel(n));
  if (l < t) {
    console.log("[TowerDrain] WARNING: Only " + l + " lanes are available; spawning is limited by lane count.");
  }
  return OK;
}

function addTowerDrainUnits(e, o, t) {
  initMemory();
  t = parseInt(t, 10);
  if (!t || t < 1) t = 1;
  const r = e + "->" + o;
  const n = Memory.towerDrainOps.operations[r];
  if (!n) {
    console.log("[TowerDrain] Operation " + r + " does not exist");
    return ERR_NOT_FOUND;
  }
  return setTowerDrainCount(e, o, (n.maxDrainers || 0) + t);
}

function addBulldozerUnits(e, o, t) {
  initMemory();
  const r = e + "->" + o;
  const n = Memory.towerDrainOps.operations[r];
  if (!n) {
    console.log("[TowerDrain] Operation " + r + " does not exist");
    return ERR_NOT_FOUND;
  }
  if (n.variant !== "bulldozer") {
    console.log("[TowerDrain] Operation " + r + " is not a bulldozer operation. Use addTowerDrainUnits for generic towerdrain operations.");
    return ERR_INVALID_TARGET;
  }
  return addTowerDrainUnits(e, o, t);
}

const LEGACY_VARIANT_SPECS = {
  bulldozer: [ "15t5w20m1r9h" ],
  drainDemolisher: [ "5t20w25m" ]
};
function updateVariantBodies(e, o) {
  initMemory();
  const t = Memory.towerDrainOps.operations;
  const r = parseTowerDrainBodySpec(o);
  const n = LEGACY_VARIANT_SPECS[e] || [];
  let a = 0;
  for (var s in t) {
    const i = t[s];
    if (!i) continue;
    const l = i.variant === e || i.bodySpec && n.indexOf(String(i.bodySpec).toLowerCase()) !== -1;
    if (!l) continue;
    i.variant = e;
    i.body = r.slice();
    i.bodySpec = o;
    i.longRange = false;
    i.extraPart = null;
    a++;
    console.log("[TowerDrain] Updated " + e + " body for " + s + " to " + o + " (" + getTowerDrainBodyLabel(i) + ")");
  }
  if (a === 0) {
    console.log("[TowerDrain] No " + e + " operations found to update.");
    for (var i in t) {
      const e = t[i];
      if (!e) continue;
      console.log("[TowerDrain]   existing op " + i + ": variant=" + (e.variant || "none") + ", bodySpec=" + (e.bodySpec || "none") + ", status=" + (e.status || "unknown"));
    }
  } else {
    console.log("[TowerDrain] Updated " + a + " " + e + " operation(s). Existing creeps keep their current body; future spawns use the new body.");
  }
  return a;
}

function updateBulldozerBodies() {
  return updateVariantBodies("bulldozer", BULLDOZER_BODY_SPEC);
}

function updateDrainDemolisherBodies() {
  return updateVariantBodies("drainDemolisher", DRAIN_DEMOLISHER_BODY_SPEC);
}

function getTowerDrainStatus() {
  initMemory();
  const e = Memory.towerDrainOps.operations;
  const o = Object.keys(e).length;
  console.log("=== Tower Drain Operations (" + o + ") ===");
  for (var t in e) {
    const o = e[t];
    console.log("");
    console.log("Operation: " + t);
    console.log("  Status: " + o.status);
    console.log("  Cross-Sector: " + (o.crossSector ? "YES" : "NO"));
    console.log("  Body: " + getTowerDrainBodyLabel(o));
    console.log("  Route: " + (o.route ? o.route.join(" -> ") : "N/A"));
    console.log("  Safe Room: " + o.safeRoom);
    console.log("  Entry Edge: " + (o.entryEdge || "TBD") + (o.preferredEdge ? " (forced)" : ""));
    if (o.targetPos) {
      console.log("  Target: (" + o.targetPos.x + "," + o.targetPos.y + ") in " + o.targetRoom);
    }
    console.log("  Lanes: " + Object.keys(o.lanes || {}).length + "/" + o.maxDrainers);
    console.log("  Creeps: " + (o.creeps ? o.creeps.length : 0));
    if (o.scanData) {
      const e = Object.keys(o.scanData.scannedRooms || {}).length;
      const t = o.scanData.roomsToScan ? o.scanData.roomsToScan.length : 0;
      console.log("  Scan Progress: " + e + "/" + t);
      if (o.crossSector) {
        const e = o.scanData.validPaths ? o.scanData.validPaths.length : 0;
        const t = o.scanData.invalidatedPaths ? o.scanData.invalidatedPaths.length : 0;
        const r = o.scanData.candidatePaths ? o.scanData.candidatePaths.length : 0;
        console.log("  Valid Paths: " + e + "/" + r + " (invalidated: " + t + ")");
      }
      if (o.scanData.rerouteAttempts) {
        console.log("  Reroute Attempts: " + o.scanData.rerouteAttempts + "/5");
      }
      if (o.scanData.blockedRooms && o.scanData.blockedRooms.length > 0) {
        console.log("  Blocked Rooms: " + o.scanData.blockedRooms.join(", "));
      } else if (o.scanData.routePassability) {
        const e = [];
        for (var r in o.scanData.routePassability) {
          if (!o.scanData.routePassability[r]) {
            e.push(r);
          }
        }
        if (e.length > 0) {
          console.log("  Blocked Rooms: " + e.join(", "));
        }
      }
    }
    if (o.failReason) {
      console.log("  Fail Reason: " + o.failReason);
    }
  }
  console.log("");
  const n = Memory.towerDrainOps.scanState;
  console.log("Scan State: room=" + (n.activeRoom || "none") + " op=" + (n.opKey || "none") + " purpose=" + (n.purpose || "none") + " requested=" + (n.requestedTick || 0));
}

function runScanner() {
  const e = Memory.towerDrainOps;
  const o = e.scanState;
  if (o.activeRoom && o.opKey) {
    const t = e.operations[o.opKey];
    const r = Game.rooms[o.activeRoom];
    if (!o.source) o.source = "towerDrain:" + o.opKey;
    if (!o.deadline) o.deadline = (o.requestedTick || Game.time) + SCAN_TIMEOUT_TICKS;
    if (!t) {
      clearScanState(o);
    } else if (t.scanData && t.scanData.scannedRooms && t.scanData.scannedRooms[o.activeRoom]) {
      clearScanState(o);
    } else if (r) {
      if (t.crossSector) {
        processCrossSectorScanResult(t, o.activeRoom, r);
      } else {
        processScanResult(t, o.activeRoom, r);
      }
      clearScanState(o);
    } else if (Game.time > o.deadline) {
      if (!t.scanData) t.scanData = {};
      const e = t.scanData.scanRetries || (t.scanData.scanRetries = {});
      e[o.activeRoom] = (e[o.activeRoom] || 0) + 1;
      if (e[o.activeRoom] >= SCAN_MAX_RETRIES) {
        t.status = "failed";
        t.failReason = "observer_timeout:" + o.activeRoom;
        console.log("[TowerDrain] Scan of " + o.activeRoom + " timed out " + e[o.activeRoom] + " times; failing " + o.opKey);
      } else {
        verboseRoutingLog("[TowerDrain] Scan of " + o.activeRoom + " timed out; retry " + e[o.activeRoom] + "/" + SCAN_MAX_RETRIES);
      }
      clearScanState(o);
    } else {
      scanner.observe.request(o.activeRoom, o.source, scanner.observe.PRI.ONESHOT, {
        untilConsumed: true,
        holdTicks: SCAN_OBSERVER_HOLD_TICKS
      });
      return;
    }
  }
  for (var t in e.operations) {
    const n = e.operations[t];
    if (n.status !== "scanning") continue;
    if (!n.scanData || !n.scanData.roomsToScan) continue;
    if (n.crossSector && n.scanData.lastProgressTick) {
      if (Game.time - n.scanData.lastProgressTick >= CROSS_SECTOR_PROGRESS_INTERVAL) {
        const e = Object.keys(n.scanData.scannedRooms || {}).length;
        const o = n.scanData.validPaths ? n.scanData.validPaths.length : 0;
        const t = n.scanData.candidatePaths ? n.scanData.candidatePaths.length : 0;
        const r = n.scanData.invalidatedPaths ? n.scanData.invalidatedPaths.length : 0;
        verboseRoutingLog("[TowerDrain] Cross-sector scan: " + e + "/" + n.scanData.roomsToScan.length + " rooms scanned, " + o + "/" + t + " routes still valid" + " (invalidated: " + r + ")");
        n.scanData.lastProgressTick = Game.time;
      }
    }
    let a = null;
    for (var r = 0; r < n.scanData.roomsToScan.length; r++) {
      const e = n.scanData.roomsToScan[r];
      if (!n.scanData.scannedRooms[e]) {
        a = e;
        break;
      }
    }
    if (!a) {
      if (n.crossSector) {
        finalizeCrossSectorOperation(n, t);
      } else {
        finalizeOperation(n, t);
      }
      continue;
    }
    if (Game.rooms[a]) {
      if (n.crossSector) {
        processCrossSectorScanResult(n, a, Game.rooms[a]);
      } else {
        processScanResult(n, a, Game.rooms[a]);
      }
      continue;
    }
    const s = "towerDrain:" + t;
    if (!scanner.observe.request(a, s, scanner.observe.PRI.ONESHOT, {
      untilConsumed: true,
      holdTicks: SCAN_OBSERVER_HOLD_TICKS
    })) {
      if (isHighwayRoom(a)) {
        verboseRoutingLog("[TowerDrain] No observer can reach " + a + " - assuming passable (highway room)");
        n.scanData.scannedRooms[a] = {
          tick: Game.time,
          safe: true,
          reason: "highway_no_observer",
          blockedExits: [],
          passable: true
        };
        n.scanData.routePassability[a] = true;
      } else {
        console.log("[TowerDrain] No observer can reach " + a + " - marking blocked");
        n.scanData.scannedRooms[a] = {
          blocked: true,
          reason: "no_observer"
        };
        n.scanData.routePassability[a] = false;
        if (n.crossSector) {
          invalidatePathsContainingRoom(n, a);
        }
      }
      continue;
    }
    o.activeRoom = a;
    o.requestedTick = Game.time;
    o.deadline = Game.time + SCAN_TIMEOUT_TICKS;
    o.opKey = t;
    o.source = s;
    if (a === n.targetRoom) {
      o.purpose = "target";
    } else if (a === n.safeRoom) {
      o.purpose = "safe";
    } else {
      o.purpose = "route";
    }
    verboseRoutingLog("[TowerDrain] Scanning " + a + " (" + o.purpose + ")");
    return;
  }
}

function invalidatePathsContainingRoom(e, o) {
  if (!e.scanData.candidatePaths) return;
  var t = roomNavigation.invalidatePathsContainingRoom(e.scanData.candidatePaths, o);
  if (!e.scanData.invalidatedPaths) e.scanData.invalidatedPaths = [];
  Array.prototype.push.apply(e.scanData.invalidatedPaths, t.invalidated);
  e.scanData.candidatePaths = t.remaining;
  if (t.remaining.length === 0) {
    console.log("[TowerDrain] All " + MAX_CROSS_SECTOR_ROUTES + " candidate paths have been invalidated");
  }
}

function invalidatePathsWithBlockedExit(e, o, t) {
  if (!e.scanData.candidatePaths || t.length === 0) return;
  var r = roomNavigation.invalidatePathsWithBlockedExit(e.scanData.candidatePaths, o, t);
  if (!e.scanData.invalidatedPaths) e.scanData.invalidatedPaths = [];
  Array.prototype.push.apply(e.scanData.invalidatedPaths, r.invalidated);
  if (r.invalidated.length > 0) {
    verboseRoutingLog("[TowerDrain] Invalidated " + r.invalidated.length + " paths due to blocked exits at " + o);
  }
  e.scanData.candidatePaths = r.remaining;
  if (r.remaining.length === 0) {
    console.log("[TowerDrain] All candidate paths have been invalidated");
  }
}

function checkTransitPassability(e, o, t) {
  return roomNavigation.checkTransitPassability(e, o, t, {
    blockObstacles: true,
    swampCost: 10,
    maxOps: 3e3,
    cacheTtl: 1
  });
}

function processCrossSectorScanResult(e, o, t) {
  const r = e.scanData;
  const n = checkRoomSafety(t);
  verboseRoutingLog("[TowerDrain] Cross-sector scan of " + o + ": " + (n.safe ? "SAFE" : "HOSTILE") + " (" + n.reason + ")");
  const a = analyzeRoomEdges(t);
  const s = [];
  if (a) {
    if (a.N.totalWalkable === 0) s.push("N");
    if (a.S.totalWalkable === 0) s.push("S");
    if (a.E.totalWalkable === 0) s.push("E");
    if (a.W.totalWalkable === 0) s.push("W");
    if (s.length > 0) {
      verboseRoutingLog("[TowerDrain] Room " + o + " has blocked exits: " + s.join(", "));
    }
  }
  r.scannedRooms[o] = {
    tick: Game.time,
    safe: n.safe,
    reason: n.reason,
    edges: a,
    blockedExits: s
  };
  if (o === e.targetRoom) {
    r.targetEdges = a;
    verboseRoutingLog("[TowerDrain] Target room " + o + " edge analysis:");
    for (var i in a) {
      verboseRoutingLog("[TowerDrain]   " + i + ": " + a[i].totalWalkable + " walkable tiles");
    }
    return;
  }
  if (o === e.safeRoom) {
    if (!n.safe) {
      console.log("[TowerDrain] CRITICAL: Safe room " + o + " is not safe!");
      r.candidatePaths = [];
      return;
    }
    r.safeEdges = a;
    verboseRoutingLog("[TowerDrain] Safe room " + o + " edge analysis:");
    for (var l in a) {
      verboseRoutingLog("[TowerDrain]   " + l + ": " + a[l].totalWalkable + " walkable tiles");
    }
    if (s.length > 0) {
      invalidatePathsWithBlockedExit(e, o, s);
    }
    return;
  }
  if (!n.safe) {
    verboseRoutingLog("[TowerDrain] Room " + o + " is hostile - invalidating affected paths");
    invalidatePathsContainingRoom(e, o);
    r.routePassability[o] = false;
    return;
  }
  if (s.length > 0) {
    invalidatePathsWithBlockedExit(e, o, s);
  }
  const c = checkTransitPassability(t, a, s);
  r.scannedRooms[o].passableTransits = c;
  for (var u in c) {
    if (c[u] === false) {
      const e = u.split("->");
      if (s.indexOf(e[0]) === -1 && s.indexOf(e[1]) === -1) {
        verboseRoutingLog("[TowerDrain] Room " + o + " transit " + u + " is BLOCKED (interior walls/ramparts)");
      }
    }
  }
  if (e.scanData.candidatePaths) {
    for (var g = e.scanData.candidatePaths.length - 1; g >= 0; g--) {
      const t = e.scanData.candidatePaths[g];
      for (var m = 0; m < t.length; m++) {
        const r = t[m];
        if (typeof r === "object" && r.room === o) {
          if (r.entryDir && r.exitDir) {
            const n = r.entryDir + "->" + r.exitDir;
            if (c[n] === false) {
              if (!e.scanData.invalidatedPaths) e.scanData.invalidatedPaths = [];
              e.scanData.invalidatedPaths.push(t);
              e.scanData.candidatePaths.splice(g, 1);
              verboseRoutingLog("[TowerDrain] Invalidated path through " + o + " (transit " + n + " blocked)");
              break;
            }
          }
        }
      }
    }
  }
  r.routePassability[o] = true;
}

function finalizeCrossSectorOperation(e, o) {
  const t = e.scanData;
  verboseRoutingLog("[TowerDrain] Finalizing cross-sector operation " + o);
  let r = [];
  for (var n = 0; n < t.candidatePaths.length; n++) {
    const e = t.candidatePaths[n];
    let o = true;
    for (var a = 0; a < e.length; a++) {
      const r = e[a];
      const n = getPathNodeRoom(r);
      const s = t.scannedRooms[n];
      if (!s) {
        verboseRoutingLog("[TowerDrain] WARNING: Room " + n + " in path was not scanned");
        o = false;
        break;
      }
      if (s.safe === false) {
        o = false;
        break;
      }
      if (typeof r === "object" && s.blockedExits) {
        if (r.entryDir && s.blockedExits.indexOf(r.entryDir) !== -1) {
          verboseRoutingLog("[TowerDrain] Path invalid: " + n + " entry " + r.entryDir + " is blocked");
          o = false;
          break;
        }
        if (r.exitDir && s.blockedExits.indexOf(r.exitDir) !== -1) {
          verboseRoutingLog("[TowerDrain] Path invalid: " + n + " exit " + r.exitDir + " is blocked");
          o = false;
          break;
        }
      }
      if (typeof r === "object" && s.passableTransits && r.entryDir && r.exitDir) {
        const e = r.entryDir + "->" + r.exitDir;
        if (s.passableTransits[e] === false) {
          verboseRoutingLog("[TowerDrain] Path invalid: " + n + " transit " + e + " blocked");
          o = false;
          break;
        }
      }
    }
    if (o) {
      r.push(e);
    }
  }
  t.validPaths = r;
  verboseRoutingLog("[TowerDrain] Valid paths after scanning: " + r.length);
  if (r.length === 0) {
    console.log("[TowerDrain] FAILED: No valid paths found after scanning all " + MAX_CROSS_SECTOR_ROUTES + " candidates");
    e.status = "failed";
    e.failReason = "all_paths_blocked";
    return;
  }
  const s = {};
  if (!t._avoidRooms) t._avoidRooms = {};
  if (!t._highwayRetries) t._highwayRetries = {};
  while (r.length > 0) {
    const n = selectBestCrossSectorRoute(e.homeRoom, r);
    if (!n) {
      break;
    }
    if (s[n.highwayEntry]) {
      r = r.filter(function(e) {
        const o = e[e.length - 1];
        return getPathNodeRoom(o) !== n.highwayEntry;
      });
      continue;
    }
    s[n.highwayEntry] = true;
    if (!t._highwayRetries[n.highwayEntry]) t._highwayRetries[n.highwayEntry] = 0;
    verboseRoutingLog("[TowerDrain] Selected route via highway " + n.highwayEntry + " (total length: " + n.totalLength + ")");
    const a = Game.map.findRoute(e.homeRoom, n.highwayEntry, {
      routeCallback: function(e) {
        if (t._avoidRooms[e]) return Infinity;
        return getRoomRouteCost(e, null);
      }
    });
    if (!a || a === ERR_NO_PATH) {
      verboseRoutingLog("[TowerDrain] Cannot build route to highway " + n.highwayEntry + ", trying next");
      r = r.filter(function(e) {
        const o = e[e.length - 1];
        return getPathNodeRoom(o) !== n.highwayEntry;
      });
      continue;
    }
    let S = [ e.homeRoom ];
    for (var i = 0; i < a.length; i++) {
      S.push(a[i].room);
    }
    const _ = [];
    for (var l = 0; l < n.path.length; l++) {
      _.push(getPathNodeRoom(n.path[l]));
    }
    _.reverse();
    for (var c = 1; c < _.length; c++) {
      if (S.indexOf(_[c]) === -1) {
        S.push(_[c]);
      }
    }
    if (S.indexOf(e.targetRoom) === -1) {
      S.push(e.targetRoom);
    }
    let P = false;
    let O = false;
    const N = 6;
    for (var u = 0; u < N; u++) {
      const o = [];
      for (var g = 1; g < S.length; g++) {
        const r = S[g];
        if (r === e.targetRoom && t.scannedRooms[r]) continue;
        if (isMyRoom(r)) continue;
        if (!t.scannedRooms[r]) {
          o.push(r);
        }
      }
      if (o.length > 0) {
        verboseRoutingLog("[TowerDrain] Full route has " + o.length + " unscanned room(s): " + o.join(", "));
        verboseRoutingLog("[TowerDrain] Adding to scan queue for passability verification");
        for (var m = 0; m < o.length; m++) {
          if (t.roomsToScan.indexOf(o[m]) === -1) {
            t.roomsToScan.push(o[m]);
          }
        }
        e.route = S;
        e.routeBack = S.slice().reverse();
        return;
      }
      let r = false;
      let a = null;
      let s = "";
      if (S.length >= 2) {
        const e = Game.rooms[S[0]];
        if (e) {
          const o = analyzeRoomEdges(e);
          if (o) {
            const e = S[1];
            const n = getDirectionBetweenRooms(S[0], e);
            if (n && o[n] && o[n].totalWalkable === 0) {
              const e = [];
              const i = [ "N", "S", "E", "W" ];
              for (var f = 0; f < i.length; f++) {
                if (o[i[f]] && o[i[f]].totalWalkable > 0) {
                  e.push(i[f]);
                }
              }
              verboseRoutingLog("[TowerDrain] Home room " + S[0] + " exit " + n + " blocked (0 walkable edge tiles). Available: " + e.join(", "));
              r = true;
              a = S[0];
              s = "home_exit_blocked";
              if (!t._homeAvailExits) t._homeAvailExits = e;
            }
          }
        }
      }
      for (var d = 1; !r && d < S.length; d++) {
        const o = S[d];
        if (o === e.targetRoom) continue;
        if (isMyRoom(o)) {
          const e = Game.rooms[o];
          if (e) {
            const t = S[d - 1];
            const n = d < S.length - 1 ? S[d + 1] : null;
            const i = analyzeRoomEdges(e);
            if (i) {
              const e = getDirectionBetweenRooms(t, o);
              const l = e ? getOppositeEdge(e) : null;
              const c = n ? getDirectionBetweenRooms(o, n) : null;
              if (l && i[l] && i[l].totalWalkable === 0) {
                verboseRoutingLog("[TowerDrain] Own room " + o + " entry from " + l + " blocked");
                r = true;
                a = o;
                s = "own_room_blocked";
                break;
              }
              if (c && i[c] && i[c].totalWalkable === 0) {
                verboseRoutingLog("[TowerDrain] Own room " + o + " exit toward " + c + " blocked");
                r = true;
                a = o;
                s = "own_room_blocked";
                break;
              }
            }
          }
          continue;
        }
        const n = t.scannedRooms[o];
        if (!n) continue;
        if (n.safe === false) {
          verboseRoutingLog("[TowerDrain] Route room " + o + " is hostile (" + n.reason + ")");
          r = true;
          a = o;
          s = "hostile";
          break;
        }
        if (n.blockedExits && n.blockedExits.length > 0) {
          const e = S[d - 1];
          const t = d < S.length - 1 ? S[d + 1] : null;
          const i = getDirectionBetweenRooms(e, o);
          const l = i ? getOppositeEdge(i) : null;
          const c = t ? getDirectionBetweenRooms(o, t) : null;
          if (l && n.blockedExits.indexOf(l) !== -1) {
            verboseRoutingLog("[TowerDrain] Route room " + o + ": entry from " + l + " is blocked");
            r = true;
            a = o;
            s = "entry_blocked_" + l;
            break;
          }
          if (c && n.blockedExits.indexOf(c) !== -1) {
            verboseRoutingLog("[TowerDrain] Route room " + o + ": exit toward " + c + " is blocked");
            r = true;
            a = o;
            s = "exit_blocked_" + c;
            break;
          }
        }
        if (n.passableTransits) {
          const e = S[d - 1];
          const t = d < S.length - 1 ? S[d + 1] : null;
          const i = getDirectionBetweenRooms(e, o);
          const l = i ? getOppositeEdge(i) : null;
          const c = t ? getDirectionBetweenRooms(o, t) : null;
          if (l && c) {
            const e = l + "->" + c;
            if (n.passableTransits[e] === false) {
              verboseRoutingLog("[TowerDrain] Route room " + o + ": transit " + e + " blocked (interior walls/ramparts)");
              r = true;
              a = o;
              s = "transit_blocked_" + e;
              break;
            }
          }
        }
      }
      if (!r) {
        P = true;
        break;
      }
      verboseRoutingLog("[TowerDrain] Route blocked at " + a + " (" + s + ")");
      t._highwayRetries[n.highwayEntry]++;
      if (t._highwayRetries[n.highwayEntry] > 5) {
        console.log("[TowerDrain] Max retries (5) for highway " + n.highwayEntry);
        O = true;
        break;
      }
      let i = false;
      if (s === "home_exit_blocked" || s === "own_room_blocked") {
        const o = Game.rooms[a];
        if (o) {
          const r = S.indexOf(a);
          let l = [];
          if (s === "home_exit_blocked" && t._homeAvailExits) {
            l = t._homeAvailExits.slice();
          } else {
            const e = analyzeRoomEdges(o);
            if (e) {
              const o = [ "N", "S", "E", "W" ];
              for (var R = 0; R < o.length; R++) {
                if (e[o[R]] && e[o[R]].totalWalkable > 0) {
                  l.push(o[R]);
                }
              }
            }
          }
          const c = r > 0 ? S[r - 1] : null;
          if (c) {
            const e = getDirectionBetweenRooms(c, a);
            const o = e ? getOppositeEdge(e) : null;
            if (o) {
              l = l.filter(function(e) {
                return e !== o;
              });
            }
          }
          const u = r < S.length - 1 ? S[r + 1] : null;
          if (u) {
            const e = getDirectionBetweenRooms(a, u);
            if (e) {
              l = l.filter(function(o) {
                return o !== e;
              });
            }
          }
          verboseRoutingLog("[TowerDrain] Owned room " + a + " available detour exits: " + l.join(", "));
          const g = getPathNodeRoom(n.path[n.path.length - 1]);
          for (var h = 0; h < l.length; h++) {
            const o = l[h];
            const n = getAdjacentRoom(a, o);
            if (!n || t._avoidRooms[n]) continue;
            verboseRoutingLog("[TowerDrain] Trying exit " + o + " -> " + n);
            const s = Game.map.findRoute(n, g, {
              routeCallback: function(e) {
                if (t._avoidRooms[e]) return Infinity;
                return getRoomRouteCost(e, null);
              }
            });
            if (!s || s === ERR_NO_PATH || s.length === 0) {
              verboseRoutingLog("[TowerDrain] No path from " + n + " to " + g);
              continue;
            }
            const c = S.slice(0, r + 1);
            c.push(n);
            for (var D = 0; D < s.length; D++) {
              const e = s[D].room;
              if (e !== n && c.indexOf(e) === -1) {
                c.push(e);
              }
            }
            for (var p = 0; p < _.length; p++) {
              if (c.indexOf(_[p]) === -1) {
                c.push(_[p]);
              }
            }
            if (c.indexOf(e.targetRoom) === -1) {
              c.push(e.targetRoom);
            }
            verboseRoutingLog("[TowerDrain] Detour route: " + c.join(" -> "));
            S = c;
            i = true;
            break;
          }
        }
      }
      const l = t.scannedRooms[a];
      if (!i && l && l.passableTransits && s.indexOf("transit_blocked_") === 0) {
        const o = S.indexOf(a);
        const r = o > 0 ? S[o - 1] : null;
        const s = r ? getDirectionBetweenRooms(r, a) : null;
        const c = s ? getOppositeEdge(s) : null;
        if (c) {
          const r = [];
          for (var T in l.passableTransits) {
            if (l.passableTransits[T] === true && T.indexOf(c + "->") === 0) {
              r.push(T.split("->")[1]);
            }
          }
          if (r.length > 0) {
            verboseRoutingLog("[TowerDrain] Room " + a + " has passable exits from " + c + ": " + r.join(", "));
          }
          for (var y = 0; y < r.length; y++) {
            const s = r[y];
            const l = getAdjacentRoom(a, s);
            if (!l || t._avoidRooms[l]) continue;
            verboseRoutingLog("[TowerDrain] Trying detour via " + a + " exit " + s + " -> " + l);
            const c = getPathNodeRoom(n.path[n.path.length - 1]);
            const u = Game.map.findRoute(l, c, {
              routeCallback: function(e) {
                if (e === a) return Infinity;
                if (t._avoidRooms[e]) return Infinity;
                return getRoomRouteCost(e, null);
              }
            });
            if (!u || u === ERR_NO_PATH || u.length === 0) {
              verboseRoutingLog("[TowerDrain] No path from " + l + " to " + c);
              continue;
            }
            const g = S.slice(0, o + 1);
            g.push(l);
            for (var w = 0; w < u.length; w++) {
              const e = u[w].room;
              if (e !== l && g.indexOf(e) === -1) {
                g.push(e);
              }
            }
            for (var b = 0; b < _.length; b++) {
              if (g.indexOf(_[b]) === -1) {
                g.push(_[b]);
              }
            }
            if (g.indexOf(e.targetRoom) === -1) {
              g.push(e.targetRoom);
            }
            verboseRoutingLog("[TowerDrain] Detour route: " + g.join(" -> "));
            S = g;
            i = true;
            break;
          }
        }
      }
      if (i) {
        continue;
      }
      t._avoidRooms[a] = true;
      verboseRoutingLog("[TowerDrain] Avoiding " + a + ", rebuilding route to " + n.highwayEntry);
      const c = Game.map.findRoute(e.homeRoom, n.highwayEntry, {
        routeCallback: function(e) {
          if (t._avoidRooms[e]) return Infinity;
          return getRoomRouteCost(e, null);
        }
      });
      if (!c || c === ERR_NO_PATH || c.length === 0) {
        console.log("[TowerDrain] No route to " + n.highwayEntry + " with avoid list");
        O = true;
        break;
      }
      S = [ e.homeRoom ];
      for (var v = 0; v < c.length; v++) {
        S.push(c[v].room);
      }
      for (var E = 1; E < _.length; E++) {
        if (S.indexOf(_[E]) === -1) {
          S.push(_[E]);
        }
      }
      if (S.indexOf(e.targetRoom) === -1) {
        S.push(e.targetRoom);
      }
      verboseRoutingLog("[TowerDrain] Rebuilt route: " + S.join(" -> "));
    }
    if (P) {
      e.route = S;
      e.routeBack = S.slice().reverse();
      verboseRoutingLog("[TowerDrain] Full route (verified): " + S.join(" -> "));
      if (e.preferredEdge) {
        e.entryEdge = e.preferredEdge;
      } else {
        e.entryEdge = getEntryEdge(e.safeRoom, e.targetRoom);
      }
      if (!e.entryEdge) {
        console.log("[TowerDrain] FAILED: Could not determine entry edge");
        e.status = "failed";
        e.failReason = "no_entry_edge";
        return;
      }
      verboseRoutingLog("[TowerDrain] Entry edge: " + e.entryEdge);
      if (!t.targetEdges) {
        console.log("[TowerDrain] FAILED: Missing target room edge data");
        e.status = "failed";
        e.failReason = "missing_target_edge_data";
        return;
      }
      if (!t.safeEdges) {
        console.log("[TowerDrain] FAILED: Missing safe room edge data");
        e.status = "failed";
        e.failReason = "missing_safe_edge_data";
        return;
      }
      const r = computeLanes(e);
      if (!r) {
        console.log("[TowerDrain] FAILED: Could not compute valid lanes");
        e.status = "failed";
        e.failReason = "no_valid_lanes";
        return;
      }
      if (e.dryRun) {
        e.status = "dryrun_complete";
        console.log("[TowerDrain] ✓ DRY RUN operation " + o + " completed successfully");
        console.log("[TowerDrain] Route: " + e.route.join(" -> "));
        console.log("[TowerDrain] " + Object.keys(e.lanes).length + " lanes computed");
        console.log("[TowerDrain] Body: " + getTowerDrainBodyLabel(e));
        console.log("[TowerDrain] No creeps will be spawned (dry run mode)");
        return;
      }
      e.status = "ready";
      console.log("[TowerDrain] ✓ Cross-sector operation " + o + " is READY");
      console.log("[TowerDrain] Route: " + e.route.join(" -> "));
      console.log("[TowerDrain] " + Object.keys(e.lanes).length + " lanes computed");
      console.log("[TowerDrain] Body: " + getTowerDrainBodyLabel(e));
      return;
    }
    if (O) {
      r = r.filter(function(e) {
        const o = e[e.length - 1];
        return getPathNodeRoom(o) !== n.highwayEntry;
      });
    }
  }
  console.log("[TowerDrain] FAILED: All candidate routes blocked after full verification");
  e.status = "failed";
  e.failReason = "all_routes_blocked_after_verification";
}

function tryReroute(e, o) {
  const t = e.scanData;
  if (!t.rerouteAttempts) t.rerouteAttempts = 0;
  t.rerouteAttempts++;
  if (t.rerouteAttempts > 5) {
    console.log("[TowerDrain] Max reroute attempts (5) reached");
    return false;
  }
  verboseRoutingLog("[TowerDrain] Reroute attempt " + t.rerouteAttempts + "/5");
  let r = null;
  let n = null;
  const a = [];
  for (var s = 1; s < e.route.length - 1; s++) {
    const o = e.route[s];
    const i = t.scannedRooms[o];
    if (!i) continue;
    if (!i.passable) {
      if (i.partiallyPassable && i.availableExits && i.availableExits.length > 0) {
        r = o;
        n = i.availableExits;
        verboseRoutingLog("[TowerDrain] Found partial room: " + o + " with exits: " + n.join(", "));
        break;
      } else {
        a.push(o);
      }
    }
  }
  if (a.length > 0) {
    verboseRoutingLog("[TowerDrain] Completely blocked rooms: " + a.join(", "));
  }
  if (!t.blockedRooms) t.blockedRooms = [];
  for (var i = 0; i < a.length; i++) {
    if (t.blockedRooms.indexOf(a[i]) === -1) {
      t.blockedRooms.push(a[i]);
    }
  }
  const l = {};
  for (var c = 0; c < t.blockedRooms.length; c++) {
    l[t.blockedRooms[c]] = true;
  }
  let u = null;
  if (r && n) {
    verboseRoutingLog("[TowerDrain] Routing through available exits of " + r);
    const o = r;
    for (var g = 0; g < n.length; g++) {
      const t = n[g];
      const a = getAdjacentRoom(r, t);
      if (!a || a === e.homeRoom || l[a]) continue;
      verboseRoutingLog("[TowerDrain] Trying route via " + a + " (exit " + t + " from " + r + ")");
      const s = Game.map.findRoute(e.homeRoom, a, {
        routeCallback: function(e) {
          if (l[e]) return Infinity;
          return getRoomRouteCost(e, null);
        }
      });
      if (!s || s === ERR_NO_PATH) {
        verboseRoutingLog("[TowerDrain] Cannot reach " + a);
        continue;
      }
      const i = Game.map.findRoute(a, e.targetRoom, {
        routeCallback: function(e) {
          if (e === o) return Infinity;
          if (l[e]) return Infinity;
          return getRoomRouteCost(e, null);
        }
      });
      if (!i || i === ERR_NO_PATH || i.length === 0) {
        verboseRoutingLog("[TowerDrain] Cannot reach target from " + a);
        continue;
      }
      u = s.concat(i);
      verboseRoutingLog("[TowerDrain] Found route via " + a);
      break;
    }
  }
  if (!u) {
    verboseRoutingLog("[TowerDrain] Trying to completely avoid problem rooms...");
    const o = {};
    for (var m in l) o[m] = true;
    if (r) o[r] = true;
    u = Game.map.findRoute(e.homeRoom, e.targetRoom, {
      routeCallback: function(e) {
        if (o[e]) return Infinity;
        return getRoomRouteCost(e, null);
      }
    });
  }
  if (!u || u === ERR_NO_PATH || u.length === 0) {
    console.log("[TowerDrain] No alternative route found");
    return false;
  }
  const f = [ e.homeRoom ];
  for (var d = 0; d < u.length; d++) {
    if (u[d] && u[d].room) {
      f.push(u[d].room);
    }
  }
  const R = e.route.join(",");
  const h = f.join(",");
  if (R === h) {
    verboseRoutingLog("[TowerDrain] Route unchanged - marking partial room as fully blocked");
    if (r && t.blockedRooms.indexOf(r) === -1) {
      t.blockedRooms.push(r);
    }
    return false;
  }
  verboseRoutingLog("[TowerDrain] Found alternative route: " + f.join(" -> "));
  e.route = f;
  e.routeBack = f.slice().reverse();
  e.safeRoom = f.length >= 2 ? f[f.length - 2] : e.homeRoom;
  const D = [];
  for (var p = 1; p < f.length; p++) {
    const o = f[p];
    if (isMyRoom(o)) continue;
    const r = t.scannedRooms[o];
    if (r && r.passable) {
      if (o === e.safeRoom && !t.safeEdges) {
        D.push(o);
        delete t.scannedRooms[o];
      }
      continue;
    }
    D.push(o);
    if (t.scannedRooms[o]) {
      delete t.scannedRooms[o];
      delete t.routePassability[o];
    }
  }
  if (t.safeEdges) {
    const o = t.scannedRooms[e.safeRoom];
    if (!o || !o.passable) {
      t.safeEdges = null;
    }
  }
  t.roomsToScan = D;
  verboseRoutingLog("[TowerDrain] New safe room: " + e.safeRoom);
  verboseRoutingLog("[TowerDrain] Rooms to scan: " + (D.length > 0 ? D.join(", ") : "none"));
  return true;
}

function getAdjacentRoom(e, o) {
  return roomNavigation.getAdjacentRoom(e, o);
}

function processScanResult(e, o, t) {
  const r = e.scanData;
  const n = o === e.targetRoom;
  const a = o === e.safeRoom;
  const s = e.route.indexOf(o);
  const i = s > 0 ? e.route[s - 1] : null;
  const l = s < e.route.length - 1 ? e.route[s + 1] : null;
  verboseRoutingLog("[TowerDrain] Processing " + o + " (from: " + i + ", to: " + (l || "TARGET") + ")");
  if (n) {
    r.routePassability[o] = true;
    verboseRoutingLog("[TowerDrain] Target room " + o + " - skipping through-passability (attack destination)");
    const e = analyzeRoomEdges(t);
    r.targetEdges = e;
    verboseRoutingLog("[TowerDrain] Target room " + o + " edge analysis:");
    for (var c in e) {
      verboseRoutingLog("[TowerDrain]   " + c + ": " + e[c].totalWalkable + " walkable tiles");
    }
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: true,
      reason: "target_room"
    };
    return;
  }
  const u = checkRoomPassability(t, i, l);
  const g = checkRoomSafety(t);
  if (!g.safe) {
    console.log("[TowerDrain] Room " + o + " is UNSAFE to transit: " + g.reason);
    r.routePassability[o] = false;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: false,
      safe: false,
      safetyReason: g.reason,
      reason: "unsafe_transit"
    };
    if (!r.blockedRooms) r.blockedRooms = [];
    if (r.blockedRooms.indexOf(o) === -1) {
      r.blockedRooms.push(o);
    }
    verboseRoutingLog("[TowerDrain] Attempting immediate reroute around hostile room " + o);
    const t = tryReroute(e, null);
    if (!t) {
      console.log("[TowerDrain] Immediate reroute failed - will try cross-sector routing");
      const o = e.homeRoom + "->" + e.targetRoom;
      convertToCrossSector(e, o);
    }
    return;
  }
  if (a) {
    verboseRoutingLog("[TowerDrain] Safe room " + o + " safety check: SAFE (" + g.reason + ")");
    const e = analyzeRoomEdges(t);
    r.safeEdges = e;
    verboseRoutingLog("[TowerDrain] Safe room " + o + " edge analysis:");
    for (var m in e) {
      verboseRoutingLog("[TowerDrain]   " + m + ": " + e[m].totalWalkable + " walkable tiles");
    }
  }
  if (u.passable) {
    verboseRoutingLog("[TowerDrain] Room " + o + " is passable (exits: " + u.availableExits.join(", ") + ")");
    r.routePassability[o] = true;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: true,
      availableExits: u.availableExits,
      reason: "ok"
    };
    return;
  }
  verboseRoutingLog("[TowerDrain] Room " + o + " BLOCKED for intended path to " + l);
  verboseRoutingLog("[TowerDrain] Available exits: " + (u.availableExits || []).join(", "));
  const f = getExitDirection(o, i);
  verboseRoutingLog("[TowerDrain] Entry direction: " + f);
  const d = [];
  if (u.availableExits) {
    for (var R = 0; R < u.availableExits.length; R++) {
      const e = u.availableExits[R];
      if (e !== f) {
        d.push(e);
      }
    }
  }
  verboseRoutingLog("[TowerDrain] Valid forward exits: " + d.join(", "));
  if (d.length === 0) {
    console.log("[TowerDrain] No forward exits - dead end at " + o);
    r.routePassability[o] = false;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: false,
      availableExits: [],
      reason: "dead_end"
    };
    if (!r.blockedRooms) r.blockedRooms = [];
    if (r.blockedRooms.indexOf(o) === -1) {
      r.blockedRooms.push(o);
    }
    return;
  }
  for (var h = 0; h < d.length; h++) {
    const t = d[h];
    const n = getAdjacentRoom(o, t);
    verboseRoutingLog("[TowerDrain] Trying exit " + t + " to " + n);
    const a = Game.map.findRoute(n, e.targetRoom, {
      routeCallback: function(e) {
        if (e === o) return Infinity;
        if (r.blockedRooms && r.blockedRooms.indexOf(e) !== -1) return Infinity;
        return getRoomRouteCost(e, null);
      }
    });
    if (!a || a === ERR_NO_PATH || a.length === 0) {
      verboseRoutingLog("[TowerDrain] No path from " + n + " to target");
      continue;
    }
    const i = e.route.slice(0, s + 1);
    i.push(n);
    for (var D = 0; D < a.length; D++) {
      const e = a[D].room;
      if (e !== n) {
        i.push(e);
      }
    }
    verboseRoutingLog("[TowerDrain] NEW ROUTE: " + i.join(" -> "));
    e.route = i;
    e.routeBack = i.slice().reverse();
    e.safeRoom = i.length >= 2 ? i[i.length - 2] : e.homeRoom;
    const l = [];
    for (var p = 1; p < i.length; p++) {
      const e = i[p];
      if (isMyRoom(e)) continue;
      if (r.scannedRooms[e]) continue;
      l.push(e);
    }
    r.roomsToScan = l;
    if (!r.scannedRooms[e.safeRoom]) {
      r.safeEdges = null;
    }
    r.routePassability[o] = true;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: true,
      availableExits: u.availableExits,
      usedExit: t,
      reason: "rerouted_via_" + t
    };
    verboseRoutingLog("[TowerDrain] Route updated! New safe room: " + e.safeRoom);
    verboseRoutingLog("[TowerDrain] Remaining rooms to scan: " + l.join(", "));
    return;
  }
  console.log("[TowerDrain] No exit from " + o + " leads to target");
  r.routePassability[o] = false;
  r.scannedRooms[o] = {
    tick: Game.time,
    passable: false,
    availableExits: u.availableExits,
    reason: "no_path_to_target"
  };
  if (!r.blockedRooms) r.blockedRooms = [];
  if (r.blockedRooms.indexOf(o) === -1) {
    r.blockedRooms.push(o);
  }
}

function convertToCrossSector(e, o) {
  verboseRoutingLog("[TowerDrain] Converting operation " + o + " to cross-sector routing");
  const t = e.safeRoom;
  const r = e.targetRoom;
  const n = bfsFindHighwayPaths(t, r, MAX_CROSS_SECTOR_ROUTES);
  if (n.length === 0) {
    console.log("[TowerDrain] BFS found no paths to highways - operation failed");
    e.status = "failed";
    e.failReason = "no_highway_paths";
    return;
  }
  const a = deduplicateRooms(n);
  const s = [];
  for (var i = 0; i < a.length; i++) {
    const o = a[i];
    const t = e.scanData.scannedRooms[o];
    if (t && t.safe !== false) {
      continue;
    }
    s.push(o);
  }
  e.crossSector = true;
  e.route = null;
  e.scanData.candidatePaths = n;
  e.scanData.validPaths = [];
  e.scanData.invalidatedPaths = [];
  e.scanData.roomsToScan = s;
  e.scanData.lastProgressTick = Game.time;
  if (e.scanData.blockedRooms) {
    for (var l = 0; l < e.scanData.blockedRooms.length; l++) {
      invalidatePathsContainingRoom(e, e.scanData.blockedRooms[l]);
    }
  }
  verboseRoutingLog("[TowerDrain] Converted to cross-sector with " + n.length + " candidate paths");
  verboseRoutingLog("[TowerDrain] Rooms to scan: " + s.length);
}

function getExitDirection(e, o) {
  return roomNavigation.getExitDirection(e, o);
}

function finalizeOperation(e, o) {
  const t = e.scanData;
  verboseRoutingLog("[TowerDrain] Finalizing operation " + o);
  let r = false;
  let n = null;
  if (e.route.length >= 2) {
    const o = Game.rooms[e.route[0]];
    if (o) {
      const t = analyzeRoomEdges(o);
      if (t) {
        const o = getDirectionBetweenRooms(e.route[0], e.route[1]);
        if (o && t[o] && t[o].totalWalkable === 0) {
          const s = [];
          const i = [ "N", "S", "E", "W" ];
          for (var a = 0; a < i.length; a++) {
            if (t[i[a]] && t[i[a]].totalWalkable > 0) s.push(i[a]);
          }
          verboseRoutingLog("[TowerDrain] Home room " + e.route[0] + " exit " + o + " blocked. Available: " + s.join(", "));
          r = true;
          n = e.route[0];
        }
      }
    }
  }
  for (var s = 1; !r && s < e.route.length; s++) {
    const o = e.route[s];
    if (o === e.targetRoom) continue;
    if (isMyRoom(o)) {
      const t = Game.rooms[o];
      if (t) {
        const a = e.route[s - 1];
        const i = s < e.route.length - 1 ? e.route[s + 1] : null;
        const l = analyzeRoomEdges(t);
        if (l) {
          const e = getDirectionBetweenRooms(a, o);
          const t = e ? getOppositeEdge(e) : null;
          const s = i ? getDirectionBetweenRooms(o, i) : null;
          if (t && l[t] && l[t].totalWalkable === 0) {
            verboseRoutingLog("[TowerDrain] Own room " + o + " entry from " + t + " blocked (0 walkable edge tiles)");
            r = true;
            n = o;
            break;
          }
          if (s && l[s] && l[s].totalWalkable === 0) {
            verboseRoutingLog("[TowerDrain] Own room " + o + " exit toward " + s + " blocked (0 walkable edge tiles)");
            r = true;
            n = o;
            break;
          }
        }
      }
      continue;
    }
    if (t.routePassability[o] === false) {
      r = true;
      n = o;
      break;
    }
  }
  if (r) {
    verboseRoutingLog("[TowerDrain] Route blocked at " + n + " - attempting final reroute");
    const t = tryReroute(e, o);
    if (!t) {
      console.log("[TowerDrain] Final reroute failed - trying cross-sector routing");
      convertToCrossSector(e, o);
      return;
    }
    return;
  }
  if (e.preferredEdge) {
    e.entryEdge = e.preferredEdge;
    verboseRoutingLog("[TowerDrain] Using preferred entry edge: " + e.entryEdge);
  } else {
    e.entryEdge = getEntryEdge(e.safeRoom, e.targetRoom);
  }
  if (!e.entryEdge) {
    console.log("[TowerDrain] FAILED: Could not determine entry edge");
    e.status = "failed";
    e.failReason = "no_entry_edge";
    return;
  }
  verboseRoutingLog("[TowerDrain] Entry edge determined: " + e.entryEdge);
  if (!t.targetEdges) {
    console.log("[TowerDrain] FAILED: Missing target room edge data");
    e.status = "failed";
    e.failReason = "missing_target_edge_data";
    return;
  }
  if (!t.safeEdges) {
    console.log("[TowerDrain] FAILED: Missing safe room edge data");
    e.status = "failed";
    e.failReason = "missing_safe_edge_data";
    return;
  }
  const i = computeLanes(e);
  if (!i) {
    console.log("[TowerDrain] FAILED: Could not compute valid lanes");
    e.status = "failed";
    e.failReason = "no_valid_lanes";
    return;
  }
  if (e.dryRun) {
    e.status = "dryrun_complete";
    console.log("[TowerDrain] ✓ DRY RUN operation " + o + " completed successfully");
    console.log("[TowerDrain] Route: " + e.route.join(" -> "));
    console.log("[TowerDrain] " + Object.keys(e.lanes).length + " lanes computed");
    console.log("[TowerDrain] Body: " + getTowerDrainBodyLabel(e));
    console.log("[TowerDrain] No creeps will be spawned (dry run mode)");
    return;
  }
  e.status = "ready";
  console.log("[TowerDrain] ✓ Operation " + o + " is READY");
  console.log("[TowerDrain] Route: " + e.route.join(" -> "));
  console.log("[TowerDrain] " + Object.keys(e.lanes).length + " lanes computed");
  console.log("[TowerDrain] Body: " + getTowerDrainBodyLabel(e));
}

function updateOperations() {
  const e = Memory.towerDrainOps.operations;
  let o = null;
  if (Memory.testPlayerRoutes && Memory.testPlayerRoutes.currentTest) {
    const e = Memory.testPlayerRoutes.currentTest;
    o = e.homeRoom + "->" + e.targetRoom;
  }
  for (var t in e) {
    const n = e[t];
    if (!n) {
      delete e[t];
      continue;
    }
    const a = n.homeRoom && Game.rooms[n.homeRoom];
    if (a && (!a.controller || !a.controller.my)) {
      console.log("[TowerDrain] Removing operation with unowned home: " + t);
      if (Memory.towerDrainOps.scanState.opKey === t) {
        clearScanState(Memory.towerDrainOps.scanState);
      }
      if (Memory.towerDrainProgress) delete Memory.towerDrainProgress[t];
      delete e[t];
      continue;
    }
    if (n.creeps) {
      const e = [];
      for (var r = 0; r < n.creeps.length; r++) {
        const o = n.creeps[r];
        if (Game.creeps[o] || isCreepSpawning(o)) {
          e.push(o);
        }
      }
      n.creeps = e;
    }
    if (n.status === "ready" && !n.dryRun && n.creeps && n.creeps.length > 0) {
      n.status = "active";
      verboseRoutingLog("[TowerDrain] Operation " + t + " is now ACTIVE");
    }
    if (t === o) {} else {
      if (n.status === "active" && (!n.creeps || n.creeps.length === 0)) {
        n.status = "ready";
        verboseRoutingLog("[TowerDrain] Operation " + t + ": all drainers dead, resetting to ready for respawn.");
      }
      if (n.status === "failed" || n.status === "dryrun_complete") {
        verboseRoutingLog("[TowerDrain] Auto-clearing " + n.status + " operation " + t);
        if (Memory.towerDrainOps.scanState.opKey === t) {
          clearScanState(Memory.towerDrainOps.scanState);
        }
        if (Memory.towerDrainProgress) delete Memory.towerDrainProgress[t];
        delete e[t];
        continue;
      }
    }
    if (n.scanData && n.status !== "scanning") {
      if (n.status === "ready" || n.status === "active") {
        delete n.scanData.candidatePaths;
        delete n.scanData.validPaths;
        delete n.scanData.invalidatedPaths;
        delete n.scanData.scannedRooms;
        delete n.scanData.routePassability;
        delete n.scanData.roomsToScan;
        delete n.scanData._avoidRooms;
        delete n.scanData._highwayRetries;
        delete n.scanData._homeAvailExits;
        delete n.scanData.lastProgressTick;
      } else if (n.status === "dryrun_complete" || n.status === "failed") {
        delete n.scanData;
      }
    }
  }
}

function isCreepSpawning(e) {
  for (var o in Game.rooms) {
    const r = Game.rooms[o];
    if (!r.controller || !r.controller.my) continue;
    const n = r.find(FIND_MY_SPAWNS);
    for (var t = 0; t < n.length; t++) {
      if (n[t].spawning && n[t].spawning.name === e) {
        return true;
      }
    }
  }
  return false;
}

function hasLostBodyPart(e) {
  for (var o = 0; o < e.body.length; o++) {
    if (e.body[o].hits <= 0) return true;
  }
  return false;
}

function countLostBodyParts(e) {
  let o = 0;
  for (var t = 0; t < e.body.length; t++) {
    if (e.body[t].hits <= 0) o++;
  }
  return o;
}

function firstActiveBodyPartHits(e) {
  for (var o = 0; o < e.body.length; o++) {
    if (e.body[o].hits > 0) return e.body[o].hits;
  }
  return 0;
}

const HEAVY_ATTACKER_PARTS = 25;
function usesLostPartRetreat(e) {
  return e.memory.variant === "drainDemolisher" || e.memory.variant === "bulldozer";
}

function hasNearbyHeavyAttacker(e) {
  const o = e.pos.findInRange(FIND_HOSTILE_CREEPS, 3, {
    filter: function(e) {
      return iff.isHostileCreep(e);
    }
  });
  for (var t = 0; t < o.length; t++) {
    const r = o[t].getActiveBodyparts(ATTACK);
    const n = o[t].getActiveBodyparts(RANGED_ATTACK);
    if (n >= HEAVY_ATTACKER_PARTS) return true;
    if (r >= HEAVY_ATTACKER_PARTS && e.pos.isNearTo(o[t])) return true;
  }
  return false;
}

function getIncomingPartLossThreat(e) {
  const o = firstActiveBodyPartHits(e);
  if (o <= 0) return null;
  const t = e.pos.findInRange(FIND_HOSTILE_CREEPS, 3, {
    filter: function(e) {
      return iff.isHostileCreep(e);
    }
  });
  for (var r = 0; r < t.length; r++) {
    const n = t[r];
    const a = e.pos.getRangeTo(n);
    const s = n.getActiveBodyparts(ATTACK);
    const i = n.getActiveBodyparts(RANGED_ATTACK);
    if (a <= 1 && s * 30 >= o) {
      return "incoming part loss from " + s + " attack parts at range " + a;
    }
    if (a <= 3 && i * 10 >= o) {
      return "incoming part loss from " + i + " ranged parts at range " + a;
    }
  }
  return null;
}

function findSquadHealer(e) {
  const o = e.memory.squadId;
  if (!o) return null;
  return _.find(getRoomState.creepIndex().all, function(e) {
    return e && e.memory && e.memory.role === "drainDemolisher" && e.memory.squadId === o;
  });
}

function hasParkedDrainDemolisherHealer(e) {
  return !!_.find(getRoomState.creepIndex().all, function(o) {
    return o && o.memory && o.memory.role === "drainDemolisher" && o.memory.homeRoom === e.memory.homeRoom && o.memory.targetRoom === e.memory.targetRoom && o.memory.safeRoom === e.memory.safeRoom && o.memory.state === "parked" && o.room.name === e.memory.safeRoom;
  });
}

function getTowerDrainOpKey(e) {
  if (e.memory.opKey) return e.memory.opKey;
  if (e.memory.homeRoom && e.memory.targetRoom) {
    e.memory.opKey = e.memory.homeRoom + "->" + e.memory.targetRoom;
    return e.memory.opKey;
  }
  return null;
}

function getTowerDrainOp(e) {
  const o = getTowerDrainOpKey(e);
  if (!o || !Memory.towerDrainOps || !Memory.towerDrainOps.operations) return null;
  return Memory.towerDrainOps.operations[o] || null;
}

function getTowerDrainLane(e) {
  const o = getTowerDrainOp(e);
  if (!o || !o.lanes) return null;
  let t = e.memory.laneSet === true ? e.memory.laneNumber : e.memory.laneSet;
  if (t === undefined || t === null) t = e.memory.laneNumber;
  if (t === undefined || t === null) return null;
  return o.lanes[String(t)] || null;
}

function getTowerDrainRoute(e, o) {
  const t = getTowerDrainOp(e);
  let r = t ? o ? t.route : t.routeBack : null;
  if (Array.isArray(r) && r.length > 0) return r;
  r = o ? e.memory.route : e.memory.routeBack;
  return Array.isArray(r) && r.length > 0 ? r : null;
}

function getTowerDrainPos(e, o) {
  const t = getTowerDrainLane(e);
  if (t && t[o]) return t[o];
  const r = getTowerDrainOp(e);
  if (o === "targetPos" && r && r.targetPos) return r.targetPos;
  return e.memory[o] || null;
}

function getTowerDrainRoom(e, o) {
  const t = getTowerDrainOp(e);
  return t && t[o] || e.memory[o];
}

function cleanupTowerDrainCreepMemory(e) {
  const o = getTowerDrainOp(e);
  const t = getTowerDrainLane(e);
  if (!o || !t) return;
  delete e.memory.route;
  delete e.memory.routeBack;
  delete e.memory.drainPos;
  delete e.memory.healPos;
  delete e.memory.attackEdgePos;
  delete e.memory.healEdgePos;
  delete e.memory.attackRestPos;
  delete e.memory.healRestPos;
  delete e.memory.targetPos;
  delete e.memory._pathCache;
}

function getTowerDrainHeapPathCache(e) {
  if (!global.__towerDrainPathCache) global.__towerDrainPathCache = {};
  return global.__towerDrainPathCache[e.name] || null;
}

function setTowerDrainHeapPathCache(e, o) {
  if (!global.__towerDrainPathCache) global.__towerDrainPathCache = {};
  global.__towerDrainPathCache[e.name] = o;
}

function clearTowerDrainHeapPathCache(e) {
  if (global.__towerDrainPathCache) delete global.__towerDrainPathCache[e.name];
  delete e.memory._pathCache;
}

const roleTowerDrain = {
  run: function(e) {
    cleanupTowerDrainCreepMemory(e);
    if (!e.memory.notifyDisabled) {
      if (e.notifyWhenAttacked(false) === OK) {
        e.memory.notifyDisabled = true;
      }
    }
    if (!getTowerDrainRoute(e, true) || e.memory.laneSet === undefined) {
      if (e.name.indexOf("TowerDrain_") === 0) {
        if (Game.time % 100 === 0) {
          console.log("[TowerDrain] WARNING: " + e.name + " missing lane data. May be legacy creep.");
        }
        return;
      }
      console.log("[TowerDrain] " + e.name + " missing cached data, suiciding");
      e.suicide();
      return;
    }
    if (!e.memory.state) {
      e.memory.state = "traveling";
    }
    const o = hasLostBodyPart(e);
    const t = countLostBodyParts(e);
    const r = usesLostPartRetreat(e);
    if (e.hits < e.hitsMax) {
      e.heal(e);
    }
    if (r) {
      if (e.ticksToLive) {
        e.memory.lastTTL = e.ticksToLive;
        e.memory.lastRoom = e.room.name;
      }
    }
    let n = null;
    if (r) {
      if (o) {
        n = "lost body part";
      } else if (e.room.name === getTowerDrainRoom(e, "targetRoom") && hasNearbyHeavyAttacker(e)) {
        n = "nearby heavy attacker";
      }
      if (!n && e.room.name === getTowerDrainRoom(e, "targetRoom")) {
        n = getIncomingPartLossThreat(e);
      }
      if (!n && e.memory.variant === "drainDemolisher" && e.room.name === getTowerDrainRoom(e, "targetRoom") && !findSquadHealer(e)) {
        n = "missing drain-demolisher healer";
      }
    } else if (e.room.name === getTowerDrainRoom(e, "targetRoom") && e.hits < e.hitsMax) {
      n = "damaged";
    }
    if (n) {
      if (e.memory.state !== "retreating" || e.memory.retreatReason !== n) {
        verboseRoutingLog("[TowerDrain] " + e.name + " retreating: " + n + " hits=" + e.hits + "/" + e.hitsMax + " lostParts=" + t);
      }
      e.memory.state = "retreating";
      e.memory.retreatReason = n;
      e.say("🏃");
      this.stateRetreating(e);
      return;
    }
    let a = false;
    if (e.getActiveBodyparts(RANGED_ATTACK) > 0) {
      const o = e.pos.findInRange(FIND_HOSTILE_CREEPS, 3, {
        filter: function(e) {
          const o = e.pos.lookFor(LOOK_STRUCTURES);
          for (var t = 0; t < o.length; t++) {
            if (o[t].structureType === STRUCTURE_RAMPART && !o[t].my) return false;
          }
          return true;
        }
      });
      if (o.length > 0) {
        o.sort(function(e, o) {
          return e.hits - o.hits;
        });
        e.rangedAttack(o[0]);
        a = true;
      }
    }
    if (e.memory.state !== "retreating" && e.getActiveBodyparts(ATTACK) > 0) {
      const o = e.pos.findInRange(FIND_HOSTILE_CREEPS, 1);
      if (o.length > 0) {
        e.attack(o[0]);
      } else if (e.room.name === getTowerDrainRoom(e, "targetRoom")) {
        const o = e.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: function(e) {
            return !e.my;
          }
        });
        if (o.length > 0) {
          o.sort(function(e, o) {
            const t = e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART;
            const r = o.structureType === STRUCTURE_WALL || o.structureType === STRUCTURE_RAMPART;
            return (t ? 1 : 0) - (r ? 1 : 0);
          });
          e.attack(o[0]);
        }
      }
    } else if (e.memory.state !== "retreating" && e.getActiveBodyparts(WORK) > 0) {
      if (e.room.name === getTowerDrainRoom(e, "targetRoom") && (e.hits === e.hitsMax || usesLostPartRetreat(e) && !o)) {
        const o = e.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: function(e) {
            return !e.my;
          }
        });
        if (o.length > 0) {
          let t = null;
          const r = getTowerDrainPos(e, "targetPos");
          if (r) {
            for (var s = 0; s < o.length; s++) {
              if (o[s].pos.x === r.x && o[s].pos.y === r.y) {
                t = o[s];
                break;
              }
            }
          }
          if (t) {
            e.dismantle(t);
          } else {
            o.sort(function(e, o) {
              const t = e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART;
              const r = o.structureType === STRUCTURE_WALL || o.structureType === STRUCTURE_RAMPART;
              if (t !== r) return (t ? 1 : 0) - (r ? 1 : 0);
              if (t && r) {
                return (e.hits || Infinity) - (o.hits || Infinity);
              }
              return 0;
            });
            e.dismantle(o[0]);
          }
        }
      }
    } else if (e.memory.state !== "retreating" && !a && e.getActiveBodyparts(RANGED_ATTACK) > 0 && e.room.name === getTowerDrainRoom(e, "targetRoom")) {
      const o = e.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: function(e) {
          return !e.my;
        }
      });
      if (o.length > 0) {
        e.rangedAttack(o[0]);
      }
    }
    switch (e.memory.state) {
     case "traveling":
      this.stateTraveling(e);
      break;
     case "draining":
      this.stateDraining(e);
      break;
     case "retreating":
      this.stateRetreating(e);
      break;
     case "healing":
      this.stateHealing(e);
      break;
     default:
      e.memory.state = "traveling";
      break;
    }
  },
  simpleMoveToPos: function(e, o) {
    if (!o) return ERR_INVALID_ARGS;
    const t = new RoomPosition(o.x, o.y, o.roomName);
    if (e.pos.isEqualTo(t)) return OK;
    if (e.pos.isNearTo(t)) {
      return e.move(e.pos.getDirectionTo(t));
    }
    this.moveToPosition(e, o);
    return OK;
  },
  isLaneSquareBlocked: function(e, o) {
    if (e.room.name !== o.roomName) return false;
    const t = new RoomPosition(o.x, o.y, o.roomName);
    const r = t.lookFor(LOOK_CREEPS);
    return r.length > 0 && r[0].id !== e.id;
  },
  findSidestepTile: function(e, o) {
    const t = getTowerDrainPos(e, "healEdgePos");
    let r;
    if (t && t.y === o.y) {
      r = [ {
        dx: 0,
        dy: -1
      }, {
        dx: 0,
        dy: 1
      } ];
    } else {
      r = [ {
        dx: -1,
        dy: 0
      }, {
        dx: 1,
        dy: 0
      } ];
    }
    const n = {};
    const a = e.memory.homeRoom + "->" + e.memory.targetRoom;
    const s = Memory.towerDrainOps && Memory.towerDrainOps.operations && Memory.towerDrainOps.operations[a];
    if (s && s.lanes) {
      for (var i in s.lanes) {
        const e = s.lanes[i].healRestPos;
        if (e && !(e.x === o.x && e.y === o.y)) {
          n[e.x + "," + e.y] = true;
        }
      }
    }
    const l = Game.map.getRoomTerrain(o.roomName);
    for (var c = 0; c < r.length; c++) {
      const t = o.x + r[c].dx;
      const a = o.y + r[c].dy;
      if (t < 1 || t > 48 || a < 1 || a > 48) continue;
      if (l.get(t, a) === TERRAIN_MASK_WALL) continue;
      if (n[t + "," + a]) continue;
      const s = new RoomPosition(t, a, o.roomName);
      const i = s.lookFor(LOOK_CREEPS);
      if (i.length > 0 && i[0].id !== e.id) continue;
      let g = false;
      const m = s.lookFor(LOOK_STRUCTURES);
      for (var u = 0; u < m.length; u++) {
        const e = m[u].structureType;
        if (e !== STRUCTURE_ROAD && e !== STRUCTURE_CONTAINER && (e !== STRUCTURE_RAMPART || !m[u].my)) {
          g = true;
          break;
        }
      }
      if (!g) return {
        x: t,
        y: a,
        roomName: o.roomName
      };
    }
    return null;
  },
  moveToLaneSquare: function(e, o) {
    if (!o) return;
    const t = new RoomPosition(o.x, o.y, o.roomName);
    if (e.pos.isEqualTo(t)) return;
    if (e.room.name === o.roomName && !e.pos.isNearTo(t) && this.isLaneSquareBlocked(e, o)) {
      const t = this.findSidestepTile(e, o);
      if (t) {
        this.simpleMoveToPos(e, t);
        return;
      }
    }
    this.simpleMoveToPos(e, o);
  },
  followRoomRoute: function(e, o) {
    const t = getTowerDrainRoute(e, o);
    if (!t || t.length === 0) return ERR_NOT_FOUND;
    const r = e.room.name;
    const n = o ? getTowerDrainRoom(e, "targetRoom") : getTowerDrainRoom(e, "homeRoom");
    if (r === n) return OK;
    const a = {};
    for (var s = 0; s < t.length; s++) {
      a[t[s]] = true;
    }
    if (!a[r]) {
      console.log("[TowerDrain] WARNING: " + e.name + " in unauthorized room " + r + "! Moving to center.");
      e.moveTo(25, 25);
      return ERR_NOT_FOUND;
    }
    let i = t.indexOf(r);
    if (i === -1) i = 0;
    const l = i + 1;
    if (l >= t.length) return OK;
    const c = t[l];
    const u = Game.map.findExit(r, c);
    if (u < 0) return ERR_NO_PATH;
    const g = getTowerDrainHeapPathCache(e) || e.memory._pathCache;
    const m = g && g.room === r && g.nextRoom === c && g.tick > Game.time - 5 && g.path && g.path.length > 0;
    let f;
    if (m) {
      f = g.path.map(function(e) {
        return new RoomPosition(e.x, e.y, e.roomName);
      });
    } else {
      const o = roomNavigation.findRoomExitPath(e, c, {
        maxRooms: 1,
        maxOps: 2e3,
        plainCost: 2,
        swampCost: 10
      });
      if (!o.result || o.result.incomplete || o.path.length === 0) {
        const o = e.pos.findClosestByRange(u);
        if (o) {
          e.moveTo(o, {
            maxRooms: 1,
            reusePath: 0
          });
        }
        return ERR_NO_PATH;
      }
      f = o.path;
      const t = [];
      for (var d = 0; d < f.length; d++) {
        t.push({
          x: f[d].x,
          y: f[d].y,
          roomName: f[d].roomName
        });
      }
      setTowerDrainHeapPathCache(e, {
        room: r,
        nextRoom: c,
        tick: Game.time,
        path: t
      });
      delete e.memory._pathCache;
    }
    const R = e.moveByPath(f);
    if (R !== OK && R !== ERR_TIRED) {
      clearTowerDrainHeapPathCache(e);
      if (f[0]) {
        const o = new RoomPosition(f[0].x, f[0].y, f[0].roomName);
        const t = e.pos.getDirectionTo(o);
        e.move(t);
      }
    }
    return OK;
  },
  moveToPosition: function(e, o) {
    if (!o) return;
    const t = new RoomPosition(o.x, o.y, o.roomName);
    if (e.pos.isEqualTo(t)) return;
    if (e.pos.roomName === t.roomName && e.pos.getRangeTo(t) === 1) {
      e.move(e.pos.getDirectionTo(t));
      return;
    }
    const r = getTowerDrainRoom(e, "safeRoom");
    const n = getTowerDrainRoom(e, "targetRoom");
    const a = e.room.name;
    const s = {};
    s[r] = true;
    s[n] = true;
    if (!s[a]) {
      console.log("[TowerDrain] WARNING: " + e.name + " in wrong room " + a + " during bounce!");
      return;
    }
    const i = e.id;
    const l = PathFinder.search(e.pos, {
      pos: t,
      range: 0
    }, {
      maxRooms: 2,
      maxOps: 2e3,
      plainCost: 2,
      swampCost: 10,
      roomCallback: function(e) {
        if (!s[e]) return false;
        const o = Game.rooms[e];
        if (!o) return false;
        return getCachedCostMatrixWithCreeps(o, i);
      }
    });
    if (l.incomplete || l.path.length === 0) {
      e.moveTo(t, {
        maxRooms: 1,
        reusePath: 0
      });
      return;
    }
    const c = e.moveByPath(l.path);
    if (c !== OK && c !== ERR_TIRED) {
      if (l.path[0]) {
        const o = e.pos.getDirectionTo(l.path[0]);
        e.move(o);
      }
    }
  },
  stateTraveling: function(e) {
    const o = getTowerDrainRoom(e, "targetRoom");
    const t = getTowerDrainRoom(e, "safeRoom");
    if (e.room.name !== t && e.room.name !== o) {
      this.followRoomRoute(e, true);
      e.say("🚶");
      return;
    }
    if (e.room.name === t) {
      if (e.memory.variant === "drainDemolisher") {
        const o = findSquadHealer(e);
        let t = o && o.memory.state === "parked";
        if (!t && e.hits === e.hitsMax) {
          t = hasParkedDrainDemolisherHealer(e);
        }
        if (!t) {
          const o = getTowerDrainPos(e, "healRestPos") || getTowerDrainPos(e, "healPos");
          if (o) {
            const t = new RoomPosition(o.x, o.y, o.roomName);
            if (!e.pos.isEqualTo(t)) {
              this.moveToLaneSquare(e, o);
            }
            e.say("⌛");
            return;
          }
        }
      }
      const o = getTowerDrainPos(e, "healEdgePos");
      if (o) {
        this.simpleMoveToPos(e, o);
        e.say("➡️");
      } else {
        this.followRoomRoute(e, true);
        e.say("🚶");
      }
      return;
    }
    const r = getTowerDrainPos(e, "drainPos");
    if (!r) {
      console.log("[TowerDrain] " + e.name + " missing drainPos");
      e.suicide();
      return;
    }
    const n = new RoomPosition(r.x, r.y, r.roomName);
    if (e.pos.isEqualTo(n)) {
      e.memory.state = "draining";
      e.say("😈");
    } else {
      this.simpleMoveToPos(e, r);
      e.say("🎯");
    }
  },
  stateDraining: function(e) {
    if (!usesLostPartRetreat(e) && e.hits < e.hitsMax) {
      e.memory.state = "retreating";
      e.say("🏃");
      return;
    }
    if (hasLostBodyPart(e)) {
      e.memory.state = "retreating";
      e.say("🏃");
      return;
    }
    const o = getTowerDrainPos(e, "drainPos");
    if (!o) {
      e.memory.state = "traveling";
      return;
    }
    const t = new RoomPosition(o.x, o.y, o.roomName);
    if (!e.pos.isEqualTo(t)) {
      this.simpleMoveToPos(e, o);
    }
    e.say("😈");
  },
  stateRetreating: function(e) {
    const o = getTowerDrainPos(e, "healPos");
    const t = getTowerDrainPos(e, "attackEdgePos");
    const r = getTowerDrainRoom(e, "targetRoom");
    const n = getTowerDrainRoom(e, "safeRoom");
    if (!o) {
      e.memory.state = "traveling";
      return;
    }
    if (e.room.name === r) {
      if (t) {
        const o = new RoomPosition(t.x, t.y, t.roomName);
        if (e.pos.isEqualTo(o)) {
          if (t.x === 0) e.move(LEFT); else if (t.x === 49) e.move(RIGHT); else if (t.y === 0) e.move(TOP); else if (t.y === 49) e.move(BOTTOM);
        } else {
          this.simpleMoveToPos(e, t);
        }
      } else {
        this.simpleMoveToPos(e, o);
      }
      e.say("🏃");
      return;
    }
    if (e.room.name === n) {
      const t = new RoomPosition(o.x, o.y, o.roomName);
      if (e.pos.isEqualTo(t)) {
        e.memory.state = "healing";
        return;
      }
      this.moveToLaneSquare(e, o);
      e.say("🏃");
      return;
    }
    this.simpleMoveToPos(e, o);
    e.say("🏃");
  },
  stateHealing: function(e) {
    if (e.hits === e.hitsMax) {
      e.memory.state = "traveling";
      return;
    }
    const o = getTowerDrainPos(e, "healPos");
    if (o) {
      const t = new RoomPosition(o.x, o.y, o.roomName);
      if (!e.pos.isEqualTo(t)) {
        this.moveToLaneSquare(e, o);
      }
    }
    if (e.getActiveBodyparts(HEAL) > 0) e.heal(e);
    e.say("❤️");
  }
};
function trackProgress(e) {
  const o = 1e3;
  const t = 15e3;
  const r = 15;
  const n = e.memory.homeRoom;
  const a = e.memory.targetRoom;
  if (!n || !a) return;
  const s = n + "->" + a;
  if (!isOpLeader(e, s)) return;
  if (!Memory.towerDrainProgress) Memory.towerDrainProgress = {};
  let i = Memory.towerDrainProgress[s];
  if (!i) {
    i = {
      lastScanTick: 0,
      lastEmailTick: 0,
      history: []
    };
    Memory.towerDrainProgress[s] = i;
  }
  if (Game.time - i.lastScanTick >= o) {
    const e = readTargetEnergy(a);
    if (e !== null) {
      const o = getDrainerCountForOp(s);
      const t = i.history;
      const n = {
        tick: Game.time,
        energy: e,
        drainerCount: o
      };
      const a = t.length > 0 ? t[t.length - 1] : null;
      if (a) {
        let t = Game.time - a.tick;
        if (t < 1) t = 1;
        const r = a.energy - e;
        const i = r * 1e3 / t;
        const l = o > 0 ? i / o : 0;
        n.per1kTotal = i;
        n.per1kPerDrainer = l;
        verboseRoutingLog("[TowerDrain " + s + "] energy=" + e + " | drain/1k=" + i.toFixed(1) + " | per drainer=" + l.toFixed(1) + " | count=" + o);
      } else {
        verboseRoutingLog("[TowerDrain " + s + "] initial: energy=" + e + " | count=" + o);
      }
      t.push(n);
      if (t.length > r) t.shift();
      i.lastScanTick = Game.time;
    }
  }
  if (Game.time - i.lastEmailTick >= t) {
    const e = i.history;
    if (e.length >= 2) {
      let o = 0;
      let t = 0;
      for (var l = 0; l < e.length; l++) {
        if (typeof e[l].per1kTotal === "number") {
          o += e[l].per1kTotal;
          t++;
        }
      }
      if (t > 0) {
        const r = o / t;
        const n = e[e.length - 1];
        const a = n.energy;
        const l = r / 1e3;
        const c = l > 0 ? Math.floor(a / l) : null;
        let u = "ETA: unknown";
        if (c && isFinite(c) && c > 0) {
          const e = c * 3;
          const o = Math.floor(e / 86400);
          const t = e % 86400;
          const r = Math.floor(t / 3600);
          const n = Math.floor(t % 3600 / 60);
          u = "ETA: " + o + "d " + r + "h " + n + "m";
        }
        const g = "[TowerDrain " + s + "]\n" + "Energy: " + a + "\n" + "Drainers: " + n.drainerCount + "\n" + "Avg drain: " + r.toFixed(1) + " per 1k ticks\n" + u;
        Game.notify(g);
        i.lastEmailTick = Game.time;
      }
    }
  }
}

function isOpLeader(e, o) {
  const t = Memory.towerDrainOps.operations[o];
  if (!t || !t.creeps || t.creeps.length === 0) return true;
  const r = [];
  for (var n = 0; n < t.creeps.length; n++) {
    if (Game.creeps[t.creeps[n]]) {
      r.push(t.creeps[n]);
    }
  }
  if (r.length === 0) return true;
  r.sort();
  return e.name === r[0];
}

function getDrainerCountForOp(e) {
  const o = Memory.towerDrainOps.operations[e];
  if (!o || !o.creeps) return 0;
  let t = 0;
  for (var r = 0; r < o.creeps.length; r++) {
    if (Game.creeps[o.creeps[r]]) t++;
  }
  return t;
}

function readTargetEnergy(e) {
  const o = Game.rooms[e];
  if (!o) return null;
  if (o.storage) {
    return o.storage.store.getUsedCapacity(RESOURCE_ENERGY);
  }
  const t = o.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_CONTAINER;
    }
  });
  let r = -1;
  for (var n = 0; n < t.length; n++) {
    const e = t[n].store.getUsedCapacity(RESOURCE_ENERGY);
    if (e > r) r = e;
  }
  return r > 0 ? r : null;
}

function getCreepMemoryForLane(e, o, t) {
  initMemory();
  const r = e + "->" + o;
  const n = Memory.towerDrainOps.operations[r];
  if (!n) {
    console.log("[TowerDrain] getCreepMemoryForLane: Operation " + r + " not found");
    return null;
  }
  if (n.dryRun) {
    console.log("[TowerDrain] getCreepMemoryForLane: Operation " + r + " is a dry run - no spawning");
    return null;
  }
  if (n.status !== "ready" && n.status !== "active") {
    console.log("[TowerDrain] getCreepMemoryForLane: Operation " + r + " not ready (status: " + n.status + ")");
    return null;
  }
  const a = n.lanes[String(t)];
  if (!a) {
    console.log("[TowerDrain] getCreepMemoryForLane: Lane " + t + " not found");
    return null;
  }
  return {
    role: "towerDrain",
    opKey: r,
    homeRoom: e,
    targetRoom: o,
    safeRoom: n.safeRoom,
    laneSet: t,
    laneNumber: t,
    variant: n.variant || null,
    state: "traveling"
  };
}

function registerSpawnedCreep(e, o, t) {
  initMemory();
  const r = e + "->" + o;
  const n = Memory.towerDrainOps.operations[r];
  if (!n) {
    console.log("[TowerDrain] Cannot register " + t + " - operation " + r + " not found");
    return false;
  }
  if (!n.creeps) n.creeps = [];
  if (n.creeps.indexOf(t) === -1) {
    n.creeps.push(t);
    verboseRoutingLog("[TowerDrain] Registered " + t + " with operation " + r);
  }
  return true;
}

function clearFailedTowerDrains() {
  initMemory();
  const e = Memory.towerDrainOps.operations;
  const o = [];
  for (var t in e) {
    if (e[t].status === "failed" || e[t].status === "dryrun_complete") {
      o.push(t + "(" + e[t].status + ")");
      delete e[t];
    }
  }
  if (o.length > 0) {
    console.log("[TowerDrain] Cleared " + o.length + " operation(s): " + o.join(", "));
  } else {
    console.log("[TowerDrain] No failed/completed operations to clear");
  }
  return o.length;
}

function testPlayerRoutes(e, o) {
  if (!e) {
    console.log('[TestRoutes] Usage: testPlayerRoutes("PlayerName", "E2N46")');
    return;
  }
  initMemory();
  let t = [];
  if (o) {
    t = [ o ];
  } else {
    for (var r in Game.rooms) {
      const e = Game.rooms[r];
      if (e.controller && e.controller.my && e.controller.level >= 7 && e.find(FIND_MY_SPAWNS).length > 0) {
        t.push(r);
      }
    }
  }
  if (t.length === 0) {
    console.log("[TestRoutes] No valid home rooms found");
    return;
  }
  console.log("[TestRoutes] Home rooms: " + t.join(", "));
  Memory.testPlayerRoutes = {
    playerName: e,
    homeRooms: t,
    phase: "scanning",
    targetRooms: [],
    testQueue: [],
    results: [],
    currentTest: null,
    startTick: Game.time
  };
  console.log("[TestRoutes] Starting wideScan for " + e + "...");
  if (typeof global.wideScan === "function") {
    global.wideScan(e);
  } else {
    console.log("[TestRoutes] wideScan not available. Use testPlayerRoutesSetTargets() to set rooms manually.");
  }
}

function buildTestQueue() {
  const e = Memory.testPlayerRoutes;
  if (!e) return;
  e.testQueue = [];
  const o = [ "N", "S", "E", "W" ];
  for (var t = 0; t < e.targetRooms.length; t++) {
    const a = e.targetRooms[t];
    let s = null;
    let i = Infinity;
    for (var r = 0; r < e.homeRooms.length; r++) {
      const o = Game.map.getRoomLinearDistance(e.homeRooms[r], a);
      if (o < i) {
        i = o;
        s = e.homeRooms[r];
      }
    }
    if (!s) continue;
    for (var n = 0; n < o.length; n++) {
      e.testQueue.push({
        homeRoom: s,
        targetRoom: a,
        edge: o[n],
        status: "pending"
      });
    }
  }
}

function runTestPlayerRoutes() {
  if (!Memory.testPlayerRoutes) return;
  const e = Memory.testPlayerRoutes;
  if (e.phase === "scanning") {
    const t = Memory.roomRegistry;
    if (t && t.sweep && t.sweep.active) {
      return;
    }
    if (t && t.rooms) {
      e.targetRooms = [];
      for (var o in t.rooms) {
        if (t.rooms[o].o === e.playerName) e.targetRooms.push(o);
      }
    }
    if (e.targetRooms.length === 0) {
      console.log("[TestRoutes] wideScan complete but no rooms found for " + e.playerName);
      console.log('[TestRoutes] Use testPlayerRoutesSetTargets(["W1N46"]) to set manually');
      e.phase = "waiting_targets";
      return;
    }
    e.phase = "testing";
    buildTestQueue();
    verboseRoutingLog("[TestRoutes] Found " + e.targetRooms.length + " rooms: " + e.targetRooms.join(", "));
    verboseRoutingLog("[TestRoutes] " + e.testQueue.length + " route tests queued");
    return;
  }
  if (e.phase === "waiting_targets") return;
  if (e.phase === "testing") {
    if (e.currentTest) {
      const o = e.currentTest;
      const t = o.homeRoom + "->" + o.targetRoom;
      const r = Memory.towerDrainOps && Memory.towerDrainOps.operations ? Memory.towerDrainOps.operations[t] : null;
      if (!r) {
        e.results.push({
          homeRoom: o.homeRoom,
          targetRoom: o.targetRoom,
          edge: o.edge,
          status: "error",
          reason: "op_disappeared"
        });
        e.currentTest = null;
      } else if (r.status === "dryrun_complete") {
        e.results.push({
          homeRoom: o.homeRoom,
          targetRoom: o.targetRoom,
          edge: o.edge,
          status: "success",
          route: r.route,
          lanes: Object.keys(r.lanes).length
        });
        delete Memory.towerDrainOps.operations[t];
        if (Memory.towerDrainOps.scanState && Memory.towerDrainOps.scanState.opKey === t) {
          clearScanState(Memory.towerDrainOps.scanState);
        }
        e.currentTest = null;
      } else if (r.status === "failed") {
        e.results.push({
          homeRoom: o.homeRoom,
          targetRoom: o.targetRoom,
          edge: o.edge,
          status: "failed",
          reason: r.failReason || "unknown"
        });
        delete Memory.towerDrainOps.operations[t];
        e.currentTest = null;
      } else if (r.status === "scanning") {
        if (Game.time - (o.startTick || Game.time) > 200) {
          e.results.push({
            homeRoom: o.homeRoom,
            targetRoom: o.targetRoom,
            edge: o.edge,
            status: "timeout",
            reason: "scan_timeout_200t"
          });
          delete Memory.towerDrainOps.operations[t];
          e.currentTest = null;
        }
        return;
      } else {
        return;
      }
    }
    if (e.testQueue.length === 0) {
      e.phase = "complete";
      reportTestResults();
      return;
    }
    const o = e.testQueue.shift();
    const t = o.homeRoom + "->" + o.targetRoom;
    if (Memory.towerDrainOps && Memory.towerDrainOps.operations && Memory.towerDrainOps.operations[t]) {
      delete Memory.towerDrainOps.operations[t];
    }
    const r = e.results.length;
    const n = r + e.testQueue.length + 1;
    verboseRoutingLog("[TestRoutes] (" + (r + 1) + "/" + n + ") " + o.homeRoom + " -> " + o.targetRoom + " edge " + o.edge);
    const a = orderTowerDrain(o.homeRoom, o.targetRoom, 2, o.edge, null);
    if (Memory.towerDrainOps && Memory.towerDrainOps.operations && Memory.towerDrainOps.operations[t]) {
      Memory.towerDrainOps.operations[t].dryRun = true;
    }
    if (a !== OK) {
      e.results.push({
        homeRoom: o.homeRoom,
        targetRoom: o.targetRoom,
        edge: o.edge,
        status: "failed",
        reason: "order_err_" + a
      });
    } else {
      o.startTick = Game.time;
      e.currentTest = o;
    }
  }
}

function reportTestResults() {
  const e = Memory.testPlayerRoutes;
  if (!e) return;
  const o = Game.time - e.startTick;
  const t = [];
  t.push("[TestRoutes] BATCH COMPLETE: " + e.playerName);
  t.push("Targets: " + e.targetRooms.join(", "));
  t.push("Tests: " + e.results.length + " | Ticks: " + o);
  t.push("");
  const r = {};
  for (var n = 0; n < e.results.length; n++) {
    const o = e.results[n];
    if (!r[o.targetRoom]) r[o.targetRoom] = [];
    r[o.targetRoom].push(o);
  }
  for (var a in r) {
    const e = r[a];
    t.push("-- " + a + " --");
    let o = null;
    for (var s = 0; s < e.length; s++) {
      const r = e[s];
      const n = r.status === "success" ? "OK" : "X";
      if (r.status === "success") {
        const e = r.route[0] + "..." + r.route[r.route.length - 1];
        t.push(n + " " + r.edge + ": " + e + " " + r.route.length + "rm " + r.lanes + "L");
        if (!o || r.route.length < o.route.length) o = r;
      } else {
        t.push(n + " " + r.edge + ": " + r.reason);
      }
    }
    if (o) {
      t.push("BEST: " + o.edge + " " + o.route.length + "rm " + o.lanes + "L");
      t.push("Route: " + o.route.join(">"));
    } else {
      t.push("NO ROUTE FOUND");
    }
    t.push("");
  }
  console.log("");
  console.log("════════════════════════════════════════════════════════════");
  for (var i = 0; i < t.length; i++) {
    console.log("  " + t[i]);
  }
  console.log("════════════════════════════════════════════════════════════");
  const l = 380;
  const c = [];
  let u = "";
  for (var g = 0; g < t.length; g++) {
    const e = t[g];
    if (e.length > l) {
      if (u.length > 0) {
        c.push(u);
        u = "";
      }
      let o = 0;
      while (o < e.length) {
        c.push(e.substring(o, o + l));
        o += l;
      }
      continue;
    }
    const o = u.length + (u.length > 0 ? 1 : 0) + e.length;
    if (o > l) {
      c.push(u);
      u = e;
    } else {
      if (u.length > 0) {
        u += "\n" + e;
      } else {
        u = e;
      }
    }
  }
  if (u.length > 0) {
    c.push(u);
  }
  for (var m = 0; m < c.length; m++) {
    const e = "[" + (m + 1) + "/" + c.length + "] ";
    Game.notify(e + c[m], 0);
  }
  verboseRoutingLog("[TestRoutes] Sent " + c.length + " notification(s)");
  delete Memory.testPlayerRoutes;
}

function testPlayerRoutesStatus() {
  if (!Memory.testPlayerRoutes) {
    console.log("[TestRoutes] No active test.");
    return;
  }
  const e = Memory.testPlayerRoutes;
  console.log("[TestRoutes] Player: " + e.playerName + " | Phase: " + e.phase);
  console.log("[TestRoutes] Targets: " + e.targetRooms.join(", "));
  console.log("[TestRoutes] Done: " + e.results.length + " | Queued: " + e.testQueue.length);
  if (e.currentTest) console.log("[TestRoutes] Current: " + e.currentTest.homeRoom + "->" + e.currentTest.targetRoom + " edge " + e.currentTest.edge);
  for (var o = 0; o < e.results.length; o++) {
    const t = e.results[o];
    console.log("  " + (t.status === "success" ? "✓" : "✗") + " " + t.targetRoom + " " + t.edge + ": " + (t.status === "success" ? t.route.length + " rooms" : t.reason));
  }
}

function testPlayerRoutesCancel() {
  if (!Memory.testPlayerRoutes) {
    console.log("[TestRoutes] Nothing to cancel.");
    return;
  }
  if (Memory.testPlayerRoutes.currentTest) {
    const e = Memory.testPlayerRoutes.currentTest;
    const o = e.homeRoom + "->" + e.targetRoom;
    if (Memory.towerDrainOps && Memory.towerDrainOps.operations && Memory.towerDrainOps.operations[o]) {
      delete Memory.towerDrainOps.operations[o];
    }
  }
  delete Memory.testPlayerRoutes;
  console.log("[TestRoutes] Cancelled.");
}

function testPlayerRoutesSetTargets(e) {
  if (!Memory.testPlayerRoutes) {
    console.log('[TestRoutes] Run testPlayerRoutes("PlayerName") first.');
    return;
  }
  Memory.testPlayerRoutes.targetRooms = e;
  Memory.testPlayerRoutes.phase = "testing";
  buildTestQueue();
  console.log("[TestRoutes] Set " + e.length + " targets, " + Memory.testPlayerRoutes.testQueue.length + " tests queued");
}

global.testPlayerRoutes = testPlayerRoutes;
global.testPlayerRoutesStatus = testPlayerRoutesStatus;
global.testPlayerRoutesCancel = testPlayerRoutesCancel;
global.testPlayerRoutesSetTargets = testPlayerRoutesSetTargets;
function testTowerDrain(e, o, t, r, n, a) {
  const s = {
    dryRun: true,
    longRange: n === "long"
  };
  if (n && n !== "long" && n !== "standard") {
    s.body = parseTowerDrainBodySpec(n);
    if (!s.body) {
      console.log("[TowerDrain] Invalid body option: " + n + '. Use "long", "standard", or a custom spec like "10t5w25m10h".');
      return ERR_INVALID_ARGS;
    }
    s.bodySpec = n.toLowerCase().replace(/\s+/g, "");
  }
  if (a !== undefined && a !== null && a !== "" && a !== "work" && a !== "rangedAttack") {
    console.log("[TowerDrain] Invalid extraPart: " + a + '. Use "work" or "rangedAttack".');
    return ERR_INVALID_ARGS;
  }
  if (s.body && a) {
    console.log("[TowerDrain] Cannot combine custom body spec with extraPart. Put all desired parts in the body spec.");
    return ERR_INVALID_ARGS;
  }
  s.extraPart = a || null;
  console.log("[TowerDrain] === DRY RUN === Planning " + e + " -> " + o + " [" + getTowerDrainBodyLabel(s) + "] (no spawning)");
  initMemory();
  if (r) r = r.toUpperCase();
  const i = findObserverForRoom(o);
  if (!i) {
    console.log("[TowerDrain] Cannot start: no observer within range of " + o);
    return ERR_NOT_FOUND;
  }
  const l = e + "->" + o;
  if (Memory.towerDrainOps.operations[l]) {
    delete Memory.towerDrainOps.operations[l];
  }
  const c = r ? getAdjacentRoom(o, r) : null;
  if (areInSameSector(e, o)) {
    return orderTowerDrainSameSector(e, o, t || 1, r, c, i, l, s);
  } else {
    return orderTowerDrainCrossSector(e, o, t || 1, r, c, i, l, s);
  }
}

function orderBulldozer(e, o, t, r) {
  const n = getBulldozerOptions(false);
  initMemory();
  if (r) r = r.toUpperCase();
  if (r && [ "N", "S", "E", "W" ].indexOf(r) === -1) {
    console.log("[TowerDrain] Invalid preferredEdge: " + r + ". Use N, S, E, or W.");
    return ERR_INVALID_ARGS;
  }
  console.log("[TowerDrain] === BULLDOZER === Ordering " + e + " -> " + o + " x" + (t || 1) + " [" + getTowerDrainBodyLabel(n) + "]");
  const a = Game.rooms[e];
  if (!a) {
    console.log("[TowerDrain] Cannot start: no vision of home room " + e);
    return ERR_NOT_FOUND;
  }
  if (!a.controller || !a.controller.my) {
    console.log("[TowerDrain] Cannot start: " + e + " is not owned");
    return ERR_INVALID_TARGET;
  }
  if (!a.storage) {
    console.log("[TowerDrain] Cannot start: " + e + " has no storage");
    return ERR_INVALID_TARGET;
  }
  const s = a.find(FIND_MY_SPAWNS);
  if (s.length === 0) {
    console.log("[TowerDrain] Cannot start: " + e + " has no spawns");
    return ERR_INVALID_TARGET;
  }
  const i = findObserverForRoom(o);
  if (!i) {
    console.log("[TowerDrain] Cannot start: no observer within range of " + o);
    return ERR_NOT_FOUND;
  }
  const l = e + "->" + o;
  if (Memory.towerDrainOps.operations[l]) {
    const e = Memory.towerDrainOps.operations[l];
    if (e.status === "failed" || e.status === "dryrun_complete") {
      console.log("[TowerDrain] Clearing " + e.status + " operation " + l + (e.failReason ? " (reason: " + e.failReason + ")" : ""));
      delete Memory.towerDrainOps.operations[l];
    } else {
      console.log("[TowerDrain] Operation " + l + " already exists (status: " + e.status + ")");
      return ERR_NAME_EXISTS;
    }
  }
  const c = r ? getAdjacentRoom(o, r) : null;
  if (areInSameSector(e, o)) {
    return orderTowerDrainSameSector(e, o, t || 1, r, c, i, l, n);
  } else {
    return orderTowerDrainCrossSector(e, o, t || 1, r, c, i, l, n);
  }
}

function resolveDrainDemolisherTarget(e, o, t) {
  if (e === undefined || e === null) {
    return {
      edge: o || null,
      targetPos: null
    };
  }
  if (typeof e.x !== "number" || typeof e.y !== "number" || e.x < 0 || e.x > 49 || e.y < 0 || e.y > 49) {
    console.log("[TowerDrain] Invalid target: expected {x:0-49, y:0-49}, got " + String(e));
    return null;
  }
  const r = [];
  if (e.x <= 2) r.push("W");
  if (e.x >= 47) r.push("E");
  if (e.y <= 2) r.push("N");
  if (e.y >= 47) r.push("S");
  if (r.length === 0) {
    console.log("[TowerDrain] Target (" + e.x + "," + e.y + ") is deeper than 2 tiles from every edge. " + "Drain demolishers hold the depth-1 drain line and cannot reach it.");
    return null;
  }
  let n;
  if (r.length === 1) {
    n = r[0];
    if (o && o !== n) {
      console.log("[TowerDrain] preferredEdge " + o + " ignored: target (" + e.x + "," + e.y + ") is only reachable from the " + n + " edge");
    }
  } else if (o && r.indexOf(o) !== -1) {
    n = o;
  } else {
    console.log("[TowerDrain] Target (" + e.x + "," + e.y + ") is near a corner, reachable from " + r.join(" or ") + ". Pass preferredEdge to pick one.");
    return null;
  }
  return {
    edge: n,
    targetPos: {
      x: e.x,
      y: e.y,
      roomName: t
    }
  };
}

function orderDrainDemolisher(e, o, t, r, n) {
  initMemory();
  if (r) r = r.toUpperCase();
  if (r && [ "N", "S", "E", "W" ].indexOf(r) === -1) {
    console.log("[TowerDrain] Invalid preferredEdge: " + r + ". Use N, S, E, or W.");
    return ERR_INVALID_ARGS;
  }
  let a = resolveDrainDemolisherTarget(n, r, o);
  if (!a) return ERR_INVALID_ARGS;
  r = a.edge;
  t = t || 1;
  if (t > DRAIN_DEMOLISHER_MAX_PAIRS) {
    console.log("[TowerDrain] Drain-demolisher pair count capped at " + DRAIN_DEMOLISHER_MAX_PAIRS);
    t = DRAIN_DEMOLISHER_MAX_PAIRS;
  }
  const s = getDrainDemolisherOptions(false, a.targetPos);
  console.log("[TowerDrain] === DRAIN DEMOLISHER === Ordering " + e + " -> " + o + " x" + t + " pairs [" + getTowerDrainBodyLabel(s) + "]" + (a.targetPos ? " target (" + a.targetPos.x + "," + a.targetPos.y + ")" : ""));
  const i = Game.rooms[e];
  if (!i) {
    console.log("[TowerDrain] Cannot start: no vision of home room " + e);
    return ERR_NOT_FOUND;
  }
  if (!i.controller || !i.controller.my) {
    console.log("[TowerDrain] Cannot start: " + e + " is not owned");
    return ERR_INVALID_TARGET;
  }
  if (!i.storage) {
    console.log("[TowerDrain] Cannot start: " + e + " has no storage");
    return ERR_INVALID_TARGET;
  }
  if (i.energyCapacityAvailable < 7500) {
    console.log("[TowerDrain] Cannot start: " + e + " energy capacity " + i.energyCapacityAvailable + " < 7500 needed for the 25H/25M healer (RCL8)");
    return ERR_NOT_ENOUGH_ENERGY;
  }
  const l = i.find(FIND_MY_SPAWNS);
  if (l.length === 0) {
    console.log("[TowerDrain] Cannot start: " + e + " has no spawns");
    return ERR_INVALID_TARGET;
  }
  const c = findObserverForRoom(o);
  if (!c) {
    console.log("[TowerDrain] Cannot start: no observer within range of " + o);
    return ERR_NOT_FOUND;
  }
  const u = e + "->" + o;
  if (Memory.towerDrainOps.operations[u]) {
    const e = Memory.towerDrainOps.operations[u];
    if (e.status === "failed" || e.status === "dryrun_complete") {
      console.log("[TowerDrain] Clearing " + e.status + " operation " + u + (e.failReason ? " (reason: " + e.failReason + ")" : ""));
      delete Memory.towerDrainOps.operations[u];
    } else {
      console.log("[TowerDrain] Operation " + u + " already exists (status: " + e.status + ")");
      return ERR_NAME_EXISTS;
    }
  }
  const g = r ? getAdjacentRoom(o, r) : null;
  if (areInSameSector(e, o)) {
    return orderTowerDrainSameSector(e, o, t, r, g, c, u, s);
  } else {
    return orderTowerDrainCrossSector(e, o, t, r, g, c, u, s);
  }
}

function testDrainDemolisher(e, o, t, r, n) {
  initMemory();
  if (r) r = r.toUpperCase();
  if (r && [ "N", "S", "E", "W" ].indexOf(r) === -1) {
    console.log("[TowerDrain] Invalid preferredEdge: " + r + ". Use N, S, E, or W.");
    return ERR_INVALID_ARGS;
  }
  let a = resolveDrainDemolisherTarget(n, r, o);
  if (!a) return ERR_INVALID_ARGS;
  r = a.edge;
  t = t || 1;
  if (t > DRAIN_DEMOLISHER_MAX_PAIRS) t = DRAIN_DEMOLISHER_MAX_PAIRS;
  const s = getDrainDemolisherOptions(true, a.targetPos);
  console.log("[TowerDrain] === DRAIN DEMOLISHER DRY RUN === Planning " + e + " -> " + o + " [" + getTowerDrainBodyLabel(s) + "]" + (a.targetPos ? " target (" + a.targetPos.x + "," + a.targetPos.y + ")" : "") + " (no spawning)");
  const i = findObserverForRoom(o);
  if (!i) {
    console.log("[TowerDrain] Cannot start: no observer within range of " + o);
    return ERR_NOT_FOUND;
  }
  const l = e + "->" + o;
  if (Memory.towerDrainOps.operations[l]) {
    delete Memory.towerDrainOps.operations[l];
  }
  const c = r ? getAdjacentRoom(o, r) : null;
  if (areInSameSector(e, o)) {
    return orderTowerDrainSameSector(e, o, t, r, c, i, l, s);
  } else {
    return orderTowerDrainCrossSector(e, o, t, r, c, i, l, s);
  }
}

function testBulldozer(e, o, t, r) {
  const n = getBulldozerOptions(true);
  console.log("[TowerDrain] === BULLDOZER DRY RUN === Planning " + e + " -> " + o + " [" + getTowerDrainBodyLabel(n) + "] (no spawning)");
  initMemory();
  if (r) r = r.toUpperCase();
  if (r && [ "N", "S", "E", "W" ].indexOf(r) === -1) {
    console.log("[TowerDrain] Invalid preferredEdge: " + r + ". Use N, S, E, or W.");
    return ERR_INVALID_ARGS;
  }
  const a = findObserverForRoom(o);
  if (!a) {
    console.log("[TowerDrain] Cannot start: no observer within range of " + o);
    return ERR_NOT_FOUND;
  }
  const s = e + "->" + o;
  if (Memory.towerDrainOps.operations[s]) {
    delete Memory.towerDrainOps.operations[s];
  }
  const i = r ? getAdjacentRoom(o, r) : null;
  if (areInSameSector(e, o)) {
    return orderTowerDrainSameSector(e, o, t || 1, r, i, a, s, n);
  } else {
    return orderTowerDrainCrossSector(e, o, t || 1, r, i, a, s, n);
  }
}

global.orderTowerDrain = orderTowerDrain;
global.orderBulldozer = orderBulldozer;
global.orderDrainDemolisher = orderDrainDemolisher;
global.testDrainDemolisher = testDrainDemolisher;
global.cancelTowerDrainOrder = cancelTowerDrainOrder;
global.setTowerDrainCount = setTowerDrainCount;
global.addTowerDrainUnits = addTowerDrainUnits;
global.addBulldozerUnits = addBulldozerUnits;
global.updateBulldozerBodies = updateBulldozerBodies;
global.updateDrainDemolisherBodies = updateDrainDemolisherBodies;
global.getTowerDrainStatus = getTowerDrainStatus;
global.clearFailedTowerDrains = clearFailedTowerDrains;
global.getCreepMemoryForLane = getCreepMemoryForLane;
global.testTowerDrain = testTowerDrain;
global.testBulldozer = testBulldozer;
global.debugPassability = function(e, o) {
  const t = Game.rooms[e];
  if (!t) {
    console.log("[Debug] No vision of " + e);
    return;
  }
  console.log("[Debug] === Passability check for " + e + " -> " + (o || "ALL") + " ===");
  let r;
  if (t.controller && t.controller.my) {
    const o = t.find(FIND_MY_CREEPS);
    if (o.length > 0) {
      r = o[0].pos;
      console.log("[Debug] Using creep position: " + r);
    } else {
      const o = t.find(FIND_MY_SPAWNS);
      if (o.length > 0) {
        r = new RoomPosition(o[0].pos.x, o[0].pos.y - 1, e);
        console.log("[Debug] Using tile near spawn: " + r);
      } else {
        r = new RoomPosition(25, 25, e);
        console.log("[Debug] No creeps/spawns, using center: " + r);
      }
    }
  } else {
    r = new RoomPosition(25, 25, e);
    console.log("[Debug] Not owned, using center: " + r);
  }
  const n = buildCostMatrix(t);
  const a = t.find(FIND_STRUCTURES);
  let s = 0, i = 0, l = 0, c = 0;
  for (var u = 0; u < a.length; u++) {
    if (a[u].structureType === STRUCTURE_WALL) s++;
    if (a[u].structureType === STRUCTURE_RAMPART) {
      i++;
      if (a[u].my) l++;
      if (a[u].isPublic) c++;
    }
  }
  console.log("[Debug] Structures: " + s + " walls, " + i + " ramparts (" + l + " own, " + c + " public)");
  console.log("[Debug] Cost at start pos (" + r.x + "," + r.y + "): " + n.get(r.x, r.y));
  const g = [ FIND_EXIT_TOP, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT, FIND_EXIT_RIGHT ];
  const m = [ "N (TOP)", "S (BOTTOM)", "W (LEFT)", "E (RIGHT)" ];
  for (var f = 0; f < g.length; f++) {
    const o = t.find(g[f]);
    if (o.length === 0) {
      console.log("[Debug] Exit " + m[f] + ": 0 tiles (no terrain exit)");
      continue;
    }
    const a = [];
    for (var d = 0; d < o.length; d++) {
      a.push({
        pos: o[d],
        range: 0
      });
    }
    const s = e;
    const i = PathFinder.search(r, a, {
      roomCallback: function() {
        return n;
      },
      maxRooms: 1,
      maxOps: 5e3
    });
    console.log("[Debug] Exit " + m[f] + ": " + o.length + " tiles, pathfinder: " + (i.incomplete ? "INCOMPLETE" : "OK") + " (path: " + i.path.length + ", ops: " + i.ops + ", cost: " + i.cost + ")");
  }
  const R = checkRoomPassability(t, null, o || null);
  console.log("[Debug] checkRoomPassability result: passable=" + R.passable + ", reason=" + R.reason + ", exits=" + (R.availableExits || []).join(","));
};
global.debugTowerDrainRoute = function(e, o, t) {
  console.log("[TowerDrain Debug] Testing route from " + e + " to " + o + (t ? " avoiding " + t : ""));
  const r = [];
  const n = Game.map.findRoute(e, o, {
    routeCallback: function(e) {
      if (t && e === t) {
        r.push(e + "(avoided)");
        return Infinity;
      }
      const o = getRoomRouteCost(e, null);
      if (o === Infinity) {
        r.push(e + "(cost)");
      } else if (o > 1) {
        console.log("[TowerDrain Debug] Room " + e + " has cost " + o);
      }
      return o;
    }
  });
  console.log("[TowerDrain Debug] findRoute returned: " + typeof n + (Array.isArray(n) ? ", length=" + n.length : ", value=" + String(n)));
  if (r.length > 0) {
    console.log("[TowerDrain Debug] Rooms returning Infinity: " + r.join(", "));
  }
  if (!n || n === ERR_NO_PATH) {
    console.log("[TowerDrain Debug] No path found");
    return null;
  }
  if (n.length === 0) {
    console.log("[TowerDrain Debug] Empty route returned (rooms might be adjacent)");
    return [ e, o ];
  }
  const a = [ e ];
  for (var s = 0; s < n.length; s++) {
    a.push(n[s].room);
  }
  console.log("[TowerDrain Debug] Route: " + a.join(" -> "));
  return a;
};
global.debugTowerDrainSector = function(e, o) {
  console.log("[TowerDrain Debug] Room 1: " + e + " -> Sector: " + getSectorName(e));
  console.log("[TowerDrain Debug] Room 2: " + o + " -> Sector: " + getSectorName(o));
  console.log("[TowerDrain Debug] Same sector: " + areInSameSector(e, o));
};
global.debugTowerDrainBFS = function(e, o) {
  console.log("[TowerDrain Debug] BFS from " + e + " (excluding " + o + ")");
  const t = bfsFindHighwayPaths(e, o, MAX_CROSS_SECTOR_ROUTES);
  console.log("[TowerDrain Debug] Found " + t.length + " paths:");
  for (var r = 0; r < t.length; r++) {
    let e = "";
    for (var n = 0; n < t[r].length; n++) {
      const o = t[r][n];
      if (n > 0) e += " -> ";
      e += o.room;
      if (o.entryDir || o.exitDir) {
        e += "(" + (o.entryDir || "?") + ">" + (o.exitDir || "?") + ")";
      }
    }
    console.log("[TowerDrain Debug]   " + (r + 1) + ": " + e);
  }
  return t;
};
function run() {
  initMemory();
  runScanner();
  updateOperations();
  runTestPlayerRoutes();
}

function runCreep(e) {
  roleTowerDrain.run(e);
  trackProgress(e);
}

module.exports = {
  run: run,
  runCreep: runCreep,
  orderTowerDrain: orderTowerDrain,
  orderBulldozer: orderBulldozer,
  orderDrainDemolisher: orderDrainDemolisher,
  testDrainDemolisher: testDrainDemolisher,
  setTowerDrainCount: setTowerDrainCount,
  addTowerDrainUnits: addTowerDrainUnits,
  addBulldozerUnits: addBulldozerUnits,
  updateBulldozerBodies: updateBulldozerBodies,
  updateDrainDemolisherBodies: updateDrainDemolisherBodies,
  testTowerDrain: testTowerDrain,
  testBulldozer: testBulldozer,
  testPlayerRoutes: testPlayerRoutes,
  cancelTowerDrainOrder: cancelTowerDrainOrder,
  getTowerDrainStatus: getTowerDrainStatus,
  clearFailedTowerDrains: clearFailedTowerDrains,
  registerSpawnedCreep: registerSpawnedCreep,
  getCreepMemoryForLane: getCreepMemoryForLane,
  areInSameSector: areInSameSector,
  getSectorName: getSectorName,
  bfsFindHighwayPaths: bfsFindHighwayPaths
};
