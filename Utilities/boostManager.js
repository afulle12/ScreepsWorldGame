/**
 * =============================================================================
 * BOOST MANAGER — Generic Screeps Creep Boosting Framework (Multi-Lab Edition)
 * =============================================================================
 *
 * Console Commands:
 *   boostUpgrader('W1N1', 3)          — Tier 3 XGH2O (+100%)
 *   boostUpgrader('W1N1', 2)          — Tier 2 GH2O  (+80%)
 *   boostUpgrader('W1N1', 1)          — Tier 1 GH    (+50%)
 *   boostRampartBot('W1N1', 3)        — Tier 3 XLH2O (+100% repair)
 *   boostRampartBot('W1N1', 2)        — Tier 2 LH2O  (+80% repair)
 *   boostRampartBot('W1N1', 1)        — Tier 1 LH    (+50% repair)
 *   boostDemolisher('W1N1', 3)        — Tier 3 XZH2O (4× dismantle)
 *   boostDemolisher('W1N1', 2)        — Tier 2 ZH2O  (3× dismantle)
 *   boostDemolisher('W1N1', 1)        — Tier 1 ZH    (2× dismantle)
 *   boost('W1N1', 'attacker', { XZHO2: 25, XLHO2: 25 })
 *   stopBoost('W1N1', 'upgrader')
 *   boostStatus()  /  boostStatus('W1N1')  /  boostStatus('W1N1', 'upgrader')
 *
 * Multi-lab burst behavior:
 *   Allocates up to half the room's labs per compound.
 *   LabBot fills ALL allocated labs to capacity in one burst, then suicides.
 *   LabBot only respawns when NO lab can serve a boost (all drained).
 *   5 labs × 6 boosts/lab = 30 boosts (~45,000 ticks) between labBot spawns.
 *
 * Spawn gating:
 *   Upgraders spawn as soon as ANY lab has enough compound + energy for 1 boost.
 *   No waiting for full batch purchase — first 450 compound triggers first upgrader.
 *
 * Memory: Memory.boostManager.orders[roomName][role] = {
 *   boosts: { 'XGH2O': { parts: 15, labIds: ['id1', 'id2', ...] } }, ...
 * }
 *
 * @module boostManager
 */

var storageManager   = require('storageManager');
var labManager       = require('labManager');
var opportunisticBuy = require('opportunisticBuy');
var getRoomState     = require('getRoomState');

function _getLabs(room) {
    var rs = getRoomState.get(room.name);
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_LAB]) {
        return rs.structuresByType[STRUCTURE_LAB];
    }
    return room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });
}

// =============================================================================
// CONSTANTS
// =============================================================================

var COMPOUND_PER_PART = 30;
var ENERGY_PER_PART   = 20;
var LAB_MINERAL_CAPACITY = 3000;
var LAB_ENERGY_CAPACITY  = 2000;

var DEFAULT_BATCH_SIZE  = 50;
var DEFAULT_REORDER_AT  = 5;
var PRICE_MULT_INSTANT  = 2.0;
var PRICE_MULT_ORDER    = 1.5;
var PURCHASE_CHECK_INTERVAL = 100;
var BUY_ORDER_STALL_TICKS   = 300;
var CLEANUP_RESERVATION_TICKS = 100000;

var UNBOOST_RETURN_PER_PART = 15;
var UNBOOST_TTL_THRESHOLD   = 100;

// Multi-lab: allocate up to this fraction of a room's total labs for boosting
var MAX_BOOST_LAB_FRACTION = 0.5;

var UPGRADER_TIERS = {
  1: { compound: 'GH',    name: 'Tier 1 (GH — +50%)' },
  2: { compound: 'GH2O',  name: 'Tier 2 (GH2O — +80%)' },
  3: { compound: 'XGH2O', name: 'Tier 3 (XGH2O — +100%)' }
};

// Repair boost tiers — LH family boosts WORK repair effectiveness
var RAMPARTBOT_TIERS = {
  1: { compound: 'LH',    name: 'Tier 1 (LH — +50% repair)' },
  2: { compound: 'LH2O',  name: 'Tier 2 (LH2O — +80% repair)' },
  3: { compound: 'XLH2O', name: 'Tier 3 (XLH2O — +100% repair)' }
};

// Dismantle boost tiers — ZH family boosts WORK dismantle effectiveness
// ZH=2×, ZHO2=3×, XZHO2=4× base dismantle hits per tick per WORK part
var DEMOLISHER_TIERS = {
  1: { compound: 'ZH',    name: 'Tier 1 (ZH — 2× dismantle)' },
  2: { compound: 'ZH2O',  name: 'Tier 2 (ZH2O — 3× dismantle)' },
  3: { compound: 'XZH2O', name: 'Tier 3 (XZH2O — 4× dismantle)' }
};

var UPGRADER_BOOST_BODY = (function() {
  var b = [];
  for (var i = 0; i < 15; i++) b.push(WORK);
  for (var j = 0; j < 5; j++)  b.push(CARRY);
  for (var k = 0; k < 20; k++) b.push(MOVE);
  return b;
})();
var UPGRADER_BOOST_COST = 2750;

// Max wallRepair body: 21 WORK / 12 CARRY / 17 MOVE = 50 parts, 3550 energy
// Matches the 3550-tier entry in spawnManager's wallRepair bodyConfigs.
var RAMPARTBOT_BOOST_BODY = (function() {
  var b = [];
  for (var i = 0; i < 21; i++) b.push(WORK);
  for (var j = 0; j < 12; j++) b.push(CARRY);
  for (var k = 0; k < 17; k++) b.push(MOVE);
  return b;
})();
var RAMPARTBOT_BOOST_COST = 3550;

// Max demolisher body: 36 WORK / 14 MOVE = 50 parts, 4300 energy
// No CARRY — demolishers drop all energy on the ground (working as intended).
// 14 MOVE gives 1 move per ~2.57 body parts; sufficient for in-room work.
// Matches the 36-WORK assumption used in orderDemolition teams.
var DEMOLISHER_BOOST_BODY = (function() {
  var b = [];
  for (var i = 0; i < 36; i++) b.push(WORK);
  for (var j = 0; j < 14; j++) b.push(MOVE);
  return b;
})();
var DEMOLISHER_BOOST_COST = 4300;

// =============================================================================
// TICK CACHE
// =============================================================================

var _cacheTick = 0;
var _hasAnyOrders = false;
var _labWorkCache = {};
var _activeOrdersCache = {};
var _needsLabBotCache = {};

