// LLM: Read docs/codex.js before reviewing or changing this file.
// opportunisticSell.js
// Console globals: opportunisticSell
// Example: opportunisticSell('status') - Run or query opportunistic market seller
var CONFIRMATION_TIMEOUT_TICKS = 20;
var MARKET_TRANSACTION_HISTORY_LIMIT = 100;
var roomSuspender = require("roomSuspender");
var util = require("util");
var pricing = require("marketPricing");
var autoTraderSellPolicy = require("autoTraderSellPolicy");
var memoryManager = require("memoryManager");
var storageManager = require("storageManager");
var terminalManager = require("terminalManager");
var RESERVATION_PROGRAM = "opportunisticSell";
var ACCOUNT_RESOURCES = {
  pixel: true,
  cpuUnlock: true,
  accessKey: true
};
function isAccountResource(e) {
  return !!ACCOUNT_RESOURCES[e];
}

function configuredSellFloor(e) {
  return autoTraderSellPolicy && typeof autoTraderSellPolicy.getFloor === "function" ? autoTraderSellPolicy.getFloor(e) : 0;
}

function effectiveMinimumPrice(e) {
  var r = e && typeof e.minPrice === "number" && isFinite(e.minPrice) ? Math.max(0, e.minPrice) : 0;
  return Math.max(r, configuredSellFloor(e && e.resourceType));
}

if (!Memory.opportunisticSell) {
  Memory.opportunisticSell = {
    requests: {}
  };
}
var getMyRooms = util.getMyRooms;
function getEnergyMarketPrice() {
  var e = pricing.getStatusEnergyPrice();
  return typeof e === "number" && isFinite(e) && e > 0 ? e : 0;
}

function addJobAllocation(e, r, o) {
  if (!e || !r) return;
  var t = Array.isArray(r.jobAllocations) ? r.jobAllocations : null;
  if (!t) {
    t = r.jobId ? [ {
      jobId: r.jobId,
      amount: typeof r.jobAmount === "number" && r.jobAmount > 0 ? r.jobAmount : o
    } ] : [];
  }
  if (!Array.isArray(e.jobAllocations)) e.jobAllocations = [];
  for (var n = 0; n < t.length; n++) {
    var a = t[n];
    if (!a || !a.jobId || !(a.amount > 0)) continue;
    var i = null;
    for (var l = 0; l < e.jobAllocations.length; l++) {
      if (e.jobAllocations[l] && e.jobAllocations[l].jobId === a.jobId) {
        i = e.jobAllocations[l];
        break;
      }
    }
    if (i) i.amount = Math.max(i.amount, a.amount); else e.jobAllocations.push({
      jobId: a.jobId,
      amount: a.amount
    });
  }
}

function setup(e, r, o, t, n, a, i, l) {
  var s = e + "_" + r;
  var u = Memory.opportunisticSell.requests[s];
  var c = t === true;
  var m = c ? 0 : t;
  var f = u && typeof u.createdAt === "number" ? u.createdAt : Game.time;
  if (u) {
    if (!Array.isArray(u.jobAllocations) && u.jobId && u.remaining > 0) {
      u.jobAllocations = [ {
        jobId: u.jobId,
        amount: u.remaining
      } ];
    }
    u.totalAmount = Math.max(u.totalAmount || 0, (u.fulfilled || 0) + o);
    u.remaining = Math.max(u.remaining || 0, o);
    u.minPrice = m;
    u.bestOffer = c;
    u.reserve = typeof n === "number" && n >= 0 ? n : u.reserve || 0;
    if (i) u.externalOnly = true;
    if (l) u.stagingOpId = l;
    addJobAllocation(u, a, o);
    syncRequestReservation(u);
    memoryManager.requestSave();
    return "Sell request for " + o + " " + r + " from " + e + " already active";
  }
  Memory.opportunisticSell.requests[s] = {
    roomName: e,
    resourceType: r,
    totalAmount: o,
    remaining: o,
    minPrice: m,
    reserve: typeof n === "number" && n >= 0 ? n : 0,
    bestOffer: c,
    externalOnly: !!i,
    stagingOpId: l || null,
    lastCheck: 0,
    checkInterval: 1,
    cachedOrderId: null,
    cachedOrderRoomName: null,
    createdAt: f,
    fulfilled: 0,
    pending: null
  };
  if (a && a.jobId) Memory.opportunisticSell.requests[s].jobId = a.jobId;
  addJobAllocation(Memory.opportunisticSell.requests[s], a, o);
  syncRequestReservation(Memory.opportunisticSell.requests[s]);
  var p = isAccountResource(r) ? " [ACCOUNT RESOURCE]" : "";
  var v = n && n > 0 ? " (reserve " + n + ")" : "";
  var d = c ? " [BEST OFFER MODE]" : " (min " + m + " credits/unit)";
  var g = "Sell request for " + o + " " + r + " from " + e + " created" + d + v + p;
  console.log("[OpportunisticSell] " + g);
  return g;
}

