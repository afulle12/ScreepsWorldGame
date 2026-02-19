//roleDepositHarvester.js
// Behavior:
//   Spawned for a single highway Deposit job.
//   Loop:
//     1) travelToDeposit  - follow an authoritative sequence of rooms from homeRoom to targetRoom
//     2) harvesting       - harvest until full or deposit gone/exhausted
//     3) returning        - follow the same room sequence in reverse back to homeRoom
//     4) delivering       - transfer resources to storage
//   Repeat until the Deposit object disappears or is considered exhausted,
//   then mark job completed and let the creep finish its last trip home.

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

// Ensure the creep has depositRoute (home -> deposit) and depositRouteBack (deposit -> home)
// in its memory, loading from the job.route if available. If the job has no route yet,
// we fall back to Game.map.findRoute to build one, then store it back into the job.
// The observer’s route is authoritative; the local fallback is a safety net only.
function ensureRouteOnCreep(creep) {
  if (Array.isArray(creep.memory.depositRoute) &&
      creep.memory.depositRoute.length >= 2 &&
      Array.isArray(creep.memory.depositRouteBack) &&
      creep.memory.depositRouteBack.length >= 2) {
    return;
  }

  var job = getJob(creep);
  var homeRoom = getHomeRoom(creep);
  var targetRoomName = creep.memory.targetRoom;

  if (!homeRoom || !targetRoomName) {
    console.log('[DepositHarvesterRoute] ' + creep.name + ' cannot ensure route - missing homeRoom or targetRoom.');
    return;
  }

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

    creep.memory.depositRoute = job.route;

    if (Array.isArray(job.routeBack) && job.routeBack.length === job.route.length) {
      creep.memory.depositRouteBack = job.routeBack;
    } else {
      var back = [];
      for (var i = job.route.length - 1; i >= 0; i--) {
        back.push(job.route[i]);
      }
      creep.memory.depositRouteBack = back;
    }
    return;
  }

  // 2) Fallback: compute a room corridor locally using Game.map.findRoute, then store it.
  var routeResult = Game.map.findRoute(homeRoom.name, targetRoomName);
  if (!routeResult || routeResult === ERR_NO_PATH || routeResult.length === 0) {
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

  var route = [homeRoom.name];
  for (var j = 0; j < routeResult.length; j++) {
    var step = routeResult[j];
    if (step && step.room) {
      route.push(step.room);
    }
  }

  creep.memory.depositRoute = route;

  var backRoute = [];
  for (var k = route.length - 1; k >= 0; k--) {
    backRoute.push(route[k]);
  }
  creep.memory.depositRouteBack = backRoute;

  if (job) {
    job.route = route;
    job.routeBack = backRoute;
    job.routePlanned = true;
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' stored locally computed room route into job ' +
        job.id +
        ' (' +
        route.length +
        ' rooms).'
    );
  } else {
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' computed room route of ' +
        route.length +
        ' rooms (no job to store it to).'
    );
  }
}

