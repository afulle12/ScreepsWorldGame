// =================================================================================================
// |                                                                                               |
// |                                     HOW TO USE THIS SCOUT                                     |
// |                                                                                               |
// | 1. To spawn a scout and send it to a specific room to start exploring:                        |
// |    require('roleScout').orderExplore('W1N8'); // (Target Room Name)                           |
// |                                                                                               |
// | 2. To order a scout for a specific mission (e.g., check if a path is clear):                  |
// |    require('roleScout').orderCheckRoom('E2N47', 'E9N44'); // (From, To)                        |
// |                                                                                               |
// | 3. To spawn a "fire-and-forget" autonomous scout that explores on its own:                    |
// |    require('roleScout').orderAutonomousScout();                                               |
// |                                                                                               |
// | 4. To find a safe path from one room to another, retrying until a path is found:              |
// |    require('roleScout').orderPathfinder('W1N8', 'E5N8'); // (From, To)                         |
// |                                                                                               |
// | 5. To spawn a scout that autonomously finds inter-shard portals and traverses them:           |
// |    require('roleScout').orderAutonomousInterShardScout();                                     |
// |    require('roleScout').orderAutonomousInterShardScout('shard2'); // prefer specific shard    |
// |                                                                                               |
// | 6. To list all discovered inter-shard portals:                                               |
// |    require('roleScout').listInterShardPortals();                                              |
// |                                                                                               |
// =================================================================================================

// =================================================================
// CONFIGURATION
// =================================================================
const DETAILED_LOGGING = true; // Set to false to disable verbose scout console logs.
const FRIENDLY_PLAYERS = ['tarenty', 'AlFe', 'AnotherFriend']; // Add friendly usernames here
// =================================================================

const log = (message) => {
    if (DETAILED_LOGGING) {
        console.log(message);
    }
};

// =================================================================
// HELPER: Parse a room name into its numeric coordinates.
// Returns { xDir: 'W'|'E', x: number, yDir: 'N'|'S', y: number }
// or null if the name is invalid.
// =================================================================
const parseRoomName = function(roomName) {
    const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return null;
    return {
        xDir: match[1],
        x:    parseInt(match[2], 10),
        yDir: match[3],
        y:    parseInt(match[4], 10)
    };
};

// =================================================================
// HELPER: Given a room name, return a list of nearby highway
// intersection room names (coords divisible by 10).
// These are the rooms most likely to contain inter-shard portals.
// Searches outward in a small spiral so the scout picks the closest
// candidate first.
// =================================================================
const getNearbyHighwayRooms = function(fromRoomName, searchRadius) {
    searchRadius = searchRadius || 3; // how many highway steps out to look
    const parsed = parseRoomName(fromRoomName);
    if (!parsed) return [];

    // Convert to signed integers for easy maths
    const signedX = parsed.xDir === 'W' ? -parsed.x : parsed.x;
    const signedY = parsed.yDir === 'N' ? -parsed.y : parsed.y;

    // Nearest highway intersection (round to nearest multiple of 10)
    const baseHX = Math.round(signedX / 10) * 10;
    const baseHY = Math.round(signedY / 10) * 10;

    const candidates = [];
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        for (let dy = -searchRadius; dy <= searchRadius; dy++) {
            const hx = baseHX + dx * 10;
            const hy = baseHY + dy * 10;
            const xDir = hx < 0 ? 'W' : 'E';
            const yDir = hy < 0 ? 'N' : 'S';
            const name = `${xDir}${Math.abs(hx)}${yDir}${Math.abs(hy)}`;
            const dist = Game.map.getRoomLinearDistance(fromRoomName, name);
            candidates.push({ name, dist });
        }
    }

    // Sort nearest first, dedupe
    candidates.sort((a, b) => a.dist - b.dist);
    return [...new Map(candidates.map(c => [c.name, c])).values()].map(c => c.name);
};

