// LLM: Read docs/codex.js before reviewing or changing this file.
// spawnManager.js
// Console globals: doubleUpgrade, pauseWallRepair, resumeWallRepair, pauseRampartBot, resumeRampartBot, forceUpgrader, allowUpgrader, mineralMiningStatus
// Example: doubleUpgrade('E1N1', true) - Enable or disable dual upgrader spawning
// Example: pauseWallRepair('E1N1') - Pause wall repairers for room
// Example: resumeWallRepair('E1N1') - Resume wall repairers for room
// Example: pauseRampartBot('E1N1') - Pause rampart repair bots for room
// Example: resumeRampartBot('E1N1') - Resume rampart repair bots for room
// Example: forceUpgrader('E1N1') - Force spawn an upgrader next tick
// Example: allowUpgrader('E1N1') - Re-allow normal upgrader spawn schedule
// Example: mineralMiningStatus() - Print overview of mineral extractor & mining status
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
 *  NOTE: The pause/resume globals are registered above.
 *        The pause logic is already in the updated manage*() functions.
 */
const getRoomState = require("getRoomState");
const towerDrain = require("roleTowerDrain");
const roleDrainDemolisher = require("roleDrainDemolisher");
const singleSourceRoom = require("singleSourceRoom");
const roomSuspender = require("roomSuspender");
const util = require("util");
const scavengerPolicy = require("scavengerPolicy");
const scavengerLearning = require("scavengerLearning");
const memoryManager = require("memoryManager");
const spawnManagerStorage = memoryManager.storage;
var _marketBuyer = null;
var _marketSeller = null;
var _marketPricing = null;
function getMarketPricing() {
  if (!_marketPricing) _marketPricing = require("marketPricing");
  return _marketPricing;
}

var _boostMgr = null;
function getBoostMgr() {
  if (!_boostMgr) _boostMgr = require("boostManager");
  return _boostMgr;
}

var _repairMgr = null;
function getRepairMgr() {
  if (!_repairMgr) _repairMgr = require("repairManager");
  return _repairMgr;
}

function shouldAttemptRepairerSpawn(e, r) {
  var lastSpawn = Memory.repairSpawnLastTick && Memory.repairSpawnLastTick[e];
  if (typeof lastSpawn === "number" && Game.time - lastSpawn < REPAIR_SPAWN_INTERVAL_TICKS) return false;
  var o;
  try {
    o = getRepairMgr();
  } catch (e) {
    return true;
  }
  if (!o || typeof o.shouldAttemptRepairerSpawn !== "function") return true;
  try {
    if (o.shouldAttemptRepairerSpawn(e)) return true;
  } catch (e) {
    return true;
  }
  for (var t = 0; t < r.length; t++) {
    var a = r[t];
    var n = a && (typeof a.at === "number" ? a.at : typeof a.createdAt === "number" ? a.createdAt : a.ct);
    if (typeof n !== "number") return true;
    if (Game.time - n >= REPAIR_SPAWN_INTERVAL_TICKS) return true;
  }
  return false;
}

spawnManagerStorage.register("spawnManager.extractorEconomics", {
  path: "Memory.extractorEconomics",
  owner: "spawnManager.js",
  mutability: "mutable"
});
function getAllCreeps() {
  var e = getRoomState.creepIndex();
  return e && e.all ? e.all : [];
}

function spawnCreepWithDurableMemory(e, r, o, t, a) {
  var n = e.spawnCreep(r, o, t);
  if (n === OK) memoryManager.requestImmediateSave(a || "spawnManager.spawnCreep");
  return n;
}

const BASIC_HARVESTER = [ WORK, WORK, CARRY, MOVE ];
const BASIC_DEFENDER = [ TOUGH, MOVE, RANGED_ATTACK ];
const SCOUT_BODY = [ MOVE, MOVE, MOVE, MOVE, MOVE ];
const MAINTAINER_BODY = [ WORK, CARRY, CARRY, MOVE ];
const REPAIR_SPAWN_INTERVAL_TICKS = 10;
const LOW_RCL_SPAWN_DELAY_TICKS = 150;
const RCL6_SUPPLIER_SPAWN_BLOCK_TTL = 200;
const SUPPLIER_HANDOFF_TTL = 85;
const TOWER_FILLER_HANDOFF_TTL = 30;
const SPAWN_CADENCE_SLACK = 10;
const RCL8_UPGRADER_SPAWN_DELAY_TICKS = 5e3;
const LARGE_CONSTRUCTION_WORK_THRESHOLD = 1e5;
const EXTRACTOR_COOLDOWN_TICKS = 5;
const EXTRACTOR_PROFITABILITY_RECHECK_TICKS = 1e3;
const EXTRACTOR_ECONOMICS_VERSION = 3;
const SPAWN_STALL_WARN_TICKS = 5;
const SPAWN_STALL_CANCEL_TICKS = 25;
const SPAWN_DIR_DELTA = {
  1: [ 0, -1 ],
  2: [ 1, -1 ],
  3: [ 1, 0 ],
  4: [ 1, 1 ],
  5: [ 0, 1 ],
  6: [ -1, 1 ],
  7: [ -1, 0 ],
  8: [ -1, -1 ]
};
global.doubleUpgrade = function(e, r) {
  if (!Memory.doubleUpgradeRooms) {
    Memory.doubleUpgradeRooms = {};
  }
  if (r) {
    var o = Game.rooms[e];
    if (o && o.controller && o.controller.level >= 8) {
      return "Command Rejected: Room " + e + " is RCL 8. Double upgrade only allowed for RCL 7 and lower.";
    }
    Memory.doubleUpgradeRooms[e] = true;
    return "Double Upgrade ENABLED for " + e + ". Max Upgraders: 2 (Active only if RCL <= 7).";
  } else {
    if (Memory.doubleUpgradeRooms[e]) {
      delete Memory.doubleUpgradeRooms[e];
    }
    return "Double Upgrade DISABLED for " + e + ". Max Upgraders: 1.";
  }
};
global.pauseWallRepair = function(e) {
  if (!Memory.spawnPause) Memory.spawnPause = {};
  if (!Memory.spawnPause.wallRepair) Memory.spawnPause.wallRepair = {
    rooms: {}
  };
  if (e) {
    Memory.spawnPause.wallRepair.rooms[e] = true;
    return "WallRepair spawning PAUSED for " + e + ".";
  }
  Memory.spawnPause.wallRepair.global = true;
  return "WallRepair spawning PAUSED globally.";
};
global.resumeWallRepair = function(e) {
  if (!Memory.spawnPause || !Memory.spawnPause.wallRepair) return "Nothing to resume.";
  if (e) {
    delete Memory.spawnPause.wallRepair.rooms[e];
    return "WallRepair spawning RESUMED for " + e + ".";
  }
  delete Memory.spawnPause.wallRepair.global;
  return "WallRepair spawning RESUMED globally.";
};
global.pauseRampartBot = function(e) {
  if (!Memory.spawnPause) Memory.spawnPause = {};
  if (!Memory.spawnPause.rampartBot) Memory.spawnPause.rampartBot = {
    rooms: {}
  };
  if (e) {
    Memory.spawnPause.rampartBot.rooms[e] = true;
    return "RampartBot spawning PAUSED for " + e + ".";
  }
  Memory.spawnPause.rampartBot.global = true;
  return "RampartBot spawning PAUSED globally.";
};
global.resumeRampartBot = function(e) {
  if (!Memory.spawnPause || !Memory.spawnPause.rampartBot) return "Nothing to resume.";
  if (e) {
    delete Memory.spawnPause.rampartBot.rooms[e];
    return "RampartBot spawning RESUMED for " + e + ".";
  }
  delete Memory.spawnPause.rampartBot.global;
  return "RampartBot spawning RESUMED globally.";
};
global.forceUpgrader = function(e, r) {
  if (!Memory.forceUpgraderRooms) Memory.forceUpgraderRooms = {};
  if (r === false) {
    delete Memory.forceUpgraderRooms[e];
    return "Force upgrader DISABLED for " + e + ". Returning to normal RCL 8 logic.";
  }
  var o = Game.rooms[e];
  if (!o || !o.controller || !o.controller.my) {
    return "Command Rejected: No vision or ownership of " + e + ".";
  }
  if (o.controller.level !== 8) {
    return "Command Rejected: " + e + " is not RCL 8. Use doubleUpgrade() for lower RCL rooms.";
  }
  if (Memory.allowUpgraderRooms && Memory.allowUpgraderRooms[e]) {
    delete Memory.allowUpgraderRooms[e];
    console.log("[forceUpgrader] Cleared allowUpgrader for " + e + " (mutually exclusive).");
  }
  if (!global.__boostActive || !getBoostMgr().isActive(e, "upgrader")) {
    Memory.forceUpgraderRooms[e] = true;
    return "Warning: No boost configured for upgrader in " + e + ". Spawning will use the standard body. Set up boost first for full effect.\n" + "Flag set anyway — disable with forceUpgrader('" + e + "', false).";
  }
  Memory.forceUpgraderRooms[e] = true;
  return "Force upgrader ENABLED for " + e + " ...";
};
global.allowUpgrader = function(e, r) {
  if (!Memory.allowUpgraderRooms) Memory.allowUpgraderRooms = {};
  if (r === false) {
    delete Memory.allowUpgraderRooms[e];
    return "Allow upgrader DISABLED for " + e + ". Returning to normal RCL 8 logic.";
  }
  var o = Game.rooms[e];
  if (!o || !o.controller || !o.controller.my) {
    return "Command Rejected: No vision or ownership of " + e + ".";
  }
  if (o.controller.level !== 8) {
    return "Command Rejected: " + e + " is not RCL 8. allowUpgrader is RCL 8 only.";
  }
  if (Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[e]) {
    delete Memory.forceUpgraderRooms[e];
    console.log("[allowUpgrader] Cleared forceUpgrader for " + e + " (mutually exclusive).");
  }
  Memory.allowUpgraderRooms[e] = true;
  return "Allow upgrader ENABLED for " + e + ". Upgrader spawns only while mining is active (extractor + mineral + container).";
};
const bodyCost = util.bodyCost;
function getSpawnDirections(e, r) {
  var o = r.x - e.x;
  var t = r.y - e.y;
  o = o === 0 ? 0 : o > 0 ? 1 : -1;
  t = t === 0 ? 0 : t > 0 ? 1 : -1;
  if (o === 0 && t === 0) return undefined;
  var a = {
    "0,-1": TOP,
    "1,-1": TOP_RIGHT,
    "1,0": RIGHT,
    "1,1": BOTTOM_RIGHT,
    "0,1": BOTTOM,
    "-1,1": BOTTOM_LEFT,
    "-1,0": LEFT,
    "-1,-1": TOP_LEFT
  };
  var n = a[o + "," + t];
  if (!n) return undefined;
  var i = [ TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT ];
  var R = i.indexOf(n);
  var s = i[(R - 1 + 8) % 8];
  var l = i[(R + 1) % 8];
  var O = [ n, s, l ];
  var m = Game.map.getRoomTerrain(e.roomName);
  var u = Game.rooms[e.roomName];
  var c = {};
  c[TOP] = {
    dx: 0,
    dy: -1
  };
  c[TOP_RIGHT] = {
    dx: 1,
    dy: -1
  };
  c[RIGHT] = {
    dx: 1,
    dy: 0
  };
  c[BOTTOM_RIGHT] = {
    dx: 1,
    dy: 1
  };
  c[BOTTOM] = {
    dx: 0,
    dy: 1
  };
  c[BOTTOM_LEFT] = {
    dx: -1,
    dy: 1
  };
  c[LEFT] = {
    dx: -1,
    dy: 0
  };
  c[TOP_LEFT] = {
    dx: -1,
    dy: -1
  };
  function isTileOpen(e, r) {
    if (e < 0 || e > 49 || r < 0 || r > 49) return false;
    if (m.get(e, r) === TERRAIN_MASK_WALL) return false;
    if (u) {
      var o = u.lookForAt(LOOK_STRUCTURES, e, r);
      for (var t = 0; t < o.length; t++) {
        var a = o[t].structureType;
        if (OBSTACLE_OBJECT_TYPES.indexOf(a) !== -1) {
          return false;
        }
      }
    }
    return true;
  }
  function isTileFree(tx, ty) {
    if (!isTileOpen(tx, ty)) return false;
    if (u && u.lookForAt(LOOK_CREEPS, tx, ty).length > 0) return false;
    return true;
  }
  var E = [];
  for (var f = 0; f < O.length; f++) {
    var M = c[O[f]];
    if (isTileFree(e.x + M.dx, e.y + M.dy)) {
      E.push(O[f]);
    }
  }
  // Every preferred tile is creep-occupied. Creeps move, so fall back to the
  // structural check here rather than jumping straight to the all-eight scan;
  // worst-case behaviour then matches the pre-creep-aware version exactly.
  if (E.length === 0) {
    for (var f2 = 0; f2 < O.length; f2++) {
      var M2 = c[O[f2]];
      if (isTileOpen(e.x + M2.dx, e.y + M2.dy)) {
        E.push(O[f2]);
      }
    }
  }
  if (E.length === 0) {
    var g = [];
    for (var A = 0; A < 8; A++) {
      var p = (R + A) % 8;
      var d = (R - A + 8) % 8;
      if (g.indexOf(i[p]) === -1) g.push(i[p]);
      if (g.indexOf(i[d]) === -1) g.push(i[d]);
    }
    for (var C = 0; C < g.length; C++) {
      var y = c[g[C]];
      if (isTileOpen(e.x + y.dx, e.y + y.dy)) {
        E.push(g[C]);
      }
    }
  }
  if (E.length === 0) return undefined;
  return E;
}

function manageSingleSourceSpawns(e) {
  for (var r in Game.rooms) {
    var o = Game.rooms[r];
    if (!o.controller || !o.controller.my) continue;
    if (roomSuspender.shouldAvoidRoomWork(r)) continue;
    if (!singleSourceRoom.isSingleSourceActive(r)) continue;
    var t = singleSourceRoom.getAnchors(r);
    if (!t) continue;
    var a = getRoomState.get(r);
    if (!a) continue;
    var n = e[r] || {};
    var i = [];
    if ((n.hd || 0) < 1 && t.hd && t.hdSpawn) {
      i.push({
        role: "hd",
        anchor: t.hd,
        spawnId: t.hdSpawn
      });
    }
    if ((n.staticDistributor || 0) < 1 && t.distributor && t.distributorSpawn) {
      i.push({
        role: "staticDistributor",
        anchor: t.distributor,
        spawnId: t.distributorSpawn
      });
    }
    if ((n.comboBot || 0) < 1 && t.comboBot && t.comboBotSpawn) {
      i.push({
        role: "comboBot",
        anchor: t.comboBot,
        spawnId: t.comboBotSpawn
      });
    }
    if (o.controller.level === 8 && o.controller.ticksToDowngrade < 15e4) {
      if ((n.maintainer || 0) < 1) {
        i.push({
          role: "maintainer",
          anchor: null,
          spawnId: null
        });
      }
    }
    var R = false;
    var s = getAllCreeps();
    for (var l = 0; l < s.length; l++) {
      var O = s[l];
      if (!O || !O.memory) continue;
      var m = O.memory.role;
      if ((m === "hd" || m === "staticDistributor" || m === "comboBot") && O.memory.homeRoom === r && O.ticksToLive < 100) {
        R = true;
        break;
      }
    }
    for (var u = 0; u < i.length; u++) {
      var c = i[u];
      if (R && c.role !== "maintainer") {
        var E = n[c.role] || 0;
        if (E > 0) continue;
      }
      var f = null;
      if (c.spawnId) {
        f = Game.getObjectById(c.spawnId);
        if (!f || f.spawning) continue;
      } else {
        var M = a.structuresByType && a.structuresByType[STRUCTURE_SPAWN] || [];
        for (var g = 0; g < M.length; g++) {
          if (M[g].my && !M[g].spawning) {
            f = M[g];
            break;
          }
        }
        if (!f) continue;
      }
      var A = getSingleSourceBody(c.role, o.energyAvailable);
      if (!A) continue;
      var p = bodyCost(A);
      if (p > o.energyAvailable) continue;
      var d = c.role + "_" + r + "_" + Game.time;
      var C = {
        role: c.role,
        homeRoom: r,
        assignedRoom: r
      };
      if (c.role === "hd") {
        var y = a.sources || [];
        if (y.length > 0) C.sourceId = y[0].id;
      }
      var V = {
        memory: C
      };
      if (c.anchor) {
        var v = singleSourceRoom.getAnchorSpawnDirection(f.pos, c.anchor);
        if (v) V.directions = v;
      }
      var W = spawnCreepWithDurableMemory(f, A, d, V);
      if (W === OK) {
        console.log("[SingleSource] Spawning " + c.role + " in " + r + " (" + A.length + " parts, cost=" + p + ")" + (c.anchor ? " anchor=(" + c.anchor.x + "," + c.anchor.y + ")" : ""));
        break;
      } else if (W !== ERR_BUSY && W !== ERR_NOT_ENOUGH_ENERGY) {
        console.log("[SingleSource] Failed to spawn " + c.role + " in " + r + ": " + W);
      }
    }
  }
}

function buildExtractorAssistantBody(e) {
  var r = Math.min(10, Math.floor(e / 250));
  if (r < 1) return null;
  var o = [];
  for (var t = 0; t < r * 4; t++) o.push(CARRY);
  for (var t = 0; t < r; t++) o.push(MOVE);
  return o;
}

function getExtractorEconomicsMemory() {
  var e = spawnManagerStorage.get("spawnManager.extractorEconomics");
  var r = false;
  var o = false;
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    e = {
      v: EXTRACTOR_ECONOMICS_VERSION,
      rooms: {}
    };
    r = true;
  }
  if (e.v !== EXTRACTOR_ECONOMICS_VERSION) {
    e.v = EXTRACTOR_ECONOMICS_VERSION;
    o = true;
    r = true;
  }
  if (!e.rooms || typeof e.rooms !== "object" || Array.isArray(e.rooms)) {
    e.rooms = {};
    r = true;
  }
  if (o) {
    for (var t in e.rooms) {
      var a = e.rooms[t];
      if (a && typeof a === "object" && !Array.isArray(a) && a.admitted !== true) {
        a.nextCheckTick = null;
      }
    }
  }
  if (r) spawnManagerStorage.set("spawnManager.extractorEconomics", e);
  return e;
}

function getExtractorEconomicsState(e) {
  var r = getExtractorEconomicsMemory();
  var o = r.rooms[e];
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    o = r.rooms[e] = {
      admitted: false,
      startedTick: null,
      nextCheckTick: null
    };
    memoryManager.requestSave();
  } else {
    var t = false;
    if (typeof o.admitted !== "boolean") {
      o.admitted = false;
      t = true;
    }
    if (o.startedTick !== null && typeof o.startedTick !== "number") {
      o.startedTick = null;
      t = true;
    }
    if (o.nextCheckTick !== null && typeof o.nextCheckTick !== "number") {
      o.nextCheckTick = null;
      t = true;
    }
    if (t) memoryManager.requestSave();
  }
  return o;
}

function peekExtractorEconomicsState(e) {
  var r = spawnManagerStorage.get("spawnManager.extractorEconomics");
  var o = r && r.rooms && r.rooms[e];
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    return {
      admitted: false,
      startedTick: null,
      nextCheckTick: null
    };
  }
  return {
    admitted: o.admitted === true,
    startedTick: typeof o.startedTick === "number" ? o.startedTick : null,
    nextCheckTick: typeof o.nextCheckTick === "number" ? o.nextCheckTick : null
  };
}

function nextExtractorScanTick(e) {
  var r = typeof e === "number" ? e : Game.time + 1;
  r = Math.max(Game.time + 1, r);
  var o = r % 20;
  return o === 0 ? r : r + (20 - o);
}

function formatDiagnosticTick(e) {
  if (e === null || e === undefined) return "-";
  return e + " (in " + Math.max(0, e - Game.time) + "t)";
}

