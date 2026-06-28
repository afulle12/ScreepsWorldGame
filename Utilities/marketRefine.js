// marketRefine.js
// Orchestrates a buy(inputs) -> refine(max) -> sell pipeline for factory products.
// Supports both simple bar/compressed products AND multi-input COMMODITIES recipes.
//
// REQUIRED console API:
//   marketRefine('W1N1', 'Zynthium bar')
//   marketRefine('W1N1', RESOURCE_COMPOSITE)
//   marketRefine('W1N1', RESOURCE_COMPOSITE, { utrium_bar: 330, zynthium_bar: 79 })  // with max prices
//
// Helpers:
//   marketRefineStatus()            // list ops
//   marketRefineStatus('op_id')     // details
//   cancelMarketRefine('op_id')     // cancel op + linked marketBuy orders
//   cancelLastMarketRefine()        // cancel the most recent op (helper)
//   abortMarketRefine(room, product) // cancel a still-buying op + sell back acquired inputs
//   marketRefineDebugOpBuy()         // print detected opportunisticBuy methods (console)
//   marketRefineOutcomes(n)          // show last n recorded outcomes (default 20)
//   cancelAllMarketRefine()
//
// Constraints per user instructions:
// - Use getRoomState for room reads.
// - Wait for buy before refining; call orderFactory(..., 'max'); wait; then sell newly produced output via marketSell.
// - No optional chaining.
//
// SPECIAL CASES:
// - Battery production uses marketSell to acquire energy (only suitable mechanism for energy).
// - Biomass always uses marketBuy (deposit resource; standing orders are the only practical source).
//
// DISPATCHER (v3):
// - Per input, chooses marketBuy (standing order) vs opportunisticBuy via marketPricing +
//   the status-report energy price (marketBuyer.computeBuyPrice(RESOURCE_ENERGY) = bestBid+0.1
//   or 95% of 2-day avg):
//     * resource in MARKET_BUY_FORCE_LIST                  -> marketBuy (manual override)
//     * ENERGY input                                       -> opportunistic
//     * value > energyBuyPrice AND range7d > RANGE_GATE    -> opportunistic (expensive + volatile)
//     * trend7d === 'rising' AND takeable ask              -> opportunistic (posted bid won't fill)
//     * otherwise                                          -> marketBuy (cheap / stable / thin)
// - Bid pricing for marketBuy uses bestBid + 0.1 (or ceiling, whichever is lower) so the
//   order is competitive on placement. marketBuy.run() also reprices UP if bestBid climbs
//   and the ceiling still allows it (capped at MAX_UP_REPRICES per order).
// - Force list is editable at runtime via global.marketRefineForceList() console command.
//
// ORDER LINKAGE (v2):
// - Order ids CANNOT be captured synchronously (createOrder returns OK; the order
//   appears in Game.market.orders next tick). The buying loop polls
//   marketBuyer.getOrderRecordFor(room, resource) until rec.orderId is populated.
// - Fill progress for marketBuy inputs is read from the managed order record
//   (tranche-aware, tombstone-aware), NOT from room deltas.
//
// EXPIRY (v2):
// - Acquisition is evaluated BEFORE expiry, so an op whose final fill lands on the
//   deadline transitions to refining instead of being killed.
// - On expiry/abort, each marketBuy order is judged against the FLOOR margin ceiling
//   (marketPricing.inputCeilings(output, FLOOR_MARGIN)): margin dead -> cancel;
//   margin alive -> passivate (marketBuy.js keeps auditing it).
//
// OUTCOMES LEDGER (new):
// - When an op leaves the active ops array (done OR failed), a small record is
//   appended to Memory.marketRefine.outcomes (capped at OUTCOMES_HISTORY_CAP).
// - This lets autoTrader (and marketRefineOutcomes()) distinguish "this job
//   actually produced output" from "this job failed and was silently dropped",
//   which previously both looked like the op simply disappearing.

var getRoomState = require('getRoomState');
var marketBuyer = require('marketBuy');
var pricing = require('marketPricing');

// ===== opportunisticBuy loader (define BEFORE any use) =====
function getOpBuy() {
  var opBuy = global.opportunisticBuy;
  if (!opBuy) {
    try { opBuy = require('opportunisticBuy'); } catch (e) { opBuy = null; }
  }
  return opBuy;
}
function opBuyMethodsString() {
  var opBuy = getOpBuy();
  if (!opBuy) return '(not found)';
  var keys = [];
  for (var k in opBuy) {
    if (typeof opBuy[k] === 'function') keys.push(k + '()');
    else keys.push(k + ':' + typeof opBuy[k]);
  }
  if (typeof opBuy === 'function') keys.unshift('(callable export)');
  return keys.join(', ');
}

// ===== INTERNAL MEMORY =====
function ensureMemory() {
  if (!Memory.marketRefine) Memory.marketRefine = { ops: [], outcomes: [] };
  if (!Array.isArray(Memory.marketRefine.ops)) Memory.marketRefine.ops = [];
  if (!Array.isArray(Memory.marketRefine.outcomes)) Memory.marketRefine.outcomes = [];
}

// Maximum number of outcome records to retain.
var OUTCOMES_HISTORY_CAP = 25;

/**
 * Record that an op has left the active ops array, either successfully
 * ('done') or unsuccessfully ('failed'). autoTrader's history renderer uses
 * this to report real status instead of guessing "[done]" for anything that
 * is no longer in Memory.marketRefine.ops.
 */
function recordOutcome(op, status, reason) {
  ensureMemory();
  Memory.marketRefine.outcomes.push({
    id: op.id,
    room: op.room,
    output: op.output,
    status: status,                 // 'done' | 'failed'
    reason: reason || op.failReason || null,
    started: op.started,
    tick: Game.time
  });
  if (Memory.marketRefine.outcomes.length > OUTCOMES_HISTORY_CAP) {
    Memory.marketRefine.outcomes = Memory.marketRefine.outcomes.slice(-OUTCOMES_HISTORY_CAP);
  }
}

