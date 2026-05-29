// remoteSupplyManager.js
// ============================================================================
// Remote Supply Manager
//
// Watches playerMonitor's per-room state and spawns supplier creeps when
// ally rooms hit configured thresholds. No observer logic lives here —
// playerMonitor owns all room scanning.
//
// ─── MISSION TYPES ──────────────────────────────────────────────────────────
//
//   extensions  Trigger: !hasCreeps && spawnExtEnergy <= 300
//               Action:  Load full carry, travel to recipient, fill
//                        extensions then spawns. Any leftover energy is
//                        dumped into storage if present.
//
//   storage     Trigger: storageEnergy <= 5000
//               Action:  Load exactly (7500 - currentStorage) energy,
//                        travel to recipient, deposit into storage.
//
// ─── CONSOLE COMMANDS ───────────────────────────────────────────────────────
//
//   remoteSupply('W1N1', 'W2N2', 'both')
//     Set up a standing order. Monitors conditions via playerMonitor and
//     spawns automatically when thresholds are met. Also resets the
//     playerMonitor poll timer so the first scan happens immediately.
//     Missions: 'both' | 'extensions' | 'storage'
//
//   triggerRemoteSupply('W1N1', 'W2N2', 'both')
//     Manually fire a one-shot supply run, bypassing all condition checks.
//     No standing order required. Won't spawn if a supplier is already
//     active for that mission. Resets cooldowns on any existing order.
//     Missions: 'both' | 'extensions' | 'storage'
//
//   cancelRemoteSupply('W1N1', 'W2N2')
//     Remove a standing order.
//
//   listRemoteSupply()
//     Show all standing orders, current playerMonitor state, cooldowns,
//     and any active supplier creeps.
// ============================================================================
const EXTENSION_ENERGY_TRIGGER = 300;    // extension mission fires when spawnExt ≤ this
const STORAGE_LOW_THRESHOLD    = 5000;   // storage mission fires when storage ≤ this
const STORAGE_TARGET           = 7500;   // bring storage up to this
const SPAWN_COOLDOWN           = 200;    // ticks before re-checking after a spawn

// ============================================================================
// Console commands
// ============================================================================

global.remoteSupply = function(sourceRoom, recipientRoom, missions) {
    if (!sourceRoom || !recipientRoom) {
        console.log('Usage: remoteSupply("sourceRoom", "recipientRoom", "both"|"extensions"|"storage")');
        return;
    }

    var arg = (missions || 'both').toLowerCase();
    var doExt = (arg === 'both' || arg === 'extensions');
    var doSto = (arg === 'both' || arg === 'storage');

    if (!doExt && !doSto) {
        console.log('[RemoteSupply] Unknown mission "' + missions + '". Use: both, extensions, storage');
        return;
    }

    if (!Memory.remoteSupplyOrders) Memory.remoteSupplyOrders = {};
    var key = sourceRoom + '->' + recipientRoom;
    var prev = Memory.remoteSupplyOrders[key] || {};

    Memory.remoteSupplyOrders[key] = {
        sourceRoom:    sourceRoom,
        recipientRoom: recipientRoom,
        missions:      { extensions: doExt, storage: doSto },
        active:        true,
        cooldown:      {
            extensions: prev.cooldown ? prev.cooldown.extensions : 0,
            storage:    prev.cooldown ? prev.cooldown.storage    : 0
        }
    };

    var playerName = _findPlayerForRoom(recipientRoom);
    var lines = ['[RemoteSupply] Order set: ' + key];
    if (doExt) lines.push('  extensions: fires when spawnExt ≤ ' + EXTENSION_ENERGY_TRIGGER + ' + no creeps');
    if (doSto) lines.push('  storage:    fires when storage ≤ ' + STORAGE_LOW_THRESHOLD + ', fills to ' + STORAGE_TARGET);
    if (!playerName) {
        lines.push('  WARNING: ' + recipientRoom + ' not found in playerMonitor. Run monitor() first.');
    } else {
        lines.push('  Watching via playerMonitor entry for: ' + playerName);
        // Force a rescan so spawnExtEnergy/storageEnergy are populated immediately
        // rather than waiting up to 1000 ticks for the next scheduled poll.
        var pm = Memory.playerMonitor;
        if (pm && pm.players && pm.players[playerName]) {
            pm.players[playerName].lastPoll = 0;
            lines.push('  playerMonitor lastPoll reset - rescan queued for next cycle.');
        }
    }
    console.log(lines.join('\n'));
};

