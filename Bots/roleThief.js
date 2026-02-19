// roleThief.js
// Uses shared roomNavigation for observer-scanned room-by-room travel.

// ============================================================================
// THIEF ORDER SYSTEM (continuous spawning)
// ============================================================================
//
// --- CREATE AN ORDER ---
// orderThieves('W1N1', 'W2N2', 1)
//
// --- CREATE ORDER WITH MULTIPLE THIEVES ---
// orderThieves('W1N1', 'W2N2', 3)
//
// --- VIEW ALL ORDERS WITH STATUS ---
// listThiefOrders()
//
// --- CANCEL ORDER FOR SPECIFIC TARGET ---
// cancelThiefOrder('W2N2')
//
// --- CANCEL ALL ORDERS ---
// Memory.thiefOrders = [];
//
// ============================================================================
// MANUAL SPAWNING (one-off, no respawn)
// ============================================================================
//
// --- SPAWN A THIEF ---
// Game.spawns['Spawn1'].spawnCreep(
//   [CARRY,CARRY,CARRY,CARRY,CARRY,MOVE,MOVE,MOVE,MOVE,MOVE],
//   'thief_' + Game.time,
//   { memory: { role: 'thief', homeRoom: 'W1N1', targetRoom: 'W2N2' } }
// );
//
// --- SPAWN A LARGER THIEF (for higher RCL) ---
// Game.spawns['Spawn1'].spawnCreep(
//   [CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,
//    MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
//   'thief_' + Game.time,
//   { memory: { role: 'thief', homeRoom: 'W1N1', targetRoom: 'W2N2' } }
// );
//
// ============================================================================
// MANAGEMENT & DEBUGGING
// ============================================================================
//
// --- LIST ALL ACTIVE THIEVES ---
// _.filter(Game.creeps, c => c.memory.role === 'thief').forEach(c => 
//   console.log(c.name + ': ' + c.memory.homeRoom + ' -> ' + c.memory.targetRoom + 
//     ' | stealing: ' + c.memory.stealing + ' | cargo: ' + c.store.getUsedCapacity())
// );
//
// --- RETARGET A THIEF ---
// Game.creeps['thief_12345'].memory.targetRoom = 'W3N3';
// delete Game.creeps['thief_12345'].memory.routeToTarget;
// delete Game.creeps['thief_12345'].memory.routeToTargetIndex;
//
// --- SEND THIEF HOME IMMEDIATELY ---
// Game.creeps['thief_12345'].memory.stealing = false;
// delete Game.creeps['thief_12345'].memory.routeToTarget;
//
// --- KILL A THIEF ---
// Game.creeps['thief_12345'].suicide();
//
// --- KILL ALL THIEVES ---
// _.filter(Game.creeps, c => c.memory.role === 'thief').forEach(c => c.suicide());
//
// --- VIEW BANNED ROOMS ---
// require('roleThief').BANNED_ROOMS
//
// --- CHECK ROUTE BEING USED ---
// JSON.stringify(Game.creeps['thief_12345'].memory.routeToTarget)
// JSON.stringify(Game.creeps['thief_12345'].memory.routeToHome)
//
// --- CLEAR CACHED ROUTES (force recalculation) ---
// Game.creeps['thief_12345'].memory.routeToTarget = null;
// Game.creeps['thief_12345'].memory.routeToHome = null;
//
// --- UNSTICK A THIEF ---
// delete Game.creeps['thief_12345'].memory._move
// delete Game.creeps['thief_12345'].memory.routeToTargetIndex
// delete Game.creeps['thief_12345'].memory.routeToHomeIndex
// delete Game.creeps['thief_12345'].memory.theftTarget
// delete Game.creeps['thief_12345'].memory._stuckCount
//
// --- DEBUG: VIEW OBSERVER'S BLOCKED ROOMS/EDGES ---
// JSON.stringify(Memory.depositObserver.roomStatus)
// JSON.stringify(Memory.depositObserver.blockedEdges)
//
// --- ENABLE/DISABLE NAVIGATION DEBUG ---
// setNavDebug(true)
// setNavDebug(false)
//
// ============================================================================

var roomNav = require('roomNavigation');

const DEBUG = false;
const STUCK_THRESHOLD = 3; // Ticks at same position before considered stuck

// ---------- Config ----------
const normalizeRoom = (r) => String(r || '').trim().toUpperCase();

