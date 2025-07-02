// === CPU USAGE LOGGING TOGGLE VARIABLES ===
const ENABLE_CPU_LOGGING = false;      // Set to false to disable ALL CPU profiling/logging
const DISABLE_CPU_CONSOLE = false;    // Set to true to disable only CPU-related console.log output

// Import role modules
const roleHarvester = require('roleHarvester');
const roleUpgrader = require('roleUpgrader');
const roleBuilder = require('roleBuilder');
const roleScout = require('roleScout');
const roleDefender = require('roleDefender');
const roleSupplier = require('roleSupplier');
const roleClaimbot = require('roleClaimbot');
const roadTracker = require('roadTracker');
const iff = require('iff');

// Constants for body parts
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER = [TOUGH, MOVE, RANGED_ATTACK];
const CRIPPLED_HARVESTER = [WORK, CARRY, MOVE];
const CARRY_ONLY = [CARRY, MOVE];
const SCOUT_BODY = [MOVE, MOVE, MOVE, MOVE, MOVE];

// --- BUILDER PRIORITIES (copied from roleBuilder) ---
const PRIORITIES = [
    {
        type: 'repair',
        filter: s =>
            (s.structureType !== STRUCTURE_CONTAINER &&
             s.structureType !== STRUCTURE_WALL &&
             s.structureType !== STRUCTURE_RAMPART) &&
            (s.hits / s.hitsMax < 0.25) &&
            s.hits < s.hitsMax,
        label: 'Repair <25%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'build',
        filter: s => true,
        targetFinder: room => room.find(FIND_CONSTRUCTION_SITES),
        label: 'Build',
        need: s => `${s.progress}/${s.progressTotal}`,
        urgency: s => -s.progress,
    },
    {
        type: 'repair',
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.hits / s.hitsMax < 0.75 && s.hits < s.hitsMax,
        label: 'Repair Container <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'repair',
        filter: s =>
            s.structureType === STRUCTURE_ROAD &&
            (s.hits / s.hitsMax < 0.75) &&
            (s.hits / s.hitsMax >= 0.25) &&
            s.hits < s.hitsMax,
        label: 'Repair Road <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'repair',
        filter: s =>
            ![STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType) &&
            (s.hits / s.hitsMax < 0.75) &&
            (s.hits / s.hitsMax >= 0.25) &&
            s.hits < s.hitsMax,
        label: 'Repair Other <75%',
        need: s => `${s.hits}/${s.hitsMax}`,
        urgency: s => s.hits,
    },
    {
        type: 'reinforce',
        filter: s =>
            (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
            s.hits < 20000,
        label: 'Reinforce <20k',
        need: s => `${s.hits}/20000`,
        urgency: s => s.hits,
    },
    {
        type: 'collect',
        filter: r => r.amount > 50,
        targetFinder: room => room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 50 }),
        label: 'Collect >50',
        need: r => `${r.amount}`,
        urgency: r => -r.amount,
    },
];

// --- CPU PROFILING HELPER ---
if (ENABLE_CPU_LOGGING && !Memory.cpuProfile) Memory.cpuProfile = {};
function profileSection(name, fn) {
    if (!ENABLE_CPU_LOGGING) {
        fn();
        return;
    }
    const start = Game.cpu.getUsed();
    fn();
    const used = Game.cpu.getUsed() - start;
    if (!Memory.cpuProfile[name]) Memory.cpuProfile[name] = [];
    Memory.cpuProfile[name].push(used);
    if (Memory.cpuProfile[name].length > 50) Memory.cpuProfile[name].shift();
    if (!Memory.cpuProfileLastUsed) Memory.cpuProfileLastUsed = {};
    Memory.cpuProfileLastUsed[name] = Game.time;
}

// --- CPU PROFILE MEMORY CLEANUP ---
function cleanCpuProfileMemory(maxAge = 5000) {
    if (!Memory.cpuProfileLastUsed) return;
    const now = Game.time;
    for (const key in Memory.cpuProfileLastUsed) {
        if (now - Memory.cpuProfileLastUsed[key] > maxAge) {
            delete Memory.cpuProfile[key];
            delete Memory.cpuProfileLastUsed[key];
        }
    }
}

