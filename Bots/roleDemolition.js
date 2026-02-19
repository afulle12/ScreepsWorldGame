//    orderDemolition('E1S1', 'E2S2', 2) - Orders 2 demolition teams from E1S1 to demolish E2S2
//    orderDemolition('E1S1', 'E2S2', 2, 'controller') - Prioritize dismantling walls/ramparts within range 1 of the controller
//    orderDemolition('E1S1', 'E2S2', 2, 'wall') - Prioritize dismantling ALL STRUCTURE_WALL in the target room (mission ends when none remain)
//    cancelDemolitionOrder('E2S2') - Cancels the demolition operation against E2S2
// Notes:
// - Adds banned rooms list at top.
// - Optional focus:
//   - 'controller' -> prioritize walls/ramparts within range 1 of target room controller.
//   - 'wall' -> dismantle ONLY STRUCTURE_WALL in the target room; do not dismantle other structures; mission is complete only when the room has zero STRUCTURE_WALL.
// - No optional chaining used.
// - In-room navigation avoids room edges; creeps step inward if sitting on an edge.
// - Pathing wrapper uses maxRooms: 1 and bans edge tiles (except the specific edge exit tile used to cross rooms).
// - If in-room pathing returns ERR_NO_PATH, a controlled cross-room fallback is attempted to route around terrain partitions.
// - Cross-room routing avoids banned rooms using routeCallback.
// - Demolishers have NO CARRY parts. All carry/withdraw/transfer/pickup/drop logic removed.
// - Mission completion attempts to delete the matching demolition order from Memory.demolitionOrders.
// - Console logging reduced (only important one-time events are logged).
// - IMPORTANT: Completed demolishers idle in place (they do NOT auto-return home).

const iff = require('iff');

// == BANNED ROOMS (edit this list to keep demolition teams out) ==
const BANNED_ROOMS = [
  'E8N49', 'E3N47', 'E9N51'
];

function isRoomBanned(roomName) {
  for (var i = 0; i < BANNED_ROOMS.length; i++) {
    if (BANNED_ROOMS[i] === roomName) return true;
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
  }
}

function isNearRoomEdge(pos, margin) {
  margin = margin || 2;
  return (
    pos.x < margin ||
    pos.x > 49 - margin ||
    pos.y < margin ||
    pos.y > 49 - margin
  );
}

function isEdgeTile(pos) {
  if (!pos) return false;
  if (pos.x === 0) return true;
  if (pos.x === 49) return true;
  if (pos.y === 0) return true;
  if (pos.y === 49) return true;
  return false;
}

function getTargetPos(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (typeof target.x === 'number' && typeof target.y === 'number' && target.roomName) return target;
  return null;
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

function applyEdgeBan(costMatrix, allowedEdgePos) {
  for (var x = 0; x < 50; x++) {
    costMatrix.set(x, 0, 255);
    costMatrix.set(x, 49, 255);
  }
  for (var y = 0; y < 50; y++) {
    costMatrix.set(0, y, 255);
    costMatrix.set(49, y, 255);
  }

  if (allowedEdgePos && isEdgeTile(allowedEdgePos)) {
    var cur = costMatrix.get(allowedEdgePos.x, allowedEdgePos.y);
    if (cur < 255) costMatrix.set(allowedEdgePos.x, allowedEdgePos.y, 1);
  }
}

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
      if (s.my || s.isPublic) {
        continue;
      } else {
        matrix.set(s.pos.x, s.pos.y, 255);
        continue;
      }
    }

    if (s.structureType === STRUCTURE_WALL) {
      if (typeof s.hits === 'undefined') {
        continue;
      }
      matrix.set(s.pos.x, s.pos.y, 255);
      continue;
    }

    matrix.set(s.pos.x, s.pos.y, 255);
  }
}

