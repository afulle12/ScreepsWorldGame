// LLM: Read docs/codex.js before reviewing or changing this file.
// defenseMonitor.js
//   defenseMonitor.run()  -> call once per tick from main loop
var getRoomState = require("getRoomState");
var iff = require("iff");
var DAMAGE_THRESHOLD = 5;
var MAX_DEFENSE_REPAIRS = 2;
var NOTIFY_COOLDOWN = 200;
var CLUSTER_RANGE = 1;
var EVENT_MEMORY_TTL = 300;
var NUKE_SCAN_INTERVAL = 100;
var NUKE_BLAST_RADIUS = 2;
var NUKE_MILESTONE_TICKS = [ 1e4, 1e3 ];
function ensureMemory() {
  if (!Memory.defense) Memory.defense = {};
  if (!Memory.defense.knownHostiles) Memory.defense.knownHostiles = {};
  if (!Memory.defense.damageEvents) Memory.defense.damageEvents = {};
  if (!Memory.defense.repairOrders) Memory.defense.repairOrders = {};
  if (!Memory.defense.notifyCooldown) Memory.defense.notifyCooldown = {};
  if (!Memory.defense.clusterCache) Memory.defense.clusterCache = {};
  if (!Memory.defense.trackedNukes) Memory.defense.trackedNukes = {};
}

function detectEnemyEntry(e, r) {
  var t = Game.rooms[e];
  if (!t) return;
  var n = r.hostiles || [];
  var a = [];
  for (var o = 0; o < n.length; o++) {
    var i = n[o].owner ? n[o].owner.username : null;
    if (i === "Invader" || i === "Source Keeper") continue;
    if (!iff.isHostileCreep(n[o])) continue;
    a.push(n[o]);
  }
  n = a;
  var s = {};
  for (var u = 0; u < n.length; u++) {
    s[n[u].id] = n[u];
  }
  var f = Memory.defense.knownHostiles[e] || [];
  var l = {};
  for (var m = 0; m < f.length; m++) {
    l[f[m]] = true;
  }
  var v = [];
  for (var d in s) {
    if (!s.hasOwnProperty(d)) continue;
    if (!l[d]) {
      v.push(s[d]);
    }
  }
  var c = [];
  for (var g in s) {
    if (s.hasOwnProperty(g)) c.push(g);
  }
  Memory.defense.knownHostiles[e] = c;
  if (v.length > 0) {
    var y = Memory.defense.notifyCooldown[e] || 0;
    if (Game.time >= y) {
      var h = [];
      var E = false;
      for (var p = 0; p < v.length; p++) {
        var R = v[p];
        var T = R.owner && R.owner.username ? R.owner.username : "unknown";
        var C = [];
        if (R.body) {
          var S = {};
          for (var N = 0; N < R.body.length; N++) {
            var A = R.body[N].type;
            if (!S[A]) S[A] = 0;
            S[A]++;
          }
          for (var M in S) {
            if (S.hasOwnProperty(M)) {
              C.push(S[M] + "x" + M);
            }
          }
          if (!(R.body.length === 1 && R.body[0].type === MOVE)) {
            E = true;
          }
        }
        h.push(T + " (" + C.join(", ") + ") at " + R.pos);
      }
      var _ = "[DEFENSE] Enemy creep(s) entered " + e + ": " + h.join(" | ");
      console.log(_);
      if (E) {
        Game.notify(_, 0);
        Memory.defense.notifyCooldown[e] = Game.time + NOTIFY_COOLDOWN;
      }
    }
  }
  for (var U = 0; U < n.length; U++) {
    var O = n[U];
    if (!O.body) continue;
    var L = false;
    for (var G = 0; G < O.body.length; G++) {
      if (O.body[G].type === WORK) {
        L = true;
        break;
      }
    }
    if (L) {
      var k = Memory.defense.notifyCooldown[e + "_dismantle"] || 0;
      if (Game.time >= k) {
        var I = O.owner && O.owner.username ? O.owner.username : "unknown";
        var w = "[DEFENSE] WARNING: Dismantler detected in " + e + " owned by " + I + " at " + O.pos;
        console.log(w);
        Game.notify(w, 0);
        Memory.defense.notifyCooldown[e + "_dismantle"] = Game.time + NOTIFY_COOLDOWN;
      }
      break;
    }
  }
}

