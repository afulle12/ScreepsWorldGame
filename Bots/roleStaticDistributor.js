// LLM: Read docs/codex.js before reviewing or changing this file.
// roleStaticDistributor.js
// Role dispatch: memory.role === 'staticDistributor' -> roleStaticDistributor.run(creep).
// Example: require('roleStaticDistributor').run(creep);
// Example: require('roleStaticDistributor').run(creep);
var getRoomState = require("getRoomState");
var neighborCache = {};
var neighborCacheLastPrune = 0;
var TOWER_HIGH_THRESHOLD = 800;
module.exports = {
  run: function(e) {
    if (e.spawning) return;
    if (Game.time % 3 !== 0) return;
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
        var i = t.renewCreep(e);
        if (i === OK) {
          e.say("♻️");
          return;
        }
      }
    }
    var n = this.getNeighbors(e, a);
    var s = e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (s > 0) {
      var o = false;
      var E = null;
      var R = Infinity;
      for (var f = 0; f < n.towers.length; f++) {
        var v = n.towers[f];
        var g = v.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (g < TOWER_HIGH_THRESHOLD && g < R) {
          R = g;
          E = v;
        }
      }
      if (E) {
        e.transfer(E, RESOURCE_ENERGY);
        o = true;
      }
      if (!o && n.spawn) {
        var h = n.spawn.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (h > 0) {
          e.transfer(n.spawn, RESOURCE_ENERGY);
          o = true;
        }
      }
      if (!o) {
        for (var d = 0; d < n.extensions.length; d++) {
          var l = n.extensions[d];
          if (l.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            e.transfer(l, RESOURCE_ENERGY);
            o = true;
            break;
          }
        }
      }
      if (!o) {
        for (var u = 0; u < n.towers.length; u++) {
          var m = n.towers[u];
          if (m.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            e.transfer(m, RESOURCE_ENERGY);
            o = true;
            break;
          }
        }
      }
      if (n.link) {
        var C = n.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var p = e.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        if (C > 0 && p > 0) {
          e.withdraw(n.link, RESOURCE_ENERGY);
        }
      }
    } else {
      if (n.link) {
        var C = n.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (C > 0) {
          e.withdraw(n.link, RESOURCE_ENERGY);
        } else {
          if (Game.time % 10 === 0) e.say("⏳");
        }
      } else {
        if (Game.time % 10 === 0) e.say("no link");
      }
    }
  },
  getAdjacentSpawn: function(e, r) {
    var a = r.structuresByType || {};
    var t = a[STRUCTURE_SPAWN] || [];
    for (var i = 0; i < t.length; i++) {
      if (t[i].my && e.pos.isNearTo(t[i])) return t[i];
    }
    return null;
  },
  getNeighbors: function(e, r) {
    var a = neighborCache[e.name];
    if (!a || Game.time - a.idsAt >= 100) {
      var t = r.structuresByType || {};
      var i = e.pos.x;
      var n = e.pos.y;
      function isAdj(e) {
        return Math.abs(i - e.pos.x) <= 1 && Math.abs(n - e.pos.y) <= 1;
      }
      var s = null;
      var o = null;
      var E = [];
      var R = [];
      var f = t[STRUCTURE_SPAWN] || [];
      for (var v = 0; v < f.length; v++) {
        if (f[v].my && isAdj(f[v])) {
          s = f[v].id;
          break;
        }
      }
      var g = t[STRUCTURE_LINK] || [];
      for (var v = 0; v < g.length; v++) {
        if (g[v].my && isAdj(g[v])) {
          o = g[v].id;
          break;
        }
      }
      var h = t[STRUCTURE_TOWER] || [];
      for (var v = 0; v < h.length; v++) {
        if (h[v].my && isAdj(h[v])) E.push(h[v].id);
      }
      var d = t[STRUCTURE_EXTENSION] || [];
      for (var v = 0; v < d.length; v++) {
        if (d[v].my && isAdj(d[v])) R.push(d[v].id);
      }
      a = {
        spawnId: s,
        linkId: o,
        towerIds: E,
        extIds: R,
        idsAt: Game.time
      };
      neighborCache[e.name] = a;
    }
    if (a.tick === Game.time) return a.hood;
    var l = {
      spawn: a.spawnId ? Game.getObjectById(a.spawnId) : null,
      link: a.linkId ? Game.getObjectById(a.linkId) : null,
      towers: [],
      extensions: []
    };
    for (var v = 0; v < a.towerIds.length; v++) {
      var u = Game.getObjectById(a.towerIds[v]);
      if (u) l.towers.push(u);
    }
    for (var v = 0; v < a.extIds.length; v++) {
      var m = Game.getObjectById(a.extIds[v]);
      if (m) l.extensions.push(m);
    }
    a.hood = l;
    a.tick = Game.time;
    return l;
  }
};