// --- LINK LOGIC ---
function runLinks() {
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;
        const links = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_LINK }
        });
        if(links.length < 2) continue;
        const storage = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_STORAGE }
        })[0];
        if(!storage || !room.controller) continue;
        const storageLink = storage.pos.findClosestByRange(links);
        const controllerLink = room.controller.pos.findClosestByRange(links);
        if(storageLink && controllerLink &&
           storageLink.id !== controllerLink.id &&
           storageLink.cooldown === 0) {
            if(storageLink.store[RESOURCE_ENERGY] > 0 &&
               controllerLink.store[RESOURCE_ENERGY] < 500) {
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
            // <<< MODIFIED HERE to use the IFF module to filter hostiles
            const hostiles = room.find(FIND_HOSTILE_CREEPS, {
                filter: creep => iff.isHostileCreep(creep)
            });
            const healers = hostiles.filter(c => c.body.some(part => part.type === HEAL));
            if (!Memory.towerTargets[tower.id]) {
                Memory.towerTargets[tower.id] = {
                    targetId: null,
                    lastHp: null,
                    sameHpTicks: 0
                };
            }
            const mem = Memory.towerTargets[tower.id];
            let target = null;
            if (healers.length > 0) {
                target = tower.pos.findClosestByRange(healers);
            } else if (hostiles.length > 0) {
                target = tower.pos.findClosestByRange(hostiles);
            }
            if (target) {
                if (mem.targetId !== target.id) {
                    mem.targetId = target.id;
                    mem.lastHp = target.hits;
                    mem.sameHpTicks = 0;
                } else {
                    if (mem.lastHp === target.hits) {
                        mem.sameHpTicks++;
                    } else {
                        mem.sameHpTicks = 0;
                        mem.lastHp = target.hits;
                    }
                }
                if (mem.sameHpTicks >= 5) {
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
                }
                tower.attack(target);
                continue;
            } else {
                mem.targetId = null;
                mem.lastHp = null;
                mem.sameHpTicks = 0;
            }
            const injured = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
                filter: c => c.hits < c.hitsMax
            });
            if(injured) {
                tower.heal(injured);
                continue;
            }
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
            const energyReserve = tower.store.getCapacity(RESOURCE_ENERGY) * 0.77;
            if(tower.store[RESOURCE_ENERGY] > energyReserve && Game.time % 5 === 0) {
                const damagedWalls = room.find(FIND_STRUCTURES, {
                    filter: s =>
                        (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
                        s.hits < 2000000
                });
                if(damagedWalls.length > 0) {
                    const mostDamagedWall = damagedWalls.sort((a, b) => a.hits - b.hits)[0];
                    tower.repair(mostDamagedWall);
                }
            }
        }
    }
}

// OPTIMIZED: Calculate total energy using cached structure IDs
function calculateTotalEnergy() {
    let totalEnergy = 0;
    if (!Memory.roomData) return 0; // Safety check if cache doesn't exist

    for (const roomName in Memory.roomData) {
        const roomCache = Memory.roomData[roomName];
        if (!roomCache) continue;

        // Combine all cached IDs into a single array for iteration
        const allIds = [
            ...(roomCache.spawnIds || []),
            ...(roomCache.extensionIds || []),
            ...(roomCache.containerIds || []),
        ];
        if (roomCache.storageId) {
            allIds.push(roomCache.storageId);
        }

        // Iterate through IDs, get the object, and sum the energy
        totalEnergy += allIds.reduce((sum, id) => {
            const structure = Game.getObjectById(id);
            // Check if structure exists and has a store property
            if (structure && structure.store) {
                return sum + structure.store.getUsedCapacity(RESOURCE_ENERGY);
            }
            return sum;
        }, 0);
    }
    return totalEnergy;
}

