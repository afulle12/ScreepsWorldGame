// LLM: Read llmcontext.js before reviewing or changing this file.
// localRefine.js
// Orchestrates a check-resources -> refine(exact complete batches) -> sell pipeline.
// Does NOT buy resources. It assumes you already have them.
//
// REQUIRED console API:
//   localRefine('W1N1', 'Zynthium bar', 10000)
//   localRefineStatus()             // list ops
//   localRefineStatus('op_id')      // details
//   cancelLocalRefine('op_id')      // cancel op


var getRoomState = require('getRoomState');
var marketSeller = require('marketSell');
var memoryManager = require('memoryManager');

var OUTCOMES_HISTORY_CAP = 25;
var SELL_MAX_ATTEMPTS = 3;
var SELL_RETRY_TICKS = 10;

// ===== INTERNAL MEMORY =====
function ensureMemory() {
  if (!Memory.localRefine) Memory.localRefine = { ops: [], outcomes: {} };
  else if (!Array.isArray(Memory.localRefine.ops)) Memory.localRefine.ops = [];
  if (!Memory.localRefine.outcomes || Array.isArray(Memory.localRefine.outcomes)) Memory.localRefine.outcomes = {};
}

function recordOutcome(op, status, reason) {
  ensureMemory();
  Memory.localRefine.outcomes[op.id] = {
    id: op.id,
    room: op.room,
    output: op.output,
    status: status,
    reason: reason || null,
    started: op.started,
    tick: Game.time
  };
  var ids = Object.keys(Memory.localRefine.outcomes);
  if (ids.length > OUTCOMES_HISTORY_CAP) {
    ids.sort(function(a, b) {
      return (Memory.localRefine.outcomes[a].tick || 0) - (Memory.localRefine.outcomes[b].tick || 0);
    });
    while (ids.length > OUTCOMES_HISTORY_CAP) delete Memory.localRefine.outcomes[ids.shift()];
  }
  op._outcomeRecorded = true;
  memoryManager.requestSave();
}

// ===== OUTPUT -> INPUT MAP =====
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
    BATTERY: RESOURCE_BATTERY
  };
  if (map[s]) return map[s];
  if (global[s]) return global[s];
  return p;
}

// Legacy single-input map (used as primary lookup for simple products)
var OUTPUT_TO_INPUT = {};
OUTPUT_TO_INPUT[RESOURCE_OXIDANT]        = RESOURCE_OXYGEN;
OUTPUT_TO_INPUT[RESOURCE_REDUCTANT]      = RESOURCE_HYDROGEN;
OUTPUT_TO_INPUT[RESOURCE_PURIFIER]       = RESOURCE_CATALYST;
OUTPUT_TO_INPUT[RESOURCE_ZYNTHIUM_BAR]   = RESOURCE_ZYNTHIUM;
OUTPUT_TO_INPUT[RESOURCE_LEMERGIUM_BAR]  = RESOURCE_LEMERGIUM;
OUTPUT_TO_INPUT[RESOURCE_UTRIUM_BAR]     = RESOURCE_UTRIUM;
OUTPUT_TO_INPUT[RESOURCE_KEANIUM_BAR]    = RESOURCE_KEANIUM;
OUTPUT_TO_INPUT[RESOURCE_GHODIUM_MELT]   = RESOURCE_GHODIUM;
OUTPUT_TO_INPUT[RESOURCE_BATTERY]        = RESOURCE_ENERGY;

/**
 * Get the primary input resource for a product.
 * Checks the legacy OUTPUT_TO_INPUT map first, then falls back to COMMODITIES.
 * For multi-input recipes from COMMODITIES, returns the first non-energy input
 * (energy is assumed to be available locally). If the only input IS energy
 * (battery), returns energy.
 *
 * @param {string} output - Resource constant for the product
 * @returns {string|null} - Input resource constant, or null if not recognized
 */
function getPrimaryInput(output) {
  if (OUTPUT_TO_INPUT[output]) return OUTPUT_TO_INPUT[output];

  // Fallback to COMMODITIES
  if (typeof COMMODITIES !== 'undefined' && COMMODITIES[output]) {
    var comps = COMMODITIES[output].components || {};
    var firstNonEnergy = null;
    for (var res in comps) {
      if (!comps.hasOwnProperty(res)) continue;
      if (res === RESOURCE_ENERGY) continue;
      if (!firstNonEnergy) firstNonEnergy = res;
    }
    // If all inputs are energy (e.g. battery), return energy
    return firstNonEnergy || RESOURCE_ENERGY;
  }

  return null;
}

/**
 * Get all non-energy inputs for a product from COMMODITIES.
 * Returns an array of {resource, ratio} where ratio is the amount per batch.
 * For simple products in OUTPUT_TO_INPUT, returns a single entry.
 * For battery (only input is energy), returns energy.
 *
 * @param {string} output - Resource constant for the product
 * @returns {Array|null} - Array of {resource, ratio} or null if not recognized
 */
