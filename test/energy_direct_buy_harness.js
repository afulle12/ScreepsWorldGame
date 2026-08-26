// LLM: Read docs/codex.js before reviewing or changing this file.
// test/energy_direct_buy_harness.js
// Regression test for autoEnergyBuyer's direct-purchase route. Buying energy by
// dealing against a SELL order makes us the dealer, so we pay the terminal
// transfer -- in energy. The route must be priced per NET unit delivered.

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

global.OK = 0;
global.ORDER_BUY = 'buy';
global.ORDER_SELL = 'sell';
global.RESOURCE_ENERGY = 'energy';
global.RESOURCE_BATTERY = 'battery';
global.COMMODITIES = { battery: { level: 0, amount: 50, components: { energy: 600 } } };
global.REACTIONS = {};

const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;

let orders = [];
let history = [];
const batchJobs = [];
const marketBuyCalls = [];

// Real distance drives real freight; rooms are named so the number is obvious.
const distances = { W1N1: 10, W2N2: 30, W3N3: 60, W4N4: 120 };
// A profile only produces a posted bid from a book deep on both sides, so the
// valuation cases need several levels from several rooms per side.
for (let i = 0; i < 6; i++) {
  distances['N' + i] = 10; // near sellers
  distances['F' + i] = 60; // far sellers
  distances['B' + i] = 30; // bidders, distance irrelevant to a resting bid
}
function book(askPrice, askRoomPrefix, bidTop) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    out.push(ask('a' + i, askPrice + i * 0.1, 10000, askRoomPrefix + i));
    out.push({ id: 'b' + i, type: ORDER_BUY, resourceType: 'energy', price: bidTop - i * 0.5, amount: 10000, remainingAmount: 10000, roomName: 'B' + i });
  }
  return out;
}

const stubs = {
  memoryManager: { requestSave() {}, requestImmediateSave() {}, heap: {} },
  getRoomState: { owned: () => ({ E9N47: {} }), init() {} },
  marketBuy: {
    marketBuy: function (room, res, amount) {
      marketBuyCalls.push({ room, res, amount });
      return OK;
    },
    computePassiveBuyPrice: () => null,
  },
  marketBatchBuy: {
    create: function (spec) {
      batchJobs.push(spec);
      return { ok: true, id: 'job' + batchJobs.length };
    },
    getOpenJobs: () => [],
  },
  storageManager: { storageFind: () => null },
  factoryManager: { getOrders: () => [] },
  localRefine: { getOperations: () => [] },
  creditLedger: { available: () => 1e9, commit() {} },
};

Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.indexOf(projectRoot) === 0) {
    if (stubs[request]) return stubs[request];
    if (request.indexOf('/') === -1 && fs.existsSync(projectRoot + request + '.js')) {
      return originalModuleLoad.call(this, projectRoot + request + '.js', parent);
    }
  }
  return originalModuleLoad.apply(this, arguments);
};

function resetEnv(terminalEnergy) {
  global.Memory = {};
  global.__marketOrders = null;
  global.__marketPriceHistory = null;
  batchJobs.length = 0;
  marketBuyCalls.length = 0;
  global.Game = {
    time: 82518000,
    rooms: {},
    map: {
      getRoomLinearDistance: function (a, b) {
        return distances[a] !== undefined ? distances[a] : distances[b] !== undefined ? distances[b] : 1;
      },
    },
    market: {
      credits: 9.9e9,
      orders: {},
      getAllOrders: () => orders.slice(),
      getHistory: () => history,
    },
  };
  delete require.cache[require.resolve('../marketPricing')];
  delete require.cache[require.resolve('../autoEnergyBuyer')];
  delete require.cache[require.resolve('../util')];
  return {
    name: 'E9N47',
    terminal: { store: { energy: terminalEnergy === undefined ? 100000 : terminalEnergy } },
  };
}

function ask(id, price, amount, room) {
  return { id, type: ORDER_SELL, resourceType: 'energy', price, amount, remainingAmount: amount, roomName: room };
}

for (let i = 0; i < 14; i++) {
  history.push({ resourceType: 'energy', date: '2026-08-' + (11 + i), transactions: 900, volume: 4e6, avgPrice: 24, stddevPrice: 1 });
}

// ── The cheapest sticker price is not the cheapest energy. ────────────────
// W1N1 is 10 rooms out: freight ~28% of the shipment.
// W3N3 is 60 rooms out: freight ~86%, so 20.00 lands dearer than 24.00 nearby.
orders = [ask('far', 20.0, 50000, 'W3N3'), ask('near', 24.0, 50000, 'W1N1')];
let room = resetEnv();
let pricing = require('../marketPricing');
let buyer = require('../autoEnergyBuyer');

