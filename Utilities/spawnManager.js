// spawnManager.js
// ============================================================================
// Spawn Manager
// Centralizes all spawn-related logic pulled from main.js.
// Updated to use getRoomState (Live Objects) instead of Memory.roomData
// ============================================================================
// To spawn 2 upgraders in a room
// doubleUpgrade('ROOMNAME', true) to enable doubleUpgrade('ROOM_NAME', false) to disable
// forceUpgrader('W1N1', true)   // enable
// forceUpgrader('W1N1', false)  // disable when done
/*
 * ── PAUSE / RESUME CONSOLE COMMANDS ────────────────────────────────────
 *
 *  1. Pause globally:
 *     pauseWallRepair()        → "WallRepair spawning PAUSED globally."
 *     pauseRampartBot()        → "RampartBot spawning PAUSED globally."
 *
 *  2. Pause a single room:
 *     pauseWallRepair('E1N1')  → "WallRepair spawning PAUSED for E1N1."
 *     pauseRampartBot('E1N1')  → "RampartBot spawning PAUSED for E1N1."
 *
 *  3. Resume globally:
 *     resumeWallRepair()       → "WallRepair spawning RESUMED globally."
 *     resumeRampartBot()       → "RampartBot spawning RESUMED globally."
 *
 *  4. Resume a single room:
 *     resumeWallRepair('E1N1') → "WallRepair spawning RESUMED for E1N1."
 *     resumeRampartBot('E1N1') → "RampartBot spawning RESUMED for E1N1."
 *
 *  NOTE: Paste the 6 globals once near other global.* commands.
 *        The pause logic is already in the updated manage*() functions.
 */



const getRoomState = require('getRoomState');
const towerDrain = require('roleTowerDrain');
const singleSourceRoom = require('singleSourceRoom');
var _boostMgr = null;
function getBoostMgr() { if (!_boostMgr) _boostMgr = require('boostManager'); return _boostMgr; }


// --- CONSTANTS ---
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER = [TOUGH, MOVE, RANGED_ATTACK];
const SCOUT_BODY = [MOVE, MOVE, MOVE, MOVE, MOVE];
const MAINTAINER_BODY = [WORK, CARRY, CARRY, MOVE]; // Fixed body for maintainer

const LOW_RCL_SPAWN_DELAY_TICKS = 150;
const RCL8_UPGRADER_SPAWN_DELAY_TICKS = 5000;
var RAMPARTBOT_PERIMETER_RANGE = 3;

var RAMPARTBOT_STRUCTURE_TARGETS = {};
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_SPAWN]       = 60500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_TERMINAL]    = 60500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_STORAGE]     = 60500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_TOWER]       =  5500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_LINK]        =  5500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_NUKER]       = 10500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_FACTORY]     =  5500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_LAB]         =  5500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_POWER_SPAWN] = 10500000;
RAMPARTBOT_STRUCTURE_TARGETS[STRUCTURE_OBSERVER]    =  5500000;
var RAMPARTBOT_EXTERNAL_TARGET = 50000000;
var RAMPARTBOT_SPAWN_OFFSET    = 400000;
var RAMPARTBOT_PROTECTED_STRUCTURES = Object.keys(RAMPARTBOT_STRUCTURE_TARGETS);

// ─── Wall-repair auto-management thresholds (indexed by RCL) ─────────────────
// THRESHOLD  = target HP creeps repair walls/ramparts UP TO (done threshold).
// SPAWN      = trigger: any perimeter wall/rampart below this spawns creeps.
// COUNT      = how many wallRepair creeps to keep alive per room.
//                                 RCL: 0  1  2      3       4        5         6          7          8
var WALLREPAIR_THRESHOLD_BY_RCL =      [0, 0, 10000, 50000, 200000, 1000000, 5000000, 10000000, 50000000];
var WALLREPAIR_SPAWN_BY_RCL     =      [0, 0,  9500, 48000, 192000,  960000, 4800000,  9600000, 49500000];
var WALLREPAIR_COUNT_BY_RCL     =      [0, 0, 1, 1, 1, 1, 1, 1, 1];
var WALLREPAIR_PERIMETER_RANGE  = 5;  // tiles from edge (matches roleWallRepair)

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
// ── Pause / resume wallRepair spawning ──────────────────────────────────
global.pauseWallRepair = function(roomName) {
  if (!Memory.spawnPause) Memory.spawnPause = {};
  if (!Memory.spawnPause.wallRepair) Memory.spawnPause.wallRepair = { rooms: {} };

  if (roomName) {
    Memory.spawnPause.wallRepair.rooms[roomName] = true;
    return 'WallRepair spawning PAUSED for ' + roomName + '.';
  }
  Memory.spawnPause.wallRepair.global = true;
  return 'WallRepair spawning PAUSED globally.';
};

global.resumeWallRepair = function(roomName) {
  if (!Memory.spawnPause || !Memory.spawnPause.wallRepair) return 'Nothing to resume.';

  if (roomName) {
    delete Memory.spawnPause.wallRepair.rooms[roomName];
    return 'WallRepair spawning RESUMED for ' + roomName + '.';
  }
  delete Memory.spawnPause.wallRepair.global;
  return 'WallRepair spawning RESUMED globally.';
};

// ── Pause / resume rampartBot spawning ──────────────────────────────────
global.pauseRampartBot = function(roomName) {
  if (!Memory.spawnPause) Memory.spawnPause = {};
  if (!Memory.spawnPause.rampartBot) Memory.spawnPause.rampartBot = { rooms: {} };

  if (roomName) {
    Memory.spawnPause.rampartBot.rooms[roomName] = true;
    return 'RampartBot spawning PAUSED for ' + roomName + '.';
  }
  Memory.spawnPause.rampartBot.global = true;
  return 'RampartBot spawning PAUSED globally.';
};

global.resumeRampartBot = function(roomName) {
  if (!Memory.spawnPause || !Memory.spawnPause.rampartBot) return 'Nothing to resume.';

  if (roomName) {
    delete Memory.spawnPause.rampartBot.rooms[roomName];
    return 'RampartBot spawning RESUMED for ' + roomName + '.';
  }
  delete Memory.spawnPause.rampartBot.global;
  return 'RampartBot spawning RESUMED globally.';
};


global.forceUpgrader = function(roomName, enable) {
  if (!Memory.forceUpgraderRooms) Memory.forceUpgraderRooms = {};

  if (enable === false) {
    delete Memory.forceUpgraderRooms[roomName];
    return "Force upgrader DISABLED for " + roomName + ". Returning to normal RCL 8 logic.";
  }

  var room = Game.rooms[roomName];
  if (!room || !room.controller || !room.controller.my) {
    return "Command Rejected: No vision or ownership of " + roomName + ".";
  }
  if (room.controller.level !== 8) {
    return "Command Rejected: " + roomName + " is not RCL 8. Use doubleUpgrade() for lower RCL rooms.";
  }

  // Mutual exclusivity — clear allowUpgrader if active
  if (Memory.allowUpgraderRooms && Memory.allowUpgraderRooms[roomName]) {
    delete Memory.allowUpgraderRooms[roomName];
    console.log('[forceUpgrader] Cleared allowUpgrader for ' + roomName + ' (mutually exclusive).');
  }

  if (!global.__boostActive || !getBoostMgr().isActive(roomName, 'upgrader')) {
    Memory.forceUpgraderRooms[roomName] = true;
    return "Warning: No boost configured for upgrader in " + roomName +
           ". Spawning will use the standard body. Set up boost first for full effect.\n" +
           "Flag set anyway — disable with forceUpgrader('" + roomName + "', false).";
  }

  Memory.forceUpgraderRooms[roomName] = true;
  return "Force upgrader ENABLED for " + roomName + " ...";
};

global.allowUpgrader = function(roomName, enable) {
  if (!Memory.allowUpgraderRooms) Memory.allowUpgraderRooms = {};

  if (enable === false) {
    delete Memory.allowUpgraderRooms[roomName];
    return 'Allow upgrader DISABLED for ' + roomName + '. Returning to normal RCL 8 logic.';
  }

  var room = Game.rooms[roomName];
  if (!room || !room.controller || !room.controller.my) {
    return 'Command Rejected: No vision or ownership of ' + roomName + '.';
  }
  if (room.controller.level !== 8) {
    return 'Command Rejected: ' + roomName + ' is not RCL 8. allowUpgrader is RCL 8 only.';
  }

  // Mutual exclusivity — clear forceUpgrader if active
  if (Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[roomName]) {
    delete Memory.forceUpgraderRooms[roomName];
    console.log('[allowUpgrader] Cleared forceUpgrader for ' + roomName + ' (mutually exclusive).');
  }

  Memory.allowUpgraderRooms[roomName] = true;
  return 'Allow upgrader ENABLED for ' + roomName + '. Upgrader spawns only while mining is active (extractor + mineral + container).';
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

// REPLACEMENT for getSpawnDirections in spawnManager.js
// Fixes: Creeps being spawned into walls or onto obstacle structures
// (extensions, towers, labs, etc.) because direction calculation
// didn't check for blocked tiles.

/**
 * Given a spawn position and a target position, returns an array of spawn
 * directions so the creep pops out facing the target.
 * Filters out directions that point into walls OR obstacle structures.
 * Returns undefined if no valid direction exists (lets the engine pick).
 */
function getSpawnDirections(spawnPos, targetPos) {
  var dx = targetPos.x - spawnPos.x;
  var dy = targetPos.y - spawnPos.y;

  dx = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
  dy = dy === 0 ? 0 : (dy > 0 ? 1 : -1);

  if (dx === 0 && dy === 0) return undefined;

  var dirMap = {
    '0,-1':  TOP,
    '1,-1':  TOP_RIGHT,
    '1,0':   RIGHT,
    '1,1':   BOTTOM_RIGHT,
    '0,1':   BOTTOM,
    '-1,1':  BOTTOM_LEFT,
    '-1,0':  LEFT,
    '-1,-1': TOP_LEFT
  };

  var primary = dirMap[dx + ',' + dy];
  if (!primary) return undefined;

  var all = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
  var idx = all.indexOf(primary);
  var left  = all[(idx - 1 + 8) % 8];
  var right = all[(idx + 1) % 8];

  var candidates = [primary, left, right];
  var terrain = Game.map.getRoomTerrain(spawnPos.roomName);
  var room = Game.rooms[spawnPos.roomName];

  var dirOffsets = {};
  dirOffsets[TOP]          = { dx:  0, dy: -1 };
  dirOffsets[TOP_RIGHT]    = { dx:  1, dy: -1 };
  dirOffsets[RIGHT]        = { dx:  1, dy:  0 };
  dirOffsets[BOTTOM_RIGHT] = { dx:  1, dy:  1 };
  dirOffsets[BOTTOM]       = { dx:  0, dy:  1 };
  dirOffsets[BOTTOM_LEFT]  = { dx: -1, dy:  1 };
  dirOffsets[LEFT]         = { dx: -1, dy:  0 };
  dirOffsets[TOP_LEFT]     = { dx: -1, dy: -1 };

  /**
   * Check if a tile is valid for spawning onto:
   * - Not a terrain wall
   * - Not occupied by an obstacle structure (extension, tower, lab, etc.)
   * Roads and containers are fine.
   */
  function isTileOpen(tx, ty) {
    if (tx < 0 || tx > 49 || ty < 0 || ty > 49) return false;

    // Check terrain
    if (terrain.get(tx, ty) === TERRAIN_MASK_WALL) return false;

    // Check for obstacle structures on the tile
    if (room) {
      var structs = room.lookForAt(LOOK_STRUCTURES, tx, ty);
      for (var s = 0; s < structs.length; s++) {
        var st = structs[s].structureType;
        if (OBSTACLE_OBJECT_TYPES.indexOf(st) !== -1) {
          return false;
        }
      }
    }

    return true;
  }

  // Filter preferred directions
  var walkable = [];
  for (var i = 0; i < candidates.length; i++) {
    var offset = dirOffsets[candidates[i]];
    if (isTileOpen(spawnPos.x + offset.dx, spawnPos.y + offset.dy)) {
      walkable.push(candidates[i]);
    }
  }

  // If none of our 3 preferred directions work, try all 8 (closest-to-ideal first)
  if (walkable.length === 0) {
    var priorityOrder = [];
    for (var d = 0; d < 8; d++) {
      var cwIdx  = (idx + d) % 8;
      var ccwIdx = (idx - d + 8) % 8;
      if (priorityOrder.indexOf(all[cwIdx]) === -1)  priorityOrder.push(all[cwIdx]);
      if (priorityOrder.indexOf(all[ccwIdx]) === -1) priorityOrder.push(all[ccwIdx]);
    }

    for (var j = 0; j < priorityOrder.length; j++) {
      var off = dirOffsets[priorityOrder[j]];
      if (isTileOpen(spawnPos.x + off.dx, spawnPos.y + off.dy)) {
        walkable.push(priorityOrder[j]);
      }
    }
  }

  if (walkable.length === 0) return undefined;

  return walkable;
}

function manageSingleSourceSpawns(perRoomRoleCounts) {
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        if (!singleSourceRoom.isSingleSourceActive(roomName)) continue;

        var anchors = singleSourceRoom.getAnchors(roomName);
        if (!anchors) continue;

        var rs = getRoomState.get(roomName);
        if (!rs) continue;

        var counts = perRoomRoleCounts[roomName] || {};

        // Spawn priority: HD > Distributor > ComboBot > Maintainer
        var spawnQueue = [];

        if ((counts.hd || 0) < 1 && anchors.hd && anchors.hdSpawn) {
            spawnQueue.push({ role: 'hd', anchor: anchors.hd, spawnId: anchors.hdSpawn });
        }
        if ((counts.staticDistributor || 0) < 1 && anchors.distributor && anchors.distributorSpawn) {
            spawnQueue.push({ role: 'staticDistributor', anchor: anchors.distributor, spawnId: anchors.distributorSpawn });
        }
        if ((counts.comboBot || 0) < 1 && anchors.comboBot && anchors.comboBotSpawn) {
            spawnQueue.push({ role: 'comboBot', anchor: anchors.comboBot, spawnId: anchors.comboBotSpawn });
        }

        // Maintainer only when TTL is low
        if (room.controller.level === 8 && room.controller.ticksToDowngrade < 150000) {
            if ((counts.maintainer || 0) < 1) {
                // Maintainer uses any free spawn, has MOVE parts
                spawnQueue.push({ role: 'maintainer', anchor: null, spawnId: null });
            }
        }

        // Check if any stationary bot needs urgent renewal (defer other spawns)
        var urgentRenewal = false;
        for (var name in Game.creeps) {
            var c = Game.creeps[name];
            if (!c || !c.memory) continue;
            var r = c.memory.role;
            if ((r === 'hd' || r === 'staticDistributor' || r === 'comboBot') &&
                c.memory.homeRoom === roomName && c.ticksToLive < 100) {
                urgentRenewal = true;
                break;
            }
        }

        for (var q = 0; q < spawnQueue.length; q++) {
            var item = spawnQueue[q];

            // If urgent renewal pending and this isn't a replacement for the dying bot, skip
            if (urgentRenewal && item.role !== 'maintainer') {
                // Check if this role is the one that needs replacement (count is 0)
                var roleCount = counts[item.role] || 0;
                if (roleCount > 0) continue; // Bot exists but is low TTL — renewal, not spawn
            }

            var spawn = null;
            if (item.spawnId) {
                spawn = Game.getObjectById(item.spawnId);
                if (!spawn || spawn.spawning) continue;
            } else {
                // Find any free spawn
                var spawns = (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) || [];
                for (var s = 0; s < spawns.length; s++) {
                    if (spawns[s].my && !spawns[s].spawning) { spawn = spawns[s]; break; }
                }
                if (!spawn) continue;
            }

            var body = getSingleSourceBody(item.role, room.energyAvailable);
            if (!body) continue;

            var cost = bodyCost(body);
            if (cost > room.energyAvailable) continue;

            var newName = item.role + '_' + roomName + '_' + Game.time;
            var memory = {
                role: item.role,
                homeRoom: roomName,
                assignedRoom: roomName
            };

            // For HD, store sourceId
            if (item.role === 'hd') {
                var sources = rs.sources || [];
                if (sources.length > 0) memory.sourceId = sources[0].id;
            }

            var spawnOpts = { memory: memory };

            // For stationary roles, aim spawn direction at anchor tile
            if (item.anchor) {
                var dirs = singleSourceRoom.getAnchorSpawnDirection(spawn.pos, item.anchor);
                if (dirs) spawnOpts.directions = dirs;
            }

            var result = spawn.spawnCreep(body, newName, spawnOpts);
            if (result === OK) {
                console.log('[SingleSource] Spawning ' + item.role + ' in ' + roomName +
                    ' (' + body.length + ' parts, cost=' + cost + ')' +
                    (item.anchor ? ' anchor=(' + item.anchor.x + ',' + item.anchor.y + ')' : ''));
                break; // One spawn per tick per room
            }
        }
    }
}

