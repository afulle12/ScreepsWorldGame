// LLM: Read docs/codex.js before reviewing or changing this file.
// linkManager.js
var getRoomState = require("getRoomState");
var singleSourceRoom = require("singleSourceRoom");
var roomSuspender = require("roomSuspender");
var _linkCache = {};
function runLinks() {
  const e = 200;
  const r = 50;
  function energyOf(e) {
    if (e && e.store && typeof e.store.getUsedCapacity === "function") {
      var r = e.store.getUsedCapacity(RESOURCE_ENERGY);
      return typeof r === "number" ? r : 0;
    }
    if (e && typeof e.energy === "number") return e.energy;
    return 0;
  }
  function freeOf(e) {
    if (e && e.store && typeof e.store.getFreeCapacity === "function") {
      var r = e.store.getFreeCapacity(RESOURCE_ENERGY);
      return typeof r === "number" ? r : 0;
    }
    if (e && typeof e.energyCapacity === "number" && typeof e.energy === "number") {
      return e.energyCapacity - e.energy;
    }
    return 0;
  }
  function canSend(r) {
    if (!r) return false;
    if (r.cooldown && r.cooldown > 0) return false;
    return energyOf(r) >= e;
  }
  function canReceive(r) {
    if (!r) return false;
    return freeOf(r) >= e;
  }
  getRoomState.init();
  var n = getRoomState.ownedNames();
  for (var o = 0; o < n.length; o++) {
    var t = n[o];
    var a = getRoomState.get(t);
    if (!a) continue;
    if (roomSuspender.shouldAvoidRoomWork(t)) continue;
    var i = a.controller;
    var f = a.storage;
    var u = a.sources || [];
    var v = a.structuresByType || {};
    var c = v[STRUCTURE_LINK] || [];
    if (c.length === 0) continue;
    if (singleSourceRoom.isSingleSourceActive(t)) {
      var s = singleSourceRoom.getLinkChain(t);
      if (s && s.length >= 2) {
        for (var g = 0; g < s.length - 1; g++) {
          var l = Game.getObjectById(s[g]);
          var d = Game.getObjectById(s[g + 1]);
          if (!l || !d) continue;
          if (l.cooldown && l.cooldown > 0) continue;
          if (energyOf(l) < e) continue;
          if (freeOf(d) < e) continue;
          var m = l.transferEnergy(d);
          if (m === OK) break;
        }
        continue;
      }
    }
    var y = Game.rooms[t];
    if (!y) continue;
    var p = _linkCache[t];
    if (!p || Game.time - p.lastUpdated >= r) {
      p = {
        donors: [],
        storage: [],
        recipients: [],
        lastUpdated: Game.time
      };
      for (var R = 0; R < c.length; R++) {
        var h = c[R];
        if (i && h.pos.inRangeTo(i, 2)) {
          p.recipients.push(h.id);
        } else if (f && h.pos.inRangeTo(f, 2)) {
          p.storage.push(h.id);
        } else {
          for (var S = 0; S < u.length; S++) {
            if (h.pos.inRangeTo(u[S], 3)) {
              p.donors.push(h.id);
              break;
            }
          }
        }
      }
      _linkCache[t] = p;
    }
    var O = [];
    var C = [];
    var b = [];
    for (var E = 0; E < p.donors.length; E++) {
      var k = Game.getObjectById(p.donors[E]);
      if (k) O.push(k);
    }
    for (var G = 0; G < p.storage.length; G++) {
      var U = Game.getObjectById(p.storage[G]);
      if (U) C.push(U);
    }
    for (var _ = 0; _ < p.recipients.length; _++) {
      var B = Game.getObjectById(p.recipients[_]);
      if (B) b.push(B);
    }
    var I = null;
    var T = 0;
    for (var j = 0; j < O.length; j++) {
      var w = O[j];
      if (canSend(w)) {
        var L = energyOf(w);
        if (L > T) {
          I = w;
          T = L;
        }
      }
    }
    var N = null;
    var q = 0;
    for (var K = 0; K < C.length; K++) {
      var A = C[K];
      if (canReceive(A)) {
        var F = freeOf(A);
        if (F > q) {
          N = A;
          q = F;
        }
      }
    }
    if (I && N) {
      var Y = I.transferEnergy(N);
      if (Y === OK) continue;
    }
    var x = null;
    var W = 0;
    for (var z = 0; z < C.length; z++) {
      var D = C[z];
      if (canSend(D)) {
        var H = energyOf(D);
        if (H > W) {
          x = D;
          W = H;
        }
      }
    }
    var J = null;
    var M = 0;
    for (var P = 0; P < b.length; P++) {
      var Q = b[P];
      if (canReceive(Q)) {
        var V = freeOf(Q);
        if (V > M) {
          J = Q;
          M = V;
        }
      }
    }
    if (x && J) {
      x.transferEnergy(J);
    }
  }
}

function invalidateRoom(e) {
  delete _linkCache[e];
}

module.exports = {
  run: runLinks,
  invalidateRoom: invalidateRoom
};
