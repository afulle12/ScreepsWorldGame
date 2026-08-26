// LLM: Read docs/codex.js before reviewing or changing this file.
// opportunisticBuy.js
// Console globals: opportunisticBuy
// Example: opportunisticBuy('status') - Run or query opportunistic market buyer
var CONFIRMATION_TIMEOUT_TICKS = 20;
var PENDING_EXPIRATION_TICKS = 1e3;
var memoryManager = require("memoryManager");
var roomSuspender = require("roomSuspender");
var util = require("util");
var creditLedger = require("creditLedger");
var marketBatchBuy = require("marketBatchBuy");
var ACCOUNT_RESOURCES = {
  pixel: true,
  cpuUnlock: true,
  accessKey: true
};
function isAccountResource(e) {
  return !!ACCOUNT_RESOURCES[e];
}

if (!Memory.opportunisticBuy) {
  Memory.opportunisticBuy = {
    requests: {}
  };
  memoryManager.requestSave();
}
var getMyRooms = util.getMyRooms;
function normalizeOpts(e) {
  if (!e) return {};
  if (typeof e === "string") return {
    queue: e
  };
  return e;
}

function requestQueue(e) {
  e = normalizeOpts(e);
  if (e && typeof e.queue === "string" && e.queue) return e.queue;
  if (e && typeof e.scope === "string" && e.scope) return e.scope;
  return null;
}

function requestKey(e, r, t) {
  var i = requestQueue(t);
  var n = e + "_" + r;
  t = normalizeOpts(t);
  if (t.opId) n = t.opId + "_" + n;
  return i ? i + "_" + n : n;
}

function requestSave() {
  if (memoryManager && typeof memoryManager.requestSave === "function") memoryManager.requestSave();
}

function requestImmediateSave(e) {
  if (memoryManager && typeof memoryManager.requestImmediateSave === "function") {
    memoryManager.requestImmediateSave(e);
  }
}

function snapshotRequest(e) {
  return e && typeof e === "object" ? Object.create(e) : null;
}

function getRequest(e, r, t) {
  var i = Memory.opportunisticBuy && Memory.opportunisticBuy.requests;
  var n = i ? i[requestKey(e, r, t)] : null;
  return snapshotRequest(n);
}

function getRequestByKey(e) {
  var r = Memory.opportunisticBuy && Memory.opportunisticBuy.requests;
  var t = r && e ? r[e] : null;
  return snapshotRequest(t);
}

function getActiveRequestEntries() {
  var e = Memory.opportunisticBuy && Memory.opportunisticBuy.requests;
  var r = [];
  if (!e) return r;
  for (var t in e) {
    if (e[t] && typeof e[t] === "object") {
      r.push({
        key: t,
        request: snapshotRequest(e[t])
      });
    }
  }
  return r;
}

function cancelRequestByKey(e) {
  var r = Memory.opportunisticBuy && Memory.opportunisticBuy.requests;
  if (!r || !r[e]) return false;
  delete r[e];
  requestSave();
  return true;
}

function fulfillRequestByKey(e, r) {
  var t = Memory.opportunisticBuy && Memory.opportunisticBuy.requests;
  var i = t && e ? t[e] : null;
  if (!i || !(r > 0)) return null;
  i.fulfilled = (i.fulfilled || 0) + r;
  i.remaining = Math.max(0, (i.remaining || 0) - r);
  i.lastProgressTick = Game.time;
  if (i.remaining <= 0) {
    delete t[e];
    requestSave();
    return null;
  }
  requestSave();
  return snapshotRequest(i);
}

