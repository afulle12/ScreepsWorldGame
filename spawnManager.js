// spawnManager.js
// ============================================================================
// Spawn Manager
// Centralizes all spawn-related logic pulled from main.js.
// Updated to use getRoomState (Live Objects) instead of Memory.roomData
// ============================================================================
// To spawn 2 upgraders in a room
// doubleUpgrade('ROOMNAME', true) to enable doubleUpgrade('ROOM_NAME', false) to disable


const getRoomState = require('getRoomState');

// --- CONSTANTS ---
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER = [TOUGH, MOVE, RANGED_ATTACK];
const SCOUT_BODY = [MOVE, MOVE, MOVE, MOVE, MOVE];
const SCAVENGER_BODY = [MOVE, CARRY, CARRY, MOVE];
const MAINTAINER_BODY = [WORK, CARRY, CARRY, MOVE]; // Fixed body for maintainer
const TOWER_DRAIN_BODY = [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, MOVE];

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
      400: [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
      450: [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
      550: [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
      750: [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
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
  var terrain = room.getTerrain();

  for (var si = 0; si < sources.length; si++) {
    var src = sources[si];
    if (!src || !src.pos) continue;

    var closestSpawn = null;
    var bestRange = Infinity;
    for (var sp = 0; sp < spawns.length; sp++) {
      var spn = spawns[sp];
      var r = spn.pos.getRangeTo(src.pos);
      if (r < bestRange) {
        bestRange = r;
        closestSpawn = spn;
      }
    }

    var open = 0;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = src.pos.x + dx;
        var y = src.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) !== TERRAIN_MASK_WALL) open++;
      }
    }

    byId[src.id] = {
      id: src.id,
      pos: { x: src.pos.x, y: src.pos.y, roomName: roomName },
      nearestSpawnId: closestSpawn ? closestSpawn.id : null,
      range: bestRange < Infinity ? bestRange : null,
      harvestPositions: open
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

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var labOrders = Memory.labOrders && Memory.labOrders[roomName];
    var hasActiveOrder = labOrders && (labOrders.active || (labOrders.queue && labOrders.queue.length > 0));
    if (!hasActiveOrder) continue;

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
    var memory = { role: 'labBot', homeRoom: roomName, assignedRoom: roomName, phase: 'buildA' };
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
  if (!Memory.towerDrainOrders || Memory.towerDrainOrders.length === 0) return;

  for (const order of Memory.towerDrainOrders) {
    const homeRoom = order.homeRoom;
    const targetRoom = order.targetRoom;
    const count = order.count;

    const existingDrainers = _.filter(Game.creeps, function(c){
      return c.memory.role === 'towerDrain' &&
             c.memory.targetRoom === targetRoom &&
             c.memory.homeRoom === homeRoom;
    });

    if (existingDrainers.length >= count) continue;

    const home = Game.rooms[homeRoom];
    if (!home || !home.controller || !home.controller.my) {
      console.log("[TowerDrain] Home room " + homeRoom + " is no longer valid. Skipping spawn.");
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

    const cost = bodyCost(TOWER_DRAIN_BODY);
    if (cost > freeSpawn.room.energyAvailable) {
      if (Game.time % 10 === 0) {
        console.log("[TowerDrain] Not enough energy in " + homeRoom + ". Have: " + freeSpawn.room.energyAvailable + ", Need: " + cost);
      }
      continue;
    }

    const newName = "TowerDrain_" + targetRoom + "_" + (Game.time % 1000);
    const memory = { role: 'towerDrain', homeRoom: homeRoom, targetRoom: targetRoom };
    const result = freeSpawn.spawnCreep(TOWER_DRAIN_BODY, newName, { memory: memory });
    if (result === OK) {
      console.log("[TowerDrain] Spawning '" + newName + "' from " + homeRoom + " to drain towers in " + targetRoom + ".");
    } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[TowerDrain] Error spawning tower drain bot in " + homeRoom + ": " + result);
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
  if (!Memory.claimOrders) Memory.claimOrders = [];
  if (Memory.claimOrders.length === 0) return;

  const claimOrder = Memory.claimOrders[0];
  const existing = _.find(Game.creeps, function(c){
    return c.memory.role === 'claimbot' && c.memory.targetRoom === claimOrder.room;
  });
  if (existing) return;

  let closestSpawn = null;
  let closestDistance = Infinity;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    var spawn = null;
    var spawns = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) ? rs.structuresByType[STRUCTURE_SPAWN] : [];
    for (var i = 0; i < spawns.length; i++) {
      if (spawns[i].my && !spawns[i].spawning) { spawn = spawns[i]; break; }
    }
    if (!spawn) continue;

    const distance = Game.map.getRoomLinearDistance(roomName, claimOrder.room);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestSpawn = spawn;
    }
  }
  if (!closestSpawn) return;

  const claimBody = [MOVE, MOVE, ATTACK, CLAIM, MOVE, MOVE];
  const cost = bodyCost(claimBody);
  const availableEnergy = closestSpawn.room.energyAvailable;
  const result = closestSpawn.spawnCreep(
    claimBody,
    'claimbot' + Game.time,
    { memory: { role: 'claimbot', targetRoom: claimOrder.room } }
  );
  if (result === OK) {
    console.log("Spawning claimbot for " + claimOrder.room + " | Cost: " + cost + " | Energy before: " + availableEnergy);
    Memory.claimOrders.shift();
  } else {
    console.log("Failed to spawn claimbot: " + result);
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

// UPDATED: Now uses getRoomState logic instead of roomDataCache
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

  // --- Logic for Upgrader Target ---
  var upgraderTarget = 1;

  // RCL 8 + Single Source -> 0 Upgraders (Save energy, rely on Maintainer if needed)
  if (room.controller && room.controller.level === 8 && sourceCount === 1) {
      upgraderTarget = 0;
  }

  // --- Logic for Double Upgrade ---
  if (Memory.doubleUpgradeRooms && Memory.doubleUpgradeRooms[roomName]) {
      // Only permit double upgraders if RCL is 7 or lower
      if (room.controller && room.controller.level <= 7) {
          upgraderTarget = 2;
      }
  }

  // --- Logic for Maintainer (RCL8, 1 Source, < 150k ticks) ---
  var maintainerTarget = 0;
  if (room.controller && room.controller.level === 8) {
      if (room.controller.ticksToDowngrade < 150000) {
          // Check source count. Use getRoomState if available for speed
          var sourceCount = 0;
          if (rs && rs.sources) {
              sourceCount = rs.sources.length;
          } else {
              // Fallback
              var sources = room.find(FIND_SOURCES);
              sourceCount = sources.length;
          }

          if (sourceCount === 1) {
              maintainerTarget = 1;
          }
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