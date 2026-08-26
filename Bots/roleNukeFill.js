// LLM: Read docs/codex.js before reviewing or changing this file.
// roleNukeFill.js
// Role dispatch: memory.role === 'nukeFill' -> roleNukeFill.run(creep).
// Console globals: nukeFill, nukeFillAutoStatus
// Example: nukeFill('E1N1') - Dispatch or toggle nuke loader creep to load silo
// Example: nukeFillAutoStatus() - View auto-loader status for all nuclear silos
// Example: require('roleNukeFill').run(creep);
//          1) Fill 100% energy first
//          2) Then fill GHODIUM
//          nukeFillAutoStatus()                 // auto fill status
//       a time in alphabetical order (manual nukeFill can still stack).
const NUKE_FILL_AUTO_ENABLED = true;
const NUKE_FILL_AUTO_MAX_PRICE = 1e4;
const NUKE_FILL_AUTO_INTERVAL = 1e3;
const getRoomState = require("getRoomState");
const opportunisticBuy = require("opportunisticBuy");
const memoryManager = require("memoryManager");
if (!Memory.nukeFillOrders) Memory.nukeFillOrders = {};
if (!Memory.nukeFillAuto) Memory.nukeFillAuto = {
  activeRoom: null,
  nextRunTick: 0
};
function getNukerFromState(e, r) {
  var t = null;
  if (r) {
    t = Game.getObjectById(r);
    if (t) return t;
  }
  if (e && e.structuresByType && e.structuresByType[STRUCTURE_NUKER]) {
    var o = e.structuresByType[STRUCTURE_NUKER];
    if (o && o.length > 0) t = o[0];
  }
  return t;
}

function getNukerCaps(e) {
  var r = 0;
  var t = 0;
  if (e && e.store && typeof e.store.getCapacity === "function") {
    var o = e.store.getCapacity(RESOURCE_ENERGY);
    var n = e.store.getCapacity(RESOURCE_GHODIUM);
    r = typeof o === "number" ? o : 0;
    t = typeof n === "number" ? n : 0;
  } else {
    r = e && typeof e.energyCapacity === "number" ? e.energyCapacity : 0;
    t = e && typeof e.ghodiumCapacity === "number" ? e.ghodiumCapacity : 0;
  }
  return {
    energy: r,
    ghodium: t
  };
}

function getNukerAmounts(e) {
  var r = 0;
  var t = 0;
  if (e && e.store) {
    r = e.store[RESOURCE_ENERGY] || 0;
    t = e.store[RESOURCE_GHODIUM] || 0;
  } else {
    r = e && typeof e.energy === "number" ? e.energy : 0;
    t = e && typeof e.ghodium === "number" ? e.ghodium : 0;
  }
  return {
    energy: r,
    ghodium: t
  };
}

function sumRoomResource(e, r, t) {
  if (!e) return 0;
  var o = 0;
  var n = [ STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_FACTORY, STRUCTURE_CONTAINER, STRUCTURE_LAB, STRUCTURE_NUKER ];
  for (var u = 0; u < n.length; u++) {
    var i = n[u];
    var a = e.structuresByType && e.structuresByType[i] ? e.structuresByType[i] : [];
    for (var l = 0; l < a.length; l++) {
      var m = a[l];
      if (!m || t && m.id === t) continue;
      if (m.store && typeof m.store.getUsedCapacity === "function") {
        o += m.store.getUsedCapacity(r) || 0;
      }
    }
  }
  return o;
}

function pickWithdrawTarget(e, r) {
  if (!e) return null;
  var t = e.terminal;
  var o = e.storage;
  var n = t && t.store ? t.store[r] || 0 : 0;
  var u = o && o.store ? o.store[r] || 0 : 0;
  if (r === RESOURCE_ENERGY) {
    if (u > 0 && u >= n) return o;
    if (n > 0) return t;
    if (u > 0) return o;
  } else {
    if (n > 0) return t;
    if (u > 0) return o;
  }
  var i = e.structuresByType && e.structuresByType[STRUCTURE_CONTAINER] ? e.structuresByType[STRUCTURE_CONTAINER] : [];
  var a = null;
  var l = 0;
  for (var m = 0; m < i.length; m++) {
    var s = i[m];
    if (!s || !s.store) continue;
    var f = s.store[r] || 0;
    if (f > l) {
      l = f;
      a = s;
    }
  }
  if (a) return a;
  return null;
}

