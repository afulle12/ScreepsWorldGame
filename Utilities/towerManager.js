// LLM: Read docs/codex.js before reviewing or changing this file.
// towerManager.js
//   1. Containers
//   2. Roads
//   3. Buildings (extensions, spawns, storage, links, towers, labs, terminals)
//   4. Generic walls/ramparts under 1M (emergency)
//   5. Ramparts protecting critical buildings under 10.5M minimum
//   6. All remaining walls/ramparts (up to defenseMax or per-type cap)
const getRoomState = require("getRoomState");
const iff = require("iff");
const spawnManager = require("spawnManager");
const repairManager = require("repairManager");
const roomSuspender = require("roomSuspender");
var DEFENSE_MAX_BY_RCL = [ 0, 0, 1e4, 5e4, 2e5, 1e6, 1e6, 1e6, 1e6 ];
var SUPPLIER_INTERVAL = 50;
var HEAL_SCAN_INTERVAL = 5;
var SCAN_COOLDOWN = 20;
var MAX_HITS_PER_TARGET = 5e4;
var REPAIR_RESCAN_INTERVAL = 150;
var MANAGER_PLAN_FRESH_TICKS = 15;
var TOWER_ENERGY_RESERVE = 350;
var TOWER_REPAIR_MAX_RATIO = .95;
var URGENT_FRACTION = .5;
var CONTAINER_URGENT_FRACTION = .2;
var GENERIC_DEFENSE_LOW = 1e6;
var CRITICAL_RAMPART_MIN = 105e5;
var CRITICAL_STRUCTURE_TYPES = [ STRUCTURE_SPAWN, STRUCTURE_TERMINAL, STRUCTURE_NUKER, STRUCTURE_STORAGE, STRUCTURE_LAB, STRUCTURE_TOWER, STRUCTURE_FACTORY ];
var REPAIR_TYPES = [ STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_LINK, STRUCTURE_TOWER, STRUCTURE_LAB, STRUCTURE_TERMINAL, STRUCTURE_RAMPART, STRUCTURE_WALL ];
function isBorderPos(e) {
  return e.x === 0 || e.x === 49 || e.y === 0 || e.y === 49;
}

function towerRepairLimit(e, r, t, a) {
  if (!e) return 0;
  var i = e.hitsMax ? Math.floor(e.hitsMax * TOWER_REPAIR_MAX_RATIO) : e.hitsMax;
  if (r && r > 0) i = Math.min(i, r);
  if (!a && (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) && t) {
    i = Math.min(i, t);
  }
  return i;
}

var PROTECTED_RAMPART_CAP_BY_TYPE = repairManager.constants.TOWER_REPAIR_CAP_BY_TYPE;
function getProtectedRampartCap(e, r) {
  if (!e || !r || !r.structuresByType) return null;
  var t = r.controller ? r.controller.level : 0;
  var a = repairManager.getRampartTarget(e, r, t);
  if (a.type && PROTECTED_RAMPART_CAP_BY_TYPE[a.type]) {
    return PROTECTED_RAMPART_CAP_BY_TYPE[a.type];
  }
  return null;
}

function effectiveTowerRepairLimit(e, r, t, a, i) {
  var R = towerRepairLimit(e, r, t, a);
  if (e && e.structureType === STRUCTURE_RAMPART) {
    var n = getProtectedRampartCap(e, i);
    if (n !== null && R > n) R = n;
  }
  return R;
}

