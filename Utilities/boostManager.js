// LLM: Read docs/codex.js before reviewing or changing this file.
// boostManager.js
// Boosting is universal: any role can be boosted. boostManager.handleCreep()
// runs from main.js before role dispatch, so role files carry no boost code.
// Console globals: boost, boostUpgrader, boostRampartBot, boostDemolisher, stopBoost, boostStatus
// Example: boost('E1N1', 'builder', 3) - Tier-3 build boost on the dynamic builder body
// Example: boost('E1N1', 'defender', { attack: 3, tough: 3 }) - Action/tier map, dynamic body
// Example: boost('E1N1', 'upgrader', ['GH2O'], [WORK, WORK, CARRY, MOVE]) - Compound list with a pinned body
// Example: boost('E1N1', 'attacker', { XUH2O: 30 }, null, { allowUnboost: false }) - Explicit part counts
// Example: boostUpgrader('E1N1', 2) - Order tier-2 boosted upgrader for room
// Example: boostRampartBot('E1N1', 3) - Order tier-3 boosted rampart bot for room
// Example: boostDemolisher('E1N1', 2) - Order tier-2 boosted demolisher for room
// Example: stopBoost('E1N1', 'upgrader') - Cancel active boost order for role
// Example: boostStatus('E1N1') - Display lab boost queues and available compound inventory
var storageManager = require("storageManager");
var labManager = require("labManager");
var opportunisticBuy = require("opportunisticBuy");
var getRoomState = require("getRoomState");
var roomSuspender = require("roomSuspender");
var util = require("util");
var pricing = require("marketPricing");
var util = require("util");
var creditLedger = require("creditLedger");
var memoryManager = require("memoryManager");
function _getLabs(e) {
  var r = getRoomState.get(e.name);
  if (r && r.structuresByType && r.structuresByType[STRUCTURE_LAB]) {
    return r.structuresByType[STRUCTURE_LAB];
  }
  return e.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_LAB;
    }
  });
}

var COMPOUND_PER_PART = 30;
var ENERGY_PER_PART = 20;
var LAB_MINERAL_CAPACITY = 3e3;
var LAB_ENERGY_CAPACITY = 2e3;
var DEFAULT_BATCH_SIZE = 50;
var DEFAULT_REORDER_AT = 5;
var PRICE_MULT_INSTANT = 2;
var PRICE_MULT_ORDER = 1.5;
var PURCHASE_CHECK_INTERVAL = 100;
var BUY_ORDER_STALL_TICKS = 300;
var CLEANUP_RESERVATION_TICKS = 1e5;
var UNBOOST_RETURN_PER_PART = 15;
var UNBOOST_TTL_THRESHOLD = 100;
var MAX_BOOST_LAB_FRACTION = .5;
var UPGRADER_TIERS = {
  1: {
    compound: "GH",
    name: "Tier 1 (GH — +50%)"
  },
  2: {
    compound: "GH2O",
    name: "Tier 2 (GH2O — +80%)"
  },
  3: {
    compound: "XGH2O",
    name: "Tier 3 (XGH2O — +100%)"
  }
};
var RAMPARTBOT_TIERS = {
  1: {
    compound: "LH",
    name: "Tier 1 (LH — +50% repair)"
  },
  2: {
    compound: "LH2O",
    name: "Tier 2 (LH2O — +80% repair)"
  },
  3: {
    compound: "XLH2O",
    name: "Tier 3 (XLH2O — +100% repair)"
  }
};
var DEMOLISHER_TIERS = {
  1: {
    compound: "ZH",
    name: "Tier 1 (ZH — 2× dismantle)"
  },
  2: {
    compound: "ZH2O",
    name: "Tier 2 (ZH2O — 3× dismantle)"
  },
  3: {
    compound: "XZH2O",
    name: "Tier 3 (XZH2O — 4× dismantle)"
  }
};
var UPGRADER_BOOST_BODY = function() {
  var e = [];
  for (var r = 0; r < 15; r++) e.push(WORK);
  for (var a = 0; a < 4; a++) e.push(CARRY);
  for (var o = 0; o < 19; o++) e.push(MOVE);
  return e;
}();
var UPGRADER_BOOST_COST = 2800;
var RAMPARTBOT_BOOST_BODY = function() {
  var e = [];
  for (var r = 0; r < 21; r++) e.push(WORK);
  for (var a = 0; a < 12; a++) e.push(CARRY);
  for (var o = 0; o < 17; o++) e.push(MOVE);
  return e;
}();
var RAMPARTBOT_BOOST_COST = 3550;
var DEMOLISHER_BOOST_BODY = function() {
  var e = [];
  for (var r = 0; r < 36; r++) e.push(WORK);
  for (var a = 0; a < 14; a++) e.push(MOVE);
  return e;
}();
var DEMOLISHER_BOOST_COST = 4300;
var _cacheTick = 0;
var _hasAnyOrders = false;
var _labWorkCache = {};
var _activeOrdersCache = {};
var _needsLabBotCache = {};
function refreshTickCache() {
  if (_cacheTick === Game.time) return;
  _cacheTick = Game.time;
  _labWorkCache = {};
  _activeOrdersCache = {};
  _needsLabBotCache = {};
  _hasAnyOrders = false;
  if (Memory.boostManager && Memory.boostManager.orders) {
    for (var e in Memory.boostManager.orders) {
      _hasAnyOrders = true;
      break;
    }
  }
}

function ensureRoot() {
  if (!Memory.boostManager) Memory.boostManager = {};
  if (!Memory.boostManager.orders) Memory.boostManager.orders = {};
  if (Memory.boostManager.lastReservationUpdateTick !== null && typeof Memory.boostManager.lastReservationUpdateTick !== "number") {
    Memory.boostManager.lastReservationUpdateTick = null;
    memoryManager.requestSave();
  }
}

function getOrder(e, r) {
  if (!Memory.boostManager || !Memory.boostManager.orders) return null;
  var a = Memory.boostManager.orders[e];
  if (!a) return null;
  return a[r] || null;
}

function setOrder(e, r, a) {
  ensureRoot();
  if (!Memory.boostManager.orders[e]) {
    Memory.boostManager.orders[e] = {};
  }
  Memory.boostManager.orders[e][r] = a;
  _cacheTick = 0;
  global.__boostActive = true;
}

function reconcilePendingBuyOrders(e, r) {
  if (!r || !r.pendingBuyOrders || !Game.market || !Game.market.orders) return;
  if (!r.buyOrderIds) r.buyOrderIds = {};
  var a = {};
  var o = Memory.boostManager && Memory.boostManager.orders || {};
  for (var t in o) {
    var n = o[t] || {};
    for (var s in n) {
      var i = n[s];
      if (!i || !i.buyOrderIds) continue;
      for (var u in i.buyOrderIds) {
        var l = i.buyOrderIds[u];
        if (l) a[l] = true;
      }
    }
  }
  var d = false;
  for (var g in r.pendingBuyOrders) {
    var v = r.pendingBuyOrders[g];
    if (!v || !(v.totalAmount > 0) || !(v.price > 0) || typeof v.createdTick !== "number") {
      delete r.pendingBuyOrders[g];
      d = true;
      continue;
    }
    var c = [];
    for (var f in Game.market.orders) {
      if (a[f]) continue;
      var m = Game.market.orders[f];
      if (!m || m.type !== ORDER_BUY || m.active === false) continue;
      if (m.resourceType !== v.resourceType || m.roomName !== e) continue;
      if (m.created !== v.createdTick || m.totalAmount !== v.totalAmount) continue;
      if (typeof m.price !== "number" || Math.abs(m.price - v.price) >= .001) continue;
      c.push(f);
    }
    if (c.length !== 1) continue;
    var b = c[0];
    r.buyOrderIds[g] = b;
    a[b] = true;
    delete r.pendingBuyOrders[g];
    d = true;
    console.log("[BoostManager] Captured buy order " + b + " for " + g + " in " + e);
  }
  if (d) memoryManager.requestImmediateSave("boostManager.captureBuyOrder");
}