// Track CPU usage over time
function trackCPUUsage() {
    if (!ENABLE_CPU_LOGGING) return;
    if(!Memory.cpuStats) {
        Memory.cpuStats = {
            history: [],
            average: 0
        };
    }
    const cpuUsed = Game.cpu.getUsed();
    Memory.cpuStats.history.push(cpuUsed);
    if(Memory.cpuStats.history.length > 50) {
        Memory.cpuStats.history.shift();
    }
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
    let incomeThisTick = 0;
    if(Memory.energyIncomeTracker.history.length > 0) {
        const lastEntry = Memory.energyIncomeTracker.history[Memory.energyIncomeTracker.history.length - 1];
        const energyIncrease = Math.max(0, currentEnergy - lastEntry.energy);
        incomeThisTick = energyIncrease;
        Memory.energyIncomeTracker.totalIncome += incomeThisTick;
    }
    Memory.energyIncomeTracker.history.push({
        tick: currentTick,
        energy: currentEnergy,
        incomeThisTick: incomeThisTick
    });
    while(Memory.energyIncomeTracker.history.length > 0 &&
          currentTick - Memory.energyIncomeTracker.history[0].tick > 100) {
        const removedEntry = Memory.energyIncomeTracker.history.shift();
        Memory.energyIncomeTracker.totalIncome -= removedEntry.incomeThisTick || 0;
    }
    const trackingTicks = Memory.energyIncomeTracker.history.length;
    Memory.energyIncomeTracker.averageIncome = trackingTicks > 0 ?
        Memory.energyIncomeTracker.totalIncome / trackingTicks : 0;
    Memory.energyIncomeTracker.totalIncome = Math.max(0, Memory.energyIncomeTracker.totalIncome);
}

// Reset kill counter daily
function handleKillCounterReset() {
    if (!Memory.stats) {
        Memory.stats = { kills: 0 };
    }
    // Get the current date in UTC (e.g., "2025-06-30")
    const todayUTC = new Date().toISOString().slice(0, 10);

    if (Memory.stats.killResetDate !== todayUTC) {
        Memory.stats.kills = 0;
        Memory.stats.killResetDate = todayUTC;
        console.log('Daily kill counter has been reset.');
    }
}

// Track kills from events
function trackKills() {
    // Ensure stats and kills property exist
    if (!Memory.stats) Memory.stats = {};
    if (Memory.stats.kills === undefined) Memory.stats.kills = 0;

    // Check if Game.events is an array before iterating
    if (Array.isArray(Game.events)) {
        for (const event of Game.events) {
            // We are only interested in object destruction events
            if (event.event === EVENT_OBJECT_DESTROYED) {
                // Check if the object was destroyed by one of our creeps or structures.
                // The 'destroyerId' is the ID of the object that landed the final blow.
                const destroyer = Game.getObjectById(event.data.destroyerId);

                // If the destroyer exists and the 'my' property is true, it's our kill.
                if (destroyer && destroyer.my) {
                    // Optional: You can also confirm the destroyed object was a creep.
                    if (event.data.type === 'creep') {
                        Memory.stats.kills++;
                    }
                }
            }
        }
    }
}


// Get performance data for display
function getPerformanceData() {
    const cpuUsed = Game.cpu.getUsed();
    const cpuAverage = (ENABLE_CPU_LOGGING && Memory.cpuStats) ? Memory.cpuStats.average : 0;
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
    // Initialize stats memory if it doesn't exist
    if (!Memory.stats) Memory.stats = {};

    // Handle daily kill counter reset and track kills
    handleKillCounterReset();
    trackKills();
    roleScout.handleDeadCreeps();

    // === ENERGY TRANSFER LOGIC ===
    //processEnergyTransfers();
    // === END ENERGY TRANSFER LOGIC ===

    if(Game.time % 20 === 0) cleanMemory();
    if(Game.time % 1000 === 0) cleanCpuProfileMemory();
    let perRoomRoleCounts, roomDataCache;
    profileSection('getPerRoomRoleCounts', () => {
        perRoomRoleCounts = getPerRoomRoleCounts();
    });
    profileSection('cacheRoomData', () => {
        roomDataCache = cacheRoomData();
    });
    profileSection('runTowers', runTowers);
    profileSection('runLinks', runLinks);
    profileSection('runCreeps', runCreeps);
    profileSection('manageClaimbotSpawns', manageClaimbotSpawns);
    if(needsNewCreeps(perRoomRoleCounts) || Game.time % 10 === 0) {
        profileSection('manageSpawnsPerRoom', () => {
            manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache);
        });
    }
    profileSection('roadTracker.trackRoadVisits', () => {
        roadTracker.trackRoadVisits();
    });
    profileSection('roadTracker.visualizeUntraveledRoads', () => {
        roadTracker.visualizeUntraveledRoads();
    });
    if (ENABLE_CPU_LOGGING) profileSection('trackCPUUsage', trackCPUUsage);
    profileSection('trackEnergyIncome', trackEnergyIncome);
    if(Game.time % 50 === 0) {
        profileSection('displayStatus', () => {
            displayStatus(perRoomRoleCounts);
        });
        if (ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
            for (const key in Memory.cpuProfile) {
                const avg = Memory.cpuProfile[key].reduce((a, b) => a + b, 0) / Memory.cpuProfile[key].length;
                console.log(`CPU Profile: ${key} avg: ${avg.toFixed(2)}`);
            }
        }
    }
}

