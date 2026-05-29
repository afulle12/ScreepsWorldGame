// roleRemoteSupplier.js
// ============================================================================
// Remote Supplier
//
// Handles two mission types set in creep.memory.mission:
//
//   'extensions'  Load full carry from homeRoom, travel to targetRoom,
//                 fill extensions then spawns. Any leftover energy is
//                 dumped into storage if present.
//
//   'storage'     Load exactly memory.amountNeeded energy (capped at carry
//                 capacity) from homeRoom, travel to targetRoom, deposit
//                 into storage until it reaches 7500 or creep is empty.


var STORAGE_TARGET = 7500;
var OBSERVER_RANGE = 10;
var MAX_RECOMPUTES = 5;
var SCAN_TIMEOUT   = 6;    // ticks to wait for observer vision before skipping

module.exports = {

    run: function(creep) {
        var mission = creep.memory.mission || 'extensions';

        // ── State transitions ─────────────────────────────────────────────────
        if (creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.working = false;
            creep.say('🏠');
            _clearExitCache(creep);
        }
        if (!creep.memory.working &&
                creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 &&
                creep.room.name === creep.memory.homeRoom) {
            creep.memory.working = true;
            creep.say(mission === 'storage' ? '📦' : '🔌');
            _clearExitCache(creep);
        }

        // Storage mission: transition when loaded enough
        if (!creep.memory.working && mission === 'storage' && creep.memory.amountNeeded) {
            var loaded = creep.store.getUsedCapacity(RESOURCE_ENERGY);
            var needed = Math.min(creep.store.getCapacity(RESOURCE_ENERGY),
                                  creep.memory.amountNeeded);
            if (loaded >= needed) {
                creep.memory.working = true;
                creep.say('📦');
                _clearExitCache(creep);
            }
        }

        if (creep.memory.working) {
            if (mission === 'storage') {
                this._fillStorage(creep);
            } else {
                this._fillExtensions(creep);
            }
        } else {
            this._loadEnergy(creep, mission);
        }
    },

    // ── Load energy from homeRoom ─────────────────────────────────────────────
    _loadEnergy: function(creep, mission) {
        var homeRoom = creep.memory.homeRoom;

        if (creep.room.name !== homeRoom) {
            _followRoute(creep, homeRoom);
            return;
        }

        var room   = creep.room;
        var source = null;

        if (room.storage && room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            source = room.storage;
        } else if (room.terminal &&
                   room.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 5000) {
            source = room.terminal;
        } else {
            var containers = room.find(FIND_STRUCTURES, {
                filter: function(s) {
                    return s.structureType === STRUCTURE_CONTAINER &&
                           s.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
                }
            });
            if (containers.length > 0) {
                source = creep.pos.findClosestByRange(containers);
            }
        }

        if (!source) {
            if (Game.time % 20 === 0) {
                console.log('[RemoteSupplier] ' + creep.name +
                            ': No energy source in ' + homeRoom);
            }
            return;
        }

        // Storage mission: only withdraw what's needed
        var amount = undefined;
        if (mission === 'storage' && creep.memory.amountNeeded) {
            var alreadyHave = creep.store.getUsedCapacity(RESOURCE_ENERGY);
            var stillNeed   = Math.min(
                creep.store.getFreeCapacity(RESOURCE_ENERGY),
                creep.memory.amountNeeded - alreadyHave
            );
            if (stillNeed <= 0) { creep.memory.working = true; return; }
            amount = stillNeed;
        }

        var result = amount !== undefined
            ? creep.withdraw(source, RESOURCE_ENERGY, amount)
            : creep.withdraw(source, RESOURCE_ENERGY);

        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(source, { reusePath: 10,
                                   visualizePathStyle: { stroke: '#aaffaa' } });
        }
    },

    // ── Fill extensions + spawns ──────────────────────────────────────────────
    _fillExtensions: function(creep) {
        if (creep.room.name !== creep.memory.targetRoom) {
            _followRoute(creep, creep.memory.targetRoom);
            return;
        }

        var extensions = creep.room.find(FIND_STRUCTURES, {
            filter: function(s) {
                return s.structureType === STRUCTURE_EXTENSION &&
                       s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
            }
        });

        var target = null;
        if (extensions.length > 0) {
            target = creep.pos.findClosestByRange(extensions);
        } else {
            var spawns = creep.room.find(FIND_STRUCTURES, {
                filter: function(s) {
                    return s.structureType === STRUCTURE_SPAWN &&
                           s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                }
            });
            if (spawns.length > 0) target = creep.pos.findClosestByRange(spawns);
        }

        // Nothing to fill — dump leftovers into storage then finish
        if (!target) {
            var storages = creep.room.find(FIND_STRUCTURES, {
                filter: function(s) {
                    return s.structureType === STRUCTURE_STORAGE &&
                           s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                }
            });
            if (storages.length > 0) {
                var dump = creep.transfer(storages[0], RESOURCE_ENERGY);
                if (dump === ERR_NOT_IN_RANGE) creep.moveTo(storages[0], { reusePath: 5 });
                return;
            }
            creep.memory.working = false;
            creep.say('✅');
            this._signalComplete(creep, 'extensions');
            return;
        }

        var r = creep.transfer(target, RESOURCE_ENERGY);
        if (r === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, { reusePath: 5,
                                   visualizePathStyle: { stroke: '#ffaaaa' } });
        }
    },

    // ── Fill storage up to STORAGE_TARGET ────────────────────────────────────
    _fillStorage: function(creep) {
        if (creep.room.name !== creep.memory.targetRoom) {
            _followRoute(creep, creep.memory.targetRoom);
            return;
        }

        var storages = creep.room.find(FIND_STRUCTURES, {
            filter: function(s) {
                return s.structureType === STRUCTURE_STORAGE &&
                       s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
            }
        });

        if (storages.length === 0) {
            creep.memory.working = false;
            creep.say('✅');
            this._signalComplete(creep, 'storage');
            return;
        }

        var storage       = storages[0];
        var currentEnergy = storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

        if (currentEnergy >= STORAGE_TARGET) {
            creep.memory.working = false;
            creep.say('✅');
            this._signalComplete(creep, 'storage');
            return;
        }

        var deficit    = STORAGE_TARGET - currentEnergy;
        var carrying   = creep.store.getUsedCapacity(RESOURCE_ENERGY);
        var toTransfer = Math.min(carrying, deficit);

        if (toTransfer <= 0) {
            creep.memory.working = false;
            this._signalComplete(creep, 'storage');
            return;
        }

        var result = creep.transfer(storage, RESOURCE_ENERGY, toTransfer);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(storage, { reusePath: 10,
                                    visualizePathStyle: { stroke: '#aaaaff' } });
        } else if (result === OK && carrying - toTransfer <= 0) {
            creep.memory.working = false;
            creep.say('✅');
            this._signalComplete(creep, 'storage');
        } else if (result !== OK) {
            console.log('[RemoteSupplier] ' + creep.name +
                        ': transfer to storage returned ' + result);
        }
    },

    // ── Completion signal ─────────────────────────────────────────────────────
    _signalComplete: function(creep, mission) {
        if (!Memory.remoteSupplyComplete) Memory.remoteSupplyComplete = {};
        var key = creep.memory.homeRoom + '->' + creep.memory.targetRoom + ':' + mission;
        Memory.remoteSupplyComplete[key] = {
            homeRoom:    creep.memory.homeRoom,
            targetRoom:  creep.memory.targetRoom,
            mission:     mission,
            completedAt: Game.time
        };
    }
};

