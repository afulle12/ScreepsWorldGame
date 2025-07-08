// =================================================================================================
// |                                                                                               |
// |                                     HOW TO USE THIS SCOUT                                     |
// |                                                                                               |
// | 1. To spawn a scout and send it to a specific room to start exploring:                        |
// |    require('roleScout').orderExplore('W1N8'); // (Target Room Name)                           |
// |                                                                                               |
// | 2. To order a scout for a specific mission (e.g., check if a path is clear):                  |
// |    require('roleScout').orderCheckRoom('E2N47', 'E5N47'); // (From, To)                        |
// |                                                                                               |
// | 3. To spawn a "fire-and-forget" autonomous scout that explores on its own:                    |
// |    require('roleScout').orderAutonomousScout();                                               |
// |                                                                                               |
// =================================================================================================

// =================================================================
// CONFIGURATION
// =================================================================
const DETAILED_LOGGING = true; // Set to false to disable verbose scout console logs.
const FRIENDLY_PLAYERS = ['tarenty', 'Player1', 'AnotherFriend']; // Add friendly usernames here
// =================================================================

/**
 * Helper function for conditional logging.
 * @param {string} message - The message to log if DETAILED_LOGGING is true.
 */
const log = (message) => {
    if (DETAILED_LOGGING) {
        console.log(message);
    }
};