global.cancelRemoteSupply = function(sourceRoom, recipientRoom) {
    if (!Memory.remoteSupplyOrders) return 'No orders.';
    var key = sourceRoom + '->' + recipientRoom;
    if (!Memory.remoteSupplyOrders[key]) return '[RemoteSupply] Not found: ' + key;
    delete Memory.remoteSupplyOrders[key];
    return '[RemoteSupply] Cancelled: ' + key;
};

/**
 * Manually trigger a remote supply run without waiting for playerMonitor
 * conditions. Bypasses hasCreeps / energy threshold checks entirely.
 *
 * Usage:
 *   triggerRemoteSupply('W1N1', 'W2N2', 'both')
 *   triggerRemoteSupply('W1N1', 'W2N2', 'extensions')
 *   triggerRemoteSupply('W1N1', 'W2N2', 'storage')
 *
 * An existing remoteSupply() order is NOT required — this works as a
 * one-shot even if no standing order is set up. If an order does exist
 * its cooldown is reset so conditions can re-trigger normally afterward.
 */
global.triggerRemoteSupply = function(sourceRoom, recipientRoom, missions) {
    if (!sourceRoom || !recipientRoom) {
        console.log('Usage: triggerRemoteSupply("sourceRoom", "recipientRoom", "both"|"extensions"|"storage")');
        return;
    }

    var arg = (missions || 'both').toLowerCase();
    var doExt = (arg === 'both' || arg === 'extensions');
    var doSto = (arg === 'both' || arg === 'storage');

    if (!doExt && !doSto) {
        console.log('[RemoteSupply] Unknown mission "' + missions + '". Use: both, extensions, storage');
        return;
    }

    // For storage mission we need a current storageEnergy value to compute
    // amountNeeded. Try playerMonitor state first, fall back to a fixed amount.
    var rs = _getRoomState(recipientRoom);

    if (doExt) {
        if (_countActiveSuppliers(sourceRoom, recipientRoom, 'extensions') > 0) {
            console.log('[RemoteSupply] Manual trigger skipped for extensions — supplier already active.');
        } else {
            _enqueueSpawn(
                { sourceRoom: sourceRoom, recipientRoom: recipientRoom },
                'extensions',
                rs
            );
            var msg = '[RemoteSupply] Manual trigger: extensions | ' + sourceRoom + ' -> ' + recipientRoom;
            console.log(msg);
            Game.notify(msg, 0);
        }
    }

    if (doSto) {
        if (_countActiveSuppliers(sourceRoom, recipientRoom, 'storage') > 0) {
            console.log('[RemoteSupply] Manual trigger skipped for storage — supplier already active.');
        } else {
            _enqueueSpawn(
                { sourceRoom: sourceRoom, recipientRoom: recipientRoom },
                'storage',
                rs   // _enqueueSpawn handles rs=null gracefully (amountNeeded becomes null → carry full)
            );
            var stoMsg = '[RemoteSupply] Manual trigger: storage | ' + sourceRoom + ' -> ' + recipientRoom +
                         (rs ? ' storageEnergy=' + rs.storageEnergy : ' (no state — will carry full)');
            console.log(stoMsg);
            Game.notify(stoMsg, 0);
        }
    }

    // Reset cooldowns on any existing standing order so it can re-trigger normally
    if (Memory.remoteSupplyOrders) {
        var key = sourceRoom + '->' + recipientRoom;
        var order = Memory.remoteSupplyOrders[key];
        if (order) {
            if (doExt) order.cooldown.extensions = 0;
            if (doSto) order.cooldown.storage    = 0;
        }
    }
};

