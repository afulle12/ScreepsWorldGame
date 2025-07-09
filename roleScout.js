// =================================================================================================
// |                                                                                               |
// |                                     HOW TO USE THIS SCOUT                                     |
// |                                                                                               |
// | 1. To spawn a scout and send it to a specific room to start exploring:                        |
// |    require('roleScout').orderExplore('W1N8'); // (Target Room Name)                           |
// |                                                                                               |
// | 2. To order a scout for a specific mission (e.g., check if a path is clear):                  |
// |    require('roleScout').orderCheckRoom('E2N47', 'E9N44'); // (From, To)                        |
// |                                                                                               |
// | 3. To spawn a "fire-and-forget" autonomous scout that explores on its own:                    |
// |    require('roleScout').orderAutonomousScout();                                               |
// |                                                                                               |
// | 4. To find a safe path from one room to another, retrying until a path is found:              |
// |    require('roleScout').orderPathfinder('W1N8', 'E5N8'); // (From, To)                         |
// |                                                                                               |
// =================================================================================================

// =================================================================
// CONFIGURATION
// =================================================================
const DETAILED_LOGGING = true; // Set to false to disable verbose scout console logs.
const FRIENDLY_PLAYERS = ['tarenty', 'Player1', 'AnotherFriend']; // Add friendly usernames here
// =================================================================

const log = (message) => {
    if (DETAILED_LOGGING) {
        console.log(message);
    }
};