function setCheckInterval(e, r, o) {
  var t = e + "_" + r;
  var n = Memory.opportunisticSell.requests;
  if (!n || !n[t]) {
    var a = "No active sell request found for " + r + " in " + e;
    console.log("[OpportunisticSell] " + a);
    return a;
  }
  if (typeof o !== "number" || o < 1) {
    var i = "Invalid checkInterval " + o + " (must be number >= 1)";
    console.log("[OpportunisticSell] " + i);
    return i;
  }
  n[t].checkInterval = o;
  var l = "Set checkInterval for " + e + " " + r + " to " + o + " ticks";
  console.log("[OpportunisticSell] " + l);
  return l;
}

function setReserve(e, r, o) {
  var t = e + "_" + r;
  var n = Memory.opportunisticSell.requests;
  if (!n || !n[t]) {
    var a = "No active sell request found for " + r + " in " + e;
    console.log("[OpportunisticSell] " + a);
    return a;
  }
  if (typeof o !== "number" || o < 0) {
    var i = "Invalid reserve " + o + " (must be number >= 0)";
    console.log("[OpportunisticSell] " + i);
    return i;
  }
  n[t].reserve = o;
  syncRequestReservation(n[t]);
  memoryManager.requestSave();
  var l = "Set reserve for " + e + " " + r + " to " + o;
  console.log("[OpportunisticSell] " + l);
  return l;
}

function setBestOffer(e, r, o) {
  var t = e + "_" + r;
  var n = Memory.opportunisticSell.requests;
  if (!n || !n[t]) {
    var a = "No active sell request found for " + r + " in " + e;
    console.log("[OpportunisticSell] " + a);
    return a;
  }
  n[t].bestOffer = !!o;
  var i = (o ? "Enabled" : "Disabled") + " best-offer mode for " + e + " " + r;
  console.log("[OpportunisticSell] " + i);
  return i;
}

var capByEnergy = util.capByEnergy;
function reservesTerminalStock(e) {
  return !isAccountResource(e) && e !== RESOURCE_ENERGY;
}

function getTerminalReservation(e, r) {
  var o = storageManager.storageFind(e, r);
  var t = o && o.terminal && o.terminal.reservations;
  if (!Array.isArray(t)) return null;
  for (var n = 0; n < t.length; n++) {
    if (t[n] && t[n].program === RESERVATION_PROGRAM) {
      return t[n];
    }
  }
  return null;
}

function getAvailableTerminalAmount(e, r, o) {
  var t = Game.rooms[e];
  var n = t && t.terminal;
  var a = n && n.store ? n.store[r] || 0 : 0;
  if (!(a > 0) || !storageManager || typeof storageManager.storageFind !== "function") return Math.max(0, a);
  var i = storageManager.storageFind(e, r);
  var l = i && i.terminal && i.terminal.reservations;
  if (!Array.isArray(l)) return Math.max(0, a);
  for (var s = 0; s < l.length; s++) {
    if (l[s] && l[s].program !== o) {
      a -= l[s].amount || 0;
    }
  }
  return Math.max(0, a);
}

function releaseRequestReservation(e) {
  if (!e || !reservesTerminalStock(e.resourceType)) return false;
  var r = getTerminalReservation(e.roomName, e.resourceType);
  if (!r) return false;
  storageManager.unReserve(e.roomName, e.resourceType, "terminal", RESERVATION_PROGRAM);
  memoryManager.requestSave();
  return true;
}

