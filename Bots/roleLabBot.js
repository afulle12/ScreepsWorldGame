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

var LAB_CAPACITY = 3000;
var LAB_REACTION_AMOUNT = 5;

// Thresholds
var REAGENT_EVAC_THRESHOLD = 1000;        // Only evacuate reagents when >= this amount
var PRODUCTION_EVAC_THRESHOLD = 2000;     // Only evacuate product when a lab has >= this amount
var IDLE_SUICIDE_TICKS = 150;             // Suicide after this many idle ticks with active order

// =============================================================================
// DELIVERY HELPERS
// =============================================================================

function deliverProductAndRecord(creep, productType) {
  var amount = creep.store[productType] || 0;
  if (amount <= 0) return false;

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var target = terminal || storage;

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

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var target = terminal || storage;

  if (!target) return false;

  if (creep.pos.isNearTo(target)) {
    var code = creep.transfer(target, reagentType);
    if (code === OK) {
      creep.memory.lastAction = 'deposit';
      creep.memory.lastResource = reagentType;
      creep.memory.depositReason = 'reagent_evacuation';
      creep.memory.idleTicks = 0;
      // NOTE: Do NOT call recordDelivery for reagent evacuation during breakdown
      // recordDelivery for breakdown tracks compound delivered TO labs, not reagents evacuated
      return true;
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10 });
  }
  return false;
}

function deliverToBest(creep) {
  if (creep.store.getUsedCapacity() === 0) return false;

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var target = terminal || storage;

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

// =============================================================================
// ORDER HELPERS
// =============================================================================

function requestGracefulSuicide(creep, reason) {
  creep.memory.suicidePending = true;
  debugLog("[LabBot " + creep.name + "] graceful suicide requested — " + reason);
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
      var wrongIn1 = group.in1.mineralType && group.in1.mineralType !== activeOrder.reag1;
      var wrongIn2 = group.in2.mineralType && group.in2.mineralType !== activeOrder.reag2;

      if (wrongIn1 || wrongIn2) return true;

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
  var remaining = typeof activeOrder.remaining === "number" ? activeOrder.remaining : (activeOrder.amount || 0);
  if (remaining <= 0) return 0;

  var outputCapacity = 0;
  for (var g = 0; g < layout.groups.length; g++) {
    for (var i = 0; i < layout.groups[g].outs.length; i++) {
      outputCapacity += layout.groups[g].outs[i].store.getFreeCapacity(activeOrder.product) || 0;
    }
  }

  var maxProducible = Math.min(remaining, outputCapacity);
  var numGroups = layout.groups.length;
  var perGroupTarget = Math.ceil(maxProducible / numGroups);
  var perInputTarget = Math.min(perGroupTarget, LAB_CAPACITY);

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
    if ((creep.store[activeOrder.reag1] || 0) > 0) {
      for (var g = 0; g < layout.groups.length; g++) {
        var group = layout.groups[g];
        var have1 = (group.in1.mineralType === activeOrder.reag1) ? (group.in1.mineralAmount || 0) : 0;
        if (have1 < target) {
          if (creep.pos.isNearTo(group.in1)) {
            var space = group.in1.store.getFreeCapacity(activeOrder.reag1) || 0;
            var amount = Math.min(creep.store[activeOrder.reag1], space);
            if (amount > 0) {
              creep.transfer(group.in1, activeOrder.reag1, amount);
              creep.memory.idleTicks = 0;
              return;
            }
          } else {
            creep.moveTo(group.in1, { range: 1, reusePath: 10 });
            return;
          }
        }
      }
    }

    if ((creep.store[activeOrder.reag2] || 0) > 0) {
      for (var g = 0; g < layout.groups.length; g++) {
        var group = layout.groups[g];
        var have2 = (group.in2.mineralType === activeOrder.reag2) ? (group.in2.mineralAmount || 0) : 0;
        if (have2 < target) {
          if (creep.pos.isNearTo(group.in2)) {
            var space = group.in2.store.getFreeCapacity(activeOrder.reag2) || 0;
            var amount = Math.min(creep.store[activeOrder.reag2], space);
            if (amount > 0) {
              creep.transfer(group.in2, activeOrder.reag2, amount);
              creep.memory.idleTicks = 0;
              return;
            }
          } else {
            creep.moveTo(group.in2, { range: 1, reusePath: 10 });
            return;
          }
        }
      }
    }

    deliverToBest(creep);
    return;
  }

  var needed = findMostNeededInput(layout, activeOrder, target, creep.room);
  if (!needed || needed.deficit <= 0) return;

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var targetReagent = needed.reagent;
  var targetAmount = Math.min(needed.deficit, creep.store.getCapacity());

  var source = null;
  if (terminal && (terminal.store[targetReagent] || 0) >= targetAmount) {
    source = terminal;
  } else if (storage && (storage.store[targetReagent] || 0) >= targetAmount) {
    source = storage;
  } else if (terminal && (terminal.store[targetReagent] || 0) > 0) {
    source = terminal;
    targetAmount = terminal.store[targetReagent];
  } else if (storage && (storage.store[targetReagent] || 0) > 0) {
    source = storage;
    targetAmount = storage.store[targetReagent];
  }

  if (!source) return;

  if (creep.pos.isNearTo(source)) {
    var available = source.store[targetReagent] || 0;
    var takeAmount = Math.min(targetAmount, available, creep.store.getFreeCapacity());
    if (takeAmount > 0) {
      creep.withdraw(source, targetReagent, takeAmount);
      creep.memory.idleTicks = 0;
    }
  } else {
    creep.moveTo(source, { range: 1, reusePath: 10 });
  }
}

