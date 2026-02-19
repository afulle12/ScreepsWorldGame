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
//   cancelMarketRefine('op_id')     // cancel orchestration record
//   cancelLastMarketRefine()        // cancel the most recent op (helper)
//   marketRefineDebugOpBuy()        // print detected opportunisticBuy methods (console)
//
// Constraints per user instructions:
// - Use getRoomState for room reads.
// - Use opportunisticBuy for purchasing.
// - Use marketPrice to set price ceiling (parses numeric value).
// - Wait for buy before refining; call orderFactory(..., 'max'); wait; then sell newly produced output via marketSell.
// - No optional chaining.
//
// SPECIAL CASE: Battery production uses marketSell (instead of opportunisticBuy) to acquire
// energy, since marketSell is currently the only mechanism suitable for buying energy.

var getRoomState = require('getRoomState');

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
  if (!Memory.marketRefine) Memory.marketRefine = { ops: [] };
  else if (!Array.isArray(Memory.marketRefine.ops)) Memory.marketRefine.ops = [];
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
    ESSENCE: RESOURCE_ESSENCE
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

// Default buy amount for simple single-input products
var DEFAULT_BUY_AMOUNT = 50000;

// Buy amount multiplier for multi-input recipes (how many batches to buy for)
var RECIPE_BATCH_MULTIPLIER = 100;

/**
 * Check if a specific input for a product should be acquired via marketSell
 * instead of opportunisticBuy. Currently only energy for battery production
 * qualifies, since marketSell is only suitable for buying energy.
 * @param {string} output - The product being produced
 * @param {string} inputResource - The input resource being acquired
 * @returns {boolean} - True if marketSell should be used for this input
 */
function shouldUseMarketSell(output, inputResource) {
    return output === RESOURCE_BATTERY && inputResource === RESOURCE_ENERGY;
}

/**
 * Check if a specific input for a product should be acquired via marketBuy
 * instead of opportunisticBuy. Currently only biomass for cell production
 * qualifies, since marketBuy creates a standing buy order which is better
 * suited for acquiring deposit resources like biomass.
 * @param {string} output - The product being produced
 * @param {string} inputResource - The input resource being acquired
 * @returns {boolean} - True if marketBuy should be used for this input
 */
function shouldUseMarketBuy(output, inputResource) {
    return output === RESOURCE_CELL && inputResource === RESOURCE_BIOMASS;
}

/**
 * Get the recipe inputs for a product.
 * Returns an array of {resource, amount} for purchasable inputs (excludes energy
 * UNLESS the product is battery, since energy IS the input for batteries).
 * Returns null if the product is not recognized.
 */
function getRecipeInputs(output, batchMultiplier) {
    // First check COMMODITIES for multi-input recipes
    if (COMMODITIES && COMMODITIES[output]) {
        var recipe = COMMODITIES[output];
        var comps = recipe.components || {};
        var inputs = [];
        for (var res in comps) {
            if (!comps.hasOwnProperty(res)) continue;
            // Skip energy for non-battery products - rooms should have this or get it normally
            // For batteries, energy IS the primary input and must be purchased
            if (res === RESOURCE_ENERGY && output !== RESOURCE_BATTERY) continue;
            var amount = comps[res] * (batchMultiplier || RECIPE_BATCH_MULTIPLIER);
            inputs.push({ resource: res, amount: amount });
        }
        if (inputs.length > 0) return inputs;
    }

    // Fallback to legacy single-input map
    if (OUTPUT_TO_INPUT[output]) {
        return [{ resource: OUTPUT_TO_INPUT[output], amount: DEFAULT_BUY_AMOUNT }];
    }

    return null;
}

// ===== WRAPPERS FOR EXTERNAL HELPERS =====
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
  var out = getMarketPriceStr(resourceType, 'avg');
  if (out == null) out = getMarketPriceStr(resourceType, undefined);
  if (typeof out === 'number' && out > 0) return out;
  var n = parseAvgPrice(out);
  if (typeof n !== 'number' || !(n > 0)) n = parseFirstNumber(out);
  if (typeof n === 'number' && n > 0) return n;
  return 1;
}

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

// Helper to check if an opportunisticBuy request exists for a room+resource
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

