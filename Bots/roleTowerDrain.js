// roleTowerDrain.js
// =============================================================================
// Tower Drain System with Comprehensive Route & Edge Scanning
// =============================================================================
//
// Usage:
//   orderTowerDrain('E1S1', 'E2S1', 2)       // Order 2 drainers from E1S1 to drain E2S1
//   orderTowerDrain('E1S1', 'E2S1', 2, 'N')  // Order 2 drainers, attack from North edge
//   cancelTowerDrainOrder('E1S1', 'E2S1')    // Cancel the operation
//   getTowerDrainStatus()                     // View all operations status
//
// In main.js:
//   require('roleTowerDrain').run();
//
// =============================================================================
// 4-POSITION BOUNCE MECHANIC:
// =============================================================================
// Each lane uses 4 specific positions - 2 in the safe room, 2 in the target room.
// The creep bounces between these positions to drain towers while staying alive.
//
// Example: Attacking E4N51 from the NORTH (safe room = E4N52, entry edge = N)
// Lane coordinate: x = 15
//
//   SAFE ROOM (E4N52)                    TARGET ROOM (E4N51)
//   +---------------------------+        +---------------------------+
//   |                           |        |                           |
//   |                           |        |  [4] attackRestPos        |
//   |                           |        |      (15, 1) - DRAIN HERE |
//   |                           |        |      Takes tower damage   |
//   |                           |        |                           |
//   |                           |        |  [3] attackEdgePos        |
//   |  [1] healRestPos          |   y=49 |      (15, 0) - transit    |
//   |      (15, 48) - HEAL HERE |========|========================== | y=0
//   |      Safe from towers     |  EDGE  |                           |
//   |                           |        |                           |
//   |  [2] healEdgePos          |        |                           |
//   |      (15, 49) - transit   |        |                           |
//   +---------------------------+        +---------------------------+
//
// Creep Behavior:
//   1. Travel to drainPos [4] - sit here taking tower fire
//   2. When damaged, retreat to healPos [1] - self-heal safely
//   3. When fully healed, return to drainPos [4]
//   4. Repeat until towers are drained of energy
//
// The 4 positions per lane:
//   - healRestPos  [1]: Safe room, 1 tile from edge - creep heals here
//   - healEdgePos  [2]: Safe room, on the edge - transit tile
//   - attackEdgePos[3]: Target room, on the edge - transit tile  
//   - attackRestPos[4]: Target room, 1 tile from edge - creep drains here
//
// For convenience:
//   - drainPos = attackRestPos (where creep sits to take damage)
//   - healPos  = healRestPos   (where creep sits to heal)
//
// =============================================================================
// Planning Flow:
// 1. orderTowerDrain() creates operation with status 'scanning'
// 2. Build route from home -> target, identify safe room (room before target)
//    - If preferredEdge specified, route through the adjacent room in that direction
// 3. For each room in route (skip owned rooms):
//    - Use observer to scan
//    - Route rooms: Check passability (can walk from entry to exit edge)
//    - Safe room: Analyze edge facing target for walkable heal positions
//    - Target room: Analyze entry edge for walkable drain positions
// 4. Once all scans complete:
//    - Verify entire route is passable
//    - Find tiles walkable on BOTH safe and target sides
//    - Compute lane positions with 1-tile gaps
// 5. Status -> 'ready', spawning begins
// 6. Creeps spawn with pre-assigned lanes, route, and positions
// =============================================================================
// CROSS-SECTOR ROUTING:
// =============================================================================
// When origin and target are in different 10x10 sectors, we need to route
// through highway rooms (rooms where X or Y coordinate ends in 0).
//
// Algorithm:
// 1. Detect if same sector using areInSameSector()
// 2. If same sector: use normal direct routing
// 3. If different sector:
//    a. BFS from safe room to find up to 16 paths to highway rooms
//    b. Scan each room in all paths with observer
//    c. Filter out routes containing hostile rooms
//    d. Pick route with shortest total path (origin -> highway -> safe room)
// =============================================================================

// ========== CONSTANTS ==========

var OBSERVER_RANGE = 10;
var SCAN_TIMEOUT_TICKS = 10;
var MAX_CROSS_SECTOR_ROUTES = 16;
var CROSS_SECTOR_PROGRESS_INTERVAL = 10;

// ========== PER-TICK CACHE ==========
// Avoids redundant room.find() and CostMatrix builds within the same tick.
// Automatically resets each tick.

var _tickCache = { tick: 0 };

function getTickCache() {
    if (_tickCache.tick !== Game.time) {
        _tickCache = { tick: Game.time };
    }
    return _tickCache;
}

/** Cached room.find - reuses results within the same tick */
function cachedFind(room, findType) {
    var cache = getTickCache();
    var key = room.name + '_f' + findType;
    if (cache[key] === undefined) {
        cache[key] = room.find(findType);
    }
    return cache[key];
}

/** Cached CostMatrix for pathfinding - built once per room per tick */
function getCachedCostMatrix(room) {
    var cache = getTickCache();
    var key = room.name + '_cm';
    if (cache[key]) return cache[key];

    var costs = new PathFinder.CostMatrix();
    var structures = cachedFind(room, FIND_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
        var s = structures[i];
        if (s.structureType === STRUCTURE_ROAD) {
            costs.set(s.pos.x, s.pos.y, 1);
        } else if (s.structureType === STRUCTURE_WALL) {
            costs.set(s.pos.x, s.pos.y, 255);
        } else if (s.structureType === STRUCTURE_RAMPART) {
            if (!s.my && !s.isPublic) {
                costs.set(s.pos.x, s.pos.y, 255);
            }
        } else if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) {
            costs.set(s.pos.x, s.pos.y, 255);
        }
    }

    cache[key] = costs;
    return costs;
}

/** Cached CostMatrix that also marks other creeps as obstacles */
function getCachedCostMatrixWithCreeps(room, selfId) {
    var cache = getTickCache();
    // Keyed per-creep since selfId differs
    var key = room.name + '_cmc_' + selfId;
    if (cache[key]) return cache[key];

    // Clone the base matrix (structures only)
    var base = getCachedCostMatrix(room);
    var costs = base.clone ? base.clone() : new PathFinder.CostMatrix();

    // If CostMatrix doesn't have clone (old server), rebuild
    if (!base.clone) {
        var structures = cachedFind(room, FIND_STRUCTURES);
        for (var i = 0; i < structures.length; i++) {
            var s = structures[i];
            if (s.structureType === STRUCTURE_ROAD) {
                costs.set(s.pos.x, s.pos.y, 1);
            } else if (s.structureType === STRUCTURE_WALL) {
                costs.set(s.pos.x, s.pos.y, 255);
            } else if (s.structureType === STRUCTURE_RAMPART) {
                if (!s.my && !s.isPublic) costs.set(s.pos.x, s.pos.y, 255);
            } else if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) {
                costs.set(s.pos.x, s.pos.y, 255);
            }
        }
    }

    var creeps = cachedFind(room, FIND_CREEPS);
    for (var c = 0; c < creeps.length; c++) {
        if (creeps[c].id !== selfId) {
            costs.set(creeps[c].pos.x, creeps[c].pos.y, 255);
        }
    }

    cache[key] = costs;
    return costs;
}

// ========== IFF INTEGRATION ==========

var iff = require('iff');

/**
 * Check if a room is a Source Keeper room
 */
function isSourceKeeperRoom(roomName) {
    var parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!parsed) return false;
    var x = parseInt(parsed[2], 10) % 10;
    var y = parseInt(parsed[4], 10) % 10;
    return (x >= 4 && x <= 6) && (y >= 4 && y <= 6);
}

/**
 * Check if a room is a highway room (no controller)
 */
function isHighwayRoom(roomName) {
    var parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!parsed) return false;
    var x = parseInt(parsed[2], 10);
    var y = parseInt(parsed[4], 10);
    return x % 10 === 0 || y % 10 === 0;
}

/**
 * Check if two rooms are in the same 10x10 sector
 */
function areInSameSector(roomName1, roomName2) {
    var parsed1 = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName1);
    var parsed2 = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName2);
    
    if (!parsed1 || !parsed2) return false;
    
    var we1 = parsed1[1];
    var x1 = parseInt(parsed1[2], 10);
    var ns1 = parsed1[3];
    var y1 = parseInt(parsed1[4], 10);
    
    var we2 = parsed2[1];
    var x2 = parseInt(parsed2[2], 10);
    var ns2 = parsed2[3];
    var y2 = parseInt(parsed2[4], 10);
    
    if (we1 !== we2 || ns1 !== ns2) return false;
    
    return Math.floor(x1 / 10) === Math.floor(x2 / 10) && 
           Math.floor(y1 / 10) === Math.floor(y2 / 10);
}

/**
 * Get the sector name for a room (e.g., E4N49 -> E0N40)
 */
function getSectorName(roomName) {
    var parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!parsed) return null;
    
    var we = parsed[1];
    var x = parseInt(parsed[2], 10);
    var ns = parsed[3];
    var y = parseInt(parsed[4], 10);
    
    var sectorX = Math.floor(x / 10) * 10;
    var sectorY = Math.floor(y / 10) * 10;
    
    return we + sectorX + ns + sectorY;
}

/**
 * Get the route cost for a room, considering IFF and room type
 */
function getRoomRouteCost(roomName, blockedRooms) {
    if (blockedRooms && blockedRooms[roomName]) {
        return Infinity;
    }
    
    if (isHighwayRoom(roomName)) {
        return 1;
    }
    
    if (isSourceKeeperRoom(roomName)) {
        return 2;
    }
    
    var room = Game.rooms[roomName];
    if (room && room.controller) {
        if (room.controller.my) {
            return 1;
        }
        
        if (room.controller.owner) {
            var owner = room.controller.owner.username;
            if (iff.isFriendlyUsername(owner)) {
                return 1;
            } else {
                return Infinity;
            }
        }
        
        if (room.controller.reservation) {
            var reserver = room.controller.reservation.username;
            if (iff.isFriendlyUsername(reserver)) {
                return 1;
            } else {
                return 3;
            }
        }
    }
    
    if (Memory.roomIntel && Memory.roomIntel[roomName]) {
        var intel = Memory.roomIntel[roomName];
        if (intel.owner) {
            if (iff.isFriendlyUsername(intel.owner)) {
                return 1;
            } else {
                return Infinity;
            }
        }
    }
    
    return 1.5;
}

// ========== MEMORY INITIALIZATION ==========

function initMemory() {
    if (!Memory.towerDrainOps) {
        Memory.towerDrainOps = {
            operations: {},
            scanState: { activeRoom: null, requestedTick: 0, opKey: null, purpose: null }
        };
    }
    if (!Memory.towerDrainOps.operations) Memory.towerDrainOps.operations = {};
    if (!Memory.towerDrainOps.scanState) {
        Memory.towerDrainOps.scanState = { activeRoom: null, requestedTick: 0, opKey: null, purpose: null };
    }
}

// ========== OBSERVER MANAGEMENT ==========

function findObserverForRoom(targetRoomName) {
    var best = null;
    
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        
        if (!room.controller || !room.controller.my) continue;
        if (room.controller.level < 8) continue;
        
        var distance = Game.map.getRoomLinearDistance(roomName, targetRoomName);
        if (distance > OBSERVER_RANGE) continue;
        
        var observers = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_OBSERVER }
        });
        
        if (observers.length === 0) continue;
        
        if (!best || distance < best.distance) {
            best = {
                observer: observers[0],
                distance: distance,
                roomName: roomName
            };
        }
    }
    
    return best;
}

function getAllObservers() {
    var observers = [];
    
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        
        if (!room.controller || !room.controller.my) continue;
        if (room.controller.level < 8) continue;
        
        var roomObservers = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_OBSERVER }
        });
        
        for (var i = 0; i < roomObservers.length; i++) {
            observers.push({
                observer: roomObservers[i],
                roomName: roomName
            });
        }
    }
    
    return observers;
}

function canAnyObserverReach(targetRoomName) {
    var observers = getAllObservers();
    
    for (var i = 0; i < observers.length; i++) {
        var distance = Game.map.getRoomLinearDistance(observers[i].roomName, targetRoomName);
        if (distance <= OBSERVER_RANGE) {
            return true;
        }
    }
    
    return false;
}

function isMyRoom(roomName) {
    var room = Game.rooms[roomName];
    if (!room) return false;
    if (!room.controller) return false;
    return room.controller.my;
}