function hasPendingBuyOrders(e) {
  if (!e || !e.pendingBuyOrders) return false;
  for (var r in e.pendingBuyOrders) {
    if (e.pendingBuyOrders[r]) return true;
  }
  return false;
}

function deleteOrder(e, r) {
  if (!Memory.boostManager || !Memory.boostManager.orders) return;
  if (Memory.boostManager.orders[e]) {
    delete Memory.boostManager.orders[e][r];
    if (Object.keys(Memory.boostManager.orders[e]).length === 0) {
      delete Memory.boostManager.orders[e];
    }
  }
  _cacheTick = 0;
}

function migrateLabIds(e) {
  if (!e || !e.boosts) return;
  for (var r in e.boosts) {
    var a = e.boosts[r];
    if (a.labId && !a.labIds) {
      a.labIds = [ a.labId ];
      delete a.labId;
    }
    if (!a.labIds) a.labIds = [];
  }
}

var bodyCost = util.bodyCost;
function compoundPerBoost(e) {
  return e * COMPOUND_PER_PART;
}

function energyPerBoost(e) {
  return e * ENERGY_PER_PART;
}

function getRoomCompound(e, r) {
  var a = 0;
  if (e.terminal) a += e.terminal.store[r] || 0;
  if (e.storage) a += e.storage.store[r] || 0;
  return a;
}

function getLabsCompound(e, r) {
  if (!e) return 0;
  var a = 0;
  for (var o = 0; o < e.length; o++) {
    var t = Game.getObjectById(e[o]);
    if (t && t.mineralType === r) a += t.mineralAmount || 0;
  }
  return a;
}

function getBoostLabStock(e, r) {
  migrateLabIds(e);
  var a = e.boosts[r];
  if (!a || !a.labIds || a.labIds.length === 0) {
    return {
      compound: 0,
      energy: 0
    };
  }
  var o = 0;
  var t = 0;
  for (var n = 0; n < a.labIds.length; n++) {
    var s = Game.getObjectById(a.labIds[n]);
    if (!s) continue;
    if (s.mineralType === r) {
      o += s.mineralAmount || 0;
    }
    if (s.store) {
      t += s.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }
  }
  return {
    compound: o,
    energy: t
  };
}

function getReservedAmount(e, r, a, o) {
  try {
    const t = require("storageVfs");
    const n = t.getReservationList(e, r, a);
    let total = 0;
    let found = false;
    for (let i = 0; i < n.length; i++) {
      if (n[i] && n[i].program === o) {
        found = true;
        total += n[i].amount || 0;
      }
    }
    if (found) return total;
  } catch (error) {
    if (Game.time % 100 === 0) console.log("[BoostManager] V2 reservation read failed: " + ((error && error.message) || error));
  }
  return storageManager.getProgramReserved(e, r, a, o);
}

function getBoostAccessibleAmount(e, r) {
  var a = storageManager.storageFind(e, r);
  if (!a) return 0;
  var o = getReservedAmount(e, "terminal", r, "boostManager");
  var t = getReservedAmount(e, "storage", r, "boostManager");
  var n = a.terminal ? a.terminal.total || 0 : 0;
  var s = a.storage ? a.storage.total || 0 : 0;
  var i = a.terminal ? a.terminal.reserved || 0 : 0;
  var u = a.storage ? a.storage.reserved || 0 : 0;
  var l = Math.max(0, i - o);
  var d = Math.max(0, u - t);
  return Math.max(0, n - l) + Math.max(0, s - d);
}

function getRefPrice(e) {
  var r = pricing.getPriceProfile(e);
  return r && r.marketPrice > 0 ? r.marketPrice : 0;
}

function getBoostFillTarget(e) {
  var r = e * UNBOOST_RETURN_PER_PART;
  return LAB_MINERAL_CAPACITY - r;
}

function selectBoostLab(e, r) {
  var a = labManager.getLayout(e);
  var o = _getLabs(e);
  if (o.length === 0) return null;
  var t = {};
  if (a && a.groups) {
    for (var n = 0; n < a.groups.length; n++) {
      t[a.groups[n].in1.id] = true;
      t[a.groups[n].in2.id] = true;
    }
  }
  var s = e.controller;
  if (!s) return null;
  var i = null;
  var u = Infinity;
  var l = true;
  for (var d = 0; d < o.length; d++) {
    var g = o[d];
    if (r[g.id]) continue;
    var v = !!t[g.id];
    var c = g.pos.getRangeTo(s);
    if (l && !v || v === l && c < u) {
      i = g;
      u = c;
      l = v;
    }
  }
  return i;
}

function getAllAllocatedLabIds(e) {
  var r = {};
  if (!Memory.boostManager || !Memory.boostManager.orders) return r;
  var a = Memory.boostManager.orders[e];
  if (!a) return r;
  for (var o in a) {
    var t = a[o];
    if (!t || !t.boosts) continue;
    for (var n in t.boosts) {
      var s = t.boosts[n].labIds;
      if (s) {
        for (var i = 0; i < s.length; i++) {
          r[s[i]] = true;
        }
      }
    }
  }
  return r;
}

function ensureLabsAllocated(e, r) {
  migrateLabIds(r);
  var a = _getLabs(e);
  var o = Math.floor(a.length * (r.maxLabFraction || MAX_BOOST_LAB_FRACTION));
  if (o < 1) o = 1;
  var t = getAllAllocatedLabIds(e.name);
  var n = false;
  var s = true;
  for (var i in r.boosts) {
    var u = r.boosts[i];
    if (!u.labIds || u.labIds.length === 0) {
      n = true;
      s = false;
    } else if (u.labIds.length < o) {
      n = true;
    }
  }
  if (!n && s) return true;
  for (var l in r.boosts) {
    var d = r.boosts[l];
    var g = [];
    for (var v = 0; v < d.labIds.length; v++) {
      if (Game.getObjectById(d.labIds[v])) {
        g.push(d.labIds[v]);
      } else {
        delete t[d.labIds[v]];
      }
    }
    d.labIds = g;
  }
  var c = true;
  for (var f in r.boosts) {
    var m = r.boosts[f];
    while (m.labIds.length < o) {
      var b = selectBoostLab(e, t);
      if (!b) break;
      m.labIds.push(b.id);
      t[b.id] = true;
      console.log("[BoostManager] Allocated lab " + b.id.substr(-4) + " at (" + b.pos.x + "," + b.pos.y + ") for " + f + " in " + e.name + " (" + m.labIds.length + "/" + o + ")");
    }
    if (m.labIds.length === 0) {
      c = false;
      if (Game.time % 100 === 0) {
        console.log("[BoostManager] No available lab for " + f + " in " + e.name);
      }
    }
  }
  return c;
}