// ===== OUTPUT NORMALIZATION =====
function normalizeOutput(p) {
  if (p && typeof p !== 'string') return p;
  var s = (p || '').trim().toUpperCase();
  var map = {
    OXIDANT: RESOURCE_OXIDANT,
    REDUCTANT: RESOURCE_REDUCTANT,
    'ZYNTHIUM BAR': RESOURCE_ZYNTHIUM_BAR, ZYNTHIUM_BAR: RESOURCE_ZYNTHIUM_BAR,
    'LEMERGIUM BAR': RESOURCE_LEMERGIUM_BAR, LEMERGIUM_BAR: RESOURCE_LEMERGIUM_BAR,
    'UTRIUM BAR': RESOURCE_UTRIUM_BAR, UTRIUM_BAR: RESOURCE_UTRIUM_BAR,
    'KEANIUM BAR': RESOURCE_KEANIUM_BAR, KEANIUM_BAR: RESOURCE_KEANIUM_BAR,
    'GHODIUM MELT': RESOURCE_GHODIUM_MELT, GHODIUM_MELT: RESOURCE_GHODIUM_MELT,
    PURIFIER: RESOURCE_PURIFIER,
    COMPOSITE: RESOURCE_COMPOSITE,
    CRYSTAL: RESOURCE_CRYSTAL,
    LIQUID: RESOURCE_LIQUID,
    WIRE: RESOURCE_WIRE,
    CELL: RESOURCE_CELL,
    ALLOY: RESOURCE_ALLOY,
    CONDENSATE: RESOURCE_CONDENSATE,
    TUBE: RESOURCE_TUBE,
    FIXTURES: RESOURCE_FIXTURES,
    FRAME: RESOURCE_FRAME,
    HYDRAULICS: RESOURCE_HYDRAULICS,
    MACHINE: RESOURCE_MACHINE,
    PHLEGM: RESOURCE_PHLEGM,
    TISSUE: RESOURCE_TISSUE,
    MUSCLE: RESOURCE_MUSCLE,
    ORGANOID: RESOURCE_ORGANOID,
    ORGANISM: RESOURCE_ORGANISM,
    SWITCH: RESOURCE_SWITCH,
    TRANSISTOR: RESOURCE_TRANSISTOR,
    MICROCHIP: RESOURCE_MICROCHIP,
    CIRCUIT: RESOURCE_CIRCUIT,
    DEVICE: RESOURCE_DEVICE,
    CONCENTRATE: RESOURCE_CONCENTRATE,
    EXTRACT: RESOURCE_EXTRACT,
    SPIRIT: RESOURCE_SPIRIT,
    EMANATION: RESOURCE_EMANATION,
    ESSENCE: RESOURCE_ESSENCE,
    UTRIUM: RESOURCE_UTRIUM,
    LEMERGIUM: RESOURCE_LEMERGIUM,
    ZYNTHIUM: RESOURCE_ZYNTHIUM,
    KEANIUM: RESOURCE_KEANIUM,
    GHODIUM: RESOURCE_GHODIUM,
    OXYGEN: RESOURCE_OXYGEN,
    HYDROGEN: RESOURCE_HYDROGEN,
    CATALYST: RESOURCE_CATALYST
  };
  if (map[s]) return map[s];
  if (global[s]) return global[s];
  return p;
}

// Legacy single-input map (still used as fallback for simple products)
var OUTPUT_TO_INPUT = {};
OUTPUT_TO_INPUT[RESOURCE_OXIDANT]        = RESOURCE_OXYGEN;
OUTPUT_TO_INPUT[RESOURCE_REDUCTANT]      = RESOURCE_HYDROGEN;
OUTPUT_TO_INPUT[RESOURCE_PURIFIER]       = RESOURCE_CATALYST;
OUTPUT_TO_INPUT[RESOURCE_ZYNTHIUM_BAR]   = RESOURCE_ZYNTHIUM;
OUTPUT_TO_INPUT[RESOURCE_LEMERGIUM_BAR]  = RESOURCE_LEMERGIUM;
OUTPUT_TO_INPUT[RESOURCE_UTRIUM_BAR]     = RESOURCE_UTRIUM;
OUTPUT_TO_INPUT[RESOURCE_KEANIUM_BAR]    = RESOURCE_KEANIUM;
OUTPUT_TO_INPUT[RESOURCE_GHODIUM_MELT]   = RESOURCE_GHODIUM;

// Default buy amount for simple single-input products (legacy fallback)
var DEFAULT_BUY_AMOUNT = 6000;

// Buy amount multiplier for multi-input recipes (how many batches to buy for).
// compression:   500 minerals/batch x 12 = 6,000 minerals bought -> 1,200 bars produced
// decompression: 100 bars/batch    x 12 = 1,200 bars bought      -> 6,000 minerals produced
var RECIPE_BATCH_MULTIPLIER = 12;

// How many ticks before a stuck buying op is abandoned and cleaned up.
// Only applies to the 'buying' phase - once inputs are acquired and a factory
// order is placed, the op runs until production completes regardless of age.
var OP_EXPIRY_TICKS = 100000;

// Margin thresholds (coupled to autoTrader's MARGIN_THRESHOLD)
var MARGIN_THRESHOLD = 40;                            // percent (target margin)
var FLOOR_MARGIN     = 20;                            // percent (passivate-vs-cancel line)
var RANGE_GATE       = (MARGIN_THRESHOLD / 2) / 100;  // 0.20 = 20% weekly range

// Manual force-list: resources that should ALWAYS use marketBuy (posted standing
// orders), bypassing the value+volatility dispatcher. These processed base
// resources are low-value enough that the energy cost of opportunisticBuy.deal()
// is a meaningful chunk of the cost, and posted bids accumulate passively.
var MARKET_BUY_FORCE_LIST = {
    [RESOURCE_BIOMASS]: true,
    [RESOURCE_METAL]:   true,
    [RESOURCE_SILICON]: true,
    [RESOURCE_MIST]:    true
};

/**
 * Check if a specific input for a product should be acquired via marketSell
 * instead of buying. Currently only energy for battery production qualifies,
 * since marketSell is currently the only mechanism suitable for buying energy.
 */
function shouldUseMarketSell(output, inputResource) {
    return output === RESOURCE_BATTERY && inputResource === RESOURCE_ENERGY;
}

/**
 * Dispatcher: should this input use a standing marketBuy order instead of
 * opportunisticBuy? Decision is value+volatility based, not spread-based.
 *
 *   1. resource in MARKET_BUY_FORCE_LIST        -> marketBuy (manual override)
 *   2. ENERGY                                   -> opportunistic (marketSell handles battery input)
 *   3. value > energyBuyPrice AND range7d > RANGE_GATE -> opportunistic
 *      (expensive + volatile: posted bid won't fill sanely, deal()'s energy fee
 *       is small in absolute terms so the standing-order alternative is worse)
 *   4. trend7d === 'rising' AND takeable ask    -> opportunistic
 *   5. default -> marketBuy (cheap / stable / thin)
 */
function shouldUseMarketBuy(output, inputResource, ceilingPrice) {
    // Hard overrides
    if (MARKET_BUY_FORCE_LIST[inputResource]) return true;
    if (inputResource === RESOURCE_ENERGY) return false;

    var book  = pricing.getBook(inputResource);
    var range = pricing.getRange7d(inputResource);
    var trend = pricing.getTrend7d(inputResource);

    // Same value the status printout uses for energy.
    var energyBuyPrice = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);

    var avg = pricing.getAvg48h(inputResource);
    var value = (typeof avg === 'number' && avg > 0) ? avg : (ceilingPrice || 0);

    var hasCeiling = typeof ceilingPrice === 'number' && ceilingPrice > 0;
    var takeableAsk = book.bestAsk !== null && (!hasCeiling || book.bestAsk <= ceilingPrice);

    if (value > energyBuyPrice && range !== null && range > RANGE_GATE) return false;
    if (trend === 'rising' && takeableAsk) return false;
    return true;
}

