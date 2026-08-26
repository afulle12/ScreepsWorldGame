// LLM: Read docs/codex.js before reviewing or changing this file.
// roleLabBot.js
// Role dispatch: memory.role === 'labBot' -> roleLabBot.run(creep).
// Console globals: forceSpawnLabBot, marketSell
// Example: forceSpawnLabBot('E1N1') - Force spawn a labBot creep in room next tick
// Example: marketSell('E1N1', RESOURCE_LEMERGIUM, 1000) - Dispatch labBot terminal transfer for market sell
// Example: require('roleLabBot').run(creep);
var debugLog = function(e) {
  if (Memory.labsDebug) {
    console.log(e);
  }
};
var getRoomState = require("getRoomState");
var storageManager = require("storageManager");
var spawnManager = require("spawnManager");
var labCommodityPolicy = require("labCommodityPolicy");
var labCommodityRouter = require("labCommodityRouter");
function _getLabs(e) {
  var r = getRoomState.get(e.room.name);
  if (r && r.structuresByType && r.structuresByType[STRUCTURE_LAB]) {
    return r.structuresByType[STRUCTURE_LAB];
  }
  return e.room.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_LAB;
    }
  });
}

var LAB_CAPACITY = 3e3;
var LAB_REACTION_AMOUNT = labCommodityPolicy.MIN_REACTION_AMOUNT;
var IDLE_SUICIDE_TICKS = 150;
var _boostManagerModule = null;
function getBoostManager() {
  if (!_boostManagerModule) _boostManagerModule = require("boostManager");
  return _boostManagerModule;
}

var LAB_MINERAL_CAPACITY_BOOST = 3e3;
var LAB_ENERGY_CAPACITY_BOOST = 2e3;
function requestGracefulSuicide(e, r) {
  e.memory.suicidePending = true;
  debugLog("[LabBot " + e.name + "] graceful suicide requested — " + r);
}

function consumeReservedWithdraw(e, r, a, t, o) {
  if (!r || !o || !o.reservationProgram) {
    return e.withdraw(r, a, t);
  }
  var i = null;
  if (r.structureType === STRUCTURE_TERMINAL) i = "terminal"; else if (r.structureType === STRUCTURE_STORAGE) i = "storage";
  var n = e.withdraw(r, a, t);
  if (n === OK && i) {
    storageManager.consume(e.room.name, a, i, o.reservationProgram, t);
  }
  return n;
}

function consumeBoostWithdraw(e, r, a, t) {
  var o = e.withdraw(r, a, t);
  if (o !== OK || !r) {
    return o;
  }
  var i = null;
  if (r.structureType === STRUCTURE_TERMINAL) i = "terminal"; else if (r.structureType === STRUCTURE_STORAGE) i = "storage";
  if (i) {
    var n = storageManager.consume(e.room.name, a, i, "boostManager", t);
    if (!n || !n.ok) {
      debugLog("[LabBot " + e.name + "] boost consume mismatch " + a + " from " + i + " amount=" + t + " reason=" + (n && n.reason ? n.reason : "unknown"));
    }
  }
  return o;
}

function getBoostReservedAmount(e, r, a) {
  try {
    const t = require("storageVfs");
    const o = t.getReservationList(e, r, a);
    let total = 0;
    let found = false;
    for (let i = 0; i < o.length; i++) {
      if (o[i] && o[i].program === "boostManager") {
        found = true;
        total += o[i].amount || 0;
      }
    }
    if (found) return total;
  } catch (error) {
    if (Game.time % 100 === 0) console.log("[LabBot] V2 reservation read failed: " + ((error && error.message) || error));
  }
  return storageManager.getProgramReserved(e, r, a, "boostManager");
}

function getBoostPickupTarget(e, r, a) {
  var t = Game.rooms[e];
  if (!t) return null;
  var o = t.terminal;
  var i = t.storage;
  if (!o && !i) return null;
  var n = o ? getBoostReservedAmount(e, "terminal", r) : 0;
  var s = i ? getBoostReservedAmount(e, "storage", r) : 0;
  if (n >= a && o) {
    return {
      source: o,
      amount: a
    };
  }
  if (s >= a && i) {
    return {
      source: i,
      amount: a
    };
  }
  if (n <= 0 && s <= 0) {
    return null;
  }
  if (n >= s && n > 0 && o) {
    return {
      source: o,
      amount: Math.min(a, n)
    };
  }
  if (i && s > 0) {
    return {
      source: i,
      amount: Math.min(a, s)
    };
  }
  return null;
}

function hasBlockers(e, r) {
  var a = r.type === "breakdown";
  for (var t = 0; t < e.groups.length; t++) {
    var o = e.groups[t];
    if (a) {
      var i = o.in1.mineralType && o.in1.mineralType !== r.reag1 && (o.in1.mineralAmount || 0) > 0;
      var n = o.in2.mineralType && o.in2.mineralType !== r.reag2 && (o.in2.mineralAmount || 0) > 0;
      if (i || n) return true;
      for (var s = 0; s < o.outs.length; s++) {
        var u = o.outs[s];
        if (u.mineralType && u.mineralType !== r.compound && (u.mineralAmount || 0) > 0) {
          return true;
        }
      }
    } else {
      var m = o.in1.mineralType && o.in1.mineralType !== r.reag1;
      var l = o.in2.mineralType && o.in2.mineralType !== r.reag2;
      if (m || l) return true;
      for (var g = 0; g < o.outs.length; g++) {
        var v = o.outs[g];
        if (v.mineralType && v.mineralType !== r.product) {
          return true;
        }
      }
    }
  }
  return false;
}

function clearBlockingLabs(e, r, a) {
  var t = a.type === "breakdown";
  var o = a.reag1;
  var i = a.reag2;
  var n = t ? a.compound : a.product;
  for (var s = 0; s < r.groups.length; s++) {
    var u = r.groups[s];
    if (u.in1.mineralType && u.in1.mineralType !== o && (u.in1.mineralAmount || 0) > 0) {
      if (e.pos.isNearTo(u.in1)) {
        var m = Math.min(u.in1.mineralAmount, e.store.getFreeCapacity());
        e.withdraw(u.in1, u.in1.mineralType, m);
        return true;
      } else {
        e.moveTo(u.in1, {
          range: 1,
          reusePath: 10
        });
        return true;
      }
    }
    if (u.in2.mineralType && u.in2.mineralType !== i && (u.in2.mineralAmount || 0) > 0) {
      if (e.pos.isNearTo(u.in2)) {
        var m = Math.min(u.in2.mineralAmount, e.store.getFreeCapacity());
        e.withdraw(u.in2, u.in2.mineralType, m);
        return true;
      } else {
        e.moveTo(u.in2, {
          range: 1,
          reusePath: 10
        });
        return true;
      }
    }
    for (var l = 0; l < u.outs.length; l++) {
      var g = u.outs[l];
      if (g.mineralType && g.mineralType !== n && (g.mineralAmount || 0) > 0) {
        if (e.pos.isNearTo(g)) {
          var m = Math.min(g.mineralAmount, e.store.getFreeCapacity());
          e.withdraw(g, g.mineralType, m);
          return true;
        } else {
          e.moveTo(g, {
            range: 1,
            reusePath: 10
          });
          return true;
        }
      }
    }
  }
  return false;
}