function handlePurchasing(e, r) {
  var a = Game.rooms[e];
  if (!a || !a.terminal) return;
  if (!r.purchaseSetup) r.purchaseSetup = {};
  if (!r.buyOrderIds) r.buyOrderIds = {};
  if (!r.pendingBuyOrders) r.pendingBuyOrders = {};
  reconcilePendingBuyOrders(e, r);
  if (r.lastPurchaseCheck && Game.time - r.lastPurchaseCheck < PURCHASE_CHECK_INTERVAL) {
    return;
  }
  r.lastPurchaseCheck = Game.time;
  var o = r.batchSize || DEFAULT_BATCH_SIZE;
  var t = r.reorderAt || DEFAULT_REORDER_AT;
  for (var n in r.boosts) {
    var s = r.boosts[n];
    var i = s.parts;
    var u = compoundPerBoost(i);
    var l = o * u;
    var d = t * u;
    var g = getRoomCompound(a, n) + getLabsCompound(s.labIds, n);
    if (g >= l) {
      if (r.purchaseSetup[n]) {
        var v = e + "_" + n;
        var c = opportunisticBuy.getRequestByKey(v);
        if (c && c.remaining <= 0) {
          delete r.purchaseSetup[n];
        }
      }
      continue;
    }
    if (g > d && r.purchaseSetup[n]) continue;
    var f = l - g;
    if (f <= 0) continue;
    var m = getRefPrice(n);
    var b = m * PRICE_MULT_INSTANT;
    if (!r.purchaseSetup[n]) {
      opportunisticBuy.setup(e, n, f, b);
      r.purchaseSetup[n] = true;
      console.log("[BoostManager] Set up opportunisticBuy for " + f + " " + n + " in " + e + " (maxPrice: " + b.toFixed(3) + ")");
    }
    var p = e + "_" + n;
    var O = opportunisticBuy.getRequestByKey(p);
    if (O && O.remaining > 0) {
      var R = Game.time - (O.createdAt || Game.time);
      if (R >= BUY_ORDER_STALL_TICKS && !r.buyOrderIds[n] && !r.pendingBuyOrders[n]) {
        var T = Math.round(m * PRICE_MULT_ORDER * 1e3) / 1e3;
        var _ = O.remaining;
        var y = pricing.FEE * T * _;
        var B = creditLedger.available() >= y ? Game.market.createOrder({
          type: ORDER_BUY,
          resourceType: n,
          price: T,
          totalAmount: _,
          roomName: e
        }) : ERR_NOT_ENOUGH_RESOURCES;
        if (B === OK) {
          creditLedger.commit(y);
          r.pendingBuyOrders[n] = {
            resourceType: n,
            totalAmount: _,
            price: T,
            createdTick: Game.time
          };
          memoryManager.requestImmediateSave("boostManager.createBuyOrder");
          console.log("[BoostManager] Placed buy order for " + _ + " " + n + " at " + T.toFixed(3) + "/unit in " + e);
        }
      }
      if (r.buyOrderIds[n]) {
        var M = Game.market.getOrderById(r.buyOrderIds[n]);
        if (!M || util.getOrderRemaining(M) <= 0) {
          delete r.buyOrderIds[n];
        }
      }
    }
  }
}

function updateReservations(e) {
  var r = Game.rooms[e];
  if (!r) return;
  var a = Memory.boostManager && Memory.boostManager.orders && Memory.boostManager.orders[e] || {};
  var o = {};
  for (var t in a) {
    var n = a[t];
    if (!n || !n.active || n.stopping) continue;
    migrateLabIds(n);
    for (var s in n.boosts) {
      var i = n.boosts[s];
      var u = (n.batchSize || DEFAULT_BATCH_SIZE) * compoundPerBoost(i.parts);
      var l = (n.batchSize || DEFAULT_BATCH_SIZE) * energyPerBoost(i.parts);
      var d = getBoostLabStock(n, s);
      var g = Math.max(0, u - d.compound);
      var v = Math.max(0, l - d.energy);
      o[s] = (o[s] || 0) + g;
      o[RESOURCE_ENERGY] = (o[RESOURCE_ENERGY] || 0) + v;
    }
  }
  var c = {};
  for (var f in o) c[f] = true;
  var existing = storageManager.getReservationRecords(e, "boostManager");
  for (var b = 0; b < existing.length; b++) {
    var p = existing[b];
    if (!c[p.material]) {
      storageManager.unReserve(e, p.material, p.building, "boostManager");
    }
  }
  for (var y in o) {
    var g = o[y];
    if (g <= 0) {
      storageManager.unReserve(e, y, "terminal", "boostManager");
      storageManager.unReserve(e, y, "storage", "boostManager");
      continue;
    }
    var B = storageManager.storageFind(e, y);
    if (!B || !B.terminal && !B.storage) continue;
    var M = getReservedAmount(e, "terminal", y, "boostManager");
    var h = getReservedAmount(e, "storage", y, "boostManager");
    var A = B.terminal ? Math.max(0, (B.terminal.total || 0) - Math.max(0, (B.terminal.reserved || 0) - M)) : 0;
    var E = B.storage ? Math.max(0, (B.storage.total || 0) - Math.max(0, (B.storage.reserved || 0) - h)) : 0;
    var I = Math.min(g, A);
    var C = Math.min(g - I, E);
    if (I > 0) {
      var S = storageManager.reserve(e, y, "terminal", "boostManager", I);
      if (!S.ok) console.log("[BoostManager] Failed terminal reserve for " + y + " in " + e + ": " + S.reason);
    } else {
      storageManager.unReserve(e, y, "terminal", "boostManager");
    }
    if (C > 0) {
      var L = storageManager.reserve(e, y, "storage", "boostManager", C);
      if (!L.ok) console.log("[BoostManager] Failed storage reserve for " + y + " in " + e + ": " + L.reason);
    } else {
      storageManager.unReserve(e, y, "storage", "boostManager");
    }
  }
}

function placeCleanupReservations(e, r) {
  var a = Game.rooms[e];
  if (!a) return;
  for (var o in r.boosts) {
    if (a.terminal && (a.terminal.store[o] || 0) > 0) {
      storageManager.reserve(e, o, "terminal", "boostManager_cleanup", a.terminal.store[o]);
    }
    if (a.storage && (a.storage.store[o] || 0) > 0) {
      storageManager.reserve(e, o, "storage", "boostManager_cleanup", a.storage.store[o]);
    }
  }
}

function isActive(e, r) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  var a = getOrder(e, r);
  return !!(a && a.active && !a.stopping);
}

function isStopping(e, r) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  var a = getOrder(e, r);
  return !!(a && a.stopping);
}

function getActiveOrders(e) {
  refreshTickCache();
  if (!_hasAnyOrders) return {};
  if (_activeOrdersCache[e] !== undefined) return _activeOrdersCache[e];
  var r = Memory.boostManager.orders[e];
  if (!r) {
    _activeOrdersCache[e] = {};
    return {};
  }
  var a = {};
  for (var o in r) {
    if (r[o] && (r[o].active || r[o].stopping)) {
      a[o] = r[o];
    }
  }
  _activeOrdersCache[e] = a;
  return a;
}

function areLabsReady(e, r) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  var a = getOrder(e, r);
  if (!a || !a.active || a.stopping) return false;
  migrateLabIds(a);
  for (var o in a.boosts) {
    var t = a.boosts[o];
    if (!t.labIds || t.labIds.length === 0) return false;
    var n = compoundPerBoost(t.parts);
    var s = energyPerBoost(t.parts);
    var i = false;
    for (var u = 0; u < t.labIds.length; u++) {
      var l = Game.getObjectById(t.labIds[u]);
      if (!l) continue;
      if (l.mineralType && l.mineralType !== o && (l.mineralAmount || 0) > 0) continue;
      var d = l.mineralType === o ? l.mineralAmount || 0 : 0;
      var g = l.store ? l.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
      if (d >= n && g >= s) {
        i = true;
        break;
      }
    }
    if (!i) return false;
  }
  return true;
}

function getBody(e, r) {
  refreshTickCache();
  if (!_hasAnyOrders) return null;
  var a = getOrder(e, r);
  if (!a || !a.body) return null;
  return a.body.slice();
}

