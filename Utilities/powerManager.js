// powerManager.js
// ============================================================================
// CONSOLE COMMANDS
// ============================================================================
//
// startPowerUpgrade(roomName)
//
// stopPowerUpgrade(roomName)
//
// powerStatus()
//   Lists all rooms that currently have power processing enabled.
//   - Shows stored Power (Terminal + Storage + PowerSpawn) per room
//   - Shows current GPL progress
//
// Enable:  Memory.power['W1N1'] = 1;
// Disable: delete Memory.power['W1N1'];
//
// ============================================================================

const opportunisticBuy = require('opportunisticBuy');
const getRoomState = require('getRoomState');

function findPowerSpawns(room) {
    var rs = getRoomState.get(room.name);
    var arr = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_POWER_SPAWN]) || [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].my) out.push(arr[i]);
    }
    return out;
}

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
    if (room.storage)  stored += room.storage.store[RESOURCE_POWER] || 0;

    // Check PowerSpawn for existing resource
    const powerSpawns = findPowerSpawns(room);
    if (powerSpawns.length > 0) {
        stored += powerSpawns[0].store[RESOURCE_POWER] || 0;
    }

    // We only buy what we don't have
    const amountToBuy = Math.max(0, remainingForLevel - stored);

    // --- 2. Activate Processing Mode ---
    if (!Memory.power) Memory.power = {};
    Memory.power[roomName] = 1;

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
    if (Memory.power) delete Memory.power[roomName];
    return "🛑 STOPPED: Power processing disabled for " + roomName;
};

/**
 * Console Command: Show all rooms with power processing enabled
 * Usage: powerStatus();
 */
global.powerStatus = function() {
    const lines = [];
    const activeRooms = [];

    lines.push(`⚡ GPL ${Game.gpl.level} — Progress: ${Game.gpl.progress}/${Game.gpl.progressTotal}`);
    lines.push('');

    if (!Memory.power) Memory.power = {};

    for (const roomName in Memory.power) {
        if (!Memory.power[roomName]) continue;
        activeRooms.push(roomName);

        const room = Game.rooms[roomName];
        if (!room) {
            lines.push(`  ${roomName}  ⚠️ (not visible)`);
            continue;
        }

        // Tally stored power across structures
        let terminal = 0, storage = 0, pSpawn = 0;
        if (room.terminal) terminal = room.terminal.store[RESOURCE_POWER] || 0;
        if (room.storage)  storage  = room.storage.store[RESOURCE_POWER] || 0;

        const powerSpawns = findPowerSpawns(room);
        if (powerSpawns.length > 0) pSpawn = powerSpawns[0].store[RESOURCE_POWER] || 0;

        const total = terminal + storage + pSpawn;
        lines.push(`  ${roomName}  🔋 ${total} Power  (T:${terminal} S:${storage} PS:${pSpawn})`);
    }

    if (activeRooms.length === 0) {
        lines.push('  No rooms have powerMode enabled.');
    }

    return lines.join('\n');
};

module.exports = {
    run: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return;

        // Only run if Power Mode is enabled in memory
        if (!Memory.power || !Memory.power[roomName]) return;

        // --- 1. Find Power Spawn ---
        var powerSpawns = findPowerSpawns(room);

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

        // --- 4. Alert for New Power Creeps (global, one-time) ---
        if (!Memory._lastGplAlertLevel) Memory._lastGplAlertLevel = 0;

        var assignedPowerCreeps = Object.keys(Game.powerCreeps).length;

        if (Game.gpl.level > assignedPowerCreeps && Game.gpl.level > Memory._lastGplAlertLevel) {
            Memory._lastGplAlertLevel = Game.gpl.level;
            var msg = "GPL " + Game.gpl.level + " reached! You have " + assignedPowerCreeps + " Power Creep(s). Use Game.powerCreeps['Name'].create(...) to initialize a new one.";
            console.log("!!! POWER LEVEL UPGRADE DETECTED — " + msg);
            Game.notify(msg);
        }
    }
};