// LLM: Read docs/codex.js before reviewing or changing this file.
// roleRepairer.js
// Role dispatch: memory.role === 'repairer' -> roleRepairer.run(creep).
// Example: require('roleRepairer').run(creep);
// Example: require('roleRepairer').run(creep);
var getRoomState = require("getRoomState");
var defenseMonitor = require("defenseMonitor");
var repairManager = require("repairManager");
var util = require("util");
var REEVAL_TICKS_DEFAULT = 50;
var REEVAL_TICKS_ROADS = 20;
var REEVAL_TICKS_WALLS = 100;
var REPAIR_SOURCE_STICKY_MIN_ENERGY = 200;
var MOVE_OPTS_CLOSE = {
  reusePath: 15,
  range: 1
};
var MOVE_OPTS_REPAIR = {
  reusePath: 15,
  range: 3
};
var WALLREPAIR_THRESHOLD_BY_RCL = [ 0, 0, 1e4, 5e4, 2e5, 1e6, 5e6, 1e7, 5e7 ];
var ROAD_REPAIR_TARGET = .8;
var CONTAINER_DONE_HITS = 244e3;
var NUKE_GROUND_ZERO_DAMAGE = 1e7;
var NUKE_SPLASH_DAMAGE = 5e6;
var NUKE_SAFETY_MARGIN = 5e5;
var DEFENSE_REPAIR_TARGET_RATIO = .97;
function getHomeRoom(e) {
  return e.memory && (e.memory.homeRoom || e.memory.assignedRoom) || null;
}

var isEdge = util.isOnRoomEdge;
var nudgeOffEdge = util.nudgeOffRoomEdge;
function blockEdgeSquares(e) {
  for (var r = 0; r < 50; r++) {
    e.set(r, 0, 255);
    e.set(r, 49, 255);
  }
  for (var t = 0; t < 50; t++) {
    e.set(0, t, 255);
    e.set(49, t, 255);
  }
}

function targetRoomName(e) {
  if (!e) return null;
  if (e.pos) return e.pos.roomName;
  return e.roomName || null;
}

function moveRepairer(e, r, t) {
  if (e.fatigue > 0) return ERR_TIRED;
  if (isEdge(e.pos) && nudgeOffEdge(e)) return OK;
  var o = targetRoomName(r);
  var a = !o || o === e.room.name;
  var n = {};
  t = t || {};
  for (var m in t) n[m] = t[m];
  if (a) {
    var i = n.costCallback;
    n.maxRooms = 1;
    n.costCallback = function(r, t) {
      var o = i ? i(r, t) : t;
      var a = o || t;
      if (r === e.room.name) blockEdgeSquares(a);
      return a;
    };
  }
  return e.moveTo(r, n);
}

function park(e, r) {
  r = r || getHomeRoom(e);
  if (!r) return;
  if (e.room.name !== r) {
    moveRepairer(e, new RoomPosition(25, 25, r), {
      reusePath: 20,
      range: 20
    });
    return;
  }
  var t = e.room.storage;
  if (t) moveRepairer(e, t, {
    reusePath: 20,
    range: 3
  }); else moveRepairer(e, new RoomPosition(25, 25, r), {
    reusePath: 20,
    range: 5
  });
}

function sourceEnergy(e) {
  if (!e || !e.store) return 0;
  if (typeof e.store.getUsedCapacity === "function") {
    return e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  }
  return e.store[RESOURCE_ENERGY] || 0;
}

function isStickyEnergySource(e) {
  return !!(e && (e.structureType === STRUCTURE_LINK || e.structureType === STRUCTURE_STORAGE));
}

function refillFromSource(e, r, t) {
  if (!r) return false;
  if (t) e.memory.energySourceId = r.id;
  if (e.pos.isNearTo(r)) {
    var o = e.withdraw(r, RESOURCE_ENERGY);
    if (o === OK && t) {
      e.memory.working = true;
      delete e.memory.releaseRepairTarget;
    } else if (o === ERR_NOT_ENOUGH_RESOURCES && t) {
      delete e.memory.energySourceId;
    }
  } else {
    moveRepairer(e, r, MOVE_OPTS_CLOSE);
  }
  return true;
}

