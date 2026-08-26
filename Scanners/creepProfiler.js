// LLM: Read docs/codex.js before reviewing or changing this file.
// creepProfiler.js
// Console globals: creepProfile
// Example: creepProfile('E1N1') - Profile creep CPU usage, roles, states & task execution
//   const profiler = require('creepProfiler');
//   // In your main loop:
//   profiler.run();
//   profiler.report();    // safe every tick — only prints once when done
//   creepProfile.reset()              — all roles, 100 ticks
//   creepProfile.reset(200)           — all roles, 200 ticks
//   creepProfile.reset(100, 'supplier') — supplier only, 100 ticks
//   creepProfile.list()               — show all supported roles
var DEFAULT_TICKS = 100;
var VERSION = 2;
var getRoomState = require("getRoomState");
function extractSupplier(e) {
  var r = e.memory.s || "unknown";
  var t = "none";
  var o = e.memory.a;
  if (o) {
    var n = o.indexOf("|");
    t = n === -1 ? o : o.substring(0, n);
  }
  return {
    state: r,
    task: t
  };
}

function extractHarvester(e) {
  var r;
  if (e.memory.suicideAfterDelivery) {
    r = "suiciding";
  } else if (e.memory.idleUntil && Game.time < e.memory.idleUntil) {
    r = "idle";
  } else {
    var t = e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    var o = e.store.getCapacity(RESOURCE_ENERGY) || 0;
    if (o === 0) {
      r = "mining(no_carry)";
    } else if (t === 0) {
      r = "mining(empty)";
    } else if (t >= o) {
      r = "transferring(full)";
    } else {
      var n = Math.round(t / o * 100);
      if (n <= 33) {
        r = "mining(1-33%)";
      } else if (n <= 66) {
        r = "mining(34-66%)";
      } else {
        r = "mining(67-99%)";
      }
    }
  }
  var a = e.memory.sourceId ? "source_" + e.memory.sourceId.slice(-4) : "no_source";
  var i = "";
  if (e.memory.sourceLinkId) {
    i = "/link";
  } else if (e.memory.containerId || e.memory.sourceContainerId) {
    i = "/container";
  }
  return {
    state: r,
    task: a + i
  };
}

function extractUpgrader(e) {
  var r;
  if (e.memory.working) {
    r = "upgrading";
  } else if (e.memory.linkDryId && e.memory.linkDryUntil && Game.time < e.memory.linkDryUntil) {
    r = "waiting_link";
  } else {
    r = "collecting";
  }
  return {
    state: r,
    task: r
  };
}

function extractBuilder(e) {
  var r;
  if (e.memory.filling) {
    r = "collecting";
  } else {
    r = "working";
  }
  var t = e.memory.task;
  var o = "none";
  if (t) {
    o = t.label || t.type || "unknown";
  }
  return {
    state: r,
    task: o
  };
}

function extractLabBot(e) {
  var r = e.memory.phase || "unknown";
  if (e.memory.suicidePending) r = "suiciding";
  var t = e.memory.wantedReagents || "none";
  return {
    state: r,
    task: t
  };
}

function extractHD(e) {
  var r = e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  var t = e.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  var o;
  if (r === 0) {
    o = "empty";
  } else if (t === 0) {
    o = "full";
  } else {
    o = "partial";
  }
  return {
    state: o,
    task: "stationary"
  };
}

function extractComboBot(e) {
  var r = e.store.getUsedCapacity() || 0;
  var t = e.store.getFreeCapacity() || 0;
  var o;
  if (r === 0) {
    o = "empty";
  } else if (t === 0) {
    o = "full";
  } else {
    o = "partial";
  }
  var n = e.memory._hasWork;
  var a = n ? "mining_body" : "carry_body";
  return {
    state: o,
    task: a
  };
}

function extractStaticDistributor(e) {
  var r = e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  var t = r > 0 ? "distributing" : "waiting";
  return {
    state: t,
    task: "stationary"
  };
}

function extractGeneric(e) {
  var r = "unknown";
  if (e.memory.state) {
    r = e.memory.state;
  } else if (e.memory.s) {
    r = e.memory.s;
  } else if (e.memory.working !== undefined) {
    r = e.memory.working ? "working" : "collecting";
  } else if (e.memory.harvesting !== undefined) {
    r = e.memory.harvesting ? "harvesting" : "delivering";
  } else if (e.memory.filling !== undefined) {
    r = e.memory.filling ? "collecting" : "working";
  }
  var t = "unknown";
  if (e.memory.task && typeof e.memory.task === "object") {
    t = e.memory.task.label || e.memory.task.type || "unknown";
  } else if (typeof e.memory.task === "string") {
    t = e.memory.task;
  } else if (e.memory.a) {
    var o = e.memory.a.indexOf("|");
    t = o === -1 ? e.memory.a : e.memory.a.substring(0, o);
  }
  return {
    state: r,
    task: t
  };
}

