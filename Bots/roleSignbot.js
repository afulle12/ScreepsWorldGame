// LLM: Read docs/codex.js before reviewing or changing this file.
// roleSignbot.js
// Role dispatch: memory.role === 'signbot' -> roleSignbot.run(creep).
// Console globals: orderSign, orderPermanentSign
// Example: orderSign('W1N1', 'W2N2', 'Colony territory') - Dispatch signbot to sign controller
// Example: orderPermanentSign('W1N1', 'W2N2', 'Protected') - Set persistent room sign order
// Example: require('roleSignbot').run(creep);
const getRoomState = require("getRoomState");
const spawnManager = require("spawnManager");
const permanentRoomFacts = require("permanentRoomFacts");
function isHighwayRoom(e) {
  const o = /^([WE])(\d+)([NS])(\d+)$/.exec(e);
  if (!o) return false;
  return parseInt(o[2], 10) % 10 === 0 || parseInt(o[4], 10) % 10 === 0;
}

function bordersHighway(e) {
  const o = Game.map.describeExits(e);
  return o && Object.values(o).some(isHighwayRoom);
}

const roleSignbot = {
  run: function(e) {
    if (!e.memory.targetRoom || !e.memory.signMessage) {
      console.log(`[Signbot] ${e.name} has no target room or message. Suiciding.`);
      e.suicide();
      return;
    }
    if (e.room.name !== e.memory.targetRoom) {
      if (e.memory.routeMode === "highway") {
        if (e.room.name !== e.memory.routeOrigin && !isHighwayRoom(e.room.name)) {
          console.log(`[Signbot] ${e.name} entered non-highway room ${e.room.name}. Suiciding.`);
          e.suicide();
          return;
        }
        const o = e.memory.highwayRoute;
        if (!Array.isArray(o)) {
          console.log(`[Signbot] ${e.name} has no highway route. Suiciding.`);
          e.suicide();
          return;
        }
        while (o[0] === e.room.name) o.shift();
        const n = o[0];
        const r = Game.map.describeExits(e.room.name);
        if (!n || n !== e.memory.targetRoom && !isHighwayRoom(n) || !r || !Object.values(r).includes(n)) {
          console.log(`[Signbot] ${e.name} has an invalid highway route from ${e.room.name}. Suiciding.`);
          e.suicide();
          return;
        }
        const t = Game.map.findExit(e.room.name, n);
        const a = e.pos.findClosestByRange(t);
        if (a) {
          e.moveTo(a, {
            plainCost: 1,
            swampCost: 1,
            visualizePathStyle: {
              stroke: "#00ff00"
            }
          });
          e.say("🚀 Highway");
        }
        return;
      }
      const o = Game.map.findExit(e.room, e.memory.targetRoom);
      if (o === ERR_NO_PATH || o === ERR_INVALID_ARGS) {
        console.log(`[Signbot] ${e.name} cannot find path to ${e.memory.targetRoom}`);
        e.suicide();
        return;
      }
      const n = e.pos.findClosestByRange(o);
      if (n) {
        e.moveTo(n, {
          plainCost: 1,
          swampCost: 1,
          visualizePathStyle: {
            stroke: "#00ff00"
          }
        });
        e.say("🚀 Moving");
      }
      return;
    }
    const o = e.room.controller;
    if (!o) {
      console.log(`[Signbot] ${e.name} found no controller in ${e.memory.targetRoom}`);
      e.suicide();
      return;
    }
    if (!e.pos.inRangeTo(o, 1)) {
      e.moveTo(o, {
        plainCost: 1,
        swampCost: 1,
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      });
      e.say("📝 Signing");
    } else {
      const n = e.signController(o, e.memory.signMessage);
      if (n === OK) {
        console.log(`[Signbot] ${e.name} successfully signed ${e.memory.targetRoom} with: "${e.memory.signMessage}"`);
        e.say("✅ Done");
        e.suicide();
      } else {
        console.log(`[Signbot] ${e.name} failed to sign controller: ${n}`);
        e.suicide();
      }
    }
  },
  runPermanentSignCheck: function() {
    var e = getRoomState.ownedNames();
    for (var o = 0; o < e.length; o++) {
      var n = e[o];
      var r = Game.rooms[n];
      var t = getRoomState.get(n);
      if (!r || !r.controller || !r.controller.my || !t || !t.permanentFacts) continue;
      var a = permanentRoomFacts.encode(t.permanentFacts);
      var i = r.controller.sign;
      if (a && i && i.text === a) continue;
      if (hasActivePermanentSignbot(n)) continue;
      var s = findNearestAvailableSpawnRoom(n);
      if (!s) continue;
      return global.orderPermanentSign(s, n, true);
    }
    return "[PermanentSign] No eligible room needs a capsule sign.";
  }
};
module.exports = roleSignbot;
global.orderSign = function(e, o, n, r) {
  if (!e || !o || !n) {
    return "[Signbot] Invalid command. Use: orderSign('spawnRoomName', 'targetRoomName', 'message'[, 'highway'])";
  }
  if (r !== undefined && r !== "highway") {
    return "[Signbot] Invalid route mode: " + r + ". Use 'highway' or omit the fourth parameter.";
  }
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[Signbot] Invalid spawn room: " + e + ". Must be a room you own.";
  }
  var t = null;
  if (r === "highway") {
    if (isHighwayRoom(o)) {
      return "[Signbot] Invalid highway destination: " + o + " is a highway room and has no controller.";
    }
    if (!bordersHighway(e)) {
      return "[Signbot] Cannot use highway routing: " + e + " is not adjacent to a highway room.";
    }
    if (!bordersHighway(o)) {
      return "[Signbot] Cannot use highway routing: " + o + " is not adjacent to a highway room.";
    }
    var a = Game.map.findRoute(e, o, {
      routeCallback: function(e, n) {
        if (e === o) return isHighwayRoom(n) ? 1 : Infinity;
        return isHighwayRoom(e) ? 1 : Infinity;
      }
    });
    if (a === ERR_NO_PATH || !Array.isArray(a)) {
      return "[Signbot] No highway-only route found from " + e + " to " + o;
    }
    t = a.map(function(e) {
      return e.room;
    });
    if (t.length < 2 || t[t.length - 1] !== o) {
      return "[Signbot] No valid highway-only route found from " + e + " to " + o;
    }
    for (var i = 0; i < t.length - 1; i++) {
      if (!isHighwayRoom(t[i])) {
        return "[Signbot] Route validation failed: " + t[i] + " is not a highway room.";
      }
    }
  }
  var s = getRoomState.get(e);
  var m = [];
  if (s && s.structuresByType && s.structuresByType[STRUCTURE_SPAWN]) {
    m = s.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
      return e.my && !e.spawning;
    });
  } else {
    m = Game.rooms[e].find(FIND_MY_SPAWNS, {
      filter: function(e) {
        return !e.spawning;
      }
    });
  }
  if (m.length === 0) {
    return "[Signbot] No available spawn in " + e;
  }
  var g = [ MOVE ];
  var u = spawnManager.bodyCost(g);
  if (u > m[0].room.energyAvailable) {
    return "[Signbot] Not enough energy in " + e + ". Need: " + u + ", Have: " + m[0].room.energyAvailable;
  }
  var l = "Signbot_" + o + "_" + Game.time;
  var c = {
    role: "signbot",
    targetRoom: o,
    signMessage: n
  };
  if (r === "highway") {
    c.routeMode = r;
    c.routeOrigin = e;
    c.highwayRoute = t;
  }
  var f = spawnManager.spawnCustomCreep(m[0], g, l, c);
  if (f === OK) {
    console.log("[Signbot] Spawning '" + l + "' from " + e + " to sign " + o + (r === "highway" ? " via highways" : "") + ' with: "' + n + '"');
    return "[Signbot] Successfully ordered signbot from " + e + " to " + o;
  } else {
    return "[Signbot] Failed to spawn signbot: " + f;
  }
};
function hasActivePermanentSignbot(e) {
  for (var o in Game.creeps) {
    var n = Game.creeps[o];
    if (n && n.memory && n.memory.role === "signbot" && n.memory.targetRoom === e) return true;
  }
  return false;
}