function moveToWithinRoom(creep, target, opts) {
  if (isNearRoomEdge(creep.pos, 1)) {
    if (nudgeOffRoomEdge(creep)) return;
  }

  var mopts = opts || {};
  mopts.maxRooms = 1;

  var tpos = getTargetPos(target);

  var targetOnEdge = false;
  if (tpos && tpos.roomName === creep.room.name) targetOnEdge = isEdgeTile(tpos);

  var isStructure = false;
  if (target && target.structureType) isStructure = true;

  if (typeof mopts.range === 'undefined' || mopts.range === null) {
    if (isStructure) mopts.range = 1;
    else mopts.range = 0;
  }

  var allowEdgeTarget = false;
  if (mopts.allowEdgeTarget === true) allowEdgeTarget = true;

  mopts.costCallback = function(roomName, costMatrix) {
    stampTerrainToMatrix(roomName, costMatrix);

    var room = Game.rooms[roomName];
    if (room) stampStructuresToMatrix(room, costMatrix);

    if (roomName === creep.room.name) {
      var allowed = null;
      if (allowEdgeTarget && targetOnEdge && tpos && tpos.roomName === roomName) allowed = tpos;
      applyEdgeBan(costMatrix, allowed);
    }
  };

  mopts.ignoreDestructibleStructures = false;

  var mv = creep.moveTo(target, mopts);

  if (mv === ERR_NO_PATH && mopts.allowCrossRoomFallback) {
    var mr = 4;
    if (mopts.maxRoomsFallback && mopts.maxRoomsFallback > 1) mr = mopts.maxRoomsFallback;

    var fb = {
      maxRooms: mr,
      visualizePathStyle: mopts.visualizePathStyle,
      reusePath: mopts.reusePath || 5,
      range: mopts.range,
      ignoreDestructibleStructures: false,
      costCallback: function(roomName, costMatrix) {
        stampTerrainToMatrix(roomName, costMatrix);

        var room2 = Game.rooms[roomName];
        if (room2) stampStructuresToMatrix(room2, costMatrix);
      }
    };
    creep.moveTo(target, fb);
  }
}

