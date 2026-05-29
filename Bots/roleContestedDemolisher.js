// roleContestedDemolisher.js
// ============================================================================
// ROLE: Contested Demolisher (Pair)
//
// USAGE (Console):
// orderContestedDemolisher('E4N49', 'E4N51')
// orderContestedDemolisher('E4N49', 'E4N51', 'towers')    // towers only
// orderContestedDemolisher('E4N49', 'E4N51', 'military')   // towers, nuker, power spawn, labs
// orderContestedDemolisher('E4N49', 'E4N51', true)          // legacy: same as 'towers'
// cancelContestedDemolisherOrder('E4N51')
// getContestedDemolisherStatus()
// resetContestedDemolisherOrder('E5N52')
// testContestedDemolisher('E4N49', 'E4N51')
// testContestedDemolisher('E4N49', 'E4N51', 'towers')
// testContestedDemolisher('E4N49', 'E4N51', 'military')
// testContestedDemolisherRoutes('PlayerName')
// testContestedDemolisherRoutes('PlayerName', 'E4N49')
// testContestedDemolisherRoutes('PlayerName', 'E4N49', 'towers')
// testContestedDemolisherRoutesSetTargets(['W1N46', 'W2N43'])
// testContestedDemolisherRoutesStatus()
// testContestedDemolisherRoutesCancel()
//
// TARGET MODES:
// - 'all'      (default) – all hostile structures except roads/containers/controllers
// - 'towers'   – towers only
// - 'military' – towers, nuker, power spawn, labs (in that priority order)
//
// IMPORTANT:
// - Spawning is handled by spawnManager.js (manageContestedDemolisherSpawns).
// - This file MUST write orders into Memory.contestedDemolisherOrders
//   using the schema spawnManager expects: an ARRAY of { homeRoom, targetRoom, squadId }.
// - Orders start in 'scanning' status and transition to 'ready' after route verification.
//
// CROSS-SECTOR ROUTING:
// - When origin and target are in different 10x10 sectors, uses BFS to find
//   paths through highway rooms (X or Y coordinate ends in 0).
// - Scans each room in candidate paths to verify safety and passability.
// - Selects the route with shortest total path length.
// ============================================================================

// ========== CONSTANTS ==========

var OBSERVER_RANGE = 10;
var MAX_CROSS_SECTOR_ROUTES = 16;
var CROSS_SECTOR_PROGRESS_INTERVAL = 10;

/**
 * Military structure types in priority order.
 * Towers first (highest threat), then nuker, power spawn, labs.
 */
var MILITARY_STRUCTURE_PRIORITY = [
    STRUCTURE_TOWER,
    STRUCTURE_NUKER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_LAB
];

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
    
    // Must be in same quadrant (E/W and N/S must match)
    if (we1 !== we2 || ns1 !== ns2) return false;
    
    // Check if same 10x10 block (same tens digit)
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
 * @param {string} roomName - Room to evaluate
 * @param {object} blockedRooms - Set of rooms to avoid (or null)
 * @param {string} targetRoom - The final destination (always allowed even if hostile)
 */
function getRoomRouteCost(roomName, blockedRooms, targetRoom) {
    // The target room is ALWAYS allowed - that's the hostile room we're attacking!
    if (targetRoom && roomName === targetRoom) {
        return 1;
    }
    
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
        
        // Hostile-owned rooms are NOT allowed as transit (but target room already handled above)
        if (room.controller.owner) {
            var owner = room.controller.owner.username;
            if (iff.isFriendlyUsername(owner)) {
                return 1;
            } else {
                return Infinity; // Can't transit through hostile owned rooms
            }
        }
        
        if (room.controller.reservation) {
            var reserver = room.controller.reservation.username;
            if (iff.isFriendlyUsername(reserver)) {
                return 1;
            } else {
                return 3; // Reserved by hostile - avoid but not impossible
            }
        }
    }
    
    if (Memory.roomIntel && Memory.roomIntel[roomName]) {
        var intel = Memory.roomIntel[roomName];
        if (intel.owner) {
            if (iff.isFriendlyUsername(intel.owner)) {
                return 1;
            } else {
                return Infinity; // Can't transit through hostile owned rooms
            }
        }
    }
    
    return 1.5;
}

// ========== OBSERVER MANAGEMENT ==========

/**
 * Find the best observer for scanning a target room.
 */
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

/**
 * Get all available observers
 */
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

/**
 * Check if any observer can reach a room
 */
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

/**
 * Check if we own a room
 */
function isMyRoom(roomName) {
    var room = Game.rooms[roomName];
    if (!room) return false;
    if (!room.controller) return false;
    return room.controller.my;
}

/**
 * Check if a TRANSIT room is safe to traverse.
 * NOTE: This is only called for rooms BETWEEN home and target.
 * The TARGET room itself is expected to be hostile and skips this check.
 * 
 * Transit rooms must be:
 * - Not owned by hostiles
 * - Not have hostile towers
 */
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

// ========== PASSABILITY ANALYSIS ==========

/**
 * Build a cost matrix for pathfinding
 */
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

/**
 * Check if a room is passable from one edge to another.
 */
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

/**
 * Analyze a room's edges for walkability (for blocked exit detection)
 */
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
    
    // North edge (y=0)
    for (var x = 1; x <= 48; x++) {
        if (isWalkable(x, 0)) {
            edges.N.walkableTiles.push(x);
            edges.N.totalWalkable++;
        }
    }
    
    // South edge (y=49)
    for (var x = 1; x <= 48; x++) {
        if (isWalkable(x, 49)) {
            edges.S.walkableTiles.push(x);
            edges.S.totalWalkable++;
        }
    }
    
    // East edge (x=49)
    for (var y = 1; y <= 48; y++) {
        if (isWalkable(49, y)) {
            edges.E.walkableTiles.push(y);
            edges.E.totalWalkable++;
        }
    }
    
    // West edge (x=0)
    for (var y = 1; y <= 48; y++) {
        if (isWalkable(0, y)) {
            edges.W.walkableTiles.push(y);
            edges.W.totalWalkable++;
        }
    }
    
    return edges;
}

/**
 * Analyze how much open ground exists between an edge and the nearest
 * defensive structures (walls/ramparts). Higher = more room to manoeuvre.
 * Returns { N: tiles, S: tiles, E: tiles, W: tiles }
 */
function analyzeApproachDepth(room) {
    if (!room) return null;

    var structures = room.find(FIND_STRUCTURES, {
        filter: function(s) {
            return s.structureType === STRUCTURE_WALL ||
                   (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic);
        }
    });

    if (structures.length === 0) {
        return { N: 50, S: 50, E: 50, W: 50 };
    }

    // For each edge, find the minimum distance from that edge to any barrier
    var minDist = { N: 50, S: 50, E: 50, W: 50 };

    for (var i = 0; i < structures.length; i++) {
        var pos = structures[i].pos;
        // Distance from north edge (y=0)
        if (pos.y < minDist.N) minDist.N = pos.y;
        // Distance from south edge (y=49)
        if ((49 - pos.y) < minDist.S) minDist.S = 49 - pos.y;
        // Distance from west edge (x=0)
        if (pos.x < minDist.W) minDist.W = pos.x;
        // Distance from east edge (x=49)
        if ((49 - pos.x) < minDist.E) minDist.E = 49 - pos.x;
    }

    return minDist;
}

/**
 * Get the opposite edge
 */
function getOppositeEdge(edge) {
    var map = { N: 'S', S: 'N', E: 'W', W: 'E' };
    return map[edge] || null;
}

/**
 * Get the room name adjacent to a room in a given direction
 */
function getAdjacentRoom(roomName, direction) {
    var parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!parsed) return null;
    
    var we = parsed[1];
    var x = parseInt(parsed[2], 10);
    var ns = parsed[3];
    var y = parseInt(parsed[4], 10);
    
    switch (direction) {
        case 'N':
            if (ns === 'N') { y++; }
            else { y--; if (y < 0) { ns = 'N'; y = 0; } }
            break;
        case 'S':
            if (ns === 'S') { y++; }
            else { y--; if (y < 0) { ns = 'S'; y = 0; } }
            break;
        case 'E':
            if (we === 'E') { x++; }
            else { x--; if (x < 0) { we = 'E'; x = 0; } }
            break;
        case 'W':
            if (we === 'W') { x++; }
            else { x--; if (x < 0) { we = 'W'; x = 0; } }
            break;
        default:
            return null;
    }
    
    return we + x + ns + y;
}

/**
 * Get the direction of an exit to reach a target room
 */
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

// ========== CROSS-SECTOR BFS ROUTING ==========

/**
 * Get all neighbors of a room that have actual exits (using Game.map.describeExits)
 * Returns array of { room: roomName, direction: 'N'|'S'|'E'|'W' }
 */
function getRoomNeighbors(roomName) {
    var neighbors = [];
    var exits = Game.map.describeExits(roomName);
    
    if (!exits) return neighbors;
    
    // exits is { '1': roomName, '3': roomName, '5': roomName, '7': roomName }
    // 1=TOP(N), 3=RIGHT(E), 5=BOTTOM(S), 7=LEFT(W)
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

/**
 * BFS from a starting room to find paths to highway rooms.
 * Respects observer range - only explores rooms that can be scanned.
 * 
 * @param {string} startRoom - Starting room for BFS
 * @param {string} targetRoom - Room to exclude from search (the hostile target)
 * @param {number} maxRoutes - Maximum number of routes to find
 * @returns {Array} Array of paths, each path is [{ room, entryDir, exitDir }, ...]
 */
function bfsFindHighwayPaths(startRoom, targetRoom, maxRoutes) {
    maxRoutes = maxRoutes || MAX_CROSS_SECTOR_ROUTES;
    
    var paths = [];
    var visited = {};
    var queue = [];
    
    // Start with start room
    queue.push({ 
        room: startRoom, 
        path: [{ room: startRoom, entryDir: null, exitDir: null }]
    });
    visited[startRoom] = true;
    visited[targetRoom] = true; // Exclude target room from BFS
    
    while (queue.length > 0 && paths.length < maxRoutes) {
        var current = queue.shift();
        var currentRoom = current.room;
        var currentPath = current.path;
        
        // Get all neighbors (rooms with actual exits)
        var neighbors = getRoomNeighbors(currentRoom);
        
        for (var i = 0; i < neighbors.length; i++) {
            var neighborInfo = neighbors[i];
            var neighbor = neighborInfo.room;
            var exitDir = neighborInfo.direction;
            
            // Skip if already visited
            if (visited[neighbor]) continue;
            
            // Skip if no observer can reach this room
            if (!canAnyObserverReach(neighbor)) {
                continue;
            }
            
            // Mark as visited
            visited[neighbor] = true;
            
            // Update the exit direction of the current room in the path
            var newPath = [];
            for (var p = 0; p < currentPath.length; p++) {
                var pathNode = currentPath[p];
                if (p === currentPath.length - 1) {
                    // Last node - set its exit direction
                    newPath.push({ 
                        room: pathNode.room, 
                        entryDir: pathNode.entryDir, 
                        exitDir: exitDir 
                    });
                } else {
                    newPath.push(pathNode);
                }
            }
            
            // Add new room to path (entry is opposite of how we exited previous room)
            var entryDir = getOppositeEdge(exitDir);
            newPath.push({ room: neighbor, entryDir: entryDir, exitDir: null });
            
            // Check if this is a highway room
            if (isHighwayRoom(neighbor)) {
                paths.push(newPath);
                
                if (paths.length >= maxRoutes) {
                    break;
                }
            } else {
                // Not a highway, continue BFS
                queue.push({ room: neighbor, path: newPath });
            }
        }
    }
    
    console.log('[ContestedDemolisher] BFS found ' + paths.length + ' paths to highways from ' + startRoom);
    
    return paths;
}

/**
 * Deduplicate rooms across multiple paths
 */
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

/**
 * Extract room name from a path node
 */
function getPathNodeRoom(node) {
    return (typeof node === 'string') ? node : node.room;
}

/**
 * Calculate the total path length from origin to target via a highway entry point
 */
function calculateTotalPathLength(originRoom, highwayEntry, pathLengthFromHighway, targetRoom) {
    // Get route from origin to highway entry
    var routeToHighway = Game.map.findRoute(originRoom, highwayEntry, {
        routeCallback: function(roomName) {
            return getRoomRouteCost(roomName, null, targetRoom);
        }
    });
    
    if (!routeToHighway || routeToHighway === ERR_NO_PATH) {
        return Infinity;
    }
    
    // Total = route to highway + path from highway to target area
    return routeToHighway.length + pathLengthFromHighway;
}

/**
 * Select the best route from valid cross-sector paths.
 * Factors in approach depth when target room edge data is available.
 */
function selectBestCrossSectorRoute(originRoom, targetRoom, validPaths, approachDepth) {
    if (validPaths.length === 0) {
        return null;
    }
    
    var best = null;
    
    for (var i = 0; i < validPaths.length; i++) {
        var path = validPaths[i];
        var lastNode = path[path.length - 1];
        var highwayEntry = getPathNodeRoom(lastNode);
        var pathLengthFromHighway = path.length - 1;
        
        var totalLength = calculateTotalPathLength(originRoom, highwayEntry, pathLengthFromHighway, targetRoom);
        
        if (totalLength === Infinity) continue;
        
        // Determine which edge of the target room this path enters from.
        // The first node in the BFS path is a neighbor of the target room;
        // the direction from that neighbor INTO the target gives us the entry edge.
        var firstNode = path[0];
        var entryNeighbor = getPathNodeRoom(firstNode);
        var entryEdge = getExitDirection(entryNeighbor, targetRoom);
        // entryEdge is the direction from the neighbor TO the target, e.g. 'E' means
        // we enter the target from the west side (the neighbor is west of target and
        // goes east). The edge of the TARGET we enter is the OPPOSITE.
        var targetEntryEdge = entryEdge ? getOppositeEdge(entryEdge) : null;
        
        // Apply approach depth bonus: reduce effective length for sides with more
        // open ground. Each tile of depth is worth 0.5 rooms of savings (tunable).
        var depthBonus = 0;
        if (approachDepth && targetEntryEdge && approachDepth[targetEntryEdge] !== undefined) {
            depthBonus = approachDepth[targetEntryEdge] * 0.5;
        }
        
        var effectiveLength = totalLength - depthBonus;
        
        if (!best || effectiveLength < best.effectiveLength) {
            best = {
                path: path,
                highwayEntry: highwayEntry,
                totalLength: totalLength,
                effectiveLength: effectiveLength,
                entryEdge: targetEntryEdge
            };
        }
    }
    
    return best;
}

/**
 * Invalidate all paths that contain a specific room
 */
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
        console.log('[ContestedDemolisher] All candidate paths have been invalidated');
    }
}