function trackDamageEvents(e) {
  var r = Game.rooms[e];
  if (!r) return;
  var t;
  try {
    t = r.getEventLog();
  } catch (e) {
    return;
  }
  if (!t || t.length === 0) return;
  if (!Memory.defense.damageEvents[e]) {
    Memory.defense.damageEvents[e] = {};
  }
  var n = Memory.defense.damageEvents[e];
  for (var a = 0; a < t.length; a++) {
    var o = t[a];
    if (o.event !== EVENT_ATTACK) continue;
    var i = o.data.targetId;
    if (!i) continue;
    var s = Game.getObjectById(i);
    if (!s) continue;
    if (s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART) continue;
    var u = o.objectId;
    var f = Game.getObjectById(u);
    if (!f) continue;
    if (f.my) continue;
    var l = f.owner ? f.owner.username : null;
    if (l === "Invader" || l === "Source Keeper") continue;
    if (!iff.isHostileCreep(f)) continue;
    if (!n[i]) {
      n[i] = {
        count: 0,
        firstTick: Game.time,
        lastTick: Game.time,
        damage: 0
      };
    }
    n[i].count++;
    n[i].lastTick = Game.time;
    n[i].damage += o.data.damage || 0;
    if (n[i].count === 1) {
      var m = "[DEFENSE] " + s.structureType + " at " + s.pos + " in " + e + " is under attack by " + l + " (damage: " + (o.data.damage || 0) + ")";
      console.log(m);
      Game.notify(m, 5);
    }
  }
  for (var v in n) {
    if (!n.hasOwnProperty(v)) continue;
    if (Game.time - n[v].lastTick > EVENT_MEMORY_TTL) {
      delete n[v];
    }
  }
}

function analyzeNukeImpact(e, r) {
  var t = [];
  var n = [];
  var a = e.lookForAt(LOOK_STRUCTURES, r.x, r.y);
  for (var o = 0; o < a.length; o++) {
    t.push({
      type: a[o].structureType,
      hits: a[o].hits,
      id: a[o].id
    });
  }
  for (var i = -NUKE_BLAST_RADIUS; i <= NUKE_BLAST_RADIUS; i++) {
    for (var s = -NUKE_BLAST_RADIUS; s <= NUKE_BLAST_RADIUS; s++) {
      if (i === 0 && s === 0) continue;
      var u = r.x + i;
      var f = r.y + s;
      if (u < 0 || u > 49 || f < 0 || f > 49) continue;
      var l = e.lookForAt(LOOK_STRUCTURES, u, f);
      for (var m = 0; m < l.length; m++) {
        n.push({
          type: l[m].structureType,
          hits: l[m].hits,
          id: l[m].id
        });
      }
    }
  }
  return {
    groundZero: t,
    splash: n
  };
}

function formatEta(e) {
  var r = e * 4;
  var t = Math.floor(r / 3600);
  var n = Math.floor(r % 3600 / 60);
  if (t > 0) {
    return t + "h " + n + "m (~" + e + " ticks)";
  }
  return n + "m (~" + e + " ticks)";
}

function buildImpactSummary(e) {
  var r = {};
  function countList(e, t) {
    for (var n = 0; n < e.length; n++) {
      var a = e[n].type;
      if (!r[a]) r[a] = {
        gz: 0,
        splash: 0
      };
      r[a][t]++;
    }
  }
  countList(e.groundZero, "gz");
  countList(e.splash, "splash");
  var t = [];
  for (var n in r) {
    if (!r.hasOwnProperty(n)) continue;
    var a = r[n];
    var o = n;
    if (a.gz > 0 && a.splash > 0) {
      o += " (" + a.gz + " direct, " + a.splash + " splash)";
    } else if (a.gz > 0) {
      o += " (" + a.gz + " direct hit)";
    } else {
      o += " (" + a.splash + " splash)";
    }
    t.push(o);
  }
  if (t.length === 0) return "No structures in blast zone";
  return t.join(", ");
}