const roleScout = {
    // --- UNCHANGED FUNCTIONS (orderExplore, orderCheckRoom, orderAutonomousScout, orderPathfinder, spawnPathfinderScout, handleDeadCreeps) ---
    orderExplore: function(destinationRoomName) { /* ... full code below ... */ },
    orderCheckRoom: function(spawnRoomName, destinationRoomName) { /* ... full code below ... */ },
    orderAutonomousScout: function() { /* ... full code below ... */ },
    orderPathfinder: function(originRoomName, destinationRoomName) { /* ... full code below ... */ },
    spawnPathfinderScout: function(missionId) { /* ... full code below ... */ },
    handleDeadCreeps: function() { /* ... full code below ... */ },

    /**
     * MODIFIED: When a creep enters a new room, clear its temporary local blacklist.
     */
        run: function(creep) {
        if (creep.spawning) return;
    
        if (creep.memory.lastRoom !== creep.room.name) {
            creep.memory.previousRoom = creep.memory.lastRoom;
            creep.memory.lastRoom = creep.room.name;
    
            // Only clear local blacklist if we're making forward progress
            // Don't clear it if we're backtracking due to a failed path
            if (!creep.memory.backtracking) {
                delete creep.memory.localBlacklist;
            }
    
            if (creep.memory.task === 'pathfinder') {
                log(`Pathfinder [${creep.name}] mission [${creep.memory.missionId}] entered new room: ${creep.room.name}`);
            }
        }
    
        if (this.checkForDanger(creep)) {
            return;
        }
    
        if (creep.memory.task === 'pathfinder') {
            this.runPathfinderTask(creep);
        } else if (creep.memory.task === 'checkRoom') {
            this.runCheckRoomTask(creep);
        } else {
            this.runAutonomousTask(creep);
        }
    },


    /**
     * MODIFIED: Implemented the new intelligent "stuck" logic.
     * - Uses a temporary `localBlacklist` to try alternate exits from the current room.
     * - Only returns ERR_NO_PATH when all local exits have been tried and failed.
     */
        travelToRoom: function(creep, targetRoomName) {
        if (!creep.memory.route || creep.memory.routeTarget !== targetRoomName) {
            delete creep.memory.route;
            creep.memory.backtracking = false; // Reset backtracking flag
    
            log(`🗺️ Scout [${creep.name}] calculating new route from ${creep.room.name} to ${targetRoomName}.`);
            const missionBlacklist = (creep.memory.task === 'pathfinder' && Memory.pathfindingMissions && Memory.pathfindingMissions[creep.memory.missionId])
                ? Memory.pathfindingMissions[creep.memory.missionId].blacklistedRooms
                : {};
            if (Object.keys(missionBlacklist).length > 0) log(`   - Mission blacklist: [${Object.keys(missionBlacklist).join(', ')}]`);
            if (creep.memory.localBlacklist && Object.keys(creep.memory.localBlacklist).length > 0) log(`   - Temp local blacklist: [${Object.keys(creep.memory.localBlacklist).join(', ')}]`);
    
            const route = Game.map.findRoute(creep.room.name, targetRoomName, {
                routeCallback: (roomName) => {
                    if (creep.memory.task === 'pathfinder') {
                        if (missionBlacklist[roomName]) return Infinity;
                        if (creep.memory.localBlacklist && creep.memory.localBlacklist[roomName]) return Infinity;
                    } else {
                        if (this.isRoomDangerous(roomName)) return Infinity;
                    }
                    return 1;
                }
            });
    
            if (route === ERR_NO_PATH || route.length === 0) {
                log(`❌ Scout [${creep.name}] found NO GLOBAL PATH to ${targetRoomName}. All exits may be blocked or blacklisted.`);
                return ERR_NO_PATH;
            }
            log(`   ✔️ Path found for [${creep.name}]: ${JSON.stringify(route.map(r => r.room))}`);
            creep.memory.route = route;
            creep.memory.routeTarget = targetRoomName;
        }
    
        const route = creep.memory.route;
        if (route && route.length > 0) {
            if (route[0].room === creep.room.name) {
                route.shift();
            }
            if (route.length > 0) {
                const exit = creep.pos.findClosestByPath(route[0].exit);
                if (exit) {
                    log(`   🏃 [${creep.name}] moving towards exit to ${route[0].room}.`);
                    creep.moveTo(exit, { reusePath: 5, ignoreCreeps: true, visualizePathStyle: false });
                    return OK;
                } else {
                    // LOCAL PATH FAILED
                    const failedExitRoom = route[0].room;
                    log(`   ⚠️ [${creep.name}] could not find a LOCAL path to the exit for room ${failedExitRoom}. Adding to temporary blacklist and will recalculate route.`);
    
                    if (!creep.memory.localBlacklist) {
                        creep.memory.localBlacklist = {};
                    }
                    creep.memory.localBlacklist[failedExitRoom] = true;
                    creep.memory.backtracking = true; // Set backtracking flag
                    delete creep.memory.route; // Force recalculation on the next tick
                    return OK;
                }
            }
        }
        delete creep.memory.route;
        return OK;
    },


    // --- FULL UNREDACTED CODE FOR ALL OTHER FUNCTIONS ---

    spawnPathfinderScout: function(missionId) {
        if (!Memory.pathfindingMissions || !Memory.pathfindingMissions[missionId]) {
            return `Error: Cannot find mission data for ${missionId}.`;
        }
        const mission = Memory.pathfindingMissions[missionId];
        if (mission.blacklistedRooms[mission.origin]) {
            mission.status = 'failed';
            mission.failureReason = `Origin room ${mission.origin} is impassable or dangerous.`;
            const message = `❌ Pathfinding Mission [${missionId}] Failed: ${mission.failureReason}`;
            console.log(message);
            Game.notify(message, 60);
            return message;
        }
        const preflightRoute = Game.map.findRoute(mission.origin, mission.destination, {
            routeCallback: (roomName) => {
                if (mission.blacklistedRooms[roomName]) return Infinity;
                return 1;
            }
        });
        if (preflightRoute === ERR_NO_PATH || preflightRoute.length === 0) {
            mission.status = 'failed';
            mission.failureReason = `No possible global path exists from ${mission.origin} to ${mission.destination} with the current blacklist.`;
            const message = `❌ Pathfinding Mission [${missionId}] Failed: ${mission.failureReason}`;
            console.log(message);
            Game.notify(message, 60);
            return message;
        }
        const spawnRoom = Game.rooms[mission.origin];
        if (!spawnRoom || !spawnRoom.controller || !spawnRoom.controller.my) {
            mission.status = 'failed';
            mission.failureReason = `No vision or control in origin room ${mission.origin}.`;
            console.log(`❌ Mission [${missionId}] Failed: ${mission.failureReason}`);
            Game.notify(`❌ Mission [${missionId}] Failed: ${mission.failureReason}`);
            return mission.failureReason;
        }
        const spawns = spawnRoom.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
        if (!spawns.length) {
            return `Warning: No available spawn in room ${mission.origin} to continue mission [${missionId}].`;
        }
        const spawn = spawns[0];
        mission.attempts += 1;
        const newName = `Pathfinder_${missionId.replace(/_/g, '')}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', task: 'pathfinder', missionId: missionId, originRoom: mission.origin, destinationRoom: mission.destination, pathTaken: [mission.origin] };
        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            mission.status = 'active';
            mission.activeScout = newName;
            const message = `✅ Spawning pathfinder scout '${newName}' (Attempt #${mission.attempts}) for mission [${missionId}].`;
            console.log(message);
            return message;
        } else {
            mission.attempts -= 1;
            return `❌ Failed to spawn pathfinder scout for mission [${missionId}]. Error code: ${result}`;
        }
    },
    handleDeadCreeps: function() {
        if (!Memory.creeps) return;
        for (const name in Memory.creeps) {
            if (Game.creeps[name]) continue;
            const memory = Memory.creeps[name];
            if (memory.role !== 'scout') {
                delete Memory.creeps[name];
                continue;
            }
    
            if (memory.task === 'pathfinder') {
                const missionId = memory.missionId;
                const mission = Memory.pathfindingMissions ? Memory.pathfindingMissions[missionId] : undefined;
                if (mission && mission.status === 'active' && mission.activeScout === name) {
                    const deathRoom = memory.lastAttackedIn || memory.lastRoom;
    
                    if (deathRoom) {
                        // Mark room as globally dangerous
                        this.markRoomAsDangerous(deathRoom, 'pathfinder_death', true);
    
                        // Add to mission blacklist
                        mission.blacklistedRooms[deathRoom] = true;
    
                        console.log(`💀 Pathfinder [${name}] died in ${deathRoom}. Room blacklisted globally and for mission [${missionId}].`);
    
                        // Spawn new pathfinder
                        this.spawnPathfinderScout(missionId);
                    } else {
                        mission.status = 'failed';
                        mission.failureReason = `Scout [${name}] died in an unknown location.`;
                        const message = `❌ Pathfinding Mission [${missionId}] Failed: ${mission.failureReason}`;
                        console.log(message);
                        Game.notify(message, 60);
                    }
                }
            } else if (memory.task === 'checkRoom' && !memory.notificationSent) {
                const deathRoom = memory.lastAttackedIn || memory.lastRoom;
                if (deathRoom) {
                    // Mark room as globally dangerous for regular scouts too
                    this.markRoomAsDangerous(deathRoom, 'scout_death', true);
                    console.log(`💀 Scout [${name}] died in ${deathRoom}. Room marked as dangerous.`);
                }
    
                const message = `❌ Mission Failed: Scout [${name}] died before reaching ${memory.destinationRoom}.`;
                Game.notify(message, 0);
                console.log(message);
            }
    
            delete Memory.creeps[name];
        }
    },

    orderExplore: function(destinationRoomName) {
        if (!destinationRoomName) return 'Error: destinationRoomName is required.';
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
            const message = `❌ Error: No available spawn found to start exploration mission to ${destinationRoomName}.`;
            console.log(message);
            return message;
        }
        const spawn = bestSpawnRoom.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
        const newName = `Scout_${destinationRoomName}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', targetRoom: destinationRoomName };
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
    orderCheckRoom: function(spawnRoomName, destinationRoomName) {
        if (!spawnRoomName || !destinationRoomName) return 'Error: Both spawnRoomName and destinationRoomName are required.';
        const spawnRoom = Game.rooms[spawnRoomName];
        if (!spawnRoom) return `Error: No vision in spawn room ${spawnRoomName}.`;
        const spawns = spawnRoom.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
        if (!spawns.length) return `Error: No available spawn in room ${spawnRoomName}.`;
        const spawn = spawns[0];
        const newName = `VisCheck_${destinationRoomName}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', task: 'checkRoom', destinationRoom: destinationRoomName, spawnRoom: spawnRoomName, pathTaken: [spawnRoomName] };
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
    orderAutonomousScout: function() {
        let spawn = null;
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room.controller && room.controller.my) {
                const availableSpawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
                if (availableSpawns.length > 0) {
                    spawn = availableSpawns[0];
                    break;
                }
            }
        }
        if (!spawn) {
            const message = `❌ Error: No available spawn found to launch an autonomous scout.`;
            console.log(message);
            return message;
        }
        const newName = `AutoScout_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', task: 'autonomous', homeRoom: spawn.room.name };
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
    orderPathfinder: function(originRoomName, destinationRoomName) {
        if (!originRoomName || !destinationRoomName) return 'Error: Both originRoomName and destinationRoomName are required.';
        const missionId = `path_${originRoomName}_${destinationRoomName}`;
        if (!Memory.pathfindingMissions) Memory.pathfindingMissions = {};
        const existingMission = Memory.pathfindingMissions[missionId];
        if (existingMission && existingMission.status === 'active') return `ℹ️ Mission [${missionId}] is already active.`;
        if (existingMission && existingMission.status === 'success') return `✅ Mission [${missionId}] has already succeeded. Path: ${existingMission.foundPath.join(' → ')}`;
        Memory.pathfindingMissions[missionId] = { origin: originRoomName, destination: destinationRoomName, status: 'initializing', attempts: 0, blacklistedRooms: {}, activeScout: null, foundPath: null, startTime: Game.time };
        console.log(`🚀 Initializing new pathfinding mission [${missionId}] from ${originRoomName} to ${destinationRoomName}.`);
        return this.spawnPathfinderScout(missionId);
    },
    runPathfinderTask: function(creep) {
        const missionId = creep.memory.missionId;
        const mission = Memory.pathfindingMissions ? Memory.pathfindingMissions[missionId] : undefined;
        if (!mission || mission.status !== 'active') {
            creep.say('✅ Over');
            creep.suicide();
            return;
        }
        const destination = creep.memory.destinationRoom;
        if (creep.room.name === destination) {
            if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
            const pathString = creep.memory.pathTaken.join(' → ');
            mission.status = 'success';
            mission.foundPath = creep.memory.pathTaken;
            mission.finishTime = Game.time;
            const message = `✅ Path Found! Mission [${missionId}] succeeded.\nRoute: ${pathString}`;
            console.log(message);
            Game.notify(message, 60);
            creep.say('✅ Path!');
            creep.suicide();
            return;
        }
        if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
        const travelResult = this.travelToRoom(creep, destination);
        if (travelResult === ERR_NO_PATH) {
            log(`Pathfinder [${creep.name}] is stuck in ${creep.room.name}. Terminating scout to trigger retry.`);
            creep.say('🚫 Stuck');
            creep.suicide();
        }
    },
    runCheckRoomTask: function(creep) {
        const destination = creep.memory.destinationRoom;
        if (creep.room.name === destination) {
            if (!creep.memory.notificationSent) {
                if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
                const pathString = creep.memory.pathTaken.join(' → ');
                const message = `✅ Mission Complete: Scout [${creep.name}] reached ${destination}.\nPath: ${pathString}`;
                Game.notify(message, 0);
                console.log(message);
                creep.memory.notificationSent = true;
                creep.say('✅ Done!');
            }
            this.idle(creep);
        } else {
            if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
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
    runAutonomousTask: function(creep) {
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
        if(!Memory.exploration) Memory.exploration = {};
        if(!Memory.exploration.rooms) Memory.exploration.rooms = {};
        if(!Memory.ownedRooms) Memory.ownedRooms = [];
        if(!Memory.dangerousRooms) Memory.dangerousRooms = {};
        if(!creep.memory.targetRoom) this.assignTargetRoom(creep);
        if(creep.memory.lastRoom !== creep.room.name) {
            creep.memory.roomScanned = false;
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
    idle: function(creep) {
        const idlePosition = new RoomPosition(48, 48, creep.room.name);
        if (!creep.pos.isEqualTo(idlePosition)) creep.moveTo(idlePosition);
    },
    checkForDanger: function(creep) {
        const room = creep.room;
        if (room.controller && room.controller.owner && FRIENDLY_PLAYERS.includes(room.controller.owner.username)) return false;
    
        if (creep.hits < creep.hitsMax && (!creep.memory.lastHits || creep.memory.lastHits > creep.hits)) {
            creep.memory.lastAttackedIn = creep.room.name;
    
            // Only non-pathfinder scouts flee from danger
            if (creep.memory.task !== 'pathfinder') {
                this.markRoomAsDangerous(creep.room.name, 'hostile_creeps', false);
                log(`⚔️ DANGER! Scout ${creep.name} under attack in ${creep.room.name}!`);
                creep.memory.fleeing = true;
                return true;
            } else {
                log(`⚔️ Pathfinder ${creep.name} taking damage in ${creep.room.name} but continuing mission`);
            }
        }
        creep.memory.lastHits = creep.hits;
    
        const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
        if (towers.length > 0) {
            // Only non-pathfinder scouts flee from towers
            if (creep.memory.task !== 'pathfinder') {
                this.markRoomAsDangerous(creep.room.name, 'hostile_towers', true);
                creep.memory.lastAttackedIn = creep.room.name;
                log(`🏰 DANGER! Scout ${creep.name} detected hostile towers in ${creep.room.name}!`);
                creep.memory.fleeing = true;
                return true;
            } else {
                log(`🏰 Pathfinder ${creep.name} detected hostile towers in ${creep.room.name} but continuing mission`);
            }
        }
    
        return false;
    },

    markRoomAsDangerous: function(roomName, reason, permanent) {
        if(!Memory.dangerousRooms) Memory.dangerousRooms = {};
        const cooldownTime = permanent ? 999999999 : 50000;
        Memory.dangerousRooms[roomName] = {
            markedAt: Game.time,
            reason: reason,
            cooldownUntil: Game.time + cooldownTime,
            permanent: permanent
        };

        const reasonText = {
            'hostile_creeps': 'hostile creeps',
            'hostile_towers': 'hostile towers',
            'pathfinder_death': 'pathfinder scout death',
            'scout_death': 'scout death'
        }[reason] || reason;

        // MOVED: This logic now correctly resides inside the function.
        // Add dangerous room to all active pathfinding missions
        if (Memory.pathfindingMissions) {
            for (const missionId in Memory.pathfindingMissions) {
                const mission = Memory.pathfindingMissions[missionId];
                if (mission.status === 'active') {
                    mission.blacklistedRooms[roomName] = true;
                    console.log(`Added dangerous room ${roomName} to mission ${missionId} blacklist`);
                }
            }
        }

        if(permanent) console.log(`🚫 PERMANENTLY AVOIDING room ${roomName} due to ${reasonText}`);
        else console.log(`⏰ Avoiding room ${roomName} for ${cooldownTime} ticks due to ${reasonText}`);
    },

    // RENAMED and FIXED: The stray code is removed and the function name is corrected.
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
                const target = creep.memory.task === 'checkRoom' || creep.memory.task === 'pathfinder' ? creep.memory.destinationRoom : creep.memory.targetRoom;
                console.log(`${creep.name}${taskInfo}: ${creep.room.name} → ${target} (HP: ${creep.hits}/${creep.hitsMax})`);
            }
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
            if(!recentlyVisited && !isDangerous) candidateRooms.push(roomName);
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
        if(room.controller) Memory.exploration.rooms[roomName].controller = { id: room.controller.id, pos: room.controller.pos, owner: room.controller.owner ? room.controller.owner.username : null, level: room.controller.level };
        Memory.exploration.rooms[roomName].minerals = room.find(FIND_MINERALS).map(m => ({ id: m.id, pos: m.pos, mineralType: m.mineralType }));
        Memory.exploration.rooms[roomName].exits = Game.map.describeExits(roomName);
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        Memory.exploration.rooms[roomName].hostile = hostiles.length > 0;
        let ownerInfo = (room.controller && room.controller.owner) ? ` (owned by ${room.controller.owner.username})` : '';
        log(`📊 Scout ${creep.name} scanned ${roomName}: ${room.find(FIND_SOURCES).length} sources, ${room.find(FIND_MINERALS).length} minerals, ${hostiles.length} hostiles${ownerInfo}`);
        if (!Memory.rooms) Memory.rooms = {};
        Memory.rooms[roomName] = { sources: room.find(FIND_SOURCES).map(s => s.id), owner: room.controller ? (room.controller.owner ? room.controller.owner.username : null) : null, reservation: room.controller ? room.controller.reservation : null, lastScouted: Game.time };
        log(`[Remote Harvest] Saved intel for ${roomName}.`);
        creep.memory.roomScanned = true;
    }
};

module.exports = roleScout;
