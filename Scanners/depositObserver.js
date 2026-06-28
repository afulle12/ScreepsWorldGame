//depositObserver.js

//Memory.depositObserver.scanQueue = [];
//Memory.depositObserver.roomStatus = {};
//Memory.depositObserver.jobs = {};
//require('depositObserver').harvestResources('TARGET_ROOM_NAME');
//require('depositObserver').stopObservation('TARGET_ROOM_NAME');
//require('depositObserver').cancelJobsInRoom('TARGET_ROOM_NAME');

var DEPOSIT_HARVESTING_ENABLED = true;
var DEPOSIT_TYPES = [RESOURCE_BIOMASS, RESOURCE_METAL, RESOURCE_MIST, RESOURCE_SILICON];
// Add room names here as strings, e.g. ['E1S1', 'W5N5']
var BANNED_ROOMS = ['E9N50'];
var SCAN_INTERVAL = 100;
var OBSERVER_RANGE = 10;
var PASSABILITY_CACHE_TICKS = 1500;
// How long to remember that a room has no observer in range before retrying (ticks).
var UNREACHABLE_CACHE_TICKS = 2000;
var MAX_HARVESTERS = 2;
var MAX_COOLDOWN = 25;
// Home selection: how many Manhattan-nearest homes to evaluate by highway route (Stage 2).
var MAX_HOME_CANDIDATES = 3;
// Per-room weights used when scoring a highway route. Highways are cheap/safe corridors;
// interior rooms cost more so a candidate forced through interior loses to one with a clean shot.
var HIGHWAY_COST = 1;
var INTERIOR_COST = 2.5;
// How long to wait for the scheduler to deliver visibility before retrying a scan.
var SCAN_REQUEST_TIMEOUT = 20;
// Scheduler priorities (see scanner OBS_PRI: one-shots 100, WAR polls 80, monitor 50, sweep last)
var PRI_ROUTE_SCAN   = 60;  // route validation scans — operationally urgent
var PRI_DEPOSIT_WATCH = 55; // periodic deposit re-checks
var iff = require('iff');
var scanner = require('scanner');

function initMemory() {
  if (!Memory.depositObserver) {
    Memory.depositObserver = {
      rooms: {},
      jobs: {},
      roomStatus: {},
      blockedEdges: {},
      scanQueue: [],
      scanState: {},
      unreachableRooms: {}
    };
  }
  if (!Memory.depositObserver.rooms)          Memory.depositObserver.rooms = {};
  if (!Memory.depositObserver.jobs)           Memory.depositObserver.jobs = {};
  if (!Memory.depositObserver.roomStatus)     Memory.depositObserver.roomStatus = {};
  if (!Memory.depositObserver.blockedEdges)   Memory.depositObserver.blockedEdges = {};
  if (!Memory.depositObserver.scanQueue)      Memory.depositObserver.scanQueue = [];
  if (!Memory.depositObserver.scanState)      Memory.depositObserver.scanState = { activeRoom: null, requestedTick: 0 };
  if (!Memory.depositObserver.unreachableRooms) Memory.depositObserver.unreachableRooms = {};
}

// --- CUSTOM GREEDY ROUTER ---

function getRoomLinearDistance(r1, r2) {
  return Game.map.getRoomLinearDistance(r1, r2);
}