function getPerInputTarget(e, r) {
  var a = typeof r.remaining === "number" ? r.remaining : r.amount || 0;
  if (a <= 0) return 0;
  var t = 0;
  var o = 0;
  for (var i = 0; i < e.groups.length; i++) {
    for (var n = 0; n < e.groups[i].outs.length; n++) {
      var s = e.groups[i].outs[n];
      t += s.store.getFreeCapacity(r.product) || 0;
      o += s.store && s.store[r.product] || 0;
    }
  }
  var u = Math.max(0, a - o);
  if (u === 0) return 0;
  var m = Math.min(u, t);
  var l = e.groups.length;
  var g = Math.ceil(m / l);
  var v = Math.min(g, LAB_CAPACITY);
  var f = v % LAB_REACTION_AMOUNT;
  if (f !== 0) {
    v += LAB_REACTION_AMOUNT - f;
  }
  v = Math.min(v, LAB_CAPACITY);
  return Math.max(v, 0);
}

function findMostNeededInput(e, r, a, t) {
  var o = null;
  var i = 0;
  var n = t ? t.terminal : null;
  var s = t ? t.storage : null;
  var u = (n && n.store[r.reag1] || 0) + (s && s.store[r.reag1] || 0);
  var m = (n && n.store[r.reag2] || 0) + (s && s.store[r.reag2] || 0);
  for (var l = 0; l < e.groups.length; l++) {
    var g = e.groups[l];
    if (u > 0) {
      var v = g.in1.mineralType === r.reag1 ? g.in1.mineralAmount || 0 : 0;
      var f = Math.max(0, a - v);
      if (f > i) {
        i = f;
        o = {
          group: g,
          groupIndex: l,
          reagent: r.reag1,
          lab: g.in1,
          deficit: f
        };
      }
    }
    if (m > 0) {
      var d = g.in2.mineralType === r.reag2 ? g.in2.mineralAmount || 0 : 0;
      var c = Math.max(0, a - d);
      if (c > i) {
        i = c;
        o = {
          group: g,
          groupIndex: l,
          reagent: r.reag2,
          lab: g.in2,
          deficit: c
        };
      }
    }
  }
  return o;
}

function handleReagentDeliveryBalanced(e, r, a, t) {
  if (e.store.getUsedCapacity() > 0) {
    function depositBalanced(a, o) {
      if ((e.store[a] || 0) === 0) return false;
      var i = [];
      for (var n = 0; n < r.groups.length; n++) {
        var s = r.groups[n];
        var u = o ? s.in1 : s.in2;
        var m = u.mineralType === a ? u.mineralAmount || 0 : 0;
        if (m < t) i.push({
          lab: u,
          have: m
        });
      }
      if (i.length === 0) return false;
      i.sort(function(e, r) {
        return e.have - r.have;
      });
      var l = i[0];
      if (!e.pos.isNearTo(l.lab)) {
        e.moveTo(l.lab, {
          range: 1,
          reusePath: 10
        });
        return true;
      }
      var g;
      if (i.length === 1) {
        g = t - l.have;
      } else if (i[1].have > l.have) {
        g = i[1].have - l.have;
      } else {
        g = Math.ceil(e.store[a] / i.length);
      }
      g = Math.max(g, LAB_REACTION_AMOUNT);
      var v = l.lab.store.getFreeCapacity(a) || 0;
      var f = Math.min(e.store[a], v, g);
      if (f > 0) {
        e.transfer(l.lab, a, f);
        e.memory.idleTicks = 0;
      }
      return true;
    }
    if (depositBalanced(a.reag1, true)) return;
    if (depositBalanced(a.reag2, false)) return;
    deliverToBest(e);
    return;
  }
  var o = findMostNeededInput(r, a, t, e.room);
  if (!o || o.deficit <= 0) return;
  var i = e.room.terminal;
  var n = e.room.storage;
  var s = o.reagent;
  var u = 0;
  for (var m = 0; m < r.groups.length; m++) {
    var l = r.groups[m];
    var g = s === a.reag1 ? l.in1 : l.in2;
    var v = g.mineralType === s ? g.mineralAmount || 0 : 0;
    u += Math.max(0, t - v);
  }
  var f = Math.min(u, e.store.getCapacity());
  var d = null;
  var c = a && a.reservationProgram;
  var p = c ? storageManager.storageFind(e.room.name, s) : null;
  var T = p && p.terminal && Array.isArray(p.terminal.reservations) ? p.terminal.reservations : [];
  var y = p && p.storage && Array.isArray(p.storage.reservations) ? p.storage.reservations : [];
  var A = 0;
  var h = 0;
  for (var R = 0; R < T.length; R++) {
    if (T[R] && T[R].program === c) A += T[R].amount || 0;
  }
  for (var b = 0; b < y.length; b++) {
    if (y[b] && y[b].program === c) h += y[b].amount || 0;
  }
  if (i && c && A > 0) {
    d = i;
    f = Math.min(f, A, i.store[s] || 0);
  } else if (n && c && h > 0) {
    d = n;
    f = Math.min(f, h, n.store[s] || 0);
  } else if (i && (i.store[s] || 0) >= f) {
    d = i;
  } else if (n && (n.store[s] || 0) >= f) {
    d = n;
  } else if (i && (i.store[s] || 0) > 0) {
    d = i;
    f = Math.min(i.store[s], e.store.getCapacity());
  } else if (n && (n.store[s] || 0) > 0) {
    d = n;
    f = Math.min(n.store[s], e.store.getCapacity());
  }
  if (!d) return;
  if (e.pos.isNearTo(d)) {
    var C = d.store[s] || 0;
    var _ = Math.min(f, C, e.store.getFreeCapacity());
    if (_ > 0) {
      consumeReservedWithdraw(e, d, s, _, a);
      e.memory.idleTicks = 0;
    }
  } else {
    e.moveTo(d, {
      range: 1,
      reusePath: 10
    });
  }
}

