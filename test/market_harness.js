// LLM: Read codex.js before reviewing or changing this file.
// test/market_harness.js
// Dependency-free market contract tests for Node.js.

const assert = require('assert');
const Module = require('module');
const path = require('path');

// Screeps constants used by util.js and marketPricing.js.
global.OK = 0;
global.ORDER_BUY = 'buy';
global.ORDER_SELL = 'sell';

global.RESOURCE_ENERGY = 'energy';
global.RESOURCE_HYDROGEN = 'H';
global.RESOURCE_OXYGEN = 'O';
global.RESOURCE_UTRIUM = 'U';
global.RESOURCE_LEMERGIUM = 'L';
global.RESOURCE_KEANIUM = 'K';
global.RESOURCE_ZYNTHIUM = 'Z';
global.RESOURCE_CATALYST = 'X';
global.RESOURCE_GHODIUM = 'G';
global.RESOURCE_HYDROXIDE = 'OH';
global.RESOURCE_ZYNTHIUM_KEANITE = 'ZK';
global.RESOURCE_UTRIUM_LEMERGITE = 'UL';
global.RESOURCE_UTRIUM_BAR = 'utrium_bar';
global.RESOURCE_SILICON = 'silicon';
global.RESOURCE_WIRE = 'wire';

global.RESOURCES_ALL = [
  RESOURCE_ENERGY, RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM, RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST,
  RESOURCE_GHODIUM, RESOURCE_HYDROXIDE, RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE, RESOURCE_UTRIUM_BAR, RESOURCE_SILICON,
  RESOURCE_WIRE, 'metal', 'biomass', 'mist'
];

// A small forward reaction graph is enough to exercise derived pricing without
// depending on the complete Screeps constants table.
global.REACTIONS = {
  H: { O: 'OH' },
  O: { H: 'OH' },
  OH: { L: 'LO' },
  L: { OH: 'LO' },
  Z: { K: 'ZK' },
  K: { Z: 'ZK' },
  ZK: { UL: 'G' },
  UL: { ZK: 'G' }
};

global.COMMODITIES = {
  wire: {
    components: { utrium_bar: 20, silicon: 100, energy: 40 },
    amount: 20,
    cooldown: 8,
    level: 0
  }
};

const marketState = {
  orders: [],
  history: {},
  allOrdersCalls: 0,
  historyCalls: 0,
  distances: {},
  distanceCalls: 0
};

function resetTestEnv() {
  resetTestEnv.generation = (resetTestEnv.generation || 0) + 1;
  global.Memory = {};
  global.Game = {
    // A large step invalidates marketPricing's private derived-floor cache as
    // well as util.marketSnapshot's public TTL cache.
    time: 100000 + resetTestEnv.generation * 10000,
    rooms: {},
    creeps: {},
    spawns: {},
    market: {
      credits: 100000,
      orders: {},
      getAllOrders: function() {
        marketState.allOrdersCalls++;
        return marketState.orders.slice();
      },
      getHistory: function(resource) {
        marketState.historyCalls++;
        return marketState.history[resource] || [];
      },
      getOrderById: function(id) {
        for (var i = 0; i < marketState.orders.length; i++) {
          if (marketState.orders[i].id === id) return marketState.orders[i];
        }
        return null;
      }
    },
    map: {
      getRoomLinearDistance: function(from, to) {
        marketState.distanceCalls++;
        var key = from + '|' + to;
        if (marketState.distances[key] !== undefined) return marketState.distances[key];
        return from === to ? 0 : 30;
      }
    },
    cpu: {
      getUsed: function() { return 1; },
      limit: 20,
      bucket: 10000
    },
    getObjectById: function() { return null; }
  };
  global.__marketOrders = undefined;
  global.__marketPriceHistory = undefined;
  global.__roomState = {
    tick: Game.time,
    rooms: {},
    ownedRooms: {},
    ownedRoomNames: [],
    creepIndex: { all: [] },
    powerCreepIndex: {}
  };
  marketState.orders = [];
  marketState.history = {};
  marketState.allOrdersCalls = 0;
  marketState.historyCalls = 0;
  marketState.distances = {};
  marketState.distanceCalls = 0;
}

function setOwnedRooms(roomNames) {
  var ownedRooms = {};
  for (var i = 0; i < roomNames.length; i++) ownedRooms[roomNames[i]] = true;
  global.__roomState.ownedRooms = ownedRooms;
  global.__roomState.ownedRoomNames = roomNames.slice();
}

function order(id, type, resourceType, price, remainingAmount, roomName, extra) {
  return Object.assign({
    id: id,
    type: type,
    resourceType: resourceType,
    price: price,
    remainingAmount: remainingAmount,
    amount: remainingAmount,
    roomName: roomName || 'W9N9',
    active: true
  }, extra || {});
}

function setOrders(orders) {
  marketState.orders = orders;
}

function setHistory(resource, days) {
  marketState.history[resource] = days;
}

resetTestEnv();

const util = require('../util');

// Screeps resolves bare "util" to this project module. Node reserves that
// name for its built-in utility module, so mirror the Screeps resolver only for
// project modules while leaving Node's own callers untouched.
const originalModuleLoad = Module._load;
const projectRoot = path.resolve(__dirname, '..') + path.sep;
Module._load = function(request, parent, isMain) {
  if (request === 'util' && parent && parent.filename &&
      parent.filename.indexOf(projectRoot) === 0) {
    return util;
  }
  return originalModuleLoad.apply(this, arguments);
};

const pricing = require('../marketPricing');
const sellPolicy = require('../autoTraderSellPolicy');
const creditLedger = require('../creditLedger');
const marketEconomics = require('../marketEconomics');
const marketAnalysis = require('../marketAnalysis');

