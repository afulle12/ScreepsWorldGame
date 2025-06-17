module.exports = {
    run: function(creep) {
        const targetRoom = creep.memory.targetRoom;
        if (!targetRoom) {
            creep.suicide();
            return;
        }

        // Move to the target room if not there yet
        if (creep.room.name !== targetRoom) {
            creep.moveTo(new RoomPosition(25, 25, targetRoom), { visualizePathStyle: { stroke: '#ffaa00' } });
            return;
        }

        // 1. Attack any hostile creeps
        const hostileCreep = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (hostileCreep && creep.pos.inRangeTo(hostileCreep, 1)) {
            creep.attack(hostileCreep);
            creep.say('⚔️Creep');
            return;
        } else if (hostileCreep) {
            creep.moveTo(hostileCreep, { visualizePathStyle: { stroke: '#ff0000' } });
            return;
        }

        // 2. Attack any hostile structures (except controller)
        const hostileStructure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType !== STRUCTURE_CONTROLLER
        });
        if (hostileStructure && creep.pos.inRangeTo(hostileStructure, 1)) {
            creep.attack(hostileStructure);
            creep.say('⚔️Struct');
            return;
        } else if (hostileStructure) {
            creep.moveTo(hostileStructure, { visualizePathStyle: { stroke: '#ff0000' } });
            return;
        }

        // 3. Controller logic
        const controller = creep.room.controller;
        if (!controller) {
            creep.say('No ctrl!');
            return;
        }

        if (!controller.my && controller.owner) {
            // Attack controller if owned by someone else
            if (creep.pos.inRangeTo(controller, 1)) {
                creep.attackController(controller);
                creep.say('AtkCtrl');
            } else {
                creep.moveTo(controller, { visualizePathStyle: { stroke: '#ff00ff' } });
            }
            return;
        }

        // Try to claim controller
        if (!controller.my && !controller.owner) {
            if (creep.pos.inRangeTo(controller, 1)) {
                const result = creep.claimController(controller);
                if (result === OK) {
                    creep.say('Claimed!');
                } else {
                    creep.say('Err:' + result);
                }
            } else {
                creep.moveTo(controller, { visualizePathStyle: { stroke: '#00ff00' } });
            }
            return;
        }

        // If controller is already yours, suicide
        if (controller.my) {
            creep.say('Done!');
            creep.suicide();
        }
    }
};