// Banned rooms - thief will never enter or route through these
const BANNED_ROOMS = [
    'E4N51', 'E6N51', 'E8N56', 'E9N51',
].map(normalizeRoom);

// ---------- Cost Matrix (for in-room pathfinding) ----------
const avoidEdges = (roomName) => {
    const costs = new PathFinder.CostMatrix();

    const room = Game.rooms[roomName];
    if (room) {
        room.find(FIND_STRUCTURES).forEach((s) => {
            if (s.structureType === STRUCTURE_ROAD) {
                costs.set(s.pos.x, s.pos.y, 1);
            } else if (
                s.structureType !== STRUCTURE_CONTAINER &&
                (s.structureType !== STRUCTURE_RAMPART || !s.my)
            ) {
                costs.set(s.pos.x, s.pos.y, 255);
            }
        });
        
        // Also avoid creeps
        room.find(FIND_CREEPS).forEach((c) => {
            costs.set(c.pos.x, c.pos.y, 255);
        });
    }

    // Edge avoidance (expensive but passable)
    for (let x = 0; x < 50; x++) {
        if (costs.get(x, 0) < 50) costs.set(x, 0, 50);
        if (costs.get(x, 49) < 50) costs.set(x, 49, 50);
    }
    for (let y = 0; y < 50; y++) {
        if (costs.get(0, y) < 50) costs.set(0, y, 50);
        if (costs.get(49, y) < 50) costs.set(49, y, 50);
    }

    return costs;
};

// ---------- Helpers ----------
const isBannedRoom = (roomName) => BANNED_ROOMS.includes(normalizeRoom(roomName));

const splitTargetsByNonEnergy = (targets) => {
    const hasNonEnergy = (s) => {
        if (!s.store) return false;
        for (const resourceType in s.store) {
            if (resourceType !== RESOURCE_ENERGY && s.store[resourceType] > 0) return true;
        }
        return false;
    };

    return {
        nonEnergyTargets: targets.filter((s) => hasNonEnergy(s)),
        energyOnlyTargets: targets.filter((s) => !hasNonEnergy(s)),
    };
};

const hasResources = (s) => {
    if (!s) return false;
    if (s.store && s.store.getUsedCapacity() > 0) return true;
    if (s.energy !== undefined && s.energy > 0) return true;
    return false;
};

/**
 * Check if there are any non-energy resources available in the room.
 * Used to decide whether to bother taking energy or wait for better loot.
 * @param {Room} room
 * @returns {boolean}
 */
const roomHasNonEnergyResources = (room) => {
    const structures = room.find(FIND_STRUCTURES, {
        filter: (s) =>
            [
                STRUCTURE_EXTENSION,
                STRUCTURE_TOWER,
                STRUCTURE_STORAGE,
                STRUCTURE_CONTAINER,
                STRUCTURE_LAB,
                STRUCTURE_TERMINAL,
                STRUCTURE_LINK,
            ].includes(s.structureType) && !s.my
    });
    
    for (const s of structures) {
        if (!s.store) continue;
        for (const resourceType in s.store) {
            if (resourceType !== RESOURCE_ENERGY && s.store[resourceType] > 0) {
                // Check if accessible (not under rampart)
                const atPos = room.lookForAt(LOOK_STRUCTURES, s.pos);
                const hasEnemyRampart = atPos.some(
                    (st) => st.structureType === STRUCTURE_RAMPART && !st.my
                );
                if (!hasEnemyRampart) {
                    return true;
                }
            }
        }
    }
    return false;
};

/**
 * Get the best resource to withdraw from a structure.
 * Prioritizes non-energy resources. Returns null if only energy and room has other non-energy available.
 * @param {Structure} target
 * @param {Room} room
 * @returns {string|null} Resource type to withdraw, or null if should skip
 */
const getBestResourceToWithdraw = (target, room) => {
    if (!target || !target.store) return null;
    
    // First, check for non-energy resources in this target
    for (const resourceType in target.store) {
        if (resourceType !== RESOURCE_ENERGY && target.store[resourceType] > 0) {
            return resourceType;
        }
    }
    
    // Only energy in this target - check if room has non-energy elsewhere
    if (target.store[RESOURCE_ENERGY] > 0) {
        // If there's non-energy available elsewhere in the room, skip this target
        if (roomHasNonEnergyResources(room)) {
            return null; // Skip energy, go find better loot
        }
        // No non-energy anywhere, take the energy
        return RESOURCE_ENERGY;
    }
    
    return null;
};

