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
// --- UPDATE THIEF COUNT FOR EXISTING ORDER ---
// updateThiefOrder('W2N2', 5)
//
// --- VIEW ALL ORDERS WITH STATUS ---
// listThiefOrders()
//
// --- CANCEL ORDER FOR SPECIFIC TARGET ---
// cancelThiefOrder('W2N2')
//
// --- CANCEL ALL ORDERS ---
// Memory.thiefOrders = [];

var roomNav = require('roomNavigation');
const getRoomStateCentral = require('getRoomState');

const DEBUG = false;

// ---------- Config ----------
const normalizeRoom = (r) => String(r || '').trim().toUpperCase();

const BANNED_ROOMS = [
    'E4N51', 'E6N51', 'E8N56', 'E9N51',
].map(normalizeRoom);

const NEAR_EDGE_DIST = 5;

// ── Edge-avoid CostMatrix cache (Aligned with Wall Repair) ───────────────────
var CACHE_REFRESH_TICKS = 25;
if (!global._edgeAvoidCache) global._edgeAvoidCache = {};

function getEdgeAvoidCacheEntry(roomName) {
    if (!global._edgeAvoidCache[roomName]) {
        global._edgeAvoidCache[roomName] = { builtAt: 0, matrix: null };
    }
    return global._edgeAvoidCache[roomName];
}

function buildEdgeAvoidMatrixFor(room) {
    var matrix = new PathFinder.CostMatrix();
    // Do not globally block edges here for a multi-room traveler, 
    // but preserve the road/structure mapping logic
    if (!room) return matrix;

    var structs = [];
    if (getRoomStateCentral && typeof getRoomStateCentral.get === 'function') {
        var base = getRoomStateCentral.get(room.name);
        if (base && base.structuresByType) {
            for (var t in base.structuresByType) {
                var arr = base.structuresByType[t];
                if (arr && arr.length) {
                    for (var i = 0; i < arr.length; i++) structs.push(arr[i]);
                }
            }
        }
    } else {
        structs = room.find(FIND_STRUCTURES);
    }

    for (var i2 = 0; i2 < structs.length; i2++) {
        var s = structs[i2];
        if (s.structureType === STRUCTURE_ROAD) {
            matrix.set(s.pos.x, s.pos.y, 1);
        } else if (
            s.structureType !== STRUCTURE_CONTAINER &&
            (s.structureType !== STRUCTURE_RAMPART || !s.my)
        ) {
            matrix.set(s.pos.x, s.pos.y, 255);
        }
    }
    return matrix;
}

function getEdgeAvoidMatrix(roomName) {
    var entry = getEdgeAvoidCacheEntry(roomName);
    if (!entry.matrix || Game.time - entry.builtAt >= CACHE_REFRESH_TICKS) {
        entry.matrix = buildEdgeAvoidMatrixFor(Game.rooms[roomName]);
        entry.builtAt = Game.time;
    }
    return entry.matrix;
}

// ── Stuck detection (Identical to Wall Repair) ───────────────────────────────
var STUCK_THRESHOLD = 5;
function updateStuckCounter(creep) {
    if (!creep.memory._stk) {
        creep.memory._stk = { x: creep.pos.x, y: creep.pos.y, r: creep.pos.roomName, n: 0 };
    }
    var s = creep.memory._stk;
    if (s.x === creep.pos.x && s.y === creep.pos.y && s.r === creep.pos.roomName) {
        s.n++;
    } else {
        s.x = creep.pos.x; s.y = creep.pos.y; s.r = creep.pos.roomName; s.n = 0;
    }
    return s.n >= STUCK_THRESHOLD;
}

function consumeStuck(creep) {
    var stuck = updateStuckCounter(creep);
    if (stuck) creep.memory._stk.n = 0;
    return stuck;
}

