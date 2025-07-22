// roleThief.js
// orderThieves('W1N1', 'W2N1', 3)
// cancelThiefOrder('W2N1')

const DEBUG = false; // Set to false to disable debug logging

const roleThief = {
    /** @param {Creep} creep **/
    run: function(creep) {
        // --- State Transition Logic ---
        if (creep.memory.stealing && creep.store.getFreeCapacity() === 0) {
            creep.memory.stealing = false;
            delete creep.memory.theftTarget; // Reset target on state change
            creep.say('💰 returning');
        }
        if (!creep.memory.stealing && creep.store.getUsedCapacity() === 0) {
            creep.memory.stealing = true;
            delete creep.memory.depositTarget; // Reset deposit target
            creep.say('🏃‍♂️ stealing');
        }

        // --- Action Logic ---
        if (creep.memory.stealing) {
            // --- STEALING PHASE ---
            const targetRoomName = creep.memory.targetRoom;
            if (creep.room.name !== targetRoomName) {
                // Move to target room (optimized with ByRange for exits)
                const exitDir = creep.room.findExitTo(targetRoomName);
                if (exitDir > 0) { // Valid direction
                    const exitPos = creep.pos.findClosestByRange(exitDir);
                    if (exitPos) {
                        creep.moveTo(exitPos, { visualizePathStyle: false });
                    }
                }
            } else {
                // In target room: Steal resources
                let target = creep.memory.theftTarget ? Game.getObjectById(creep.memory.theftTarget) : null;

                // Helper function to check if structure has resources - FIXED
                const hasResources = (s) => {
                    // Check store property first
                    if (s.store && s.store.getUsedCapacity() > 0) {
                        return true;
                    }
                    // Also check old energy property (for extensions, spawns, towers)
                    if (s.energy !== undefined && s.energy > 0) {
                        return true;
                    }
                    return false;
                };

                // Find new target only if none or invalid/empty
                if (!target || !hasResources(target)) {
                    delete creep.memory.theftTarget;

                    // First, find all structures with resources
                    const allStructures = creep.room.find(FIND_STRUCTURES, {
                        filter: (s) => [
                            STRUCTURE_EXTENSION,
                            //STRUCTURE_SPAWN,
                            STRUCTURE_TOWER,
                            STRUCTURE_STORAGE,
                            STRUCTURE_CONTAINER,
                            STRUCTURE_LAB,
                            STRUCTURE_TERMINAL,
                            STRUCTURE_LINK
                        ].includes(s.structureType) && hasResources(s)
                    });

                    if (DEBUG) {
                        console.log(`Thief ${creep.name} found ${allStructures.length} structures with resources`);
                        // Break down by structure type
                        const structureBreakdown = {};
                        allStructures.forEach(s => {
                            structureBreakdown[s.structureType] = (structureBreakdown[s.structureType] || 0) + 1;
                        });
                        console.log(`Structure breakdown:`, JSON.stringify(structureBreakdown));
                    }

                    // Filter out your own structures (if any)
                    const enemyStructures = allStructures.filter(s => {
                        const isOwned = s.my;
                        if (DEBUG && isOwned) console.log(`Filtering out owned ${s.structureType} at ${s.pos}`);
                        return !isOwned;
                    });
                    if (DEBUG) console.log(`After ownership filter: ${enemyStructures.length} enemy structures`);

                    // Filter out structures behind enemy ramparts
                    const potentialTargets = enemyStructures.filter(s => {
                        const structuresAtPos = creep.room.lookForAt(LOOK_STRUCTURES, s.pos);
                        const hasEnemyRampart = structuresAtPos.some(struct => 
                            struct.structureType === STRUCTURE_RAMPART && !struct.my
                        );
                        if (DEBUG && hasEnemyRampart) console.log(`Filtering out rampart-protected ${s.structureType} at ${s.pos}`);
                        return !hasEnemyRampart;
                    });

                    if (DEBUG) {
                        console.log(`After rampart filter: ${potentialTargets.length} accessible targets`);
                        // Show what we have left
                        const finalBreakdown = {};
                        potentialTargets.forEach(s => {
                            finalBreakdown[s.structureType] = (finalBreakdown[s.structureType] || 0) + 1;
                        });
                        console.log(`Final targets breakdown:`, JSON.stringify(finalBreakdown));
                    }

                    if (potentialTargets.length) {
                        // Sort by accessibility and resource amount
                        potentialTargets.sort((a, b) => {
                            const aPath = PathFinder.search(creep.pos, a.pos).incomplete;
                            const bPath = PathFinder.search(creep.pos, b.pos).incomplete;
                            if (aPath !== bPath) return aPath - bPath; // Prefer complete paths

                            // Get resource amounts using both old and new properties
                            const aResources = (a.store ? a.store.getUsedCapacity() : 0) + (a.energy || 0);
                            const bResources = (b.store ? b.store.getUsedCapacity() : 0) + (b.energy || 0);
                            return bResources - aResources;
                        });

                        target = creep.pos.findClosestByPath(potentialTargets);
                        if (!target) {
                            if (DEBUG) console.log(`No path found, trying findClosestByRange`);
                            target = creep.pos.findClosestByRange(potentialTargets);
                        }
                        if (target) {
                            creep.memory.theftTarget = target.id;
                            if (DEBUG) console.log(`Selected target: ${target.structureType} at ${target.pos}`);
                        } else {
                            if (DEBUG) console.log(`No accessible targets found`);
                        }
                    } else {
                        // Enhanced debug: Let's see what's being filtered out
                        if (DEBUG) {
                            console.log(`Debug - All structures in room: ${creep.room.find(FIND_STRUCTURES).length}`);

                            // Check extensions specifically with both methods
                            const extensions = creep.room.find(FIND_STRUCTURES, {
                                filter: (s) => s.structureType === STRUCTURE_EXTENSION
                            });
                            console.log(`Extensions found: ${extensions.length}`);

                            const extensionsWithEnergy = extensions.filter(s => s.energy > 0);
                            console.log(`Extensions with energy (old property): ${extensionsWithEnergy.length}`);

                            const extensionsWithStore = extensions.filter(s => s.store && s.store.getUsedCapacity() > 0);
                            console.log(`Extensions with energy (store property): ${extensionsWithStore.length}`);

                            // Test the fixed hasResources function
                            const extensionsWithResources = extensions.filter(s => hasResources(s));
                            console.log(`Extensions with resources (fixed function): ${extensionsWithResources.length}`);
                        }
                    }
                }

                if (target && hasResources(target)) {
                    // Withdraw resources - handle both old and new API
                    if (target.store && target.store.getUsedCapacity() > 0) {
                        // New store API
                        for (const resourceType in target.store) {
                            const result = creep.withdraw(target, resourceType);
                            if (result === ERR_NOT_IN_RANGE) {
                                creep.moveTo(target, { visualizePathStyle: false });
                                break;
                            }
                        }
                    } else if (target.energy > 0) {
                        // Old energy API
                        const result = creep.withdraw(target, RESOURCE_ENERGY);
                        if (result === ERR_NOT_IN_RANGE) {
                            creep.moveTo(target, { visualizePathStyle: false });
                        }
                    }

                    // Check if target is now empty
                    if (!hasResources(target)) {
                        delete creep.memory.theftTarget;
                    }
                } else {
                    // No target: Move to room center
                    creep.moveTo(new RoomPosition(25, 25, targetRoomName), { visualizePathStyle: false });
                }
            }
        } else {
            // --- RETURNING PHASE ---
            const homeRoomName = creep.memory.homeRoom;
            if (creep.room.name !== homeRoomName) {
                // Move to home room (optimized with ByRange for exits)
                const exitDir = creep.room.findExitTo(homeRoomName);
                if (exitDir > 0) { // Valid direction
                    const exitPos = creep.pos.findClosestByRange(exitDir);
                    if (exitPos) {
                        creep.moveTo(exitPos, { visualizePathStyle: false });
                    }
                }
            } else {
                // In home room: Deposit resources
                let depositTarget = creep.memory.depositTarget ? Game.getObjectById(creep.memory.depositTarget) : null;

                // Find new deposit target only if none or invalid/full
                if (!depositTarget || depositTarget.store.getFreeCapacity() === 0) {
                    delete creep.memory.depositTarget;
                    const potentialDeposits = creep.room.find(FIND_STRUCTURES, {
                        filter: (s) => (
                            (s.structureType === STRUCTURE_STORAGE && s.my) ||
                            s.structureType === STRUCTURE_CONTAINER
                        ) && s.store.getFreeCapacity() > 0
                    });
                    if (potentialDeposits.length) {
                        depositTarget = creep.pos.findClosestByPath(potentialDeposits);
                        if (!depositTarget) {
                            // Fallback for deposit targets too
                            depositTarget = creep.pos.findClosestByRange(potentialDeposits);
                        }
                        if (depositTarget) {
                            creep.memory.depositTarget = depositTarget.id;
                        }
                    }
                }

                if (depositTarget && depositTarget.store.getFreeCapacity() > 0) {
                    // Transfer all carried resources
                    for (const resourceType in creep.store) {
                        const result = creep.transfer(depositTarget, resourceType);
                        if (result === ERR_NOT_IN_RANGE) {
                            creep.moveTo(depositTarget, { visualizePathStyle: false });
                            break;
                        }
                    }
                    // Check if deposit is now full
                    if (depositTarget.store.getFreeCapacity() === 0) {
                        delete creep.memory.depositTarget;
                    }
                }
            }
        }
    }
};

module.exports = roleThief;