function findNearestAvailableSpawnRoom(e) {
  var o = getRoomState.ownedNames();
  var n = null;
  var r = Infinity;
  for (var t = 0; t < o.length; t++) {
    var a = o[t];
    var i = getRoomState.get(a);
    var s = i && i.structuresByType && i.structuresByType[STRUCTURE_SPAWN];
    if (!s) continue;
    var m = false;
    for (var g = 0; g < s.length; g++) {
      if (s[g].my && !s[g].spawning) {
        m = true;
        break;
      }
    }
    if (!m) continue;
    var u = Game.map.getRoomLinearDistance(a, e);
    if (u < r) {
      n = a;
      r = u;
    }
  }
  return n;
}

global.orderPermanentSign = function(e, o, n) {
  var r = Game.rooms[o];
  var t = getRoomState.get(o);
  if (!r || !r.controller || !r.controller.my || !t || !t.permanentFacts) {
    return "[PermanentSign] " + o + " must be a visible owned room with permanent facts.";
  }
  var a = permanentRoomFacts.encode(t.permanentFacts);
  if (!a) return "[PermanentSign] Could not encode permanent facts for " + o + ".";
  var i = r.controller.sign;
  if (i && i.text === a) return "[PermanentSign] " + o + " already has the current capsule.";
  var s = r.controller.owner && r.controller.owner.username;
  if (i && i.text && i.username !== s && n !== true) {
    return "[PermanentSign] " + o + " has a foreign sign; using live facts instead. Pass true to replace it deliberately.";
  }
  if (hasActivePermanentSignbot(o)) return "[PermanentSign] A signbot is already travelling to " + o + ".";
  return global.orderSign(e, o, a, undefined);
};
