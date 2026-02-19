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
// INTEGRATION (main.js)
// ============================================================================
//
//   const roleOperator = require('roleOperator');
//   profiler.registerObject(roleOperator, 'roleOperator');
//
//   // Driven from the power creep loop inside runCreeps() — no standalone call needed.
//
// ============================================================================
// DESIGN
// ============================================================================
//
//   - Each power has a self-contained handler in POWER_HANDLERS
//   - Creeps only attempt powers they actually have leveled
//   - Adding new powers = adding a new handler entry, nothing else changes
//   - Multiple creeps in different rooms with different power sets is supported
//   - Priority loop: Renew → Emergency Ops → Ops Banking → Intel Observe → Powers in config order → Idle
//
// ============================================================================

// --- Power Handler Registry ---
// Each handler defines:
//   getTarget(creep, room)  -> Game object to use the power on, or null for self-cast
//   shouldUse(creep, room, target) -> boolean, whether conditions are met to use now
//   range                   -> how close the creep must be to the target
//   opsCost                 -> ops consumed per use (0 if none)
//   label                   -> friendly name for logging

const POWER_HANDLERS = {};

// ---------------------------------------------------------------------------
// PWR_GENERATE_OPS (1) - Self-cast, generates ops resource
// Generates ops as long as carry is not completely full.
// The deposit-to-storage logic keeps space available so generation never stalls.
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
// recipe requires a factory level (e.g. Composite, Crystal, Liquid).
// ---------------------------------------------------------------------------
POWER_HANDLERS[PWR_OPERATE_FACTORY] = {
    label: 'OperateFactory',
    range: 3,
    opsCost: 100,
    getTarget: function(creep, room) {
        var factories = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) {
                if (s.structureType !== STRUCTURE_FACTORY) return false;
                if (s.effects && s.effects.length) {
                    for (var i = 0; i < s.effects.length; i++) {
                        if (s.effects[i].effect === PWR_OPERATE_FACTORY) return false;
                    }
                }
                return true;
            }
        });
        return factories[0] || null;
    },
    shouldUse: function(creep, room) {
        var orders = Memory.factoryOrders || [];
        var RECIPES = require('factoryManager').RECIPES;
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (o.room !== room.name) continue;
            if (o.status !== 'active') continue;
            var recipe = RECIPES[o.product];
            if (recipe && recipe.level) return true;
        }
        return false;
    }
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
        var spawns = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) {
                if (s.structureType !== STRUCTURE_SPAWN) return false;
                if (!s.spawning) return false;
                if (s.effects && s.effects.length) {
                    for (var i = 0; i < s.effects.length; i++) {
                        if (s.effects[i].effect === PWR_OPERATE_SPAWN) return false;
                    }
                }
                return true;
            }
        });
        return spawns[0] || null;
    },
    shouldUse: function() { return true; }
};

// ---------------------------------------------------------------------------
// PWR_OPERATE_TERMINAL (23) - Reduces transaction cost by 50%
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
        return terminal.store.getUsedCapacity() > 0;
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
        var sources = room.find(FIND_SOURCES, {
            filter: function(s) {
                if (s.effects && s.effects.length) {
                    for (var i = 0; i < s.effects.length; i++) {
                        if (s.effects[i].effect === PWR_REGEN_SOURCE) return false;
                    }
                }
                return true;
            }
        });
        return sources[0] || null;
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
        var labs = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) {
                if (s.structureType !== STRUCTURE_LAB) return false;
                if (!s.mineralType) return false;
                if (s.effects && s.effects.length) {
                    for (var i = 0; i < s.effects.length; i++) {
                        if (s.effects[i].effect === PWR_OPERATE_LAB) return false;
                    }
                }
                return true;
            }
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
        var observers = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) {
                return s.structureType === STRUCTURE_OBSERVER;
            }
        });
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
var OPS_EMERGENCY = 10;

