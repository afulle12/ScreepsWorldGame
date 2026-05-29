// roleFactoryBot.js
// ============================================================================
// Stationary factory hauler. 48 CARRY / 2 MOVE.
//
// Parks on a precomputed tile adjacent to storage, terminal, AND factory.
// Once parked, never moves again. All operations are 1-tick withdraw/transfer.
//
// State machine:
//   PARK    → walk to parkPos (one-time on spawn)
//   IDLE    → no active order, check every 10 ticks
//   LOAD    → evacuate product + fill inputs for up to BATCH_TARGET batches
//   PRODUCE → call factory.produce() each cooldown, sleep between calls
//
// The bot handles both logistics AND production. It wakes every cooldown
// tick to call produce(), checks input levels, and transitions to LOAD
// when inputs run low.
// ============================================================================

var BATCH_TARGET = 50;
var WAKE_BUFFER  = 2;   // wake when this many batches of inputs remain

// ─── Recipes (must include cooldown for sleep calculation) ────────────────────

var RECIPES = Object.freeze({
  // Compression commodities (cooldown 20)
  [RESOURCE_OXIDANT]:       { inputs: { [RESOURCE_OXYGEN]: 500,    [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_REDUCTANT]:     { inputs: { [RESOURCE_HYDROGEN]: 500,  [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_ZYNTHIUM_BAR]:  { inputs: { [RESOURCE_ZYNTHIUM]: 500,  [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_LEMERGIUM_BAR]: { inputs: { [RESOURCE_LEMERGIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_UTRIUM_BAR]:    { inputs: { [RESOURCE_UTRIUM]: 500,    [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_KEANIUM_BAR]:   { inputs: { [RESOURCE_KEANIUM]: 500,   [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_GHODIUM_MELT]:  { inputs: { [RESOURCE_GHODIUM]: 500,   [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_PURIFIER]:      { inputs: { [RESOURCE_CATALYST]: 500,  [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
  [RESOURCE_BATTERY]:       { inputs: { [RESOURCE_ENERGY]: 600  }, out: 50, cooldown: 10 },

  // Basic regional commodities (cooldown 8)
  [RESOURCE_WIRE]:       { inputs: { [RESOURCE_UTRIUM_BAR]: 20,    [RESOURCE_SILICON]: 100, [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 },
  [RESOURCE_CELL]:       { inputs: { [RESOURCE_LEMERGIUM_BAR]: 20, [RESOURCE_BIOMASS]: 100, [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 },
  [RESOURCE_ALLOY]:      { inputs: { [RESOURCE_ZYNTHIUM_BAR]: 20,  [RESOURCE_METAL]: 100,   [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 },
  [RESOURCE_CONDENSATE]: { inputs: { [RESOURCE_KEANIUM_BAR]: 20,   [RESOURCE_MIST]: 100,    [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 }
});

function getRecipe(product) {
  if (RECIPES[product]) return RECIPES[product];
  if (typeof COMMODITIES !== 'undefined' && COMMODITIES[product]) {
    var c = COMMODITIES[product];
    var inputs = {};
    var components = c.components || {};
    for (var res in components) {
      if (components.hasOwnProperty(res)) inputs[res] = components[res];
    }
    return {
      inputs: inputs,
      out: (typeof c.amount === 'number' && c.amount > 0) ? c.amount : 1,
      cooldown: c.cooldown || 20
    };
  }
  return null;
}

function findFactory(room) {
  return room.find(FIND_MY_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_FACTORY; }
  })[0];
}

// ─── State handlers ──────────────────────────────────────────────────────────

function doPark(creep) {
  var p = creep.memory.parkPos;
  if (!p) {
    console.log('[FactoryBot] ' + creep.name + ': no parkPos, suiciding');
    creep.suicide();
    return;
  }

  if (creep.pos.x === p.x && creep.pos.y === p.y) {
    creep.memory.state = 'idle';
    console.log('[FactoryBot] ' + creep.name + ' parked at (' + p.x + ',' + p.y + ')');
    return;
  }

  creep.moveTo(new RoomPosition(p.x, p.y, creep.memory.homeRoom), {
    range: 0, reusePath: 20, visualizePathStyle: { stroke: '#ffaa00' }
  });
}

function doIdle(creep) {
  // Check infrequently — near-zero CPU when idle
  if (Game.time % 10 !== 0) return;

  var orders = Memory.factoryOrders || [];
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (o && o.room === creep.memory.homeRoom && o.status === 'active') {
      creep.memory.orderId = o.id;
      creep.memory.product = o.product;
      creep.memory.state   = 'load';
      delete creep.memory.targetBatches;
      delete creep.memory.cycleStartProgress;
      return;
    }
  }
}

function doLoad(creep) {
  var room = Game.rooms[creep.memory.homeRoom];
  if (!room) return;

  var factory = findFactory(room);
  if (!factory) return;

  var orders  = Memory.factoryOrders || [];
  var myOrder = null;
  for (var i = 0; i < orders.length; i++) {
    if (orders[i] && orders[i].id === creep.memory.orderId) {
      myOrder = orders[i];
      break;
    }
  }

  var product = creep.memory.product;

  // ── Order gone / done / cancelled → drain factory, go idle ──────────────
  if (!myOrder || myOrder.status === 'done' || myOrder.status === 'cancelled') {
    delete creep.memory.waitingForInputs;
    if (drainAndDump(creep, room, factory)) return;
    creep.memory.state = 'idle';
    delete creep.memory.product;
    delete creep.memory.orderId;
    delete creep.memory.targetBatches;
    delete creep.memory.cycleStartProgress;
    return;
  }

  // ── Not the active FIFO order for this room → wait ──────────────────────
  var firstActive = null;
  for (var j = 0; j < orders.length; j++) {
    var oj = orders[j];
    if (oj && oj.room === myOrder.room && oj.status === 'active') {
      firstActive = oj;
      break;
    }
  }
  if (!firstActive || firstActive.id !== myOrder.id) return;

  var recipe = getRecipe(product);
  if (!recipe) {
    console.log('[FactoryBot] No recipe for ' + product);
    return;
  }

  // ── Calculate target batches for this load cycle (once per cycle) ────────
  if (creep.memory.targetBatches === undefined) {
    var batchesRemaining = Math.ceil(
      Math.max(0, myOrder.requested - (myOrder.progressOut || 0)) / recipe.out
    );
    creep.memory.targetBatches = Math.min(BATCH_TARGET, batchesRemaining);
    creep.memory.cycleStartProgress = myOrder.progressOut || 0;

    if (creep.memory.targetBatches <= 0) {
      // Order is essentially complete — manager will mark done
      delete creep.memory.waitingForInputs;
      if (drainAndDump(creep, room, factory)) return;
      creep.memory.state = 'idle';
      return;
    }
  }

  var targetBatches = creep.memory.targetBatches;
  var freeCapacity  = creep.store.getFreeCapacity();

  // ── P1: Carrying product → dump to storage ──────────────────────────────
  if (product && (creep.store[product] || 0) > 0) {
    delete creep.memory.waitingForInputs;
    if (room.storage && room.storage.store.getFreeCapacity() > 0) {
      creep.transfer(room.storage, product);
    } else if (room.terminal && room.terminal.store.getFreeCapacity() > 0) {
      creep.transfer(room.terminal, product);
    }
    return;
  }

  // ── P2: Factory has product → evacuate it ───────────────────────────────
  if (product && (factory.store[product] || 0) > 0 && freeCapacity > 0) {
    delete creep.memory.waitingForInputs;
    creep.withdraw(factory, product);
    return;
  }

  // ── P3: Carrying a needed input → transfer to factory ───────────────────
  if (creep.store.getUsedCapacity() > 0) {
    delete creep.memory.waitingForInputs;
    for (var res in recipe.inputs) {
      var creepHas = creep.store[res] || 0;
      if (creepHas <= 0) continue;
      var deficit = (recipe.inputs[res] * targetBatches) - (factory.store[res] || 0);
      if (deficit > 0) {
        creep.transfer(factory, res, Math.min(creepHas, deficit));
        return;
      }
    }
    // Carrying something unneeded → dump it
    dumpAll(creep, room);
    return;
  }

  // ── P4: Calculate total input deficit ───────────────────────────────────
  var totalDeficit = 0;
  var bestRes      = null;
  var bestBatches  = Infinity;

  for (var res2 in recipe.inputs) {
    var perBatch = recipe.inputs[res2];
    var need     = perBatch * targetBatches;
    var have     = factory.store[res2] || 0;
    var d        = Math.max(0, need - have);
    totalDeficit += d;

    if (d > 0) {
      var batchesLoaded = Math.floor(have / perBatch);
      if (batchesLoaded < bestBatches) {
        bestBatches = batchesLoaded;
        bestRes     = res2;
      }
    }
  }

  // ── All inputs loaded → start producing ─────────────────────────────────
  if (totalDeficit === 0) {
    delete creep.memory.waitingForInputs;
    creep.memory.state = 'produce';
    creep.memory.wakeUpTick = Game.time;
    delete creep.memory.targetBatches;
    delete creep.memory.cycleStartProgress;
    return;
  }

  // ── Withdraw most-needed input from storage / terminal ──────────────────
  if (bestRes && freeCapacity > 0) {
    var resDeficit  = Math.max(0, (recipe.inputs[bestRes] * targetBatches) - (factory.store[bestRes] || 0));
    var amt         = Math.min(resDeficit, freeCapacity);
    var storageHas  = room.storage  ? (room.storage.store[bestRes]  || 0) : 0;
    var terminalHas = room.terminal ? (room.terminal.store[bestRes] || 0) : 0;

    if (storageHas > 0) {
      delete creep.memory.waitingForInputs;
      creep.withdraw(room.storage, bestRes, Math.min(amt, storageHas));
    } else if (terminalHas > 0) {
      delete creep.memory.waitingForInputs;
      creep.withdraw(room.terminal, bestRes, Math.min(amt, terminalHas));
    } else {
      // No inputs available anywhere — signal factoryManager to auto-complete.
      creep.memory.waitingForInputs = true;
    }
  }
}

function doProduce(creep) {
  // Sleep between cooldowns — near-zero CPU
  if (Game.time < (creep.memory.wakeUpTick || 0)) return;

  var room = Game.rooms[creep.memory.homeRoom];
  if (!room) return;
  var factory = findFactory(room);
  if (!factory) return;

  var product = creep.memory.product;
  var recipe  = getRecipe(product);
  if (!recipe) { creep.memory.state = 'idle'; return; }

  // Check order still exists and is active
  var orders  = Memory.factoryOrders || [];
  var myOrder = null;
  for (var i = 0; i < orders.length; i++) {
    if (orders[i] && orders[i].id === creep.memory.orderId) {
      myOrder = orders[i];
      break;
    }
  }

  if (!myOrder || myOrder.status === 'done' || myOrder.status === 'cancelled') {
    creep.memory.state = 'load'; // load handles drain + idle transition
    delete creep.memory.wakeUpTick;
    return;
  }

  // Call produce when factory cooldown is ready
  if (!factory.cooldown) {
    var res = factory.produce(product);
    if (res === OK) {
      myOrder.batchesQueued  = (myOrder.batchesQueued || 0) + 1;
      myOrder.progressOut    = myOrder.batchesQueued * recipe.out;
      myOrder.lastProduceTick = Game.time;
    }
  }

  // Check if order is now complete
  if ((myOrder.progressOut || 0) >= myOrder.requested) {
    creep.memory.state = 'load'; // load will detect done → drain → idle
    delete creep.memory.wakeUpTick;
    return;
  }

  // Check how many full batches of inputs remain in factory
  var minInputBatches = Infinity;
  for (var r in recipe.inputs) {
    var perBatch = recipe.inputs[r] || 0;
    if (perBatch <= 0) continue;
    var have    = factory.store[r] || 0;
    var batches = Math.floor(have / perBatch);
    if (batches < minInputBatches) minInputBatches = batches;
  }

  // Low on inputs → go to LOAD to evacuate product and reload
  if (minInputBatches <= WAKE_BUFFER) {
    creep.memory.state = 'load';
    delete creep.memory.wakeUpTick;
    delete creep.memory.targetBatches;
    delete creep.memory.cycleStartProgress;
    return;
  }

  // Sleep until next cooldown
  var cooldown = recipe.cooldown || 20;
  creep.memory.wakeUpTick = Game.time + cooldown;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Drain factory of everything, dump carry to storage/terminal.
 * Returns true if there's still work to do (call again next tick).
 */
function drainAndDump(creep, room, factory) {
  if (creep.store.getUsedCapacity() > 0) {
    dumpAll(creep, room);
    return true;
  }
  if (factory) {
    for (var res in factory.store) {
      if ((factory.store[res] || 0) > 0 && creep.store.getFreeCapacity() > 0) {
        creep.withdraw(factory, res);
        return true;
      }
    }
  }
  return false;
}

/** Transfer first resource in carry to storage, falling back to terminal. */
function dumpAll(creep, room) {
  if (!room) room = creep.room;
  for (var res in creep.store) {
    if ((creep.store[res] || 0) <= 0) continue;
    if (room.storage && room.storage.store.getFreeCapacity() > 0) {
      creep.transfer(room.storage, res);
      return;
    }
    if (room.terminal && room.terminal.store.getFreeCapacity() > 0) {
      creep.transfer(room.terminal, res);
      return;
    }
    break; // nowhere to put it
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────────

module.exports = {
  run: function(creep) {
    // TTL guard — dump everything, drain factory, suicide
    if (creep.ticksToLive < 50) {
      var room = Game.rooms[creep.memory.homeRoom] || creep.room;
      var factory = findFactory(room);
      if (drainAndDump(creep, room, factory)) return;
      creep.suicide();
      return;
    }

    switch (creep.memory.state || 'park') {
      case 'park':  doPark(creep);  break;
      case 'idle':  doIdle(creep);  break;
      case 'load':    doLoad(creep);    break;
      case 'produce': doProduce(creep); break;
    }
  }
};