var URGENT_TYPES = [ STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_LINK, STRUCTURE_TOWER, STRUCTURE_LAB, STRUCTURE_TERMINAL ];
var heap = {
  towers: {},
  energy: {},
  heal: {},
  repair: {},
  urgent: {},
  criticalRamparts: {},
  towerState: {},
  pendingKills: {},
  rooms: null,
  roomsTick: 0
};
function getManagerHealTarget(e, r) {
  var t = Memory.repairPlan && Memory.repairPlan[e];
  if (!t || !t.hq || !t.hq.length) return null;
  var a = t.hqt || t.t || t.tick || 0;
  if (r - a > MANAGER_PLAN_FRESH_TICKS) return null;
  for (var i = 0; i < t.hq.length; i++) {
    var R = t.hq[i];
    var n = Array.isArray(R) ? R[0] : R.name || R.id;
    var o = n && Game.powerCreeps && Game.powerCreeps[n];
    if (!o || !o.ticksToLive || !o.room || o.room.name !== e) continue;
    if (o.hits < o.hitsMax) return o;
  }
  return null;
}

function reconcilePendingTowerKills(e) {
  if (!Memory.stats) Memory.stats = {};
  if (typeof Memory.stats.kills !== "number") Memory.stats.kills = 0;
  var r = heap.pendingKills;
  for (var t in r) {
    var a = r[t];
    if (!a || a.tick >= e) continue;
    var i = Game.rooms[t];
    if (!i) {
      delete r[t];
      continue;
    }
    var R = i.find(FIND_TOMBSTONES);
    for (var n = 0; n < R.length; n++) {
      var o = R[n];
      if (o.deathTime !== a.tick) continue;
      if (a.targets[o.creep.name]) {
        Memory.stats.kills++;
      }
    }
    delete r[t];
  }
}

function getDefenseMax(e) {
  var r = e.controller ? e.controller.level : 0;
  return DEFENSE_MAX_BY_RCL[r] || 0;
}

// (for example, a bare 1-MOVE scout). A single tower one-shots it regardless of
function isLowThreatCreep(e) {
  return e.getActiveBodyparts(HEAL) === 0 && e.getActiveBodyparts(WORK) === 0 && e.getActiveBodyparts(ATTACK) === 0 && e.getActiveBodyparts(RANGED_ATTACK) === 0 && e.getActiveBodyparts(CLAIM) === 0;
}

//             tombstone-based kill attribution on the next tick
function assignTowersToTargets(e, r, t) {
  var a = 0;
  var i = r.length;
  var R = null;
  for (var n = 0; n < e.length && a < i; n++) {
    var o = e[n];
    if (isLowThreatCreep(o)) {
      if (r[a].attack(o) === OK) {
        if (!R) R = {};
        R[o.name] = true;
      }
      a++;
    } else {
      for (;a < i; a++) {
        if (r[a].attack(o) === OK) {
          if (!R) R = {};
          R[o.name] = true;
        }
      }
    }
  }
  if (t && R) {
    heap.pendingKills[t] = {
      tick: Game.time,
      targets: R
    };
  }
}

function isCriticalRampart(e, r, t) {
  var a = Game.time;
  var i = heap.criticalRamparts[r];
  if (!i || a - i.tick >= 500) {
    var R = {};
    var n = t.structuresByType;
    if (n) {
      for (var o = 0; o < CRITICAL_STRUCTURE_TYPES.length; o++) {
        var T = n[CRITICAL_STRUCTURE_TYPES[o]];
        if (!T) continue;
        for (var s = 0; s < T.length; s++) {
          try {
            var E = T[s];
            R[E.pos.x + "," + E.pos.y] = true;
          } catch (e) {}
        }
      }
    }
    var l = {};
    var v = n ? n[STRUCTURE_RAMPART] : null;
    if (v) {
      for (var f = 0; f < v.length; f++) {
        try {
          var p = v[f];
          if (R[p.pos.x + "," + p.pos.y]) {
            l[p.id] = true;
          }
        } catch (e) {}
      }
    }
    i = heap.criticalRamparts[r] = {
      tick: a,
      set: l
    };
  }
  return !!i.set[e.id];
}

