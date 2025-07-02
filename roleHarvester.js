const DEBUG = false; // Set to false to disable console logging

const roleHarvester = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // Assign a source if the creep doesn't have one
        if (!creep.memory.sourceId) {
            if (DEBUG) console.log(`Harvester ${creep.name}: No source assigned, finding one.`);
            this.assignBalancedSource(creep);
        }

        // State switching logic
        if (creep.memory.depositing && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.depositing = false;
            creep.memory.targetId = null; // Clear deposit target
            if (DEBUG) console.log(`Harvester ${creep.name}: Switching to harvest mode.`);
        }
        if (!creep.memory.depositing && creep.store.getFreeCapacity() === 0) {
            creep.memory.depositing = true;
            if (DEBUG) console.log(`Harvester ${creep.name}: Switching to deposit mode.`);
        }

        // Execute actions based on state
        if (creep.memory.depositing) {
            this.depositEnergy(creep);
        } else {
            this.harvestEnergy(creep);
        }
    },

    /** OPTIMIZED: Assigns a source by counting assignments in a single pass. **/
    assignBalancedSource: function(creep) {
        const sources = creep.room.find(FIND_SOURCES);
        if (sources.length === 0) return;

        // Create a count for each source, initialized to 0
        const sourceCounts = sources.reduce((acc, s) => {
            acc[s.id] = 0;
            return acc;
        }, {});

        // Count existing assignments in a single loop over all creeps
        for (const name in Game.creeps) {
            const c = Game.creeps[name];
            if (c.memory.role === 'harvester' && c.memory.sourceId && sourceCounts.hasOwnProperty(c.memory.sourceId)) {
                sourceCounts[c.memory.sourceId]++;
            }
        }

        // Find the source with the minimum number of assigned harvesters
        let minCount = Infinity;
        let bestSourceId = null;
        for (const sourceId in sourceCounts) {
            if (sourceCounts[sourceId] < minCount) {
                minCount = sourceCounts[sourceId];
                bestSourceId = sourceId;
            }
        }

        if (bestSourceId) {
            creep.memory.sourceId = bestSourceId;
            if (DEBUG) console.log(`Harvester ${creep.name}: Assigned to source ${bestSourceId.slice(-6)} (${minCount} harvesters).`);
        }
    },

    /** OPTIMIZED: Harvests energy, using reusePath. **/
    harvestEnergy: function(creep) {
        const source = Game.getObjectById(creep.memory.sourceId);
        if (!source) {
            if (DEBUG) console.log(`Harvester ${creep.name}: Source ${creep.memory.sourceId} invalid, reassigning.`);
            delete creep.memory.sourceId; // Clear invalid source and let it re-assign next tick
            return;
        }

        // If the source is empty, don't move, just wait.
        if (source.energy === 0) {
            creep.say('⏳ waiting');
            return;
        }

        const harvestResult = creep.harvest(source);
        if (harvestResult === ERR_NOT_IN_RANGE) {
            // OPTIMIZATION: Reuse path to save CPU
            creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' }, reusePath: 5 });
        }
    },

    /** OPTIMIZED: Deposits energy using a cached target. **/
    depositEnergy: function(creep) {
        // OPTIMIZATION: Use a cached target ID
        let target = Game.getObjectById(creep.memory.targetId);

        // Find a new target only if the cached one is invalid or full
        if (!target || target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            if (DEBUG) console.log(`Harvester ${creep.name}: Finding new deposit target.`);

            // Priority 1: Storage or Containers
            let newTarget = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) &&
                             s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            });

            // Priority 2: Spawns or Extensions (if no storage/containers)
            if (!newTarget) {
                newTarget = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                    filter: s => (s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN) &&
                                 s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                });
            }

            if (newTarget) {
                creep.memory.targetId = newTarget.id;
                target = newTarget;
                if (DEBUG) console.log(`Harvester ${creep.name}: New target set to ${target.structureType} (${target.id})`);
            }
        }

        // If we have a valid target, transfer energy
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                // OPTIMIZATION: Reuse path to save CPU
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' }, reusePath: 5 });
            }
        } else {
            // If no targets, move to a resting position (e.g., near spawn) to avoid blocking paths
            if (DEBUG) console.log(`Harvester ${creep.name}: No deposit targets, resting.`);
            const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
            if (spawn) {
                creep.moveTo(spawn, { visualizePathStyle: { stroke: '#ffffff' }, reusePath: 5 });
            }
        }
    }
};

module.exports = roleHarvester;
