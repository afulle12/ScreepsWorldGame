// towerManager.js
// Optimized: Cache heal target, only re-scan when needed.

const getRoomState = require('getRoomState');
const iff = require('iff');
const spawnManager = require('spawnManager');

// RCL-indexed repair caps (exponential scaling to 20M)
// RCL:  0    1      2       3        4         5          6          7            8
var DEFENSE_MAX_BY_RCL = [
  0, 0, 10000, 50000, 200000, 1000000, 5000000, 10000000, 20000000
];

var SCAN_INTERVAL = 20;
var SUPPLIER_INTERVAL = 50;
var MAX_HITS_TARGET = 1000000;
var HEAL_SCAN_INTERVAL = 5;

var REPAIR_TYPES = [
  STRUCTURE_CONTAINER, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_SPAWN,
  STRUCTURE_STORAGE, STRUCTURE_LINK, STRUCTURE_TOWER, STRUCTURE_LAB,
  STRUCTURE_TERMINAL, STRUCTURE_RAMPART, STRUCTURE_WALL
];

// Heap cache
var heap = {
  towers: {},
  energy: {},
  heal: {},      // roomName -> { id, tick }
  rooms: null,
  roomsTick: 0
};

function getDefenseMax(room) {
  var rcl = room.controller ? room.controller.level : 0;
  return DEFENSE_MAX_BY_RCL[rcl] || 0;
}

