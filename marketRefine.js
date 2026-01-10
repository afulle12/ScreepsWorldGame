// marketRefine.js
// Orchestrates a buy(50k) -> refine(max) -> sell pipeline for simple bar/melt/purifier/oxidant/reductant.
// REQUIRED console API (two params):
//   marketRefine('W1N1', 'Zynthium bar')
//   marketRefine('W1N1', RESOURCE_ZYNTHIUM_BAR)
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
// - Fixed purchase: 50,000 units.
// - Wait for buy before refining; call orderFactory(..., 'max'); wait; then sell newly produced output via marketSell.
// - No optional chaining.

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
    PURIFIER: RESOURCE_PURIFIER
    //BATTERY: RESOURCE_BATTERY
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
// Battery: input is ENERGY
//OUTPUT_TO_INPUT[RESOURCE_BATTERY]        = RESOURCE_ENERGY;

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
global.marketRefine = function(roomName, outputLike) {
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
  if (!output || !OUTPUT_TO_INPUT[output]) {
    return '[MarketRefine] Unsupported output: ' + outputLike + '. Allowed: Oxidant, Reductant, Purifier, Zynthium bar, Lemergium bar, Utrium bar, Keanium bar, Ghodium melt.';
  }

  var inputRes = OUTPUT_TO_INPUT[output];
  var buyAmount = 50000;
  var ceiling = computeCeiling(inputRes);

  // Check if there's already an active request for this room+resource
  if (hasActiveOpBuyRequest(roomName, inputRes)) {
    return '[MarketRefine] ERROR: Active opportunisticBuy request already exists for ' + inputRes + ' in ' + roomName + '. Cancel it first or wait for completion.';
  }

  var baseInput = countInRoom(roomName, inputRes);
  var baseOutput = countInRoom(roomName, output);

  var id = 'mref_' + roomName + '_' + output + '_' + Game.time;
  var op = {
    id: id,
    room: roomName,
    input: inputRes,
    output: output,
    targetBuy: buyAmount,
    price: ceiling,
    baseInputCount: baseInput,
    baseOutputCount: baseOutput,
    phase: 'buying',
    started: Game.time,
    lastUpdate: Game.time,
    buyRequestCreated: false
  };

  // Enqueue buy (first and only attempt)
  var buyMsg = invokeOpportunisticBuy(roomName, inputRes, buyAmount, ceiling);
  op.buyRequestCreated = true;

  Memory.marketRefine.ops.push(op);
  return '[MarketRefine] Started ' + id + ' | buy ' + buyAmount + ' ' + inputRes + ' @ ' + ceiling + ' -> refine ' + output + ' (max) -> sell.';
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
        s.push('  input: ' + o.input + ' target=' + o.targetBuy + ' price=' + o.price);
        s.push('  output: ' + o.output + (o.factoryOrderId ? (' orderId=' + o.factoryOrderId) : ''));
        s.push('  baseInput=' + o.baseInputCount + ' currentInput=' + countInRoom(o.room, o.input));
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
    lines.push('[' + op.id + '] ' + op.room + ' ' + op.input + ' -> ' + op.output + ' | phase=' + op.phase);
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

  // Do not call opportunisticBuy.process() here; not all implementations provide it.

  var ops = Memory.marketRefine.ops;
  for (var i = ops.length - 1; i >= 0; i--) {
    var op = ops[i];
    if (!op) { ops.splice(i, 1); continue; }

    op.lastUpdate = Game.time;

    // --- AUTO CLEANUP ---
    // If op was marked done/error in a previous tick, remove it now.
    if (op.phase === 'done' || op.phase === 'error') {
        ops.splice(i, 1);
        continue;
    }

    if (op.phase === 'buying') {
      // OpportunisticBuy module handles purchasing elsewhere; we just observe completion.
      var have = countInRoom(op.room, op.input);
      var acquired = have - (op.baseInputCount || 0);
      if (acquired < 0) acquired = 0;
      if (acquired >= op.targetBuy) {
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