// roleNukeFill.js
// Purpose: Spawn a supplier-bodied creep that fills the room's Nuker:
//          1) Fill 100% energy first
//          2) Then fill GHODIUM
// Console: nukeFill('W1N1', { maxPrice: 1.2 })  // maxPrice optional
// Notes:
// - Uses getRoomState for scanning (no room.find)
// - Uses opportunisticBuy to request GHODIUM if the room is short
// - No optional chaining
//
// Screeps API reference for Nuker and resource handling (capacities, transactions)【2】【1】

const getRoomState = require('getRoomState');
const opportunisticBuy = require('opportunisticBuy');

// Memory bucket:
// Memory.nukeFillOrders = {
//   [roomName]: {
//     roomName,
//     nukerId,
//     energyTarget,
//     ghodiumTarget,
//     phase: 'energy' | 'ghodium' | 'done',
//     createdAt,
//     maxPrice,          // for opportunistic buy
//     buyRequested,      // true once a buy request is created
//     completed          // set true when done
//   }
// }

if (!Memory.nukeFillOrders) Memory.nukeFillOrders = {};

function getNukerFromState(rs, preferId) {
  var nuker = null;

  if (preferId) {
    nuker = Game.getObjectById(preferId);
    if (nuker) return nuker;
  }

  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_NUKER]) {
    var arr = rs.structuresByType[STRUCTURE_NUKER];
    if (arr && arr.length > 0) nuker = arr[0];
  }
  return nuker;
}

function getNukerCaps(nuker) {
  // Support both modern store and legacy props
  var energyCap = 0;
  var ghodiumCap = 0;

  if (nuker && nuker.store && typeof nuker.store.getCapacity === 'function') {
    var ec = nuker.store.getCapacity(RESOURCE_ENERGY);
    var gc = nuker.store.getCapacity(RESOURCE_GHODIUM);
    energyCap = typeof ec === 'number' ? ec : 0;
    ghodiumCap = typeof gc === 'number' ? gc : 0;
  } else {
    // legacy
    energyCap = nuker && typeof nuker.energyCapacity === 'number' ? nuker.energyCapacity : 0;
    ghodiumCap = nuker && typeof nuker.ghodiumCapacity === 'number' ? nuker.ghodiumCapacity : 0;
  }
  return { energy: energyCap, ghodium: ghodiumCap };
}

function getNukerAmounts(nuker) {
  var energy = 0;
  var ghodium = 0;

  if (nuker && nuker.store) {
    energy = nuker.store[RESOURCE_ENERGY] || 0;
    ghodium = nuker.store[RESOURCE_GHODIUM] || 0;
  } else {
    energy = nuker && typeof nuker.energy === 'number' ? nuker.energy : 0;
    ghodium = nuker && typeof nuker.ghodium === 'number' ? nuker.ghodium : 0;
  }
  return { energy: energy, ghodium: ghodium };
}

function sumRoomResource(rs, resourceType, excludeId) {
  if (!rs) return 0;

  var total = 0;
  var types = [
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_FACTORY,
    STRUCTURE_CONTAINER,
    STRUCTURE_LAB,
    STRUCTURE_NUKER
  ];

  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var list = (rs.structuresByType && rs.structuresByType[t]) ? rs.structuresByType[t] : [];
    for (var j = 0; j < list.length; j++) {
      var s = list[j];
      if (!s || (excludeId && s.id === excludeId)) continue;
      if (s.store && typeof s.store.getUsedCapacity === 'function') {
        total += s.store.getUsedCapacity(resourceType) || 0;
      }
    }
  }
  return total;
}

