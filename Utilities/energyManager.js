// LLM: Read docs/codex.js before reviewing or changing this file.
// energyManager.js
// Console globals: energyReport
// Example: energyReport() - Display empire energy distribution and transfer status
// Example: energyReport();
const getRoomState = require("getRoomState");
const storageManager = require("storageManager");
const heap = require("memoryManager").heap;
const LOW_STORAGE = 3e5;
const HIGH_STORAGE = 4e5;
const BUY_TIERS = [ {
  label: "normal",
  threshold: 25e4
}, {
  label: "emergency",
  threshold: 1e5
}, {
  label: "critical",
  threshold: 5e4
} ];
const TERMINAL_TARGET = 2e4;
const SOURCE_ENERGY_TICK = 10;
const STATUS_LABELS = {
  CRITICAL: "CRIT",
  LOW: "LOW",
  HEALTHY: "OK"
};
const BALANCE_LABELS = {
  DONOR: "DNR",
  RECIPIENT: "RCV"
};
function sumEnergy(e) {
  var t = 0;
  if (!e) return t;
  for (var r = 0; r < e.length; r++) {
    var a = e[r];
    if (a && a.store) {
      t += a.store[RESOURCE_ENERGY] || 0;
    }
  }
  return t;
}

function sourceMaxRate(e) {
  var t = SOURCE_ENERGY_TICK;
  if (!e || !e.effects || e.effects.length === 0) return t;
  var r = typeof POWER_INFO !== "undefined" ? POWER_INFO[PWR_REGEN_SOURCE] : null;
  for (var a = 0; a < e.effects.length; a++) {
    var o = e.effects[a];
    if (o.effect !== PWR_REGEN_SOURCE) continue;
    var n = o.level || 1;
    var s = r && r.effect && r.effect[n - 1] || 0;
    var l = r && r.period || 15;
    if (l > 0) t += s / l;
  }
  return t;
}

function roleWorkParts(e, t) {
  var r = 0;
  if (!e) return r;
  for (var a = 0; a < e.length; a++) {
    var o = e[a];
    if (!o || o.spawning) continue;
    if (!o.memory || o.memory.role !== t) continue;
    r += o.getActiveBodyparts(WORK);
  }
  return r;
}

function shortNum(e) {
  e = Math.round(e || 0);
  var t = e < 0 ? "-" : "";
  var r = Math.abs(e);
  if (r >= 1e6) return t + Math.round(r / 1e5) / 10 + "M";
  if (r >= 1e3) return t + Math.round(r / 1e3) + "K";
  return t + String(r);
}

function signedShort(e) {
  e = Math.round(e || 0);
  if (e > 0) return "+" + shortNum(e);
  return shortNum(e);
}

function stateLabel(e) {
  var t = STATUS_LABELS[e.healthStatus] || e.healthStatus || "?";
  if (e.balanceRole && BALANCE_LABELS[e.balanceRole]) {
    return t + "/" + BALANCE_LABELS[e.balanceRole];
  }
  return t;
}