function findLinearRoute(startRoom, targetRoom) {
  // A room is "coverable" if at least one observer is within OBSERVER_RANGE of it,
  // OR if it is one of our own rooms (we always have vision there).
  // Coverage checks go through the scanner's shared helper.
  function isCoverable(roomName) {
    var r = Game.rooms[roomName];
    if (r && r.controller && r.controller.my) return true;
    return scanner.observe.inRange(roomName);
  }

  var openSet = [startRoom];
  var cameFrom = {};
  var gScore = {};
  gScore[startRoom] = 0;

  var fScore = {};
  fScore[startRoom] = getRoomLinearDistance(startRoom, targetRoom) * 10;

  var visited = {};
  var blockedEdges = Memory.depositObserver.blockedEdges || {};

  while (openSet.length > 0) {
    var current = openSet[0];
    var minScore = fScore[current] || Infinity;
    var minIndex = 0;

    for (var i = 1; i < openSet.length; i++) {
      var score = fScore[openSet[i]] || Infinity;
      if (score < minScore) {
        minScore = score;
        current = openSet[i];
        minIndex = i;
      }
    }

    if (current === targetRoom) {
      var totalPath = [current];
      while (current in cameFrom) {
        current = cameFrom[current];
        totalPath.unshift(current);
      }
      return totalPath;
    }

    openSet.splice(minIndex, 1);
    visited[current] = true;

    var exits = Game.map.describeExits(current);
    if (!exits) continue;

    for (var dir in exits) {
      var neighbor = exits[dir];
      if (visited[neighbor]) continue;

      // --- BANNED ROOM CHECK ---
      if (BANNED_ROOMS.indexOf(neighbor) !== -1) continue;

      // --- OBSERVER COVERAGE CHECK ---
      // Skip rooms no observer can scan — the planner can never validate them.
      if (!isCoverable(neighbor)) continue;

      var status = Game.map.getRoomStatus(neighbor);
      if (status && status.status !== 'normal') continue;

      var memStatus = Memory.depositObserver.roomStatus[neighbor];
      if (memStatus && memStatus.blocked) continue;

      if (blockedEdges[current + ':' + neighbor]) continue;

      // Diagonal moves (both X and Y change) cost 2 because the creep
      // must physically pass through two room transitions instead of one.
      var moveCost = 1;
      var parsedCurrent  = /^[WE](\d+)[NS](\d+)$/.exec(current);
      var parsedNeighbor = /^[WE](\d+)[NS](\d+)$/.exec(neighbor);
      if (parsedCurrent && parsedNeighbor) {
        var dx = Math.abs(parseInt(parsedCurrent[1], 10) - parseInt(parsedNeighbor[1], 10));
        var dy = Math.abs(parseInt(parsedCurrent[2], 10) - parseInt(parsedNeighbor[2], 10));
        if (dx > 0 && dy > 0) moveCost = 2;
      }
      var tentative_gScore = gScore[current] + moveCost;

      if (typeof gScore[neighbor] === 'undefined' || tentative_gScore < gScore[neighbor]) {
        cameFrom[neighbor] = current;
        gScore[neighbor] = tentative_gScore;
        fScore[neighbor] = tentative_gScore + (getRoomLinearDistance(neighbor, targetRoom) * 10);

        if (openSet.indexOf(neighbor) === -1) {
          openSet.push(neighbor);
        }
      }
    }
  }

  return null;
}

// --- PATHFINDER ROUTE VALIDATION ---

function getEdgeCoords(exitDir) {
  switch (exitDir) {
    case FIND_EXIT_TOP:    return { axis: 'y', value: 0,  range: 'x' };
    case FIND_EXIT_BOTTOM: return { axis: 'y', value: 49, range: 'x' };
    case FIND_EXIT_LEFT:   return { axis: 'x', value: 0,  range: 'y' };
    case FIND_EXIT_RIGHT:  return { axis: 'x', value: 49, range: 'y' };
  }
  return null;
}

function getEntryDirection(prevRoom, thisRoom) {
  var exitDir = Game.map.findExit(prevRoom, thisRoom);
  switch (exitDir) {
    case FIND_EXIT_TOP:    return FIND_EXIT_BOTTOM;
    case FIND_EXIT_BOTTOM: return FIND_EXIT_TOP;
    case FIND_EXIT_LEFT:   return FIND_EXIT_RIGHT;
    case FIND_EXIT_RIGHT:  return FIND_EXIT_LEFT;
  }
  return -1;
}

function pickRandomEdgeTile(roomName, edgeDir) {
  var terrain = Game.map.getRoomTerrain(roomName);
  if (!terrain) return null;

  var coords = getEdgeCoords(edgeDir);
  if (!coords) return null;

  var walkable = [];
  for (var i = 0; i < 50; i++) {
    var x = coords.axis === 'x' ? coords.value : i;
    var y = coords.axis === 'y' ? coords.value : i;
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
      walkable.push({ x: x, y: y });
    }
  }

  if (walkable.length === 0) return null;
  var pick = walkable[Math.floor(Math.random() * walkable.length)];
  return new RoomPosition(pick.x, pick.y, roomName);
}

function getEdgeGoals(roomName, edgeDir) {
  var terrain = Game.map.getRoomTerrain(roomName);
  if (!terrain) return [];

  var coords = getEdgeCoords(edgeDir);
  if (!coords) return [];

  var goals = [];
  for (var i = 0; i < 50; i++) {
    var x = coords.axis === 'x' ? coords.value : i;
    var y = coords.axis === 'y' ? coords.value : i;
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
      goals.push({ pos: new RoomPosition(x, y, roomName), range: 0 });
    }
  }
  return goals;
}

function checkRoomTraversal(roomName, prevRoom, nextRoom) {
  var entryDir = getEntryDirection(prevRoom, roomName);
  var exitDir  = Game.map.findExit(roomName, nextRoom);
  if (entryDir < 0 || exitDir < 0) return false;

  var startPos = pickRandomEdgeTile(roomName, entryDir);
  if (!startPos) return false;

  var goals = getEdgeGoals(roomName, exitDir);
  if (goals.length === 0) return false;

  var result = PathFinder.search(startPos, goals, {
    plainCost: 2,
    swampCost: 10,
    maxOps: 4000,
    maxRooms: 1,
    roomCallback: function (rName) {
      if (rName !== roomName) return false;
      return buildRoomCostMatrix(rName);
    }
  });

  return !result.incomplete;
}

