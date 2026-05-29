// maintenanceScanner.js
// Purpose: Scan all visible rooms and estimate energy per tick (en/tick) needed to offset decay
// across roads (plains/swamp), ramparts (yours only), containers (claimed vs unclaimed/reserved),
// and tunnels (if present / flagged).
// No optional chaining is used.
//
// Console:
//   - One room (with observer fallback): require('maintenanceScanner').scanRoom('W1N1')
//   - All visible rooms:                 require('maintenanceScanner').print()
//   - Raw data:                          require('maintenanceScanner').scan()
//
// main.js (run every tick):
//   const maint = require('maintenanceScanner');
//   maint.processPendingMaintScan();
//
// One command does everything — scanRoom() fires the observer if needed,
// then processPendingMaintScan() auto-completes next tick and wipes memory.
//
// Repair cost model:
//   Creep:         REPAIR_POWER = 100 hits/energy  (1 energy heals 100 HP)
//   Tower optimal: 800 hits / 10 energy = 80 hits/energy  (range ≤5)
//   Tower average: 400 hits / 10 energy = 40 hits/energy  (range ~12)
//   Tower poor:    200 hits / 10 energy = 20 hits/energy  (range ≥20)
//   Tower cost is calculated per-structure from actual tower positions where available.
//   Falls back to TOWER_FALLBACK_HITS_PER_ENERGY if no towers exist in the room.
//
// Container decay classification:
//   claimed   = controller.owner set (any player, yours OR enemy) → 10 hits/tick
//   unclaimed = no controller, or controller with no owner (neutral/reserved) → 50 hits/tick
//
// Notes:
//   - We iterate Game.rooms and room.find(FIND_STRUCTURES) so neutral structures (roads/containers)
//     are included. Game.structures alone only includes your owned structures.
//   - All ramparts are counted regardless of ownership — useful for your own rooms (maintenance
//     cost) and enemy rooms (estimating their upkeep burden or planning attacks).
//   - You can mark tunnel ids in Memory.maintScan.tunnelIds = ['id1','id2'].
//   - ROAD_WEAROUT (1 hit per creep footstep) is intentionally not modelled — it requires
//     traffic counts per tile which aren't available from a static scan.

// ─── Repair power constants ───────────────────────────────────────────────────

var CREEP_REPAIR_HITS_PER_ENERGY = 100;  // REPAIR_POWER: hits per 1 energy

// Screeps tower repair formula constants
var TOWER_ENERGY_COST          = 10;   // energy per tower action
var TOWER_MAX_REPAIR           = 800;  // hits repaired at range ≤ TOWER_OPTIMAL_RANGE
var TOWER_MIN_REPAIR           = 200;  // hits repaired at range ≥ TOWER_FALLOFF_RANGE
var TOWER_OPTIMAL_RANGE        = 5;    // full power within this range
var TOWER_FALLOFF_RANGE        = 20;   // minimum power at this range and beyond

// Fallback used only when no towers exist in the scanned room
var TOWER_FALLBACK_HITS_PER_ENERGY = 40;

/**
 * Returns hits/energy a tower delivers at a given Chebyshev range.
 * Matches the Screeps engine formula exactly.
 */
function calcTowerHitsPerEnergy(range) {
  var hits;
  if (range <= TOWER_OPTIMAL_RANGE) {
    hits = TOWER_MAX_REPAIR;
  } else if (range >= TOWER_FALLOFF_RANGE) {
    hits = TOWER_MIN_REPAIR;
  } else {
    var ratio = (range - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE);
    hits = TOWER_MAX_REPAIR - ratio * (TOWER_MAX_REPAIR - TOWER_MIN_REPAIR);
  }
  return hits / TOWER_ENERGY_COST;
}

/**
 * Returns the hits/energy for a structure based on its distance to the
 * nearest tower in the same room. Falls back to TOWER_FALLBACK_HITS_PER_ENERGY
 * if no towers are provided.
 */
function towerHitsPerEnergyForStructure(structure, towers) {
  if (!towers || towers.length === 0) return TOWER_FALLBACK_HITS_PER_ENERGY;
  var minRange = Infinity;
  for (var i = 0; i < towers.length; i++) {
    var range = Math.max(
      Math.abs(structure.pos.x - towers[i].pos.x),
      Math.abs(structure.pos.y - towers[i].pos.y)
    );
    if (range < minRange) minRange = range;
  }
  return calcTowerHitsPerEnergy(minRange);
}

