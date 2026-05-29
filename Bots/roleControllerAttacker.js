// ============================================================================
// Role: Controller Attacker
// Desc: Navigates to a target room and attacks its controller to rapidly
//       reduce downgrade or reservation timers.
//
// USAGE / CONSOLE COMMANDS:
// ----------------------------------------------------------------------------
// 1. Order an attack:
//    orderControllerAttack('W1N1', 'W2N2')
//    (Spawns an attacker from W1N1 and sends it to W2N2)
//
// 2. Order an attack with a forced exit direction:
//    orderControllerAttack('W1N1', 'W2N2', 'N')
//    (Creep will go north first before routing to W2N2)
//
// 3. View active orders:
//    listControllerAttackOrders()

const iff = require('iff');

// === ROOM DIRECTION HELPER ===
/**
 * Returns the name of the room adjacent in the given cardinal direction.
 * Handles the N0↔S1 and W0↔E1 axis transitions.
 * @param {string} roomName  e.g. "W1N1"
 * @param {string} dir       "N" | "S" | "E" | "W"
 * @returns {string|null}
 */
function getRoomInDirection(roomName, dir) {
    const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return null;

    let [, we, weNum, ns, nsNum] = match;
    weNum = parseInt(weNum, 10);
    nsNum = parseInt(nsNum, 10);

    if (dir === 'N') {
        if (ns === 'N') { nsNum++; }
        else if (nsNum > 0) { nsNum--; }
        else { ns = 'N'; nsNum = 1; }
    } else if (dir === 'S') {
        if (ns === 'S') { nsNum++; }
        else if (nsNum > 0) { nsNum--; }
        else { ns = 'S'; nsNum = 1; }
    } else if (dir === 'E') {
        if (we === 'E') { weNum++; }
        else if (weNum > 0) { weNum--; }
        else { we = 'E'; weNum = 1; }
    } else if (dir === 'W') {
        if (we === 'W') { weNum++; }
        else if (weNum > 0) { weNum--; }
        else { we = 'W'; weNum = 1; }
    } else {
        return null;
    }

    return `${we}${weNum}${ns}${nsNum}`;
}

// === CONSOLE COMMANDS ===
global.orderControllerAttack = function(spawnRoom, targetRoom, exitDirection = null) {
    if (!Memory.controllerAttackOrders) Memory.controllerAttackOrders = [];

    const order = { homeRoom: spawnRoom, targetRoom, time: Game.time };

    if (exitDirection) {
        const dir = exitDirection.toUpperCase();
        if (!['N', 'S', 'E', 'W'].includes(dir)) {
            return `Invalid exit direction "${exitDirection}". Use N, S, E, or W.`;
        }
        const waypoint = getRoomInDirection(spawnRoom, dir);
        if (!waypoint) {
            return `Could not resolve room to the ${dir} of ${spawnRoom}.`;
        }
        order.waypointRoom = waypoint;
    }

    Memory.controllerAttackOrders.push(order);
    return `Controller attack ordered from ${spawnRoom} targeting ${targetRoom}` +
           (order.waypointRoom ? ` via ${order.waypointRoom} (exit ${exitDirection.toUpperCase()})` : '');
};

global.listControllerAttackOrders = function() {
    if (!Memory.controllerAttackOrders || Memory.controllerAttackOrders.length === 0) {
        return "No active controller attack orders.";
    }
    return JSON.stringify(Memory.controllerAttackOrders, null, 2);
};

