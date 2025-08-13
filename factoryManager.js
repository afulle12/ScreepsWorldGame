// factoryManager.js
// FIFO per room factory order manager. Refuses orders unless full resources
// are present in the room. Spawns a hauler to feed the Factory and keeps
// production going. Orders in different rooms run concurrently.

//orderFactory('W1N1', 'Oxidant', 1000);
//orderFactory('W1N1', 'Zynthium bar', 500); // will wait until Oxidant order finishes (FIFO)
//orderFactory('W2N3', 'RESOURCE_UTRIUM_BAR', 200); // runs concurrently in another room


const ROLE_NAME = 'factoryBot';

// Basic “any-level” recipes (500 base + 200 energy -> 100 output, 20 ticks)
const RECIPES = Object.freeze({
  [RESOURCE_OXIDANT]:       { input: RESOURCE_OXYGEN,   inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_REDUCTANT]:     { input: RESOURCE_HYDROGEN, inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_ZYNTHIUM_BAR]:  { input: RESOURCE_ZYNTHIUM, inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_LEMERGIUM_BAR]: { input: RESOURCE_LEMERGIUM,inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_UTRIUM_BAR]:    { input: RESOURCE_UTRIUM,   inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_KEANIUM_BAR]:   { input: RESOURCE_KEANIUM,  inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_PURIFIER]:      { input: RESOURCE_CATALYST, inAmt: 500, energy: 200, out: 100 }
});

function ensureMemory() {
  if (!Memory.factoryOrders) Memory.factoryOrders = [];
}

function findFactory(room) {
  return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0];
}

function roomOwned(room) {
  return room && room.controller && room.controller.my;
}

function countInRoom(room, resourceType) {
  let total = 0;
  const add = s => { if (s && s.store) total += s.store[resourceType] || 0; };
  add(room.storage);
  add(room.terminal);
  const factory = findFactory(room); add(factory);
  const containers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
  for (const c of containers) add(c);
  return total;
}

function normalizeProduct(p) {
  if (p && RECIPES[p]) return p;
  if (typeof p === 'string') {
    const s = p.trim().toUpperCase();
    const map = {
      OXIDANT: RESOURCE_OXIDANT,
      REDUCTANT: RESOURCE_REDUCTANT,
      'ZYNTHIUM BAR': RESOURCE_ZYNTHIUM_BAR, ZYNTHIUM_BAR: RESOURCE_ZYNTHIUM_BAR,
      'LEMERGIUM BAR': RESOURCE_LEMERGIUM_BAR, LEMERGIUM_BAR: RESOURCE_LEMERGIUM_BAR,
      'UTRIUM BAR': RESOURCE_UTRIUM_BAR, UTRIUM_BAR: RESOURCE_UTRIUM_BAR,
      'KEANIUM BAR': RESOURCE_KEANIUM_BAR, KEANIUM_BAR: RESOURCE_KEANIUM_BAR,
      PURIFIER: RESOURCE_PURIFIER
    };
    if (map[s]) return map[s];
    if (global[s]) return global[s];
  }
  return null;
}

function batchesFor(amount, recipe) { return Math.ceil(amount / recipe.out); }

function haulerBody(energyAvail) {
  const pairCost = 100; // CARRY+MOVE
  const pairs = Math.max(3, Math.min(15, Math.floor(energyAvail / pairCost)));
  const body = [];
  for (let i = 0; i < pairs; i++) body.push(CARRY);
  for (let i = 0; i < pairs; i++) body.push(MOVE);
  return body;
}

function spawnFactoryBot(room, orderId) {
  const spawn = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
  if (!spawn) return ERR_BUSY;
  const body = haulerBody(spawn.room.energyAvailable);
  const name = `FactoryBot_${room.name}_${Game.time}`;
  const order = (Memory.factoryOrders || []).find(o => o.id === orderId);
  const memory = {
    role: ROLE_NAME,
    orderId,
    homeRoom: room.name,
    product: order ? order.product : undefined
  };
  return spawn.spawnCreep(body, name, { memory });
}


function enoughForOneBatchInFactory(factory, product) {
  const r = RECIPES[product];
  return (factory.store[r.input] || 0) >= r.inAmt &&
         (factory.store[RESOURCE_ENERGY] || 0) >= r.energy;
}