// ─── Decay rates (hits per tick) ─────────────────────────────────────────────
// Derived from official Screeps constants where available, with hardcoded fallbacks
// in case a constant isn't defined (private servers, future changes, etc).
//
// Source constants (all verified against docs.screeps.com/api/#Constants):
//   ROAD_DECAY_AMOUNT     = 100    ROAD_DECAY_TIME           = 1000
//   ROAD_WEAROUT          = 1      (extra 1 hit per creep stepping on road — NOT modelled here)
//   RAMPART_DECAY_AMOUNT  = 300    RAMPART_DECAY_TIME        = 100
//   CONTAINER_DECAY       = 5000   CONTAINER_DECAY_TIME      = 100 (unowned)
//                                  CONTAINER_DECAY_TIME_OWNED= 500 (claimed)

var _ROAD_DPT   = (typeof ROAD_DECAY_AMOUNT    !== 'undefined' && typeof ROAD_DECAY_TIME            !== 'undefined') ? ROAD_DECAY_AMOUNT    / ROAD_DECAY_TIME            : 0.1;
var _RAMP_DPT   = (typeof RAMPART_DECAY_AMOUNT !== 'undefined' && typeof RAMPART_DECAY_TIME         !== 'undefined') ? RAMPART_DECAY_AMOUNT / RAMPART_DECAY_TIME          : 3.0;
var _CONT_DPT_U = (typeof CONTAINER_DECAY      !== 'undefined' && typeof CONTAINER_DECAY_TIME       !== 'undefined') ? CONTAINER_DECAY      / CONTAINER_DECAY_TIME        : 50.0;
var _CONT_DPT_O = (typeof CONTAINER_DECAY      !== 'undefined' && typeof CONTAINER_DECAY_TIME_OWNED !== 'undefined') ? CONTAINER_DECAY      / CONTAINER_DECAY_TIME_OWNED  : 10.0;

var DECAY_HITS = {
  road_plain:           _ROAD_DPT,        // 0.1  hits/tick
  road_swamp:           _ROAD_DPT * 5,    // 0.5  hits/tick (CONSTRUCTION_COST_ROAD_SWAMP_RATIO = 5)
  rampart:              _RAMP_DPT,        // 3.0  hits/tick
  container_claimed:    _CONT_DPT_O,      // 10.0 hits/tick (any owned room — yours or enemy)
  container_unclaimed:  _CONT_DPT_U,      // 50.0 hits/tick (neutral or reserved only)
  tunnel:               15.0             // custom — adjust as needed
};

// Precompute creep en/tick from decay — tower cost is computed per-structure at scan time
var EPT_CREEP = {};
for (var _k in DECAY_HITS) {
  EPT_CREEP[_k] = DECAY_HITS[_k] / CREEP_REPAIR_HITS_PER_ENERGY;
}

var OBSERVER_RANGE = 10;

// ─── Room helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the room has a claimed controller — any owner, yours or enemy.
 * This is what determines the slower container decay rate (CONTAINER_DECAY_TIME_OWNED).
 * Previously this checked c.my which incorrectly treated enemy-owned rooms as unclaimed.
 */
function isClaimedRoom(room) {
  if (!room) return false;
  var c = room.controller;
  if (!c) return false;
  return !!c.owner; // any player's ownership triggers the owned decay rate
}

function classifyRoadTerrain(structure) {
  var terrain = structure.room.getTerrain();
  var t = terrain.get(structure.pos.x, structure.pos.y);
  if ((t & TERRAIN_MASK_SWAMP) === TERRAIN_MASK_SWAMP) return 'swamp';
  return 'plain';
}

function isTunnelStructure(structure) {
  if (typeof STRUCTURE_TUNNEL !== 'undefined') {
    if (structure.structureType === STRUCTURE_TUNNEL) return true;
  }
  if (structure.structureType === 'tunnel') return true;
  if (Memory.maintScan && Array.isArray(Memory.maintScan.tunnelIds)) {
    for (var i = 0; i < Memory.maintScan.tunnelIds.length; i++) {
      if (structure.id === Memory.maintScan.tunnelIds[i]) return true;
    }
  }
  return false;
}

// ─── Observer helpers ─────────────────────────────────────────────────────────

function parseRoomCoords(roomName) {
  var m = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!m) return null;
  var x = parseInt(m[2], 10);
  var y = parseInt(m[4], 10);
  if (m[1] === 'W') x = -x - 1;
  if (m[3] === 'S') y = -y - 1;
  return { x: x, y: y };
}