function edgeAvoidMoveOpts(creep, lockRoomName) {
    var roomName = lockRoomName || creep.room.name;
    var stuck = consumeStuck(creep);
    return {
        reusePath: stuck ? 1 : 15,
        ignoreCreeps: !stuck,
        maxRooms: 1,
        plainCost: 20,
        swampCost: 40,
        roomCallback: function(rn) { return rn === roomName ? getEdgeAvoidMatrix(roomName) : false; }
    };
}

function stayOffEdges(creep) {
    if (creep.pos.x === 0) creep.move(RIGHT);
    else if (creep.pos.x === 49) creep.move(LEFT);
    if (creep.pos.y === 0) creep.move(BOTTOM);
    else if (creep.pos.y === 49) creep.move(TOP);
}

// ---------- Helpers ----------
const isBannedRoom = (roomName) => BANNED_ROOMS.includes(normalizeRoom(roomName));

const isOnEdge = (pos) => pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;

const clearRoute = (creep, routeKey) => {
    delete creep.memory[routeKey];
    delete creep.memory[routeKey + 'Index'];
};

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
    if (s.amount !== undefined && s.amount > 0) return true;
    if (s.store && s.store.getUsedCapacity() > 0) return true;
    if (s.energy !== undefined && s.energy > 0) return true;
    return false;
};

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

const getBestResourceToWithdraw = (target, room) => {
    if (!target || !target.store) return null;

    for (const resourceType in target.store) {
        if (resourceType !== RESOURCE_ENERGY && target.store[resourceType] > 0) {
            return resourceType;
        }
    }

    if (target.store[RESOURCE_ENERGY] > 0) {
        if (roomHasNonEnergyResources(room)) {
            return null;
        }
        return RESOURCE_ENERGY;
    }

    return null;
};

const clearStuckState = (creep) => {
    if (creep.memory._stk) {
        creep.memory._stk.n = 0;
    }
    delete creep.memory._move;
};

const smartMoveTo = (creep, target, opts) => {
    var moveOpts = edgeAvoidMoveOpts(creep, creep.room.name);
    if (opts && opts.range) moveOpts.range = opts.range;

    const result = creep.moveTo(target, moveOpts);

    if (result === ERR_NO_PATH) {
        if (DEBUG) console.log('[Thief] ' + creep.name + ' ERR_NO_PATH to ' + target);
        delete creep.memory._move;
        return ERR_NO_PATH;
    }

    return result;
};

function stepInwardOffEdge(creep) {
    const pos = creep.pos;

    if (!isOnEdge(pos)) {
        delete creep.memory._settlingInRoom;
        return false;
    }

    let targetX = pos.x;
    let targetY = pos.y;

    if (pos.x === 0) targetX = 1;
    else if (pos.x === 49) targetX = 48;

    if (pos.y === 0) targetY = 1;
    else if (pos.y === 49) targetY = 48;

    const inwardPos = new RoomPosition(targetX, targetY, creep.room.name);

    delete creep.memory._move;
    delete creep.memory._moveDir;
    delete creep.memory.routeToTarget;
    delete creep.memory.routeToTargetIndex;
    delete creep.memory.routeToHome;
    delete creep.memory.routeToHomeIndex;

    creep.memory._settlingInRoom = creep.room.name;

    const dir = pos.getDirectionTo(inwardPos);
    const moveResult = creep.move(dir);

    if (moveResult === OK) {
        return true;
    }

    const result = creep.moveTo(inwardPos, {
        reusePath: 0,
        maxRooms: 1,
        maxOps: 500,
        plainCost: 20,
        swampCost: 40,
        roomCallback: function(rn) { return rn === creep.room.name ? getEdgeAvoidMatrix(rn) : false; }
    });

    return true;
}

