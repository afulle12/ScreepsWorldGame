/**
 * The Attacker role uses iff.js to avoid friendly targets.
 * It prioritizes an assigned target, then hostile creeps, then hostile structures.
 *
 * --- HOW TO USE ---
 * 1. Order attackers to a room from the console:
 *    > global.orderAttack('E3N44', 3)
 *
 * 2. (Optional) Assign a specific target ID to all attackers in that room:
 *    > Game.assignAttackTarget('W1N8', '5bbcac4c9099fc012e635e3a')
 *
 * Memory:
 *  - role: 'attacker'
 *  - targetRoom: The room to attack.
 *  - homeRoom: The room it was spawned from.
 *  - assignedTargetId: (Optional) The ID of a specific target to focus on.
 */
const iff = require('iff');

const roleAttacker = {
    /** @param {Creep} creep **/
    run: function(creep) {
        const targetRoom = creep.memory.targetRoom;

        if (creep.room.name !== targetRoom) {
            creep.moveTo(new RoomPosition(25, 25, targetRoom), {
                visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' }
            });
            creep.say(`⚔️ ${targetRoom}`);
            return;
        }

        let target = null;

        // Priority 0: Assigned target from memory
        if (creep.memory.assignedTargetId) {
            target = Game.getObjectById(creep.memory.assignedTargetId);
            if (!target) {
                delete creep.memory.assignedTargetId;
            }
        }

        if (!target) {
            // Priority 1: Hostile creeps (using IFF)
            target = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS, {
                filter: (c) => iff.isHostileCreep(c)
            });

            // Priority 2: Hostile structures (using IFF)
            if (!target) {
                target = creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
                    filter: (s) => {
                        if (s.structureType === STRUCTURE_CONTROLLER || s.structureType === STRUCTURE_KEEPER_LAIR) {
                            return false;
                        }
                        if (s.owner && iff.IFF_WHITELIST.includes(s.owner.username)) {
                            return false;
                        }
                        return true;
                    }
                });
            }

            // Priority 3: Hostile construction sites
            if (!target) {
                target = creep.pos.findClosestByPath(FIND_HOSTILE_CONSTRUCTION_SITES);
            }
        }

        // --- ACTION LOGIC ---
        if (target) {
            creep.say('💥 ATTACK!');
            if (creep.attack(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' } });
            }
        } else {
            creep.moveTo(new RoomPosition(25, 25, targetRoom), {
                visualizePathStyle: { stroke: '#cccccc' }
            });
            creep.say('⚔️ IDLE');
        }
    }
};

module.exports = roleAttacker;
