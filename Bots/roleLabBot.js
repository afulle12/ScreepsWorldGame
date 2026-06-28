/**
 * =============================================================================
 * LAB BOT ROLE - Screeps Lab Logistics Creep (Multi-Group Edition)
 * =============================================================================
 */

var debugLog = function(message) {
  if (Memory.labsDebug) {
    console.log(message);
  }
};

var getRoomState = require('getRoomState');
var storageManager = require('storageManager');

function _getLabs(creep) {
  var rs = getRoomState.get(creep.room.name);
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_LAB]) {
    return rs.structuresByType[STRUCTURE_LAB];
  }
  return creep.room.find(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_LAB; }
  });
}

var LAB_CAPACITY = 3000;
var LAB_REACTION_AMOUNT = 5;

// Thresholds
var IDLE_SUICIDE_TICKS = 150;

// Boost manager — lazy loaded
var _boostManagerModule = null;
function getBoostManager() {
  if (!_boostManagerModule) _boostManagerModule = require('boostManager');
  return _boostManagerModule;
}

// Boost lab constants
var LAB_MINERAL_CAPACITY_BOOST = 3000;
var LAB_ENERGY_CAPACITY_BOOST  = 2000;

// =============================================================================
// ORDER HELPERS
// =============================================================================

function requestGracefulSuicide(creep, reason) {
  creep.memory.suicidePending = true;
  debugLog("[LabBot " + creep.name + "] graceful suicide requested — " + reason);
}

function consumeReservedWithdraw(creep, source, resourceType, amount, activeOrder) {
  if (!source || !activeOrder || !activeOrder.reservationProgram) {
    return creep.withdraw(source, resourceType, amount);
  }

  var building = null;
  if (source.structureType === STRUCTURE_TERMINAL) building = 'terminal';
  else if (source.structureType === STRUCTURE_STORAGE) building = 'storage';

  var result = creep.withdraw(source, resourceType, amount);
  if (result === OK && building) {
    storageManager.consume(creep.room.name, resourceType, building, activeOrder.reservationProgram, amount);
  }
  return result;
}

function consumeBoostWithdraw(creep, source, resourceType, amount) {
  var result = creep.withdraw(source, resourceType, amount);
  if (result !== OK || !source) {
    return result;
  }

  var building = null;
  if (source.structureType === STRUCTURE_TERMINAL) building = 'terminal';
  else if (source.structureType === STRUCTURE_STORAGE) building = 'storage';

  if (building) {
    var rv = storageManager.consume(creep.room.name, resourceType, building, 'boostManager', amount);
    if (!rv || !rv.ok) {
      debugLog('[LabBot ' + creep.name + '] boost consume mismatch ' + resourceType + ' from ' + building + ' amount=' + amount + ' reason=' + (rv && rv.reason ? rv.reason : 'unknown'));
    }
  }
  return result;
}

function getBoostReservedAmount(roomName, building, resourceType) {
  if (!Memory.storageReservations) return 0;
  var roomBuckets = Memory.storageReservations[roomName];
  if (!roomBuckets || !roomBuckets[building] || !roomBuckets[building][resourceType]) return 0;

  var reservations = roomBuckets[building][resourceType];
  var total = 0;
  for (var i = 0; i < reservations.length; i++) {
    if (reservations[i] && reservations[i].program === 'boostManager') {
      total += (reservations[i].amount || 0);
    }
  }
  return total;
}

function getBoostPickupTarget(roomName, resourceType, requestedAmount) {
  var room = Game.rooms[roomName];
  if (!room) return null;

  var terminal = room.terminal;
  var storage = room.storage;
  if (!terminal && !storage) return null;

  var terminalReserved = terminal ? getBoostReservedAmount(roomName, 'terminal', resourceType) : 0;
  var storageReserved = storage ? getBoostReservedAmount(roomName, 'storage', resourceType) : 0;

  if (terminalReserved >= requestedAmount && terminal) {
    return { source: terminal, amount: requestedAmount };
  }
  if (storageReserved >= requestedAmount && storage) {
    return { source: storage, amount: requestedAmount };
  }

  if (terminalReserved <= 0 && storageReserved <= 0) {
    return null;
  }

  if (terminalReserved >= storageReserved && terminalReserved > 0 && terminal) {
    return { source: terminal, amount: Math.min(requestedAmount, terminalReserved) };
  }

  if (storage && storageReserved > 0) {
    return { source: storage, amount: Math.min(requestedAmount, storageReserved) };
  }

  return null;
}

// =============================================================================
// BLOCKING MATERIAL DETECTION AND CLEANUP
// =============================================================================

function hasBlockers(layout, activeOrder) {
  var isBreakdown = activeOrder.type === 'breakdown';

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];

    if (isBreakdown) {
      var wrongIn1 = group.in1.mineralType && 
                     group.in1.mineralType !== activeOrder.reag1 &&
                     (group.in1.mineralAmount || 0) > 0;
      var wrongIn2 = group.in2.mineralType && 
                     group.in2.mineralType !== activeOrder.reag2 &&
                     (group.in2.mineralAmount || 0) > 0;

      if (wrongIn1 || wrongIn2) return true;

      for (var i = 0; i < group.outs.length; i++) {
        var out = group.outs[i];
        if (out.mineralType && 
            out.mineralType !== activeOrder.compound &&
            (out.mineralAmount || 0) > 0) {
          return true;
        }
      }
    } else {
      var wrongIn1b = group.in1.mineralType && group.in1.mineralType !== activeOrder.reag1;
      var wrongIn2b = group.in2.mineralType && group.in2.mineralType !== activeOrder.reag2;

      if (wrongIn1b || wrongIn2b) return true;

      for (var j = 0; j < group.outs.length; j++) {
        var outLab = group.outs[j];
        if (outLab.mineralType && outLab.mineralType !== activeOrder.product) {
          return true;
        }
      }
    }
  }

  return false;
}

function clearBlockingLabs(creep, layout, activeOrder) {
  var isBreakdown = activeOrder.type === 'breakdown';
  var expectedIn1 = activeOrder.reag1;
  var expectedIn2 = activeOrder.reag2;
  var expectedOut = isBreakdown ? activeOrder.compound : activeOrder.product;

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];

    if (group.in1.mineralType && 
        group.in1.mineralType !== expectedIn1 && 
        (group.in1.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(group.in1)) {
        var takeAmount = Math.min(group.in1.mineralAmount, creep.store.getFreeCapacity());
        creep.withdraw(group.in1, group.in1.mineralType, takeAmount);
        return true;
      } else {
        creep.moveTo(group.in1, { range: 1, reusePath: 10 });
        return true;
      }
    }

    if (group.in2.mineralType && 
        group.in2.mineralType !== expectedIn2 && 
        (group.in2.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(group.in2)) {
        var takeAmount = Math.min(group.in2.mineralAmount, creep.store.getFreeCapacity());
        creep.withdraw(group.in2, group.in2.mineralType, takeAmount);
        return true;
      } else {
        creep.moveTo(group.in2, { range: 1, reusePath: 10 });
        return true;
      }
    }

    for (var i = 0; i < group.outs.length; i++) {
      var out = group.outs[i];
      if (out.mineralType && 
          out.mineralType !== expectedOut && 
          (out.mineralAmount || 0) > 0) {
        if (creep.pos.isNearTo(out)) {
          var takeAmount = Math.min(out.mineralAmount, creep.store.getFreeCapacity());
          creep.withdraw(out, out.mineralType, takeAmount);
          return true;
        } else {
          creep.moveTo(out, { range: 1, reusePath: 10 });
          return true;
        }
      }
    }
  }

  return false;
}

// =============================================================================
// PRODUCTION MODE HELPERS
// =============================================================================

