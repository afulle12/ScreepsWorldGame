// roleDefenseRepair.js

var getRoomState = require('getRoomState');
var defenseMonitor = require('defenseMonitor');

var MOVE_OPTS_CLOSE  = { reusePath: 10, range: 1 };
var MOVE_OPTS_REPAIR = { reusePath: 10, range: 3 };

// How often (in ticks) the bot re-checks its completion condition
var RECHECK_INTERVAL = 10;

// ============================================================================
// Energy collection — prefer storage, then containers
// ============================================================================

function getEnergy(creep, rs) {
  var storage = rs ? rs.storage : null;
  if (storage && storage.store) {
    var se = storage.store[RESOURCE_ENERGY] || 0;
    if (se > 0) {
      var w = creep.withdraw(storage, RESOURCE_ENERGY);
      if (w === ERR_NOT_IN_RANGE) creep.moveTo(storage, MOVE_OPTS_CLOSE);
      return true;
    }
  }

  var bestContainer = null;
  var bestAmt = 0;
  var containers = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER])
    ? rs.structuresByType[STRUCTURE_CONTAINER] : [];
  for (var i = 0; i < containers.length; i++) {
    var c = containers[i];
    if (!c || !c.store) continue;
    var amt = c.store[RESOURCE_ENERGY] || 0;
    if (amt > bestAmt) {
      bestAmt = amt;
      bestContainer = c;
    }
  }
  if (bestContainer && bestAmt > 0) {
    var res = creep.withdraw(bestContainer, RESOURCE_ENERGY);
    if (res === ERR_NOT_IN_RANGE) creep.moveTo(bestContainer, MOVE_OPTS_CLOSE);
    return true;
  }

  return false;
}

// ============================================================================
// Pick the lowest-hits structure in the cluster
// ============================================================================

function pickClusterTarget(creep) {
  var clusterIds = creep.memory.clusterIds;
  if (!clusterIds || clusterIds.length === 0) return null;

  var roomName = creep.memory.homeRoom;
  var isSolo = creep.memory.solo;

  // For solo structures, the cap is the room median
  // For multi-structure clusters, repair lowest-hits (no cap — completion
  // is determined by isJobDone, not by individual structure thresholds)
  var median = 0;
  if (isSolo) {
    median = defenseMonitor.getRoomMedianHits(roomName);
  }

  var lowest = null;
  var lowestHits = Infinity;

  for (var i = 0; i < clusterIds.length; i++) {
    var s = Game.getObjectById(clusterIds[i]);
    if (!s) continue;
    if (typeof s.hits !== 'number' || typeof s.hitsMax !== 'number') continue;

    // Skip structures already at their target
    if (isSolo && s.hits >= median) continue;
    if (!isSolo && s.hits >= s.hitsMax) continue;

    if (s.hits < lowestHits) {
      lowestHits = s.hits;
      lowest = s;
    }
  }

  return lowest;
}

// ============================================================================
// Check if the bot's job is done
//   Solo:  hits >= room median
//   Multi: cluster is no longer the weakest section
// ============================================================================

function isJobDone(creep) {
  var roomName = creep.memory.homeRoom;
  if (!roomName) return true;

  // Only recheck periodically to save CPU
  if (creep.memory._lastWeakCheck && (Game.time - creep.memory._lastWeakCheck) < RECHECK_INTERVAL) {
    return creep.memory._lastWeakResult || false;
  }
  creep.memory._lastWeakCheck = Game.time;

  var isSolo = creep.memory.solo;

  // ----- SOLO: repair until hits >= room median -----
  if (isSolo) {
    var struct = Game.getObjectById(creep.memory.targetId);
    if (!struct) {
      // Structure destroyed — job done
      creep.memory._lastWeakResult = true;
      return true;
    }

    var median = defenseMonitor.getRoomMedianHits(roomName);

    if (typeof struct.hits === 'number' && struct.hits >= median) {
      console.log('[DefenseRepair] ' + creep.name + ': Solo structure in ' + roomName +
        ' reached median (' + struct.hits + ' >= ' + median + '). Job complete.');
      creep.memory._lastWeakResult = true;
      return true;
    }

    creep.memory._lastWeakResult = false;
    return false;
  }

  // ----- MULTI: repair until no longer the weakest cluster -----
  var allClusters = defenseMonitor.getAllClusters(roomName);
  if (!allClusters || allClusters.length <= 1) {
    // Only one cluster (or none) — keep repairing until dead or empty
    creep.memory._lastWeakResult = false;
    return false;
  }

  // Find our cluster in the room's cluster map
  var ourCluster = defenseMonitor.findClusterContaining(creep.memory.targetId, allClusters);
  if (!ourCluster) {
    // Try any ID in our list
    for (var i = 0; i < creep.memory.clusterIds.length; i++) {
      ourCluster = defenseMonitor.findClusterContaining(creep.memory.clusterIds[i], allClusters);
      if (ourCluster) break;
    }
  }

  if (!ourCluster) {
    // Can't find our cluster — structures gone, job done
    creep.memory._lastWeakResult = true;
    return true;
  }

  // Refresh live data
  var stats = defenseMonitor.getClusterMinHits(ourCluster.ids);
  ourCluster.minHits = stats.minHits;
  ourCluster.minId = stats.minId;

  var stillWeakest = defenseMonitor.isWeakestCluster(ourCluster, allClusters);

  if (!stillWeakest) {
    console.log('[DefenseRepair] ' + creep.name + ': Cluster in ' + roomName +
      ' is no longer the weakest section (minHits: ' + ourCluster.minHits +
      '). Job complete.');
  }

  creep.memory._lastWeakResult = !stillWeakest;
  return !stillWeakest;
}

