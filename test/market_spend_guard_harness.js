// LLM: Read docs/codex.js before reviewing or changing this file.
// test/market_spend_guard_harness.js
// Regression test for the corroborated buy ceiling and the Game.market spend
// guard. Reproduces the 2026-08-25 incident: energy BUY orders posted at
// 12555.228/unit because the only visible ask defined the price.

const assert = require('assert');
const Module = require('module');
const path = require('path');

global.OK = 0;
global.ERR_INVALID_ARGS = -10;
global.ORDER_BUY = 'buy';
global.ORDER_SELL = 'sell';
global.RESOURCE_ENERGY = 'energy';
global.REACTIONS = {};
global.COMMODITIES = {};

const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;

let orders = [];
let history = [];
const dealCalls = [];
const createCalls = [];

const utilStub = {
  marketSnapshot: function () {
    if (!global.__marketOrders || global.__marketOrders.tick !== Game.time) {
      const idx = {};
      for (const o of orders) {
        if (!idx[o.resourceType]) idx[o.resourceType] = { buy: [], sell: [] };
        if (o.type === ORDER_BUY) idx[o.resourceType].buy.push(o);
        else idx[o.resourceType].sell.push(o);
      }
      for (const res in idx) {
        idx[res].buy.sort((a, b) => b.price - a.price);
        idx[res].sell.sort((a, b) => a.price - b.price);
      }
      global.__marketOrders = { tick: Game.time, all: orders.slice(), idx: idx };
    }
    return global.__marketOrders;
  },
  getOrderRemaining: function (o) {
    if (!o) return 0;
    if (typeof o.remainingAmount === 'number') return Math.max(0, o.remainingAmount);
    if (typeof o.amount === 'number') return Math.max(0, o.amount);
    return 0;
  },
  getMyRooms: function () {
    return { E9N47: true, E9N49: true };
  },
};
const memoryManagerStub = { requestSave: function () {}, requestImmediateSave: function () {} };
const dependencyStubs = { util: utilStub, memoryManager: memoryManagerStub };

const fs = require('fs');
// Screeps modules require each other by bare name; map those to the root files.
Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.indexOf(projectRoot) === 0) {
    if (dependencyStubs[request]) return dependencyStubs[request];
    if (request.indexOf('/') === -1 && fs.existsSync(projectRoot + request + '.js')) {
      return originalModuleLoad.call(this, projectRoot + request + '.js', parent);
    }
  }
  return originalModuleLoad.apply(this, arguments);
};

function resetEnv() {
  global.Memory = {};
  global.__marketOrders = null;
  global.__marketPriceHistory = null;
  dealCalls.length = 0;
  createCalls.length = 0;
  global.Game = {
    time: 82515085,
    rooms: {},
    market: {
      credits: 9.9e9,
      orders: {},
      getHistory: function () {
        return history;
      },
      getOrderById: function (id) {
        return orders.find((o) => o.id === id) || null;
      },
      deal: function (id, amount, room) {
        dealCalls.push({ id, amount, room });
        return OK;
      },
      createOrder: function (params) {
        createCalls.push(params);
        return OK;
      },
    },
  };
  delete require.cache[require.resolve('../marketPricing')];
  delete require.cache[require.resolve('../marketSpendGuard')];
}

// Fourteen days of ordinary energy trade around 12.5 credits/unit.
function normalHistory() {
  const days = [];
  for (let i = 0; i < 14; i++) {
    days.push({ resourceType: 'energy', date: '2026-08-' + (11 + i), transactions: 900, volume: 4e6, avgPrice: 12.5, stddevPrice: 0.4 });
  }
  return days;
}

function order(id, type, price, amount, roomName) {
  return { id, type, resourceType: 'energy', price, amount, remainingAmount: amount, roomName };
}