function refill(e, r) {
  r = r || getHomeRoom(e);
  if (!r) return false;
  if (e.room.name !== r) {
    moveRepairer(e, new RoomPosition(25, 25, r), {
      reusePath: 20,
      range: 20
    });
    return true;
  }
  var t = e.room;
  var o = e.memory.targetId ? Game.getObjectById(e.memory.targetId) : null;
  var a = e.memory.energySourceId ? Game.getObjectById(e.memory.energySourceId) : null;
  var n = sourceEnergy(a);
  if (!o || !isStickyEnergySource(a)) {
    a = null;
    n = 0;
    delete e.memory.energySourceId;
  } else if (n >= REPAIR_SOURCE_STICKY_MIN_ENERGY) {
    return refillFromSource(e, a, true);
  } else {
    delete e.memory.energySourceId;
    if (!(n > 0)) a = null;
  }
  var m = getRoomState.get(r);
  var i = m && m.structuresByType && m.structuresByType[STRUCTURE_LINK] || [];
  var u = t.storage;
  var R = sourceEnergy(u);
  var l = o && o.pos && R > 0 ? o.pos.getRangeTo(u) : Infinity;
  var E = null;
  var s = null;
  if (o && o.pos && t.controller) {
    for (var g = 0; g < i.length; g++) {
      var f = i[g];
      if (!f || f.my === false || !f.store) continue;
      var y = sourceEnergy(f);
      if (!(y > 0)) continue;
      if (f.pos.getRangeTo(t.controller) > 2 || o.pos.getRangeTo(f) >= l) continue;
      if (y >= REPAIR_SOURCE_STICKY_MIN_ENERGY) E = f; else if (!s) s = f;
      if (E) break;
    }
  }
  var T = R >= REPAIR_SOURCE_STICKY_MIN_ENERGY ? u : null;
  var d = E || T || a || s;
  if (!d && R > 0) d = u;
  if (d) {
    return refillFromSource(e, d, !!o && isStickyEnergySource(d));
  }
  if (t.terminal && sourceEnergy(t.terminal) > 0) {
    return refillFromSource(e, t.terminal, false);
  }
  var _ = m && m.structuresByType && m.structuresByType[STRUCTURE_CONTAINER] || [];
  var c = null;
  var v = 0;
  for (var S = 0; S < _.length; S++) {
    var p = _[S];
    if (!p || !p.store) continue;
    var I = sourceEnergy(p);
    if (I > v) {
      c = p;
      v = I;
    }
  }
  if (c) {
    return refillFromSource(e, c, false);
  }
  park(e);
  return false;
}

function taskKind(e) {
  return e ? e.k || e.kind : null;
}

function taskHome(e, r) {
  return e && (e.r || e.homeRoom) || getHomeRoom(r);
}

function nukeDamageAt(e, r) {
  var t = 0;
  for (var o = 0; o < e.length; o++) {
    var a = e[o];
    var n = Math.max(Math.abs(a.pos.x - r.x), Math.abs(a.pos.y - r.y));
    if (n === 0) t += NUKE_GROUND_ZERO_DAMAGE; else if (n <= 2) t += NUKE_SPLASH_DAMAGE;
  }
  return t;
}

function getWallTarget(e, r) {
  var t = Memory.repairManager && Memory.repairManager.rooms && Memory.repairManager.rooms[e];
  if (t && t.targetOverrides && t.targetOverrides[STRUCTURE_WALL]) return t.targetOverrides[STRUCTURE_WALL];
  return WALLREPAIR_THRESHOLD_BY_RCL[r] || 0;
}

function getRampartTarget(e, r, t) {
  var o = getRoomState.get(r);
  return repairManager.getRampartTarget(e, o, t).target;
}

function deriveTargetHits(e, r, t) {
  if (!r || !r.pos) return 0;
  var o = taskHome(e) || r.pos.roomName;
  var a = Game.rooms[o];
  var n = a && a.controller ? a.controller.level : 0;
  if (taskKind(e) === "nuke") {
    var m = a ? a.find(FIND_NUKES) : [];
    var i = nukeDamageAt(m, r.pos);
    if (i > 0) return i + NUKE_SAFETY_MARGIN;
  }
  if (r.structureType === STRUCTURE_ROAD) return Math.floor((r.hitsMax || 0) * ROAD_REPAIR_TARGET);
  if (r.structureType === STRUCTURE_CONTAINER) return CONTAINER_DONE_HITS;
  if (r.structureType === STRUCTURE_WALL) return Math.floor(getWallTarget(o, n) * DEFENSE_REPAIR_TARGET_RATIO);
  if (r.structureType === STRUCTURE_RAMPART) return Math.floor(getRampartTarget(r, o, n) * DEFENSE_REPAIR_TARGET_RATIO);
  return r.hitsMax || 0;
}

function targetDone(e, r) {
  if (!e || typeof e.hits !== "number") return true;
  return e.hits >= r;
}

function isWallOrRampartType(e) {
  return e === STRUCTURE_WALL || e === STRUCTURE_RAMPART;
}

function isTowerMaintenanceType(e) {
  return e === STRUCTURE_ROAD || e === STRUCTURE_CONTAINER;
}

function repairSelectedTarget(e, r) {
  if (e.pos.inRangeTo(r, 3)) {
    var t = e.repair(r);
    if (t === ERR_NOT_ENOUGH_ENERGY) e.memory.working = false; else if (t === ERR_INVALID_TARGET || t === ERR_NO_BODYPART) {
      e.memory.targetId = null;
      delete e.memory.route;
    }
  } else {
    moveRepairer(e, r, MOVE_OPTS_REPAIR);
  }
}

