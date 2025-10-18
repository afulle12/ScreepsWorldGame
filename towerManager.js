// towerManager.js
// Manages tower target selection, healing, and repairs with lightweight caching.

const getRoomState = require('getRoomState');
const iff = require('iff');

// Runtime-only, per-tick flags (not stored in Memory)
const runtimeTowerOnce = {}; // { [roomName]: { tick: number, repaired: boolean, healedTargets: {} } }

function runTowers() {
  if (!Memory.towerCache) Memory.towerCache = {};
  if (!Memory.towerTargets) Memory.towerTargets = {};

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    if (!Memory.towerCache[roomName]) {
      Memory.towerCache[roomName] = { towers: [], lastUpdate: 0, cacheValidUntil: 0, searchCache: {} };
    }

    var roomCache = Memory.towerCache[roomName];
    var currentTick = Game.time;

    // Initialize per-room, per-tick once-flags
    var onceFlags = runtimeTowerOnce[roomName];
    if (!onceFlags || onceFlags.tick !== currentTick) {
      onceFlags = { tick: currentTick, repaired: false, healedTargets: {} };
      runtimeTowerOnce[roomName] = onceFlags;
    }

    // Update tower cache every 50 ticks or if empty
    if (currentTick >= roomCache.cacheValidUntil || roomCache.towers.length === 0) {
      var towerObjs = [];
      if (rs.structuresByType && rs.structuresByType[STRUCTURE_TOWER]) {
        towerObjs = rs.structuresByType[STRUCTURE_TOWER].filter(function(t){ return t.my; });
      }
      roomCache.towers = towerObjs.map(function(t){ return t.id; });
      roomCache.lastUpdate = currentTick;
      roomCache.cacheValidUntil = currentTick + 50;
    }

    if (roomCache.towers.length === 0) continue;

    var towers = roomCache.towers.map(function(id){ return Game.getObjectById(id); }).filter(function(t){ return t; });
    if (towers.length === 0) continue;

    // Rotate search types; build from rs instead of room.find
    var tickMod = currentTick % 4;
    var searchResults = null;
    var searchType = null;

    if (tickMod === 0) {
      // Hostiles (still allow ally filter)
      var hostiles = rs.hostiles || [];
      searchResults = hostiles.filter(function(creep){ return iff.isHostileCreep(creep); });
      searchType = 'hostiles';
    } else if (tickMod === 1) {
      // Injured my creeps
      var injured = [];
      var myC = rs.myCreeps || [];
      for (var i1 = 0; i1 < myC.length; i1++) {
        var c = myC[i1];
        if (c.hits < c.hitsMax) injured.push(c);
      }
      searchResults = injured;
      searchType = 'injured';
    } else if (tickMod === 2) {
      // Damaged non-walls
      var damaged = [];
      if (rs.structuresByType) {
        for (var st in rs.structuresByType) {
          if (st === STRUCTURE_WALL || st === STRUCTURE_RAMPART) continue;
          var arr = rs.structuresByType[st];
          for (var ii = 0; ii < arr.length; ii++) {
            var s = arr[ii];
            if (typeof s.hits === 'number' && typeof s.hitsMax === 'number' && s.hits < s.hitsMax) {
              damaged.push(s);
            }
          }
        }
      }
      searchResults = damaged;
      searchType = 'damaged';
    } else if (tickMod === 3) {
      // Weak walls/ramparts if excess energy
      var hasExcessEnergy = false;
      for (var t = 0; t < towers.length; t++) {
        var tw = towers[t];
        if (tw.store[RESOURCE_ENERGY] > tw.store.getCapacity(RESOURCE_ENERGY) * 0.77) { hasExcessEnergy = true; break; }
      }
      if (hasExcessEnergy) {
        var walls = [];
        if (rs.structuresByType && rs.structuresByType[STRUCTURE_WALL]) {
          for (var w1 = 0; w1 < rs.structuresByType[STRUCTURE_WALL].length; w1++) {
            var wObj = rs.structuresByType[STRUCTURE_WALL][w1];
            if (wObj.hits < 500000) walls.push(wObj);
          }
        }
        if (rs.structuresByType && rs.structuresByType[STRUCTURE_RAMPART]) {
          for (var r1 = 0; r1 < rs.structuresByType[STRUCTURE_RAMPART].length; r1++) {
            var rp = rs.structuresByType[STRUCTURE_RAMPART][r1];
            if (rp.hits < 1000000) walls.push(rp);
          }
        }
        searchResults = walls;
        searchType = 'walls';
      }
    }

    if (searchResults !== null) {
      if (!roomCache.searchCache) roomCache.searchCache = {};
      roomCache.searchCache[searchType] = {
        results: searchResults.map(function(obj) {
          var rec = { id: obj.id, pos: { x: obj.pos.x, y: obj.pos.y }, hits: obj.hits, hitsMax: obj.hitsMax };
          if (searchType === 'hostiles') {
            rec.healParts = obj.getActiveBodyparts(HEAL);
            rec.attackParts = obj.getActiveBodyparts(ATTACK);
            rec.workParts = obj.getActiveBodyparts(WORK);
          }
          return rec;
        }),
        lastUpdate: currentTick,
        validUntil: currentTick + 4
      };
    }

    var cache = roomCache.searchCache || {};
    var hostileCache = cache.hostiles;
    var injuredCache = cache.injured;
    var damagedCache = cache.damaged;
    var wallsCache = cache.walls;

    var hostilesList = [];
    var healers = [];
    if (hostileCache && currentTick < hostileCache.validUntil) {
      hostilesList = hostileCache.results.map(function(data){ return Game.getObjectById(data.id); }).filter(function(o){ return o; });
      healers = hostilesList.filter(function(c){ return c.getActiveBodyparts(HEAL) > 0; });
    }

    var specialTargeting = false;
    var healerOnly = null;
    var workerAttacker = null;

    if (hostilesList.length === 2 && towers.length > 1) {
      var enemy1 = hostilesList[0];
      var enemy2 = hostilesList[1];

      if (enemy1.getActiveBodyparts(HEAL) > 0 && enemy1.getActiveBodyparts(ATTACK) === 0 &&
          enemy2.getActiveBodyparts(HEAL) === 0 &&
          (enemy2.getActiveBodyparts(WORK) > 0 || enemy2.getActiveBodyparts(ATTACK) > 0)) {
        specialTargeting = true; healerOnly = enemy1; workerAttacker = enemy2;
      } else if (enemy2.getActiveBodyparts(HEAL) > 0 && enemy2.getActiveBodyparts(ATTACK) === 0 &&
                 enemy1.getActiveBodyparts(HEAL) === 0 &&
                 (enemy1.getActiveBodyparts(WORK) > 0 || enemy1.getActiveBodyparts(ATTACK) > 0)) {
        specialTargeting = true; healerOnly = enemy2; workerAttacker = enemy1;
      }
    }

    // Pre-calculate closest targets once per room (optimization for findClosestByRange)
    var closestHealer = null;
    var closestHostile = null;
    if (!specialTargeting) {
      if (healers.length && towers.length) {
        closestHealer = towers[0].pos.findClosestByRange(healers);
      }
      if (hostilesList.length && towers.length && !closestHealer) {
        closestHostile = towers[0].pos.findClosestByRange(hostilesList);
      }
    }

    // Track if repair has been assigned this tick for this room
    var roomRepairAssigned = false;

    for (var i = 0; i < towers.length; i++) {
      var tower = towers[i];
      var mem = Memory.towerTargets[tower.id] ||
        (Memory.towerTargets[tower.id] = { targetId: null, lastHp: 0, sameHp: 0 });

      var target = null;

      if (specialTargeting) {
        target = (i % 2 === 0) ? healerOnly : workerAttacker;
      } else if (closestHealer) {
        target = closestHealer;
      } else if (closestHostile) {
        target = closestHostile;
      }

      if (target) {
        if (mem.targetId === target.id) {
          mem.sameHp = (mem.lastHp === target.hits) ? mem.sameHp + 1 : 0;
        } else {
          mem.targetId = target.id;
          mem.sameHp = 0;
        }
        mem.lastHp = target.hits;

        if (!specialTargeting && mem.sameHp >= 5) {
          var others = hostilesList.filter(function(h){ return h.id !== target.id; });
          if (others.length) {
            target = tower.pos.findClosestByRange(others);
            mem.targetId = target.id;
            mem.lastHp = target.hits;
            mem.sameHp = 0;
          }
        }

        tower.attack(target);
        continue;
      }

      mem.targetId = null;
      mem.lastHp = 0;
      mem.sameHp = 0;

      // Healing - only heal if target hasn't been healed this tick
      if (injuredCache && currentTick < injuredCache.validUntil) {
        var injuredCreeps = injuredCache.results
          .map(function(data){ return Game.getObjectById(data.id); })
          .filter(function(obj){ return obj && obj.hits < obj.hitsMax && !onceFlags.healedTargets[obj.id]; });

        if (injuredCreeps.length) {
          var healTarget = tower.pos.findClosestByRange(injuredCreeps);
          if (healTarget) {
            tower.heal(healTarget);
            onceFlags.healedTargets[healTarget.id] = true;
            continue;
          }
        }
      }

      // Damaged non-walls repair (limit to 1 tower per room per tick)
      if (!roomRepairAssigned && !onceFlags.repaired && damagedCache && currentTick < damagedCache.validUntil) {
        var damagedStructures = damagedCache.results
          .map(function(data){ return Game.getObjectById(data.id); })
          .filter(function(obj){ return obj && obj.hits < obj.hitsMax; });

        if (damagedStructures.length) {
          var weakest = damagedStructures[0];
          for (var j = 1; j < damagedStructures.length; j++) {
            if (damagedStructures[j].hits < weakest.hits) {
              weakest = damagedStructures[j];
            }
          }
          tower.repair(weakest);
          roomRepairAssigned = true;
          onceFlags.repaired = true;
          continue;
        }
      }

      // Walls/ramparts repair (also limited to 1 per room per tick)
      if (!roomRepairAssigned &&
          !onceFlags.repaired &&
          tower.store[RESOURCE_ENERGY] > tower.store.getCapacity(RESOURCE_ENERGY) * 0.77 &&
          wallsCache && currentTick < wallsCache.validUntil) {

        var walls = wallsCache.results
          .map(function(data){ return Game.getObjectById(data.id); })
          .filter(function(obj){ return obj && obj.hits < 1000000; });

        if (walls.length) {
          var weakestWall = walls[0];
          for (var k = 1; k < walls.length; k++) {
            if (walls[k].hits < weakestWall.hits) {
              weakestWall = walls[k];
            }
          }
          tower.repair(weakestWall);
          roomRepairAssigned = true;
          onceFlags.repaired = true;
          continue;
        }
      }
    }
  }
}

module.exports = {
  run: runTowers
};