function pickWithdrawTarget(rs, resourceType) {
  if (!rs) return null;

  var term = rs.terminal;
  if (term && term.store && (term.store[resourceType] || 0) > 0) return term;

  var storage = rs.storage;
  if (storage && storage.store && (storage.store[resourceType] || 0) > 0) return storage;

  var containers = (rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) ? rs.structuresByType[STRUCTURE_CONTAINER] : [];
  var best = null;
  var bestAmt = 0;
  for (var i = 0; i < containers.length; i++) {
    var c = containers[i];
    if (!c || !c.store) continue;
    var amt = c.store[resourceType] || 0;
    if (amt > bestAmt) {
      bestAmt = amt;
      best = c;
    }
  }
  if (best) return best;

  // As a last resort, if energy needed, allow storage-like alternatives again
  return null;
}

function depositElsewhere(creep, rs, resourceType) {
  // Try storage > terminal (avoid cluttering containers if possible)
  var storage = rs ? rs.storage : null;
  if (storage && storage.store && storage.store.getFreeCapacity && storage.store.getFreeCapacity() > 0) {
    var r1 = creep.transfer(storage, resourceType);
    if (r1 === ERR_NOT_IN_RANGE) creep.moveTo(storage, { range: 1 });
    return true;
  }

  var term = rs ? rs.terminal : null;
  if (term && term.store && term.store.getFreeCapacity && term.store.getFreeCapacity() > 0) {
    var r2 = creep.transfer(term, resourceType);
    if (r2 === ERR_NOT_IN_RANGE) creep.moveTo(term, { range: 1 });
    return true;
  }

  // If nowhere to store, drop as a last resort
  creep.drop(resourceType);
  return true;
}

// Console entrypoint: nukeFill('W1N1', { maxPrice: 1.2 })
function order(roomName, opts) {
  if (!opts) opts = {};
  var maxPrice = typeof opts.maxPrice === 'number' ? opts.maxPrice : 10000.0;

  var room = Game.rooms[roomName];
  if (!room || !room.controller || !room.controller.my) {
    var m0 = '[NukeFill] Room ' + roomName + ' is not visible or not owned.';
    console.log(m0);
    return m0;
  }

  var rs = getRoomState.get(roomName);
  if (!rs) {
    var m1 = '[NukeFill] getRoomState not available for ' + roomName + ' this tick.';
    console.log(m1);
    return m1;
  }

  var nuker = getNukerFromState(rs);
  if (!nuker) {
    var m2 = '[NukeFill] No Nuker found in room ' + roomName + '.';
    console.log(m2);
    return m2;
  }

  var caps = getNukerCaps(nuker);
  var cur = getNukerAmounts(nuker);

  var energyNeeded = Math.max(0, caps.energy - cur.energy);
  var ghodiumNeeded = Math.max(0, caps.ghodium - cur.ghodium);

  // Room stock check (excluding the nuker itself)
  var energyInRoom = sumRoomResource(rs, RESOURCE_ENERGY, nuker.id);
  var ghodiumInRoom = sumRoomResource(rs, RESOURCE_GHODIUM, nuker.id);

  // Opportunistic buy for GHODIUM if short
  var buyAmt = 0;
  if (ghodiumNeeded > 0 && ghodiumInRoom < ghodiumNeeded) {
    buyAmt = ghodiumNeeded - ghodiumInRoom;
    if (rs.terminal) {
      opportunisticBuy.setup(roomName, RESOURCE_GHODIUM, buyAmt, maxPrice);
    } else {
      console.log('[NukeFill] No terminal in ' + roomName + ' to buy GHODIUM; will wait for manual supply.');
    }
  }

  Memory.nukeFillOrders[roomName] = {
    roomName: roomName,
    nukerId: nuker.id,
    energyTarget: caps.energy,
    ghodiumTarget: caps.ghodium,
    phase: energyNeeded > 0 ? 'energy' : (ghodiumNeeded > 0 ? 'ghodium' : 'done'),
    createdAt: Game.time,
    maxPrice: maxPrice,
    buyRequested: buyAmt > 0 ? true : false,
    completed: energyNeeded === 0 && ghodiumNeeded === 0
  };

  var msg =
    '[NukeFill] ' + roomName +
    ' | Energy need: ' + energyNeeded +
    ' | GHODIUM need: ' + ghodiumNeeded +
    (buyAmt > 0 ? (' | Buying GHODIUM: ' + buyAmt + ' @ <= ' + maxPrice) : ' | No GHODIUM buy needed');

  console.log(msg);
  return msg;
}