// ============================================================================
// Route state machine
//
// creep.memory._rs = {
//   phase:        'idle' | 'pending' | 'ready' | 'failed'
//   route:        string[]   homeRoom -> targetRoom
//   routeBack:    string[]   targetRoom -> homeRoom
//   toScan:       string[]   rooms still needing observer scan + traversal check
//   pending:      { room, requestedTick } | null
//   blocked:      string[]   rooms confirmed impassable
//   attempts:     number     recompute count
// }
// ============================================================================

/**
 * Top-level entry: initialize state if idle, tick the scanner if pending,
 * then navigate if ready. Called by _followRoute every tick.
 */
function _tickRouteState(creep) {
    if (!creep.memory._rs) {
        creep.memory._rs = {
            phase:    'idle',
            route:    null,
            routeBack: null,
            toScan:   [],
            pending:  null,
            blocked:  [],
            attempts: 0
        };
    }

    var rs = creep.memory._rs;

    if (rs.phase === 'idle') {
        _initRoute(creep, rs);
        return;
    }

    if (rs.phase === 'pending') {
        _scanTick(creep, rs);
        return;
    }

    // 'ready' and 'failed' are terminal — no further ticking needed
}

/**
 * Compute initial route and build the scan queue.
 * If all intermediate rooms are already owned/visible and passable, jump
 * straight to 'ready'. Otherwise enter 'pending'.
 */
