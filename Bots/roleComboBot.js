// LLM: Read docs/codex.js before reviewing or changing this file.
// roleComboBot.js
// Role dispatch: memory.role === 'comboBot' -> roleComboBot.run(creep).
// Example: require('roleComboBot').run(creep);
// Example: require('roleComboBot').run(creep);
var getRoomState = require("getRoomState");
var util = require("util");
var factoryManager = require("factoryManager");
var LINK_FEED_THRESHOLD = 600;
var TERMINAL_LOW = 19e3;
var TERMINAL_HIGH = 21e3;
var neighborCache = {};
var neighborCacheLastPrune = 0;
var _recipeCache = {};
var _factoryOrderCache = {
  tick: -1
};
var _termNeedCache = {
  tick: -1
};
var _toStorageCache = {
  tick: -1
};
function getRecipe(e) {
  if (!e) return null;
  if (_recipeCache[e] !== undefined) return _recipeCache[e];
  var r = null;
  if (typeof COMMODITIES !== "undefined" && COMMODITIES[e]) {
    var t = COMMODITIES[e];
    var a = {};
    var i = t.components || {};
    for (var o in i) {
      if (i.hasOwnProperty(o)) a[o] = i[o];
    }
    r = {
      inputs: a,
      out: t.amount || 1
    };
  }
  _recipeCache[e] = r;
  return r;
}

function findAdjacentSpawn(e) {
  var r = e.pos.findInRange(FIND_MY_SPAWNS, 1);
  return r.length > 0 ? r[0] : null;
}

function findAdjacentMineral(e) {
  var r = e.pos.findInRange(FIND_MINERALS, 1);
  return r.length > 0 ? r[0] : null;
}

