//    orderDemolition('E1S1', 'E2S2', 2) - Orders 2 demolition teams from E1S1 to demolish E2S2
//    orderDemolition('E1S1', 'E2S2', 2, 'controller') - Prioritize dismantling walls/ramparts within range 1 of the controller
//    orderDemolition('E1S1', 'E2S2', 2, 'wall') - Prioritize dismantling ALL STRUCTURE_WALL in the target room (mission ends when none remain)
//    orderDemolition('E1S1', 'E2S2', 2, 'rampart') - Prioritize dismantling ALL STRUCTURE_RAMPART in the target room (mission ends when none remain)
//    cancelDemolitionOrder('E2S2') - Cancels the demolition operation against E2S2
//    showDemolitionOrders() - Lists all active demolition orders in the console
//    setDemolitionFocus('E2S2', 'rampart')
// Notes:
// - Adds banned rooms list at top.
// - Optional focus (all three are strict — mission ends when no matching targets remain):
//   - 'controller' -> dismantle ONLY walls/ramparts within range 1 of the target room controller; mission ends when the ring is clear.
//   - 'wall'       -> dismantle ONLY STRUCTURE_WALL in the target room; mission ends when the room has zero STRUCTURE_WALL.
//   - 'rampart'    -> dismantle ONLY STRUCTURE_RAMPART in the target room; mission ends when the room has zero STRUCTURE_RAMPART.

const iff = require('iff');

// == BANNED ROOMS (edit this list to keep demolition teams out) ==
const BANNED_ROOMS = [
  'E8N49', 'E9N51'
];

/**
 * Checks if a room is banned via hardcode OR dynamic creep tower blacklist
 */
function isRoomBanned(roomName, creep) {
  for (var i = 0; i < BANNED_ROOMS.length; i++) {
    if (BANNED_ROOMS[i] === roomName) return true;
  }
  if (creep && creep.memory.blacklistedRooms && creep.memory.blacklistedRooms.indexOf(roomName) !== -1) {
    return true;
  }
  return false;
}

function logOnce(creep, key, msg) {
  if (!creep.memory._logOnce) creep.memory._logOnce = {};
  if (creep.memory._logOnce[key]) return;
  creep.memory._logOnce[key] = true;
  console.log(msg);
}

function removeOrdersFromArray(arr, targetRoom) {
  if (!arr || !arr.length) return false;

  var kept = [];
  var removed = false;

  for (var i = 0; i < arr.length; i++) {
    var o = arr[i];
    if (o && o.targetRoom === targetRoom) {
      removed = true;
      continue;
    }
    kept.push(o);
  }

  arr.length = 0;
  for (var j = 0; j < kept.length; j++) arr.push(kept[j]);

  return removed;
}

global.setDemolitionFocus = function(targetRoom, focus) {
  var validFocus = ['wall', 'rampart', 'controller'];
  if (focus && validFocus.indexOf(focus) === -1) {
    console.log('[Demolition] Invalid focus "' + focus + '". Valid options: ' + validFocus.join(', '));
    return;
  }

  // Update the order in memory
  var orders = Memory.demolitionOrders;
  var found = false;
  if (orders && orders.length) {
    for (var i = 0; i < orders.length; i++) {
      if (orders[i] && orders[i].targetRoom === targetRoom) {
        orders[i].focus = focus || null;
        found = true;
      }
    }
  }

  if (!found) {
    console.log('[Demolition] No active order found for ' + targetRoom);
    return;
  }

  // Patch all active creeps on this order so they re-evaluate immediately
  var patched = 0;
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c.memory.role === 'demolition' && c.memory.targetRoom === targetRoom) {
      c.memory.demolitionFocus = focus || null;
      delete c.memory.targetId; // Drop cached target so they pick up the new focus next tick
      patched++;
    }
  }

  console.log('[Demolition] Focus for ' + targetRoom + ' set to "' + (focus || 'default') + '" — ' + patched + ' creep(s) updated');
};

