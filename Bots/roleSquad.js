//orderSquad('SPAWN', 'TARGET');
//cancelSquadOrder('ROOM');
/*
 * roleSquad.js
 * PATCHED: Fixed "Snake Mode" triggering on walls
 * PATCHED: Added "Breach Mode" to target blocking walls/ramparts when no path exists
 * PATCHED: Fixed followers trying to form up where buildings block formation
 * PATCHED: Fixed train mode — followers now chain-follow instead of all pathing to leader
 * PATCHED: Fixed room-boundary oscillation — followers go FORWARD not back to leader
 * PATCHED: Added moveAsTrain fallback + findClosestByPath for stuck corners
 */

var iff = require('iff');

var roleSquad = {
    formationVectors: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 }
    ],

    run: function(creep) {
        if (!creep.memory.squadId) return;

        if (!creep.memory.spawnRoom) creep.memory.spawnRoom = creep.room.name;
        if (!creep.memory.targetRoom) return;

        var squadMembers = this.getSquadMembers(creep);
        var allPresent = this.checkAllPresent(squadMembers);
        var inSpawnRoom = creep.room.name === creep.memory.spawnRoom;

        if (inSpawnRoom && !allPresent) {
            if (Game.time % 5 === 0) creep.say('Wait');
            return;
        }

        var actingLeader = this.getActingLeader(squadMembers);
        if (!actingLeader) return;

        if (creep.id === actingLeader.id && Game.time % 10 === 0) {
            console.log("Squad " + creep.memory.squadId + " Leader: " + actingLeader.name);
        }

        if (!this.checkAllSpawned(squadMembers)) {
            creep.say('Spawn');
            return;
        }

        this.handleCombat(creep, squadMembers, actingLeader);

        if (creep.id === actingLeader.id) {
            this.handleLeaderLogic(creep, squadMembers, allPresent);
        } else {
            this.handleFollowerLogic(creep, squadMembers, actingLeader, allPresent);
        }
    },

    getActingLeader: function(members) {
        for (var i = 0; i < 4; i++) {
            if (members[i]) return members[i];
        }
        return null;
    },

    checkAllPresent: function(members) {
        for (var i = 0; i < 4; i++) {
            if (!members[i]) return false;
        }
        return true;
    },

    checkAllSpawned: function(members) {
        for (var i = 0; i < 4; i++) {
            if (members[i] && members[i].spawning) return false;
        }
        return true;
    },

    checkAllInSameRoom: function(members) {
        var roomName = null;
        for (var i = 0; i < 4; i++) {
            if (members[i]) {
                if (!roomName) roomName = members[i].room.name;
                if (members[i].room.name !== roomName) return false;
            }
        }
        return true;
    },

    getSquadMembers: function(creep) {
        var members = [null, null, null, null];
        for (var name in Game.creeps) {
            var c = Game.creeps[name];
            if (c.memory.squadId === creep.memory.squadId && c.memory.quadPos !== undefined) {
                members[c.memory.quadPos] = c;
            }
        }
        return members;
    },

    getCreepAhead: function(creep, members, leader) {
        var chain = [];
        for (var i = 0; i < 4; i++) {
            if (members[i]) chain.push(members[i]);
        }
        for (var i = 0; i < chain.length; i++) {
            if (chain[i].id === creep.id) {
                return (i > 0) ? chain[i - 1] : leader;
            }
        }
        return leader;
    },

    handleCombat: function(creep, members, leader) {
        var healTarget = null;
        var lowestExpectedHealth = Infinity;

        for (var i = 0; i < 4; i++) {
            var member = members[i];
            if (member && creep.pos.getRangeTo(member) <= 1) {
                var memberDamage = this.getTowerDamageAt(member.pos, member.room.name);
                var expectedHealth = member.hits - memberDamage;

                if (expectedHealth < lowestExpectedHealth) {
                    lowestExpectedHealth = expectedHealth;
                    healTarget = member;
                }
            }
        }

        if (healTarget && healTarget.hits < healTarget.hitsMax) {
            creep.heal(healTarget);
        } else if (creep.hits < creep.hitsMax) {
            creep.heal(creep);
        }

        var target = null;

        if (leader && leader.memory.breachId) {
            var breachStruct = Game.getObjectById(leader.memory.breachId);
            if (breachStruct && creep.pos.inRangeTo(breachStruct, 3)) {
                target = breachStruct;
            }
        }

        if (!target) {
            var hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
                filter: function(c) { return iff.isHostileCreep(c); }
            });
            target = creep.pos.findClosestByRange(hostiles);
        }

        if (!target) {
            var structures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
                filter: function(s) {
                    return s.structureType !== STRUCTURE_CONTROLLER &&
                           s.structureType !== STRUCTURE_POWER_BANK;
                }
            });
            target = creep.pos.findClosestByRange(structures);
        }

        if (target) {
            var range = creep.pos.getRangeTo(target);
            if (range <= 3) creep.rangedAttack(target);
            if (range <= 1) {
                creep.attack(target);
            }
        }
    },

    getTowerDamageAt: function(pos, roomName) {
        var room = Game.rooms[roomName];
        if (!room) return 0;
        var towers = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
        });
        var totalDamage = 0;
        for (var i = 0; i < towers.length; i++) {
            var tower = towers[i];
            var range = tower.pos.getRangeTo(pos);
            var damage = 600;
            if (range > 5) damage = 600 - 300 * ((range - 5) / 45);
            totalDamage += damage;
        }
        return totalDamage;
    },

    isInSafeZone: function(leader) {
        var pos = leader.pos;
        return pos.x >= 3 && pos.x <= 46 && pos.y >= 3 && pos.y <= 46;
    },

    isNearTargetExit: function(creep, targetRoom) {
        var exitDir = Game.map.findExit(creep.room, targetRoom);
        if (exitDir === ERR_NO_PATH) return false;

        var pos = creep.pos;
        if (exitDir === TOP && pos.y <= 3) return true;
        if (exitDir === BOTTOM && pos.y >= 46) return true;
        if (exitDir === LEFT && pos.x <= 3) return true;
        if (exitDir === RIGHT && pos.x >= 46) return true;
        return false;
    },

    findBestAttackTarget: function(leader) {
        var hostiles = leader.room.find(FIND_HOSTILE_CREEPS, {
            filter: function(c) { return iff.isHostileCreep(c); }
        });
        if (hostiles.length > 0) {
            return leader.pos.findClosestByRange(hostiles);
        }

        var structures = leader.room.find(FIND_HOSTILE_STRUCTURES, {
            filter: function(s) {
                return s.structureType !== STRUCTURE_CONTROLLER &&
                       s.structureType !== STRUCTURE_POWER_BANK;
            }
        });
        if (structures.length > 0) {
            return leader.pos.findClosestByRange(structures);
        }
        return null;
    },

    handleLeaderLogic: function(leader, members, allPresent) {
        // Clear breach target if destroyed
        if (leader.memory.breachId) {
            var obj = Game.getObjectById(leader.memory.breachId);
            if (!obj) delete leader.memory.breachId;
        }

        var inSpawnRoom = leader.room.name === leader.memory.spawnRoom;
        var targetRoom = leader.memory.targetRoom;
        var inTargetRoom = leader.room.name === targetRoom;
        var tryingToExit = this.isNearTargetExit(leader, targetRoom);
        var allInSameRoom = this.checkAllInSameRoom(members);

        // FIX: Predict trainMode early so followers that execute before us
        // this tick see the correct flag. moveAsTrain may override to false.
        var needTrain = inSpawnRoom ||
                        (tryingToExit && !inTargetRoom) ||
                        (!allInSameRoom && !inTargetRoom);
        leader.memory.trainMode = needTrain;

        // Broken squad — solo push
        if (!allPresent && !inSpawnRoom) {
            leader.say('Broken');
            leader.memory.trainMode = false;
            if (inTargetRoom) {
                var target = this.findBestAttackTarget(leader);
                if (target) leader.moveTo(target, { reusePath: 5 });
            } else {
                leader.moveTo(new RoomPosition(25, 25, targetRoom), { reusePath: 20 });
            }
            return;
        }

        // === PHASE 1: Independent movement (train mode) ===
        // Runs BEFORE fatigue check — leader moves independently of followers
        if (needTrain) {
            if (this.moveAsTrain(leader, members, targetRoom)) {
                if (inSpawnRoom) leader.say('Train');
                else if (!allInSameRoom) leader.say('Cross');
                else leader.say('Exit');
                return;
            }
            // FIX: moveAsTrain failed (no path to exit from here).
            // trainMode already set to false inside moveAsTrain.
            // Fall through to normal movement instead of getting stuck.
            leader.say('Detour');
        }

        // === PHASE 1b: Leader in target room, waiting for followers ===
        if (!allInSameRoom && inTargetRoom) {
            leader.say('Wait');
            // Move away from border to clear exit tiles for followers
            if (!this.isInSafeZone(leader)) {
                leader.moveTo(new RoomPosition(25, 25, leader.room.name), {
                    reusePath: 5
                });
            }
            return;
        }

        // === PHASE 2: Synchronized quad movement (all in same room) ===
        // Fatigue check only gates quad movement, not train movement
        for (var i = 0; i < 4; i++) {
            if (members[i] && members[i].fatigue > 0) {
                leader.say('Tired');
                return;
            }
        }

        var inSafeZone = this.isInSafeZone(leader);
        var center = new RoomPosition(25, 25, leader.room.name);

        if (!inSafeZone && !tryingToExit && !inTargetRoom) {
            leader.say('Enter');
            for (var i = 0; i < 4; i++) {
                if (members[i]) members[i].moveTo(center, { reusePath: 0 });
            }
            return;
        }

        if (!leader.memory.snakeMode) {
            if (!this.checkFormation(members)) {
                if (this.isAreaClearForQuad(leader, leader.pos)) {
                    leader.say('Form');
                    this.reformSquad(leader, members);
                } else {
                    leader.say('Nudge');
                    var validSpot = this.findValidFormationSpot(leader);
                    if (validSpot) {
                        leader.moveTo(validSpot, { reusePath: 0 });
                    } else {
                        leader.say('ForceSnake');
                        leader.memory.snakeMode = true;
                    }
                }
                return;
            }
        }

        if (inTargetRoom) {
            leader.say('Attack');
            var targetObj = this.findBestAttackTarget(leader);
            if (targetObj) {
                this.moveQuadWithPathfinding(leader, members, targetObj.pos, true);
            } else {
                leader.say('Clear');
                leader.memory.snakeMode = false;
            }
        } else {
            leader.say('Move');
            var exitDir = Game.map.findExit(leader.room, targetRoom);
            if (exitDir !== ERR_NO_PATH) {
                // FIX: findClosestByPath avoids unreachable exit tiles in corners
                var exit = leader.pos.findClosestByPath(exitDir);
                if (!exit) exit = leader.pos.findClosestByRange(exitDir); // fallback
                if (exit) {
                    this.moveQuadWithPathfinding(leader, members, exit, false);
                }
            }
        }
    },

    handleFollowerLogic: function(creep, members, actingLeader, allPresent) {
        if (!actingLeader) return;

        if (!allPresent) {
            creep.say('Follow');
            creep.moveTo(actingLeader, { reusePath: 1 });
            return;
        }

        var isDifferentRoom = creep.room.name !== actingLeader.room.name;
        var isTrainMode = actingLeader.memory.trainMode;
        var isSnakeMode = actingLeader.memory.snakeMode;

        // === CROSS-ROOM HANDLING ===
        // FIX: This is the key anti-oscillation fix. When the squad is split
        // across rooms and in train mode, followers move TOWARD THE TARGET
        // (same direction as leader) instead of back toward the leader.
        // This prevents the "passing each other at the border" loop.
        if (isDifferentRoom) {
            if (isTrainMode) {
                // Both leader and follower heading to target — keep going forward
                creep.say('Fwd');
                creep.moveTo(new RoomPosition(25, 25, creep.memory.targetRoom), {
                    reusePath: 0,
                    ignoreCreeps: true
                });
            } else {
                // Not in train mode — regroup toward leader via chain-follow
                creep.say('Catch');
                var ahead = this.getCreepAhead(creep, members, actingLeader);
                creep.moveTo(ahead, { reusePath: 0, ignoreCreeps: true });
            }
            return;
        }

        // === SAME ROOM: Train or Snake — chain-follow ===
        if (isTrainMode || isSnakeMode) {
            creep.say(isTrainMode ? 'Train' : 'Snake');
            var ahead = this.getCreepAhead(creep, members, actingLeader);
            creep.moveTo(ahead, { reusePath: 0, ignoreCreeps: true });
            return;
        }

        // === SAME ROOM: Formation mode ===
        var leaderInSafeZone = actingLeader.pos.x >= 3 && actingLeader.pos.x <= 46 &&
                               actingLeader.pos.y >= 3 && actingLeader.pos.y <= 46;
        var inTargetRoom = creep.room.name === creep.memory.targetRoom;

        if (!leaderInSafeZone && !inTargetRoom) {
            creep.say('Trail');
            creep.moveTo(actingLeader, { reusePath: 0 });
            return;
        }

        if (!this.isAreaClearForQuad(actingLeader, actingLeader.pos)) {
            creep.say('Blocked');
            creep.moveTo(actingLeader, { reusePath: 0 });
            return;
        }

        var vector = this.formationVectors[creep.memory.quadPos];
        var targetX = actingLeader.pos.x + vector.x;
        var targetY = actingLeader.pos.y + vector.y;

        if (creep.pos.x !== targetX || creep.pos.y !== targetY) {
            creep.say('Form');
            creep.moveTo(new RoomPosition(targetX, targetY, actingLeader.room.name), {
                reusePath: 0
            });
        }
    },

    // FIX: Now returns true/false so handleLeaderLogic can fall through on failure
    moveAsTrain: function(leader, members, targetRoom) {
        leader.memory.snakeMode = false;

        var exitDir = Game.map.findExit(leader.room, targetRoom);
        if (exitDir === ERR_NO_PATH) {
            leader.memory.trainMode = false;
            return false;
        }

        // If on the correct exit edge, explicitly step across.
        // moveTo can stall at range 0 on exit tiles — this forces the crossing.
        var pos = leader.pos;
        if ((exitDir === FIND_EXIT_TOP && pos.y === 0) ||
            (exitDir === FIND_EXIT_BOTTOM && pos.y === 49) ||
            (exitDir === FIND_EXIT_LEFT && pos.x === 0) ||
            (exitDir === FIND_EXIT_RIGHT && pos.x === 49)) {
            leader.memory.trainMode = true;
            leader.move(exitDir);
            return true;
        }

        // Try cross-room moveTo (handles exit selection + room crossing)
        var result = leader.moveTo(new RoomPosition(25, 25, targetRoom), {
            reusePath: 0,
            ignoreCreeps: true
        });

        if (result !== ERR_NO_PATH) {
            leader.memory.trainMode = true;
            return true;
        }

        // FIX: Cross-room moveTo failed (stuck in corner, op limit, etc.)
        // Try same-room path to nearest REACHABLE exit tile
        var exitTile = leader.pos.findClosestByPath(exitDir);
        if (exitTile) {
            leader.memory.trainMode = true;
            leader.moveTo(exitTile, { reusePath: 0, ignoreCreeps: true });
            return true;
        }

        // Completely stuck — no reachable exit from this position
        leader.memory.trainMode = false;
        return false;
    },

    checkFormation: function(members) {
        var tl = members[0];
        var tr = members[1];
        var bl = members[2];
        var br = members[3];
        if (!tl || !tr || !bl || !br) return false;
        if (tr.pos.x !== tl.pos.x + 1 || tr.pos.y !== tl.pos.y) return false;
        if (bl.pos.x !== tl.pos.x || bl.pos.y !== tl.pos.y + 1) return false;
        if (br.pos.x !== tl.pos.x + 1 || br.pos.y !== tl.pos.y + 1) return false;
        if (tr.pos.roomName !== tl.pos.roomName) return false;
        return true;
    },

    reformSquad: function(leader, members) {
        for (var i = 0; i < 4; i++) {
            var follower = members[i];
            if (!follower || follower.id === leader.id) continue;

            var vector = this.formationVectors[i];
            var targetX = leader.pos.x + vector.x;
            var targetY = leader.pos.y + vector.y;
            if (follower.pos.x !== targetX || follower.pos.y !== targetY) {
                follower.moveTo(new RoomPosition(targetX, targetY, leader.room.name), {
                    reusePath: 0
                });
            }
        }
    },

    isAreaClearForQuad: function(leader, anchorPos) {
        if (!anchorPos) anchorPos = leader.pos;
        var terrain = Game.map.getRoomTerrain(leader.room.name);
        for (var i = 0; i < 4; i++) {
            var vec = this.formationVectors[i];
            var x = anchorPos.x + vec.x;
            var y = anchorPos.y + vec.y;
            if (x < 1 || x > 48 || y < 1 || y > 48) return false;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
            var pos = new RoomPosition(x, y, leader.room.name);
            var structures = pos.lookFor(LOOK_STRUCTURES);
            for (var s = 0; s < structures.length; s++) {
                var str = structures[s];
                if (str.structureType !== STRUCTURE_ROAD &&
                    str.structureType !== STRUCTURE_CONTAINER &&
                    str.structureType !== STRUCTURE_RAMPART) {
                    return false;
                }
            }
        }
        return true;
    },

    findValidFormationSpot: function(leader) {
        var startPos = leader.pos;
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                var x = startPos.x + dx;
                var y = startPos.y + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                var testPos = new RoomPosition(x, y, leader.room.name);
                if (this.isAreaClearForQuad(leader, testPos)) {
                    return testPos;
                }
            }
        }
        return null;
    },

    moveQuadWithPathfinding: function(leader, members, targetPos, stayInRoom) {
        if (leader.pos.getRangeTo(targetPos) <= 1) {
            leader.say('AtGoal');
            return;
        }

        if (leader.memory.snakeMode) {
            if (!this.isAreaClearForQuad(leader, leader.pos)) {
                leader.say('Snaking');
                leader.moveTo(targetPos, { reusePath: 0 });
                return;
            }
        }

        var costs = this.getQuadCostMatrix(leader.room.name, stayInRoom);
        var result = PathFinder.search(leader.pos, { pos: targetPos, range: 1 }, {
            plainCost: 1,
            swampCost: 5,
            maxRooms: 1,
            maxOps: 4000,
            roomCallback: function(roomName) {
                if (roomName === leader.room.name) return costs;
                return false;
            }
        });

        if (!result.incomplete && result.path.length > 0) {
            leader.memory.snakeMode = false;
            var nextPos = result.path[0];
            var direction = leader.pos.getDirectionTo(nextPos);

            if (this.canQuadMove(members, direction)) {
                for (var i = 0; i < 4; i++) {
                    if (members[i]) members[i].move(direction);
                }
            } else {
                this.tryAlternativeMove(leader, members, targetPos);
            }
            return;
        }

        var result1x1 = PathFinder.search(leader.pos, { pos: targetPos, range: 1 }, {
            plainCost: 1,
            swampCost: 5,
            maxRooms: 1,
            maxOps: 4000
        });

        if (!result1x1.incomplete) {
            leader.say('Snake');
            leader.memory.snakeMode = true;
            leader.moveTo(targetPos, { reusePath: 0 });
        } else {
            leader.say('Breach');
            leader.memory.snakeMode = false;

            var lastStep = (result1x1.path.length > 0) ? result1x1.path[result1x1.path.length - 1] : leader.pos;

            var blockage = lastStep.findInRange(FIND_STRUCTURES, 1, {
                filter: function(s) {
                    return s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART;
                }
            });

            if (blockage.length > 0) {
                var target = blockage.sort(function(a, b) {
                    return a.pos.getRangeTo(targetPos) - b.pos.getRangeTo(targetPos);
                })[0];
                leader.memory.breachId = target.id;

                leader.moveTo(target, { reusePath: 0 });
            }
        }
    },

    tryAlternativeMove: function(leader, members, targetPos) {
        var directions = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
        var bestDir = null;
        var bestDist = Infinity;

        for (var d = 0; d < directions.length; d++) {
            var dir = directions[d];
            if (this.canQuadMove(members, dir)) {
                var newPos = this.getPosInDirection(leader.pos, dir);
                if (newPos) {
                    var dist = newPos.getRangeTo(targetPos);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestDir = dir;
                    }
                }
            }
        }

        if (bestDir !== null) {
            for (var i = 0; i < 4; i++) {
                if (members[i]) members[i].move(bestDir);
            }
        } else {
            leader.say('Stuck');
        }
    },

    getQuadCostMatrix: function(roomName, forbidExits) {
        var room = Game.rooms[roomName];
        if (!room) return new PathFinder.CostMatrix();

        var baseCosts = new PathFinder.CostMatrix();
        var terrain = room.getTerrain();

        for (var x = 0; x < 50; x++) {
            for (var y = 0; y < 50; y++) {
                var tile = terrain.get(x, y);
                if (tile === TERRAIN_MASK_WALL) {
                    baseCosts.set(x, y, 255);
                } else if (tile === TERRAIN_MASK_SWAMP) {
                    baseCosts.set(x, y, 5);
                } else {
                    baseCosts.set(x, y, 1);
                }
            }
        }

        var structures = room.find(FIND_STRUCTURES);
        for (var i = 0; i < structures.length; i++) {
            var s = structures[i];
            if (s.structureType !== STRUCTURE_ROAD &&
                s.structureType !== STRUCTURE_CONTAINER &&
                (s.structureType !== STRUCTURE_RAMPART || !s.my)) {
                baseCosts.set(s.pos.x, s.pos.y, 255);
            }
        }

        var dilatedCosts = new PathFinder.CostMatrix();
        for (var x = 0; x < 50; x++) {
            for (var y = 0; y < 50; y++) {
                if (baseCosts.get(x, y) === 255) {
                    dilatedCosts.set(x, y, 255);
                    continue;
                }
                if (x >= 49 || y >= 49) {
                    dilatedCosts.set(x, y, 255);
                    continue;
                }
                var right = baseCosts.get(x + 1, y);
                var bottom = baseCosts.get(x, y + 1);
                var bottomRight = baseCosts.get(x + 1, y + 1);

                if (right === 255 || bottom === 255 || bottomRight === 255) {
                    dilatedCosts.set(x, y, 255);
                } else {
                    var max = Math.max(baseCosts.get(x, y), right, bottom, bottomRight);
                    dilatedCosts.set(x, y, max);
                }
            }
        }

        if (forbidExits) {
            for (var i = 0; i < 50; i++) {
                dilatedCosts.set(i, 0, 255);
                dilatedCosts.set(i, 49, 255);
                dilatedCosts.set(0, i, 255);
                dilatedCosts.set(49, i, 255);
            }
        }

        return dilatedCosts;
    },

    canQuadMove: function(members, direction) {
        for (var i = 0; i < 4; i++) {
            var creep = members[i];
            if (!creep) continue;

            var targetPos = this.getPosInDirection(creep.pos, direction);
            if (!targetPos) return false;
            var terrain = Game.map.getRoomTerrain(creep.room.name);
            if (terrain.get(targetPos.x, targetPos.y) === TERRAIN_MASK_WALL) return false;
            var structures = targetPos.lookFor(LOOK_STRUCTURES);
            for (var s = 0; s < structures.length; s++) {
                var str = structures[s];
                if (str.structureType !== STRUCTURE_ROAD &&
                    str.structureType !== STRUCTURE_CONTAINER &&
                    (str.structureType !== STRUCTURE_RAMPART || !str.my)) return false;
            }
            var creeps = targetPos.lookFor(LOOK_CREEPS);
            for (var c = 0; c < creeps.length; c++) {
                var other = creeps[c];
                var isMember = false;
                for (var m = 0; m < 4; m++) {
                    if (members[m] && members[m].id === other.id) isMember = true;
                }
                if (!isMember) return false;
            }
        }
        return true;
    },

    getPosInDirection: function(pos, direction) {
        var x = pos.x;
        var y = pos.y;
        var roomName = pos.roomName;
        if (direction === TOP) y--;
        if (direction === TOP_RIGHT) { x++; y--; }
        if (direction === RIGHT) x++;
        if (direction === BOTTOM_RIGHT) { x++; y++; }
        if (direction === BOTTOM) y++;
        if (direction === BOTTOM_LEFT) { x--; y++; }
        if (direction === LEFT) x--;
        if (direction === TOP_LEFT) { x--; y--; }
        if (x < 0 || x > 49 || y < 0 || y > 49) return null;
        return new RoomPosition(x, y, roomName);
    }
};

module.exports = roleSquad;