function depositElsewhere(e, r, t) {
  var o = r ? r.storage : null;
  if (o && o.store && o.store.getFreeCapacity && o.store.getFreeCapacity() > 0) {
    var n = e.transfer(o, t);
    if (n === ERR_NOT_IN_RANGE) e.moveTo(o, {
      range: 1
    });
    return true;
  }
  var u = r ? r.terminal : null;
  if (u && u.store && u.store.getFreeCapacity && u.store.getFreeCapacity() > 0) {
    var i = e.transfer(u, t);
    if (i === ERR_NOT_IN_RANGE) e.moveTo(u, {
      range: 1
    });
    return true;
  }
  e.drop(t);
  return true;
}

function order(e, r) {
  if (!r) r = {};
  var t = typeof r.maxPrice === "number" ? r.maxPrice : 1e4;
  var o = Game.rooms[e];
  if (!o || !o.controller || !o.controller.my) {
    var n = "[NukeFill] Room " + e + " is not visible or not owned.";
    console.log(n);
    return n;
  }
  var u = getRoomState.get(e);
  if (!u) {
    var i = "[NukeFill] getRoomState not available for " + e + " this tick.";
    console.log(i);
    return i;
  }
  var a = getNukerFromState(u);
  if (!a) {
    var l = "[NukeFill] No Nuker found in room " + e + ".";
    console.log(l);
    return l;
  }
  var m = getNukerCaps(a);
  var s = getNukerAmounts(a);
  var f = Math.max(0, m.energy - s.energy);
  var c = Math.max(0, m.ghodium - s.ghodium);
  if (f === 0 && c === 0) {
    if (Memory.nukeFillOrders && Memory.nukeFillOrders[e]) delete Memory.nukeFillOrders[e];
    var R = "[NukeFill] " + e + " nuker is already full.";
    console.log(R);
    return R;
  }
  var y = sumRoomResource(u, RESOURCE_ENERGY, a.id);
  var d = sumRoomResource(u, RESOURCE_GHODIUM, a.id);
  var v = 0;
  if (c > 0 && d < c) {
    v = c - d;
    if (u.terminal) {
      opportunisticBuy.setup(e, RESOURCE_GHODIUM, v, t);
    } else {
      console.log("[NukeFill] No terminal in " + e + " to buy GHODIUM; will wait for manual supply.");
    }
  }
  Memory.nukeFillOrders[e] = {
    id: "nukeFill_" + e + "_" + Game.time,
    roomName: e,
    nukerId: a.id,
    energyTarget: m.energy,
    ghodiumTarget: m.ghodium,
    phase: f > 0 ? "energy" : c > 0 ? "ghodium" : "done",
    createdAt: Game.time,
    maxPrice: t,
    buyRequested: v > 0 ? true : false,
    completed: false,
    source: r.source || "manual"
  };
  var g = "[NukeFill] " + e + " | Energy need: " + f + " | GHODIUM need: " + c + (v > 0 ? " | Buying GHODIUM: " + v + " @ <= " + t : " | No GHODIUM buy needed");
  console.log(g);
  return g;
}