// --- Ops Banking Thresholds ---
// When carry reaches this level, deposit excess ops into room storage.
// When carry is low, withdraw ops back from storage to stay operational.
var OPS_DEPOSIT_THRESHOLD = 695;   // deposit when ops >= this
var OPS_DEPOSIT_AMOUNT = 100;      // how many ops to deposit per trip
var OPS_WITHDRAW_THRESHOLD = 100;  // withdraw when ops fall below this

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
        powers = [
            PWR_GENERATE_OPS,
            PWR_OPERATE_FACTORY,
            PWR_OPERATE_EXTENSION,
            PWR_OPERATE_SPAWN,
            PWR_OPERATE_TERMINAL,
            PWR_REGEN_SOURCE,
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
// Module Exports (called from runCreeps in main.js)
// ============================================================================

module.exports = {

    trySpawn: function(pc, roomName) {
        var room = Game.rooms[roomName];
        if (!room) return;

        var powerSpawns = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_POWER_SPAWN; }
        });
        if (powerSpawns.length === 0) return;

        var result = pc.spawn(powerSpawns[0]);
        if (result === OK) {
            console.log('[Operator] Spawned ' + pc.name + ' in ' + roomName);
        }
    },

    runCreep: function(pc, config) {
        var room = Game.rooms[config.homeRoom];
        if (!room) {
            pc.moveTo(new RoomPosition(25, 25, config.homeRoom));
            return;
        }

        if (pc.room.name !== config.homeRoom) {
            pc.moveTo(new RoomPosition(25, 25, config.homeRoom));
            return;
        }

        // --- PRIORITY 0: Enable power in room (one-time per room) ---
        if (room.controller && !room.controller.isPowerEnabled) {
            var result = pc.enableRoom(room.controller);
            if (result === ERR_NOT_IN_RANGE) {
                pc.moveTo(room.controller, { reusePath: 5 });
                return;
            }
            if (result === OK) {
                console.log('[Operator] Enabled power in ' + room.name);
                return;
            }
        }

        // --- PRIORITY 1: Renew if TTL is low ---
        if (pc.ticksToLive < RENEW_TTL) {
            if (this.doRenew(pc, room)) return;
        }

        // --- PRIORITY 2: Emergency ops generation ---
        var ops = pc.store[RESOURCE_OPS] || 0;
        if (ops <= OPS_EMERGENCY && pc.powers[PWR_GENERATE_OPS]) {
            if (this.tryPower(pc, room, PWR_GENERATE_OPS)) return;
        }

        // --- PRIORITY 2.5: Ops banking (deposit / withdraw) ---
        if (this.handleOpsBanking(pc, room)) return;

        // --- PRIORITY 3: On-demand intel observation (PWR_OPERATE_OBSERVER) ---
        if (this.handleIntelObserve(pc, room)) return;

        // --- PRIORITY 4: Run configured powers in order ---
        var powers = config.powers || [];
        for (var i = 0; i < powers.length; i++) {
            var powerId = powers[i];

            if (!pc.powers || !pc.powers[powerId]) continue;
            if (pc.powers[powerId].cooldown > 0) continue;
            if (!POWER_HANDLERS[powerId]) continue;

            var handler = POWER_HANDLERS[powerId];
            if (handler.opsCost > 0 && ops < handler.opsCost) continue;

            if (this.tryPower(pc, room, powerId)) return;
        }

        // --- IDLE: Move near power spawn for quick renew access ---
        this.idleNearSpawn(pc, room);
    },

    // ========================================================================
    // Ops Banking — deposit excess ops to storage, withdraw when depleted
    // ========================================================================

    /**
     * Manages ops overflow and depletion via room storage.
     *
     * - When carry ops >= OPS_DEPOSIT_THRESHOLD (695), deposit OPS_DEPOSIT_AMOUNT
     *   (100) into storage so generation can continue.
     * - When carry ops < OPS_WITHDRAW_THRESHOLD (100) and storage has ops,
     *   withdraw up to OPS_DEPOSIT_AMOUNT to stay operational.
     *
     * Returns true if the creep was given an action this tick.
     */
    handleOpsBanking: function(pc, room) {
        var storage = room.storage;
        if (!storage) return false;

        var ops = pc.store[RESOURCE_OPS] || 0;

        // ── Deposit: offload ops when near carry capacity ──
        if (ops >= OPS_DEPOSIT_THRESHOLD) {
            var depositAmount = Math.min(OPS_DEPOSIT_AMOUNT, ops);
            var result = pc.transfer(storage, RESOURCE_OPS, depositAmount);
            if (result === OK) {
                return true;
            } else if (result === ERR_NOT_IN_RANGE) {
                pc.moveTo(storage, { reusePath: 5 });
                return true;
            }
            return false;
        }

        // ── Withdraw: pull ops back from storage when running low ──
        if (ops < OPS_WITHDRAW_THRESHOLD) {
            var storageOps = storage.store[RESOURCE_OPS] || 0;
            if (storageOps === 0) return false;

            var cap = pc.store.getCapacity(RESOURCE_OPS) || 700;
            var space = cap - ops;
            var withdrawAmount = Math.min(OPS_DEPOSIT_AMOUNT, storageOps, space);
            if (withdrawAmount <= 0) return false;

            var result = pc.withdraw(storage, RESOURCE_OPS, withdrawAmount);
            if (result === OK) {
                return true;
            } else if (result === ERR_NOT_IN_RANGE) {
                pc.moveTo(storage, { reusePath: 5 });
                return true;
            }
            return false;
        }

        return false;
    },

    handleIntelObserve: function(pc, room) {
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
            if (pc.powers[PWR_GENERATE_OPS] && pc.powers[PWR_GENERATE_OPS].cooldown === 0) {
                pc.usePower(PWR_GENERATE_OPS);
                return true;
            }
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

            var observers = room.find(FIND_MY_STRUCTURES, {
                filter: function(s) { return s.structureType === STRUCTURE_OBSERVER; }
            });
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
        var powerSpawns = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_POWER_SPAWN; }
        });
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
        var powerSpawns = room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_POWER_SPAWN; }
        });
        if (powerSpawns.length === 0) return;

        var spawn = powerSpawns[0];
        if (pc.pos.getRangeTo(spawn) > 3) {
            pc.moveTo(spawn, { reusePath: 10 });
        }
    }
};