// ---------- Navigation Wrapper ----------
function travelToRoom(creep, destRoom, routeKey) {
    destRoom = normalizeRoom(destRoom);
    const here = normalizeRoom(creep.room.name);

    if (creep.memory._move &&
        creep.memory._move.dest &&
        normalizeRoom(creep.memory._move.dest.room) !== here) {
        delete creep.memory._move;
    }

    if (here === destRoom) {
        if (isOnEdge(creep.pos)) {
            stepInwardOffEdge(creep);
            return ERR_TIRED;
        }
        delete creep.memory._settlingInRoom;
        if (creep.memory[routeKey] !== undefined || creep.memory[routeKey + 'Index'] !== undefined) {
            clearRoute(creep, routeKey);
            clearStuckState(creep);
        }
        return OK;
    }

    const existingRoute = creep.memory[routeKey];
    if (existingRoute && Array.isArray(existingRoute)) {
        const normalizedRoute = existingRoute.map(normalizeRoom);
        const currentPosInRoute = normalizedRoute.indexOf(here);
        const storedIndex = creep.memory[routeKey + 'Index'] || 0;
        if (currentPosInRoute !== -1 && currentPosInRoute > storedIndex) {
            creep.memory[routeKey + 'Index'] = currentPosInRoute;
            delete creep.memory._move;
        }
    }

    const route = roomNav.ensureRoute(creep, here, destRoom, routeKey, BANNED_ROOMS);

    if (!route) {
        const mapRoute = Game.map.findRoute(here, destRoom, {
            routeCallback: (roomName) => BANNED_ROOMS.includes(normalizeRoom(roomName)) ? Infinity : 1,
        });

        if (mapRoute && mapRoute.length > 0) {
            const exitDir = mapRoute[0].exit;
            const exitTiles = creep.room.find(exitDir);
            if (exitTiles.length > 0) {
                const closest = creep.pos.findClosestByRange(exitTiles);
                if (closest) {
                    var fallbackOpts = edgeAvoidMoveOpts(creep, creep.room.name);
                    fallbackOpts.maxRooms = 2; // Allow cross-room edge tracking
                    creep.moveTo(closest, fallbackOpts);
                    return ERR_TIRED;
                }
            }
        }
        return ERR_NO_PATH;
    }

    const pos = creep.pos;
    const nearEdge =
        pos.x < NEAR_EDGE_DIST || pos.x >= 50 - NEAR_EDGE_DIST ||
        pos.y < NEAR_EDGE_DIST || pos.y >= 50 - NEAR_EDGE_DIST;

    if (nearEdge) {
        let exitDir = null;
        const storedRoute = creep.memory[routeKey];
        const routeIdx = creep.memory[routeKey + 'Index'] || 0;
        if (storedRoute && storedRoute[routeIdx]) {
            const nextEntry = storedRoute[routeIdx];
            const nextRoom = typeof nextEntry === 'string' ? nextEntry : (nextEntry.room || null);
            if (nextRoom) {
                exitDir = Game.map.findExit(here, normalizeRoom(nextRoom));
            }
        }

        if (!exitDir || exitDir < 0) {
            const mapRoute = Game.map.findRoute(here, destRoom, {
                routeCallback: function (roomName) {
                    if (BANNED_ROOMS.includes(normalizeRoom(roomName))) return Infinity;
                    return 1;
                }
            });
            if (mapRoute && mapRoute.length > 0) {
                exitDir = mapRoute[0].exit;
            }
        }

        if (exitDir && exitDir > 0) {
            const exitTiles = creep.room.find(exitDir);
            if (exitTiles.length > 0) {
                const closest = creep.pos.findClosestByRange(exitTiles);
                if (closest) {
                    var edgeOpts = edgeAvoidMoveOpts(creep, creep.room.name);
                    edgeOpts.maxRooms = 2;
                    const moveToExit = creep.moveTo(closest, edgeOpts);
                    if (moveToExit === OK || moveToExit === ERR_TIRED) {
                        return ERR_TIRED;
                    }
                }
            }
        }
    }

    // Capture current position to evaluate stuck rules before passing to external routing
    updateStuckCounter(creep);
    const result = roomNav.followRoomRoute(creep, routeKey, destRoom);

    if (result !== OK && result !== ERR_TIRED) {
        clearRoute(creep, routeKey);
    }

    return result;
}