function refreshTickCache() {
  if (_cacheTick === Game.time) return;
  _cacheTick = Game.time;
  _labWorkCache = {};
  _activeOrdersCache = {};
  _needsLabBotCache = {};

  _hasAnyOrders = false;
  if (Memory.boostManager && Memory.boostManager.orders) {
    for (var k in Memory.boostManager.orders) {
      _hasAnyOrders = true;
      break;
    }
  }
}

// =============================================================================
// MEMORY HELPERS
// =============================================================================

function ensureRoot() {
  if (!Memory.boostManager) Memory.boostManager = {};
  if (!Memory.boostManager.orders) Memory.boostManager.orders = {};
}

function getOrder(roomName, role) {
  if (!Memory.boostManager || !Memory.boostManager.orders) return null;
  var rOrders = Memory.boostManager.orders[roomName];
  if (!rOrders) return null;
  return rOrders[role] || null;
}

function setOrder(roomName, role, order) {
  ensureRoot();
  if (!Memory.boostManager.orders[roomName]) {
    Memory.boostManager.orders[roomName] = {};
  }
  Memory.boostManager.orders[roomName][role] = order;
  _cacheTick = 0;
  global.__boostActive = true;
}

function deleteOrder(roomName, role) {
  if (!Memory.boostManager || !Memory.boostManager.orders) return;
  if (Memory.boostManager.orders[roomName]) {
    delete Memory.boostManager.orders[roomName][role];
    if (Object.keys(Memory.boostManager.orders[roomName]).length === 0) {
      delete Memory.boostManager.orders[roomName];
    }
  }
  _cacheTick = 0;
}

/**
 * Migrate old labId (string) → labIds (array) format.
 * Safe to call repeatedly; no-ops if already migrated.
 */
function migrateLabIds(order) {
  if (!order || !order.boosts) return;
  for (var comp in order.boosts) {
    var info = order.boosts[comp];
    if (info.labId && !info.labIds) {
      info.labIds = [info.labId];
      delete info.labId;
    }
    if (!info.labIds) info.labIds = [];
  }
}

// =============================================================================
// UTILITY
// =============================================================================

function bodyCost(body) {
  var COSTS = { move: 50, work: 100, carry: 50, attack: 80,
                ranged_attack: 150, heal: 250, tough: 10, claim: 600 };
  var total = 0;
  for (var i = 0; i < body.length; i++) total += (COSTS[body[i]] || 0);
  return total;
}

function compoundPerBoost(parts) {
  return parts * COMPOUND_PER_PART;
}

function energyPerBoost(parts) {
  return parts * ENERGY_PER_PART;
}

function getRoomCompound(room, compound) {
  var amt = 0;
  if (room.terminal) amt += (room.terminal.store[compound] || 0);
  if (room.storage)  amt += (room.storage.store[compound] || 0);
  return amt;
}

/**
 * Get compound across multiple labs.
 */
function getLabsCompound(labIds, compound) {
  if (!labIds) return 0;
  var total = 0;
  for (var i = 0; i < labIds.length; i++) {
    var lab = Game.getObjectById(labIds[i]);
    if (lab && lab.mineralType === compound) total += (lab.mineralAmount || 0);
  }
  return total;
}

function getBoostLabStock(order, compound) {
  migrateLabIds(order);

  var info = order.boosts[compound];
  if (!info || !info.labIds || info.labIds.length === 0) {
    return { compound: 0, energy: 0 };
  }

  var compoundTotal = 0;
  var energyTotal = 0;

  for (var i = 0; i < info.labIds.length; i++) {
    var lab = Game.getObjectById(info.labIds[i]);
    if (!lab) continue;

    if (lab.mineralType === compound) {
      compoundTotal += (lab.mineralAmount || 0);
    }
    if (lab.store) {
      energyTotal += (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0);
    }
  }

  return {
    compound: compoundTotal,
    energy: energyTotal
  };
}

function getReservedAmount(roomName, building, material, program) {
  if (!Memory.storageReservations) return 0;
  var roomBuckets = Memory.storageReservations[roomName];
  if (!roomBuckets || !roomBuckets[building] || !roomBuckets[building][material]) return 0;

  var reservations = roomBuckets[building][material];
  var total = 0;
  for (var i = 0; i < reservations.length; i++) {
    if (reservations[i] && reservations[i].program === program) {
      total += (reservations[i].amount || 0);
    }
  }
  return total;
}

function getBoostAccessibleAmount(roomName, material) {
  var info = storageManager.storageFind(roomName, material);
  if (!info) return 0;

  var terminalOwn = getReservedAmount(roomName, 'terminal', material, 'boostManager');
  var storageOwn = getReservedAmount(roomName, 'storage', material, 'boostManager');

  var terminalActual = info.terminal ? (info.terminal.total || 0) : 0;
  var storageActual = info.storage ? (info.storage.total || 0) : 0;
  var terminalReserved = info.terminal ? (info.terminal.reserved || 0) : 0;
  var storageReserved = info.storage ? (info.storage.reserved || 0) : 0;

  var terminalOthers = Math.max(0, terminalReserved - terminalOwn);
  var storageOthers = Math.max(0, storageReserved - storageOwn);

  return Math.max(0, terminalActual - terminalOthers) + Math.max(0, storageActual - storageOthers);
}

function getRefPrice(compound) {
  var history = Game.market.getHistory(compound);
  if (history && history.length > 0) {
    return history[history.length - 1].avgPrice;
  }
  return 1.0;
}

/**
 * Compute the fill target for a boost compound's labs.
 * Leaves exactly enough free space for one unboost return so the
 * drain logic and fill logic don't fight each other.
 */
function getBoostFillTarget(parts) {
  var returned = parts * UNBOOST_RETURN_PER_PART;
  return LAB_MINERAL_CAPACITY - returned;
}

// =============================================================================
// LAB ALLOCATION — Multi-lab, up to half room's labs per compound
// =============================================================================

function selectBoostLab(room, usedLabIds) {
  var layout = labManager.getLayout(room);

  var allLabs = _getLabs(room);
  if (allLabs.length === 0) return null;

  var inputIds = {};
  if (layout && layout.groups) {
    for (var g = 0; g < layout.groups.length; g++) {
      inputIds[layout.groups[g].in1.id] = true;
      inputIds[layout.groups[g].in2.id] = true;
    }
  }

  var controller = room.controller;
  if (!controller) return null;

  var best = null;
  var bestRange = Infinity;
  var bestIsInput = true;

  for (var i = 0; i < allLabs.length; i++) {
    var lab = allLabs[i];
    if (usedLabIds[lab.id]) continue;

    var isInput = !!inputIds[lab.id];
    var range = lab.pos.getRangeTo(controller);

    if ((bestIsInput && !isInput) ||
        (isInput === bestIsInput && range < bestRange)) {
      best = lab;
      bestRange = range;
      bestIsInput = isInput;
    }
  }

  return best;
}