/**
 * Compute a competitive bid for marketBuy: leads the best external bid by 0.1,
 * floored by the volume-weighted ask, and ignores a bestBid that sits above the
 * volume-weighted ask (crossed/manipulated book). Capped by `ceiling`.
 *
 * Returns null when the resulting bid exceeds the ceiling - a starved/unprofitable
 * order would only get a useless fill, so the caller should refuse to start the op
 * (marketRefine callers surface this as a refusal string).
 *
 * Returns at least 0.001 in the normal case.
 */
function computeCompetitiveBid(resource, ceiling) {
    return pricing.computePostedBid(resource, ceiling);
}

/**
 * Get the recipe inputs for a product.
 */
function getRecipeInputs(output, batchMultiplier) {
    if (COMMODITIES && COMMODITIES[output]) {
        var recipe = COMMODITIES[output];
        var comps = recipe.components || {};
        var inputs = [];
        for (var res in comps) {
            if (!comps.hasOwnProperty(res)) continue;
            if (res === RESOURCE_ENERGY && output !== RESOURCE_BATTERY) continue;
            var amount = comps[res] * (batchMultiplier || RECIPE_BATCH_MULTIPLIER);
            inputs.push({ resource: res, amount: amount });
        }
        if (inputs.length > 0) return inputs;
    }
    if (OUTPUT_TO_INPUT[output]) {
        return [{ resource: OUTPUT_TO_INPUT[output], amount: DEFAULT_BUY_AMOUNT }];
    }
    return null;
}

// ===== FAILURE NOTIFICATION =====

function failOp(op, reason, detail) {
    var msg = '[MarketRefine] FAILED: ' + op.id + ' (' + op.output + ' in ' + op.room + ') - ' + reason;
    if (detail) msg += ' | ' + detail;
    console.log(msg);
    //Game.notify(msg, 30); // group notifications within 30 minutes
    op.phase = 'failed';
    op.failReason = reason;
    op.failTick = Game.time;
    recordOutcome(op, 'failed', reason);
}

// ===== PRICE CEILING (default when caller supplies none) =====

function getMarketPriceStr(resourceType, mode) {
  var mp = null;
  if (typeof marketPrice === 'function') mp = marketPrice;
  if (!mp) {
    try {
      var mq = require('marketQuery');
      if (mq && typeof mq.marketPrice === 'function') mp = mq.marketPrice;
    } catch (e) {}
  }
  if (!mp) return null;
  try { return mp(resourceType, mode); } catch (e) { return null; }
}

function parseAvgPrice(str) {
  if (typeof str !== 'string') return null;
  var m = str.match(/avg[^:]*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m && m[1]) return Number(m[1]);
  return null;
}

function parseFirstNumber(str) {
  if (typeof str !== 'string') return null;
  var m = str.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (m && m[1]) return Number(m[1]);
  return null;
}

function computeCeiling(resourceType) {
  var avg = pricing.getAvg48h(resourceType);
  if (typeof avg === 'number' && avg > 0) return avg;
  var out = getMarketPriceStr(resourceType, 'avg');
  if (out == null) out = getMarketPriceStr(resourceType, undefined);
  if (typeof out === 'number' && out > 0) return out;
  var n = parseAvgPrice(out);
  if (typeof n !== 'number' || !(n > 0)) n = parseFirstNumber(out);
  if (typeof n === 'number' && n > 0) return n;
  return 1;
}

// ===== EXTERNAL HELPER WRAPPERS =====

function invokeOpportunisticBuy(roomName, resourceType, amount, maxPrice) {
  var opBuy = getOpBuy();
  if (!opBuy) return '[MarketRefine] ERROR: opportunisticBuy module not available.';
  try {
    if (typeof opBuy.setup === 'function')      return opBuy.setup(roomName, resourceType, amount, maxPrice);
    if (typeof opBuy.requestBuy === 'function') return opBuy.requestBuy(roomName, resourceType, amount, maxPrice);
    if (typeof opBuy.addRequest === 'function') return opBuy.addRequest(roomName, resourceType, amount, maxPrice);
    if (typeof opBuy.request === 'function')    return opBuy.request(roomName, resourceType, amount, maxPrice);
    if (typeof opBuy.enqueue === 'function')    return opBuy.enqueue(roomName, resourceType, amount, maxPrice);
    if (typeof opBuy.queue === 'function')      return opBuy.queue(roomName, resourceType, amount, maxPrice);
    if (typeof opBuy.buy === 'function')        return opBuy.buy(roomName, resourceType, amount, maxPrice);
    if (typeof opBuy === 'function')            return opBuy(roomName, resourceType, amount, maxPrice);
  } catch (e) {
    return '[MarketRefine] ERROR invoking opportunisticBuy: ' + e;
  }
  return '[MarketRefine] ERROR: Unknown opportunisticBuy API; methods: ' + opBuyMethodsString();
}

function cancelOpBuyRequest(roomName, resourceType) {
  var opBuy = getOpBuy();
  if (!opBuy) return;
  try {
    if (typeof opBuy.cancelRequest === 'function') { opBuy.cancelRequest(roomName, resourceType); return; }
    if (typeof opBuy.cancel === 'function')        { opBuy.cancel(roomName, resourceType); return; }
  } catch (e) {}
  if (Memory.opportunisticBuy && Memory.opportunisticBuy.requests) {
    var key = roomName + '_' + resourceType;
    if (Memory.opportunisticBuy.requests[key]) delete Memory.opportunisticBuy.requests[key];
  }
}

function hasActiveOpBuyRequest(roomName, resourceType) {
  var opBuy = getOpBuy();
  try {
    if (opBuy && typeof opBuy.hasActive === 'function') return !!opBuy.hasActive(roomName, resourceType);
    if (opBuy && typeof opBuy.hasRequest === 'function') return !!opBuy.hasRequest(roomName, resourceType);
  } catch (e) {}
  if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) return false;
  var key = roomName + '_' + resourceType;
  var req = Memory.opportunisticBuy.requests[key];
  return !!(req && req.remaining > 0);
}

function callOrderFactory(roomName, productType) {
  if (typeof orderFactory === 'function') {
    return orderFactory(roomName, productType, 'max');
  }
  try {
    var fm = require('factoryManager');
    if (fm && typeof fm.orderFactory === 'function') {
      return fm.orderFactory(roomName, productType, 'max');
    }
  } catch (e) {}
  return '[MarketRefine] ERROR: orderFactory not available.';
}

function callMarketSell(roomName, resourceType, amount) {
  var ms = global.marketSell;
  if (!ms) {
    try { ms = require('marketSell'); } catch (e) { ms = null; }
  }
  if (!ms) return '[MarketRefine] ERROR: marketSell not available.';
  try {
    if (typeof ms.sell === 'function') return ms.sell(roomName, resourceType, amount);
    if (typeof ms.run === 'function')  return ms.run(roomName, resourceType, amount);
    if (typeof ms === 'function')      return ms(roomName, resourceType, amount);
  } catch (e) {
    return '[MarketRefine] ERROR invoking marketSell: ' + e;
  }
  return '[MarketRefine] ERROR: Unknown marketSell API.';
}

