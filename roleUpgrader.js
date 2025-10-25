// role.upgrader.nearestControllerSource.js
// Purpose: Upgrader that withdraws from room energy storage if available; otherwise harvests from the Source nearest to the controller.
// Changes:
//   - Energy target selection by range (no path search).
//   - Path visuals behind global flag SHOW_PATHS.
//   - Cached closest-by-path source per room with invalidation via Memory.rooms[roomName].layoutVersion.
//   - Removed "any spawn is spawning" guard; added "skip if only upgrader is spawning".

var getRoomState = require('getRoomState');

var RCL8_THROTTLE_TICKS = 25;

// Global path-visual flag (default false). Set to true for debugging.
if (typeof global.SHOW_PATHS !== 'boolean') {
  global.SHOW_PATHS = false;
}

function moveOpts(color) {
  if (global.SHOW_PATHS) {
    return { reusePath: 20, visualizePathStyle: { stroke: color || '#ffaa00' } };
  }
  return { reusePath: 20 };
}

function structureHasEnergy(structure) {
  if (!structure) return false;
  if (structure.store && typeof structure.store.getUsedCapacity === 'function') {
    var amt = structure.store.getUsedCapacity(RESOURCE_ENERGY);
    return amt && amt > 0;
  }
  if (typeof structure.energy === 'number') {
    return structure.energy > 0;
  }
  return false;
}

// Skip role processing in a room when the only upgrader is currently spawning.
function onlyUpgraderIsSpawning(roomName) {
  var count = 0;
  var spawning = false;
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c) continue;
    if (!c.memory || c.memory.role !== 'upgrader') continue;
    if (!c.room || c.room.name !== roomName) continue;
    count++;
    if (c.spawning) spawning = true;
  }
  return count === 1 && spawning;
}

function findEnergyWithdrawTarget(creep, state) {
  if (!state || !state.controller) return null;

  var controllerPos = state.controller.pos;
  var candidates = [];

  // 1) Containers near controller (range <= 3) with energy
  var containers = state.structuresByType && state.structuresByType[STRUCTURE_CONTAINER]
    ? state.structuresByType[STRUCTURE_CONTAINER]
    : [];
  for (var i = 0; i < containers.length; i++) {
    var cont = containers[i];
    if (!cont) continue;
    if (controllerPos.getRangeTo(cont.pos) <= 3 && structureHasEnergy(cont)) {
      candidates.push(cont);
    }
  }

  // 2) Storage with energy
  var storage = state.storage;
  if (storage && structureHasEnergy(storage)) {
    candidates.push(storage);
  }

  // 3) Links near controller (range <= 3) with energy
  var links = state.structuresByType && state.structuresByType[STRUCTURE_LINK]
    ? state.structuresByType[STRUCTURE_LINK]
    : [];
  for (var j = 0; j < links.length; j++) {
    var link = links[j];
    if (!link) continue;
    if (controllerPos.getRangeTo(link.pos) <= 3 && structureHasEnergy(link)) {
      candidates.push(link);
    }
  }

  if (candidates.length === 0) return null;

  // Choose closest by range to the creep (cheap)
  var best = null;
  var bestRange = 9999;
  for (var k = 0; k < candidates.length; k++) {
    var s = candidates[k];
    var r = creep.pos.getRangeTo(s.pos);
    if (r < bestRange) {
      bestRange = r;
      best = s;
    }
  }
  return best;
}

// Cached closest-by-path source from controller, invalidated by room layoutVersion.
function getClosestControllerSourceId(roomState) {
  if (!roomState || !roomState.controller) return null;

  var roomName = roomState.name;
  var sources = roomState.sources;
  if (!sources || sources.length === 0) return null;

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};

  var layoutVersion = Memory.rooms[roomName].layoutVersion || 0;
  var cached = Memory.rooms[roomName].closestControllerSource;
  if (cached && cached.id && cached.version === layoutVersion) {
    return cached.id;
  }

  // Compute once per layoutVersion change: closest by path from controller
  var closest = roomState.controller.pos.findClosestByPath(sources);

  // Fallback: closest by range if path search fails
  if (!closest) {
    var best = null;
    var bestRange = 9999;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var r = roomState.controller.pos.getRangeTo(s.pos);
      if (r < bestRange) {
        bestRange = r;
        best = s;
      }
    }
    closest = best;
  }

  var id = closest ? closest.id : null;
  Memory.rooms[roomName].closestControllerSource = { id: id, version: layoutVersion };
  return id;
}

function withdrawEnergy(creep, target) {
  if (!target) return;
  if (creep.pos.isNearTo(target)) {
    creep.withdraw(target, RESOURCE_ENERGY);
  } else {
    creep.moveTo(target, moveOpts('#ffaa00'));
  }
}

function harvestFromSource(creep, source) {
  if (!source) return;
  if (creep.pos.isNearTo(source)) {
    creep.harvest(source);
  } else {
    creep.moveTo(source, moveOpts('#ffaa00'));
  }
}

function doUpgrade(creep, controller) {
  if (!controller) return;
  if (creep.pos.inRangeTo(controller, 3)) {
    creep.upgradeController(controller);
  } else {
    creep.moveTo(controller, moveOpts('#ffffff'));
  }
}

var role = {
  run: function (creep) {
    // Skip if this creep is still spawning.
    if (creep.spawning) return;

    // Build room cache for this tick (ensure it's called once globally if possible).
    getRoomState.init();

    var state = getRoomState.get(creep.room.name);
    if (!state || !state.controller) return;

    // New guard: if the only upgrader in this room is spawning, skip processing.
    if (onlyUpgraderIsSpawning(state.name)) return;

    // RCL8 throttle: if owned RCL8, only run every N ticks.
    if (state.controller.my && state.controller.level === 8) {
      if (Game.time % RCL8_THROTTLE_TICKS !== 0) return;
    }

    // State toggle
    if (creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.working = false;
      creep.say('🔄 energy');
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say('⚡ upgrade');
    }

    if (creep.memory.working) {
      doUpgrade(creep, state.controller);
      return;
    }

    // Not working (refill energy): try storage first, then harvest if none available
    var withdrawTarget = findEnergyWithdrawTarget(creep, state);
    if (withdrawTarget) {
      withdrawEnergy(creep, withdrawTarget);
      return;
    }

    // No energy storage with energy: harvest from nearest-to-controller Source (cached)
    var srcId = getClosestControllerSourceId(state);
    if (!srcId) return;

    var src = Game.getObjectById(srcId);
    if (!src) {
      if (Memory.rooms && Memory.rooms[creep.room.name]) {
        Memory.rooms[creep.room.name].closestControllerSource = null;
      }
      return;
    }

    harvestFromSource(creep, src);
  }
};

module.exports = role;
