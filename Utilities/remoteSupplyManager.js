// LLM: Read docs/codex.js before reviewing or changing this file.
// remoteSupplyManager.js
// Console globals: remoteSupply, triggerRemoteSupply, cancelRemoteSupply, listRemoteSupply
// Example: remoteSupply('E1N1', 'E2N2', 5000) - Queue remote energy supply transport
// Example: triggerRemoteSupply('E1N1') - Immediately trigger remote supply dispatch
// Example: cancelRemoteSupply('E1N1', 'E2N2') - Cancel remote supply order between rooms
// Example: listRemoteSupply() - List active remote supply routes and orders
//   extensions  Trigger: !hasCreeps && spawnExtEnergy <= 300. Action: load
//     full carry, travel to recipient, fill extensions then spawns; any
//     leftover energy is dumped into storage if present.
//   storage     Trigger: storageEnergy <= 5000. Action: load exactly
//     (7500 - currentStorage) energy, travel to recipient, deposit into storage.
//   remoteSupply('W1N1', 'W2N2', 'both')  Set up a standing order:
//     monitors conditions via playerMonitor and queues supplier spawn
//     requests automatically when thresholds are met; also resets the
//     playerMonitor poll timer so the first scan happens immediately.
//   triggerRemoteSupply('W1N1', 'W2N2', 'both')  Manually queue a one-shot
//     supply run, bypassing all condition checks; no standing order
//     required. Won't spawn if a supplier is already active for that
//     mission. Resets cooldowns on any existing order.
//   cancelRemoteSupply('W1N1', 'W2N2')  Remove a standing order.
//   listRemoteSupply()  All standing orders, current playerMonitor state,
//     cooldowns, and any active supplier creeps.
var getRoomState = require("getRoomState");
const EXTENSION_ENERGY_TRIGGER = 300;
const STORAGE_LOW_THRESHOLD = 5e3;
const STORAGE_TARGET = 7500;
const SPAWN_COOLDOWN = 200;
global.remoteSupply = function(e, o, r) {
  if (!e || !o) {
    console.log('Usage: remoteSupply("sourceRoom", "recipientRoom", "both"|"extensions"|"storage")');
    return;
  }
  var t = (r || "both").toLowerCase();
  var n = t === "both" || t === "extensions";
  var s = t === "both" || t === "storage";
  if (!n && !s) {
    console.log('[RemoteSupply] Unknown mission "' + r + '". Use: both, extensions, storage');
    return;
  }
  if (!Memory.remoteSupplyOrders) Memory.remoteSupplyOrders = {};
  var i = e + "->" + o;
  var m = Memory.remoteSupplyOrders[i] || {};
  Memory.remoteSupplyOrders[i] = {
    sourceRoom: e,
    recipientRoom: o,
    missions: {
      extensions: n,
      storage: s
    },
    active: true,
    cooldown: {
      extensions: m.cooldown ? m.cooldown.extensions : 0,
      storage: m.cooldown ? m.cooldown.storage : 0
    }
  };
  var a = _findPlayerForRoom(o);
  var p = [ "[RemoteSupply] Order set: " + i ];
  if (n) p.push("  extensions: fires when spawnExt ≤ " + EXTENSION_ENERGY_TRIGGER + " + no creeps");
  if (s) p.push("  storage:    fires when storage ≤ " + STORAGE_LOW_THRESHOLD + ", fills to " + STORAGE_TARGET);
  if (!a) {
    p.push("  WARNING: " + o + " not found in playerMonitor. Run monitor() first.");
  } else {
    p.push("  Watching via playerMonitor entry for: " + a);
    var u = Memory.roomRegistry;
    if (u && u.rooms && u.rooms[o]) {
      u.rooms[o].t = 0;
    }
    p.push("  playerMonitor scan timestamp reset - rescan queued for next cycle.");
  }
  console.log(p.join("\n"));
};
global.cancelRemoteSupply = function(e, o) {
  if (!Memory.remoteSupplyOrders) return "No orders.";
  var r = e + "->" + o;
  if (!Memory.remoteSupplyOrders[r]) return "[RemoteSupply] Not found: " + r;
  delete Memory.remoteSupplyOrders[r];
  return "[RemoteSupply] Cancelled: " + r;
};
global.triggerRemoteSupply = function(e, o, r) {
  if (!e || !o) {
    console.log('Usage: triggerRemoteSupply("sourceRoom", "recipientRoom", "both"|"extensions"|"storage")');
    return;
  }
  var t = (r || "both").toLowerCase();
  var n = t === "both" || t === "extensions";
  var s = t === "both" || t === "storage";
  if (!n && !s) {
    console.log('[RemoteSupply] Unknown mission "' + r + '". Use: both, extensions, storage');
    return;
  }
  var i = _getRoomState(o);
  if (n) {
    if (_countActiveSuppliers(e, o, "extensions") > 0) {
      console.log("[RemoteSupply] Manual trigger skipped for extensions — supplier already active.");
    } else {
      _enqueueSpawn({
        sourceRoom: e,
        recipientRoom: o
      }, "extensions", i);
      var m = "[RemoteSupply] Manual trigger: extensions | " + e + " -> " + o;
      console.log(m);
      Game.notify(m, 0);
    }
  }
  if (s) {
    if (_countActiveSuppliers(e, o, "storage") > 0) {
      console.log("[RemoteSupply] Manual trigger skipped for storage — supplier already active.");
    } else {
      _enqueueSpawn({
        sourceRoom: e,
        recipientRoom: o
      }, "storage", i);
      var a = "[RemoteSupply] Manual trigger: storage | " + e + " -> " + o + (i ? " storageEnergy=" + i.storageEnergy : " (no state — will carry full)");
      console.log(a);
      Game.notify(a, 0);
    }
  }
  if (Memory.remoteSupplyOrders) {
    var p = e + "->" + o;
    var u = Memory.remoteSupplyOrders[p];
    if (u) {
      if (n) u.cooldown.extensions = 0;
      if (s) u.cooldown.storage = 0;
    }
  }
};
global.listRemoteSupply = function() {
  if (!Memory.remoteSupplyOrders || !Object.keys(Memory.remoteSupplyOrders).length) {
    return "No remote supply orders.";
  }
  var e = [ "=== Remote Supply Orders ===" ];
  for (var o in Memory.remoteSupplyOrders) {
    var r = Memory.remoteSupplyOrders[o];
    var t = _getRoomState(r.recipientRoom);
    var n = [];
    if (r.missions.extensions) n.push("extensions");
    if (r.missions.storage) n.push("storage");
    e.push(o + " [" + n.join("+") + "]" + (r.active ? "" : " INACTIVE"));
    if (t) {
      e.push("  spawnExt=" + (t.spawnExtEnergy !== undefined ? t.spawnExtEnergy : "?") + "  storage=" + (t.storageEnergy !== undefined ? t.storageEnergy : "?") + "  hasCreeps=" + !!t.hasCreeps + "  scanned " + _roomStateAge(r.recipientRoom));
    } else {
      e.push("  (no playerMonitor state yet)");
    }
    var s = r.cooldown.extensions > Game.time ? "  ext cooldown: " + (r.cooldown.extensions - Game.time) + " ticks" : "";
    var i = r.cooldown.storage > Game.time ? "  sto cooldown: " + (r.cooldown.storage - Game.time) + " ticks" : "";
    if (s) e.push(s);
    if (i) e.push(i);
  }
  var m = [];
  var a = getRoomState.creepIndex();
  var p = a && a.all ? a.all : [];
  for (var u = 0; u < p.length; u++) {
    var l = p[u];
    if (l && l.memory && l.memory.role === "remoteSupplier") {
      m.push("  " + l.name + " [" + l.memory.mission + "] " + l.memory.homeRoom + "->" + l.memory.targetRoom + " ttl=" + l.ticksToLive + " working=" + l.memory.working);
    }
  }
  if (m.length) {
    e.push("Active suppliers:");
    e = e.concat(m);
  }
  return e.join("\n");
};
function _findPlayerForRoom(e) {
  var o = Memory.playerMonitor;
  var r = Memory.roomRegistry;
  if (!o || !o.players || !r || !r.rooms || !r.rooms[e]) return null;
  var t = r.rooms[e].o;
  return o.players[t] ? t : null;
}

