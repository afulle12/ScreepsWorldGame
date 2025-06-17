module.exports = {
    run: function(creep) {
        // Find the closest hostile creep
        const target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);

        if(target) {
            if(creep.attack(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' } });
            }
        } else {
            if(creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL)) {
                creep.heal(creep);
            }

            // --- Better Stuck Detection and Patrol Logic ---

            // Initialize patrol memory
            if(!creep.memory.patrolPoints || Game.time % 1000 === 0) {
                initializePatrolPoints(creep);
            }

            // Track position to detect being stuck
            if(!creep.memory.lastPos) {
                creep.memory.lastPos = {x: creep.pos.x, y: creep.pos.y, stuckCount: 0};
            }

            // Check if stuck in the same position
            if(creep.pos.x === creep.memory.lastPos.x && creep.pos.y === creep.memory.lastPos.y) {
                creep.memory.lastPos.stuckCount++;
            } else {
                creep.memory.lastPos = {x: creep.pos.x, y: creep.pos.y, stuckCount: 0};
            }

            // If stuck for several ticks, change patrol point or try random movement
            if(creep.memory.lastPos.stuckCount > 3) {
                // Move to a random adjacent position to break the pattern
                if(creep.memory.lastPos.stuckCount > 6) {
                    moveRandomly(creep);
                    return;
                }
                // Skip to next patrol point
                creep.memory.patrolIndex = (creep.memory.patrolIndex + 1) % creep.memory.patrolPoints.length;
            }

            const patrolPoints = creep.memory.patrolPoints.map(
                p => new RoomPosition(p[0], p[1], creep.room.name)
            );
            let patrolIndex = creep.memory.patrolIndex || 0;
            let patrolPos = patrolPoints[patrolIndex];

            // If close to patrol point, go to next one
            if(creep.pos.inRangeTo(patrolPos, 1)) {
                patrolIndex = (patrolIndex + 1) % patrolPoints.length;
                creep.memory.patrolIndex = patrolIndex;
                patrolPos = patrolPoints[patrolIndex];
            }

            // Better movement options
            creep.moveTo(patrolPos, { 
                visualizePathStyle: { stroke: '#00ff00' },
                reusePath: 5,   // Recalculate path more frequently
                ignoreCreeps: true,  // Try to move around other creeps
                plainCost: 2,        // Adjusted cost to encourage varied paths
                swampCost: 10         // Higher penalty for swamps
            });
        }
    }
};

// Initialize patrol points function
function initializePatrolPoints(creep) {
    const points = [];
    const room = creep.room;

    // Add strategic points
    if(room.controller) {
        points.push([room.controller.pos.x, room.controller.pos.y]);
    }

    // Spawns
    const spawns = room.find(FIND_MY_SPAWNS);
    for(const spawn of spawns) {
        points.push([spawn.pos.x, spawn.pos.y]);
    }

    // Add random points across the room
    for(let i = 0; i < 3; i++) {
        // Generate points in the middle area of the room, avoiding edges
        const x = 10 + Math.floor(Math.random() * 30);
        const y = 10 + Math.floor(Math.random() * 30);
        points.push([x, y]);
    }

    // Offsets from corners (avoid walls)
    const offset = 3;
    points.push([offset, offset]);
    points.push([49 - offset, offset]);
    points.push([49 - offset, 49 - offset]);
    points.push([offset, 49 - offset]);

    // Filter out impassable points
    creep.memory.patrolPoints = points.filter(p => {
        // Check terrain
        const terrain = room.getTerrain();
        if(terrain.get(p[0], p[1]) === TERRAIN_MASK_WALL) {
            return false;
        }

        // Check for structure obstacles (except roads)
        const structures = room.lookForAt(LOOK_STRUCTURES, p[0], p[1]);
        for(const struct of structures) {
            if(struct.structureType !== STRUCTURE_ROAD && 
               OBSTACLE_OBJECT_TYPES.includes(struct.structureType)) {
                return false;
            }
        }

        return true;
    });

    // Randomize patrol index
    creep.memory.patrolIndex = Math.floor(Math.random() * creep.memory.patrolPoints.length);
}

// Move randomly function
function moveRandomly(creep) {
    const directions = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
    const randomDirection = directions[Math.floor(Math.random() * directions.length)];
    creep.move(randomDirection);

    // Reset the stuck counter after moving randomly
    creep.memory.lastPos.stuckCount = 0;
}