function findObserverInRange(targetRoomName) {
  var tc = parseRoomCoords(targetRoomName);
  if (!tc) return null;

  var best = null;
  var bestDist = Infinity;

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var observers = room.find(FIND_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_OBSERVER; }
    });

    for (var i = 0; i < observers.length; i++) {
      var oc = parseRoomCoords(roomName);
      if (!oc) continue;
      var dist = Math.max(Math.abs(tc.x - oc.x), Math.abs(tc.y - oc.y));
      if (dist <= OBSERVER_RANGE && dist < bestDist) {
        best = observers[i];
        bestDist = dist;
      }
    }
  }

  return best;
}

// ─── Memory helpers ───────────────────────────────────────────────────────────

function getPending(roomName) {
  if (!Memory.maintScan || !Memory.maintScan.pending) return null;
  return Memory.maintScan.pending[roomName] || null;
}

function setPending(roomName, data) {
  if (!Memory.maintScan)         Memory.maintScan         = {};
  if (!Memory.maintScan.pending) Memory.maintScan.pending = {};
  Memory.maintScan.pending[roomName] = data;
}

function wipePending(roomName) {
  if (!Memory.maintScan) return;
  if (Memory.maintScan.pending)  delete Memory.maintScan.pending[roomName];
  if (Memory.maintScan.powerObs) delete Memory.maintScan.powerObs[roomName];
}

// ─── Core scan logic ──────────────────────────────────────────────────────────

// Data shape:
// {
//   totalEptCreep, totalEptTower,
//   rooms: {
//     <roomName>: {
//       totalEptCreep, totalEptTower, towerExact, count,
//       types: { <typeKey>: { eptCreep, eptTower, count } }
//     }
//   }
// }
// towerExact: true  = tower cost calculated from actual tower positions in room
// towerExact: false = no towers found, tower cost is an estimate (TOWER_FALLBACK_HITS_PER_ENERGY)

function scan() {
  var summary = { totalEptCreep: 0, totalEptTower: 0, rooms: {} };

  function add(roomName, typeKey, eptCreep, eptTower, towerExact) {
    if (!summary.rooms[roomName]) {
      summary.rooms[roomName] = { totalEptCreep: 0, totalEptTower: 0, towerExact: false, count: 0, types: {} };
    }
    var r = summary.rooms[roomName];
    r.totalEptCreep += eptCreep;
    r.totalEptTower += eptTower;
    if (towerExact) r.towerExact = true;
    r.count += 1;
    if (!r.types[typeKey]) r.types[typeKey] = { eptCreep: 0, eptTower: 0, count: 0 };
    r.types[typeKey].eptCreep += eptCreep;
    r.types[typeKey].eptTower += eptTower;
    r.types[typeKey].count += 1;
    summary.totalEptCreep += eptCreep;
    summary.totalEptTower += eptTower;
  }

  for (var rn in Game.rooms) {
    var room = Game.rooms[rn];
    if (!room) continue;
    scanRoomStructures(room, rn, add);
  }

  return roundSummary(summary);
}

function scanRoomStructures(room, roomName, addFn) {
  // Find all towers in the room first — used for per-structure tower cost calculation
  var towers = room.find(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
  });
  var hasTowers = towers.length > 0;

  var structs = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];

    // Compute this structure's tower repair efficiency from its distance to nearest tower
    var towerHpe = towerHitsPerEnergyForStructure(s, towers);

    if (isTunnelStructure(s)) {
      addFn(roomName, 'tunnel', EPT_CREEP.tunnel, DECAY_HITS.tunnel / towerHpe, hasTowers);
      continue;
    }

    if (s.structureType === STRUCTURE_ROAD) {
      var rt = classifyRoadTerrain(s);
      if (rt === 'swamp') addFn(roomName, 'road_swamp', EPT_CREEP.road_swamp, DECAY_HITS.road_swamp / towerHpe, hasTowers);
      else                addFn(roomName, 'road_plain',  EPT_CREEP.road_plain,  DECAY_HITS.road_plain  / towerHpe, hasTowers);
      continue;
    }

    if (s.structureType === STRUCTURE_RAMPART) {
      // Count all ramparts — enemy rooms show enemy ramparts, useful for
      // estimating their maintenance burden or planning attacks
      addFn(roomName, 'rampart', EPT_CREEP.rampart, DECAY_HITS.rampart / towerHpe, hasTowers);
      continue;
    }

    if (s.structureType === STRUCTURE_CONTAINER) {
      if (isClaimedRoom(room)) addFn(roomName, 'container_claimed',   EPT_CREEP.container_claimed,   DECAY_HITS.container_claimed   / towerHpe, hasTowers);
      else                     addFn(roomName, 'container_unclaimed', EPT_CREEP.container_unclaimed, DECAY_HITS.container_unclaimed / towerHpe, hasTowers);
      continue;
    }
  }
}

