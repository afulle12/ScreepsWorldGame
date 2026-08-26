// LLM: Read docs/codex.js before reviewing or changing this file.
// marketSell.js
// Console globals: marketSell, marketSellStatus, cancelMarketSellGather, marketSellCleanup, marketSellReconcile, marketSellDedupe
// Example: marketSell('E1N1', RESOURCE_LEMERGIUM, 5000, 0.2) - Place or fulfill market sell order
// Example: marketSellStatus('E1N1') - Display active market sell orders and fulfillment
// Example: cancelMarketSellGather('E1N1') - Cancel gathering operations for sell order
// Example: marketSellCleanup('E1N1') - Clean up expired or completed market sell orders
// Example: marketSellReconcile('E1N1') - Reconcile sell order quantities against terminal stock
// Example: marketSellDedupe('E1N1') - Deduplicate overlapping sell orders for room
//   marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000)  Post at the canonical
//     market price profile. If E1S1 already has an active SELL order for
//     zynthium, extends the most competitive existing order instead of
//     duplicating. Dead commodity markets use a recipe-derived theoretical
//     sell value when resolvable; never priced from an unrelated average.
//   marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000, 2.75)  Post at a fixed
//     price. The fixed price only applies when creating a new order --
//     existing room/resource orders keep their current price and are
//     extended/deduped.
//   marketSell('E1S1', 'Everything')  Scans terminal + storage for all
//     resources (except energy), skips any with an active SELL order in
//     the room, creates orders for the full available amount.
//   marketSellDedupe() / marketSellDedupe('E1S1') /
//     marketSellDedupe('E1S1', RESOURCE_ZYNTHIUM)  One-time cleanup for
//     duplicate active SELL orders: groups by room+resource, keeps the
//     lowest-price order, extends it by the duplicates' remaining amount,
//     cancels the duplicates.
//   marketSellStatus(room?, resource?)  Inspect managed sell requests.
//   localRefine battery output may pass { liquidate: true } to use the
//     live external BUY book instead of waiting indefinitely at the ask.
//   marketSellReconcile(), marketSellCleanup(), cancelMarketSellGather(id)
//     are maintenance commands.
//   autoTraderSellPolicy.js defines optional minimum prices; every sell
//     order routed through this module is clamped to those floors, and
//     live owned orders are repaired during the periodic run (active
//     oneTimePriceAdjustment orders are excluded from that repair).
var terminalManager = require("terminalManager");
var pricing = require("marketPricing");
var util = require("util");
var storageManager = require("storageManager");
var memoryManager = require("memoryManager");
var creditLedger = require("creditLedger");
var autoTraderSellPolicy = require("autoTraderSellPolicy");
var labCommodityPolicy = require("labCommodityPolicy");
var STALE_OWNED_LOT_ORDER_TICKS = 1e4;
var STALE_UNSUPPLIED_BATTERY_ORDER_TICKS = 1e4;
var STALE_TERMINAL_GATHER_TICKS = 1e3;
var reservationBatchDepth = 0;
var reservationBatchPrimed = false;
var reservationBatchDirty = false;
var reservationBatchCleaned = false;
function compactRequest(e) {
  return memoryManager.compactMarketSellRequest(e);
}

function isArbitrageOwnedOrder(e) {
  if (!e || !Memory.marketArbitrage) return false;
  var r = Memory.marketArbitrage;
  var t = r.operations || {};
  for (var a in t) {
    if (t[a] && t[a].sellOrderId === e) return true;
  }
  var i = r.selfArbPending || {};
  for (var o in i) {
    if (i[o] && i[o].ourSellOrderId === e) return true;
  }
  return !!(r.accountOp && r.accountOp.sellOrderId === e);
}

function applyBestBidGap(e, r) {
  if (pricing && typeof pricing.applyBestBidGap === "function") {
    return pricing.applyBestBidGap(e, r);
  }
  return r;
}