module.exports = {
  run: function(e) {
    if (e.spawning) return;
    if (Game.time - neighborCacheLastPrune > 200) {
      neighborCacheLastPrune = Game.time;
      for (var r in neighborCache) {
        if (!Game.creeps[r]) delete neighborCache[r];
      }
    }
    var t = getRoomState.get(e.room.name);
    if (!t) return;
    var a = this.getNeighbors(e, t);
    if (e.memory._hasWork === undefined) {
      var i = false;
      for (var o = 0; o < e.body.length; o++) {
        if (e.body[o].type === WORK) {
          i = true;
          break;
        }
      }
      e.memory._hasWork = i;
    }
    var n = e.memory._hasWork;
    var s = a.mineral || findAdjacentMineral(e);
    var f = false;
    var c = false;
    if (s) {
      if (s.mineralAmount === 0) {
        f = true;
        if (s.ticksToRegeneration === undefined || s.ticksToRegeneration >= 300) {
          c = true;
        }
      }
    }
    if (n && f && c) {
      for (var m in e.store) {
        if (m === RESOURCE_ENERGY) continue;
        if ((e.store[m] || 0) <= 0) continue;
        if (a.factory && a.factory.store && a.factory.store.getFreeCapacity() > 0) {
          e.transfer(a.factory, m);
          return;
        }
        if (a.terminal && a.terminal.store && a.terminal.store.getFreeCapacity() > 0) {
          e.transfer(a.terminal, m);
          return;
        }
        if (a.storage && a.storage.store && a.storage.store.getFreeCapacity() > 0) {
          e.transfer(a.storage, m);
          return;
        }
      }
      if ((e.store[RESOURCE_ENERGY] || 0) > 0) {
        if (a.storage && a.storage.store && a.storage.store.getFreeCapacity() > 0) {
          e.transfer(a.storage, RESOURCE_ENERGY);
          return;
        }
        if (a.link && a.link.store && a.link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          e.transfer(a.link, RESOURCE_ENERGY);
          return;
        }
      }
      console.log("[ComboBot] " + e.name + " minerals exhausted, suiciding for carry-only respawn");
      e.suicide();
      return;
    }
    if (n && e.ticksToLive < 1400) {
      var u = false;
      if (s && s.mineralAmount > 0) {
        var l = 0;
        for (var E = 0; E < e.body.length; E++) {
          if (e.body[E].type === WORK && e.body[E].hits > 0) l++;
        }
        if (l > 0) {
          var g = s.mineralAmount * 5 / l;
          if (g <= 200) u = true;
        }
      }
      if (!u) {
        var v = a.spawn || findAdjacentSpawn(e);
        if (v && !v.spawning) {
          var R = v.renewCreep(e);
          if (R === OK) e.say("♻️");
        }
      }
    }
    var y = e.store.getUsedCapacity() || 0;
    var d = e.store[RESOURCE_ENERGY] || 0;
    var h = e.store.getFreeCapacity() || 0;
    var p = !!(a.terminal && a.terminal.store);
    var C = !!(a.storage && a.storage.store);
    var _ = !!(a.factory && a.factory.store);
    var O = !!(a.link && a.link.store);
    var N = O ? a.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
    var S = p ? a.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
    var G = this.getActiveFactoryOrder(e.room.name);
    var M = G ? G.product : null;
    if (n && s && a.extractor && h > 0) {
      if (s.mineralAmount > 0 && (!a.extractor.cooldown || a.extractor.cooldown === 0)) {
        e.harvest(s);
      }
    }
    var T = false;
    if (!T && a.spawn && d > 0) {
      if (a.spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        e.transfer(a.spawn, RESOURCE_ENERGY);
        T = true;
      }
    }
    if (!T && d > 0) {
      for (var U = 0; U < a.extensions.length; U++) {
        if (a.extensions[U].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          e.transfer(a.extensions[U], RESOURCE_ENERGY);
          T = true;
          break;
        }
      }
    }
    if (!T && p) {
      var k = this.getTerminalTransferNeed(e.room.name);
      if (k && (e.store[k] || 0) > 0 && a.terminal.store.getFreeCapacity() > 0) {
        var w = e.store[k] || 0;
        var F = e.transfer(a.terminal, k);
        if (F === OK) {
          this.recordLocalOpProgress(e.room.name, "toTerminal", k, w);
        }
        T = true;
      }
    }
    if (!T) {
      var I = s ? s.mineralType : null;
      if (I && (e.store[I] || 0) > 0) {
        if (_ && G) {
          var b = getRecipe(M);
          if (b && b.inputs[I]) {
            var Y = a.factory.store[I] || 0;
            var L = Math.max(1, G.cycleBatches || 1);
            var A = b.inputs[I] * L;
            if (Y < A) {
              var x = a.factory.store.getFreeCapacity ? a.factory.store.getFreeCapacity() || 0 : e.store[I];
              var H = Math.min(e.store[I] || 0, A - Y, x);
              if (H > 0) {
                e.transfer(a.factory, I, H);
                T = true;
              }
            }
          }
        }
        if (!T) {
          if (p && a.terminal.store.getFreeCapacity() > 0) {
            e.transfer(a.terminal, I);
            T = true;
          } else if (C && a.storage.store.getFreeCapacity() > 0) {
            e.transfer(a.storage, I);
            T = true;
          }
        }
      }
    }
    if (!T && O && d > 0 && N < LINK_FEED_THRESHOLD) {
      e.transfer(a.link, RESOURCE_ENERGY);
      T = true;
    }
    if (!T && p && d > 0 && S < TERMINAL_LOW) {
      e.transfer(a.terminal, RESOURCE_ENERGY);
      T = true;
    }
    if (!T && _ && G) {
      if (this.tryTransferFactoryInput(e, a.factory, G)) T = true;
    }
    if (!T && _ && M && (e.store[M] || 0) > 0) {
      if (C && a.storage.store.getFreeCapacity() > 0) {
        e.transfer(a.storage, M);
        T = true;
      } else if (p && a.terminal.store.getFreeCapacity() > 0) {
        e.transfer(a.terminal, M);
        T = true;
      }
    }
    if (!T && _ && !G && C) {
      for (var j in e.store) {
        if (j === RESOURCE_ENERGY) continue;
        if ((e.store[j] || 0) <= 0) continue;
        if (a.storage.store.getFreeCapacity() > 0) {
          e.transfer(a.storage, j);
          T = true;
          break;
        }
      }
    }
    if (!T && C) {
      var D = this.getTerminalToStorageNeed(e.room.name);
      if (D && (e.store[D.resource] || 0) > 0) {
        if (a.storage.store.getFreeCapacity() > 0) {
          var K = e.store[D.resource] || 0;
          var B = e.transfer(a.storage, D.resource);
          if (B === OK) {
            this.recordLocalOpProgress(e.room.name, "toStorage", D.resource, K);
          }
          T = true;
        }
      }
    }
    if (!T && y > d && y > 0) {
      for (var W in e.store) {
        if (W === RESOURCE_ENERGY) continue;
        if ((e.store[W] || 0) <= 0) continue;
        if (p && a.terminal.store.getFreeCapacity() > 0) {
          e.transfer(a.terminal, W);
        } else if (C && a.storage.store.getFreeCapacity() > 0) {
          e.transfer(a.storage, W);
        }
        T = true;
        break;
      }
    }
    if (!T && C && d > 0) {
      if (a.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        var P = e.transfer(a.storage, RESOURCE_ENERGY);
        if (P === OK) {
          this.recordLocalOpProgress(e.room.name, "toStorage", RESOURCE_ENERGY, d);
        }
        T = true;
      }
    }
    var q = false;
    if (!q && O && h > 0) {
      var X = a.spawn && a.spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? a.spawn.store.getFreeCapacity(RESOURCE_ENERGY) : 0;
      var z = 0;
      for (var J = 0; J < a.extensions.length; J++) {
        z += a.extensions[J].store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      }
      if (X + z > 0) {
        var Q = a.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var V = Math.min(X + z, h, Q);
        if (V > 0) {
          e.withdraw(a.link, RESOURCE_ENERGY, V);
          q = true;
        }
      }
    }
    if (!q && O && h > 0 && N > LINK_FEED_THRESHOLD) {
      var Z = Math.min(N - LINK_FEED_THRESHOLD, h);
      if (Z > 0) {
        e.withdraw(a.link, RESOURCE_ENERGY, Z);
        q = true;
      }
    }
    if (!q && C && O && N < LINK_FEED_THRESHOLD && h > 0) {
      if ((a.storage.store[RESOURCE_ENERGY] || 0) > 0) {
        e.withdraw(a.storage, RESOURCE_ENERGY);
        q = true;
      }
    }
    if (!q && p && S > TERMINAL_HIGH && h > 0) {
      var $ = S - TERMINAL_HIGH;
      var ee = O && N < LINK_FEED_THRESHOLD ? LINK_FEED_THRESHOLD - N : 0;
      var re = Math.min($, h - ee);
      if (re > 0) {
        e.withdraw(a.terminal, RESOURCE_ENERGY, re);
        q = true;
      }
    }
    if (!q && _ && M && h > 0) {
      var te = a.factory.store[M] || 0;
      if (te > 0) {
        e.withdraw(a.factory, M);
        q = true;
      }
    }
    if (!q && _ && !G && h > 0) {
      for (var ae in a.factory.store) {
        if (ae === RESOURCE_ENERGY) continue;
        if ((a.factory.store[ae] || 0) <= 0) continue;
        e.withdraw(a.factory, ae);
        q = true;
        break;
      }
    }
    if (!q && p && h > 0) {
      var ie = this.getTerminalToStorageNeed(e.room.name);
      if (ie) {
        var oe = a.terminal.store[ie.resource] || 0;
        if (oe > 0) {
          var ne = Math.min(oe, h, ie.remaining);
          if (ne > 0) {
            e.withdraw(a.terminal, ie.resource, ne);
            q = true;
          }
        }
      }
    }
    if (!q && C && h > 0) {
      var se = this.getTerminalTransferNeed(e.room.name);
      if (se && (a.storage.store[se] || 0) > 0) {
        e.withdraw(a.storage, se);
        q = true;
      }
    }
    if (!q && C && p && S < TERMINAL_LOW && h > 0) {
      if ((a.storage.store[RESOURCE_ENERGY] || 0) > 0) {
        e.withdraw(a.storage, RESOURCE_ENERGY);
        q = true;
      }
    }
    if (!q && G && _ && h > 0) {
      if (this.tryWithdrawFactoryInput(e, a, G)) q = true;
    }
    if (!T && !q) {
      if (Game.time % 20 === 0) e.say("💤");
    }
  },
  getActiveFactoryOrder: function(e) {
    if (_factoryOrderCache.tick === Game.time && _factoryOrderCache[e] !== undefined) {
      return _factoryOrderCache[e];
    }
    if (_factoryOrderCache.tick !== Game.time) {
      _factoryOrderCache = {
        tick: Game.time
      };
    }
    var r = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
    var t = null;
    for (var a = 0; a < r.length; a++) {
      var i = r[a];
      if (i && i.room === e && i.status === "active") {
        t = i;
        break;
      }
    }
    _factoryOrderCache[e] = t;
    return t;
  },
  tryTransferFactoryInput: function(e, r, t) {
    var a = getRecipe(t.product);
    if (!a || !a.inputs) return false;
    var i = Math.max(1, t.cycleBatches || 1);
    for (var o in a.inputs) {
      var n = (a.inputs[o] || 0) * i;
      var s = r.store[o] || 0;
      var f = n - s;
      if (f <= 0) continue;
      var c = e.store[o] || 0;
      if (c > 0) {
        var m = r.store.getFreeCapacity ? r.store.getFreeCapacity() || 0 : c;
        var u = Math.min(c, f, m);
        if (u <= 0) return false;
        e.transfer(r, o, u);
        return true;
      }
    }
    return false;
  },
  tryWithdrawFactoryInput: function(e, r, t) {
    var a = getRecipe(t.product);
    if (!a || !a.inputs) return false;
    var i = Math.max(1, t.cycleBatches || 1);
    var o = null;
    var n = 0;
    for (var s in a.inputs) {
      var f = (a.inputs[s] || 0) * i;
      var c = r.factory ? r.factory.store[s] || 0 : 0;
      var m = f - c;
      if (m > n) {
        n = m;
        o = s;
      }
    }
    if (!o) return false;
    var u = r.factory && r.factory.store && r.factory.store.getFreeCapacity ? r.factory.store.getFreeCapacity() || 0 : e.store.getFreeCapacity();
    var l = Math.min(n, u, e.store.getFreeCapacity());
    if (l <= 0) return false;
    if (r.terminal && r.terminal.store && (r.terminal.store[o] || 0) > 0) {
      e.withdraw(r.terminal, o, Math.min(l, r.terminal.store[o] || 0));
      return true;
    }
    if (r.storage && r.storage.store && (r.storage.store[o] || 0) > 0) {
      e.withdraw(r.storage, o, Math.min(l, r.storage.store[o] || 0));
      return true;
    }
    return false;
  },
  getTerminalTransferNeed: function(e) {
    if (_termNeedCache.tick === Game.time && _termNeedCache[e] !== undefined) {
      return _termNeedCache[e];
    }
    if (_termNeedCache.tick !== Game.time) {
      _termNeedCache = {
        tick: Game.time
      };
    }
    var r = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
    var t = null;
    var a = 0;
    for (var i = 0; i < r.length; i++) {
      var o = r[i];
      if (!o || o.status === "completed" || o.status === "failed") continue;
      if (o.type === "transfer" && o.fromRoom === e) {
        var n = Math.max(0, o.amount - (o.amountTransferred || 0));
        if (n <= 0) continue;
        var s = Game.rooms[e];
        var f = s && s.terminal ? s.terminal : null;
        if (!f) continue;
        var c = f.store[o.resourceType] || 0;
        var m = Math.max(0, n - c);
        if (m > a) {
          a = m;
          t = o.resourceType;
        }
        if (o.resourceType !== RESOURCE_ENERGY && n > 0) {
          var u = util.calcTransactionCost(n, o.fromRoom, o.toRoom);
          var l = f.store[RESOURCE_ENERGY] || 0;
          var E = Math.max(0, u - l);
          if (E > a) {
            a = E;
            t = RESOURCE_ENERGY;
          }
        }
      }
      if (o.type === "toTerminal" && o.roomName === e) {
        var g = o.amountMoved || 0;
        var v = Math.max(0, o.amount - g);
        if (v > a) {
          a = v;
          t = o.resourceType;
        }
      }
    }
    _termNeedCache[e] = t;
    return t;
  },
  getTerminalToStorageNeed: function(e) {
    if (_toStorageCache.tick === Game.time && _toStorageCache[e] !== undefined) {
      return _toStorageCache[e];
    }
    if (_toStorageCache.tick !== Game.time) {
      _toStorageCache = {
        tick: Game.time
      };
    }
    var r = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
    var t = null;
    var a = 0;
    var i = 0;
    for (var o = 0; o < r.length; o++) {
      var n = r[o];
      if (!n || n.status === "completed" || n.status === "failed") continue;
      if (n.type === "toStorage" && n.roomName === e) {
        var s = n.amountMoved || 0;
        var f = Math.max(0, n.amount - s);
        if (f <= 0) continue;
        if (n.resourceType === RESOURCE_ENERGY) {
          if (f > i) i = f;
        } else {
          if (f > a) {
            a = f;
            t = {
              resource: n.resourceType,
              remaining: f
            };
          }
        }
      }
    }
    var c = null;
    if (t) {
      c = t;
    } else if (i > 0) {
      var m = Game.rooms[e];
      var u = m && m.terminal ? m.terminal : null;
      var l = u && u.store ? u.store[RESOURCE_ENERGY] || 0 : 0;
      if (l > TERMINAL_HIGH) {
        c = {
          resource: RESOURCE_ENERGY,
          remaining: i
        };
      }
    }
    _toStorageCache[e] = c;
    return c;
  },
  recordLocalOpProgress: function(e, r, t, a) {
    var i = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
    for (var o = 0; o < i.length; o++) {
      var n = i[o];
      if (!n || n.status === "completed" || n.status === "failed") continue;
      if (n.type === r && n.roomName === e && n.resourceType === t) {
        if (typeof n.amountMoved !== "number") n.amountMoved = 0;
        n.amountMoved += a;
        return;
      }
    }
  },
  getNeighbors: function(e, r) {
    var t = neighborCache[e.name];
    if (!t || Game.time - t.idsAt >= 100) {
      var a = r.structuresByType || {};
      var i = e.pos.x;
      var o = e.pos.y;
      function isAdj(e) {
        return Math.abs(i - e.pos.x) <= 1 && Math.abs(o - e.pos.y) <= 1;
      }
      var n = {
        spawn: null,
        link: null,
        factory: null,
        terminal: null,
        storage: null,
        extractor: null,
        mineral: null,
        extensions: []
      };
      var s = a[STRUCTURE_SPAWN] || [];
      for (var f = 0; f < s.length; f++) {
        if (s[f].my && isAdj(s[f])) {
          n.spawn = s[f].id;
          break;
        }
      }
      var c = a[STRUCTURE_LINK] || [];
      for (var f = 0; f < c.length; f++) {
        if (c[f].my && isAdj(c[f])) {
          n.link = c[f].id;
          break;
        }
      }
      var m = a[STRUCTURE_FACTORY] || [];
      for (var f = 0; f < m.length; f++) {
        if (isAdj(m[f])) {
          n.factory = m[f].id;
          break;
        }
      }
      var u = a[STRUCTURE_TERMINAL] || [];
      for (var f = 0; f < u.length; f++) {
        if (isAdj(u[f])) {
          n.terminal = u[f].id;
          break;
        }
      }
      if (r.storage && isAdj(r.storage)) {
        n.storage = r.storage.id;
      }
      var l = (a[STRUCTURE_EXTRACTOR] || []).filter(function(e) {
        return e.my;
      });
      for (var f = 0; f < l.length; f++) {
        if (isAdj(l[f])) {
          n.extractor = l[f].id;
          break;
        }
      }
      var E = r.minerals || [];
      for (var f = 0; f < E.length; f++) {
        if (isAdj(E[f])) {
          n.mineral = E[f].id;
          break;
        }
      }
      var g = a[STRUCTURE_EXTENSION] || [];
      for (var f = 0; f < g.length; f++) {
        if (g[f].my && isAdj(g[f])) n.extensions.push(g[f].id);
      }
      t = {
        ids: n,
        idsAt: Game.time
      };
      neighborCache[e.name] = t;
    }
    if (t.tick === Game.time) return t.hood;
    var n = t.ids;
    var v = {
      spawn: n.spawn ? Game.getObjectById(n.spawn) : null,
      link: n.link ? Game.getObjectById(n.link) : null,
      factory: n.factory ? Game.getObjectById(n.factory) : null,
      terminal: n.terminal ? Game.getObjectById(n.terminal) : null,
      storage: n.storage ? Game.getObjectById(n.storage) : null,
      extractor: n.extractor ? Game.getObjectById(n.extractor) : null,
      mineral: n.mineral ? Game.getObjectById(n.mineral) : null,
      extensions: []
    };
    for (var f = 0; f < n.extensions.length; f++) {
      var R = Game.getObjectById(n.extensions[f]);
      if (R) v.extensions.push(R);
    }
    t.hood = v;
    t.tick = Game.time;
    return v;
  }
};