function buildExtractorAssistantBody(energyAvailable) {
    // Each set: 4 CARRY + 1 MOVE = 250e. Cap at 10 sets (40C+10M = 2500e).
    var sets = Math.min(10, Math.floor(energyAvailable / 250));
    if (sets < 1) return null;

    var body = [];
    for (var i = 0; i < sets * 4; i++) body.push(CARRY);
    for (var i = 0; i < sets; i++) body.push(MOVE);
    return body;
}

function manageExtractorAssistantSpawns() {
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;

        var rs = getRoomState.get(roomName);
        if (!rs || !rs.structuresByType) continue;

        // ── Require an extractor ───────────────────────────────────────────
        var extractors = (rs.structuresByType[STRUCTURE_EXTRACTOR] || []).filter(function(e) { return e.my; });
        if (extractors.length === 0) continue;
        var extPos = extractors[0].pos;

        // ── Find the mineral container (adjacent to extractor) ─────────────
        var containers = rs.structuresByType[STRUCTURE_CONTAINER] || [];
        var mineralContainer = null;
        for (var i = 0; i < containers.length; i++) {
            if (containers[i].pos.getRangeTo(extPos) <= 1) {
                mineralContainer = containers[i];
                break;
            }
        }
        if (!mineralContainer) continue;

        // ── Only spawn if there are actually minerals in the container ──────
        var mineralAmt = 0;
        var storeKeys = Object.keys(mineralContainer.store);
        for (var k = 0; k < storeKeys.length; k++) {
            if (storeKeys[k] !== RESOURCE_ENERGY) mineralAmt += mineralContainer.store[storeKeys[k]] || 0;
        }
        if (mineralAmt === 0) continue;

        // ── Already have one (alive or spawning)? ─────────────────────────
        var existing = false;
        for (var name in Game.creeps) {
            var c = Game.creeps[name];
            if (!c || !c.memory) continue;
            if (c.memory.role === 'extractorAssistant' &&
                (c.memory.homeRoom === roomName || c.memory.assignedRoom === roomName)) {
                existing = true;
                break;
            }
        }
        if (!existing && rs.structuresByType[STRUCTURE_SPAWN]) {
            for (var si = 0; si < rs.structuresByType[STRUCTURE_SPAWN].length && !existing; si++) {
                var chk = rs.structuresByType[STRUCTURE_SPAWN][si];
                if (chk.my && chk.spawning) {
                    var chkMem = Memory.creeps[chk.spawning.name];
                    if (chkMem && chkMem.role === 'extractorAssistant' && chkMem.homeRoom === roomName) {
                        existing = true;
                    }
                }
            }
        }
        if (existing) continue;

        // ── Find the closest free spawn to the extractor ──────────────────
        var freeSpawn = null;
        var bestSpawnRange = Infinity;
        if (rs.structuresByType[STRUCTURE_SPAWN]) {
            for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
                var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
                if (!sp.my || sp.spawning) continue;
                var r = sp.pos.getRangeTo(extPos);
                if (r < bestSpawnRange) { bestSpawnRange = r; freeSpawn = sp; }
            }
        }
        if (!freeSpawn) continue;

        var body = buildExtractorAssistantBody(freeSpawn.room.energyAvailable);
        if (!body) continue;

        var cost = bodyCost(body);
        if (cost > freeSpawn.room.energyAvailable) continue;

        var newName = 'ExtAssist_' + roomName + '_' + (Game.time % 10000);
        var memory = {
            role:         'extractorAssistant',
            homeRoom:     roomName,
            assignedRoom: roomName,
            state:        'waiting'
        };

        var res = freeSpawn.spawnCreep(body, newName, { memory: memory });
        if (res === OK) {
            console.log('[ExtractorAssistant] Spawning ' + newName + ' in ' + roomName +
                ' | Parts: ' + body.length + ' | Cost: ' + cost +
                ' | Minerals in container: ' + mineralAmt +
                ' | spawnRange: ' + bestSpawnRange);
        } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
            console.log('[ExtractorAssistant] Failed to spawn in ' + roomName + ': ' + res);
        }
    }
}

function getSingleSourceBody(role, energy) {
    switch (role) {
        case 'hd':
            if (energy >= 1950) return [
                WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK,
                WORK, WORK, WORK, WORK, WORK,
                CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY
            ];
            if (energy >= 1200) return [
                WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK,
                CARRY, CARRY, CARRY, CARRY
            ];
            if (energy >= 700) return [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY];
            if (energy >= 400) return [WORK, WORK, WORK, CARRY, CARRY];
            return null;

        case 'staticDistributor':
            var carrys = Math.min(16, Math.floor(energy / 50));
            if (carrys < 4) return null;
            var body = [];
            for (var i = 0; i < carrys; i++) body.push(CARRY);
            return body;

        case 'comboBot':
            // FIX: Use the outer-scope singleSourceRoom require, don't re-declare
            // with var which would shadow it across the whole function.
            var ssRoom = require('singleSourceRoom');
            var comboRoom = null;
            for (var rn in Game.rooms) {
                var r = Game.rooms[rn];
                if (r.controller && r.controller.my && ssRoom.isSingleSourceActive(rn)) {
                    comboRoom = r;
                    break;
                }
            }

            var needsWork = false;
            if (comboRoom) {
                var comboRS = getRoomState.get(comboRoom.name);
                var minerals = (comboRS && comboRS.minerals) || comboRoom.find(FIND_MINERALS);
                if (minerals.length > 0) {
                    var mineral = minerals[0];
                    if (mineral.mineralAmount > 0) {
                        needsWork = true;
                    } else if (mineral.ticksToRegeneration !== undefined && mineral.ticksToRegeneration < 300) {
                        needsWork = true;
                    }
                }
            }

            if (needsWork) {
                if (energy >= 1550) return [
                    WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK,
                    CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY
                ];
                if (energy >= 900) return [
                    WORK, WORK, WORK, WORK, WORK,
                    CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY
                ];
                if (energy >= 550) return [WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY];
                return null;
            } else {
                var comboCounts = Math.min(20, Math.floor(energy / 50));
                if (comboCounts < 4) return null;
                var comboBody = [];
                for (var ci = 0; ci < comboCounts; ci++) comboBody.push(CARRY);
                return comboBody;
            }

        case 'maintainer':
            return [WORK, CARRY, CARRY, MOVE];

        default:
            return null;
    }
}