function roundSummary(summary) {
  summary.totalEptCreep = Math.round(summary.totalEptCreep * 1000) / 1000;
  summary.totalEptTower = Math.round(summary.totalEptTower * 1000) / 1000;
  for (var k in summary.rooms) {
    var r = summary.rooms[k];
    r.totalEptCreep = Math.round(r.totalEptCreep * 1000) / 1000;
    r.totalEptTower = Math.round(r.totalEptTower * 1000) / 1000;
    for (var tk in r.types) {
      r.types[tk].eptCreep = Math.round(r.types[tk].eptCreep * 1000) / 1000;
      r.types[tk].eptTower = Math.round(r.types[tk].eptTower * 1000) / 1000;
    }
  }
  return summary;
}

// ─── Print helpers ────────────────────────────────────────────────────────────

var TICKS_PER_DAY = 28800; // 1 tick per 3 seconds × 86400 seconds

function fmtEnergy(e) {
  if (e >= 1000000) return (e / 1000000).toFixed(2) + 'M';
  if (e >= 1000)    return (e / 1000).toFixed(1) + 'k';
  return Math.round(e).toString();
}

function dailyCost(ept) {
  return fmtEnergy(ept * TICKS_PER_DAY);
}

function printSummary(data) {
  console.log('[maint-scan] Total — creep: ' + data.totalEptCreep +
    ' en/tick (' + dailyCost(data.totalEptCreep) + '/day)' +
    ' | tower: ' + data.totalEptTower + ' en/tick (' + dailyCost(data.totalEptTower) + '/day)');

  var rooms = [];
  for (var rn in data.rooms) rooms.push({ name: rn, info: data.rooms[rn] });
  rooms.sort(function(a, b) { return b.info.totalEptCreep - a.info.totalEptCreep; });

  console.log('[maint-scan] Rooms (desc by creep en/tick):');
  for (var i = 0; i < rooms.length; i++) {
    var r = rooms[i];
    var towerLabel = r.info.towerExact
      ? 'tower (actual)'
      : 'tower (est. ' + TOWER_FALLBACK_HITS_PER_ENERGY + ' hits/e)';
    console.log('  - ' + r.name +
      ': creep ' + r.info.totalEptCreep +
      ' (' + dailyCost(r.info.totalEptCreep) + '/day)' +
      ' | ' + towerLabel + ' ' + r.info.totalEptTower +
      ' (' + dailyCost(r.info.totalEptTower) + '/day)' +
      ' en/tick (structures ' + r.info.count + ')');

    var types = [];
    for (var tk in r.info.types) {
      types.push({
        key:      tk,
        eptCreep: r.info.types[tk].eptCreep,
        eptTower: r.info.types[tk].eptTower,
        count:    r.info.types[tk].count
      });
    }
    types.sort(function(a, b) { return b.eptCreep - a.eptCreep; });

    for (var j = 0; j < types.length; j++) {
      var t = types[j];
      console.log('      - ' + t.key +
        ': creep ' + t.eptCreep +
        ' (' + dailyCost(t.eptCreep) + '/day)' +
        ' | tower ' + t.eptTower +
        ' (' + dailyCost(t.eptTower) + '/day)' +
        ' en/tick (count ' + t.count + ')');
    }
  }
}

function print(filterRoom) {
  if (filterRoom) {
    var room = Game.rooms[filterRoom];
    if (!room) {
      console.log('[maint-scan] ' + filterRoom + ' not visible. Use scanRoom(\'' + filterRoom + '\') to observe it.');
      return;
    }
    var summary = { totalEptCreep: 0, totalEptTower: 0, rooms: {} };
    scanRoomStructures(room, filterRoom, function(rn, tk, eptCreep, eptTower, towerExact) {
      if (!summary.rooms[rn]) summary.rooms[rn] = { totalEptCreep: 0, totalEptTower: 0, towerExact: false, count: 0, types: {} };
      summary.rooms[rn].totalEptCreep += eptCreep;
      summary.rooms[rn].totalEptTower += eptTower;
      if (towerExact) summary.rooms[rn].towerExact = true;
      summary.rooms[rn].count += 1;
      if (!summary.rooms[rn].types[tk]) summary.rooms[rn].types[tk] = { eptCreep: 0, eptTower: 0, count: 0 };
      summary.rooms[rn].types[tk].eptCreep += eptCreep;
      summary.rooms[rn].types[tk].eptTower += eptTower;
      summary.rooms[rn].types[tk].count += 1;
      summary.totalEptCreep += eptCreep;
      summary.totalEptTower += eptTower;
    });
    printSummary(roundSummary(summary));
    return;
  }
  printSummary(scan());
}

