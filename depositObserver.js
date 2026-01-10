// depositObserver.js
// FIXED: Added cooldown checks to runSafetyScanner. 
// Prevents the "Scanning Loop" where the bot tries to scan faster than the Observer can work.
// UPDATED: Now supports multiple harvesters per deposit (MAX_HARVESTERS).
// OPTIMIZED: Added garbage collection for old jobs and stale pathfinding data.
// UPDATED: Filter out deposits with lastCooldown >= 100 to save CPU/Travel.
// UPDATED: Added BANNED_ROOMS to prevent routing through hostile/avoided rooms.
// UPDATED: Detects accessible edges around deposit to prevent over-spawning (Dynamic Harvester Limit).

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
var SCAN_INTERVAL = 50;
var OBSERVER_RANGE = 10;
var PASSABILITY_CACHE_TICKS = 1500;
var MAX_HARVESTERS = 3; 
var MAX_COOLDOWN = 75; // <--- Changed: Max cooldown to consider harvesting
var iff = require('iff');

function initMemory() {
  if (!Memory.depositObserver) {
    Memory.depositObserver = { 
        rooms: {}, 
        jobs: {}, 
        roomStatus: {}, 
        blockedEdges: {}, 
        scanQueue: [], 
        scanState: {} 
    };
  }
  if (!Memory.depositObserver.rooms) Memory.depositObserver.rooms = {};
  if (!Memory.depositObserver.jobs) Memory.depositObserver.jobs = {};
  if (!Memory.depositObserver.roomStatus) Memory.depositObserver.roomStatus = {};
  if (!Memory.depositObserver.blockedEdges) Memory.depositObserver.blockedEdges = {};
  if (!Memory.depositObserver.scanQueue) Memory.depositObserver.scanQueue = [];
  if (!Memory.depositObserver.scanState) Memory.depositObserver.scanState = { activeRoom: null, requestedTick: 0 };
}

// --- CUSTOM GREEDY ROUTER ---

function getRoomLinearDistance(r1, r2) {
    return Game.map.getRoomLinearDistance(r1, r2);
}

function findLinearRoute(startRoom, targetRoom) {
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
        
        for(var i=1; i<openSet.length; i++) {
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
            // -------------------------

            var status = Game.map.getRoomStatus(neighbor);
            if (status && status.status !== 'normal') continue;

            var memStatus = Memory.depositObserver.roomStatus[neighbor];
            if (memStatus && memStatus.blocked) continue;

            if (blockedEdges[current + ":" + neighbor]) continue;

            var tentative_gScore = gScore[current] + 1;
            
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

// --- CORE OBSERVER LOGIC ---

function harvestResources(targetRoomName) {
  initMemory();
  var observer = findObserverForRoom(targetRoomName);
  if (!observer) return ERR_NOT_FOUND;
  
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

function findObserverForRoom(targetRoomName) {
  var bestObserver = null;
  var bestDistance = Infinity;
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;
    var observers = room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_OBSERVER } });
    if (observers.length === 0) continue;
    var distance = Game.map.getRoomLinearDistance(roomName, targetRoomName);
    if (distance <= OBSERVER_RANGE && distance < bestDistance) {
      bestDistance = distance;
      bestObserver = observers[0];
    }
  }
  return bestObserver;
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
      goals = exitExits.map(function(p) { return { pos: p, range: 0 }; });
    }
  }

  if (goals.length === 0) return true;

  var ret = PathFinder.search(
    startPos,
    goals,
    {
      plainCost: 2, swampCost: 10,
      maxOps: 4000, 
      maxRooms: 1, 
      roomCallback: function(rName) {
        if (rName !== roomName) return false;
        return buildRoomCostMatrix(rName);
      }
    }
  );

  if (ret.incomplete) {
    // console.log('[DepositObserverSafety] BLOCKED PATH: ' + roomName);
    return false;
  }
  return true;
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
  
  var owner = controller.owner ? controller.owner.username : (controller.reservation ? controller.reservation.username : null);
  if (!owner) return true;

  if (iff.IFF_WHITELIST && iff.IFF_WHITELIST.indexOf(owner) !== -1) return true;
  
  return false;
}

// --- PLANNING & JOB MANAGEMENT ---

