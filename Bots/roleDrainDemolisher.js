// LLM: Read docs/codex.js before reviewing or changing this file.
// roleDrainDemolisher.js
// Role dispatch: memory.role === 'drainDemolisher' -> roleDrainDemolisher.run(creep).
// Example: require('roleDrainDemolisher').run(creep);
//   orderDrainDemolisher(homeRoom, targetRoom, count, preferredEdge, target)
//   testDrainDemolisher(homeRoom, targetRoom, count, preferredEdge, target)
//   cancelTowerDrainOrder(homeRoom, targetRoom)
var PARK_BLOCKED_TICKS = 10;
var ORPHAN_CHECK_INTERVAL = 50;
var getRoomState = require("getRoomState");
function deriveHealerParkPos(e, r, o, a) {
  if (!e || !r || !o) return null;
  var t = 0, i = 0;
  if (e === "W") t = -1; else if (e === "E") t = 1; else if (e === "N") i = -1; else if (e === "S") i = 1; else return null;
  var n = Game.map.getRoomTerrain(o);
  function usable(e, r) {
    if (e < 2 || e > 47 || r < 2 || r > 47) return false;
    if (n.get(e, r) === TERRAIN_MASK_WALL) return false;
    if (a) {
      for (var o = 0; o < a.length; o++) {
        if (a[o] && a[o].x === e && a[o].y === r) return false;
      }
    }
    return true;
  }
  var m = [];
  var s = {
    x: r.x + t,
    y: r.y + i
  };
  if (usable(s.x, s.y)) m.push(s);
  for (var l = -1; l <= 1; l++) {
    for (var f = -1; f <= 1; f++) {
      if (l === 0 && f === 0) continue;
      var u = r.x + l;
      var R = r.y + f;
      if (u === s.x && R === s.y) continue;
      if (usable(u, R)) m.push({
        x: u,
        y: R
      });
    }
  }
  if (m.length === 0) return null;
  m.sort(function(e, r) {
    var o = n.get(e.x, e.y) === TERRAIN_MASK_SWAMP ? 1 : 0;
    var a = n.get(r.x, r.y) === TERRAIN_MASK_SWAMP ? 1 : 0;
    return o - a;
  });
  return {
    x: m[0].x,
    y: m[0].y,
    roomName: o
  };
}

function findWorker(e) {
  var r = e.memory.squadId;
  if (!r) return null;
  return _.find(getRoomState.creepIndex().all, function(e) {
    return e && e.memory && e.memory.role === "towerDrain" && e.memory.variant === "drainDemolisher" && e.memory.squadId === r;
  });
}

function findAlternateHealTarget(e, r) {
  var o = r && r.id;
  var a = e.pos.findInRange(FIND_MY_CREEPS, 3, {
    filter: function(r) {
      return r.id !== e.id && r.id !== o && r.hits < r.hitsMax;
    }
  });
  if (a.length === 0) return null;
  a.sort(function(r, o) {
    var a = e.pos.getRangeTo(r) <= 1 ? 0 : 1;
    var t = e.pos.getRangeTo(o) <= 1 ? 0 : 1;
    if (a !== t) return a - t;
    return r.hits / r.hitsMax - o.hits / o.hitsMax;
  });
  return a[0];
}

function otherHealerParkTiles(e) {
  var r = [];
  var o = getRoomState.creepIndex();
  var a = o && o.all ? o.all : [];
  for (var t = 0; t < a.length; t++) {
    var i = a[t];
    if (i.name === e.name || !i.memory) continue;
    if (i.memory.role !== "drainDemolisher") continue;
    if (i.memory.homeRoom !== e.memory.homeRoom) continue;
    if (i.memory.targetRoom !== e.memory.targetRoom) continue;
    if (i.memory.healerParkPos) r.push(i.memory.healerParkPos);
  }
  return r;
}

function followRoomRoute(e) {
  var r = e.memory.route;
  var o = e.memory.safeRoom;
  if (!r || r.length === 0) {
    e.moveTo(new RoomPosition(25, 25, o), {
      reusePath: 10
    });
    return ERR_NOT_FOUND;
  }
  var a = e.room.name;
  if (a === o) return OK;
  var t = {};
  for (var i = 0; i < r.length; i++) {
    t[r[i]] = true;
  }
  if (!t[a]) {
    console.log("[DrainDemolisher] WARNING: " + e.name + " in unauthorized room " + a);
    e.moveTo(25, 25);
    return ERR_NOT_FOUND;
  }
  var n = r.indexOf(a);
  if (n === -1) n = 0;
  var m = n + 1;
  if (m >= r.length) return OK;
  var s = r[m];
  if (s === e.memory.targetRoom) return OK;
  var l = Game.map.findExit(a, s);
  if (l < 0) {
    console.log("[DrainDemolisher] WARNING: " + e.name + " route has non-adjacent hop " + a + " -> " + s + ", seeking skip");
    var f = false;
    for (var u = m + 1; u < r.length; u++) {
      if (r[u] === e.memory.targetRoom) break;
      var R = Game.map.findExit(a, r[u]);
      if (R > 0) {
        s = r[u];
        l = R;
        console.log("[DrainDemolisher] Skipping to " + s + " (index " + u + ")");
        f = true;
        break;
      }
    }
    if (!f) {
      e.moveTo(new RoomPosition(25, 25, o), {
        reusePath: 10
      });
      return ERR_NO_PATH;
    }
  }
  if (l < 0) return ERR_NO_PATH;
  var y = e.room.find(l);
  if (y.length === 0) return ERR_NO_PATH;
  var v = y.map(function(e) {
    return {
      pos: e,
      range: 0
    };
  });
  var h = e.id;
  var p = PathFinder.search(e.pos, v, {
    maxRooms: 1,
    maxOps: 2e3,
    plainCost: 2,
    swampCost: 10,
    roomCallback: function(e) {
      if (e !== a) return false;
      var r = Game.rooms[e];
      if (!r) return false;
      var o = new PathFinder.CostMatrix;
      r.find(FIND_STRUCTURES).forEach(function(e) {
        if (e.structureType === STRUCTURE_ROAD) {
          o.set(e.pos.x, e.pos.y, 1);
        } else if (e.structureType !== STRUCTURE_CONTAINER && (e.structureType !== STRUCTURE_RAMPART || !e.my)) {
          o.set(e.pos.x, e.pos.y, 255);
        }
      });
      r.find(FIND_CREEPS).forEach(function(e) {
        if (e.id !== h) {
          o.set(e.pos.x, e.pos.y, 255);
        }
      });
      return o;
    }
  });
  if (p.incomplete || p.path.length === 0) {
    var T = e.pos.findClosestByRange(l);
    if (T) {
      e.moveTo(T, {
        maxRooms: 1,
        reusePath: 0
      });
    }
    return ERR_NO_PATH;
  }
  var d = e.moveByPath(p.path);
  if (d !== OK && d !== ERR_TIRED) {
    if (p.path[0]) {
      var c = e.pos.getDirectionTo(p.path[0]);
      e.move(c);
    }
  }
  return OK;
}

