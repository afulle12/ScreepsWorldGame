// LLM: Read docs/codex.js before reviewing or changing this file.
// roleUpgrader.js
// Role dispatch: memory.role === 'upgrader' -> roleUpgrader.run(creep).
// Console globals: SHOW_PATHS
// Example: global.SHOW_PATHS = true; - Toggle path visualization for upgraders
// Example: require('roleUpgrader').run(creep);
var getRoomState = require("getRoomState");
var RCL8_THROTTLE_TICKS = 1;
var LINK_WAIT_TICKS = 10;
var CONTAINER_WAIT_TICKS = 10;
if (typeof global.SHOW_PATHS !== "boolean") {
  global.SHOW_PATHS = false;
}
function moveOpts(e) {
  var r = {
    reusePath: 20
  };
  if (global.SHOW_PATHS) {
    r.visualizePathStyle = {
      stroke: e || "#ffaa00"
    };
  }
  r.costCallback = function(e, r) {
    for (var o = 0; o < 50; o++) {
      r.set(o, 0, 255);
      r.set(o, 49, 255);
      r.set(0, o, 255);
      r.set(49, o, 255);
    }
    return r;
  };
  return r;
}

function safeMoveTo(e, r, o) {
  if (e.fatigue > 0) return ERR_TIRED;
  return e.moveTo(r, o);
}

function structureHasEnergy(e) {
  if (!e) return false;
  if (e.store && typeof e.store.getUsedCapacity === "function") {
    var r = e.store.getUsedCapacity(RESOURCE_ENERGY);
    return r && r > 0;
  }
  if (typeof e.energy === "number") {
    return e.energy > 0;
  }
  return false;
}

function onlyUpgraderIsSpawning(e) {
  if (!e || e.length === 0) return false;
  var r = 0;
  var o = false;
  for (var t = 0; t < e.length; t++) {
    var n = e[t];
    if (n.memory && n.memory.role === "upgrader") {
      r++;
      if (n.spawning) o = true;
    }
  }
  return r === 1 && o;
}

function getLayoutVersion(e) {
  return Memory.rooms && Memory.rooms[e] && Memory.rooms[e].layoutVersion || 0;
}

function getControllerStructIds(e, r, o) {
  if (!Memory.upgrader) Memory.upgrader = {};
  if (!Memory.upgrader[e]) Memory.upgrader[e] = {};
  var t = Memory.upgrader[e];
  var n = getLayoutVersion(e);
  if (t.controllerStructs && t.controllerStructs.version === n && t.controllerStructs.ids.length > 0 && Game.time % 100 !== 0) {
    return t.controllerStructs.ids;
  }
  var a = [];
  var i = [ STRUCTURE_LINK, STRUCTURE_CONTAINER ];
  if (o) {
    i.forEach(function(e) {
      var t = o[e] || [];
      for (var n = 0; n < t.length; n++) {
        if (r.getRangeTo(t[n]) <= 3) {
          a.push(t[n].id);
        }
      }
    });
  }
  if (a.length === 0) {
    return a;
  }
  t.controllerStructs = {
    ids: a,
    version: n
  };
  return a;
}

function findEnergyWithdrawTarget(e, r) {
  if (!r || !r.controller) return null;
  var o = getControllerStructIds(r.name, r.controller.pos, r.structuresByType);
  var t = [];
  for (var n = 0; n < o.length; n++) {
    var a = Game.getObjectById(o[n]);
    if (a && structureHasEnergy(a)) {
      t.push(a);
    }
  }
  if (t.length > 0) {
    return e.pos.findClosestByRange(t);
  }
  var i = r.storage;
  if (i) {
    var s = i.store[RESOURCE_ENERGY] || 0;
    try {
      var m = require("storageVfs");
      var u = m.stat("/rooms/" + r.name + "/storage/energy");
      if (u && u.ok) s = u.available;
    } catch (error) {
      if (Game.time % 100 === 0) console.log("[Upgrader] V2 storage read failed: " + ((error && error.message) || error));
    }
    if (s > 1e4) {
      return i;
    }
  }
  return null;
}

function getRankedControllerSourceIds(e) {
  if (!e || !e.controller) return [];
  var r = e.name;
  var o = e.sources;
  if (!o || o.length === 0) return [];
  if (!Memory.upgrader) Memory.upgrader = {};
  if (!Memory.upgrader[r]) Memory.upgrader[r] = {};
  var t = Memory.upgrader[r];
  var n = getLayoutVersion(r);
  if (t.rankedControllerSources && t.rankedControllerSources.ids && t.rankedControllerSources.version === n) {
    return t.rankedControllerSources.ids;
  }
  var a = o.slice().sort(function(r, o) {
    return e.controller.pos.getRangeTo(r.pos) - e.controller.pos.getRangeTo(o.pos);
  });
  var i = a.map(function(e) {
    return e.id;
  });
  t.rankedControllerSources = {
    ids: i,
    version: n
  };
  return i;
}

