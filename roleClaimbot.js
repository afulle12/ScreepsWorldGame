const enableLogging = true;  // Set to false to disable logging

module.exports = {
    run: function(creep) {
        if (enableLogging) {
            console.log(`Creep ${creep.name} starting run with targetRoom: ${creep.memory.targetRoom}`);
        }

        const targetRoom = creep.memory.targetRoom;
        if (!targetRoom) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} has no targetRoom, suiciding`);
            }
            creep.suicide();
            return;
        }

        // Move to the target room if not there yet
        if (creep.room.name !== targetRoom) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} moving to room ${targetRoom}`);
            }
            creep.moveTo(new RoomPosition(25, 25, targetRoom), { visualizePathStyle: { stroke: '#ffaa00' } });
            return;
        }

        // 1. Attack any hostile creeps
        const hostileCreep = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (hostileCreep && creep.pos.inRangeTo(hostileCreep, 1)) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} attacking hostile creep at ${hostileCreep.pos}`);
            }
            creep.attack(hostileCreep);
            creep.say('⚔️Creep');
            return;
        } else if (hostileCreep) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} moving to hostile creep at ${hostileCreep.pos}`);
            }
            creep.moveTo(hostileCreep, { visualizePathStyle: { stroke: '#ff0000' } });
            return;
        }

        // 2. Attack any hostile structures (except controller)
        const hostileStructure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType !== STRUCTURE_CONTROLLER
        });
        if (hostileStructure && creep.pos.inRangeTo(hostileStructure, 1)) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} attacking hostile structure at ${hostileStructure.pos}`);
            }
            creep.attack(hostileStructure);
            creep.say('⚔️Struct');
            return;
        } else if (hostileStructure) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} moving to hostile structure at ${hostileStructure.pos}`);
            }
            creep.moveTo(hostileStructure, { visualizePathStyle: { stroke: '#ff0000' } });
            return;
        }

        // 3. Controller logic
        const controller = creep.room.controller;
        if (!controller) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} found no controller in room`);
            }
            creep.say('No ctrl!');
            return;
        }

        if (!controller.my && controller.owner) {
            // Attack controller if owned by someone else
            if (creep.pos.inRangeTo(controller, 1)) {
                if (enableLogging) {
                    console.log(`Creep ${creep.name} attacking controller at ${controller.pos}`);
                }
                creep.attackController(controller);
                creep.say('AtkCtrl');
            } else {
                if (enableLogging) {
                    console.log(`Creep ${creep.name} moving to controller at ${controller.pos}`);
                }
                creep.moveTo(controller, { visualizePathStyle: { stroke: '#ff00ff' } });
            }
            return;
        }

        // Try to claim controller
        if (!controller.my && !controller.owner) {
            if (creep.pos.inRangeTo(controller, 1)) {
                if (enableLogging) {
                    console.log(`Creep ${creep.name} attempting to claim controller at ${controller.pos}`);
                }
                const result = creep.claimController(controller);
                if (result === OK) {
                    creep.say('Claimed!');
                    if (enableLogging) {
                        console.log(`Creep ${creep.name} successfully claimed controller`);
                    }
                } else {
                    creep.say('Err:' + result);
                    if (enableLogging) {
                        console.log(`Creep ${creep.name} failed to claim controller: ${result}`);
                    }
                }
            } else {
                if (enableLogging) {
                    console.log(`Creep ${creep.name} moving to unowned controller at ${controller.pos}`);
                }
                creep.moveTo(controller, { visualizePathStyle: { stroke: '#00ff00' } });
            }
            return;
        }

        // If controller is already yours, suicide
        if (controller.my) {
            if (enableLogging) {
                console.log(`Creep ${creep.name} controller is ours, suiciding`);
            }
            creep.say('Done!');
            creep.suicide();
        }
    }
};