function checkRoomSafety(room) {
    if (!room) return { safe: false, reason: 'no_vision' };
    
    if (room.controller && room.controller.my) {
        return { safe: true, reason: 'owned_by_us' };
    }
    
    if (room.controller && room.controller.owner) {
        var owner = room.controller.owner.username;
        if (!iff.isFriendlyUsername(owner)) {
            return { safe: false, reason: 'owned_by_hostile_' + owner };
        }
        return { safe: true, reason: 'owned_by_friendly_' + owner };
    }
    
    if (room.controller && room.controller.reservation) {
        var reserver = room.controller.reservation.username;
        if (!iff.isFriendlyUsername(reserver)) {
            var hostileTowers = room.find(FIND_HOSTILE_STRUCTURES, {
                filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
            });
            if (hostileTowers.length > 0) {
                return { safe: false, reason: 'hostile_towers_' + hostileTowers.length };
            }
        }
    }
    
    var hostileTowers = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
    });
    if (hostileTowers.length > 0) {
        return { safe: false, reason: 'hostile_towers_' + hostileTowers.length };
    }
    
    return { safe: true, reason: 'unowned_no_threats' };
}

// ========== EDGE & PASSABILITY ANALYSIS ==========

function buildCostMatrix(room) {
    var matrix = new PathFinder.CostMatrix();
    
    var structures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
        var s = structures[i];
        
        if (s.structureType === STRUCTURE_WALL) {
            matrix.set(s.pos.x, s.pos.y, 255);
        } else if (s.structureType === STRUCTURE_RAMPART) {
            if (!s.my && !s.isPublic) {
                matrix.set(s.pos.x, s.pos.y, 255);
            }
        } else if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) {
            matrix.set(s.pos.x, s.pos.y, 255);
        }
    }
    
    return matrix;
}

function checkRoomPassability(room, fromRoomName, toRoomName) {
    if (!room) return { passable: false, reason: 'no_vision', availableExits: [] };
    
    var entryDir = fromRoomName ? Game.map.findExit(room.name, fromRoomName) : null;
    var intendedExitDir = toRoomName ? Game.map.findExit(room.name, toRoomName) : null;
    
    if (toRoomName && (intendedExitDir === ERR_NO_PATH || intendedExitDir === ERR_INVALID_ARGS)) {
        return { passable: false, reason: 'no_exit_to_' + toRoomName, availableExits: [] };
    }
    
    var startPos;
    if (entryDir && entryDir > 0) {
        var entryExits = room.find(entryDir);
        if (entryExits.length > 0) {
            startPos = entryExits[Math.floor(entryExits.length / 2)];
        } else {
            startPos = new RoomPosition(25, 25, room.name);
        }
    } else {
        startPos = new RoomPosition(25, 25, room.name);
    }
    
    var matrix = buildCostMatrix(room);
    
    var exitDirs = [FIND_EXIT_TOP, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT, FIND_EXIT_RIGHT];
    var exitNames = ['N', 'S', 'W', 'E'];
    var availableExits = [];
    var intendedPassable = false;
    
    for (var i = 0; i < exitDirs.length; i++) {
        var exitDir = exitDirs[i];
        var exitTiles = room.find(exitDir);
        
        if (exitTiles.length === 0) continue;
        
        var goals = [];
        for (var j = 0; j < exitTiles.length; j++) {
            goals.push({ pos: exitTiles[j], range: 0 });
        }
        
        var result = PathFinder.search(startPos, goals, {
            roomCallback: function(rn) {
                if (rn !== room.name) return false;
                return matrix;
            },
            maxRooms: 1,
            maxOps: 5000
        });
        
        if (!result.incomplete) {
            availableExits.push(exitNames[i]);
            
            if (exitDir === intendedExitDir) {
                intendedPassable = true;
            }
        }
    }
    
    if (intendedPassable) {
        return { passable: true, reason: 'ok', availableExits: availableExits };
    }
    
    if (availableExits.length > 0) {
        return { 
            passable: false, 
            reason: 'intended_path_blocked', 
            availableExits: availableExits,
            partiallyPassable: true
        };
    }
    
    return { passable: false, reason: 'all_exits_blocked', availableExits: [] };
}

function analyzeRoomEdges(room) {
    if (!room) return null;
    
    var terrain = room.getTerrain();
    var structures = room.find(FIND_STRUCTURES);
    
    var blocked = {};
    for (var i = 0; i < structures.length; i++) {
        var s = structures[i];
        var isBlocking = false;
        
        if (s.structureType === STRUCTURE_WALL) {
            isBlocking = true;
        } else if (s.structureType === STRUCTURE_RAMPART) {
            if (!s.my && !s.isPublic) {
                isBlocking = true;
            }
        } else if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) {
            isBlocking = true;
        }
        
        if (isBlocking) {
            blocked[s.pos.x + ':' + s.pos.y] = true;
        }
    }
    
    function isWalkable(x, y) {
        if (x < 0 || x > 49 || y < 0 || y > 49) return false;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
        if (blocked[x + ':' + y]) return false;
        return true;
    }
    
    var edges = {
        N: { walkableTiles: [], totalWalkable: 0 },
        S: { walkableTiles: [], totalWalkable: 0 },
        E: { walkableTiles: [], totalWalkable: 0 },
        W: { walkableTiles: [], totalWalkable: 0 }
    };
    
    for (var x = 1; x <= 48; x++) {
        if (isWalkable(x, 0) && isWalkable(x, 1)) {
            edges.N.walkableTiles.push(x);
            edges.N.totalWalkable++;
        }
    }
    
    for (var x = 1; x <= 48; x++) {
        if (isWalkable(x, 49) && isWalkable(x, 48)) {
            edges.S.walkableTiles.push(x);
            edges.S.totalWalkable++;
        }
    }
    
    for (var y = 1; y <= 48; y++) {
        if (isWalkable(49, y) && isWalkable(48, y)) {
            edges.E.walkableTiles.push(y);
            edges.E.totalWalkable++;
        }
    }
    
    for (var y = 1; y <= 48; y++) {
        if (isWalkable(0, y) && isWalkable(1, y)) {
            edges.W.walkableTiles.push(y);
            edges.W.totalWalkable++;
        }
    }
    
    return edges;
}

function getEntryEdge(safeRoom, targetRoom) {
    var exitDir = Game.map.findExit(safeRoom, targetRoom);
    if (exitDir === FIND_EXIT_TOP) return 'S';
    if (exitDir === FIND_EXIT_BOTTOM) return 'N';
    if (exitDir === FIND_EXIT_LEFT) return 'E';
    if (exitDir === FIND_EXIT_RIGHT) return 'W';
    return null;
}

function getOppositeEdge(edge) {
    var map = { N: 'S', S: 'N', E: 'W', W: 'E' };
    return map[edge] || null;
}

// ========== CROSS-SECTOR BFS ROUTING ==========

function getRoomNeighbors(roomName) {
    var neighbors = [];
    var exits = Game.map.describeExits(roomName);
    
    if (!exits) return neighbors;
    
    var dirMap = {
        '1': 'N',
        '3': 'E', 
        '5': 'S',
        '7': 'W'
    };
    
    for (var exitKey in exits) {
        var neighborRoom = exits[exitKey];
        var direction = dirMap[exitKey];
        if (neighborRoom && direction) {
            neighbors.push({
                room: neighborRoom,
                direction: direction
            });
        }
    }
    
    return neighbors;
}

function getDirectionBetweenRooms(fromRoom, toRoom) {
    var exits = Game.map.describeExits(fromRoom);
    if (!exits) return null;
    
    var dirMap = { '1': 'N', '3': 'E', '5': 'S', '7': 'W' };
    
    for (var exitKey in exits) {
        if (exits[exitKey] === toRoom) {
            return dirMap[exitKey];
        }
    }
    
    return null;
}

function bfsFindHighwayPaths(safeRoom, targetRoom, maxRoutes) {
    maxRoutes = maxRoutes || MAX_CROSS_SECTOR_ROUTES;
    
    var paths = [];
    var visited = {};
    var queue = [];
    
    queue.push({ 
        room: safeRoom, 
        path: [{ room: safeRoom, entryDir: null, exitDir: null }]
    });
    visited[safeRoom] = true;
    visited[targetRoom] = true;
    
    while (queue.length > 0 && paths.length < maxRoutes) {
        var current = queue.shift();
        var currentRoom = current.room;
        var currentPath = current.path;
        
        var neighbors = getRoomNeighbors(currentRoom);
        
        for (var i = 0; i < neighbors.length; i++) {
            var neighborInfo = neighbors[i];
            var neighbor = neighborInfo.room;
            var exitDir = neighborInfo.direction;
            
            if (visited[neighbor]) continue;
            
            if (!canAnyObserverReach(neighbor)) {
                continue;
            }
            
            visited[neighbor] = true;
            
            var newPath = [];
            for (var p = 0; p < currentPath.length; p++) {
                var pathNode = currentPath[p];
                if (p === currentPath.length - 1) {
                    newPath.push({ 
                        room: pathNode.room, 
                        entryDir: pathNode.entryDir, 
                        exitDir: exitDir 
                    });
                } else {
                    newPath.push(pathNode);
                }
            }
            
            var entryDir = getOppositeEdge(exitDir);
            newPath.push({ room: neighbor, entryDir: entryDir, exitDir: null });
            
            if (isHighwayRoom(neighbor)) {
                paths.push(newPath);
                
                if (paths.length >= maxRoutes) {
                    break;
                }
            } else {
                queue.push({ room: neighbor, path: newPath });
            }
        }
    }
    
    console.log('[TowerDrain] BFS found ' + paths.length + ' paths to highways from ' + safeRoom);
    
    return paths;
}

function deduplicateRooms(paths) {
    var seen = {};
    var rooms = [];
    
    for (var i = 0; i < paths.length; i++) {
        var path = paths[i];
        for (var j = 0; j < path.length; j++) {
            var node = path[j];
            var room = (typeof node === 'string') ? node : node.room;
            if (!seen[room]) {
                seen[room] = true;
                rooms.push(room);
            }
        }
    }
    
    return rooms;
}

function getPathNodeRoom(node) {
    return (typeof node === 'string') ? node : node.room;
}

function getPathNodeDirections(path, roomName) {
    for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (typeof node === 'object' && node.room === roomName) {
            return { entryDir: node.entryDir, exitDir: node.exitDir };
        }
    }
    return null;
}

function calculateTotalPathLength(originRoom, highwayEntry, pathLengthToHighway) {
    var routeToHighway = Game.map.findRoute(originRoom, highwayEntry, {
        routeCallback: function(roomName) {
            return getRoomRouteCost(roomName, null);
        }
    });
    
    if (!routeToHighway || routeToHighway === ERR_NO_PATH) {
        return Infinity;
    }
    
    return routeToHighway.length + pathLengthToHighway;
}

function selectBestCrossSectorRoute(originRoom, validPaths) {
    if (validPaths.length === 0) {
        return null;
    }
    
    var best = null;
    
    for (var i = 0; i < validPaths.length; i++) {
        var path = validPaths[i];
        var lastNode = path[path.length - 1];
        var highwayEntry = getPathNodeRoom(lastNode);
        var pathLengthToHighway = path.length - 1;
        
        var totalLength = calculateTotalPathLength(originRoom, highwayEntry, pathLengthToHighway);
        
        if (totalLength === Infinity) continue;
        
        if (!best || totalLength < best.totalLength) {
            best = {
                path: path,
                highwayEntry: highwayEntry,
                totalLength: totalLength
            };
        }
    }
    
    return best;
}

// ========== LANE COMPUTATION ==========

