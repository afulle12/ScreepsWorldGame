// roleRampartBot.js
// Spawned when any critical or external rampart drops below its
// per-structure spawn threshold (target - 400k).
// Primary goal: repair ramparts adjacent to protected structures up to
//               the per-structure target HP.
// Secondary goal: repair external (perimeter) ramparts up to EXTERNAL_TARGET.
// Uses the wallRepair body for sustained heavy repair work.
// On confirmed empty rebuild: deposits remaining energy into storage and
// suicides with a cooldown so the spawn manager doesn't immediately re-trigger.

const getRoomState = require('getRoomState');
const boostManager = require('boostManager');

// ─── Per-structure rampart targets ────────────────────────────────────────────
var STRUCTURE_RAMPART_TARGETS = {};
STRUCTURE_RAMPART_TARGETS[STRUCTURE_SPAWN]       = 60500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_TERMINAL]    = 60500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_STORAGE]     = 60500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_TOWER]       =  5500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_LINK]        =  5500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_NUKER]       = 10500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_FACTORY]     =  5500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_LAB]         =  5500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_POWER_SPAWN] = 10500000;
STRUCTURE_RAMPART_TARGETS[STRUCTURE_OBSERVER]    =  5500000;

var EXTERNAL_TARGET = 50000000;
var SPAWN_THRESHOLD_OFFSET = 400000;

// All structure types that get rampart protection
var PROTECTED_STRUCTURES = Object.keys(STRUCTURE_RAMPART_TARGETS);

const PERIMETER_RANGE  = 3;
const MAX_TARGETS      = 25;
const SPAWN_COOLDOWN   = 100;

// [CPU] How many ticks to wait before attempting another queue rebuild after
// the queue empties. Prevents hammering buildRepairQueue every tick when all
// ramparts are above threshold.
const REBUILD_COOLDOWN = 20;

// ─── Movement helpers ─────────────────────────────────────────────────────────

function blockEdges(roomName, costMatrix) {
  for (var i = 0; i <= 49; i++) {
    costMatrix.set(0,  i,  255);
    costMatrix.set(49, i,  255);
    costMatrix.set(i,  0,  255);
    costMatrix.set(i,  49, 255);
  }
  return costMatrix;
}

const MOVE_OPTS_CLOSE  = { reusePath: 15, range: 1, costCallback: blockEdges };
const MOVE_OPTS_REPAIR = { reusePath: 15, range: 3, costCallback: blockEdges };

// ─── Boost helpers ────────────────────────────────────────────────────────────

function toLabArray(val) {
  if (!val) return [];
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) return val;
  return [];
}

function findReadyLab(labIds, compound) {
  for (var i = 0; i < labIds.length; i++) {
    var lab = Game.getObjectById(labIds[i]);
    if (!lab) continue;
    var hasComp = (lab.mineralType === compound) && (lab.mineralAmount || 0) >= 30;
    var hasEn   = lab.store && (lab.store.getUsedCapacity(RESOURCE_ENERGY) || 0) >= 20;
    if (hasComp && hasEn) return lab;
  }
  return null;
}

function findFirstValidLab(labIds) {
  for (var i = 0; i < labIds.length; i++) {
    var lab = Game.getObjectById(labIds[i]);
    if (lab) return lab;
  }
  return null;
}

// ─── Classification helpers ───────────────────────────────────────────────────

function isExternalRampart(rampart) {
  var x = rampart.pos.x;
  var y = rampart.pos.y;
  return (x <= PERIMETER_RANGE || x >= 49 - PERIMETER_RANGE ||
          y <= PERIMETER_RANGE || y >= 49 - PERIMETER_RANGE);
}

/**
 * Returns the repair target for a rampart based on adjacent structures.
 * Picks the HIGHEST target among all structures within range 1.
 * Falls back to EXTERNAL_TARGET if it's a perimeter rampart, else 0.
 * Clamps the final target to RAMPART_HITS_MAX[rcl] so we never queue
 * an impossible repair goal.
 */
function getRampartTarget(rampart, structurePositions, rcl) {
  var maxTarget = 0;

  for (var i = 0; i < structurePositions.length; i++) {
    var sp = structurePositions[i];
    if (rampart.pos.getRangeTo(sp.pos) <= 1) {
      if (sp.target > maxTarget) maxTarget = sp.target;
    }
  }

  if (maxTarget === 0 && isExternalRampart(rampart)) {
    maxTarget = EXTERNAL_TARGET;
  }

  if (maxTarget === 0) return 0;

  // Cap at the RCL-imposed rampart maximum so we don't endlessly chase HP we
  // can't actually deposit (e.g. RCL 4 caps ramparts at 3M, RCL 5 at 10M).
  var rclCap = RAMPART_HITS_MAX[rcl] || 0;
  if (rclCap > 0 && maxTarget > rclCap) maxTarget = rclCap;

  return maxTarget;
}

