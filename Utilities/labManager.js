/**
 * =============================================================================
 * LAB MANAGER MODULE - Screeps Lab Automation System (Multi-Group Edition)
 * =============================================================================
 */

// showAllLabs()
// Console diagnostic commands:
// labsDiagnoseRoom('E2N46')            Exact room state: active order, queue length, labsNeedWork() result, every labbot found in that room, and whether the order is stuck in pre-evacuation or evacuation.
// labsDiagnoseBots()                   Global census of every creep with labbot in its role, its current room, phase, idle ticks, and suicide flag.
// labsClearBotMemory('LabBot_E2N46_1') Hard-resets a stuck bot's memory so the role script starts fresh without waiting for a respawn.
// cancelLabs('E9N49') Clears lab orders in a room
// Paste this block inside your labManager.js installConsole() function, for example right after global.labsStats.

var labManager = (function() {
  var LAYOUT_VALIDATION_INTERVAL = 50;
  var MANAGER_RUN_INTERVAL = 3;
  var LAB_REACTION_AMOUNT = 5;

  var layoutCache = {};
  var breakdownLayoutCache = {};
  var cacheValidUntil = 0;

  function debugLog(message) {
    if (!Memory.labManager) Memory.labManager = {};
    if (Memory.labManager.debug) {
      console.log(message);
    }
  }

  function ensureOrdersRoot() {
    if (!Memory.labOrders) Memory.labOrders = {};
  }

  function ensureRoomOrders(roomName) {
    ensureOrdersRoot();
    if (!Memory.labOrders[roomName]) {
      Memory.labOrders[roomName] = { active: null, queue: [] };
    }
    return Memory.labOrders[roomName];
  }

  function ensureLayoutRoot() {
    if (!Memory.labLayout) Memory.labLayout = {};
  }

  function ensureManagerRoot() {
    if (!Memory.labManager) Memory.labManager = {};
  }

  function getCachedLayout(roomName) {
    if (Game.time > cacheValidUntil) {
      layoutCache = {};
      breakdownLayoutCache = {};
      cacheValidUntil = Game.time + 10;
    }
    return layoutCache[roomName];
  }

  function getCachedBreakdownLayout(roomName) {
    if (Game.time > cacheValidUntil) {
      layoutCache = {};
      breakdownLayoutCache = {};
      cacheValidUntil = Game.time + 10;
    }
    return breakdownLayoutCache[roomName];
  }

  function setCachedLayout(roomName, layout) {
    layoutCache[roomName] = layout;
  }

  function setCachedBreakdownLayout(roomName, layout) {
    breakdownLayoutCache[roomName] = layout;
  }

  function clearRoomCache(roomName, fullClear) {
    delete layoutCache[roomName];
    delete breakdownLayoutCache[roomName];
    if (Memory.labLayout && Memory.labLayout[roomName]) {
      if (fullClear) {
        delete Memory.labLayout[roomName];
      } else {
        delete Memory.labLayout[roomName].validated;
        delete Memory.labLayout[roomName].breakdownValidated;
      }
    }
  }

  function validateStoredLayout(room, m) {
    if (!m) return null;
    if (!m.groups || m.groups.length === 0) return null;

    if (m.validated && (Game.time - m.validated) < LAYOUT_VALIDATION_INTERVAL) {
      var cached = getCachedLayout(room.name);
      if (cached) return cached;
    }

    var validGroups = [];

    for (var g = 0; g < m.groups.length; g++) {
      var group = m.groups[g];
      if (!group.in1Id || !group.in2Id || !group.outIds || group.outIds.length === 0) {
        continue;
      }

      var in1 = Game.getObjectById(group.in1Id);
      var in2 = Game.getObjectById(group.in2Id);
      if (!in1 || !in2) continue;

      var outs = [];
      for (var i = 0; i < group.outIds.length; i++) {
        var o = Game.getObjectById(group.outIds[i]);
        if (!o) continue;
        if (in1.pos.inRangeTo(o, 2) && in2.pos.inRangeTo(o, 2)) {
          outs.push(o);
        }
      }

      if (outs.length > 0) {
        validGroups.push({ in1: in1, in2: in2, outs: outs });
      }
    }

    if (validGroups.length === 0) return null;

    m.validated = Game.time;
    var layout = { groups: validGroups };
    setCachedLayout(room.name, layout);
    return layout;
  }

  function computeBestLayout(room) {
    var labs = room._labsCache;
    if (!labs || room._labsCacheTime !== Game.time) {
      labs = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
      });
      room._labsCache = labs;
      room._labsCacheTime = Game.time;
    }

    if (!labs || labs.length < 3) return null;

    var usedLabIds = new Set();
    var groups = [];

    var maxIterations = Math.floor(labs.length / 3);

    for (var iter = 0; iter < maxIterations; iter++) {
      var bestIn1 = null;
      var bestIn2 = null;
      var bestOuts = [];

      for (var i = 0; i < labs.length; i++) {
        if (usedLabIds.has(labs[i].id)) continue;

        for (var j = i + 1; j < labs.length; j++) {
          if (usedLabIds.has(labs[j].id)) continue;

          var a = labs[i];
          var b = labs[j];

          var outs = [];
          for (var k = 0; k < labs.length; k++) {
            if (k === i || k === j) continue;
            if (usedLabIds.has(labs[k].id)) continue;

            var l = labs[k];
            if (a.pos.inRangeTo(l, 2) && b.pos.inRangeTo(l, 2)) {
              outs.push(l);
            }
          }

          if (outs.length > bestOuts.length) {
            bestIn1 = a;
            bestIn2 = b;
            bestOuts = outs;
          }
        }
      }

      if (bestIn1 && bestIn2 && bestOuts.length > 0) {
        groups.push({
          in1: bestIn1,
          in2: bestIn2,
          outs: bestOuts
        });

        usedLabIds.add(bestIn1.id);
        usedLabIds.add(bestIn2.id);
        for (var o = 0; o < bestOuts.length; o++) {
          usedLabIds.add(bestOuts[o].id);
        }

        debugLog("[Labs] Found group " + groups.length + ": in1=" + bestIn1.id.substr(-4) + 
                 " in2=" + bestIn2.id.substr(-4) + " outs=" + bestOuts.length);
      } else {
        break;
      }
    }

    if (groups.length === 0) return null;

    var hasActiveOrder = Memory.labOrders && Memory.labOrders[room.name] && Memory.labOrders[room.name].active;
    if (hasActiveOrder) {
      ensureLayoutRoot();
      var memGroups = [];
      for (var g = 0; g < groups.length; g++) {
        memGroups.push({
          in1Id: groups[g].in1.id,
          in2Id: groups[g].in2.id,
          outIds: groups[g].outs.map(function(o) { return o.id; })
        });
      }
      Memory.labLayout[room.name] = {
        groups: memGroups,
        validated: Game.time
      };
    }

    var layout = { groups: groups };
    setCachedLayout(room.name, layout);

    var totalOuts = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      totalOuts += groups[gi].outs.length;
    }
    debugLog("[Labs] Computed layout for " + room.name + ": " + groups.length + 
             " groups, " + (groups.length * 2) + " inputs, " + totalOuts + " outputs");

    return layout;
  }

  function resolveLayout(room) {
    var cached = getCachedLayout(room.name);
    if (cached) return cached;

    ensureLayoutRoot();
    var stored = Memory.labLayout[room.name];
    var valid = validateStoredLayout(room, stored);
    if (valid) return valid;

    return computeBestLayout(room);
  }

  function getLayout(room) {
    return resolveLayout(room);
  }

  function computeBreakdownLayout(room) {
    var cached = getCachedBreakdownLayout(room.name);
    if (cached) return cached;

    ensureLayoutRoot();
    var stored = Memory.labLayout[room.name];
    if (stored && stored.breakdownIn1Id && stored.breakdownIn2Id && stored.breakdownOutIds) {
      if (stored.breakdownValidated && (Game.time - stored.breakdownValidated) < LAYOUT_VALIDATION_INTERVAL) {
        var in1 = Game.getObjectById(stored.breakdownIn1Id);
        var in2 = Game.getObjectById(stored.breakdownIn2Id);
        if (in1 && in2) {
          var outs = [];
          for (var i = 0; i < stored.breakdownOutIds.length; i++) {
            var o = Game.getObjectById(stored.breakdownOutIds[i]);
            if (o) outs.push(o);
          }
          if (outs.length > 0) {
            var layout = { groups: [{ in1: in1, in2: in2, outs: outs }] };
            setCachedBreakdownLayout(room.name, layout);
            return layout;
          }
        }
      }
    }

    var labs = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });

    if (!labs || labs.length < 3) return null;

    var bestIn1 = null;
    var bestIn2 = null;
    var bestOuts = [];

    for (var i = 0; i < labs.length; i++) {
      for (var j = i + 1; j < labs.length; j++) {
        var a = labs[i];
        var b = labs[j];

        var outs = [];
        for (var k = 0; k < labs.length; k++) {
          if (k === i || k === j) continue;
          var l = labs[k];
          if (a.pos.inRangeTo(l, 2) && b.pos.inRangeTo(l, 2)) {
            outs.push(l);
          }
        }

        if (outs.length > bestOuts.length) {
          bestIn1 = a;
          bestIn2 = b;
          bestOuts = outs;
        }
      }
    }

    if (!bestIn1 || !bestIn2 || bestOuts.length === 0) return null;

    var hasActiveOrder = Memory.labOrders && Memory.labOrders[room.name] && Memory.labOrders[room.name].active;
    if (hasActiveOrder) {
      if (!Memory.labLayout[room.name]) {
        Memory.labLayout[room.name] = {};
      }
      Memory.labLayout[room.name].breakdownIn1Id = bestIn1.id;
      Memory.labLayout[room.name].breakdownIn2Id = bestIn2.id;
      Memory.labLayout[room.name].breakdownOutIds = bestOuts.map(function(o) { return o.id; });
      Memory.labLayout[room.name].breakdownValidated = Game.time;
    }

    var layout = { groups: [{ in1: bestIn1, in2: bestIn2, outs: bestOuts }] };
    setCachedBreakdownLayout(room.name, layout);
    return layout;
  }

  function getBreakdownLayout(room) {
    return computeBreakdownLayout(room);
  }

  // ===========================================================================
  // REACTION HELPERS
  // ===========================================================================

  function findDirectReagents(product) {
    for (var left in REACTIONS) {
      var row = REACTIONS[left];
      for (var right in row) {
        if (row[right] === product) {
          return { a: left, b: right };
        }
      }
    }
    return null;
  }

  function buildReactionChain(product, room) {
    var chain = [];
    var visited = new Set();

    function addToChain(target) {
      if (visited.has(target)) return;
      visited.add(target);

      var reagents = findDirectReagents(target);
      if (!reagents) return;

      var storage = room.storage;
      var terminal = room.terminal;
      var needA = true;
      var needB = true;

      if (storage || terminal) {
        var availA = ((storage && storage.store[reagents.a]) || 0) + 
                     ((terminal && terminal.store[reagents.a]) || 0);
        var availB = ((storage && storage.store[reagents.b]) || 0) + 
                     ((terminal && terminal.store[reagents.b]) || 0);

        needA = availA < 1000;
        needB = availB < 1000;
      }

      if (needA) addToChain(reagents.a);
      if (needB) addToChain(reagents.b);

      chain.push({
        product: target,
        reag1: reagents.a,
        reag2: reagents.b,
        priority: chain.length
      });
    }

    addToChain(product);
    return chain.reverse();
  }

  // ===========================================================================
  // ORDER MANAGEMENT - PRODUCTION
  // ===========================================================================

  function startOrder(roomName, product, amount) {
    var rm = ensureRoomOrders(roomName);
    var room = Game.rooms[roomName];

    if (!room) {
      return { ok: false, msg: "[Labs] No vision in room " + roomName };
    }

    var chain = buildReactionChain(product, room);
    if (chain.length === 0) {
      return { ok: false, msg: "[Labs] Cannot produce " + product + " - no reaction found" };
    }

    var orders = [];
    for (var i = 0; i < chain.length; i++) {
      var step = chain[i];
      var stepAmount = (step.product === product) ? amount : Math.ceil(amount * 1.2);

      orders.push({
        type: 'production',
        product: step.product,
        amount: stepAmount,
        remaining: stepAmount,
        reag1: step.reag1,
        reag2: step.reag2,
        created: Game.time,
        priority: step.priority,
        needsPreEvacuation: (i === 0)
      });
    }

    clearRoomCache(roomName);

    if (!rm.active) {
      rm.active = orders.shift();
      rm.active.needsPreEvacuation = true;
      rm.queue = orders;
      return { ok: true, msg: "[Labs] Started reaction chain for " + product + " x" + amount + " (" + (orders.length + 1) + " steps)" };
    } else {
      rm.queue = rm.queue.concat(orders);
      return { ok: true, msg: "[Labs] Queued reaction chain for " + product + " x" + amount + " (" + orders.length + " steps)" };
    }
  }

  // ===========================================================================
  // ORDER MANAGEMENT - BREAKDOWN
  // ===========================================================================

  function startBreakdownOrder(roomName, compound, amount) {
    var rm = ensureRoomOrders(roomName);
    var room = Game.rooms[roomName];

    if (!room) {
      return { ok: false, msg: "[Labs] No vision in room " + roomName };
    }

    var reagents = findDirectReagents(compound);
    if (!reagents) {
      return { ok: false, msg: "[Labs] Cannot break down " + compound + " - not a compound (base mineral?)" };
    }

    var storage = room.storage;
    var terminal = room.terminal;
    var available = ((storage && storage.store[compound]) || 0) + 
                    ((terminal && terminal.store[compound]) || 0);

    if (available < amount) {
      debugLog("[Labs] Warning: Only " + available + " " + compound + " available, requested " + amount);
    }

    var order = {
      type: 'breakdown',
      compound: compound,
      amount: amount,
      remaining: amount,           // Tracks compound remaining to deliver to output labs
      compoundDelivered: 0,        // Tracks compound actually delivered to output labs
      reag1: reagents.a,
      reag2: reagents.b,
      created: Game.time,
      evacuating: false,
      needsPreEvacuation: true
    };

    clearRoomCache(roomName);

    if (!rm.active) {
      rm.active = order;
      return { ok: true, msg: "[Labs] Started breakdown of " + compound + " x" + amount + " -> " + reagents.a + " + " + reagents.b };
    } else {
      rm.queue.push(order);
      return { ok: true, msg: "[Labs] Queued breakdown of " + compound + " x" + amount };
    }
  }

  // ===========================================================================
  // ORDER COMPLETION
  // ===========================================================================

  function maybeCompleteOrder(roomName) {
    var rm = ensureRoomOrders(roomName);
    if (!rm.active) return;

    var room = Game.rooms[roomName];
    if (!room) return;

    // =====================================================================
    // CLEANUP ORDER: complete as soon as pre-evac finishes (all labs empty)
    // =====================================================================
    if (rm.active.type === 'cleanup') {
      if (!rm.active.needsPreEvacuation) {
        debugLog("[Labs] Cleanup complete in " + roomName);
        rm.active = null;
        clearRoomCache(roomName);

        if (rm.queue.length > 0) {
          rm.active = rm.queue.shift();
          rm.active.needsPreEvacuation = true;
          var nextDesc = rm.active.type === 'breakdown' ? rm.active.compound
                       : rm.active.type === 'cleanup'   ? 'cleanup'
                       : rm.active.product;
          debugLog("[Labs] Started next order: " + rm.active.type + " " + nextDesc);
        }
      }
      return;
    }

    var isBreakdown = rm.active.type === 'breakdown';

    var layout = isBreakdown ? computeBreakdownLayout(room) : resolveLayout(room);

    var allLabs = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });

    // =====================================================================
    // CHECK IF ALL LABS ARE EMPTY (shared helper for both types)
    // =====================================================================
    function checkLabsEmpty() {
      for (var li = 0; li < allLabs.length; li++) {
        if ((allLabs[li].mineralAmount || 0) > 0) return false;
      }
      return true;
    }

    if (isBreakdown) {
      var storage = room.storage;
      var terminal = room.terminal;
      var compoundInStorage = (storage && storage.store[rm.active.compound]) || 0;
      var compoundInTerminal = (terminal && terminal.store[rm.active.compound]) || 0;
      var compoundInTerminalStorage = compoundInStorage + compoundInTerminal;

      var compoundInLabs = 0;
      var processableCompoundInLabs = 0;
      var totalReagentsInInputs = 0;

      for (var k = 0; k < allLabs.length; k++) {
        if (allLabs[k].mineralType === rm.active.compound) {
          var amt = allLabs[k].mineralAmount || 0;
          compoundInLabs += amt;
          if (amt >= LAB_REACTION_AMOUNT) {
            processableCompoundInLabs += amt;
          }
        }
      }

      if (layout && layout.groups) {
        for (var g = 0; g < layout.groups.length; g++) {
          var group = layout.groups[g];
          totalReagentsInInputs += (group.in1.mineralAmount || 0);
          totalReagentsInInputs += (group.in2.mineralAmount || 0);
        }
      }

      var totalCompoundAnywhere = compoundInTerminalStorage + compoundInLabs;
      var labsEmpty = checkLabsEmpty();

      // -----------------------------------------------------------------
      // FIX: If evacuating and labs are empty, complete the order
      // even if compound still exists in terminal/storage (unprocessed)
      // -----------------------------------------------------------------
      if (rm.active.evacuating && labsEmpty) {
        // Check if compound was never actually processed
        if (compoundInTerminalStorage >= LAB_REACTION_AMOUNT && compoundInLabs === 0 && totalReagentsInInputs === 0) {
          // Compound was never loaded into labs - this order failed
          debugLog("[Labs] Breakdown aborted: compound never processed, " + 
                   compoundInTerminalStorage + " still in terminal/storage");
          rm.active = null;
          clearRoomCache(roomName);
          if (rm.queue.length > 0) {
            rm.active = rm.queue.shift();
            rm.active.needsPreEvacuation = true;
          }
          return;
        }

        // Evacuation is truly complete
        debugLog("[Labs] Breakdown fully complete: " + rm.active.compound + " in " + roomName +
                 " (reagents: " + totalReagentsInInputs + ")");
        rm.active = null;
        clearRoomCache(roomName);

        if (rm.queue.length > 0) {
          rm.active = rm.queue.shift();
          rm.active.needsPreEvacuation = true;
          var nextDesc = rm.active.type === 'breakdown' ? rm.active.compound : rm.active.product;
          debugLog("[Labs] Started next order: " + rm.active.type + " " + nextDesc);
        } else {
          debugLog("[Labs] Completed all lab orders in " + roomName);
        }
        return;
      }

      // -----------------------------------------------------------------
      // FIX: If evacuating is true but compound is still waiting to be
      // processed (in terminal, not in labs), don't clear the order
      // but also don't force the labbot to keep spawning endlessly
      // -----------------------------------------------------------------
      var compoundStillWaiting = compoundInTerminalStorage >= LAB_REACTION_AMOUNT && 
                                  compoundInLabs === 0 && 
                                  totalReagentsInInputs < LAB_REACTION_AMOUNT &&
                                  !rm.active.evacuating;

      // Don't return early - let the labbot do its work
      if (!compoundStillWaiting) {
        // Fast path: absolutely nothing left anywhere
        if (totalCompoundAnywhere === 0 && totalReagentsInInputs < LAB_REACTION_AMOUNT) {
          debugLog("[Labs] Breakdown order complete - no compound or reagents remain anywhere.");
          rm.active = null;
          clearRoomCache(roomName);

          if (rm.queue.length > 0) {
            rm.active = rm.queue.shift();
            rm.active.needsPreEvacuation = true;
            var nextDesc = rm.active.type === 'breakdown' ? rm.active.compound : rm.active.product;
            debugLog("[Labs] Started next order: " + rm.active.type + " " + nextDesc);
          }
          return;
        }

        // Once evacuating=true, delivery is done by definition
        var deliveryComplete = rm.active.evacuating ||
                               (rm.active.remaining <= 0) ||
                               (compoundInTerminalStorage < LAB_REACTION_AMOUNT);
        var reactionsComplete = processableCompoundInLabs === 0;
        var evacuationComplete = totalReagentsInInputs < LAB_REACTION_AMOUNT;

        if (deliveryComplete && reactionsComplete && evacuationComplete) {
          debugLog("[Labs] Breakdown fully complete: " + rm.active.compound + " in " + roomName +
                   " (compound remaining: " + totalCompoundAnywhere + ", reagents: " + totalReagentsInInputs + ")");
          rm.active = null;
          clearRoomCache(roomName);

          if (rm.queue.length > 0) {
            rm.active = rm.queue.shift();
            rm.active.needsPreEvacuation = true;
            var nextDesc = rm.active.type === 'breakdown' ? rm.active.compound : rm.active.product;
            debugLog("[Labs] Started next order: " + rm.active.type + " " + nextDesc);
          } else {
            debugLog("[Labs] Completed all lab orders in " + roomName);
          }
          return;
        }

        if (deliveryComplete && reactionsComplete && !evacuationComplete) {
          if (!rm.active.evacuating) {
            rm.active.evacuating = true;
            debugLog("[Labs] Breakdown: delivery & reactions complete, entering evacuation phase (" + totalReagentsInInputs + " reagents remaining)");
          }
        }
      }

    } else {
      // =====================================================================
      // PRODUCTION COMPLETION
      // =====================================================================
      var deliveryComplete = rm.active.remaining <= 0;
      var labsEmpty = checkLabsEmpty();

      // -----------------------------------------------------------------
      // FIX: If evacuating and labs are empty, complete regardless
      // of remaining (product may already be in terminal/storage)
      // -----------------------------------------------------------------
      if (rm.active.evacuating && labsEmpty) {
        var orderDesc = rm.active.product;
        debugLog("[Labs] Evacuation complete, labs empty — completing " + orderDesc + " in " + roomName);
        rm.active = null;
        clearRoomCache(roomName);

        if (rm.queue.length > 0) {
          rm.active = rm.queue.shift();
          rm.active.needsPreEvacuation = true;
          var nextDesc = rm.active.type === 'breakdown' ? rm.active.compound : rm.active.product;
          debugLog("[Labs] Started next order: " + rm.active.type + " " + nextDesc + " x" + rm.active.remaining);
        } else {
          debugLog("[Labs] Completed all lab orders in " + roomName);
        }
        return;
      }

      // -----------------------------------------------------------------
      // FIX: If one reagent is loaded into an input lab but the other
      // reagent is completely absent from terminal + storage, reactions
      // cannot proceed.  Force evacuation so the stranded mineral is
      // returned to storage rather than sitting idle forever.
      // -----------------------------------------------------------------
      if (!rm.active.evacuating && !deliveryComplete) {
        var st = room.storage;
        var tm = room.terminal;
        var r1Avail = ((st && st.store[rm.active.reag1]) || 0) +
                      ((tm && tm.store[rm.active.reag1]) || 0);
        var r2Avail = ((st && st.store[rm.active.reag2]) || 0) +
                      ((tm && tm.store[rm.active.reag2]) || 0);

        if (layout && layout.groups) {
          for (var g = 0; g < layout.groups.length; g++) {
            var grp = layout.groups[g];
            if ((grp.in1.mineralAmount || 0) > 0 && r2Avail === 0) {
              rm.active.evacuating = true;
              debugLog("[Labs] Production stuck: " + rm.active.reag1 +
                       " loaded but no " + rm.active.reag2 + " available — evacuating");
              break;
            }
            if ((grp.in2.mineralAmount || 0) > 0 && r1Avail === 0) {
              rm.active.evacuating = true;
              debugLog("[Labs] Production stuck: " + rm.active.reag2 +
                       " loaded but no " + rm.active.reag1 + " available — evacuating");
              break;
            }
          }
        }
      }

      if (layout && layout.groups) {
        for (var g = 0; g < layout.groups.length && labsEmpty; g++) {
          var group = layout.groups[g];

          for (var j = 0; j < group.outs.length && labsEmpty; j++) {
            var productInLab = (group.outs[j].store && group.outs[j].store[rm.active.product]) || 0;
            if (productInLab > 0) {
              labsEmpty = false;
              break;
            }
          }

          if (labsEmpty && (group.in1.mineralAmount || 0) > 0) labsEmpty = false;
          if (labsEmpty && (group.in2.mineralAmount || 0) > 0) labsEmpty = false;
        }
      }

      if (deliveryComplete && labsEmpty) {
        var orderDesc = rm.active.product;
        debugLog("[Labs] Completed " + orderDesc + " in " + roomName);
        rm.active = null;
        clearRoomCache(roomName);

        if (rm.queue.length > 0) {
          rm.active = rm.queue.shift();
          rm.active.needsPreEvacuation = true;
          var nextDesc = rm.active.type === 'breakdown' ? rm.active.compound : rm.active.product;
          debugLog("[Labs] Started next order: " + rm.active.type + " " + nextDesc + " x" + rm.active.remaining);
        } else {
          debugLog("[Labs] Completed all lab orders in " + roomName);
        }
      } else if (deliveryComplete && !labsEmpty) {
        rm.active.evacuating = true;
        debugLog("[Labs] Delivery complete, entering evacuation phase");
      }
    }
  }

  /**
   * Record a delivery for order tracking
   * For PRODUCTION: called when product is delivered to terminal/storage
   * For BREAKDOWN: called when compound is delivered TO output labs
   */
  function recordDelivery(roomName, mineralType, amount) {
    var rm = ensureRoomOrders(roomName);
    if (!rm.active) return;

    var isBreakdown = rm.active.type === 'breakdown';

    if (isBreakdown) {
      if (mineralType !== rm.active.compound) return;
    } else {
      if (mineralType !== rm.active.product) return;
    }

    if (typeof amount !== "number" || amount <= 0) return;

    rm.active.remaining -= amount;
    if (rm.active.remaining < 0) rm.active.remaining = 0;

    if (isBreakdown) {
      if (typeof rm.active.compoundDelivered !== 'number') rm.active.compoundDelivered = 0;
      rm.active.compoundDelivered += amount;
      debugLog("[Labs] Breakdown delivery tracked: " + amount + " " + mineralType + 
               " to labs (remaining: " + rm.active.remaining + ", total delivered: " + rm.active.compoundDelivered + ")");
    }
  }

  function computeAndStoreLabLayout(room) {
    return computeBestLayout(room);
  }

  function repairActiveOrderIfNeeded(roomName) {
    var rm = ensureRoomOrders(roomName);
    if (!rm || !rm.active) return;
    var act = rm.active;

    var compound = act.type === 'breakdown' ? act.compound : act.product;

    if (!act.reag1 || !act.reag2) {
      var pair = findDirectReagents(compound);
      if (pair) {
        act.reag1 = pair.a;
        act.reag2 = pair.b;
      }
    }
    if (typeof act.remaining !== 'number' || act.remaining < 0) {
      act.remaining = act.amount || 0;
    }

    if (!act.type) {
      act.type = 'production';
    }

    if (act.type === 'breakdown' && typeof act.compoundDelivered !== 'number') {
      act.compoundDelivered = 0;
    }
  }

  // ===========================================================================
  // MAIN RUNNER - HELPERS
  // ===========================================================================

  function checkLabsClear(room, layout, order) {
    var allLabs = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });

    for (var i = 0; i < allLabs.length; i++) {
      var lab = allLabs[i];
      var mineralAmount = lab.mineralAmount || 0;

      if (mineralAmount > 0) {
        debugLog("[Labs] Pre-evac needed: lab has " + mineralAmount + " " + lab.mineralType);
        return false;
      }
    }

    return true;
  }

  /**
   * Create an evac-only order to flush unexpected minerals from labs.
   */
  function queueCleanup(roomName) {
    var rm = ensureRoomOrders(roomName);
    if (rm.active) return false;

    var room = Game.rooms[roomName];
    if (!room) return false;

    var labs = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });

    var hasMineral = false;
    for (var i = 0; i < labs.length; i++) {
      if ((labs[i].mineralAmount || 0) > 0) {
        hasMineral = true;
        break;
      }
    }

    if (!hasMineral) return false;

    rm.active = {
      type:               'cleanup',
      created:            Game.time,
      needsPreEvacuation: true,
      evacuating:         false,
      remaining:          0,
      reag1:              null,
      reag2:              null,
      product:            null,
      compound:           null
    };

    clearRoomCache(roomName);
    console.log('[Labs] Cleanup order queued for ' + roomName);
    return true;
  }

  // ===========================================================================
  // MAIN RUNNER - PRODUCTION (Multi-Group)
  // ===========================================================================

  function runProduction(room, layout, order) {
    var outStock = 0;
    for (var g = 0; g < layout.groups.length; g++) {
      var group = layout.groups[g];
      for (var s = 0; s < group.outs.length; s++) {
        var outLabX = group.outs[s];
        if (!outLabX || !outLabX.store) continue;
        if (outLabX.store[order.product]) {
          outStock += outLabX.store[order.product];
        }
      }
    }

    var remaining = typeof order.remaining === "number" && order.remaining > 0 
      ? order.remaining 
      : (order.amount || 0);

    if (!order.evacuating && remaining > 0 && outStock >= remaining) {
      order.evacuating = true;
      debugLog("[Labs] Preemptive evacuate: outputs hold " + outStock + " " + order.product + " >= remaining " + remaining);
    }

    if (!order.evacuating) {
      for (var gi = 0; gi < layout.groups.length; gi++) {
        var grp = layout.groups[gi];

        for (var j = 0; j < grp.outs.length; j++) {
          var out = grp.outs[j];
          if (out.cooldown > 0) continue;

          var code = out.runReaction(grp.in1, grp.in2);
          if (code !== OK) {
            out.runReaction(grp.in2, grp.in1);
          }
        }
      }
    }
  }

  // ===========================================================================
  // MAIN RUNNER - BREAKDOWN (Multi-Group)
  // ===========================================================================

  function runBreakdown(room, layout, order) {
    if (order.evacuating) return;

    var allLabs = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });

    // Preemptive evacuate: if reagent destinations (in1/in2) can't accept any
    // more reagent, OR there is no processable compound anywhere, flip the order
    // into evacuation rather than calling reverseReaction pointlessly.
    var preProcessable = false;
    for (var pi = 0; pi < allLabs.length; pi++) {
      if (allLabs[pi].mineralType === order.compound &&
          (allLabs[pi].mineralAmount || 0) >= LAB_REACTION_AMOUNT) {
        preProcessable = true;
        break;
      }
    }
    var preDestFull = false;
    var pgrp = layout.groups[0];
    if ((pgrp.in1.store.getFreeCapacity(order.reag1) || 0) < LAB_REACTION_AMOUNT) preDestFull = true;
    if ((pgrp.in2.store.getFreeCapacity(order.reag2) || 0) < LAB_REACTION_AMOUNT) preDestFull = true;

    // Only evacuate if destinations are full, or if delivery has actually begun
    // and there's no more processable compound. A fresh order with no compound
    // in labs yet just means the labbot hasn't delivered — wait, don't abort.
    var anyDeliveryHappened = (order.compoundDelivered || 0) > 0;
    var orderAge = Game.time - (order.created || Game.time);
    var deliveryGraceExpired = orderAge > 100; // safety net if labbot never spawns

    if (preDestFull || (!preProcessable && (anyDeliveryHappened || deliveryGraceExpired))) {
      order.evacuating = true;
      return;
    }

    var destIn1 = layout.groups[0].in1;
    var destIn2 = layout.groups[0].in2;

    for (var i = 0; i < allLabs.length; i++) {
      var lab = allLabs[i];

      if (lab.cooldown > 0) continue;
      if (lab.mineralType !== order.compound) continue;
      if ((lab.mineralAmount || 0) < LAB_REACTION_AMOUNT) continue;
      if (lab.id === destIn1.id || lab.id === destIn2.id) continue;

      var in1Space = destIn1.store.getFreeCapacity(order.reag1) || 0;
      var in2Space = destIn2.store.getFreeCapacity(order.reag2) || 0;

      if (in1Space < LAB_REACTION_AMOUNT || in2Space < LAB_REACTION_AMOUNT) {
        continue;
      }

      if (!lab.pos.inRangeTo(destIn1, 2) || !lab.pos.inRangeTo(destIn2, 2)) {
        continue;
      }

      var code = lab.reverseReaction(destIn1, destIn2);
      if (code === OK) {
        debugLog("[Labs] Breaking down " + order.compound + " from lab " + lab.id.substr(-4));
      } else if (code !== ERR_TIRED) {
        code = lab.reverseReaction(destIn2, destIn1);
      }
    }
  }

  // ===========================================================================
  // WORK DETECTION (for spawn decisions)
  // ===========================================================================

  /**
   * Check if labs in a room actually need a labbot to do work
   * FIX: Returns false during evacuation if all labs are empty
   * @param {string} roomName
   * @returns {boolean}
   */
  function labsNeedWork(roomName) {
    var rm = Memory.labOrders && Memory.labOrders[roomName];
    if (!rm || !rm.active) return false;
 
    var room = Game.rooms[roomName];
    if (!room) return false;
 
    var active = rm.active;
 
    // Cleanup orders: need a labBot only while pre-evac is still running
    if (active.type === 'cleanup') {
      return active.needsPreEvacuation === true;
    }
 
    var isBreakdown = active.type === 'breakdown';
 
    // Pre-evacuation always needs a labBot
    if (active.needsPreEvacuation) return true;
 
    // During evacuation, only need a labBot if labs still have minerals to move out
    if (active.evacuating) {
      var allLabs = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
      });
 
      for (var li = 0; li < allLabs.length; li++) {
        if ((allLabs[li].mineralAmount || 0) > 0) {
          return true;
        }
      }
 
      return false;
    }
 
    var terminal = room.terminal;
    var storage = room.storage;
    var LAB_CAPACITY = 3000;
 
    var allLabs = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_LAB; }
    });
 
    // Contamination: wrong mineral type in a lab always needs a labBot
    for (var i = 0; i < allLabs.length; i++) {
      var lab = allLabs[i];
      if ((lab.mineralAmount || 0) === 0) continue;
      var mt = lab.mineralType;
 
      if (isBreakdown) {
        if (mt !== active.compound && mt !== active.reag1 && mt !== active.reag2) {
          return true;
        }
      } else {
        if (mt !== active.product && mt !== active.reag1 && mt !== active.reag2) {
          return true;
        }
      }
    }
 
    if (isBreakdown) {
      var compoundAvailable = ((terminal && terminal.store[active.compound]) || 0) +
                              ((storage && storage.store[active.compound]) || 0);
      if (compoundAvailable >= LAB_REACTION_AMOUNT) return true;
 
      var layout = computeBreakdownLayout(room);
      if (layout && layout.groups.length > 0) {
        for (var g = 0; g < layout.groups.length; g++) {
          var group = layout.groups[g];
          if ((group.in1.mineralAmount || 0) >= 1000) return true;
          if ((group.in2.mineralAmount || 0) >= 1000) return true;
        }
      }
    } else {
      var reag1Available = ((terminal && terminal.store[active.reag1]) || 0) +
                           ((storage && storage.store[active.reag1]) || 0);
      var reag2Available = ((terminal && terminal.store[active.reag2]) || 0) +
                           ((storage && storage.store[active.reag2]) || 0);
 
      var layout = resolveLayout(room);
      if (layout) {
        for (var g = 0; g < layout.groups.length; g++) {
          var group = layout.groups[g];
          var have1 = (group.in1.mineralType === active.reag1) ? (group.in1.mineralAmount || 0) : 0;
          var have2 = (group.in2.mineralType === active.reag2) ? (group.in2.mineralAmount || 0) : 0;
          // Only spawn if deficit and supply are both actionable (>= one reaction's worth)
          if ((LAB_CAPACITY - have1) >= LAB_REACTION_AMOUNT && reag1Available >= LAB_REACTION_AMOUNT) return true;
          if ((LAB_CAPACITY - have2) >= LAB_REACTION_AMOUNT && reag2Available >= LAB_REACTION_AMOUNT) return true;
        }
 
        // Output lab filling up — spawn to evacuate before reactions stall
        for (var g = 0; g < layout.groups.length; g++) {
          var group = layout.groups[g];
          for (var j = 0; j < group.outs.length; j++) {
            var outLab = group.outs[j];
            if (outLab.mineralType === active.product && (outLab.mineralAmount || 0) >= 2000) {
              return true;
            }
          }
        }
 
        // A reagent is loaded in an input lab but its partner is gone — needs evacuation
        for (var g = 0; g < layout.groups.length; g++) {
          var group = layout.groups[g];
          if ((group.in1.mineralAmount || 0) > 0 && reag2Available === 0) return true;
          if ((group.in2.mineralAmount || 0) > 0 && reag1Available === 0) return true;
        }
      }
    }
 
    return false;
  }


  // ===========================================================================
  // MAIN RUNNER
  // ===========================================================================

  function runRoom(room) {
    var rm = ensureRoomOrders(room.name);

    if (!rm.active) return;

    maybeCompleteOrder(room.name);
    rm = ensureRoomOrders(room.name);
    if (!rm.active) return;

    // -----------------------------------------------------------------------
    // CLEANUP ORDER
    // -----------------------------------------------------------------------
    if (rm.active.type === 'cleanup') {
      if (rm.active.needsPreEvacuation) {
        if (checkLabsClear(room, null, rm.active)) {
          rm.active.needsPreEvacuation = false;
          debugLog("[Labs] Cleanup pre-evac complete for " + room.name);
        }
      }
      maybeCompleteOrder(room.name);
      return;
    }

    repairActiveOrderIfNeeded(room.name);

    var stored = Memory.labLayout ? Memory.labLayout[room.name] : null;
    if (stored && stored.validated && (Game.time - stored.validated) > LAYOUT_VALIDATION_INTERVAL) {
      delete layoutCache[room.name];
      delete stored.validated;
    }
    if (stored && stored.breakdownValidated && (Game.time - stored.breakdownValidated) > LAYOUT_VALIDATION_INTERVAL) {
      delete breakdownLayoutCache[room.name];
      delete stored.breakdownValidated;
    }

    var layout;
    if (rm.active.type === 'breakdown') {
      layout = computeBreakdownLayout(room);
    } else {
      layout = resolveLayout(room);
    }

    if (!layout || !layout.groups || layout.groups.length === 0) return;

    if (rm.active.needsPreEvacuation) {
      var labsClear = checkLabsClear(room, layout, rm.active);
      if (labsClear) {
        rm.active.needsPreEvacuation = false;
        debugLog("[Labs] Pre-evacuation complete for " + room.name);
      } else {
        debugLog("[Labs] Waiting for pre-evacuation in " + room.name);
        return;
      }
    }

    if (rm.active.type === 'breakdown') {
      runBreakdown(room, layout, rm.active);
    } else {
      runProduction(room, layout, rm.active);
    }

    maybeCompleteOrder(room.name);
  }

  function run(arg) {
    ensureManagerRoot();

    if (Memory.labManager.lastRun && (Game.time - Memory.labManager.lastRun) < MANAGER_RUN_INTERVAL) {
      return;
    }
    Memory.labManager.lastRun = Game.time;

    if (arg && arg.name && arg.find) {
      return runRoom(arg);
    }

    for (var roomName in Memory.labOrders) {
      var orders = Memory.labOrders[roomName];
      if (orders && orders.active) {
        var room = Game.rooms[roomName];
        if (room) {
          runRoom(room);
        }
      }
    }
  }

  // ===========================================================================
  // CONSOLE COMMANDS
  // ===========================================================================

  function installConsole() {
      // Console diagnostic commands:
    global.labsDiagnoseRoom = function(roomName) {
      if (typeof roomName !== "string") return "[Labs] Usage: labsDiagnoseRoom(roomName)";
      var room = Game.rooms[roomName];
      if (!room) return "[Labs] No vision in " + roomName;

      var lines = [];
      var rm = ensureRoomOrders(roomName);

      lines.push("Order: " + (rm.active ? rm.active.type + " " + (rm.active.product || rm.active.compound) : "none"));
      lines.push("Queue: " + ((rm.queue && rm.queue.length) || 0));
      lines.push("labsNeedWork: " + labsNeedWork(roomName));

      var allCreeps = room.find(FIND_MY_CREEPS);
      var bots = [];
      for (var i = 0; i < allCreeps.length; i++) {
        if (/labbot/i.test(allCreeps[i].memory.role || "")) bots.push(allCreeps[i]);
      }
      lines.push("LabBots in room: " + bots.length);

      for (var j = 0; j < bots.length; j++) {
        var c = bots[j];
        var carry = {};
        for (var res in c.store) {
          if (c.store[res] > 0) carry[res] = c.store[res];
        }
        lines.push("  " + c.name + ": " + JSON.stringify({
          role: c.memory.role,
          phase: c.memory.phase,
          idleTicks: c.memory.idleTicks,
          suicidePending: c.memory.suicidePending,
          task: c.memory.task,
          targetId: c.memory.targetId,
          working: c.memory.working,
          carry: carry
        }));
      }

      var layout = resolveLayout(room);
      lines.push("Layout: " + (layout && layout.groups && layout.groups.length > 0 ? "valid " + layout.groups.length + " groups" : "NONE"));

      if (rm.active && rm.active.needsPreEvacuation) lines.push("WARNING: stuck in needsPreEvacuation");
      if (rm.active && rm.active.evacuating)       lines.push("Note: evacuating flag is set");

      return "[Labs] " + roomName + "\n" + lines.join("\n");
    };

    global.labsDiagnoseBots = function() {
      var lines = [];
      for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (/labbot/i.test(c.memory.role || "")) {
          lines.push(c.name + " | room: " + c.room.name + " | phase: " + (c.memory.phase || "none") +
                     " | idleTicks: " + (c.memory.idleTicks || 0) +
                     " | suicidePending: " + (c.memory.suicidePending || false));
        }
      }
      return lines.length ? "[Labs] Global labbot census:\n" + lines.join("\n") : "[Labs] No labbots found globally.";
    };

    global.labsClearBotMemory = function(creepName) {
      var c = Game.creeps[creepName];
      if (!c) return "[Labs] Creep not found: " + creepName;
      delete c.memory.phase;
      delete c.memory.idleTicks;
      delete c.memory.suicidePending;
      delete c.memory.lastAction;
      delete c.memory.lastResource;
      delete c.memory.depositReason;
      delete c.memory.wantedReagents;
      delete c.memory.task;
      delete c.memory.targetId;
      delete c.memory.working;
      delete c.memory.idle;
      return "[Labs] Reset sticky memory on " + creepName + " — manager should reclaim it next tick";
    };

    global.orderLabs = function(roomName, product, amount) {
      if (typeof roomName !== "string" || typeof product !== "string") {
        return "[Labs] Usage: orderLabs(roomName, product, amount)";
      }
      var n = parseInt(amount, 10);
      if (isNaN(n) || n < 0) n = 0;

      var roomObj = Game.rooms[roomName] || null;
      if (roomObj) {
        var layout = computeAndStoreLabLayout(roomObj);
        if (layout) {
          var totalOuts = 0;
          for (var i = 0; i < layout.groups.length; i++) {
            totalOuts += layout.groups[i].outs.length;
          }
          debugLog("[Labs] Computed lab layout for " + roomName + " — " + 
                   layout.groups.length + " groups, " + totalOuts + " outputs");
        }
      }

      var result = startOrder(roomName, product, n);
      return result.msg;
    };

    global.breakdownLabs = function(roomName, compound, amount) {
      if (typeof roomName !== "string" || typeof compound !== "string") {
        return "[Labs] Usage: breakdownLabs(roomName, compound, amount)";
      }
      var n = parseInt(amount, 10);
      if (isNaN(n) || n < 0) n = 0;

      var roomObj = Game.rooms[roomName] || null;
      if (roomObj) {
        var layout = computeAndStoreLabLayout(roomObj);
        if (layout) {
          debugLog("[Labs] Computed lab layout for " + roomName + " — " + layout.groups.length + " groups");
        }
      }

      var result = startBreakdownOrder(roomName, compound, n);
      return result.msg;
    };

    global.showAllLabs = function() {
      if (!Memory.labOrders) return "[Labs] No orders anywhere";
      var results = [];
      for (var roomName in Memory.labOrders) {
        results.push(global.showLabs(roomName));
      }
      return results.join("\n");
    };

    global.cancelLabs = function(roomName) {
      if (typeof roomName !== "string") return "[Labs] Usage: cancelLabs(roomName)";
      var rm = ensureRoomOrders(roomName);
      rm.active = null;
      rm.queue = [];
      return "[Labs] Cleared labs orders in " + roomName;
    };

    global.recomputeLabLayout = function(roomName) {
      if (typeof roomName !== "string") return "[Labs] Usage: recomputeLabLayout(roomName)";

      var room = Game.rooms[roomName];
      if (!room) return "[Labs] No vision in " + roomName;

      clearRoomCache(roomName, true);

      var layout = computeBestLayout(room);
      if (!layout) return "[Labs] Could not compute layout for " + roomName;

      var totalOuts = 0;
      var summary = [];
      for (var g = 0; g < layout.groups.length; g++) {
        totalOuts += layout.groups[g].outs.length;
        summary.push("Group " + (g+1) + ": " + layout.groups[g].outs.length + " outputs");
      }

      return "[Labs] Recomputed layout for " + roomName + ": " + layout.groups.length + 
             " groups, " + (layout.groups.length * 2) + " inputs, " + totalOuts + " outputs\n" +
             summary.join("\n");
    };

    global.showLabs = function(roomName) {
      if (typeof roomName !== "string") return "[Labs] Usage: showLabs(roomName)";

      var rm = ensureRoomOrders(roomName);
      if (!rm || typeof rm !== "object") {
        Memory.labOrders = Memory.labOrders && typeof Memory.labOrders === "object" ? Memory.labOrders : {};
        Memory.labOrders[roomName] = { active: null, queue: [] };
        rm = Memory.labOrders[roomName];
      }

      var lines = [];

      if (rm.active) {
        var act = rm.active;
        var compound = act.type === 'breakdown' ? act.compound : act.product;

        if (!act.reag1 || !act.reag2) {
          var pair = findDirectReagents(compound);
          if (pair) {
            act.reag1 = pair.a;
            act.reag2 = pair.b;
          }
        }
        if (typeof act.remaining !== 'number') {
          act.remaining = act.amount || 0;
        }

        var status = act.evacuating ? " (evacuating)" : "";
        if (act.needsPreEvacuation) status += " (pre-evac)";
        var typeLabel = act.type === 'breakdown' ? "BREAKDOWN" : "PRODUCTION";

        var line = "Active: " + typeLabel + " " + compound +
          " remaining " + act.remaining +
          " reagents " + act.reag1 + " + " + act.reag2 + status;

        if (act.type === 'breakdown' && typeof act.compoundDelivered === 'number') {
          line += " (delivered: " + act.compoundDelivered + ")";
        }

        lines.push(line);

        var needsWork = labsNeedWork(roomName);
        lines.push("Needs labbot: " + (needsWork ? "YES" : "NO"));
      } else {
        lines.push("Active: none");
      }

      var queueLen = (rm.queue && rm.queue.length) ? rm.queue.length : 0;
      lines.push("Queue: " + queueLen);

      var mem = (Memory.labLayout && Memory.labLayout[roomName]) ? Memory.labLayout[roomName] : null;
      if (!mem || typeof mem !== "object" || !mem.groups) {
        lines.push("Layout: none");
      } else {
        var groupCount = mem.groups.length;
        var totalInputs = groupCount * 2;
        var totalOutputs = 0;
        var validGroups = 0;

        for (var g = 0; g < mem.groups.length; g++) {
          var group = mem.groups[g];
          totalOutputs += (group.outIds ? group.outIds.length : 0);

          var in1 = Game.getObjectById(group.in1Id);
          var in2 = Game.getObjectById(group.in2Id);
          if (in1 && in2) {
            var validOuts = 0;
            for (var i = 0; i < (group.outIds || []).length; i++) {
              var lab = Game.getObjectById(group.outIds[i]);
              if (lab && in1.pos.inRangeTo(lab, 2) && in2.pos.inRangeTo(lab, 2)) {
                validOuts++;
              }
            }
            if (validOuts > 0) validGroups++;
          }
        }

        var status2 = (validGroups === groupCount) ? "valid" : "partial";
        lines.push(
          "Layout: " + status2 +
          " groups=" + groupCount +
          " inputs=" + totalInputs +
          " outputs=" + totalOutputs +
          " validGroups=" + validGroups
        );
      }

      return "[Labs] " + roomName + " — " + lines.join(" | ");
    };

    global.labsDebugOn = function() {
      if (!Memory.labManager) Memory.labManager = {};
      Memory.labManager.debug = true;
      return "[Labs] Debug logging enabled";
    };

    global.labsDebugOff = function() {
      if (!Memory.labManager) Memory.labManager = {};
      Memory.labManager.debug = false;
      return "[Labs] Debug logging disabled";
    };

    global.labsStats = function() {
      var stats = [];
      stats.push("Layout cache size: " + Object.keys(layoutCache).length);
      stats.push("Breakdown cache size: " + Object.keys(breakdownLayoutCache).length);
      stats.push("Cache valid until: " + cacheValidUntil);
      stats.push("Last run: " + (Memory.labManager.lastRun || "never"));
      stats.push("Run interval: " + MANAGER_RUN_INTERVAL + " ticks");
      stats.push("Validation interval: " + LAYOUT_VALIDATION_INTERVAL + " ticks");
      return "[Labs] " + stats.join(" | ");
    };
  }

  function autoInstallConsoleOnce() {
    if (!global.__labsConsoleInstalled) {
      installConsole();
      global.__labsConsoleInstalled = true;
    }
  }
  autoInstallConsoleOnce();

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

    return {
        installConsole:    installConsole,
        runRoom:           runRoom,
        run:               run,
        recordDelivery:    recordDelivery,
        getLayout:         getLayout,
        getBreakdownLayout:getBreakdownLayout,
        clearRoomCache:    clearRoomCache,
        labsNeedWork:      labsNeedWork,
        queueCleanup:      queueCleanup
      };
})();

module.exports = labManager;