function moveToRoomAvoidingBanned(creep, targetRoom, opts) {
  if (creep.room.name === targetRoom) return false;

  if (isRoomBanned(targetRoom)) {
    creep.say('BAN');
    logOnce(creep, 'banTarget:' + targetRoom, '[Demolition] ' + creep.name + ': Target room ' + targetRoom + ' is banned; aborting travel');
    return true;
  }

  var route = Game.map.findRoute(creep.room.name, targetRoom, {
    routeCallback: function(roomName) {
      if (isRoomBanned(roomName)) return Infinity;
      return 1;
    }
  });

  if (route === ERR_NO_PATH || !route || !route.length) {
    logOnce(creep, 'noRoute:' + creep.room.name + '->' + targetRoom, '[Demolition] ' + creep.name + ': No safe route to ' + targetRoom);
    return true;
  }

  var nextHop = route[0];
  var exitDir = Game.map.findExit(creep.room, nextHop.room);
  if (exitDir === ERR_NO_PATH) {
    logOnce(creep, 'noExit:' + creep.room.name + '->' + nextHop.room, '[Demolition] ' + creep.name + ': No exit toward ' + nextHop.room);
    return true;
  }

  var exit = creep.pos.findClosestByRange(exitDir);
  if (exit) {
    var mopts = opts || {};
    mopts.allowEdgeTarget = true;
    moveToWithinRoom(creep, exit, mopts);
    return true;
  }

  return true;
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

    // Hard rule: if we are sitting on an edge tile, step inward and do nothing else this tick
    if (isEdgeTile(creep.pos)) {
      nudgeOffRoomEdge(creep);
      return;
    }

    // If we are in a banned room, leave toward home if possible
    if (isRoomBanned(creep.room.name)) {
      creep.say('OUT');
      if (homeRoom && !isRoomBanned(homeRoom)) {
        moveToRoomAvoidingBanned(creep, homeRoom, { reusePath: 10 });
      } else {
        nudgeOffRoomEdge(creep);
      }
      return;
    }

    // Determine focus mode: prefer creep memory, then order memory
    var focus = creep.memory.demolitionFocus;
    if (!focus) {
      var order = getOrderForRoom(targetRoom);
      if (order && order.focus) focus = order.focus;
      if (focus) creep.memory.demolitionFocus = focus;
    }

    // Move to target room via safe route
    if (targetRoom && creep.room.name !== targetRoom) {
      var moved = moveToRoomAvoidingBanned(creep, targetRoom, { reusePath: 10 });
      if (moved) return;
    }

    var room = null;
    if (targetRoom) room = Game.rooms[targetRoom];

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

    // Focus: wall
    // Mission is complete only when we have visibility of the target room AND there are zero STRUCTURE_WALL.
    if (focus === 'wall') {
      if (!targetRoom) {
        // No target means we cannot make progress
        creep.say('NO');
        return;
      }

      if (creep.room.name !== targetRoom) {
        // Travel handled above, but keep this guard
        return;
      }

      // If for some reason room object is not available yet, do not complete
      if (!room) {
        var mid = new RoomPosition(25, 25, targetRoom);
        moveToWithinRoom(creep, mid, { reusePath: 5 });
        creep.say('WALL');
        return;
      }

      var walls = findAllWalls(room);
      if (walls.length > 0) {
        var wTarget = creep.pos.findClosestByPath(walls);
        if (!wTarget) wTarget = creep.pos.findClosestByRange(walls);

        if (!wTarget) {
          // We see walls but cannot pick one, do not complete
          var mid2 = new RoomPosition(25, 25, targetRoom);
          moveToWithinRoom(creep, mid2, { reusePath: 5 });
          creep.say('WALL');
          return;
        }

        var dmw = creep.dismantle(wTarget);
        if (dmw === ERR_NOT_IN_RANGE) {
          moveToWithinRoom(creep, wTarget, {
            allowCrossRoomFallback: true,
            maxRoomsFallback: 4,
            range: 1,
            reusePath: 5
          });
          creep.say('WALL');
          return;
        }

        if (dmw === ERR_NO_BODYPART) {
          logOnce(creep, 'noWork:' + creep.name, '[Demolition] ' + creep.name + ': Cannot dismantle (no WORK parts)');
          creep.say('WORK');
          return;
        }

        if (dmw === OK) {
          creep.say('HIT');
          return;
        }

        return;
      }

      // Only here is the wall mission complete
      completeDemolitionMission(creep, targetRoom, 'wall');
      creep.say('DONE');
      return;
    }

    // Focus: controller ring first
    if (focus === 'controller') {
      if (room) {
        var ringTargets = findControllerRingTargets(room);
        if (ringTargets.length > 0) {
          var ringTarget = creep.pos.findClosestByPath(ringTargets);
          if (!ringTarget) ringTarget = creep.pos.findClosestByRange(ringTargets);

          var dm0 = creep.dismantle(ringTarget);
          if (dm0 === ERR_NOT_IN_RANGE) {
            moveToWithinRoom(creep, ringTarget, {
              allowCrossRoomFallback: true,
              maxRoomsFallback: 4,
              range: 1,
              reusePath: 5
            });
            creep.say('CTR');
          } else if (dm0 === OK) {
            creep.say('R1');
          }
          return;
        }
      }
    }

    // Default targeting: ramparts first, then other hostile structures
    var ramparts = [];
    if (room) {
      ramparts = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(s) {
          if (s.structureType === STRUCTURE_RAMPART) return true;
          return false;
        }
      });
    }

    if (ramparts.length > 0) {
      var target = creep.pos.findClosestByPath(ramparts);
      if (!target) target = creep.pos.findClosestByRange(ramparts);

      var resultDis = creep.dismantle(target);
      if (resultDis === ERR_NOT_IN_RANGE) {
        moveToWithinRoom(creep, target, {
          allowCrossRoomFallback: true,
          maxRoomsFallback: 4,
          range: 1,
          reusePath: 5
        });
        creep.say('MOVE');
      } else if (resultDis === OK) {
        creep.say('RAM');
      }
      return;
    }

    var hostileStructures = [];
    if (room) {
      hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(s) {
          if (s.structureType !== STRUCTURE_CONTROLLER) return true;
          return false;
        }
      });
    }

    if (hostileStructures.length > 0) {
      var target2 = creep.pos.findClosestByPath(hostileStructures);
      if (!target2) target2 = creep.pos.findClosestByRange(hostileStructures);

      var dm = creep.dismantle(target2);
      if (dm === ERR_NOT_IN_RANGE) {
        moveToWithinRoom(creep, target2, {
          allowCrossRoomFallback: true,
          maxRoomsFallback: 4,
          range: 1,
          reusePath: 5
        });
      } else if (dm === OK) {
        creep.say('DIS');
      }
      return;
    }

    completeDemolitionMission(creep, targetRoom, 'cleared');
    creep.say('DONE');
  }
};

module.exports = roleDemolition;