function runTowers() {
  var tick = Game.time;

  // Room list cache
  if (!heap.rooms || tick - heap.roomsTick >= 100) {
    heap.rooms = [];
    for (var rn in Game.rooms) {
      var r = Game.rooms[rn];
      if (r.controller && r.controller.my) heap.rooms.push(rn);
    }
    heap.roomsTick = tick;
  }

  var roomList = heap.rooms;
  var rLen = roomList.length;

  for (var ri = 0; ri < rLen; ri++) {
    var roomName = roomList[ri];
    var room = Game.rooms[roomName];
    if (!room) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    // Tower cache
    var tc = heap.towers[roomName];
    if (!tc || tick - tc.tick >= 100) {
      var tArr = rs.structuresByType ? rs.structuresByType[STRUCTURE_TOWER] : null;
      var ids = [];
      if (tArr) {
        for (var i = 0; i < tArr.length; i++) {
          if (tArr[i].my) ids.push(tArr[i].id);
        }
      }
      tc = heap.towers[roomName] = { ids: ids, tick: tick };
    }

    var tIds = tc.ids;
    var tCount = tIds.length;
    if (tCount === 0) continue;

    // Resolve towers
    var towers = [];
    for (var ti = 0; ti < tCount; ti++) {
      var t = Game.getObjectById(tIds[ti]);
      if (t) towers.push(t);
    }
    tCount = towers.length;
    if (tCount === 0) continue;

    // === COMBAT (always check - highest priority) ===
    var hostiles = rs.hostiles;
    if (hostiles && hostiles.length > 0) {
      var target = null;
      var healer = null;
      for (var hi = 0; hi < hostiles.length; hi++) {
        var hc = hostiles[hi];
        if (!iff.isHostileCreep(hc)) continue;
        if (!target) target = hc;
        if (!healer && hc.getActiveBodyparts(HEAL) > 0) {
          healer = hc;
          break;
        }
      }
      var atk = healer || target;
      if (atk) {
        for (var ai = 0; ai < tCount; ai++) towers[ai].attack(atk);
        continue;
      }
    }

    // === PEACETIME ===
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    var tmem = Memory.rooms[roomName].tower;
    if (!tmem) tmem = Memory.rooms[roomName].tower = {};

    // Best tower cache (3 ticks)
    var ec = heap.energy[roomName];
    var best = null;
    var bestE = 0;
    var minE = tCount === 1 ? 100 : 300;

    if (ec && tick - ec.tick < 3 && ec.id) {
      best = Game.getObjectById(ec.id);
      if (best) bestE = best.store[RESOURCE_ENERGY];
    }

    if (!best || bestE < minE) {
      best = null;
      bestE = 0;
      for (var ei = 0; ei < tCount; ei++) {
        var tw = towers[ei];
        var e = tw.store[RESOURCE_ENERGY];
        if (e > bestE && e > minE) {
          bestE = e;
          best = tw;
        }
      }
      heap.energy[roomName] = { tick: tick, id: best ? best.id : null };
    }

    if (!best) continue;

    // === HEAL (cached target) ===
    if (bestE >= 100) {
      var hc = heap.heal[roomName];
      var healT = null;
      var needHealScan = false;

      // Validate cached heal target (CHEAP - just getObjectById + hits check)
      if (hc && hc.id) {
        healT = Game.getObjectById(hc.id);
        if (healT) {
          // Check if still needs healing
          if (healT.hits >= healT.hitsMax * 0.95) {
            healT = null;  // Healed enough, clear cache
            hc.id = null;
            needHealScan = true;
          }
        } else {
          hc.id = null;  // Creep died/left
          needHealScan = true;
        }
      }

      // Only scan for new heal target periodically
      if (!healT && (!hc || tick - hc.tick >= HEAL_SCAN_INTERVAL || needHealScan)) {
        var myC = rs.myCreeps;
        if (myC) {
          var minF = 0.9;
          for (var ci = 0; ci < myC.length; ci++) {
            var c = myC[ci];
            var cH = c.hits;
            var cM = c.hitsMax;
            if (cH < cM) {
              var f = cH / cM;
              if (f < minF) {
                minF = f;
                healT = c;
              }
            }
          }
        }
        heap.heal[roomName] = { id: healT ? healT.id : null, tick: tick };
      }

      // Execute heal
      if (healT) {
        best.heal(healT);
        bestE -= 10;
      }
    }

    // === REPAIR ===
    if (bestE < 100) continue;

    // Get RCL-based defense cap for this room
    var defenseMax = getDefenseMax(room);

    // Validate cached target
    var repT = null;
    var cid = tmem.repairTargetId;
    if (cid) {
      repT = Game.getObjectById(cid);
      if (repT) {
        var h = repT.hits;
        var m = repT.hitsMax;
        var st = repT.structureType;
        if (typeof h !== 'number' || h >= m ||
            (st === STRUCTURE_WALL && h >= defenseMax) ||
            (st === STRUCTURE_RAMPART && h >= defenseMax) ||
            (tmem.hitsRepaired || 0) >= MAX_HITS_TARGET) {
          repT = null;
          tmem.repairTargetId = null;
          tmem.hitsRepaired = 0;
        }
      } else {
        tmem.repairTargetId = null;
      }
    }

    // Scan for new target
    var ls = tmem.lastRepairScan || 0;
    if (!repT && tick - ls >= SCAN_INTERVAL) {
      var lsc = tmem.lastSupplierCheck || 0;
      if (tick - lsc >= SUPPLIER_INTERVAL) {
        tmem.supplierNeeded = spawnManager.shouldSpawnSupplier(roomName);
        tmem.lastSupplierCheck = tick;
      }
      var allowW = (tmem.supplierNeeded === 1);

      var myC = rs.myCreeps;
      var hasSup = false;
      if (myC) {
        for (var si = 0; si < myC.length; si++) {
          var cm = myC[si].memory;
          if (cm && cm.role === 'supplier') { hasSup = true; break; }
        }
      }

      var sbt = rs.structuresByType;
      if (sbt) {
        var bT = null;
        var bP = 999;
        var bV = Infinity;

        for (var sti = 0; sti < REPAIR_TYPES.length; sti++) {
          var sType = REPAIR_TYPES[sti];
          var arr = sbt[sType];
          if (!arr) continue;

          var isW = (sType === STRUCTURE_WALL);
          var isR = (sType === STRUCTURE_RAMPART);
          var isD = isW || isR;

          if (isD && !allowW) continue;
          if (bT && bP < 9 && isD) break;

          for (var di = 0; di < arr.length; di++) {
            var s = arr[di];
            var sH = s.hits;
            if (typeof sH !== 'number') continue;
            var sM = s.hitsMax;
            if (sH >= sM) continue;
            if (isW && sH >= defenseMax) continue;
            if (isR && sH >= defenseMax) continue;

            var v = isD ? sH : (sM > 0 ? sH / sM : 1);
            if (sType === STRUCTURE_CONTAINER && !hasSup && v >= 0.25) continue;

            // Use shared priority (10) for walls and ramparts so they compete by hits
            var pri = isD ? 10 : sti;
            if (pri < bP || (pri === bP && v < bV)) {
              bP = pri;
              bV = v;
              bT = s;
            }
          }
        }

        repT = bT;
        tmem.repairTargetId = repT ? repT.id : null;
        tmem.hitsRepaired = 0;
      }
      tmem.lastRepairScan = tick;
    }

    if (repT) {
      best.repair(repT);
      tmem.hitsRepaired = (tmem.hitsRepaired || 0) + 600;
    }
  }
}

module.exports = { run: runTowers };