function stateTraveling(e) {
  var r = e.memory.safeRoom;
  if (e.room.name !== r) {
    followRoomRoute(e);
    e.say("🚑");
    return;
  }
  var o = e.memory.healerParkPos;
  if (!o) {
    o = deriveHealerParkPos(e.memory.entryEdge, e.memory.healRestPos, r, otherHealerParkTiles(e));
    if (!o) {
      console.log("[DrainDemolisher] " + e.name + " cannot derive a park tile in " + r + ", suiciding");
      e.suicide();
      return;
    }
    e.memory.healerParkPos = o;
  }
  if (e.pos.x === o.x && e.pos.y === o.y) {
    e.memory.state = "parked";
    e.say("🅿️");
    return;
  }
  e.moveTo(new RoomPosition(o.x, o.y, r), {
    maxRooms: 1,
    reusePath: 5
  });
  e.say("🎯");
}

function stateParked(e) {
  var r = e.memory.healerParkPos;
  if (!r) {
    e.memory.state = "traveling";
    return;
  }
  if (e.pos.x === r.x && e.pos.y === r.y) {
    e.memory.parkBlockedTicks = 0;
    return;
  }
  var o = new RoomPosition(r.x, r.y, e.room.name);
  var a = false;
  var t = o.lookFor(LOOK_CREEPS);
  if (t.length > 0) a = true;
  if (!a) {
    var i = o.lookFor(LOOK_STRUCTURES);
    for (var n = 0; n < i.length; n++) {
      var m = i[n].structureType;
      if (m !== STRUCTURE_ROAD && m !== STRUCTURE_CONTAINER && (m !== STRUCTURE_RAMPART || !i[n].my)) {
        a = true;
        break;
      }
    }
  }
  if (a) {
    e.memory.parkBlockedTicks = (e.memory.parkBlockedTicks || 0) + 1;
    if (e.memory.parkBlockedTicks > PARK_BLOCKED_TICKS) {
      var s = otherHealerParkTiles(e);
      s.push({
        x: r.x,
        y: r.y
      });
      var l = deriveHealerParkPos(e.memory.entryEdge, e.memory.healRestPos, e.memory.safeRoom, s);
      if (l) {
        console.log("[DrainDemolisher] " + e.name + " park tile (" + r.x + "," + r.y + ") blocked, moving to (" + l.x + "," + l.y + ")");
        e.memory.healerParkPos = l;
      }
      e.memory.parkBlockedTicks = 0;
    }
  } else {
    e.memory.parkBlockedTicks = 0;
  }
  e.moveTo(new RoomPosition(e.memory.healerParkPos.x, e.memory.healerParkPos.y, e.memory.safeRoom), {
    maxRooms: 1,
    reusePath: 0
  });
}

function run(e) {
  if (e.spawning) return;
  if (!e.memory.notifyDisabled) {
    if (e.notifyWhenAttacked(false) === OK) {
      e.memory.notifyDisabled = true;
    }
  }
  if (!e.memory.state) e.memory.state = "traveling";
  if (Game.time % ORPHAN_CHECK_INTERVAL === 0) {
    var r = e.memory.homeRoom + "->" + e.memory.targetRoom;
    var o = Memory.towerDrainOps && Memory.towerDrainOps.operations;
    if (!o || !o[r]) {
      console.log("[DrainDemolisher] " + e.name + " orphaned (no op " + r + "), suiciding");
      e.suicide();
      return;
    }
  }
  var a = findWorker(e);
  var t = false;
  if (a && !a.spawning && a.room.name === e.room.name && a.hits < a.hitsMax) {
    var i = e.pos.getRangeTo(a);
    if (i <= 1) {
      e.heal(a);
      t = true;
    } else if (i <= 3) {
      e.rangedHeal(a);
      t = true;
    }
  }
  if (!t) {
    var n = findAlternateHealTarget(e, a);
    if (n) {
      var m = e.pos.getRangeTo(n);
      if (m <= 1) {
        e.heal(n);
        t = true;
      } else if (m <= 3) {
        e.rangedHeal(n);
        t = true;
      }
    }
  }
  if (!t && e.hits < e.hitsMax) {
    e.heal(e);
  }
  if (e.memory.state === "parked") {
    stateParked(e);
  } else {
    stateTraveling(e);
  }
}

module.exports = {
  run: run,
  deriveHealerParkPos: deriveHealerParkPos
};