function getInputs(output) {
  // Check COMMODITIES first for multi-input recipes
  if (typeof COMMODITIES !== 'undefined' && COMMODITIES[output]) {
    var recipe = COMMODITIES[output];
    var comps = recipe.components || {};
    var inputs = [];
    for (var res in comps) {
      if (!comps.hasOwnProperty(res)) continue;
      inputs.push({ resource: res, ratio: comps[res] || 0 });
    }
    if (inputs.length > 0) return inputs;
  }

  // Fallback to legacy map
  if (OUTPUT_TO_INPUT[output]) {
    return [{ resource: OUTPUT_TO_INPUT[output], ratio: 0 }];
  }

  return null;
}

/**
 * Check if a product is supported for localRefine.
 * @param {string} output - Resource constant
 * @returns {boolean}
 */
function isSupported(output) {
  if (OUTPUT_TO_INPUT[output]) return true;
  if (typeof COMMODITIES !== 'undefined' && COMMODITIES[output]) return true;
  return false;
}

// ===== FAILURE NOTIFICATION =====

/**
 * Log a failure, send a Game.notify, and mark the op as failed.
 * @param {Object} op - The localRefine operation
 * @param {string} reason - Human-readable failure reason
 * @param {string} [detail] - Optional additional detail for the log
 */
function failOp(op, reason, detail) {
  var msg = '[LocalRefine] FAILED: ' + op.id + ' (' + op.output + ' in ' + op.room + ') - ' + reason;
  if (detail) msg += ' | ' + detail;
  console.log(msg);
  Game.notify(msg, 30);
  op.phase = 'failed';
  op.failReason = reason;
  op.failTick = Game.time;
  if (!op._outcomeRecorded) recordOutcome(op, 'failed', detail ? reason + ': ' + detail : reason);
}

// ===== WRAPPERS FOR EXTERNAL HELPERS =====
function callOrderFactory(roomName, productType, outputAmount) {
  if (typeof orderFactory === 'function') {
    return orderFactory(roomName, productType, outputAmount);
  }
  try {
    var fm = require('factoryManager');
    if (fm && typeof fm.orderFactory === 'function') {
      return fm.orderFactory(roomName, productType, outputAmount);
    }
  } catch (e) {}
  return '[LocalRefine] ERROR: orderFactory not available.';
}

// marketSell.js exports the marketSeller object; call marketSeller.marketSell() directly.
function callMarketSell(roomName, resourceType, amount) {
  if (!marketSeller || typeof marketSeller.marketSell !== 'function') {
    return '[LocalRefine] ERROR: marketSell module not available or missing .marketSell().';
  }
  try {
    return marketSeller.marketSell(roomName, resourceType, amount);
  } catch (e) {
    return '[LocalRefine] ERROR invoking marketSell: ' + e;
  }
}

// ===== ROOM HELPERS =====
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

  return total;
}

