//    orderDemolition('E1S1', 'E2S2', 2) - Orders 2 demolition teams from E1S1 to demolish E2S2
//    orderDemolition('E1S1', 'E2S2', 2, 'controller') - Prioritize dismantling walls/ramparts within range 1 of the controller
//    cancelDemolitionOrder('E2S2') - Cancels the demolition operation against E2S2
// Notes:
// - Adds banned rooms list at top.
// - Optional focus: 'controller' -> prioritize walls/ramparts within range 1 of target room controller.
// - No optional chaining used.
// - In-room navigation avoids room edges; creeps step inward if sitting on an edge.
// - Pathing wrapper uses maxRooms: 1 and edge penalties (builder-style).
// - If in-room pathing returns ERR_NO_PATH, a controlled cross-room fallback is attempted to route around terrain partitions.
// - Cross-room routing avoids banned rooms using routeCallback.
// - Demolishers have NO CARRY parts. All carry/withdraw/transfer/pickup/drop logic removed.
// - Pathing hardening: treat destructible structures as obstacles via cost matrix and ignoreDestructibleStructures:false, and default to range:1 vs structures.

const iff = require('iff');

// == BANNED ROOMS (edit this list to keep demolition teams out) ==
const BANNED_ROOMS = [
  'E8N49', 'E3N47'
];

// == Helper: is a room banned? ==
function isRoomBanned(roomName) {
  for (var i = 0; i < BANNED_ROOMS.length; i++) {
    if (BANNED_ROOMS[i] === roomName) return true;
  }
  return false;
}

// == Helper: is a position within N tiles of the room edge? ==
function isNearRoomEdge(pos, margin) {
  margin = margin || 2; // default to 2 tiles
  return (
    pos.x < margin ||
    pos.x > 49 - margin ||
    pos.y < margin ||
    pos.y > 49 - margin
  );
}

// == Helper: nudge off room edges (single-step inward) ==
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

// == Pathing: discourage edge tiles for in-room navigation ==
function applyEdgePenalty(roomName, costMatrix) {
  for (var x = 0; x < 50; x++) {
    costMatrix.set(x, 0, 255);
    costMatrix.set(x, 49, 255);
    var c1 = costMatrix.get(x, 1);
    var c48 = costMatrix.get(x, 48);
    costMatrix.set(x, 1, Math.max(c1, 10));
    costMatrix.set(x, 48, Math.max(c48, 10));
  }
  for (var y = 0; y < 50; y++) {
    costMatrix.set(0, y, 255);
    costMatrix.set(49, y, 255);
    var c2 = costMatrix.get(1, y);
    var c47 = costMatrix.get(48, y);
    costMatrix.set(1, y, Math.max(c2, 10));
    costMatrix.set(48, y, Math.max(c47, 10));
  }
}

// == Stamp terrain walls into cost matrix ==
function stampTerrainToMatrix(roomName, matrix) {
  var terrain = Game.map.getRoomTerrain(roomName);
  for (var x = 0; x < 50; x++) {
    for (var y = 0; y < 50; y++) {
      var terrainType = terrain.get(x, y);
      if (terrainType === TERRAIN_MASK_WALL) {
        matrix.set(x, y, 255);
      }
    }
  }
}

// == Build a structure-aware matrix for a room (roads low cost, most structures blocked) ==
function stampStructuresToMatrix(room, matrix) {
  if (!room) return;

  var structures = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structures.length; i++) {
    var s = structures[i];

    if (s.structureType === STRUCTURE_ROAD) {
      var cur = matrix.get(s.pos.x, s.pos.y);
      if (cur > 1) matrix.set(s.pos.x, s.pos.y, 1);
      continue;
    }

    if (s.structureType === STRUCTURE_CONTAINER) {
      var cur2 = matrix.get(s.pos.x, s.pos.y);
      if (cur2 < 5) matrix.set(s.pos.x, s.pos.y, 5);
      continue;
    }

    if (s.structureType === STRUCTURE_RAMPART) {
      // Only our/public ramparts are passable
      if (s.my || s.isPublic) {
        continue;
      } else {
        matrix.set(s.pos.x, s.pos.y, 255);
        continue;
      }
    }

    // Handle walls: skip indestructible walls (terrain handles them)
    if (s.structureType === STRUCTURE_WALL) {
      // Indestructible walls have no hits property
      if (typeof s.hits === 'undefined') {
        continue;
      }
      // Destructible walls are unwalkable
      matrix.set(s.pos.x, s.pos.y, 255);
      continue;
    }

    // Everything else (extensions, spawns, towers, etc.) is unwalkable
    matrix.set(s.pos.x, s.pos.y, 255);
  }
}