// ─── scanRoom with observer fallback ─────────────────────────────────────────

/**
 * scanRoom('W1N1')
 *
 * One command does everything. If the room is already visible, scans and
 * prints immediately. If not, queues an observation — processPendingMaintScan()
 * running in the main loop auto-completes the scan next tick and wipes memory.
 * You never need to call scanRoom() a second time.
 *
 * Observer fallback chain:
 *   1. Structural observer within 10 rooms (auto-completes next tick)
 *   2. Operator with PWR_OPERATE_OBSERVER (~3 tick delay)
 *   3. Error: manual scout required
 */
function scanRoom(roomName) {
  if (!roomName || typeof roomName !== 'string') {
    return '[maint-scan] Usage: scanRoom("W1N1")';
  }

  if (!Memory.maintScan)         Memory.maintScan         = {};
  if (!Memory.maintScan.pending) Memory.maintScan.pending = {};

  var room = Game.rooms[roomName];

  // ── Room is visible — scan, print, wipe, done ─────────────────────────
  if (room) {
    wipePending(roomName);
    print(roomName);
    return null;
  }

  // ── Fallback 1: structural observer within 10 rooms ───────────────────
  var observer = findObserverInRange(roomName);
  if (observer) {
    var obsResult = observer.observeRoom(roomName);
    if (obsResult === OK) {
      setPending(roomName, { tick: Game.time, observerRoom: observer.room.name });
      return '[maint-scan] 🔭 observing ' + roomName + ' from ' + observer.room.name + ' — auto-completing next tick';
    }
    console.log('[maint-scan] Observer in ' + observer.room.name + ' failed: code ' + obsResult);
  }

  // ── Fallback 2: operator with PWR_OPERATE_OBSERVER ────────────────────
  try {
    var roleOperator = require('roleOperator');
    if (roleOperator && typeof roleOperator.findPowerObserver === 'function') {
      var po = roleOperator.findPowerObserver(roomName);
      if (po) {
        if (!Memory.maintScan.powerObs) Memory.maintScan.powerObs = {};
        Memory.maintScan.powerObs[roomName] = {
          operatorName: po.operatorName,
          operatorRoom: po.operatorRoom,
          tick:         Game.time
        };
        setPending(roomName, { tick: Game.time, observerRoom: po.operatorRoom, poweredObserver: true });
        return '[maint-scan] 🔭⚡ PWR_OPERATE_OBSERVER requested from ' + po.operatorName +
               ' (' + po.operatorRoom + ') — auto-completing when ' + roomName + ' is visible';
      }
    }
  } catch (e) { /* roleOperator unavailable */ }

  // ── Fallback 3: no option ─────────────────────────────────────────────
  return '[maint-scan] ERROR: ' + roomName + ' not visible, no observer in range, no operator available — send a scout';
}

// ─── Auto-complete pending observations ──────────────────────────────────────

/**
 * Call once per tick from main.js:
 *   const maint = require('maintenanceScanner');
 *   maint.processPendingMaintScan();
 *
 * When an observer was queued last tick, room visibility is available this
 * tick — auto-fires the scan, prints results, and wipes memory.
 * Also cleans up stale entries that never resolved.
 */
function processPendingMaintScan() {
  if (!Memory.maintScan || !Memory.maintScan.pending) return;

  for (var roomName in Memory.maintScan.pending) {
    var pending = Memory.maintScan.pending[roomName];
    var age     = Game.time - pending.tick;

    if (Game.rooms[roomName]) {
      console.log('[maint-scan] 🔭 Auto-completing scan for ' + roomName +
        ' (observed from ' + pending.observerRoom + ')');
      wipePending(roomName);
      print(roomName);

    } else if (pending.poweredObserver) {
      // PWR_OPERATE_OBSERVER can take a few ticks — clean up if stale (100 ticks)
      var poReq = Memory.maintScan.powerObs && Memory.maintScan.powerObs[roomName];
      if (poReq && Game.time - poReq.tick > 100) {
        console.log('[maint-scan] ⚠️  Power-observe timed out for ' + roomName + ' after 100 ticks. Clearing.');
        wipePending(roomName);
      }

    } else if (age >= 5) {
      console.log('[maint-scan] ⚠️  Timed out waiting for visibility of ' + roomName +
        ' after ' + age + ' ticks. Clearing.');
      wipePending(roomName);
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  scan:                    scan,
  print:                   print,
  scanRoom:                scanRoom,
  processPendingMaintScan: processPendingMaintScan
};

if (typeof global !== 'undefined') {
  global.maintScan     = function()         { return print(); };
  global.maintScanRoom = function(roomName) { return scanRoom(roomName); };
}