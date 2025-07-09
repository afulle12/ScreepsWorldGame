const DEBUG = false; // Set to false to disable console logging

const roleUpgrader = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // Check for invaders in the room
        const hostile = creep.room.find(FIND_HOSTILE_CREEPS).length > 0;

        if (hostile) {
            // Find storage building
            let storage = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                filter: (s) => s.structureType == STRUCTURE_STORAGE
            });

            // If no storage, use spawn
            if (!storage) {
                storage = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
                    filter: (s) => s.structureType == STRUCTURE_SPAWN
                });
            }

            if (storage) {
                // Stay next to the storage/spawn
                if (creep.pos.getRangeTo(storage) > 1) {
                    // OPTIMIZATION: Reuse path to save CPU
                    creep.moveTo(storage, { visualizePathStyle: { stroke: '#ff0000' }, reusePath: 5 });
                } else {
                    creep.say('⏸️ invader');
                }
            } else {
                creep.say('🚨 invader');
            }
            return; // Do nothing else while invader is present
        }

        // State switching: Preserve targetId to remember last source
        if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.upgrading = false;
            creep.say('🔄 withdraw');
            if (DEBUG) console.log(`Upgrader ${creep.name}: Switching to withdraw mode`);
        }
        if (!creep.memory.upgrading && creep.store.getFreeCapacity() == 0) {
            creep.memory.upgrading = true;
            // TargetId is for an energy source, so it's irrelevant for upgrading,
            // but we preserve it for the next withdraw cycle.
            creep.say('⚡ upgrade');
            if (DEBUG) console.log(`Upgrader ${creep.name}: Switching to upgrade mode`);
        }

        // If in upgrading state
        if (creep.memory.upgrading) {
            if (DEBUG) console.log(`Upgrader ${creep.name}: Upgrading controller`);
            if (creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                // OPTIMIZATION: Reuse path to save CPU
                creep.moveTo(creep.room.controller, { visualizePathStyle: false, reusePath: 5 });
            }
        }
        // If in withdrawing state
        else {
            // Reset target every 100 ticks to find a potentially closer source
            if (creep.memory.searchCooldown === undefined) {
                creep.memory.searchCooldown = Game.time;
            }
            if (Game.time - creep.memory.searchCooldown >= 20) {
                creep.memory.targetId = null;
                creep.memory.waitStart = undefined; // Also reset waiting state
                creep.memory.searchCooldown = Game.time;
                if (DEBUG) console.log(`Upgrader ${creep.name}: 100-tick reset. Searching for new source.`);
            }

            let target = Game.getObjectById(creep.memory.targetId);

            // If the stored target is empty, wait for it to be refilled.
            if (target && target.store && target.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                // Initialize wait timer if it doesn't exist
                if (creep.memory.waitStart === undefined) {
                    creep.memory.waitStart = Game.time;
                    if (DEBUG) console.log(`Upgrader ${creep.name}: Source ${target.id} is empty. Waiting.`);
                }

                // Check if 21 ticks have passed
                if (Game.time - creep.memory.waitStart < 21) {
                    creep.say('⏳ Waiting');
                    return; // Stay put and wait for the next tick.
                } else {
                    // Wait time is over, forget the target and find a new one.
                    if (DEBUG) console.log(`Upgrader ${creep.name}: Wait timeout. Finding new source.`);
                    creep.memory.targetId = null;
                    creep.memory.waitStart = undefined;
                    target = null; // Ensure the find logic below runs
                }
            }

            // If the target is valid and has energy, we are no longer waiting.
            if (target && target.store && target.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                creep.memory.waitStart = undefined;
            }

            // Find a new target if one is needed (due to reset, timeout, or initialization)
            if (!target) {
                if (DEBUG) console.log(`Upgrader ${creep.name}: Finding new energy source by distance.`);

                // Find the closest structure with energy (Link, Storage, or Container)
                let newTarget = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                    filter: (s) =>
                        (s.structureType == STRUCTURE_LINK ||
                         s.structureType == STRUCTURE_STORAGE ||
                         s.structureType == STRUCTURE_CONTAINER) &&
                        s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                });

                if (newTarget) {
                    creep.memory.targetId = newTarget.id;
                    target = newTarget;
                    if (DEBUG) console.log(`Upgrader ${creep.name}: New target set to ${target.structureType} (${target.id})`);
                }
                // Fallback to harvesting if no stored energy is available
                else {
                    let source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
                    if (source) {
                        creep.say('⛏️ mining');
                        if (creep.harvest(source) == ERR_NOT_IN_RANGE) {
                            // OPTIMIZATION: Reuse path to save CPU
                            creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' }, reusePath: 5 });
                        }
                    }
                    return; // Exit early since we are harvesting, not withdrawing
                }
            }

            // Execute withdraw action if we have a valid target
            if (target) {
                if (creep.withdraw(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                    // OPTIMIZATION: Reuse path to save CPU
                    creep.moveTo(target, { visualizePathStyle: { stroke: '#ffaa00' }, reusePath: 5 });
                }
            } else {
                if (DEBUG) console.log(`Upgrader ${creep.name}: No energy sources available.`);
            }
        }
    }
};

module.exports = roleUpgrader;
