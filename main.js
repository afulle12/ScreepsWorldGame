// Import role modules
const roleHarvester = require('roleHarvester');
const roleUpgrader = require('roleUpgrader');
const roleBuilder = require('roleBuilder');
const roleScout = require('roleScout');
const roleDefender = require('roleDefender');
const roleSupplier = require('roleSupplier');
const roleClaimbot = require('roleClaimbot');
const roadTracker = require('roadTracker');

// Constants for body parts
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER = [TOUGH, MOVE, RANGED_ATTACK];
const CRIPPLED_HARVESTER = [WORK, CARRY, MOVE];
const CARRY_ONLY = [CARRY, MOVE];
const SCOUT_BODY = [MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE];

// --- LINK LOGIC ---
function runLinks() {
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;

        // Find all links in the room
        const links = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_LINK }
        });

        if(links.length < 2) continue; // Need at least 2 links to transfer

        // Find storage in the room
        const storage = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_STORAGE }
        })[0];

        if(!storage || !room.controller) continue;

        // Find link closest to storage
        const storageLink = storage.pos.findClosestByRange(links);

        // Find link closest to controller
        const controllerLink = room.controller.pos.findClosestByRange(links);

        // Transfer energy from storage link to controller link
        if(storageLink && controllerLink &&
           storageLink.id !== controllerLink.id &&
           storageLink.cooldown === 0) {

            // Only transfer if storage link has energy and controller link is below 400 energy
            if(storageLink.store[RESOURCE_ENERGY] > 0 &&
               controllerLink.store[RESOURCE_ENERGY] < 400) {

                const result = storageLink.transferEnergy(controllerLink);
                if(result === OK) {
                    console.log(`Link transfer: ${storageLink.pos} -> ${controllerLink.pos} in ${roomName}`);
                }
            }
        }
    }
}

// --- TOWER LOGIC ---
function runTowers() {
    if (!Memory.towerTargets) Memory.towerTargets = {};

    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;

        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_TOWER }
        });

        for(const tower of towers) {
            // Find all hostile creeps
            const hostiles = room.find(FIND_HOSTILE_CREEPS);

            // Filter for hostiles with HEAL parts
            const healers = hostiles.filter(c => c.body.some(part => part.type === HEAL));

            // --- Tower Target Tracking Logic ---
            // Initialize memory for this tower
            if (!Memory.towerTargets[tower.id]) {
                Memory.towerTargets[tower.id] = {
                    targetId: null,
                    lastHp: null,
                    sameHpTicks: 0
                };
            }
            const mem = Memory.towerTargets[tower.id];

            // Determine target: prioritize healers, then other hostiles
            let target = null;
            if (healers.length > 0) {
                // Find closest healer
                target = tower.pos.findClosestByRange(healers);
            } else if (hostiles.length > 0) {
                // Find closest hostile
                target = tower.pos.findClosestByRange(hostiles);
            }

            // If we have a target, check if we should switch
            if (target) {
                // If new target or target changed, reset memory
                if (mem.targetId !== target.id) {
                    mem.targetId = target.id;
                    mem.lastHp = target.hits;
                    mem.sameHpTicks = 0;
                } else {
                    // Same target as last tick
                    if (mem.lastHp === target.hits) {
                        mem.sameHpTicks++;
                    } else {
                        mem.sameHpTicks = 0;
                        mem.lastHp = target.hits;
                    }
                }

                // If we've shot for 5 ticks and health hasn't changed, switch target
                if (mem.sameHpTicks >= 5) {
                    // Try to find a different hostile (not this one)
                    const otherHostiles = hostiles.filter(h => h.id !== target.id);
                    if (otherHostiles.length > 0) {
                        const newTarget = tower.pos.findClosestByRange(otherHostiles);
                        if (newTarget) {
                            mem.targetId = newTarget.id;
                            mem.lastHp = newTarget.hits;
                            mem.sameHpTicks = 0;
                            tower.attack(newTarget);
                            continue;
                        }
                    }
                    // If no other hostiles, just keep attacking the same target
                }

                tower.attack(target);
                continue;
            } else {
                // No hostile, reset memory for this tower
                mem.targetId = null;
                mem.lastHp = null;
                mem.sameHpTicks = 0;
            }

            // Heal friendly creeps if needed
            const injured = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
                filter: c => c.hits < c.hitsMax
            });
            if(injured) {
                tower.heal(injured);
                continue;
            }

            // Repair structures (excluding walls/ramparts)
            const damaged = tower.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: s =>
                    s.hits < s.hitsMax &&
                    s.structureType !== STRUCTURE_WALL &&
                    s.structureType !== STRUCTURE_RAMPART
            });
            if(damaged) {
                tower.repair(damaged);
                continue;
            }

            // Repair walls/ramparts only if below 20,000,000 HP and tower has >77% energy (lowest priority)
            const energyReserve = tower.store.getCapacity(RESOURCE_ENERGY) * 0.77;
            if(tower.store[RESOURCE_ENERGY] > energyReserve) {
                const damagedWalls = room.find(FIND_STRUCTURES, {
                    filter: s =>
                        (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
                        s.hits < 20000000
                });

                if(damagedWalls.length > 0) {
                    // Sort by lowest health first
                    const mostDamagedWall = damagedWalls.sort((a, b) => a.hits - b.hits)[0];
                    tower.repair(mostDamagedWall);
                }
            }
        }
    }
}