// ---------- Order Management ----------
function orderThieves(homeRoom, targetRoom, count) {
    if (!homeRoom || !targetRoom || !count || count <= 0) {
        return ERR_INVALID_ARGS;
    }
    homeRoom = normalizeRoom(homeRoom);
    targetRoom = normalizeRoom(targetRoom);

    if (!Game.rooms[homeRoom] || !Game.rooms[homeRoom].controller || !Game.rooms[homeRoom].controller.my) {
        return ERR_INVALID_TARGET;
    }
    if (isBannedRoom(targetRoom)) {
        return ERR_INVALID_TARGET;
    }

    if (!Memory.thiefOrders) Memory.thiefOrders = [];
    const existing = Memory.thiefOrders.find((o) => normalizeRoom(o.targetRoom) === targetRoom);
    if (existing) {
        return ERR_NAME_EXISTS;
    }

    Memory.thiefOrders.push({ homeRoom, targetRoom, count: parseInt(count, 10) });
    return OK;
}

function cancelThiefOrder(targetRoom) {
    if (!targetRoom) return ERR_INVALID_ARGS;
    targetRoom = normalizeRoom(targetRoom);
    if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) return ERR_NOT_FOUND;

    const before = Memory.thiefOrders.length;
    Memory.thiefOrders = Memory.thiefOrders.filter((o) => normalizeRoom(o.targetRoom) !== targetRoom);
    return (before - Memory.thiefOrders.length > 0) ? OK : ERR_NOT_FOUND;
}

function updateThiefOrder(targetRoom, newCount) {
    if (!targetRoom || !newCount || newCount <= 0) return ERR_INVALID_ARGS;
    targetRoom = normalizeRoom(targetRoom);
    if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) return ERR_NOT_FOUND;

    const order = Memory.thiefOrders.find((o) => normalizeRoom(o.targetRoom) === targetRoom);
    if (!order) return ERR_NOT_FOUND;

    order.count = parseInt(newCount, 10);
    return OK;
}

function listThiefOrders() {
    if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) {
        console.log('[Thief] No active orders.');
        return;
    }
    console.log('[Thief] Active Orders:');
    console.log('─────────────────────────────────────────');

    Memory.thiefOrders.forEach((o) => {
        const active = _.filter(Game.creeps, (c) =>
            c.memory.role === 'thief' &&
            normalizeRoom(c.memory.homeRoom) === normalizeRoom(o.homeRoom) &&
            normalizeRoom(c.memory.targetRoom) === normalizeRoom(o.targetRoom)
        );
        console.log('  ' + o.homeRoom + ' -> ' + o.targetRoom + ': ' + active.length + '/' + o.count);
    });
}

global.orderThieves = orderThieves;
global.cancelThiefOrder = cancelThiefOrder;
global.updateThiefOrder = updateThiefOrder;
global.listThiefOrders = listThiefOrders;