/**
 * Handle mid-reaction evacuation - collect from MULTIPLE output labs before delivering
 * Visits nearby labs to fill carry capacity before going to terminal
 */
function handleMidReactionEvacuation(creep, layout, activeOrder) {
  var product = activeOrder.product;
  
  // If carrying product, check if we should collect more or deliver
  if ((creep.store[product] || 0) > 0) {
    var freeCapacity = creep.store.getFreeCapacity();
    
    // If carry is full (or nearly), deliver to terminal
    if (freeCapacity < LAB_REACTION_AMOUNT) {
      deliverProductAndRecord(creep, product);
      return true;
    }
    
    // Check if there's a nearby lab with more product to collect
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
    
    // If a lab is nearby (range <= 3), collect more before delivering
    if (nearestLab && nearestRange <= 3) {
      if (creep.pos.isNearTo(nearestLab)) {
        var takeAmount = Math.min(nearestLab.mineralAmount || 0, freeCapacity);
        creep.withdraw(nearestLab, product, takeAmount);
        creep.memory.idleTicks = 0;
      } else {
        creep.moveTo(nearestLab, { range: 1, reusePath: 5 });
      }
      return true;
    }
    
    // No nearby labs with product, deliver what we have
    deliverProductAndRecord(creep, product);
    return true;
  }
  
  // If carrying anything else, deliver it
  if (creep.store.getUsedCapacity() > 0) {
    deliverToBest(creep);
    return true;
  }
  
  // Empty hands - find nearest output lab with product
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
  
  if (!nearestLab) return false;
  
  if (creep.pos.isNearTo(nearestLab)) {
    var takeAmount = Math.min(nearestLab.mineralAmount || 0, creep.store.getCapacity());
    creep.withdraw(nearestLab, product, takeAmount);
    creep.memory.idleTicks = 0;
    return true;
  } else {
    creep.moveTo(nearestLab, { range: 1, reusePath: 10 });
    return true;
  }
}