function validateRouteTraversal(route) {
  var blocked = [];
  if (!Array.isArray(route) || route.length < 3) return blocked;

  for (var i = 1; i < route.length - 1; i++) {
    if (!checkRoomTraversal(route[i], route[i - 1], route[i + 1])) {
      blocked.push(route[i]);
    }
  }

  return blocked;
}

// --- ROOM COORDINATE HELPERS ---

// Parse a room name into SIGNED grid coordinates so distance math is correct
// across the W/E and N/S hemisphere seams. (W and E both start at 0, so the
// raw numbers alone would make e.g. W1 <-> E1 look like distance 0.)
function parseRoomXY(roomName) {
  var m = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!m) return null;
  var x = parseInt(m[2], 10);
  var y = parseInt(m[4], 10);
  if (m[1] === 'W') x = -x - 1;
  if (m[3] === 'S') y = -y - 1;
  return { x: x, y: y };
}

// Manhattan distance in room-grid units. Rooms only connect via the four cardinal
// exits, so true travel distance is |dx| + |dy| — a diagonal costs 2, not 1.
function roomManhattanDistance(a, b) {
  var pa = parseRoomXY(a);
  var pb = parseRoomXY(b);
  if (!pa || !pb) return Infinity;
  return Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
}

// --- HIGHWAY ADJACENCY CHECK ---
// Returns true if the room is one step away from a highway (coordinate mod 10 === 1 or 9).
function isRoomAdjacentToHighway(roomName) {
  var parsed = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!parsed) return false;
  var x = parseInt(parsed[1], 10) % 10;
  var y = parseInt(parsed[2], 10) % 10;
  return (x === 1 || x === 9 || y === 1 || y === 9);
}

// Returns true if the room is a highway (either coordinate divisible by 10).
function isHighwayRoom(roomName) {
  var parsed = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!parsed) return false;
  return (parseInt(parsed[1], 10) % 10 === 0) || (parseInt(parsed[2], 10) % 10 === 0);
}

// Score a route from fromRoom to toRoom that prefers highway rooms.
// Uses Game.map.findRoute with a routeCallback weighting highways low and interior
// rooms higher (but NOT banning interior — we still need a few interior hops at each
// end to get on/off the highway). BANNED_ROOMS are excluded entirely.
// Returns the summed weighted cost, or Infinity if no route exists.
function highwayRouteCost(fromRoom, toRoom) {
  if (fromRoom === toRoom) return 0;

  var route = Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: function (roomName) {
      if (BANNED_ROOMS.indexOf(roomName) !== -1) return Infinity;
      return isHighwayRoom(roomName) ? HIGHWAY_COST : INTERIOR_COST;
    }
  });

  if (!Array.isArray(route) || route.length === 0) return Infinity;

  var total = 0;
  for (var i = 0; i < route.length; i++) {
    total += isHighwayRoom(route[i].room) ? HIGHWAY_COST : INTERIOR_COST;
  }
  return total;
}

// --- UNREACHABLE ROOM HELPERS ---

// Returns true if this room is currently cached as having no observer in range.
function isRoomUnreachableByObserver(roomName) {
  var entry = Memory.depositObserver.unreachableRooms[roomName];
  if (!entry) return false;
  if (Game.time > entry.until) {
    delete Memory.depositObserver.unreachableRooms[roomName];
    return false;
  }
  return true;
}

// Record that no observer can currently reach this room.
function markRoomUnreachable(roomName) {
  Memory.depositObserver.unreachableRooms[roomName] = { until: Game.time + UNREACHABLE_CACHE_TICKS };
}

// --- CORE OBSERVER LOGIC ---

function harvestResources(targetRoomName) {
  initMemory();
  if (!scanner.observe.inRange(targetRoomName)) return ERR_NOT_FOUND;

  if (!Memory.depositObserver.rooms[targetRoomName]) {
    Memory.depositObserver.rooms[targetRoomName] = { nextScanTick: Game.time, lastObserved: 0 };
    console.log('[DepositObserver] Watching ' + targetRoomName);
  }
  return OK;
}

function stopObservation(targetRoomName) {
  if (Memory.depositObserver && Memory.depositObserver.rooms && Memory.depositObserver.rooms[targetRoomName]) {
    delete Memory.depositObserver.rooms[targetRoomName];
    console.log('[DepositObserver] Stopped watching ' + targetRoomName);
    return OK;
  }
  return ERR_NOT_FOUND;
}

function cancelJobsInRoom(targetRoomName) {
  var jobs = Memory.depositObserver.jobs;
  var count = 0;
  for (var id in jobs) {
    if (jobs[id].roomName === targetRoomName) {
      delete jobs[id];
      count++;
    }
  }
  if (count > 0) {
    console.log('[DepositObserver] Cancelled ' + count + ' jobs in ' + targetRoomName);
    return OK;
  }
  console.log('[DepositObserver] No active jobs found in ' + targetRoomName);
  return ERR_NOT_FOUND;
}

// --- SAFETY & CONNECTIVITY CHECKS ---