var EXTRACTORS = {
  supplier: extractSupplier,
  harvester: extractHarvester,
  upgrader: extractUpgrader,
  builder: extractBuilder,
  labBot: extractLabBot,
  labbot: extractLabBot,
  hd: extractHD,
  HD: extractHD,
  comboBot: extractComboBot,
  combobot: extractComboBot,
  staticDistributor: extractStaticDistributor,
  distributor: extractStaticDistributor
};
function extract(e) {
  var r = e.memory.role || "unknown";
  var t = EXTRACTORS[r] || extractGeneric;
  var o = t(e);
  o.role = r;
  return o;
}

var SUPPLIER_TASK_LABELS = {
  spawn: "Fill Spawns",
  extension: "Fill Extensions",
  tower: "Fill Towers",
  power_spawn_power: "Fill Power Spawn Power",
  power_spawn_energy: "Fill Power Spawn Energy",
  link_drain: "Drain Links",
  link_fill: "Fill Links",
  container_empty: "Empty Containers",
  materials_drain_energy: "Drain Materials (Energy)",
  container_drain: "Drain Containers",
  terminal_balance: "Balance Terminal",
  terminal_stock: "Terminal Stock",
  factory_input: "Factory Input",
  factory_output: "Factory Output",
  factory_drain: "Factory Drain",
  ground_mineral_pickup: "Ground Mineral Pickup",
  fallback_dump: "Fallback Dump",
  idle: "Idle"
};
function labelTask(e, r) {
  if (e === "supplier" && SUPPLIER_TASK_LABELS[r]) {
    return SUPPLIER_TASK_LABELS[r];
  }
  return r;
}

function ensure(e, r) {
  if (!Memory.creepProfiler) {
    Memory.creepProfiler = {
      trackTicks: e || DEFAULT_TICKS,
      roleFilter: r || null,
      startTick: null,
      endTick: null,
      ticksSampled: 0,
      done: false,
      reported: false,
      global: {
        states: {},
        tasks: {},
        roles: {}
      },
      roles: {},
      rooms: {}
    };
  }
  return Memory.creepProfiler;
}

function inc(e, r) {
  e[r] = (e[r] || 0) + 1;
}

function ensureRole(e, r) {
  if (!e.roles[r]) {
    e.roles[r] = {
      states: {},
      tasks: {},
      samples: 0
    };
  }
  return e.roles[r];
}

function ensureRoom(e, r) {
  if (!e.rooms[r]) {
    e.rooms[r] = {
      states: {},
      tasks: {},
      roles: {},
      samples: 0,
      byRole: {}
    };
  }
  return e.rooms[r];
}

function ensureRoomRole(e, r) {
  if (!e.byRole) e.byRole = {};
  if (!e.byRole[r]) {
    e.byRole[r] = {
      states: {},
      tasks: {},
      samples: 0
    };
  }
  return e.byRole[r];
}

function sortedEntries(e) {
  var r = [];
  var t = Object.keys(e);
  for (var o = 0; o < t.length; o++) {
    r.push({
      key: t[o],
      count: e[t[o]]
    });
  }
  r.sort(function(e, r) {
    return r.count - e.count;
  });
  return r;
}

function pctStr(e, r) {
  if (r === 0) return "0.0";
  return (e / r * 100).toFixed(1);
}

function pad(e, r) {
  e = String(e);
  while (e.length < r) e += " ";
  return e;
}