function callMarketBuy(roomName, resourceType, amount, maxPrice) {
  var mb = global.marketBuy;
  if (!mb) {
    try { var mbm = require('marketBuyer'); mb = mbm && mbm.marketBuy ? mbm.marketBuy.bind(mbm) : null; } catch (e) { mb = null; }
  }
  if (!mb) return '[MarketRefine] ERROR: marketBuy not available.';
  try {
    if (typeof mb === 'function') return mb(roomName, resourceType, amount, maxPrice);
  } catch (e) {
    return '[MarketRefine] ERROR invoking marketBuy: ' + e;
  }
  return '[MarketRefine] ERROR: Unknown marketBuy API.';
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

function anyFactoryOrderAfter(roomName, product, createdTick) {
  var list = (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) ? Memory.factoryOrders : [];
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    if (o && o.room === roomName && o.product === product && typeof o.created === 'number' && o.created >= createdTick) return true;
  }
  return false;
}

// ===== CONSOLE API =====

/**
 * Start a marketRefine operation.
 * @param {string} roomName - Room to refine in
 * @param {string} outputLike - Product to produce (resource constant or name)
 * @param {Object} [maxPrices] - Optional map of {resourceType: maxPrice} for inputs
 */
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

  // Get recipe inputs for this product
  var recipeInputs = getRecipeInputs(output);
  if (!recipeInputs || recipeInputs.length === 0) {
    return '[MarketRefine] Unsupported output: ' + outputLike + '. Must be a valid COMMODITIES product or compressed resource.';
  }

  // Check for existing active buy requests for any of the inputs
  // (skip inputs that will use marketSell or marketBuy instead of opportunisticBuy)
  for (var c = 0; c < recipeInputs.length; c++) {
    if (!shouldUseMarketSell(output, recipeInputs[c].resource) && !shouldUseMarketBuy(output, recipeInputs[c].resource) && hasActiveOpBuyRequest(roomName, recipeInputs[c].resource)) {
      return '[MarketRefine] ERROR: Active opportunisticBuy request already exists for ' + recipeInputs[c].resource + ' in ' + roomName + '. Cancel it first or wait for completion.';
    }
  }

  // Build input tracking array with prices
  var inputs = [];
  var buyMsgs = [];
  for (var i = 0; i < recipeInputs.length; i++) {
    var inp = recipeInputs[i];
    var useMS = shouldUseMarketSell(output, inp.resource);
    var useMB = shouldUseMarketBuy(output, inp.resource);
    var ceiling;
    if (maxPrices && typeof maxPrices[inp.resource] === 'number') {
      ceiling = maxPrices[inp.resource];
    } else {
      ceiling = computeCeiling(inp.resource);
    }

    var baseCount = countInRoom(roomName, inp.resource);

    inputs.push({
      resource: inp.resource,
      amount: inp.amount,
      maxPrice: ceiling,
      baseCount: baseCount,
      useMarketSell: useMS,
      useMarketBuy: useMB
    });

    // Enqueue buy for this input via the appropriate mechanism
    var buyMsg;
    if (useMS) {
      // Use marketSell for energy acquisition (currently only suitable for energy)
      buyMsg = callMarketSell(roomName, inp.resource, inp.amount);
      buyMsgs.push(inp.resource + ' x' + inp.amount + ' (via marketSell)');
    } else if (useMB) {
      // Use marketBuy for biomass acquisition (creates a standing buy order)
      buyMsg = callMarketBuy(roomName, inp.resource, inp.amount, ceiling);
      buyMsgs.push(inp.resource + ' x' + inp.amount + ' @' + ceiling.toFixed(3) + ' (via marketBuy)');
    } else {
      buyMsg = invokeOpportunisticBuy(roomName, inp.resource, inp.amount, ceiling);
      buyMsgs.push(inp.resource + ' x' + inp.amount + ' @' + ceiling.toFixed(3));
    }
  }

  var baseOutput = countInRoom(roomName, output);

  var id = 'mref_' + roomName + '_' + output + '_' + Game.time;
  var op = {
    id: id,
    room: roomName,
    output: output,
    inputs: inputs,
    // Legacy fields for backward compat with status display
    input: inputs.length === 1 ? inputs[0].resource : '(multi)',
    targetBuy: inputs.length === 1 ? inputs[0].amount : 0,
    price: inputs.length === 1 ? inputs[0].maxPrice : 0,
    baseOutputCount: baseOutput,
    phase: 'buying',
    started: Game.time,
    lastUpdate: Game.time,
    buyRequestCreated: true
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
        if (o.inputs && o.inputs.length > 0) {
          for (var k = 0; k < o.inputs.length; k++) {
            var inp = o.inputs[k];
            var have = countInRoom(o.room, inp.resource);
            var acquired = have - (inp.baseCount || 0);
            if (acquired < 0) acquired = 0;
            var viaStr = inp.useMarketSell ? ' (via marketSell)' : (inp.useMarketBuy ? ' (via marketBuy)' : '');
            s.push('  input: ' + inp.resource + ' target=' + inp.amount + ' price=' + inp.maxPrice + ' acquired=' + acquired + ' current=' + have + viaStr);
          }
        } else {
          // Legacy single-input format
          s.push('  input: ' + o.input + ' target=' + o.targetBuy + ' price=' + o.price);
          s.push('  baseInput=' + (o.baseInputCount || 0) + ' currentInput=' + countInRoom(o.room, o.input));
        }
        s.push('  output: ' + o.output + (o.factoryOrderId ? (' orderId=' + o.factoryOrderId) : ''));
        s.push('  baseOutput=' + o.baseOutputCount + ' currentOutput=' + countInRoom(o.room, o.output));
        return s.join('\n');
      }
    }
    return '[MarketRefine] Op not found: ' + id;
  }

  var lines = [];
  for (var j = 0; j < ops.length; j++) {
    var op = ops[j];
    if (!op) continue;
    if (op.inputs && op.inputs.length > 0) {
      var inputNames = [];
      for (var m = 0; m < op.inputs.length; m++) {
        inputNames.push(op.inputs[m].resource);
      }
      lines.push('[' + op.id + '] ' + op.room + ' ' + inputNames.join('+') + ' -> ' + op.output + ' | phase=' + op.phase);
    } else {
      lines.push('[' + op.id + '] ' + op.room + ' ' + op.input + ' -> ' + op.output + ' | phase=' + op.phase);
    }
  }
  return lines.join('\n');
};