function detectNukes() {
  var e = Memory.defense.trackedNukes;
  for (var r in e) {
    if (e.hasOwnProperty(r)) {
      e[r]._seen = false;
    }
  }
  var t = getRoomState.ownedNames();
  for (var n = 0; n < t.length; n++) {
    var a = t[n];
    var o = Game.rooms[a];
    if (!o) continue;
    var i = o.find(FIND_NUKES);
    if (!i || i.length === 0) continue;
    for (var s = 0; s < i.length; s++) {
      var u = i[s];
      var f = u.id;
      if (e[f]) {
        e[f]._seen = true;
        var l = u.timeToLand;
        var m = e[f].milestones || {};
        for (var v = 0; v < NUKE_MILESTONE_TICKS.length; v++) {
          var d = NUKE_MILESTONE_TICKS[v];
          if (l <= d && !m[d]) {
            m[d] = Game.time;
            var c = "[NUKE WARNING] Nuke inbound to " + a + " at (" + u.pos.x + "," + u.pos.y + ")" + " — " + formatEta(l) + " remaining!" + " Launched from: " + u.launchRoomName;
            console.log(c);
            Game.notify(c, 0);
          }
        }
        e[f].milestones = m;
        continue;
      }
      var g = analyzeNukeImpact(o, u.pos);
      var y = buildImpactSummary(g);
      e[f] = {
        roomName: a,
        pos: {
          x: u.pos.x,
          y: u.pos.y
        },
        launchRoom: u.launchRoomName,
        landTick: Game.time + u.timeToLand,
        notifiedAt: Game.time,
        milestones: {},
        _seen: true
      };
      var h = "[NUKE ALERT] Incoming nuke detected in " + a + "!\n" + "  Impact: (" + u.pos.x + "," + u.pos.y + ")\n" + "  Launched from: " + u.launchRoomName + "\n" + "  ETA: " + formatEta(u.timeToLand) + "\n" + "  Threatened structures: " + y;
      console.log(h);
      Game.notify(h, 0);
    }
  }
  for (var E in e) {
    if (!e.hasOwnProperty(E)) continue;
    if (!e[E]._seen) {
      var p = e[E];
      var R = "[NUKE] Nuke in " + p.roomName + " at (" + p.pos.x + "," + p.pos.y + ")" + " from " + p.launchRoom + " has landed or expired.";
      console.log(R);
      Game.notify(R, 0);
      delete e[E];
    } else {
      delete e[E]._seen;
    }
  }
}

function findContiguousCluster(e, r) {
  var t = Game.getObjectById(e);
  if (!t) return [];
  var n = {};
  var a = [];
  var o = [ t ];
  n[t.id] = true;
  while (o.length > 0) {
    var i = o.shift();
    a.push(i.id);
    var s = i.pos.x;
    var u = i.pos.y;
    for (var f = -CLUSTER_RANGE; f <= CLUSTER_RANGE; f++) {
      for (var l = -CLUSTER_RANGE; l <= CLUSTER_RANGE; l++) {
        if (f === 0 && l === 0) continue;
        var m = s + f;
        var v = u + l;
        if (m < 0 || m > 49 || v < 0 || v > 49) continue;
        var d = r.lookForAt(LOOK_STRUCTURES, m, v);
        for (var c = 0; c < d.length; c++) {
          var g = d[c];
          if (n[g.id]) continue;
          if (g.structureType !== STRUCTURE_WALL && g.structureType !== STRUCTURE_RAMPART) continue;
          n[g.id] = true;
          o.push(g);
        }
      }
    }
  }
  return a;
}

function getAllClusters(e) {
  var r = Memory.defense.clusterCache[e];
  if (r) {
    return r.clusters;
  }
  var t = Game.rooms[e];
  if (!t) return [];
  var n = getRoomState.get(e);
  if (!n || !n.structuresByType) return [];
  var a = [];
  var o = n.structuresByType[STRUCTURE_WALL] || [];
  var i = n.structuresByType[STRUCTURE_RAMPART] || [];
  for (var s = 0; s < o.length; s++) a.push(o[s]);
  for (var u = 0; u < i.length; u++) a.push(i[u]);
  if (a.length === 0) return [];
  var f = {};
  var l = [];
  for (var m = 0; m < a.length; m++) {
    var v = a[m];
    if (f[v.id]) continue;
    var d = [];
    var c = [ v ];
    f[v.id] = true;
    while (c.length > 0) {
      var g = c.shift();
      d.push(g.id);
      var y = g.pos.x;
      var h = g.pos.y;
      for (var E = -CLUSTER_RANGE; E <= CLUSTER_RANGE; E++) {
        for (var p = -CLUSTER_RANGE; p <= CLUSTER_RANGE; p++) {
          if (E === 0 && p === 0) continue;
          var R = y + E;
          var T = h + p;
          if (R < 0 || R > 49 || T < 0 || T > 49) continue;
          var C = t.lookForAt(LOOK_STRUCTURES, R, T);
          for (var S = 0; S < C.length; S++) {
            var N = C[S];
            if (f[N.id]) continue;
            if (N.structureType !== STRUCTURE_WALL && N.structureType !== STRUCTURE_RAMPART) continue;
            f[N.id] = true;
            c.push(N);
          }
        }
      }
    }
    l.push({
      ids: d
    });
  }
  Memory.defense.clusterCache[e] = {
    clusters: l
  };
  return l;
}

