// localRefine.js
// Orchestrates a check-resources -> refine(max) -> sell pipeline.
// Does NOT buy resources. It assumes you already have them.
//
// REQUIRED console API:
//   localRefine('W1N1', 'Zynthium bar', 10000)
//   localRefineStatus()             // list ops
//   localRefineStatus('op_id')      // details
//   cancelLocalRefine('op_id')      // cancel op


var getRoomState = require('getRoomState');
var marketSeller = require('marketSell');

// ===== INTERNAL MEMORY =====
function ensureMemory() {
  if (!Memory.localRefine) Memory.localRefine = { ops: [] };
  else if (!Array.isArray(Memory.localRefine.ops)) Memory.localRefine.ops = [];
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
      // Skip energy for non-battery products (rooms should have energy)
      if (res === RESOURCE_ENERGY && output !== RESOURCE_BATTERY) continue;
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
}

// ===== WRAPPERS FOR EXTERNAL HELPERS =====
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

  var containers = stMap[STRUCTURE_CONTAINER] || [];
  for (var i = 0; i < containers.length; i++) add(containers[i]);

  return total;
}

// ===== FACTORY ORDER TRACKING =====
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

  // For multi-input recipes, verify ALL inputs are present (not just the primary)
  var allInputs = getInputs(output);
  if (allInputs && allInputs.length > 1) {
    var missingInputs = [];
    for (var ci = 0; ci < allInputs.length; ci++) {
      var inp = allInputs[ci];
      var have = countInRoom(roomName, inp.resource);
      if (have <= 0) {
        missingInputs.push(inp.resource + ': 0');
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
  return '[LocalRefine] Started ' + id + ' | Found ' + currentInput + ' ' + primaryInput + ' (Req: ' + requiredAmount + ') -> refine ' + output + ' (max) -> sell.';
};

global.localRefineStatus = function(id) {
  ensureMemory();
  var ops = Memory.localRefine.ops;
  if (!ops || ops.length === 0) return '[LocalRefine] No ops.';

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
    return '[LocalRefine] Op not found: ' + id;
  }

  var lines = [];
  for (var j = 0; j < ops.length; j++) {
    var op = ops[j];
    if (!op) continue;
    var failStr = op.phase === 'failed' ? ' FAILED: ' + (op.failReason || '?') : '';
    lines.push('[' + op.id + '] ' + op.room + ' ' + op.input + ' -> ' + op.output + ' | phase=' + op.phase + failStr);
  }
  return lines.join('\n');
};

global.cancelLocalRefine = function(id) {
  ensureMemory();
  var ops = Memory.localRefine.ops;
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op && op.id === id) {
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
      ops.splice(i, 1);
      continue;
    }

    if (op.phase === 'refining') {
      if (!op.factoryStarted) {
        var ret = startFactoryMax(op.room, op.output);
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

        op.factoryOrderId = ret.orderId || null;
        op.factoryCreated = Game.time;
        op.factoryStarted = true;
        // Snapshot output count at the moment the factory order is placed.
        // Use explicit assignment (not ||) so 0 is preserved as a valid baseline.
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
      op.phase = 'done';
      continue;
    }
  }
}

module.exports = { run: run };