/**
 * Builds a list of { pos, target } for all protected structures in the room.
 */
function getStructurePositionsWithTargets(rs) {
  var results = [];
  if (!rs || !rs.structuresByType) return results;

  for (var i = 0; i < PROTECTED_STRUCTURES.length; i++) {
    var sType = PROTECTED_STRUCTURES[i];
    var target = STRUCTURE_RAMPART_TARGETS[sType];
    var arr = rs.structuresByType[sType] || [];
    for (var j = 0; j < arr.length; j++) {
      if (arr[j] && arr[j].pos) {
        results.push({ pos: arr[j].pos, target: target });
      }
    }
  }

  return results;
}

// ─── Route planning ───────────────────────────────────────────────────────────

function buildRepairQueue(creep, rs, rcl) {
  if (!rs || !rs.structuresByType) return { ids: [], thresholds: {} };

  var ramparts = rs.structuresByType[STRUCTURE_RAMPART] || [];
  if (ramparts.length === 0) return { ids: [], thresholds: {} };

  var structurePositions = getStructurePositionsWithTargets(rs);

  // Bucket ramparts by target (descending priority = higher targets first)
  var buckets = {};  // target -> [rampart, ...]

  for (var i = 0; i < ramparts.length; i++) {
    var ramp = ramparts[i];
    if (!ramp || !ramp.my || typeof ramp.hits !== 'number') continue;

    var target = getRampartTarget(ramp, structurePositions, rcl);
    if (target <= 0 || ramp.hits >= target) continue;

    if (!buckets[target]) buckets[target] = [];
    buckets[target].push(ramp);
  }

  // Sort bucket keys descending (highest priority first)
  var targetKeys = Object.keys(buckets).map(Number).sort(function(a, b) { return b - a; });

  var route = [];
  var thresholds = {};

  function greedyOrder(targets, threshold) {
    var remaining = targets.slice();
    var cur = (route.length > 0)
      ? Game.getObjectById(route[route.length - 1])
      : creep;
    if (!cur) cur = creep;
    var curPos = cur.pos || creep.pos;

    while (route.length < MAX_TARGETS && remaining.length > 0) {
      var bestIdx  = 0;
      var bestDist = curPos.getRangeTo(remaining[0].pos);

      for (var j = 1; j < remaining.length; j++) {
        var d = curPos.getRangeTo(remaining[j].pos);
        if (d < bestDist) { bestDist = d; bestIdx = j; }
      }

      var picked = remaining.splice(bestIdx, 1)[0];
      route.push(picked.id);
      thresholds[picked.id] = threshold;
      curPos = picked.pos;
    }
  }

  for (var k = 0; k < targetKeys.length; k++) {
    greedyOrder(buckets[targetKeys[k]], targetKeys[k]);
  }

  return { ids: route, thresholds: thresholds };
}

// ─── Energy helpers ───────────────────────────────────────────────────────────

// [CPU] Caches the chosen energy source ID in creep.memory.energySourceId so
// the container scan only runs when the cache is stale (source gone or empty).
function getEnergy(creep, rs) {
  var storage = rs ? rs.storage : null;

  // Prefer storage when it has energy.
  if (storage && storage.store && (storage.store[RESOURCE_ENERGY] || 0) > 0) {
    // [MEM] Clear any cached container ID — storage takes priority.
    if (creep.memory.energySourceId) delete creep.memory.energySourceId;

    if (creep.pos.isNearTo(storage)) {
      creep.withdraw(storage, RESOURCE_ENERGY);
    } else {
      creep.moveTo(storage, MOVE_OPTS_CLOSE);
    }
    return true;
  }

  // [CPU] Try the cached container first before scanning the full list.
  if (creep.memory.energySourceId) {
    var cached = Game.getObjectById(creep.memory.energySourceId);
    if (cached && cached.store && (cached.store[RESOURCE_ENERGY] || 0) > 0) {
      if (creep.pos.isNearTo(cached)) {
        creep.withdraw(cached, RESOURCE_ENERGY);
      } else {
        creep.moveTo(cached, MOVE_OPTS_CLOSE);
      }
      return true;
    }
    // Cache miss — source is gone or empty, clear it and fall through to scan.
    delete creep.memory.energySourceId;
  }

  // Full container scan (only runs when cache is stale).
  var containers = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) || [];
  var best    = null;
  var bestAmt = 0;

  for (var i = 0; i < containers.length; i++) {
    var c = containers[i];
    if (!c || !c.store) continue;
    var amt = c.store[RESOURCE_ENERGY] || 0;
    if (amt > bestAmt) { bestAmt = amt; best = c; }
  }

  if (best) {
    // [MEM] Cache the winner so we skip this scan next tick.
    creep.memory.energySourceId = best.id;
    if (creep.pos.isNearTo(best)) {
      creep.withdraw(best, RESOURCE_ENERGY);
    } else {
      creep.moveTo(best, MOVE_OPTS_CLOSE);
    }
    return true;
  }

  return false;
}

