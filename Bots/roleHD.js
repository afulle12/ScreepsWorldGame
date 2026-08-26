// LLM: Read docs/codex.js before reviewing or changing this file.
// roleHD.js
// Role dispatch: memory.role === 'hd' -> roleHD.run(creep).
// Example: require('roleHD').run(creep);
// Example: require('roleHD').run(creep);
//   - Source (harvest)
//   - Spawn (fill)
//   - Link (dump energy into link network)
//   - Extensions (fill 2 local extensions)
//   1. Renewal check (TTL < 200)
//   2. harvest(source) — if source has energy and carry has room
//   3. ONE transfer (priority order, only when carry full or source empty):
//      a. Spawn (if not full)
//      b. Extension with most free capacity (if any not full)
//      c. Link (dump the rest)
//   4. Idle if source depleted and carry empty
//   - 5 WORK saturates a single source (10 energy/tick)
//   - 4 CARRY = 200 buffer (2 harvest ticks)
var getRoomState = require("getRoomState");
var neighborCache = {};
var neighborCacheLastPrune = 0;
module.exports = {
  run: function(e) {
    if (e.spawning) return;
    if (Game.time - neighborCacheLastPrune > 200) {
      neighborCacheLastPrune = Game.time;
      for (var r in neighborCache) {
        if (!Game.creeps[r]) delete neighborCache[r];
      }
    }
    var a = getRoomState.get(e.room.name);
    if (!a) return;
    if (e.ticksToLive < 200) {
      var t = this.getAdjacentSpawn(e, a);
      if (t && !t.spawning) {
        var n = t.renewCreep(e);
        if (n === OK) {
          e.say("♻️");
          return;
        }
      }
    }
    var i = Game.getObjectById(e.memory.sourceId);
    if (!i) {
      var s = a.sources || [];
      for (var o = 0; o < s.length; o++) {
        if (e.pos.isNearTo(s[o])) {
          e.memory.sourceId = s[o].id;
          i = s[o];
          break;
        }
      }
      if (!i) {
        e.say("no src");
        return;
      }
    }
    var f = true;
    if (a.storage && a.storage.store) {
      var E = a.storage.store[RESOURCE_ENERGY] || 0;
      if (E >= 35e4) {
        f = false;
      }
    }
    if (f && i.energy > 0 && e.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      e.harvest(i);
    }
    var g = e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (g <= 0) {
      if (i.energy === 0 && typeof i.ticksToRegeneration === "number") {
        if (Game.time % 10 === 0) e.say("⏳" + i.ticksToRegeneration);
      }
      return;
    }
    var R = e.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
    var v = !i || i.energy === 0;
    if (!R && !v) return;
    var u = this.getNeighbors(e, a);
    if (u.spawn && u.spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      e.transfer(u.spawn, RESOURCE_ENERGY);
      return;
    }
    var h = null;
    var m = 0;
    for (var c = 0; c < u.extensions.length; c++) {
      var p = u.extensions[c];
      var y = p.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      if (y > m) {
        m = y;
        h = p;
      }
    }
    if (h) {
      e.transfer(h, RESOURCE_ENERGY);
      return;
    }
    if (u.link && u.link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      e.transfer(u.link, RESOURCE_ENERGY);
      return;
    }
    if (Game.time % 10 === 0) e.say("full");
  },
  getAdjacentSpawn: function(e, r) {
    var a = r.structuresByType || {};
    var t = a[STRUCTURE_SPAWN] || [];
    for (var n = 0; n < t.length; n++) {
      if (t[n].my && e.pos.isNearTo(t[n])) return t[n];
    }
    return null;
  },
  getNeighbors: function(e, r) {
    var a = neighborCache[e.name];
    if (!a || Game.time - a.idsAt >= 100) {
      var t = r.structuresByType || {};
      var n = e.pos.x;
      var i = e.pos.y;
      var s = null;
      var o = null;
      var f = [];
      var E = t[STRUCTURE_SPAWN] || [];
      for (var g = 0; g < E.length; g++) {
        if (E[g].my && Math.abs(n - E[g].pos.x) <= 1 && Math.abs(i - E[g].pos.y) <= 1) {
          s = E[g].id;
          break;
        }
      }
      var R = t[STRUCTURE_LINK] || [];
      for (var g = 0; g < R.length; g++) {
        if (R[g].my && Math.abs(n - R[g].pos.x) <= 1 && Math.abs(i - R[g].pos.y) <= 1) {
          o = R[g].id;
          break;
        }
      }
      var v = t[STRUCTURE_EXTENSION] || [];
      for (var g = 0; g < v.length; g++) {
        if (v[g].my && Math.abs(n - v[g].pos.x) <= 1 && Math.abs(i - v[g].pos.y) <= 1) {
          f.push(v[g].id);
        }
      }
      a = {
        spawnId: s,
        linkId: o,
        extIds: f,
        idsAt: Game.time
      };
      neighborCache[e.name] = a;
    }
    if (a.tick === Game.time) return a.hood;
    var u = {
      spawn: a.spawnId ? Game.getObjectById(a.spawnId) : null,
      link: a.linkId ? Game.getObjectById(a.linkId) : null,
      extensions: []
    };
    for (var g = 0; g < a.extIds.length; g++) {
      var h = Game.getObjectById(a.extIds[g]);
      if (h) u.extensions.push(h);
    }
    a.hood = u;
    a.tick = Game.time;
    return u;
  }
};
