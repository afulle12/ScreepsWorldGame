// LLM: Read docs/codex.js before reviewing or changing this file.
// roomBalance.js
// Console globals: roomBalanceNextRun
// Example: roomBalanceNextRun() - Query next scheduled execution tick for room balance
//   (factory-battery path via localRefine, or direct energy path via opportunisticSell), then
//   calls the chosen module. See decideDisposalRoute() and dispatchDisposal() for the logic.
// Example: roomBalanceNextRun();
const terminalManager = require("terminalManager");
const opportunisticSell = require("opportunisticSell");
const roomSuspender = require("roomSuspender");
const localRefine = require("localRefine");
const economics = require("economics");
const LOW_STORAGE_THRESHOLD = 3e5;
const HIGH_STORAGE_THRESHOLD = 4e5;
const TRANSFER_AMOUNT = 15e3;
const SELL_THRESHOLD = 6e5;
const ENERGY_PER_BATTERY = 12;
const BATTERIES_PER_BATCH = 50;
const ENERGY_PER_BATCH = 600;
const MIN_ENERGY_REMAINDER_DIRECT_SELL = 1e3;
global.roomBalanceNextRun = function() {
  var e = 5e3;
  var r = Game.time % e;
  var n = r === 0 ? 0 : e - r;
  var t = Game.time + n;
  console.log("[roomBalance] next auto run at tick " + t + " (in " + n + " ticks, now=" + Game.time + ", interval=" + e + ")");
  return {
    nextTick: t,
    inTicks: n,
    now: Game.time,
    interval: e
  };
};
function decideDisposalRoute(e, r) {
  if (e <= 0) return null;
  var n = economics.resourcePrice(RESOURCE_BATTERY);
  var t = economics.resourcePrice(RESOURCE_ENERGY);
  var o = n > 0 ? n / ENERGY_PER_BATTERY : 0;
  var a = t > 0 ? t : 0;
  var i = {
    batteryPrice: n,
    energyPrice: t,
    batteryPerEnergy: o,
    energyPerEnergy: a,
    batteryBreakEvenPrice: a * ENERGY_PER_BATTERY
  };
  var l = o > a;
  if (!l) {
    return {
      route: "energy",
      amount: e,
      comparison: i,
      reason: n > 0 ? "battery revenue per input energy is not higher than direct energy" : "battery has no usable price"
    };
  }
  var s = Math.floor(e / ENERGY_PER_BATCH);
  if (s <= 0) {
    return {
      route: "energy",
      amount: e,
      comparison: i,
      reason: "battery route would not fill one factory batch"
    };
  }
  return {
    route: "battery",
    amount: s * ENERGY_PER_BATCH,
    remainder: e - s * ENERGY_PER_BATCH,
    comparison: i,
    reason: "battery revenue per input energy exceeds direct energy"
  };
}

function formatRouteComparison(e) {
  var r = e && e.comparison;
  if (!r) return "";
  return " | battery " + r.batteryPrice.toFixed(3) + "/12=" + r.batteryPerEnergy.toFixed(3) + " per energy vs direct " + r.energyPrice.toFixed(3) + " | battery break-even=" + r.batteryBreakEvenPrice.toFixed(3) + " | reason=" + e.reason;
}

function hasActiveLocalRefineBatteryOp(e) {
  var r = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
  for (var n = 0; n < r.length; n++) {
    var t = r[n];
    if (!t) continue;
    if (t.room !== e) continue;
    if (t.output !== RESOURCE_BATTERY) continue;
    if (t.phase === "done" || t.phase === "failed" || t.phase === "error" || t.phase === "cancelled") continue;
    return true;
  }
  return false;
}

function getEnergySellRequest(e) {
  var r = e + "_" + RESOURCE_ENERGY;
  var n = Memory.opportunisticSell && Memory.opportunisticSell.requests ? Memory.opportunisticSell.requests : null;
  return n && n[r];
}

function marketSellOwnsTerminalOperation(e) {
  var r = Memory.marketSell && Memory.marketSell.requests;
  if (!Array.isArray(r)) return false;
  for (var n = 0; n < r.length; n++) {
    if (r[n] && r[n].tmOpId === e) return true;
  }
  return false;
}

function cancelLegacyEnergyStaging(e) {
  var r = Memory.terminalManager && Memory.terminalManager.operations;
  if (!Array.isArray(r) || !terminalManager || typeof terminalManager.cancelOperation !== "function") return;
  var n = [];
  for (var t = 0; t < r.length; t++) {
    var o = r[t];
    if (!o || o.type !== "toTerminal" || o.roomName !== e || o.resourceType !== RESOURCE_ENERGY || !o.useSupplier || o.feederFor || o.status === "completed" || o.status === "failed" || o.status === "cancelled" || marketSellOwnsTerminalOperation(o.id)) continue;
    n.push(o.id);
  }
  for (var a = 0; a < n.length; a++) {
    terminalManager.cancelOperation(n[a]);
    console.log("[RoomBalance] " + e + ": cancelled legacy energy staging operation " + n[a] + ".");
  }
}