/**
 * Invalidate paths that require a specific exit from a room that is blocked
 */
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
        console.log('[ContestedDemolisher] Invalidated ' + invalidatedCount + ' paths due to blocked exits at ' + roomName);
    }
    
    op.scanData.candidatePaths = stillValid;
}

// ========== ROUTE VALIDATION ==========

/**
 * Check if two rooms are directly adjacent (share an exit).
 * Diagonal rooms (differ in both X and Y) are NOT adjacent.
 */
function areRoomsAdjacent(roomA, roomB) {
    if (!roomA || !roomB) return false;
    if (roomA === roomB) return true;
    
    var exits = Game.map.describeExits(roomA);
    if (!exits) return false;
    
    for (var dir in exits) {
        if (exits[dir] === roomB) return true;
    }
    return false;
}

/**
 * Validate a route: every consecutive pair of rooms must be adjacent.
 * Returns { valid: true } or { valid: false, breakIndex: i } where
 * route[i] and route[i+1] are not adjacent.
 */
function validateRoute(route) {
    if (!route || route.length < 2) return { valid: true };
    
    for (var i = 0; i < route.length - 1; i++) {
        if (!areRoomsAdjacent(route[i], route[i + 1])) {
            return { valid: false, breakIndex: i, from: route[i], to: route[i + 1] };
        }
    }
    return { valid: true };
}

/**
 * Repair a broken route by filling gaps between non-adjacent rooms.
 * Uses findRoute to bridge each gap. Returns the repaired route, or null if
 * any gap cannot be bridged.
 */
function repairRoute(route, targetRoom) {
    if (!route || route.length < 2) return route;
    
    var repaired = [route[0]];
    
    for (var i = 0; i < route.length - 1; i++) {
        var from = route[i];
        var to = route[i + 1];
        
        if (areRoomsAdjacent(from, to)) {
            repaired.push(to);
        } else {
            // Bridge the gap
            console.log('[ContestedDemolisher] Repairing route gap: ' + from + ' -> ' + to);
            var bridgeTarget = targetRoom;
            var bridge = Game.map.findRoute(from, to, {
                routeCallback: function(roomName) {
                    return getRoomRouteCost(roomName, null, bridgeTarget);
                }
            });
            
            if (!bridge || bridge === ERR_NO_PATH || bridge.length === 0) {
                console.log('[ContestedDemolisher] Cannot bridge gap ' + from + ' -> ' + to);
                return null;
            }
            
            for (var b = 0; b < bridge.length; b++) {
                var bridgeRoom = bridge[b].room;
                if (bridgeRoom !== from && repaired[repaired.length - 1] !== bridgeRoom) {
                    repaired.push(bridgeRoom);
                }
            }
        }
    }
    
    return repaired;
}

/**
 * Validate and repair an operation's route. Call after any route modification.
 * Returns true if route is valid (or was repaired), false if unfixable.
 */
function ensureValidRoute(op) {
    if (!op.route) return true;
    
    var check = validateRoute(op.route);
    if (check.valid) return true;
    
    console.log('[ContestedDemolisher] Route broken at index ' + check.breakIndex +
                ': ' + check.from + ' is not adjacent to ' + check.to);
    
    var fixed = repairRoute(op.route, op.targetRoom);
    if (!fixed) {
        console.log('[ContestedDemolisher] Route could not be repaired');
        return false;
    }
    
    // Validate the repaired route too
    var recheck = validateRoute(fixed);
    if (!recheck.valid) {
        console.log('[ContestedDemolisher] Repaired route still broken at ' + 
                    recheck.from + ' -> ' + recheck.to);
        return false;
    }
    
    console.log('[ContestedDemolisher] Route repaired: ' + fixed.join(' -> '));
    op.route = fixed;
    op.routeBack = fixed.slice().reverse();
    return true;
}

// ========== MEMORY INITIALIZATION ==========

function initMemory() {
    if (!Memory.contestedDemolisherOrders) {
        Memory.contestedDemolisherOrders = [];
    }
    
    // Convert old schema (object) -> array if needed
    if (!Array.isArray(Memory.contestedDemolisherOrders)) {
        var converted = [];
        for (var k in Memory.contestedDemolisherOrders) {
            if (Memory.contestedDemolisherOrders[k]) converted.push(Memory.contestedDemolisherOrders[k]);
        }
        Memory.contestedDemolisherOrders = converted;
    }
    
    // Clean up old scan state if present
    if (Memory.contestedDemolisherScanState) {
        delete Memory.contestedDemolisherScanState;
    }
}

// ---------------------------------------------------------------------------
// GLOBAL CONSOLE COMMANDS
// ---------------------------------------------------------------------------
global.testContestedDemolisherRoutes = function(playerName, homeRoom, targetMode) {
    if (!playerName) {
        console.log('[TestCDRoutes] Usage: testContestedDemolisherRoutes("PlayerName", "homeRoom"?, "targetMode"?)');
        return;
    }
 
    initMemory();
 
    var homeRooms = [];
    if (homeRoom) {
        homeRooms = [homeRoom];
    } else {
        for (var rn in Game.rooms) {
            var rm = Game.rooms[rn];
            if (rm.controller && rm.controller.my &&
                rm.controller.level >= 7 &&
                rm.find(FIND_MY_SPAWNS).length > 0) {
                homeRooms.push(rn);
            }
        }
    }
 
    if (homeRooms.length === 0) {
        console.log('[TestCDRoutes] No valid home rooms found');
        return;
    }
 
    console.log('[TestCDRoutes] Home rooms: ' + homeRooms.join(', '));
 
    Memory.testCDRoutes = {
        playerName: playerName,
        homeRooms: homeRooms,
        targetMode: targetMode || 'all',
        phase: 'scanning',
        targetRooms: [],
        testQueue: [],
        results: [],
        currentTest: null,
        startTick: Game.time
    };
 
    console.log('[TestCDRoutes] Starting wideScan for ' + playerName + '...');
    if (typeof global.wideScan === 'function') {
        global.wideScan(playerName);
    } else {
        console.log('[TestCDRoutes] wideScan not available.');
        console.log('[TestCDRoutes] Use testContestedDemolisherRoutesSetTargets(["W1N46", ...]) to set rooms manually.');
    }
};
 
/**
 * Manually set target rooms (skips wideScan step).
 * Usage: testContestedDemolisherRoutesSetTargets(['W1N46', 'W2N43'])
 */
global.testContestedDemolisherRoutesSetTargets = function(rooms) {
    if (!Memory.testCDRoutes) {
        console.log('[TestCDRoutes] Run testContestedDemolisherRoutes("PlayerName") first.');
        return;
    }
    Memory.testCDRoutes.targetRooms = rooms;
    Memory.testCDRoutes.phase = 'testing';
    buildCDTestQueue(Memory.testCDRoutes);
    console.log('[TestCDRoutes] Set ' + rooms.length + ' target(s), ' +
                Memory.testCDRoutes.testQueue.length + ' test(s) queued');
};
 
/**
 * Print the current batch test progress.
 * Usage: testContestedDemolisherRoutesStatus()
 */
global.testContestedDemolisherRoutesStatus = function() {
    if (!Memory.testCDRoutes) {
        console.log('[TestCDRoutes] No active batch test.');
        return;
    }
    var s = Memory.testCDRoutes;
    console.log('[TestCDRoutes] Player: ' + s.playerName + ' | Phase: ' + s.phase + ' | Mode: ' + (s.targetMode || 'all'));
    console.log('[TestCDRoutes] Targets: ' + (s.targetRooms.join(', ') || '(none yet)'));
    console.log('[TestCDRoutes] Done: ' + s.results.length + ' | Queued: ' + s.testQueue.length);
    if (s.currentTest) {
        console.log('[TestCDRoutes] Current: ' + s.currentTest.homeRoom + ' -> ' + s.currentTest.targetRoom +
                    ' (started tick ' + s.currentTest.startTick + ')');
    }
    for (var i = 0; i < s.results.length; i++) {
        var r = s.results[i];
        var sym = r.status === 'success' ? '✓' : '✗';
        var detail = r.status === 'success'
            ? r.route.length + ' rooms' + (r.approachEdge ? ' approach:' + r.approachEdge : '')
            : r.reason;
        console.log('  ' + sym + ' ' + r.targetRoom + ': ' + detail);
    }
};
 
/**
 * Cancel an in-progress batch test.
 * Usage: testContestedDemolisherRoutesCancel()
 */
global.testContestedDemolisherRoutesCancel = function() {
    if (!Memory.testCDRoutes) {
        console.log('[TestCDRoutes] Nothing to cancel.');
        return;
    }
 
    // Clean up any in-flight dry-run order
    if (Memory.testCDRoutes.currentTest) {
        var ct = Memory.testCDRoutes.currentTest;
        Memory.contestedDemolisherOrders = _.filter(Memory.contestedDemolisherOrders, function(o) {
            return !(o && o.homeRoom === ct.homeRoom && o.targetRoom === ct.targetRoom);
        });
    }
 
    delete Memory.testCDRoutes;
    console.log('[TestCDRoutes] Cancelled.');
};

global.testContestedDemolisher = function(homeRoom, targetRoom, targetMode) {
    console.log('[ContestedDemolisher] === DRY RUN === Planning ' + homeRoom + ' -> ' + targetRoom + ' (no spawning)');
    global.orderContestedDemolisher(homeRoom, targetRoom, targetMode || 'all', { dryRun: true });
};

global.orderContestedDemolisher = function (spawnRoomName, targetRoomName, targetMode, options) {
    if (!spawnRoomName || !targetRoomName) {
        console.log('Usage: orderContestedDemolisher("spawnRoom", "targetRoom", targetMode?)');
        console.log('  targetMode: "all" (default), "towers", "military", or true (legacy = towers)');
        console.log('  military targets: towers, nuker, power spawn, labs (in priority order)');
        return;
    }
 
    // Backward compatibility: true -> 'towers', false/undefined -> 'all'
    if (targetMode === true) {
        targetMode = 'towers';
    } else if (!targetMode || targetMode === false) {
        targetMode = 'all';
    }
 
    // Validate target mode
    var validModes = ['all', 'towers', 'military'];
    if (validModes.indexOf(targetMode) === -1) {
        console.log('[ContestedDemolisher] Invalid targetMode "' + targetMode + '". Use: ' + validModes.join(', '));
        return;
    }
 
    if (!options) options = {};
 
    initMemory();
 
    // Validate home room
    var home = Game.rooms[spawnRoomName];
    if (!home) {
        console.log('[ContestedDemolisher] Cannot start: no vision of home room ' + spawnRoomName);
        return;
    }
 
    if (!home.controller || !home.controller.my) {
        console.log('[ContestedDemolisher] Cannot start: ' + spawnRoomName + ' is not owned');
        return;
    }
 
    var spawns = home.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) {
        console.log('[ContestedDemolisher] Cannot start: ' + spawnRoomName + ' has no spawns');
        return;
    }
 
    // Check for observer coverage
    var observerInfo = findObserverForRoom(targetRoomName);
    if (!observerInfo) {
        console.log('[ContestedDemolisher] Cannot start: no RCL 8 room with observer within ' + OBSERVER_RANGE + ' of ' + targetRoomName);
        return;
    }
 
    // Check for existing order
    var exists = _.some(Memory.contestedDemolisherOrders, function (o) {
        return o && o.homeRoom === spawnRoomName && o.targetRoom === targetRoomName;
    });
 
    if (exists) {
        console.log('[ContestedDemolisher] Order already exists for ' + spawnRoomName + ' -> ' + targetRoomName);
        return;
    }
 
    // Check if same sector or cross-sector
    var sameSector = areInSameSector(spawnRoomName, targetRoomName);
    console.log('[ContestedDemolisher] Origin sector: ' + getSectorName(spawnRoomName) + ', Target sector: ' + getSectorName(targetRoomName));
    console.log('[ContestedDemolisher] Same sector: ' + sameSector);
 
    if (sameSector) {
        createSameSectorOrder(spawnRoomName, targetRoomName, targetMode, observerInfo, options);
    } else {
        createCrossSectorOrder(spawnRoomName, targetRoomName, targetMode, observerInfo, options);
    }
};

