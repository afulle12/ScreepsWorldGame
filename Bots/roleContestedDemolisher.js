// LLM: Read docs/codex.js before reviewing or changing this file.
// roleContestedDemolisher.js
// Role dispatch: memory.role === 'contestedDemolisher' -> roleContestedDemolisher.run(creep).
// Console globals: orderContestedDemolisher, cancelContestedDemolisherOrder, resetContestedDemolisherOrder, forceCompleteContestedDemolisher, clearFailedContestedDemolishers, getContestedDemolisherStatus, testContestedDemolisher, testContestedDemolisherRoutes, testContestedDemolisherRoutesStatus, testContestedDemolisherRoutesCancel, testContestedDemolisherRoutesSetTargets, wideScan
// Example: orderContestedDemolisher('W1N1', 'W2N2', 1) - Order contested demolisher creep
// Example: cancelContestedDemolisherOrder('W1N1') - Cancel contested demolisher order
// Example: resetContestedDemolisherOrder('W1N1') - Reset active demolisher order state
// Example: forceCompleteContestedDemolisher('W1N1') - Mark demolisher order complete
// Example: clearFailedContestedDemolishers() - Clear failed demolisher order records
// Example: getContestedDemolisherStatus('W1N1') - View demolisher status for room
// Example: testContestedDemolisher('W1N1', 'W2N2') - Test demolisher route and viability
// Example: testContestedDemolisherRoutes('W1N1', ['W2N2']) - Batch test routes for demolisher
// Example: testContestedDemolisherRoutesStatus() - View route test progress
// Example: testContestedDemolisherRoutesCancel() - Cancel active route testing
// Example: testContestedDemolisherRoutesSetTargets(['W2N2']) - Set target rooms for route test
// Example: wideScan('W1N1', 5) - Run wide-area route and threat scan
//   orderContestedDemolisher('E4N49', 'E4N51'[, mode])  mode: 'towers'
//     (towers only), 'military' (towers, nuker, power spawn, labs), or
//     legacy true (same as 'towers'); omit for 'all'.
//   cancelContestedDemolisherOrder('E4N51')
//   getContestedDemolisherStatus()
//   resetContestedDemolisherOrder('E5N52')
//   testContestedDemolisher('E4N49', 'E4N51'[, mode])  Dry run.
//   testContestedDemolisherRoutes('PlayerName'[, 'E4N49'][, mode])
//   testContestedDemolisherRoutesSetTargets(['W1N46', 'W2N43'])
//   testContestedDemolisherRoutesStatus() / testContestedDemolisherRoutesCancel()
//   Place CD_Breach_<targetRoom> on a hostile wall/rampart to force that
//   breach; also works with only one contested demolisher active.
//   'all' (default)  All hostile structures except roads, containers,
//     controllers, portals, walls, ramparts.
//   'towers'    Towers only, then the weakest hostile wall/rampart if none remain.
//   'military'  Towers, nuker, power spawn, labs (priority order), then the
//     weakest hostile wall/rampart if none remain.
// IMPORTANT: spawning is handled by spawnManager.js
const OBSERVER_RANGE = 10;
const MAX_CROSS_SECTOR_ROUTES = 16;
const CROSS_SECTOR_PROGRESS_INTERVAL = 10;
const SCAN_OBSERVER_HOLD_TICKS = 15;
const SCAN_OBSERVER_TIMEOUT_TICKS = 120;
function verboseRoutingLog(e) {
  if (Memory.debug && Memory.debug.verboseRouting) console.log(e);
}

const MILITARY_STRUCTURE_PRIORITY = [ STRUCTURE_TOWER, STRUCTURE_NUKER, STRUCTURE_POWER_SPAWN, STRUCTURE_LAB ];
const ALL_STRUCTURE_PRIORITY = [ STRUCTURE_TOWER, STRUCTURE_SPAWN, STRUCTURE_NUKER, STRUCTURE_POWER_SPAWN, STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_FACTORY, STRUCTURE_LAB, STRUCTURE_OBSERVER, STRUCTURE_LINK, STRUCTURE_EXTENSION ];
const iff = require("iff");
const util = require("util");
const getRoomState = require("getRoomState");
const scanner = require("scanner");
const roomNavigation = require("roomNavigation");
function cancelPendingScan(e) {
  const o = e && e.scanData && e.scanData.pendingScan;
  if (!o) return;
  scanner.observe.cancel(o.roomName, o.source || "contestedDemolisher:" + e.squadId);
  delete e.scanData.pendingScan;
}

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

function getRoomRouteCost(e, o, t) {
  return roomNavigation.getRoomRouteCost(e, o, {
    targetRoom: t,
    isFriendlyUsername: iff.isFriendlyUsername
  });
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
  return roomNavigation.checkRoomPassability(e, o, t, {
    blockObstacles: true,
    entryStrategy: o ? "median" : "center",
    plainCost: 2,
    swampCost: 10,
    maxOps: 5e3,
    cacheTtl: 1
  });
}

function analyzeRoomEdges(e) {
  return roomNavigation.analyzeRoomEdges(e, {
    blockObstacles: true,
    requireDepthOne: false
  });
}

function analyzeApproachDepth(e) {
  return roomNavigation.analyzeApproachDepth(e);
}

const getOppositeEdge = util.getOppositeEdge;
function getAdjacentRoom(e, o) {
  return roomNavigation.getAdjacentRoom(e, o);
}

function getExitDirection(e, o) {
  return roomNavigation.getExitDirection(e, o);
}

function getRoomNeighbors(e) {
  return roomNavigation.getRoomNeighbors(e);
}

function bfsFindHighwayPaths(e, o, t) {
  const r = getExitDirection(e, o);
  return roomNavigation.bfsFindHighwayPaths(e, o, t || MAX_CROSS_SECTOR_ROUTES, {
    canReachRoom: canAnyObserverReach,
    startEntryDir: r ? getOppositeEdge(r) : null,
    log: function(o) {
      verboseRoutingLog("[ContestedDemolisher] " + o + " to highways from " + e);
    }
  });
}

function deduplicateRooms(e) {
  return roomNavigation.deduplicateRooms(e);
}

function getPathNodeRoom(e) {
  return roomNavigation.getPathNodeRoom(e);
}

function selectBestCrossSectorRoute(e, o, t, r) {
  return roomNavigation.selectBestCrossSectorRoute(e, o, t, {
    approachDepth: r,
    routeCost: function(e) {
      return getRoomRouteCost(e, null, o);
    },
    allowTarget: true
  });
}

function invalidatePathsContainingRoom(e, o) {
  if (!e.scanData.candidatePaths) return;
  var t = roomNavigation.invalidatePathsContainingRoom(e.scanData.candidatePaths, o);
  if (!e.scanData.invalidatedPaths) e.scanData.invalidatedPaths = [];
  Array.prototype.push.apply(e.scanData.invalidatedPaths, t.invalidated);
  e.scanData.candidatePaths = t.remaining;
  if (t.remaining.length === 0) {
    console.log("[ContestedDemolisher] All candidate paths have been invalidated");
  }
}

function invalidatePathsWithBlockedExit(e, o, t) {
  if (!e.scanData.candidatePaths || t.length === 0) return;
  var r = roomNavigation.invalidatePathsWithBlockedExit(e.scanData.candidatePaths, o, t);
  if (!e.scanData.invalidatedPaths) e.scanData.invalidatedPaths = [];
  Array.prototype.push.apply(e.scanData.invalidatedPaths, r.invalidated);
  if (r.invalidated.length > 0) {
    verboseRoutingLog("[ContestedDemolisher] Invalidated " + r.invalidated.length + " paths due to blocked exits at " + o);
  }
  e.scanData.candidatePaths = r.remaining;
}

function areRoomsAdjacent(e, o) {
  return roomNavigation.areRoomsAdjacent(e, o);
}

function validateRoute(e) {
  return roomNavigation.validateRoomSequence(e);
}

function repairRoute(e, o) {
  return roomNavigation.repairRoute(e, o, {
    routeCost: function(e) {
      return getRoomRouteCost(e, null, o);
    }
  });
}

function ensureValidRoute(e) {
  if (!e.route) return true;
  const o = validateRoute(e.route);
  if (o.valid) return true;
  console.log("[ContestedDemolisher] Route broken at index " + o.breakIndex + ": " + o.from + " is not adjacent to " + o.to);
  const t = repairRoute(e.route, e.targetRoom);
  if (!t) {
    console.log("[ContestedDemolisher] Route could not be repaired");
    return false;
  }
  const r = validateRoute(t);
  if (!r.valid) {
    console.log("[ContestedDemolisher] Repaired route still broken at " + r.from + " -> " + r.to);
    return false;
  }
  verboseRoutingLog("[ContestedDemolisher] Route repaired: " + t.join(" -> "));
  e.route = t;
  e.routeBack = t.slice().reverse();
  return true;
}

function initMemory() {
  if (!Memory.contestedDemolisherOrders) {
    Memory.contestedDemolisherOrders = [];
  }
  if (!Array.isArray(Memory.contestedDemolisherOrders)) {
    const o = [];
    for (var e in Memory.contestedDemolisherOrders) {
      if (Memory.contestedDemolisherOrders[e]) o.push(Memory.contestedDemolisherOrders[e]);
    }
    Memory.contestedDemolisherOrders = o;
  }
  if (Memory.contestedDemolisherScanState) {
    delete Memory.contestedDemolisherScanState;
  }
}