/**
 * Check if creep is stuck (same position for multiple ticks)
 * @param {Creep} creep
 * @returns {boolean}
 */
const checkIfStuck = (creep) => {
    const posKey = creep.pos.x + ',' + creep.pos.y + ',' + creep.room.name;
    
    if (creep.memory._lastPos === posKey) {
        creep.memory._stuckCount = (creep.memory._stuckCount || 0) + 1;
    } else {
        creep.memory._lastPos = posKey;
        creep.memory._stuckCount = 0;
    }
    
    return creep.memory._stuckCount >= STUCK_THRESHOLD;
};

/**
 * Clear stuck state
 * @param {Creep} creep
 */
const clearStuckState = (creep) => {
    delete creep.memory._stuckCount;
    delete creep.memory._lastPos;
    delete creep.memory._move;
};

/**
 * Smart move that handles failures and stuck detection
 * @param {Creep} creep
 * @param {RoomObject} target
 * @param {Object} opts
 * @returns {number} Move result or custom error
 */
const smartMoveTo = (creep, target, opts) => {
    opts = opts || {};
    
    const result = creep.moveTo(target, {
        reusePath: opts.reusePath || 5,
        maxOps: opts.maxOps || 2000,
        costCallback: opts.costCallback,
    });
    
    if (result === ERR_NO_PATH) {
        if (DEBUG) console.log('[Thief] ' + creep.name + ' ERR_NO_PATH to ' + target);
        delete creep.memory._move;
        return ERR_NO_PATH;
    }
    
    // Check if stuck
    if (checkIfStuck(creep)) {
        if (DEBUG) console.log('[Thief] ' + creep.name + ' stuck at ' + creep.pos);
        clearStuckState(creep);
        return ERR_NO_PATH; // Treat stuck as no path
    }
    
    return result;
};

// ---------- Navigation Wrapper ----------

/**
 * Travel to a destination room using observer-scanned routes.
 * @param {Creep} creep
 * @param {string} destRoom
 * @param {string} routeKey - Memory key for this route
 * @returns {number} OK if in dest room, otherwise movement result
 */
function travelToRoom(creep, destRoom, routeKey) {
    destRoom = normalizeRoom(destRoom);
    var here = normalizeRoom(creep.room.name);
    
    if (here === destRoom) {
        return OK;
    }
    
    // Ensure we have a route (uses observer data when available)
    var route = roomNav.ensureRoute(creep, here, destRoom, routeKey, BANNED_ROOMS);
    
    if (!route) {
        console.log('[Thief] ' + creep.name + ' cannot find route to ' + destRoom);
        return ERR_NO_PATH;
    }
    
    // Follow the room-by-room route
    var result = roomNav.followRoomRoute(creep, routeKey, destRoom);
    
    if (result !== OK && result !== ERR_TIRED) {
        // Route might be stale, clear and retry next tick
        console.log('[Thief] ' + creep.name + ' followRoomRoute returned ' + result + ', clearing route.');
        roomNav.clearRoute(creep, routeKey);
    }
    
    return result;
}

// ---------- Order Management Functions ----------

function orderThieves(homeRoom, targetRoom, count) {
    if (!homeRoom || !targetRoom) {
        console.log('[Thief] Usage: orderThieves(homeRoom, targetRoom, count)');
        return ERR_INVALID_ARGS;
    }
    
    homeRoom = normalizeRoom(homeRoom);
    targetRoom = normalizeRoom(targetRoom);
    count = count || 1;
    
    // Check if target is banned
    if (isBannedRoom(targetRoom)) {
        console.log('[Thief] ERROR: ' + targetRoom + ' is in BANNED_ROOMS list!');
        return ERR_INVALID_TARGET;
    }
    
    if (!Memory.thiefOrders) Memory.thiefOrders = [];
    
    // Check if order already exists
    const existing = Memory.thiefOrders.find(o => 
        normalizeRoom(o.homeRoom) === homeRoom && normalizeRoom(o.targetRoom) === targetRoom
    );
    
    if (existing) {
        existing.count = count;
        console.log('[Thief] Updated order: ' + homeRoom + ' -> ' + targetRoom + ' (count: ' + count + ')');
    } else {
        Memory.thiefOrders.push({ homeRoom: homeRoom, targetRoom: targetRoom, count: count });
        console.log('[Thief] Created order: ' + homeRoom + ' -> ' + targetRoom + ' (count: ' + count + ')');
    }
    
    return OK;
}

