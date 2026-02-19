// spawnManager.js
// ============================================================================
// Spawn Manager
// Centralizes all spawn-related logic pulled from main.js.
// Updated to use getRoomState (Live Objects) instead of Memory.roomData
// ============================================================================
// To spawn 2 upgraders in a room
// doubleUpgrade('ROOMNAME', true) to enable doubleUpgrade('ROOM_NAME', false) to disable


const getRoomState = require('getRoomState');
const towerDrain = require('roleTowerDrain');


// --- CONSTANTS ---
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER = [TOUGH, MOVE, RANGED_ATTACK];
const SCOUT_BODY = [MOVE, MOVE, MOVE, MOVE, MOVE];
const SCAVENGER_BODY = [MOVE, CARRY, CARRY, MOVE];
const MAINTAINER_BODY = [WORK, CARRY, CARRY, MOVE]; // Fixed body for maintainer

const LOW_RCL_SPAWN_DELAY_TICKS = 300;
const RCL8_UPGRADER_SPAWN_DELAY_TICKS = 5000;

// ============================================================================
// Console Commands
// ============================================================================

global.doubleUpgrade = function(roomName, enable) {
  if (!Memory.doubleUpgradeRooms) { Memory.doubleUpgradeRooms = {}; }

  if (enable) {
    var room = Game.rooms[roomName];
    if (room && room.controller && room.controller.level >= 8) {
      return "Command Rejected: Room " + roomName + " is RCL 8. Double upgrade only allowed for RCL 7 and lower.";
    }
    Memory.doubleUpgradeRooms[roomName] = true;
    return "Double Upgrade ENABLED for " + roomName + ". Max Upgraders: 2 (Active only if RCL <= 7).";
  } else {
    if (Memory.doubleUpgradeRooms[roomName]) {
      delete Memory.doubleUpgradeRooms[roomName];
    }
    return "Double Upgrade DISABLED for " + roomName + ". Max Upgraders: 1.";
  }
};

// ============================================================================
// Helper / utility (local to spawn module)
// ============================================================================

function bodyCost(body) {
  const BODYPART_COST = {
    move: 50, work: 100, attack: 80, carry: 50, heal: 250,
    ranged_attack: 150, tough: 10, claim: 600
  };
  return body.reduce(function(cost, part){ return cost + BODYPART_COST[part]; }, 0);
}