/**
 * Collect ALL lab IDs allocated by ANY boost order in a room.
 * No Game.getObjectById calls — just reads Memory.
 */
function getAllAllocatedLabIds(roomName) {
  var usedIds = {};
  if (!Memory.boostManager || !Memory.boostManager.orders) return usedIds;
  var rOrders = Memory.boostManager.orders[roomName];
  if (!rOrders) return usedIds;

  for (var role in rOrders) {
    var order = rOrders[role];
    if (!order || !order.boosts) continue;
    for (var comp in order.boosts) {
      var labIds = order.boosts[comp].labIds;
      if (labIds) {
        for (var i = 0; i < labIds.length; i++) {
          usedIds[labIds[i]] = true;
        }
      }
    }
  }
  return usedIds;
}

/**
 * Ensure all compounds in an order have labs allocated.
 * Allocates up to floor(totalLabs * MAX_BOOST_LAB_FRACTION) labs total
 * across all boost orders in the room.
 *
 * FAST PATH: if labIds arrays are already populated and at budget,
 * returns true with zero Game.getObjectById calls.
 */
function ensureLabsAllocated(room, order) {
  migrateLabIds(order);

  var allLabs = _getLabs(room);

  // Per-order budget — each order independently gets up to this many labs
  var perOrderBudget = Math.floor(allLabs.length * (order.maxLabFraction || MAX_BOOST_LAB_FRACTION));
  if (perOrderBudget < 1) perOrderBudget = 1;

  // ALL allocated IDs across all orders — used for exclusion only,
  // so two orders never claim the same lab
  var globalUsedIds = getAllAllocatedLabIds(room.name);

  // Quick check: do we need to do anything?
  var needsMore = false;
  var hasAtLeastOne = true;
  for (var comp in order.boosts) {
    var info = order.boosts[comp];
    if (!info.labIds || info.labIds.length === 0) {
      needsMore = true;
      hasAtLeastOne = false;
    } else if (info.labIds.length < perOrderBudget) {
      needsMore = true;
    }
  }
  if (!needsMore && hasAtLeastOne) return true;

  // Validate existing labIds for this order (remove destroyed labs)
  for (var comp2 in order.boosts) {
    var info2 = order.boosts[comp2];
    var valid = [];
    for (var v = 0; v < info2.labIds.length; v++) {
      if (Game.getObjectById(info2.labIds[v])) {
        valid.push(info2.labIds[v]);
      } else {
        delete globalUsedIds[info2.labIds[v]];
      }
    }
    info2.labIds = valid;
  }

  // Allocate more labs for each compound up to this order's own budget
  var allAssigned = true;
  for (var comp3 in order.boosts) {
    var info3 = order.boosts[comp3];

    while (info3.labIds.length < perOrderBudget) {
      var newLab = selectBoostLab(room, globalUsedIds);
      if (!newLab) break;

      info3.labIds.push(newLab.id);
      globalUsedIds[newLab.id] = true;

      console.log('[BoostManager] Allocated lab ' + newLab.id.substr(-4) +
        ' at (' + newLab.pos.x + ',' + newLab.pos.y + ') for ' + comp3 +
        ' in ' + room.name + ' (' + info3.labIds.length + '/' + perOrderBudget + ')');
    }

    if (info3.labIds.length === 0) {
      allAssigned = false;
      if (Game.time % 100 === 0) {
        console.log('[BoostManager] No available lab for ' + comp3 + ' in ' + room.name);
      }
    }
  }

  return allAssigned;
}

// =============================================================================
// PURCHASING
// =============================================================================

function handlePurchasing(roomName, order) {
  var room = Game.rooms[roomName];
  if (!room || !room.terminal) return;

  if (order.lastPurchaseCheck &&
      (Game.time - order.lastPurchaseCheck) < PURCHASE_CHECK_INTERVAL) {
    return;
  }
  order.lastPurchaseCheck = Game.time;

  if (!order.purchaseSetup) order.purchaseSetup = {};
  if (!order.buyOrderIds)   order.buyOrderIds = {};

  var batchSize = order.batchSize || DEFAULT_BATCH_SIZE;
  var reorderAt = order.reorderAt || DEFAULT_REORDER_AT;

  for (var compound in order.boosts) {
    var info      = order.boosts[compound];
    var parts     = info.parts;
    var perBoost  = compoundPerBoost(parts);
    var totalNeed = batchSize * perBoost;
    var reorderAmt = reorderAt * perBoost;

    var available = getRoomCompound(room, compound) +
                    getLabsCompound(info.labIds, compound);

    if (available >= totalNeed) {
      if (order.purchaseSetup[compound]) {
        var obKey = roomName + '_' + compound;
        var obReq = Memory.opportunisticBuy &&
                    Memory.opportunisticBuy.requests &&
                    Memory.opportunisticBuy.requests[obKey];
        if (obReq && obReq.remaining <= 0) {
          delete order.purchaseSetup[compound];
        }
      }
      continue;
    }

    if (available > reorderAmt && order.purchaseSetup[compound]) continue;

    var deficit = totalNeed - available;
    if (deficit <= 0) continue;

    var refPrice = getRefPrice(compound);
    var maxPrice = refPrice * PRICE_MULT_INSTANT;

    if (!order.purchaseSetup[compound]) {
      opportunisticBuy.setup(roomName, compound, deficit, maxPrice);
      order.purchaseSetup[compound] = true;
      console.log('[BoostManager] Set up opportunisticBuy for ' + deficit + ' ' +
        compound + ' in ' + roomName + ' (maxPrice: ' + maxPrice.toFixed(3) + ')');
    }

    var obKey2 = roomName + '_' + compound;
    var obReq2 = Memory.opportunisticBuy &&
                 Memory.opportunisticBuy.requests &&
                 Memory.opportunisticBuy.requests[obKey2];

    if (obReq2 && obReq2.remaining > 0) {
      var stallTicks = Game.time - (obReq2.createdAt || Game.time);

      if (stallTicks >= BUY_ORDER_STALL_TICKS && !order.buyOrderIds[compound]) {
        var buyPrice = refPrice * PRICE_MULT_ORDER;
        var orderAmt = obReq2.remaining;

        var res = Game.market.createOrder({
          type: ORDER_BUY, resourceType: compound,
          price: buyPrice, totalAmount: orderAmt, roomName: roomName
        });

        if (res === OK) {
          var myOrders = Game.market.orders;
          for (var id in myOrders) {
            var o = myOrders[id];
            if (o.type === ORDER_BUY && o.resourceType === compound &&
                o.roomName === roomName && o.remainingAmount === orderAmt && o.active) {
              order.buyOrderIds[compound] = id;
              break;
            }
          }
          console.log('[BoostManager] Placed buy order for ' + orderAmt + ' ' +
            compound + ' at ' + buyPrice.toFixed(3) + '/unit in ' + roomName);
        }
      }

      if (order.buyOrderIds[compound]) {
        var existing = Game.market.getOrderById(order.buyOrderIds[compound]);
        if (!existing || existing.remainingAmount <= 0) {
          delete order.buyOrderIds[compound];
        }
      }
    }
  }
}