// == Wrapper: in-room move that avoids edges and treats structures as obstacles ==
// Default range: 1 when target is a structure (prevents "through-wall" paths).
// Fallback to cross-room path if ERR_NO_PATH (to route around terrain partitions).
function moveToWithinRoom(creep, target, opts) {
  if (isNearRoomEdge(creep.pos, 1)) {
    if (nudgeOffRoomEdge(creep)) return;
  }

  var mopts = opts || {};
  mopts.maxRooms = 1;

  var targetOnEdge = false;
  if (target && target.pos && target.pos.roomName === creep.room.name) {
    targetOnEdge = isNearRoomEdge(target.pos, 1);
  }

  var isStructure = false;
  if (target && target.structureType) {
    isStructure = true;
  }

  if (typeof mopts.range === 'undefined' || mopts.range === null) {
    mopts.range = (isStructure && !targetOnEdge) ? 1 : 0;
  }

  // Enforce destructible structures as obstacles and add our edge penalties
  mopts.costCallback = function(roomName, costMatrix) {
    // MUST stamp terrain first, before anything else
    stampTerrainToMatrix(roomName, costMatrix);

    var room = Game.rooms[roomName];
    if (room) {
      stampStructuresToMatrix(room, costMatrix);
    }
    if (roomName === creep.room.name && !targetOnEdge) {
      applyEdgePenalty(roomName, costMatrix);
    }
  };

  // Make sure destructible structures are not ignored by the pathing
  mopts.ignoreDestructibleStructures = false; // prevents treating walls/ramparts as passable in planning

  var mv = creep.moveTo(target, mopts); // returns a status code

  // Controlled fallback if blocked by terrain partitions
  if (mv === ERR_NO_PATH && mopts.allowCrossRoomFallback) {
    var fb = {
      maxRooms: mopts.maxRoomsFallback && mopts.maxRoomsFallback > 1 ? mopts.maxRoomsFallback : 4,
      visualizePathStyle: mopts.visualizePathStyle,
      reusePath: mopts.reusePath || 5,
      range: mopts.range,
      ignoreDestructibleStructures: false,
      costCallback: function(roomName, costMatrix) {
        // MUST stamp terrain first
        stampTerrainToMatrix(roomName, costMatrix);

        var room = Game.rooms[roomName];
        if (room) stampStructuresToMatrix(room, costMatrix);
      }
    };
    creep.moveTo(target, fb); // try again with relaxed constraints
  }
}

// == Wrapper: cross-room move avoiding banned rooms ==
function moveToRoomAvoidingBanned(creep, targetRoom, opts) {
  if (creep.room.name === targetRoom) return false;
  if (isRoomBanned(targetRoom)) {
    creep.say('⛔ BAN');
    console.log('[Demolition] ' + creep.name + ': Target room ' + targetRoom + ' is banned, aborting travel');
    return true;
  }

  var route = Game.map.findRoute(creep.room.name, targetRoom, {
    routeCallback: function(roomName) {
      if (isRoomBanned(roomName)) return Infinity;
      return 1;
    }
  }); // routing API

  if (route === ERR_NO_PATH || !route || !route.length) {
    console.log('[Demolition] ' + creep.name + ': No safe route to ' + targetRoom);
    return true;
  }

  var nextHop = route[0];
  var exitDir = Game.map.findExit(creep.room, nextHop.room);
  if (exitDir === ERR_NO_PATH) {
    console.log('[Demolition] ' + creep.name + ': No exit toward ' + nextHop.room);
    return true;
  }

  var exit = creep.pos.findClosestByRange(exitDir);
  if (exit) {
    var mopts = opts || {};
    moveToWithinRoom(creep, exit, mopts);
    return true;
  }

  return true;
}

// == Focus helpers ==
function getOrderFocusForRoom(targetRoom) {
  var orders = Memory.demolitionOrders;
  if (!orders || !orders.length) return null;
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (o && o.targetRoom === targetRoom) {
      return o.focus || null;
    }
  }
  return null;
}

function findControllerRingTargets(room) {
  // Return all walls and ramparts within range 1 of the controller
  var out = [];
  if (!room || !room.controller) return out;

  var all = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART) return false;
      return room.controller.pos.getRangeTo(s) <= 1;
    }
  }); // find + range checks

  for (var i = 0; i < all.length; i++) out.push(all[i]);
  return out;
}

