// LLM: Read llmcontext.js before reviewing or changing this file.
// roleOperator.js
// ============================================================================
// Modular Power Creep (Operator) controller.
//
// ============================================================================
// CONSOLE COMMANDS
// ============================================================================
//
// createOperator('CreepName')
//   Creates a new Operator-class power creep.
//   - Must wait 1 tick before it appears in Game.powerCreeps
//   - Does NOT spawn it into a room yet (use setupOperator for that)
//   Example: createOperator('C1')
//
// upgradeOperator('CreepName', PWR_GENERATE_OPS)
//   Upgrades a power creep with the specified power.
//   - Costs 1 GPL level per upgrade
//   - Some powers can be upgraded multiple times (e.g. PWR_GENERATE_OPS lvl 2)
//   - Use listPowers() to see all available power IDs
//   Example: upgradeOperator('C1', PWR_GENERATE_OPS)
//   Example: upgradeOperator('C1', PWR_OPERATE_FACTORY)
//   Example: upgradeOperator('C1', PWR_OPERATE_EXTENSION)
//
// setupOperator('CreepName', 'RoomName')
//   Assigns a power creep to a room with default power priorities.
//   - Auto-spawns at the room's PowerSpawn each tick if not alive
//   - Runs all powers the creep has learned, in default priority order
//   Example: setupOperator('C1', 'E2N46')
//
// setupOperator('CreepName', 'RoomName', [PWR_GENERATE_OPS, PWR_OPERATE_FACTORY])
//   Assigns with explicit power priority list (highest priority first).
//   - Only powers the creep has actually learned will be used
//   - Powers it hasn't learned are silently skipped
//   Example: setupOperator('C1', 'E2N46', [PWR_GENERATE_OPS, PWR_OPERATE_FACTORY, PWR_OPERATE_EXTENSION])
//
// removeOperator('CreepName')
//   Clears room assignment for a power creep.
//   - Does NOT delete the creep, just stops running it
//   Example: removeOperator('C1')
//
// listOperators()
//   Shows all configured operators, their rooms, and alive/spawned status.
//   Example: listOperators()
//
// listPowers()
//   Prints a reference table of all supported power IDs and names.
//   Useful when calling upgradeOperator().
//   Example: listPowers()
//
// showOperator('CreepName')
//   Shows detailed info about a power creep: learned powers, levels, room.
//   Example: showOperator('C1')
//
// ============================================================================
// QUICK START GUIDE (run these in console, one per tick)
// ============================================================================
//
//   Tick 1:  createOperator('C1')
//   Tick 2:  upgradeOperator('C1', PWR_GENERATE_OPS)
//   Tick 3:  upgradeOperator('C1', PWR_OPERATE_FACTORY)
//   Tick 4:  upgradeOperator('C1', PWR_OPERATE_EXTENSION)
//   Tick 5:  setupOperator('C1', 'E2N46', [PWR_GENERATE_OPS, PWR_OPERATE_FACTORY, PWR_OPERATE_EXTENSION])
//
//   The creep will auto-spawn at the PowerSpawn and begin its power cycle.
//
// ============================================================================
// INTEL INTEGRATION (PWR_OPERATE_OBSERVER)
// ============================================================================
//
//   PWR_OPERATE_OBSERVER is NOT part of the default power cycle.
//   It only fires on-demand when intel() needs to see a room that is
//   beyond normal observer range (10 rooms).
//
//   Flow:
//     1. intel('farRoom') finds no structural observer in range
//     2. It locates an operator with PWR_OPERATE_OBSERVER + an observer
//        in its home room, writes Memory.intelPowerObserve
//     3. Next tick the operator uses PWR_OPERATE_OBSERVER on the observer,
//        the observer calls observeRoom(), and the request is cleaned up
//     4. The tick after that, processPendingIntel() auto-completes the report
//
//   To enable: upgradeOperator('C1', PWR_OPERATE_OBSERVER)
//   No other setup needed — intel() will find it automatically.
//
// ============================================================================
// SOURCE REGEN
// ============================================================================
//
//   setupSourceRegen(operatorName, roomName, [initialDelay])
//     Activates effect-based source regen for an operator in a room.
//     Discovers the room's sources and records per-source next-due ticks.
//     The operator will regen the next scheduled source, then set that
//     source's next due = (regen tick) + 125 * sourceCount. Sources
//     naturally alternate on a 125 tick cast cadence. The first regen fires after `initialDelay`
//     ticks (default 125).
//     Example: setupSourceRegen('C1', 'E2N46')
//     Example: setupSourceRegen('C1', 'E2N46', 0)
//
//   disableSourceRegen(operatorName)
//     Clears the operator's source regen memory.
//     Example: disableSourceRegen('C1')
//
//   showSourceRegen(operatorName)
//     Prints per-source last-regen and next-due timing.
//     Example: showSourceRegen('C1')
//
// ============================================================================
// INTEGRATION (main.js)
// ============================================================================
//
//   const roleOperator = require('roleOperator');
//   profiler.registerObject(roleOperator, 'roleOperator');
//
//   // Driven from the power creep loop inside runCreeps() — no standalone call needed.
//
// --- Power Handler Registry ---
// Each handler defines:
//   getTarget(creep, room)  -> Game object to use the power on, or null for self-cast
//   shouldUse(creep, room, target) -> boolean, whether conditions are met to use now
//   range                   -> how close the creep must be to the target
//   opsCost                 -> ops consumed per use (0 if none)
//   label                   -> friendly name for logging

const getRoomState = require('getRoomState');

// ============================================================================
// Source Regen — Memory Layout
//   Memory.operatorSourceRegen[operatorName] = {
//       roomName:    string,
//       sources: {
//           [sourceId]: {
//               lastRegenTick: number, // tick of last successful regen
//               nextDueTick:   number, // tick the operator should regen again
//           }
//       }
//   }
//
//   On setup: nextDueTick = Game.time + initialDelay + (i * 125).
//     This staggers sources so the operator casts on one source every 125 ticks.
//
//   On regen OK: lastRegenTick = Game.time, nextDueTick = Game.time + 125 * sourceCount
// ============================================================================

function _myStructuresByType(room, type) {
    var rs = getRoomState.get(room.name);
    var arr = (rs && rs.structuresByType && rs.structuresByType[type]) || [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].my) out.push(arr[i]);
    }
    return out;
}

function _structuresOfTypeWith(room, type, extraFilter) {
    var rs = getRoomState.get(room.name);
    if (rs && rs.structuresByType && rs.structuresByType[type]) {
        var arr = rs.structuresByType[type];
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            if (arr[i].my && extraFilter(arr[i])) out.push(arr[i]);
        }
        return out;
    }
    return room.find(FIND_MY_STRUCTURES, {
        filter: function(s) { return s.structureType === type && extraFilter(s); }
    });
}

const POWER_HANDLERS = {};