function getUrgentTargets(e, r, t) {
  var a = heap.urgent[e];
  if (a && t - a.tick < 3) {
    var i = [];
    for (var R = 0; R < a.targets.length; R++) {
      var n = Game.getObjectById(a.targets[R]);
      if (n && n.hits < towerRepairLimit(n, null, null, true)) i.push(a.targets[R]);
    }
    a.targets = i;
    return i;
  }
  var o = r.structuresByType;
  var T = [];
  if (!o) {
    heap.urgent[e] = {
      tick: t,
      targets: T
    };
    return T;
  }
  for (var s = 0; s < URGENT_TYPES.length; s++) {
    var E = URGENT_TYPES[s];
    var l = o[E];
    if (!l) continue;
    var v = E === STRUCTURE_CONTAINER ? CONTAINER_URGENT_FRACTION : URGENT_FRACTION;
    for (var f = 0; f < l.length; f++) {
      try {
        var p = l[f];
        if (typeof p.hits !== "number") continue;
        if (p.hitsMax > 0 && p.hits / p.hitsMax < v) {
          T.push(p.id);
        }
      } catch (e) {}
    }
  }
  T.sort(function(e, r) {
    var t = Game.getObjectById(e);
    var a = Game.getObjectById(r);
    if (!t) return 1;
    if (!a) return -1;
    return t.hits / t.hitsMax - a.hits / a.hitsMax;
  });
  heap.urgent[e] = {
    tick: t,
    targets: T
  };
  return T;
}