// ===== FACTORY ORDER TRACKING =====
function startFactoryOrder(roomName, outputResource, outputAmount) {
  var msg = callOrderFactory(roomName, outputResource, outputAmount);
  var id = null;
  if (typeof msg === 'string') {
    var m = msg.match(/\[#([^\]]+)\]/);
    if (m && m[1]) id = m[1];
  }
  return { message: msg, orderId: id };
}

function marketSellAccepted(msg) {
  return typeof msg === 'string' &&
    (msg.indexOf('Created SELL order') >= 0 || msg.indexOf('extended existing') >= 0);
}

function productionPlan(output, primaryInput, primaryAmount) {
  if (typeof COMMODITIES === 'undefined' || !COMMODITIES[output]) return null;
  var recipe = COMMODITIES[output];
  var perBatch = recipe.components && recipe.components[primaryInput];
  var outPerBatch = recipe.amount || 1;
  if (!(perBatch > 0) || !(outPerBatch > 0)) return null;
  var batches = Math.floor(primaryAmount / perBatch);
  if (batches <= 0) return null;
  return { batches: batches, outputAmount: batches * outPerBatch };
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
global.localRefine = function(roomName, outputLike, amount) {
  ensureMemory();
  getRoomState.init();

  if (typeof roomName !== 'string' || !roomName) {
    return '[LocalRefine] Provide a valid room name.';
  }
  if (!roomOwned(roomName)) {
    return '[LocalRefine] Room not owned or not visible: ' + roomName;
  }
  if (!roomHasTerminal(roomName)) {
    return '[LocalRefine] Room ' + roomName + ' has no terminal.';
  }

  var output = normalizeOutput(outputLike);
  if (!output || !isSupported(output)) {
    return '[LocalRefine] Unsupported output: ' + outputLike + '. Must be a valid COMMODITIES product or compressed resource.';
  }

  var primaryInput = getPrimaryInput(output);
  if (!primaryInput) {
    return '[LocalRefine] Cannot determine input resource for: ' + outputLike;
  }

  var currentInput = countInRoom(roomName, primaryInput);

  var requiredAmount;
  if (amount === 'max' || amount === 'MAX') {
    requiredAmount = currentInput;
  } else {
    requiredAmount = typeof amount === 'number' ? amount : 0;
  }

  if (requiredAmount <= 0) {
    return '[LocalRefine] ERROR: Must provide a positive AMOUNT, or "max". Found ' + currentInput + ' ' + primaryInput + ' in room.';
  }

  if (currentInput < requiredAmount) {
    return '[LocalRefine] ERROR: Not enough ' + primaryInput + ' in ' + roomName + '. Found: ' + currentInput + ', Needed: ' + requiredAmount;
  }

  var plan = productionPlan(output, primaryInput, requiredAmount);
  if (!plan) {
    return '[LocalRefine] ERROR: ' + requiredAmount + ' ' + primaryInput + ' is not enough for one complete ' + output + ' batch.';
  }

  // Verify every recipe input for the exact complete-batch target.
  var allInputs = getInputs(output);
  if (allInputs) {
    var missingInputs = [];
    for (var ci = 0; ci < allInputs.length; ci++) {
      var inp = allInputs[ci];
      var have = countInRoom(roomName, inp.resource);
      var need = inp.ratio * plan.batches;
      if (have < need) {
        missingInputs.push(inp.resource + ': ' + have + '/' + need);
      }
    }
    if (missingInputs.length > 0) {
      return '[LocalRefine] ERROR: Missing inputs in ' + roomName + ': ' + missingInputs.join(', ');
    }
  }

  var baseOutput = countInRoom(roomName, output);

  var id = 'lref_' + roomName + '_' + output + '_' + Game.time;
  var op = {
    id: id,
    room: roomName,
    input: primaryInput,
    output: output,
    requiredAmount: requiredAmount,
    targetBatches: plan.batches,
    targetOutput: plan.outputAmount,
    baseInputCount: currentInput,
    baseOutputCount: baseOutput,
    phase: 'refining',
    started: Game.time,
    lastUpdate: Game.time,
    factoryStarted: false,
    factoryOrderId: null,
    // outputBaseAtFactoryStart is set later when the factory order is placed.
    // Kept null here so the selling phase can distinguish "not set yet" from 0.
    outputBaseAtFactoryStart: null
  };

  Memory.localRefine.ops.push(op);
  memoryManager.requestSave();
  return '[LocalRefine] Started ' + id + ' | Found ' + currentInput + ' ' + primaryInput + ' (Req: ' + requiredAmount + ') -> refine ' + plan.outputAmount + ' ' + output + ' (' + plan.batches + ' batches) -> sell.';
};

global.localRefineStatus = function(id) {
  ensureMemory();
  var ops = Memory.localRefine.ops;
  var hasOutcomes = Object.keys(Memory.localRefine.outcomes).length > 0;
  if ((!ops || ops.length === 0) && !hasOutcomes) return '[LocalRefine] No ops.';

  if (id) {
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (o && o.id === id) {
        var s = [];
        s.push('[' + o.id + '] room=' + o.room + ' phase=' + o.phase);
        s.push('  output: ' + o.output + (o.factoryOrderId ? (' orderId=' + o.factoryOrderId) : ''));
        s.push('  reqInput=' + o.requiredAmount + ' currentInput=' + countInRoom(o.room, o.input));
        s.push('  baseOutput=' + o.baseOutputCount + ' outputBaseAtFactoryStart=' + o.outputBaseAtFactoryStart + ' currentOutput=' + countInRoom(o.room, o.output));
        if (o.failReason) {
          s.push('  FAILURE: ' + o.failReason + ' (tick ' + (o.failTick || '?') + ')');
        }
        return s.join('\n');
      }
    }
    var outcome = Memory.localRefine.outcomes[id];
    if (outcome) return '[' + outcome.id + '] room=' + outcome.room + ' status=' + outcome.status + '\n  output: ' + outcome.output + '\n  reason: ' + (outcome.reason || '(none)') + ' (tick ' + outcome.tick + ')';
    return '[LocalRefine] Op not found: ' + id;
  }

  var lines = [];
  for (var j = 0; j < ops.length; j++) {
    var op = ops[j];
    if (!op) continue;
    var failStr = op.phase === 'failed' ? ' FAILED: ' + (op.failReason || '?') : '';
    lines.push('[' + op.id + '] ' + op.room + ' ' + op.input + ' -> ' + op.output + ' | phase=' + op.phase + failStr);
  }
  var outcomes = Memory.localRefine.outcomes;
  var outcomeIds = Object.keys(outcomes).sort(function(a, b) { return (outcomes[a].tick || 0) - (outcomes[b].tick || 0); });
  for (var k = 0; k < outcomeIds.length; k++) {
    var result = outcomes[outcomeIds[k]];
    lines.push('[' + result.id + '] ' + result.room + ' -> ' + result.output + ' | status=' + result.status + (result.reason ? ' reason=' + result.reason : ''));
  }
  return lines.join('\n');
};

global.cancelLocalRefine = function(id) {
  ensureMemory();
  var ops = Memory.localRefine.ops;
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op && op.id === id) {
      recordOutcome(op, 'cancelled', 'Cancelled by console command');
      ops.splice(i, 1);
      return '[LocalRefine] Cancelled op ' + id;
    }
  }
  return '[LocalRefine] Op not found: ' + id;
};