function setup(e, r, t, i, n) {
  n = normalizeOpts(n);
  var o = requestKey(e, r, n);
  var a = Memory.opportunisticBuy.requests[o];
  if (a) {
    a.totalAmount = Math.max(a.totalAmount || 0, (a.fulfilled || 0) + t);
    a.remaining = Math.max(a.remaining || 0, t);
    a.maxPrice = Math.min(a.maxPrice || i, i);
    a.stopAfterPending = false;
    a.includeTransferCost = !!n.includeTransferCost;
    a.externalOnly = !!n.externalOnly;
    a.energyPrice = n.energyPrice > 0 ? n.energyPrice : null;
    if (typeof a.lastProgressTick !== "number") {
      a.lastProgressTick = a.createdAt || Game.time;
    }
    requestSave();
    return "Buy request for " + t + " " + r + " in " + e + " already active";
  }
  var u = a && typeof a.createdAt === "number" ? a.createdAt : Game.time;
  Memory.opportunisticBuy.requests[o] = {
    roomName: e,
    resourceType: r,
    totalAmount: t,
    remaining: t,
    maxPrice: i,
    lastCheck: 0,
    checkInterval: 1,
    cachedOrderId: null,
    cachedOrderRoomName: null,
    createdAt: u,
    lastProgressTick: Game.time,
    fulfilled: 0,
    queue: requestQueue(n) || "default",
    product: n.product || null,
    direction: n.direction || null,
    opId: n.opId || null,
    jobId: n.jobId || null,
    includeTransferCost: !!n.includeTransferCost,
    externalOnly: !!n.externalOnly,
    energyPrice: n.energyPrice > 0 ? n.energyPrice : null,
    pending: null
  };
  requestSave();
  var c = isAccountResource(r) ? " [ACCOUNT RESOURCE]" : "";
  var s = requestQueue(n) ? " [" + requestQueue(n) + "]" : "";
  var m = "Buy request for " + t + " " + r + " in " + e + s + " created (max " + i + " credits/unit)" + c;
  console.log("[OpportunisticBuy] " + m);
  return m;
}

function findIncomingDeal(e, r, t) {
  var i = Game.market && Game.market.incomingTransactions;
  if (!i) return null;
  for (var n = 0; n < i.length; n++) {
    var o = i[n];
    if (o.time < t.tick) break;
    if (o.to === e && o.resourceType === r && o.amount >= t.expected && o.order && o.order.id === t.orderId) {
      return o;
    }
  }
  return null;
}

function setCheckInterval(e, r, t, i) {
  var n = requestKey(e, r, i);
  var o = Memory.opportunisticBuy.requests;
  if (!o || !o[n]) {
    var a = requestQueue(i);
    var u = "No active buy request found for " + r + " in " + e + (a ? " [" + a + "]" : "");
    console.log("[OpportunisticBuy] " + u);
    return u;
  }
  if (typeof t !== "number" || t < 1) {
    var c = "Invalid checkInterval " + t + " (must be number >= 1)";
    console.log("[OpportunisticBuy] " + c);
    return c;
  }
  o[n].checkInterval = t;
  requestSave();
  var s = requestQueue(i);
  var m = "Set checkInterval for " + e + " " + r + (s ? " [" + s + "]" : "") + " to " + t + " ticks";
  console.log("[OpportunisticBuy] " + m);
  return m;
}