function getBodyCost(e, r) {
  refreshTickCache();
  if (!_hasAnyOrders) return 0;
  var a = getOrder(e, r);
  return a ? a.bodyCost || 0 : 0;
}

function getSpawnBoostMeta(e, r) {
  refreshTickCache();
  if (!_hasAnyOrders) return null;
  var a = getOrder(e, r);
  if (!a || !a.active || a.stopping) return null;
  migrateLabIds(a);
  var o = {};
  var t = false;
  for (var n in a.boosts) {
    var s = a.boosts[n];
    if (!(s.parts > 0)) continue;
    if (s.labIds && s.labIds.length > 0) {
      o[n] = s.labIds.slice();
      t = true;
    }
  }
  if (!t) return null;
  return {
    needsBoost: true,
    boostLabs: o,
    boosted: {},
    boostRole: r,
    allowUnboost: a.allowUnboost !== undefined ? !!a.allowUnboost : !MILITARY_ROLES[r]
  };
}

function getLabWork(e) {
  refreshTickCache();
  if (!_hasAnyOrders) return [];
  if (_labWorkCache[e] !== undefined) return _labWorkCache[e];
  var r = getActiveOrders(e);
  var a = [];
  for (var o in r) {
    var t = r[o];
    migrateLabIds(t);
    for (var n in t.boosts) {
      var s = t.boosts[n];
      if (!s.labIds || s.labIds.length === 0) continue;
      var i = compoundPerBoost(s.parts);
      var u = energyPerBoost(s.parts);
      var l = s.parts * UNBOOST_RETURN_PER_PART;
      var d = LAB_MINERAL_CAPACITY - l;
      for (var g = 0; g < s.labIds.length; g++) {
        var v = s.labIds[g];
        var c = Game.getObjectById(v);
        if (!c) continue;
        if (t.stopping) {
          var f = (c.mineralAmount || 0) > 0;
          var m = c.store && (c.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0;
          if (f || m) {
            a.push({
              labId: v,
              lab: c,
              compound: n,
              role: o,
              needsCompound: false,
              needsEnergy: false,
              hasWrongMineral: false,
              stopping: true
            });
          }
          continue;
        }
        var b = c.mineralType && c.mineralType !== n && (c.mineralAmount || 0) > 0;
        var p = c.mineralType === n ? c.mineralAmount || 0 : 0;
        var O = c.store ? c.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
        var R = !b && p < d;
        var T = O < LAB_ENERGY_CAPACITY;
        if (b || R || T) {
          a.push({
            labId: v,
            lab: c,
            compound: n,
            role: o,
            needsCompound: R,
            needsEnergy: T,
            hasWrongMineral: b,
            stopping: false,
            compoundAmount: p,
            energyAmount: O,
            fillTarget: d
          });
        }
      }
      if (!t.stopping) {
        var _ = false;
        var y = null;
        var B = 0;
        for (var M = 0; M < s.labIds.length; M++) {
          var h = Game.getObjectById(s.labIds[M]);
          if (!h) continue;
          if (h.mineralType && h.mineralType !== n && (h.mineralAmount || 0) > 0) continue;
          var A = h.store ? h.store.getFreeCapacity(n) || 0 : 0;
          var E = h.cooldown && h.cooldown > 0;
          var I = h.mineralType === n ? h.mineralAmount || 0 : 0;
          if (!E && A >= l) {
            _ = true;
            break;
          }
          if (!E && I > B && I >= l) {
            y = h;
            B = I;
          }
        }
        if (!_ && y) {
          a.push({
            labId: y.id,
            lab: y,
            compound: n,
            role: o,
            needsCompound: false,
            needsEnergy: false,
            hasWrongMineral: false,
            stopping: false,
            isUnboostDrain: true,
            drainAmount: l
          });
        }
      }
    }
  }
  _labWorkCache[e] = a;
  return a;
}

function needsLabBot(e) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  if (_needsLabBotCache[e] !== undefined) return _needsLabBotCache[e];
  var r = getLabWork(e);
  if (r.length === 0) {
    _needsLabBotCache[e] = false;
    return false;
  }
  for (var a = 0; a < r.length; a++) {
    if (r[a].stopping || r[a].hasWrongMineral || r[a].isUnboostDrain) {
      _needsLabBotCache[e] = true;
      return true;
    }
  }
  var o = getActiveOrders(e);
  for (var t in o) {
    var n = o[t];
    if (!n.active) continue;
    migrateLabIds(n);
    for (var s in n.boosts) {
      var i = n.boosts[s];
      if (!i.labIds || i.labIds.length === 0) continue;
      var u = compoundPerBoost(i.parts);
      var l = energyPerBoost(i.parts);
      for (var d = 0; d < i.labIds.length; d++) {
        var g = Game.getObjectById(i.labIds[d]);
        if (!g) continue;
        if (g.mineralType && g.mineralType !== s && (g.mineralAmount || 0) > 0) continue;
        var v = g.mineralType === s ? g.mineralAmount || 0 : 0;
        var c = g.store ? g.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
        if (v < u) {
          if (getBoostAccessibleAmount(e, s) >= u) {
            _needsLabBotCache[e] = true;
            return true;
          }
        }
        if (c < l) {
          if (getBoostAccessibleAmount(e, RESOURCE_ENERGY) >= l) {
            _needsLabBotCache[e] = true;
            return true;
          }
        }
      }
    }
  }
  _needsLabBotCache[e] = false;
  return false;
}

function shouldUnboost(e, r) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  var a = getOrder(e, r);
  return !!(a && (a.active || a.stopping));
}

function getUnboostTarget(e, r, a) {
  refreshTickCache();
  if (!_hasAnyOrders) return null;
  var o = getOrder(e, r);
  if (!o) return null;
  migrateLabIds(o);
  for (var t in o.boosts) {
    if (!a || !a[t]) continue;
    var n = o.boosts[t];
    if (!n.labIds || n.labIds.length === 0) continue;
    var s = n.parts * UNBOOST_RETURN_PER_PART;
    for (var i = 0; i < n.labIds.length; i++) {
      var u = Game.getObjectById(n.labIds[i]);
      if (!u) continue;
      var l = u.mineralType;
      if (l && l !== t && (u.mineralAmount || 0) > 0) continue;
      if (u.cooldown && u.cooldown > 0) continue;
      var d = u.store ? u.store.getFreeCapacity(t) || 0 : 0;
      if (d < s) continue;
      return {
        labId: n.labIds[i],
        compound: t
      };
    }
  }
  return null;
}

function getUnboostTTL() {
  return UNBOOST_TTL_THRESHOLD;
}

function recordBoost(e, r, a) {
  var o = getOrder(e, r);
  if (!o) return;
  if (typeof o.boostsCompleted !== "number") o.boostsCompleted = 0;
  if (!o._pendingBoosts) o._pendingBoosts = {};
  o._pendingBoosts[a] = true;
  var t = true;
  for (var n in o.boosts) {
    if (!o._pendingBoosts[n]) {
      t = false;
      break;
    }
  }
  if (t) {
    o.boostsCompleted++;
    o._pendingBoosts = {};
    console.log("[BoostManager] Boost cycle #" + o.boostsCompleted + " completed for " + r + " in " + e);
  }
}

