// roleContestedDemolisher.js
// ============================================================================
// ROLE: Contested Demolisher (Pair)
//
// USAGE (Console):
// orderContestedDemolisher('E4N49', 'E4N51')
// orderContestedDemolisher('E4N49', 'E4N51', true)  // towers only
// cancelContestedDemolisherOrder('E4N51')
// getContestedDemolisherStatus()
// resetContestedDemolisherOrder('E5N52')
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
 * Select the best route from valid cross-sector paths
 */
function selectBestCrossSectorRoute(originRoom, targetRoom, validPaths) {
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

global.orderContestedDemolisher = function (spawnRoomName, targetRoomName, towersOnly) {
    if (!spawnRoomName || !targetRoomName) {
        console.log('Usage: orderContestedDemolisher("spawnRoom", "targetRoom", towersOnly?)');
        console.log('  towersOnly: optional boolean, if true only targets towers');
        return;
    }
    
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
        createSameSectorOrder(spawnRoomName, targetRoomName, towersOnly, observerInfo);
    } else {
        createCrossSectorOrder(spawnRoomName, targetRoomName, towersOnly, observerInfo);
    }
};

function createSameSectorOrder(spawnRoomName, targetRoomName, towersOnly, observerInfo) {
    var targetForRoute = targetRoomName;
    var routeResult = Game.map.findRoute(spawnRoomName, targetRoomName, {
        routeCallback: function(roomName) {
            return getRoomRouteCost(roomName, null, targetForRoute);
        }
    });
    
    if (!routeResult || routeResult === ERR_NO_PATH || routeResult.length === 0) {
        console.log('[ContestedDemolisher] Cannot find direct route - falling back to cross-sector routing');
        createCrossSectorOrder(spawnRoomName, targetRoomName, towersOnly, observerInfo);
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
        towersOnly: !!towersOnly,
        status: 'scanning',
        crossSector: false,
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
    
    var modeStr = towersOnly ? ' (TOWERS ONLY)' : '';
    console.log('[ContestedDemolisher] Created SAME-SECTOR order for ' + targetRoomName + modeStr);
    console.log('[ContestedDemolisher] Route: ' + route.join(' -> '));
    console.log('[ContestedDemolisher] Observer in: ' + observerInfo.roomName + ' (distance ' + observerInfo.distance + ')');
    console.log('[ContestedDemolisher] Rooms to scan: ' + roomsToScan.join(', '));
}

function createCrossSectorOrder(spawnRoomName, targetRoomName, towersOnly, observerInfo) {
    // For cross-sector, we need to find rooms adjacent to the target to start BFS from
    // Run BFS from ALL neighbors to get comprehensive path options
    var neighbors = getRoomNeighbors(targetRoomName);
    
    if (neighbors.length === 0) {
        console.log('[ContestedDemolisher] Cannot start: target room has no accessible neighbors');
        return;
    }
    
    console.log('[ContestedDemolisher] Cross-sector: BFS from all ' + neighbors.length + ' neighbors of target');
    
    // BFS from ALL neighbors to find paths to highways
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
    
    // Deduplicate rooms to scan (include target room)
    var roomsToScan = deduplicateRooms(candidatePaths);
    if (roomsToScan.indexOf(targetRoomName) === -1) {
        roomsToScan.push(targetRoomName);
    }
    
    var squadId = 'cd-' + spawnRoomName + '-' + targetRoomName + '-' + Game.time;
    
    Memory.contestedDemolisherOrders.push({
        homeRoom: spawnRoomName,
        targetRoom: targetRoomName,
        squadId: squadId,
        towersOnly: !!towersOnly,
        status: 'scanning',
        crossSector: true,
        route: null, // Will be determined after scanning
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
            lastProgressTick: Game.time
        }
    });
    
    var modeStr = towersOnly ? ' (TOWERS ONLY)' : '';
    console.log('[ContestedDemolisher] Created CROSS-SECTOR order for ' + targetRoomName + modeStr);
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
        
        console.log('');
        console.log('Order: ' + op.homeRoom + ' -> ' + op.targetRoom);
        console.log('  Squad ID: ' + op.squadId);
        console.log('  Status: ' + (op.status || 'unknown'));
        console.log('  Cross-Sector: ' + (op.crossSector ? 'YES' : 'NO'));
        console.log('  Towers Only: ' + (op.towersOnly ? 'YES' : 'no'));
        console.log('  Creeps: ' + demolishers.length + ' demolisher(s), ' + healers.length + ' healer(s)');
        console.log('  Route: ' + (op.route ? op.route.join(' -> ') : 'N/A'));
        
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
    order.scanData = {
        roomsToScan: roomsToScan,
        scannedRooms: {},
        routePassability: {},
        blockedRooms: [],
        pendingScan: null,
        candidatePaths: order.scanData ? order.scanData.candidatePaths : null,
        validPaths: [],
        invalidatedPaths: [],
        lastProgressTick: Game.time
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
    
    var toRemove = [];
    
    for (var i = 0; i < orders.length; i++) {
        var op = orders[i];
        if (!op) {
            toRemove.push(i);
            continue;
        }
        
        // Only check active operations for completion
        if (op.status === 'active') {
            var squadCreeps = _.filter(Game.creeps, function(c) {
                return c.memory.role === 'contestedDemolisher' && 
                       c.memory.squadId === op.squadId;
            });
            
            if (squadCreeps.length === 0) {
                // No creeps left - operation complete
                console.log('[ContestedDemolisher] Operation ' + op.homeRoom + ' -> ' + op.targetRoom + ' COMPLETE (no creeps remaining)');
                toRemove.push(i);
            }
        }
        
        // Also check for ready operations that have been waiting too long without spawning
        if (op.status === 'ready' && op.readyTick) {
            // If ready for more than 3000 ticks without any creeps, assume abandoned
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
    
    // Remove completed operations (in reverse order to preserve indices)
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
    
    // TARGET ROOM: Skip safety checks - the target is EXPECTED to be hostile!
    if (isTarget) {
        scanData.routePassability[roomName] = true;
        scanData.scannedRooms[roomName] = {
            tick: Game.time,
            passable: true,
            reason: 'target_room_hostile_allowed'
        };
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
    
    // Target room is always allowed (it's hostile, that's the point!)
    if (isTarget) {
        scanData.routePassability[roomName] = true;
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
    
    op.status = 'ready';
    op.readyTick = Game.time;
    console.log('[ContestedDemolisher] ✓ Operation ' + op.homeRoom + ' -> ' + op.targetRoom + ' is READY');
    console.log('[ContestedDemolisher] Final route: ' + op.route.join(' -> '));
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
    
    // Select best route
    var bestRoute = selectBestCrossSectorRoute(op.homeRoom, op.targetRoom, validPaths);
    
    if (!bestRoute) {
        console.log('[ContestedDemolisher] FAILED: Could not select best route');
        op.status = 'failed';
        op.failReason = 'no_valid_route';
        return;
    }
    
    console.log('[ContestedDemolisher] Selected route via highway ' + bestRoute.highwayEntry + ' (total length: ' + bestRoute.totalLength + ')');
    
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
    
    // Add route to highway
    for (var r = 0; r < routeToHighway.length; r++) {
        fullRoute.push(routeToHighway[r].room);
    }
    
    // Add BFS path reversed (highway -> entry room)
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
    
    console.log('[ContestedDemolisher] Full route: ' + fullRoute.join(' -> '));
    
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
    
    // Find exit direction
    var exitDir = Game.map.findExit(currentRoom, nextRoom);
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

function runCrossingDemolisher(demo, healer, finalDestRoom) {
    var cross = demo.memory.cdCross;
    if (!cross) return false;
    
    if (demo.fatigue > 0) return true;
    if (healer && healer.fatigue > 0) return true;
    
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
    
    if (cross.push > 0) {
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
        if (healer.hits < healer.hitsMax) healer.heal(healer);
        return;
    }
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
    
    if (healer.pos.getRangeTo(demo) > 1) {
        healer.moveTo(demo, { range: 1, reusePath: 3 });
    }
}

// ---------------------------------------------------------------------------
// DEMOLISHER (LEADER)
// ---------------------------------------------------------------------------

function runDemolisher(demo) {
    var healer = findPartner(demo, 'healer');
    
    demo.memory.cdState = 'waiting';
    
    if (!healer) return;
    if (healer.spawning) return;
    
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
    
    if (demo.room.name === healer.room.name) {
        if (demo.pos.getRangeTo(healer) > 1) return;
    }
    
    if (demo.fatigue > 0) return;
    if (healer.fatigue > 0) return;
    
    // Not in target room - navigate using route
    if (demo.room.name !== targetRoom) {
        // Check if we need the crossing mechanic (approaching room boundary)
        var route = demo.memory.route;
        if (route) {
            var currentIdx = route.indexOf(demo.room.name);
            var nextRoom = currentIdx >= 0 && currentIdx < route.length - 1 ? route[currentIdx + 1] : null;
            
            if (nextRoom) {
                var edgePos = getEdgeExitPosToRoom(demo, nextRoom);
                
                if (edgePos && demo.pos.getRangeTo(edgePos) <= 1) {
                    // Near edge - use crossing mechanic for pair synchronization
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
        
        // Not near edge - use PathFinder-based route following
        demo.memory.cdState = 'moving';
        followRoomRoute(demo, true);
        return;
    }
    
    // In target room: dismantle
    var towersOnly = demo.memory.towersOnly || false;
    var target = findHostileStructureTarget(demo, towersOnly);
    if (!target) return;
    
    if (demo.pos.getRangeTo(target) > 1) {
        demo.memory.cdState = 'moving';
        demo.moveTo(target, { reusePath: 3 });
    } else {
        demo.memory.cdState = 'dismantling';
        demo.dismantle(target);
    }
}

// ---------------------------------------------------------------------------
// TARGETING
// ---------------------------------------------------------------------------

function findHostileStructureTarget(creep, towersOnly) {
    var targets = creep.room.find(FIND_STRUCTURES, {
        filter: function (s) {
            if (s.my) return false;
            
            if (towersOnly) {
                return s.structureType === STRUCTURE_TOWER;
            }
            
            if (s.structureType === STRUCTURE_ROAD) return false;
            if (s.structureType === STRUCTURE_CONTAINER) return false;
            if (s.structureType === STRUCTURE_CONTROLLER) return false;
            if (s.structureType === STRUCTURE_PORTAL) return false;
            
            return true;
        }
    });
    
    if (targets.length === 0) return null;
    return creep.pos.findClosestByRange(targets);
}