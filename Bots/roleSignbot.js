//orderSign('W1N1', 'W2N2', 'Hello from my colony!')

const roleSignbot = {
    run: function(creep) {
        // If we don't have a target room or message, something went wrong
        if (!creep.memory.targetRoom || !creep.memory.signMessage) {
            console.log(`[Signbot] ${creep.name} has no target room or message. Suiciding.`);
            creep.suicide();
            return;
        }

        // If we're not in the target room, move there
        if (creep.room.name !== creep.memory.targetRoom) {
            const exitDir = Game.map.findExit(creep.room, creep.memory.targetRoom);
            if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) {
                console.log(`[Signbot] ${creep.name} cannot find path to ${creep.memory.targetRoom}`);
                creep.suicide();
                return;
            }

            const exit = creep.pos.findClosestByRange(exitDir);
            if (exit) {
                creep.moveTo(exit, { visualizePathStyle: { stroke: '#00ff00' } });
                creep.say('🚀 Moving');
            }
            return;
        }

        // We're in the target room, find the controller
        const controller = creep.room.controller;
        if (!controller) {
            console.log(`[Signbot] ${creep.name} found no controller in ${creep.memory.targetRoom}`);
            creep.suicide();
            return;
        }

        // Move to the controller and sign it
        if (!creep.pos.inRangeTo(controller, 1)) {
            creep.moveTo(controller, { visualizePathStyle: { stroke: '#ffaa00' } });
            creep.say('📝 Signing');
        } else {
            const result = creep.signController(controller, creep.memory.signMessage);
            if (result === OK) {
                console.log(`[Signbot] ${creep.name} successfully signed ${creep.memory.targetRoom} with: "${creep.memory.signMessage}"`);
                creep.say('✅ Done');
                creep.suicide(); // Job complete
            } else {
                console.log(`[Signbot] ${creep.name} failed to sign controller: ${result}`);
                creep.suicide();
            }
        }
    }
};

module.exports = roleSignbot;