function clearClusterCache(e) {
  delete Memory.defense.clusterCache[e];
}

function getClusterMinHits(e) {
  var r = Infinity;
  var t = null;
  for (var n = 0; n < e.length; n++) {
    var a = Game.getObjectById(e[n]);
    if (!a) continue;
    if (typeof a.hits !== "number") continue;
    if (a.hits < r) {
      r = a.hits;
      t = a.id;
    }
  }
  return {
    minHits: r,
    minId: t
  };
}

function getRoomMedianHits(e) {
  var r = getRoomState.get(e);
  if (!r || !r.structuresByType) return 0;
  var t = [];
  var n = r.structuresByType[STRUCTURE_WALL] || [];
  var a = r.structuresByType[STRUCTURE_RAMPART] || [];
  for (var o = 0; o < n.length; o++) {
    if (typeof n[o].hits === "number") {
      t.push(n[o].hits);
    }
  }
  for (var i = 0; i < a.length; i++) {
    if (typeof a[i].hits === "number") {
      t.push(a[i].hits);
    }
  }
  if (t.length === 0) return 0;
  if (t.length === 1) return t[0];
  t.sort(function(e, r) {
    return e - r;
  });
  var s = Math.floor(t.length / 2);
  if (t.length % 2 === 0) {
    return Math.floor((t[s - 1] + t[s]) / 2);
  } else {
    return t[s];
  }
}

function findClusterContaining(e, r) {
  for (var t = 0; t < r.length; t++) {
    if (r[t].ids.indexOf(e) !== -1) {
      return r[t];
    }
  }
  return null;
}

function isWeakestCluster(e, r) {
  if (!e || !r || r.length === 0) return false;
  if (r.length === 1) return true;
  var t = getClusterMinHits(e);
  for (var n = 0; n < r.length; n++) {
    var a = r[n];
    if (a.ids[0] === e[0]) continue;
    var o = getClusterMinHits(a.ids);
    if (o.minHits < t.minHits) return false;
  }
  return true;
}