let offer = buyer.bestDirectEnergyOffer('E9N47', 25000);
assert.strictEqual(offer.orderId, 'near', 'delivered cost must decide, not sticker price');
const freight = require('../util').calcTransactionCost(25000, 'E9N47', 'W1N1');
assert.strictEqual(offer.freight, freight);
assert.strictEqual(offer.net, 25000 - freight);
assert.ok(Math.abs(offer.delivered - (24.0 * 25000) / (25000 - freight)) < 1e-9);
assert.ok(offer.delivered > 24.0, 'freight makes delivered strictly worse than the ask');

// The far order is not merely worse -- price it and see how much worse.
const farFreight = require('../util').calcTransactionCost(25000, 'E9N47', 'W3N3');
const farDelivered = (20.0 * 25000) / (25000 - farFreight);
assert.ok(farDelivered > offer.delivered * 3, 'distant energy is multiples dearer: ' + farDelivered.toFixed(2));

// ── An order too far to be worth taking is refused, not merely priced. ───
// 120 rooms out, freight is 98%: sending 25,000 nets 457. The delivered price
// (54.70) still clears the ceiling, and under an urgent premium it would clear
// the standing bid too -- the yield floor is what stops it, not the price.
orders = [ask('hopeless', 1.0, 50000, 'W4N4')];
room = resetEnv();
pricing = require('../marketPricing');
buyer = require('../autoEnergyBuyer');
assert.strictEqual(buyer.bestDirectEnergyOffer('E9N47', 25000), null, 'a shipment that does not survive the trip is not an offer');
assert.strictEqual(buyer.tryDirectEnergyPurchase(room, 25000, 100.0, true), 0);
assert.strictEqual(batchJobs.length, 0, 'no job even when the delivered price looks affordable');

// ── Cheaper delivered than the standing bid: take it. ────────────────────
orders = [ask('near', 24.0, 50000, 'W1N1')];
room = resetEnv();
pricing = require('../marketPricing');
buyer = require('../autoEnergyBuyer');
let committed = buyer.tryDirectEnergyPurchase(room, 25000, 40.0, false);
assert.strictEqual(batchJobs.length, 1, 'a direct job is created');
assert.strictEqual(batchJobs[0].resourceType, 'energy');
assert.strictEqual(batchJobs[0].orderId, 'near');
assert.strictEqual(batchJobs[0].amount, 25000);
assert.strictEqual(batchJobs[0].energyCost, freight);
assert.strictEqual(committed, 25000 - freight, 'the passive order is sized against NET energy');

// ── Dearer than the standing bid: stay passive unless it is urgent. ──────
room = resetEnv();
pricing = require('../marketPricing');
buyer = require('../autoEnergyBuyer');
assert.strictEqual(buyer.tryDirectEnergyPurchase(room, 25000, 25.0, false), 0, 'normal tier will not pay up');
assert.strictEqual(batchJobs.length, 0);
assert.ok(buyer.tryDirectEnergyPurchase(room, 25000, 25.0, true) > 0, 'a critical room pays a premium for immediacy');
assert.strictEqual(batchJobs.length, 1);

// ── No terminal energy means no freight, so no deal. ─────────────────────
room = resetEnv(100);
pricing = require('../marketPricing');
buyer = require('../autoEnergyBuyer');
assert.strictEqual(buyer.tryDirectEnergyPurchase(room, 25000, 40.0, true), 0, 'cannot pay freight, cannot deal');
assert.strictEqual(batchJobs.length, 0);

// ── The buy ceiling still governs the direct route. ──────────────────────
orders = [ask('gouge', 1e6, 50000, 'W1N1')];
room = resetEnv();
pricing = require('../marketPricing');
buyer = require('../autoEnergyBuyer');
assert.strictEqual(buyer.bestDirectEnergyOffer('E9N47', 25000), null, 'asks above the corroborated ceiling are not offers');

