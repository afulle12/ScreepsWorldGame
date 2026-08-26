// LLM: Read docs/codex.js before reviewing or changing this file.
// roleClaimbot.js
// Role dispatch: memory.role === 'claimbot' -> roleClaimbot.run(creep).
// Console globals: launchClaimbot
// Example: launchClaimbot('W1N1', 'W2N2', 'claim') - Spawn claimbot to claim or reserve room
const enableLogging = false;
const spawnManager = require("spawnManager");
const util = require("util");
const memoryManager = require("memoryManager");
const heap = memoryManager.heap;
var roleClaimbot;
const BANNED_ROOMS = [ "E8N49", "W8N49" ];
function isRoomBanned(e) {
  for (let o = 0; o < BANNED_ROOMS.length; o++) {
    if (BANNED_ROOMS[o] === e) return true;
  }
  return false;
}

const isOnRoomEdge = util.isOnRoomEdge;
const nudgeOffRoomEdge = util.nudgeOffRoomEdge;
roleClaimbot = {
  //   The route should be the sequence of rooms to travel through (excluding spawn room, including target)
  spawn: function(e, o, r) {
    if (!e || !o) {
      return '❌ Usage: launchClaimbot("SpawnRoomName", "TargetRoomName", [optional route array])';
    }
    var n = Game.rooms[e];
    if (!n) {
      return "❌ Room " + e + " is not visible or has no spawns.";
    }
    var a = n.find(FIND_MY_SPAWNS);
    if (a.length === 0) {
      return "❌ No available spawns in " + e;
    }
    var t = a[0];
    if (r) {
      if (!Array.isArray(r)) {
        return '❌ Route must be an array of room names, e.g. ["E1N1", "E2N1", "E3N1"]';
      }
      if (r.length === 0) {
        return "❌ Route array cannot be empty";
      }
      if (r[r.length - 1] !== o) {
        return "❌ Route must end with target room " + o + " (last room in route: " + r[r.length - 1] + ")";
      }
      for (var i = 0; i < r.length; i++) {
        if (isRoomBanned(r[i])) {
          return "⚠️ Warning: Route includes banned room " + r[i] + ". Spawn aborted.";
        }
      }
    }
    var l = [ MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, ATTACK, CLAIM ];
    var m = util.bodyCost(l);
    if (n.energyAvailable < m) {
      return "❌ Not enough energy in " + e + " (Need " + m + ")";
    }
    var s = "Claimbot_" + o + "_" + Game.time;
    var g = {
      role: "claimbot",
      targetRoom: o
    };
    if (r) {
      g.hardcodedRoute = r;
      g.routeIndex = 0;
    }
    var u = spawnManager.spawnCustomCreep(t, l, s, g);
    if (u === OK) {
      var f = "✅ Spawning " + s + " in " + e + " targeting " + o;
      if (r) {
        f += " via hardcoded route: " + r.join(" → ");
      }
      return f;
    } else {
      return "❌ Spawn error: " + u;
    }
  },
  run: function(e) {
    if (e.memory && (e.memory.autoBuilderCancelled || Memory.autoBuilder && Memory.autoBuilder.cancelled && Memory.autoBuilder.cancelled[e.memory.targetRoom])) {
      return e.suicide();
    }
    if (enableLogging) {
      var o = e.memory.hardcodedRoute ? " route=[" + e.memory.hardcodedRoute.join("→") + "] idx=" + e.memory.routeIndex : " (dynamic route)";
      console.log("[" + e.name + "] start; room=" + e.room.name + " target=" + e.memory.targetRoom + o);
    }
    var r = e.memory.targetRoom;
    if (!r) {
      if (enableLogging) console.log("[" + e.name + "] no target → suiciding");
      return e.suicide();
    }
    if (e.room.name !== r && (e.memory.controllerPath || heap.claimbotControllerPaths && heap.claimbotControllerPaths[e.name])) {
      if (enableLogging) {
        console.log("[" + e.name + "] left " + r + " → clearing controllerPath");
      }
      delete e.memory.controllerPath;
      if (heap.claimbotControllerPaths) delete heap.claimbotControllerPaths[e.name];
    }
    //  • Inter‐room: defer to banned-room aware router
    //  • In‐room: PathFinder with outer 2‐tile border blocked
        function moveAvoidEdges(o, r) {
      var n = o.pos ? o.pos : o;
      if (n.roomName && n.roomName !== e.room.name) {
        moveToRoomAvoidingBanned(n.roomName, r);
        return;
      }
      var a = Game.map.getRoomTerrain(e.room.name);
      var t = new PathFinder.CostMatrix;
      for (var i = 0; i < 50; i++) {
        for (var l = 0; l < 50; l++) {
          var m = a.get(l, i);
          var s = m === 0 ? 2 : m === 2 ? 10 : 255;
          if (l <= 1 || l >= 48 || i <= 1 || i >= 48) s = 255;
          t.set(l, i, s);
        }
      }
      var g = e.room.find(FIND_STRUCTURES);
      g.forEach(function(e) {
        if (e.structureType === STRUCTURE_CONTAINER) {
          t.set(e.pos.x, e.pos.y, 5);
        } else if (e.structureType === STRUCTURE_RAMPART && e.my) {
          t.set(e.pos.x, e.pos.y, 1);
        } else if (e.structureType === STRUCTURE_ROAD) {
          return;
        } else if (e.structureType !== STRUCTURE_CONTROLLER) {
          t.set(e.pos.x, e.pos.y, 50);
        } else {
          t.set(e.pos.x, e.pos.y, 255);
        }
      });
      g.forEach(function(e) {
        if (e.structureType === STRUCTURE_ROAD) {
          t.set(e.pos.x, e.pos.y, 1);
        }
      });
      var u = PathFinder.search(e.pos, {
        pos: n,
        range: 1
      }, {
        maxOps: 2e3,
        roomCallback: function(o) {
          return o === e.room.name ? t : new PathFinder.CostMatrix;
        }
      });
      if (u.path.length) {
        if (enableLogging) {
          console.log("[" + e.name + "] PF→ next (" + u.path[0].x + "," + u.path[0].y + ")");
        }
        var f = new RoomPosition(u.path[0].x, u.path[0].y, e.room.name);
        var c = f.lookFor(LOOK_STRUCTURES);
        for (var R = 0; R < c.length; R++) {
          var p = c[R];
          if (p.structureType === STRUCTURE_WALL || p.structureType === STRUCTURE_RAMPART && !p.my || p.structureType !== STRUCTURE_ROAD && p.structureType !== STRUCTURE_CONTAINER && p.structureType !== STRUCTURE_CONTROLLER) {
            e.attack(p);
            e.say("⚔️Clear");
            break;
          }
        }
        return e.moveByPath(u.path, {
          visualizePathStyle: r,
          maxRooms: 1
        });
      }
      if (enableLogging) {
        console.log("[" + e.name + "] PF failed → fallback moveTo (" + n.x + "," + n.y + ")");
      }
      return e.moveTo(n, {
        visualizePathStyle: r,
        maxRooms: 1
      });
    }
    function moveToRoomAvoidingBanned(o, r) {
      if (e.room.name === o) return;
      if (isRoomBanned(o)) {
        e.say("BAN");
        if (enableLogging) {
          console.log("[" + e.name + "] Target room " + o + " is banned, aborting travel");
        }
        if (isOnRoomEdge(e.pos)) nudgeOffRoomEdge(e);
        return;
      }
      var n;
      var a;
      if (e.memory.hardcodedRoute && e.memory.hardcodedRoute.length > 0) {
        var t = e.memory.hardcodedRoute;
        var i = e.memory.routeIndex || 0;
        while (i < t.length && e.room.name === t[i]) {
          i++;
          e.memory.routeIndex = i;
        }
        if (i >= t.length) {
          if (enableLogging) {
            console.log("[" + e.name + "] Hardcoded route complete");
          }
          return;
        }
        var l = t[i];
        if (enableLogging) {
          console.log("[" + e.name + "] Following hardcoded route: step " + i + " → " + l);
        }
        var m = Game.map.findExit(e.room.name, l);
        if (m === ERR_NO_PATH || m < 0) {
          if (enableLogging) {
            console.log("[" + e.name + "] No direct exit from " + e.room.name + " to hardcoded next room " + l);
          }
          n = Game.map.findRoute(e.room.name, l, {
            routeCallback: function(e) {
              if (isRoomBanned(e)) return Infinity;
              return 1;
            }
          });
          if (n === ERR_NO_PATH || !n || !n.length) {
            if (isOnRoomEdge(e.pos)) nudgeOffRoomEdge(e);
            return;
          }
          a = n[0];
        } else {
          a = {
            room: l,
            exit: m
          };
        }
      } else {
        n = Game.map.findRoute(e.room.name, o, {
          routeCallback: function(e) {
            if (isRoomBanned(e)) return Infinity;
            return 1;
          }
        });
        if (n === ERR_NO_PATH || !n || !n.length) {
          if (enableLogging) {
            console.log("[" + e.name + "] No safe route to " + o);
          }
          if (isOnRoomEdge(e.pos)) nudgeOffRoomEdge(e);
          return;
        }
        a = n[0];
      }
      var m = Game.map.findExit(e.room, a.room);
      if (m === ERR_NO_PATH) {
        if (enableLogging) {
          console.log("[" + e.name + "] No exit toward " + a.room);
        }
        if (isOnRoomEdge(e.pos)) nudgeOffRoomEdge(e);
        return;
      }
      var s = e.pos.y === 0 && m !== FIND_EXIT_TOP || e.pos.y === 49 && m !== FIND_EXIT_BOTTOM || e.pos.x === 0 && m !== FIND_EXIT_LEFT || e.pos.x === 49 && m !== FIND_EXIT_RIGHT;
      if (s) {
        if (nudgeOffRoomEdge(e)) return;
      }
      var g = e.pos.findClosestByPath(m);
      if (!g) g = e.pos.findClosestByRange(m);
      if (g) {
        e.moveTo(g, {
          visualizePathStyle: r,
          reusePath: 5
        });
      }
    }
    function moveToController(o) {
      var r = e.room.controller;
      if (!r) {
        if (enableLogging) console.log("[" + e.name + "] no controller here");
        return;
      }
      if (!heap.claimbotControllerPaths) heap.claimbotControllerPaths = {};
      var n = heap.claimbotControllerPaths;
      if (e.memory.controllerPath) delete e.memory.controllerPath;
      function clearControllerPath() {
        delete n[e.name];
      }
      if (e.pos.inRangeTo(r, 1)) {
        if (n[e.name]) {
          if (enableLogging) {
            console.log("[" + e.name + "] at controller → clearing path");
          }
          clearControllerPath();
        }
        return;
      }
      if (!n[e.name]) {
        if (enableLogging) {
          console.log("[" + e.name + "] computing path from (" + e.pos.x + "," + e.pos.y + ") to controller");
        }
        var a = Game.map.getRoomTerrain(e.room.name);
        var t = new PathFinder.CostMatrix;
        for (var i = 0; i < 50; i++) {
          for (var l = 0; l < 50; l++) {
            var m = a.get(l, i);
            var s = m === 0 ? 2 : m === 2 ? 10 : 255;
            if (l <= 1 || l >= 48 || i <= 1 || i >= 48) s = 255;
            t.set(l, i, s);
          }
        }
        var g = e.room.find(FIND_STRUCTURES);
        g.forEach(function(e) {
          if (e.structureType === STRUCTURE_ROAD) {
            return;
          } else if (e.structureType === STRUCTURE_RAMPART && !e.my) {
            t.set(e.pos.x, e.pos.y, 50);
          } else if (e.structureType === STRUCTURE_WALL) {
            t.set(e.pos.x, e.pos.y, 50);
          } else if (e.structureType !== STRUCTURE_CONTAINER && e.structureType !== STRUCTURE_CONTROLLER) {
            t.set(e.pos.x, e.pos.y, 50);
          }
        });
        g.forEach(function(e) {
          if (e.structureType === STRUCTURE_ROAD) {
            t.set(e.pos.x, e.pos.y, 1);
          }
        });
        var u = PathFinder.search(e.pos, {
          pos: r.pos,
          range: 1
        }, {
          maxOps: 2e3,
          roomCallback: function(o) {
            return o === e.room.name ? t : new PathFinder.CostMatrix;
          }
        });
        n[e.name] = u.path;
        if (enableLogging) {
          console.log("[" + e.name + "] stored controllerPath, length=" + u.path.length);
        }
      }
      var f = n[e.name];
      if (Array.isArray(f) && f.length > 0) {
        if (f[0].x === e.pos.x && f[0].y === e.pos.y) {
          f.shift();
        }
        if (f.length > 0) {
          var c = f[0];
          var R = new RoomPosition(c.x, c.y, e.room.name);
          var p = R.lookFor(LOOK_STRUCTURES);
          for (var d = 0; d < p.length; d++) {
            var T = p[d];
            if (T.structureType === STRUCTURE_WALL || T.structureType === STRUCTURE_RAMPART && !T.my || T.structureType !== STRUCTURE_ROAD && T.structureType !== STRUCTURE_CONTAINER && T.structureType !== STRUCTURE_CONTROLLER) {
              e.attack(T);
              e.say("⚔️Open");
              break;
            }
          }
          var h = e.moveTo(new RoomPosition(c.x, c.y, e.room.name), {
            visualizePathStyle: o,
            reusePath: 0,
            maxRooms: 1
          });
          if (enableLogging) {
            console.log("[" + e.name + "] step→ (" + c.x + "," + c.y + ") result=" + h);
          }
          if (h === OK) {
            f.shift();
            return;
          }
          if (h !== ERR_TIRED) {
            if (enableLogging) {
              console.log("[" + e.name + "] step error (" + h + ") → clearing path");
            }
            clearControllerPath();
          }
        }
      }
      if (enableLogging) {
        console.log("[" + e.name + "] fallback direct moveTo controller");
      }
      e.moveTo(r, {
        visualizePathStyle: o,
        reusePath: 0,
        maxRooms: 1
      });
    }
    if (e.room.name === r && isOnRoomEdge(e.pos)) {
      if (nudgeOffRoomEdge(e)) return;
    }
    if (e.room.name !== r) {
      if (enableLogging) {
        console.log("[" + e.name + "] traveling to " + r);
      }
      moveToRoomAvoidingBanned(r, {
        stroke: "#ffaa00"
      });
      return;
    }
    var n = e.room.controller;
    if (!n) {
      if (enableLogging) console.log("[" + e.name + "] no controller here");
      e.say("No ctrl");
      return;
    }
    if (!n.my && n.owner) {
      if (e.pos.inRangeTo(n, 1)) {
        if (enableLogging) {
          console.log("[" + e.name + "] attacking enemy controller at " + n.pos);
        }
        e.attackController(n);
        e.say("AtkCtrl");
      } else {
        moveToController({
          stroke: "#ff00ff"
        });
      }
      return;
    }
    if (!n.my && !n.owner) {
      if (e.pos.inRangeTo(n, 1)) {
        if (enableLogging) {
          console.log("[" + e.name + "] claiming controller at " + n.pos);
        }
        var a = e.claimController(n);
        if (a === OK) {
          e.say("Claimed");
        } else {
          e.say("Err " + a);
          if (enableLogging) {
            console.log("[" + e.name + "] claim result=" + a);
          }
        }
      } else {
        moveToController({
          stroke: "#00ff00"
        });
      }
      return;
    }
    if (n.my) {
      if (heap.claimbotControllerPaths) delete heap.claimbotControllerPaths[e.name];
      if (enableLogging) console.log("[" + e.name + "] controller mine → suiciding");
      e.say("Done");
      e.suicide();
    }
  }
};
roleClaimbot.clearCreepCache = function(e) {
  if (heap.claimbotControllerPaths) delete heap.claimbotControllerPaths[e];
};
global.launchClaimbot = roleClaimbot.spawn;
module.exports = roleClaimbot;