function mineralMiningStatus(e) {
  var r = e ? [ e ] : getRoomState.ownedNames();
  var o = [ "[MineralMining] tick=" + Game.time + " | extractor scan cadence=20 ticks" ];
  for (var t = 0; t < r.length; t++) {
    var a = r[t];
    var n = Game.rooms[a];
    if (!n) {
      o.push(a + ": no vision");
      continue;
    }
    if (!n.controller || !n.controller.my) {
      o.push(a + ": not an owned room");
      continue;
    }
    var i = getRoomState.get(a);
    var R = peekExtractorEconomicsState(a);
    var s = i && i.structuresByType && i.structuresByType[STRUCTURE_EXTRACTOR] || [];
    var l = null;
    for (var O = 0; O < s.length; O++) {
      if (s[O].my) {
        l = s[O];
        break;
      }
    }
    var m = i && i.minerals && i.minerals.length > 0 ? i.minerals[0] : null;
    var u = findMineralContainer(i, l);
    var c = mineralAmountInStore(u && u.store);
    var E = hasMineralOperationWorker(a, i);
    var f = nextExtractorScanTick(Game.time);
    var M = buildExtractorBody(n.energyAvailable || 0);
    var g = buildExtractorAssistantBody(n.energyAvailable || 0);
    var A = null;
    if (m && m.mineralAmount > 0 && M && g) {
      A = calculateMineralEconomics(m, M, g);
    }
    var p = roomSuspender.shouldAvoidRoomWork(a);
    var d = "eligible for profitability check";
    if (p) {
      d = "room suspended";
    } else if (!l) {
      d = "no owned extractor";
    } else if (!m) {
      d = "no mineral";
    } else if (m.mineralAmount === 0) {
      d = "mineral depleted";
    } else if (!u) {
      d = "no container adjacent to extractor";
    } else if (E) {
      d = "mineral operation worker active";
    } else if (!M) {
      d = "not enough energy for extractor body";
    } else if (!g) {
      d = "not enough energy for assistant body";
    } else if (R.admitted) {
      d = "operation admitted; profitability gate bypassed";
    } else if (A && A.available && A.profitable) {
      d = "currently profitable";
    } else if (R.nextCheckTick !== null && Game.time < R.nextCheckTick) {
      d = "profitability cooldown";
    } else if (A && !A.available) {
      d = A.reason || "economics unavailable";
    } else if (A && !A.profitable) {
      d = "currently unprofitable";
    }
    var C = null;
    var y = !p && l && m && m.mineralAmount > 0 && u && !E && M && g;
    if (!R.admitted && y) {
      if (A && A.available && A.profitable) {
        C = f;
      } else {
        var V = R.nextCheckTick !== null && R.nextCheckTick > Game.time ? R.nextCheckTick : Game.time + 1;
        C = nextExtractorScanTick(V);
      }
    }
    o.push(a + ": mineral=" + (m ? m.mineralType : "-") + " amount=" + (m ? m.mineralAmount || 0 : 0) + " container=" + (u ? "yes/" + c : "no") + " admitted=" + R.admitted + " worker=" + E);
    o.push("  reason=" + d + " nextScan=" + formatDiagnosticTick(f) + " storedCheck=" + formatDiagnosticTick(R.nextCheckTick) + " nextProfitability=" + formatDiagnosticTick(C));
    if (A && A.available) {
      o.push("  economics: energy=" + formatEconomicsNumber(A.energyPrice) + "cr/e[" + (A.energyPriceSource || "NONE") + "]" + " mineral=" + formatEconomicsNumber(A.mineralPrice) + "cr/u value=" + formatEconomicsNumber(A.mineralValue) + "cr spawn=" + formatEconomicsNumber(A.spawnCost) + "cr net=" + formatEconomicsNumber(A.netProfit) + "cr breakEven=" + A.breakEvenYield + " cycles=" + A.extractorCycles);
    } else if (A) {
      o.push("  economics: unavailable reason=" + (A.reason || "unknown") + " energyQuote=" + formatEconomicsNumber(A.energyPrice) + "[" + (A.energyPriceSource || "NONE") + "]" + " mineralQuote=" + formatEconomicsNumber(A.mineralPrice));
    } else {
      o.push("  economics: unavailable until mineral, bodies, and quotes are available");
    }
  }
  var v = o.join("\n");
  return v;
}

global.mineralMiningStatus = mineralMiningStatus;
function mineralAmountInStore(e) {
  if (!e) return 0;
  var r = 0;
  for (var o in e) {
    if (o !== RESOURCE_ENERGY) r += e[o] || 0;
  }
  return r;
}

function findMineralContainer(e, r) {
  if (!e || !e.structuresByType || !r) return null;
  var o = e.structuresByType[STRUCTURE_CONTAINER] || [];
  for (var t = 0; t < o.length; t++) {
    if (o[t].pos.getRangeTo(r.pos) <= 1) return o[t];
  }
  return null;
}

function mineralCreepBelongsToRoom(e, r) {
  if (!e || !e.memory) return false;
  var o = e.memory;
  if (o.role !== "extractor" && o.role !== "extractorAssistant") return false;
  return o.roomName === r || o.homeRoom === r || o.assignedRoom === r || e.room && e.room.name === r;
}

function hasMineralOperationWorker(e, r) {
  var o = getAllCreeps();
  for (var t = 0; t < o.length; t++) {
    if (mineralCreepBelongsToRoom(o[t], e)) return true;
  }
  var a = r && r.structuresByType && r.structuresByType[STRUCTURE_SPAWN] || [];
  for (var n = 0; n < a.length; n++) {
    var i = a[n];
    if (!i.my || !i.spawning || !Memory.creeps) continue;
    var R = Memory.creeps[i.spawning.name];
    if (R && (R.role === "extractor" || R.role === "extractorAssistant") && (R.roomName === e || R.homeRoom === e || R.assignedRoom === e)) {
      return true;
    }
  }
  return false;
}

function syncMineralOperationState(e, r, o, t) {
  var a = getExtractorEconomicsState(e);
  var n = hasMineralOperationWorker(e, r);
  var i = mineralAmountInStore(t && t.store);
  var R = !o || (o.mineralAmount || 0) <= 0;
  var s = false;
  if (a.admitted && R && i === 0 && !n) {
    a.admitted = false;
    a.startedTick = null;
    a.nextCheckTick = null;
    s = true;
  }
  if (n || i > 0) {
    if (!a.admitted) {
      a.admitted = true;
      a.startedTick = Game.time;
      s = true;
    }
    if (a.nextCheckTick !== null) {
      a.nextCheckTick = null;
      s = true;
    }
  }
  if (s) memoryManager.requestSave();
  return {
    state: a,
    activeWorker: n,
    containerAmount: i
  };
}

function roundMarketPrice(e) {
  if (typeof e !== "number" || !isFinite(e) || e <= 0) return null;
  var r = Math.round(e * 1e3) / 1e3;
  return r >= .001 ? r : .001;
}

function getMarketBuyQuote(e, r) {
  var o = getMarketPricing();
  var t = o.getInputBuyQuote(e, r);
  return {
    price: roundMarketPrice(t.price),
    source: t.source || "NONE"
  };
}

function getMarketSellQuote(e) {
  var r = getMarketPricing();
  var o = r.getPriceProfile(e);
  var t = o ? o.postedSellPrice : null;
  if (!(t > 0) && o) {
    t = o.marketPrice || o.sellPrice || o.bestBid || o.postedBuyPrice || o.historyPrice;
  }
  if (!(t > 0) && r) {
    var a = r.getAvg48h(e) || r.getAvg7d(e);
    if (a > 0) t = a;
  }
  return roundMarketPrice(t);
}

function countWorkParts(e) {
  var r = 0;
  for (var o = 0; o < e.length; o++) {
    var t = e[o];
    if ((t && t.type !== undefined ? t.type : t) === WORK) r++;
  }
  return r;
}

function creepSpawnTicks(e) {
  var r = typeof CREEP_SPAWN_TIME === "number" && CREEP_SPAWN_TIME > 0 ? CREEP_SPAWN_TIME : 3;
  return e.length * r;
}

function calculateMineralEconomics(e, r, o) {
  var t = getMarketSellQuote(e.mineralType);
  var a = countWorkParts(r);
  var n = creepSpawnTicks(r);
  var i = creepSpawnTicks(o);
  var R = Math.floor(CREEP_LIFE_TIME / EXTRACTOR_COOLDOWN_TICKS);
  var s = a * HARVEST_MINERAL_POWER * R;
  var l = Math.max(0, e.mineralAmount || 0);
  var O = s > 0 ? Math.ceil(l / s) : 0;
  var m = a * HARVEST_MINERAL_POWER > 0 ? Math.ceil(l / (a * HARVEST_MINERAL_POWER)) : 0;
  var u = Math.min(l, s);
  var c = bodyCost(r);
  var E = bodyCost(o);
  var f = O * (c + E);
  var M = getMarketBuyQuote(RESOURCE_ENERGY, f);
  var g = M.price;
  if (g === null || t === null) {
    return {
      available: false,
      energyPrice: g,
      energyPriceSource: M.source,
      mineralPrice: t,
      reason: "missing market quote"
    };
  }
  var A = l * t;
  var p = f * g;
  var d = A - p;
  var C = t > 0 ? Math.ceil(p / t) : Infinity;
  var y = m * EXTRACTOR_COOLDOWN_TICKS;
  var V = O * (n + i);
  var v = Math.max(1, y + V);
  return {
    available: true,
    energyPrice: g,
    energyPriceSource: M.source,
    mineralPrice: t,
    workParts: a,
    extractorSpawnTicks: n,
    assistantSpawnTicks: i,
    harvestActions: m,
    harvestActionsPerLife: R,
    harvestCapacity: s,
    extractorCycles: O,
    remainingMineral: l,
    cycleYield: u,
    productiveTicks: y,
    totalSpawnTicks: V,
    extractorCost: c,
    assistantCost: E,
    totalSpawnEnergy: f,
    mineralValue: A,
    spawnCost: p,
    breakEvenYield: C,
    netProfit: d,
    operationTicks: v,
    netProfitPerTick: d / v,
    profitable: d > 0
  };
}

function deferMineralAdmission(e) {
  e.nextCheckTick = Game.time + EXTRACTOR_PROFITABILITY_RECHECK_TICKS;
  memoryManager.requestSave();
}

function formatEconomicsNumber(e) {
  return typeof e === "number" && isFinite(e) ? e.toFixed(3) : "?";
}

function canStartMineralOperation(e, r, o, t, a) {
  if (r.admitted) return true;
  var n = calculateMineralEconomics(o, t, a);
  if (n.available && n.profitable) {
    if (r.nextCheckTick !== null) {
      r.nextCheckTick = null;
      memoryManager.requestSave();
    }
    return true;
  }
  if (r.nextCheckTick !== null && Game.time < r.nextCheckTick) return false;
  if (r.nextCheckTick !== null) {
    r.nextCheckTick = null;
    memoryManager.requestSave();
  }
  if (!n.available) {
    deferMineralAdmission(r);
    console.log("[ExtractorEconomics] Cannot price mineral extraction in " + e + "; deferring for " + EXTRACTOR_PROFITABILITY_RECHECK_TICKS + " ticks.");
    return false;
  }
  if (!n.profitable) {
    var i = "[ExtractorEconomics] Not profitable to mine in " + e + ": " + o.mineralType + " work=" + n.workParts + " cycles=" + n.extractorCycles + " actions=" + n.harvestActions + " yield=" + n.remainingMineral + " breakEven=" + n.breakEvenYield + " value=" + formatEconomicsNumber(n.mineralValue) + "cr" + " < spawn=" + formatEconomicsNumber(n.spawnCost) + "cr" + " net=" + formatEconomicsNumber(n.netProfit) + "cr" + " (extractor=" + n.extractorCost + "e, assistant=" + n.assistantCost + "e, spawn=" + n.extractorSpawnTicks + "+" + n.assistantSpawnTicks + "t" + ", energy=" + formatEconomicsNumber(n.energyPrice) + "cr/e" + ", mineral=" + formatEconomicsNumber(n.mineralPrice) + "cr/u)" + "; next check=" + (Game.time + EXTRACTOR_PROFITABILITY_RECHECK_TICKS);
    console.log(i);
    deferMineralAdmission(r);
    return false;
  }
  return true;
}

function commitMineralOperationAdmission(e) {
  var r = getExtractorEconomicsState(e);
  var o = false;
  if (!r.admitted) {
    r.admitted = true;
    r.startedTick = Game.time;
    o = true;
  }
  if (r.nextCheckTick !== null) {
    r.nextCheckTick = null;
    o = true;
  }
  if (o) memoryManager.requestSave();
}

function manageExtractorAssistantSpawns() {
  for (var e in Game.rooms) {
    var r = Game.rooms[e];
    if (!r.controller || !r.controller.my) continue;
    if (roomSuspender.shouldAvoidRoomWork(e)) continue;
    var o = getRoomState.get(e);
    if (!o || !o.structuresByType) continue;
    var t = (o.structuresByType[STRUCTURE_EXTRACTOR] || []).filter(function(e) {
      return e.my;
    });
    if (t.length === 0) continue;
    var a = t[0];
    var n = a.pos;
    var i = o.minerals && o.minerals.length > 0 ? o.minerals[0] : null;
    var R = findMineralContainer(o, a);
    if (!R) continue;
    var s = syncMineralOperationState(e, o, i, R);
    var l = s.containerAmount;
    if (l === 0) continue;
    var O = false;
    var m = getAllCreeps();
    for (var u = 0; u < m.length; u++) {
      var c = m[u];
      if (!c || !c.memory) continue;
      if (c.memory.role === "extractorAssistant" && (c.memory.homeRoom === e || c.memory.assignedRoom === e)) {
        O = true;
        break;
      }
    }
    if (!O && o.structuresByType[STRUCTURE_SPAWN]) {
      for (var E = 0; E < o.structuresByType[STRUCTURE_SPAWN].length && !O; E++) {
        var f = o.structuresByType[STRUCTURE_SPAWN][E];
        if (f.my && f.spawning) {
          var M = Memory.creeps[f.spawning.name];
          if (M && M.role === "extractorAssistant" && M.homeRoom === e) {
            O = true;
          }
        }
      }
    }
    if (O) continue;
    var g = null;
    var A = Infinity;
    if (o.structuresByType[STRUCTURE_SPAWN]) {
      for (var p = 0; p < o.structuresByType[STRUCTURE_SPAWN].length; p++) {
        var d = o.structuresByType[STRUCTURE_SPAWN][p];
        if (!d.my || d.spawning) continue;
        var C = d.pos.getRangeTo(n);
        if (C < A) {
          A = C;
          g = d;
        }
      }
    }
    if (!g) continue;
    var y = buildExtractorAssistantBody(g.room.energyAvailable);
    if (!y) continue;
    var V = bodyCost(y);
    if (V > g.room.energyAvailable) continue;
    var v = "ExtAssist_" + e + "_" + Game.time % 1e4;
    var W = {
      role: "extractorAssistant",
      homeRoom: e,
      assignedRoom: e,
      state: "waiting"
    };
    var K = spawnCreepWithDurableMemory(g, y, v, {
      memory: W
    });
    if (K === OK) {
      commitMineralOperationAdmission(e);
      console.log("[ExtractorAssistant] Spawning " + v + " in " + e + " | Parts: " + y.length + " | Cost: " + V + " | Minerals in container: " + l + " | spawnRange: " + A);
    } else if (K !== ERR_BUSY && K !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[ExtractorAssistant] Failed to spawn in " + e + ": " + K);
    }
  }
}

function getSingleSourceBody(e, r) {
  switch (e) {
   case "hd":
    if (r >= 1950) return [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY ];
    if (r >= 1200) return [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY ];
    if (r >= 700) return [ WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY ];
    if (r >= 400) return [ WORK, WORK, WORK, CARRY, CARRY ];
    return null;
   case "staticDistributor":
    var o = Math.min(16, Math.floor(r / 50));
    if (o < 4) return null;
    var t = [];
    for (var a = 0; a < o; a++) t.push(CARRY);
    return t;
   case "comboBot":
    var n = require("singleSourceRoom");
    var i = null;
    for (var R in Game.rooms) {
      var s = Game.rooms[R];
      if (s.controller && s.controller.my && n.isSingleSourceActive(R)) {
        i = s;
        break;
      }
    }
    var l = false;
    if (i) {
      var O = getRoomState.get(i.name);
      var m = O && O.minerals || i.find(FIND_MINERALS);
      if (m.length > 0) {
        var u = m[0];
        if (u.mineralAmount > 0) {
          l = true;
        } else if (u.ticksToRegeneration !== undefined && u.ticksToRegeneration < 300) {
          l = true;
        }
      }
    }
    if (l) {
      if (r >= 1550) return [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY ];
      if (r >= 900) return [ WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY ];
      if (r >= 550) return [ WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY ];
      return null;
    } else {
      var c = Math.min(20, Math.floor(r / 50));
      if (c < 4) return null;
      var E = [];
      for (var f = 0; f < c; f++) E.push(CARRY);
      return E;
    }
   case "maintainer":
    return [ WORK, CARRY, CARRY, MOVE ];
   default:
    return null;
  }
}