// Follow the room route one room at a time using local moveTo to the correct exit.
// - forward === true:  storage/home -> deposit  (depositRoute, depositRouteIndex)
// - forward === false: deposit -> storage/home (depositRouteBack, depositRouteBackIndex)
//
// This function only cares about **which room** we are in; within the room it uses
// standard pathfinding to the proper exit tile.
function followRoomRoute(creep, forward) {
  var homeRoom = getHomeRoom(creep);
  var targetRoomName = creep.memory.targetRoom;

  // --- FIX: EXIT BOUNCE PREVENTION ---
  // If we are on an exit tile (x=0, x=49, y=0, y=49), we MUST move into the room immediately.
  // This overrides route logic to prevent being bounced back to the previous room by the engine.
  if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
    creep.moveTo(new RoomPosition(25, 25, creep.room.name), { reusePath: 0, maxOps: 500 });
    return OK;
  }
  // -----------------------------------

  var route = forward ? creep.memory.depositRoute : creep.memory.depositRouteBack;
  if (!Array.isArray(route) || route.length === 0) {
    return ERR_NOT_FOUND;
  }

  var indexKey = forward ? 'depositRouteIndex' : 'depositRouteBackIndex';
  var currentRoomName = creep.room.name;
  var goalRoomName = forward
    ? targetRoomName
    : (homeRoom ? homeRoom.name : null);

  // If we are already in the goal room for this leg, let the caller handle local movement.
  if (goalRoomName && currentRoomName === goalRoomName) {
    return OK;
  }

  var idx = creep.memory[indexKey];

  // Sync index with current room if needed.
  if (typeof idx !== 'number' ||
      idx < 0 ||
      idx >= route.length ||
      route[idx] !== currentRoomName) {

    var foundIdx = -1;
    for (var i = 0; i < route.length; i++) {
      if (route[i] === currentRoomName) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx !== -1) {
      idx = foundIdx;
    } else {
      // If we somehow appear off-route, snap to the nearest route room by linear distance.
      var nearestIdx = 0;
      var nearestDist = Infinity;
      for (var j = 0; j < route.length; j++) {
        var dist = Game.map.getRoomLinearDistance(currentRoomName, route[j]);
        if (typeof dist === 'number' && dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = j;
        }
      }
      idx = nearestIdx;
    }

    creep.memory[indexKey] = idx;
  }

  // Determine the next room along this route.
  var nextIdx = idx + 1;
  if (nextIdx >= route.length) {
    // No further rooms in this direction. If we are not in the goal, signal failure.
    if (!goalRoomName || currentRoomName === goalRoomName) {
      return OK;
    }
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' has no further rooms in route (forward=' +
        forward +
        ') but is still not in goal room (current=' +
        currentRoomName +
        ', goal=' +
        goalRoomName +
        ').'
    );
    return ERR_NOT_FOUND;
  }

  var nextRoomName = route[nextIdx];

  // If we already crossed into the next room (border case), advance the index.
  if (currentRoomName === nextRoomName) {
    creep.memory[indexKey] = nextIdx;
    return OK;
  }

  var exitDir = Game.map.findExit(currentRoomName, nextRoomName);
  if (exitDir < 0) {
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' Game.map.findExit from ' +
        currentRoomName +
        ' to ' +
        nextRoomName +
        ' returned ' +
        exitDir +
        '.'
    );
    return ERR_NO_PATH;
  }

  var exitPos = creep.pos.findClosestByRange(exitDir);
  if (!exitPos) {
    console.log(
      '[DepositHarvesterRoute] ' +
        creep.name +
        ' could not find exit ' +
        exitDir +
        ' in room ' +
        currentRoomName +
        ' toward ' +
        nextRoomName +
        '.'
    );
    return ERR_NO_PATH;
  }

  // Local navigation inside this room to reach the correct exit tile.
  // Screeps pathfinding handles dynamic obstacles here.
  creep.moveTo(exitPos, {
    reusePath: 5,
    maxOps: 2000
  });

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
    // --- FIX: LOGICAL BOUNCE PREVENTION ---
    // If empty, only return to work if we are NOT dying AND we are ALREADY HOME.
    // Fixed threshold to 500 so it matches run() logic.
    if (typeof creep.ticksToLive === 'number' && creep.ticksToLive <= 500) {
      creep.suicide();
      return;
    }

    if (creep.room.name === homeRoom.name) {
      // Next trip: reset forward index, go outbound again.
      creep.memory.depositRouteIndex = 0;
      creep.memory.state = 'travelToDeposit';
      return;
    }
    // If not home, fall through to movement logic to continue walking home.
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

  if (!transferredSomething || creep.store.getUsedCapacity() === 0) {
    // Increased threshold to 500 to match run() logic
    if (typeof creep.ticksToLive === 'number' && creep.ticksToLive <= 500) {
      creep.suicide();
      return;
    }
    // New outbound trip.
    creep.memory.depositRouteIndex = 0;
    creep.memory.state = 'travelToDeposit';
  }
}

module.exports = {
  run: run
};