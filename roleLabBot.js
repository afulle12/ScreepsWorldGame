// Lab Bot Role
// Handles lab operations including reagent delivery, product evacuation, and cleanup
// Supports balanced reagent delivery and policy-based product management
// Lab Bot Role
// Handles lab operations including reagent delivery, product evacuation, and cleanup
// Supports balanced reagent delivery and policy-based product management

var debugLog = function(message) {
  // Check if lab debugging is enabled globally
  if (Memory.labsDebug) {
    console.log(message);
  }
};

// Deliver product to terminal/storage and record the action
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
      return true;
    } else {
      debugLog("[LabBot " + creep.name + "] Product transfer failed: " + code);
    }
  } else {
    creep.moveTo(target, { range: 1, reusePath: 10 });
  }
  return false;
}

// Deliver any carried resources to the best available target
function deliverToBest(creep) {
  if (creep.store.getUsedCapacity() === 0) return false;

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;
  var target = terminal || storage;

  if (!target) {
    debugLog("[LabBot " + creep.name + "] No terminal or storage for delivery");
    return false;
  }

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

// Get the currently active product type for a room
function getActiveProduct(roomName) {
  var orders = Memory.labOrders || {};
  var roomOrders = orders[roomName];
  if (roomOrders && roomOrders.active && roomOrders.active.product) {
    return roomOrders.active.product;
  }
  return null;
}

// Request graceful suicide for the creep
function requestGracefulSuicide(creep, reason) {
  creep.memory.suicidePending = true;
  debugLog("[LabBot " + creep.name + "] graceful suicide requested — " + reason);
}

// Check if there are blocking materials in the labs
function hasBlockers(layout, activeOrder) {
  var wrongIn1 = layout.in1.mineralType && layout.in1.mineralType !== activeOrder.reag1;
  var wrongIn2 = layout.in2.mineralType && layout.in2.mineralType !== activeOrder.reag2;

  var wrongOuts = false;
  for (var i = 0; i < layout.outs.length; i++) {
    var out = layout.outs[i];
    if (out.mineralType && out.mineralType !== activeOrder.product) {
      wrongOuts = true;
      break;
    }
  }

  return wrongIn1 || wrongIn2 || wrongOuts;
}

// Clear blocking materials from labs
function clearBlockingLabs(creep, layout, activeOrder) {
  // Check input labs first
  if (layout.in1.mineralType && layout.in1.mineralType !== activeOrder.reag1 && (layout.in1.mineralAmount || 0) > 0) {
    if (creep.pos.isNearTo(layout.in1)) {
      var takeAmount = Math.min(layout.in1.mineralAmount, creep.store.getFreeCapacity());
      var code = creep.withdraw(layout.in1, layout.in1.mineralType, takeAmount);
      debugLog("[LabBot " + creep.name + "] clearing blocker from IN1: " + takeAmount + " " + layout.in1.mineralType + " code=" + code);
      return true;
    } else {
      creep.moveTo(layout.in1, { range: 1, reusePath: 10 });
      return true;
    }
  }

  if (layout.in2.mineralType && layout.in2.mineralType !== activeOrder.reag2 && (layout.in2.mineralAmount || 0) > 0) {
    if (creep.pos.isNearTo(layout.in2)) {
      var takeAmount = Math.min(layout.in2.mineralAmount, creep.store.getFreeCapacity());
      var code = creep.withdraw(layout.in2, layout.in2.mineralType, takeAmount);
      debugLog("[LabBot " + creep.name + "] clearing blocker from IN2: " + takeAmount + " " + layout.in2.mineralType + " code=" + code);
      return true;
    } else {
      creep.moveTo(layout.in2, { range: 1, reusePath: 10 });
      return true;
    }
  }

  // Check output labs
  for (var i = 0; i < layout.outs.length; i++) {
    var out = layout.outs[i];
    if (out.mineralType && out.mineralType !== activeOrder.product && (out.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(out)) {
        var takeAmount = Math.min(out.mineralAmount, creep.store.getFreeCapacity());
        var code = creep.withdraw(out, out.mineralType, takeAmount);
        debugLog("[LabBot " + creep.name + "] clearing blocker from OUT" + i + ": " + takeAmount + " " + out.mineralType + " code=" + code);
        return true;
      } else {
        creep.moveTo(out, { range: 1, reusePath: 10 });
        return true;
      }
    }
  }

  return false; // No blockers found or cleared
}

// Calculate per-input target based on remaining production needs
function getPerInputTarget(layout, activeOrder) {
  var remaining = typeof activeOrder.remaining === "number" ? activeOrder.remaining : (activeOrder.amount || 0);
  if (remaining <= 0) return 0;

  var outputCapacity = 0;
  for (var i = 0; i < layout.outs.length; i++) {
    outputCapacity += layout.outs[i].store.getFreeCapacity(activeOrder.product) || 0;
  }

  var maxProducible = Math.min(remaining, outputCapacity);
  var perInputTarget = Math.min(maxProducible, 1000); // Cap at 1000 per input

  return Math.max(perInputTarget, 0);
}

// Handle balanced reagent delivery to input labs
function handleReagentDeliveryBalanced(creep, layout, activeOrder, target) {
  // If carrying anything, try to deposit it first
  if (creep.store.getUsedCapacity() > 0) {
    var deposited = false;

    // Try to deposit reagent 1
    if ((creep.store[activeOrder.reag1] || 0) > 0) {
      if (creep.pos.isNearTo(layout.in1)) {
        var space1 = layout.in1.store.getFreeCapacity(activeOrder.reag1) || 0;
        var amount1 = Math.min(creep.store[activeOrder.reag1], space1);
        if (amount1 > 0) {
          var code1 = creep.transfer(layout.in1, activeOrder.reag1, amount1);
          if (code1 === OK) {
            debugLog("[LabBot " + creep.name + "] delivered " + amount1 + " " + activeOrder.reag1 + " to IN1");
            deposited = true;
          }
        }
      } else {
        creep.moveTo(layout.in1, { range: 1, reusePath: 10 });
        return;
      }
    }

    // Try to deposit reagent 2
    if (!deposited && (creep.store[activeOrder.reag2] || 0) > 0) {
      if (creep.pos.isNearTo(layout.in2)) {
        var space2 = layout.in2.store.getFreeCapacity(activeOrder.reag2) || 0;
        var amount2 = Math.min(creep.store[activeOrder.reag2], space2);
        if (amount2 > 0) {
          var code2 = creep.transfer(layout.in2, activeOrder.reag2, amount2);
          if (code2 === OK) {
            debugLog("[LabBot " + creep.name + "] delivered " + amount2 + " " + activeOrder.reag2 + " to IN2");
            deposited = true;
          }
        }
      } else {
        creep.moveTo(layout.in2, { range: 1, reusePath: 10 });
        return;
      }
    }

    // If carrying other stuff, deposit it
    if (!deposited) {
      deliverToBest(creep);
      return;
    }

    if (deposited) return; // Successfully deposited something
  }

  // Determine what to pick up
  var have1 = (layout.in1.mineralType === activeOrder.reag1) ? (layout.in1.mineralAmount || 0) : 0;
  var have2 = (layout.in2.mineralType === activeOrder.reag2) ? (layout.in2.mineralAmount || 0) : 0;
  var def1 = Math.max(0, target - have1);
  var def2 = Math.max(0, target - have2);

  if (def1 <= 0 && def2 <= 0) return; // Both inputs are satisfied

  var terminal = creep.room.terminal;
  var storage = creep.room.storage;

  // Prioritize the reagent with higher deficit
  var targetReagent, targetAmount;
  if (def1 >= def2 && def1 > 0) {
    targetReagent = activeOrder.reag1;
    targetAmount = Math.min(def1, creep.store.getCapacity());
  } else if (def2 > 0) {
    targetReagent = activeOrder.reag2;
    targetAmount = Math.min(def2, creep.store.getCapacity());
  } else {
    return; // Nothing needed
  }

  // Try to get the reagent from terminal first, then storage
  var source = null;
  if (terminal && (terminal.store[targetReagent] || 0) >= targetAmount) {
    source = terminal;
  } else if (storage && (storage.store[targetReagent] || 0) >= targetAmount) {
    source = storage;
  }

  if (!source) {
    debugLog("[LabBot " + creep.name + "] No source for " + targetAmount + " " + targetReagent);
    return;
  }

  if (creep.pos.isNearTo(source)) {
    var available = source.store[targetReagent] || 0;
    var takeAmount = Math.min(targetAmount, available, creep.store.getFreeCapacity());
    if (takeAmount > 0) {
      var code = creep.withdraw(source, targetReagent, takeAmount);
      debugLog("[LabBot " + creep.name + "] withdrew " + takeAmount + " " + targetReagent + " code=" + code);
    }
  } else {
    creep.moveTo(source, { range: 1, reusePath: 10 });
  }
}

// Handle product evacuation with policy management
function handleProductEvacuationPolicy(creep, layout, activeOrder) {
  // If carrying anything, deposit it first
  if (creep.store.getUsedCapacity() > 0) {
    var product = activeOrder.product;
    if ((creep.store[product] || 0) > 0) {
      deliverProductAndRecord(creep, product);
    } else {
      deliverToBest(creep);
    }
    return;
  }

  // Look for product in output labs
  for (var i = 0; i < layout.outs.length; i++) {
    var outLab = layout.outs[i];
    if (outLab.mineralType === activeOrder.product && (outLab.mineralAmount || 0) > 0) {
      if (creep.pos.isNearTo(outLab)) {
        var takeAmount = Math.min(outLab.mineralAmount, creep.store.getCapacity());
        var code = creep.withdraw(outLab, activeOrder.product, takeAmount);
        debugLog("[LabBot " + creep.name + "] evacuating " + takeAmount + " " + activeOrder.product + " from OUT" + i + " code=" + code);
        return;
      } else {
        creep.moveTo(outLab, { range: 1, reusePath: 10 });
        return;
      }
    }
  }

  // No product found in outputs, check for reagents in inputs that need cleanup
  if ((layout.in1.mineralAmount || 0) > 0) {
    if (creep.pos.isNearTo(layout.in1)) {
      var takeAmount = Math.min(layout.in1.mineralAmount, creep.store.getCapacity());
      var code = creep.withdraw(layout.in1, layout.in1.mineralType, takeAmount);
      debugLog("[LabBot " + creep.name + "] cleaning up " + takeAmount + " " + layout.in1.mineralType + " from IN1 code=" + code);
      return;
    } else {
      creep.moveTo(layout.in1, { range: 1, reusePath: 10 });
      return;
    }
  }

  if ((layout.in2.mineralAmount || 0) > 0) {
    if (creep.pos.isNearTo(layout.in2)) {
      var takeAmount = Math.min(layout.in2.mineralAmount, creep.store.getCapacity());
      var code = creep.withdraw(layout.in2, layout.in2.mineralType, takeAmount);
      debugLog("[LabBot " + creep.name + "] cleaning up " + takeAmount + " " + layout.in2.mineralType + " from IN2 code=" + code);
      return;
    } else {
      creep.moveTo(layout.in2, { range: 1, reusePath: 10 });
      return;
    }
  }

  // If no cleanup needed, just idle near labs
  if (!creep.pos.inRangeTo(layout.in1, 3)) {
    creep.moveTo(layout.in1, { range: 3, reusePath: 15 });
  }
}

module.exports = {
  run: function(creep) {
    // Phase logging
    if (creep.memory.phase) {
      var carryInfo = "";
      for (var resource in creep.store) {
        if (creep.store[resource] > 0) {
          carryInfo += resource + ":" + creep.store[resource] + " ";
        }
      }
      debugLog("[LabBot " + creep.name + "] phase=" + creep.memory.phase +
               " want=(" + (creep.memory.wantedReagents || "unknown") + ") " +
               "carry=" + carryInfo.trim());
    }

    // Deposit action logging (one-shot)
    if (creep.memory.lastAction === 'deposit') {
      debugLog("[LabBot " + creep.name + "] depositOne(" + (creep.memory.lastResource || "undefined") + ") " +
               "reason=" + (creep.memory.depositReason || "unknown"));
      creep.memory.lastAction = null;
      creep.memory.lastResource = null;
      creep.memory.depositReason = null;
    }

    // If a graceful suicide is pending, do only deposit until empty, then suicide
    if (creep.memory.suicidePending) {
      var productTypePending = getActiveProduct(creep.room.name);
      if (creep.store.getUsedCapacity() > 0) {
        if (productTypePending && (creep.store[productTypePending] || 0) > 0) {
          deliverProductAndRecord(creep, productTypePending);
        } else {
          deliverToBest(creep);
        }
      } else {
        debugLog("[LabBot " + creep.name + "] graceful suicide — inventory empty");
        creep.suicide();
      }
      return;
    }

    var orders = Memory.labOrders || {};
    var roomOrders = orders[creep.room.name];

    // No active orders path (graceful suicide at low TTL)
    if (!roomOrders || !roomOrders.active) {
      if (creep.store.getUsedCapacity() > 0) {
        deliverToBest(creep);
        return;
      }

      if (typeof creep.ticksToLive === "number" && creep.ticksToLive <= 50) {
        requestGracefulSuicide(creep, "idle_no_orders");
        return;
      }

      var storage = creep.room.storage;
      if (storage && !creep.pos.inRangeTo(storage, 3)) {
        creep.moveTo(storage, { range: 3, reusePath: 20 });
      }
      return;
    }

    var activeOrder = roomOrders.active;
    var manager = require('labManager');
    var layout = manager.getLayout(creep.room);
    if (!layout) {
      debugLog("[LabBot " + creep.name + "] No valid lab layout found");
      return;
    }

    // Check if we should be in evacuation mode
    var remaining = typeof activeOrder.remaining === "number" ? activeOrder.remaining : (activeOrder.amount || 0);
    var shouldEvacuate = (remaining <= 0) || activeOrder.evacuating;

    // If we should evacuate, clean up everything and complete the order
    if (shouldEvacuate) {
      creep.memory.phase = 'final';

      // If carrying anything, deposit it first
      if (creep.store.getUsedCapacity() > 0) {
        var product = activeOrder.product;
        if ((creep.store[product] || 0) > 0) {
          deliverProductAndRecord(creep, product);
        } else {
          deliverToBest(creep);
        }
        return;
      }

      // Check if there's anything left in any lab that needs cleanup
      var needsCleanup = false;
      var cleanupTarget = null;
      var cleanupResource = null;
      var cleanupAmount = 0;

      // Check output labs for any remaining product
      for (var i = 0; i < layout.outs.length; i++) {
        var outLab = layout.outs[i];
        if (outLab.mineralType === activeOrder.product && (outLab.mineralAmount || 0) > 0) {
          needsCleanup = true;
          cleanupTarget = outLab;
          cleanupResource = activeOrder.product;
          cleanupAmount = outLab.mineralAmount || 0;
          break;
        }
      }

      // If no product in outputs, check input labs for reagents
      if (!needsCleanup) {
        if ((layout.in1.mineralAmount || 0) > 0) {
          needsCleanup = true;
          cleanupTarget = layout.in1;
          cleanupResource = layout.in1.mineralType;
          cleanupAmount = layout.in1.mineralAmount || 0;
        } else if ((layout.in2.mineralAmount || 0) > 0) {
          needsCleanup = true;
          cleanupTarget = layout.in2;
          cleanupResource = layout.in2.mineralType;
          cleanupAmount = layout.in2.mineralAmount || 0;
        }
      }

      if (needsCleanup && cleanupTarget && cleanupResource) {
        debugLog("[LabBot " + creep.name + "] final cleanup: " + cleanupAmount + " " + cleanupResource + " from " + cleanupTarget.id);
        if (creep.pos.isNearTo(cleanupTarget)) {
          var takeAmount = Math.min(cleanupAmount, creep.store.getFreeCapacity());
          var code = creep.withdraw(cleanupTarget, cleanupResource, takeAmount);
          debugLog("[LabBot " + creep.name + "] final cleanup withdraw: " + takeAmount + " " + cleanupResource + " code=" + code);
        } else {
          creep.moveTo(cleanupTarget, { range: 1, reusePath: 10 });
        }
        return;
      }

      // If no cleanup needed, just idle near labs
      if (!creep.pos.inRangeTo(layout.in1, 3)) {
        creep.moveTo(layout.in1, { range: 3, reusePath: 15 });
      }
      return;
    }

    // Enter cleanup ONLY if there is an actual blocker (wrong minerals)
    if (hasBlockers(layout, activeOrder)) {
      creep.memory.phase = 'cleanup';
      if (clearBlockingLabs(creep, layout, activeOrder)) {
        return; // performed a blocker cleanup action this tick
      }
      // Fall through to build if nothing else to do
    }

    // Fill input labs to balanced per-input target (output-aware)
    creep.memory.phase = 'buildA';
    creep.memory.wantedReagents = activeOrder.reag1 + "," + activeOrder.reag2;

    var target = getPerInputTarget(layout, activeOrder);
    var have1 = (layout.in1.mineralType === activeOrder.reag1) ? (layout.in1.mineralAmount || 0) : 0;
    var have2 = (layout.in2.mineralType === activeOrder.reag2) ? (layout.in2.mineralAmount || 0) : 0;
    var def1 = Math.max(0, target - have1);
    var def2 = Math.max(0, target - have2);

    if (def1 > 0 || def2 > 0 || creep.store.getUsedCapacity() > 0) {
      handleReagentDeliveryBalanced(creep, layout, activeOrder, target);
      return;
    }

    // Product evacuation (policy-managed)
    creep.memory.phase = 'final';
    handleProductEvacuationPolicy(creep, layout, activeOrder);
  }
};