function checkRoomPassability(roomName, fromRoomName, toRoomName) {
  var room = Game.rooms[roomName];
  if (!room) return true;

  var startPos = new RoomPosition(25, 25, roomName);
  if (fromRoomName) {
    var entryDir = Game.map.findExit(roomName, fromRoomName);
    if (entryDir !== ERR_NO_PATH && entryDir !== ERR_INVALID_ARGS) {
      var entryExits = room.find(entryDir);
      if (entryExits.length > 0) {
        startPos = entryExits[Math.floor(entryExits.length / 2)];
      }
    }
  }

  var goals = [];
  if (toRoomName) {
    var exitDir = Game.map.findExit(roomName, toRoomName);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      var exitExits = room.find(exitDir);
      goals = exitExits.map(function (p) { return { pos: p, range: 0 }; });
    }
  }

  if (goals.length === 0) return true;

  var ret = PathFinder.search(startPos, goals, {
    plainCost: 2, swampCost: 10,
    maxOps: 4000,
    maxRooms: 1,
    roomCallback: function (rName) {
      if (rName !== roomName) return false;
      return buildRoomCostMatrix(rName);
    }
  });

  return !ret.incomplete;
}

function buildRoomCostMatrix(roomName) {
  var room = Game.rooms[roomName];
  var matrix = new PathFinder.CostMatrix();
  if (!room) return matrix;

  var structures = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structures.length; i++) {
    var s = structures[i];
    if (s.structureType === STRUCTURE_WALL) {
      matrix.set(s.pos.x, s.pos.y, 0xff);
    } else if (s.structureType === STRUCTURE_RAMPART) {
      if (!s.my && !s.isPublic) matrix.set(s.pos.x, s.pos.y, 0xff);
    }
  }
  return matrix;
}

function isRoomSafeForTravel(roomName) {
  var room = Game.rooms[roomName];
  if (!room) return true;

  var controller = room.controller;
  if (!controller || controller.my) return true;

  var owner = controller.owner
    ? controller.owner.username
    : (controller.reservation ? controller.reservation.username : null);
  if (!owner) return true;

  if (iff.IFF_WHITELIST && iff.IFF_WHITELIST.indexOf(owner) !== -1) return true;

  return false;
}

// --- PLANNING & JOB MANAGEMENT ---