// --- CLAIMBOT SPAWN LOGIC ---
function manageClaimbotSpawns() {
    if (!Memory.claimOrders) Memory.claimOrders = [];
    if (Memory.claimOrders.length === 0) return;
    const claimOrder = Memory.claimOrders[0];
    const existing = _.find(Game.creeps, c => c.memory.role === 'claimbot' && c.memory.targetRoom === claimOrder.room);
    if (existing) return;
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
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(room.controller && room.controller.my) {
            perRoomCounts[roomName] = {
                harvester: 0, upgrader: 0, builder: 0, scout: 0,
                defender: 0, supplier: 0, claimbot: 0
            };
        }
    }
    for(const name in Game.creeps) {
        const creep = Game.creeps[name];
        const role = creep.memory.role;
        let assignedRoom = creep.room.name;
        if(creep.memory.assignedRoom) {
            assignedRoom = creep.memory.assignedRoom;
        }
        else if(creep.memory.sourceRoom) {
            assignedRoom = creep.memory.sourceRoom;
        }
        else if(creep.memory.targetRoom) {
            assignedRoom = creep.memory.targetRoom;
        }
        if(perRoomCounts[assignedRoom] && perRoomCounts[assignedRoom][role] !== undefined) {
            perRoomCounts[assignedRoom][role]++;
        }
    }
    return perRoomCounts;
}

// OPTIMIZED: Cache room data to memory to avoid repeated find() calls
function cacheRoomData() {
    if(!Memory.roomData) Memory.roomData = {};
    const cache = {};
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;
        const shouldUpdate = !Memory.roomData[roomName] || Game.time % 100 === 0;
        if(shouldUpdate) {
            if(!Memory.roomData[roomName]) Memory.roomData[roomName] = {};
            const roomMemory = Memory.roomData[roomName];

            // Cache basic info
            const sources = room.find(FIND_SOURCES);
            roomMemory.sources = sources.map(s => s.id);
            roomMemory.constructionSitesCount = room.find(FIND_CONSTRUCTION_SITES).length;
            roomMemory.energyCapacity = room.energyCapacityAvailable;
            roomMemory.energyAvailable = room.energyAvailable;

            // OPTIMIZATION: Cache IDs of all energy-holding structures
            roomMemory.spawnIds = room.find(FIND_MY_SPAWNS).map(s => s.id);
            roomMemory.extensionIds = room.find(FIND_MY_STRUCTURES, {
                filter: { structureType: STRUCTURE_EXTENSION }
            }).map(s => s.id);
            const storage = room.storage; // room.storage is a cheap shortcut
            roomMemory.storageId = storage ? storage.id : null;
            roomMemory.containerIds = room.find(FIND_STRUCTURES, {
                filter: { structureType: STRUCTURE_CONTAINER }
            }).map(s => s.id);
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
        if(counts.harvester === 0) return true;
        if(totalCreeps < 3) return true;
    }
    return false;
}

// Run each creep's role behavior
function runCreeps() {
    for(const name in Game.creeps) {
        const creep = Game.creeps[name];
        if(creep.spawning) continue;
        const role = creep.memory.role;
        //if(role === 'scout') continue;
        //if((role === 'builder' || role === 'upgrader')) continue;
        let cpuBefore, cpuAfter;
        if (ENABLE_CPU_LOGGING) cpuBefore = Game.cpu.getUsed();
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
        if (ENABLE_CPU_LOGGING) {
            cpuAfter = Game.cpu.getUsed();
            if (!Memory.cpuProfileCreeps) Memory.cpuProfileCreeps = {};
            if (!Memory.cpuProfileCreeps[role]) Memory.cpuProfileCreeps[role] = [];
            Memory.cpuProfileCreeps[role].push(cpuAfter - cpuBefore);
            if (Memory.cpuProfileCreeps[role].length > 50) Memory.cpuProfileCreeps[role].shift();
        }
    }
    if (Game.time % 50 === 0 && ENABLE_CPU_LOGGING && Memory.cpuProfileCreeps && !DISABLE_CPU_CONSOLE) {
        for (const role in Memory.cpuProfileCreeps) {
            const arr = Memory.cpuProfileCreeps[role];
            const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
            console.log(`Creep Role CPU: ${role} avg: ${avg.toFixed(2)}`);
        }
    }
}