function countWalkableAdjacentTiles(e, r) {
  var o = 0;
  var t = r.getTerrain();
  for (var n = -1; n <= 1; n++) {
    for (var a = -1; a <= 1; a++) {
      if (n === 0 && a === 0) continue;
      var i = e.x + n;
      var s = e.y + a;
      if (i < 0 || i > 49 || s < 0 || s > 49) continue;
      if (t.get(i, s) !== TERRAIN_MASK_WALL) {
        o++;
      }
    }
  }
  return o;
}

function countCreepsAtSource(e, r, o) {
  if (!o) return 0;
  var t = 0;
  for (var n = 0; n < o.length; n++) {
    var a = o[n];
    if (a.spawning) continue;
    if (a.memory && a.memory.sourceId === e) {
      t++;
    } else if (r && a.pos.isNearTo(r)) {
      t++;
    }
  }
  return t;
}

function pickAvailableSource(e, r, o) {
  if (!e || e.length === 0) return null;
  var t = null;
  for (var n = 0; n < e.length; n++) {
    var a = Game.getObjectById(e[n]);
    if (!a) continue;
    if (!t) t = a;
    if (a.energy <= 0) continue;
    var i = countWalkableAdjacentTiles(a.pos, r);
    var s = countCreepsAtSource(a.id, a, o);
    if (s < i) {
      return a;
    }
  }
  return t;
}

function withdrawEnergy(e, r) {
  if (!r) return;
  if (e.pos.isNearTo(r)) {
    var o = e.withdraw(r, RESOURCE_ENERGY);
    if (r.structureType === STRUCTURE_LINK) {
      if (o === ERR_NOT_ENOUGH_RESOURCES) {
        e.memory.linkDryId = r.id;
        e.memory.linkDryUntil = Game.time + LINK_WAIT_TICKS;
        return;
      }
      if (o === OK) {
        if (!structureHasEnergy(r)) {
          e.memory.linkDryId = r.id;
          e.memory.linkDryUntil = Game.time + LINK_WAIT_TICKS;
        }
        if (e.store.getFreeCapacity() > 0) {
          e.memory.working = true;
          e.say("⚡ upgrade");
        }
      }
    }
    if (r.structureType === STRUCTURE_CONTAINER && e.room.controller && e.room.controller.level <= 5) {
      if (o === ERR_NOT_ENOUGH_RESOURCES) {
        e.memory.linkDryId = r.id;
        e.memory.linkDryUntil = Game.time + CONTAINER_WAIT_TICKS;
        return;
      }
      if (o === OK && !structureHasEnergy(r)) {
        e.memory.linkDryId = r.id;
        e.memory.linkDryUntil = Game.time + CONTAINER_WAIT_TICKS;
      }
    }
  } else {
    safeMoveTo(e, r, moveOpts("#ffaa00"));
  }
}

function harvestFromSource(e, r) {
  if (!r) return;
  if (e.pos.isNearTo(r)) {
    e.harvest(r);
  } else {
    safeMoveTo(e, r, moveOpts("#ffaa00"));
  }
}

function doUpgrade(e, r) {
  if (!r) return;
  if (e.pos.inRangeTo(r, 3)) {
    e.upgradeController(r);
  } else {
    safeMoveTo(e, r, moveOpts("#ffffff"));
  }
}

var role = {
  run: function(e) {
    if (e.spawning) return;
    getRoomState.init();
    var l = getRoomState.get(e.room.name);
    if (!l || !l.controller) return;
    if (onlyUpgraderIsSpawning(l.myCreeps)) return;
    if (l.controller.my && l.controller.level === 8) {
      if (Game.time % RCL8_THROTTLE_TICKS !== 0) return;
    }
    if (e.memory.working && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.memory.working = false;
      e.say("🔄 energy");
    }
    if (!e.memory.working && e.store.getFreeCapacity() === 0) {
      e.memory.working = true;
      e.say("⚡ upgrade");
    }
    if (e.memory.working) {
      doUpgrade(e, l.controller);
      return;
    }
    if (e.memory.linkDryId && typeof e.memory.linkDryUntil === "number") {
      if (Game.time < e.memory.linkDryUntil) {
        var f = Game.getObjectById(e.memory.linkDryId);
        if (f) {
          if (structureHasEnergy(f)) {
            withdrawEnergy(e, f);
            delete e.memory.linkDryId;
            delete e.memory.linkDryUntil;
          } else {
            if (!e.pos.isNearTo(f)) {
              safeMoveTo(e, f, moveOpts("#ffaa00"));
            }
          }
          return;
        }
      } else {
        delete e.memory.linkDryId;
        delete e.memory.linkDryUntil;
      }
    }
    var y = findEnergyWithdrawTarget(e, l);
    if (y) {
      withdrawEnergy(e, y);
      if (e.store.getFreeCapacity() === 0) {
        doUpgrade(e, l.controller);
      }
      return;
    }
    var g = getRankedControllerSourceIds(l);
    var d = pickAvailableSource(g, e.room, l.myCreeps);
    if (!d) return;
    if (!Game.getObjectById(d.id)) {
      if (Memory.upgrader && Memory.upgrader[e.room.name]) {
        Memory.upgrader[e.room.name].rankedControllerSources = null;
      }
      return;
    }
    harvestFromSource(e, d);
  }
};
module.exports = role;
