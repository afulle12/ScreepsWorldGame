//roleDepositHarvester.js
// UPDATED: Added PathFinder-based route validation to detect rooms that are impassable between
// entry/exit edges (terrain walls or player-built walls). Uses same engine as creep movement.
// Routes are validated after loading/computing and recomputed (up to 5 attempts) avoiding blocked rooms.
// OPTIMIZED: CPU efficiency while traveling. Per-room navigation is now corridor-constrained:
// each hop targets a concrete exit tile toward the next route room with maxRooms:1, so the engine
// can never detour into an off-route room. reusePath raised to 20 for highway rooms.
// Skips redundant validation if observer already validated the job route (job.routeValidated).
//
// MOVEMENT FIXES (border-bounce hardening):
//   FIX 1: corridor-constrained movement (maxRooms:1 toward a concrete exit tile).
//   FIX 2: forward-biased off-route recovery (no backward snap on linear-distance ties).
//   FIX 4: peel off wrong-edge exit tiles before the engine's start-of-tick auto-transfer.
//
// Behavior:
//   Spawned for a single highway Deposit job.
//   Loop:
//     1) travelToDeposit  - follow an authoritative sequence of rooms from homeRoom to targetRoom
//     2) harvesting       - harvest until full or deposit gone/exhausted
//     3) returning        - follow the same room sequence in reverse back to homeRoom
//     4) delivering       - transfer resources to storage
//   After delivering, the creep suicides so a fresh creep can be spawned for the next trip.

function getJob(creep) {
  if (!creep.memory.depositId) return null;
  if (!Memory.depositObserver) return null;
  if (!Memory.depositObserver.jobs) return null;
  return Memory.depositObserver.jobs[creep.memory.depositId] || null;
}

function getHomeRoom(creep) {
  if (!creep.memory.homeRoom) return null;
  return Game.rooms[creep.memory.homeRoom] || null;
}

function getTargetPosition(creep) {
  if (!creep.memory.targetRoom) return null;
  if (typeof creep.memory.depositX !== 'number') return null;
  if (typeof creep.memory.depositY !== 'number') return null;
  return new RoomPosition(creep.memory.depositX, creep.memory.depositY, creep.memory.targetRoom);
}

function getDeposit(creep) {
  if (!creep.memory.depositId) return null;
  return Game.getObjectById(creep.memory.depositId);
}

function clearRouteData(creep) {
  delete creep.memory.depositRoute;
  delete creep.memory.depositRouteBack;
  delete creep.memory.depositRouteIndex;
  delete creep.memory.depositRouteBackIndex;
  delete creep.memory.depositRouteValidated;
  delete creep.memory._exitTarget;
  delete creep.memory._lastRoom;
}

function markJobCompleted(creep, keepRoute) {
  var job = getJob(creep);
  if (job && !job.completed) {
    job.completed = true;
    console.log('[DepositHarvester] Marking job ' + creep.memory.depositId + ' as completed.');
  }

  if (!keepRoute) {
    clearRouteData(creep);
  }
}

// ---------------------------------------------------------------------------
// ROUTE VALIDATION — PathFinder traversal check
// Uses the same pathfinding engine as creep movement to verify each intermediate
// room can be crossed from the entry edge to the exit edge. When the room is
// visible, player-built walls/ramparts are included via CostMatrix.
// ---------------------------------------------------------------------------

// Given an exit direction, return edge coordinate info for building RoomPositions.
function getEdgeCoords(exitDir) {
  switch (exitDir) {
    case FIND_EXIT_TOP:    return { axis: 'y', value: 0,  range: 'x' };
    case FIND_EXIT_BOTTOM: return { axis: 'y', value: 49, range: 'x' };
    case FIND_EXIT_LEFT:   return { axis: 'x', value: 0,  range: 'y' };
    case FIND_EXIT_RIGHT:  return { axis: 'x', value: 49, range: 'y' };
  }
  return null;
}

// Get the opposite exit direction (entry edge when arriving from prevRoom).
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

// Pick a random walkable tile on the given edge of a room using terrain data.
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

// Get all walkable tiles on the given edge as PathFinder goals.
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

// Build a CostMatrix including structures when the room is visible.
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