function getCreepBody(role, energy) {
  if (role === 'labBot') {
    var pairs = Math.min(20, Math.floor(energy / 100));
    if (pairs <= 0) return null;
    var b = [];
    for (var i = 0; i < pairs; i++) b.push(CARRY);
    for (var j = 0; j < pairs; j++) b.push(MOVE);
    return b;
  }

  // --- Maintainer Body ---
  if (role === 'maintainer') {
      return MAINTAINER_BODY;
  }

  if (role === 'attacker') {
    const costPerSet = 390;
    const numSets = Math.min(16, Math.floor(energy / costPerSet));
    if (numSets > 0) {
      const body = [];
      for (let i = 0; i < numSets; i++) body.push(TOUGH, MOVE, ATTACK, HEAL);
      return body;
    } else {
      if (energy >= 130) return [TOUGH, MOVE, ATTACK];
      else if (energy >= 80) return [ATTACK];
      else return null;
    }
  }

  const bodyConfigs = {
    // --- SQUAD (QUAD) CONFIGURATION ---
    quad: {
      1300: [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1800: [TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2300: [TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      5000: [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    powerBot: {
      300: [CARRY, CARRY, MOVE, MOVE],
      500: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
      800: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1600: [CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, 
             MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE]
    },
    upgrader: {
      200:  [WORK, CARRY, MOVE],
      300:  [WORK, WORK, CARRY, MOVE],
      500:  [WORK, WORK, WORK, WORK, CARRY, MOVE],
      550:  [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
      800:  [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE],
      1100: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
      1300: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1800: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2300: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2800: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      3300: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      3600: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    builder: {
      300: [WORK, CARRY, CARRY, MOVE, MOVE],
      400: [WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
      550: [WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE], 
      800: [WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE], 
      1300:[WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1800:[WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    remoteBuilder: {
      300: [WORK, CARRY, CARRY, MOVE, MOVE],
      400: [WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
      550: [WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE], 
      800: [WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE], 
      1300:[WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1800:[WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    wallRepair: {
      300: [WORK, CARRY, CARRY, MOVE, MOVE],
      400: [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
      450: [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
      550: [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
      750: [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
      900:  [WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE],
      1100: [WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      1300: [WORK,WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      1500: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      1800: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      2000: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      2300: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      2500: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      3000: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK, CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE]
    },
    defender: {
      300: BASIC_DEFENDER,
      460: [TOUGH, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE],
      670: [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE],
      880: [TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    supplier: {
      200: [CARRY, CARRY, MOVE, MOVE],
      300: [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
      400: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
      600: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      900: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1000:[CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1200:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      1400:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      1600:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      1800:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      2000:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      2200:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      2400:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE]
    },
    scout: { 300: SCOUT_BODY }
  };

  if (role === 'scout') return SCOUT_BODY;
  if (energy <= 300 && role !== 'defender' && role !== 'supplier' && role !== 'powerBot' && role !== 'remoteBuilder' && role !== 'quad' && role !== 'maintainer') return BASIC_HARVESTER;

  const configs = bodyConfigs[role] || bodyConfigs.harvester;
  return getBestBody(configs, energy);

  function getBestBody(bodyTiers, availableEnergy) {
    const tiers = Object.keys(bodyTiers).map(Number).sort(function(a, b){ return a - b; });
    let bestTier = tiers[0];
    for (var i = 0; i < tiers.length; i++) {
      var tier = tiers[i];
      if (availableEnergy >= tier) bestTier = tier;
      else break;
    }
    return bodyTiers[bestTier];
  }
}

// ============================================================================
// Harvester specialized helpers
// ============================================================================

if (!Memory.sourceMeta) Memory.sourceMeta = {};

/**
 * Builds/refreshes the sourceMeta cache for a room.
 * SLIMMED DOWN: Only stores pos and range (the fields actually used).
 * Removed: id (redundant key), nearestSpawnId (never read), harvestPositions (never read)
 */
function ensureSourceMetaCache(room) {
  if (!room || !room.controller || !room.controller.my) return null;

  var roomName = room.name;
  var meta = Memory.sourceMeta[roomName];
  var needsScan = !meta || !meta.lastScan || (Game.time - meta.lastScan >= 10000);
  if (!needsScan) return meta;

  var rs = getRoomState.get(roomName);
  if (!rs) return meta;

  var sources = rs.sources || [];

  var spawns = [];
  if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
      var s = rs.structuresByType[STRUCTURE_SPAWN][i];
      if (s.my) spawns.push(s);
    }
  }

  var byId = {};

  for (var si = 0; si < sources.length; si++) {
    var src = sources[si];
    if (!src || !src.pos) continue;

    // Find closest spawn (only need distance for body sizing)
    var bestRange = Infinity;
    for (var sp = 0; sp < spawns.length; sp++) {
      var r = spawns[sp].pos.getRangeTo(src.pos);
      if (r < bestRange) {
        bestRange = r;
      }
    }

    // Store only what's actually used
    byId[src.id] = {
      pos: { x: src.pos.x, y: src.pos.y, roomName: roomName },
      range: bestRange < Infinity ? bestRange : null
    };
  }

  Memory.sourceMeta[roomName] = { lastScan: Game.time, byId: byId };
  return Memory.sourceMeta[roomName];
}

function costOf(part) {
  switch (part) {
    case MOVE: return 50;
    case WORK: return 100;
    case CARRY: return 50;
    case ATTACK: return 80;
    case RANGED_ATTACK: return 150;
    case HEAL: return 250;
    case TOUGH: return 10;
    case CLAIM: return 600;
    default: return 0;
  }
}

function buildExtractorBody(energyAvailable) {
  var setCost = costOf(WORK) + costOf(WORK) + costOf(MOVE);
  if (energyAvailable < setCost) return null;

  var maxSetsByParts = Math.floor(48 / 3);
  var setsByEnergy = Math.floor(energyAvailable / setCost);
  var sets = Math.min(maxSetsByParts, setsByEnergy);
  if (sets <= 0) return null;

  var body = [];
  for (var i = 0; i < sets; i++) {
    body.push(WORK, WORK, MOVE);
  }
  return body;
}

function manageNukeFillSpawns() {
  if (!Memory.nukeFillOrders) return;

  for (var roomName in Memory.nukeFillOrders) {
    var order = Memory.nukeFillOrders[roomName];
    if (!order || order.completed) continue;

    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var nuker = null;
    if (order.nukerId) nuker = Game.getObjectById(order.nukerId);
    if (!nuker && rs.structuresByType && rs.structuresByType[STRUCTURE_NUKER] && rs.structuresByType[STRUCTURE_NUKER].length > 0) {
      nuker = rs.structuresByType[STRUCTURE_NUKER][0];
      order.nukerId = nuker.id;
    }
    if (!nuker) continue;

    var exists = _.some(Game.creeps, function(c) {
      if (!c || !c.memory) return false;
      if (c.memory.role !== 'nukeFill') return false;
      var assigned = c.memory.orderRoom || c.memory.homeRoom || (c.room ? c.room.name : null);
      return assigned === roomName;
    });
    if (exists) continue;

    var freeSpawn = null;
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = getCreepBody('supplier', freeSpawn.room.energyAvailable);
    if (!body) continue;

    var name = 'NukeFill_' + roomName + '_' + (Game.time % 1000);
    var mem  = {
      role: 'nukeFill',
      homeRoom: roomName,
      orderRoom: roomName,
      nukerId: order.nukerId,
      phase: order.phase
    };

    var cost = bodyCost(body);
    var res = freeSpawn.spawnCreep(body, name, { memory: mem });
    if (res === OK) {
      console.log('[NukeFill] Spawning ' + name + ' in ' + roomName + ' | Parts: ' + body.length + ' | Cost: ' + cost);
    } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[NukeFill] Failed to spawn in ' + roomName + ': ' + res);
    }
  }
}


function buildHarvesterBodyForDistance(distance, energyBudget) {
  if (energyBudget < 200) return null;

  var body  = [];
  var cost  = 0;
  var parts = 0;

  function canAdd(part) {
    return (parts + 1 <= 50) && (cost + costOf(part) <= energyBudget);
  }
  function add(part) {
    body.push(part);
    cost += costOf(part);
    parts++;
  }
  function removePart(part) {
    for (var i = body.length - 1; i >= 0; i--) {
      if (body[i] === part) {
        body.splice(i, 1);
        cost -= costOf(part);
        parts--;
        if (part === WORK) workCount--;
        else if (part === CARRY) carryCount--;
        else if (part === MOVE) moveCount--;
        return true;
      }
    }
    return false;
  }

  function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b !== 0) {
      var t = b;
      b = a % b;
      a = t;
    }
    return a;
  }
  function lcm(a, b) {
    if (a === 0 || b === 0) return 0;
    return Math.abs(a * b) / gcd(a, b);
  }
  function carryNeededFor(workCount) {
    var twoW = workCount * 2;
    if (twoW === 0) return 0;
    return lcm(50, twoW) / 50;
  }

  var maxWork      = 15;
  var workCount    = 0;
  var carryCount = 0;
  var moveCount    = 0;

  function rebalanceCarry() {
    if (workCount === 0) return;
    var safety = 0;
    while (safety < 100) {
      safety++;
      var required = carryNeededFor(workCount);
      if (carryCount >= required) break;
      if (canAdd(CARRY)) {
        add(CARRY);
        carryCount++;
        continue;
      }
      var removed = removePart(WORK);
      if (!removed) break; 
    }
  }

  function ensureBaseline() {
    if (carryCount === 0) {
      if (canAdd(CARRY)) {
        add(CARRY); carryCount++;
      } else if (removePart(WORK)) {
        if (canAdd(CARRY)) { add(CARRY); carryCount++; }
      } else if (removePart(MOVE)) {
        if (canAdd(CARRY)) { add(CARRY); carryCount++; }
      }
    }
    if (moveCount === 0) {
      if (canAdd(MOVE)) {
        add(MOVE); moveCount++;
      } else if (removePart(WORK)) {
        if (canAdd(MOVE)) { add(MOVE); moveCount++; }
      } else {
        var carrySeen = 0;
        for (var i = 0; i < body.length; i++) {
          if (body[i] === CARRY) carrySeen++;
        }
        if (carrySeen > 1 && removePart(CARRY)) {
          if (canAdd(MOVE)) { add(MOVE); moveCount++; }
        }
      }
    }
  }

  if (distance < 4) {
    while (workCount < maxWork && canAdd(WORK)) {
      add(WORK); workCount++;
    }
    var neededCarry = carryNeededFor(workCount);
    while (carryCount < neededCarry && canAdd(CARRY)) {
      add(CARRY); carryCount++;
    }
    if (canAdd(MOVE)) { add(MOVE); moveCount++; }
    rebalanceCarry();
    ensureBaseline();
    return body;
  }

  if (distance > 25) {
    while (
      (parts + 2 <= 50) &&
      (cost + costOf(MOVE) + costOf(WORK) <= energyBudget) &&
      workCount < maxWork
    ) {
      add(MOVE); moveCount++;
      add(WORK); workCount++;
    }
    var neededCarryFar = carryNeededFor(workCount);
    while (carryCount < neededCarryFar && canAdd(CARRY)) {
      add(CARRY); carryCount++;
    }
    rebalanceCarry();
    ensureBaseline();
    return body;
  }

  while (workCount < maxWork && canAdd(WORK)) {
    add(WORK);
    workCount++;
    if (workCount % 3 === 0 && canAdd(MOVE)) {
      add(MOVE);
      moveCount++;
    }
  }

  var neededCarryMid = carryNeededFor(workCount);
  while (carryCount < neededCarryMid && canAdd(CARRY)) {
    add(CARRY); carryCount++;
  }

  if (moveCount === 0 && canAdd(MOVE)) {
    add(MOVE); moveCount++;
  }

  rebalanceCarry();
  ensureBaseline();
  return body;
}

// ============================================================================
// Spawn functions (grouped)
// ============================================================================

function manageHarvesterSpawns() {
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var storageEnergy = 0;
    var rs = getRoomState.get(roomName);
    var storage = rs ? rs.storage : null;
    if (storage && storage.store) {
      storageEnergy = storage.store[RESOURCE_ENERGY] || 0;
    }

    if (storageEnergy >= 700000) continue;

    var meta = ensureSourceMetaCache(room);
    if (!meta || !meta.byId) continue;

    var availableSpawns = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      availableSpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){
        return s.my && !s.spawning;
      });
    }
    if (availableSpawns.length === 0) continue;

    var perSourceCounts = {};
    for (var sid in meta.byId) perSourceCounts[sid] = 0;

    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.role !== 'harvester') continue;
      var assignedRoom = c.memory.homeRoom || c.memory.assignedRoom || (c.room ? c.room.name : null);
      if (assignedRoom !== room.name) continue;
      if (c.memory.sourceId && perSourceCounts[c.memory.sourceId] !== undefined) {
        perSourceCounts[c.memory.sourceId]++;
      }
    }

    var needsHarvester = [];
    for (var sourceId in meta.byId) {
      var count = perSourceCounts[sourceId] || 0;
      if (count === 0) {
        needsHarvester.push({
          id: sourceId,
          meta: meta.byId[sourceId],
          range: meta.byId[sourceId].range || 9999
        });
      }
    }
    if (needsHarvester.length === 0) continue;

    needsHarvester.sort(function(a, b) { return a.range - b.range; });

    var sourceToSpawn = needsHarvester[0];
    var smeta = sourceToSpawn.meta;
    var sourcePos = new RoomPosition(smeta.pos.x, smeta.pos.y, smeta.pos.roomName);

    // Find closest available spawn to this source
    var spawn = null;
    var bestSpawnRange = Infinity;
    for (var si = 0; si < availableSpawns.length; si++) {
      var sp = availableSpawns[si];
      var r = sp.pos.getRangeTo(sourcePos);
      if (r < bestSpawnRange) {
        bestSpawnRange = r;
        spawn = sp;
      }
    }
    if (!spawn) continue;

    var distance = bestSpawnRange < Infinity ? bestSpawnRange : (smeta.range || 10);
    var energyBudget = spawn.room.energyAvailable;
    var body = buildHarvesterBodyForDistance(distance, energyBudget);
    if (!body) continue;

    var shortId = sourceToSpawn.id.slice(-6);
    var hName = 'H_' + roomName + '_' + shortId + '_' + Game.time;
    var memory = {
      role: 'harvester',
      assignedRoom: room.name,
      homeRoom: room.name,
      sourceId: sourceToSpawn.id
    };

    var cost = bodyCost(body);
    var res = spawn.spawnCreep(body, hName, { memory: memory });

    if (res === OK) {
      console.log(
        "Spawning harvester in " + room.name +
        " for source " + shortId +
        " (distFromSpawn: " + distance + ") | Parts: " + body.length +
        " | Cost: " + cost
      );
    } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("Failed to spawn harvester in " + room.name + " for " + shortId + ": " + res);
    }
  }
}

function spawnEmergencyHarvester(room, spawn) {
  if (!room || !spawn) return false;
  var meta = ensureSourceMetaCache(room);
  if (!meta || !meta.byId) return false;

  var pickSid = null;
  var bestRange = Infinity;
  for (var sid in meta.byId) {
    var r = meta.byId[sid].range || 9999;
    if (r < bestRange) {
      bestRange = r;
      pickSid = sid;
    }
  }
  if (!pickSid) return false;

  var smeta = meta.byId[pickSid];
  var distance = smeta.range || 10;
  var body = [WORK, CARRY, MOVE];

  var shortId = pickSid.slice(-6);
  var name = 'H_EMG_' + room.name + '_' + shortId + '_' + Game.time;
  var memory = {
    role: 'harvester',
    assignedRoom: room.name,
    homeRoom: room.name,
    sourceId: pickSid
  };

  var cost = bodyCost(body);
  var res = spawn.spawnCreep(body, name, { memory: memory });

  if (res === OK) {
    console.log("EMERGENCY: Spawning harvester in " + room.name + " for source " + shortId +
                " (dist: " + distance + ") | Parts: " + body.length + " | Cost: " + cost);
    return true;
  } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
    console.log("EMERGENCY: Failed to spawn harvester in " + room.name + " for " + pickSid + ": " + res);
  }
  return false;
}

function roomHasLabBotOrSpawning(roomName) {
  var alive = _.some(Game.creeps, function(c) {
    if (!c.memory) return false;
    if (c.memory.role !== 'labBot') return false;
    var assigned = c.memory.homeRoom || c.memory.assignedRoom || c.room.name;
    return assigned === roomName;
  });
  if (alive) return true;

  var rs = getRoomState.get(roomName);
  if (!rs) return false;

  var spawns = [];
  if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    spawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; });
  }

  for (var i = 0; i < spawns.length; i++) {
    var s = spawns[i];
    if (!s.spawning) continue;
    var spawningName = s.spawning.name;
    var mem = Memory.creeps[spawningName];
    if (!mem) continue;
    if (mem.role !== 'labBot') continue;
    var assigned2 = mem.homeRoom || mem.assignedRoom || roomName;
    if (assigned2 === roomName) return true;
  }
  return false;
}

function migrateLegacyLabOrders() {
  if (!Memory.labOrders) return;
  if (Memory._labOrdersMigrated) return;

  for (var roomName in Memory.labOrders) {
    var val = Memory.labOrders[roomName];
    if (!val) continue;

    var looksLegacy = (typeof val === 'object' &&
                       (val.product !== undefined || val.state !== undefined || val.amount !== undefined)) &&
                      (val.active === undefined && val.queue === undefined);

    if (looksLegacy) {
      var product = val.product || '';
      var amount = val.amount || 0;
      var created = val.createdAt || Game.time;

      var a = null;
      var b = null;
      if (product) {
        for (var left in REACTIONS) {
          var row = REACTIONS[left];
          for (var right in row) {
            if (row[right] === product) {
              a = left;
              b = right;
              break;
            }
          }
          if (a && b) break;
        }
      }

      Memory.labOrders[roomName] = {
        active: { product: product, amount: amount, remaining: amount, reag1: a, reag2: b, created: created },
        queue: []
      };
      console.log('[Labs] Migrated legacy lab order for ' + roomName);
    } else if (typeof val !== 'object' || (val.active === undefined || val.queue === undefined)) {
      Memory.labOrders[roomName] = { active: null, queue: [] };
      console.log('[Labs] Reset malformed labOrders entry for ' + roomName);
    }
  }

  Memory._labOrdersMigrated = true;
}

function spawnScavengers() {
  if (!Game.events) return;
  for (const event of Game.events) {
    if (event.event === EVENT_OBJECT_DESTROYED && event.data.type === 'creep') {
      const destroyer = Game.getObjectById(event.data.destroyerId);
      if (destroyer &&
          destroyer.structureType === STRUCTURE_TOWER &&
          destroyer.my) {
        const room = destroyer.room;
        var rs = getRoomState.get(room.name);
        if (!rs) continue;
        var freeSpawns = [];
        if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
          freeSpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
        }
        if (freeSpawns.length > 0) {
          const spawn = freeSpawns[0];
          const name = 'Scavenger_' + room.name + '_' + Game.time;
          const memory = { role: 'scavenger', homeRoom: room.name };
          spawn.spawnCreep(SCAVENGER_BODY, name, { memory: memory });
        }
      }
    }
  }
}

function manageRemoteBuilderSpawns() {
  var orders = Memory.remoteBuilderOrders;
  if (!orders) return;

  var normalized = [];

  if (Array.isArray(orders)) {
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (!o) continue;
      var homeA = o.homeRoom;
      var targetA = o.targetRoom || o.workRoom;
      var countA = parseInt(o.count, 10) || 1;
      var activeA = (o.active === false) ? false : true;
      if (!homeA || !targetA || !activeA) continue;
      normalized.push({ homeRoom: homeA, targetRoom: targetA, count: countA });
    }
  } else {
    for (var key in orders) {
      var o2 = orders[key];
      if (!o2) continue;

      var homeB = o2.homeRoom;
      var targetB = o2.targetRoom || o2.workRoom;

      if ((!homeB || !targetB) && typeof key === 'string') {
        var parts = key.split('->');
        if (!homeB && parts.length > 0) homeB = parts[0];
        if (!targetB && parts.length > 1) targetB = parts[1];
      }

      var countB = parseInt(o2.count, 10) || 1;
      var activeB = (o2.active === false) ? false : true;
      if (!homeB || !targetB || !activeB) continue;
      normalized.push({ homeRoom: homeB, targetRoom: targetB, count: countB });
    }
  }

  if (normalized.length === 0) return;

  for (var n = 0; n < normalized.length; n++) {
    var order = normalized[n];
    var homeRoom = order.homeRoom;
    var targetRoom = order.targetRoom;
    var desired = order.count;

    var living = [];
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.role !== 'remoteBuilder') continue;
      if (c.memory.homeRoom === homeRoom && c.memory.targetRoom === targetRoom) {
        living.push(c);
      }
    }
    if (living.length >= desired) continue;

    var rs = getRoomState.get(homeRoom);
    if (!rs) continue;

    var spawn = null;
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
        if (sp.my && !sp.spawning) { spawn = sp; break; }
      }
    }
    if (!spawn) continue;

    var body = getCreepBody('remoteBuilder', spawn.room.energyAvailable);
    if (!body) continue;

    var newName = 'RemoteBuilder_' + homeRoom + '_' + targetRoom + '_' + (Game.time % 10000);
    var mem = {
      role: 'remoteBuilder',
      homeRoom: homeRoom,
      targetRoom: targetRoom,
      assignedRoom: homeRoom
    };

    var cost = bodyCost(body);
    var res = spawn.spawnCreep(body, newName, { memory: mem });
    if (res === OK) {
      console.log('[RemoteBuilder] Spawning ' + newName + ' at ' + homeRoom + ' for work in ' + targetRoom + ' (' + body.length + ' parts, cost=' + cost + ')');
    } else if (res === ERR_NOT_ENOUGH_ENERGY) {
      if (Game.time % 25 === 0) {
        console.log('[RemoteBuilder] Not enough energy in ' + homeRoom + ' for ' + newName + '. Have: ' + spawn.room.energyAvailable + ', Need: ' + cost);
      }
    } else if (res !== ERR_BUSY) {
      console.log('[RemoteBuilder] Failed to spawn in ' + homeRoom + ': ' + res);
    }
  }
}

// ============================================================================
// SQUAD SPAWN LOGIC (FIXED FOR PRIORITY)
// ============================================================================

function manageSquadSpawns(perRoomRoleCounts) {
  if (!Memory.squadOrders) return;

  // Cleanup fulfilled orders
  for (var i = Memory.squadOrders.length - 1; i >= 0; i--) {
    var ord = Memory.squadOrders[i];
    if (ord.spawnedCount >= 4) {
      console.log("[Squad] Order fulfilled for target " + ord.targetRoom);
      Memory.squadOrders.splice(i, 1);
      continue;
    }
  }

  if (Memory.squadOrders.length === 0) return;

  var order = Memory.squadOrders[0]; // Process one order at a time
  var homeRoom = order.homeRoom;

  var room = Game.rooms[homeRoom];
  if (!room || !room.controller || !room.controller.my) {
    if (Game.time % 20 === 0) console.log("[Squad] Invalid home room " + homeRoom);
    return;
  }

  // --- CRITICAL PRIORITY CHECK ---
  // Ensure we do not starve the room. Squads are expensive.
  // We need Harvesters and Suppliers BEFORE we even think about spawning a squad member.

  var counts = perRoomRoleCounts[homeRoom] || {};
  var targets = getRoomTargets(homeRoom, room);

  var meta = ensureSourceMetaCache(room);
  var expectedHarvesters = meta && meta.byId ? Object.keys(meta.byId).length : 2;

  // If Harvesters exist but are dead (0), or Suppliers are below target:
  if (counts.harvester < expectedHarvesters || counts.supplier < targets.supplier) {
      if (Game.time % 10 === 0) console.log("[Squad] Paused: Room " + homeRoom + " needs economy (Harv/Supp) first.");
      return; // YIELD to economy spawns
  }

  var rs = getRoomState.get(homeRoom);
  if (!rs) return;

  var freeSpawn = null;
  if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
     for(var s=0; s<rs.structuresByType[STRUCTURE_SPAWN].length; s++){
         var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
         if(sp.my && !sp.spawning) { freeSpawn = sp; break; }
     }
  }

  if (!freeSpawn) return; // No spawn available, retry next tick

  var squadId = order.squadId || ("Squad_" + order.targetRoom + "_" + Game.time);
  if (!order.squadId) order.squadId = squadId;

  // --- ROBUST POSITION CHECK ---
  // Iterate 0..3 to find the first missing member. This prevents skipping.
  var spawnIndex = -1;
  var allAlive = true;

  for (var i = 0; i < 4; i++) {
      var creepName = "Quad_" + i + "_" + squadId;
      var creep = Game.creeps[creepName];

      // Check if this specific squad member is currently spawning
      var isSpawning = false;
      var spawns = room.find(FIND_MY_SPAWNS);
      for(var k=0; k<spawns.length; k++) {
          if (spawns[k].spawning && spawns[k].spawning.name === creepName) {
              isSpawning = true;
              break;
          }
      }

      if (isSpawning) {
          if (Game.time % 10 === 0) console.log("[Squad] Member " + i + " is spawning. Waiting.");
          return; // WAIT! Do not check next index.
      }

      if (!creep) {
          spawnIndex = i;
          allAlive = false;
          break; // Found the gap. Stop looking.
      }
  }

  if (allAlive) return;

  var body = getCreepBody('quad', freeSpawn.room.energyAvailable);

  // If energy is too low for a quad, we WAIT. We do NOT cancel.
  if (!body) {
      if (Game.time % 10 === 0) console.log("[Squad] Waiting for energy in " + homeRoom + " to spawn squad member.");
      return; 
  }

  var name = "Quad_" + spawnIndex + "_" + squadId;

  var mem = {
      role: 'quad',
      homeRoom: order.homeRoom,
      targetRoom: order.targetRoom,
      squadId: squadId,
      quadPos: spawnIndex
  };

  var cost = bodyCost(body);
  var res = freeSpawn.spawnCreep(body, name, { memory: mem });

  if (res === OK) {
      console.log("[Squad] Spawning Member " + spawnIndex + " | Cost: " + cost);
      // We do not increment 'spawnedCount' anymore, logic relies on checking existence.
      order.spawnedCount = (order.spawnedCount || 0) + 1;
  }
}