function _initRoute(creep, rs) {
    var from = creep.memory.homeRoom;
    var to   = creep.memory.targetRoom;
    if (!from || !to) { rs.phase = 'failed'; return; }

    var route = _computeRoute(from, to, rs.blocked);
    if (!route) {
        console.log('[RemoteSupplier] ' + creep.name +
                    ': findRoute failed ' + from + ' -> ' + to + '. Marking failed.');
        rs.phase = 'failed';
        return;
    }

    rs.route    = route;
    rs.routeBack = route.slice().reverse();

    // Queue intermediate rooms that we don't own for scanning
    rs.toScan = [];
    for (var i = 1; i < route.length - 1; i++) {
        var rn  = route[i];
        var rm  = Game.rooms[rn];
        var own = rm && rm.controller && rm.controller.my;
        if (!own) rs.toScan.push(rn);
    }

    if (rs.toScan.length === 0) {
        rs.phase = 'ready';
        console.log('[RemoteSupplier] ' + creep.name +
                    ': route ready (all rooms owned): ' + route.join(' -> '));
        return;
    }

    rs.phase   = 'pending';
    rs.pending = null;
    console.log('[RemoteSupplier] ' + creep.name +
                ': route computed, scanning ' + rs.toScan.length +
                ' room(s): ' + route.join(' -> '));
}

/**
 * Process one tick of observer scanning / traversal validation.
 *
 * Flow per tick:
 *   A) If a scan was requested last tick, check for vision and validate.
 *   B) If no pending scan, pick the next room and request observation.
 *   C) When toScan is empty, mark route ready.
 */
function _scanTick(creep, rs) {
    // ── A: Process result from last tick's observation ────────────────────────
    if (rs.pending) {
        var pRoom = rs.pending.room;
        var room  = Game.rooms[pRoom];

        if (room) {
            // Vision acquired — run traversal check
            var routeIdx = rs.route.indexOf(pRoom);
            var prev     = routeIdx > 0               ? rs.route[routeIdx - 1] : null;
            var next     = routeIdx < rs.route.length - 1 ? rs.route[routeIdx + 1] : null;

            var passable = (prev && next)
                ? _checkRoomTraversal(pRoom, prev, next)
                : true;  // first/last room — no traversal check needed

            if (passable) {
                // Remove from scan queue, clear pending
                var idx = rs.toScan.indexOf(pRoom);
                if (idx !== -1) rs.toScan.splice(idx, 1);
                rs.pending = null;
            } else {
                // Room is impassable — add to blocked and recompute
                console.log('[RemoteSupplier] ' + creep.name +
                            ': room ' + pRoom + ' failed traversal check. Recomputing route.');
                rs.blocked.push(pRoom);
                rs.pending   = null;
                rs.attempts++;

                if (rs.attempts > MAX_RECOMPUTES) {
                    console.log('[RemoteSupplier] ' + creep.name +
                                ': exhausted recompute attempts. Route failed.');
                    rs.phase = 'failed';
                    return;
                }

                _recomputeRoute(creep, rs);
                return;
            }

        } else if (Game.time - rs.pending.requestedTick >= SCAN_TIMEOUT) {
            // Observer timed out — assume passable and continue
            console.log('[RemoteSupplier] ' + creep.name +
                        ': scan timeout for ' + pRoom + ' — assuming passable.');
            var tidx = rs.toScan.indexOf(pRoom);
            if (tidx !== -1) rs.toScan.splice(tidx, 1);
            rs.pending = null;
        } else {
            // Still waiting for vision — do nothing this tick
            return;
        }
    }

    // ── B: Scan is clear — check if done ─────────────────────────────────────
    if (rs.toScan.length === 0) {
        rs.phase = 'ready';
        console.log('[RemoteSupplier] ' + creep.name +
                    ': route validated and ready: ' + rs.route.join(' -> '));
        return;
    }

    // ── C: Request observation of next room in queue ──────────────────────────
    // First check if we already have natural vision (owned by us, scout, etc.)
    var nextRoom = rs.toScan[0];
    if (Game.rooms[nextRoom]) {
        // Already visible — validate immediately without observer
        var nr       = rs.route.indexOf(nextRoom);
        var nrPrev   = nr > 0               ? rs.route[nr - 1] : null;
        var nrNext   = nr < rs.route.length - 1 ? rs.route[nr + 1] : null;
        var nrPass   = (nrPrev && nrNext)
            ? _checkRoomTraversal(nextRoom, nrPrev, nrNext)
            : true;

        if (nrPass) {
            rs.toScan.shift();
            // Let next call pick the following room
        } else {
            console.log('[RemoteSupplier] ' + creep.name +
                        ': room ' + nextRoom + ' (natural vision) failed traversal. Recomputing.');
            rs.blocked.push(nextRoom);
            rs.toScan.shift();
            rs.attempts++;
            if (rs.attempts > MAX_RECOMPUTES) {
                rs.phase = 'failed';
                return;
            }
            _recomputeRoute(creep, rs);
        }
        return;
    }

    // Need observer
    var observer = _findObserverForRoom(nextRoom);
    if (!observer) {
        console.log('[RemoteSupplier] ' + creep.name +
                    ': no observer in range of ' + nextRoom + ' — skipping (assumed passable).');
        rs.toScan.shift();
        return;
    }

    if (observer.cooldown > 0) {
        return; // Wait for observer to be free
    }

    var result = observer.observeRoom(nextRoom);
    if (result === OK) {
        rs.pending = { room: nextRoom, requestedTick: Game.time };
    } else {
        console.log('[RemoteSupplier] ' + creep.name +
                    ': observeRoom(' + nextRoom + ') returned ' + result);
    }
}

