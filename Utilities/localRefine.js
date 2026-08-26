// LLM: Read docs/codex.js before reviewing or changing this file.
// localRefine.js
// Console globals: localRefine, localRefineStatus, cancelLocalRefine
// Example: localRefine('E1N1', RESOURCE_PURIFIER, 1000) - Order local commodity refinement
// Example: localRefineStatus('E1N1') - Display local refinement queue and status
// Example: cancelLocalRefine('E1N1') - Cancel active local refinement order
//   localRefine('W1N1', 'Zynthium bar', 10000)
//   localRefineStatus()             // list ops
//   localRefineStatus('op_id')      // details
//   cancelLocalRefine('op_id')      // cancel op
var getRoomState = require("getRoomState");
var marketSeller = require("marketSell");
var util = require("util");
var memoryManager = require("memoryManager");
var factorySlots = require("factorySlots");
var storageManager = require("storageManager");
var factoryManager = require("factoryManager");
var OUTCOMES_HISTORY_CAP = 60;
var SELL_RETRY_TICKS = 10;
var SELL_RETRY_CAP = 50;
var BATTERY_REPRICE_TICKS = 1e3;
function ensureMemory() {
  if (!Memory.localRefine) Memory.localRefine = {
    ops: [],
    outcomes: {}
  }; else if (!Array.isArray(Memory.localRefine.ops)) Memory.localRefine.ops = [];
  if (!Memory.localRefine.outcomes || Array.isArray(Memory.localRefine.outcomes)) Memory.localRefine.outcomes = {};
  for (var e = 0; e < Memory.localRefine.ops.length; e++) {
    if (Memory.localRefine.ops[e]) delete Memory.localRefine.ops[e].lastUpdate;
  }
  var r = Memory.localRefine.outcomes;
  for (var t in r) {
    if (!r[t]) continue;
    delete r[t].id;
    delete r[t].jobId;
  }
}

function recordOutcome(e, r, t) {
  ensureMemory();
  releaseSellReservation(e, true);
  Memory.localRefine.outcomes[e.id] = {
    room: e.room,
    output: e.output,
    status: r,
    reason: t || null,
    started: e.started,
    tick: Game.time
  };
  var o = Object.keys(Memory.localRefine.outcomes);
  if (o.length > OUTCOMES_HISTORY_CAP) {
    o.sort(function(e, r) {
      return (Memory.localRefine.outcomes[e].tick || 0) - (Memory.localRefine.outcomes[r].tick || 0);
    });
    while (o.length > OUTCOMES_HISTORY_CAP) delete Memory.localRefine.outcomes[o.shift()];
  }
  e._outcomeRecorded = true;
  if (e.jobId) {
    try {
      var a = require("marketEconomics");
      a.finish(e.jobId, r === "done" ? "done" : r, t || null);
    } catch (e) {}
  }
  memoryManager.requestSave();
}

function releaseProductionState(e) {
  var r = [ "input", "requiredAmount", "targetBatches", "baseInputCount", "factoryCreated", "factoryStarted" ];
  var t = false;
  for (var o = 0; o < r.length; o++) {
    if (e[r[o]] !== undefined) {
      delete e[r[o]];
      t = true;
    }
  }
  if (t) memoryManager.requestSave();
}

function normalizeOutput(e) {
  if (e && typeof e !== "string") return e;
  var r = (e || "").trim().toUpperCase();
  var t = {
    OXIDANT: RESOURCE_OXIDANT,
    REDUCTANT: RESOURCE_REDUCTANT,
    "ZYNTHIUM BAR": RESOURCE_ZYNTHIUM_BAR,
    ZYNTHIUM_BAR: RESOURCE_ZYNTHIUM_BAR,
    "LEMERGIUM BAR": RESOURCE_LEMERGIUM_BAR,
    LEMERGIUM_BAR: RESOURCE_LEMERGIUM_BAR,
    "UTRIUM BAR": RESOURCE_UTRIUM_BAR,
    UTRIUM_BAR: RESOURCE_UTRIUM_BAR,
    "KEANIUM BAR": RESOURCE_KEANIUM_BAR,
    KEANIUM_BAR: RESOURCE_KEANIUM_BAR,
    "GHODIUM MELT": RESOURCE_GHODIUM_MELT,
    GHODIUM_MELT: RESOURCE_GHODIUM_MELT,
    PURIFIER: RESOURCE_PURIFIER,
    BATTERY: RESOURCE_BATTERY
  };
  if (t[r]) return t[r];
  if (global[r]) return global[r];
  return e;
}

