// LLM: Read docs/codex.js before reviewing or changing this file.
// marketArbitrage.js
// Console globals: marketArbitrage
// Example: marketArbitrage('scan') - Scan market for cross-room arbitrage trades
const marketSeller = require("marketSell");
const marketBatchBuy = require("marketBatchBuy");
const pricing = require("marketPricing");
const roomSuspender = require("roomSuspender");
const util = require("util");
const creditLedger = require("creditLedger");
const autoTraderSellPolicy = require("autoTraderSellPolicy");
const memoryManager = require("memoryManager");
const marketPriceAdjustment = require("marketPriceAdjustment");
const labCommodityPolicy = require("labCommodityPolicy");
const labCommodityRouter = require("labCommodityRouter");
let ENABLED = true;
let MIN_PROFIT_MARGIN = .005;
let MIN_BUY_ORDER_AMOUNT = 6;
let MIN_BUY_ORDER_PRICE = 10;
const MAX_SELLS_PER_RESOURCE = 10;
let BUFFER_TIMEOUT = 5e4;
let VERIFY_TIMEOUT = 6;
const ACCOUNT_VERIFY_TIMEOUT = 3;
const MIN_AMOUNT_PER_TERMINAL = 500;
let MAX_RESOURCE_EXPOSURE = 5e4;
const BUY_DEPTH = 3;
let MIN_ARB_BUY_VOLUME = 49;
const GHOST_SELL_COOLDOWN = 100;
const BAD_BUY_ORDER_COOLDOWN = 100;
let SELL_GHOST_FAIL_THRESHOLD = 3;
let GROUP_STALE_TICKS = 200;
const SINGLE_TERMINAL_RESOURCES = {
  ops: true
};
let MIN_SELF_ARB_PROFIT = 1;
let SELF_FULFILL_ADVANTAGE = 1.25;
let FLOOR_SWEEP_PRICE = 7;
const FLOOR_SWEEP_BANNED = {
  Z: true,
  zynthium: true,
  ops: true
};
let FLOOR_SWEEP_DEBUG = false;
const ACCOUNT_RESOURCES = {
  pixel: true,
  cpuUnlock: true,
  accessKey: true
};
function isAccountResource(e) {
  return !!ACCOUNT_RESOURCES[e];
}

function ensureMemory() {
  if (!Memory.marketArbitrage || typeof Memory.marketArbitrage !== "object") {
    Memory.marketArbitrage = {};
  }
  const e = Memory.marketArbitrage;
  if (!e.operations || typeof e.operations !== "object" || Array.isArray(e.operations)) e.operations = {};
  if (!Array.isArray(e.buffered)) e.buffered = [];
  if (!e.ghostSellOrders || typeof e.ghostSellOrders !== "object") e.ghostSellOrders = {};
  if (!e.selfArbPending || typeof e.selfArbPending !== "object") e.selfArbPending = {};
  if (e.accountOp === undefined) e.accountOp = null;
  if (!e.groups || typeof e.groups !== "object") e.groups = {};
  if (e.scanInterval !== undefined) {
    delete e.scanInterval;
    memoryManager.requestSave();
  }
  return e;
}

ensureMemory();
function orderStillLive(e, r) {
  if (marketBatchBuy.isOrderReserved && marketBatchBuy.isOrderReserved(e)) return false;
  const t = Game.market.getOrderById(e);
  const o = util.getOrderRemaining(t);
  return !!(t && o >= r);
}

function getBadBuyOrders() {
  let e = global.__marketArbBadBuyOrders;
  if (!e) e = global.__marketArbBadBuyOrders = {};
  return e;
}

function isBadBuyOrder(e) {
  if (!e) return false;
  const r = getBadBuyOrders();
  const t = r[e];
  if (t === undefined) return false;
  if (Game.time - t > BAD_BUY_ORDER_COOLDOWN) {
    delete r[e];
    return false;
  }
  return true;
}

function markBadBuyOrder(e, r) {
  if (!e) return;
  if (r !== ERR_INVALID_ARGS && r !== ERR_FULL) return;
  getBadBuyOrders()[e] = Game.time;
}

function pruneBadBuyOrders() {
  const e = getBadBuyOrders();
  for (var r in e) {
    if (Game.time - e[r] > BAD_BUY_ORDER_COOLDOWN) delete e[r];
  }
}

const getMyRooms = util.getMyRooms;
const _costFactorCache = {};
function getCostFactor(e, r) {
  const t = e + "|" + r;
  let o = _costFactorCache[t];
  if (o === undefined) {
    const i = Game.map.getRoomLinearDistance(e, r, true);
    o = 1 - Math.exp(-i / 30);
    _costFactorCache[t] = o;
  }
  return o;
}

let _powerMultiplierCache = {};
function getPowerMultiplier(e) {
  if (!e || !e.effects) return 1;
  const r = e.id;
  if (r && _powerMultiplierCache[r] !== undefined) return _powerMultiplierCache[r];
  for (var t = 0; t < e.effects.length; t++) {
    const o = e.effects[t];
    if (o.effect === PWR_OPERATE_TERMINAL && o.ticksRemaining > 0) {
      if (o.level >= 1 && o.level <= 5) {
        const e = 1 - o.level * .1;
        if (r) _powerMultiplierCache[r] = e;
        return e;
      }
      if (r) _powerMultiplierCache[r] = 1;
      return 1;
    }
  }
  if (r) _powerMultiplierCache[r] = 1;
  return 1;
}

function calcEffectiveEnergyCost(e, r, t, o) {
  if (e <= 0) return 0;
  const i = Math.ceil(e * getCostFactor(r, t));
  const n = getPowerMultiplier(o);
  return n < 1 ? Math.ceil(i * n) : i;
}

function capByEnergy(e, r, t, o, i) {
  if (o <= 0 || e <= 0) return 0;
  const n = getCostFactor(r, t) * getPowerMultiplier(i);
  if (n <= 0) return e;
  let s = Math.min(e, Math.floor(o / n));
  while (s > 0 && calcEffectiveEnergyCost(s, r, t, i) > o) s--;
  return s;
}

function capByEnergyBothLegs(e, r, t, o, i, n) {
  if (i <= 0 || e <= 0) return 0;
  const s = getPowerMultiplier(n);
  const a = (getCostFactor(r, t) + getCostFactor(r, o)) * s;
  if (a <= 0) return e;
  let c = Math.min(e, Math.floor(i / a));
  while (c > 0 && calcEffectiveEnergyCost(c, r, t, n) + calcEffectiveEnergyCost(c, r, o, n) > i) c--;
  return c;
}

function getCostBasisFloor(e) {
  if (!e || typeof e.sellPrice !== "number" || e.sellPrice <= 0) return null;
  return typeof e.costBasis === "number" && e.costBasis >= e.sellPrice ? e.costBasis : e.sellPrice;
}

function netSellPricePerUnit(e, r, t, o, i, n) {
  if (r <= 0) return -Infinity;
  const s = calcEffectiveEnergyCost(r, t, o, i);
  return e - s * n / r;
}

function terminalUsedThisTick(e, r) {
  return !!(r && r[e]) || util.wasTerminalUsed && util.wasTerminalUsed(e);
}

function markTerminalIntent(e, r) {
  if (r) r[e] = true;
  if (util.markTerminalUsed) util.markTerminalUsed(e);
}

function describeDealFailure(e, r, t, o, i, n) {
  const s = i && i.id ? i.id : "?";
  const a = i && i.roomName ? i.roomName : "?";
  const c = util.getOrderRemaining(i);
  const l = s !== "?" ? Game.market.getOrderById(s) : null;
  const u = util.getOrderRemaining(l);
  const m = n && n.store ? n.store[t] || 0 : 0;
  const f = n && n.store ? n.store[RESOURCE_ENERGY] || 0 : 0;
  const d = n && i && i.roomName ? calcEffectiveEnergyCost(o, r, i.roomName, n) : "?";
  return "result=" + e + ", resource=" + t + ", amount=" + o + ", order=" + s + ", orderRoom=" + a + ", orderAmount=" + c + ", liveOrderAmount=" + u + ", terminalStock=" + m + ", terminalEnergy=" + f + ", energyCost=" + d + ", cooldown=" + (n ? n.cooldown : "?");
}

function getOppBuyRequests() {
  const e = {};
  const r = require("opportunisticBuy");
  const t = r && typeof r.getActiveRequestEntries === "function" ? r.getActiveRequestEntries() : [];
  for (var o = 0; o < t.length; o++) {
    const r = t[o].key;
    const i = t[o].request;
    if (!i || typeof i.remaining !== "number" || i.remaining <= 0) continue;
    if (i.pending && typeof i.pending.expected === "number") continue;
    const n = i.resourceType;
    if (!e[n]) e[n] = [];
    e[n].push({
      roomName: i.roomName,
      remaining: i.remaining,
      maxPrice: i.maxPrice,
      key: r
    });
  }
  for (var i in e) {
    e[i].sort(function(e, r) {
      return r.maxPrice - e.maxPrice;
    });
  }
  return e;
}

function getLiveOppBuyRequest(e, r) {
  const t = require("opportunisticBuy");
  const o = t && e && typeof t.getRequestByKey === "function" ? t.getRequestByKey(e.key) : null;
  if (!o || o.resourceType !== r || !(o.remaining > 0)) return null;
  if (o.pending && typeof o.pending.expected === "number") return null;
  e.roomName = o.roomName;
  e.remaining = o.remaining;
  e.maxPrice = o.maxPrice;
  return o;
}

function fulfillOppBuyRequest(e, r, t) {
  if (!e || !r || !(t > 0)) return;
  const o = require("opportunisticBuy");
  const i = o && typeof o.fulfillRequestByKey === "function" ? o.fulfillRequestByKey(e.key, t) : null;
  e.remaining = i ? Math.max(0, i.remaining) : 0;
}

function findOutgoingTx(e, r, t, o) {
  const i = Game.market.outgoingTransactions;
  if (!i) return null;
  for (var n = 0; n < i.length; n++) {
    const s = i[n];
    if (s.time < o) break;
    if (s.from === e && s.resourceType === r && s.order && s.order.id === t) return s;
  }
  return null;
}

function findIncomingTx(e, r, t, o) {
  const i = Game.market.incomingTransactions;
  if (!i) return null;
  for (var n = 0; n < i.length; n++) {
    const s = i[n];
    if (s.time < o) break;
    if (s.to === e && s.resourceType === r && s.order && s.order.id === t) return s;
  }
  return null;
}

const MARKET_TRANSACTION_HISTORY_LIMIT = 100;
function transactionHistoryCovers(e, r) {
  if (!Array.isArray(e)) return false;
  if (e.length < MARKET_TRANSACTION_HISTORY_LIMIT) return true;
  const t = e[e.length - 1];
  return !!t && typeof t.time === "number" && t.time < r;
}

function markVerificationAmbiguous(e, r, t, o) {
  if (e.ambiguous) return;
  e.ambiguous = true;
  e.ambiguousTick = Game.time;
  e.ambiguousReason = "transaction history no longer covers tick " + o;
  console.log("[Arbitrage] AMBIGUOUS " + t + " in " + r + ": transaction history no longer covers " + "accepted deal tick " + o + ". Holding bookkeeping; will not retry automatically.");
  memoryManager.requestSave();
}

function clearVerificationAmbiguity(e) {
  delete e.ambiguous;
  delete e.ambiguousTick;
  delete e.ambiguousReason;
}

function groupExpectedCount(e) {
  return e.members.length - Object.keys(e.failedRooms).length;
}

function groupFailedSuffix(e) {
  const r = Object.keys(e.failedRooms);
  if (!r.length) return "";
  return " | Failed: " + r.map(function(r) {
    const t = e.failedRooms[r];
    return r + "(" + t.stage + "/" + t.reason + "," + t.amount + ")";
  }).join(", ");
}

function logBuyConfirmed(e) {
  let r = 0;
  for (var t in e.buyConfirmedRooms) r += e.buyConfirmedRooms[t];
  console.log("[Arbitrage] BUY CONFIRMED " + e.resource + " from " + e.sellRoom + " | Total: " + r + "/" + e.totalAmount + " across " + Object.keys(e.buyConfirmedRooms).length + " rooms" + groupFailedSuffix(e));
}

function logSellInitiated(e) {
  let r = 0;
  for (var t in e.sellInitRooms) r += e.sellInitRooms[t];
  console.log("[Arbitrage] SELL INITIATED " + e.resource + " | Total: " + r + "/" + e.totalAmount + " -> (" + Object.keys(e.sellRoomsActual).join(", ") + ")" + groupFailedSuffix(e));
}