global.testContestedDemolisherRoutes = function(e, o, t) {
  if (!e) {
    console.log('[TestCDRoutes] Usage: testContestedDemolisherRoutes("PlayerName", "homeRoom"?, "targetMode"?)');
    return;
  }
  initMemory();
  let r = [];
  if (o) {
    r = [ o ];
  } else {
    for (var s in Game.rooms) {
      const e = Game.rooms[s];
      if (e.controller && e.controller.my && e.controller.level >= 7 && e.find(FIND_MY_SPAWNS).length > 0) {
        r.push(s);
      }
    }
  }
  if (r.length === 0) {
    console.log("[TestCDRoutes] No valid home rooms found");
    return;
  }
  console.log("[TestCDRoutes] Home rooms: " + r.join(", "));
  Memory.testCDRoutes = {
    playerName: e,
    homeRooms: r,
    targetMode: t || "all",
    phase: "scanning",
    targetRooms: [],
    testQueue: [],
    results: [],
    currentTest: null,
    startTick: Game.time
  };
  console.log("[TestCDRoutes] Starting wideScan for " + e + "...");
  if (typeof global.wideScan === "function") {
    global.wideScan(e);
  } else {
    console.log("[TestCDRoutes] wideScan not available.");
    console.log('[TestCDRoutes] Use testContestedDemolisherRoutesSetTargets(["W1N46", ...]) to set rooms manually.');
  }
};
global.testContestedDemolisherRoutesSetTargets = function(e) {
  if (!Memory.testCDRoutes) {
    console.log('[TestCDRoutes] Run testContestedDemolisherRoutes("PlayerName") first.');
    return;
  }
  Memory.testCDRoutes.targetRooms = e;
  Memory.testCDRoutes.phase = "testing";
  buildCDTestQueue(Memory.testCDRoutes);
  console.log("[TestCDRoutes] Set " + e.length + " target(s), " + Memory.testCDRoutes.testQueue.length + " test(s) queued");
};
global.testContestedDemolisherRoutesStatus = function() {
  if (!Memory.testCDRoutes) {
    console.log("[TestCDRoutes] No active batch test.");
    return;
  }
  const e = Memory.testCDRoutes;
  console.log("[TestCDRoutes] Player: " + e.playerName + " | Phase: " + e.phase + " | Mode: " + (e.targetMode || "all"));
  console.log("[TestCDRoutes] Targets: " + (e.targetRooms.join(", ") || "(none yet)"));
  console.log("[TestCDRoutes] Done: " + e.results.length + " | Queued: " + e.testQueue.length);
  if (e.currentTest) {
    console.log("[TestCDRoutes] Current: " + e.currentTest.homeRoom + " -> " + e.currentTest.targetRoom + " (started tick " + e.currentTest.startTick + ")");
  }
  for (var o = 0; o < e.results.length; o++) {
    const t = e.results[o];
    const r = t.status === "success" ? "✓" : "✗";
    const s = t.status === "success" ? t.route.length + " rooms" + (t.approachEdge ? " approach:" + t.approachEdge : "") : t.reason;
    console.log("  " + r + " " + t.targetRoom + ": " + s);
  }
};
global.testContestedDemolisherRoutesCancel = function() {
  if (!Memory.testCDRoutes) {
    console.log("[TestCDRoutes] Nothing to cancel.");
    return;
  }
  if (Memory.testCDRoutes.currentTest) {
    const e = Memory.testCDRoutes.currentTest;
    Memory.contestedDemolisherOrders = _.filter(Memory.contestedDemolisherOrders, function(o) {
      return !(o && o.homeRoom === e.homeRoom && o.targetRoom === e.targetRoom);
    });
  }
  delete Memory.testCDRoutes;
  console.log("[TestCDRoutes] Cancelled.");
};
global.testContestedDemolisher = function(e, o, t, r) {
  console.log("[ContestedDemolisher] === DRY RUN === Planning " + e + " -> " + o + " (no spawning)");
  if (typeof t === "object") {
    r = t;
    t = "all";
  }
  r = r || {};
  r.dryRun = true;
  global.orderContestedDemolisher(e, o, t || "all", r);
};
global.orderContestedDemolisher = function(e, o, t, r) {
  if (!e || !o) {
    console.log('Usage: orderContestedDemolisher("spawnRoom", "targetRoom", targetMode?)');
    console.log('  targetMode: "all" (default), "towers", "military", or true (legacy = towers)');
    console.log("  military targets: towers, nuker, power spawn, labs (in priority order)");
    return;
  }
  if (t === true) {
    t = "towers";
  } else if (!t || t === false) {
    t = "all";
  }
  const s = [ "all", "towers", "military" ];
  if (s.indexOf(t) === -1) {
    console.log('[ContestedDemolisher] Invalid targetMode "' + t + '". Use: ' + s.join(", "));
    return;
  }
  if (!r) r = {};
  initMemory();
  const n = Game.rooms[e];
  if (!n) {
    console.log("[ContestedDemolisher] Cannot start: no vision of home room " + e);
    return;
  }
  if (!n.controller || !n.controller.my) {
    console.log("[ContestedDemolisher] Cannot start: " + e + " is not owned");
    return;
  }
  const a = n.find(FIND_MY_SPAWNS);
  if (a.length === 0) {
    console.log("[ContestedDemolisher] Cannot start: " + e + " has no spawns");
    return;
  }
  const i = findObserverForRoom(o);
  if (!i) {
    console.log("[ContestedDemolisher] Cannot start: no RCL 8 room with observer within " + OBSERVER_RANGE + " of " + o);
    return;
  }
  let l = _.some(Memory.contestedDemolisherOrders, function(t) {
    return t && t.homeRoom === e && t.targetRoom === o;
  });
  if (l) {
    console.log("[ContestedDemolisher] Order already exists for " + e + " -> " + o);
    return;
  }
  const c = areInSameSector(e, o);
  console.log("[ContestedDemolisher] Origin sector: " + getSectorName(e) + ", Target sector: " + getSectorName(o));
  console.log("[ContestedDemolisher] Same sector: " + c);
  if (c) {
    createSameSectorOrder(e, o, t, i, r);
  } else {
    createCrossSectorOrder(e, o, t, i, r);
  }
};
function createSameSectorOrder(e, o, t, r, s) {
  if (!s) s = {};
  const n = o;
  const a = Game.map.findRoute(e, o, {
    routeCallback: function(e) {
      return getRoomRouteCost(e, null, n);
    }
  });
  if (!a || a === ERR_NO_PATH || a.length === 0) {
    console.log("[ContestedDemolisher] Cannot find direct route - falling back to cross-sector routing");
    createCrossSectorOrder(e, o, t, r, s);
    return;
  }
  const i = [ e ];
  for (var l = 0; l < a.length; l++) {
    if (a[l] && a[l].room) {
      i.push(a[l].room);
    }
  }
  const c = i.slice().reverse();
  const m = [];
  for (var u = 1; u < i.length; u++) {
    const e = i[u];
    if (!isMyRoom(e)) {
      m.push(e);
    }
  }
  const d = "cd-" + e + "-" + o + "-" + Game.time;
  Memory.contestedDemolisherOrders.push({
    homeRoom: e,
    targetRoom: o,
    squadId: d,
    targetMode: t,
    status: "scanning",
    crossSector: false,
    dryRun: !!s.dryRun,
    preferredApproachEdge: s.preferredApproachEdge || null,
    route: i,
    routeBack: c,
    observerRoom: r.roomName,
    scanData: {
      roomsToScan: m,
      scannedRooms: {},
      routePassability: {},
      blockedRooms: []
    }
  });
  const g = t !== "all" ? " (" + t.toUpperCase() + ")" : "";
  const f = s.dryRun ? " [DRY RUN]" : "";
  console.log("[ContestedDemolisher] Created SAME-SECTOR order for " + o + g + f);
  console.log("[ContestedDemolisher] Route: " + i.join(" -> "));
  console.log("[ContestedDemolisher] Observer in: " + r.roomName + " (distance " + r.distance + ")");
  console.log("[ContestedDemolisher] Rooms to scan: " + m.join(", "));
  const h = Memory.contestedDemolisherOrders[Memory.contestedDemolisherOrders.length - 1];
  if (!ensureValidRoute(h)) {
    console.log("[ContestedDemolisher] Initial route invalid - falling back to cross-sector");
    Memory.contestedDemolisherOrders.pop();
    createCrossSectorOrder(e, o, t, r, s);
  }
}

