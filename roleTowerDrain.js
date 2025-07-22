const roleTowerDrain = {
    run: function(creep) {
        // Initialize or reset the state machine
        if (!creep.memory.state || !['findPositions', 'draining', 'retreating', 'healing', 'returningHome'].includes(creep.memory.state)) {
            creep.memory.state = 'findPositions';
        }

        // Flee if about to die
        if (creep.ticksToLive < 50) {
            creep.memory.state = 'returningHome';
        }

        // --- State Machine based on your idea ---
        switch (creep.memory.state) {
            case 'findPositions':
                this.findPositions(creep);
                break;
            case 'draining':
                this.doDraining(creep);
                break;
            case 'retreating':
                this.doRetreating(creep);
                break;
            case 'healing':
                this.doHealing(creep);
                break;
            case 'returningHome':
                this.returnHome(creep);
                break;
            default:
                creep.memory.state = 'findPositions';
                break;
        }
    },

    /**
     * Finds and saves the two key positions:
     * creep.memory.drainPos: The tile in the target room, right on the border.
     * creep.memory.healPos: The tile one square INSIDE the safe room.
     */
    findPositions: function(creep) {
        const targetRoom = creep.memory.targetRoom;
        if (creep.room.name !== targetRoom) {
            creep.memory.safeRoom = creep.room.name;
            const exit = creep.pos.findClosestByPath(creep.room.findExitTo(targetRoom));
            if (exit) creep.moveTo(exit);
            return;
        }

        let drainPos, healPos;
        const safeRoomName = creep.memory.safeRoom;

        if (creep.pos.x === 0) { // Entered from West
            drainPos = { x: 0, y: creep.pos.y, roomName: creep.room.name };
            healPos = { x: 48, y: creep.pos.y, roomName: safeRoomName }; // One square in from the east edge
        } else if (creep.pos.x === 49) { // Entered from East
            drainPos = { x: 49, y: creep.pos.y, roomName: creep.room.name };
            healPos = { x: 1, y: creep.pos.y, roomName: safeRoomName }; // One square in from the west edge
        } else if (creep.pos.y === 0) { // Entered from North
            drainPos = { x: creep.pos.x, y: 0, roomName: creep.room.name };
            healPos = { x: creep.pos.x, y: 48, roomName: safeRoomName }; // One square in from the south edge
        } else if (creep.pos.y === 49) { // Entered from South
            drainPos = { x: creep.pos.x, y: 49, roomName: creep.room.name };
            healPos = { x: creep.pos.x, y: 1, roomName: safeRoomName }; // One square in from the north edge
        }

        if (!drainPos || !healPos) {
            console.log(`[${creep.name}] ERROR: Could not determine drain/heal positions.`);
            return;
        }

        creep.memory.drainPos = drainPos;
        creep.memory.healPos = healPos;
        creep.memory.state = 'draining';
        console.log(`[${creep.name}] Positions found. Drain: ${JSON.stringify(drainPos)}, Heal: ${JSON.stringify(healPos)}.`);
    },

    /**
     * STATE: DRAINING
     * Moves to drainPos and waits for damage.
     */
    doDraining: function(creep) {
        if (creep.hits < creep.hitsMax) {
            console.log(`[${creep.name}] Damage detected! State: draining -> retreating.`);
            creep.memory.state = 'retreating';
            return;
        }
        const drainPos = new RoomPosition(creep.memory.drainPos.x, creep.memory.drainPos.y, creep.memory.drainPos.roomName);
        if (!creep.pos.isEqualTo(drainPos)) {
            creep.moveTo(drainPos, { visualizePathStyle: { stroke: '#ff0000' } });
            creep.say('🎯');
        } else {
            creep.say('😎');
        }
    },

    /**
     * STATE: RETREATING
     * Moves to the dedicated healPos.
     */
    doRetreating: function(creep) {
        const healPos = new RoomPosition(creep.memory.healPos.x, creep.memory.healPos.y, creep.memory.healPos.roomName);
        if (creep.pos.isEqualTo(healPos)) {
            console.log(`[${creep.name}] Arrived at heal spot. State: retreating -> healing.`);
            creep.memory.state = 'healing';
            // Fall through to heal immediately on the same tick
            this.doHealing(creep);
            return;
        }
        creep.moveTo(healPos, { visualizePathStyle: { stroke: '#00ff00' } });
        creep.heal(creep);
        creep.say('🏃');
    },

    /**
     * STATE: HEALING
     * Sits still at healPos and does nothing but heal until full health.
     */
    doHealing: function(creep) {
        // The ONLY way to leave this state is to be at full health.
        if (creep.hits === creep.hitsMax) {
            console.log(`[${creep.name}] Fully healed. State: healing -> draining.`);
            creep.memory.state = 'draining';
            return;
        }

        // If not at full health, heal. DO NOT MOVE.
        creep.heal(creep);
        creep.say('❤️‍🩹');
    },

    returnHome: function(creep) {
        const homeRoom = creep.memory.homeRoom;
        if (homeRoom && creep.room.name !== homeRoom) {
            const exit = creep.pos.findClosestByPath(creep.room.findExitTo(homeRoom));
            if (exit) creep.moveTo(exit);
        } else {
            creep.say('🏠');
        }
    }
};

module.exports = roleTowerDrain;
