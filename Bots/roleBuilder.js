// LLM: Read docs/codex.js before reviewing or changing this file.
// roleBuilder.js
// Role dispatch: memory.role === 'builder' -> roleBuilder.run(creep).
// Example: require('roleBuilder').run(creep);
// Example: require('roleBuilder').run(creep);
var getRoomState = require("getRoomState");
var util = require("util");
const BUILDER_LOGGING = false;
const BUILDER_LOG_INTERVAL = 5;
const RAMPART_REINFORCE_TARGET = 1e5;
const TERMINAL_ENERGY_RESERVE = 1e3;
const PRIORITIES = [ {
  type: "repair",
  filter: function(e) {
    if (e.structureType === STRUCTURE_RAMPART) {
      return e.hits < 1e3;
    }
    return e.structureType !== STRUCTURE_CONTAINER && e.structureType !== STRUCTURE_WALL && e.hits / e.hitsMax < .25 && e.hits < e.hitsMax;
  },
  label: "Repair <25%"
}, {
  type: "build",
  filter: function(e) {
    return true;
  },
  label: "Build"
}, {
  type: "repair",
  filter: function(e) {
    return e.structureType === STRUCTURE_CONTAINER && e.hits / e.hitsMax < .75 && e.hits < e.hitsMax;
  },
  label: "Repair Container <75%"
}, {
  type: "repair",
  filter: function(e) {
    return e.structureType === STRUCTURE_ROAD && e.hits / e.hitsMax < .75 && e.hits / e.hitsMax >= .25 && e.hits < e.hitsMax;
  },
  label: "Repair Road <75%"
} ];
function flattenStructures(e) {
  var r = [];
  for (var t in e) {
    if (!e.hasOwnProperty(t)) continue;
    var o = e[t];
    for (var a = 0; a < o.length; a++) r.push(o[a]);
  }
  return r;
}

function closestByRange(e, r) {
  var t = null;
  var o = Infinity;
  for (var a = 0; a < r.length; a++) {
    var n = r[a];
    var i = n.pos && n.pos.x !== undefined ? n.pos : n;
    var s = e.getRangeTo(i);
    if (s < o) {
      o = s;
      t = n;
    }
  }
  return t;
}

function resolveById(e, r, t) {
  if (!e) return null;
  var o = Game.getObjectById(e);
  if (o) return o;
  var a = getRoomState.get(r.name);
  if (t === "dropped") {
    var n = [];
    if (a && a.dropped) {
      var i = a.dropped;
      for (var s = 0; s < i.length; s++) {
        if (i[s].resourceType === RESOURCE_ENERGY) n.push(i[s]);
      }
    } else {
      n = r.find(FIND_DROPPED_RESOURCES, {
        filter: function(e) {
          return e.resourceType === RESOURCE_ENERGY;
        }
      });
    }
    if (!n.length) return null;
    var u = r.controller ? r.controller.pos : n[0].pos;
    return closestByRange(u, n);
  }
  if (t === STRUCTURE_STORAGE || t === STRUCTURE_TERMINAL || t === STRUCTURE_CONTAINER || t === STRUCTURE_LINK) {
    var l = [];
    if (a && a.structuresByType && a.structuresByType[t]) {
      var R = a.structuresByType[t];
      for (var f = 0; f < R.length; f++) {
        if (R[f].store && R[f].store[RESOURCE_ENERGY] > 0) l.push(R[f]);
      }
    } else {
      l = r.find(FIND_STRUCTURES, {
        filter: function(e) {
          return e.structureType === t && e.store && e.store[RESOURCE_ENERGY] > 0;
        }
      });
    }
    if (!l.length) return null;
    var m = r.controller ? r.controller.pos : l[0].pos;
    return closestByRange(m, l);
  }
  return null;
}

