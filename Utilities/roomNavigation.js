// roomNavigation.js
// Shared room-by-room navigation system used by deposit harvesters, thieves, etc.
// Uses observer-scanned routes when available, falls back to Game.map.findRoute.

var DEBUG = false; // Set to true to diagnose routing issues

// ---------- Route Finding (A* over rooms) ----------

function getRoomLinearDistance(r1, r2) {
    return Game.map.getRoomLinearDistance(r1, r2);
}

/**
 * A* pathfinder for room corridors.
 * Respects observer's blocked rooms/edges and custom banned rooms.
 * @param {string} startRoom
 * @param {string} targetRoom
 * @param {string[]} [bannedRooms] - Additional rooms to avoid
 * @returns {string[]|null} Array of room names or null if no path
 */
function findLinearRoute(startRoom, targetRoom, bannedRooms) {
    bannedRooms = bannedRooms || [];
    
    var openSet = [startRoom];
    var cameFrom = {};
    var gScore = {};
    gScore[startRoom] = 0;
    
    var fScore = {};
    fScore[startRoom] = getRoomLinearDistance(startRoom, targetRoom) * 10;
    
    var visited = {};
    var blockedEdges = (Memory.depositObserver && Memory.depositObserver.blockedEdges) || {};

    while (openSet.length > 0) {
        // Find node with lowest fScore
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

            // Banned room check
            if (bannedRooms.indexOf(neighbor) !== -1) continue;

            // Game status check (novice/respawn zones)
            var status = Game.map.getRoomStatus(neighbor);
            if (status && status.status !== 'normal') continue;

            // Observer's room status (hostile owners, etc.)
            if (Memory.depositObserver && Memory.depositObserver.roomStatus) {
                var memStatus = Memory.depositObserver.roomStatus[neighbor];
                if (memStatus && memStatus.blocked) continue;
            }

            // Observer's blocked edges (impassable terrain between rooms)
            if (blockedEdges[current + ':' + neighbor]) continue;

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

// ---------- Edge Handling ----------

function isOnEdge(pos) {
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

// ---------- Cost Matrix that blocks wrong exits ----------

/**
 * Build a cost matrix that blocks all room exits EXCEPT the one to nextRoomName.
 * This prevents moveTo() from escaping through the wrong exit.
 * 
 * @param {string} currentRoomName
 * @param {string} nextRoomName - The only room we're allowed to exit to
 * @returns {PathFinder.CostMatrix}
 */
function buildExitConstrainedMatrix(currentRoomName, nextRoomName) {
    var costs = new PathFinder.CostMatrix();
    var room = Game.rooms[currentRoomName];
    
    if (!room) return costs;
    
    // Get the exit direction we WANT to use
    var allowedExitDir = Game.map.findExit(currentRoomName, nextRoomName);
    
    // Block ALL edge tiles first
    for (var x = 0; x < 50; x++) {
        costs.set(x, 0, 255);   // Top edge
        costs.set(x, 49, 255);  // Bottom edge
    }
    for (var y = 0; y < 50; y++) {
        costs.set(0, y, 255);   // Left edge
        costs.set(49, y, 255);  // Right edge
    }
    
    // Now UNBLOCK only the exit tiles leading to our target room
    if (allowedExitDir > 0) {
        var allowedExits = room.find(allowedExitDir);
        var terrain = room.getTerrain();
        
        for (var i = 0; i < allowedExits.length; i++) {
            var pos = allowedExits[i];
            // Only unblock if it's not a wall
            if (terrain.get(pos.x, pos.y) !== TERRAIN_MASK_WALL) {
                costs.set(pos.x, pos.y, 1); // Make it passable
            }
        }
    }
    
    // Also mark structures
    var structures = room.find(FIND_STRUCTURES);
    for (var j = 0; j < structures.length; j++) {
        var s = structures[j];
        if (s.structureType === STRUCTURE_ROAD) {
            // Don't override our exit blocking for roads on edges
            if (s.pos.x > 0 && s.pos.x < 49 && s.pos.y > 0 && s.pos.y < 49) {
                costs.set(s.pos.x, s.pos.y, 1);
            }
        } else if (s.structureType !== STRUCTURE_CONTAINER &&
                   s.structureType !== STRUCTURE_RAMPART) {
            costs.set(s.pos.x, s.pos.y, 255);
        } else if (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic) {
            costs.set(s.pos.x, s.pos.y, 255);
        }
    }
    
    // Mark hostile creeps
    var hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    for (var k = 0; k < hostileCreeps.length; k++) {
        costs.set(hostileCreeps[k].pos.x, hostileCreeps[k].pos.y, 255);
    }
    
    return costs;
}

// ---------- Room-by-Room Navigation ----------

/**
 * Follow a room route stored in creep memory.
 * Handles edge bounce prevention by moving to room center when on boundary.
 * BLOCKS wrong exits to prevent creep from leaving through unintended rooms.
 * 
 * @param {Creep} creep
 * @param {string} routeKey - Memory key where route array is stored
 * @param {string} goalRoom - Final destination room name
 * @returns {number} OK, ERR_NOT_FOUND, or ERR_NO_PATH
 */
function followRoomRoute(creep, routeKey, goalRoom) {
    var route = creep.memory[routeKey];
    var indexKey = routeKey + 'Index';
    
    if (!Array.isArray(route) || route.length === 0) {
        if (DEBUG) console.log('[RoomNav] ' + creep.name + ' no route in memory key: ' + routeKey);
        return ERR_NOT_FOUND;
    }
    
    var currentRoomName = creep.room.name;
    
    // EXIT BOUNCE PREVENTION
    // If on edge tile (x=0, x=49, y=0, y=49), immediately move into the room.
    // This prevents the engine from bouncing us back to the previous room.
    if (isOnEdge(creep.pos)) {
        if (DEBUG) console.log('[RoomNav] ' + creep.name + ' on edge, moving to center');
        creep.moveTo(new RoomPosition(25, 25, creep.room.name), { reusePath: 0, maxOps: 500 });
        return OK;
    }
    
    // If already in goal room, signal success - let caller handle local movement
    if (goalRoom && currentRoomName === goalRoom) {
        if (DEBUG) console.log('[RoomNav] ' + creep.name + ' reached goal room: ' + goalRoom);
        return OK;
    }
    
    var idx = creep.memory[indexKey];
    
    // Sync index with current room if needed
    if (typeof idx !== 'number' || idx < 0 || idx >= route.length || route[idx] !== currentRoomName) {
        var foundIdx = -1;
        for (var i = 0; i < route.length; i++) {
            if (route[i] === currentRoomName) {
                foundIdx = i;
                break;
            }
        }
        
        if (foundIdx !== -1) {
            idx = foundIdx;
            if (DEBUG) console.log('[RoomNav] ' + creep.name + ' synced to route index ' + idx + ' (room: ' + currentRoomName + ')');
        } else {
            // Off-route: snap to nearest route room by linear distance
            if (DEBUG) console.log('[RoomNav] ' + creep.name + ' OFF ROUTE! Current: ' + currentRoomName + ', Route: ' + JSON.stringify(route));
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
            if (DEBUG) console.log('[RoomNav] ' + creep.name + ' snapped to nearest route room: ' + route[idx] + ' (index ' + idx + ')');
        }
        
        creep.memory[indexKey] = idx;
    }
    
    // Determine next room in sequence
    var nextIdx = idx + 1;
    if (nextIdx >= route.length) {
        // No more rooms in route
        if (!goalRoom || currentRoomName === goalRoom) {
            return OK;
        }
        console.log('[RoomNav] ' + creep.name + ' exhausted route but not in goal room. Current: ' + currentRoomName + ', Goal: ' + goalRoom);
        return ERR_NOT_FOUND;
    }
    
    var nextRoomName = route[nextIdx];
    
    // Already crossed into next room (edge case)
    if (currentRoomName === nextRoomName) {
        creep.memory[indexKey] = nextIdx;
        return OK;
    }
    
    // Find exit direction to next room
    var exitDir = Game.map.findExit(currentRoomName, nextRoomName);
    if (exitDir < 0) {
        console.log('[RoomNav] ' + creep.name + ' findExit failed: ' + currentRoomName + ' -> ' + nextRoomName + ' (error: ' + exitDir + ')');
        return ERR_NO_PATH;
    }
    
    var exitPos = creep.pos.findClosestByRange(exitDir);
    if (!exitPos) {
        console.log('[RoomNav] ' + creep.name + ' no exit tile found for dir ' + exitDir);
        return ERR_NO_PATH;
    }
    
    if (DEBUG) {
        console.log('[RoomNav] ' + creep.name + ' navigating: ' + currentRoomName + ' -> ' + nextRoomName + 
            ' (exit dir: ' + exitDir + ', target: ' + exitPos.x + ',' + exitPos.y + ')');
        console.log('[RoomNav] ' + creep.name + ' full route: ' + JSON.stringify(route) + ' index: ' + idx);
    }
    
    // Visual debugging - draw the intended path
    if (DEBUG) {
        creep.room.visual.line(creep.pos, exitPos, { color: '#00ff00', lineStyle: 'dashed' });
        creep.room.visual.text('→' + nextRoomName, exitPos.x, exitPos.y - 0.5, { color: '#00ff00', font: 0.4 });
    }
    
    // Build cost matrix that BLOCKS all exits except the one we want
    var costMatrix = buildExitConstrainedMatrix(currentRoomName, nextRoomName);
    
    // Local pathfinding to exit tile with constrained exits
    var moveResult = creep.moveTo(exitPos, { 
        reusePath: 5, 
        maxOps: 2000,
        costCallback: function(roomName) {
            if (roomName === currentRoomName) {
                return costMatrix;
            }
            return false; // Don't path into other rooms
        }
    });
    
    if (moveResult === ERR_NO_PATH) {
        // Clear cached path and try again next tick
        delete creep.memory._move;
        if (DEBUG) console.log('[RoomNav] ' + creep.name + ' ERR_NO_PATH to exit, cleared cache');
    }
    
    return OK;
}

/**
 * Ensure a route exists in creep memory, computing if needed.
 * Uses observer-aware A* first, falls back to Game.map.findRoute.
 * 
 * @param {Creep} creep
 * @param {string} fromRoom - Starting room
 * @param {string} toRoom - Destination room
 * @param {string} routeKey - Memory key to store route
 * @param {string[]} [bannedRooms] - Rooms to avoid
 * @returns {string[]|null} The route array or null if no path
 */
function ensureRoute(creep, fromRoom, toRoom, routeKey, bannedRooms) {
    bannedRooms = bannedRooms || [];
    var indexKey = routeKey + 'Index';
    
    // Normalize room names for comparison
    fromRoom = fromRoom.toUpperCase();
    toRoom = toRoom.toUpperCase();
    
    // If same room, no route needed
    if (fromRoom === toRoom) {
        creep.memory[routeKey] = [fromRoom];
        return creep.memory[routeKey];
    }
    
    var existingRoute = creep.memory[routeKey];
    
    // Check if existing route is still valid
    if (Array.isArray(existingRoute) && existingRoute.length >= 2) {
        var routeEnd = existingRoute[existingRoute.length - 1];
        
        // Route is valid if it ends at our destination
        if (routeEnd === toRoom) {
            // Check current room is in the route
            var currentRoom = creep.room.name.toUpperCase();
            var currentIdx = -1;
            for (var i = 0; i < existingRoute.length; i++) {
                if (existingRoute[i].toUpperCase() === currentRoom) {
                    currentIdx = i;
                    break;
                }
            }
            
            if (currentIdx !== -1) {
                if (DEBUG) console.log('[RoomNav] ' + creep.name + ' using existing route: ' + JSON.stringify(existingRoute));
                return existingRoute;
            } else {
                if (DEBUG) console.log('[RoomNav] ' + creep.name + ' current room ' + currentRoom + ' not in route, recalculating');
            }
        } else {
            if (DEBUG) console.log('[RoomNav] ' + creep.name + ' route ends at ' + routeEnd + ' but goal is ' + toRoom + ', recalculating');
        }
    }
    
    // Compute new route using observer-aware A*
    if (DEBUG) console.log('[RoomNav] ' + creep.name + ' computing new route: ' + fromRoom + ' -> ' + toRoom);
    var newRoute = findLinearRoute(fromRoom, toRoom, bannedRooms);
    
    if (newRoute && newRoute.length >= 1) {
        creep.memory[routeKey] = newRoute;
        delete creep.memory[indexKey];
        if (DEBUG) console.log('[RoomNav] ' + creep.name + ' new A* route: ' + JSON.stringify(newRoute));
        return newRoute;
    }
    
    // Fallback to Game.map.findRoute
    if (DEBUG) console.log('[RoomNav] ' + creep.name + ' A* failed, trying Game.map.findRoute');
    var routeResult = Game.map.findRoute(fromRoom, toRoom, {
        routeCallback: function(roomName) {
            if (bannedRooms.indexOf(roomName) !== -1) return Infinity;
            if (Memory.depositObserver && Memory.depositObserver.roomStatus) {
                var memStatus = Memory.depositObserver.roomStatus[roomName];
                if (memStatus && memStatus.blocked) return Infinity;
            }
            return 1;
        }
    });
    
    if (routeResult === ERR_NO_PATH || !routeResult || routeResult.length === 0) {
        console.log('[RoomNav] ' + creep.name + ' no route from ' + fromRoom + ' to ' + toRoom);
        return null;
    }
    
    var fallbackRoute = [fromRoom];
    for (var i = 0; i < routeResult.length; i++) {
        if (routeResult[i] && routeResult[i].room) {
            fallbackRoute.push(routeResult[i].room);
        }
    }
    
    creep.memory[routeKey] = fallbackRoute;
    delete creep.memory[indexKey];
    if (DEBUG) console.log('[RoomNav] ' + creep.name + ' fallback route: ' + JSON.stringify(fallbackRoute));
    return fallbackRoute;
}

/**
 * Clear route data from creep memory.
 * @param {Creep} creep
 * @param {string} routeKey
 */
function clearRoute(creep, routeKey) {
    delete creep.memory[routeKey];
    delete creep.memory[routeKey + 'Index'];
    delete creep.memory._move; // Also clear cached moveTo path
}

/**
 * Enable/disable debug logging
 * @param {boolean} enabled
 */
function setDebug(enabled) {
    DEBUG = !!enabled;
    console.log('[RoomNav] Debug mode: ' + (DEBUG ? 'ON' : 'OFF'));
}

module.exports = {
    findLinearRoute: findLinearRoute,
    followRoomRoute: followRoomRoute,
    ensureRoute: ensureRoute,
    clearRoute: clearRoute,
    isOnEdge: isOnEdge,
    setDebug: setDebug
};