/**
 * Recompute route after a blocked room is discovered.
 * Rebuilds toScan with any new rooms on the new route that haven't been seen.
 */
function _recomputeRoute(creep, rs) {
    var from = creep.memory.homeRoom;
    var to   = creep.memory.targetRoom;

    var newRoute = _computeRoute(from, to, rs.blocked);
    if (!newRoute) {
        console.log('[RemoteSupplier] ' + creep.name +
                    ': no alternative route avoiding ' + rs.blocked.join(', '));
        rs.phase = 'failed';
        return;
    }

    rs.route    = newRoute;
    rs.routeBack = newRoute.slice().reverse();

    // Build new scan queue — only rooms not yet confirmed passable
    var alreadyPassed = {};
    // Rooms that were in old toScan but already processed are no longer there
    // We track this simply: any room NOT in current toScan was already validated
    for (var p = 0; p < rs.toScan.length; p++) {
        alreadyPassed[rs.toScan[p]] = true; // still need scanning
    }

    rs.toScan = [];
    for (var i = 1; i < newRoute.length - 1; i++) {
        var rn  = newRoute[i];
        var rm  = Game.rooms[rn];
        var own = rm && rm.controller && rm.controller.my;
        if (own) continue;
        // Skip rooms we already confirmed as passable (not in old toScan and not blocked)
        if (rs.blocked.indexOf(rn) !== -1) continue;
        rs.toScan.push(rn);
    }

    rs.pending = null;

    console.log('[RemoteSupplier] ' + creep.name +
                ': recomputed route (attempt ' + rs.attempts + '): ' + newRoute.join(' -> ') +
                ' | scan queue: ' + rs.toScan.length + ' room(s)');

    if (rs.toScan.length === 0) {
        rs.phase = 'ready';
        console.log('[RemoteSupplier] ' + creep.name + ': recomputed route validated immediately.');
    }
}

/**
 * Compute a room corridor via Game.map.findRoute, avoiding known blocked rooms.
 * Returns string array [from, ..., to] or null.
 */