function planPathForJob(job) {
  if (job.pathPlanned) return;
  if (job.planningRetryTick && Game.time < job.planningRetryTick) return;
  if (!job.storagePos) return;

  var startPos  = new RoomPosition(job.storagePos.x, job.storagePos.y, job.storagePos.roomName);
  var targetPos = new RoomPosition(job.x, job.y, job.roomName);

  // NOTE: The random blockedEdges/roomStatus wipe has been removed.
  // It caused the system to repeatedly re-discover blocked edges (e.g. E8N56->E9N56)
  // and re-queue rooms for scanning on every wipe cycle.
  // Stale entries are now cleaned up only by cleanStaleMemory() on a fixed schedule.

  var route = findLinearRoute(startPos.roomName, targetPos.roomName);

  if (!route || route.length === 0) {
    console.log('[DepositObserverPlan] No route for job ' + job.id + '. Retrying in 50 ticks.');
    job.planningRetryTick = Game.time + 50;
    return;
  }

  // --- VISION QUEUE: queue rooms that need scanning, bail if any are unobservable ---
  var missingVision = false;
  for (var i = 0; i < route.length; i++) {
    var rName = route[i];
    var status = Memory.depositObserver.roomStatus[rName];
    var isFresh = status && (Game.time - status.lastScan < PASSABILITY_CACHE_TICKS);
    var roomObj = Game.rooms[rName];
    var isMine  = roomObj && roomObj.controller && roomObj.controller.my;

    if (!isMine && !isFresh) {
      // If we already know no observer can reach this room, fail fast.
      if (isRoomUnreachableByObserver(rName)) {
        console.log(
          '[DepositObserverPlan] Job ' + job.id + ' route passes through ' + rName +
          ' which has no observer coverage. Retrying in 100 ticks.'
        );
        job.planningRetryTick = Game.time + 100;
        return;
      }

      // Queue it for scanning if not already queued.
      if (Memory.depositObserver.scanQueue.indexOf(rName) === -1) {
        Memory.depositObserver.scanQueue.unshift(rName);
      }
      missingVision = true;
    }
  }

  if (missingVision) {
    if (Game.time % 20 === 0) {
      console.log('[DepositObserverPlan] Verifying route (' + route.length + ' rooms)...');
    }
    job.route = route;
    return;
  }

  // --- PATHFINDER ROUTE VALIDATION ---
  var traversalBlocked = validateRouteTraversal(route);
  var recomputeAttempts = 0;

  while (traversalBlocked.length > 0 && recomputeAttempts < 5) {
    recomputeAttempts++;
    for (var tb = 0; tb < traversalBlocked.length; tb++) {
      var blockedIdx = route.indexOf(traversalBlocked[tb]);
      if (blockedIdx > 0) {
        var edgeKey = route[blockedIdx - 1] + ':' + traversalBlocked[tb];
        Memory.depositObserver.blockedEdges[edgeKey] = true;
        console.log('[DepositObserverPlan] Blocked edge: ' + edgeKey);
      }
      if (blockedIdx >= 0 && blockedIdx < route.length - 1) {
        var edgeKey2 = traversalBlocked[tb] + ':' + route[blockedIdx + 1];
        Memory.depositObserver.blockedEdges[edgeKey2] = true;
        console.log('[DepositObserverPlan] Blocked edge: ' + edgeKey2);
      }
    }

    console.log(
      '[DepositObserverPlan] Route for job ' + job.id +
      ' has impassable rooms: ' + traversalBlocked.join(', ') +
      '. Recomputing (attempt ' + recomputeAttempts + ')…'
    );

    route = findLinearRoute(startPos.roomName, targetPos.roomName);
    if (!route || route.length === 0) {
      console.log('[DepositObserverPlan] No alternative route for job ' + job.id + ' after blocking impassable rooms.');
      job.planningRetryTick = Game.time + 50;
      return;
    }

    // New route may include unscanned rooms — bail and let vision catch up.
    var newMissing = false;
    for (var nm = 0; nm < route.length; nm++) {
      var nmRoom   = route[nm];
      var nmStatus = Memory.depositObserver.roomStatus[nmRoom];
      var nmFresh  = nmStatus && (Game.time - nmStatus.lastScan < PASSABILITY_CACHE_TICKS);
      var nmObj    = Game.rooms[nmRoom];
      var nmMine   = nmObj && nmObj.controller && nmObj.controller.my;

      if (!nmMine && !nmFresh) {
        if (isRoomUnreachableByObserver(nmRoom)) {
          console.log(
            '[DepositObserverPlan] Recomputed route for job ' + job.id +
            ' still passes through unobservable room ' + nmRoom + '. Giving up for now.'
          );
          job.planningRetryTick = Game.time + 100;
          return;
        }
        if (Memory.depositObserver.scanQueue.indexOf(nmRoom) === -1) {
          Memory.depositObserver.scanQueue.unshift(nmRoom);
        }
        newMissing = true;
      }
    }
    if (newMissing) {
      console.log('[DepositObserverPlan] New route has unscanned rooms. Queuing scans…');
      job.route = route;
      return;
    }

    traversalBlocked = validateRouteTraversal(route);
  }

  if (traversalBlocked.length > 0) {
    console.log(
      '[DepositObserverPlan] Exhausted recompute attempts for job ' + job.id +
      '. Still blocked: ' + traversalBlocked.join(', ')
    );
    job.planningRetryTick = Game.time + 100;
    return;
  }
  // --- END PATHFINDER ROUTE VALIDATION ---

  var exitDirections     = {};
  var exitDirectionsBack = {};
  for (var i = 0; i < route.length - 1; i++) {
    var dir = Game.map.findExit(route[i], route[i + 1]);
    if (dir > 0) {
      exitDirections[route[i]]         = dir;
      exitDirectionsBack[route[i + 1]] = (dir + 2) % 8 || 8;
    }
  }

  job.route              = route;
  job.routeBack          = route.slice().reverse();
  job.exitDirections     = exitDirections;
  job.exitDirectionsBack = exitDirectionsBack;
  job.pathRooms          = route.slice();

  job.pathPlanned = true;
  delete job.planningRetryTick;
  console.log('[DepositObserverPlan] ✓ Job ' + job.id + ' route confirmed: ' + route.join(' '));

  var result = PathFinder.search(
    startPos, { pos: targetPos, range: 1 },
    {
      plainCost: 2, swampCost: 10, maxRooms: 64, maxOps: 40000,
      roomCallback: function (roomName) {
        if (Memory.depositObserver.roomStatus[roomName] && Memory.depositObserver.roomStatus[roomName].blocked) return false;
        return buildRoomCostMatrix(roomName);
      }
    }
  );

  if (!result.incomplete) {
    job.path     = result.path.map(function (p) { return { x: p.x, y: p.y, roomName: p.roomName }; });
    job.pathBack = job.path.slice().reverse();
  }
}

