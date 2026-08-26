// LLM: Read docs/codex.js before reviewing or changing this file.
// roleOperator.js
// Role dispatch: roleOperator.runCreep(powerCreep, Memory.operators[name]).
// Console globals: createOperator, removeOperator, showOperator, listOperators, setupOperator, setupSourceRegen, disableSourceRegen, showSourceRegen, upgradeOperator, listPowers
// Example: createOperator('operatorName', 'E1N1') - Spawn and initialize power creep operator
// Example: removeOperator('operatorName') - Remove power creep operator configuration
// Example: showOperator('operatorName') - Display power creep operator status and powers
// Example: listOperators() - List all configured power creep operators
// Example: setupOperator('operatorName', 'E1N1') - Configure operator home room and powers
// Example: setupSourceRegen('E1N1') - Configure PWR_REGEN_SOURCE cycle for operator
// Example: disableSourceRegen('E1N1') - Disable PWR_REGEN_SOURCE automation in room
// Example: showSourceRegen('E1N1') - Inspect PWR_REGEN_SOURCE assignments and cooldowns
// Example: upgradeOperator('operatorName', PWR_GENERATE_OPS) - Upgrade power creep ability
// Example: listPowers() - Display available power abilities and unlock levels
//   Game.powerCreeps after 1 tick; not yet spawned into a room (setupOperator).
//   have multiple levels (e.g. PWR_GENERATE_OPS). listPowers() for IDs.
//   priority order; auto-spawns at the room's PowerSpawn each tick when dead.
//   Assigns with an explicit priority list (highest first); unlearned powers
//   are silently skipped.
//   createOperator('C1') -> upgradeOperator('C1', PWR_GENERATE_OPS) ->
//   upgradeOperator('C1', PWR_OPERATE_FACTORY) ->
//   upgradeOperator('C1', PWR_OPERATE_EXTENSION) ->
//   setupOperator('C1', 'E2N46', [PWR_GENERATE_OPS, PWR_OPERATE_FACTORY, PWR_OPERATE_EXTENSION])
//   The creep auto-spawns at the PowerSpawn and begins its power cycle.
//   Not part of the default power cycle -- fires on demand when intel()
//   needs a room beyond normal observer range (10 rooms). Flow: intel()
//   finds no structural observer in range -> locates an operator with
//   PWR_OPERATE_OBSERVER + an observer in its home room, writes
//   Memory.intelPowerObserve -> next tick the operator fires the power, the
//   observer calls observeRoom(), the request is cleaned up -> the tick
//   after, processPendingIntel() auto-completes the report. Enable with
//   upgradeOperator('C1', PWR_OPERATE_OBSERVER); no other setup needed.
//   setupSourceRegen(operatorName, roomName, [initialDelay=125])  Activates
//     effect-based regen: discovers sources, records per-source next-due
//     ticks. After a regen, next due = (regen tick) + 125 * sourceCount, so
//     sources naturally alternate on a 125-tick cadence.
//   disableSourceRegen(operatorName)  Clears regen memory.
//   showSourceRegen(operatorName)     Per-source last-regen and next-due.
//   getTarget(creep, room)          Game object to target, or null for self
//   shouldUse(creep, room, target)  boolean, conditions met to use now
//   range                           required distance to target
//   opsCost                         ops consumed per use (0 if none)
//   label                           friendly name for logging
const getRoomState = require("getRoomState");
const storageManager = require("storageManager");
//   Memory.operatorSourceRegen[operatorName] = {
//       roomName:    string,
//       sources: {
//           [sourceId]: {
//               lastRegenTick: number, // tick of last successful regen
//               nextDueTick:   number, // tick the operator should regen again
//           }
//       }
//   }
//   On setup: nextDueTick = Game.time + initialDelay + (i * 125).
//     This staggers sources so the operator casts on one source every 125 ticks.
//   On regen OK: lastRegenTick = Game.time, nextDueTick = Game.time + 125 * sourceCount
function _myStructuresByType(e, r) {
  var o = getRoomState.get(e.name);
  var t = o && o.structuresByType && o.structuresByType[r] || [];
  var n = [];
  for (var a = 0; a < t.length; a++) {
    if (t[a].my) n.push(t[a]);
  }
  return n;
}

function _structuresOfTypeWith(e, r, o) {
  var t = getRoomState.get(e.name);
  if (t && t.structuresByType && t.structuresByType[r]) {
    var n = t.structuresByType[r];
    var a = [];
    for (var s = 0; s < n.length; s++) {
      if (n[s].my && o(n[s])) a.push(n[s]);
    }
    return a;
  }
  return e.find(FIND_MY_STRUCTURES, {
    filter: function(e) {
      return e.structureType === r && o(e);
    }
  });
}