function callMarketBuy(roomName, resourceType, amount, maxPrice, product) {
  try {
    var msg = marketBuyer.marketBuy(roomName, resourceType, amount, maxPrice,
                                    { product: product, room: roomName, ceiling: maxPrice });
    var ok = typeof msg === 'string' && msg.indexOf('Created BUY order') >= 0;
    return { ok: ok, message: msg };
  } catch (e) {
    return { ok: false, message: '[MarketRefine] ERROR invoking marketBuy: ' + e };
  }
}

function pollMarketBuyOrderId(op, inp) {
  var rec = marketBuyer.getOrderRecordFor(op.room, inp.resource);
  if (rec && rec.orderId && !inp.marketBuyOrderId) {
    inp.marketBuyOrderId = rec.orderId;
  }
  return rec;
}

// ===== ROOM HELPERS (getRoomState only) =====
function roomOwned(roomName) {
  var state = getRoomState.get(roomName);
  return !!(state && state.controller && state.controller.my);
}

function roomHasTerminal(roomName) {
  var state = getRoomState.get(roomName);
  return !!(state && state.terminal);
}

function countInRoom(roomName, resourceType) {
  var state = getRoomState.get(roomName);
  if (!state) return 0;

  var total = 0;
  function add(s) { if (s && s.store && s.store[resourceType]) total += s.store[resourceType]; }

  add(state.storage);
  add(state.terminal);

  var stMap = state.structuresByType || {};

  var factories = stMap[STRUCTURE_FACTORY] || [];
  if (factories.length > 0) add(factories[0]);

  var containers = stMap[STRUCTURE_CONTAINER] || [];
  for (var i = 0; i < containers.length; i++) add(containers[i]);

  return total;
}

