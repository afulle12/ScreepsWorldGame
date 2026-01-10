//orderSquad('SPAWN', 'TARGET');
//cancelSquadOrder('ROOM');
/*
 * roleSquad.js
 * PATCHED: Fixed "Snake Mode" triggering on walls
 * PATCHED: Added "Breach Mode" to target blocking walls/ramparts when no path exists
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

        // Assembly phase
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

        // --- COMBAT LOGIC ---
        // Pass the acting leader so we can check for breach targets
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

    handleCombat: function(creep, members, leader) {
        var healTarget = null;
        var lowestExpectedHealth = Infinity;

        // 1. Squad Healing Logic
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

        // 2. Attack Logic
        var target = null;

        // PRIORITY: BREACH TARGET (Walls/Ramparts marked by leader)
        if (leader && leader.memory.breachId) {
            var breachStruct = Game.getObjectById(leader.memory.breachId);
            if (breachStruct && creep.pos.inRangeTo(breachStruct, 3)) {
                target = breachStruct;
            }
        }

        // If no breach target, look for hostiles
        if (!target) {
            var hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
                filter: function(c) { return iff.isHostileCreep(c); }
            });
            target = creep.pos.findClosestByRange(hostiles);
        }

        // If no hostiles, look for other structures
        if (!target) {
            var structures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
                filter: function(s) { 
                    return s.structureType !== STRUCTURE_CONTROLLER && 
                           s.structureType !== STRUCTURE_POWER_BANK;
                }
            });
            target = creep.pos.findClosestByRange(structures);
        }

        // Execute Attack
        if (target) {
            var range = creep.pos.getRangeTo(target);
            if (range <= 3) creep.rangedAttack(target);
            if (range <= 1) {
                // If it's a structure, dismantle is often better if we have parts, otherwise attack
                // Assuming standard squad with ATTACK parts here
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
        // Clear breach target if it's destroyed or we moved away
        if (leader.memory.breachId) {
            var obj = Game.getObjectById(leader.memory.breachId);
            if (!obj) delete leader.memory.breachId;
        }

        var inSpawnRoom = leader.room.name === leader.memory.spawnRoom;
        var targetRoom = leader.memory.targetRoom;
        var inTargetRoom = leader.room.name === targetRoom;

        if (!allPresent && !inSpawnRoom) {
            leader.say('Broken');
            if (inTargetRoom) {
                var repairTarget = this.findBestAttackTarget(leader);
                if (repairTarget) leader.moveTo(repairTarget, { reusePath: 5 });
            } else {
                leader.moveTo(new RoomPosition(25, 25, targetRoom), { reusePath: 20 });
            }
            return;
        }

        for (var i = 0; i < 4; i++) {
            if (members[i] && members[i].fatigue > 0) {
                leader.say('Tired');
                return;
            }
        }

        var tryingToExit = this.isNearTargetExit(leader, targetRoom);

        if (inSpawnRoom || (tryingToExit && !inTargetRoom)) {
            leader.say(inSpawnRoom ? 'Train' : 'Exit');
            this.moveAsTrain(leader, members, targetRoom);
            return;
        }

        var allInSameRoom = this.checkAllInSameRoom(members);
        var inSafeZone = this.isInSafeZone(leader);
        var center = new RoomPosition(25, 25, leader.room.name);

        if (!allInSameRoom) {
            leader.say('Cross');
            if (leader.room.name !== targetRoom) {
                 this.moveAsTrain(leader, members, targetRoom);
            } 
            else if (leader.pos.getRangeTo(center) > 5) {
                leader.moveTo(center, { reusePath: 5 });
            }
            return;
        }

        if (!inSafeZone && !tryingToExit && !inTargetRoom) {
            leader.say('Enter');
            for (var i = 0; i < 4; i++) {
                if(members[i]) members[i].moveTo(center, { reusePath: 0 });
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
                        // If no spot to form, we force snake logic
                        // But pathfinding below will decide if it's Snake vs Breach
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
                var exit = leader.pos.findClosestByRange(exitDir);
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

        if (creep.room.name !== actingLeader.room.name) {
            creep.say('Catch');
            creep.moveTo(actingLeader, { reusePath: 5 });
            return;
        }

        if (actingLeader.memory.snakeMode) {
            creep.say('Snake');
            creep.moveTo(actingLeader, { reusePath: 0 });
            return;
        }

        var leaderInSafeZone = actingLeader.pos.x >= 3 && actingLeader.pos.x <= 46 && 
                               actingLeader.pos.y >= 3 && actingLeader.pos.y <= 46;
        var tryingToExit = this.isNearTargetExit(actingLeader, actingLeader.memory.targetRoom);
        var inTargetRoom = creep.room.name === creep.memory.targetRoom;

        if (!leaderInSafeZone && !inTargetRoom && !tryingToExit) return;
        if (tryingToExit && !inTargetRoom) return;

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

    moveAsTrain: function(leader, members, targetRoom) {
        var exitDir = Game.map.findExit(leader.room, targetRoom);
        if (exitDir === ERR_NO_PATH) return;
        var exit = leader.pos.findClosestByRange(exitDir);
        if (!exit) return;

        var sortedMembers = [];
        for(var i=0; i<4; i++) {
            if(members[i]) sortedMembers.push(members[i]);
        }
        sortedMembers.sort((a,b) => a.pos.getRangeTo(exit) - b.pos.getRangeTo(exit));
        
        var closest = sortedMembers[0];

        if (closest.id !== leader.id) {
            if (leader.pos.isNearTo(closest)) {
                leader.say('Swap');
                closest.say('Yield');
                
                leader.move(leader.pos.getDirectionTo(closest));
                closest.move(closest.pos.getDirectionTo(leader));
                return;
            }
        }

        leader.moveTo(exit, { reusePath: 0, ignoreCreeps: true });

        for (var i = 0; i < 4; i++) {
            var follower = members[i];
            if (follower && follower.id !== leader.id) {
                follower.moveTo(leader, { reusePath: 0, ignoreCreeps: true });
            }
        }
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

        // Stickiness: If snake mode is on, check if we can revert
        if (leader.memory.snakeMode) {
            if (!this.isAreaClearForQuad(leader, leader.pos)) {
                // Keep snaking
                leader.say('Snaking');
                leader.moveTo(targetPos, { reusePath: 0 });
                return;
            }
        }

        // 1. Try 2x2 Pathfinding
        var costs = this.getQuadCostMatrix(leader.room.name, stayInRoom);
        var result = PathFinder.search(leader.pos, { pos: targetPos, range: 1 }, {
            plainCost: 1,
            swampCost: 5,
            maxRooms: 1,
            maxOps: 4000, // Reduced maxOps for 2x2 since we failover quickly
            roomCallback: function(roomName) {
                if (roomName === leader.room.name) return costs;
                return false;
            }
        });

        // 2. If 2x2 succeeds, execute
        if (!result.incomplete && result.path.length > 0) {
            leader.memory.snakeMode = false;
            var nextPos = result.path[0];
            var direction = leader.pos.getDirectionTo(nextPos);
            
            if (this.canQuadMove(members, direction)) {
                for (var i = 0; i < 4; i++) {
                    if(members[i]) members[i].move(direction);
                }
            } else {
                this.tryAlternativeMove(leader, members, targetPos);
            }
            return;
        }

        // 3. If 2x2 Fails, decide between SNAKE (narrow path) vs BREACH (wall)
        // Run a standard 1x1 search to see if ANY path exists
        var result1x1 = PathFinder.search(leader.pos, { pos: targetPos, range: 1 }, {
            plainCost: 1,
            swampCost: 5,
            maxRooms: 1,
            maxOps: 4000
            // Default CostMatrix used here (walkable walls are blocked, roads/plains ok)
        });

        if (!result1x1.incomplete) {
            // A 1x1 path exists! We should SNAKE through it.
            leader.say('Snake');
            leader.memory.snakeMode = true;
            leader.moveTo(targetPos, { reusePath: 0 });
        } else {
            // A 1x1 path DOES NOT exist. We are completely blocked (Walls).
            // We need to BREACH.
            leader.say('Breach');
            leader.memory.snakeMode = false; // Stop snaking
            
            // Find the obstruction at the end of the partial path
            var lastStep = (result1x1.path.length > 0) ? result1x1.path[result1x1.path.length-1] : leader.pos;
            
            // Scan for walls/ramparts near the blockage point
            var blockage = lastStep.findInRange(FIND_STRUCTURES, 1, {
                filter: function(s) {
                    return s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART;
                }
            });

            if (blockage.length > 0) {
                // Pick the one closest to the TARGET (to breach in the right direction)
                var target = blockage.sort((a,b) => a.pos.getRangeTo(targetPos) - b.pos.getRangeTo(targetPos))[0];
                leader.memory.breachId = target.id;
                
                // Move towards it to get in range
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
                if(members[i]) members[i].move(bestDir);
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

        // 1. Mark basic terrain
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

        // 2. Mark structures
        var structures = room.find(FIND_STRUCTURES);
        for (var i = 0; i < structures.length; i++) {
            var s = structures[i];
            if (s.structureType !== STRUCTURE_ROAD && 
                s.structureType !== STRUCTURE_CONTAINER && 
                (s.structureType !== STRUCTURE_RAMPART || !s.my)) {
                baseCosts.set(s.pos.x, s.pos.y, 255);
            }
        }

        // 3. Dilation
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
                    var max = Math.max(baseCosts.get(x,y), right, bottom, bottomRight);
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