function createCrossSectorOrder(e, o, t, r, s) {
  if (!s) s = {};
  const n = getRoomNeighbors(o);
  if (n.length === 0) {
    console.log("[ContestedDemolisher] Cannot start: target room has no accessible neighbors");
    return;
  }
  verboseRoutingLog("[ContestedDemolisher] Cross-sector: BFS from all " + n.length + " neighbors of target");
  const a = [];
  const i = Math.ceil(MAX_CROSS_SECTOR_ROUTES / n.length);
  for (var l = 0; l < n.length; l++) {
    const e = n[l].room;
    const t = bfsFindHighwayPaths(e, o, i);
    verboseRoutingLog("[ContestedDemolisher]   " + e + ": found " + t.length + " paths");
    for (var c = 0; c < t.length; c++) {
      a.push(t[c]);
    }
  }
  const m = a;
  if (m.length === 0) {
    console.log("[ContestedDemolisher] BFS found no paths to highways from any neighbor");
    return;
  }
  verboseRoutingLog("[ContestedDemolisher] Total candidate paths: " + m.length);
  const u = deduplicateRooms(m);
  if (u.indexOf(o) === -1) {
    u.push(o);
  }
  const d = "cd-" + e + "-" + o + "-" + Game.time;
  Memory.contestedDemolisherOrders.push({
    homeRoom: e,
    targetRoom: o,
    squadId: d,
    targetMode: t,
    status: "scanning",
    crossSector: true,
    dryRun: !!s.dryRun,
    preferredApproachEdge: s.preferredApproachEdge || null,
    route: null,
    routeBack: null,
    observerRoom: r.roomName,
    scanData: {
      roomsToScan: u,
      scannedRooms: {},
      routePassability: {},
      blockedRooms: [],
      candidatePaths: m,
      validPaths: [],
      invalidatedPaths: [],
      lastProgressTick: Game.time,
      targetApproachDepth: null
    }
  });
  const g = t !== "all" ? " (" + t.toUpperCase() + ")" : "";
  const f = s.dryRun ? " [DRY RUN]" : "";
  console.log("[ContestedDemolisher] Created CROSS-SECTOR order for " + o + g + f);
  console.log("[ContestedDemolisher] Candidate paths: " + m.length);
  console.log("[ContestedDemolisher] Total rooms to scan: " + u.length);
}

global.cancelContestedDemolisherOrder = function(e) {
  initMemory();
  const o = Memory.contestedDemolisherOrders.length;
  const t = [];
  for (var r = 0; r < Memory.contestedDemolisherOrders.length; r++) {
    const o = Memory.contestedDemolisherOrders[r];
    if (!o) continue;
    if (o.targetRoom !== e) t.push(o); else cancelPendingScan(o);
  }
  Memory.contestedDemolisherOrders = t;
  const s = Memory.contestedDemolisherOrders.length;
  if (s < o) console.log("[ContestedDemolisher] Canceled order(s) for " + e); else console.log("[ContestedDemolisher] No active order found for " + e);
};
global.getContestedDemolisherStatus = function() {
  initMemory();
  const e = Memory.contestedDemolisherOrders;
  console.log("=== Contested Demolisher Orders (" + e.length + ") ===");
  for (var o = 0; o < e.length; o++) {
    const t = e[o];
    if (!t) continue;
    let r = _.filter(getRoomState.creepIndex().all, function(e) {
      return e.memory.role === "contestedDemolisher" && e.memory.squadId === t.squadId;
    });
    let s = _.filter(r, function(e) {
      return e.memory.roleType === "demolisher";
    });
    let n = _.filter(r, function(e) {
      return e.memory.roleType === "healer";
    });
    const a = t.targetMode || (t.towersOnly ? "towers" : "all");
    console.log("");
    console.log("Order: " + t.homeRoom + " -> " + t.targetRoom);
    console.log("  Squad ID: " + t.squadId);
    console.log("  Status: " + (t.status || "unknown"));
    console.log("  Cross-Sector: " + (t.crossSector ? "YES" : "NO"));
    console.log("  Target Mode: " + a.toUpperCase());
    console.log("  Creeps: " + s.length + " demolisher(s), " + n.length + " healer(s)");
    console.log("  Route: " + (t.route ? t.route.join(" -> ") : "N/A"));
    if (t.approachEdge) {
      console.log("  Approach Edge: " + t.approachEdge);
    }
    if (t.scanData && t.scanData.targetApproachDepth) {
      const e = t.scanData.targetApproachDepth;
      console.log("  Approach Depth: N=" + e.N + " S=" + e.S + " E=" + e.E + " W=" + e.W);
    }
    if (t.readyTick) {
      console.log("  Ready since: tick " + t.readyTick + " (" + (Game.time - t.readyTick) + " ticks ago)");
    }
    if (t.activeTick) {
      console.log("  Active since: tick " + t.activeTick + " (" + (Game.time - t.activeTick) + " ticks ago)");
    }
    if (t.scanData) {
      const e = Object.keys(t.scanData.scannedRooms || {}).length;
      const o = t.scanData.roomsToScan ? t.scanData.roomsToScan.length : 0;
      console.log("  Scan Progress: " + e + "/" + o);
      if (t.crossSector) {
        const e = t.scanData.validPaths ? t.scanData.validPaths.length : 0;
        const o = t.scanData.invalidatedPaths ? t.scanData.invalidatedPaths.length : 0;
        const r = t.scanData.candidatePaths ? t.scanData.candidatePaths.length : 0;
        console.log("  Valid Paths: " + e + "/" + (r + o) + " (invalidated: " + o + ")");
      }
      if (t.scanData.blockedRooms && t.scanData.blockedRooms.length > 0) {
        console.log("  Blocked Rooms: " + t.scanData.blockedRooms.join(", "));
      }
    }
    if (t.failReason) {
      console.log("  Fail Reason: " + t.failReason);
    }
  }
};
global.clearFailedContestedDemolishers = function() {
  initMemory();
  const e = Memory.contestedDemolisherOrders.length;
  const o = [];
  for (var t = 0; t < Memory.contestedDemolisherOrders.length; t++) {
    const e = Memory.contestedDemolisherOrders[t];
    if (!e) continue;
    if (e.status !== "failed") o.push(e); else cancelPendingScan(e);
  }
  Memory.contestedDemolisherOrders = o;
  const r = e - o.length;
  console.log("[ContestedDemolisher] Cleared " + r + " failed order(s)");
};
global.forceCompleteContestedDemolisher = function(e) {
  initMemory();
  const o = Memory.contestedDemolisherOrders.length;
  const t = [];
  for (var r = 0; r < Memory.contestedDemolisherOrders.length; r++) {
    const o = Memory.contestedDemolisherOrders[r];
    if (!o) continue;
    if (o.targetRoom !== e) {
      t.push(o);
    } else {
      cancelPendingScan(o);
      console.log("[ContestedDemolisher] Force completing order: " + o.homeRoom + " -> " + o.targetRoom);
    }
  }
  Memory.contestedDemolisherOrders = t;
  const s = o - t.length;
  if (s > 0) {
    console.log("[ContestedDemolisher] Removed " + s + " order(s) for " + e);
  } else {
    console.log("[ContestedDemolisher] No orders found for " + e);
  }
};
global.resetContestedDemolisherOrder = function(e) {
  initMemory();
  let o = _.find(Memory.contestedDemolisherOrders, function(o) {
    return o && o.targetRoom === e;
  });
  if (!o) {
    console.log("[ContestedDemolisher] No order found for " + e);
    return;
  }
  cancelPendingScan(o);
  let t = [];
  if (o.route) {
    for (var r = 1; r < o.route.length; r++) {
      const e = o.route[r];
      if (!isMyRoom(e)) {
        t.push(e);
      }
    }
  } else if (o.scanData && o.scanData.candidatePaths) {
    t = deduplicateRooms(o.scanData.candidatePaths);
    if (t.indexOf(o.targetRoom) === -1) {
      t.push(o.targetRoom);
    }
  }
  o.status = "scanning";
  o.failReason = null;
  o.approachEdge = null;
  o.scanData = {
    roomsToScan: t,
    scannedRooms: {},
    routePassability: {},
    blockedRooms: [],
    pendingScan: null,
    candidatePaths: o.scanData ? o.scanData.candidatePaths : null,
    validPaths: [],
    invalidatedPaths: [],
    lastProgressTick: Game.time,
    targetApproachDepth: null
  };
  console.log("[ContestedDemolisher] Reset order for " + e + " - will rescan " + t.length + " rooms");
};
function cleanupCompletedOperations() {
  const e = Memory.contestedDemolisherOrders;
  if (!e || e.length === 0) return;
  let o = null;
  if (Memory.testCDRoutes && Memory.testCDRoutes.currentTest) {
    const e = Memory.testCDRoutes.currentTest;
    o = e.homeRoom + "|" + e.targetRoom;
  }
  const t = [];
  for (var r = 0; r < e.length; r++) {
    const s = e[r];
    if (!s) {
      t.push(r);
      continue;
    }
    const n = s.homeRoom + "|" + s.targetRoom;
    if (s.status === "dryrun_complete" && n !== o) {
      t.push(r);
      continue;
    }
    if (s.status === "active") {
      let e = _.filter(getRoomState.creepIndex().all, function(e) {
        return e.memory.role === "contestedDemolisher" && e.memory.squadId === s.squadId;
      });
      if (e.length === 0) {
        verboseRoutingLog("[ContestedDemolisher] Operation " + s.homeRoom + " -> " + s.targetRoom + " COMPLETE (no creeps remaining)");
        t.push(r);
      }
    }
    if (s.status === "ready" && s.readyTick) {
      if (Game.time - s.readyTick > 3e3) {
        let e = _.some(getRoomState.creepIndex().all, function(e) {
          return e.memory.role === "contestedDemolisher" && e.memory.squadId === s.squadId;
        });
        if (!e) {
          console.log("[ContestedDemolisher] Operation " + s.homeRoom + " -> " + s.targetRoom + " EXPIRED (ready but never spawned)");
          t.push(r);
        }
      }
    }
  }
  if (t.length > 0) {
    for (var s = t.length - 1; s >= 0; s--) {
      cancelPendingScan(Memory.contestedDemolisherOrders[t[s]]);
      Memory.contestedDemolisherOrders.splice(t[s], 1);
    }
  }
}