function _computeRoute(from, to, blockedRooms) {
    var blockedSet = {};
    if (blockedRooms) {
        for (var b = 0; b < blockedRooms.length; b++) {
            blockedSet[blockedRooms[b]] = true;
        }
    }

    var result = Game.map.findRoute(from, to, {
        routeCallback: function(roomName) {
            if (blockedSet[roomName]) return Infinity;
            var room = Game.rooms[roomName];
            if (room && room.controller && room.controller.owner && !room.controller.my) {
                return Infinity; // Don't transit hostile-owned rooms
            }
            return 1;
        }
    });

    // Fallback with no restrictions except hard blocks
    if (!result || result === ERR_NO_PATH || result.length === 0) {
        result = Game.map.findRoute(from, to, {
            routeCallback: function(roomName) {
                return blockedSet[roomName] ? Infinity : 1;
            }
        });
    }

    if (!result || result === ERR_NO_PATH || result.length === 0) return null;

    var route = [from];
    for (var i = 0; i < result.length; i++) {
        route.push(result[i].room);
    }
    return route;
}

// ============================================================================
// Navigation — exit-by-exit room following
// ============================================================================

/**
 * Navigate the creep toward destRoom (homeRoom or targetRoom).
 * Waits in place if route validation is still in progress.
 */
function _followRoute(creep, destRoom) {
    // Tick the route state machine
    _tickRouteState(creep);

    var rs = creep.memory._rs;
    if (!rs) return;

    if (rs.phase === 'failed') {
        if (Game.time % 20 === 0) {
            console.log('[RemoteSupplier] ' + creep.name +
                        ': route failed — creep stuck. Consider cancelling order.');
        }
        return;
    }

    if (rs.phase !== 'ready') {
        // Validation still running — wait in place
        if (Game.time % 10 === 0) {
            creep.say('🔍');
        }
        return;
    }

    // Route is ready — navigate exit-by-exit
    var isForward   = (destRoom === creep.memory.targetRoom);
    var route       = isForward ? rs.route : rs.routeBack;
    var currentRoom = creep.room.name;

    if (currentRoom === destRoom) return;

    // Bounce prevention: on a room border tile, step inward.
    // maxRooms:1 is critical — without it PathFinder can route back through the
    // previous room (e.g. targetRoom) to reach (25,25), causing a return loop.
    if (creep.pos.x === 0  || creep.pos.x === 49 ||
        creep.pos.y === 0  || creep.pos.y === 49) {
        creep.moveTo(new RoomPosition(25, 25, currentRoom),
                     { reusePath: 3, maxOps: 2000, maxRooms: 1 });
        return;
    }

    // Find position in route
    var idx = -1;
    for (var i = 0; i < route.length; i++) {
        if (route[i] === currentRoom) { idx = i; break; }
    }

    if (idx === -1) {
        // Off route — invalidate and recompute on next tick
        console.log('[RemoteSupplier] ' + creep.name +
                    ': off route in ' + currentRoom + ', resetting route state.');
        delete creep.memory._rs;
        delete creep.memory._exitCache;
        return;
    }

    var nextIdx = idx + 1;
    if (nextIdx >= route.length) {
        creep.moveTo(new RoomPosition(25, 25, destRoom), { reusePath: 5 });
        return;
    }

    var nextRoom = route[nextIdx];

    // Cache exit tile to avoid findClosestByRange every tick
    var cached = creep.memory._exitCache;
    if (!cached || cached.nextRoom !== nextRoom) {
        var exitDir = Game.map.findExit(currentRoom, nextRoom);
        if (exitDir < 0) {
            console.log('[RemoteSupplier] ' + creep.name +
                        ': no exit from ' + currentRoom + ' to ' + nextRoom +
                        ' — resetting route.');
            delete creep.memory._rs;
            delete creep.memory._exitCache;
            return;
        }
        var exitPos = creep.pos.findClosestByRange(exitDir);
        if (!exitPos) {
            creep.moveTo(new RoomPosition(25, 25, destRoom), { reusePath: 5 });
            return;
        }
        creep.memory._exitCache = { nextRoom: nextRoom, x: exitPos.x, y: exitPos.y };
        cached = creep.memory._exitCache;
    }

    // maxRooms:1 keeps pathfinding within currentRoom when navigating to the exit
    // tile — prevents the creep from accidentally looping through adjacent rooms.
    creep.moveTo(new RoomPosition(cached.x, cached.y, currentRoom), {
        reusePath:          20,
        maxOps:             2000,
        maxRooms:           1,
        visualizePathStyle: { stroke: '#ffffff', opacity: 0.2 }
    });
}