let passed = 0;
let failed = 0;
let registered = 0;

function test(name, fn) {
  registered++;
  resetTestEnv();
  try {
    fn();
    console.log('  \u2713 ' + name);
    passed++;
  } catch (err) {
    console.error('  \u2717 ' + name);
    console.error(err);
    failed++;
  }
}

// === Shared market utilities ===

test('getOrderRemaining preserves an explicit zero', function() {
  assert.strictEqual(util.getOrderRemaining({ remainingAmount: 0, amount: 999 }), 0);
  assert.strictEqual(util.getOrderRemaining({ remainingAmount: 125, amount: 999 }), 125);
});

test('getOrderRemaining handles fallback and invalid quantities', function() {
  assert.strictEqual(util.getOrderRemaining({ remainingAmount: NaN, amount: 25 }), 25);
  assert.strictEqual(util.getOrderRemaining({ remainingAmount: -10, amount: 25 }), 0);
  assert.strictEqual(util.getOrderRemaining({ remainingAmount: '25', amount: 30 }), 30);
  assert.strictEqual(util.getOrderRemaining({ amount: Infinity }), 0);
  assert.strictEqual(util.getOrderRemaining(null), 0);
});

test('marketSnapshot filters and sorts order buckets', function() {
  setOrders([
    order('b-low', ORDER_BUY, 'H', 2, 1000),
    order('b-high', ORDER_BUY, 'H', 5, 1000),
    order('s-high', ORDER_SELL, 'H', 7, 1000),
    order('s-low', ORDER_SELL, 'H', 1, 1000),
    order('dust', ORDER_BUY, 'H', 99, 999),
    order('bad-price', ORDER_BUY, 'H', NaN, 1000),
    order('zero-price', ORDER_BUY, 'H', 0, 1000),
    order('negative-price', ORDER_SELL, 'H', -1, 1000),
    order('other-type', 'unknown', 'H', 50, 1000)
  ]);

  var snapshot = util.marketSnapshot();
  assert.deepStrictEqual(snapshot.idx.H.buy.map(function(o) { return o.price; }), [99, 5, 2]);
  assert.deepStrictEqual(snapshot.idx.H.sell.map(function(o) { return o.price; }), [1, 7]);
  assert.strictEqual(marketState.allOrdersCalls, 1);
  assert.strictEqual(util.marketSnapshot(), snapshot);
  assert.strictEqual(marketState.allOrdersCalls, 1);
});

test('marketSnapshot refreshes after its TTL', function() {
  setOrders([order('old', ORDER_BUY, 'H', 2, 1000)]);
  assert.strictEqual(util.marketSnapshot().idx.H.buy[0].price, 2);
  Game.time += util.ORDER_TTL + 1;
  setOrders([order('new', ORDER_BUY, 'H', 9, 1000)]);
  assert.strictEqual(util.marketSnapshot().idx.H.buy[0].price, 9);
  assert.strictEqual(marketState.allOrdersCalls, 2);
});

test('marketOrders returns sorted resource and side views without a bucket error', function() {
  setOrders([
    order('h-buy', ORDER_BUY, 'H', 5, 1000),
    order('h-sell', ORDER_SELL, 'H', 6, 1000),
    order('o-buy', ORDER_BUY, 'O', 2, 1000)
  ]);
  assert.deepStrictEqual(util.marketOrders('H', ORDER_BUY).map(function(o) { return o.id; }), ['h-buy']);
  assert.deepStrictEqual(util.marketOrders('H', ORDER_SELL).map(function(o) { return o.id; }), ['h-sell']);
  assert.strictEqual(util.marketOrders('H').length, 2);
  assert.deepStrictEqual(util.marketOrders('missing'), []);
});

test('calcTransactionCost rounds the documented distance formula and caches it', function() {
  marketState.distances['W1N1|W2N2'] = 30;
  var expected = Math.ceil(100 * (1 - Math.exp(-30 / 30)));
  assert.strictEqual(util.calcTransactionCost(100, 'W1N1', 'W2N2'), expected);
  assert.strictEqual(util.calcTransactionCost(50, 'W1N1', 'W2N2'), Math.ceil(50 * (1 - Math.exp(-1))));
  assert.strictEqual(marketState.distanceCalls, 1);
});

test('capByEnergy returns the largest affordable amount', function() {
  marketState.distances['W3N3|W4N4'] = 30;
  var amount = util.capByEnergy(1000, 'W3N3', 'W4N4', 100, false);
  assert.ok(amount > 0);
  assert.ok(util.calcTransactionCost(amount, 'W3N3', 'W4N4') <= 100);
  assert.ok(util.calcTransactionCost(amount + 1, 'W3N3', 'W4N4') > 100);
});

test('transaction helpers reject empty or unbounded requests', function() {
  assert.strictEqual(util.calcTransactionCost(0, 'W1N1', 'W2N2'), 0);
  assert.strictEqual(util.capByEnergy(0, 'W1N1', 'W2N2', 100, false), 0);
  assert.strictEqual(util.capByEnergy(100, 'W1N1', 'W2N2', 0, false), 0);
  assert.strictEqual(util.capByEnergy(100, 'W1N1', null, 100, false), 0);
  assert.strictEqual(util.capByEnergy(100, 'W1N1', 'W2N2', 100, false) > 0, true);
});

test('capByEnergy includes the sent resource when sellingEnergy is enabled', function() {
  marketState.distances['W5N5|W6N6'] = 30;
  var amount = util.capByEnergy(1000, 'W5N5', 'W6N6', 100, true);
  var cost = util.calcTransactionCost(amount, 'W5N5', 'W6N6');
  assert.ok(amount + cost <= 100);
  assert.ok(amount + 1 + util.calcTransactionCost(amount + 1, 'W5N5', 'W6N6') > 100);
});