function markOperationActive(e) {
  let o = _.find(Memory.contestedDemolisherOrders, function(o) {
    return o && o.squadId === e;
  });
  if (o && o.status === "ready") {
    o.status = "active";
    o.activeTick = Game.time;
    verboseRoutingLog("[ContestedDemolisher] Operation " + o.homeRoom + " -> " + o.targetRoom + " now ACTIVE");
  }
}

function runScanner() {
  initMemory();
  cleanupCompletedOperations();
  const e = Memory.contestedDemolisherOrders;
  for (var o = 0; o < e.length; o++) {
    const t = e[o];
    if (!t) continue;
    if (t.status !== "scanning") continue;
    if (!t.scanData) continue;
    if (t.scanData.pendingScan) {
      const e = t.scanData.pendingScan;
      const o = Game.rooms[e.roomName];
      if (!e.source) e.source = "contestedDemolisher:" + t.squadId;
      if (!e.deadline) e.deadline = (e.requestedTick || Game.time) + SCAN_OBSERVER_TIMEOUT_TICKS;
      if (t.scanData.scannedRooms[e.roomName]) {
        cancelPendingScan(t);
      } else if (o) {
        verboseRoutingLog("[ContestedDemolisher] Scanning " + e.roomName + " (vision from observer)");
        if (t.crossSector) {
          processCrossSectorScanResult(t, e.roomName, o);
        } else {
          processScanResult(t, e.roomName, o);
        }
        cancelPendingScan(t);
      } else if (Game.time > e.deadline) {
        t.status = "failed";
        t.failReason = "observer_timeout:" + e.roomName;
        console.log("[ContestedDemolisher] Scan timeout for " + e.roomName + "; failing " + t.squadId + ".");
        cancelPendingScan(t);
      } else if (!scanner.observe.request(e.roomName, e.source, scanner.observe.PRI.ONESHOT, {
        untilConsumed: true,
        holdTicks: SCAN_OBSERVER_HOLD_TICKS
      })) {
        t.status = "failed";
        t.failReason = "observer_unreachable:" + e.roomName;
        cancelPendingScan(t);
      } else {
        continue;
      }
    }
  }
  for (var o = 0; o < e.length; o++) {
    const r = e[o];
    if (!r) continue;
    if (r.status !== "scanning") continue;
    if (!r.scanData || !r.scanData.roomsToScan) continue;
    if (r.scanData.pendingScan) continue;
    if (r.crossSector && r.scanData.lastProgressTick) {
      if (Game.time - r.scanData.lastProgressTick >= CROSS_SECTOR_PROGRESS_INTERVAL) {
        const e = Object.keys(r.scanData.scannedRooms || {}).length;
        const o = r.scanData.candidatePaths ? r.scanData.candidatePaths.length : 0;
        const t = r.scanData.invalidatedPaths ? r.scanData.invalidatedPaths.length : 0;
        verboseRoutingLog("[ContestedDemolisher] Cross-sector scan: " + e + "/" + r.scanData.roomsToScan.length + " rooms scanned, " + o + "/" + (o + t) + " routes still valid");
        r.scanData.lastProgressTick = Game.time;
      }
    }
    let s = null;
    for (var t = 0; t < r.scanData.roomsToScan.length; t++) {
      const e = r.scanData.roomsToScan[t];
      if (!r.scanData.scannedRooms[e]) {
        s = e;
        break;
      }
    }
    if (!s) {
      if (r.crossSector) {
        finalizeCrossSectorOperation(r);
      } else {
        finalizeOperation(r);
      }
      continue;
    }
    if (Game.rooms[s]) {
      verboseRoutingLog("[ContestedDemolisher] Scanning " + s + " (existing vision)");
      if (r.crossSector) {
        processCrossSectorScanResult(r, s, Game.rooms[s]);
      } else {
        processScanResult(r, s, Game.rooms[s]);
      }
      return;
    }
    const n = "contestedDemolisher:" + r.squadId;
    if (!scanner.observe.request(s, n, scanner.observe.PRI.ONESHOT, {
      untilConsumed: true,
      holdTicks: SCAN_OBSERVER_HOLD_TICKS
    })) {
      verboseRoutingLog("[ContestedDemolisher] No observer can reach " + s + " - assuming passable");
      r.scanData.scannedRooms[s] = {
        passable: true,
        safe: true,
        reason: "no_observer_assumed_safe"
      };
      r.scanData.routePassability[s] = true;
      continue;
    }
    r.scanData.pendingScan = {
      roomName: s,
      source: n,
      requestedTick: Game.time,
      deadline: Game.time + SCAN_OBSERVER_TIMEOUT_TICKS
    };
    verboseRoutingLog("[ContestedDemolisher] Observer queued for " + s + ".");
    return;
  }
}

function processScanResult(e, o, t) {
  const r = e.scanData;
  const s = o === e.targetRoom;
  const n = e.route.indexOf(o);
  const a = n > 0 ? e.route[n - 1] : null;
  const i = n < e.route.length - 1 ? e.route[n + 1] : null;
  verboseRoutingLog("[ContestedDemolisher] Processing " + o + " (from: " + a + ", to: " + (i || "TARGET") + ")");
  if (s) {
    const s = analyzeRoomEdges(t);
    const n = analyzeApproachDepth(t);
    r.routePassability[o] = true;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: true,
      reason: "target_room_hostile_allowed",
      edges: s,
      approachDepth: n
    };
    r.targetApproachDepth = n;
    if (s) {
      let t = null;
      let r = -1;
      const a = [ "N", "S", "E", "W" ];
      const i = getRoomNeighbors(o);
      for (var l = 0; l < a.length; l++) {
        const e = a[l];
        let o = false;
        for (var c = 0; c < i.length; c++) {
          if (i[c].direction === e) {
            o = true;
            break;
          }
        }
        const m = s[e].totalWalkable;
        if (!o || m === 0) continue;
        const u = n ? n[e] : 0;
        const d = m + u * 2;
        if (d > r) {
          r = d;
          t = e;
        }
      }
      verboseRoutingLog("[ContestedDemolisher] Target room approach analysis:");
      for (var m = 0; m < a.length; m++) {
        const e = a[m];
        verboseRoutingLog("[ContestedDemolisher]   " + e + ": " + s[e].totalWalkable + " walkable tiles, depth " + (n ? n[e] : "?"));
      }
      verboseRoutingLog("[ContestedDemolisher] Best approach: " + t + " (score " + r + ")");
      e.analyzedApproachEdge = t;
    }
    verboseRoutingLog("[ContestedDemolisher] Target room " + o + " - OK (hostile allowed)");
    return;
  }
  const u = checkRoomPassability(t, a, i);
  const d = checkRoomSafety(t);
  if (!d.safe) {
    verboseRoutingLog("[ContestedDemolisher] Room " + o + " is UNSAFE: " + d.reason);
    r.routePassability[o] = false;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: false,
      reason: "unsafe_" + d.reason
    };
    if (r.blockedRooms.indexOf(o) === -1) {
      r.blockedRooms.push(o);
    }
    verboseRoutingLog("[ContestedDemolisher] Attempting cross-sector routing due to blocked room");
    convertToCrossSector(e);
    return;
  }
  if (u.passable) {
    verboseRoutingLog("[ContestedDemolisher] Room " + o + " is passable");
    r.routePassability[o] = true;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: true,
      availableExits: u.availableExits,
      reason: "ok"
    };
    return;
  }
  verboseRoutingLog("[ContestedDemolisher] Room " + o + " BLOCKED, attempting reroute...");
  verboseRoutingLog("[ContestedDemolisher] Available exits: " + (u.availableExits || []).join(", "));
  const g = getExitDirection(o, a);
  const f = [];
  if (u.availableExits) {
    for (var h = 0; h < u.availableExits.length; h++) {
      const e = u.availableExits[h];
      if (e !== g) {
        f.push(e);
      }
    }
  }
  if (f.length === 0) {
    verboseRoutingLog("[ContestedDemolisher] No forward exits - trying cross-sector routing");
    r.routePassability[o] = false;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: false,
      reason: "dead_end"
    };
    if (r.blockedRooms.indexOf(o) === -1) {
      r.blockedRooms.push(o);
    }
    convertToCrossSector(e);
    return;
  }
  for (var R = 0; R < f.length; R++) {
    const t = f[R];
    const s = getAdjacentRoom(o, t);
    if (!s || s === e.homeRoom) continue;
    const a = {};
    for (var p = 0; p < r.blockedRooms.length; p++) {
      a[r.blockedRooms[p]] = true;
    }
    if (a[s]) continue;
    verboseRoutingLog("[ContestedDemolisher] Trying exit " + t + " to " + s);
    const i = o;
    const l = e.targetRoom;
    const c = Game.map.findRoute(s, e.targetRoom, {
      routeCallback: function(e) {
        if (e === i) return Infinity;
        if (a[e]) return Infinity;
        return getRoomRouteCost(e, null, l);
      }
    });
    if (!c || c === ERR_NO_PATH || c.length === 0) {
      verboseRoutingLog("[ContestedDemolisher] No path from " + s + " to target");
      continue;
    }
    const m = e.route.slice(0, n + 1);
    m.push(s);
    for (var T = 0; T < c.length; T++) {
      const e = c[T].room;
      if (e !== s) {
        m.push(e);
      }
    }
    verboseRoutingLog("[ContestedDemolisher] NEW ROUTE: " + m.join(" -> "));
    e.route = m;
    e.routeBack = m.slice().reverse();
    if (!ensureValidRoute(e)) {
      verboseRoutingLog("[ContestedDemolisher] Rerouted path invalid - trying next exit");
      continue;
    }
    const d = [];
    for (var y = 1; y < m.length; y++) {
      const e = m[y];
      if (isMyRoom(e)) continue;
      if (r.scannedRooms[e] && r.scannedRooms[e].passable) continue;
      d.push(e);
    }
    r.roomsToScan = d;
    r.routePassability[o] = true;
    r.scannedRooms[o] = {
      tick: Game.time,
      passable: true,
      availableExits: u.availableExits,
      usedExit: t,
      reason: "rerouted_via_" + t
    };
    verboseRoutingLog("[ContestedDemolisher] Route updated! Remaining to scan: " + d.join(", "));
    return;
  }
  verboseRoutingLog("[ContestedDemolisher] No exit from " + o + " leads to target - trying cross-sector");
  r.routePassability[o] = false;
  r.scannedRooms[o] = {
    tick: Game.time,
    passable: false,
    availableExits: u.availableExits,
    reason: "no_path_to_target"
  };
  if (r.blockedRooms.indexOf(o) === -1) {
    r.blockedRooms.push(o);
  }
  convertToCrossSector(e);
}