function manageLabBotSpawns() {
  migrateLegacyLabOrders();

  var labManager = require('labManager');

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var labOrders = Memory.labOrders && Memory.labOrders[roomName];
    var hasActiveOrder = labOrders && (labOrders.active || (labOrders.queue && labOrders.queue.length > 0));
    if (!hasActiveOrder) continue;

    // Only spawn if there's actual logistics work to do
    // Prevents spawning labbots that idle while reactions run
    if (!labManager.labsNeedWork(roomName)) {
      continue;
    }

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var labs = [];
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_LAB]) {
      labs = rs.structuresByType[STRUCTURE_LAB].filter(function(l){ return l.my; });
    }
    if (!labs || labs.length < 3) continue;

    if (roomHasLabBotOrSpawning(roomName)) continue;

    var freeSpawn = null;
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = getCreepBody('labBot', freeSpawn.room.energyAvailable);
    if (!body) continue;

    var name = 'LabBot_' + roomName + '_' + Game.time;
    var memory = { role: 'labBot', homeRoom: roomName, assignedRoom: roomName, phase: 'buildA', idleTicks: 0 };
    var cost = bodyCost(body);
    var result = freeSpawn.spawnCreep(body, name, { memory: memory });

    if (result === OK) {
      console.log('Spawning LabBot in ' + roomName + ' with ' + body.length + ' parts | Cost: ' + cost + ' | Energy before: ' + freeSpawn.room.energyAvailable);
    } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('Failed to spawn LabBot in ' + roomName + ': ' + result);
    }
  }
}