function findBestJob(e) {
  var r = getRoomState.get(e.room.name);
  if (!r) return null;
  var t = [];
  var o = r.structuresByType ? flattenStructures(r.structuresByType) : [];
  for (var a = 0; a < PRIORITIES.length; a++) {
    var n = PRIORITIES[a];
    if ((n.type === "repair" || n.type === "reinforce") && (!r.controller || !r.controller.my)) {
      continue;
    }
    var i;
    if (n.type === "build") {
      i = r.constructionSites || [];
    } else {
      i = [];
      for (var s = 0; s < o.length; s++) {
        var u = o[s];
        if (n.filter(u)) i.push(u);
      }
    }
    for (var l = 0; l < i.length; l++) {
      t.push({
        target: i[l],
        type: n.type,
        label: n.label
      });
    }
  }
  if (!t.length) return null;
  for (var R = 0; R < t.length; R++) {
    var f = t[R];
    if (f.type === "build" && f.target.structureType === STRUCTURE_SPAWN) {
      return f;
    }
  }
  var m = null;
  var T = r.structuresByType && r.structuresByType[STRUCTURE_STORAGE] || [];
  if (T.length > 0) {
    m = T[0].pos;
  }
  if (!m) {
    var E = r.structuresByType && r.structuresByType[STRUCTURE_SPAWN] || [];
    if (E.length > 0) {
      m = E[0].pos;
    }
  }
  if (!m) {
    m = e.pos;
  }
  var y = null;
  var g = Infinity;
  for (var v = 0; v < t.length; v++) {
    var p = t[v];
    var c = m.getRangeTo(p.target.pos);
    if (c < g) {
      g = c;
      y = p;
    }
  }
  return y;
}

function logBuilderTasks(e, r) {
  console.log("🔨 BUILDER STATUS - " + e.name + " (Tick " + Game.time + ")");
  console.log("┌────────────────────────────┬──────────────┬──────────────┐");
  console.log("│    Name                    │   Task       │   Target     │");
  console.log("├────────────────────────────┼──────────────┼──────────────┤");
  var t = _.filter(getRoomState.creepIndex().all, function(r) {
    return r.memory.role === "builder" && r.room.name === e.name;
  });
  if (!t.length) {
    console.log("│               No builder creeps in this room.              │");
  } else {
    for (var o = 0; o < t.length; o++) {
      var a = t[o];
      var n = (a.name + "                          ").slice(0, 26);
      var i = a.memory.task && a.memory.task.label ? a.memory.task.label : "Idle";
      i = (i + "            ").slice(0, 12);
      var s = a.memory.task && a.memory.task.targetId ? a.memory.task.targetId.slice(-6) : "";
      s = (s + "            ").slice(0, 12);
      console.log("│ " + n + " │ " + i + " │ " + s + " │");
    }
  }
  console.log("└────────────────────────────┴──────────────┴──────────────┘");
}

function findIdleSpotNearRoad(e) {
  if (e.memory.idleSpotPos) {
    var r = e.memory.idleSpotPos;
    var t = new RoomPosition(r.x, r.y, r.roomName);
    var o = t.lookFor(LOOK_CREEPS).length > 0;
    if (!o || e.pos.isEqualTo(t)) {
      return t;
    }
    delete e.memory.idleSpotPos;
  }
  var a = getRoomState.get(e.room.name);
  var n = a && a.structuresByType && a.structuresByType[STRUCTURE_ROAD] || [];
  if (!n.length) return null;
  var i = closestByRange(e.pos, n);
  if (!i) return null;
  var s = [];
  for (var u = -1; u <= 1; u++) {
    for (var l = -1; l <= 1; l++) {
      if (u === 0 && l === 0) continue;
      var R = i.pos.x + u;
      var f = i.pos.y + l;
      if (R < 0 || R > 49 || f < 0 || f > 49) continue;
      var m = new RoomPosition(R, f, i.pos.roomName);
      if (isNearRoomEdge(m, 1)) continue;
      var T = m.lookFor(LOOK_STRUCTURES);
      var E = false;
      var y = false;
      for (var g = 0; g < T.length; g++) {
        var v = T[g];
        if (v.structureType === STRUCTURE_ROAD) E = true;
        if (OBSTACLE_OBJECT_TYPES.indexOf(v.structureType) !== -1) y = true;
      }
      var o = m.lookFor(LOOK_CREEPS).length > 0;
      var p = m.lookFor(LOOK_TERRAIN);
      if (p[0] === "wall" || E || o || y) continue;
      s.push(m);
    }
  }
  if (!s.length) return null;
  var c = closestByRange(e.pos, s);
  if (c) {
    e.memory.idleSpotPos = {
      x: c.x,
      y: c.y,
      roomName: c.roomName
    };
  }
  return c;
}