var capByEnergy = util.capByEnergy;
function processAccountResource(e, r, t, i) {
  var n = r.checkInterval || 1;
  if (Game.time - r.lastCheck < n) return;
  r.lastCheck = Game.time;
  function attemptAccountDeal(e) {
    var t = Game.market.getOrderById(e.id);
    if (!t || util.getOrderRemaining(t) <= 0) return false;
    if (marketBatchBuy.isOrderReserved && marketBatchBuy.isOrderReserved(e.id)) return false;
    e = t;
    var n = !!(e.roomName && i[e.roomName]);
    if (!n && !(e.price <= r.maxPrice)) return false;
    var o = creditLedger.available();
    var a = e.price > 0 ? Math.floor(o / e.price) : 0;
    if (a <= 0 && !n) {
      console.log("[OpportunisticBuy] Insufficient credits to buy " + r.resourceType + " at " + e.price + " (balance: " + Game.market.credits.toFixed(3) + ")");
      return true;
    }
    var u = util.getOrderRemaining(e);
    if (u > r.remaining) u = r.remaining;
    if (!n && u > a) u = a;
    if (u <= 0) return false;
    var c = Game.market.deal(e.id, u);
    if (c === OK) {
      var s = u * e.price;
      if (!n) creditLedger.commit(s);
      r.fulfilled = (r.fulfilled || 0) + u;
      r.remaining -= u;
      r.lastProgressTick = Game.time;
      r.cachedOrderId = e.id;
      r.cachedOrderRoomName = e.roomName;
      requestImmediateSave("opportunisticBuy.accountDeal");
      var m = n ? " [OWN ROOM]" : "";
      console.log("[OpportunisticBuy] Bought " + u + " " + r.resourceType + " (account resource) from " + (e.roomName || "market") + m + " @ " + e.price + " (credits: " + s.toFixed(3) + "). Progress: " + r.fulfilled + "/" + r.totalAmount);
      return true;
    } else {
      var l = "Unknown error: " + c;
      if (c === ERR_NOT_ENOUGH_RESOURCES) {
        l = "Insufficient credits or order resources";
      } else if (c === ERR_INVALID_ARGS) {
        l = "Invalid arguments";
      } else if (c === ERR_NOT_FOUND) {
        l = "Order no longer available";
      }
      console.log("[OpportunisticBuy] Error buying account resource from order " + e.id + " (" + (e.roomName || "unknown") + "): " + l);
      r.cachedOrderId = null;
      r.cachedOrderRoomName = null;
      return true;
    }
  }
  var o = false;
  if (r.cachedOrderId) {
    var a = Game.market.getOrderById(r.cachedOrderId);
    var u = !!(a && a.roomName && i[a.roomName]);
    if (a && a.resourceType === r.resourceType && (a.price <= r.maxPrice || u) && util.getOrderRemaining(a) > 0) {
      o = attemptAccountDeal(a);
    } else {
      r.cachedOrderId = null;
      r.cachedOrderRoomName = null;
    }
  }
  if (!o) {
    var c = util.marketOrders(r.resourceType, ORDER_SELL).filter(function(e) {
      if (e.roomName && i[e.roomName]) return util.getOrderRemaining(e) > 0;
      return e.price <= r.maxPrice && util.getOrderRemaining(e) > 0;
    }).sort(function(e, r) {
      var t = e.roomName && i[e.roomName] ? 1 : 0;
      var n = r.roomName && i[r.roomName] ? 1 : 0;
      if (t !== n) return n - t;
      return e.price - r.price;
    });
    for (var s = 0; s < c.length && !o; s++) {
      o = attemptAccountDeal(c[s]);
    }
  }
  if (r.remaining <= 0) {
    delete t[e];
    requestSave();
    console.log("[OpportunisticBuy] Completed buy request for " + r.resourceType + " (" + r.totalAmount + " total)");
  }
}