// ============================================================================
// Park near storage or controller
// ============================================================================

function park(creep, rs) {
  var storage = rs ? rs.storage : null;
  if (storage) {
    creep.moveTo(storage, { reusePath: 20, range: 3 });
  } else if (rs && rs.controller) {
    creep.moveTo(rs.controller, { reusePath: 20, range: 3 });
  }
}

// ============================================================================
// Clear the repair order in Memory when done
// ============================================================================

function clearOrder(creep) {
  var roomName = creep.memory.homeRoom;
  if (!roomName) return;
  if (!Memory.defense || !Memory.defense.repairOrders || !Memory.defense.repairOrders[roomName]) return;

  var orders = Memory.defense.repairOrders[roomName];
  for (var i = orders.length - 1; i >= 0; i--) {
    if (orders[i].assignedCreep === creep.name) {
      orders.splice(i, 1);
      break;
    }
  }
}

// ============================================================================
// Recycle at nearest spawn
// ============================================================================

function tryRecycle(creep, rs) {
  if (!rs || !rs.structuresByType || !rs.structuresByType[STRUCTURE_SPAWN]) return false;
  var spawns = rs.structuresByType[STRUCTURE_SPAWN];
  for (var si = 0; si < spawns.length; si++) {
    if (spawns[si].my) {
      var result = spawns[si].recycleCreep(creep);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(spawns[si], MOVE_OPTS_CLOSE);
      }
      return true;
    }
  }
  return false;
}

// ============================================================================
// Main work logic
// ============================================================================

function work(creep, rs) {
  // Toggle working state
  if (creep.memory.working !== true && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
  }
  if (creep.memory.working === true && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.memory.repairId = null;
  }

  // Check completion condition
  if (isJobDone(creep)) {
    clearOrder(creep);
    if (!tryRecycle(creep, rs)) {
      park(creep, rs);
    }
    return;
  }

  // Collecting energy
  if (!creep.memory.working) {
    var acted = getEnergy(creep, rs);
    if (!acted) park(creep, rs);
    return;
  }

  // Pick repair target — cache to reduce scanning
  var target = null;
  if (creep.memory.repairId) {
    target = Game.getObjectById(creep.memory.repairId);

    // Validate cached target is still damaged
    if (target) {
      if (creep.memory.solo) {
        var median = defenseMonitor.getRoomMedianHits(creep.memory.homeRoom);
        if (typeof target.hits === 'number' && target.hits >= median) {
          target = null;
        }
      } else {
        if (typeof target.hits === 'number' && typeof target.hitsMax === 'number' && target.hits >= target.hitsMax) {
          target = null;
        }
      }
    }

    if (!target) {
      creep.memory.repairId = null;
    }
  }

  if (!target) {
    target = pickClusterTarget(creep);
    if (target) {
      creep.memory.repairId = target.id;
    }
  }

  if (!target) {
    // Nothing to repair — either at target or all gone
    clearOrder(creep);
    if (!tryRecycle(creep, rs)) {
      park(creep, rs);
    }
    return;
  }

  // Repair
  var res = creep.repair(target);
  if (res === ERR_NOT_IN_RANGE) {
    creep.moveTo(target, MOVE_OPTS_REPAIR);
  } else if (res === ERR_INVALID_TARGET || res === ERR_NO_BODYPART) {
    creep.memory.repairId = null;
  }
}

// ============================================================================
// Entry point
// ============================================================================

function run(creep) {
  var roomName = creep.room && creep.room.name ? creep.room.name : null;
  if (!roomName) return;

  var rs = getRoomState.get(roomName);
  work(creep, rs);
}

module.exports = { run: run };