function createSameSectorOrder(spawnRoomName, targetRoomName, targetMode, observerInfo, options) {
    if (!options) options = {};
 
    var targetForRoute = targetRoomName;
    var routeResult = Game.map.findRoute(spawnRoomName, targetRoomName, {
        routeCallback: function(roomName) {
            return getRoomRouteCost(roomName, null, targetForRoute);
        }
    });
 
    if (!routeResult || routeResult === ERR_NO_PATH || routeResult.length === 0) {
        console.log('[ContestedDemolisher] Cannot find direct route - falling back to cross-sector routing');
        createCrossSectorOrder(spawnRoomName, targetRoomName, targetMode, observerInfo, options);
        return;
    }
 
    var route = [spawnRoomName];
    for (var i = 0; i < routeResult.length; i++) {
        if (routeResult[i] && routeResult[i].room) {
            route.push(routeResult[i].room);
        }
    }
 
    var routeBack = route.slice().reverse();
 
    var roomsToScan = [];
    for (var j = 1; j < route.length; j++) {
        var rn = route[j];
        if (!isMyRoom(rn)) {
            roomsToScan.push(rn);
        }
    }
 
    var squadId = 'cd-' + spawnRoomName + '-' + targetRoomName + '-' + Game.time;
 
    Memory.contestedDemolisherOrders.push({
        homeRoom: spawnRoomName,
        targetRoom: targetRoomName,
        squadId: squadId,
        targetMode: targetMode,
        status: 'scanning',
        crossSector: false,
        dryRun: !!options.dryRun,   // <-- NEW
        route: route,
        routeBack: routeBack,
        observerRoom: observerInfo.roomName,
        scanData: {
            roomsToScan: roomsToScan,
            scannedRooms: {},
            routePassability: {},
            blockedRooms: []
        }
    });
 
    var modeStr = targetMode !== 'all' ? ' (' + targetMode.toUpperCase() + ')' : '';
    var dryStr  = options.dryRun ? ' [DRY RUN]' : '';
    console.log('[ContestedDemolisher] Created SAME-SECTOR order for ' + targetRoomName + modeStr + dryStr);
    console.log('[ContestedDemolisher] Route: ' + route.join(' -> '));
    console.log('[ContestedDemolisher] Observer in: ' + observerInfo.roomName + ' (distance ' + observerInfo.distance + ')');
    console.log('[ContestedDemolisher] Rooms to scan: ' + roomsToScan.join(', '));
 
    // Validate the route before proceeding
    var newOrder = Memory.contestedDemolisherOrders[Memory.contestedDemolisherOrders.length - 1];
    if (!ensureValidRoute(newOrder)) {
        console.log('[ContestedDemolisher] Initial route invalid - falling back to cross-sector');
        Memory.contestedDemolisherOrders.pop();
        createCrossSectorOrder(spawnRoomName, targetRoomName, targetMode, observerInfo, options);
    }
}

function createCrossSectorOrder(spawnRoomName, targetRoomName, targetMode, observerInfo, options) {
    if (!options) options = {};
 
    // For cross-sector, BFS from ALL neighbors of the target
    var neighbors = getRoomNeighbors(targetRoomName);
 
    if (neighbors.length === 0) {
        console.log('[ContestedDemolisher] Cannot start: target room has no accessible neighbors');
        return;
    }
 
    console.log('[ContestedDemolisher] Cross-sector: BFS from all ' + neighbors.length + ' neighbors of target');
 
    var allCandidatePaths = [];
    var pathsPerNeighbor = Math.ceil(MAX_CROSS_SECTOR_ROUTES / neighbors.length);
 
    for (var n = 0; n < neighbors.length; n++) {
        var neighborRoom = neighbors[n].room;
        var pathsFromNeighbor = bfsFindHighwayPaths(neighborRoom, targetRoomName, pathsPerNeighbor);
 
        console.log('[ContestedDemolisher]   ' + neighborRoom + ': found ' + pathsFromNeighbor.length + ' paths');
 
        for (var p = 0; p < pathsFromNeighbor.length; p++) {
            allCandidatePaths.push(pathsFromNeighbor[p]);
        }
    }
 
    var candidatePaths = allCandidatePaths;
 
    if (candidatePaths.length === 0) {
        console.log('[ContestedDemolisher] BFS found no paths to highways from any neighbor');
        return;
    }
 
    console.log('[ContestedDemolisher] Total candidate paths: ' + candidatePaths.length);
 
    var roomsToScan = deduplicateRooms(candidatePaths);
    if (roomsToScan.indexOf(targetRoomName) === -1) {
        roomsToScan.push(targetRoomName);
    }
 
    var squadId = 'cd-' + spawnRoomName + '-' + targetRoomName + '-' + Game.time;
 
    Memory.contestedDemolisherOrders.push({
        homeRoom: spawnRoomName,
        targetRoom: targetRoomName,
        squadId: squadId,
        targetMode: targetMode,
        status: 'scanning',
        crossSector: true,
        dryRun: !!options.dryRun,   // <-- NEW
        route: null,
        routeBack: null,
        observerRoom: observerInfo.roomName,
        scanData: {
            roomsToScan: roomsToScan,
            scannedRooms: {},
            routePassability: {},
            blockedRooms: [],
            candidatePaths: candidatePaths,
            validPaths: [],
            invalidatedPaths: [],
            lastProgressTick: Game.time,
            targetApproachDepth: null
        }
    });
 
    var modeStr = targetMode !== 'all' ? ' (' + targetMode.toUpperCase() + ')' : '';
    var dryStr  = options.dryRun ? ' [DRY RUN]' : '';
    console.log('[ContestedDemolisher] Created CROSS-SECTOR order for ' + targetRoomName + modeStr + dryStr);
    console.log('[ContestedDemolisher] Candidate paths: ' + candidatePaths.length);
    console.log('[ContestedDemolisher] Total rooms to scan: ' + roomsToScan.length);
}

global.cancelContestedDemolisherOrder = function (targetRoomName) {
    initMemory();
    
    var before = Memory.contestedDemolisherOrders.length;
    
    var filtered = [];
    for (var i = 0; i < Memory.contestedDemolisherOrders.length; i++) {
        var o = Memory.contestedDemolisherOrders[i];
        if (!o) continue;
        if (o.targetRoom !== targetRoomName) filtered.push(o);
    }
    Memory.contestedDemolisherOrders = filtered;
    
    var after = Memory.contestedDemolisherOrders.length;
    if (after < before) console.log('[ContestedDemolisher] Canceled order(s) for ' + targetRoomName);
    else console.log('[ContestedDemolisher] No active order found for ' + targetRoomName);
};

global.getContestedDemolisherStatus = function() {
    initMemory();
    
    var orders = Memory.contestedDemolisherOrders;
    console.log('=== Contested Demolisher Orders (' + orders.length + ') ===');
    
    for (var i = 0; i < orders.length; i++) {
        var op = orders[i];
        if (!op) continue;
        
        // Count creeps for this squad
        var squadCreeps = _.filter(Game.creeps, function(c) {
            return c.memory.role === 'contestedDemolisher' && 
                   c.memory.squadId === op.squadId;
        });
        var demolishers = _.filter(squadCreeps, function(c) { return c.memory.roleType === 'demolisher'; });
        var healers = _.filter(squadCreeps, function(c) { return c.memory.roleType === 'healer'; });
        
        // Resolve effective target mode (backward compat with old towersOnly field)
        var effectiveMode = op.targetMode || (op.towersOnly ? 'towers' : 'all');
        
        console.log('');
        console.log('Order: ' + op.homeRoom + ' -> ' + op.targetRoom);
        console.log('  Squad ID: ' + op.squadId);
        console.log('  Status: ' + (op.status || 'unknown'));
        console.log('  Cross-Sector: ' + (op.crossSector ? 'YES' : 'NO'));
        console.log('  Target Mode: ' + effectiveMode.toUpperCase());
        console.log('  Creeps: ' + demolishers.length + ' demolisher(s), ' + healers.length + ' healer(s)');
        console.log('  Route: ' + (op.route ? op.route.join(' -> ') : 'N/A'));
        
        // Approach info
        if (op.approachEdge) {
            console.log('  Approach Edge: ' + op.approachEdge);
        }
        if (op.scanData && op.scanData.targetApproachDepth) {
            var d = op.scanData.targetApproachDepth;
            console.log('  Approach Depth: N=' + d.N + ' S=' + d.S + ' E=' + d.E + ' W=' + d.W);
        }
        
        // Timing info
        if (op.readyTick) {
            console.log('  Ready since: tick ' + op.readyTick + ' (' + (Game.time - op.readyTick) + ' ticks ago)');
        }
        if (op.activeTick) {
            console.log('  Active since: tick ' + op.activeTick + ' (' + (Game.time - op.activeTick) + ' ticks ago)');
        }
        
        if (op.scanData) {
            var scanned = Object.keys(op.scanData.scannedRooms || {}).length;
            var total = op.scanData.roomsToScan ? op.scanData.roomsToScan.length : 0;
            console.log('  Scan Progress: ' + scanned + '/' + total);
            
            if (op.crossSector) {
                var validPaths = op.scanData.validPaths ? op.scanData.validPaths.length : 0;
                var invalidPaths = op.scanData.invalidatedPaths ? op.scanData.invalidatedPaths.length : 0;
                var totalPaths = op.scanData.candidatePaths ? op.scanData.candidatePaths.length : 0;
                console.log('  Valid Paths: ' + validPaths + '/' + (totalPaths + invalidPaths) + ' (invalidated: ' + invalidPaths + ')');
            }
            
            if (op.scanData.blockedRooms && op.scanData.blockedRooms.length > 0) {
                console.log('  Blocked Rooms: ' + op.scanData.blockedRooms.join(', '));
            }
        }
        
        if (op.failReason) {
            console.log('  Fail Reason: ' + op.failReason);
        }
    }
};

global.clearFailedContestedDemolishers = function() {
    initMemory();
    
    var before = Memory.contestedDemolisherOrders.length;
    
    var filtered = [];
    for (var i = 0; i < Memory.contestedDemolisherOrders.length; i++) {
        var o = Memory.contestedDemolisherOrders[i];
        if (!o) continue;
        if (o.status !== 'failed') filtered.push(o);
    }
    Memory.contestedDemolisherOrders = filtered;
    
    var cleared = before - filtered.length;
    console.log('[ContestedDemolisher] Cleared ' + cleared + ' failed order(s)');
};

global.forceCompleteContestedDemolisher = function(targetRoomName) {
    initMemory();
    
    var before = Memory.contestedDemolisherOrders.length;
    
    var filtered = [];
    for (var i = 0; i < Memory.contestedDemolisherOrders.length; i++) {
        var o = Memory.contestedDemolisherOrders[i];
        if (!o) continue;
        if (o.targetRoom !== targetRoomName) {
            filtered.push(o);
        } else {
            console.log('[ContestedDemolisher] Force completing order: ' + o.homeRoom + ' -> ' + o.targetRoom);
        }
    }
    Memory.contestedDemolisherOrders = filtered;
    
    var cleared = before - filtered.length;
    if (cleared > 0) {
        console.log('[ContestedDemolisher] Removed ' + cleared + ' order(s) for ' + targetRoomName);
    } else {
        console.log('[ContestedDemolisher] No orders found for ' + targetRoomName);
    }
};

