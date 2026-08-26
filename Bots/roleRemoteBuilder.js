// LLM: Read docs/codex.js before reviewing or changing this file.
// roleRemoteBuilder.js
// Role dispatch: memory.role === 'remoteBuilder' -> roleRemoteBuilder.run(creep).
// Console globals: remoteBuilder, cancelRemoteBuilder, listRemoteBuilders
// Example: remoteBuilder('E1N1', 'E2N2', 2) - Dispatch remote builders to construct remote room
// Example: cancelRemoteBuilder('E1N1', 'E2N2') - Cancel remote builder order
// Example: listRemoteBuilders() - List all active remote builder orders
// Example: require('roleRemoteBuilder').run(creep);
//          and reuses roleBuilder logic inside the target room.
//   - roleRemoteBuilder.run(creep)
//   - If target room is avoided, never enter it (log and idle).
//   - While not in target room, compute a safe multiroom route that excludes avoided rooms,
//     then move to the closest exit toward the next allowed room.
//   - Once in the target room, delegate all work to roleBuilder.
//   - Prevent cross-room tasks by clearing tasks not in target room.
//   - UPDATED: If sources in target room are inaccessible while filling, return home for energy.
//   - UPDATED: If target room is owned by a friendly player (IFF whitelist), return home for energy.
//    remoteBuilder('SpawningRoom', 'WorkingRoom', Number) to CREATE or UPDATE an order.
//    cancelRemoteBuilder('SpawningRoom', 'WorkingRoom') to cancel an order.
//    listRemoteBuilders() to list active orders.
//   - Uses Game.map.findRoute + routeCallback with Infinity to avoid rooms.
//   - Uses "exit stepping" pattern for inter-room travel.
var roleBuilder = require("roleBuilder");
var iff = require("iff");
var getRoomState = require("getRoomState");
var REMOTE_AVOID_ROOMS = {
  E8N49: true,
  W8N49: true
};
function getSafeRoute(e, r) {
  return Game.map.findRoute(e, r, {
    routeCallback: function(e, r) {
      if (REMOTE_AVOID_ROOMS[e]) return Infinity;
      return 1;
    }
  });
}

function moveTowardRoomSafely(e, r) {
  if (REMOTE_AVOID_ROOMS[r]) {
    if (Game.time % 25 === 0) {
      console.log("[RemoteBuilder] Target room " + r + " is in avoid list. Holding at " + e.room.name + ".");
    }
    return;
  }
  var o = getSafeRoute(e.room.name, r);
  if (o === ERR_NO_PATH || !o || o.length === 0) {
    if (Game.time % 25 === 0) {
      console.log("[RemoteBuilder] No safe route from " + e.room.name + " to " + r + " (avoid list may block).");
    }
    return;
  }
  var m = o[0];
  var t = m.exit;
  var i = e.pos.findClosestByRange(t);
  if (i) {
    e.moveTo(i, {
      reusePath: 15
    });
  } else {
    var n = new RoomPosition(25, 25, e.room.name);
    e.moveTo(n, {
      reusePath: 10
    });
  }
}

function isFriendlyOwnedRoom(e) {
  if (!e || !e.controller) return false;
  if (e.controller.owner && iff.isFriendlyUsername(e.controller.owner.username)) {
    return true;
  }
  if (e.controller.reservation && iff.isFriendlyUsername(e.controller.reservation.username)) {
    return true;
  }
  return false;
}