function manageTowerDrainSpawns() {
  // Check if tower drain operations system exists
  if (!Memory.towerDrainOps || !Memory.towerDrainOps.operations) return;

  var operations = Memory.towerDrainOps.operations;

  for (var opKey in operations) {
    var op = operations[opKey];
    if (!op) continue;

    // Only spawn for operations that are 'ready' or 'active'
    if (op.status !== 'ready' && op.status !== 'active') continue;

    // Check if we need more creeps
    if (op.creeps.length >= op.maxDrainers) continue;

    // Get home room
    var home = Game.rooms[op.homeRoom];
    if (!home || !home.controller || !home.controller.my) continue;

    var rs = getRoomState.get(op.homeRoom);
    if (!rs) continue;

    // Find available spawn
    var freeSpawn = null;
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
        if (sp.my && !sp.spawning) { 
          freeSpawn = sp; 
          break; 
        }
      }
    }
    if (!freeSpawn) continue;

    // Find next available lane
    var usedLanes = {};
    for (var j = 0; j < op.creeps.length; j++) {
      var c = Game.creeps[op.creeps[j]];
      if (c && typeof c.memory.laneNumber === 'number') {
        usedLanes[c.memory.laneNumber] = true;
      }
    }

    var laneNumber = null;
    for (var n = 1; n <= op.maxDrainers; n++) {
      if (!usedLanes[n] && op.lanes[String(n)]) {
        laneNumber = n;
        break;
      }
    }

    if (laneNumber === null) {
      if (Game.time % 20 === 0) {
        console.log('[TowerDrain] No available lanes for ' + opKey);
      }
      continue;
    }

    // Build body - Tower drainers need TOUGH (absorb damage), HEAL (self-heal), MOVE
    // Each set: 1 TOUGH (10), 1 MOVE (50), 1 HEAL (250) = 310 energy
    var body = [];
    var energyAvailable = freeSpawn.room.energyCapacityAvailable;

    var setCost = 10 + 50 + 250; // TOUGH + MOVE + HEAL = 310
    var maxSets = Math.floor(energyAvailable / setCost);

    // Cap at 16 sets (48 parts total)
    if (maxSets > 16) maxSets = 16;
    if (maxSets < 1) maxSets = 1;

    // Build body: TOUGH parts first (take damage first), then MOVE, then HEAL (protected at end)
    for (var t = 0; t < maxSets; t++) {
      body.push(TOUGH);
    }
    for (var m = 0; m < maxSets; m++) {
      body.push(MOVE);
    }
    for (var h = 0; h < maxSets; h++) {
      body.push(HEAL);
    }

    var cost = bodyCost(body);
    if (cost > freeSpawn.room.energyAvailable) {
      if (Game.time % 20 === 0) {
        console.log('[TowerDrain] Not enough energy in ' + op.homeRoom + ' for drainer. Have: ' + freeSpawn.room.energyAvailable + ', Need: ' + cost);
      }
      continue;
    }

    // Get pre-computed lane positions
    var lane = op.lanes[String(laneNumber)];
    if (!lane) {
      console.log('[TowerDrain] ERROR: Lane ' + laneNumber + ' missing from operation ' + opKey);
      continue;
    }

    // Create creep name
    var name = 'TowerDrain_' + op.targetRoom + '_' + laneNumber + '_' + Game.time;

    // Build memory with all pre-planned data
    var memory = {
      role: 'towerDrain',
      homeRoom: op.homeRoom,
      targetRoom: op.targetRoom,
      safeRoom: op.safeRoom,
      route: op.route,
      routeBack: op.routeBack,
      entryEdge: op.entryEdge,
      laneNumber: laneNumber,
      // Pre-assigned positions from cache
      attackRestPos: lane.attackRestPos,
      attackEdgePos: lane.attackEdgePos,
      healEdgePos: lane.healEdgePos,
      healRestPos: lane.healRestPos,
      drainPos: lane.drainPos,
      healPos: lane.healPos,
      laneSet: true
    };

    // Spawn the creep
    var result = freeSpawn.spawnCreep(body, name, { memory: memory });

    if (result === OK) {
      // Register creep with operation
      towerDrain.registerSpawnedCreep(op.homeRoom, op.targetRoom, name);
      console.log('[TowerDrain] Spawning ' + name + ' (lane ' + laneNumber + ') | Parts: ' + body.length + ' | Cost: ' + cost);
    } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[TowerDrain] Failed to spawn in ' + op.homeRoom + ': ' + result);
    }
  }
}

function manageDemolitionSpawns() {
  if (!Memory.demolitionOrders || Memory.demolitionOrders.length === 0) return;

  for (const order of Memory.demolitionOrders) {
    const homeRoom = order.homeRoom;
    const targetRoom = order.targetRoom;
    const teamCount = order.teamCount;

    const home = Game.rooms[homeRoom];
    if (!home || !home.controller || !home.controller.my) {
      console.log("[Demolition] Home room " + homeRoom + " is no longer valid. Skipping spawn.");
      continue;
    }

    var rsHome = getRoomState.get(homeRoom);
    if (!rsHome) continue;

    var spawns = [];
    if (rsHome && rsHome.structuresByType && rsHome.structuresByType[STRUCTURE_SPAWN]) {
      spawns = rsHome.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
    }
    if (spawns.length === 0) continue;

    const existingDemolishers = _.filter(Game.creeps, function(c){
      if (c.memory.role !== 'demolition') return false;
      if (c.memory.targetRoom !== targetRoom) return false;
      if (c.memory.homeRoom !== homeRoom) return false;
      if (c.memory.demolitionRole && c.memory.demolitionRole !== 'demolisher') return false;
      return true;
    });

    const activeDemolishers = existingDemolishers.length;
    const needed = teamCount - activeDemolishers;

    if (Game.time % 20 === 0 && needed > 0) {
      console.log("[Demolition] Order " + homeRoom + "->" + targetRoom + ": Need " + needed + " demolishers, have " + activeDemolishers);
    }

    for (var i = 0; i < needed; i++) {
      var spawn = spawns.shift();
      if (!spawn) break;

      const demolisherBody = [
        WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK,
        MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE
      ];
      const demolisherCost = bodyCost(demolisherBody);

      if (demolisherCost > spawn.room.energyAvailable) {
        if (Game.time % 20 === 0) {
          console.log("[Demolition] Not enough energy in " + homeRoom + " for demolisher. Have: " + spawn.room.energyAvailable + ", Need: " + demolisherCost);
        }
        if (spawn) spawns.unshift(spawn);
        break;
      }

      const teamId = targetRoom + "_" + Game.time + "_" + Math.floor(Math.random() * 1000);
      const demolisherName = "Demolisher_" + teamId;

      const demolisherMemory = {
        role: 'demolition',
        demolitionRole: 'demolisher',
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        teamId: teamId
      };

      const demolisherResult = spawn.spawnCreep(demolisherBody, demolisherName, { memory: demolisherMemory }); // 
      if (demolisherResult === OK) {
        console.log("[Demolition] Spawning demolisher '" + demolisherName + "' from " + homeRoom + " for " + targetRoom + ".");
      } else if (demolisherResult !== ERR_BUSY) {
        console.log("[Demolition] Failed to spawn demolisher '" + demolisherName + "': " + demolisherResult);
        break;
      }
    }
  }
}