// Check if a creep entering roomName from prevRoom can reach the exit toward nextRoom.
// Uses PathFinder.search constrained to 1 room, with structure-aware CostMatrix when visible.
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
    swampCost: 2,
    maxOps: 4000,
    maxRooms: 1,
    roomCallback: function (rName) {
      if (rName !== roomName) return false;
      return buildRoomCostMatrix(rName);
    }
  });

  return !result.incomplete;
}

// Validate every intermediate room in the route. Returns an array of room names
// that fail the PathFinder traversal check (empty array === route is good).
function validateRoute(route) {
  var blocked = [];
  if (!Array.isArray(route) || route.length < 3) return blocked;

  for (var i = 1; i < route.length - 1; i++) {
    if (!checkRoomTraversal(route[i], route[i - 1], route[i + 1])) {
      blocked.push(route[i]);
    }
  }

  return blocked;
}

// Recompute a route that avoids the given set of blocked rooms.
function computeRouteAvoiding(fromRoom, toRoom, blockedRooms) {
  var blockedSet = {};
  for (var b = 0; b < blockedRooms.length; b++) {
    blockedSet[blockedRooms[b]] = true;
  }

  var routeResult = Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: function (roomName) {
      if (blockedSet[roomName]) return Infinity;
      return 1; // default cost
    }
  });

  return routeResult;
}

// ---------------------------------------------------------------------------

// Ensure the creep has depositRoute (home -> deposit) and depositRouteBack
// (deposit -> home) in its memory, loading from the job.route if available.
// If the observer already validated the route (job.routeValidated), trust it
// to avoid redundant PathFinder calls. Only validate locally-computed fallback routes.
function ensureRouteOnCreep(creep) {
  if (Array.isArray(creep.memory.depositRoute) &&
      creep.memory.depositRoute.length >= 2 &&
      Array.isArray(creep.memory.depositRouteBack) &&
      creep.memory.depositRouteBack.length >= 2 &&
      creep.memory.depositRouteValidated) {
    return;
  }

  var job = getJob(creep);
  var homeRoom = getHomeRoom(creep);
  var targetRoomName = creep.memory.targetRoom;

  if (!homeRoom || !targetRoomName) {
    console.log('[DepositHarvesterRoute] ' + creep.name + ' cannot ensure route - missing homeRoom or targetRoom.');
    return;
  }

  var route = null;
  var alreadyValidated = false;

  // 1) Preferred: load the authoritative route from the job.
  if (job && Array.isArray(job.route) && job.route.length >= 2) {
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' loading authoritative room route from job ' +
        job.id +
        ' (' +
        job.route.length +
        ' rooms).'
    );
    route = job.route;
    // If the observer already validated this route, skip redundant PathFinder checks.
    if (job.routeValidated) {
      alreadyValidated = true;
    }
  }

  // 2) Fallback: compute a room corridor locally using Game.map.findRoute.
  if (!route) {
    route = buildRouteFromFindRoute(homeRoom.name, targetRoomName);
    if (!route) {
      console.log(
        '[DepositHarvesterRoute] ' +
          creep.name +
          ' Game.map.findRoute could not find route from ' +
          homeRoom.name +
          ' to ' +
          targetRoomName +
          '.'
      );
      return;
    }
  }

  // 3) VALIDATE: PathFinder traversal check on every intermediate room.
  // Skip if the observer already validated this route to save CPU.
  if (!alreadyValidated) {
    var blocked = validateRoute(route);
    var recomputeAttempts = 0;
    var allBlocked = []; // accumulate blocked rooms across retries

    while (blocked.length > 0 && recomputeAttempts < 5) {
      recomputeAttempts++;
      for (var b = 0; b < blocked.length; b++) {
        if (allBlocked.indexOf(blocked[b]) === -1) {
          allBlocked.push(blocked[b]);
        }
      }
      console.log(
        '[DepositHarvesterRoute] ' +
          creep.name +
          ' route validation FAILED — impassable rooms: ' +
          blocked.join(', ') +
          '. Recomputing (attempt ' +
          recomputeAttempts +
          ')…'
      );

      var altResult = computeRouteAvoiding(homeRoom.name, targetRoomName, allBlocked);
      if (!altResult || altResult === ERR_NO_PATH || altResult.length === 0) {
        console.log(
          '[DepositHarvesterRoute] ' +
            creep.name +
            ' could not find alternative route avoiding ' +
            allBlocked.join(', ') +
            '. Giving up.'
        );
        return;
      }

      route = [homeRoom.name];
      for (var j = 0; j < altResult.length; j++) {
        if (altResult[j] && altResult[j].room) {
          route.push(altResult[j].room);
        }
      }

      blocked = validateRoute(route);
    }

    if (blocked.length > 0) {
      console.log(
        '[DepositHarvesterRoute] ' +
          creep.name +
          ' exhausted recompute attempts. Route still has blocked rooms: ' +
          blocked.join(', ')
      );
      return;
    }
  }

  // Route is valid — store it.
  creep.memory.depositRoute = route;
  creep.memory.depositRouteValidated = true;

  var backRoute = [];
  for (var k = route.length - 1; k >= 0; k--) {
    backRoute.push(route[k]);
  }
  creep.memory.depositRouteBack = backRoute;

  if (job) {
    job.route = route;
    job.routeBack = backRoute;
    job.routePlanned = true;
    job.routeValidated = true;
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' stored VALIDATED room route into job ' +
        job.id +
        ' (' +
        route.length +
        ' rooms): ' +
        route.join(' → ') +
        '.'
    );
  } else {
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' validated room route of ' +
        route.length +
        ' rooms: ' +
        route.join(' → ') +
        ' (no job to store it to).'
    );
  }
}