function healthyBook() {
  return [
    order('a1', ORDER_SELL, 12.6, 8000, 'W1N1'),
    order('a2', ORDER_SELL, 12.8, 8000, 'W2N2'),
    order('a3', ORDER_SELL, 13.1, 8000, 'W3N3'),
    order('a4', ORDER_SELL, 14.0, 8000, 'W4N4'),
    order('b1', ORDER_BUY, 12.4, 8000, 'W5N5'),
    order('b2', ORDER_BUY, 12.2, 8000, 'W6N6'),
    order('b3', ORDER_BUY, 12.0, 8000, 'W7N7'),
    order('b4', ORDER_BUY, 11.5, 8000, 'W8N8'),
  ];
}

// ── Case 1: the incident. Cheap asks gone, one scam ask left standing. ─────
history = normalHistory();
// The scam ask sat at 12555.329; the profile posted a bid one passive step
// under it, which is the 12555.228 the transaction log recorded.
orders = [order('scam', ORDER_SELL, 12555.329, 50000, 'W17S6')];
resetEnv();
let pricing = require('../marketPricing');
let guard = require('../marketSpendGuard');

let band = pricing.buyPriceCeiling(RESOURCE_ENERGY);
assert.strictEqual(band.source, 'HISTORY_14D', 'a lone scam ask is not evidence; history must bind');
assert.strictEqual(band.ceiling, 125, '10x the volume-weighted median daily price');

// The incident itself: with no bid side visible, the profile posts one
// millicredit under the only ask on the book -- 12555.228, to the millicredit.
const profile = pricing.getPriceProfile(RESOURCE_ENERGY);
assert.strictEqual(profile.state, 'sellers-only');
assert.strictEqual(Math.round(profile.postedBuyPrice * 1e3) / 1e3, 12555.228, 'reproduces the posted price from the incident');

// What we would actually bid now: the corroborated reference, not the book,
// and not the ceiling either -- clamping to 125 would still pay 10x on purpose.
assert.strictEqual(pricing.passiveBuyPrice(RESOURCE_ENERGY), 12.5, 'falls back to fair value');
assert.strictEqual(pricing.getStatusEnergyPrice(), 12.5, 'energy valuation stays believable everywhere');

guard.install();
assert.strictEqual(
  Game.market.createOrder({ type: ORDER_BUY, resourceType: 'energy', price: 12555.228, totalAmount: 25000, roomName: 'E9N47' }),
  ERR_INVALID_ARGS,
  'the incident order must be refused at the API boundary'
);
assert.strictEqual(createCalls.length, 0, 'no createOrder intent may reach the server');
assert.strictEqual(Game.market.deal('scam', 483, 'E9N47'), ERR_INVALID_ARGS, 'buying the scam ask must be refused');
assert.strictEqual(dealCalls.length, 0, 'no deal intent may reach the server');
assert.strictEqual(Memory.marketGuard.blockedCount, 2, 'both blocks are recorded for review');

// ── Case 2: an ordinary market still trades normally. ─────────────────────
history = normalHistory();
orders = healthyBook();
resetEnv();
pricing = require('../marketPricing');
guard = require('../marketSpendGuard');
guard.install();

band = pricing.buyPriceCeiling(RESOURCE_ENERGY);
assert.ok(band.ceiling >= 60 && band.ceiling <= 130, 'headroom above market, far below the scam price: ' + band.ceiling);
assert.strictEqual(
  Game.market.createOrder({ type: ORDER_BUY, resourceType: 'energy', price: 12.5, totalAmount: 25000, roomName: 'E9N47' }),
  OK,
  'a normal buy is untouched'
);
assert.strictEqual(createCalls.length, 1);
assert.strictEqual(Game.market.deal('a1', 5000, 'E9N47'), OK, 'a normal deal is untouched');
assert.strictEqual(dealCalls.length, 1);
assert.strictEqual(
  Game.market.createOrder({ type: ORDER_SELL, resourceType: 'energy', price: 9e5, totalAmount: 1000, roomName: 'E9N47' }),
  OK,
  'the guard only governs what we pay, never what we ask'
);