// Calculate total energy across all storage structures
function calculateTotalEnergy() {
    let totalEnergy = 0;

    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;

        // Get energy from spawn
        const spawns = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_SPAWN }
        });
        for(const spawn of spawns) {
            totalEnergy += spawn.store[RESOURCE_ENERGY] || 0;
        }

        // Get energy from extensions
        const extensions = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_EXTENSION }
        });
        for(const extension of extensions) {
            totalEnergy += extension.store[RESOURCE_ENERGY] || 0;
        }

        // Get energy from storage
        const storages = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_STORAGE }
        });
        for(const storage of storages) {
            totalEnergy += storage.store[RESOURCE_ENERGY] || 0;
        }

        // Get energy from containers
        const containers = room.find(FIND_STRUCTURES, {
            filter: { structureType: STRUCTURE_CONTAINER }
        });
        for(const container of containers) {
            totalEnergy += container.store[RESOURCE_ENERGY] || 0;
        }
    }

    return totalEnergy;
}

// Track CPU usage over time
function trackCPUUsage() {
    if(!Memory.cpuStats) {
        Memory.cpuStats = {
            history: [],
            average: 0
        };
    }

    const cpuUsed = Game.cpu.getUsed();
    Memory.cpuStats.history.push(cpuUsed);

    // Keep only last 50 ticks for average calculation
    if(Memory.cpuStats.history.length > 50) {
        Memory.cpuStats.history.shift();
    }

    // Calculate rolling average
    Memory.cpuStats.average = Memory.cpuStats.history.reduce((sum, cpu) => sum + cpu, 0) / Memory.cpuStats.history.length;
}

// Track energy income rate over time
function trackEnergyIncome() {
    if(!Memory.energyIncomeTracker) {
        Memory.energyIncomeTracker = {
            history: [],
            totalIncome: 0,
            averageIncome: 0
        };
    }

    const currentEnergy = calculateTotalEnergy();
    const currentTick = Game.time;

    // Calculate income since last tick if we have previous data
    let incomeThisTick = 0;
    if(Memory.energyIncomeTracker.history.length > 0) {
        const lastEntry = Memory.energyIncomeTracker.history[Memory.energyIncomeTracker.history.length - 1];
        const energyIncrease = Math.max(0, currentEnergy - lastEntry.energy);
        incomeThisTick = energyIncrease;
        Memory.energyIncomeTracker.totalIncome += incomeThisTick;
    }

    // Add current data to history
    Memory.energyIncomeTracker.history.push({
        tick: currentTick,
        energy: currentEnergy,
        incomeThisTick: incomeThisTick
    });

    // Remove entries older than 100 ticks and update total
    while(Memory.energyIncomeTracker.history.length > 0 &&
          currentTick - Memory.energyIncomeTracker.history[0].tick > 100) {
        const removedEntry = Memory.energyIncomeTracker.history.shift();
        Memory.energyIncomeTracker.totalIncome -= removedEntry.incomeThisTick || 0;
    }

    // Calculate average income over the tracking period
    const trackingTicks = Memory.energyIncomeTracker.history.length;
    Memory.energyIncomeTracker.averageIncome = trackingTicks > 0 ?
        Memory.energyIncomeTracker.totalIncome / trackingTicks : 0;

    // Ensure totalIncome doesn't go negative
    Memory.energyIncomeTracker.totalIncome = Math.max(0, Memory.energyIncomeTracker.totalIncome);
}