// =============================================================================
// RESERVATIONS
// =============================================================================

function updateReservations(roomName) {
  var room = Game.rooms[roomName];
  if (!room) return;

  var roomOrders = (Memory.boostManager && Memory.boostManager.orders && Memory.boostManager.orders[roomName]) || {};
  var demand = {};

  for (var role in roomOrders) {
    var order = roomOrders[role];
    if (!order || !order.active || order.stopping) continue;
    migrateLabIds(order);

    for (var compound in order.boosts) {
      var info = order.boosts[compound];
      var totalCompoundNeed = (order.batchSize || DEFAULT_BATCH_SIZE) * compoundPerBoost(info.parts);
      var totalEnergyNeed = (order.batchSize || DEFAULT_BATCH_SIZE) * energyPerBoost(info.parts);
      var labStock = getBoostLabStock(order, compound);
      var need = Math.max(0, totalCompoundNeed - labStock.compound);
      var energyNeed = Math.max(0, totalEnergyNeed - labStock.energy);

      demand[compound] = (demand[compound] || 0) + need;
      demand[RESOURCE_ENERGY] = (demand[RESOURCE_ENERGY] || 0) + energyNeed;
    }
  }

  var active = {};
  for (var c in demand) active[c] = true;

  if (Memory.storageReservations && Memory.storageReservations[roomName]) {
    var roomBuckets = Memory.storageReservations[roomName];
    for (var building in roomBuckets) {
      var bucket = roomBuckets[building] || {};
      for (var material in bucket) {
        var reservations = bucket[material] || [];
        var hasBoostMgr = false;
        for (var i = 0; i < reservations.length; i++) {
          if (reservations[i] && reservations[i].program === 'boostManager') { hasBoostMgr = true; break; }
        }
        if (hasBoostMgr && !active[material]) {
          storageManager.unReserve(roomName, material, building, 'boostManager');
        }
      }
    }
  }

  for (var compound2 in demand) {
    var need = demand[compound2];
    if (need <= 0) {
      storageManager.unReserve(roomName, compound2, 'terminal', 'boostManager');
      storageManager.unReserve(roomName, compound2, 'storage', 'boostManager');
      continue;
    }

    var info2 = storageManager.storageFind(roomName, compound2);
    if (!info2 || (!info2.terminal && !info2.storage)) continue;

    var termOwn = getReservedAmount(roomName, 'terminal', compound2, 'boostManager');
    var storOwn = getReservedAmount(roomName, 'storage', compound2, 'boostManager');
    var termFree = info2.terminal
      ? Math.max(0, (info2.terminal.total || 0) - Math.max(0, (info2.terminal.reserved || 0) - termOwn))
      : 0;
    var storFree = info2.storage
      ? Math.max(0, (info2.storage.total || 0) - Math.max(0, (info2.storage.reserved || 0) - storOwn))
      : 0;
    var fromTerm = Math.min(need, termFree);
    var fromStor = Math.min(need - fromTerm, storFree);

    if (fromTerm > 0) {
      var rv1 = storageManager.reserve(roomName, compound2, 'terminal', 'boostManager', fromTerm);
      if (!rv1.ok) console.log('[BoostManager] Failed terminal reserve for ' + compound2 + ' in ' + roomName + ': ' + rv1.reason);
    } else {
      storageManager.unReserve(roomName, compound2, 'terminal', 'boostManager');
    }

    if (fromStor > 0) {
      var rv2 = storageManager.reserve(roomName, compound2, 'storage', 'boostManager', fromStor);
      if (!rv2.ok) console.log('[BoostManager] Failed storage reserve for ' + compound2 + ' in ' + roomName + ': ' + rv2.reason);
    } else {
      storageManager.unReserve(roomName, compound2, 'storage', 'boostManager');
    }
  }
}

function removeReservations(roomName, order) {
  updateReservations(roomName);
}

function placeCleanupReservations(roomName, order) {
  var room = Game.rooms[roomName];
  if (!room) return;

  for (var compound in order.boosts) {
    if (room.terminal && (room.terminal.store[compound] || 0) > 0) {
      storageManager.reserve(roomName, compound, 'terminal',
        'boostManager_cleanup', room.terminal.store[compound]);
    }
    if (room.storage && (room.storage.store[compound] || 0) > 0) {
      storageManager.reserve(roomName, compound, 'storage',
        'boostManager_cleanup', room.storage.store[compound]);
    }
  }
}

// =============================================================================
// STATUS QUERIES
// =============================================================================

function isActive(roomName, role) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  var order = getOrder(roomName, role);
  return !!(order && order.active && !order.stopping);
}

function isStopping(roomName, role) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  var order = getOrder(roomName, role);
  return !!(order && order.stopping);
}

function getActiveOrders(roomName) {
  refreshTickCache();
  if (!_hasAnyOrders) return {};
  if (_activeOrdersCache[roomName] !== undefined) return _activeOrdersCache[roomName];

  var rOrders = Memory.boostManager.orders[roomName];
  if (!rOrders) {
    _activeOrdersCache[roomName] = {};
    return {};
  }

  var result = {};
  for (var role in rOrders) {
    if (rOrders[role] && (rOrders[role].active || rOrders[role].stopping)) {
      result[role] = rOrders[role];
    }
  }
  _activeOrdersCache[roomName] = result;
  return result;
}

/**
 * Are ANY boost labs for a role ready? (at least one lab has enough
 * compound + energy for 1 boost). Spawns creep as soon as possible.
 */