// Helper: build a route array from Game.map.findRoute result.
function buildRouteFromFindRoute(fromRoom, toRoom) {
  var routeResult = Game.map.findRoute(fromRoom, toRoom);
  if (!routeResult || routeResult === ERR_NO_PATH || routeResult.length === 0) {
    return null;
  }
  var route = [fromRoom];
  for (var j = 0; j < routeResult.length; j++) {
    if (routeResult[j] && routeResult[j].room) {
      route.push(routeResult[j].room);
    }
  }
  return route;
}

// ---------------------------------------------------------------------------
// MOVEMENT HELPERS (route-following)
// ---------------------------------------------------------------------------

// Parse a room name into signed grid coordinates so we can test true
// orthogonal (edge-sharing) adjacency rather than Chebyshev distance.
function parseRoomXY(roomName) {
  var m = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!m) return null;
  var x = parseInt(m[2], 10);
  var y = parseInt(m[4], 10);
  if (m[1] === 'W') x = -x - 1;
  if (m[3] === 'S') y = -y - 1;
  return { x: x, y: y };
}

// True only when the two rooms share an edge (i.e. can be crossed directly).
function roomsOrthogonallyAdjacent(a, b) {
  var pa = parseRoomXY(a);
  var pb = parseRoomXY(b);
  if (!pa || !pb) return false;
  return (Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y)) === 1;
}

// FIX 2: forward-biased off-route recovery. Among route rooms that share an
// edge with the (off-route) current room, return the one furthest along the
// route (highest index). This pulls the creep back onto the corridor heading
// forward instead of snapping it backward on a linear-distance tie.
function pickRecoveryRoom(currentRoomName, route) {
  var best = null;
  var bestIdx = -1;
  for (var i = 0; i < route.length; i++) {
    if (roomsOrthogonallyAdjacent(currentRoomName, route[i]) && i > bestIdx) {
      bestIdx = i;
      best = route[i];
    }
  }
  return best;
}

// Deep off-route fallback: nearest route room by linear distance, ties broken
// toward the higher index (forward bias).
function pickNearestRouteRoom(currentRoomName, route) {
  var best = null;
  var bestDist = Infinity;
  var bestIdx = -1;
  for (var i = 0; i < route.length; i++) {
    var d = Game.map.getRoomLinearDistance(currentRoomName, route[i]);
    if (typeof d !== 'number') continue;
    if (d < bestDist || (d === bestDist && i > bestIdx)) {
      bestDist = d;
      bestIdx = i;
      best = route[i];
    }
  }
  return best;
}