test('creditLedger tracks committed spend only within one tick', function() {
  Game.market.credits = 1000;
  assert.strictEqual(creditLedger.available(), 1000);
  creditLedger.commit(125);
  creditLedger.commit(0);
  creditLedger.commit(-50);
  creditLedger.commit(NaN);
  creditLedger.commit(Infinity);
  creditLedger.commit('25');
  assert.strictEqual(creditLedger.committedThisTick(), 125);
  assert.strictEqual(creditLedger.available(), 875);
  Game.time++;
  assert.strictEqual(creditLedger.committedThisTick(), 0);
  assert.strictEqual(creditLedger.available(), 1000);
});

test('creditLedger accepts finite fractional spend and uses the live credit snapshot', function() {
  Game.market.credits = 1000;
  creditLedger.commit(0.25);
  Game.market.credits = 900;
  assert.strictEqual(creditLedger.committedThisTick(), 0.25);
  assert.strictEqual(creditLedger.available(), 899.75);
});

test('creditLedger ignores object and infinite commit values', function() {
  Game.market.credits = 1000;
  creditLedger.commit({ amount: 50 });
  creditLedger.commit(Infinity);
  creditLedger.commit(-Infinity);
  creditLedger.commit(null);
  assert.strictEqual(creditLedger.committedThisTick(), 0);
  assert.strictEqual(creditLedger.available(), 1000);
});

// === Market economics ledger ===

test('marketEconomics creates an idempotent job with normalized expectations', function() {
  var first = marketEconomics.start('job-1', {
    kind: 'lab',
    room: 'W1N1',
    product: 'OH',
    expectedNetProfit: 123.6,
    expectedElapsedTicks: 10,
    expectedCreditsPerTick: 12.3456
  });
  var second = marketEconomics.start('job-1', { kind: 'different' });
  assert.strictEqual(second.id, 'job-1');
  assert.strictEqual(second.kind, 'lab');
  assert.strictEqual(second.room, 'W1N1');
  assert.strictEqual(second.product, 'OH');
  assert.strictEqual(second.expected.netCredits, 124);
  assert.strictEqual(second.expected.elapsedTicks, 10);
  assert.strictEqual(second.expected.creditsPerTick, 12.346);
  assert.strictEqual(second, first);
  assert.strictEqual(second.status, 'active');
});

test('marketEconomics recomputes cash and economic totals with fees and energy', function() {
  marketEconomics.start('job-2', { kind: 'factory', product: 'wire' });
  marketEconomics.recordBuy('job-2', 'H', 100, 200, 10, 5);
  marketEconomics.recordOwnedOpportunity('job-2', 'O', 50, 30);
  marketEconomics.recordProduction('job-2', 'OH', 100, { H: 100, O: 100 });
  marketEconomics.recordSale('job-2', 'OH', 100, 500, 20, 10);
  marketEconomics.recordFee('job-2', 'sellCreate', 12.4);
  marketEconomics.recordFee('job-2', 'invalidFee', 1000);

  var active = marketEconomics.get('job-2');
  assert.strictEqual(active.input.H.acquired, 100);
  assert.strictEqual(active.input.H.buyCredits, 200);
  assert.strictEqual(active.input.H.transferEnergy, 10);
  assert.strictEqual(active.input.O.ownedOpportunityCredits, 30);
  assert.strictEqual(active.output.OH.produced, 100);
  assert.strictEqual(active.output.OH.sold, 100);
  assert.strictEqual(active.fees.sellCreate, 12);
  assert.strictEqual(active.fees.total, 12);
  assert.strictEqual(active.totals.realizedNetCredits, 288);
  assert.strictEqual(active.totals.economicNetCredits, 243);
  assert.strictEqual(active.totals.transferEnergy, 30);
  assert.strictEqual(active.totals.transferEnergyCredits, 15);

  Game.time += 10;
  var finished = marketEconomics.finish('job-2', 'done');
  assert.strictEqual(finished.status, 'done');
  assert.strictEqual(finished.finishedTick, Game.time);
  assert.strictEqual(finished.totals.realizedNetCreditsPerTick, 28.8);
  assert.strictEqual(finished.totals.economicNetCreditsPerTick, 24.3);
  assert.ok(Memory.marketEconomics.closedOrder.indexOf('job-2') >= 0);
});

test('marketEconomics allocates a sale FIFO across adjacent job lots', function() {
  marketEconomics.start('job-a', { kind: 'factory', product: 'wire' });
  marketEconomics.start('job-b', { kind: 'factory', product: 'wire' });
  marketEconomics.attachSellLot('sell-1', 'job-a', 100);
  marketEconomics.attachSellLot('sell-1', 'job-a', 50);
  marketEconomics.attachSellLot('sell-1', 'job-b', 100);

  var allocations = marketEconomics.allocateSale('sell-1', 'wire', 180, 1800, 18);
  assert.strictEqual(allocations.length, 2);
  assert.deepStrictEqual(allocations[0], {
    jobId: 'job-a', amount: 150, credits: 1500, transferEnergy: 15
  });
  assert.deepStrictEqual(allocations[1], {
    jobId: 'job-b', amount: 30, credits: 300, transferEnergy: 3
  });
  assert.strictEqual(marketEconomics.get('job-a').output.wire.sold, 150);
  assert.strictEqual(marketEconomics.get('job-b').output.wire.sold, 30);

  var remaining = marketEconomics.getOrderLots('sell-1');
  assert.strictEqual(remaining.lots.length, 1);
  assert.strictEqual(remaining.lots[0].jobId, 'job-b');
  assert.strictEqual(remaining.lots[0].remaining, 70);
});

