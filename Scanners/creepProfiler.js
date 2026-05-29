// creepProfiler.js
// ============================================================================
// Universal Creep Profiler — tracks state and task distribution across ALL
// roles (or a single role) over a configurable number of ticks (default 100).
//
// Usage:
//   const profiler = require('creepProfiler');
//   // In your main loop:
//   profiler.run();
//   profiler.report();    // safe every tick — only prints once when done
//
// Console commands (via global.creepProfile):
//   creepProfile.reset()              — all roles, 100 ticks
//   creepProfile.reset(200)           — all roles, 200 ticks
//   creepProfile.reset(100, 'supplier') — supplier only, 100 ticks
//   creepProfile.list()               — show all supported roles
//
// ============================================================================

var DEFAULT_TICKS = 100;
var VERSION = 2;  // Bump this to confirm deployment

// ---------------------------------------------------------------------------
// Per-role extractors: return { state, task } strings for a given creep.
// Each role stores its status differently, so we normalise here.
// ---------------------------------------------------------------------------

function extractSupplier(creep) {
    var state = creep.memory.s || 'unknown';
    var task = 'none';
    var raw = creep.memory.a;
    if (raw) {
        var idx = raw.indexOf('|');
        task = idx === -1 ? raw : raw.substring(0, idx);
    }
    return { state: state, task: task };
}

// ---------------------------------------------------------------------------
// Static harvesters: no state key in memory. They sit on a source and
// transfer to a link or container every tick. Infer state from carry level,
// and distinguish link-miners from container-miners in the task.
// ---------------------------------------------------------------------------
function extractHarvester(creep) {
    var state;

    if (creep.memory.suicideAfterDelivery) {
        state = 'suiciding';
    } else if (creep.memory.idleUntil && Game.time < creep.memory.idleUntil) {
        state = 'idle';
    } else {
        var used = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var cap  = creep.store.getCapacity(RESOURCE_ENERGY) || 0;

        if (cap === 0) {
            state = 'mining(no_carry)';
        } else if (used === 0) {
            state = 'mining(empty)';
        } else if (used >= cap) {
            state = 'transferring(full)';
        } else {
            var pct = Math.round(used / cap * 100);
            if (pct <= 33) {
                state = 'mining(1-33%)';
            } else if (pct <= 66) {
                state = 'mining(34-66%)';
            } else {
                state = 'mining(67-99%)';
            }
        }
    }

    var srcTag = creep.memory.sourceId
        ? 'source_' + creep.memory.sourceId.slice(-4)
        : 'no_source';

    var outputType = '';
    if (creep.memory.sourceLinkId) {
        outputType = '/link';
    } else if (creep.memory.containerId || creep.memory.sourceContainerId) {
        outputType = '/container';
    }

    return { state: state, task: srcTag + outputType };
}


function extractUpgrader(creep) {
    var state;
    if (creep.memory.working) {
        state = 'upgrading';
    } else if (creep.memory.linkDryId && creep.memory.linkDryUntil && Game.time < creep.memory.linkDryUntil) {
        state = 'waiting_link';
    } else {
        state = 'collecting';
    }
    return { state: state, task: state };
}

function extractBuilder(creep) {
    var state;
    if (creep.memory.filling) {
        state = 'collecting';
    } else {
        state = 'working';
    }
    var taskObj = creep.memory.task;
    var task = 'none';
    if (taskObj) {
        task = taskObj.label || taskObj.type || 'unknown';
    }
    return { state: state, task: task };
}

function extractLabBot(creep) {
    var state = creep.memory.phase || 'unknown';
    if (creep.memory.suicidePending) state = 'suiciding';
    var task = creep.memory.wantedReagents || 'none';
    return { state: state, task: task };
}

function extractHD(creep) {
    var carrying = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var free = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    var state;
    if (carrying === 0) {
        state = 'empty';
    } else if (free === 0) {
        state = 'full';
    } else {
        state = 'partial';
    }
    return { state: state, task: 'stationary' };
}