// FIX 4 helpers: detect exit tiles and whether the creep sits on the edge that
// actually leads toward its intended next room.
function isOnExitTile(pos) {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

function isOnIntendedExitEdge(pos, exitDir) {
  switch (exitDir) {
    case FIND_EXIT_TOP:    return pos.y === 0;
    case FIND_EXIT_BOTTOM: return pos.y === 49;
    case FIND_EXIT_LEFT:   return pos.x === 0;
    case FIND_EXIT_RIGHT:  return pos.x === 49;
  }
  return false;
}

// FIX 1: find (and cache) a concrete exit tile on the edge toward nextRoom so
// movement can be constrained to the current room (maxRooms: 1). Returns null
// if no walkable exit on that edge is reachable from the creep's position.
function getCachedExitTarget(creep, exitDir) {
  var cached = creep.memory._exitTarget;
  if (cached && typeof cached.x === 'number' && typeof cached.y === 'number') {
    return new RoomPosition(cached.x, cached.y, creep.room.name);
  }
  var exitPos = creep.pos.findClosestByPath(exitDir, { ignoreCreeps: true });
  if (!exitPos) return null;
  creep.memory._exitTarget = { x: exitPos.x, y: exitPos.y };
  return exitPos;
}

// Follow the room route one room at a time, constrained to the validated
// corridor. Replaces the old moveTo(25,25,nextRoom) approach, which ran its own
// multi-room planner and could detour through off-route rooms — producing the
// two-room border-bounce.
//
// - forward === true:  storage/home -> deposit  (depositRoute, depositRouteIndex)
// - forward === false: deposit -> storage/home  (depositRouteBack, depositRouteBackIndex)
//
// FIX 1: each hop targets a concrete exit tile toward the next route room with
//        maxRooms:1, so the engine can never wander into an off-route room.
// FIX 2: when off-route, recover toward the furthest-forward edge-adjacent route
//        room instead of snapping backward on a linear-distance tie.
// FIX 4: if parked on an exit tile that is NOT the intended exit edge, peel
//        inward first so the engine's start-of-tick exit-tile auto-transfer
//        cannot ping-pong the creep back across the border.
//
// CPU notes:
//   - reusePath: 20 for highway rooms (no dynamic obstacles).
//   - maxOps: 2000 (allow pathing across the current room to the far exit).
//   - The chosen exit tile is cached in memory._exitTarget and invalidated on
//     room change, so findClosestByPath runs at most once per room.
function followRoomRoute(creep, forward) {
  var currentRoomName = creep.room.name;
  var route = forward ? creep.memory.depositRoute : creep.memory.depositRouteBack;
  if (!Array.isArray(route) || route.length === 0) {
    return ERR_NOT_FOUND;
  }

  var indexKey = forward ? 'depositRouteIndex' : 'depositRouteBackIndex';
  var goalRoomName = forward ? creep.memory.targetRoom : creep.memory.homeRoom;

  // Invalidate the cached exit tile whenever the room changes.
  if (creep.memory._lastRoom !== currentRoomName) {
    creep.memory._lastRoom = currentRoomName;
    delete creep.memory._exitTarget;
  }

  // Arrived at the goal room.
  if (goalRoomName && currentRoomName === goalRoomName) {
    var goalIdx = route.indexOf(currentRoomName);
    if (goalIdx !== -1) creep.memory[indexKey] = goalIdx;
    return OK;
  }

  // Decide which room to head toward next.
  var currentIdx = route.indexOf(currentRoomName);
  var nextRoomName;

  if (currentIdx !== -1) {
    // On route: aim at the next room in sequence.
    creep.memory[indexKey] = currentIdx;
    var nextIdx = currentIdx + 1;
    if (nextIdx >= route.length) {
      return ERR_NOT_FOUND;
    }
    nextRoomName = route[nextIdx];
  } else {
    // FIX 2: off route — recover forward toward an edge-adjacent route room.
    nextRoomName = pickRecoveryRoom(currentRoomName, route);
    if (!nextRoomName) {
      // Drifted 2+ rooms off the corridor: fall back to a normal multi-room
      // move toward the nearest route room (forward-biased on ties).
      var fallbackRoom = pickNearestRouteRoom(currentRoomName, route);
      if (!fallbackRoom) return ERR_NOT_FOUND;
      console.log(
        '[DepositHarvesterRoute] ' +
          creep.name +
          ' deep off-route in ' +
          currentRoomName +
          '; recovering toward ' +
          fallbackRoom +
          '.'
      );
      creep.moveTo(new RoomPosition(25, 25, fallbackRoom), { reusePath: 20 });
      return OK;
    }
  }

  // Direction of the shared edge toward nextRoom (within the current room).
  var exitDir = creep.room.findExitTo(nextRoomName);
  if (exitDir < 0) {
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' findExitTo from ' +
        currentRoomName +
        ' to ' +
        nextRoomName +
        ' returned ' +
        exitDir +
        '.'
    );
    return ERR_NO_PATH;
  }

  // FIX 4: parked on the wrong exit edge — pull inward before the engine yanks
  // the creep back across the border at the start of next tick.
  if (isOnExitTile(creep.pos) && !isOnIntendedExitEdge(creep.pos, exitDir)) {
    creep.moveTo(new RoomPosition(25, 25, currentRoomName), { maxRooms: 1, reusePath: 0 });
    return OK;
  }

  // FIX 1: move toward a concrete exit tile, constrained to this room only.
  var exitTarget = getCachedExitTarget(creep, exitDir);
  if (!exitTarget) {
    // No reachable exit tile (rare: disconnected pocket). Let the engine plan
    // multi-room toward the next room center as a last resort.
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' no reachable exit tile toward ' +
        nextRoomName +
        ' from ' +
        currentRoomName +
        '; falling back to multi-room moveTo.'
    );
    creep.moveTo(new RoomPosition(25, 25, nextRoomName), { reusePath: 20, maxOps: 2000 });
    return OK;
  }

  creep.moveTo(exitTarget, { reusePath: 20, maxOps: 2000, maxRooms: 1 });
  return OK;
}