const POWER_HANDLERS = {};
POWER_HANDLERS[PWR_GENERATE_OPS] = {
  label: "GenerateOps",
  range: 0,
  opsCost: 0,
  getTarget: function() {
    return null;
  },
  shouldUse: function(e) {
    var r = e.store[RESOURCE_OPS] || 0;
    var o = e.store.getCapacity(RESOURCE_OPS) || 100;
    return r < o;
  }
};
POWER_HANDLERS[PWR_OPERATE_FACTORY] = {
  label: "OperateFactory",
  range: 3,
  opsCost: 100,
  getTarget: function(e, r) {
    var o = 0;
    var t = require("factoryManager");
    var n = t && typeof t.getOrders === "function" ? t.getOrders() : [];
    var a = t.getRecipe;
    for (var s = 0; s < n.length; s++) {
      var u = n[s];
      if (u.room !== r.name || u.status !== "active") continue;
      var i = a(u.product);
      if (i && i.level) {
        o = i.level;
        break;
      }
    }
    if (!o) return null;
    var R = _structuresOfTypeWith(r, STRUCTURE_FACTORY, function(e) {
      if (e.effects && e.effects.length) {
        for (var r = 0; r < e.effects.length; r++) {
          if (e.effects[r].effect === PWR_OPERATE_FACTORY) {
            return e.effects[r].level !== o;
          }
        }
      }
      return true;
    });
    return R[0] || null;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_OPERATE_EXTENSION] = {
  label: "OperateExtension",
  range: 3,
  opsCost: 2,
  getTarget: function(e, r) {
    if (r.energyAvailable >= r.energyCapacityAvailable) return null;
    if (r.storage && r.storage.store[RESOURCE_ENERGY] > 0) return r.storage;
    if (r.terminal && r.terminal.store[RESOURCE_ENERGY] > 0) return r.terminal;
    return null;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_OPERATE_SPAWN] = {
  label: "OperateSpawn",
  range: 3,
  opsCost: 100,
  getTarget: function(e, r) {
    var o = _structuresOfTypeWith(r, STRUCTURE_SPAWN, function(e) {
      if (!e.spawning) return false;
      if (e.effects && e.effects.length) {
        for (var r = 0; r < e.effects.length; r++) {
          if (e.effects[r].effect === PWR_OPERATE_SPAWN) return false;
        }
      }
      return true;
    });
    return o[0] || null;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_OPERATE_TERMINAL] = {
  label: "OperateTerminal",
  range: 3,
  opsCost: 100,
  getTarget: function(e, r) {
    var o = r.terminal;
    if (!o) return null;
    if (o.effects && o.effects.length) {
      for (var t = 0; t < o.effects.length; t++) {
        if (o.effects[t].effect === PWR_OPERATE_TERMINAL) return null;
      }
    }
    return o;
  },
  shouldUse: function(e, r) {
    var o = r.terminal;
    if (!o) return false;
    return o.cooldown > 0;
  }
};
POWER_HANDLERS[PWR_REGEN_SOURCE] = {
  label: "RegenSource",
  range: 3,
  opsCost: 0,
  getTarget: function(e, r) {
    var o = getRoomState.get(r.name);
    var t = o && o.sources || r.find(FIND_SOURCES);
    var n = [];
    for (var a = 0; a < t.length; a++) {
      var s = t[a];
      if (s.effects && s.effects.length) {
        var u = false;
        for (var i = 0; i < s.effects.length; i++) {
          if (s.effects[i].effect === PWR_REGEN_SOURCE) {
            u = true;
            break;
          }
        }
        if (u) continue;
      }
      n.push(s);
    }
    return n[0] || null;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_REGEN_MINERAL] = {
  label: "RegenMineral",
  range: 3,
  opsCost: 0,
  getTarget: function(e, r) {
    var o = getRoomState.get(r.name);
    var t = o && o.minerals || r.find(FIND_MINERALS);
    var n = [];
    for (var a = 0; a < t.length; a++) {
      var s = t[a];
      if (s.mineralAmount === 0) continue;
      if (s.ticksToRegeneration > 0) continue;
      if (s.effects && s.effects.length) {
        var u = false;
        for (var i = 0; i < s.effects.length; i++) {
          if (s.effects[i].effect === PWR_REGEN_MINERAL) {
            u = true;
            break;
          }
        }
        if (u) continue;
      }
      n.push(s);
    }
    return n[0] || null;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_OPERATE_STORAGE] = {
  label: "OperateStorage",
  range: 3,
  opsCost: 100,
  getTarget: function(e, r) {
    var o = r.storage;
    if (!o) return null;
    if (o.effects && o.effects.length) {
      for (var t = 0; t < o.effects.length; t++) {
        if (o.effects[t].effect === PWR_OPERATE_STORAGE) return null;
      }
    }
    return o;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_OPERATE_LAB] = {
  label: "OperateLab",
  range: 3,
  opsCost: 10,
  getTarget: function(e, r) {
    var o = _structuresOfTypeWith(r, STRUCTURE_LAB, function(e) {
      if (!e.mineralType) return false;
      if (e.effects && e.effects.length) {
        for (var r = 0; r < e.effects.length; r++) {
          if (e.effects[r].effect === PWR_OPERATE_LAB) return false;
        }
      }
      return true;
    });
    return o[0] || null;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_OPERATE_CONTROLLER] = {
  label: "OperateController",
  range: 3,
  opsCost: 200,
  getTarget: function(e, r) {
    var o = r.controller;
    if (!o || o.level >= 8) return null;
    if (o.effects && o.effects.length) {
      for (var t = 0; t < o.effects.length; t++) {
        if (o.effects[t].effect === PWR_OPERATE_CONTROLLER) return null;
      }
    }
    return o;
  },
  shouldUse: function() {
    return true;
  }
};
POWER_HANDLERS[PWR_OPERATE_OBSERVER] = {
  label: "OperateObserver",
  range: 3,
  opsCost: 10,
  getTarget: function(e, r) {
    var o = _myStructuresByType(r, STRUCTURE_OBSERVER);
    return o[0] || null;
  },
  shouldUse: function() {
    return false;
  }
};
var RENEW_TTL = 500;
var OPS_DEPOSIT_PCT = .85;
var OPS_WITHDRAW_PCT = .15;
var OPS_BANK_AMOUNT_PCT = .15;
global.createOperator = function(e) {
  if (Game.powerCreeps[e]) {
    return '⚠️ Power creep "' + e + '" already exists.';
  }
  var r = PowerCreep.create(e, POWER_CLASS.OPERATOR);
  if (r === OK) {
    return '✅ Created power creep "' + e + '"\n' + "   Wait 1 tick, then use upgradeOperator() to add powers.\n" + "   Example: upgradeOperator('" + e + "', PWR_GENERATE_OPS)";
  } else if (r === ERR_NAME_EXISTS) {
    return '⚠️ A power creep named "' + e + '" already exists.';
  } else if (r === ERR_NOT_ENOUGH_RESOURCES) {
    return "❌ Not enough GPL levels available. Process more Power to level up.";
  } else {
    return "❌ Failed to create power creep. Error code: " + r;
  }
};
global.upgradeOperator = function(e, r) {
  var o = Game.powerCreeps[e];
  if (!o) {
    return '❌ Power creep "' + e + '" not found.\n' + "   Create it first: createOperator('" + e + "')\n" + "   Then wait 1 tick before upgrading.";
  }
  if (r === undefined || r === null) {
    return "❌ No power specified.\n" + "   Usage: upgradeOperator('" + e + "', PWR_GENERATE_OPS)\n" + "   Run listPowers() to see all available power IDs.";
  }
  var t = o.powers && o.powers[r] ? o.powers[r].level : 0;
  var n = POWER_HANDLERS[r];
  var a = n ? n.label : "Power_" + r;
  var s = o.upgrade(r);
  if (s === OK) {
    return '✅ Upgraded "' + e + '" → ' + a + " (now level " + (t + 1) + ")";
  } else if (s === ERR_NOT_ENOUGH_RESOURCES) {
    return '❌ No available power levels on "' + e + '". Need more GPL.';
  } else if (s === ERR_FULL) {
    return "❌ " + a + ' is already at max level on "' + e + '".';
  } else {
    return "❌ Failed to upgrade. Error code: " + s;
  }
};
global.setupOperator = function(e, r, o) {
  if (!Game.powerCreeps[e]) {
    return '❌ Power creep "' + e + '" not found.\n' + "   Create it first: createOperator('" + e + "')";
  }
  if (!Memory.operators) Memory.operators = {};
  if (!o || !o.length) {
    o = [ PWR_GENERATE_OPS, PWR_REGEN_SOURCE, PWR_REGEN_MINERAL, PWR_OPERATE_EXTENSION, PWR_OPERATE_FACTORY, PWR_OPERATE_SPAWN, PWR_OPERATE_TERMINAL, PWR_OPERATE_STORAGE, PWR_OPERATE_LAB, PWR_OPERATE_CONTROLLER ];
  }
  Memory.operators[e] = {
    homeRoom: r,
    powers: o
  };
  var t = Game.powerCreeps[e];
  var n = [];
  var a = [];
  for (var s = 0; s < o.length; s++) {
    var u = o[s];
    var i = POWER_HANDLERS[u];
    var R = i ? i.label : "Unknown_" + u;
    if (t.powers && t.powers[u]) {
      n.push(R + " (lvl " + t.powers[u].level + ")");
    } else {
      a.push(R);
    }
  }
  var f = t.powers && t.powers[PWR_OPERATE_OBSERVER];
  var E = '✅ Operator "' + e + '" → ' + r + "\n";
  E += "   Active: " + (n.length ? n.join(", ") : "none") + "\n";
  if (a.length) {
    E += "   Skipped (not learned): " + a.join(", ") + "\n";
  }
  if (f) {
    E += "   🔭 OperateObserver available for on-demand intel (not in cycle)";
  }
  return E;
};
global.removeOperator = function(e) {
  if (Memory.operators && Memory.operators[e]) {
    delete Memory.operators[e];
    return '🗑️ Removed operator config for "' + e + '"';
  }
  return '⚠️ No config found for "' + e + '"';
};
global.listOperators = function() {
  if (!Memory.operators || !Object.keys(Memory.operators).length) {
    return "No operators configured. Use setupOperator(name, room) to assign one.";
  }
  var e = [ "=== Configured Operators ===" ];
  for (var r in Memory.operators) {
    var o = Memory.operators[r];
    var t = Game.powerCreeps[r];
    var n = t && t.ticksToLive ? "alive, TTL " + t.ticksToLive : "not spawned";
    var a = t && t.powers && t.powers[PWR_OPERATE_OBSERVER] ? " [🔭 intel]" : "";
    e.push("  " + r + " → " + o.homeRoom + " (" + n + ")" + a);
  }
  return e.join("\n");
};
global.showOperator = function(e) {
  var r = Game.powerCreeps[e];
  if (!r) {
    return '❌ Power creep "' + e + '" not found.';
  }
  var o = [ "=== " + e + " ===" ];
  o.push("  Class: " + r.className);
  o.push("  Level: " + r.level);
  o.push("  TTL: " + (r.ticksToLive || "not spawned"));
  o.push("  Room: " + (r.room ? r.room.name : "none"));
  o.push("  Ops: " + (r.store[RESOURCE_OPS] || 0));
  if (r.powers && Object.keys(r.powers).length > 0) {
    o.push("  Powers:");
    for (var t in r.powers) {
      var n = r.powers[t];
      var a = POWER_HANDLERS[t];
      var s = a ? a.label : "Unknown_" + t;
      var u = parseInt(t) === PWR_OPERATE_OBSERVER ? " [on-demand only]" : "";
      o.push("    " + s + " → lvl " + n.level + " (cooldown: " + n.cooldown + ")" + u);
    }
  } else {
    o.push("  Powers: none — use upgradeOperator('" + e + "', PWR_GENERATE_OPS)");
  }
  var i = Memory.operators ? Memory.operators[e] : null;
  if (i) {
    o.push("  Assigned: " + i.homeRoom);
  } else {
    o.push("  Assigned: none — use setupOperator('" + e + "', 'RoomName')");
  }
  return o.join("\n");
};
global.listPowers = function() {
  var e = [ "=== Supported Powers ===" ];
  e.push("  PWR_GENERATE_OPS (" + PWR_GENERATE_OPS + ")        - Generate ops (self-cast, no cost)");
  e.push("  PWR_OPERATE_FACTORY (" + PWR_OPERATE_FACTORY + ")     - Set factory level (100 ops)");
  e.push("  PWR_OPERATE_EXTENSION (" + PWR_OPERATE_EXTENSION + ")   - Fill extensions instantly (2 ops)");
  e.push("  PWR_OPERATE_SPAWN (" + PWR_OPERATE_SPAWN + ")       - +30% spawn speed (100 ops)");
  e.push("  PWR_OPERATE_TERMINAL (" + PWR_OPERATE_TERMINAL + ")    - -50% transaction cost (100 ops)");
  e.push("  PWR_REGEN_SOURCE (" + PWR_REGEN_SOURCE + ")        - +50% source energy (free)");
  e.push("  PWR_REGEN_MINERAL (" + PWR_REGEN_MINERAL + ")       - Regen mineral deposit (free)");
  e.push("  PWR_OPERATE_STORAGE (" + PWR_OPERATE_STORAGE + ")     - +500k storage cap (100 ops)");
  e.push("  PWR_OPERATE_LAB (" + PWR_OPERATE_LAB + ")         - +2 reaction/tick (10 ops)");
  e.push("  PWR_OPERATE_CONTROLLER (" + PWR_OPERATE_CONTROLLER + ")  - +8 upgrade/tick (200 ops)");
  e.push("  PWR_OPERATE_OBSERVER (" + PWR_OPERATE_OBSERVER + ")    - Observe any room [on-demand via intel] (10 ops)");
  e.push("");
  e.push("  Usage: upgradeOperator('CreepName', PWR_GENERATE_OPS)");
  e.push("  Note:  PWR_OPERATE_OBSERVER is not added to the power cycle.");
  e.push("         It fires automatically when intel() needs a distant room.");
  return e.join("\n");
};
var SOURCE_REGEN_CAST_INTERVAL = 125;
var SOURCE_REGEN_TRAVEL_LEAD = 40;
var SOURCE_REGEN_RENEW_AT = 150;
var REGEN_DEFAULT_INITIAL_DELAY = 125;
function getRegenSourceDuration(e) {
  if (typeof POWER_INFO !== "undefined" && POWER_INFO[PWR_REGEN_SOURCE] && POWER_INFO[PWR_REGEN_SOURCE].duration) {
    var r = e.powers && e.powers[PWR_REGEN_SOURCE] && e.powers[PWR_REGEN_SOURCE].level || 1;
    var o = POWER_INFO[PWR_REGEN_SOURCE].duration[r - 1];
    if (typeof o === "number") return o;
  }
  return 300;
}

global.setupSourceRegen = function(e, r, o) {
  var t = Game.powerCreeps[e];
  if (!t) return '❌ Power creep "' + e + '" not found.';
  if (!t.powers || !t.powers[PWR_REGEN_SOURCE]) {
    return '❌ "' + e + '" has not learned PWR_REGEN_SOURCE.';
  }
  if (!Game.rooms[r]) return "❌ Room " + r + " not visible.";
  var n = getRoomState.get(r);
  var a = n && n.sources || Game.rooms[r].find(FIND_SOURCES);
  if (!a || !a.length) return "❌ No sources found in " + r + ".";
  if (o === undefined || o === null) {
    o = REGEN_DEFAULT_INITIAL_DELAY;
  }
  o = Math.max(0, Math.floor(o));
  var s = getRegenSourceDuration(t);
  var u = a.length;
  if (!Memory.operatorSourceRegen) Memory.operatorSourceRegen = {};
  var i = Memory.operatorSourceRegen[e];
  var R = i && i.sources ? i.sources : null;
  var f = {};
  for (var E = 0; E < a.length; E++) {
    var l = a[E].id;
    var c = R && R[l];
    var _;
    _ = Game.time + o + E * SOURCE_REGEN_CAST_INTERVAL;
    f[l] = {
      lastRegenTick: c ? c.lastRegenTick || 0 : 0,
      nextDueTick: _
    };
  }
  Memory.operatorSourceRegen[e] = {
    roomName: r,
    castInterval: SOURCE_REGEN_CAST_INTERVAL,
    sources: f
  };
  var p = null;
  for (var O in f) {
    if (p === null || f[O].nextDueTick < p) {
      p = f[O].nextDueTick;
    }
  }
  return "🔁 Source regen enabled for " + e + " in " + r + " — " + u + " source(s), duration " + s + "t, interval " + SOURCE_REGEN_CAST_INTERVAL + "t" + ", first regen in ~" + Math.max(0, p - Game.time) + "t";
};
global.disableSourceRegen = function(e) {
  if (!Memory.operatorSourceRegen || !Memory.operatorSourceRegen[e]) {
    return "⚠️ No source regen configured for " + e + ".";
  }
  delete Memory.operatorSourceRegen[e];
  return "🗑️ Source regen disabled for " + e + ".";
};
global.showSourceRegen = function(e) {
  if (!Memory.operatorSourceRegen || !Memory.operatorSourceRegen[e]) {
    return "No source regen configured for " + e + ".";
  }
  var r = Memory.operatorSourceRegen[e];
  var o = [ "=== Source Regen: " + e + " (" + r.roomName + ") ===" ];
  var t = Object.keys(r.sources || {});
  t.sort(function(e, o) {
    return r.sources[e].nextDueTick - r.sources[o].nextDueTick;
  });
  for (var n = 0; n < t.length; n++) {
    var a = r.sources[t[n]];
    var s = a.nextDueTick - Game.time;
    var u = a.lastRegenTick ? "last regen " + a.lastRegenTick : "never regened";
    o.push("  " + t[n] + " | next due in " + s + "t (tick " + a.nextDueTick + ")" + " | " + u);
  }
  return o.join("\n");
};
module.exports = {
  trySpawn: function(e, r) {
    var o = Game.rooms[r];
    if (!o) return;
    var t = _myStructuresByType(o, STRUCTURE_POWER_SPAWN);
    if (t.length === 0) return;
    var n = e.spawn(t[0]);
    if (n === OK) {
      console.log("[Operator] Spawned " + e.name + " in " + r);
    }
  },
  //   Layer 0 (Unconditional): PWR_GENERATE_OPS is attempted here. Self-cast,
  //                            range 0, and available during travel phases.
  //   Layer 1 (Power):    Fire all ready, in-range powers. Free action —
  //                       usePower does NOT consume the movement slot.
  //   Layer 2 (Movement): Mutually exclusive — first match wins.
  //                       Renew → Banking → Intel → Move-commit → Idle
  runCreep: function(e, r) {
    if (!e || !r || !r.homeRoom) return;
    var o = false;
    var t = Game.rooms[r.homeRoom];
    if (!t) {
      o = this.tryGenerateOps(e);
      e.moveTo(new RoomPosition(25, 25, r.homeRoom));
      return;
    }
    if (e.room.name !== r.homeRoom) {
      o = this.tryGenerateOps(e);
      e.moveTo(new RoomPosition(25, 25, r.homeRoom));
      return;
    }
    if (t.controller && !t.controller.isPowerEnabled) {
      var n = e.enableRoom(t.controller);
      if (n === ERR_NOT_IN_RANGE) {
        o = this.tryGenerateOps(e);
        e.moveTo(t.controller, {
          reusePath: 5
        });
        return;
      }
      if (n === OK) {
        console.log("[Operator] Enabled power in " + t.name);
        return;
      }
    }
    if (Memory.operatorSourceRegen && Memory.operatorSourceRegen[e.name] && Memory.operatorSourceRegen[e.name].sources) {
      if (e.ticksToLive < RENEW_TTL) {} else if (this.handleSourceRegen(e, t, true, true)) {
        if (!e.memory) e.memory = {};
        e.memory._powerUsedTick = Game.time;
        return;
      }
    }
    o = this.tryGenerateOps(e);
    if (Memory.operatorSourceRegen && Memory.operatorSourceRegen[e.name] && Memory.operatorSourceRegen[e.name].sources) {
      if (e.ticksToLive < RENEW_TTL) {} else if (this.handleSourceRegen(e, t, !o, false)) {
        if (!e.memory) e.memory = {};
        e.memory._powerUsedTick = o ? Game.time : 0;
        return;
      }
    }
    if (!o) {
      o = this.executeScheduledPower(e, t, r);
    }
    if (!e.memory) e.memory = {};
    e.memory._powerUsedTick = o ? Game.time : 0;
    if (e.ticksToLive < RENEW_TTL) {
      if (this.doRenew(e, t)) return;
    }
    if (this.handleOpsBanking(e, t)) return;
    if (this.handleIntelObserve(e, t)) return;
    if (this.handleMoveCommit(e, t, r)) return;
    this.idleNearSpawn(e, t);
  },
  executeScheduledPower: function(e, r, o) {
    var t = e.store[RESOURCE_OPS] || 0;
    var n = o.powers || [];
    for (var a = 0; a < n.length; a++) {
      var s = n[a];
      if (s === PWR_GENERATE_OPS) continue;
      if (s === PWR_REGEN_SOURCE && Memory.operatorSourceRegen && Memory.operatorSourceRegen[e.name]) continue;
      if (!e.powers || !e.powers[s]) continue;
      if (e.powers[s].cooldown > 0) continue;
      var u = POWER_HANDLERS[s];
      if (!u) continue;
      if (u.opsCost > 0 && t < u.opsCost) continue;
      if (this.tryPowerInRange(e, r, s)) {
        return true;
      }
    }
    return false;
  },
  tryGenerateOps: function(e) {
    if (e.powers && e.powers[PWR_GENERATE_OPS] && e.powers[PWR_GENERATE_OPS].cooldown === 0) {
      return this.tryPowerInRange(e, null, PWR_GENERATE_OPS);
    }
    return false;
  },
  //   1. If a commit exists, validate it (target still needs the power,
  //      cooldown still 0, can still afford ops).
  //   2. If valid and in range — hold position so Layer 1 fires the power.
  //      Clear after 3 ticks if unfired (safety valve).
  //   3. If valid and out of range — keep walking.
  //   4. If invalid — clear lock and fall through to find a new target.
  //   5. If no commit, scan for the highest-priority out-of-range target.
  handleMoveCommit: function(e, r, o) {
    var t = e.store[RESOURCE_OPS] || 0;
    var n = e.memory || {};
    if (!n._moveCommit) n._moveCommit = null;
    if (n._moveCommit) {
      var a = n._moveCommit;
      var s = Game.getObjectById(a.targetId);
      var u = POWER_HANDLERS[a.powerId];
      var i = s && u && e.powers[a.powerId] && e.powers[a.powerId].cooldown === 0 && (u.opsCost === 0 || t >= u.opsCost) && u.shouldUse(e, r, s);
      if (i && u.range > 0) {
        var R = u.getTarget(e, r);
        if (!R || R.id !== s.id) {
          i = false;
        }
      }
      if (i) {
        if (e.pos.getRangeTo(s) <= u.range) {
          if (!a.inRangeSince) a.inRangeSince = Game.time;
          if (Game.time - a.inRangeSince > 3) {
            n._moveCommit = null;
            return false;
          }
          return true;
        } else {
          a.inRangeSince = null;
          e.moveTo(s, {
            reusePath: 5
          });
          return true;
        }
      } else {
        n._moveCommit = null;
      }
    }
    var f = this.findMoveTarget(e, r, o, t);
    if (f) {
      n._moveCommit = {
        targetId: f.target.id,
        powerId: f.powerId
      };
      e.moveTo(f.target, {
        reusePath: 5
      });
      return true;
    }
    return false;
  },
  handleSourceRegen: function(e, r, o, t) {
    if (o === undefined) o = true;
    if (t === undefined) t = false;
    if (!Memory.operatorSourceRegen) return false;
    var n = Memory.operatorSourceRegen[e.name];
    if (!n || !n.sources) return false;
    if (!e.powers || !e.powers[PWR_REGEN_SOURCE]) return false;
    if (n.castInterval !== SOURCE_REGEN_CAST_INTERVAL) {
      var a = Object.keys(n.sources);
      a.sort(function(e, r) {
        return (n.sources[e].nextDueTick || 0) - (n.sources[r].nextDueTick || 0);
      });
      for (var s = 0; s < a.length; s++) {
        n.sources[a[s]].nextDueTick = Game.time + s * SOURCE_REGEN_CAST_INTERVAL;
      }
      n.castInterval = SOURCE_REGEN_CAST_INTERVAL;
    }
    //   1. no active regen effect
    //   2. active effect at/below renewal threshold
    //   3. scheduled soon enough to pre-position
        var u = null;
    var i = null;
    var R = null;
    var f = Infinity;
    var E = 0;
    var l = Game.time + SOURCE_REGEN_TRAVEL_LEAD;
    for (var c in n.sources) {
      var _ = n.sources[c];
      E++;
      if (typeof _.nextDueTick !== "number") continue;
      var p = Game.getObjectById(c);
      if (!p) continue;
      var O = 0;
      if (p.effects && p.effects.length) {
        for (var m = 0; m < p.effects.length; m++) {
          if (p.effects[m].effect === PWR_REGEN_SOURCE) {
            O = p.effects[m].ticksRemaining || 0;
            break;
          }
        }
      }
      var v;
      if (O <= 0) {
        var P = _.nextDueTick - Game.time;
        if (P < -9e5) P = -9e5;
        if (P > 9e5) P = 9e5;
        v = -2e6 + P;
      } else if (O <= SOURCE_REGEN_RENEW_AT) {
        v = -1e6 + O;
      } else if (_.nextDueTick <= l) {
        v = _.nextDueTick - Game.time;
      } else {
        continue;
      }
      if (v < f) {
        u = _;
        i = c;
        R = p;
        f = v;
      }
    }
    if (!u) return false;
    var T = R || Game.getObjectById(i);
    if (!T) {
      if (u.nextDueTick < Game.time) {
        var g = SOURCE_REGEN_CAST_INTERVAL * Math.max(1, E);
        var S = Math.floor((Game.time - u.nextDueTick) / g) + 1;
        u.nextDueTick += S * g;
      }
      return false;
    }
    if (n.roomName && e.room.name !== n.roomName) {
      if (t) return false;
      e.moveTo(T, {
        reusePath: 5
      });
      return true;
    }
    if (e.pos.getRangeTo(T) > 3) {
      if (t) return false;
      e.moveTo(T, {
        reusePath: 5
      });
      return true;
    }
    var N = 0;
    if (T.effects && T.effects.length) {
      for (var d = 0; d < T.effects.length; d++) {
        if (T.effects[d].effect === PWR_REGEN_SOURCE) {
          N = T.effects[d].ticksRemaining || 0;
          break;
        }
      }
    }
    if (u.nextDueTick > Game.time && N > SOURCE_REGEN_RENEW_AT) {
      return t ? false : true;
    }
    if (!o || e.powers[PWR_REGEN_SOURCE].cooldown > 0) {
      return t ? false : true;
    }
    var A = e.usePower(PWR_REGEN_SOURCE, T);
    if (A === OK) {
      var h = SOURCE_REGEN_CAST_INTERVAL * Math.max(1, E);
      u.lastRegenTick = Game.time;
      u.nextDueTick = Game.time + h;
      console.log("[Operator] 🔁 Source regen fired on " + i + " in " + (T.room ? T.room.name : n.roomName || "?") + " — next due in " + h + "t");
      return true;
    }
    console.log("[Operator] Source regen on " + i + " failed → code " + A + " (will retry next tick)");
    return true;
  },
  tryPowerInRange: function(e, r, o) {
    var t = POWER_HANDLERS[o];
    if (!t) return false;
    if (t.range === 0) {
      if (!t.shouldUse(e, null, null)) return false;
      return e.usePower(o) === OK;
    }
    if (!r) return false;
    var n = t.getTarget(e, r);
    if (!n) return false;
    if (!t.shouldUse(e, r, n)) return false;
    if (e.pos.getRangeTo(n) > t.range) return false;
    var a = e.usePower(o, n);
    if (a !== OK) {
      console.log("[Operator] " + t.label + " failed on " + n + " → code " + a);
    }
    return a === OK;
  },
  findMoveTarget: function(e, r, o, t) {
    if (e.powers && e.powers[PWR_OPERATE_TERMINAL] && e.powers[PWR_OPERATE_TERMINAL].cooldown === 0) {
      var n = POWER_HANDLERS[PWR_OPERATE_TERMINAL];
      if (t >= n.opsCost) {
        var a = n.getTarget(e, r);
        if (a && n.shouldUse(e, r, a)) {
          if (e.pos.getRangeTo(a) > n.range) {
            return {
              target: a,
              powerId: PWR_OPERATE_TERMINAL
            };
          }
        }
      }
    }
    var s = o.powers || [];
    for (var u = 0; u < s.length; u++) {
      var i = s[u];
      if (i === PWR_REGEN_SOURCE && Memory.operatorSourceRegen && Memory.operatorSourceRegen[e.name]) continue;
      if (!e.powers || !e.powers[i]) continue;
      if (e.powers[i].cooldown > 0) continue;
      if (!POWER_HANDLERS[i]) continue;
      var R = POWER_HANDLERS[i];
      if (R.range === 0) continue;
      if (R.opsCost > 0 && t < R.opsCost) continue;
      var f = R.getTarget(e, r);
      if (!f) continue;
      if (!R.shouldUse(e, r, f)) continue;
      if (e.pos.getRangeTo(f) > R.range) {
        return {
          target: f,
          powerId: i
        };
      }
    }
    return null;
  },
  //   cap=100: deposit at 85 ops, withdraw below 15, bank 15 per trip
  //   cap=700: deposit at 595 ops, withdraw below 105, bank 105 per trip
  handleOpsBanking: function(e, r) {
    var o = r.storage;
    var t = r.terminal;
    if (!o && !t) return false;
    var available = storageManager.getUnreserved(r.name) || {};
    var availableStorage = available.storage || {};
    var availableTerminal = available.terminal || {};
    var n = e.store[RESOURCE_OPS] || 0;
    var a = e.store.getCapacity(RESOURCE_OPS) || 100;
    var s = Math.floor(a * OPS_DEPOSIT_PCT);
    var u = Math.floor(a * OPS_WITHDRAW_PCT);
    var i = Math.max(10, Math.floor(a * OPS_BANK_AMOUNT_PCT));
    var R = e.memory || {};
    if (n >= s && !R._moveCommit) {
      var f = o ? o : t;
      var E = Math.min(i, n);
      var l = e.transfer(f, RESOURCE_OPS, E);
      if (l === OK) return true;
      if (l === ERR_NOT_IN_RANGE) {
        e.moveTo(f, {
          reusePath: 5
        });
        return true;
      }
      return false;
    }
    if (n < u) {
      var c = o ? availableStorage[RESOURCE_OPS] || 0 : 0;
      var _ = t ? availableTerminal[RESOURCE_OPS] || 0 : 0;
      var p = null;
      var O = 0;
      if (c > 0) {
        p = o;
        O = c;
      } else if (_ > 0) {
        p = t;
        O = _;
      }
      if (!p) return false;
      var m = a - n;
      var v = Math.floor(a * .5);
      var P = Math.min(v - n, O, m);
      if (P <= 0) return false;
      var l = e.withdraw(p, RESOURCE_OPS, P);
      if (l === OK) return true;
      if (l === ERR_NOT_IN_RANGE) {
        e.moveTo(p, {
          reusePath: 5
        });
        return true;
      }
      return false;
    }
    return false;
  },
  handleIntelObserve: function(e, r) {
    if (e.memory && e.memory._powerUsedTick === Game.time) return false;
    if (!e.powers || !e.powers[PWR_OPERATE_OBSERVER]) return false;
    var o = null;
    var t = null;
    var n = null;
    var a = null;
    var s = [ {
      root: Memory.intelPowerObserve,
      purpose: "intel"
    }, {
      root: Memory.maintScan && Memory.maintScan.powerObs,
      purpose: "maintenance"
    }, {
      root: Memory.energyEffPowerObs,
      purpose: "energy"
    }, {
      root: Memory.nukeThreatPowerObserve,
      purpose: "nukeThreat"
    } ];
    for (var u = 0; u < s.length && !t; u++) {
      var i = s[u];
      if (!i.root) continue;
      for (var R in i.root) {
        var f = i.root[R];
        if (f.operatorRoom === r.name && f.operatorName === e.name) {
          o = R;
          t = f;
          n = i.root;
          a = i.purpose;
          break;
        }
      }
    }
    if (!t) return false;
    if (Game.time - t.tick > 100) {
      console.log("[Operator] " + a + " observe request for " + o + " expired after 100 ticks.");
      delete n[o];
      return false;
    }
    var E = POWER_HANDLERS[PWR_OPERATE_OBSERVER];
    var l = E.getTarget(e, r);
    if (!l) {
      console.log("[Operator] No observer found in " + r.name + " for intel request.");
      delete n[o];
      return false;
    }
    var c = false;
    if (l.effects && l.effects.length) {
      for (var _ = 0; _ < l.effects.length; _++) {
        if (l.effects[_].effect === PWR_OPERATE_OBSERVER) {
          c = true;
          break;
        }
      }
    }
    if (c) {
      var p = require("scanner").observe.dispatch(l, o);
      if (p) {
        console.log("[Operator] 🔭 observeRoom(" + o + ") fired (powered observer from " + r.name + ")");
        if (a === "intel" && (t.fast !== undefined || t.purpose !== "nukeAnalyze")) {
          if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
          Memory.roomIntelPending[o] = {
            tick: Game.time,
            observerRoom: r.name,
            poweredObserver: true,
            fast: t.fast
          };
        }
        delete n[o];
      } else {
        console.log("[Operator] Observer in " + r.name + " is already booked or unavailable; retrying next tick.");
      }
      return true;
    }
    if (e.powers[PWR_OPERATE_OBSERVER].cooldown > 0) {
      return false;
    }
    var O = e.store[RESOURCE_OPS] || 0;
    if (E.opsCost > 0 && O < E.opsCost) {
      return false;
    }
    var m = e.usePower(PWR_OPERATE_OBSERVER, l);
    if (m === OK) {
      console.log("[Operator] ⚡ PWR_OPERATE_OBSERVER applied to observer in " + r.name + " → will observe " + o + " next tick.");
      t.phase = "observe";
      return true;
    } else if (m === ERR_NOT_IN_RANGE) {
      e.moveTo(l, {
        reusePath: 5
      });
      return true;
    } else {
      console.log("[Operator] PWR_OPERATE_OBSERVER failed with code " + m);
      return false;
    }
  },
  findPowerObserver: function(e) {
    if (!Memory.operators) return null;
    for (var r in Memory.operators) {
      var o = Memory.operators[r];
      var t = Game.powerCreeps[r];
      if (!t || !t.ticksToLive) continue;
      if (!t.powers || !t.powers[PWR_OPERATE_OBSERVER]) continue;
      var n = Game.rooms[o.homeRoom];
      if (!n) continue;
      var a = _myStructuresByType(n, STRUCTURE_OBSERVER);
      if (a.length === 0) continue;
      var s = t.store[RESOURCE_OPS] || 0;
      var u = POWER_HANDLERS[PWR_OPERATE_OBSERVER];
      var i = s >= u.opsCost;
      var R = t.powers[PWR_GENERATE_OPS] !== undefined;
      if (!i && !R) continue;
      return {
        operatorName: r,
        operatorRoom: o.homeRoom,
        observerId: a[0].id
      };
    }
    return null;
  },
  tryPower: function(e, r, o) {
    var t = POWER_HANDLERS[o];
    if (!t) return false;
    if (t.range === 0) {
      if (!t.shouldUse(e, r, null)) return false;
      var n = e.usePower(o);
      if (n === OK) return true;
      return false;
    }
    var a = t.getTarget(e, r);
    if (!a) return false;
    if (!t.shouldUse(e, r, a)) return false;
    var n = e.usePower(o, a);
    if (n === OK) {
      return true;
    } else if (n === ERR_NOT_IN_RANGE) {
      e.moveTo(a, {
        reusePath: 5
      });
      return true;
    }
    return false;
  },
  doRenew: function(e, r) {
    var o = _myStructuresByType(r, STRUCTURE_POWER_SPAWN);
    if (o.length === 0) return false;
    var t = o[0];
    var n = e.renew(t);
    if (n === OK) {
      return true;
    } else if (n === ERR_NOT_IN_RANGE) {
      e.moveTo(t, {
        reusePath: 5
      });
      return true;
    }
    return false;
  },
  idleNearSpawn: function(e, r) {
    var o = _myStructuresByType(r, STRUCTURE_POWER_SPAWN);
    if (o.length === 0) return;
    var t = o[0];
    if (e.pos.getRangeTo(t) > 3) {
      e.moveTo(t, {
        reusePath: 10
      });
    }
  }
};