function run(e) {
  var r = e.memory.orderRoom || e.memory.homeRoom || (e.room ? e.room.name : null);
  if (!r) return;
  var t = getRoomState.get(r);
  if (!t) return;
  var o = Memory.nukeFillOrders ? Memory.nukeFillOrders[r] : null;
  if (!o || o.completed) {
    if (e.store) {
      for (var n in e.store) {
        if (e.store[n] > 0) {
          depositElsewhere(e, t, n);
          return;
        }
      }
    }
    var u = t.storage;
    if (u) e.moveTo(u, {
      range: 2
    });
    return;
  }
  if (e.memory.nukeFillOrderId !== o.id) {
    e.memory.nukeFillOrderId = o.id;
    delete e.memory.nukeFillDone;
  }
  if (Game.time - o.createdAt > 1e5) {
    return;
  }
  var i = getNukerFromState(t, e.memory.nukerId);
  if (!i) {
    i = getNukerFromState(t);
    if (i) e.memory.nukerId = i.id; else return;
  }
  var a = getNukerCaps(i);
  var l = getNukerAmounts(i);
  var m = Math.max(0, a.energy - l.energy);
  var s = Math.max(0, a.ghodium - l.ghodium);
  if (m === 0 && s === 0) {
    o.phase = "done";
    if (e.store) {
      for (var f in e.store) {
        if (e.store[f] > 0) {
          depositElsewhere(e, t, f);
          return;
        }
      }
    }
    e.memory.nukeFillDone = true;
    return;
  }
  var c = m > 0 ? RESOURCE_ENERGY : RESOURCE_GHODIUM;
  o.phase = m > 0 ? "energy" : "ghodium";
  if (o.phase === "ghodium" && !o.buyRequested) {
    var R = sumRoomResource(t, RESOURCE_GHODIUM, i.id);
    var y = Math.max(0, a.ghodium - l.ghodium);
    var d = Math.max(0, y - R);
    if (d > 0 && t.terminal) {
      var v = typeof o.maxPrice === "number" ? o.maxPrice : 1;
      opportunisticBuy.setup(r, RESOURCE_GHODIUM, d, v);
      o.buyRequested = true;
    }
  }
  if (e.store) {
    for (var g in e.store) {
      if (g !== c && e.store[g] > 0) {
        depositElsewhere(e, t, g);
        return;
      }
    }
  }
  var E = e.store ? e.store[c] || 0 : 0;
  if (E <= 0) {
    var p = pickWithdrawTarget(t, c);
    if (p) {
      var k = e.withdraw(p, c);
      if (k === ERR_NOT_IN_RANGE) e.moveTo(p, {
        range: 1,
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      });
    } else {
      var N = t.terminal || t.storage;
      if (N) e.moveTo(N, {
        range: 2
      });
    }
    return;
  }
  var _ = e.transfer(i, c);
  if (_ === ERR_NOT_IN_RANGE) {
    e.moveTo(i, {
      range: 1,
      visualizePathStyle: {
        stroke: "#00ffff"
      }
    });
    return;
  }
  if (_ === ERR_FULL) {
    return;
  }
  if (_ === ERR_INVALID_ARGS || _ === ERR_INVALID_TARGET) {
    depositElsewhere(e, t, c);
  }
}

function hasLiveOrder(e) {
  var r = Memory.nukeFillOrders ? Memory.nukeFillOrders[e] : null;
  return !!(r && !r.completed);
}

function isNukerIncomplete(e) {
  var r = getNukerFromState(e);
  if (!r) return false;
  var t = getNukerCaps(r);
  var o = getNukerAmounts(r);
  return t.energy - o.energy > 0 || t.ghodium - o.ghodium > 0;
}

function listIncompleteNukerRooms() {
  var e = getRoomState.ownedNames().slice().sort();
  var r = [];
  for (var t = 0; t < e.length; t++) {
    var o = e[t];
    var n = getRoomState.get(o);
    if (!n) continue;
    if (!isNukerIncomplete(n)) continue;
    r.push(o);
  }
  return r;
}

function ensureAutoMemory() {
  if (!Memory.nukeFillAuto || typeof Memory.nukeFillAuto !== "object") {
    Memory.nukeFillAuto = {
      activeRoom: null,
      nextRunTick: 0
    };
    memoryManager.requestSave();
  } else if (typeof Memory.nukeFillAuto.nextRunTick !== "number") {
    Memory.nukeFillAuto.nextRunTick = 0;
    memoryManager.requestSave();
  }
  return Memory.nukeFillAuto;
}