function getCreepBody(e, r) {
  if (e === "labBot") {
    var o = Math.min(10, Math.floor(r / 100));
    if (o <= 0) return null;
    var t = [];
    for (var a = 0; a < o; a++) t.push(CARRY);
    for (var n = 0; n < o; n++) t.push(MOVE);
    return t;
  }
  if (e === "maintainer") {
    return MAINTAINER_BODY;
  }
  if (e === "attacker") {
    const e = 430;
    const o = Math.min(Math.floor(50 / 4), Math.floor(r / e));
    if (o > 0) {
      const e = [];
      for (let r = 0; r < o; r++) e.push(MOVE, MOVE, ATTACK, HEAL);
      return e;
    } else {
      if (r >= 130) return [ MOVE, ATTACK ]; else if (r >= 80) return [ ATTACK ]; else return null;
    }
  }
  if (e === "harasser") {
    const e = 260;
    const o = Math.min(12, Math.floor(r / e));
    if (o < 1) return null;
    const t = [];
    for (let e = 0; e < o; e++) t.push(RANGED_ATTACK, HEAL, MOVE, MOVE);
    return t;
  }
  if (e === "fastAttacker") {
    const e = 80 + 50;
    const o = Math.min(25, Math.floor(r / e));
    if (o < 1) return null;
    const t = [];
    for (let e = 0; e < o; e++) t.push(ATTACK);
    for (let e = 0; e < o; e++) t.push(MOVE);
    return t;
  }
  if (e === "healer") {
    if (r < 1300) return null;
    const e = [];
    for (let r = 0; r < 25; r++) e.push(HEAL);
    for (let r = 0; r < 25; r++) e.push(MOVE);
    return e;
  }
  if (e === "skAttacker") {
    const e = 430;
    const o = Math.min(Math.floor(50 / 4), Math.floor(r / e));
    if (o >= 2) {
      const e = [];
      for (let r = 0; r < o * 2; r++) e.push(MOVE);
      for (let r = 0; r < o; r++) e.push(ATTACK);
      for (let r = 0; r < o; r++) e.push(HEAL);
      return e;
    } else if (r >= 430) {
      return [ MOVE, MOVE, ATTACK, HEAL ];
    } else {
      return null;
    }
  }
  const i = {
    demolisher: {
      1500: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2500: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      4300: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    quad: {
      1300: [ MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL ],
      1800: [ MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL ],
      2300: [ MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL ],
      5e3: [ MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL ]
    },
    powerBot: {
      200: [ CARRY, CARRY, MOVE, MOVE ],
      300: [ CARRY, CARRY, CARRY, MOVE, MOVE, MOVE ],
      400: [ CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE ],
      600: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      900: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1e3: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1200: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1400: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1600: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1800: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2e3: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2200: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2400: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    upgrader: {
      250: [ WORK, CARRY, MOVE, MOVE ],
      400: [ WORK, WORK, CARRY, MOVE, MOVE, MOVE ],
      550: [ WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE ],
      700: [ WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE ],
      850: [ WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1e3: [ WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1150: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1300: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1400: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1550: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1700: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1850: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1950: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2100: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2250: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2350: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2500: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2650: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2800: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2950: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3100: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3250: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3400: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3550: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    builder: {
      300: [ WORK, CARRY, CARRY, MOVE, MOVE ],
      400: [ WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE ],
      550: [ WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE ],
      800: [ WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1300: [ WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1800: [ WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    remoteBuilder: {
      300: [ WORK, CARRY, CARRY, MOVE, MOVE ],
      400: [ WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE ],
      550: [ WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE ],
      800: [ WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1300: [ WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1800: [ WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    wallRepair: {
      250: [ WORK, CARRY, MOVE, MOVE ],
      500: [ WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE ],
      750: [ WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1e3: [ WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1250: [ WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1500: [ WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2e3: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2500: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3e3: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3150: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    defenseRepair: {
      400: [ WORK, WORK, CARRY, MOVE, MOVE, MOVE ],
      600: [ WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE ],
      900: [ WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1200: [ WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1600: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2e3: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2500: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3e3: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      3600: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    towerFiller: {
      150: [ CARRY, CARRY, MOVE ],
      300: [ CARRY, CARRY, CARRY, CARRY, MOVE, MOVE ],
      450: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE ],
      600: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE ],
      750: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    defender: {
      300: BASIC_DEFENDER,
      460: [ TOUGH, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE ],
      670: [ TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE ],
      880: [ TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE ]
    },
    supplier: {
      200: [ CARRY, CARRY, MOVE, MOVE ],
      300: [ CARRY, CARRY, CARRY, MOVE, MOVE, MOVE ],
      400: [ CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE ],
      500: [ CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE ],
      600: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      900: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1e3: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1200: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1400: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1600: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      1800: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2e3: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2200: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
      2400: [ CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, CARRY, MOVE, MOVE, CARRY, MOVE, CARRY, MOVE, MOVE, CARRY, MOVE, MOVE, MOVE, CARRY, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, CARRY, MOVE ]
    },
    scout: {
      300: SCOUT_BODY
    }
  };
  if (e === "scout") return SCOUT_BODY;
  if (r <= 300 && e !== "defender" && e !== "supplier" && e !== "powerBot" && e !== "remoteBuilder" && e !== "quad" && e !== "maintainer" && e !== "demolisher" && e !== "towerFiller") return BASIC_HARVESTER;
  const R = i[e] || i.harvester;
  return getBestBody(R, r);
  function getBestBody(e, r) {
    const o = Object.keys(e).map(Number).sort(function(e, r) {
      return e - r;
    });
    if (!o.length || r < o[0]) return null;
    let t = o[0];
    for (var a = 0; a < o.length; a++) {
      var n = o[a];
      if (r >= n) t = n; else break;
    }
    return e[t];
  }
}

if (!Memory.sourceMeta) Memory.sourceMeta = {};
// spawnManager_patch.js
//         "Spawn functions (grouped)" section of spawnManager.js,
//         e.g. directly after manageRemoteBuilderSpawns().
//   if (Game.time % 5 === 0) manageRemoteSupplierSpawns();
function manageRemoteSupplierSpawns() {
  if (!Memory.remoteSupplySpawnQueue || Memory.remoteSupplySpawnQueue.length === 0) return;
  Memory.remoteSupplySpawnQueue = Memory.remoteSupplySpawnQueue.filter(function(e) {
    return Game.time - e.requestedAt < 500;
  });
  for (var e = Memory.remoteSupplySpawnQueue.length - 1; e >= 0; e--) {
    var r = Memory.remoteSupplySpawnQueue[e];
    var o = false;
    var t = getAllCreeps();
    for (var a = 0; a < t.length; a++) {
      var n = t[a];
      if (!n || !n.memory) continue;
      if (n.memory.role === "remoteSupplier" && n.memory.homeRoom === r.sourceRoom && n.memory.targetRoom === r.recipientRoom && n.memory.mission === r.mission) {
        o = true;
        break;
      }
    }
    if (o) {
      Memory.remoteSupplySpawnQueue.splice(e, 1);
      continue;
    }
    var i = getRoomState.get(r.sourceRoom);
    if (!i) continue;
    var R = Game.rooms[r.sourceRoom];
    if (!R || !R.controller || !R.controller.my) continue;
    var s = null;
    var l = i.structuresByType && i.structuresByType[STRUCTURE_SPAWN] || [];
    for (var O = 0; O < l.length; O++) {
      if (l[O].my && !l[O].spawning) {
        s = l[O];
        break;
      }
    }
    if (!s) continue;
    var m = getCreepBody("supplier", s.room.energyAvailable);
    if (!m) continue;
    var u = bodyCost(m);
    if (u > s.room.energyAvailable) continue;
    var c = "RemSup_" + r.mission.charAt(0).toUpperCase() + "_" + r.recipientRoom + "_" + Game.time % 1e4;
    var E = {
      role: "remoteSupplier",
      homeRoom: r.sourceRoom,
      targetRoom: r.recipientRoom,
      mission: r.mission,
      amountNeeded: r.amountNeeded,
      working: false
    };
    var f = spawnCreepWithDurableMemory(s, m, c, {
      memory: E
    });
    if (f === OK) {
      console.log("[RemoteSupply] Spawning " + c + " [" + r.mission + "] " + r.sourceRoom + " -> " + r.recipientRoom + " (" + m.length + " parts, cost=" + u + ")" + (r.amountNeeded ? " need=" + r.amountNeeded : ""));
      Memory.remoteSupplySpawnQueue.splice(e, 1);
    } else if (f !== ERR_BUSY && f !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[RemoteSupply] Spawn failed in " + r.sourceRoom + ": " + f);
    }
  }
}

function ensureSourceMetaCache(e) {
  if (!e || !e.controller || !e.controller.my) return null;
  var r = e.name;
  var o = Memory.sourceMeta[r];
  var t = !o || !o.lastScan || Game.time - o.lastScan >= 1e4;
  if (!t && o && o.byId && Game.time - o.lastScan >= 100) {
    // A room scanned before its first spawn existed stores range: null. Re-scan
    // once spawns are present instead of holding the null for the full cycle.
    for (var nullRangeKey in o.byId) {
      if (o.byId[nullRangeKey].range === null) {
        t = true;
        break;
      }
    }
  }
  if (!t) return o;
  var a = getRoomState.get(r);
  if (!a) return o;
  var n = a.sources || [];
  var i = [];
  if (a.structuresByType && a.structuresByType[STRUCTURE_SPAWN]) {
    for (var R = 0; R < a.structuresByType[STRUCTURE_SPAWN].length; R++) {
      var s = a.structuresByType[STRUCTURE_SPAWN][R];
      if (s.my) i.push(s);
    }
  }
  var l = {};
  for (var O = 0; O < n.length; O++) {
    var m = n[O];
    if (!m || !m.pos) continue;
    var u = Infinity;
    for (var c = 0; c < i.length; c++) {
      var E = i[c].pos.getRangeTo(m.pos);
      if (E < u) {
        u = E;
      }
    }
    l[m.id] = {
      pos: {
        x: m.pos.x,
        y: m.pos.y,
        roomName: r
      },
      range: u < Infinity ? u : null
    };
  }
  Memory.sourceMeta[r] = {
    lastScan: Game.time,
    byId: l
  };
  return Memory.sourceMeta[r];
}

function pruneSourceMetaCache() {
  if (!Memory.sourceMeta) return;
  for (var e in Memory.sourceMeta) {
    var r = Game.rooms[e];
    if (!r || !r.controller || !r.controller.my) {
      delete Memory.sourceMeta[e];
    }
  }
}

function costOf(e) {
  switch (e) {
   case MOVE:
    return 50;
   case WORK:
    return 100;
   case CARRY:
    return 50;
   case ATTACK:
    return 80;
   case RANGED_ATTACK:
    return 150;
   case HEAL:
    return 250;
   case TOUGH:
    return 10;
   case CLAIM:
    return 600;
   default:
    return 0;
  }
}

function buildExtractorBody(e) {
  var r = 40;
  var o = 0;
  var t = 0;
  for (var a = 1; a <= r; a++) {
    var n = Math.max(1, Math.ceil(a / 4));
    if (a + n > 50) break;
    var i = a * costOf(WORK) + n * costOf(MOVE);
    if (i > e) continue;
    o = a;
    t = n;
  }
  if (o === 0) return null;
  var R = [];
  for (var s = 0; s < o; s++) R.push(WORK);
  for (var l = 0; l < t; l++) R.push(MOVE);
  return R;
}

function manageNukeFillSpawns() {
  if (!Memory.nukeFillOrders) return;
  for (var e in Memory.nukeFillOrders) {
    var r = Memory.nukeFillOrders[e];
    if (!r || r.completed) continue;
    var o = _.some(getAllCreeps(), function(r) {
      if (!r || !r.memory) return false;
      if (r.memory.role !== "nukeFill") return false;
      var o = r.memory.orderRoom || r.memory.homeRoom || (r.room ? r.room.name : null);
      return o === e;
    });
    if (o) continue;
    var t = Game.rooms[e];
    if (!t || !t.controller || !t.controller.my) continue;
    var a = getRoomState.get(e);
    if (!a) continue;
    var n = null;
    if (r.nukerId) n = Game.getObjectById(r.nukerId);
    if (!n && a.structuresByType && a.structuresByType[STRUCTURE_NUKER] && a.structuresByType[STRUCTURE_NUKER].length > 0) {
      n = a.structuresByType[STRUCTURE_NUKER][0];
      r.nukerId = n.id;
    }
    if (!n) continue;
    var i = null;
    if (a.structuresByType && a.structuresByType[STRUCTURE_SPAWN]) {
      for (var R = 0; R < a.structuresByType[STRUCTURE_SPAWN].length; R++) {
        var s = a.structuresByType[STRUCTURE_SPAWN][R];
        if (s.my && !s.spawning) {
          i = s;
          break;
        }
      }
    }
    if (!i) continue;
    var l = getCreepBody("supplier", i.room.energyAvailable);
    if (!l) continue;
    var O = "NukeFill_" + e + "_" + Game.time % 1e3;
    var m = {
      role: "nukeFill",
      homeRoom: e,
      orderRoom: e,
      nukerId: r.nukerId,
      phase: r.phase
    };
    var u = bodyCost(l);
    var c = spawnCreepWithDurableMemory(i, l, O, {
      memory: m
    });
    if (c === OK) {
      console.log("[NukeFill] Spawning " + O + " in " + e + " | Parts: " + l.length + " | Cost: " + u);
    } else if (c !== ERR_BUSY && c !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[NukeFill] Failed to spawn in " + e + ": " + c);
    }
  }
}

//   1. Healer first (most expensive, gates affordability check)
//   2. Attacker (immediately after healer is queued)
//   3. Carriers (only when subtask.phase === 'collecting')
//   Attacker: 25× ATTACK + 25× MOVE  (3250e)
//   Healer:   25× HEAL   + 25× MOVE  (7500e)
//   Carrier:  25× CARRY  + 25× MOVE  (2500e)
function manageSpawnsPerRoom(e) {
  manageHarvesterSpawns();
  for (var r in Game.rooms) {
    var o = Game.rooms[r];
    if (!o.controller || !o.controller.my) continue;
    if (roomSuspender.shouldAvoidRoomWork(r)) {
      if (Game.time % 100 === 0) {
        console.log("[Spawn] " + r + ": skipped, room suspended");
      }
      continue;
    }
    var t = getRoomState.get(r);
    if (!t) continue;
    var a = [];
    if (t && t.structuresByType && t.structuresByType[STRUCTURE_SPAWN]) {
      a = t.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
        return e.my && !e.spawning;
      });
    }
    if (a.length === 0) continue;
    var n = e[r] || {};
    var i = getRoomTargets(r, o);
    if ((n.harvester || 0) === 0) {
      var R = bodyCost(BASIC_HARVESTER);
      var s = o.energyAvailable >= R;
      var l = n.supplier || 0;
      var O = calculateRoomTotalEnergy(r);
      var m = !s && (l === 0 || l > 0 && O < 300);
      if (m) {
        console.log("EMERGENCY MODE in " + r + "!!! " + "(harvesters=0, suppliers=" + l + ", roomEnergy=" + O + ", available=" + o.energyAvailable + "/" + R + ")");
        spawnEmergencyHarvester(o, a[0]);
        continue;
      }
    }
    var u = isRcl6SupplierNearDeath(r, o);
    var c = handleRoomSpawnDelay(r, o);
    var E = [];
    if ((n.defender || 0) < i.defender) E.push("defender");
    if ((n.supplier || 0) < i.supplier || i.supplier > 0 && isSupplierPrespawnDue(r, o)) E.push("supplier");
    if ((n.maintainer || 0) < i.maintainer) E.push("maintainer");
    if ((n.upgrader || 0) < i.upgrader) E.push("upgrader");
    if ((n.builder || 0) < i.builder) E.push("builder");
    if ((n.scout || 0) < i.scout) E.push("scout");
    var f = 0;
    for (var M = 0; M < E.length; M++) {
      if (f >= a.length) break;
      var g = E[M];
      if (u || c && g !== "supplier") continue;
      if (g === "upgrader" && shouldDelayUpgraderAtRCL8(r, o)) {
        var A = global.__boostActive && getBoostMgr().isActive(r, "upgrader");
        var p = Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[r];
        if (!A && !p) continue;
      }
      var d = o.energyAvailable;
      var C = undefined;
      if (global.__boostActive && getBoostMgr().isActive(r, g)) {
        var y = getBoostMgr().getBody(r, g);
        if (y) {
          var V = getBoostMgr().getBodyCost(r, g);
          if (o.energyAvailable < V) {
            if (Game.time % 20 === 0) {
              console.log("[BoostManager] " + r + ": Need " + V + " energy for boosted " + g + ", have " + o.energyAvailable);
            }
            continue;
          }
        }
        if (getBoostMgr().shouldGateSpawn(r, g) && !getBoostMgr().areLabsReady(r, g)) {
          if (Game.time % 20 === 0) {
            console.log("[BoostManager] " + r + ": Waiting for boost labs before spawning " + g);
          }
          continue;
        }
        C = y;
      }
      if (!C && g === "upgrader" && Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[r]) {
        var v = o.controller && o.controller.level === 8 ? 3550 : d;
        C = getCreepBody(g, Math.min(d, v));
      }
      if (!C) {
        if (g === "upgrader" && o.controller && o.controller.my && o.controller.level === 8 && d > 3550) {
          d = 3550;
        }
        if (g === "upgrader" && o.controller && o.controller.my) {
          var W = getUpgraderBody(o);
          if (W) {
            C = W;
          } else {
            C = getCreepBody("upgrader", d);
          }
        } else {
          var K = g;
          if (g === "builder" && getRemainingConstructionWork(t, o) > LARGE_CONSTRUCTION_WORK_THRESHOLD) {
            K = "defenseRepair";
          }
          C = getCreepBody(K, d);
        }
      }
      if (!C) {
        if (Game.time % 10 === 0) {
          console.log("[Spawn] " + r + ": no affordable " + g + " body (energy " + d + ")");
        }
        continue;
      }
      var T = spawnCreepInRoom(g, C, a[f], r);
      if (T) {
        f++;
        if (n[g] === undefined) n[g] = 0;
        n[g]++;
        if (o.controller.level <= 6 && (n.harvester || 0) > 0) {
          Memory.spawnDelayUntil[r] = Game.time + LOW_RCL_SPAWN_DELAY_TICKS;
          console.log("[SpawnDelay] " + r + ": Spawn complete. Pausing non-supplier spawns for " + LOW_RCL_SPAWN_DELAY_TICKS + " ticks.");
        }
        if (g === "upgrader" && o.controller && o.controller.level === 8) {
          scheduleUpgraderDelayRCL8(r);
        }
      }
    }
  }
}

function buildHarvesterBodyForDistance(e, r) {
  if (r < 200) return null;
  var o = [];
  var t = 0;
  var a = 0;
  function canAdd(e) {
    return a + 1 <= 50 && t + costOf(e) <= r;
  }
  function add(e) {
    o.push(e);
    t += costOf(e);
    a++;
  }
  function removePart(e) {
    for (var r = o.length - 1; r >= 0; r--) {
      if (o[r] === e) {
        o.splice(r, 1);
        t -= costOf(e);
        a--;
        if (e === WORK) i--; else if (e === CARRY) R--; else if (e === MOVE) s--;
        return true;
      }
    }
    return false;
  }
  function gcd(e, r) {
    e = Math.abs(e);
    r = Math.abs(r);
    while (r !== 0) {
      var o = r;
      r = e % r;
      e = o;
    }
    return e;
  }
  function lcm(e, r) {
    if (e === 0 || r === 0) return 0;
    return Math.abs(e * r) / gcd(e, r);
  }
  function carryNeededFor(e) {
    var r = e * 2;
    if (r === 0) return 0;
    return lcm(50, r) / 50;
  }
  var n = 30;
  var i = 0;
  var R = 0;
  var s = 0;
  function rebalanceCarry() {
    if (i === 0) return;
    var e = 0;
    while (e < 100) {
      e++;
      var r = carryNeededFor(i);
      if (R >= r) break;
      if (canAdd(CARRY)) {
        add(CARRY);
        R++;
        continue;
      }
      var o = removePart(WORK);
      if (!o) break;
    }
  }
  function ensureBaseline() {
    if (R === 0) {
      if (canAdd(CARRY)) {
        add(CARRY);
        R++;
      } else if (removePart(WORK)) {
        if (canAdd(CARRY)) {
          add(CARRY);
          R++;
        }
      } else if (removePart(MOVE)) {
        if (canAdd(CARRY)) {
          add(CARRY);
          R++;
        }
      }
    }
    if (s === 0) {
      if (canAdd(MOVE)) {
        add(MOVE);
        s++;
      } else if (removePart(WORK)) {
        if (canAdd(MOVE)) {
          add(MOVE);
          s++;
        }
      } else {
        var e = 0;
        for (var r = 0; r < o.length; r++) {
          if (o[r] === CARRY) e++;
        }
        if (e > 1 && removePart(CARRY)) {
          if (canAdd(MOVE)) {
            add(MOVE);
            s++;
          }
        }
      }
    }
  }
  if (e < 4) {
    var l = [ {
      cost: 4450,
      body: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE ]
    }, {
      cost: 3900,
      body: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE ]
    }, {
      cost: 3350,
      body: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE ]
    }, {
      cost: 2800,
      body: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE ]
    }, {
      cost: 1700,
      body: [ WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE ]
    }, {
      cost: 600,
      body: [ WORK, WORK, WORK, WORK, WORK, CARRY, MOVE ]
    }, {
      cost: 200,
      body: [ WORK, CARRY, MOVE ]
    } ];
    for (var O = 0; O < l.length; O++) {
      if (r >= l[O].cost) return l[O].body;
    }
    return null;
  }
  if (e > 25) {
    while (a + 2 <= 50 && t + costOf(MOVE) + costOf(WORK) <= r && i < n) {
      add(MOVE);
      s++;
      add(WORK);
      i++;
    }
    var m = carryNeededFor(i);
    while (R < m && canAdd(CARRY)) {
      add(CARRY);
      R++;
    }
    rebalanceCarry();
    ensureBaseline();
    return o;
  }
  while (i < n && canAdd(WORK)) {
    add(WORK);
    i++;
    if (i % 3 === 0 && canAdd(MOVE)) {
      add(MOVE);
      s++;
    }
  }
  var u = carryNeededFor(i);
  while (R < u && canAdd(CARRY)) {
    add(CARRY);
    R++;
  }
  if (s === 0 && canAdd(MOVE)) {
    add(MOVE);
    s++;
  }
  rebalanceCarry();
  ensureBaseline();
  return o;
}

function getComplianceBody(e, r, o) {
  if (e === "extractorAssistant") return buildExtractorAssistantBody(r);
  if (e === "extractor") return buildExtractorBody(r);
  if (e === "repairer") {
    return getRepairMgr().sizeDispatch({
      availableEnergy: r,
      movementProfile: "mixed"
    }).body;
  }
  if (e === "harvester") {
    var t = o && o.homeRoom;
    var a = o && o.sourceId;
    var n = Memory.sourceMeta && Memory.sourceMeta[t];
    var i = n && n.byId && n.byId[a];
    var R = i && i.range;
    if (typeof R !== "number") return null;
    return buildHarvesterBodyForDistance(R, r);
  }
  if (e === "upgrader") {
    var t = o && o.homeRoom;
    if (t && Game.rooms[t]) {
      var s = getUpgraderBody(Game.rooms[t]);
      if (s) return s;
    }
    return getCreepBody("upgrader", r);
  }
  return getCreepBody(e, r);
}

function _upgraderLayoutVersion(e) {
  return Memory.rooms && Memory.rooms[e] && Memory.rooms[e].layoutVersion || 0;
}

function _rcl8UpgraderBody() {
  var e = [];
  for (var r = 0; r < 15; r++) e.push(WORK);
  for (var o = 0; o < 4; o++) e.push(CARRY);
  for (var t = 0; t < 19; t++) e.push(MOVE);
  return e;
}

function _upgraderMakeBody(e, r, o) {
  var t = new Array(e + r + o);
  for (var a = 0; a < e; a++) t[a] = WORK;
  for (var n = 0; n < r; n++) t[e + n] = CARRY;
  for (var i = 0; i < o; i++) t[e + r + i] = MOVE;
  return t;
}

function _findControllerLinkDistance(e) {
  if (!e.controller) return null;
  var r = e.find(FIND_MY_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_LINK;
    }
  });
  for (var o = 0; o < r.length; o++) {
    if (e.controller.pos.getRangeTo(r[o].pos) <= 2) {
      return 0;
    }
  }
  return null;
}

function _getStorageToControllerPath(e) {
  if (!e.storage || !e.controller) return null;
  var r = e.storage.store && e.storage.store.getUsedCapacity(RESOURCE_ENERGY);
  if (!r) return null;
  var o = e.name;
  if (!Memory.upgrader) Memory.upgrader = {};
  if (!Memory.upgrader[o]) Memory.upgrader[o] = {};
  var t = Memory.upgrader[o];
  var a = _upgraderLayoutVersion(o);
  var n = e.storage.id;
  if (t.storageToControllerPath && t.storageToControllerPath.layoutVersion === a && t.storageToControllerPath.storageId === n) {
    return t.storageToControllerPath.length || null;
  }
  var i = e.findPath(e.storage.pos, e.controller.pos, {
    plainCost: 1,
    swampCost: 5,
    maxOps: 2e3
  });
  var R = i && i.length ? i.length : null;
  t.storageToControllerPath = {
    layoutVersion: a,
    storageId: n,
    length: R
  };
  return R;
}

function _computeOptimalUpgraderBody(e, r) {
  if (e === null || e === undefined) return null;
  if (r < 200) return null;
  var o = null;
  var t = 0;
  for (var a = 1; a <= 30; a++) {
    if (a * 100 + 100 > r) break;
    if (a + 2 > 50) break;
    for (var n = 1; n <= 10; n++) {
      if (a + n + 1 > 50) break;
      if (a * 100 + n * 50 + 50 > r) break;
      var i = Math.min(50 - a - n, Math.floor((r - a * 100 - n * 50) / 50));
      if (i < 1) continue;
      var R = a + n;
      var s = Math.ceil(R / i);
      var l = 2 * e * s;
      var O = l + 1 + n * 50 / a;
      var m = n * 50 / O;
      if (m > t) {
        t = m;
        o = _upgraderMakeBody(a, n, i);
      }
    }
  }
  return o;
}

function getUpgraderBody(e) {
  if (!e || !e.controller) return null;
  if (e.controller.level === 8) {
    return _rcl8UpgraderBody();
  }
  var r = _findControllerLinkDistance(e);
  if (r === null) {
    r = _getStorageToControllerPath(e);
  }
  if (r === null) {
    return null;
  }
  var o = e.name;
  if (!Memory.upgrader) Memory.upgrader = {};
  if (!Memory.upgrader[o]) Memory.upgrader[o] = {};
  var t = Memory.upgrader[o];
  var a = _upgraderLayoutVersion(o);
  var n = e.energyAvailable;
  if (t.upgraderBodyCache && t.upgraderBodyCache.energy === n && t.upgraderBodyCache.distance === r && t.upgraderBodyCache.layoutVersion === a) {
    return t.upgraderBodyCache.body;
  }
  var i = _computeOptimalUpgraderBody(r, n);
  t.upgraderBodyCache = {
    energy: n,
    distance: r,
    layoutVersion: a,
    body: i
  };
  return i;
}

function spawnEmergencyHarvester(e, r) {
  if (!e || !r) return false;
  var o = ensureSourceMetaCache(e);
  if (!o || !o.byId) return false;
  var t = null;
  var a = Infinity;
  for (var n in o.byId) {
    var i = o.byId[n].range || 9999;
    if (i < a) {
      a = i;
      t = n;
    }
  }
  if (!t) return false;
  var R = o.byId[t];
  var s = R.range || 10;
  var l = [ WORK, CARRY, MOVE ];
  var O = t.slice(-6);
  var m = "H_EMG_" + e.name + "_" + O + "_" + Game.time;
  var u = {
    role: "harvester",
    assignedRoom: e.name,
    homeRoom: e.name,
    sourceId: t
  };
  var c = bodyCost(l);
  var E = new RoomPosition(R.pos.x, R.pos.y, R.pos.roomName);
  var f = getSpawnDirections(r.pos, E);
  var M = {
    memory: u
  };
  if (f) M.directions = f;
  var g = spawnCreepWithDurableMemory(r, l, m, M);
  if (g === OK) {
    console.log("EMERGENCY: Spawning harvester in " + e.name + " for source " + O + " (dist: " + s + ") | Parts: " + l.length + " | Cost: " + c);
    return true;
  } else if (g !== ERR_BUSY && g !== ERR_NOT_ENOUGH_ENERGY) {
    console.log("EMERGENCY: Failed to spawn harvester in " + e.name + " for " + t + ": " + g);
  }
  return false;
}

function roomHasLabBotOrSpawning(e) {
  var r = _.some(getAllCreeps(), function(r) {
    if (!r.memory) return false;
    if (r.memory.role !== "labBot") return false;
    var o = r.memory.homeRoom || r.memory.assignedRoom || r.room.name;
    return o === e;
  });
  if (r) return true;
  var o = getRoomState.get(e);
  if (!o) return false;
  var t = [];
  if (o.structuresByType && o.structuresByType[STRUCTURE_SPAWN]) {
    t = o.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
      return e.my;
    });
  }
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    if (!n.spawning) continue;
    var i = n.spawning.name;
    var R = Memory.creeps[i];
    if (!R) continue;
    if (R.role !== "labBot") continue;
    var s = R.homeRoom || R.assignedRoom || e;
    if (s === e) return true;
  }
  return false;
}

function shouldRetireAutoBuilderRemoteOrder(e) {
  if (!e || !e.targetRoom) return false;
  var r = Game.rooms[e.targetRoom];
  if (!r || !r.controller || r.controller.level < 4) return false;
  if (e.autoBuilder === true) return true;
  if (e.autoBuilder === false) return false;
  return !!(Memory.autoBuilder && Memory.autoBuilder.progress && Memory.autoBuilder.progress[e.targetRoom]);
}

function manageRemoteBuilderSpawns() {
  var e = Memory.remoteBuilderOrders;
  if (!e) return;
  var r = [];
  var o = {};
  if (Array.isArray(e)) {
    for (var t = 0; t < e.length; t++) {
      var a = e[t];
      if (!a) continue;
      var n = a.homeRoom;
      var i = a.targetRoom || a.workRoom;
      var R = parseInt(a.count, 10) || 1;
      var s = a.active === false ? false : true;
      if (!n || !i || !s) continue;
      if (shouldRetireAutoBuilderRemoteOrder({
        homeRoom: n,
        targetRoom: i,
        autoBuilder: a.autoBuilder
      })) {
        console.log("[RemoteBuilder] Retiring autoBuilder order at RCL 4+: " + n + " -> " + i);
        continue;
      }
      var l = Game.rooms[n];
      if (l && (!l.controller || !l.controller.my)) {
        console.log("[RemoteBuilder] Removing order with unowned home: " + n + " -> " + i);
        continue;
      }
      var O = {
        homeRoom: n,
        targetRoom: i,
        count: R
      };
      if (a.autoBuilder !== undefined) O.autoBuilder = a.autoBuilder;
      r.push(O);
      var m = {
        homeRoom: n,
        targetRoom: i,
        count: R,
        createdAt: a.createdAt || Game.time,
        updatedAt: a.updatedAt || Game.time
      };
      if (a.autoBuilder !== undefined) m.autoBuilder = a.autoBuilder;
      o[n + "->" + i] = m;
    }
  } else {
    for (var u in e) {
      var c = e[u];
      if (!c) continue;
      var E = c.homeRoom;
      var f = c.targetRoom || c.workRoom;
      if ((!E || !f) && typeof u === "string") {
        var M = u.split("->");
        if (!E && M.length > 0) E = M[0];
        if (!f && M.length > 1) f = M[1];
      }
      var g = parseInt(c.count, 10) || 1;
      var A = c.active === false ? false : true;
      if (!E || !f || !A) continue;
      if (shouldRetireAutoBuilderRemoteOrder({
        homeRoom: E,
        targetRoom: f,
        autoBuilder: c.autoBuilder
      })) {
        console.log("[RemoteBuilder] Retiring autoBuilder order at RCL 4+: " + E + " -> " + f);
        continue;
      }
      var p = Game.rooms[E];
      if (p && (!p.controller || !p.controller.my)) {
        console.log("[RemoteBuilder] Removing order with unowned home: " + E + " -> " + f);
        continue;
      }
      var d = {
        homeRoom: E,
        targetRoom: f,
        count: g
      };
      if (c.autoBuilder !== undefined) d.autoBuilder = c.autoBuilder;
      r.push(d);
      var C = {
        homeRoom: E,
        targetRoom: f,
        count: g,
        createdAt: c.createdAt || Game.time,
        updatedAt: c.updatedAt || Game.time
      };
      if (c.autoBuilder !== undefined) C.autoBuilder = c.autoBuilder;
      o[E + "->" + f] = C;
    }
  }
  Memory.remoteBuilderOrders = o;
  if (r.length === 0) return;
  for (var y = 0; y < r.length; y++) {
    var V = r[y];
    var v = V.homeRoom;
    var W = V.targetRoom;
    var K = V.count;
    var T = [];
    var Y = getAllCreeps();
    for (var h = 0; h < Y.length; h++) {
      var S = Y[h];
      if (!S || !S.memory) continue;
      if (S.memory.role !== "remoteBuilder") continue;
      if (S.memory.homeRoom === v && S.memory.targetRoom === W) {
        T.push(S);
      }
    }
    if (T.length >= K) continue;
    var w = getRoomState.get(v);
    if (!w) continue;
    var _ = null;
    if (w.structuresByType && w.structuresByType[STRUCTURE_SPAWN]) {
      for (var b = 0; b < w.structuresByType[STRUCTURE_SPAWN].length; b++) {
        var U = w.structuresByType[STRUCTURE_SPAWN][b];
        if (U.my && !U.spawning) {
          _ = U;
          break;
        }
      }
    }
    if (!_) continue;
    var k = getCreepBody("remoteBuilder", _.room.energyAvailable);
    if (!k) continue;
    var B = "RemoteBuilder_" + v + "_" + W + "_" + Game.time % 1e4;
    var N = {
      role: "remoteBuilder",
      homeRoom: v,
      targetRoom: W,
      assignedRoom: v
    };
    var G = bodyCost(k);
    var P = spawnCreepWithDurableMemory(_, k, B, {
      memory: N
    });
    if (P === OK) {
      console.log("[RemoteBuilder] Spawning " + B + " at " + v + " for work in " + W + " (" + k.length + " parts, cost=" + G + ")");
    } else if (P === ERR_NOT_ENOUGH_ENERGY) {
      if (Game.time % 25 === 0) {
        console.log("[RemoteBuilder] Not enough energy in " + v + " for " + B + ". Have: " + _.room.energyAvailable + ", Need: " + G);
      }
    } else if (P !== ERR_BUSY) {
      console.log("[RemoteBuilder] Failed to spawn in " + v + ": " + P);
    }
  }
}

function manageSquadSpawns(e) {
  if (!Memory.squadOrders) return;
  for (var r = Memory.squadOrders.length - 1; r >= 0; r--) {
    var o = Memory.squadOrders[r];
    if (o.spawnedCount >= 4) {
      console.log("[Squad] Order fulfilled for target " + o.targetRoom);
      Memory.squadOrders.splice(r, 1);
      continue;
    }
  }
  if (Memory.squadOrders.length === 0) return;
  var t = Memory.squadOrders[0];
  var a = t.homeRoom;
  var n = Game.rooms[a];
  if (!n || !n.controller || !n.controller.my) {
    if (Game.time % 20 === 0) console.log("[Squad] Invalid home room " + a);
    return;
  }
  if (Game.time % 5 === 0) managePowerBankSpawns();
  var i = e[a] || {};
  var R = getRoomTargets(a, n);
  var s = ensureSourceMetaCache(n);
  var l = s && s.byId ? Object.keys(s.byId).length : 2;
  if ((i.harvester || 0) < l || (i.supplier || 0) < R.supplier) {
    if (Game.time % 10 === 0) console.log("[Squad] Paused: Room " + a + " needs economy (Harv/Supp) first.");
    return;
  }
  var O = getRoomState.get(a);
  if (!O) return;
  var m = null;
  if (O.structuresByType && O.structuresByType[STRUCTURE_SPAWN]) {
    for (var u = 0; u < O.structuresByType[STRUCTURE_SPAWN].length; u++) {
      var c = O.structuresByType[STRUCTURE_SPAWN][u];
      if (c.my && !c.spawning) {
        m = c;
        break;
      }
    }
  }
  if (!m) return;
  var E = t.squadId || "Squad_" + t.targetRoom + "_" + Game.time;
  if (!t.squadId) t.squadId = E;
  var f = -1;
  var M = true;
  for (var r = 0; r < 4; r++) {
    var g = "Quad_" + r + "_" + E;
    var A = Game.creeps[g];
    var p = false;
    var d = getRoomState.get(n.name);
    var C = d && d.structuresByType && d.structuresByType[STRUCTURE_SPAWN] || n.find(FIND_MY_SPAWNS);
    for (var y = 0; y < C.length; y++) {
      if (C[y].my && C[y].spawning && C[y].spawning.name === g) {
        p = true;
        break;
      }
    }
    if (p) {
      if (Game.time % 10 === 0) console.log("[Squad] Member " + r + " is spawning. Waiting.");
      return;
    }
    if (!A) {
      f = r;
      M = false;
      break;
    }
  }
  if (M) return;
  var V = getCreepBody("quad", m.room.energyAvailable);
  if (!V) {
    if (Game.time % 10 === 0) console.log("[Squad] Waiting for energy in " + a + " to spawn squad member.");
    return;
  }
  var v = "Quad_" + f + "_" + E;
  var W = {
    role: "quad",
    homeRoom: t.homeRoom,
    targetRoom: t.targetRoom,
    squadId: E,
    quadPos: f
  };
  var K = bodyCost(V);
  var T = spawnCreepWithDurableMemory(m, V, v, {
    memory: W
  });
  if (T === OK) {
    console.log("[Squad] Spawning Member " + f + " | Cost: " + K);
    t.spawnedCount = (t.spawnedCount || 0) + 1;
  } else if (T !== ERR_BUSY && T !== ERR_NOT_ENOUGH_ENERGY) {
    console.log("[Squad] Failed to spawn Member " + f + " in " + a + ": " + T);
  }
}

function manageLabBotSpawns() {
  var e = require("labManager");
  if (e && typeof e.migrateLegacyOrders === "function") {
    e.migrateLegacyOrders();
  }
  for (var r in Game.rooms) {
    var o = Game.rooms[r];
    if (!o || !o.controller || !o.controller.my) continue;
    var t = e && typeof e.getRoomOrderState === "function" ? e.getRoomOrderState(r) : null;
    var a = t && (t.active || t.queue && t.queue.length > 0);
    var n = t && t.active;
    var i = n && (n.origin === "marketLab" || n.marketOpId);
    var R = global.__boostActive ? getBoostMgr().needsLabBot(r) : false;
    if (!a && !R) continue;
    if (i) continue;
    if (a && !R && !e.labsNeedWork(r)) {
      continue;
    }
    var s = getRoomState.get(r);
    if (!s) continue;
    var l = [];
    if (s.structuresByType && s.structuresByType[STRUCTURE_LAB]) {
      l = s.structuresByType[STRUCTURE_LAB].filter(function(e) {
        return e.my;
      });
    }
    if (!l || l.length < 3) continue;
    if (roomHasLabBotOrSpawning(r)) continue;
    var O = null;
    if (s.structuresByType && s.structuresByType[STRUCTURE_SPAWN]) {
      for (var m = 0; m < s.structuresByType[STRUCTURE_SPAWN].length; m++) {
        var u = s.structuresByType[STRUCTURE_SPAWN][m];
        if (u.my && !u.spawning) {
          O = u;
          break;
        }
      }
    }
    if (!O) continue;
    var c = getCreepBody("labBot", O.room.energyAvailable);
    if (!c) continue;
    var E = "LabBot_" + r + "_" + Game.time;
    var f = {
      role: "labBot",
      homeRoom: r,
      assignedRoom: r,
      phase: "buildA",
      idleTicks: 0
    };
    var M = bodyCost(c);
    var g = spawnCreepWithDurableMemory(O, c, E, {
      memory: f
    });
    if (g === OK) {
      console.log("Spawning LabBot in " + r + " with " + c.length + " parts | Cost: " + M + " | Energy before: " + O.room.energyAvailable);
    } else if (g !== ERR_BUSY && g !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("Failed to spawn LabBot in " + r + ": " + g);
    }
  }
}

function manageTowerDrainSpawns() {
  if (!Memory.towerDrainOps || !Memory.towerDrainOps.operations) return;
  var e = Memory.towerDrainOps.operations;
  for (var r in e) {
    var o = e[r];
    if (!o) continue;
    if (o.variant === "drainDemolisher") continue;
    if (o.status !== "ready" && o.status !== "active") continue;
    if (o.creeps.length >= o.maxDrainers) continue;
    var t = Game.rooms[o.homeRoom];
    if (!t || !t.controller || !t.controller.my) continue;
    var a = getRoomState.get(o.homeRoom);
    if (!a) continue;
    var n = null;
    if (a.structuresByType && a.structuresByType[STRUCTURE_SPAWN]) {
      for (var i = 0; i < a.structuresByType[STRUCTURE_SPAWN].length; i++) {
        var R = a.structuresByType[STRUCTURE_SPAWN][i];
        if (R.my && !R.spawning) {
          n = R;
          break;
        }
      }
    }
    if (!n) continue;
    var s = {};
    for (var l = 0; l < o.creeps.length; l++) {
      var O = Game.creeps[o.creeps[l]];
      if (O && typeof O.memory.laneNumber === "number") {
        s[O.memory.laneNumber] = true;
      }
    }
    var m = null;
    for (var u = 1; u <= o.maxDrainers; u++) {
      if (!s[u] && o.lanes[String(u)]) {
        m = u;
        break;
      }
    }
    if (m === null) {
      if (Game.time % 20 === 0) {
        console.log("[TowerDrain] No available lanes for " + r);
      }
      continue;
    }
    var c = Array.isArray(o.body) && o.body.length > 0 ? o.body : null;
    var E = [];
    if (c) {
      E = c;
    } else {
      var f = ATTACK;
      if (o.extraPart === "work") f = WORK; else if (o.extraPart === "rangedAttack") f = RANGED_ATTACK;
      var M = 80;
      if (o.extraPart === "work") M = 100; else if (o.extraPart === "rangedAttack") M = 150;
      if (o.longRange) {
        for (var g = 0; g < 9; g++) E.push(TOUGH);
        E.push(f);
        for (var A = 0; A < 25; A++) E.push(MOVE);
        for (var p = 0; p < 15; p++) E.push(HEAL);
      } else {
        var d = n.room.energyCapacityAvailable;
        var C = 50;
        var y = 10 + 50 + 250;
        var V = Math.floor((d - M - C) / y);
        if (V > 15) V = 15;
        if (V < 1) V = 1;
        for (var g = 0; g < V; g++) {
          E.push(TOUGH);
        }
        E.push(f);
        for (var A = 0; A < V + 1; A++) {
          E.push(MOVE);
        }
        for (var p = 0; p < V; p++) {
          E.push(HEAL);
        }
      }
    }
    var v = bodyCost(E);
    if (v > n.room.energyAvailable) {
      if (Game.time % 20 === 0) {
        console.log("[TowerDrain] Not enough energy in " + o.homeRoom + " for drainer. Have: " + n.room.energyAvailable + ", Need: " + v);
      }
      continue;
    }
    var W = o.lanes[String(m)];
    if (!W) {
      console.log("[TowerDrain] ERROR: Lane " + m + " missing from operation " + r);
      continue;
    }
    var K = o.variant === "bulldozer";
    var T = K ? "Bulldozer_" : "Attacker_";
    var Y = T + o.targetRoom + "_" + m + "_" + Game.time;
    var h = {
      role: "towerDrain",
      opKey: r,
      homeRoom: o.homeRoom,
      targetRoom: o.targetRoom,
      safeRoom: o.safeRoom,
      entryEdge: o.entryEdge,
      laneNumber: m,
      laneSet: m,
      variant: o.variant || null
    };
    var S = spawnCreepWithDurableMemory(n, E, Y, {
      memory: h
    });
    if (S === OK) {
      towerDrain.registerSpawnedCreep(o.homeRoom, o.targetRoom, Y);
      console.log("[TowerDrain] Spawning " + Y + " (lane " + m + ")" + (K ? " [BULLDOZER]" : "") + (c ? " [CUSTOM " + (o.bodySpec || E.length + " parts") + "]" : "") + (o.longRange ? " [LONG-RANGE]" : "") + (o.extraPart ? " [REPLACE ATTACK->" + o.extraPart + "]" : "") + " | Parts: " + E.length + " | Cost: " + v);
    } else if (S !== ERR_BUSY && S !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[TowerDrain] Failed to spawn in " + o.homeRoom + ": " + S);
    }
  }
}

function manageDemolitionSpawns() {
  if (!Memory.demolitionOrders || Memory.demolitionOrders.length === 0) return;
  for (var e = Memory.demolitionOrders.length - 1; e >= 0; e--) {
    var r = Memory.demolitionOrders[e];
    if (!r || !r.homeRoom || !r.targetRoom) {
      Memory.demolitionOrders.splice(e, 1);
      continue;
    }
    var o = Game.rooms[r.homeRoom];
    if (o && (!o.controller || !o.controller.my)) {
      console.log("[Demolition] Removing order with unowned home: " + r.homeRoom + " -> " + r.targetRoom);
      Memory.demolitionOrders.splice(e, 1);
    }
  }
  for (const e of Memory.demolitionOrders) {
    const r = e.homeRoom;
    const o = e.targetRoom;
    const E = e.teamCount;
    const f = _.filter(getAllCreeps(), function(e) {
      if (!e.memory) return false;
      if (e.memory.role !== "demolition") return false;
      if (e.memory.targetRoom !== o) return false;
      if (e.memory.homeRoom !== r) return false;
      if (e.memory.demolitionRole && e.memory.demolitionRole !== "demolisher") return false;
      return true;
    });
    if (f.length >= E) continue;
    const M = Game.rooms[r];
    if (!M || !M.controller || !M.controller.my) {
      if (M) console.log("[Demolition] Home room " + r + " is no longer valid. Skipping spawn.");
      continue;
    }
    var t = getRoomState.get(r);
    if (!t) continue;
    var a = [];
    if (t.structuresByType && t.structuresByType[STRUCTURE_SPAWN]) {
      a = t.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
        return e.my && !e.spawning;
      });
    }
    if (a.length === 0) continue;
    const g = E - f.length;
    if (g <= 0) continue;
    if (Game.time % 20 === 0) {
      console.log("[Demolition] Order " + r + "->" + o + ": Need " + g + " demolishers, have " + f.length);
    }
    var n = Array.isArray(e.body) && e.body.length > 0 ? e.body : null;
    var i = !n && global.__boostActive && getBoostMgr().isActive(r, "demolisher");
    var R = null;
    var s = null;
    if (i) {
      R = getBoostMgr().getBody(r, "demolisher");
      if (R) {
        var l = getBoostMgr().getBodyCost(r, "demolisher");
        if (M.energyAvailable < l) {
          if (Game.time % 20 === 0) {
            console.log("[Demolition] " + r + ": Need " + l + " energy for boosted demolisher, have " + M.energyAvailable);
          }
          continue;
        }
      }
      if (!getBoostMgr().areLabsReady(r, "demolisher")) {
        if (Game.time % 20 === 0) {
          console.log("[Demolition] " + r + ": Waiting for boost labs to fill");
        }
        continue;
      }
      s = getBoostMgr().getSpawnBoostMeta(r, "demolisher");
    }
    for (var O = 0; O < g; O++) {
      var m = a.shift();
      if (!m) break;
      var u = n ? n : i && R ? R : getCreepBody("demolisher", m.room.energyAvailable);
      if (!u) {
        if (Game.time % 20 === 0) {
          console.log("[Demolition] Not enough energy in " + r + " for demolisher. Have: " + m.room.energyAvailable);
        }
        a.unshift(m);
        break;
      }
      var c = bodyCost(u);
      if (c > m.room.energyAvailable) {
        if (Game.time % 20 === 0) {
          console.log("[Demolition] " + r + ": Need " + c + " energy for " + (e.bodySpec ? "custom '" + e.bodySpec + "' " : "") + "demolisher, have " + m.room.energyAvailable);
        }
        a.unshift(m);
        break;
      }
      const t = o + "_" + Game.time + "_" + Math.floor(Math.random() * 1e3);
      const l = "Demolisher_" + t;
      const O = {
        role: "demolition",
        demolitionRole: "demolisher",
        homeRoom: r,
        targetRoom: o,
        teamId: t
      };
      if (i && s) {
        O.needsBoost = true;
        O.boostLabs = s.boostLabs;
        O.boosted = s.boosted;
        O.boostRole = s.boostRole;
        O.allowUnboost = s.allowUnboost;
      }
      const E = spawnCreepWithDurableMemory(m, u, l, {
        memory: O
      });
      if (E === OK) {
        console.log("[Demolition] Spawning " + (n ? "[CUSTOM " + (e.bodySpec || u.length + " parts") + "] " : "") + (i ? "[BOOSTED] " : "") + "demolisher '" + l + "' from " + r + " for " + o + " | Parts: " + u.length + " | Cost: " + c);
      } else if (E !== ERR_BUSY) {
        console.log("[Demolition] Failed to spawn '" + l + "': " + E);
        break;
      }
    }
  }
}

function manageContestedDemolisherSpawns() {
  if (!Memory.contestedDemolisherOrders || Memory.contestedDemolisherOrders.length === 0) return;
  for (var e = Memory.contestedDemolisherOrders.length - 1; e >= 0; e--) {
    var r = Memory.contestedDemolisherOrders[e];
    if (!r) continue;
    var o = r.homeRoom;
    var t = r.targetRoom;
    var a = r.squadId || "cd-" + t + "-" + Game.time;
    var n = _.find(getAllCreeps(), function(e) {
      return e.memory.role === "contestedDemolisher" && e.memory.squadId === a && e.memory.roleType === "demolisher" && e.ticksToLive > 100;
    });
    var i = _.find(getAllCreeps(), function(e) {
      return e.memory.role === "contestedDemolisher" && e.memory.squadId === a && e.memory.roleType === "healer" && e.ticksToLive > 100;
    });
    if (n && i) {
      if (r.status !== "active") {
        r.status = "active";
        console.log("[ContestedDemolisher] Squad " + a + " complete and active.");
      }
      continue;
    }
    if (r.status !== "ready" && r.status !== "active") {
      if (Game.time % 50 === 0 && r.status === "scanning") {
        console.log("[ContestedDemolisher] Order " + o + " -> " + t + " still scanning route...");
      }
      continue;
    }
    var R = Game.rooms[o];
    if (!R || !R.controller || !R.controller.my) {
      console.log("[ContestedDemolisher] Invalid home room " + o + ". Removing order.");
      Memory.contestedDemolisherOrders.splice(e, 1);
      continue;
    }
    var s = getRoomState.get(o);
    if (!s) continue;
    var l = [];
    if (s.structuresByType && s.structuresByType[STRUCTURE_SPAWN]) {
      l = s.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
        return e.my;
      });
    }
    if (l.length === 0) continue;
    var O = false;
    for (var m = 0; m < l.length; m++) {
      if (l[m].spawning) {
        var u = Memory.creeps[l[m].spawning.name];
        if (u && u.squadId === a) {
          O = true;
          break;
        }
      }
    }
    if (O) continue;
    var c = l.filter(function(e) {
      return !e.spawning;
    });
    if (c.length === 0) continue;
    var E = c[0];
    var f = false;
    if (!n) {
      var M = [];
      for (var g = 0; g < 25; g++) M.push(MOVE);
      for (var A = 0; A < 25; A++) M.push(WORK);
      var p = bodyCost(M);
      if (p <= E.room.energyAvailable) {
        var d = "CD_Demo_" + a + "_" + Game.time;
        var u = {
          role: "contestedDemolisher",
          roleType: "demolisher",
          squadId: a,
          targetRoom: t,
          homeRoom: o,
          towersOnly: r.towersOnly || false,
          targetMode: r.targetMode,
          route: r.route,
          routeBack: r.routeBack
        };
        var C = spawnCreepWithDurableMemory(E, M, d, {
          memory: u
        });
        if (C === OK) {
          console.log("[ContestedDemolisher] Spawning Demolisher (" + d + ") for " + t + " | Route: " + (r.route ? r.route.join(" -> ") : "N/A"));
          f = true;
          r.status = "active";
        }
      } else if (Game.time % 20 === 0) {
        console.log("[ContestedDemolisher] Not enough energy for Demolisher in " + o + ". Have: " + E.room.energyAvailable + ", Need: " + p);
      }
    } else if (!i) {
      var y = [];
      for (var V = 0; V < 25; V++) y.push(MOVE);
      for (var v = 0; v < 25; v++) y.push(HEAL);
      var W = bodyCost(y);
      if (W <= E.room.energyAvailable) {
        var K = "CD_Heal_" + a + "_" + Game.time;
        var T = {
          role: "contestedDemolisher",
          roleType: "healer",
          squadId: a,
          targetRoom: t,
          homeRoom: o,
          route: r.route,
          routeBack: r.routeBack
        };
        var Y = spawnCreepWithDurableMemory(E, y, K, {
          memory: T
        });
        if (Y === OK) {
          console.log("[ContestedDemolisher] Spawning Healer (" + K + ") for " + t);
          f = true;
        }
      } else if (Game.time % 20 === 0) {
        console.log("[ContestedDemolisher] Not enough energy for Healer in " + o + ". Have: " + E.room.energyAvailable + ", Need: " + W);
      }
    }
    if (n && i) {
      if (r.status !== "active") {
        r.status = "active";
        console.log("[ContestedDemolisher] Squad " + a + " complete and active.");
      }
    }
  }
}

function drainDemolisherParkTiles(e, r) {
  var o = [];
  var t = getAllCreeps();
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    if (!n.memory || n.memory.role !== "drainDemolisher") continue;
    if (n.memory.homeRoom !== e.homeRoom || n.memory.targetRoom !== e.targetRoom) continue;
    if (r && n.memory.squadId === r) continue;
    if (n.memory.healerParkPos) o.push(n.memory.healerParkPos);
  }
  return o;
}

function manageDrainDemolisherSpawns() {
  if (!Memory.towerDrainOps || !Memory.towerDrainOps.operations) return;
  var e = Memory.towerDrainOps.operations;
  for (var r in e) {
    var o = e[r];
    if (!o || o.variant !== "drainDemolisher") continue;
    if (o.status !== "ready" && o.status !== "active") continue;
    var t = Game.rooms[o.homeRoom];
    if (!t || !t.controller || !t.controller.my) continue;
    var a = getRoomState.get(o.homeRoom);
    if (!a) continue;
    var n = [];
    if (a.structuresByType && a.structuresByType[STRUCTURE_SPAWN]) {
      n = a.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
        return e.my;
      });
    }
    if (n.length === 0) continue;
    for (var i = 1; i <= o.maxDrainers; i++) {
      var R = o.lanes[String(i)];
      if (!R) continue;
      var s = "dd-" + o.homeRoom + "-" + o.targetRoom + "-L" + i;
      var l = _.find(getAllCreeps(), function(e) {
        return e.memory && e.memory.role === "towerDrain" && e.memory.squadId === s && (e.ticksToLive === undefined || e.ticksToLive > 150);
      });
      var O = _.find(getAllCreeps(), function(e) {
        return e.memory && e.memory.role === "drainDemolisher" && e.memory.squadId === s && (e.ticksToLive === undefined || e.ticksToLive > 150);
      });
      if (l && O) continue;
      var m = false;
      for (var u = 0; u < n.length; u++) {
        if (n[u].spawning) {
          var c = Memory.creeps[n[u].spawning.name];
          if (c && c.squadId === s) {
            m = true;
            break;
          }
        }
      }
      if (m) continue;
      var E = n.filter(function(e) {
        return !e.spawning;
      });
      if (E.length === 0) break;
      var f = E[0];
      if (!O) {
        var M = [];
        for (var g = 0; g < 25; g++) M.push(MOVE);
        for (var A = 0; A < 25; A++) M.push(HEAL);
        var p = bodyCost(M);
        if (p > f.room.energyAvailable) {
          if (Game.time % 20 === 0) {
            console.log("[DrainDemolisher] Not enough energy for healer in " + o.homeRoom + ". Have: " + f.room.energyAvailable + ", Need: " + p);
          }
          continue;
        }
        var d = roleDrainDemolisher.deriveHealerParkPos(o.entryEdge, R.healRestPos, o.safeRoom, drainDemolisherParkTiles(o, s));
        if (!d) {
          if (Game.time % 20 === 0) {
            console.log("[DrainDemolisher] No usable healer park tile for lane " + i + " of " + r);
          }
          continue;
        }
        var C = "DD_Heal_" + o.targetRoom + "_" + i + "_" + Game.time;
        var y = {
          role: "drainDemolisher",
          roleType: "healer",
          squadId: s,
          homeRoom: o.homeRoom,
          targetRoom: o.targetRoom,
          safeRoom: o.safeRoom,
          route: o.route,
          routeBack: o.routeBack,
          entryEdge: o.entryEdge,
          laneNumber: i,
          healRestPos: R.healRestPos,
          healerParkPos: d,
          state: "traveling"
        };
        var V = spawnCreepWithDurableMemory(f, M, C, {
          memory: y
        });
        if (V === OK) {
          towerDrain.registerSpawnedCreep(o.homeRoom, o.targetRoom, C);
          console.log("[DrainDemolisher] Spawning healer " + C + " (lane " + i + ", park " + d.x + "," + d.y + ") | Cost: " + p);
        } else if (V !== ERR_BUSY && V !== ERR_NOT_ENOUGH_ENERGY) {
          console.log("[DrainDemolisher] Failed to spawn healer in " + o.homeRoom + ": " + V);
        }
      } else if (!l) {
        var v = Array.isArray(o.body) && o.body.length > 0 ? o.body : null;
        if (!v) {
          console.log("[DrainDemolisher] ERROR: operation " + r + " missing worker body");
          continue;
        }
        var W = bodyCost(v);
        if (W > f.room.energyAvailable) {
          if (Game.time % 20 === 0) {
            console.log("[DrainDemolisher] Not enough energy for worker in " + o.homeRoom + ". Have: " + f.room.energyAvailable + ", Need: " + W);
          }
          continue;
        }
        var K = "DD_Work_" + o.targetRoom + "_" + i + "_" + Game.time;
        var T = {
          role: "towerDrain",
          opKey: r,
          homeRoom: o.homeRoom,
          targetRoom: o.targetRoom,
          safeRoom: o.safeRoom,
          entryEdge: o.entryEdge,
          laneNumber: i,
          laneSet: i,
          variant: "drainDemolisher",
          squadId: s
        };
        var Y = spawnCreepWithDurableMemory(f, v, K, {
          memory: T
        });
        if (Y === OK) {
          towerDrain.registerSpawnedCreep(o.homeRoom, o.targetRoom, K);
          console.log("[DrainDemolisher] Spawning worker " + K + " (lane " + i + ")" + (T.targetPos ? " target (" + T.targetPos.x + "," + T.targetPos.y + ")" : "") + " | Cost: " + W);
        } else if (Y !== ERR_BUSY && Y !== ERR_NOT_ENOUGH_ENERGY) {
          console.log("[DrainDemolisher] Failed to spawn worker in " + o.homeRoom + ": " + Y);
        }
      }
    }
  }
}

// Keep in sync with MIN_ENERGY_DROP in roleThief.js
//  after adding MIN_ENERGY_DROP to roleThief's module.exports)
var MIN_ENERGY_DROP = 200;
function manageThiefSpawns() {
  if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) return;
  const e = Memory.thiefOrders.filter(function(e) {
    var r = Game.rooms[e.targetRoom];
    if (r && r.controller) {
      var o = r.controller;
      var t = null;
      var a = Object.keys(Game.spawns);
      if (a.length > 0 && Game.spawns[a[0]].owner) {
        t = Game.spawns[a[0]].owner.username;
      }
      if (o.my) {
        console.log("[Thief] Target room " + e.targetRoom + " is now owned by us. Cancelling operation.");
        return false;
      }
      if (o.reservation && t && o.reservation.username === t) {
        console.log("[Thief] Target room " + e.targetRoom + " is now reserved by us. Cancelling operation.");
        return false;
      }
      try {
        var n = require("iff");
        var i = o.owner ? o.owner.username : o.reservation ? o.reservation.username : null;
        if (i && n && typeof n.isFriendlyUsername === "function" && n.isFriendlyUsername(i)) {
          console.log("[Thief] Target room " + e.targetRoom + " is owned/reserved by ally " + i + ". Cancelling operation.");
          return false;
        }
      } catch (e) {}
    }
    var R = getRoomState.get(e.targetRoom);
    if (!R) return true;
    var s = false;
    var l = [ STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_CONTAINER, STRUCTURE_LAB, STRUCTURE_TERMINAL ];
    for (var O = 0; O < l.length && !s; O++) {
      var m = l[O];
      var u = R.structuresByType && R.structuresByType[m] ? R.structuresByType[m] : [];
      for (var c = 0; c < u.length; c++) {
        var E = u[c];
        if (E.store && E.store.getUsedCapacity() > 0) {
          s = true;
          break;
        }
      }
    }
    if (!s && Game.rooms[e.targetRoom]) {
      var f = Game.rooms[e.targetRoom];
      var M = getRoomState.get(e.targetRoom);
      if (M && M.dropped) {
        var g = M.dropped;
        for (var A = 0; A < g.length; A++) {
          var p = g[A];
          if (p.resourceType !== RESOURCE_ENERGY || p.amount >= MIN_ENERGY_DROP) {
            s = true;
            break;
          }
        }
      } else {
        var d = f.find(FIND_DROPPED_RESOURCES, {
          filter: function(e) {
            return e.resourceType !== RESOURCE_ENERGY || e.amount >= MIN_ENERGY_DROP;
          }
        });
        if (d.length > 0) s = true;
      }
      if (!s) {
        if (M && M.ruins) {
          var C = M.ruins;
          for (var y = 0; y < C.length; y++) {
            var V = C[y];
            if (V.store && V.store.getUsedCapacity() > 0) {
              s = true;
              break;
            }
          }
        } else {
          var v = f.find(FIND_RUINS, {
            filter: function(e) {
              return e.store && e.store.getUsedCapacity() > 0;
            }
          });
          if (v.length > 0) s = true;
        }
      }
    }
    if (!s) {
      console.log("[Thief] Target room " + e.targetRoom + " appears to be empty. Cancelling operation.");
      return false;
    }
    return true;
  });
  Memory.thiefOrders = e;
  for (const e of Memory.thiefOrders) {
    const n = e.homeRoom;
    const i = e.targetRoom;
    const R = e.count;
    const s = _.filter(getAllCreeps(), function(e) {
      return e.memory.role === "thief" && e.memory.targetRoom === i && e.memory.homeRoom === n;
    });
    if (s.length >= R) continue;
    const l = Game.rooms[n];
    if (!l || !l.controller || !l.controller.my) {
      console.log("[Thief] Home room " + n + " for raid on " + i + " is no longer valid. Skipping spawn.");
      continue;
    }
    var r = getRoomState.get(n);
    if (!r) continue;
    var o = null;
    if (r && r.structuresByType && r.structuresByType[STRUCTURE_SPAWN]) {
      for (var t = 0; t < r.structuresByType[STRUCTURE_SPAWN].length; t++) {
        var a = r.structuresByType[STRUCTURE_SPAWN][t];
        if (a.my && !a.spawning) {
          o = a;
          break;
        }
      }
    }
    if (!o) continue;
    const O = getCreepBody("supplier", o.room.energyAvailable);
    const m = O ? bodyCost(O) : 0;
    if (!O || m > o.room.energyAvailable) {
      if (Game.time % 10 === 0) {
        console.log("[Thief] Not enough energy in " + n + " to spawn a thief. Have: " + o.room.energyAvailable + ", Need: " + m);
      }
      continue;
    }
    const u = "Thief_" + i + "_" + Game.time % 1e3;
    const c = {
      role: "thief",
      homeRoom: n,
      targetRoom: i,
      stealing: true
    };
    const E = spawnCreepWithDurableMemory(o, O, u, {
      memory: c
    });
    if (E === OK) {
      console.log("[Thief] Spawning '" + u + "' from " + n + " for raid on " + i + ".");
    } else if (E !== ERR_BUSY && E !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[Thief] Error spawning thief in " + n + ": " + E);
    }
  }
}

function manageScavengerSpawns() {
  if (!scavengerPolicy.canEvaluate()) return;
  scavengerLearning.maintenance();
  const e = scavengerPolicy.getEligibleRooms();
  for (var r = 0; r < e.length; r++) {
    var o = e[r];
    var t = o.name;
    if (scavengerPolicy.isActiveScavenger(t)) continue;
    var a = scavengerPolicy.getSpawnDecision(o);
    if (!a.candidates.length) continue;
    if (!scavengerLearning.shouldEvaluateState(t, a.lootFingerprint, a.contextFingerprint)) continue;
    scavengerLearning.markObservedState(t, a.lootFingerprint, a.contextFingerprint, a.controllable);
    if (!a.controllable) {
      scavengerLearning.recordNonControllable(t);
      continue;
    }
    var n = null;
    try {
      n = scavengerLearning.startOpportunity(t, {
        fingerprint: a.lootFingerprint,
        potentialProfit: a.potentialProfit,
        bestPotentialNet: a.bestPotentialNet
      });
      var i = scavengerLearning.getModelForVariant(n.variant);
      var R = scavengerPolicy.chooseBody(a, i);
      if (R.invalid) {
        scavengerLearning.recordInvalidOutput(n.episodeId);
        scavengerLearning.resolveSkip(n.episodeId, false, false);
        continue;
      }
      if (R.bodySize === 0) {
        scavengerLearning.resolveSkip(n.episodeId, true);
        continue;
      }
      var s = scavengerPolicy.buildBody(R.bodySize);
      var l = bodyCost(s);
      var O = a.freeSpawns[0];
      if (!O || o.energyAvailable < l) {
        scavengerLearning.recordExecutionFailure(n.episodeId);
        continue;
      }
      var m = n.variant === "challenger" ? "chl" : "inc";
      var u = "NeuralScavenger_" + t + "_" + m + "_" + Game.time;
      var c = {
        role: "scavenger",
        homeRoom: t,
        assignedRoom: t,
        scavengerPolicy: {
          modelId: n.modelId,
          modelVersion: n.modelVersion,
          policyVersion: scavengerLearning.DATASET_VERSION,
          architectureVersion: scavengerLearning.ARCHITECTURE_VERSION,
          featureSchemaVersion: scavengerLearning.FEATURE_SCHEMA_VERSION,
          comparisonPairId: n.pairId,
          cohortId: n.cohortId,
          episodeId: n.episodeId,
          variant: n.variant,
          bodySize: R.bodySize,
          learningEligible: true
        }
      };
      var E = spawnCreepWithDurableMemory(O, s, u, {
        memory: c
      });
      if (E === OK) {
        scavengerLearning.attachSpawn(n.episodeId, R.bodySize, l);
        if (Game.time % 25 === 0) {
          console.log("[Scavenger] Neural spawn " + u + " in " + t + " | variant=" + n.variant + " | model=" + n.modelVersion + " | body=" + R.bodySize + " | cost=" + l);
        }
      } else {
        scavengerLearning.recordExecutionFailure(n.episodeId);
        if (E !== ERR_BUSY && E !== ERR_NOT_ENOUGH_ENERGY && Game.time % 25 === 0) {
          console.log("[Scavenger] Neural spawn failed in " + t + ": " + E);
        }
      }
    } catch (e) {
      if (n && n.episodeId) {
        scavengerLearning.recordExecutionFailure(n.episodeId);
      }
      if (Game.time % 25 === 0) {
        console.log("[Scavenger] Neural planning failed in " + t + ": " + e);
      }
    }
  }
}

function calculateRoomTotalEnergy(e) {
  const r = getRoomState.get(e);
  if (!r || !r.structuresByType) return 0;
  let o = 0;
  function sumType(e) {
    const o = r.structuresByType[e];
    if (!o) return 0;
    let t = 0;
    for (let e = 0; e < o.length; e++) {
      if (o[e].store) {
        t += o[e].store.getUsedCapacity(RESOURCE_ENERGY);
      }
    }
    return t;
  }
  o += sumType(STRUCTURE_SPAWN);
  o += sumType(STRUCTURE_EXTENSION);
  o += sumType(STRUCTURE_CONTAINER);
  if (r.storage && r.storage.store) {
    o += r.storage.store.getUsedCapacity(RESOURCE_ENERGY);
  }
  return o;
}

function manageSKAttackerSpawns() {
  if (!Memory.skAttackOrders || Memory.skAttackOrders.length === 0) return;
  for (var e = Memory.skAttackOrders.length - 1; e >= 0; e--) {
    var r = Memory.skAttackOrders[e];
    var o = r && r.spawnRoom ? Game.rooms[r.spawnRoom] : null;
    if (!r || !r.spawnRoom || !r.targetRoom || r.active === false || o && (!o.controller || !o.controller.my)) {
      if (r && o && (!o.controller || !o.controller.my)) {
        console.log("[SKAttack] Removing order with unowned spawn room: " + r.spawnRoom + " -> " + r.targetRoom);
      }
      Memory.skAttackOrders.splice(e, 1);
    }
  }
  for (var t = 0; t < Memory.skAttackOrders.length; t++) {
    var r = Memory.skAttackOrders[t];
    if (!r || !r.active) continue;
    var a = r.spawnRoom;
    var n = r.targetRoom;
    var i = r.count || 1;
    var R = _.filter(getAllCreeps(), function(e) {
      return e.memory && e.memory.role === "skAttacker" && e.memory.targetRoom === n && !e.memory.noReplace;
    });
    var s = 0;
    var l = getRoomState.get(a);
    if (l && l.structuresByType && l.structuresByType[STRUCTURE_SPAWN]) {
      for (var O = 0; O < l.structuresByType[STRUCTURE_SPAWN].length; O++) {
        var m = l.structuresByType[STRUCTURE_SPAWN][O];
        if (m.my && m.spawning) {
          var u = Memory.creeps[m.spawning.name];
          if (u && u.role === "skAttacker" && u.targetRoom === n) {
            s++;
          }
        }
      }
    }
    var c = R.length + s;
    if (c >= i) continue;
    var E = Game.rooms[a];
    if (!E || !E.controller || !E.controller.my) {
      if (Game.time % 50 === 0) {
        console.log("[SKAttack] Invalid spawn room: " + a);
      }
      continue;
    }
    if (!l) continue;
    var f = null;
    if (l.structuresByType && l.structuresByType[STRUCTURE_SPAWN]) {
      for (var M = 0; M < l.structuresByType[STRUCTURE_SPAWN].length; M++) {
        var g = l.structuresByType[STRUCTURE_SPAWN][M];
        if (g.my && !g.spawning) {
          f = g;
          break;
        }
      }
    }
    if (!f) continue;
    var A = getCreepBody("skAttacker", f.room.energyAvailable);
    if (!A) {
      if (Game.time % 20 === 0) {
        console.log("[SKAttack] Not enough energy in " + a + " for skAttacker. Need at least 860.");
      }
      continue;
    }
    var p = bodyCost(A);
    if (p > f.room.energyAvailable) continue;
    var d = "SKAttacker_" + n + "_" + Game.time % 1e4;
    var C = {
      role: "skAttacker",
      homeRoom: a,
      targetRoom: n,
      state: "moving"
    };
    var y = spawnCreepWithDurableMemory(f, A, d, {
      memory: C
    });
    if (y === OK) {
      console.log("[SKAttack] Spawning " + d + " from " + a + " -> " + n + " (" + A.length + " parts, cost=" + p + ") [" + (c + 1) + "/" + i + "]");
    } else if (y !== ERR_BUSY && y !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[SKAttack] Failed to spawn in " + a + ": " + y);
    }
  }
}

const ATTACKER_SPAWN_TIMEOUT = 1e3;
const ATTACKER_RALLY_TIMEOUT = 750;
function manageAttackerSpawns() {
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return;
  for (let e = Memory.attackOrders.length - 1; e >= 0; e--) {
    const r = Memory.attackOrders[e];
    if (!r) continue;
    if (!r.orderId) {
      r.orderId = "attack_" + (r.startTime || Game.time) + "_" + r.spawnRoom + "_" + r.targetRoom;
      _.filter(getAllCreeps(), function(e) {
        return e.memory.role === "attacker" && !e.memory.attackOrderId && e.memory.targetRoom === r.targetRoom && e.memory.spawnRoom === r.spawnRoom;
      }).forEach(function(e) {
        e.memory.attackOrderId = r.orderId;
      });
    }
    const o = r.targetRoom;
    const t = r.spawnRoom;
    const a = r.rallyRoom;
    const n = r.count;
    const i = r.rallyPhase;
    const R = Game.time - r.startTime >= ATTACKER_SPAWN_TIMEOUT;
    const s = _.filter(getAllCreeps(), function(e) {
      return e.memory.role === "attacker" && e.memory.attackOrderId === r.orderId;
    });
    if (i === "spawning") {
      const e = n - s.length;
      let a = 0;
      if (e > 0) {
        a = trySpawnAttackers(r, e);
        if (a > 0) {
          r.spawned += a;
          console.log("[Attack] Spawned " + a + " attackers (" + r.spawned + "/" + n + " total) for " + o + " from " + t);
        }
      }
      const i = s.length + (e > 0 ? a : 0);
      if (i >= n || R && i > 0) {
        r.rallyPhase = "rallying";
        r.rallyStartTime = Game.time;
        console.log("[Attack] Moving to rally phase for " + o + " (" + i + "/" + n + (R && i < n ? " after spawn timeout" : " wave formed") + ")");
      }
    } else if (i === "rallying") {
      const e = _.filter(getAllCreeps(), function(e) {
        return e.memory.role === "attacker" && e.memory.attackOrderId === r.orderId;
      });
      const t = n - e.length;
      const i = Game.time - r.rallyStartTime >= ATTACKER_RALLY_TIMEOUT;
      if (t > 0 && !i) {
        const e = trySpawnAttackers(r, t);
        if (e > 0) {
          r.spawned += e;
          console.log("[Attack] Replacing " + e + " lost rally attacker(s) for " + o);
        }
        continue;
      }
      if (i && e.length === 0) {
        r.rallyPhase = "spawning";
        r.startTime = Game.time;
        delete r.rallyStartTime;
        console.log("[Attack] Rally for " + o + " timed out with no attackers alive; restarting wave formation.");
        continue;
      }
      const R = _.filter(e, function(e) {
        return !e.spawning;
      });
      const s = _.filter(R, function(e) {
        return e.room.name === a;
      });
      const l = R.length === n && s.length === n;
      const O = i && R.length > 0;
      const m = l || O;
      if (m) {
        const e = _.filter(getAllCreeps(), function(e) {
          return e.memory.role === "attacker" && e.memory.attackOrderId === r.orderId;
        });
        e.forEach(function(e) {
          e.memory.rallyComplete = true;
        });
        r.rallyPhase = "attacking";
        console.log("[Attack] Rally complete for " + o + ". " + e.length + " attackers proceeding to attack" + (O && !l ? " after rally timeout" : "") + ".");
      }
    } else if (i === "attacking") {
      const t = _.filter(getAllCreeps(), function(e) {
        return e.memory.role === "attacker" && e.memory.attackOrderId === r.orderId;
      });
      if (r.sustain === true) {
        const e = r.count - t.length;
        if (e > 0) {
          const a = trySpawnAttackers(r, e, true);
          if (a > 0) {
            r.spawned += a;
            console.log("[Attack] Respawned " + a + " attacker(s) for sustained attack on " + o + " (" + (t.length + a) + "/" + r.count + " alive)");
          }
        }
      } else if (t.length === 0) {
        console.log("[Attack] All attackers for " + o + " have been eliminated. Order complete.");
        Memory.attackOrders.splice(e, 1);
      }
    }
  }
}

function trySpawnAttackers(e, r, o) {
  if (r <= 0) return 0;
  const t = e.spawnRoom;
  const a = Game.rooms[t];
  if (!a || !a.controller || !a.controller.my) {
    if (Game.time % 20 === 0) console.log("[Attack] Spawn room " + t + " is invalid");
    return 0;
  }
  var n = getRoomState.get(t);
  if (!n) return 0;
  var i = [];
  if (n && n.structuresByType && n.structuresByType[STRUCTURE_SPAWN]) {
    i = n.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
      return e.my && !e.spawning;
    });
  }
  if (i.length === 0) return 0;
  const R = e.fast === true ? "fastAttacker" : "attacker";
  let s = 0;
  for (let n = 0; n < i.length && s < r; n++) {
    const r = i[n];
    const l = getCreepBody(R, a.energyAvailable);
    if (!l) break;
    const O = bodyCost(l);
    if (O > a.energyAvailable) break;
    const m = "Attacker_" + e.orderId + "_" + Game.time + "_" + (e.spawned + s);
    const u = spawnCreepWithDurableMemory(r, l, m, {
      memory: {
        role: "attacker",
        targetRoom: e.targetRoom,
        rallyRoom: e.spawnRoom,
        spawnRoom: e.spawnRoom,
        entryPoint: e.entryPoint || {
          x: 25,
          y: 25
        },
        entryRange: e.entryRange === undefined ? 23 : e.entryRange,
        attackOrderId: e.orderId,
        rallyComplete: o === true,
        fast: e.fast === true
      }
    });
    if (u === OK) {
      s++;
      console.log("[Attack] Spawning " + R + " '" + m + "' in " + t + " (energy=" + a.energyAvailable + ", body=" + l.length + " parts, cost=" + O + ")");
    } else if (u !== ERR_BUSY) {
      console.log("[Attack] Failed to spawn '" + m + "' in " + t + ": " + u);
    }
  }
  return s;
}