function reconcilePending() {
  if (memoryManager.heap.opportunisticBuyReconcileTick === Game.time) return;
  memoryManager.heap.opportunisticBuyReconcileTick = Game.time;
  if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) return;
  var e = Memory.opportunisticBuy.requests;
  for (var r in e) {
    var t = e[r];
    if (!t || isAccountResource(t.resourceType) || !t.pending || typeof t.pending.expected !== "number") continue;
    var i = t.roomName;
    var n = Game.rooms[i];
    var o = n && n.terminal;
    var a = t.pending.pre || 0;
    var u = t.pending.expected;
    var c = t.pending.energyCost || 0;
    var s = t.pending.price || 0;
    var m = t.resourceType === RESOURCE_ENERGY ? Math.max(0, u - c) : u;
    var l = o ? (o.store[t.resourceType] || 0) - a : 0;
    var f = findIncomingDeal(i, t.resourceType, t.pending);
    var p = f || o && l >= m && m > 0 || m <= 0 && c > 0 && t.resourceType === RESOURCE_ENERGY;
    if (p) {
      t.fulfilled = (t.fulfilled || 0) + u;
      t.remaining -= u;
      t.lastProgressTick = Game.time;
      if (t.jobId) {
        try {
          var d = require("marketEconomics");
          var y = require("marketPricing").getStatusEnergyPrice() || 0;
          d.recordBuy(t.jobId, t.resourceType, u, u * s, c, c * y);
        } catch (e) {}
      }
      console.log("[OpportunisticBuy] Confirmed " + u + " " + t.resourceType + " delivered to " + i + " from " + (t.pending.orderRoom || "unknown") + (t.resourceType === RESOURCE_ENERGY ? " (net +" + m + " after transfer energy)" : "") + ". Progress: " + t.fulfilled + "/" + t.totalAmount + " " + t.resourceType + " purchased.");
      t.pending = null;
      requestImmediateSave("opportunisticBuy.confirmDeal");
      if (t.remaining <= 0 || t.stopAfterPending) {
        delete e[r];
        requestImmediateSave("opportunisticBuy.completeDeal");
        console.log("[OpportunisticBuy] Completed buy request for " + t.resourceType + " in " + i);
      }
      continue;
    }
    var v = t.pending.tick || 0;
    var g = Game.time - v;
    if (g > PENDING_EXPIRATION_TICKS) {
      console.log("[OpportunisticBuy] Clearing expired pending lock for " + i + " " + t.resourceType + " after " + g + " ticks.");
      t.pending = null;
      requestSave();
      continue;
    }
    if (g > CONFIRMATION_TIMEOUT_TICKS && !t.pending.ambiguous) {
      t.pending.ambiguous = true;
      console.log("[OpportunisticBuy] Confirmation unresolved after " + g + " ticks for order " + (t.pending.orderId || "unknown") + " to " + i + ". Holding " + u + " " + t.resourceType + " for reconciliation; will not retry automatically.");
      requestSave();
    }
  }
}

