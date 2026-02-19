// roleRepairBot.js
// Behavior:
// 1) Energy: withdraw from storage if available; otherwise from a container; otherwise idle
// 2) Repairs priority:
//    2A) First damaged containers (first found)
//    2B) If none, damaged roads (first found)
//    2C) If none, other damaged structures (exclude walls & ramparts)
//    2D) If none, walls or ramparts under 1,000,000 hits (pick the lowest hits)
// Notes:
// - Uses getRoomState for data access (no room.find calls here)
// - No optional chaining used
// - Caches current repair target in memory to reduce re-scanning CPU cost
// - Creep.repair works up to range 3; move within range if needed【1】
// - Structures expose hits/hitsMax which we use to decide damage【3】

const getRoomState = require('getRoomState');

const WALL_RAMPART_THRESHOLD = 1000000;
const RESCAN_COOLDOWN = 5; // ticks to wait before re-scanning when no target
const MOVE_OPTS_CLOSE = { reusePath: 10, range: 1 };
const MOVE_OPTS_REPAIR = { reusePath: 10, range: 3 };

function isDamaged(structure) {
  if (!structure) return false;
  if (typeof structure.hits !== 'number') return false;
  if (typeof structure.hitsMax !== 'number') return structure.hits > 0 && structure.hits < WALL_RAMPART_THRESHOLD; // fallback
  return structure.hits < structure.hitsMax;
}

function getEnergy(creep, rs) {
  // Prefer storage
  var storage = rs ? rs.storage : null;
  if (storage && storage.store) {
    var se = storage.store[RESOURCE_ENERGY] || 0;
    if (se > 0) {
      var w = creep.withdraw(storage, RESOURCE_ENERGY);
      if (w === ERR_NOT_IN_RANGE) creep.moveTo(storage, MOVE_OPTS_CLOSE);
      return true;
    }
  }

  // Otherwise the fullest container
  var bestContainer = null;
  var bestAmt = 0;
  var containers = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) ? rs.structuresByType[STRUCTURE_CONTAINER] : [];
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

  // Nothing to withdraw -> idle
  return false;
}

function pickRepairTarget(creep, rs) {
  if (!rs || !rs.structuresByType) return null;

  // 2A: damaged containers (first found)
  var containers = rs.structuresByType[STRUCTURE_CONTAINER] || [];
  for (var i = 0; i < containers.length; i++) {
    var cont = containers[i];
    if (isDamaged(cont)) return cont;
  }

  // 2B: damaged roads (first found)
  var roads = rs.structuresByType[STRUCTURE_ROAD] || [];
  for (var r = 0; r < roads.length; r++) {
    var road = roads[r];
    if (isDamaged(road)) return road;
  }

  // 2C: damaged "other" structures excluding walls/ramparts/containers/roads
  // iterate by type to avoid big room.find calls
  var sbt = rs.structuresByType;
  for (var t in sbt) {
    if (!sbt.hasOwnProperty(t)) continue;
    if (t === STRUCTURE_WALL || t === STRUCTURE_RAMPART || t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER) continue;
    var list = sbt[t];
    for (var j = 0; j < list.length; j++) {
      var s = list[j];
      if (isDamaged(s)) return s;
    }
  }

  // 2D: walls/ramparts under threshold - pick lowest hits
  var lowest = null;
  var walls = sbt[STRUCTURE_WALL] || [];
  for (var w = 0; w < walls.length; w++) {
    var wall = walls[w];
    if (!wall) continue;
    var hitsNum = typeof wall.hits === 'number' ? wall.hits : null;
    if (hitsNum !== null && hitsNum < WALL_RAMPART_THRESHOLD) {
      if (!lowest || hitsNum < lowest.hits) lowest = wall;
    }
  }
  var ramps = sbt[STRUCTURE_RAMPART] || [];
  for (var p = 0; p < ramps.length; p++) {
    var ramp = ramps[p];
    if (!ramp) continue;
    var rh = typeof ramp.hits === 'number' ? ramp.hits : null;
    if (rh !== null && rh < WALL_RAMPART_THRESHOLD) {
      if (!lowest || rh < lowest.hits) lowest = ramp;
    }
  }

  return lowest || null;
}

function ensureTarget(creep, rs) {
  // If we have a target, validate it
  if (creep.memory.repairTargetId) {
    var t = Game.getObjectById(creep.memory.repairTargetId);
    if (!t) {
      creep.memory.repairTargetId = null;
    } else {
      // If it’s fully repaired, or (for wall/rampart) above threshold when we’re in 2D mode
      var tType = t.structureType;
      var fully = !isDamaged(t);
      var overBarrierThresh = (tType === STRUCTURE_WALL || tType === STRUCTURE_RAMPART) &&
                              typeof t.hits === 'number' && t.hits >= WALL_RAMPART_THRESHOLD;

      if (fully || overBarrierThresh) {
        creep.memory.repairTargetId = null;
      }
    }
  }

  // If no target, throttle scans
  if (!creep.memory.repairTargetId) {
    if (!creep.memory.nextScan || Game.time >= creep.memory.nextScan) {
      var pick = pickRepairTarget(creep, rs);
      creep.memory.repairTargetId = pick ? pick.id : null;
      creep.memory.nextScan = Game.time + RESCAN_COOLDOWN;
    }
  }

  return creep.memory.repairTargetId ? Game.getObjectById(creep.memory.repairTargetId) : null;
}

function park(creep, rs) {
  // Idle near storage if present, else near controller center-ish
  var storage = rs ? rs.storage : null;
  if (storage) {
    creep.moveTo(storage, { reusePath: 20, range: 3 });
  } else if (rs && rs.controller) {
    creep.moveTo(rs.controller, { reusePath: 20, range: 3 });
  }
}

function work(creep, rs) {
  // Maintain working state
  if (creep.memory.working !== true && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
  }
  if (creep.memory.working === true && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.memory.repairTargetId = null; // drop target to seek energy
  }

  if (!creep.memory.working) {
    var acted = getEnergy(creep, rs); // withdraw storage -> container
    if (!acted) park(creep, rs);
    return;
  }

  // Working: find/keep a target and repair
  var target = ensureTarget(creep, rs);
  if (!target) {
    park(creep, rs);
    return;
  }

  var res = creep.repair(target);
  if (res === ERR_NOT_IN_RANGE) {
    creep.moveTo(target, MOVE_OPTS_REPAIR);
  } else if (res === ERR_INVALID_TARGET || res === ERR_NO_BODYPART) {
    // Fail-fast: invalid or cannot repair -> clear and rescan soon
    creep.memory.repairTargetId = null;
    creep.memory.nextScan = Game.time + 1;
  }
}

function run(creep) {
  var roomName = creep.room && creep.room.name ? creep.room.name : null;
  if (!roomName) return;

  var rs = getRoomState.get(roomName);
  work(creep, rs);
}

module.exports = { run: run };
