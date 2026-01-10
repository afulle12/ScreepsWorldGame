// roleRemoteHarvesters.js
// remoteBuilder('W1N1','W1N2',2) Deploy 2 builders from W1N1 to W1N2
// cancelRemoteBuilder('W1N1','W1N2') Cancel W1N1→W1N2 order
// listRemoteBuilders() Show active orders with current counts


const LOGGING_ENABLED = false; // Set to true for debugging

// Helper function for logging
const log = (creep, message) => {
    if (LOGGING_ENABLED) {
        console.log(`[${creep.name}] ${message}`);
    }
};

const roleRemoteHarvester = {
    // --- NEW: Dynamic Body Definitions ---
    // Bodies are defined in tiers, from largest to smallest.
    // The ratio is roughly 1 WORK : 2 CARRY : 2 MOVE for efficient long-distance work.
    BODIES: [
        // Tier 3 (Max): 1800 Energy - 6 WORK, 12 CARRY, 12 MOVE
        {
            cost: 1800,
            body: [
                WORK, WORK, WORK, WORK, WORK, WORK,
                CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY,
                MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE
            ]
        },
        // Tier 2 (Medium): 1200 Energy - 4 WORK, 8 CARRY, 8 MOVE
        {
            cost: 1200,
            body: [
                WORK, WORK, WORK, WORK,
                CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY,
                MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE
            ]
        },
        // Tier 1 (Small): 600 Energy - 2 WORK, 4 CARRY, 4 MOVE
        {
            cost: 600,
            body: [
                WORK, WORK,
                CARRY, CARRY, CARRY, CARRY,
                MOVE, MOVE, MOVE, MOVE
            ]
        }
    ],

    /**
     * --- NEW: Helper function to get the best body for the available energy ---
     * @param {number} energy - The total energy available in the room.
     * @returns {string[] | null} The body parts array, or null if no body can be afforded.
     */
    getBody: function(energy) {
        for (const tier of this.BODIES) {
            if (energy >= tier.cost) {
                return tier.body;
            }
        }
        return null; // Return null if even the smallest body can't be afforded
    },

    run: function(creep) {
        // --- Fleeing Logic (Unchanged) ---
        if (creep.memory.fleeing && Game.time < creep.memory.fleeUntil) {
            if (creep.room.name === creep.memory.homeRoom) {
                log(creep, `✅ Safe in home room. Resuming duties.`);
                delete creep.memory.fleeing;
                delete creep.memory.fleeUntil;
            } else {
                creep.moveTo(new RoomPosition(25, 25, creep.memory.homeRoom), { reusePath: 10 });
                return;
            }
        } else {
            if (creep.room.name === creep.memory.targetRoom) {
                const hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
                    filter: (c) => (c.body.some(p => p.type === ATTACK) || c.body.some(p => p.type === RANGED_ATTACK)) && c.owner.username !== 'Source Keeper'
                });
                if (hostiles.length > 0) {
                    creep.memory.fleeing = true;
                    creep.memory.fleeUntil = Game.time + 50;
                    return;
                }
            }
        }

        // --- State Transition (Unchanged) ---
        if (creep.memory.working && creep.store.getUsedCapacity() === 0) {
            creep.memory.working = false;
            delete creep.memory.depositRoom;
            log(creep, '⛏️ Empty. Switching to harvesting.');
        }
        if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
            creep.memory.working = true;
        }

        // --- Action Logic (Unchanged) ---
        if (creep.memory.working) {
            if (Game.time % 20 === 0 || !creep.memory.depositRoom) {
                log(creep, `⏰ Reassessing deposit target...`);
                const local_storage = creep.room.storage;
                if (local_storage && local_storage.my && local_storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    creep.memory.depositRoom = creep.room.name;
                    log(creep, `🎯 New target (local): ${creep.room.name}`);
                } else {
                    const myRoomsWithStorage = _.filter(Game.rooms, r => r.controller && r.controller.my && r.storage);
                    if (myRoomsWithStorage.length > 0) {
                        const closestRoom = _.min(myRoomsWithStorage, r => Game.map.getRoomLinearDistance(creep.room.name, r.name));
                        creep.memory.depositRoom = closestRoom.name;
                        log(creep, `🎯 New target (remote): ${closestRoom.name}`);
                    } else {
                        creep.memory.depositRoom = creep.memory.homeRoom;
                        log(creep, `🎯 No storage found. Defaulting to home room ${creep.memory.homeRoom}.`);
                    }
                }
            }

            const depositRoomName = creep.memory.depositRoom;
            if (depositRoomName) {
                if (creep.room.name === depositRoomName) {
                    const target = creep.room.storage;
                    if (target) {
                        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(target);
                        }
                    }
                } else {
                    creep.moveTo(new RoomPosition(25, 25, depositRoomName), { reusePath: 10 });
                }
            } else {
                log(creep, '❓ No deposit target. Idling.');
            }

        } else {
            if (creep.room.name !== creep.memory.targetRoom) {
                const targetPos = new RoomPosition(25, 25, creep.memory.targetRoom);
                creep.moveTo(targetPos, { reusePath: 10 });
            } else {
                const source = Game.getObjectById(creep.memory.sourceId);
                if (source) {
                    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(source);
                    }
                }
            }
        }
    }
};

module.exports = roleRemoteHarvester;
