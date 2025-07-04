// =================================================================
// CONFIGURATION
// =================================================================
const DETAILED_LOGGING = true; // Set to false to disable verbose scout console logs.
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
     * Spawns a scout with a specific mission to check if a room is visitable.
     * Can be called from the Screeps console.
     * Example: require('roleScout').orderCheckRoom('E2N46', 'W2N2')
     * @param {string} spawnRoomName - The name of the room with a spawn to create the scout.
     * @param {string} destinationRoomName - The name of the room to send the scout to.
     */
    orderCheckRoom: function(spawnRoomName, destinationRoomName) {
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
            task: 'checkRoom', // Special task identifier
            destinationRoom: destinationRoomName,
            spawnRoom: spawnRoomName
        };

        const result = spawn.spawnCreep(body, newName, { memory: memory });

        if (result === OK) {
            const message = `✅ Spawning scout '${newName}' from ${spawnRoomName} to check room ${destinationRoomName}.`;
            console.log(message); // Always log this user-initiated action
            return message;
        } else {
            const errorMessage = `❌ Failed to spawn scout. Error code: ${result}`;
            console.log(errorMessage); // Always log errors
            return errorMessage;
        }
    },

    /**
     * Checks for dead creeps and handles their last wishes, sending detailed failure notifications.
     * This should be called from your main loop in `main.js`.
     */
    handleDeadCreeps: function() {
        for (const name in Memory.creeps) {
            if (!Game.creeps[name]) {
                const memory = Memory.creeps[name];

                if (memory.role === 'scout' && memory.task === 'checkRoom' && !memory.notificationSent) {
                    const deathRoom = memory.lastAttackedIn || memory.lastRoom || 'an unknown room';
                    const cause = memory.causeOfDeath || 'unknown reasons';

                    const message = `❌ Mission Failed: Scout [${name}] died in room ${deathRoom} (Cause: ${cause}) before reaching its destination of ${memory.destinationRoom}.`;
                    Game.notify(message, 0);
                    console.log(message); // Always log critical failures
                }

                delete Memory.creeps[name];
            }
        }
    },

    /**
     * Main logic loop for all scouts.
     * @param {Creep} creep
     */
    run: function(creep) {
        if (creep.spawning) return;

        if (creep.memory.task === 'checkRoom') {
            this.runCheckRoomTask(creep);
            return;
        }

        this.checkForAttack(creep);

        if(!Memory.exploration) Memory.exploration = {};
        if(!Memory.exploration.rooms) Memory.exploration.rooms = {};
        if(!Memory.ownedRooms) Memory.ownedRooms = [];
        if(!Memory.dangerousRooms) Memory.dangerousRooms = {};

        if(!creep.memory.targetRoom) {
            this.assignTargetRoom(creep);
        }

        if(creep.memory.lastRoom !== creep.room.name) {
            creep.memory.roomScanned = false;
            creep.memory.lastRoom = creep.room.name;
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

    /**
     * Logic for a scout assigned the 'checkRoom' task.
     * @param {Creep} creep
     */
    runCheckRoomTask: function(creep) {
        const destination = creep.memory.destinationRoom;

        if (creep.room.name === destination) {
            if (!creep.memory.notificationSent) {
                const message = `✅ Scout [${creep.name}] has successfully reached the destination room: ${destination}. The room is visitable.`;
                Game.notify(message, 0);
                console.log(message); // Always log mission success
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
                    console.log(message); // Always log mission failure
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
            creep.moveTo(idlePosition, { visualizePathStyle: { stroke: '#cccccc' } });
        }
    },

    checkForAttack: function(creep) {
        if(creep.hits < creep.hitsMax) {
            if(!creep.memory.lastHits || creep.memory.lastHits > creep.hits) {
                const damageTaken = creep.memory.lastHits - creep.hits;
                console.log(`🚨 SCOUT UNDER ATTACK! ${creep.name} in room ${creep.room.name} - Health: ${creep.hits}/${creep.hitsMax} (Damage: ${damageTaken})`);
                creep.say('💀 HELP!');
                creep.memory.lastAttackedIn = creep.room.name;
                const isTowerAttack = damageTaken >= 150;
                if(isTowerAttack) {
                    this.markRoomAsDangerous(creep.room.name, 'tower_attack', true);
                    console.log(`🏰 TOWER ATTACK DETECTED! Permanently marking room ${creep.room.name} as dangerous!`);
                    creep.say('🏰 TOWER!');
                    creep.memory.causeOfDeath = 'Hostile Tower';
                } else {
                    creep.memory.causeOfDeath = 'Hostile Creep/Trap';
                }
            }
        }
        if(!creep.memory.towerCheckDone) {
            const towers = creep.room.find(FIND_HOSTILE_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
            if(towers.length > 0) {
                this.markRoomAsDangerous(creep.room.name, 'hostile_towers', true);
                console.log(`🏰 HOSTILE TOWERS DETECTED! Permanently marking room ${creep.room.name} as dangerous!`);
            }
            creep.memory.towerCheckDone = true;
        }
        creep.memory.lastHits = creep.hits;
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
        if (!creep.memory.route || creep.memory.routeTarget !== targetRoomName) {
            log(`🗺️ Scout ${creep.name} calculating new route to ${targetRoomName}`);
            const route = Game.map.findRoute(creep.room.name, targetRoomName, {
                routeCallback: (roomName) => {
                    if (roomName === targetRoomName) return 1;
                    if (this.isRoomDangerous(roomName)) return Infinity;
                    return 1;
                }
            });

            if (route === ERR_NO_PATH || route.length === 0) {
                console.log(`❌ Scout ${creep.name} found no safe path to ${targetRoomName}, reassigning target.`);
                if (creep.memory.task !== 'checkRoom') {
                    this.assignTargetRoom(creep);
                }
                return ERR_NO_PATH;
            }

            creep.memory.route = route;
            creep.memory.routeTarget = targetRoomName;
        }

        const currentRoom = creep.room.name;
        const route = creep.memory.route;

        if (route.length > 0 && currentRoom === route[0].room) {
            route.shift();
        }

        if (route.length > 0) {
            const exit = creep.pos.findClosestByPath(route[0].exit);
            if (exit) {
                if (creep.pos.isNearTo(exit)) {
                    creep.moveTo(exit);
                } else {
                    let stagingPos = exit;
                    if (exit.x === 0) stagingPos = new RoomPosition(1, exit.y, creep.room.name);
                    else if (exit.x === 49) stagingPos = new RoomPosition(48, exit.y, creep.room.name);
                    else if (exit.y === 0) stagingPos = new RoomPosition(exit.x, 1, creep.room.name);
                    else if (exit.y === 49) stagingPos = new RoomPosition(exit.x, 48, creep.room.name);

                    creep.moveTo(stagingPos, {
                        visualizePathStyle: { stroke: '#55aaff' },
                        reusePath: 10,
                        ignoreCreeps: true,
                        costCallback: function(roomName, costMatrix) {
                            if (roomName !== creep.room.name) return;
                            let cm = costMatrix.clone();
                            for (let i = 0; i < 50; i++) {
                                if (cm.get(i, 0) === 0) cm.set(i, 0, 10);
                                if (cm.get(i, 49) === 0) cm.set(i, 49, 10);
                                if (cm.get(0, i) === 0) cm.set(0, i, 10);
                                if (cm.get(49, i) === 0) cm.set(49, i, 10);
                            }
                            return cm;
                        },
                    });
                }
                creep.say('🔭' + route[0].room);
            }
            return OK;
        } else {
            delete creep.memory.route;
            delete creep.memory.routeTarget;
            return OK;
        }
    },

    assignTargetRoom: function(creep) {
        const exits = Game.map.describeExits(creep.room.name);
        if(!exits) return;

        if(!creep.memory.visitedRooms) creep.memory.visitedRooms = {};

        const candidateRooms = [];
        for(const dir in exits) {
            const roomName = exits[dir];
            const isOwned = Memory.ownedRooms.includes(roomName);
            const recentlyVisited = creep.memory.visitedRooms[roomName] && (Game.time - creep.memory.visitedRooms[roomName] < 500);
            const isDangerous = this.isRoomDangerous(roomName);

            if(!isOwned && !recentlyVisited && !isDangerous) {
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
            if(!Memory.ownedRooms.includes(roomName) && !this.isRoomDangerous(roomName)) {
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
            console.log(`⚠️ Scout ${creep.name} has no safe rooms to explore, staying put.`); // Always log this warning
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
        creep.memory.roomScanned = true;
        let ownerInfo = (room.controller && room.controller.owner) ? ` (owned by ${room.controller.owner.username})` : '';
        log(`📊 Scout ${creep.name} scanned ${roomName}: ${room.find(FIND_SOURCES).length} sources, ${room.find(FIND_MINERALS).length} minerals, ${hostiles.length} hostiles${ownerInfo}`);
    }
};

module.exports = roleScout;