const roleDemolition = {
  /** @param {Creep} creep **/
  run: function(creep) {
    // Only demolisher behavior remains
    this.runDemolisher(creep);
  },

  runDemolisher: function(creep) {
    var targetRoom = creep.memory.targetRoom;
    var homeRoom = creep.memory.homeRoom;

    // If we are in a banned room, leave toward home if possible
    if (isRoomBanned(creep.room.name)) {
      creep.say('🚫 OUT');
      if (homeRoom && !isRoomBanned(homeRoom)) {
        moveToRoomAvoidingBanned(creep, homeRoom, { visualizePathStyle: { stroke: '#ff0000' } });
      } else {
        nudgeOffRoomEdge(creep);
      }
      return;
    }

    // Move to target room via safe route
    if (creep.room.name !== targetRoom) {
      var moved = moveToRoomAvoidingBanned(creep, targetRoom, { visualizePathStyle: { stroke: '#ff0000' } });
      if (moved) return;
    }

    var room = Game.rooms[targetRoom];

    // Safety check - don't demolish friendly rooms
    if (room && room.controller && room.controller.owner) {
      if (room.controller.my) {
        console.log('[Demolisher] ' + creep.name + ': Aborting - ' + targetRoom + ' is our own room!');
        creep.memory.role = 'harvester';
        return;
      }

      if (iff.IFF_WHITELIST && iff.IFF_WHITELIST.indexOf(room.controller.owner.username) !== -1) {
        console.log('[Demolisher] ' + creep.name + ': Aborting - ' + targetRoom + ' is owned by ally ' + room.controller.owner.username);
        creep.memory.role = 'harvester';
        return;
      }
    }

    // Determine focus mode: prefer creep memory, then order memory
    var focus = creep.memory.demolitionFocus;
    if (!focus) {
      focus = getOrderFocusForRoom(targetRoom);
    }

    // Focus: controller ring first (walls/ramparts within range 1 of controller)
    if (focus === 'controller') {
      var ringTargets = findControllerRingTargets(room);
      if (ringTargets && ringTargets.length > 0) {
        var ringTarget = creep.pos.findClosestByPath(ringTargets);
        if (!ringTarget) {
          ringTarget = creep.pos.findClosestByRange(ringTargets);
        }
        var dm0 = creep.dismantle(ringTarget);
        if (dm0 === ERR_NOT_IN_RANGE) {
          moveToWithinRoom(creep, ringTarget, {
            visualizePathStyle: { stroke: '#ff0000' },
            allowCrossRoomFallback: true,
            maxRoomsFallback: 4,
            range: 1
          });
          creep.say('🎯 CTR');
        } else if (dm0 === OK) {
          creep.say('🧱 R1');
        } else {
          console.log('[Demolisher] ' + creep.name + ': Controller ring dismantle failed: ' + dm0);
        }
        return;
      }
      // If no controller ring targets remain, continue with normal flow
    }

    // Simple targeting: Look for ramparts first, always
    var ramparts = room ? room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_RAMPART; }
    }) : [];
    if (ramparts.length > 0) {
      var target = creep.pos.findClosestByPath(ramparts);
      if (!target) target = creep.pos.findClosestByRange(ramparts);
      console.log('[Demolisher] ' + creep.name + ': Found ' + ramparts.length + ' ramparts, targeting closest');

      var resultDis = creep.dismantle(target);
      if (resultDis === ERR_NOT_IN_RANGE) {
        moveToWithinRoom(creep, target, {
          visualizePathStyle: { stroke: '#ff0000' },
          allowCrossRoomFallback: true,
          maxRoomsFallback: 4,
          range: 1
        });
        creep.say('➡️ MOVE');
      } else if (resultDis === OK) {
        creep.say('🛡️ RAM');
      } else {
        console.log('[Demolisher] ' + creep.name + ': Dismantle rampart failed: ' + resultDis);
      }
      return;
    }

    // If no ramparts, look for other hostile structures
    var hostileStructures = room ? room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s) { return s.structureType !== STRUCTURE_CONTROLLER; }
    }) : [];
    if (hostileStructures.length > 0) {
      var target2 = creep.pos.findClosestByPath(hostileStructures);
      if (!target2) target2 = creep.pos.findClosestByRange(hostileStructures);

      var dm = creep.dismantle(target2);
      if (dm === ERR_NOT_IN_RANGE) {
        moveToWithinRoom(creep, target2, {
          visualizePathStyle: { stroke: '#ff0000' },
          allowCrossRoomFallback: true,
          maxRoomsFallback: 4,
          range: 1
        });
      } else if (dm === OK) {
        creep.say('🔨 DIS');
      }
      return;
    }

    // Mission complete
    console.log('[Demolisher] ' + creep.name + ': No more targets in ' + targetRoom + ', mission complete');
    creep.memory.missionComplete = true;
    creep.say('✅ DONE');
  }
};

module.exports = roleDemolition;