function logSellConfirmed(e) {
  let r = 0, t = 0;
  for (var o in e.sellConfirmedRooms) {
    r += e.sellConfirmedRooms[o].amount;
    t += e.sellConfirmedRooms[o].profit;
  }
  console.log("[Arbitrage] SELL CONFIRMED " + e.resource + " -> " + e.buyRoom + " | Total: " + r + "/" + e.totalAmount + " | Realized Profit: " + t.toFixed(2) + " (" + (e.margin * 100).toFixed(1) + "%)" + groupFailedSuffix(e));
}

function checkStaleGroups() {
  const e = Memory.marketArbitrage.groups;
  if (!e) return;
  for (var r in e) {
    const o = e[r];
    const i = Game.time - o.createdTick;
    if (i < GROUP_STALE_TICKS) continue;
    if ((i - GROUP_STALE_TICKS) % 100 !== 0) continue;
    const n = [], s = [];
    for (var t = 0; t < o.members.length; t++) {
      const e = o.members[t];
      if (o.failedRooms[e]) continue;
      if (!o.buyConfirmedRooms[e]) {
        n.push(e);
        continue;
      }
      if (!o.sellConfirmedRooms[e]) s.push(e);
    }
    console.log("[Arbitrage] GROUP STALE (" + i + "t) " + o.resource + " " + o.sellRoom + "->" + o.buyRoom + (n.length ? " | Waiting on buy: (" + n.join(", ") + ")" : "") + (s.length ? " | Waiting on sell: (" + s.join(", ") + ")" : "") + groupFailedSuffix(o));
  }
}

function cleanupGroups(e) {
  const r = Memory.marketArbitrage.groups;
  if (!r) return;
  const t = {};
  for (var o in e) {
    const r = e[o];
    if (r && r.groupKey) t[r.groupKey] = true;
  }
  for (var i in r) {
    const e = r[i];
    const o = groupExpectedCount(e);
    const n = Object.keys(e.sellConfirmedRooms).length;
    if (o <= 0 || n >= o || !t[i]) {
      delete r[i];
    }
  }
}

let _historyCache = {};
let _cachedOppBuyRequests = {};
let _cachedEnergyPrice = 0;
let _cachedBooks = null;
let _usedBuyOrdersTick = -1;
let _usedBuyOrders = {};
function getUsedBuyOrdersThisTick() {
  if (_usedBuyOrdersTick !== Game.time) {
    _usedBuyOrdersTick = Game.time;
    _usedBuyOrders = {};
  }
  return _usedBuyOrders;
}

function configuredSellFloor(e) {
  return autoTraderSellPolicy && typeof autoTraderSellPolicy.getFloor === "function" ? autoTraderSellPolicy.getFloor(e) : 0;
}

function getCanonicalEnergyPrice() {
  const e = pricing.getStatusEnergyPrice();
  return e > 0 ? e : 0;
}

function recordBuyOrderIntent(e, r, t) {
  if (!e || !(r > 0)) return;
  const o = getUsedBuyOrdersThisTick();
  o[e] = (o[e] || 0) + r;
  if (t) {
    t[e] = (t[e] || 0) + r;
  }
}

function getHistoryCap(e, r) {
  if (_historyCache[e] === undefined) {
    const r = pricing.getPriceProfile(e);
    _historyCache[e] = r && r.marketPrice !== null ? r.marketPrice : null;
  }
  const t = _historyCache[e];
  if (t === null) return r <= 1 ? 0 : Infinity;
  return t * r;
}

function getOwnSellResources() {
  const e = {};
  const r = Game.market.orders;
  if (!r) return e;
  for (var t in r) {
    const o = r[t];
    if (o && o.type === ORDER_SELL && o.active && util.getOrderRemaining(o) > 0) {
      e[o.resourceType] = true;
    }
  }
  return e;
}

function buildOrderBooks(e, r) {
  const t = pricing.getRawOrders();
  const o = Game.market.orders || {};
  const i = {};
  const n = {};
  const s = [];
  const a = {};
  const c = {};
  const l = Memory.marketArbitrage.ghostSellOrders;
  function keepCheapestSell(e, r) {
    if (e.length < MAX_SELLS_PER_RESOURCE) {
      e.push(r);
      return;
    }
    let t = 0;
    let o = e[0].price;
    for (var i = 1; i < e.length; i++) {
      if (e[i].price > o) {
        o = e[i].price;
        t = i;
      }
    }
    if (r.price < o) e[t] = r;
  }
  for (var u = 0; u < t.length; u++) {
    const r = t[u];
    if (!r || r.resourceType === RESOURCE_ENERGY) continue;
    if (o[r.id]) continue;
    const n = isAccountResource(r.resourceType);
    if (r.type === ORDER_BUY) {
      const t = util.getOrderRemaining(r);
      if (t < MIN_BUY_ORDER_AMOUNT) continue;
      if (isBadBuyOrder(r.id)) continue;
      if (r.roomName && e[r.roomName]) continue;
      if (!n && r.price < MIN_BUY_ORDER_PRICE) continue;
      if (!n && r.price < configuredSellFloor(r.resourceType)) continue;
      if (!i[r.resourceType]) i[r.resourceType] = [];
      i[r.resourceType].push(r);
      if (r.price > (a[r.resourceType] || 0)) {
        a[r.resourceType] = r.price;
      }
    } else if (r.type === ORDER_SELL && util.getOrderRemaining(r) > 0 && !(r.roomName && e[r.roomName])) {
      if (!n && l && l[r.id] && Game.time - l[r.id] <= GHOST_SELL_COOLDOWN) continue;
      s.push(r);
      if (FLOOR_SWEEP_PRICE > 0 && r.price <= FLOOR_SWEEP_PRICE) {
        c[r.resourceType] = true;
      }
    }
  }
  const m = {};
  for (var f in a) m[f] = true;
  for (var d in c) m[d] = true;
  for (var g in r) m[g] = true;
  for (var y = 0; y < s.length; y++) {
    const e = s[y];
    if (!m[e.resourceType]) continue;
    if (!isAccountResource(e.resourceType)) {
      const r = a[e.resourceType] || 0;
      if (e.price > r && e.price > FLOOR_SWEEP_PRICE) continue;
    }
    if (!n[e.resourceType]) n[e.resourceType] = [];
    keepCheapestSell(n[e.resourceType], e);
  }
  for (var d in n) {
    n[d].sort(function(e, r) {
      return e.price - r.price;
    });
  }
  return {
    sellsByRes: n,
    buysByRes: i,
    _sortedBuys: {}
  };
}

function ensureSortedBuys(e, r) {
  if (!e) return null;
  const t = e.buysByRes[r];
  if (!t || e._sortedBuys[r]) return t;
  t.sort(function(e, r) {
    return r.price - e.price;
  });
  e._sortedBuys[r] = true;
  return t;
}

const CANDIDATE_LIMIT = 25;
function buildArbCandidates(e, r, t, o, i, n, s, a) {
  const c = [];
  for (var l in e.sellsByRes) {
    if (isAccountResource(l)) continue;
    if (n[l]) continue;
    if (s && s[l]) continue;
    if (SINGLE_TERMINAL_RESOURCES[l] && a[l]) continue;
    const d = i[l] || 0;
    const g = MAX_RESOURCE_EXPOSURE - d;
    if (g <= 0) continue;
    const y = e.sellsByRes[l];
    if (!y || !y.length) continue;
    const p = ensureSortedBuys(e, l);
    const b = [];
    if (p) {
      for (var u = 0; u < p.length && b.length < BUY_DEPTH; u++) {
        const e = p[u];
        if (isBadBuyOrder(e.id)) continue;
        const r = util.getOrderRemaining(e) - (t[e.id] || 0);
        if (r > 0) b.push({
          order: e,
          available: r
        });
      }
    }
    if (b.length === 0) continue;
    const O = b[0].order;
    let A = 0;
    for (var m = 0; m < b.length; m++) A += b[m].available;
    if (r && r[l] && r[l].length > 0) {
      const e = r[l][0].maxPrice;
      const t = y[0].price;
      if (t <= e) {
        if (O.price < e * SELF_FULFILL_ADVANTAGE) continue;
      }
    }
    const E = getHistoryCap(l, 1.5);
    for (var f = 0; f < y.length; f++) {
      const e = y[f];
      if (e.price > E) break;
      if (e.price >= O.price) break;
      if (e.roomName && O.roomName && e.roomName === O.roomName) continue;
      const r = o[e.id] || 0;
      const t = Game.market.getOrderById(e.id);
      const i = util.getOrderRemaining(t);
      if (i <= 0) continue;
      const n = Math.min(util.getOrderRemaining(e), i) - r;
      if (n <= 0) continue;
      const s = (O.price - e.price) / e.price;
      if (s <= MIN_PROFIT_MARGIN) break;
      if (A < MIN_ARB_BUY_VOLUME) break;
      c.push({
        resource: l,
        sell: e,
        buy: O,
        buyDepth: b,
        sellAvailable: n,
        buyAvailable: A,
        exposureRoom: g,
        roughMargin: s
      });
      break;
    }
  }
  c.sort(function(e, r) {
    return r.roughMargin - e.roughMargin;
  });
  if (c.length > CANDIDATE_LIMIT) c.length = CANDIDATE_LIMIT;
  return c;
}

function evaluateCandidate(e, r, t, o, i) {
  const n = e.resource;
  if (SINGLE_TERMINAL_RESOURCES[n] && i[n]) return null;
  if (e.sellAvailable <= 0 || e.buyAvailable <= 0 || e.exposureRoom <= 0) return null;
  const s = r.room.name;
  const a = r.store[RESOURCE_ENERGY] || 0;
  const c = r.store.getFreeCapacity() || 0;
  const l = creditLedger.available();
  if (c <= 0 || a < 100 || l < 1) return null;
  const u = e.sell, m = e.buy;
  let f;
  if (SINGLE_TERMINAL_RESOURCES[n] || e.sellAvailable < 50) {
    f = e.sellAvailable;
  } else {
    const r = Math.max(1, o);
    f = Math.ceil(e.sellAvailable / r);
    if (f < MIN_AMOUNT_PER_TERMINAL) {
      if (e.sellAvailable >= MIN_AMOUNT_PER_TERMINAL * r) {
        f = MIN_AMOUNT_PER_TERMINAL;
      }
    }
  }
  const d = Math.min(f, e.sellAvailable, e.buyAvailable, c, Math.floor(l / u.price), e.exposureRoom);
  if (d <= 0) return null;
  const g = capByEnergyBothLegs(d, s, u.roomName, m.roomName, a, r);
  if (g <= 0) return null;
  const y = e.buyDepth;
  if (!y || !y.length) return null;
  let p = g;
  let b = 0;
  let O = 0;
  let A = 0;
  const E = [];
  let R = null;
  for (var T = 0; T < y.length && p > 0; T++) {
    const o = y[T];
    let i = Math.min(p, o.available);
    if (i <= 0) break;
    const n = calcEffectiveEnergyCost(i, s, o.order.roomName, r);
    const a = u.price * i;
    const c = o.order.price * i;
    const l = n * t;
    const m = c - a - l;
    const f = a + l;
    const d = f > 0 ? m / f : 0;
    if (d < MIN_PROFIT_MARGIN || m <= 0) break;
    E.push({
      order: {
        id: o.order.id,
        roomName: o.order.roomName,
        price: o.order.price
      },
      amount: i
    });
    if (!R) {
      R = {
        id: o.order.id,
        roomName: o.order.roomName,
        price: o.order.price,
        amount: e.buyAvailable
      };
    }
    b += c;
    O += n;
    A += a;
    p -= i;
  }
  const _ = g - p;
  if (_ <= 0 || !R) return null;
  const B = calcEffectiveEnergyCost(_, s, u.roomName, r);
  const I = (B + O) * t;
  const k = A + I;
  const S = b - k;
  const h = k > 0 ? S / k : 0;
  if (h < MIN_PROFIT_MARGIN || S <= 0) return null;
  return {
    resourceType: n,
    sellOrder: {
      id: u.id,
      roomName: u.roomName,
      price: u.price,
      amount: util.getOrderRemaining(u)
    },
    buyOrder: R,
    buyDepthAllocation: E,
    amount: _,
    creditCost: A,
    creditRevenue: b,
    buyEnergy: B,
    sellEnergy: O,
    energyCostCr: I,
    profit: S,
    margin: h
  };
}

function cachedOpportunityStillValid(e, r, t, o) {
  if (!e || !r) return false;
  if (t && t[e.sell.id]) return false;
  if (SINGLE_TERMINAL_RESOURCES[e.resource] && o[e.resource]) return false;
  if (e.sellAvailable < r.amount) return false;
  if (e.buyAvailable < r.amount) return false;
  if (e.exposureRoom < r.amount) return false;
  return true;
}