global.resetContestedDemolisherOrder = function(targetRoomName) {
    initMemory();
    
    var order = _.find(Memory.contestedDemolisherOrders, function(o) {
        return o && o.targetRoom === targetRoomName;
    });
    
    if (!order) {
        console.log('[ContestedDemolisher] No order found for ' + targetRoomName);
        return;
    }
    
    // Reset scan data
    var roomsToScan = [];
    if (order.route) {
        for (var j = 1; j < order.route.length; j++) {
            var rn = order.route[j];
            if (!isMyRoom(rn)) {
                roomsToScan.push(rn);
            }
        }
    } else if (order.scanData && order.scanData.candidatePaths) {
        roomsToScan = deduplicateRooms(order.scanData.candidatePaths);
        if (roomsToScan.indexOf(order.targetRoom) === -1) {
            roomsToScan.push(order.targetRoom);
        }
    }
    
    order.status = 'scanning';
    order.failReason = null;
    order.approachEdge = null;
    order.scanData = {
        roomsToScan: roomsToScan,
        scannedRooms: {},
        routePassability: {},
        blockedRooms: [],
        pendingScan: null,
        candidatePaths: order.scanData ? order.scanData.candidatePaths : null,
        validPaths: [],
        invalidatedPaths: [],
        lastProgressTick: Game.time,
        targetApproachDepth: null
    };
    
    console.log('[ContestedDemolisher] Reset order for ' + targetRoomName + ' - will rescan ' + roomsToScan.length + ' rooms');
};

// ========== CLEANUP SYSTEM ==========

/**
 * Clean up completed or dead operations
 * An operation is complete when:
 * - Status is 'active' and no creeps remain for that squad
 * - Status is 'failed' (optional auto-cleanup)
 */
function cleanupCompletedOperations() {
    var orders = Memory.contestedDemolisherOrders;
    if (!orders || orders.length === 0) return;
 
    // Guard: don't auto-clear the order the batch tester is currently watching.
    var batchTestKey = null;
    if (Memory.testCDRoutes && Memory.testCDRoutes.currentTest) {
        var ct = Memory.testCDRoutes.currentTest;
        batchTestKey = ct.homeRoom + '|' + ct.targetRoom;
    }
 
    var toRemove = [];
 
    for (var i = 0; i < orders.length; i++) {
        var op = orders[i];
        if (!op) {
            toRemove.push(i);
            continue;
        }
 
        var opKey = op.homeRoom + '|' + op.targetRoom;
 
        // Auto-remove completed dry-run orders (unless the batch tester is watching this one)
        if (op.status === 'dryrun_complete' && opKey !== batchTestKey) {
            toRemove.push(i);
            continue;
        }
 
        // Only check active operations for natural completion
        if (op.status === 'active') {
            var squadCreeps = _.filter(Game.creeps, function(c) {
                return c.memory.role === 'contestedDemolisher' &&
                       c.memory.squadId === op.squadId;
            });
 
            if (squadCreeps.length === 0) {
                console.log('[ContestedDemolisher] Operation ' + op.homeRoom + ' -> ' + op.targetRoom + ' COMPLETE (no creeps remaining)');
                toRemove.push(i);
            }
        }
 
        // Ready ops that have been waiting too long without any creeps
        if (op.status === 'ready' && op.readyTick) {
            if (Game.time - op.readyTick > 3000) {
                var anyCreeps = _.some(Game.creeps, function(c) {
                    return c.memory.role === 'contestedDemolisher' &&
                           c.memory.squadId === op.squadId;
                });
 
                if (!anyCreeps) {
                    console.log('[ContestedDemolisher] Operation ' + op.homeRoom + ' -> ' + op.targetRoom + ' EXPIRED (ready but never spawned)');
                    toRemove.push(i);
                }
            }
        }
    }
 
    // Remove in reverse order to preserve indices
    if (toRemove.length > 0) {
        for (var r = toRemove.length - 1; r >= 0; r--) {
            Memory.contestedDemolisherOrders.splice(toRemove[r], 1);
        }
    }
}

/**
 * Mark an operation as active (called when creeps start moving)
 */
function markOperationActive(squadId) {
    var order = _.find(Memory.contestedDemolisherOrders, function(o) {
        return o && o.squadId === squadId;
    });
    
    if (order && order.status === 'ready') {
        order.status = 'active';
        order.activeTick = Game.time;
        console.log('[ContestedDemolisher] Operation ' + order.homeRoom + ' -> ' + order.targetRoom + ' now ACTIVE');
    }
}

// ========== SCANNING SYSTEM ==========

/**
 * Scanner processes one room per tick.
 */
function runScanner() {
    initMemory();
    
    // First, clean up completed/dead operations
    cleanupCompletedOperations();
    
    var orders = Memory.contestedDemolisherOrders;
    
    // First, check if we have a pending scan from last tick
    for (var i = 0; i < orders.length; i++) {
        var op = orders[i];
        if (!op) continue;
        if (op.status !== 'scanning') continue;
        if (!op.scanData) continue;
        
        // Check for pending scan
        if (op.scanData.pendingScan) {
            var pending = op.scanData.pendingScan;
            var room = Game.rooms[pending.roomName];
            
            if (room) {
                // Vision available - process it
                console.log('[ContestedDemolisher] Scanning ' + pending.roomName + ' (vision from observer)');
                if (op.crossSector) {
                    processCrossSectorScanResult(op, pending.roomName, room);
                } else {
                    processScanResult(op, pending.roomName, room);
                }
                delete op.scanData.pendingScan;
            } else if (Game.time - pending.requestedTick > 5) {
                // Timeout - mark as no vision and continue
                console.log('[ContestedDemolisher] Scan timeout for ' + pending.roomName + ' - marking as passable (highway/safe assumed)');
                op.scanData.scannedRooms[pending.roomName] = {
                    tick: Game.time,
                    passable: true,
                    safe: true,
                    reason: 'no_vision_assumed_safe'
                };
                op.scanData.routePassability[pending.roomName] = true;
                delete op.scanData.pendingScan;
            } else {
                // Still waiting for vision
                return;
            }
        }
    }
    
    // Find next room to scan
    for (var i = 0; i < orders.length; i++) {
        var op = orders[i];
        if (!op) continue;
        if (op.status !== 'scanning') continue;
        if (!op.scanData || !op.scanData.roomsToScan) continue;
        
        // Skip if we have a pending scan
        if (op.scanData.pendingScan) continue;
        
        // Cross-sector progress logging
        if (op.crossSector && op.scanData.lastProgressTick) {
            if (Game.time - op.scanData.lastProgressTick >= CROSS_SECTOR_PROGRESS_INTERVAL) {
                var scannedCount = Object.keys(op.scanData.scannedRooms || {}).length;
                var validCount = op.scanData.candidatePaths ? op.scanData.candidatePaths.length : 0;
                var invalidCount = op.scanData.invalidatedPaths ? op.scanData.invalidatedPaths.length : 0;
                console.log('[ContestedDemolisher] Cross-sector scan: ' + scannedCount + '/' + op.scanData.roomsToScan.length + 
                            ' rooms scanned, ' + validCount + '/' + (validCount + invalidCount) + ' routes still valid');
                op.scanData.lastProgressTick = Game.time;
            }
        }
        
        // Find next unscanned room
        var nextRoom = null;
        for (var j = 0; j < op.scanData.roomsToScan.length; j++) {
            var rn = op.scanData.roomsToScan[j];
            if (!op.scanData.scannedRooms[rn]) {
                nextRoom = rn;
                break;
            }
        }
        
        if (!nextRoom) {
            // All rooms scanned - finalize
            if (op.crossSector) {
                finalizeCrossSectorOperation(op);
            } else {
                finalizeOperation(op);
            }
            continue;
        }
        
        // Check if we already have vision (owned room, creep present, etc.)
        if (Game.rooms[nextRoom]) {
            console.log('[ContestedDemolisher] Scanning ' + nextRoom + ' (existing vision)');
            if (op.crossSector) {
                processCrossSectorScanResult(op, nextRoom, Game.rooms[nextRoom]);
            } else {
                processScanResult(op, nextRoom, Game.rooms[nextRoom]);
            }
            return; // One room per tick
        }
        
        // Need to use observer
        var observerInfo = findObserverForRoom(nextRoom);
        if (!observerInfo) {
            console.log('[ContestedDemolisher] No observer can reach ' + nextRoom + ' - assuming passable');
            op.scanData.scannedRooms[nextRoom] = { 
                passable: true,
                safe: true,
                reason: 'no_observer_assumed_safe' 
            };
            op.scanData.routePassability[nextRoom] = true;
            continue;
        }
        
        if (observerInfo.observer.cooldown > 0) {
            continue; // Observer busy, try next order
        }
        
        var result = observerInfo.observer.observeRoom(nextRoom);
        if (result === OK) {
            // Vision will be available NEXT tick
            op.scanData.pendingScan = {
                roomName: nextRoom,
                requestedTick: Game.time
            };
            console.log('[ContestedDemolisher] Observer requested for ' + nextRoom + ' (vision next tick)');
            return; // Wait for next tick
        } else {
            console.log('[ContestedDemolisher] observeRoom failed for ' + nextRoom + ': ' + result);
        }
    }
}

function processScanResult(op, roomName, room) {
    var scanData = op.scanData;
    var isTarget = roomName === op.targetRoom;
    var routeIndex = op.route.indexOf(roomName);
    
    var prevRoom = routeIndex > 0 ? op.route[routeIndex - 1] : null;
    var nextRoom = routeIndex < op.route.length - 1 ? op.route[routeIndex + 1] : null;
    
    console.log('[ContestedDemolisher] Processing ' + roomName + ' (from: ' + prevRoom + ', to: ' + (nextRoom || 'TARGET') + ')');
    
    // TARGET ROOM: Analyse edges for approach-direction preference but don't
    // block the route — the target IS expected to be hostile.
    if (isTarget) {
        var targetEdges = analyzeRoomEdges(room);
        var targetDepth = analyzeApproachDepth(room);

        scanData.routePassability[roomName] = true;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: true,
            reason: 'target_room_hostile_allowed',
            edges: targetEdges,
            approachDepth: targetDepth
        };
        scanData.targetApproachDepth = targetDepth;

        if (targetEdges) {
            var bestEdge = null;
            var bestScore = -1;
            var dirs = ['N', 'S', 'E', 'W'];
            for (var d = 0; d < dirs.length; d++) {
                var dir = dirs[d];
                var walkable = targetEdges[dir].totalWalkable;
                var depth = targetDepth ? targetDepth[dir] : 0;
                // Combined score: walkable tiles on the edge + approach depth
                var score = walkable + depth * 2;
                if (score > bestScore) {
                    bestScore = score;
                    bestEdge = dir;
                }
            }
            console.log('[ContestedDemolisher] Target room approach analysis:');
            for (var d2 = 0; d2 < dirs.length; d2++) {
                var dd = dirs[d2];
                console.log('[ContestedDemolisher]   ' + dd + ': ' + targetEdges[dd].totalWalkable +
                            ' walkable tiles, depth ' + (targetDepth ? targetDepth[dd] : '?'));
            }
            console.log('[ContestedDemolisher] Best approach: ' + bestEdge + ' (score ' + bestScore + ')');
            op.preferredApproachEdge = bestEdge;
        }

        console.log('[ContestedDemolisher] Target room ' + roomName + ' - OK (hostile allowed)');
        return;
    }
    
    // TRANSIT ROOMS: Must be passable AND safe
    var passResult = checkRoomPassability(room, prevRoom, nextRoom);
    
    var safetyResult = checkRoomSafety(room);
    if (!safetyResult.safe) {
        console.log('[ContestedDemolisher] Room ' + roomName + ' is UNSAFE: ' + safetyResult.reason);
        scanData.routePassability[roomName] = false;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: false,
            reason: 'unsafe_' + safetyResult.reason
        };
        
        if (scanData.blockedRooms.indexOf(roomName) === -1) {
            scanData.blockedRooms.push(roomName);
        }
        
        // Try to convert to cross-sector routing
        console.log('[ContestedDemolisher] Attempting cross-sector routing due to blocked room');
        convertToCrossSector(op);
        return;
    }
    
    if (passResult.passable) {
        console.log('[ContestedDemolisher] Room ' + roomName + ' is passable');
        scanData.routePassability[roomName] = true;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: true,
            availableExits: passResult.availableExits,
            reason: 'ok'
        };
        return;
    }
    
    // Room blocked - try to reroute
    console.log('[ContestedDemolisher] Room ' + roomName + ' BLOCKED, attempting reroute...');
    console.log('[ContestedDemolisher] Available exits: ' + (passResult.availableExits || []).join(', '));
    
    var entryDir = getExitDirection(roomName, prevRoom);
    var validExits = [];
    if (passResult.availableExits) {
        for (var i = 0; i < passResult.availableExits.length; i++) {
            var exitDir = passResult.availableExits[i];
            if (exitDir !== entryDir) {
                validExits.push(exitDir);
            }
        }
    }
    
    if (validExits.length === 0) {
        console.log('[ContestedDemolisher] No forward exits - trying cross-sector routing');
        scanData.routePassability[roomName] = false;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: false,
            reason: 'dead_end'
        };
        if (scanData.blockedRooms.indexOf(roomName) === -1) {
            scanData.blockedRooms.push(roomName);
        }
        convertToCrossSector(op);
        return;
    }
    
    // Try each valid exit
    for (var v = 0; v < validExits.length; v++) {
        var tryExitDir = validExits[v];
        var exitToRoom = getAdjacentRoom(roomName, tryExitDir);
        
        if (!exitToRoom || exitToRoom === op.homeRoom) continue;
        
        var blockedSet = {};
        for (var b = 0; b < scanData.blockedRooms.length; b++) {
            blockedSet[scanData.blockedRooms[b]] = true;
        }
        if (blockedSet[exitToRoom]) continue;
        
        console.log('[ContestedDemolisher] Trying exit ' + tryExitDir + ' to ' + exitToRoom);
        
        var avoidRoom = roomName;
        var targetForReroute = op.targetRoom;
        var newRouteResult = Game.map.findRoute(exitToRoom, op.targetRoom, {
            routeCallback: function(rn) {
                if (rn === avoidRoom) return Infinity;
                if (blockedSet[rn]) return Infinity;
                return getRoomRouteCost(rn, null, targetForReroute);
            }
        });
        
        if (!newRouteResult || newRouteResult === ERR_NO_PATH || newRouteResult.length === 0) {
            console.log('[ContestedDemolisher] No path from ' + exitToRoom + ' to target');
            continue;
        }
        
        // Build new route
        var newFullRoute = op.route.slice(0, routeIndex + 1);
        newFullRoute.push(exitToRoom);
        for (var r = 0; r < newRouteResult.length; r++) {
            var nextRoomInRoute = newRouteResult[r].room;
            if (nextRoomInRoute !== exitToRoom) {
                newFullRoute.push(nextRoomInRoute);
            }
        }
        
        console.log('[ContestedDemolisher] NEW ROUTE: ' + newFullRoute.join(' -> '));
        
        op.route = newFullRoute;
        op.routeBack = newFullRoute.slice().reverse();
        
        // Validate the rerouted path
        if (!ensureValidRoute(op)) {
            console.log('[ContestedDemolisher] Rerouted path invalid - trying next exit');
            continue;
        }
        
        // Update rooms to scan
        var newRoomsToScan = [];
        for (var s = 1; s < newFullRoute.length; s++) {
            var scanRoom = newFullRoute[s];
            if (isMyRoom(scanRoom)) continue;
            if (scanData.scannedRooms[scanRoom] && scanData.scannedRooms[scanRoom].passable) continue;
            newRoomsToScan.push(scanRoom);
        }
        scanData.roomsToScan = newRoomsToScan;
        
        scanData.routePassability[roomName] = true;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: true,
            availableExits: passResult.availableExits,
            usedExit: tryExitDir,
            reason: 'rerouted_via_' + tryExitDir
        };
        
        console.log('[ContestedDemolisher] Route updated! Remaining to scan: ' + newRoomsToScan.join(', '));
        return;
    }
    
    // No exit worked - try cross-sector
    console.log('[ContestedDemolisher] No exit from ' + roomName + ' leads to target - trying cross-sector');
    scanData.routePassability[roomName] = false;
    scanData.scannedRooms[roomName] = {
        tick: Game.time,
        passable: false,
        availableExits: passResult.availableExits,
        reason: 'no_path_to_target'
    };
    if (scanData.blockedRooms.indexOf(roomName) === -1) {
        scanData.blockedRooms.push(roomName);
    }
    convertToCrossSector(op);
}