// Get performance data for display
function getPerformanceData() {
    const cpuUsed = Game.cpu.getUsed();
    const cpuAverage = Memory.cpuStats ? Memory.cpuStats.average : 0;
    const cpuLimit = Game.cpu.limit;
    const cpuPercent = ((cpuUsed / cpuLimit) * 100).toFixed(1);

    const energyIncome = Memory.energyIncomeTracker ? Memory.energyIncomeTracker.averageIncome : 0;
    const trackingTicks = Memory.energyIncomeTracker ? Memory.energyIncomeTracker.history.length : 0;

    return {
        cpuUsed: Math.round(cpuUsed),
        cpuAverage: Math.round(cpuAverage),
        cpuPercent: cpuPercent,
        cpuLimit: cpuLimit,
        energyIncome: energyIncome.toFixed(2),
        trackingTicks: trackingTicks
    };
}

// Format time in days, hours, and minutes
function formatTime(totalMinutes) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = Math.floor(totalMinutes % 60);

    if (days > 0) {
        if (hours > 0) {
            return `${days}d ${hours}h ${minutes}m`;
        } else {
            return `${days}d ${minutes}m`;
        }
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

// Main game loop
module.exports.loop = function() {
    if(Game.time % 20 === 0) cleanMemory();

    // Cache per-room role counts and room data once per tick
    const perRoomRoleCounts = getPerRoomRoleCounts();
    const roomDataCache = cacheRoomData();

    // --- Run tower logic here ---
    runTowers();

    // --- Run link logic here ---
    runLinks();

    runCreeps();

    // --- CLAIMBOT SPAWN LOGIC ---
    manageClaimbotSpawns();

    if(needsNewCreeps(perRoomRoleCounts) || Game.time % 10 === 0) {
        manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache);
    }

    if(Game.time % 50 === 0) visualizeExploration();

    // === Moved CPU/energy tracking and status display to the end of the loop ===
    // Track performance metrics every tick (AFTER all logic)
    roadTracker.trackRoadVisits();
    roadTracker.visualizeUntraveledRoads();
    // Example: get array of untraveled roads for a room
    // const untraveled = roadTracker.getUntraveledRoads('W1N1');

    trackCPUUsage();
    trackEnergyIncome();

    if(Game.time % 50 === 0) {
        displayStatus(perRoomRoleCounts);
        suggestExpansion();
    }
}

// --- CLAIMBOT SPAWN LOGIC ---
function manageClaimbotSpawns() {
    if (!Memory.claimOrders) Memory.claimOrders = [];
    if (Memory.claimOrders.length === 0) return;

    const claimOrder = Memory.claimOrders[0];
    // Only spawn if we don't already have a claimbot for this room
    const existing = _.find(Game.creeps, c => c.memory.role === 'claimbot' && c.memory.targetRoom === claimOrder.room);
    if (existing) return;

    // Find the closest owned room with an idle spawn
    let closestSpawn = null;
    let closestDistance = Infinity;
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        const spawn = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_SPAWN }
        })[0];
        if (!spawn || spawn.spawning) continue;
        const distance = Game.map.getRoomLinearDistance(roomName, claimOrder.room);
        if (distance < closestDistance) {
            closestDistance = distance;
            closestSpawn = spawn;
        }
    }
    if (!closestSpawn) return;

    // You may want to add more MOVE if the target room is far away
    const claimBody = [CLAIM, ATTACK, MOVE, MOVE, MOVE];

    const cost = bodyCost(claimBody);
    const availableEnergy = closestSpawn.room.energyAvailable;

    const result = closestSpawn.spawnCreep(claimBody, 'claimbot' + Game.time, {
        memory: { role: 'claimbot', targetRoom: claimOrder.room }
    });
    if (result === OK) {
        console.log(`Spawning claimbot for ${claimOrder.room} | Cost: ${cost} | Energy before: ${availableEnergy}`);
        Memory.claimOrders.shift();
    } else {
        console.log(`Failed to spawn claimbot: ${result}`);
    }
}