function getPerInputTarget(layout, activeOrder) {
  var remaining = typeof activeOrder.remaining === "number"
      ? activeOrder.remaining
      : (activeOrder.amount || 0);
  if (remaining <= 0) return 0;
 
  var outputCapacity = 0;
  var outStock = 0;
  for (var g = 0; g < layout.groups.length; g++) {
    for (var i = 0; i < layout.groups[g].outs.length; i++) {
      var outLab = layout.groups[g].outs[i];
      outputCapacity += outLab.store.getFreeCapacity(activeOrder.product) || 0;
      outStock      += (outLab.store && outLab.store[activeOrder.product]) || 0;
    }
  }
 
  // Product already in output labs counts toward fulfilling the order, so
  // we only need to size input labs for what is STILL to be produced. This
  // prevents the labbot from topping up reagents past the point where the
  // remaining reactions plus already-produced output cover the order.
  var stillToProduce = Math.max(0, remaining - outStock);
  if (stillToProduce === 0) return 0;
 
  var maxProducible  = Math.min(stillToProduce, outputCapacity);
  var numGroups      = layout.groups.length;
  var perGroupTarget = Math.ceil(maxProducible / numGroups);
  var perInputTarget = Math.min(perGroupTarget, LAB_CAPACITY);
 
  var mod = perInputTarget % LAB_REACTION_AMOUNT;
  if (mod !== 0) {
    perInputTarget += (LAB_REACTION_AMOUNT - mod);
  }
  perInputTarget = Math.min(perInputTarget, LAB_CAPACITY);
 
  return Math.max(perInputTarget, 0);
}

function findMostNeededInput(layout, activeOrder, target, room) {
  var best = null;
  var bestDeficit = 0;

  var terminal = room ? room.terminal : null;
  var storage = room ? room.storage : null;
  var reag1Available = ((terminal && terminal.store[activeOrder.reag1]) || 0) + 
                       ((storage && storage.store[activeOrder.reag1]) || 0);
  var reag2Available = ((terminal && terminal.store[activeOrder.reag2]) || 0) + 
                       ((storage && storage.store[activeOrder.reag2]) || 0);

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];

    if (reag1Available > 0) {
      var have1 = (group.in1.mineralType === activeOrder.reag1) ? (group.in1.mineralAmount || 0) : 0;
      var def1 = Math.max(0, target - have1);

      if (def1 > bestDeficit) {
        bestDeficit = def1;
        best = { group: group, groupIndex: g, reagent: activeOrder.reag1, lab: group.in1, deficit: def1 };
      }
    }

    if (reag2Available > 0) {
      var have2 = (group.in2.mineralType === activeOrder.reag2) ? (group.in2.mineralAmount || 0) : 0;
      var def2 = Math.max(0, target - have2);

      if (def2 > bestDeficit) {
        bestDeficit = def2;
        best = { group: group, groupIndex: g, reagent: activeOrder.reag2, lab: group.in2, deficit: def2 };
      }
    }
  }

  return best;
}

function handleReagentDeliveryBalanced(creep, layout, activeOrder, target) {
  if (creep.store.getUsedCapacity() > 0) {
    function depositBalanced(reagent, isReag1) {
      if ((creep.store[reagent] || 0) === 0) return false;

      var needy = [];
      for (var g = 0; g < layout.groups.length; g++) {
        var grp = layout.groups[g];
        var lab = isReag1 ? grp.in1 : grp.in2;
        var have = (lab.mineralType === reagent) ? (lab.mineralAmount || 0) : 0;
        if (have < target) needy.push({ lab: lab, have: have });
      }
      if (needy.length === 0) return false;

      needy.sort(function(a, b) { return a.have - b.have; });
      var pick = needy[0];

      if (!creep.pos.isNearTo(pick.lab)) {
        creep.moveTo(pick.lab, { range: 1, reusePath: 10 });
        return true;
      }

      var cap;
      if (needy.length === 1) {
        cap = target - pick.have;
      } else if (needy[1].have > pick.have) {
        cap = needy[1].have - pick.have;
      } else {
        cap = Math.ceil(creep.store[reagent] / needy.length);
      }
      cap = Math.max(cap, LAB_REACTION_AMOUNT);

      var space = pick.lab.store.getFreeCapacity(reagent) || 0;
      var amount = Math.min(creep.store[reagent], space, cap);
      if (amount > 0) {
        creep.transfer(pick.lab, reagent, amount);
        creep.memory.idleTicks = 0;
      }
      return true;
    }

    if (depositBalanced(activeOrder.reag1, true)) return;
    if (depositBalanced(activeOrder.reag2, false)) return;
    deliverToBest(creep);
    return;
  }

  var needed = findMostNeededInput(layout, activeOrder, target, creep.room);
  if (!needed || needed.deficit <= 0) return;

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var targetReagent = needed.reagent;

  var totalDeficit = 0;
  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];
    var lab = (targetReagent === activeOrder.reag1) ? group.in1 : group.in2;
    var have = (lab.mineralType === targetReagent) ? (lab.mineralAmount || 0) : 0;
    totalDeficit += Math.max(0, target - have);
  }

  var targetAmount = Math.min(totalDeficit, creep.store.getCapacity());

  var source = null;
  var reservationProgram = activeOrder && activeOrder.reservationProgram;
  var info = reservationProgram ? storageManager.storageFind(creep.room.name, targetReagent) : null;
  var terminalReserved = info && info.terminal && Array.isArray(info.terminal.reservations)
    ? info.terminal.reservations : [];
  var storageReserved = info && info.storage && Array.isArray(info.storage.reservations)
    ? info.storage.reservations : [];
  var termReservedAmt = 0;
  var storReservedAmt = 0;
  for (var rr = 0; rr < terminalReserved.length; rr++) {
    if (terminalReserved[rr] && terminalReserved[rr].program === reservationProgram) termReservedAmt += terminalReserved[rr].amount || 0;
  }
  for (var rs = 0; rs < storageReserved.length; rs++) {
    if (storageReserved[rs] && storageReserved[rs].program === reservationProgram) storReservedAmt += storageReserved[rs].amount || 0;
  }

  if (terminal && reservationProgram && termReservedAmt > 0) {
    source = terminal;
    targetAmount = Math.min(targetAmount, termReservedAmt, terminal.store[targetReagent] || 0);
  } else if (storage && reservationProgram && storReservedAmt > 0) {
    source = storage;
    targetAmount = Math.min(targetAmount, storReservedAmt, storage.store[targetReagent] || 0);
  } else if (terminal && (terminal.store[targetReagent] || 0) >= targetAmount) {
    source = terminal;
  } else if (storage && (storage.store[targetReagent] || 0) >= targetAmount) {
    source = storage;
  } else if (terminal && (terminal.store[targetReagent] || 0) > 0) {
    source = terminal;
    targetAmount = Math.min(terminal.store[targetReagent], creep.store.getCapacity());
  } else if (storage && (storage.store[targetReagent] || 0) > 0) {
    source = storage;
    targetAmount = Math.min(storage.store[targetReagent], creep.store.getCapacity());
  }

  if (!source) return;

  if (creep.pos.isNearTo(source)) {
    var available = source.store[targetReagent] || 0;
    var takeAmount = Math.min(targetAmount, available, creep.store.getFreeCapacity());
    if (takeAmount > 0) {
      consumeReservedWithdraw(creep, source, targetReagent, takeAmount, activeOrder);
      creep.memory.idleTicks = 0;
    }
  } else {
    creep.moveTo(source, { range: 1, reusePath: 10 });
  }
}