function handleStopping(e, r, a) {
  var o = Game.rooms[e];
  if (!o) return;
  migrateLabIds(a);
  if (!a.pendingBuyOrders) a.pendingBuyOrders = {};
  reconcilePendingBuyOrders(e, a);
  if (hasPendingBuyOrders(a)) return;
  var t = true;
  for (var n in a.boosts) {
    var s = a.boosts[n];
    for (var i = 0; i < s.labIds.length; i++) {
      var u = Game.getObjectById(s.labIds[i]);
      if (u) {
        if ((u.mineralAmount || 0) > 0) {
          t = false;
          break;
        }
        if (u.store && (u.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) {
          t = false;
          break;
        }
      }
    }
    if (!t) break;
  }
  if (!t) return;
  console.log("[BoostManager] Cleanup complete for " + r + " in " + e);
  for (var l in a.boosts) {
    storageManager.unReserve(e, l, "terminal", "boostManager_cleanup");
    storageManager.unReserve(e, l, "storage", "boostManager_cleanup");
  }
  for (var d in a.boosts) {
    opportunisticBuy.cancelRequest(e, d);
  }
  if (a.buyOrderIds) {
    for (var g in a.buyOrderIds) {
      var v = a.buyOrderIds[g];
      if (v) {
        var c = Game.market.getOrderById(v);
        if (c) Game.market.cancelOrder(v);
      }
    }
  }
  deleteOrder(e, r);
  updateReservations(e);
  console.log("[BoostManager] Fully stopped " + r + " boosting in " + e);
}

// Universal boost layer.
// An order names compounds, not bodies. Part counts are resolved from the
// pinned order body when there is one, otherwise from spawnManager's dynamic
// body for that role at the room's energy capacity, so any role can be boosted
// without a hardcoded body here. Creep-side boosting/unboosting lives in
// handleCreep(), dispatched from main.js before role dispatch, so roles need
// no boost code of their own.
var BOOST_ACTIONS = {
  upgrade: [ "GH", "GH2O", "XGH2O" ],
  build: [ "LH", "LH2O", "XLH2O" ],
  repair: [ "LH", "LH2O", "XLH2O" ],
  dismantle: [ "ZH", "ZH2O", "XZH2O" ],
  harvest: [ "UO", "UHO2", "XUHO2" ],
  attack: [ "UH", "UH2O", "XUH2O" ],
  rangedAttack: [ "KO", "KHO2", "XKHO2" ],
  heal: [ "LO", "LHO2", "XLHO2" ],
  tough: [ "GO", "GHO2", "XGHO2" ],
  carry: [ "KH", "KH2O", "XKH2O" ],
  move: [ "ZO", "ZHO2", "XZHO2" ]
};

// Action assumed when a bare tier number is given for a role.
var DEFAULT_BOOST_ACTION = {
  upgrader: "upgrade",
  builder: "build",
  remoteBuilder: "build",
  repairer: "repair",
  wallRepair: "repair",
  rampartBot: "repair",
  defenseRepair: "repair",
  maintainer: "repair",
  demolisher: "dismantle",
  demolition: "dismantle",
  contestedDemolisher: "dismantle",
  drainDemolisher: "dismantle",
  attacker: "attack",
  defender: "attack",
  squad: "attack",
  quad: "attack",
  harasser: "rangedAttack",
  skAttacker: "attack",
  healer: "heal",
  extractor: "harvest",
  harvester: "harvest",
  depositHarvester: "harvest"
};

// Roles that leave the home room: they cannot come back to unboost, and a
// stalled military creep is worse than an unboosted one.
var MILITARY_ROLES = {
  attacker: true,
  harasser: true,
  healer: true,
  skAttacker: true,
  squad: true,
  quad: true,
  demolition: true,
  demolisher: true,
  contestedDemolisher: true,
  drainDemolisher: true,
  towerDrain: true,
  thief: true,
  claimbot: true,
  controllerAttacker: true,
  depositHarvester: true,
  scavenger: true
};
// Roles the room cannot afford to stall on. Their spawns are never held back
// waiting for labs, and their creeps give up on a boost quickly.
var CRITICAL_SPAWN_ROLES = {
  harvester: true,
  supplier: true,
  defender: true,
  labBot: true,
  towerFiller: true,
  maintainer: true
};
var DEFAULT_MILITARY_BOOST_WAIT = 100;
var DEFAULT_CRITICAL_BOOST_WAIT = 50;
var MAX_BOOSTABLE_PARTS = 50;
var PARTS_REFRESH_TICKS = 1e3;
var NEWBORN_TTL_SLACK = 25;
var _compoundPartType = null;
function getPartTypeForCompound(e) {
  if (!_compoundPartType) {
    _compoundPartType = {};
    if (typeof BOOSTS !== "undefined") {
      for (var r in BOOSTS) {
        for (var a in BOOSTS[r]) _compoundPartType[a] = r;
      }
    }
  }
  return _compoundPartType[e] || null;
}

function compoundForTier(e, r) {
  var a = BOOST_ACTIONS[e];
  if (!a) return null;
  r = parseInt(r, 10);
  if (isNaN(r) || r < 1 || r > a.length) return null;
  return a[r - 1];
}

// Accepts spawn bodies ([WORK, MOVE]) and creep bodies ([{type,boost}]).
function countBodyParts(e, r) {
  if (!e) return 0;
  var a = 0;
  for (var o = 0; o < e.length; o++) {
    var t = e[o];
    if ((t && t.type ? t.type : t) === r) a++;
  }
  return a;
}

function unboostedPartCount(e, r) {
  var a = getPartTypeForCompound(r);
  if (!a) return 0;
  var o = 0;
  for (var t = 0; t < e.body.length; t++) {
    if (e.body[t].type === a && !e.body[t].boost) o++;
  }
  return o;
}

// The boost-order key is not always memory.role: demolishers run as role
// "demolition" but are ordered as "demolisher".
function boostRoleKey(e) {
  var r = e.memory;
  if (r.boostRole) return r.boostRole;
  var a = getActiveOrders(homeRoomOf(e));
  if (r.role && a[r.role]) return r.role;
  if (r.demolitionRole && a[r.demolitionRole]) return r.demolitionRole;
  return r.role;
}

function toLabIds(e) {
  if (!e) return [];
  return Array.isArray(e) ? e : [ e ];
}

function homeRoomOf(e) {
  return e.memory.homeRoom || e.memory.assignedRoom || e.room.name;
}

// Pinned order body first, then a living creep of that role (the only exact
// answer), then spawnManager's dynamic body. getCreepBody falls back to the
// harvester table for roles it does not know, so the estimate can be wrong for
// exotic roles -- pin a body on the order when the count must be exact.
function resolveRoleBody(e, r, a) {
  if (a && a.body && a.body.length) return a.body;
  for (var o in Game.creeps) {
    var t = Game.creeps[o];
    if (t.spawning || !t.memory) continue;
    if ((t.memory.homeRoom || t.memory.assignedRoom || t.room.name) !== e) continue;
    if ((t.memory.boostRole || t.memory.role) !== r && t.memory.demolitionRole !== r) continue;
    return t.body;
  }
  var n = Game.rooms[e];
  if (!n) return null;
  try {
    return require("spawnManager").getCreepBody(r, n.energyCapacityAvailable) || null;
  } catch (s) {
    return null;
  }
}

// Fills in part counts for `auto` compounds. Called at order creation so no
// downstream consumer ever sees an unresolved count, and refreshed
// periodically so a growing RCL body keeps its labs correctly stocked.
function resolveOrderParts(e, r, a) {
  if (!a || !a.boosts) return;
  var o = false;
  for (var t in a.boosts) {
    if (a.boosts[t].auto && typeof a.boosts[t].parts !== "number") {
      o = true;
      break;
    }
  }
  var n = typeof a.partsResolvedAt !== "number" || Game.time - a.partsResolvedAt >= PARTS_REFRESH_TICKS;
  if (!o && !n) return;
  var s = null;
  var i = false;
  for (var u in a.boosts) {
    var l = a.boosts[u];
    if (!l.auto) continue;
    if (s === null) s = resolveRoleBody(e, r, a) || false;
    if (!s) continue;
    var d = getPartTypeForCompound(u);
    var g = d ? countBodyParts(s, d) : 0;
    if (g > MAX_BOOSTABLE_PARTS) g = MAX_BOOSTABLE_PARTS;
    if (l.parts !== g) {
      l.parts = g;
      i = true;
      console.log("[BoostManager] " + e + "/" + r + ": " + u + " resolved to " + g + " " + (d || "?") + " part(s)");
    }
  }
  if (n || i) a.partsResolvedAt = Game.time;
  if (i) memoryManager.requestSave();
}

function normalizeBoostSpec(e, r) {
  var a = {};
  function o(e, r) {
    if (!getPartTypeForCompound(e)) return "Unknown boost compound: " + e;
    a[e] = {
      parts: r,
      auto: r === null,
      labIds: []
    };
    return null;
  }
  if (typeof e === "number" || typeof e === "string" && /^[1-3]$/.test(e)) {
    var t = DEFAULT_BOOST_ACTION[r];
    if (!t) {
      return {
        error: "No default boost action for role '" + r + "'. Pass compounds or an action map, e.g. { attack: 3 }."
      };
    }
    var n = compoundForTier(t, e);
    if (!n) return {
      error: "Invalid tier " + e + " for " + t + " (use 1-3)"
    };
    var s = o(n, null);
    return s ? {
      error: s
    } : {
      boosts: a
    };
  }
  if (typeof e === "string") e = [ e ];
  if (Array.isArray(e)) {
    for (var i = 0; i < e.length; i++) {
      var u = o(e[i], null);
      if (u) return {
        error: u
      };
    }
    return {
      boosts: a
    };
  }
  if (e && typeof e === "object") {
    for (var l in e) {
      var d = e[l];
      if (BOOST_ACTIONS[l]) {
        var g = compoundForTier(l, d);
        if (!g) return {
          error: "Invalid tier for " + l + ": " + d
        };
        var v = o(g, null);
        if (v) return {
          error: v
        };
        continue;
      }
      var c = d === true || d === null || d === "auto" ? null : parseInt(d, 10);
      if (c !== null && (isNaN(c) || c <= 0)) {
        return {
          error: "Invalid parts count for " + l + ": " + d
        };
      }
      var f = o(l, c);
      if (f) return {
        error: f
      };
    }
    return {
      boosts: a
    };
  }
  return {
    error: "compounds must be a tier number, compound name, array of compounds, or object map"
  };
}

function defaultBoostWait(e) {
  if (MILITARY_ROLES[e]) return DEFAULT_MILITARY_BOOST_WAIT;
  if (CRITICAL_SPAWN_ROLES[e]) return DEFAULT_CRITICAL_BOOST_WAIT;
  return 0;
}

function getBoostWaitLimit(e, r) {
  var a = getOrder(e, r);
  if (a && typeof a.maxBoostWait === "number") return a.maxBoostWait;
  return defaultBoostWait(r);
}

// Whether spawnManager may hold a spawn back until the boost labs are stocked.
// Off by default for roles the room cannot run without.
function shouldGateSpawn(e, r) {
  var a = getOrder(e, r);
  if (!a || !a.active || a.stopping) return false;
  if (a.gateSpawn !== undefined) return !!a.gateSpawn;
  return !CRITICAL_SPAWN_ROLES[r];
}

function boostMoveTo(e, r, a) {
  if (e.fatigue > 0) return;
  e.moveTo(r, {
    range: a,
    reusePath: 5
  });
}

// Places a boost order for any role. Subsystems call this directly;
// global.boost() is the console wrapper.
function requestBoost(e, r, a, o, t) {
  if (typeof e !== "string" || typeof r !== "string") {
    return "[BoostManager] Usage: boost(roomName, role, tier|compound|[compounds]|{compound:parts}, [body], [opts])";
  }
  var n = Game.rooms[e];
  if (!n || !n.controller || !n.controller.my) return "[BoostManager] No owned room: " + e;
  var s = normalizeBoostSpec(a, r);
  if (s.error) return "[BoostManager] " + s.error;
  var i = s.boosts;
  var u = Object.keys(i);
  if (u.length === 0) return "[BoostManager] No compounds requested";
  var l = _getLabs(n);
  if (l.length < u.length) {
    return "[BoostManager] Need " + u.length + " lab(s) but room has " + l.length;
  }
  var d = {};
  for (var g = 0; g < u.length; g++) {
    var v = getPartTypeForCompound(u[g]);
    if (d[v]) {
      return "[BoostManager] " + u[g] + " and " + d[v] + " both boost " + v + " parts; only one can apply";
    }
    d[v] = u[g];
  }
  var c = getOrder(e, r);
  if (c && c.boosts) {
    for (var f in c.boosts) opportunisticBuy.cancelRequest(e, f);
  }
  t = t || {};
  var m = o ? bodyCost(o) : 0;
  var b = {
    active: true,
    stopping: false,
    boosts: i,
    body: o || null,
    bodyCost: m,
    batchSize: t.batchSize || DEFAULT_BATCH_SIZE,
    reorderAt: t.reorderAt || DEFAULT_REORDER_AT,
    maxLabFraction: t.maxLabFraction != null ? t.maxLabFraction : Math.min(MAX_BOOST_LAB_FRACTION, 1 / u.length),
    allowUnboost: t.allowUnboost !== undefined ? !!t.allowUnboost : !MILITARY_ROLES[r],
    maxBoostWait: t.maxBoostWait !== undefined ? t.maxBoostWait : defaultBoostWait(r),
    gateSpawn: t.gateSpawn !== undefined ? !!t.gateSpawn : !CRITICAL_SPAWN_ROLES[r],
    boostsCompleted: 0,
    purchaseSetup: {},
    buyOrderIds: {},
    pendingBuyOrders: {},
    lastPurchaseCheck: 0,
    _pendingBoosts: {},
    created: Game.time
  };
  setOrder(e, r, b);
  resolveOrderParts(e, r, b);
  updateReservations(e);
  var p = Math.floor(l.length * b.maxLabFraction);
  if (p < 1) p = 1;
  var O = [ "[BoostManager] Enabled " + r + " boosting in " + e ];
  O.push("  Body: " + (o ? o.length + " parts, cost " + m : "dynamic (spawnManager body for '" + r + "')"));
  O.push("  Batch: " + b.batchSize + " boosts, reorder at " + b.reorderAt);
  O.push("  Max boost labs: " + p + " (of " + l.length + " total)");
  O.push("  Unboost at low TTL: " + (b.allowUnboost ? "yes" : "no") + " | Max boost wait: " + (b.maxBoostWait || "unlimited") + " | Hold spawn for labs: " + (b.gateSpawn ? "yes" : "no"));
  for (var R in i) {
    var T = i[R].parts;
    if (!(T > 0)) {
      O.push("  " + R + ": WARNING no " + (getPartTypeForCompound(R) || "?") + " parts in the resolved body — this compound will be skipped");
      continue;
    }
    var _ = b.batchSize * compoundPerBoost(T);
    var y = getRoomCompound(n, R);
    var B = getBoostFillTarget(T);
    O.push("  " + R + " x" + T + " parts" + (i[R].auto ? " (auto)" : "") + ": have " + y + "/" + _ + " (" + compoundPerBoost(T) + "/boost x " + b.batchSize + ")" + " | fill target: " + B + "/" + LAB_MINERAL_CAPACITY);
    O.push("    with " + p + " labs: " + p * Math.floor(B / compoundPerBoost(T)) + " boosts between refills");
  }
  return O.join("\n");
}

// Moves the creep to a stocked boost lab and applies one compound per tick.
// Returns true when the tick was consumed; false lets the role run this tick.
function runCreepBoosting(e) {
  var r = e.memory;
  if (!r.boostLabs) {
    r.needsBoost = false;
    return false;
  }
  if (!r.boosted) r.boosted = {};
  var a = boostRoleKey(e);
  var o = homeRoomOf(e);
  var t = null;
  for (var n in r.boostLabs) {
    if (r.boosted[n]) continue;
    var s = toLabIds(r.boostLabs[n]);
    if (s.length === 0) {
      r.boosted[n] = true;
      console.log("[BoostManager] No labs for " + e.name + ", skipping " + n);
      continue;
    }
    var i = unboostedPartCount(e, n);
    if (i === 0) {
      r.boosted[n] = true;
      continue;
    }
    t = {
      compound: n,
      labIds: s,
      need: i
    };
    break;
  }
  if (!t) {
    r.needsBoost = false;
    delete r.boostWait;
    return false;
  }
  var u = null;
  var l = 0;
  var d = null;
  for (var g = 0; g < t.labIds.length; g++) {
    var v = Game.getObjectById(t.labIds[g]);
    if (!v) continue;
    if (!d) d = v;
    if (v.mineralType !== t.compound) continue;
    var c = Math.floor((v.mineralAmount || 0) / COMPOUND_PER_PART);
    var f = Math.floor((v.store ? v.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0) / ENERGY_PER_PART);
    var m = Math.min(c, f, t.need);
    if (m > l) {
      l = m;
      u = v;
    }
    if (l >= t.need) break;
  }
  if (u) {
    if (e.pos.isNearTo(u)) {
      var b = u.boostCreep(e, l);
      if (b === OK) {
        delete r.boostWait;
        if (l >= t.need) {
          r.boosted[t.compound] = true;
          recordBoost(o, a, t.compound);
        }
        e.say("💪");
      } else if (b === ERR_NOT_FOUND) {
        r.boosted[t.compound] = true;
      } else if (Game.time % 10 === 0) {
        console.log("[BoostManager] boostCreep failed for " + e.name + " (" + t.compound + "): " + b);
      }
    } else {
      boostMoveTo(e, u, 1);
      e.say("🧪");
    }
    return true;
  }
  r.boostWait = (r.boostWait || 0) + 1;
  var p = getBoostWaitLimit(o, a);
  if (p > 0 && r.boostWait > p) {
    r.needsBoost = false;
    delete r.boostWait;
    console.log("[BoostManager] " + e.name + " gave up waiting for " + t.compound + " after " + p + " ticks; running unboosted");
    return false;
  }
  if (d && !e.pos.inRangeTo(d, 3)) boostMoveTo(e, d, 3);
  e.say("⏳");
  return true;
}

// Returns half the compound to a boost lab before the creep dies.
function runCreepUnboosting(e) {
  var r = e.memory;
  var a = boostRoleKey(e);
  var o = homeRoomOf(e);
  if (r.allowUnboost === false || e.room.name !== o || !shouldUnboost(o, a)) {
    r.unboosted = true;
    return false;
  }
  var t = getUnboostTarget(o, a, r.boosted);
  var n = t ? Game.getObjectById(t.labId) : null;
  if (!n) {
    r.unboosted = true;
    return false;
  }
  if (e.pos.isNearTo(n)) {
    var s = n.unboostCreep(e);
    if (s === OK) {
      if (!r.unboostDone) r.unboostDone = {};
      r.unboostDone[t.compound] = true;
      delete r.boosted[t.compound];
      console.log("[BoostManager] Unboosted " + e.name + " (" + t.compound + ") into lab " + n.id.substr(-4));
    } else if (s === ERR_NOT_FOUND) {
      delete r.boosted[t.compound];
    } else if (Game.time % 5 === 0) {
      console.log("[BoostManager] unboostCreep failed for " + e.name + ": " + s);
    }
  } else {
    boostMoveTo(e, n, 1);
    e.say("♻️");
  }
  return true;
}

// Attaches a boost manifest to a creep spawned by a path that does not inject
// one itself. Bounded to the creep's first NEWBORN_TTL_SLACK ticks so an order
// placed mid-life never diverts creeps already at work.
function attachBoostMeta(e) {
  if (!global.__boostActive) return false;
  var r = e.ticksToLive;
  // Cheapest rejections first: this runs for every creep on every tick while
  // any boost order exists, so the body scan comes last.
  if (typeof r !== "number" || r < CREEP_CLAIM_LIFE_TIME - NEWBORN_TTL_SLACK) return false;
  var a = homeRoomOf(e);
  var o = getActiveOrders(a);
  var t = null;
  if (e.memory.boostRole && o[e.memory.boostRole]) t = e.memory.boostRole; else if (e.memory.role && o[e.memory.role]) t = e.memory.role; else if (e.memory.demolitionRole && o[e.memory.demolitionRole]) t = e.memory.demolitionRole;
  if (!t) return false;
  // A body carrying CLAIM lives CREEP_CLAIM_LIFE_TIME, so a high TTL alone
  // does not prove youth for those.
  if (r < CREEP_LIFE_TIME - NEWBORN_TTL_SLACK && countBodyParts(e.body, CLAIM) === 0) return false;
  var n = getSpawnBoostMeta(a, t);
  if (!n) return false;
  e.memory.needsBoost = true;
  e.memory.boostLabs = n.boostLabs;
  e.memory.boosted = {};
  e.memory.boostRole = t;
  e.memory.allowUnboost = n.allowUnboost;
  memoryManager.requestSave();
  console.log("[BoostManager] Attached boost manifest to " + e.name + " (" + t + " in " + a + ")");
  return true;
}

// Single creep-side entrypoint, called from main.js before role dispatch.
// True means the creep spent its tick boosting or unboosting.
function handleCreep(e) {
  var r = e.memory;
  if (!r) return false;
  if (r.needsBoost) return runCreepBoosting(e);
  if (r.boosted) {
    if (r.unboosted) return false;
    if (typeof e.ticksToLive !== "number" || e.ticksToLive >= UNBOOST_TTL_THRESHOLD) return false;
    return runCreepUnboosting(e);
  }
  return attachBoostMeta(e) ? runCreepBoosting(e) : false;
}

function run() {
  ensureRoot();
  refreshTickCache();
  global.__boostActive = _hasAnyOrders;
  if (!Memory.boostManager._v2migration) {
    var e = [ "XZHO2", "ZHO2" ];
    for (var r in Game.rooms) {
      var a = Game.rooms[r];
      if (!a || !a.controller || !a.controller.my) continue;
      for (var o = 0; o < e.length; o++) {
        var t = e[o];
        storageManager.unReserve(r, t, "terminal", "boostManager_cleanup");
        storageManager.unReserve(r, t, "storage", "boostManager_cleanup");
        storageManager.unReserve(r, t, "terminal", "boostManager");
        storageManager.unReserve(r, t, "storage", "boostManager");
      }
    }
    Memory.boostManager._v2migration = true;
    console.log("[BoostManager] Migration: cleared stale XZHO2/ZHO2 reservations.");
  }
  if (!_hasAnyOrders) return;
  var n = Memory.boostManager.orders;
  var s = Memory.boostManager.lastReservationUpdateTick === null || Memory.boostManager.lastReservationUpdateTick > Game.time || Game.time - Memory.boostManager.lastReservationUpdateTick >= 50;
  for (var i in n) {
    var u = Game.rooms[i];
    if (!u || !u.controller || !u.controller.my) continue;
    if (roomSuspender.shouldAvoidRoomWork(i)) continue;
    var l = n[i];
    for (var d in l) {
      var g = l[d];
      if (!g) continue;
      migrateLabIds(g);
      if (g.stopping) {
        handleStopping(i, d, g);
        continue;
      }
      if (!g.active) continue;
      resolveOrderParts(i, d, g);
      ensureLabsAllocated(u, g);
      handlePurchasing(i, g);
    }
    if (s) updateReservations(i);
  }
  if (s) {
    Memory.boostManager.lastReservationUpdateTick = Game.time;
    memoryManager.requestSave();
  }
}

function installConsole() {
  global.boost = requestBoost;
  global.boostUpgrader = function(e, r) {
    r = parseInt(r, 10);
    var a = UPGRADER_TIERS[r];
    if (!a) return "[BoostManager] Invalid tier. Use 1 (GH +50%), 2 (GH2O +80%), 3 (XGH2O +100%)";
    var o = {};
    o[a.compound] = 15;
    return global.boost(e, "upgrader", o, UPGRADER_BOOST_BODY);
  };
  global.boostRampartBot = function(e, r) {
    r = parseInt(r, 10);
    var a = RAMPARTBOT_TIERS[r];
    if (!a) return "[BoostManager] Invalid tier. Use 1 (LH +50%), 2 (LH2O +80%), 3 (XLH2O +100%)";
    var o = {};
    o[a.compound] = 21;
    return global.boost(e, "rampartBot", o, RAMPARTBOT_BOOST_BODY);
  };
  //   Tier 1: ZH    → 2× dismantle (100 hits/tick per WORK part)
  //   Tier 2: ZH2O  → 3× dismantle (150 hits/tick per WORK part)
  //   Tier 3: XZH2O → 4× dismantle (200 hits/tick per WORK part)
  global.boostDemolisher = function(e, r) {
    r = parseInt(r, 10);
    var a = DEMOLISHER_TIERS[r];
    if (!a) return "[BoostManager] Invalid tier. Use 1 (ZH 2×), 2 (ZH2O 3×), 3 (XZH2O 4×)";
    var o = {};
    o[a.compound] = 36;
    return global.boost(e, "demolisher", o, DEMOLISHER_BOOST_BODY, {
      maxLabFraction: 1
    });
  };
  global.stopBoost = function(e, r) {
    if (typeof e !== "string" || typeof r !== "string") {
      return "[BoostManager] Usage: stopBoost(roomName, role)";
    }
    var a = getOrder(e, r);
    if (!a) return "[BoostManager] No boost order for " + r + " in " + e;
    a.stopping = true;
    a.active = false;
    _cacheTick = 0;
    updateReservations(e);
    return "[BoostManager] Stopping " + r + " boost in " + e + ". LabBot will empty boost labs.";
  };
  global.boostStatus = function(e, r) {
    ensureRoot();
    var a = Memory.boostManager.orders;
    if (Object.keys(a).length === 0) {
      return "[BoostManager] No active boost orders";
    }
    var o = [];
    for (var t in a) {
      if (e && t !== e) continue;
      var n = a[t];
      for (var s in n) {
        if (r && s !== r) continue;
        var i = n[s];
        migrateLabIds(i);
        var u = i.stopping ? "STOPPING" : i.active ? "ACTIVE" : "INACTIVE";
        o.push("[BoostManager] " + t + " / " + s + ": " + u + " | Boosts done: " + (i.boostsCompleted || 0) + " | Unboost: " + (i.allowUnboost === false ? "no" : "yes") + " | Max wait: " + (i.maxBoostWait || "unlimited"));
        for (var l in i.boosts) {
          var d = i.boosts[l];
          var g = Game.rooms[t];
          var v = g ? getRoomCompound(g, l) : "?";
          var c = (i.batchSize || DEFAULT_BATCH_SIZE) * compoundPerBoost(d.parts);
          var f = compoundPerBoost(d.parts);
          var m = energyPerBoost(d.parts);
          var b = getBoostFillTarget(d.parts);
          var p = [];
          var O = 0;
          for (var R = 0; R < d.labIds.length; R++) {
            var T = Game.getObjectById(d.labIds[R]);
            if (!T) {
              p.push("destroyed");
              continue;
            }
            var _ = T.mineralType === l ? T.mineralAmount || 0 : 0;
            var y = T.store ? T.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
            var B = T.mineralType && T.mineralType !== l && (T.mineralAmount || 0) > 0;
            var M = Math.min(Math.floor(_ / f), Math.floor(y / m));
            var h = T.cooldown && T.cooldown > 0 ? "[CD:" + T.cooldown + "]" : "";
            if (_ >= f && y >= m) O++;
            p.push(T.id.substr(-4) + ":" + _ + "/" + y + (B ? "[BLOCKED]" : "") + h + "(" + M + " boosts)");
          }
          var A = i.buyOrderIds && i.buyOrderIds[l] ? " | Buy order: " + i.buyOrderIds[l] : "";
          o.push("  " + l + " ×" + d.parts + " parts" + (d.auto ? " (auto)" : "") + ": " + v + "/" + c + " in room | " + d.labIds.length + " labs (" + O + " ready)" + " | fill:" + b + "/3000" + A);
          o.push("    " + p.join(" | "));
        }
        o.push("  Body: " + (i.body ? i.body.length + " parts, cost " + (i.bodyCost || "?") : "dynamic"));
      }
    }
    return o.join("\n");
  };
}

installConsole();
module.exports = {
  run: run,
  requestBoost: requestBoost,
  handleCreep: handleCreep,
  shouldGateSpawn: shouldGateSpawn,
  runCreepBoosting: runCreepBoosting,
  runCreepUnboosting: runCreepUnboosting,
  getPartTypeForCompound: getPartTypeForCompound,
  countBodyParts: countBodyParts,
  compoundForTier: compoundForTier,
  BOOST_ACTIONS: BOOST_ACTIONS,
  DEFAULT_BOOST_ACTION: DEFAULT_BOOST_ACTION,
  MILITARY_ROLES: MILITARY_ROLES,
  isActive: isActive,
  isStopping: isStopping,
  areLabsReady: areLabsReady,
  getBody: getBody,
  getBodyCost: getBodyCost,
  getSpawnBoostMeta: getSpawnBoostMeta,
  getLabWork: getLabWork,
  needsLabBot: needsLabBot,
  getActiveOrders: getActiveOrders,
  getOrder: getOrder,
  recordBoost: recordBoost,
  installConsole: installConsole,
  shouldUnboost: shouldUnboost,
  getUnboostTarget: getUnboostTarget,
  getUnboostTTL: getUnboostTTL,
  COMPOUND_PER_PART: COMPOUND_PER_PART,
  ENERGY_PER_PART: ENERGY_PER_PART,
  UNBOOST_RETURN_PER_PART: UNBOOST_RETURN_PER_PART,
  UNBOOST_TTL_THRESHOLD: UNBOOST_TTL_THRESHOLD,
  compoundPerBoost: compoundPerBoost,
  energyPerBoost: energyPerBoost,
  getBoostFillTarget: getBoostFillTarget,
  UPGRADER_BOOST_BODY: UPGRADER_BOOST_BODY,
  UPGRADER_BOOST_COST: UPGRADER_BOOST_COST,
  UPGRADER_TIERS: UPGRADER_TIERS,
  RAMPARTBOT_BOOST_BODY: RAMPARTBOT_BOOST_BODY,
  RAMPARTBOT_BOOST_COST: RAMPARTBOT_BOOST_COST,
  RAMPARTBOT_TIERS: RAMPARTBOT_TIERS,
  DEMOLISHER_BOOST_BODY: DEMOLISHER_BOOST_BODY,
  DEMOLISHER_BOOST_COST: DEMOLISHER_BOOST_COST,
  DEMOLISHER_TIERS: DEMOLISHER_TIERS
};