test('marketEconomics rejects invalid lots and records phase durations', function() {
  assert.strictEqual(marketEconomics.attachSellLot('', 'job-missing', 10), null);
  assert.strictEqual(marketEconomics.attachSellLot('order', null, 0), null);
  assert.deepStrictEqual(marketEconomics.allocateSale('missing', 'H', 10, 10, 0), []);

  marketEconomics.start('job-3', { kind: 'lab', product: 'OH' });
  Game.time += 5;
  marketEconomics.phase('job-3', 'buying');
  marketEconomics.phase('job-3', 'buying');
  Game.time += 3;
  marketEconomics.phase('job-3', 'selling');
  assert.strictEqual(marketEconomics.get('job-3').status, 'selling');
  assert.strictEqual(marketEconomics.get('job-3').phase.durations.queued, 5);
  assert.strictEqual(marketEconomics.get('job-3').phase.durations.buying, 3);
  assert.strictEqual(marketEconomics.finish('job-3', 'failed', 'no market depth').reason, 'no market depth');
});

// === Sell floor policy ===

test('configured sell floors protect highway deposit resources', function() {
  assert.strictEqual(sellPolicy.getFloor('metal'), 1200);
  assert.strictEqual(sellPolicy.getFloor('biomass'), 1200);
  assert.strictEqual(sellPolicy.getFloor('silicon'), 1200);
  assert.strictEqual(sellPolicy.getFloor('mist'), 1200);
  assert.strictEqual(sellPolicy.applyFloor('metal', 100), 1200);
  assert.strictEqual(sellPolicy.applyFloor('metal', 1500), 1500);
});

test('sell floor leaves unknown and invalid prices unchanged', function() {
  assert.strictEqual(sellPolicy.getFloor('H'), 0);
  assert.strictEqual(sellPolicy.applyFloor('H', 1.25), 1.25);
  assert.strictEqual(sellPolicy.applyFloor('metal', 0), 0);
  assert.ok(Number.isNaN(sellPolicy.applyFloor('metal', NaN)));
  assert.strictEqual(sellPolicy.applyFloor('metal', Infinity), Infinity);
  assert.strictEqual(sellPolicy.hasConfiguredFloors(), true);
});

test('derived sell floor includes processing markup and market fee', function() {
  setOrders([
    order('h-ask', ORDER_SELL, 'H', 2, 1000),
    order('o-ask', ORDER_SELL, 'O', 3, 1000)
  ]);
  var floor = pricing.getDerivedSellFloor('OH');
  var expected = Math.ceil((2 + 3) * 1.10 / 0.95 * 1000) / 1000;
  assert.strictEqual(floor, expected);
  assert.strictEqual(sellPolicy.getFloor('OH'), expected);
  assert.ok(sellPolicy.applyFloor('OH', 1) >= expected);
});

test('sell policy handles missing resources and non-positive candidate prices', function() {
  assert.strictEqual(sellPolicy.getFloor(null), 0);
  assert.strictEqual(sellPolicy.getFloor(''), 0);
  assert.strictEqual(sellPolicy.applyFloor(null, 4), 4);
  assert.strictEqual(sellPolicy.applyFloor('metal', -1), -1);
  assert.strictEqual(sellPolicy.applyFloor('metal', '100'), '100');
});

test('unresolved derived products do not invent a sell floor', function() {
  setOrders([]);
  assert.strictEqual(pricing.getDerivedSellFloor('OH'), 0);
  var compound = pricing.getTheoreticalPrice('OH');
  assert.strictEqual(compound.price, null);
  assert.strictEqual(compound.source, 'UNRESOLVED');
  assert.deepStrictEqual(compound.unresolvedInputs, ['OH']);

  var base = pricing.getTheoreticalPrice('H');
  assert.strictEqual(base.price, null);
  assert.strictEqual(base.reason, 'base resource has no forward theoretical recipe');
});

// === Canonical market book and quote behavior ===

test('market book excludes owned rooms and dust orders', function() {
  setOwnedRooms(['W1N1']);
  setOrders([
    order('own', ORDER_BUY, 'H', 100, 5000, 'W1N1'),
    order('external', ORDER_BUY, 'H', 5, 1000, 'W2N2'),
    order('dust', ORDER_BUY, 'H', 10, 999, 'W3N3'),
    order('ask', ORDER_SELL, 'H', 8, 1000, 'W4N4')
  ]);
  var book = pricing.getBook('H');
  assert.strictEqual(book.bestBid, 5);
  assert.strictEqual(book.bestAsk, 8);
  assert.strictEqual(book.totalBidVolume, 1000);
  assert.strictEqual(book.totalAskVolume, 1000);
});

test('empty market books expose stable null and dead-market values', function() {
  setOrders([]);
  var book = pricing.getBook('H');
  assert.strictEqual(book.bestBid, null);
  assert.strictEqual(book.bestAsk, null);
  assert.strictEqual(book.totalBidVolume, 0);
  assert.strictEqual(book.totalAskVolume, 0);
  assert.strictEqual(book.bidLiquidity, 'dead');
  assert.strictEqual(book.askLiquidity, 'dead');
  assert.strictEqual(book.oneSided, 'empty');

  var profile = pricing.getPriceProfile('H');
  assert.strictEqual(profile.state, 'empty');
  assert.strictEqual(profile.confidence, 'none');
  assert.strictEqual(profile.postedBuyPrice, null);
  assert.strictEqual(profile.postedSellPrice, null);
  assert.strictEqual(pricing.liquidationPrice('H'), 0);
  assert.strictEqual(pricing.actualBuyPrice('H'), null);
  assert.strictEqual(pricing.actualSellPrice('H'), null);
});