function planPathForJob(job) {
  if (job.pathPlanned) return;
  if (job.planningRetryTick && Game.time < job.planningRetryTick) return;
  if (!job.storagePos) return;

  var startPos = new RoomPosition(job.storagePos.x, job.storagePos.y, job.storagePos.roomName);
  var targetPos = new RoomPosition(job.x, job.y, job.roomName);

  if (Math.random() < 0.05) { 
      Memory.depositObserver.blockedEdges = {}; 
      Memory.depositObserver.roomStatus = {};
  }

  var route = findLinearRoute(startPos.roomName, targetPos.roomName);

  if (!route || route.length === 0) {
    console.log('[DepositObserverPlan] No route for job ' + job.id + '. Wiping cache & retrying.');
    Memory.depositObserver.blockedEdges = {}; 
    job.planningRetryTick = Game.time + 20;
    return;
  }

  var missingVision = false;
  for (var i = 0; i < route.length; i++) {
    var rName = route[i];
    var status = Memory.depositObserver.roomStatus[rName];
    var isFresh = status && (Game.time - status.lastScan < PASSABILITY_CACHE_TICKS);
    var roomObj = Game.rooms[rName];
    var isMine = roomObj && roomObj.controller && roomObj.controller.my;

    if (!isMine) {
      if (!isFresh) {
        if (Memory.depositObserver.scanQueue.indexOf(rName) === -1) {
            Memory.depositObserver.scanQueue.unshift(rName);
        }
        missingVision = true;
      }
    }
  }

  if (missingVision) {
    if (Game.time % 20 === 0) console.log('[DepositObserverPlan] Verifying route (' + route.length + ' rooms)...');
    job.route = route; 
    return; 
  }

  var exitDirections = {};
  var exitDirectionsBack = {};
  for (var i = 0; i < route.length - 1; i++) {
    var dir = Game.map.findExit(route[i], route[i+1]);
    if (dir > 0) {
        exitDirections[route[i]] = dir;
        exitDirectionsBack[route[i+1]] = (dir + 2) % 8 || 8;
    }
  }
  
  job.route = route;
  job.routeBack = route.slice().reverse();
  job.exitDirections = exitDirections;
  job.exitDirectionsBack = exitDirectionsBack;
  job.pathRooms = route.slice();
  
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
    job.path = result.path.map(function(p) { return { x: p.x, y: p.y, roomName: p.roomName }; });
    job.pathBack = job.path.slice().reverse();
  }
}

function runSafetyScanner() {
  var mem = Memory.depositObserver;
  
  // 1. PROCESS SCAN RESULT FROM PREVIOUS TICK
  if (mem.scanState.activeRoom) {
    var roomName = mem.scanState.activeRoom;
    var room = Game.rooms[roomName];
    
    // If room is visible, we succeeded.
    if (room) {
      var safe = isRoomSafeForTravel(roomName);
      var connectivityBlocked = false;

      for (var id in mem.jobs) {
        var job = mem.jobs[id];
        if (!job.route) continue;
        
        var idx = job.route.indexOf(roomName);
        if (idx > -1 && idx < job.route.length - 1) {
            var nextRoom = job.route[idx+1];
            var prevRoom = idx > 0 ? job.route[idx-1] : null;
            
            if (!checkRoomPassability(roomName, prevRoom, nextRoom)) {
                connectivityBlocked = true;
                mem.blockedEdges[roomName + ":" + nextRoom] = true;
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
                 job.route = null;
                 job.path = null;
             }
         }
      }

      // Success! Remove from queue.
      mem.scanState.activeRoom = null;
      // We only remove from queue if the ROOM MATCHES head of queue 
      // (Safety check in case logic got desynced)
      if (mem.scanQueue.length > 0 && mem.scanQueue[0] === roomName) {
        mem.scanQueue.shift();
      }

    } else {
        // Room still not visible?
        // Maybe observer failed or tick alignment issue.
        // We will retry observation below if it's still in queue.
        // Just clear active state so we can try observing again.
        mem.scanState.activeRoom = null;
    }
  }

  // 2. PICK NEXT SCAN (If not currently processing one)
  if (mem.scanQueue.length > 0 && !mem.scanState.activeRoom) {
    var nextRoom = mem.scanQueue[0];
    var observer = findObserverForRoom(nextRoom);
    
    if (observer) {
        if (observer.cooldown > 0) {
            // Observer Busy: Do nothing. Wait for next tick.
            return;
        }

        var result = observer.observeRoom(nextRoom);
        if (result === OK) {
             mem.scanState.activeRoom = nextRoom;
        }
    } else {
        console.log('[DepositObserver] Skipping unreachable room ' + nextRoom);
        mem.scanQueue.shift();
    }
  }
}

