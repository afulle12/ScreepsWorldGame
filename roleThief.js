// roleThief.js
// orderThieves('W1N1', 'W2N1', 3)
// cancelThiefOrder('W2N1')

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

                // Find new target only if none or invalid/empty
                if (!target || target.store.getUsedCapacity() === 0) {
                    delete creep.memory.theftTarget;
                    const potentialTargets = creep.room.find(FIND_STRUCTURES, {
                        filter: (s) => [
                            STRUCTURE_EXTENSION,
                            STRUCTURE_SPAWN,
                            STRUCTURE_TOWER,
                            STRUCTURE_STORAGE,
                            STRUCTURE_CONTAINER,
                            STRUCTURE_LAB,
                            STRUCTURE_TERMINAL
                        ].includes(s.structureType) && s.store.getUsedCapacity() > 0
                    });
                    if (potentialTargets.length) {
                        target = creep.pos.findClosestByPath(potentialTargets);
                        if (target) {
                            creep.memory.theftTarget = target.id;
                        }
                    }
                }

                if (target && target.store.getUsedCapacity() > 0) {
                    // Withdraw all possible resources
                    for (const resourceType in target.store) {
                        const result = creep.withdraw(target, resourceType);
                        if (result === ERR_NOT_IN_RANGE) {
                            creep.moveTo(target, { visualizePathStyle: false });
                            break;
                        }
                    }
                    // Check if target is now empty
                    if (target.store.getUsedCapacity() === 0) {
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