function tryProduce(factory, order) {
  if (!factory || factory.cooldown) return false;
  if (!enoughForOneBatchInFactory(factory, order.product)) return false;
  const res = factory.produce(order.product);
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
  const byRoom = _.groupBy(Memory.factoryOrders, o => o.room);
  for (const roomName in byRoom) {
    let activated = false;
    for (const order of byRoom[roomName]) {
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
  const existing = _.filter(Game.creeps, c => c.memory.role === ROLE_NAME && (c.memory.homeRoom === roomName));
  return existing.length === 0;
}

function orderSummary(order) {
  return `[#${order.id}] ${order.room} -> ${order.product} | requested: ${order.requested}, queuedOut: ${order.progressOut || 0}, status: ${order.status}`;
}

// Console: place an order (REFUSES unless full resources are present)
global.orderFactory = function(roomName, productLike, amount = 100) {
  ensureMemory();

  const room = Game.rooms[roomName];
  if (!room || !roomOwned(room)) return `[Factory] Invalid or not-owned room: ${roomName}`;

  const factory = findFactory(room);
  if (!factory) return `[Factory] No Factory in ${roomName}. Build one at RCL7.`;

  const product = normalizeProduct(productLike);
  if (!product || !RECIPES[product]) return `[Factory] Unknown or unsupported product: ${productLike}`;

  const recipe = RECIPES[product];
  const batches = batchesFor(amount, recipe);
  const needInput = batches * recipe.inAmt;
  const needEnergy = batches * recipe.energy;

  const haveInput = countInRoom(room, recipe.input);
  const haveEnergy = countInRoom(room, RESOURCE_ENERGY);

  if (haveInput < needInput || haveEnergy < needEnergy) {
    return `[Factory] REFUSED: Need ${needInput} ${recipe.input} + ${needEnergy} energy in ${roomName}. Have ${haveInput}/${haveEnergy}.`;
  }

  const id = `${roomName}_${product}_${Game.time}`;
  const order = {
    id, room: roomName, product, requested: amount,
    status: 'queued', created: Game.time,
    batchesQueued: 0, progressOut: 0, lastProduceTick: 0
  };
  Memory.factoryOrders.push(order);

  // Set active if first in queue for this room
  markActivePerRoom();

  // Spawn a hauler immediately if this room's order is active and no bot exists
  const isActive = Memory.factoryOrders.find(o => o.room === roomName && o.status === 'active' && o.id === id);
  if (isActive && needBotForRoom(roomName)) spawnFactoryBot(room, id);

  return `[Factory] Order accepted. ${orderSummary(order)}`;
};

global.cancelFactoryOrder = function(idOrRoom, productLike = null) {
  ensureMemory();
  if (!Memory.factoryOrders.length) return `[Factory] No orders.`;
  let removed = 0;

  if (productLike) {
    const product = normalizeProduct(productLike);
    Memory.factoryOrders = Memory.factoryOrders.filter(o => {
      const match = (o.id === idOrRoom || o.room === idOrRoom) && o.product === product;
      if (match) removed++;
      return !match;
    });
  } else {
    Memory.factoryOrders = Memory.factoryOrders.filter(o => {
      const match = (o.id === idOrRoom || o.room === idOrRoom);
      if (match) removed++;
      return !match;
    });
  }

  markActivePerRoom();
  return removed ? `[Factory] Cancelled ${removed} order(s).` : `[Factory] No matching orders.`;
};

global.factoryOrders = function() {
  ensureMemory();
  if (!Memory.factoryOrders.length) return `[Factory] No active orders.`;
  return Memory.factoryOrders.map(orderSummary).join('\n');
};

// Tick
function run() {
  ensureMemory();
  markActivePerRoom();

  // Process per-room active orders
  const activeByRoom = _.groupBy(Memory.factoryOrders.filter(o => o.status === 'active'), o => o.room);

  for (const roomName in activeByRoom) {
    const room = Game.rooms[roomName];
    if (!room || !roomOwned(room)) continue;
    const factory = findFactory(room);
    if (!factory) continue;

    const order = activeByRoom[roomName][0]; // FIFO: first active for this room
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
  const before = Memory.factoryOrders.length;
  Memory.factoryOrders = Memory.factoryOrders.filter(o => o.status !== 'done' && o.status !== 'cancelled');
  if (Memory.factoryOrders.length !== before) {
    markActivePerRoom();
  }
}

module.exports = { run, RECIPES };
