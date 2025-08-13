/**

* An efficient upgrader that pulls from a cached energy source.
* Fixed version with proper object handling and additional safety checks.
 */
const roleUpgrader = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // Cache controller reference for multiple ticks
        if (!creep.memory.ctrlTick || Game.time - creep.memory.ctrlTick > 5) {
            // Added safety check for controller existence
            if (creep.room.controller) {
                creep.memory.ctrlId = creep.room.controller.id;
                creep.memory.ctrlTick = Game.time;
            } else {
                // No controller in room - clear memory and return
                creep.memory.ctrlId = null;
                creep.memory.ctrlTick = null;
                return;
            }
        }

        const ctrl = creep.memory.ctrlId ? Game.getObjectById(creep.memory.ctrlId) : null;
        if (!ctrl) return;

        // State switching logic
        if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.upgrading = false;
            creep.say('🔄 withdraw');
        }
        if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) {
            creep.memory.upgrading = true;
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
        if (!ctrl) {
            creep.memory.ctrlTick = 0; // Force controller refresh
            return;
        }

        if (creep.upgradeController(ctrl) === ERR_NOT_IN_RANGE) {
            creep.moveTo(ctrl, { 
                visualizePathStyle: { stroke: '#ffffff' }, 
                reusePath: 200,
                // Added range parameter to prevent overshooting
                range: 1
            });
        }
    },

    /** @param {Creep} creep **/
    getEnergy: function(creep) {
        // Cache energy target search for 20 ticks
        if (!creep.memory.srcTick || Game.time - creep.memory.srcTick > 20) {
            let target = null;

            // Use direct property access instead of method call
            const stores = creep.room.find(FIND_STRUCTURES, {
                filter: s =>
                    (s.structureType === STRUCTURE_STORAGE ||
                     s.structureType === STRUCTURE_CONTAINER ||
                     s.structureType === STRUCTURE_LINK) &&
                    s.store && s.store[RESOURCE_ENERGY] > 0
            });

            // First find closest by range
            const closestByRange = creep.pos.findClosestByRange(stores);

            if (closestByRange) {
                // CORRECTED: findClosestByPath returns single object, not array
                target = creep.pos.findClosestByPath([closestByRange]);
                if (target) {
                    creep.memory.energyTargetId = target.id;
                    creep.memory.shouldHarvest = false;
                } else {
                    // No path found to storage
                    creep.memory.srcTick = 0;
                    return;
                }
            } else {
                // No stored energy found, try energy sources
                const sources = creep.room.find(FIND_SOURCES, {
                    filter: source => source.energy > 0
                });

                // First find closest by range
                const sourceByRange = creep.pos.findClosestByRange(sources);

                if (sourceByRange) {
                    // CORRECTED: findClosestByPath returns single object, not array
                    target = creep.pos.findClosestByPath([sourceByRange]);
                    if (target) {
                        creep.memory.energyTargetId = target.id;
                        creep.memory.shouldHarvest = true;
                        creep.say('⛏️ mining');
                    } else {
                        // No path found to source
                        creep.memory.srcTick = 0;
                        return;
                    }
                } else {
                    // Wait near controller with path caching
                    const ctrl = creep.memory.ctrlId ? 
                                 Game.getObjectById(creep.memory.ctrlId) : 
                                 creep.room.controller;

                    if (ctrl && creep.pos.getRangeTo(ctrl) > 3) {
                        creep.moveTo(ctrl, { reusePath: 5, range: 3 });
                    }
                    creep.say('😴 no energy');
                    return;
                }
            }
            creep.memory.srcTick = Game.time;
        }

        // Retrieve cached target with safety check
        const target = creep.memory.energyTargetId ? 
                      Game.getObjectById(creep.memory.energyTargetId) : 
                      null;

        if (!target) {
            creep.memory.srcTick = 0; // Force refresh
            return;
        }

        // Early exit if target no longer has energy
        if ((creep.memory.shouldHarvest && (!target || target.energy === 0)) || 
            (!creep.memory.shouldHarvest && (!target.store || target.store[RESOURCE_ENERGY] === 0))) {
            creep.memory.srcTick = 0; // Force refresh
            return;
        }

        // Interact with target
        if (creep.memory.shouldHarvest) {
            const harvestResult = creep.harvest(target);
            if (harvestResult === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { 
                    visualizePathStyle: { stroke: '#ffaa00' }, 
                    reusePath: 20,
                    range: 1
                });
            } else if (harvestResult < 0) {
                // Handle other errors
                creep.memory.srcTick = 0;
            }
        } else {
            const withdrawResult = creep.withdraw(target, RESOURCE_ENERGY);
            if (withdrawResult === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { 
                    visualizePathStyle: { stroke: '#ffaa00' }, 
                    reusePath: 20,
                    range: 1
                });
            } else if (withdrawResult < 0) {
                // Handle other errors
                creep.memory.srcTick = 0;
            }
        }
    }
};

module.exports = roleUpgrader;