function computeLanes(op) {
    var edge = op.entryEdge;
    var targetRoom = op.targetRoom;
    var safeRoom = op.safeRoom;
    var count = op.maxDrainers;
    
    if (!op.scanData) {
        console.log('[TowerDrain] Cannot compute lanes: no scan data');
        return false;
    }
    
    var targetEdgeData = op.scanData.targetEdges ? op.scanData.targetEdges[edge] : null;
    var targetWalkable = targetEdgeData ? targetEdgeData.walkableTiles : [];
    
    var safeEdge = getOppositeEdge(edge);
    var safeEdgeData = op.scanData.safeEdges ? op.scanData.safeEdges[safeEdge] : null;
    var safeWalkable = safeEdgeData ? safeEdgeData.walkableTiles : [];
    
    console.log('[TowerDrain] Target edge ' + edge + ' has ' + targetWalkable.length + ' walkable tiles');
    console.log('[TowerDrain] Safe edge ' + safeEdge + ' has ' + safeWalkable.length + ' walkable tiles');
    
    var bothWalkable = [];
    for (var i = 0; i < targetWalkable.length; i++) {
        var coord = targetWalkable[i];
        if (safeWalkable.indexOf(coord) !== -1) {
            bothWalkable.push(coord);
        }
    }
    
    console.log('[TowerDrain] ' + bothWalkable.length + ' tiles walkable on both sides');
    
    if (bothWalkable.length === 0) {
        console.log('[TowerDrain] ERROR: No tiles walkable on both sides of edge ' + edge);
        return false;
    }
    
    bothWalkable.sort(function(a, b) {
        return Math.abs(a - 25) - Math.abs(b - 25);
    });
    
    function buildPositions(edgeStr, c) {
        var attackEdgePos, attackRestPos, healEdgePos, healRestPos;
        
        if (edgeStr === 'W') {
            attackEdgePos = { x: 0, y: c, roomName: targetRoom };
            attackRestPos = { x: 1, y: c, roomName: targetRoom };
            healEdgePos = { x: 49, y: c, roomName: safeRoom };
            healRestPos = { x: 48, y: c, roomName: safeRoom };
        } else if (edgeStr === 'E') {
            attackEdgePos = { x: 49, y: c, roomName: targetRoom };
            attackRestPos = { x: 48, y: c, roomName: targetRoom };
            healEdgePos = { x: 0, y: c, roomName: safeRoom };
            healRestPos = { x: 1, y: c, roomName: safeRoom };
        } else if (edgeStr === 'N') {
            attackEdgePos = { x: c, y: 0, roomName: targetRoom };
            attackRestPos = { x: c, y: 1, roomName: targetRoom };
            healEdgePos = { x: c, y: 49, roomName: safeRoom };
            healRestPos = { x: c, y: 48, roomName: safeRoom };
        } else { // 'S'
            attackEdgePos = { x: c, y: 49, roomName: targetRoom };
            attackRestPos = { x: c, y: 48, roomName: targetRoom };
            healEdgePos = { x: c, y: 0, roomName: safeRoom };
            healRestPos = { x: c, y: 1, roomName: safeRoom };
        }
        
        return {
            attackEdgePos: attackEdgePos,
            attackRestPos: attackRestPos,
            healEdgePos: healEdgePos,
            healRestPos: healRestPos,
            drainPos: attackRestPos,
            healPos: healRestPos
        };
    }
    
    var used = {};
    var laneNumber = 1;
    op.lanes = {};
    
    for (var j = 0; j < bothWalkable.length && laneNumber <= count; j++) {
        var c = bothWalkable[j];
        
        if (used[c] || used[c - 1] || used[c + 1]) continue;
        
        var positions = buildPositions(edge, c);
        op.lanes[String(laneNumber)] = positions;
        used[c] = true;
        
        console.log('[TowerDrain] Lane ' + laneNumber + ' at coord ' + c + 
                    ': drain=' + JSON.stringify(positions.drainPos) + 
                    ', heal=' + JSON.stringify(positions.healPos));
        
        laneNumber++;
    }
    
    var lanesCreated = Object.keys(op.lanes).length;
    if (lanesCreated < count) {
        console.log('[TowerDrain] WARNING: Only found ' + lanesCreated + ' valid lanes (requested ' + count + ')');
    }
    
    return lanesCreated > 0;
}

// ========== OPERATION MANAGEMENT ==========

function orderTowerDrain(homeRoom, targetRoom, count, preferredEdge) {
    initMemory();
    
    if (preferredEdge) {
        preferredEdge = preferredEdge.toUpperCase();
        if (['N', 'S', 'E', 'W'].indexOf(preferredEdge) === -1) {
            console.log('[TowerDrain] Invalid preferredEdge: ' + preferredEdge + '. Use N, S, E, or W.');
            return ERR_INVALID_ARGS;
        }
        console.log('[TowerDrain] Preferred entry edge: ' + preferredEdge);
    }
    
    var home = Game.rooms[homeRoom];
    if (!home) {
        console.log('[TowerDrain] Cannot start: no vision of home room ' + homeRoom);
        return ERR_NOT_FOUND;
    }
    
    if (!home.controller || !home.controller.my) {
        console.log('[TowerDrain] Cannot start: ' + homeRoom + ' is not owned');
        return ERR_INVALID_TARGET;
    }
    
    if (!home.storage) {
        console.log('[TowerDrain] Cannot start: ' + homeRoom + ' has no storage');
        return ERR_INVALID_TARGET;
    }
    
    var spawns = home.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) {
        console.log('[TowerDrain] Cannot start: ' + homeRoom + ' has no spawns');
        return ERR_INVALID_TARGET;
    }
    
    var observerInfo = findObserverForRoom(targetRoom);
    if (!observerInfo) {
        console.log('[TowerDrain] Cannot start: no RCL 8 room with observer within ' + OBSERVER_RANGE + ' of ' + targetRoom);
        return ERR_NOT_FOUND;
    }
    
    var opKey = homeRoom + '->' + targetRoom;
    
    if (Memory.towerDrainOps.operations[opKey]) {
        var existingOp = Memory.towerDrainOps.operations[opKey];
        
        if (existingOp.status === 'failed') {
            console.log('[TowerDrain] Clearing failed operation ' + opKey + ' (reason: ' + (existingOp.failReason || 'unknown') + ')');
            delete Memory.towerDrainOps.operations[opKey];
        } else {
            console.log('[TowerDrain] Operation ' + opKey + ' already exists (status: ' + existingOp.status + ')');
            return ERR_NAME_EXISTS;
        }
    }
    
    var requiredSafeRoom = null;
    if (preferredEdge) {
        requiredSafeRoom = getAdjacentRoom(targetRoom, preferredEdge);
        if (!requiredSafeRoom) {
            console.log('[TowerDrain] Cannot determine safe room for edge ' + preferredEdge);
            return ERR_INVALID_ARGS;
        }
        console.log('[TowerDrain] Required safe room for ' + preferredEdge + ' entry: ' + requiredSafeRoom);
    }
    
    var sameSector = areInSameSector(homeRoom, targetRoom);
    console.log('[TowerDrain] Origin sector: ' + getSectorName(homeRoom) + ', Target sector: ' + getSectorName(targetRoom));
    console.log('[TowerDrain] Same sector: ' + sameSector);
    
    if (sameSector) {
        return orderTowerDrainSameSector(homeRoom, targetRoom, count, preferredEdge, requiredSafeRoom, observerInfo, opKey);
    } else {
        return orderTowerDrainCrossSector(homeRoom, targetRoom, count, preferredEdge, requiredSafeRoom, observerInfo, opKey);
    }
}

function orderTowerDrainSameSector(homeRoom, targetRoom, count, preferredEdge, requiredSafeRoom, observerInfo, opKey) {
    var routeResult;
    if (requiredSafeRoom) {
        var routeToSafe = Game.map.findRoute(homeRoom, requiredSafeRoom, {
            routeCallback: function(roomName, fromRoomName) {
                return getRoomRouteCost(roomName, null);
            }
        });
        
        if (!routeToSafe || routeToSafe === ERR_NO_PATH) {
            console.log('[TowerDrain] Cannot find route from ' + homeRoom + ' to required safe room ' + requiredSafeRoom);
            console.log('[TowerDrain] Falling back to cross-sector routing...');
            return orderTowerDrainCrossSector(homeRoom, targetRoom, count, preferredEdge, requiredSafeRoom, observerInfo, opKey);
        }
        
        var exitToTarget = Game.map.findExit(requiredSafeRoom, targetRoom);
        if (exitToTarget === ERR_NO_PATH || exitToTarget === ERR_INVALID_ARGS) {
            console.log('[TowerDrain] Required safe room ' + requiredSafeRoom + ' is not adjacent to target ' + targetRoom);
            return ERR_INVALID_ARGS;
        }
        
        routeResult = routeToSafe.slice();
        routeResult.push({ room: targetRoom, exit: exitToTarget });
    } else {
        routeResult = Game.map.findRoute(homeRoom, targetRoom, {
            routeCallback: function(roomName, fromRoomName) {
                return getRoomRouteCost(roomName, null);
            }
        });
    }
    
    if (!routeResult || routeResult === ERR_NO_PATH || routeResult.length === 0) {
        console.log('[TowerDrain] Cannot find direct route from ' + homeRoom + ' to ' + targetRoom);
        console.log('[TowerDrain] Falling back to cross-sector routing...');
        return orderTowerDrainCrossSector(homeRoom, targetRoom, count, preferredEdge, requiredSafeRoom, observerInfo, opKey);
    }
    
    var route = [homeRoom];
    for (var i = 0; i < routeResult.length; i++) {
        if (routeResult[i] && routeResult[i].room) {
            route.push(routeResult[i].room);
        }
    }
    
    var safeRoom = requiredSafeRoom || (route.length >= 2 ? route[route.length - 2] : homeRoom);
    var routeBack = route.slice().reverse();
    
    var roomsToScan = [];
    for (var j = 1; j < route.length; j++) {
        var rn = route[j];
        if (!isMyRoom(rn)) {
            roomsToScan.push(rn);
        }
    }
    
    Memory.towerDrainOps.operations[opKey] = {
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        safeRoom: safeRoom,
        route: route,
        routeBack: routeBack,
        maxDrainers: count,
        creeps: [],
        status: 'scanning',
        entryEdge: preferredEdge || null,
        preferredEdge: preferredEdge || null,
        lanes: {},
        observerRoom: observerInfo.roomName,
        crossSector: false,
        scanData: {
            roomsToScan: roomsToScan,
            scannedRooms: {},
            routePassability: {},
            targetEdges: null,
            safeEdges: null
        }
    };
    
    console.log('[TowerDrain] Created SAME-SECTOR operation ' + opKey);
    console.log('[TowerDrain] Route: ' + route.join(' -> '));
    console.log('[TowerDrain] Safe room: ' + safeRoom);
    if (preferredEdge) {
        console.log('[TowerDrain] Entry edge (forced): ' + preferredEdge);
    }
    console.log('[TowerDrain] Observer in: ' + observerInfo.roomName + ' (distance ' + observerInfo.distance + ')');
    console.log('[TowerDrain] Rooms to scan: ' + roomsToScan.join(', '));
    
    return OK;
}

function orderTowerDrainCrossSector(homeRoom, targetRoom, count, preferredEdge, requiredSafeRoom, observerInfo, opKey) {
    var safeRoom;
    if (requiredSafeRoom) {
        safeRoom = requiredSafeRoom;
    } else if (preferredEdge) {
        safeRoom = getAdjacentRoom(targetRoom, preferredEdge);
    } else {
        var directions = ['N', 'S', 'E', 'W'];
        for (var d = 0; d < directions.length; d++) {
            var adjacent = getAdjacentRoom(targetRoom, directions[d]);
            if (adjacent && adjacent !== homeRoom) {
                safeRoom = adjacent;
                preferredEdge = directions[d];
                break;
            }
        }
    }
    
    if (!safeRoom) {
        console.log('[TowerDrain] Cannot determine safe room for cross-sector routing');
        return ERR_INVALID_ARGS;
    }
    
    console.log('[TowerDrain] Cross-sector operation: safe room = ' + safeRoom);
    
    var candidatePaths = bfsFindHighwayPaths(safeRoom, targetRoom, MAX_CROSS_SECTOR_ROUTES);
    
    if (candidatePaths.length === 0) {
        console.log('[TowerDrain] BFS found no paths to highways from ' + safeRoom);
        return ERR_NO_PATH;
    }
    
    console.log('[TowerDrain] Found ' + candidatePaths.length + ' candidate paths to highways');
    
    var roomsToScan = deduplicateRooms(candidatePaths);
    
    if (roomsToScan.indexOf(targetRoom) === -1) {
        roomsToScan.push(targetRoom);
    }
    
    Memory.towerDrainOps.operations[opKey] = {
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        safeRoom: safeRoom,
        route: null,
        routeBack: null,
        maxDrainers: count,
        creeps: [],
        status: 'scanning',
        entryEdge: preferredEdge || null,
        preferredEdge: preferredEdge || null,
        lanes: {},
        observerRoom: observerInfo.roomName,
        crossSector: true,
        scanData: {
            roomsToScan: roomsToScan,
            scannedRooms: {},
            routePassability: {},
            targetEdges: null,
            safeEdges: null,
            candidatePaths: candidatePaths,
            validPaths: [],
            invalidatedPaths: [],
            roomsScannedCount: 0,
            lastProgressTick: Game.time
        }
    };
    
    console.log('[TowerDrain] Created CROSS-SECTOR operation ' + opKey);
    console.log('[TowerDrain] Safe room: ' + safeRoom);
    console.log('[TowerDrain] Entry edge: ' + (preferredEdge || 'TBD'));
    console.log('[TowerDrain] Candidate paths: ' + candidatePaths.length);
    console.log('[TowerDrain] Total rooms to scan: ' + roomsToScan.length);
    
    return OK;
}