global.showDemolitionOrders = function() {
  var orders = Memory.demolitionOrders;
  if (!orders || !orders.length) {
    console.log('[Demolition] No active demolition orders.');
    return;
  }

  console.log('[Demolition] Active orders (' + orders.length + '):');
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (!o) continue;

    var assignedCreeps = [];
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (c.memory.role === 'demolition' && c.memory.targetRoom === o.targetRoom) {
        var status;
        if (c.memory.missionComplete) {
          status = '✅ done';
        } else if (c.memory.retreating) {
          status = '🏃 retreating';
        } else if (c.memory.needsBoost) {
          status = '⚗️ boosting';
        } else if (c.room.name === o.targetRoom) {
          var currentTarget = c.memory.targetId ? Game.getObjectById(c.memory.targetId) : null;
          status = '⚒️ ' + (currentTarget ? currentTarget.structureType : 'searching');
        } else {
          status = '🚶 ' + c.room.name + ' → ' + o.targetRoom;
        }
        assignedCreeps.push(c.name + ' [' + status + ']');
      }
    }

    var line = '  #' + (i + 1) + ': ' + o.homeRoom + ' → ' + o.targetRoom;
    if (o.focus) line += ' (focus: ' + o.focus + ')';
    line += '\n       Creeps (' + assignedCreeps.length + '): ';
    line += assignedCreeps.length ? assignedCreeps.join(', ') : 'none assigned';

    console.log(line);
  }
};

function purgeDemolitionMemory(targetRoom) {
  var removed = false;

  if (Memory.demolitionOrders && Memory.demolitionOrders.length) {
    if (removeOrdersFromArray(Memory.demolitionOrders, targetRoom)) removed = true;
  }

  return removed;
}

function completeDemolitionMission(creep, targetRoom, note) {
  creep.memory.missionComplete = true;

  var roomToClear = targetRoom;
  if (!roomToClear) roomToClear = creep.room.name;

  if (!Memory._demolitionCompleteLoggedAt) Memory._demolitionCompleteLoggedAt = {};
  if (Memory._demolitionCompleteLoggedAt[roomToClear] === Game.time) return;

  var removed = purgeDemolitionMemory(roomToClear);
  if (removed) {
    Memory._demolitionCompleteLoggedAt[roomToClear] = Game.time;

    var msg = '[Demolition] Order complete: ' + roomToClear;
    if (note) msg = msg + ' (' + note + ')';
    console.log(msg);

    // Auto-stop boost order so labBot stops refilling unused labs
    var homeRoom = creep.memory.homeRoom;
    if (homeRoom &&
        Memory.boostManager &&
        Memory.boostManager.orders &&
        Memory.boostManager.orders[homeRoom] &&
        Memory.boostManager.orders[homeRoom].demolisher) {

      var boostOrder = Memory.boostManager.orders[homeRoom].demolisher;
      boostOrder.stopping = true;
      boostOrder.active = false;
      console.log('[Demolition] Auto-stopping demolisher boost in ' + homeRoom);
    }
  }
}

function isEdgeTile(pos) {
  if (!pos) return false;
  if (pos.x === 0) return true;
  if (pos.x === 49) return true;
  if (pos.y === 0) return true;
  if (pos.y === 49) return true;
  return false;
}

function nudgeOffRoomEdge(creep) {
  if (creep.pos.y === 0) {
    var mv = creep.move(BOTTOM);
    if (mv === OK) return true;
    if (creep.pos.x > 0 && creep.move(BOTTOM_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(BOTTOM_RIGHT) === OK) return true;
  } else if (creep.pos.y === 49) {
    var mv2 = creep.move(TOP);
    if (mv2 === OK) return true;
    if (creep.pos.x > 0 && creep.move(TOP_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(TOP_RIGHT) === OK) return true;
  } else if (creep.pos.x === 0) {
    var mv3 = creep.move(RIGHT);
    if (mv3 === OK) return true;
    if (creep.pos.y > 0 && creep.move(BOTTOM_RIGHT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(TOP_RIGHT) === OK) return true;
  } else if (creep.pos.x === 49) {
    var mv4 = creep.move(LEFT);
    if (mv4 === OK) return true;
    if (creep.pos.y > 0 && creep.move(BOTTOM_LEFT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(TOP_LEFT) === OK) return true;
  }
  return false;
}

function getOrderForRoom(targetRoom) {
  var orders = Memory.demolitionOrders;
  if (!orders || !orders.length) return null;

  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (o && o.targetRoom === targetRoom) return o;
  }
  return null;
}

function findControllerRingTargets(room) {
  var out = [];
  if (!room || !room.controller) return out;

  var all = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART) return false;
      if (room.controller.pos.getRangeTo(s) <= 1) return true;
      return false;
    }
  });

  for (var i = 0; i < all.length; i++) out.push(all[i]);
  return out;
}