function getCreepBody(role, energy) {
  if (role === 'labBot') {
    var pairs = Math.min(10, Math.floor(energy / 100));
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
    const numSets = Math.min(Math.floor(50 / 4), Math.floor(energy / costPerSet));
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
 
  // --- Fast Attacker Body (ATTACK/MOVE pairs, full road speed, no sustain) ---
  if (role === 'fastAttacker') {
    const pairCost = 80 + 50; // ATTACK(80) + MOVE(50) = 130
    const pairs = Math.min(25, Math.floor(energy / pairCost));
    if (pairs < 1) return null;
    const body = [];
    for (let i = 0; i < pairs; i++) body.push(ATTACK);
    for (let i = 0; i < pairs; i++) body.push(MOVE);
    return body;
  }
 
  // --- SK Attacker Body ---
  if (role === 'skAttacker') {
    const costPerSet = 430;
    const numSets = Math.min(Math.floor(50 / 4), Math.floor(energy / costPerSet));
    if (numSets >= 2) {
      const body = [];
      for (let i = 0; i < numSets * 2; i++) body.push(MOVE);
      for (let i = 0; i < numSets; i++) body.push(ATTACK);
      for (let i = 0; i < numSets; i++) body.push(HEAL);
      return body;
    } else if (energy >= 430) {
      return [MOVE, MOVE, ATTACK, HEAL];
    } else {
      return null;
    }
  }
 
  const bodyConfigs = {
    // ── Demolisher ─────────────────────────────────────────────────────────
    demolisher: {
      1500: [
        WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,
        MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE
      ],
      2500: [
        WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,
        WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,
        MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE
      ],
      4300: [
        WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,
        WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,
        WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,
        WORK,WORK,WORK,WORK,WORK,WORK,
        MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,MOVE,
        MOVE,MOVE,MOVE,MOVE
      ]
    },
 
    quad: {
      1300: [MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL],
      1800: [MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL],
      2300: [MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL],
      5000: [MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL]
    },
    powerBot: {
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
      2350: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
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
      250:  [WORK, CARRY, MOVE, MOVE],
      500:  [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
      750:  [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1000: [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1250: [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1500: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2000: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2500: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      3000: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      3150: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
    },
    defenseRepair: {
      400:  [WORK, WORK, CARRY, MOVE, MOVE, MOVE],
      600:  [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
      900:  [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1200: [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1600: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2000: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2500: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      3000: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      3600: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    repairBot: {
      300:  [WORK, CARRY, MOVE, MOVE],
      400:  [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
      600:  [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
      900:  [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
      1200: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    // ── TowerFiller ────────────────────────────────────────────────────────
    // Pure CARRY/MOVE: 2:1 ratio gives road speed with no wasted parts.
    // Capped at 10 CARRY (500 energy) — enough to fill a low tower in one trip.
    // Falls back to smaller bodies when spawn energy is tight.
    towerFiller: {
       150: [CARRY,CARRY,
             MOVE],
       300: [CARRY,CARRY,CARRY,CARRY,
             MOVE,MOVE],
       450: [CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,
             MOVE,MOVE,MOVE],
       600: [CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,
             MOVE,MOVE,MOVE,MOVE],
       750: [CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,
             MOVE,MOVE,MOVE,MOVE,MOVE]
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
      500: [CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
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
  if (energy <= 300 && role !== 'defender' && role !== 'supplier' && role !== 'powerBot' && role !== 'remoteBuilder' && role !== 'quad' && role !== 'maintainer' && role !== 'demolisher' && role !== 'towerFiller') return BASIC_HARVESTER;
 
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

// ============================================================================
// spawnManager_patch.js
//
// STEP 1: Paste manageRemoteSupplierSpawns() anywhere in the
//         "Spawn functions (grouped)" section of spawnManager.js,
//         e.g. directly after manageRemoteBuilderSpawns().
//
// STEP 2: In the run() function at the bottom, add:
//   if (Game.time % 5 === 0) manageRemoteSupplierSpawns();
// ============================================================================

function manageRemoteSupplierSpawns() {
    if (!Memory.remoteSupplySpawnQueue || Memory.remoteSupplySpawnQueue.length === 0) return;

    // Expire stale requests — remoteSupplyManager re-enqueues each tick anyway
    Memory.remoteSupplySpawnQueue = Memory.remoteSupplySpawnQueue.filter(function(req) {
        return Game.time - req.requestedAt < 500;
    });

    for (var i = Memory.remoteSupplySpawnQueue.length - 1; i >= 0; i--) {
        var req = Memory.remoteSupplySpawnQueue[i];

        // If a supplier already exists for this order + mission, clear the request
        var alreadyAlive = false;
        for (var cname in Game.creeps) {
            var c = Game.creeps[cname];
            if (!c || !c.memory) continue;
            if (c.memory.role       === 'remoteSupplier' &&
                c.memory.homeRoom   === req.sourceRoom    &&
                c.memory.targetRoom === req.recipientRoom &&
                c.memory.mission    === req.mission) {
                alreadyAlive = true;
                break;
            }
        }
        if (alreadyAlive) {
            Memory.remoteSupplySpawnQueue.splice(i, 1);
            continue;
        }

        var rs = getRoomState.get(req.sourceRoom);
        if (!rs) continue;

        var room = Game.rooms[req.sourceRoom];
        if (!room || !room.controller || !room.controller.my) continue;

        // Find a free spawn in the source room
        var freeSpawn = null;
        var spawns = (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) || [];
        for (var s = 0; s < spawns.length; s++) {
            if (spawns[s].my && !spawns[s].spawning) { freeSpawn = spawns[s]; break; }
        }
        if (!freeSpawn) continue;

        var body = getCreepBody('supplier', freeSpawn.room.energyAvailable);
        if (!body) continue;

        var cost = bodyCost(body);
        if (cost > freeSpawn.room.energyAvailable) continue;

        var newName = 'RemSup_' + req.mission.charAt(0).toUpperCase() + '_' + req.recipientRoom + '_' + (Game.time % 10000);
        var memory = {
            role:         'remoteSupplier',
            homeRoom:     req.sourceRoom,
            targetRoom:   req.recipientRoom,
            mission:      req.mission,        // 'extensions' | 'storage'
            amountNeeded: req.amountNeeded,   // null for extensions, number for storage
            working:      false
        };

        var result = freeSpawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            console.log('[RemoteSupply] Spawning ' + newName +
                        ' [' + req.mission + '] ' +
                        req.sourceRoom + ' -> ' + req.recipientRoom +
                        ' (' + body.length + ' parts, cost=' + cost + ')' +
                        (req.amountNeeded ? ' need=' + req.amountNeeded : ''));
            Memory.remoteSupplySpawnQueue.splice(i, 1);
        } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
            console.log('[RemoteSupply] Spawn failed in ' + req.sourceRoom + ': ' + result);
        }
    }
}

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

    var exists = _.some(Game.creeps, function(c) {
      if (!c || !c.memory) return false;
      if (c.memory.role !== 'nukeFill') return false;
      var assigned = c.memory.orderRoom || c.memory.homeRoom || (c.room ? c.room.name : null);
      return assigned === roomName;
    });
    if (exists) continue;

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

// ============================================================================
// POWER BANK SPAWN LOGIC
// Add this function to spawnManager.js, then call it from run():
//   if (Game.time % 5 === 0) managePowerBankSpawns();
// ============================================================================
//
// Spawn order per subtask:
//   1. Healer first (most expensive, gates affordability check)
//   2. Attacker (immediately after healer is queued)
//   3. Carriers (only when subtask.phase === 'collecting')
//
// Bodies (fixed 50-part, no scaling):
//   Attacker: 25× ATTACK + 25× MOVE  (3250e)
//   Healer:   25× HEAL   + 25× MOVE  (7500e)
//   Carrier:  25× CARRY  + 25× MOVE  (2500e)

// Helper: check if a creep with a given name is currently being spawned
function isCreepSpawningByName(creepName) {
  for (var roomName in Game.rooms) {
    var rs = getRoomState.get(roomName);
    var spawns = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) || Game.rooms[roomName].find(FIND_MY_SPAWNS);
    for (var i = 0; i < spawns.length; i++) {
      if (spawns[i].my && spawns[i].spawning && spawns[i].spawning.name === creepName) return true;
    }
  }
  return false;
}

function manageSpawnsPerRoom(perRoomRoleCounts) {
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

    if ((roleCounts.harvester || 0) === 0) {
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
    if (roleCounts.maintainer < roomTargets.maintainer) spawnQueue.push('maintainer');

    if (Memory.spawnRequests && Memory.spawnRequests[roomName] && Memory.spawnRequests[roomName].needPowerBot) {
      var existingPower = _.filter(Game.creeps, function(c) { return c.memory.role === 'powerBot' && c.memory.homeRoom === roomName; });
      if (existingPower.length === 0) {
        var roomPower = 0;
        if (rs) {
          if (rs.storage && rs.storage.store) {
            roomPower += rs.storage.store[RESOURCE_POWER] || 0;
          }
          var terminals = (rs.structuresByType && rs.structuresByType[STRUCTURE_TERMINAL]) || [];
          for (var tp = 0; tp < terminals.length; tp++) {
            if (terminals[tp].store) roomPower += terminals[tp].store[RESOURCE_POWER] || 0;
          }
          var powerSpawns = (rs.structuresByType && rs.structuresByType[STRUCTURE_POWER_SPAWN]) || [];
          for (var psp = 0; psp < powerSpawns.length; psp++) {
            if (powerSpawns[psp].store) roomPower += powerSpawns[psp].store[RESOURCE_POWER] || 0;
          }
        }
        if (roomPower > 0) {
          spawnQueue.push('powerBot');
        } else if (Game.time % 50 === 0) {
          console.log('[PowerBot] ' + roomName + ': Skipping spawn — no power in room to process.');
        }
      }
    }

    if ((roleCounts.upgrader || 0) < roomTargets.upgrader) spawnQueue.push('upgrader');
    if (roleCounts.builder   < roomTargets.builder)  spawnQueue.push('builder');
    if (roleCounts.scout     < roomTargets.scout)    spawnQueue.push('scout');

    var spawnsUsed = 0;
    for (var i = 0; i < spawnQueue.length; i++) {
      if (spawnsUsed >= availableSpawns.length) break;

      var roleToSpawn = spawnQueue[i];

      if (delayActive && roleToSpawn !== 'supplier') continue;

      if (roleToSpawn === 'upgrader' && shouldDelayUpgraderAtRCL8(roomName, room)) {
        var boostBypasses = global.__boostActive && getBoostMgr().isActive(roomName, 'upgrader');
        var forceBypasses = Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[roomName];
        if (!boostBypasses && !forceBypasses) continue;
      }

      var energyForSpawn = room.energyAvailable;
      var body = undefined;

      if (global.__boostActive && getBoostMgr().isActive(roomName, roleToSpawn)) {
        var boostBody = getBoostMgr().getBody(roomName, roleToSpawn);
        if (boostBody) {
          var boostCost = getBoostMgr().getBodyCost(roomName, roleToSpawn);
          if (room.energyAvailable < boostCost) {
            if (Game.time % 20 === 0) {
              console.log('[BoostManager] ' + roomName + ': Need ' + boostCost +
                ' energy for boosted ' + roleToSpawn + ', have ' + room.energyAvailable);
            }
            continue;
          }
          if (!getBoostMgr().areLabsReady(roomName, roleToSpawn)) {
            if (Game.time % 20 === 0) {
              console.log('[BoostManager] ' + roomName + ': Waiting for boost labs before spawning ' + roleToSpawn);
            }
            continue;
          }
          body = boostBody;
        } else {
          body = null;
        }
      }

      if (!body && roleToSpawn === 'upgrader' &&
          Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[roomName]) {
        var forceCap = (room.controller && room.controller.level === 8) ? 2350 : energyForSpawn;
        body = getCreepBody(roleToSpawn, Math.min(energyForSpawn, forceCap));
      }

      if (!body) {
        if (roleToSpawn === 'upgrader' &&
            room.controller && room.controller.my &&
            room.controller.level === 8 &&
            energyForSpawn > 2350) {
          energyForSpawn = 2350;
        }
        body = getCreepBody(roleToSpawn, energyForSpawn);
      }

      if (!body) continue;

      var success = spawnCreepInRoom(roleToSpawn, body, availableSpawns[spawnsUsed], roomName);
      if (success) {
        spawnsUsed++;
        if (roleCounts[roleToSpawn] === undefined) roleCounts[roleToSpawn] = 0;
        roleCounts[roleToSpawn]++;

        if (room.controller.level <= 6 && (roleCounts.harvester || 0) > 0) {
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

  var maxWork      = 30;
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
    // Clean static mining builds: C = W/5 ratio ensures carry capacity
    // divides evenly by harvest-per-tick. Zero overflow, zero cleanup intents.
    // 40W/8C/1M: 46 intents/cycle, 230 operational + 68 spawn = 298 lifetime
    var staticBuilds = [
      { cost: 4450, body: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,MOVE] },  // 40W/8C/1M
      { cost: 3900, body: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,MOVE] },  // 35W/7C/1M
      { cost: 3350, body: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,CARRY,CARRY,CARRY,CARRY,CARRY,CARRY,MOVE] },  // 30W/6C/1M
      { cost: 2800, body: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,CARRY,CARRY,CARRY,CARRY,CARRY,MOVE] },  // 25W/5C/1M
      { cost: 1700, body: [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,CARRY,CARRY,CARRY,MOVE] },  // 15W/3C/1M
      { cost:  600, body: [WORK,WORK,WORK,WORK,WORK,CARRY,MOVE] },  // 5W/1C/1M
      { cost:  200, body: [WORK,CARRY,MOVE] }  // emergency fallback
    ];

    for (var si = 0; si < staticBuilds.length; si++) {
      if (energyBudget >= staticBuilds[si].cost) return staticBuilds[si].body;
    }
    return null;
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
  var sourcePos = new RoomPosition(smeta.pos.x, smeta.pos.y, smeta.pos.roomName);
  var directions = getSpawnDirections(spawn.pos, sourcePos);
  var spawnOpts = { memory: memory };
  if (directions) spawnOpts.directions = directions;
  var res = spawn.spawnCreep(body, name, spawnOpts);

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

function manageDefenseRepairSpawns() {
  if (!Memory.defense || !Memory.defense.repairOrders) return;

  for (var roomName in Memory.defense.repairOrders) {
    var orders = Memory.defense.repairOrders[roomName];
    if (!orders || orders.length === 0) continue;

    var unassignedOrder = null;
    for (var oi = 0; oi < orders.length; oi++) {
      if (!orders[oi].assignedCreep || !Game.creeps[orders[oi].assignedCreep]) {
        unassignedOrder = orders[oi];
        break;
      }
    }
    if (!unassignedOrder) continue;

    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);
    if (!rs) continue;

    // Count existing defense repair creeps (alive + spawning)
    var existingCount = 0;
    for (var cname in Game.creeps) {
      var c = Game.creeps[cname];
      if (!c.memory) continue;
      if (c.memory.role === 'defenseRepair' && c.memory.homeRoom === roomName) {
        existingCount++;
      }
    }
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var spi = 0; spi < rs.structuresByType[STRUCTURE_SPAWN].length; spi++) {
        var chk = rs.structuresByType[STRUCTURE_SPAWN][spi];
        if (chk.my && chk.spawning) {
          var chkMem = Memory.creeps[chk.spawning.name];
          if (chkMem && chkMem.role === 'defenseRepair' && chkMem.homeRoom === roomName) {
            existingCount++;
          }
        }
      }
    }
    if (existingCount >= 2) continue;

    // Find free spawn
    var freeSpawn = null;
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = getCreepBody('defenseRepair', freeSpawn.room.energyAvailable);
    if (!body) continue;

    var cost = bodyCost(body);
    if (cost > freeSpawn.room.energyAvailable) continue;

    var name = 'DefRepair_' + roomName + '_' + (Game.time % 10000);
    var memory = {
      role: 'defenseRepair',
      homeRoom: roomName,
      assignedRoom: roomName,
      targetId: unassignedOrder.clusterId,
      clusterIds: unassignedOrder.clusterIds,
      solo: unassignedOrder.solo || false,
      working: false,
      repairId: null
    };

    var spawnOpts = { memory: memory };
    var targetObj = Game.getObjectById(unassignedOrder.clusterId);
    if (targetObj) {
      var directions = getSpawnDirections(freeSpawn.pos, targetObj.pos);
      if (directions) spawnOpts.directions = directions;
    }

    var res = freeSpawn.spawnCreep(body, name, spawnOpts);
    if (res === OK) {
      unassignedOrder.assignedCreep = name;
      var modeStr = unassignedOrder.solo ? 'solo→median' : 'cluster→weakest';
      console.log('[DefenseRepair] Spawning ' + name + ' in ' + roomName +
        ' | Parts: ' + body.length + ' | Cost: ' + cost +
        ' | Mode: ' + modeStr +
        ' | Structures: ' + unassignedOrder.clusterIds.length);
      Game.notify('[DEFENSE] Spawning defense repair bot in ' + roomName +
        ' (' + modeStr + ', ' + unassignedOrder.clusterIds.length + ' structures).', 5);
    } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[DefenseRepair] Failed to spawn in ' + roomName + ': ' + res);
    }
  }
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

  for (var i = Memory.squadOrders.length - 1; i >= 0; i--) {
    var ord = Memory.squadOrders[i];
    if (ord.spawnedCount >= 4) {
      console.log("[Squad] Order fulfilled for target " + ord.targetRoom);
      Memory.squadOrders.splice(i, 1);
      continue;
    }
  }

  if (Memory.squadOrders.length === 0) return;

  var order = Memory.squadOrders[0];
  var homeRoom = order.homeRoom;

  var room = Game.rooms[homeRoom];
  if (!room || !room.controller || !room.controller.my) {
    if (Game.time % 20 === 0) console.log("[Squad] Invalid home room " + homeRoom);
    return;
  }
  if (Game.time % 5 === 0) managePowerBankSpawns();

  // FIX: Use (counts.x || 0) so undefined keys don't produce NaN comparisons.
  var counts = perRoomRoleCounts[homeRoom] || {};
  var targets = getRoomTargets(homeRoom, room);

  var meta = ensureSourceMetaCache(room);
  var expectedHarvesters = meta && meta.byId ? Object.keys(meta.byId).length : 2;

  if ((counts.harvester || 0) < expectedHarvesters || (counts.supplier || 0) < targets.supplier) {
    if (Game.time % 10 === 0) console.log("[Squad] Paused: Room " + homeRoom + " needs economy (Harv/Supp) first.");
    return;
  }

  var rs = getRoomState.get(homeRoom);
  if (!rs) return;

  var freeSpawn = null;
  if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
      var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
      if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
    }
  }

  if (!freeSpawn) return;

  var squadId = order.squadId || ("Squad_" + order.targetRoom + "_" + Game.time);
  if (!order.squadId) order.squadId = squadId;

  var spawnIndex = -1;
  var allAlive = true;

  for (var i = 0; i < 4; i++) {
    var creepName = "Quad_" + i + "_" + squadId;
    var creep = Game.creeps[creepName];

    var isSpawning = false;
    var squadRS = getRoomState.get(room.name);
    var spawns = (squadRS && squadRS.structuresByType && squadRS.structuresByType[STRUCTURE_SPAWN]) || room.find(FIND_MY_SPAWNS);
    for (var k = 0; k < spawns.length; k++) {
      if (spawns[k].my && spawns[k].spawning && spawns[k].spawning.name === creepName) {
        isSpawning = true;
        break;
      }
    }

    if (isSpawning) {
      if (Game.time % 10 === 0) console.log("[Squad] Member " + i + " is spawning. Waiting.");
      return;
    }

    if (!creep) {
      spawnIndex = i;
      allAlive = false;
      break;
    }
  }

  if (allAlive) return;

  var body = getCreepBody('quad', freeSpawn.room.energyAvailable);

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
    order.spawnedCount = (order.spawnedCount || 0) + 1;
  }
}


// ─── REPLACEMENT manageRepairBotSpawns ───────────────────────────────────────
// ─── REPLACEMENT manageRepairBotSpawns ───────────────────────────────────────
// Drop-in replacement for manageRepairBotSpawns() in spawnManager.js.
// Now also triggers a spawn when any container is below 150k hits,
// and passes container targets to roleRepairBot via the same spawn path.
// The CONTAINER_TRIGGER_HITS value here must stay in sync with the constant
// of the same name in roleRepairBot.js.

function manageRepairBotSpawns() {
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;
    var rs = getRoomState.get(roomName);
    if (!rs || !rs.structuresByType) continue;

    // ── Road metrics ─────────────────────────────────────────────────────────
    var roads = rs.structuresByType[STRUCTURE_ROAD] || [];
    var roadsBelow75 = 0;
    var roadsBelow50 = 0;
    for (var i = 0; i < roads.length; i++) {
      var road = roads[i];
      if (!road || typeof road.hits !== 'number' || typeof road.hitsMax !== 'number' || road.hitsMax === 0) continue;
      var ratio = road.hits / road.hitsMax;
      if (ratio < 0.75) roadsBelow75++;
      if (ratio < 0.50) roadsBelow50++;
    }

    // ── Container metrics ─────────────────────────────────────────────────────
    var containersBelowTrigger = 0;
    var contArr = rs.structuresByType[STRUCTURE_CONTAINER] || [];
    for (var ci = 0; ci < contArr.length; ci++) {
      var cont = contArr[ci];
      if (!cont || typeof cont.hits !== 'number') continue;
      if (cont.hits < 150000) containersBelowTrigger++;
    }

    // Skip if there is nothing to do.
    if (roadsBelow75 === 0 && containersBelowTrigger === 0) continue;

    // Spawn condition: 3+ roads below 50%, OR at least one container below 150k.
    if (roadsBelow50 < 3 && containersBelowTrigger === 0) continue;

    // Max 1 repairBot per room — check alive and spawning.
    var existing = 0;
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.role === 'repairBot' &&
          (c.memory.homeRoom === roomName || c.memory.assignedRoom === roomName)) {
        existing++;
      }
    }
    if (existing >= 1) continue;

    // Also check if one is currently being spawned.
    var spawning = false;
    if (rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var si = 0; si < rs.structuresByType[STRUCTURE_SPAWN].length; si++) {
        var chk = rs.structuresByType[STRUCTURE_SPAWN][si];
        if (chk.my && chk.spawning) {
          var chkMem = Memory.creeps[chk.spawning.name];
          if (chkMem && chkMem.role === 'repairBot' && chkMem.homeRoom === roomName) {
            spawning = true;
            break;
          }
        }
      }
    }
    if (spawning) continue;

    // ── Cooldown guard — respect the delay written by the bot on suicide ─────
    var _rbCd = (Memory.repairBotCooldown && Memory.repairBotCooldown[roomName]) || Memory['repairBotCooldown_' + roomName];
    if (_rbCd && Game.time < _rbCd) continue;

    // Find a free spawn.
    var freeSpawn = null;
    if (rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = getCreepBody('repairBot', freeSpawn.room.energyAvailable);
    if (!body) continue;
    var cost = bodyCost(body);
    if (cost > freeSpawn.room.energyAvailable) continue;

    var newName = 'RepairBot_' + roomName + '_' + (Game.time % 10000);
    var memory = {
      role:         'repairBot',
      homeRoom:     roomName,
      assignedRoom: roomName
    };

    var res = freeSpawn.spawnCreep(body, newName, { memory: memory });
    if (res === OK) {
      if (Memory.repairBotCooldown) delete Memory.repairBotCooldown[roomName];
      delete Memory['repairBotCooldown_' + roomName];
      console.log('[RepairBot] Spawning ' + newName + ' in ' + roomName +
        ' | Roads <50%: ' + roadsBelow50 +
        ' | Roads <75%: ' + roadsBelow75 +
        ' | Containers <150k: ' + containersBelowTrigger +
        ' | Parts: ' + body.length + ' | Cost: ' + cost);
    } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[RepairBot] Failed to spawn in ' + roomName + ': ' + res);
    }
  }
}

function manageRampartBotSpawns() {
  var _rbPause = Memory.spawnPause && Memory.spawnPause.rampartBot;

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    if (_rbPause && (_rbPause.global || (_rbPause.rooms && _rbPause.rooms[roomName]))) {
      if (Game.time % 50 === 0) console.log('[RampartBot] Spawning paused for ' + roomName);
      continue;
    }

    var rcl = room.controller.level;
    if (rcl < 2) continue;

    var rs = getRoomState.get(roomName);
    if (!rs || !rs.structuresByType) continue;

    var ramparts = rs.structuresByType[STRUCTURE_RAMPART] || [];
    if (ramparts.length === 0) continue;

    // Per-rampart threshold: spawn when any rampart drops below
    // (its per-structure target − RAMPARTBOT_SPAWN_OFFSET).
    var structurePositions = [];
    for (var spi = 0; spi < RAMPARTBOT_PROTECTED_STRUCTURES.length; spi++) {
      var spType = RAMPARTBOT_PROTECTED_STRUCTURES[spi];
      var spTarget = RAMPARTBOT_STRUCTURE_TARGETS[spType];
      var spArr = rs.structuresByType[spType] || [];
      for (var spj = 0; spj < spArr.length; spj++) {
        if (spArr[spj] && spArr[spj].pos) {
          structurePositions.push({ pos: spArr[spj].pos, target: spTarget });
        }
      }
    }

    var rclCap = RAMPART_HITS_MAX[rcl] || 0;
    var pr = RAMPARTBOT_PERIMETER_RANGE;

    // Sort protected-structure positions by target descending once per room so
    // rampartTargetFor can break on the first adjacent match (which is the max
    // target by construction). Replaces getRangeTo with inline Chebyshev
    // (equivalent for same-room positions; all entries come from the same rs).
    structurePositions.sort(function(a, b) { return b.target - a.target; });

    function rampartTargetFor(ramp) {
      var rx = ramp.pos.x, ry = ramp.pos.y;
      var maxTarget = 0;
      for (var k = 0; k < structurePositions.length; k++) {
        var ssp = structurePositions[k];
        if (Math.abs(rx - ssp.pos.x) <= 1 && Math.abs(ry - ssp.pos.y) <= 1) {
          maxTarget = ssp.target;
          break; // first match in descending-target order is the max
        }
      }
      if (maxTarget === 0) {
        if (rx <= pr || rx >= 49 - pr || ry <= pr || ry >= 49 - pr) {
          maxTarget = RAMPARTBOT_EXTERNAL_TARGET;
        } else {
          return 0;
        }
      }
      if (rclCap > 0 && maxTarget > rclCap) maxTarget = rclCap;
      return maxTarget;
    }

    var needsSpawn = false;
    for (var i = 0; i < ramparts.length; i++) {
      var ramp = ramparts[i];
      if (!ramp || !ramp.my || typeof ramp.hits !== 'number') continue;
      var target = rampartTargetFor(ramp);
      if (target <= 0) continue;
      if (ramp.hits < target - RAMPARTBOT_SPAWN_OFFSET) {
        needsSpawn = true;
        break;
      }
    }

    if (!needsSpawn) continue;

    // Per-role slot: a rampartBot already in (or spawning for) this room
    // is enough — wallRepair in the same room no longer suppresses us.
    var aliveCount = 0;
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.role === 'rampartBot' &&
          (c.memory.homeRoom === roomName || c.memory.assignedRoom === roomName)) {
        aliveCount++;
      }
    }
    if (aliveCount >= 1) continue;

    var spawning = false;
    if (rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var si = 0; si < rs.structuresByType[STRUCTURE_SPAWN].length; si++) {
        var chk = rs.structuresByType[STRUCTURE_SPAWN][si];
        if (chk.my && chk.spawning) {
          var chkMem = Memory.creeps[chk.spawning.name];
          if (chkMem && chkMem.role === 'rampartBot' &&
              chkMem.homeRoom === roomName) {
            spawning = true;
            break;
          }
        }
      }
    }
    if (spawning) continue;

    var cooldownKey = 'rampartBotCooldown_' + roomName;
    if (Memory[cooldownKey] && Game.time < Memory[cooldownKey]) continue;

    var freeSpawn = null;
    if (rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = undefined;
    var boostActive = global.__boostActive && getBoostMgr().isActive(roomName, 'rampartBot');

    if (boostActive) {
      var boostBody = getBoostMgr().getBody(roomName, 'rampartBot');
      if (boostBody) {
        var boostCost = getBoostMgr().getBodyCost(roomName, 'rampartBot');
        if (freeSpawn.room.energyAvailable < boostCost) {
          if (Game.time % 20 === 0) {
            console.log('[RampartBot] ' + roomName + ': Need ' + boostCost +
              ' energy for boosted rampartBot, have ' + freeSpawn.room.energyAvailable);
          }
          continue;
        }
        if (!getBoostMgr().areLabsReady(roomName, 'rampartBot')) {
          if (Game.time % 20 === 0) {
            console.log('[RampartBot] ' + roomName + ': Waiting for boost labs');
          }
          continue;
        }
        body = boostBody;
      }
    }

    if (!body) {
      body = getCreepBody('wallRepair', freeSpawn.room.energyAvailable);
    }

    if (!body) continue;
    var cost = bodyCost(body);
    if (cost > freeSpawn.room.energyAvailable) continue;

    var newName = 'RampartBot_' + roomName + '_' + (Game.time % 10000);
    var memory = {
      role:         'rampartBot',
      homeRoom:     roomName,
      assignedRoom: roomName
    };

    if (boostActive) {
      var boostMeta = getBoostMgr().getSpawnBoostMeta(roomName, 'rampartBot');
      if (boostMeta) {
        memory.needsBoost = true;
        memory.boostLabs  = boostMeta.boostLabs;
        memory.boosted    = boostMeta.boosted;
      }
    }

    var res = freeSpawn.spawnCreep(body, newName, { memory: memory });
    if (res === OK) {
      delete Memory[cooldownKey];
      console.log('[RampartBot] Spawning ' + newName + ' in ' + roomName +
        ' (RCL ' + rcl + ')' +
        (boostActive ? ' [BOOSTED]' : '') +
        ' | Parts: ' + body.length + ' | Cost: ' + cost);
    } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[RampartBot] Failed to spawn in ' + roomName + ': ' + res);
    }
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
    var activeOrder = labOrders && labOrders.active;
    var activeMarketLabOrder = activeOrder && (activeOrder.origin === 'marketLab' || activeOrder.marketOpId);
 
    // ── NEW: Check if boost labs need work too ──
    var hasBoostWork = global.__boostActive ? getBoostMgr().needsLabBot(roomName) : false; 
    // Skip if neither production nor boost work exists
    if (!hasActiveOrder && !hasBoostWork) continue;
    if (activeMarketLabOrder) continue;
 
    // If only production orders exist, check if labManager actually needs work
    if (hasActiveOrder && !hasBoostWork && !labManager.labsNeedWork(roomName)) {
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
  if (!Memory.towerDrainOps || !Memory.towerDrainOps.operations) return;

  var operations = Memory.towerDrainOps.operations;

  for (var opKey in operations) {
    var op = operations[opKey];
    if (!op) continue;

    if (op.status !== 'ready' && op.status !== 'active') continue;
    if (op.creeps.length >= op.maxDrainers) continue;

    var home = Game.rooms[op.homeRoom];
    if (!home || !home.controller || !home.controller.my) continue;

    var rs = getRoomState.get(op.homeRoom);
    if (!rs) continue;

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

    var body = [];

    if (op.longRange) {
      for (var t = 0; t < 9;  t++) body.push(TOUGH);
      body.push(ATTACK);
      for (var m = 0; m < 25; m++) body.push(MOVE);
      for (var h = 0; h < 15; h++) body.push(HEAL);
    } else {
      var energyAvailable = freeSpawn.room.energyCapacityAvailable;

      var attackCost = 80;
      var extraMoveCost = 50;
      var setCost = 10 + 50 + 250;
      var maxSets = Math.floor((energyAvailable - attackCost - extraMoveCost) / setCost);

      if (maxSets > 15) maxSets = 15;
      if (maxSets < 1) maxSets = 1;

      for (var t = 0; t < maxSets; t++) {
        body.push(TOUGH);
      }
      body.push(ATTACK);
      for (var m = 0; m < maxSets + 1; m++) {
        body.push(MOVE);
      }
      for (var h = 0; h < maxSets; h++) {
        body.push(HEAL);
      }
    }

    var cost = bodyCost(body);
    if (cost > freeSpawn.room.energyAvailable) {
      if (Game.time % 20 === 0) {
        console.log('[TowerDrain] Not enough energy in ' + op.homeRoom + ' for drainer. Have: ' + freeSpawn.room.energyAvailable + ', Need: ' + cost);
      }
      continue;
    }

    var lane = op.lanes[String(laneNumber)];
    if (!lane) {
      console.log('[TowerDrain] ERROR: Lane ' + laneNumber + ' missing from operation ' + opKey);
      continue;
    }

    var name = 'Attacker_' + op.targetRoom + '_' + laneNumber + '_' + Game.time;

    var memory = {
      role: 'towerDrain',
      homeRoom: op.homeRoom,
      targetRoom: op.targetRoom,
      safeRoom: op.safeRoom,
      route: op.route,
      routeBack: op.routeBack,
      entryEdge: op.entryEdge,
      laneNumber: laneNumber,
      attackRestPos: lane.attackRestPos,
      attackEdgePos: lane.attackEdgePos,
      healEdgePos: lane.healEdgePos,
      healRestPos: lane.healRestPos,
      drainPos: lane.drainPos,
      healPos: lane.healPos,
      laneSet: true
    };

    var result = freeSpawn.spawnCreep(body, name, { memory: memory });

    if (result === OK) {
      towerDrain.registerSpawnedCreep(op.homeRoom, op.targetRoom, name);
      console.log('[TowerDrain] Spawning ' + name +
        ' (lane ' + laneNumber + ')' +
        (op.longRange ? ' [LONG-RANGE]' : '') +
        ' | Parts: ' + body.length + ' | Cost: ' + cost);
    } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[TowerDrain] Failed to spawn in ' + op.homeRoom + ': ' + result);
    }
  }
}

function manageDemolitionSpawns() {
  if (!Memory.demolitionOrders || Memory.demolitionOrders.length === 0) return;
 
  for (const order of Memory.demolitionOrders) {
    const homeRoom  = order.homeRoom;
    const targetRoom = order.targetRoom;
    const teamCount  = order.teamCount;

    const existingDemolishers = _.filter(Game.creeps, function(c) {
      if (!c.memory) return false;
      if (c.memory.role !== 'demolition') return false;
      if (c.memory.targetRoom !== targetRoom) return false;
      if (c.memory.homeRoom !== homeRoom) return false;
      if (c.memory.demolitionRole && c.memory.demolitionRole !== 'demolisher') return false;
      return true;
    });
    if (existingDemolishers.length >= teamCount) continue;
 
    const home = Game.rooms[homeRoom];
    if (!home || !home.controller || !home.controller.my) {
      console.log("[Demolition] Home room " + homeRoom + " is no longer valid. Skipping spawn.");
      continue;
    }
 
    var rsHome = getRoomState.get(homeRoom);
    if (!rsHome) continue;
 
    var spawns = [];
    if (rsHome.structuresByType && rsHome.structuresByType[STRUCTURE_SPAWN]) {
      spawns = rsHome.structuresByType[STRUCTURE_SPAWN].filter(function(s) {
        return s.my && !s.spawning;
      });
    }
    if (spawns.length === 0) continue;

    const needed = teamCount - existingDemolishers.length;
    if (needed <= 0) continue;
 
    if (Game.time % 20 === 0) {
      console.log("[Demolition] Order " + homeRoom + "->" + targetRoom +
        ": Need " + needed + " demolishers, have " + existingDemolishers.length);
    }
 
    // ── Boost awareness ───────────────────────────────────────────────────
    // Mirror the same pattern used by manageRampartBotSpawns().
    // If a boost order is active but labs aren't ready yet, hold off —
    // don't waste a spawn on an unboosted body while compound is en route.
    var boostActive = global.__boostActive && getBoostMgr().isActive(homeRoom, 'demolisher');
    var boostBody   = null;
    var boostMeta   = null;
 
    if (boostActive) {
      boostBody = getBoostMgr().getBody(homeRoom, 'demolisher');
 
      if (boostBody) {
        var boostCost = getBoostMgr().getBodyCost(homeRoom, 'demolisher');
 
        if (home.energyAvailable < boostCost) {
          if (Game.time % 20 === 0) {
            console.log('[Demolition] ' + homeRoom + ': Need ' + boostCost +
              ' energy for boosted demolisher, have ' + home.energyAvailable);
          }
          continue; // wait for energy — don't fall back to unboosted
        }
 
        if (!getBoostMgr().areLabsReady(homeRoom, 'demolisher')) {
          if (Game.time % 20 === 0) {
            console.log('[Demolition] ' + homeRoom + ': Waiting for boost labs to fill');
          }
          continue; // wait for lab — don't fall back to unboosted
        }
 
        boostMeta = getBoostMgr().getSpawnBoostMeta(homeRoom, 'demolisher');
      }
    }
    // ─────────────────────────────────────────────────────────────────────
 
    for (var i = 0; i < needed; i++) {
      var spawn = spawns.shift();
      if (!spawn) break;
 
      // Pick body: boosted first, then normal energy-scaled fallback
      var demolisherBody = (boostActive && boostBody)
        ? boostBody
        : getCreepBody('demolisher', spawn.room.energyAvailable);
 
      if (!demolisherBody) {
        if (Game.time % 20 === 0) {
          console.log("[Demolition] Not enough energy in " + homeRoom +
            " for demolisher. Have: " + spawn.room.energyAvailable);
        }
        spawns.unshift(spawn); // return the spawn slot
        break;
      }
 
      const teamId = targetRoom + "_" + Game.time + "_" + Math.floor(Math.random() * 1000);
      const demolisherName = "Demolisher_" + teamId;
 
      const demolisherMemory = {
        role:           'demolition',
        demolitionRole: 'demolisher',
        homeRoom:       homeRoom,
        targetRoom:     targetRoom,
        teamId:         teamId
      };
 
      // Inject boost metadata — roleDemolition.handleBoosting() reads this
      // and holds the creep at the lab before it heads to the target room.
      if (boostActive && boostMeta) {
        demolisherMemory.needsBoost = true;
        demolisherMemory.boostLabs  = boostMeta.boostLabs;
        demolisherMemory.boosted    = boostMeta.boosted;
      }
 
      const result = spawn.spawnCreep(demolisherBody, demolisherName, { memory: demolisherMemory });
      if (result === OK) {
        console.log("[Demolition] Spawning " + (boostActive ? '[BOOSTED] ' : '') +
          "demolisher '" + demolisherName + "' from " + homeRoom +
          " for " + targetRoom +
          " | Parts: " + demolisherBody.length +
          " | Cost: " + bodyCost(demolisherBody));
      } else if (result !== ERR_BUSY) {
        console.log("[Demolition] Failed to spawn '" + demolisherName + "': " + result);
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

  for (var i = Memory.contestedDemolisherOrders.length - 1; i >= 0; i--) {
    var order = Memory.contestedDemolisherOrders[i];
    if (!order) continue;

    var homeRoom = order.homeRoom;
    var targetRoom = order.targetRoom;
    var squadId = order.squadId || ('cd-' + targetRoom + '-' + Game.time);

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

    if (demolisher && healer) {
      if (order.status !== 'active') {
        order.status = 'active';
        console.log("[ContestedDemolisher] Squad " + squadId + " complete and active.");
      }
      continue;
    }

    if (order.status !== 'ready' && order.status !== 'active') {
      if (Game.time % 50 === 0 && order.status === 'scanning') {
        console.log("[ContestedDemolisher] Order " + homeRoom + " -> " + targetRoom + " still scanning route...");
      }
      continue;
    }

    var home = Game.rooms[homeRoom];
    if (!home || !home.controller || !home.controller.my) {
      console.log("[ContestedDemolisher] Invalid home room " + homeRoom + ". Removing order.");
      Memory.contestedDemolisherOrders.splice(i, 1);
      continue;
    }

    var rsHome = getRoomState.get(homeRoom);
    if (!rsHome) continue;

    var allSpawns = [];
    if (rsHome.structuresByType && rsHome.structuresByType[STRUCTURE_SPAWN]) {
      allSpawns = rsHome.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; });
    }
    if (allSpawns.length === 0) continue;

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
    if (isSpawningSquad) continue;

    var spawns = allSpawns.filter(function(s){ return !s.spawning; });
    if (spawns.length === 0) continue;

    var spawn = spawns[0];
    var spawnedSomething = false;

    if (!demolisher) {
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
          route: order.route,
          routeBack: order.routeBack
        };
        var res = spawn.spawnCreep(demoBody, name, { memory: mem });
        if (res === OK) {
          console.log("[ContestedDemolisher] Spawning Demolisher (" + name + ") for " + targetRoom + " | Route: " + (order.route ? order.route.join(' -> ') : 'N/A'));
          spawnedSomething = true;
          order.status = 'active';
        }
      } else if (Game.time % 20 === 0) {
          console.log("[ContestedDemolisher] Not enough energy for Demolisher in " + homeRoom + ". Have: " + spawn.room.energyAvailable + ", Need: " + cost);
      }
    } else if (!healer) {
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

    if (demolisher && healer) {
      if (order.status !== 'active') {
        order.status = 'active';
        console.log("[ContestedDemolisher] Squad " + squadId + " complete and active.");
      }
    }
  }
}

function manageWallRepairSpawns() {
  var _wrPause = Memory.spawnPause && Memory.spawnPause.wallRepair;

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    if (_wrPause && (_wrPause.global || (_wrPause.rooms && _wrPause.rooms[roomName]))) {
      if (Game.time % 50 === 0) console.log('[WallRepair] Spawning paused for ' + roomName);
      continue;
    }

    var rcl = room.controller.level;
    var threshold = WALLREPAIR_THRESHOLD_BY_RCL[rcl] || 0;
    var spawnAt = WALLREPAIR_SPAWN_BY_RCL[rcl] || 0;
    var maxCount = WALLREPAIR_COUNT_BY_RCL[rcl] || 0;

    if (threshold <= 0 || maxCount <= 0) continue;

    var rs = getRoomState.get(roomName);
    if (!rs || !rs.structuresByType) continue;

    // ── Per-role slot: a wallRepair already in (or spawning for) this room
    // is enough — a rampartBot in the same room no longer suppresses us.
    var combinedRepairCount = 0;
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.role === 'wallRepair' &&
          (c.memory.homeRoom === roomName || c.memory.assignedRoom === roomName)) {
        combinedRepairCount++;
      }
    }

    var spawning = false;
    if (rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var si = 0; si < rs.structuresByType[STRUCTURE_SPAWN].length; si++) {
        var chk = rs.structuresByType[STRUCTURE_SPAWN][si];
        if (chk.my && chk.spawning) {
          var chkMem = Memory.creeps[chk.spawning.name];
          if (chkMem && chkMem.role === 'wallRepair' &&
              chkMem.homeRoom === roomName) {
            spawning = true;
            break;
          }
        }
      }
    }
    if (spawning) continue;
    if (combinedRepairCount >= maxCount) continue;

    // Check if any perimeter wall/rampart is below the spawn threshold
    var needsRepair = false;
    var walls = rs.structuresByType[STRUCTURE_WALL] || [];
    for (var wi = 0; wi < walls.length; wi++) {
      var w = walls[wi];
      if (!w || typeof w.hits !== 'number') continue;
      if (w.hits < spawnAt) {
        var x = w.pos.x;
        var y = w.pos.y;
        if (x <= WALLREPAIR_PERIMETER_RANGE || x >= 49 - WALLREPAIR_PERIMETER_RANGE ||
            y <= WALLREPAIR_PERIMETER_RANGE || y >= 49 - WALLREPAIR_PERIMETER_RANGE) {
          needsRepair = true;
          break;
        }
      }
    }

    if (!needsRepair) {
      var ramparts = rs.structuresByType[STRUCTURE_RAMPART] || [];
      for (var ri = 0; ri < ramparts.length; ri++) {
        var ramp = ramparts[ri];
        if (!ramp || !ramp.my || typeof ramp.hits !== 'number') continue;
        if (ramp.hits < spawnAt) {
          var rx = ramp.pos.x;
          var ry = ramp.pos.y;
          if (rx <= WALLREPAIR_PERIMETER_RANGE || rx >= 49 - WALLREPAIR_PERIMETER_RANGE ||
              ry <= WALLREPAIR_PERIMETER_RANGE || ry >= 49 - WALLREPAIR_PERIMETER_RANGE) {
            needsRepair = true;
            break;
          }
        }
      }
    }

    if (!needsRepair) continue;

    var freeSpawn = null;
    if (rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
        if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = getCreepBody('wallRepair', freeSpawn.room.energyAvailable);
    if (!body) continue;

    var cost = bodyCost(body);
    if (cost > freeSpawn.room.energyAvailable) continue;

    var newName = 'WallRepair_' + roomName + '_' + (Game.time % 10000);
    var memory = {
      role:         'wallRepair',
      homeRoom:     roomName,
      assignedRoom: roomName
    };

    var res = freeSpawn.spawnCreep(body, newName, { memory: memory });
    if (res === OK) {
      console.log('[WallRepair] Spawning ' + newName + ' in ' + roomName +
        ' (RCL ' + rcl + ')' +
        ' | Parts: ' + body.length + ' | Cost: ' + cost);
    } else if (res !== ERR_BUSY && res !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[WallRepair] Failed to spawn in ' + roomName + ': ' + res);
    }
  }
}