// ============================================================================
// CONTESTED DEMOLISHER SPAWN LOGIC (WITH ROUTE SCANNING)
// ============================================================================

function manageContestedDemolisherSpawns() {
  if (!Memory.contestedDemolisherOrders || Memory.contestedDemolisherOrders.length === 0) return;

  // Iterate backwards to allow splicing
  for (var i = Memory.contestedDemolisherOrders.length - 1; i >= 0; i--) {
    var order = Memory.contestedDemolisherOrders[i];
    if (!order) continue;

    var homeRoom = order.homeRoom;
    var targetRoom = order.targetRoom;
    var squadId = order.squadId || ('cd-' + targetRoom + '-' + Game.time);

    // Only spawn for operations that are 'ready' or 'active'
    // Orders in 'scanning' or 'failed' status should not spawn
    if (order.status !== 'ready' && order.status !== 'active') {
      if (Game.time % 50 === 0 && order.status === 'scanning') {
        console.log("[ContestedDemolisher] Order " + homeRoom + " -> " + targetRoom + " still scanning route...");
      }
      continue;
    }

    // Validate Home Room
    var home = Game.rooms[homeRoom];
    if (!home || !home.controller || !home.controller.my) {
      console.log("[ContestedDemolisher] Invalid home room " + homeRoom + ". Removing order.");
      Memory.contestedDemolisherOrders.splice(i, 1);
      continue;
    }

    var rsHome = getRoomState.get(homeRoom);
    if (!rsHome) continue;

    // Get ALL spawns (including busy ones) to check if we are already spawning a squad member
    var allSpawns = [];
    if (rsHome.structuresByType && rsHome.structuresByType[STRUCTURE_SPAWN]) {
      allSpawns = rsHome.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; });
    }
    if (allSpawns.length === 0) continue;

    // FIX: Check if we are already spawning a member of this squad
    var isSpawningSquad = false;
    for (var s = 0; s < allSpawns.length; s++) {
        if (allSpawns[s].spawning) {
            var mem = Memory.creeps[allSpawns[s].spawning.name];
            if (mem && mem.squadId === squadId) {
                isSpawningSquad = true;
                break;
            }
        }
    }
    if (isSpawningSquad) {
        // We are currently spawning a member (Demo or Healer) for this squad. Wait until it's done.
        continue;
    }

    // Now filter for free spawns only
    var spawns = allSpawns.filter(function(s){ return !s.spawning; });
    if (spawns.length === 0) continue;

    var spawn = spawns[0];
    var spawnedSomething = false;

    // Check existing squad members (alive only)
    var demolisher = _.find(Game.creeps, function(c){
      return c.memory.role === 'contestedDemolisher' &&
             c.memory.squadId === squadId &&
             c.memory.roleType === 'demolisher' &&
             c.ticksToLive > 100;
    });

    var healer = _.find(Game.creeps, function(c){
      return c.memory.role === 'contestedDemolisher' &&
             c.memory.squadId === squadId &&
             c.memory.roleType === 'healer' &&
             c.ticksToLive > 100;
    });

    if (!demolisher) {
      // Demolisher Body: 25 WORK, 25 MOVE
      var demoBody = [];
      for(var m=0; m<25; m++) demoBody.push(MOVE);
      for(var w=0; w<25; w++) demoBody.push(WORK);

      var cost = bodyCost(demoBody);
      if (cost <= spawn.room.energyAvailable) {
        var name = "CD_Demo_" + squadId + "_" + Game.time;
        var mem = {
          role: 'contestedDemolisher',
          roleType: 'demolisher',
          squadId: squadId,
          targetRoom: targetRoom,
          homeRoom: homeRoom,
          towersOnly: order.towersOnly || false,
          // Pre-computed route data from scanning
          route: order.route,
          routeBack: order.routeBack
        };
        var res = spawn.spawnCreep(demoBody, name, { memory: mem });
        if (res === OK) {
          console.log("[ContestedDemolisher] Spawning Demolisher (" + name + ") for " + targetRoom + " | Route: " + (order.route ? order.route.join(' -> ') : 'N/A'));
          spawnedSomething = true;
          // Mark order as active once we start spawning
          order.status = 'active';
        }
      } else if (Game.time % 20 === 0) {
          console.log("[ContestedDemolisher] Not enough energy for Demolisher in " + homeRoom + ". Have: " + spawn.room.energyAvailable + ", Need: " + cost);
      }
    } else if (!healer) {
      // Healer Body: 25 HEAL, 25 MOVE
      var healBody = [];
      for(var m2=0; m2<25; m2++) healBody.push(MOVE);
      for(var h=0; h<25; h++) healBody.push(HEAL);
      var healCost = bodyCost(healBody);
      if (healCost <= spawn.room.energyAvailable) {
        var healName = "CD_Heal_" + squadId + "_" + Game.time;
        var healMem = {
          role: 'contestedDemolisher',
          roleType: 'healer',
          squadId: squadId,
          targetRoom: targetRoom,
          homeRoom: homeRoom,
          // Pre-computed route data from scanning
          route: order.route,
          routeBack: order.routeBack
        };
        var healRes = spawn.spawnCreep(healBody, healName, { memory: healMem });
        if (healRes === OK) {
          console.log("[ContestedDemolisher] Spawning Healer (" + healName + ") for " + targetRoom);
          spawnedSomething = true;
        }
      } else if (Game.time % 20 === 0) {
          console.log("[ContestedDemolisher] Not enough energy for Healer in " + homeRoom + ". Have: " + spawn.room.energyAvailable + ", Need: " + healCost);
      }
    }

    // If both exist and healthy, order is complete - but don't remove it
    // The order stays active so creeps can reference it for route updates
    // Only remove if both creeps are dead AND order was previously active
    if (demolisher && healer) {
      if (order.status !== 'active') {
        order.status = 'active';
        console.log("[ContestedDemolisher] Squad " + squadId + " complete and active.");
      }
    }
  }
}

function manageWallRepairSpawns() {
  if (!Memory.wallRepairOrders) return;

  for (var roomName in Memory.wallRepairOrders) {
    var order = Memory.wallRepairOrders[roomName];
    if (!order || order.active === false) continue;

    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) {
      if (Game.time % 50 === 0) console.log("[WallRepair] Skipping " + roomName + " (no vision or not owned)");
      continue;
    }

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var stillBelow = [];
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_WALL]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_WALL].length; i++) {
        var w = rs.structuresByType[STRUCTURE_WALL][i];
        if (w.hits < order.threshold) stillBelow.push(w);
      }
    }
    if (stillBelow.length === 0) {
      order.active = false;
      order.completedAt = Game.time;
      console.log("[WallRepair] Order complete for " + roomName + " at " + Game.time);
      continue;
    }

    var existing = _.filter(Game.creeps, function(c) {
      return c.memory && c.memory.role === 'wallRepair' && c.memory.orderRoom === roomName;
    });
    if (existing.length > 0) continue;

    var freeSpawn = null;
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = getCreepBody('wallRepair', freeSpawn.room.energyAvailable);
    if (!body) continue;

    var name = 'WallRepair_' + roomName + '_' + (Game.time % 1000);
    var memory = { role: 'wallRepair', orderRoom: roomName };

    var res = freeSpawn.spawnCreep(body, name, { memory: memory });
    if (res === OK) {
      console.log("[WallRepair] Spawning '" + name + "' for " + roomName + " (" + body.length + " parts)");
    } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[WallRepair] Failed to spawn in " + roomName + ": " + res);
    }
  }
}

function manageThiefSpawns() {
  if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) return;

  const activeOrders = Memory.thiefOrders.filter(function(order) {
    var rs = getRoomState.get(order.targetRoom);
    if (!rs) return true;

    var hasResources = false;
    var types = [
      STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_TOWER,
      STRUCTURE_STORAGE, STRUCTURE_CONTAINER, STRUCTURE_LAB, STRUCTURE_TERMINAL
    ];
    for (var ti = 0; ti < types.length && !hasResources; ti++) {
      var t = types[ti];
      var arr = (rs.structuresByType && rs.structuresByType[t]) ? rs.structuresByType[t] : [];
      for (var si = 0; si < arr.length; si++) {
        var st = arr[si];
        if (st.store && st.store.getUsedCapacity() > 0) { hasResources = true; break; }
      }
    }

    if (!hasResources) {
      console.log("[Thief] Target room " + order.targetRoom + " appears to be empty. Cancelling operation.");
      return false;
    }
    return true;
  });

  Memory.thiefOrders = activeOrders;

  for (const order of Memory.thiefOrders) {
    const homeRoom = order.homeRoom;
    const targetRoom = order.targetRoom;
    const count = order.count;

    const existingThieves = _.filter(Game.creeps, function(c){
      return c.memory.role === 'thief' &&
             c.memory.targetRoom === targetRoom &&
             c.memory.homeRoom === homeRoom;
    });
    if (existingThieves.length >= count) continue;

    const home = Game.rooms[homeRoom];
    if (!home || !home.controller || !home.controller.my) {
      console.log("[Thief] Home room " + homeRoom + " for raid on " + targetRoom + " is no longer valid. Skipping spawn.");
      continue;
    }

    var rs = getRoomState.get(homeRoom);
    if (!rs) continue;

    var freeSpawn = null;
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    const body = getCreepBody('supplier', freeSpawn.room.energyAvailable);
    const cost = bodyCost(body);

    if (!body || cost > freeSpawn.room.energyAvailable) {
      if (Game.time % 10 === 0) {
        console.log("[Thief] Not enough energy in " + homeRoom + " to spawn a thief. Have: " + freeSpawn.room.energyAvailable + ", Need: " + cost);
      }
      continue;
    }

    const newName = "Thief_" + targetRoom + "_" + (Game.time % 1000);
    const memory = { role: 'thief', homeRoom: homeRoom, targetRoom: targetRoom, stealing: true };

    const result = freeSpawn.spawnCreep(body, newName, { memory: memory });
    if (result === OK) {
      console.log("[Thief] Spawning '" + newName + "' from " + homeRoom + " for raid on " + targetRoom + ".");
    } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[Thief] Error spawning thief in " + homeRoom + ": " + result);
    }
  }
}