function runSafetyScanner() {
  var mem = Memory.depositObserver;

  // 1. PROCESS SCAN RESULT — the scheduler delivers visibility for the
  //    requested room; we read it whenever it shows up.
  if (mem.scanState.activeRoom) {
    var roomName = mem.scanState.activeRoom;
    var room = Game.rooms[roomName];

    if (room) {
      var safe = isRoomSafeForTravel(roomName);
      var connectivityBlocked = false;

      for (var id in mem.jobs) {
        var job = mem.jobs[id];
        if (!job.route) continue;

        var idx = job.route.indexOf(roomName);
        if (idx > -1 && idx < job.route.length - 1) {
          var nextRoom = job.route[idx + 1];
          var prevRoom = idx > 0 ? job.route[idx - 1] : null;

          if (!checkRoomPassability(roomName, prevRoom, nextRoom)) {
            connectivityBlocked = true;
            mem.blockedEdges[roomName + ':' + nextRoom] = true;
            console.log('[DepositObserver] Edge Blocked: ' + roomName + ' -> ' + nextRoom);
          }
        }
      }

      mem.roomStatus[roomName] = {
        lastScan: Game.time,
        blocked: !safe
      };

      if (connectivityBlocked || !safe) {
        for (var id in mem.jobs) {
          var job = mem.jobs[id];
          if (job.route && job.route.indexOf(roomName) > -1) {
            console.log('[DepositObserver] Re-routing job ' + id);
            job.pathPlanned = false;
            job.route       = null;
            job.path        = null;
          }
        }
      }

      mem.scanState.activeRoom = null;
      if (mem.scanQueue.length > 0 && mem.scanQueue[0] === roomName) {
        mem.scanQueue.shift();
      }

    } else if (Game.time - (mem.scanState.requestedTick || 0) > SCAN_REQUEST_TIMEOUT) {
      // The scheduler hasn't delivered visibility — observers are saturated
      // or the request expired. Clear and re-request next tick.
      mem.scanState.activeRoom = null;
    }
    // else: still waiting on the scheduler — do nothing this tick.
  }

  // 2. PICK NEXT SCAN — submit to the scanner's observer scheduler.
  if (mem.scanQueue.length > 0 && !mem.scanState.activeRoom) {
    var nextRoom = mem.scanQueue[0];

    if (scanner.observe.request(nextRoom, 'deposit', PRI_ROUTE_SCAN)) {
      mem.scanState.activeRoom = nextRoom;
      mem.scanState.requestedTick = Game.time;
    } else {
      // No observer can reach this room. Cache the fact so planPathForJob stops re-queuing it.
      console.log('[DepositObserver] Skipping unreachable room ' + nextRoom);
      markRoomUnreachable(nextRoom);
      mem.scanQueue.shift();
    }
  }
}

function ensureJobForDeposit(deposit) {
  if ((deposit.lastCooldown || 0) >= MAX_COOLDOWN) {
    return false;
  }

  var jobs = Memory.depositObserver.jobs;
  if (jobs[deposit.id]) return false;

  var homeRoom = findNearestRcl7Home(deposit.room.name);
  if (!homeRoom) return false;

  var terrain   = deposit.room.getTerrain();
  var freeSpots = 0;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (terrain.get(deposit.pos.x + dx, deposit.pos.y + dy) !== TERRAIN_MASK_WALL) {
        freeSpots++;
      }
    }
  }

  var jobMaxHarvesters = Math.min(freeSpots, MAX_HARVESTERS);
  if (jobMaxHarvesters < 1) jobMaxHarvesters = 1;

  var storagePos = { x: homeRoom.storage.pos.x, y: homeRoom.storage.pos.y, roomName: homeRoom.name };

  jobs[deposit.id] = {
    id:             deposit.id,
    roomName:       deposit.room.name,
    x:              deposit.pos.x,
    y:              deposit.pos.y,
    type:           deposit.depositType,
    homeRoom:       homeRoom.name,
    storagePos:     storagePos,
    creeps:         [],
    maxHarvesters:  jobMaxHarvesters,
    completed:      false,
    pathPlanned:    false
  };

  console.log('[DepositObserver] Found new deposit ' + deposit.id + '. Spots: ' + freeSpots + '. Limit set to: ' + jobMaxHarvesters);
  return true;
}