// Keep in sync with MIN_ENERGY_DROP in roleThief.js
// (or require it: const { MIN_ENERGY_DROP } = require('roleThief');
//  after adding MIN_ENERGY_DROP to roleThief's module.exports)
var MIN_ENERGY_DROP = 200;

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
    // Also check for dropped resources / ruins if we have live vision of the room.
    // Drops are filtered the same way the thief filters them (ignore small
    // energy piles), so a room with only a 50-energy pile doesn't keep the
    // order alive while the thieves refuse to touch it.
    if (!hasResources && Game.rooms[order.targetRoom]) {
      var liveRoom = Game.rooms[order.targetRoom];
      var liveRS = getRoomState.get(order.targetRoom);
      if (liveRS && liveRS.dropped) {
        var liveDropped = liveRS.dropped;
        for (var li = 0; li < liveDropped.length; li++) {
          var r = liveDropped[li];
          if (r.resourceType !== RESOURCE_ENERGY || r.amount >= MIN_ENERGY_DROP) {
            hasResources = true;
            break;
          }
        }
      } else {
        var dropped = liveRoom.find(FIND_DROPPED_RESOURCES, {
          filter: function(r) {
            return r.resourceType !== RESOURCE_ENERGY || r.amount >= MIN_ENERGY_DROP;
          }
        });
        if (dropped.length > 0) hasResources = true;
      }
      if (!hasResources) {
        if (liveRS && liveRS.ruins) {
          var liveRuins = liveRS.ruins;
          for (var li2 = 0; li2 < liveRuins.length; li2++) {
            var ruin = liveRuins[li2];
            if (ruin.store && ruin.store.getUsedCapacity() > 0) {
              hasResources = true;
              break;
            }
          }
        } else {
          var ruins = liveRoom.find(FIND_RUINS, {
            filter: function(r) { return r.store && r.store.getUsedCapacity() > 0; }
          });
          if (ruins.length > 0) hasResources = true;
        }
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

// ============================================================================
// SK ATTACKER SPAWN LOGIC (Continuous operation — auto-replace dead creeps)
// ============================================================================

function manageSKAttackerSpawns() {
  if (!Memory.skAttackOrders || Memory.skAttackOrders.length === 0) return;

  // Clean up inactive orders
  for (var i = Memory.skAttackOrders.length - 1; i >= 0; i--) {
    var order = Memory.skAttackOrders[i];
    if (!order || order.active === false) {
      Memory.skAttackOrders.splice(i, 1);
    }
  }

  for (var idx = 0; idx < Memory.skAttackOrders.length; idx++) {
    var order = Memory.skAttackOrders[idx];
    if (!order || !order.active) continue;

    var spawnRoom = order.spawnRoom;
    var targetRoom = order.targetRoom;
    var desiredCount = order.count || 1;

    // Count living skAttacker creeps assigned to this target
    var living = _.filter(Game.creeps, function(c) {
      return c.memory &&
             c.memory.role === 'skAttacker' &&
             c.memory.targetRoom === targetRoom &&
             !c.memory.noReplace;
    });

    // Also count creeps currently spawning for this target
    var spawningCount = 0;
    var rs = getRoomState.get(spawnRoom);
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var s = 0; s < rs.structuresByType[STRUCTURE_SPAWN].length; s++) {
        var sp = rs.structuresByType[STRUCTURE_SPAWN][s];
        if (sp.my && sp.spawning) {
          var mem = Memory.creeps[sp.spawning.name];
          if (mem && mem.role === 'skAttacker' && mem.targetRoom === targetRoom) {
            spawningCount++;
          }
        }
      }
    }

    var totalActive = living.length + spawningCount;
    if (totalActive >= desiredCount) continue;

    // Find free spawn
    var room = Game.rooms[spawnRoom];
    if (!room || !room.controller || !room.controller.my) {
      if (Game.time % 50 === 0) {
        console.log('[SKAttack] Invalid spawn room: ' + spawnRoom);
      }
      continue;
    }

    if (!rs) continue;

    var freeSpawn = null;
    if (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      for (var j = 0; j < rs.structuresByType[STRUCTURE_SPAWN].length; j++) {
        var spawn = rs.structuresByType[STRUCTURE_SPAWN][j];
        if (spawn.my && !spawn.spawning) { freeSpawn = spawn; break; }
      }
    }
    if (!freeSpawn) continue;

    var body = getCreepBody('skAttacker', freeSpawn.room.energyAvailable);
    if (!body) {
      if (Game.time % 20 === 0) {
        console.log('[SKAttack] Not enough energy in ' + spawnRoom + ' for skAttacker. Need at least 860.');
      }
      continue;
    }

    var cost = bodyCost(body);
    if (cost > freeSpawn.room.energyAvailable) continue;

    var name = 'SKAttacker_' + targetRoom + '_' + (Game.time % 10000);
    var memory = {
      role: 'skAttacker',
      homeRoom: spawnRoom,
      targetRoom: targetRoom,
      state: 'moving'
    };

    var result = freeSpawn.spawnCreep(body, name, { memory: memory });
    if (result === OK) {
      console.log('[SKAttack] Spawning ' + name + ' from ' + spawnRoom + ' -> ' + targetRoom +
                  ' (' + body.length + ' parts, cost=' + cost + ') [' + (totalActive + 1) + '/' + desiredCount + ']');
    } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
      console.log('[SKAttack] Failed to spawn in ' + spawnRoom + ': ' + result);
    }
  }
}