// UPDATED: Now uses getRoomState to calculate total energy
function calculateRoomTotalEnergy(roomName) {
  const rs = getRoomState.get(roomName);
  if (!rs || !rs.structuresByType) return 0;

  let total = 0;

  // Helper to sum energy for a list of structures
  function sumType(type) {
    const list = rs.structuresByType[type];
    if (!list) return 0;
    let sum = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].store) {
        sum += list[i].store.getUsedCapacity(RESOURCE_ENERGY);
      }
    }
    return sum;
  }

  total += sumType(STRUCTURE_SPAWN);
  total += sumType(STRUCTURE_EXTENSION);
  total += sumType(STRUCTURE_CONTAINER);

  if (rs.storage && rs.storage.store) {
    total += rs.storage.store.getUsedCapacity(RESOURCE_ENERGY);
  }

  return total;
}

function manageAttackerSpawns() {
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return;

  for (let i = Memory.attackOrders.length - 1; i >= 0; i--) {
    const order = Memory.attackOrders[i];
    const targetRoom = order.targetRoom;
    const rallyRoom = order.rallyRoom;
    const count = order.count;
    const spawned = order.spawned;
    const startTime = order.startTime;
    const rallyPhase = order.rallyPhase;

    if (rallyPhase === 'spawning') {
      if (spawned < count) {
        const spawnResults = trySpawnAttackersFromAllRooms(order, i);
        if (spawnResults > 0) {
          order.spawned += spawnResults;
          console.log("[Attack] Spawned " + spawnResults + " attackers (" + order.spawned + "/" + count + " total) for " + targetRoom);
        }
      }
      const timeElapsed = Game.time - startTime;
      if (order.spawned >= count || timeElapsed >= 50) {
        order.rallyPhase = 'rallying';
        order.rallyStartTime = Game.time;
        console.log("[Attack] Moving to rally phase for " + targetRoom + " (" + order.spawned + "/" + count + " spawned)");
      }
    } else if (rallyPhase === 'rallying') {
      const attackersAtRally = _.filter(Game.creeps, function(c){
        return c.memory.role === 'attacker' &&
                c.memory.targetRoom === targetRoom &&
                c.room.name === rallyRoom &&
                c.pos.getRangeTo(order.rallyPoint.x, order.rallyPoint.y) <= 3;
      });

      const rallyTimeElapsed = Game.time - order.rallyStartTime;
      const shouldProceed = rallyTimeElapsed >= 50 || attackersAtRally.length >= order.spawned;

      if (shouldProceed) {
        const allAttackers = _.filter(Game.creeps, function(c){
          return c.memory.role === 'attacker' && c.memory.targetRoom === targetRoom;
        });
        allAttackers.forEach(function(creep){ creep.memory.rallyComplete = true; });
        order.rallyPhase = 'attacking';
        console.log("[Attack] Rally complete for " + targetRoom + ". " + allAttackers.length + " attackers proceeding to attack.");
      }
    } else if (rallyPhase === 'attacking') {
      const remainingAttackers = _.filter(Game.creeps, function(c){
        return c.memory.role === 'attacker' && c.memory.targetRoom === targetRoom;
      });
      if (remainingAttackers.length === 0) {
        console.log("[Attack] All attackers for " + targetRoom + " have been eliminated. Order complete.");
        Memory.attackOrders.splice(i, 1);
      }
    }
  }
}

function trySpawnAttackersFromAllRooms(order, orderIndex) {
  let totalSpawned = 0;
  const remainingToSpawn = order.count - order.spawned;
  if (remainingToSpawn <= 0) return 0;

  const roomsWithSpawns = [];

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var spawns = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      spawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
    }
    if (spawns.length === 0) continue;

    const body = getCreepBody('attacker', room.energyAvailable);
    if (!body) continue;

    const cost = bodyCost(body);
    if (cost > room.energyAvailable) continue;

    const distance = Game.map.getRoomLinearDistance(roomName, order.targetRoom);
    const energyRatio = room.energyAvailable / room.energyCapacityAvailable;
    const bodySize = body.length;
    const score = distance - (energyRatio * 5) - (bodySize * 0.1);

    roomsWithSpawns.push({
      roomName: roomName,
      room: room,
      spawns: spawns,
      distance: distance,
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
      energyRatio: energyRatio,
      bodySize: bodySize,
      score: score
    });
  }

  if (roomsWithSpawns.length === 0) {
    if (Game.time % 20 === 0) console.log("[Attack] No rooms can spawn attackers for " + order.targetRoom);
    return 0;
  }

  roomsWithSpawns.sort(function(a, b){ return a.score - b.score; });

  if (!order.roomSpawnCount) order.roomSpawnCount = {};

  for (let i = 0; i < roomsWithSpawns.length && totalSpawned < remainingToSpawn; i++) {
    const roomInfo = roomsWithSpawns[i];

    const alreadySpawnedFromRoom = order.roomSpawnCount[roomInfo.roomName] || 0;
    const maxPerRoom = Math.ceil(order.count / Math.min(3, roomsWithSpawns.length));
    if (alreadySpawnedFromRoom >= maxPerRoom) continue;

    const spawn = roomInfo.spawns[0];
    const body = getCreepBody('attacker', spawn.room.energyAvailable);
    if (!body) {
      console.log("[Attack] " + roomInfo.roomName + ": Failed to generate attacker body");
      continue;
    }

    const attackerName = "Attacker_" + order.targetRoom + "_" + Game.time + "_" + (order.spawned + totalSpawned);
    const result = spawn.spawnCreep(body, attackerName, {
      memory: {
        role: 'attacker',
        targetRoom: order.targetRoom,
        rallyRoom: order.rallyRoom,
        spawnRoom: roomInfo.roomName,
        orderIndex: orderIndex,
        rallyComplete: false
      }
    });

    if (result === OK) {
      totalSpawned++;
      order.roomSpawnCount[roomInfo.roomName] = alreadySpawnedFromRoom + 1;
      console.log("[Attack] Spawning attacker '" + attackerName + "' from " + roomInfo.roomName + " (dist=" + roomInfo.distance + ", energy=" + roomInfo.energyAvailable + ", body=" + body.length + " parts)");
    } else if (result !== ERR_BUSY) {
      console.log("[Attack] Failed to spawn attacker '" + attackerName + "' from " + roomInfo.roomName + ": " + result);
    }

    if (totalSpawned > 0) break;
  }

  return totalSpawned;
}

function manageExtractorSpawns() {
  if (Game.time % 20 !== 0) return;

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var extractor = null;
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTRACTOR]) {
      var list = rs.structuresByType[STRUCTURE_EXTRACTOR].filter(function(s){ return s.my; });
      extractor = list[0];
    }
    if (!extractor) continue;

    var mineral = (rs.minerals && rs.minerals.length > 0) ? rs.minerals[0] : null;
    if (!mineral || mineral.mineralAmount === 0) continue;

    var container = null;
    var containers = (rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) ? rs.structuresByType[STRUCTURE_CONTAINER] : [];
    for (var i = 0; i < containers.length; i++) {
      if (containers[i].pos.getRangeTo(extractor.pos) <= 1) { container = containers[i]; break; }
    }
    if (!container) continue;

    var hasExtractorCreep = false;
    for (var cname in Game.creeps) {
      var c = Game.creeps[cname];
      if (!c.memory) continue;
      if (c.memory.role === 'extractor' && c.memory.extractorId === extractor.id) {
        var ttl = c.ticksToLive;
        if (ttl === undefined || ttl > 80 || c.spawning) {
          hasExtractorCreep = true;
          break;
        }
      }
    }
    if (hasExtractorCreep) continue;

    var spawn = null;
    var spawns = (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) ? rs.structuresByType[STRUCTURE_SPAWN] : [];
    for (var s = 0; s < spawns.length; s++) {
      if (spawns[s].my && !spawns[s].spawning) { spawn = spawns[s]; break; }
    }
    if (!spawn) continue;

    var body = buildExtractorBody(spawn.room.energyAvailable);
    if (!body) continue;

    var name    = "extractor_" + roomName + "_" + (Game.time % 1000);
    var memory = { role: 'extractor', roomName: roomName, extractorId: extractor.id };
    var result = spawn.spawnCreep(body, name, { memory: memory });
    if (result === OK) {
      console.log("[Spawn] extractor for " + roomName + " | parts=" + body.length);
    }
  }
}