// Clean memory only occasionally
function cleanMemory() {
    for(const name in Memory.creeps) {
        if(!Game.creeps[name]) delete Memory.creeps[name];
    }
}

// Cache per-room role counts - NEW MULTI-ROOM VERSION
function getPerRoomRoleCounts() {
    const perRoomCounts = {};

    // Initialize counts for all owned rooms
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(room.controller && room.controller.my) {
            perRoomCounts[roomName] = {
                harvester: 0, upgrader: 0, builder: 0, scout: 0,
                defender: 0, supplier: 0, claimbot: 0
            };
        }
    }

    // Count creeps assigned to each room
    for(const name in Game.creeps) {
        const creep = Game.creeps[name];
        const role = creep.memory.role;

        // Determine which room this creep is assigned to
        let assignedRoom = creep.room.name;

        // Check if creep has a specific room assignment
        if(creep.memory.assignedRoom) {
            assignedRoom = creep.memory.assignedRoom;
        }
        // For harvesters, check if they have a specific source room
        else if(creep.memory.sourceRoom) {
            assignedRoom = creep.memory.sourceRoom;
        }
        // For upgraders, check if they have a specific target room
        else if(creep.memory.targetRoom) {
            assignedRoom = creep.memory.targetRoom;
        }

        // Only count if it's an owned room and valid role
        if(perRoomCounts[assignedRoom] && perRoomCounts[assignedRoom][role] !== undefined) {
            perRoomCounts[assignedRoom][role]++;
        }
    }

    return perRoomCounts;
}

// Cache room data to memory to avoid repeated find() calls
function cacheRoomData() {
    if(!Memory.roomData) Memory.roomData = {};
    const cache = {};

    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;

        // Only update cache occasionally unless it doesn't exist
        const shouldUpdate = !Memory.roomData[roomName] || Game.time % 100 === 0;

        if(shouldUpdate) {
            if(!Memory.roomData[roomName]) Memory.roomData[roomName] = {};
            const sources = room.find(FIND_SOURCES);
            Memory.roomData[roomName].sources = sources.map(s => s.id);
            Memory.roomData[roomName].constructionSitesCount = room.find(FIND_CONSTRUCTION_SITES).length;

            // Calculate room energy capacity for spawn prioritization
            Memory.roomData[roomName].energyCapacity = room.energyCapacityAvailable;
            Memory.roomData[roomName].energyAvailable = room.energyAvailable;
        }
        cache[roomName] = Memory.roomData[roomName];
    }
    return cache;
}

// Check if any room needs new creeps - UPDATED FOR MULTI-ROOM
function needsNewCreeps(perRoomRoleCounts) {
    for(const roomName in perRoomRoleCounts) {
        const counts = perRoomRoleCounts[roomName];
        const totalCreeps = counts.harvester + counts.upgrader + counts.builder +
                           counts.scout + counts.defender + counts.supplier;

        // Emergency check - any room with no harvesters needs immediate attention
        if(counts.harvester === 0) return true;

        // Any room with very few total creeps needs attention
        if(totalCreeps < 3) return true;
    }
    return false;
}