/**
 * Clear only the exit tile cache (called on direction changes).
 * Does NOT reset route validation — that persists for the creep's lifetime.
 */
function _clearExitCache(creep) {
    delete creep.memory._exitCache;
}

// ============================================================================
// Observer helpers
// ============================================================================

function _findObserverForRoom(targetRoom) {
    var best = null;
    var bestDist = Infinity;
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        var dist = Game.map.getRoomLinearDistance(roomName, targetRoom);
        if (dist > OBSERVER_RANGE) continue;
        var obs = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_OBSERVER; }
        });
        if (obs.length > 0 && dist < bestDist) {
            best     = obs[0];
            bestDist = dist;
        }
    }
    return best;
}

// ============================================================================
// Route traversal validation (modeled after depositObserver.js)
//
// Checks that a creep entering roomName from prevRoom can actually reach the
// exit toward nextRoom using PathFinder — catches player-built walls/ramparts
// that Game.map.findRoute knows nothing about.
// ============================================================================

function _getEdgeCoords(exitDir) {
    switch (exitDir) {
        case FIND_EXIT_TOP:    return { axis: 'y', value: 0,  range: 'x' };
        case FIND_EXIT_BOTTOM: return { axis: 'y', value: 49, range: 'x' };
        case FIND_EXIT_LEFT:   return { axis: 'x', value: 0,  range: 'y' };
        case FIND_EXIT_RIGHT:  return { axis: 'x', value: 49, range: 'y' };
    }
    return null;
}

function _getEntryDirection(prevRoom, thisRoom) {
    var exitDir = Game.map.findExit(prevRoom, thisRoom);
    switch (exitDir) {
        case FIND_EXIT_TOP:    return FIND_EXIT_BOTTOM;
        case FIND_EXIT_BOTTOM: return FIND_EXIT_TOP;
        case FIND_EXIT_LEFT:   return FIND_EXIT_RIGHT;
        case FIND_EXIT_RIGHT:  return FIND_EXIT_LEFT;
    }
    return -1;
}

function _pickRandomEdgeTile(roomName, edgeDir) {
    var terrain = Game.map.getRoomTerrain(roomName);
    if (!terrain) return null;
    var coords = _getEdgeCoords(edgeDir);
    if (!coords) return null;
    var walkable = [];
    for (var i = 0; i < 50; i++) {
        var x = coords.axis === 'x' ? coords.value : i;
        var y = coords.axis === 'y' ? coords.value : i;
        if (terrain.get(x, y) !== TERRAIN_MASK_WALL) walkable.push({ x: x, y: y });
    }
    if (walkable.length === 0) return null;
    var pick = walkable[Math.floor(walkable.length / 2)]; // middle tile, deterministic
    return new RoomPosition(pick.x, pick.y, roomName);
}

function _getEdgeGoals(roomName, edgeDir) {
    var terrain = Game.map.getRoomTerrain(roomName);
    if (!terrain) return [];
    var coords = _getEdgeCoords(edgeDir);
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

function _buildRoomCostMatrix(roomName) {
    var room   = Game.rooms[roomName];
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

/**
 * Check that a creep can traverse roomName from prevRoom's exit edge to
 * nextRoom's entry edge. Returns true if passable.
 */
function _checkRoomTraversal(roomName, prevRoom, nextRoom) {
    var entryDir = _getEntryDirection(prevRoom, roomName);
    var exitDir  = Game.map.findExit(roomName, nextRoom);
    if (entryDir < 0 || exitDir < 0) return false;

    var startPos = _pickRandomEdgeTile(roomName, entryDir);
    if (!startPos) return false;

    var goals = _getEdgeGoals(roomName, exitDir);
    if (goals.length === 0) return false;

    var result = PathFinder.search(startPos, goals, {
        plainCost: 2,
        swampCost: 10,
        maxOps:    4000,
        maxRooms:  1,
        roomCallback: function(rName) {
            if (rName !== roomName) return false;
            return _buildRoomCostMatrix(rName);
        }
    });

    return !result.incomplete;
}