// ===== FACTORY ORDER TRACKING (Memory-based) =====
function startFactoryMax(roomName, outputResource) {
  var msg = callOrderFactory(roomName, outputResource);
  var id = null;
  if (typeof msg === 'string') {
    var m = msg.match(/\[#([^\]]+)\]/);
    if (m && m[1]) id = m[1];
  }
  return { message: msg, orderId: id };
}

function findFactoryOrderById(id) {
  var list = (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) ? Memory.factoryOrders : [];
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
  return null;
}

function findCompletedFactoryOrderById(id) {
  var list = (Memory.factoryOrderHistory && Array.isArray(Memory.factoryOrderHistory)) ? Memory.factoryOrderHistory : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

function anyFactoryOrderAfter(roomName, product, createdTick) {
  var list = (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) ? Memory.factoryOrders : [];
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    if (o && o.room === roomName && o.product === product && typeof o.created === 'number' && o.created >= createdTick) return true;
  }
  return false;
}

// ===== ACQUISITION TRACKING =====

function getInputAcquired(op, inp) {
  var have = countInRoom(op.room, inp.resource);
  var roomAcquired = have - (typeof inp.baseCount === 'number' ? inp.baseCount : 0);
  roomAcquired = roomAcquired > 0 ? roomAcquired : 0;
  if (inp.useMarketBuy) {
    var rec = pollMarketBuyOrderId(op, inp);
    if (rec) return Math.max(marketBuyer.getFulfilled(rec), roomAcquired);
  }
  return roomAcquired;
}

// Recreate a marketBuy order if the underlying order has disappeared.
// Returns true if a live order exists or was successfully recreated.
// On failure/unprofitability it falls back to opportunisticBuy and returns false.
function ensureMarketBuyOrder(op, inp) {
  if (!inp.useMarketBuy) return true;

  var rec = marketBuyer.getOrderRecordFor(op.room, inp.resource);
  var orderLive = false;
  if (rec && !rec.done && !rec.cancelled) {
    if (!rec.orderId) orderLive = true; // pending id capture
    else if (Game.market.orders[rec.orderId]) orderLive = true;
  }
  if (orderLive) return true;

  var acquired = getInputAcquired(op, inp);
  var remaining = Math.max(0, inp.amount - acquired);
  if (remaining <= 0) return true;

  console.log('[MarketRefine] marketBuy order for ' + inp.resource + ' in ' + op.room +
      ' is missing/cancelled (op ' + op.id + '). Recreating for remaining ' + remaining + '.');

  var bidPrice = computeCompetitiveBid(inp.resource, inp.maxPrice);
  if (bidPrice === null) {
    console.log('[MarketRefine] Cannot recreate marketBuy for ' + inp.resource + ' in ' + op.room +
        ': bid would exceed ceiling ' + inp.maxPrice.toFixed(3) + '. Falling back to opportunisticBuy.');
    inp.useMarketBuy = false;
    if (rec && rec.orderId) marketBuyer.cancelOrderById(rec.orderId, 'recreate fallback');
    else marketBuyer.cancelOrderFor(op.room, inp.resource, 'recreate fallback');
    invokeOpportunisticBuy(op.room, inp.resource, remaining, inp.maxPrice);
    return false;
  }

  var createRes = callMarketBuy(op.room, inp.resource, remaining, bidPrice, op.output);
  if (createRes.ok) {
    console.log('[MarketRefine] Recreated marketBuy for ' + inp.resource + ' in ' + op.room +
        ': ' + remaining + ' @ ' + bidPrice.toFixed(3) + ' (ceiling ' + inp.maxPrice.toFixed(3) + ')');
    inp.marketBuyOrderId = null; // will be captured by pollMarketBuyOrderId on next ticks
    return true;
  }

  // Creation failed (order cap, credits, etc.) -> opportunisticBuy fallback.
  console.log('[MarketRefine] Failed to recreate marketBuy for ' + inp.resource + ' in ' + op.room +
      ': ' + createRes.message + '. Falling back to opportunisticBuy.');
  inp.useMarketBuy = false;
  if (rec && rec.orderId) marketBuyer.cancelOrderById(rec.orderId, 'recreate fallback');
  else marketBuyer.cancelOrderFor(op.room, inp.resource, 'recreate fallback');
  invokeOpportunisticBuy(op.room, inp.resource, remaining, inp.maxPrice);
  return false;
}

// ===== EXPIRY HANDLER (margin-aware, per input) =====

function expireOp(op, reasonOverride) {
  var age = Game.time - op.started;
  var reason = reasonOverride || ('Expired after ' + age + ' ticks (phase=' + op.phase + ')');

  var sellParts = [];

  var floorCeilings = pricing.inputCeilings(op.output, FLOOR_MARGIN);

  if (op.inputs && op.inputs.length > 0) {
    for (var k = 0; k < op.inputs.length; k++) {
      var inp = op.inputs[k];
      var useMS = inp.useMarketSell || shouldUseMarketSell(op.output, inp.resource);

      if (useMS) {
        // marketSell inputs are managed externally; nothing to cancel here.
      } else if (inp.useMarketBuy) {
        pollMarketBuyOrderId(op, inp);

        var ceil = floorCeilings ? floorCeilings[inp.resource] : null;
        var order = inp.marketBuyOrderId ? Game.market.orders[inp.marketBuyOrderId] : null;
        var marginDead = (typeof ceil !== 'number') || !(ceil > 0) || (order && order.price > ceil);

        if (inp.marketBuyOrderId) {
          if (marginDead) {
            marketBuyer.cancelOrderById(inp.marketBuyOrderId, 'op expiry, margin dead');
            console.log('[MarketRefine] Cancelled marketBuy order ' + inp.marketBuyOrderId +
                ' (margin dead) for ' + inp.resource + ' in ' + op.room);
          } else {
            marketBuyer.passivateOrder(inp.marketBuyOrderId, op.output);
            console.log('[MarketRefine] Passivated marketBuy order ' + inp.marketBuyOrderId +
                ' (margin OK at floor ' + FLOOR_MARGIN + '%) for ' + inp.resource + ' in ' + op.room);
          }
        } else {
          marketBuyer.cancelOrderFor(op.room, inp.resource, 'op expiry, no captured id');
        }
      } else {
        if (hasActiveOpBuyRequest(op.room, inp.resource)) {
          cancelOpBuyRequest(op.room, inp.resource);
          console.log('[MarketRefine] Cancelled opportunisticBuy for ' + inp.resource + ' in ' + op.room);
        }
      }

      var have = countInRoom(op.room, inp.resource);
      var baseCount = typeof inp.baseCount === 'number' ? inp.baseCount : 0;
      var acquired = have - baseCount;
      if (acquired > 0) {
        callMarketSell(op.room, inp.resource, acquired);
        sellParts.push(acquired + ' ' + inp.resource);
      }
    }
  } else {
    var legacyResource = op.input;
    if (legacyResource && legacyResource !== '(multi)') {
      var useLegacyMS = shouldUseMarketSell(op.output, legacyResource);
      if (!useLegacyMS && !op.useMarketBuy) {
        if (hasActiveOpBuyRequest(op.room, legacyResource)) {
          cancelOpBuyRequest(op.room, legacyResource);
          console.log('[MarketRefine] Cancelled opportunisticBuy for ' + legacyResource + ' in ' + op.room);
        }
      } else if (op.useMarketBuy) {
        marketBuyer.cancelOrderFor(op.room, legacyResource, 'legacy op expiry');
      }
      var legacyHave = countInRoom(op.room, legacyResource);
      var legacyBase = typeof op.baseInputCount === 'number' ? op.baseInputCount : 0;
      var legacyAcquired = legacyHave - legacyBase;
      if (legacyAcquired > 0) {
        callMarketSell(op.room, legacyResource, legacyAcquired);
        sellParts.push(legacyAcquired + ' ' + legacyResource);
      }
    }
  }

  var detail = sellParts.length > 0
    ? 'Selling acquired inputs: ' + sellParts.join(', ')
    : 'No acquired inputs to sell';
  failOp(op, reason, detail);
}

// ===== CONSOLE API =====

global.marketRefine = function(roomName, outputLike, maxPrices) {
  ensureMemory();
  getRoomState.init();

  if (typeof roomName !== 'string' || !roomName) {
    return '[MarketRefine] Provide a valid room name.';
  }
  if (!roomOwned(roomName)) {
    return '[MarketRefine] Room not owned or not visible: ' + roomName;
  }
  if (!roomHasTerminal(roomName)) {
    return '[MarketRefine] Room ' + roomName + ' has no terminal.';
  }

  var output = normalizeOutput(outputLike);

  var recipeInputs = getRecipeInputs(output);
  if (!recipeInputs || recipeInputs.length === 0) {
    return '[MarketRefine] Unsupported output: ' + outputLike + '. Must be a valid COMMODITIES product or compressed resource.';
  }

  var plan = [];
  for (var c = 0; c < recipeInputs.length; c++) {
    var inpC = recipeInputs[c];
    var ceilC = (maxPrices && typeof maxPrices[inpC.resource] === 'number')
      ? maxPrices[inpC.resource] : computeCeiling(inpC.resource);
    var useMSC = shouldUseMarketSell(output, inpC.resource);
    var useMBC = !useMSC && shouldUseMarketBuy(output, inpC.resource, ceilC);

    if (!useMSC && !useMBC && hasActiveOpBuyRequest(roomName, inpC.resource)) {
      return '[MarketRefine] ERROR: Active opportunisticBuy request already exists for ' +
             inpC.resource + ' in ' + roomName + '. Cancel it first or wait for completion.';
    }
    // NOTE: no pre-flight check for an existing marketBuy order here. marketBuy
    // owns those records: it reclaims a stale/empty/passive order and creates a
    // fresh one, or refuses (return string) when a genuinely live order exists.
    // We act on its return value at call time below.
    plan.push({ resource: inpC.resource, amount: inpC.amount, ceiling: ceilC, useMS: useMSC, useMB: useMBC });
  }

  var inputs = [];
  var buyMsgs = [];
  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    var baseCount = countInRoom(roomName, p.resource);

    var inputRec = {
      resource: p.resource,
      amount: p.amount,
      maxPrice: p.ceiling,
      baseCount: baseCount,
      useMarketSell: p.useMS,
      useMarketBuy: p.useMB,
      marketBuyOrderId: null
    };

    if (p.useMS) {
      callMarketSell(roomName, p.resource, p.amount);
      buyMsgs.push(p.resource + ' x' + p.amount + ' (via marketSell)');
    } else if (p.useMB) {
      var bidPrice = computeCompetitiveBid(p.resource, p.ceiling);
      inputRec.bidPrice = bidPrice;
      if (bidPrice === null) {
        // volume-weighted ask exceeds our margin ceiling: a posted bid would be
        // starved. Roll back any prior-input buys and refuse the whole op.
        for (var rbNull = 0; rbNull < inputs.length; rbNull++) {
          var rbInpN = inputs[rbNull];
          if (rbInpN.useMarketSell) continue;
          if (rbInpN.useMarketBuy) marketBuyer.cancelOrderFor(roomName, rbInpN.resource, 'op aborted: ask floor > ceiling');
          else if (hasActiveOpBuyRequest(roomName, rbInpN.resource)) cancelOpBuyRequest(roomName, rbInpN.resource);
        }
        return '[MarketRefine] Refused ' + output + ' in ' + roomName +
               ': ask floor for ' + p.resource + ' exceeds ceiling ' + p.ceiling.toFixed(3) +
               ' (no profitable bid available).';
      }
      var createRes = callMarketBuy(roomName, p.resource, p.amount, bidPrice, output);
      if (createRes.ok) {
        buyMsgs.push(p.resource + ' x' + p.amount + ' @' + bidPrice.toFixed(3) +
                     ' (via marketBuy, ceiling ' + p.ceiling.toFixed(3) + ', id pending)');
      } else if (('' + createRes.message).indexOf('already exists') >= 0) {
        // A genuinely live marketBuy order for this input is still in flight.
        // Do NOT fall back to opportunisticBuy (that would post a competing buy).
        // Abort this whole op: roll back any buys already queued for prior inputs,
        // then bail. The op retries on a later cycle once the live order clears.
        for (var rb = 0; rb < inputs.length; rb++) {
          var rbInp = inputs[rb];
          if (rbInp.useMarketSell) continue;
          if (rbInp.useMarketBuy) marketBuyer.cancelOrderFor(roomName, rbInp.resource, 'op aborted: input conflict');
          else if (hasActiveOpBuyRequest(roomName, rbInp.resource)) cancelOpBuyRequest(roomName, rbInp.resource);
        }
        return '[MarketRefine] Aborted ' + output + ' in ' + roomName +
               ': live marketBuy order already exists for ' + p.resource +
               '. Will retry once it clears. (' + createRes.message + ')';
      } else {
        // Other failure (credits, ERR_FULL on order cap, etc.) -> fall back.
        console.log('[MarketRefine] marketBuy failed for ' + p.resource + ', falling back to opportunisticBuy: ' + createRes.message);
        inputRec.useMarketBuy = false;
        invokeOpportunisticBuy(roomName, p.resource, p.amount, p.ceiling);
        buyMsgs.push(p.resource + ' x' + p.amount + ' @' + p.ceiling.toFixed(3) + ' (fallback opportunistic)');
      }
    } else {
      invokeOpportunisticBuy(roomName, p.resource, p.amount, p.ceiling);
      buyMsgs.push(p.resource + ' x' + p.amount + ' @' + p.ceiling.toFixed(3));
    }

    inputs.push(inputRec);
  }

  var baseOutput = countInRoom(roomName, output);

  var id = 'mref_' + roomName + '_' + output + '_' + Game.time;
  var op = {
    id: id,
    room: roomName,
    output: output,
    inputs: inputs,
    input: inputs.length === 1 ? inputs[0].resource : '(multi)',
    targetBuy: inputs.length === 1 ? inputs[0].amount : 0,
    price: inputs.length === 1 ? inputs[0].maxPrice : 0,
    baseOutputCount: baseOutput,
    phase: 'buying',
    started: Game.time,
    lastUpdate: Game.time,
    buyRequestCreated: true,
    factoryProgressOut: 0
  };

  Memory.marketRefine.ops.push(op);
  return '[MarketRefine] Started ' + id + ' | buying: ' + buyMsgs.join(', ') + ' -> refine ' + output + ' (max) -> sell.';
};

global.marketRefineStatus = function(id) {
  ensureMemory();
  var ops = Memory.marketRefine.ops;
  if (!ops || ops.length === 0) return '[MarketRefine] No ops.';

  if (id) {
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (o && o.id === id) {
        var s = [];
        s.push('[' + o.id + '] room=' + o.room + ' phase=' + o.phase);
        var age = Game.time - (o.started || 0);
        var expiresIn = OP_EXPIRY_TICKS - age;
        s.push('  age=' + age + ' ticks' + (o.phase === 'buying' ? ' | expires in ' + (expiresIn > 0 ? expiresIn : 0) + ' ticks' : ' | no expiry (inputs acquired)'));
        if (o.inputs && o.inputs.length > 0) {
          for (var k = 0; k < o.inputs.length; k++) {
            var inp = o.inputs[k];
            var acquired = getInputAcquired(o, inp);

            var orderFill = '';
            if (inp.useMarketBuy) {
              var rec = marketBuyer.getOrderRecordFor(o.room, inp.resource);
              if (rec && rec.orderId) {
                var ord = Game.market.orders[rec.orderId];
                if (rec.done) orderFill = ' [order DONE ' + (rec.fulfilledFinal || 0) + '/' + rec.target + ']';
                else if (rec.cancelled) orderFill = ' [order CANCELLED ' + (rec.fulfilledFinal || 0) + '/' + rec.target + ']';
                else if (ord) orderFill = ' [orderFill=' + marketBuyer.getFulfilled(rec) + '/' + rec.target +
                                          ' rem=' + ord.remainingAmount + ' cap=' + rec.trancheTotal +
                                          (rec.passive ? ' PASSIVE' : '') + ']';
                else orderFill = ' [order missing]';
              } else if (rec) {
                orderFill = ' [order id pending]';
              } else {
                orderFill = ' [no managed order]';
              }
            }

            var viaStr = inp.useMarketSell ? ' (via marketSell)' : (inp.useMarketBuy ? ' (via marketBuy)' : '');
            s.push('  input: ' + inp.resource + ' target=' + inp.amount + ' price=' + inp.maxPrice +
                   ' acquired=' + acquired + ' current=' + countInRoom(o.room, inp.resource) + viaStr + orderFill);
          }
        } else {
          s.push('  input: ' + o.input + ' target=' + o.targetBuy + ' price=' + o.price);
          s.push('  baseInput=' + (o.baseInputCount || 0) + ' currentInput=' + countInRoom(o.room, o.input));
        }
        s.push('  output: ' + o.output + (o.factoryOrderId ? (' orderId=' + o.factoryOrderId) : ''));
        s.push('  baseOutput=' + o.baseOutputCount + ' currentOutput=' + countInRoom(o.room, o.output));
        if (o.failReason) {
          s.push('  FAILURE: ' + o.failReason + ' (tick ' + (o.failTick || '?') + ')');
        }
        return s.join('\n');
      }
    }
    return '[MarketRefine] Op not found: ' + id;
  }

  var lines = [];
  for (var j = 0; j < ops.length; j++) {
    var op = ops[j];
    if (!op) continue;
    var age2 = Game.time - (op.started || 0);
    var expiresIn2 = OP_EXPIRY_TICKS - age2;
    var ageStr = op.phase === 'buying'
      ? ' age=' + age2 + (expiresIn2 < 10000 ? ' EXPIRES IN ' + Math.max(0, expiresIn2) : '')
      : ' age=' + age2;
    var failStr = op.phase === 'failed' ? ' FAILED: ' + (op.failReason || '?') : '';
    if (op.inputs && op.inputs.length > 0) {
      var inputNames = [];
      for (var m = 0; m < op.inputs.length; m++) {
        inputNames.push(op.inputs[m].resource + (op.inputs[m].useMarketBuy ? '*' : ''));
      }
      lines.push('[' + op.id + '] ' + op.room + ' ' + inputNames.join('+') + ' -> ' + op.output + ' | phase=' + op.phase + ageStr + failStr);
    } else {
      lines.push('[' + op.id + '] ' + op.room + ' ' + op.input + ' -> ' + op.output + ' | phase=' + op.phase + ageStr + failStr);
    }
  }
  lines.push('(* = via marketBuy standing order)');
  return lines.join('\n');
};

