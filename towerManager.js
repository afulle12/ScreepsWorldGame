// towerManager.js
// Intent-first tower manager: minimizes expensive tower intents, uses runtime caching, adds repair/heal budgets and hysteresis.

const getRoomState = require('getRoomState');
const iff = require('iff');

// Runtime-only, per-tick flags (not stored in Memory)
const runtimeTowerOnce = {}; // { [roomName]: { tick, repaired, healedTargets: {}, healCount } }

// Runtime multi-tick state (not serialized to Memory)
const runtimeTowerState = {}; // { [roomName]: { searchCache, lastHostileTick, wallRepairActive, lastRepairTick } }

// Intent-budgeting and hysteresis config
const REPAIR_COOLDOWN_TICKS = 10;            // Minimum ticks between any repair intent in a room
const HOSTILE_SUPPRESS_REPAIR_TICKS = 5;     // Suppress repairs for X ticks after hostiles seen
const HEAL_BUDGET_PER_ROOM = 1;              // Max heals per room per tick
const WALL_REPAIR_START_THRESHOLD = 0.90;    // Start walls/ramparts repair when all towers >= 90% energy
const WALL_REPAIR_STOP_THRESHOLD = 0.85;     // Stop when any tower drops below 85% energy
const WALL_MAX_TARGET_HITS = 500000;         // Cap for walls
const RAMPART_MAX_TARGET_HITS = 1000000;     // Cap for ramparts