function isNearRoomEdge(e, r) {
  r = r || 2;
  return e.x < r || e.x > 49 - r || e.y < r || e.y > 49 - r;
}

var nudgeOffRoomEdge = util.nudgeOffRoomEdge;
function applyEdgePenalty(e, r) {
  for (var t = 0; t < 50; t++) {
    r.set(t, 0, 255);
    r.set(t, 49, 255);
    var o = r.get(t, 1);
    var a = r.get(t, 48);
    r.set(t, 1, Math.max(o, 10));
    r.set(t, 48, Math.max(a, 10));
  }
  for (var n = 0; n < 50; n++) {
    r.set(0, n, 255);
    r.set(49, n, 255);
    var i = r.get(1, n);
    var s = r.get(48, n);
    r.set(1, n, Math.max(i, 10));
    r.set(48, n, Math.max(s, 10));
  }
}

function buildBuilderCostMatrix(e, r, t) {
  var o = new Room.Terrain(e.name);
  for (var a = 0; a < 50; a++) {
    for (var n = 0; n < 50; n++) {
      var i = o.get(a, n);
      if (i === TERRAIN_MASK_WALL) {
        r.set(a, n, 255);
      }
    }
  }
  var s = e.find(FIND_STRUCTURES);
  for (var u = 0; u < s.length; u++) {
    var l = s[u];
    if (l.structureType === STRUCTURE_WALL) {
      r.set(l.pos.x, l.pos.y, 255);
    } else if (l.structureType === STRUCTURE_RAMPART) {
      if (!l.my && !l.isPublic) {
        r.set(l.pos.x, l.pos.y, 255);
      }
    }
  }
  if (!t) {
    applyEdgePenalty(e.name, r);
  }
  return r;
}

function moveToWithinRoom(e, r, t) {
  if (e.fatigue > 0) return ERR_TIRED;
  if (isNearRoomEdge(e.pos, 1)) {
    if (nudgeOffRoomEdge(e)) return;
  }
  var o = t || {};
  o.maxRooms = 1;
  o.plainCost = 2;
  o.swampCost = 3;
  var a = false;
  var n = null;
  if (r && r.pos && r.pos.roomName === e.room.name) {
    a = isNearRoomEdge(r.pos, 1);
    n = r.pos;
  } else if (r && r.x !== undefined && r.roomName) {
    n = r;
    a = isNearRoomEdge(n, 1);
  }
  o.costCallback = function(r, t) {
    if (r === e.room.name) {
      var o = Game.rooms[r];
      if (o) {
        buildBuilderCostMatrix(o, t, a);
      }
    }
  };
  return e.moveTo(r, o);
}

function countOpenAdjacentTiles(e) {
  var r = new Room.Terrain(e.pos.roomName);
  var t = 0;
  for (var o = -1; o <= 1; o++) {
    for (var a = -1; a <= 1; a++) {
      if (o === 0 && a === 0) continue;
      var n = e.pos.x + o;
      var i = e.pos.y + a;
      if (n < 1 || n > 48 || i < 1 || i > 48) continue;
      if (r.get(n, i) !== TERRAIN_MASK_WALL) t++;
    }
  }
  return t;
}

function clearHarvestSource(e) {
  delete e.memory.harvestSourceId;
  delete e.memory.harvestSourceRoomName;
}