function areLabsReady(roomName, role) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;

  var order = getOrder(roomName, role);
  if (!order || !order.active || order.stopping) return false;
  migrateLabIds(order);

  for (var compound in order.boosts) {
    var info = order.boosts[compound];
    if (!info.labIds || info.labIds.length === 0) return false;

    var needed = compoundPerBoost(info.parts);
    var neededEnergy = energyPerBoost(info.parts);
    var anyReady = false;

    for (var i = 0; i < info.labIds.length; i++) {
      var lab = Game.getObjectById(info.labIds[i]);
      if (!lab) continue;
      if (lab.mineralType && lab.mineralType !== compound && (lab.mineralAmount || 0) > 0) continue;
      var compAmt = (lab.mineralType === compound) ? (lab.mineralAmount || 0) : 0;
      var enAmt = lab.store ? (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
      if (compAmt >= needed && enAmt >= neededEnergy) { anyReady = true; break; }
    }

    if (!anyReady) return false;
  }

  return true;
}

function getBody(roomName, role) {
  refreshTickCache();
  if (!_hasAnyOrders) return null;
  var order = getOrder(roomName, role);
  if (!order || !order.body) return null;
  return order.body.slice();
}

function getBodyCost(roomName, role) {
  refreshTickCache();
  if (!_hasAnyOrders) return 0;
  var order = getOrder(roomName, role);
  return order ? (order.bodyCost || 0) : 0;
}

/**
 * Get boost metadata for creep memory when spawning.
 * Returns labIds arrays so creep can find whichever lab is ready.
 * Format: { needsBoost: true, boostLabs: { compound: [id1, id2, ...] }, boosted: {} }
 */
function getSpawnBoostMeta(roomName, role) {
  refreshTickCache();
  if (!_hasAnyOrders) return null;

  var order = getOrder(roomName, role);
  if (!order || !order.active || order.stopping) return null;
  migrateLabIds(order);

  var labs = {};
  var hasAny = false;
  for (var compound in order.boosts) {
    var info = order.boosts[compound];
    if (info.labIds && info.labIds.length > 0) {
      labs[compound] = info.labIds.slice();
      hasAny = true;
    }
  }

  if (!hasAny) return null;

  return {
    needsBoost: true,
    boostLabs: labs,
    boosted: {}
  };
}

/**
 * Get lab work needed for boost system in a room.
 * Returns work items for EACH lab that needs filling/emptying.
 *
 * FIX: Uses per-compound fillTarget (LAB_MINERAL_CAPACITY - unboostReturn)
 * instead of raw LAB_MINERAL_CAPACITY so labs are never filled past the
 * point where an unboost return would fit. This prevents the fill→drain
 * cycle that caused constant labBot respawning.
 *
 * TICK-CACHED.
 */