function process() {
  if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) return;
  reconcilePending();
  var e = Memory.opportunisticBuy.requests;
  var r = getMyRooms();
  var t = [];
  for (var i in e) {
    var n = e[i];
    if (!n || typeof n.remaining !== "number" || n.remaining <= 0) continue;
    if (!isAccountResource(n.resourceType) && !r[n.roomName]) {
      console.log("[OpportunisticBuy] Removing orphaned request for " + n.remaining + "/" + n.totalAmount + " " + n.resourceType + " in " + n.roomName + " (room no longer owned); " + (n.fulfilled || 0) + " already fulfilled.");
      delete e[i];
      requestSave();
      continue;
    }
    t.push({
      key: i,
      req: n
    });
  }
  t.sort(function(e, r) {
    var t = (e.req.createdAt || 0) - (r.req.createdAt || 0);
    if (t !== 0) return t;
    if (e.key < r.key) return -1;
    if (e.key > r.key) return 1;
    return 0;
  });
  var o = {};
  for (var a = 0; a < t.length; a++) {
    var u = t[a].req;
    if (u && u.pending && u.roomName && !isAccountResource(u.resourceType)) {
      o[u.roomName] = true;
    }
  }
  for (var c = 0; c < t.length; c++) {
    var s = t[c].key;
    var m = t[c].req;
    if (m.remaining <= 0) continue;
    if (isAccountResource(m.resourceType)) {
      processAccountResource(s, m, e, r);
      continue;
    }
    var l = m.roomName;
    if (roomSuspender.shouldAvoidRoomWork(l)) continue;
    var f = Game.rooms[l];
    var p = f && f.terminal;
    if (!f || !p) continue;
    if (m.pending && typeof m.pending.expected === "number") continue;
    if (o[l]) continue;
    var d = m.checkInterval || 1;
    if (Game.time - m.lastCheck < d) continue;
    m.lastCheck = Game.time;
    if (p.cooldown > 0 || util.wasTerminalUsed && util.wasTerminalUsed(l)) {
      continue;
    }
    var y = p.store[RESOURCE_ENERGY] || 0;
    var v = p.store.getFreeCapacity();
    if (v <= 0) {
      continue;
    }
    var g = m.includeTransferCost ? require("marketPricing").getStatusEnergyPrice() || 0 : 0;
    function effectivePrice(e, r) {
      if (!m.includeTransferCost) return e.price;
      if (!(g > 0) || !(r > 0)) return Infinity;
      var t = util.calcTransactionCost(r, l, e.roomName);
      return e.price + t * g / r;
    }
    function feasibleOrderAmount(e) {
      var r = Math.min(util.getOrderRemaining(e), m.remaining, v);
      if (!(r > 0)) return 0;
      return capByEnergy(r, l, e.roomName, y);
    }
    function attemptDeal(e) {
      var t = Game.market.getOrderById(e.id);
      if (!t || util.getOrderRemaining(t) <= 0) return false;
      e = t;
      if (e.roomName === l) return false;
      var i = !!(e.roomName && r[e.roomName]);
      if (m.externalOnly && i) return false;
      if (!i && !(e.price <= m.maxPrice)) return false;
      var n = creditLedger.available();
      var a = e.price > 0 ? Math.floor(n / e.price) : 0;
      if (a <= 0 && !i) {
        console.log("[OpportunisticBuy] Insufficient credits to buy " + m.resourceType + " at " + e.price + " (balance: " + Game.market.credits.toFixed(3) + ")");
        return true;
      }
      var u = util.getOrderRemaining(e);
      if (u > m.remaining) u = m.remaining;
      if (!i && u > a) u = a;
      if (u > v) u = v;
      var c = capByEnergy(u, l, e.roomName, y);
      if (c <= 0) {
        return false;
      }
      u = c;
      if (m.includeTransferCost && effectivePrice(e, u) > m.maxPrice) {
        return false;
      }
      var s = p.store[m.resourceType] || 0;
      var f = Game.market.deal(e.id, u, l);
      if (f === OK) {
        var d = util.calcTransactionCost(u, l, e.roomName);
        var g = u * e.price;
        if (!i) creditLedger.commit(g);
        m.pending = {
          pre: s,
          expected: u,
          tick: Game.time,
          orderId: e.id,
          orderRoom: e.roomName,
          price: e.price,
          energyCost: d
        };
        m.cachedOrderId = e.id;
        m.cachedOrderRoomName = e.roomName;
        requestImmediateSave("opportunisticBuy.terminalDeal");
        if (util.markTerminalUsed) util.markTerminalUsed(l);
        o[l] = true;
        var R = i ? " [OWN ROOM]" : "";
        console.log("[OpportunisticBuy] Placed deal for " + u + " " + m.resourceType + " from " + e.roomName + R + " @ " + e.price + " (credits: " + g.toFixed(3) + ", energy: " + d + "). Awaiting terminal confirmation.");
        return true;
      } else {
        var O = "Unknown error: " + f;
        if (f === ERR_NOT_ENOUGH_RESOURCES) {
          O = "Insufficient credits or order resources";
        } else if (f === ERR_INVALID_ARGS) {
          O = "Invalid arguments";
        } else if (f === ERR_NOT_ENOUGH_ENERGY) {
          O = "Insufficient terminal energy";
        } else if (f === ERR_NOT_FOUND) {
          O = "Order no longer available";
        } else if (f === ERR_TIRED) {
          O = "Terminal cooldown";
        }
        console.log("[OpportunisticBuy] Error buying from order " + e.id + " (" + e.roomName + "): " + O);
        m.cachedOrderId = null;
        m.cachedOrderRoomName = null;
        return true;
      }
    }
    var R = false;
    if (m.cachedOrderId && !m.includeTransferCost) {
      var O = Game.market.getOrderById(m.cachedOrderId);
      var q = !!(O && O.roomName && r[O.roomName]);
      if (O && O.roomName && O.roomName !== l && O.resourceType === m.resourceType && (!m.externalOnly || !q) && (O.price <= m.maxPrice || q) && util.getOrderRemaining(O) > 0) {
        R = attemptDeal(O);
      } else {
        m.cachedOrderId = null;
        m.cachedOrderRoomName = null;
      }
    }
    if (!R) {
      var N = util.marketOrders(m.resourceType, ORDER_SELL).filter(function(e) {
        if (!e.roomName) return false;
        if (marketBatchBuy.isOrderReserved && marketBatchBuy.isOrderReserved(e.id)) return false;
        if (m.externalOnly && r[e.roomName]) return false;
        if (r[e.roomName]) return util.getOrderRemaining(e) > 0;
        if (!(e.price <= m.maxPrice) || !(util.getOrderRemaining(e) > 0)) return false;
        var t = feasibleOrderAmount(e);
        return t > 0 && effectivePrice(e, t) <= m.maxPrice;
      }).sort(function(e, t) {
        var i = e.roomName && r[e.roomName] ? 1 : 0;
        var n = t.roomName && r[t.roomName] ? 1 : 0;
        if (i !== n) return n - i;
        if (m.includeTransferCost) {
          return effectivePrice(e, feasibleOrderAmount(e)) - effectivePrice(t, feasibleOrderAmount(t));
        }
        return e.price - t.price;
      });
      if (N.length === 0) continue;
      if (m.includeTransferCost) {
        for (var B = 0; B < N.length && !R; B++) {
          R = attemptDeal(N[B]);
        }
        continue;
      }
      var T = !!(N[0].roomName && r[N[0].roomName]);
      if (T) {
        for (var I = 0; I < N.length && !R; I++) {
          var h = N[I];
          if (!(h.roomName && r[h.roomName])) break;
          if (h.roomName === l) continue;
          var k = util.getOrderRemaining(h);
          if (k > m.remaining) k = m.remaining;
          if (k > v) k = v;
          k = capByEnergy(k, l, h.roomName, y);
          if (k > 0) {
            R = attemptDeal(h);
          }
        }
      }
      if (!R) {
        var E = [];
        for (var A = 0; A < N.length; A++) {
          if (!(N[A].roomName && r[N[A].roomName])) {
            E.push(N[A]);
          }
        }
        if (E.length > 0) {
          var M = m.includeTransferCost ? effectivePrice(E[0], feasibleOrderAmount(E[0])) : E[0].price;
          var C = null;
          var b = 0;
          for (var P = 0; P < E.length; P++) {
            var S = E[P];
            var x = m.includeTransferCost ? effectivePrice(S, feasibleOrderAmount(S)) : S.price;
            if (x !== M) break;
            var G = creditLedger.available();
            var _ = Math.floor(G / S.price);
            if (_ <= 0) break;
            var U = util.getOrderRemaining(S);
            if (U > m.remaining) U = m.remaining;
            if (U > _) U = _;
            if (U > v) U = v;
            U = capByEnergy(U, l, S.roomName, y);
            if (U > b) {
              b = U;
              C = S;
            }
          }
          if (C && b > 0) {
            R = attemptDeal(C);
          } else {
            for (var D = 0; D < E.length && !R; D++) {
              var K = E[D];
              var w = creditLedger.available();
              var L = Math.floor(w / K.price);
              if (L <= 0) break;
              var Q = util.getOrderRemaining(K);
              if (Q > m.remaining) Q = m.remaining;
              if (Q > L) Q = L;
              if (Q > v) Q = v;
              Q = capByEnergy(Q, l, K.roomName, y);
              if (Q > 0) {
                R = attemptDeal(K);
              }
            }
          }
        }
      }
    }
  }
}