function handleProductEvacuationPolicy(creep, layout, activeOrder) {
  if (creep.store.getUsedCapacity() > 0) {
    var product = activeOrder.product;
    if ((creep.store[product] || 0) > 0) {
      deliverProductAndRecord(creep, product);
    } else {
      deliverToBest(creep);
    }
    return;
  }

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];
    
    for (var i = 0; i < group.outs.length; i++) {
      var outLab = group.outs[i];
      if (outLab.mineralType === activeOrder.product && (outLab.mineralAmount || 0) > 0) {
        if (creep.pos.isNearTo(outLab)) {
          var takeAmount = Math.min(outLab.mineralAmount, creep.store.getCapacity());
          creep.withdraw(outLab, activeOrder.product, takeAmount);
          creep.memory.idleTicks = 0;
          return;
        } else {
          creep.moveTo(outLab, { range: 1, reusePath: 10 });
          return;
        }
      }
    }
  }

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];
    
    if ((group.in1.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(group.in1)) {
        var takeAmount = Math.min(group.in1.mineralAmount, creep.store.getCapacity());
        creep.withdraw(group.in1, group.in1.mineralType, takeAmount);
        return;
      } else {
        creep.moveTo(group.in1, { range: 1, reusePath: 10 });
        return;
      }
    }

    if ((group.in2.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(group.in2)) {
        var takeAmount = Math.min(group.in2.mineralAmount, creep.store.getCapacity());
        creep.withdraw(group.in2, group.in2.mineralType, takeAmount);
        return;
      } else {
        creep.moveTo(group.in2, { range: 1, reusePath: 10 });
        return;
      }
    }
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

/**
 * Handle compound delivery and reagent evacuation for breakdown mode
 * KEY BEHAVIOR: Fill all output labs, then IDLE until input labs reach threshold
 */