var EXTRA_ALLOWED_RESOURCES = [ RESOURCE_OPS ];
var marketSeller = {
  ensureMemory: function() {
    var e = false;
    if (!Memory.marketSell) {
      Memory.marketSell = {
        v: 2,
        requests: []
      };
      e = true;
    } else if (!Array.isArray(Memory.marketSell.requests)) {
      Memory.marketSell.requests = [];
      e = true;
    }
    for (var r = 0; r < Memory.marketSell.requests.length; r++) {
      if (!Memory.marketSell.requests[r] || Memory.marketSell.requests[r].__marketSellRequest) continue;
      Memory.marketSell.requests[r] = compactRequest(Memory.marketSell.requests[r]);
      e = true;
    }
    if (Memory.marketSell.v !== 2) {
      Memory.marketSell.v = 2;
      e = true;
    }
    if (Memory.marketSell.operations !== undefined) {
      delete Memory.marketSell.operations;
      e = true;
    }
    if (e) memoryManager.requestSave();
  },
  getRequests: function() {
    this.ensureMemory();
    return Memory.marketSell.requests.map(function(e) {
      return e && typeof e === "object" ? Object.create(e) : null;
    });
  },
  isExtraAllowed: function(e) {
    for (var r = 0; r < EXTRA_ALLOWED_RESOURCES.length; r++) {
      if (EXTRA_ALLOWED_RESOURCES[r] === e) return true;
    }
    return false;
  },
  cancelZeroRemainingSellOrders: function() {
    if (!Game.market || !Game.market.orders) return 0;
    var e = 0;
    var r = Game.market.orders;
    for (var t in r) {
      var a = r[t];
      if (!a) continue;
      if (a.type !== ORDER_SELL) continue;
      if ((typeof a.remainingAmount === "number" || typeof a.amount === "number") && util.getOrderRemaining(a) === 0) {
        var i = Game.market.cancelOrder(t);
        if (i === OK) e++;
      }
    }
    return e;
  },
  cancelStaleOwnedLotOrders: function() {
    if (!Game.market || !Game.market.orders) return 0;
    var e = 0;
    var r = require("marketEconomics");
    var t = r && typeof r.getOrderLots === "function" ? r.getOrderLots() : {};
    for (var a in t) {
      var i = t[a];
      var o = i && typeof i.lastTick === "number" ? i.lastTick : 0;
      if (!i || !Array.isArray(i.lots) || Game.time - o < STALE_OWNED_LOT_ORDER_TICKS) continue;
      var n = false;
      for (var l = 0; l < i.lots.length; l++) {
        if (i.lots[l] && i.lots[l].jobId && i.lots[l].remaining > 0) {
          n = true;
          break;
        }
      }
      if (!n) continue;
      var s = Game.market.orders[a];
      if (!s || s.type !== ORDER_SELL || !(util.getOrderRemaining(s) > 0)) continue;
      if (Game.market.cancelOrder(a) === OK) {
        e++;
        console.log("[MarketSell] Cancelled stale owned-lot order " + a + " after " + (Game.time - o) + " ticks without activity.");
      }
    }
    return e;
  },
  cancelStaleUnsuppliedBatteryOrders: function() {
    this.ensureMemory();
    if (!Game.market || !Game.market.orders) return 0;
    var e = 0;
    var r = Memory.marketSell.requests;
    for (var t = r.length - 1; t >= 0; t--) {
      var a = r[t];
      if (!a || a.resourceType !== RESOURCE_BATTERY || !a.orderId) continue;
      if (Game.time - (a.created || Game.time) < STALE_UNSUPPLIED_BATTERY_ORDER_TICKS) continue;
      if (a.tmOpId && !this._isTransferReady(a)) continue;
      var i = Game.market.orders[a.orderId];
      if (!i || !(util.getOrderRemaining(i) > 0)) continue;
      var o = Game.rooms[a.roomName];
      var n = o && o.terminal && o.terminal.store ? o.terminal.store[a.resourceType] || 0 : 0;
      var l = util.getOrderRemaining(i);
      if (n >= l || i.active !== false) continue;
      var s = storageManager.storageFind(a.roomName, a.resourceType);
      var m = 0;
      if (s) {
        m += s.terminal && s.terminal.reserved || 0;
        m += s.storage && s.storage.reserved || 0;
      }
      if (m >= l) continue;
      if (Game.market.cancelOrder(a.orderId) !== OK) continue;
      this.cancelRequestTransfer(a);
      r.splice(t, 1);
      e++;
      console.log("[MarketSell] Cancelled stale unsupplied battery order " + a.orderId + " in " + a.roomName + " after " + (Game.time - (a.created || Game.time)) + " ticks.");
    }
    if (e > 0) {
      this.syncReservations();
      memoryManager.requestImmediateSave("marketSell.cancelStaleBattery");
    }
    return e;
  },
  repairUnstagedBatteryOrders: function() {
    this.ensureMemory();
    if (!Game.market || !Game.market.orders) return 0;
    var e = 0;
    var r = Memory.marketSell.requests;
    for (var t = 0; t < r.length; t++) {
      var a = r[t];
      if (!a || a.resourceType !== RESOURCE_BATTERY || !a.orderId) continue;
      var i = Game.market.orders[a.orderId];
      if (!i || !(util.getOrderRemaining(i) > 0)) continue;
      var o = Game.rooms[a.roomName];
      if (!o || !o.terminal || !o.storage) continue;
      var n = o.terminal.store && o.terminal.store[RESOURCE_BATTERY] || 0;
      var l = Math.max(0, util.getOrderRemaining(i) - n);
      if (!(l > 0)) continue;
      var s = false;
      if (a.tmOpId && Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) {
        for (var m = 0; m < Memory.terminalManager.operations.length; m++) {
          var d = Memory.terminalManager.operations[m];
          if (!d || d.id !== a.tmOpId) continue;
          s = d.status !== "completed" && d.status !== "failed";
          break;
        }
      }
      if (s) continue;
      storageManager.unReserve(a.roomName, RESOURCE_BATTERY, "storage", "marketSell");
      delete a.tmOpId;
      var u = this.scheduleTerminalCoverage(a.roomName, RESOURCE_BATTERY, {
        need: l,
        unreservedInTerminal: n
      });
      if (u && u.tmOpId) {
        a.tmOpId = u.tmOpId;
        e++;
        console.log("[MarketSell] Staged " + l + " battery for inactive order " + a.orderId + " in " + a.roomName + " via " + u.tmOpId + ".");
      }
    }
    if (e > 0) memoryManager.requestImmediateSave("marketSell.repairBatteryCoverage");
    return e;
  },
  getRoomTotalAvailable: function(e, r) {
    var t = Game.rooms[e];
    if (!t) return 0;
    var a = 0;
    var i = t.terminal;
    if (i && i.store && i.store[r]) {
      a += i.store[r];
    }
    if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === "function") {
      a += terminalManager.getRoomAvailableOutsideTerminal(e, r) || 0;
    }
    var o = storageManager.storageFind(e, r);
    if (o && o.combined && typeof o.combined.reserved === "number") {
      a = Math.max(0, a - o.combined.reserved);
    }
    return a;
  },
  getReservationSummary: function(e, r) {
    var t = storageManager.storageFind(e, r);
    var a = {};
    var i = t ? [ t.terminal, t.storage ] : [];
    for (var o = 0; o < i.length; o++) {
      var n = i[o] && i[o].reservations;
      if (!Array.isArray(n)) continue;
      for (var l = 0; l < n.length; l++) {
        var s = n[l];
        if (!s || !s.program || !(s.amount > 0)) continue;
        a[s.program] = (a[s.program] || 0) + s.amount;
      }
    }
    var m = Object.keys(a).sort();
    var d = [];
    for (var u = 0; u < m.length; u++) {
      d.push(m[u] + "=" + a[m[u]]);
    }
    return d.join(", ");
  },
  getRoomUnlistedAvailable: function(e, r) {
    var t = this.getRoomTotalAvailable(e, r);
    var a = this.getExistingSellReservations(e, r);
    var i = storageManager.storageFind(e, r);
    var o = 0;
    var n = i ? [ i.terminal, i.storage ] : [];
    for (var l = 0; l < n.length; l++) {
      var s = n[l] && n[l].reservations;
      if (!Array.isArray(s)) continue;
      for (var m = 0; m < s.length; m++) {
        if (s[m] && s[m].program === "marketSell") {
          o += s[m].amount || 0;
        }
      }
    }
    var d = 0;
    var u = Memory.marketSell && Memory.marketSell.requests || [];
    for (var c = 0; c < u.length; c++) {
      var f = u[c];
      if (f && !f.orderId && f.created === Game.time && f.roomName === e && f.resourceType === r) {
        a += f.amount || 0;
      }
    }
    var v = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
    var g = {};
    for (var p = 0; p < u.length; p++) {
      var y = u[p];
      if (!y || y.roomName !== e || y.resourceType !== r || !y.tmOpId) continue;
      for (var h = 0; h < v.length; h++) {
        var S = v[h];
        if (!S || S.id !== y.tmOpId || S.status === "completed" || S.status === "failed" || !S.reservationProgram || g[S.reservationProgram]) continue;
        g[S.reservationProgram] = true;
        for (var M = 0; M < n.length; M++) {
          var k = n[M] && n[M].reservations;
          if (!Array.isArray(k)) continue;
          for (var O = 0; O < k.length; O++) {
            if (k[O] && k[O].program === S.reservationProgram) {
              d += k[O].amount || 0;
            }
          }
        }
        break;
      }
    }
    var R = Math.min(a, o + d);
    return Math.max(0, t - Math.max(0, a - R));
  },
  raiseOrdersToFloor: function(e, r, t) {
    if (!e || e.length === 0 || !(r > 0)) {
      return {
        error: null,
        raised: 0,
        fee: 0
      };
    }
    r = Math.max(.001, Math.round(r * 1e3) / 1e3);
    var a = 0;
    for (var i = 0; i < e.length; i++) {
      var o = e[i] && e[i].order;
      if (o && labCommodityPolicy.isTwoLetterLabProduct(o.resourceType)) continue;
      if (!o || typeof o.price !== "number" || o.price + 5e-4 >= applyBestBidGap(o.resourceType, r)) continue;
      var n = applyBestBidGap(o.resourceType, r);
      a += pricing.FEE * (n - o.price) * util.getOrderRemaining(o);
    }
    if (a > 0 && creditLedger.available() < a) {
      return {
        error: "[MarketSell] Insufficient credits to raise SELL orders to floor " + r.toFixed(3) + ": need " + a.toFixed(1) + ", have " + creditLedger.available().toFixed(1) + " available this tick",
        raised: 0,
        fee: 0
      };
    }
    var l = 0;
    var s = 0;
    for (var m = 0; m < e.length; m++) {
      var d = e[m];
      var u = d && d.order;
      if (u && labCommodityPolicy.isTwoLetterLabProduct(u.resourceType)) continue;
      if (!u || typeof u.price !== "number" || u.price + 5e-4 >= applyBestBidGap(u.resourceType, r)) continue;
      var c = u.price;
      var n = applyBestBidGap(u.resourceType, r);
      var f = Game.market.changeOrderPrice(d.id, n);
      if (f !== OK) {
        return {
          error: "[MarketSell] Could not raise SELL order " + d.id + " from " + c.toFixed(3) + " to floor " + n.toFixed(3) + ": " + f,
          raised: l,
          fee: s
        };
      }
      var v = pricing.FEE * (n - c) * util.getOrderRemaining(u);
      if (v > 0) {
        creditLedger.commit(v);
        s += v;
        if (t) {
          try {
            require("marketEconomics").recordFee(t, "sellReprice", v);
          } catch (e) {}
        }
      }
      u.price = n;
      l++;
      console.log("[MarketSell] Raised SELL order " + d.id + " from " + c.toFixed(3) + " to configured floor " + n.toFixed(3));
    }
    return {
      error: null,
      raised: l,
      fee: s
    };
  },
  enforcePriceFloors: function(e) {
    if (!autoTraderSellPolicy.hasConfiguredFloors()) return {
      scanned: 0,
      raised: 0,
      skipped: 0
    };
    var r = this.getActiveOwnedSellOrders();
    var t = null;
    try {
      t = require("marketPriceAdjustment");
    } catch (e) {}
    var a = {};
    var i = 0;
    for (var o = 0; o < r.length; o++) {
      var n = r[o];
      if (n && n.order && labCommodityPolicy.isTwoLetterLabProduct(n.order.resourceType)) continue;
      if (t && typeof t.isOneTimePriceAdjustmentOrder === "function" && t.isOneTimePriceAdjustmentOrder(n.id)) continue;
      var l = autoTraderSellPolicy.getFloor(n.order.resourceType);
      if (!(l > 0)) continue;
      i++;
      if (n.order.price + 5e-4 >= l) continue;
      var s = n.order.resourceType + "|" + l;
      if (!a[s]) a[s] = {
        floor: l,
        entries: []
      };
      a[s].entries.push(n);
    }
    var m = 0;
    var d = 0;
    for (var s in a) {
      var u = this.raiseOrdersToFloor(a[s].entries, a[s].floor, e);
      m += u.raised || 0;
      if (u.error) d += a[s].entries.length - (u.raised || 0);
    }
    return {
      scanned: i,
      raised: m,
      skipped: d
    };
  },
  computePrice: function(e) {
    var r = pricing && typeof pricing.getPriceProfile === "function" ? pricing.getPriceProfile(e) : null;
    var t = r ? r.postedSellPrice : pricing.passiveSellPrice(e);
    if (!(typeof t === "number" && t > 0) && r && r.marketPrice > 0) {
      t = r.marketPrice;
    }
    if (!(typeof t === "number" && t > 0)) {
      if (autoTraderSellPolicy && typeof autoTraderSellPolicy.getFloor === "function") {
        t = autoTraderSellPolicy.getFloor(e);
      }
      if (!(typeof t === "number" && t > 0) && pricing && typeof pricing.getDerivedSellFloor === "function") {
        t = pricing.getDerivedSellFloor(e);
      }
      if (!(typeof t === "number" && t > 0) && pricing && typeof pricing.getSubstantialBuyPrice === "function") {
        t = pricing.getSubstantialBuyPrice(e);
      }
    }
    if (!(typeof t === "number" && t > 0)) return null;
    return applyBestBidGap(e, t);
  },
  getMarketSellPrice: function(e) {
    var r = this.computePrice(e);
    if (!(r > 0)) return null;
    r = autoTraderSellPolicy.applyFloor(e, r);
    r = applyBestBidGap(e, r);
    r = Math.round(r * 1e3) / 1e3;
    return r >= .001 ? r : .001;
  },
  computeLiquidationPrice: function(e, r, t) {
    if (pricing && typeof pricing.executableSellQuote === "function") {
      var a = pricing.executableSellQuote(e, r, t);
      if (a && a.price > 0) return a.price;
    }
    if (pricing && typeof pricing.getPriceProfile === "function") {
      var i = pricing.getPriceProfile(e);
      if (i && i.sellLiquidity === "deep" && i.sellPrice > 0) return i.sellPrice;
    }
    return null;
  },
  repriceExistingOrders: function(e, r, t) {
    if (!e || e.length === 0 || !(r > 0)) return null;
    r = Math.max(.001, Math.round(r * 1e3) / 1e3);
    var a = 0;
    for (var i = 0; i < e.length; i++) {
      var o = e[i] && e[i].order;
      if (o && labCommodityPolicy.isTwoLetterLabProduct(o.resourceType)) continue;
      if (!o || typeof o.price !== "number") continue;
      var n = r;
      if (n > o.price + 5e-4) {
        a += pricing.FEE * (n - o.price) * util.getOrderRemaining(o);
      }
    }
    if (a > 0 && creditLedger.available() < a) {
      return "[MarketSell] Insufficient credits to reprice liquidation orders: need " + a.toFixed(1) + ", have " + creditLedger.available().toFixed(1);
    }
    for (var l = 0; l < e.length; l++) {
      var s = e[l];
      var m = s && s.order;
      if (m && labCommodityPolicy.isTwoLetterLabProduct(m.resourceType)) continue;
      if (!m || typeof m.price !== "number" || Math.abs(m.price - r) <= 5e-4) continue;
      var n = r;
      var d = Game.market.changeOrderPrice(s.id, n);
      if (d !== OK) {
        return "[MarketSell] Could not reprice liquidation order " + s.id + " to " + r + ": " + d;
      }
      if (n > m.price + 5e-4) {
        var u = pricing.FEE * (n - m.price) * util.getOrderRemaining(m);
        if (u > 0) {
          creditLedger.commit(u);
          if (t) {
            try {
              require("marketEconomics").recordFee(t, "sellReprice", u);
            } catch (e) {}
          }
        }
      }
      console.log("[MarketSell] Repriced liquidation order " + s.id + " from " + m.price.toFixed(3) + " to " + r.toFixed(3));
      m.price = n;
    }
    return null;
  },
  markLiquidationOrders: function(e) {
    if (!e || e.length === 0) return;
    for (var r = 0; r < e.length; r++) {
      var t = e[r];
      if (!t || !t.order) continue;
      var a = this.ensureRequestForOrder(t.id, t.order, null);
      if (a) a.liquidate = true;
    }
    memoryManager.requestSave();
  },
  getExistingSellReservations: function(e, r) {
    var t = 0;
    var a = Game.market && Game.market.orders ? Game.market.orders : null;
    if (!a) return 0;
    for (var i in a) {
      var o = a[i];
      if (!o) continue;
      if (o.type !== ORDER_SELL) continue;
      if (o.roomName !== e) continue;
      if (o.resourceType !== r) continue;
      var n = util.getOrderRemaining(o);
      if (!(n > 0)) continue;
      t += n;
    }
    return t;
  },
  tryLinkLocalOp: function(e, r, t) {
    if (!Memory.terminalManager || !Array.isArray(Memory.terminalManager.operations)) return null;
    var a = Memory.terminalManager.operations;
    for (var i = 0; i < a.length; i++) {
      var o = a[i];
      if (!o) continue;
      if (o.type !== "toTerminal") continue;
      if (o.roomName !== e) continue;
      if (o.resourceType !== r) continue;
      if (o.amount !== t) continue;
      if (o.created !== Game.time) continue;
      return o.id;
    }
    return null;
  },
  findOrderId: function(e, r, t, a) {
    if (!Game.market || !Game.market.orders) return null;
    var i = Game.market.orders;
    for (var o in i) {
      var n = i[o];
      if (!n) continue;
      if (n.type !== ORDER_SELL) continue;
      if (n.roomName !== e) continue;
      if (n.resourceType !== r) continue;
      if (typeof n.totalAmount !== "number") continue;
      if (n.totalAmount !== t) continue;
      if (typeof a === "number") {
        if (typeof n.created !== "number") continue;
        if (n.created !== a) continue;
      }
      return o;
    }
    return null;
  },
  getActiveOwnedSellOrders: function(e, r) {
    var t = [];
    if (!Game.market || !Game.market.orders) return t;
    for (var a in Game.market.orders) {
      var i = Game.market.orders[a];
      if (!i || i.type !== ORDER_SELL) continue;
      if (!(util.getOrderRemaining(i) > 0)) continue;
      if (e && i.roomName !== e) continue;
      if (r && i.resourceType !== r) continue;
      var o = Game.rooms[i.roomName];
      if (!o || !o.controller || !o.controller.my) continue;
      t.push({
        id: a,
        order: i
      });
    }
    return t;
  },
  chooseMostCompetitiveSellOrder: function(e) {
    if (!e || e.length === 0) return null;
    var r = e[0];
    for (var t = 1; t < e.length; t++) {
      var a = e[t];
      var i = typeof r.order.price === "number" ? r.order.price : Infinity;
      var o = typeof a.order.price === "number" ? a.order.price : Infinity;
      if (o < i) {
        r = a;
        continue;
      }
      if (o > i) continue;
      var n = util.getOrderRemaining(r.order);
      var l = util.getOrderRemaining(a.order);
      if (l > n) {
        r = a;
        continue;
      }
      if (l < n) continue;
      var s = typeof r.order.created === "number" ? r.order.created : 0;
      var m = typeof a.order.created === "number" ? a.order.created : 0;
      if (m > s) r = a;
    }
    return r;
  },
  adoptExistingCoverage: function(e, r, t, a, i, o) {
    if (!(t > 0) || !o || o.length === 0) return null;
    a = Math.max(0, Math.min(t, a || 0));
    var n = t - a;
    if (!(n > 0)) return null;
    var l = storageManager.storageFind(e, r);
    var s = l ? [ l.terminal, l.storage ] : [];
    var m = 0;
    for (var d = 0; d < s.length; d++) {
      var u = s[d] && s[d].reservations;
      if (!Array.isArray(u)) continue;
      for (var c = 0; c < u.length; c++) {
        var f = u[c];
        if (f && f.program !== "marketSell") {
          m += f.amount || 0;
        }
      }
    }
    if (m > 0) return null;
    var v = o.filter(function(e) {
      return e && e.order && util.getOrderRemaining(e.order) >= n;
    });
    while (v.length > 0) {
      var g = this.chooseMostCompetitiveSellOrder(v);
      if (!g) break;
      var p = Memory.marketSell && Memory.marketSell.requests || [];
      var y = null;
      for (var h = 0; h < p.length; h++) {
        if (p[h] && p[h].orderId === g.id && p[h].tmOpId && !this._isTransferReady(p[h])) {
          y = {
            tmOpId: p[h].tmOpId
          };
          break;
        }
      }
      if (y && a > 0) {
        return "[MarketSell] Existing " + e + "/" + r + " terminal gather is still pending; retry extension after it completes.";
      }
      var S = pricing.FEE * (g.order && g.order.price || 0) * a;
      if (S > 0 && creditLedger.available() < S) {
        return "[MarketSell] Insufficient credits to extend existing SELL order: need " + S.toFixed(1) + ", have " + creditLedger.available().toFixed(1) + " available this tick";
      }
      var M = !i;
      var k = null;
      if (i) {
        try {
          var O = require("marketEconomics").claimUnownedSellLot(g.id, i, n);
          M = !!(O && O.claimed === n);
          k = O && O.reason;
        } catch (e) {
          k = String(e);
        }
      }
      if (M) {
        var R = util.getOrderRemaining(g.order);
        if (a > 0) {
          var T = Game.market.extendOrder(g.id, a);
          if (T !== OK) {
            if (i) {
              try {
                require("marketEconomics").releaseClaimedSellLot(g.id, i, n);
              } catch (e) {}
            }
            return "[MarketSell] Failed to extend existing SELL order for combined coverage: " + T;
          }
          creditLedger.commit(S);
          if (i) {
            try {
              var I = require("marketEconomics");
              I.attachSellLot(g.id, i, a);
              if (S > 0) I.recordFee(i, "sellExtend", S);
            } catch (e) {}
          }
        }
        try {
          var E = y;
          if (!E) {
            var b = Game.rooms[e];
            var A = b && b.storage && b.storage.store ? b.storage.store[r] || 0 : 0;
            var L = b && b.terminal && b.terminal.store ? b.terminal.store[r] || 0 : 0;
            var q = R + a;
            var x = Math.max(0, q - L);
            var G = Math.min(A, x);
            if (G > 0) {
              storageManager.unReserve(e, r, "storage", "marketSell");
              E = this.scheduleTerminalCoverage(e, r, {
                need: G,
                unreservedInTerminal: 0
              });
            }
          }
          var P = Game.market.orders && Game.market.orders[g.id] || g.order;
          var F = this.ensureRequestForOrder(g.id, P, E);
          if (F && a > 0) {
            var N = Math.max(0, util.getOrderRemaining(P) - R);
            var C = Math.max(0, a - N);
            if (C > 0) {
              F.pendingExtendAmount = (F.pendingExtendAmount || 0) + C;
              F.pendingExtendTick = Game.time;
              memoryManager.requestImmediateSave("marketSell.extendOrder");
            }
          }
          this.syncReservations();
        } catch (e) {
          console.log("[MarketSell] Existing-coverage bookkeeping warning for " + g.id + ": " + e);
          try {
            this.syncReservations();
          } catch (e) {}
        }
        return "[MarketSell] Produced stock covered existing " + e + "/" + r + " order" + (a > 0 ? " and extended it by " + a : " without extension") + " | orderId " + g.id + (i ? " | jobLot " + i : "");
      }
      v = v.filter(function(e) {
        return e.id !== g.id;
      });
      if (k && v.length === 0) {
        return "[MarketSell] Existing " + e + "/" + r + " coverage could not be assigned to " + i + ": " + k;
      }
    }
    return null;
  },
  planTerminalCoverage: function(e, r, t) {
    var a = storageManager.storageFind(e, r);
    var i = a && a.terminal ? Math.max(0, a.terminal.available || 0) : 0;
    var o = this.getRoomTotalAvailable(e, r);
    var n = Math.max(0, o - i);
    var l = Math.min(t, i + n);
    var s = Math.max(0, l - i);
    return {
      need: s,
      unreservedInTerminal: i
    };
  },
  scheduleTerminalCoverage: function(e, r, t) {
    var a = t && typeof t.need === "number" ? t.need : 0;
    var i = null;
    var o = false;
    if (a > 0) {
      if (typeof terminalManager.storageToTerminal === "function") {
        terminalManager.storageToTerminal(e, r, a);
        i = this.tryLinkLocalOp(e, r, a);
        o = true;
      } else {
        console.log("[MarketSell] Warning: terminalManager.storageToTerminal not available.");
      }
    }
    return {
      need: a,
      tmOpId: i,
      needsTransfer: o,
      unreservedInTerminal: t ? t.unreservedInTerminal : 0
    };
  },
  repairStaleTerminalCoverage: function() {
    this.ensureMemory();
    var e = Memory.marketSell.requests;
    var r = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
    var t = 0;
    for (var a = 0; a < e.length; a++) {
      var i = e[a];
      if (!i || !i.orderId) continue;
      var o = Game.market && Game.market.orders ? Game.market.orders[i.orderId] : null;
      if (!o || !(util.getOrderRemaining(o) > 0)) continue;
      var n = Game.rooms[i.roomName];
      var l = n && n.terminal;
      var s = l && l.store ? l.store[i.resourceType] || 0 : 0;
      var m = util.getOrderRemaining(o);
      var d = null;
      if (i.tmOpId) {
        for (var u = 0; u < r.length; u++) {
          if (r[u] && r[u].id === i.tmOpId) {
            d = r[u];
            break;
          }
        }
      }
      var c = false;
      if (i.tmOpId) {
        if (!d || d.status === "failed") {
          c = true;
        } else if (d.status !== "completed") {
          c = terminalManager && typeof terminalManager.isOperationStale === "function" ? terminalManager.isOperationStale(d, STALE_TERMINAL_GATHER_TICKS) : Game.time - (d.created || Game.time) >= STALE_TERMINAL_GATHER_TICKS;
        }
      } else if (o.active === false || s < m) {
        c = true;
      }
      if (!c) continue;
      if (d && terminalManager && typeof terminalManager.cancelOperation === "function") {
        terminalManager.cancelOperation(d.id);
      }
      var f = n;
      var v = f && f.terminal;
      var g = v && v.store ? v.store[i.resourceType] || 0 : 0;
      var p = util.getOrderRemaining(o);
      var y = Math.max(0, p - g);
      delete i.tmOpId;
      t++;
      if (!(y > 0)) continue;
      storageManager.unReserve(i.roomName, i.resourceType, "storage", "marketSell");
      var h = storageManager.storageFind(i.roomName, i.resourceType);
      var S = h && h.storage ? Math.max(0, h.storage.available || 0) : 0;
      var M = Math.min(y, S);
      if (!(M > 0)) continue;
      var k = this.scheduleTerminalCoverage(i.roomName, i.resourceType, {
        need: M,
        unreservedInTerminal: g
      });
      if (k && k.tmOpId) {
        i.tmOpId = k.tmOpId;
        console.log("[MarketSell] Re-staged " + M + " " + i.resourceType + " for " + i.roomName + "/" + i.resourceType + " order " + i.orderId + " via " + k.tmOpId + " after stale terminal gather recovery.");
      }
    }
    if (t > 0) {
      memoryManager.requestImmediateSave("marketSell.repairTerminalCoverage");
    }
    return t;
  },
  removeRequestsForOrderIds: function(e) {
    this.ensureMemory();
    var r = 0;
    var t = Memory.marketSell.requests;
    var a = [];
    for (var i = 0; i < t.length; i++) {
      var o = t[i];
      if (o && o.orderId && e[o.orderId]) {
        if (o.tmOpId && terminalManager && typeof terminalManager.cancelOperation === "function") {
          terminalManager.cancelOperation(o.tmOpId);
        }
        r++;
        continue;
      }
      a.push(o);
    }
    Memory.marketSell.requests = a;
    if (r > 0) memoryManager.requestSave();
    return r;
  },
  cancelRequestTransfer: function(e) {
    if (!e || !e.tmOpId || !terminalManager || typeof terminalManager.cancelOperation !== "function") return;
    terminalManager.cancelOperation(e.tmOpId);
  },
  ensureRequestForOrder: function(e, r, t) {
    this.ensureMemory();
    if (!e || !r) return null;
    var a = Memory.marketSell.requests;
    var i = null;
    var o = [];
    for (var n = 0; n < a.length; n++) {
      var l = a[n];
      if (!l || l.orderId !== e) {
        o.push(l);
        continue;
      }
      if (!i) {
        i = l;
        o.push(l);
      } else if (!i.tmOpId && l.tmOpId) {
        i.tmOpId = l.tmOpId;
      } else if (l.tmOpId && l.tmOpId !== i.tmOpId) {
        this.cancelRequestTransfer(l);
      }
    }
    Memory.marketSell.requests = o;
    var s = typeof r.totalAmount === "number" ? r.totalAmount : typeof r.amount === "number" ? r.amount : r.remainingAmount;
    if (!i) {
      i = {
        roomName: r.roomName,
        resourceType: r.resourceType,
        amount: s,
        created: typeof r.created === "number" ? r.created : Game.time,
        orderId: e
      };
      i = compactRequest(i);
      Memory.marketSell.requests.push(i);
    } else {
      i.roomName = r.roomName;
      i.resourceType = r.resourceType;
      i.amount = s;
      i.orderId = e;
    }
    if (t && t.tmOpId) {
      i.tmOpId = t.tmOpId;
    }
    memoryManager.requestImmediateSave("marketSell.syncOrder");
    return i;
  },
  consolidateSellOrders: function(e, r, t, a, i) {
    this.ensureMemory();
    var o = this.getActiveOwnedSellOrders(e, r);
    var n = {};
    var l;
    for (var s = 0; s < o.length; s++) {
      var m = o[s];
      l = m.order.roomName + ":" + m.order.resourceType;
      if (!n[l]) n[l] = [];
      n[l].push(m);
    }
    var d = {
      groupsScanned: 0,
      groupsDeduped: 0,
      ordersCanceled: 0,
      amountConsolidated: 0,
      amountAdded: 0,
      existingAmountBeforeAdd: 0,
      requestEntriesRemoved: 0,
      failures: []
    };
    for (l in n) {
      var u = n[l];
      if (!u || u.length === 0) continue;
      d.groupsScanned++;
      var c = l.split(":");
      var f = c[0];
      var v = c[1];
      var g = t && e === f && r === v ? t : 0;
      if (u.length <= 1 && g <= 0) continue;
      var p = this.chooseMostCompetitiveSellOrder(u);
      if (!p) continue;
      var y = 0;
      var h = {};
      for (var S = 0; S < u.length; S++) {
        if (u[S].id === p.id) continue;
        if (i) continue;
        var M = util.getOrderRemaining(u[S].order);
        h[u[S].id] = M;
        y += M;
      }
      var k = y + g;
      var O = pricing.FEE * (p.order && p.order.price || 0) * k;
      if (k > 0 && creditLedger.available() < O) {
        d.failures.push(f + "/" + v + ": extendOrder(" + p.id + ", " + k + ") skipped - fee " + O.toFixed(1) + " exceeds credits available this tick");
        continue;
      }
      var R = 0;
      var T = 0;
      var I = {};
      for (var E in h) {
        var b = Game.market.cancelOrder(E);
        if (b === OK) {
          I[E] = true;
          T += h[E] || 0;
          R++;
        } else {
          d.failures.push(f + "/" + v + ": cancelOrder(" + E + ") failed " + b);
        }
      }
      var A = T + g;
      var L = false;
      var q = 0;
      if (A > 0) {
        var x = pricing.FEE * (p.order && p.order.price || 0) * A;
        var G = p.order ? util.getOrderRemaining(p.order) : 0;
        var P = Game.market.extendOrder(p.id, A);
        if (P !== OK) {
          d.failures.push(f + "/" + v + ": extendOrder(" + p.id + ", " + A + ") failed " + P);
        } else {
          creditLedger.commit(x);
          d.amountConsolidated += T;
          d.amountAdded += g;
          if (g > 0) d.existingAmountBeforeAdd = G + T;
          L = true;
          var F = Game.market.orders && Game.market.orders[p.id];
          var N = F ? Math.max(0, util.getOrderRemaining(F) - G) : 0;
          q = Math.max(0, A - N);
          for (var C in I) {
            try {
              require("marketEconomics").moveSellLots(C, p.id);
            } catch (e) {}
          }
        }
      }
      d.ordersCanceled += R;
      if (R > 0 || L && g > 0) d.groupsDeduped++;
      d.requestEntriesRemoved += this.removeRequestsForOrderIds(I);
      var B = this.ensureRequestForOrder(p.id, p.order, a);
      if (L && B && q > 0) {
        B.pendingExtendAmount = (B.pendingExtendAmount || 0) + q;
        B.pendingExtendTick = Game.time;
        memoryManager.requestImmediateSave("marketSell.extendOrder");
      }
    }
    this.syncReservations();
    return d;
  },
  formatDedupeSummary: function(e) {
    var r = "[MarketSell] Dedupe scanned " + e.groupsScanned + " group(s), deduped " + e.groupsDeduped + ", canceled " + e.ordersCanceled + " duplicate order(s), consolidated " + e.amountConsolidated + " unit(s)";
    if (e.amountAdded > 0) r += ", added " + e.amountAdded + " unit(s)";
    if (e.requestEntriesRemoved > 0) r += ", removed " + e.requestEntriesRemoved + " stale request(s)";
    if (e.failures.length > 0) r += ", failures: " + e.failures.join("; ");
    return r;
  },
  getResourcesWithActiveSellOrders: function(e) {
    var r = {};
    var t = Game.market && Game.market.orders ? Game.market.orders : null;
    if (!t) return r;
    for (var a in t) {
      var i = t[a];
      if (!i) continue;
      if (i.type !== ORDER_SELL) continue;
      if (i.roomName !== e) continue;
      if (!(util.getOrderRemaining(i) > 0)) continue;
      r[i.resourceType] = true;
    }
    return r;
  },
  getRoomResourceList: function(e) {
    var r = Game.rooms[e];
    if (!r) return [];
    var t = {};
    var a = r.terminal;
    if (a && a.store) {
      for (var i in a.store) {
        if (i === RESOURCE_ENERGY) continue;
        if (a.store[i] > 0) {
          t[i] = true;
        }
      }
    }
    var o = r.storage;
    if (o && o.store) {
      for (var n in o.store) {
        if (n === RESOURCE_ENERGY) continue;
        if (o.store[n] > 0) {
          t[n] = true;
        }
      }
    }
    var l = [];
    for (var s in t) {
      l.push(s);
    }
    l.sort();
    return l;
  },
  sellEverything: function(e) {
    this.cleanup();
    var r = Game.rooms[e];
    if (!r || !r.controller || !r.controller.my) {
      return "[MarketSell] Invalid room: " + e + ". Must be a room you own.";
    }
    if (!r.terminal) {
      return "[MarketSell] Room " + e + " has no terminal.";
    }
    var t = this.getResourcesWithActiveSellOrders(e);
    var a = this.getRoomResourceList(e);
    var i = [];
    var o = 0;
    var n = 0;
    var l = 0;
    this.beginReservationBatch(true);
    try {
      for (var s = 0; s < a.length; s++) {
        var m = a[s];
        if (t[m]) {
          n++;
          continue;
        }
        var d = terminalManager && typeof terminalManager.validateResource === "function" && terminalManager.validateResource(m);
        if (!d && !this.isExtraAllowed(m)) {
          l++;
          continue;
        }
        if (labCommodityPolicy.isTwoLetterLabProduct(m)) {
          l++;
          continue;
        }
        var u = this.getRoomTotalAvailable(e, m);
        if (u <= 0) continue;
        var c = this.marketSell(e, m, u);
        i.push(c);
        if (c.indexOf("Created SELL order") !== -1) {
          o++;
        }
      }
    } finally {
      this.endReservationBatch();
    }
    var f = "[MarketSell] sellEverything(" + e + "): " + o + " orders created";
    if (n > 0) f += ", " + n + " skipped (already selling)";
    if (l > 0) f += ", " + l + " skipped (invalid resource type)";
    console.log(f);
    for (var v = 0; v < i.length; v++) {
      console.log("  " + i[v]);
    }
    return f;
  },
  //           marketSell('ROOM#', 'Everything')
  marketSell: function(e, r, t, a, i) {
    if (r === "Everything") {
      return this.sellEverything(e);
    }
    var o = i && i.jobId ? i.jobId : null;
    if (labCommodityPolicy.isTwoLetterLabProduct(r)) {
      return "[MarketSell] Two-letter lab product " + r + " requires conversion or an opportunistic live-bid sale.";
    }
    if (reservationBatchDepth > 0) {
      if (!reservationBatchCleaned) {
        this.cleanup();
        reservationBatchCleaned = true;
      }
    } else {
      this.cleanup();
    }
    this.cancelStaleUnsuppliedBatteryOrders();
    var n = terminalManager && typeof terminalManager.validateResource === "function" && terminalManager.validateResource(r);
    if (!n && !this.isExtraAllowed(r)) {
      return "[MarketSell] Invalid resource type: " + r;
    }
    if (!t || t <= 0) {
      return "[MarketSell] Invalid amount: " + t;
    }
    var l = Game.rooms[e];
    if (!l || !l.controller || !l.controller.my) {
      return "[MarketSell] Invalid room: " + e + ". Must be a room you own.";
    }
    var s = l.terminal;
    if (!s) {
      return "[MarketSell] Room " + e + " has no terminal.";
    }
    this.syncReservations();
    var m = this.getActiveOwnedSellOrders(e, r);
    var d = null;
    try {
      d = require("marketPriceAdjustment");
    } catch (e) {}
    var u = [];
    for (var c = 0; c < m.length; c++) {
      var f = m[c];
      if (d && typeof d.isOneTimePriceAdjustmentOrder === "function" && d.isOneTimePriceAdjustmentOrder(f.id)) continue;
      u.push(f);
    }
    var v = autoTraderSellPolicy.getFloor(r);
    if (i && typeof i.minPrice === "number" && isFinite(i.minPrice) && i.minPrice > 0) {
      v = Math.max(v, i.minPrice);
    }
    if (i && typeof i.priceFloor === "number" && isFinite(i.priceFloor) && i.priceFloor > 0) {
      v = Math.max(v, i.priceFloor);
    }
    if (i && i.repriceOnly) {
      if (u.length === 0) {
        return "[MarketSell] No active SELL order to reprice for " + e + "/" + r;
      }
      var g = typeof a === "number" && a > 0 ? a : this.computeLiquidationPrice(r, t, e);
      if (!(g > 0)) {
        return "[MarketSell] No executable BUY-side price is available for liquidation of " + r;
      }
      this.markLiquidationOrders(u);
      g = autoTraderSellPolicy.applyFloor(r, Math.max(g, v));
      var p = this.repriceExistingOrders(u, g, o);
      if (p) return p;
      this.syncReservations();
      return "[MarketSell] Repriced " + e + "/" + r + " liquidation order(s) to " + g.toFixed(3);
    }
    if (i && i.liquidate && u.length > 0) {
      var y = typeof a === "number" && a > 0 ? a : this.computeLiquidationPrice(r, t, e);
      if (!(y > 0)) {
        return "[MarketSell] No executable BUY-side price is available for liquidation of " + r;
      }
      this.markLiquidationOrders(u);
      y = autoTraderSellPolicy.applyFloor(r, Math.max(y, v));
      var h = this.repriceExistingOrders(u, y, o);
      if (h) return h;
      a = y;
    }
    if (u.length > 0 && !(i && i.liquidate)) {
      var S = v;
      if (typeof a === "number" && a > 0) {
        S = Math.max(S, Math.max(.001, Math.round(a * 1e3) / 1e3));
      }
      var M = this.raiseOrdersToFloor(u, S, o);
      if (M.error) return M.error;
    }
    if (i && i.allowExistingCoverage && u.length > 1) {
      this.consolidateSellOrders(e, r, 0, null, false);
      u = this.getActiveOwnedSellOrders(e, r);
    }
    var k = u.length > 0 ? this.getRoomUnlistedAvailable(e, r) : this.getRoomTotalAvailable(e, r);
    if (k < t) {
      if (i && i.allowExistingCoverage && u.length > 0) {
        var O = this.adoptExistingCoverage(e, r, t, k, o, u);
        if (O) return O;
      }
      var R = this.getReservationSummary(e, r);
      return "[MarketSell] Not enough " + r + " in room " + e + " to cover order: have " + k + " available (after reservations) / " + t + " needed" + (R ? " | reservations: " + R : "");
    }
    if (u.length > 0) {
      var T = 0;
      for (var I = 0; I < u.length; I++) {
        T += util.getOrderRemaining(u[I].order);
      }
      var E = storageManager.storageFind(e, r);
      var b = l.terminal && l.terminal.store ? l.terminal.store[r] || 0 : 0;
      var A = E && E.storage ? E.storage.total || 0 : 0;
      var L = 0;
      var q = E && E.storage ? E.storage.reservations || [] : [];
      for (var x = 0; x < q.length; x++) {
        if (q[x] && q[x].program !== "marketSell") {
          L += q[x].amount || 0;
        }
      }
      var G = {
        need: Math.min(Math.max(0, A - L), Math.max(0, T + t - b)),
        unreservedInTerminal: b
      };
      var P = false;
      if (G.need > 0) {
        var F = Memory.marketSell && Memory.marketSell.requests || [];
        for (var N = 0; N < F.length; N++) {
          var C = F[N];
          if (!C || !C.tmOpId || this._isTransferReady(C)) continue;
          for (var B = 0; B < u.length; B++) {
            if (C.orderId === u[B].id) {
              return "[MarketSell] Existing " + e + "/" + r + " terminal gather is still pending; retry extension after it completes.";
            }
          }
        }
      }
      var _ = this.consolidateSellOrders(e, r, t, null, true);
      var D = this.formatDedupeSummary(_);
      if (_.amountAdded > 0) {
        if (G.need > 0) {
          storageManager.unReserve(e, r, "storage", "marketSell");
        }
        var w = this.scheduleTerminalCoverage(e, r, G);
        var j = this.getActiveOwnedSellOrders(e, r);
        var U = this.chooseMostCompetitiveSellOrder(j);
        if (U) {
          this.ensureRequestForOrder(U.id, U.order, w);
          this.syncReservations();
        }
        if (o && U && _.amountAdded > 0) {
          try {
            var K = require("marketEconomics");
            K.seedUnownedSellLot(U.id, Math.max(0, _.existingAmountBeforeAdd || 0));
            if (K.attachSellLot(U.id, o, _.amountAdded)) {
              P = true;
            }
            var Y = pricing.FEE * (U.order && U.order.price || 0) * _.amountAdded;
            if (Y > 0) K.recordFee(o, "sellExtend", Y);
          } catch (e) {}
        }
        D += " | extended existing " + e + "/" + r + " order instead of creating a duplicate";
        if (w.need > 0) {
          D += " | scheduled to move " + w.need + " into terminal" + (w.tmOpId ? " (op " + w.tmOpId + ")" : "");
        }
        if (U) {
          D += " | orderId " + U.id;
        }
        if (P) D += " | jobLot " + o;
      }
      return D;
    }
    var W = Memory.marketSell && Memory.marketSell.requests || [];
    for (var Z = 0; Z < W.length; Z++) {
      var H = W[Z];
      if (H && !H.orderId && H.roomName === e && H.resourceType === r && Game.time - (H.created || 0) <= 10) {
        return "[MarketSell] SELL order creation already pending for " + e + "/" + r + "; retry after order-id capture.";
      }
    }
    var X = a;
    if (typeof X !== "number") {
      X = i && i.liquidate ? this.computeLiquidationPrice(r, t, e) : this.computePrice(r, t, e);
    }
    if (!(X > 0) && autoTraderSellPolicy && typeof autoTraderSellPolicy.getFloor === "function") {
      X = autoTraderSellPolicy.getFloor(r);
    }
    if (!(X > 0) && pricing && typeof pricing.getDerivedSellFloor === "function") {
      X = pricing.getDerivedSellFloor(r);
    }
    if (!(X > 0)) {
      return "[MarketSell] No canonical SELL price is available for " + r + "; the market has no executable buyer or resolvable theoretical value.";
    }
    X = autoTraderSellPolicy.applyFloor(r, X);
    if (!(i && i.liquidate)) X = applyBestBidGap(r, X);
    X = Math.round(X * 1e3) / 1e3;
    if (X < .001) X = .001;
    var Q = pricing.FEE * X * t;
    if (creditLedger.available() < Q) {
      return "[MarketSell] Insufficient credits for SELL order fee: need " + Q.toFixed(1) + ", have " + creditLedger.available().toFixed(1) + " available this tick";
    }
    if (Game.market && Game.market.orders && Object.keys(Game.market.orders).length >= 300) {
      this.cancelZeroRemainingSellOrders();
    }
    var z = this.planTerminalCoverage(e, r, t);
    var J = Game.market.createOrder({
      type: ORDER_SELL,
      resourceType: r,
      price: X,
      totalAmount: t,
      roomName: e
    });
    if (J === ERR_FULL) {
      this.cancelZeroRemainingSellOrders();
      J = Game.market.createOrder({
        type: ORDER_SELL,
        resourceType: r,
        price: X,
        totalAmount: t,
        roomName: e
      });
    }
    if (J !== OK) {
      return "[MarketSell] Failed to create SELL order: " + J + " (room " + e + ", " + r + " x " + t + " @ " + X + ")";
    }
    creditLedger.commit(Q);
    if (o) {
      try {
        require("marketEconomics").recordFee(o, "sellCreate", Q);
      } catch (e) {}
    }
    var V = this.scheduleTerminalCoverage(e, r, z);
    var $ = this.findOrderId(e, r, t, Game.time);
    var ee = {
      roomName: e,
      resourceType: r,
      amount: t,
      created: Game.time
    };
    if (V.tmOpId) ee.tmOpId = V.tmOpId;
    if ($) ee.orderId = $;
    if (o) ee.jobId = o;
    if (i && i.liquidate) ee.liquidate = true;
    ee = compactRequest(ee);
    Memory.marketSell.requests.push(ee);
    memoryManager.requestImmediateSave("marketSell.createOrder");
    if ($) {
      var re = false;
      try {
        var te = require("marketEconomics");
        if (o) {
          if (te.attachSellLot($, o, t)) {
            re = true;
            delete ee.jobId;
          }
        }
      } catch (e) {}
    }
    this.syncReservations();
    var ae = "[MarketSell] Created SELL order from " + e + ": " + t + " " + r + " @ " + X.toFixed(3);
    if ($) ae += " | orderId " + $;
    if (re) ae += " | jobLot " + o;
    if (V.need > 0) {
      ae += " | scheduled to move " + V.need + " into terminal" + (V.tmOpId ? " (op " + V.tmOpId + ")" : "");
      ae += " | reservation pending transfer completion";
    } else {
      ae += " | terminal already has target amount (unreserved: " + V.unreservedInTerminal + ")";
      ae += " | reservation will be placed on next sync";
    }
    return ae;
  },
  dedupe: function(e, r) {
    if (labCommodityPolicy.isTwoLetterLabProduct(r)) {
      return "[MarketSell] Restricted two-letter products are owned by labCommodityRouter.";
    }
    this.ensureMemory();
    this.enforcePriceFloors();
    var t = this.consolidateSellOrders(e, r, 0, null);
    return this.formatDedupeSummary(t);
  },
  run: function() {
    this.ensureMemory();
    this.enforcePriceFloors();
    this.cancelStaleOwnedLotOrders();
    this.reconcileOrders();
    this.cleanup();
    this.repairStaleTerminalCoverage();
    this.repairUnstagedBatteryOrders();
    this.syncReservations();
    this.cancelStaleUnsuppliedBatteryOrders();
  },
  reconcileOrders: function() {
    this.ensureMemory();
    if (!Game.market || !Game.market.orders) {
      return "[MarketSell] No market orders to reconcile.";
    }
    var e = Memory.marketSell.requests;
    var r = {};
    for (var t = 0; t < e.length; t++) {
      var a = e[t];
      if (a && a.orderId) r[a.orderId] = true;
    }
    var i = 0;
    var o = 0;
    for (var n in Game.market.orders) {
      var l = Game.market.orders[n];
      if (!l || l.type !== ORDER_SELL) continue;
      if (!(util.getOrderRemaining(l) > 0)) continue;
      if (isArbitrageOwnedOrder(n)) {
        r[n] = true;
        continue;
      }
      if (r[n]) continue;
      var s = Game.rooms[l.roomName];
      if (!s || !s.controller || !s.controller.my) continue;
      var m = typeof l.totalAmount === "number" ? l.totalAmount : typeof l.amount === "number" ? l.amount : 0;
      var d = false;
      for (var u = 0; u < e.length; u++) {
        var c = e[u];
        if (!c || c.orderId) continue;
        if (c.roomName !== l.roomName) continue;
        if (c.resourceType !== l.resourceType) continue;
        if (c.amount !== m) continue;
        c.orderId = n;
        if (c.jobId) {
          try {
            require("marketEconomics").attachSellLot(n, c.jobId, c.amount);
            delete c.jobId;
          } catch (e) {}
        }
        d = true;
        i++;
        break;
      }
      if (!d) {
        e.push(compactRequest({
          roomName: l.roomName,
          resourceType: l.resourceType,
          amount: m,
          created: typeof l.created === "number" ? l.created : Game.time,
          orderId: n
        }));
        o++;
      }
      r[n] = true;
    }
    if (o === 0 && i === 0) {
      return "[MarketSell] No orphaned marketSell orders found.";
    }
    memoryManager.requestSave();
    return "[MarketSell] Reconciled " + (o + i) + " orphaned marketSell order(s) (" + i + " attached, " + o + " added).";
  },
  beginReservationBatch: function(e) {
    if (reservationBatchDepth === 0) {
      reservationBatchPrimed = false;
      reservationBatchDirty = false;
      reservationBatchCleaned = !!e;
    }
    reservationBatchDepth++;
  },
  endReservationBatch: function() {
    if (reservationBatchDepth <= 0) return;
    reservationBatchDepth--;
    if (reservationBatchDepth > 0) return;
    var e = reservationBatchDirty;
    reservationBatchPrimed = false;
    reservationBatchDirty = false;
    reservationBatchCleaned = false;
    if (e) this.syncReservations();
  },
  syncReservations: function() {
    if (reservationBatchDepth > 0) {
      if (reservationBatchPrimed) {
        reservationBatchDirty = true;
        return;
      }
      reservationBatchPrimed = true;
    }
    var e = Memory.marketSell.requests;
    if (!e || e.length === 0) {
      this._unreserveAll();
      return;
    }
    var r = {};
    var t = {};
    for (var a = 0; a < e.length; a++) {
      var i = e[a];
      var o = 0;
      if (i.orderId) {
        if (t[i.orderId]) continue;
        t[i.orderId] = true;
        var n = Game.market && Game.market.orders ? Game.market.orders[i.orderId] : null;
        if (!n || !(util.getOrderRemaining(n) > 0)) continue;
        o = util.getOrderRemaining(n);
        if (i.pendingExtendTick === Game.time && i.pendingExtendAmount > 0) {
          o += i.pendingExtendAmount;
        } else if (i.pendingExtendTick !== undefined) {
          delete i.pendingExtendAmount;
          delete i.pendingExtendTick;
        }
      } else {
        if (Game.time - (i.created || 0) > 10 || !(i.amount > 0)) continue;
        o = i.amount;
      }
      var l = this._isTransferReady(i);
      var s = 0;
      if (!l && i.tmOpId) {
        var m = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
        var d = null;
        for (var u = 0; u < m.length; u++) {
          if (m[u] && m[u].id === i.tmOpId) {
            d = m[u].reservationProgram || null;
            break;
          }
        }
        if (d) {
          var c = storageManager.storageFind(i.roomName, i.resourceType);
          var f = c ? [ c.terminal, c.storage ] : [];
          for (var v = 0; v < f.length; v++) {
            var g = f[v] && f[v].reservations || [];
            for (var p = 0; p < g.length; p++) {
              if (g[p] && g[p].program === d) {
                s += g[p].amount || 0;
              }
            }
          }
        }
      }
      var y = Math.max(0, o - s);
      if (!(y > 0)) continue;
      var h = i.roomName + ":" + i.resourceType;
      if (!r[h]) {
        r[h] = {
          roomName: i.roomName,
          resource: i.resourceType,
          total: 0,
          reqs: []
        };
      }
      r[h].total += y;
      r[h].reqs.push(i);
    }
    var S = {};
    for (var M in r) {
      var k = r[M];
      if (k.total > 0) {
        var O = Game.rooms[k.roomName];
        var R = O && O.terminal ? O.terminal : null;
        var T = O && O.storage ? O.storage : null;
        var I = R && R.store && R.store[k.resource] ? R.store[k.resource] : 0;
        var E = T && T.store && T.store[k.resource] ? T.store[k.resource] : 0;
        var b = storageManager.storageFind(k.roomName, k.resource);
        var A = 0;
        var L = 0;
        var q = b && b.terminal && b.terminal.reservations || [];
        var x = b && b.storage && b.storage.reservations || [];
        for (var G = 0; G < q.length; G++) {
          if (q[G] && q[G].program !== "marketSell") {
            A += q[G].amount || 0;
          }
        }
        for (var P = 0; P < x.length; P++) {
          if (x[P] && x[P].program !== "marketSell") {
            L += x[P].amount || 0;
          }
        }
        var F = Math.min(k.total, Math.max(0, I - A));
        var N = Math.min(Math.max(0, k.total - F), Math.max(0, E - L));
        var C = true;
        var B = true;
        if (F > 0) {
          var _ = storageManager.reserve(k.roomName, k.resource, "terminal", "marketSell", F);
          C = !!(_ && _.ok);
          if (!C && Game.time % 100 === 0) {
            console.log("[MarketSell] Reserve warning for " + k.resource + " in " + k.roomName + " terminal: " + _.reason);
          }
          if (!C) {
            storageManager.unReserve(k.roomName, k.resource, "terminal", "marketSell");
          }
        } else {
          var D = storageManager.storageFind(k.roomName, k.resource);
          var w = false;
          if (D && D.terminal && Array.isArray(D.terminal.reservations)) {
            for (var j = 0; j < D.terminal.reservations.length; j++) {
              var U = D.terminal.reservations[j];
              if (U && U.program === "marketSell") {
                w = true;
                break;
              }
            }
          }
          if (w) storageManager.unReserve(k.roomName, k.resource, "terminal", "marketSell");
        }
        if (N > 0) {
          var K = storageManager.reserve(k.roomName, k.resource, "storage", "marketSell", N);
          B = !!(K && K.ok);
          if (!B && Game.time % 100 === 0) {
            console.log("[MarketSell] Reserve warning for " + k.resource + " in " + k.roomName + " storage: " + K.reason);
          }
          if (!B) {
            storageManager.unReserve(k.roomName, k.resource, "storage", "marketSell");
          }
        } else {
          var Y = storageManager.storageFind(k.roomName, k.resource);
          var W = false;
          if (Y && Y.storage && Array.isArray(Y.storage.reservations)) {
            for (var Z = 0; Z < Y.storage.reservations.length; Z++) {
              var H = Y.storage.reservations[Z];
              if (H && H.program === "marketSell") {
                W = true;
                break;
              }
            }
          }
          if (W) storageManager.unReserve(k.roomName, k.resource, "storage", "marketSell");
        }
        S[M] = true;
      }
    }
    this._unreserveInactive(S);
  },
  _isTransferReady: function(e) {
    if (!e.tmOpId) return true;
    var r = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
    for (var t = 0; t < r.length; t++) {
      var a = r[t];
      if (!a) continue;
      if (a.id === e.tmOpId) {
        if (a.status === "completed") return true;
        if (a.status === "failed") return true;
        return false;
      }
    }
    return true;
  },
  _unreserveInactive: function(e) {
    var r = storageManager.getReservationRecords(null, "marketSell");
    for (var t = 0; t < r.length; t++) {
      var a = r[t];
      var o = a.roomName + ":" + a.material;
      if (!e[o]) {
        storageManager.unReserve(a.roomName, a.material, a.building, "marketSell");
      }
    }
  },
  _unreserveAll: function() {
    this._unreserveInactive({});
  },
  status: function(e, r) {
    this.ensureMemory();
    this.cleanup();
    this.syncReservations();
    var t = Memory.marketSell.requests;
    var a = [];
    for (var i = 0; i < t.length; i++) {
      var o = t[i];
      if (!o) continue;
      if (e && o.roomName !== e) continue;
      if (r && o.resourceType !== r) continue;
      var n = o.orderId && Game.market && Game.market.orders ? Game.market.orders[o.orderId] : null;
      var l = n ? util.getOrderRemaining(n) : 0;
      var s = n ? n.totalAmount : typeof o.amount === "number" ? o.amount : 0;
      var m = storageManager.storageFind(o.roomName, o.resourceType);
      var d = m && m.terminal && typeof m.terminal.reserved === "number" ? m.terminal.reserved : 0;
      var u = m && m.storage && typeof m.storage.reserved === "number" ? m.storage.reserved : 0;
      var c = d + u;
      var f = Math.max(0, l - c);
      var v = "-";
      if (o.tmOpId && Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) {
        var g = Memory.terminalManager.operations;
        for (var p = 0; p < g.length; p++) {
          var y = g[p];
          if (y && y.id === o.tmOpId) {
            var h = y.amountMoved || 0;
            if (h < 0) h = 0;
            if (h > y.amount) h = y.amount;
            v = h + "/" + y.amount + " " + (y.status || "-");
            break;
          }
        }
      }
      var S = "live";
      if (!n) S = "orphan"; else if (n.active === false) S = "inactive"; else if (f > 0) S = "pending";
      a.push({
        roomName: o.roomName,
        resourceType: o.resourceType,
        orderTotal: s,
        orderRemaining: l,
        termRsv: d,
        storRsv: u,
        shortfall: f,
        price: n && typeof n.price === "number" ? n.price : "-",
        created: o.created || 0,
        age: typeof o.created === "number" && typeof Game.time === "number" ? Game.time - o.created : "-",
        orderId: o.orderId || "-",
        state: S,
        progress: v
      });
    }
    var M = [];
    var k = e ? e : "*";
    var O = r ? r : "*";
    M.push("[MarketSell] Requests room=" + k + " resource=" + O);
    if (a.length === 0) {
      M.push("  none");
      M.push("Total requests: 0");
      console.log(M.join("\n"));
      return "[MarketSell] Status printed.";
    }
    a.sort(function(e, r) {
      if (e.roomName !== r.roomName) return e.roomName < r.roomName ? -1 : 1;
      if (e.resourceType !== r.resourceType) return e.resourceType < r.resourceType ? -1 : 1;
      return (e.created || 0) - (r.created || 0);
    });
    function padRight(e, r) {
      e = String(e);
      while (e.length < r) e += " ";
      return e;
    }
    M.push("room        resource        state    remaining  total      termRsv  storRsv  shortfall  price     age   orderId");
    for (var R = 0; R < a.length; R++) {
      var T = a[R];
      M.push(padRight(T.roomName, 11) + " " + padRight(T.resourceType, 14) + " " + padRight(T.state, 8) + " " + padRight(T.orderRemaining, 10) + " " + padRight(T.orderTotal, 10) + " " + padRight(T.termRsv, 8) + " " + padRight(T.storRsv, 8) + " " + padRight(T.shortfall, 10) + " " + padRight(typeof T.price === "number" ? T.price.toFixed(3) : T.price, 8) + " " + padRight(T.age, 5) + " " + T.orderId);
      if (T.progress !== "-" || T.state !== "live") {
        M.push("  " + T.progress);
      }
    }
    M.push("Total requests: " + a.length);
    console.log(M.join("\n"));
    return "[MarketSell] Status printed.";
  },
  cancelGather: function(e) {
    this.ensureMemory();
    var r = Memory.marketSell.requests;
    for (var t = r.length - 1; t >= 0; t--) {
      var a = r[t];
      if (a && (a.orderId === e || a.tmOpId === e)) {
        if (a.tmOpId && terminalManager && typeof terminalManager.cancelOperation === "function") {
          terminalManager.cancelOperation(a.tmOpId);
        }
        r.splice(t, 1);
        memoryManager.requestSave();
        this.syncReservations();
        return "[MarketSell] Cancelled associated local move and removed request: " + e;
      }
    }
    return "[MarketSell] Request not found (pass an orderId or terminal op id): " + e;
  },
  cleanup: function() {
    this.ensureMemory();
    this.cancelZeroRemainingSellOrders();
    var e = Memory.marketSell.requests;
    var r = Game.market.orders;
    var t = [];
    var a = 0;
    var i = 0;
    var o = {};
    for (var n = 0; n < e.length; n++) {
      var l = e[n];
      delete l.id;
      delete l.price;
      delete l.reserved;
      delete l.needsTransfer;
      delete l.reconciled;
      if (l.created === Game.time) {
        t.push(l);
        continue;
      }
      if (!l.orderId) {
        var s = this.findOrderId(l.roomName, l.resourceType, l.amount, l.created);
        if (s) {
          l.orderId = s;
          if (l.jobId) {
            try {
              require("marketEconomics").attachSellLot(s, l.jobId, l.amount);
              delete l.jobId;
            } catch (e) {}
          }
          i++;
        } else {
          if (Game.time - (l.created || 0) > 10) {
            this.cancelRequestTransfer(l);
            a++;
            continue;
          }
          t.push(l);
          continue;
        }
      }
      var m = r[l.orderId];
      if (m && isArbitrageOwnedOrder(l.orderId)) {
        this.cancelRequestTransfer(l);
        a++;
        continue;
      }
      if (!m) {
        this.cancelRequestTransfer(l);
        a++;
        continue;
      }
      if (util.getOrderRemaining(m) <= 0) {
        this.cancelRequestTransfer(l);
        a++;
        continue;
      }
      var d = o[l.orderId];
      if (d) {
        if (!d.tmOpId && l.tmOpId) d.tmOpId = l.tmOpId; else if (l.tmOpId && l.tmOpId !== d.tmOpId) this.cancelRequestTransfer(l);
        if (!d.jobId && l.jobId) d.jobId = l.jobId;
        if ((!d.pendingExtendTick || (l.pendingExtendTick || 0) > d.pendingExtendTick) && l.pendingExtendAmount > 0) {
          d.pendingExtendAmount = l.pendingExtendAmount;
          d.pendingExtendTick = l.pendingExtendTick;
        }
        a++;
        continue;
      }
      o[l.orderId] = l;
      t.push(l);
    }
    Memory.marketSell.requests = t;
    if (a > 0 || i > 0) memoryManager.requestSave();
    if (a > 0) {
      this.syncReservations();
    }
    return "[MarketSell] Sync: Pruned " + a + " completed/invalid requests. Active: " + t.length;
  }
};
global.marketSell = function(e, r, t, a, i) {
  return marketSeller.marketSell(e, r, t, a, i);
};
global.marketSellStatus = function(e, r) {
  return marketSeller.status(e, r);
};
global.marketSellReconcile = function() {
  return marketSeller.reconcileOrders();
};
global.cancelMarketSellGather = function(e) {
  return marketSeller.cancelGather(e);
};
global.marketSellCleanup = function() {
  return marketSeller.cleanup();
};
global.marketSellDedupe = function(e, r) {
  return marketSeller.dedupe(e, r);
};
module.exports = marketSeller;