function retireRepairer(e, r) {
  delete e.memory.task;
  delete e.memory.targetId;
  delete e.memory.route;
  delete e.memory.releaseRepairTarget;
  delete e.memory.repairMaintenance;
  delete e.memory.energySourceId;
  e.memory.working = false;
  if (!r) {
    e.suicide();
    return true;
  }
  if (e.room.name !== r) {
    moveRepairer(e, new RoomPosition(25, 25, r), {
      reusePath: 20,
      range: 20
    });
    return true;
  }
  var t = e.room.storage;
  if (!t) {
    e.suicide();
    return true;
  }
  var o = e.store[RESOURCE_ENERGY] || 0;
  if (o > 0) {
    if (e.pos.isNearTo(t)) {
      var a = e.transfer(t, RESOURCE_ENERGY);
      if (a === OK || a === ERR_NOT_ENOUGH_RESOURCES || a === ERR_FULL) e.suicide();
    } else moveRepairer(e, t, MOVE_OPTS_CLOSE);
    return true;
  }
  e.suicide();
  return true;
}

function handleNoTarget(e, r) {
  delete e.memory.energySourceId;
  delete e.memory.repairMaintenance;
  var t = Memory.repairPlan && Memory.repairPlan[r];
  var o = t ? t.rt || t.tier || "PEACE" : "PEACE";
  var a = o === "PEACE";
  var n = t && (t.maxHeal || t.tp && t.tp.m);
  var m = t && t.n && t.n.a;
  if (a && !n && !m) {
    e.memory.idleTicks = (e.memory.idleTicks || 0) + 1;
    if (e.memory.idleTicks >= 20) {
      retireRepairer(e, r);
      return;
    }
  }
  e.memory.working = false;
  park(e, r);
}

function run(e) {
  if (!e.memory._repairMemoryCleaned) {
    delete e.memory.task;
    delete e.memory.repairQueue;
    delete e.memory.repairThresholds;
    delete e.memory.energySourceId;
    delete e.memory.clusterIds;
    delete e.memory.repairId;
    delete e.memory._lastReeval;
    e.memory._repairMemoryCleaned = 1;
  }
  var r = getHomeRoom(e);
  if (r && !e.memory.homeRoom) e.memory.homeRoom = r;
  if (r && !e.memory.assignedRoom) e.memory.assignedRoom = r;
  if (!r) {
    park(e);
    return;
  }
  if (e.ticksToLive !== undefined && e.ticksToLive < 50) {
    retireRepairer(e, r);
    return;
  }
  if (e.room.name !== r) {
    moveRepairer(e, new RoomPosition(25, 25, r), {
      reusePath: 20,
      range: 20
    });
    return;
  }
  var t = e.memory.targetId ? Game.getObjectById(e.memory.targetId) : null;
  if (!t) {
    delete e.memory.targetId;
    delete e.memory.route;
    repairManager.ensureCreepAssignment(e);
    t = e.memory.targetId ? Game.getObjectById(e.memory.targetId) : null;
  }
  if (!t) {
    handleNoTarget(e, r);
    return;
  }
  if (!e.memory.working && e.store[RESOURCE_ENERGY] > 0) e.memory.working = true;
  if (!e.memory.working && e.store.getFreeCapacity(RESOURCE_ENERGY) === 0) e.memory.working = true;
  if (e.memory.working && e.store[RESOURCE_ENERGY] === 0) {
    e.memory.working = false;
    e.memory.releaseRepairTarget = e.memory.targetId || null;
    delete e.memory.energySourceId;
  }
  if (!e.memory.working) {
    refill(e, r);
    return;
  }
  t = e.memory.targetId ? Game.getObjectById(e.memory.targetId) : null;
  if (!t) {
    handleNoTarget(e, r);
    return;
  }
  if (e.memory.route && e.memory.route.length) {
    while (e.memory.route.length && e.memory.route[0] !== t.id) e.memory.route.shift();
    var o = targetDone(t, deriveTargetHits({
      r: r
    }, t, e));
    if (o) {
      e.memory.route.shift();
      e.memory.targetId = e.memory.route[0] || null;
      if (!e.memory.targetId) {
        handleNoTarget(e, r);
        return;
      }
      t = Game.getObjectById(e.memory.targetId);
      if (!t) {
        handleNoTarget(e, r);
        return;
      }
    }
  } else if ((e.memory.repairMaintenance || !isWallOrRampartType(t.structureType)) && targetDone(t, deriveTargetHits({
    r: r
  }, t, e))) {
    e.memory.releaseRepairTarget = t.id;
    delete e.memory.targetId;
    handleNoTarget(e, r);
    return;
  }
  if (isTowerMaintenanceType(t.structureType)) {
    e.memory.releaseRepairTarget = t.id;
    delete e.memory.targetId;
    delete e.memory.route;
    handleNoTarget(e, r);
    return;
  }
  delete e.memory.idleTicks;
  repairSelectedTarget(e, t);
}

module.exports = {
  run: run
};