function manageClaimbotSpawns() {
  if (!Memory.claimSpawnQueue) Memory.claimSpawnQueue = [];
  if (Memory.claimSpawnQueue.length === 0) return;

  const order = Memory.claimSpawnQueue[0];

  // De-dupe: don’t spawn if already exists
  const existing = _.find(Game.creeps, function(c){
    return c.memory && c.memory.role === 'claimbot' && c.memory.targetRoom === order.targetRoom;
  });
  if (existing) {
    Memory.claimSpawnQueue.shift();
    return;
  }

  const rs = getRoomState.get(order.spawnRoom);
  if (!rs || !rs.structuresByType || !rs.structuresByType[STRUCTURE_SPAWN]) return;

  const spawn = rs.structuresByType[STRUCTURE_SPAWN].find(function(s){
    return s.my && !s.spawning;
  });
  if (!spawn) return;

  // Body: 9 MOVE (+5 from old 4 MOVE baseline), plus ATTACK + CLAIM
  const body = [
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
    ATTACK, CLAIM
  ];

  const cost = bodyCost(body);
  if (spawn.room.energyAvailable < cost) return;

  const name = 'Claimbot_' + order.targetRoom + '_' + Game.time;
  const res = spawn.spawnCreep(body, name, {
    memory: {
      role: 'claimbot',
      targetRoom: order.targetRoom,
      precomputedRoute: order.route
    }
  });

  if (res === OK) {
    console.log('[Claimbot] Spawning ' + name + ' from ' + order.spawnRoom + ' -> ' + order.targetRoom);
    Memory.claimSpawnQueue.shift();
  }
}


function spawnCreepInRoom(role, body, spawn, roomName) {
  const newName = role + "_" + roomName + "_" + Game.time;
  // --- MODIFIED: Added homeRoom to generic spawn memory for compatibility with new roles (like powerBot) ---
  const memory = { role: role, assignedRoom: roomName, homeRoom: roomName };
  const availableEnergy = spawn.room.energyAvailable;
  const cost = bodyCost(body);
  const result = spawn.spawnCreep(body, newName, { memory: memory });

  if (result === OK) {
    console.log("Spawning " + role + " in " + roomName + " with " + body.length + " parts | Cost: " + cost + " | Energy before: " + availableEnergy);
    return true;
  } else {
    if (result !== ERR_BUSY) {
      console.log("Failed to spawn " + role + " in " + roomName + ": " + result + " (energy: " + availableEnergy + ", cost: " + cost + ")");
    }
    return false;
  }
}

function shouldSpawnSupplier(roomName) {
  var room = Game.rooms[roomName];
  if (!room || !room.controller || !room.controller.my) return 0;

  if (room.controller.level !== 8) return 1;

  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.room && c.room.name === roomName && c.memory.role !== 'supplier') {
      return 1;
    }
  }

  var rs = getRoomState.get(roomName);
  if (!rs) return 0;

  var towers = (rs.structuresByType && rs.structuresByType[STRUCTURE_TOWER]) ? rs.structuresByType[STRUCTURE_TOWER] : [];
  if (towers.length > 0) {
    var allBelowThreshold = true;
    for (var t = 0; t < towers.length; t++) {
      var tw = towers[t];
      if (!tw || !tw.store) { allBelowThreshold = false; break; }
      var twEnergy = tw.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
      if (twEnergy >= 500) { allBelowThreshold = false; break; }
    }
    if (allBelowThreshold) return 1;
  }

  var terminals = (rs.structuresByType && rs.structuresByType[STRUCTURE_TERMINAL]) ? rs.structuresByType[STRUCTURE_TERMINAL] : [];
  for (var k = 0; k < terminals.length; k++) {
    var term = terminals[k];
    if (!term || !term.store) continue;
    var termEnergy = term.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (termEnergy < 5000) return 1;
  }

  var totalEnergy = 0;
  var totalCapacity = 0;

  var extensions = (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTENSION]) ? rs.structuresByType[STRUCTURE_EXTENSION] : [];
  for (var e = 0; e < extensions.length; e++) {
    var ex = extensions[e];
    if (!ex || !ex.store) continue;
    totalEnergy += ex.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    totalCapacity += ex.store.getCapacity(RESOURCE_ENERGY) || 0;
  }

  var spawns = (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) ? rs.structuresByType[STRUCTURE_SPAWN] : [];
  for (var s = 0; s < spawns.length; s++) {
    var sp = spawns[s];
    if (!sp || !sp.store) continue;
    totalEnergy += sp.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    totalCapacity += sp.store.getCapacity(RESOURCE_ENERGY) || 0;
  }

  if (totalCapacity > 0) {
    var ratio = totalEnergy / totalCapacity;
    if (ratio < 0.5) return 1;
  }

  return 0;
}

// --- Spawn delay helpers for low RCL and low energy fill ---
function handleRoomSpawnDelay(roomName, room) {
  if (!Memory.spawnDelayUntil) Memory.spawnDelayUntil = {};
  const existing = Memory.spawnDelayUntil[roomName];

  // If a delay exists and is in the future, it is active
  if (existing && Game.time < existing) return true;

  // If the delay has passed, clear it
  if (existing && Game.time >= existing) delete Memory.spawnDelayUntil[roomName];

  return false;
}

// --- RCL8 Upgrader spawn cooldown helpers ---
function shouldDelayUpgraderAtRCL8(roomName, room) {
  if (!room || !room.controller || !room.controller.my) return false;
  if (room.controller.level !== 8) return false;

  if (!Memory.rcl8UpgraderDelayUntil) Memory.rcl8UpgraderDelayUntil = {};
  var until = Memory.rcl8UpgraderDelayUntil[roomName];

  if (!until) return false;

  if (Game.time < until) return true;

  delete Memory.rcl8UpgraderDelayUntil[roomName];
  return false;
}

function scheduleUpgraderDelayRCL8(roomName) {
  var room = Game.rooms[roomName];
  if (!room) return;

  var minerals = room.find(FIND_MINERALS);
  var mineral = minerals.length > 0 ? minerals[0] : null;

  if (!mineral) {
    if (!Memory.rcl8UpgraderDelayUntil) Memory.rcl8UpgraderDelayUntil = {};
    Memory.rcl8UpgraderDelayUntil[roomName] = Game.time + 5000;
    return;
  }

  if (mineral.mineralAmount > 0) {
    if (Memory.rcl8UpgraderDelayUntil && Memory.rcl8UpgraderDelayUntil[roomName]) {
      delete Memory.rcl8UpgraderDelayUntil[roomName];
    }
  } 
  else {
    var regenTime = mineral.ticksToRegeneration;
    if (regenTime === undefined || regenTime === null) {
       regenTime = 100; 
    }

    if (!Memory.rcl8UpgraderDelayUntil) Memory.rcl8UpgraderDelayUntil = {};
    Memory.rcl8UpgraderDelayUntil[roomName] = Game.time + regenTime;

    console.log('[RCL8] ' + roomName + ': Minerals exhausted. Pausing upgraders for ' + regenTime + ' ticks.');
  }
}

function getRoomTargets(roomName, room) {
  var rs = getRoomState.get(roomName);

  var containers = [];
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) {
    containers = rs.structuresByType[STRUCTURE_CONTAINER];
  }

  // Checking construction sites from getRoomState
  var constructionSitesCount = 0;
  if (rs && rs.constructionSites) {
    constructionSitesCount = rs.constructionSites.length;
  }
  let builderTarget = +(constructionSitesCount > 0);

  // --- Determine Source Count ---
  var sourceCount = 0;
  if (rs && rs.sources) {
    sourceCount = rs.sources.length;
  } else {
    // Fallback
    var sources = room.find(FIND_SOURCES);
    sourceCount = sources.length;
  }

  // --- Storage energy only ---
  var storageEnergy = 0;
  if (rs && rs.storage && rs.storage.store) {
    storageEnergy = rs.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  } else if (room.storage && room.storage.store) {
    storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  }

  // --- Default targets ---
  var upgraderTarget = 1;
  var maintainerTarget = 0;

  // ==========================================================================
  // RCL 8 LOGIC: Upgrader vs Maintainer (MUTUALLY EXCLUSIVE)
  // ==========================================================================
  // At RCL8 you can't level up - upgrading just prevents downgrade.
  // 
  // Decision tree:
  //   1. Good storage (>=200k)?  -> Use UPGRADER (you can afford it)
  //   2. Low storage (<200k)?    -> Use MAINTAINER only when TTL is critical
  //   3. Single source room?     -> Always use MAINTAINER (conserve energy)
  // ==========================================================================
  
  if (room.controller && room.controller.level === 8) {
    // Determine TTL threshold based on source count
    var ticksThreshold = (sourceCount === 1) ? 150000 : 125000;
    
    if (sourceCount === 1) {
      // --- SINGLE SOURCE RCL8 ROOM ---
      // Always conserve energy - use maintainer only when needed
      upgraderTarget = 0;
      if (room.controller.ticksToDowngrade < ticksThreshold) {
        maintainerTarget = 1;
      }
    } 
    else if (storageEnergy < 500000) {
      // --- LOW ENERGY RCL8 ROOM (2+ sources) ---
      // Conserve energy - use maintainer only when TTL is critical
      upgraderTarget = 0;
      if (room.controller.ticksToDowngrade < ticksThreshold) {
        maintainerTarget = 1;
      }
      
      // EXCEPTION: If extractor is about to spawn, allow an upgrader to pair with it
      // (This keeps the upgrader from idling while extractor works)
      if (Game.time % 20 === 0) {
        var extractorSpawnConditionsMet = checkExtractorSpawnConditions(rs, containers);
        if (extractorSpawnConditionsMet) {
          upgraderTarget = 1;
          maintainerTarget = 0; // Don't need both
        }
      }
    } 
    else {
      // --- GOOD ENERGY RCL8 ROOM (2+ sources, storage >= 200k) ---
      // Use a regular upgrader - you can afford it
      upgraderTarget = 1;
      maintainerTarget = 0; // Upgrader handles maintenance
    }
  }

  // ==========================================================================
  // NON-RCL8 LOGIC
  // ==========================================================================
  
  // Double upgrade for sub-RCL8 rooms (if enabled)
  if (Memory.doubleUpgradeRooms && Memory.doubleUpgradeRooms[roomName]) {
    if (room.controller && room.controller.level <= 7) {
      upgraderTarget = 2;
    }
  }

  return {
    harvester:   0,
    upgrader:    upgraderTarget,
    builder:     builderTarget,
    scout:       0,
    defender:    0,
    supplier:    shouldSpawnSupplier(roomName),
    maintainer:  maintainerTarget
  };
}