function findFloorSweepOpportunity(e, r, t, o, i, n, s, a) {
  if (FLOOR_SWEEP_PRICE <= 0) return null;
  const c = e.room.name;
  const l = e.store[RESOURCE_ENERGY] || 0;
  const u = e.store.getFreeCapacity() || 0;
  const m = creditLedger.available();
  if (u <= 0 || l < 100 || m < 1) {
    if (FLOOR_SWEEP_DEBUG) console.log("[Arbitrage][SweepDBG] " + c + ": early exit cap=" + u + " energy=" + l + " cr=" + m.toFixed(1));
    return null;
  }
  let f = null, d = 0;
  for (var g in r.sellsByRes) {
    if (g === RESOURCE_ENERGY) continue;
    if (isAccountResource(g)) continue;
    if (FLOOR_SWEEP_BANNED[g]) {
      if (FLOOR_SWEEP_DEBUG) console.log("[Arbitrage][SweepDBG] " + g + ": skip banned");
      continue;
    }
    if (SINGLE_TERMINAL_RESOURCES[g] && a[g]) {
      if (FLOOR_SWEEP_DEBUG) console.log("[Arbitrage][SweepDBG] " + g + ": skip single-terminal in-flight");
      continue;
    }
    const s = i[g] || 0;
    const b = MAX_RESOURCE_EXPOSURE - s;
    if (b <= 0) {
      if (FLOOR_SWEEP_DEBUG) console.log("[Arbitrage][SweepDBG] " + g + ": skip exposure cap " + s);
      continue;
    }
    const O = r.sellsByRes[g];
    if (!O || !O.length) continue;
    if (FLOOR_SWEEP_DEBUG && O[0] && O[0].price <= FLOOR_SWEEP_PRICE) {
      console.log("[Arbitrage][SweepDBG] " + g + ": cheapest=" + O[0].price + " room=" + O[0].roomName + " amt=" + util.getOrderRemaining(O[0]) + (n[g] ? " (already buffered)" : ""));
    }
    for (var y = 0; y < O.length; y++) {
      const i = O[y];
      if (i.price > FLOOR_SWEEP_PRICE) break;
      const n = o[i.id] || 0;
      const s = Game.market.getOrderById(i.id);
      const a = util.getOrderRemaining(s);
      if (a <= 0) continue;
      const A = Math.min(util.getOrderRemaining(i), a) - n;
      if (A <= 0) continue;
      const E = i.price > 0 ? Math.floor(m / i.price) : A;
      const R = Math.min(A, u, E, b);
      if (R <= 0) {
        if (FLOOR_SWEEP_DEBUG) console.log("[Arbitrage][SweepDBG] " + g + ": maxAmt=0 avail=" + A + " cap=" + u + " creditCap=" + E);
        continue;
      }
      const T = capByEnergy(R, c, i.roomName, l, e);
      if (T <= 0) {
        if (FLOOR_SWEEP_DEBUG) console.log("[Arbitrage][SweepDBG] " + g + ": energy too low for any amount (avail=" + l + " cost1=" + calcEffectiveEnergyCost(1, c, i.roomName, e) + "/unit)");
        continue;
      }
      const _ = calcEffectiveEnergyCost(T, c, i.roomName, e);
      const B = i.price + _ * t / T;
      const I = B * (1 + MIN_PROFIT_MARGIN);
      let k = false;
      const S = r.buysByRes[g];
      if (S) {
        for (var p = 0; p < S.length; p++) {
          if (S[p].price >= I) {
            k = true;
            break;
          }
        }
      }
      if (!k) {
        const e = getHistoryCap(g, 1.5);
        if (e < I) {
          if (FLOOR_SWEEP_DEBUG) console.log("[Arbitrage][SweepDBG] " + g + ": no exit: basis=" + B.toFixed(3) + " minSell=" + I.toFixed(3) + " histCap=" + (e === Infinity ? "Inf" : e.toFixed(3)) + " energy=" + _ + "@" + t.toFixed(2) + "cr");
          continue;
        }
      }
      if (T > d) {
        d = T;
        f = {
          resourceType: g,
          sellOrder: {
            id: i.id,
            roomName: i.roomName,
            price: i.price,
            amount: util.getOrderRemaining(i)
          },
          amount: T,
          creditCost: i.price * T,
          buyEnergy: _,
          costBasis: B
        };
      }
    }
  }
  if (FLOOR_SWEEP_DEBUG && !f) console.log("[Arbitrage][SweepDBG] " + c + ": no sweep opportunity found");
  return f;
}

function reconcileSelfArbPending(e) {
  const r = Memory.marketArbitrage.selfArbPending;
  for (var t in r) {
    const o = r[t];
    const i = findOutgoingTx(t, o.resourceType, o.buyOrderId, o.tick);
    if (i) {
      clearVerificationAmbiguity(o);
      const n = Game.rooms[t] && Game.rooms[t].terminal;
      const s = (o.buyPrice - o.ourSellPrice) * i.amount - calcEffectiveEnergyCost(i.amount, t, o.buyOrderRoom, n) * e;
      console.log("[Arbitrage] SELF-ARB verified: sold " + i.amount + " " + o.resourceType + " from " + t + " @ " + o.buyPrice + " (was listed @ " + o.ourSellPrice + ") | Profit: " + s.toFixed(2));
      const a = Game.market.getOrderById(o.ourSellOrderId);
      if (a) {
        const e = util.getOrderRemaining(a);
        const r = Game.rooms[t] && Game.rooms[t].terminal;
        const i = r ? r.store[o.resourceType] || 0 : 0;
        if (i < e) {
          Game.market.cancelOrder(o.ourSellOrderId);
          console.log("[Arbitrage] Cancelled own sell order " + o.ourSellOrderId + " (only " + i + " left, order wants " + e + ")");
        }
      }
      delete r[t];
      continue;
    }
    if (Game.time - o.tick >= VERIFY_TIMEOUT) {
      if (o.ambiguous) continue;
      if (!transactionHistoryCovers(Game.market.outgoingTransactions, o.tick)) {
        markVerificationAmbiguous(o, t, "SELF-ARB SELL", o.tick);
        continue;
      }
      console.log("[Arbitrage] SELF-ARB ghost in " + t + ": " + o.amount + " " + o.resourceType + " -- no outgoing tx. Cleaning up.");
      delete r[t];
    }
  }
}

function processOwnSellOrders(e, r, t, o, i, n) {
  const s = Memory.marketArbitrage.selfArbPending;
  const a = Memory.marketArbitrage.operations;
  const c = Game.market.orders;
  if (!c) return;
  for (var l in c) {
    const t = c[l];
    if (!t || t.type !== ORDER_SELL || !t.active) continue;
    if (marketPriceAdjustment.isProtectedOrder(l)) continue;
    if (t.resourceType === RESOURCE_ENERGY) continue;
    const f = util.getOrderRemaining(t);
    if (f <= 0) continue;
    if (isAccountResource(t.resourceType)) continue;
    const d = t.roomName;
    if (roomSuspender.shouldAvoidRoomWork(d)) continue;
    if (terminalUsedThisTick(d, n)) continue;
    const g = Game.rooms[d];
    const y = g && g.terminal;
    if (!y || y.cooldown > 0) continue;
    if (a[d] || s[d]) continue;
    const p = y.store[t.resourceType] || 0;
    if (p <= 0) continue;
    const b = Math.min(f, p);
    const O = y.store[RESOURCE_ENERGY] || 0;
    if (O < 50) continue;
    const A = t.price;
    const E = i[t.resourceType];
    if (E) {
      for (var u = 0; u < E.length; u++) {
        const i = E[u];
        const s = getLiveOppBuyRequest(i, t.resourceType);
        if (!s || i.roomName === d || i.maxPrice < configuredSellFloor(t.resourceType)) continue;
        const a = capByEnergy(Math.min(b, i.remaining), d, i.roomName, O, y);
        if (a <= 0) continue;
        const c = calcEffectiveEnergyCost(a, d, i.roomName, y);
        const g = i.maxPrice - (a > 0 ? c * r / a : 0);
        const p = ensureSortedBuys(e, t.resourceType);
        let R = 0;
        if (p) {
          for (var m = 0; m < p.length; m++) {
            const e = p[m];
            if (isBadBuyOrder(e.id)) continue;
            const t = util.getOrderRemaining(e) - (o[e.id] || 0);
            if (t < MIN_BUY_ORDER_AMOUNT) continue;
            const i = Math.min(b, t);
            if (i <= 0) continue;
            const n = calcEffectiveEnergyCost(i, d, e.roomName, y);
            const s = e.price - n * r / i;
            if (s > R) R = s;
          }
        }
        if (g * SELF_FULFILL_ADVANTAGE > R) {
          const e = y.send(t.resourceType, a, i.roomName);
          if (e === OK) {
            console.log("[Arbitrage] OWN-SELL self-fulfill " + a + " " + t.resourceType + " -> " + i.roomName + " (maxPrice " + i.maxPrice + ", listed @ " + A + ")");
            fulfillOppBuyRequest(i, s, a);
            if (memoryManager && typeof memoryManager.requestImmediateSave === "function") {
              memoryManager.requestImmediateSave("marketArbitrage.terminalSend");
            }
            markTerminalIntent(d, n);
            const e = f - a;
            if (e <= 0) {
              Game.market.cancelOrder(l);
              console.log("[Arbitrage] Cancelled own sell order " + l + " (fully sent via self-fulfill)");
            } else if ((y.store[t.resourceType] || 0) - a < f) {
              Game.market.cancelOrder(l);
              if (marketSeller && typeof marketSeller.cancelGather === "function") marketSeller.cancelGather(l);
              console.log("[Arbitrage] Cancelled own sell order " + l + " (partially self-fulfilled; remaining listing no longer backed)");
            }
            break;
          }
        }
      }
    }
    if (terminalUsedThisTick(d, n)) continue;
    const R = ensureSortedBuys(e, t.resourceType);
    if (!R || !R.length) continue;
    let T = null, _ = 0;
    for (var m = 0; m < R.length; m++) {
      const e = R[m];
      if (isBadBuyOrder(e.id)) continue;
      if (e.price < configuredSellFloor(t.resourceType)) continue;
      if (e.price <= A) break;
      const i = util.getOrderRemaining(e) - (o[e.id] || 0);
      if (i < MIN_BUY_ORDER_AMOUNT) continue;
      const n = Math.min(b, i);
      const s = capByEnergy(n, d, e.roomName, O, y);
      if (s <= 0) continue;
      const a = calcEffectiveEnergyCost(s, d, e.roomName, y);
      const c = a * r;
      const l = (e.price - A) * s - c;
      if (l > MIN_SELF_ARB_PROFIT && l > _) {
        _ = l;
        T = {
          buyOrder: e,
          amount: s,
          energyCost: a,
          profit: l
        };
      }
    }
    if (!T) continue;
    const B = orderStillLive(T.buyOrder.id, T.amount) ? Game.market.deal(T.buyOrder.id, T.amount, d) : ERR_INVALID_ARGS;
    if (B === OK) {
      s[d] = {
        buyOrderId: T.buyOrder.id,
        buyOrderRoom: T.buyOrder.roomName,
        buyPrice: T.buyOrder.price,
        ourSellOrderId: l,
        ourSellPrice: A,
        resourceType: t.resourceType,
        amount: T.amount,
        tick: Game.time
      };
      recordBuyOrderIntent(T.buyOrder.id, T.amount, o);
      markTerminalIntent(d, n);
      console.log("[Arbitrage] SELF-ARB deal() OK " + T.amount + " " + t.resourceType + " from " + d + " (listed @ " + A + ") -> buy order @ " + T.buyOrder.price + " in " + T.buyOrder.roomName + " | Spread profit: " + T.profit.toFixed(2) + " | Energy: " + T.energyCost + " (" + (T.energyCost * r).toFixed(2) + " cr)" + " | Verifying...");
    } else {
      markBadBuyOrder(T.buyOrder.id, B);
      console.log("[Arbitrage] SELF-ARB deal failed in " + d + ": " + describeDealFailure(B, d, t.resourceType, T.amount, T.buyOrder, y));
    }
  }
}