function processCrossSectorScanResult(e, o, t) {
  const r = e.scanData;
  const s = o === e.targetRoom;
  const n = checkRoomSafety(t);
  const a = analyzeRoomEdges(t);
  const i = [];
  if (a) {
    if (a.N.totalWalkable === 0) i.push("N");
    if (a.S.totalWalkable === 0) i.push("S");
    if (a.E.totalWalkable === 0) i.push("E");
    if (a.W.totalWalkable === 0) i.push("W");
    if (i.length > 0) {
      verboseRoutingLog("[ContestedDemolisher] Room " + o + " has blocked exits: " + i.join(", "));
    }
  }
  verboseRoutingLog("[ContestedDemolisher] Cross-sector scan of " + o + ": " + (n.safe ? "SAFE" : "HOSTILE") + " (" + n.reason + ")");
  r.scannedRooms[o] = {
    tick: Game.time,
    safe: n.safe,
    reason: n.reason,
    edges: a,
    blockedExits: i
  };
  if (s) {
    const s = analyzeApproachDepth(t);
    r.scannedRooms[o].approachDepth = s;
    r.targetApproachDepth = s;
    r.routePassability[o] = true;
    if (a) {
      let t = null;
      let r = -1;
      const n = [ "N", "S", "E", "W" ];
      const u = getRoomNeighbors(o);
      for (var l = 0; l < n.length; l++) {
        const e = n[l];
        if (a[e].totalWalkable === 0) continue;
        let o = false;
        for (var c = 0; c < u.length; c++) {
          if (u[c].direction === e) {
            o = true;
            break;
          }
        }
        if (!o) continue;
        const i = a[e].totalWalkable;
        const m = s ? s[e] : 0;
        const d = i + m * 2;
        if (d > r) {
          r = d;
          t = e;
        }
      }
      if (t) {
        e.analyzedApproachEdge = t;
        verboseRoutingLog("[ContestedDemolisher] Target " + o + " best approach: " + t + " (score " + r + ")");
      }
      for (var m = 0; m < i.length; m++) {
        invalidatePathsEnteringTargetFromEdge(e, i[m]);
      }
    }
    verboseRoutingLog("[ContestedDemolisher] Target room " + o + " - OK (hostile allowed)");
    return;
  }
  if (!n.safe) {
    verboseRoutingLog("[ContestedDemolisher] Room " + o + " is hostile - invalidating affected paths");
    invalidatePathsContainingRoom(e, o);
    r.routePassability[o] = false;
    return;
  }
  if (i.length > 0) {
    invalidatePathsWithBlockedExit(e, o, i);
  }
  r.routePassability[o] = true;
}

function invalidatePathsEnteringTargetFromEdge(e, o) {
  if (!e.scanData.candidatePaths) return;
  const t = getOppositeEdge(o);
  if (!t) return;
  const r = [];
  let s = 0;
  for (var n = 0; n < e.scanData.candidatePaths.length; n++) {
    const o = e.scanData.candidatePaths[n];
    const a = o[0];
    if (typeof a === "object" && a.entryDir === t) {
      if (!e.scanData.invalidatedPaths) e.scanData.invalidatedPaths = [];
      e.scanData.invalidatedPaths.push(o);
      s++;
    } else {
      r.push(o);
    }
  }
  if (s > 0) {
    verboseRoutingLog("[ContestedDemolisher] Invalidated " + s + " paths entering target from blocked " + o + " edge");
  }
  e.scanData.candidatePaths = r;
}

function convertToCrossSector(e) {
  verboseRoutingLog("[ContestedDemolisher] Converting to cross-sector routing");
  const o = getRoomNeighbors(e.targetRoom);
  if (o.length === 0) {
    console.log("[ContestedDemolisher] No neighbors for target - operation failed");
    e.status = "failed";
    e.failReason = "no_target_neighbors";
    return;
  }
  const t = [];
  for (var r = 0; r < o.length; r++) {
    const s = o[r].room;
    if (e.scanData.blockedRooms && e.scanData.blockedRooms.indexOf(s) !== -1) continue;
    t.push(s);
  }
  if (t.length === 0) {
    console.log("[ContestedDemolisher] All neighbors blocked - operation failed");
    e.status = "failed";
    e.failReason = "all_neighbors_blocked";
    return;
  }
  const s = [];
  const n = Math.ceil(MAX_CROSS_SECTOR_ROUTES / t.length);
  for (var a = 0; a < t.length; a++) {
    const o = t[a];
    const r = bfsFindHighwayPaths(o, e.targetRoom, n);
    verboseRoutingLog("[ContestedDemolisher]   " + o + ": found " + r.length + " paths");
    for (var i = 0; i < r.length; i++) {
      s.push(r[i]);
    }
  }
  const l = s;
  if (l.length === 0) {
    console.log("[ContestedDemolisher] BFS found no paths - operation failed");
    e.status = "failed";
    e.failReason = "no_highway_paths";
    return;
  }
  const c = deduplicateRooms(l);
  if (c.indexOf(e.targetRoom) === -1) {
    c.push(e.targetRoom);
  }
  const m = [];
  for (var u = 0; u < c.length; u++) {
    const o = c[u];
    const t = e.scanData.scannedRooms[o];
    if (t && t.safe !== false && t.passable !== false) {
      continue;
    }
    m.push(o);
  }
  e.crossSector = true;
  e.route = null;
  e.scanData.candidatePaths = l;
  e.scanData.validPaths = [];
  e.scanData.invalidatedPaths = [];
  e.scanData.roomsToScan = m;
  e.scanData.lastProgressTick = Game.time;
  if (!e.scanData.targetApproachDepth) e.scanData.targetApproachDepth = null;
  if (e.scanData.blockedRooms) {
    for (var d = 0; d < e.scanData.blockedRooms.length; d++) {
      invalidatePathsContainingRoom(e, e.scanData.blockedRooms[d]);
    }
  }
  verboseRoutingLog("[ContestedDemolisher] Converted to cross-sector with " + l.length + " candidate paths");
  verboseRoutingLog("[ContestedDemolisher] Rooms to scan: " + m.length);
}