// ─── End-of-life ──────────────────────────────────────────────────────────────

// [MEM] Purges all transient memory keys before suiciding so the heap stays
// clean in the tick the creep dies (Screeps keeps the memory object alive
// briefly after suicide).
function cleanupMemory(creep) {
  delete creep.memory.repairQueue;
  delete creep.memory.repairThresholds;
  delete creep.memory.rcl;
  delete creep.memory.working;
  delete creep.memory.energySourceId;
  delete creep.memory.rebuildCooldown;
  delete creep.memory.pendingSuicide;
  delete creep.memory.boosted;
  delete creep.memory.unboosted;
  delete creep.memory.unboostDone;
  delete creep.memory.needsBoost;
  delete creep.memory.boostLabs;
}

function depositAndSuicide(creep, rs) {
  if (creep.store[RESOURCE_ENERGY] > 0) {
    var storage = rs ? rs.storage : null;
    if (storage) {
      if (creep.pos.isNearTo(storage)) {
        creep.transfer(storage, RESOURCE_ENERGY);
        creep.memory.pendingSuicide = true;
      } else {
        creep.moveTo(storage, MOVE_OPTS_CLOSE);
      }
      return;
    }
  }
  Memory['rampartBotCooldown_' + creep.room.name] = Game.time + SPAWN_COOLDOWN;
  cleanupMemory(creep);
  creep.suicide();
}

// ─── Main loop ────────────────────────────────────────────────────────────────