function findAccountOpportunity(e, r, t, o, i) {
  const n = creditLedger.available();
  if (n < 1) return null;
  let s = null, a = 0;
  for (var c in e.sellsByRes) {
    if (!isAccountResource(c)) continue;
    const m = e.sellsByRes[c];
    if (!m || !m.length) continue;
    if (i && i[c]) continue;
    const f = o[c] || 0;
    const d = MAX_RESOURCE_EXPOSURE - f;
    if (d <= 0) continue;
    let g = null, y = 0;
    const p = ensureSortedBuys(e, c);
    if (p) {
      for (var l = 0; l < p.length; l++) {
        const e = p[l];
        if (isBadBuyOrder(e.id)) continue;
        const t = util.getOrderRemaining(e) - (r[e.id] || 0);
        if (t > 0) {
          g = e;
          y = t;
          break;
        }
      }
    }
    if (!g) continue;
    const b = c === "cpuUnlock" || c === "accessKey" ? 1 : 1.5;
    const O = getHistoryCap(c, b);
    for (var u = 0; u < m.length; u++) {
      const e = m[u];
      if (e.price > O) continue;
      if (e.price >= g.price) break;
      const r = t[e.id] || 0;
      const o = Game.market.getOrderById(e.id);
      const i = util.getOrderRemaining(o);
      if (i <= 0) continue;
      const l = Math.min(util.getOrderRemaining(e), i) - r;
      if (l <= 0) continue;
      const f = Math.min(l, y, Math.floor(n / e.price), d);
      if (f <= 0) continue;
      const p = e.price * f;
      const b = g.price * f;
      const A = b - p;
      const E = p > 0 ? A / p : 0;
      if (E >= MIN_PROFIT_MARGIN && A > a) {
        a = A;
        s = {
          resourceType: c,
          sellOrder: {
            id: e.id,
            roomName: e.roomName,
            price: e.price,
            amount: util.getOrderRemaining(e)
          },
          buyOrder: {
            id: g.id,
            roomName: g.roomName,
            price: g.price,
            amount: y
          },
          amount: f,
          creditCost: p,
          creditRevenue: b,
          profit: A,
          margin: E
        };
      }
    }
  }
  return s;
}

function processAccountOpVerify() {
  const e = Memory.marketArbitrage.accountOp;
  if (!e) return;
  if (e.state === "pending_buy_verify") {
    const r = Game.resources && Game.resources[e.resourceType] || 0;
    const t = r - (e.prevBalance || 0);
    if (t > 0) {
      const r = Math.min(t, e.amount);
      if (r < e.amount) {
        console.log("[Arbitrage] Account buy partial: expected " + e.amount + ", got " + r + ". Adjusting.");
        e.amount = r;
        e.profit = (e.buyPrice - e.sellPrice) * r;
        e.margin = e.sellPrice > 0 ? (e.buyPrice - e.sellPrice) / e.sellPrice : 0;
      }
      e.state = "ready_to_sell";
      delete e.buyVerifyTick;
      delete e.prevBalance;
      console.log("[Arbitrage] Account buy verified: " + r + " " + e.resourceType);
      return;
    }
    if (Game.time - e.buyVerifyTick >= ACCOUNT_VERIFY_TIMEOUT) {
      console.log("[Arbitrage] Account BUY GHOST: " + e.amount + " " + e.resourceType + " -- no balance increase after " + (Game.time - e.buyVerifyTick) + " ticks. Cleaning up.");
      if (e.sellOrderId) {
        Memory.marketArbitrage.ghostSellOrders[e.sellOrderId] = Game.time;
      }
      Memory.marketArbitrage.accountOp = null;
    }
    return;
  }
  if (e.state === "pending_sell_verify") {
    const r = Game.resources && Game.resources[e.resourceType] || 0;
    const t = (e.prevSellBalance || 0) - r;
    if (t > 0) {
      const r = Math.min(t, e.sellVerifyAmount || e.amount);
      console.log("[Arbitrage] Account VERIFIED sale of " + r + " " + e.resourceType + " @ " + (e.buyPrice || "?"));
      e.amount -= r;
      if (e.amount <= 0) {
        console.log("[Arbitrage] Account arbitrage complete for " + e.resourceType + ". Est. profit: " + e.profit.toFixed(2) + " (" + (e.margin * 100).toFixed(1) + "%)");
        Memory.marketArbitrage.accountOp = null;
      } else {
        e.state = "ready_to_sell";
        delete e.sellVerifyTick;
        delete e.sellVerifyOrderId;
        delete e.sellVerifyAmount;
        delete e.prevSellBalance;
        console.log("[Arbitrage] Account partial verify, " + e.amount + " " + e.resourceType + " remaining to sell");
      }
      return;
    }
    if (Game.time - e.sellVerifyTick >= ACCOUNT_VERIFY_TIMEOUT) {
      console.log("[Arbitrage] Account SELL GHOST: " + (e.sellVerifyAmount || "?") + " " + e.resourceType + " -- no balance decrease after " + (Game.time - e.sellVerifyTick) + " ticks.");
      e.state = "ready_to_sell";
      e.buyOrderId = null;
      delete e.sellVerifyTick;
      delete e.sellVerifyOrderId;
      delete e.sellVerifyAmount;
      delete e.prevSellBalance;
    }
    return;
  }
}

function processAccountOpSellAndScan(e, r, t, o, i, n) {
  let s = Memory.marketArbitrage.accountOp;
  if (s && s.state === "ready_to_sell") {
    const t = Game.resources && Game.resources[s.resourceType] || 0;
    const o = Math.min(s.amount, t);
    if (o <= 0) {
      console.log("[Arbitrage] Account resources gone (" + s.resourceType + "). Abandoning.");
      Memory.marketArbitrage.accountOp = null;
      s = null;
    } else {
      if (o < s.amount) {
        console.log("[Arbitrage] Account has " + t + " " + s.resourceType + ", expected " + s.amount + ". Adjusting.");
        s.amount = o;
      }
      let n = s.buyOrderId ? Game.market.getOrderById(s.buyOrderId) : null;
      let c = util.getOrderRemaining(n);
      const l = s.sellPrice * (1 + MIN_PROFIT_MARGIN);
      if (n && n.price <= l) {
        n = null;
        c = 0;
        s.buyOrderId = null;
      }
      if (!n || c <= 0) {
        console.log("[Arbitrage] Account buy order " + (s.buyOrderId || "none") + " gone. Searching replacement...");
        let t = (ensureSortedBuys(e, s.resourceType) || []).filter(function(e) {
          return util.getOrderRemaining(e) >= MIN_BUY_ORDER_AMOUNT && !(e.roomName && i[e.roomName]);
        });
        let o = null, u = 0;
        for (var a = 0; a < t.length; a++) {
          const e = t[a];
          if (isBadBuyOrder(e.id)) continue;
          const i = Game.market.getOrderById(e.id);
          const n = util.getOrderRemaining(i);
          const s = n - (r[i && i.id] || 0);
          if (s <= 0) continue;
          if (i.price > l) {
            o = i;
            u = s;
            break;
          }
        }
        if (o) {
          n = o;
          c = u;
          s.buyOrderId = o.id;
          s.buyPrice = o.price;
          s.profit = (o.price - s.sellPrice) * s.amount;
          s.margin = s.sellPrice > 0 ? (o.price - s.sellPrice) / s.sellPrice : 0;
          console.log("[Arbitrage] Account replacement: " + o.id + " @ " + o.price);
        } else {
          const e = Game.time - s.tick;
          if (e >= BUFFER_TIMEOUT) {
            console.log("[Arbitrage] Account hold timeout for " + s.amount + " " + s.resourceType + " after " + e + " ticks. Abandoning.");
            Memory.marketArbitrage.accountOp = null;
          } else {
            console.log("[Arbitrage] No account buyer for " + s.resourceType + ". Holding (" + e + "/" + BUFFER_TIMEOUT + " ticks)...");
          }
          return;
        }
      }
      const u = Math.min(s.amount, c);
      if (u <= 0) return;
      const m = !isBadBuyOrder(n.id) && orderStillLive(n.id, u) ? Game.market.deal(n.id, u) : ERR_INVALID_ARGS;
      if (m === OK) {
        s.state = "pending_sell_verify";
        s.sellVerifyTick = Game.time;
        s.sellVerifyOrderId = n.id;
        s.sellVerifyAmount = u;
        s.prevSellBalance = Game.resources && Game.resources[s.resourceType] || 0;
        recordBuyOrderIntent(n.id, u, r);
        console.log("[Arbitrage] Account deal() OK sell " + u + " " + s.resourceType + " @ " + n.price + " | Verifying...");
      } else {
        markBadBuyOrder(n.id, m);
        console.log("[Arbitrage] Account sell deal failed for " + s.resourceType);
        s.buyOrderId = null;
      }
      return;
    }
  }
  if (!s) {
    const i = findAccountOpportunity(e, r, t, o, n);
    if (!i) return;
    const s = Memory.marketArbitrage.ghostSellOrders;
    if (s && s[i.sellOrder.id]) return;
    if (orderStillLive(i.sellOrder.id, i.amount) && Game.market.deal(i.sellOrder.id, i.amount) === OK) {
      creditLedger.commit(i.amount * i.sellOrder.price);
      t[i.sellOrder.id] = (t[i.sellOrder.id] || 0) + i.amount;
      r[i.buyOrder.id] = (r[i.buyOrder.id] || 0) + i.amount;
      o[i.resourceType] = (o[i.resourceType] || 0) + i.amount;
      Memory.marketArbitrage.accountOp = {
        state: "pending_buy_verify",
        resourceType: i.resourceType,
        amount: i.amount,
        sellOrderId: i.sellOrder.id,
        sellPrice: i.sellOrder.price,
        buyOrderId: i.buyOrder.id,
        buyPrice: i.buyOrder.price,
        profit: i.profit,
        margin: i.margin,
        buyVerifyTick: Game.time,
        tick: Game.time,
        prevBalance: Game.resources && Game.resources[i.resourceType] || 0
      };
      console.log("[Arbitrage] ACCOUNT BUY " + i.amount + " " + i.resourceType + " @ " + i.sellOrder.price + " -> sell @ " + i.buyOrder.price + " | Profit: " + i.profit.toFixed(2) + " (" + (i.margin * 100).toFixed(1) + "%)" + " | Verifying buy...");
    } else {
      console.log("[Arbitrage] Account buy deal failed for " + i.resourceType);
    }
  }
}

function enterBuffered(e, r, t) {
  delete r[t];
  if (!Memory.marketArbitrage.buffered) Memory.marketArbitrage.buffered = [];
  if (typeof e.sellPrice !== "number" || e.sellPrice <= 0) {
    console.log("[Arbitrage] enterBuffered: missing/invalid sellPrice for " + e.resourceType + " in " + t + " -- dropping entry to prevent loss sale.");
    return;
  }
  const o = typeof e.costBasis === "number" && e.costBasis >= e.sellPrice ? e.costBasis : e.sellPrice;
  Memory.marketArbitrage.buffered.push({
    roomName: t,
    resourceType: e.resourceType,
    amount: e.amount,
    sellPrice: e.sellPrice,
    costBasis: o,
    bufferedTick: Game.time
  });
  console.log("[Arbitrage] BUFFERED " + e.amount + " " + e.resourceType + " in " + t + " (paid " + e.sellPrice.toFixed(3) + ", basis " + o.toFixed(3) + "). Watching for up to " + BUFFER_TIMEOUT + " ticks.");
}

function processPendingBuyVerify(e, r, t) {
  const o = findIncomingTx(t, e.resourceType, e.sellOrderId, e.buyVerifyTick);
  const i = e.groupKey && Memory.marketArbitrage.groups[e.groupKey];
  if (o) {
    clearVerificationAmbiguity(e);
    const r = o.amount;
    if (r < e.amount) {
      console.log("[Arbitrage] Buy partial fill: expected " + e.amount + ", got " + r + ". Adjusting.");
      e.amount = r;
    }
    e.state = "pending_sell";
    e.arrivedTick = Game.time;
    delete e.buyVerifyTick;
    if (i) {
      i.buyConfirmedRooms[t] = r;
      if (Object.keys(i.buyConfirmedRooms).length >= groupExpectedCount(i)) {
        logBuyConfirmed(i);
      }
    } else {
      console.log("[Arbitrage] Buy verified: " + r + " " + e.resourceType + " in " + t);
    }
    return;
  }
  if (Game.time - e.buyVerifyTick >= VERIFY_TIMEOUT) {
    if (e.ambiguous) return;
    if (!transactionHistoryCovers(Game.market.incomingTransactions, e.buyVerifyTick)) {
      markVerificationAmbiguous(e, t, "BUY", e.buyVerifyTick);
      return;
    }
    console.log("[Arbitrage] BUY GHOST in " + t + ": " + e.amount + " " + e.resourceType + " -- no incoming transaction after " + (Game.time - e.buyVerifyTick) + " ticks. Cleaning up.");
    if (e.sellOrderId) {
      Memory.marketArbitrage.ghostSellOrders[e.sellOrderId] = Game.time;
    }
    if (i) {
      i.failedRooms[t] = {
        stage: "buy",
        reason: "ghost",
        amount: e.amount,
        tick: Game.time
      };
      i.totalAmount -= e.amount;
      console.log("[Arbitrage] GROUP " + i.resource + " " + i.sellRoom + "->" + i.buyRoom + ": " + t + " FAILED at buy stage (ghost), removed from group");
      const r = groupExpectedCount(i);
      if (r <= 0 || Object.keys(i.buyConfirmedRooms).length >= r) {
        logBuyConfirmed(i);
      }
      if (r <= 0) delete Memory.marketArbitrage.groups[e.groupKey];
    }
    delete r[t];
  }
}

