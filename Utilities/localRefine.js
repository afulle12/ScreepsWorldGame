// localRefine.js
// Orchestrates a check-resources -> refine(max) -> sell pipeline.
// Does NOT buy resources. It assumes you already have them.
//
// REQUIRED console API:
//   localRefine('W1N1', 'Zynthium bar', 10000)
//      -> Checks if W1N1 has 10k Zynthium.
//      -> Orders factory to produce 'max' Zynthium bar.
//      -> Waits for factory order to finish.
//      -> Sells the resulting Zynthium bars.
//
//   localRefine('W1N1', 'Zynthium bar', 'max')
//      -> Uses ALL available Zynthium in the room.
//
// Helpers:
//   localRefineStatus()             // list ops
//   localRefineStatus('op_id')      // details
//   cancelLocalRefine('op_id')      // cancel op
//
// Constraints:
// - Use getRoomState for room reads.
// - Call orderFactory(..., 'max').
// - Sell via marketSell.
// - No optional chaining.

var getRoomState = require('getRoomState');

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

function callMarketSell(roomName, resourceType, amount) {
  var ms = global.marketSell;
  if (!ms) {
    try { ms = require('marketSell'); } catch (e) { ms = null; }
  }
  if (!ms) return '[LocalRefine] ERROR: marketSell not available.';
  try {
    if (typeof ms.sell === 'function') return ms.sell(roomName, resourceType, amount);
    if (typeof ms.run === 'function')  return ms.run(roomName, resourceType, amount);
    if (typeof ms === 'function')      return ms(roomName, resourceType, amount);
  } catch (e) {
    return '[LocalRefine] ERROR invoking marketSell: ' + e;
  }
  return '[LocalRefine] ERROR: Unknown marketSell API.';
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
  if (!output || !OUTPUT_TO_INPUT[output]) {
    return '[LocalRefine] Unsupported output: ' + outputLike + '. Allowed: Oxidant, Reductant, Purifier, Zynthium bar, Lemergium bar, Utrium bar, Keanium bar, Ghodium melt, Battery.';
  }

  var inputRes = OUTPUT_TO_INPUT[output];
  var currentInput = countInRoom(roomName, inputRes);

  var requiredAmount;
  if (amount === 'max' || amount === 'MAX') {
    requiredAmount = currentInput;
  } else {
    requiredAmount = typeof amount === 'number' ? amount : 0;
  }

  if (requiredAmount <= 0) {
    return '[LocalRefine] ERROR: Must provide a positive AMOUNT, or "max". Found ' + currentInput + ' ' + inputRes + ' in room.';
  }

  if (currentInput < requiredAmount) {
    return '[LocalRefine] ERROR: Not enough ' + inputRes + ' in ' + roomName + '. Found: ' + currentInput + ', Needed: ' + requiredAmount;
  }

  var baseOutput = countInRoom(roomName, output);

  var id = 'lref_' + roomName + '_' + output + '_' + Game.time;
  var op = {
    id: id,
    room: roomName,
    input: inputRes,
    output: output,
    requiredAmount: requiredAmount,
    baseInputCount: currentInput,
    baseOutputCount: baseOutput,
    phase: 'refining', // Direct to refining
    started: Game.time,
    lastUpdate: Game.time,
    factoryStarted: false,
    factoryOrderId: null
  };

  Memory.localRefine.ops.push(op);
  return '[LocalRefine] Started ' + id + ' | Found ' + currentInput + ' ' + inputRes + ' (Req: ' + requiredAmount + ') -> refine ' + output + ' (max) -> sell.';
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
        s.push('  baseOutput=' + o.baseOutputCount + ' currentOutput=' + countInRoom(o.room, o.output));
        return s.join('\n');
      }
    }
    return '[LocalRefine] Op not found: ' + id;
  }

  var lines = [];
  for (var j = 0; j < ops.length; j++) {
    var op = ops[j];
    if (!op) continue;
    lines.push('[' + op.id + '] ' + op.room + ' ' + op.input + ' -> ' + op.output + ' | phase=' + op.phase);
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
    if (op.phase === 'done' || op.phase === 'error') {
        ops.splice(i, 1);
        continue;
    }

    if (op.phase === 'refining') {
      if (!op.factoryStarted) {
        var ret = startFactoryMax(op.room, op.output);
        if (typeof ret.message === 'string' && ret.message.indexOf('REFUSED') >= 0) {
          op.phase = 'error';
          console.log('[LocalRefine] Factory Refused: ' + ret.message);
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
      
      // If we didn't make anything (delta <= 0), just finish.
      if (delta <= 0) {
        op.phase = 'done';
        continue;
      }

      var msg = callMarketSell(op.room, op.output, delta);
      // We assume sell initiated successfully or failed gracefully
      op.phase = 'done';
      continue;
    }
  }
}

module.exports = { run: run };