global.cancelMarketRefine = function(id) {
  ensureMemory();
  var ops = Memory.marketRefine.ops;
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op && op.id === id) {
      ops.splice(i, 1);
      return '[MarketRefine] Cancelled op ' + id + '. Note: external market/factory orders are not auto-cancelled.';
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

// Helper to inspect the opportunisticBuy API from console
global.marketRefineDebugOpBuy = function() {
  return '[marketRefine] opportunisticBuy methods: ' + opBuyMethodsString();
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
    if (op.phase === 'done' || op.phase === 'error') {
        ops.splice(i, 1);
        continue;
    }

    if (op.phase === 'buying') {
      // Check if all inputs have been acquired
      var allAcquired = true;

      if (op.inputs && op.inputs.length > 0) {
        // Multi-input path
        for (var k = 0; k < op.inputs.length; k++) {
          var inp = op.inputs[k];
          var have = countInRoom(op.room, inp.resource);
          var acquired = have - (inp.baseCount || 0);
          if (acquired < 0) acquired = 0;
          if (acquired < inp.amount) {
            allAcquired = false;
            break;
          }
        }
      } else {
        // Legacy single-input path
        var have = countInRoom(op.room, op.input);
        var acquired = have - (op.baseInputCount || 0);
        if (acquired < 0) acquired = 0;
        if (acquired < op.targetBuy) {
          allAcquired = false;
        }
      }

      if (allAcquired) {
        op.phase = 'refining';
      }
      continue;
    }

    if (op.phase === 'refining') {
      if (!op.factoryStarted) {
        var ret = startFactoryMax(op.room, op.output);
        if (typeof ret.message === 'string' && ret.message.indexOf('REFUSED') >= 0) {
          op.phase = 'error';
          op.error = 'factory refused';
          continue;
        }
        op.factoryOrderId = ret.orderId || null;
        op.factoryCreated = Game.time;
        op.factoryStarted = true;
        op.outputBaseAtFactoryStart = countInRoom(op.room, op.output);
        continue;
      }

      var stillPresent = false;
      if (op.factoryOrderId) stillPresent = !!findFactoryOrderById(op.factoryOrderId);
      else stillPresent = anyFactoryOrderAfter(op.room, op.output, op.factoryCreated || op.started);

      if (!stillPresent) {
        op.phase = 'selling';
      }
      continue;
    }

    if (op.phase === 'selling') {
      var nowOut = countInRoom(op.room, op.output);
      var delta = nowOut - (op.outputBaseAtFactoryStart || op.baseOutputCount || 0);
      if (delta <= 0) {
        op.phase = 'done';
        continue;
      }

      var msg = callMarketSell(op.room, op.output, delta);
      op.phase = 'done';
      continue;
    }
  }
}

module.exports = { run: run };