function processPendingVerify(e, r, t) {
  const o = findOutgoingTx(t, e.resourceType, e.verifyOrderId, e.verifyTick);
  const i = e.groupKey && Memory.marketArbitrage.groups[e.groupKey];
  if (o) {
    clearVerificationAmbiguity(e);
    const n = o.amount;
    if (!i) {
      console.log("[Arbitrage] VERIFIED sale of " + n + " " + e.resourceType + " from " + t + " @ " + (o.order ? o.order.price : "?") + " -> " + (o.to || "?"));
    }
    e.amount -= n;
    e.soldTotal = (e.soldTotal || 0) + n;
    if (e.buyDepth && e.buyDepthIndex !== undefined && e.buyDepth[e.buyDepthIndex]) {
      e.buyDepth[e.buyDepthIndex].amount -= n;
      if (e.buyDepth[e.buyDepthIndex].amount <= 0) {
        e.buyDepthIndex++;
      }
    }
    if (e.amount <= 0) {
      if (i) {
        i.sellConfirmedRooms[t] = {
          amount: e.soldTotal,
          profit: e.profit
        };
        if (Object.keys(i.sellConfirmedRooms).length >= groupExpectedCount(i)) {
          logSellConfirmed(i);
          delete Memory.marketArbitrage.groups[e.groupKey];
        }
      } else {
        console.log("[Arbitrage] Arbitrage complete in " + t + ". Est. profit: " + e.profit.toFixed(2) + " (" + (e.margin * 100).toFixed(1) + "%)");
      }
      delete r[t];
    } else {
      e.state = "pending_sell";
      delete e.verifyTick;
      delete e.verifyOrderId;
      delete e.verifyAmount;
      if (!i) console.log("[Arbitrage] Partial verify, " + e.amount + " remaining in " + t);
    }
    return;
  }
  if (Game.time - e.verifyTick >= VERIFY_TIMEOUT) {
    if (e.ambiguous) return;
    if (!transactionHistoryCovers(Game.market.outgoingTransactions, e.verifyTick)) {
      markVerificationAmbiguous(e, t, "SELL", e.verifyTick);
      return;
    }
    if (!i) {
      console.log("[Arbitrage] SELL GHOST in " + t + ": " + e.verifyAmount + " " + e.resourceType + " -- no outgoing tx after " + (Game.time - e.verifyTick) + " ticks.");
    }
    e.state = "pending_sell";
    e.buyOrderId = null;
    if (e.buyDepth && e.buyDepthIndex !== undefined && e.buyDepth[e.buyDepthIndex]) {
      e.buyDepth[e.buyDepthIndex].amount = 0;
      e.buyDepthIndex++;
    }
    delete e.verifyTick;
    delete e.verifyOrderId;
    delete e.verifyAmount;
    if (i) {
      i.sellGhostCounts[t] = (i.sellGhostCounts[t] || 0) + 1;
      if (i.sellGhostCounts[t] >= SELL_GHOST_FAIL_THRESHOLD && !i.failedRooms[t]) {
        i.failedRooms[t] = {
          stage: "sell",
          reason: "repeated-ghost",
          amount: e.amount,
          tick: Game.time
        };
        i.totalAmount -= e.amount;
        console.log("[Arbitrage] GROUP " + i.resource + " " + i.sellRoom + "->" + i.buyRoom + ": " + t + " FAILED at sell stage (" + i.sellGhostCounts[t] + " ghosts), removed from group, " + e.amount + " left in terminal");
        enterBuffered(e, r, t);
        const o = groupExpectedCount(i);
        if (o <= 0 || Object.keys(i.sellConfirmedRooms).length >= o) {
          logSellConfirmed(i);
          delete Memory.marketArbitrage.groups[e.groupKey];
        }
      }
    }
  }
}

function reconcileBufferedPending(e) {
  for (var r = e.length - 1; r >= 0; r--) {
    const t = e[r];
    if (!t || !t.pendingVerify) continue;
    const o = t.pendingVerify;
    const i = t.roomName;
    const n = findOutgoingTx(i, t.resourceType, o.orderId, o.tick);
    if (n) {
      clearVerificationAmbiguity(o);
      console.log("[Arbitrage] VERIFIED BUFFER sale of " + n.amount + " " + t.resourceType + " from " + i + " @ " + (n.order ? n.order.price : "?"));
      if (typeof o.basis === "number" && n.order && typeof n.order.price === "number" && n.order.price < o.basis) {
        console.log("[Arbitrage] WARNING: BUFFER verified sale price below basis: " + n.order.price + " < " + o.basis.toFixed(3) + " in " + i);
      }
      t.amount -= n.amount;
      delete t.pendingVerify;
      if (t.amount <= 0) {
        e.splice(r, 1);
        console.log("[Arbitrage] Buffer fully sold in " + i);
      }
      continue;
    }
    if (Game.time - o.tick < VERIFY_TIMEOUT || o.ambiguous) continue;
    if (!transactionHistoryCovers(Game.market.outgoingTransactions, o.tick)) {
      markVerificationAmbiguous(o, i, "BUFFER SELL", o.tick);
      continue;
    }
    console.log("[Arbitrage] BUFFER ghost in " + i + ". Retrying.");
    delete t.pendingVerify;
  }
}

function processBufferedEntries(e, r, t, o, i, n) {
  for (var s = e.length - 1; s >= 0; s--) {
    const l = e[s];
    const u = l.roomName;
    if (l.pendingVerify) continue;
    if (roomSuspender.shouldAvoidRoomWork(u)) continue;
    const m = Game.rooms[u];
    const f = m && m.terminal;
    if (!m || !f) continue;
    if (f.cooldown > 0) continue;
    if (terminalUsedThisTick(u, n)) continue;
    const d = f.store[l.resourceType] || 0;
    if (d <= 0) {
      console.log("[Arbitrage] Buffered gone from " + u + ". Removing.");
      e.splice(s, 1);
      continue;
    }
    if (d < l.amount) {
      l.amount = d;
    }
    if (typeof l.sellPrice !== "number" || l.sellPrice <= 0) {
      console.log("[Arbitrage] BUFFER dropping " + l.amount + " " + l.resourceType + " in " + u + " -- invalid sellPrice (" + l.sellPrice + "). Cannot verify profitability.");
      e.splice(s, 1);
      continue;
    }
    const g = getCostBasisFloor(l);
    if (g === null) {
      console.log("[Arbitrage] BUFFER dropping " + l.amount + " " + l.resourceType + " in " + u + " -- invalid cost basis. Cannot verify profitability.");
      e.splice(s, 1);
      continue;
    }
    const y = Math.max(g * (1 + MIN_PROFIT_MARGIN), configuredSellFloor(l.resourceType));
    const p = f.store[RESOURCE_ENERGY] || 0;
    const b = t[l.resourceType];
    let O = false;
    if (b) {
      for (var a = 0; a < b.length; a++) {
        const r = b[a];
        const t = getLiveOppBuyRequest(r, l.resourceType);
        if (!t || r.roomName === u) continue;
        const i = capByEnergy(Math.min(l.amount, r.remaining), u, r.roomName, p, f);
        if (i <= 0) continue;
        const c = netSellPricePerUnit(r.maxPrice, i, u, r.roomName, f, o);
        if (c <= y) continue;
        if (terminalUsedThisTick(u, n)) continue;
        const m = f.send(l.resourceType, i, r.roomName);
        if (m === OK) {
          console.log("[Arbitrage] BUFFER self-fulfill " + i + " " + l.resourceType + " -> " + r.roomName + " (net " + c.toFixed(3) + ", basis " + g.toFixed(3) + ")");
          markTerminalIntent(u, n);
          fulfillOppBuyRequest(r, t, i);
          l.amount -= i;
          if (l.amount <= 0) {
            e.splice(s, 1);
          }
          memoryManager.requestImmediateSave("marketArbitrage.terminalSend");
          O = true;
          break;
        }
      }
    }
    if (O) continue;
    const A = ensureSortedBuys(r, l.resourceType);
    if (!A || !A.length) continue;
    let E = null, R = 0;
    for (var c = 0; c < A.length; c++) {
      const e = A[c];
      if (isBadBuyOrder(e.id)) continue;
      const r = util.getOrderRemaining(e) - (i[e.id] || 0);
      if (r > 0) {
        E = e;
        R = r;
        break;
      }
    }
    if (!E) continue;
    const T = Math.min(l.amount, R);
    let _ = netSellPricePerUnit(E.price, T, u, E.roomName, f, o);
    if (_ <= y) continue;
    const B = Math.min(l.amount, Math.max(Math.ceil(l.amount * .5), 100));
    const I = capByEnergy(T, u, E.roomName, p, f);
    if (I < B) continue;
    _ = netSellPricePerUnit(E.price, I, u, E.roomName, f, o);
    if (_ <= y) continue;
    if (terminalUsedThisTick(u, n)) continue;
    const k = orderStillLive(E.id, I) ? Game.market.deal(E.id, I, u) : ERR_INVALID_ARGS;
    if (k === OK) {
      l.pendingVerify = {
        tick: Game.time,
        orderId: E.id,
        amount: I,
        price: E.price,
        basis: g,
        net: _
      };
      markTerminalIntent(u, n);
      recordBuyOrderIntent(E.id, I, i);
      console.log("[Arbitrage] BUFFER deal() OK " + I + " " + l.resourceType + " -> " + E.roomName + " @ " + E.price + " (net " + _.toFixed(3) + ", basis " + g.toFixed(3) + ") | Verifying...");
    } else {
      markBadBuyOrder(E.id, k);
      console.log("[Arbitrage] BUFFER sell failed in " + u + ": " + describeDealFailure(k, u, l.resourceType, I, E, f));
    }
  }
}