function processCrossSectorScanResult(op, roomName, room) {
    var scanData = op.scanData;
    var isTarget = roomName === op.targetRoom;
    
    // Check room safety
    var safetyResult = checkRoomSafety(room);
    
    // Analyze edges for blocked exit detection
    var edgeData = analyzeRoomEdges(room);
    var blockedExits = [];
    
    if (edgeData) {
        if (edgeData.N.totalWalkable === 0) blockedExits.push('N');
        if (edgeData.S.totalWalkable === 0) blockedExits.push('S');
        if (edgeData.E.totalWalkable === 0) blockedExits.push('E');
        if (edgeData.W.totalWalkable === 0) blockedExits.push('W');
        
        if (blockedExits.length > 0) {
            console.log('[ContestedDemolisher] Room ' + roomName + ' has blocked exits: ' + blockedExits.join(', '));
        }
    }
    
    console.log('[ContestedDemolisher] Cross-sector scan of ' + roomName + ': ' + 
                (safetyResult.safe ? 'SAFE' : 'HOSTILE') + ' (' + safetyResult.reason + ')');
    
    scanData.scannedRooms[roomName] = {
        tick: Game.time,
        safe: safetyResult.safe,
        reason: safetyResult.reason,
        edges: edgeData,
        blockedExits: blockedExits
    };
    
    // Target room: always allowed (it's hostile, that's the point!)
    // Also analyse approach depth for route selection.
    if (isTarget) {
        var targetDepth = analyzeApproachDepth(room);
        scanData.scannedRooms[roomName].approachDepth = targetDepth;
        scanData.targetApproachDepth = targetDepth;
        scanData.routePassability[roomName] = true;

        if (edgeData) {
            var bestEdge = null;
            var bestScore = -1;
            var dirs = ['N', 'S', 'E', 'W'];
            for (var d = 0; d < dirs.length; d++) {
                var dir = dirs[d];
                // Skip edges with zero walkable tiles
                if (edgeData[dir].totalWalkable === 0) continue;
                var walkable = edgeData[dir].totalWalkable;
                var depth = targetDepth ? targetDepth[dir] : 0;
                var score = walkable + depth * 2;
                if (score > bestScore) {
                    bestScore = score;
                    bestEdge = dir;
                }
            }
            if (bestEdge) {
                op.preferredApproachEdge = bestEdge;
                console.log('[ContestedDemolisher] Target ' + roomName + ' preferred approach: ' + bestEdge +
                            ' (score ' + bestScore + ')');
            }

            // Invalidate paths that enter from edges with ZERO walkable tiles
            for (var be = 0; be < blockedExits.length; be++) {
                // blockedExits are edges of the target room that are fully walled.
                // Paths entering from this edge should be eliminated.
                invalidatePathsEnteringTargetFromEdge(op, blockedExits[be]);
            }
        }

        console.log('[ContestedDemolisher] Target room ' + roomName + ' - OK (hostile allowed)');
        return;
    }
    
    // For transit rooms: check safety and passability
    if (!safetyResult.safe) {
        console.log('[ContestedDemolisher] Room ' + roomName + ' is hostile - invalidating affected paths');
        invalidatePathsContainingRoom(op, roomName);
        scanData.routePassability[roomName] = false;
        return;
    }
    
    // Check if any required exits are blocked
    if (blockedExits.length > 0) {
        invalidatePathsWithBlockedExit(op, roomName, blockedExits);
    }
    
    scanData.routePassability[roomName] = true;
}

/**
 * Invalidate cross-sector paths that would enter the target room from a
 * fully-walled edge. The BFS paths are stored "outward" from the target's
 * neighbor, so the first node is the neighbor and its entryDir tells us
 * which edge of the TARGET the pair would cross.
 */
function invalidatePathsEnteringTargetFromEdge(op, blockedEdge) {
    if (!op.scanData.candidatePaths) return;

    // If a neighbor enters the target heading 'E', the pair lands on the
    // target's WEST edge. So the TARGET edge is the opposite of the first
    // node's exit direction toward the target.  But in our BFS data the
    // first node's entryDir is actually the direction it was entered FROM
    // (i.e. from the target side).  entryDir on the first node = the edge
    // of the NEIGHBOR that faces the target = opposite of the target edge.
    // So: if blockedEdge = 'E' (target's east edge is walled), we want to
    // remove paths where the first node's entryDir = 'W' (neighbor entered
    // from its west side, which faces target's east side).
    var neighborEntry = getOppositeEdge(blockedEdge);
    if (!neighborEntry) return;

    var stillValid = [];
    var invalidatedCount = 0;

    for (var i = 0; i < op.scanData.candidatePaths.length; i++) {
        var path = op.scanData.candidatePaths[i];
        var firstNode = path[0];

        if (typeof firstNode === 'object' && firstNode.entryDir === neighborEntry) {
            if (!op.scanData.invalidatedPaths) op.scanData.invalidatedPaths = [];
            op.scanData.invalidatedPaths.push(path);
            invalidatedCount++;
        } else {
            stillValid.push(path);
        }
    }

    if (invalidatedCount > 0) {
        console.log('[ContestedDemolisher] Invalidated ' + invalidatedCount +
                    ' paths entering target from blocked ' + blockedEdge + ' edge');
    }

    op.scanData.candidatePaths = stillValid;
}

function convertToCrossSector(op) {
    console.log('[ContestedDemolisher] Converting to cross-sector routing');
    
    // Find all neighbors of target
    var neighbors = getRoomNeighbors(op.targetRoom);
    if (neighbors.length === 0) {
        console.log('[ContestedDemolisher] No neighbors for target - operation failed');
        op.status = 'failed';
        op.failReason = 'no_target_neighbors';
        return;
    }
    
    // Filter out blocked neighbors
    var validNeighbors = [];
    for (var n = 0; n < neighbors.length; n++) {
        var neighborRoom = neighbors[n].room;
        if (op.scanData.blockedRooms && op.scanData.blockedRooms.indexOf(neighborRoom) !== -1) continue;
        validNeighbors.push(neighborRoom);
    }
    
    if (validNeighbors.length === 0) {
        console.log('[ContestedDemolisher] All neighbors blocked - operation failed');
        op.status = 'failed';
        op.failReason = 'all_neighbors_blocked';
        return;
    }
    
    // BFS from ALL valid neighbors
    var allCandidatePaths = [];
    var pathsPerNeighbor = Math.ceil(MAX_CROSS_SECTOR_ROUTES / validNeighbors.length);
    
    for (var v = 0; v < validNeighbors.length; v++) {
        var neighborRoom = validNeighbors[v];
        var pathsFromNeighbor = bfsFindHighwayPaths(neighborRoom, op.targetRoom, pathsPerNeighbor);
        
        console.log('[ContestedDemolisher]   ' + neighborRoom + ': found ' + pathsFromNeighbor.length + ' paths');
        
        for (var p = 0; p < pathsFromNeighbor.length; p++) {
            allCandidatePaths.push(pathsFromNeighbor[p]);
        }
    }
    
    var candidatePaths = allCandidatePaths;
    
    if (candidatePaths.length === 0) {
        console.log('[ContestedDemolisher] BFS found no paths - operation failed');
        op.status = 'failed';
        op.failReason = 'no_highway_paths';
        return;
    }
    
    // Deduplicate rooms to scan
    var roomsToScan = deduplicateRooms(candidatePaths);
    if (roomsToScan.indexOf(op.targetRoom) === -1) {
        roomsToScan.push(op.targetRoom);
    }
    
    // Filter out already-scanned rooms that are safe
    var newRoomsToScan = [];
    for (var i = 0; i < roomsToScan.length; i++) {
        var room = roomsToScan[i];
        var existing = op.scanData.scannedRooms[room];
        if (existing && existing.safe !== false && existing.passable !== false) {
            continue;
        }
        newRoomsToScan.push(room);
    }
    
    // Update operation
    op.crossSector = true;
    op.route = null;
    
    op.scanData.candidatePaths = candidatePaths;
    op.scanData.validPaths = [];
    op.scanData.invalidatedPaths = [];
    op.scanData.roomsToScan = newRoomsToScan;
    op.scanData.lastProgressTick = Game.time;
    if (!op.scanData.targetApproachDepth) op.scanData.targetApproachDepth = null;
    
    // Invalidate paths containing blocked rooms
    if (op.scanData.blockedRooms) {
        for (var b = 0; b < op.scanData.blockedRooms.length; b++) {
            invalidatePathsContainingRoom(op, op.scanData.blockedRooms[b]);
        }
    }
    
    console.log('[ContestedDemolisher] Converted to cross-sector with ' + candidatePaths.length + ' candidate paths');
    console.log('[ContestedDemolisher] Rooms to scan: ' + newRoomsToScan.length);
}

