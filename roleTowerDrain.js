// Order 2 tower drain bots from E1S1 to attack towers in E2S1
//orderTowerDrain('E1S1', 'E2S1', 2)

// Cancel the operation
//cancelTowerDrainOrder('E1S1', 'E2S1')

/**
 * roleTowerDrain
 *
 * Purpose:
 * - Tower drainers step forward exactly 1 tile inside the target room (attackRestPos), wait to be attacked,
 *   then retreat 1 tile inside the safe room (healRestPos) to heal. They do not directly attack anything.
 * - Each lane now reserves FOUR tiles in a straight line across the border:
 *   1) attackRestPos (inside target)
 *   2) attackEdgePos (target border)
 *   3) healEdgePos   (safe border)
 *   4) healRestPos   (inside safe)
 * - Retreat on ANY damage. Sit still at healRestPos until fully healed, then repeat.
 * - Enforces a 1-tile gap between lanes on the same edge (no adjacent lanes).
 * - Avoids stepping onto other bots’ reserved tiles using a cost matrix in moveTo.
 * - Releases reservations when returning home and auto-GCs dead creeps.
 *
 * Reservation model:
 * - A "lane" is defined by a single axis coordinate along the border (y for W/E edges, x for N/S edges).
 * - Each lane maps to four tiles: attackRestPos, attackEdgePos, healEdgePos, healRestPos.
 * - Memory scope: per operation key "safeRoom->targetRoom|edge". Global checks prevent overlap across all operations.
 *
 * Implementation notes:
 * - Walkability is checked via Game.map.getRoomTerrain(roomName) for wall detection. 
 * - Stored positions in Memory are plain objects {x,y,roomName} (not RoomPosition instances). 
 */