global.listRemoteSupply = function() {
    if (!Memory.remoteSupplyOrders || !Object.keys(Memory.remoteSupplyOrders).length) {
        return 'No remote supply orders.';
    }
    var lines = ['=== Remote Supply Orders ==='];

    for (var key in Memory.remoteSupplyOrders) {
        var o   = Memory.remoteSupplyOrders[key];
        var rs  = _getRoomState(o.recipientRoom);

        var missionList = [];
        if (o.missions.extensions) missionList.push('extensions');
        if (o.missions.storage)    missionList.push('storage');

        lines.push(key + ' [' + missionList.join('+') + ']' + (o.active ? '' : ' INACTIVE'));

        if (rs) {
            lines.push('  spawnExt=' + (rs.spawnExtEnergy !== undefined ? rs.spawnExtEnergy : '?') +
                       '  storage='  + (rs.storageEnergy  !== undefined ? rs.storageEnergy  : '?') +
                       '  hasCreeps=' + rs.hasCreeps +
                       '  scanned '  + (rs.t ? (Game.time - rs.t) + ' ticks ago' : 'never'));
        } else {
            lines.push('  (no playerMonitor state yet)');
        }

        var cdExt = o.cooldown.extensions > Game.time
            ? '  ext cooldown: ' + (o.cooldown.extensions - Game.time) + ' ticks' : '';
        var cdSto = o.cooldown.storage > Game.time
            ? '  sto cooldown: ' + (o.cooldown.storage - Game.time) + ' ticks' : '';
        if (cdExt) lines.push(cdExt);
        if (cdSto) lines.push(cdSto);
    }

    // Active remote suppliers
    var active = [];
    for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (c && c.memory && c.memory.role === 'remoteSupplier') {
            active.push('  ' + name + ' [' + c.memory.mission + '] ' +
                        c.memory.homeRoom + '->' + c.memory.targetRoom +
                        ' ttl=' + c.ticksToLive +
                        ' working=' + c.memory.working);
        }
    }
    if (active.length) {
        lines.push('Active suppliers:');
        lines = lines.concat(active);
    }

    return lines.join('\n');
};

// ============================================================================
// Helpers
// ============================================================================

function _findPlayerForRoom(roomName) {
    var pm = Memory.playerMonitor;
    if (!pm || !pm.players) return null;
    for (var p in pm.players) {
        var pd = pm.players[p];
        if (pd.rooms && pd.rooms.indexOf(roomName) !== -1) return p;
    }
    return null;
}

function _getRoomState(roomName) {
    var playerName = _findPlayerForRoom(roomName);
    if (!playerName) return null;
    var pm = Memory.playerMonitor;
    if (!pm || !pm.players[playerName] || !pm.players[playerName].state) return null;
    return pm.players[playerName].state[roomName] || null;
}

function _countActiveSuppliers(sourceRoom, recipientRoom, mission) {
    var n = 0;
    for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (!c || !c.memory) continue;
        if (c.memory.role       !== 'remoteSupplier') continue;
        if (c.memory.homeRoom   !== sourceRoom)        continue;
        if (c.memory.targetRoom !== recipientRoom)     continue;
        if (c.memory.mission    !== mission)           continue;
        n++;
    }
    return n;
}

// ============================================================================
// Condition checks
// ============================================================================

function _checkExtensionTrigger(rs) {
    if (!rs) return false;
    if (rs.hasCreeps) return false;
    if (rs.spawnExtEnergy === undefined) return false;
    return rs.spawnExtEnergy <= EXTENSION_ENERGY_TRIGGER;
}

function _checkStorageTrigger(rs) {
    if (!rs) return false;
    if (rs.storageEnergy === undefined) return false;
    return rs.storageEnergy <= STORAGE_LOW_THRESHOLD;
}

// ============================================================================
// run() — called every tick
// ============================================================================