function handleMidReactionEvacuation(creep, layout, activeOrder) {
  var product = activeOrder.product;

  if (creep.store.getUsedCapacity() > 0 && !(creep.store[product] > 0)) {
    deliverToBest(creep);
    return true;
  }

  var nearestLab = null;
  var nearestRange = Infinity;

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];
    for (var i = 0; i < group.outs.length; i++) {
      var outLab = group.outs[i];
      if (outLab.mineralType === product && (outLab.mineralAmount || 0) > 0) {
        var range = creep.pos.getRangeTo(outLab);
        if (range < nearestRange) {
          nearestRange = range;
          nearestLab = outLab;
        }
      }
    }
  }

  if ((creep.store[product] || 0) > 0) {
    var freeCapacity = creep.store.getFreeCapacity();

    if (freeCapacity < LAB_REACTION_AMOUNT) {
      deliverProductAndRecord(creep, product);
      return true;
    }

    if (nearestLab) {
      if (creep.pos.isNearTo(nearestLab)) {
        var takeAmount = Math.min(nearestLab.mineralAmount || 0, freeCapacity);
        creep.withdraw(nearestLab, product, takeAmount);
        creep.memory.idleTicks = 0;
      } else {
        creep.moveTo(nearestLab, { range: 1, reusePath: 10 });
      }
      return true;
    }

    deliverProductAndRecord(creep, product);
    return true;
  }

  if (!nearestLab) return false;

  if (creep.pos.isNearTo(nearestLab)) {
    var takeAmount = Math.min(nearestLab.mineralAmount || 0, creep.store.getCapacity());
    creep.withdraw(nearestLab, product, takeAmount);
    creep.memory.idleTicks = 0;
  } else {
    creep.moveTo(nearestLab, { range: 1, reusePath: 10 });
  }
  return true;
}

function handleProductionEvacuation(creep, layout, activeOrder) {
  var cleanupTarget = null;
  var cleanupResource = null;
  var cleanupAmount = 0;

  for (var g = 0; g < layout.groups.length && !cleanupTarget; g++) {
    var group = layout.groups[g];

    for (var i = 0; i < group.outs.length; i++) {
      var outLab = group.outs[i];
      if (outLab.mineralType === activeOrder.product && (outLab.mineralAmount || 0) > 0) {
        cleanupTarget   = outLab;
        cleanupResource = activeOrder.product;
        cleanupAmount   = outLab.mineralAmount;
        break;
      }
    }

    if (!cleanupTarget && (group.in1.mineralAmount || 0) > 0) {
      cleanupTarget   = group.in1;
      cleanupResource = group.in1.mineralType;
      cleanupAmount   = group.in1.mineralAmount;
    } else if (!cleanupTarget && (group.in2.mineralAmount || 0) > 0) {
      cleanupTarget   = group.in2;
      cleanupResource = group.in2.mineralType;
      cleanupAmount   = group.in2.mineralAmount;
    }
  }

  if (cleanupTarget) {
    if (creep.store.getUsedCapacity() > 0 && !(creep.store[cleanupResource] > 0)) {
      var product = activeOrder.product;
      if ((creep.store[product] || 0) > 0) deliverProductAndRecord(creep, product);
      else deliverToBest(creep);
      return;
    }

    if (creep.store.getFreeCapacity() === 0) {
      var product = activeOrder.product;
      if ((creep.store[product] || 0) > 0) deliverProductAndRecord(creep, product);
      else deliverToBest(creep);
      return;
    }

  if (creep.pos.isNearTo(cleanupTarget)) {
    consumeReservedWithdraw(creep, cleanupTarget, cleanupResource,
                            Math.min(cleanupAmount, creep.store.getFreeCapacity()), activeOrder);
  } else {
    creep.moveTo(cleanupTarget, { range: 1, reusePath: 10 });
  }
    return;
  }

  if (creep.store.getUsedCapacity() > 0) {
    var product = activeOrder.product;
    if ((creep.store[product] || 0) > 0) deliverProductAndRecord(creep, product);
    else deliverToBest(creep);
    return;
  }

  if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
    creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
  }
}

// =============================================================================
// BREAKDOWN MODE HELPERS
// =============================================================================

function findLowestOutputLab(layout, activeOrder, targetPerLab) {
  var compound = activeOrder.compound;
  var best = null;
  var lowestAmount = Infinity;

  var effectiveTarget = Math.max(targetPerLab, LAB_REACTION_AMOUNT);

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];

    for (var i = 0; i < group.outs.length; i++) {
      var outLab = group.outs[i];
      var canAccept = outLab.mineralType === compound || !outLab.mineralType || (outLab.mineralAmount || 0) === 0;

      if (!canAccept) continue;

      var currentAmount = (outLab.mineralType === compound) ? (outLab.mineralAmount || 0) : 0;
      var freeSpace = outLab.store.getFreeCapacity(compound) || 0;

      if (currentAmount < effectiveTarget && freeSpace > 0 && currentAmount < lowestAmount) {
        lowestAmount = currentAmount;
        best = {
          lab: outLab,
          groupIndex: g,
          outIndex: i,
          currentAmount: currentAmount,
          deficit: effectiveTarget - currentAmount,
          freeSpace: freeSpace
        };
      }
    }
  }

  return best;
}

function countTotalOutputLabs(layout) {
  var count = 0;
  for (var g = 0; g < layout.groups.length; g++) {
    count += layout.groups[g].outs.length;
  }
  return count;
}

