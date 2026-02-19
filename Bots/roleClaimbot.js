// roleClaimbot.js
// Bot that travels to a target room, avoids edges, then attacks or claims the controller.
// To launch: launchClaimbot('SpawnRoomName', 'TargetRoomName')
// With hardcoded route: launchClaimbot('SpawnRoomName', 'TargetRoomName', ['Room1', 'Room2', 'Room3'])

const enableLogging = true;  // Set false to silence logs

// == BANNED ROOMS (keep in sync with demolition) ==
const BANNED_ROOMS = [
  'E8N49', 'E3N47'
];

// == Helper: is a room banned? ==
function isRoomBanned(roomName) {
  for (let i = 0; i < BANNED_ROOMS.length; i++) {
    if (BANNED_ROOMS[i] === roomName) return true;
  }
  return false;
}

// == Edge helpers ==
function isOnRoomEdge(pos) {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
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

module.exports = {
  // == SPAWN COMMAND LOGIC ==
  // Call this via console: launchClaimbot('SpawnRoom', 'TargetRoom')
  // With hardcoded route: launchClaimbot('SpawnRoom', 'TargetRoom', ['Room1', 'Room2', ...])
  //   The route should be the sequence of rooms to travel through (excluding spawn room, including target)
  spawn: function(spawnRoomName, targetRoomName, route) {
    if (!spawnRoomName || !targetRoomName) {
      return '❌ Usage: launchClaimbot("SpawnRoomName", "TargetRoomName", [optional route array])';
    }

    var room = Game.rooms[spawnRoomName];
    if (!room) {
      return '❌ Room ' + spawnRoomName + ' is not visible or has no spawns.';
    }

    var spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) {
      return '❌ No available spawns in ' + spawnRoomName;
    }

    var spawn = spawns[0]; // Uses the first found spawn

    // Validate route if provided
    if (route) {
      if (!Array.isArray(route)) {
        return '❌ Route must be an array of room names, e.g. ["E1N1", "E2N1", "E3N1"]';
      }
      if (route.length === 0) {
        return '❌ Route array cannot be empty';
      }
      // Ensure the route ends at the target room
      if (route[route.length - 1] !== targetRoomName) {
        return '❌ Route must end with target room ' + targetRoomName + ' (last room in route: ' + route[route.length - 1] + ')';
      }
      // Warn about banned rooms in the route
      for (var r = 0; r < route.length; r++) {
        if (isRoomBanned(route[r])) {
          return '⚠️ Warning: Route includes banned room ' + route[r] + '. Spawn aborted.';
        }
      }
    }

    // BODY DEFINITION
    // Your script attempts to attack creeps/structures AND claim.
    // Therefore, it needs ATTACK, CLAIM, and MOVE parts.
    // Adjust this array based on your room's capacity.
    var body = [MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, ATTACK, CLAIM];

    // Check energy cost
    var cost = 0;
    for(var i=0; i<body.length; i++) {
        cost += BODYPART_COST[body[i]];
    }
    if (room.energyAvailable < cost) {
        return '❌ Not enough energy in ' + spawnRoomName + ' (Need ' + cost + ')';
    }

    var creepName = 'Claimbot_' + targetRoomName + '_' + Game.time;
    
    var memory = {
      role: 'claimbot',
      targetRoom: targetRoomName
    };
    
    // Add hardcoded route to memory if provided
    if (route) {
      memory.hardcodedRoute = route;
      memory.routeIndex = 0;  // Track progress through the route
    }
    
    var result = spawn.spawnCreep(body, creepName, { memory: memory });

    if (result === OK) {
      var msg = '✅ Spawning ' + creepName + ' in ' + spawnRoomName + ' targeting ' + targetRoomName;
      if (route) {
        msg += ' via hardcoded route: ' + route.join(' → ');
      }
      return msg;
    } else {
      return '❌ Spawn error: ' + result;
    }
  },

  run: function(creep) {
    // --- INIT & LOGGING ---
    if (enableLogging) {
      var routeInfo = creep.memory.hardcodedRoute 
        ? ' route=[' + creep.memory.hardcodedRoute.join('→') + '] idx=' + creep.memory.routeIndex
        : ' (dynamic route)';
      console.log(
        '[' + creep.name + '] start; room=' + creep.room.name + ' target=' + creep.memory.targetRoom + routeInfo
      );
    }
    var targetRoom = creep.memory.targetRoom;
    if (!targetRoom) {
      if (enableLogging) console.log('[' + creep.name + '] no target → suiciding');
      return creep.suicide();
    }

    // Clear old controller path if we've left the target room
    if (creep.room.name !== targetRoom && creep.memory.controllerPath) {
      if (enableLogging) {
        console.log('[' + creep.name + '] left ' + targetRoom + ' → clearing controllerPath');
      }
      delete creep.memory.controllerPath;
    }

    // --- moveAvoidEdges(dest, style) ---
    //  • Inter‐room: defer to banned-room aware router
    //  • In‐room: PathFinder with outer 2‐tile border blocked
    function moveAvoidEdges(dest, style) {
      var pos = dest.pos ? dest.pos : dest;

      // If target is in another room, use cross-room router (not in-room PF)
      if (pos.roomName && pos.roomName !== creep.room.name) {
        moveToRoomAvoidingBanned(pos.roomName, style);
        return;
      }

      // Build CostMatrix blocking walls & outer border
      // Priority changed to ensure Roads overwrite Walls for the road-through-wall logic
      var terrain = Game.map.getRoomTerrain(creep.room.name);
      var costs = new PathFinder.CostMatrix();
      for (var y = 0; y < 50; y++) {
        for (var x = 0; x < 50; x++) {
          var t = terrain.get(x, y);
          var c = t === 0 ? 2 : t === 2 ? 10 : 255;
          if (x <= 1 || x >= 48 || y <= 1 || y >= 48) c = 255;
          costs.set(x, y, c);
        }
      }
      
      var structures = creep.room.find(FIND_STRUCTURES);
      
      // PASS 1: Set obstacles (Walls, Hostile Ramparts)
      structures.forEach(function(s) {
        if (s.structureType === STRUCTURE_CONTAINER) {
            costs.set(s.pos.x, s.pos.y, 5);
        } else if (s.structureType === STRUCTURE_RAMPART && s.my) {
            costs.set(s.pos.x, s.pos.y, 1);
        } else if (s.structureType === STRUCTURE_ROAD) {
            // Skip roads in pass 1
            return;
        } else if (s.structureType !== STRUCTURE_CONTROLLER) {
            // Walls, Hostile Ramparts, Extensions, etc.
            // We set this to 50. This allows pathing if no other option exists.
            costs.set(s.pos.x, s.pos.y, 50);
        } else {
            // Controller is impassable
            costs.set(s.pos.x, s.pos.y, 255);
        }
      });

      // PASS 2: Set ROADS (Overwrites walls/obstacles on the same tile)
      // This forces the bot to prefer the road even if it goes through a wall.
      structures.forEach(function(s) {
        if (s.structureType === STRUCTURE_ROAD) {
            costs.set(s.pos.x, s.pos.y, 1);
        }
      });

      var res = PathFinder.search(
        creep.pos,
        { pos: pos, range: 1 }, 
        {
          maxOps: 2000,
          roomCallback: function(rn) { return rn === creep.room.name ? costs : new PathFinder.CostMatrix(); }
        }
      );

      if (res.path.length) {
        if (enableLogging) {
          console.log(
            '[' + creep.name + '] PF→ next (' + res.path[0].x + ',' + res.path[0].y + ')'
          );
        }
        
        // --- AUTO-ATTACK BLOCKERS ---
        // Attacks walls/ramparts only if they are directly in the path
        var nextPos = new RoomPosition(res.path[0].x, res.path[0].y, creep.room.name);
        var structuresAtNext = nextPos.lookFor(LOOK_STRUCTURES);
        for (var i = 0; i < structuresAtNext.length; i++) {
            var s = structuresAtNext[i];
            if (s.structureType === STRUCTURE_WALL || 
                (s.structureType === STRUCTURE_RAMPART && !s.my) || 
                (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_CONTROLLER)) {
                creep.attack(s);
                creep.say('⚔️Clear');
                break; 
            }
        }
        
        return creep.moveByPath(res.path, { visualizePathStyle: style, maxRooms: 1 });
      }

      if (enableLogging) {
        console.log(
          '[' + creep.name + '] PF failed → fallback moveTo (' + pos.x + ',' + pos.y + ')'
        );
      }
      return creep.moveTo(pos, { visualizePathStyle: style, maxRooms: 1 });
    }

    // --- Cross-room travel avoiding banned rooms; safe edge behavior ---
    // Now supports hardcoded routes
    function moveToRoomAvoidingBanned(targetRoomName, style) {
      if (creep.room.name === targetRoomName) return;

      // Abort if target is banned
      if (isRoomBanned(targetRoomName)) {
        creep.say('BAN');
        if (enableLogging) {
          console.log('[' + creep.name + '] Target room ' + targetRoomName + ' is banned, aborting travel');
        }
        if (isOnRoomEdge(creep.pos)) nudgeOffRoomEdge(creep);
        return;
      }

      var route;
      var nextHop;

      // Check if we have a hardcoded route
      if (creep.memory.hardcodedRoute && creep.memory.hardcodedRoute.length > 0) {
        // Update route index based on current room position
        var hardRoute = creep.memory.hardcodedRoute;
        var currentIdx = creep.memory.routeIndex || 0;
        
        // Advance index if we've reached the current waypoint
        while (currentIdx < hardRoute.length && creep.room.name === hardRoute[currentIdx]) {
          currentIdx++;
          creep.memory.routeIndex = currentIdx;
        }
        
        // If we've completed the hardcoded route, we're done traveling
        if (currentIdx >= hardRoute.length) {
          if (enableLogging) {
            console.log('[' + creep.name + '] Hardcoded route complete');
          }
          return;
        }
        
        // Get the next room in the hardcoded route
        var nextRoom = hardRoute[currentIdx];
        
        if (enableLogging) {
          console.log('[' + creep.name + '] Following hardcoded route: step ' + currentIdx + ' → ' + nextRoom);
        }
        
        // Find exit to next hardcoded room
        var exitDir = Game.map.findExit(creep.room.name, nextRoom);
        if (exitDir === ERR_NO_PATH || exitDir < 0) {
          if (enableLogging) {
            console.log('[' + creep.name + '] No direct exit from ' + creep.room.name + ' to hardcoded next room ' + nextRoom);
          }
          // Fallback: use dynamic routing for just this hop
          route = Game.map.findRoute(creep.room.name, nextRoom, {
            routeCallback: function(roomName) {
              if (isRoomBanned(roomName)) return Infinity;
              return 1;
            }
          });
          if (route === ERR_NO_PATH || !route || !route.length) {
            if (isOnRoomEdge(creep.pos)) nudgeOffRoomEdge(creep);
            return;
          }
          nextHop = route[0];
        } else {
          // Direct exit exists
          nextHop = { room: nextRoom, exit: exitDir };
        }
      } else {
        // No hardcoded route - compute safe route that avoids banned rooms
        route = Game.map.findRoute(creep.room.name, targetRoomName, {
          routeCallback: function(roomName) {
            if (isRoomBanned(roomName)) return Infinity;
            return 1;
          }
        });

        // If no route, back away from any edge to stop oscillation
        if (route === ERR_NO_PATH || !route || !route.length) {
          if (enableLogging) {
            console.log('[' + creep.name + '] No safe route to ' + targetRoomName);
          }
          if (isOnRoomEdge(creep.pos)) nudgeOffRoomEdge(creep);
          return;
        }

        nextHop = route[0];
      }

      var exitDir = Game.map.findExit(creep.room, nextHop.room);
      if (exitDir === ERR_NO_PATH) {
        if (enableLogging) {
          console.log('[' + creep.name + '] No exit toward ' + nextHop.room);
        }
        if (isOnRoomEdge(creep.pos)) nudgeOffRoomEdge(creep);
        return;
      }

      // If we are on an edge that is NOT the chosen exit side, step inward first
      var onWrongEdge =
        (creep.pos.y === 0 && exitDir !== FIND_EXIT_TOP) ||
        (creep.pos.y === 49 && exitDir !== FIND_EXIT_BOTTOM) ||
        (creep.pos.x === 0 && exitDir !== FIND_EXIT_LEFT) ||
        (creep.pos.x === 49 && exitDir !== FIND_EXIT_RIGHT);

      if (onWrongEdge) {
        if (nudgeOffRoomEdge(creep)) return;
      }

      // Choose a concrete exit tile; prefer pathable choice to avoid oscillation
      var exitPos = creep.pos.findClosestByPath(exitDir);
      if (!exitPos) exitPos = creep.pos.findClosestByRange(exitDir);

      if (exitPos) {
        // Direct move to exit; do not use edge-blocking matrix here
        creep.moveTo(exitPos, {
          visualizePathStyle: style,
          reusePath: 5
        });
      }
    }

    // --- moveToController(style) ---
    function moveToController(style) {
      var ctrl = creep.room.controller;
      if (!ctrl) {
        if (enableLogging) console.log('[' + creep.name + '] no controller here');
        return;
      }

      // If adjacent, clear stored path
      if (creep.pos.inRangeTo(ctrl, 1)) {
        if (creep.memory.controllerPath) {
          if (enableLogging) {
            console.log('[' + creep.name + '] at controller → clearing path');
          }
          delete creep.memory.controllerPath;
        }
        return;
      }

      // 1) Compute path once on entry
      if (!creep.memory.controllerPath) {
        if (enableLogging) {
          console.log(
            '[' + creep.name + '] computing path from (' + creep.pos.x + ',' + creep.pos.y + ') to controller'
          );
        }
        var terrain = Game.map.getRoomTerrain(creep.room.name);
        var costs = new PathFinder.CostMatrix();
        for (var y2 = 0; y2 < 50; y2++) {
          for (var x2 = 0; x2 < 50; x2++) {
            var t = terrain.get(x2, y2);
            var c = t === 0 ? 2 : t === 2 ? 10 : 255;
            if (x2 <= 1 || x2 >= 48 || y2 <= 1 || y2 >= 48) c = 255;
            costs.set(x2, y2, c);
          }
        }
        
        var structures = creep.room.find(FIND_STRUCTURES);
        
        // PASS 1: Obstacles
        structures.forEach(function(s) {
           if (s.structureType === STRUCTURE_ROAD) {
              return; // Skip
           } else if (s.structureType === STRUCTURE_RAMPART && !s.my) {
              costs.set(s.pos.x, s.pos.y, 50); 
           } else if (s.structureType === STRUCTURE_WALL) {
              costs.set(s.pos.x, s.pos.y, 50);
           } else if (s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_CONTROLLER) {
              costs.set(s.pos.x, s.pos.y, 50);
           }
        });
        
        // PASS 2: Roads (Overwrite obstacles)
        structures.forEach(function(s) {
           if (s.structureType === STRUCTURE_ROAD) {
              costs.set(s.pos.x, s.pos.y, 1);
           }
        });

        var res = PathFinder.search(creep.pos, { pos: ctrl.pos, range: 1 }, {
          maxOps: 2000,
          roomCallback: function(rn) { return rn === creep.room.name ? costs : new PathFinder.CostMatrix(); }
        });
        creep.memory.controllerPath = res.path;
        if (enableLogging) {
          console.log(
            '[' + creep.name + '] stored controllerPath, length=' + res.path.length
          );
        }
      }

      // 2) Step one tile
      var path = creep.memory.controllerPath;
      if (Array.isArray(path) && path.length > 0) {
        if (path[0].x === creep.pos.x && path[0].y === creep.pos.y) {
          path.shift();
        }
        if (path.length > 0) {
          var nxt = path[0];
          
          // --- AUTO-ATTACK BLOCKERS FOR CONTROLLER PATH ---
          var nextPos = new RoomPosition(nxt.x, nxt.y, creep.room.name);
          var structuresAtNext = nextPos.lookFor(LOOK_STRUCTURES);
          for (var i = 0; i < structuresAtNext.length; i++) {
            var s = structuresAtNext[i];
            if (s.structureType === STRUCTURE_WALL || 
                (s.structureType === STRUCTURE_RAMPART && !s.my) || 
                (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_CONTROLLER)) {
                creep.attack(s);
                creep.say('⚔️Open');
                break; 
            }
          }
          
          var res2 = creep.moveTo(
            new RoomPosition(nxt.x, nxt.y, creep.room.name),
            { visualizePathStyle: style, reusePath: 0, maxRooms: 1 }
          );
          if (enableLogging) {
            console.log(
              '[' + creep.name + '] step→ (' + nxt.x + ',' + nxt.y + ') result=' + res2
            );
          }
          if (res2 === OK) {
            path.shift();
            return;
          }
          if (res2 !== ERR_TIRED) {
            if (enableLogging) {
              console.log(
                '[' + creep.name + '] step error (' + res2 + ') → clearing path'
              );
            }
            delete creep.memory.controllerPath;
          }
        }
      }

      // 3) Fallback: direct moveTo(controller) constrained to this room
      if (enableLogging) {
        console.log('[' + creep.name + '] fallback direct moveTo controller');
      }
      creep.moveTo(ctrl, { visualizePathStyle: style, reusePath: 0, maxRooms: 1 });
    }

    // --- MAIN BEHAVIOR ---

    // In target room: if on edge, only step inward this tick (prevents accidental exits)
    if (creep.room.name === targetRoom && isOnRoomEdge(creep.pos)) {
      if (nudgeOffRoomEdge(creep)) return;
    }

    // 1) Travel to target room center
    if (creep.room.name !== targetRoom) {
      if (enableLogging) {
        console.log('[' + creep.name + '] traveling to ' + targetRoom);
      }
      // Route around banned rooms; leave only via chosen exit
      moveToRoomAvoidingBanned(targetRoom, { stroke: '#ffaa00' });
      return;
    }

    // 2) Controller logic
    var controller = creep.room.controller;
    if (!controller) {
      if (enableLogging) console.log('[' + creep.name + '] no controller here');
      creep.say('No ctrl');
      return;
    }

    // 2a) Enemy-owned → attack
    if (!controller.my && controller.owner) {
      if (creep.pos.inRangeTo(controller, 1)) {
        if (enableLogging) {
          console.log(
            '[' + creep.name + '] attacking enemy controller at ' + controller.pos
          );
        }
        creep.attackController(controller);
        creep.say('AtkCtrl');
      } else {
        moveToController({ stroke: '#ff00ff' });
      }
      return;
    }

    // 2b) Unowned → claim
    if (!controller.my && !controller.owner) {
      if (creep.pos.inRangeTo(controller, 1)) {
        if (enableLogging) {
          console.log(
            '[' + creep.name + '] claiming controller at ' + controller.pos
          );
        }
        var resClaim = creep.claimController(controller);
        if (resClaim === OK) {
          creep.say('Claimed');
        } else {
          creep.say('Err ' + resClaim);
          if (enableLogging) {
            console.log('[' + creep.name + '] claim result=' + resClaim);
          }
        }
      } else {
        moveToController({ stroke: '#00ff00' });
      }
      return;
    }

    // 2c) Already ours → done
    if (controller.my) {
      if (enableLogging) console.log('[' + creep.name + '] controller mine → suiciding');
      creep.say('Done');
      creep.suicide();
    }
  }
};