const HARASSER_PRESPAWN_TTL = 150;
function manageHarasserSpawns() {
  if (!Memory.harassOrders || Memory.harassOrders.length === 0) return;
  for (let e = Memory.harassOrders.length - 1; e >= 0; e--) {
    const r = Memory.harassOrders[e];
    const o = Game.rooms[r.spawnRoom];
    if (!o || !o.controller || !o.controller.my) {
      if (Game.time % 20 === 0) console.log("[Harass] Invalid spawn room: " + r.spawnRoom);
      continue;
    }
    const t = _.filter(getAllCreeps(), e => e.memory.role === "harasser" && e.memory.harassOrderId === r.orderId);
    const a = r.sustain ? _.filter(t, e => e.ticksToLive === undefined || e.ticksToLive > HARASSER_PRESPAWN_TTL) : t;
    const n = r.sustain ? r.count - a.length : r.count - r.spawned;
    if (n > 0) {
      const e = trySpawnHarassers(r, n);
      if (e > 0) {
        r.spawned += e;
        const o = r.sustain && t.length >= r.count ? "Pre-spawned" : "Spawned";
        console.log("[Harass] " + o + " " + e + " harasser(s) for " + r.targetRoom + ".");
      }
      continue;
    }
    if (!r.sustain && r.spawned >= r.count && t.length === 0) {
      console.log("[Harass] All harassers for " + r.targetRoom + " have been eliminated. Order complete.");
      Memory.harassOrders.splice(e, 1);
    }
  }
}