// Run each creep's role behavior
function runCreeps() {
    for(const name in Game.creeps) {
        const creep = Game.creeps[name];
        if(creep.spawning) continue;

        // Throttle less critical roles
        const role = creep.memory.role;
        if(role === 'scout' && Game.time % 5 !== 0) continue;
        if((role === 'builder' || role === 'upgrader') && Game.time % 3 !== 0) continue;

        switch(role) {
            case 'harvester':
                roleHarvester.run(creep);
                break;
            case 'upgrader':
                roleUpgrader.run(creep);
                break;
            case 'builder':
                roleBuilder.run(creep);
                break;
            case 'scout':
                roleScout.run(creep);
                break;
            case 'defender':
                roleDefender.run(creep);
                break;
            case 'supplier':
                roleSupplier.run(creep);
                break;
            case 'claimbot':
                roleClaimbot.run(creep);
                break;
            default:
                creep.memory.role = 'harvester';
                break;
        }
    }
}

// Display colony status - UPDATED FOR PER-ROOM DISPLAY
function displayStatus(perRoomRoleCounts) {
    const TICK_WINDOW = 500; // 10 minutes at 4s/tick

    // Calculate per-room stats
    const perRoomStats = {};
    for(const name in Game.creeps) {
        const creep = Game.creeps[name];
        const assignedRoom = creep.memory.assignedRoom || creep.room.name;  // Fallback to current room

        if(!perRoomStats[assignedRoom]) {
            perRoomStats[assignedRoom] = {
                totalBodyParts: 0,
                totalCreeps: 0,
                totalTTL: 0,
                oldestCreepTTL: Infinity
            };
        }

        perRoomStats[assignedRoom].totalBodyParts += creep.body.length;
        perRoomStats[assignedRoom].totalCreeps += 1;
        if(creep.ticksToLive) {
            perRoomStats[assignedRoom].totalTTL += creep.ticksToLive;
            if(creep.ticksToLive < perRoomStats[assignedRoom].oldestCreepTTL) {
                perRoomStats[assignedRoom].oldestCreepTTL = creep.ticksToLive;
            }
        }
    }

    console.log(`=== COLONY STATUS ===`);
    for(const roomName in perRoomRoleCounts) {
        const counts = perRoomRoleCounts[roomName];
        const stats = perRoomStats[roomName] || { totalBodyParts: 0, totalCreeps: 0, totalTTL: 0, oldestCreepTTL: 0 };
        const avgBodyParts = stats.totalCreeps > 0 ? (stats.totalBodyParts / stats.totalCreeps).toFixed(1) : 0;
        const avgTTL = stats.totalCreeps > 0 ? Math.round(stats.totalTTL / stats.totalCreeps) : 0;
        const oldestTTL = stats.oldestCreepTTL === Infinity ? 0 : stats.oldestCreepTTL;

        console.log(`${roomName}: 🧑‍🌾 ${counts.harvester} | ⚡ ${counts.upgrader} | 🔨 ${counts.builder} | 🔭 ${counts.scout} | 🛡 ${counts.defender} | 🔋 ${counts.supplier} | 🤖 ${counts.claimbot} | Avg Parts: ${avgBodyParts} | Avg TTL: ${avgTTL} | Low TTL: ${oldestTTL}`);
    }

    // Performance tracking and display
    const perfData = getPerformanceData();
    const currentEnergy = calculateTotalEnergy();
    console.log(`💰 Total Energy: ${currentEnergy} | ⛏️ Income: ${perfData.energyIncome}/tick (last ${perfData.trackingTicks} ticks)`);
    console.log(`🖥️ CPU: ${perfData.cpuUsed}/${perfData.cpuLimit} (${perfData.cpuPercent}%) | Avg: ${perfData.cpuAverage}`);

    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(room.controller && room.controller.my) {
            const percent = (room.controller.progress / room.controller.progressTotal * 100);
            const progress = percent.toFixed(1);
            const energyPercent = (room.energyAvailable / room.energyCapacityAvailable * 100).toFixed(1);

            // --- Reliable ETA Calculation over 10 minutes (TICK_WINDOW) ---
            if(!Memory.progressTracker) Memory.progressTracker = {};
            if(!Memory.progressTracker[roomName]) Memory.progressTracker[roomName] = {};
            const tracker = Memory.progressTracker[roomName];

            // Reset if controller level changes
            if(tracker.level !== room.controller.level) {
                tracker.level = room.controller.level;
                tracker.history = [{ tick: Game.time, percent: percent }];
            }
            if(!tracker.history) tracker.history = [];

            // Add current sample
            tracker.history.push({ tick: Game.time, percent: percent });

            // Remove samples older than TICK_WINDOW
            while(tracker.history.length > 0 && tracker.history[0].tick < Game.time - TICK_WINDOW) {
                tracker.history.shift();
            }

            // Use the oldest sample in the window for ETA
            let etaString = '';
            if(tracker.history.length > 1) {
                const oldest = tracker.history[0];
                const newest = tracker.history[tracker.history.length - 1];
                const tickDelta = newest.tick - oldest.tick;
                const percentDelta = newest.percent - oldest.percent;
                if(tickDelta >= TICK_WINDOW && percentDelta > 0) {
                    const percentRemaining = 100 - newest.percent;
                    const rate = percentDelta / tickDelta; // percent per tick
                    const etaTicks = Math.ceil(percentRemaining / rate);
                    const etaMinutes = etaTicks * 4 / 60;

                    // **NEW: Format ETA with days, hours, and minutes**
                    const formattedTime = formatTime(etaMinutes);
                    etaString = ` | ETA: ${etaTicks} ticks (~${formattedTime})`;
                } else if(tickDelta >= TICK_WINDOW && percentDelta <= 0) {
                    etaString = ' | ETA: ∞ (no progress)';
                }
            }

            console.log(`Room ${roomName}: RCL ${room.controller.level} - Progress: ${progress}% | Energy: ${room.energyAvailable}/${room.energyCapacityAvailable} (${energyPercent}%)${etaString}`);
        }
    }
    if(Memory.exploration && Memory.exploration.rooms) {
        console.log(`Explored rooms: ${Object.keys(Memory.exploration.rooms).length}`);
    }
}