function finalizeOperation(e) {
  const o = e.scanData;
  verboseRoutingLog("[ContestedDemolisher] Finalizing " + e.homeRoom + " -> " + e.targetRoom);
  for (var t = 1; t < e.route.length; t++) {
    const r = e.route[t];
    if (r === e.targetRoom) continue;
    if (o.routePassability[r] === false) {
      verboseRoutingLog("[ContestedDemolisher] Route blocked at " + r + " - trying cross-sector");
      convertToCrossSector(e);
      return;
    }
  }
  if (e.preferredApproachEdge && e.route && e.route.length >= 2) {
    const o = e.route[e.route.length - 2];
    const t = getExitDirection(o, e.targetRoom);
    const n = t ? getOppositeEdge(t) : null;
    if (n && n !== e.preferredApproachEdge) {
      verboseRoutingLog("[ContestedDemolisher] Current approach (" + n + ") differs from preferred (" + e.preferredApproachEdge + ") - attempting reroute");
      let o = null;
      const t = getRoomNeighbors(e.targetRoom);
      for (var r = 0; r < t.length; r++) {
        if (t[r].direction === e.preferredApproachEdge) {
          o = t[r].room;
          break;
        }
      }
      if (o) {
        const t = e.targetRoom;
        const r = Game.map.findRoute(e.homeRoom, o, {
          routeCallback: function(e) {
            return getRoomRouteCost(e, null, t);
          }
        });
        if (r && r !== ERR_NO_PATH && r.length > 0) {
          const t = [ e.homeRoom ];
          for (var s = 0; s < r.length; s++) {
            t.push(r[s].room);
          }
          if (t.indexOf(e.targetRoom) === -1) {
            t.push(e.targetRoom);
          }
          if (t.length <= e.route.length + 3) {
            const r = validateRoute(t);
            const s = t[t.length - 2];
            if (r.valid && s === o) {
              e.route = t;
              e.routeBack = t.slice().reverse();
              e.approachEdge = e.preferredApproachEdge;
              verboseRoutingLog("[ContestedDemolisher] Rerouted for preferred approach: " + e.route.join(" -> "));
            } else {
              verboseRoutingLog("[ContestedDemolisher] Preferred approach route invalid, keeping direct route");
            }
          } else {
            verboseRoutingLog("[ContestedDemolisher] Preferred route too long (" + t.length + " vs " + e.route.length + "), keeping original");
          }
        } else {
          verboseRoutingLog("[ContestedDemolisher] No route to preferred approach, keeping direct route");
        }
      } else {
        verboseRoutingLog("[ContestedDemolisher] Preferred approach has no exit, keeping direct route");
      }
    }
  }
  if (!ensureValidRoute(e)) {
    console.log("[ContestedDemolisher] Final route invalid - trying cross-sector");
    e.status = "scanning";
    convertToCrossSector(e);
    return;
  }
  if (e.route && e.route.length >= 2) {
    const o = e.route[e.route.length - 2];
    const t = getExitDirection(o, e.targetRoom);
    e.approachEdge = t ? getOppositeEdge(t) : null;
  }
  if (e.dryRun) {
    e.status = "dryrun_complete";
    e.readyTick = Game.time;
    console.log("[ContestedDemolisher] ✓ DRY RUN " + e.homeRoom + " -> " + e.targetRoom + " COMPLETE");
    console.log("[ContestedDemolisher] Final route: " + e.route.join(" -> "));
    if (e.approachEdge) {
      console.log("[ContestedDemolisher] Approach edge: " + e.approachEdge);
    }
    return;
  }
  e.status = "ready";
  e.readyTick = Game.time;
  console.log("[ContestedDemolisher] ✓ Operation " + e.homeRoom + " -> " + e.targetRoom + " is READY");
  console.log("[ContestedDemolisher] Final route: " + e.route.join(" -> "));
  if (e.approachEdge) {
    console.log("[ContestedDemolisher] Approach edge: " + e.approachEdge);
  }
}

function finalizeCrossSectorOperation(e) {
  const o = e.scanData;
  verboseRoutingLog("[ContestedDemolisher] Finalizing cross-sector " + e.homeRoom + " -> " + e.targetRoom);
  const t = [];
  for (var r = 0; r < o.candidatePaths.length; r++) {
    const e = o.candidatePaths[r];
    let n = true;
    for (var s = 0; s < e.length; s++) {
      const t = e[s];
      const r = getPathNodeRoom(t);
      const a = o.scannedRooms[r];
      if (!a) {
        verboseRoutingLog("[ContestedDemolisher] WARNING: Room " + r + " in path was not scanned");
        n = false;
        break;
      }
      if (a.safe === false) {
        n = false;
        break;
      }
      if (typeof t === "object" && a.blockedExits) {
        if (t.entryDir && a.blockedExits.indexOf(t.entryDir) !== -1) {
          n = false;
          break;
        }
        if (t.exitDir && a.blockedExits.indexOf(t.exitDir) !== -1) {
          n = false;
          break;
        }
      }
    }
    if (n) {
      t.push(e);
    }
  }
  o.validPaths = t;
  verboseRoutingLog("[ContestedDemolisher] Valid paths after scanning: " + t.length);
  if (t.length === 0) {
    console.log("[ContestedDemolisher] FAILED: No valid paths found");
    e.status = "failed";
    e.failReason = "all_paths_blocked";
    return;
  }
  const n = selectBestCrossSectorRoute(e.homeRoom, e.targetRoom, t, o.targetApproachDepth);
  if (!n) {
    console.log("[ContestedDemolisher] FAILED: Could not select best route");
    e.status = "failed";
    e.failReason = "no_valid_route";
    return;
  }
  verboseRoutingLog("[ContestedDemolisher] Selected route via highway " + n.highwayEntry + " (total length: " + n.totalLength + ", effective: " + n.effectiveLength.toFixed(1) + ")");
  if (n.entryEdge) {
    verboseRoutingLog("[ContestedDemolisher] Target entry edge: " + n.entryEdge);
    e.approachEdge = n.entryEdge;
  }
  const a = Game.map.findRoute(e.homeRoom, n.highwayEntry, {
    routeCallback: function(o) {
      return getRoomRouteCost(o, null, e.targetRoom);
    }
  });
  if (!a || a === ERR_NO_PATH) {
    console.log("[ContestedDemolisher] FAILED: Cannot build route to highway " + n.highwayEntry);
    e.status = "failed";
    e.failReason = "no_route_to_highway";
    return;
  }
  const i = [ e.homeRoom ];
  for (var l = 0; l < a.length; l++) {
    i.push(a[l].room);
  }
  const c = [];
  for (var m = 0; m < n.path.length; m++) {
    c.push(getPathNodeRoom(n.path[m]));
  }
  c.reverse();
  for (var u = 1; u < c.length; u++) {
    if (i.indexOf(c[u]) === -1) {
      i.push(c[u]);
    }
  }
  if (i.indexOf(e.targetRoom) === -1) {
    i.push(e.targetRoom);
  }
  e.route = i;
  e.routeBack = i.slice().reverse();
  if (!ensureValidRoute(e)) {
    console.log("[ContestedDemolisher] FAILED: Assembled cross-sector route is invalid");
    e.status = "failed";
    e.failReason = "invalid_route";
    return;
  }
  verboseRoutingLog("[ContestedDemolisher] Full route: " + e.route.join(" -> "));
  if (e.dryRun) {
    e.status = "dryrun_complete";
    e.readyTick = Game.time;
    console.log("[ContestedDemolisher] ✓ DRY RUN cross-sector " + e.homeRoom + " -> " + e.targetRoom + " COMPLETE");
    if (e.approachEdge) {
      console.log("[ContestedDemolisher] Approach edge: " + e.approachEdge);
    }
    return;
  }
  e.status = "ready";
  e.readyTick = Game.time;
  console.log("[ContestedDemolisher] ✓ Cross-sector operation " + e.homeRoom + " -> " + e.targetRoom + " is READY");
}

module.exports = {
  run: function(e) {
    if (!e) {
      runScanner();
      return;
    }
    const o = e.memory.roleType;
    const t = e.memory.squadId;
    const r = e.memory.homeRoom;
    const s = e.memory.targetRoom;
    if (!o || !t || !r || !s) return;
    if (o === "demolisher") {
      runDemolisher(e);
      return;
    }
    if (o === "healer") {
      runHealer(e);
      return;
    }
  },
  runScanner: runScanner,
  getOrderBySquadId: function(e) {
    initMemory();
    return _.find(Memory.contestedDemolisherOrders, function(o) {
      return o && o.squadId === e;
    });
  },
  isOrderReady: function(e) {
    const o = this.getOrderBySquadId(e);
    return o && (o.status === "ready" || o.status === "active");
  }
};
function findPartner(e, o) {
  const t = e.memory.squadId;
  return _.find(getRoomState.creepIndex().all, function(e) {
    if (!e || !e.memory) return false;
    if (e.memory.role !== "contestedDemolisher") return false;
    if (e.memory.squadId !== t) return false;
    if (e.memory.roleType !== o) return false;
    return true;
  });
}

function followRoomRoute(e, o) {
  const t = o ? e.memory.route : e.memory.routeBack;
  if (!t || t.length === 0) {
    const t = o ? e.memory.targetRoom : e.memory.homeRoom;
    e.moveTo(new RoomPosition(25, 25, t), {
      reusePath: 10
    });
    return ERR_NOT_FOUND;
  }
  const r = e.room.name;
  const s = o ? e.memory.targetRoom : e.memory.homeRoom;
  if (r === s) return OK;
  const n = {};
  for (var a = 0; a < t.length; a++) {
    n[t[a]] = true;
  }
  if (!n[r]) {
    console.log("[ContestedDemolisher] WARNING: " + e.name + " in unauthorized room " + r);
    e.moveTo(25, 25);
    return ERR_NOT_FOUND;
  }
  let i = t.indexOf(r);
  if (i === -1) i = 0;
  const l = i + 1;
  if (l >= t.length) return OK;
  let c = t[l];
  let m = Game.map.findExit(r, c);
  if (m < 0) {
    console.log("[ContestedDemolisher] WARNING: " + e.name + " route has non-adjacent hop " + r + " -> " + c + ", seeking skip");
    let s = false;
    for (var u = l + 1; u < t.length; u++) {
      const e = Game.map.findExit(r, t[u]);
      if (e > 0) {
        c = t[u];
        m = e;
        verboseRoutingLog("[ContestedDemolisher] Skipping to " + c + " (index " + u + ")");
        s = true;
        break;
      }
    }
    if (!s) {
      const t = o ? e.memory.targetRoom : e.memory.homeRoom;
      e.moveTo(new RoomPosition(25, 25, t), {
        reusePath: 10
      });
      return ERR_NO_PATH;
    }
  }
  if (m < 0) return ERR_NO_PATH;
  const d = roomNavigation.findRoomExitPath(e, c, {
    maxRooms: 1,
    maxOps: 2e3,
    plainCost: 2,
    swampCost: 10
  });
  const g = d.result;
  if (!g || g.incomplete || d.path.length === 0) {
    const o = e.pos.findClosestByRange(m);
    if (o) {
      e.moveTo(o, {
        maxRooms: 1,
        reusePath: 0
      });
    }
    return ERR_NO_PATH;
  }
  const f = e.moveByPath(d.path);
  if (f !== OK && f !== ERR_TIRED) {
    if (d.path[0]) {
      const o = e.pos.getDirectionTo(d.path[0]);
      e.move(o);
    }
  }
  return OK;
}

