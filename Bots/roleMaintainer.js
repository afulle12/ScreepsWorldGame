// LLM: Read docs/codex.js before reviewing or changing this file.
// roleMaintainer.js
// Role dispatch: memory.role === 'maintainer' -> roleMaintainer.run(creep).
// Example: require('roleMaintainer').run(creep);
// Example: require('roleMaintainer').run(creep);
var getRoomState = require("getRoomState");
function _flattenStructures(e) {
  var r = [];
  for (var t in e) {
    if (!e.hasOwnProperty(t)) continue;
    var o = e[t];
    for (var a = 0; a < o.length; a++) r.push(o[a]);
  }
  return r;
}

function getRoomCostMatrix(e) {
  var r = Game.rooms[e];
  var t = new PathFinder.CostMatrix;
  for (var o = 0; o < 50; o++) {
    t.set(o, 0, 255);
    t.set(o, 49, 255);
    t.set(0, o, 255);
    t.set(49, o, 255);
  }
  if (!r) return t;
  var a = getRoomState.get(e);
  var n = a && a.structuresByType ? _flattenStructures(a.structuresByType) : r.find(FIND_STRUCTURES);
  for (var i = 0; i < n.length; i++) {
    var s = n[i];
    if (s.structureType === STRUCTURE_ROAD) {
      t.set(s.pos.x, s.pos.y, 1);
    } else if (s.structureType !== STRUCTURE_CONTAINER && (s.structureType !== STRUCTURE_RAMPART || !s.my)) {
      t.set(s.pos.x, s.pos.y, 255);
    }
  }
  if (a) {
    var R = a.myCreeps || [];
    for (var f = 0; f < R.length; f++) {
      t.set(R[f].pos.x, R[f].pos.y, 255);
    }
    var u = a.hostiles || [];
    for (var E = 0; E < u.length; E++) {
      t.set(u[E].pos.x, u[E].pos.y, 255);
    }
  } else {
    r.find(FIND_CREEPS).forEach(function(e) {
      t.set(e.pos.x, e.pos.y, 255);
    });
  }
  return t;
}

function getMoveOpts(e) {
  var r = {
    costCallback: getRoomCostMatrix
  };
  for (var t in e) {
    r[t] = e[t];
  }
  return r;
}

module.exports = {
  run: function(e) {
    if (e.spawning) return;
    if (e.room.controller && e.room.controller.ticksToDowngrade > 199e3) {
      e.say("Done");
      console.log(e.name + " finished maintenance in " + e.room.name + ". Suiciding.");
      e.suicide();
      return;
    }
    if (!e.memory.phase) {
      if (isSupplierSpawned(e.room)) {
        e.memory.phase = "maintain";
      } else {
        e.memory.phase = "fillLink";
      }
    }
    if (e.memory.phase === "fillLink") {
      runFillLink(e);
    } else {
      runMaintain(e);
    }
  }
};
function runFillLink(e) {
  var r = e.room;
  if (!r.storage) {
    console.log(e.name + ": No storage found in " + r.name + ", skipping link fill.");
    e.memory.phase = "maintain";
    return;
  }
  var t = getStorageLink(e);
  if (!t) {
    e.memory.phase = "maintain";
    return;
  }
  if (t.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    e.memory.phase = "maintain";
    return;
  }
  if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    if (e.withdraw(r.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      e.moveTo(r.storage, getMoveOpts({
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      }));
    }
  } else {
    if (e.transfer(t, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      e.moveTo(t, getMoveOpts({
        visualizePathStyle: {
          stroke: "#ffffff"
        }
      }));
    }
  }
}

function runMaintain(e) {
  var r = e.room.controller;
  if (!r) return;
  if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    getMaintenanceEnergy(e);
  } else {
    if (e.upgradeController(r) === ERR_NOT_IN_RANGE) {
      e.moveTo(r, getMoveOpts({
        range: 3,
        visualizePathStyle: {
          stroke: "#00ff00"
        }
      }));
    }
  }
}

function isSupplierSpawned(e) {
  if (!e) return false;
  var r = getRoomState.get(e.name);
  if (r && r.myCreeps) {
    for (var t = 0; t < r.myCreeps.length; t++) {
      var o = r.myCreeps[t];
      if (o.memory && o.memory.role === "supplier") return true;
    }
    return false;
  }
  var a = e.find(FIND_MY_CREEPS, {
    filter: function(e) {
      return e.memory && e.memory.role === "supplier";
    }
  });
  return a.length > 0;
}

function getStorageLink(e) {
  var r = getRoomState.get(e.room.name);
  var t = [];
  if (r && r.structuresByType && r.structuresByType[STRUCTURE_LINK]) {
    var o = r.structuresByType[STRUCTURE_LINK];
    for (var a = 0; a < o.length; a++) {
      if (o[a].my) t.push(o[a]);
    }
  } else {
    t = e.room.find(FIND_MY_STRUCTURES, {
      filter: function(e) {
        return e.structureType === STRUCTURE_LINK;
      }
    });
  }
  var n = e.room.storage.pos;
  for (var i = 0; i < t.length; i++) {
    if (t[i].pos.getRangeTo(n) <= 2) {
      return t[i];
    }
  }
  return null;
}

function getMaintenanceEnergy(e) {
  var r = getRoomState.get(e.room.name);
  var t = null;
  if (r && r.structuresByType && r.structuresByType[STRUCTURE_LINK]) {
    var o = r.structuresByType[STRUCTURE_LINK];
    for (var a = 0; a < o.length; a++) {
      if (o[a].pos.getRangeTo(e.room.controller) <= 4 && o[a].store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        t = o[a];
        break;
      }
    }
  }
  if (t) {
    if (e.withdraw(t, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      e.moveTo(t, getMoveOpts({
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      }));
    }
    return;
  }
  var n = e.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_CONTAINER && e.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    }
  });
  if (n) {
    if (e.withdraw(n, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      e.moveTo(n, getMoveOpts({
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      }));
    }
    return;
  }
  if (e.room.storage && e.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    if (e.withdraw(e.room.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      e.moveTo(e.room.storage, getMoveOpts({
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      }));
    }
  }
}
