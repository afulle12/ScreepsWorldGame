/**
 * roomNavigation.js
 *
 * Returns fully verified room-to-room paths.
 * Output format: ['W1N1', 'W1N0', 'W2N0', 'W3N0', 'W3N1']
 */
const roomNavigation = {
    DEBUG: false,

    ensureRoute: function (creep, fromRoom, toRoom, routeKey, bannedRooms) {
        fromRoom = fromRoom.toUpperCase();
        toRoom = toRoom.toUpperCase();
        bannedRooms = bannedRooms || [];
        const indexKey = routeKey + 'Index';

        if (fromRoom === toRoom) {
            const trivial = [fromRoom];
            creep.memory[routeKey] = trivial;
            delete creep.memory[indexKey];
            return trivial;
        }

        // --- Attempt to reuse cached route if it still passes validation ---
        const cached = creep.memory[routeKey];
        if (cached && Array.isArray(cached) && cached.length > 0) {
            if (cached[0] === fromRoom && cached[cached.length - 1] === toRoom) {
                let stillValid = true;
                for (let i = 0; i < cached.length - 1; i++) {
                    const edgeKey = cached[i] + ':' + cached[i + 1];
                    const blockedEdges = (Memory.depositObserver && Memory.depositObserver.blockedEdges) || {};
                    if (blockedEdges[edgeKey]) {
                        stillValid = false;
                        break;
                    }
                    // Live re-check when we have vision
                    if (Game.rooms[cached[i]] && !this.validateEdgeLive(cached[i], cached[i + 1])) {
                        if (!Memory.depositObserver.blockedEdges) Memory.depositObserver.blockedEdges = {};
                        Memory.depositObserver.blockedEdges[edgeKey] = true;
                        stillValid = false;
                        break;
                    }
                }
                if (stillValid) return cached;
            }
            delete creep.memory[routeKey];
            delete creep.memory[indexKey];
        }

        // --- Generate candidate ---
        const candidate = this.findLinearRoute(fromRoom, toRoom, bannedRooms);
        if (!candidate || candidate.length === 0) {
            if (this.DEBUG) console.log(`[RoomNav] ${creep.name} no candidate from ${fromRoom} to ${toRoom}`);
            return null;
        }

        // --- Verify every room and every edge ---
        const verifiedPath = [];
        if (!Memory.depositObserver) Memory.depositObserver = {};
        const obs = Memory.depositObserver;
        const roomStatus = obs.roomStatus || {};
        const blockedEdges = obs.blockedEdges || {};

        for (let i = 0; i < candidate.length; i++) {
            const roomName = candidate[i];
            const nextRoom = candidate[i + 1];
            const prevRoom = candidate[i - 1];

            // 1. Must have observer status
            const status = roomStatus[roomName];
            if (!status) {
                if (this.DEBUG) console.log(`[RoomNav] ${creep.name} missing observer scan: ${roomName}`);
                this.requestObserverScan(roomName);
                return null;
            }
            if (status.hostile === true || status.blocked === true) {
                if (this.DEBUG) console.log(`[RoomNav] ${creep.name} room hostile/blocked: ${roomName}`);
                return null;
            }

            // 2. Outgoing edge must not be cached as blocked
            if (nextRoom) {
                const edgeKey = roomName + ':' + nextRoom;
                if (blockedEdges[edgeKey]) {
                    if (this.DEBUG) console.log(`[RoomNav] ${creep.name} edge blocked (cache): ${edgeKey}`);
                    return null;
                }

                // 3. Live validation when we have vision (catches new walls/ramparts)
                if (Game.rooms[roomName]) {
                    if (!this.validateEdgeLive(roomName, nextRoom)) {
                        if (!Memory.depositObserver.blockedEdges) Memory.depositObserver.blockedEdges = {};
                        Memory.depositObserver.blockedEdges[edgeKey] = true;
                        if (this.DEBUG) console.log(`[RoomNav] ${creep.name} edge sealed by live scan: ${edgeKey}`);
                        return null;
                    }
                }
            }

            // 4. Incoming edge must not be cached as blocked
            if (prevRoom) {
                const prevEdgeKey = prevRoom + ':' + roomName;
                if (blockedEdges[prevEdgeKey]) {
                    if (this.DEBUG) console.log(`[RoomNav] ${creep.name} incoming edge blocked: ${prevEdgeKey}`);
                    return null;
                }
            }

            verifiedPath.push(roomName);
        }

        creep.memory[routeKey] = verifiedPath;
        delete creep.memory[indexKey];
        if (this.DEBUG) console.log(`[RoomNav] ${creep.name} verified: ${JSON.stringify(verifiedPath)}`);
        return verifiedPath;
    },

    /**
     * Queues a room for observer scanning.
     */
    requestObserverScan: function (roomName) {
        if (!Memory.observerQueue) Memory.observerQueue = [];
        if (!Memory.observerQueue.includes(roomName)) {
            Memory.observerQueue.push(roomName);
        }
    },

    /**
     * If we have vision, check that at least one tile on the exit edge
     * to nextRoom is open (not a wall, not blocked by an enemy rampart).
     * Returns true if an open path exists.
     */
    validateEdgeLive: function (roomName, nextRoom) {
        const room = Game.rooms[roomName];
        if (!room) return true; // No vision; assume open until observer confirms

        const exitDir = Game.map.findExit(roomName, nextRoom);
        if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return false;

        const terrain = room.getTerrain();
        const structures = room.find(FIND_STRUCTURES);
        const blockedPos = {};

        for (let i = 0; i < structures.length; i++) {
            const s = structures[i];
            if (s.structureType === STRUCTURE_WALL) {
                blockedPos[s.pos.x + ':' + s.pos.y] = true;
            } else if (s.structureType === STRUCTURE_RAMPART) {
                if (!s.my && !s.isPublic) {
                    blockedPos[s.pos.x + ':' + s.pos.y] = true;
                }
            }
        }

        let xStart, xEnd, yStart, yEnd;
        switch (exitDir) {
            case FIND_EXIT_TOP:    xStart = 0; xEnd = 49; yStart = 0; yEnd = 0; break;
            case FIND_EXIT_RIGHT:  xStart = 49; xEnd = 49; yStart = 0; yEnd = 49; break;
            case FIND_EXIT_BOTTOM: xStart = 0; xEnd = 49; yStart = 49; yEnd = 49; break;
            case FIND_EXIT_LEFT:   xStart = 0; xEnd = 0; yStart = 0; yEnd = 49; break;
            default: return true;
        }

        for (let x = xStart; x <= xEnd; x++) {
            for (let y = yStart; y <= yEnd; y++) {
                if (terrain.get(x, y) !== TERRAIN_MASK_WALL && !blockedPos[x + ':' + y]) {
                    return true;
                }
            }
        }

        return false;
    },

    /**
     * Builds a candidate route from origin to destination.
     * Uses observer-aware blocking so hostile/banned rooms are avoided.
     * Returns an array of room names including the origin.
     */
    findLinearRoute: function (fromRoom, toRoom, bannedRooms) {
        if (fromRoom === toRoom) return [fromRoom];
        bannedRooms = bannedRooms || [];

        const route = Game.map.findRoute(fromRoom, toRoom, {
            routeCallback: (roomName) => {
                if (bannedRooms.includes(roomName)) return Infinity;

                const status = (Memory.depositObserver && Memory.depositObserver.roomStatus)
                    ? Memory.depositObserver.roomStatus[roomName]
                    : null;
                if (status && (status.hostile === true || status.blocked === true)) return Infinity;

                return 1;
            }
        });

        if (route === ERR_NO_PATH) return null;
        if (!route || route.length === 0) return null;

        // findRoute returns the rooms you enter; prepend the origin.
        return [fromRoom].concat(route.map(r => r.room));
    },

    /**
     * Moves the creep along a verified room route.
     * Call this every tick with the array returned by ensureRoute.
     */
    followRoomRoute: function (creep, roomRoute) {
        if (!roomRoute || roomRoute.length === 0) return;

        // Consume rooms we have already reached
        while (roomRoute.length > 0 && creep.room.name === roomRoute[0]) {
            roomRoute.shift();
        }

        if (roomRoute.length === 0) return;

        const nextRoom = roomRoute[0];
        if (creep.room.name === nextRoom) return; // Arrived at final room

        const exitDir = creep.room.findExitTo(nextRoom);
        if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return;

        const exit = creep.pos.findClosestByRange(exitDir);
        if (exit) {
            creep.moveTo(exit, {
                visualizePathStyle: { stroke: '#ffffff', lineStyle: 'dashed' }
            });
        }
    },

    /**
     * Utility: builds a CostMatrix for local pathfinding that treats
     * enemy walls and non-public ramparts as impassable.
     */
    buildExitConstrainedMatrix: function (roomName) {
        const room = Game.rooms[roomName];
        if (!room) return null;

        const matrix = new PathFinder.CostMatrix();
        const terrain = room.getTerrain();

        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                    matrix.set(x, y, 255);
                }
            }
        }

        const structures = room.find(FIND_STRUCTURES);
        for (let i = 0; i < structures.length; i++) {
            const s = structures[i];
            if (s.structureType === STRUCTURE_WALL) {
                matrix.set(s.pos.x, s.pos.y, 255);
            } else if (s.structureType === STRUCTURE_RAMPART) {
                if (!s.my && !s.isPublic) {
                    matrix.set(s.pos.x, s.pos.y, 255);
                }
            }
        }

        return matrix;
    }
};

module.exports = roomNavigation;