function handleMidReactionEvacuation(e, r, a) {
  var t = a.product;
  if (e.store.getUsedCapacity() > 0 && !(e.store[t] > 0)) {
    deliverToBest(e);
    return true;
  }
  var o = null;
  var i = Infinity;
  for (var n = 0; n < r.groups.length; n++) {
    var s = r.groups[n];
    for (var u = 0; u < s.outs.length; u++) {
      var m = s.outs[u];
      if (m.mineralType === t && (m.mineralAmount || 0) > 0) {
        var l = e.pos.getRangeTo(m);
        if (l < i) {
          i = l;
          o = m;
        }
      }
    }
  }
  if ((e.store[t] || 0) > 0) {
    var g = e.store.getFreeCapacity();
    if (g < LAB_REACTION_AMOUNT) {
      deliverProductAndRecord(e, t);
      return true;
    }
    if (o) {
      if (e.pos.isNearTo(o)) {
        var v = Math.min(o.mineralAmount || 0, g);
        e.withdraw(o, t, v);
        e.memory.idleTicks = 0;
      } else {
        e.moveTo(o, {
          range: 1,
          reusePath: 10
        });
      }
      return true;
    }
    deliverProductAndRecord(e, t);
    return true;
  }
  if (!o) return false;
  if (e.pos.isNearTo(o)) {
    var v = Math.min(o.mineralAmount || 0, e.store.getCapacity());
    e.withdraw(o, t, v);
    e.memory.idleTicks = 0;
  } else {
    e.moveTo(o, {
      range: 1,
      reusePath: 10
    });
  }
  return true;
}

function handleProductionEvacuation(e, r, a) {
  var t = null;
  var o = null;
  var i = 0;
  for (var n = 0; n < r.groups.length && !t; n++) {
    var s = r.groups[n];
    for (var u = 0; u < s.outs.length; u++) {
      var m = s.outs[u];
      if (m.mineralType === a.product && (m.mineralAmount || 0) > 0) {
        t = m;
        o = a.product;
        i = m.mineralAmount;
        break;
      }
    }
    if (!t && (s.in1.mineralAmount || 0) > 0) {
      t = s.in1;
      o = s.in1.mineralType;
      i = s.in1.mineralAmount;
    } else if (!t && (s.in2.mineralAmount || 0) > 0) {
      t = s.in2;
      o = s.in2.mineralType;
      i = s.in2.mineralAmount;
    }
  }
  if (t) {
    if (e.store.getUsedCapacity() > 0 && !(e.store[o] > 0)) {
      var l = a.product;
      if ((e.store[l] || 0) > 0) deliverProductAndRecord(e, l); else deliverToBest(e);
      return;
    }
    if (e.store.getFreeCapacity() === 0) {
      var l = a.product;
      if ((e.store[l] || 0) > 0) deliverProductAndRecord(e, l); else deliverToBest(e);
      return;
    }
    if (e.pos.isNearTo(t)) {
      consumeReservedWithdraw(e, t, o, Math.min(i, e.store.getFreeCapacity()), a);
    } else {
      e.moveTo(t, {
        range: 1,
        reusePath: 10
      });
    }
    return;
  }
  if (e.store.getUsedCapacity() > 0) {
    var l = a.product;
    if ((e.store[l] || 0) > 0) deliverProductAndRecord(e, l); else deliverToBest(e);
    return;
  }
  if (r.groups.length > 0 && !e.pos.inRangeTo(r.groups[0].in1, 3)) {
    e.moveTo(r.groups[0].in1, {
      range: 3,
      reusePath: 15
    });
  }
}

function findLowestOutputLab(e, r, a) {
  var t = r.compound;
  var o = null;
  var i = Infinity;
  var n = Math.max(a, LAB_REACTION_AMOUNT);
  for (var s = 0; s < e.groups.length; s++) {
    var u = e.groups[s];
    for (var m = 0; m < u.outs.length; m++) {
      var l = u.outs[m];
      var g = l.mineralType === t || !l.mineralType || (l.mineralAmount || 0) === 0;
      if (!g) continue;
      var v = l.mineralType === t ? l.mineralAmount || 0 : 0;
      var f = l.store.getFreeCapacity(t) || 0;
      if (v < n && f > 0 && v < i) {
        i = v;
        o = {
          lab: l,
          groupIndex: s,
          outIndex: m,
          currentAmount: v,
          deficit: n - v,
          freeSpace: f
        };
      }
    }
  }
  return o;
}

function countTotalOutputLabs(e) {
  var r = 0;
  for (var a = 0; a < e.groups.length; a++) {
    r += e.groups[a].outs.length;
  }
  return r;
}

