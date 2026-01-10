// towerManager.js
// Intent-first tower manager with combat short-circuit, per-room intent budgets, and cached repair targets.

const getRoomState = require('getRoomState');
const iff = require('iff');
const spawnManager = require('spawnManager');

const REPAIR_RESERVE_FRAC = 0.50;
const HEAL_RESERVE_FRAC     = 0.10;
const WALL_MAX_TARGET_HITS      = 2000000;
const RAMPART_MAX_TARGET_HITS   = 2000000;

// Optional hysteresis margins (start/stop thresholds)
const REPAIR_START_FRAC = 0.60;
const REPAIR_STOP_FRAC  = 0.45;
const HEAL_START_FRAC   = 0.15;
const HEAL_STOP_FRAC    = 0.08;

// Per-room budgets when no hostiles
const MAX_HEAL_INTENTS_PER_TICK   = 1;
const MAX_REPAIR_INTENTS_PER_TICK = 1;

// How often to rescan for a repair target if the cached one is still valid
const REPAIR_SCAN_INTERVAL = 20; // ticks
// How often to re-check if we need a supplier (to determine if we can repair walls)
const SUPPLIER_CHECK_INTERVAL = 25; // ticks

// Minimal additions to let defenses get time-slice without raising CPU:
const CONTAINER_PRIORITY_UNDER = 0.60;
const NONDEF_PRIORITY_UNDER    = 0.85;

// Run lightweight memory cleanup every 50 ticks.
function gcMemory() {
  // 1) Top-level towerTargets pruning
  if (Memory.towerTargets) {
    for (var tid in Memory.towerTargets) {
      var rec = Memory.towerTargets[tid];
      var towerObj = Game.getObjectById(tid);

      if (!towerObj || towerObj.structureType !== STRUCTURE_TOWER || !towerObj.my) {
        delete Memory.towerTargets[tid];
        continue;
      }

      var sameHpZeroOrUndef = (typeof rec === 'object') ? (typeof rec.sameHp === 'undefined' || rec.sameHp === 0) : true;
      var empty = !rec || (rec.targetId == null && rec.lastHp === 0 && rec.sameHpTicks === 0 && sameHpZeroOrUndef);
      if (empty) delete Memory.towerTargets[tid];
    }
    var anyTowerTarget = false;
    for (var k in Memory.towerTargets) { anyTowerTarget = true; break; }
    if (!anyTowerTarget) delete Memory.towerTargets;
  }

  // 2) Per-room tower sub-memory pruning
  if (Memory.rooms) {
    for (var rn in Memory.rooms) {
      var rmem = Memory.rooms[rn];
      if (!rmem || !rmem.tower) continue;

      var roomObj = Game.rooms[rn];
      if (!roomObj || !roomObj.controller || !roomObj.controller.my) {
        delete rmem.tower;
        continue;
      }

      var towersNow = roomObj.find(FIND_MY_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
      });

      if (towersNow.length === 0) {
        delete rmem.tower;
        continue;
      }

      var idSet = {};
      for (var i0 = 0; i0 < towersNow.length; i0++) idSet[towersNow[i0].id] = true;

      if (rmem.tower.healEnabledById) {
        for (var id1 in rmem.tower.healEnabledById) {
          if (!idSet[id1]) delete rmem.tower.healEnabledById[id1];
        }
      }
      if (rmem.tower.repairEnabledById) {
        for (var id2 in rmem.tower.repairEnabledById) {
          if (!idSet[id2]) delete rmem.tower.repairEnabledById[id2];
        }
      }
    }
  }
}