function listActiveRequests() {
  if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) {
    var e = "No active buy requests";
    console.log("[OpportunisticBuy] " + e);
    return e;
  }
  var r = Memory.opportunisticBuy.requests;
  var t = "Active buy requests:\n";
  for (var i in r) {
    var n = r[i];
    var o = n.fulfilled || 0;
    var a = isAccountResource(n.resourceType) ? " [ACCOUNT]" : "";
    var u = n.pending && typeof n.pending.expected === "number" ? " (pending " + n.pending.expected + " awaiting confirmation)" : "";
    var c = n.queue ? " [" + n.queue + "]" : "";
    var s = n.product ? " job=" + n.product + (n.direction ? "/" + n.direction : "") : "";
    var m = n.opId ? " op=" + n.opId : "";
    t += "- " + n.roomName + c + ": " + n.remaining + "/" + n.totalAmount + " " + n.resourceType + a + " (fulfilled " + o + ")" + " (max " + n.maxPrice + " credits)" + s + m + u + "\n";
  }
  console.log("[OpportunisticBuy] " + t);
  return t;
}

function getActiveRequestRecords() {
  if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) return [];
  var e = Memory.opportunisticBuy.requests;
  var r = [];
  for (var t in e) {
    if (e[t] && typeof e[t] === "object") r.push(snapshotRequest(e[t]));
  }
  return r;
}