function cancelTowerDrainOrder(homeRoom, targetRoom) {
    initMemory();
    
    var opKey = homeRoom + '->' + targetRoom;
    var op = Memory.towerDrainOps.operations[opKey];
    
    if (!op) {
        console.log('[TowerDrain] Operation ' + opKey + ' does not exist');
        return ERR_NOT_FOUND;
    }
    
    for (var i = 0; i < op.creeps.length; i++) {
        var creep = Game.creeps[op.creeps[i]];
        if (creep) {
            creep.suicide();
        }
    }
    
    delete Memory.towerDrainOps.operations[opKey];
    
    if (Memory.towerDrainProgress) {
        delete Memory.towerDrainProgress[opKey];
    }
    
    console.log('[TowerDrain] Cancelled operation ' + opKey);
    return OK;
}

function getTowerDrainStatus() {
    initMemory();
    
    var ops = Memory.towerDrainOps.operations;
    var count = Object.keys(ops).length;
    
    console.log('=== Tower Drain Operations (' + count + ') ===');
    
    for (var opKey in ops) {
        var op = ops[opKey];
        console.log('');
        console.log('Operation: ' + opKey);
        console.log('  Status: ' + op.status);
        console.log('  Cross-Sector: ' + (op.crossSector ? 'YES' : 'NO'));
        console.log('  Route: ' + (op.route ? op.route.join(' -> ') : 'N/A'));
        console.log('  Safe Room: ' + op.safeRoom);
        console.log('  Entry Edge: ' + (op.entryEdge || 'TBD') + (op.preferredEdge ? ' (forced)' : ''));
        console.log('  Lanes: ' + Object.keys(op.lanes || {}).length + '/' + op.maxDrainers);
        console.log('  Creeps: ' + (op.creeps ? op.creeps.length : 0));
        
        if (op.scanData) {
            var scanned = Object.keys(op.scanData.scannedRooms || {}).length;
            var total = op.scanData.roomsToScan ? op.scanData.roomsToScan.length : 0;
            console.log('  Scan Progress: ' + scanned + '/' + total);
            
            if (op.crossSector) {
                var validPaths = op.scanData.validPaths ? op.scanData.validPaths.length : 0;
                var invalidPaths = op.scanData.invalidatedPaths ? op.scanData.invalidatedPaths.length : 0;
                var totalPaths = op.scanData.candidatePaths ? op.scanData.candidatePaths.length : 0;
                console.log('  Valid Paths: ' + validPaths + '/' + totalPaths + ' (invalidated: ' + invalidPaths + ')');
            }
            
            if (op.scanData.rerouteAttempts) {
                console.log('  Reroute Attempts: ' + op.scanData.rerouteAttempts + '/5');
            }
            
            if (op.scanData.blockedRooms && op.scanData.blockedRooms.length > 0) {
                console.log('  Blocked Rooms: ' + op.scanData.blockedRooms.join(', '));
            } else if (op.scanData.routePassability) {
                var blocked = [];
                for (var rn in op.scanData.routePassability) {
                    if (!op.scanData.routePassability[rn]) {
                        blocked.push(rn);
                    }
                }
                if (blocked.length > 0) {
                    console.log('  Blocked Rooms: ' + blocked.join(', '));
                }
            }
        }
        
        if (op.failReason) {
            console.log('  Fail Reason: ' + op.failReason);
        }
    }
    
    console.log('');
    console.log('Scan State: ' + JSON.stringify(Memory.towerDrainOps.scanState));
}

// ========== SCANNING SYSTEM ==========

function runScanner() {
    var mem = Memory.towerDrainOps;
    var state = mem.scanState;
    
    if (state.activeRoom && state.opKey) {
        var op = mem.operations[state.opKey];
        var room = Game.rooms[state.activeRoom];
        
        if (room && op) {
            if (op.crossSector) {
                processCrossSectorScanResult(op, state.activeRoom, room, state.opKey);
            } else {
                processScanResult(op, state.activeRoom, room);
            }
            state.activeRoom = null;
            state.opKey = null;
            state.purpose = null;
        } else if (Game.time - state.requestedTick > SCAN_TIMEOUT_TICKS) {
            console.log('[TowerDrain] Scan of ' + state.activeRoom + ' timed out');
            state.activeRoom = null;
            state.opKey = null;
            state.purpose = null;
        } else {
            return;
        }
    }
    
    for (var opKey in mem.operations) {
        var op = mem.operations[opKey];
        
        if (op.status !== 'scanning') continue;
        if (!op.scanData || !op.scanData.roomsToScan) continue;
        
        if (op.crossSector && op.scanData.lastProgressTick) {
            if (Game.time - op.scanData.lastProgressTick >= CROSS_SECTOR_PROGRESS_INTERVAL) {
                var scannedCount = Object.keys(op.scanData.scannedRooms || {}).length;
                var validCount = op.scanData.validPaths ? op.scanData.validPaths.length : 0;
                var totalPaths = op.scanData.candidatePaths ? op.scanData.candidatePaths.length : 0;
                var invalidCount = op.scanData.invalidatedPaths ? op.scanData.invalidatedPaths.length : 0;
                console.log('[TowerDrain] Cross-sector scan: ' + scannedCount + '/' + op.scanData.roomsToScan.length + 
                            ' rooms scanned, ' + validCount + '/' + totalPaths + ' routes still valid' +
                            ' (invalidated: ' + invalidCount + ')');
                op.scanData.lastProgressTick = Game.time;
            }
        }
        
        var nextRoom = null;
        for (var i = 0; i < op.scanData.roomsToScan.length; i++) {
            var rn = op.scanData.roomsToScan[i];
            if (!op.scanData.scannedRooms[rn]) {
                nextRoom = rn;
                break;
            }
        }
        
        if (!nextRoom) {
            if (op.crossSector) {
                finalizeCrossSectorOperation(op, opKey);
            } else {
                finalizeOperation(op, opKey);
            }
            continue;
        }
        
        if (Game.rooms[nextRoom]) {
            if (op.crossSector) {
                processCrossSectorScanResult(op, nextRoom, Game.rooms[nextRoom], opKey);
            } else {
                processScanResult(op, nextRoom, Game.rooms[nextRoom]);
            }
            continue;
        }
        
        var observerInfo = findObserverForRoom(nextRoom);
        if (!observerInfo) {
            console.log('[TowerDrain] No observer can reach ' + nextRoom + ' - marking blocked');
            op.scanData.scannedRooms[nextRoom] = { blocked: true, reason: 'no_observer' };
            op.scanData.routePassability[nextRoom] = false;
            
            if (op.crossSector) {
                invalidatePathsContainingRoom(op, nextRoom);
            }
            continue;
        }
        
        if (observerInfo.observer.cooldown > 0) {
            continue;
        }
        
        var result = observerInfo.observer.observeRoom(nextRoom);
        if (result === OK) {
            state.activeRoom = nextRoom;
            state.requestedTick = Game.time;
            state.opKey = opKey;
            
            if (nextRoom === op.targetRoom) {
                state.purpose = 'target';
            } else if (nextRoom === op.safeRoom) {
                state.purpose = 'safe';
            } else {
                state.purpose = 'route';
            }
            
            console.log('[TowerDrain] Scanning ' + nextRoom + ' (' + state.purpose + ')');
            return;
        }
    }
}

function invalidatePathsContainingRoom(op, roomName) {
    if (!op.scanData.candidatePaths) return;
    
    var stillValid = [];
    
    for (var i = 0; i < op.scanData.candidatePaths.length; i++) {
        var path = op.scanData.candidatePaths[i];
        var containsRoom = false;
        
        for (var j = 0; j < path.length; j++) {
            if (getPathNodeRoom(path[j]) === roomName) {
                containsRoom = true;
                break;
            }
        }
        
        if (containsRoom) {
            if (!op.scanData.invalidatedPaths) op.scanData.invalidatedPaths = [];
            op.scanData.invalidatedPaths.push(path);
        } else {
            stillValid.push(path);
        }
    }
    
    op.scanData.candidatePaths = stillValid;
    
    if (stillValid.length === 0) {
        console.log('[TowerDrain] All ' + MAX_CROSS_SECTOR_ROUTES + ' candidate paths have been invalidated');
    }
}

function invalidatePathsWithBlockedExit(op, roomName, blockedExits) {
    if (!op.scanData.candidatePaths || blockedExits.length === 0) return;
    
    var stillValid = [];
    var invalidatedCount = 0;
    
    for (var i = 0; i < op.scanData.candidatePaths.length; i++) {
        var path = op.scanData.candidatePaths[i];
        var pathInvalid = false;
        
        for (var j = 0; j < path.length; j++) {
            var node = path[j];
            if (typeof node === 'object' && node.room === roomName) {
                if (node.entryDir && blockedExits.indexOf(node.entryDir) !== -1) {
                    pathInvalid = true;
                    break;
                }
                if (node.exitDir && blockedExits.indexOf(node.exitDir) !== -1) {
                    pathInvalid = true;
                    break;
                }
            }
        }
        
        if (pathInvalid) {
            if (!op.scanData.invalidatedPaths) op.scanData.invalidatedPaths = [];
            op.scanData.invalidatedPaths.push(path);
            invalidatedCount++;
        } else {
            stillValid.push(path);
        }
    }
    
    if (invalidatedCount > 0) {
        console.log('[TowerDrain] Invalidated ' + invalidatedCount + ' paths due to blocked exits at ' + roomName);
    }
    
    op.scanData.candidatePaths = stillValid;
    
    if (stillValid.length === 0) {
        console.log('[TowerDrain] All candidate paths have been invalidated');
    }
}

function processCrossSectorScanResult(op, roomName, room, opKey) {
    var scanData = op.scanData;
    
    var safetyResult = checkRoomSafety(room);
    
    console.log('[TowerDrain] Cross-sector scan of ' + roomName + ': ' + 
                (safetyResult.safe ? 'SAFE' : 'HOSTILE') + ' (' + safetyResult.reason + ')');
    
    var edgeData = analyzeRoomEdges(room);
    var blockedExits = [];
    
    if (edgeData) {
        if (edgeData.N.totalWalkable === 0) blockedExits.push('N');
        if (edgeData.S.totalWalkable === 0) blockedExits.push('S');
        if (edgeData.E.totalWalkable === 0) blockedExits.push('E');
        if (edgeData.W.totalWalkable === 0) blockedExits.push('W');
        
        if (blockedExits.length > 0) {
            console.log('[TowerDrain] Room ' + roomName + ' has blocked exits: ' + blockedExits.join(', '));
        }
    }
    
    scanData.scannedRooms[roomName] = {
        tick: Game.time,
        safe: safetyResult.safe,
        reason: safetyResult.reason,
        edges: edgeData,
        blockedExits: blockedExits
    };
    
    if (roomName === op.targetRoom) {
        scanData.targetEdges = edgeData;
        console.log('[TowerDrain] Target room ' + roomName + ' edge analysis:');
        for (var te in edgeData) {
            console.log('[TowerDrain]   ' + te + ': ' + edgeData[te].totalWalkable + ' walkable tiles');
        }
        return;
    }
    
    if (roomName === op.safeRoom) {
        if (!safetyResult.safe) {
            console.log('[TowerDrain] CRITICAL: Safe room ' + roomName + ' is not safe!');
            scanData.candidatePaths = [];
            return;
        }
        
        scanData.safeEdges = edgeData;
        console.log('[TowerDrain] Safe room ' + roomName + ' edge analysis:');
        for (var se in edgeData) {
            console.log('[TowerDrain]   ' + se + ': ' + edgeData[se].totalWalkable + ' walkable tiles');
        }
        
        if (blockedExits.length > 0) {
            invalidatePathsWithBlockedExit(op, roomName, blockedExits);
        }
        return;
    }
    
    if (!safetyResult.safe) {
        console.log('[TowerDrain] Room ' + roomName + ' is hostile - invalidating affected paths');
        invalidatePathsContainingRoom(op, roomName);
        scanData.routePassability[roomName] = false;
        return;
    }
    
    if (blockedExits.length > 0) {
        invalidatePathsWithBlockedExit(op, roomName, blockedExits);
    }
    
    scanData.routePassability[roomName] = true;
}