function run(creep) {
  var roomName = creep.memory.orderRoom || creep.memory.homeRoom || (creep.room ? creep.room.name : null);
  if (!roomName) return;

  var rs = getRoomState.get(roomName);
  if (!rs) return;

  var order = Memory.nukeFillOrders ? Memory.nukeFillOrders[roomName] : null;
  if (!order || order.completed) {
    // Idle/park if nothing to do
    var storage = rs.storage;
    if (storage) creep.moveTo(storage, { range: 2 });
    return;
  }

  var nuker = getNukerFromState(rs, creep.memory.nukerId);
  if (!nuker) {
    // Try to re-discover and update memory
    nuker = getNukerFromState(rs);
    if (nuker) creep.memory.nukerId = nuker.id;
    else return; // nothing to do without nuker
  }

  var caps = getNukerCaps(nuker);
  var cur = getNukerAmounts(nuker);
  var needEnergy = Math.max(0, caps.energy - cur.energy);
  var needGhodium = Math.max(0, caps.ghodium - cur.ghodium);

  if (needEnergy === 0 && needGhodium === 0) {
    order.phase = 'done';
    order.completed = true;
    console.log('[NukeFill] Completed nuker fill in ' + roomName + '.');
    return;
  }

  // Phase: energy first, then GHODIUM
  var targetResource = needEnergy > 0 ? RESOURCE_ENERGY : RESOURCE_GHODIUM;
  order.phase = needEnergy > 0 ? 'energy' : 'ghodium';

  if (order.phase === 'ghodium' && !order.buyRequested) {
    // Re-check GHODIUM stock vs remaining, and open a buy if needed
    var gOutside = sumRoomResource(rs, RESOURCE_GHODIUM, nuker.id);
    var gNeed = Math.max(0, caps.ghodium - cur.ghodium);
    var buyMissing = Math.max(0, gNeed - gOutside);
    if (buyMissing > 0 && rs.terminal) {
      var price = typeof order.maxPrice === 'number' ? order.maxPrice : 1.0;
      opportunisticBuy.setup(roomName, RESOURCE_GHODIUM, buyMissing, price);
      order.buyRequested = true;
    }
  }

  // If carrying other resource(s), deposit them first
  if (creep.store) {
    for (var r in creep.store) {
      if (r !== targetResource && creep.store[r] > 0) {
        depositElsewhere(creep, rs, r);
        return;
      }
    }
  }

  // Ensure we have the right resource in carry; otherwise withdraw
  var carryAmt = creep.store ? (creep.store[targetResource] || 0) : 0;
  if (carryAmt <= 0) {
    var src = pickWithdrawTarget(rs, targetResource);
    if (src) {
      var res = creep.withdraw(src, targetResource);
      if (res === ERR_NOT_IN_RANGE) creep.moveTo(src, { range: 1, visualizePathStyle: { stroke: '#ffaa00' } });
    } else {
      // No source found. If waiting for GHODIUM, camp at terminal/storage
      var waitAt = rs.terminal || rs.storage;
      if (waitAt) creep.moveTo(waitAt, { range: 2 });
    }
    return;
  }

  // Deliver to nuker
  var tr = creep.transfer(nuker, targetResource);
  if (tr === ERR_NOT_IN_RANGE) {
    creep.moveTo(nuker, { range: 1, visualizePathStyle: { stroke: '#00ffff' } });
    return;
  }
  if (tr === ERR_FULL) {
    // Nuker reached cap for this resource; next tick will switch to next phase
    return;
  }
  if (tr === ERR_INVALID_ARGS || tr === ERR_INVALID_TARGET) {
    // Should not happen often; dump back
    depositElsewhere(creep, rs, targetResource);
  }
}

module.exports = {
  run: run,
  order: order
};
