//    orderDemolition('E1S1', 'E2S2', 2) - Orders 2 demolition teams from E1S1 to demolish E2S2
//    cancelDemolitionOrder('E2S2') - Cancels the demolition operation against E2S2
const iff = require('iff');

const roleDemolition = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // Handle different demolition roles
        if (creep.memory.demolitionRole === 'demolisher') {
            this.runDemolisher(creep);
        } else if (creep.memory.demolitionRole === 'collector') {
            this.runCollector(creep);
        }
    },

    runDemolisher: function(creep) {
        const targetRoom = creep.memory.targetRoom;
        const homeRoom = creep.memory.homeRoom;

        // Move to target room if not there
        if (creep.room.name !== targetRoom) {
            const exitDir = Game.map.findExit(creep.room, targetRoom);
            if (exitDir === ERR_NO_PATH) {
                console.log(`[Demolisher] ${creep.name}: No path to ${targetRoom}`);
                return;
            }
            const exit = creep.pos.findClosestByRange(exitDir);
            creep.moveTo(exit, {visualizePathStyle: {stroke: '#ff0000'}});
            return;
        }

        const room = Game.rooms[targetRoom];

        // Safety check - don't demolish friendly rooms
        if (room && room.controller && room.controller.owner) {
            if (room.controller.my) {
                console.log(`[Demolisher] ${creep.name}: Aborting - ${targetRoom} is our own room!`);
                creep.memory.role = 'harvester';
                return;
            }

            if (iff.IFF_WHITELIST.includes(room.controller.owner.username)) {
                console.log(`[Demolisher] ${creep.name}: Aborting - ${targetRoom} is owned by ally ${room.controller.owner.username}`);
                creep.memory.role = 'harvester';
                return;
            }
        }

        // Check if collector partner exists
        const partnerName = creep.memory.partnerName;
        const partner = Game.creeps[partnerName];

        // If full, handle energy transfer
        if (creep.store.getFreeCapacity() === 0) {
            if (partner && partner.room.name === creep.room.name) {
                const range = creep.pos.getRangeTo(partner);
                if (range <= 1) {
                    // Transfer energy to collector
                    const result = creep.transfer(partner, RESOURCE_ENERGY);
                    if (result === OK) {
                        creep.say('💰 GIVE');
                    } else if (result === ERR_FULL) {
                        creep.say('📦 FULL');
                    } else {
                        console.log(`[Demolisher] ${creep.name}: Transfer failed: ${result}`);
                        // If transfer fails, drop energy
                        creep.drop(RESOURCE_ENERGY);
                        creep.say('💧 DROP');
                    }
                } else {
                    // Wait for collector to get closer
                    creep.say('⏳ WAIT');
                }
                return;
            } else if (partner) {
                // Partner exists but not in same room, wait
                creep.say('⏳ WAIT');
                return;
            } else {
                // No collector, dump energy to continue working
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    const droppedEnergy = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
                        filter: r => r.resourceType === RESOURCE_ENERGY
                    });
                    if (droppedEnergy.length === 0) {
                        creep.drop(RESOURCE_ENERGY);
                        creep.say('💧 DROP');
                    }
                }
            }
        }

        // Simple targeting: Look for ramparts first, always
        const ramparts = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_RAMPART
        });

        if (ramparts.length > 0) {
            const target = creep.pos.findClosestByRange(ramparts);
            console.log(`[Demolisher] ${creep.name}: Found ${ramparts.length} ramparts, targeting closest`);

            const result = creep.dismantle(target);
            if (result === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}});
                creep.say('➡️ MOVE');
            } else if (result === OK) {
                creep.say('🛡️ RAM');
            } else {
                console.log(`[Demolisher] ${creep.name}: Dismantle rampart failed: ${result}`);
            }
            return;
        }

        // If no ramparts, look for other hostile structures
        const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType !== STRUCTURE_CONTROLLER
        });

        if (hostileStructures.length > 0) {
            const target = creep.pos.findClosestByRange(hostileStructures);

            if (target.store && target.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                const result = creep.withdraw(target, RESOURCE_ENERGY);
                if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}});
                } else if (result === OK) {
                    creep.say('⚡ WDR');
                }
            } else {
                const result = creep.dismantle(target);
                if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}});
                } else if (result === OK) {
                    creep.say('🔨 DIS');
                }
            }
            return;
        }

        // Mission complete
        console.log(`[Demolisher] ${creep.name}: No more targets in ${targetRoom}, mission complete`);
        creep.memory.missionComplete = true;
        creep.say('✅ DONE');
    },

    runCollector: function(creep) {
        const targetRoom = creep.memory.targetRoom;
        const homeRoom = creep.memory.homeRoom;
        const partnerName = creep.memory.partnerName;

        // Find partner demolisher
        const partner = Game.creeps[partnerName];

        // Debug logging
        if (Game.time % 5 === 0) {
            console.log(`[Collector] ${creep.name}: Partner: ${partner ? 'found' : 'not found'}, Energy: ${creep.store.getUsedCapacity(RESOURCE_ENERGY)}/${creep.store.getCapacity()}`);
            if (partner) {
                console.log(`[Collector] ${creep.name}: Partner energy: ${partner.store.getUsedCapacity(RESOURCE_ENERGY)}/${partner.store.getCapacity()}, Range: ${creep.pos.getRangeTo(partner)}`);
            }
        }

        // If carrying energy, return to home to deposit
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            if (creep.room.name !== homeRoom) {
                const exitDir = Game.map.findExit(creep.room, homeRoom);
                if (exitDir !== ERR_NO_PATH) {
                    const exit = creep.pos.findClosestByRange(exitDir);
                    creep.moveTo(exit, {visualizePathStyle: {stroke: '#00ff00'}});
                }
                return;
            }

            // Deposit energy in home room
            const storage = creep.room.storage;
            const containers = creep.room.find(FIND_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            });

            let target = storage;
            if (!target || target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                target = creep.pos.findClosestByRange(containers);
            }

            if (target) {
                const result = creep.transfer(target, RESOURCE_ENERGY);
                if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#00ff00'}});
                } else if (result === OK) {
                    creep.say('💰 DEP');
                }
            }
            return;
        }

        // If partner doesn't exist, look for dropped energy
        if (!partner) {
            if (creep.room.name !== targetRoom) {
                const exitDir = Game.map.findExit(creep.room, targetRoom);
                if (exitDir !== ERR_NO_PATH) {
                    const exit = creep.pos.findClosestByRange(exitDir);
                    creep.moveTo(exit, {visualizePathStyle: {stroke: '#00ff00'}});
                }
                return;
            }

            const droppedEnergy = creep.room.find(FIND_DROPPED_RESOURCES, {
                filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
            });

            if (droppedEnergy.length > 0) {
                const target = creep.pos.findClosestByRange(droppedEnergy);
                const result = creep.pickup(target);
                if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#00ff00'}});
                } else if (result === OK) {
                    creep.say('📦 PICK');
                }
                return;
            }

            creep.say('🔍 WAIT');
            return;
        }

        // Partner exists - work with them
        // Move to partner's room first
        if (creep.room.name !== partner.room.name) {
            const exitDir = Game.map.findExit(creep.room, partner.room.name);
            if (exitDir !== ERR_NO_PATH) {
                const exit = creep.pos.findClosestByRange(exitDir);
                creep.moveTo(exit, {visualizePathStyle: {stroke: '#00ff00'}});
            }
            return;
        }

        // Now we're in the same room as partner
        const range = creep.pos.getRangeTo(partner);

        // If partner is full and we have capacity, get close for energy transfer
        if (partner.store.getFreeCapacity() === 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            if (range <= 1) {
                // Just wait next to the demolisher - it will transfer to us
                creep.say('📥 RDY');
            } else {
                // Move closer to partner for energy transfer
                creep.moveTo(partner, {visualizePathStyle: {stroke: '#00ff00'}, range: 1});
                creep.say('➡️ GET');
            }
        } else {
            // Stay close to partner but not too close
            if (range > 3) {
                creep.moveTo(partner, {visualizePathStyle: {stroke: '#00ff00'}, range: 2});
                creep.say('➡️ FOL');
            } else if (range === 0) {
                // Too close, move away slightly
                const direction = Math.floor(Math.random() * 8) + 1;
                creep.move(direction);
                creep.say('↔️ SPC');
            } else {
                creep.say('👀 WAT');
            }
        }
    }
};

module.exports = roleDemolition;