function finalizeCrossSectorOperation(op, opKey) {
    var scanData = op.scanData;
    
    console.log('[TowerDrain] Finalizing cross-sector operation ' + opKey);
    
    var validPaths = [];
    
    for (var i = 0; i < scanData.candidatePaths.length; i++) {
        var path = scanData.candidatePaths[i];
        var pathValid = true;
        
        for (var j = 0; j < path.length; j++) {
            var node = path[j];
            var roomName = getPathNodeRoom(node);
            var roomInfo = scanData.scannedRooms[roomName];
            
            if (!roomInfo) {
                console.log('[TowerDrain] WARNING: Room ' + roomName + ' in path was not scanned');
                pathValid = false;
                break;
            }
            
            if (roomInfo.safe === false) {
                pathValid = false;
                break;
            }
            
            if (typeof node === 'object' && roomInfo.blockedExits) {
                if (node.entryDir && roomInfo.blockedExits.indexOf(node.entryDir) !== -1) {
                    console.log('[TowerDrain] Path invalid: ' + roomName + ' entry ' + node.entryDir + ' is blocked');
                    pathValid = false;
                    break;
                }
                if (node.exitDir && roomInfo.blockedExits.indexOf(node.exitDir) !== -1) {
                    console.log('[TowerDrain] Path invalid: ' + roomName + ' exit ' + node.exitDir + ' is blocked');
                    pathValid = false;
                    break;
                }
            }
        }
        
        if (pathValid) {
            validPaths.push(path);
        }
    }
    
    scanData.validPaths = validPaths;
    
    console.log('[TowerDrain] Valid paths after scanning: ' + validPaths.length);
    
    if (validPaths.length === 0) {
        console.log('[TowerDrain] FAILED: No valid paths found after scanning all ' + MAX_CROSS_SECTOR_ROUTES + ' candidates');
        op.status = 'failed';
        op.failReason = 'all_paths_blocked';
        return;
    }
    
    var bestRoute = selectBestCrossSectorRoute(op.homeRoom, validPaths);
    
    if (!bestRoute) {
        console.log('[TowerDrain] FAILED: Could not select best route');
        op.status = 'failed';
        op.failReason = 'no_valid_route';
        return;
    }
    
    console.log('[TowerDrain] Selected route via highway ' + bestRoute.highwayEntry + ' (total length: ' + bestRoute.totalLength + ')');
    
    var routeToHighway = Game.map.findRoute(op.homeRoom, bestRoute.highwayEntry, {
        routeCallback: function(roomName) {
            return getRoomRouteCost(roomName, null);
        }
    });
    
    if (!routeToHighway || routeToHighway === ERR_NO_PATH) {
        console.log('[TowerDrain] FAILED: Cannot build route to highway ' + bestRoute.highwayEntry);
        op.status = 'failed';
        op.failReason = 'no_route_to_highway';
        return;
    }
    
    var fullRoute = [op.homeRoom];
    
    for (var r = 0; r < routeToHighway.length; r++) {
        fullRoute.push(routeToHighway[r].room);
    }
    
    var bfsRooms = [];
    for (var b = 0; b < bestRoute.path.length; b++) {
        bfsRooms.push(getPathNodeRoom(bestRoute.path[b]));
    }
    bfsRooms.reverse();
    
    for (var br = 1; br < bfsRooms.length; br++) {
        if (fullRoute.indexOf(bfsRooms[br]) === -1) {
            fullRoute.push(bfsRooms[br]);
        }
    }
    
    if (fullRoute.indexOf(op.targetRoom) === -1) {
        fullRoute.push(op.targetRoom);
    }
    
    op.route = fullRoute;
    op.routeBack = fullRoute.slice().reverse();
    
    console.log('[TowerDrain] Full route: ' + fullRoute.join(' -> '));
    
    if (op.preferredEdge) {
        op.entryEdge = op.preferredEdge;
    } else {
        op.entryEdge = getEntryEdge(op.safeRoom, op.targetRoom);
    }
    
    if (!op.entryEdge) {
        console.log('[TowerDrain] FAILED: Could not determine entry edge');
        op.status = 'failed';
        op.failReason = 'no_entry_edge';
        return;
    }
    
    console.log('[TowerDrain] Entry edge: ' + op.entryEdge);
    
    if (!scanData.targetEdges) {
        console.log('[TowerDrain] FAILED: Missing target room edge data');
        op.status = 'failed';
        op.failReason = 'missing_target_edge_data';
        return;
    }
    
    if (!scanData.safeEdges) {
        console.log('[TowerDrain] FAILED: Missing safe room edge data');
        op.status = 'failed';
        op.failReason = 'missing_safe_edge_data';
        return;
    }
    
    var success = computeLanes(op);
    if (!success) {
        console.log('[TowerDrain] FAILED: Could not compute valid lanes');
        op.status = 'failed';
        op.failReason = 'no_valid_lanes';
        return;
    }
    
    op.status = 'ready';
    console.log('[TowerDrain] ✓ Cross-sector operation ' + opKey + ' is READY');
    console.log('[TowerDrain] Route: ' + op.route.join(' -> '));
    console.log('[TowerDrain] ' + Object.keys(op.lanes).length + ' lanes computed');
}

function tryReroute(op, opKey) {
    var scanData = op.scanData;
    
    if (!scanData.rerouteAttempts) scanData.rerouteAttempts = 0;
    scanData.rerouteAttempts++;
    
    if (scanData.rerouteAttempts > 5) {
        console.log('[TowerDrain] Max reroute attempts (5) reached');
        return false;
    }
    
    console.log('[TowerDrain] Reroute attempt ' + scanData.rerouteAttempts + '/5');
    
    var partialRoom = null;
    var partialExits = null;
    var completelyBlocked = [];
    
    for (var i = 1; i < op.route.length - 1; i++) {
        var rn = op.route[i];
        var roomInfo = scanData.scannedRooms[rn];
        if (!roomInfo) continue;
        
        if (!roomInfo.passable) {
            if (roomInfo.partiallyPassable && roomInfo.availableExits && roomInfo.availableExits.length > 0) {
                partialRoom = rn;
                partialExits = roomInfo.availableExits;
                console.log('[TowerDrain] Found partial room: ' + rn + ' with exits: ' + partialExits.join(', '));
                break;
            } else {
                completelyBlocked.push(rn);
            }
        }
    }
    
    if (completelyBlocked.length > 0) {
        console.log('[TowerDrain] Completely blocked rooms: ' + completelyBlocked.join(', '));
    }
    
    if (!scanData.blockedRooms) scanData.blockedRooms = [];
    for (var b = 0; b < completelyBlocked.length; b++) {
        if (scanData.blockedRooms.indexOf(completelyBlocked[b]) === -1) {
            scanData.blockedRooms.push(completelyBlocked[b]);
        }
    }
    
    var blockedSet = {};
    for (var j = 0; j < scanData.blockedRooms.length; j++) {
        blockedSet[scanData.blockedRooms[j]] = true;
    }
    
    var routeResult = null;
    
    if (partialRoom && partialExits) {
        console.log('[TowerDrain] Routing through available exits of ' + partialRoom);
        
        var avoidRoom = partialRoom;
        
        for (var e = 0; e < partialExits.length; e++) {
            var exitDir = partialExits[e];
            var exitRoom = getAdjacentRoom(partialRoom, exitDir);
            
            if (!exitRoom || exitRoom === op.homeRoom || blockedSet[exitRoom]) continue;
            
            console.log('[TowerDrain] Trying route via ' + exitRoom + ' (exit ' + exitDir + ' from ' + partialRoom + ')');
            
            var route1 = Game.map.findRoute(op.homeRoom, exitRoom, {
                routeCallback: function(roomName) {
                    if (blockedSet[roomName]) return Infinity;
                    return getRoomRouteCost(roomName, null);
                }
            });
            
            if (!route1 || route1 === ERR_NO_PATH) {
                console.log('[TowerDrain] Cannot reach ' + exitRoom);
                continue;
            }
            
            var route2 = Game.map.findRoute(exitRoom, op.targetRoom, {
                routeCallback: function(roomName) {
                    if (roomName === avoidRoom) return Infinity;
                    if (blockedSet[roomName]) return Infinity;
                    return getRoomRouteCost(roomName, null);
                }
            });
            
            if (!route2 || route2 === ERR_NO_PATH || route2.length === 0) {
                console.log('[TowerDrain] Cannot reach target from ' + exitRoom);
                continue;
            }
            
            routeResult = route1.concat(route2);
            console.log('[TowerDrain] Found route via ' + exitRoom);
            break;
        }
    }
    
    if (!routeResult) {
        console.log('[TowerDrain] Trying to completely avoid problem rooms...');
        
        var avoidSet = {};
        for (var k in blockedSet) avoidSet[k] = true;
        if (partialRoom) avoidSet[partialRoom] = true;
        
        routeResult = Game.map.findRoute(op.homeRoom, op.targetRoom, {
            routeCallback: function(roomName) {
                if (avoidSet[roomName]) return Infinity;
                return getRoomRouteCost(roomName, null);
            }
        });
    }
    
    if (!routeResult || routeResult === ERR_NO_PATH || routeResult.length === 0) {
        console.log('[TowerDrain] No alternative route found');
        return false;
    }
    
    var newRoute = [op.homeRoom];
    for (var m = 0; m < routeResult.length; m++) {
        if (routeResult[m] && routeResult[m].room) {
            newRoute.push(routeResult[m].room);
        }
    }
    
    var oldRouteStr = op.route.join(',');
    var newRouteStr = newRoute.join(',');
    if (oldRouteStr === newRouteStr) {
        console.log('[TowerDrain] Route unchanged - marking partial room as fully blocked');
        if (partialRoom && scanData.blockedRooms.indexOf(partialRoom) === -1) {
            scanData.blockedRooms.push(partialRoom);
        }
        return false;
    }
    
    console.log('[TowerDrain] Found alternative route: ' + newRoute.join(' -> '));
    
    op.route = newRoute;
    op.routeBack = newRoute.slice().reverse();
    op.safeRoom = newRoute.length >= 2 ? newRoute[newRoute.length - 2] : op.homeRoom;
    
    var newRoomsToScan = [];
    for (var n = 1; n < newRoute.length; n++) {
        var roomName = newRoute[n];
        if (isMyRoom(roomName)) continue;
        
        var alreadyScanned = scanData.scannedRooms[roomName];
        if (alreadyScanned && alreadyScanned.passable) {
            if (roomName === op.safeRoom && !scanData.safeEdges) {
                newRoomsToScan.push(roomName);
                delete scanData.scannedRooms[roomName];
            }
            continue;
        }
        
        newRoomsToScan.push(roomName);
        if (scanData.scannedRooms[roomName]) {
            delete scanData.scannedRooms[roomName];
            delete scanData.routePassability[roomName];
        }
    }
    
    if (scanData.safeEdges) {
        var safeRoomInfo = scanData.scannedRooms[op.safeRoom];
        if (!safeRoomInfo || !safeRoomInfo.passable) {
            scanData.safeEdges = null;
        }
    }
    
    scanData.roomsToScan = newRoomsToScan;
    
    console.log('[TowerDrain] New safe room: ' + op.safeRoom);
    console.log('[TowerDrain] Rooms to scan: ' + (newRoomsToScan.length > 0 ? newRoomsToScan.join(', ') : 'none'));
    
    return true;
}

function getAdjacentRoom(roomName, direction) {
    var parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!parsed) return null;
    
    var we = parsed[1];
    var x = parseInt(parsed[2], 10);
    var ns = parsed[3];
    var y = parseInt(parsed[4], 10);
    
    switch (direction) {
        case 'N':
            if (ns === 'N') { y++; } else { y--; if (y < 0) { ns = 'N'; y = 0; } }
            break;
        case 'S':
            if (ns === 'S') { y++; } else { y--; if (y < 0) { ns = 'S'; y = 0; } }
            break;
        case 'E':
            if (we === 'E') { x++; } else { x--; if (x < 0) { we = 'E'; x = 0; } }
            break;
        case 'W':
            if (we === 'W') { x++; } else { x--; if (x < 0) { we = 'W'; x = 0; } }
            break;
        default:
            return null;
    }
    
    return we + x + ns + y;
}