function processPendingSell(e, r, t, o, i, n, s, a, c) {
  c = c || {};
  if (e.cooldown > 0) return;
  if (terminalUsedThisTick(o, a)) return;
  const l = e.store[RESOURCE_ENERGY] || 0;
  const u = r.groupKey && Memory.marketArbitrage.groups[r.groupKey];
  const m = getCostBasisFloor(r);
  if (m === null) {
    console.log("[Arbitrage] Dropping op in " + o + " -- invalid cost basis for " + r.resourceType);
    delete t[o];
    return;
  }
  const f = Math.max(m * (1 + MIN_PROFIT_MARGIN), configuredSellFloor(r.resourceType));
  const d = e.store[r.resourceType] || 0;
  if (d <= 0) {
    console.log("[Arbitrage] Resources gone from " + o + ". Aborting.");
    delete t[o];
    return;
  }
  if (d < r.amount) {
    console.log("[Arbitrage] Expected " + r.amount + " " + r.resourceType + " in " + o + ", found " + d + ". Adjusting.");
    r.amount = d;
  }
  const g = n[r.resourceType];
  if (g) {
    for (var y = 0; y < g.length; y++) {
      const n = g[y];
      const s = getLiveOppBuyRequest(n, r.resourceType);
      if (!s || n.roomName === o || r.sellPrice > n.maxPrice) continue;
      const c = capByEnergy(Math.min(r.amount, n.remaining), o, n.roomName, l, e);
      if (c <= 0) continue;
      const d = calcEffectiveEnergyCost(c, o, n.roomName, e);
      const p = n.maxPrice * c - d * i;
      const b = p / c;
      if (b <= f) continue;
      let O = 0;
      if (r.buyOrderId) {
        const t = Game.market.getOrderById(r.buyOrderId);
        if (t && util.getOrderRemaining(t) > 0) {
          const r = capByEnergy(Math.min(c, util.getOrderRemaining(t)), o, t.roomName, l, e);
          O = t.price * r - calcEffectiveEnergyCost(r, o, t.roomName, e) * i;
        }
      }
      if (p * SELF_FULFILL_ADVANTAGE <= O) continue;
      const A = e.send(r.resourceType, c, n.roomName);
      if (A === OK) {
        console.log("[Arbitrage] SELF-FULFILL " + c + " " + r.resourceType + " -> " + n.roomName + " (maxPrice " + n.maxPrice + ", net " + b.toFixed(3) + ", basis " + m.toFixed(3) + ")");
        markTerminalIntent(o, a);
        fulfillOppBuyRequest(n, s, c);
        r.amount -= c;
        r.soldTotal = (r.soldTotal || 0) + c;
        if (r.amount <= 0) {
          if (u) {
            u.sellConfirmedRooms[o] = {
              amount: r.soldTotal,
              profit: 0
            };
            if (Object.keys(u.sellConfirmedRooms).length >= groupExpectedCount(u)) {
              logSellConfirmed(u);
              delete Memory.marketArbitrage.groups[r.groupKey];
            }
          }
          delete t[o];
        }
        memoryManager.requestImmediateSave("marketArbitrage.terminalSend");
        return;
      }
    }
  }
  const p = r.buyDepth;
  if (r.buyDepthIndex === undefined) r.buyDepthIndex = 0;
  let b = false;
  if (p && p.length && r.buyDepthIndex < p.length) {
    for (var O = 0; O < BUY_DEPTH; O++) {
      let t = r.buyDepthIndex;
      while (t < p.length && p[t].amount <= 0) t++;
      if (t >= p.length) {
        b = true;
        break;
      }
      const n = p[t];
      if (isBadBuyOrder(n.order.id)) {
        p[t].amount = 0;
        r.buyDepthIndex = t + 1;
        continue;
      }
      const s = Game.market.getOrderById(n.order.id);
      const d = s ? Math.max(0, util.getOrderRemaining(s) - (c[s.id] || 0)) : 0;
      if (!s || d <= 0) {
        p[t].amount = 0;
        r.buyDepthIndex = t + 1;
        continue;
      }
      const g = Math.min(r.amount, n.amount, d);
      const y = capByEnergy(g, o, s.roomName, l, e);
      if (y <= 0) {
        console.log("[Arbitrage] Insufficient energy for depth buyer " + n.order.id + " in " + o);
        return;
      }
      const O = netSellPricePerUnit(s.price, y, o, s.roomName, e, i);
      if (O <= f) {
        p[t].amount = 0;
        r.buyDepthIndex = t + 1;
        continue;
      }
      const A = orderStillLive(s.id, y) ? Game.market.deal(s.id, y, o) : ERR_INVALID_ARGS;
      if (A === OK) {
        r.buyDepthIndex = t;
        r.state = "pending_verify";
        r.verifyTick = Game.time;
        r.verifyOrderId = s.id;
        r.verifyAmount = y;
        recordBuyOrderIntent(s.id, y, null);
        markTerminalIntent(o, a);
        if (u) {
          u.sellInitRooms[o] = y;
          u.sellRoomsActual[s.roomName] = true;
          if (Object.keys(u.sellInitRooms).length >= groupExpectedCount(u)) {
            logSellInitiated(u);
          }
        } else {
          console.log("[Arbitrage] deal() OK " + y + " " + r.resourceType + " -> " + s.roomName + " @ " + s.price + " (net " + O.toFixed(3) + ", basis " + m.toFixed(3) + ", depth " + (t + 1) + "/" + p.length + ") | Verifying...");
        }
        return;
      } else {
        markBadBuyOrder(s.id, A);
        console.log("[Arbitrage] deal() failed for depth buyer " + n.order.id + " in " + o + ": " + describeDealFailure(A, o, r.resourceType, y, s, e));
        p[t].amount = 0;
        r.buyDepthIndex = t + 1;
        continue;
      }
    }
    if (!b && r.buyDepthIndex >= p.length) b = true;
  } else {
    b = true;
  }
  let A = r.buyOrderId ? Game.market.getOrderById(r.buyOrderId) : null;
  let E = A ? Math.max(0, util.getOrderRemaining(A) - (c[A.id] || 0)) : 0;
  if (!A || E <= 0) {
    if (!b) {
      return;
    }
    if (!s) return;
    console.log("[Arbitrage] Buy order " + (r.buyOrderId || "none") + " gone. Searching replacement...");
    const n = ensureSortedBuys(s, r.resourceType) || [];
    let d = null, y = 0;
    for (var R = 0; R < n.length; R++) {
      const t = n[R];
      if (isBadBuyOrder(t.id)) continue;
      const s = Game.market.getOrderById(t.id);
      const a = s ? Math.max(0, util.getOrderRemaining(s) - (c[s.id] || 0)) : 0;
      if (a <= 0) continue;
      const l = Math.min(r.amount, a);
      const u = netSellPricePerUnit(s.price, l, o, s.roomName, e, i);
      if (u > f) {
        d = s;
        y = a;
        break;
      }
    }
    if (d) {
      A = d;
      E = y;
      r.buyOrderId = d.id;
      r.buyOrderRoom = d.roomName;
      r.buyPrice = d.price;
      console.log("[Arbitrage] Replacement: " + d.id + " @ " + d.price + " in " + d.roomName);
    } else {
      if (g) {
        for (var T = 0; T < g.length; T++) {
          const n = g[T];
          const s = getLiveOppBuyRequest(n, r.resourceType);
          if (!s || n.roomName === o) continue;
          const c = capByEnergy(Math.min(r.amount, n.remaining), o, n.roomName, l, e);
          if (c <= 0) continue;
          const d = netSellPricePerUnit(n.maxPrice, c, o, n.roomName, e, i);
          if (d <= f) continue;
          const y = c > 0 ? e.send(r.resourceType, c, n.roomName) : ERR_INVALID_ARGS;
          if (y === OK) {
            console.log("[Arbitrage] FALLBACK self-fulfill " + c + " " + r.resourceType + " -> " + n.roomName + " (net " + d.toFixed(3) + ", basis " + m.toFixed(3) + ")");
            markTerminalIntent(o, a);
            fulfillOppBuyRequest(n, s, c);
            r.amount -= c;
            r.soldTotal = (r.soldTotal || 0) + c;
            if (r.amount <= 0) {
              if (u) {
                u.sellConfirmedRooms[o] = {
                  amount: r.soldTotal,
                  profit: 0
                };
                if (Object.keys(u.sellConfirmedRooms).length >= groupExpectedCount(u)) {
                  logSellConfirmed(u);
                  delete Memory.marketArbitrage.groups[r.groupKey];
                }
              }
              delete t[o];
            }
            memoryManager.requestImmediateSave("marketArbitrage.terminalSend");
            return;
          }
        }
      }
      enterBuffered(r, t, o);
      if (u) {
        u.failedRooms[o] = {
          stage: "sell",
          reason: "buffered",
          amount: r.amount,
          tick: Game.time
        };
        u.totalAmount -= r.amount;
        const e = groupExpectedCount(u);
        if (e <= 0 || Object.keys(u.sellConfirmedRooms).length >= e) {
          logSellConfirmed(u);
          delete Memory.marketArbitrage.groups[r.groupKey];
        }
      }
      return;
    }
  }
  const _ = Math.min(r.amount, E);
  const B = capByEnergy(_, o, A.roomName, l, e);
  if (B <= 0) {
    console.log("[Arbitrage] Insufficient energy in " + o + ".");
    return;
  }
  const I = netSellPricePerUnit(A.price, B, o, A.roomName, e, i);
  if (I <= f) {
    console.log("[Arbitrage] Sell blocked in " + o + ": net " + I.toFixed(3) + " below basis floor " + f.toFixed(3) + " for " + r.resourceType);
    r.buyOrderId = null;
    return;
  }
  const k = !isBadBuyOrder(A.id) && orderStillLive(A.id, B) ? Game.market.deal(A.id, B, o) : ERR_INVALID_ARGS;
  if (k === OK) {
    r.state = "pending_verify";
    r.verifyTick = Game.time;
    r.verifyOrderId = A.id;
    r.verifyAmount = B;
    recordBuyOrderIntent(A.id, B, null);
    markTerminalIntent(o, a);
    if (u) {
      u.sellInitRooms[o] = B;
      u.sellRoomsActual[A.roomName] = true;
      if (Object.keys(u.sellInitRooms).length >= groupExpectedCount(u)) {
        logSellInitiated(u);
      }
    } else {
      console.log("[Arbitrage] deal() OK " + B + " " + r.resourceType + " -> " + A.roomName + " @ " + A.price + " (net " + I.toFixed(3) + ", basis " + m.toFixed(3) + ") | Verifying...");
    }
  } else {
    markBadBuyOrder(A.id, k);
    console.log("[Arbitrage] Sell failed in " + o + ": " + describeDealFailure(k, o, r.resourceType, B, A, e));
    if (!A || Game.market.getOrderById(A.id) === null) r.buyOrderId = null;
  }
}

function reconcilePending() {
  if (memoryManager.heap.marketArbitrageReconcileTick === Game.time) return;
  memoryManager.heap.marketArbitrageReconcileTick = Game.time;
  _powerMultiplierCache = {};
  const e = ensureMemory();
  const r = e.operations;
  for (var t in r) {
    const e = r[t];
    if (!e) continue;
    if (e.state === "pending_buy") {
      e.state = "pending_buy_verify";
      e.buyVerifyTick = e.tick || Game.time;
    }
    if (e.state === "pending_buy_verify") processPendingBuyVerify(e, r, t); else if (e.state === "pending_verify") processPendingVerify(e, r, t);
  }
  warnBlockedOperations(r);
  processAccountOpVerify();
  reconcileBufferedPending(e.buffered);
  if (Object.keys(e.selfArbPending).length > 0) {
    reconcileSelfArbPending(getCanonicalEnergyPrice());
  }
}

function terminalBlockReason(e) {
  const r = Game.rooms[e];
  if (!r) return "room is not visible";
  if (!r.controller || !r.controller.my) return "room is not owned";
  if (r.controller.level < 6) return "controller is below RCL 6";
  if (!r.terminal) return "terminal is missing";
  if (typeof r.terminal.isActive === "function" && !r.terminal.isActive()) return "terminal is inactive";
  return null;
}

function warnBlockedOperations(e) {
  if (Game.time % 100 !== 0) return;
  for (var r in e) {
    const t = e[r];
    if (!t || t.state !== "pending_sell") continue;
    const o = terminalBlockReason(r);
    if (!o) continue;
    console.log("[Arbitrage] WARNING: op in " + r + " (" + t.amount + " " + t.resourceType + ", " + t.state + ") cannot continue because " + o + ". Bookkeeping retained.");
  }
}

function serviceActive() {
  if (!ENABLED) return;
  if (memoryManager.heap.marketArbitrageServiceTick === Game.time) return;
  memoryManager.heap.marketArbitrageServiceTick = Game.time;
  _powerMultiplierCache = {};
  pruneBadBuyOrders();
  const e = ensureMemory().operations;
  const r = _cachedBooks ? _cachedOppBuyRequests : getOppBuyRequests();
  const t = _cachedBooks ? _cachedEnergyPrice : getCanonicalEnergyPrice();
  const o = {};
  const i = getUsedBuyOrdersThisTick();
  for (var n in e) {
    const s = e[n];
    if (!s || s.state !== "pending_sell") continue;
    if (terminalBlockReason(n)) continue;
    const a = Game.rooms[n];
    const c = a.terminal;
    if (c.cooldown > 0) continue;
    processPendingSell(c, s, e, n, t, r, _cachedBooks, o, i);
  }
}