const isEdgePos = util.isOnRoomEdge;
function outwardDirFromEdgePos(e) {
  if (e.x === 0) return LEFT;
  if (e.x === 49) return RIGHT;
  if (e.y === 0) return TOP;
  if (e.y === 49) return BOTTOM;
  return null;
}

function getEdgeExitPosToRoom(e, o) {
  const t = e.room.findExitTo(o);
  if (t === ERR_NO_PATH || t === ERR_INVALID_ARGS) return null;
  const r = e.pos.findClosestByPath(t);
  if (!r) return null;
  let s = r.x;
  let n = r.y;
  if (t === FIND_EXIT_LEFT) s = 0; else if (t === FIND_EXIT_RIGHT) s = 49; else if (t === FIND_EXIT_TOP) n = 0; else if (t === FIND_EXIT_BOTTOM) n = 49;
  return new RoomPosition(s, n, e.room.name);
}

function ensureCrossState(e, o) {
  if (e.memory.cdCross) return;
  const t = getEdgeExitPosToRoom(e, o);
  if (!t) return;
  if (!e.pos.isEqualTo(t)) return;
  if (!isEdgePos(e.pos)) return;
  const r = outwardDirFromEdgePos(e.pos);
  if (!r) return;
  e.memory.cdCross = {
    fromRoom: e.room.name,
    dir: r,
    push: 3
  };
}

function runCrossingDemolisher(e, o, t) {
  const r = e.memory.cdCross;
  if (!r) return false;
  if (e.fatigue > 0) return true;
  if (o && o.fatigue > 0) return true;
  if (e.room.name === r.fromRoom) {
    if (!isEdgePos(e.pos)) {
      const o = getEdgeExitPosToRoom(e, t);
      if (o) e.moveTo(o, {
        range: 0,
        reusePath: 5
      });
      e.memory.cdState = "moving";
      return true;
    }
    e.move(r.dir);
    e.memory.cdState = "moving";
    return true;
  }
  if (e.room.name === e.memory.targetRoom) {
    if (r.push > 1) r.push = 1;
  }
  if (r.push > 0) {
    let o = 0;
    let t = 0;
    if (r.dir === LEFT) o = -1; else if (r.dir === RIGHT) o = 1; else if (r.dir === TOP) t = -1; else if (r.dir === BOTTOM) t = 1;
    const n = e.pos.x + o;
    const a = e.pos.y + t;
    if (n < 1 || n > 48 || a < 1 || a > 48) {
      delete e.memory.cdCross;
      return false;
    }
    let i = false;
    const l = e.room.lookForAt(LOOK_STRUCTURES, n, a);
    for (var s = 0; s < l.length; s++) {
      const e = l[s];
      if (e.structureType === STRUCTURE_WALL) {
        i = true;
        break;
      }
      if (e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic) {
        i = true;
        break;
      }
      if (OBSTACLE_OBJECT_TYPES.indexOf(e.structureType) !== -1) {
        i = true;
        break;
      }
    }
    if (!i) {
      const o = e.room.getTerrain();
      if (o.get(n, a) === TERRAIN_MASK_WALL) {
        i = true;
      }
    }
    if (i) {
      delete e.memory.cdCross;
      return false;
    }
    e.move(r.dir);
    r.push = r.push - 1;
    e.memory.cdState = "moving";
    return true;
  }
  delete e.memory.cdCross;
  return false;
}

function runCrossingHealer(e, o) {
  const t = o.memory.cdCross;
  if (!t) return false;
  if (e.room.name === o.room.name) return false;
  if (e.fatigue > 0) return true;
  if (isEdgePos(e.pos)) {
    e.move(t.dir);
    return true;
  }
  const r = getEdgeExitPosToRoom(e, o.room.name);
  if (r) e.moveTo(r, {
    range: 0,
    reusePath: 5
  });
  return true;
}

function runHealer(e) {
  const o = findPartner(e, "demolisher");
  if (!o) {
    if (!e.memory.partnerGraceTick) {
      e.memory.partnerGraceTick = Game.time;
    }
    if (Game.time - e.memory.partnerGraceTick > 5) {
      e.suicide();
    }
    return;
  }
  delete e.memory.partnerGraceTick;
  if (o.spawning) {
    if (e.hits < e.hitsMax) e.heal(e);
    return;
  }
  if (e.hits < e.hitsMax) e.heal(e);
  if (runCrossingHealer(e, o)) return;
  if (e.room.name !== o.room.name) {
    if (!e.memory.route) {
      let o = _.find(Memory.contestedDemolisherOrders, function(o) {
        return o && o.squadId === e.memory.squadId;
      });
      if (o && o.route) {
        e.memory.route = o.route;
        e.memory.routeBack = o.routeBack;
      }
    }
    followRoomRoute(e, true);
    return;
  }
  if (o.hits < o.hitsMax) {
    if (e.pos.getRangeTo(o) <= 1) e.heal(o); else e.rangedHeal(o);
  }
  const t = o.memory.cdState;
  if (t === "moving") {
    e.moveTo(o, {
      range: 0,
      reusePath: 1
    });
    return;
  }
  if (e.room.name === e.memory.targetRoom && isEdgePos(e.pos)) {
    e.moveTo(o, {
      range: 1,
      reusePath: 0
    });
    return;
  }
  if (e.pos.getRangeTo(o) > 1) {
    e.moveTo(o, {
      range: 1,
      reusePath: 3
    });
  }
}

function resolveTargetMode(e) {
  if (e.memory.targetMode) return e.memory.targetMode;
  if (e.memory.towersOnly) return "towers";
  let o = _.find(Memory.contestedDemolisherOrders, function(o) {
    return o && o.squadId === e.memory.squadId;
  });
  if (o) {
    if (o.targetMode) return o.targetMode;
    if (o.towersOnly) return "towers";
  }
  return "all";
}

function runDemolisher(e) {
  const o = findPartner(e, "healer");
  e.memory.cdState = "waiting";
  const t = e.room.name === e.memory.targetRoom;
  const r = o && o.room.name === e.room.name;
  const s = t && !r;
  if (!o && !s) return;
  if (o && o.spawning && !s) return;
  if (!e.memory.operationMarkedActive) {
    markOperationActive(e.memory.squadId);
    e.memory.operationMarkedActive = true;
  }
  if (!e.memory.route) {
    let u = _.find(Memory.contestedDemolisherOrders, function(o) {
      return o && o.squadId === e.memory.squadId;
    });
    if (u && u.route) {
      e.memory.route = u.route;
      e.memory.routeBack = u.routeBack;
    }
  }
  const n = e.memory.targetRoom;
  if (e.memory.cdCross) {
    runCrossingDemolisher(e, o, n);
    return;
  }
  if (r) {
    if (e.pos.getRangeTo(o) > 1) return;
  }
  const a = e.fatigue > 0 || o && o.fatigue > 0;
  if (a) {
    if (t) {
      const d = resolveTargetMode(e);
      const g = findHostileStructureTarget(e, d);
      if (g && e.pos.getRangeTo(g) <= 1) {
        e.memory.cdState = "dismantling";
        e.dismantle(g);
      }
    }
    return;
  }
  if (e.room.name !== n) {
    const f = e.memory.route;
    if (f) {
      const h = f.indexOf(e.room.name);
      const R = h >= 0 && h < f.length - 1 ? f[h + 1] : null;
      if (R) {
        const p = getEdgeExitPosToRoom(e, R);
        if (p && e.pos.getRangeTo(p) <= 1) {
          if (!e.pos.isEqualTo(p)) {
            e.memory.cdState = "moving";
            e.moveTo(p, {
              range: 0,
              reusePath: 5
            });
            return;
          }
          ensureCrossState(e, R);
          if (e.memory.cdCross) {
            e.memory.cdState = "moving";
            runCrossingDemolisher(e, o, R);
          }
          return;
        }
      }
    }
    e.memory.cdState = "moving";
    followRoomRoute(e, true);
    return;
  }
  if (isEdgePos(e.pos) && !r) {
    e.memory.cdState = "moving";
    const T = e.room.getTerrain();
    let y = 0;
    let D = 0;
    if (e.pos.y === 0) D = 1; else if (e.pos.y === 49) D = -1; else if (e.pos.x === 0) y = 1; else if (e.pos.x === 49) y = -1;
    function isTileWalkable(o, t) {
      if (o < 0 || o > 49 || t < 0 || t > 49) return false;
      if (T.get(o, t) === TERRAIN_MASK_WALL) return false;
      const r = e.room.lookForAt(LOOK_STRUCTURES, o, t);
      for (var s = 0; s < r.length; s++) {
        const e = r[s];
        if (e.structureType === STRUCTURE_WALL) return false;
        if (e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic) return false;
        if (OBSTACLE_OBJECT_TYPES.indexOf(e.structureType) !== -1) return false;
      }
      return true;
    }
    const C = e.pos.x + y;
    const v = e.pos.y + D;
    if (isTileWalkable(C, v)) {
      e.move(e.pos.getDirectionTo(C, v));
      return;
    }
    const S = D !== 0 ? [ {
      dx: 1,
      dy: 0
    }, {
      dx: -1,
      dy: 0
    } ] : [ {
      dx: 0,
      dy: 1
    }, {
      dx: 0,
      dy: -1
    } ];
    for (var i = 0; i < S.length; i++) {
      const E = e.pos.x + S[i].dx;
      const b = e.pos.y + S[i].dy;
      if (E < 0 || E > 49 || b < 0 || b > 49) continue;
      if ((E === 0 || E === 49) && (b === 0 || b === 49)) continue;
      if (isTileWalkable(E, b)) {
        e.move(e.pos.getDirectionTo(E, b));
        return;
      }
    }
    for (var l = 0; l < S.length; l++) {
      const O = e.pos.x + y + S[l].dx;
      const P = e.pos.y + D + S[l].dy;
      if (O < 0 || O > 49 || P < 0 || P > 49) continue;
      if ((O === 0 || O === 49) && (P === 0 || P === 49)) continue;
      if (isTileWalkable(O, P)) {
        e.move(e.pos.getDirectionTo(O, P));
        return;
      }
    }
    e.memory.cdState = "waiting";
    return;
  }
  const c = resolveTargetMode(e);
  const m = findHostileStructureTarget(e, c);
  if (!m) return;
  if (e.pos.getRangeTo(m) > 1) {
    e.memory.cdState = "moving";
    moveToBreaching(e, m);
  } else {
    e.memory.cdState = "dismantling";
    e.dismantle(m);
  }
}

