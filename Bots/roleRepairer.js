// LLM: Read llmcontext.js before reviewing or changing this file.
// roleRepairer.js
// Generic repair executor for repairManager tasks. This module is safe to add
// before spawn migration because no existing creep uses role 'repairer'.

var getRoomState = require('getRoomState');
var defenseMonitor = require('defenseMonitor');
var repairManager = require('repairManager');
var util = require('util');

var REEVAL_TICKS_DEFAULT = 50;
var REEVAL_TICKS_ROADS = 20;
var REEVAL_TICKS_WALLS = 100;
var MOVE_OPTS_CLOSE = { reusePath: 15, range: 1 };
var MOVE_OPTS_REPAIR = { reusePath: 15, range: 3 };
var WALLREPAIR_THRESHOLD_BY_RCL = [0, 0, 10000, 50000, 200000, 1000000, 5000000, 10000000, 50000000];
var ROAD_REPAIR_TARGET = 0.80;
var CONTAINER_DONE_HITS = 244000;
var NUKE_GROUND_ZERO_DAMAGE = 10000000;
var NUKE_SPLASH_DAMAGE = 5000000;
var NUKE_SAFETY_MARGIN = 500000;
var RAMPARTBOT_EXTERNAL_TARGET = 50000000;
var RAMPARTBOT_PERIMETER_RANGE = 3;
var DEFENSE_REPAIR_TARGET_RATIO = 0.97;

var RAMPART_TARGETS = repairManager.constants.RAMPART_TARGETS;

function getHomeRoom(creep) {
  return (creep.memory && (creep.memory.homeRoom || creep.memory.assignedRoom)) || null;
}

var isEdge = util.isOnRoomEdge;

function isPerimeter(pos) {
  return pos.x <= RAMPARTBOT_PERIMETER_RANGE || pos.x >= 49 - RAMPARTBOT_PERIMETER_RANGE ||
    pos.y <= RAMPARTBOT_PERIMETER_RANGE || pos.y >= 49 - RAMPARTBOT_PERIMETER_RANGE;
}

var nudgeOffEdge = util.nudgeOffRoomEdge;

function blockEdgeSquares(costMatrix) {
  for (var x = 0; x < 50; x++) {
    costMatrix.set(x, 0, 255);
    costMatrix.set(x, 49, 255);
  }
  for (var y = 0; y < 50; y++) {
    costMatrix.set(0, y, 255);
    costMatrix.set(49, y, 255);
  }
}

function targetRoomName(target) {
  if (!target) return null;
  if (target.pos) return target.pos.roomName;
  return target.roomName || null;
}

function moveRepairer(creep, target, opts) {
  if (creep.fatigue > 0) return ERR_TIRED;
  if (isEdge(creep.pos) && nudgeOffEdge(creep)) return OK;

  var targetRoom = targetRoomName(target);
  var sameRoom = !targetRoom || targetRoom === creep.room.name;
  var moveOpts = {};
  opts = opts || {};
  for (var key in opts) moveOpts[key] = opts[key];

  if (sameRoom) {
    var originalCostCallback = moveOpts.costCallback;
    moveOpts.maxRooms = 1;
    moveOpts.costCallback = function(roomName, costMatrix) {
      var result = originalCostCallback ? originalCostCallback(roomName, costMatrix) : costMatrix;
      var matrix = result || costMatrix;
      if (roomName === creep.room.name) blockEdgeSquares(matrix);
      return matrix;
    };
  }

  return creep.moveTo(target, moveOpts);
}

function park(creep, roomName) {
  roomName = roomName || getHomeRoom(creep);
  if (!roomName) return;
  if (creep.room.name !== roomName) {
    moveRepairer(creep, new RoomPosition(25, 25, roomName), { reusePath: 20, range: 20 });
    return;
  }
  var storage = creep.room.storage;
  if (storage) moveRepairer(creep, storage, { reusePath: 20, range: 3 });
  else moveRepairer(creep, new RoomPosition(25, 25, roomName), { reusePath: 20, range: 5 });
}