function syncRequestReservation(e) {
  if (!e || !reservesTerminalStock(e.resourceType)) return 0;
  var r = getTerminalReservation(e.roomName, e.resourceType);
  if (e.pending && typeof e.pending.expected === "number") {
    return r ? Math.min(r.amount || 0, e.remaining || 0) : 0;
  }
  var o = Game.rooms[e.roomName];
  var t = o && o.terminal;
  if (!t) {
    if (r) releaseRequestReservation(e);
    return 0;
  }
  var n = getAvailableTerminalAmount(e.roomName, e.resourceType, RESERVATION_PROGRAM);
  var a = typeof e.reserve === "number" && e.reserve > 0 ? e.reserve : 0;
  var i = Math.min(Math.max(0, e.remaining || 0), Math.max(0, n - a));
  if (i <= 0) {
    if (r) releaseRequestReservation(e);
    return 0;
  }
  var l = r && typeof r.time === "number" && Game.time - r.time > 1e3;
  if (r && r.amount === i && !l) return i;
  var s = storageManager.reserve(e.roomName, e.resourceType, "terminal", RESERVATION_PROGRAM, i);
  if (s && s.ok) {
    memoryManager.requestSave();
    return i;
  }
  if (Game.time % 100 === 0) {
    console.log("[OpportunisticSell] Could not reserve " + i + " " + e.resourceType + " in " + e.roomName + ": " + (s && s.reason ? s.reason : "unknown error"));
  }
  return r ? Math.min(r.amount || 0, e.remaining || 0) : 0;
}

function processAccountResource(e, r, o, t) {
  var n = r.checkInterval || 1;
  if (Game.time - r.lastCheck < n) return;
  r.lastCheck = Game.time;
  function attemptAccountDeal(e) {
    var o = Game.market.getOrderById(e.id);
    if (!o || o.amount <= 0) return false;
    e = o;
    var n = !!(e.roomName && t[e.roomName]);
    if (l > 0 && e.price < l) return false;
    if (!n && !r.bestOffer && e.price < i) return false;
    var a = e.amount;
    if (a > r.remaining) a = r.remaining;
    if (a <= 0) return false;
    var s = Game.market.deal(e.id, a);
    if (s === OK) {
      var u = a * e.price;
      r.fulfilled = (r.fulfilled || 0) + a;
      r.remaining -= a;
      r.cachedOrderId = e.id;
      r.cachedOrderRoomName = e.roomName;
      memoryManager.requestImmediateSave("opportunisticSell.accountDeal");
      var c = n ? " [OWN ROOM]" : "";
      console.log("[OpportunisticSell] Sold " + a + " " + r.resourceType + " (account resource) to " + (e.roomName || "market") + c + " @ " + e.price + " (credits earned: " + u.toFixed(3) + "). Progress: " + r.fulfilled + "/" + r.totalAmount);
      return true;
    } else {
      var m = "Unknown error: " + s;
      if (s === ERR_NOT_ENOUGH_RESOURCES) {
        m = "Insufficient resources";
      } else if (s === ERR_INVALID_ARGS) {
        m = "Invalid arguments";
      } else if (s === ERR_NOT_FOUND) {
        m = "Order no longer available";
      }
      console.log("[OpportunisticSell] Error selling account resource to order " + e.id + " (" + (e.roomName || "unknown") + "): " + m);
      r.cachedOrderId = null;
      r.cachedOrderRoomName = null;
      return true;
    }
  }
  var a = false;
  var i = effectiveMinimumPrice(r);
  var l = configuredSellFloor(r.resourceType);
  if (r.cachedOrderId) {
    var s = Game.market.getOrderById(r.cachedOrderId);
    var u = !!(s && s.roomName && t[s.roomName]);
    if (s && s.resourceType === r.resourceType && (s.price >= i || u && l <= 0) && s.amount > 0) {
      a = attemptAccountDeal(s);
    } else {
      r.cachedOrderId = null;
      r.cachedOrderRoomName = null;
    }
  }
  if (!a) {
    var c = util.marketOrders(r.resourceType, ORDER_BUY).filter(function(e) {
      if (e.roomName && t[e.roomName]) {
        return (l <= 0 || e.price >= l) && e.amount > 0;
      }
      return e.price >= i && e.amount > 0;
    }).sort(function(e, r) {
      var o = e.roomName && t[e.roomName] ? 1 : 0;
      var n = r.roomName && t[r.roomName] ? 1 : 0;
      if (o !== n) return n - o;
      return r.price - e.price;
    });
    for (var m = 0; m < c.length && !a; m++) {
      a = attemptAccountDeal(c[m]);
    }
  }
  if (r.remaining <= 0) {
    delete o[e];
    console.log("[OpportunisticSell] Completed sell request for " + r.resourceType + " (" + r.totalAmount + " total)");
  }
}