/**
 * Show recent outcomes (done/failed) from the outcomes ledger.
 * marketRefineOutcomes()       -> last 20
 * marketRefineOutcomes(50)     -> last 50
 * marketRefineOutcomes('W1N1') -> last 20 for that room
 * marketRefineOutcomes('W1N1', 50)
 */
global.marketRefineOutcomes = function(arg1, arg2) {
  ensureMemory();
  var outcomes = Memory.marketRefine.outcomes;
  if (!outcomes || outcomes.length === 0) return '[MarketRefine] No recorded outcomes yet.';

  var roomFilter = null, n = 20;
  if (typeof arg1 === 'string') roomFilter = arg1;
  else if (typeof arg1 === 'number') n = arg1;
  if (typeof arg2 === 'number') n = arg2;

  var filtered = outcomes;
  if (roomFilter) filtered = filtered.filter(function(o) { return o.room === roomFilter; });
  if (filtered.length === 0) return '[MarketRefine] No recorded outcomes' + (roomFilter ? ' for ' + roomFilter : '') + '.';

  var slice = filtered.slice(-n);
  var lines = ['[MarketRefine] Last ' + slice.length + ' of ' + filtered.length + ' outcome(s):', ''];
  for (var i = 0; i < slice.length; i++) {
    var o = slice[i];
    var age = Game.time - o.tick;
    var tag = o.status === 'failed' ? 'FAILED' : 'done';
    var reasonStr = o.reason ? ' - ' + o.reason : '';
    lines.push('  [' + age + ' ticks ago] ' + tag + ': ' + o.output + ' in ' + o.room + reasonStr);
  }
  return lines.join('\n');
};

