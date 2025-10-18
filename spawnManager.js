// spawnManager.js
// ============================================================================
// Spawn Manager
// Centralizes all spawn-related logic pulled from main.js.
//
// Integration options:
//  - Option A (single entry): call spawnManager.run(perRoomRoleCounts, roomDataCache)
//  - Option B (piecemeal): call individual exported functions where you already do
//
// Notes:
//  - No optional chaining used
//  - Uses Screeps API only
//  - Requires: getRoomState, squadModule (same modules as your main)
// ============================================================================

const getRoomState = require('getRoomState');
const squad = require('squadModule');

// --- CONSTANTS (copied from main where needed) ---
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER   = [TOUGH, MOVE, RANGED_ATTACK];
const SCOUT_BODY       = [MOVE, MOVE, MOVE, MOVE, MOVE];
const SCAVENGER_BODY   = [MOVE, CARRY, CARRY, MOVE];
const TOWER_DRAIN_BODY = [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, MOVE];

const LOW_RCL_SPAWN_DELAY_TICKS = 100;
const LOW_RCL_ENERGY_FILL_THRESHOLD = 0.75;

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
    upgrader: {
      200: [WORK, CARRY, MOVE],
      300: [WORK, WORK, CARRY, MOVE],
      500: [WORK, WORK, WORK, WORK, CARRY, MOVE],
      550: [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
      800: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE],
      1100: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE]
    },
    builder: {
      300: [WORK, CARRY, CARRY, MOVE, MOVE],
      400: [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
      450: [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
      550: [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
      750: [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
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
      2200:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE],
      2400:[CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY, MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE]
    },
    scout: { 300: SCOUT_BODY }
  };

  if (role === 'scout') return SCOUT_BODY;
  if (energy <= 300 && role !== 'defender' && role !== 'supplier') return BASIC_HARVESTER;

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
  var sources = (rs && rs.sources) ? rs.sources : room.find(FIND_SOURCES);

  var spawns = [];
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
      var s = rs.structuresByType[STRUCTURE_SPAWN][i];
      if (s.my) spawns.push(s);
    }
  } else {
    spawns = room.find(FIND_MY_SPAWNS);
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

function buildHarvesterBodyForDistance(distance, energyBudget) {
  if (energyBudget < 200) return null;

  var body = [];
  var cost = 0;
  var parts = 0;

  function canAdd(part) {
    return (parts + 1 <= 50) && (cost + costOf(part) <= energyBudget);
  }
  function add(part) {
    body.push(part);
    cost += costOf(part);
    parts++;
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
    return lcm(50, twoW) / 50;
  }

  var maxWork = 15;
  var workCount = 0;
  var carryCount = 0;
  var moveCount = 0;

  if (distance < 4) {
    while (workCount < maxWork && canAdd(WORK)) {
      add(WORK); workCount++;
    }
    var neededCarry = carryNeededFor(workCount);
    while (carryCount < neededCarry && canAdd(CARRY)) {
      add(CARRY); carryCount++;
    }
    if (canAdd(MOVE)) {
      add(MOVE); moveCount++;
    }
    return body;
  }

  if (distance > 25) {
    while ((parts + 2 <= 50) &&
           (cost + costOf(MOVE) + costOf(WORK) <= energyBudget) &&
           workCount < maxWork) {
      add(MOVE); moveCount++;
      add(WORK); workCount++;
    }
    var neededCarryFar = carryNeededFor(workCount);
    while (carryCount < neededCarryFar && canAdd(CARRY)) {
      add(CARRY); carryCount++;
    }
    return body;
  }

  while (workCount < maxWork && canAdd(WORK)) {
    add(WORK); workCount++;
    if (workCount % 3 === 0 && canAdd(MOVE)) {
      add(MOVE); moveCount++;
    }
  }
  var neededCarryMid = carryNeededFor(workCount);
  while (carryCount < neededCarryMid && canAdd(CARRY)) {
    add(CARRY); carryCount++;
  }
  if (moveCount === 0 && canAdd(MOVE)) {
    add(MOVE); moveCount++;
  }
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
    var storage = rs ? rs.storage : room.storage;
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
    } else {
      availableSpawns = room.find(FIND_MY_SPAWNS, { 
        filter: function(s){ return !s.spawning; } 
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

    var spawn = availableSpawns[0];
    var sourceToSpawn = needsHarvester[0];
    var smeta = sourceToSpawn.meta;
    var distance = smeta.range || 10;

    var body = buildHarvesterBodyForDistance(distance, room.energyAvailable);
    if (!body) continue;

    var shortId = sourceToSpawn.id.slice(-6);
    var name = 'H_' + roomName + '_' + shortId + '_' + Game.time;
    var memory = { 
      role: 'harvester', 
      assignedRoom: room.name, 
      homeRoom: room.name, 
      sourceId: sourceToSpawn.id 
    };

    var cost = bodyCost(body);
    var res = spawn.spawnCreep(body, name, { memory: memory });

    if (res === OK) {
      console.log("Spawning harvester in " + room.name + " for source " + shortId + 
                  " (dist: " + distance + ") | Parts: " + body.length + " | Cost: " + cost);
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
  var body = buildHarvesterBodyForDistance(distance, room.energyAvailable);
  if (!body) return false;

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
  var spawns = [];
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    spawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; });
  } else {
    var room = Game.rooms[roomName];
    if (!room) return false;
    spawns = room.find(FIND_MY_SPAWNS);
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
        var freeSpawns = [];
        if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
          freeSpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
        } else {
          freeSpawns = room.find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } });
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

