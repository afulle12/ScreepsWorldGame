// LLM: Read llmcontext.js before reviewing or changing this file.
// =============================================================================
// roleDrainDemolisher: healer half of the drain-demolisher pair
// =============================================================================
// A drain-demolisher squad pairs a towerDrain worker (variant 'drainDemolisher',
// body 25W/25M) with this healer (25H/25M). The worker bounces on the
// standard 4-position tower-drain lane; the healer parks permanently on a 5th
// position one tile further inside the safe room than the worker's healRestPos,
// healing the worker while it rests (range 1) or crosses the edge (rangedHeal).
//
// The pair is bound by memory.squadId ('dd-<home>-<target>-L<lane>').
// Operation lifecycle is owned by roleTowerDrain (Memory.towerDrainOps);
// pair spawning by spawnManager.manageDrainDemolisherSpawns().
//
// Console commands (defined in roleTowerDrain.js):
//   orderDrainDemolisher(homeRoom, targetRoom, count, preferredEdge, target)
//   testDrainDemolisher(homeRoom, targetRoom, count, preferredEdge, target)
//   cancelTowerDrainOrder(homeRoom, targetRoom)
// =============================================================================

var PARK_BLOCKED_TICKS = 10;
var ORPHAN_CHECK_INTERVAL = 50;
var getRoomState = require('getRoomState');

// ========== 5TH POSITION DERIVATION ==========

// The park tile sits one step further inward from healRestPos, away from the
// safe-room edge the lane crosses. entryEdge is the edge of the TARGET room the
// worker enters through, so the safe-room crossing edge is the opposite side.
// excludeList: array of {x, y} tiles to skip (blocked tile, other lanes' parks).
function deriveHealerParkPos(entryEdge, healRestPos, safeRoom, excludeList) {
    if (!entryEdge || !healRestPos || !safeRoom) return null;

    var dx = 0, dy = 0;
    if (entryEdge === 'W') dx = -1;      // healRest x=48 -> park x=47
    else if (entryEdge === 'E') dx = 1;  // healRest x=1  -> park x=2
    else if (entryEdge === 'N') dy = -1; // healRest y=48 -> park y=47
    else if (entryEdge === 'S') dy = 1;  // healRest y=1  -> park y=2
    else return null;

    var terrain = Game.map.getRoomTerrain(safeRoom);

    function usable(x, y) {
        // Depth >= 2 from every edge: the healer must never sit on or beside
        // an exit tile, and depth-1 tiles belong to the workers' heal line.
        if (x < 2 || x > 47 || y < 2 || y > 47) return false;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
        if (excludeList) {
            for (var e = 0; e < excludeList.length; e++) {
                if (excludeList[e] && excludeList[e].x === x && excludeList[e].y === y) return false;
            }
        }
        return true;
    }

    var candidates = [];
    var straight = { x: healRestPos.x + dx, y: healRestPos.y + dy };
    if (usable(straight.x, straight.y)) candidates.push(straight);

    for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 1; oy++) {
            if (ox === 0 && oy === 0) continue;
            var x = healRestPos.x + ox;
            var y = healRestPos.y + oy;
            if (x === straight.x && y === straight.y) continue;
            if (usable(x, y)) candidates.push({ x: x, y: y });
        }
    }

    if (candidates.length === 0) return null;

    // Stable sort: straight-line tile stays first within each terrain class,
    // but any plain tile beats a swamp one (fatigue only matters while
    // re-acquiring the tile, still cheaper to avoid).
    candidates.sort(function(a, b) {
        var aSwamp = terrain.get(a.x, a.y) === TERRAIN_MASK_SWAMP ? 1 : 0;
        var bSwamp = terrain.get(b.x, b.y) === TERRAIN_MASK_SWAMP ? 1 : 0;
        return aSwamp - bSwamp;
    });

    return { x: candidates[0].x, y: candidates[0].y, roomName: safeRoom };
}

// ========== PAIRING ==========

function findWorker(healer) {
    var squadId = healer.memory.squadId;
    if (!squadId) return null;

    return _.find(getRoomState.creepIndex().all, function(c) {
        return c && c.memory &&
               c.memory.role === 'towerDrain' &&
               c.memory.variant === 'drainDemolisher' &&
               c.memory.squadId === squadId;
    });
}

