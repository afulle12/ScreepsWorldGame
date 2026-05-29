// rolePowerBot.js
// Manages both ENERGY and POWER delivery to PowerSpawn
// States: idle, gather_energy, deliver_energy, gather_power, gather_energy_bonus, deliver_power, return_resource
// Priority: energy > 500 → prefer power task; energy <= 500 → prefer energy task
// After gathering power, any remaining carry capacity is filled with energy.
// Delivery order: power first, then energy, then idle.

module.exports = {
    run: function(creep) {
        var powerSpawn = creep.room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_POWER_SPAWN; }
        })[0];

        if (!powerSpawn) {
            creep.say('? no spawn');
            return;
        }

        // ── 0. Low TTL Handler ──────────────────────────────────────────
        if (creep.ticksToLive < 100) {
            this.handleLowTTL(creep);
            return;
        }

        // ── 1. Decide task (only when idle or between trips) ────────────
        if (!creep.memory.state || creep.memory.state === 'idle') {
            this.decideTask(creep, powerSpawn);
        }

        // ── 2. Execute current state ────────────────────────────────────
        switch (creep.memory.state) {
            case 'return_resource':
                this.returnResource(creep);
                break;
            case 'gather_energy':
                this.gatherEnergy(creep);
                break;
            case 'deliver_energy':
                this.deliverEnergy(creep, powerSpawn);
                break;
            case 'gather_power':
                this.gatherPower(creep);
                break;
            case 'gather_energy_bonus':
                this.gatherEnergyBonus(creep);
                break;
            case 'deliver_power':
                this.deliverPower(creep, powerSpawn);
                break;
            default:
                // idle — park near spawn
                if (creep.pos.getRangeTo(powerSpawn) > 3) {
                    creep.moveTo(powerSpawn);
                }
                break;
        }
    },

    // ── Task Decision Logic ─────────────────────────────────────────────
    decideTask: function(creep, powerSpawn) {
        var spawnEnergy = powerSpawn.store[RESOURCE_ENERGY] || 0;
        var spawnPower  = powerSpawn.store[RESOURCE_POWER]  || 0;

        var needsEnergy = spawnEnergy < 2000;
        var needsPower  = spawnPower  < 30;

        // Determine which task we want
        var nextTask = null;

        if (!needsEnergy && !needsPower) {
            // Nothing needed
        } else if (needsEnergy && !needsPower) {
            nextTask = 'energy';
        } else if (needsPower && !needsEnergy) {
            nextTask = 'power';
        } else {
            // Both needed — use priority
            nextTask = (spawnEnergy > 500) ? 'power' : 'energy';
        }

        // Before starting a new task, check if we're carrying the WRONG resource
        if (creep.store.getUsedCapacity() > 0) {
            var carryingPower  = creep.store[RESOURCE_POWER]  || 0;
            var carryingEnergy = creep.store[RESOURCE_ENERGY] || 0;

            if (nextTask === 'energy' && carryingPower > 0) {
                // Need to return power before gathering energy
                creep.memory.state = 'return_resource';
                creep.memory.nextTask = nextTask;
                creep.say('↩ dump P');
                return;
            }
            if (nextTask === 'power' && carryingEnergy > 0) {
                // Need to return energy before gathering power
                creep.memory.state = 'return_resource';
                creep.memory.nextTask = nextTask;
                creep.say('↩ dump E');
                return;
            }
            // If carrying the right resource already, skip gather
            if (nextTask === 'energy' && carryingEnergy > 0) {
                creep.memory.state = 'deliver_energy';
                creep.say('🔋 fill E');
                return;
            }
            if (nextTask === 'power' && carryingPower > 0) {
                creep.memory.state = 'deliver_power';
                creep.say('⚡ fill P');
                return;
            }
        }

        if (!nextTask) {
            creep.memory.state = 'idle';
            if (Game.time % 10 === 0) creep.say('💤 idle');
            return;
        }

        if (nextTask === 'energy') {
            this.startEnergyTask(creep);
        } else {
            this.startPowerTask(creep);
        }
    },

    startEnergyTask: function(creep) {
        if (creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
            creep.memory.state = 'gather_energy';
            creep.say('🔋 get E');
        } else {
            creep.memory.state = 'idle';
            if (Game.time % 10 === 0) creep.say('⏳ no E');
        }
    },

    startPowerTask: function(creep) {
        // Check if at least 10 power is available anywhere
        var terminalPower = (creep.room.terminal && creep.room.terminal.store[RESOURCE_POWER]) || 0;
        var storagePower  = (creep.room.storage  && creep.room.storage.store[RESOURCE_POWER])  || 0;

        if (terminalPower + storagePower >= 10) {
            creep.memory.state = 'gather_power';
            creep.say('🔴 get P');
        } else {
            // Not enough power — try energy instead, or idle
            var powerSpawn = creep.room.find(FIND_MY_STRUCTURES, {
                filter: function(s) { return s.structureType === STRUCTURE_POWER_SPAWN; }
            })[0];
            if (powerSpawn && (powerSpawn.store[RESOURCE_ENERGY] || 0) < 2000) {
                this.startEnergyTask(creep);
            } else {
                creep.memory.state = 'idle';
                if (Game.time % 10 === 0) creep.say('💤 idle');
            }
        }
    },

    // ── Return Resource (dump wrong resource to terminal/storage) ───────
    returnResource: function(creep) {
        if (creep.store.getUsedCapacity() === 0) {
            // Done returning — go idle so decideTask picks the right job
            delete creep.memory.nextTask;
            creep.memory.state = 'idle';
            return;
        }

        var returnTarget = creep.room.terminal || creep.room.storage;
        if (!returnTarget) {
            creep.memory.state = 'idle';
            return;
        }

        for (var res in creep.store) {
            if (creep.store[res] > 0) {
                var result = creep.transfer(returnTarget, res);
                if (result === ERR_NOT_IN_RANGE) {
                    creep.moveTo(returnTarget, { visualizePathStyle: { stroke: '#ff00ff' } });
                }
                return; // One resource type per tick
            }
        }
    },

    // ── Gather Energy ───────────────────────────────────────────────────
    gatherEnergy: function(creep) {
        if (creep.store.getFreeCapacity() === 0) {
            creep.memory.state = 'deliver_energy';
            creep.say('🔋 fill E');
            return;
        }

        var storage = creep.room.storage;
        if (storage && storage.store[RESOURCE_ENERGY] > 0) {
            var result = creep.withdraw(storage, RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) {
                creep.moveTo(storage, { visualizePathStyle: { stroke: '#ffaa00' } });
            } else if (result === OK) {
                if (creep.store.getFreeCapacity() === 0) {
                    creep.memory.state = 'deliver_energy';
                    creep.say('🔋 fill E');
                }
            }
        } else {
            if (creep.store[RESOURCE_ENERGY] > 0) {
                creep.memory.state = 'deliver_energy';
                creep.say('🔋 flush E');
            } else {
                creep.memory.state = 'idle';
                creep.say('⏳ no E');
            }
        }
    },

    // ── Deliver Energy ──────────────────────────────────────────────────
    deliverEnergy: function(creep, powerSpawn) {
        if (creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.state = 'idle';
            return;
        }

        var result = creep.transfer(powerSpawn, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(powerSpawn, { visualizePathStyle: { stroke: '#ffaa00' } });
        } else if (result === ERR_FULL) {
            creep.memory.state = 'idle';
            creep.say('🔋 E full');
        } else if (result === OK) {
            if (creep.store[RESOURCE_ENERGY] === 0) {
                creep.memory.state = 'idle';
            }
        }
    },

    // ── Gather Power (max 80) ───────────────────────────────────────────
    gatherPower: function(creep) {
        var carried = creep.store[RESOURCE_POWER] || 0;

        // Cap at 80 — leave room for bonus energy top-up
        if (carried >= 80) {
            this.transitionAfterPower(creep);
            return;
        }

        var amountNeeded = 80 - carried;

        // Priority: Terminal > Storage > Dropped
        var target = null;
        if (creep.room.terminal && creep.room.terminal.store[RESOURCE_POWER] > 0) {
            target = creep.room.terminal;
        } else if (creep.room.storage && creep.room.storage.store[RESOURCE_POWER] > 0) {
            target = creep.room.storage;
        }

        if (target) {
            var available = target.store[RESOURCE_POWER] || 0;
            var withdrawAmount = Math.min(amountNeeded, available);

            // Enforce minimum of 10 for fresh pickups
            if (withdrawAmount < 10 && carried === 0) {
                creep.memory.state = 'idle';
                if (Game.time % 10 === 0) creep.say('💤 low P');
                return;
            }

            var result = creep.withdraw(target, RESOURCE_POWER, withdrawAmount);
            if (result === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
            } else if (result === OK) {
                this.transitionAfterPower(creep);
            }
        } else {
            // Check for dropped power
            var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
                filter: function(r) { return r.resourceType === RESOURCE_POWER; }
            });
            if (dropped) {
                if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(dropped);
                }
            } else if (carried >= 10) {
                this.transitionAfterPower(creep);
            } else {
                creep.memory.state = 'idle';
                if (Game.time % 10 === 0) creep.say('💤 no P');
            }
        }
    },

    // ── After gathering power, fill remaining space with energy if possible
    transitionAfterPower: function(creep) {
        var storage = creep.room.storage;
        if (creep.store.getFreeCapacity() > 0 &&
            storage && storage.store[RESOURCE_ENERGY] > 0) {
            creep.memory.state = 'gather_energy_bonus';
            creep.say('🔋 also E');
        } else {
            creep.memory.state = 'deliver_power';
            creep.say('⚡ fill P');
        }
    },

    // ── Gather bonus energy to fill remaining capacity after power pickup
    gatherEnergyBonus: function(creep) {
        if (creep.store.getFreeCapacity() === 0) {
            creep.memory.state = 'deliver_power';
            creep.say('⚡ fill P');
            return;
        }

        var storage = creep.room.storage;
        if (storage && storage.store[RESOURCE_ENERGY] > 0) {
            var result = creep.withdraw(storage, RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) {
                creep.moveTo(storage, { visualizePathStyle: { stroke: '#ffaa00' } });
            } else if (result === OK || result === ERR_FULL) {
                creep.memory.state = 'deliver_power';
                creep.say('⚡ fill P');
            }
        } else {
            // No energy available — proceed with just the power
            creep.memory.state = 'deliver_power';
            creep.say('⚡ fill P');
        }
    },

    // ── Deliver Power ───────────────────────────────────────────────────
    deliverPower: function(creep, powerSpawn) {
        var carried = creep.store[RESOURCE_POWER] || 0;
        if (carried === 0) {
            // Power done — deliver any bonus energy we picked up
            if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                creep.memory.state = 'deliver_energy';
                creep.say('🔋 fill E');
            } else {
                creep.memory.state = 'idle';
            }
            return;
        }

        var spawnSpace = 100 - (powerSpawn.store[RESOURCE_POWER] || 0);

        if (spawnSpace < 10) {
            // Not enough room for a meaningful transfer.
            // If we're also holding energy, go deliver that while we wait.
            if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                creep.memory.state = 'deliver_energy';
                creep.say('🔋 fill E');
                return;
            }
            if (creep.pos.getRangeTo(powerSpawn) > 1) {
                creep.moveTo(powerSpawn);
            }
            creep.say('⏳ P full');
            return;
        }

        var transferAmount = Math.min(carried, spawnSpace);
        var result = creep.transfer(powerSpawn, RESOURCE_POWER, transferAmount);

        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(powerSpawn, { visualizePathStyle: { stroke: '#ff0000' } });
        } else if (result === ERR_FULL) {
            if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                creep.memory.state = 'deliver_energy';
                creep.say('🔋 fill E');
            } else {
                if (creep.pos.getRangeTo(powerSpawn) > 1) {
                    creep.moveTo(powerSpawn);
                }
                creep.say('⏳ P full');
            }
        } else if (result === OK) {
            if ((creep.store[RESOURCE_POWER] || 0) === 0) {
                // Power delivered — chain to energy delivery if we have bonus energy
                if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    creep.memory.state = 'deliver_energy';
                    creep.say('🔋 fill E');
                } else {
                    creep.memory.state = 'idle';
                }
            }
        }
    },

    // ── Low TTL — return resources and die ──────────────────────────────
    handleLowTTL: function(creep) {
        var returnTarget = creep.room.terminal || creep.room.storage;

        if (creep.store.getUsedCapacity() > 0 && returnTarget) {
            for (var res in creep.store) {
                if (creep.store[res] > 0) {
                    var result = creep.transfer(returnTarget, res);
                    if (result === ERR_NOT_IN_RANGE) {
                        creep.moveTo(returnTarget, { visualizePathStyle: { stroke: '#ff00ff' } });
                    }
                    creep.say('💀 return');
                    return;
                }
            }
        }

        creep.say('💀 bye');
        creep.suicide();
    }
};