var creepProfiler = {
  VERSION: VERSION,
  run: function() {
    if (!Memory.creepProfiler) return;
    var e = Memory.creepProfiler;
    if (e.done) return;
    if (e.startTick === null) {
      e.startTick = Game.time;
      e.endTick = Game.time + e.trackTicks - 1;
      var r = e.roleFilter ? " (role: " + e.roleFilter + ")" : " (all roles)";
      console.log("[CreepProfiler v" + VERSION + "] Started at tick " + Game.time + " — capturing " + e.trackTicks + " ticks" + r + " (until " + e.endTick + ")");
    }
    if (Game.time > e.endTick) {
      e.done = true;
      return;
    }
    var t = e.roleFilter || null;
    var o = getRoomState.creepIndex();
    var n = o && o.all ? o.all : [];
    for (var a = 0; a < n.length; a++) {
      var i = n[a];
      if (!i || !i.memory) continue;
      if (i.spawning) continue;
      var s = i.memory.role || "unknown";
      if (t && s !== t) continue;
      var l = extract(i);
      var c = l.role;
      var m = l.state;
      var u = l.task;
      var f = i.room ? i.room.name : "unknown";
      inc(e.global.states, m);
      inc(e.global.tasks, u);
      inc(e.global.roles, c);
      var p = ensureRole(e, c);
      inc(p.states, m);
      inc(p.tasks, u);
      p.samples++;
      var y = ensureRoom(e, f);
      inc(y.states, m);
      inc(y.tasks, u);
      inc(y.roles, c);
      y.samples++;
      var g = ensureRoomRole(y, c);
      inc(g.states, m);
      inc(g.tasks, u);
      g.samples++;
    }
    e.ticksSampled++;
  },
  report: function() {
    if (!Memory.creepProfiler) return;
    var e = Memory.creepProfiler;
    if (!e.done) return;
    if (e.reported) return;
    e.reported = true;
    var r = 0;
    var t = Object.keys(e.global.states);
    for (var o = 0; o < t.length; o++) r += e.global.states[t[o]];
    if (r === 0) {
      console.log("[CreepProfiler] No samples recorded over " + e.ticksSampled + " ticks.");
      delete Memory.creepProfiler;
      return;
    }
    function inline(e, r, t) {
      var o = sortedEntries(e);
      var n = [];
      for (var a = 0; a < o.length; a++) {
        var i = t ? labelTask(t, o[a].key) : o[a].key;
        n.push(i + " " + pctStr(o[a].count, r) + "%(" + o[a].count + ")");
      }
      return n.join(", ");
    }
    var n = [];
    var a = e.roleFilter ? " | role: " + e.roleFilter : " | all roles";
    n.push("═══ CREEP PROFILER v" + VERSION + " — " + e.ticksSampled + " ticks (" + e.startTick + "→" + e.endTick + ")" + a + " | " + r + " samples ═══");
    if (!e.roleFilter) {
      n.push("Roles: " + inline(e.global.roles, r));
    }
    var i = Object.keys(e.roles).sort();
    for (var s = 0; s < i.length; s++) {
      var l = i[s];
      var c = e.roles[l];
      if (c.samples === 0) continue;
      n.push("── " + l.toUpperCase() + " (" + c.samples + ") ──  " + "States: " + inline(c.states, c.samples) + "  |  " + "Tasks: " + inline(c.tasks, c.samples, l));
    }
    var m = Object.keys(e.rooms).sort();
    for (var u = 0; u < m.length; u++) {
      var f = m[u];
      var p = e.rooms[f];
      if (p.samples === 0) continue;
      if (p.byRole) {
        var y = Object.keys(p.byRole).sort();
        for (var g = 0; g < y.length; g++) {
          var v = y[g];
          var k = p.byRole[v];
          if (k.samples === 0) continue;
          var d = y.length > 1 ? " [" + v + "]" : "";
          n.push("  " + f + d + " (" + k.samples + ")  " + "States: " + inline(k.states, k.samples) + "  |  " + "Tasks: " + inline(k.tasks, k.samples, v));
        }
      }
    }
    n.push("═══ END CREEP PROFILER ═══");
    console.log(n.join("\n"));
    var R = "";
    for (var b = 0; b < n.length; b++) {
      var E = n[b];
      if (R.length > 0 && R.length + 1 + E.length > 400) {
        Game.notify(R, 0);
        R = "";
      }
      if (E.length > 400) {
        E = E.substring(0, 397) + "...";
      }
      R = R.length > 0 ? R + "\n" + E : E;
    }
    if (R.length > 0) {
      Game.notify(R, 0);
    }
    delete Memory.creepProfiler;
  },
  reset: function(e, r) {
    delete Memory.creepProfiler;
    if (typeof e === "string") {
      r = e;
      e = DEFAULT_TICKS;
    }
    ensure(e || DEFAULT_TICKS, r || null);
    var t = "[CreepProfiler v" + VERSION + "] Reset. Capture: " + (e || DEFAULT_TICKS) + " ticks";
    if (r) t += ", role: " + r;
    console.log(t);
  },
  list: function() {
    var e = Object.keys(EXTRACTORS);
    var r = {};
    var t = [];
    for (var o = 0; o < e.length; o++) {
      var n = e[o].toLowerCase();
      if (!r[n]) {
        r[n] = true;
        t.push(e[o]);
      }
    }
    t.sort();
    console.log("");
    console.log("═══ Supported Roles (dedicated extractors) ═══");
    for (var a = 0; a < t.length; a++) {
      console.log("  • " + t[a]);
    }
    console.log("");
    console.log("Any other role will use the generic extractor");
    console.log("(reads memory.state / .s / .working / .harvesting / .filling / .task)");
    console.log("");
    console.log("Usage: creepProfile.reset(100, '" + t[0] + "')");
    console.log("");
  },
  isDone: function() {
    return !Memory.creepProfiler;
  }
};
global.creepProfile = creepProfiler;
module.exports = creepProfiler;