function getLabWork(roomName) {
  refreshTickCache();
  if (!_hasAnyOrders) return [];
  if (_labWorkCache[roomName] !== undefined) return _labWorkCache[roomName];

  var activeOrders = getActiveOrders(roomName);
  var work = [];

  for (var role in activeOrders) {
    var order = activeOrders[role];
    migrateLabIds(order);

    for (var compound in order.boosts) {
      var info = order.boosts[compound];
      if (!info.labIds || info.labIds.length === 0) continue;

      var perBoost = compoundPerBoost(info.parts);
      var perBoostEnergy = energyPerBoost(info.parts);

      // Dynamic fill target: leave exactly enough space for one unboost return
      var returned = info.parts * UNBOOST_RETURN_PER_PART;
      var fillTarget = LAB_MINERAL_CAPACITY - returned;

      for (var li = 0; li < info.labIds.length; li++) {
        var labId = info.labIds[li];
        var lab = Game.getObjectById(labId);
        if (!lab) continue;

        if (order.stopping) {
          var hasMineral = (lab.mineralAmount || 0) > 0;
          var hasEnergy = lab.store && (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0;
          if (hasMineral || hasEnergy) {
            work.push({
              labId: labId, lab: lab, compound: compound, role: role,
              needsCompound: false, needsEnergy: false,
              hasWrongMineral: false, stopping: true
            });
          }
          continue;
        }

        var wrongMineral = lab.mineralType &&
                           lab.mineralType !== compound &&
                           (lab.mineralAmount || 0) > 0;

        var compAmt = (lab.mineralType === compound) ? (lab.mineralAmount || 0) : 0;
        var enAmt = lab.store ? (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;

        // FIX: Use fillTarget instead of LAB_MINERAL_CAPACITY so we stop
        // filling once unboost headroom is reserved
        var needsComp = !wrongMineral && compAmt < fillTarget;
        var needsEn = enAmt < LAB_ENERGY_CAPACITY;

        if (wrongMineral || needsComp || needsEn) {
          work.push({
            labId: labId, lab: lab, compound: compound, role: role,
            needsCompound: needsComp, needsEnergy: needsEn,
            hasWrongMineral: wrongMineral, stopping: false,
            compoundAmount: compAmt, energyAmount: enAmt,
            fillTarget: fillTarget
          });
        }
      }

      // Proactive unboost drain: ensure at least one non-cooldown lab always
      // has enough free space for one unboost return. If not, emit a drain
      // work item so the labBot withdraws from the fullest non-cooldown lab
      // before the creep ever needs to unboost.
      if (!order.stopping) {
        var hasUnboostSpace = false;
        var bestDonorLab    = null;
        var bestDonorAmt    = 0;

        for (var ui = 0; ui < info.labIds.length; ui++) {
          var ulab = Game.getObjectById(info.labIds[ui]);
          if (!ulab) continue;
          if (ulab.mineralType && ulab.mineralType !== compound &&
              (ulab.mineralAmount || 0) > 0) continue;

          var ufree       = ulab.store ? (ulab.store.getFreeCapacity(compound) || 0) : 0;
          var uonCooldown = ulab.cooldown && ulab.cooldown > 0;
          var umineralAmt = (ulab.mineralType === compound) ? (ulab.mineralAmount || 0) : 0;

          if (!uonCooldown && ufree >= returned) {
            hasUnboostSpace = true;
            break;
          }
          if (!uonCooldown && umineralAmt > bestDonorAmt && umineralAmt >= returned) {
            bestDonorLab = ulab;
            bestDonorAmt = umineralAmt;
          }
        }

        if (!hasUnboostSpace && bestDonorLab) {
          work.push({
            labId: bestDonorLab.id, lab: bestDonorLab,
            compound: compound, role: role,
            needsCompound: false, needsEnergy: false,
            hasWrongMineral: false, stopping: false,
            isUnboostDrain: true, drainAmount: returned
          });
        }
      }
    }
  }

  _labWorkCache[roomName] = work;
  return work;
}

/**
 * Should a labBot spawn for boost work?
 * BURST BEHAVIOR: Spawn when ANY boost lab is below 1 boost of compound.
 * The labBot then fills ALL labs to capacity (fillTarget/2000) and suicides.
 * TICK-CACHED.
 */
function needsLabBot(roomName) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  if (_needsLabBotCache[roomName] !== undefined) return _needsLabBotCache[roomName];

  var work = getLabWork(roomName);
  if (work.length === 0) {
    _needsLabBotCache[roomName] = false;
    return false;
  }

  for (var i = 0; i < work.length; i++) {
    if (work[i].stopping || work[i].hasWrongMineral || work[i].isUnboostDrain) {
      _needsLabBotCache[roomName] = true;
      return true;
    }
  }

  var activeOrders = getActiveOrders(roomName);
  for (var role in activeOrders) {
    var order = activeOrders[role];
    if (!order.active) continue;
    migrateLabIds(order);

    for (var comp in order.boosts) {
      var info = order.boosts[comp];
      if (!info.labIds || info.labIds.length === 0) continue;

      var perBoost = compoundPerBoost(info.parts);
      var perBoostEnergy = energyPerBoost(info.parts);

      for (var li = 0; li < info.labIds.length; li++) {
        var lab = Game.getObjectById(info.labIds[li]);
        if (!lab) continue;

        if (lab.mineralType && lab.mineralType !== comp && (lab.mineralAmount || 0) > 0) continue;

        var compAmt = (lab.mineralType === comp) ? (lab.mineralAmount || 0) : 0;
        var enAmt = lab.store ? (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;

        if (compAmt < perBoost) {
          if (getBoostAccessibleAmount(roomName, comp) >= perBoost) {
            _needsLabBotCache[roomName] = true;
            return true;
          }
        }

        if (enAmt < perBoostEnergy) {
          if (getBoostAccessibleAmount(roomName, RESOURCE_ENERGY) >= perBoostEnergy) {
            _needsLabBotCache[roomName] = true;
            return true;
          }
        }
      }
    }
  }

  _needsLabBotCache[roomName] = false;
  return false;
}

function shouldUnboost(roomName, role) {
  refreshTickCache();
  if (!_hasAnyOrders) return false;
  var order = getOrder(roomName, role);
  return !!(order && (order.active || order.stopping));
}

/**
 * Find a lab to unboost into. Searches all labIds for one that:
 *   - has the right mineral type (or is empty)
 *   - has enough free space for one unboost return
 *   - is NOT on cooldown
 */
function getUnboostTarget(roomName, role, boostedCompounds) {
  refreshTickCache();
  if (!_hasAnyOrders) return null;

  var order = getOrder(roomName, role);
  if (!order) return null;
  migrateLabIds(order);

  for (var compound in order.boosts) {
    if (!boostedCompounds || !boostedCompounds[compound]) continue;

    var info = order.boosts[compound];
    if (!info.labIds || info.labIds.length === 0) continue;

    var returned = info.parts * UNBOOST_RETURN_PER_PART;

    for (var i = 0; i < info.labIds.length; i++) {
      var lab = Game.getObjectById(info.labIds[i]);
      if (!lab) continue;

      // Skip labs containing a different mineral
      var labMineral = lab.mineralType;
      if (labMineral && labMineral !== compound && (lab.mineralAmount || 0) > 0) continue;

      // Skip labs on cooldown — can't unboost into them right now
      if (lab.cooldown && lab.cooldown > 0) continue;

      var freeSpace = lab.store ? (lab.store.getFreeCapacity(compound) || 0) : 0;
      if (freeSpace < returned) continue;

      return { labId: info.labIds[i], compound: compound };
    }
  }

  return null;
}

function getUnboostTTL() {
  return UNBOOST_TTL_THRESHOLD;
}

function recordBoost(roomName, role, compound) {
  var order = getOrder(roomName, role);
  if (!order) return;
  if (typeof order.boostsCompleted !== 'number') order.boostsCompleted = 0;

  if (!order._pendingBoosts) order._pendingBoosts = {};
  order._pendingBoosts[compound] = true;

  var allDone = true;
  for (var comp in order.boosts) {
    if (!order._pendingBoosts[comp]) { allDone = false; break; }
  }

  if (allDone) {
    order.boostsCompleted++;
    order._pendingBoosts = {};
    console.log('[BoostManager] Boost cycle #' + order.boostsCompleted +
      ' completed for ' + role + ' in ' + roomName);
  }
}

// =============================================================================
// STOPPING / CLEANUP
// =============================================================================

function handleStopping(roomName, role, order) {
  var room = Game.rooms[roomName];
  if (!room) return;
  migrateLabIds(order);

  var allEmpty = true;
  for (var compound in order.boosts) {
    var info = order.boosts[compound];
    for (var i = 0; i < info.labIds.length; i++) {
      var lab = Game.getObjectById(info.labIds[i]);
      if (lab) {
        if ((lab.mineralAmount || 0) > 0) { allEmpty = false; break; }
        if (lab.store && (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) > 0) {
          allEmpty = false; break;
        }
      }
    }
    if (!allEmpty) break;
  }

  if (!allEmpty) return;

  console.log('[BoostManager] Cleanup complete for ' + role + ' in ' + roomName);

  // Clear any boostManager_cleanup reservations for these compounds.
  // placeCleanupReservations() used to re-lock them here, but nothing ever
  // removed those reservations, causing permanent stale entries.
  for (var cleanComp in order.boosts) {
    storageManager.unReserve(roomName, cleanComp, 'terminal', 'boostManager_cleanup');
    storageManager.unReserve(roomName, cleanComp, 'storage',  'boostManager_cleanup');
  }

  for (var comp in order.boosts) {
    opportunisticBuy.cancelRequest(roomName, comp);
  }

  if (order.buyOrderIds) {
    for (var comp2 in order.buyOrderIds) {
      var oid = order.buyOrderIds[comp2];
      if (oid) {
        var mktOrder = Game.market.getOrderById(oid);
        if (mktOrder) Game.market.cancelOrder(oid);
      }
    }
  }

  deleteOrder(roomName, role);
  updateReservations(roomName);
  console.log('[BoostManager] Fully stopped ' + role + ' boosting in ' + roomName);
}

// =============================================================================
// UNBOOST DRAIN — Lab-to-lab transfer to free space when creep needs to unboost
// =============================================================================


// =============================================================================
// MAIN RUNNER
// =============================================================================

function run() {
  ensureRoot();
  refreshTickCache();
  global.__boostActive = _hasAnyOrders;

  // ── One-time migration: clear stale reservations from the incorrect
  // compound names (XZHO2/ZHO2) used before the ZH→ZH2O→XZH2O rename.
  // Also clears any boostManager_cleanup entries left by the old code path.
  if (!Memory.boostManager._v2migration) {
    var staleCompounds = ['XZHO2', 'ZHO2'];
    for (var migrRn in Game.rooms) {
      var migrRoom = Game.rooms[migrRn];
      if (!migrRoom || !migrRoom.controller || !migrRoom.controller.my) continue;
      for (var sci = 0; sci < staleCompounds.length; sci++) {
        var sc = staleCompounds[sci];
        storageManager.unReserve(migrRn, sc, 'terminal', 'boostManager_cleanup');
        storageManager.unReserve(migrRn, sc, 'storage',  'boostManager_cleanup');
        storageManager.unReserve(migrRn, sc, 'terminal', 'boostManager');
        storageManager.unReserve(migrRn, sc, 'storage',  'boostManager');
      }
    }
    Memory.boostManager._v2migration = true;
    console.log('[BoostManager] Migration: cleared stale XZHO2/ZHO2 reservations.');
  }
  if (!_hasAnyOrders) return;

  var allOrders = Memory.boostManager.orders;

  for (var roomName in allOrders) {
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var rOrders = allOrders[roomName];

    for (var role in rOrders) {
      var order = rOrders[role];
      if (!order) continue;

      migrateLabIds(order);

      if (order.stopping) {
        handleStopping(roomName, role, order);
        continue;
      }

      if (!order.active) continue;

      ensureLabsAllocated(room, order);
      handlePurchasing(roomName, order);

    }

    if (Game.time % 50 === 0) {
      updateReservations(roomName);
    }

  }
}

// =============================================================================
// CONSOLE COMMANDS
// =============================================================================

function installConsole() {

  global.boost = function(roomName, role, compounds, customBody, opts) {
    if (typeof roomName !== 'string' || typeof role !== 'string') {
      return '[BoostManager] Usage: boost(roomName, role, { compound: parts }, [body], [opts])';
    }
    if (typeof compounds !== 'object' || compounds === null) {
      return '[BoostManager] compounds must be an object like { XGH2O: 15 }';
    }

    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) {
      return '[BoostManager] No owned room: ' + roomName;
    }

    var labs = _getLabs(room);
    var numCompounds = Object.keys(compounds).length;
    if (labs.length < numCompounds) {
      return '[BoostManager] Need ' + numCompounds + ' lab(s) but room has ' + labs.length;
    }

    var boosts = {};
    var summaryParts = [];
    for (var comp in compounds) {
      var parts = parseInt(compounds[comp], 10);
      if (isNaN(parts) || parts <= 0) {
        return '[BoostManager] Invalid parts count for ' + comp + ': ' + compounds[comp];
      }
      boosts[comp] = { parts: parts, labIds: [] };
      summaryParts.push(comp + '×' + parts);
    }

    var existing = getOrder(roomName, role);
    if (existing) {
      for (var oldComp in existing.boosts) {
        opportunisticBuy.cancelRequest(roomName, oldComp);
      }
    }

    var bCost = customBody ? bodyCost(customBody) : 0;
    var batchSize = (opts && opts.batchSize) || DEFAULT_BATCH_SIZE;
    var reorderAt = (opts && opts.reorderAt) || DEFAULT_REORDER_AT;
    var maxLabFrac = (opts && opts.maxLabFraction != null) ? opts.maxLabFraction : MAX_BOOST_LAB_FRACTION;

    setOrder(roomName, role, {
      active: true, stopping: false, boosts: boosts,
      body: customBody || null, bodyCost: bCost,
      batchSize: batchSize, reorderAt: reorderAt,
      maxLabFraction: maxLabFrac,
      boostsCompleted: 0, purchaseSetup: {}, buyOrderIds: {},
      lastPurchaseCheck: 0, _pendingBoosts: {}, created: Game.time
    });

    updateReservations(roomName);

    var maxLabs = Math.floor(labs.length * MAX_BOOST_LAB_FRACTION);
    var lines = ['[BoostManager] Enabled ' + role + ' boosting in ' + roomName];
    lines.push('  Compounds: ' + summaryParts.join(', '));
    if (customBody) lines.push('  Body: ' + customBody.length + ' parts, cost ' + bCost);
    lines.push('  Batch: ' + batchSize + ' boosts, reorder at ' + reorderAt);
    lines.push('  Max boost labs: ' + maxLabs + ' (of ' + labs.length + ' total)');

    for (var c in boosts) {
      var need = batchSize * compoundPerBoost(boosts[c].parts);
      var have = getRoomCompound(room, c);
      var ft = getBoostFillTarget(boosts[c].parts);
      lines.push('  ' + c + ': have ' + have + '/' + need +
        ' (' + compoundPerBoost(boosts[c].parts) + '/boost × ' + batchSize + ')' +
        ' | fill target: ' + ft + '/3000 (buffer: ' + (LAB_MINERAL_CAPACITY - ft) + ')');
    }

    lines.push('  With ' + maxLabs + ' labs: ' +
      (maxLabs * Math.floor(getBoostFillTarget(boosts[Object.keys(boosts)[0]].parts) / compoundPerBoost(boosts[Object.keys(boosts)[0]].parts))) +
      ' boosts between refills');

    return lines.join('\n');
  };

  global.boostUpgrader = function(roomName, tier) {
    tier = parseInt(tier, 10);
    var t = UPGRADER_TIERS[tier];
    if (!t) return '[BoostManager] Invalid tier. Use 1 (GH +50%), 2 (GH2O +80%), 3 (XGH2O +100%)';

    var compounds = {};
    compounds[t.compound] = 15;

    return global.boost(roomName, 'upgrader', compounds, UPGRADER_BOOST_BODY);
  };

  global.boostRampartBot = function(roomName, tier) {
    tier = parseInt(tier, 10);
    var t = RAMPARTBOT_TIERS[tier];
    if (!t) return '[BoostManager] Invalid tier. Use 1 (LH +50%), 2 (LH2O +80%), 3 (XLH2O +100%)';

    var compounds = {};
    compounds[t.compound] = 21; // 21 WORK parts in the boost body

    return global.boost(roomName, 'rampartBot', compounds, RAMPARTBOT_BOOST_BODY);
  };

  // ---------------------------------------------------------------------------
  // boostDemolisher — ZH family boosts WORK dismantle effectiveness
  //   Tier 1: ZH    → 2× dismantle (100 hits/tick per WORK part)
  //   Tier 2: ZHO2  → 3× dismantle (150 hits/tick per WORK part)
  //   Tier 3: XZHO2 → 4× dismantle (200 hits/tick per WORK part)
  //
  // No unboost is performed — demolishers operate in a foreign room and die there.
  // The lab compound will drain naturally as creeps spawn; stopBoost cleans it up.
  // ---------------------------------------------------------------------------
  global.boostDemolisher = function(roomName, tier) {
    tier = parseInt(tier, 10);
    var t = DEMOLISHER_TIERS[tier];
    if (!t) return '[BoostManager] Invalid tier. Use 1 (ZH 2×), 2 (ZH2O 3×), 3 (XZH2O 4×)';

    var compounds = {};
    compounds[t.compound] = 36; // 36 WORK parts in the boost body

    return global.boost(roomName, 'demolisher', compounds, DEMOLISHER_BOOST_BODY, { maxLabFraction: 1.0 });
  };

  global.stopBoost = function(roomName, role) {
    if (typeof roomName !== 'string' || typeof role !== 'string') {
      return '[BoostManager] Usage: stopBoost(roomName, role)';
    }

    var order = getOrder(roomName, role);
    if (!order) return '[BoostManager] No boost order for ' + role + ' in ' + roomName;

    order.stopping = true;
    order.active = false;
    _cacheTick = 0;
    updateReservations(roomName);

    return '[BoostManager] Stopping ' + role + ' boost in ' + roomName +
      '. LabBot will empty boost labs.';
  };

  global.boostStatus = function(roomName, role) {
    ensureRoot();
    var allOrders = Memory.boostManager.orders;

    if (Object.keys(allOrders).length === 0) {
      return '[BoostManager] No active boost orders';
    }

    var lines = [];

    for (var rn in allOrders) {
      if (roomName && rn !== roomName) continue;
      var rOrders = allOrders[rn];

      for (var r in rOrders) {
        if (role && r !== role) continue;
        var ord = rOrders[r];
        migrateLabIds(ord);

        var state = ord.stopping ? 'STOPPING' : (ord.active ? 'ACTIVE' : 'INACTIVE');
        lines.push('[BoostManager] ' + rn + ' / ' + r + ': ' + state +
          ' | Boosts done: ' + (ord.boostsCompleted || 0));

        for (var comp in ord.boosts) {
          var info = ord.boosts[comp];
          var room = Game.rooms[rn];
          var have = room ? getRoomCompound(room, comp) : '?';
          var need = (ord.batchSize || DEFAULT_BATCH_SIZE) * compoundPerBoost(info.parts);
          var perB = compoundPerBoost(info.parts);
          var perBE = energyPerBoost(info.parts);
          var ft = getBoostFillTarget(info.parts);

          var labDetails = [];
          var readyCount = 0;
          for (var li = 0; li < info.labIds.length; li++) {
            var lab = Game.getObjectById(info.labIds[li]);
            if (!lab) { labDetails.push('destroyed'); continue; }
            var ca = (lab.mineralType === comp) ? (lab.mineralAmount || 0) : 0;
            var ea = lab.store ? (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
            var wrong = lab.mineralType && lab.mineralType !== comp && (lab.mineralAmount || 0) > 0;
            var boostsInLab = Math.min(Math.floor(ca / perB), Math.floor(ea / perBE));
            var cd = (lab.cooldown && lab.cooldown > 0) ? '[CD:' + lab.cooldown + ']' : '';
            if (ca >= perB && ea >= perBE) readyCount++;
            labDetails.push(lab.id.substr(-4) + ':' + ca + '/' + ea +
              (wrong ? '[BLOCKED]' : '') + cd +
              '(' + boostsInLab + ' boosts)');
          }

          var buyOrd = (ord.buyOrderIds && ord.buyOrderIds[comp])
            ? ' | Buy order: ' + ord.buyOrderIds[comp] : '';

          lines.push('  ' + comp + ' ×' + info.parts + 'parts: ' +
            have + '/' + need + ' in room | ' +
            info.labIds.length + ' labs (' + readyCount + ' ready)' +
            ' | fill:' + ft + '/3000' + buyOrd);
          lines.push('    ' + labDetails.join(' | '));
        }

        if (ord.body) {
          lines.push('  Body: ' + ord.body.length + ' parts, cost ' + (ord.bodyCost || '?'));
        }
      }
    }

    return lines.join('\n');
  };
}

installConsole();

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  run: run,

  isActive: isActive,
  isStopping: isStopping,
  areLabsReady: areLabsReady,
  getBody: getBody,
  getBodyCost: getBodyCost,
  getSpawnBoostMeta: getSpawnBoostMeta,
  getLabWork: getLabWork,
  needsLabBot: needsLabBot,
  getActiveOrders: getActiveOrders,
  getOrder: getOrder,

  recordBoost: recordBoost,
  installConsole: installConsole,

  shouldUnboost: shouldUnboost,
  getUnboostTarget: getUnboostTarget,
  getUnboostTTL: getUnboostTTL,

  COMPOUND_PER_PART: COMPOUND_PER_PART,
  ENERGY_PER_PART: ENERGY_PER_PART,
  UNBOOST_RETURN_PER_PART: UNBOOST_RETURN_PER_PART,
  UNBOOST_TTL_THRESHOLD: UNBOOST_TTL_THRESHOLD,
  compoundPerBoost: compoundPerBoost,
  energyPerBoost: energyPerBoost,
  getBoostFillTarget: getBoostFillTarget,

  UPGRADER_BOOST_BODY: UPGRADER_BOOST_BODY,
  UPGRADER_BOOST_COST: UPGRADER_BOOST_COST,
  UPGRADER_TIERS: UPGRADER_TIERS,

  RAMPARTBOT_BOOST_BODY: RAMPARTBOT_BOOST_BODY,
  RAMPARTBOT_BOOST_COST: RAMPARTBOT_BOOST_COST,
  RAMPARTBOT_TIERS: RAMPARTBOT_TIERS,

  DEMOLISHER_BOOST_BODY: DEMOLISHER_BOOST_BODY,
  DEMOLISHER_BOOST_COST: DEMOLISHER_BOOST_COST,
  DEMOLISHER_TIERS: DEMOLISHER_TIERS
};