function findAllWalls(room) {
  var out = [];
  if (!room) return out;

  var all = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (s.structureType === STRUCTURE_WALL) return true;
      return false;
    }
  });

  for (var i = 0; i < all.length; i++) out.push(all[i]);
  return out;
}

function findAllRamparts(room) {
  var out = [];
  if (!room) return out;

  var all = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (s.structureType === STRUCTURE_RAMPART) return true;
      return false;
    }
  });

  for (var i = 0; i < all.length; i++) out.push(all[i]);
  return out;
}

/**
 * Returns true when `target` is a valid match for the current demolition focus.
 * Used to invalidate stale cached targets that were picked up under a different
 * focus (or under no focus) so a wall-focused demolisher cannot keep dismantling
 * a rampart (or any other structure type) for several ticks.
 *
 *   'wall'       -> target must be STRUCTURE_WALL
 *   'rampart'    -> target must be STRUCTURE_RAMPART
 *   'controller' -> target must be STRUCTURE_WALL or STRUCTURE_RAMPART
 *   (none)       -> any target is fine
 */
function isFocusTarget(focus, target) {
  if (!focus) return true;
  if (focus === 'wall') return target.structureType === STRUCTURE_WALL;
  if (focus === 'rampart') return target.structureType === STRUCTURE_RAMPART;
  if (focus === 'controller') {
    return target.structureType === STRUCTURE_WALL || target.structureType === STRUCTURE_RAMPART;
  }
  return true;
}