function trySpawnHarassers(e, r) {
  const o = Game.rooms[e.spawnRoom];
  const t = getRoomState.get(e.spawnRoom);
  const a = t && t.structuresByType && t.structuresByType[STRUCTURE_SPAWN] ? t.structuresByType[STRUCTURE_SPAWN].filter(e => e.my && !e.spawning) : [];
  let n = 0;
  for (let t = 0; t < a.length && n < r; t++) {
    const r = getCreepBody("harasser", o.energyAvailable);
    if (!r || bodyCost(r) > o.energyAvailable) break;
    const i = "Harasser_" + e.orderId + "_" + Game.time + "_" + (e.spawned + n);
    const R = spawnCreepWithDurableMemory(a[t], r, i, {
      memory: {
        role: "harasser",
        targetRoom: e.targetRoom,
        spawnRoom: e.spawnRoom,
        entryPoint: e.entryPoint,
        entryRange: e.entryRange,
        harassOrderId: e.orderId
      }
    });
    if (R === OK) n++; else if (R !== ERR_BUSY) console.log("[Harass] Failed to spawn " + i + ": " + R);
  }
  return n;
}

const HEALER_SPAWN_TIMEOUT = 1e3;
function manageHealerSpawns() {
  if (!Memory.healOrders || Memory.healOrders.length === 0) return;
  let e = false;
  for (const r in Game.spawns) {
    const o = Game.spawns[r];
    if (!o.spawning) continue;
    const t = Memory.creeps[o.spawning.name];
    if (t && t.role === "healer") {
      e = true;
      break;
    }
  }
  for (let r = Memory.healOrders.length - 1; r >= 0; r--) {
    const o = Memory.healOrders[r];
    if (!o) continue;
    if (!Number.isSafeInteger(o.count) || o.count < 1) {
      console.log("[Heal] Removing invalid heal order for " + o.targetRoom + ".");
      Memory.healOrders.splice(r, 1);
      continue;
    }
    if (!o.orderId) {
      o.orderId = "heal_" + (o.startTime || Game.time) + "_" + o.spawnRoom + "_" + o.targetRoom;
      _.filter(getAllCreeps(), function(e) {
        return e.memory.role === "healer" && !e.memory.healOrderId && e.memory.targetRoom === o.targetRoom && e.memory.spawnRoom === o.spawnRoom;
      }).forEach(function(e) {
        e.memory.healOrderId = o.orderId;
      });
    }
    if (!o.rallyPhase) o.rallyPhase = "spawning";
    if (o.rallyPhase === "rallying") o.rallyPhase = "healing";
    if (!o.startTime) o.startTime = Game.time;
    if (o.spawned === undefined) o.spawned = 0;
    const t = _.filter(getAllCreeps(), function(e) {
      return e.memory.role === "healer" && e.memory.healOrderId === o.orderId;
    });
    const a = o.count;
    const n = Game.time - o.startTime >= HEALER_SPAWN_TIMEOUT;
    if (o.rallyPhase === "spawning") {
      const r = a - t.length;
      const i = r > 0 && !e ? trySpawnHealers(o, r) : 0;
      if (i > 0) {
        e = true;
        o.spawned += i;
        console.log("[Heal] Spawned " + i + " healers (" + o.spawned + "/" + a + ") for " + o.targetRoom);
      }
      const R = t.length + i;
      if (R >= a || n && R > 0) {
        o.rallyPhase = "healing";
        console.log("[Heal] Sending healers to " + o.targetRoom + " (" + R + "/" + a + ")");
      }
      continue;
    }
    if (o.rallyPhase === "healing") {
      if (o.sustain === true) {
        const r = t.slice().sort(function(e, r) {
          return r.ticksToLive - e.ticksToLive;
        });
        r.forEach(function(e, r) {
          if (r < a) delete e.memory.retiring; else e.memory.retiring = true;
        });
        const n = a - t.length;
        if (n > 0 && !e) {
          const r = trySpawnHealers(o, n);
          if (r > 0) {
            e = true;
            o.spawned += r;
            console.log("[Heal] Respawned " + r + " healer(s) for sustained heal on " + o.targetRoom + " (" + (t.length + r) + "/" + a + " alive)");
          }
        }
      } else if (t.length === 0) {
        console.log("[Heal] All healers for " + o.targetRoom + " have been eliminated. Order complete.");
        Memory.healOrders.splice(r, 1);
      }
    }
  }
}