// ============================================================================
// ATTACKER SPAWN LOGIC (SINGLE SPAWN ROOM - spawn & rally in same room)
// ============================================================================

function manageAttackerSpawns() {
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return;

  for (let i = Memory.attackOrders.length - 1; i >= 0; i--) {
    const order = Memory.attackOrders[i];
    const targetRoom = order.targetRoom;
    const spawnRoom = order.spawnRoom;
    const rallyRoom = order.rallyRoom; // same as spawnRoom
    const count = order.count;
    const spawned = order.spawned;
    const startTime = order.startTime;
    const rallyPhase = order.rallyPhase;

    if (rallyPhase === 'spawning') {
      if (spawned < count) {
        const spawnResults = trySpawnAttackers(order, i);
        if (spawnResults > 0) {
          order.spawned += spawnResults;
          console.log("[Attack] Spawned " + spawnResults + " attackers (" + order.spawned + "/" + count + " total) for " + targetRoom + " from " + spawnRoom);
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

/**
 * Spawns attackers only from the designated spawnRoom in the order.
 * @param {Object} order - The attack order
 * @param {number} orderIndex - Index of this order in Memory.attackOrders
 * @returns {number} Number of attackers spawned this tick
 */
function trySpawnAttackers(order, orderIndex) {
  const remainingToSpawn = order.count - order.spawned;
  if (remainingToSpawn <= 0) return 0;

  const spawnRoom = order.spawnRoom;
  const room = Game.rooms[spawnRoom];
  if (!room || !room.controller || !room.controller.my) {
    if (Game.time % 20 === 0) console.log("[Attack] Spawn room " + spawnRoom + " is invalid");
    return 0;
  }

  var rs = getRoomState.get(spawnRoom);
  if (!rs) return 0;

  var spawns = [];
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    spawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
  }
  if (spawns.length === 0) return 0;

  // Use fastAttacker body if the order was placed with fast=true
  const role = order.fast === true ? 'fastAttacker' : 'attacker';
  const body = getCreepBody(role, room.energyAvailable);
  if (!body) return 0;

  const cost = bodyCost(body);
  if (cost > room.energyAvailable) return 0;

  const spawn = spawns[0];
  const attackerName = "Attacker_" + order.targetRoom + "_" + Game.time + "_" + order.spawned;
  const result = spawn.spawnCreep(body, attackerName, {
    memory: {
      role: 'attacker',
      targetRoom: order.targetRoom,
      rallyRoom: order.spawnRoom,
      spawnRoom: order.spawnRoom,
      orderIndex: orderIndex,
      rallyComplete: false,
      fast: order.fast === true
    }
  });

  if (result === OK) {
    console.log("[Attack] Spawning " + role + " '" + attackerName + "' in " + spawnRoom +
      " (energy=" + room.energyAvailable + ", body=" + body.length + " parts, cost=" + cost + ")");
    return 1;
  } else if (result !== ERR_BUSY) {
    console.log("[Attack] Failed to spawn '" + attackerName + "' in " + spawnRoom + ": " + result);
  }

  return 0;
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

    // Find the closest free spawn to the mineral
    var spawn = null;
    var bestSpawnRange = Infinity;
    var spawns = (rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) ? rs.structuresByType[STRUCTURE_SPAWN] : [];
    for (var s = 0; s < spawns.length; s++) {
      if (!spawns[s].my || spawns[s].spawning) continue;
      var r = spawns[s].pos.getRangeTo(mineral.pos);
      if (r < bestSpawnRange) { bestSpawnRange = r; spawn = spawns[s]; }
    }
    if (!spawn) continue;

    var body = buildExtractorBody(spawn.room.energyAvailable);
    if (!body) continue;

    var name   = "extractor_" + roomName + "_" + (Game.time % 1000);
    var memory = { role: 'extractor', roomName: roomName, extractorId: extractor.id };
    var result = spawn.spawnCreep(body, name, { memory: memory });
    if (result === OK) {
      console.log("[Spawn] extractor for " + roomName + " | parts=" + body.length + " | spawnRange=" + bestSpawnRange);
    }
  }
}


/*function spawnCreepInRoom(role, body, spawn, roomName) {
  const newName = role + "_" + roomName + "_" + Game.time;
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
}*/

function shouldSpawnSupplier(roomName) {
  var room = Game.rooms[roomName];
  if (!room || !room.controller || !room.controller.my) return 0;

  if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
    for (var i = 0; i < Memory.factoryOrders.length; i++) {
      var order = Memory.factoryOrders[i];
      if (order && order.room === roomName && order.status === 'active') return 1;
    }
  }

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

function handleRoomSpawnDelay(roomName, room) {
  if (!Memory.spawnDelayUntil) Memory.spawnDelayUntil = {};
  const existing = Memory.spawnDelayUntil[roomName];

  if (existing && Game.time < existing) return true;
  if (existing && Game.time >= existing) delete Memory.spawnDelayUntil[roomName];

  return false;
}

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

  var rs = getRoomState.get(roomName);
  var minerals = (rs && rs.minerals) || room.find(FIND_MINERALS);
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
  if (singleSourceRoom.isSingleSourceActive(roomName)) {
    var sites = (rs && rs.constructionSites) ? rs.constructionSites.length : 0;

    var forcedUpgrader = (Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[roomName]) ? 1 : 0;

    return {
        harvester: 0, upgrader: forcedUpgrader,
        builder: +(sites > 0),
        scout: 0, defender: 0, supplier: 0, maintainer: 0
    };
  }

  var containers = [];
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) {
    containers = rs.structuresByType[STRUCTURE_CONTAINER];
  }

  var constructionSitesCount = 0;
  if (rs && rs.constructionSites) {
    constructionSitesCount = rs.constructionSites.length;
  }
  let builderTarget = +(constructionSitesCount > 0);

  var sourceCount = 0;
  if (rs && rs.sources) {
    sourceCount = rs.sources.length;
  } else {
    var sources = room.find(FIND_SOURCES);
    sourceCount = sources.length;
  }

  var storageEnergy = 0;
  if (rs && rs.storage && rs.storage.store) {
    storageEnergy = rs.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  } else if (room.storage && room.storage.store) {
    storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  }

  var upgraderTarget = 1;
  var maintainerTarget = 0;

  if (room.controller && room.controller.level === 8) {
    var ticksThreshold = (sourceCount === 1) ? 150000 : 125000;

    upgraderTarget = 0; // RCL 8 default: no upgrader — use forceUpgrader or allowUpgrader

    if (room.controller.ticksToDowngrade < ticksThreshold) {
      maintainerTarget = 1;
    }
  }

  if (Memory.doubleUpgradeRooms && Memory.doubleUpgradeRooms[roomName]) {
    if (room.controller && room.controller.level <= 7) {
      upgraderTarget = 2;
    }
  }

  // Boosted upgrader override
  if (global.__boostActive && getBoostMgr().isActive(roomName, 'upgrader')) {
    upgraderTarget = 1;
    maintainerTarget = 0;
  }

  // allowUpgrader: spawn only while mining is active (RCL 8 only, mutually exclusive with forceUpgrader)
  if (room.controller && room.controller.level === 8 &&
      Memory.allowUpgraderRooms && Memory.allowUpgraderRooms[roomName]) {
    var miningActive = isMiningActive(rs, containers);
    if (miningActive) {
      upgraderTarget = 1;
      maintainerTarget = 0;
    } else {
      upgraderTarget = 0;
      // maintainerTarget preserved from normal RCL 8 logic above
    }
  }

  // forceUpgrader: always spawn an upgrader at RCL 8 (console command override)
  if (room.controller && room.controller.level === 8 &&
      Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[roomName]) {
    upgraderTarget = 1;
    maintainerTarget = 0;
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
 
// ── 2c. FULL REPLACEMENT: spawnCreepInRoom() ────────────────────────────────
// Replace the entire spawnCreepInRoom function with this version.
// Changes: boost metadata injection after the memory object is created.
 
function isMiningActive(rs, containers) {
  if (!rs) return false;

  var extractor = null;
  if (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTRACTOR]) {
    var list = rs.structuresByType[STRUCTURE_EXTRACTOR].filter(function(e){ return e.my; });
    extractor = list[0];
  }
  if (!extractor) return false;

  var mineral = (rs.minerals && rs.minerals.length > 0) ? rs.minerals[0] : null;
  if (!mineral || mineral.mineralAmount === 0) return false;

  for (var i = 0; i < containers.length; i++) {
    if (containers[i].pos.getRangeTo(extractor.pos) <= 1) return true;
  }
  return false;
}

function spawnCreepInRoom(role, body, spawn, roomName) {
  const newName = role + "_" + roomName + "_" + Game.time;
  const memory = { role: role, assignedRoom: roomName, homeRoom: roomName };
 
  // ── NEW: Inject boost metadata if this role is being boosted ──
if (global.__boostActive && getBoostMgr().isActive(roomName, role)) {
    var boostMeta = getBoostMgr().getSpawnBoostMeta(roomName, role);
    if (boostMeta) {
      memory.needsBoost = true;
      memory.boostLabs  = boostMeta.boostLabs;   // { compound: labId }
      memory.boosted    = boostMeta.boosted;      // { compound: true } — filled during boost
    }
  }
 
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

function manageTowerFillerSpawns() {
    var roleTowerFiller = require('roleTowerFiller');
    var SPAWN_TRIGGER = roleTowerFiller.SPAWN_TRIGGER_RATIO; // 0.25

    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;

        // ── 1. Require at least one hostile creep in the room ─────────────────
        var rs = getRoomState.get(roomName);
        var hostiles = (rs && rs.hostiles) || room.find(FIND_HOSTILE_CREEPS);
        hostiles = hostiles.filter(function(c) {
            if (!c || !c.owner) return false;
            if (c.owner.username === 'Invader' || c.owner.username === 'Source Keeper') return false;
            return !isPureScout(c);
        });
        if (hostiles.length === 0) continue;

        // ── 2. Require at least one tower at or below the spawn trigger ───────
        if (!rs || !rs.structuresByType) continue;

        var towers = rs.structuresByType[STRUCTURE_TOWER] || [];
        if (towers.length === 0) continue;

        var criticalTower = false;
        for (var ti = 0; ti < towers.length; ti++) {
            var t = towers[ti];
            if (!t || !t.my || !t.store) continue;
            var ratio = t.store.getUsedCapacity(RESOURCE_ENERGY) /
                        t.store.getCapacity(RESOURCE_ENERGY);
            if (ratio <= SPAWN_TRIGGER) { criticalTower = true; break; }
        }
        if (!criticalTower) continue;

        // ── 3. Skip if a towerFiller already exists or is spawning ────────────
        var alreadyExists = false;
        for (var cname in Game.creeps) {
            var c = Game.creeps[cname];
            if (!c || !c.memory) continue;
            if (c.memory.role === 'towerFiller' &&
                (c.memory.homeRoom === roomName || c.memory.assignedRoom === roomName)) {
                alreadyExists = true;
                break;
            }
        }
        if (alreadyExists) continue;

        var spawning = false;
        var spawns = rs.structuresByType[STRUCTURE_SPAWN] || [];
        for (var si = 0; si < spawns.length && !spawning; si++) {
            var chk = spawns[si];
            if (chk.my && chk.spawning) {
                var chkMem = Memory.creeps[chk.spawning.name];
                if (chkMem && chkMem.role === 'towerFiller' && chkMem.homeRoom === roomName) {
                    spawning = true;
                }
            }
        }
        if (spawning) continue;

        // ── 4. Find a free spawn ──────────────────────────────────────────────
        var freeSpawn = null;
        for (var s = 0; s < spawns.length; s++) {
            if (spawns[s].my && !spawns[s].spawning) { freeSpawn = spawns[s]; break; }
        }
        if (!freeSpawn) continue;

        // ── 5. Select body via getCreepBody (towerFiller tiers live there) ────
        var body = getCreepBody('towerFiller', freeSpawn.room.energyAvailable);
        if (!body) {
            if (Game.time % 10 === 0) {
                console.log('[TowerFiller] Not enough energy in ' + roomName +
                    ' to spawn. Have: ' + freeSpawn.room.energyAvailable + ', min: 150');
            }
            continue;
        }

        var cost = bodyCost(body);
        var carryCapacity = 0;
        for (var bi = 0; bi < body.length; bi++) {
            if (body[bi] === CARRY) carryCapacity += 50;
        }

        // ── 6. Spawn ──────────────────────────────────────────────────────────
        var newName = 'TowerFiller_' + roomName + '_' + (Game.time % 10000);
        var memory = {
            role:         'towerFiller',
            homeRoom:     roomName,
            assignedRoom: roomName,
            state:        'collect'
        };

        var result = freeSpawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            console.log('[TowerFiller] Spawning ' + newName + ' in ' + roomName +
                ' | Carry: ' + carryCapacity +
                ' | Parts: ' + body.length +
                ' | Cost: ' + cost +
                ' | Hostiles: ' + hostiles.length);
        } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
            console.log('[TowerFiller] Spawn failed in ' + roomName + ': ' + result);
        }
    }
}