function process() {
  if (!Memory.opportunisticSell || !Memory.opportunisticSell.requests) return;
  reconcilePending();
  var e = Memory.opportunisticSell.requests;
  var r = getMyRooms();
  var o = [];
  for (var t in e) {
    var n = e[t];
    if (!n || typeof n.remaining !== "number") continue;
    if (n.remaining <= 0) {
      releaseRequestReservation(n);
      delete e[t];
      continue;
    }
    if (!isAccountResource(n.resourceType) && !r[n.roomName]) {
      console.log("[OpportunisticSell] Removing orphaned request for " + n.remaining + "/" + n.totalAmount + " " + n.resourceType + " in " + n.roomName + " (room no longer owned); " + (n.fulfilled || 0) + " already fulfilled.");
      releaseRequestReservation(n);
      delete e[t];
      continue;
    }
    o.push({
      key: t,
      req: n
    });
  }
  o.sort(function(e, r) {
    var o = (e.req.createdAt || 0) - (r.req.createdAt || 0);
    if (o !== 0) return o;
    if (e.key < r.key) return -1;
    if (e.key > r.key) return 1;
    return 0;
  });
  var a = {};
  var i = {};
  for (var l = 0; l < o.length; l++) {
    var s = o[l].req;
    if (s && s.pending && s.roomName && !isAccountResource(s.resourceType)) {
      a[s.roomName] = true;
    }
  }
  for (var u = 0; u < o.length; u++) {
    var c = o[u].key;
    var m = o[u].req;
    if (m.remaining <= 0) continue;
    if (isAccountResource(m.resourceType)) {
      processAccountResource(c, m, e, r);
      continue;
    }
    var f = m.roomName;
    if (roomSuspender.shouldAvoidRoomWork(f)) continue;
    var p = Game.rooms[f];
    var v = p && p.terminal;
    if (!p || !v) {
      if (p && !v) releaseRequestReservation(m);
      continue;
    }
    if (m.pending && typeof m.pending.expected === "number") continue;
    var d = reservesTerminalStock(m.resourceType);
    var g = d ? syncRequestReservation(m) : 0;
    if (a[f]) continue;
    var y = m.checkInterval || 1;
    if (Game.time - m.lastCheck < y) continue;
    m.lastCheck = Game.time;
    if (v.cooldown > 0 || util.wasTerminalUsed && util.wasTerminalUsed(f)) continue;
    if (terminalManager && typeof terminalManager.isRoomBusyWithTransfer === "function" && terminalManager.isRoomBusyWithTransfer(f)) continue;
    var R = m.reserve || 0;
    var O = d ? g : getAvailableTerminalAmount(f, m.resourceType);
    var S = d ? O : Math.max(0, O - R);
    if (S <= 0) continue;
    var T = getAvailableTerminalAmount(f, RESOURCE_ENERGY);
    var N = m.resourceType === RESOURCE_ENERGY;
    var A = effectiveMinimumPrice(m);
    var M = configuredSellFloor(m.resourceType);
    function attemptDeal(e) {
      var o = Game.market.getOrderById(e.id);
      if (!o || o.amount <= 0) return false;
      e = o;
      var t = !!(e.roomName && r[e.roomName]);
      if (m.externalOnly && t) return false;
      if (M > 0 && e.price < M) return false;
      if (!t && !m.bestOffer && e.price < A) return false;
      var n = e.amount;
      var l = i[e.id] || 0;
      n -= l;
      if (n <= 0) return false;
      if (n > m.remaining) n = m.remaining;
      if (n > S) n = S;
      var s = capByEnergy(n, f, e.roomName, T, N);
      if (s <= 0) {
        return false;
      }
      n = s;
      if (m.bestOffer) {
        var u = getEnergyMarketPrice();
        var c = util.calcTransactionCost(n, f, e.roomName);
        var p = c / n;
        var d = e.price - p * u;
        if (!(d > 0)) return false;
      }
      var g = v.store[m.resourceType] || 0;
      var y = Game.market.deal(e.id, n, f);
      if (y === OK) {
        var R = util.calcTransactionCost(n, f, e.roomName);
        var O = n * e.price;
        m.pending = {
          pre: g,
          expected: n,
          tick: Game.time,
          orderId: e.id,
          orderRoom: e.roomName,
          price: e.price,
          energyCost: R
        };
        i[e.id] = (i[e.id] || 0) + n;
        if (util.markTerminalUsed) util.markTerminalUsed(f);
        m.cachedOrderId = e.id;
        m.cachedOrderRoomName = e.roomName;
        memoryManager.requestImmediateSave("opportunisticSell.terminalDeal");
        a[f] = true;
        var h = t ? " [OWN ROOM]" : "";
        console.log("[OpportunisticSell] Placed deal to sell " + n + " " + m.resourceType + " to " + e.roomName + h + " (order " + e.id + ") @ " + e.price + " (credits earned: " + O.toFixed(3) + ", energy: " + R + "). Awaiting terminal confirmation.");
        return true;
      } else {
        var b = "Unknown error: " + y;
        if (y === ERR_NOT_ENOUGH_RESOURCES) {
          b = "Insufficient resources in terminal";
        } else if (y === ERR_INVALID_ARGS) {
          b = "Invalid arguments";
        } else if (y === ERR_NOT_ENOUGH_ENERGY) {
          b = "Insufficient terminal energy";
        } else if (y === ERR_NOT_FOUND) {
          b = "Order no longer available";
        } else if (y === ERR_TIRED) {
          b = "Terminal cooldown";
        }
        console.log("[OpportunisticSell] Error selling to order " + e.id + " (" + e.roomName + "): " + b);
        m.cachedOrderId = null;
        m.cachedOrderRoomName = null;
        return true;
      }
    }
    var h = false;
    if (!m.bestOffer && m.cachedOrderId) {
      var b = Game.market.getOrderById(m.cachedOrderId);
      var I = !!(b && b.roomName && r[b.roomName]);
      if (b && b.roomName && b.resourceType === m.resourceType && (b.price >= A || I && M <= 0) && b.amount > 0) {
        h = attemptDeal(b);
      } else {
        m.cachedOrderId = null;
        m.cachedOrderRoomName = null;
      }
    }
    if (!h) {
      var E = util.marketOrders(m.resourceType, ORDER_BUY).filter(function(e) {
        if (!e.roomName) return false;
        if (e.roomName === f) return false;
        if (r[e.roomName]) {
          return (M <= 0 || e.price >= M) && e.amount > 0;
        }
        return e.price >= A && e.amount > 0;
      }).sort(function(e, o) {
        var t = e.roomName && r[e.roomName] ? 1 : 0;
        var n = o.roomName && r[o.roomName] ? 1 : 0;
        if (t !== n) return n - t;
        return o.price - e.price;
      });
      if (E.length === 0) continue;
      if (m.bestOffer) {
        var k = [];
        var q = getEnergyMarketPrice();
        for (var C = 0; C < E.length; C++) {
          var _ = E[C];
          var G = Math.min(m.remaining, S, _.amount || 0);
          G = capByEnergy(G, f, _.roomName, T, N);
          if (!(G > 0)) continue;
          var P = util.calcTransactionCost(G, f, _.roomName);
          var x = _.price - P / G * q;
          if (!(x > 0)) continue;
          k.push({
            order: _,
            netPerUnit: x
          });
        }
        k.sort(function(e, r) {
          return r.netPerUnit - e.netPerUnit;
        });
        for (var j = 0; j < k.length && !h; j++) {
          h = attemptDeal(k[j].order);
        }
        continue;
      }
      var U = !!(E[0].roomName && r[E[0].roomName]);
      if (U) {
        for (var D = 0; D < E.length && !h; D++) {
          var F = E[D];
          if (!(F.roomName && r[F.roomName])) break;
          if (F.roomName === f) continue;
          var B = F.amount;
          if (B > m.remaining) B = m.remaining;
          if (B > S) B = S;
          B = capByEnergy(B, f, F.roomName, T, N);
          if (B > 0) {
            h = attemptDeal(F);
          }
        }
      }
      if (!h) {
        var w = [];
        for (var V = 0; V < E.length; V++) {
          if (!(E[V].roomName && r[E[V].roomName])) {
            w.push(E[V]);
          }
        }
        if (w.length > 0) {
          if (m.bestOffer) {
            var Y = getEnergyMarketPrice();
            var H = w.slice(0, 10);
            var K = [];
            for (var W = 0; W < H.length; W++) {
              var L = H[W];
              var J = L.amount;
              if (J > m.remaining) J = m.remaining;
              if (J > S) J = S;
              J = capByEnergy(J, f, L.roomName, T, N);
              if (J <= 0) continue;
              var z = util.calcTransactionCost(J, f, L.roomName);
              var Q = z / J;
              var X = L.price - Q * Y;
              K.push({
                order: L,
                feasible: J,
                netPerUnit: X,
                energyCost: z
              });
            }
            K.sort(function(e, r) {
              return r.netPerUnit - e.netPerUnit;
            });
            for (var Z = 0; Z < K.length && !h; Z++) {
              if (K[Z].netPerUnit > 0) {
                h = attemptDeal(K[Z].order);
              }
            }
            if (h && K.length > 0) {
              var $ = K[0];
              console.log("[OpportunisticSell] Best offer: " + $.order.roomName + " @ " + $.order.price + " | net/unit: " + $.netPerUnit.toFixed(4) + " (energy cost: " + $.energyCost + " @ " + Y.toFixed(4) + "/unit)" + (K.length > 1 ? " | runner-up net/unit: " + K[1].netPerUnit.toFixed(4) : ""));
            }
          } else {
            var ee = w[0].price;
            var re = null;
            var oe = 0;
            for (var te = 0; te < w.length; te++) {
              var ne = w[te];
              if (ne.price !== ee) break;
              var ae = ne.amount;
              if (ae > m.remaining) ae = m.remaining;
              if (ae > S) ae = S;
              ae = capByEnergy(ae, f, ne.roomName, T, N);
              if (ae > oe) {
                oe = ae;
                re = ne;
              }
            }
            if (re && oe > 0) {
              h = attemptDeal(re);
            } else {
              for (var ie = 0; ie < w.length && !h; ie++) {
                var le = w[ie];
                var se = le.amount;
                if (se > m.remaining) se = m.remaining;
                if (se > S) se = S;
                se = capByEnergy(se, f, le.roomName, T, N);
                if (se > 0) {
                  h = attemptDeal(le);
                }
              }
            }
          }
        }
      }
    }
  }
}

