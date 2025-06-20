const DEBUG = false; // Set to false to disable console logging

const roleUpgrader = {
    run: function(creep) {
        // Check for invaders in the room
        const hostile = creep.room.find(FIND_HOSTILE_CREEPS).length > 0;

        if (hostile) {
            // Find storage building
            let storage = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                filter: (structure) =>
                    structure.structureType == STRUCTURE_STORAGE
            });

            // If no storage, use spawn
            if (!storage) {
                storage = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
                    filter: (structure) =>
                        structure.structureType == STRUCTURE_SPAWN
                });
            }

            if (storage) {
                // Stay next to the storage/spawn
                if (creep.pos.getRangeTo(storage) > 1) {
                    creep.moveTo(storage, {visualizePathStyle: {stroke: '#ff0000'}});
                } else {
                    creep.say('⏸️ invader');
                }
            } else {
                // Nowhere to hide, just stop
                creep.say('🚨 invader');
            }
            return; // Do nothing else while invader is present
        }

        // Toggle between withdrawing and upgrading
        if(creep.memory.upgrading && creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.upgrading = false;
            creep.say('🔄 withdraw');
            if (DEBUG) console.log(`Upgrader ${creep.name}: Switching to withdraw mode - out of energy`);
        }
        if(!creep.memory.upgrading && creep.store.getFreeCapacity() == 0) {
            creep.memory.upgrading = true;
            creep.say('⚡ upgrade');
            if (DEBUG) console.log(`Upgrader ${creep.name}: Switching to upgrade mode - energy full`);
        }

        // Upgrading controller
        if(creep.memory.upgrading) {
            if (DEBUG) console.log(`Upgrader ${creep.name}: Upgrading controller`);
            if(creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}});
            }
        }
        // Withdrawing energy - prioritize controller link first
        else {
            let target = null;

            // First priority: Link closest to controller with energy
            if (creep.room.controller) {
                const links = creep.room.find(FIND_MY_STRUCTURES, {
                    filter: { structureType: STRUCTURE_LINK }
                });

                if (links.length > 0) {
                    const controllerLink = creep.room.controller.pos.findClosestByRange(links);
                    if (controllerLink && controllerLink.store[RESOURCE_ENERGY] > 0) {
                        target = controllerLink;
                        if (DEBUG) console.log(`Upgrader ${creep.name}: Using controller link for energy (${controllerLink.store[RESOURCE_ENERGY]} energy available)`);
                    }
                }
            }

            // Second priority: Storage or containers if no link energy available
            if (!target) {
                target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                    filter: (structure) => 
                        (structure.structureType == STRUCTURE_STORAGE || 
                         structure.structureType == STRUCTURE_CONTAINER) &&
                        structure.store[RESOURCE_ENERGY] > 0
                });

                if (target) {
                    if (DEBUG) console.log(`Upgrader ${creep.name}: Using ${target.structureType} for energy (${target.store[RESOURCE_ENERGY]} energy available)`);
                }
            }

            // Third priority: Mine energy sources if no stored energy available
            if (!target) {
                target = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);

                if (target) {
                    if (DEBUG) console.log(`Upgrader ${creep.name}: No stored energy available, mining from source`);
                    creep.say('⛏️ mining');
                    if(creep.harvest(target) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                    }
                    return; // Exit early since we're mining, not withdrawing
                }
            }

            // Execute withdraw action if we found a target
            if(target) {
                if(creep.withdraw(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
                }
            } else {
                if (DEBUG) console.log(`Upgrader ${creep.name}: No energy sources available`);
            }
        }
    }
};

module.exports = roleUpgrader;
