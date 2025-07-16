/**
 * An efficient upgrader that pulls from a cached energy source.
 * It will harvest if no stored energy is available, and wait near the controller as a last resort.
 * This saves CPU and ensures the creep is always in position to work.
 */
const roleUpgrader = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // State switching logic
        if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.upgrading = false;
            creep.say('🔄 withdraw');
        }
        if (!creep.memory.upgrading && creep.store.getFreeCapacity() == 0) {
            creep.memory.upgrading = true;
            // Clear the energy target when we start upgrading
            creep.memory.energyTargetId = null;
            creep.say('⚡ upgrade');
        }

        if (creep.memory.upgrading) {
            this.upgrade(creep);
        } else {
            this.getEnergy(creep);
        }
    },

    /** @param {Creep} creep **/
    upgrade: function(creep) {
        if (creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE) {
            // Move to controller, reusing path to save CPU
            creep.moveTo(creep.room.controller, { visualizePathStyle: { stroke: '#ffffff' }, reusePath: 10 });
        }
    },

    /** @param {Creep} creep **/
    getEnergy: function(creep) {
        let target = Game.getObjectById(creep.memory.energyTargetId);

        // 1. Find a new target ONLY if the cached one is invalid or empty
        if (!target || (target.store && target.store.getUsedCapacity(RESOURCE_ENERGY) === 0)) {
            // First try to find stored energy sources
            target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                filter: (s) =>
                    (s.structureType == STRUCTURE_STORAGE ||
                     s.structureType == STRUCTURE_CONTAINER ||
                     s.structureType == STRUCTURE_LINK) &&
                    s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
            });

            if (target) {
                // Cache the new target's ID and mark as withdraw target
                creep.memory.energyTargetId = target.id;
                creep.memory.shouldHarvest = false;
            } else {
                // No stored energy found, try to find energy sources to harvest
                target = creep.pos.findClosestByPath(FIND_SOURCES, {
                    filter: (source) => source.energy > 0
                });

                if (target) {
                    // Cache the energy source ID and mark as harvest target
                    creep.memory.energyTargetId = target.id;
                    creep.memory.shouldHarvest = true;
                    creep.say('⛏️ mining');
                } else {
                    // If no energy sources are available, wait near the controller
                    if (creep.pos.getRangeTo(creep.room.controller) > 3) {
                        creep.moveTo(creep.room.controller);
                    }
                    creep.say('😴 no energy');
                    return; // No energy sources at all, do nothing else
                }
            }
        }

        // 2. Interact with the target (withdraw or harvest)
        if (creep.memory.shouldHarvest) {
            // Harvest from energy source
            if (creep.harvest(target) == ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ffaa00' }, reusePath: 10 });
            }
        } else {
            // Withdraw from storage/container/link
            if (creep.withdraw(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ffaa00' }, reusePath: 10 });
            }
        }
    }
};

module.exports = roleUpgrader;