function refill(creep, roomName) {
  roomName = roomName || getHomeRoom(creep);
  if (!roomName) return false;
  if (creep.room.name !== roomName) {
    moveRepairer(creep, new RoomPosition(25, 25, roomName), { reusePath: 20, range: 20 });
    return true;
  }

  var room = creep.room;
  if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.pos.isNearTo(room.storage)) creep.withdraw(room.storage, RESOURCE_ENERGY);
    else moveRepairer(creep, room.storage, MOVE_OPTS_CLOSE);
    return true;
  }

  if (room.terminal && room.terminal.store[RESOURCE_ENERGY] > 0) {
    if (creep.pos.isNearTo(room.terminal)) creep.withdraw(room.terminal, RESOURCE_ENERGY);
    else moveRepairer(creep, room.terminal, MOVE_OPTS_CLOSE);
    return true;
  }

  var rs = getRoomState.get(roomName);
  var containers = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) || [];
  var best = null;
  var bestAmt = 0;
  for (var i = 0; i < containers.length; i++) {
    var c = containers[i];
    if (!c || !c.store) continue;
    var amt = c.store[RESOURCE_ENERGY] || 0;
    if (amt > bestAmt) { best = c; bestAmt = amt; }
  }
  if (best) {
    if (creep.pos.isNearTo(best)) creep.withdraw(best, RESOURCE_ENERGY);
    else moveRepairer(creep, best, MOVE_OPTS_CLOSE);
    return true;
  }

  park(creep);
  return false;
}

function taskKind(task) { return task ? (task.k || task.kind) : null; }

function taskHome(task, creep) { return (task && (task.r || task.homeRoom)) || getHomeRoom(creep); }

function taskIds(task) { return (task && (task.i || task.structureIds)) || []; }

function taskSecondaryIds(task) { return (task && (task.s || task.secondaryIds)) || []; }

function taskClusterIds(task) { return (task && (task.c || task.clusterIds)) || []; }

function taskTargetHits(task, id, index) {
  if (!task) return 0;
  if (task.h) return task.h[index] || 0;
  if (task.targets) return task.targets[id] || 0;
  return deriveTargetHits(task, Game.getObjectById(id));
}

function nukeDamageAt(nukes, pos) {
  var total = 0;
  for (var i = 0; i < nukes.length; i++) {
    var nuke = nukes[i];
    var range = Math.max(Math.abs(nuke.pos.x - pos.x), Math.abs(nuke.pos.y - pos.y));
    if (range === 0) total += NUKE_GROUND_ZERO_DAMAGE;
    else if (range <= 2) total += NUKE_SPLASH_DAMAGE;
  }
  return total;
}

function getWallTarget(roomName, rcl) {
  var rm = Memory.repairManager && Memory.repairManager.rooms && Memory.repairManager.rooms[roomName];
  if (rm && rm.targetOverrides && rm.targetOverrides[STRUCTURE_WALL]) return rm.targetOverrides[STRUCTURE_WALL];
  return WALLREPAIR_THRESHOLD_BY_RCL[rcl] || 0;
}

function getRampartTarget(rampart, roomName, rcl) {
  var rs = getRoomState.get(roomName);
  var sbt = rs && rs.structuresByType ? rs.structuresByType : {};
  var maxTarget = 0;
  for (var type in RAMPART_TARGETS) {
    var arr = sbt[type] || [];
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (s && rampart.pos.getRangeTo(s.pos) <= 1 && RAMPART_TARGETS[type] > maxTarget) {
        maxTarget = RAMPART_TARGETS[type];
      }
    }
  }
  if (maxTarget === 0 && isPerimeter(rampart.pos)) maxTarget = RAMPARTBOT_EXTERNAL_TARGET;
  var cap = RAMPART_HITS_MAX[rcl] || 0;
  if (cap > 0 && maxTarget > cap) maxTarget = cap;
  return maxTarget;
}

function deriveTargetHits(task, target) {
  if (!target || !target.pos) return 0;
  var roomName = taskHome(task) || target.pos.roomName;
  var room = Game.rooms[roomName];
  var rcl = room && room.controller ? room.controller.level : 0;

  if (taskKind(task) === 'nuke') {
    var nukes = room ? room.find(FIND_NUKES) : [];
    var damage = nukeDamageAt(nukes, target.pos);
    if (damage > 0) return damage + NUKE_SAFETY_MARGIN;
  }

  if (target.structureType === STRUCTURE_ROAD) return Math.floor((target.hitsMax || 0) * ROAD_REPAIR_TARGET);
  if (target.structureType === STRUCTURE_CONTAINER) return CONTAINER_DONE_HITS;
  if (target.structureType === STRUCTURE_WALL) return Math.floor(getWallTarget(roomName, rcl) * DEFENSE_REPAIR_TARGET_RATIO);
  if (target.structureType === STRUCTURE_RAMPART) return Math.floor(getRampartTarget(target, roomName, rcl) * DEFENSE_REPAIR_TARGET_RATIO);
  return target.hitsMax || 0;
}

function targetDone(target, targetHits) {
  if (!target || typeof target.hits !== 'number') return true;
  return target.hits >= targetHits;
}

function isWallOrRampartType(type) {
  return type === STRUCTURE_WALL || type === STRUCTURE_RAMPART;
}

function isTowerMaintenanceType(type) {
  return type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER;
}