function handleBreakdownDelivery(creep, layout, activeOrder) {
  var compound = activeOrder.compound;
  var carryCapacity = creep.store.getCapacity();
 
  var remaining = typeof activeOrder.remaining === "number" ? activeOrder.remaining : (activeOrder.amount || 0);
  var totalOutputLabs = countTotalOutputLabs(layout);

  var allLabs = _getLabs(creep);

  var compoundInLabs = 0;
  var processableCompoundInLabs = 0;
 
  for (var li = 0; li < allLabs.length; li++) {
    var lab = allLabs[li];
    if (lab.mineralType === compound) {
      var amt = lab.mineralAmount || 0;
      compoundInLabs += amt;
      if (amt >= LAB_REACTION_AMOUNT) processableCompoundInLabs += amt;
    }
  }
 
  var targetPerLab;
  if (remaining < LAB_REACTION_AMOUNT) {
    targetPerLab = 0;
  } else {
    var totalToDistribute = compoundInLabs + remaining;
    var rawTarget = Math.ceil(totalToDistribute / Math.max(totalOutputLabs, 1));
    var mod = rawTarget % LAB_REACTION_AMOUNT;
    if (mod !== 0) rawTarget += (LAB_REACTION_AMOUNT - mod);
    targetPerLab = Math.max(rawTarget, LAB_REACTION_AMOUNT);
    targetPerLab = Math.min(targetPerLab, LAB_CAPACITY);
  }
 
  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var terminalCompound = (terminal && terminal.store[compound]) || 0;
  var storageCompound = (storage && storage.store[compound]) || 0;
  var compoundInTerminalStorage = terminalCompound + storageCompound;
 
  var totalCompoundAnywhere = compoundInTerminalStorage + compoundInLabs;
  var hasUsableCompound = terminalCompound >= LAB_REACTION_AMOUNT ||
                          storageCompound >= LAB_REACTION_AMOUNT;
  var hasProcessableCompoundAnywhere = hasUsableCompound || processableCompoundInLabs > 0;
 
  var totalReagentsInInputs = 0;
  var largestReagentAmount = 0;
  var reagentLabToEvacuate = null;
 
  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];
 
    var in1Amount = group.in1.mineralAmount || 0;
    totalReagentsInInputs += in1Amount;
    if (in1Amount > largestReagentAmount) {
      largestReagentAmount = in1Amount;
      reagentLabToEvacuate = { lab: group.in1, groupIndex: g, labName: 'IN1' };
    }
 
    var in2Amount = group.in2.mineralAmount || 0;
    totalReagentsInInputs += in2Amount;
    if (in2Amount > largestReagentAmount) {
      largestReagentAmount = in2Amount;
      reagentLabToEvacuate = { lab: group.in2, groupIndex: g, labName: 'IN2' };
    }
  }
 
  var breakdownEffectivelyComplete = !hasProcessableCompoundAnywhere;
  var isFinishingUp = breakdownEffectivelyComplete ||
                      remaining <= 0 ||
                      (remaining < LAB_REACTION_AMOUNT && !hasUsableCompound) ||
                      targetPerLab === 0;
 
  if (breakdownEffectivelyComplete && totalReagentsInInputs > 0) {
    debugLog("[LabBot " + creep.name + "] BREAKDOWN COMPLETE - forcing evacuation.");
 
    if (!activeOrder.evacuating) {
      activeOrder.evacuating = true;
      activeOrder.remaining = 0;
    }
  }
 
  if ((creep.store[compound] || 0) > 0) {
    var carryingAmount = creep.store[compound];
 
    if (carryingAmount < LAB_REACTION_AMOUNT || isFinishingUp) {
      deliverToBest(creep);
      return;
    }
 
    var lowestLab = findLowestOutputLab(layout, activeOrder, targetPerLab);
 
    if (lowestLab && lowestLab.deficit > 0) {
      if (creep.pos.isNearTo(lowestLab.lab)) {
        var amount = Math.min(creep.store[compound], lowestLab.freeSpace, lowestLab.deficit);
        if (amount > 0) {
          var code = creep.transfer(lowestLab.lab, compound, amount);
          if (code === OK) {
            var labManager = require('labManager');
            labManager.recordDelivery(creep.room.name, compound, amount);
            creep.memory.idleTicks = 0;
            debugLog("[LabBot " + creep.name + "] delivered " + amount + " " + compound + " to output lab (recorded)");
          }
        }
        return;
      } else {
        creep.moveTo(lowestLab.lab, { range: 1, reusePath: 10 });
        return;
      }
    }
 
    deliverToBest(creep);
    return;
  }
 
  if ((creep.store[activeOrder.reag1] || 0) > 0) {
    deliverReagentAndRecord(creep, activeOrder.reag1);
    return;
  }
  if ((creep.store[activeOrder.reag2] || 0) > 0) {
    deliverReagentAndRecord(creep, activeOrder.reag2);
    return;
  }
 
  if (creep.store.getUsedCapacity() > 0) {
    deliverToBest(creep);
    return;
  }
 
  if (isFinishingUp) {
    // If compound is still actively being processed in output labs, only evacuate input
    // labs when they are full (which would stall the reaction). Never evacuate proactively
    // while reactions are still running — wait for the reaction to finish first.
    if (processableCompoundInLabs > 0) {
      var destIn1Free = layout.groups[0].in1.store.getFreeCapacity(activeOrder.reag1) || 0;
      var destIn2Free = layout.groups[0].in2.store.getFreeCapacity(activeOrder.reag2) || 0;
      if (destIn1Free >= LAB_REACTION_AMOUNT && destIn2Free >= LAB_REACTION_AMOUNT) {
        // Reactions still running and inputs have room — wait, do not unload yet
        creep.memory.idleTicks = 0;
        debugLog("[LabBot " + creep.name + "] waiting for breakdown to finish (" + processableCompoundInLabs + " compound remaining in labs)");
        if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
          creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
        }
        return;
      }
      // Inputs are full — must evacuate them now or reactions stall
    }
 
    if (largestReagentAmount > 0 && reagentLabToEvacuate) {
      debugLog("[LabBot " + creep.name + "] finishing: evacuating " + largestReagentAmount +
               " " + reagentLabToEvacuate.lab.mineralType);
      if (creep.pos.isNearTo(reagentLabToEvacuate.lab)) {
        creep.withdraw(reagentLabToEvacuate.lab, reagentLabToEvacuate.lab.mineralType,
                       Math.min(reagentLabToEvacuate.lab.mineralAmount, carryCapacity));
        creep.memory.idleTicks = 0;
        return;
      } else {
        creep.moveTo(reagentLabToEvacuate.lab, { range: 1, reusePath: 10 });
        return;
      }
    }
 
    if (compoundInLabs > 0) {
      for (var li = 0; li < allLabs.length; li++) {
        var lab = allLabs[li];
        if (lab.mineralType === compound && (lab.mineralAmount || 0) > 0) {
          if (creep.pos.isNearTo(lab)) {
            creep.withdraw(lab, compound, Math.min(lab.mineralAmount, carryCapacity));
            creep.memory.idleTicks = 0;
            return;
          } else {
            creep.moveTo(lab, { range: 1, reusePath: 10 });
            return;
          }
        }
      }
    }
 
    if (!activeOrder.evacuating) {
      activeOrder.evacuating = true;
      activeOrder.remaining = 0;
    }
    if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
      creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
    }
    return;
  }
 
  var destinationsFull = false;
  for (var g = 0; g < layout.groups.length; g++) {
    var grp = layout.groups[g];
    if ((grp.in1.store.getFreeCapacity(activeOrder.reag1) || 0) < LAB_REACTION_AMOUNT) destinationsFull = true;
    if ((grp.in2.store.getFreeCapacity(activeOrder.reag2) || 0) < LAB_REACTION_AMOUNT) destinationsFull = true;
  }
  var noReactionsPossible = !hasUsableCompound && !processableCompoundInLabs;
  var shouldEvacuateReagents = (destinationsFull || noReactionsPossible) && largestReagentAmount > 0;
 
  if (shouldEvacuateReagents && reagentLabToEvacuate) {
    if (creep.pos.isNearTo(reagentLabToEvacuate.lab)) {
      consumeReservedWithdraw(creep, reagentLabToEvacuate.lab, reagentLabToEvacuate.lab.mineralType,
                              Math.min(reagentLabToEvacuate.lab.mineralAmount, carryCapacity), activeOrder);
      creep.memory.idleTicks = 0;
      debugLog("[LabBot " + creep.name + "] evacuating " + reagentLabToEvacuate.lab.mineralType);
      return;
    } else {
      creep.moveTo(reagentLabToEvacuate.lab, { range: 1, reusePath: 10 });
      return;
    }
  }
 
  var effectiveTarget = Math.max(targetPerLab, LAB_REACTION_AMOUNT);
  var lowestLab = findLowestOutputLab(layout, activeOrder, effectiveTarget);
  var shouldDeliverCompound = lowestLab && lowestLab.deficit > 0 && hasUsableCompound;
 
  if (shouldDeliverCompound) {
    var source = null;
    var fetchAmount = Math.min(lowestLab.deficit, carryCapacity);
 
    if (terminal && terminalCompound >= LAB_REACTION_AMOUNT) {
      source = terminal;
      fetchAmount = Math.min(fetchAmount, terminalCompound);
    } else if (storage && storageCompound >= LAB_REACTION_AMOUNT) {
      source = storage;
      fetchAmount = Math.min(fetchAmount, storageCompound);
    }
 
    if (source && fetchAmount >= LAB_REACTION_AMOUNT) {
      if (creep.pos.isNearTo(source)) {
        creep.withdraw(source, compound, Math.min(fetchAmount, creep.store.getFreeCapacity()));
        creep.memory.idleTicks = 0;
        return;
      } else {
        creep.moveTo(source, { range: 1, reusePath: 10 });
        return;
      }
    }
  }
 
  for (var li = 0; li < allLabs.length; li++) {
    var lab = allLabs[li];
    var labAmount = lab.mineralAmount || 0;
    if (lab.mineralType === compound && labAmount > 0 && labAmount < LAB_REACTION_AMOUNT) {
      if (creep.pos.isNearTo(lab)) {
        creep.withdraw(lab, compound, labAmount);
        creep.memory.idleTicks = 0;
        return;
      } else {
        creep.moveTo(lab, { range: 1, reusePath: 10 });
        return;
      }
    }
  }
 
  debugLog("[LabBot " + creep.name + "] idle: reagent=" + largestReagentAmount +
           ", compound=" + totalCompoundAnywhere);
 
  // If breakdown reactions are still running (compound in labs, inputs have room), don't suicide
  var destIn1Free = layout.groups[0].in1.store.getFreeCapacity(activeOrder.reag1) || 0;
  var destIn2Free = layout.groups[0].in2.store.getFreeCapacity(activeOrder.reag2) || 0;
  var breakdownActive = processableCompoundInLabs > 0 &&
                        destIn1Free >= LAB_REACTION_AMOUNT &&
                        destIn2Free >= LAB_REACTION_AMOUNT;
 
  if (breakdownActive) {
    creep.memory.idleTicks = 0;
    debugLog("[LabBot " + creep.name + "] waiting on active breakdown reactions");
    if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
      creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
    }
    return;
  }
 
  if (typeof creep.memory.idleTicks !== 'number') creep.memory.idleTicks = 0;
  creep.memory.idleTicks++;
 
  if (creep.memory.idleTicks >= IDLE_SUICIDE_TICKS) {
    requestGracefulSuicide(creep, "idle_too_long_" + creep.memory.idleTicks + "_ticks");
    return;
  }
 
  if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
    creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
  }
}