function ensureJobForDeposit(deposit) {
  // --- NEW: Cooldown Check ---
  // If the deposit is too tired (high lastCooldown), don't create a job.
  if ((deposit.lastCooldown || 0) >= MAX_COOLDOWN) {
      return false;
  }
  
  var jobs = Memory.depositObserver.jobs;
  if (jobs[deposit.id]) return false;

  var homeRoom = findNearestRcl7Home(deposit.room.name);
  if (!homeRoom) return false;

  // --- NEW: Terrain Analysis ---
  // Count how many non-wall spots are around the deposit
  var terrain = deposit.room.getTerrain();
  var freeSpots = 0;
  for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          if (terrain.get(deposit.pos.x + dx, deposit.pos.y + dy) !== TERRAIN_MASK_WALL) {
              freeSpots++;
          }
      }
  }
  
  // Cap the harvesters by available spots, but don't exceed global MAX_HARVESTERS
  var jobMaxHarvesters = Math.min(freeSpots, MAX_HARVESTERS);
  if (jobMaxHarvesters < 1) jobMaxHarvesters = 1; // Always allow at least 1 if it spawned? (Rare edge case)

  var storagePos = { x: homeRoom.storage.pos.x, y: homeRoom.storage.pos.y, roomName: homeRoom.name };

  jobs[deposit.id] = {
    id: deposit.id,
    roomName: deposit.room.name,
    x: deposit.pos.x, y: deposit.pos.y,
    type: deposit.depositType,
    homeRoom: homeRoom.name,
    storagePos: storagePos,
    creeps: [], // Changed to array for multiple harvesters
    maxHarvesters: jobMaxHarvesters, // Store the specific limit
    completed: false,
    pathPlanned: false
  };
  
  console.log('[DepositObserver] Found new deposit ' + deposit.id + '. Spots: ' + freeSpots + '. Limit set to: ' + jobMaxHarvesters);
  return true;
}

function maintainJobs() {
    var statusReport = [];
    var idsToDelete = [];
    
    for (var id in Memory.depositObserver.jobs) {
        var job = Memory.depositObserver.jobs[id];

        // --- MIGRATION: Convert old single-creep jobs to array format automatically ---
        if (job.creepName) {
            if (!job.creeps) job.creeps = [];
            job.creeps.push(job.creepName);
            delete job.creepName;
        }
        if (!job.creeps) job.creeps = [];
        // -----------------------------------------------------------------------------

        // 1. Prune dead creeps from the array
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

        var status = "Unknown";
        
        // Use job specific limit if available, otherwise default
        var currentJobLimit = job.maxHarvesters || MAX_HARVESTERS;

        if (!job.pathPlanned) {
            if (job.planningRetryTick && Game.time < job.planningRetryTick) {
                status = "❄️ Retry in " + (job.planningRetryTick - Game.time);
            } else {
                planPathForJob(job);
                if (job.pathPlanned) status = "✅ Planned";
                else if (job.planningRetryTick) status = "❌ Failed";
                else status = "⏳ Scanning";
            }
        } 
        // Logic to spawn up to currentJobLimit
        else if (job.creeps.length < currentJobLimit && DEPOSIT_HARVESTING_ENABLED) {
            var spawnResult = spawnHarvesterForJob(job);
            if (spawnResult === OK) status = "🚀 Spawning (" + (job.creeps.length) + "/" + currentJobLimit + ")";
            else if (spawnResult === ERR_BUSY) status = "💤 Busy (" + job.creeps.length + "/" + currentJobLimit + ")";
            else status = "❌ Err " + spawnResult;
        } 
        else {
            if (job.creeps.length > 0) {
                // Get the TTL of the first creep just for display purposes
                var firstCreep = Game.creeps[job.creeps[0]];
                var ttl = firstCreep ? firstCreep.ticksToLive : "Spawning";
                status = "Working [" + job.creeps.length + "/" + currentJobLimit + "] (TTL: " + ttl + ")";
            } else {
                status = "Idle (Waiting)";
            }
        }

        statusReport.push({ room: job.roomName, status: status });
    }

    // Cleanup completed jobs
    for (var i = 0; i < idsToDelete.length; i++) {
        delete Memory.depositObserver.jobs[idsToDelete[i]];
    }

    if (Game.time % 100 === 0 || Memory.depositObserver.printStatus) {
        console.log('--- DEPOSIT STATUS ---');
        statusReport.forEach(function(s) { console.log("[" + s.room + "]: " + s.status); });
        Memory.depositObserver.printStatus = false;
    }
}