function cancelRequest(e, r, t) {
  var i = requestKey(e, r, t);
  var n = Memory.opportunisticBuy.requests;
  if (n[i]) {
    var o = n[i];
    var a = o.remaining;
    var u = o.totalAmount;
    if (t && t.settlePending && o.pending && typeof o.pending.expected === "number") {
      var c = Game.time - (o.pending.tick || Game.time);
      if (o.stopAfterPending && c > CONFIRMATION_TIMEOUT_TICKS) {
        delete n[i];
        requestImmediateSave("opportunisticBuy.releasePending");
        var s = "Released cancelled buy request for " + r + " in " + e + " after pending settlement timeout (" + c + " ticks)" + (requestQueue(t) ? " [" + requestQueue(t) + "]" : "");
        console.log("[OpportunisticBuy] " + s);
        return s;
      }
      var m = "Closed buy request for " + a + "/" + u + " " + r + " in " + e + "; awaiting pending settlement" + (requestQueue(t) ? " [" + requestQueue(t) + "]" : "");
      if (!o.stopAfterPending) {
        o.stopAfterPending = true;
        requestImmediateSave("opportunisticBuy.stopAfterPending");
        console.log("[OpportunisticBuy] " + m);
      }
      return m;
    }
    delete n[i];
    requestSave();
    var l = requestQueue(t);
    var f = "Cancelled buy request for " + a + "/" + u + " " + r + " in " + e + (l ? " [" + l + "]" : "");
    console.log("[OpportunisticBuy] " + f);
    return f;
  } else {
    var p = requestQueue(t);
    var d = "No active buy request found for " + r + " in " + e + (p ? " [" + p + "]" : "");
    console.log("[OpportunisticBuy] " + d);
    return d;
  }
}

module.exports = {
  setup: setup,
  setCheckInterval: setCheckInterval,
  reconcilePending: reconcilePending,
  process: process,
  listActiveRequests: listActiveRequests,
  getActiveRequestRecords: getActiveRequestRecords,
  getActiveRequestEntries: getActiveRequestEntries,
  getRequest: getRequest,
  getRequestByKey: getRequestByKey,
  cancelRequestByKey: cancelRequestByKey,
  fulfillRequestByKey: fulfillRequestByKey,
  cancelRequest: cancelRequest
};
global.opportunisticBuy = module.exports;