function moveToBreaching(e, o) {
  const t = e.id;
  const r = e.room.name;
  const s = PathFinder.search(e.pos, {
    pos: o.pos,
    range: 1
  }, {
    maxRooms: 1,
    maxOps: 4e3,
    plainCost: 2,
    swampCost: 10,
    roomCallback: function(e) {
      if (e !== r) return false;
      const o = Game.rooms[e];
      if (!o) return false;
      const s = new PathFinder.CostMatrix;
      o.find(FIND_STRUCTURES).forEach(function(e) {
        if (e.structureType === STRUCTURE_ROAD) {
          s.set(e.pos.x, e.pos.y, 1);
        } else if (e.structureType === STRUCTURE_WALL) {
          s.set(e.pos.x, e.pos.y, getBarrierPathCost(e.hits));
        } else if (e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic) {
          s.set(e.pos.x, e.pos.y, getBarrierPathCost(e.hits));
        } else if (OBSTACLE_OBJECT_TYPES.indexOf(e.structureType) !== -1) {
          s.set(e.pos.x, e.pos.y, 255);
        }
      });
      o.find(FIND_CREEPS).forEach(function(e) {
        if (e.id !== t) {
          s.set(e.pos.x, e.pos.y, 255);
        }
      });
      return s;
    }
  });
  if (s.incomplete || s.path.length === 0) {
    e.moveTo(o, {
      reusePath: 3
    });
    return;
  }
  const n = s.path[0];
  if (n) {
    const o = e.room.lookForAt(LOOK_STRUCTURES, n.x, n.y);
    let t = false;
    for (var a = 0; a < o.length; a++) {
      const e = o[a];
      if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic) {
        t = true;
        break;
      }
    }
    if (t) {
      return;
    }
    const r = e.pos.getDirectionTo(n);
    e.move(r);
  }
}

function isHostileBarrier(e) {
  return e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic;
}

function getFlaggedBreachBarrier(e) {
  const o = Game.flags["CD_Breach_" + e.memory.targetRoom] || Game.flags.CD_Breach;
  if (!o || o.pos.roomName !== e.room.name || e.room.name !== e.memory.targetRoom) {
    return null;
  }
  const t = o.pos.lookFor(LOOK_STRUCTURES);
  for (var r = 0; r < t.length; r++) {
    if (isHostileBarrier(t[r])) return t[r];
  }
  return null;
}

function getBarrierPathCost(e) {
  return Math.min(254, 20 + Math.ceil(Math.log((e || 0) + 1) / Math.LN10) * 20);
}

function getTargetPriority(e, o) {
  if (o === "towers") return 0;
  const t = o === "military" ? MILITARY_STRUCTURE_PRIORITY : ALL_STRUCTURE_PRIORITY;
  const r = t.indexOf(e.structureType);
  return r === -1 ? t.length : r;
}

function findBreachPath(e, o) {
  const t = e.room;
  const r = PathFinder.search(e.pos, {
    pos: o.pos,
    range: 1
  }, {
    maxRooms: 1,
    maxOps: 4e3,
    plainCost: 2,
    swampCost: 10,
    roomCallback: function(e) {
      if (e !== t.name) return false;
      const o = new PathFinder.CostMatrix;
      t.find(FIND_STRUCTURES).forEach(function(e) {
        if (e.structureType === STRUCTURE_ROAD) {
          o.set(e.pos.x, e.pos.y, 1);
        } else if (isHostileBarrier(e)) {
          o.set(e.pos.x, e.pos.y, getBarrierPathCost(e.hits));
        } else if (OBSTACLE_OBJECT_TYPES.indexOf(e.structureType) !== -1) {
          o.set(e.pos.x, e.pos.y, 255);
        }
      });
      return o;
    }
  });
  if (r.incomplete) return null;
  let s = 0;
  let n = null;
  for (var a = 0; a < r.path.length; a++) {
    const e = t.lookForAt(LOOK_STRUCTURES, r.path[a].x, r.path[a].y);
    for (var i = 0; i < e.length; i++) {
      if (isHostileBarrier(e[i])) {
        s += e[i].hits;
        if (!n) n = e[i];
      }
    }
  }
  return {
    pathLength: r.path.length,
    barrierHits: s,
    firstBarrier: n
  };
}

function findHostileStructureTarget(e, o) {
  const t = e.room;
  const r = getFlaggedBreachBarrier(e);
  if (r) return r;
  const s = e.memory.cdBreachPlan;
  if (s && s.until >= Game.time) {
    const e = Game.getObjectById(s.targetId);
    const o = s.barrierId && Game.getObjectById(s.barrierId);
    if (e && (!s.barrierId || o)) {
      return o || e;
    }
  }
  delete e.memory.cdBreachPlan;
  const n = t.find(FIND_STRUCTURES, {
    filter: function(e) {
      if (e.my) return false;
      if (o === "towers") {
        return e.structureType === STRUCTURE_TOWER;
      }
      if (o === "military") {
        return MILITARY_STRUCTURE_PRIORITY.indexOf(e.structureType) !== -1;
      }
      if (e.structureType === STRUCTURE_ROAD) return false;
      if (e.structureType === STRUCTURE_CONTAINER) return false;
      if (e.structureType === STRUCTURE_CONTROLLER) return false;
      if (e.structureType === STRUCTURE_PORTAL) return false;
      if (e.structureType === STRUCTURE_WALL) return false;
      if (e.structureType === STRUCTURE_RAMPART) return false;
      return true;
    }
  });
  if (n.length === 0) {
    const e = t.find(FIND_STRUCTURES, {
      filter: function(e) {
        if (e.my) return false;
        return e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART;
      }
    });
    if (e.length === 0) return null;
    return _.min(e, "hits");
  }
  let a = _.min(n, function(e) {
    return getTargetPriority(e, o);
  });
  const i = getTargetPriority(a, o);
  const l = [];
  for (var c = 0; c < n.length; c++) {
    const t = n[c];
    if (getTargetPriority(t, o) !== i) continue;
    const r = findBreachPath(e, t);
    if (r) {
      r.target = t;
      l.push(r);
    }
  }
  if (l.length > 0) {
    l.sort(function(e, o) {
      if (e.barrierHits !== o.barrierHits) return e.barrierHits - o.barrierHits;
      return e.pathLength - o.pathLength;
    });
    const o = l[0];
    e.memory.cdBreachPlan = {
      targetId: o.target.id,
      barrierId: o.firstBarrier && o.firstBarrier.id,
      until: Game.time + 3
    };
    if (o.firstBarrier) {
      const r = o.firstBarrier.pos;
      const s = t.find(FIND_STRUCTURES, {
        filter: function(o) {
          if (o.my) return false;
          if (o.structureType !== STRUCTURE_WALL && !(o.structureType === STRUCTURE_RAMPART && !o.isPublic)) {
            return false;
          }
          if (e.pos.getRangeTo(o) > 1) return false;
          const t = Math.abs(o.pos.x - r.x);
          const s = Math.abs(o.pos.y - r.y);
          return t <= 2 && s <= 2;
        }
      });
      if (s.length > 0) {
        return _.min(s, "hits");
      }
      return o.firstBarrier;
    }
    return o.target;
  }
  const m = t.find(FIND_STRUCTURES, {
    filter: function(o) {
      if (o.my) return false;
      if (o.structureType !== STRUCTURE_WALL && !(o.structureType === STRUCTURE_RAMPART && !o.isPublic)) {
        return false;
      }
      return e.pos.getRangeTo(o) <= 1;
    }
  });
  if (m.length > 0) {
    return _.min(m, "hits");
  }
  const u = e.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function(e) {
      if (e.my) return false;
      return e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART;
    }
  });
  return u || null;
}