function processSquadSpawnQueues() {
  if (!Memory.squadQueues || Memory.squadQueues.length === 0) return;

  var formRooms = null;
  for (var i = 0; i < Memory.squadQueues.length; i++) {
    var q = Memory.squadQueues[i];
    if (q && q.formRoom) {
      if (!formRooms) formRooms = {};
      formRooms[q.formRoom] = true;
    }
  }

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    if (formRooms && !formRooms[roomName]) continue;

    var rs = getRoomState.get(roomName);
    var spawns = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      spawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; });
    } else {
      spawns = room.find(FIND_MY_SPAWNS);
    }
    if (spawns.length === 0) continue;

    squad.processSpawnQueue(roomName);
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
    var freeSpawn = null;
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    } else {
      freeSpawn = home.find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } })[0];
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
  if (!Memory.demolitionCollectorQueue) Memory.demolitionCollectorQueue = [];

  for (let i = Memory.demolitionCollectorQueue.length - 1; i >= 0; i--) {
    const queueItem = Memory.demolitionCollectorQueue[i];
    const home = Game.rooms[queueItem.homeRoom];
    if (!home) { Memory.demolitionCollectorQueue.splice(i, 1); continue; }

    var rs = getRoomState.get(queueItem.homeRoom);
    var freeSpawn = null;
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    } else {
      freeSpawn = home.find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } })[0];
    }
    if (!freeSpawn) continue;

    const cost = bodyCost(queueItem.collectorBody);
    if (cost > freeSpawn.room.energyAvailable) {
      if (Game.time % 20 === 0) {
        console.log("[Demolition] Not enough energy in " + queueItem.homeRoom + " for collector. Have: " + freeSpawn.room.energyAvailable + ", Need: " + cost);
      }
      continue;
    }

    const collectorMemory = {
      role: 'demolition',
      demolitionRole: 'collector',
      homeRoom: queueItem.homeRoom,
      targetRoom: queueItem.targetRoom,
      partnerName: queueItem.demolisherName,
      teamId: queueItem.teamId
    };

    const result = freeSpawn.spawnCreep(queueItem.collectorBody, queueItem.collectorName, { memory: collectorMemory });
    if (result === OK) {
      console.log("[Demolition] Spawning collector '" + queueItem.collectorName + "' from " + queueItem.homeRoom + " for " + queueItem.targetRoom + ".");
      Memory.demolitionCollectorQueue.splice(i, 1);
    } else if (result !== ERR_BUSY) {
      console.log("[Demolition] Failed to spawn collector '" + queueItem.collectorName + "': " + result);
    }
  }

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
    var spawns = [];
    if (rsHome && rsHome.structuresByType && rsHome.structuresByType[STRUCTURE_SPAWN]) {
      spawns = rsHome.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
    } else {
      spawns = home.find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } });
    }
    if (spawns.length === 0) continue;

    const existingCreeps = _.filter(Game.creeps, function(c){
      return c.memory.role === 'demolition' &&
             c.memory.targetRoom === targetRoom &&
             c.memory.homeRoom === homeRoom;
    });

    const existingDemolishers = existingCreeps.filter(function(c){ return c.memory.demolitionRole === 'demolisher'; });
    const existingCollectors = existingCreeps.filter(function(c){ return c.memory.demolitionRole === 'collector'; });

    const teamIds = new Set();
    const completePairs = new Set();
    existingCreeps.forEach(function(creep){ if (creep.memory.teamId) teamIds.add(creep.memory.teamId); });
    teamIds.forEach(function(teamId){
      const teamDemolisher = existingDemolishers.find(function(c){ return c.memory.teamId === teamId; });
      const teamCollector = existingCollectors.find(function(c){ return c.memory.teamId === teamId; });
      if (teamDemolisher && teamCollector) completePairs.add(teamId);
    });

    const activeTeams = completePairs.size;
    const teamsNeeded = teamCount - activeTeams;

    if (Game.time % 20 === 0 && teamsNeeded > 0) {
      console.log("[Demolition] Order " + homeRoom + "->" + targetRoom + ": Need " + teamsNeeded + " teams, have " + activeTeams + " complete pairs");
    }

    for (let i = 0; i < teamsNeeded; i++) {
      const spawn = spawns[0];
      if (!spawn) break;

      const demolisherBody = [
        WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK,
        CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY,
        MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE
      ];
      const collectorBody = getCreepBody('supplier', spawn.room.energyAvailable);
      const demolisherCost = bodyCost(demolisherBody);

      if (demolisherCost > spawn.room.energyAvailable) {
        if (Game.time % 20 === 0) {
          console.log("[Demolition] Not enough energy in " + homeRoom + " for demolisher. Have: " + spawn.room.energyAvailable + ", Need: " + demolisherCost);
        }
        break;
      }

      const teamId = targetRoom + "_" + Game.time + "_" + Math.floor(Math.random() * 1000);
      const demolisherName = "Demolisher_" + teamId;
      const collectorName = "Collector_" + teamId;

      const demolisherMemory = {
        role: 'demolition',
        demolitionRole: 'demolisher',
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        partnerName: collectorName,
        teamId: teamId
      };

      const demolisherResult = spawn.spawnCreep(demolisherBody, demolisherName, { memory: demolisherMemory });
      if (demolisherResult === OK) {
        console.log("[Demolition] Spawning replacement demolisher '" + demolisherName + "' from " + homeRoom + " for " + targetRoom + ".");

        Memory.demolitionCollectorQueue.push({
          homeRoom: homeRoom,
          collectorName: collectorName,
          demolisherName: demolisherName,
          targetRoom: targetRoom,
          teamId: teamId,
          collectorBody: collectorBody
        });

        break;
      } else if (demolisherResult !== ERR_BUSY) {
        console.log("[Demolition] Failed to spawn replacement demolisher '" + demolisherName + "': " + demolisherResult);
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

    var stillBelow = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_WALL]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_WALL].length; i++) {
        var w = rs.structuresByType[STRUCTURE_WALL][i];
        if (w.hits < order.threshold) stillBelow.push(w);
      }
    } else {
      stillBelow = room.find(FIND_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_WALL && s.hits < order.threshold; }
      });
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
    } else {
      freeSpawn = room.find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } })[0];
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
    var freeSpawn = null;
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    } else {
      freeSpawn = home.find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } })[0];
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