function run(creep) {
  if (!creep.memory.state) {
    creep.memory.state = 'travelToDeposit';
  }

  if (!creep.memory.homeRoom || !creep.memory.targetRoom) {
    console.log('[DepositHarvester] ' + creep.name + ' missing homeRoom/targetRoom. Suicide.');
    markJobCompleted(creep);
    creep.suicide();
    return;
  }

  // If life is low, head home regardless of cargo, unless already going home.
  if (typeof creep.ticksToLive === 'number' && creep.ticksToLive <= 500) {
    if (creep.memory.state !== 'returning' &&
        creep.memory.state !== 'delivering') {
      creep.memory.state = 'returning';
      creep.memory.depositRouteBackIndex = 0;
    }
  }

  switch (creep.memory.state) {
    case 'travelToDeposit':
      stateTravelToDeposit(creep);
      break;
    case 'harvesting':
      stateHarvesting(creep);
      break;
    case 'returning':
      stateReturning(creep);
      break;
    case 'delivering':
      stateDelivering(creep);
      break;
    default:
      creep.memory.state = 'travelToDeposit';
      break;
  }
}

function stateTravelToDeposit(creep) {
  var targetPos = getTargetPosition(creep);
  if (!targetPos) {
    console.log('[DepositHarvester] ' + creep.name + ' has no valid target position. Suicide.');
    markJobCompleted(creep);
    creep.suicide();
    return;
  }

  // Ensure we have the room route cached.
  ensureRouteOnCreep(creep);

  // While not in target room, follow the room route.
  if (creep.room.name !== creep.memory.targetRoom) {
    var result = followRoomRoute(creep, true);
    if (result !== OK && result !== ERR_TIRED) {
      // As a last resort, try a direct multiroom moveTo to the target room center.
      console.log(
        '[DepositHarvester] ' +
          creep.name +
          ' followRoomRoute forward returned ' +
          result +
          ', falling back to direct moveTo.'
      );
      creep.moveTo(new RoomPosition(25, 25, creep.memory.targetRoom), { reusePath: 20 });
    }
    return;
  }

  // We are in the target room: approach the deposit locally.
  var deposit = getDeposit(creep);
  if (!deposit) {
    console.log('[DepositHarvester] ' + creep.name + ' reached target room but deposit not found. Completing job.');
    markJobCompleted(creep);
    creep.suicide();
    return;
  }

  if (!creep.pos.isNearTo(deposit.pos)) {
    creep.moveTo(deposit, { reusePath: 5 });
    return;
  }

  creep.memory.state = 'harvesting';
}