function handleBreakdownDelivery(e, r, a) {
  var t = a.compound;
  var o = e.store.getCapacity();
  var i = typeof a.remaining === "number" ? a.remaining : a.amount || 0;
  var n = countTotalOutputLabs(r);
  var s = _getLabs(e);
  var u = 0;
  var m = 0;
  for (var l = 0; l < s.length; l++) {
    var g = s[l];
    if (g.mineralType === t) {
      var v = g.mineralAmount || 0;
      u += v;
      if (v >= LAB_REACTION_AMOUNT) m += v;
    }
  }
  var f;
  if (i < LAB_REACTION_AMOUNT) {
    f = 0;
  } else {
    var d = u + i;
    var c = Math.ceil(d / Math.max(n, 1));
    var p = c % LAB_REACTION_AMOUNT;
    if (p !== 0) c += LAB_REACTION_AMOUNT - p;
    f = Math.max(c, LAB_REACTION_AMOUNT);
    f = Math.min(f, LAB_CAPACITY);
  }
  var T = e.room.terminal;
  var y = e.room.storage;
  var A = T && T.store[t] || 0;
  var h = y && y.store[t] || 0;
  var R = A + h;
  var b = R + u;
  var C = A >= LAB_REACTION_AMOUNT || h >= LAB_REACTION_AMOUNT;
  var _ = C || m > 0;
  var M = 0;
  var N = 0;
  var B = null;
  for (var L = 0; L < r.groups.length; L++) {
    var E = r.groups[L];
    var O = E.in1.mineralAmount || 0;
    M += O;
    if (O > N) {
      N = O;
      B = {
        lab: E.in1,
        groupIndex: L,
        labName: "IN1"
      };
    }
    var k = E.in2.mineralAmount || 0;
    M += k;
    if (k > N) {
      N = k;
      B = {
        lab: E.in2,
        groupIndex: L,
        labName: "IN2"
      };
    }
  }
  var U = !_;
  var P = U || i <= 0 || i < LAB_REACTION_AMOUNT && !C || f === 0;
  if (U && M > 0) {
    debugLog("[LabBot " + e.name + "] BREAKDOWN COMPLETE - forcing evacuation.");
    if (!a.evacuating) {
      a.evacuating = true;
      a.remaining = 0;
    }
  }
  if ((e.store[t] || 0) > 0) {
    var w = e.store[t];
    if (w < LAB_REACTION_AMOUNT || P) {
      deliverToBest(e);
      return;
    }
    var I = findLowestOutputLab(r, a, f);
    if (I && I.deficit > 0) {
      if (e.pos.isNearTo(I.lab)) {
        var S = Math.min(e.store[t], I.freeSpace, I.deficit);
        if (S > 0) {
          var F = e.transfer(I.lab, t, S);
          if (F === OK) {
            var x = require("labManager");
            x.recordDelivery(e.room.name, t, S);
            e.memory.idleTicks = 0;
            debugLog("[LabBot " + e.name + "] delivered " + S + " " + t + " to output lab (recorded)");
          }
        }
        return;
      } else {
        e.moveTo(I.lab, {
          range: 1,
          reusePath: 10
        });
        return;
      }
    }
    deliverToBest(e);
    return;
  }
  if ((e.store[a.reag1] || 0) > 0) {
    deliverReagentAndRecord(e, a.reag1);
    return;
  }
  if ((e.store[a.reag2] || 0) > 0) {
    deliverReagentAndRecord(e, a.reag2);
    return;
  }
  if (e.store.getUsedCapacity() > 0) {
    deliverToBest(e);
    return;
  }
  if (P) {
    if (m > 0) {
      var q = r.groups[0].in1.store.getFreeCapacity(a.reag1) || 0;
      var D = r.groups[0].in2.store.getFreeCapacity(a.reag2) || 0;
      if (q >= LAB_REACTION_AMOUNT && D >= LAB_REACTION_AMOUNT) {
        e.memory.idleTicks = 0;
        debugLog("[LabBot " + e.name + "] waiting for breakdown to finish (" + m + " compound remaining in labs)");
        if (r.groups.length > 0 && !e.pos.inRangeTo(r.groups[0].in1, 3)) {
          e.moveTo(r.groups[0].in1, {
            range: 3,
            reusePath: 15
          });
        }
        return;
      }
    }
    if (N > 0 && B) {
      debugLog("[LabBot " + e.name + "] finishing: evacuating " + N + " " + B.lab.mineralType);
      if (e.pos.isNearTo(B.lab)) {
        e.withdraw(B.lab, B.lab.mineralType, Math.min(B.lab.mineralAmount, o));
        e.memory.idleTicks = 0;
        return;
      } else {
        e.moveTo(B.lab, {
          range: 1,
          reusePath: 10
        });
        return;
      }
    }
    if (u > 0) {
      for (var l = 0; l < s.length; l++) {
        var g = s[l];
        if (g.mineralType === t && (g.mineralAmount || 0) > 0) {
          if (e.pos.isNearTo(g)) {
            e.withdraw(g, t, Math.min(g.mineralAmount, o));
            e.memory.idleTicks = 0;
            return;
          } else {
            e.moveTo(g, {
              range: 1,
              reusePath: 10
            });
            return;
          }
        }
      }
    }
    if (!a.evacuating) {
      a.evacuating = true;
      a.remaining = 0;
    }
    if (r.groups.length > 0 && !e.pos.inRangeTo(r.groups[0].in1, 3)) {
      e.moveTo(r.groups[0].in1, {
        range: 3,
        reusePath: 15
      });
    }
    return;
  }
  var G = false;
  for (var L = 0; L < r.groups.length; L++) {
    var Y = r.groups[L];
    if ((Y.in1.store.getFreeCapacity(a.reag1) || 0) < LAB_REACTION_AMOUNT) G = true;
    if ((Y.in2.store.getFreeCapacity(a.reag2) || 0) < LAB_REACTION_AMOUNT) G = true;
  }
  var W = !C && !m;
  var K = (G || W) && N > 0;
  if (K && B) {
    if (e.pos.isNearTo(B.lab)) {
      consumeReservedWithdraw(e, B.lab, B.lab.mineralType, Math.min(B.lab.mineralAmount, o), a);
      e.memory.idleTicks = 0;
      debugLog("[LabBot " + e.name + "] evacuating " + B.lab.mineralType);
      return;
    } else {
      e.moveTo(B.lab, {
        range: 1,
        reusePath: 10
      });
      return;
    }
  }
  var V = Math.max(f, LAB_REACTION_AMOUNT);
  var I = findLowestOutputLab(r, a, V);
  var j = I && I.deficit > 0 && C;
  if (j) {
    var z = null;
    var H = Math.min(I.deficit, o);
    if (T && A >= LAB_REACTION_AMOUNT) {
      z = T;
      H = Math.min(H, A);
    } else if (y && h >= LAB_REACTION_AMOUNT) {
      z = y;
      H = Math.min(H, h);
    }
    if (z && H >= LAB_REACTION_AMOUNT) {
      if (e.pos.isNearTo(z)) {
        e.withdraw(z, t, Math.min(H, e.store.getFreeCapacity()));
        e.memory.idleTicks = 0;
        return;
      } else {
        e.moveTo(z, {
          range: 1,
          reusePath: 10
        });
        return;
      }
    }
  }
  for (var l = 0; l < s.length; l++) {
    var g = s[l];
    var J = g.mineralAmount || 0;
    if (g.mineralType === t && J > 0 && J < LAB_REACTION_AMOUNT) {
      if (e.pos.isNearTo(g)) {
        e.withdraw(g, t, J);
        e.memory.idleTicks = 0;
        return;
      } else {
        e.moveTo(g, {
          range: 1,
          reusePath: 10
        });
        return;
      }
    }
  }
  debugLog("[LabBot " + e.name + "] idle: reagent=" + N + ", compound=" + b);
  var q = r.groups[0].in1.store.getFreeCapacity(a.reag1) || 0;
  var D = r.groups[0].in2.store.getFreeCapacity(a.reag2) || 0;
  var Q = m > 0 && q >= LAB_REACTION_AMOUNT && D >= LAB_REACTION_AMOUNT;
  if (Q) {
    e.memory.idleTicks = 0;
    debugLog("[LabBot " + e.name + "] waiting on active breakdown reactions");
    if (r.groups.length > 0 && !e.pos.inRangeTo(r.groups[0].in1, 3)) {
      e.moveTo(r.groups[0].in1, {
        range: 3,
        reusePath: 15
      });
    }
    return;
  }
  if (typeof e.memory.idleTicks !== "number") e.memory.idleTicks = 0;
  e.memory.idleTicks++;
  if (e.memory.idleTicks >= IDLE_SUICIDE_TICKS) {
    requestGracefulSuicide(e, "idle_too_long_" + e.memory.idleTicks + "_ticks");
    return;
  }
  if (r.groups.length > 0 && !e.pos.inRangeTo(r.groups[0].in1, 3)) {
    e.moveTo(r.groups[0].in1, {
      range: 3,
      reusePath: 15
    });
  }
}