function finalizeOperation(op) {
    var scanData = op.scanData;
 
    console.log('[ContestedDemolisher] Finalizing ' + op.homeRoom + ' -> ' + op.targetRoom);
 
    // Check for blocked rooms in route
    for (var i = 1; i < op.route.length; i++) {
        var rn = op.route[i];
        if (rn === op.targetRoom) continue;
 
        if (scanData.routePassability[rn] === false) {
            console.log('[ContestedDemolisher] Route blocked at ' + rn + ' - trying cross-sector');
            convertToCrossSector(op);
            return;
        }
    }
 
    // Check if current route enters from a poor approach edge and a better
    // one is available (same-sector only, before marking ready).
    if (op.preferredApproachEdge && op.route && op.route.length >= 2) {
        var penultimateRoom = op.route[op.route.length - 2];
        var currentEntryDir = getExitDirection(penultimateRoom, op.targetRoom);
        // currentEntryDir is the direction the penultimate room exits toward
        // the target, so the target edge is the opposite.
        var currentTargetEdge = currentEntryDir ? getOppositeEdge(currentEntryDir) : null;
 
        if (currentTargetEdge && currentTargetEdge !== op.preferredApproachEdge) {
            console.log('[ContestedDemolisher] Current approach (' + currentTargetEdge + ') differs from preferred (' +
                        op.preferredApproachEdge + ') - attempting reroute');
 
            // Try to find a route that enters from the preferred side
            var preferredNeighborDir = getOppositeEdge(op.preferredApproachEdge);
            var preferredNeighbor = getAdjacentRoom(op.targetRoom, preferredNeighborDir);
 
            if (preferredNeighbor) {
                var targetForReroute = op.targetRoom;
                var altRoute = Game.map.findRoute(op.homeRoom, preferredNeighbor, {
                    routeCallback: function(roomName) {
                        return getRoomRouteCost(roomName, null, targetForReroute);
                    }
                });
 
                if (altRoute && altRoute !== ERR_NO_PATH && altRoute.length > 0) {
                    var newRoute = [op.homeRoom];
                    for (var ar = 0; ar < altRoute.length; ar++) {
                        newRoute.push(altRoute[ar].room);
                    }
                    if (newRoute.indexOf(op.targetRoom) === -1) {
                        newRoute.push(op.targetRoom);
                    }
 
                    // Only use if not significantly longer (within 3 rooms)
                    if (newRoute.length <= op.route.length + 3) {
                        op.route = newRoute;
                        op.routeBack = newRoute.slice().reverse();
 
                        if (ensureValidRoute(op)) {
                            console.log('[ContestedDemolisher] Rerouted for preferred approach: ' + op.route.join(' -> '));
                            op.approachEdge = op.preferredApproachEdge;
                        } else {
                            console.log('[ContestedDemolisher] Preferred approach route invalid, keeping original');
                        }
                    } else {
                        console.log('[ContestedDemolisher] Preferred route too long (' + newRoute.length + ' vs ' + op.route.length + '), keeping original');
                    }
                }
            }
        } else {
            op.approachEdge = currentTargetEdge;
        }
    }
 
    // Final route validation
    if (!ensureValidRoute(op)) {
        console.log('[ContestedDemolisher] Final route invalid - trying cross-sector');
        op.status = 'scanning';
        convertToCrossSector(op);
        return;
    }
 
    // ── DRY RUN branch ──────────────────────────────────────────────────────
    if (op.dryRun) {
        op.status = 'dryrun_complete';
        op.readyTick = Game.time;
        console.log('[ContestedDemolisher] ✓ DRY RUN ' + op.homeRoom + ' -> ' + op.targetRoom + ' COMPLETE');
        console.log('[ContestedDemolisher] Final route: ' + op.route.join(' -> '));
        if (op.approachEdge) {
            console.log('[ContestedDemolisher] Approach edge: ' + op.approachEdge);
        }
        return;
    }
 
    op.status = 'ready';
    op.readyTick = Game.time;
    console.log('[ContestedDemolisher] ✓ Operation ' + op.homeRoom + ' -> ' + op.targetRoom + ' is READY');
    console.log('[ContestedDemolisher] Final route: ' + op.route.join(' -> '));
    if (op.approachEdge) {
        console.log('[ContestedDemolisher] Approach edge: ' + op.approachEdge);
    }
}