function findOutgoingDeal(e, r, o) {
  var t = Game.market && Game.market.outgoingTransactions;
  if (!t) return null;
  for (var n = 0; n < t.length; n++) {
    var a = t[n];
    if (typeof a.time === "number" && a.time < o.tick) break;
    if (a.from === e && a.resourceType === r && a.amount >= o.expected && a.order && a.order.id === o.orderId) {
      return a;
    }
  }
  return null;
}

function transactionHistoryCovers(e, r) {
  if (!Array.isArray(e)) return false;
  if (e.length < MARKET_TRANSACTION_HISTORY_LIMIT) return true;
  var o = e[e.length - 1];
  return !!o && typeof o.time === "number" && o.time < r;
}

function reconcilePending() {
  if (memoryManager.heap.opportunisticSellReconcileTick === Game.time) return;
  memoryManager.heap.opportunisticSellReconcileTick = Game.time;
  if (!Memory.opportunisticSell || !Memory.opportunisticSell.requests) return;
  var e = Memory.opportunisticSell.requests;
  for (var r in e) {
    var o = e[r];
    if (!o || isAccountResource(o.resourceType) || !o.pending || typeof o.pending.expected !== "number" || o.pending.ambiguous) continue;
    var t = o.roomName;
    var n = Game.rooms[t];
    var a = n && n.terminal;
    var i = o.pending;
    var l = findOutgoingDeal(t, o.resourceType, i);
    var s = !!(Game.market && Game.market.outgoingTransactions);
    var u = i.pre || 0;
    var c = a && a.store ? a.store[o.resourceType] || 0 : 0;
    var m = !!l;
    if (!s && a) m = u - c >= i.expected;
    if (m) {
      if (reservesTerminalStock(o.resourceType)) {
        storageManager.consume(t, o.resourceType, "terminal", RESERVATION_PROGRAM, i.expected);
      }
      o.fulfilled = (o.fulfilled || 0) + i.expected;
      o.remaining -= i.expected;
      if (Array.isArray(o.jobAllocations) && o.jobAllocations.length > 0) {
        var f = i.expected;
        for (var p = 0; p < o.jobAllocations.length && f > 0; p++) {
          var v = o.jobAllocations[p];
          if (!v || !(v.amount > 0)) continue;
          var d = Math.min(v.amount, f);
          try {
            require("marketEconomics").recordSale(v.jobId, o.resourceType, d, d * i.price, (i.energyCost || 0) * d / i.expected, 0);
          } catch (e) {}
          v.amount -= d;
          f -= d;
        }
        o.jobAllocations = o.jobAllocations.filter(function(e) {
          return e && e.amount > 0;
        });
      } else if (o.jobId) {
        try {
          require("marketEconomics").recordSale(o.jobId, o.resourceType, i.expected, i.expected * i.price, i.energyCost || 0, 0);
        } catch (e) {}
      }
      console.log("[OpportunisticSell] Confirmed " + i.expected + " " + o.resourceType + " sent from " + t + " to " + (i.orderRoom || "unknown") + " (order " + (i.orderId || "unknown") + "). Progress: " + o.fulfilled + "/" + o.totalAmount + " " + o.resourceType + " sold.");
      o.pending = null;
      if (o.remaining <= 0) {
        releaseRequestReservation(o);
        delete e[r];
        console.log("[OpportunisticSell] Completed sell request for " + o.resourceType + " in " + t);
      }
      memoryManager.requestImmediateSave("opportunisticSell.confirmDeal");
      continue;
    }
    var g = Game.time - (i.tick || 0);
    if (g > CONFIRMATION_TIMEOUT_TICKS) {
      if (transactionHistoryCovers(Game.market && Game.market.outgoingTransactions, i.tick)) {
        console.log("[OpportunisticSell] No outgoing transaction after " + g + " ticks for order " + (i.orderId || "unknown") + " from " + t + "; clearing ghost deal and retrying.");
        o.pending = null;
        o.cachedOrderId = null;
        o.cachedOrderRoomName = null;
        memoryManager.requestSave();
        continue;
      }
      i.ambiguous = true;
      i.ambiguousTick = Game.time;
      console.log("[OpportunisticSell] Confirmation unresolved after " + g + " ticks for order " + (i.orderId || "unknown") + " from " + t + ". Transaction history no longer covers tick " + i.tick + "; holding " + i.expected + " " + o.resourceType + " to avoid a duplicate sale.");
      memoryManager.requestSave();
    }
  }
}