function cancelThiefOrder(targetRoom) {
    if (!targetRoom) {
        console.log('[Thief] Usage: cancelThiefOrder(targetRoom)');
        return ERR_INVALID_ARGS;
    }
    
    targetRoom = normalizeRoom(targetRoom);
    
    if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) {
        console.log('[Thief] No active orders.');
        return ERR_NOT_FOUND;
    }
    
    const before = Memory.thiefOrders.length;
    Memory.thiefOrders = Memory.thiefOrders.filter(o => normalizeRoom(o.targetRoom) !== targetRoom);
    const removed = before - Memory.thiefOrders.length;
    
    if (removed > 0) {
        console.log('[Thief] Cancelled ' + removed + ' order(s) targeting ' + targetRoom);
        return OK;
    } else {
        console.log('[Thief] No orders found targeting ' + targetRoom);
        return ERR_NOT_FOUND;
    }
}

function listThiefOrders() {
    if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) {
        console.log('[Thief] No active orders.');
        return;
    }
    
    console.log('[Thief] Active Orders:');
    console.log('─────────────────────────────────────────');
    
    Memory.thiefOrders.forEach(o => {
        const active = _.filter(Game.creeps, c =>
            c.memory.role === 'thief' &&
            normalizeRoom(c.memory.homeRoom) === normalizeRoom(o.homeRoom) &&
            normalizeRoom(c.memory.targetRoom) === normalizeRoom(o.targetRoom)
        );
        
        const spawning = _.filter(Game.spawns, s =>
            s.spawning &&
            Memory.creeps[s.spawning.name] &&
            Memory.creeps[s.spawning.name].role === 'thief' &&
            normalizeRoom(Memory.creeps[s.spawning.name].homeRoom) === normalizeRoom(o.homeRoom) &&
            normalizeRoom(Memory.creeps[s.spawning.name].targetRoom) === normalizeRoom(o.targetRoom)
        ).length;
        
        const status = active.length >= o.count ? '✓' : '⏳';
        const spawningStr = spawning > 0 ? ' (+' + spawning + ' spawning)' : '';
        
        console.log('  ' + status + ' ' + o.homeRoom + ' -> ' + o.targetRoom + 
            ': ' + active.length + '/' + o.count + spawningStr);
        
        // Show individual creep status
        active.forEach(c => {
            const state = c.memory.stealing ? 'stealing' : 'returning';
            const cargo = c.store.getUsedCapacity() + '/' + c.store.getCapacity();
            const ttl = c.ticksToLive || 'spawning';
            const stuck = c.memory._stuckCount ? ' STUCK:' + c.memory._stuckCount : '';
            console.log('    └─ ' + c.name + ' [' + state + '] cargo: ' + cargo + ' TTL: ' + ttl + stuck);
        });
    });
    
    console.log('─────────────────────────────────────────');
}

// ---------- Main Role Logic ----------