// ---------------------------------------------------------------------------
// PWR_GENERATE_OPS (1) - Self-cast, generates ops resource
// Generates ops as long as carry is not completely full.
// The deposit-to-storage/terminal logic keeps space available so generation
// never stalls. Fired unconditionally before all other powers in Layer 1.
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_GENERATE_OPS] = {
    label: 'GenerateOps',
    range: 0,
    opsCost: 0,
    getTarget: function() { return null; },
    shouldUse: function(creep) {
        var ops = creep.store[RESOURCE_OPS] || 0;
        var cap = creep.store.getCapacity(RESOURCE_OPS) || 100;
        // Keep generating unless completely full — deposit logic handles overflow
        return ops < cap;
    }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_FACTORY (22) - Targets factory, sets its level
// Only activates when there is an active factory order in the room whose
// recipe requires a factory level (e.g. Composite, Crystal, Liquid, Concentrate).
// Uses getRecipe() which falls back to COMMODITIES, so ALL leveled products
// are detected — not just the ones in the hardcoded RECIPES table.
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_FACTORY] = {
    label: 'OperateFactory',
    range: 3,
    opsCost: 100,

    getTarget: function(creep, room) {
        // Determine what level the active order needs
        var neededLevel = 0;
        var orders = Memory.factoryOrders || [];
        var getRecipe = require('factoryManager').getRecipe;
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (o.room !== room.name || o.status !== 'active') continue;
            var recipe = getRecipe(o.product);
            if (recipe && recipe.level) { neededLevel = recipe.level; break; }
        }
        if (!neededLevel) return null; // no leveled order — don't operate

        var factories = _structuresOfTypeWith(room, STRUCTURE_FACTORY, function(s) {
            if (s.effects && s.effects.length) {
                for (var i = 0; i < s.effects.length; i++) {
                    if (s.effects[i].effect === PWR_OPERATE_FACTORY) {
                        // Effect is live — re-target only if the level is wrong
                        return s.effects[i].level !== neededLevel;
                    }
                }
            }
            return true; // no active effect — needs operating
        });
        return factories[0] || null;
    },

    // getTarget is the sole gatekeeper; shouldUse is a passthrough
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_EXTENSION (13) - Fills all extensions from storage/terminal
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_EXTENSION] = {
    label: 'OperateExtension',
    range: 3,
    opsCost: 2,
    getTarget: function(creep, room) {
        if (room.energyAvailable >= room.energyCapacityAvailable) return null;
        if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) return room.storage;
        if (room.terminal && room.terminal.store[RESOURCE_ENERGY] > 0) return room.terminal;
        return null;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_SPAWN (12) - Speeds up a spawn by +30%
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_SPAWN] = {
    label: 'OperateSpawn',
    range: 3,
    opsCost: 100,
    getTarget: function(creep, room) {
        var spawns = _structuresOfTypeWith(room, STRUCTURE_SPAWN, function(s) {
            if (!s.spawning) return false;
            if (s.effects && s.effects.length) {
                for (var i = 0; i < s.effects.length; i++) {
                    if (s.effects[i].effect === PWR_OPERATE_SPAWN) return false;
                }
            }
            return true;
        });
        return spawns[0] || null;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_TERMINAL (23) - Reduces transaction cost by 50%
// Only activates when the terminal is on cooldown (a send just occurred).
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_TERMINAL] = {
    label: 'OperateTerminal',
    range: 3,
    opsCost: 100,
    getTarget: function(creep, room) {
        var terminal = room.terminal;
        if (!terminal) return null;
        if (terminal.effects && terminal.effects.length) {
            for (var i = 0; i < terminal.effects.length; i++) {
                if (terminal.effects[i].effect === PWR_OPERATE_TERMINAL) return null;
            }
        }
        return terminal;
    },
    shouldUse: function(creep, room) {
        var terminal = room.terminal;
        if (!terminal) return false;
        return terminal.cooldown > 0;
    }
};

// ---------------------------------------------------------------------------
// PWR_REGEN_SOURCE (2) - Regenerates a source for bonus energy
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_REGEN_SOURCE] = {
    label: 'RegenSource',
    range: 3,
    opsCost: 0,
    getTarget: function(creep, room) {
        var rs = getRoomState.get(room.name);
        var sources = (rs && rs.sources) || room.find(FIND_SOURCES);
        var out = [];
        for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (s.effects && s.effects.length) {
                var hasEffect = false;
                for (var j = 0; j < s.effects.length; j++) {
                    if (s.effects[j].effect === PWR_REGEN_SOURCE) { hasEffect = true; break; }
                }
                if (hasEffect) continue;
            }
            out.push(s);
        }
        return out[0] || null;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_REGEN_MINERAL (17) - Boosts mineral yield (like PWR_REGEN_SOURCE for energy)
// Only targets minerals that are actively minable — skips depleted ones that
// are waiting on their natural regeneration timer.
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_REGEN_MINERAL] = {
    label: 'RegenMineral',
    range: 3,
    opsCost: 0,
    getTarget: function(creep, room) {
        var rs = getRoomState.get(room.name);
        var minerals = (rs && rs.minerals) || room.find(FIND_MINERALS);
        var out = [];
        for (var i = 0; i < minerals.length; i++) {
            var s = minerals[i];
            if (s.mineralAmount === 0) continue;
            if (s.ticksToRegeneration > 0) continue;
            if (s.effects && s.effects.length) {
                var hasEffect = false;
                for (var j = 0; j < s.effects.length; j++) {
                    if (s.effects[j].effect === PWR_REGEN_MINERAL) { hasEffect = true; break; }
                }
                if (hasEffect) continue;
            }
            out.push(s);
        }
        return out[0] || null;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_STORAGE (19) - Increases storage capacity
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_STORAGE] = {
    label: 'OperateStorage',
    range: 3,
    opsCost: 100,
    getTarget: function(creep, room) {
        var storage = room.storage;
        if (!storage) return null;
        if (storage.effects && storage.effects.length) {
            for (var i = 0; i < storage.effects.length; i++) {
                if (storage.effects[i].effect === PWR_OPERATE_STORAGE) return null;
            }
        }
        return storage;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_LAB (26) - +2 reaction amount per tick
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_LAB] = {
    label: 'OperateLab',
    range: 3,
    opsCost: 10,
    getTarget: function(creep, room) {
        var labs = _structuresOfTypeWith(room, STRUCTURE_LAB, function(s) {
            if (!s.mineralType) return false;
            if (s.effects && s.effects.length) {
                for (var i = 0; i < s.effects.length; i++) {
                    if (s.effects[i].effect === PWR_OPERATE_LAB) return false;
                }
            }
            return true;
        });
        return labs[0] || null;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_CONTROLLER (21) - +8 upgrade per tick on controller
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_CONTROLLER] = {
    label: 'OperateController',
    range: 3,
    opsCost: 200,
    getTarget: function(creep, room) {
        var ctrl = room.controller;
        if (!ctrl || ctrl.level >= 8) return null;
        if (ctrl.effects && ctrl.effects.length) {
            for (var i = 0; i < ctrl.effects.length; i++) {
                if (ctrl.effects[i].effect === PWR_OPERATE_CONTROLLER) return null;
            }
        }
        return ctrl;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_OBSERVER (24) - Extends observer range to any room on the map
// NOT included in default power cycle. Only used on-demand by intel().
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_OBSERVER] = {
    label: 'OperateObserver',
    range: 3,
    opsCost: 10,
    getTarget: function(creep, room) {
        var observers = _myStructuresByType(room, STRUCTURE_OBSERVER);
        return observers[0] || null;
    },
    shouldUse: function() {
        return false;
    }
};

// ============================================================================
// Tuning Constants
// ============================================================================
var RENEW_TTL = 500;

// --- Ops Banking Thresholds (percentage-based, scales with any carry capacity) ---
var OPS_DEPOSIT_PCT = 0.85;       // deposit when ops >= 85% of capacity
var OPS_WITHDRAW_PCT = 0.15;      // withdraw when ops < 15% of capacity
var OPS_BANK_AMOUNT_PCT = 0.15;   // amount per banking trip (% of capacity, min 10)

// ============================================================================
// Console Commands — Creation & Upgrades
// ============================================================================

global.createOperator = function(creepName) {
    if (Game.powerCreeps[creepName]) {
        return '⚠️ Power creep "' + creepName + '" already exists.';
    }

    var result = PowerCreep.create(creepName, POWER_CLASS.OPERATOR);

    if (result === OK) {
        return '✅ Created power creep "' + creepName + '"\n' +
               '   Wait 1 tick, then use upgradeOperator() to add powers.\n' +
               '   Example: upgradeOperator(\'' + creepName + '\', PWR_GENERATE_OPS)';
    } else if (result === ERR_NAME_EXISTS) {
        return '⚠️ A power creep named "' + creepName + '" already exists.';
    } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
        return '❌ Not enough GPL levels available. Process more Power to level up.';
    } else {
        return '❌ Failed to create power creep. Error code: ' + result;
    }
};

global.upgradeOperator = function(creepName, power) {
    var pc = Game.powerCreeps[creepName];
    if (!pc) {
        return '❌ Power creep "' + creepName + '" not found.\n' +
               '   Create it first: createOperator(\'' + creepName + '\')\n' +
               '   Then wait 1 tick before upgrading.';
    }

    if (power === undefined || power === null) {
        return '❌ No power specified.\n' +
               '   Usage: upgradeOperator(\'' + creepName + '\', PWR_GENERATE_OPS)\n' +
               '   Run listPowers() to see all available power IDs.';
    }

    var currentLevel = (pc.powers && pc.powers[power]) ? pc.powers[power].level : 0;
    var handler = POWER_HANDLERS[power];
    var powerName = handler ? handler.label : ('Power_' + power);

    var result = pc.upgrade(power);

    if (result === OK) {
        return '✅ Upgraded "' + creepName + '" → ' + powerName + ' (now level ' + (currentLevel + 1) + ')';
    } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
        return '❌ No available power levels on "' + creepName + '". Need more GPL.';
    } else if (result === ERR_FULL) {
        return '❌ ' + powerName + ' is already at max level on "' + creepName + '".';
    } else {
        return '❌ Failed to upgrade. Error code: ' + result;
    }
};

// ============================================================================
// Console Commands — Assignment & Info
// ============================================================================

global.setupOperator = function(creepName, roomName, powers) {
    if (!Game.powerCreeps[creepName]) {
        return '❌ Power creep "' + creepName + '" not found.\n' +
               '   Create it first: createOperator(\'' + creepName + '\')';
    }
    if (!Memory.operators) Memory.operators = {};

    if (!powers || !powers.length) {
        // Priority order: regen powers first (frequent, free), then extension,
        // then factory (long-duration effect — serviced promptly after regen
        // completes, and its getTarget() returns null while the effect is
        // active so it never wins a commit it doesn't need), then the rest.
        powers = [
            PWR_GENERATE_OPS,
            PWR_REGEN_SOURCE,
            PWR_REGEN_MINERAL,
            PWR_OPERATE_EXTENSION,
            PWR_OPERATE_FACTORY,
            PWR_OPERATE_SPAWN,
            PWR_OPERATE_TERMINAL,
            PWR_OPERATE_STORAGE,
            PWR_OPERATE_LAB,
            PWR_OPERATE_CONTROLLER
        ];
    }

    Memory.operators[creepName] = {
        homeRoom: roomName,
        powers: powers
    };

    var creep = Game.powerCreeps[creepName];
    var active = [];
    var skipped = [];
    for (var i = 0; i < powers.length; i++) {
        var p = powers[i];
        var handler = POWER_HANDLERS[p];
        var name = handler ? handler.label : ('Unknown_' + p);
        if (creep.powers && creep.powers[p]) {
            active.push(name + ' (lvl ' + creep.powers[p].level + ')');
        } else {
            skipped.push(name);
        }
    }

    var hasObsPower = creep.powers && creep.powers[PWR_OPERATE_OBSERVER];

    var msg = '✅ Operator "' + creepName + '" → ' + roomName + '\n';
    msg += '   Active: ' + (active.length ? active.join(', ') : 'none') + '\n';
    if (skipped.length) {
        msg += '   Skipped (not learned): ' + skipped.join(', ') + '\n';
    }
    if (hasObsPower) {
        msg += '   🔭 OperateObserver available for on-demand intel (not in cycle)';
    }
    return msg;
};

global.removeOperator = function(creepName) {
    if (Memory.operators && Memory.operators[creepName]) {
        delete Memory.operators[creepName];
        return '🗑️ Removed operator config for "' + creepName + '"';
    }
    return '⚠️ No config found for "' + creepName + '"';
};

global.listOperators = function() {
    if (!Memory.operators || !Object.keys(Memory.operators).length) {
        return 'No operators configured. Use setupOperator(name, room) to assign one.';
    }
    var lines = ['=== Configured Operators ==='];
    for (var name in Memory.operators) {
        var cfg = Memory.operators[name];
        var creep = Game.powerCreeps[name];
        var status = creep && creep.ticksToLive ? ('alive, TTL ' + creep.ticksToLive) : 'not spawned';
        var obsTag = (creep && creep.powers && creep.powers[PWR_OPERATE_OBSERVER]) ? ' [🔭 intel]' : '';
        lines.push('  ' + name + ' → ' + cfg.homeRoom + ' (' + status + ')' + obsTag);
    }
    return lines.join('\n');
};

global.showOperator = function(creepName) {
    var pc = Game.powerCreeps[creepName];
    if (!pc) {
        return '❌ Power creep "' + creepName + '" not found.';
    }

    var lines = ['=== ' + creepName + ' ==='];
    lines.push('  Class: ' + pc.className);
    lines.push('  Level: ' + pc.level);
    lines.push('  TTL: ' + (pc.ticksToLive || 'not spawned'));
    lines.push('  Room: ' + (pc.room ? pc.room.name : 'none'));
    lines.push('  Ops: ' + (pc.store[RESOURCE_OPS] || 0));

    if (pc.powers && Object.keys(pc.powers).length > 0) {
        lines.push('  Powers:');
        for (var powerId in pc.powers) {
            var info = pc.powers[powerId];
            var handler = POWER_HANDLERS[powerId];
            var name = handler ? handler.label : ('Unknown_' + powerId);
            var cycleTag = (parseInt(powerId) === PWR_OPERATE_OBSERVER) ? ' [on-demand only]' : '';
            lines.push('    ' + name + ' → lvl ' + info.level + ' (cooldown: ' + info.cooldown + ')' + cycleTag);
        }
    } else {
        lines.push('  Powers: none — use upgradeOperator(\'' + creepName + '\', PWR_GENERATE_OPS)');
    }

    var cfg = Memory.operators ? Memory.operators[creepName] : null;
    if (cfg) {
        lines.push('  Assigned: ' + cfg.homeRoom);
    } else {
        lines.push('  Assigned: none — use setupOperator(\'' + creepName + '\', \'RoomName\')');
    }

    return lines.join('\n');
};

global.listPowers = function() {
    var lines = ['=== Supported Powers ==='];
    lines.push('  PWR_GENERATE_OPS (' + PWR_GENERATE_OPS + ')        - Generate ops (self-cast, no cost)');
    lines.push('  PWR_OPERATE_FACTORY (' + PWR_OPERATE_FACTORY + ')     - Set factory level (100 ops)');
    lines.push('  PWR_OPERATE_EXTENSION (' + PWR_OPERATE_EXTENSION + ')   - Fill extensions instantly (2 ops)');
    lines.push('  PWR_OPERATE_SPAWN (' + PWR_OPERATE_SPAWN + ')       - +30% spawn speed (100 ops)');
    lines.push('  PWR_OPERATE_TERMINAL (' + PWR_OPERATE_TERMINAL + ')    - -50% transaction cost (100 ops)');
    lines.push('  PWR_REGEN_SOURCE (' + PWR_REGEN_SOURCE + ')        - +50% source energy (free)');
    lines.push('  PWR_REGEN_MINERAL (' + PWR_REGEN_MINERAL + ')       - Regen mineral deposit (free)');
    lines.push('  PWR_OPERATE_STORAGE (' + PWR_OPERATE_STORAGE + ')     - +500k storage cap (100 ops)');
    lines.push('  PWR_OPERATE_LAB (' + PWR_OPERATE_LAB + ')         - +2 reaction/tick (10 ops)');
    lines.push('  PWR_OPERATE_CONTROLLER (' + PWR_OPERATE_CONTROLLER + ')  - +8 upgrade/tick (200 ops)');
    lines.push('  PWR_OPERATE_OBSERVER (' + PWR_OPERATE_OBSERVER + ')    - Observe any room [on-demand via intel] (10 ops)');
    lines.push('');
    lines.push('  Usage: upgradeOperator(\'CreepName\', PWR_GENERATE_OPS)');
    lines.push('  Note:  PWR_OPERATE_OBSERVER is not added to the power cycle.');
    lines.push('         It fires automatically when intel() needs a distant room.');
    return lines.join('\n');
};

// ============================================================================
// Console Commands — Source Regen
// ============================================================================

var SOURCE_REGEN_CAST_INTERVAL = 125; // desired spacing between source regen casts
var SOURCE_REGEN_TRAVEL_LEAD = 40; // begin moving before a source is due
var SOURCE_REGEN_RENEW_AT = 150; // refresh sources once the effect is this low
var REGEN_DEFAULT_INITIAL_DELAY = 125;

/**
 * Look up the duration of PWR_REGEN_SOURCE at the operator's current level.
 * Falls back to 300 (the level-1 value) if POWER_INFO is unavailable.
 */
function getRegenSourceDuration(pc) {
    if (typeof POWER_INFO !== 'undefined'
        && POWER_INFO[PWR_REGEN_SOURCE]
        && POWER_INFO[PWR_REGEN_SOURCE].duration) {
        var lvl = (pc.powers && pc.powers[PWR_REGEN_SOURCE] && pc.powers[PWR_REGEN_SOURCE].level) || 1;
        var d = POWER_INFO[PWR_REGEN_SOURCE].duration[lvl - 1];
        if (typeof d === 'number') return d;
    }
    return 300;
}

/**
 * Activate effect-based source regen for an operator in a room.
 * Each source is recorded with its own next-due tick. After each successful
 * regen, next-due is set to (regen tick) + 125 * sourceCount, so the operator
 * casts on one source every 125 ticks while alternating sources.
 */
global.setupSourceRegen = function(operatorName, roomName, initialDelay) {
    var pc = Game.powerCreeps[operatorName];
    if (!pc) return '❌ Power creep "' + operatorName + '" not found.';
    if (!pc.powers || !pc.powers[PWR_REGEN_SOURCE]) {
        return '❌ "' + operatorName + '" has not learned PWR_REGEN_SOURCE.';
    }

    if (!Game.rooms[roomName]) return '❌ Room ' + roomName + ' not visible.';

    var sources = Game.rooms[roomName].find(FIND_SOURCES);
    if (!sources || !sources.length) return '❌ No sources found in ' + roomName + '.';

    if (initialDelay === undefined || initialDelay === null) {
        initialDelay = REGEN_DEFAULT_INITIAL_DELAY;
    }
    initialDelay = Math.max(0, Math.floor(initialDelay));

    var duration = getRegenSourceDuration(pc);
    var n = sources.length;

    if (!Memory.operatorSourceRegen) Memory.operatorSourceRegen = {};
    var mem = Memory.operatorSourceRegen[operatorName];
    var preservedLastRegen = (mem && mem.sources) ? mem.sources : null;
    var newSources = {};

    for (var i = 0; i < sources.length; i++) {
        var sId = sources[i].id;
        var prior = preservedLastRegen && preservedLastRegen[sId];
        var nextDue;
        // Rebuild the cadence every time setup is run; stale nextDueTick values
        // from older scheduler versions can otherwise keep a bad rhythm alive.
        nextDue = Game.time + initialDelay + (i * SOURCE_REGEN_CAST_INTERVAL);
        newSources[sId] = {
            lastRegenTick: prior ? (prior.lastRegenTick || 0) : 0,
            nextDueTick: nextDue
        };
    }

    Memory.operatorSourceRegen[operatorName] = {
        roomName: roomName,
        castInterval: SOURCE_REGEN_CAST_INTERVAL,
        sources: newSources
    };

    var firstDue = null;
    for (var k in newSources) {
        if (firstDue === null || newSources[k].nextDueTick < firstDue) {
            firstDue = newSources[k].nextDueTick;
        }
    }

    return '🔁 Source regen enabled for ' + operatorName + ' in ' + roomName
        + ' — ' + n + ' source(s), duration ' + duration + 't, interval ' + SOURCE_REGEN_CAST_INTERVAL + 't'
        + ', first regen in ~' + Math.max(0, firstDue - Game.time) + 't';
};

/**
 * Clear the operator's source regen memory.
 */
global.disableSourceRegen = function(operatorName) {
    if (!Memory.operatorSourceRegen || !Memory.operatorSourceRegen[operatorName]) {
        return '⚠️ No source regen configured for ' + operatorName + '.';
    }
    delete Memory.operatorSourceRegen[operatorName];
    return '🗑️ Source regen disabled for ' + operatorName + '.';
};

/**
 * Print per-source regen state for an operator.
 */
global.showSourceRegen = function(operatorName) {
    if (!Memory.operatorSourceRegen || !Memory.operatorSourceRegen[operatorName]) {
        return 'No source regen configured for ' + operatorName + '.';
    }
    var entry = Memory.operatorSourceRegen[operatorName];
    var lines = ['=== Source Regen: ' + operatorName + ' (' + entry.roomName + ') ==='];
    var keys = Object.keys(entry.sources || {});
    keys.sort(function(a, b) { return entry.sources[a].nextDueTick - entry.sources[b].nextDueTick; });
    for (var i = 0; i < keys.length; i++) {
        var s = entry.sources[keys[i]];
        var dueIn = s.nextDueTick - Game.time;
        var lastRel = s.lastRegenTick ? ('last regen ' + s.lastRegenTick) : 'never regened';
        lines.push('  ' + keys[i]
            + ' | next due in ' + dueIn + 't (tick ' + s.nextDueTick + ')'
            + ' | ' + lastRel);
    }
    return lines.join('\n');
};

// ============================================================================
// Module Exports (called from runCreeps in main.js)
// ============================================================================

module.exports = {

    trySpawn: function(pc, roomName) {
        var room = Game.rooms[roomName];
        if (!room) return;

        var powerSpawns = _myStructuresByType(room, STRUCTURE_POWER_SPAWN);
        if (powerSpawns.length === 0) return;

        var result = pc.spawn(powerSpawns[0]);
        if (result === OK) {
            console.log('[Operator] Spawned ' + pc.name + ' in ' + roomName);
        }
    },

    // ====================================================================
    // Main tick entry point — two-layer architecture
    //
    //   Layer 0 (Unconditional): PWR_GENERATE_OPS fires here. Self-cast,
    //                            range 0, fires even during travel phases.
    //   Layer 1 (Power):    Fire all ready, in-range powers. Free action —
    //                       usePower does NOT consume the movement slot.
    //   Layer 2 (Movement): Mutually exclusive — first match wins.
    //                       Renew → Banking → Intel → Move-commit → Idle
    // ====================================================================

    runCreep: function(pc, config) {
        // =============================================================
        // LAYER 0: Power usage setup.
        // Source regen gets first chance only when it can cast immediately.
        // GenerateOps still fires while source regen is walking or waiting.
        // =============================================================
        var powerUsedThisTick = false;

        var room = Game.rooms[config.homeRoom];
        if (!room) {
            powerUsedThisTick = this.tryGenerateOps(pc);
            pc.moveTo(new RoomPosition(25, 25, config.homeRoom));
            return;
        }

        if (pc.room.name !== config.homeRoom) {
            powerUsedThisTick = this.tryGenerateOps(pc);
            pc.moveTo(new RoomPosition(25, 25, config.homeRoom));
            return;
        }

        // --- PRE-CHECK: Enable power in room (one-time, needs exclusive movement) ---
        if (room.controller && !room.controller.isPowerEnabled) {
            var result = pc.enableRoom(room.controller);
            if (result === ERR_NOT_IN_RANGE) {
                powerUsedThisTick = this.tryGenerateOps(pc);
                pc.moveTo(room.controller, { reusePath: 5 });
                return;
            }
            if (result === OK) {
                console.log('[Operator] Enabled power in ' + room.name);
                return;
            }
        }

        // =============================================================
        // LAYER 0.5: Source regen (effect-based, per-source timers)
        // When setupSourceRegen() is active, the operator picks the next
        // scheduled source and regens it. On success, that source's next due
        // is set to (regen tick) + 125 * sourceCount, so one source is handled
        // every 125 ticks.
        // Renewal still wins if TTL is critical.
        // =============================================================
        if (Memory.operatorSourceRegen
            && Memory.operatorSourceRegen[pc.name]
            && Memory.operatorSourceRegen[pc.name].sources) {
            if (pc.ticksToLive < RENEW_TTL) {
                // TTL too low — let renewal take priority, skip regen this tick
            } else if (this.handleSourceRegen(pc, room, true, true)) {
                if (!pc.memory) pc.memory = {};
                pc.memory._powerUsedTick = Game.time;
                return;
            }
            // else: no cast-ready source — GenerateOps can still fire below
        }

        powerUsedThisTick = this.tryGenerateOps(pc);

        if (Memory.operatorSourceRegen
            && Memory.operatorSourceRegen[pc.name]
            && Memory.operatorSourceRegen[pc.name].sources) {
            if (pc.ticksToLive < RENEW_TTL) {
                // TTL too low — let renewal take priority, skip regen this tick
            } else if (this.handleSourceRegen(pc, room, !powerUsedThisTick, false)) {
                if (!pc.memory) pc.memory = {};
                pc.memory._powerUsedTick = powerUsedThisTick ? Game.time : 0;
                return;
            }
            // else: no source due yet — fall through to normal Layer 1
        }

        // =============================================================
        // LAYER 1: Fire exactly one ready power by priority.
        // GenerateOps already had first chance in Layer 0; the rest run
        // in config.powers order. Screeps only allows one successful
        // usePower per tick, so we stop after the first valid candidate.
        // =============================================================
        if (!powerUsedThisTick) {
            powerUsedThisTick = this.executeScheduledPower(pc, room, config);
        }

        // Remember whether we used a power this tick so later stages
        // (e.g. on-demand intel observation) don't overwrite the intent.
        if (!pc.memory) pc.memory = {};
        pc.memory._powerUsedTick = powerUsedThisTick ? Game.time : 0;

        // =============================================================
        // LAYER 2: Movement — mutually exclusive, first match wins
        // =============================================================

        // 2a: Renew if TTL is low
        if (pc.ticksToLive < RENEW_TTL) {
            if (this.doRenew(pc, room)) return;
        }

        // 2b: Ops banking (deposit overflow / withdraw when depleted)
        if (this.handleOpsBanking(pc, room)) return;

        // 2c: On-demand intel observation
        if (this.handleIntelObserve(pc, room)) return;

        // 2d: Move-commit to nearest out-of-range power target
        if (this.handleMoveCommit(pc, room, config)) return;

        // 2e: Nothing to do — idle near power spawn
        this.idleNearSpawn(pc, room);
    },

    // ====================================================================
    // Layer 1: Execute exactly one ready, in-range power by priority.
    //
    // PWR_GENERATE_OPS had first chance in Layer 0, so it is skipped here.
    // We walk config.powers in order and stop at the first candidate that
    // successfully calls usePower. Screeps only allows one power action per
    // tick; calling usePower multiple times overrides the previous intent.
    // ====================================================================

    executeScheduledPower: function(pc, room, config) {
        var ops = pc.store[RESOURCE_OPS] || 0;
        var powers = config.powers || [];

        for (var i = 0; i < powers.length; i++) {
            var powerId = powers[i];

            // PWR_GENERATE_OPS already had first chance in Layer 0
            if (powerId === PWR_GENERATE_OPS) continue;

            // setupSourceRegen() owns source timing; do not let the generic
            // handler cast out of order and desync per-source memory.
            if (powerId === PWR_REGEN_SOURCE
                && Memory.operatorSourceRegen
                && Memory.operatorSourceRegen[pc.name]) continue;

            if (!pc.powers || !pc.powers[powerId]) continue;
            if (pc.powers[powerId].cooldown > 0) continue;

            var handler = POWER_HANDLERS[powerId];
            if (!handler) continue;

            if (handler.opsCost > 0 && ops < handler.opsCost) continue;

            if (this.tryPowerInRange(pc, room, powerId)) {
                return true;
            }
        }

        return false;
    },

    tryGenerateOps: function(pc) {
        if (pc.powers && pc.powers[PWR_GENERATE_OPS]
            && pc.powers[PWR_GENERATE_OPS].cooldown === 0) {
            return this.tryPowerInRange(pc, null, PWR_GENERATE_OPS);
        }
        return false;
    },

    // ====================================================================
    // Layer 2d: Move-commit system
    //
    // Maintains a persistent movement lock so the creep walks to one target
    // without being redirected each tick. Layer 1 fires in-range powers
    // along the way.
    //
    // Each tick:
    //   1. If a commit exists, validate it (target still needs the power,
    //      cooldown still 0, can still afford ops).
    //   2. If valid and in range — hold position so Layer 1 fires the power.
    //      Clear after 3 ticks if unfired (safety valve).
    //   3. If valid and out of range — keep walking.
    //   4. If invalid — clear lock and fall through to find a new target.
    //   5. If no commit, scan for the highest-priority out-of-range target.
    //
    // No mid-walk preemption is used. Any form of preemption causes
    // oscillation when multiple targets are simultaneously valid (e.g.
    // source and factory both needing service at different locations).
    // Priority is resolved entirely by the config list order at the moment
    // a new commit is chosen — keep high-value frequent powers near the top.
    // ====================================================================

    handleMoveCommit: function(pc, room, config) {
        var ops = pc.store[RESOURCE_OPS] || 0;
        var mem = pc.memory || {};
        if (!mem._moveCommit) mem._moveCommit = null;

        // --- Validate existing commit ---
        if (mem._moveCommit) {
            var commit = mem._moveCommit;
            var cTarget = Game.getObjectById(commit.targetId);
            var cHandler = POWER_HANDLERS[commit.powerId];
            var stillValid = cTarget && cHandler
                && pc.powers[commit.powerId]
                && pc.powers[commit.powerId].cooldown === 0
                && (cHandler.opsCost === 0 || ops >= cHandler.opsCost)
                && cHandler.shouldUse(pc, room, cTarget);

            // Confirm the target still needs the power
            if (stillValid && cHandler.range > 0) {
                var freshTarget = cHandler.getTarget(pc, room);
                if (!freshTarget || freshTarget.id !== cTarget.id) {
                    stillValid = false;
                }
            }

            if (stillValid) {
                if (pc.pos.getRangeTo(cTarget) <= cHandler.range) {
                    // In range — hold position so Layer 1 can fire the power.
                    // When it fires, cooldown > 0 → stillValid fails next tick
                    // → commit clears naturally via the else branch below.
                    // Safety: if the power hasn't fired after 3 ticks in range,
                    // clear the commit to avoid getting permanently stuck.
                    if (!commit.inRangeSince) commit.inRangeSince = Game.time;
                    if (Game.time - commit.inRangeSince > 3) {
                        mem._moveCommit = null;
                        return false;
                    }
                    return true;
                } else {
                    commit.inRangeSince = null;
                    pc.moveTo(cTarget, { reusePath: 5 });
                    return true;
                }
            } else {
                mem._moveCommit = null;
            }
        }

        // --- Find a new target and lock onto it ---
        var moveResult = this.findMoveTarget(pc, room, config, ops);
        if (moveResult) {
            mem._moveCommit = {
                targetId: moveResult.target.id,
                powerId: moveResult.powerId
            };
            pc.moveTo(moveResult.target, { reusePath: 5 });
            return true;
        }

        return false;
    },

    /**
     * Layer 0.5 — effect-based source regen driver.
     *
     * Walks to the next scheduled source and fires PWR_REGEN_SOURCE on it.
     * On success, that source's next-due tick is set to
     * Game.time + 125 * sourceCount, so the operator casts every 125 ticks
     * while alternating sources. It starts moving early to absorb travel time.
     *
     * Returns true when the tick was fully consumed (movement issued or
     * power fired). Returns false when no source is due yet.
     */
    handleSourceRegen: function(pc, room, allowCast, castOnly) {
        if (allowCast === undefined) allowCast = true;
        if (castOnly === undefined) castOnly = false;

        if (!Memory.operatorSourceRegen) return false;
        var entry = Memory.operatorSourceRegen[pc.name];
        if (!entry || !entry.sources) return false;

        if (!pc.powers || !pc.powers[PWR_REGEN_SOURCE]) return false;

        if (entry.castInterval !== SOURCE_REGEN_CAST_INTERVAL) {
            var migrateIds = Object.keys(entry.sources);
            migrateIds.sort(function(a, b) {
                return (entry.sources[a].nextDueTick || 0) - (entry.sources[b].nextDueTick || 0);
            });
            for (var m = 0; m < migrateIds.length; m++) {
                entry.sources[migrateIds[m]].nextDueTick = Game.time + (m * SOURCE_REGEN_CAST_INTERVAL);
            }
            entry.castInterval = SOURCE_REGEN_CAST_INTERVAL;
        }

        // Pick in one cheap pass over configured sources:
        //   1. no active regen effect
        //   2. active effect at/below renewal threshold
        //   3. scheduled soon enough to pre-position
        var picked = null;
        var pickedId = null;
        var pickedSource = null;
        var pickedScore = Infinity;
        var sourceCount = 0;
        var readyBy = Game.time + SOURCE_REGEN_TRAVEL_LEAD;
        for (var sId in entry.sources) {
            var s = entry.sources[sId];
            sourceCount++;
            if (typeof s.nextDueTick !== 'number') continue;

            var candidateSource = Game.getObjectById(sId);
            if (!candidateSource) continue;

            var effectTicks = 0;
            if (candidateSource.effects && candidateSource.effects.length) {
                for (var e = 0; e < candidateSource.effects.length; e++) {
                    if (candidateSource.effects[e].effect === PWR_REGEN_SOURCE) {
                        effectTicks = candidateSource.effects[e].ticksRemaining || 0;
                        break;
                    }
                }
            }

            // Scores must stay on a relative-tick scale: nextDueTick is an
            // absolute game tick (tens of millions), which would swamp the
            // category offsets and invert the priority order.
            var score;
            if (effectTicks <= 0) {
                var overdue = s.nextDueTick - Game.time;
                if (overdue < -900000) overdue = -900000;
                if (overdue > 900000) overdue = 900000;
                score = -2000000 + overdue;
            } else if (effectTicks <= SOURCE_REGEN_RENEW_AT) {
                score = -1000000 + effectTicks;
            } else if (s.nextDueTick <= readyBy) {
                score = s.nextDueTick - Game.time;
            } else {
                continue;
            }

            if (score < pickedScore) {
                picked = s;
                pickedId = sId;
                pickedSource = candidateSource;
                pickedScore = score;
            }
        }
        if (!picked) return false;

        var source = pickedSource || Game.getObjectById(pickedId);
        if (!source) {
            // Source no longer visible (room not in vision) — bump the due
            // tick forward so we don't keep retrying every tick while
            // waiting for vision to return.
            picked.nextDueTick = Game.time + 50;
            return false;
        }

        // Cross-room navigation
        if (entry.roomName && pc.room.name !== entry.roomName) {
            if (castOnly) return false;
            pc.moveTo(source, { reusePath: 5 });
            return true;
        }

        // In the right room — get into range
        if (pc.pos.getRangeTo(source) > 3) {
            if (castOnly) return false;
            pc.moveTo(source, { reusePath: 5 });
            return true;
        }

        var pickedEffectTicks = 0;
        if (source.effects && source.effects.length) {
            for (var pe = 0; pe < source.effects.length; pe++) {
                if (source.effects[pe].effect === PWR_REGEN_SOURCE) {
                    pickedEffectTicks = source.effects[pe].ticksRemaining || 0;
                    break;
                }
            }
        }

        // We arrived early and the effect is still healthy. Hold position so
        // cadence stays stable instead of burning the refresh too soon.
        if (picked.nextDueTick > Game.time && pickedEffectTicks > SOURCE_REGEN_RENEW_AT) {
            return castOnly ? false : true;
        }

        // Due, but the power is still cooling down. Stay committed instead of
        // letting unrelated movement pull the operator away from the source.
        if (!allowCast || pc.powers[PWR_REGEN_SOURCE].cooldown > 0) {
            return castOnly ? false : true;
        }

        var result = pc.usePower(PWR_REGEN_SOURCE, source);
        if (result === OK) {
            var nextInterval = SOURCE_REGEN_CAST_INTERVAL * Math.max(1, sourceCount);
            picked.lastRegenTick = Game.time;
            picked.nextDueTick = Game.time + nextInterval;
            console.log('[Operator] 🔁 Source regen fired on ' + pickedId
                + ' in ' + (source.room ? source.room.name : entry.roomName || '?')
                + ' — next due in ' + nextInterval + 't');
            return true;
        }

        console.log('[Operator] Source regen on ' + pickedId
            + ' failed → code ' + result + ' (will retry next tick)');
        return true;
    },

    /**
     * Try to use a power ONLY if the creep is already in range.
     * Does not issue any movement. Returns true if the power fired.
     */
    tryPowerInRange: function(pc, room, powerId) {
        var handler = POWER_HANDLERS[powerId];
        if (!handler) return false;

        // Self-cast (range 0) — always in range, room can be null
        if (handler.range === 0) {
            if (!handler.shouldUse(pc, null, null)) return false;
            return pc.usePower(powerId) === OK;
        }

        // For targeted powers, room is required
        if (!room) return false;

        var target = handler.getTarget(pc, room);
        if (!target) return false;
        if (!handler.shouldUse(pc, room, target)) return false;
        if (pc.pos.getRangeTo(target) > handler.range) return false;

        var result = pc.usePower(powerId, target);
        if (result !== OK) {
            console.log('[Operator] ' + handler.label + ' failed on ' + target + ' → code ' + result);
        }
        return result === OK;
    },

    /**
     * Scan configured powers for the highest-priority one that has a valid
     * target out of range. Returns {target, powerId} or null.
     */
    findMoveTarget: function(pc, room, config, ops) {
        // Check Operate Terminal first (high priority when active)
        if (pc.powers && pc.powers[PWR_OPERATE_TERMINAL] && pc.powers[PWR_OPERATE_TERMINAL].cooldown === 0) {
            var termHandler = POWER_HANDLERS[PWR_OPERATE_TERMINAL];
            if (ops >= termHandler.opsCost) {
                var termTarget = termHandler.getTarget(pc, room);
                if (termTarget && termHandler.shouldUse(pc, room, termTarget)) {
                    if (pc.pos.getRangeTo(termTarget) > termHandler.range) {
                        return { target: termTarget, powerId: PWR_OPERATE_TERMINAL };
                    }
                }
            }
        }

        // Check configured powers in priority order
        var powers = config.powers || [];
        for (var i = 0; i < powers.length; i++) {
            var powerId = powers[i];

            // setupSourceRegen() performs its own pre-positioning for sources.
            if (powerId === PWR_REGEN_SOURCE
                && Memory.operatorSourceRegen
                && Memory.operatorSourceRegen[pc.name]) continue;

            if (!pc.powers || !pc.powers[powerId]) continue;
            if (pc.powers[powerId].cooldown > 0) continue;
            if (!POWER_HANDLERS[powerId]) continue;

            var handler = POWER_HANDLERS[powerId];
            if (handler.range === 0) continue; // self-cast, no movement needed
            if (handler.opsCost > 0 && ops < handler.opsCost) continue;

            var target = handler.getTarget(pc, room);
            if (!target) continue;
            if (!handler.shouldUse(pc, room, target)) continue;
            if (pc.pos.getRangeTo(target) > handler.range) {
                return { target: target, powerId: powerId };
            }
        }

        return null;
    },

    // ====================================================================
    // Ops Banking — deposit excess ops to storage, withdraw when depleted
    //
    // Checks storage first for both deposit and withdraw. Falls back to
    // terminal if storage is absent or has no ops to offer.
    //
    // Thresholds are percentage-based so they scale with any carry capacity
    // (100 for a base Operator, potentially more with upgrades).
    //
    //   cap=100: deposit at 85 ops, withdraw below 15, bank 15 per trip
    //   cap=700: deposit at 595 ops, withdraw below 105, bank 105 per trip
    // ====================================================================

    handleOpsBanking: function(pc, room) {
        var storage = room.storage;
        var terminal = room.terminal;
        if (!storage && !terminal) return false;

        var ops = pc.store[RESOURCE_OPS] || 0;
        var cap = pc.store.getCapacity(RESOURCE_OPS) || 100;
        var depositAt   = Math.floor(cap * OPS_DEPOSIT_PCT);
        var withdrawAt  = Math.floor(cap * OPS_WITHDRAW_PCT);
        var bankAmount  = Math.max(10, Math.floor(cap * OPS_BANK_AMOUNT_PCT));

        // ── Deposit: prefer storage, fall back to terminal ──
        // Skip deposit if actively committed to walking toward a power target —
        // banking would yank the creep back to storage every few ticks, preventing
        // it from ever reaching distant targets like minerals or sources.
        var mem = pc.memory || {};
        if (ops >= depositAt && !mem._moveCommit) {
            var depositTarget = storage ? storage : terminal;
            var depositAmount = Math.min(bankAmount, ops);
            var result = pc.transfer(depositTarget, RESOURCE_OPS, depositAmount);
            if (result === OK) return true;
            if (result === ERR_NOT_IN_RANGE) {
                pc.moveTo(depositTarget, { reusePath: 5 });
                return true;
            }
            return false;
        }

        // ── Withdraw: check storage first, then terminal ──
        if (ops < withdrawAt) {
            var storageOps  = storage  ? (storage.store[RESOURCE_OPS]  || 0) : 0;
            var terminalOps = terminal ? (terminal.store[RESOURCE_OPS] || 0) : 0;

            var withdrawSource = null;
            var availableOps   = 0;
            if (storageOps > 0) {
                withdrawSource = storage;
                availableOps   = storageOps;
            } else if (terminalOps > 0) {
                withdrawSource = terminal;
                availableOps   = terminalOps;
            }

            if (!withdrawSource) return false;

            var space          = cap - ops;
            var targetOps      = Math.floor(cap * 0.50);
            var withdrawAmount = Math.min(targetOps - ops, availableOps, space);
            if (withdrawAmount <= 0) return false;

            var result = pc.withdraw(withdrawSource, RESOURCE_OPS, withdrawAmount);
            if (result === OK) return true;
            if (result === ERR_NOT_IN_RANGE) {
                pc.moveTo(withdrawSource, { reusePath: 5 });
                return true;
            }
            return false;
        }

        return false;
    },

    // ====================================================================
    // Intel Observation (on-demand, not part of the power cycle)
    // ====================================================================

    handleIntelObserve: function(pc, room) {
        if (pc.memory && pc.memory._powerUsedTick === Game.time) return false;

        if (!Memory.intelPowerObserve) return false;

        if (!pc.powers || !pc.powers[PWR_OPERATE_OBSERVER]) return false;

        var requestKey = null;
        var request = null;
        for (var targetRoom in Memory.intelPowerObserve) {
            var req = Memory.intelPowerObserve[targetRoom];
            if (req.operatorRoom === room.name && req.operatorName === pc.name) {
                requestKey = targetRoom;
                request = req;
                break;
            }
        }
        if (!request) return false;

        if (Game.time - request.tick > 50) {
            console.log('[Operator] Intel observe request for ' + requestKey + ' expired after 50 ticks.');
            delete Memory.intelPowerObserve[requestKey];
            return false;
        }

        var handler = POWER_HANDLERS[PWR_OPERATE_OBSERVER];
        var observer = handler.getTarget(pc, room);
        if (!observer) {
            console.log('[Operator] No observer found in ' + room.name + ' for intel request.');
            delete Memory.intelPowerObserve[requestKey];
            return false;
        }

        var phase = request.phase || 'power';

        if (phase === 'observe') {
            var hasPowerEffect = false;
            if (observer.effects && observer.effects.length) {
                for (var i = 0; i < observer.effects.length; i++) {
                    if (observer.effects[i].effect === PWR_OPERATE_OBSERVER) {
                        hasPowerEffect = true;
                        break;
                    }
                }
            }

            if (!hasPowerEffect) {
                console.log('[Operator] Observer power effect not found, re-powering...');
                request.phase = 'power';
                return this.handleIntelObserve(pc, room);
            }

            var obsResult = observer.observeRoom(requestKey);
            if (obsResult === OK) {
                console.log('[Operator] 🔭 observeRoom(' + requestKey + ') fired (powered observer from ' + room.name + ')');

                if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
                Memory.roomIntelPending[requestKey] = {
                    tick: Game.time,
                    observerRoom: room.name,
                    poweredObserver: true
                };

                delete Memory.intelPowerObserve[requestKey];
            } else {
                console.log('[Operator] observeRoom(' + requestKey + ') failed with code ' + obsResult + ', retrying next tick.');
            }
            return true;
        }

        var alreadyPowered = false;
        if (observer.effects && observer.effects.length) {
            for (var j = 0; j < observer.effects.length; j++) {
                if (observer.effects[j].effect === PWR_OPERATE_OBSERVER) {
                    alreadyPowered = true;
                    break;
                }
            }
        }
        if (alreadyPowered) {
            console.log('[Operator] Observer in ' + room.name + ' already powered — skipping to observe phase for ' + requestKey);
            request.phase = 'observe';
            var skipResult = observer.observeRoom(requestKey);
            if (skipResult === OK) {
                console.log('[Operator] 🔭 observeRoom(' + requestKey + ') fired (reusing active power effect)');
                if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
                Memory.roomIntelPending[requestKey] = {
                    tick: Game.time,
                    observerRoom: room.name,
                    poweredObserver: true
                };
                delete Memory.intelPowerObserve[requestKey];
            } else {
                console.log('[Operator] observeRoom(' + requestKey + ') failed with code ' + skipResult + ', retrying next tick.');
            }
            return true;
        }

        if (pc.powers[PWR_OPERATE_OBSERVER].cooldown > 0) {
            return false;
        }

        var ops = pc.store[RESOURCE_OPS] || 0;
        if (handler.opsCost > 0 && ops < handler.opsCost) {
            // Layer 1 already fired generation if possible — just wait for next tick
            return false;
        }

        var result = pc.usePower(PWR_OPERATE_OBSERVER, observer);
        if (result === OK) {
            console.log('[Operator] ⚡ PWR_OPERATE_OBSERVER applied to observer in ' + room.name + ' → will observe ' + requestKey + ' next tick.');
            request.phase = 'observe';
            return true;

        } else if (result === ERR_NOT_IN_RANGE) {
            pc.moveTo(observer, { reusePath: 5 });
            return true;

        } else {
            console.log('[Operator] PWR_OPERATE_OBSERVER failed with code ' + result);
            return false;
        }
    },

    findPowerObserver: function(targetRoomName) {
        if (!Memory.operators) return null;

        for (var name in Memory.operators) {
            var cfg = Memory.operators[name];
            var pc = Game.powerCreeps[name];

            if (!pc || !pc.ticksToLive) continue;
            if (!pc.powers || !pc.powers[PWR_OPERATE_OBSERVER]) continue;

            var room = Game.rooms[cfg.homeRoom];
            if (!room) continue;

            var observers = _myStructuresByType(room, STRUCTURE_OBSERVER);
            if (observers.length === 0) continue;

            var ops = pc.store[RESOURCE_OPS] || 0;
            var handler = POWER_HANDLERS[PWR_OPERATE_OBSERVER];
            var canAfford = ops >= handler.opsCost;
            var canGenerate = pc.powers[PWR_GENERATE_OPS] !== undefined;
            if (!canAfford && !canGenerate) continue;

            return {
                operatorName: name,
                operatorRoom: cfg.homeRoom,
                observerId: observers[0].id
            };
        }

        return null;
    },

    /**
     * Legacy helper — attempts a power with movement fallback.
     * No longer called from the main loop (Layer 0/1 handles in-range,
     * Layer 2 handles movement separately), but kept as a utility.
     */
    tryPower: function(pc, room, powerId) {
        var handler = POWER_HANDLERS[powerId];
        if (!handler) return false;

        if (handler.range === 0) {
            if (!handler.shouldUse(pc, room, null)) return false;
            var result = pc.usePower(powerId);
            if (result === OK) return true;
            return false;
        }

        var target = handler.getTarget(pc, room);
        if (!target) return false;
        if (!handler.shouldUse(pc, room, target)) return false;

        var result = pc.usePower(powerId, target);
        if (result === OK) {
            return true;
        } else if (result === ERR_NOT_IN_RANGE) {
            pc.moveTo(target, { reusePath: 5 });
            return true;
        }

        return false;
    },

    doRenew: function(pc, room) {
        var powerSpawns = _myStructuresByType(room, STRUCTURE_POWER_SPAWN);
        if (powerSpawns.length === 0) return false;

        var spawn = powerSpawns[0];
        var result = pc.renew(spawn);

        if (result === OK) {
            return true;
        } else if (result === ERR_NOT_IN_RANGE) {
            pc.moveTo(spawn, { reusePath: 5 });
            return true;
        }

        return false;
    },

    idleNearSpawn: function(pc, room) {
        var powerSpawns = _myStructuresByType(room, STRUCTURE_POWER_SPAWN);
        if (powerSpawns.length === 0) return;

        var spawn = powerSpawns[0];
        if (pc.pos.getRangeTo(spawn) > 3) {
            pc.moveTo(spawn, { reusePath: 10 });
        }
    }
};