function isPureScout(creep) {
    if (!creep || !creep.body || creep.body.length === 0) return true;
    for (var i = 0; i < creep.body.length; i++) {
        if (creep.body[i].type !== MOVE) return false;
    }
    return true;
}



function manageHarvesterSpawns() {
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (singleSourceRoom.isSingleSourceActive(roomName)) continue;
    if (!room.controller || !room.controller.my) continue;

    var storageEnergy = 0;
    var rs = getRoomState.get(roomName);
    var storage = rs ? rs.storage : null;
    if (storage && storage.store) {
      storageEnergy = storage.store[RESOURCE_ENERGY] || 0;
    }

    var meta = ensureSourceMetaCache(room);
    if (!meta || !meta.byId) continue;

    // Collect ALL owned spawns (busy or not) — we lock to the closest one per source
    var allSpawns = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
      allSpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; });
    }
    if (allSpawns.length === 0) continue;

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

    // Skip room if storage is rich AND every source already has a harvester
    if (storageEnergy >= 700000) {
      var allSourcesCovered = true;
      for (var sid in meta.byId) {
        if ((perSourceCounts[sid] || 0) === 0) { allSourcesCovered = false; break; }
      }
      if (allSourcesCovered) continue;
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

    // Find the CLOSEST spawn to this source regardless of availability.
    // If it's busy, wait for it — don't fall back to a farther spawn.
    var closestSpawn = null;
    var bestSpawnRange = Infinity;
    for (var si = 0; si < allSpawns.length; si++) {
      var sp = allSpawns[si];
      var r = sp.pos.getRangeTo(sourcePos);
      if (r < bestSpawnRange) {
        bestSpawnRange = r;
        closestSpawn = sp;
      }
    }
    if (!closestSpawn) continue;

    // Closest spawn is busy — wait rather than use a farther one
    if (closestSpawn.spawning) continue;

    var spawn = closestSpawn;
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
    var directions = getSpawnDirections(spawn.pos, sourcePos);
    var spawnOpts = { memory: memory };
    if (directions) spawnOpts.directions = directions;
    var res = spawn.spawnCreep(body, hName, spawnOpts);

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
// ============================================================================
// One-call orchestrator for spawn systems
// ============================================================================

function manageRepairerSpawns() {
  if (!Memory.repairSpawnRequests) return;
  var pause = Memory.spawnPause && Memory.spawnPause.repairer;

  for (var roomName in Memory.repairSpawnRequests) {
    if (pause && (pause.global || (pause.rooms && pause.rooms[roomName]))) continue;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;
    var requests = Memory.repairSpawnRequests[roomName];
    if (!requests || requests.length === 0) continue;

    requests.sort(function(a, b) { return (a.priority || 99) - (b.priority || 99); });

    for (var i = requests.length - 1; i >= 0; i--) {
      var old = requests[i];
      if (old.spawned || old.s || Game.time - (old.ct || old.createdAt || Game.time) > 100) requests.splice(i, 1);
    }
    if (requests.length === 0) continue;

    var rs = getRoomState.get(roomName);
    if (!rs || !rs.structuresByType || !rs.structuresByType[STRUCTURE_SPAWN]) continue;

    var freeSpawn = null;
    for (var si = 0; si < rs.structuresByType[STRUCTURE_SPAWN].length; si++) {
      var sp = rs.structuresByType[STRUCTURE_SPAWN][si];
      if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
    }
    if (!freeSpawn) continue;

    for (var ri = 0; ri < requests.length; ri++) {
      var req = requests[ri];
      if (!req || req.spawned) continue;
      if (req.kind === 'extra') {
        if (!room.storage || room.storage.store[RESOURCE_ENERGY] < 300000) {
          req.blockedReason = 'storage below 300k';
          continue;
        }
      }
      var body = req.body;
      if (!body && req.b) {
        body = [];
        var order = [WORK, CARRY, MOVE, TOUGH, ATTACK, RANGED_ATTACK, HEAL, CLAIM];
        for (var bi = 0; bi < order.length; bi++) {
          var part = order[bi];
          var count = req.b[part] || 0;
          for (var pi = 0; pi < count; pi++) body.push(part);
        }
      }
      if (!body || !body.length) { requests.splice(ri, 1); ri--; continue; }
      var cost = req.cost || bodyCost(body);
      if (freeSpawn.room.energyAvailable < cost) {
        req.blockedReason = 'need ' + cost + ' energy';
        continue;
      }

      var name = 'Repairer_' + roomName + '_' + req.kind + '_' + (Game.time % 10000);
      var memory = {
        role: 'repairer',
        homeRoom: roomName,
        repairKind: req.kind,
        task: req.task
      };
      var result = freeSpawn.spawnCreep(body, name, { memory: memory });
      if (result === OK) {
        console.log('[RepairManager] Spawning ' + name + ' in ' + roomName +
          ' | kind:' + req.kind + ' | cost:' + cost + ' | parts:' + body.length);
        requests.splice(ri, 1);
      } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
        console.log('[RepairManager] Failed to spawn repairer in ' + roomName + ': ' + result);
      }
      break;
    }
  }
}