var roleRemoteBuilder = {
  run: function(e) {
    if (e.memory && (e.memory.autoBuilderCancelled || Memory.autoBuilder && Memory.autoBuilder.cancelled && Memory.autoBuilder.cancelled[e.memory.targetRoom])) {
      return e.suicide();
    }
    var r = e.memory && e.memory.targetRoom ? e.memory.targetRoom : null;
    if (!e.memory.homeRoom) {
      e.memory.homeRoom = e.room.name;
    }
    if (!r) {
      roleBuilder.run(e);
      return;
    }
    if (e.memory.filling && e.store.getFreeCapacity() === 0) {
      e.memory.filling = false;
      delete e.memory.harvestSourceId;
      delete e.memory.harvestSourceRoomName;
      if (e.memory.returningHome) {
        delete e.memory.returningHome;
      }
    }
    if (!e.memory.filling && e.store[RESOURCE_ENERGY] === 0) {
      e.memory.filling = true;
      delete e.memory.harvestSourceId;
      delete e.memory.harvestSourceRoomName;
    }
    if (e.memory.filling && e.room.name === r) {
      if (!e.memory.returningHome) {
        if (isFriendlyOwnedRoom(e.room)) {
          e.memory.returningHome = true;
          delete e.memory.energyTargetId;
          console.log("[RemoteBuilder] " + e.name + " in friendly room " + r + ". Returning to " + e.memory.homeRoom + " for energy.");
        } else {
          var o = e.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
          var m = e.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: function(r) {
              return (r.structureType === STRUCTURE_CONTAINER || r.structureType === STRUCTURE_STORAGE) && r.store[RESOURCE_ENERGY] >= e.store.getCapacity(RESOURCE_ENERGY);
            }
          });
          if (!o && !m) {
            e.memory.returningHome = true;
            delete e.memory.energyTargetId;
            console.log("[RemoteBuilder] " + e.name + " cannot access energy in " + r + ". Returning to " + e.memory.homeRoom);
          }
        }
      }
    }
    var t = r;
    if (e.memory.returningHome) {
      t = e.memory.homeRoom;
    }
    if (e.room.name !== t) {
      if (e.memory && e.memory.task && e.memory.task.roomName && e.memory.task.roomName !== t) {
        delete e.memory.task;
      }
      moveTowardRoomSafely(e, t);
      return;
    }
    if (e.memory && e.memory.task && e.memory.task.roomName && e.memory.task.roomName !== e.room.name) {
      delete e.memory.task;
    }
    if (e.memory && e.memory.energyTargetId) {
      var i = Game.getObjectById(e.memory.energyTargetId);
      if (!i || i.pos && i.pos.roomName && i.pos.roomName !== e.room.name) {
        delete e.memory.energyTargetId;
      }
    }
    roleBuilder.run(e);
    if (e.memory && e.memory.task && e.memory.task.roomName && e.memory.task.roomName !== e.room.name) {
      delete e.memory.task;
    }
  }
};
module.exports = roleRemoteBuilder;
global.remoteBuilder = function(e, r, o) {
  if (!e || !r || !o || parseInt(o, 10) <= 0) {
    return "[RemoteBuilder] Invalid command. Use: remoteBuilder('homeRoom', 'targetRoom', count)";
  }
  var m = Game.rooms[e];
  if (!m || !m.controller || !m.controller.my) {
    return "[RemoteBuilder] Invalid home room: " + e + ". Must be a room you own.";
  }
  if (!Memory.remoteBuilderOrders) Memory.remoteBuilderOrders = {};
  var t = e + "->" + r;
  var i = Memory.remoteBuilderOrders[t];
  if (i) {
    if (i.autoBuilder === undefined) i.autoBuilder = false;
    i.count = parseInt(o, 10);
    i.updatedAt = Game.time;
    return "[RemoteBuilder] Updated order " + t + " to count=" + i.count;
  } else {
    Memory.remoteBuilderOrders[t] = {
      homeRoom: e,
      targetRoom: r,
      count: parseInt(o, 10),
      autoBuilder: false,
      createdAt: Game.time,
      updatedAt: Game.time
    };
    return "[RemoteBuilder] Order created: " + t + " with count=" + o;
  }
};
global.cancelRemoteBuilder = function(e, r) {
  if (!e || !r) {
    return "[RemoteBuilder] Invalid command. Use: cancelRemoteBuilder('homeRoom', 'targetRoom')";
  }
  if (!Memory.remoteBuilderOrders) return "[RemoteBuilder] No remote builder orders exist.";
  var o = e + "->" + r;
  if (!Memory.remoteBuilderOrders[o]) {
    return "[RemoteBuilder] No order found for " + o + ".";
  }
  delete Memory.remoteBuilderOrders[o];
  return "[RemoteBuilder] Cancelled order for " + o + ". Existing creeps will not be replaced.";
};
global.listRemoteBuilders = function() {
  if (!Memory.remoteBuilderOrders || Object.keys(Memory.remoteBuilderOrders).length === 0) {
    return "[RemoteBuilder] No active remote builder orders.";
  }
  var e = [];
  for (var r in Memory.remoteBuilderOrders) {
    var o = Memory.remoteBuilderOrders[r];
    var m = _.filter(getRoomState.creepIndex().all, function(e) {
      return e.memory && e.memory.role === "remoteBuilder" && e.memory.homeRoom === o.homeRoom && e.memory.targetRoom === o.targetRoom;
    }).length;
    e.push(o.homeRoom + " -> " + o.targetRoom + " | desired=" + o.count + " | living=" + m + " | key=" + r);
  }
  return e.join(" || ");
};