function extractComboBot(creep) {
    var carrying = creep.store.getUsedCapacity() || 0;
    var free = creep.store.getFreeCapacity() || 0;
    var state;
    if (carrying === 0) {
        state = 'empty';
    } else if (free === 0) {
        state = 'full';
    } else {
        state = 'partial';
    }
    var hasWork = creep.memory._hasWork;
    var task = hasWork ? 'mining_body' : 'carry_body';
    return { state: state, task: task };
}

function extractStaticDistributor(creep) {
    var carrying = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var state = carrying > 0 ? 'distributing' : 'waiting';
    return { state: state, task: 'stationary' };
}

function extractGeneric(creep) {
    var state = 'unknown';
    if (creep.memory.state) {
        state = creep.memory.state;
    } else if (creep.memory.s) {
        state = creep.memory.s;
    } else if (creep.memory.working !== undefined) {
        state = creep.memory.working ? 'working' : 'collecting';
    } else if (creep.memory.harvesting !== undefined) {
        state = creep.memory.harvesting ? 'harvesting' : 'delivering';
    } else if (creep.memory.filling !== undefined) {
        state = creep.memory.filling ? 'collecting' : 'working';
    }

    var task = 'unknown';
    if (creep.memory.task && typeof creep.memory.task === 'object') {
        task = creep.memory.task.label || creep.memory.task.type || 'unknown';
    } else if (typeof creep.memory.task === 'string') {
        task = creep.memory.task;
    } else if (creep.memory.a) {
        var idx = creep.memory.a.indexOf('|');
        task = idx === -1 ? creep.memory.a : creep.memory.a.substring(0, idx);
    }

    return { state: state, task: task };
}

// Registry — add new roles here to get dedicated extraction
var EXTRACTORS = {
    'supplier':            extractSupplier,
    'harvester':           extractHarvester,
    'upgrader':            extractUpgrader,
    'builder':             extractBuilder,
    'labBot':              extractLabBot,
    'labbot':              extractLabBot,
    'hd':                  extractHD,
    'HD':                  extractHD,
    'comboBot':            extractComboBot,
    'combobot':            extractComboBot,
    'staticDistributor':   extractStaticDistributor,
    'distributor':         extractStaticDistributor
};

function extract(creep) {
    var role = creep.memory.role || 'unknown';
    var fn = EXTRACTORS[role] || extractGeneric;
    var result = fn(creep);
    result.role = role;
    return result;
}

// ---------------------------------------------------------------------------
// Task display labels (supplier-specific, others pass through as-is)
// ---------------------------------------------------------------------------
var SUPPLIER_TASK_LABELS = {
    'spawn':                  'Fill Spawns',
    'extension':              'Fill Extensions',
    'tower':                  'Fill Towers',
    'power_spawn_fill':       'Fill Power Spawns',
    'link_drain':             'Drain Links',
    'link_fill':              'Fill Links',
    'container_empty':        'Empty Containers',
    'materials_drain_energy': 'Drain Materials (Energy)',
    'container_drain':        'Drain Containers',
    'materials_empty':        'Empty Materials (Minerals)',
    'terminal_balance':       'Balance Terminal',
    'ground_mineral_pickup':  'Ground Mineral Pickup',
    'fallback_dump':          'Fallback Dump',
    'idle':                   'Idle'
};

function labelTask(role, rawTask) {
    if (role === 'supplier' && SUPPLIER_TASK_LABELS[rawTask]) {
        return SUPPLIER_TASK_LABELS[rawTask];
    }
    return rawTask;
}

// ---------------------------------------------------------------------------
// Data store
// ---------------------------------------------------------------------------

function ensure(ticks, roleFilter) {
    if (!Memory.creepProfiler) {
        Memory.creepProfiler = {
            trackTicks: ticks || DEFAULT_TICKS,
            roleFilter: roleFilter || null,
            startTick: null,
            endTick: null,
            ticksSampled: 0,
            done: false,
            reported: false,
            global: { states: {}, tasks: {}, roles: {} },
            roles: {},
            rooms: {}
        };
    }
    return Memory.creepProfiler;
}

function inc(obj, key) {
    obj[key] = (obj[key] || 0) + 1;
}