const roleDemolition = {
  run: function(creep) {
    this.runDemolisher(creep);
  },

  runDemolisher: function(creep) {
    var targetRoom = creep.memory.targetRoom;
    var homeRoom = creep.memory.homeRoom;

    // If mission is complete: idle in place
    if (creep.memory.missionComplete) {
      if (isEdgeTile(creep.pos)) nudgeOffRoomEdge(creep);
      return;
    }

    // =========================================================================
    // BOOST PHASE — hold in home room until all compounds are applied.
    // Runs before travel so the creep never leaves without its boosts.
    // No unboost is performed; creeps die in the target room.
    // =========================================================================
    if (creep.memory.needsBoost) {
      this.handleBoosting(creep);
      return;
    }

    // Force new pathfinding if flag is set
    if (creep.memory.forceNewPath) {
      delete creep.memory.forceNewPath;
      console.log(`[Demolition] ${creep.name}: Forcing new pathfinding calculation`);
    }

    // Store current room for next tick's previous room tracking
    if (!creep.memory.previousRoom) {
      creep.memory.previousRoom = creep.room.name;
    }

    // If we just entered the target room on an edge tile, step inward before acting.
    // Do NOT apply this during inter-room travel - it would trap the creep at the exit forever.
    if (isEdgeTile(creep.pos) && creep.room.name === targetRoom) {
      nudgeOffRoomEdge(creep);
      return;
    }

    // Handle retreat state
    if (creep.memory.retreating) {
      return this.handleRetreat(creep);
    }

    // Check for hostile towers in current room (unless it's the target room)
    const shouldAvoidRoom = this.checkForHostileTowers(creep);
    if (shouldAvoidRoom) {
      creep.say('🚨 RETREAT!');
      creep.memory.retreating = true;
      creep.memory.retreatTarget = creep.memory.previousRoom || homeRoom;
      this.clearAllMovementCache(creep);
      return this.handleRetreat(creep);
    }

    // Update previous room tracking
    if (creep.memory.previousRoom !== creep.room.name) {
      creep.memory.previousRoom = creep.room.name;
    }

    // Check if current room is hard-banned (and we aren't retreating yet)
    if (isRoomBanned(creep.room.name, creep) && creep.room.name !== targetRoom) {
      creep.say('BAN');
      creep.memory.retreating = true;
      creep.memory.retreatTarget = homeRoom;
      this.clearAllMovementCache(creep);
      return this.handleRetreat(creep);
    }

    // Determine focus mode
    var focus = creep.memory.demolitionFocus;
    if (!focus) {
      var order = getOrderForRoom(targetRoom);
      if (order && order.focus) focus = order.focus;
      if (focus) creep.memory.demolitionFocus = focus;
    }

    // Phase 1: Move to target room - mirrors Attacker Phase 3 exactly
    if (targetRoom && creep.room.name !== targetRoom) {
      this.moveToAvoidingBlacklist(creep, new RoomPosition(25, 25, targetRoom), {
        visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' },
        range: 23
      });
      creep.say(`⚒️ ${targetRoom}`);
      return;
    }

    var room = Game.rooms[targetRoom];

    // Safety check - do not demolish friendly rooms
    if (room && room.controller && room.controller.owner) {
      if (room.controller.my) {
        logOnce(creep, 'abortOwn:' + targetRoom, '[Demolisher] ' + creep.name + ': Aborting - ' + targetRoom + ' is our own room');
        creep.memory.role = 'harvester';
        return;
      }

      if (iff.IFF_WHITELIST && iff.IFF_WHITELIST.indexOf(room.controller.owner.username) !== -1) {
        logOnce(creep, 'abortAlly:' + targetRoom, '[Demolisher] ' + creep.name + ': Aborting - ' + targetRoom + ' is owned by ally ' + room.controller.owner.username);
        creep.memory.role = 'harvester';
        return;
      }
    }

    // =========================================================================
    // Phase 2: In-room dismantle logic
    // =========================================================================

    // Heal self if damaged and has heal parts
    const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
    if (hasHealParts && creep.hits < creep.hitsMax) {
      creep.heal(creep);
      creep.say('🩹 HEAL');
    }

    // Recall cached target from last tick
    if (creep.memory.targetId && Game.time % 5 !== 0) {
      const cached = Game.getObjectById(creep.memory.targetId);
      if (cached) {
        // Invalidate cache if the cached target was picked up under a different
        // focus (or no focus) — prevents a wall-focused demolisher from
        // continuing to dismantle a rampart (or vice versa) for several ticks.
        if (!isFocusTarget(focus, cached)) {
          delete creep.memory.targetId;
        } else {
          this.dismantleTarget(creep, cached);
          return;
        }
      } else {
        delete creep.memory.targetId;
      }
    }

    let target = null;

    // ── Focus: wall ────────────────────────────────────────────────────────
    // Dismantle ONLY STRUCTURE_WALL; mission ends when none remain.
    if (focus === 'wall') {
      if (!room) {
        creep.moveTo(new RoomPosition(25, 25, targetRoom), { maxRooms: 1, range: 20 });
        creep.say('WALL');
        return;
      }

      const walls = findAllWalls(room);
      if (walls.length > 0) {
        target = creep.pos.findClosestByPath(walls) || creep.pos.findClosestByRange(walls);
        if (target) {
          creep.memory.targetId = target.id;
          creep.say('WALL');
          this.dismantleTarget(creep, target);
          return;
        }
      }

      completeDemolitionMission(creep, targetRoom, 'wall');
      creep.say('DONE');
      return;
    }

    // ── Focus: rampart ─────────────────────────────────────────────────────
    // Dismantle ONLY STRUCTURE_RAMPART; mission ends when none remain.
    if (focus === 'rampart') {
      if (!room) {
        creep.moveTo(new RoomPosition(25, 25, targetRoom), { maxRooms: 1, range: 20 });
        creep.say('RAMP');
        return;
      }

      const ramparts = findAllRamparts(room);
      if (ramparts.length > 0) {
        target = creep.pos.findClosestByPath(ramparts) || creep.pos.findClosestByRange(ramparts);
        if (target) {
          creep.memory.targetId = target.id;
          creep.say('🛡️ RAM');
          this.dismantleTarget(creep, target);
          return;
        }
      }

      completeDemolitionMission(creep, targetRoom, 'rampart');
      creep.say('DONE');
      return;
    }

    // ── Focus: controller ──────────────────────────────────────────────────
    // Dismantle ONLY walls/ramparts within range 1 of the controller; mission
    // ends when the controller ring is clear.
    if (focus === 'controller') {
      if (!room) {
        creep.moveTo(new RoomPosition(25, 25, targetRoom), { maxRooms: 1, range: 20 });
        creep.say('CTR');
        return;
      }

      const ringTargets = findControllerRingTargets(room);
      if (ringTargets.length > 0) {
        target = creep.pos.findClosestByPath(ringTargets) || creep.pos.findClosestByRange(ringTargets);
        if (target) {
          creep.memory.targetId = target.id;
          creep.say('CTR');
          this.dismantleTarget(creep, target);
          return;
        }
      }

      completeDemolitionMission(creep, targetRoom, 'controller');
      creep.say('DONE');
      return;
    }

    // ── Default targeting: ramparts first, then other hostile structures ───
    if (room) {
      const ramparts = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_RAMPART
      });

      if (ramparts.length > 0) {
        target = creep.pos.findClosestByPath(ramparts) || creep.pos.findClosestByRange(ramparts);
        if (target) {
          creep.memory.targetId = target.id;
          creep.say('RAM');
          this.dismantleTarget(creep, target);
          return;
        }
      }

      const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType !== STRUCTURE_CONTROLLER
      });

      if (hostileStructures.length > 0) {
        target = creep.pos.findClosestByPath(hostileStructures) || creep.pos.findClosestByRange(hostileStructures);
        if (target) {
          creep.memory.targetId = target.id;
          creep.say('DIS');
          this.dismantleTarget(creep, target);
          return;
        }
      }
    }

    completeDemolitionMission(creep, targetRoom, 'cleared');
    creep.say('DONE');
  },

  // ==========================================================================
  // handleBoosting — seek boost labs and apply all compounds before leaving.
  //
  // Reads creep.memory.boostLabs ({ compound: [labId, ...] }) set at spawn
  // time by boostManager.getSpawnBoostMeta(). Works through each compound
  // one at a time; pre-selects the first lab that is actually stocked with
  // the compound so the creep never walks toward an empty lab and bounces.
  // Marks each compound done in creep.memory.boosted. Clears needsBoost
  // once all compounds are handled.
  //
  // ERR_NOT_ENOUGH_RESOURCES means labBot hasn't finished loading yet —
  // the creep waits at the lab. It only skips a compound if NO lab has any
  // stock at all (boost order was cancelled or never started).
  // ==========================================================================
  handleBoosting: function(creep) {
    var boostLabs = creep.memory.boostLabs;
    if (!boostLabs) {
      // No lab data — nothing to do, proceed normally
      creep.memory.needsBoost = false;
      return;
    }

    if (!creep.memory.boosted) creep.memory.boosted = {};

    // Find the first compound that hasn't been boosted yet
    var pendingCompound = null;
    for (var compound in boostLabs) {
      if (!creep.memory.boosted[compound]) {
        pendingCompound = compound;
        break;
      }
    }

    // All compounds handled — release the creep
    if (!pendingCompound) {
      creep.memory.needsBoost = false;
      console.log('[Demolition] ' + creep.name + ': fully boosted, heading to target');
      return;
    }

    var labIds = boostLabs[pendingCompound];

    // Determine how many units are required to boost all relevant body parts.
    // Each part needs 30 units. Look up which body part type this compound
    // boosts via the BOOSTS constant so we don't need a hardcoded mapping.
    var boostPartType = null;
    for (var partType in BOOSTS) {
      if (BOOSTS[partType][pendingCompound]) {
        boostPartType = partType;
        break;
      }
    }

    var partsToBoost = 0;
    if (boostPartType) {
      for (var b = 0; b < creep.body.length; b++) {
        // Only count parts that haven't already been boosted with this compound
        if (creep.body[b].type === boostPartType && creep.body[b].boost !== pendingCompound) {
          partsToBoost++;
        }
      }
    }

    var requiredAmount = partsToBoost * 30;

    // Pre-select the first lab that has enough stock to cover all body parts.
    // Labs with some stock but not enough (e.g. still being loaded by labBot)
    // are skipped here so the creep never commits to a lab it can't use.
    var chosenLab = null;
    var partialLab = null; // track a partial lab as fallback for waiting
    for (var i = 0; i < labIds.length; i++) {
      var candidate = Game.getObjectById(labIds[i]);
      if (!candidate) continue;
      if (candidate.mineralType !== pendingCompound) continue;
      var stock = candidate.store[pendingCompound] || 0;
      if (stock >= requiredAmount) {
        chosenLab = candidate;
        break;
      }
      // Remember the best partial lab (most stock) so we can wait near it
      if (stock > 0 && (!partialLab || stock > (partialLab.store[pendingCompound] || 0))) {
        partialLab = candidate;
      }
    }

    // If no fully-stocked lab yet but labBot is loading one, wait near it
    if (!chosenLab && partialLab) {
      logOnce(creep, 'boostWait:' + pendingCompound,
        '[Demolition] ' + creep.name + ': waiting for ' + pendingCompound +
        ' lab to finish loading (have ' + (partialLab.store[pendingCompound] || 0) +
        ', need ' + requiredAmount + ')');
      creep.say('⏳ LAB');
      if (creep.pos.getRangeTo(partialLab) > 1) {
        creep.moveTo(partialLab, {
          visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dashed' },
          reusePath: 5
        });
      }
      return;
    }

    if (chosenLab) {
      var result = chosenLab.boostCreep(creep);

      if (result === OK) {
        creep.memory.boosted[pendingCompound] = true;
        creep.say('⚗️ BOOST');
        return;
      }

      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(chosenLab, {
          visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dashed' },
          reusePath: 5
        });
        creep.say('⚗️ GO');
        return;
      }

      // Any other error (e.g. ERR_INVALID_TARGET): fall through to skip below
    }

    // No lab has any stock at all for this compound — the boost order was
    // likely cancelled or never started. Skip rather than stall forever.
    logOnce(creep, 'boostSkip:' + pendingCompound,
      '[Demolition] ' + creep.name + ': no lab stocked for ' + pendingCompound + ', skipping');
    creep.memory.boosted[pendingCompound] = true;
  },

  // ==========================================================================
  // dismantleTarget - mirrors the Attacker's in-room attack logic exactly.
  //
  // 1. Try a direct path to the target (walls/ramparts impassable at cost 255).
  // 2. If that path is empty (we're walled off), re-path treating walls as cost 1.
  // 3. Walk the wall-path and collect every wall/rampart structure on each step.
  // 4. Dismantle the weakest blocker first so we carve our own path.
  // 5. If no blockers found, move normally toward the original target.
  // ==========================================================================
  dismantleTarget: function(creep, target) {
    // Step 1: Try direct path avoiding walls
    const standardRoomCallback = () => {
      const matrix = new PathFinder.CostMatrix();
      const room = Game.rooms[creep.room.name];
      if (room) {
        room.find(FIND_STRUCTURES).forEach(s => {
          if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
            matrix.set(s.pos.x, s.pos.y, 255);
          }
        });
      }
      return matrix;
    };

    const standardPathRes = PathFinder.search(
      creep.pos, { pos: target.pos, range: 1 },
      {
        maxOps: 1000,
        plainCost: 10,
        swampCost: 25,
        roomCallback: standardRoomCallback
      }
    );

    // Step 2: If direct path is blocked, find the blocker via wall-permissive path
    if (standardPathRes.path.length === 0) {
      const wallRoomCallback = () => {
        const matrix = new PathFinder.CostMatrix();
        const room = Game.rooms[creep.room.name];
        if (room) {
          room.find(FIND_STRUCTURES).forEach(s => {
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
              matrix.set(s.pos.x, s.pos.y, 1);
            }
          });
        }
        return matrix;
      };

      const wallPathRes = PathFinder.search(
        creep.pos, { pos: target.pos, range: 1 },
        {
          maxOps: 1000,
          plainCost: 1,
          swampCost: 5,
          roomCallback: wallRoomCallback
        }
      );

      // Step 3: Collect blocker structures along the wall-permissive path
      const blockers = [];
      for (const step of wallPathRes.path) {
        const structs = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
        for (const s of structs) {
          if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
            blockers.push(s);
          }
        }
      }

      // Step 4: Target the weakest blocker
      if (blockers.length) {
        target = blockers.reduce((weakest, s) => s.hits < weakest.hits ? s : weakest, blockers[0]);
        creep.memory.targetId = target.id;
        creep.say('🪨 BUST');
      }
    }

    // Step 5: Dismantle (or move to) the resolved target
    const result = creep.dismantle(target);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: '#ffaa00' } });
    } else if (result === ERR_NO_BODYPART) {
      logOnce(creep, 'noWork:' + creep.name, '[Demolition] ' + creep.name + ': Cannot dismantle (no WORK parts)');
      creep.say('WORK');
    }
  },

  // ==========================================================================
  // NAVIGATION SYSTEM (Unified exactly with Attacker)
  // ==========================================================================

  moveToAvoidingBlacklist: function(creep, target, opts = {}) {
    const hasBlacklist = creep.memory.blacklistedRooms && creep.memory.blacklistedRooms.length > 0;
    const hasBanned = BANNED_ROOMS && BANNED_ROOMS.length > 0;

    // Mirrors Attacker: if no banned/blacklisted rooms, use normal moveTo for efficiency
    if (!hasBlacklist && !hasBanned) {
      return creep.moveTo(target, opts);
    }

    const targetPos = target.pos || target;
    const goals = [{ pos: targetPos, range: opts.range || 1 }];

    const result = PathFinder.search(creep.pos, goals, {
      maxOps: opts.maxOps || 4000,
      maxRooms: opts.maxRooms || 16,
      plainCost: opts.plainCost || 1,
      swampCost: opts.swampCost || 5,
      roomCallback: this.getAvoidanceRoomCallback(creep)
    });

    if (result.incomplete) {
      console.log(`[Demolition] ${creep.name}: PathFinder incomplete, avoiding: ${JSON.stringify(creep.memory.blacklistedRooms)} / ${JSON.stringify(BANNED_ROOMS)}`);
    }

    if (result.path && result.path.length > 0) {
      const nextStep = result.path[0];
      const direction = creep.pos.getDirectionTo(nextStep);

      if (opts.visualizePathStyle) {
        // Only draw steps that are in the current room — foreign-room coordinates
        // share the same 0-49 x/y space and would render as nonsensical crossing lines.
        const localSteps = result.path.filter(p => p.roomName === creep.room.name);
        if (localSteps.length > 0) {
          creep.room.visual.poly(localSteps, opts.visualizePathStyle);
        }
      }

      if (isRoomBanned(nextStep.roomName, creep)) {
        console.log(`[Demolition] ${creep.name}: ERROR - PathFinder trying to go to banned room ${nextStep.roomName}!`);
        return ERR_NO_PATH;
      }

      return creep.move(direction);
    }

    return ERR_NO_PATH;
  },

  clearAllMovementCache: function(creep) {
    delete creep.memory._move;
    delete creep.memory._path;
    delete creep.memory.pathToTarget;
    delete creep.memory.destination;

    creep.memory.forceNewPath = true;
    console.log(`[Demolition] ${creep.name}: Cleared all movement cache`);
  },

  handleRetreat: function(creep) {
    if (!creep.memory.retreatTarget) {
      creep.memory.retreatTarget = creep.memory.previousRoom || creep.memory.homeRoom;
    }

    // If still in a banned or blacklisted room, get out immediately
    if (isRoomBanned(creep.room.name, creep)) {
      const exitDir = creep.room.findExitTo(creep.memory.retreatTarget);
      if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
        const exit = creep.pos.findClosestByPath(exitDir);
        if (exit) {
          creep.moveTo(exit, { visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' } });
          creep.say('🏃 FLEE!');
          return;
        }
      }

      // Fallback: find any exit that doesn't lead to a banned room
      const exits = Game.map.describeExits(creep.room.name);
      for (const direction in exits) {
        const neighborRoom = exits[direction];
        if (isRoomBanned(neighborRoom, creep)) continue;

        const exitDirInt = parseInt(direction, 10);
        const exitFall = creep.pos.findClosestByPath(exitDirInt);
        if (exitFall) {
          creep.moveTo(exitFall, { visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' } });
          creep.say('🏃 FLEE!');
          return;
        }
      }
      return;
    }

    // Phase 2: Move away from the edge of the safe room
    const distanceFromEdge = Math.min(
      creep.pos.x,
      creep.pos.y,
      49 - creep.pos.x,
      49 - creep.pos.y
    );

    if (distanceFromEdge < 5) {
      const centerPos = new RoomPosition(25, 25, creep.room.name);
      creep.moveTo(centerPos, { visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dotted' } });
      creep.say('🛡️ SAFE');
      return;
    }

    // Phase 3: Heal up if damaged
    const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
    if (hasHealParts && creep.hits < creep.hitsMax) {
      creep.heal(creep);
      creep.say('🩹 HEAL');
      return;
    }

    // Phase 4: Wait a few ticks to ensure stable, then exit retreat mode
    if (!creep.memory.retreatTimer) {
      creep.memory.retreatTimer = Game.time;
    }

    if (Game.time - creep.memory.retreatTimer > 3) {
      delete creep.memory.retreating;
      delete creep.memory.retreatTarget;
      delete creep.memory.retreatTimer;

      this.clearAllMovementCache(creep);

      creep.say('✅ READY');
      console.log(`[Demolition] Creep ${creep.name} finished retreating.`);
    } else {
      creep.say(`⏳ ${3 - (Game.time - creep.memory.retreatTimer)}`);
    }
  },

  checkForHostileTowers: function(creep) {
    if (creep.room.name === creep.memory.targetRoom) {
      return false;
    }

    const towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: s => {
        if (s.structureType !== STRUCTURE_TOWER) return false;
        if (s.owner && iff.IFF_WHITELIST.includes(s.owner.username)) return false;
        return true;
      }
    });

    if (towers.length > 0) {
      if (!creep.memory.blacklistedRooms) {
        creep.memory.blacklistedRooms = [];
      }

      if (creep.memory.blacklistedRooms.indexOf(creep.room.name) === -1) {
        creep.memory.blacklistedRooms.push(creep.room.name);
        this.clearAllMovementCache(creep);
        console.log(`[Demolition] Creep ${creep.name} blacklisted room ${creep.room.name} due to hostile towers`);
      }
      return true;
    }
    return false;
  },

  getAvoidanceRoomCallback: function(creep) {
    return function(roomName) {
      if (isRoomBanned(roomName, creep) && roomName !== creep.memory.targetRoom) {
        return false; // Completely block the room
      }

      const matrix = new PathFinder.CostMatrix();
      const room = Game.rooms[roomName];
      if (room) {
        room.find(FIND_STRUCTURES).forEach(s => {
          if (s.structureType === STRUCTURE_ROAD) {
            // Prefer roads
            matrix.set(s.pos.x, s.pos.y, 1);
            return;
          }

          if (s.structureType === STRUCTURE_CONTAINER) {
            // Always walkable
            return;
          }

          if (s.structureType === STRUCTURE_RAMPART) {
            // Only passable if ours or explicitly public - ally ramparts that
            // aren't public are still physically blocked to us
            if (s.my || s.isPublic) return;
            matrix.set(s.pos.x, s.pos.y, 255);
            return;
          }

          // Everything else (walls, spawns, extensions, towers, storage, links,
          // labs, terminals — including friendly and IFF-ally structures) is impassable.
          matrix.set(s.pos.x, s.pos.y, 255);
        });
      }
      return matrix;
    };
  }
};

module.exports = roleDemolition;