const roleScout = {
    /**
     * Spawns a scout to explore a destination, automatically finding the best spawn room.
     * Example: require('roleScout').orderExplore('W1N8')
     * @param {string} destinationRoomName - The name of the room to send the scout to.
     */
    orderExplore: function(destinationRoomName) {
        // ... (this function is unchanged)
        if (!destinationRoomName) {
            return 'Error: destinationRoomName is required.';
        }
        let bestSpawnRoom = null;
        let minDistance = Infinity;
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room.controller && room.controller.my) {
                const spawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
                if (spawns.length > 0) {
                    const distance = Game.map.getRoomLinearDistance(roomName, destinationRoomName);
                    if (distance < minDistance) {
                        minDistance = distance;
                        bestSpawnRoom = room;
                    }
                }
            }
        }
        if (!bestSpawnRoom) {
            const message = `❌ Error: No available spawn found in any of your rooms to start exploration mission to ${destinationRoomName}.`;
            console.log(message);
            return message;
        }
        const spawn = bestSpawnRoom.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
        const newName = `Scout_${destinationRoomName}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = {
            role: 'scout',
            targetRoom: destinationRoomName
        };
        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            const message = `✅ Spawning scout '${newName}' from ${bestSpawnRoom.name} to explore ${destinationRoomName}.`;
            console.log(message);
            return message;
        } else {
            const errorMessage = `❌ Failed to spawn scout from ${bestSpawnRoom.name}. Error code: ${result}`;
            console.log(errorMessage);
            return errorMessage;
        }
    },

    /**
     * Spawns a scout with a specific mission to check if a room is visitable.
     * Example: require('roleScout').orderCheckRoom('E2N46', 'W2N2')
     * @param {string} spawnRoomName - The name of the room with a spawn to create the scout.
     * @param {string} destinationRoomName - The name of the room to send the scout to.
     */
    orderCheckRoom: function(spawnRoomName, destinationRoomName) {
        // ... (this function is unchanged)
        if (!spawnRoomName || !destinationRoomName) {
            return 'Error: Both spawnRoomName and destinationRoomName are required.';
        }
        const spawnRoom = Game.rooms[spawnRoomName];
        if (!spawnRoom) {
            return `Error: No vision in spawn room ${spawnRoomName}.`;
        }
        const spawns = spawnRoom.find(FIND_MY_SPAWNS, {
            filter: s => !s.spawning
        });
        if (!spawns.length) {
            return `Error: No available spawn in room ${spawnRoomName}.`;
        }
        const spawn = spawns[0];
        const newName = `VisCheck_${destinationRoomName}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = {
            role: 'scout',
            task: 'checkRoom',
            destinationRoom: destinationRoomName,
            spawnRoom: spawnRoomName
        };
        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            const message = `✅ Spawning scout '${newName}' from ${spawnRoomName} to check room ${destinationRoomName}.`;
            console.log(message);
            return message;
        } else {
            const errorMessage = `❌ Failed to spawn scout. Error code: ${result}`;
            console.log(errorMessage);
            return errorMessage;
        }
    },

    /**
     * <<< NEW: Spawns a scout that explores autonomously without a specific destination. >>>
     * Example: require('roleScout').orderAutonomousScout()
     */
    orderAutonomousScout: function() {
        let spawn = null;
        // Find any available spawn in any of your rooms
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room.controller && room.controller.my) {
                const availableSpawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
                if (availableSpawns.length > 0) {
                    spawn = availableSpawns[0];
                    break; // Found one, no need to keep looking
                }
            }
        }

        if (!spawn) {
            const message = `❌ Error: No available spawn found in any of your rooms to launch an autonomous scout.`;
            console.log(message);
            return message;
        }

        const newName = `AutoScout_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = {
            role: 'scout',
            task: 'autonomous', // A specific task name for clarity
            homeRoom: spawn.room.name
            // No targetRoom is set; the scout will find its own on the first tick.
        };

        const result = spawn.spawnCreep(body, newName, { memory: memory });

        if (result === OK) {
            const message = `✅ Spawning autonomous scout '${newName}' from ${spawn.room.name}.`;
            console.log(message);
            return message;
        } else {
            const errorMessage = `❌ Failed to spawn autonomous scout from ${spawn.room.name}. Error code: ${result}`;
            console.log(errorMessage);
            return errorMessage;
        }
    },

    // ... (The rest of the file is unchanged) ...
    handleDeadCreeps: function() {
        for (const name in Memory.creeps) {
            if (!Game.creeps[name]) {
                const memory = Memory.creeps[name];
                if (memory.role === 'scout' && memory.task === 'checkRoom' && !memory.notificationSent) {
                    const deathRoom = memory.lastAttackedIn || memory.lastRoom || 'an unknown room';
                    const cause = memory.causeOfDeath || 'unknown reasons';
                    const message = `❌ Mission Failed: Scout [${name}] died in room ${deathRoom} (Cause: ${cause}) before reaching its destination of ${memory.destinationRoom}.`;
                    Game.notify(message, 0);
                    console.log(message);
                }
                delete Memory.creeps[name];
            }
        }
    },
    run: function(creep) {
        if (creep.spawning) return;
        if (creep.memory.fleeing) {
            if (creep.room.name === creep.memory.previousRoom || !creep.memory.previousRoom) {
                log(`✅ Scout ${creep.name} successfully fled. Looking for new target.`);
                delete creep.memory.fleeing;
                this.assignTargetRoom(creep);
            } else {
                creep.say('😱 RUN!');
                creep.moveTo(new RoomPosition(25, 25, creep.memory.previousRoom));
                return;
            }
        }
        if (creep.memory.task === 'checkRoom') {
            this.runCheckRoomTask(creep);
            return;
        }
        if (this.checkForDanger(creep)) {
            return;
        }
        if(!Memory.exploration) Memory.exploration = {};
        if(!Memory.exploration.rooms) Memory.exploration.rooms = {};
        if(!Memory.ownedRooms) Memory.ownedRooms = [];
        if(!Memory.dangerousRooms) Memory.dangerousRooms = {};
        if(!creep.memory.targetRoom) {
            this.assignTargetRoom(creep);
        }
        if(creep.memory.lastRoom !== creep.room.name) {
            creep.memory.previousRoom = creep.memory.lastRoom;
            creep.memory.roomScanned = false;
            creep.memory.lastRoom = creep.room.name;
            delete creep.memory.route;
            if(!creep.memory.visitedRooms) creep.memory.visitedRooms = {};
            creep.memory.visitedRooms[creep.room.name] = Game.time;
            log(`🔍 Scout ${creep.name} entered room ${creep.room.name} (target: ${creep.memory.targetRoom})`);
        }
        if(creep.room.name !== creep.memory.targetRoom) {
            this.travelToRoom(creep, creep.memory.targetRoom);
        } else {
            log(`🎯 Scout ${creep.name} arrived at target room ${creep.room.name}`);
            this.gatherIntelligence(creep);
            log(`⏱️ Scout ${creep.name} finished scanning ${creep.room.name}, looking for new target`);
            this.assignTargetRoom(creep);
        }
    },
    runCheckRoomTask: function(creep) {
        const destination = creep.memory.destinationRoom;
        if (creep.room.name === destination) {
            if (!creep.memory.notificationSent) {
                const message = `✅ Scout [${creep.name}] has successfully reached the destination room: ${destination}. The room is visitable.`;
                Game.notify(message, 0);
                console.log(message);
                creep.memory.notificationSent = true;
                creep.say('✅ Done!');
            }
            this.idle(creep);
        } else {
            const travelResult = this.travelToRoom(creep, destination);
            if (travelResult === ERR_NO_PATH) {
                if (!creep.memory.notificationSent) {
                    const message = `❌ Mission Failed: Scout [${creep.name}] could not find a safe path to ${destination}.`;
                    Game.notify(message, 0);
                    console.log(message);
                    creep.memory.notificationSent = true;
                }
                creep.say('🚫 Path');
                creep.suicide();
            }
        }
    },
    idle: function(creep) {
        const idlePosition = new RoomPosition(48, 48, creep.room.name);
        if (!creep.pos.isEqualTo(idlePosition)) {
            creep.moveTo(idlePosition);
        }
    },
    checkForDanger: function(creep) {
        const room = creep.room;
        if (room.controller && room.controller.owner && FRIENDLY_PLAYERS.includes(room.controller.owner.username)) {
            log(`Scout ${creep.name} in friendly room ${creep.room.name} owned by ${room.controller.owner.username}. Not fleeing.`);
            return false;
        }
        const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
        if (towers.length > 0) {
            this.markRoomAsDangerous(creep.room.name, 'hostile_towers', true);
            creep.memory.fleeing = true;
            delete creep.memory.targetRoom;
            log(`🏰 HOSTILE TOWERS DETECTED! Scout ${creep.name} is fleeing from ${creep.room.name}!`);
            return true;
        }
        if (creep.hits < creep.hitsMax && (!creep.memory.lastHits || creep.memory.lastHits > creep.hits)) {
            const damageTaken = (creep.memory.lastHits || creep.hitsMax) - creep.hits;
            console.log(`🚨 SCOUT UNDER ATTACK! ${creep.name} in room ${creep.room.name} - Health: ${creep.hits}/${creep.hitsMax} (Damage: ${damageTaken})`);
            creep.memory.lastAttackedIn = creep.room.name;
            this.markRoomAsDangerous(creep.room.name, 'hostile_creeps', false);
            creep.memory.fleeing = true;
            delete creep.memory.targetRoom;
            log(`⚔️ HOSTILES DETECTED! Scout ${creep.name} is fleeing from ${creep.room.name}!`);
            return true;
        }
        creep.memory.lastHits = creep.hits;
        return false;
    },
    markRoomAsDangerous: function(roomName, reason, permanent) {
        if(!Memory.dangerousRooms) Memory.dangerousRooms = {};
        const cooldownTime = permanent ? 999999999 : 50000;
        Memory.dangerousRooms[roomName] = { markedAt: Game.time, reason: reason, cooldownUntil: Game.time + cooldownTime, permanent: permanent };
        if(permanent) {
            console.log(`🚫 PERMANENTLY AVOIDING room ${roomName} due to ${reason}`);
        } else {
            console.log(`⏰ Avoiding room ${roomName} for ${cooldownTime} ticks due to ${reason}`);
        }
    },
    isRoomDangerous: function(roomName) {
        if(!Memory.dangerousRooms || !Memory.dangerousRooms[roomName]) return false;
        const dangerData = Memory.dangerousRooms[roomName];
        if(dangerData.permanent) return true;
        if(Game.time > dangerData.cooldownUntil) {
            delete Memory.dangerousRooms[roomName];
            console.log(`✅ Room ${roomName} is no longer marked as dangerous.`);
            return false;
        }
        return true;
    },
    clearDangerousRoom: function(roomName) {
        if(Memory.dangerousRooms && Memory.dangerousRooms[roomName]) {
            delete Memory.dangerousRooms[roomName];
            console.log(`🔓 Manually cleared dangerous room: ${roomName}`);
            return true;
        }
        return false;
    },
    listDangerousRooms: function() {
        if(!Memory.dangerousRooms || Object.keys(Memory.dangerousRooms).length === 0) {
            console.log("No dangerous rooms tracked.");
            return;
        }
        console.log("=== DANGEROUS ROOMS ===");
        for(const roomName in Memory.dangerousRooms) {
            const data = Memory.dangerousRooms[roomName];
            const status = data.permanent ? "PERMANENT" : `${data.cooldownUntil - Game.time} ticks remaining`;
            console.log(`${roomName}: ${data.reason} - ${status}`);
        }
    },
    showScoutStatus: function() {
        console.log("=== SCOUT STATUS ===");
        for(const creepName in Game.creeps) {
            const creep = Game.creeps[creepName];
            if(creep.memory.role === 'scout') {
                const taskInfo = creep.memory.task ? ` (${creep.memory.task})` : '';
                const target = creep.memory.task === 'checkRoom' ? creep.memory.destinationRoom : creep.memory.targetRoom;
                console.log(`${creep.name}${taskInfo}: ${creep.room.name} → ${target} (HP: ${creep.hits}/${creep.hitsMax})`);
            }
        }
    },
    travelToRoom: function(creep, targetRoomName) {
        if (!creep.memory.route) {
            let attempts = 0;
            while (attempts < 5) {
                const route = Game.map.findRoute(creep.room.name, targetRoomName, {
                    routeCallback: (roomName) => {
                        if (this.isRoomDangerous(roomName)) return Infinity;
                        if (creep.memory.routeBlacklist && creep.memory.routeBlacklist[roomName]) {
                            return Infinity;
                        }
                        return 1;
                    }
                });
                if (route === ERR_NO_PATH || route.length === 0) {
                    console.log(`❌ Scout ${creep.name} found no safe path to ${targetRoomName}.`);
                    this.assignTargetRoom(creep);
                    return ERR_NO_PATH;
                }
                if (route[0].room === creep.memory.previousRoom) {
                    log(`Pathfinding loop detected! Scout wants to go from ${creep.room.name} back to ${creep.memory.previousRoom}.`);
                    if (!creep.memory.routeBlacklist) creep.memory.routeBlacklist = {};
                    creep.memory.routeBlacklist[route[0].room] = true;
                    log(`Temporarily blacklisting ${route[0].room} and recalculating.`);
                    attempts++;
                    continue;
                }
                creep.memory.route = route;
                creep.memory.routeTarget = targetRoomName;
                break;
            }
        }
        const route = creep.memory.route;
        if (route && route.length > 0) {
            const exit = creep.pos.findClosestByPath(route[0].exit);
            if (exit) {
                creep.moveTo(exit, {
                    reusePath: 10,
                    ignoreCreeps: true
                });
                creep.say('🔭' + route[0].room);
            }
            return OK;
        } else {
            delete creep.memory.route;
            return OK;
        }
    },
    assignTargetRoom: function(creep) {
        delete creep.memory.routeBlacklist;
        delete creep.memory.route;
        const exits = Game.map.describeExits(creep.room.name);
        if(!exits) return;
        if(!creep.memory.visitedRooms) creep.memory.visitedRooms = {};
        const candidateRooms = [];
        for(const dir in exits) {
            const roomName = exits[dir];
            if (Game.rooms[roomName] && Game.rooms[roomName].controller && Game.rooms[roomName].controller.my) continue;
            const recentlyVisited = creep.memory.visitedRooms[roomName] && (Game.time - creep.memory.visitedRooms[roomName] < 500);
            const isDangerous = this.isRoomDangerous(roomName);
            if(!recentlyVisited && !isDangerous) {
                candidateRooms.push(roomName);
            }
        }
        if(candidateRooms.length > 0) {
            const targetRoom = candidateRooms[Math.floor(Math.random() * candidateRooms.length)];
            creep.memory.targetRoom = targetRoom;
            creep.say('🚪' + targetRoom);
            log(`🆕 Scout ${creep.name} assigned NEW target: ${targetRoom}`);
            return;
        }
        let oldestVisit = Game.time;
        let oldestRoom = null;
        for(const dir in exits) {
            const roomName = exits[dir];
            if(!this.isRoomDangerous(roomName)) {
                const lastVisit = creep.memory.visitedRooms[roomName] || 0;
                if(lastVisit < oldestVisit) {
                    oldestVisit = lastVisit;
                    oldestRoom = roomName;
                }
            }
        }
        if(oldestRoom) {
            creep.memory.targetRoom = oldestRoom;
            creep.say('🔄' + oldestRoom);
            log(`🔄 Scout ${creep.name} assigned OLD target: ${oldestRoom}`);
        } else {
            creep.memory.targetRoom = creep.room.name;
            creep.say('🏠 SAFE');
            console.log(`⚠️ Scout ${creep.name} has no safe rooms to explore, staying put.`);
        }
    },
    gatherIntelligence: function(creep) {
        if (creep.memory.roomScanned) return;
        const room = creep.room;
        const roomName = room.name;
        if(!Memory.exploration.rooms[roomName]) Memory.exploration.rooms[roomName] = {};
        Memory.exploration.rooms[roomName].lastVisit = Game.time;
        Memory.exploration.rooms[roomName].sources = room.find(FIND_SOURCES).map(s => ({ id: s.id, pos: s.pos }));
        if(room.controller) {
            Memory.exploration.rooms[roomName].controller = {
                id: room.controller.id,
                pos: room.controller.pos,
                owner: room.controller.owner ? room.controller.owner.username : null,
                level: room.controller.level
            };
        }
        Memory.exploration.rooms[roomName].minerals = room.find(FIND_MINERALS).map(m => ({ id: m.id, pos: m.pos, mineralType: m.mineralType }));
        Memory.exploration.rooms[roomName].exits = Game.map.describeExits(roomName);
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        Memory.exploration.rooms[roomName].hostile = hostiles.length > 0;
        let ownerInfo = (room.controller && room.controller.owner) ? ` (owned by ${room.controller.owner.username})` : '';
        log(`📊 Scout ${creep.name} scanned ${roomName}: ${room.find(FIND_SOURCES).length} sources, ${room.find(FIND_MINERALS).length} minerals, ${hostiles.length} hostiles${ownerInfo}`);
        if (!Memory.rooms) { Memory.rooms = {}; }
        const remoteHarvestIntel = {
            sources: room.find(FIND_SOURCES).map(s => s.id),
            owner: room.controller ? (room.controller.owner ? room.controller.owner.username : null) : null,
            reservation: room.controller ? room.controller.reservation : null,
            lastScouted: Game.time
        };
        Memory.rooms[roomName] = remoteHarvestIntel;
        log(`[Remote Harvest] Saved intel for ${roomName}.`);
        creep.memory.roomScanned = true;
    }
};

module.exports = roleScout;