const roleTowerDrain = {
    run: function(creep) {
        // Periodic GC of stale reservations
        this.gcReservations();

        // Progress tracking (lightweight, no movement effect)
        this.trackProgress(creep);

        // Initialize or reset the state machine
        if (!creep.memory.state || !['findPositions', 'draining', 'retreating', 'healing', 'returningHome'].includes(creep.memory.state)) {
            creep.memory.state = 'findPositions';
        }

        // Flee if about to die
        if (creep.ticksToLive < 50) {
            creep.memory.state = 'returningHome';
        }

        // --- State Machine ---
        switch (creep.memory.state) {
            case 'findPositions':
                this.findPositions(creep);
                break;
            case 'draining':
                this.doDraining(creep);
                break;
            case 'retreating':
                this.doRetreating(creep);
                break;
            case 'healing':
                this.doHealing(creep);
                break;
            case 'returningHome':
                this.returnHome(creep);
                break;
            default:
                creep.memory.state = 'findPositions';
                break;
        }
    },

    /**
     * Finds and saves the four key positions for the lane:
     * - attackRestPos: one tile INSIDE the target room (creep.memory.drainPos alias)
     * - attackEdgePos: the tile on the target room border
     * - healEdgePos:   the tile on the safe room border
     * - healRestPos:   one tile INSIDE the safe room (creep.memory.healPos alias)
     * Also reserves a unique lane with a 1-tile gap and ensures no overlap with any other drainer.
     */
    findPositions: function(creep) {
        const targetRoom = creep.memory.targetRoom;

        // Not in target room: set safeRoom and move toward cached exit
        if (creep.room.name !== targetRoom) {
            // Only update when changed to reduce memory churn
            if (creep.memory.safeRoom !== creep.room.name) {
                creep.memory.safeRoom = creep.room.name;
            }

            // If fatigued, don't schedule a move intent
            if (creep.fatigue) return;

            // Cache exit position per (currentRoom -> targetRoom) so we don't run pathfinder every tick
            const cacheKey = creep.room.name + '->' + targetRoom;
            let exitPos = creep.memory.exitCache && creep.memory.exitCache[cacheKey];

            if (!exitPos || exitPos.roomName !== creep.room.name) {
                const exitDir = creep.room.findExitTo(targetRoom);
                const exit = creep.pos.findClosestByPath(exitDir);
                if (!exit) return;

                exitPos = { x: exit.x, y: exit.y, roomName: creep.room.name };
                if (!creep.memory.exitCache) creep.memory.exitCache = {};
                creep.memory.exitCache[cacheKey] = exitPos;
            }

            const exit = new RoomPosition(exitPos.x, exitPos.y, exitPos.roomName);

            // If already on the target tile, don't schedule a move
            if (creep.pos.isEqualTo(exit)) return;

            // If adjacent, use move(direction) to avoid pathfinding CPU
            const range = creep.pos.getRangeTo(exit);
            if (range === 1) {
                creep.move(creep.pos.getDirectionTo(exit));
                return;
            }

            // Otherwise use moveTo with path reuse to cut pathfinding CPU
            creep.moveTo(exit, { reusePath: 20, maxRooms: 1 });
            return;
        }

        // Already in target room: if lane already set, proceed to draining
        if (creep.memory.laneSet) {
            if (creep.memory.state !== 'draining') creep.memory.state = 'draining';
            return;
        }

        // Helpers for minimal memory churn on position writes
        function samePos(a, b) {
            return !!a && !!b && a.x === b.x && a.y === b.y && a.roomName === b.roomName;
        }
        function setPos(mem, key, value) {
            if (!samePos(mem[key], value)) mem[key] = value;
        }

        let attackEdgePos = null;
        let healRestPos = null;
        const safeRoomName = creep.memory.safeRoom;

        // Determine entry edge and initial proposed positions based on current border coordinate
        const x = creep.pos.x;
        const y = creep.pos.y;

        if (x === 0) { // Entered from West
            attackEdgePos = { x: 0, y: y, roomName: creep.room.name };
            healRestPos   = { x: 48, y: y, roomName: safeRoomName };
        } else if (x === 49) { // Entered from East
            attackEdgePos = { x: 49, y: y, roomName: creep.room.name };
            healRestPos   = { x: 1, y: y, roomName: safeRoomName };
        } else if (y === 0) { // Entered from North
            attackEdgePos = { x: x, y: 0, roomName: creep.room.name };
            healRestPos   = { x: x, y: 48, roomName: safeRoomName };
        } else if (y === 49) { // Entered from South
            attackEdgePos = { x: x, y: 49, roomName: creep.room.name };
            healRestPos   = { x: x, y: 1, roomName: safeRoomName };
        }

        if (!attackEdgePos || !healRestPos) {
            console.log('[' + creep.name + '] ERROR: Could not determine edge/rest positions.');
            return;
        }

        // Reserve a unique lane near the entry point, enforcing 1-tile gap
        const reserved = this.reserveLane(creep, attackEdgePos, healRestPos);
        if (!reserved) return;

        // Store all four lane positions (only write when changed)
        const m = creep.memory;
        setPos(m, 'attackEdgePos', reserved.attackEdgePos);
        setPos(m, 'healEdgePos',   reserved.healEdgePos);

        // Alias resting tiles to the existing names used by the state machine
        setPos(m, 'drainPos', reserved.attackRestPos); // inside target
        setPos(m, 'healPos',  reserved.healRestPos);   // inside safe

        m.state = 'draining';
        m.laneSet = true;

        /*console.log('[' + creep.name + '] Lane set. ' +
            'attackRest=' + JSON.stringify(reserved.attackRestPos) +
            ' attackEdge=' + JSON.stringify(reserved.attackEdgePos) +
            ' healEdge='   + JSON.stringify(reserved.healEdgePos) +
            ' healRest='   + JSON.stringify(reserved.healRestPos));
            */
    },

    /**
     * STATE: DRAINING
     * Moves to attackRestPos (1 tile inside target) and waits for damage.
     * Retreats immediately on any damage.
     * Movement avoids other reserved tiles so drainers do not run into each other.
     */
    doDraining: function(creep) {
        if (creep.hits < creep.hitsMax) {
            //console.log('[' + creep.name + '] Damage detected! State: draining -> retreating.');
            creep.memory.state = 'retreating';
            return;
        }
        const drainPosMem = creep.memory.drainPos;
        if (!drainPosMem) {
            creep.memory.state = 'findPositions';
            return;
        }
        const drainPos = new RoomPosition(drainPosMem.x, drainPosMem.y, drainPosMem.roomName);
        if (!creep.pos.isEqualTo(drainPos)) {
            this.moveAvoidingReserved(creep, drainPos, '#ff0000');
            creep.say('🎯');
        } else {
            creep.say('😎');
        }
    },

    /**
     * STATE: RETREATING
     * Moves to the dedicated healRestPos (1 tile inside safe room), healing on the way.
     * Movement avoids other reserved tiles so drainers do not run into each other.
     */
    doRetreating: function(creep) {
        const healPosMem = creep.memory.healPos;
        if (!healPosMem) {
            creep.memory.state = 'findPositions';
            return;
        }
        const healPos = new RoomPosition(healPosMem.x, healPosMem.y, healPosMem.roomName);
        if (creep.pos.isEqualTo(healPos)) {
            //console.log('[' + creep.name + '] Arrived at heal spot. State: retreating -> healing.');
            creep.memory.state = 'healing';
            // Heal immediately on the same tick
            this.doHealing(creep);
            return;
        }
        this.moveAvoidingReserved(creep, healPos, '#00ff00');
        creep.heal(creep);
        creep.say('🏃');
    },

    /**
     * STATE: HEALING
     * Sits still at healRestPos and does nothing but heal until full health.
     */
    doHealing: function(creep) {
        if (creep.hits === creep.hitsMax) {
            //console.log('[' + creep.name + '] Fully healed. State: healing -> draining.');
            creep.memory.state = 'draining';
            return;
        }
        creep.heal(creep);
        creep.say('❤️‍🩹');
    },

    /**
     * Returning home:
     * - Releases the lane reservation for this creep.
     * - Moves back to homeRoom if set.
     */
    returnHome: function(creep) {
        // Release lane when returning
        this.releaseLane(creep);

        const homeRoom = creep.memory.homeRoom;
        if (homeRoom && creep.room.name !== homeRoom) {
            if (creep.fatigue) return;

            // Cache exit per (currentRoom -> homeRoom)
            const cacheKey = creep.room.name + '->' + homeRoom;
            let exitPos = creep.memory.exitCache && creep.memory.exitCache[cacheKey];

            if (!exitPos || exitPos.roomName !== creep.room.name) {
                const exitDir = creep.room.findExitTo(homeRoom);
                const exit = creep.pos.findClosestByPath(exitDir);
                if (!exit) return;
                exitPos = { x: exit.x, y: exit.y, roomName: creep.room.name };
                if (!creep.memory.exitCache) creep.memory.exitCache = {};
                creep.memory.exitCache[cacheKey] = exitPos;
            }

            const exit = new RoomPosition(exitPos.x, exitPos.y, exitPos.roomName);

            if (creep.pos.isEqualTo(exit)) return;

            const range = creep.pos.getRangeTo(exit);
            if (range === 1) {
                creep.move(creep.pos.getDirectionTo(exit));
                return;
            }

            creep.moveTo(exit, { reusePath: 20, maxRooms: 1 });
        } else {
            creep.say('🏠');
        }
    },

    // ---------- Movement with reserved-tile avoidance ----------

    moveAvoidingReserved: function(creep, targetPos, color) {
        // Gate move: skip if we can't or don't need to move
        if (!targetPos) return;
        if (creep.fatigue) return;
        if (creep.pos.isEqualTo(targetPos)) return;

        creep.moveTo(targetPos, {
            range: 0,
            ignoreCreeps: false,
            maxRooms: 2,
            reusePath: 2,
            visualizePathStyle: color ? { stroke: color } : undefined,
            costCallback: function(roomName, costMatrix) {
                if (!Memory.towerDrainLanes) return costMatrix;

                for (var opKey in Memory.towerDrainLanes) {
                    var op = Memory.towerDrainLanes[opKey];
                    if (!op || !op.lanes) continue;

                    for (var laneKey in op.lanes) {
                        var lane = op.lanes[laneKey];
                        if (!lane || lane.name === creep.name) continue;

                        function block(pos) {
                            if (pos && pos.roomName === roomName) {
                                costMatrix.set(pos.x, pos.y, 255);
                            }
                        }

                        // Block all known lane tiles (new 4-tile model)
                        block(lane.attackRestPos);
                        block(lane.attackEdgePos);
                        block(lane.healEdgePos);
                        block(lane.healRestPos);

                        // Backward compatibility (older 2-tile records, if any)
                        block(lane.drainPos);
                        block(lane.healPos);
                    }
                }
                return costMatrix;
            }
        });
    },

    // ---------- Lane reservation helpers ----------

    edgeFromPos: function(posObj) {
        if (!posObj) return null;
        if (posObj.x === 0) return 'W';
        if (posObj.x === 49) return 'E';
        if (posObj.y === 0) return 'N';
        if (posObj.y === 49) return 'S';
        return null;
    },

    getOpKey: function(safeRoom, targetRoom, edge) {
        return safeRoom + '->' + targetRoom + '|' + edge;
    },

    // Global set of taken coordinates for a given targetRoom+edge (used to enforce 1-tile gap across all operations)
    getUsedCoordsForEdge: function(targetRoom, edge) {
        var used = {};
        if (!Memory.towerDrainLanes) return used;

        for (var opKey in Memory.towerDrainLanes) {
            var op = Memory.towerDrainLanes[opKey];
            if (!op || !op.lanes) continue;

            for (var laneKey in op.lanes) {
                var lane = op.lanes[laneKey];
                if (!lane || !lane.attackEdgePos) continue;

                var laneEdge = this.edgeFromPos(lane.attackEdgePos);
                if (lane.attackEdgePos.roomName === targetRoom && laneEdge === edge) {
                    var c = (edge === 'W' || edge === 'E') ? lane.attackEdgePos.y : lane.attackEdgePos.x;
                    used[String(c)] = true;
                }
            }
        }
        return used;
    },

    // Global tile reservation check: no other drainer may use these tiles (in either room)
    isTileGloballyReserved: function(roomName, x, y, exceptCreepName) {
        if (!Memory.towerDrainLanes) return false;

        for (var opKey in Memory.towerDrainLanes) {
            var op = Memory.towerDrainLanes[opKey];
            if (!op || !op.lanes) continue;

            for (var laneKey in op.lanes) {
                var lane = op.lanes[laneKey];
                if (!lane || lane.name === exceptCreepName) continue;

                // Check all four new fields
                if (lane.attackRestPos && lane.attackRestPos.roomName === roomName && lane.attackRestPos.x === x && lane.attackRestPos.y === y) return true;
                if (lane.attackEdgePos && lane.attackEdgePos.roomName === roomName && lane.attackEdgePos.x === x && lane.attackEdgePos.y === y) return true;
                if (lane.healEdgePos && lane.healEdgePos.roomName === roomName && lane.healEdgePos.x === x && lane.healEdgePos.y === y) return true;
                if (lane.healRestPos && lane.healRestPos.roomName === roomName && lane.healRestPos.x === x && lane.healRestPos.y === y) return true;

                // Backward compatibility: old fields
                if (lane.drainPos && lane.drainPos.roomName === roomName && lane.drainPos.x === x && lane.drainPos.y === y) return true;
                if (lane.healPos && lane.healPos.roomName === roomName && lane.healPos.x === x && lane.healPos.y === y) return true;
            }
        }
        return false;
    },

    reserveLane: function(creep, proposedAttackEdgePos, proposedHealRestPos) {
        var safeRoom = creep.memory.safeRoom;
        var targetRoom = creep.memory.targetRoom;
        var edge = this.edgeFromPos(proposedAttackEdgePos);
        if (!edge || !safeRoom || !targetRoom) {
            // Fallback: derive positions directly from proposed coords
            var fallback = this.buildPositionsFrom(edge, proposedAttackEdgePos, proposedHealRestPos, targetRoom, safeRoom);
            return fallback;
        }

        if (!Memory.towerDrainLanes) Memory.towerDrainLanes = {};
        var opKey = this.getOpKey(safeRoom, targetRoom, edge);
        if (!Memory.towerDrainLanes[opKey]) Memory.towerDrainLanes[opKey] = { lanes: {} };
        var lanesObj = Memory.towerDrainLanes[opKey].lanes;

        // Keep existing lane if already assigned to this creep
        if (creep.memory.laneKey && lanesObj[creep.memory.laneKey] && lanesObj[creep.memory.laneKey].name === creep.name) {
            var lane = lanesObj[creep.memory.laneKey];
            creep.memory.opKey = opKey;
            return {
                attackRestPos: lane.attackRestPos || lane.drainPos,
                attackEdgePos: lane.attackEdgePos,
                healEdgePos:   lane.healEdgePos,
                healRestPos:   lane.healRestPos || lane.healPos
            };
        }

        // Axis details and starting coordinate
        var axisIsY = edge === 'W' || edge === 'E';
        var startCoord = axisIsY ? proposedAttackEdgePos.y : proposedAttackEdgePos.x;

        // Terrain checks (walls) only
        var terrainTarget = Game.map.getRoomTerrain(targetRoom);
        var terrainSafe   = Game.map.getRoomTerrain(safeRoom);
        function isWalkable(terrain, x, y) {
            return terrain.get(x, y) !== TERRAIN_MASK_WALL;
        }

        // Build a global set of used coordinates (for 1-tile gap rule across all ops)
        var globalUsed = this.getUsedCoordsForEdge(targetRoom, edge);

        // Helper to construct the 4 positions for a given coordinate 'c'
        function buildPositions(edgeStr, c, tgtRoom, safeRoomName) {
            var attackEdgePos, attackRestPos, healEdgePos, healRestPos;
            if (edgeStr === 'W') {
                attackEdgePos = { x: 0,  y: c, roomName: tgtRoom };
                attackRestPos = { x: 1,  y: c, roomName: tgtRoom };
                healEdgePos   = { x: 49, y: c, roomName: safeRoomName };
                healRestPos   = { x: 48, y: c, roomName: safeRoomName };
            } else if (edgeStr === 'E') {
                attackEdgePos = { x: 49, y: c, roomName: tgtRoom };
                attackRestPos = { x: 48, y: c, roomName: tgtRoom };
                healEdgePos   = { x: 0,  y: c, roomName: safeRoomName };
                healRestPos   = { x: 1,  y: c, roomName: safeRoomName };
            } else if (edgeStr === 'N') {
                attackEdgePos = { x: c, y: 0,  roomName: tgtRoom };
                attackRestPos = { x: c, y: 1,  roomName: tgtRoom };
                healEdgePos   = { x: c, y: 49, roomName: safeRoomName };
                healRestPos   = { x: c, y: 48, roomName: safeRoomName };
            } else { // 'S'
                attackEdgePos = { x: c, y: 49, roomName: tgtRoom };
                attackRestPos = { x: c, y: 48, roomName: tgtRoom };
                healEdgePos   = { x: c, y: 0,  roomName: safeRoomName };
                healRestPos   = { x: c, y: 1,  roomName: safeRoomName };
            }
            return { attackEdgePos: attackEdgePos, attackRestPos: attackRestPos, healEdgePos: healEdgePos, healRestPos: healRestPos };
        }

        var best = null;
        for (var radius = 0; radius <= 49; radius++) {
            var candidates = [];
            var c1 = startCoord - radius;
            var c2 = startCoord + radius;
            if (c1 >= 0) candidates.push(c1);
            if (c2 <= 49 && c2 !== c1) candidates.push(c2);

            for (var i = 0; i < candidates.length; i++) {
                var c = candidates[i];
                var laneKey = String(c);

                // Per-op uniqueness
                if (lanesObj[laneKey]) continue;

                // Global uniqueness + 1-tile gap
                if (globalUsed[String(c)]) continue;
                if (globalUsed[String(c - 1)]) continue;
                if (globalUsed[String(c + 1)]) continue;

                var pos = buildPositions(edge, c, targetRoom, safeRoom);

                // Walkable in both rooms (terrain only)
                if (!isWalkable(terrainTarget, pos.attackEdgePos.x, pos.attackEdgePos.y)) continue;
                if (!isWalkable(terrainTarget, pos.attackRestPos.x, pos.attackRestPos.y)) continue;
                if (!isWalkable(terrainSafe,   pos.healEdgePos.x,   pos.healEdgePos.y)) continue;
                if (!isWalkable(terrainSafe,   pos.healRestPos.x,   pos.healRestPos.y)) continue;

                // Globally not already reserved by other operations/creeps
                if (this.isTileGloballyReserved(pos.attackEdgePos.roomName, pos.attackEdgePos.x, pos.attackEdgePos.y, creep.name)) continue;
                if (this.isTileGloballyReserved(pos.attackRestPos.roomName, pos.attackRestPos.x, pos.attackRestPos.y, creep.name)) continue;
                if (this.isTileGloballyReserved(pos.healEdgePos.roomName,   pos.healEdgePos.x,   pos.healEdgePos.y,   creep.name)) continue;
                if (this.isTileGloballyReserved(pos.healRestPos.roomName,   pos.healRestPos.x,   pos.healRestPos.y,   creep.name)) continue;

                best = { laneKey: laneKey, positions: pos };
                break;
            }
            if (best) break;
        }

        // Fallback to proposed positions if no lane found
        if (!best) {
            creep.memory.opKey = opKey;
            var fallback = buildPositions(edge, startCoord, targetRoom, safeRoom);
            return fallback;
        }

        // Reserve lane
        lanesObj[best.laneKey] = {
            name: creep.name,
            attackEdgePos: best.positions.attackEdgePos,
            attackRestPos: best.positions.attackRestPos,
            healEdgePos:   best.positions.healEdgePos,
            healRestPos:   best.positions.healRestPos
        };
        creep.memory.laneKey = best.laneKey;
        creep.memory.opKey   = opKey;

        return best.positions;
    },

    // Helper to build positions if edge/rooms are already implied by inputs (fallback path)
    buildPositionsFrom: function(edge, proposedAttackEdgePos, proposedHealRestPos, targetRoom, safeRoom) {
        var c = edge === 'W' || edge === 'E' ? proposedAttackEdgePos.y : proposedAttackEdgePos.x;
        function build(edgeStr, coord, tgtRoom, safeRoomName) {
            var attackEdgePos, attackRestPos, healEdgePos, healRestPos;
            if (edgeStr === 'W') {
                attackEdgePos = { x: 0,  y: coord, roomName: tgtRoom };
                attackRestPos = { x: 1,  y: coord, roomName: tgtRoom };
                healEdgePos   = { x: 49, y: coord, roomName: safeRoomName };
                healRestPos   = { x: 48, y: coord, roomName: safeRoomName };
            } else if (edgeStr === 'E') {
                attackEdgePos = { x: 49, y: coord, roomName: tgtRoom };
                attackRestPos = { x: 48, y: coord, roomName: tgtRoom };
                healEdgePos   = { x: 0,  y: coord, roomName: safeRoomName };
                healRestPos   = { x: 1,  y: coord, roomName: safeRoomName };
            } else if (edgeStr === 'N') {
                attackEdgePos = { x: coord, y: 0,  roomName: tgtRoom };
                attackRestPos = { x: coord, y: 1,  roomName: tgtRoom };
                healEdgePos   = { x: coord, y: 49, roomName: safeRoomName };
                healRestPos   = { x: coord, y: 48, roomName: safeRoomName };
            } else { // 'S'
                attackEdgePos = { x: coord, y: 49, roomName: tgtRoom };
                attackRestPos = { x: coord, y: 48, roomName: tgtRoom };
                healEdgePos   = { x: coord, y: 0,  roomName: safeRoomName };
                healRestPos   = { x: coord, y: 1,  roomName: safeRoomName };
            }
            return { attackEdgePos: attackEdgePos, attackRestPos: attackRestPos, healEdgePos: healEdgePos, healRestPos: healRestPos };
        }
        return build(edge, c, targetRoom, safeRoom);
    },

    releaseLane: function(creep) {
        if (!Memory.towerDrainLanes) return;

        var opKey = creep.memory.opKey;
        if (!opKey) {
            // Reconstruct opKey if missing
            var safeRoom = creep.memory.safeRoom;
            var targetRoom = creep.memory.targetRoom;
            var edgePos = creep.memory.attackEdgePos;
            var edge = this.edgeFromPos(edgePos);
            if (!safeRoom || !targetRoom || !edge) return;
            opKey = this.getOpKey(safeRoom, targetRoom, edge);
        }

        var laneKey = creep.memory.laneKey;
        if (!laneKey) return;

        var op = Memory.towerDrainLanes[opKey];
        if (!op || !op.lanes) return;

        var holder = op.lanes[laneKey];
        if (holder && holder.name === creep.name) {
            delete op.lanes[laneKey];
        }
        delete creep.memory.laneKey;
    },

    gcReservations: function() {
        if (!Memory.towerDrainLanes) return;

        for (var opKey in Memory.towerDrainLanes) {
            var op = Memory.towerDrainLanes[opKey];
            if (!op || !op.lanes) {
                delete Memory.towerDrainLanes[opKey];
                continue;
            }

            for (var laneKey in op.lanes) {
                var lane = op.lanes[laneKey];
                if (!lane || !Game.creeps[lane.name]) {
                    delete op.lanes[laneKey];
                }
            }

            // Remove empty ops
            var hasAny = false;
            for (var k in op.lanes) { hasAny = true; break; }
            if (!hasAny) delete Memory.towerDrainLanes[opKey];
        }
    },

    // ---------- Progress tracking (per operation) ----------

    trackProgress: function(creep) {
        // Config
        var SCAN_INTERVAL = 1000;   // ticks
        var EMAIL_INTERVAL = 15000; // ticks
        var HISTORY_LIMIT = 15;     // 15 * ~1000 = ~15000 ticks

        // Identify this creep's operation
        var opInfo = this.getOpFromCreep(creep);
        if (!opInfo) return;

        var opKey = opInfo.opKey;
        var targetRoom = opInfo.targetRoom;

        // Only one drainer per operation should perform the scan/email to avoid duplication.
        if (!this.isOpLeader(creep, opKey)) return;

        if (!Memory.towerDrainProgress) Memory.towerDrainProgress = {};
        var opProg = Memory.towerDrainProgress[opKey];
        if (!opProg) {
            opProg = { lastScanTick: 0, lastEmailTick: 0, history: [] };
            Memory.towerDrainProgress[opKey] = opProg;
        }

        // Due for scan?
        if (Game.time - opProg.lastScanTick >= SCAN_INTERVAL) {
            var energy = this.readTargetEnergy(targetRoom);
            if (energy !== null) {
                var drainerCount = this.getDrainerCountForOp(opKey);

                var history = opProg.history;
                var sample = { tick: Game.time, energy: energy, drainerCount: drainerCount };

                var prev = history.length > 0 ? history[history.length - 1] : null;
                if (prev) {
                    var deltaTicks = Game.time - prev.tick;
                    if (deltaTicks < 1) deltaTicks = 1;
                    var deltaEnergy = prev.energy - energy; // positive = drained
                    var per1kTotal = (deltaEnergy * 1000) / deltaTicks;
                    var per1kPerDrainer = drainerCount > 0 ? per1kTotal / drainerCount : 0;
                    sample.per1kTotal = per1kTotal;
                    sample.per1kPerDrainer = per1kPerDrainer;

                    var prevPerDrainer = typeof prev.per1kPerDrainer === 'number' ? prev.per1kPerDrainer : null;
                    if (prevPerDrainer !== null) {
                        var deltaPerDrainer = per1kPerDrainer - prevPerDrainer;
                        console.log(
                            '[TowerDrain ' + opKey + '] energy=' + energy +
                            ' | drain/1k per drainer=' + per1kPerDrainer.toFixed(1) +
                            ' (Δ' + deltaPerDrainer.toFixed(1) + ')' +
                            ' | total/1k=' + per1kTotal.toFixed(1) +
                            ' | drainers=' + drainerCount
                        );
                    } else {
                        console.log(
                            '[TowerDrain ' + opKey + '] energy=' + energy +
                            ' | drain/1k per drainer=' + per1kPerDrainer.toFixed(1) +
                            ' | total/1k=' + per1kTotal.toFixed(1) +
                            ' | drainers=' + drainerCount
                        );
                    }
                } else {
                    console.log('[TowerDrain ' + opKey + '] initial sample: energy=' + energy + ' | drainers=' + drainerCount);
                }

                history.push(sample);
                if (history.length > HISTORY_LIMIT) history.shift();
                opProg.lastScanTick = Game.time;
            }
            // If no vision, we intentionally don't bump lastScanTick so we retry when we next can see the room.
        }

        // Email every ~15000 ticks with progress & ETA
        if (Game.time - opProg.lastEmailTick >= EMAIL_INTERVAL) {
            var hist = opProg.history;
            if (hist.length >= 2) {
                // Use average total drain over the history for stability
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
                    var etaTicks = null;
                    if (perTickTotal > 0) {
                        etaTicks = Math.floor(energyNow / perTickTotal);
                    }

                    var etaString = 'ETA: unknown';
                    if (etaTicks !== null && isFinite(etaTicks) && etaTicks > 0) {
                        var totalSec = etaTicks * 3; // Screeps ~3s/tick
                        var days = Math.floor(totalSec / 86400);
                        var rem = totalSec % 86400;
                        var hours = Math.floor(rem / 3600);
                        var minutes = Math.floor((rem % 3600) / 60);
                        etaString = 'ETA: ' + days + 'd ' + hours + 'h ' + minutes + 'm';
                    }

                    var drainerCountNow = latest.drainerCount;
                    var avgPer1kPerDrainer = drainerCountNow > 0 ? (avgPer1kTotal / drainerCountNow) : 0;

                    var msg =
                        '[TowerDrain ' + opKey + ']\n' +
                        'Energy now: ' + energyNow + '\n' +
                        'Drainers: ' + drainerCountNow + '\n' +
                        'Avg drain (15k window): ' + avgPer1kTotal.toFixed(1) + ' per 1k ticks total\n' +
                        'Avg per drainer: ' + avgPer1kPerDrainer.toFixed(1) + ' per 1k ticks\n' +
                        etaString + '\n' +
                        'Samples: ' + count + ' over ~' + (count * 1000) + ' ticks';

                    Game.notify(msg);
                    opProg.lastEmailTick = Game.time;
                }
            }
        }
    },

    getOpFromCreep: function(creep) {
        // Prefer stored opKey if present
        if (creep.memory.opKey && creep.memory.targetRoom && creep.memory.safeRoom) {
            return { opKey: creep.memory.opKey, targetRoom: creep.memory.targetRoom, safeRoom: creep.memory.safeRoom };
        }
        // Reconstruct from stored edge when available
        var safeRoom = creep.memory.safeRoom;
        var targetRoom = creep.memory.targetRoom;
        var edgePos = creep.memory.attackEdgePos;
        var edge = this.edgeFromPos(edgePos);
        if (!safeRoom || !targetRoom || !edge) return null;
        var opKey = this.getOpKey(safeRoom, targetRoom, edge);
        return { opKey: opKey, targetRoom: targetRoom, safeRoom: safeRoom };
    },

    isOpLeader: function(creep, opKey) {
        if (!Memory.towerDrainLanes || !Memory.towerDrainLanes[opKey] || !Memory.towerDrainLanes[opKey].lanes) return true;
        var names = [];
        var lanes = Memory.towerDrainLanes[opKey].lanes;
        for (var k in lanes) {
            var lane = lanes[k];
            if (lane && lane.name && Game.creeps[lane.name]) {
                names.push(lane.name);
            }
        }
        if (names.length === 0) return true;
        names.sort();
        return creep.name === names[0];
    },

    getDrainerCountForOp: function(opKey) {
        if (!Memory.towerDrainLanes || !Memory.towerDrainLanes[opKey] || !Memory.towerDrainLanes[opKey].lanes) return 0;
        var count = 0;
        var lanes = Memory.towerDrainLanes[opKey].lanes;
        for (var k in lanes) {
            var lane = lanes[k];
            if (lane && lane.name && Game.creeps[lane.name]) {
                count++;
            }
        }
        return count;
    },

    readTargetEnergy: function(targetRoom) {
        // Only if we have vision to avoid movement/observer requirements
        var room = Game.rooms[targetRoom];
        if (!room) return null;

        if (room.storage) {
            return room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
        }

        var best = null;
        var bestAmt = -1;
        var containers = room.find(FIND_STRUCTURES, { filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; } });
        for (var i = 0; i < containers.length; i++) {
            var amt = containers[i].store.getUsedCapacity(RESOURCE_ENERGY);
            if (amt > bestAmt) {
                bestAmt = amt;
                best = containers[i];
            }
        }
        if (best) return bestAmt;

        return null;
    }
};

module.exports = roleTowerDrain;