// =============================================================================
// DELIVERY HELPERS (second set with pickDeliveryTarget)
// =============================================================================

function pickDeliveryTarget(creep) {
  var terminal = creep.room.terminal;
  var storage  = creep.room.storage;

  if (creep.memory.labSink === 'storage') {
    if (storage && (storage.store.getFreeCapacity() || 0) > 0) return storage;
    if (terminal && (terminal.store.getFreeCapacity() || 0) > 0) return terminal;
    return storage || terminal || null;
  }

  if (terminal && (terminal.store.getFreeCapacity() || 0) > 0) return terminal;
  if (storage)  return storage;
  return terminal || null;
}

function deliverProductAndRecord(creep, productType) {
  var amount = creep.store[productType] || 0;
  if (amount <= 0) return false;

  var target = pickDeliveryTarget(creep);
  if (!target) {
    debugLog("[LabBot " + creep.name + "] No terminal or storage for product delivery");
    return false;
  }

  if (creep.pos.isNearTo(target)) {
    var code = creep.transfer(target, productType);
    if (code === OK) {
      creep.memory.lastAction = 'deposit';
      creep.memory.lastResource = productType;
      creep.memory.depositReason = 'product_delivery';
      creep.memory.idleTicks = 0;

      var labManager = require('labManager');
      labManager.recordDelivery(creep.room.name, productType, amount);
      return true;
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10 });
  }
  return false;
}

function deliverReagentAndRecord(creep, reagentType) {
  var amount = creep.store[reagentType] || 0;
  if (amount <= 0) return false;

  var target = pickDeliveryTarget(creep);
  if (!target) return false;

  if (creep.pos.isNearTo(target)) {
    var code = creep.transfer(target, reagentType);
    if (code === OK) {
      creep.memory.lastAction = 'deposit';
      creep.memory.lastResource = reagentType;
      creep.memory.depositReason = 'reagent_evacuation';
      creep.memory.idleTicks = 0;
      return true;
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10 });
  }
  return false;
}

function deliverToBest(creep) {
  if (creep.store.getUsedCapacity() === 0) return false;

  var target = pickDeliveryTarget(creep);
  if (!target) return false;

  if (creep.pos.isNearTo(target)) {
    for (var resourceType in creep.store) {
      if (creep.store[resourceType] > 0) {
        var code = creep.transfer(target, resourceType);
        if (code === OK) {
          creep.memory.lastAction = 'deposit';
          creep.memory.lastResource = resourceType;
          creep.memory.depositReason = 'general_delivery';
          return true;
        }
      }
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10 });
  }
  return false;
}

// === NEW HELPERS (Change 1a) ===
function orderNeedsResource(order, resource) {
  if (!order) return false;
  return resource === order.reag1 ||
         resource === order.reag2 ||
         resource === order.product ||
         resource === order.compound;
}

function isResourceReservedForRoom(roomName, resource, activeOrder) {
  if (orderNeedsResource(activeOrder, resource)) return true;

  var rm = Memory.labOrders && Memory.labOrders[roomName];
  if (rm && rm.queue) {
    for (var i = 0; i < rm.queue.length; i++) {
      if (orderNeedsResource(rm.queue[i], resource)) return true;
    }
  }

  if (Memory.marketLabForward && Memory.marketLabForward.rooms) {
    var lf = Memory.marketLabForward.rooms[roomName];
    if (lf) {
      for (var j = 0; j < lf.length; j++) {
        var op = lf[j];
        if (!op) continue;
        if (op.targetCompound === resource) return true;
        if (op.reagents && (op.reagents[0] === resource || op.reagents[1] === resource)) return true;
      }
    }
  }

  if (Memory.marketLabReverse && Memory.marketLabReverse.rooms) {
    var lr = Memory.marketLabReverse.rooms[roomName];
    if (lr) {
      for (var k = 0; k < lr.length; k++) {
        var op = lr[k];
        if (op && op.targetCompound === resource) return true;
      }
    }
  }

  return false;
}

/**
 * Pre-evac delivery helper
 */
function deliverPreEvacAndSell(creep, activeOrder) {
  if (creep.store.getUsedCapacity() === 0) return false;

  var terminal = creep.room.terminal;
  var target   = pickDeliveryTarget(creep);
  if (!target) return false;

  if (creep.pos.isNearTo(target)) {
    for (var resourceType in creep.store) {
      if (creep.store[resourceType] > 0) {
        var amount = creep.store[resourceType];
        var code = creep.transfer(target, resourceType);
        if (code === OK) {
          creep.memory.lastAction    = 'deposit';
          creep.memory.lastResource  = resourceType;
          creep.memory.depositReason = 'pre_evac_sell';
          creep.memory.idleTicks     = 0;

          // === UPDATED BLOCK (Change 1b) ===
          var isExpected = isResourceReservedForRoom(creep.room.name, resourceType, activeOrder);

          if (target === terminal &&
              !isExpected &&
              resourceType !== RESOURCE_ENERGY &&
              typeof global.marketSell === 'function') {
            global.marketSell(creep.room.name, resourceType, amount);
          }
          return true;
        }
      }
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10 });
  }
  return false;
}

function handlePreEvacuation(creep, layout, activeOrder) {
  var allLabs = _getLabs(creep);

  var pickupTarget   = null;
  var pickupResource = null;
  var pickupAmount   = 0;
  for (var i = 0; i < allLabs.length; i++) {
    var lab = allLabs[i];
    var mineralAmount = lab.mineralAmount || 0;
    if (mineralAmount > 0) {
      pickupTarget   = lab;
      pickupResource = lab.mineralType;
      pickupAmount   = mineralAmount;
      break;
    }
  }

  if (!pickupTarget) {
    if (creep.store.getUsedCapacity() > 0) {
      deliverPreEvacAndSell(creep, activeOrder);
      return;
    }
    var destIn1 = layout.groups[0].in1;
    if (!creep.pos.inRangeTo(destIn1, 3)) {
      creep.moveTo(destIn1, { range: 3, reusePath: 15 });
    }
    return;
  }

  if (creep.store.getUsedCapacity() > 0 && !(creep.store[pickupResource] > 0)) {
    deliverPreEvacAndSell(creep, activeOrder);
    return;
  }

  if (creep.store.getFreeCapacity() === 0) {
    deliverPreEvacAndSell(creep, activeOrder);
    return;
  }

    if (creep.pos.isNearTo(pickupTarget)) {
      var takeAmount = Math.min(pickupAmount, creep.store.getFreeCapacity());
      consumeReservedWithdraw(creep, pickupTarget, pickupResource, takeAmount, activeOrder);
      creep.memory.idleTicks = 0;
    } else {
      creep.moveTo(pickupTarget, { range: 1, reusePath: 10 });
    }
}