function findNearestRcl7Home(targetRoomName) {
  var bestRoom = null, bestDist = Infinity;
  for (var name in Game.rooms) {
    var r = Game.rooms[name];
    if(r.controller && r.controller.my && r.controller.level >= 7 && r.storage && r.find(FIND_MY_SPAWNS).length > 0) {
      var d = Game.map.getRoomLinearDistance(name, targetRoomName);
      if(d < bestDist) { bestDist = d; bestRoom = r; }
    }
  }
  return bestRoom;
}

function spawnHarvesterForJob(job) {
  var home = Game.rooms[job.homeRoom];
  if(!home) return ERR_NOT_FOUND;
  
  var spawn = home.find(FIND_MY_SPAWNS).find(function(s) { return !s.spawning; });
  if(!spawn) return ERR_BUSY;
  
  var body = [];
  var setCost = 2 * BODYPART_COST[WORK] + 1 * BODYPART_COST[CARRY] + 2 * BODYPART_COST[MOVE];
  var parts = Math.floor(home.energyCapacityAvailable / setCost);
  if (parts > 10) parts = 10; 
  if (parts < 1) parts = 1;

  for(var i=0; i<parts; i++) body.push(WORK,WORK,CARRY,MOVE,MOVE);
  
  // Unique name appended with timestamp so we can spawn multiple for the same job
  var name = 'depositHarvester_' + job.roomName + '_' + job.id + '_' + Game.time + '_' + job.creeps.length;
  
  var mem = {
    role: 'depositHarvester',
    homeRoom: job.homeRoom, targetRoom: job.roomName,
    depositId: job.id, 
    depositRoute: job.route, 
    depositRouteBack: job.routeBack,
    depositX: job.x, 
    depositY: job.y
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
  var roomsMem = Memory.depositObserver.rooms;
  var currentTime = Game.time;
  
  for (var roomName in roomsMem) {
    var data = roomsMem[roomName];
    if (currentTime >= data.nextScanTick) {
        var observer = findObserverForRoom(roomName);
        if (observer && !observer.cooldown) {
            observer.observeRoom(roomName);
            data.lastObserved = currentTime;
            data.nextScanTick = currentTime + SCAN_INTERVAL;
            break; 
        }
    }
  }
  
  for (var roomName in roomsMem) {
    var room = Game.rooms[roomName];
    if (!room) continue;

    // --- CLEANUP LOGIC START ---
    var currentDeposits = room.find(FIND_DEPOSITS);
    var foundDepositIds = [];
    for (var k = 0; k < currentDeposits.length; k++) {
        var d = currentDeposits[k];
        foundDepositIds.push(d.id);

        // If the deposit is too hard, remove existing job (if any)
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
            // If we have a job for this room, but the deposit ID is not in current findings, it is gone.
            if (foundDepositIds.indexOf(jobId) === -1) {
                console.log('[DepositObserver] Deposit ' + jobId + ' in ' + roomName + ' decayed. Removing job.');
                delete Memory.depositObserver.jobs[jobId];
            }
        }
    }
    // --- CLEANUP LOGIC END ---

    for (var i = 0; i < currentDeposits.length; i++) {
        if (DEPOSIT_TYPES.indexOf(currentDeposits[i].depositType) !== -1) ensureJobForDeposit(currentDeposits[i]);
    }
  }
}

function cleanStaleMemory() {
    // Only run this occasionally to save CPU
    if (Game.time % 1000 !== 0) return;

    var roomStatus = Memory.depositObserver.roomStatus;
    var now = Game.time;
    var cleared = 0;

    for (var rName in roomStatus) {
        // If the scan is older than the cache time + buffer, delete it
        if (now - roomStatus[rName].lastScan > (PASSABILITY_CACHE_TICKS + 500)) {
            delete roomStatus[rName];
            cleared++;
        }
    }

    if (cleared > 0) {
        console.log('[DepositObserver] Garbage collected ' + cleared + ' stale room records.');
    }
}

function isCreepSpawning(creepName) {
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    var spawns = room.find(FIND_MY_SPAWNS);
    for (var i = 0; i < spawns.length; i++) {
      var spawn = spawns[i];
      if (spawn.spawning && spawn.spawning.name === creepName) return true;
    }
  }
  return false;
}

function run() {
    initMemory();
    runSafetyScanner();
    scanVisibleRoomsForDeposits();
    maintainJobs();
    cleanStaleMemory(); // New memory cleaner
}

module.exports = { 
    run: run, 
    harvestResources: harvestResources,
    stopObservation: stopObservation,
    cancelJobsInRoom: cancelJobsInRoom
};