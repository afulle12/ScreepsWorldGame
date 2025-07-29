/**
 * An efficient upgrader that pulls from a cached energy source.
 * It will harvest if no stored energy is available, and wait near the controller as a last resort.
 * This saves CPU and ensures the creep is always in position to work.
 */
const roleUpgrader = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // 1. Cache the controller reference once
        if (!creep.memory.ctrlId) {
            creep.memory.ctrlId = creep.room.controller.id;
        }
        const ctrl = Game.getObjectById(creep.memory.ctrlId);

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
            this.upgrade(creep, ctrl);
        } else {
            this.getEnergy(creep);
        }
    },

    /** @param {Creep} creep **/
    upgrade: function(creep, ctrl) {
        if (creep.upgradeController(ctrl) == ERR_NOT_IN_RANGE) {
            // Move to controller, reusing path to save CPU
            creep.moveTo(ctrl, { visualizePathStyle: { stroke: '#ffffff' }, reusePath: 100 });
        }
    },

    /** @param {Creep} creep **/
    getEnergy: function(creep) {
        // 2. Cache the search result for 20 ticks
        if (!creep.memory.srcTick || Game.time - creep.memory.srcTick > 20) {
            let target;

            // 3. Use Room.find once and filter in JS
            const stores = creep.room.find(FIND_STRUCTURES, {
                filter: s =>
                    (s.structureType === STRUCTURE_STORAGE ||
                     s.structureType === STRUCTURE_CONTAINER ||
                     s.structureType === STRUCTURE_LINK) &&
                    s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
            });
            target = creep.pos.findClosestByPath(stores);

            if (target) {
                creep.memory.energyTargetId = target.id;
                creep.memory.shouldHarvest = false;
            } else {
                // No stored energy found, try to find energy sources to harvest
                const sources = creep.room.find(FIND_SOURCES, {
                    filter: source => source.energy > 0
                });
                target = creep.pos.findClosestByPath(sources);

                if (target) {
                    creep.memory.energyTargetId = target.id;
                    creep.memory.shouldHarvest = true;
                    creep.say('⛏️ mining');
                } else {
                    // If no energy sources are available, wait near the controller
                    const ctrl = Game.getObjectById(creep.memory.ctrlId) || creep.room.controller;
                    if (creep.pos.getRangeTo(ctrl) > 3) {
                        creep.moveTo(ctrl);
                    }
                    creep.say('😴 no energy');
                    return; // No energy sources at all, do nothing else
                }
            }
            creep.memory.srcTick = Game.time;
        }

        // Retrieve cached target
        const target = Game.getObjectById(creep.memory.energyTargetId);
        if (!target) return;

        // Interact with the target (withdraw or harvest)
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