function trySpawnHealers(e, r) {
  if (r <= 0) return 0;
  const o = Game.rooms[e.spawnRoom];
  if (!o || !o.controller || !o.controller.my) {
    if (Game.time % 20 === 0) console.log("[Heal] Spawn room " + e.spawnRoom + " is invalid");
    return 0;
  }
  const t = getRoomState.get(e.spawnRoom);
  const a = t && t.structuresByType && t.structuresByType[STRUCTURE_SPAWN] ? t.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
    return e.my && !e.spawning;
  }) : [];
  let n = 0;
  for (let r = 0; r < a.length && n < 1; r++) {
    const t = a[r];
    const i = getCreepBody("healer", o.energyAvailable);
    if (!i || bodyCost(i) > o.energyAvailable) break;
    const R = "Healer_" + e.orderId + "_" + Game.time + "_" + (e.spawned + n);
    const s = spawnCreepWithDurableMemory(t, i, R, {
      memory: {
        role: "healer",
        targetRoom: e.targetRoom,
        spawnRoom: e.spawnRoom,
        entryPoint: e.entryPoint || {
          x: 25,
          y: 25
        },
        entryRange: e.entryRange === undefined ? 23 : e.entryRange,
        healOrderId: e.orderId
      }
    });
    if (s === OK) {
      n++;
      console.log("[Heal] Spawning healer " + R + " in " + e.spawnRoom + " (body=" + i.length + " parts, cost=" + bodyCost(i) + ")");
    } else if (s !== ERR_BUSY) {
      console.log("[Heal] Failed to spawn " + R + " in " + e.spawnRoom + ": " + s);
    }
  }
  return n;
}

function manageExtractorSpawns() {
  if (Game.time % 20 !== 0) return;
  for (const C in Game.rooms) {
    const y = Game.rooms[C];
    if (!y.controller || !y.controller.my) continue;
    if (roomSuspender.shouldAvoidRoomWork(C)) continue;
    var e = getRoomState.get(C);
    if (!e) continue;
    var r = null;
    if (e.structuresByType && e.structuresByType[STRUCTURE_EXTRACTOR]) {
      var o = e.structuresByType[STRUCTURE_EXTRACTOR].filter(function(e) {
        return e.my;
      });
      r = o[0];
    }
    if (!r) continue;
    var t = e.minerals && e.minerals.length > 0 ? e.minerals[0] : null;
    var a = findMineralContainer(e, r);
    var n = syncMineralOperationState(C, e, t, a);
    if (!t || t.mineralAmount === 0) continue;
    if (!a) continue;
    var i = false;
    var R = getAllCreeps();
    for (var s = 0; s < R.length; s++) {
      var l = R[s];
      if (!l.memory) continue;
      if (l.memory.role === "extractor" && l.memory.extractorId === r.id) {
        var O = l.ticksToLive;
        if (O === undefined || O > 80 || l.spawning) {
          i = true;
          break;
        }
      }
    }
    if (i) continue;
    var m = null;
    var u = Infinity;
    var c = e.structuresByType && e.structuresByType[STRUCTURE_SPAWN] ? e.structuresByType[STRUCTURE_SPAWN] : [];
    for (var E = 0; E < c.length; E++) {
      if (!c[E].my || c[E].spawning) continue;
      var f = c[E].pos.getRangeTo(t.pos);
      if (f < u) {
        u = f;
        m = c[E];
      }
    }
    if (!m) continue;
    var M = buildExtractorBody(m.room.energyAvailable);
    if (!M) continue;
    var g = buildExtractorAssistantBody(m.room.energyAvailable);
    if (!g) continue;
    if (!canStartMineralOperation(C, n.state, t, M, g)) continue;
    var A = "extractor_" + C + "_" + Game.time % 1e3;
    var p = {
      role: "extractor",
      roomName: C,
      extractorId: r.id
    };
    var d = spawnCreepWithDurableMemory(m, M, A, {
      memory: p
    });
    if (d === OK) {
      commitMineralOperationAdmission(C);
      console.log("[Spawn] extractor for " + C + " | parts=" + M.length + " | spawnRange=" + u);
    } else if (d !== ERR_BUSY && d !== ERR_NOT_ENOUGH_ENERGY) {
      // Admission is never committed on failure, so without a back-off the room
      // re-evaluates and re-fails the same operation on every scan.
      console.log("[Spawn] Failed to spawn extractor for " + C + ": " + d);
      deferMineralAdmission(n.state);
    }
  }
}