function scan() {
  if (!ENABLED) return;
  if (memoryManager.heap.marketArbitrageScanTick === Game.time) return;
  memoryManager.heap.marketArbitrageScanTick = Game.time;
  _powerMultiplierCache = {};
  pruneBadBuyOrders();
  const e = ensureMemory().operations;
  const r = getMyRooms();
  const t = getCanonicalEnergyPrice();
  const o = [];
  for (var i in Game.rooms) {
    const r = Game.rooms[i];
    if (terminalBlockReason(i)) continue;
    if (!e[i] && roomSuspender.shouldAvoidRoomWork(i)) continue;
    o.push(r.terminal);
  }
  _historyCache = {};
  const n = getOppBuyRequests();
  const s = buildOrderBooks(r, n);
  _cachedOppBuyRequests = n;
  _cachedEnergyPrice = t;
  _cachedBooks = s;
  let a = Memory.marketArbitrage.buffered || [];
  const c = {};
  for (var l in e) {
    const r = e[l];
    if (!r) continue;
    if (r.state === "pending_verify" && r.verifyOrderId) {
      c[r.verifyOrderId] = (c[r.verifyOrderId] || 0) + r.amount;
    } else if (r.buyOrderId && !r.buyDepth) {
      c[r.buyOrderId] = (c[r.buyOrderId] || 0) + r.amount;
    }
    if (r.buyDepth) {
      for (var u = 0; u < r.buyDepth.length; u++) {
        const e = r.buyDepth[u];
        if (e && e.order && e.order.id) {
          c[e.order.id] = (c[e.order.id] || 0) + (e.amount || 0);
        }
      }
    }
  }
  for (var m = 0; m < a.length; m++) {
    if (a[m].pendingVerify && a[m].pendingVerify.orderId) {
      const e = a[m].pendingVerify.orderId;
      c[e] = (c[e] || 0) + a[m].pendingVerify.amount;
    }
  }
  const f = Memory.marketArbitrage.selfArbPending;
  for (var d in f) {
    const e = f[d];
    if (e && e.buyOrderId) {
      c[e.buyOrderId] = (c[e.buyOrderId] || 0) + e.amount;
    }
  }
  const g = Memory.marketArbitrage.accountOp;
  if (g) {
    if (g.buyOrderId) {
      c[g.buyOrderId] = (c[g.buyOrderId] || 0) + g.amount;
    }
  }
  const y = {};
  const p = getUsedBuyOrdersThisTick();
  const b = [];
  for (var O = 0; O < o.length; O++) {
    const r = o[O];
    const i = r.room.name;
    const a = e[i];
    if (a) {
      if (a.state === "pending_sell") processPendingSell(r, a, e, i, t, n, s, y, p);
    } else if (!roomSuspender.shouldAvoidRoomWork(i) && r.cooldown <= 0) {
      b.push(r);
    }
  }
  for (var A in p) {
    c[A] = Math.max(c[A] || 0, p[A] || 0);
  }
  cleanupGroups(e);
  checkStaleGroups();
  a = Memory.marketArbitrage.buffered;
  if (a) {
    for (var E = a.length - 1; E >= 0; E--) {
      const e = a[E];
      if (e && roomSuspender.shouldAvoidRoomWork(e.roomName)) continue;
      if (e.pendingVerify) continue;
      const r = Game.time - (e.bufferedTick || 0);
      if (r >= BUFFER_TIMEOUT) {
        const t = labCommodityPolicy.isTwoLetterLabProduct(e.resourceType);
        let o = marketSeller.computePrice(e.resourceType);
        if (!(o > 0) && !t) continue;
        if (o < .001) o = .001;
        const i = typeof e.costBasis === "number" && e.costBasis >= e.sellPrice ? e.costBasis : e.sellPrice;
        const n = i * 1.05;
        if (o < n) o = n;
        let s;
        if (labCommodityPolicy.isTwoLetterLabProduct(e.resourceType)) {
          labCommodityRouter.enqueue(e.roomName, e.resourceType, e.amount, "marketArbitrage buffer timeout");
          s = "conversion queued";
        } else {
          s = marketSeller.marketSell(e.roomName, e.resourceType, e.amount, o);
        }
        console.log("[Arbitrage] BUFFER TIMEOUT " + e.amount + " " + e.resourceType + " in " + e.roomName + " after " + r + " ticks. " + s);
        a.splice(E, 1);
      }
    }
  }
  processOwnSellOrders(s, t, r, c, n, y);
  const R = {};
  for (var T in e) {
    const r = e[T];
    if (!r || !r.sellOrderId) continue;
    if (r.state === "pending_buy_verify") {
      R[r.sellOrderId] = (R[r.sellOrderId] || 0) + r.amount;
    }
  }
  if (g && g.sellOrderId && g.state === "pending_buy_verify") {
    R[g.sellOrderId] = (R[g.sellOrderId] || 0) + g.amount;
  }
  const _ = {};
  for (var B in e) {
    const r = e[B];
    if (r && r.resourceType) {
      _[r.resourceType] = (_[r.resourceType] || 0) + r.amount;
    }
  }
  const I = {};
  for (var k = 0; k < a.length; k++) {
    const e = a[k];
    if (e && e.resourceType) {
      _[e.resourceType] = (_[e.resourceType] || 0) + e.amount;
      I[e.resourceType] = true;
    }
  }
  if (g && g.resourceType) {
    _[g.resourceType] = (_[g.resourceType] || 0) + g.amount;
  }
  const S = a && a.length > 0;
  if (S) processBufferedEntries(a, s, n, t, c, y);
  const h = Memory.marketArbitrage.ghostSellOrders;
  if (h) {
    for (var M in h) {
      if (Game.time - h[M] > GHOST_SELL_COOLDOWN) delete h[M];
    }
  }
  const v = getOwnSellResources();
  processAccountOpSellAndScan(s, c, R, _, r, v);
  const P = {};
  for (var N in e) {
    if (e[N] && e[N].resourceType) {
      P[e[N].resourceType] = true;
    }
  }
  const F = buildArbCandidates(s, n, c, R, _, I, v, P);
  const C = [];
  for (var G = 0; G < b.length; G++) {
    const e = b[G];
    if (terminalUsedThisTick(e.room.name, y)) continue;
    let r = 0;
    let o = null;
    let i = null;
    for (var L = 0; L < F.length; L++) {
      const n = F[L];
      const s = evaluateCandidate(n, e, t, b.length, P);
      if (s && s.profit > r) {
        r = s.profit;
        o = s;
        i = n;
      }
    }
    C.push({
      terminal: e,
      profit: r,
      bestOpp: o,
      bestCand: i
    });
  }
  C.sort(function(e, r) {
    return r.profit - e.profit;
  });
  const U = {};
  let D = C.length;
  for (var x = 0; x < C.length; x++) {
    const r = C[x].terminal;
    const o = r.room.name;
    let i = C[x].bestOpp;
    let n = C[x].bestCand;
    let a = C[x].profit;
    if (!cachedOpportunityStillValid(n, i, h, P)) {
      i = null;
      n = null;
      a = 0;
      for (var V = 0; V < F.length; V++) {
        const e = F[V];
        if (h && h[e.sell.id]) continue;
        let o = evaluateCandidate(e, r, t, D, P);
        if (o && o.profit > a) {
          a = o.profit;
          i = o;
          n = e;
        }
      }
    }
    if (!i) {
      const i = findFloorSweepOpportunity(r, s, t, R, _, I, v, P);
      if (i && !(h && h[i.sellOrder.id])) {
        if (orderStillLive(i.sellOrder.id, i.amount) && Game.market.deal(i.sellOrder.id, i.amount, o) === OK) {
          creditLedger.commit(i.amount * i.sellOrder.price);
          markTerminalIntent(o, y);
          R[i.sellOrder.id] = (R[i.sellOrder.id] || 0) + i.amount;
          _[i.resourceType] = (_[i.resourceType] || 0) + i.amount;
          e[o] = {
            state: "pending_buy_verify",
            resourceType: i.resourceType,
            amount: i.amount,
            sellOrderId: i.sellOrder.id,
            sellOrderRoom: i.sellOrder.roomName,
            sellPrice: i.sellOrder.price,
            costBasis: i.costBasis,
            buyOrderId: null,
            buyOrderRoom: null,
            buyPrice: 0,
            profit: 0,
            margin: 0,
            buyEnergy: i.buyEnergy,
            sellEnergy: 0,
            buyVerifyTick: Game.time,
            tick: Game.time,
            isFloorSweep: true
          };
          P[i.resourceType] = true;
          console.log("[Arbitrage] FLOOR SWEEP " + i.amount + " " + i.resourceType + " from " + i.sellOrder.roomName + " @ " + i.sellOrder.price + " cr | Basis: " + i.costBasis.toFixed(3) + " cr/unit (incl. " + i.buyEnergy + " energy)" + " | Room: " + o + " | Verifying buy...");
        } else {
          console.log("[Arbitrage] Floor sweep deal failed in " + o + " for " + i.resourceType);
        }
      }
      D--;
      continue;
    }
    if (orderStillLive(i.sellOrder.id, i.amount) && Game.market.deal(i.sellOrder.id, i.amount, o) === OK) {
      creditLedger.commit(i.amount * i.sellOrder.price);
      markTerminalIntent(o, y);
      n.sellAvailable -= i.amount;
      n.buyAvailable -= i.amount;
      n.exposureRoom -= i.amount;
      R[i.sellOrder.id] = (R[i.sellOrder.id] || 0) + i.amount;
      if (i.buyDepthAllocation) {
        for (var w = 0; w < i.buyDepthAllocation.length; w++) {
          const e = i.buyDepthAllocation[w];
          c[e.order.id] = (c[e.order.id] || 0) + e.amount;
        }
      } else if (i.buyOrder) {
        c[i.buyOrder.id] = (c[i.buyOrder.id] || 0) + i.amount;
      }
      _[i.resourceType] = (_[i.resourceType] || 0) + i.amount;
      const r = i.sellOrder.id + "|" + (i.buyOrder ? i.buyOrder.id : "");
      e[o] = {
        state: "pending_buy_verify",
        resourceType: i.resourceType,
        amount: i.amount,
        sellOrderId: i.sellOrder.id,
        sellOrderRoom: i.sellOrder.roomName,
        sellPrice: i.sellOrder.price,
        costBasis: i.sellOrder.price + i.buyEnergy * t / i.amount,
        buyOrderId: i.buyOrder ? i.buyOrder.id : null,
        buyOrderRoom: i.buyOrder ? i.buyOrder.roomName : null,
        buyPrice: i.buyOrder ? i.buyOrder.price : 0,
        buyDepth: i.buyDepthAllocation || null,
        buyDepthIndex: 0,
        profit: i.profit,
        margin: i.margin,
        buyEnergy: i.buyEnergy,
        sellEnergy: i.sellEnergy,
        buyVerifyTick: Game.time,
        tick: Game.time,
        groupKey: r
      };
      P[i.resourceType] = true;
      if (!U[r]) {
        U[r] = {
          resource: i.resourceType,
          sellRoom: i.sellOrder.roomName,
          buyRoom: i.buyOrder ? i.buyOrder.roomName : "?",
          margin: i.margin,
          rooms: [],
          totalAmount: 0,
          totalProfit: 0
        };
      }
      const s = U[r];
      s.rooms.push(o);
      s.totalAmount += i.amount;
      s.totalProfit += i.profit;
      if (i.margin < s.margin) s.margin = i.margin;
    } else {
      console.log("[Arbitrage] Buy deal failed in " + o + " for " + i.resourceType);
    }
    D--;
  }
  for (var K in U) {
    const e = U[K];
    Memory.marketArbitrage.groups[K] = {
      resource: e.resource,
      sellRoom: e.sellRoom,
      buyRoom: e.buyRoom,
      margin: e.margin,
      members: e.rooms,
      totalAmount: e.totalAmount,
      totalProfit: e.totalProfit,
      createdTick: Game.time,
      buyConfirmedRooms: {},
      sellInitRooms: {},
      sellConfirmedRooms: {},
      failedRooms: {},
      sellGhostCounts: {},
      sellRoomsActual: {}
    };
    console.log("[Arbitrage] BUY INITIATED " + e.resource + " " + e.sellRoom + " -> My Rooms: (" + e.rooms.join(", ") + ") -> " + e.buyRoom + " | Margin: " + (e.margin * 100).toFixed(1) + "%" + " | Volume: " + e.totalAmount + " | Est. Profit: " + e.totalProfit.toFixed(2));
  }
}

function run() {
  reconcilePending();
  serviceActive();
  scan();
}