function runTowers() {
  if (!Memory.rooms) {
    Memory.rooms = {};
  }

  // Periodic GC
  if (Game.time % 50 === 0) gcMemory();

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var towers = [];
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_TOWER]) {
      var tArr = rs.structuresByType[STRUCTURE_TOWER];
      for (var ti = 0; ti < tArr.length; ti++) {
        if (tArr[ti].my) towers.push(tArr[ti]);
      }
    }

    // Prepare per-room memory
    var mem = Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
    if (towers.length === 0) {
      if (mem.tower) delete mem.tower;
      continue;
    }
    
    // Ensure tower memory block exists
    var tmem = mem.tower || (mem.tower = { repairTargetId: null, lastRepairScan: 0 });
    if (!tmem.healEnabledById) tmem.healEnabledById = {};
    if (!tmem.repairEnabledById) tmem.repairEnabledById = {};

    // Looser thresholds for single-tower rooms
    var singleTower = (towers.length === 1);
    var repairStart = singleTower ? 0.35 : REPAIR_START_FRAC;
    var repairStop  = singleTower ? 0.15 : REPAIR_STOP_FRAC;
    var repairReserve = singleTower ? 0.30 : REPAIR_RESERVE_FRAC;

    var healStart = singleTower ? 0.12 : HEAL_START_FRAC;
    var healStop  = singleTower ? 0.06 : HEAL_STOP_FRAC;
    var rescanInterval = singleTower ? Math.max(5, Math.floor(REPAIR_SCAN_INTERVAL / 2)) : REPAIR_SCAN_INTERVAL;

    var twoTowers = (towers.length === 2);
    if (twoTowers) {
      repairStart = 0.50;
      repairStop = 0.30;
      repairReserve = 0.45;
    }

    function hysteresisAllow(frac, start, stop, prev) {
      if (prev) return frac > stop;
      return frac >= start;
    }

    // Hostiles logic
    var hostilesList = [];
    var healers = [];
    var rawHostiles = rs.hostiles || [];
    for (var h = 0; h < rawHostiles.length; h++) {
      var hc = rawHostiles[h];
      if (!iff.isHostileCreep(hc)) continue;
      hostilesList.push(hc);
      var healParts = hc.getActiveBodyparts(HEAL) || 0;
      if (healParts > 0) healers.push(hc);
    }

    // Combat short-circuit
    if (hostilesList.length) {
      var specialTargeting = false;
      var healerOnly = null;
      var workerAttacker = null;

      if (hostilesList.length === 2 && towers.length > 1) {
        var e1 = hostilesList[0];
        var e2 = hostilesList[1];
        var e1Heal = e1.getActiveBodyparts(HEAL);
        var e1Attack = e1.getActiveBodyparts(ATTACK);
        var e1Work = e1.getActiveBodyparts(WORK);
        var e2Heal = e2.getActiveBodyparts(HEAL);
        var e2Attack = e2.getActiveBodyparts(ATTACK);
        var e2Work = e2.getActiveBodyparts(WORK);
        if (e1Heal > 0 && e1Attack === 0 && e2Heal === 0 && (e2Work > 0 || e2Attack > 0)) {
          specialTargeting = true; healerOnly = e1; workerAttacker = e2;
        } else if (e2Heal > 0 && e2Attack === 0 && e1Heal === 0 && (e1Work > 0 || e1Attack > 0)) {
          specialTargeting = true; healerOnly = e2; workerAttacker = e1;
        }
      }

      var primaryHealer = null;
      var primaryHostile = null;
      if (!specialTargeting) {
        if (healers.length) primaryHealer = towers[0].pos.findClosestByRange(healers);
        if (!primaryHealer && hostilesList.length) primaryHostile = towers[0].pos.findClosestByRange(hostilesList);
      }

      for (var i = 0; i < towers.length; i++) {
        var tower = towers[i];
        var attackTarget = null;
        if (specialTargeting) {
          attackTarget = (i % 2 === 0) ? healerOnly : workerAttacker;
        } else if (primaryHealer) {
          attackTarget = primaryHealer;
        } else if (primaryHostile) {
          attackTarget = primaryHostile;
        }
        if (attackTarget) tower.attack(attackTarget);
      }
      continue;
    }

    // No hostiles
    var healIntentsLeft = MAX_HEAL_INTENTS_PER_TICK;
    var repairIntentsLeft = MAX_REPAIR_INTENTS_PER_TICK;

    var healTarget = null;
    var minHealFrac = 1;
    var hasSupplier = false; // Track if we have a supplier spawned in the room
    var myC = rs.myCreeps || [];
    for (var i1 = 0; i1 < myC.length; i1++) {
      var c = myC[i1];
      // Check for supplier role
      if (c.memory && c.memory.role === 'supplier') {
        hasSupplier = true;
      }
      if (c.hits < c.hitsMax) {
        var fracH = c.hits / c.hitsMax;
        if (fracH < minHealFrac) { minHealFrac = fracH; healTarget = c; }
      }
    }

    // --- CHECK & CACHE: ALLOW WALL REPAIRS? ---
    // Perform check only if cache is missing or expired (every 25 ticks)
    if (typeof tmem.supplierNeeded === 'undefined' || 
        typeof tmem.lastSupplierCheck === 'undefined' || 
        (Game.time - tmem.lastSupplierCheck >= SUPPLIER_CHECK_INTERVAL)) {
        
        tmem.supplierNeeded = spawnManager.shouldSpawnSupplier(roomName);
        tmem.lastSupplierCheck = Game.time;
    }

    // If result is 1, we allow wall repairs. If 0, we do not.
    var allowWallRepairs = (tmem.supplierNeeded === 1);

    // Resolve cached repair target
    var repairTarget = null;
    if (tmem.repairTargetId) {
      repairTarget = Game.getObjectById(tmem.repairTargetId);
      
      // Validity check
      if (!repairTarget || !repairTarget.hits || repairTarget.hits >= repairTarget.hitsMax ||
          (repairTarget.structureType === STRUCTURE_WALL && repairTarget.hits >= WALL_MAX_TARGET_HITS) ||
          (repairTarget.structureType === STRUCTURE_RAMPART && repairTarget.hits >= RAMPART_MAX_TARGET_HITS)) {
        repairTarget = null;
        tmem.repairTargetId = null;
      }
      // If we disallowed walls but the cached target IS a wall, drop it.
      else if (!allowWallRepairs && (repairTarget.structureType === STRUCTURE_WALL || repairTarget.structureType === STRUCTURE_RAMPART)) {
        repairTarget = null;
        tmem.repairTargetId = null;
      }
    }

    // Scan for new targets if needed
    if (!repairTarget && (Game.time - tmem.lastRepairScan >= rescanInterval)) {
      var containerTarget = null;
      var containerRatio = 1;

      var roadTarget = null;
      var roadRatio = 1;

      var otherTarget = null;
      var otherRatio = 1;

      var rampartTarget = null;
      var rampartHits = Infinity;

      var wallTarget = null;
      var wallHits = Infinity;

      if (rs.structuresByType) {
        // First pass: non-wall / non-rampart structures
        for (var st in rs.structuresByType) {
          var arr = rs.structuresByType[st];
          for (var di = 0; di < arr.length; di++) {
            var s = arr[di];

            if (typeof s.hits !== 'number' || typeof s.hitsMax !== 'number') continue;
            if (s.hits >= s.hitsMax) continue;

            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) continue;

            var ratio = s.hitsMax > 0 ? (s.hits / s.hitsMax) : 1;

            if (s.structureType === STRUCTURE_CONTAINER) {
              // If no supplier is spawned, do not heal containers unless they are below 25% health
              if (!hasSupplier && ratio >= 0.25) continue;

              if (ratio < containerRatio) {
                containerRatio = ratio;
                containerTarget = s;
              }
            } else if (s.structureType === STRUCTURE_ROAD) {
              if (ratio < roadRatio) {
                roadRatio = ratio;
                roadTarget = s;
              }
            } else {
              if (ratio < otherRatio) {
                otherRatio = ratio;
                otherTarget = s;
              }
            }
          }
        }

        // Second pass: defensive structures (ONLY if allowed)
        if (allowWallRepairs) {
            
            // Ramparts
            if (rs.structuresByType[STRUCTURE_RAMPART]) {
              var ramps = rs.structuresByType[STRUCTURE_RAMPART];
              for (var r1 = 0; r1 < ramps.length; r1++) {
                var rp = ramps[r1];
                if (typeof rp.hits !== 'number') continue;
                if (rp.hits >= RAMPART_MAX_TARGET_HITS) continue;
    
                if (rp.hits < rampartHits) {
                  rampartHits = rp.hits;
                  rampartTarget = rp;
                }
              }
            }
    
            // Walls
            if (rs.structuresByType[STRUCTURE_WALL]) {
              var walls = rs.structuresByType[STRUCTURE_WALL];
              for (var w1 = 0; w1 < walls.length; w1++) {
                var wObj = walls[w1];
                if (typeof wObj.hits !== 'number') continue;
                if (wObj.hits >= WALL_MAX_TARGET_HITS) continue;
    
                if (wObj.hits < wallHits) {
                  wallHits = wObj.hits;
                  wallTarget = wObj;
                }
              }
            }
        }
      }

      repairTarget =
        containerTarget ||
        roadTarget ||
        otherTarget ||
        rampartTarget ||
        wallTarget ||
        null;

      tmem.repairTargetId = repairTarget ? repairTarget.id : null;
      tmem.lastRepairScan = Game.time;
    }

    // HEAL
    var healTower = null;
    if (healTarget && healIntentsLeft > 0) {
      var bestTower = null, bestDist = Infinity;
      for (var i2 = 0; i2 < towers.length; i2++) {
        var t = towers[i2];
        var energy = t.store[RESOURCE_ENERGY];
        var capacity = t.store.getCapacity(RESOURCE_ENERGY);
        var fracE = capacity > 0 ? (energy / capacity) : 0;

        var prev = !!tmem.healEnabledById[t.id];
        var enabled = hysteresisAllow(fracE, healStart, healStop, prev);
        
        if (enabled && fracE >= HEAL_RESERVE_FRAC) {
          var d = t.pos.getRangeTo(healTarget);
          if (d < bestDist) { bestDist = d; bestTower = t; }
        }
        tmem.healEnabledById[t.id] = enabled;
      }
      healTower = bestTower;
      if (healTower) {
        healTower.heal(healTarget);
        healIntentsLeft--;
      }
    }

    // REPAIR
    if (repairIntentsLeft > 0 && repairTarget) {
      var bestTower = null, bestDist = Infinity;
      for (var i3 = 0; i3 < towers.length; i3++) {
        var t = towers[i3];
        var energy = t.store[RESOURCE_ENERGY];
        var capacity = t.store.getCapacity(RESOURCE_ENERGY);
        var fracE = capacity > 0 ? (energy / capacity) : 0;

        var prev = !!tmem.repairEnabledById[t.id];
        var enabled = hysteresisAllow(fracE, repairStart, repairStop, prev);
        
        if (enabled && fracE >= repairReserve) {
          var d = t.pos.getRangeTo(repairTarget);
          if (d < bestDist) { bestDist = d; bestTower = t; }
        }
        tmem.repairEnabledById[t.id] = enabled;
      }
      if (bestTower) {
        bestTower.repair(repairTarget);
        repairIntentsLeft--;
      }
    }
  }
}

module.exports = { run: runTowers };