// powerManager.js
//startPowerUpgrade('W1N1')
const opportunisticBuy = require('opportunisticBuy');

/**
 * Internal helper to calculate 48h weighted average price
 * (Logic derived from marketQuery.js)
 */
function getMarketPriceAvg(resource) {
    const hist = Game.market.getHistory(resource) || [];
    if (!hist.length) return 0;

    // Use last 2 days for approx 48h window
    const last = hist[hist.length - 1];
    const prev = hist.length >= 2 ? hist[hist.length - 2] : null;

    let sumPV = 0;
    let sumV = 0;

    if (last && typeof last.avgPrice === 'number') { 
        sumPV += last.avgPrice * last.volume; 
        sumV += last.volume; 
    }
    if (prev && typeof prev.avgPrice === 'number') { 
        sumPV += prev.avgPrice * prev.volume; 
        sumV += prev.volume; 
    }

    if (sumV === 0) return last ? last.avgPrice : 0;
    
    return sumPV / sumV;
}

/**
 * Console Command: Automatically manages Power Upgrade
 * Usage: startPowerUpgrade('W1N1');
 */
global.startPowerUpgrade = function(roomName) {
    if (!Game.rooms[roomName]) return "❌ Room " + roomName + " not visible.";
    const room = Game.rooms[roomName];
    
    // --- 1. Detect Amount Needed ---
    // Calculate how much is left to reach the next GPL level
    const totalForLevel = Game.gpl.progressTotal;
    const currentProgress = Game.gpl.progress;
    const remainingForLevel = totalForLevel - currentProgress;
    
    // Calculate what we already have in this room
    let stored = 0;
    if (room.terminal) stored += room.terminal.store[RESOURCE_POWER] || 0;
    if (room.storage) stored += room.storage.store[RESOURCE_POWER] || 0;
    
    // Check PowerSpawn for existing resource
    const powerSpawns = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_POWER_SPAWN });
    if (powerSpawns.length > 0) {
        stored += powerSpawns[0].store[RESOURCE_POWER] || 0;
    }

    // We only buy what we don't have
    const amountToBuy = Math.max(0, remainingForLevel - stored);

    // --- 2. Activate Processing Mode ---
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    Memory.rooms[roomName].powerMode = true;

    if (amountToBuy === 0) {
        return `✅ PROCESSING ENABLED: No purchase needed.\n` +
               `   Have: ${stored} | Need: ${remainingForLevel}`;
    }

    // --- 3. Detect Market Price ---
    let avgPrice = getMarketPriceAvg(RESOURCE_POWER);
    if (avgPrice <= 0) {
        // Fallback if API returns no history (rare for Power)
        avgPrice = 100; 
        console.log("⚠️ No market history for POWER, defaulting to 100cr.");
    }
    
    // --- 4. Place Order ---
    // We use the exact 48h weighted average as the max price
    opportunisticBuy.setup(roomName, RESOURCE_POWER, amountToBuy, avgPrice);
    
    return `🚀 UPGRADE STARTED in ${roomName}\n` +
           `   - Goal: Level ${Game.gpl.level + 1} (${currentProgress}/${totalForLevel})\n` +
           `   - Buying: ${amountToBuy} Power\n` +
           `   - Limit: ${avgPrice.toFixed(3)} credits (48h Avg)`;
};

global.stopPowerUpgrade = function(roomName) {
    if (Memory.rooms[roomName]) {
        Memory.rooms[roomName].powerMode = false;
    }
    return "🛑 STOPPED: Power processing disabled for " + roomName;
};

module.exports = {
    run: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return;
        
        // Only run if Power Mode is enabled in memory
        if (!Memory.rooms[roomName] || !Memory.rooms[roomName].powerMode) return;

        // --- 1. Find Power Spawn ---
        var powerSpawns = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_POWER_SPAWN; }
        });
        
        if (powerSpawns.length === 0) return;
        var powerSpawn = powerSpawns[0];

        // --- 2. Process Power ---
        // Input: 1 Power + 50 Energy per tick
        if (powerSpawn.store[RESOURCE_POWER] >= 1 && powerSpawn.store[RESOURCE_ENERGY] >= 50) {
            powerSpawn.processPower();
        }

        // --- 3. Manage Creep Spawning (Integration with SpawnManager) ---
        // Request a powerBot if we have power in Terminal but not in Spawn
        var terminal = room.terminal;
        var needsPowerBot = false;

        if (terminal && terminal.store[RESOURCE_POWER] > 0 && powerSpawn.store.getFreeCapacity(RESOURCE_POWER) > 0) {
            // Check alive creeps
            var existingBots = _.filter(Game.creeps, function(c) {
                return c.memory.role === 'powerBot' && c.memory.homeRoom === roomName;
            });

            if (existingBots.length === 0) {
                needsPowerBot = true;
            }
        }

        // Write to memory so spawnManager can read it
        if (!Memory.spawnRequests) Memory.spawnRequests = {};
        if (!Memory.spawnRequests[roomName]) Memory.spawnRequests[roomName] = {};
        
        Memory.spawnRequests[roomName].needPowerBot = needsPowerBot;

        // --- 4. Alert for New Power Creeps ---
        // Detect if we actually leveled up
        var assignedPowerCreeps = 0;
        for (var name in Game.powerCreeps) {
            assignedPowerCreeps++;
        }

        if (Game.gpl.level > assignedPowerCreeps && Game.time % 100 === 0) {
            console.log("!!! POWER LEVEL UPGRADE DETECTED !!!");
            console.log("Use Game.powerCreeps['Name'].create(...) to initialize.");
        }
    }
};