function run(creep) {
  // CPU throttle
  if (Memory.cpuStats && Memory.cpuStats.average > 25) {
    creep.say('💤');
    return;
  }

  var roomName = creep.room && creep.room.name ? creep.room.name : null;
  if (!roomName) return;

  var rs = getRoomState.get(roomName);
  if (!rs) return;

  var room = Game.rooms[roomName];
  var rcl  = (room && room.controller) ? room.controller.level : 0;

  // ── BOOST CHECK — visit labs before starting repair work ──────────────────
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

      var readyLab = findReadyLab(labIds, compound);

      if (readyLab) {
        if (creep.pos.isNearTo(readyLab)) {
          var result = readyLab.boostCreep(creep);
          if (result === OK) {
            if (!creep.memory.boosted) creep.memory.boosted = {};
            creep.memory.boosted[compound] = true;
            boostManager.recordBoost(roomName, creep.memory.role, compound);
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
          creep.moveTo(readyLab, { range: 1, reusePath: 5, costCallback: blockEdges });
          creep.say('🧪');
        }
      } else {
        var waitLab = findFirstValidLab(labIds);
        if (waitLab && !creep.pos.inRangeTo(waitLab, 3)) {
          creep.moveTo(waitLab, { range: 3, reusePath: 10, costCallback: blockEdges });
        }
        creep.say('⏳');
      }
      return;
    }

    if (allBoosted) {
      creep.memory.needsBoost = false;
      // [MEM] boostLabs is only needed during the boost phase; drop it now.
      delete creep.memory.boostLabs;
      console.log('[BoostManager] ' + creep.name + ' fully boosted, starting repair');
    } else {
      return;
    }
  }

  // ── UNBOOST CHECK — recover 50% of compound when TTL is low ──────────────
  if (creep.memory.boosted &&
      typeof creep.ticksToLive === 'number' &&
      creep.ticksToLive < boostManager.UNBOOST_TTL_THRESHOLD &&
      !creep.memory.unboosted) {

    if (boostManager.shouldUnboost(roomName, creep.memory.role)) {
      var unboostTarget = boostManager.getUnboostTarget(
        roomName, creep.memory.role, creep.memory.boosted
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
                ' (' + unboostTarget.compound + ') → lab ' + unboostLab.id.substr(-4));
            } else if (ubResult === ERR_NOT_FOUND) {
              delete creep.memory.boosted[unboostTarget.compound];
            } else if (Game.time % 5 === 0) {
              console.log('[BoostManager] unboostCreep failed: ' + ubResult);
            }
          } else {
            creep.moveTo(unboostLab, { range: 1, reusePath: 3, costCallback: blockEdges });
            creep.say('♻️');
          }
          return;
        }
      }
    }

    // No valid unboost target — let creep die normally.
    creep.memory.unboosted = true;
    // [MEM] unboostDone is only meaningful during unboosting; clear it now.
    delete creep.memory.unboostDone;
  }

  // ── ORIGINAL REPAIR LOGIC ─────────────────────────────────────────────────

  // Deferred suicide — transfer was issued last tick, now safe to die.
  if (creep.memory.pendingSuicide) {
    Memory['rampartBotCooldown_' + roomName] = Game.time + SPAWN_COOLDOWN;
    cleanupMemory(creep);
    creep.suicide();
    return;
  }

  // Build queue exactly once, on first tick.
  if (!creep.memory.repairQueue) {
    var queueData = buildRepairQueue(creep, rs, rcl);
    creep.memory.repairQueue     = queueData.ids;
    creep.memory.repairThresholds = queueData.thresholds;
    creep.memory.rcl              = rcl;
    if (creep.memory.repairQueue.length === 0) {
      depositAndSuicide(creep, rs);
      return;
    }
    console.log('[RampartBot] ' + creep.name + ' queued ' +
      creep.memory.repairQueue.length + ' ramparts in ' + roomName +
      ' (RCL ' + rcl + ')');
  }

  // Queue exhausted — try to rebuild, but honour the rebuild cooldown so we
  // don't call buildRepairQueue (expensive getRangeTo loops) every tick while
  // all ramparts happen to be above threshold.
  if (creep.memory.repairQueue.length === 0) {
    // [CPU] Skip rebuild attempt until the cooldown expires.
    if (creep.memory.rebuildCooldown && Game.time < creep.memory.rebuildCooldown) {
      return;
    }

    var rebuilt = buildRepairQueue(creep, rs, rcl);
    if (rebuilt.ids.length > 0) {
      creep.memory.repairQueue      = rebuilt.ids;
      creep.memory.repairThresholds = rebuilt.thresholds;
      // [MEM] Clear the cooldown now that we have real work again.
      delete creep.memory.rebuildCooldown;
      console.log('[RampartBot] ' + creep.name + ' rebuilt queue with ' +
        rebuilt.ids.length + ' ramparts in ' + roomName);
      return;
    }

    // Still nothing to do — set a cooldown before trying again.
    creep.memory.rebuildCooldown = Game.time + REBUILD_COOLDOWN;
    depositAndSuicide(creep, rs);
    return;
  }

  // Energy state toggle.
  if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
    // [MEM] Energy source is now irrelevant until the next refuel cycle.
    delete creep.memory.energySourceId;
  }
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
  }

  // Refuel.
  if (!creep.memory.working) {
    getEnergy(creep, rs);
    return;
  }

  // Repair current head of queue.
  var targetId = creep.memory.repairQueue[0];
  var target   = Game.getObjectById(targetId);

  var doneThreshold = (creep.memory.repairThresholds && creep.memory.repairThresholds[targetId])
    ? creep.memory.repairThresholds[targetId]
    : 0;

  if (!target ||
      (typeof target.hits === 'number' && target.hits >= doneThreshold)) {
    creep.memory.repairQueue.shift();
    // [MEM] Drop the threshold entry as soon as the target is done.
    if (creep.memory.repairThresholds) {
      delete creep.memory.repairThresholds[targetId];
    }
    return;
  }

  if (creep.pos.inRangeTo(target, 3)) {
    var res = creep.repair(target);
    if (res === ERR_NOT_ENOUGH_ENERGY) {
      creep.memory.working = false;
    } else if (res === ERR_INVALID_TARGET || res === ERR_NO_BODYPART) {
      creep.memory.repairQueue.shift();
      if (creep.memory.repairThresholds) {
        delete creep.memory.repairThresholds[targetId];
      }
    }
  } else {
    creep.moveTo(target, MOVE_OPTS_REPAIR);
  }
}

module.exports = { run: run };