function findAlternateHealTarget(healer, worker) {
    var workerId = worker && worker.id;
    var targets = healer.pos.findInRange(FIND_MY_CREEPS, 3, {
        filter: function(c) {
            return c.id !== healer.id && c.id !== workerId && c.hits < c.hitsMax;
        }
    });

    if (targets.length === 0) return null;

    targets.sort(function(a, b) {
        var aAdjacent = healer.pos.getRangeTo(a) <= 1 ? 0 : 1;
        var bAdjacent = healer.pos.getRangeTo(b) <= 1 ? 0 : 1;
        if (aAdjacent !== bAdjacent) return aAdjacent - bAdjacent;
        return (a.hits / a.hitsMax) - (b.hits / b.hitsMax);
    });

    return targets[0];
}

// Park tiles claimed by the op's other healers, so a fallback re-derivation
// never squats on a neighboring lane's spot (targeted mode packs lanes).
function otherHealerParkTiles(healer) {
    var tiles = [];
    var idx = getRoomState.creepIndex();
    var creeps = idx && idx.all ? idx.all : [];
    for (var i = 0; i < creeps.length; i++) {
        var c = creeps[i];
        if (c.name === healer.name || !c.memory) continue;
        if (c.memory.role !== 'drainDemolisher') continue;
        if (c.memory.homeRoom !== healer.memory.homeRoom) continue;
        if (c.memory.targetRoom !== healer.memory.targetRoom) continue;
        if (c.memory.healerParkPos) tiles.push(c.memory.healerParkPos);
    }
    return tiles;
}

// ========== NAVIGATION (route-follow copied from roleContestedDemolisher) ==========