// Display colony status - UPDATED FOR PER-ROOM DISPLAY
function displayStatus(perRoomRoleCounts) {
    const TICK_WINDOW = 500;
    const perRoomStats = {};
    for(const name in Game.creeps) {
        const creep = Game.creeps[name];
        const assignedRoom = creep.memory.assignedRoom || creep.room.name;
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
        const stats = perRoomStats[roomName] || { totalBodyParts: 0, totalCreeps: 0, oldestCreepTTL: 0, totalTTL: 0 };
        const avgBodyParts = stats.totalCreeps > 0 ? (stats.totalBodyParts / stats.totalCreeps).toFixed(1) : 0;
        const avgTTL = stats.totalCreeps > 0 ? Math.round(stats.totalTTL / stats.totalCreeps) : 0;
        const oldestTTL = stats.oldestCreepTTL === Infinity ? 0 : stats.oldestCreepTTL;
        console.log(`${roomName}: 🧑‍🌾 ${counts.harvester} | ⚡ ${counts.upgrader} | 🔨 ${counts.builder} | 🔭 ${counts.scout} | 🛡 ${counts.defender} | 🔋 ${counts.supplier} | 🤖 ${counts.claimbot} | Avg Parts: ${avgBodyParts} | Avg TTL: ${avgTTL} | Low TTL: ${oldestTTL}`);
    }
    const perfData = getPerformanceData();
    const currentEnergy = calculateTotalEnergy();
    console.log(`💰 Total Energy: ${currentEnergy} | ⛏️ Income: ${perfData.energyIncome}/tick (last ${perfData.trackingTicks} ticks)`);
    console.log(`⚔️ Kills Today: ${Memory.stats.kills || 0}`);
    if (!ENABLE_CPU_LOGGING || !DISABLE_CPU_CONSOLE) {
        console.log(`🖥️ CPU: ${perfData.cpuUsed}/${perfData.cpuLimit} (${perfData.cpuPercent}%) | Avg: ${perfData.cpuAverage}`);
    }
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(room.controller && room.controller.my) {
            const percent = (room.controller.progress / room.controller.progressTotal * 100);
            const progress = percent.toFixed(1);
            const energyPercent = (room.energyAvailable / room.energyCapacityAvailable * 100).toFixed(1);
            if(!Memory.progressTracker) Memory.progressTracker = {};
            if(!Memory.progressTracker[roomName]) Memory.progressTracker[roomName] = {};
            const tracker = Memory.progressTracker[roomName];
            if(tracker.level !== room.controller.level) {
                tracker.level = room.controller.level;
                tracker.history = [{ tick: Game.time, percent: percent }];
            }
            if(!tracker.history) tracker.history = [];
            tracker.history.push({ tick: Game.time, percent: percent });
            while(tracker.history.length > 0 && tracker.history[0].tick < Game.time - TICK_WINDOW) {
                tracker.history.shift();
            }
            let etaString = '';
            if(tracker.history.length > 1) {
                const oldest = tracker.history[0];
                const newest = tracker.history[tracker.history.length - 1];
                const tickDelta = newest.tick - oldest.tick;
                const percentDelta = newest.percent - oldest.percent;
                if(tickDelta >= TICK_WINDOW && percentDelta > 0) {
                    const percentRemaining = 100 - newest.percent;
                    const rate = percentDelta / tickDelta;
                    const etaTicks = Math.ceil(percentRemaining / rate);
                    const etaMinutes = etaTicks * 4 / 60;
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

// === BUILDER JOB COUNT HELPER ===
function countBuilderJobs(room) {
    // Check if the room has a tower
    const hasTower = room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_TOWER }
    }).length > 0;

    let total = 0;
    for (let prio of PRIORITIES) {
        // If there's a tower, only count construction jobs (type === 'build')
        if (hasTower && prio.type !== 'build') continue;
        let targets = prio.targetFinder
            ? prio.targetFinder(room)
            : room.find(FIND_STRUCTURES, { filter: prio.filter });
        total += targets.length;
    }
    return total;
}

//Get room-specific targets based on room characteristics
function getRoomTargets(roomName, roomData, room) {
    const sourcesCount = roomData.sources ? roomData.sources.length : 2;
    const constructionSitesCount = roomData.constructionSitesCount || 0;
    const containers = room.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_CONTAINER }
    });
    const storage = room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_STORAGE }
    });
    const hasStorageStructures = containers.length > 0 || storage.length > 0;
    const towers = room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_TOWER }
    });
    const hasTower = towers.length > 0;
    let builderJobs = countBuilderJobs(room);
    let builderTarget = 0;
    if (builderJobs > 0) {
        builderTarget = 1 + Math.floor((builderJobs - 1) / 10);
    }

    // --- UPGRADER SCALING LOGIC ---
    let upgraderTarget = Math.max(1, sourcesCount);
    let storedEnergy = 0;
    if (storage.length > 0) {
        storedEnergy = storage[0].store[RESOURCE_ENERGY] || 0;
    }
    if (storedEnergy > 950000) {
        upgraderTarget += 8;
    } else if (storedEnergy > 900000) {
        upgraderTarget += 4;
    } else if (storedEnergy > 750000) {
        upgraderTarget += 2;
    } else if (storedEnergy > 600000) {
        upgraderTarget += 1;
    }
    // --- END UPGRADER SCALING LOGIC ---

    return {
        harvester: Math.max(1, sourcesCount),
        upgrader: upgraderTarget,
        builder: builderTarget,
        scout: 0,
        defender: 0,
        supplier: hasStorageStructures ? (sourcesCount + 2) : 0
    };
}