function processScanResult(op, roomName, room) {
    var scanData = op.scanData;
    
    var isTarget = roomName === op.targetRoom;
    var isSafe = roomName === op.safeRoom;
    var routeIndex = op.route.indexOf(roomName);
    
    var prevRoom = routeIndex > 0 ? op.route[routeIndex - 1] : null;
    var nextRoom = routeIndex < op.route.length - 1 ? op.route[routeIndex + 1] : null;
    
    console.log('[TowerDrain] Processing ' + roomName + ' (from: ' + prevRoom + ', to: ' + (nextRoom || 'TARGET') + ')');
    
    if (isTarget) {
        scanData.routePassability[roomName] = true;
        console.log('[TowerDrain] Target room ' + roomName + ' - skipping through-passability (attack destination)');
        
        var targetEdges = analyzeRoomEdges(room);
        scanData.targetEdges = targetEdges;
        console.log('[TowerDrain] Target room ' + roomName + ' edge analysis:');
        for (var te in targetEdges) {
            console.log('[TowerDrain]   ' + te + ': ' + targetEdges[te].totalWalkable + ' walkable tiles');
        }
        
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: true,
            reason: 'target_room'
        };
        return;
    }
    
    var passResult = checkRoomPassability(room, prevRoom, nextRoom);
    
    if (!scanData.roomExits) scanData.roomExits = {};
    scanData.roomExits[roomName] = passResult.availableExits || [];
    
    var transitSafetyResult = checkRoomSafety(room);
    if (!transitSafetyResult.safe) {
        console.log('[TowerDrain] Room ' + roomName + ' is UNSAFE to transit: ' + transitSafetyResult.reason);
        scanData.routePassability[roomName] = false;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: false,
            safe: false,
            safetyReason: transitSafetyResult.reason,
            reason: 'unsafe_transit'
        };
        
        if (!scanData.blockedRooms) scanData.blockedRooms = [];
        if (scanData.blockedRooms.indexOf(roomName) === -1) {
            scanData.blockedRooms.push(roomName);
        }
        
        console.log('[TowerDrain] Attempting immediate reroute around hostile room ' + roomName);
        var rerouteSuccess = tryReroute(op, null);
        if (!rerouteSuccess) {
            console.log('[TowerDrain] Immediate reroute failed - will try cross-sector routing');
            var opKey = op.homeRoom + '->' + op.targetRoom;
            convertToCrossSector(op, opKey);
        }
        return;
    }
    
    if (isSafe) {
        console.log('[TowerDrain] Safe room ' + roomName + ' safety check: SAFE (' + transitSafetyResult.reason + ')');
        
        var safeEdges = analyzeRoomEdges(room);
        scanData.safeEdges = safeEdges;
        console.log('[TowerDrain] Safe room ' + roomName + ' edge analysis:');
        for (var se in safeEdges) {
            console.log('[TowerDrain]   ' + se + ': ' + safeEdges[se].totalWalkable + ' walkable tiles');
        }
    }
    
    if (passResult.passable) {
        console.log('[TowerDrain] Room ' + roomName + ' is passable (exits: ' + passResult.availableExits.join(', ') + ')');
        scanData.routePassability[roomName] = true;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: true,
            availableExits: passResult.availableExits,
            reason: 'ok'
        };
        return;
    }
    
    console.log('[TowerDrain] Room ' + roomName + ' BLOCKED for intended path to ' + nextRoom);
    console.log('[TowerDrain] Available exits: ' + (passResult.availableExits || []).join(', '));
    
    var entryDir = getExitDirection(roomName, prevRoom);
    console.log('[TowerDrain] Entry direction: ' + entryDir);
    
    var validExits = [];
    if (passResult.availableExits) {
        for (var i = 0; i < passResult.availableExits.length; i++) {
            var exitDir = passResult.availableExits[i];
            if (exitDir !== entryDir) {
                validExits.push(exitDir);
            }
        }
    }
    
    console.log('[TowerDrain] Valid forward exits: ' + validExits.join(', '));
    
    if (validExits.length === 0) {
        console.log('[TowerDrain] No forward exits - dead end at ' + roomName);
        scanData.routePassability[roomName] = false;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: false,
            availableExits: [],
            reason: 'dead_end'
        };
        
        if (!scanData.blockedRooms) scanData.blockedRooms = [];
        if (scanData.blockedRooms.indexOf(roomName) === -1) {
            scanData.blockedRooms.push(roomName);
        }
        return;
    }
    
    for (var v = 0; v < validExits.length; v++) {
        var tryExitDir = validExits[v];
        var exitToRoom = getAdjacentRoom(roomName, tryExitDir);
        
        console.log('[TowerDrain] Trying exit ' + tryExitDir + ' to ' + exitToRoom);
        
        var newRouteResult = Game.map.findRoute(exitToRoom, op.targetRoom, {
            routeCallback: function(rn) {
                if (rn === roomName) return Infinity;
                if (scanData.blockedRooms && scanData.blockedRooms.indexOf(rn) !== -1) return Infinity;
                return getRoomRouteCost(rn, null);
            }
        });
        
        if (!newRouteResult || newRouteResult === ERR_NO_PATH || newRouteResult.length === 0) {
            console.log('[TowerDrain] No path from ' + exitToRoom + ' to target');
            continue;
        }
        
        var newFullRoute = op.route.slice(0, routeIndex + 1);
        newFullRoute.push(exitToRoom);
        for (var r = 0; r < newRouteResult.length; r++) {
            var nextRoomInRoute = newRouteResult[r].room;
            if (nextRoomInRoute !== exitToRoom) {
                newFullRoute.push(nextRoomInRoute);
            }
        }
        
        console.log('[TowerDrain] NEW ROUTE: ' + newFullRoute.join(' -> '));
        
        op.route = newFullRoute;
        op.routeBack = newFullRoute.slice().reverse();
        op.safeRoom = newFullRoute.length >= 2 ? newFullRoute[newFullRoute.length - 2] : op.homeRoom;
        
        var newRoomsToScan = [];
        for (var s = 1; s < newFullRoute.length; s++) {
            var scanRoom = newFullRoute[s];
            if (isMyRoom(scanRoom)) continue;
            if (scanData.scannedRooms[scanRoom]) continue;
            newRoomsToScan.push(scanRoom);
        }
        scanData.roomsToScan = newRoomsToScan;
        
        if (!scanData.scannedRooms[op.safeRoom]) {
            scanData.safeEdges = null;
        }
        
        scanData.routePassability[roomName] = true;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: true,
            availableExits: passResult.availableExits,
            usedExit: tryExitDir,
            reason: 'rerouted_via_' + tryExitDir
        };
        
        console.log('[TowerDrain] Route updated! New safe room: ' + op.safeRoom);
        console.log('[TowerDrain] Remaining rooms to scan: ' + newRoomsToScan.join(', '));
        return;
    }
    
    console.log('[TowerDrain] No exit from ' + roomName + ' leads to target');
    scanData.routePassability[roomName] = false;
    scanData.scannedRooms[roomName] = {
        tick: Game.time,
        passable: false,
        availableExits: passResult.availableExits,
        reason: 'no_path_to_target'
    };
    
    if (!scanData.blockedRooms) scanData.blockedRooms = [];
    if (scanData.blockedRooms.indexOf(roomName) === -1) {
        scanData.blockedRooms.push(roomName);
    }
}

function convertToCrossSector(op, opKey) {
    console.log('[TowerDrain] Converting operation ' + opKey + ' to cross-sector routing');
    
    var safeRoom = op.safeRoom;
    var targetRoom = op.targetRoom;
    
    var candidatePaths = bfsFindHighwayPaths(safeRoom, targetRoom, MAX_CROSS_SECTOR_ROUTES);
    
    if (candidatePaths.length === 0) {
        console.log('[TowerDrain] BFS found no paths to highways - operation failed');
        op.status = 'failed';
        op.failReason = 'no_highway_paths';
        return;
    }
    
    var roomsToScan = deduplicateRooms(candidatePaths);
    
    var newRoomsToScan = [];
    for (var i = 0; i < roomsToScan.length; i++) {
        var room = roomsToScan[i];
        var existing = op.scanData.scannedRooms[room];
        if (existing && existing.safe !== false) {
            continue;
        }
        newRoomsToScan.push(room);
    }
    
    op.crossSector = true;
    op.route = null;
    
    op.scanData.candidatePaths = candidatePaths;
    op.scanData.validPaths = [];
    op.scanData.invalidatedPaths = [];
    op.scanData.roomsToScan = newRoomsToScan;
    op.scanData.lastProgressTick = Game.time;
    
    if (op.scanData.blockedRooms) {
        for (var b = 0; b < op.scanData.blockedRooms.length; b++) {
            invalidatePathsContainingRoom(op, op.scanData.blockedRooms[b]);
        }
    }
    
    console.log('[TowerDrain] Converted to cross-sector with ' + candidatePaths.length + ' candidate paths');
    console.log('[TowerDrain] Rooms to scan: ' + newRoomsToScan.length);
}

function getExitDirection(fromRoom, toRoom) {
    if (!toRoom) return null;
    
    var fromParsed = /^([WE])(\d+)([NS])(\d+)$/.exec(fromRoom);
    var toParsed = /^([WE])(\d+)([NS])(\d+)$/.exec(toRoom);
    
    if (!fromParsed || !toParsed) return null;
    
    var fromWE = fromParsed[1];
    var fromX = parseInt(fromParsed[2], 10);
    var fromNS = fromParsed[3];
    var fromY = parseInt(fromParsed[4], 10);
    
    var toWE = toParsed[1];
    var toX = parseInt(toParsed[2], 10);
    var toNS = toParsed[3];
    var toY = parseInt(toParsed[4], 10);
    
    var fromAbsX = fromWE === 'W' ? -fromX - 1 : fromX;
    var fromAbsY = fromNS === 'S' ? -fromY - 1 : fromY;
    var toAbsX = toWE === 'W' ? -toX - 1 : toX;
    var toAbsY = toNS === 'S' ? -toY - 1 : toY;
    
    var dx = toAbsX - fromAbsX;
    var dy = toAbsY - fromAbsY;
    
    if (dx === 1) return 'E';
    if (dx === -1) return 'W';
    if (dy === 1) return 'N';
    if (dy === -1) return 'S';
    
    return null;
}

function finalizeOperation(op, opKey) {
    var scanData = op.scanData;
    
    console.log('[TowerDrain] Finalizing operation ' + opKey);
    
    var routeBlocked = false;
    var blockedRoom = null;
    for (var i = 1; i < op.route.length; i++) {
        var rn = op.route[i];
        if (rn === op.targetRoom) continue;
        
        if (scanData.routePassability[rn] === false) {
            routeBlocked = true;
            blockedRoom = rn;
            break;
        }
    }
    
    if (routeBlocked) {
        console.log('[TowerDrain] Route blocked at ' + blockedRoom + ' - attempting final reroute');
        var rerouteSuccess = tryReroute(op, opKey);
        if (!rerouteSuccess) {
            console.log('[TowerDrain] Final reroute failed - trying cross-sector routing');
            convertToCrossSector(op, opKey);
            return;
        }
        return;
    }
    
    if (op.preferredEdge) {
        op.entryEdge = op.preferredEdge;
        console.log('[TowerDrain] Using preferred entry edge: ' + op.entryEdge);
    } else {
        op.entryEdge = getEntryEdge(op.safeRoom, op.targetRoom);
    }
    
    if (!op.entryEdge) {
        console.log('[TowerDrain] FAILED: Could not determine entry edge');
        op.status = 'failed';
        op.failReason = 'no_entry_edge';
        return;
    }
    
    console.log('[TowerDrain] Entry edge determined: ' + op.entryEdge);
    
    if (!scanData.targetEdges) {
        console.log('[TowerDrain] FAILED: Missing target room edge data');
        op.status = 'failed';
        op.failReason = 'missing_target_edge_data';
        return;
    }
    
    if (!scanData.safeEdges) {
        console.log('[TowerDrain] FAILED: Missing safe room edge data');
        op.status = 'failed';
        op.failReason = 'missing_safe_edge_data';
        return;
    }
    
    var success = computeLanes(op);
    if (!success) {
        console.log('[TowerDrain] FAILED: Could not compute valid lanes');
        op.status = 'failed';
        op.failReason = 'no_valid_lanes';
        return;
    }
    
    op.status = 'ready';
    console.log('[TowerDrain] ✓ Operation ' + opKey + ' is READY');
    console.log('[TowerDrain] Route: ' + op.route.join(' -> '));
    console.log('[TowerDrain] ' + Object.keys(op.lanes).length + ' lanes computed');
}

function updateOperations() {
    var ops = Memory.towerDrainOps.operations;
    
    for (var opKey in ops) {
        var op = ops[opKey];
        
        if (op.creeps) {
            var liveCreeps = [];
            for (var i = 0; i < op.creeps.length; i++) {
                var name = op.creeps[i];
                if (Game.creeps[name] || isCreepSpawning(name)) {
                    liveCreeps.push(name);
                }
            }
            op.creeps = liveCreeps;
        }
        
        if (op.status === 'ready' && op.creeps && op.creeps.length > 0) {
            op.status = 'active';
            console.log('[TowerDrain] Operation ' + opKey + ' is now ACTIVE');
        }
    }
}

