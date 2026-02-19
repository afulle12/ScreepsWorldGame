// roleRemoteBuilder.js
// Purpose: Remote builder wrapper that forces travel to a target room, avoids hard-coded rooms,
//          and reuses roleBuilder logic inside the target room.
// API:
//   - roleRemoteBuilder.run(creep)
// Behavior:
//   - If target room is avoided, never enter it (log and idle).
//   - While not in target room, compute a safe multiroom route that excludes avoided rooms,
//     then move to the closest exit toward the next allowed room.
//   - Once in the target room, delegate all work to roleBuilder.
//   - Prevent cross-room tasks by clearing tasks not in target room.
//   - UPDATED: If sources in target room are inaccessible while filling, return home for energy.
//   - UPDATED: If target room is owned by a friendly player (IFF whitelist), return home for energy.
//
//    remoteBuilder('SpawningRoom', 'WorkingRoom', Number) to create/update an order.
//    cancelRemoteBuilder('SpawningRoom', 'WorkingRoom') to cancel an order.
//    listRemoteBuilders() to list active orders.

// Notes:
//   - Uses Game.map.findRoute + routeCallback with Infinity to avoid rooms.
//   - Uses "exit stepping" pattern for inter-room travel.

var roleBuilder = require('roleBuilder');
var iff = require('iff');

// Hard-coded rooms to avoid (edit to your needs)
var REMOTE_AVOID_ROOMS = {
   'E8N49': true,
  // 'W2N3': true
};

function getSafeRoute(fromRoom, toRoom) {
  // Return an array of steps or ERR_NO_PATH
  return Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: function(roomName, fromRoomName) {
      if (REMOTE_AVOID_ROOMS[roomName]) return Infinity; // forbid entering this room
      return 1; // default cost
    }
  });
}

function moveTowardRoomSafely(creep, targetRoom) {
  if (REMOTE_AVOID_ROOMS[targetRoom]) {
    if (Game.time % 25 === 0) {
      console.log('[RemoteBuilder] Target room ' + targetRoom + ' is in avoid list. Holding at ' + creep.room.name + '.');
    }
    return;
  }

  var route = getSafeRoute(creep.room.name, targetRoom);
  if (route === ERR_NO_PATH || !route || route.length === 0) {
    if (Game.time % 25 === 0) {
      console.log('[RemoteBuilder] No safe route from ' + creep.room.name + ' to ' + targetRoom + ' (avoid list may block).');
    }
    return;
  }

  // Step toward the next room along the route using the exit toward it
  var nextStep = route[0];
  var exitDir = nextStep.exit;  // one of FIND_EXIT_*
  var exitPos = creep.pos.findClosestByRange(exitDir);
  if (exitPos) {
    creep.moveTo(exitPos, { reusePath: 15 });
  } else {
    // Fallback: move to center of current room to try again next tick
    var center = new RoomPosition(25, 25, creep.room.name);
    creep.moveTo(center, { reusePath: 10 });
  }
}

/**
 * Check if a room is owned or reserved by a friendly player (IFF whitelist).
 * @param {Room} room - The room object to check
 * @returns {boolean} - True if the room is controlled by a friendly player
 */
function isFriendlyOwnedRoom(room) {
  if (!room || !room.controller) return false;
  
  // Check if room is owned by a friendly player
  if (room.controller.owner && iff.isFriendlyUsername(room.controller.owner.username)) {
    return true;
  }
  
  // Check if room is reserved by a friendly player
  if (room.controller.reservation && iff.isFriendlyUsername(room.controller.reservation.username)) {
    return true;
  }
  
  return false;
}

var roleRemoteBuilder = {
  run: function(creep) {
    var targetRoom = creep.memory && creep.memory.targetRoom ? creep.memory.targetRoom : null;

    // Initialize homeRoom if not set (assumes creep starts in home room)
    if (!creep.memory.homeRoom) {
      creep.memory.homeRoom = creep.room.name;
    }

    // If no target room is defined, fallback to local builder behavior
    if (!targetRoom) {
      roleBuilder.run(creep);
      return;
    }

    // == STATE MANAGEMENT ==
    // Mirror roleBuilder filling logic to handle cross-room refills
    if (creep.memory.filling && creep.store.getFreeCapacity() === 0) {
      creep.memory.filling = false;
      // Reset return flag when full
      if (creep.memory.returningHome) {
        delete creep.memory.returningHome;
      }
    }
    if (!creep.memory.filling && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.filling = true;
    }

    // == INACCESSIBILITY CHECK ==
    // If filling and inside target room, check if we can actually reach a source
    if (creep.memory.filling && creep.room.name === targetRoom) {
      // Check if we already decided to return
      if (!creep.memory.returningHome) {
        // Check if room is owned/reserved by a friendly player - don't harvest there
        if (isFriendlyOwnedRoom(creep.room)) {
          creep.memory.returningHome = true;
          delete creep.memory.energyTargetId;
          console.log('[RemoteBuilder] ' + creep.name + ' in friendly room ' + targetRoom + '. Returning to ' + creep.memory.homeRoom + ' for energy.');
        } else {
          // findClosestByPath returns null if no path exists or no sources active
          var accessibleSource = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
          
          // Also check for containers with energy so we don't leave unnecessarily
          var accessibleContainer = creep.pos.findClosestByPath(FIND_STRUCTURES, {
              filter: function(s) {
                  return (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) && 
                         s.store[RESOURCE_ENERGY] > 50;
              }
          });

          if (!accessibleSource && !accessibleContainer) {
            creep.memory.returningHome = true;
            // Clean up local target so we don't get stuck trying to path to it
            delete creep.memory.energyTargetId;
            console.log('[RemoteBuilder] ' + creep.name + ' cannot access energy in ' + targetRoom + '. Returning to ' + creep.memory.homeRoom);
          }
        }
      }
    }

    // == DESTINATION SELECTION ==
    var currentDestination = targetRoom;
    if (creep.memory.returningHome) {
        currentDestination = creep.memory.homeRoom;
    }

    // == MOVEMENT ==
    // While not in the destination room, move step-by-step
    if (creep.room.name !== currentDestination) {
      // Clear any wrong-room task that might have been assigned
      if (creep.memory && creep.memory.task && creep.memory.task.roomName && creep.memory.task.roomName !== currentDestination) {
        delete creep.memory.task;
      }
      moveTowardRoomSafely(creep, currentDestination);
      
      // If we are back home and returning for energy, we can start harvesting immediately 
      // if we are in the home room, but the loop below handles delegation.
      return;
    }

    // == WORK EXECUTION ==
    
    // Safety: ensure we never work outside the intended room (Home or Target)
    if (creep.memory && creep.memory.task && creep.memory.task.roomName && creep.memory.task.roomName !== creep.room.name) {
      delete creep.memory.task;
    }

    // Safety: ensure energy target is not outside current room
    if (creep.memory && creep.memory.energyTargetId) {
      var et = Game.getObjectById(creep.memory.energyTargetId);
      if (!et || (et.pos && et.pos.roomName && et.pos.roomName !== creep.room.name)) {
        delete creep.memory.energyTargetId;
      }
    }

    // Delegate work to the standard builder role
    // This works for both TargetRoom (Working) and HomeRoom (Refilling)
    roleBuilder.run(creep);

    // Post-guard: if a cross-room task slipped in, clear it
    if (creep.memory && creep.memory.task && creep.memory.task.roomName && creep.memory.task.roomName !== creep.room.name) {
      delete creep.memory.task;
    }
  }
};

module.exports = roleRemoteBuilder;