global.cancelMarketRefine = function(id) {
  ensureMemory();
  var ops = Memory.marketRefine.ops;
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op && op.id === id) {
      if (op.inputs && op.inputs.length > 0) {
        for (var k = 0; k < op.inputs.length; k++) {
          var inp = op.inputs[k];
          if (inp.useMarketBuy) {
            if (inp.marketBuyOrderId) marketBuyer.cancelOrderById(inp.marketBuyOrderId, 'op cancelled');
            else marketBuyer.cancelOrderFor(op.room, inp.resource, 'op cancelled');
          }
        }
      }
      ops.splice(i, 1);
      return '[MarketRefine] Cancelled op ' + id + ' (linked marketBuy orders cancelled; ' +
             'opportunisticBuy requests, marketSell and factory orders are NOT auto-cancelled).';
    }
  }
  return '[MarketRefine] Op not found: ' + id;
};

global.cancelLastMarketRefine = function() {
  ensureMemory();
  var ops = Memory.marketRefine.ops;
  if (!ops || ops.length === 0) return '[MarketRefine] No ops to cancel.';
  var last = ops[ops.length - 1];
  var id = last && last.id ? last.id : null;
  if (!id) return '[MarketRefine] Last op missing id.';
  return cancelMarketRefine(id);
};

global.abortMarketRefine = function(roomOrId, product) {
  ensureMemory();
  var ops = Memory.marketRefine.ops;
  for (var i = ops.length - 1; i >= 0; i--) {
    var op = ops[i];
    if (!op) continue;
    var match = (product === undefined) ? (op.id === roomOrId)
                                        : (op.room === roomOrId && op.output === product);
    if (!match) continue;
    if (op.phase !== 'buying') {
      return '[MarketRefine] ' + op.id + ' not in buying phase (phase=' + op.phase + '); not aborted.';
    }
    expireOp(op, 'Aborted: no longer profitable (below margin threshold)');
    ops.splice(i, 1);
    return '[MarketRefine] Aborted ' + op.id + ' (cancelled/passivated buys, sold back acquired inputs).';
  }
  return '[MarketRefine] No matching buying op to abort.';
};

global.marketRefineDebugOpBuy = function() {
  return '[marketRefine] opportunisticBuy methods: ' + opBuyMethodsString();
};

global.marketRefineShouldUseMarketBuy = shouldUseMarketBuy;
global.marketRefineComputeBidPrice    = computeCompetitiveBid;

global.marketRefineDebugBuyDecision = function(room, resource, ceiling) {
  var book = pricing.getBook(resource);
  var energyBuyPrice = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);
  var avg = pricing.getAvg48h(resource);
  var value = (typeof avg === 'number' && avg > 0) ? avg : ceiling;
  var useMB = shouldUseMarketBuy(null, resource, ceiling);
  var bid   = computeCompetitiveBid(resource, ceiling);
  var forced = MARKET_BUY_FORCE_LIST[resource] ? ' [FORCED]' : '';
  return '[marketRefine debug] ' + resource +
         ' | energyBuy=' + (typeof energyBuyPrice === 'number' ? energyBuyPrice.toFixed(3) : String(energyBuyPrice)) +
         ' | value='     + (typeof value === 'number' ? value.toFixed(3) : String(value)) +
         ' | bestBid='   + (book.bestBid === null ? 'null' : book.bestBid.toFixed(3)) +
         ' | bestAsk='   + (book.bestAsk === null ? 'null' : book.bestAsk.toFixed(3)) +
         ' | range7d='   + pricing.getRange7d(resource) +
         ' | trend7d='   + pricing.getTrend7d(resource) +
         ' | useMarketBuy=' + useMB + forced +
         ' | bidPrice='  + (typeof bid === 'number' ? bid.toFixed(3) : String(bid));
};

/**
 * View or edit the marketBuy force list.
 *   marketRefineForceList()         -> list current forced resources
 *   marketRefineForceList('add', RESOURCE_X)    -> add resource to force list
 *   marketRefineForceList('remove', RESOURCE_X) -> remove resource from force list
 *   marketRefineForceList('reset')  -> restore defaults (biomass, metal, silicon, mist)
 */
global.marketRefineForceList = function(action, resource) {
  if (!action) {
    var list = [];
    for (var r in MARKET_BUY_FORCE_LIST) {
      if (MARKET_BUY_FORCE_LIST.hasOwnProperty(r) && MARKET_BUY_FORCE_LIST[r]) list.push(r);
    }
    return '[marketRefine forceList] ' + (list.length ? list.join(', ') : '(empty)');
  }
  if (action === 'reset') {
    delete MARKET_BUY_FORCE_LIST[RESOURCE_BIOMASS];
    delete MARKET_BUY_FORCE_LIST[RESOURCE_METAL];
    delete MARKET_BUY_FORCE_LIST[RESOURCE_SILICON];
    delete MARKET_BUY_FORCE_LIST[RESOURCE_MIST];
    MARKET_BUY_FORCE_LIST[RESOURCE_BIOMASS] = true;
    MARKET_BUY_FORCE_LIST[RESOURCE_METAL]   = true;
    MARKET_BUY_FORCE_LIST[RESOURCE_SILICON] = true;
    MARKET_BUY_FORCE_LIST[RESOURCE_MIST]    = true;
    return '[marketRefine forceList] reset to defaults: biomass, metal, silicon, mist';
  }
  if (!resource) return '[marketRefine forceList] Usage: action="add"|"remove"|"reset", resource=RESOURCE_X';
  if (action === 'add') {
    MARKET_BUY_FORCE_LIST[resource] = true;
    return '[marketRefine forceList] added ' + resource;
  }
  if (action === 'remove') {
    delete MARKET_BUY_FORCE_LIST[resource];
    return '[marketRefine forceList] removed ' + resource;
  }
  return '[marketRefine forceList] Unknown action: ' + action + '. Use add|remove|reset';
};