// Manage spawning per room - COMPLETELY REWRITTEN FOR MULTI-ROOM
function manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache) {
    if (Memory.claimOrders && Memory.claimOrders.length > 0) return;
    if(!Memory.harvesterSpawnDelay) Memory.harvesterSpawnDelay = {};
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if(!room.controller || !room.controller.my) continue;
        const spawn = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_SPAWN }
        })[0];
        if(!spawn || spawn.spawning) continue;
        const roomData = roomDataCache[roomName] || {};
        const roleCounts = perRoomRoleCounts[roomName] || {};
        const roomTargets = getRoomTargets(roomName, roomData, room);
        if(roleCounts.harvester === 0) {
            console.log(`EMERGENCY MODE in ${roomName}!!!`);
            const body = getCreepBody('harvester', room.energyAvailable);
            if (body && body.length > 0 && bodyCost(body) <= room.energyAvailable) {
                spawnCreepInRoom('harvester', body, spawn, roomName);
                continue;
            } else {
                console.log(`Not enough energy in ${roomName} to spawn a harvester!`);
                continue;
            }
        }

        let roleToSpawn = null;
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
            if(roleToSpawn === 'harvester') {
                const totalEnergy = calculateTotalEnergy();
                if(totalEnergy < 800) {
                    if(!Memory.harvesterSpawnDelay[roomName]) {
                        Memory.harvesterSpawnDelay[roomName] = { nextSpawnTime: Game.time + 60 };
                        console.log(`Low energy (${totalEnergy} < 800) - delaying harvester spawn in ${roomName} by 60 ticks`);
                        continue;
                    }
                    if(Game.time < Memory.harvesterSpawnDelay[roomName].nextSpawnTime) {
                        continue;
                    }
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
    const bodyConfigs = {
        harvester: {
            300: BASIC_HARVESTER,
            400: [WORK, WORK, WORK, CARRY, MOVE],
            550: [WORK, WORK, WORK, CARRY, WORK, MOVE, MOVE],
            800: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE],
            950: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE]
        },
        upgrader: {
            200: [WORK, CARRY, MOVE],
            300: [WORK, WORK, CARRY, CARRY, MOVE],
            500: [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
            600: [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
            800: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
            //1100: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE]
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
            200: [CARRY, CARRY, MOVE, MOVE],
            300: [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
            400: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
            600: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
            //900: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
            //1000: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
        },
        scout: {
            300: SCOUT_BODY
        }
    };
    if (role === 'scout') {
        return SCOUT_BODY;
    }
    if (energy <= 300 && role !== 'defender' && role !== 'supplier') {
        return BASIC_HARVESTER;
    }
    if (bodyConfigs[role]) {
        return getBestBody(bodyConfigs[role], energy);
    }
    return getBestBody(bodyConfigs.harvester, energy);
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
        let type = typeof part === 'string' ? part.toLowerCase() : part;
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