function run(perRoomRoleCounts) {
  // 1. Run low-priority spawns
  if (Game.time % 5 === 0)  manageDemolitionSpawns();
  if (Game.time % 5 === 0)  manageAttackerSpawns();
  if (Game.time % 5 === 0)  manageTowerDrainSpawns();
  if (Game.time % 5 === 0)  manageThiefSpawns();
  if (Game.time % 5 === 0)  manageExtractorSpawns();
  if (Game.time % 2 === 0)  manageLabBotSpawns();
  // Legacy repair spawns are replaced by repairManager + repairer.
  // Existing old-role creeps keep running until they naturally expire.
  // if (Game.time % 10 === 0) manageWallRepairSpawns();
  if (Game.time % 10 === 0) manageNukeFillSpawns();
  if (Game.time % 5 === 0) manageRemoteBuilderSpawns();
  if (Game.time % 5 === 0) manageContestedDemolisherSpawns();
  if (Game.time % 5 === 0) manageSKAttackerSpawns();
  // if (Game.time % 10 === 0) manageDefenseRepairSpawns();
  // Single-source rooms use their own spawn logic
  if (Game.time % 10 === 0) manageSingleSourceSpawns(perRoomRoleCounts);
  // if (Game.time % 10 === 0) manageRepairBotSpawns();
  // if (Game.time % 10 === 0) manageRampartBotSpawns();
  if (Game.time % 5 === 0) manageRemoteSupplierSpawns();
  if (Game.time % 10 === 0) manageControllerAttackerSpawns();
  if (Game.time % 10 === 0) manageExtractorAssistantSpawns();
  if (Game.time % 10 === 0)  manageTowerFillerSpawns();
  // 2. Run High Priority (Room Economy)
  if (needsNewCreeps(perRoomRoleCounts) || Game.time % 10 === 0) {
    manageSpawnsPerRoom(perRoomRoleCounts);
  }

  // Repairers are intentionally lower spawn priority than harvesters,
  // suppliers, and tower fillers.
  if (Game.time % 10 === 0) manageRepairerSpawns();

  // 3. Run Squad Spawns (AFTER economy)
  if (Game.time % 5 === 0)  manageSquadSpawns(perRoomRoleCounts); 
}

