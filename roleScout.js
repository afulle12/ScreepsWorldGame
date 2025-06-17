const roleScout = {
    run: function(creep) {
        // Check if under attack
        this.checkForAttack(creep);

        if(!Memory.exploration) Memory.exploration = {};
        if(!Memory.exploration.rooms) Memory.exploration.rooms = {};
        if(!Memory.ownedRooms) Memory.ownedRooms = [];

        // Initialize dangerous rooms tracking
        if(!Memory.dangerousRooms) Memory.dangerousRooms = {};

        if(!creep.memory.targetRoom) {
            this.assignTargetRoom(creep);
        }

        // Reduced frequency of target reassignment to prevent bouncing
        if(Game.time % 200 === 0) {
            this.assignTargetRoom(creep);
        }

        if(creep.memory.lastRoom !== creep.room.name) {
            creep.memory.roomScanned = false;
            creep.memory.lastRoom = creep.room.name;

            // Track visited rooms
            if(!creep.memory.visitedRooms) creep.memory.visitedRooms = {};
            creep.memory.visitedRooms[creep.room.name] = Game.time;

            // Log room entry
            console.log(`🔍 Scout ${creep.name} entered room ${creep.room.name} (target: ${creep.memory.targetRoom})`);
        }

        if(creep.room.name !== creep.memory.targetRoom) {
            this.travelToRoom(creep, creep.memory.targetRoom);
        } else {
            this.gatherIntelligence(creep);

            if(!creep.memory.targetRoomEntryTime) {
                creep.memory.targetRoomEntryTime = Game.time;
                // Log arrival at target
                console.log(`🎯 Scout ${creep.name} arrived at target room ${creep.room.name}`);
            } else if(Game.time - creep.memory.targetRoomEntryTime > 50) {
                delete creep.memory.targetRoomEntryTime;
                console.log(`⏱️ Scout ${creep.name} finished exploring ${creep.room.name}, looking for new target`);
                this.assignTargetRoom(creep);
            }
        }
    },

    checkForAttack: function(creep) {
        // Check if creep took damage
        if(creep.hits < creep.hitsMax) {
            if(!creep.memory.lastHits || creep.memory.lastHits > creep.hits) {
                const damageTaken = creep.memory.lastHits - creep.hits;
                console.log(`🚨 SCOUT UNDER ATTACK! ${creep.name} in room ${creep.room.name} - Health: ${creep.hits}/${creep.hitsMax} (Damage: ${damageTaken})`);
                creep.say('💀 HELP!');

                // Detect tower attacks (typically 150+ damage per hit)
                const isTowerAttack = damageTaken >= 150;

                if(isTowerAttack) {
                    // PERMANENT AVOIDANCE for tower rooms
                    this.markRoomAsDangerous(creep.room.name, 'tower_attack', true);
                    console.log(`🏰 TOWER ATTACK DETECTED! Permanently marking room ${creep.room.name} as dangerous!`);
                    creep.say('🏰 TOWER!');
                } else if(creep.hits <= 20) {
                    // 50,000 tick cooldown for regular deaths
                    this.markRoomAsDangerous(creep.room.name, 'scout_death', false);
                    console.log(`💀 MARKING ROOM AS DANGEROUS: ${creep.room.name} - Scout ${creep.name} critically injured!`);
                }
            }
        }

        // Additional tower detection by checking for towers in room
        if(!creep.memory.towerCheckDone) {
            const towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
                filter: (structure) => structure.structureType === STRUCTURE_TOWER
            });

            if(towers.length > 0) {
                // Any room with hostile towers gets permanently marked as dangerous
                this.markRoomAsDangerous(creep.room.name, 'hostile_towers', true);
                console.log(`🏰 HOSTILE TOWERS DETECTED! Permanently marking room ${creep.room.name} as dangerous! (${towers.length} towers found)`);
                creep.say('🏰 TOWERS!');
            }

            creep.memory.towerCheckDone = true;
        }

        // Check for nearby hostiles
        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        if(hostiles.length > 0) {
            const nearbyHostiles = hostiles.filter(hostile => 
                creep.pos.getRangeTo(hostile) <= 3
            );

            if(nearbyHostiles.length > 0 && !creep.memory.hostileWarningGiven) {
                console.log(`⚠️ HOSTILE DETECTED! Scout ${creep.name} in room ${creep.room.name} - ${nearbyHostiles.length} hostile(s) nearby`);
                creep.memory.hostileWarningGiven = Game.time;
                creep.say('👻 ENEMY!');
            }

            // Reset warning flag if no hostiles nearby
            if(nearbyHostiles.length === 0) {
                delete creep.memory.hostileWarningGiven;
            }
        } else {
            delete creep.memory.hostileWarningGiven;
        }

        // Store current hits for next tick comparison
        creep.memory.lastHits = creep.hits;
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

        if(permanent) {
            console.log(`🚫 PERMANENTLY AVOIDING room ${roomName} due to ${reason}`);
        } else {
            console.log(`⏰ Avoiding room ${roomName} for ${cooldownTime} ticks due to ${reason}`);
        }
    },

    isRoomDangerous: function(roomName) {
        if(!Memory.dangerousRooms || !Memory.dangerousRooms[roomName]) {
            return false;
        }

        const dangerData = Memory.dangerousRooms[roomName];

        // Permanent rooms are always dangerous
        if(dangerData.permanent) {
            return true;
        }

        // Check if cooldown has expired for temporary rooms
        if(Game.time > dangerData.cooldownUntil) {
            delete Memory.dangerousRooms[roomName];
            console.log(`✅ Room ${roomName} is no longer marked as dangerous (cooldown expired after ${dangerData.reason})`);
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
        if(!Memory.dangerousRooms) {
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
                console.log(`${creep.name}: ${creep.room.name} → ${creep.memory.targetRoom} (HP: ${creep.hits}/${creep.hitsMax})`);
            }
        }
    },

    travelToRoom: function(creep, targetRoomName) {
        // Double-check if target room is dangerous before traveling
        if(this.isRoomDangerous(targetRoomName)) {
            console.log(`🚫 Scout ${creep.name} avoiding dangerous room ${targetRoomName}, reassigning target`);
            this.assignTargetRoom(creep);
            return;
        }

        const result = creep.moveTo(new RoomPosition(25, 25, targetRoomName), {
            visualizePathStyle: {stroke: '#55aaff'},
            reusePath: 50,
            plainCost: 1,
            swampCost: 5
        });

        if(result === ERR_NO_PATH) {
            console.log(`❌ Scout ${creep.name} found no path to ${targetRoomName}, reassigning target`);
            this.assignTargetRoom(creep);
        } else {
            creep.say('🔭');
            // Optional: Less frequent travel logging to avoid spam
            if(Game.time % 20 === 0) {
                console.log(`🚶 Scout ${creep.name} traveling from ${creep.room.name} to ${targetRoomName}`);
            }
        }
    },

    assignTargetRoom: function(creep) {
        const exits = Game.map.describeExits(creep.room.name);
        if(!exits) return;

        if(!creep.memory.visitedRooms) creep.memory.visitedRooms = {};

        // Clean up old visited rooms (older than 1000 ticks)
        for(const roomName in creep.memory.visitedRooms) {
            if(Game.time - creep.memory.visitedRooms[roomName] > 1000) {
                delete creep.memory.visitedRooms[roomName];
            }
        }

        // Find exits that lead OUT of your area and haven't been visited recently
        const candidateRooms = [];
        for(const dir in exits) {
            const roomName = exits[dir];
            const isOwned = Memory.ownedRooms.includes(roomName);
            const recentlyVisited = creep.memory.visitedRooms[roomName] && 
                                  (Game.time - creep.memory.visitedRooms[roomName] < 500);

            // Check if room is dangerous
            const isDangerous = this.isRoomDangerous(roomName);

            if(!isOwned && !recentlyVisited && !isDangerous) {
                candidateRooms.push(roomName);
            }
        }

        // If we have safe unvisited rooms, pick one randomly
        if(candidateRooms.length > 0) {
            const targetRoom = candidateRooms[Math.floor(Math.random() * candidateRooms.length)];
            creep.memory.targetRoom = targetRoom;
            creep.say('🚪 ' + targetRoom);
            console.log(`🆕 Scout ${creep.name} assigned NEW target: ${targetRoom}`);
            return;
        }

        // If no safe unvisited rooms, find the least recently visited SAFE room
        let oldestVisit = Game.time;
        let oldestRoom = null;

        for(const dir in exits) {
            const roomName = exits[dir];
            const isOwned = Memory.ownedRooms.includes(roomName);
            const isDangerous = this.isRoomDangerous(roomName);

            if(!isOwned && !isDangerous) {
                const lastVisit = creep.memory.visitedRooms[roomName] || 0;
                if(lastVisit < oldestVisit) {
                    oldestVisit = lastVisit;
                    oldestRoom = roomName;
                }
            }
        }

        if(oldestRoom) {
            creep.memory.targetRoom = oldestRoom;
            creep.say('🔄 ' + oldestRoom);
            console.log(`🔄 Scout ${creep.name} assigned OLD target: ${oldestRoom} (last visited ${Game.time - oldestVisit} ticks ago)`);
            return;
        }

        // If all adjacent rooms are dangerous/owned, stay put or go to a random safe room
        const allExits = Object.values(exits);
        const safeRooms = allExits.filter(roomName => 
            !Memory.ownedRooms.includes(roomName) && !this.isRoomDangerous(roomName)
        );

        if(safeRooms.length > 0) {
            const targetRoom = safeRooms[Math.floor(Math.random() * safeRooms.length)];
            creep.memory.targetRoom = targetRoom;
            creep.say('🛡️ ' + targetRoom);
            console.log(`🛡️ Scout ${creep.name} assigned SAFE fallback target: ${targetRoom}`);
        } else {
            // All adjacent rooms are dangerous - stay in current room
            creep.memory.targetRoom = creep.room.name;
            creep.say('🏠 SAFE');
            console.log(`⚠️ Scout ${creep.name} has no safe rooms to explore, staying put in ${creep.room.name}`);
        }
    },

    gatherIntelligence: function(creep) {
        const room = creep.room;
        const roomName = room.name;

        if(!Memory.exploration.rooms[roomName]) {
            Memory.exploration.rooms[roomName] = {
                lastVisit: Game.time,
                sources: [],
                controller: null,
                minerals: [],
                exits: {},
                hostile: false
            };
        } else {
            Memory.exploration.rooms[roomName].lastVisit = Game.time;
        }

        if(!creep.memory.roomScanned) {
            const sources = room.find(FIND_SOURCES);
            Memory.exploration.rooms[roomName].sources = sources.map(s => ({
                id: s.id,
                pos: {x: s.pos.x, y: s.pos.y}
            }));

            if(room.controller) {
                Memory.exploration.rooms[roomName].controller = {
                    id: room.controller.id,
                    pos: {x: room.controller.pos.x, y: room.controller.pos.y},
                    owner: room.controller.owner ? room.controller.owner.username : null,
                    level: room.controller.level
                };
            }

            const minerals = room.find(FIND_MINERALS);
            Memory.exploration.rooms[roomName].minerals = minerals.map(m => ({
                id: m.id,
                pos: {x: m.pos.x, y: m.pos.y},
                mineralType: m.mineralType
            }));

            Memory.exploration.rooms[roomName].exits = Game.map.describeExits(roomName);

            const hostiles = room.find(FIND_HOSTILE_CREEPS);
            Memory.exploration.rooms[roomName].hostile = hostiles.length > 0;

            creep.memory.roomScanned = true;

            // **FIXED: Log room scan results without optional chaining**
            let ownerInfo = '';
            if(room.controller && room.controller.owner) {
                ownerInfo = ` (owned by ${room.controller.owner.username})`;
            }
            console.log(`📊 Scout ${creep.name} scanned ${roomName}: ${sources.length} sources, ${minerals.length} minerals, ${hostiles.length} hostiles${ownerInfo}`);
        }

        this.exploreRoom(creep);
    },

    exploreRoom: function(creep) {
        if(!creep.memory.exploreTarget || Game.time % 10 === 0) {
            const pointsOfInterest = [];

            if(creep.room.controller) {
                pointsOfInterest.push({
                    x: creep.room.controller.pos.x,
                    y: creep.room.controller.pos.y
                });
            }

            const sources = creep.room.find(FIND_SOURCES);
            for(let source of sources) {
                pointsOfInterest.push({
                    x: source.pos.x,
                    y: source.pos.y
                });
            }

            const minerals = creep.room.find(FIND_MINERALS);
            for(let mineral of minerals) {
                pointsOfInterest.push({
                    x: mineral.pos.x,
                    y: mineral.pos.y
                });
            }

            pointsOfInterest.push({x: 10, y: 10});
            pointsOfInterest.push({x: 40, y: 10});
            pointsOfInterest.push({x: 10, y: 40});
            pointsOfInterest.push({x: 40, y: 40});
            pointsOfInterest.push({x: 25, y: 25});

            const targetPoint = pointsOfInterest[Math.floor(Math.random() * pointsOfInterest.length)];
            creep.memory.exploreTarget = targetPoint;
        }

        const target = creep.memory.exploreTarget;
        const targetPos = new RoomPosition(target.x, target.y, creep.room.name);

        creep.moveTo(targetPos, {
            visualizePathStyle: {stroke: '#55aaff'},
            reusePath: 5
        });
    }
};

module.exports = roleScout;