// ── The status valuation takes the cheaper of the two routes. ────────────
// Note the shape these cases have to take: in an UNCROSSED book the posted bid
// always sits under the best ask, so the direct route cannot win by
// construction. It wins only when the book is crossed -- distant players
// bidding above nearby asks -- which is exactly the basis state shard3 energy
// is in, with bids at 50 in the south-east against asks at 24 in the north.
// Asks at 24 ten rooms out against bids at 50: paying 28% freight lands energy
// at ~33.5, under the ~36 the crossed book values a resting bid at.
orders = book(24.0, 'N', 50.0);
room = resetEnv();
pricing = require('../marketPricing');
let quote = pricing.energyAcquisitionQuote();
assert.strictEqual(quote.route, 'DIRECT', 'a near ask at 24 beats resting a bid at 40');
assert.ok(quote.bid > 30, 'the bid leg is real: ' + quote.bid);
assert.ok(quote.direct.delivered > 24 && quote.direct.delivered < quote.bid, 'delivered sits between ask and bid: ' + quote.direct.delivered);
assert.strictEqual(pricing.getStatusEnergyPrice(), quote.direct.delivered, 'status quotes the winning route');

// Same asks, now 60 rooms out. Freight is 86%, so the ask is unreachable under
// the yield floor and the bid route wins -- same sticker price, other answer.
orders = book(24.0, 'F', 40.0);
room = resetEnv();
pricing = require('../marketPricing');
quote = pricing.energyAcquisitionQuote();
assert.strictEqual(quote.route, 'BID', 'freight makes the distant ask the dearer route');
assert.strictEqual(quote.direct, null, 'below the yield floor there is no direct route to price');
assert.strictEqual(pricing.getStatusEnergyPrice(), quote.bid);

// And when the bid route is the cheaper of the two, it is still chosen even
// though a direct route exists.
orders = book(24.0, 'N', 30.0);
room = resetEnv();
pricing = require('../marketPricing');
quote = pricing.energyAcquisitionQuote();
assert.strictEqual(quote.route, 'BID', 'a cheaper bid leg beats the 33.5 delivered ask');
assert.ok(quote.direct && quote.direct.delivered > quote.bid);
assert.strictEqual(pricing.getStatusEnergyPrice(), quote.bid);

// ── Valuation and posting are different questions. ───────────────────────
// With a cheap ask available, energy is WORTH the delivered price, but the bid
// we post must still be the competitive bid -- resting under the market to
// match a direct price we could simply go and take wins nothing.
orders = book(24.0, 'N', 50.0);
room = resetEnv();
pricing = require('../marketPricing');
quote = pricing.energyAcquisitionQuote();
assert.strictEqual(quote.route, 'DIRECT');
assert.strictEqual(pricing.getStatusEnergyPrice(), quote.direct.delivered, 'valuation follows the cheaper route');
assert.strictEqual(pricing.passiveBuyPrice('energy'), quote.bid, 'the posted bid stays on the bid leg');
assert.ok(pricing.passiveBuyPrice('energy') > pricing.getStatusEnergyPrice(), 'and is dearer than the direct route here');

// ── Freight lands differently for anything that is not energy. ───────────
// Buying batteries, the full count arrives and the energy is a separate cost.
// Buying energy, the freight comes out of the shipment itself.
orders = book(24.0, 'N', 50.0);
for (let i = 0; i < 6; i++) {
  orders.push({ id: 'bat' + i, type: ORDER_SELL, resourceType: 'battery', price: 100 + i, amount: 10000, remainingAmount: 10000, roomName: 'N' + i });
  orders.push({ id: 'batbid' + i, type: ORDER_BUY, resourceType: 'battery', price: 90 - i, amount: 10000, remainingAmount: 10000, roomName: 'B' + i });
}
history = [];
for (let i = 0; i < 14; i++) {
  history.push({ resourceType: 'x', date: '2026-08-' + (11 + i), transactions: 900, volume: 4e6, avgPrice: 100, stddevPrice: 2 });
}
room = resetEnv();
pricing = require('../marketPricing');

const batQuote = pricing.deliveredBuyQuote('battery', 5000, 'E9N47');
assert.strictEqual(batQuote.net, batQuote.take, 'the whole battery shipment arrives');
assert.strictEqual(batQuote.yield, 1);
assert.ok(batQuote.freightCredits > 0, 'freight still costs, just in credits');
assert.ok(
  Math.abs(batQuote.delivered - (batQuote.price + batQuote.freightCredits / batQuote.take)) < 1e-9,
  'non-energy delivered = price + freight valued in energy, per unit'
);
assert.ok(batQuote.delivered > batQuote.price, 'freight is never free');

const energyQuote = pricing.deliveredBuyQuote('energy', 5000, 'E9N47');
assert.ok(energyQuote.net < energyQuote.take, 'the energy shipment shrinks in transit');
assert.strictEqual(energyQuote.freightCredits, 0, 'energy freight is paid in the good, not in credits');

Module._load = originalModuleLoad;
console.log('Energy direct-buy regression test passed.');
