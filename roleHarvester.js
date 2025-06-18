const DEBUG = false; // Set to false to disable console logging

const roleHarvester = {
    run: function(creep) {
        if(!creep.memory.sourceId) {
            if (DEBUG) console.log(`Harvester ${creep.name}: No source assigned, finding balanced source`);
            this.assignBalancedSource(creep);
        }

        if(creep.memory.depositing && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.depositing = false;
            creep.memory.travelingToNewSource = false;
            if (DEBUG) console.log(`Harvester ${creep.name}: Switching to harvest mode - out of energy`);
        }
        if(!creep.memory.depositing && creep.store.getFreeCapacity() === 0) {
            creep.memory.depositing = true;
            if (DEBUG) console.log(`Harvester ${creep.name}: Switching to deposit mode - energy full`);
        }

        if(creep.memory.depositing) {
            this.depositEnergy(creep);
        } else {
            this.harvestEnergy(creep);
        }
    },

    assignBalancedSource: function(creep) {
        const sources = creep.room.find(FIND_SOURCES);

        // For each source, count how many harvesters are assigned to it
        const sourceCounts = sources.map(source => {
            const harvesters = _.filter(Game.creeps, c =>
                c.memory.role === 'harvester' &&
                c.memory.sourceId === source.id &&
                c.name !== creep.name // Exclude self in case of reassignment
            ).length;
            return { source, count: harvesters };
        });

        // Find the minimum count
        const minCount = Math.min(...sourceCounts.map(s => s.count));
        // Filter sources with the minimum count
        const leastAssignedSources = sourceCounts.filter(s => s.count === minCount);

        // Pick one of the least assigned sources (random if tie)
        if (leastAssignedSources.length > 0) {
            const pick = leastAssignedSources[Math.floor(Math.random() * leastAssignedSources.length)];
            creep.memory.sourceId = pick.source.id;
            if (DEBUG) console.log(`Harvester ${creep.name}: Assigned to source ${pick.source.id.slice(-6)} (${pick.count} harvesters assigned)`);
        } else {
            if (DEBUG) console.log(`Harvester ${creep.name}: No sources available for assignment`);
        }
    },

    filterAvailableSources: function(creep, sources) {
        return sources.filter(source => {
            let freeSpots = 0;
            const terrain = new Room.Terrain(source.room.name);

            for(let dx = -1; dx <= 1; dx++) {
                for(let dy = -1; dy <= 1; dy++) {
                    if(dx === 0 && dy === 0) continue;
                    const x = source.pos.x + dx;
                    const y = source.pos.y + dy;
                    if(x >= 0 && x < 50 && y >= 0 && y < 50) {
                        if(terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                            freeSpots++;
                        }
                    }
                }
            }

            const harvestersAtSource = _.filter(Game.creeps, c => 
                c.memory.role === 'harvester' && 
                c.memory.sourceId === source.id && 
                !c.memory.depositing
            ).length;

            return harvestersAtSource < freeSpots;
        });
    },

    harvestEnergy: function(creep) {
        const source = Game.getObjectById(creep.memory.sourceId);
        if(!source) {
            if (DEBUG) console.log(`Harvester ${creep.name}: Source ${creep.memory.sourceId} no longer exists, reassigning`);
            creep.memory.travelingToNewSource = false;
            this.assignBalancedSource(creep);
            return;
        }
        if(creep.memory.travelingToNewSource && creep.pos.inRangeTo(source, 1)) {
            creep.memory.travelingToNewSource = false;
            if (DEBUG) console.log(`Harvester ${creep.name}: Reached new source, ready to harvest`);
        }
        if(source.energy === 0) {
            creep.say('⏳ waiting');
            if(!creep.pos.inRangeTo(source, 1)) {
                creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
            return;
        }
        if(creep.harvest(source) === ERR_NOT_IN_RANGE) {
            creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
    },

    depositEnergy: function(creep) {
        // Include both storage and containers
        const depositTargets = creep.room.find(FIND_STRUCTURES, {
            filter: structure => 
                (structure.structureType === STRUCTURE_STORAGE ||
                 structure.structureType === STRUCTURE_CONTAINER) &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });

        if(depositTargets.length > 0) {
            const closest = creep.pos.findClosestByRange(depositTargets);
            if(closest) {
                if (DEBUG) console.log(`Harvester ${creep.name}: Depositing to ${closest.structureType} at ${closest.pos}`);
                if(creep.transfer(closest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(closest, {visualizePathStyle: {stroke: '#ffffff'}});
                }
                return;
            }
        }

        // Fall back: extensions or spawns
        const targets = creep.room.find(FIND_STRUCTURES, {
            filter: structure =>
                (structure.structureType === STRUCTURE_EXTENSION ||
                 structure.structureType === STRUCTURE_SPAWN) &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });

        if(targets.length > 0) {
            const target = creep.pos.findClosestByPath(targets);
            if(target) {
                if (DEBUG) console.log(`Harvester ${creep.name}: No storage/containers available, depositing to ${target.structureType}`);
                if(creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
                }
            }
        } else {
            if (DEBUG) console.log(`Harvester ${creep.name}: No deposit targets available, moving to spawn`);
            const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
            if(spawn) {
                creep.moveTo(spawn, {visualizePathStyle: {stroke: '#ffffff'}});
            }
        }
    }
};

module.exports = roleHarvester;