function handleBreakdownEvacuation(creep, layout, activeOrder) {
  // Check if compound is still being processed in output labs.
  // If so, only evacuate input labs when they are full (to unblock reactions).
  // Don't do a full evacuation while reactions are still running.
  var allLabsCheck = _getLabs(creep);
 
  var processableCompoundInLabs = 0;
  for (var pli = 0; pli < allLabsCheck.length; pli++) {
    var plab = allLabsCheck[pli];
    if (plab.mineralType === activeOrder.compound && (plab.mineralAmount || 0) >= LAB_REACTION_AMOUNT) {
      processableCompoundInLabs += plab.mineralAmount;
    }
  }
 
  if (processableCompoundInLabs > 0) {
    var in1Free = layout.groups[0].in1.store.getFreeCapacity(activeOrder.reag1) || 0;
    var in2Free = layout.groups[0].in2.store.getFreeCapacity(activeOrder.reag2) || 0;
 
    if (in1Free >= LAB_REACTION_AMOUNT && in2Free >= LAB_REACTION_AMOUNT) {
      // Reactions still running and inputs have space — wait, do not unload yet
      creep.memory.idleTicks = 0;
      debugLog("[LabBot " + creep.name + "] breakdown still running (" + processableCompoundInLabs + " compound in labs), waiting");
      if (creep.store.getUsedCapacity() > 0) {
        // Finish delivering anything already in carry before parking
        if ((creep.store[activeOrder.reag1] || 0) > 0) {
          deliverReagentAndRecord(creep, activeOrder.reag1);
          return;
        }
        if ((creep.store[activeOrder.reag2] || 0) > 0) {
          deliverReagentAndRecord(creep, activeOrder.reag2);
          return;
        }
        deliverToBest(creep);
        return;
      }
      if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
        creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
      }
      return;
    }
    // Inputs are full — must evacuate them now or the reaction stalls
  }
 
  // Compound is fully processed (or inputs are full and need clearing).
  // Proceed with normal evacuation logic.
 
  var pickupTarget = null;
  var pickupResource = null;
  var pickupAmount = 0;
 
  outer:
  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];
    var candidates = [
      { lab: group.in1, expectedResource: activeOrder.reag1 },
      { lab: group.in2, expectedResource: activeOrder.reag2 }
    ];
    for (var c = 0; c < candidates.length; c++) {
      var lab = candidates[c].lab;
      if ((lab.mineralAmount || 0) > 0) {
        pickupTarget   = lab;
        pickupResource = lab.mineralType;
        pickupAmount   = lab.mineralAmount;
        break outer;
      }
    }
  }
 
  if (!pickupTarget) {
    outer2:
    for (var g = 0; g < layout.groups.length; g++) {
      for (var i = 0; i < layout.groups[g].outs.length; i++) {
        var outLab = layout.groups[g].outs[i];
        if (outLab.mineralType === activeOrder.compound && (outLab.mineralAmount || 0) > 0) {
          pickupTarget   = outLab;
          pickupResource = activeOrder.compound;
          pickupAmount   = outLab.mineralAmount;
          break outer2;
        }
      }
    }
  }
 
  if (!pickupTarget) {
  var allLabs = _getLabs(creep);
    // Catch-all sweep: at this point reactions are finished (or inputs are
    // full and there's nothing more to react), so anything still sitting in
    // ANY lab needs to come out — not just the compound. Reagents stranded in
    // a lab the current layout treats as an output were previously invisible
    // here, leaving the bot with no pickup target and parked forever.
    for (var j = 0; j < allLabs.length; j++) {
      var lab = allLabs[j];
      if (lab.mineralType && (lab.mineralAmount || 0) > 0) {
        pickupTarget   = lab;
        pickupResource = lab.mineralType;
        pickupAmount   = lab.mineralAmount;
        break;
      }
    }
  }
 
  if (!pickupTarget) {
    if (creep.store.getUsedCapacity() > 0) {
      if ((creep.store[activeOrder.reag1] || 0) > 0) {
        deliverReagentAndRecord(creep, activeOrder.reag1);
      } else if ((creep.store[activeOrder.reag2] || 0) > 0) {
        deliverReagentAndRecord(creep, activeOrder.reag2);
      } else {
        deliverToBest(creep);
      }
      return;
    }
    if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
      creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
    }
    return;
  }
 
  if (creep.store.getUsedCapacity() > 0 && !(creep.store[pickupResource] > 0)) {
    if ((creep.store[activeOrder.reag1] || 0) > 0) {
      deliverReagentAndRecord(creep, activeOrder.reag1);
    } else if ((creep.store[activeOrder.reag2] || 0) > 0) {
      deliverReagentAndRecord(creep, activeOrder.reag2);
    } else {
      deliverToBest(creep);
    }
    return;
  }
 
  if (creep.store.getFreeCapacity() === 0) {
    if ((creep.store[activeOrder.reag1] || 0) > 0) {
      deliverReagentAndRecord(creep, activeOrder.reag1);
    } else if ((creep.store[activeOrder.reag2] || 0) > 0) {
      deliverReagentAndRecord(creep, activeOrder.reag2);
    } else {
      deliverToBest(creep);
    }
    return;
  }
 
  if (creep.pos.isNearTo(pickupTarget)) {
    var takeAmount = Math.min(pickupAmount, creep.store.getFreeCapacity());
    consumeReservedWithdraw(creep, pickupTarget, pickupResource, takeAmount, activeOrder);
    creep.memory.idleTicks = 0;
  } else {
    creep.moveTo(pickupTarget, { range: 1, reusePath: 10 });
  }
}


// =============================================================================
// BOOST LAB WORK
// =============================================================================

