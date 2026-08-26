// LLM: Read docs/codex.js before reviewing or changing this file.
// marketBuy.js
// Console globals: marketBuy, marketBuyStatus, cancelMarketBuyOrder, cancelMarketBuyGather, marketBuyForceRaiseToTop
// Example: marketBuy('E1N1', RESOURCE_HYDROGEN, 5000, 0.15) - Place or fulfill market buy order
// Example: marketBuyStatus('E1N1') - Display active market buy orders and fulfillment status
// Example: cancelMarketBuyOrder('orderId') - Cancel specific market buy order
// Example: cancelMarketBuyGather('E1N1') - Cancel gathering operations for buy order
// Example: marketBuyForceRaiseToTop('orderId') - Increase buy order bid to top of book
var terminalManager = require("terminalManager");
var pricing = require("marketPricing");
var util = require("util");
var roomSuspender = require("roomSuspender");
var memoryManager = require("memoryManager");
var creditLedger = require("creditLedger");
var TRANCHE_RATIO = .25;
var MIN_TRANCHE = 2e3;
var EXTEND_TRIGGER_RATIO = .25;
var PASSIVE_STALL_TICKS = 2e4;
var PENDING_CAPTURE_TTL = 10;
var PENDING_HARD_TTL = 5e3;
var REPRICE_BUDGET_RATIO = .05;
var TOMBSTONE_TTL = 5e3;
var MANAGE_INTERVAL = 10;
var MAX_UP_REPRICES = 12;
var UP_REPRICE_GATE = 10;
var MAX_PRICE_OVER_BEST = .1;
function compactTombstone(e) {
  delete e.price;
  delete e.trancheTotal;
  delete e.repriceFees;
  delete e.job;
  delete e.jobCeiling;
  delete e.upReprices;
  delete e.lastUpRepriceTick;
  delete e.created;
  delete e.lastRemaining;
  delete e.lastProgressTick;
  delete e.passive;
  delete e.passiveSince;
  delete e.cancelRequested;
  delete e.reason;
  delete e.extendFailSince;
  delete e.capacityLockId;
  delete e.capacityOwnerId;
  delete e.capacityReserved;
  delete e.capacityFulfilled;
}