test('buyers-only deep books expose a low-confidence liquidation reference', function() {
  setOrders([
    order('b1', ORDER_BUY, 'H', 4, 5000, 'W1N1'),
    order('b2', ORDER_BUY, 'H', 3, 5000, 'W2N2'),
    order('b3', ORDER_BUY, 'H', 2, 5000, 'W3N3'),
    order('b4', ORDER_BUY, 'H', 1, 5000, 'W4N4')
  ]);
  var profile = pricing.getPriceProfile('H');
  assert.strictEqual(profile.state, 'buyers-only');
  assert.strictEqual(profile.confidence, 'low');
  assert.strictEqual(profile.sellLiquidity, 'deep');
  assert.strictEqual(profile.buyLiquidity, 'dead');
  assert.ok(Math.abs(profile.sellPrice - 2.5) < 1e-9);
  assert.strictEqual(pricing.liquidationPrice('H'), 2.5);
  assert.ok(Math.abs(pricing.passiveBuyPrice('H') - 2.6) < 1e-9);
  assert.ok(Math.abs(pricing.passiveSellPrice('H') - 4.001) < 1e-9);
});

test('deep reference prices use cumulative volume across four levels', function() {
  var orders = [];
  [4, 3, 2, 1].forEach(function(price, index) {
    orders.push(order('b' + index, ORDER_BUY, 'H', price, 5000, 'W' + (index + 1) + 'N1'));
  });
  [6, 7, 8, 9].forEach(function(price, index) {
    orders.push(order('s' + index, ORDER_SELL, 'H', price, 5000, 'W' + (index + 1) + 'N2'));
  });
  setOrders(orders);
  var book = pricing.getBook('H');
  assert.strictEqual(book.referenceBid, 2.5);
  assert.strictEqual(book.referenceAsk, 7.5);
  assert.strictEqual(book.referenceBidVolume, 20000);
  assert.strictEqual(book.referenceAskVolume, 20000);
  assert.strictEqual(book.bidLiquidity, 'deep');
  assert.strictEqual(book.askLiquidity, 'deep');
});

test('active deep profile exposes guarded passive prices', function() {
  var orders = [];
  [4, 3.9, 3.8, 3.7].forEach(function(price, index) {
    orders.push(order('b' + index, ORDER_BUY, 'H', price, 5000, 'W' + (index + 1) + 'N1'));
  });
  [4.2, 4.3, 4.4, 4.5].forEach(function(price, index) {
    orders.push(order('s' + index, ORDER_SELL, 'H', price, 5000, 'W' + (index + 1) + 'N2'));
  });
  setOrders(orders);
  var profile = pricing.getPriceProfile('H');
  assert.strictEqual(profile.state, 'active');
  assert.strictEqual(profile.confidence, 'high');
  assert.ok(Math.abs(profile.marketPrice - 4.1) < 1e-9);
  assert.ok(Math.abs(profile.postedBuyPrice - 3.95) < 1e-9);
  assert.ok(Math.abs(profile.postedSellPrice - 4.1) < 1e-9);
  assert.strictEqual(profile.postedBuySource, 'ABUY');
  assert.strictEqual(profile.postedSellSource, 'ASELL');
});

test('executable quotes consume exact partial depth and charge transfer energy', function() {
  marketState.distances['W1N1|W2N2'] = 30;
  marketState.distances['W1N1|W3N3'] = 60;
  setOrders([
    order('ask1', ORDER_SELL, 'H', 6, 1000, 'W2N2'),
    order('ask2', ORDER_SELL, 'H', 8, 1000, 'W3N3'),
    order('bid1', ORDER_BUY, 'H', 4, 1000, 'W2N2'),
    order('bid2', ORDER_BUY, 'H', 3, 1000, 'W3N3')
  ]);
  var buy = pricing.executableBuyQuote('H', 1500, 'W1N1');
  assert.strictEqual(buy.amount, 1500);
  assert.strictEqual(buy.price, (6000 + 4000) / 1500);
  assert.strictEqual(buy.transferEnergy,
    util.calcTransactionCost(1000, 'W1N1', 'W2N2') +
    util.calcTransactionCost(500, 'W1N1', 'W3N3'));

  var sell = pricing.executableSellQuote('H', 1500, 'W1N1');
  assert.strictEqual(sell.amount, 1500);
  assert.strictEqual(sell.price, (4000 + 1500) / 1500);
  assert.strictEqual(sell.orderCount, 2);
  assert.strictEqual(sell.bestBid, 4);
});

test('executable quote helpers reject non-positive and insufficient amounts', function() {
  setOrders([
    order('ask', ORDER_SELL, 'H', 6, 1000, 'W2N2'),
    order('bid', ORDER_BUY, 'H', 4, 1000, 'W3N3')
  ]);
  assert.strictEqual(pricing.executableBuyQuote('H', 0, 'W1N1'), null);
  assert.strictEqual(pricing.executableBuyQuote('H', -1, 'W1N1'), null);
  assert.strictEqual(pricing.executableBuyQuote('H', 1001, 'W1N1'), null);
  assert.strictEqual(pricing.executableSellQuote('H', 0, 'W1N1'), null);
  assert.strictEqual(pricing.executableSellQuote('H', 1001, 'W1N1'), null);
  assert.strictEqual(pricing.getConversionExitQuote('H', 0, 'W1N1'), null);
});