function handleBreakdownDelivery(creep, layout, activeOrder) {
  var compound = activeOrder.compound;
  var carryCapacity = creep.store.getCapacity();
  
  var remaining = typeof activeOrder.remaining === "number" ? activeOrder.remaining : (activeOrder.amount || 0);
  var totalOutputLabs = countTotalOutputLabs(layout);
  
  var targetPerLab;
  if (remaining < LAB_REACTION_AMOUNT) {
    targetPerLab = 0;
  } else {
    var rawTarget = Math.ceil(remaining / Math.max(totalOutputLabs, 1));
    targetPerLab = Math.max(rawTarget, LAB_REACTION_AMOUNT);
    targetPerLab = Math.min(targetPerLab, LAB_CAPACITY);
  }

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var terminalCompound = (terminal && terminal.store[compound]) || 0;
  var storageCompound = (storage && storage.store[compound]) || 0;
  var compoundInTerminalStorage = terminalCompound + storageCompound;
  
  var allLabs = creep.room.find(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_LAB; }
  });
  
  var compoundInLabs = 0;
  var processableCompoundInLabs = 0;
  
  for (var li = 0; li < allLabs.length; li++) {
    var lab = allLabs[li];
    if (lab.mineralType === compound) {
      var amt = lab.mineralAmount || 0;
      compoundInLabs += amt;
      if (amt >= LAB_REACTION_AMOUNT) {
        processableCompoundInLabs += amt;
      }
    }
  }
  
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

  // =========================================================================
  // HANDLE WHAT WE'RE CARRYING
  // =========================================================================
  
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
            // Track compound delivery to labs for the two-counter system
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

  // =========================================================================
  // EMPTY HANDS - DECIDE WHAT TO PICK UP
  // =========================================================================

  // =========================================================================
  // PRIORITY 0: FINISHING UP - Force evacuate everything
  // =========================================================================
  if (isFinishingUp) {
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

  // =========================================================================
  // PRIORITY 1: Evacuate reagents ONLY when significant amount (>= threshold)
  // This lets reactions run until input labs are well-stocked
  // =========================================================================
  var shouldEvacuateReagents = largestReagentAmount >= REAGENT_EVAC_THRESHOLD || 
                               (largestReagentAmount > 0 && !hasUsableCompound && !processableCompoundInLabs);
  
  if (shouldEvacuateReagents && reagentLabToEvacuate) {
    if (creep.pos.isNearTo(reagentLabToEvacuate.lab)) {
      creep.withdraw(reagentLabToEvacuate.lab, reagentLabToEvacuate.lab.mineralType,
                     Math.min(reagentLabToEvacuate.lab.mineralAmount, carryCapacity));
      creep.memory.idleTicks = 0;
      debugLog("[LabBot " + creep.name + "] evacuating " + reagentLabToEvacuate.lab.mineralType + 
               " (" + reagentLabToEvacuate.lab.mineralAmount + " >= " + REAGENT_EVAC_THRESHOLD + ")");
      return;
    } else {
      creep.moveTo(reagentLabToEvacuate.lab, { range: 1, reusePath: 10 });
      return;
    }
  }

  // =========================================================================
  // PRIORITY 2: Deliver compound if deficit exists and compound available
  // =========================================================================
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

  // =========================================================================
  // PRIORITY 3: Clean up unusable compound amounts (< 5) in labs
  // =========================================================================
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

  // =========================================================================
  // IDLE - Nothing to do right now, reactions are running
  // =========================================================================
  debugLog("[LabBot " + creep.name + "] idle: reagent=" + largestReagentAmount + 
           "/" + REAGENT_EVAC_THRESHOLD + ", compound=" + totalCompoundAnywhere);
  
  // Track idle ticks for suicide decision
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

function handlePreEvacuation(creep, layout, activeOrder) {
  if (creep.store.getUsedCapacity() > 0) {
    deliverToBest(creep);
    return;
  }

  var allLabs = creep.room.find(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_LAB; }
  });

  for (var i = 0; i < allLabs.length; i++) {
    var lab = allLabs[i];
    var mineralAmount = lab.mineralAmount || 0;

    if (mineralAmount > 0) {
      if (creep.pos.isNearTo(lab)) {
        var takeAmount = Math.min(mineralAmount, creep.store.getCapacity());
        creep.withdraw(lab, lab.mineralType, takeAmount);
        creep.memory.idleTicks = 0;
        return;
      } else {
        creep.moveTo(lab, { range: 1, reusePath: 10 });
        return;
      }
    }
  }

  var destIn1 = layout.groups[0].in1;
  if (!creep.pos.inRangeTo(destIn1, 3)) {
    creep.moveTo(destIn1, { range: 3, reusePath: 15 });
  }
}