function dispatchDisposal(e, r) {
  if (!r || r.amount <= 0) return;
  cancelLegacyEnergyStaging(e);
  if (r.route === "battery") {
    if (hasActiveLocalRefineBatteryOp(e)) {
      console.log("[RoomBalance] " + e + ": localRefine battery op already in progress; selling excess energy directly." + formatRouteComparison(r));
      r = {
        route: "energy",
        amount: r.amount + (r.remainder || 0),
        comparison: r.comparison,
        reason: "localRefine battery op already in progress"
      };
    } else {
      var n = localRefine.start(e, RESOURCE_BATTERY, r.amount);
      var t = r.amount / ENERGY_PER_BATTERY;
      console.log("[RoomBalance] Battery route for " + e + ": " + r.amount + " energy → ~" + t + " battery via localRefine → " + n + formatRouteComparison(r));
      if (typeof n !== "string" || n.indexOf("[LocalRefine] Started ") !== 0) {
        console.log("[RoomBalance] Battery conversion for " + e + " was not accepted; retaining the energy for a later retry.");
        return;
      }
      if (r.remainder && r.remainder > 0) {
        if (r.remainder >= MIN_ENERGY_REMAINDER_DIRECT_SELL) {
          dispatchDisposal(e, {
            route: "energy",
            amount: r.remainder
          });
        } else {
          console.log("[RoomBalance] " + e + ": dropping small battery-route remainder of " + r.remainder + " energy (below MIN_ENERGY_REMAINDER_DIRECT_SELL=" + MIN_ENERGY_REMAINDER_DIRECT_SELL + ").");
        }
      }
      return;
    }
  }
  var o = getEnergySellRequest(e);
  if (o && o.pending && o.pending.ambiguous) {
    var a = o.pending.expected || 0;
    opportunisticSell.cancelRequest(e, RESOURCE_ENERGY);
    console.log("[RoomBalance] " + e + ": replacing ambiguous energy sell request " + "(held " + a + " energy) with current excess.");
  }
  opportunisticSell.setup(e, RESOURCE_ENERGY, r.amount, true);
  console.log("[RoomBalance] Energy route for " + e + ": opportunistic sell target " + r.amount + " energy (excess above " + SELL_THRESHOLD + ")" + formatRouteComparison(r) + ".");
}

const roomBalance = {
  run: function() {
    var e = [];
    for (var r in Game.rooms) {
      var n = Game.rooms[r];
      if (!n || !n.controller || !n.controller.my) continue;
      if (roomSuspender.shouldAvoidRoomWork(r)) continue;
      var t = 0;
      if (n.storage && n.storage.store) {
        var o = n.storage.store[RESOURCE_ENERGY];
        t = typeof o === "number" ? o : 0;
      }
      var a = !!n.terminal;
      e.push({
        name: r,
        energy: t,
        hasTerminal: a
      });
    }
    if (e.length === 0) return;
    for (var i = 0; i < e.length; i++) {
      var l = e[i];
      if (l.energy > SELL_THRESHOLD && l.hasTerminal) {
        var s = l.energy - SELL_THRESHOLD;
        var c = decideDisposalRoute(s, l.name);
        if (c) dispatchDisposal(l.name, c);
      }
    }
    var u = e.filter(function(e) {
      return e.energy < LOW_STORAGE_THRESHOLD && e.hasTerminal;
    });
    var E = e.filter(function(e) {
      return e.energy > HIGH_STORAGE_THRESHOLD && e.hasTerminal;
    });
    if (u.length === 0 || E.length === 0) return;
    E.sort(function(e, r) {
      return r.energy - e.energy;
    });
    u.sort(function(e, r) {
      return e.energy - r.energy;
    });
    function isBusy(e) {
      return terminalManager.isRoomBusyWithTransfer(e);
    }
    u = u.filter(function(e) {
      return !isBusy(e.name);
    });
    E = E.filter(function(e) {
      return !isBusy(e.name);
    });
    if (u.length === 0 || E.length === 0) return;
    if (u.length >= 1 && E.length >= 1) {
      var R = u[0].name;
      var m = E[0].name;
      if (m !== R && !isBusy(R) && !isBusy(m)) {
        var g = terminalManager.transferStuff(m, R, "energy", TRANSFER_AMOUNT);
        console.log("[RoomBalance] " + m + " -> " + R + " x " + TRANSFER_AMOUNT + " ENERGY | " + g);
      }
    }
    if (u.length >= 2 && E.length >= 2) {
      var f = u[1].name;
      var y = E[1].name;
      if (y !== f && !isBusy(f) && !isBusy(y)) {
        var p = terminalManager.transferStuff(y, f, "energy", TRANSFER_AMOUNT);
        console.log("[RoomBalance] " + y + " -> " + f + " x " + TRANSFER_AMOUNT + " ENERGY | " + p);
      }
    }
  }
};
module.exports = roomBalance;