function isCreepSpawning(creepName) {
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        var spawns = room.find(FIND_MY_SPAWNS);
        for (var i = 0; i < spawns.length; i++) {
            if (spawns[i].spawning && spawns[i].spawning.name === creepName) {
                return true;
            }
        }
    }
    return false;
}

// ========== CREEP BEHAVIOR ==========
// ==========================================================================
// PERFORMANCE OPTIMIZATION NOTES:
// The original code used PathFinder.search for EVERY movement, including
// the 1-tile bounce moves between the 4 lane positions. Each PathFinder
// call rebuilds cost matrices from room.find() results (~0.5-1 CPU each).
// With 4 drainers, that's 2-4 CPU/tick just for movement.
//
// Optimizations applied:
// 1. simpleMoveToPos() - direct creep.move(direction) for 1-tile bounce
//    moves. No PathFinder, no room.find(), ~0.001 CPU per call.
// 2. followRoomRoute() - cached path with 5-tick reuse. PathFinder only
//    runs once every 5 ticks or on room change.
// 3. moveToPosition() - uses cached cost matrices when PathFinder IS
//    needed (initial travel only).
// 4. Per-tick find cache - room.find() results shared across all creeps.
// ==========================================================================

var roleTowerDrain = {
    run: function(creep) {
        // Validate pre-planned data exists
        if (!creep.memory.route || !creep.memory.laneSet) {
            if (creep.name.indexOf('TowerDrain_') === 0) {
                if (Game.time % 100 === 0) {
                    console.log('[TowerDrain] WARNING: ' + creep.name + ' missing lane data. May be legacy creep.');
                }
                return;
            }
            console.log('[TowerDrain] ' + creep.name + ' missing cached data, suiciding');
            creep.suicide();
            return;
        }
        
        if (!creep.memory.state) {
            creep.memory.state = 'traveling';
        }
        
        if (creep.ticksToLive < 50) {
            creep.memory.state = 'returningHome';
        }
        
        // Always self-heal when damaged
        if (creep.hits < creep.hitsMax) {
            creep.heal(creep);
        }
        
        switch (creep.memory.state) {
            case 'traveling':
                this.stateTraveling(creep);
                break;
            case 'draining':
                this.stateDraining(creep);
                break;
            case 'retreating':
                this.stateRetreating(creep);
                break;
            case 'healing':
                this.stateHealing(creep);
                break;
            case 'returningHome':
                this.stateReturningHome(creep);
                break;
            default:
                creep.memory.state = 'traveling';
                break;
        }
    },
    
    // ======================================================================
    // SIMPLE 1-TILE MOVE: Used for bounce-cycle movement between the 4
    // known lane positions. Only works when adjacent (1 tile) or crossing
    // a room border. Falls back to moveToPosition if not adjacent.
    // Cost: ~0.001 CPU when adjacent vs ~0.5 CPU for PathFinder fallback
    // ======================================================================
    simpleMoveToPos: function(creep, pos) {
        if (!pos) return ERR_INVALID_ARGS;
        var targetPos = new RoomPosition(pos.x, pos.y, pos.roomName);
        if (creep.pos.isEqualTo(targetPos)) return OK;
        
        // If adjacent (including cross-room edge tiles), direct move works
        if (creep.pos.isNearTo(targetPos)) {
            return creep.move(creep.pos.getDirectionTo(targetPos));
        }
        
        // Not adjacent - need pathfinding (creep not on a lane position yet)
        this.moveToPosition(creep, pos);
        return OK;
    },
    
    // ======================================================================
    // CACHED ROUTE FOLLOWING: Path is computed once and reused for 5 ticks.
    // Recomputes on room change or when path is stale.
    // Cost: ~0.002 CPU on cache hit vs ~0.5-1.0 CPU for PathFinder.search
    // ======================================================================
    followRoomRoute: function(creep, forward) {
        var route = forward ? creep.memory.route : creep.memory.routeBack;
        if (!route || route.length === 0) return ERR_NOT_FOUND;
        
        var currentRoom = creep.room.name;
        var goalRoom = forward ? creep.memory.targetRoom : creep.memory.homeRoom;
        
        if (currentRoom === goalRoom) return OK;
        
        // Build allowed rooms set
        var allowedRooms = {};
        for (var r = 0; r < route.length; r++) {
            allowedRooms[route[r]] = true;
        }
        
        if (!allowedRooms[currentRoom]) {
            console.log('[TowerDrain] WARNING: ' + creep.name + ' in unauthorized room ' + currentRoom + '! Moving to center.');
            creep.moveTo(25, 25);
            return ERR_NOT_FOUND;
        }
        
        // Find current position in route
        var idx = route.indexOf(currentRoom);
        if (idx === -1) idx = 0;
        
        var nextIdx = idx + 1;
        if (nextIdx >= route.length) return OK;
        
        var nextRoom = route[nextIdx];
        
        // Find exit direction to next room
        var exitDir = Game.map.findExit(currentRoom, nextRoom);
        if (exitDir < 0) return ERR_NO_PATH;
        
        // === PATH CACHING ===
        // Reuse cached path if: same room, same target, not expired
        var pathCache = creep.memory._pathCache;
        var cacheValid = pathCache &&
                         pathCache.room === currentRoom &&
                         pathCache.nextRoom === nextRoom &&
                         pathCache.tick > Game.time - 5 &&  // 5-tick TTL
                         pathCache.path && pathCache.path.length > 0;
        
        var path;
        if (cacheValid) {
            path = pathCache.path;
        } else {
            // Compute new path
            var exits = creep.room.find(exitDir);
            if (exits.length === 0) return ERR_NO_PATH;
            
            var goals = [];
            for (var g = 0; g < exits.length; g++) {
                goals.push({ pos: exits[g], range: 0 });
            }
            
            var result = PathFinder.search(creep.pos, goals, {
                maxRooms: 1,
                maxOps: 2000,
                plainCost: 2,
                swampCost: 10,
                roomCallback: function(roomName) {
                    if (roomName !== currentRoom) return false;
                    var room = Game.rooms[roomName];
                    if (!room) return false;
                    return getCachedCostMatrixWithCreeps(room, creep.id);
                }
            });
            
            if (result.incomplete || result.path.length === 0) {
                var closestExit = creep.pos.findClosestByRange(exitDir);
                if (closestExit) {
                    creep.moveTo(closestExit, { maxRooms: 1, reusePath: 0 });
                }
                return ERR_NO_PATH;
            }
            
            path = result.path;
            
            // Cache the path (serialize positions for Memory storage)
            var serializedPath = [];
            for (var sp = 0; sp < path.length; sp++) {
                serializedPath.push({
                    x: path[sp].x,
                    y: path[sp].y,
                    roomName: path[sp].roomName
                });
            }
            creep.memory._pathCache = {
                room: currentRoom,
                nextRoom: nextRoom,
                tick: Game.time,
                path: serializedPath
            };
        }
        
        // Follow the cached path
        var moveResult = creep.moveByPath(path);
        if (moveResult !== OK && moveResult !== ERR_TIRED) {
            // Invalidate cache and try direct move
            delete creep.memory._pathCache;
            if (path[0]) {
                var pos = new RoomPosition(path[0].x, path[0].y, path[0].roomName);
                var dir = creep.pos.getDirectionTo(pos);
                creep.move(dir);
            }
        }
        
        return OK;
    },
    
    // ======================================================================
    // FULL PATHFINDER MOVE: Only used during initial travel to the bounce
    // zone (before the creep reaches its lane positions). Uses cached cost
    // matrices to reduce CPU even when PathFinder is needed.
    // ======================================================================
    moveToPosition: function(creep, pos, color) {
        if (!pos) return;
        
        var targetPos = new RoomPosition(pos.x, pos.y, pos.roomName);
        
        if (creep.pos.isEqualTo(targetPos)) return;
        
        // If adjacent (1 tile away, same room), just move directly - no PathFinder needed
        if (creep.pos.roomName === targetPos.roomName && creep.pos.getRangeTo(targetPos) === 1) {
            creep.move(creep.pos.getDirectionTo(targetPos));
            return;
        }
        
        var safeRoom = creep.memory.safeRoom;
        var targetRoom = creep.memory.targetRoom;
        var currentRoom = creep.room.name;
        
        var allowedRooms = {};
        allowedRooms[safeRoom] = true;
        allowedRooms[targetRoom] = true;
        
        if (!allowedRooms[currentRoom]) {
            console.log('[TowerDrain] WARNING: ' + creep.name + ' in wrong room ' + currentRoom + ' during bounce!');
            return;
        }
        
        var creepId = creep.id;
        
        var result = PathFinder.search(creep.pos, { pos: targetPos, range: 0 }, {
            maxRooms: 2,
            maxOps: 2000,
            plainCost: 2,
            swampCost: 10,
            roomCallback: function(roomName) {
                if (!allowedRooms[roomName]) return false;
                var room = Game.rooms[roomName];
                if (!room) return false;
                return getCachedCostMatrixWithCreeps(room, creepId);
            }
        });
        
        if (result.incomplete || result.path.length === 0) {
            creep.moveTo(targetPos, { maxRooms: 1, reusePath: 0 });
            return;
        }
        
        var moveResult = creep.moveByPath(result.path);
        if (moveResult !== OK && moveResult !== ERR_TIRED) {
            if (result.path[0]) {
                var dir = creep.pos.getDirectionTo(result.path[0]);
                creep.move(dir);
            }
        }
    },
    
    /**
     * Traveling state: Get to the drain position via the 4-tile lane
     */
    stateTraveling: function(creep) {
        var targetRoom = creep.memory.targetRoom;
        var safeRoom = creep.memory.safeRoom;
        
        // Not in safe room or target room yet - follow route
        if (creep.room.name !== safeRoom && creep.room.name !== targetRoom) {
            this.followRoomRoute(creep, true);
            creep.say('🚶');
            return;
        }
        
        // In safe room - move towards edge (simple 1-tile move)
        if (creep.room.name === safeRoom) {
            var healEdgePos = creep.memory.healEdgePos;
            if (healEdgePos) {
                // If at heal rest pos, simple move to edge; if at edge, will cross room
                this.simpleMoveToPos(creep, healEdgePos);
                creep.say('➡️');
            } else {
                this.followRoomRoute(creep, true);
                creep.say('🚶');
            }
            return;
        }
        
        // In target room - go to drain position
        var drainPos = creep.memory.drainPos;
        if (!drainPos) {
            console.log('[TowerDrain] ' + creep.name + ' missing drainPos');
            creep.suicide();
            return;
        }
        
        var targetPos = new RoomPosition(drainPos.x, drainPos.y, drainPos.roomName);
        if (creep.pos.isEqualTo(targetPos)) {
            creep.memory.state = 'draining';
            creep.say('😈');
        } else {
            // Should be 1 tile from edge - simple move
            this.simpleMoveToPos(creep, drainPos);
            creep.say('🎯');
        }
    },
    
    stateDraining: function(creep) {
        if (creep.hits < creep.hitsMax) {
            creep.memory.state = 'retreating';
            creep.say('🏃');
            return;
        }
        
        // Stay at drain position - only move if somehow displaced
        var drainPos = creep.memory.drainPos;
        if (!drainPos) {
            creep.memory.state = 'traveling';
            return;
        }
        
        var targetPos = new RoomPosition(drainPos.x, drainPos.y, drainPos.roomName);
        if (!creep.pos.isEqualTo(targetPos)) {
            this.simpleMoveToPos(creep, drainPos);
        }
        
        creep.say('😈');
    },
    
    stateRetreating: function(creep) {
        var healPos = creep.memory.healPos;
        var attackEdgePos = creep.memory.attackEdgePos;
        var targetRoom = creep.memory.targetRoom;
        var safeRoom = creep.memory.safeRoom;
        
        if (!healPos) {
            creep.memory.state = 'traveling';
            return;
        }
        
        // In target room - move to attack edge (1 tile), will cross to safe room
        if (creep.room.name === targetRoom) {
            if (attackEdgePos) {
                this.simpleMoveToPos(creep, attackEdgePos);
            } else {
                this.simpleMoveToPos(creep, healPos);
            }
            creep.say('🏃');
            return;
        }
        
        // In safe room - move to heal position (1 tile from edge)
        if (creep.room.name === safeRoom) {
            var targetPos = new RoomPosition(healPos.x, healPos.y, healPos.roomName);
            
            if (creep.pos.isEqualTo(targetPos)) {
                creep.memory.state = 'healing';
                return;
            }
            
            this.simpleMoveToPos(creep, healPos);
            creep.say('🏃');
            return;
        }
        
        // In some other room (shouldn't happen)
        this.simpleMoveToPos(creep, healPos);
        creep.say('🏃');
    },
    
    stateHealing: function(creep) {
        if (creep.hits === creep.hitsMax) {
            creep.memory.state = 'traveling';
            return;
        }
        
        // Stay at heal position - only move if somehow displaced
        var healPos = creep.memory.healPos;
        if (healPos) {
            var targetPos = new RoomPosition(healPos.x, healPos.y, healPos.roomName);
            if (!creep.pos.isEqualTo(targetPos)) {
                this.simpleMoveToPos(creep, healPos);
            }
        }
        
        creep.say('❤️');
    },
    
    stateReturningHome: function(creep) {
        var homeRoom = creep.memory.homeRoom;
        
        if (homeRoom && creep.room.name !== homeRoom) {
            this.followRoomRoute(creep, false);
        }
        
        creep.say('🏠');
    }
};