// =============================================================================
// HELPER: Check if extractor spawn conditions are met
// =============================================================================
function checkExtractorSpawnConditions(rs, containers) {
  if (!rs) return false;
  
  var extractor = null;
  if (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTRACTOR]) {
    var list = rs.structuresByType[STRUCTURE_EXTRACTOR].filter(function(s){ return s.my; });
    extractor = list[0];
  }
  if (!extractor) return false;

  var mineral = (rs.minerals && rs.minerals.length > 0) ? rs.minerals[0] : null;
  if (!mineral || mineral.mineralAmount === 0) return false;

  // Require a container next to the extractor
  var container = null;
  var contList = containers || [];
  for (var i = 0; i < contList.length; i++) {
    if (contList[i].pos.getRangeTo(extractor.pos) <= 1) {
      container = contList[i];
      break;
    }
  }
  if (!container) return false;

  // Require that we don't already have a valid extractor creep
  for (var cname in Game.creeps) {
    var c = Game.creeps[cname];
    if (!c || !c.memory) continue;
    if (c.memory.role === 'extractor' && c.memory.extractorId === extractor.id) {
      var ttl = c.ticksToLive;
      if (ttl === undefined || ttl > 80 || c.spawning) {
        return false; // Already have one
      }
    }
  }

  return true;
}



// UPDATED: Removed roomDataCache parameter
function manageSpawnsPerRoom(perRoomRoleCounts) {
  if (Memory.claimOrders && Memory.claimOrders.length > 0) return;

  manageHarvesterSpawns();

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var availableSpawns = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      availableSpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
    }
    if (availableSpawns.length === 0) continue;

    var roleCounts = perRoomRoleCounts[roomName] || {};
    var roomTargets = getRoomTargets(roomName, room);

    if (roleCounts.harvester === 0) {
      var minHarvesterCost = bodyCost(BASIC_HARVESTER);
      var canSpawnBasicHarvester = room.energyAvailable >= minHarvesterCost;
      var supplierCount = roleCounts.supplier || 0;
      var roomEnergyTotal = calculateRoomTotalEnergy(roomName);

      var emergency = !canSpawnBasicHarvester &&
                      (supplierCount === 0 || (supplierCount > 0 && roomEnergyTotal < 300));

      if (emergency) {
        console.log(
          'EMERGENCY MODE in ' + roomName + '!!! ' +
          '(harvesters=0, suppliers=' + supplierCount +
          ', roomEnergy=' + roomEnergyTotal +
          ', available=' + room.energyAvailable + '/' + minHarvesterCost + ')'
        );

        spawnEmergencyHarvester(room, availableSpawns[0]);
        continue;
      }
    }

    var delayActive = handleRoomSpawnDelay(roomName, room);

    var spawnQueue = [];
    if (roleCounts.defender  < roomTargets.defender)  spawnQueue.push('defender');
    if (roleCounts.supplier  < roomTargets.supplier)  spawnQueue.push('supplier');

    // Maintainer logic (Placed after supplier to ensure room energy flow, but before upgraders)
    if (roleCounts.maintainer < roomTargets.maintainer) spawnQueue.push('maintainer');

    // --- POWER BOT QUEUE CHECK ---
    if (Memory.spawnRequests && Memory.spawnRequests[roomName] && Memory.spawnRequests[roomName].needPowerBot) {
       var existingPower = _.filter(Game.creeps, function(c) { return c.memory.role === 'powerBot' && c.memory.homeRoom === roomName; });
       if (existingPower.length === 0) {
           spawnQueue.push('powerBot');
       }
    }
    // ------------------------------------

    if (roleCounts.upgrader  < roomTargets.upgrader)  spawnQueue.push('upgrader');
    if (roleCounts.builder   < roomTargets.builder)   spawnQueue.push('builder');
    if (roleCounts.scout     < roomTargets.scout)     spawnQueue.push('scout');

    var spawnsUsed = 0;
    for (var i = 0; i < spawnQueue.length; i++) {
      if (spawnsUsed >= availableSpawns.length) break;

      var roleToSpawn = spawnQueue[i];

      // If delay is active, skip all roles except suppliers
      if (delayActive && roleToSpawn !== 'supplier') continue;

      if (roleToSpawn === 'upgrader' && shouldDelayUpgraderAtRCL8(roomName, room)) {
        continue;
      }

      var energyForSpawn = room.energyAvailable;

      if (roleToSpawn === 'upgrader' &&
          room.controller &&
          room.controller.my &&
          room.controller.level === 8 &&
          energyForSpawn > 2300) {
        energyForSpawn = 2300;
      }

      var body = getCreepBody(roleToSpawn, energyForSpawn);
      if (!body) continue;

      var success = spawnCreepInRoom(roleToSpawn, body, availableSpawns[spawnsUsed], roomName);
      if (success) {
        spawnsUsed++;
        if (roleCounts[roleToSpawn] === undefined) roleCounts[roleToSpawn]++;

        // --- SPAWN DELAY LOGIC ---
        // If the room is Low RCL (<=6), trigger a delay after ANY spawn.
        if (room.controller && room.controller.level <= 6) {
             Memory.spawnDelayUntil[roomName] = Game.time + LOW_RCL_SPAWN_DELAY_TICKS;
             console.log("[SpawnDelay] " + roomName + ": Spawn complete. Pausing non-supplier spawns for " + LOW_RCL_SPAWN_DELAY_TICKS + " ticks.");
        }

        if (roleToSpawn === 'upgrader' && room.controller && room.controller.level === 8) {
          scheduleUpgraderDelayRCL8(roomName);
        }
      }
    }
  }
}

// ============================================================================
// One-call orchestrator for spawn systems
// ============================================================================

// UPDATED: Ignores the second argument (since getRoomState is global/required)
function run(perRoomRoleCounts) {
  // 1. Run low-priority spawns
  if (Game.time % 5 === 0)  manageDemolitionSpawns();
  if (Game.time % 10 === 0) manageClaimbotSpawns();
  if (Game.time % 5 === 0)  manageAttackerSpawns();
  if (Game.time % 5 === 0)  manageTowerDrainSpawns();
  if (Game.time % 5 === 0)  manageThiefSpawns();
  if (Game.time % 5 === 0)  manageExtractorSpawns();
  if (Game.time % 10 === 0) spawnScavengers();
  if (Game.time % 2 === 0)  manageLabBotSpawns();
  if (Game.time % 10 === 0) manageWallRepairSpawns();
  if (Game.time % 10 === 0) manageNukeFillSpawns();
  if (Game.time % 5 === 0) manageRemoteBuilderSpawns();
  // --- CONTESTED DEMOLISHER ---
  if (Game.time % 5 === 0) manageContestedDemolisherSpawns();

  // 2. Run High Priority (Room Economy)
  if (needsNewCreeps(perRoomRoleCounts) || Game.time % 10 === 0) {
    manageSpawnsPerRoom(perRoomRoleCounts);
  }

  // 3. Run Squad Spawns (AFTER economy)
  if (Game.time % 5 === 0)  manageSquadSpawns(perRoomRoleCounts); 
}

function needsNewCreeps(perRoomRoleCounts) {
  for (const roomName in perRoomRoleCounts) {
    const counts = perRoomRoleCounts[roomName];
    var total = 0;
    for (var k in counts) total += counts[k];
    if (counts.harvester === 0) return true;
    if (total < 3) return true;
  }
  return false;
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Orchestrator
  run,

  // Primary managers
  manageSpawnsPerRoom,
  manageHarvesterSpawns,
  manageDemolitionSpawns,
  manageContestedDemolisherSpawns,
  manageClaimbotSpawns,
  manageAttackerSpawns,
  manageTowerDrainSpawns,
  manageThiefSpawns,
  manageExtractorSpawns,
  manageLabBotSpawns,
  manageWallRepairSpawns,
  manageSquadSpawns,
  spawnScavengers,
  manageNukeFillSpawns,
  manageRemoteBuilderSpawns,

  // Utilities you use elsewhere
  getCreepBody,
  bodyCost,
  shouldSpawnSupplier,
  spawnEmergencyHarvester,
  getRoomTargets,
  handleRoomSpawnDelay
};