function finalizeCrossSectorOperation(op) {
    var scanData = op.scanData;
 
    console.log('[ContestedDemolisher] Finalizing cross-sector ' + op.homeRoom + ' -> ' + op.targetRoom);
 
    // Determine which paths are still valid
    var validPaths = [];
 
    for (var i = 0; i < scanData.candidatePaths.length; i++) {
        var path = scanData.candidatePaths[i];
        var pathValid = true;
 
        for (var j = 0; j < path.length; j++) {
            var node = path[j];
            var roomName = getPathNodeRoom(node);
            var roomInfo = scanData.scannedRooms[roomName];
 
            if (!roomInfo) {
                console.log('[ContestedDemolisher] WARNING: Room ' + roomName + ' in path was not scanned');
                pathValid = false;
                break;
            }
 
            if (roomInfo.safe === false) {
                pathValid = false;
                break;
            }
 
            // Check if required exits are blocked
            if (typeof node === 'object' && roomInfo.blockedExits) {
                if (node.entryDir && roomInfo.blockedExits.indexOf(node.entryDir) !== -1) {
                    pathValid = false;
                    break;
                }
                if (node.exitDir && roomInfo.blockedExits.indexOf(node.exitDir) !== -1) {
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
 
    console.log('[ContestedDemolisher] Valid paths after scanning: ' + validPaths.length);
 
    if (validPaths.length === 0) {
        console.log('[ContestedDemolisher] FAILED: No valid paths found');
        op.status = 'failed';
        op.failReason = 'all_paths_blocked';
        return;
    }
 
    // Select best route (with approach depth awareness)
    var bestRoute = selectBestCrossSectorRoute(op.homeRoom, op.targetRoom, validPaths, scanData.targetApproachDepth);
 
    if (!bestRoute) {
        console.log('[ContestedDemolisher] FAILED: Could not select best route');
        op.status = 'failed';
        op.failReason = 'no_valid_route';
        return;
    }
 
    console.log('[ContestedDemolisher] Selected route via highway ' + bestRoute.highwayEntry +
                ' (total length: ' + bestRoute.totalLength + ', effective: ' + bestRoute.effectiveLength.toFixed(1) + ')');
    if (bestRoute.entryEdge) {
        console.log('[ContestedDemolisher] Target entry edge: ' + bestRoute.entryEdge);
        op.approachEdge = bestRoute.entryEdge;
    }
 
    // Build full route: origin -> highway -> reverse(BFS path) -> target
    var routeToHighway = Game.map.findRoute(op.homeRoom, bestRoute.highwayEntry, {
        routeCallback: function(roomName) {
            return getRoomRouteCost(roomName, null, op.targetRoom);
        }
    });
 
    if (!routeToHighway || routeToHighway === ERR_NO_PATH) {
        console.log('[ContestedDemolisher] FAILED: Cannot build route to highway ' + bestRoute.highwayEntry);
        op.status = 'failed';
        op.failReason = 'no_route_to_highway';
        return;
    }
 
    // Build complete route
    var fullRoute = [op.homeRoom];
 
    for (var r = 0; r < routeToHighway.length; r++) {
        fullRoute.push(routeToHighway[r].room);
    }
 
    // Add BFS path reversed (highway -> entry room adjacent to target)
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
 
    // Add target room
    if (fullRoute.indexOf(op.targetRoom) === -1) {
        fullRoute.push(op.targetRoom);
    }
 
    op.route = fullRoute;
    op.routeBack = fullRoute.slice().reverse();
 
    // Validate the assembled route
    if (!ensureValidRoute(op)) {
        console.log('[ContestedDemolisher] FAILED: Assembled cross-sector route is invalid');
        op.status = 'failed';
        op.failReason = 'invalid_route';
        return;
    }
 
    console.log('[ContestedDemolisher] Full route: ' + op.route.join(' -> '));
 
    // ── DRY RUN branch ──────────────────────────────────────────────────────
    if (op.dryRun) {
        op.status = 'dryrun_complete';
        op.readyTick = Game.time;
        console.log('[ContestedDemolisher] ✓ DRY RUN cross-sector ' + op.homeRoom + ' -> ' + op.targetRoom + ' COMPLETE');
        if (op.approachEdge) {
            console.log('[ContestedDemolisher] Approach edge: ' + op.approachEdge);
        }
        return;
    }
 
    op.status = 'ready';
    op.readyTick = Game.time;
    console.log('[ContestedDemolisher] ✓ Cross-sector operation ' + op.homeRoom + ' -> ' + op.targetRoom + ' is READY');
}

// ---------------------------------------------------------------------------
// ROLE RUNTIME
// ---------------------------------------------------------------------------

module.exports = {
    /**
     * Main run function - handles both manager mode and creep mode
     * @param {Creep} [creep] - If provided, runs creep logic. If omitted, runs scanner.
     */
    run: function (creep) {
        // Manager mode: run scanner
        if (!creep) {
            runScanner();
            return;
        }
        
        // Creep mode: run individual creep
        var roleType = creep.memory.roleType; // 'demolisher' or 'healer'
        var squadId = creep.memory.squadId;
        var homeRoom = creep.memory.homeRoom;
        var targetRoom = creep.memory.targetRoom;
        
        if (!roleType || !squadId || !homeRoom || !targetRoom) return;
        
        if (roleType === 'demolisher') {
            runDemolisher(creep);
            return;
        }
        
        if (roleType === 'healer') {
            runHealer(creep);
            return;
        }
    },
    
    // Expose scanner separately if needed
    runScanner: runScanner,
    
    // Export for spawn manager
    getOrderBySquadId: function(squadId) {
        initMemory();
        return _.find(Memory.contestedDemolisherOrders, function(o) {
            return o && o.squadId === squadId;
        });
    },
    
    isOrderReady: function(squadId) {
        var order = this.getOrderBySquadId(squadId);
        return order && (order.status === 'ready' || order.status === 'active');
    }
};

// ---------------------------------------------------------------------------
// PAIR HELPERS
// ---------------------------------------------------------------------------

function findPartner(creep, wantedRoleType) {
    var squadId = creep.memory.squadId;
    
    return _.find(Game.creeps, function (c) {
        if (!c || !c.memory) return false;
        if (c.memory.role !== 'contestedDemolisher') return false;
        if (c.memory.squadId !== squadId) return false;
        if (c.memory.roleType !== wantedRoleType) return false;
        return true;
    });
}

// ---------------------------------------------------------------------------
// LONG-RANGE NAVIGATION (from towerDrain)
// ---------------------------------------------------------------------------

/**
 * Follow pre-computed room route one room at a time
 * Uses PathFinder.search for strict room control
 */
function followRoomRoute(creep, forward) {
    var route = forward ? creep.memory.route : creep.memory.routeBack;
    if (!route || route.length === 0) {
        // Fallback to simple moveTo if no route cached
        var targetRoom = forward ? creep.memory.targetRoom : creep.memory.homeRoom;
        creep.moveTo(new RoomPosition(25, 25, targetRoom), { reusePath: 10 });
        return ERR_NOT_FOUND;
    }
    
    var currentRoom = creep.room.name;
    var goalRoom = forward ? creep.memory.targetRoom : creep.memory.homeRoom;
    
    if (currentRoom === goalRoom) return OK;
    
    // Build allowed rooms set
    var allowedRooms = {};
    for (var r = 0; r < route.length; r++) {
        allowedRooms[route[r]] = true;
    }
    
    if (!allowedRooms[currentRoom]) {
        console.log('[ContestedDemolisher] WARNING: ' + creep.name + ' in unauthorized room ' + currentRoom);
        creep.moveTo(25, 25);
        return ERR_NOT_FOUND;
    }
    
    // Find next room in route
    var idx = route.indexOf(currentRoom);
    if (idx === -1) idx = 0;
    
    var nextIdx = idx + 1;
    if (nextIdx >= route.length) return OK;
    
    var nextRoom = route[nextIdx];
    
    // Safety check: if the next room isn't adjacent, try to find a later
    // room in the route that IS adjacent and skip to it
    var exitDir = Game.map.findExit(currentRoom, nextRoom);
    if (exitDir < 0) {
        console.log('[ContestedDemolisher] WARNING: ' + creep.name + 
                    ' route has non-adjacent hop ' + currentRoom + ' -> ' + nextRoom + ', seeking skip');
        var skipped = false;
        for (var sk = nextIdx + 1; sk < route.length; sk++) {
            var tryExit = Game.map.findExit(currentRoom, route[sk]);
            if (tryExit > 0) {
                nextRoom = route[sk];
                exitDir = tryExit;
                console.log('[ContestedDemolisher] Skipping to ' + nextRoom + ' (index ' + sk + ')');
                skipped = true;
                break;
            }
        }
        if (!skipped) {
            // Can't find any reachable room on the route - navigate directly
            var endRoom = forward ? creep.memory.targetRoom : creep.memory.homeRoom;
            creep.moveTo(new RoomPosition(25, 25, endRoom), { reusePath: 10 });
            return ERR_NO_PATH;
        }
    }
    if (exitDir < 0) return ERR_NO_PATH;
    
    var exits = creep.room.find(exitDir);
    if (exits.length === 0) return ERR_NO_PATH;
    
    // PathFinder with strict room control
    var goals = exits.map(function(pos) {
        return { pos: pos, range: 0 };
    });
    
    var creepId = creep.id;
    
    var result = PathFinder.search(creep.pos, goals, {
        maxRooms: 1,
        maxOps: 2000,
        plainCost: 2,
        swampCost: 10,
        roomCallback: function(roomName) {
            if (roomName !== currentRoom) return false;
            
            var room = Game.rooms[roomName];
            if (!room) return false;
            
            var costs = new PathFinder.CostMatrix();
            
            room.find(FIND_STRUCTURES).forEach(function(s) {
                if (s.structureType === STRUCTURE_ROAD) {
                    costs.set(s.pos.x, s.pos.y, 1);
                } else if (s.structureType !== STRUCTURE_CONTAINER &&
                           (s.structureType !== STRUCTURE_RAMPART || !s.my)) {
                    costs.set(s.pos.x, s.pos.y, 255);
                }
            });
            
            room.find(FIND_CREEPS).forEach(function(c) {
                if (c.id !== creepId) {
                    costs.set(c.pos.x, c.pos.y, 255);
                }
            });
            
            return costs;
        }
    });
    
    if (result.incomplete || result.path.length === 0) {
        var closestExit = creep.pos.findClosestByRange(exitDir);
        if (closestExit) {
            creep.moveTo(closestExit, { maxRooms: 1, reusePath: 0 });
        }
        return ERR_NO_PATH;
    }
    
    var moveResult = creep.moveByPath(result.path);
    if (moveResult !== OK && moveResult !== ERR_TIRED) {
        if (result.path[0]) {
            var dir = creep.pos.getDirectionTo(result.path[0]);
            creep.move(dir);
        }
    }
    
    return OK;
}

// ---------------------------------------------------------------------------
// EDGE-ONLY ROOM TRANSITION HELPERS (for pair crossing)
// ---------------------------------------------------------------------------

function isEdgePos(pos) {
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

function outwardDirFromEdgePos(pos) {
    if (pos.x === 0) return LEFT;
    if (pos.x === 49) return RIGHT;
    if (pos.y === 0) return TOP;
    if (pos.y === 49) return BOTTOM;
    return null;
}

function getEdgeExitPosToRoom(creep, destRoomName) {
    var exitDir = creep.room.findExitTo(destRoomName);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return null;
    
    var closest = creep.pos.findClosestByPath(exitDir);
    if (!closest) return null;
    
    var x = closest.x;
    var y = closest.y;
    
    if (exitDir === FIND_EXIT_LEFT) x = 0;
    else if (exitDir === FIND_EXIT_RIGHT) x = 49;
    else if (exitDir === FIND_EXIT_TOP) y = 0;
    else if (exitDir === FIND_EXIT_BOTTOM) y = 49;
    
    return new RoomPosition(x, y, creep.room.name);
}

function ensureCrossState(demo, finalDestRoom) {
    if (demo.memory.cdCross) return;
    
    var edgePos = getEdgeExitPosToRoom(demo, finalDestRoom);
    if (!edgePos) return;
    
    if (!demo.pos.isEqualTo(edgePos)) return;
    if (!isEdgePos(demo.pos)) return;
    
    var outDir = outwardDirFromEdgePos(demo.pos);
    if (!outDir) return;
    
    demo.memory.cdCross = {
        fromRoom: demo.room.name,
        dir: outDir,
        push: 3
    };
}

/**
 * Run crossing logic for the demolisher.
 * FIX: When the demolisher has entered the TARGET room, skip the blind push
 * phase entirely — the pair needs to start dismantling immediately instead of
 * wasting ticks walking into walls/ramparts under tower fire.
 */
function runCrossingDemolisher(demo, healer, finalDestRoom) {
    var cross = demo.memory.cdCross;
    if (!cross) return false;
    
    if (demo.fatigue > 0) return true;
    if (healer && healer.fatigue > 0) return true;
    
    // Still in the departure room — move to the edge and step across
    if (demo.room.name === cross.fromRoom) {
        if (!isEdgePos(demo.pos)) {
            var edgePos = getEdgeExitPosToRoom(demo, finalDestRoom);
            if (edgePos) demo.moveTo(edgePos, { range: 0, reusePath: 5 });
            demo.memory.cdState = 'moving';
            return true;
        }
        
        demo.move(cross.dir);
        demo.memory.cdState = 'moving';
        return true;
    }
    
    // === We have crossed into a new room ===
    
    // If this is the TARGET room, we still need to clear the entry tile so
    // the healer can cross behind us. Allow exactly 1 push tick. The push
    // logic below handles blocked tiles gracefully (stops if the next tile
    // has a wall/rampart/obstacle), so this is safe even if defences are
    // right at the edge.
    if (demo.room.name === demo.memory.targetRoom) {
        if (cross.push > 1) cross.push = 1;
    }
    
    // Push inward a few tiles so the healer has room to cross behind us,
    // but stop early if the next tile is blocked.
    if (cross.push > 0) {
        // Check whether the tile in the push direction is walkable
        var dx = 0;
        var dy = 0;
        if (cross.dir === LEFT) dx = -1;
        else if (cross.dir === RIGHT) dx = 1;
        else if (cross.dir === TOP) dy = -1;
        else if (cross.dir === BOTTOM) dy = 1;
        
        var nextX = demo.pos.x + dx;
        var nextY = demo.pos.y + dy;
        
        // Bounds check (don't push off the other edge)
        if (nextX < 1 || nextX > 48 || nextY < 1 || nextY > 48) {
            delete demo.memory.cdCross;
            return false;
        }
        
        // Check for blocking structures on the next tile
        var blocked = false;
        var structs = demo.room.lookForAt(LOOK_STRUCTURES, nextX, nextY);
        for (var si = 0; si < structs.length; si++) {
            var s = structs[si];
            if (s.structureType === STRUCTURE_WALL) { blocked = true; break; }
            if (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic) { blocked = true; break; }
            if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) { blocked = true; break; }
        }
        
        // Also check terrain
        if (!blocked) {
            var terrain = demo.room.getTerrain();
            if (terrain.get(nextX, nextY) === TERRAIN_MASK_WALL) {
                blocked = true;
            }
        }
        
        if (blocked) {
            // Stop pushing — we're next to an obstacle
            delete demo.memory.cdCross;
            return false;
        }
        
        demo.move(cross.dir);
        cross.push = cross.push - 1;
        demo.memory.cdState = 'moving';
        return true;
    }
    
    delete demo.memory.cdCross;
    return false;
}

function runCrossingHealer(healer, demo) {
    var cross = demo.memory.cdCross;
    if (!cross) return false;
    
    if (healer.room.name === demo.room.name) return false;
    
    if (healer.fatigue > 0) return true;
    
    if (isEdgePos(healer.pos)) {
        healer.move(cross.dir);
        return true;
    }
    
    var edgePos = getEdgeExitPosToRoom(healer, demo.room.name);
    if (edgePos) healer.moveTo(edgePos, { range: 0, reusePath: 5 });
    return true;
}

// ---------------------------------------------------------------------------
// HEALER
// ---------------------------------------------------------------------------

function runHealer(healer) {
    var demo = findPartner(healer, 'demolisher');
    if (!demo) {
        // Give a brief grace window in case the demolisher hasn't spawned yet
        if (!healer.memory.partnerGraceTick) {
            healer.memory.partnerGraceTick = Game.time;
        }
        if (Game.time - healer.memory.partnerGraceTick > 5) {
            healer.suicide();
        }
        return;
    }
    delete healer.memory.partnerGraceTick;

    if (demo.spawning) {
        if (healer.hits < healer.hitsMax) healer.heal(healer);
        return;
    }
    
    if (healer.hits < healer.hitsMax) healer.heal(healer);
    
    if (runCrossingHealer(healer, demo)) return;
    
    if (healer.room.name !== demo.room.name) {
        // Use route-based navigation to reach demo
        if (!healer.memory.route) {
            // Copy route from order if available
            var order = _.find(Memory.contestedDemolisherOrders, function(o) {
                return o && o.squadId === healer.memory.squadId;
            });
            if (order && order.route) {
                healer.memory.route = order.route;
                healer.memory.routeBack = order.routeBack;
            }
        }
        followRoomRoute(healer, true);
        return;
    }
    
    if (demo.hits < demo.hitsMax) {
        if (healer.pos.getRangeTo(demo) <= 1) healer.heal(demo);
        else healer.rangedHeal(demo);
    }
    
    var state = demo.memory.cdState;
    
    if (state === 'moving') {
        healer.moveTo(demo, { range: 0, reusePath: 1 });
        return;
    }
    
    // FIX: When in the target room, avoid standing on edge tiles to prevent
    // accidental room-boundary oscillation.
    if (healer.room.name === healer.memory.targetRoom && isEdgePos(healer.pos)) {
        // Step inward toward the demolisher
        healer.moveTo(demo, { range: 1, reusePath: 0 });
        return;
    }
    
    if (healer.pos.getRangeTo(demo) > 1) {
        healer.moveTo(demo, { range: 1, reusePath: 3 });
    }
}

// ---------------------------------------------------------------------------
// DEMOLISHER (LEADER)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective target mode for a creep, with backward compatibility.
 * Checks creep memory first, then falls back to the order.
 */
function resolveTargetMode(creep) {
    // New field takes priority
    if (creep.memory.targetMode) return creep.memory.targetMode;
    // Legacy boolean
    if (creep.memory.towersOnly) return 'towers';
    // Check the order
    var order = _.find(Memory.contestedDemolisherOrders, function(o) {
        return o && o.squadId === creep.memory.squadId;
    });
    if (order) {
        if (order.targetMode) return order.targetMode;
        if (order.towersOnly) return 'towers';
    }
    return 'all';
}

function runDemolisher(demo) {
    var healer = findPartner(demo, 'healer');
    
    demo.memory.cdState = 'waiting';

    // "alone" means the healer is not present in the target room with us —
    // covers: healer dead, healer respawning in base, healer still en route.
    var inTargetRoom = demo.room.name === demo.memory.targetRoom;
    var healerHere   = healer && healer.room.name === demo.room.name;
    var aloneInTargetRoom = inTargetRoom && !healerHere;

    if (!healer && !aloneInTargetRoom) return;
    if (healer && healer.spawning && !aloneInTargetRoom) return;

    // Mark operation as active once both creeps are ready
    if (!demo.memory.operationMarkedActive) {
        markOperationActive(demo.memory.squadId);
        demo.memory.operationMarkedActive = true;
    }

    // Ensure route is cached on creep memory
    if (!demo.memory.route) {
        var order = _.find(Memory.contestedDemolisherOrders, function(o) {
            return o && o.squadId === demo.memory.squadId;
        });
        if (order && order.route) {
            demo.memory.route = order.route;
            demo.memory.routeBack = order.routeBack;
        }
    }

    var targetRoom = demo.memory.targetRoom;

    if (demo.memory.cdCross) {
        runCrossingDemolisher(demo, healer, targetRoom);
        return;
    }

    // Pair spacing — only enforce when healer is actually alongside us
    if (healerHere) {
        if (demo.pos.getRangeTo(healer) > 1) return;
    }

    // ── FATIGUE: movement is blocked, but we can still dismantle in place ──
    var fatigued = demo.fatigue > 0 || (healer && healer.fatigue > 0);
    if (fatigued) {
        if (inTargetRoom) {
            var targetMode = resolveTargetMode(demo);
            var fatigueTarget = findHostileStructureTarget(demo, targetMode);
            if (fatigueTarget && demo.pos.getRangeTo(fatigueTarget) <= 1) {
                demo.memory.cdState = 'dismantling';
                demo.dismantle(fatigueTarget);
            }
        }
        return;
    }

    // Not in target room - navigate using route
    if (demo.room.name !== targetRoom) {
        var route = demo.memory.route;
        if (route) {
            var currentIdx = route.indexOf(demo.room.name);
            var nextRoom = currentIdx >= 0 && currentIdx < route.length - 1 ? route[currentIdx + 1] : null;

            if (nextRoom) {
                var edgePos = getEdgeExitPosToRoom(demo, nextRoom);

                if (edgePos && demo.pos.getRangeTo(edgePos) <= 1) {
                    if (!demo.pos.isEqualTo(edgePos)) {
                        demo.memory.cdState = 'moving';
                        demo.moveTo(edgePos, { range: 0, reusePath: 5 });
                        return;
                    }

                    ensureCrossState(demo, nextRoom);
                    if (demo.memory.cdCross) {
                        demo.memory.cdState = 'moving';
                        runCrossingDemolisher(demo, healer, nextRoom);
                    }
                    return;
                }
            }
        }

        demo.memory.cdState = 'moving';
        followRoomRoute(demo, true);
        return;
    }

    // =========================================================================
    // IN TARGET ROOM: Find target and breach walls if needed
    // =========================================================================

    // Free entry tile so healer can follow (only when healer isn't here yet)
    if (isEdgePos(demo.pos) && !healerHere) {
        demo.memory.cdState = 'moving';

        var terrain = demo.room.getTerrain();

        var inwardDx = 0;
        var inwardDy = 0;
        if (demo.pos.y === 0)  inwardDy = 1;
        else if (demo.pos.y === 49) inwardDy = -1;
        else if (demo.pos.x === 0)  inwardDx = 1;
        else if (demo.pos.x === 49) inwardDx = -1;

        function isTileWalkable(x, y) {
            if (x < 0 || x > 49 || y < 0 || y > 49) return false;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
            var structs = demo.room.lookForAt(LOOK_STRUCTURES, x, y);
            for (var si = 0; si < structs.length; si++) {
                var st = structs[si];
                if (st.structureType === STRUCTURE_WALL) return false;
                if (st.structureType === STRUCTURE_RAMPART && !st.my && !st.isPublic) return false;
                if (OBSTACLE_OBJECT_TYPES.indexOf(st.structureType) !== -1) return false;
            }
            return true;
        }

        var inX = demo.pos.x + inwardDx;
        var inY = demo.pos.y + inwardDy;
        if (isTileWalkable(inX, inY)) {
            demo.move(demo.pos.getDirectionTo(inX, inY));
            return;
        }

        var lateralDirs = inwardDy !== 0
            ? [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }]
            : [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

        for (var li = 0; li < lateralDirs.length; li++) {
            var lx = demo.pos.x + lateralDirs[li].dx;
            var ly = demo.pos.y + lateralDirs[li].dy;
            if (lx < 0 || lx > 49 || ly < 0 || ly > 49) continue;
            if ((lx === 0 || lx === 49) && (ly === 0 || ly === 49)) continue;
            if (isTileWalkable(lx, ly)) {
                demo.move(demo.pos.getDirectionTo(lx, ly));
                return;
            }
        }

        for (var di = 0; di < lateralDirs.length; di++) {
            var diagX = demo.pos.x + inwardDx + lateralDirs[di].dx;
            var diagY = demo.pos.y + inwardDy + lateralDirs[di].dy;
            if (diagX < 0 || diagX > 49 || diagY < 0 || diagY > 49) continue;
            if ((diagX === 0 || diagX === 49) && (diagY === 0 || diagY === 49)) continue;
            if (isTileWalkable(diagX, diagY)) {
                demo.move(demo.pos.getDirectionTo(diagX, diagY));
                return;
            }
        }

        demo.memory.cdState = 'waiting';
        return;
    }

    var targetMode = resolveTargetMode(demo);
    var target = findHostileStructureTarget(demo, targetMode);
    if (!target) return;

    if (demo.pos.getRangeTo(target) > 1) {
        demo.memory.cdState = 'moving';
        moveToBreaching(demo, target);
    } else {
        demo.memory.cdState = 'dismantling';
        demo.dismantle(target);
    }
}
// ---------------------------------------------------------------------------
// BREACH-AWARE MOVEMENT
// ---------------------------------------------------------------------------

/**
 * Move toward a target using breach-aware pathfinding.
 * Treats walls/ramparts as very expensive (not impassable) so PathFinder
 * produces a path that goes THROUGH them. The creep follows this path
 * until it is adjacent to a wall/rampart, then stops (so it can dismantle).
 */
function moveToBreaching(creep, target) {
    var creepId = creep.id;
    var roomName = creep.room.name;
    
    var result = PathFinder.search(creep.pos, { pos: target.pos, range: 1 }, {
        maxRooms: 1,
        maxOps: 4000,
        plainCost: 2,
        swampCost: 10,
        roomCallback: function(rn) {
            if (rn !== roomName) return false;
            
            var room = Game.rooms[rn];
            if (!room) return false;
            
            var costs = new PathFinder.CostMatrix();
            
            room.find(FIND_STRUCTURES).forEach(function(s) {
                if (s.structureType === STRUCTURE_ROAD) {
                    costs.set(s.pos.x, s.pos.y, 1);
                } else if (s.structureType === STRUCTURE_WALL) {
                    // Expensive but passable - PathFinder routes through them
                    costs.set(s.pos.x, s.pos.y, 50);
                } else if (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic) {
                    costs.set(s.pos.x, s.pos.y, 50);
                } else if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) {
                    costs.set(s.pos.x, s.pos.y, 255);
                }
            });
            
            room.find(FIND_CREEPS).forEach(function(c) {
                if (c.id !== creepId) {
                    costs.set(c.pos.x, c.pos.y, 255);
                }
            });
            
            return costs;
        }
    });
    
    if (result.incomplete || result.path.length === 0) {
        // Fallback: just moveTo normally
        creep.moveTo(target, { reusePath: 3 });
        return;
    }
    
    // Walk the path but stop before stepping onto a wall/rampart tile
    // (the creep needs to be ADJACENT to dismantle, not ON TOP of it)
    var nextStep = result.path[0];
    if (nextStep) {
        // Check if the next step has a wall/rampart we need to dismantle first
        var structsOnNext = creep.room.lookForAt(LOOK_STRUCTURES, nextStep.x, nextStep.y);
        var hasBarrier = false;
        for (var i = 0; i < structsOnNext.length; i++) {
            var s = structsOnNext[i];
            if (s.structureType === STRUCTURE_WALL || 
                (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic)) {
                hasBarrier = true;
                break;
            }
        }
        
        if (hasBarrier) {
            // Don't move - we're adjacent to a barrier, stay put and let
            // the main loop call dismantle on findHostileStructureTarget's result
            return;
        }
        
        // Safe to move
        var dir = creep.pos.getDirectionTo(nextStep);
        creep.move(dir);
    }
}

// ---------------------------------------------------------------------------
// TARGETING
// ---------------------------------------------------------------------------

/**
 * Find the best hostile structure target, with breach-path awareness.
 * 
 * @param {Creep} creep
 * @param {string} targetMode - 'all', 'towers', or 'military'
 *
 * Priority order:
 * 1. Reachable valuable structures (filtered by targetMode)
 * 2. Wall/rampart blocking the path to the nearest valuable structure
 * 3. Weakest wall/rampart (fallback when no valuables remain)
 */
function findHostileStructureTarget(creep, targetMode) {
    var room = creep.room;
    
    // Step 1: Find all valuable (non-barrier) hostile structures
    var valuableTargets = room.find(FIND_STRUCTURES, {
        filter: function (s) {
            if (s.my) return false;
            
            if (targetMode === 'towers') {
                return s.structureType === STRUCTURE_TOWER;
            }
            
            if (targetMode === 'military') {
                return MILITARY_STRUCTURE_PRIORITY.indexOf(s.structureType) !== -1;
            }
            
            // 'all' mode — everything except roads/containers/controllers/portals/barriers
            if (s.structureType === STRUCTURE_ROAD) return false;
            if (s.structureType === STRUCTURE_CONTAINER) return false;
            if (s.structureType === STRUCTURE_CONTROLLER) return false;
            if (s.structureType === STRUCTURE_PORTAL) return false;
            if (s.structureType === STRUCTURE_WALL) return false;
            if (s.structureType === STRUCTURE_RAMPART) return false;
            
            return true;
        }
    });
    
    // No valuable structures left: breach the weakest barrier
    if (valuableTargets.length === 0) {
        var barriers = room.find(FIND_STRUCTURES, {
            filter: function (s) {
                if (s.my) return false;
                return s.structureType === STRUCTURE_WALL ||
                       s.structureType === STRUCTURE_RAMPART;
            }
        });
        
        if (barriers.length === 0) return null;
        
        // Target the lowest-HP barrier as the breach point
        return _.min(barriers, 'hits');
    }
    
    // Step 1b (military mode only): Sort by priority so we target towers
    // before nukers, nukers before power spawns, etc.
    if (targetMode === 'military' && valuableTargets.length > 1) {
        valuableTargets.sort(function(a, b) {
            var priA = MILITARY_STRUCTURE_PRIORITY.indexOf(a.structureType);
            var priB = MILITARY_STRUCTURE_PRIORITY.indexOf(b.structureType);
            if (priA !== priB) return priA - priB;
            // Same type — prefer the closer one
            return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
        });
    }
    
    // Step 2: Find the best target.
    // For military mode, pick the highest-priority reachable structure.
    // For other modes, pick the closest.
    var closest;
    if (targetMode === 'military') {
        // Try each target in priority order; pick the first one we can
        // path to (or breach to). Fall through to breach logic below if
        // none are directly reachable.
        closest = valuableTargets[0]; // highest priority, closest of its type
    } else {
        closest = creep.pos.findClosestByRange(valuableTargets);
    }
    if (!closest) return null;
    
    // Step 3: Check if we can reach it without going through walls
    var directPath = PathFinder.search(creep.pos, { pos: closest.pos, range: 1 }, {
        maxRooms: 1,
        maxOps: 3000,
        roomCallback: function(rn) {
            var r = Game.rooms[rn];
            if (!r) return false;
            
            var costs = new PathFinder.CostMatrix();
            
            r.find(FIND_STRUCTURES).forEach(function(s) {
                if (s.structureType === STRUCTURE_ROAD) {
                    costs.set(s.pos.x, s.pos.y, 1);
                } else if (s.structureType === STRUCTURE_WALL) {
                    costs.set(s.pos.x, s.pos.y, 255);
                } else if (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic) {
                    costs.set(s.pos.x, s.pos.y, 255);
                } else if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) {
                    costs.set(s.pos.x, s.pos.y, 255);
                }
            });
            
            return costs;
        }
    });
    
    // If we can reach the target directly, go for it
    if (!directPath.incomplete) {
        return closest;
    }
    
    // Step 4: Path is blocked by walls/ramparts. Find the breach point.
    // Pathfind THROUGH walls (expensive but passable) to determine which
    // barrier to dismantle first.
    var breachPath = PathFinder.search(creep.pos, { pos: closest.pos, range: 1 }, {
        maxRooms: 1,
        maxOps: 4000,
        plainCost: 2,
        swampCost: 10,
        roomCallback: function(rn) {
            var r = Game.rooms[rn];
            if (!r) return false;
            
            var costs = new PathFinder.CostMatrix();
            
            r.find(FIND_STRUCTURES).forEach(function(s) {
                if (s.structureType === STRUCTURE_ROAD) {
                    costs.set(s.pos.x, s.pos.y, 1);
                } else if (s.structureType === STRUCTURE_WALL) {
                    // Treat walls as expensive but traversable for path planning
                    costs.set(s.pos.x, s.pos.y, 50);
                } else if (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic) {
                    costs.set(s.pos.x, s.pos.y, 50);
                } else if (OBSTACLE_OBJECT_TYPES.indexOf(s.structureType) !== -1) {
                    costs.set(s.pos.x, s.pos.y, 255);
                }
            });
            
            return costs;
        }
    });
    
    if (!breachPath.incomplete && breachPath.path.length > 0) {
        // Find the first barrier tile on the breach path
        var firstBarrierPos = null;

        for (var i = 0; i < breachPath.path.length; i++) {
            var pos = breachPath.path[i];
            var structsAtPos = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
            
            for (var j = 0; j < structsAtPos.length; j++) {
                var s = structsAtPos[j];
                if (s.structureType === STRUCTURE_WALL || 
                    (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic)) {
                    firstBarrierPos = pos;
                    break;
                }
            }
            if (firstBarrierPos) break;
        }
        
        if (firstBarrierPos) {
            // Collect ALL barriers adjacent to the creep (range 1) that are
            // also near the breach point (within 2 tiles of the first barrier
            // on the path). This captures the same wall segment while letting
            // us pick the weakest structure in it.
            var candidateBarriers = room.find(FIND_STRUCTURES, {
                filter: function(s) {
                    if (s.my) return false;
                    if (s.structureType !== STRUCTURE_WALL && 
                        !(s.structureType === STRUCTURE_RAMPART && !s.isPublic)) {
                        return false;
                    }
                    // Must be adjacent to creep (range 1) so we can dismantle it
                    if (creep.pos.getRangeTo(s) > 1) return false;
                    // Must be near the breach point so we're breaking the right wall
                    var dx = Math.abs(s.pos.x - firstBarrierPos.x);
                    var dy = Math.abs(s.pos.y - firstBarrierPos.y);
                    return dx <= 2 && dy <= 2;
                }
            });
            
            if (candidateBarriers.length > 0) {
                // Pick the weakest barrier - fastest to break through
                return _.min(candidateBarriers, 'hits');
            }
            
            // Not adjacent yet - return the first barrier on the path
            // so moveToBreaching navigates toward it
            var firstBarrierStructs = room.lookForAt(LOOK_STRUCTURES, 
                firstBarrierPos.x, firstBarrierPos.y);
            for (var fb = 0; fb < firstBarrierStructs.length; fb++) {
                var fbs = firstBarrierStructs[fb];
                if (fbs.structureType === STRUCTURE_WALL || 
                    (fbs.structureType === STRUCTURE_RAMPART && !fbs.my && !fbs.isPublic)) {
                    return fbs;
                }
            }
        }
    }
    
    // Step 5: Fallback - target the weakest barrier adjacent to the creep,
    // or nearest barrier if none adjacent
    var adjacentBarriers = room.find(FIND_STRUCTURES, {
        filter: function(s) {
            if (s.my) return false;
            if (s.structureType !== STRUCTURE_WALL && 
                !(s.structureType === STRUCTURE_RAMPART && !s.isPublic)) {
                return false;
            }
            return creep.pos.getRangeTo(s) <= 1;
        }
    });
    
    if (adjacentBarriers.length > 0) {
        return _.min(adjacentBarriers, 'hits');
    }
    
    var nearestBarrier = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: function(s) {
            if (s.my) return false;
            return s.structureType === STRUCTURE_WALL ||
                   s.structureType === STRUCTURE_RAMPART;
        }
    });
    
    return nearestBarrier || null;
}