function maintainJobs() {
  var statusReport = [];
  var idsToDelete  = [];

  for (var id in Memory.depositObserver.jobs) {
    var job = Memory.depositObserver.jobs[id];

    // --- MIGRATION: Convert old single-creep jobs to array format ---
    if (job.creepName) {
      if (!job.creeps) job.creeps = [];
      job.creeps.push(job.creepName);
      delete job.creepName;
    }
    if (!job.creeps) job.creeps = [];

    // Prune dead creeps
    var liveCreeps = [];
    for (var i = 0; i < job.creeps.length; i++) {
      var cName = job.creeps[i];
      if (Game.creeps[cName] || isCreepSpawning(cName)) {
        liveCreeps.push(cName);
      }
    }
    job.creeps = liveCreeps;

    if (job.completed) {
      idsToDelete.push(id);
      continue;
    }

    var status          = 'Unknown';
    var currentJobLimit = job.maxHarvesters || MAX_HARVESTERS;

    if (!job.pathPlanned) {
      if (job.planningRetryTick && Game.time < job.planningRetryTick) {
        status = '❄️ Retry in ' + (job.planningRetryTick - Game.time);
      } else {
        planPathForJob(job);
        if (job.pathPlanned)         status = '✅ Planned';
        else if (job.planningRetryTick) status = '❌ Failed';
        else                         status = '⏳ Scanning';
      }
    } else if (job.creeps.length < currentJobLimit && DEPOSIT_HARVESTING_ENABLED) {
      var spawnResult = spawnHarvesterForJob(job);
      if (spawnResult === OK)        status = '🚀 Spawning (' + job.creeps.length + '/' + currentJobLimit + ')';
      else if (spawnResult === ERR_BUSY) status = '💤 Busy (' + job.creeps.length + '/' + currentJobLimit + ')';
      else                           status = '❌ Err ' + spawnResult;
    } else {
      if (job.creeps.length > 0) {
        var firstCreep = Game.creeps[job.creeps[0]];
        var ttl        = firstCreep ? firstCreep.ticksToLive : 'Spawning';
        status = 'Working [' + job.creeps.length + '/' + currentJobLimit + '] (TTL: ' + ttl + ')';
      } else {
        status = 'Idle (Waiting)';
      }
    }

    statusReport.push({ room: job.roomName, status: status });
  }

  for (var i = 0; i < idsToDelete.length; i++) {
    delete Memory.depositObserver.jobs[idsToDelete[i]];
  }

  if (Game.time % 100 === 0 || Memory.depositObserver.printStatus) {
    console.log('--- DEPOSIT STATUS ---');
    statusReport.forEach(function (s) { console.log('[' + s.room + ']: ' + s.status); });
    Memory.depositObserver.printStatus = false;
  }
}

// Two-stage home selection.
//   STAGE 1: gather all eligible homes (RCL7+, has storage + spawn, highway-adjacent)
//            and prune to the MAX_HOME_CANDIDATES nearest by Manhattan distance
//            (orthogonal-only travel => diagonal counts as 2).
//   STAGE 2: among the shortlist, pick the one with the cheapest *highway* route
//            (Game.map.findRoute weighted to prefer highway rooms over interior).
//   FALLBACKS: if no shortlisted room yields a highway route, widen to the rest of
//            the candidates; if still none, use the Manhattan-nearest home outright.
function findNearestRcl7Home(targetRoomName) {
  var candidates = [];
  for (var name in Game.rooms) {
    var r = Game.rooms[name];
    if (!r.controller || !r.controller.my) continue;
    if (r.controller.level < 7) continue;
    if (!r.storage || r.find(FIND_MY_SPAWNS).length === 0) continue;

    // Deposits live in highway rooms; only spawn from highway-adjacent rooms to
    // minimise travel time and avoid routing through deep interior rooms.
    if (!isRoomAdjacentToHighway(name)) continue;

    candidates.push({
      room:      r,
      name:      name,
      manhattan: roomManhattanDistance(name, targetRoomName)
    });
  }

  if (candidates.length === 0) return null;

  // STAGE 1 — prune to the nearest few by Manhattan distance.
  candidates.sort(function (a, b) { return a.manhattan - b.manhattan; });
  var shortlist = candidates.slice(0, MAX_HOME_CANDIDATES);

  // STAGE 2 — pick the shortlisted home with the cheapest highway route.
  var best     = null;
  var bestCost = Infinity;
  for (var i = 0; i < shortlist.length; i++) {
    var cost = highwayRouteCost(shortlist[i].name, targetRoomName);
    if (cost < bestCost) {
      bestCost = cost;
      best     = shortlist[i];
    }
  }

  // FALLBACK 1 — no shortlisted room could produce a highway route. Walk the rest
  // of the (Manhattan-sorted) candidates and take the first that routes.
  if (!best) {
    for (var j = MAX_HOME_CANDIDATES; j < candidates.length; j++) {
      var c = highwayRouteCost(candidates[j].name, targetRoomName);
      if (c < Infinity) { best = candidates[j]; bestCost = c; break; }
    }
  }

  // FALLBACK 2 — nothing routes at all. Use the Manhattan-nearest home.
  if (!best) {
    console.log('[DepositObserver] No highway route to ' + targetRoomName + '; using Manhattan-nearest home.');
    best     = candidates[0];
    bestCost = Infinity;
  }

  console.log(
    '[DepositObserver] Home for ' + targetRoomName + ': ' + best.name +
    ' (manhattan ' + best.manhattan + ', highwayCost ' +
    (bestCost === Infinity ? 'n/a' : bestCost.toFixed(1)) + ')'
  );

  return best.room;
}

