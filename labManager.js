// Start a chain to produce 2,000 XGH2O in W1N1
//orderLabs('W1N1', 'XGH2O', 2000);
// or using Screeps constants
//orderLabs('W1N1', RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 2000);

// Check current status
//showLabs('W1N1');

// Cancel all lab work in a room
//cancelLabs('W1N1');

// Toggle debug logging
//labsDebugOn();
//labsDebugOff();

// Inspect internal stats
//labsStats();

var labManager = (function() {
  // CPU optimization constants
  var LAYOUT_VALIDATION_INTERVAL = 50;  // Validate layouts every 50 ticks
  var MANAGER_RUN_INTERVAL = 3;         // Run manager every 3 ticks

  // Cache for resolved layouts to avoid repeated Game.getObjectById calls
  var layoutCache = {};
  var cacheValidUntil = 0;

  // ---------------- Debug helper ----------------
  function debugLog(message) {
    if (!Memory.labManager) Memory.labManager = {};
    if (Memory.labManager.debug) {
      console.log(message);
    }
  }

  // ---------------- Memory helpers ----------------
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

  // ---------------- Cached Layout helpers ----------------
  function getCachedLayout(roomName) {
    if (Game.time > cacheValidUntil) {
      layoutCache = {};
      cacheValidUntil = Game.time + 10; // Cache valid for 10 ticks
    }
    return layoutCache[roomName];
  }

  function setCachedLayout(roomName, layout) {
    layoutCache[roomName] = layout;
  }

  function validateStoredLayout(room, m) {
    if (!m) return null;
    if (!m.in1Id || !m.in2Id || !m.outIds || m.outIds.length === 0) return null;

    // Skip validation if recently validated
    if (m.validated && (Game.time - m.validated) < LAYOUT_VALIDATION_INTERVAL) {
      var cached = getCachedLayout(room.name);
      if (cached) return cached;
    }

    var in1 = Game.getObjectById(m.in1Id);
    var in2 = Game.getObjectById(m.in2Id);
    if (!in1 || !in2) return null;

    var outs = [];
    for (var i = 0; i < m.outIds.length; i++) {
      var o = Game.getObjectById(m.outIds[i]);
      if (!o) continue;
      if (in1.pos.inRangeTo(o, 2) && in2.pos.inRangeTo(o, 2)) {
        outs.push(o);
      }
    }

    if (outs.length === 0) return null;

    // Mark as validated and cache result
    m.validated = Game.time;
    var layout = { in1: in1, in2: in2, outs: outs };
    setCachedLayout(room.name, layout);
    return layout;
  }

  function computeBestLayout(room) {
    // Use cached room.find result if available
    var cacheKey = room.name + '_labs';
    var labs = room._labsCache;
    if (!labs || room._labsCacheTime !== Game.time) {
      labs = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
      });
      room._labsCache = labs;
      room._labsCacheTime = Game.time;
    }

    if (!labs || labs.length < 3) return null;

    var bestIn1 = null;
    var bestIn2 = null;
    var bestOuts = [];

    // Optimized layout computation - break early when good layout found
    for (var i = 0; i < labs.length && bestOuts.length < 7; i++) {
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

          // Break early if we found a very good layout
          if (bestOuts.length >= Math.min(7, labs.length - 2)) break;
        }
      }
    }

    if (!bestIn1 || !bestIn2 || bestOuts.length === 0) return null;

    ensureLayoutRoot();
    Memory.labLayout[room.name] = {
      in1Id: bestIn1.id,
      in2Id: bestIn2.id,
      outIds: bestOuts.map(function(o) { return o.id; }),
      validated: Game.time
    };

    var layout = { in1: bestIn1, in2: bestIn2, outs: bestOuts };
    setCachedLayout(room.name, layout);
    return layout;
  }

  function resolveLayout(room) {
    // Check cache first
    var cached = getCachedLayout(room.name);
    if (cached) return cached;

    ensureLayoutRoot();
    var stored = Memory.labLayout[room.name];
    var valid = validateStoredLayout(room, stored);
    if (valid) return valid;

    var computed = computeBestLayout(room);
    if (computed) return computed;

    // Fallback for 3-lab rooms (optimized)
    var labs = room._labsCache;
    if (!labs) {
      labs = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_LAB; }
      });
      room._labsCache = labs;
      room._labsCacheTime = Game.time;
    }

    if (labs && labs.length === 3) {
      for (var k = 0; k < 3; k++) {
        var prod = labs[k];
        var a = labs[(k + 1) % 3];
        var b = labs[(k + 2) % 3];
        if (prod.pos.inRangeTo(a, 2) && prod.pos.inRangeTo(b, 2)) {
          Memory.labLayout[room.name] = {
            in1Id: a.id, in2Id: b.id, outIds: [prod.id], validated: Game.time
          };
          var layout = { in1: a, in2: b, outs: [prod] };
          setCachedLayout(room.name, layout);
          return layout;
        }
      }
    }

    return null;
  }

  function getLayout(room) {
    return resolveLayout(room);
  }

  // ---------------- Reaction helpers (unchanged) ----------------
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

  // ---------------- Orders (unchanged) ----------------
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
        product: step.product,
        amount: stepAmount,
        remaining: stepAmount,
        reag1: step.reag1,
        reag2: step.reag2,
        created: Game.time,
        priority: step.priority
      });
    }

    if (!rm.active) {
      rm.active = orders.shift();
      rm.queue = orders;
      return { ok: true, msg: "[Labs] Started reaction chain for " + product + " x" + amount + " (" + (orders.length + 1) + " steps)" };
    } else {
      rm.queue = rm.queue.concat(orders);
      return { ok: true, msg: "[Labs] Queued reaction chain for " + product + " x" + amount + " (" + orders.length + " steps)" };
    }
  }

  function maybeCompleteOrder(roomName) {
    var rm = ensureRoomOrders(roomName);
    if (!rm.active) return;

    var room = Game.rooms[roomName];
    if (!room) return;

    var deliveryComplete = rm.active.remaining <= 0;
    var labsEmpty = true;
    var layout = resolveLayout(room);

    if (layout && layout.outs) {
      var totalRemaining = 0;
      for (var i = 0; i < layout.outs.length; i++) {
        var outLab = layout.outs[i];
        var productInLab = (outLab.store && outLab.store[rm.active.product]) || 0;
        totalRemaining += productInLab;
        if (productInLab > 0) {
          labsEmpty = false;
        }
      }

      if (!labsEmpty) {
        debugLog("[Labs] Order not complete - " + totalRemaining + " " + rm.active.product + " remaining in output labs");
      }
    }

    if (deliveryComplete && labsEmpty) {
      debugLog("[Labs] Completed " + rm.active.product + " in " + roomName + " (delivered + labs evacuated)");
      rm.active = null;

      if (rm.queue.length > 0) {
        rm.active = rm.queue.shift();
        debugLog("[Labs] Started next step: " + rm.active.product + " x" + rm.active.remaining);

        // Clear layout cache to force recomputation for new reaction
        delete layoutCache[roomName];
        if (Memory.labLayout[roomName]) {
          delete Memory.labLayout[roomName].validated;
        }
      } else {
        debugLog("[Labs] Completed all lab orders in " + roomName);
      }
    } else if (deliveryComplete && !labsEmpty) {
      rm.active.evacuating = true;
      debugLog("[Labs] " + rm.active.product + " delivery complete, entering evacuation phase");
    }
  }

  function recordDelivery(roomName, mineralType, amount) {
    var rm = ensureRoomOrders(roomName);
    if (!rm.active) return;
    if (rm.active.product !== mineralType) return;
    if (typeof amount !== "number") return;
    if (amount <= 0) return;

    rm.active.remaining -= amount;
    if (rm.active.remaining < 0) rm.active.remaining = 0;
  }

  function computeAndStoreLabLayout(room) {
    return computeBestLayout(room);
  }

  function repairActiveOrderIfNeeded(roomName) {
    var rm = ensureRoomOrders(roomName);
    if (!rm || !rm.active) return;
    var act = rm.active;
    if (!act.reag1 || !act.reag2) {
      var pr = act.product;
      var pair = findDirectReagents(pr);
      if (pair) {
        act.reag1 = pair.a;
        act.reag2 = pair.b;
      }
    }
    if (typeof act.remaining !== 'number' || act.remaining < 0) {
      act.remaining = act.amount || 0;
    }
  }

  // ---------------- Optimized Main Runner ----------------
  function runRoom(room) {
    var rm = ensureRoomOrders(room.name);

    // Skip processing if no active orders
    if (!rm.active) return;

    maybeCompleteOrder(room.name);
    rm = ensureRoomOrders(room.name);
    if (!rm.active) return;

    repairActiveOrderIfNeeded(room.name);

    // Optimized layout validation - only check periodically
    var stored = Memory.labLayout ? Memory.labLayout[room.name] : null;
    if (stored && stored.validated && (Game.time - stored.validated) > LAYOUT_VALIDATION_INTERVAL) {
      // Periodic validation - clear cache to force recheck
      delete layoutCache[room.name];
      delete stored.validated;
    }

    var layout = resolveLayout(room);
    if (!layout) return;

    // NEW: if outputs already hold enough to satisfy remaining, enter evacuation (stop new reactions)
    var outStock = 0;
    if (layout.outs && layout.outs.length > 0) {
      for (var s = 0; s < layout.outs.length; s++) {
        var outLabX = layout.outs[s];
        if (!outLabX || !outLabX.store) continue;
        if (outLabX.store[rm.active.product]) {
          outStock += outLabX.store[rm.active.product];
        }
      }
    }
    var remaining = 0;
    if (typeof rm.active.remaining === "number" && rm.active.remaining > 0) {
      remaining = rm.active.remaining;
    } else if (typeof rm.active.amount === "number" && rm.active.amount > 0) {
      remaining = rm.active.amount;
    }
    if (!rm.active.evacuating && remaining > 0 && outStock >= remaining) {
      rm.active.evacuating = true;
      debugLog("[Labs] Preemptive evacuate: outputs hold " + outStock + " " + rm.active.product + " >= remaining " + remaining);
    }

    // Only run reactions if not in evacuation phase
    if (!rm.active.evacuating) {
      for (var j = 0; j < layout.outs.length; j++) {
        var out = layout.outs[j];
        if (out.cooldown > 0) continue;

        var code = out.runReaction(layout.in1, layout.in2);
        if (code !== OK) {
          out.runReaction(layout.in2, layout.in1);
        }
      }
    }

    maybeCompleteOrder(room.name);
  }

  // CPU-optimized main run function
  function run(arg) {
    ensureManagerRoot();

    // Throttle manager execution to every N ticks
    if (Memory.labManager.lastRun && (Game.time - Memory.labManager.lastRun) < MANAGER_RUN_INTERVAL) {
      return;
    }
    Memory.labManager.lastRun = Game.time;

    if (arg && arg.name && arg.find) {
      return runRoom(arg);
    }

    // Only process rooms with active lab orders
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

  // ---------------- Console (unchanged) ----------------
  function installConsole() {
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
          debugLog("[Labs] Computed lab layout for " + roomName + " — outs: " + layout.outs.length);
        } else {
          debugLog("[Labs] Could not compute lab layout for " + roomName + " (need at least 3 labs and overlap).");
        }
      } else {
        debugLog("[Labs] No vision in " + roomName + "; layout will be computed when vision is available.");
      }

      var result = startOrder(roomName, product, n);
      return result.msg;
    };

    global.cancelLabs = function(roomName) {
      if (typeof roomName !== "string") return "[Labs] Usage: cancelLabs(roomName)";
      var rm = ensureRoomOrders(roomName);
      rm.active = null;
      rm.queue = [];
      return "[Labs] Cleared labs orders in " + roomName;
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
        if (!rm.active.reag1 || !rm.active.reag2) {
          var pair = findDirectReagents(rm.active.product);
          if (pair) {
            rm.active.reag1 = pair.a;
            rm.active.reag2 = pair.b;
          }
        }
        if (typeof rm.active.remaining !== 'number') {
          rm.active.remaining = rm.active.amount || 0;
        }

        var status = rm.active.evacuating ? " (evacuating)" : "";
        lines.push(
          "Active: " + rm.active.product +
          " remaining " + rm.active.remaining +
          " reagents " + rm.active.reag1 + " + " + rm.active.reag2 + status
        );
      } else {
        lines.push("Active: none");
      }

      var queueLen = (rm.queue && rm.queue.length) ? rm.queue.length : 0;
      lines.push("Queue: " + queueLen);

      var mem = (Memory.labLayout && Memory.labLayout[roomName]) ? Memory.labLayout[roomName] : null;
      if (!mem || typeof mem !== "object") {
        lines.push("Layout: none");
      } else {
        var in1Id = mem.in1Id || "(missing)";
        var in2Id = mem.in2Id || "(missing)";
        var outIds = (mem.outIds && mem.outIds.length) ? mem.outIds : [];
        var outCount = outIds.length;

        var validOuts = 0;
        var in1 = in1Id && Game.getObjectById(in1Id) || null;
        var in2 = in2Id && Game.getObjectById(in2Id) || null;
        if (in1 && in2 && outCount > 0) {
          for (var i = 0; i < outIds.length; i++) {
            var lab = Game.getObjectById(outIds[i]);
            if (!lab) continue;
            if (in1.pos.inRangeTo(lab, 2) && in2.pos.inRangeTo(lab, 2)) validOuts++;
          }
        }

        var status2 = (in1 && in2 && validOuts > 0) ? "valid" : "invalid";
        lines.push(
          "Layout: " + status2 +
          " in1 " + in1Id +
          " in2 " + in2Id +
          " outs " + outCount +
          " validOuts " + validOuts
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

    // CPU debugging command
    global.labsStats = function() {
      var stats = [];
      stats.push("Layout cache size: " + Object.keys(layoutCache).length);
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

  return {
    installConsole: installConsole,
    runRoom: runRoom,
    run: run,
    recordDelivery: recordDelivery,
    getLayout: getLayout
  };
})();

module.exports = labManager;