function handleBoostLabWork(creep) {
  var workItems = getBoostManager().getLabWork(creep.room.name);
  if (workItems.length === 0) return false;

  for (var wi = 0; wi < workItems.length; wi++) {
    var item = workItems[wi];
    var lab  = item.lab;

    if (item.stopping) {
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return true;
      }

      if (lab.mineralType && (lab.mineralAmount || 0) > 0) {
        if (creep.pos.isNearTo(lab)) {
          creep.withdraw(lab, lab.mineralType,
            Math.min(lab.mineralAmount, creep.store.getCapacity()));
          creep.memory.idleTicks = 0;
        } else {
          creep.moveTo(lab, { range: 1, reusePath: 10 });
        }
        return true;
      }

      var labEn = lab.store ? (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
      if (labEn > 0) {
        if (creep.pos.isNearTo(lab)) {
          creep.withdraw(lab, RESOURCE_ENERGY,
            Math.min(labEn, creep.store.getCapacity()));
          creep.memory.idleTicks = 0;
        } else {
          creep.moveTo(lab, { range: 1, reusePath: 10 });
        }
        return true;
      }

      continue;
    }

    if (item.hasWrongMineral) {
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return true;
      }
      if (creep.pos.isNearTo(lab)) {
        creep.withdraw(lab, lab.mineralType,
          Math.min(lab.mineralAmount || 0, creep.store.getCapacity()));
        creep.memory.idleTicks = 0;
      } else {
        creep.moveTo(lab, { range: 1, reusePath: 10 });
      }
      return true;
    }

    if (item.isUnboostDrain) {
      if (creep.store.getUsedCapacity() > 0) {
        continue;
      }
      if (creep.pos.isNearTo(lab)) {
        var drainAmt = Math.min(
          item.drainAmount || 500,
          lab.mineralAmount || 0,
          creep.store.getCapacity()
        );
        if (drainAmt > 0) {
          creep.withdraw(lab, item.compound, drainAmt);
          creep.memory.idleTicks = 0;
        }
      } else {
        creep.moveTo(lab, { range: 1, reusePath: 10 });
      }
      return true;
    }

    var compound = item.compound;
    if ((creep.store[compound] || 0) > 0 && item.needsCompound) {
      if (creep.pos.isNearTo(lab)) {
        var boostFillTarget = item.fillTarget || (LAB_MINERAL_CAPACITY_BOOST - 150);
        var currentAmt = (lab.mineralType === compound) ? (lab.mineralAmount || 0) : 0;
        var space = Math.max(0, boostFillTarget - currentAmt);
        var amt = Math.min(creep.store[compound], space);

        if (amt > 0) {
          creep.transfer(lab, compound, amt);
          creep.memory.idleTicks = 0;
        }
      } else {
        creep.moveTo(lab, { range: 1, reusePath: 10 });
      }
      return true;
    }

    if ((creep.store[RESOURCE_ENERGY] || 0) > 0 && item.needsEnergy) {
      if (creep.pos.isNearTo(lab)) {
        var enSpace = lab.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        var enAmt = Math.min(creep.store[RESOURCE_ENERGY], enSpace);
        if (enAmt > 0) {
          creep.transfer(lab, RESOURCE_ENERGY, enAmt);
          creep.memory.idleTicks = 0;
        }
      } else {
        creep.moveTo(lab, { range: 1, reusePath: 10 });
      }
      return true;
    }

    if (creep.store.getUsedCapacity() > 0) {
      continue;
    }

    if (item.needsCompound) {
      var boostFillTarget2 = item.fillTarget || (LAB_MINERAL_CAPACITY_BOOST - 150);
      var deficit = boostFillTarget2 - (item.compoundAmount || 0);
      var pickup  = Math.min(deficit, creep.store.getCapacity());
      var pickupTarget = getBoostPickupTarget(creep.room.name, compound, pickup);
      var src = pickupTarget ? pickupTarget.source : null;
      if (pickupTarget) {
        pickup = pickupTarget.amount;
      }

      if (src && pickup > 0) {
        if (creep.pos.isNearTo(src)) {
          consumeBoostWithdraw(creep, src, compound, pickup);
          creep.memory.idleTicks = 0;
        } else {
          creep.moveTo(src, { range: 1, reusePath: 10 });
        }
        return true;
      }
    }

    if (item.needsEnergy) {
      var enDeficit = LAB_ENERGY_CAPACITY_BOOST - (item.energyAmount || 0);
      var enPickup  = Math.min(enDeficit, creep.store.getCapacity());
      var enTarget = getBoostPickupTarget(creep.room.name, RESOURCE_ENERGY, enPickup);
      var enSrc = enTarget ? enTarget.source : null;
      if (enTarget) {
        enPickup = enTarget.amount;
      }

      if (enSrc && enPickup > 0) {
        if (creep.pos.isNearTo(enSrc)) {
          consumeBoostWithdraw(creep, enSrc, RESOURCE_ENERGY, enPickup);
          creep.memory.idleTicks = 0;
        } else {
          creep.moveTo(enSrc, { range: 1, reusePath: 10 });
        }
        return true;
      }
    }
  }

  if (creep.store.getUsedCapacity() > 0) {
    deliverToBest(creep);
    return true;
  }

  return false;
}

// =============================================================================
// MAIN ROLE LOGIC
// =============================================================================