function _getRoomState(e) {
  var o = Memory.playerMonitor;
  if (!o || !o.state) return null;
  return o.state[e] || null;
}

function _roomStateAge(e) {
  var o = Memory.roomRegistry;
  var r = o && o.rooms && o.rooms[e];
  return r && r.t ? Game.time - r.t + " ticks ago" : "never";
}

function _countActiveSuppliers(e, o, r) {
  var t = 0;
  var n = getRoomState.creepIndex();
  var s = n && n.all ? n.all : [];
  for (var i = 0; i < s.length; i++) {
    var m = s[i];
    if (!m || !m.memory) continue;
    if (m.memory.role !== "remoteSupplier") continue;
    if (m.memory.homeRoom !== e) continue;
    if (m.memory.targetRoom !== o) continue;
    if (m.memory.mission !== r) continue;
    t++;
  }
  return t;
}

function _checkExtensionTrigger(e) {
  if (!e) return false;
  if (e.hasCreeps) return false;
  if (e.spawnExtEnergy === undefined) return false;
  return e.spawnExtEnergy <= EXTENSION_ENERGY_TRIGGER;
}

function _checkStorageTrigger(e) {
  if (!e) return false;
  if (e.storageEnergy === undefined) return false;
  return e.storageEnergy <= STORAGE_LOW_THRESHOLD;
}

