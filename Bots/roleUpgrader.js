// role.upgrader.nearestControllerSource.js
var getRoomState = require('getRoomState');
var boostManager = require('boostManager');

var RCL8_THROTTLE_TICKS = 1;
var LINK_WAIT_TICKS = 10;
var CONTAINER_WAIT_TICKS = 10;

if (typeof global.SHOW_PATHS !== 'boolean') {
  global.SHOW_PATHS = false;
}

function moveOpts(color) {
  var opts = { reusePath: 20 };

  if (global.SHOW_PATHS) {
    opts.visualizePathStyle = { stroke: color || '#ffaa00' };
  }

  opts.costCallback = function(roomName, costMatrix) {
    for (var i = 0; i < 50; i++) {
      costMatrix.set(i, 0, 255);
      costMatrix.set(i, 49, 255);
      costMatrix.set(0, i, 255);
      costMatrix.set(49, i, 255);
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

function onlyUpgraderIsSpawning(myCreeps) {
  if (!myCreeps || myCreeps.length === 0) return false;

  var count = 0;
  var spawning = false;

  for (var i = 0; i < myCreeps.length; i++) {
    var c = myCreeps[i];
    if (c.memory && c.memory.role === 'upgrader') {
      count++;
      if (c.spawning) spawning = true;
    }
  }
  return count === 1 && spawning;
}

function getLayoutVersion(roomName) {
  return (Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].layoutVersion) || 0;
}

function getControllerStructIds(roomName, controllerPos, structuresByType) {
  if (!Memory.upgrader) Memory.upgrader = {};
  if (!Memory.upgrader[roomName]) Memory.upgrader[roomName] = {};
  var mem = Memory.upgrader[roomName];

  var layoutVersion = getLayoutVersion(roomName);

  // Added a tick throttle (Game.time % 100 !== 0) so it periodically refreshes the layout
  if (mem.controllerStructs &&
      mem.controllerStructs.version === layoutVersion &&
      mem.controllerStructs.ids.length > 0 &&
      Game.time % 100 !== 0) {
    return mem.controllerStructs.ids;
  }

  var candidates = [];
  var typesToCheck = [STRUCTURE_LINK, STRUCTURE_CONTAINER];

  if (structuresByType) {
    typesToCheck.forEach(function(type) {
      var structs = structuresByType[type] || [];
      for (var i = 0; i < structs.length; i++) {
        if (controllerPos.getRangeTo(structs[i]) <= 3) {
          candidates.push(structs[i].id);
        }
      }
    });
  }

  if (candidates.length === 0) {
    return candidates;
  }

  mem.controllerStructs = { ids: candidates, version: layoutVersion };
  return candidates;
}

function findEnergyWithdrawTarget(creep, state) {
  if (!state || !state.controller) return null;

  var candidateIds = getControllerStructIds(state.name, state.controller.pos, state.structuresByType);

  var localCandidates = [];
  for (var i = 0; i < candidateIds.length; i++) {
    var s = Game.getObjectById(candidateIds[i]);
    if (s && structureHasEnergy(s)) {
      localCandidates.push(s);
    }
  }

  if (localCandidates.length > 0) {
    return creep.pos.findClosestByRange(localCandidates);
  }

  var storage = state.storage;
  if (storage && structureHasEnergy(storage)) {
    return storage;
  }

  return null;
}

/**
 * Returns an array of source IDs sorted nearest-to-farthest from the
 * controller. The sorted list is cached by layoutVersion so the sort only
 * runs when the room layout changes.
 */
function getRankedControllerSourceIds(roomState) {
  if (!roomState || !roomState.controller) return [];

  var roomName = roomState.name;
  var sources = roomState.sources;
  if (!sources || sources.length === 0) return [];

  if (!Memory.upgrader) Memory.upgrader = {};
  if (!Memory.upgrader[roomName]) Memory.upgrader[roomName] = {};
  var mem = Memory.upgrader[roomName];

  var layoutVersion = getLayoutVersion(roomName);

  if (mem.rankedControllerSources &&
      mem.rankedControllerSources.ids &&
      mem.rankedControllerSources.version === layoutVersion) {
    return mem.rankedControllerSources.ids;
  }

  // Sort all sources by range from the controller, nearest first.
  var sorted = sources.slice().sort(function(a, b) {
    return roomState.controller.pos.getRangeTo(a.pos) -
           roomState.controller.pos.getRangeTo(b.pos);
  });

  var ids = sorted.map(function(s) { return s.id; });
  mem.rankedControllerSources = { ids: ids, version: layoutVersion };
  return ids;
}

/**
 * Counts non-wall tiles within range 1 of a position.
 * This is the maximum number of creeps that can harvest a source simultaneously.
 */
function countWalkableAdjacentTiles(pos, room) {
  var count = 0;
  var terrain = room.getTerrain();
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = pos.x + dx;
      var y = pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Counts creeps currently targeting or standing at a source.
 * Uses memory.sourceId for predictive targeting; falls back to physical
 * presence for creeps that don't set sourceId.
 */
function countCreepsAtSource(sourceId, source, myCreeps) {
  if (!myCreeps) return 0;
  var count = 0;
  for (var i = 0; i < myCreeps.length; i++) {
    var c = myCreeps[i];
    if (c.spawning) continue;
    if (c.memory && c.memory.sourceId === sourceId) {
      count++;
    } else if (source && c.pos.isNearTo(source)) {
      count++;
    }
  }
  return count;
}

/**
 * Walks the ranked source ID list and returns the first source that:
 *   1. Has energy remaining, and
 *   2. Has at least one open harvesting spot.
 *
 * Falls back to the first valid source in the list if none pass both checks,
 * so the creep always has somewhere to go.
 */
function pickAvailableSource(rankedIds, room, myCreeps) {
  if (!rankedIds || rankedIds.length === 0) return null;

  var firstValid = null;

  for (var i = 0; i < rankedIds.length; i++) {
    var src = Game.getObjectById(rankedIds[i]);
    if (!src) continue;

    if (!firstValid) firstValid = src;

    if (src.energy <= 0) continue;

    var walkable = countWalkableAdjacentTiles(src.pos, room);
    var occupied = countCreepsAtSource(src.id, src, myCreeps);

    if (occupied < walkable) {
      return src;
    }
  }

  // All sources are either empty or fully occupied — return nearest as fallback
  // so the creep waits in the best position for the next regeneration.
  return firstValid;
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

    // Apply dry-wait to controller containers at RCL 5 or lower so the
    // upgrader stays put rather than wandering off when the container runs dry.
    if (target.structureType === STRUCTURE_CONTAINER &&
        creep.room.controller &&
        creep.room.controller.level <= 5) {
      if (result === ERR_NOT_ENOUGH_RESOURCES) {
        creep.memory.linkDryId = target.id;
        creep.memory.linkDryUntil = Game.time + CONTAINER_WAIT_TICKS;
        return;
      }
      if (result === OK && !structureHasEnergy(target)) {
        creep.memory.linkDryId = target.id;
        creep.memory.linkDryUntil = Game.time + CONTAINER_WAIT_TICKS;
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

/**
 * Normalize boostLabs value to an array.
 * Handles old format (string) and new format (array).
 */
function toLabArray(val) {
  if (!val) return [];
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) return val;
  return [];
}

/**
 * Find the first lab from an array of IDs that has enough compound + energy
 * for one boost. Returns the lab object or null.
 */
function findReadyLab(labIds, compound) {
  for (var i = 0; i < labIds.length; i++) {
    var lab = Game.getObjectById(labIds[i]);
    if (!lab) continue;
    var hasComp = (lab.mineralType === compound) && (lab.mineralAmount || 0) >= 30;
    var hasEn = lab.store && (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= 20;
    if (hasComp && hasEn) return lab;
  }
  return null;
}

/**
 * Find the first valid lab object from an array of IDs (for waiting near).
 */
function findFirstValidLab(labIds) {
  for (var i = 0; i < labIds.length; i++) {
    var lab = Game.getObjectById(labIds[i]);
    if (lab) return lab;
  }
  return null;
}

var role = {
  run: function (creep) {
    if (creep.spawning) return;

    // ═══════════════════════════════════════════════════════════════════════
    // BOOST CHECK — Visit labs before starting normal behavior.
    // boostLabs format: { compound: [labId1, labId2, ...] } (multi-lab)
    // Also supports old format: { compound: 'labId' } (single lab)
    // ═══════════════════════════════════════════════════════════════════════
    if (creep.memory.needsBoost && creep.memory.boostLabs) {
      var allBoosted = true;

      for (var compound in creep.memory.boostLabs) {
        if (creep.memory.boosted && creep.memory.boosted[compound]) continue;
        allBoosted = false;

        var labIds = toLabArray(creep.memory.boostLabs[compound]);

        if (labIds.length === 0) {
          if (!creep.memory.boosted) creep.memory.boosted = {};
          creep.memory.boosted[compound] = true;
          console.log('[BoostManager] No labs for ' + creep.name + ', skipping ' + compound);
          continue;
        }

        // Find first lab with enough compound + energy
        var readyLab = findReadyLab(labIds, compound);

        if (readyLab) {
          if (creep.pos.isNearTo(readyLab)) {
            var result = readyLab.boostCreep(creep);
            if (result === OK) {
              if (!creep.memory.boosted) creep.memory.boosted = {};
              creep.memory.boosted[compound] = true;
              boostManager.recordBoost(creep.room.name, creep.memory.role, compound);
              creep.say('💪');
              console.log('[BoostManager] Boosted ' + creep.name + ' with ' + compound +
                ' from lab ' + readyLab.id.substr(-4));
            } else if (result === ERR_NOT_FOUND) {
              if (!creep.memory.boosted) creep.memory.boosted = {};
              creep.memory.boosted[compound] = true;
            } else if (Game.time % 10 === 0) {
              console.log('[BoostManager] boostCreep failed for ' + creep.name +
                ' (' + compound + '): ' + result);
            }
          } else {
            creep.moveTo(readyLab, { range: 1, reusePath: 5 });
            creep.say('🧪');
          }
        } else {
          // No lab ready — wait near the first valid lab
          var waitLab = findFirstValidLab(labIds);
          if (waitLab && !creep.pos.inRangeTo(waitLab, 3)) {
            creep.moveTo(waitLab, { range: 3, reusePath: 10 });
          }
          creep.say('⏳');
        }
        return; // Process one compound at a time
      }

      if (allBoosted) {
        creep.memory.needsBoost = false;
        console.log('[BoostManager] ' + creep.name + ' fully boosted, starting upgrade');
      } else {
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UNBOOST CHECK — When TTL is low, return to a boost lab to recover 50%
    // of compound. Searches all labIds for one with free space.
    // ═══════════════════════════════════════════════════════════════════════
    if (creep.memory.boosted &&
        typeof creep.ticksToLive === 'number' &&
        creep.ticksToLive < boostManager.UNBOOST_TTL_THRESHOLD &&
        !creep.memory.unboosted) {

      if (boostManager.shouldUnboost(creep.room.name, creep.memory.role)) {
        var unboostTarget = boostManager.getUnboostTarget(
          creep.room.name, creep.memory.role, creep.memory.boosted
        );

        if (unboostTarget) {
          var unboostLab = Game.getObjectById(unboostTarget.labId);
          if (unboostLab) {
            if (creep.pos.isNearTo(unboostLab)) {
              var ubResult = unboostLab.unboostCreep(creep);
              if (ubResult === OK) {
                if (!creep.memory.unboostDone) creep.memory.unboostDone = {};
                creep.memory.unboostDone[unboostTarget.compound] = true;
                delete creep.memory.boosted[unboostTarget.compound];
                console.log('[BoostManager] Unboosted ' + creep.name +
                  ' (' + unboostTarget.compound + ') — compound recovered to lab ' +
                  unboostLab.id.substr(-4));
              } else if (ubResult === ERR_NOT_FOUND) {
                delete creep.memory.boosted[unboostTarget.compound];
              } else if (Game.time % 5 === 0) {
                console.log('[BoostManager] unboostCreep failed: ' + ubResult);
              }
            } else {
              creep.moveTo(unboostLab, { range: 1, reusePath: 3 });
              creep.say('♻️');
            }
            return;
          }
        }

        creep.memory.unboosted = true;
      } else {
        creep.memory.unboosted = true;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ORIGINAL UPGRADER LOGIC (unchanged from here down)
    // ═══════════════════════════════════════════════════════════════════════

    getRoomState.init();

    var state = getRoomState.get(creep.room.name);
    if (!state || !state.controller) return;

    if (onlyUpgraderIsSpawning(state.myCreeps)) return;

    if (state.controller.my && state.controller.level === 8) {
      if (Game.time % RCL8_THROTTLE_TICKS !== 0) return;
    }

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

    var withdrawTarget = findEnergyWithdrawTarget(creep, state);
    if (withdrawTarget) {
      withdrawEnergy(creep, withdrawTarget);
      return;
    }

    // Get sources ranked nearest-to-farthest from the controller, then pick
    // the first one that has energy and an open harvesting spot. Falls back
    // to the nearest source if all are full or empty.
    var rankedIds = getRankedControllerSourceIds(state);
    var src = pickAvailableSource(rankedIds, creep.room, state.myCreeps);

    if (!src) return;

    // If the picked source is no longer in the game object cache, clear the
    // ranked list so it gets rebuilt next tick.
    if (!Game.getObjectById(src.id)) {
      if (Memory.upgrader && Memory.upgrader[creep.room.name]) {
        Memory.upgrader[creep.room.name].rankedControllerSources = null;
      }
      return;
    }

    harvestFromSource(creep, src);
  }
};

module.exports = role;