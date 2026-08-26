// LLM: Read docs/codex.js before reviewing or changing this file.
// test/market_sell_harness.js
// Direct marketSell pricing contract tests.

const assert = require('assert');
const Module = require('module');
const path = require('path');
global.OK = 0;
global.ERR_FULL = -8;
global.ORDER_BUY = 'buy';
global.ORDER_SELL = 'sell';
global.RESOURCE_ENERGY = 'energy';
global.RESOURCE_OPS = 'ops';
global.RESOURCES_ALL = ['energy', 'O', 'L', 'X', 'ops'];
global.REACTIONS = {};
global.COMMODITIES = {};
const marketState = { orders: [], history: {} };
global.Memory = {};
global.Game = {
  time: 1000,
  rooms: {},
  market: {
    orders: {},
    getAllOrders: function () {
      return marketState.orders.slice();
    },
    getHistory: function (resource) {
      return marketState.history[resource] || [];
    },
  },
};
global.__marketOrders = undefined;
global.__marketPriceHistory = undefined;
const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;
const util = require('../util');
// marketSell only needs these dependencies for the pricing methods under test.
// Keep the harness isolated from room/terminal orchestration.
const dependencyStubs = {
  getRoomState: {
    owned: function () {
      return {};
    },
  },
  terminalManager: {},
  storageManager: {},
  memoryManager: {
    compactMarketSellRequest: function (request) {
      return request;
    },
    requestSave: function () {},
    requestImmediateSave: function () {},
  },
  creditLedger: {
    available: function () {
      return 1000000000;
    },
    commit: function () {},
  },
  labCommodityPolicy: {
    isTwoLetterLabProduct: function () {
      return false;
    },
  },
};
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.indexOf(projectRoot) === 0) {
    if (request === 'util') return util;
    if (dependencyStubs[request]) return dependencyStubs[request];
  }
  return originalModuleLoad.apply(this, arguments);
};
const pricing = require('../marketPricing');
const marketSeller = require('../marketSell');
function order(id, type, resourceType, price, remainingAmount, roomName) {
  return {
    id: id,
    type: type,
    resourceType: resourceType,
    price: price,
    remainingAmount: remainingAmount,
    amount: remainingAmount,
    roomName: roomName || 'W9N9',
    active: true,
  };
}

function setOrders(orders) {
  marketState.orders = orders;
  Game.time += 100;
  global.__marketOrders = undefined;
  global.__marketPriceHistory = undefined;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  PASS ' + name);
    passed++;
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err);
    failed++;
  }
}

test('crossed base books still provide a fair marketSell anchor', function () {
  setOrders([
    order('o-bid', ORDER_BUY, 'O', 10, 5000, 'W1N1'),
    order('o-ask', ORDER_SELL, 'O', 6, 5000, 'W2N2'),
  ]);
  var raw = marketSeller.computePrice('O');
  var final = marketSeller.getMarketSellPrice('O');
  assert.ok(raw > 10);
  assert.ok(final >= 10.001);
  assert.strictEqual(final, Math.round(raw * 1000) / 1000);
});

test('substantial dust-filtered buyer anchors a base-resource sell price', function () {
  setOrders([order('o-small-bid', ORDER_BUY, 'O', 7, 500, 'W2N2')]);
  assert.strictEqual(pricing.getPriceProfile('O').postedSellPrice, null);
  assert.strictEqual(marketSeller.computePrice('O'), 7);
  assert.strictEqual(marketSeller.getMarketSellPrice('O'), 7);
});

test('empty base-resource markets remain unresolved', function () {
  setOrders([]);
  assert.strictEqual(marketSeller.computePrice('O'), null);
  assert.strictEqual(marketSeller.getMarketSellPrice('O'), null);
});

test('marketSell price helpers always return finite positive values', function () {
  setOrders([
    order('x-bid', ORDER_BUY, 'X', 0.001, 500, 'W2N2'),
    order('l-ask', ORDER_SELL, 'L', 0.002, 1000, 'W3N3'),
    order('energy-bid', ORDER_BUY, 'energy', 0.4, 5000, 'W4N4'),
    order('energy-ask', ORDER_SELL, 'energy', 0.6, 5000, 'W5N5'),
  ]);
  ['X', 'L', RESOURCE_ENERGY].forEach(function (resource) {
    var price = marketSeller.getMarketSellPrice(resource);
    assert.strictEqual(typeof price, 'number', resource);
    assert.ok(isFinite(price), resource);
    assert.ok(price >= 0.001, resource);
  });
});

console.log(
  '\nMarketSell Pricing Test Suite Complete: ' + passed + ' passed, ' + failed + ' failed.'
);
if (failed > 0) process.exit(1);