var OUTPUT_TO_INPUT = {};
OUTPUT_TO_INPUT[RESOURCE_OXIDANT] = RESOURCE_OXYGEN;
OUTPUT_TO_INPUT[RESOURCE_REDUCTANT] = RESOURCE_HYDROGEN;
OUTPUT_TO_INPUT[RESOURCE_PURIFIER] = RESOURCE_CATALYST;
OUTPUT_TO_INPUT[RESOURCE_ZYNTHIUM_BAR] = RESOURCE_ZYNTHIUM;
OUTPUT_TO_INPUT[RESOURCE_LEMERGIUM_BAR] = RESOURCE_LEMERGIUM;
OUTPUT_TO_INPUT[RESOURCE_UTRIUM_BAR] = RESOURCE_UTRIUM;
OUTPUT_TO_INPUT[RESOURCE_KEANIUM_BAR] = RESOURCE_KEANIUM;
OUTPUT_TO_INPUT[RESOURCE_GHODIUM_MELT] = RESOURCE_GHODIUM;
OUTPUT_TO_INPUT[RESOURCE_BATTERY] = RESOURCE_ENERGY;
function getPrimaryInput(e) {
  if (OUTPUT_TO_INPUT[e]) return OUTPUT_TO_INPUT[e];
  if (typeof COMMODITIES !== "undefined" && COMMODITIES[e]) {
    var r = COMMODITIES[e].components || {};
    var t = null;
    for (var o in r) {
      if (!r.hasOwnProperty(o)) continue;
      if (o === RESOURCE_ENERGY) continue;
      if (!t) t = o;
    }
    return t || RESOURCE_ENERGY;
  }
  return null;
}

function getInputs(e) {
  if (typeof COMMODITIES !== "undefined" && COMMODITIES[e]) {
    var r = COMMODITIES[e];
    var t = r.components || {};
    var o = [];
    for (var a in t) {
      if (!t.hasOwnProperty(a)) continue;
      o.push({
        resource: a,
        ratio: t[a] || 0
      });
    }
    if (o.length > 0) return o;
  }
  if (OUTPUT_TO_INPUT[e]) {
    return [ {
      resource: OUTPUT_TO_INPUT[e],
      ratio: 0
    } ];
  }
  return null;
}

function isSupported(e) {
  if (OUTPUT_TO_INPUT[e]) return true;
  if (typeof COMMODITIES !== "undefined" && COMMODITIES[e]) return true;
  return false;
}

function failOp(e, r, t) {
  var o = "[LocalRefine] FAILED: " + e.id + " (" + e.output + " in " + e.room + ") - " + r;
  if (t) o += " | " + t;
  console.log(o);
  Game.notify(o, 30);
  e.phase = "failed";
  e.failReason = r;
  e.failTick = Game.time;
  if (!e._outcomeRecorded) recordOutcome(e, "failed", t ? r + ": " + t : r);
}

function callOrderFactory(e, r, t) {
  if (typeof orderFactory === "function") {
    return orderFactory(e, r, t);
  }
  try {
    var o = require("factoryManager");
    if (o && typeof o.orderFactory === "function") {
      return o.orderFactory(e, r, t);
    }
  } catch (e) {}
  return "[LocalRefine] ERROR: orderFactory not available.";
}