function run() {
    if (!Memory.remoteSupplyOrders) return;

    // ── Pick up completion signals written by roleRemoteSupplier ──────────────
    if (Memory.remoteSupplyComplete) {
        for (var ck in Memory.remoteSupplyComplete) {
            var sig = Memory.remoteSupplyComplete[ck];
            var doneMsg = '[RemoteSupply] Task complete: ' + sig.homeRoom +
                          ' -> ' + sig.targetRoom +
                          ' [' + sig.mission + '] at tick ' + sig.completedAt;
            console.log(doneMsg);
            Game.notify(doneMsg, 0);
        }
        delete Memory.remoteSupplyComplete;
    }

    for (var key in Memory.remoteSupplyOrders) {
        var order = Memory.remoteSupplyOrders[key];
        if (!order || !order.active) continue;

        var rs = _getRoomState(order.recipientRoom);

        // ── Dead-creep detection ───────────────────────────────────────────────
        // If the cooldown is still active but no supplier is alive AND no spawn
        // is queued, the creep died mid-mission. Reset the cooldown immediately
        // so the condition can re-trigger without waiting for the full cooldown.
        if (order.missions.extensions) _resetCooldownIfDead(order, 'extensions');
        if (order.missions.storage)    _resetCooldownIfDead(order, 'storage');

        // ── Extension mission ──────────────────────────────────────────────────
        if (order.missions.extensions &&
            Game.time >= (order.cooldown.extensions || 0) &&
            _checkExtensionTrigger(rs)) {

            if (_countActiveSuppliers(order.sourceRoom, order.recipientRoom, 'extensions') === 0) {
                var extMsg = '[RemoteSupply] Extension trigger: ' + order.sourceRoom +
                             ' -> ' + order.recipientRoom +
                             ' | spawnExt=' + rs.spawnExtEnergy + ', no creeps';
                console.log(extMsg);
                Game.notify(extMsg, 0);
                _enqueueSpawn(order, 'extensions', rs);
                order.cooldown.extensions = Game.time + SPAWN_COOLDOWN;
            }
        }

        // ── Storage mission ────────────────────────────────────────────────────
        if (order.missions.storage &&
            Game.time >= (order.cooldown.storage || 0) &&
            _checkStorageTrigger(rs)) {

            if (_countActiveSuppliers(order.sourceRoom, order.recipientRoom, 'storage') === 0) {
                var stoMsg = '[RemoteSupply] Storage trigger: ' + order.sourceRoom +
                             ' -> ' + order.recipientRoom +
                             ' | storageEnergy=' + rs.storageEnergy +
                             ' (target ' + STORAGE_TARGET + ')';
                console.log(stoMsg);
                Game.notify(stoMsg, 0);
                _enqueueSpawn(order, 'storage', rs);
                order.cooldown.storage = Game.time + SPAWN_COOLDOWN;
            }
        }
    }
}

/**
 * Reset the cooldown for a mission if the supplier died:
 *   - cooldown is still active (hasn't expired yet)
 *   - no supplier creep is alive for this mission
 *   - no spawn request is sitting in the queue waiting to be processed
 *
 * All three must be true — if a spawn is queued but not yet picked up by
 * spawnManager, the cooldown is still valid and we should not reset it.
 */
function _resetCooldownIfDead(order, mission) {
    if ((order.cooldown[mission] || 0) <= Game.time) return; // Already expired

    var alive  = _countActiveSuppliers(order.sourceRoom, order.recipientRoom, mission);
    if (alive > 0) return; // Creep is alive

    var queued = _hasQueuedSpawn(order.sourceRoom, order.recipientRoom, mission);
    if (queued) return; // Spawn is in the queue, just not processed yet

    // Creep is gone and no replacement is coming — reset so re-trigger can fire
    console.log('[RemoteSupply] ' + order.sourceRoom + '->' + order.recipientRoom +
                ' [' + mission + ']: supplier died mid-mission, resetting cooldown.');
    order.cooldown[mission] = 0;
}

/**
 * Returns true if there is a pending spawn request for this order+mission
 * in Memory.remoteSupplySpawnQueue that has not yet been processed by spawnManager.
 */
function _hasQueuedSpawn(sourceRoom, recipientRoom, mission) {
    if (!Memory.remoteSupplySpawnQueue) return false;
    for (var i = 0; i < Memory.remoteSupplySpawnQueue.length; i++) {
        var req = Memory.remoteSupplySpawnQueue[i];
        if (req.sourceRoom    === sourceRoom    &&
            req.recipientRoom === recipientRoom &&
            req.mission       === mission) {
            return true;
        }
    }
    return false;
}

/**
 * Write a spawn request into Memory for spawnManager to action.
 * For the storage mission, amountNeeded tells the creep how much energy
 * to load (capped at carry capacity in the role).
 */
function _enqueueSpawn(order, mission, rs) {
    if (!Memory.remoteSupplySpawnQueue) Memory.remoteSupplySpawnQueue = [];

    var amountNeeded = null;
    if (mission === 'storage' && rs) {
        amountNeeded = STORAGE_TARGET - (rs.storageEnergy || 0);
    }

    Memory.remoteSupplySpawnQueue.push({
        sourceRoom:    order.sourceRoom,
        recipientRoom: order.recipientRoom,
        mission:       mission,         // 'extensions' | 'storage'
        amountNeeded:  amountNeeded,    // null for extensions (carry full)
        requestedAt:   Game.time
    });
}

module.exports = { run };