function reevalTicksForTarget(target) {
  if (!target || !target.structureType) return REEVAL_TICKS_DEFAULT;
  if (target.structureType === STRUCTURE_ROAD || target.structureType === STRUCTURE_CONTAINER) return REEVAL_TICKS_ROADS;
  if (target.structureType === STRUCTURE_WALL || target.structureType === STRUCTURE_RAMPART) return REEVAL_TICKS_WALLS;
  return REEVAL_TICKS_DEFAULT;
}

function reevalTicksForCreep(creep, task) {
  var target = creep.memory.targetId ? Game.getObjectById(creep.memory.targetId) : null;
  if (target) return reevalTicksForTarget(target);
  var kind = taskKind(task);
  if (kind === 'roads-first') return REEVAL_TICKS_ROADS;
  if (kind === 'walls' || kind === 'median') return REEVAL_TICKS_WALLS;
  return REEVAL_TICKS_DEFAULT;
}

function selectTargetFromIds(creep, homeRoom, ids) {
  var task = creep.memory.task;
  if (!task || !ids.length) return null;
  homeRoom = homeRoom || getHomeRoom(creep);
  if (!homeRoom) return null;

  var current = creep.memory.targetId ? Game.getObjectById(creep.memory.targetId) : null;
  if (current) {
    var curIdx = ids.indexOf(current.id);
    if (isTowerMaintenanceType(current.structureType)) delete creep.memory.targetId;
    else if (curIdx !== -1 && current.pos && current.pos.roomName === homeRoom && !targetDone(current, taskTargetHits(task, current.id, curIdx))) return current;
  }

  var best = null;
  var bestScore = Infinity;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var obj = Game.getObjectById(id);
    if (!obj) continue;
    if (!obj.pos || obj.pos.roomName !== homeRoom) continue;
    if (isTowerMaintenanceType(obj.structureType)) continue;
    var targetHits = taskTargetHits(task, id, i);
    if (targetDone(obj, targetHits)) continue;
    var ratio = targetHits > 0 ? obj.hits / targetHits : 1;
    var dist = creep.pos.getRangeTo(obj.pos);
    var score = ratio * 1000 + dist;
    if (score < bestScore) { best = obj; bestScore = score; }
  }

  creep.memory.targetId = best ? best.id : null;
  return best;
}

function selectTarget(creep, homeRoom) {
  return selectTargetFromIds(creep, homeRoom, taskIds(creep.memory.task));
}

function repairSelectedTarget(creep, target) {
  if (creep.pos.inRangeTo(target, 3)) {
    var result = creep.repair(target);
    if (result === ERR_NOT_ENOUGH_ENERGY) creep.memory.working = false;
    else if (result === ERR_INVALID_TARGET || result === ERR_NO_BODYPART) {
      creep.memory.targetId = null;
      delete creep.memory.route;
    }
  } else {
    moveRepairer(creep, target, MOVE_OPTS_REPAIR);
  }
}

function retireRepairer(creep, homeRoom) {
  delete creep.memory.task;
  delete creep.memory.targetId;
  delete creep.memory.route;
  delete creep.memory.releaseRepairTarget;
  creep.memory.working = false;

  if (!homeRoom) {
    creep.suicide();
    return true;
  }

  if (creep.room.name !== homeRoom) {
    moveRepairer(creep, new RoomPosition(25, 25, homeRoom), { reusePath: 20, range: 20 });
    return true;
  }

  var storage = creep.room.storage;
  if (!storage) {
    creep.suicide();
    return true;
  }

  var energy = creep.store[RESOURCE_ENERGY] || 0;
  if (energy > 0) {
    if (creep.pos.isNearTo(storage)) {
      var result = creep.transfer(storage, RESOURCE_ENERGY);
      if (result === OK || result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_FULL) creep.suicide();
    } else moveRepairer(creep, storage, MOVE_OPTS_CLOSE);
    return true;
  }

  creep.suicide();
  return true;
}

function workTargetTask(creep, homeRoom) {
  var target = selectTarget(creep, homeRoom);
  if (!target) { delete creep.memory.task; park(creep, homeRoom); return; }
  repairSelectedTarget(creep, target);
}

function workRoadsFirstTask(creep, homeRoom) {
  var task = creep.memory.task;
  var target = selectTargetFromIds(creep, homeRoom, taskIds(task));
  if (!target) target = selectTargetFromIds(creep, homeRoom, taskSecondaryIds(task));
  if (!target) { delete creep.memory.task; park(creep, homeRoom); return; }
  repairSelectedTarget(creep, target);
}

function workWallsTask(creep, homeRoom) {
  workTargetTask(creep, homeRoom);
}

