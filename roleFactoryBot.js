// roleFactoryBot.js
// Evacuates finished product to Storage (fallback Terminal -> Container)
// and feeds inputs (mineral + energy) to the Factory. After order completion,
// it drains remaining product from the Factory before suiciding.

const RECIPES = Object.freeze({
  [RESOURCE_OXIDANT]:       { input: RESOURCE_OXYGEN,   inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_REDUCTANT]:     { input: RESOURCE_HYDROGEN, inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_ZYNTHIUM_BAR]:  { input: RESOURCE_ZYNTHIUM, inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_LEMERGIUM_BAR]: { input: RESOURCE_LEMERGIUM,inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_UTRIUM_BAR]:    { input: RESOURCE_UTRIUM,   inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_KEANIUM_BAR]:   { input: RESOURCE_KEANIUM,  inAmt: 500, energy: 200, out: 100 },
  [RESOURCE_PURIFIER]:      { input: RESOURCE_CATALYST, inAmt: 500, energy: 200, out: 100 }
});

function findFactory(room) {
  return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0];
}

function deliverToBest(creep) {
  const room = creep.room;
  const targets = [];
  if (room.storage && room.storage.store.getFreeCapacity() > 0) targets.push(room.storage);
  if (room.terminal && room.terminal.store.getFreeCapacity() > 0) targets.push(room.terminal);
  const containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getFreeCapacity() > 0
  });
  targets.push(...containers);

  const target = targets[0];
  if (!target) return false;

  if (creep.pos.isNearTo(target)) {
    for (const r in creep.store) {
      const amt = creep.store[r] || 0;
      if (amt > 0) creep.transfer(target, r);
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#aaffaa' } });
  }
  return true;
}

function withdrawFromBest(room, creep, resource, amount) {
  const sources = [];
  if (room.storage && (room.storage.store[resource] || 0) > 0) sources.push(room.storage);
  if (room.terminal && (room.terminal.store[resource] || 0) > 0) sources.push(room.terminal);
  const containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && (s.store[resource] || 0) > 0
  });
  sources.push(...containers);

  for (const s of sources) {
    if (creep.pos.isNearTo(s)) {
      const amt = Math.min(amount, s.store[resource] || 0, creep.store.getFreeCapacity());
      if (amt <= 0) continue;
      const res = creep.withdraw(s, resource, amt);
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
  // Fallback: infer from carried goods
  for (const res in RECIPES) {
    if ((creep.store[res] || 0) > 0) return res;
  }
  return null;
}

module.exports = {
  run(creep) {
    const orders = Memory.factoryOrders || [];
    const myOrder = orders.find(o => o && o.id === creep.memory.orderId);
    const room = Game.rooms[creep.memory.homeRoom || creep.room.name];
    const factory = findFactory(room);

    // Determine product we care about (works even after order is removed)
    const product = getTargetProduct(creep, myOrder);

    // Post-completion/cleanup phase: drain product then suicide
    const orderDone = !myOrder || myOrder.status === 'done' || myOrder.status === 'cancelled';
    if (orderDone) {
      // Persist intent
      creep.memory.closing = true;

      // 1) If carrying anything, deliver it first.
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }

      // 2) Then drain remaining product from the Factory.
      if (factory && product && (factory.store[product] || 0) > 0) {
        if (creep.pos.isNearTo(factory)) {
          const amt = Math.min(factory.store[product], creep.store.getFreeCapacity());
          creep.withdraw(factory, product, amt);
        } else {
          creep.moveTo(factory, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
        }
        return;
      }

      // 3) Nothing left to evacuate.
      creep.suicide();
      return;
    }

    // Only operate if this is the active order for the room (FIFO per room).
    const firstActive = orders.find(o => o.room === myOrder.room && o.status === 'active');
    if (!firstActive || firstActive.id !== myOrder.id) {
      const anchor = room.storage || room.terminal || creep;
      if (!creep.pos.inRangeTo(anchor, 3)) creep.moveTo(anchor, { range: 3, reusePath: 20 });
      return;
    }

    if (!factory || !product) return;

    const recipe = RECIPES[product];

    // Evacuate finished product first to keep factory clear
    const productInFactory = factory.store[product] || 0;
    if ((creep.store[product] || 0) > 0) {
      deliverToBest(creep);
      return;
    }
    if (productInFactory > 0 && creep.store.getFreeCapacity() > 0) {
      if (creep.pos.isNearTo(factory)) {
        const amt = Math.min(productInFactory, creep.store.getFreeCapacity());
        creep.withdraw(factory, product, amt);
      } else {
        creep.moveTo(factory, { range: 1, reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
      }
      return;
    }

    // Feed inputs
    const needIn = Math.max(0, recipe.inAmt - (factory.store[recipe.input] || 0));
    const needE  = Math.max(0, recipe.energy - (factory.store[RESOURCE_ENERGY] || 0));

    const carryIn = creep.store[recipe.input] || 0;
    const carryE  = creep.store[RESOURCE_ENERGY] || 0;

    // If carrying inputs/energy, deliver to factory when needed; otherwise return them.
    if (carryIn > 0 || carryE > 0) {
      if (carryIn > 0 && needIn > 0) {
        transferToFactory(creep, factory, recipe.input);
        return;
      }
      if (carryE > 0 && needE > 0) {
        transferToFactory(creep, factory, RESOURCE_ENERGY);
        return;
      }
      // Factory doesn't need what we have anymore
      deliverToBest(creep);
      return;
    }

    // If empty and inputs are needed, fetch whichever is more lacking (by %)
    if (needIn > 0 || needE > 0) {
      const pctIn = recipe.inAmt ? (needIn / recipe.inAmt) : 0;
      const pctE  = recipe.energy ? (needE / recipe.energy) : 0;
      if (pctIn >= pctE && needIn > 0) {
        if (!withdrawFromBest(room, creep, recipe.input, needIn)) {
          withdrawFromBest(room, creep, RESOURCE_ENERGY, needE);
        }
      } else if (needE > 0) {
        if (!withdrawFromBest(room, creep, RESOURCE_ENERGY, needE)) {
          withdrawFromBest(room, creep, recipe.input, needIn);
        }
      }
      return;
    }

    // Stand by near the factory
    if (!creep.pos.inRangeTo(factory, 2)) creep.moveTo(factory, { range: 2, reusePath: 15 });
  }
};