function pickDeliveryTarget(e) {
  var r = e.room.terminal;
  var a = e.room.storage;
  if (e.memory.labSink === "storage") {
    if (a && (a.store.getFreeCapacity() || 0) > 0) return a;
    if (r && (r.store.getFreeCapacity() || 0) > 0) return r;
    return a || r || null;
  }
  if (r && (r.store.getFreeCapacity() || 0) > 0) return r;
  if (a) return a;
  return r || null;
}

function deliverProductAndRecord(e, r) {
  var a = e.store[r] || 0;
  if (a <= 0) return false;
  var t = pickDeliveryTarget(e);
  if (!t) {
    debugLog("[LabBot " + e.name + "] No terminal or storage for product delivery");
    return false;
  }
  if (e.pos.isNearTo(t)) {
    var o = e.transfer(t, r);
    if (o === OK) {
      e.memory.lastAction = "deposit";
      e.memory.lastResource = r;
      e.memory.depositReason = "product_delivery";
      e.memory.idleTicks = 0;
      var i = require("labManager");
      i.recordDelivery(e.room.name, r, a);
      return true;
    }
  } else {
    e.moveTo(t, {
      range: 1,
      reusePath: 10
    });
  }
  return false;
}

function deliverReagentAndRecord(e, r) {
  var a = e.store[r] || 0;
  if (a <= 0) return false;
  var t = pickDeliveryTarget(e);
  if (!t) return false;
  if (e.pos.isNearTo(t)) {
    var o = e.transfer(t, r);
    if (o === OK) {
      e.memory.lastAction = "deposit";
      e.memory.lastResource = r;
      e.memory.depositReason = "reagent_evacuation";
      e.memory.idleTicks = 0;
      return true;
    }
  } else {
    e.moveTo(t, {
      range: 1,
      reusePath: 10
    });
  }
  return false;
}

function deliverToBest(e) {
  if (e.store.getUsedCapacity() === 0) return false;
  var r = pickDeliveryTarget(e);
  if (!r) return false;
  if (e.pos.isNearTo(r)) {
    for (var a in e.store) {
      if (e.store[a] > 0) {
        var t = e.transfer(r, a);
        if (t === OK) {
          e.memory.lastAction = "deposit";
          e.memory.lastResource = a;
          e.memory.depositReason = "general_delivery";
          return true;
        }
      }
    }
  } else {
    e.moveTo(r, {
      range: 1,
      reusePath: 10
    });
  }
  return false;
}

function orderNeedsResource(e, r) {
  if (!e) return false;
  return r === e.reag1 || r === e.reag2 || r === e.product || r === e.compound;
}

function isResourceReservedForRoom(e, r, a) {
  if (orderNeedsResource(a, r)) return true;
  var t = require("labManager");
  var o = t && typeof t.getRoomOrderState === "function" ? t.getRoomOrderState(e) : null;
  if (o && o.queue) {
    for (var i = 0; i < o.queue.length; i++) {
      if (orderNeedsResource(o.queue[i], r)) return true;
    }
  }
  var n = require("marketLab");
  var s = n && typeof n.getRoomOperations === "function" ? n.getRoomOperations(e) : [];
  for (var u = 0; u < s.length; u++) {
    var m = s[u];
    if (!m) continue;
    if (m.targetCompound === r) return true;
    if (m.direction === "forward" && m.reagents && (m.reagents[0] === r || m.reagents[1] === r)) return true;
  }
  return false;
}

function deliverPreEvacAndSell(e, r) {
  if (e.store.getUsedCapacity() === 0) return false;
  var a = e.room.terminal;
  var t = pickDeliveryTarget(e);
  if (!t) return false;
  if (e.pos.isNearTo(t)) {
    for (var o in e.store) {
      if (e.store[o] > 0) {
        var i = e.store[o];
        var n = e.transfer(t, o);
        if (n === OK) {
          e.memory.lastAction = "deposit";
          e.memory.lastResource = o;
          e.memory.depositReason = "pre_evac_sell";
          e.memory.idleTicks = 0;
          var s = isResourceReservedForRoom(e.room.name, o, r);
          if (t === a && !s && o !== RESOURCE_ENERGY) {
            if (labCommodityPolicy.isTwoLetterLabProduct(o)) {
              labCommodityRouter.enqueue(e.room.name, o, i, "lab pre-evacuation cleanup");
            } else if (typeof global.marketSell === "function") {
              global.marketSell(e.room.name, o, i);
            }
          }
          return true;
        }
      }
    }
  } else {
    e.moveTo(t, {
      range: 1,
      reusePath: 10
    });
  }
  return false;
}

function handlePreEvacuation(e, r, a) {
  var t = _getLabs(e);
  var o = null;
  var i = null;
  var n = 0;
  for (var s = 0; s < t.length; s++) {
    var u = t[s];
    var m = u.mineralAmount || 0;
    if (m > 0) {
      o = u;
      i = u.mineralType;
      n = m;
      break;
    }
  }
  if (!o) {
    if (e.store.getUsedCapacity() > 0) {
      deliverPreEvacAndSell(e, a);
      return;
    }
    var l = r.groups[0].in1;
    if (!e.pos.inRangeTo(l, 3)) {
      e.moveTo(l, {
        range: 3,
        reusePath: 15
      });
    }
    return;
  }
  if (e.store.getUsedCapacity() > 0 && !(e.store[i] > 0)) {
    deliverPreEvacAndSell(e, a);
    return;
  }
  if (e.store.getFreeCapacity() === 0) {
    deliverPreEvacAndSell(e, a);
    return;
  }
  if (e.pos.isNearTo(o)) {
    var g = Math.min(n, e.store.getFreeCapacity());
    consumeReservedWithdraw(e, o, i, g, a);
    e.memory.idleTicks = 0;
  } else {
    e.moveTo(o, {
      range: 1,
      reusePath: 10
    });
  }
}