function run() {
  if (heap.energyTick === Game.time) return;
  getRoomState.init();
  heap.energySnapshots = {};
  heap.energyGlobal = {
    tick: Game.time,
    totalStock: 0,
    totalBufferStock: 0,
    totalReserved: 0,
    donorCount: 0,
    recipientCount: 0
  };
  var e = getRoomState.ownedNames();
  var t = getRoomState.creepIndex();
  var r = typeof HARVEST_POWER === "number" ? HARVEST_POWER : 2;
  var a = typeof UPGRADE_CONTROLLER_POWER === "number" ? UPGRADE_CONTROLLER_POWER : 1;
  for (var o = 0; o < e.length; o++) {
    var n = e[o];
    var s = getRoomState.get(n);
    if (!s) continue;
    var l = s.structuresByType || {};
    var i = 0;
    if (s.storage && s.storage.store) {
      i = s.storage.store[RESOURCE_ENERGY] || 0;
    }
    var u = 0;
    if (s.terminal && s.terminal.store) {
      u = s.terminal.store[RESOURCE_ENERGY] || 0;
    }
    var R = sumEnergy(l[STRUCTURE_CONTAINER]);
    var E = i + u;
    var f = E + R;
    var h = 0;
    var S = storageManager.storageFind(n, RESOURCE_ENERGY);
    if (S && !S.error) {
      var c = S.storage && typeof S.storage.reserved === "number" ? S.storage.reserved : 0;
      var g = S.terminal && typeof S.terminal.reserved === "number" ? S.terminal.reserved : 0;
      h = c + g;
    }
    var p = s.sources || [];
    var v = 0;
    for (var m = 0; m < p.length; m++) {
      v += sourceMaxRate(p[m]);
    }
    var d = t.byRoom && t.byRoom[n] || [];
    var T = roleWorkParts(d, "harvester");
    var O = roleWorkParts(d, "upgrader");
    var y = T * r;
    var _ = Math.floor(Math.min(y, v));
    var N = O * a;
    var G = _ - N;
    var A = "HEALTHY";
    if (E < BUY_TIERS[2].threshold) {
      A = "CRITICAL";
    } else if (E < BUY_TIERS[1].threshold) {
      A = "LOW";
    }
    var C = !!s.terminal;
    var L = null;
    if (C && E >= HIGH_STORAGE && G > 0) {
      L = "DONOR";
    } else if (C && E < LOW_STORAGE) {
      L = "RECIPIENT";
    }
    heap.energySnapshots[n] = {
      stock: {
        storage: i,
        terminal: u,
        containers: R
      },
      totalStock: f,
      bufferStock: E,
      reserved: h,
      prodEst: _,
      consEst: N,
      netEst: G,
      healthStatus: A,
      balanceRole: L,
      sourceCount: p.length,
      hasTerminal: C
    };
    heap.energyGlobal.totalStock += f;
    heap.energyGlobal.totalBufferStock += E;
    heap.energyGlobal.totalReserved += h;
    if (L === "DONOR") heap.energyGlobal.donorCount++;
    if (L === "RECIPIENT") heap.energyGlobal.recipientCount++;
  }
  heap.energyTick = Game.time;
}

function get(e) {
  return heap.energySnapshots ? heap.energySnapshots[e] : null;
}

function all() {
  return heap.energySnapshots || {};
}

function getGlobal() {
  return heap.energyGlobal || null;
}

function energyReport(e) {
  var t = heap.energySnapshots;
  var r = heap.energyGlobal;
  if (!t || !r) {
    console.log("[energyReport] No snapshot yet (energyManager.run has not built this tick).");
    return;
  }
  var a = [];
  var o = Game.time - (r.tick || 0);
  if (o > 0) {
    a.push("[energyReport] Snapshot tick " + r.tick + ", age " + o);
  }
  a.push("Room".padEnd(8) + "Sto".padStart(6) + "Trm".padStart(6) + "Ctr".padStart(6) + "Rsvd".padStart(6) + "P/t".padStart(5) + "C/t".padStart(5) + "N/t".padStart(6) + "  State");
  var n;
  if (e) {
    if (!t[e]) {
      console.log("[energyReport] No snapshot for " + e);
      return;
    }
    n = [ e ];
  } else {
    n = Object.keys(t).sort();
  }
  for (var s = 0; s < n.length; s++) {
    var l = n[s];
    var i = t[l];
    if (!i) continue;
    var u = i.stock || {};
    a.push(l.padEnd(8) + shortNum(u.storage).padStart(6) + shortNum(u.terminal).padStart(6) + shortNum(u.containers).padStart(6) + shortNum(i.reserved).padStart(6) + String(i.prodEst).padStart(5) + String(i.consEst).padStart(5) + signedShort(i.netEst).padStart(6) + "  " + stateLabel(i));
  }
  if (!e) {
    a.push("---");
    a.push("Colony: " + shortNum(r.totalStock) + " stock | " + shortNum(r.totalBufferStock) + " buffer | " + "Donors: " + r.donorCount + " | Recipients: " + r.recipientCount);
  }
  console.log(a.join("\n"));
}

global.energyReport = energyReport;
module.exports = {
  run: run,
  get: get,
  all: all,
  global: getGlobal,
  LOW_STORAGE: LOW_STORAGE,
  HIGH_STORAGE: HIGH_STORAGE,
  BUY_TIERS: BUY_TIERS,
  TERMINAL_TARGET: TERMINAL_TARGET
};