function status() {
  if (!Memory.marketArbitrage) {
    var e = "[Arbitrage] No operations.";
    return e;
  }
  const r = Memory.marketArbitrage.operations || {};
  const t = Memory.marketArbitrage.buffered || [];
  const o = Memory.marketArbitrage.selfArbPending || {};
  const i = Memory.marketArbitrage.accountOp;
  const n = Memory.marketArbitrage.groups || {};
  let s = "[Arbitrage] Status: " + (ENABLED ? "ENABLED" : "DISABLED") + "\nActive operations:\n";
  let a = 0;
  for (var c in r) {
    const e = r[c];
    const t = Game.time - e.tick;
    let o = e.state;
    if (e.isFloorSweep) o += " [SWEEP]";
    if (e.groupKey) o += " [GRP]";
    if (e.buyDepth && e.buyDepth.length) {
      const r = e.buyDepthIndex || 0;
      o += " [DEPTH " + (r + 1) + "/" + e.buyDepth.length + "]";
    }
    if (e.ambiguous) o += " [AMBIGUOUS: " + (e.ambiguousReason || "verification unresolved") + "]";
    if (e.state === "pending_sell") {
      const e = terminalBlockReason(c);
      if (e) o += " [BLOCKED: " + e + "]";
    }
    if (e.state === "pending_verify") o += " (sell " + e.verifyAmount + ", " + (Game.time - e.verifyTick) + "t ago)"; else if (e.state === "pending_buy_verify") o += " (buy " + e.amount + ", " + (Game.time - e.buyVerifyTick) + "t ago)";
    const i = typeof e.costBasis === "number" ? " basis@" + e.costBasis.toFixed(3) : "";
    s += "  " + c + ": " + o + " | " + e.amount + " " + e.resourceType + " | paid@" + e.sellPrice.toFixed(3) + i + " -> sell@" + (e.buyPrice || 0).toFixed(3) + " | profit: " + e.profit.toFixed(2) + " (" + (e.margin * 100).toFixed(1) + "%)" + " | age: " + t + "t\n";
    a++;
  }
  if (i) {
    const e = Game.time - i.tick;
    let r = i.state;
    if (i.state === "pending_buy_verify") r += " (buy " + i.amount + ", " + (Game.time - i.buyVerifyTick) + "t ago)"; else if (i.state === "pending_sell_verify") r += " (sell " + i.sellVerifyAmount + ", " + (Game.time - i.sellVerifyTick) + "t ago)"; else if (i.state === "ready_to_sell") r += " (holding " + i.amount + ")";
    s += "\nAccount resource op:\n";
    s += "  [ACCOUNT] " + r + " | " + i.amount + " " + i.resourceType + " | buy@" + i.sellPrice.toFixed(3) + " -> sell@" + (i.buyPrice || 0).toFixed(3) + " | profit: " + i.profit.toFixed(2) + " (" + (i.margin * 100).toFixed(1) + "%)" + " | age: " + e + "t\n";
    a++;
  }
  if (t.length > 0) {
    s += "\nBuffered:\n";
    for (var l = 0; l < t.length; l++) {
      const e = t[l];
      const r = Game.time - (e.bufferedTick || 0);
      const o = e.pendingVerify ? " [VERIFYING " + e.pendingVerify.amount + " @ " + e.pendingVerify.price + "]" + (e.pendingVerify.ambiguous ? " [AMBIGUOUS: " + (e.pendingVerify.ambiguousReason || "verification unresolved") + "]" : "") : "";
      const i = typeof e.costBasis === "number" && e.costBasis > e.sellPrice ? " basis@" + e.costBasis.toFixed(3) : "";
      s += "  " + e.roomName + ": " + e.amount + " " + e.resourceType + " | paid@" + e.sellPrice.toFixed(3) + i + " | " + r + "/" + BUFFER_TIMEOUT + "t" + o + "\n";
      a++;
    }
  }
  let u = 0;
  for (var m in o) {
    if (!u) s += "\nSelf-arb pending:\n";
    const e = o[m];
    const r = Game.time - e.tick;
    s += "  " + m + ": " + e.amount + " " + e.resourceType + " | own@" + e.ourSellPrice.toFixed(3) + " -> ext@" + e.buyPrice.toFixed(3) + " | " + r + "t ago" + (e.ambiguous ? " [AMBIGUOUS: " + (e.ambiguousReason || "verification unresolved") + "]" : "") + "\n";
    u++;
    a++;
  }
  const f = Object.keys(n);
  if (f.length > 0) {
    s += "\nActive groups:\n";
    for (var d = 0; d < f.length; d++) {
      const e = n[f[d]];
      const r = Game.time - e.createdTick;
      const t = Object.keys(e.buyConfirmedRooms).length;
      const o = Object.keys(e.sellInitRooms).length;
      const i = Object.keys(e.sellConfirmedRooms).length;
      const a = Object.keys(e.failedRooms).length;
      const c = groupExpectedCount(e);
      s += "  " + e.resource + " " + e.sellRoom + "->" + e.buyRoom + " | members: " + e.members.length + " | buyConfirmed: " + t + "/" + c + " | sellInit: " + o + "/" + c + " | sellConfirmed: " + i + "/" + c + " | failed: " + a + " | age: " + r + "t\n";
    }
  }
  if (a === 0) s += "  (none)\n";
  const g = memoryManager.heap.cpuSectionStats && memoryManager.heap.cpuSectionStats["marketArbitrage.scan"];
  const y = g && g.effectiveInterval ? g.effectiveInterval : 2;
  s += "\nConfig: enabled=" + ENABLED + ", margin=" + MIN_PROFIT_MARGIN * 100 + "%, minBuy=" + MIN_BUY_ORDER_AMOUNT + ", minBuyPrice=" + MIN_BUY_ORDER_PRICE + ", minArbBuyVol=" + MIN_ARB_BUY_VOLUME + ", scan=scheduler/" + y + ", bufTimeout=" + BUFFER_TIMEOUT + ", verifyTimeout=" + VERIFY_TIMEOUT + ", acctVerifyTimeout=" + ACCOUNT_VERIFY_TIMEOUT + ", maxExposure=" + MAX_RESOURCE_EXPOSURE + ", minSelfArbProfit=" + MIN_SELF_ARB_PROFIT + ", selfFulfillAdvantage=" + (SELF_FULFILL_ADVANTAGE * 100).toFixed(0) + "%" + ", floorSweepPrice=" + FLOOR_SWEEP_PRICE + ", floorSweepBanned=[" + Object.keys(FLOOR_SWEEP_BANNED).join(",") + "]" + ", sellGhostFailThreshold=" + SELL_GHOST_FAIL_THRESHOLD + ", groupStaleTicks=" + GROUP_STALE_TICKS;
  return s;
}

function cancel(e) {
  if (!Memory.marketArbitrage) return "[Arbitrage] Nothing to cancel.";
  if (Memory.marketArbitrage.operations && Memory.marketArbitrage.operations[e]) {
    const r = Memory.marketArbitrage.operations[e];
    delete Memory.marketArbitrage.operations[e];
    if (r.groupKey && Memory.marketArbitrage.groups && Memory.marketArbitrage.groups[r.groupKey]) {
      const t = Memory.marketArbitrage.groups[r.groupKey];
      t.failedRooms[e] = {
        stage: r.state,
        reason: "cancelled",
        amount: r.amount,
        tick: Game.time
      };
      t.totalAmount -= r.amount;
      const o = groupExpectedCount(t);
      if (o <= 0) delete Memory.marketArbitrage.groups[r.groupKey];
    }
    const t = "[Arbitrage] Cancelled " + e + " (" + r.amount + " " + r.resourceType + " " + r.state + ")";
    return t;
  }
  if (Memory.marketArbitrage.selfArbPending && Memory.marketArbitrage.selfArbPending[e]) {
    const r = Memory.marketArbitrage.selfArbPending[e];
    delete Memory.marketArbitrage.selfArbPending[e];
    const t = "[Arbitrage] Cancelled self-arb pending " + r.amount + " " + r.resourceType + " in " + e;
    return t;
  }
  const r = Memory.marketArbitrage.buffered || [];
  for (var t = r.length - 1; t >= 0; t--) {
    if (r[t].roomName === e) {
      const o = r[t];
      r.splice(t, 1);
      const i = "[Arbitrage] Cancelled buffered " + o.amount + " " + o.resourceType + " in " + e;
      return i;
    }
  }
  return "[Arbitrage] No op in " + e;
}

function cancelAccount() {
  if (!Memory.marketArbitrage || !Memory.marketArbitrage.accountOp) {
    const e = "[Arbitrage] No active account operation.";
    return e;
  }
  const e = Memory.marketArbitrage.accountOp;
  Memory.marketArbitrage.accountOp = null;
  const r = "[Arbitrage] Cancelled account op: " + e.amount + " " + e.resourceType + " (" + e.state + ")";
  return r;
}

function setEnabled(e) {
  ENABLED = !!e;
  const r = "[Arbitrage] " + (ENABLED ? "ENABLED" : "DISABLED");
  return r;
}

function setMargin(e) {
  if (typeof e !== "number" || e < 0 || e > 1) return "[Arbitrage] Must be 0-1";
  MIN_PROFIT_MARGIN = e;
  const r = "[Arbitrage] Margin set to " + (e * 100).toFixed(1) + "%";
  return r;
}

function setMinBuyAmount(e) {
  if (typeof e !== "number" || e < 1) return "[Arbitrage] Must be >= 1";
  MIN_BUY_ORDER_AMOUNT = e;
  const r = "[Arbitrage] Min buy amount set to " + e;
  return r;
}

function setMinBuyOrderPrice(e) {
  if (typeof e !== "number" || e < 0) return "[Arbitrage] Must be >= 0";
  MIN_BUY_ORDER_PRICE = e;
  const r = "[Arbitrage] Min buy order price set to " + e;
  return r;
}

function setMinArbBuyVolume(e) {
  if (typeof e !== "number" || e < 1) return "[Arbitrage] Must be >= 1";
  MIN_ARB_BUY_VOLUME = e;
  const r = "[Arbitrage] Min arbitrage buy volume set to " + e;
  return r;
}

function setBufferTimeout(e) {
  if (typeof e !== "number" || e < 1) return "[Arbitrage] Must be >= 1";
  BUFFER_TIMEOUT = e;
  const r = "[Arbitrage] Buffer timeout set to " + e + " ticks";
  return r;
}

function setMaxExposure(e) {
  if (typeof e !== "number" || e < 1) return "[Arbitrage] Must be >= 1";
  MAX_RESOURCE_EXPOSURE = e;
  const r = "[Arbitrage] Max resource exposure set to " + e;
  return r;
}

function setMinSelfArbProfit(e) {
  if (typeof e !== "number" || e < 0) return "[Arbitrage] Must be >= 0";
  MIN_SELF_ARB_PROFIT = e;
  const r = "[Arbitrage] Min self-arb profit set to " + e;
  return r;
}

function setSelfFulfillAdvantage(e) {
  if (typeof e !== "number" || e < 1) return "[Arbitrage] Must be >= 1.0 (1.0 = no advantage)";
  SELF_FULFILL_ADVANTAGE = e;
  const r = "[Arbitrage] Self-fulfill advantage set to " + (e * 100).toFixed(0) + "%";
  return r;
}

function setFloorSweepPrice(e) {
  if (typeof e !== "number" || e < 0) return "[Arbitrage] Must be >= 0 (0 = disabled)";
  FLOOR_SWEEP_PRICE = e;
  const r = "[Arbitrage] Floor sweep price set to " + e + " cr" + (e === 0 ? " (disabled)" : "");
  return r;
}

function setFloorSweepDebug(e) {
  FLOOR_SWEEP_DEBUG = !!e;
  const r = "[Arbitrage] Floor sweep debug " + (FLOOR_SWEEP_DEBUG ? "ENABLED" : "DISABLED");
  return r;
}

function addFloorSweepBan(e) {
  if (typeof e !== "string" || !e) return "[Arbitrage] Must be a resource type string";
  FLOOR_SWEEP_BANNED[e] = true;
  const r = "[Arbitrage] Floor sweep ban added: " + e + " (banned: " + Object.keys(FLOOR_SWEEP_BANNED).join(", ") + ")";
  return r;
}

function removeFloorSweepBan(e) {
  if (!FLOOR_SWEEP_BANNED[e]) return "[Arbitrage] " + e + " is not banned";
  delete FLOOR_SWEEP_BANNED[e];
  const r = "[Arbitrage] Floor sweep ban removed: " + e + " (remaining: " + (Object.keys(FLOOR_SWEEP_BANNED).join(", ") || "none") + ")";
  return r;
}

function setSellGhostFailThreshold(e) {
  if (typeof e !== "number" || e < 1) return "[Arbitrage] Must be >= 1";
  SELL_GHOST_FAIL_THRESHOLD = e;
  const r = "[Arbitrage] Sell ghost fail threshold set to " + e;
  return r;
}

function setGroupStaleTicks(e) {
  if (typeof e !== "number" || e < 1) return "[Arbitrage] Must be >= 1";
  GROUP_STALE_TICKS = e;
  const r = "[Arbitrage] Group stale ticks set to " + e;
  return r;
}

module.exports = {
  run: run,
  reconcilePending: reconcilePending,
  serviceActive: serviceActive,
  scan: scan,
  status: status,
  cancel: cancel,
  cancelAccount: cancelAccount,
  setEnabled: setEnabled,
  setMargin: setMargin,
  setMinBuyAmount: setMinBuyAmount,
  setMinBuyOrderPrice: setMinBuyOrderPrice,
  setMinArbBuyVolume: setMinArbBuyVolume,
  setBufferTimeout: setBufferTimeout,
  setMaxExposure: setMaxExposure,
  setMinSelfArbProfit: setMinSelfArbProfit,
  setSelfFulfillAdvantage: setSelfFulfillAdvantage,
  setFloorSweepPrice: setFloorSweepPrice,
  setFloorSweepDebug: setFloorSweepDebug,
  addFloorSweepBan: addFloorSweepBan,
  removeFloorSweepBan: removeFloorSweepBan,
  setSellGhostFailThreshold: setSellGhostFailThreshold,
  setGroupStaleTicks: setGroupStaleTicks
};
global.marketArbitrage = module.exports;