const roleScout = {
    // =============================================================
    // NEW: orderAutonomousInterShardScout
    // Spawns a scout that independently hunts highway intersection
    // rooms for inter-shard portals and, once found, jumps through
    // them to continue autonomous exploration on the target shard.
    //
    // Usage:
    //   require('roleScout').orderAutonomousInterShardScout();
    //   require('roleScout').orderAutonomousInterShardScout('shard2');
    // =============================================================
    orderAutonomousInterShardScout: function(preferredShard) {
        let spawn = null;
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room.controller && room.controller.my) {
                const available = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
                if (available.length > 0) {
                    spawn = available[0];
                    break;
                }
            }
        }
        if (!spawn) {
            const msg = `❌ Error: No available spawn found to launch an inter-shard scout.`;
            console.log(msg);
            return msg;
        }

        // Build the initial queue of highway rooms to visit, nearest first
        const highwayQueue = getNearbyHighwayRooms(spawn.room.name, 3);

        const newName   = `ISScout_${Game.time % 1000}`;
        const body      = [MOVE];
        const memory    = {
            role:           'scout',
            task:           'interShardAutonomous',
            phase:          'findingPortals',      // findingPortals → traversing
            homeRoom:       spawn.room.name,
            homeShard:      Game.shard ? Game.shard.name : 'shard0',
            preferredShard: preferredShard || null, // null = take any inter-shard portal
            highwayQueue:   highwayQueue,            // rooms still to check
            checkedRooms:   [],                      // highway rooms already visited
            portalId:       null,
            portalRoom:     null,
        };

        const result = spawn.spawnCreep(body, newName, { memory });
        if (result === OK) {
            const shardNote = preferredShard ? ` (targeting ${preferredShard})` : ' (any shard)';
            const msg = `✅ Spawning inter-shard scout '${newName}' from ${spawn.room.name}${shardNote}.`;
            console.log(msg);
            return msg;
        } else {
            const msg = `❌ Failed to spawn inter-shard scout. Error code: ${result}`;
            console.log(msg);
            return msg;
        }
    },

    // =============================================================
    // NEW: listInterShardPortals
    // Prints all inter-shard portal data gathered by scouts so far.
    // =============================================================
    listInterShardPortals: function() {
        if (!Memory.interShardPortals || Object.keys(Memory.interShardPortals).length === 0) {
            console.log('No inter-shard portals discovered yet.');
            return;
        }
        console.log('=== INTER-SHARD PORTALS ===');
        for (const key in Memory.interShardPortals) {
            const p = Memory.interShardPortals[key];
            console.log(`  ${p.fromRoom} (${p.fromShard}) → ${p.toRoom} on ${p.toShard}  [found tick ${p.foundAt}]`);
        }
    },

    // =============================================================
    // NEW: runInterShardAutonomousTask
    // Called each tick for creeps with task === 'interShardAutonomous'.
    //
    // Phase flow:
    //   findingPortals  — travel through highway queue, scan each room
    //   traversing      — move onto the discovered portal tile
    //
    // After the shard jump the creep's memory transitions to the
    // standard 'autonomous' task so the existing runAutonomousTask
    // handler takes over on the new shard automatically.
    // =============================================================
    runInterShardAutonomousTask: function(creep) {
        const mem = creep.memory;

        // ── Phase: traversing ────────────────────────────────────
        if (mem.phase === 'traversing') {
            // PRIMARY check: have we already jumped? If so, transition to autonomous.
            // We do this BEFORE touching the portal so the task is only rewritten
            // after a confirmed shard change, not speculatively.
            const currentShard = Game.shard ? Game.shard.name : 'shard0';
            if (currentShard !== mem.homeShard) {
                log(`✅ Inter-shard scout [${creep.name}] confirmed jump to ${currentShard}! Switching to autonomous.`);
                mem.task        = 'autonomous';
                mem.phase       = null;
                mem.arrivedFrom = mem.homeShard;
                mem.homeRoom    = null;
                return;
            }

            // Try ID lookup first; if it fails and we're in the portal room,
            // re-scan by structure type so a stale ID doesn't stall us forever.
            let portal = Game.getObjectById(mem.portalId);

            if (!portal && creep.room.name === mem.portalRoom) {
                const found = creep.room.find(FIND_STRUCTURES, {
                    filter: s =>
                        s.structureType === STRUCTURE_PORTAL &&
                        s.destination && typeof s.destination === 'object' &&
                        s.destination.shard === mem.targetShard
                });
                if (found.length > 0) {
                    portal = found[0];
                    mem.portalId = portal.id; // refresh stale ID
                    log(`🌀 Inter-shard scout [${creep.name}] re-acquired portal reference in ${creep.room.name}.`);
                }
            }

            if (!portal) {
                if (creep.room.name !== mem.portalRoom) {
                    // Drifted away — travel back to the portal room
                    log(`🌀 Inter-shard scout [${creep.name}] lost portal, heading back to ${mem.portalRoom}.`);
                    this.travelToRoom(creep, mem.portalRoom);
                } else {
                    // In the right room, still nothing — portal may have expired; re-hunt
                    log(`⚠️ Inter-shard scout [${creep.name}] portal gone from ${mem.portalRoom}. Re-scanning highway rooms.`);
                    mem.phase      = 'findingPortals';
                    mem.portalId   = null;
                    mem.portalRoom = null;
                    mem.targetShard = null;
                    // Remove this room from checkedRooms so we re-visit it next pass
                    mem.checkedRooms = (mem.checkedRooms || []).filter(r => r !== creep.room.name);
                }
                return;
            }

            // Step onto the portal. Do NOT rewrite mem.task here —
            // the shard-name check at the top of the next tick will do that
            // only after the jump is confirmed.
            creep.say('🌀 Jump!');
            log(`🌀 Inter-shard scout [${creep.name}] stepping onto portal in ${creep.room.name} → ${mem.targetShard}.`);
            creep.moveTo(portal, { reusePath: 3, visualizePathStyle: false });
            return;
        }

        // ── Phase: findingPortals ─────────────────────────────────
        if (!mem.highwayQueue) mem.highwayQueue = [];
        if (!mem.checkedRooms) mem.checkedRooms = [];

        // If we're already in a highway room, scan it first
        if (creep.room.name !== mem.currentHighwayTarget || !mem.currentHighwayTarget) {
            // Pick next unchecked room from the queue
            while (mem.highwayQueue.length > 0 && mem.checkedRooms.includes(mem.highwayQueue[0])) {
                mem.highwayQueue.shift();
            }

            if (mem.highwayQueue.length === 0) {
                // Exhausted initial queue — expand the search radius
                log(`🔭 Inter-shard scout [${creep.name}] exhausted initial highway queue. Expanding search.`);
                const expanded = getNearbyHighwayRooms(creep.room.name, 6);
                mem.highwayQueue = expanded.filter(r => !mem.checkedRooms.includes(r));
                if (mem.highwayQueue.length === 0) {
                    console.log(`❌ Inter-shard scout [${creep.name}] could not find any new highway rooms to check. Suiciding.`);
                    creep.suicide();
                    return;
                }
            }

            mem.currentHighwayTarget = mem.highwayQueue[0];
            log(`🗺️ Inter-shard scout [${creep.name}] heading to highway room ${mem.currentHighwayTarget}.`);
        }

        // Travel to the current target highway room
        if (creep.room.name !== mem.currentHighwayTarget) {
            const result = this.travelToRoom(creep, mem.currentHighwayTarget);
            if (result === ERR_NO_PATH) {
                log(`⚠️ Inter-shard scout [${creep.name}] can't reach ${mem.currentHighwayTarget}. Skipping.`);
                mem.checkedRooms.push(mem.currentHighwayTarget);
                mem.highwayQueue.shift();
                mem.currentHighwayTarget = null;
            }
            return;
        }

        // ── We are in the highway room — scan for inter-shard portals ──
        if (!mem.checkedRooms.includes(creep.room.name)) {
            mem.checkedRooms.push(creep.room.name);
        }
        mem.highwayQueue = mem.highwayQueue.filter(r => r !== creep.room.name);

        const allPortals = creep.room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_PORTAL
        });

        // Filter to inter-shard portals only (destination has a .shard property)
        const interShardPortals = allPortals.filter(p =>
            p.destination && typeof p.destination === 'object' && p.destination.shard
        );

        if (interShardPortals.length === 0) {
            log(`🔭 Inter-shard scout [${creep.name}] found no inter-shard portals in ${creep.room.name}.`);
            mem.currentHighwayTarget = null;
            return;
        }

        // Pick the portal matching preferredShard, or just take the first one
        let chosenPortal = null;
        if (mem.preferredShard) {
            chosenPortal = interShardPortals.find(p => p.destination.shard === mem.preferredShard);
            if (!chosenPortal) {
                log(`ℹ️ Inter-shard scout [${creep.name}] found portals in ${creep.room.name} but none go to ${mem.preferredShard}. Continuing search.`);
                mem.currentHighwayTarget = null;
                return;
            }
        } else {
            chosenPortal = interShardPortals[0];
        }

        // Record the discovery in global Memory so it persists after the scout is gone
        if (!Memory.interShardPortals) Memory.interShardPortals = {};
        const portalKey = `${creep.room.name}_${chosenPortal.destination.shard}`;
        Memory.interShardPortals[portalKey] = {
            fromShard: mem.homeShard,
            fromRoom:  creep.room.name,
            toShard:   chosenPortal.destination.shard,
            toRoom:    chosenPortal.destination.room || '?',
            portalPos: chosenPortal.pos,
            foundAt:   Game.time
        };

        console.log(`🌀 Inter-shard scout [${creep.name}] found portal in ${creep.room.name} → ${chosenPortal.destination.shard} (${chosenPortal.destination.room || 'unknown room'}). Preparing to jump!`);
        Game.notify(`🌀 Inter-shard portal discovered in ${creep.room.name} → ${chosenPortal.destination.shard}`, 60);

        mem.portalId    = chosenPortal.id;
        mem.portalRoom  = creep.room.name;
        mem.targetShard = chosenPortal.destination.shard;
        mem.phase       = 'traversing';
    },

    // ─────────────────────────────────────────────────────────────
    // Everything below is unchanged from the original file
    // ─────────────────────────────────────────────────────────────

    orderExplore: function(destinationRoomName) {
        if (!destinationRoomName) return 'Error: destinationRoomName is required.';
        let bestSpawnRoom = null;
        let minDistance = Infinity;
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room.controller && room.controller.my) {
                const spawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
                if (spawns.length > 0) {
                    const distance = Game.map.getRoomLinearDistance(roomName, destinationRoomName);
                    if (distance < minDistance) {
                        minDistance = distance;
                        bestSpawnRoom = room;
                    }
                }
            }
        }
        if (!bestSpawnRoom) {
            const message = `❌ Error: No available spawn found to start exploration mission to ${destinationRoomName}.`;
            console.log(message);
            return message;
        }
        const spawn = bestSpawnRoom.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
        const newName = `Scout_${destinationRoomName}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', targetRoom: destinationRoomName };
        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            const message = `✅ Spawning scout '${newName}' from ${bestSpawnRoom.name} to explore ${destinationRoomName}.`;
            console.log(message);
            return message;
        } else {
            const errorMessage = `❌ Failed to spawn scout from ${bestSpawnRoom.name}. Error code: ${result}`;
            console.log(errorMessage);
            return errorMessage;
        }
    },

    orderCheckRoom: function(spawnRoomName, destinationRoomName) {
        if (!spawnRoomName || !destinationRoomName) return 'Error: Both spawnRoomName and destinationRoomName are required.';
        const spawnRoom = Game.rooms[spawnRoomName];
        if (!spawnRoom) return `Error: No vision in spawn room ${spawnRoomName}.`;
        const spawns = spawnRoom.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
        if (!spawns.length) return `Error: No available spawn in room ${spawnRoomName}.`;
        const spawn = spawns[0];
        const newName = `VisCheck_${destinationRoomName}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', task: 'checkRoom', destinationRoom: destinationRoomName, spawnRoom: spawnRoomName, pathTaken: [spawnRoomName] };
        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            const message = `✅ Spawning scout '${newName}' from ${spawnRoomName} to check room ${destinationRoomName}.`;
            console.log(message);
            return message;
        } else {
            const errorMessage = `❌ Failed to spawn scout. Error code: ${result}`;
            console.log(errorMessage);
            return errorMessage;
        }
    },

    orderAutonomousScout: function() {
        let spawn = null;
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (room.controller && room.controller.my) {
                const availableSpawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
                if (availableSpawns.length > 0) {
                    spawn = availableSpawns[0];
                    break;
                }
            }
        }
        if (!spawn) {
            const message = `❌ Error: No available spawn found to launch an autonomous scout.`;
            console.log(message);
            return message;
        }
        const newName = `AutoScout_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', task: 'autonomous', homeRoom: spawn.room.name };
        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            const message = `✅ Spawning autonomous scout '${newName}' from ${spawn.room.name}.`;
            console.log(message);
            return message;
        } else {
            const errorMessage = `❌ Failed to spawn autonomous scout from ${spawn.room.name}. Error code: ${result}`;
            console.log(errorMessage);
            return errorMessage;
        }
    },

    orderPathfinder: function(originRoomName, destinationRoomName) {
        if (!originRoomName || !destinationRoomName) return 'Error: Both originRoomName and destinationRoomName are required.';
        const missionId = `path_${originRoomName}_${destinationRoomName}`;
        if (!Memory.pathfindingMissions) Memory.pathfindingMissions = {};
        const existingMission = Memory.pathfindingMissions[missionId];
        if (existingMission && existingMission.status === 'active') return `ℹ️ Mission [${missionId}] is already active.`;
        if (existingMission && existingMission.status === 'success') return `✅ Mission [${missionId}] has already succeeded. Path: ${existingMission.foundPath.join(' → ')}`;
        Memory.pathfindingMissions[missionId] = { origin: originRoomName, destination: destinationRoomName, status: 'initializing', attempts: 0, blacklistedRooms: {}, activeScout: null, foundPath: null, startTime: Game.time };
        console.log(`🚀 Initializing new pathfinding mission [${missionId}] from ${originRoomName} to ${destinationRoomName}.`);
        return this.spawnPathfinderScout(missionId);
    },

    spawnPathfinderScout: function(missionId) {
        if (!Memory.pathfindingMissions || !Memory.pathfindingMissions[missionId]) {
            return `Error: Cannot find mission data for ${missionId}.`;
        }
        const mission = Memory.pathfindingMissions[missionId];
        if (mission.blacklistedRooms[mission.origin]) {
            mission.status = 'failed';
            mission.failureReason = `Origin room ${mission.origin} is impassable or dangerous.`;
            const message = `❌ Pathfinding Mission [${missionId}] Failed: ${mission.failureReason}`;
            console.log(message);
            Game.notify(message, 60);
            return message;
        }
        const preflightRoute = Game.map.findRoute(mission.origin, mission.destination, {
            routeCallback: (roomName) => {
                if (mission.blacklistedRooms[roomName]) return Infinity;
                return 1;
            }
        });
        if (preflightRoute === ERR_NO_PATH || preflightRoute.length === 0) {
            mission.status = 'failed';
            mission.failureReason = `No possible global path exists from ${mission.origin} to ${mission.destination} with the current blacklist.`;
            const message = `❌ Pathfinding Mission [${missionId}] Failed: ${mission.failureReason}`;
            console.log(message);
            Game.notify(message, 60);
            return message;
        }
        const spawnRoom = Game.rooms[mission.origin];
        if (!spawnRoom || !spawnRoom.controller || !spawnRoom.controller.my) {
            mission.status = 'failed';
            mission.failureReason = `No vision or control in origin room ${mission.origin}.`;
            console.log(`❌ Mission [${missionId}] Failed: ${mission.failureReason}`);
            Game.notify(`❌ Mission [${missionId}] Failed: ${mission.failureReason}`);
            return mission.failureReason;
        }
        const spawns = spawnRoom.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
        if (!spawns.length) {
            return `Warning: No available spawn in room ${mission.origin} to continue mission [${missionId}].`;
        }
        const spawn = spawns[0];
        mission.attempts += 1;
        const newName = `Pathfinder_${missionId.replace(/_/g, '')}_${Game.time % 1000}`;
        const body = [MOVE];
        const memory = { role: 'scout', task: 'pathfinder', missionId: missionId, originRoom: mission.origin, destinationRoom: mission.destination, pathTaken: [mission.origin] };
        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            mission.status = 'active';
            mission.activeScout = newName;
            const message = `✅ Spawning pathfinder scout '${newName}' (Attempt #${mission.attempts}) for mission [${missionId}].`;
            console.log(message);
            return message;
        } else {
            mission.attempts -= 1;
            return `❌ Failed to spawn pathfinder scout for mission [${missionId}]. Error code: ${result}`;
        }
    },

    handleDeadCreeps: function() {
        if (!Memory.creeps) return;
        for (const name in Memory.creeps) {
            if (Game.creeps[name]) continue;
            const memory = Memory.creeps[name];
            if (memory.role !== 'scout') {
                delete Memory.creeps[name];
                continue;
            }

            if (memory.task === 'pathfinder') {
                const missionId = memory.missionId;
                const mission = Memory.pathfindingMissions ? Memory.pathfindingMissions[missionId] : undefined;
                if (mission && mission.status === 'active' && mission.activeScout === name) {
                    const deathRoom = memory.lastAttackedIn || memory.lastRoom;

                    if (deathRoom) {
                        this.markRoomAsDangerous(deathRoom, 'pathfinder_death', true);
                        mission.blacklistedRooms[deathRoom] = true;
                        console.log(`💀 Pathfinder [${name}] died in ${deathRoom}. Room blacklisted globally and for mission [${missionId}].`);
                        this.spawnPathfinderScout(missionId);
                    } else {
                        mission.status = 'failed';
                        mission.failureReason = `Scout [${name}] died in an unknown location.`;
                        const message = `❌ Pathfinding Mission [${missionId}] Failed: ${mission.failureReason}`;
                        console.log(message);
                        Game.notify(message, 60);
                    }
                }
            } else if (memory.task === 'checkRoom' && !memory.notificationSent) {
                const deathRoom = memory.lastAttackedIn || memory.lastRoom;
                if (deathRoom) {
                    this.markRoomAsDangerous(deathRoom, 'scout_death', true);
                    console.log(`💀 Scout [${name}] died in ${deathRoom}. Room marked as dangerous.`);
                }

                const message = `❌ Mission Failed: Scout [${name}] died before reaching ${memory.destinationRoom}.`;
                Game.notify(message, 0);
                console.log(message);
            }

            delete Memory.creeps[name];
        }
    },

    run: function(creep) {
        if (creep.spawning) return;

        if (creep.memory.lastRoom !== creep.room.name) {
            creep.memory.previousRoom = creep.memory.lastRoom;
            creep.memory.lastRoom = creep.room.name;

            if (!creep.memory.backtracking) {
                delete creep.memory.localBlacklist;
            }

            if (creep.memory.task === 'pathfinder') {
                log(`Pathfinder [${creep.name}] mission [${creep.memory.missionId}] entered new room: ${creep.room.name}`);
            }
        }

        if (this.checkForDanger(creep)) {
            return;
        }

        if (creep.memory.task === 'interShardAutonomous') {
            this.runInterShardAutonomousTask(creep);
        } else if (creep.memory.task === 'pathfinder') {
            this.runPathfinderTask(creep);
        } else if (creep.memory.task === 'checkRoom') {
            this.runCheckRoomTask(creep);
        } else {
            this.runAutonomousTask(creep);
        }
    },

    travelToRoom: function(creep, targetRoomName) {
        if (!creep.memory.route || creep.memory.routeTarget !== targetRoomName) {
            delete creep.memory.route;
            creep.memory.backtracking = false;

            log(`🗺️ Scout [${creep.name}] calculating new route from ${creep.room.name} to ${targetRoomName}.`);
            const missionBlacklist = (creep.memory.task === 'pathfinder' && Memory.pathfindingMissions && Memory.pathfindingMissions[creep.memory.missionId])
                ? Memory.pathfindingMissions[creep.memory.missionId].blacklistedRooms
                : {};
            if (Object.keys(missionBlacklist).length > 0) log(`   - Mission blacklist: [${Object.keys(missionBlacklist).join(', ')}]`);
            if (creep.memory.localBlacklist && Object.keys(creep.memory.localBlacklist).length > 0) log(`   - Temp local blacklist: [${Object.keys(creep.memory.localBlacklist).join(', ')}]`);

            const route = Game.map.findRoute(creep.room.name, targetRoomName, {
                routeCallback: (roomName) => {
                    if (creep.memory.task === 'pathfinder') {
                        if (missionBlacklist[roomName]) return Infinity;
                        if (creep.memory.localBlacklist && creep.memory.localBlacklist[roomName]) return Infinity;
                    } else {
                        if (this.isRoomDangerous(roomName)) return Infinity;
                    }
                    return 1;
                }
            });

            if (route === ERR_NO_PATH || route.length === 0) {
                log(`❌ Scout [${creep.name}] found NO GLOBAL PATH to ${targetRoomName}. All exits may be blocked or blacklisted.`);
                return ERR_NO_PATH;
            }
            log(`   ✔️ Path found for [${creep.name}]: ${JSON.stringify(route.map(r => r.room))}`);
            creep.memory.route = route;
            creep.memory.routeTarget = targetRoomName;
        }

        const route = creep.memory.route;
        if (route && route.length > 0) {
            if (route[0].room === creep.room.name) {
                route.shift();
            }
            if (route.length > 0) {
                const exit = creep.pos.findClosestByPath(route[0].exit);
                if (exit) {
                    log(`   🏃 [${creep.name}] moving towards exit to ${route[0].room}.`);
                    creep.moveTo(exit, { reusePath: 5, ignoreCreeps: true, visualizePathStyle: false });
                    return OK;
                } else {
                    const failedExitRoom = route[0].room;
                    log(`   ⚠️ [${creep.name}] could not find a LOCAL path to the exit for room ${failedExitRoom}. Adding to temporary blacklist and will recalculate route.`);

                    if (!creep.memory.localBlacklist) {
                        creep.memory.localBlacklist = {};
                    }
                    creep.memory.localBlacklist[failedExitRoom] = true;
                    creep.memory.backtracking = true;
                    delete creep.memory.route;
                    return OK;
                }
            }
        }
        delete creep.memory.route;
        return OK;
    },

    runPathfinderTask: function(creep) {
        const missionId = creep.memory.missionId;
        const mission = Memory.pathfindingMissions ? Memory.pathfindingMissions[missionId] : undefined;
        if (!mission || mission.status !== 'active') {
            creep.say('✅ Over');
            creep.suicide();
            return;
        }
        const destination = creep.memory.destinationRoom;
        if (creep.room.name === destination) {
            if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
            const pathString = creep.memory.pathTaken.join(' → ');
            mission.status = 'success';
            mission.foundPath = creep.memory.pathTaken;
            mission.finishTime = Game.time;
            const message = `✅ Path Found! Mission [${missionId}] succeeded.\nRoute: ${pathString}`;
            console.log(message);
            Game.notify(message, 60);
            creep.say('✅ Path!');
            creep.suicide();
            return;
        }
        if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
        const travelResult = this.travelToRoom(creep, destination);
        if (travelResult === ERR_NO_PATH) {
            log(`Pathfinder [${creep.name}] is stuck in ${creep.room.name}. Terminating scout to trigger retry.`);
            creep.say('🚫 Stuck');
            creep.suicide();
        }
    },

    runCheckRoomTask: function(creep) {
        const destination = creep.memory.destinationRoom;
        if (creep.room.name === destination) {
            if (!creep.memory.notificationSent) {
                if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
                const pathString = creep.memory.pathTaken.join(' → ');
                const message = `✅ Mission Complete: Scout [${creep.name}] reached ${destination}.\nPath: ${pathString}`;
                Game.notify(message, 0);
                console.log(message);
                creep.memory.notificationSent = true;
                creep.say('✅ Done!');
            }
            this.idle(creep);
        } else {
            if (creep.memory.pathTaken[creep.memory.pathTaken.length - 1] !== creep.room.name) creep.memory.pathTaken.push(creep.room.name);
            const travelResult = this.travelToRoom(creep, destination);
            if (travelResult === ERR_NO_PATH) {
                if (!creep.memory.notificationSent) {
                    const message = `❌ Mission Failed: Scout [${creep.name}] could not find a safe path to ${destination}.`;
                    Game.notify(message, 0);
                    console.log(message);
                    creep.memory.notificationSent = true;
                }
                creep.say('🚫 Path');
                creep.suicide();
            }
        }
    },

    runAutonomousTask: function(creep) {
        if (creep.memory.fleeing) {
            if (creep.room.name === creep.memory.previousRoom || !creep.memory.previousRoom) {
                log(`✅ Scout ${creep.name} successfully fled. Looking for new target.`);
                delete creep.memory.fleeing;
                this.assignTargetRoom(creep);
            } else {
                creep.say('😱 RUN!');
                creep.moveTo(new RoomPosition(25, 25, creep.memory.previousRoom));
                return;
            }
        }
        if (!Memory.exploration) Memory.exploration = {};
        if (!Memory.exploration.rooms) Memory.exploration.rooms = {};
        if (!Memory.ownedRooms) Memory.ownedRooms = [];
        if (!Memory.dangerousRooms) Memory.dangerousRooms = {};
        if (!creep.memory.targetRoom) this.assignTargetRoom(creep);
        if (creep.memory.lastRoom !== creep.room.name) {
            creep.memory.roomScanned = false;
            delete creep.memory.route;
            if (!creep.memory.visitedRooms) creep.memory.visitedRooms = {};
            creep.memory.visitedRooms[creep.room.name] = Game.time;
            log(`🔍 Scout ${creep.name} entered room ${creep.room.name} (target: ${creep.memory.targetRoom})`);
        }
        if (creep.room.name !== creep.memory.targetRoom) {
            this.travelToRoom(creep, creep.memory.targetRoom);
        } else {
            log(`🎯 Scout ${creep.name} arrived at target room ${creep.room.name}`);
            this.gatherIntelligence(creep);
            log(`⏱️ Scout ${creep.name} finished scanning ${creep.room.name}, looking for new target`);
            this.assignTargetRoom(creep);
        }
    },

    idle: function(creep) {
        const idlePosition = new RoomPosition(48, 48, creep.room.name);
        if (!creep.pos.isEqualTo(idlePosition)) creep.moveTo(idlePosition);
    },

    checkForDanger: function(creep) {
        const room = creep.room;
        if (room.controller && room.controller.owner && FRIENDLY_PLAYERS.includes(room.controller.owner.username)) return false;

        if (creep.hits < creep.hitsMax && (!creep.memory.lastHits || creep.memory.lastHits > creep.hits)) {
            creep.memory.lastAttackedIn = creep.room.name;

            if (creep.memory.task !== 'pathfinder' && creep.memory.task !== 'interShardAutonomous') {
                this.markRoomAsDangerous(creep.room.name, 'hostile_creeps', false);
                log(`⚔️ DANGER! Scout ${creep.name} under attack in ${creep.room.name}!`);
                creep.memory.fleeing = true;
                return true;
            } else {
                log(`⚔️ Scout ${creep.name} taking damage in ${creep.room.name} but continuing mission`);
            }
        }
        creep.memory.lastHits = creep.hits;

        const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
        if (towers.length > 0) {
            if (creep.memory.task !== 'pathfinder' && creep.memory.task !== 'interShardAutonomous') {
                this.markRoomAsDangerous(creep.room.name, 'hostile_towers', true);
                creep.memory.lastAttackedIn = creep.room.name;
                log(`🏰 DANGER! Scout ${creep.name} detected hostile towers in ${creep.room.name}!`);
                creep.memory.fleeing = true;
                return true;
            } else {
                log(`🏰 Scout ${creep.name} detected hostile towers in ${creep.room.name} but continuing mission`);
            }
        }

        return false;
    },

    markRoomAsDangerous: function(roomName, reason, permanent) {
        if (!Memory.dangerousRooms) Memory.dangerousRooms = {};
        const cooldownTime = permanent ? 999999999 : 50000;
        Memory.dangerousRooms[roomName] = {
            markedAt: Game.time,
            reason: reason,
            cooldownUntil: Game.time + cooldownTime,
            permanent: permanent
        };

        const reasonText = {
            'hostile_creeps': 'hostile creeps',
            'hostile_towers': 'hostile towers',
            'pathfinder_death': 'pathfinder scout death',
            'scout_death': 'scout death'
        }[reason] || reason;

        if (Memory.pathfindingMissions) {
            for (const missionId in Memory.pathfindingMissions) {
                const mission = Memory.pathfindingMissions[missionId];
                if (mission.status === 'active') {
                    mission.blacklistedRooms[roomName] = true;
                    console.log(`Added dangerous room ${roomName} to mission ${missionId} blacklist`);
                }
            }
        }

        if (permanent) console.log(`🚫 PERMANENTLY AVOIDING room ${roomName} due to ${reasonText}`);
        else console.log(`⏰ Avoiding room ${roomName} for ${cooldownTime} ticks due to ${reasonText}`);
    },

    isRoomDangerous: function(roomName) {
        if (!Memory.dangerousRooms || !Memory.dangerousRooms[roomName]) return false;
        const dangerData = Memory.dangerousRooms[roomName];
        if (dangerData.permanent) return true;
        if (Game.time > dangerData.cooldownUntil) {
            delete Memory.dangerousRooms[roomName];
            console.log(`✅ Room ${roomName} is no longer marked as dangerous.`);
            return false;
        }
        return true;
    },

    clearDangerousRoom: function(roomName) {
        if (Memory.dangerousRooms && Memory.dangerousRooms[roomName]) {
            delete Memory.dangerousRooms[roomName];
            console.log(`🔓 Manually cleared dangerous room: ${roomName}`);
            return true;
        }
        return false;
    },

    listDangerousRooms: function() {
        if (!Memory.dangerousRooms || Object.keys(Memory.dangerousRooms).length === 0) {
            console.log("No dangerous rooms tracked.");
            return;
        }
        console.log("=== DANGEROUS ROOMS ===");
        for (const roomName in Memory.dangerousRooms) {
            const data = Memory.dangerousRooms[roomName];
            const status = data.permanent ? "PERMANENT" : `${data.cooldownUntil - Game.time} ticks remaining`;
            console.log(`${roomName}: ${data.reason} - ${status}`);
        }
    },

    showScoutStatus: function() {
        console.log("=== SCOUT STATUS ===");
        for (const creepName in Game.creeps) {
            const creep = Game.creeps[creepName];
            if (creep.memory.role === 'scout') {
                const taskInfo = creep.memory.task ? ` (${creep.memory.task})` : '';
                const target = creep.memory.task === 'checkRoom' || creep.memory.task === 'pathfinder'
                    ? creep.memory.destinationRoom
                    : creep.memory.task === 'interShardAutonomous'
                        ? `[portal hunting → ${creep.memory.preferredShard || 'any shard'}] phase:${creep.memory.phase}`
                        : creep.memory.targetRoom;
                console.log(`${creep.name}${taskInfo}: ${creep.room.name} → ${target} (HP: ${creep.hits}/${creep.hitsMax})`);
            }
        }
    },

    assignTargetRoom: function(creep) {
        delete creep.memory.routeBlacklist;
        delete creep.memory.route;
        const exits = Game.map.describeExits(creep.room.name);
        if (!exits) return;
        if (!creep.memory.visitedRooms) creep.memory.visitedRooms = {};
        const candidateRooms = [];
        for (const dir in exits) {
            const roomName = exits[dir];
            if (Game.rooms[roomName] && Game.rooms[roomName].controller && Game.rooms[roomName].controller.my) continue;
            const recentlyVisited = creep.memory.visitedRooms[roomName] && (Game.time - creep.memory.visitedRooms[roomName] < 500);
            const isDangerous = this.isRoomDangerous(roomName);
            if (!recentlyVisited && !isDangerous) candidateRooms.push(roomName);
        }
        if (candidateRooms.length > 0) {
            const targetRoom = candidateRooms[Math.floor(Math.random() * candidateRooms.length)];
            creep.memory.targetRoom = targetRoom;
            creep.say('🚪' + targetRoom);
            log(`🆕 Scout ${creep.name} assigned NEW target: ${targetRoom}`);
            return;
        }
        let oldestVisit = Game.time;
        let oldestRoom = null;
        for (const dir in exits) {
            const roomName = exits[dir];
            if (!this.isRoomDangerous(roomName)) {
                const lastVisit = creep.memory.visitedRooms[roomName] || 0;
                if (lastVisit < oldestVisit) {
                    oldestVisit = lastVisit;
                    oldestRoom = roomName;
                }
            }
        }
        if (oldestRoom) {
            creep.memory.targetRoom = oldestRoom;
            creep.say('🔄' + oldestRoom);
            log(`🔄 Scout ${creep.name} assigned OLD target: ${oldestRoom}`);
        } else {
            creep.memory.targetRoom = creep.room.name;
            creep.say('🏠 SAFE');
            console.log(`⚠️ Scout ${creep.name} has no safe rooms to explore, staying put.`);
        }
    },

    gatherIntelligence: function(creep) {
        if (creep.memory.roomScanned) return;
        const room = creep.room;
        const roomName = room.name;
        if (!Memory.exploration.rooms[roomName]) Memory.exploration.rooms[roomName] = {};
        Memory.exploration.rooms[roomName].lastVisit = Game.time;
        Memory.exploration.rooms[roomName].sources = room.find(FIND_SOURCES).map(s => ({ id: s.id, pos: s.pos }));
        if (room.controller) Memory.exploration.rooms[roomName].controller = { id: room.controller.id, pos: room.controller.pos, owner: room.controller.owner ? room.controller.owner.username : null, level: room.controller.level };
        Memory.exploration.rooms[roomName].minerals = room.find(FIND_MINERALS).map(m => ({ id: m.id, pos: m.pos, mineralType: m.mineralType }));
        Memory.exploration.rooms[roomName].exits = Game.map.describeExits(roomName);
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        Memory.exploration.rooms[roomName].hostile = hostiles.length > 0;
        let ownerInfo = (room.controller && room.controller.owner) ? ` (owned by ${room.controller.owner.username})` : '';
        log(`📊 Scout ${creep.name} scanned ${roomName}: ${room.find(FIND_SOURCES).length} sources, ${room.find(FIND_MINERALS).length} minerals, ${hostiles.length} hostiles${ownerInfo}`);

        if (!Memory.scoutIntel) Memory.scoutIntel = {};
        Memory.scoutIntel[roomName] = {
            sources:      room.find(FIND_SOURCES).map(s => s.id),
            owner:        room.controller ? (room.controller.owner ? room.controller.owner.username : null) : null,
            reservation:  room.controller ? room.controller.reservation : null,
            lastScouted:  Game.time
        };
        log(`[Remote Harvest] Saved intel for ${roomName}.`);
        creep.memory.roomScanned = true;
    }
};

module.exports = roleScout;