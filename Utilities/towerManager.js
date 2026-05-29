// towerManager.js
// Optimized: Repair state machine (scan->repair->scan), heap-cached queues,
// per-room state, heal scan every 5 ticks, hostiles every tick.
// Default: 1 tower, 1 peacetime action, every 2 ticks (heal > urgent > queue).
// Unleash mode: set Memory.towers[roomName] = 1 to have ALL towers fire EVERY
// tick for all peacetime actions (heal, urgent, queue).
// Combat always uses all towers every tick regardless of unleash state.
//
// Repair queue priority (most damaged first within each tier):
//   1. Containers
//   2. Roads
//   3. Buildings (extensions, spawns, storage, links, towers, labs, terminals)
//   4. Generic walls/ramparts under 1M (emergency)
//   5. Ramparts protecting critical buildings under 10.5M minimum
//   6. All remaining walls/ramparts (up to defenseMax)

// Enable for one room:
//Memory.towers['W1N1'] = 1;

// Disable:
//delete Memory.towers['W1N1'];


const getRoomState = require('getRoomState');
const iff = require('iff');
const spawnManager = require('spawnManager');

// RCL-indexed repair caps (exponential scaling to 20M)
// RCL:  0    1      2       3        4         5          6          7           8
var DEFENSE_MAX_BY_RCL = [
  0, 0, 10000, 50000, 200000, 1000000, 1000000, 1000000, 1000000
];

var SUPPLIER_INTERVAL = 50;
var HEAL_SCAN_INTERVAL = 5;
var SCAN_COOLDOWN = 20;

// How many hits the queue-repair tower spends on one target before advancing.
var MAX_HITS_PER_TARGET = 50000;

// Rescan the repair queue periodically even when it isn't exhausted,
// so newly-damaged structures (container decay, road wear) get picked up.
var REPAIR_RESCAN_INTERVAL = 150;

// Minimum energy a tower must hold before it will perform any peacetime
// action (heal, urgent repair, queue repair).  Keeps a combat reserve so
// towers are never caught empty when hostiles appear.
var TOWER_ENERGY_RESERVE = 350;

// Structures below this fraction of hitsMax are treated as urgent and
// repaired outside the normal queue (containers, roads, etc.).
var URGENT_FRACTION = 0.5;

// Containers specifically get an even more generous urgency check because
// they decay steadily and are critical infrastructure.
var CONTAINER_URGENT_FRACTION = 0.20;

// Generic walls/ramparts below this are treated as emergency (pri 4),
// jumping ahead of critical rampart minimum enforcement.
var GENERIC_DEFENSE_LOW = 1000000; // 1M

// Ramparts covering critical buildings are maintained to at least this level.
// They get pri 5 until this minimum is met (or defenseMax, whichever is lower).
var CRITICAL_RAMPART_MIN = 10500000; // 10.5M

// Structure types considered critical — ramparts on these get boosted priority.
var CRITICAL_STRUCTURE_TYPES = [
  STRUCTURE_SPAWN, STRUCTURE_TERMINAL, STRUCTURE_NUKER, STRUCTURE_STORAGE, 
  STRUCTURE_LAB, STRUCTURE_TOWER, STRUCTURE_FACTORY
];

var REPAIR_TYPES = [
  STRUCTURE_CONTAINER, STRUCTURE_EXTENSION, STRUCTURE_SPAWN,
  STRUCTURE_STORAGE, STRUCTURE_LINK, STRUCTURE_TOWER, STRUCTURE_LAB,
  STRUCTURE_TERMINAL, STRUCTURE_RAMPART, STRUCTURE_WALL//, STRUCTURE_ROAD
];