// ---------- Main Role Logic ----------
const roleThief = {
    run: function (creep) {
        const here = normalizeRoom(creep.room.name);
        const targetRoomName = normalizeRoom(creep.memory.targetRoom);
        const homeRoomName = normalizeRoom(creep.memory.homeRoom);

        const inTargetRoom = here === targetRoomName;
        const inHomeRoom = here === homeRoomName;

        if (creep.memory._settlingInRoom === here) {
            if (isOnEdge(creep.pos)) {
                stepInwardOffEdge(creep);
                return;
            } else {
                delete creep.memory._settlingInRoom;
            }
        }

        if (creep.memory.stealing && inTargetRoom && isOnEdge(creep.pos)) {
            stepInwardOffEdge(creep);
            return;
        }

        if (!creep.memory.stealing && inHomeRoom && isOnEdge(creep.pos)) {
            stepInwardOffEdge(creep);
            return;
        }

        const fullyInTargetRoom = inTargetRoom && !isOnEdge(creep.pos);
        const fullyInHomeRoom = inHomeRoom && !isOnEdge(creep.pos);

        if (creep.memory._lastRoom && normalizeRoom(creep.memory._lastRoom) !== here) {
            delete creep.memory._move;
            clearStuckState(creep);
        }
        creep.memory._lastRoom = here;

        if (isBannedRoom(targetRoomName)) {
            creep.memory.stealing = false;
        }

        if (creep.memory.stealing && creep.store.getFreeCapacity() === 0) {
            creep.memory.stealing = false;
            delete creep.memory.theftTarget;
            delete creep.memory.depositTarget;
            delete creep.memory._move;
            clearStuckState(creep);
            clearRoute(creep, 'routeToTarget');
        }

        if (!creep.memory.stealing && creep.store.getUsedCapacity() === 0) {
            if (!isBannedRoom(targetRoomName)) {
                creep.memory.stealing = true;
                delete creep.memory.depositTarget;
                delete creep.memory.theftTarget;
                delete creep.memory._move;
                clearStuckState(creep);
                clearRoute(creep, 'routeToHome');
            }
        }

        if (isBannedRoom(here)) {
            const desired = creep.memory.stealing ? targetRoomName : homeRoomName;
            travelToRoom(creep, desired, creep.memory.stealing ? 'routeToTarget' : 'routeToHome');
            return;
        }

        // ========== STEALING MODE ==========
        if (creep.memory.stealing) {
            if (!fullyInTargetRoom) {
                travelToRoom(creep, targetRoomName, 'routeToTarget');
                return;
            }

            if (creep.memory.routeToTargetIndex !== undefined) {
                delete creep.memory._move;
                delete creep.memory.routeToTargetIndex;
                clearStuckState(creep);
            }

            let target = creep.memory.theftTarget ? Game.getObjectById(creep.memory.theftTarget) : null;

            if (target && target.amount === undefined) {
                const bestResource = getBestResourceToWithdraw(target, creep.room);
                if (!bestResource) {
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

                const droppedResources = creep.room.find(FIND_DROPPED_RESOURCES);
                const nonEnergyDrops = droppedResources.filter(r => r.resourceType !== RESOURCE_ENERGY);
                const energyDrops    = droppedResources.filter(r => r.resourceType === RESOURCE_ENERGY);

                const allStructures = creep.room.find(FIND_STRUCTURES, {
                    filter: (s) =>
                        [
                            STRUCTURE_EXTENSION, STRUCTURE_TOWER,  STRUCTURE_STORAGE,
                            STRUCTURE_CONTAINER, STRUCTURE_LAB,    STRUCTURE_TERMINAL,
                            STRUCTURE_LINK,
                        ].includes(s.structureType) && hasResources(s),
                });

                const enemyStructures = allStructures.filter((s) => !s.my);
                const potentialTargets = enemyStructures.filter((s) => {
                    const atPos = creep.room.lookForAt(LOOK_STRUCTURES, s.pos);
                    return !atPos.some((st) => st.structureType === STRUCTURE_RAMPART && !st.my);
                });

                const split = splitTargetsByNonEnergy(potentialTargets);

                const closestByPath = (arr) =>
                    arr.length
                        ? creep.pos.findClosestByPath(arr, {
                              maxRooms: 1,
                              costCallback: (rn) => rn === creep.room.name ? getEdgeAvoidMatrix(rn) : false,
                          }) || creep.pos.findClosestByRange(arr)
                        : null;

                const noNonEnergyStructures = !split.nonEnergyTargets.length;
                const roomHasNoNonEnergy    = !roomHasNonEnergyResources(creep.room);

                target =
                    closestByPath(nonEnergyDrops)                                        // 1. non-energy drops
                    || closestByPath(split.nonEnergyTargets)                             // 2. non-energy structures
                    || (noNonEnergyStructures && closestByPath(energyDrops))             // 3. energy drops
                    || (roomHasNoNonEnergy    && closestByPath(split.energyOnlyTargets)) // 4. energy structures
                    || null;

                if (target) creep.memory.theftTarget = target.id;
            }

            if (target && hasResources(target)) {
                const isDropped = target.amount !== undefined;

                if (isDropped) {
                    const res = creep.pickup(target);
                    if (res === ERR_NOT_IN_RANGE) {
                        const moveResult = smartMoveTo(creep, target);
                        if (moveResult === ERR_NO_PATH) {
                            delete creep.memory.theftTarget;
                            delete creep.memory._move;
                        }
                    } else if (res === OK) {
                        clearStuckState(creep);
                        if (!hasResources(target)) delete creep.memory.theftTarget;
                    }
                } else {
                    const resourceToWithdraw = getBestResourceToWithdraw(target, creep.room);
                    if (resourceToWithdraw) {
                        const res = creep.withdraw(target, resourceToWithdraw);
                        if (res === ERR_NOT_IN_RANGE) {
                            const moveResult = smartMoveTo(creep, target);
                            if (moveResult === ERR_NO_PATH) {
                                delete creep.memory.theftTarget;
                                delete creep.memory._move;
                            }
                        } else if (res === OK) {
                            clearStuckState(creep);
                            if (!getBestResourceToWithdraw(target, creep.room)) {
                                delete creep.memory.theftTarget;
                            }
                        }
                    } else {
                        delete creep.memory.theftTarget;
                        delete creep.memory._move;
                        clearStuckState(creep);
                    }
                }
            } else {
                stayOffEdges(creep);
                smartMoveTo(creep, new RoomPosition(25, 25, creep.room.name));
            }

        // ========== RETURNING MODE ==========
        } else {
            if (!fullyInHomeRoom) {
                travelToRoom(creep, homeRoomName, 'routeToHome');
                return;
            }

            if (creep.memory.routeToHomeIndex !== undefined) {
                delete creep.memory._move;
                delete creep.memory.routeToHomeIndex;
                clearStuckState(creep);
            }

            let depositTarget = creep.memory.depositTarget ? Game.getObjectById(creep.memory.depositTarget) : null;

            if (!depositTarget || !depositTarget.store || depositTarget.store.getFreeCapacity() === 0) {
                delete creep.memory.depositTarget;
                delete creep.memory._move;
                clearStuckState(creep);

                const potentialDeposits = creep.room.find(FIND_STRUCTURES, {
                    filter: (s) => (s.structureType === STRUCTURE_STORAGE && s.my) && s.store && s.store.getFreeCapacity() > 0,
                });

                if (potentialDeposits.length) {
                    depositTarget =
                        creep.pos.findClosestByPath(potentialDeposits, { maxRooms: 1, costCallback: function(rn) { return rn === creep.room.name ? getEdgeAvoidMatrix(rn) : false; } }) ||
                        creep.pos.findClosestByRange(potentialDeposits);

                    if (depositTarget) creep.memory.depositTarget = depositTarget.id;
                }
            }

            if (depositTarget && depositTarget.store && depositTarget.store.getFreeCapacity() > 0) {
                for (const resourceType in creep.store) {
                    const res = creep.transfer(depositTarget, resourceType);

                    if (res === ERR_NOT_IN_RANGE) {
                        const moveResult = smartMoveTo(creep, depositTarget);
                        if (moveResult === ERR_NO_PATH) {
                            delete creep.memory.depositTarget;
                            delete creep.memory._move;
                        }
                    } else if (res === OK) {
                        clearStuckState(creep);
                    }
                    break;
                }

                if (depositTarget.store.getFreeCapacity() === 0) {
                    delete creep.memory.depositTarget;
                }
            }
        }
    },
};

module.exports = {
    run: roleThief.run,
    BANNED_ROOMS,
    orderThieves,
    cancelThiefOrder,
    updateThiefOrder,
    listThiefOrders,
};