function evaluateRepairOrders(e) {
  var r = Memory.defense.damageEvents[e];
  if (!Memory.defense.repairOrders[e]) {
    Memory.defense.repairOrders[e] = [];
  }
  var t = Memory.defense.repairOrders[e];
  var n = Game.rooms[e];
  if (!n) return;
  var a = false;
  if (r) {
    for (var o in r) {
      if (r.hasOwnProperty(o) && r[o].count >= DAMAGE_THRESHOLD) {
        a = true;
        break;
      }
    }
  }
  var i = t.length > 0;
  if (!a && !i) {
    clearClusterCache(e);
    return;
  }
  var s = 0;
  var u = getRoomState.creepIndex();
  var f = u && u.all ? u.all : [];
  for (var l = 0; l < f.length; l++) {
    var m = f[l];
    if (!m.memory) continue;
    if (m.memory.role === "defenseRepair" && m.memory.homeRoom === e) {
      s++;
    }
  }
  var v = getRoomState.get(e);
  if (v && v.structuresByType && v.structuresByType[STRUCTURE_SPAWN]) {
    for (var d = 0; d < v.structuresByType[STRUCTURE_SPAWN].length; d++) {
      var c = v.structuresByType[STRUCTURE_SPAWN][d];
      if (c.my && c.spawning) {
        var g = Memory.creeps[c.spawning.name];
        if (g && g.role === "defenseRepair" && g.homeRoom === e) {
          s++;
        }
      }
    }
  }
  var y = getAllClusters(e);
  if (y.length === 0) return;
  if (r) {
    for (var h in r) {
      if (!r.hasOwnProperty(h)) continue;
      var E = r[h];
      if (E.count < DAMAGE_THRESHOLD) continue;
      if (s >= MAX_DEFENSE_REPAIRS) continue;
      var p = false;
      for (var R = 0; R < t.length; R++) {
        if (t[R].clusterIds && t[R].clusterIds.indexOf(h) !== -1) {
          p = true;
          break;
        }
      }
      if (p) continue;
      var T = findClusterContaining(h, y);
      if (!T) {
        var C = findContiguousCluster(h, n);
        if (C.length === 0) continue;
        T = {
          ids: C
        };
      }
      var S = T.ids.length === 1;
      var N = getClusterMinHits(T.ids);
      if (S) {
        var A = getRoomMedianHits(e);
        if (N.minHits >= A) {
          console.log("[DefenseMonitor] Solo structure in " + e + " (hits: " + N.minHits + ") is at or above median (" + A + "). Clearing alert.");
          delete r[h];
          continue;
        }
      } else {
        if (!isWeakestCluster(T.ids, y)) {
          console.log("[DefenseMonitor] Damaged cluster in " + e + " (minHits: " + N.minHits + ") is NOT the weakest section. Clearing alert.");
          delete r[h];
          continue;
        }
      }
      var M = {
        clusterId: T.ids[0],
        clusterIds: T.ids,
        solo: S,
        assignedCreep: null,
        createdAt: Game.time
      };
      t.push(M);
      s++;
      var _ = S ? "solo (target: median)" : "weakest cluster";
      var U = "[DEFENSE] Repair order created in " + e + " — " + _ + " (minHits: " + N.minHits + ", " + T.ids.length + " structures). " + "Damage events: " + E.count + ", total damage: " + E.damage;
      console.log(U);
      Game.notify(U, 5);
      delete r[h];
    }
  }
  for (var O = t.length - 1; O >= 0; O--) {
    var L = t[O];
    if (L.assignedCreep && !Game.creeps[L.assignedCreep]) {
      L.assignedCreep = null;
      var G = false;
      if (L.solo) {
        var k = Game.getObjectById(L.clusterId);
        var I = getRoomMedianHits(e);
        if (k && typeof k.hits === "number" && k.hits < I) {
          G = true;
        }
      } else {
        if (isWeakestCluster(L.clusterIds, y)) {
          G = true;
        }
      }
      if (!G) {
        console.log("[DefenseMonitor] Repair order in " + e + " no longer needed. Removing.");
        t.splice(O, 1);
        continue;
      }
    }
    if (!L.assignedCreep && Game.time - L.createdAt > 500) {
      t.splice(O, 1);
    }
  }
  if (t.length === 0) {
    clearClusterCache(e);
  }
}

function run() {
  ensureMemory();
  var e = getRoomState.ownedNames();
  for (var r = 0; r < e.length; r++) {
    var t = e[r];
    var n = getRoomState.get(t);
    var a = Game.rooms[t];
    if (!a || !n) continue;
    var o = n.hostiles ? n.hostiles.length : 0;
    var i = Memory.defense.knownHostiles[t] && Memory.defense.knownHostiles[t].length > 0;
    if (o > 0 || i || Game.time % 7 === 0) {
      detectEnemyEntry(t, n);
    }
    trackDamageEvents(t);
    if (Game.time % 3 === 0) {
      evaluateRepairOrders(t);
    }
  }
  if (Game.time % NUKE_SCAN_INTERVAL === 0) {
    detectNukes();
  }
}

module.exports = {
  run: run,
  getAllClusters: getAllClusters,
  clearClusterCache: clearClusterCache,
  getClusterMinHits: getClusterMinHits,
  getRoomMedianHits: getRoomMedianHits,
  isWeakestCluster: isWeakestCluster,
  findClusterContaining: findClusterContaining,
  findContiguousCluster: findContiguousCluster,
  detectNukes: detectNukes,
  analyzeNukeImpact: analyzeNukeImpact,
  DAMAGE_THRESHOLD: DAMAGE_THRESHOLD,
  MAX_DEFENSE_REPAIRS: MAX_DEFENSE_REPAIRS
};
