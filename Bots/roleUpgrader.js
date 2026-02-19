// role.upgrader.nearestControllerSource.js
var getRoomState = require('getRoomState');

var RCL8_THROTTLE_TICKS = 1;
var LINK_WAIT_TICKS = 10;

if (typeof global.SHOW_PATHS !== 'boolean') {
  global.SHOW_PATHS = false;
}

function moveOpts(color) {
  var opts = { reusePath: 20 };

  if (global.SHOW_PATHS) {
    opts.visualizePathStyle = { stroke: color || '#ffaa00' };
  }

  // UPDATED: Cost callback to avoid room edges (0 and 49)
  opts.costCallback = function(roomName, costMatrix) {
    // Loop through 0 to 49 to set the edges as unwalkable (cost 255)
    for (var i = 0; i < 50; i++) {
      costMatrix.set(i, 0, 255);  // Top edge
      costMatrix.set(i, 49, 255); // Bottom edge
      costMatrix.set(0, i, 255);  // Left edge
      costMatrix.set(49, i, 255); // Right edge
    }
    return costMatrix;
  };

  return opts;
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

// --- FIX 1: Optimized Spawning Check (via getRoomState) ---
// Now accepts the pre-cached 'myCreeps' array from getRoomState.
// No room.find() or Game.creeps iteration required.
function onlyUpgraderIsSpawning(myCreeps) {
  if (!myCreeps || myCreeps.length === 0) return false;

  var count = 0;
  var spawning = false;

  for (var i = 0; i < myCreeps.length; i++) {
    var c = myCreeps[i];
    // getRoomState filters by room already, so we just check role/spawning
    if (c.memory && c.memory.role === 'upgrader') {
      count++;
      if (c.spawning) spawning = true;
    }
  }
  return count === 1 && spawning;
}

// --- FIX 2 Helper: Cache Controller Structures ---
// Finds structures <= 3 range from controller and saves IDs to memory.
function getControllerStructIds(roomName, controllerPos, structuresByType) {
    // 1. Try to read from memory cache
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    var mem = Memory.rooms[roomName];

    // Check if cache exists and matches current layout version
    if (mem.controllerStructs && mem.controllerStructs.version === mem.layoutVersion) {
        return mem.controllerStructs.ids;
    }

    // 2. Cache miss: Find them manually using structuresByType from getRoomState
    var candidates = [];
    var typesToCheck = [STRUCTURE_LINK, STRUCTURE_CONTAINER];

    if (structuresByType) {
      typesToCheck.forEach(function(type) {
          var structs = structuresByType[type] || [];
          for(var i=0; i<structs.length; i++) {
              if (controllerPos.getRangeTo(structs[i]) <= 3) {
                  candidates.push(structs[i].id);
              }
          }
      });
    }

    // 3. Save to cache
    mem.controllerStructs = {
        ids: candidates,
        version: mem.layoutVersion || 0
    };

    return candidates;
}

// --- FIX 2: Updated Target Finder ---
function findEnergyWithdrawTarget(creep, state) {
  if (!state || !state.controller) return null;

  // PRIORITY 1: Local Controller Energy
  // Uses cached IDs + state.structuresByType to avoid recalculation
  var candidateIds = getControllerStructIds(state.name, state.controller.pos, state.structuresByType);
   
  var localCandidates = [];
  for (var i = 0; i < candidateIds.length; i++) {
      var s = Game.getObjectById(candidateIds[i]);
      if (s && structureHasEnergy(s)) {
          localCandidates.push(s);
      }
  }

  // Pick closest of the valid local candidates
  if (localCandidates.length > 0) {
    return creep.pos.findClosestByRange(localCandidates);
  }

  // PRIORITY 2: Storage with energy
  // state.storage is provided directly by getRoomState
  var storage = state.storage;
  if (storage && structureHasEnergy(storage)) {
    return storage;
  }

  return null;
}

function getClosestControllerSourceId(roomState) {
  if (!roomState || !roomState.controller) return null;

  var roomName = roomState.name;
  var sources = roomState.sources; // Provided by getRoomState
  if (!sources || sources.length === 0) return null;

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};

  var layoutVersion = Memory.rooms[roomName].layoutVersion || 0;
  var cached = Memory.rooms[roomName].closestControllerSource;
  if (cached && cached.id && cached.version === layoutVersion) {
    return cached.id;
  }

  var closest = roomState.controller.pos.findClosestByRange(sources);

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
    var result = creep.withdraw(target, RESOURCE_ENERGY);

    if (target.structureType === STRUCTURE_LINK) {
      if (result === ERR_NOT_ENOUGH_RESOURCES) {
        creep.memory.linkDryId = target.id;
        creep.memory.linkDryUntil = Game.time + LINK_WAIT_TICKS;
        return;
      }

      if (result === OK) {
        if (!structureHasEnergy(target)) {
          creep.memory.linkDryId = target.id;
          creep.memory.linkDryUntil = Game.time + LINK_WAIT_TICKS;
        }

        if (creep.store.getFreeCapacity() > 0) {
          creep.memory.working = true;
          creep.say('⚡ upgrade');
        }
      }
    }
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
    if (creep.spawning) return;

    getRoomState.init(); // Build cache for this tick

    var state = getRoomState.get(creep.room.name);
    if (!state || !state.controller) return;

    // FIX 1 APPLIED: Using optimized check with state.myCreeps
    if (onlyUpgraderIsSpawning(state.myCreeps)) return;

    // RETAINED #4 (RCL8 Throttle Logic)
    if (state.controller.my && state.controller.level === 8) {
      if (Game.time % RCL8_THROTTLE_TICKS !== 0) return;
    }

    if (creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.working = false;
      // RETAINED #3 (Say)
      creep.say('🔄 energy');
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      // RETAINED #3 (Say)
      creep.say('⚡ upgrade');
    }

    if (creep.memory.working) {
      doUpgrade(creep, state.controller);
      return;
    }

    if (creep.memory.linkDryId && typeof creep.memory.linkDryUntil === 'number') {
      if (Game.time < creep.memory.linkDryUntil) {
        var dryLink = Game.getObjectById(creep.memory.linkDryId);
        if (dryLink) {
          if (structureHasEnergy(dryLink)) {
            withdrawEnergy(creep, dryLink);
            delete creep.memory.linkDryId;
            delete creep.memory.linkDryUntil;
          } else {
            if (!creep.pos.isNearTo(dryLink)) {
              creep.moveTo(dryLink, moveOpts('#ffaa00'));
            }
          }
          return;
        }
      } else {
        delete creep.memory.linkDryId;
        delete creep.memory.linkDryUntil;
      }
    }

    // FIX 2 APPLIED: Using optimized cached target finder
    var withdrawTarget = findEnergyWithdrawTarget(creep, state);
    if (withdrawTarget) {
      withdrawEnergy(creep, withdrawTarget);
      return;
    }

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