function callMarketSell(e, r, t, o, a) {
  if (!marketSeller || typeof marketSeller.marketSell !== "function") {
    return "[LocalRefine] ERROR: marketSell module not available or missing .marketSell().";
  }
  try {
    return marketSeller.marketSell(e, r, t, o, a);
  } catch (e) {
    return "[LocalRefine] ERROR invoking marketSell: " + e;
  }
}

function roomOwned(e) {
  var r = getRoomState.get(e);
  return !!(r && r.controller && r.controller.my);
}

function roomHasTerminal(e) {
  var r = getRoomState.get(e);
  return !!(r && r.terminal);
}

function findLiveOperation(e, r) {
  var t = Memory.localRefine && Array.isArray(Memory.localRefine.ops) ? Memory.localRefine.ops : [];
  for (var o = 0; o < t.length; o++) {
    var a = t[o];
    if (!a || a.room !== e || a.output !== r) continue;
    if (a.phase === "done" || a.phase === "failed" || a.phase === "error" || a.phase === "cancelled") continue;
    return a;
  }
  return null;
}

function countInRoom(e, r) {
  var t = getRoomState.get(e);
  if (!t) return 0;
  var o = 0;
  function add(e) {
    if (e && e.store && e.store[r]) o += e.store[r];
  }
  add(t.storage);
  add(t.terminal);
  var a = t.structuresByType || {};
  var n = a[STRUCTURE_FACTORY] || [];
  if (n.length > 0) add(n[0]);
  return o;
}

function ensureSellReservationProgram(e) {
  if (!e.sellReservationProgram) {
    e.sellReservationProgram = "localRefineSell_" + e.id;
    memoryManager.requestSave();
  }
  return e.sellReservationProgram;
}

function getBuildingFreeForProgram(e, r, t, o) {
  var a = storageManager.storageFind(e, r);
  var n = a && a[t];
  if (!n) return 0;
  var i = 0;
  var l = n.reservations || [];
  for (var u = 0; u < l.length; u++) {
    if (l[u] && l[u].program !== o) {
      i += l[u].amount || 0;
    }
  }
  return Math.max(0, (n.total || 0) - i);
}

function reserveSellOutput(e, r) {
  if (!e || !(r > 0)) return 0;
  var t = ensureSellReservationProgram(e);
  var o = Math.min(r, getBuildingFreeForProgram(e.room, e.output, "terminal", t));
  if (o > 0) {
    var a = storageManager.reserve(e.room, e.output, "terminal", t, o);
    if (!a || !a.ok) o = 0;
  }
  if (o <= 0) storageManager.unReserve(e.room, e.output, "terminal", t);
  var n = Math.min(Math.max(0, r - o), getBuildingFreeForProgram(e.room, e.output, "storage", t));
  if (n > 0) {
    var i = storageManager.reserve(e.room, e.output, "storage", t, n);
    if (!i || !i.ok) n = 0;
  }
  if (n <= 0) storageManager.unReserve(e.room, e.output, "storage", t);
  return o + n;
}

function releaseSellReservation(e, r) {
  if (!e || !e.sellReservationProgram) return;
  storageManager.unReserve(e.room, e.output, "terminal", e.sellReservationProgram);
  storageManager.unReserve(e.room, e.output, "storage", e.sellReservationProgram);
  if (r) delete e.sellReservationProgram;
}