module.exports = {
  run: function(creep) {
    if (creep.memory.phase) {
      var carryInfo = "";
      for (var resource in creep.store) {
        if (creep.store[resource] > 0) {
          carryInfo += resource + ":" + creep.store[resource] + " ";
        }
      }
      debugLog("[LabBot " + creep.name + "] phase=" + creep.memory.phase +
               " want=(" + (creep.memory.wantedReagents || "unknown") + ") " +
               "carry=" + carryInfo.trim() + " idle=" + (creep.memory.idleTicks || 0));
    }
 
    if (creep.memory.lastAction === 'deposit') {
      debugLog("[LabBot " + creep.name + "] depositOne(" + (creep.memory.lastResource || "undefined") + ") " +
               "reason=" + (creep.memory.depositReason || "unknown"));
      creep.memory.lastAction = null;
      creep.memory.lastResource = null;
      creep.memory.depositReason = null;
    }
 
    if (typeof creep.ticksToLive === "number" && creep.ticksToLive < 100 && !creep.memory.suicidePending) {
      requestGracefulSuicide(creep, "low_ttl_" + creep.ticksToLive);
    }
 
    if (creep.memory.suicidePending) {
      var terminal = creep.room.terminal;
      var storage = creep.room.storage;
      var depositTarget = terminal || storage;
 
      if (creep.store.getUsedCapacity() > 0) {
        if (!depositTarget) {
          creep.suicide();
          return;
        }
        if (!creep.pos.isNearTo(depositTarget)) {
          creep.moveTo(depositTarget, { range: 1, reusePath: 5 });
          return;
        }
        for (var resourceType in creep.store) {
          if (creep.store[resourceType] > 0) {
            creep.transfer(depositTarget, resourceType);
            return;
          }
        }
      }
      creep.suicide();
      return;
    }
 
    if (global.__boostActive && handleBoostLabWork(creep)) return;
 
    var orders = Memory.labOrders || {};
    var roomOrders = orders[creep.room.name];
 
    if (!roomOrders || !roomOrders.active) {
      delete creep.memory.labSink;
      if (global.__boostActive && handleBoostLabWork(creep)) return;
 
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }
      if (typeof creep.ticksToLive === "number" && creep.ticksToLive <= 50) {
        requestGracefulSuicide(creep, "idle_no_orders");
        return;
      }
 
      if (typeof creep.memory.idleTicks !== 'number') creep.memory.idleTicks = 0;
      creep.memory.idleTicks++;
      if (creep.memory.idleTicks >= 30) {
        requestGracefulSuicide(creep, "no_orders_idle");
        return;
      }
 
      var storage = creep.room.storage;
      if (storage && !creep.pos.inRangeTo(storage, 3)) {
        creep.moveTo(storage, { range: 3, reusePath: 20 });
      }
      return;
    }
 
    var activeOrder = roomOrders.active;
    creep.memory.labSink = activeOrder.sink || null;
    var labManager = require('labManager');

    if (activeOrder.origin === 'marketLab' || activeOrder.marketOpId) {
      delete creep.memory.labSink;
      requestGracefulSuicide(creep, "marketLab_order_supplier_owned");
      return;
    }
 
    if (activeOrder.type === 'cleanup') {
      creep.memory.phase = 'cleanup';
 
      if (creep.store.getUsedCapacity() > 0) {
        deliverPreEvacAndSell(creep, activeOrder);
        return;
      }

      var allLabsCleanup = _getLabs(creep);

      for (var cli = 0; cli < allLabsCleanup.length; cli++) {
        var clab = allLabsCleanup[cli];
        if ((clab.mineralAmount || 0) > 0) {
          if (creep.pos.isNearTo(clab)) {
            creep.withdraw(clab, clab.mineralType,
              Math.min(clab.mineralAmount, creep.store.getFreeCapacity()));
            creep.memory.idleTicks = 0;
          } else {
            creep.moveTo(clab, { range: 1, reusePath: 10 });
          }
          return;
        }
      }
 
      var cleanupStorage = creep.room.storage;
      if (cleanupStorage && !creep.pos.inRangeTo(cleanupStorage, 3)) {
        creep.moveTo(cleanupStorage, { range: 3, reusePath: 20 });
      }
      return;
    }
 
    var isBreakdown = activeOrder.type === 'breakdown';
    var layout = isBreakdown ? labManager.getBreakdownLayout(creep.room) : labManager.getLayout(creep.room);
 
    if (!layout || !layout.groups || layout.groups.length === 0) {
      debugLog("[LabBot " + creep.name + "] No valid lab layout found");
      return;
    }
 
    if (activeOrder.needsPreEvacuation) {
      creep.memory.phase = 'pre-evac';
      creep.memory.idleTicks = 0;
      handlePreEvacuation(creep, layout, activeOrder);
      return;
    }
 
    var remaining = typeof activeOrder.remaining === "number" ? activeOrder.remaining : (activeOrder.amount || 0);
    var shouldEvacuate = (remaining <= 0) || activeOrder.evacuating;
 
    if (shouldEvacuate) {
      creep.memory.phase = 'final';
      creep.memory.idleTicks = 0;
 
      if (isBreakdown) {
        handleBreakdownEvacuation(creep, layout, activeOrder);
      } else {
        handleProductionEvacuation(creep, layout, activeOrder);
      }
      return;
    }
 
    if (hasBlockers(layout, activeOrder)) {
      creep.memory.phase = 'cleanup';
      creep.memory.idleTicks = 0;
 
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }
 
      if (clearBlockingLabs(creep, layout, activeOrder)) {
        return;
      }
    }
 
    creep.memory.phase = 'buildA';
 
    if (isBreakdown) {
      creep.memory.wantedReagents = activeOrder.compound + " -> " + activeOrder.reag1 + "," + activeOrder.reag2;
      handleBreakdownDelivery(creep, layout, activeOrder);
    } else {
      creep.memory.wantedReagents = activeOrder.reag1 + "," + activeOrder.reag2;
 
      var carryCapacity = creep.store.getCapacity();
      var target = getPerInputTarget(layout, activeOrder);
 
      if (creep.store.getUsedCapacity() > 0) {
        var product = activeOrder.product;
        if ((creep.store[product] || 0) > 0) {
          deliverProductAndRecord(creep, product);
          return;
        }
        handleReagentDeliveryBalanced(creep, layout, activeOrder, target);
        return;
      }
 
      var largestReagentDeficit = 0;
      var reagentDeficits = {};
      reagentDeficits[activeOrder.reag1] = 0;
      reagentDeficits[activeOrder.reag2] = 0;
 
      for (var g = 0; g < layout.groups.length; g++) {
        var group = layout.groups[g];
        var have1 = (group.in1.mineralType === activeOrder.reag1) ? (group.in1.mineralAmount || 0) : 0;
        var have2 = (group.in2.mineralType === activeOrder.reag2) ? (group.in2.mineralAmount || 0) : 0;
        var def1 = Math.max(0, target - have1);
        var def2 = Math.max(0, target - have2);
        reagentDeficits[activeOrder.reag1] = Math.max(reagentDeficits[activeOrder.reag1], def1);
        reagentDeficits[activeOrder.reag2] = Math.max(reagentDeficits[activeOrder.reag2], def2);
        largestReagentDeficit = Math.max(largestReagentDeficit, def1, def2);
      }
 
      var terminal = creep.room.terminal;
      var storage = creep.room.storage;
      var reag1Available = ((terminal && terminal.store[activeOrder.reag1]) || 0) +
                           ((storage && storage.store[activeOrder.reag1]) || 0);
      var reag2Available = ((terminal && terminal.store[activeOrder.reag2]) || 0) +
                           ((storage && storage.store[activeOrder.reag2]) || 0);
 
      var canDeliverReag1 = reagentDeficits[activeOrder.reag1] >= carryCapacity && reag1Available >= carryCapacity;
      var canDeliverReag2 = reagentDeficits[activeOrder.reag2] >= carryCapacity && reag2Available >= carryCapacity;
 
      var largestProductAmount = 0;
      var product = activeOrder.product;
      for (var g = 0; g < layout.groups.length; g++) {
        var group = layout.groups[g];
        for (var i = 0; i < group.outs.length; i++) {
          var outLab = group.outs[i];
          if (outLab.mineralType === product) {
            var amt = outLab.mineralAmount || 0;
            largestProductAmount = Math.max(largestProductAmount, amt);
          }
        }
      }
 
      var isFinishingUp = remaining < carryCapacity;
      var canDeliverReag1Partial = reagentDeficits[activeOrder.reag1] > 0 && reag1Available > 0;
      var canDeliverReag2Partial = reagentDeficits[activeOrder.reag2] > 0 && reag2Available > 0;
 
      var shouldDeliverReagents = canDeliverReag1 || canDeliverReag2 ||
                                   (isFinishingUp && (canDeliverReag1Partial || canDeliverReag2Partial));
 
      var reag1CompletelyMissing = reag1Available === 0 && reagentDeficits[activeOrder.reag1] > 0;
      var reag2CompletelyMissing = reag2Available === 0 && reagentDeficits[activeOrder.reag2] > 0;
 
      if (!shouldDeliverReagents) {
        if (reag1CompletelyMissing && canDeliverReag2Partial) {
          shouldDeliverReagents = true;
        } else if (reag2CompletelyMissing && canDeliverReag1Partial) {
          shouldDeliverReagents = true;
        }
      }
 
      if (shouldDeliverReagents) {
        creep.memory.phase = 'buildA';
        creep.memory.idleTicks = 0;
        handleReagentDeliveryBalanced(creep, layout, activeOrder, target);
        return;
      }
 
      var allOutputsFull = true;
      for (var g = 0; g < layout.groups.length && allOutputsFull; g++) {
        var grp = layout.groups[g];
        for (var i = 0; i < grp.outs.length; i++) {
          if ((grp.outs[i].store.getFreeCapacity(activeOrder.product) || 0) >= LAB_REACTION_AMOUNT) {
            allOutputsFull = false;
            break;
          }
        }
      }
 
      var allReactionsStalled = true;
      for (var g = 0; g < layout.groups.length; g++) {
        var grp = layout.groups[g];
        if ((grp.in1.mineralAmount || 0) >= LAB_REACTION_AMOUNT &&
            (grp.in2.mineralAmount || 0) >= LAB_REACTION_AMOUNT) {
          allReactionsStalled = false;
          break;
        }
      }
      var shouldEvacuateProducts = allOutputsFull || allReactionsStalled;
 
      if (shouldEvacuateProducts) {
        creep.memory.phase = 'mid-evac';
        var didWork = handleMidReactionEvacuation(creep, layout, activeOrder);
        if (didWork) {
          creep.memory.idleTicks = 0;
          return;
        }
        // Fall through to idle logic if nothing was evacuated
      }
 
      // If reactions are still running (inverse of allReactionsStalled), don't count toward suicide.
      // allReactionsStalled is already computed above — reuse it rather than looping again.
      var reactionsActive = !allReactionsStalled;
 
      if (reactionsActive) {
        creep.memory.idleTicks = 0;
        debugLog("[LabBot " + creep.name + "] waiting on active reactions");
        if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
          creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
        }
        return;
      }
 
      if (typeof creep.memory.idleTicks !== 'number') creep.memory.idleTicks = 0;
      creep.memory.idleTicks++;
 
      if (creep.memory.idleTicks >= IDLE_SUICIDE_TICKS) {
        requestGracefulSuicide(creep, "production_idle_" + creep.memory.idleTicks + "_ticks");
        return;
      }
 
      debugLog("[LabBot " + creep.name + "] waiting: reagent deficit=" + largestReagentDeficit +
               " (reag1 avail=" + reag1Available + ", reag2 avail=" + reag2Available + ")" +
               ", product=" + largestProductAmount +
               ", idle=" + creep.memory.idleTicks + "/" + IDLE_SUICIDE_TICKS);
      if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
        creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
      }
    }
  }
};