test('input quotes fall back to bounded asks for thin base-resource markets', function() {
  setOrders([
    order('x-ask', ORDER_SELL, 'X', 4, 1000, 'W2N2'),
    order('l-ask', ORDER_SELL, 'L', 2, 1000, 'W3N3'),
    order('o-ask', ORDER_SELL, 'O', 3, 1000, 'W4N4')
  ]);

  var x = pricing.getInputBuyQuote('X', 3000);
  var l = pricing.getInputBuyQuote('L', 3000);
  var o = pricing.getInputBuyQuote('O', 3000);
  assert.strictEqual(x.source, 'REFERENCE_ASK');
  assert.strictEqual(l.source, 'REFERENCE_ASK');
  assert.strictEqual(o.source, 'REFERENCE_ASK');
  assert.strictEqual(x.price, 4);
  assert.strictEqual(l.price, 2);
  assert.strictEqual(o.price, 3);
});

test('input quotes use a standing bid when a base market has no asks', function() {
  setOrders([
    order('x-bid', ORDER_BUY, 'X', 4, 1000, 'W2N2'),
    order('l-bid', ORDER_BUY, 'L', 2, 1000, 'W3N3'),
    order('o-bid', ORDER_BUY, 'O', 3, 1000, 'W4N4')
  ]);

  var x = pricing.getInputBuyQuote('X', 3000);
  var l = pricing.getInputBuyQuote('L', 3000);
  var o = pricing.getInputBuyQuote('O', 3000);
  assert.strictEqual(x.source, 'POSTED_BUY');
  assert.strictEqual(l.source, 'POSTED_BUY');
  assert.strictEqual(o.source, 'POSTED_BUY');
  assert.ok(x.price > 4);
  assert.ok(l.price > 2);
  assert.ok(o.price > 3);
});

test('energy input quotes match the status() valuation', function() {
  setOrders([order('energy-ask', ORDER_SELL, 'energy', 0.5, 1000, 'W2N2')]);
  var quote = pricing.getInputBuyQuote(RESOURCE_ENERGY, 0);
  assert.strictEqual(quote.source, 'STATUS');
  assert.strictEqual(quote.price, pricing.getStatusEnergyPrice());
  assert.ok(quote.price > 0 && quote.price < 0.5);
});

test('status energy valuation remains the single quote across book shapes', function() {
  var books = [
    [],
    [order('ask-only', ORDER_SELL, 'energy', 0.5, 5000, 'W2N2')],
    [order('bid-only', ORDER_BUY, 'energy', 0.4, 5000, 'W3N3')],
    [order('active-bid', ORDER_BUY, 'energy', 0.4, 5000, 'W4N4'),
     order('active-ask', ORDER_SELL, 'energy', 0.6, 5000, 'W5N5')],
    [order('crossed-bid', ORDER_BUY, 'energy', 0.6, 5000, 'W6N6'),
     order('crossed-ask', ORDER_SELL, 'energy', 0.5, 5000, 'W7N7')],
    [order('low-ask', ORDER_SELL, 'energy', 0.002, 1000, 'W8N8')]
  ];

  for (var i = 0; i < books.length; i++) {
    setOrders(books[i]);
    Game.time += 100;
    var statusPrice = pricing.getStatusEnergyPrice();
    var inputQuote = pricing.getInputBuyQuote(RESOURCE_ENERGY, 100000);
    assert.strictEqual(inputQuote.price, statusPrice);
    assert.ok(statusPrice === 0 || (isFinite(statusPrice) && statusPrice > 0));
    var profile = pricing.getPriceProfile(RESOURCE_ENERGY);
    ['marketPrice', 'postedBuyPrice', 'postedSellPrice'].forEach(function(field) {
      assert.ok(profile[field] === null || (isFinite(profile[field]) && profile[field] > 0), field);
    });
  }
});

test('low-price seller books retain a positive passive sell price', function() {
  setOrders([order('low-l-ask', ORDER_SELL, 'L', 0.002, 1000, 'W2N2')]);
  var profile = pricing.getPriceProfile('L');
  assert.ok(profile.postedSellPrice >= 0.001);
  assert.ok(pricing.passiveSellPrice('L') >= 0.001);
});

test('input quotes use theoretical values for derived dependencies', function() {
  setOrders([
    order('h-ask', ORDER_SELL, 'H', 2, 1000, 'W2N2'),
    order('o-ask', ORDER_SELL, 'O', 3, 1000, 'W3N3')
  ]);
  var quote = pricing.getInputBuyQuote('OH', 3000);
  assert.strictEqual(quote.source, 'THEORETICAL');
  assert.strictEqual(quote.price, 5.79);
});

test('factory analysis accepts thin canonical input references', function() {
  setOrders([
    order('bar-ask', ORDER_SELL, 'utrium_bar', 10, 1000, 'W2N2'),
    order('silicon-ask', ORDER_SELL, 'silicon', 2, 1000, 'W3N3'),
    order('energy-ask', ORDER_SELL, 'energy', 0.5, 1000, 'W4N4'),
    order('wire-bid', ORDER_BUY, 'wire', 40, 1000, 'W5N5')
  ]);
  var row = marketAnalysis.analyzeFactoryCommodity('wire', 'PASSIVE_SELL', 'PASSIVE_BUY');
  assert.ok(row);
  assert.ok(row.inputCost > 0);
  assert.ok(row.ingredientCost > 0);
  assert.ok(row.revenue > 0);
});

