// factoryManager.js
// FIFO per room factory order manager. Refuses orders unless full resources
// are present in the room. Spawns a hauler to feed the Factory and keeps
// production going. Orders in different rooms run concurrently.
//
// Added: common higher commodities recipes (Composite, Crystal, Liquid)
// with factory level requirements. Recipes support multi-input via `inputs`
// map. Energy is expressed as RESOURCE_ENERGY. `out` is the product units
// per batch. Optional `level` and `cooldown` fields are informational, with
// `level` enforced at order time.

//orderFactory('W1N1', 'Oxidant', 1000);
//orderFactory('W1N1', 'Zynthium bar', 500); // will wait until Oxidant order finishes (FIFO)
//orderFactory('W2N3', 'RESOURCE_UTRIUM_BAR', 200); // runs concurrently in another room
//orderFactory('W1N1', 'Oxidant', 'max'); // computes the maximum producible amount from room resources
//    Show all factory orders: listFactoryOrders()
//    Show orders for a specific room: listFactoryOrders('W1N1')

const getRoomState = require('getRoomState');

const ROLE_NAME = 'factoryBot';

// Recipes (includes any-level and higher-tier with level requirements)
const RECIPES = Object.freeze({
  // Compressing commodities (20 ticks)
  [RESOURCE_OXIDANT]:       { inputs: { [RESOURCE_OXYGEN]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_REDUCTANT]:     { inputs: { [RESOURCE_HYDROGEN]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_ZYNTHIUM_BAR]:  { inputs: { [RESOURCE_ZYNTHIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_LEMERGIUM_BAR]: { inputs: { [RESOURCE_LEMERGIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_UTRIUM_BAR]:    { inputs: { [RESOURCE_UTRIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_KEANIUM_BAR]:   { inputs: { [RESOURCE_KEANIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_GHODIUM_MELT]:  { inputs: { [RESOURCE_GHODIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_PURIFIER]:      { inputs: { [RESOURCE_CATALYST]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_BATTERY]:       { inputs: { [RESOURCE_ENERGY]: 600 }, out: 50 }, // 10 ticks

  // Basic regional commodities (8 ticks)
  [RESOURCE_WIRE]:         { inputs: { [RESOURCE_UTRIUM_BAR]: 20,  [RESOURCE_SILICON]: 100, [RESOURCE_ENERGY]: 40 }, out: 20 },
  [RESOURCE_CELL]:         { inputs: { [RESOURCE_LEMERGIUM_BAR]: 20, [RESOURCE_BIOMASS]: 100, [RESOURCE_ENERGY]: 40 }, out: 20 },
  [RESOURCE_ALLOY]:        { inputs: { [RESOURCE_ZYNTHIUM_BAR]: 20, [RESOURCE_METAL]: 100,   [RESOURCE_ENERGY]: 40 }, out: 20 },
  [RESOURCE_CONDENSATE]:   { inputs: { [RESOURCE_KEANIUM_BAR]: 20,  [RESOURCE_MIST]: 100,    [RESOURCE_ENERGY]: 40 }, out: 20 },

  // Common higher commodities
  // Factory Lvl 1: Composite × 20 (50 ticks)
  [RESOURCE_COMPOSITE]: { level: 1, inputs: { [RESOURCE_UTRIUM_BAR]: 20, [RESOURCE_ZYNTHIUM_BAR]: 20, [RESOURCE_ENERGY]: 20 }, out: 20, cooldown: 50 },
  // Factory Lvl 2: Crystal × 6 (21 ticks)
  [RESOURCE_CRYSTAL]:   { level: 2, inputs: { [RESOURCE_LEMERGIUM_BAR]: 6, [RESOURCE_KEANIUM_BAR]: 6, [RESOURCE_PURIFIER]: 6, [RESOURCE_ENERGY]: 45 }, out: 6, cooldown: 21 },
  // Factory Lvl 3: Liquid × 12 (60 ticks)
  [RESOURCE_LIQUID]:    { level: 3, inputs: { [RESOURCE_OXIDANT]: 12, [RESOURCE_REDUCTANT]: 12, [RESOURCE_GHODIUM_MELT]: 12, [RESOURCE_ENERGY]: 90 }, out: 12, cooldown: 60 }
});

function ensureMemory() {
  if (!Memory.factoryOrders) Memory.factoryOrders = [];
}

function findFactory(room) {
  var state = getRoomState.get(room.name);
  if (!state) return undefined;
  var list = (state.structuresByType && state.structuresByType[STRUCTURE_FACTORY]) || [];
  return list.length ? list[0] : undefined;
}

function roomOwned(room) {
  var state = getRoomState.get(room.name);
  return !!(state && state.controller && state.controller.my);
}

function countInRoom(room, resourceType) {
  var state = getRoomState.get(room.name);
  if (!state) return 0;

  var total = 0;
  function add(s) { if (s && s.store) total += s.store[resourceType] || 0; }

  add(state.storage);
  add(state.terminal);

  var factory = findFactory(room);
  add(factory);

  var containers = (state.structuresByType && state.structuresByType[STRUCTURE_CONTAINER]) || [];
  for (var i = 0; i < containers.length; i++) add(containers[i]);

  return total;
}

function normalizeProduct(p) {
  if (p && RECIPES[p]) return p;
  if (typeof p === 'string') {
    var s = p.trim().toUpperCase();
    var map = {
      OXIDANT: RESOURCE_OXIDANT,
      REDUCTANT: RESOURCE_REDUCTANT,
      'ZYNTHIUM BAR': RESOURCE_ZYNTHIUM_BAR, ZYNTHIUM_BAR: RESOURCE_ZYNTHIUM_BAR,
      'LEMERGIUM BAR': RESOURCE_LEMERGIUM_BAR, LEMERGIUM_BAR: RESOURCE_LEMERGIUM_BAR,
      'UTRIUM BAR': RESOURCE_UTRIUM_BAR, UTRIUM_BAR: RESOURCE_UTRIUM_BAR,
      'KEANIUM BAR': RESOURCE_KEANIUM_BAR, KEANIUM_BAR: RESOURCE_KEANIUM_BAR,
      'GHODIUM MELT': RESOURCE_GHODIUM_MELT, GHODIUM_MELT: RESOURCE_GHODIUM_MELT,
      PURIFIER: RESOURCE_PURIFIER,
      BATTERY: RESOURCE_BATTERY,
      WIRE: RESOURCE_WIRE,
      CELL: RESOURCE_CELL,
      ALLOY: RESOURCE_ALLOY,
      CONDENSATE: RESOURCE_CONDENSATE,
      COMPOSITE: RESOURCE_COMPOSITE,
      CRYSTAL: RESOURCE_CRYSTAL,
      LIQUID: RESOURCE_LIQUID
    };
    if (map[s]) return map[s];
    if (global[s]) return global[s];
  }
  return null;
}

function batchesFor(amount, recipe) { return Math.ceil(amount / recipe.out); }

function haulerBody(energyAvail) {
  var pairCost = 100; // CARRY+MOVE
  var pairs = Math.max(3, Math.min(10, Math.floor(energyAvail / pairCost)));
  var body = [];
  for (var i = 0; i < pairs; i++) body.push(CARRY);
  for (var j = 0; j < pairs; j++) body.push(MOVE);
  return body;
}

function spawnFactoryBot(room, orderId) {
  var state = getRoomState.get(room.name);
  var spawns = (state && state.structuresByType && state.structuresByType[STRUCTURE_SPAWN]) || [];
  var spawn;
  for (var i = 0; i < spawns.length; i++) {
    var s = spawns[i];
    if (s.my && !s.spawning) { spawn = s; break; }
  }
  if (!spawn) return ERR_BUSY;

  var body = haulerBody(spawn.room.energyAvailable);
  var name = 'FactoryBot_' + room.name + '_' + Game.time;
  var order = (Memory.factoryOrders || []).find(function(o){ return o.id === orderId; });
  var memory = {
    role: ROLE_NAME,
    orderId: orderId,
    homeRoom: room.name,
    product: order ? order.product : undefined
  };
  return spawn.spawnCreep(body, name, { memory: memory });
}

function enoughForOneBatchInFactory(factory, product) {
  var rec = RECIPES[product];
  if (!rec) return false;
  if (rec.level && (factory.level || 0) < rec.level) return false;
  for (var res in rec.inputs) {
    var need = rec.inputs[res] || 0;
    var have = (factory.store && factory.store[res]) || 0;
    if (have < need) return false;
  }
  return true;
}

function tryProduce(factory, order) {
  if (!factory || factory.cooldown) return false;
  if (!enoughForOneBatchInFactory(factory, order.product)) return false;
  var res = factory.produce(order.product);
  if (res === OK) {
    order.batchesQueued = (order.batchesQueued || 0) + 1;
    order.progressOut = (order.batchesQueued * RECIPES[order.product].out);
    order.lastProduceTick = Game.time;
    return true;
  }
  return false;
}

function markActivePerRoom() {
  // For each room, ensure the earliest non-done order is 'active', others 'queued'
  var byRoom = _.groupBy(Memory.factoryOrders, function(o){ return o.room; });
  for (var roomName in byRoom) {
    var activated = false;
    var list = byRoom[roomName];
    for (var i = 0; i < list.length; i++) {
      var order = list[i];
      if (order.status === 'done' || order.status === 'cancelled') continue;
      if (!activated) {
        if (order.status !== 'active') order.status = 'active';
        activated = true;
      } else {
        if (order.status !== 'queued') order.status = 'queued';
      }
    }
  }
}

function needBotForRoom(roomName) {
  // One hauler per room (since only one active order runs per room)
  var existing = _.filter(Game.creeps, function(c){ return c.memory.role === ROLE_NAME && (c.memory.homeRoom === roomName); });
  return existing.length === 0;
}

function orderSummary(order) {
  return '[#' + order.id + '] ' + order.room + ' -> ' + order.product + ' | requested: ' + order.requested + ', queuedOut: ' + (order.progressOut || 0) + ', status: ' + order.status;
}

// Compute the maximum number of batches possible in a room for a given recipe
function maxBatchesForRoom(room, recipe) {
  var minBatches = Infinity;
  for (var res in recipe.inputs) {
    var perBatch = recipe.inputs[res] || 0;
    if (perBatch <= 0) continue;
    var have = countInRoom(room, res);
    var possible = Math.floor(have / perBatch);
    if (possible < minBatches) minBatches = possible;
  }
  if (minBatches === Infinity) return 0;
  return minBatches;
}

function maxAmountForRoom(room, recipe) {
  var batches = maxBatchesForRoom(room, recipe);
  return batches * recipe.out;
}

// Console: place an order (REFUSES unless full resources are present)
// Supports amount = 'max' to compute the maximum producible amount from room resources.
global.orderFactory = function(roomName, productLike, amount) {
  ensureMemory();
  if (amount === undefined) amount = 100;

  var room = Game.rooms[roomName];
  if (!room || !roomOwned(room)) return '[Factory] Invalid or not-owned room: ' + roomName;

  var factory = findFactory(room);
  if (!factory) return '[Factory] No Factory in ' + roomName + '. Build one at RCL7.';
  var product = normalizeProduct(productLike);
  if (!product || !RECIPES[product]) return '[Factory] Unknown or unsupported product: ' + productLike;

  var recipe = RECIPES[product];

  // Enforce factory level requirement (if any)
  if (recipe.level && (factory.level || 0) < recipe.level) {
    return '[Factory] REFUSED: Factory level ' + (factory.level || 0) + ' in ' + roomName + ' is insufficient for ' + product + ' (requires level ' + recipe.level + ').';
  }

  // Determine batches and amount
  var batches;
  var isMax = (typeof amount === 'string') && (amount.trim().toLowerCase() === 'max');
  if (isMax) {
    // Only full batches count for 'max'
    batches = maxBatchesForRoom(room, recipe);
    if (batches <= 0) {
      return '[Factory] REFUSED: Not enough inputs in ' + roomName + ' for one batch of ' + product;
    }
    amount = batches * recipe.out; // derive amount from full batches
  } else {
    batches = batchesFor(amount, recipe); // ceil for user-specified amount is correct
  }

  // Build need map per resource based on batches
  var needMap = {};
  for (var res in recipe.inputs) {
    needMap[res] = (recipe.inputs[res] || 0) * batches;
  }

  // Verify we have everything in-room
  var missing = [];
  for (var r in needMap) {
    var have = countInRoom(room, r);
    var need = needMap[r];
    if (have < need) {
      missing.push(r + ' ' + have + '/' + need);
    }
  }

  if (missing.length > 0) {
    return '[Factory] REFUSED: Missing inputs in ' + roomName + ' -> ' + missing.join(', ');
  }

  var id = roomName + '_' + product + '_' + Game.time;
  var order = {
    id: id, room: roomName, product: product, requested: amount,
    status: 'queued', created: Game.time,
    batchesQueued: 0, progressOut: 0, lastProduceTick: 0
  };
  Memory.factoryOrders.push(order);

  // Set active if first in queue for this room
  markActivePerRoom();

  // Spawn a hauler immediately if this room's order is active and no bot exists
  var isActive = Memory.factoryOrders.find(function(o){ return o.room === roomName && o.status === 'active' && o.id === id; });
  if (isActive && needBotForRoom(roomName)) spawnFactoryBot(room, id);

  return '[Factory] Order accepted. ' + orderSummary(order);
};

global.cancelFactoryOrder = function(idOrRoom, productLike) {
  ensureMemory();
  if (!Memory.factoryOrders.length) return '[Factory] No orders.';
  var removed = 0;

  if (productLike) {
    var product = normalizeProduct(productLike);
    Memory.factoryOrders = Memory.factoryOrders.filter(function(o){
      var match = (o.id === idOrRoom || o.room === idOrRoom) && o.product === product;
      if (match) removed++;
      return !match;
    });
  } else {
    Memory.factoryOrders = Memory.factoryOrders.filter(function(o){
      var match = (o.id === idOrRoom || o.room === idOrRoom);
      if (match) removed++;
      return !match;
    });
  }

  markActivePerRoom();
  return removed ? '[Factory] Cancelled ' + removed + ' order(s).' : '[Factory] No matching orders.';
};

// Backward-compatible listing; now supports optional roomName and delegates to listFactoryOrders
global.factoryOrders = function(roomName) {
  return global.listFactoryOrders(roomName);
};

// Console helper: list orders globally or for a specific room (matches documented usage)
global.listFactoryOrders = function(roomName) {
  ensureMemory();
  var list = Memory.factoryOrders;
  if (!list.length) return '[Factory] No active orders.';
  if (roomName) {
    list = list.filter(function(o){ return o.room === roomName; });
    if (!list.length) return '[Factory] No active orders in ' + roomName + '.';
  }
  return list.map(orderSummary).join('\n');
};

// Tick
function run() {
  ensureMemory();
  getRoomState.init();
  markActivePerRoom();

  // Process per-room active orders
  var activeByRoom = _.groupBy(Memory.factoryOrders.filter(function(o){ return o.status === 'active'; }), function(o){ return o.room; });

  for (var roomName in activeByRoom) {
    var room = Game.rooms[roomName];
    if (!room || !roomOwned(room)) continue;

    var factory = findFactory(room);
    if (!factory) continue;

    var order = activeByRoom[roomName][0]; // FIFO: first active for this room
    // Maintain one hauler
    if (needBotForRoom(roomName)) spawnFactoryBot(room, order.id);

    // Try to start batches as soon as possible
    tryProduce(factory, order);

    // Finish when queued output meets request (we count batches started)
    if ((order.progressOut || 0) >= order.requested) {
      order.status = 'done';
    }
  }

  // Cleanup done orders and let next queued become active
  var before = Memory.factoryOrders.length;
  Memory.factoryOrders = Memory.factoryOrders.filter(function(o){ return o.status !== 'done' && o.status !== 'cancelled'; });
  if (Memory.factoryOrders.length !== before) {
    markActivePerRoom();
  }
}

module.exports = { run: run, RECIPES: RECIPES };