// ========== PROGRESS TRACKING ==========

function trackProgress(creep) {
    var SCAN_INTERVAL = 1000;
    var EMAIL_INTERVAL = 15000;
    var HISTORY_LIMIT = 15;
    
    var homeRoom = creep.memory.homeRoom;
    var targetRoom = creep.memory.targetRoom;
    if (!homeRoom || !targetRoom) return;
    
    var opKey = homeRoom + '->' + targetRoom;
    
    if (!isOpLeader(creep, opKey)) return;
    
    if (!Memory.towerDrainProgress) Memory.towerDrainProgress = {};
    var opProg = Memory.towerDrainProgress[opKey];
    if (!opProg) {
        opProg = { lastScanTick: 0, lastEmailTick: 0, history: [] };
        Memory.towerDrainProgress[opKey] = opProg;
    }
    
    if (Game.time - opProg.lastScanTick >= SCAN_INTERVAL) {
        var energy = readTargetEnergy(targetRoom);
        if (energy !== null) {
            var drainerCount = getDrainerCountForOp(opKey);
            var history = opProg.history;
            var sample = { tick: Game.time, energy: energy, drainerCount: drainerCount };
            
            var prev = history.length > 0 ? history[history.length - 1] : null;
            if (prev) {
                var deltaTicks = Game.time - prev.tick;
                if (deltaTicks < 1) deltaTicks = 1;
                var deltaEnergy = prev.energy - energy;
                var per1kTotal = (deltaEnergy * 1000) / deltaTicks;
                var per1kPerDrainer = drainerCount > 0 ? per1kTotal / drainerCount : 0;
                sample.per1kTotal = per1kTotal;
                sample.per1kPerDrainer = per1kPerDrainer;
                
                console.log(
                    '[TowerDrain ' + opKey + '] energy=' + energy +
                    ' | drain/1k=' + per1kTotal.toFixed(1) +
                    ' | per drainer=' + per1kPerDrainer.toFixed(1) +
                    ' | count=' + drainerCount
                );
            } else {
                console.log('[TowerDrain ' + opKey + '] initial: energy=' + energy + ' | count=' + drainerCount);
            }
            
            history.push(sample);
            if (history.length > HISTORY_LIMIT) history.shift();
            opProg.lastScanTick = Game.time;
        }
    }
    
    if (Game.time - opProg.lastEmailTick >= EMAIL_INTERVAL) {
        var hist = opProg.history;
        if (hist.length >= 2) {
            var sum = 0;
            var count = 0;
            for (var i = 0; i < hist.length; i++) {
                if (typeof hist[i].per1kTotal === 'number') {
                    sum += hist[i].per1kTotal;
                    count++;
                }
            }
            if (count > 0) {
                var avgPer1kTotal = sum / count;
                var latest = hist[hist.length - 1];
                var energyNow = latest.energy;
                var perTickTotal = avgPer1kTotal / 1000;
                var etaTicks = perTickTotal > 0 ? Math.floor(energyNow / perTickTotal) : null;
                
                var etaString = 'ETA: unknown';
                if (etaTicks && isFinite(etaTicks) && etaTicks > 0) {
                    var totalSec = etaTicks * 3;
                    var days = Math.floor(totalSec / 86400);
                    var rem = totalSec % 86400;
                    var hours = Math.floor(rem / 3600);
                    var minutes = Math.floor((rem % 3600) / 60);
                    etaString = 'ETA: ' + days + 'd ' + hours + 'h ' + minutes + 'm';
                }
                
                var msg =
                    '[TowerDrain ' + opKey + ']\n' +
                    'Energy: ' + energyNow + '\n' +
                    'Drainers: ' + latest.drainerCount + '\n' +
                    'Avg drain: ' + avgPer1kTotal.toFixed(1) + ' per 1k ticks\n' +
                    etaString;
                
                Game.notify(msg);
                opProg.lastEmailTick = Game.time;
            }
        }
    }
}

function isOpLeader(creep, opKey) {
    var op = Memory.towerDrainOps.operations[opKey];
    if (!op || !op.creeps || op.creeps.length === 0) return true;
    
    var liveCreeps = [];
    for (var i = 0; i < op.creeps.length; i++) {
        if (Game.creeps[op.creeps[i]]) {
            liveCreeps.push(op.creeps[i]);
        }
    }
    
    if (liveCreeps.length === 0) return true;
    liveCreeps.sort();
    return creep.name === liveCreeps[0];
}

function getDrainerCountForOp(opKey) {
    var op = Memory.towerDrainOps.operations[opKey];
    if (!op || !op.creeps) return 0;
    
    var count = 0;
    for (var i = 0; i < op.creeps.length; i++) {
        if (Game.creeps[op.creeps[i]]) count++;
    }
    return count;
}

function readTargetEnergy(targetRoom) {
    var room = Game.rooms[targetRoom];
    if (!room) return null;
    
    if (room.storage) {
        return room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
    }
    
    var containers = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; }
    });
    
    var best = -1;
    for (var i = 0; i < containers.length; i++) {
        var amt = containers[i].store.getUsedCapacity(RESOURCE_ENERGY);
        if (amt > best) best = amt;
    }
    
    return best > 0 ? best : null;
}

// ========== EXPORTS ==========

function getCreepMemoryForLane(homeRoom, targetRoom, laneNumber) {
    initMemory();
    
    var opKey = homeRoom + '->' + targetRoom;
    var op = Memory.towerDrainOps.operations[opKey];
    
    if (!op) {
        console.log('[TowerDrain] getCreepMemoryForLane: Operation ' + opKey + ' not found');
        return null;
    }
    
    if (op.status !== 'ready' && op.status !== 'active') {
        console.log('[TowerDrain] getCreepMemoryForLane: Operation ' + opKey + ' not ready (status: ' + op.status + ')');
        return null;
    }
    
    var lane = op.lanes[String(laneNumber)];
    if (!lane) {
        console.log('[TowerDrain] getCreepMemoryForLane: Lane ' + laneNumber + ' not found');
        return null;
    }
    
    return {
        role: 'towerDrain',
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        safeRoom: op.safeRoom,
        route: op.route,
        routeBack: op.routeBack,
        laneSet: laneNumber,
        drainPos: lane.drainPos,
        healPos: lane.healPos,
        attackEdgePos: lane.attackEdgePos,
        healEdgePos: lane.healEdgePos,
        attackRestPos: lane.attackRestPos,
        healRestPos: lane.healRestPos,
        state: 'traveling'
    };
}

function registerSpawnedCreep(homeRoom, targetRoom, creepName) {
    initMemory();
    
    var opKey = homeRoom + '->' + targetRoom;
    var op = Memory.towerDrainOps.operations[opKey];
    
    if (!op) {
        console.log('[TowerDrain] Cannot register ' + creepName + ' - operation ' + opKey + ' not found');
        return false;
    }
    
    if (!op.creeps) op.creeps = [];
    
    if (op.creeps.indexOf(creepName) === -1) {
        op.creeps.push(creepName);
        console.log('[TowerDrain] Registered ' + creepName + ' with operation ' + opKey);
    }
    
    return true;
}

function clearFailedTowerDrains() {
    initMemory();
    
    var ops = Memory.towerDrainOps.operations;
    var cleared = [];
    
    for (var opKey in ops) {
        if (ops[opKey].status === 'failed') {
            cleared.push(opKey);
            delete ops[opKey];
        }
    }
    
    if (cleared.length > 0) {
        console.log('[TowerDrain] Cleared ' + cleared.length + ' failed operation(s): ' + cleared.join(', '));
    } else {
        console.log('[TowerDrain] No failed operations to clear');
    }
    
    return cleared.length;
}

// Global console commands
global.orderTowerDrain = orderTowerDrain;
global.cancelTowerDrainOrder = cancelTowerDrainOrder;
global.getTowerDrainStatus = getTowerDrainStatus;
global.clearFailedTowerDrains = clearFailedTowerDrains;
global.getCreepMemoryForLane = getCreepMemoryForLane;

global.debugTowerDrainRoute = function(fromRoom, toRoom, avoidRoom) {
    console.log('[TowerDrain Debug] Testing route from ' + fromRoom + ' to ' + toRoom + (avoidRoom ? ' avoiding ' + avoidRoom : ''));
    
    var blockedRooms = [];
    var routeResult = Game.map.findRoute(fromRoom, toRoom, {
        routeCallback: function(roomName) {
            if (avoidRoom && roomName === avoidRoom) {
                blockedRooms.push(roomName + '(avoided)');
                return Infinity;
            }
            var cost = getRoomRouteCost(roomName, null);
            if (cost === Infinity) {
                blockedRooms.push(roomName + '(cost)');
            } else if (cost > 1) {
                console.log('[TowerDrain Debug] Room ' + roomName + ' has cost ' + cost);
            }
            return cost;
        }
    });
    
    console.log('[TowerDrain Debug] findRoute returned: ' + typeof routeResult + ' = ' + JSON.stringify(routeResult));
    
    if (blockedRooms.length > 0) {
        console.log('[TowerDrain Debug] Rooms returning Infinity: ' + blockedRooms.join(', '));
    }
    
    if (!routeResult || routeResult === ERR_NO_PATH) {
        console.log('[TowerDrain Debug] No path found');
        return null;
    }
    
    if (routeResult.length === 0) {
        console.log('[TowerDrain Debug] Empty route returned (rooms might be adjacent)');
        return [fromRoom, toRoom];
    }
    
    var route = [fromRoom];
    for (var i = 0; i < routeResult.length; i++) {
        route.push(routeResult[i].room);
    }
    
    console.log('[TowerDrain Debug] Route: ' + route.join(' -> '));
    return route;
};

global.debugTowerDrainSector = function(room1, room2) {
    console.log('[TowerDrain Debug] Room 1: ' + room1 + ' -> Sector: ' + getSectorName(room1));
    console.log('[TowerDrain Debug] Room 2: ' + room2 + ' -> Sector: ' + getSectorName(room2));
    console.log('[TowerDrain Debug] Same sector: ' + areInSameSector(room1, room2));
};

global.debugTowerDrainBFS = function(safeRoom, targetRoom) {
    console.log('[TowerDrain Debug] BFS from ' + safeRoom + ' (excluding ' + targetRoom + ')');
    var paths = bfsFindHighwayPaths(safeRoom, targetRoom, MAX_CROSS_SECTOR_ROUTES);
    console.log('[TowerDrain Debug] Found ' + paths.length + ' paths:');
    for (var i = 0; i < paths.length; i++) {
        var pathStr = '';
        for (var j = 0; j < paths[i].length; j++) {
            var node = paths[i][j];
            if (j > 0) pathStr += ' -> ';
            pathStr += node.room;
            if (node.entryDir || node.exitDir) {
                pathStr += '(' + (node.entryDir || '?') + '>' + (node.exitDir || '?') + ')';
            }
        }
        console.log('[TowerDrain Debug]   ' + (i + 1) + ': ' + pathStr);
    }
    return paths;
};

// Main run function
function run() {
    initMemory();
    
    runScanner();
    updateOperations();
    
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (creep.memory.role === 'towerDrain') {
            roleTowerDrain.run(creep);
            trackProgress(creep);
        }
    }
}

module.exports = {
    run: run,
    orderTowerDrain: orderTowerDrain,
    cancelTowerDrainOrder: cancelTowerDrainOrder,
    getTowerDrainStatus: getTowerDrainStatus,
    clearFailedTowerDrains: clearFailedTowerDrains,
    registerSpawnedCreep: registerSpawnedCreep,
    getCreepMemoryForLane: getCreepMemoryForLane,
    areInSameSector: areInSameSector,
    getSectorName: getSectorName,
    bfsFindHighwayPaths: bfsFindHighwayPaths
};