function shouldSpawnSupplier(e) {
  var r = Game.rooms[e];
  if (!r || !r.controller || !r.controller.my) return 0;
  var o = Memory.powerUpgrade;
  if (o && o.targetLevel > Game.gpl.level && Array.isArray(o.rooms) && o.rooms.indexOf(e) >= 0) {
    return 1;
  }
  var t = require("labManager");
  var a = t && typeof t.getRoomOrderState === "function" ? t.getRoomOrderState(e) : null;
  var n = a && a.active;
  if (n && (n.origin === "marketLab" || n.marketOpId)) return 1;
  var i = require("factoryManager");
  var R = i && typeof i.getOrders === "function" ? i.getOrders() : [];
  if (R.length > 0) {
    for (var s = 0; s < R.length; s++) {
      var l = R[s];
      if (l && l.room === e && l.status === "active") return 1;
    }
  }
  if (Memory.terminalManager && Memory.terminalManager.supplierTasks) {
    var O = Memory.terminalManager.supplierTasks[e];
    if (Array.isArray(O) && O.length > 0) {
      var m = Memory.terminalManager.operations || [];
      for (var u = 0; u < O.length; u++) {
        var c = O[u];
        if (!c || !c.opId) continue;
        for (var E = 0; E < m.length; E++) {
          var f = m[E];
          if (!f || f.id !== c.opId) continue;
          if (f.status === "completed" || f.status === "failed") break;
          var M = f.amountMoved || 0;
          if (M < f.amount) return 1;
          break;
        }
      }
    }
  }
  var g = Memory.terminalManager && Memory.terminalManager.operations;
  if (Array.isArray(g)) {
    for (var A = 0; A < g.length; A++) {
      var p = g[A];
      if (!p || p.type !== "toTerminal" || p.roomName !== e || !p.useSupplier || p.status === "completed" || p.status === "failed") continue;
      if ((p.amount || 0) - (p.amountMoved || 0) > 0) return 1;
    }
  }
  if (r.controller.level !== 8) return 1;
  var d = getAllCreeps();
  for (var C = 0; C < d.length; C++) {
    var y = d[C];
    if (!y || !y.memory) continue;
    if (y.room && y.room.name === e && y.memory.role !== "supplier") {
      return 1;
    }
  }
  var V = getRoomState.get(e);
  if (!V) return 0;
  var v = V.structuresByType && V.structuresByType[STRUCTURE_TOWER] ? V.structuresByType[STRUCTURE_TOWER] : [];
  if (v.length > 0) {
    var W = true;
    for (var K = 0; K < v.length; K++) {
      var T = v[K];
      if (!T || !T.store) {
        W = false;
        break;
      }
      var Y = T.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
      if (Y >= 500) {
        W = false;
        break;
      }
    }
    if (W) return 1;
  }
  var h = V.structuresByType && V.structuresByType[STRUCTURE_TERMINAL] ? V.structuresByType[STRUCTURE_TERMINAL] : [];
  for (var S = 0; S < h.length; S++) {
    var w = h[S];
    if (!w || !w.store) continue;
    var _ = w.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (_ < 5e3) return 1;
  }
  var b = 0;
  var U = 0;
  var k = V.structuresByType && V.structuresByType[STRUCTURE_EXTENSION] ? V.structuresByType[STRUCTURE_EXTENSION] : [];
  for (var B = 0; B < k.length; B++) {
    var N = k[B];
    if (!N || !N.store) continue;
    b += N.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    U += N.store.getCapacity(RESOURCE_ENERGY) || 0;
  }
  var G = V.structuresByType && V.structuresByType[STRUCTURE_SPAWN] ? V.structuresByType[STRUCTURE_SPAWN] : [];
  for (var P = 0; P < G.length; P++) {
    var D = G[P];
    if (!D || !D.store) continue;
    b += D.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    U += D.store.getCapacity(RESOURCE_ENERGY) || 0;
  }
  if (U > 0) {
    var I = b / U;
    if (I < .5) return 1;
  }
  return 0;
}

function handleRoomSpawnDelay(e, r) {
  if (!Memory.spawnDelayUntil) Memory.spawnDelayUntil = {};
  const o = Memory.spawnDelayUntil[e];
  if (o && Game.time < o) return true;
  if (o && Game.time >= o) delete Memory.spawnDelayUntil[e];
  return false;
}

function isRcl6SupplierNearDeath(e, r) {
  if (!e || !r || !r.controller || !r.controller.my) return false;
  if (r.controller.level !== 6) return false;
  var o = getAllCreeps();
  for (var t = 0; t < o.length; t++) {
    var a = o[t];
    if (!a || !a.memory || a.memory.role !== "supplier") continue;
    var n = a.memory.homeRoom || a.memory.assignedRoom || a.room && a.room.name;
    if (n !== e) continue;
    if (typeof a.ticksToLive === "number" && a.ticksToLive <= RCL6_SUPPLIER_SPAWN_BLOCK_TTL) {
      return true;
    }
  }
  return false;
}

function isSupplierPrespawnDue(e, r) {
  if (!e || !r || !r.controller || !r.controller.my) return false;
  if (r.controller.level < 7) return false;
  var o = getCreepBody("supplier", r.energyCapacityAvailable);
  if (!o) return false;
  var t = SUPPLIER_HANDOFF_TTL + o.length * CREEP_SPAWN_TIME + SPAWN_CADENCE_SLACK;
  var a = getAllCreeps();
  var n = 0;
  var i = false;
  var O = Infinity;
  for (var R = 0; R < a.length; R++) {
    var s = a[R];
    if (!s || !s.memory || s.memory.role !== "supplier") continue;
    var l = s.memory.homeRoom || s.memory.assignedRoom || s.room && s.room.name;
    if (l !== e) continue;
    n++;
    if (s.spawning || typeof s.ticksToLive !== "number") return false;
    if (s.ticksToLive > t) return false;
    if (s.ticksToLive < O) O = s.ticksToLive;
    i = true;
  }
  if (n >= 2) return false;
  if (!i) return false;
  // Prefer a full-capacity replacement, but never let an unaffordable ideal
  // body block the handoff outright -- that is what left rooms supplierless:
  // the room dips below full energy, the prespawn declines every tick, and the
  // replacement only starts once the incumbent is already dead.
  if (r.energyAvailable >= bodyCost(o)) return true;
  var m = getCreepBody("supplier", r.energyAvailable);
  if (!m || r.energyAvailable < bodyCost(m)) return false;
  // Keep waiting for a full-size body while there is still time to build one.
  // Downgrade only at the point where the affordable body itself would no
  // longer finish spawning before the incumbent dies.
  if (O > m.length * CREEP_SPAWN_TIME + SPAWN_CADENCE_SLACK) return false;
  return true;
}

function shouldDelayUpgraderAtRCL8(e, r) {
  if (!r || !r.controller || !r.controller.my) return false;
  if (r.controller.level !== 8) return false;
  if (!Memory.rcl8UpgraderDelayUntil) Memory.rcl8UpgraderDelayUntil = {};
  var o = Memory.rcl8UpgraderDelayUntil[e];
  if (!o) return false;
  if (Game.time < o) return true;
  delete Memory.rcl8UpgraderDelayUntil[e];
  return false;
}

function scheduleUpgraderDelayRCL8(e) {
  var r = Game.rooms[e];
  if (!r) return;
  var o = getRoomState.get(e);
  var t = o && o.minerals || r.find(FIND_MINERALS);
  var a = t.length > 0 ? t[0] : null;
  if (!a) {
    if (!Memory.rcl8UpgraderDelayUntil) Memory.rcl8UpgraderDelayUntil = {};
    Memory.rcl8UpgraderDelayUntil[e] = Game.time + 5e3;
    return;
  }
  if (a.mineralAmount > 0) {
    if (Memory.rcl8UpgraderDelayUntil && Memory.rcl8UpgraderDelayUntil[e]) {
      delete Memory.rcl8UpgraderDelayUntil[e];
    }
  } else {
    var n = a.ticksToRegeneration;
    if (n === undefined || n === null) {
      n = 100;
    }
    if (!Memory.rcl8UpgraderDelayUntil) Memory.rcl8UpgraderDelayUntil = {};
    Memory.rcl8UpgraderDelayUntil[e] = Game.time + n;
    console.log("[RCL8] " + e + ": Minerals exhausted. Pausing upgraders for " + n + " ticks.");
  }
}

function getRoomTargets(e, r) {
  var o = getRoomState.get(e);
  if (singleSourceRoom.isSingleSourceActive(e)) {
    var t = o && o.constructionSites ? o.constructionSites.length : 0;
    var a = Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[e] ? 1 : 0;
    return {
      harvester: 0,
      upgrader: a,
      builder: +(t > 0),
      scout: 0,
      defender: 0,
      supplier: 0,
      maintainer: 0
    };
  }
  var n = [];
  if (o && o.structuresByType && o.structuresByType[STRUCTURE_CONTAINER]) {
    n = o.structuresByType[STRUCTURE_CONTAINER];
  }
  var i = 0;
  if (o && o.constructionSites) {
    i = o.constructionSites.length;
  }
  let R = +(i > 0);
  var s = o && o.sources || r.find(FIND_SOURCES);
  var l = s.length;
  var O = 0;
  if (o && o.storage && o.storage.store) {
    O = o.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  } else if (r.storage && r.storage.store) {
    O = r.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  }
  var m = 1;
  var u = 0;
  if (r.controller && r.controller.level === 8) {
    var c = l === 1 ? 15e4 : 125e3;
    m = 0;
    if (r.controller.ticksToDowngrade < c) {
      u = 1;
    }
  }
  if (Memory.doubleUpgradeRooms && Memory.doubleUpgradeRooms[e]) {
    if (r.controller && r.controller.level <= 7) {
      m = 2;
    }
  }
  if (global.__boostActive && getBoostMgr().isActive(e, "upgrader")) {
    m = 1;
    u = 0;
  }
  if (r.controller && r.controller.level === 8 && Memory.allowUpgraderRooms && Memory.allowUpgraderRooms[e]) {
    var E = isMiningActive(o, n);
    if (E) {
      m = 1;
      u = 0;
    } else {
      m = 0;
    }
  }
  if (r.controller && r.controller.level === 8 && Memory.forceUpgraderRooms && Memory.forceUpgraderRooms[e]) {
    m = 1;
    u = 0;
  }
  return {
    harvester: 0,
    upgrader: m,
    builder: R,
    scout: 0,
    defender: 0,
    supplier: shouldSpawnSupplier(e),
    maintainer: u
  };
}

function getRemainingConstructionWork(e, r) {
  var o = e && e.constructionSites || r.find(FIND_CONSTRUCTION_SITES);
  var t = 0;
  for (var a = 0; a < o.length; a++) {
    t += Math.max(0, (o[a].progressTotal || 0) - (o[a].progress || 0));
  }
  return t;
}

function isMiningActive(e, r) {
  if (!e) return false;
  var o = null;
  if (e.structuresByType && e.structuresByType[STRUCTURE_EXTRACTOR]) {
    var t = e.structuresByType[STRUCTURE_EXTRACTOR].filter(function(e) {
      return e.my;
    });
    o = t[0];
  }
  if (!o) return false;
  var a = e.minerals && e.minerals.length > 0 ? e.minerals[0] : null;
  if (!a || a.mineralAmount === 0) return false;
  for (var n = 0; n < r.length; n++) {
    if (r[n].pos.getRangeTo(o.pos) <= 1) return true;
  }
  return false;
}

function spawnCreepInRoom(e, r, o, t) {
  const a = e + "_" + t + "_" + Game.time;
  const n = {
    role: e,
    assignedRoom: t,
    homeRoom: t
  };
  if (global.__boostActive && getBoostMgr().isActive(t, e)) {
    var i = getBoostMgr().getSpawnBoostMeta(t, e);
    if (i) {
      n.needsBoost = true;
      n.boostLabs = i.boostLabs;
      n.boosted = i.boosted;
      n.boostRole = i.boostRole;
      n.allowUnboost = i.allowUnboost;
    }
  }
  const R = o.room.energyAvailable;
  const s = bodyCost(r);
  const l = spawnCreepWithDurableMemory(o, r, a, {
    memory: n
  });
  if (l === OK) {
    console.log("[Spawn] " + e + " in " + t + " with " + r.length + " parts | Cost: " + s + " | Energy before: " + R);
    return true;
  } else {
    if (l !== ERR_BUSY) {
      console.log("[Spawn] Failed to spawn " + e + " in " + t + ": " + l + " (energy: " + R + ", cost: " + s + ")");
    }
    return false;
  }
}

function spawnCustomCreep(e, r, o, t, a) {
  var n = {};
  if (a) {
    for (var i in a) n[i] = a[i];
  }
  n.memory = t;
  var R = spawnCreepWithDurableMemory(e, r, o, n, "spawnManager.spawnCustomCreep");
  return R;
}

function manageTowerFillerSpawns() {
  var e = require("roleTowerFiller");
  var r = e.SPAWN_TRIGGER_RATIO;
  var o = getRepairMgr();
  var t = .9;
  for (var a in Game.rooms) {
    var n = Game.rooms[a];
    if (!n.controller || !n.controller.my) continue;
    var i = getRoomState.get(a);
    var R = !!(o && o.isMaxHeal && o.isMaxHeal(a));
    var s = i && i.hostiles || n.find(FIND_HOSTILE_CREEPS);
    s = s.filter(function(e) {
      if (!e || !e.owner) return false;
      if (e.owner.username === "Invader" || e.owner.username === "Source Keeper") return false;
      return !isPureScout(e);
    });
    if (s.length === 0 && !R) continue;
    if (!i || !i.structuresByType) continue;
    var l = i.structuresByType[STRUCTURE_TOWER] || [];
    if (l.length === 0) continue;
    var O = false;
    var m = R ? t : r;
    for (var u = 0; u < l.length; u++) {
      var c = l[u];
      if (!c || !c.my || !c.store) continue;
      var E = c.store.getUsedCapacity(RESOURCE_ENERGY) / c.store.getCapacity(RESOURCE_ENERGY);
      if (E <= m) {
        O = true;
        break;
      }
    }
    var Q = getCreepBody("towerFiller", n.energyCapacityAvailable);
    var Z = TOWER_FILLER_HANDOFF_TTL + (Q ? Q.length * CREEP_SPAWN_TIME : 45) + SPAWN_CADENCE_SLACK;
    var f = false;
    var q = false;
    var M = getAllCreeps();
    for (var g = 0; g < M.length; g++) {
      var A = M[g];
      if (!A || !A.memory) continue;
      if (A.memory.role === "towerFiller" && (A.memory.homeRoom === a || A.memory.assignedRoom === a)) {
        if (A.spawning || typeof A.ticksToLive !== "number" || A.ticksToLive > Z) {
          f = true;
          break;
        }
        q = true;
      }
    }
    if (f) continue;
    if (!O && !q) continue;
    var p = false;
    var d = i.structuresByType[STRUCTURE_SPAWN] || [];
    for (var C = 0; C < d.length && !p; C++) {
      var y = d[C];
      if (y.my && y.spawning) {
        var V = Memory.creeps[y.spawning.name];
        if (V && V.role === "towerFiller" && V.homeRoom === a) {
          p = true;
        }
      }
    }
    if (p) continue;
    var v = null;
    for (var W = 0; W < d.length; W++) {
      if (d[W].my && !d[W].spawning) {
        v = d[W];
        break;
      }
    }
    if (!v) continue;
    var K = getCreepBody("towerFiller", v.room.energyAvailable);
    if (!K) {
      if (Game.time % 10 === 0) {
        console.log("[TowerFiller] Not enough energy in " + a + " to spawn. Have: " + v.room.energyAvailable + ", min: 150");
      }
      continue;
    }
    var T = bodyCost(K);
    var Y = 0;
    for (var h = 0; h < K.length; h++) {
      if (K[h] === CARRY) Y += 50;
    }
    var S = "TowerFiller_" + a + "_" + Game.time % 1e4;
    var w = {
      role: "towerFiller",
      homeRoom: a,
      assignedRoom: a,
      state: "collect"
    };
    var _ = spawnCreepWithDurableMemory(v, K, S, {
      memory: w
    });
    if (_ === OK) {
      console.log("[TowerFiller] Spawning " + S + " in " + a + " | Carry: " + Y + " | Parts: " + K.length + " | Cost: " + T + " | Hostiles: " + s.length);
    } else if (_ !== ERR_BUSY && _ !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[TowerFiller] Spawn failed in " + a + ": " + _);
    }
  }
}

function isPureScout(e) {
  if (!e || !e.body || e.body.length === 0) return true;
  for (var r = 0; r < e.body.length; r++) {
    if (e.body[r].type !== MOVE) return false;
  }
  return true;
}

function manageHarvesterSpawns() {
  for (var e in Game.rooms) {
    var r = Game.rooms[e];
    if (singleSourceRoom.isSingleSourceActive(e)) continue;
    if (!r.controller || !r.controller.my) continue;
    if (roomSuspender.shouldAvoidRoomWork(e) && r.energyAvailable < 3e3) continue;
    var o = 0;
    var t = getRoomState.get(e);
    var a = t ? t.storage : null;
    if (a && a.store) {
      o = a.store[RESOURCE_ENERGY] || 0;
    }
    var n = ensureSourceMetaCache(r);
    if (!n || !n.byId) continue;
    var i = [];
    if (t && t.structuresByType && t.structuresByType[STRUCTURE_SPAWN]) {
      i = t.structuresByType[STRUCTURE_SPAWN].filter(function(e) {
        return e.my;
      });
    }
    if (i.length === 0) continue;
    var R = {};
    for (var s in n.byId) R[s] = 0;
    var l = getAllCreeps();
    for (var O = 0; O < l.length; O++) {
      var m = l[O];
      if (!m || !m.memory) continue;
      if (m.memory.role !== "harvester") continue;
      var u = m.memory.homeRoom || m.memory.assignedRoom || (m.room ? m.room.name : null);
      if (u !== r.name) continue;
      if (m.memory.sourceId && R[m.memory.sourceId] !== undefined) {
        R[m.memory.sourceId]++;
      }
    }
    if (o >= 7e5) {
      var c = true;
      for (var s in n.byId) {
        if ((R[s] || 0) === 0) {
          c = false;
          break;
        }
      }
      if (c) continue;
    }
    var E = [];
    for (var f in n.byId) {
      var M = R[f] || 0;
      if (M === 0) {
        E.push({
          id: f,
          meta: n.byId[f],
          range: n.byId[f].range || 9999
        });
      }
    }
    if (E.length === 0) continue;
    E.sort(function(e, r) {
      return e.range - r.range;
    });
    var g = E[0];
    var A = g.meta;
    var p = new RoomPosition(A.pos.x, A.pos.y, A.pos.roomName);
    var d = null;
    var C = Infinity;
    for (var y = 0; y < i.length; y++) {
      var V = i[y];
      var v = V.pos.getRangeTo(p);
      if (v < C) {
        C = v;
        d = V;
      }
    }
    if (!d) continue;
    if (d.spawning) {
      // Nearest spawn is busy. Prefer the closest idle spawn over skipping the
      // source entirely for this tick.
      var altSpawn = null;
      var altRange = Infinity;
      for (var altIdx = 0; altIdx < i.length; altIdx++) {
        if (i[altIdx].spawning) continue;
        var altDist = i[altIdx].pos.getRangeTo(p);
        if (altDist < altRange) {
          altRange = altDist;
          altSpawn = i[altIdx];
        }
      }
      if (!altSpawn) continue;
      d = altSpawn;
      C = altRange;
    }
    var W = d;
    var K = C < Infinity ? C : A.range || 10;
    var T = W.room.energyAvailable;
    var Y = buildHarvesterBodyForDistance(K, T);
    if (!Y) continue;
    var h = g.id.slice(-6);
    var S = "H_" + e + "_" + h + "_" + Game.time;
    var w = {
      role: "harvester",
      assignedRoom: r.name,
      homeRoom: r.name,
      sourceId: g.id
    };
    var _ = bodyCost(Y);
    var b = getSpawnDirections(W.pos, p);
    var U = {
      memory: w
    };
    if (b) U.directions = b;
    var k = spawnCreepWithDurableMemory(W, Y, S, U);
    if (k === OK) {
      console.log("[Spawn] harvester in " + r.name + " for source " + h + " (distFromSpawn: " + K + ") | Parts: " + Y.length + " | Cost: " + _);
    } else if (k !== ERR_BUSY && k !== ERR_NOT_ENOUGH_ENERGY) {
      console.log("[Spawn] Failed to spawn harvester in " + r.name + " for " + h + ": " + k);
    }
  }
}