function runTowers() {
  if (!Memory.towerCache) Memory.towerCache = {};
  if (!Memory.towerTargets) Memory.towerTargets = {};

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    if (!Memory.towerCache[roomName]) {
      Memory.towerCache[roomName] = { towers: [], lastUpdate: 0, cacheValidUntil: 0 };
    }

    var roomCache = Memory.towerCache[roomName];
    var currentTick = Game.time;

    // Per-tick flags
    var onceFlags = runtimeTowerOnce[roomName];
    if (!onceFlags || onceFlags.tick !== currentTick) {
      onceFlags = { tick: currentTick, repaired: false, healedTargets: {}, healCount: 0 };
      runtimeTowerOnce[roomName] = onceFlags;
    }

    // Multi-tick runtime state
    var rt = runtimeTowerState[roomName];
    if (!rt) {
      rt = { searchCache: {}, lastHostileTick: 0, wallRepairActive: false, lastRepairTick: 0 };
      runtimeTowerState[roomName] = rt;
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

    // Hysteresis for wall/rampart repair based on tower energy
    var minEnergyFrac = 1;
    for (var ti = 0; ti < towers.length; ti++) {
      var frac = towers[ti].store[RESOURCE_ENERGY] / towers[ti].store.getCapacity(RESOURCE_ENERGY);
      if (frac < minEnergyFrac) minEnergyFrac = frac;
    }
    if (rt.wallRepairActive) {
      if (minEnergyFrac < WALL_REPAIR_STOP_THRESHOLD) {
        rt.wallRepairActive = false;
      }
    } else {
      if (minEnergyFrac >= WALL_REPAIR_START_THRESHOLD) {
        rt.wallRepairActive = true;
      }
    }

    // Rotate search types; store in runtime cache (not in Memory)
    var tickMod = currentTick % 4;
    var searchType = null;
    var searchResults = null;

    if (tickMod === 0) {
      // Hostiles (still allow ally filter)
      var hostiles = rs.hostiles || [];
      searchResults = hostiles.filter(function(creep){ return iff.isHostileCreep(creep); });
      searchType = 'hostiles';
      if (searchResults.length > 0) {
        rt.lastHostileTick = currentTick;
      }
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
      // Damaged non-walls, exclude roads
      var damaged = [];
      if (rs.structuresByType) {
        for (var st in rs.structuresByType) {
          // Skip walls, ramparts, and roads
          if (st === STRUCTURE_WALL || st === STRUCTURE_RAMPART || st === STRUCTURE_ROAD) continue;
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
    } else {
      // Weak walls/ramparts if hysteresis says active
      if (rt.wallRepairActive) {
        var walls = [];
        if (rs.structuresByType && rs.structuresByType[STRUCTURE_WALL]) {
          for (var w1 = 0; w1 < rs.structuresByType[STRUCTURE_WALL].length; w1++) {
            var wObj = rs.structuresByType[STRUCTURE_WALL][w1];
            if (wObj.hits < WALL_MAX_TARGET_HITS) walls.push(wObj);
          }
        }
        if (rs.structuresByType && rs.structuresByType[STRUCTURE_RAMPART]) {
          for (var r1 = 0; r1 < rs.structuresByType[STRUCTURE_RAMPART].length; r1++) {
            var rp = rs.structuresByType[STRUCTURE_RAMPART][r1];
            if (rp.hits < RAMPART_MAX_TARGET_HITS) walls.push(rp);
          }
        }
        searchResults = walls;
        searchType = 'walls';
      }
    }

    if (searchResults !== null) {
      if (!rt.searchCache) rt.searchCache = {};
      rt.searchCache[searchType] = {
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

    // Prepare mapped lists once per room
    var cache = rt.searchCache || {};
    var hostilesCache = cache.hostiles;
    var injuredCache = cache.injured;
    var damagedCache = cache.damaged;
    var wallsCache = cache.walls;

    var hostilesList = [];
    var hostileInfoById = {};
    var healers = [];

    if (hostilesCache && currentTick < hostilesCache.validUntil) {
      for (var h = 0; h < hostilesCache.results.length; h++) {
        var data = hostilesCache.results[h];
        var obj = Game.getObjectById(data.id);
        if (!obj) continue;
        hostilesList.push(obj);
        hostileInfoById[data.id] = { heal: data.healParts, attack: data.attackParts, work: data.workParts };
      }
      for (var hl = 0; hl < hostilesList.length; hl++) {
        var c = hostilesList[hl];
        var info = hostileInfoById[c.id];
        if (info && info.heal > 0) healers.push(c);
      }
    }

    var injuredList = [];
    if (injuredCache && currentTick < injuredCache.validUntil) {
      for (var ic = 0; ic < injuredCache.results.length; ic++) {
        var d = injuredCache.results[ic];
        var o = Game.getObjectById(d.id);
        if (o && o.hits < o.hitsMax && !onceFlags.healedTargets[o.id]) {
          injuredList.push(o);
        }
      }
    }

    var damagedList = [];
    if (damagedCache && currentTick < damagedCache.validUntil) {
      for (var dc = 0; dc < damagedCache.results.length; dc++) {
        var dd = damagedCache.results[dc];
        var oo = Game.getObjectById(dd.id);
        // Ensure roads are never considered even if present in cache
        if (oo && oo.hits < oo.hitsMax && oo.structureType !== STRUCTURE_ROAD) {
          damagedList.push(oo);
        }
      }
    }

    var wallsList = [];
    if (wallsCache && currentTick < wallsCache.validUntil) {
      for (var wc = 0; wc < wallsCache.results.length; wc++) {
        var wd = wallsCache.results[wc];
        var wo = Game.getObjectById(wd.id);
        if (wo) {
          if (wo.structureType === STRUCTURE_WALL && wo.hits < WALL_MAX_TARGET_HITS) {
            wallsList.push(wo);
          } else if (wo.structureType === STRUCTURE_RAMPART && wo.hits < RAMPART_MAX_TARGET_HITS) {
            wallsList.push(wo);
          }
        }
      }
    }

    // Special targeting pairs
    var specialTargeting = false;
    var healerOnly = null;
    var workerAttacker = null;

    if (hostilesList.length === 2 && towers.length > 1) {
      var enemy1 = hostilesList[0];
      var enemy2 = hostilesList[1];
      var info1 = hostileInfoById[enemy1.id] || { heal: enemy1.getActiveBodyparts(HEAL), attack: enemy1.getActiveBodyparts(ATTACK), work: enemy1.getActiveBodyparts(WORK) };
      var info2 = hostileInfoById[enemy2.id] || { heal: enemy2.getActiveBodyparts(HEAL), attack: enemy2.getActiveBodyparts(ATTACK), work: enemy2.getActiveBodyparts(WORK) };

      if (info1.heal > 0 && info1.attack === 0 && info2.heal === 0 && (info2.work > 0 || info2.attack > 0)) {
        specialTargeting = true; healerOnly = enemy1; workerAttacker = enemy2;
      } else if (info2.heal > 0 && info2.attack === 0 && info1.heal === 0 && (info1.work > 0 || info1.attack > 0)) {
        specialTargeting = true; healerOnly = enemy2; workerAttacker = enemy1;
      }
    }

    // Pre-calc closest targets once
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

    // Budgets and suppression
    var recentHostiles = (currentTick - rt.lastHostileTick) <= HOSTILE_SUPPRESS_REPAIR_TICKS;
    var canRepairThisTick = (!recentHostiles) && (currentTick - rt.lastRepairTick >= REPAIR_COOLDOWN_TICKS);
    var roomRepairAssigned = false;

    // Tower loop
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
          var others = [];
          for (var oi = 0; oi < hostilesList.length; oi++) {
            var hobj = hostilesList[oi];
            if (hobj.id !== target.id) others.push(hobj);
          }
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

      // Healing budget: max one heal per room per tick
      if (injuredList.length && onceFlags.healCount < HEAL_BUDGET_PER_ROOM) {
        var healTarget = tower.pos.findClosestByRange(injuredList);
        if (healTarget) {
          tower.heal(healTarget);
          onceFlags.healedTargets[healTarget.id] = true;
          onceFlags.healCount++;
          continue;
        }
      }

      // Non-wall repair: cooldown-based and single intent per room (roads excluded)
      if (!roomRepairAssigned && canRepairThisTick && damagedList.length) {
        var weakest = damagedList[0];
        for (var j = 1; j < damagedList.length; j++) {
          if (damagedList[j].hits < weakest.hits) {
            weakest = damagedList[j];
          }
        }
        tower.repair(weakest);
        roomRepairAssigned = true;
        onceFlags.repaired = true;
        rt.lastRepairTick = currentTick;
        continue;
      }

      // Walls/ramparts repair: hysteresis, cooldown, single intent per room
      if (!roomRepairAssigned && canRepairThisTick && rt.wallRepairActive && wallsList.length) {
        var weakestWall = wallsList[0];
        for (var k = 1; k < wallsList.length; k++) {
          if (wallsList[k].hits < weakestWall.hits) {
            weakestWall = wallsList[k];
          }
        }
        tower.repair(weakestWall);
        roomRepairAssigned = true;
        onceFlags.repaired = true;
        rt.lastRepairTick = currentTick;
        continue;
      }
    }
  }
}

module.exports = {
  run: runTowers
};