// === CREEP LOGIC ===
const roleControllerAttacker = {
    run: function(creep) {
        const targetRoom = creep.memory.targetRoom;

        // Store current room for next tick's previous room tracking
        if (!creep.memory.previousRoom) {
            creep.memory.previousRoom = creep.room.name;
        }

        // Handle retreat state
        if (creep.memory.retreating) {
            return this.handleRetreat(creep);
        }

        // Check for hostile towers in current room (unless it's the target room)
        const shouldAvoidRoom = this.checkForHostileTowers(creep);
        if (shouldAvoidRoom) {
            creep.say('🚨 RETREAT!');

            // Enter retreat mode (movement cache was already cleared inside checkForHostileTowers)
            creep.memory.retreating = true;
            creep.memory.retreatTarget = creep.memory.previousRoom || creep.memory.homeRoom;

            return this.handleRetreat(creep);
        }

        // Update previous room tracking (only when not retreating)
        if (creep.memory.previousRoom !== creep.room.name) {
            creep.memory.previousRoom = creep.room.name;
        }

        // 0. If a forced exit waypoint was set, reach it before normal routing takes over
        if (creep.memory.waypointRoom && creep.room.name !== creep.memory.waypointRoom) {
            this.moveToAvoidingBlacklist(creep, new RoomPosition(25, 25, creep.memory.waypointRoom), {
                visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dotted' },
                range: 23
            });
            creep.say('📍 WP');
            return;
        }
        // Waypoint reached — clear it so normal routing takes over
        if (creep.memory.waypointRoom && creep.room.name === creep.memory.waypointRoom) {
            delete creep.memory.waypointRoom;
        }

        // 1. Cross-room navigation using avoidance logic
        if (creep.room.name !== targetRoom) {
            this.moveToAvoidingBlacklist(creep, new RoomPosition(25, 25, targetRoom), {
                visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' },
                range: 23
            });
            return;
        }

        const controller = creep.room.controller;

        // 2. Validation: Nothing to do if no controller, it's ours, or it's empty
        if (!controller || controller.my || (!controller.owner && !controller.reservation)) {
            // Idle near the controller in case someone claims/reserves it while we wait
            if (controller && !creep.pos.isNearTo(controller)) {
                creep.moveTo(controller, { reusePath: 50, maxRooms: 1 });
            }
            return;
        }

        // 3. Move to controller if not adjacent (O(1) check)
        if (!creep.pos.isNearTo(controller)) {
            creep.moveTo(controller, { reusePath: 50, maxRooms: 1, visualizePathStyle: { stroke: '#ff0000' } });
            return;
        }

        // 4. We are adjacent. Execute the attack.
        const result = creep.attackController(controller);

        if (result === OK) {
            if (controller.owner) {
                // Attacking an owned controller blocks it from being attacked again for 1000 ticks.
                // Since this is longer than our lifespan, we suicide to free up Game.creeps parsing CPU.
                creep.say('💥 Strike!');
                creep.suicide();
            } else if (controller.reservation) {
                // Attacking a reserved controller has no cooldown. We hit it every tick.
                creep.say('⚔️ Unreserve');
            }
        }
    },

    /**
     * Custom moveTo that respects blacklisted rooms.
     * Falls back to standard moveTo if PathFinder cannot find a path around
     * the blacklist — prevents the creep from stalling indefinitely after a
     * false-positive blacklist entry.
     * @param {Creep} creep
     * @param {RoomPosition} target
     * @param {Object} opts
     */
    moveToAvoidingBlacklist: function(creep, target, opts = {}) {
        // No blacklisted rooms — use normal moveTo for efficiency
        if (!creep.memory.blacklistedRooms || creep.memory.blacklistedRooms.length === 0) {
            return creep.moveTo(target, opts);
        }

        // Use PathFinder.search directly so our room callback is respected
        const goals = [{ pos: target, range: opts.range || 1 }];

        const result = PathFinder.search(creep.pos, goals, {
            maxOps: opts.maxOps || 4000,
            maxRooms: opts.maxRooms || 16,
            plainCost: opts.plainCost || 1,
            swampCost: opts.swampCost || 5,
            roomCallback: this.getAvoidanceRoomCallback(creep)
        });

        if (result.incomplete || !result.path || result.path.length === 0) {
            // PathFinder hit its op budget but may still have a partial path.
            // Re-run with a higher budget before giving up — incomplete usually
            // means the route exists but needs more ops (multi-room detour).
            console.log(`[ControllerAttack] ${creep.name}: Blacklist-aware path to ${target.roomName} incomplete, ` +
                        `retrying with higher maxOps. Blacklisted: ${JSON.stringify(creep.memory.blacklistedRooms)}`);

            const retry = PathFinder.search(creep.pos, goals, {
                maxOps: 20000,
                maxRooms: opts.maxRooms || 16,
                plainCost: opts.plainCost || 1,
                swampCost: opts.swampCost || 5,
                roomCallback: this.getAvoidanceRoomCallback(creep)
            });

            if (!retry.incomplete && retry.path && retry.path.length > 0) {
                if (opts.visualizePathStyle) creep.room.visual.poly(retry.path, opts.visualizePathStyle);
                return creep.move(creep.pos.getDirectionTo(retry.path[0]));
            }

            // Genuinely no path exists around the blacklist — log and hold position
            // rather than routing back through the hostile room.
            console.log(`[ControllerAttack] ${creep.name}: No path to ${target.roomName} avoiding blacklist — holding position.`);
            return ERR_NO_PATH;
        }

        // Visualize the path if requested
        if (opts.visualizePathStyle) {
            creep.room.visual.poly(result.path, opts.visualizePathStyle);
        }

        const nextStep = result.path[0];

        // Safety guard: log loudly if PathFinder somehow routes through a blacklisted room
        if (creep.memory.blacklistedRooms.includes(nextStep.roomName)) {
            console.log(`[ControllerAttack] ${creep.name}: ERROR — PathFinder routing through blacklisted room ${nextStep.roomName}!`);
        }

        return creep.move(creep.pos.getDirectionTo(nextStep));
    },

    /**
     * Thoroughly clears all cached movement data for a creep
     * @param {Creep} creep
     */
    clearAllMovementCache: function(creep) {
        delete creep.memory._move;
        delete creep.memory._path;
        delete creep.memory.pathToTarget;
        delete creep.memory.destination;
        console.log(`[ControllerAttack] ${creep.name}: Cleared all movement cache`);
    },

    /**
     * Handles the retreat behavior when hostile towers are detected.
     * After a 3-tick stabilisation wait the creep exits retreat state and
     * immediately reroutes toward the target on that same tick so there is
     * no extra tick of sitting still.
     * @param {Creep} creep
     */
    handleRetreat: function(creep) {
        // Phase 1: Get out of the blacklisted room
        if (!creep.memory.retreatTarget) {
            creep.memory.retreatTarget = creep.memory.previousRoom || creep.memory.homeRoom;
        }

        if (creep.memory.blacklistedRooms && creep.memory.blacklistedRooms.includes(creep.room.name)) {
            const exitDir = creep.room.findExitTo(creep.memory.retreatTarget);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
                const exit = creep.pos.findClosestByPath(exitDir);
                if (exit) {
                    creep.moveTo(exit, {
                        visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' }
                    });
                    creep.say('🏃 FLEE!');
                    return;
                }
            }

            // Fallback: find any exit that doesn't lead to another blacklisted room
            const exits = Game.map.describeExits(creep.room.name);
            for (const direction in exits) {
                const neighborRoom = exits[direction];
                if (creep.memory.blacklistedRooms && creep.memory.blacklistedRooms.includes(neighborRoom)) {
                    continue;
                }
                const exitDir = parseInt(direction, 10);
                const exit = creep.pos.findClosestByPath(exitDir);
                if (exit) {
                    creep.moveTo(exit, {
                        visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' }
                    });
                    creep.say('🏃 FLEE!');
                    return;
                }
            }
            return;
        }

        // Phase 2: Move away from the room edge so we don't immediately re-enter
        const distanceFromEdge = Math.min(
            creep.pos.x,
            creep.pos.y,
            49 - creep.pos.x,
            49 - creep.pos.y
        );

        if (distanceFromEdge < 5) {
            creep.moveTo(new RoomPosition(25, 25, creep.room.name), {
                visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dotted' }
            });
            creep.say('🛡️ SAFE');
            return;
        }

        // Phase 3: Self-heal if possible
        const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
        if (hasHealParts && creep.hits < creep.hitsMax) {
            creep.heal(creep);
            creep.say('🩹 HEAL');
            return;
        }

        // Phase 4: Wait a few ticks to stabilise, then exit retreat and reroute immediately
        if (!creep.memory.retreatTimer) {
            creep.memory.retreatTimer = Game.time;
        }

        const ticksWaited = Game.time - creep.memory.retreatTimer;
        if (ticksWaited > 3) {
            // Clear all retreat state
            delete creep.memory.retreating;
            delete creep.memory.retreatTarget;
            delete creep.memory.retreatTimer;
            this.clearAllMovementCache(creep);

            creep.say('✅ REROUTE');
            console.log(`[ControllerAttack] ${creep.name}: Retreat complete, rerouting to ${creep.memory.targetRoom}. ` +
                        `Blacklisted rooms: ${JSON.stringify(creep.memory.blacklistedRooms)}`);

            // Reroute on this same tick rather than waiting until next tick.
            // moveToAvoidingBlacklist will fall back to standard moveTo if the
            // blacklist makes the target unreachable via PathFinder.
            this.moveToAvoidingBlacklist(creep, new RoomPosition(25, 25, creep.memory.targetRoom), {
                visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' },
                range: 23
            });
        } else {
            creep.say(`⏳ ${3 - ticksWaited}`);
        }
    },

    /**
     * Checks if the current room has hostile towers and blacklists it if so.
     *
     * IFF check runs FIRST: if the room controller is owned or reserved by a
     * whitelisted player the room is unconditionally safe and tower scanning is
     * skipped entirely. This prevents friendly transit rooms from being
     * blacklisted just because they contain towers.
     *
     * @param {Creep} creep
     * @returns {boolean} true if room should be avoided, false if safe
     */
    checkForHostileTowers: function(creep) {
        // Never blacklist the target room itself
        if (creep.room.name === creep.memory.targetRoom) {
            return false;
        }

        // IFF room-level check: if the room is owned or reserved by a whitelisted
        // player it is safe regardless of what structures it contains.
        const ctrl = creep.room.controller;
        if (ctrl) {
            if (ctrl.owner && iff.isFriendlyUsername(ctrl.owner.username)) {
                return false;
            }
            if (ctrl.reservation && iff.isFriendlyUsername(ctrl.reservation.username)) {
                return false;
            }
        }

        // Scan for hostile towers (towers whose owner is NOT whitelisted)
        const towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => {
                if (s.structureType !== STRUCTURE_TOWER) return false;
                // Per-tower IFF guard handles unclaimed rooms where a tower's
                // owner field may differ from the room controller owner
                return !iff.isFriendlyUsername(s.owner && s.owner.username);
            }
        });

        if (towers.length > 0) {
            if (!creep.memory.blacklistedRooms) {
                creep.memory.blacklistedRooms = [];
            }

            if (!creep.memory.blacklistedRooms.includes(creep.room.name)) {
                creep.memory.blacklistedRooms.push(creep.room.name);
                this.clearAllMovementCache(creep);

                // Diagnostic: log exactly what caused the blacklist decision
                const ctrlOwner    = ctrl && ctrl.owner       ? ctrl.owner.username       : '(none)';
                const ctrlReserver = ctrl && ctrl.reservation ? ctrl.reservation.username : '(none)';
                const towerOwners  = towers.map(t => (t.owner && t.owner.username) || '(no owner)').join(', ');
                console.log(`[ControllerAttack] ${creep.name}: Blacklisted room ${creep.room.name} — hostile towers detected`);
                console.log(`[ControllerAttack]   ctrl.owner="${ctrlOwner}" ctrl.reservation="${ctrlReserver}"`);
                console.log(`[ControllerAttack]   hostile tower owners: [${towerOwners}]`);
            }

            return true;
        }

        return false;
    },

    /**
     * Custom room callback that avoids blacklisted rooms
     * @param {Creep} creep
     * @returns {function} PathFinder room callback
     */
    getAvoidanceRoomCallback: function(creep) {
        return function(roomName) {
            // Block blacklisted rooms (except the target room, which we always want to reach)
            if (creep.memory.blacklistedRooms &&
                creep.memory.blacklistedRooms.includes(roomName) &&
                roomName !== creep.memory.targetRoom) {
                console.log(`[ControllerAttack] ${creep.name}: Blocking pathfinding through blacklisted room ${roomName}`);
                return false;
            }

            const matrix = new PathFinder.CostMatrix();
            const room = Game.rooms[roomName];
            if (room) {
                room.find(FIND_STRUCTURES).forEach(s => {
                    if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
                        matrix.set(s.pos.x, s.pos.y, 255);
                    }
                });
            }
            return matrix;
        };
    }
};

module.exports = roleControllerAttacker;