function spawnHarvesterForJob(job) {
  var home = Game.rooms[job.homeRoom];
  if (!home) return ERR_NOT_FOUND;

  var spawn = home.find(FIND_MY_SPAWNS).find(function (s) { return !s.spawning; });
  if (!spawn) return ERR_BUSY;

  var setCost = 2 * BODYPART_COST[WORK] + 1 * BODYPART_COST[CARRY] + 3 * BODYPART_COST[MOVE];
  var parts   = Math.min(Math.floor(home.energyCapacityAvailable / setCost), 8);
  if (parts < 1) parts = 1;

  var body = [];
  for (var i = 0; i < parts; i++) body.push(WORK, WORK, CARRY, MOVE, MOVE, MOVE);

  var name = 'depositHarvester_' + job.roomName + '_' + job.id + '_' + Game.time + '_' + job.creeps.length;

  var mem = {
    role:             'depositHarvester',
    homeRoom:         job.homeRoom,
    targetRoom:       job.roomName,
    depositId:        job.id,
    depositRoute:     job.route,
    depositRouteBack: job.routeBack,
    depositX:         job.x,
    depositY:         job.y
  };

  var result = spawn.spawnCreep(body, name, { memory: mem });
  if (result === OK) {
    job.creeps.push(name);
    var currentLimit = job.maxHarvesters || MAX_HARVESTERS;
    console.log('[DepositObserver] Spawning ' + name + ' (' + job.creeps.length + '/' + currentLimit + ')');
  }
  return result;
}

function scanVisibleRoomsForDeposits() {
  var roomsMem    = Memory.depositObserver.rooms;
  var currentTime = Game.time;

  // Submit ONE due watch-room to the scheduler per tick (same pacing as before,
  // but the scheduler decides which observer fires and when).
  for (var roomName in roomsMem) {
    var data = roomsMem[roomName];
    if (currentTime >= data.nextScanTick && !Game.rooms[roomName]) {
      if (scanner.observe.request(roomName, 'deposit', PRI_DEPOSIT_WATCH)) {
        data.nextScanTick = currentTime + SCAN_INTERVAL;
        break;
      } else {
        // No coverage right now (lost an observer?) — back off a full interval.
        data.nextScanTick = currentTime + SCAN_INTERVAL;
      }
    }
  }

  for (var roomName in roomsMem) {
    var room = Game.rooms[roomName];
    if (!room) continue;

    roomsMem[roomName].lastObserved = currentTime;

    var currentDeposits = room.find(FIND_DEPOSITS);
    var foundDepositIds = [];
    for (var k = 0; k < currentDeposits.length; k++) {
      var d = currentDeposits[k];
      foundDepositIds.push(d.id);

      if ((d.lastCooldown || 0) >= MAX_COOLDOWN) {
        if (Memory.depositObserver.jobs[d.id]) {
          console.log('[DepositObserver] Deposit ' + d.id + ' cooldown too high (' + d.lastCooldown + '). Removing job.');
          delete Memory.depositObserver.jobs[d.id];
        }
      }
    }

    var jobsToCheck = Memory.depositObserver.jobs;
    for (var jobId in jobsToCheck) {
      if (jobsToCheck[jobId].roomName === roomName) {
        if (foundDepositIds.indexOf(jobId) === -1) {
          console.log('[DepositObserver] Deposit ' + jobId + ' in ' + roomName + ' decayed. Removing job.');
          delete Memory.depositObserver.jobs[jobId];
        }
      }
    }

    for (var i = 0; i < currentDeposits.length; i++) {
      if (DEPOSIT_TYPES.indexOf(currentDeposits[i].depositType) !== -1) {
        ensureJobForDeposit(currentDeposits[i]);
      }
    }
  }
}

function cleanStaleMemory() {
  if (Game.time % 1000 !== 0) return;

  var roomStatus = Memory.depositObserver.roomStatus;
  var now        = Game.time;
  var cleared    = 0;

  for (var rName in roomStatus) {
    if (now - roomStatus[rName].lastScan > (PASSABILITY_CACHE_TICKS + 500)) {
      delete roomStatus[rName];
      cleared++;
    }
  }

  // Also prune expired unreachableRooms entries.
  var unreachable    = Memory.depositObserver.unreachableRooms;
  var clearedUnreach = 0;
  for (var uName in unreachable) {
    if (now > unreachable[uName].until) {
      delete unreachable[uName];
      clearedUnreach++;
    }
  }

  if (cleared > 0) {
    console.log('[DepositObserver] Garbage collected ' + cleared + ' stale room records.');
  }
  if (clearedUnreach > 0) {
    console.log('[DepositObserver] Cleared ' + clearedUnreach + ' expired unreachable-room entries.');
  }
}

function isCreepSpawning(creepName) {
  for (var roomName in Game.rooms) {
    var room   = Game.rooms[roomName];
    var spawns = room.find(FIND_MY_SPAWNS);
    for (var i = 0; i < spawns.length; i++) {
      if (spawns[i].spawning && spawns[i].spawning.name === creepName) return true;
    }
  }
  return false;
}


function run() {
  initMemory();
  runSafetyScanner();
  scanVisibleRoomsForDeposits();
  maintainJobs();
  cleanStaleMemory();
}

module.exports = {
  run:               run,
  harvestResources:  harvestResources,
  stopObservation:   stopObservation,
  cancelJobsInRoom:  cancelJobsInRoom
};