function calculateRoomTotalEnergy(roomName) {
  const roomCache = Memory.roomData && Memory.roomData[roomName];
  if (!roomCache) return 0;

  const allIds = []
    .concat(roomCache.spawnIds || [])
    .concat(roomCache.extensionIds || [])
    .concat(roomCache.containerIds || []);

  if (roomCache.storageId) allIds.push(roomCache.storageId);

  let total = 0;
  for (let i = 0; i < allIds.length; i++) {
    const obj = Game.getObjectById(allIds[i]);
    if (obj && obj.store) {
      total += obj.store.getUsedCapacity(RESOURCE_ENERGY);
    }
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
    var spawns = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      spawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
    } else {
      spawns = room.find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } });
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

    const body   = [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE];
    const name   = "extractor_" + roomName + "_" + (Game.time % 1000);
    const memory = { role: 'extractor', roomName: roomName, extractorId: extractor.id };
    const result = spawn.spawnCreep(body, name, { memory: memory });
    if (result === OK) {
      console.log("[Spawn] extractor for " + roomName);
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

  const claimBody = [MOVE, MOVE, ATTACK, CLAIM, MOVE];
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

// --- Spawn delay helpers for low RCL and low energy fill ---
function shouldApplySpawnDelay(room) {
  if (!room || !room.controller || !room.controller.my) return false;
  if (room.controller.level > 6) return false;
  if (room.energyCapacityAvailable <= 0) return false;
  const ratio = room.energyAvailable / room.energyCapacityAvailable;
  return ratio < LOW_RCL_ENERGY_FILL_THRESHOLD;
}

function handleRoomSpawnDelay(roomName, room) {
  if (!Memory.spawnDelayUntil) Memory.spawnDelayUntil = {};
  const existing = Memory.spawnDelayUntil[roomName];

  if (existing && Game.time < existing) return true;

  if (existing && Game.time >= existing) delete Memory.spawnDelayUntil[roomName];

  if (!Memory.spawnDelayUntil[roomName] && shouldApplySpawnDelay(room)) {
    Memory.spawnDelayUntil[roomName] = Game.time + LOW_RCL_SPAWN_DELAY_TICKS;
    if (Game.time % 10 === 0) {
      const percent = Math.round((room.energyAvailable / room.energyCapacityAvailable) * 100);
      console.log("[SpawnDelay] " + roomName + ": RCL " + room.controller.level + ", energy " + percent + "% < " + Math.round(LOW_RCL_ENERGY_FILL_THRESHOLD * 100) + "% -> delaying spawns for " + LOW_RCL_SPAWN_DELAY_TICKS + " ticks");
    }
    return true;
  }
  return false;
}

function spawnCreepInRoom(role, body, spawn, roomName) {
  const newName = role + "_" + roomName + "_" + Game.time;
  const memory  = { role: role, assignedRoom: roomName };
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

function getRoomTargets(roomName, roomData, room) {
  var rs = getRoomState.get(roomName);

  var containers = [];
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) {
    containers = rs.structuresByType[STRUCTURE_CONTAINER];
  } else {
    containers = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; } });
  }
  const storage = rs ? rs.storage : room.storage;
  const hasStorageStructures = containers.length > 0 || !!storage;

  var constructionSitesCount = 0;
  if (rs && rs.constructionSites) {
    constructionSitesCount = rs.constructionSites.length;
  } else {
    var r = Game.rooms[roomName];
    constructionSitesCount = (r && r.find(FIND_CONSTRUCTION_SITES).length) || 0;
  }
  let builderTarget = +(constructionSitesCount > 0);

  return {
    harvester:   0,
    upgrader:    1,
    builder:     builderTarget,
    scout:       0,
    defender:    0,
    supplier:    hasStorageStructures ? 1 : 0
  };
}

function manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache) {
  if (Memory.claimOrders && Memory.claimOrders.length > 0) return;

  manageHarvesterSpawns();

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);

    var availableSpawns = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      availableSpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
    } else {
      availableSpawns = room.find(FIND_MY_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_SPAWN && !s.spawning; } });
    }
    if (availableSpawns.length === 0) continue;

    var roomData = roomDataCache[roomName] || {};
    var roleCounts = perRoomRoleCounts[roomName] || {};
    var roomTargets = getRoomTargets(roomName, roomData, room);

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
    if (roleCounts.upgrader  < roomTargets.upgrader)  spawnQueue.push('upgrader');
    if (roleCounts.builder   < roomTargets.builder)   spawnQueue.push('builder');
    if (roleCounts.scout     < roomTargets.scout)     spawnQueue.push('scout');

    var spawnsUsed = 0;
    for (var i = 0; i < spawnQueue.length; i++) {
      if (spawnsUsed >= availableSpawns.length) break;

      var roleToSpawn = spawnQueue[i];

      if (delayActive && roleToSpawn !== 'supplier') continue;

      var energyForSpawn = room.energyAvailable;
      if (roleToSpawn === 'upgrader') {
        var rcl = room.controller ? room.controller.level : 0;
        if (rcl === 8) {
          energyForSpawn = Math.min(energyForSpawn, 300);
        }
      }

      var body = getCreepBody(roleToSpawn, energyForSpawn);
      if (!body) continue;

      var success = spawnCreepInRoom(roleToSpawn, body, availableSpawns[spawnsUsed], roomName);
      if (success) {
        spawnsUsed++;
        if (roleCounts[roleToSpawn] === undefined) roleCounts[roleToSpawn] = 0;
        roleCounts[roleToSpawn]++;
      }
    }
  }
}

// ============================================================================
// One-call orchestrator for spawn systems (optional)
// Call this once per tick if you want this module to manage cadence internally.
// ============================================================================

function run(perRoomRoleCounts, roomDataCache) {
  if (Game.time % 5 === 0)  manageDemolitionSpawns();
  if (Game.time % 10 === 0) manageClaimbotSpawns();
  if (Game.time % 5 === 0)  manageAttackerSpawns();
  if (Game.time % 5 === 0)  manageTowerDrainSpawns();
  if (Game.time % 5 === 0)  manageThiefSpawns();
  if (Game.time % 5 === 0)  manageExtractorSpawns();
  if (Game.time % 10 === 0) spawnScavengers();
  if (Game.time % 2 === 0)  manageLabBotSpawns();
  if (Game.time % 2 === 0)  processSquadSpawnQueues();
  if (Game.time % 10 === 0) manageWallRepairSpawns();

  if (needsNewCreeps(perRoomRoleCounts) || Game.time % 10 === 0) {
    manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache);
  }
}

// Minimal helper to mirror main’s behavior
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
  processSquadSpawnQueues,
  spawnScavengers,

  // Utilities you use elsewhere
  getCreepBody,
  bodyCost,

  // Rarely called helpers
  spawnEmergencyHarvester,
  getRoomTargets,
  handleRoomSpawnDelay
};
