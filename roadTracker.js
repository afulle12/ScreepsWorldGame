// roadTracker.js

const ROAD_TRACKING_ACTIVE = true;
const TRACKING_DURATION = 2000; // Number of ticks to track
const LOG_INTERVAL = 10;      // How often to log status
const OVERUSED_THRESHOLD = 10; // Visits needed to mark a no-structure square as overused

// Helper to create a 50x50 matrix filled with value
function makeMatrix(val = 0) {
    const arr = [];
    for (let y = 0; y < 50; y++) {
        const row = [];
        for (let x = 0; x < 50; x++) {
            row.push(val);
        }
        arr.push(row);
    }
    return arr;
}

const roadTracker = {

    // Call every tick
    trackRoadVisits() {
        if (!ROAD_TRACKING_ACTIVE) return;

        if (!Memory.roadTracker) Memory.roadTracker = {};

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller || !room.controller.my) continue;

            // Initialize memory for this room if needed
            if (!Memory.roadTracker[roomName]) {
                Memory.roadTracker[roomName] = {};
            }
            const mem = Memory.roadTracker[roomName];

            // At the start of a tracking cycle, reset visitMatrix
            if (!mem.startTick || Game.time - mem.startTick >= TRACKING_DURATION) {
                mem.visitMatrix = makeMatrix(0);
                // untraveledMatrix, roadMatrix, overusedNoStructureMatrix will be updated at the end of the cycle
                mem.startTick = Game.time;
                mem.lastCycle = Game.time;
                if (Game.time % LOG_INTERVAL === 0) {
                    console.log(`[RoadTracker] (${roomName}) Tracking reset.`);
                }
            }

            // Matrix #1: Increment visitMatrix for each creep standing on a road or not
            for (const name in Game.creeps) {
                const creep = Game.creeps[name];
                if (creep.room.name !== roomName) continue;
                const x = creep.pos.x;
                const y = creep.pos.y;
                mem.visitMatrix[y][x]++;
                // Log every visit
                // (Optional: comment out if too spammy)
                // console.log(`[RoadTracker] ${creep.name} visited ${x},${y} in ${roomName} (visit #${mem.visitMatrix[y][x]})`);
            }
        }
    },

    // Call every tick after trackRoadVisits
    visualizeUntraveledRoads() {
        if (!ROAD_TRACKING_ACTIVE) return;

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller || !room.controller.my) continue;
            const mem = Memory.roadTracker && Memory.roadTracker[roomName];
            if (!mem) continue;

            const elapsed = Game.time - mem.startTick;

            // At the end of the tracking cycle, rescan for roads/structures and generate matrices
            if (elapsed === TRACKING_DURATION - 1) { // On the last tick of the cycle
                // Matrix #2: roadMatrix (rescan for roads)
                const roadMatrix = makeMatrix(0);
                const roads = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_ROAD });
                for (const road of roads) {
                    roadMatrix[road.pos.y][road.pos.x] = 1;
                }
                mem.roadMatrix = roadMatrix;

                // Matrix #3: untraveledMatrix
                const untraveled = makeMatrix(0);
                let untraveledCount = 0;
                for (let y = 0; y < 50; y++) {
                    for (let x = 0; x < 50; x++) {
                        if (mem.roadMatrix[y][x] === 1 && mem.visitMatrix[y][x] === 0) {
                            untraveled[y][x] = 1;
                            untraveledCount++;
                        }
                    }
                }
                mem.untraveledMatrix = untraveled;

                // Matrix #4: overusedNoStructureMatrix
                const overusedNoStructure = makeMatrix(0);
                let overusedCount = 0;
                // Build a structure presence matrix for the room
                const structureMatrix = makeMatrix(0);
                const structures = room.find(FIND_STRUCTURES);
                for (const s of structures) {
                    structureMatrix[s.pos.y][s.pos.x] = 1;
                }
                for (let y = 0; y < 50; y++) {
                    for (let x = 0; x < 50; x++) {
                        if (structureMatrix[y][x] === 0 && mem.visitMatrix[y][x] >= OVERUSED_THRESHOLD) {
                            overusedNoStructure[y][x] = 1;
                            overusedCount++;
                        }
                    }
                }
                mem.overusedNoStructureMatrix = overusedNoStructure;

                mem.lastCycle = Game.time;
                if (Game.time % LOG_INTERVAL === 0) {
                    console.log(`[RoadTracker] (${roomName}) Untraveled roads after ${TRACKING_DURATION} ticks: ${untraveledCount}`);
                    console.log(`[RoadTracker] (${roomName}) Overused no-structure squares after ${TRACKING_DURATION} ticks: ${overusedCount}`);
                }
            }

            // Draw red dots for all untraveled roads (persistent)
            if (mem.untraveledMatrix) {
                for (let y = 0; y < 50; y++) {
                    for (let x = 0; x < 50; x++) {
                        if (mem.untraveledMatrix[y][x] === 1) {
                            room.visual.circle(x, y, {
                                fill: 'red',
                                radius: 0.35,
                                opacity: 0.7,
                                stroke: 'red'
                            });
                        }
                    }
                }
            }

            // Draw green dots for all overused no-structure squares (persistent)
            if (mem.overusedNoStructureMatrix) {
                for (let y = 0; y < 50; y++) {
                    for (let x = 0; x < 50; x++) {
                        if (mem.overusedNoStructureMatrix[y][x] === 1) {
                            room.visual.circle(x, y, {
                                fill: 'green',
                                radius: 0.35,
                                opacity: 0.7,
                                stroke: 'green'
                            });
                        }
                    }
                }
            }
        }
    },

    // Returns array of {x, y} for all untraveled roads in a room
    getUntraveledRoads(roomName) {
        const mem = Memory.roadTracker && Memory.roadTracker[roomName];
        if (!mem || !mem.untraveledMatrix) return [];
        const arr = [];
        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) {
                if (mem.untraveledMatrix[y][x] === 1) {
                    arr.push({ x, y });
                }
            }
        }
        return arr;
    },

    // Returns array of {x, y} for all overused no-structure squares in a room
    getOverusedNoStructure(roomName) {
        const mem = Memory.roadTracker && Memory.roadTracker[roomName];
        if (!mem || !mem.overusedNoStructureMatrix) return [];
        const arr = [];
        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) {
                if (mem.overusedNoStructureMatrix[y][x] === 1) {
                    arr.push({ x, y });
                }
            }
        }
        return arr;
    }
};

module.exports = roadTracker;