// ===== TICK RUNNER =====
function run() {
  ensureMemory();
  getRoomState.init();

  var ops = Memory.localRefine.ops;
  for (var i = ops.length - 1; i >= 0; i--) {
    var op = ops[i];
    if (!op) { ops.splice(i, 1); continue; }

    op.lastUpdate = Game.time;

    // --- AUTO CLEANUP ---
    if (op.phase === 'done' || op.phase === 'error' || op.phase === 'failed') {
      if (!op._outcomeRecorded) {
        recordOutcome(op, op.phase === 'done' ? 'done' : 'failed', op.failReason || op.phase);
      }
      ops.splice(i, 1);
      continue;
    }

    if (op.phase === 'refining') {
      if (!op.factoryStarted) {
        if (!(op.targetOutput > 0)) {
          var legacyPlan = productionPlan(op.output, op.input, op.requiredAmount);
          if (!legacyPlan) {
            failOp(op, 'Cannot determine exact factory target', 'Legacy operation has no complete-batch target');
            continue;
          }
          op.targetBatches = legacyPlan.batches;
          op.targetOutput = legacyPlan.outputAmount;
        }
        var ret = startFactoryOrder(op.room, op.output, op.targetOutput);
        var retMsg = typeof ret.message === 'string' ? ret.message : '';

        // Check for factory refusal
        if (retMsg.indexOf('REFUSED') >= 0 || retMsg.indexOf('Unknown') >= 0 || retMsg.indexOf('unsupported') >= 0) {
          failOp(op, 'Factory refused order', retMsg);
          continue;
        }

        // Check for other errors (module not available, etc.)
        if (retMsg.indexOf('ERROR') >= 0) {
          failOp(op, 'Factory order error', retMsg);
          continue;
        }
        if (retMsg.indexOf('Order accepted') < 0) {
          failOp(op, 'Factory order was not accepted', retMsg || 'Empty factory response');
          continue;
        }

        op.factoryOrderId = ret.orderId || null;
        op.factoryCreated = Game.time;
        op.factoryStarted = true;
        // Snapshot output count at the moment the factory order is placed.
        // Use explicit assignment (not ||) so 0 is preserved as a valid baseline.
        op.outputBaseAtFactoryStart = countInRoom(op.room, op.output);
        memoryManager.requestSave();
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
      if (op.nextSellTick && Game.time < op.nextSellTick) continue;
      var nowOut = countInRoom(op.room, op.output);

      // Use outputBaseAtFactoryStart when available (explicit null check, NOT ||).
      // Falls back to baseOutputCount only if outputBaseAtFactoryStart was never set.
      var baseline = (op.outputBaseAtFactoryStart !== null && op.outputBaseAtFactoryStart !== undefined)
        ? op.outputBaseAtFactoryStart
        : op.baseOutputCount;

      var delta = nowOut - baseline;

      console.log('[LocalRefine] Selling ' + op.output + ' in ' + op.room
        + ' | baseline=' + baseline
        + ' nowOut=' + nowOut
        + ' delta=' + delta);

      if (delta <= 0) {
        failOp(op, 'No output produced', 'Expected ' + op.output + ' in ' + op.room + ' but delta=' + delta + ' (current=' + nowOut + ', baseline=' + baseline + ')');
        continue;
      }

      var msg = callMarketSell(op.room, op.output, delta);
      console.log('[LocalRefine] marketSell result: ' + msg);
      if (marketSellAccepted(msg)) {
        op.phase = 'done';
        recordOutcome(op, 'done', delta + ' ' + op.output + ' sell request accepted');
      } else {
        op.sellAttempts = (op.sellAttempts || 0) + 1;
        if (op.sellAttempts >= SELL_MAX_ATTEMPTS) {
          failOp(op, 'marketSell refused output', '' + msg);
        } else {
          op.nextSellTick = Game.time + SELL_RETRY_TICKS;
          memoryManager.requestSave();
        }
      }
      continue;
    }
  }
}

module.exports = { run: run };