function run() {
  if (!Memory.remoteSupplyOrders) return;
  if (Memory.remoteSupplyComplete) {
    for (var e in Memory.remoteSupplyComplete) {
      var o = Memory.remoteSupplyComplete[e];
      var r = "[RemoteSupply] Task complete: " + o.homeRoom + " -> " + o.targetRoom + " [" + o.mission + "] at tick " + o.completedAt;
      console.log(r);
      Game.notify(r, 0);
    }
    delete Memory.remoteSupplyComplete;
  }
  for (var t in Memory.remoteSupplyOrders) {
    var n = Memory.remoteSupplyOrders[t];
    if (!n || !n.active) continue;
    var s = _getRoomState(n.recipientRoom);
    if (n.missions.extensions) _resetCooldownIfDead(n, "extensions");
    if (n.missions.storage) _resetCooldownIfDead(n, "storage");
    if (n.missions.extensions && Game.time >= (n.cooldown.extensions || 0) && _checkExtensionTrigger(s)) {
      if (_countActiveSuppliers(n.sourceRoom, n.recipientRoom, "extensions") === 0) {
        var i = "[RemoteSupply] Extension trigger: " + n.sourceRoom + " -> " + n.recipientRoom + " | spawnExt=" + s.spawnExtEnergy + ", no creeps";
        console.log(i);
        Game.notify(i, 0);
        _enqueueSpawn(n, "extensions", s);
        n.cooldown.extensions = Game.time + SPAWN_COOLDOWN;
      }
    }
    if (n.missions.storage && Game.time >= (n.cooldown.storage || 0) && _checkStorageTrigger(s)) {
      if (_countActiveSuppliers(n.sourceRoom, n.recipientRoom, "storage") === 0) {
        var m = "[RemoteSupply] Storage trigger: " + n.sourceRoom + " -> " + n.recipientRoom + " | storageEnergy=" + s.storageEnergy + " (target " + STORAGE_TARGET + ")";
        console.log(m);
        Game.notify(m, 0);
        _enqueueSpawn(n, "storage", s);
        n.cooldown.storage = Game.time + SPAWN_COOLDOWN;
      }
    }
  }
}

function _resetCooldownIfDead(e, o) {
  if ((e.cooldown[o] || 0) <= Game.time) return;
  var r = _countActiveSuppliers(e.sourceRoom, e.recipientRoom, o);
  if (r > 0) return;
  var t = _hasQueuedSpawn(e.sourceRoom, e.recipientRoom, o);
  if (t) return;
  console.log("[RemoteSupply] " + e.sourceRoom + "->" + e.recipientRoom + " [" + o + "]: supplier died mid-mission, resetting cooldown.");
  e.cooldown[o] = 0;
}

function _hasQueuedSpawn(e, o, r) {
  if (!Memory.remoteSupplySpawnQueue) return false;
  for (var t = 0; t < Memory.remoteSupplySpawnQueue.length; t++) {
    var n = Memory.remoteSupplySpawnQueue[t];
    if (n.sourceRoom === e && n.recipientRoom === o && n.mission === r) {
      return true;
    }
  }
  return false;
}

function _enqueueSpawn(e, o, r) {
  if (!Memory.remoteSupplySpawnQueue) Memory.remoteSupplySpawnQueue = [];
  var t = null;
  if (o === "storage" && r) {
    t = STORAGE_TARGET - (r.storageEnergy || 0);
  }
  Memory.remoteSupplySpawnQueue.push({
    sourceRoom: e.sourceRoom,
    recipientRoom: e.recipientRoom,
    mission: o,
    amountNeeded: t,
    requestedAt: Game.time
  });
}

module.exports = {
  run: run
};
