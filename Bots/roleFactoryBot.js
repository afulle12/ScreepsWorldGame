// roleFactoryBot.js
// Evacuates finished product to Storage (fallback Terminal -> Container)
// and feeds inputs (mineral + energy) to the Factory. After order completion,
// it drains remaining product from the Factory before suiciding.

const RECIPES = Object.freeze({
  // Compressing commodities
  [RESOURCE_OXIDANT]:       { inputs: { [RESOURCE_OXYGEN]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_REDUCTANT]:     { inputs: { [RESOURCE_HYDROGEN]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_ZYNTHIUM_BAR]:  { inputs: { [RESOURCE_ZYNTHIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_LEMERGIUM_BAR]: { inputs: { [RESOURCE_LEMERGIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_UTRIUM_BAR]:    { inputs: { [RESOURCE_UTRIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_KEANIUM_BAR]:   { inputs: { [RESOURCE_KEANIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_GHODIUM_MELT]:  { inputs: { [RESOURCE_GHODIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_PURIFIER]:      { inputs: { [RESOURCE_CATALYST]: 500, [RESOURCE_ENERGY]: 200 }, out: 100 },
  [RESOURCE_BATTERY]:       { inputs: { [RESOURCE_ENERGY]: 600 }, out: 50 },

  // Basic regional commodities
  [RESOURCE_WIRE]:         { inputs: { [RESOURCE_UTRIUM_BAR]: 20,  [RESOURCE_SILICON]: 100, [RESOURCE_ENERGY]: 40 }, out: 20 },
  [RESOURCE_CELL]:         { inputs: { [RESOURCE_LEMERGIUM_BAR]: 20, [RESOURCE_BIOMASS]: 100, [RESOURCE_ENERGY]: 40 }, out: 20 },
  [RESOURCE_ALLOY]:        { inputs: { [RESOURCE_ZYNTHIUM_BAR]: 20, [RESOURCE_METAL]: 100,   [RESOURCE_ENERGY]: 40 }, out: 20 },
  [RESOURCE_CONDENSATE]:   { inputs: { [RESOURCE_KEANIUM_BAR]: 20,  [RESOURCE_MIST]: 100,    [RESOURCE_ENERGY]: 40 }, out: 20 }
});

/**
 * Get recipe for a product. Checks local RECIPES first, then falls back
 * to the game's COMMODITIES constant for higher-level products.
 * Returns a normalized { inputs: { resource: qty }, out: qty } object.
 * @param {string} product - Resource constant
 * @returns {Object|null} - Recipe object or null if unknown
 */
function getRecipe(product) {
  if (RECIPES[product]) return RECIPES[product];
  
  // Fall back to COMMODITIES for products not in our hardcoded table
  if (typeof COMMODITIES !== 'undefined' && COMMODITIES[product]) {
    var commodity = COMMODITIES[product];
    var inputs = {};
    var components = commodity.components || {};
    for (var res in components) {
      if (components.hasOwnProperty(res)) {
        inputs[res] = components[res];
      }
    }
    return {
      inputs: inputs,
      out: (typeof commodity.amount === 'number' && commodity.amount > 0) ? commodity.amount : 1
    };
  }
  
  return null;
}

function findFactory(room) {
  return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0];
}

function deliverToBest(creep) {
  var room = creep.room;
  var targets = [];
  if (room.storage && room.storage.store.getFreeCapacity() > 0) targets.push(room.storage);
  if (room.terminal && room.terminal.store.getFreeCapacity() > 0) targets.push(room.terminal);
  var containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getFreeCapacity() > 0
  });
  for (var i = 0; i < containers.length; i++) targets.push(containers[i]);

  var target = targets[0];
  if (!target) return false;

  if (creep.pos.isNearTo(target)) {
    // One action per tick — transfer a single resource kind each tick.
    for (var r in creep.store) {
      var amt = creep.store[r] || 0;
      if (amt > 0) { creep.transfer(target, r); break; }
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#aaffaa' } });
  }
  return true;
}

function withdrawFromBest(room, creep, resource, amount) {
  var sources = [];
  if (room.storage && (room.storage.store[resource] || 0) > 0) sources.push(room.storage);
  if (room.terminal && (room.terminal.store[resource] || 0) > 0) sources.push(room.terminal);
  var containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && (s.store[resource] || 0) > 0
  });
  for (var i = 0; i < containers.length; i++) sources.push(containers[i]);

  for (var j = 0; j < sources.length; j++) {
    var s = sources[j];
    if (creep.pos.isNearTo(s)) {
      var amt = Math.min(amount, s.store[resource] || 0, creep.store.getFreeCapacity());
      if (amt <= 0) continue;
      var res = creep.withdraw(s, resource, amt);
      if (res === OK) return true;
    } else {
      creep.moveTo(s, { reusePath: 10, range: 1, visualizePathStyle: { stroke: '#99ccff' } });
      return true;
    }
  }
  return false;
}

function transferToFactory(creep, factory, resource) {
  if (creep.pos.isNearTo(factory)) {
    creep.transfer(factory, resource);
  } else {
    creep.moveTo(factory, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
  }
}

function getTargetProduct(creep, myOrder) {
  if (myOrder && myOrder.product) return myOrder.product;
  if (creep.memory.product) return creep.memory.product;
  // Fallback: infer from carried goods (check local RECIPES and COMMODITIES)
  for (var res in RECIPES) {
    if ((creep.store[res] || 0) > 0) return res;
  }
  if (typeof COMMODITIES !== 'undefined') {
    for (var res2 in creep.store) {
      if ((creep.store[res2] || 0) > 0 && COMMODITIES[res2]) return res2;
    }
  }
  return null;
}

function computeInputNeeds(factory, recipe) {
  if (!recipe || !recipe.inputs) return {};
  var needs = {};
  for (var res in recipe.inputs) {
    var req = recipe.inputs[res] || 0;
    var have = (factory && factory.store && factory.store[res]) || 0;
    needs[res] = Math.max(0, req - have);
  }
  return needs;
}

// Helpers to drain any leftover from the factory (not only the target product).
function firstResourceInStore(store) {
  for (var r in store) {
    var amt = store[r];
    if (typeof amt === 'number' && amt > 0) return r;
  }
  return null;
}

function drainFactoryAny(creep, factory) {
  if (!factory) return false;
  var res = firstResourceInStore(factory.store);
  if (!res) return false;

  if (creep.pos.isNearTo(factory)) {
    var amt = Math.min(factory.store[res] || 0, creep.store.getFreeCapacity());
    if (amt > 0) creep.withdraw(factory, res, amt);
  } else {
    creep.moveTo(factory, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
  }
  return true;
}

module.exports = {
  run(creep) {
    var orders = Memory.factoryOrders || [];
    var myOrder = orders.find(function(o){ return o && o.id === creep.memory.orderId; });
    var room = Game.rooms[creep.memory.homeRoom || creep.room.name];
    var factory = findFactory(room);

    // Remember product once per order so we can still clean up if the order entry is removed.
    if (myOrder && myOrder.product && !creep.memory.product) creep.memory.product = myOrder.product;

    // TTL check - evacuate everything and only suicide when both creep and factory are empty
    if (creep.ticksToLive < 50) {
      creep.memory.lowTTL = true;
      creep.memory.closing = true;

      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }

      if (drainFactoryAny(creep, factory)) {
        return;
      }

      creep.suicide();
      return;
    }

    // Determine product we care about (works even after order is removed)
    var product = getTargetProduct(creep, myOrder);

    // Post-completion/cleanup phase: drain everything from the Factory then suicide
    var orderDone = !myOrder || myOrder.status === 'done' || myOrder.status === 'cancelled';
    if (orderDone) {
      creep.memory.closing = true;

      // 1) If carrying anything, deliver it first.
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }

      // 2) Drain any remaining resource from the Factory (not only the target product).
      if (drainFactoryAny(creep, factory)) {
        return;
      }

      // 3) Nothing left to evacuate anywhere; safe to suicide.
      creep.suicide();
      return;
    }

    // Only operate if this is the active order for the room (FIFO per room).
    var firstActive = orders.find(function(o){ return o && o.room === myOrder.room && o.status === 'active'; });
    if (!firstActive || firstActive.id !== myOrder.id) {
      var anchor = room.storage || room.terminal || creep;
      if (!creep.pos.inRangeTo(anchor, 3)) creep.moveTo(anchor, { range: 3, reusePath: 20 });
      return;
    }

    // --- one-time startup drain of any leftovers in the Factory ---
    if (!creep.memory.startupDrainDone) {
      // Deliver anything we are already carrying first
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }

      if (factory) {
        // Prefer to clear the target product first (unblocks produce),
        // otherwise pull any resource that exists.
        var resToPull = null;

        if (product && (factory.store[product] || 0) > 0) {
          resToPull = product;
        } else {
          for (var r in factory.store) {
            if ((factory.store[r] || 0) > 0) { resToPull = r; break; }
          }
        }

        if (resToPull) {
          if (creep.pos.isNearTo(factory)) {
            var amtPull = Math.min(factory.store[resToPull] || 0, creep.store.getFreeCapacity());
            if (amtPull > 0) creep.withdraw(factory, resToPull, amtPull);
          } else {
            creep.moveTo(factory, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
          }
          return; // keep draining until empty, then mark done
        }
      }

      // Nothing left inside; mark startup drain complete
      creep.memory.startupDrainDone = true;
    }
    // --- END startup drain ---

    if (!factory || !product) return;

    var recipe = getRecipe(product);

    // If we still can't find a recipe, log and bail
    if (!recipe) {
      console.log('[factoryBot] No recipe found for product: ' + product + ' in ' + room.name);
      return;
    }

    // Evacuate finished product first to keep factory clear
    var productInFactory = (factory.store && factory.store[product]) || 0;
    if ((creep.store[product] || 0) > 0) {
      deliverToBest(creep);
      return;
    }
    if (productInFactory > 0 && creep.store.getFreeCapacity() > 0) {
      if (creep.pos.isNearTo(factory)) {
        var pull = Math.min(productInFactory, creep.store.getFreeCapacity());
        creep.withdraw(factory, product, pull);
      } else {
        creep.moveTo(factory, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
      }
      return;
    }

    // Feed inputs (multi-input aware)
    var needs = computeInputNeeds(factory, recipe);

    // If carrying inputs, deliver any that are still needed; otherwise return them.
    var carryingSomething = creep.store.getUsedCapacity() > 0;
    if (carryingSomething) {
      // Prefer delivering needed inputs to the factory; if nothing needed, unload.
      for (var resInCarry in creep.store) {
        var carryAmt = creep.store[resInCarry] || 0;
        if (carryAmt <= 0) continue;
        if (recipe.inputs[resInCarry] && (needs[resInCarry] || 0) > 0) {
          transferToFactory(creep, factory, resInCarry);
          return;
        }
      }
      // Nothing the factory needs anymore
      deliverToBest(creep);
      return;
    }

    // If empty and inputs are needed, fetch whichever is most lacking by percentage
    var bestRes = null;
    var bestPct = -1;
    for (var resNeeded in recipe.inputs) {
      var req = recipe.inputs[resNeeded] || 0;
      var need = needs[resNeeded] || 0;
      if (req <= 0 || need <= 0) continue;
      var pct = need / req;
      if (pct > bestPct) { bestPct = pct; bestRes = resNeeded; }
    }

    if (bestRes) {
      // Try to withdraw the most lacking input; if that fails, try another input that is needed.
      if (!withdrawFromBest(room, creep, bestRes, needs[bestRes])) {
        for (var alt in recipe.inputs) {
          if (alt === bestRes) continue;
          if ((needs[alt] || 0) > 0) {
            if (withdrawFromBest(room, creep, alt, needs[alt])) return;
          }
        }
      }
      return;
    }

    // Stand by near the factory
    if (!creep.pos.inRangeTo(factory, 2)) creep.moveTo(factory, { range: 2, reusePath: 15 });
  }
};