function canFillBuilderFrom(e, r) {
  if (!e || !e.store) return false;
  var t = e.store[RESOURCE_ENERGY] || 0;
  if (e.structureType === STRUCTURE_TERMINAL) {
    t -= TERMINAL_ENERGY_RESERVE;
  }
  return t >= r;
}

function useHarvestSource(e, r) {
  if (!r || r.energy <= 0 || e.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    clearHarvestSource(e);
    return false;
  }
  if (!e.pos.inRangeTo(r, 1)) {
    moveToWithinRoom(e, r, {
      range: 1,
      reusePath: 15
    });
    return true;
  }
  var t = e.harvest(r);
  if (t === ERR_NOT_ENOUGH_RESOURCES || t === ERR_INVALID_TARGET) {
    clearHarvestSource(e);
  }
  return true;
}

function acquireEnergy(e) {
  var r = e.room;
  var t = getRoomState.get(e.room.name);
  var o = e.store.getCapacity(RESOURCE_ENERGY);
  var a = e.memory.task;
  var n = a && a.targetId ? resolveById(a.targetId, e.room, a.type) : null;
  if (e.memory.harvestSourceId) {
    var i = Game.getObjectById(e.memory.harvestSourceId);
    if (i && i.pos.roomName === e.room.name) {
      if (useHarvestSource(e, i)) return true;
    } else {
      clearHarvestSource(e);
    }
  }
  var s = [];
  var u = [];
  var l = [];
  var R = [];
  if (t && t.structuresByType) {
    s = t.structuresByType[STRUCTURE_STORAGE] || [];
    u = t.structuresByType[STRUCTURE_CONTAINER] || [];
    l = t.structuresByType[STRUCTURE_TERMINAL] || [];
    R = t.structuresByType[STRUCTURE_LINK] || [];
  }
  var f = [];
  for (var m = 0; m < s.length; m++) {
    var T = s[m];
    if (T && T.store && T.store[RESOURCE_ENERGY] >= o) {
      f.push(T);
    }
  }
  var E = n ? closestByRange(n.pos, f) : closestByRange(e.pos, f);
  var y = [];
  if (n && r.controller && r.controller.my) {
    for (var g = 0; g < R.length; g++) {
      var v = R[g];
      if (!v || v.my !== true || !v.store) continue;
      if (v.pos.getRangeTo(r.controller) > 2) continue;
      if ((v.store[RESOURCE_ENERGY] || 0) < o) continue;
      y.push(v);
    }
  }
  var p = n ? closestByRange(n.pos, y) : null;
  var c = E;
  if (n && p) {
    if (!E || n.pos.getRangeTo(p) < n.pos.getRangeTo(E)) {
      c = p;
    }
  }
  var d = [];
  for (var S = 0; S < l.length; S++) {
    var _ = l[S];
    if (_ && _.store && _.store[RESOURCE_ENERGY] > TERMINAL_ENERGY_RESERVE) {
      d.push(_);
    }
  }
  var h = d.length > 0;
  if (e.memory.energyTargetId) {
    var N = resolveById(e.memory.energyTargetId, e.room, e.memory.energyTargetType || null);
    if (N && N.pos && N.pos.roomName && N.pos.roomName !== e.room.name) {
      delete e.memory.energyTargetId;
      delete e.memory.energyTargetType;
      N = null;
    }
    if (N && !canFillBuilderFrom(N, o)) {
      delete e.memory.energyTargetId;
      delete e.memory.energyTargetType;
      N = null;
    }
    if (N && (N.structureType === STRUCTURE_STORAGE || N.structureType === STRUCTURE_LINK)) {
      if (!c || N.id !== c.id) {
        delete e.memory.energyTargetId;
        delete e.memory.energyTargetType;
        N = null;
      }
    }
    if (N) {
      if (N.structureType && N.store && N.store[RESOURCE_ENERGY] > 0) {
        if (!e.pos.inRangeTo(N, 1)) {
          moveToWithinRoom(e, N, {
            range: 1,
            reusePath: 15
          });
          return true;
        }
        var U = e.withdraw(N, RESOURCE_ENERGY);
        if (U === OK) return true;
        if (U === ERR_NOT_ENOUGH_RESOURCES || U === ERR_INVALID_TARGET) {
          delete e.memory.energyTargetId;
          delete e.memory.energyTargetType;
        }
        return true;
      }
    }
    delete e.memory.energyTargetId;
    delete e.memory.energyTargetType;
  }
  if (c) {
    e.memory.energyTargetId = c.id;
    e.memory.energyTargetType = c.structureType;
    if (!e.pos.inRangeTo(c, 1)) {
      moveToWithinRoom(e, c, {
        range: 1,
        reusePath: 15
      });
      return true;
    }
    var I = e.withdraw(c, RESOURCE_ENERGY);
    if (I === ERR_NOT_ENOUGH_RESOURCES || I === ERR_INVALID_TARGET) {
      delete e.memory.energyTargetId;
      delete e.memory.energyTargetType;
    }
    return true;
  }
  if (h) {
    var C = [];
    for (var O = 0; O < d.length; O++) {
      var A = d[O];
      var B = A.store[RESOURCE_ENERGY] - TERMINAL_ENERGY_RESERVE;
      if (B >= o) {
        C.push(A);
      }
    }
    var G = C;
    var P = closestByRange(e.pos, G);
    if (P) {
      e.memory.energyTargetId = P.id;
      e.memory.energyTargetType = STRUCTURE_TERMINAL;
      return true;
    }
  }
  var L = [];
  for (var b = 0; b < u.length; b++) {
    var x = u[b];
    if (x && x.store && x.store[RESOURCE_ENERGY] >= o) {
      L.push(x);
    }
  }
  if (L.length) {
    var M = closestByRange(e.pos, L);
    if (M) {
      e.memory.energyTargetId = M.id;
      e.memory.energyTargetType = STRUCTURE_CONTAINER;
      return true;
    }
  }
  var k = t && t.sources ? t.sources : [];
  var Y = [];
  for (var g = 0; g < k.length; g++) {
    if (k[g] && k[g].energy > 0) Y.push(k[g]);
  }
  var D = [];
  for (var F = 0; F < Y.length; F++) {
    var w = Y[F];
    var W = w.pos.findInRange(FIND_CREEPS, 1);
    var H = 0;
    for (var K = 0; K < W.length; K++) {
      if (W[K].id !== e.id) H++;
    }
    if (H < countOpenAdjacentTiles(w)) {
      D.push(w);
    }
  }
  var V = D.length ? D : Y;
  var q = closestByRange(e.pos, V);
  if (q) {
    e.memory.harvestSourceId = q.id;
    e.memory.harvestSourceRoomName = q.pos.roomName;
    return useHarvestSource(e, q);
  }
  return false;
}