function workNukeTask(creep, homeRoom) {
  // Nuke tasks use the same per-id target execution, but manager assigns
  // nuke-priority ids and targets. Re-evaluation handles new incoming nukes.
  workTargetTask(creep, homeRoom);
}

function pickMedianTarget(creep) {
  var task = creep.memory.task;
  var ids = taskClusterIds(task);
  if (!task || ids.length === 0) return null;
  var lowest = null;
  var lowestHits = Infinity;
  for (var i = 0; i < ids.length; i++) {
    var s = Game.getObjectById(ids[i]);
    if (!s || typeof s.hits !== 'number') continue;
    if (s.hits < lowestHits) { lowest = s; lowestHits = s.hits; }
  }
  return lowest;
}

function medianDone(creep) {
  var task = creep.memory.task;
  var roomName = getHomeRoom(creep);
  var ids = taskClusterIds(task);
  if (!task || ids.length === 0) return true;
  var median = defenseMonitor.getRoomMedianHits(roomName);
  var stats = defenseMonitor.getClusterMinHits(ids);
  return stats.minHits >= median;
}

function workMedianTask(creep, homeRoom) {
  if (medianDone(creep)) { delete creep.memory.task; park(creep, homeRoom); return; }
  var target = pickMedianTarget(creep);
  if (!target) { delete creep.memory.task; park(creep, homeRoom); return; }
  if (creep.pos.inRangeTo(target, 3)) {
    var result = creep.repair(target);
    if (result === ERR_NOT_ENOUGH_ENERGY) creep.memory.working = false;
  } else {
    moveRepairer(creep, target, MOVE_OPTS_REPAIR);
  }
}

function run(creep) {
  const cpuStats = require('memoryManager').heap.cpuStats;
  if (cpuStats && cpuStats.average > 25) { creep.say('Zzz'); return; }

  if (!creep.memory._repairMemoryCleaned) {
    delete creep.memory.task;
    delete creep.memory.repairQueue;
    delete creep.memory.repairThresholds;
    delete creep.memory.energySourceId;
    delete creep.memory.clusterIds;
    delete creep.memory.repairId;
    delete creep.memory._lastReeval;
    creep.memory._repairMemoryCleaned = 1;
  }

  var homeRoom = getHomeRoom(creep);
  if (homeRoom && !creep.memory.homeRoom) creep.memory.homeRoom = homeRoom;
  if (homeRoom && !creep.memory.assignedRoom) creep.memory.assignedRoom = homeRoom;

  if (!homeRoom) {
    park(creep);
    return;
  }

  if (creep.ticksToLive !== undefined && creep.ticksToLive < 50) {
    retireRepairer(creep, homeRoom);
    return;
  }

  if (creep.room.name !== homeRoom) {
    moveRepairer(creep, new RoomPosition(25, 25, homeRoom), { reusePath: 20, range: 20 });
    return;
  }

  if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.working = true;
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.memory.releaseRepairTarget = creep.memory.targetId || null;
  }

  if (!creep.memory.working) { refill(creep, homeRoom); return; }

  var target = creep.memory.targetId ? Game.getObjectById(creep.memory.targetId) : null;
  if (!target) {
    if (!creep.memory.targetId) repairManager.ensureCreepAssignment(creep);
    target = creep.memory.targetId ? Game.getObjectById(creep.memory.targetId) : null;
  }
  if (!target) {
    if (creep.memory.route && creep.memory.route.length) {
      creep.memory.route.shift();
      creep.memory.targetId = creep.memory.route[0] || null;
      target = creep.memory.targetId ? Game.getObjectById(creep.memory.targetId) : null;
    }
    if (!target) return;
  }

  if (creep.memory.route && creep.memory.route.length) {
    while (creep.memory.route.length && creep.memory.route[0] !== target.id) creep.memory.route.shift();
    var routeDoneTarget = targetDone(target, deriveTargetHits({ r: homeRoom }, target));
    if (routeDoneTarget) {
      creep.memory.route.shift();
      creep.memory.targetId = creep.memory.route[0] || null;
      if (!creep.memory.targetId) return;
      target = Game.getObjectById(creep.memory.targetId);
      if (!target) return;
    }
  } else if (!isWallOrRampartType(target.structureType) && targetDone(target, deriveTargetHits({ r: homeRoom }, target))) {
    creep.memory.releaseRepairTarget = target.id;
    delete creep.memory.targetId;
    return;
  }

  if (isTowerMaintenanceType(target.structureType)) {
    creep.memory.releaseRepairTarget = target.id;
    delete creep.memory.targetId;
    delete creep.memory.route;
    return;
  }

  repairSelectedTarget(creep, target);
}

module.exports = { run: run };