function handleBreakdownEvacuation(e, r, a) {
  var t = _getLabs(e);
  var o = 0;
  for (var i = 0; i < t.length; i++) {
    var n = t[i];
    if (n.mineralType === a.compound && (n.mineralAmount || 0) >= LAB_REACTION_AMOUNT) {
      o += n.mineralAmount;
    }
  }
  if (o > 0) {
    var s = r.groups[0].in1.store.getFreeCapacity(a.reag1) || 0;
    var u = r.groups[0].in2.store.getFreeCapacity(a.reag2) || 0;
    if (s >= LAB_REACTION_AMOUNT && u >= LAB_REACTION_AMOUNT) {
      e.memory.idleTicks = 0;
      debugLog("[LabBot " + e.name + "] breakdown still running (" + o + " compound in labs), waiting");
      if (e.store.getUsedCapacity() > 0) {
        if ((e.store[a.reag1] || 0) > 0) {
          deliverReagentAndRecord(e, a.reag1);
          return;
        }
        if ((e.store[a.reag2] || 0) > 0) {
          deliverReagentAndRecord(e, a.reag2);
          return;
        }
        deliverToBest(e);
        return;
      }
      if (r.groups.length > 0 && !e.pos.inRangeTo(r.groups[0].in1, 3)) {
        e.moveTo(r.groups[0].in1, {
          range: 3,
          reusePath: 15
        });
      }
      return;
    }
  }
  var m = null;
  var l = null;
  var g = 0;
  e: for (var v = 0; v < r.groups.length; v++) {
    var f = r.groups[v];
    var d = [ {
      lab: f.in1,
      expectedResource: a.reag1
    }, {
      lab: f.in2,
      expectedResource: a.reag2
    } ];
    for (var c = 0; c < d.length; c++) {
      var p = d[c].lab;
      if ((p.mineralAmount || 0) > 0) {
        m = p;
        l = p.mineralType;
        g = p.mineralAmount;
        break e;
      }
    }
  }
  if (!m) {
    e: for (var v = 0; v < r.groups.length; v++) {
      for (var T = 0; T < r.groups[v].outs.length; T++) {
        var y = r.groups[v].outs[T];
        if (y.mineralType === a.compound && (y.mineralAmount || 0) > 0) {
          m = y;
          l = a.compound;
          g = y.mineralAmount;
          break e;
        }
      }
    }
  }
  if (!m) {
    var A = _getLabs(e);
    for (var h = 0; h < A.length; h++) {
      var p = A[h];
      if (p.mineralType && (p.mineralAmount || 0) > 0) {
        m = p;
        l = p.mineralType;
        g = p.mineralAmount;
        break;
      }
    }
  }
  if (!m) {
    if (e.store.getUsedCapacity() > 0) {
      if ((e.store[a.reag1] || 0) > 0) {
        deliverReagentAndRecord(e, a.reag1);
      } else if ((e.store[a.reag2] || 0) > 0) {
        deliverReagentAndRecord(e, a.reag2);
      } else {
        deliverToBest(e);
      }
      return;
    }
    if (r.groups.length > 0 && !e.pos.inRangeTo(r.groups[0].in1, 3)) {
      e.moveTo(r.groups[0].in1, {
        range: 3,
        reusePath: 15
      });
    }
    return;
  }
  if (e.store.getUsedCapacity() > 0 && !(e.store[l] > 0)) {
    if ((e.store[a.reag1] || 0) > 0) {
      deliverReagentAndRecord(e, a.reag1);
    } else if ((e.store[a.reag2] || 0) > 0) {
      deliverReagentAndRecord(e, a.reag2);
    } else {
      deliverToBest(e);
    }
    return;
  }
  if (e.store.getFreeCapacity() === 0) {
    if ((e.store[a.reag1] || 0) > 0) {
      deliverReagentAndRecord(e, a.reag1);
    } else if ((e.store[a.reag2] || 0) > 0) {
      deliverReagentAndRecord(e, a.reag2);
    } else {
      deliverToBest(e);
    }
    return;
  }
  if (e.pos.isNearTo(m)) {
    var R = Math.min(g, e.store.getFreeCapacity());
    consumeReservedWithdraw(e, m, l, R, a);
    e.memory.idleTicks = 0;
  } else {
    e.moveTo(m, {
      range: 1,
      reusePath: 10
    });
  }
}

function handleBoostLabWork(e) {
  var r = getBoostManager().getLabWork(e.room.name);
  if (r.length === 0) return false;
  for (var a = 0; a < r.length; a++) {
    var t = r[a];
    var o = t.lab;
    if (t.stopping) {
      if (e.store.getUsedCapacity() > 0) {
        deliverToBest(e);
        return true;
      }
      if (o.mineralType && (o.mineralAmount || 0) > 0) {
        if (e.pos.isNearTo(o)) {
          e.withdraw(o, o.mineralType, Math.min(o.mineralAmount, e.store.getCapacity()));
          e.memory.idleTicks = 0;
        } else {
          e.moveTo(o, {
            range: 1,
            reusePath: 10
          });
        }
        return true;
      }
      var i = o.store ? o.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
      if (i > 0) {
        if (e.pos.isNearTo(o)) {
          e.withdraw(o, RESOURCE_ENERGY, Math.min(i, e.store.getCapacity()));
          e.memory.idleTicks = 0;
        } else {
          e.moveTo(o, {
            range: 1,
            reusePath: 10
          });
        }
        return true;
      }
      continue;
    }
    if (t.hasWrongMineral) {
      if (e.store.getUsedCapacity() > 0) {
        deliverToBest(e);
        return true;
      }
      if (e.pos.isNearTo(o)) {
        e.withdraw(o, o.mineralType, Math.min(o.mineralAmount || 0, e.store.getCapacity()));
        e.memory.idleTicks = 0;
      } else {
        e.moveTo(o, {
          range: 1,
          reusePath: 10
        });
      }
      return true;
    }
    if (t.isUnboostDrain) {
      if (e.store.getUsedCapacity() > 0) {
        continue;
      }
      if (e.pos.isNearTo(o)) {
        var n = Math.min(t.drainAmount || 500, o.mineralAmount || 0, e.store.getCapacity());
        if (n > 0) {
          e.withdraw(o, t.compound, n);
          e.memory.idleTicks = 0;
        }
      } else {
        e.moveTo(o, {
          range: 1,
          reusePath: 10
        });
      }
      return true;
    }
    var s = t.compound;
    if ((e.store[s] || 0) > 0 && t.needsCompound) {
      if (e.pos.isNearTo(o)) {
        var u = t.fillTarget || LAB_MINERAL_CAPACITY_BOOST - 150;
        var m = o.mineralType === s ? o.mineralAmount || 0 : 0;
        var l = Math.max(0, u - m);
        var g = Math.min(e.store[s], l);
        if (g > 0) {
          e.transfer(o, s, g);
          e.memory.idleTicks = 0;
        }
      } else {
        e.moveTo(o, {
          range: 1,
          reusePath: 10
        });
      }
      return true;
    }
    if ((e.store[RESOURCE_ENERGY] || 0) > 0 && t.needsEnergy) {
      if (e.pos.isNearTo(o)) {
        var v = o.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        var f = Math.min(e.store[RESOURCE_ENERGY], v);
        if (f > 0) {
          e.transfer(o, RESOURCE_ENERGY, f);
          e.memory.idleTicks = 0;
        }
      } else {
        e.moveTo(o, {
          range: 1,
          reusePath: 10
        });
      }
      return true;
    }
    if (e.store.getUsedCapacity() > 0) {
      continue;
    }
    if (t.needsCompound) {
      var d = t.fillTarget || LAB_MINERAL_CAPACITY_BOOST - 150;
      var c = d - (t.compoundAmount || 0);
      var p = Math.min(c, e.store.getCapacity());
      var T = getBoostPickupTarget(e.room.name, s, p);
      var y = T ? T.source : null;
      if (T) {
        p = T.amount;
      }
      if (y && p > 0) {
        if (e.pos.isNearTo(y)) {
          consumeBoostWithdraw(e, y, s, p);
          e.memory.idleTicks = 0;
        } else {
          e.moveTo(y, {
            range: 1,
            reusePath: 10
          });
        }
        return true;
      }
    }
    if (t.needsEnergy) {
      var A = LAB_ENERGY_CAPACITY_BOOST - (t.energyAmount || 0);
      var h = Math.min(A, e.store.getCapacity());
      var R = getBoostPickupTarget(e.room.name, RESOURCE_ENERGY, h);
      var b = R ? R.source : null;
      if (R) {
        h = R.amount;
      }
      if (b && h > 0) {
        if (e.pos.isNearTo(b)) {
          consumeBoostWithdraw(e, b, RESOURCE_ENERGY, h);
          e.memory.idleTicks = 0;
        } else {
          e.moveTo(b, {
            range: 1,
            reusePath: 10
          });
        }
        return true;
      }
    }
  }
  if (e.store.getUsedCapacity() > 0) {
    deliverToBest(e);
    return true;
  }
  return false;
}