test('factory break-even ceilings use canonical energy and input quotes', function() {
  setOrders([
    order('bar-ask', ORDER_SELL, 'utrium_bar', 10, 1000, 'W2N2'),
    order('silicon-ask', ORDER_SELL, 'silicon', 2, 1000, 'W3N3'),
    order('energy-ask', ORDER_SELL, 'energy', 0.5, 1000, 'W4N4'),
    order('wire-bid', ORDER_BUY, 'wire', 40, 1000, 'W5N5')
  ]);
  var ceilings = pricing.breakEvenInputCeilings('wire');
  assert.ok(ceilings);
  assert.ok(ceilings.utrium_bar > 0);
  assert.ok(ceilings.silicon > 0);
});

test('unpriced base inputs remain unresolved without an acquisition side', function() {
  setOrders([]);
  var quote = pricing.getInputBuyQuote('X', 3000);
  assert.strictEqual(quote.price, 0);
  assert.strictEqual(quote.source, 'NONE');
});

test('pricing uses amount when an order has no remainingAmount field', function() {
  var ask = order('amount-only', ORDER_SELL, 'H', 6, 1000, 'W2N2');
  delete ask.remainingAmount;
  setOrders([ask]);
  var book = pricing.getBook('H');
  assert.strictEqual(book.totalAskVolume, 1000);
  assert.strictEqual(pricing.executableBuyPrice('H', 1000), 6);
});

test('substantial buy price uses the 500-unit threshold before dust filtering', function() {
  setOrders([
    order('too-small', ORDER_BUY, 'H', 20, 499, 'W2N2'),
    order('substantial', ORDER_BUY, 'H', 8, 500, 'W3N3'),
    order('own', ORDER_BUY, 'H', 100, 1000, 'W1N1')
  ]);
  setOwnedRooms(['W1N1']);
  assert.strictEqual(pricing.getSubstantialBuyPrice('H'), 8);
});

test('substantial buy price returns null when no external bid meets the threshold', function() {
  setOrders([
    order('small', ORDER_BUY, 'H', 20, 499, 'W2N2'),
    order('own', ORDER_BUY, 'H', 100, 1000, 'W1N1')
  ]);
  setOwnedRooms(['W1N1']);
  assert.strictEqual(pricing.getSubstantialBuyPrice('H'), null);
});

test('crossed books are marked low confidence and disable passive quotes', function() {
  var orders = [];
  [10, 9, 8, 7].forEach(function(price, index) {
    orders.push(order('b' + index, ORDER_BUY, 'H', price, 5000, 'W' + (index + 1) + 'N1'));
  });
  [6, 7, 8, 9].forEach(function(price, index) {
    orders.push(order('s' + index, ORDER_SELL, 'H', price, 5000, 'W' + (index + 1) + 'N2'));
  });
  setOrders(orders);
  var profile = pricing.getPriceProfile('H');
  assert.strictEqual(profile.crossed, true);
  assert.strictEqual(profile.confidence, 'low');
  assert.strictEqual(profile.postedBuyPrice, null);
  assert.strictEqual(profile.postedSellPrice, null);
});

test('history range, trend, and weekly low ignore sparse history', function() {
  setHistory('energy', [
    { avgPrice: 1, volume: 100 },
    { avgPrice: 1, volume: 100 },
    { avgPrice: 1, volume: 100 },
    { avgPrice: 2, volume: 100 },
    { avgPrice: 2, volume: 100 },
    { avgPrice: 2, volume: 100 },
    { avgPrice: 2, volume: 100 }
  ]);
  assert.strictEqual(pricing.getRange7d('energy'), 1);
  assert.strictEqual(pricing.getTrend7d('energy'), 'rising');
  assert.strictEqual(pricing.getWeekLow('energy'), 1);

  setHistory('H', [
    { avgPrice: 5, volume: 100 },
    { avgPrice: 6, volume: 100 },
    { avgPrice: 7, volume: 100 }
  ]);
  assert.strictEqual(pricing.getRange7d('H'), null);
  assert.strictEqual(pricing.getTrend7d('H'), null);
});

test('history averages are volume-weighted and refresh after the history TTL', function() {
  setHistory('H', [
    { avgPrice: 2, volume: 100 },
    { avgPrice: 4, volume: 300 }
  ]);
  assert.strictEqual(pricing.getAvg48h('H'), 3.5);
  assert.strictEqual(pricing.getAvg48h('H'), 3.5);
  assert.strictEqual(marketState.historyCalls, 1);

  Game.time += 1000;
  setHistory('H', [
    { avgPrice: 10, volume: 100 },
    { avgPrice: 20, volume: 100 }
  ]);
  assert.strictEqual(pricing.getAvg48h('H'), 15);
  assert.strictEqual(marketState.historyCalls, 2);
});

test('weekly range ignores a low-volume outlier while trend uses all valid days', function() {
  setHistory('energy', [
    { avgPrice: 10, volume: 100 },
    { avgPrice: 10, volume: 100 },
    { avgPrice: 10, volume: 100 },
    { avgPrice: 20, volume: 1 },
    { avgPrice: 10, volume: 100 }
  ]);
  assert.strictEqual(pricing.getRange7d('energy'), 0);
  assert.strictEqual(pricing.getTrend7d('energy'), 'rising');

  setHistory('O', [
    { avgPrice: 4, volume: 100 },
    { avgPrice: 4, volume: 100 },
    { avgPrice: 4, volume: 100 },
    { avgPrice: 2, volume: 100 },
    { avgPrice: 2, volume: 100 },
    { avgPrice: 2, volume: 100 },
    { avgPrice: 2, volume: 100 }
  ]);
  assert.strictEqual(pricing.getTrend7d('O'), 'falling');
  assert.strictEqual(pricing.getWeekLow('O'), 2);
});