function listActiveRequests() {
  if (!Memory.opportunisticSell || !Memory.opportunisticSell.requests) {
    var e = "No active sell requests";
    console.log("[OpportunisticSell] " + e);
    return e;
  }
  var r = Memory.opportunisticSell.requests;
  var o = "Active sell requests:\n";
  for (var t in r) {
    var n = r[t];
    var a = n.fulfilled || 0;
    var i = isAccountResource(n.resourceType) ? " [ACCOUNT]" : "";
    var l = n.reserve && n.reserve > 0 ? " (reserve " + n.reserve + ")" : "";
    var s = n.bestOffer ? " [BEST OFFER]" : "";
    var u = n.bestOffer ? "" : " (min " + n.minPrice + " credits)";
    var c = n.pending && typeof n.pending.expected === "number" ? " (pending " + n.pending.expected + " awaiting confirmation)" : "";
    o += "- " + n.roomName + ": " + n.remaining + "/" + n.totalAmount + " " + n.resourceType + i + " (fulfilled " + a + ")" + u + l + s + c + "\n";
  }
  console.log("[OpportunisticSell] " + o);
  return o;
}

function cancelRequest(e, r) {
  var o = e + "_" + r;
  var t = Memory.opportunisticSell.requests;
  if (t[o]) {
    var n = t[o];
    if (n.pending) {
      var a = "[OpportunisticSell] Cannot cancel request with in-flight pending deal for " + r + " in " + e;
      console.log(a);
      return a;
    }
    var i = n.remaining;
    var l = n.totalAmount;
    if (n.stagingOpId && terminalManager && typeof terminalManager.cancelOperation === "function") {
      terminalManager.cancelOperation(e, n.stagingOpId);
    }
    releaseRequestReservation(n);
    delete t[o];
    var s = "Cancelled sell request for " + i + "/" + l + " " + r + " in " + e;
    console.log("[OpportunisticSell] " + s);
    return s;
  } else {
    var u = "No active sell request found for " + r + " in " + e;
    console.log("[OpportunisticSell] " + u);
    return u;
  }
}

module.exports = {
  setup: setup,
  setCheckInterval: setCheckInterval,
  setReserve: setReserve,
  setBestOffer: setBestOffer,
  process: process,
  reconcilePending: reconcilePending,
  listActiveRequests: listActiveRequests,
  cancelRequest: cancelRequest
};
global.opportunisticSell = module.exports;