function followRoomRoute(creep) {
    var route = creep.memory.route;
    var goalRoom = creep.memory.safeRoom;

    if (!route || route.length === 0) {
        creep.moveTo(new RoomPosition(25, 25, goalRoom), { reusePath: 10 });
        return ERR_NOT_FOUND;
    }

    var currentRoom = creep.room.name;
    if (currentRoom === goalRoom) return OK;

    var allowedRooms = {};
    for (var r = 0; r < route.length; r++) {
        allowedRooms[route[r]] = true;
    }

    if (!allowedRooms[currentRoom]) {
        console.log('[DrainDemolisher] WARNING: ' + creep.name + ' in unauthorized room ' + currentRoom);
        creep.moveTo(25, 25);
        return ERR_NOT_FOUND;
    }

    var idx = route.indexOf(currentRoom);
    if (idx === -1) idx = 0;

    var nextIdx = idx + 1;
    if (nextIdx >= route.length) return OK;

    var nextRoom = route[nextIdx];

    // The op route ends at the hostile target room; the healer's journey ends
    // one room earlier. Never step past the safe room.
    if (nextRoom === creep.memory.targetRoom) return OK;

    var exitDir = Game.map.findExit(currentRoom, nextRoom);
    if (exitDir < 0) {
        console.log('[DrainDemolisher] WARNING: ' + creep.name +
                    ' route has non-adjacent hop ' + currentRoom + ' -> ' + nextRoom + ', seeking skip');
        var skipped = false;
        for (var sk = nextIdx + 1; sk < route.length; sk++) {
            if (route[sk] === creep.memory.targetRoom) break;
            var tryExit = Game.map.findExit(currentRoom, route[sk]);
            if (tryExit > 0) {
                nextRoom = route[sk];
                exitDir = tryExit;
                console.log('[DrainDemolisher] Skipping to ' + nextRoom + ' (index ' + sk + ')');
                skipped = true;
                break;
            }
        }
        if (!skipped) {
            creep.moveTo(new RoomPosition(25, 25, goalRoom), { reusePath: 10 });
            return ERR_NO_PATH;
        }
    }
    if (exitDir < 0) return ERR_NO_PATH;

    var exits = creep.room.find(exitDir);
    if (exits.length === 0) return ERR_NO_PATH;

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

// ========== HEALER STATES ==========

function stateTraveling(creep) {
    var safeRoom = creep.memory.safeRoom;

    if (creep.room.name !== safeRoom) {
        followRoomRoute(creep);
        creep.say('🚑');
        return;
    }

    var parkPos = creep.memory.healerParkPos;
    if (!parkPos) {
        parkPos = deriveHealerParkPos(creep.memory.entryEdge, creep.memory.healRestPos,
                                      safeRoom, otherHealerParkTiles(creep));
        if (!parkPos) {
            console.log('[DrainDemolisher] ' + creep.name + ' cannot derive a park tile in ' +
                        safeRoom + ', suiciding');
            creep.suicide();
            return;
        }
        creep.memory.healerParkPos = parkPos;
    }

    if (creep.pos.x === parkPos.x && creep.pos.y === parkPos.y) {
        creep.memory.state = 'parked';
        creep.say('🅿️');
        return;
    }

    creep.moveTo(new RoomPosition(parkPos.x, parkPos.y, safeRoom), { maxRooms: 1, reusePath: 5 });
    creep.say('🎯');
}

function stateParked(creep) {
    var parkPos = creep.memory.healerParkPos;
    if (!parkPos) {
        creep.memory.state = 'traveling';
        return;
    }

    if (creep.pos.x === parkPos.x && creep.pos.y === parkPos.y) {
        creep.memory.parkBlockedTicks = 0;
        return;
    }

    // Off the park tile (shoved, or the tile got squatted). Re-acquire it; if
    // something has held it for a while, derive a replacement tile instead.
    var tile = new RoomPosition(parkPos.x, parkPos.y, creep.room.name);
    var blocked = false;

    var creepsThere = tile.lookFor(LOOK_CREEPS);
    if (creepsThere.length > 0) blocked = true;

    if (!blocked) {
        var structsThere = tile.lookFor(LOOK_STRUCTURES);
        for (var s = 0; s < structsThere.length; s++) {
            var st = structsThere[s].structureType;
            if (st !== STRUCTURE_ROAD && st !== STRUCTURE_CONTAINER &&
                (st !== STRUCTURE_RAMPART || !structsThere[s].my)) {
                blocked = true;
                break;
            }
        }
    }

    if (blocked) {
        creep.memory.parkBlockedTicks = (creep.memory.parkBlockedTicks || 0) + 1;
        if (creep.memory.parkBlockedTicks > PARK_BLOCKED_TICKS) {
            var exclude = otherHealerParkTiles(creep);
            exclude.push({ x: parkPos.x, y: parkPos.y });
            var newPark = deriveHealerParkPos(creep.memory.entryEdge, creep.memory.healRestPos,
                                              creep.memory.safeRoom, exclude);
            if (newPark) {
                console.log('[DrainDemolisher] ' + creep.name + ' park tile (' + parkPos.x + ',' +
                            parkPos.y + ') blocked, moving to (' + newPark.x + ',' + newPark.y + ')');
                creep.memory.healerParkPos = newPark;
            }
            creep.memory.parkBlockedTicks = 0;
        }
    } else {
        creep.memory.parkBlockedTicks = 0;
    }

    creep.moveTo(new RoomPosition(creep.memory.healerParkPos.x, creep.memory.healerParkPos.y,
                                  creep.memory.safeRoom), { maxRooms: 1, reusePath: 0 });
}

// ========== MAIN ==========

function run(creep) {
    if (creep.spawning) return;

    if (!creep.memory.notifyDisabled) {
        if (creep.notifyWhenAttacked(false) === OK) {
            creep.memory.notifyDisabled = true;
        }
    }

    if (!creep.memory.state) creep.memory.state = 'traveling';

    // If the owning operation is gone (cancelled without registration, or
    // memory wiped), don't idle forever.
    if (Game.time % ORPHAN_CHECK_INTERVAL === 0) {
        var opKey = creep.memory.homeRoom + '->' + creep.memory.targetRoom;
        var ops = Memory.towerDrainOps && Memory.towerDrainOps.operations;
        if (!ops || !ops[opKey]) {
            console.log('[DrainDemolisher] ' + creep.name + ' orphaned (no op ' + opKey + '), suiciding');
            creep.suicide();
            return;
        }
    }

    // Heal runs alongside movement in the same tick. Worker first; if it is
    // not in range or does not need healing, help nearby friendly creeps while
    // holding the park tile. Self-heal remains the final fallback.
    var worker = findWorker(creep);
    var healed = false;
    if (worker && !worker.spawning && worker.room.name === creep.room.name &&
        worker.hits < worker.hitsMax) {
        var range = creep.pos.getRangeTo(worker);
        if (range <= 1) {
            creep.heal(worker);
            healed = true;
        } else if (range <= 3) {
            creep.rangedHeal(worker);
            healed = true;
        }
    }
    if (!healed) {
        var alternate = findAlternateHealTarget(creep, worker);
        if (alternate) {
            var altRange = creep.pos.getRangeTo(alternate);
            if (altRange <= 1) {
                creep.heal(alternate);
                healed = true;
            } else if (altRange <= 3) {
                creep.rangedHeal(alternate);
                healed = true;
            }
        }
    }
    if (!healed && creep.hits < creep.hitsMax) {
        creep.heal(creep);
    }

    if (creep.memory.state === 'parked') {
        stateParked(creep);
    } else {
        stateTraveling(creep);
    }
}

module.exports = {
    run: run,
    deriveHealerParkPos: deriveHealerParkPos
};