function handleBreakdownEvacuation(creep, layout, activeOrder) {
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

  for (var g = 0; g < layout.groups.length; g++) {
    var group = layout.groups[g];
    
    if ((group.in1.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(group.in1)) {
        var takeAmount = Math.min(group.in1.mineralAmount, creep.store.getCapacity());
        creep.withdraw(group.in1, group.in1.mineralType, takeAmount);
        creep.memory.idleTicks = 0;
        return;
      } else {
        creep.moveTo(group.in1, { range: 1, reusePath: 10 });
        return;
      }
    }

    if ((group.in2.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(group.in2)) {
        var takeAmount = Math.min(group.in2.mineralAmount, creep.store.getCapacity());
        creep.withdraw(group.in2, group.in2.mineralType, takeAmount);
        creep.memory.idleTicks = 0;
        return;
      } else {
        creep.moveTo(group.in2, { range: 1, reusePath: 10 });
        return;
      }
    }

    for (var i = 0; i < group.outs.length; i++) {
      var outLab = group.outs[i];
      if (outLab.mineralType === activeOrder.compound && (outLab.mineralAmount || 0) > 0) {
        if (creep.pos.isNearTo(outLab)) {
          var takeAmount = Math.min(outLab.mineralAmount, creep.store.getCapacity());
          creep.withdraw(outLab, activeOrder.compound, takeAmount);
          creep.memory.idleTicks = 0;
          return;
        } else {
          creep.moveTo(outLab, { range: 1, reusePath: 10 });
          return;
        }
      }
    }
  }

  var allLabs = creep.room.find(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_LAB; }
  });
  
  for (var j = 0; j < allLabs.length; j++) {
    var lab = allLabs[j];
    if (lab.mineralType === activeOrder.compound && (lab.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(lab)) {
        var takeAmount = Math.min(lab.mineralAmount, creep.store.getCapacity());
        creep.withdraw(lab, activeOrder.compound, takeAmount);
        creep.memory.idleTicks = 0;
        return;
      } else {
        creep.moveTo(lab, { range: 1, reusePath: 10 });
        return;
      }
    }
  }

  if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
    creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
  }
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

    // LOW TTL CHECK
    if (typeof creep.ticksToLive === "number" && creep.ticksToLive < 100 && !creep.memory.suicidePending) {
      requestGracefulSuicide(creep, "low_ttl_" + creep.ticksToLive);
    }

    // GRACEFUL SUICIDE
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

    // NO ACTIVE ORDERS
    var orders = Memory.labOrders || {};
    var roomOrders = orders[creep.room.name];

    if (!roomOrders || !roomOrders.active) {
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }
      if (typeof creep.ticksToLive === "number" && creep.ticksToLive <= 50) {
        requestGracefulSuicide(creep, "idle_no_orders");
        return;
      }
      
      // No orders - suicide quickly to save energy
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

    // Reset idle counter when we have work
    // (will be incremented by specific handlers when idle)

    // GET LAYOUT AND ORDER INFO
    var activeOrder = roomOrders.active;
    var labManager = require('labManager');
    
    var isBreakdown = activeOrder.type === 'breakdown';
    var layout = isBreakdown ? labManager.getBreakdownLayout(creep.room) : labManager.getLayout(creep.room);

    if (!layout || !layout.groups || layout.groups.length === 0) {
      debugLog("[LabBot " + creep.name + "] No valid lab layout found");
      return;
    }

    // PRE-EVACUATION PHASE
    if (activeOrder.needsPreEvacuation) {
      creep.memory.phase = 'pre-evac';
      creep.memory.idleTicks = 0;
      handlePreEvacuation(creep, layout, activeOrder);
      return;
    }

    var remaining = typeof activeOrder.remaining === "number" ? activeOrder.remaining : (activeOrder.amount || 0);
    var shouldEvacuate = (remaining <= 0) || activeOrder.evacuating;

    // EVACUATION PHASE
    if (shouldEvacuate) {
      creep.memory.phase = 'final';
      creep.memory.idleTicks = 0;

      if (isBreakdown) {
        handleBreakdownEvacuation(creep, layout, activeOrder);
      } else {
        if (creep.store.getUsedCapacity() > 0) {
          var product = activeOrder.product;
          if ((creep.store[product] || 0) > 0) {
            deliverProductAndRecord(creep, product);
          } else {
            deliverToBest(creep);
          }
          return;
        }

        var needsCleanup = false;
        var cleanupTarget = null;
        var cleanupResource = null;
        var cleanupAmount = 0;

        for (var g = 0; g < layout.groups.length && !needsCleanup; g++) {
          var group = layout.groups[g];
          
          for (var i = 0; i < group.outs.length; i++) {
            var outLab = group.outs[i];
            if (outLab.mineralType === activeOrder.product && (outLab.mineralAmount || 0) > 0) {
              needsCleanup = true;
              cleanupTarget = outLab;
              cleanupResource = activeOrder.product;
              cleanupAmount = outLab.mineralAmount || 0;
              break;
            }
          }

          if (!needsCleanup) {
            if ((group.in1.mineralAmount || 0) > 0) {
              needsCleanup = true;
              cleanupTarget = group.in1;
              cleanupResource = group.in1.mineralType;
              cleanupAmount = group.in1.mineralAmount || 0;
            } else if ((group.in2.mineralAmount || 0) > 0) {
              needsCleanup = true;
              cleanupTarget = group.in2;
              cleanupResource = group.in2.mineralType;
              cleanupAmount = group.in2.mineralAmount || 0;
            }
          }
        }

        if (needsCleanup && cleanupTarget && cleanupResource) {
          if (creep.pos.isNearTo(cleanupTarget)) {
            var takeAmount = Math.min(cleanupAmount, creep.store.getFreeCapacity());
            creep.withdraw(cleanupTarget, cleanupResource, takeAmount);
          } else {
            creep.moveTo(cleanupTarget, { range: 1, reusePath: 10 });
          }
          return;
        }

        if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
          creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
        }
      }
      return;
    }

    // CLEANUP PHASE
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

    // BUILD PHASE
    creep.memory.phase = 'buildA';

    if (isBreakdown) {
      creep.memory.wantedReagents = activeOrder.compound + " -> " + activeOrder.reag1 + "," + activeOrder.reag2;
      handleBreakdownDelivery(creep, layout, activeOrder);
    } else {
      creep.memory.wantedReagents = activeOrder.reag1 + "," + activeOrder.reag2;

      var carryCapacity = creep.store.getCapacity();
      var target = getPerInputTarget(layout, activeOrder);
      
      // If carrying anything, deposit it first
      if (creep.store.getUsedCapacity() > 0) {
        var product = activeOrder.product;
        if ((creep.store[product] || 0) > 0) {
          deliverProductAndRecord(creep, product);
          return;
        }
        handleReagentDeliveryBalanced(creep, layout, activeOrder, target);
        return;
      }
      
      // Find the largest reagent deficit
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
      
      // Find the largest product amount in output labs
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
      
      // PRODUCTION EVACUATION: Use higher threshold (2000) so we don't constantly shuttle
      var shouldEvacuateProducts = largestProductAmount >= PRODUCTION_EVAC_THRESHOLD;
      
      if (shouldEvacuateProducts) {
        creep.memory.phase = 'mid-evac';
        creep.memory.idleTicks = 0;
        debugLog("[LabBot " + creep.name + "] mid-reaction evacuation: " + largestProductAmount + " " + product + 
                 " (threshold: " + PRODUCTION_EVAC_THRESHOLD + ")");
        handleMidReactionEvacuation(creep, layout, activeOrder);
        return;
      }
      
      // Fallback: evacuate any products if reagents unavailable
      var needsReagentsButCantGet = largestReagentDeficit > 0 && 
                                     !canDeliverReag1Partial && !canDeliverReag2Partial;
      var hasAnyProductToEvacuate = largestProductAmount > 0;
      
      if (needsReagentsButCantGet && hasAnyProductToEvacuate) {
        creep.memory.phase = 'mid-evac';
        creep.memory.idleTicks = 0;
        handleMidReactionEvacuation(creep, layout, activeOrder);
        return;
      }
      
      // IDLE - track for suicide
      if (typeof creep.memory.idleTicks !== 'number') creep.memory.idleTicks = 0;
      creep.memory.idleTicks++;
      
      if (creep.memory.idleTicks >= IDLE_SUICIDE_TICKS) {
        requestGracefulSuicide(creep, "production_idle_" + creep.memory.idleTicks + "_ticks");
        return;
      }
      
      debugLog("[LabBot " + creep.name + "] waiting: reagent deficit=" + largestReagentDeficit + 
               " (reag1 avail=" + reag1Available + ", reag2 avail=" + reag2Available + ")" +
               ", product=" + largestProductAmount + "/" + PRODUCTION_EVAC_THRESHOLD +
               ", idle=" + creep.memory.idleTicks + "/" + IDLE_SUICIDE_TICKS);
      if (layout.groups.length > 0 && !creep.pos.inRangeTo(layout.groups[0].in1, 3)) {
        creep.moveTo(layout.groups[0].in1, { range: 3, reusePath: 15 });
      }
    }
  }
};