function stateHarvesting(creep) {
  if (creep.store.getFreeCapacity() === 0) {
    // Start return leg; routeBack will be used.
    creep.memory.depositRouteBackIndex = 0;
    creep.memory.state = 'returning';
    return;
  }

  var deposit = getDeposit(creep);
  if (!deposit) {
    console.log('[DepositHarvester] ' + creep.name + ' deposit gone while harvesting. Returning with cargo.');
    // Job done, but keep route for final trip home.
    markJobCompleted(creep, true);
    creep.memory.depositRouteBackIndex = 0;
    creep.memory.state = 'returning';
    return;
  }

  if (typeof deposit.cooldown === 'number' && deposit.cooldown >= 100) {
    console.log('[DepositHarvester] ' + creep.name + ' deposit cooldown >= 100; treating as exhausted and completing job.');
    // Job done, but keep route for final trip home.
    markJobCompleted(creep, true);
    creep.memory.depositRouteBackIndex = 0;
    creep.memory.state = 'returning';
    return;
  }

  if (typeof deposit.cooldown === 'number' && deposit.cooldown > 0) {
    if (!creep.pos.isNearTo(deposit.pos)) {
      creep.moveTo(deposit, { reusePath: 5 });
    }
    return;
  }

  var result = creep.harvest(deposit);

  if (result === OK) {
    return;
  }

  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(deposit, { reusePath: 5 });
    return;
  }

  if (result === ERR_TIRED) {
    if (!creep.pos.isNearTo(deposit.pos)) {
      creep.moveTo(deposit, { reusePath: 5 });
    }
    return;
  }

  console.log('[DepositHarvester] ' + creep.name + ' harvest error ' + result + '. Completing job.');
  // Treat as job done; keep route for final trip home.
  markJobCompleted(creep, true);
  creep.memory.depositRouteBackIndex = 0;
  creep.memory.state = 'returning';
}

function stateReturning(creep) {
  var homeRoom = getHomeRoom(creep);
  if (!homeRoom) {
    console.log('[DepositHarvester] ' + creep.name + ' cannot see home room ' + creep.memory.homeRoom + '. Suicide.');
    markJobCompleted(creep);
    creep.suicide();
    return;
  }

  if (creep.store.getUsedCapacity() === 0) {
    // Nothing to deliver — suicide immediately rather than wasting TTL on another trip.
    creep.suicide();
    return;
  }

  var storage = homeRoom.storage;
  if (!storage) {
    console.log('[DepositHarvester] ' + creep.name + ' home room has no storage. Suicide.');
    markJobCompleted(creep);
    creep.suicide();
    return;
  }

  // While not in home room, follow the reverse room route.
  if (creep.room.name !== homeRoom.name) {
    var result = followRoomRoute(creep, false);
    if (result !== OK && result !== ERR_TIRED) {
      console.log(
        '[DepositHarvester] ' +
          creep.name +
          ' followRoomRoute back returned ' +
          result +
          ', falling back to moveTo home room center.'
      );
      creep.moveTo(new RoomPosition(25, 25, homeRoom.name), { reusePath: 20 });
    }
    return;
  }

  // We are in the home room: approach storage locally.
  if (!creep.pos.isNearTo(storage.pos)) {
    creep.moveTo(storage, { reusePath: 5 });
    return;
  }

  creep.memory.state = 'delivering';
}

function stateDelivering(creep) {
  var homeRoom = getHomeRoom(creep);
  if (!homeRoom || !homeRoom.storage) {
    console.log('[DepositHarvester] ' + creep.name + ' cannot deliver: no home storage. Suicide.');
    markJobCompleted(creep);
    creep.suicide();
    return;
  }

  var storage = homeRoom.storage;

  var transferredSomething = false;
  for (var resourceType in creep.store) {
    if (creep.store[resourceType] > 0) {
      var result = creep.transfer(storage, resourceType);
      if (result === OK || result === ERR_NOT_IN_RANGE) {
        transferredSomething = true;
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(storage, { reusePath: 5 });
        }
        break;
      }
    }
  }

  // Once done delivering (or nothing left to transfer), always suicide.
  // A fresh creep will be spawned for the next trip rather than risking
  // this one dying en route with a full cargo.
  if (!transferredSomething || creep.store.getUsedCapacity() === 0) {
    creep.suicide();
  }
}

module.exports = {
  run: run
};