module.exports = {
  run: function(e) {
    if (e.memory.phase) {
      var r = "";
      for (var a in e.store) {
        if (e.store[a] > 0) {
          r += a + ":" + e.store[a] + " ";
        }
      }
      debugLog("[LabBot " + e.name + "] phase=" + e.memory.phase + " want=(" + (e.memory.wantedReagents || "unknown") + ") " + "carry=" + r.trim() + " idle=" + (e.memory.idleTicks || 0));
    }
    if (e.memory.lastAction === "deposit") {
      debugLog("[LabBot " + e.name + "] depositOne(" + (e.memory.lastResource || "undefined") + ") " + "reason=" + (e.memory.depositReason || "unknown"));
      e.memory.lastAction = null;
      e.memory.lastResource = null;
      e.memory.depositReason = null;
    }
    if (typeof e.ticksToLive === "number" && e.ticksToLive < 100 && !e.memory.suicidePending) {
      requestGracefulSuicide(e, "low_ttl_" + e.ticksToLive);
    }
    if (e.memory.suicidePending) {
      var t = e.room.terminal;
      var o = e.room.storage;
      var i = t || o;
      if (e.store.getUsedCapacity() > 0) {
        if (!i) {
          e.suicide();
          return;
        }
        if (!e.pos.isNearTo(i)) {
          e.moveTo(i, {
            range: 1,
            reusePath: 5
          });
          return;
        }
        for (var n in e.store) {
          if (e.store[n] > 0) {
            e.transfer(i, n);
            return;
          }
        }
      }
      e.suicide();
      return;
    }
    if (global.__boostActive && handleBoostLabWork(e)) return;
    var s = require("labManager");
    var u = s && typeof s.getRoomOrderState === "function" ? s.getRoomOrderState(e.room.name) : null;
    if (!u || !u.active) {
      delete e.memory.labSink;
      if (global.__boostActive && handleBoostLabWork(e)) return;
      if (e.store.getUsedCapacity() > 0) {
        deliverToBest(e);
        return;
      }
      if (typeof e.ticksToLive === "number" && e.ticksToLive <= 50) {
        requestGracefulSuicide(e, "idle_no_orders");
        return;
      }
      if (typeof e.memory.idleTicks !== "number") e.memory.idleTicks = 0;
      e.memory.idleTicks++;
      if (e.memory.idleTicks >= 30) {
        requestGracefulSuicide(e, "no_orders_idle");
        return;
      }
      var o = e.room.storage;
      if (o && !e.pos.inRangeTo(o, 3)) {
        e.moveTo(o, {
          range: 3,
          reusePath: 20
        });
      }
      return;
    }
    var m = u.active;
    e.memory.labSink = m.sink || null;
    if ((m.origin === "marketLab" || m.marketOpId) && !m.stockpile) {
      delete e.memory.labSink;
      requestGracefulSuicide(e, "marketLab_order_supplier_owned");
      return;
    }
    if (m.type === "cleanup") {
      e.memory.phase = "cleanup";
      if (e.store.getUsedCapacity() > 0) {
        deliverPreEvacAndSell(e, m);
        return;
      }
      var l = _getLabs(e);
      for (var g = 0; g < l.length; g++) {
        var v = l[g];
        if ((v.mineralAmount || 0) > 0) {
          if (e.pos.isNearTo(v)) {
            e.withdraw(v, v.mineralType, Math.min(v.mineralAmount, e.store.getFreeCapacity()));
            e.memory.idleTicks = 0;
          } else {
            e.moveTo(v, {
              range: 1,
              reusePath: 10
            });
          }
          return;
        }
      }
      var f = e.room.storage;
      if (f && !e.pos.inRangeTo(f, 3)) {
        e.moveTo(f, {
          range: 3,
          reusePath: 20
        });
      }
      return;
    }
    var d = m.type === "breakdown";
    var c = d ? s.getBreakdownLayout(e.room) : s.getLayout(e.room);
    if (!c || !c.groups || c.groups.length === 0) {
      debugLog("[LabBot " + e.name + "] No valid lab layout found");
      return;
    }
    if (m.needsPreEvacuation) {
      e.memory.phase = "pre-evac";
      e.memory.idleTicks = 0;
      handlePreEvacuation(e, c, m);
      return;
    }
    var p = typeof m.remaining === "number" ? m.remaining : m.amount || 0;
    var T = p <= 0 || m.evacuating;
    if (T) {
      e.memory.phase = "final";
      e.memory.idleTicks = 0;
      if (d) {
        handleBreakdownEvacuation(e, c, m);
      } else {
        handleProductionEvacuation(e, c, m);
      }
      return;
    }
    if (hasBlockers(c, m)) {
      e.memory.phase = "cleanup";
      e.memory.idleTicks = 0;
      if (e.store.getUsedCapacity() > 0) {
        deliverToBest(e);
        return;
      }
      if (clearBlockingLabs(e, c, m)) {
        return;
      }
    }
    e.memory.phase = "buildA";
    if (d) {
      e.memory.wantedReagents = m.compound + " -> " + m.reag1 + "," + m.reag2;
      handleBreakdownDelivery(e, c, m);
    } else {
      e.memory.wantedReagents = m.reag1 + "," + m.reag2;
      var y = e.store.getCapacity();
      var A = getPerInputTarget(c, m);
      if (e.store.getUsedCapacity() > 0) {
        var h = m.product;
        if ((e.store[h] || 0) > 0) {
          deliverProductAndRecord(e, h);
          return;
        }
        handleReagentDeliveryBalanced(e, c, m, A);
        return;
      }
      var R = 0;
      var b = {};
      b[m.reag1] = 0;
      b[m.reag2] = 0;
      for (var C = 0; C < c.groups.length; C++) {
        var _ = c.groups[C];
        var M = _.in1.mineralType === m.reag1 ? _.in1.mineralAmount || 0 : 0;
        var N = _.in2.mineralType === m.reag2 ? _.in2.mineralAmount || 0 : 0;
        var B = Math.max(0, A - M);
        var L = Math.max(0, A - N);
        b[m.reag1] = Math.max(b[m.reag1], B);
        b[m.reag2] = Math.max(b[m.reag2], L);
        R = Math.max(R, B, L);
      }
      var t = e.room.terminal;
      var o = e.room.storage;
      var E = (t && t.store[m.reag1] || 0) + (o && o.store[m.reag1] || 0);
      var O = (t && t.store[m.reag2] || 0) + (o && o.store[m.reag2] || 0);
      var k = b[m.reag1] >= y && E >= y;
      var U = b[m.reag2] >= y && O >= y;
      var P = 0;
      var h = m.product;
      for (var C = 0; C < c.groups.length; C++) {
        var _ = c.groups[C];
        for (var w = 0; w < _.outs.length; w++) {
          var I = _.outs[w];
          if (I.mineralType === h) {
            var S = I.mineralAmount || 0;
            P = Math.max(P, S);
          }
        }
      }
      var F = p < y;
      var x = b[m.reag1] > 0 && E > 0;
      var q = b[m.reag2] > 0 && O > 0;
      var D = k || U || F && (x || q);
      var G = E === 0 && b[m.reag1] > 0;
      var Y = O === 0 && b[m.reag2] > 0;
      if (!D) {
        if (G && q) {
          D = true;
        } else if (Y && x) {
          D = true;
        }
      }
      if (D) {
        e.memory.phase = "buildA";
        e.memory.idleTicks = 0;
        handleReagentDeliveryBalanced(e, c, m, A);
        return;
      }
      var W = true;
      for (var C = 0; C < c.groups.length && W; C++) {
        var K = c.groups[C];
        for (var w = 0; w < K.outs.length; w++) {
          if ((K.outs[w].store.getFreeCapacity(m.product) || 0) >= LAB_REACTION_AMOUNT) {
            W = false;
            break;
          }
        }
      }
      var V = true;
      for (var C = 0; C < c.groups.length; C++) {
        var K = c.groups[C];
        if ((K.in1.mineralAmount || 0) >= LAB_REACTION_AMOUNT && (K.in2.mineralAmount || 0) >= LAB_REACTION_AMOUNT) {
          V = false;
          break;
        }
      }
      var j = W || V;
      if (j) {
        e.memory.phase = "mid-evac";
        var z = handleMidReactionEvacuation(e, c, m);
        if (z) {
          e.memory.idleTicks = 0;
          return;
        }
      }
      var H = !V;
      if (H) {
        e.memory.idleTicks = 0;
        debugLog("[LabBot " + e.name + "] waiting on active reactions");
        if (c.groups.length > 0 && !e.pos.inRangeTo(c.groups[0].in1, 3)) {
          e.moveTo(c.groups[0].in1, {
            range: 3,
            reusePath: 15
          });
        }
        return;
      }
      if (typeof e.memory.idleTicks !== "number") e.memory.idleTicks = 0;
      e.memory.idleTicks++;
      if (e.memory.idleTicks >= IDLE_SUICIDE_TICKS) {
        requestGracefulSuicide(e, "production_idle_" + e.memory.idleTicks + "_ticks");
        return;
      }
      debugLog("[LabBot " + e.name + "] waiting: reagent deficit=" + R + " (reag1 avail=" + E + ", reag2 avail=" + O + ")" + ", product=" + P + ", idle=" + e.memory.idleTicks + "/" + IDLE_SUICIDE_TICKS);
      if (c.groups.length > 0 && !e.pos.inRangeTo(c.groups[0].in1, 3)) {
        e.moveTo(c.groups[0].in1, {
          range: 3,
          reusePath: 15
        });
      }
    }
  }
};
global.forceSpawnLabBot = function(e) {
  var r = Game.rooms[e];
  if (!r) return "No vision in " + e;
  var a = getRoomState.get(e);
  var t = null;
  if (a && a.structuresByType && a.structuresByType[STRUCTURE_SPAWN]) {
    for (var o = 0; o < a.structuresByType[STRUCTURE_SPAWN].length; o++) {
      var i = a.structuresByType[STRUCTURE_SPAWN][o];
      if (i.my && !i.spawning) {
        t = i;
        break;
      }
    }
  } else {
    t = r.find(FIND_MY_SPAWNS)[0];
  }
  if (!t) return "No spawn in " + e;
  if (t.spawning) return "Spawn busy in " + e;
  var n = spawnManager.getCreepBody("labBot", t.room.energyAvailable);
  if (!n) return "Cannot generate labBot body";
  var s = "LabBot_" + e + "_" + Game.time;
  var u = {
    role: "labBot",
    homeRoom: e,
    assignedRoom: e,
    phase: "buildA"
  };
  var m = spawnManager.spawnCustomCreep(t, n, s, u);
  return m === OK ? "LabBot spawn queued" : "LabBot spawn failed: " + m;
};