function startFactoryOrder(e, r, t) {
  var o = callOrderFactory(e, r, t);
  var a = null;
  if (typeof o === "string") {
    var n = o.match(/\[#([^\]]+)\]/);
    if (n && n[1]) a = n[1];
  }
  return {
    message: o,
    orderId: a
  };
}

function marketSellAccepted(e) {
  return typeof e === "string" && (e.indexOf("Created SELL order") >= 0 || e.indexOf("extended existing") >= 0 || e.indexOf("covered existing") >= 0);
}

function productionPlan(e, r, t) {
  if (typeof COMMODITIES === "undefined" || !COMMODITIES[e]) return null;
  var o = COMMODITIES[e];
  var a = o.components && o.components[r];
  var n = o.amount || 1;
  if (!(a > 0) || !(n > 0)) return null;
  var i = Math.floor(t / a);
  if (i <= 0) return null;
  return {
    batches: i,
    outputAmount: i * n
  };
}

function findFactoryOrderById(e) {
  return factoryManager.getOrderById(e);
}

function isLiveFactoryOrder(e) {
  return factoryManager && typeof factoryManager.isLiveOrder === "function" ? factoryManager.isLiveOrder(e) : !!(e && e.status !== "done" && e.status !== "cancelled");
}

function findCompletedFactoryOrderById(e) {
  return factoryManager.getCompletedOrderById(e);
}

function anyFactoryOrderAfter(e, r, t) {
  return factoryManager.hasOrderAfter(e, r, t);
}

function reconcileFactoryState(e) {
  if (!e || e.phase !== "refining" || !e.factoryStarted) return false;
  var r = e.factoryOrderId ? findFactoryOrderById(e.factoryOrderId) : null;
  var t = e.factoryOrderId ? isLiveFactoryOrder(r) : anyFactoryOrderAfter(e.room, e.output, e.factoryCreated || e.started);
  if (r && typeof r.progressOut === "number" && r.progressOut > (e.factoryProgressOut || 0)) {
    e.factoryProgressOut = r.progressOut;
  }
  if (t) return false;
  if (e.factoryOrderId) {
    var o = findCompletedFactoryOrderById(e.factoryOrderId);
    if (o && typeof o.progressOut === "number" && o.progressOut > (e.factoryProgressOut || 0)) {
      e.factoryProgressOut = o.progressOut;
    }
  }
  e.phase = "selling";
  reserveSellOutput(e, e.factoryProgressOut || e.targetOutput || 0);
  releaseProductionState(e);
  if (e.jobId) {
    try {
      require("marketEconomics").phase(e.jobId, "delivering");
      e._phase = "delivering";
    } catch (e) {}
  }
  memoryManager.requestSave();
  return true;
}

var startLocalRefine = global.localRefine = function(e, r, t, o) {
  var a = o && o.jobId ? o.jobId : null;
  ensureMemory();
  getRoomState.init();
  if (typeof e !== "string" || !e) {
    return "[LocalRefine] Provide a valid room name.";
  }
  if (!roomOwned(e)) {
    return "[LocalRefine] Room not owned or not visible: " + e;
  }
  if (!roomHasTerminal(e)) {
    return "[LocalRefine] Room " + e + " has no terminal.";
  }
  var n = factorySlots.refusal(e, "LocalRefine");
  if (n) return n;
  var i = normalizeOutput(r);
  if (!i || !isSupported(i)) {
    return "[LocalRefine] Unsupported output: " + r + ". Must be a valid COMMODITIES product or compressed resource.";
  }
  var l = findLiveOperation(e, i);
  if (l) {
    return "[LocalRefine] REFUSED: " + i + " operation already active in " + e + " (" + l.id + ", phase=" + l.phase + ").";
  }
  var u = getPrimaryInput(i);
  if (!u) {
    return "[LocalRefine] Cannot determine input resource for: " + r;
  }
  var s = countInRoom(e, u);
  var c;
  if (t === "max" || t === "MAX") {
    c = s;
  } else {
    c = typeof t === "number" ? t : 0;
  }
  if (c <= 0) {
    return '[LocalRefine] ERROR: Must provide a positive AMOUNT, or "max". Found ' + s + " " + u + " in room.";
  }
  if (s < c) {
    return "[LocalRefine] ERROR: Not enough " + u + " in " + e + ". Found: " + s + ", Needed: " + c;
  }
  var f = productionPlan(i, u, c);
  if (!f) {
    return "[LocalRefine] ERROR: " + c + " " + u + " is not enough for one complete " + i + " batch.";
  }
  var d = getInputs(i);
  if (d) {
    var m = [];
    for (var R = 0; R < d.length; R++) {
      var O = d[R];
      var p = countInRoom(e, O.resource);
      var g = O.ratio * f.batches;
      if (p < g) {
        m.push(O.resource + ": " + p + "/" + g);
      }
    }
    if (m.length > 0) {
      return "[LocalRefine] ERROR: Missing inputs in " + e + ": " + m.join(", ");
    }
  }
  var y = countInRoom(e, i);
  var v = "lref_" + e + "_" + i + "_" + Game.time;
  var I = {
    id: v,
    room: e,
    input: u,
    output: i,
    requiredAmount: c,
    targetBatches: f.batches,
    targetOutput: f.outputAmount,
    baseInputCount: s,
    baseOutputCount: y,
    phase: "refining",
    started: Game.time,
    factoryStarted: false,
    factoryOrderId: null,
    outputBaseAtFactoryStart: null,
    jobId: a
  };
  Memory.localRefine.ops.push(I);
  memoryManager.requestSave();
  return "[LocalRefine] Started " + v + " | Found " + s + " " + u + " (Req: " + c + ") -> refine " + f.outputAmount + " " + i + " (" + f.batches + " batches) -> sell.";
};
global.localRefineStatus = function(e) {
  ensureMemory();
  var r = Memory.localRefine.ops;
  var t = Object.keys(Memory.localRefine.outcomes).length > 0;
  if ((!r || r.length === 0) && !t) return "[LocalRefine] No ops.";
  if (e) {
    for (var o = 0; o < r.length; o++) {
      var a = r[o];
      if (a && a.id === e) {
        var n = [];
        n.push("[" + a.id + "] room=" + a.room + " phase=" + a.phase);
        n.push("  output: " + a.output + (a.factoryOrderId ? " orderId=" + a.factoryOrderId : ""));
        n.push("  reqInput=" + a.requiredAmount + " currentInput=" + countInRoom(a.room, a.input));
        n.push("  baseOutput=" + a.baseOutputCount + " outputBaseAtFactoryStart=" + a.outputBaseAtFactoryStart + " currentOutput=" + countInRoom(a.room, a.output));
        if (a.sellPosted) {
          var i = a.sellOrderId && Game.market && Game.market.orders ? Game.market.orders[a.sellOrderId] : null;
          n.push("  sell=" + (a.sellOrderId || "unknown") + " price=" + (i && typeof i.price === "number" ? i.price : a.sellOrderPrice || "?") + " remaining=" + (i ? util.getOrderRemaining(i) : "?") + " target=" + (a.sellAmount || "?"));
        }
        if (a.failReason) {
          n.push("  FAILURE: " + a.failReason + " (tick " + (a.failTick || "?") + ")");
        }
        return n.join("\n");
      }
    }
    var l = Memory.localRefine.outcomes[e];
    if (l) return "[" + e + "] room=" + l.room + " status=" + l.status + "\n  output: " + l.output + "\n  reason: " + (l.reason || "(none)") + " (tick " + l.tick + ")";
    return "[LocalRefine] Op not found: " + e;
  }
  var u = [];
  for (var s = 0; s < r.length; s++) {
    var c = r[s];
    if (!c) continue;
    var f = c.phase === "failed" ? " FAILED: " + (c.failReason || "?") : "";
    var d = "";
    if (c.sellPosted) {
      var m = c.sellOrderId && Game.market && Game.market.orders ? Game.market.orders[c.sellOrderId] : null;
      d = " | sell=" + (c.sellOrderId || "?") + "@" + (m && typeof m.price === "number" ? m.price : c.sellOrderPrice || "?") + " rem=" + (m ? util.getOrderRemaining(m) : "?") + "/" + (c.sellAmount || "?");
    }
    u.push("[" + c.id + "] " + c.room + " " + (c.input || "energy") + " -> " + c.output + " | phase=" + c.phase + d + f);
  }
  var R = Memory.localRefine.outcomes;
  var O = Object.keys(R).sort(function(e, r) {
    return (R[e].tick || 0) - (R[r].tick || 0);
  });
  for (var p = 0; p < O.length; p++) {
    var g = R[O[p]];
    u.push("[" + O[p] + "] " + g.room + " -> " + g.output + " | status=" + g.status + (g.reason ? " reason=" + g.reason : ""));
  }
  return u.join("\n");
};
global.cancelLocalRefine = function(e) {
  ensureMemory();
  var r = Memory.localRefine.ops;
  for (var t = 0; t < r.length; t++) {
    var o = r[t];
    if (o && o.id === e) {
      recordOutcome(o, "cancelled", "Cancelled by console command");
      r.splice(t, 1);
      return "[LocalRefine] Cancelled op " + e;
    }
  }
  return "[LocalRefine] Op not found: " + e;
};
function run() {
  ensureMemory();
  getRoomState.init();
  var e = Memory.localRefine.ops;
  for (var r = e.length - 1; r >= 0; r--) {
    var t = e[r];
    if (!t) {
      e.splice(r, 1);
      continue;
    }
    if (t.phase === "done" || t.phase === "error" || t.phase === "failed") {
      if (!t._outcomeRecorded) {
        recordOutcome(t, t.phase === "done" ? "done" : "failed", t.failReason || t.phase);
      }
      e.splice(r, 1);
      continue;
    }
    if (t.phase === "refining") {
      if (!t.factoryStarted) {
        if (!(t.targetOutput > 0)) {
          var o = productionPlan(t.output, t.input, t.requiredAmount);
          if (!o) {
            failOp(t, "Cannot determine exact factory target", "Legacy operation has no complete-batch target");
            continue;
          }
          t.targetBatches = o.batches;
          t.targetOutput = o.outputAmount;
        }
        var a = startFactoryOrder(t.room, t.output, t.targetOutput);
        var n = typeof a.message === "string" ? a.message : "";
        if (n.indexOf("REFUSED") >= 0 || n.indexOf("Unknown") >= 0 || n.indexOf("unsupported") >= 0) {
          failOp(t, "Factory refused order", n);
          continue;
        }
        if (n.indexOf("ERROR") >= 0) {
          failOp(t, "Factory order error", n);
          continue;
        }
        if (n.indexOf("Order accepted") < 0) {
          failOp(t, "Factory order was not accepted", n || "Empty factory response");
          continue;
        }
        t.factoryOrderId = a.orderId || null;
        if (t.jobId && t.factoryOrderId) {
          factoryManager.annotateOrder(t.factoryOrderId, {
            jobId: t.jobId
          });
        }
        t.factoryCreated = Game.time;
        t.factoryStarted = true;
        t.outputBaseAtFactoryStart = countInRoom(t.room, t.output);
        if (t.jobId) {
          try {
            var i = require("marketEconomics");
            i.link(t.jobId, "factory", t.factoryOrderId);
            if (t._phase !== "producing") i.phase(t.jobId, "producing");
            t._phase = "producing";
          } catch (e) {}
        }
        memoryManager.requestSave();
        continue;
      }
      reconcileFactoryState(t);
      continue;
    }
    if (t.phase === "selling") {
      releaseProductionState(t);
      if (t.nextSellTick && Game.time < t.nextSellTick) continue;
      var l = countInRoom(t.room, t.output);
      var u = t.outputBaseAtFactoryStart !== null && t.outputBaseAtFactoryStart !== undefined ? t.outputBaseAtFactoryStart : t.baseOutputCount;
      var s = l - u;
      var c = typeof t.factoryProgressOut === "number" ? t.factoryProgressOut : 0;
      if (c <= 0 && t.factoryOrderId) {
        var f = findCompletedFactoryOrderById(t.factoryOrderId);
        if (f && typeof f.progressOut === "number") {
          c = f.progressOut;
          t.factoryProgressOut = f.progressOut;
        }
      }
      if (c <= 0) {
        var d = t.factoryOrderId ? findFactoryOrderById(t.factoryOrderId) : null;
        if (d && typeof d.progressOut === "number") {
          c = d.progressOut;
          t.factoryProgressOut = d.progressOut;
        }
      }
      if (c <= 0 && s > 0) {
        c = s;
        t.factoryProgressOut = s;
      }
      if (c <= 0) {
        failOp(t, "No output produced", "Expected " + t.output + " in " + t.room + " but produced=" + c + " delta=" + s + " (current=" + l + ", baseline=" + u + ")");
        continue;
      }
      if (t.sellPosted) {
        var m = t.sellAmount || s;
        if (t.output === RESOURCE_BATTERY && (!t.nextSellRepriceTick || Game.time >= t.nextSellRepriceTick)) {
          callMarketSell(t.room, t.output, m, undefined, {
            repriceOnly: true,
            liquidate: true
          });
          t.nextSellRepriceTick = Game.time + BATTERY_REPRICE_TICKS;
          if (t.sellOrderId && Game.market && Game.market.orders && Game.market.orders[t.sellOrderId]) {
            t.sellOrderPrice = Game.market.orders[t.sellOrderId].price;
          }
          memoryManager.requestSave();
        }
        var R = 0;
        var O = false;
        var p = false;
        if (t.jobId && t.sellLotTracked) {
          try {
            var g = require("marketEconomics").get(t.jobId);
            var y = g && g.output && g.output[t.output];
            var v = y && y.sold || 0;
            R = Math.max(0, v - (t.jobSoldAtPost || 0));
            p = true;
          } catch (e) {}
        }
        if (!p && t.sellOrderId && Game.market && Game.market.orders && Game.market.orders[t.sellOrderId]) {
          var I = util.getOrderRemaining(Game.market.orders[t.sellOrderId]);
          R = Math.max(0, (t.sellOrderRemainingAtPost || 0) - I);
        } else if (!p && t.sellOrderId) {
          O = true;
          var E = Game.market.outgoingTransactions || [];
          for (var T = 0; T < E.length; T++) {
            var M = E[T];
            if (!M || !M.order || M.order.id !== t.sellOrderId) continue;
            if (typeof M.time === "number" && M.time < (t.sellPostedTick || 0)) continue;
            R += M.amount || 0;
          }
        } else if (!p) {
          var S = 0;
          if (Game.market && Game.market.orders) {
            for (var U in Game.market.orders) {
              var _ = Game.market.orders[U];
              if (!_ || _.type !== ORDER_SELL) continue;
              if (_.roomName !== t.room || _.resourceType !== t.output) continue;
              S += util.getOrderRemaining(_);
            }
          }
          if (S <= 0 && l <= u) R = m;
        }
        if (p && t.sellOrderId && (!Game.market || !Game.market.orders || !Game.market.orders[t.sellOrderId]) && R < m) {
          if (!t.sellOrderMissingTick) {
            t.sellOrderMissingTick = Game.time;
            memoryManager.requestSave();
          }
          if (Game.time - t.sellOrderMissingTick >= 20) {
            var h = Math.max(0, m - R);
            t.sellPosted = false;
            t.sellOrderId = null;
            t.sellOrderRemainingAtPost = null;
            t.sellAmount = h;
            t.nextSellTick = Game.time + SELL_RETRY_TICKS;
            t.sellRetryCount = (t.sellRetryCount || 0) + 1;
            delete t.sellOrderMissingTick;
            console.log("[LocalRefine] Tracked sell order disappeared for " + t.id + "; retrying " + h + " " + t.output + " after " + R + " sold.");
            memoryManager.requestSave();
          }
          continue;
        }
        if (R >= m) {
          t.phase = "done";
          recordOutcome(t, "done", m + " " + t.output + " produced and sold");
        } else if (O) {
          var A = Math.max(0, m - R);
          t.sellPosted = false;
          t.sellOrderId = null;
          t.sellOrderRemainingAtPost = null;
          t.sellAmount = A;
          t.nextSellTick = Game.time + SELL_RETRY_TICKS;
          t.sellRetryCount = (t.sellRetryCount || 0) + 1;
          console.log("[LocalRefine] Sell order disappeared for " + t.id + "; retrying " + A + " " + t.output + " after " + R + " sold.");
          memoryManager.requestSave();
        }
        continue;
      }
      var C = c;
      var P = {
        allowExistingCoverage: true,
        liquidate: t.output === RESOURCE_BATTERY
      };
      if (t.jobId) P.jobId = t.jobId;
      reserveSellOutput(t, C);
      releaseSellReservation(t, false);
      var k = callMarketSell(t.room, t.output, C, undefined, P);
      if (marketSellAccepted(k)) {
        releaseSellReservation(t, true);
        t.sellPosted = true;
        t.sellAmount = C;
        t.sellPostedTick = Game.time;
        t.nextSellRepriceTick = Game.time + BATTERY_REPRICE_TICKS;
        var L = typeof k === "string" ? k.match(/orderId\s+([A-Za-z0-9]+)/) : null;
        t.sellOrderId = L ? L[1] : null;
        t.sellOrderPrice = t.sellOrderId && Game.market.orders[t.sellOrderId] ? Game.market.orders[t.sellOrderId].price : null;
        if (t.sellOrderId && Game.market.orders[t.sellOrderId]) {
          t.sellOrderRemainingAtPost = util.getOrderRemaining(Game.market.orders[t.sellOrderId]);
        } else {
          t.sellOrderRemainingAtPost = null;
        }
        t.sellLotTracked = !!(t.jobId && typeof k === "string" && k.indexOf("jobLot " + t.jobId) >= 0);
        if (t.sellLotTracked) {
          try {
            var b = require("marketEconomics").get(t.jobId);
            var G = b && b.output && b.output[t.output];
            t.jobSoldAtPost = G && G.sold || 0;
          } catch (e) {
            t.sellLotTracked = false;
          }
        }
        if (t.jobId) {
          try {
            var B = require("marketEconomics");
            if (t._phase !== "selling") B.phase(t.jobId, "selling");
            t._phase = "selling";
          } catch (e) {}
        }
        memoryManager.requestSave();
      } else {
        reserveSellOutput(t, C);
        t.sellAttempts = (t.sellAttempts || 0) + 1;
        if (t.sellAttempts >= SELL_RETRY_CAP) {
          failOp(t, "Sell retries exhausted", "sellAttempts=" + t.sellAttempts + " (cap=" + SELL_RETRY_CAP + ") - last message: " + (typeof k === "string" ? k : "n/a"));
          continue;
        }
        t.nextSellTick = Game.time + SELL_RETRY_TICKS;
        memoryManager.requestSave();
      }
      continue;
    }
  }
}

function getOperations() {
  ensureMemory();
  const e = 5e3;
  if (Array.isArray(Memory.localRefine.ops)) {
    Memory.localRefine.ops = Memory.localRefine.ops.filter(function(r) {
      if (!r) return false;
      if (r.phase === "selling" && Game.time - (r.started || Game.time) > e) {
        return false;
      }
      return true;
    });
  }
  return Memory.localRefine.ops.map(function(e) {
    return e && typeof e === "object" ? Object.create(e) : null;
  });
}

function getOperation(e) {
  if (!e) return null;
  var r = getOperations();
  for (var t = 0; t < r.length; t++) {
    if (r[t] && r[t].id === e) return r[t];
  }
  return null;
}

function getOutcome(e) {
  if (!e) return null;
  ensureMemory();
  return Memory.localRefine.outcomes[e] || null;
}

function getOutcomes() {
  ensureMemory();
  return Object.keys(Memory.localRefine.outcomes).map(function(e) {
    var r = Memory.localRefine.outcomes[e];
    if (!r) return r;
    var t = Object.create(r);
    t.id = e;
    return t;
  });
}

module.exports = {
  run: run,
  start: startLocalRefine,
  getOperations: getOperations,
  getOperation: getOperation,
  getOutcome: getOutcome,
  getOutcomes: getOutcomes
};