function runAuto() {
  if (!NUKE_FILL_AUTO_ENABLED) return;
  var e = ensureAutoMemory();
  if (Game.time < e.nextRunTick) return;
  var r = e.activeRoom;
  if (r) {
    if (hasLiveOrder(r)) {
      e.nextRunTick = Game.time + NUKE_FILL_AUTO_INTERVAL;
      memoryManager.requestSave();
      return;
    }
    e.activeRoom = null;
  }
  var t = listIncompleteNukerRooms();
  for (var o = 0; o < t.length; o++) {
    var n = t[o];
    if (hasLiveOrder(n)) continue;
    var u = order(n, {
      maxPrice: NUKE_FILL_AUTO_MAX_PRICE,
      source: "auto"
    });
    if (hasLiveOrder(n)) {
      e.activeRoom = n;
      console.log("[NukeFillAuto] Started " + n + ".");
      e.nextRunTick = Game.time + NUKE_FILL_AUTO_INTERVAL;
      memoryManager.requestSave();
      return;
    }
    if (typeof u === "string" && u.indexOf("already full") !== -1) continue;
  }
  e.nextRunTick = Game.time + NUKE_FILL_AUTO_INTERVAL;
  memoryManager.requestSave();
}

function consolidateCompletedOrders() {
  if (!Memory.nukeFillOrders) return;
  for (var e in Memory.nukeFillOrders) {
    var r = Memory.nukeFillOrders[e];
    if (!r) continue;
    if (r.completed) {
      delete Memory.nukeFillOrders[e];
      console.log("[NukeFill] Order for " + e + " finalized.");
      continue;
    }
    if (Game.time - r.createdAt > 1e5) {
      delete Memory.nukeFillOrders[e];
      console.log("[NukeFill] Order for " + e + " expired after 100,000 ticks.");
      continue;
    }
    var t = _.filter(Game.creeps, function(t) {
      return t && t.memory && !t.spawning && t.memory.role === "nukeFill" && (t.memory.orderRoom === e || t.memory.homeRoom === e) && t.memory.nukeFillOrderId === r.id;
    });
    if (t.length === 0) continue;
    var o = true;
    for (var n = 0; n < t.length; n++) {
      if (!t[n].memory.nukeFillDone) {
        o = false;
        break;
      }
    }
    if (o) {
      delete Memory.nukeFillOrders[e];
      console.log("[NukeFill] Completed nuker fill in " + e + ".");
    }
  }
}

function autoStatus() {
  var e = ensureAutoMemory();
  var r = listIncompleteNukerRooms();
  var t = [];
  t.push("[NukeFillAuto] enabled=" + NUKE_FILL_AUTO_ENABLED + " maxPrice=" + NUKE_FILL_AUTO_MAX_PRICE + " interval=" + NUKE_FILL_AUTO_INTERVAL);
  t.push("activeRoom=" + (e.activeRoom || "none"));
  t.push("nextRun=" + Math.max(0, e.nextRunTick - Game.time) + " ticks");
  t.push("incomplete (" + r.length + "): " + (r.length ? r.join(", ") : "none"));
  var o = Memory.nukeFillOrders || {};
  var n = [];
  for (var u in o) {
    if (o[u] && !o[u].completed) {
      n.push(u + "(" + (o[u].source || "?") + "/" + (o[u].phase || "?") + ")");
    }
  }
  t.push("orders: " + (n.length ? n.join(", ") : "none"));
  var i = t.join("\n");
  console.log(i);
  return i;
}

global.nukeFill = order;
global.nukeFillAutoStatus = autoStatus;
module.exports = {
  run: run,
  order: order,
  runAuto: runAuto,
  consolidateCompletedOrders: consolidateCompletedOrders,
  autoStatus: autoStatus
};
