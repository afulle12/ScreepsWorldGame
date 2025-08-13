const DEBUG = false; // Set to false to disable console logging

// Global cache for room data
global.roomCache = global.roomCache || {};

const roleHarvester = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // Initialize room cache if needed
        this.initializeRoomCache(creep.room);

        // Assign a source if the creep doesn't have one
        if (!creep.memory.sourceId) {
            if (DEBUG) console.log(`Harvester ${creep.name}: No source assigned, finding one.`);
            this.assignBalancedSource(creep);
        }

        // State switching logic
        if (creep.memory.depositing && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.depositing = false;
            creep.memory.targetId = null; // Clear deposit target
            delete creep.memory.lastSearchTick; // Clear search timer when switching to harvest
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

    /** Initialize and manage global room cache **/
    initializeRoomCache: function(room) {
        const roomName = room.name;

        if (!global.roomCache[roomName]) {
            global.roomCache[roomName] = {
                lastUpdate: 0,
                sources: [],
                depositTargets: [],
                sourceAssignments: {}
            };
        }

        const cache = global.roomCache[roomName];

        // Refresh cache every 10 ticks
        if (Game.time - cache.lastUpdate >= 10) {
            cache.sources = room.find(FIND_SOURCES);
            cache.depositTargets = this.findAllDepositTargets(room);
            cache.lastUpdate = Game.time;

            if (DEBUG) console.log(`Room ${roomName}: Cache refreshed with ${cache.depositTargets.length} deposit targets`);
        }
    },

    /** Find all deposit targets in a single operation with priority sorting **/
    findAllDepositTargets: function(room) {
        const allTargets = room.find(FIND_STRUCTURES, {
            filter: s => {
                const hasCapacity = s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                return hasCapacity && (
                    s.structureType === STRUCTURE_LINK ||
                    s.structureType === STRUCTURE_STORAGE ||
                    s.structureType === STRUCTURE_CONTAINER ||
                    s.structureType === STRUCTURE_EXTENSION ||
                    s.structureType === STRUCTURE_SPAWN
                );
            }
        });

        // Sort by priority: Links > Storage/Containers > Spawns/Extensions
        return allTargets.sort((a, b) => {
            const getPriority = (structure) => {
                switch (structure.structureType) {
                    case STRUCTURE_LINK: return 1;
                    case STRUCTURE_STORAGE:
                    case STRUCTURE_CONTAINER: return 2;
                    case STRUCTURE_SPAWN:
                    case STRUCTURE_EXTENSION: return 3;
                    default: return 4;
                }
            };
            return getPriority(a) - getPriority(b);
        });
    },

    /** ENHANCED: Uses incremental source assignment caching **/
    assignBalancedSource: function(creep) {
        const roomName = creep.room.name;
        const cache = global.roomCache[roomName];

        if (!cache || cache.sources.length === 0) return;

        // Initialize source assignments if not present
        if (!Memory.sourceAssignments) {
            Memory.sourceAssignments = {};
        }
        if (!Memory.sourceAssignments[roomName]) {
            Memory.sourceAssignments[roomName] = {};
            // Initialize all sources with 0 count
            cache.sources.forEach(source => {
                Memory.sourceAssignments[roomName][source.id] = 0;
            });
        }

        const assignments = Memory.sourceAssignments[roomName];

        // Find the source with minimum assignments
        let minCount = Infinity;
        let bestSourceId = null;

        for (const sourceId in assignments) {
            if (assignments[sourceId] < minCount) {
                minCount = assignments[sourceId];
                bestSourceId = sourceId;
            }
        }

        if (bestSourceId) {
            creep.memory.sourceId = bestSourceId;
            // Increment assignment count
            assignments[bestSourceId]++;

            if (DEBUG) console.log(`Harvester ${creep.name}: Assigned to source ${bestSourceId.slice(-6)} (${minCount + 1} harvesters).`);
        }
    },

    /** Harvests energy with regeneration-aware waiting; only idles when parked by the source */
    harvestEnergy: function(creep) {
        const source = Game.getObjectById(creep.memory.sourceId);
        if (!source) {
            if (DEBUG) console.log(`Harvester ${creep.name}: Source ${creep.memory.sourceId} invalid, reassigning.`);
            // Decrement assignment count for invalid source
            this.decrementSourceAssignment(creep);
            delete creep.memory.sourceId;
            return;
        }

        // If we have a wait window, only keep waiting while the source is still empty and time hasn't passed
        if (creep.memory.waitUntil) {
            if (source.energy > 0 || Game.time >= creep.memory.waitUntil) {
                delete creep.memory.waitUntil;
            } else {
                // Honor the wait window and just park at the source
                if (!creep.pos.isNearTo(source)) {
                    creep.moveTo(source, { range: 1, reusePath: 50, visualizePathStyle: false });
                } else {
                    if (DEBUG) creep.say(`⏳${creep.memory.waitUntil - Game.time}`);
                }
                return;
            }
        }

        // If the source is empty now, compute a wake-up tick and park next to it
        if (source.energy === 0) {
            const ttr = typeof source.ticksToRegeneration === 'number' ? source.ticksToRegeneration : 10;
            creep.memory.waitUntil = Game.time + Math.max(1, ttr - 1); // wake 1 tick early
            if (!creep.pos.isNearTo(source)) {
                creep.moveTo(source, { range: 1, reusePath: 50, visualizePathStyle: false });
            } else {
                if (DEBUG) creep.say(`⏳${creep.memory.waitUntil - Game.time}`);
            }
            return;
        }

        // Source has energy and we're not in a wait window → harvest
        if (creep.pos.isNearTo(source)) {
            creep.harvest(source);
        } else {
            creep.moveTo(source, { range: 1, reusePath: 12, visualizePathStyle: false });
        }
    },

    /** Helper function to decrement source assignment count **/
    decrementSourceAssignment: function(creep) {
        const roomName = creep.room.name;
        if (Memory.sourceAssignments && 
            Memory.sourceAssignments[roomName] && 
            creep.memory.sourceId &&
            Memory.sourceAssignments[roomName][creep.memory.sourceId] > 0) {
            Memory.sourceAssignments[roomName][creep.memory.sourceId]--;
        }
    },

    /**
     * ENHANCED: Deposits energy with priority to nearby storage, no wandering when full.
     * If unable to deposit, parks at the source and idles there.
     * @param {Creep} creep
     */
    depositEnergy: function(creep) {
        // First check if there's a nearby container/link within 1 range
        const nearbyStorage = creep.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: s => (s.structureType === STRUCTURE_CONTAINER || 
                         s.structureType === STRUCTURE_LINK) &&
                         s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });

        // If there's nearby storage with capacity, use it immediately
        if (nearbyStorage.length > 0) {
            const target = nearbyStorage[0];
            // Single-intent-per-tick: check range first, then transfer or move
            if (creep.pos.isNearTo(target)) {
                creep.transfer(target, RESOURCE_ENERGY);
            } else {
                creep.moveTo(target, { 
                    visualizePathStyle: false, 
                    reusePath: 12 
                });
            }
            return;
        }

        // If nearby storage is full, do not idle here — park at the source instead
        const nearbyFullStorage = creep.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: s => (s.structureType === STRUCTURE_CONTAINER || 
                         s.structureType === STRUCTURE_LINK) &&
                         s.store.getFreeCapacity(RESOURCE_ENERGY) === 0
        });

        if (nearbyFullStorage.length > 0) {
            const source = Game.getObjectById(creep.memory.sourceId);
            if (source) {
                if (!creep.pos.isNearTo(source)) {
                    creep.moveTo(source, { range: 1, reusePath: 50, visualizePathStyle: false });
                } else {
                    creep.say('Idle');
                }
            } else {
                creep.say('Idle');
            }
            return; // Don't search for other targets; just wait by the source
        }

        // Only if there's no nearby container/link at all, then use the existing logic
        const roomName = creep.room.name;
        const cache = global.roomCache[roomName];
        let target = Game.getObjectById(creep.memory.targetId);
        let shouldSearch = false;

        // Condition 1: The cached target is invalid (doesn't exist or is full).
        if (!target || target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            shouldSearch = true;
            if (DEBUG && target) console.log(`Harvester ${creep.name}: Target is full, forcing a new search.`);
        }

        // Condition 2: Extended periodic refresh (every 10 ticks for better caching)
        if (!creep.memory.lastSearchTick || (Game.time - creep.memory.lastSearchTick) >= 10) {
            shouldSearch = true;
        }

        // --- Perform the search using cached targets ---
        if (shouldSearch) {
            if (DEBUG) console.log(`Harvester ${creep.name}: Searching for a new deposit target.`);

            let newTarget = null;
            const source = Game.getObjectById(creep.memory.sourceId);

            // Use cached deposit targets instead of repeated finds
            const availableTargets = cache.depositTargets.filter(structure => {
                const obj = Game.getObjectById(structure.id);
                return obj && obj.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
            });

            if (availableTargets.length > 0) {
                // Priority 1: Links within 3 squares of the assigned source
                if (source) {
                    const nearbyLinks = availableTargets.filter(structure => {
                        const obj = Game.getObjectById(structure.id);
                        return obj && 
                               obj.structureType === STRUCTURE_LINK && 
                               source.pos.getRangeTo(obj) <= 3;
                    });

                    if (nearbyLinks.length > 0) {
                        // Avoid findClosestByPath: use findClosestByRange
                        const objs = nearbyLinks.map(s => Game.getObjectById(s.id)).filter(Boolean);
                        newTarget = creep.pos.findClosestByRange(objs);
                    }
                }

                // If no nearby link found, use the pre-sorted cached targets
                if (!newTarget) {
                    const validTargets = availableTargets.map(s => Game.getObjectById(s.id)).filter(Boolean);
                    // Avoid findClosestByPath: use findClosestByRange
                    newTarget = creep.pos.findClosestByRange(validTargets);
                }
            }

            // Update search timing - extend to 10 ticks when no target found (idle optimization)
            creep.memory.lastSearchTick = Game.time;

            if (newTarget) {
                creep.memory.targetId = newTarget.id;
                target = newTarget;
                if (DEBUG) console.log(`Harvester ${creep.name}: New target set to ${target.structureType} (${target.id})`);
            } else {
                // If no target was found, clear the old one
                delete creep.memory.targetId;
            }
        }

        // --- Act based on the final target (either cached or newly found) ---
        if (target) {
            // Single-intent-per-tick: check range first, then transfer or move
            if (creep.pos.isNearTo(target)) {
                creep.transfer(target, RESOURCE_ENERGY);
            } else {
                // OPTIMIZATION: Increased reusePath for more stable pathing
                creep.moveTo(target, { 
                    visualizePathStyle: false, 
                    reusePath: 12 
                });
            }
        } else {
            // Park at the source and idle there (as requested)
            const source = Game.getObjectById(creep.memory.sourceId);
            if (source) {
                if (!creep.pos.isNearTo(source)) {
                    creep.moveTo(source, { range: 1, reusePath: 50, visualizePathStyle: false });
                } else {
                    creep.say('Idle');
                }
            } else {
                if (DEBUG) console.log(`Harvester ${creep.name}: No deposit targets and no source; resting.`);
                creep.say('Idle');
            }
        }
    }
};

// Clean up source assignments when creeps die
const originalCreepDie = Creep.prototype.suicide;
Creep.prototype.suicide = function() {
    if (this.memory.role === 'harvester' && this.memory.sourceId) {
        const roomName = this.room.name;
        if (Memory.sourceAssignments && 
            Memory.sourceAssignments[roomName] && 
            Memory.sourceAssignments[roomName][this.memory.sourceId] > 0) {
            Memory.sourceAssignments[roomName][this.memory.sourceId]--;
        }
    }
    return originalCreepDie.call(this);
};

module.exports = roleHarvester;