// NEW: Small helper to detect border positions
function isBorderPos(pos) {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

// Non-defense structure types that can become urgent
var URGENT_TYPES = [
  STRUCTURE_CONTAINER, STRUCTURE_EXTENSION, STRUCTURE_SPAWN,
  STRUCTURE_STORAGE, STRUCTURE_LINK, STRUCTURE_TOWER, STRUCTURE_LAB,
  STRUCTURE_TERMINAL//, STRUCTURE_ROAD
];

// Heap cache (survives ticks, clears on global reset)
var heap = {
  towers: {},
  energy: {},
  heal: {},
  repair: {},          // roomName -> { queue, idx, hitsRepaired, scanTick }
  urgent: {},          // roomName -> { tick, targets: [id, ...] }
  criticalRamparts: {}, // roomName -> { tick, set: { rampartId: true } }
  towerState: {},      // roomName -> { repairState, nextScanTick, 
                       // supplierNeeded, lastSupplierCheck }
  rooms: null,
  roomsTick: 0
};

function getDefenseMax(room) {
  var rcl = room.controller ? room.controller.level : 0;
  return DEFENSE_MAX_BY_RCL[rcl] || 0;
}

// Returns true if the creep has only 1 body part (e.g. a bare 1-MOVE scout).
// A single tower one-shots it regardless of distance, so there's no need to
// pile on additional towers.
function isLowThreatCreep(creep) {
  return creep.getActiveBodyparts(HEAL) === 0 &&
         creep.getActiveBodyparts(WORK) === 0 &&
         creep.getActiveBodyparts(ATTACK) === 0 &&
         creep.getActiveBodyparts(RANGED_ATTACK) === 0;
         creep.getActiveBodyparts(CLAIM) === 0;
}

// Assigns towers to a prioritised list of targets efficiently.
// Targets with only 1 body part get exactly 1 tower; all others absorb all
// remaining towers. Towers are consumed in descending energy order (already
// sorted before this is called).
//
// targets  – array of creep objects, highest priority first
// towers   – array of tower objects, highest energy first
function assignTowersToTargets(targets, towers) {
  var towerIdx = 0;
  var tCount = towers.length;

  for (var ti = 0; ti < targets.length && towerIdx < tCount; ti++) {
    var target = targets[ti];
    if (isLowThreatCreep(target)) {
      // 1 tower is enough to one-shot this creep
      towers[towerIdx].attack(target);
      towerIdx++;
    } else {
      // Give all remaining towers to this target
      for (; towerIdx < tCount; towerIdx++) {
        towers[towerIdx].attack(target);
      }
    }
  }
}

// ── Critical rampart detection ──
function isCriticalRampart(rampart, roomName, rs) {
  var tick = Game.time;
  var cc = heap.criticalRamparts[roomName];

  if (!cc || tick - cc.tick >= 500) {
    var critTiles = {};
    var sbt = rs.structuresByType;
    if (sbt) {
      for (var ci = 0; ci < CRITICAL_STRUCTURE_TYPES.length; ci++) {
        var arr = sbt[CRITICAL_STRUCTURE_TYPES[ci]];
        if (!arr) continue;
        for (var si = 0; si < arr.length; si++) {
          try {
            var s = arr[si];
            critTiles[s.pos.x + ',' + s.pos.y] = true;
          } catch (e) { /* stale object, skip */ }
        }
      }
    }

    var set = {};
    var ramps = sbt ? sbt[STRUCTURE_RAMPART] : null;
    if (ramps) {
      for (var ri = 0; ri < ramps.length; ri++) {
        try {
          var rmp = ramps[ri];
          if (critTiles[rmp.pos.x + ',' + rmp.pos.y]) {
            set[rmp.id] = true;
          }
        } catch (e) { /* stale object, skip */ }
      }
    }

    cc = heap.criticalRamparts[roomName] = { tick: tick, set: set };
  }

  return !!cc.set[rampart.id];
}

// ── Urgent scan: find critically damaged non-defense structures ──
function getUrgentTargets(roomName, rs, tick) {
  var uc = heap.urgent[roomName];

  if (uc && tick - uc.tick < 3) {
    var valid = [];
    for (var i = 0; i < uc.targets.length; i++) {
      var obj = Game.getObjectById(uc.targets[i]);
      if (obj && obj.hits < obj.hitsMax) valid.push(uc.targets[i]);
    }
    uc.targets = valid;
    return valid;
  }

  var sbt = rs.structuresByType;
  var targets = [];
  if (!sbt) {
    heap.urgent[roomName] = { tick: tick, targets: targets };
    return targets;
  }

  for (var ui = 0; ui < URGENT_TYPES.length; ui++) {
    var sType = URGENT_TYPES[ui];
    var arr = sbt[sType];
    if (!arr) continue;

    var thresh = (sType === STRUCTURE_CONTAINER)
      ? CONTAINER_URGENT_FRACTION
      : URGENT_FRACTION;

    for (var si = 0; si < arr.length; si++) {
      try {
        var s = arr[si];
        if (typeof s.hits !== 'number') continue;
        if (s.hitsMax > 0 && s.hits / s.hitsMax < thresh) {
          targets.push(s.id);
        }
      } catch (e) { /* stale/destroyed object, skip */ }
    }
  }

  targets.sort(function(a, b) {
    var sa = Game.getObjectById(a);
    var sb = Game.getObjectById(b);
    if (!sa) return 1;
    if (!sb) return -1;
    return (sa.hits / sa.hitsMax) - (sb.hits / sb.hitsMax);
  });

  heap.urgent[roomName] = { tick: tick, targets: targets };
  return targets;
}


function runTowers() {
  var tick = Game.time;

  // Room list cache (refresh every 100 ticks)
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

    // Tower cache (refresh every 100 ticks)
    var tc = heap.towers[roomName];
    if (!tc || tick - tc.tick >= 100) {
      var tArr = rs.structuresByType ? rs.structuresByType[STRUCTURE_TOWER] : null;
      var ids = [];
      if (tArr) {
        for (var i = 0; i < tArr.length; i++) {
          try {
            if (tArr[i].my) ids.push(tArr[i].id);
          } catch (e) { /* stale tower ref, skip */ }
        }
      }
      tc = heap.towers[roomName] = { ids: ids, tick: tick };
    }

    var tIds = tc.ids;
    var tCount = tIds.length;
    if (tCount === 0) continue;

    // Resolve towers and sort by energy descending
    var towers = [];
    for (var ti = 0; ti < tCount; ti++) {
      var t = Game.getObjectById(tIds[ti]);
      if (t) towers.push(t);
    }
    towers.sort(function(a, b) {
      return b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY];
    });
    tCount = towers.length;
    if (tCount === 0) continue;

    // === COMBAT (all towers, every tick — highest priority) ===
    var hostiles = rs.hostiles;
    if (hostiles && hostiles.length > 0) {
      // Filter to confirmed hostiles
      var confirmed = [];
      for (var hi = 0; hi < hostiles.length; hi++) {
        try {
          if (iff.isHostileCreep(hostiles[hi])) confirmed.push(hostiles[hi]);
        } catch (e) { /* stale hostile ref, skip */ }
      }

      if (confirmed.length > 0) {
        // Check for 2-creep healer split: one healer + one non-healer
        var healer = null;
        var nonHealer = null;
        if (confirmed.length === 2) {
          var h0 = confirmed[0].getActiveBodyparts(HEAL) > 0;
          var h1 = confirmed[1].getActiveBodyparts(HEAL) > 0;
          if (h0 && !h1) {
            healer = confirmed[0];
            nonHealer = confirmed[1];
          } else if (!h0 && h1) {
            healer = confirmed[1];
            nonHealer = confirmed[0];
          }
        }

        if (healer && nonHealer && tCount >= 2) {
          // Split: healer is highest priority; non-healer gets leftover towers.
          // assignTowersToTargets handles the 1-part optimisation on both.
          assignTowersToTargets([healer, nonHealer], towers);
        } else {
          // Sort confirmed by priority: healers first, then ranged, then work (dismantlers),
        // then melee, then other. Within the same priority, lower hits first (closest to dead).
        confirmed.sort(function(a, b) {
          var pa = a.getActiveBodyparts(HEAL) > 0 ? 2
                 : a.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3
                 : a.getActiveBodyparts(WORK) > 0 ? 1
                 : a.getActiveBodyparts(ATTACK) > 0 ? 4
                 : 5;
          var pb = b.getActiveBodyparts(HEAL) > 0 ? 2
                 : b.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3
                 : b.getActiveBodyparts(WORK) > 0 ? 1
                 : b.getActiveBodyparts(ATTACK) > 0 ? 4
                 : 5;
          return pa !== pb ? pa - pb : a.hits - b.hits;
        });
          assignTowersToTargets(confirmed, towers);
        }
        continue;
      }
    }

    // === PEACETIME ===
    if (!Memory.towers) Memory.towers = {};
    var unleashed = !!Memory.towers[roomName];

    var tmem = heap.towerState[roomName];
    if (!tmem) tmem = heap.towerState[roomName] = {};

    // Non-unleashed: 1 tower, 1 action, every 3 ticks
    if (!unleashed && tick % 3 !== 0) continue;

    var primary = towers[0];
    var primaryE = primary.store[RESOURCE_ENERGY];
    if (primaryE < TOWER_ENERGY_RESERVE) continue;

    // === HEAL ===
    if (primaryE >= TOWER_ENERGY_RESERVE) {
      var hCache = heap.heal[roomName];
      var healT = null;
      var needHealScan = false;

      if (hCache && hCache.id) {
        healT = Game.getObjectById(hCache.id);
        if (healT) {
          if (healT.hits >= healT.hitsMax * 0.95) {
            healT = null;
            hCache.id = null;
            needHealScan = true;
          }
        } else {
          hCache.id = null;
          needHealScan = true;
        }
      }

      // ── CHANGED: Border-aware heal scan ──
      if (!healT && (!hCache || tick - hCache.tick >= HEAL_SCAN_INTERVAL || needHealScan)) {
        var myC = rs.myCreeps;
        if (myC) {
          var bestNonBorder = null, bestNonBorderF = 0.9;
          var bestBorder    = null, bestBorderF    = 0.9;
          for (var ci = 0; ci < myC.length; ci++) {
            try {
              var c = myC[ci];
              if (c.hits < c.hitsMax) {
                var f = c.hits / c.hitsMax;
                if (isBorderPos(c.pos)) {
                  if (f < bestBorderF) { bestBorderF = f; bestBorder = c; }
                } else {
                  if (f < bestNonBorderF) { bestNonBorderF = f; bestNonBorder = c; }
                }
              }
            } catch (e) { /* stale creep ref, skip */ }
          }
          healT = bestNonBorder || bestBorder;
        }
        heap.heal[roomName] = { id: healT ? healT.id : null, tick: tick };
      }

      if (healT) {
        primary.heal(healT);
        primaryE -= 10;
        if (!unleashed) continue;
      }
    }

    // === URGENT REPAIR ===
    var urgentTargets = getUrgentTargets(roomName, rs, tick);
    if (urgentTargets.length > 0) {
      if (unleashed) {
        var urgIdx = 0;
        for (var ui = 0; ui < tCount && urgIdx < urgentTargets.length; ui++) {
          var tw = towers[ui];
          var twE = tw.store[RESOURCE_ENERGY];
          if (ui === 0) twE = primaryE;
          if (twE < TOWER_ENERGY_RESERVE) continue;

          var urgTarget = Game.getObjectById(urgentTargets[urgIdx]);
          if (urgTarget && urgTarget.hits < urgTarget.hitsMax) {
            tw.repair(urgTarget);
            if (ui === 0) primaryE -= 10;
            if (urgTarget.hitsMax > 0 &&
                urgTarget.hits / urgTarget.hitsMax < URGENT_FRACTION * 0.5) {
            } else {
              urgIdx++;
            }
          } else {
            urgIdx++;
            ui--;
          }
        }
        if (primaryE < TOWER_ENERGY_RESERVE) continue;
      } else {
        var urgTarget = Game.getObjectById(urgentTargets[0]);
        if (urgTarget && urgTarget.hits < urgTarget.hitsMax && primaryE >= TOWER_ENERGY_RESERVE) {
          primary.repair(urgTarget);
          continue;
        }
      }
    }

    // === QUEUE-BASED REPAIR STATE MACHINE ===
    if (primaryE < TOWER_ENERGY_RESERVE) continue;

    var state = tmem.repairState || 'scan';
    var rp = heap.repair[roomName];

    if (state === 'repair' && rp && rp.scanTick &&
        tick - rp.scanTick >= REPAIR_RESCAN_INTERVAL) {
      state = 'scan';
      tmem.repairState = 'scan';
    }

    if (state === 'scan') {
      if (tmem.nextScanTick && tick < tmem.nextScanTick) continue;

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
          try {
            var cm = myC[si].memory;
            if (cm && cm.role === 'supplier') { hasSup = true; break; }
          } catch (e) { /* stale creep, skip */ }
        }
      }

      var defenseMax = getDefenseMax(room);
      var critMin = Math.min(CRITICAL_RAMPART_MIN, defenseMax);
      var sbt = rs.structuresByType;
      var queue = [];

      // ── Priority tiers (most damaged first within each tier) ──
      //   1 = Containers
      //   2 = Roads
      //   3 = Buildings
      //   4 = Generic walls/ramparts under 1M (emergency)
      //   5 = Critical ramparts under 10.5M (minimum enforcement)
      //   6 = All remaining walls/ramparts (up to defenseMax)

      if (sbt) {
        for (var sti = 0; sti < REPAIR_TYPES.length; sti++) {
          var sType = REPAIR_TYPES[sti];
          var arr = sbt[sType];
          if (!arr) continue;

          var isW = (sType === STRUCTURE_WALL);
          var isR = (sType === STRUCTURE_RAMPART);
          var isD = isW || isR;
          if (isD && !allowW) continue;

          for (var di = 0; di < arr.length; di++) {
            try {
              var s = arr[di];
              var sH = s.hits;
              if (typeof sH !== 'number') continue;
              var sM = s.hitsMax;
              if (sH >= sM) continue;
              if (isD && sH >= defenseMax) continue;

              var v = isD ? sH : (sM > 0 ? sH / sM : 1);

              if (sType === STRUCTURE_CONTAINER) {
                if (sH >= 50000) continue;
              }

              var pri;
              if (sType === STRUCTURE_CONTAINER) {
                pri = 1;
              } else if (sType === STRUCTURE_ROAD) {
                pri = 2;
              } else if (!isD) {
                // Buildings (extension, spawn, storage, link, tower, lab, terminal)
                pri = 3;
              } else {
                // Defense structure (wall or rampart)
                var isCrit = isR && isCriticalRampart(s, roomName, rs);
                if (!isCrit && sH < GENERIC_DEFENSE_LOW) {
                  // Generic wall/rampart under 1M — emergency
                  pri = 4;
                } else if (isCrit && sH < critMin) {
                  // Critical rampart below 10.5M minimum
                  pri = 5;
                } else {
                  // Everything else up to defenseMax
                  pri = 6;
                }
              }

              // Tag each entry with the border flag
              queue.push({ id: s.id, pri: pri, val: v, border: isBorderPos(s.pos) ? 1 : 0 });
            } catch (e) { /* stale/destroyed structure, skip */ }
          }
        }

        // Slot border between pri and val in sort
        queue.sort(function(a, b) {
          if (a.pri !== b.pri)       return a.pri - b.pri;
          if (a.border !== b.border) return a.border - b.border;
          return a.val - b.val;
        });
      }

      rp = heap.repair[roomName] = {
        queue: queue, idx: 0, hitsRepaired: 0, scanTick: tick
      };
      tmem.repairState = 'repair';
      tmem.nextScanTick = null;
      state = 'repair';
    }

    if (state === 'repair') {
      if (!rp) {
        tmem.repairState = 'scan';
        continue;
      }

      var q = rp.queue;
      var qi = rp.idx;
      var repT = null;
      var defenseMax = getDefenseMax(room);

      while (q && qi < q.length) {
        var candidate = Game.getObjectById(q[qi].id);
        if (candidate && candidate.hits < candidate.hitsMax) {
          var cst = candidate.structureType;
          if ((cst === STRUCTURE_WALL || cst === STRUCTURE_RAMPART)
              && candidate.hits >= defenseMax) {
            qi++; continue;
          }
          repT = candidate;
          break;
        }
        qi++;
      }

      if (!repT) {
        tmem.repairState = 'scan';
        tmem.nextScanTick = tick + SCAN_COOLDOWN;
        heap.repair[roomName] = null;
      } else {
        var repCount = 0;

        if (unleashed) {
          for (var rti = 0; rti < tCount; rti++) {
            var rtw = towers[rti];
            var rtE = (rti === 0) ? primaryE : rtw.store[RESOURCE_ENERGY];
            if (rtE >= TOWER_ENERGY_RESERVE) {
              rtw.repair(repT);
              repCount++;
            }
          }
        } else {
          primary.repair(repT);
          repCount = 1;
        }

        rp.hitsRepaired += 800 * repCount;

        if (rp.hitsRepaired >= MAX_HITS_PER_TARGET) {
          rp.idx = qi + 1;
          rp.hitsRepaired = 0;
        } else {
          rp.idx = qi;
        }
      }
    }
  }
}

module.exports = { run: runTowers };
