// LLM: Read docs/codex.js before reviewing or changing this file.
// roleMineralCollector.js
// Role dispatch: memory.role === 'mineralCollector' -> roleMineralCollector.run(creep).
// Console globals: orderMineralCollect
// Example: orderMineralCollect('E1N1', 'E2N2') - Dispatch mineral collector to remote room
// Example: require('roleMineralCollector').run(creep);
// roleMineralCollector.js
var getRoomState = require("getRoomState");
var spawnManager = require("spawnManager");
var economics = require("economics");
function resourceAllowed(e, r) {
  if (!e) return false;
  if (r.resourceType && e !== r.resourceType) return false;
  if (e === RESOURCE_ENERGY && !r.includeEnergy) return false;
  return true;
}

function collectTargets(e, r) {
  var t = [];
  r = r || {};
  if (r.targetId) {
    var o = Game.getObjectById(r.targetId);
    if (o && hasCollectableResources(o, r)) t.push(o);
    return t;
  }
  if (!e || !e.structuresByType) return t;
  var n = [ STRUCTURE_CONTAINER, STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_FACTORY ];
  for (var l = 0; l < n.length; l++) {
    var s = e.structuresByType[n[l]] || [];
    for (var a = 0; a < s.length; a++) {
      if (hasCollectableResources(s[a], r)) t.push(s[a]);
    }
  }
  return t;
}

function hasCollectableResources(e, r) {
  r = r || {};
  if (e.store) {
    var t = Object.keys(e.store);
    for (var o = 0; o < t.length; o++) {
      var n = t[o];
      if (resourceAllowed(n, r) && e.store[n] > 0) return true;
    }
    return false;
  }
  if (e.structureType === STRUCTURE_LAB) {
    return !!e.mineralType && resourceAllowed(e.mineralType, r) && e.mineralAmount > 0;
  }
  return false;
}

module.exports = {
  run: function(e) {
    const r = Game.rooms[e.memory.homeRoom];
    if (!r) {
      e.suicide();
      return;
    }
    const t = getRoomState.get(r.name);
    const o = {
      targetId: e.memory.targetId || null,
      resourceType: e.memory.resourceType || null,
      includeEnergy: e.memory.includeEnergy === true
    };
    function firstCollectableResource(e) {
      if (e.store) {
        const r = Object.keys(e.store);
        for (let t = 0; t < r.length; t++) {
          const n = r[t];
          if (resourceAllowed(n, o) && e.store[n] > 0) return n;
        }
        return null;
      }
      if (e.structureType === STRUCTURE_LAB) {
        if (e.mineralType && resourceAllowed(e.mineralType, o) && e.mineralAmount > 0) return e.mineralType;
        return null;
      }
      return null;
    }
    if (e.memory.collectedSoFar === undefined) e.memory.collectedSoFar = 0;
    if (e.memory.totalToCollect === undefined) {
      let r = 0;
      const n = collectTargets(t, o);
      for (let e = 0; e < n.length; e++) {
        const t = n[e];
        if (t.store) {
          const e = Object.keys(t.store);
          for (let n = 0; n < e.length; n++) {
            const l = e[n];
            if (resourceAllowed(l, o)) r += t.store[l];
          }
        } else if (t.structureType === STRUCTURE_LAB) {
          if (t.mineralType && resourceAllowed(t.mineralType, o) && t.mineralAmount > 0) r += t.mineralAmount;
        }
      }
      e.memory.totalToCollect = r;
      if (r === 0) {
        e.suicide();
        return;
      }
    }
    if (e.memory.collectedSoFar >= e.memory.totalToCollect) {
      e.suicide();
      return;
    }
    if (_.sum(e.store) === 0) {
      const r = collectTargets(t, o);
      const n = r.length ? e.pos.findClosestByRange(r) : null;
      if (!n) {
        e.suicide();
        return;
      }
      const l = firstCollectableResource(n);
      if (l) {
        const r = Math.max(0, e.memory.totalToCollect - e.memory.collectedSoFar);
        const t = Math.min(r, e.store.getFreeCapacity(), n.store ? n.store[l] || 0 : r);
        const o = e.withdraw(n, l, t);
        if (o === ERR_NOT_IN_RANGE) {
          e.moveTo(n, {
            reusePath: 10
          });
        } else if (o === ERR_INVALID_TARGET || o === ERR_NOT_ENOUGH_RESOURCES) {}
      }
      return;
    }
    const n = r.storage;
    if (!n) {
      e.suicide();
      return;
    }
    const l = Object.keys(e.store);
    for (let t = 0; t < l.length; t++) {
      const s = l[t];
      if (resourceAllowed(s, o) && e.store[s] > 0) {
        const t = e.store[s];
        const o = e.transfer(n, s);
        if (o === ERR_NOT_IN_RANGE) {
          e.moveTo(n, {
            reusePath: 10
          });
        } else if (o === OK) {
          e.memory.collectedSoFar += t;
          economics.record("mineralCollection", r.name, s, {
            out: economics.value(s, t),
            qty: t
          });
        }
        break;
      }
    }
  }
};
global.orderMineralCollect = function(e, r) {
  if (typeof r === "string") r = {
    targetId: r
  };
  r = r || {};
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[MineralCollector] Invalid room: " + e;
  }
  var t = getRoomState.get(e);
  var o = null;
  if (t && t.structuresByType && t.structuresByType[STRUCTURE_SPAWN]) {
    for (var n = 0; n < t.structuresByType[STRUCTURE_SPAWN].length; n++) {
      var l = t.structuresByType[STRUCTURE_SPAWN][n];
      if (l.my && !l.spawning) {
        o = l;
        break;
      }
    }
  } else {
    o = Game.rooms[e].find(FIND_MY_SPAWNS, {
      filter: function(e) {
        return !e.spawning;
      }
    })[0];
  }
  if (!o) return "[MineralCollector] No free spawn in " + e;
  var s = spawnManager.getCreepBody("supplier", o.room.energyAvailable);
  if (!s) {
    return "[MineralCollector] No affordable supplier body (energy " + o.room.energyAvailable + ")";
  }
  var a = spawnManager.bodyCost(s);
  if (a > o.room.energyAvailable) {
    return "[MineralCollector] Not enough energy (need " + a + ")";
  }
  var c = "MC_" + e + "_" + Game.time;
  var u = {
    role: "mineralCollector",
    homeRoom: e
  };
  if (r.targetId) u.targetId = r.targetId;
  if (r.resourceType) u.resourceType = r.resourceType;
  if (r.amount) u.totalToCollect = r.amount;
  if (r.includeEnergy) u.includeEnergy = true;
  var i = spawnManager.spawnCustomCreep(o, s, c, u);
  if (i !== OK) return "[MineralCollector] Spawn failed: " + i;
  return "[MineralCollector] Spawning " + c;
};