function manageRepairerSpawns() {
  if (!Memory.repairSpawnRequests) return;
  var e = Memory.spawnPause && Memory.spawnPause.repairer;
  for (var r in Memory.repairSpawnRequests) {
    if (e && (e.global || e.rooms && e.rooms[r])) continue;
    var o = Game.rooms[r];
    if (!o || !o.controller || !o.controller.my) continue;
    var t = Memory.repairSpawnRequests[r];
    if (!t || t.length === 0) continue;
    if (!shouldAttemptRepairerSpawn(r, t)) continue;
    t.sort(function(e, r) {
      return (e.priority || 99) - (r.priority || 99);
    });
    for (var a = t.length - 1; a >= 0; a--) {
      var n = t[a];
      if (!n || n.spawned || n.s) t.splice(a, 1);
    }
    if (t.length === 0) continue;
    // blockedReason is diagnostic only and is rewritten below whenever a gate
    // actually rejects a request. Clear it first so repairDispatch reports this
    // tick's reason instead of one left over from an earlier attempt.
    for (var B = 0; B < t.length; B++) {
      if (t[B] && t[B].blockedReason !== undefined) delete t[B].blockedReason;
    }
    if (roomSuspender.shouldAvoidRoomWork(r)) {
      for (var i = 0; i < t.length; i++) {
        if (t[i]) t[i].blockedReason = "room suspended";
      }
      continue;
    }
    var R = getRoomState.get(r);
    if (!R || !R.structuresByType || !R.structuresByType[STRUCTURE_SPAWN]) continue;
    var s = null;
    for (var l = 0; l < R.structuresByType[STRUCTURE_SPAWN].length; l++) {
      var O = R.structuresByType[STRUCTURE_SPAWN][l];
      if (O.my && !O.spawning) {
        s = O;
        break;
      }
    }
    if (!s) continue;
    if (global.__boostActive && getBoostMgr().isActive(r, "repairer") && getBoostMgr().shouldGateSpawn(r, "repairer") && !getBoostMgr().areLabsReady(r, "repairer")) {
      for (var b = 0; b < t.length; b++) {
        if (t[b]) t[b].blockedReason = "waiting for boost labs";
      }
      if (Game.time % 20 === 0) {
        console.log("[BoostManager] " + r + ": Waiting for boost labs before spawning repairer");
      }
      continue;
    }
    for (var m = 0; m < t.length; m++) {
      var u = t[m];
      if (!u || u.spawned) continue;
      if (u.kind === "extra" && !u.emergency && !u.maxHeal) {
        if (!o.storage || o.storage.store[RESOURCE_ENERGY] < 3e5) {
          u.blockedReason = "storage below 300k";
          continue;
        }
      }
      var c = u.body;
      if (!c && u.b) {
        c = [];
        var E = [ WORK, CARRY, MOVE, TOUGH, ATTACK, RANGED_ATTACK, HEAL, CLAIM ];
        for (var i = 0; i < E.length; i++) {
          var f = E[i];
          var M = u.b[f] || 0;
          for (var g = 0; g < M; g++) c.push(f);
        }
      }
      if (!c || !c.length) {
        t.splice(m, 1);
        m--;
        continue;
      }
      var A = u.cost || bodyCost(c);
      if (s.room.energyAvailable < A) {
        u.blockedReason = "need " + A + " energy";
        continue;
      }
      var p = "Repairer_" + r + "_" + u.kind + "_" + Game.time % 1e4;
      var d = {
        role: "repairer",
        homeRoom: r
      };
      var C = spawnCreepWithDurableMemory(s, c, p, {
        memory: d
      });
      if (C === OK) {
        if (!Memory.repairSpawnLastTick) Memory.repairSpawnLastTick = {};
        Memory.repairSpawnLastTick[r] = Game.time;
        console.log("[RepairManager] Spawning " + p + " in " + r + " | kind:" + u.kind + " | cost:" + A + " | parts:" + c.length);
        t.splice(m, 1);
      } else if (C !== ERR_BUSY && C !== ERR_NOT_ENOUGH_ENERGY) {
        console.log("[RepairManager] Failed to spawn repairer in " + r + ": " + C);
      }
      break;
    }
  }
}

// Reports what is occupying each candidate exit tile of a spawn. Used by the
// stall watchdog and by spawnStatus() to explain a spawn stuck at
// remainingTime === 0.
function spawnExitReport(spawn, directions) {
  var lines = [];
  var room = spawn.room;
  var list = directions && directions.length ? directions : [ 1, 2, 3, 4, 5, 6, 7, 8 ];
  var terrain = Game.map.getRoomTerrain(room.name);
  for (var i = 0; i < list.length; i++) {
    var delta = SPAWN_DIR_DELTA[list[i]];
    if (!delta) continue;
    var x = spawn.pos.x + delta[0];
    var y = spawn.pos.y + delta[1];
    if (x < 0 || x > 49 || y < 0 || y > 49) {
      lines.push("dir " + list[i] + " " + x + "," + y + ": off-map");
      continue;
    }
    var blockers = [];
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) blockers.push("wall");
    var creeps = room.lookForAt(LOOK_CREEPS, x, y);
    for (var c = 0; c < creeps.length; c++) {
      blockers.push("creep:" + creeps[c].name + "(" + (creeps[c].memory ? creeps[c].memory.role : "?") + ")");
    }
    var structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (var t = 0; t < structures.length; t++) {
      if (OBSTACLE_OBJECT_TYPES.indexOf(structures[t].structureType) !== -1) {
        blockers.push(structures[t].structureType);
      }
    }
    lines.push("dir " + list[i] + " " + x + "," + y + ": " + (blockers.length ? blockers.join(" ") : "OPEN"));
  }
  return lines;
}

// A spawn whose creep cannot be placed sits at remainingTime === 0 forever.
// spawnCreep already returned OK, so nothing else in the codebase notices, and
// manageSpawnsPerRoom filters the spawn out as "busy" — in a one-spawn room
// that silently stops every role. Runs every tick, outside the spawn cadence
// gate, so the stall counter is measured in real ticks.
function checkStalledSpawns() {
  if (!Memory.spawnStallWatch) Memory.spawnStallWatch = {};
  var watch = Memory.spawnStallWatch;
  var seen = {};
  for (var name in Game.spawns) {
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.my) continue;
    var spawning = spawn.spawning;
    if (!spawning || spawning.remainingTime !== 0) continue;
    var key = spawn.room.name + "|" + name;
    seen[key] = true;
    if (watch[key] === undefined) {
      watch[key] = Game.time;
      continue;
    }
    var stuck = Game.time - watch[key];
    if (stuck === SPAWN_STALL_WARN_TICKS || (stuck > SPAWN_STALL_WARN_TICKS && stuck % 20 === 0)) {
      console.log("[SpawnStall] " + spawn.room.name + " " + name + ": '" + spawning.name + "' blocked " + stuck + " ticks (dirs=" + (spawning.directions ? spawning.directions.join("/") : "any") + ")");
      var report = spawnExitReport(spawn, spawning.directions);
      for (var r = 0; r < report.length; r++) console.log("[SpawnStall]   " + report[r]);
    }
    if (stuck >= SPAWN_STALL_CANCEL_TICKS) {
      spawning.cancel();
      console.log("[SpawnStall] " + spawn.room.name + " " + name + ": cancelled '" + spawning.name + "' after " + stuck + " ticks to free the spawn.");
      delete watch[key];
    }
  }
  for (var k in watch) {
    if (!seen[k]) delete watch[k];
  }
}

// Console command. spawnStatus() for every owned room, spawnStatus("E1N46")
// for one. Read-only.
function spawnStatus(roomName) {
  var lines = [ "[SpawnStatus] tick=" + Game.time + " bucket=" + Game.cpu.bucket ];
  var rooms = [];
  if (roomName) {
    rooms.push(roomName);
  } else {
    for (var name in Game.rooms) {
      var candidate = Game.rooms[name];
      if (candidate.controller && candidate.controller.my) rooms.push(name);
    }
  }
  var creeps = getAllCreeps();
  for (var n = 0; n < rooms.length; n++) {
    var rn = rooms[n];
    var room = Game.rooms[rn];
    if (!room || !room.controller || !room.controller.my) {
      lines.push(rn + ": no vision or not owned");
      continue;
    }
    lines.push("");
    lines.push(rn + " RCL" + room.controller.level + " energy=" + room.energyAvailable + "/" + room.energyCapacityAvailable);
    var susp = Memory.suspendedRooms && Memory.suspendedRooms[rn];
    lines.push("  suspended=" + (susp ? "YES reason=" + susp.reason + " for " + (Game.time - (susp.at || Game.time)) + "t" : "no"));
    var spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns.length) lines.push("  spawns: NONE");
    for (var i = 0; i < spawns.length; i++) {
      var spawn = spawns[i];
      if (!spawn.spawning) {
        lines.push("  spawn " + spawn.name + ": idle");
        continue;
      }
      var sp = spawn.spawning;
      lines.push("  spawn " + spawn.name + ": " + sp.name + " rem=" + sp.remainingTime + "/" + sp.needTime + " dirs=" + (sp.directions ? sp.directions.join("/") : "any") + (sp.remainingTime === 0 ? "   <<< STALLED" : ""));
      if (sp.remainingTime === 0) {
        var report = spawnExitReport(spawn, sp.directions);
        for (var q = 0; q < report.length; q++) lines.push("    " + report[q]);
      }
    }
    var fullBody = getCreepBody("supplier", room.energyCapacityAvailable);
    var fullCost = fullBody ? bodyCost(fullBody) : 0;
    var supplierCount = 0;
    var ttls = [];
    for (var c = 0; c < creeps.length; c++) {
      var creep = creeps[c];
      if (!creep || !creep.memory || creep.memory.role !== "supplier") continue;
      var home = creep.memory.homeRoom || creep.memory.assignedRoom || (creep.room && creep.room.name);
      if (home !== rn) continue;
      supplierCount++;
      ttls.push(creep.spawning ? "spawning" : creep.ticksToLive);
    }
    lines.push("  supplier: count=" + supplierCount + " target=" + shouldSpawnSupplier(rn) + " ttl=[" + ttls.join(",") + "]");
    lines.push("    prespawnDue=" + isSupplierPrespawnDue(rn, room) + " fullBodyCost=" + fullCost + " energyAvail=" + room.energyAvailable + (fullCost && room.energyAvailable < fullCost ? " (below full-body cost, downgrade path)" : ""));
    var meta = Memory.sourceMeta && Memory.sourceMeta[rn];
    if (!meta || !meta.byId) {
      lines.push("  sourceMeta: MISSING -- harvester spawning bails");
    } else {
      var perSource = {};
      for (var id in meta.byId) perSource[id] = 0;
      for (var h = 0; h < creeps.length; h++) {
        var hc = creeps[h];
        if (!hc || !hc.memory || hc.memory.role !== "harvester") continue;
        var hhome = hc.memory.homeRoom || hc.memory.assignedRoom || (hc.room && hc.room.name);
        if (hhome !== rn) continue;
        if (perSource[hc.memory.sourceId] !== undefined) perSource[hc.memory.sourceId]++;
      }
      for (var id2 in meta.byId) {
        lines.push("  source " + id2.slice(-6) + ": harvesters=" + perSource[id2] + " range=" + meta.byId[id2].range);
      }
      lines.push("  sourceMeta age=" + (Game.time - meta.lastScan) + "t");
    }
    var delay = Memory.spawnDelayUntil && Memory.spawnDelayUntil[rn];
    var upDelay = Memory.rcl8UpgraderDelayUntil && Memory.rcl8UpgraderDelayUntil[rn];
    lines.push("  locks: spawnDelay=" + (delay && Game.time < delay ? delay - Game.time + "t" : "-") + " rcl8UpgraderDelay=" + (upDelay && Game.time < upDelay ? upDelay - Game.time + "t" : "-") + " singleSource=" + !!(Memory.singleSourceRooms && Memory.singleSourceRooms[rn]));
    lines.push("  targets: " + JSON.stringify(getRoomTargets(rn, room)));
  }
  var stalls = Memory.spawnStallWatch ? Object.keys(Memory.spawnStallWatch) : [];
  if (stalls.length) lines.push("stallWatch: " + stalls.join(" "));
  console.log(lines.join("\n"));
  return "";
}

global.spawnStatus = spawnStatus;

function run(e) {
  checkStalledSpawns();
  if (Game.time % 1e3 === 0) pruneSourceMetaCache();
  if (Game.time % 5 === 0) manageDemolitionSpawns();
  if (Game.time % 5 === 0) manageAttackerSpawns();
  if (Game.time % 5 === 0) manageHarasserSpawns();
  if (Game.time % 5 === 0) manageHealerSpawns();
  if (Game.time % 5 === 0) manageTowerDrainSpawns();
  if (Game.time % 5 === 0) manageThiefSpawns();
  if (Game.time % 5 === 0) manageScavengerSpawns();
  if (Game.time % 5 === 0) manageExtractorSpawns();
  if (Game.time % 2 === 0) manageLabBotSpawns();
  if (Game.time % 10 === 0) manageNukeFillSpawns();
  if (Game.time % 5 === 0) manageRemoteBuilderSpawns();
  if (Game.time % 5 === 0) manageContestedDemolisherSpawns();
  if (Game.time % 5 === 0) manageDrainDemolisherSpawns();
  if (Game.time % 5 === 0) manageSKAttackerSpawns();
  if (Game.time % 10 === 0) manageSingleSourceSpawns(e);
  if (Game.time % 5 === 0) manageRemoteSupplierSpawns();
  if (Game.time % 10 === 0) manageControllerAttackerSpawns();
  if (Game.time % 10 === 0) manageExtractorAssistantSpawns();
  if (Game.time % 10 === 0) manageTowerFillerSpawns();
  if (needsNewCreeps(e) || Game.time % 10 === 0) {
    manageSpawnsPerRoom(e);
  }
  manageRepairerSpawns();
  if (Game.time % 5 === 0) manageSquadSpawns(e);
}

function manageControllerAttackerSpawns() {
  if (!Memory.controllerAttackOrders || Memory.controllerAttackOrders.length === 0) return;
  const e = 650;
  const r = 19;
  const o = 15;
  const t = 1;
  let a = null;
  let n = null;
  for (let i = 0; i < Memory.controllerAttackOrders.length; ) {
    const R = Memory.controllerAttackOrders[i];
    if (!R || !R.homeRoom || !R.targetRoom) {
      console.log("[ControllerAttack] Removing malformed order at queue index " + i + ".");
      Memory.controllerAttackOrders.splice(i, 1);
      continue;
    }
    const s = _.find(getAllCreeps(), e => e.memory && e.memory.role === "controllerAttacker" && e.memory.targetRoom === R.targetRoom);
    if (s) {
      console.log("[ControllerAttack] Creep already exists for " + R.targetRoom + ". Removing order.");
      Memory.controllerAttackOrders.splice(i, 1);
      continue;
    }
    const l = Game.rooms[R.homeRoom];
    if (l && (!l.controller || !l.controller.my)) {
      console.log("[ControllerAttack] Home room is no longer owned: " + R.homeRoom + ". Removing order.");
      Memory.controllerAttackOrders.splice(i, 1);
      continue;
    }
    if (!l) {
      i++;
      continue;
    }
    const O = getRoomState.get(R.homeRoom);
    if (!O || !O.structuresByType || !O.structuresByType[STRUCTURE_SPAWN]) {
      i++;
      continue;
    }
    const m = O.structuresByType[STRUCTURE_SPAWN].find(e => e.my && !e.spawning);
    if (!m) {
      i++;
      continue;
    }
    const u = m.room.energyCapacityAvailable;
    const c = m.room.energyAvailable;
    const E = Math.min(r, Math.floor(u / e));
    const f = E * e;
    const M = Math.min(E, o);
    const g = M * e;
    let A, p, d;
    if (c >= f && E >= t) {
      A = E;
      p = f;
      d = "FULL (" + A + " pairs)";
    } else if (c >= g && M >= t) {
      A = M;
      p = g;
      d = "LARGE (" + A + " pairs)";
    } else {
      if (!n) n = {
        order: R,
        available: c,
        fullCost: f,
        fallbackCost: g
      };
      i++;
      continue;
    }
    a = {
      index: i,
      order: R,
      spawn: m,
      targetPairs: A,
      targetCost: p,
      tierLabel: d
    };
    break;
  }
  if (!a) {
    if (n) {
      console.log("[ControllerAttack] Waiting for energy in " + n.order.homeRoom + " | Have: " + n.available + " | Full needs: " + n.fullCost + " | Fallback needs: " + n.fallbackCost);
    }
    return;
  }
  const i = a.order;
  const R = a.spawn;
  const s = a.targetPairs;
  const l = a.targetCost;
  const O = a.tierLabel;
  const m = [];
  for (let e = 0; e < s; e++) m.push(CLAIM);
  for (let e = 0; e < s; e++) m.push(MOVE);
  const u = "CtrlAtk_" + i.targetRoom + "_" + Game.time;
  const c = spawnCreepWithDurableMemory(R, m, u, {
    memory: {
      role: "controllerAttacker",
      homeRoom: i.homeRoom,
      targetRoom: i.targetRoom,
      waypointRoom: i.waypointRoom || undefined
    }
  });
  if (c === OK) {
    console.log("[ControllerAttack] Spawning " + u + " | " + i.homeRoom + " -> " + i.targetRoom + " | Tier: " + O + " | Parts: " + m.length + " | Cost: " + l);
    Memory.controllerAttackOrders.splice(a.index, 1);
  } else if (c !== ERR_BUSY) {
    console.log("[ControllerAttack] Spawn failed in " + i.homeRoom + ": error " + c);
  }
}

function needsNewCreeps(e) {
  if (!e) return false;
  for (const t in e) {
    if (Memory.suspendedRooms && Memory.suspendedRooms[t]) continue;
    const a = e[t];
    var r = 0;
    for (var o in a) r += a[o];
    if (a.harvester === 0) return true;
    if (r < 3) return true;
  }
  return false;
}

module.exports = {
  run: run,
  manageSpawnsPerRoom: manageSpawnsPerRoom,
  manageHarvesterSpawns: manageHarvesterSpawns,
  manageDemolitionSpawns: manageDemolitionSpawns,
  manageContestedDemolisherSpawns: manageContestedDemolisherSpawns,
  manageDrainDemolisherSpawns: manageDrainDemolisherSpawns,
  manageAttackerSpawns: manageAttackerSpawns,
  manageHarasserSpawns: manageHarasserSpawns,
  manageHealerSpawns: manageHealerSpawns,
  trySpawnHealers: trySpawnHealers,
  manageTowerDrainSpawns: manageTowerDrainSpawns,
  manageThiefSpawns: manageThiefSpawns,
  manageExtractorSpawns: manageExtractorSpawns,
  manageLabBotSpawns: manageLabBotSpawns,
  manageRepairerSpawns: manageRepairerSpawns,
  manageSquadSpawns: manageSquadSpawns,
  manageNukeFillSpawns: manageNukeFillSpawns,
  manageRemoteBuilderSpawns: manageRemoteBuilderSpawns,
  manageSKAttackerSpawns: manageSKAttackerSpawns,
  manageSingleSourceSpawns: manageSingleSourceSpawns,
  getSingleSourceBody: getSingleSourceBody,
  manageExtractorAssistantSpawns: manageExtractorAssistantSpawns,
  mineralMiningStatus: mineralMiningStatus,
  manageTowerFillerSpawns: manageTowerFillerSpawns,
  manageScavengerSpawns: manageScavengerSpawns,
  getCreepBody: getCreepBody,
  getComplianceBody: getComplianceBody,
  getUpgraderBody: getUpgraderBody,
  spawnCustomCreep: spawnCustomCreep,
  bodyCost: bodyCost,
  shouldSpawnSupplier: shouldSpawnSupplier,
  isSupplierPrespawnDue: isSupplierPrespawnDue,
  spawnEmergencyHarvester: spawnEmergencyHarvester,
  getRoomTargets: getRoomTargets,
  handleRoomSpawnDelay: handleRoomSpawnDelay,
  checkStalledSpawns: checkStalledSpawns,
  spawnExitReport: spawnExitReport,
  spawnStatus: spawnStatus
};