const roleThief = {
    /** @param {Creep} creep **/
    run: function (creep) {
        const here = normalizeRoom(creep.room.name);
        const targetRoomName = normalizeRoom(creep.memory.targetRoom);
        const homeRoomName = normalizeRoom(creep.memory.homeRoom);

        const inTargetRoom = here === targetRoomName;
        const inHomeRoom = here === homeRoomName;

        // Clear cached paths when changing rooms
        if (creep.memory._lastRoom && normalizeRoom(creep.memory._lastRoom) !== here) {
            delete creep.memory._move;
            clearStuckState(creep);
        }
        creep.memory._lastRoom = here;

        // If target is banned, never steal - just go home
        if (isBannedRoom(targetRoomName)) {
            creep.memory.stealing = false;
        }

        // State transitions
        if (creep.memory.stealing && creep.store.getFreeCapacity() === 0) {
            creep.memory.stealing = false;
            delete creep.memory.theftTarget;
            delete creep.memory.depositTarget;
            delete creep.memory._move;
            clearStuckState(creep);
            roomNav.clearRoute(creep, 'routeToTarget');
        }

        if (!creep.memory.stealing && creep.store.getUsedCapacity() === 0) {
            if (!isBannedRoom(targetRoomName)) {
                creep.memory.stealing = true;
                delete creep.memory.depositTarget;
                delete creep.memory.theftTarget;
                delete creep.memory._move;
                clearStuckState(creep);
                roomNav.clearRoute(creep, 'routeToHome');
            }
        }

        // If in a banned room, leave immediately
        if (isBannedRoom(here)) {
            const desired = creep.memory.stealing ? targetRoomName : homeRoomName;
            travelToRoom(creep, desired, creep.memory.stealing ? 'routeToTarget' : 'routeToHome');
            return;
        }

        // Edge escape when we've arrived at our destination room
        // (roomNavigation handles edge bounce during transit)
        if (roomNav.isOnEdge(creep.pos)) {
            if ((creep.memory.stealing && inTargetRoom) || (!creep.memory.stealing && inHomeRoom)) {
                creep.moveTo(new RoomPosition(25, 25, creep.room.name), {
                    reusePath: 5,
                    costCallback: avoidEdges,
                });
                return;
            }
        }

        // ========== STEALING MODE ==========
        if (creep.memory.stealing) {
            // Travel to target room
            if (!inTargetRoom) {
                travelToRoom(creep, targetRoomName, 'routeToTarget');
                return;
            }

            // Clear stale navigation cache when we arrive at target room
            // This prevents the exit-constrained cost matrix from blocking in-room movement
            if (creep.memory.routeToTargetIndex !== undefined) {
                delete creep.memory._move;
                delete creep.memory.routeToTargetIndex;
                clearStuckState(creep);
                if (DEBUG) console.log('[Thief] ' + creep.name + ' arrived at target, cleared nav cache');
            }

            // Extra safety: never steal in banned room
            if (isBannedRoom(here)) return;

            // Find theft target
            let target = creep.memory.theftTarget ? Game.getObjectById(creep.memory.theftTarget) : null;

            // Check if current target still has valuable resources
            if (target) {
                const bestResource = getBestResourceToWithdraw(target, creep.room);
                if (!bestResource) {
                    // Target only has energy but room has non-energy elsewhere, find new target
                    delete creep.memory.theftTarget;
                    delete creep.memory._move;
                    clearStuckState(creep);
                    target = null;
                }
            }

            if (!target || !hasResources(target)) {
                delete creep.memory.theftTarget;
                delete creep.memory._move;
                clearStuckState(creep);

                const allStructures = creep.room.find(FIND_STRUCTURES, {
                    filter: (s) =>
                        [
                            STRUCTURE_EXTENSION,
                            STRUCTURE_TOWER,
                            STRUCTURE_STORAGE,
                            STRUCTURE_CONTAINER,
                            STRUCTURE_LAB,
                            STRUCTURE_TERMINAL,
                            STRUCTURE_LINK,
                        ].includes(s.structureType) && hasResources(s),
                });

                const enemyStructures = allStructures.filter((s) => !s.my);

                const potentialTargets = enemyStructures.filter((s) => {
                    const atPos = creep.room.lookForAt(LOOK_STRUCTURES, s.pos);
                    const hasEnemyRampart = atPos.some(
                        (st) => st.structureType === STRUCTURE_RAMPART && !st.my
                    );
                    return !hasEnemyRampart;
                });

                if (potentialTargets.length) {
                    const { nonEnergyTargets, energyOnlyTargets } = splitTargetsByNonEnergy(potentialTargets);

                    // Prioritize structures with non-energy resources
                    // Only consider energy-only targets if no non-energy targets exist
                    target =
                        (nonEnergyTargets.length &&
                            creep.pos.findClosestByPath(nonEnergyTargets, { costCallback: avoidEdges })) ||
                        (nonEnergyTargets.length && creep.pos.findClosestByRange(nonEnergyTargets)) ||
                        (energyOnlyTargets.length && !roomHasNonEnergyResources(creep.room) &&
                            creep.pos.findClosestByPath(energyOnlyTargets, { costCallback: avoidEdges })) ||
                        (energyOnlyTargets.length && !roomHasNonEnergyResources(creep.room) && 
                            creep.pos.findClosestByRange(energyOnlyTargets)) ||
                        null;

                    if (target) creep.memory.theftTarget = target.id;
                }
            }

            // Withdraw from target
            if (target && hasResources(target)) {
                const resourceToWithdraw = getBestResourceToWithdraw(target, creep.room);
                
                if (resourceToWithdraw) {
                    const res = creep.withdraw(target, resourceToWithdraw);
                    if (res === ERR_NOT_IN_RANGE) {
                        const moveResult = smartMoveTo(creep, target, { costCallback: avoidEdges });
                        
                        // If we can't path to this target, blacklist it and find another
                        if (moveResult === ERR_NO_PATH) {
                            if (DEBUG) console.log('[Thief] ' + creep.name + ' cannot reach target, finding new one');
                            delete creep.memory.theftTarget;
                            delete creep.memory._move;
                        }
                    } else if (res === OK) {
                        clearStuckState(creep); // Successful action, clear stuck state
                        // Check if target is now empty or only has energy (and room has non-energy elsewhere)
                        const nextResource = getBestResourceToWithdraw(target, creep.room);
                        if (!nextResource) {
                            delete creep.memory.theftTarget;
                        }
                    }
                } else {
                    // No valid resource to withdraw (only energy, but room has non-energy elsewhere)
                    delete creep.memory.theftTarget;
                    delete creep.memory._move;
                    clearStuckState(creep);
                }
            } else {
                // No target available - idle in center while waiting for targets
                creep.moveTo(new RoomPosition(25, 25, creep.room.name), {
                    reusePath: 5,
                    costCallback: avoidEdges,
                });
            }

        // ========== RETURNING MODE ==========
        } else {
            // Travel to home room
            if (!inHomeRoom) {
                travelToRoom(creep, homeRoomName, 'routeToHome');
                return;
            }

            // Clear stale navigation cache when we arrive at home room
            // This prevents the exit-constrained cost matrix from blocking in-room movement
            if (creep.memory.routeToHomeIndex !== undefined) {
                delete creep.memory._move;
                delete creep.memory.routeToHomeIndex;
                clearStuckState(creep);
                if (DEBUG) console.log('[Thief] ' + creep.name + ' arrived at home, cleared nav cache');
            }

            // Find deposit target
            let depositTarget = creep.memory.depositTarget ? Game.getObjectById(creep.memory.depositTarget) : null;

            if (!depositTarget || !depositTarget.store || depositTarget.store.getFreeCapacity() === 0) {
                delete creep.memory.depositTarget;
                delete creep.memory._move;
                clearStuckState(creep);

                const potentialDeposits = creep.room.find(FIND_STRUCTURES, {
                    filter: (s) =>
                        (
                            (s.structureType === STRUCTURE_STORAGE && s.my) ||
                            s.structureType === STRUCTURE_CONTAINER
                        ) &&
                        s.store &&
                        s.store.getFreeCapacity() > 0,
                });

                if (potentialDeposits.length) {
                    depositTarget =
                        creep.pos.findClosestByPath(potentialDeposits, { costCallback: avoidEdges }) ||
                        creep.pos.findClosestByRange(potentialDeposits);

                    if (depositTarget) creep.memory.depositTarget = depositTarget.id;
                }
            }

            // Transfer to deposit
            if (depositTarget && depositTarget.store && depositTarget.store.getFreeCapacity() > 0) {
                for (const resourceType in creep.store) {
                    const res = creep.transfer(depositTarget, resourceType);
                    if (res === ERR_NOT_IN_RANGE) {
                        const moveResult = smartMoveTo(creep, depositTarget, { costCallback: avoidEdges });
                        
                        // If we can't path to this deposit, find another
                        if (moveResult === ERR_NO_PATH) {
                            if (DEBUG) console.log('[Thief] ' + creep.name + ' cannot reach deposit, finding new one');
                            delete creep.memory.depositTarget;
                            delete creep.memory._move;
                        }
                    } else if (res === OK) {
                        clearStuckState(creep); // Successful action, clear stuck state
                    }
                    break;
                }

                if (depositTarget.store.getFreeCapacity() === 0) delete creep.memory.depositTarget;
            }
        }
    },
};

module.exports = {
    run: roleThief.run,
    BANNED_ROOMS: BANNED_ROOMS,
    orderThieves: orderThieves,
    cancelThiefOrder: cancelThiefOrder,
    listThiefOrders: listThiefOrders
};