function manageControllerAttackerSpawns() {
  if (!Memory.controllerAttackOrders || Memory.controllerAttackOrders.length === 0) return;

  const order = Memory.controllerAttackOrders[0];
  if (!order) { Memory.controllerAttackOrders.shift(); return; }

  const existing = _.find(Game.creeps, c =>
    c.memory && c.memory.role === 'controllerAttacker' && c.memory.targetRoom === order.targetRoom
  );
  if (existing) {
    console.log('[ControllerAttack] Creep already exists for ' + order.targetRoom + '. Removing order.');
    Memory.controllerAttackOrders.shift();
    return;
  }

  const room = Game.rooms[order.homeRoom];
  if (!order.homeRoom || !room || !room.controller || !room.controller.my) {
    console.log('[ControllerAttack] Invalid home room: ' + order.homeRoom + '. Trashing order.');
    Memory.controllerAttackOrders.shift();
    return;
  }

  const rs = getRoomState.get(order.homeRoom);
  if (!rs || !rs.structuresByType || !rs.structuresByType[STRUCTURE_SPAWN]) {
    if (Game.time % 10 === 0) console.log('[ControllerAttack] No spawns in ' + order.homeRoom);
    return;
  }

  const spawn = rs.structuresByType[STRUCTURE_SPAWN].find(s => s.my && !s.spawning);
  if (!spawn) return;

  const PAIR_COST    = 650;
  const MAX_PAIRS    = 19;
  const LARGE_PAIRS  = 15;
  const MIN_PAIRS    = 1;

  const capacity  = spawn.room.energyCapacityAvailable;
  const available = spawn.room.energyAvailable;

  const maxPairs    = Math.min(MAX_PAIRS, Math.floor(capacity / PAIR_COST));
  const fullCost    = maxPairs * PAIR_COST;

  const fallbackPairs = Math.min(maxPairs, LARGE_PAIRS);
  const fallbackCost  = fallbackPairs * PAIR_COST;

  let targetPairs, targetCost, tierLabel;

  if (available >= fullCost && maxPairs >= MIN_PAIRS) {
    targetPairs = maxPairs;
    targetCost  = fullCost;
    tierLabel   = 'FULL (' + targetPairs + ' pairs)';
  } else if (available >= fallbackCost && fallbackPairs >= MIN_PAIRS) {
    targetPairs = fallbackPairs;
    targetCost  = fallbackCost;
    tierLabel   = 'LARGE (' + targetPairs + ' pairs)';
  } else {
    if (Game.time % 10 === 0)
      console.log(
        '[ControllerAttack] Waiting for energy in ' + order.homeRoom +
        ' | Have: ' + available +
        ' | Full needs: ' + fullCost +
        ' | Fallback needs: ' + fallbackCost
      );
    return;
  }

  const body = [];
  for (let i = 0; i < targetPairs; i++) body.push(CLAIM);
  for (let i = 0; i < targetPairs; i++) body.push(MOVE);

  const name = 'CtrlAtk_' + order.targetRoom + '_' + Game.time;
  const res  = spawn.spawnCreep(body, name, {
    memory: {
      role:       'controllerAttacker',
      homeRoom:   order.homeRoom,
      targetRoom: order.targetRoom
    }
  });

  if (res === OK) {
    console.log(
      '[ControllerAttack] Spawning ' + name +
      ' | ' + order.homeRoom + ' -> ' + order.targetRoom +
      ' | Tier: ' + tierLabel +
      ' | Parts: ' + body.length + ' | Cost: ' + targetCost
    );
    Memory.controllerAttackOrders.shift();
  } else if (res !== ERR_BUSY) {
    console.log('[ControllerAttack] Spawn failed in ' + order.homeRoom + ': error ' + res);
  }
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
  manageAttackerSpawns,
  manageTowerDrainSpawns,
  manageThiefSpawns,
  manageExtractorSpawns,
  manageLabBotSpawns,
  manageWallRepairSpawns,
  manageRepairerSpawns,
  manageSquadSpawns,
  manageNukeFillSpawns,
  manageRemoteBuilderSpawns,
  manageSKAttackerSpawns,
  manageDefenseRepairSpawns,
  manageSingleSourceSpawns,
  getSingleSourceBody,
  manageExtractorAssistantSpawns,
  manageTowerFillerSpawns,

  // Utilities you use elsewhere
  getCreepBody,
  bodyCost,
  shouldSpawnSupplier,
  spawnEmergencyHarvester,
  getRoomTargets,
  handleRoomSpawnDelay
};