function findWinddownDepositTarget(e) {
  var r = e.room;
  var t = [ r.storage, r.terminal ];
  for (var o = 0; o < t.length; o++) {
    var a = t[o];
    if (a && a.store && a.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      return a;
    }
  }
  var n = r.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_CONTAINER && e.store && e.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    }
  });
  return closestByRange(e.pos, n);
}

function runLowTtlWinddown(e) {
  if (e.memory && e.memory.role === "remoteBuilder") return false;
  if (typeof e.ticksToLive !== "number" || e.ticksToLive >= 100) return false;
  if (e.room.find(FIND_CONSTRUCTION_SITES).length > 0) return false;
  var r = findWinddownDepositTarget(e);
  if (!r) {
    return true;
  }
  if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    e.suicide();
    return true;
  }
  var t = e.transfer(r, RESOURCE_ENERGY);
  if (t === ERR_NOT_IN_RANGE) {
    moveToWithinRoom(e, r, {
      range: 1,
      reusePath: 15
    });
  }
  return true;
}

var roleBuilder = {
  run: function(e) {
    getRoomState.init();
    if (runLowTtlWinddown(e)) return;
    if (e.memory.filling && e.store.getFreeCapacity() === 0) {
      e.memory.filling = false;
      clearHarvestSource(e);
      delete e.memory.idleSpotPos;
    }
    if (!e.memory.filling && e.store[RESOURCE_ENERGY] === 0) {
      e.memory.filling = true;
      clearHarvestSource(e);
    }
    if (e.memory.filling) {
      if (!acquireEnergy(e)) {
        var r = findIdleSpotNearRoad(e);
        if (r && !e.pos.isEqualTo(r)) {
          moveToWithinRoom(e, r, {
            reusePath: 15
          });
        }
      }
      return;
    }
    var t = e.memory.task || {};
    var o = t.targetId ? resolveById(t.targetId, e.room, t.type) : null;
    var a = false;
    if (t.type === "build") {
      if (!o) {
        if (t.structureType === STRUCTURE_RAMPART && t.targetPos) {
          var n = new RoomPosition(t.targetPos.x, t.targetPos.y, t.targetPos.roomName);
          var i = n.lookFor(LOOK_STRUCTURES);
          var s = null;
          for (var u = 0; u < i.length; u++) {
            if (i[u].structureType === STRUCTURE_RAMPART) {
              s = i[u];
              break;
            }
          }
          if (s && s.hits < RAMPART_REINFORCE_TARGET) {
            e.memory.task = {
              type: "reinforce",
              targetId: s.id,
              label: "Reinforce Rampart"
            };
            t = e.memory.task;
            o = s;
          } else {
            a = true;
          }
        } else {
          a = true;
        }
      } else if (o.progress >= o.progressTotal) {
        a = true;
      }
    }
    if (t.type === "repair" && (!o || o.hits >= o.hitsMax)) a = true;
    if (t.type === "reinforce") {
      if (!o) {
        a = true;
      } else if (o.structureType === STRUCTURE_RAMPART) {
        if (o.hits >= RAMPART_REINFORCE_TARGET) {
          a = true;
        } else if (o.hits >= o.hitsMax) {
          a = true;
        }
      } else {
        if (o.hits >= o.hitsMax) {
          a = true;
        }
      }
    }
    if (a) {
      delete e.memory.task;
      t = {};
      o = null;
    }
    if (!t.targetId) {
      var l = findBestJob(e);
      if (l) {
        var R = {
          type: l.type,
          targetId: l.target.id,
          label: l.label
        };
        if (l.type === "build" && l.target.pos) {
          R.structureType = l.target.structureType;
          R.targetPos = {
            x: l.target.pos.x,
            y: l.target.pos.y,
            roomName: l.target.pos.roomName
          };
        }
        e.memory.task = R;
      } else {
        e.memory.task = {
          type: "idle",
          targetId: null,
          label: "Idle"
        };
      }
      t = e.memory.task;
      o = t.targetId ? resolveById(t.targetId, e.room, t.type) : null;
    }
    if (!o && t.type !== "idle") {
      delete e.memory.task;
    } else {
      switch (t.type) {
       case "build":
        {
          var f = 3;
          if (!e.pos.inRangeTo(o, f)) {
            moveToWithinRoom(e, o, {
              range: f,
              reusePath: 15
            });
          } else {
            e.build(o);
          }
          break;
        }
       case "repair":
       case "reinforce":
        {
          var m = 3;
          if (!e.pos.inRangeTo(o, m)) {
            moveToWithinRoom(e, o, {
              range: m,
              reusePath: 15
            });
          } else {
            e.repair(o);
          }
          break;
        }
       case "idle":
       default:
        {
          var T = findIdleSpotNearRoad(e);
          if (T && !e.pos.isEqualTo(T)) {
            moveToWithinRoom(e, T, {
              visualizePathStyle: {
                stroke: "#888888"
              },
              reusePath: 15
            });
          }
          break;
        }
      }
    }
    if (BUILDER_LOGGING && Game.time % BUILDER_LOG_INTERVAL === 0) {
      logBuilderTasks(e.room, e);
    }
  }
};
module.exports = roleBuilder;