global.cancelAllMarketRefine = function() {
  if (!Memory.marketRefine || !Array.isArray(Memory.marketRefine.ops)) {
    return '[MarketRefine] Nothing to cancel.';
  }
  // Snapshot ids first: abort/cancel splice the live array as they go.
  var ids = Memory.marketRefine.ops.map(function(o) { return o ? o.id : null; });
  var results = [];
  for (var i = 0; i < ids.length; i++) {
    var op = null, phase = null;
    for (var j = 0; j < Memory.marketRefine.ops.length; j++) {
      if (Memory.marketRefine.ops[j] && Memory.marketRefine.ops[j].id === ids[i]) {
        op = Memory.marketRefine.ops[j]; phase = op.phase; break;
      }
    }
    if (!op) continue;
    // Buying phase: abort stops opportunisticBuy + marketBuy and sells back inputs.
    // Other phases: cancel removes the op + its marketBuy orders.
    if (phase === 'buying') results.push(abortMarketRefine(op.id));
    else results.push(cancelMarketRefine(op.id));
  }
  return results.length ? results.join('\n') : '[MarketRefine] No ops cancelled.';
};

// ===== TICK RUNNER =====
function run() {
  ensureMemory();
  getRoomState.init();

  var ops = Memory.marketRefine.ops;
  for (var i = ops.length - 1; i >= 0; i--) {
    var op = ops[i];
    if (!op) { ops.splice(i, 1); continue; }

    op.lastUpdate = Game.time;

    // --- AUTO CLEANUP ---
    // NOTE: outcomes (done/failed) are recorded at the point the phase
    // transition happens (see 'selling' phase and failOp()), BEFORE the op
    // reaches this generic cleanup splice. This block just removes the op
    // from the active list once its outcome has already been logged.
    if (op.phase === 'done' || op.phase === 'error' || op.phase === 'failed') {
        if (op.phase === 'error' && !op._outcomeRecorded) {
            recordOutcome(op, 'failed', op.failReason || 'error');
        }
        ops.splice(i, 1);
        continue;
    }

    if (op.phase === 'buying') {
      var allAcquired = true;

      if (op.inputs && op.inputs.length > 0) {
        for (var k = 0; k < op.inputs.length; k++) {
          var inp = op.inputs[k];
          if (inp.useMarketBuy) ensureMarketBuyOrder(op, inp);
          var acquired = getInputAcquired(op, inp);
          if (acquired < inp.amount) {
            allAcquired = false;
            break;
          }
        }
      } else {
        var have = countInRoom(op.room, op.input);
        var acquired2 = have - (op.baseInputCount || 0);
        if (acquired2 < 0) acquired2 = 0;
        if (acquired2 < op.targetBuy) {
          allAcquired = false;
        }
      }

      if (allAcquired) {
        if (op.inputs && op.inputs.length > 0) {
          for (var c = 0; c < op.inputs.length; c++) {
            var cInp = op.inputs[c];
            if (cInp.useMarketBuy && cInp.marketBuyOrderId) {
              var cRec = marketBuyer.getManagedOrders()[cInp.marketBuyOrderId];
              if (cRec && !cRec.done && !cRec.cancelled) {
                marketBuyer.cancelOrderById(cInp.marketBuyOrderId, 'target acquired');
              }
            }
          }
        }
        op.phase = 'refining';
        continue;
      }

      var age = Game.time - (op.started || 0);
      if (age > OP_EXPIRY_TICKS) {
        expireOp(op);
        ops.splice(i, 1);
        continue;
      }

      continue;
    }

    if (op.phase === 'refining') {
      if (!op.factoryStarted) {
        var ret = startFactoryMax(op.room, op.output);
        var retMsg = typeof ret.message === 'string' ? ret.message : '';

        if (retMsg.indexOf('REFUSED') >= 0 || retMsg.indexOf('Unknown') >= 0 || retMsg.indexOf('unsupported') >= 0) {
          failOp(op, 'Factory refused order', retMsg);

          var sellBackParts = [];
          if (op.inputs && op.inputs.length > 0) {
            for (var sb = 0; sb < op.inputs.length; sb++) {
              var sbInp = op.inputs[sb];
              var sbHave = countInRoom(op.room, sbInp.resource);
              var sbBase = typeof sbInp.baseCount === 'number' ? sbInp.baseCount : 0;
              var sbAcquired = sbHave - sbBase;
              if (sbAcquired > 0) {
                callMarketSell(op.room, sbInp.resource, sbAcquired);
                sellBackParts.push(sbAcquired + ' ' + sbInp.resource);
              }
            }
          }
          if (sellBackParts.length > 0) {
            console.log('[MarketRefine] Selling back inputs for failed op ' + op.id + ': ' + sellBackParts.join(', '));
          }
          continue;
        }

        if (retMsg.indexOf('ERROR') >= 0) {
          failOp(op, 'Factory order error', retMsg);
          continue;
        }

        op.factoryOrderId = ret.orderId || null;
        op.factoryCreated = Game.time;
        op.factoryStarted = true;
        op.outputBaseAtFactoryStart = countInRoom(op.room, op.output);
        op.factoryProgressOut = 0;
        continue;
      }

      var liveOrder = null;
      if (op.factoryOrderId) liveOrder = findFactoryOrderById(op.factoryOrderId);
      if (liveOrder && typeof liveOrder.progressOut === 'number' && liveOrder.progressOut > (op.factoryProgressOut || 0)) {
        op.factoryProgressOut = liveOrder.progressOut;
      }

      var stillPresent = false;
      if (op.factoryOrderId) {
        stillPresent = !!liveOrder;
        if (!stillPresent) {
          var completedOrder = findCompletedFactoryOrderById(op.factoryOrderId);
          if (completedOrder && typeof completedOrder.progressOut === 'number' && completedOrder.progressOut > (op.factoryProgressOut || 0)) {
            op.factoryProgressOut = completedOrder.progressOut;
          }
        }
      }
      else stillPresent = anyFactoryOrderAfter(op.room, op.output, op.factoryCreated || op.started);

      if (!stillPresent) {
        op.phase = 'selling';
      }
      continue;
    }

    if (op.phase === 'selling') {
      var nowOut = countInRoom(op.room, op.output);

      var baseline = (op.outputBaseAtFactoryStart !== null && op.outputBaseAtFactoryStart !== undefined)
        ? op.outputBaseAtFactoryStart
        : op.baseOutputCount;
      var produced = typeof op.factoryProgressOut === 'number' ? op.factoryProgressOut : 0;
      if (produced <= 0 && op.factoryOrderId) {
        var completed = findCompletedFactoryOrderById(op.factoryOrderId);
        if (completed && typeof completed.progressOut === 'number') produced = completed.progressOut;
      }

      if (produced <= 0) {
        var delta = nowOut - baseline;
        failOp(op, 'No output produced', 'Expected ' + op.output + ' in ' + op.room + ' but produced=' + produced + ' delta=' + delta + ' (current=' + nowOut + ', base=' + baseline + ')');
        continue;
      }

      var sellAmount = produced;
      if (sellAmount <= 0) {
        failOp(op, 'No output produced', 'Expected ' + op.output + ' in ' + op.room + ' but produced=' + produced + ' current=' + nowOut + ' base=' + baseline);
        continue;
      }

      callMarketSell(op.room, op.output, sellAmount);
      op.phase = 'done';
      recordOutcome(op, 'done', sellAmount + ' ' + op.output + ' produced and sold');
      continue;
    }
  }
}

module.exports = { run: run };