// NEW: Get room-specific targets based on room characteristics
function getRoomTargets(roomName, roomData, room) {
    const sourcesCount = roomData.sources ? roomData.sources.length : 2;
    const constructionSitesCount = roomData.constructionSitesCount || 0;

    // **Check if containers or storage exist in the room**
    const containers = room.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_CONTAINER }
    });
    const storage = room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_STORAGE }
    });

    const hasStorageStructures = containers.length > 0 || storage.length > 0;

    // Base targets adjusted for room characteristics
    return {
        harvester: Math.max(2, sourcesCount), // At least 2, preferably 1 per source
        upgrader: 2,
        //builder: constructionSitesCount > 0 ? 1 : 0, // Only spawn builders if there's work
        builder: 2, //temporary
        scout: 0, // Scouts can work globally
        defender: 0, // Spawn defenders as needed based on threats
        supplier: hasStorageStructures ? Math.min(3, Math.floor(sourcesCount * 1.5)) : 0 // Only spawn suppliers if storage structures exist
    };
}

// Manage spawning per room - COMPLETELY REWRITTEN FOR MULTI-ROOM
function manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache) {
    // Do not spawn normal creeps if a claimbot is being spawned this tick
    if (Memory.claimOrders && Memory.claimOrders.length > 0) return;

    // Initialize harvester spawn delay tracker
    if(!Memory.harvesterSpawnDelay) Memory.harvesterSpawnDelay = {};

    // Process each owned room
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;

        // Find spawn in this room
        const spawn = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_SPAWN }
        })[0];

        if(!spawn || spawn.spawning) continue;

        const roomData = roomDataCache[roomName] || {};
        const roleCounts = perRoomRoleCounts[roomName] || {};
        const roomTargets = getRoomTargets(roomName, roomData, room); // Pass room object

        // EMERGENCY MODE - if no harvesters in this room, build one immediately
        if(roleCounts.harvester === 0) {
            console.log(`EMERGENCY MODE in ${roomName}!!!`);
            let body = [];
            if(room.energyAvailable >= 200) {
                body = BASIC_HARVESTER;
            } else if(room.energyAvailable >= 150) {
                body = CRIPPLED_HARVESTER;
            }
            if(body.length > 0) {
                spawnCreepInRoom('harvester', body, spawn, roomName);
                continue; // Skip to next room
            } else {
                console.log(`Not enough energy in ${roomName} to spawn even a crippled harvester!`);
                continue;
            }
        }

        let roleToSpawn = null;

        // Priority order for spawning (defenders first, then essentials)
        if(roleCounts.defender < roomTargets.defender) {
            roleToSpawn = 'defender';
        } else if(roleCounts.harvester < roomTargets.harvester) {
            roleToSpawn = 'harvester';
        } else if(roleCounts.supplier < roomTargets.supplier) {
            roleToSpawn = 'supplier';
        } else if(roleCounts.upgrader < roomTargets.upgrader) {
            roleToSpawn = 'upgrader';
        } else if(roleCounts.builder < roomTargets.builder) {
            roleToSpawn = 'builder';
        } else if(roleCounts.scout < roomTargets.scout) {
            roleToSpawn = 'scout';
        }

        if(roleToSpawn) {
            // **NEW: Add 60 second delay for harvester spawning when energy is below 800**
            if(roleToSpawn === 'harvester') {
                const totalEnergy = calculateTotalEnergy();
                if(totalEnergy < 800) {
                    // Initialize delay tracker for this room if it doesn't exist
                    if(!Memory.harvesterSpawnDelay[roomName]) {
                        Memory.harvesterSpawnDelay[roomName] = { nextSpawnTime: Game.time + 60 };
                        console.log(`Low energy (${totalEnergy} < 800) - delaying harvester spawn in ${roomName} by 60 ticks`);
                        continue;
                    }

                    // Check if we need to wait more time before spawning harvester
                    if(Game.time < Memory.harvesterSpawnDelay[roomName].nextSpawnTime) {
                        continue; // Wait until the 60 tick delay passes
                    }

                    // Reset the delay tracker since we're about to spawn
                    delete Memory.harvesterSpawnDelay[roomName];
                }
            }

            const body = getCreepBody(roleToSpawn, room.energyAvailable);
            const success = spawnCreepInRoom(roleToSpawn, body, spawn, roomName);
        }
    }
}