var marketBuyer = {
  getQueue: function(e) {
    if (e && typeof e.queue === "string" && e.queue) return e.queue;
    if (e && typeof e.scope === "string" && e.scope) return e.scope;
    return "default";
  },
  ensureMemory: function() {
    var e = false;
    if (!Memory.marketBuy) Memory.marketBuy = {};
    if (!Array.isArray(Memory.marketBuy.operations)) Memory.marketBuy.operations = [];
    if (!Memory.marketBuy.orders) Memory.marketBuy.orders = {};
    if (!Array.isArray(Memory.marketBuy.pending)) Memory.marketBuy.pending = [];
    if (typeof Memory.marketBuy.lastManageTick !== "number") {
      Memory.marketBuy.lastManageTick = null;
      e = true;
    }
    if (typeof Memory.marketBuy.lastCleanupTick !== "number") {
      Memory.marketBuy.lastCleanupTick = null;
      e = true;
    }
    if (Memory.marketBuy.version !== 2) {
      for (var r in Memory.marketBuy.orders) {
        var a = Memory.marketBuy.orders[r];
        if (a && (a.done || a.cancelled)) compactTombstone(a);
      }
      Memory.marketBuy.version = 2;
      e = true;
    }
    if (e) memoryManager.requestSave();
  },
  installGetResourceNeededHook: function() {
    return;
  },
  createGatherOp: function(e, r, a, t) {
    this.ensureMemory();
    return null;
  },
  getManagedOrders: function() {
    this.ensureMemory();
    return Memory.marketBuy.orders;
  },
  getManagedOrderRecords: function() {
    var e = this.getManagedOrders();
    var r = {};
    for (var a in e) {
      if (e[a] && typeof e[a] === "object") r[a] = Object.create(e[a]);
    }
    return r;
  },
  getPendingOrders: function() {
    this.ensureMemory();
    return Memory.marketBuy.pending.map(function(e) {
      return e && typeof e === "object" ? Object.create(e) : null;
    });
  },
  getOrderRecordFor: function(e, r, a, t) {
    this.ensureMemory();
    var i = Memory.marketBuy.orders;
    var o = null;
    for (var n in i) {
      var c = i[n];
      if (!c || c.room !== e || c.resource !== r) continue;
      if (a && (c.queue || "default") !== a) continue;
      if (t && c.opId !== t) continue;
      if (c.done || c.cancelled) {
        if (!o || (c.closedTick || 0) > (o.closedTick || 0)) o = c;
        continue;
      }
      return c;
    }
    var u = Memory.marketBuy.pending;
    for (var l = 0; l < u.length; l++) {
      if (u[l] && u[l].room === e && u[l].resource === r && (!a || (u[l].queue || "default") === a) && (!t || u[l].opId === t)) return u[l];
    }
    return o;
  },
  getFulfilled: function(e) {
    if (!e) return 0;
    if (e.done || e.cancelled) return e.fulfilledFinal || 0;
    if (!e.orderId) return 0;
    var r = Game.market.orders[e.orderId];
    if (!r) {
      if (typeof e.fulfilledFinal === "number") return e.fulfilledFinal;
      if (typeof e.lastRemaining === "number" && typeof e.trancheTotal === "number") {
        return Math.max(0, e.trancheTotal - e.lastRemaining);
      }
      return 0;
    }
    var a = util.getOrderRemaining(r);
    e.lastRemaining = a;
    return Math.max(0, (e.trancheTotal || 0) - a);
  },
  addRepriceFee: function(e, r) {
    this.ensureMemory();
    var a = Memory.marketBuy.orders[e];
    if (a) {
      a.feesPaid = (a.feesPaid || 0) + r;
      a.repriceFees = (a.repriceFees || 0) + r;
      memoryManager.requestSave();
    }
  },
  repriceBudgetRemaining: function(e) {
    this.ensureMemory();
    var r = Memory.marketBuy.orders[e];
    if (!r) return 0;
    var a = REPRICE_BUDGET_RATIO * r.price * r.target;
    return Math.max(0, a - (r.repriceFees || 0));
  },
  _closeRecord: function(e, r, a) {
    e.fulfilledFinal = typeof a === "number" ? a : this.getFulfilled(e);
    this._releaseCapacity(e);
    if (r) e.done = true; else e.cancelled = true;
    e.closedTick = Game.time;
    compactTombstone(e);
  },
  _releaseCapacity: function(e) {
    if (!e || !e.capacityLockId) return;
    try {
      require("storageVfs").unlockCapacity(e.capacityLockId);
    } catch (e) {}
    e.capacityLockId = null;
  },
  _touchCapacity: function(e) {
    if (!e || !e.capacityLockId) return;
    try {
      var r = require("storageVfs").touchCapacity(e.capacityLockId, require("storageVfs").TTL_QUEUED);
      if (!r.ok) e.capacityLockId = null;
    } catch (e) {}
  },
  _recordCapacityFill: function(e, r) {
    if (!e || !(r >= 0)) return;
    var a = typeof e.capacityFulfilled === "number" ? e.capacityFulfilled : 0;
    var t = Math.max(0, r - a);
    e.capacityFulfilled = r;
    if (!e.capacityLockId) return;
    try {
      var i = require("storageVfs");
      if (t > 0) {
        var o = i.reduceCapacity(e.capacityLockId, t);
        if (!o.ok || o.remainingCapacity === 0) e.capacityLockId = null;
      } else {
        this._touchCapacity(e);
      }
    } catch (e) {}
  },
  _reserveCapacityForExtension: function(e, r) {
    if (!e || !(r > 0)) return {
      ok: true
    };
    try {
      var a = require("storageVfs");
      if (e.capacityLockId) {
        var t = a.extendCapacity(e.capacityLockId, r, a.TTL_QUEUED);
        if (t.ok) {
          e.capacityReserved = (e.capacityReserved || e.trancheTotal || 0) + r;
          return t;
        }
        e.capacityLockId = null;
      }
      var i = "/rooms/" + e.room + "/terminal/" + e.resource;
      var o = e.capacityOwnerId || e.opId || e.queue || "default";
      var n = Math.max(0, (e.trancheTotal || 0) - (e.capacityFulfilled || 0));
      var c = r + n;
      var u = a.lockCapacity(i, {
        program: "marketBuy",
        ownerId: o,
        capacity: c,
        ttl: a.TTL_QUEUED
      });
      if (u.ok) {
        e.capacityLockId = u.capacityLockId;
        e.capacityOwnerId = o;
        e.capacityReserved = c;
      }
      return u;
    } catch (e) {
      return {
        ok: false,
        reason: e.message || String(e)
      };
    }
  },
  repriceUpIfNeeded: function(e) {
    if (!e || e.passive || e.done || e.cancelled) return false;
    if (!e.orderId) return false;
    var r = Game.market.orders[e.orderId];
    if (!r || r.type !== ORDER_BUY) return false;
    if (Game.time - (e.lastUpRepriceTick || e.created || 0) < UP_REPRICE_GATE) return false;
    var a = Infinity;
    if (e.job && e.job.product && (e.queue || "default") === "factory") {
      var t = pricing.breakEvenInputCeilings(e.job.product);
      var i = t ? t[e.resource] : null;
      if (typeof i !== "number" || !(i > 0)) {
        this.cancelOrderById(e.orderId, "break-even ceiling unavailable", e.opId || null);
        return false;
      }
      a = i;
    }
    if (typeof e.jobCeiling === "number" && e.jobCeiling > 0) {
      a = Math.min(a, e.jobCeiling);
    }
    // Chasing bestBid is the manipulable half of this function: one fat bid
    // pulls us up behind it. Bound the chase by the corroborated ceiling, and
    // let the lowering branch below walk a standing order back down if the
    // ceiling has already fallen underneath its price.
    var b = pricing.maxBuyPrice(e.resource);
    if (b !== null && b > 0) a = Math.min(a, b);
    if (a < .001) {
      this.cancelOrderById(e.orderId, "hard ceiling below market minimum price", e.opId || null);
      return false;
    }
    if (a < Infinity && r.price > a + 5e-4) {
      var o = Game.market.changeOrderPrice(e.orderId, Math.max(.001, a));
      if (o === OK) {
        e.price = Math.max(.001, a);
        e.lastUpRepriceTick = Game.time;
        memoryManager.requestSave();
        console.log("[MarketBuy] Lowered " + e.resource + " in " + e.room + " to hard ceiling " + e.price.toFixed(3) + " (order " + e.orderId + ")");
        return true;
      }
    }
    var n = pricing.getBook(e.resource);
    if (!n || n.bestBid === null) return false;
    var c = Math.min(n.bestBid + MAX_PRICE_OVER_BEST, a);
    if (c <= r.price + 5e-4) return false;
    if ((e.upReprices || 0) >= MAX_UP_REPRICES) {
      this.passivateOrder(e.orderId, e.job && e.job.product);
      console.log("[MarketBuy] Up-reprice cap hit for " + e.resource + " in " + e.room + " (order " + e.orderId + "). Passivating at " + r.price.toFixed(3));
      return false;
    }
    var u = pricing.FEE * (c - r.price) * util.getOrderRemaining(r);
    var l = this.repriceBudgetRemaining(e.orderId);
    if (u > l) {
      this.passivateOrder(e.orderId, e.job && e.job.product);
      console.log("[MarketBuy] Up-reprice fee " + u.toFixed(1) + " exceeds budget " + l.toFixed(1) + " for " + e.resource + " in " + e.room + ". Passivating.");
      return false;
    }
    if (creditLedger.available() < u) return false;
    var s = Game.market.changeOrderPrice(e.orderId, c);
    if (s === OK) {
      creditLedger.commit(u);
      e.feesPaid = (e.feesPaid || 0) + u;
      e.repriceFees = (e.repriceFees || 0) + u;
      e.upReprices = (e.upReprices || 0) + 1;
      e.lastUpRepriceTick = Game.time;
      e.price = c;
      if (e.jobId) {
        try {
          require("marketEconomics").recordFee(e.jobId, "buyReprice", u);
        } catch (e) {}
      }
      memoryManager.requestSave();
      console.log("[MarketBuy] Up-repriced " + e.resource + " in " + e.room + " to " + c.toFixed(3) + " (bestBid " + n.bestBid.toFixed(3) + ", order " + e.orderId + ", cap " + MAX_UP_REPRICES + ")");
      return true;
    }
    return false;
  },
  forceRaiseToTop: function(e, r) {
    if (!e || e.done || e.cancelled) return {
      ok: false,
      reason: "inactive"
    };
    if (!e.orderId) return {
      ok: false,
      reason: "no-orderId"
    };
    var a = Game.market.orders[e.orderId];
    if (!a || a.type !== ORDER_BUY) return {
      ok: false,
      reason: "order-missing"
    };
    r = r || {};
    var t = typeof r.edge === "number" ? r.edge : MAX_PRICE_OVER_BEST;
    var i = pricing.getBook(e.resource);
    if (!i || i.bestBid === null) return {
      ok: false,
      reason: "no-competitor-bid"
    };
    var o = i.bestBid + t;
    var n = null;
    if (e.job && e.job.product && (e.queue || "default") === "factory") {
      var c = pricing.breakEvenInputCeilings(e.job.product);
      n = c ? c[e.resource] : null;
      if (typeof n !== "number" || !(n > 0)) {
        return {
          ok: false,
          reason: "no-ceiling",
          bestBid: i.bestBid,
          target: o,
          msg: "break-even ceiling unavailable for " + (e.job && e.job.product)
        };
      }
    }
    if (typeof e.jobCeiling === "number" && e.jobCeiling > 0) {
      n = typeof n === "number" && n > 0 ? Math.min(n, e.jobCeiling) : e.jobCeiling;
    }
    // Tighten only: this path still requires a break-even/job ceiling of its
    // own, and the corroborated ceiling can lower that but never supply it.
    var C = pricing.maxBuyPrice(e.resource);
    if (typeof n === "number" && n > 0 && C !== null && C > 0) n = Math.min(n, C);
    if (typeof n !== "number" || !(n > 0)) {
      return {
        ok: false,
        reason: "no-ceiling",
        bestBid: i.bestBid,
        target: o,
        msg: "no break-even ceiling or jobCeiling for " + e.resource
      };
    }
    if (o > n) {
      return {
        ok: false,
        reason: "unprofitable",
        bestBid: i.bestBid,
        target: o,
        ceiling: n,
        msg: "target " + o.toFixed(3) + " > ceiling " + n.toFixed(3) + " for " + e.resource
      };
    }
    if (o <= a.price + 5e-4) {
      return {
        ok: true,
        reason: "already-on-top",
        price: a.price,
        bestBid: i.bestBid,
        ceiling: n,
        target: o
      };
    }
    var u = pricing.FEE * (o - a.price) * util.getOrderRemaining(a);
    if (creditLedger.available() < u) {
      return {
        ok: false,
        reason: "insufficient-credits",
        target: o,
        fee: u
      };
    }
    var l = Game.market.changeOrderPrice(e.orderId, o);
    if (l !== OK) {
      return {
        ok: false,
        reason: "changeOrderPrice-failed:" + l,
        target: o,
        fee: u
      };
    }
    creditLedger.commit(u);
    e.feesPaid = (e.feesPaid || 0) + u;
    e.repriceFees = (e.repriceFees || 0) + u;
    e.upReprices = (e.upReprices || 0) + 1;
    e.lastUpRepriceTick = Game.time;
    e.price = o;
    memoryManager.requestImmediateSave("marketBuy.reprice");
    console.log("[MarketBuy] forceRaiseToTop " + e.resource + " in " + e.room + " " + a.price.toFixed(3) + " -> " + o.toFixed(3) + " (bestBid " + i.bestBid.toFixed(3) + ", ceil " + n.toFixed(3) + ", fee " + u.toFixed(1) + ", break-even ceiling)");
    return {
      ok: true,
      reason: "raised",
      from: a.price,
      to: o,
      bestBid: i.bestBid,
      ceiling: n,
      fee: u,
      target: o
    };
  },
  cancelOrderById: function(e, r, a) {
    this.ensureMemory();
    var t = Memory.marketBuy.orders[e];
    if (a && (!t || t.opId !== a)) return false;
    if (t && (t.done || t.cancelled)) {
      memoryManager.requestSave();
      return true;
    }
    var i = Game.market.cancelOrder(e);
    if (i === OK || i === ERR_INVALID_ARGS) {
      if (t) {
        this._closeRecord(t, false);
        console.log("[MarketBuy] Cancelled order " + e + " (" + t.resource + " in " + t.room + ")" + (r ? " - " + r : "") + " | filled " + t.fulfilledFinal + "/" + t.target + " | fees paid " + (t.feesPaid || 0).toFixed(1) + " (sunk)");
      } else {
        console.log("[MarketBuy] Cancelled untracked order " + e + (r ? " - " + r : ""));
      }
      memoryManager.requestSave();
      return true;
    }
    console.log("[MarketBuy] Failed to cancel order " + e + ": " + i);
    return false;
  },
  cancelOrderFor: function(e, r, a, t, i) {
    this.ensureMemory();
    var o = Memory.marketBuy.orders;
    var n = 0;
    for (var c in o) {
      var u = o[c];
      if (u && u.room === e && u.resource === r && !u.done && !u.cancelled && (!t || (u.queue || "default") === t) && (!i || u.opId === i)) {
        if (this.cancelOrderById(c, a, i)) n++;
      }
    }
    var l = Memory.marketBuy.pending;
    for (var s = 0; s < l.length; s++) {
      if (l[s] && l[s].room === e && l[s].resource === r && (!t || (l[s].queue || "default") === t) && (!i || l[s].opId === i)) {
        l[s].cancelRequested = true;
        l[s].reason = a || "cancel requested before order-id capture";
        n++;
        memoryManager.requestSave();
      }
    }
    return n;
  },
  cancelOrdersForProduct: function(e, r, a, t, i) {
    this.ensureMemory();
    var o = 0;
    var n = Memory.marketBuy.orders;
    for (var c in n) {
      var u = n[c];
      if (!u || u.room !== e || u.resource !== r || u.done || u.cancelled || i && (u.queue || "default") !== i || !u.job || u.job.product !== a) continue;
      if (this.cancelOrderById(c, t, u.opId || null)) o++;
    }
    var l = Memory.marketBuy.pending;
    for (var s = 0; s < l.length; s++) {
      var d = l[s];
      if (d && d.room === e && d.resource === r && (!i || (d.queue || "default") === i) && d.job && d.job.product === a) {
        d.cancelRequested = true;
        d.reason = t || "cancel requested before order-id capture";
        o++;
        memoryManager.requestSave();
      }
    }
    return o;
  },
  _passivate: function(e, r) {
    e.passive = true;
    e.passiveSince = Game.time;
    if (r) e.job = r;
    console.log("[MarketBuy] Order " + e.orderId + " (" + e.resource + " in " + e.room + ") marked PASSIVE; cancels on break-even collapse or " + PASSIVE_STALL_TICKS + "-tick fill stall.");
  },
  markPassiveFor: function(e, r, a, t) {
    this.ensureMemory();
    var i = t || a && a.opId || null;
    var o = Memory.marketBuy.orders;
    for (var n in o) {
      var c = o[n];
      if (c && c.room === e && c.resource === r && !c.done && !c.cancelled && (!i || c.opId === i)) {
        this._passivate(c, a);
        return true;
      }
    }
    return false;
  },
  passivateOrder: function(e, r, a) {
    this.ensureMemory();
    var t = Memory.marketBuy.orders[e];
    if (!t || t.done || t.cancelled || a && t.opId !== a) return false;
    this._passivate(t, r ? {
      product: r,
      room: t.room
    } : t.job);
    return true;
  },
  getPriceRange: function(e) {
    return pricing.getRange7d(e);
  },
  computePassiveBuyPrice: function(e) {
    var r = pricing && typeof pricing.passiveBuyPrice === "function" ? pricing.passiveBuyPrice(e) : pricing.getPriceProfile(e).postedBuyPrice;
    return typeof r === "number" && r > 0 ? r : null;
  },
  computeBuyPrice: function(e) {
    return this.computePassiveBuyPrice(e);
  },
  getRoomTotalAvailable: function(e, r) {
    var a = Game.rooms[e];
    if (!a) return 0;
    var t = 0;
    if (a.terminal && a.terminal.store && a.terminal.store[r]) {
      t += a.terminal.store[r];
    }
    if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === "function") {
      t += terminalManager.getRoomAvailableOutsideTerminal(e, r) || 0;
    }
    return t;
  },
  cleanupFulfilledOrders: function() {
    this.ensureMemory();
    var e = Memory.marketBuy.orders;
    var r = 0;
    for (var a in Game.market.orders) {
      if (e[a]) continue;
      var t = Game.market.orders[a];
      if (!t) continue;
      var i = Memory.marketBuy.pending;
      var o = false;
      for (var n = 0; n < i.length; n++) {
        var c = i[n];
        if (c && t.roomName === c.room && t.resourceType === c.resource && t.created === c.createdTick && t.totalAmount === c.trancheTotal && Math.abs(t.price - c.price) < .001) {
          o = true;
          break;
        }
      }
      if (o) continue;
      if (t.type === ORDER_BUY && util.getOrderRemaining(t) === 0) {
        if (Game.market.cancelOrder(a) === OK) {
          r++;
          memoryManager.requestSave();
          console.log("[MarketBuy] Auto-cancelled fulfilled untracked order: " + a);
        }
      }
    }
    return r;
  },
  cancelGather: function(e) {
    this.ensureMemory();
    var r = Memory.marketBuy.operations;
    for (var a = r.length - 1; a >= 0; a--) {
      if (r[a] && r[a].id === e) {
        r.splice(a, 1);
        return "[MarketBuy] Cancelled gather op: " + e;
      }
    }
    return "[MarketBuy] Gather op not found: " + e;
  },
  marketBuy: function(e, r, a, t, i) {
    this.installGetResourceNeededHook();
    this.ensureMemory();
    if (!terminalManager || typeof terminalManager.validateResource !== "function" || !terminalManager.validateResource(r)) {
      return "[MarketBuy] Invalid resource type: " + r;
    }
    if (!a || a <= 0) return "[MarketBuy] Invalid amount: " + a;
    var o = Game.rooms[e];
    if (!o || !o.controller || !o.controller.my) {
      return "[MarketBuy] Invalid room: " + e + ". Must be a room you own.";
    }
    if (!o.terminal) return "[MarketBuy] Room " + e + " has no terminal.";
    var n = this.getQueue(i);
    var c = i && i.opId ? i.opId : null;
    var u = this.getOrderRecordFor(e, r, n, c);
    if (u && !u.done && !u.cancelled) {
      var l = u.orderId ? Game.market.orders[u.orderId] : null;
      var s = !!u.orderId && (!l || util.getOrderRemaining(l) === 0);
      if (s) {
        if (l && Game.market.cancelOrder(u.orderId) === OK) memoryManager.requestSave();
        this._closeRecord(u, true);
        memoryManager.requestSave();
        console.log("[MarketBuy] Reclaimed stale order for " + r + " in " + e + " (0 remaining/missing); filled " + (u.fulfilledFinal || 0) + "/" + u.target + ". Creating fresh order.");
      } else {
        return "[MarketBuy] Managed order already exists for " + r + " in " + e + " [" + n + "]" + ". Cancel it first (cancelMarketBuyOrder).";
      }
    }
    var d = t;
    if (typeof d !== "number") d = pricing.passiveBuyPrice(r);
    if (!(d > 0)) {
      return "[MarketBuy] No canonical BUY price is available for " + r + "; the market is dead and has no resolvable theoretical value.";
    }
    if (i && typeof i.ceiling === "number" && i.ceiling > 0) {
      if (i.ceiling < .001) return "[MarketBuy] Job ceiling is below the minimum market price: " + i.ceiling;
      d = Math.min(d, i.ceiling);
    }
    // Manipulation ceiling: what we are willing to pay is bounded by trade
    // history and by the median of real depth, never by the top of the book
    // alone. An automated caller (no explicit price) fails closed when no
    // source corroborates a price at all -- an uncorroborated book is exactly
    // the state in which a single order dictates the price.
    var P = pricing.buyPriceCeiling(r);
    if (P && P.ceiling > 0) {
      if (d > P.ceiling) {
        // passiveBuyPrice already falls back to the corroborated reference,
        // so anything still above the ceiling here is a caller-supplied
        // number. Honour the intent, capped hard.
        console.log("[MarketBuy] Capping the requested " + r + " BUY price in " + e + " at " + P.ceiling.toFixed(3) + " (asked " + d.toFixed(3) + "; " + P.source + " reference " + P.reference.toFixed(3) + ")");
        d = P.ceiling;
      }
    } else if (typeof t === "number" && t > 0) {
      console.log("[MarketBuy] WARNING: no corroborated price evidence for " + r + " in " + e + "; posting the caller-supplied price " + d.toFixed(3) + ".");
    } else {
      return "[MarketBuy] Refusing to post a BUY for " + r + " in " + e + " at " + d.toFixed(3) + ": no corroborated price evidence (trade history, ask depth, and bid depth all fail the evidence test). Pass an explicit price to override.";
    }
    d = Math.round(d * 1e3) / 1e3;
    if (d < .001) d = .001;
    var m = Math.min(a, Math.max(MIN_TRANCHE, Math.ceil(a * TRANCHE_RATIO)));
    var f = pricing.FEE * d * m;
    if (creditLedger.available() < f) {
      return "[MarketBuy] Insufficient credits for BUY order fee: need " + f.toFixed(1) + ", have " + creditLedger.available().toFixed(1) + " (" + creditLedger.committedThisTick().toFixed(1) + " committed this tick)";
    }
    var p = Memory.marketBuy.pending;
    for (var y = 0; y < p.length; y++) {
      var g = p[y];
      if (g && g.room === e && g.resource === r && g.createdTick === Game.time && g.trancheTotal === m && Math.abs(g.price - d) < .001) {
        return "[MarketBuy] Identical BUY order is already pending capture this tick; retry next tick.";
      }
    }
    var v = null;
    var k = c || n;
    try {
      const a = require("storageVfs");
      const t = a.lockCapacity("/rooms/" + e + "/terminal/" + r, {
        program: "marketBuy",
        ownerId: k,
        capacity: m,
        ttl: a.TTL_QUEUED
      });
      if (!t.ok) {
        return "[MarketBuy] Cannot reserve terminal capacity for " + r + " in " + e + ": " + t.reason;
      }
      v = t.capacityLockId;
    } catch (a) {
      return "[MarketBuy] Cannot reserve terminal capacity for " + r + " in " + e + ": " + (a.message || a);
    }
    var M = {
      room: e,
      resource: r,
      queue: n,
      opId: c,
      target: a,
      price: d,
      trancheTotal: m,
      feesPaid: f,
      repriceFees: 0,
      job: i || null,
      jobCeiling: i && typeof i.ceiling === "number" && i.ceiling > 0 ? i.ceiling : null,
      jobId: i && i.jobId ? i.jobId : null,
      upReprices: 0,
      lastUpRepriceTick: 0,
      createdTick: Game.time,
      orderId: null,
      capacityLockId: v,
      capacityOwnerId: k,
      capacityReserved: m
    };
    Memory.marketBuy.pending.push(M);
    memoryManager.requestImmediateSave("marketBuy.createOrder.pending");
    var h = Game.market.createOrder({
      type: ORDER_BUY,
      resourceType: r,
      price: d,
      totalAmount: m,
      roomName: e
    });
    if (h !== OK) {
      if (v) {
        try {
          require("storageVfs").unlockCapacity(v);
        } catch (e) {}
      }
      var B = Memory.marketBuy.pending.indexOf(M);
      if (B !== -1) Memory.marketBuy.pending.splice(B, 1);
      memoryManager.requestImmediateSave("marketBuy.createOrder.rejected");
      return "[MarketBuy] Failed to create BUY order: " + h + " (room " + e + ", " + r + " x " + m + " @ " + d + ")";
    }
    creditLedger.commit(f);
    if (i && i.jobId) {
      try {
        require("marketEconomics").recordFee(i.jobId, "buyCreate", f);
      } catch (e) {}
    }
    return "[MarketBuy] Created BUY order from " + e + ": tranche " + m + "/" + a + " " + r + " @ " + d.toFixed(3) + " (fee " + (pricing.FEE * d * m).toFixed(1) + ", extends on fills; id captured next tick)" + (i ? " [job: " + i.product + (i.jobId ? " " + i.jobId : "") + "]" : "");
  },
  createBuyOrder: function(e, r, a, t, i) {
    var o = i ? {
      product: i.product || null,
      room: e,
      queue: i.queue || i.scope,
      opId: i.opId || null,
      ceiling: i.ceiling,
      jobId: i.jobId || null
    } : null;
    var n = this.marketBuy(e, r, a, t, o);
    var c = typeof n === "string" && n.indexOf("Created BUY order") >= 0;
    return {
      ok: c,
      orderId: null,
      message: n
    };
  },
  run: function() {
    this.installGetResourceNeededHook();
    this.ensureMemory();
    this._resolvePendingCaptures();
    var e = Memory.marketBuy;
    var r = e.lastManageTick === null || e.lastManageTick > Game.time || Game.time - e.lastManageTick >= MANAGE_INTERVAL;
    var a = e.lastCleanupTick === null || e.lastCleanupTick > Game.time || Game.time - e.lastCleanupTick >= 100;
    if (r) {
      this._manageOrders();
      e.lastManageTick = Game.time;
      memoryManager.requestSave();
    }
    if (a) {
      this._cleanupGatherOps();
      this.cleanupFulfilledOrders();
      e.lastCleanupTick = Game.time;
      memoryManager.requestSave();
    }
  },
  _resolvePendingCaptures: function() {
    var e = Memory.marketBuy.pending;
    if (e.length === 0) return;
    var r = Memory.marketBuy.orders;
    for (var a = e.length - 1; a >= 0; a--) {
      var t = e[a];
      if (!t) {
        e.splice(a, 1);
        continue;
      }
      var i = [];
      for (var o in Game.market.orders) {
        if (r[o]) continue;
        var n = Game.market.orders[o];
        if (!n || n.type !== ORDER_BUY) continue;
        if (n.resourceType !== t.resource || n.roomName !== t.room) continue;
        if (typeof n.created !== "number" || n.created !== t.createdTick) continue;
        if (typeof n.totalAmount !== "number" || n.totalAmount !== t.trancheTotal) continue;
        if (Math.abs(n.price - t.price) >= .001) continue;
        i.push(n);
      }
      var c = i.length === 1 ? i[0] : null;
      if (c) {
        var u = 0;
        for (var l = 0; l < e.length; l++) {
          var s = e[l];
          if (s && s.room === c.roomName && s.resource === c.resourceType && s.createdTick === c.created && s.trancheTotal === c.totalAmount && Math.abs(s.price - c.price) < .001) u++;
        }
        if (u !== 1) c = null;
      }
      if (c) {
        r[c.id] = {
          orderId: c.id,
          room: t.room,
          resource: t.resource,
          queue: t.queue || "default",
          opId: t.opId || null,
          target: t.target,
          price: c.price,
          trancheTotal: t.trancheTotal,
          feesPaid: t.feesPaid,
          repriceFees: t.repriceFees,
          job: t.job,
          jobCeiling: t.jobCeiling || null,
          jobId: t.jobId || null,
          upReprices: t.upReprices || 0,
          lastUpRepriceTick: t.lastUpRepriceTick || 0,
          created: t.createdTick,
          lastRemaining: util.getOrderRemaining(c),
          lastProgressTick: Game.time,
          capacityLockId: t.capacityLockId || null,
          capacityOwnerId: t.capacityOwnerId || t.opId || t.queue || "default",
          capacityReserved: t.capacityReserved || t.trancheTotal || 0,
          capacityFulfilled: 0,
          passive: false,
          done: false,
          cancelled: false,
          cancelRequested: !!t.cancelRequested,
          reason: t.reason || null
        };
        e.splice(a, 1);
        memoryManager.requestSave();
        console.log("[MarketBuy] Captured order id " + c.id + " for " + t.resource + " in " + t.room + " [" + (t.queue || "default") + "]");
        if (t.cancelRequested) this.cancelOrderById(c.id, t.reason, t.opId || null);
      } else if (Game.time - t.createdTick > PENDING_HARD_TTL) {
        console.log("[MarketBuy] Dropping unresolved capture metadata for " + t.resource + " in " + t.room + " after " + PENDING_HARD_TTL + " ticks with no matching live order.");
        this._releaseCapacity(t);
        e.splice(a, 1);
        memoryManager.requestSave();
      } else if (Game.time - t.createdTick > PENDING_CAPTURE_TTL) {
        var d = [];
        for (var m in Game.market.orders) {
          if (r[m]) continue;
          var f = Game.market.orders[m];
          if (!f || f.type !== ORDER_BUY) continue;
          if (f.resourceType !== t.resource || f.roomName !== t.room) continue;
          d.push(m + " created " + f.created + " vs " + t.createdTick + ", total " + f.totalAmount + " vs " + t.trancheTotal + ", price " + f.price + " vs " + t.price);
        }
        if (d.length === 0 && Game.time - t.createdTick > PENDING_CAPTURE_TTL * 3) {
          console.log("[MarketBuy] Dropping phantom capture stub for " + t.resource + " in " + t.room + " (age " + (Game.time - t.createdTick) + "): no live order exists; the createOrder intent failed after returning OK.");
          this._releaseCapacity(t);
          e.splice(a, 1);
          memoryManager.requestSave();
        } else if (!t.lastCaptureWarning || Game.time - t.lastCaptureWarning >= 1e3) {
          t.lastCaptureWarning = Game.time;
          memoryManager.requestSave();
          console.log("[MarketBuy] WARNING: pending id capture remains unresolved for " + t.resource + " in " + t.room + " (age " + (Game.time - t.createdTick) + "); near-miss untracked orders [live vs stub]: " + d.join(" | "));
        }
      }
    }
  },
  _manageOrders: function() {
    var e = Memory.marketBuy.orders;
    for (var r in e) {
      var a = e[r];
      if (!a) {
        delete e[r];
        continue;
      }
      if (a.done || a.cancelled) {
        if (Game.time - (a.closedTick || 0) > TOMBSTONE_TTL) delete e[r];
        continue;
      }
      if (a.cancelRequested) {
        this.cancelOrderById(r, a.reason, a.opId || null);
        continue;
      }
      var t = Game.market.orders[r];
      if (!t) {
        if (!a.cancelled && !a.done) {
          console.log("[MarketBuy] Order " + r + " (" + a.resource + " in " + a.room + ") no longer exists; closing record. Filled ~" + Math.max(0, (a.trancheTotal || 0) - (a.lastRemaining || 0)) + "/" + a.target);
          var i = Math.max(0, (a.trancheTotal || 0) - (a.lastRemaining || 0));
          this._closeRecord(a, false, i);
        }
        memoryManager.requestSave();
        continue;
      }
      var o = util.getOrderRemaining(t);
      if (o !== a.lastRemaining) {
        a.lastRemaining = o;
        a.lastProgressTick = Game.time;
      }
      a.price = t.price;
      var n = Math.max(0, a.trancheTotal - o);
      this._recordCapacityFill(a, n);
      this._touchCapacity(a);
      if (n >= a.target) {
        console.log("[MarketBuy] Order " + r + " COMPLETE: " + n + "/" + a.target + " " + a.resource + " in " + a.room + " | total fees " + (a.feesPaid || 0).toFixed(1));
        if (Game.market.cancelOrder(r) === OK) memoryManager.requestSave();
        this._closeRecord(a, true);
        a.fulfilledFinal = n;
        memoryManager.requestSave();
        continue;
      }
      if (roomSuspender.shouldAvoidRoomWork(a.room)) continue;
      if (!a.passive && a.trancheTotal < a.target) {
        var c = Math.max(MIN_TRANCHE, Math.ceil(a.target * TRANCHE_RATIO));
        if (o <= Math.ceil(c * EXTEND_TRIGGER_RATIO)) {
          var u = Math.min(c, a.target - a.trancheTotal);
          if (u > 0) {
            var l = pricing.FEE * t.price * u;
            var s = a.trancheTotal;
            var d = creditLedger.available() >= l ? this._reserveCapacityForExtension(a, u) : {
              ok: false,
              reason: "insufficient credits"
            };
            var m = d.ok ? Game.market.extendOrder(r, u) : creditLedger.available() >= l ? ERR_FULL : ERR_NOT_ENOUGH_RESOURCES;
            if (m === OK) {
              creditLedger.commit(l);
              a.trancheTotal += u;
              a.feesPaid = (a.feesPaid || 0) + l;
              a.extendFailSince = null;
              if (a.jobId) {
                try {
                  require("marketEconomics").recordFee(a.jobId, "buyExtend", l);
                } catch (e) {}
              }
              memoryManager.requestSave();
              console.log("[MarketBuy] Extended order " + r + " by " + u + " (" + a.resource + ", fee " + l.toFixed(1) + "); capacity " + a.trancheTotal + "/" + a.target);
            } else {
              if (d.ok && a.capacityLockId) {
                try {
                  var f = require("storageVfs").resizeCapacity(a.capacityLockId, s, require("storageVfs").TTL_QUEUED);
                  if (f.ok) {
                    a.capacityReserved = s;
                  } else {
                    require("storageVfs").unlockCapacity(a.capacityLockId);
                    a.capacityLockId = null;
                  }
                } catch (e) {}
              }
              if (!a.extendFailSince) {
                a.extendFailSince = Game.time;
                console.log("[MarketBuy] WARNING: extendOrder failed for " + r + " (" + a.resource + " in " + a.room + "): " + m + " - will close as partial-done if still failing in 1000 ticks");
              } else if (Game.time - a.extendFailSince > 1e3 && o === 0) {
                console.log("[MarketBuy] Order " + r + " stuck (extend failing " + m + ", 0 remaining); closing as partial: " + Math.max(0, a.trancheTotal - o) + "/" + a.target);
                if (Game.market.cancelOrder(r) === OK) memoryManager.requestSave();
                this._closeRecord(a, true);
                memoryManager.requestSave();
                continue;
              }
            }
          }
        }
      }
      this.repriceUpIfNeeded(a);
      if (a.passive) {
        var p = null;
        if (Game.time - (a.lastProgressTick || a.passiveSince || a.created) > PASSIVE_STALL_TICKS) {
          p = "passive fill stall (" + PASSIVE_STALL_TICKS + " ticks, no progress)";
        } else if (a.job && a.job.product && (a.queue || "default") === "factory") {
          var y = pricing.breakEvenInputCeilings(a.job.product);
          var g = y ? y[a.resource] : null;
          if (typeof g === "number" && g > 0 && typeof a.jobCeiling === "number" && a.jobCeiling > 0) {
            g = Math.min(g, a.jobCeiling);
          }
          if (typeof g !== "number" || !(g > 0) || t.price > g) {
            p = "passive break-even collapse (price " + t.price.toFixed(3) + " vs ceiling " + (typeof g === "number" ? g.toFixed(3) : "none") + ")";
          }
        }
        if (p) this.cancelOrderById(r, p);
      }
    }
  },
  _cleanupGatherOps: function() {
    var e = Memory.marketBuy.operations;
    if (e.length > 0) e.splice(0, e.length);
  },
  status: function() {
    this.ensureMemory();
    var e = [ "=== MARKET BUY (managed orders) ===" ];
    var r = Memory.marketBuy.orders;
    var a = false;
    for (var t in r) {
      var i = r[t];
      if (!i) continue;
      a = true;
      if (i.done || i.cancelled) {
        e.push("  " + t + " | " + i.resource + " in " + i.room + " [" + (i.queue || "default") + "]" + " | " + (i.done ? "DONE" : "CANCELLED") + " filled " + (i.fulfilledFinal || 0) + "/" + i.target + " | fees " + (i.feesPaid || 0).toFixed(1) + " | tombstone");
        continue;
      }
      var o = Game.market.orders[t];
      var n = o ? Math.max(0, i.trancheTotal - util.getOrderRemaining(o)) : "?";
      e.push("  " + t + " | " + i.resource + " in " + i.room + " [" + (i.queue || "default") + "]" + " | " + n + "/" + i.target + " @ " + i.price.toFixed(3) + " | capacity " + i.trancheTotal + " | fees " + (i.feesPaid || 0).toFixed(1) + (i.passive ? " | PASSIVE since " + i.passiveSince : "") + (i.job ? " | job: " + i.job.product : ""));
    }
    if (!a) e.push("  (none)");
    var c = Memory.marketBuy.pending;
    if (c.length > 0) e.push("  pending id capture: " + c.length);
    var u = Memory.marketBuy.operations;
    if (u.length > 0) e.push("  gather ops: " + u.length);
    console.log(e.join("\n"));
    return "[MarketBuy] Status printed.";
  }
};
global.marketBuy = function(e, r, a, t, i) {
  return marketBuyer.marketBuy(e, r, a, t, i);
};
global.marketBuyStatus = function() {
  return marketBuyer.status();
};
global.cancelMarketBuyOrder = function(e, r) {
  if (r !== undefined) {
    var a = marketBuyer.cancelOrderFor(e, r, "console");
    return "[MarketBuy] Cancelled " + a + " order(s) for " + r + " in " + e;
  }
  return marketBuyer.cancelOrderById(e, "console") ? "[MarketBuy] Cancelled " + e : "[MarketBuy] Cancel failed for " + e;
};
global.cancelMarketBuyGather = function(e) {
  marketBuyer.ensureMemory();
  var r = Memory.marketBuy.operations;
  for (var a = r.length - 1; a >= 0; a--) {
    if (r[a] && r[a].id === e) {
      r.splice(a, 1);
      return "[MarketBuy] Cancelled gather op: " + e;
    }
  }
  return "[MarketBuy] Gather op not found: " + e;
};
//   marketBuyForceRaiseToTop('W1N1', 'H')
//   marketBuyForceRaiseToTop('W1N1', 'H', {edge: 0.2})
global.marketBuyForceRaiseToTop = function(e, r, a) {
  marketBuyer.ensureMemory();
  var t = Memory.marketBuy.orders;
  for (var i in t) {
    var o = t[i];
    if (o && o.room === e && o.resource === r && !o.done && !o.cancelled) {
      return marketBuyer.forceRaiseToTop(o, a);
    }
  }
  return {
    ok: false,
    reason: "no-live-order",
    msg: "No live managed order for " + r + " in " + e
  };
};
module.exports = marketBuyer;