test('conversion exit prefers an executable external bid', function() {
  marketState.distances['W1N1|W2N2'] = 30;
  setOrders([
    order('bid', ORDER_BUY, 'H', 4, 1000, 'W2N2'),
    order('ask', ORDER_SELL, 'H', 6, 1000, 'W3N3')
  ]);
  var quote = pricing.getConversionExitQuote('H', 500, 'W1N1');
  assert.strictEqual(quote.method, 'LIVE_BID');
  assert.strictEqual(quote.source, 'LIVE_BID');
  assert.strictEqual(quote.amount, 500);
  assert.strictEqual(quote.price, 4);
});

test('conversion exit falls back to a resolved theoretical value', function() {
  setOrders([
    order('h-ask', ORDER_SELL, 'H', 2, 1000, 'W2N2'),
    order('o-ask', ORDER_SELL, 'O', 3, 1000, 'W3N3')
  ]);
  var quote = pricing.getConversionExitQuote('OH', 100, 'W1N1');
  assert.strictEqual(quote.method, 'THEORETICAL');
  assert.strictEqual(quote.source, 'THEORETICAL');
  assert.strictEqual(quote.amount, 100);
  assert.strictEqual(quote.price, 5.79);
});

test('conversion exit can produce a patient ask-side quote', function() {
  setOrders([
    order('ask1', ORDER_SELL, 'H', 6, 1000, 'W2N2'),
    order('ask2', ORDER_SELL, 'H', 7, 1000, 'W3N3'),
    order('ask3', ORDER_SELL, 'H', 8, 1000, 'W4N4'),
    order('ask4', ORDER_SELL, 'H', 9, 1000, 'W5N5')
  ]);
  var quote = pricing.getConversionExitQuote('H', 500, 'W1N1');
  assert.strictEqual(quote.method, 'LIVE_ASK');
  assert.strictEqual(quote.source, 'LIVE_ASK');
  assert.strictEqual(quote.amount, 500);
  assert.ok(Math.abs(quote.price - 5.9) < 1e-9);
});

test('theoretical factory pricing resolves component asks and level-zero markup', function() {
  setOrders([
    order('bar', ORDER_SELL, 'utrium_bar', 10, 1000, 'W2N2'),
    order('silicon', ORDER_SELL, 'silicon', 2, 1000, 'W3N3'),
    order('energy', ORDER_SELL, 'energy', 0.5, 1000, 'W4N4')
  ]);
  var theoretical = pricing.getTheoreticalPrice('wire');
  assert.strictEqual(theoretical.source, 'THEORETICAL');
  assert.strictEqual(theoretical.processingLevel, 0);
  assert.strictEqual(theoretical.marginPct, 5);
  var energyPrice = pricing.getStatusEnergyPrice();
  var expectedCost = (10 * 20 + 2 * 100 + energyPrice * 40) / 20;
  var expectedPrice = Math.ceil(expectedCost * 1.05 / 0.95 * 1000) / 1000;
  assert.strictEqual(theoretical.price, expectedPrice);
  assert.ok(Math.abs(theoretical.cost - expectedCost) < 0.001);
});

test('restricted direct quote rejects bids below the configured floor', function() {
  setOrders([
    order('below-floor', ORDER_BUY, 'metal', 1199, 1000, 'W2N2'),
    order('at-floor', ORDER_BUY, 'metal', 1201, 1000, 'W3N3'),
    order('inactive', ORDER_BUY, 'metal', 1300, 1000, 'W4N4', { active: false })
  ]);
  var quote = pricing.getRestrictedDirectQuote('metal', 1500, 'W1N1');
  assert.strictEqual(quote.executableAmount, 1000);
  assert.strictEqual(quote.price, 1201);
  assert.strictEqual(quote.totalValue, 1201000);
  assert.strictEqual(quote.orderCount, 1);
});

test('forced buy method returns a canonical bid capped by the caller ceiling', function() {
  var orders = [];
  [4, 3, 2, 1].forEach(function(price, index) {
    orders.push(order('b' + index, ORDER_BUY, 'H', price, 5000, 'W' + (index + 1) + 'N1'));
  });
  [6, 7, 8, 9].forEach(function(price, index) {
    orders.push(order('s' + index, ORDER_SELL, 'H', price, 5000, 'W' + (index + 1) + 'N2'));
  });
  setOrders(orders);
  var decision = pricing.chooseBuyMethod('H', 2.55, { forceOrder: true });
  assert.strictEqual(decision.method, 'order');
  assert.strictEqual(decision.suggestedBid, 2.55);
  assert.strictEqual(decision.reason, 'forced standing order');
});

test('buy-method selection waits when no canonical passive bid exists', function() {
  setOrders([]);
  var normal = pricing.chooseBuyMethod('H', 10);
  assert.strictEqual(normal.method, 'opportunistic');
  assert.strictEqual(normal.suggestedBid, null);
  assert.ok(normal.reason.indexOf('no canonical passive bid') >= 0);

  var forced = pricing.chooseBuyMethod('H', 10, { forceOrder: true });
  assert.strictEqual(forced.method, 'order');
  assert.strictEqual(forced.suggestedBid, 0.001);
});

test('buy-method selection posts when ask depth cannot fill the requested input', function() {
  setOrders([order('thin-ask', ORDER_SELL, 'H', 6, 1000, 'W2N2')]);
  var decision = pricing.chooseBuyMethod('H', 6, { amount: 3000 });
  assert.strictEqual(decision.method, 'order');
  assert.ok(decision.suggestedBid > 0);
  assert.ok(decision.reason.indexOf('insufficient external ask depth') >= 0);
});

console.log('\nMarket Test Suite Complete: ' + passed + ' passed, ' + failed + ' failed.');
if (passed + failed !== registered) {
  console.error('Registered test accounting mismatch.');
  process.exit(1);
}
if (failed > 0) process.exit(1);
