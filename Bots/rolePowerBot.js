// rolePowerBot.js
// Hauls RESOURCE_POWER from Terminal/Storage to PowerSpawn
// Fixes: Handles partial loads and ERR_FULL gracefully

module.exports = {
    run: function(creep) {
        // 0. Low TTL Handler - Return power to terminal and suicide
        if (creep.ticksToLive < 100) {
            if (creep.store[RESOURCE_POWER] > 0) {
                var returnTarget = creep.room.terminal || creep.room.storage;
                if (returnTarget) {
                    var result = creep.transfer(returnTarget, RESOURCE_POWER);
                    if (result === ERR_NOT_IN_RANGE) {
                        creep.moveTo(returnTarget, { visualizePathStyle: { stroke: '#ff00ff' } });
                    }
                    creep.say('💀 return');
                    return;
                }
            }
            // No power left (or nowhere to return it) - suicide
            creep.say('💀 bye');
            creep.suicide();
            return;
        }

        // 1. State switching
        // If we are working (delivering) but run out of power, switch to gathering
        if (creep.memory.working && creep.store[RESOURCE_POWER] === 0) {
            creep.memory.working = false;
            creep.say('🔄 gather');
        }
        // If we are gathering but become full, switch to delivering
        if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
            creep.memory.working = true;
            creep.say('⚡ transfer');
        }

        // 2. Action Logic
        if (creep.memory.working) {
            // --- STATE: DELIVERING ---
            var powerSpawn = creep.room.find(FIND_MY_STRUCTURES, {
                filter: function(s) {
                    return s.structureType === STRUCTURE_POWER_SPAWN;
                }
            })[0];

            if (powerSpawn) {
                var result = creep.transfer(powerSpawn, RESOURCE_POWER);
                
                if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(powerSpawn, { visualizePathStyle: { stroke: '#ff0000' } });
                } else if (result === ERR_FULL) {
                    // Spawn is full (100/100). Wait for it to process.
                    // Ideally, we move close so we are ready the moment it ticks.
                    if (creep.pos.getRangeTo(powerSpawn) > 1) {
                        creep.moveTo(powerSpawn);
                    }
                    // Optional: Drop/transfer energy to it if it's out of energy? 
                    // No, supplier handles energy. We just wait.
                    creep.say('⏳ waiting');
                }
            } else {
                // No spawn? Just hang out.
                creep.say('? no spawn');
            }
        } else {
            // --- STATE: GATHERING ---
            
            // Priority 1: Terminal
            var target = null;
            if (creep.room.terminal && creep.room.terminal.store[RESOURCE_POWER] > 0) {
                target = creep.room.terminal;
            } 
            // Priority 2: Storage
            else if (creep.room.storage && creep.room.storage.store[RESOURCE_POWER] > 0) {
                target = creep.room.storage;
            }
            // Priority 3: Ruin/Tombstone (Rescue dropped power)
            else {
                var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
                    filter: function(r) { return r.resourceType === RESOURCE_POWER; }
                });
                if (dropped) {
                    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(dropped);
                    }
                    return; // Early return to focus on pickup
                }
            }

            if (target) {
                if (creep.withdraw(target, RESOURCE_POWER) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
                }
            } else {
                // --- THE FIX IS HERE ---
                // We found no target to withdraw from.
                // Do we have ANY power on us? If so, switch to delivery mode immediately.
                if (creep.store[RESOURCE_POWER] > 0) {
                    creep.memory.working = true;
                    creep.say('⚡ flushing');
                } else {
                    // Totally empty and no source. Idle near PowerSpawn.
                    var powerSpawn = creep.room.find(FIND_MY_STRUCTURES, {
                        filter: function(s) { return s.structureType === STRUCTURE_POWER_SPAWN; }
                    })[0];
                    if (powerSpawn) {
                        if (creep.pos.getRangeTo(powerSpawn) > 3) {
                            creep.moveTo(powerSpawn);
                        }
                    }
                }
            }
        }
    }
};