// Get appropriate body based on role and energy
function getCreepBody(role, energy) {
    // Define body configurations for different energy levels by role
    const bodyConfigs = {
        harvester: {
            300: BASIC_HARVESTER,
            400: [WORK, WORK, WORK, CARRY, MOVE],
            550: [WORK, WORK, WORK, CARRY, WORK, MOVE],
            800: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE]
        },
        upgrader: {
            300: [WORK, CARRY, MOVE],
            400: [WORK, WORK, CARRY, CARRY, MOVE],
            550: [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
            800: [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
            1200: [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
            1800: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE]
        },

        builder: {
            300: [WORK, WORK, CARRY, MOVE],
            400: [WORK, WORK, WORK, CARRY, MOVE],
            550: [WORK, WORK, WORK, CARRY, MOVE, MOVE],
            800: [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
            1200: [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
        },

        defender: {
            300: BASIC_DEFENDER,
            550: [TOUGH, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE],
            800: [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE],
            1200: [TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE]
        },
        supplier: {
            300: [CARRY, CARRY, MOVE, MOVE],
            400: [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
            550: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
            800: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
            900: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
            1000: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
        },
        scout: {
            300: SCOUT_BODY
        }
    };

    // Special case handling
    if (role === 'scout') {
        return SCOUT_BODY;
    }

    // For low energy and common roles (preserving original behavior)
    if (energy <= 300 && role !== 'defender' && role !== 'supplier') {
        return BASIC_HARVESTER;
    }

    // Get the appropriate body configuration based on role and energy
    if (bodyConfigs[role]) {
        return getBestBody(bodyConfigs[role], energy);
    }

    // Default to harvester for unknown roles
    return getBestBody(bodyConfigs.harvester, energy);

    // Helper function to select the best body based on available energy
    function getBestBody(bodyTiers, availableEnergy) {
        const tiers = Object.keys(bodyTiers)
            .map(Number)
            .sort((a, b) => a - b);

        let bestTier = tiers[0];

        for (const tier of tiers) {
            if (availableEnergy >= tier) {
                bestTier = tier;
            } else {
                break;
            }
        }

        return bodyTiers[bestTier];
    }
}

// Helper: Calculate the cost of a creep body
function bodyCost(body) {
    const BODYPART_COST = {
        move: 50,
        work: 100,
        attack: 80,
        carry: 50,
        heal: 250,
        ranged_attack: 150,
        tough: 10,
        claim: 600
    };
    let cost = 0;
    for(const part of body) {
        // part can be a string or a constant, so get .toLowerCase()
        let type = typeof part === 'string' ? part.toLowerCase() : part;
        // If it's a constant, get its string name
        if(typeof type !== 'string' && type in BODYPART_COST) {
            cost += BODYPART_COST[type];
        } else if(typeof type === 'string' && BODYPART_COST[type]) {
            cost += BODYPART_COST[type];
        } else if(typeof part === 'number' && BODYPART_COST[part]) {
            cost += BODYPART_COST[part];
        }
    }
    return cost;
}

// Spawn a new creep in a specific room, with room assignment
function spawnCreepInRoom(role, body, spawn, roomName) {
    const newName = role + '_' + roomName + '_' + Game.time;
    const memory = {
        role: role,
        assignedRoom: roomName
    };

    // Add role-specific memory assignments
    if(role === 'harvester') {
        memory.sourceRoom = roomName;
    } else if(role === 'upgrader') {
        memory.targetRoom = roomName;
    }

    const availableEnergy = spawn.room.energyAvailable;
    const cost = bodyCost(body);

    const result = spawn.spawnCreep(body, newName, { memory: memory });

    if(result === OK) {
        console.log(`Spawning ${role} in ${roomName} with ${body.length} parts | Cost: ${cost} | Energy before: ${availableEnergy}`);
        return true;
    } else {
        console.log(`Failed to spawn ${role} in ${roomName}: ${result} (energy: ${availableEnergy}, cost: ${cost})`);
        return false;
    }
}

// Visualize exploration data
function visualizeExploration() {
    if(!Memory.exploration || !Memory.exploration.rooms) return;

    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        const visual = room.visual;

        const exits = Game.map.describeExits(roomName);
        const exitCoords = {
            [FIND_EXIT_TOP]: {x: 25, y: 5},
            [FIND_EXIT_RIGHT]: {x: 45, y: 25},
            [FIND_EXIT_BOTTOM]: {x: 25, y: 45},
            [FIND_EXIT_LEFT]: {x: 5, y: 25}
        };

        for(const dir in exits) {
            const neighborName = exits[dir];
            const neighborData = Memory.exploration.rooms[neighborName];

            if(neighborData) {
                const pos = exitCoords[dir];
                let color = 'white';
                let text = neighborName;

                if(neighborData.hostile) {
                    color = 'red';
                    text += ' ⚠️';
                }

                if(neighborData.controller && neighborData.controller.owner) {
                    color = 'purple';
                    text += ' 👑';
                }

                if(neighborData.sources.length > 0) {
                    text += ` ⚡${neighborData.sources.length}`;
                }

                visual.text(text, pos.x, pos.y, {color: color, fontSize: 7});
            }
        }
    }
}

// Suggest room expansion based on scout data
function suggestExpansion() {
    if(!Memory.exploration || !Memory.exploration.rooms) return;

    let bestRoom = null;
    let bestScore = -Infinity;

    for(const roomName in Memory.exploration.rooms) {
        const roomData = Memory.exploration.rooms[roomName];
        if(roomData.hostile || (roomData.controller && roomData.controller.owner)) continue;

        let score = 0;
        score += roomData.sources.length * 10;
        score += roomData.minerals.length * 5;

        for(const myRoomName in Game.rooms) {
            if(Game.rooms[myRoomName].controller && Game.rooms[myRoomName].controller.my) {
                const distance = Game.map.getRoomLinearDistance(myRoomName, roomName);
                score -= distance * 5;
            }
        }

        if(score > bestScore) {
            bestScore = score;
            bestRoom = roomName;
        }
    }

    if(bestRoom) {
        console.log(`Recommended expansion: ${bestRoom} (Score: ${bestScore})`);
    }
}