function ensureRole(data, role) {
    if (!data.roles[role]) {
        data.roles[role] = { states: {}, tasks: {}, samples: 0 };
    }
    return data.roles[role];
}

function ensureRoom(data, roomName) {
    if (!data.rooms[roomName]) {
        data.rooms[roomName] = { states: {}, tasks: {}, roles: {}, samples: 0,
                                  byRole: {} };
    }
    return data.rooms[roomName];
}

function ensureRoomRole(roomData, role) {
    if (!roomData.byRole) roomData.byRole = {};
    if (!roomData.byRole[role]) {
        roomData.byRole[role] = { states: {}, tasks: {}, samples: 0 };
    }
    return roomData.byRole[role];
}

// ---------------------------------------------------------------------------
// Sorted entries helper
// ---------------------------------------------------------------------------

function sortedEntries(obj) {
    var arr = [];
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
        arr.push({ key: keys[i], count: obj[keys[i]] });
    }
    arr.sort(function(a, b) { return b.count - a.count; });
    return arr;
}

function pctStr(n, total) {
    if (total === 0) return '0.0';
    return (n / total * 100).toFixed(1);
}

function pad(s, len) {
    s = String(s);
    while (s.length < len) s += ' ';
    return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

var creepProfiler = {

    VERSION: VERSION,

    run: function() {
        if (!Memory.creepProfiler) return;

        var data = Memory.creepProfiler;
        if (data.done) return;

        if (data.startTick === null) {
            data.startTick = Game.time;
            data.endTick = Game.time + data.trackTicks - 1;
            var filterMsg = data.roleFilter ? ' (role: ' + data.roleFilter + ')' : ' (all roles)';
            console.log('[CreepProfiler v' + VERSION + '] Started at tick ' + Game.time +
                        ' — capturing ' + data.trackTicks + ' ticks' + filterMsg +
                        ' (until ' + data.endTick + ')');
        }

        if (Game.time > data.endTick) {
            data.done = true;
            return;
        }

        var roleFilter = data.roleFilter || null;
        var names = Object.keys(Game.creeps);
        for (var i = 0; i < names.length; i++) {
            var creep = Game.creeps[names[i]];
            if (!creep || !creep.memory) continue;
            if (creep.spawning) continue;

            var creepRole = creep.memory.role || 'unknown';
            if (roleFilter && creepRole !== roleFilter) continue;

            var info = extract(creep);
            var role = info.role;
            var state = info.state;
            var task = info.task;
            var roomName = creep.room ? creep.room.name : 'unknown';

            // Global
            inc(data.global.states, state);
            inc(data.global.tasks, task);
            inc(data.global.roles, role);

            // Per-role
            var rd = ensureRole(data, role);
            inc(rd.states, state);
            inc(rd.tasks, task);
            rd.samples++;

            // Per-room
            var roomD = ensureRoom(data, roomName);
            inc(roomD.states, state);
            inc(roomD.tasks, task);
            inc(roomD.roles, role);
            roomD.samples++;

            // Per-room-per-role
            var rrD = ensureRoomRole(roomD, role);
            inc(rrD.states, state);
            inc(rrD.tasks, task);
            rrD.samples++;
        }

        data.ticksSampled++;
    },

    report: function() {
        if (!Memory.creepProfiler) return;
        var data = Memory.creepProfiler;
        if (!data.done) return;
        if (data.reported) return;
        data.reported = true;

        var totalSamples = 0;
        var rKeys = Object.keys(data.global.states);
        for (var k = 0; k < rKeys.length; k++) totalSamples += data.global.states[rKeys[k]];

        if (totalSamples === 0) {
            console.log('[CreepProfiler] No samples recorded over ' + data.ticksSampled + ' ticks.');
            delete Memory.creepProfiler;
            return;
        }

        function inline(obj, total, role) {
            var arr = sortedEntries(obj);
            var parts = [];
            for (var i = 0; i < arr.length; i++) {
                var label = role ? labelTask(role, arr[i].key) : arr[i].key;
                parts.push(label + ' ' + pctStr(arr[i].count, total) + '%(' + arr[i].count + ')');
            }
            return parts.join(', ');
        }

        var lines = [];
        var filterTag = data.roleFilter ? ' | role: ' + data.roleFilter : ' | all roles';
        lines.push('═══ CREEP PROFILER v' + VERSION + ' — ' + data.ticksSampled + ' ticks (' +
                    data.startTick + '→' + data.endTick + ')' + filterTag +
                    ' | ' + totalSamples + ' samples ═══');

        if (!data.roleFilter) {
            lines.push('Roles: ' + inline(data.global.roles, totalSamples));
        }

        var roleNames = Object.keys(data.roles).sort();
        for (var rni = 0; rni < roleNames.length; rni++) {
            var roleName = roleNames[rni];
            var rd = data.roles[roleName];
            if (rd.samples === 0) continue;
            lines.push('── ' + roleName.toUpperCase() + ' (' + rd.samples + ') ──  ' +
                        'States: ' + inline(rd.states, rd.samples) + '  |  ' +
                        'Tasks: ' + inline(rd.tasks, rd.samples, roleName));
        }

        var roomNames = Object.keys(data.rooms).sort();
        for (var rmi = 0; rmi < roomNames.length; rmi++) {
            var roomName = roomNames[rmi];
            var roomD = data.rooms[roomName];
            if (roomD.samples === 0) continue;

            if (roomD.byRole) {
                var brKeys = Object.keys(roomD.byRole).sort();
                for (var bri = 0; bri < brKeys.length; bri++) {
                    var brRole = brKeys[bri];
                    var brD = roomD.byRole[brRole];
                    if (brD.samples === 0) continue;
                    var roleTag = brKeys.length > 1 ? ' [' + brRole + ']' : '';
                    lines.push('  ' + roomName + roleTag + ' (' + brD.samples + ')  ' +
                               'States: ' + inline(brD.states, brD.samples) + '  |  ' +
                               'Tasks: ' + inline(brD.tasks, brD.samples, brRole));
                }
            }
        }

        lines.push('═══ END CREEP PROFILER ═══');
        console.log(lines.join('\n'));

        var batch = '';
        for (var ni = 0; ni < lines.length; ni++) {
            var line = lines[ni];
            if (batch.length > 0 && batch.length + 1 + line.length > 400) {
                Game.notify(batch, 0);
                batch = '';
            }
            if (line.length > 400) {
                line = line.substring(0, 397) + '...';
            }
            batch = batch.length > 0 ? batch + '\n' + line : line;
        }
        if (batch.length > 0) {
            Game.notify(batch, 0);
        }

        delete Memory.creepProfiler;
    },

    reset: function(ticks, role) {
        delete Memory.creepProfiler;
        if (typeof ticks === 'string') {
            role = ticks;
            ticks = DEFAULT_TICKS;
        }
        ensure(ticks || DEFAULT_TICKS, role || null);
        var msg = '[CreepProfiler v' + VERSION + '] Reset. Capture: ' + (ticks || DEFAULT_TICKS) + ' ticks';
        if (role) msg += ', role: ' + role;
        console.log(msg);
    },

    list: function() {
        var dedicatedKeys = Object.keys(EXTRACTORS);
        var seen = {};
        var unique = [];
        for (var i = 0; i < dedicatedKeys.length; i++) {
            var lower = dedicatedKeys[i].toLowerCase();
            if (!seen[lower]) {
                seen[lower] = true;
                unique.push(dedicatedKeys[i]);
            }
        }
        unique.sort();
        console.log('');
        console.log('═══ Supported Roles (dedicated extractors) ═══');
        for (var j = 0; j < unique.length; j++) {
            console.log('  • ' + unique[j]);
        }
        console.log('');
        console.log('Any other role will use the generic extractor');
        console.log('(reads memory.state / .s / .working / .harvesting / .filling / .task)');
        console.log('');
        console.log('Usage: creepProfile.reset(100, \'' + unique[0] + '\')');
        console.log('');
    },

    isDone: function() {
        return !Memory.creepProfiler;
    }
};

module.exports = creepProfiler;