// ── Case 3: one player stacking depth is not corroboration. ───────────────
// 25 scam asks, all from the same room, are the cheapest thing on the book.
history = [];
orders = [];
for (let i = 0; i < 25; i++) orders.push(order('s' + i, ORDER_SELL, 9000 + i, 2000, 'W17S6'));
resetEnv();
pricing = require('../marketPricing');
band = pricing.buyPriceCeiling(RESOURCE_ENERGY);
assert.strictEqual(band.ceiling, null, 'single-room depth with no history is not evidence');
assert.strictEqual(band.source, 'NONE');

// The same depth spread across distinct rooms does count as a market.
orders = [];
for (let i = 0; i < 25; i++) orders.push(order('m' + i, ORDER_SELL, 12 + i * 0.1, 2000, 'W' + i + 'N1'));
resetEnv();
pricing = require('../marketPricing');
band = pricing.buyPriceCeiling(RESOURCE_ENERGY);
assert.strictEqual(band.source, 'ASK_DEPTH');
assert.ok(band.reference > 12 && band.reference < 13.5, 'median of the cheapest depth, not the top order: ' + band.reference);

// ── Case 4: the 0.030 junk wall (live shard, 2026-08-26). ────────────────
// Two rooms park 10k bids at 0.030 on every resource. GH2O trades at ~1457.
history = [];
for (let i = 0; i < 14; i++) {
  history.push({ resourceType: 'GH2O', date: '2026-08-' + (11 + i), transactions: 4, volume: 5000, avgPrice: 1457.031, stddevPrice: 300 });
}
orders = [
  { id: 'ga', type: ORDER_SELL, resourceType: 'GH2O', price: 876.634, amount: 2900, remainingAmount: 2900, roomName: 'E11S33' },
  { id: 'gb1', type: ORDER_BUY, resourceType: 'GH2O', price: 192.343, amount: 2000, remainingAmount: 2000, roomName: 'E27S13' },
  { id: 'gb2', type: ORDER_BUY, resourceType: 'GH2O', price: 192.342, amount: 2000, remainingAmount: 2000, roomName: 'W41S31' },
  { id: 'junk1', type: ORDER_BUY, resourceType: 'GH2O', price: 0.03, amount: 10000, remainingAmount: 10000, roomName: 'E28S23' },
  { id: 'junk2', type: ORDER_BUY, resourceType: 'GH2O', price: 0.03, amount: 10000, remainingAmount: 10000, roomName: 'E29S22' },
];
resetEnv();
pricing = require('../marketPricing');
guard = require('../marketSpendGuard');
guard.install();

band = pricing.buyPriceCeiling('GH2O');
assert.notStrictEqual(band.source, 'BID_DEPTH', 'a wall of fake size must never set the ceiling');
assert.ok(band.ceiling > 1457, 'the ceiling must clear the traded price, not collapse to 0.15: ' + band.ceiling);
assert.strictEqual(Game.market.deal('ga', 2900, 'E9N47'), OK, 'buying at the real ask must not be blocked');

// The bid reference is still reported, it just cannot cap.
const bidSource = band.sources.filter((s) => s.source === 'BID_DEPTH')[0];
assert.ok(!bidSource || bidSource.caps === false, 'bid depth is diagnostic only');

// ── Case 5: history floor. A depressed ask side cannot block buying. ─────
history = [];
for (let i = 0; i < 14; i++) {
  history.push({ resourceType: 'battery', date: '2026-08-' + (11 + i), transactions: 50, volume: 90000, avgPrice: 120, stddevPrice: 5 });
}
orders = [];
for (let i = 0; i < 4; i++) {
  orders.push({ id: 'cheap' + i, type: ORDER_SELL, resourceType: 'battery', price: 1 + i * 0.1, amount: 6000, remainingAmount: 6000, roomName: 'W' + i + 'N1' });
}
resetEnv();
pricing = require('../marketPricing');
band = pricing.buyPriceCeiling('battery');
assert.ok(band.ceiling >= 120, 'the traded price is always payable: ' + band.ceiling + ' (' + band.source + ')');

Module._load = originalModuleLoad;
console.log('Market spend guard regression test passed.');