function runTowers() {
  var e = Game.time;
  reconcilePendingTowerKills(e);
  if (!heap.rooms || e - heap.roomsTick >= 100) {
    heap.rooms = [];
    for (var r in Game.rooms) {
      var t = Game.rooms[r];
      if (t.controller && t.controller.my) heap.rooms.push(r);
    }
    heap.roomsTick = e;
  }
  var a = heap.rooms;
  var i = a.length;
  for (var R = 0; R < i; R++) {
    var n = a[R];
    var o = Game.rooms[n];
    if (!o) continue;
    if (roomSuspender.isSuspended(n)) continue;
    var T = getRoomState.get(n);
    if (!T) continue;
    var s = heap.towers[n];
    if (!s || e - s.tick >= 100) {
      var E = T.structuresByType ? T.structuresByType[STRUCTURE_TOWER] : null;
      var l = [];
      if (E) {
        for (var v = 0; v < E.length; v++) {
          try {
            if (E[v].my) l.push(E[v].id);
          } catch (e) {}
        }
      }
      s = heap.towers[n] = {
        ids: l,
        tick: e
      };
    }
    var f = s.ids;
    var p = f.length;
    if (p === 0) continue;
    var c = [];
    for (var u = 0; u < p; u++) {
      var _ = Game.getObjectById(f[u]);
      if (_) c.push(_);
    }
    c.sort(function(e, r) {
      return r.store[RESOURCE_ENERGY] - e.store[RESOURCE_ENERGY];
    });
    p = c.length;
    if (p === 0) continue;
    var A = T.hostiles;
    if (A && A.length > 0) {
      var h = [];
      for (var S = 0; S < A.length; S++) {
        try {
          if (iff.isHostileCreep(A[S])) h.push(A[S]);
        } catch (e) {}
      }
      if (h.length > 0) {
        var g = null;
        var C = null;
        if (h.length === 2) {
          var U = h[0].getActiveBodyparts(HEAL) > 0;
          var m = h[1].getActiveBodyparts(HEAL) > 0;
          if (U && !m) {
            g = h[0];
            C = h[1];
          } else if (!U && m) {
            g = h[1];
            C = h[0];
          }
        }
        if (g && C && p >= 2) {
          assignTowersToTargets([ g, C ], c, n);
        } else {
          h.sort(function(e, r) {
            var t = e.getActiveBodyparts(HEAL) > 0 ? 2 : e.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : e.getActiveBodyparts(WORK) > 0 ? 1 : e.getActiveBodyparts(ATTACK) > 0 ? 4 : 5;
            var a = r.getActiveBodyparts(HEAL) > 0 ? 2 : r.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : r.getActiveBodyparts(WORK) > 0 ? 1 : r.getActiveBodyparts(ATTACK) > 0 ? 4 : 5;
            return t !== a ? t - a : e.hits - r.hits;
          });
          assignTowersToTargets(h, c, n);
        }
        continue;
      }
    }
    if (!Memory.towers) Memory.towers = {};
    var y = !!(repairManager && repairManager.isMaxHeal && repairManager.isMaxHeal(n));
    var d = !!Memory.towers[n] || y;
    var N = false;
    var P = Memory.repairPlan && Memory.repairPlan[n];
    if (P) {
      N = !!(P.tp && P.tp.s === 1 || P.towerPolicy && P.towerPolicy.spreadTargets);
    }
    var M = heap.towerState[n];
    if (!M) M = heap.towerState[n] = {};
    if (!d && e % 3 !== 0) continue;
    var O = c[0];
    var I = O.store[RESOURCE_ENERGY];
    if (I < TOWER_ENERGY_RESERVE) continue;
    if (I >= TOWER_ENERGY_RESERVE) {
      var L = heap.heal[n];
      var G = getManagerHealTarget(n, e);
      var w = false;
      if (!G && L && L.id) {
        G = Game.getObjectById(L.id);
        if (G) {
          if (G.hits >= G.hitsMax * .95) {
            G = null;
            L.id = null;
            w = true;
          }
        } else {
          L.id = null;
          w = true;
        }
      }
      if (!G && (!L || e - L.tick >= HEAL_SCAN_INTERVAL || w)) {
        var B = T.myCreeps;
        if (B) {
          var x = null, k = .9;
          var Y = null, W = .9;
          for (var b = 0; b < B.length; b++) {
            try {
              var H = B[b];
              if (H.hits < H.hitsMax) {
                var K = H.hits / H.hitsMax;
                if (isBorderPos(H.pos)) {
                  if (K < W) {
                    W = K;
                    Y = H;
                  }
                } else {
                  if (K < k) {
                    k = K;
                    x = H;
                  }
                }
              }
            } catch (e) {}
          }
          G = x || Y;
        }
        heap.heal[n] = {
          id: G ? G.id : null,
          tick: e
        };
      }
      if (G) {
        O.heal(G);
        I -= 10;
        if (!d) continue;
      }
    }
    var D = getUrgentTargets(n, T, e);
    if (D.length > 0) {
      if (d) {
        var V = 0;
        var q = N ? {} : null;
        for (var F = 0; F < p && V < D.length; F++) {
          var j = c[F];
          var X = j.store[RESOURCE_ENERGY];
          if (F === 0) X = I;
          if (X < TOWER_ENERGY_RESERVE) continue;
          var Q = Game.getObjectById(D[V]);
          while (N && Q && q[Q.id] && V < D.length) {
            V++;
            Q = Game.getObjectById(D[V]);
          }
          if (Q && Q.hits < towerRepairLimit(Q, null, null, true)) {
            j.repair(Q);
            if (F === 0) I -= 10;
            if (N) {
              q[Q.id] = true;
              V++;
            } else if (Q.hitsMax > 0 && Q.hits / Q.hitsMax < URGENT_FRACTION * .5) {} else {
              V++;
            }
          } else {
            V++;
            F--;
          }
        }
        if (I < TOWER_ENERGY_RESERVE) continue;
      } else {
        var Q = Game.getObjectById(D[0]);
        if (Q && Q.hits < towerRepairLimit(Q, null, null, true) && I >= TOWER_ENERGY_RESERVE) {
          O.repair(Q);
          continue;
        }
      }
    }
    if (I < TOWER_ENERGY_RESERVE) continue;
    var z = M.repairState || "scan";
    var J = heap.repair[n];
    if (z === "repair" && J && J.scanTick && e - J.scanTick >= REPAIR_RESCAN_INTERVAL) {
      z = "scan";
      M.repairState = "scan";
    }
    if (z === "scan") {
      if (M.nextScanTick && e < M.nextScanTick) continue;
      var Z = Memory.repairPlan && Memory.repairPlan[n];
      var $ = Z ? Z.tick || Z.t || 0 : 0;
      var ee = Z && (Z.tq || Z.towerQueue);
      if (!y && Z && ee && e - $ <= MANAGER_PLAN_FRESH_TICKS) {
        var re = [];
        for (var te = 0; te < ee.length; te++) {
          var ae = ee[te];
          if (Array.isArray(ae)) {
            re.push({
              id: ae[0],
              pri: ae[1],
              val: ae[2],
              border: ae[3],
              target: ae[4]
            });
          } else {
            re.push(ae);
          }
        }
        var ie = Z.towerPolicy || null;
        if (!ie && Z.tp) {
          ie = {
            repairTowerLimit: Z.tp.l,
            reservePerTower: Z.tp.r,
            maxHeal: Z.tp.m === 1,
            spreadTargets: Z.tp.s === 1
          };
        } else if (ie) {
          if (ie.maxHeal === undefined && Z.tp && Z.tp.m === 1) ie.maxHeal = true;
          if (ie.spreadTargets === undefined && Z.tp && Z.tp.s === 1) ie.spreadTargets = true;
        }
        J = heap.repair[n] = {
          queue: re,
          idx: 0,
          hitsRepaired: 0,
          scanTick: $,
          towerPolicy: ie
        };
        M.repairState = "repair";
        M.nextScanTick = null;
        z = "repair";
      } else {
        var Re = M.lastSupplierCheck || 0;
        if (e - Re >= SUPPLIER_INTERVAL) {
          M.supplierNeeded = spawnManager.shouldSpawnSupplier(n);
          M.lastSupplierCheck = e;
        }
        var ne = M.supplierNeeded === 1;
        var B = T.myCreeps;
        var oe = false;
        if (B) {
          for (var Te = 0; Te < B.length; Te++) {
            try {
              var se = B[Te].memory;
              if (se && se.role === "supplier") {
                oe = true;
                break;
              }
            } catch (e) {}
          }
        }
        var Ee = getDefenseMax(o);
        var le = Math.min(CRITICAL_RAMPART_MIN, Ee);
        var ve = T.structuresByType;
        var fe = [];
        //   1 = Containers
        //   2 = Roads
        //   3 = Buildings
        //   4 = Generic walls/ramparts under 1M (emergency)
        //   5 = Critical ramparts under 10.5M (minimum enforcement)
        //   6 = All remaining walls/ramparts (up to defenseMax)
                if (ve) {
          for (var pe = 0; pe < REPAIR_TYPES.length; pe++) {
            var ce = REPAIR_TYPES[pe];
            var ue = ve[ce];
            if (!ue) continue;
            var _e = ce === STRUCTURE_WALL;
            var Ae = ce === STRUCTURE_RAMPART;
            var he = _e || Ae;
            if (he && !ne && !y) continue;
            for (var Se = 0; Se < ue.length; Se++) {
              try {
                var ge = ue[Se];
                var Ce = ge.hits;
                if (typeof Ce !== "number") continue;
                var Ue = ge.hitsMax;
                var me = effectiveTowerRepairLimit(ge, null, Ee, y, T);
                if (Ce >= me) continue;
                if (he && !y && Ce >= Ee) continue;
                var ye = he ? Ce : Ue > 0 ? Ce / Ue : 1;
                if (ce === STRUCTURE_CONTAINER) {
                  if (Ce >= 5e4) continue;
                }
                var de;
                if (ce === STRUCTURE_CONTAINER) {
                  de = 1;
                } else if (ce === STRUCTURE_ROAD) {
                  de = 2;
                } else if (!he) {
                  de = 3;
                } else {
                  var Ne = Ae && isCriticalRampart(ge, n, T);
                  if (!Ne && Ce < GENERIC_DEFENSE_LOW) {
                    de = 4;
                  } else if (Ne && Ce < le) {
                    de = 5;
                  } else {
                    de = 6;
                  }
                }
                fe.push({
                  id: ge.id,
                  pri: de,
                  val: ye,
                  border: isBorderPos(ge.pos) ? 1 : 0,
                  target: me
                });
              } catch (e) {}
            }
          }
          fe.sort(function(e, r) {
            if (e.pri !== r.pri) return e.pri - r.pri;
            if (e.border !== r.border) return e.border - r.border;
            return e.val - r.val;
          });
        }
        J = heap.repair[n] = {
          queue: fe,
          idx: 0,
          hitsRepaired: 0,
          scanTick: e
        };
        M.repairState = "repair";
        M.nextScanTick = null;
        z = "repair";
      }
    }
    if (z === "repair") {
      if (!J) {
        M.repairState = "scan";
        continue;
      }
      var Pe = J.queue;
      var Me = J.idx;
      var Oe = null;
      var Ee = getDefenseMax(o);
      while (Pe && Me < Pe.length) {
        var Ie = Game.getObjectById(Pe[Me].id);
        var Le = y || !!(J.towerPolicy && J.towerPolicy.maxHeal);
        if (Ie && Ie.hits < effectiveTowerRepairLimit(Ie, Pe[Me].target, Ee, Le, T)) {
          var Ge = Ie.structureType;
          var we = Ge === STRUCTURE_WALL || Ge === STRUCTURE_RAMPART;
          if (we && !Le && Ie.hits >= Ee) {
            Me++;
            continue;
          }
          Oe = Ie;
          break;
        }
        Me++;
      }
      if (!Oe) {
        M.repairState = "scan";
        M.nextScanTick = e + SCAN_COOLDOWN;
        heap.repair[n] = null;
      } else {
        var Be = 0;
        var xe = p;
        if (J.towerPolicy && typeof J.towerPolicy.repairTowerLimit === "number") {
          xe = Math.min(xe, J.towerPolicy.repairTowerLimit);
        }
        if (d && J.towerPolicy && J.towerPolicy.spreadTargets) {
          var ke = {};
          var Ye = Me;
          for (var pe = 0; pe < p && Be < xe; pe++) {
            var We = c[pe];
            var be = pe === 0 ? I : We.store[RESOURCE_ENERGY];
            if (be < TOWER_ENERGY_RESERVE) continue;
            var He = null;
            while (Pe && Ye < Pe.length) {
              var Ke = Game.getObjectById(Pe[Ye].id);
              var De = y || !!(J.towerPolicy && J.towerPolicy.maxHeal);
              if (Ke && !ke[Ke.id] && Ke.hits < effectiveTowerRepairLimit(Ke, Pe[Ye].target, Ee, De, T)) {
                var Ve = Ke.structureType;
                var qe = Ve === STRUCTURE_WALL || Ve === STRUCTURE_RAMPART;
                if (!qe || De || Ke.hits < Ee) {
                  He = Ke;
                  break;
                }
              }
              Ye++;
            }
            if (!He) break;
            We.repair(He);
            ke[He.id] = true;
            Be++;
            Ye++;
          }
        } else if (d) {
          for (var Fe = 0; Fe < p && Be < xe; Fe++) {
            var je = c[Fe];
            var Xe = Fe === 0 ? I : je.store[RESOURCE_ENERGY];
            if (Xe >= TOWER_ENERGY_RESERVE) {
              je.repair(Oe);
              Be++;
            }
          }
        } else if (xe > 0) {
          O.repair(Oe);
          Be = 1;
        }
        J.hitsRepaired += 800 * Be;
        if (J.hitsRepaired >= MAX_HITS_PER_TARGET) {
          J.idx = Me + 1;
          J.hitsRepaired = 0;
        } else {
          J.idx = Me;
        }
      }
    }
  }
}

module.exports = {
  run: runTowers
};
