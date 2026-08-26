// LLM: Read docs/codex.js before reviewing or changing this file.
// scanner.js
// Console globals: maintScan, maintScanRoom, intel, intelFast, listIntel, getCachedIntel, nukeAnalyze, nukeAnalyzeSelf, nukeAnalyzeCost, nukeIncoming, nukeThreat, nukeThreatStatus, nukeThreatCancel, player, playerCancel, playerStatus, playerLast, playerScan, playerScanStatus, playerScanCancel, wideScan, wideScanPlayers, wideScanCancel, wideScanStatus, warEstimate, warEstimateCancel, warEstimateStatus, warEstimateLast, registrySweep, registryStatus, registryPlayer, registryList, monitor, monitorAdd, monitorRemove, monitorSetStatus, monitorStatus, monitorPause, monitorResume, monitorUpdateRooms, profileEnergy, cancelEnergyProfile, energyProfileStatus
// Example: maintScan('W1N1') - Trigger maintenance scan for room
// Example: maintScanRoom('W1N1') - Run deep maintenance scan on specific room
// Example: intel('W1N1') - Display cached intel report for room
// Example: intelFast('W1N1') - Quick memory-only intel query for room
// Example: listIntel() - List all rooms with recorded intel
// Example: getCachedIntel('W1N1') - Retrieve raw cached intel object
// Example: nukeAnalyze('W1N1') - Run nuke vulnerability analysis on room
// Example: nukeAnalyzeSelf() - Run nuke threat analysis on all owned rooms
// Example: nukeAnalyzeCost('W1N1') - Estimate repair and energy cost of nuclear strike
// Example: nukeIncoming() - Check for detected incoming nuclear strikes
// Example: nukeThreat() - Display current empire-wide nuclear threat assessment
// Example: nukeThreatStatus() - View status of continuous nuclear threat monitor
// Example: nukeThreatCancel() - Stop continuous nuclear threat monitor
// Example: player('PlayerName') - Display intel and threat assessment for player
// Example: playerCancel('PlayerName') - Cancel active tracking or scan for player
// Example: playerStatus() - Show status of active player intel scans
// Example: playerLast('PlayerName') - Show last seen timestamp and rooms for player
// Example: playerScan('PlayerName') - Start deep scan of player territory and rooms
// Example: playerScanStatus() - View progress of active player scan
// Example: playerScanCancel() - Cancel active player scan
// Example: wideScan('W1N1', 5) - Run multi-room sector reconnaissance scan
// Example: wideScanPlayers() - Run wide scan searching for player colonies
// Example: wideScanCancel() - Cancel active wide-area scan
// Example: wideScanStatus() - View progress of active wide scan
// Example: warEstimate('PlayerName') - Calculate war cost and combat balance estimate
// Example: warEstimateCancel() - Cancel active war estimate calculation
// Example: warEstimateStatus() - View progress of war estimation job
// Example: warEstimateLast() - Display results of latest war estimate
// Example: registrySweep() - Sweep and prune expired player registry records
// Example: registryStatus() - Display status of player and room registry
// Example: registryPlayer('PlayerName') - Inspect registry data for specific player
// Example: registryList() - List all registered players and relationships
// Example: monitor('W1N1') - Inspect defense and observer monitor for room
// Example: monitorAdd('W1N1') - Add room to active observer monitoring list
// Example: monitorRemove('W1N1') - Remove room from active observer monitoring list
// Example: monitorSetStatus('W1N1', 'active') - Set monitor tracking status for room
// Example: monitorStatus() - Display status of all actively monitored rooms
// Example: monitorPause() - Pause observer monitoring loop
// Example: monitorResume() - Resume observer monitoring loop
// Example: monitorUpdateRooms() - Refresh list of rooms under active monitoring
// Example: profileEnergy('W1N1') - Start background energy flow profiler for room
// Example: cancelEnergyProfile('W1N1') - Stop energy flow profiler for room
// Example: energyProfileStatus() - View status of energy profiling sessions
/**
 * scanner.js — Unified scanning and intelligence module.
 * Consolidates: maintenanceScanner, roomIntel, nukeAnalyze, playerAnalysis,
 * wideScan, warEstimate, playerMonitor, observer scheduler, room registry.
 *
 * Usage: call the scan globals below from the Screeps console.
 * Example: intel('W1N1'); nukeIncoming();
 *
 * MAINTENANCE SCANNER
 *   maintScan()  Energy/tick decay + workforce body cost (snapshot and
 *     per-day replacement by TTL) for every visible room's owner. Columns:
 *     creep repair cost, tower repair cost per structure type.
 *   maintScanRoom('W1N1')  One room; observer/PWR_OPERATE_OBSERVER fallback
 *     if not visible, auto-completes next tick via scanner.run().
 *
 * ROOM INTEL
 *   intel('W1N1')  Full report; auto-starts a 100-tick efficiency profile
 *     and prints on completion. Observer fallback. Scores: Defense 30%,
 *     Offense 20%, Economy 20%, Infrastructure 20% (Operations separate).
 *   intelFast('W1N1')  Instant snapshot, legacy blend: Economy 25%,
 *     Military 30%, Infrastructure 45%.
 *   listIntel()  Rooms with active or cached profiles.
 *   getCachedIntel('W1N1')  Cached profile or null if missing/expired; with
 *     no argument, {room, completedTick, expiresTick} for every live profile.
 *
 * NUKE ANALYSIS
 *   nukeAnalyze('W1N1')                Best single strike position.
 *   nukeAnalyze('W1N1', 3)             Greedy best-3 strike combination.
 *   nukeAnalyzeSelf()                  Analyze every room you own.
 *   nukeAnalyzeCost('W1N1', x, y)      Cost report for one coordinate.
 *   nukeAnalyzeCost('W1N1', [{x,y}])   Multi-strike stacked-damage report.
 *   nukeIncoming() / nukeIncoming('W1N1')  FIND_NUKES, all rooms or one.
 *   nukeThreat('W1N1')       10-room hostile-nuker radius scan; tests
 *     whether they can kill key structures.
 *   nukeThreatStatus/nukeThreatCancel('W1N1')  Progress / cancel.
 *   All use observer/PWR_OPERATE_OBSERVER fallback and auto-complete.
 *
 * PLAYER ANALYSIS
 *   player('PlayerName')  Phase 1 scans observer range for bases, phase 2
 *     gathers intel on each. Report: Defense/Offense/Eco/Infrastructure
 *     scores, nuke threat matrix, strike capability, recommendations.
 *     Game.notify summary on completion.
 *   playerStatus() / playerCancel() / playerLast()  Progress, cancel,
 *     reprint last report (10k tick TTL).
 *   playerScan('Name','CREEPCOUNT')  Creep census: Military (ATTACK/
 *     RANGED_ATTACK/HEAL parts), Worker (>25% WORK), Supplier (<10% WORK,
 *     hauler), Claimer (CLAIM), Scout (100% MOVE), Other (10-25% WORK).
 *   playerScanStatus() / playerScanCancel()  Progress / cancel.
 *
 * ROOM REGISTRY (sweep-based)
 *   registrySweep()  Force a sweep of every claimable room in observer
 *     range now (highways/SK/sector centers skipped, never player-owned).
 *     Runs automatically every REG_SWEEP_INTERVAL ticks on leftover
 *     observer capacity.
 *   registryStatus()  Sweep progress / registry age / room count.
 *   registryList() / registryPlayer('Name')  Every player + rooms, or one
 *     player's rooms with RCL + age.
 *
 * WIDE SCAN (registry views)
 *   wideScan('PlayerName')  Rooms owned by player; instant if registry
 *     fresh, else starts a sweep and prints on completion.
 *   wideScanPlayers()  Every player in observer range.
 *   wideScanStatus() / wideScanCancel()  Sweep progress / cancel report
 *     (sweep continues).
 *
 * PLAYER MONITOR
 *   monitor('Player', 'WAR')              Assign status, alerts on.
 *   monitor('Player', 'ALLY', ['rooms'])  Assign status + seed rooms.
 *   monitor('Player')                     Defaults to ENEMY.
 *   monitorSetStatus('Player', 'WAR')     Change status.
 *   monitorAdd('Player', ['rooms'], 'WAR')  Seed registry rooms; optional
 *     3rd arg assigns/changes status (arg order reversed vs monitor()).
 *   monitorRemove('Player')   Clear status (registry keeps tracking rooms;
 *     only critical unmonitored alerts remain).
 *   monitorStatus()            Statuses, rooms, staleness.
 *   monitorPause()/monitorResume()  Pause/resume alerts + hot polls.
 *   The sweep tracks every claimable room regardless of status; status only
 *   controls alert filtering and hot-poll rate: ALLY/NEUTRAL/ENEMY every
 *   1000 ticks, WAR every 100. Unstatused players keep alerts only for
 *   ownership changes, safe mode, nuker readiness, incoming nukes; remote-
 *   supply rooms also keep the operational fields remoteSupplyManager needs.
 *   Alerts by status: all — RCL_UPGRADED/DOWNGRADED, ROOM_LOST, NO_CREEPS,
 *   SPAWNS_DRAINED, TOWERS_EMPTY, SAFE_MODE, NEW_ROOM; NEUTRAL+ — NUKER_BUILT,
 *   NUKER_FILLING_G/E, MILITARY_CREEPS, BOOSTED_CREEPS; ENEMY+ —
 *   POWER_DETECTED; WAR only — TERMINAL_G.
 *
 * PLAYER STATUS BOARD
 *   status('PlayerName')  (global lives in statusReport.js) Observer-
 *     snapshots every registry room the player owns, one room per observer
 *     per tick at one-shot priority, then prints a status()-style board:
 *     energy, storage, creep census emoji, RCL % + ETA, threat flags. ETA
 *     needs two anchors >=100t apart, appears from the second scan on.
 *     Re-run mid-scan to see progress. Plain status() still shows the
 *     colony report.
 *
 * WAR ESTIMATE
 *   warEstimate('PlayerName')  Five phases: 1 Discovery (registry, sweep if
 *     stale, skipped if fresh player() data exists), 2 Intel (observe each
 *     room, full 5x5 nuke sweep), 3 Monitor (10 snapshots at 1k-tick
 *     intervals), 4 Compute (6 categories x 3 horizons), 5 Notify (chunked
 *     Game.notify). Categories: Force Projection 20%, Spawn Throughput 20%,
 *     Attrition 20%, Boost Capacity 15%, Defensive Depth 15%, Multi-Front
 *     Strain 10%.
 *   warEstimateStatus/Cancel/Last()  Progress, cancel, last report (2k TTL).
 *
 * OBSERVER SCHEDULER
 *   All observer use flows through one tick-scoped booking set
 *   (global.__obsUsed) so no two consumers fire the same observer in the
 *   same tick. Dispatched at the top of scanner.run() by priority:
 *   p~100 one-shot console commands (intel/nuke/maint) > p=80 WAR hot polls
 *   (100t) > p=55-60 depositObserver requests > p=50 ENEMY/NEUTRAL/ALLY hot
 *   polls (1000t) > sweep fills whatever's still idle at the end, lowest
 *   priority. External modules request with
 *   require('scanner').observe.request(roomName, 'src', priority) and wait
 *   for Game.rooms[roomName]; adaptive consumers pass {untilConsumed:true,
 *   holdTicks:N}, persist their result, then observe.consume(roomName,
 *   'src'). Requests persist until fulfilled, consumed, or timed out.
 *   Multi-tick scans (playerAnalysis, warEstimate) still pace one room per
 *   tick but book through the shared set and retry instead of dropping
 *   rooms when their observer was taken.
 *
 * MEMORY KEYS
 *   Memory.maintScan, heap.roomEffProfile (heap; lost on reset),
 *   Memory.roomEffCache, roomIntelPending, intelPowerObserve,
 *   nukeAnalyzePending, nukeThreatScans, nukeThreatPowerObserve,
 *   playerAnalysis, playerScan, lastPlayerAnalysis, warEstimate,
 *   lastWarEstimate, obsSched, roomRegistry, wideScanReport, playerMonitor,
 *   playerStatusScan, playerStatusAnchors.
 */
"use strict";
let _isFriendlyUsername;
try {
  const e = require("iff");
  _isFriendlyUsername = e && typeof e.isFriendlyUsername === "function" ? t => e.isFriendlyUsername(t) : () => false;
} catch (e) {
  _isFriendlyUsername = () => false;
}
const util = require("util");
const memoryManager = require("memoryManager");
const heap = memoryManager.heap;
const storage = memoryManager.storage;
storage.register("scanner.schedule", {
  path: "Memory.scannerSchedule",
  owner: "scanner.js",
  mutability: "mutable"
});
const OBSERVER_RANGE = 10;
const NUKE_RANGE = 10;
const SUPPORT_RANGE = 6;
const TOWER_ENERGY_COST = 10;
const TOWER_MAX_REPAIR = 800;
const TOWER_MIN_REPAIR = 200;
const TOWER_OPTIMAL_RANGE = 5;
const TOWER_FALLOFF_RANGE = 20;
const TOWER_FALLBACK_HPE = 40;
const CREEP_REPAIR_HITS = 100;
const NUKE_DIRECT_DAMAGE = 1e7;
const NUKE_AREA_DAMAGE = 5e6;
const NUKE_ENERGY_COST_CONST = 3e5;
const NUKE_GHODIUM_COST = 5e3;
const REPAIR_HITS_PER_ENERGY = 100;
const ROAD_PLAIN_DPT = .1;
const ROAD_SWAMP_DPT = .5;
const RAMPART_DPT = 3;
const CONTAINER_OWNED_DPT = 10;
const CONTAINER_UNOWNED_DPT = 50;
const NUKE_BUILD_COST = {
  spawn: 15e3,
  extension: 3e3,
  road: 300,
  wall: 1,
  rampart: 1,
  link: 5e3,
  storage: 3e4,
  tower: 5e3,
  observer: 8e3,
  powerSpawn: 1e5,
  extractor: 5e3,
  lab: 5e4,
  terminal: 1e5,
  container: 5e3,
  nuker: 1e5,
  factory: 1e5
};
const STRUCT_COST_MAP = {};
const INTEL_W = {
  defense: .3,
  offense: .2,
  economy: .2,
  infrastructure: .2,
  operations: .1
};
const INTEL_W_COMPOSITE_TOTAL = INTEL_W.defense + INTEL_W.offense + INTEL_W.economy + INTEL_W.infrastructure;
const INTEL_W_FAST = {
  economic: .25,
  military: .3,
  infrastructure: .45
};
const INTEL_DEFENSE_RAW_MAX = 62;
const INTEL_OFFENSE_RAW_MAX = 47;
const INTEL_PROFILE_TICKS = 100;
const INTEL_EFF_EXPIRE = 5e3;
const INTEL_EFF_MEM_KEY = "roomEffProfile";
const INTEL_EFF_CACHE_KEY = "roomEffCache";
const INTEL_EFF_GLOBAL_PREV = "__effPrev";
const INTEL_EXT_BY_RCL = {
  0: 0,
  1: 0,
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60
};
const INTEL_SPWN_BY_RCL = {
  0: 0,
  1: 1,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 2,
  8: 3
};
const CREEP_LIFE_TIME = 1500;
const INTEL_COMBAT_BOOSTS = [ "UH", "UH2O", "XUH2O", "KO", "KHO2", "XKHO2", "LO", "LHO2", "XLHO2" ];
const ENERGY_PROFILE_TICKS = 1500;
const ENERGY_EFF_EXPIRE = 5e3;
const ENERGY_EFF_MEM_KEY = "energyEffProfile";
const ENERGY_EFF_CACHE_KEY = "energyEffCache";
const ENERGY_EFF_GLOBAL_PREV = "__energyPrev";
const ENERGY_PENDING_KEY = "energyEffPending";
const ENERGY_POWER_OBS_KEY = "energyEffPowerObs";
const ENERGY_LOG_INTERVAL = 250;
const ENERGY_NOTIFY_TOTAL_MAX = 455;
const ENERGY_NOTIFY_PER_TICK = 10;
const ENERGY_NOTIFY_HEADER_MAX = 50;
const ENERGY_SIMILARITY_THRESHOLD = .5;
const ENERGY_ROOM_NAME_RE = /^[WE]\d+[NS]\d+$/;
const ENERGY_BOX_DROP_RE = /^[\s\u2500\u2508\u2550\u2569\u256C]+$/;
const EV_HARVEST = 5, EV_HEAL = 6, EV_REPAIR = 7, EV_BUILD = 4, EV_TRANSFER = 12, EV_ATTACK = 1, EV_POWER = 11, EV_UPGRADE_CONTROLLER = 9, EV_ATTACK_CONTROLLER = 3, EV_RESERVE_CONTROLLER = 8;
function _bpCostOf(e) {
  return util.bodyCost(e);
}

function _bpTTL(e) {
  const t = e && e.length ? e.length : 0;
  return Math.max(1, CREEP_LIFE_TIME + t * 150);
}

function _bpHasWork(e) {
  for (const t of e) if ((t.type || t) === WORK) return true;
  return false;
}

function _bpSig(e) {
  const t = {};
  for (const o of e) {
    const e = o.type || o;
    t[e] = (t[e] || 0) + 1;
  }
  const o = {
    work: "W",
    carry: "C",
    move: "M",
    attack: "A",
    ranged_attack: "R",
    heal: "H",
    claim: "L",
    tough: "T"
  };
  let n = "";
  for (const e of [ WORK, CARRY, MOVE, ATTACK, RANGED_ATTACK, HEAL, CLAIM, TOUGH ]) if (t[e]) n += t[e] + o[e];
  return n;
}

function _bpInferRole(e) {
  const t = {};
  for (const o of e) t[o.type || o] = (t[o.type || o] || 0) + 1;
  const o = t.work || 0;
  const n = t.carry || 0;
  const r = (t.attack || 0) + (t.ranged_attack || 0);
  const s = t.heal || 0;
  const a = t.claim || 0;
  if (a) return "claimer";
  if (r) return "attacker";
  if (s) return "healer";
  if (o === 0 && n === 0) return "scout";
  if (o >= 5 && n <= 1) return "static-miner";
  if (o === 0 && n >= 5) return "hauler";
  if (n === 0 && o > 0) return "worker-no-carry";
  if (o > 0 && n > 0) return "worker";
  return "unknown";
}

const PA_THRESHOLDS = {
  weak: 40,
  strong: 70
};
const PA_SCAN_TYPES = [ "CREEPCOUNT" ];
const WE_NOTIFY_TOTAL_MAX = 455;
const WE_NOTIFY_PER_TICK = 10;
const WE_MONITOR_SAMPLES = 10;
const WE_MONITOR_INTERVAL = 1e3;
const TICKS_PER_DAY = 28800;
const COMBAT_BOOSTS_ATK = [ "UH", "UH2O", "XUH2O" ];
const COMBAT_BOOSTS_RNG = [ "KO", "KHO2", "XKHO2" ];
const COMBAT_BOOSTS_HEAL = [ "LO", "LHO2", "XLHO2" ];
const COMBAT_BOOSTS_TUFF = [ "GO", "GHO2", "XGHO2" ];
const ALL_COMBAT_BOOSTS = [ ...COMBAT_BOOSTS_ATK, ...COMBAT_BOOSTS_RNG, ...COMBAT_BOOSTS_HEAL, ...COMBAT_BOOSTS_TUFF ];
const T3_BOOSTS = [ "XUH2O", "XKHO2", "XLHO2", "XGHO2", "XZH2O", "XZHO2", "XKH2O", "XLH2O", "XGH2O", "XUHO2" ];
const BASE_MINERALS = [ "H", "O", "U", "L", "K", "Z", "X", "G" ];
const HIGHWAY_DEPOSITS = [ "metal", "biomass", "silicon", "mist" ];
const COMPRESSED_COMMODITIES = [ "utrium_bar", "lemergium_bar", "zynthium_bar", "keanium_bar", "ghodium_melt", "oxidant", "reductant", "purifier", "battery" ];
const REGIONAL_COMMODITIES = [ "wire", "cell", "alloy", "condensate" ];
const LEVEL_COMMODITIES = [ "composite", "crystal", "liquid", "switch", "phlegm", "tube", "concentrate", "transistor", "tissue", "fixtures", "extract", "microchip", "muscle", "frame", "spirit", "circuit", "organoid", "hydraulics", "emanation", "device", "organism", "machine", "essence" ];
const LAB_PRODUCTS_LIST = [ "OH", "ZK", "UL", "UH", "UO", "KH", "KO", "LH", "LO", "ZH", "ZO", "GH", "GO", "UH2O", "UHO2", "KH2O", "KHO2", "LH2O", "LHO2", "ZH2O", "ZHO2", "GH2O", "GHO2", "XUH2O", "XUHO2", "XKH2O", "XKHO2", "XLH2O", "XLHO2", "XZH2O", "XZHO2", "XGH2O", "XGHO2" ];
const WE_CAT_WEIGHTS = {
  forceProjection: .2,
  spawnThroughput: .2,
  attrition: .2,
  boostCapacity: .15,
  defensiveDepth: .15,
  multiFrontStrain: .1
};
const WE_CAPS = {
  spawnsInTheater: 18,
  towersInTheater: 36,
  roomsInSupport: 10,
  warChest: 2e7,
  incomePerTick: 120,
  economicTiers: 8,
  marketScore: 25,
  burnRate: 800,
  terminalDepth: 10,
  combatBoosts: 6e4,
  labCount: 10,
  baseMineralTypes: 8,
  repairPerTick: 4800,
  wallHPMedian: 1e9,
  safeModeTicks: 1e5,
  maxRoomSpread: 30,
  energyCap: 12300,
  activeSpawns: 18
};
const WE_W = {
  forceProjection: {
    short: {
      distance: .15,
      spawnsSupport: .2,
      towersTheater: .15,
      terminalRelay: .2,
      nukeOverlap: .1,
      roomsSupport: .2
    },
    medium: {
      distance: .1,
      spawnsSupport: .18,
      towersTheater: .12,
      terminalRelay: .22,
      nukeOverlap: .15,
      roomsSupport: .23
    },
    long: {
      distance: .08,
      spawnsSupport: .12,
      towersTheater: .08,
      terminalRelay: .25,
      nukeOverlap: .2,
      roomsSupport: .27
    }
  },
  spawnThroughput: {
    short: {
      energyCap: .2,
      activeSpawns: .25,
      extensionFill: .15,
      operatorBoost: .15,
      creepsPer100: .25
    },
    medium: {
      energyCap: .2,
      activeSpawns: .2,
      extensionFill: .15,
      operatorBoost: .18,
      creepsPer100: .27
    },
    long: {
      energyCap: .15,
      activeSpawns: .15,
      extensionFill: .1,
      operatorBoost: .2,
      creepsPer100: .4
    }
  },
  attrition: {
    short: {
      warChest: .25,
      baseIncome: .08,
      econProduction: .05,
      tradeLiquidity: .07,
      burnRate: .18,
      terminalDepth: .12,
      mineralPressure: .1,
      depletion: .15
    },
    medium: {
      warChest: .12,
      baseIncome: .1,
      econProduction: .15,
      tradeLiquidity: .1,
      burnRate: .15,
      terminalDepth: .18,
      mineralPressure: .08,
      depletion: .12
    },
    long: {
      warChest: .05,
      baseIncome: .08,
      econProduction: .25,
      tradeLiquidity: .12,
      burnRate: .12,
      terminalDepth: .2,
      mineralPressure: .06,
      depletion: .12
    }
  },
  boostCapacity: {
    short: {
      stockpile: .3,
      tierDistribution: .15,
      labCapacity: .1,
      baseMinerals: .1,
      replenishment: .1,
      defensiveBoosts: .25
    },
    medium: {
      stockpile: .15,
      tierDistribution: .12,
      labCapacity: .2,
      baseMinerals: .18,
      replenishment: .2,
      defensiveBoosts: .15
    },
    long: {
      stockpile: .08,
      tierDistribution: .1,
      labCapacity: .25,
      baseMinerals: .22,
      replenishment: .25,
      defensiveBoosts: .1
    }
  },
  defensiveDepth: {
    short: {
      repairThroughput: .2,
      wallHPPool: .15,
      safeModeInventory: .25,
      towerSustain: .15,
      gclHeadroom: .05,
      rebuildCapacity: .05,
      controllerFort: .15
    },
    medium: {
      repairThroughput: .18,
      wallHPPool: .2,
      safeModeInventory: .15,
      towerSustain: .2,
      gclHeadroom: .1,
      rebuildCapacity: .07,
      controllerFort: .1
    },
    long: {
      repairThroughput: .12,
      wallHPPool: .15,
      safeModeInventory: .1,
      towerSustain: .2,
      gclHeadroom: .18,
      rebuildCapacity: .15,
      controllerFort: .1
    }
  },
  multiFrontStrain: {
    short: {
      spawnAllocation: .2,
      terminalBandwidth: .15,
      geoSpread: .2,
      reserveRooms: .1,
      perFrontRatio: .25,
      ownStrain: .1
    },
    medium: {
      spawnAllocation: .18,
      terminalBandwidth: .2,
      geoSpread: .18,
      reserveRooms: .15,
      perFrontRatio: .18,
      ownStrain: .11
    },
    long: {
      spawnAllocation: .15,
      terminalBandwidth: .22,
      geoSpread: .15,
      reserveRooms: .22,
      perFrontRatio: .13,
      ownStrain: .13
    }
  }
};
const OBS_PRI = {
  ONESHOT: 100,
  WAR: 80,
  DEPOSIT: 60,
  MONITOR: 50,
  SWEEP: 10
};
const OBS_REQ_TIMEOUT = 100;
const REG_SWEEP_INTERVAL = 2e3;
const REG_FRESH_TICKS = 2e4;
const REG_SWEEP_TIMEOUT = 8e3;
const SCAN_BACKGROUND_INTERVAL = 5;
const SCAN_IDLE_INTERVAL = 25;
const STATUS = {
  ALLY: "ALLY",
  NEUTRAL: "NEUTRAL",
  ENEMY: "ENEMY",
  WAR: "WAR"
};
const POLL_INTERVAL = {
  ALLY: 1e3,
  NEUTRAL: 1e3,
  ENEMY: 1e3,
  WAR: 100
};
const NOTIFY_COOLDOWN = 30;
const MON_AWAIT_TIMEOUT = 200;
const MON_SCHEMA_VERSION = 3;
const UNMONITORED_ALERTS = [ "NEW_ROOM", "ROOM_LOST", "NUKER_READY", "NUKE_INCOMING", "SAFE_MODE" ];
const ALERT_FILTER = {
  ALLY: [ "RCL_UPGRADED", "RCL_DOWNGRADED", "ROOM_LOST", "NO_CREEPS", "SPAWNS_DRAINED", "TOWERS_EMPTY", "SAFE_MODE", "NEW_ROOM", "NUKER_READY", "NUKE_INCOMING" ],
  NEUTRAL: [ "RCL_UPGRADED", "RCL_DOWNGRADED", "ROOM_LOST", "NO_CREEPS", "SPAWNS_DRAINED", "TOWERS_EMPTY", "SAFE_MODE", "NEW_ROOM", "NUKER_BUILT", "NUKER_FILLING_G", "NUKER_FILLING_E", "NUKER_READY", "NUKE_INCOMING", "MILITARY_CREEPS", "BOOSTED_CREEPS" ],
  ENEMY: null,
  WAR: null
};
const parseRoomCoords = util.parseRoomXY;
const toRoomName = util.roomNameFromXY;
function roomsInRange(e, t) {
  const o = parseRoomCoords(e);
  if (!o) return [];
  const n = [];
  for (let e = -t; e <= t; e++) for (let r = -t; r <= t; r++) n.push(toRoomName(o.x + e, o.y + r));
  return n;
}

const getRoomDistance = util.roomChebyshevDistance;
function canNuke(e, t) {
  return getRoomDistance(e, t) <= NUKE_RANGE;
}

function avgDistanceBetweenRooms(e) {
  if (e.length < 2) return 0;
  let t = 0, o = 0;
  for (let n = 0; n < e.length; n++) for (let r = n + 1; r < e.length; r++) {
    t += getRoomDistance(e[n], e[r]);
    o++;
  }
  return o > 0 ? t / o : 0;
}

function isClaimableRoom(e) {
  if (!/^[WE]\d+[NS]\d+$/.test(e)) return false;
  return util.isClaimableRoomCoord(e);
}

function _tickUsedSet() {
  if (!global.__obsUsed || global.__obsUsed.tick !== Game.time) global.__obsUsed = {
    tick: Game.time,
    set: new Set
  };
  return global.__obsUsed.set;
}

function _tickObserve(e, t) {
  const o = _tickUsedSet();
  if (!e || o.has(e.id)) return false;
  if (e.observeRoom(t) === OK) {
    o.add(e.id);
    return true;
  }
  return false;
}

function getObserverMap() {
  if (global.__obsMapCache && global.__obsMapCache.tick === Game.time) {
    return global.__obsMapCache.map;
  }
  const e = {};
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (!o.controller || !o.controller.my) continue;
    const n = o.find(FIND_MY_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_OBSERVER && (typeof e.isActive !== "function" || e.isActive())
    })[0];
    if (n) e[t] = n;
  }
  global.__obsMapCache = {
    tick: Game.time,
    map: e
  };
  return e;
}

function findObserverInRange(e, t) {
  const o = parseRoomCoords(e);
  if (!o) return null;
  const n = getObserverMap();
  let r = null, s = Infinity;
  for (const e in n) {
    const a = n[e];
    if (t && t.has(a.id)) continue;
    const i = parseRoomCoords(e);
    if (!i) continue;
    const l = Math.max(Math.abs(o.x - i.x), Math.abs(o.y - i.y));
    if (l <= OBSERVER_RANGE && l < s) {
      r = a;
      s = l;
    }
  }
  return r;
}

function findObserversInRange(e) {
  const t = parseRoomCoords(e);
  if (!t) return [];
  const o = getObserverMap();
  const n = [];
  for (const e in o) {
    const r = parseRoomCoords(e);
    if (!r) continue;
    const s = Math.max(Math.abs(t.x - r.x), Math.abs(t.y - r.y));
    if (s <= OBSERVER_RANGE) n.push({
      obs: o[e],
      dist: s
    });
  }
  n.sort((e, t) => e.dist - t.dist);
  return n.map(e => e.obs);
}

function findObserverForRoom(e, t) {
  const o = parseRoomCoords(e);
  if (!o) return null;
  for (const e in t) {
    const n = parseRoomCoords(e);
    if (n && Math.max(Math.abs(o.x - n.x), Math.abs(o.y - n.y)) <= OBSERVER_RANGE) return t[e];
  }
  return null;
}

function findAllObserversForRoom(e, t) {
  const o = parseRoomCoords(e);
  if (!o) return [];
  return Object.entries(t).filter(([e]) => {
    const t = parseRoomCoords(e);
    return t && Math.max(Math.abs(o.x - t.x), Math.abs(o.y - t.y)) <= OBSERVER_RANGE;
  }).map(([, e]) => e);
}

function tryObserveRoom(e, t) {
  const o = _tickUsedSet();
  let n = o;
  if (t && t.size > 0) {
    n = new Set(o);
    for (const e of t) n.add(e);
  }
  const r = findObserverInRange(e, n);
  if (!r) return false;
  if (r.observeRoom(e) === OK) {
    o.add(r.id);
    if (t) t.add(r.id);
    return true;
  }
  return false;
}

function tryPowerObserver(e) {
  try {
    const t = require("roleOperator");
    if (t && typeof t.findPowerObserver === "function") return t.findPowerObserver(e);
  } catch (e) {}
  return null;
}

function getMarketBuyPrice(e) {
  try {
    const t = require("marketPricing");
    if (e === RESOURCE_ENERGY) {
      const e = t.getStatusEnergyPrice();
      return e > 0 ? e : 0;
    }
    const o = t.getPriceProfile(e);
    return o && o.postedBuyPrice > 0 ? o.postedBuyPrice : 0;
  } catch (e) {
    return 0;
  }
}

function getMarketHistoryPrice(e) {
  try {
    const t = require("marketPricing").getAvg48h(e);
    return t !== null ? t : 0;
  } catch (e) {
    return 0;
  }
}

function fmtNum(e) {
  if (!e) return "0";
  if (e >= 1e6) return (e / 1e6).toFixed(1) + "M";
  if (e >= 1e3) return (e / 1e3).toFixed(1) + "k";
  return String(Math.round(e));
}

function fmtCr(e) {
  if (!e) return "0 cr";
  if (e >= 1e6) return (e / 1e6).toFixed(2) + "M cr";
  if (e >= 1e3) return (e / 1e3).toFixed(1) + "k cr";
  return Math.round(e) + " cr";
}

function fmtE(e) {
  return e >= 1e6 ? (e / 1e6).toFixed(2) + "M" : e >= 1e3 ? (e / 1e3).toFixed(1) + "k" : Math.round(e).toString();
}

function dailyCost(e) {
  return fmtE(e * TICKS_PER_DAY);
}

function r1(e) {
  return Math.round(e * 10) / 10;
}

function r2(e) {
  return Math.round(e * 100) / 100;
}

function r3(e) {
  return Math.round(e * 1e3) / 1e3;
}

function yn(e) {
  return e ? "Y" : "N";
}

function clamp(e) {
  return Math.max(0, Math.min(100, e));
}

function _itNormalizeRubric(e, t, o, n) {
  const r = 100 / n;
  const scaleEntries = e => Object.keys(e).reduce((t, o) => {
    t[o] = r1(e[o] * r);
    return t;
  }, {});
  return {
    score: r1(clamp(e * r)),
    positives: scaleEntries(t),
    negatives: scaleEntries(o)
  };
}

function _mtTowerHPE(e) {
  if (e <= TOWER_OPTIMAL_RANGE) return TOWER_MAX_REPAIR / TOWER_ENERGY_COST;
  if (e >= TOWER_FALLOFF_RANGE) return TOWER_MIN_REPAIR / TOWER_ENERGY_COST;
  const t = (e - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE);
  return (TOWER_MAX_REPAIR - t * (TOWER_MAX_REPAIR - TOWER_MIN_REPAIR)) / TOWER_ENERGY_COST;
}

function _mtTowerHPEForStruct(e, t) {
  if (!t || !t.length) return TOWER_FALLBACK_HPE;
  let o = Infinity;
  for (const n of t) {
    const t = Math.max(Math.abs(e.pos.x - n.pos.x), Math.abs(e.pos.y - n.pos.y));
    if (t < o) o = t;
  }
  return _mtTowerHPE(o);
}

function _mtIsTunnel(e) {
  if (typeof STRUCTURE_TUNNEL !== "undefined" && e.structureType === STRUCTURE_TUNNEL) return true;
  if (e.structureType === "tunnel") return true;
  return false;
}

function _mtCreepCost(e) {
  const t = e.controller && e.controller.owner;
  if (!t || !t.username) return null;
  const o = t.username;
  let n = 0, r = 0, s = 0, a = 0, i = 0;
  const l = {};
  function add(e, t) {
    const o = _bpCostOf(e);
    const l = _bpTTL(e);
    if (t) {
      r += o;
      a++;
    } else {
      n += o;
      s++;
    }
    i += o * (TICKS_PER_DAY / l);
  }
  for (const t of e.find(FIND_CREEPS)) {
    if (!t.owner || t.owner.username !== o) continue;
    add(t.body, !!t.spawning);
    l[t.name] = true;
  }
  for (const t of e.find(FIND_STRUCTURES, {
    filter: e => e.structureType === STRUCTURE_SPAWN && e.owner && e.owner.username === o && e.spawning && e.spawning.body && !l[e.spawning.name]
  })) {
    add(t.spawning.body, true);
  }
  return {
    owner: o,
    liveCost: n,
    spawningCost: r,
    liveCount: s,
    spawningCount: a,
    total: n + r,
    perDay: i
  };
}

function _mtScanRoom(e, t, o) {
  const n = e.find(FIND_STRUCTURES, {
    filter: e => e.structureType === STRUCTURE_TOWER
  });
  const r = n.length > 0;
  const s = !!(e.controller && e.controller.owner);
  const a = e.getTerrain();
  for (const i of e.find(FIND_STRUCTURES)) {
    const e = _mtTowerHPEForStruct(i, n);
    if (_mtIsTunnel(i)) {
      o(t, "tunnel", 15 / CREEP_REPAIR_HITS, 15 / e, r);
      continue;
    }
    if (i.structureType === STRUCTURE_ROAD) {
      const n = (a.get(i.pos.x, i.pos.y) & TERRAIN_MASK_SWAMP) === TERRAIN_MASK_SWAMP;
      const s = n ? ROAD_SWAMP_DPT : ROAD_PLAIN_DPT;
      o(t, n ? "road_swamp" : "road_plain", s / CREEP_REPAIR_HITS, s / e, r);
      continue;
    }
    if (i.structureType === STRUCTURE_RAMPART) {
      o(t, "rampart", RAMPART_DPT / CREEP_REPAIR_HITS, RAMPART_DPT / e, r);
      continue;
    }
    if (i.structureType === STRUCTURE_CONTAINER) {
      const n = s ? CONTAINER_OWNED_DPT : CONTAINER_UNOWNED_DPT;
      o(t, s ? "container_claimed" : "container_unclaimed", n / CREEP_REPAIR_HITS, n / e, r);
    }
  }
}

function _mtRound(e) {
  e.totalEptCreep = Math.round(e.totalEptCreep * 1e3) / 1e3;
  e.totalEptTower = Math.round(e.totalEptTower * 1e3) / 1e3;
  for (const t in e.rooms) {
    const o = e.rooms[t];
    o.totalEptCreep = Math.round(o.totalEptCreep * 1e3) / 1e3;
    o.totalEptTower = Math.round(o.totalEptTower * 1e3) / 1e3;
    for (const e in o.types) {
      o.types[e].eptCreep = Math.round(o.types[e].eptCreep * 1e3) / 1e3;
      o.types[e].eptTower = Math.round(o.types[e].eptTower * 1e3) / 1e3;
    }
  }
  return e;
}

function _mtAttachCreepCost(e, t, o) {
  const n = _mtCreepCost(o);
  if (!e.rooms[t]) e.rooms[t] = {
    totalEptCreep: 0,
    totalEptTower: 0,
    towerExact: false,
    count: 0,
    types: {}
  };
  e.rooms[t].creepCost = n;
  if (!n) return;
  e.totalCreepCost += n.total;
  e.totalCreepPerDay += n.perDay;
  e.totalCreepCount += n.liveCount;
  e.totalSpawningCreeps += n.spawningCount;
}

function _mtAdd(e, t, o, n, r, s) {
  if (!e.rooms[t]) e.rooms[t] = {
    totalEptCreep: 0,
    totalEptTower: 0,
    towerExact: false,
    count: 0,
    types: {}
  };
  const a = e.rooms[t];
  a.totalEptCreep += n;
  a.totalEptTower += r;
  if (s) a.towerExact = true;
  a.count++;
  if (!a.types[o]) a.types[o] = {
    eptCreep: 0,
    eptTower: 0,
    count: 0
  };
  a.types[o].eptCreep += n;
  a.types[o].eptTower += r;
  a.types[o].count++;
  e.totalEptCreep += n;
  e.totalEptTower += r;
}

function maintScan() {
  const e = {
    totalEptCreep: 0,
    totalEptTower: 0,
    totalCreepCost: 0,
    totalCreepPerDay: 0,
    totalCreepCount: 0,
    totalSpawningCreeps: 0,
    rooms: {}
  };
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (o) {
      _mtScanRoom(o, t, (t, o, n, r, s) => _mtAdd(e, t, o, n, r, s));
      _mtAttachCreepCost(e, t, o);
    }
  }
  return _mtRound(e);
}

function _mtPrint(e) {
  console.log("[maint-scan] Total — creep: " + e.totalEptCreep + " en/tick (" + dailyCost(e.totalEptCreep) + "/day) | tower: " + e.totalEptTower + " en/tick (" + dailyCost(e.totalEptTower) + "/day) | creep workforce: " + fmtE(e.totalCreepCost || 0) + " en (" + (e.totalCreepCount || 0) + " live, " + (e.totalSpawningCreeps || 0) + " spawning) | " + fmtE(e.totalCreepPerDay || 0) + " en/day");
  const t = Object.entries(e.rooms).map(([e, t]) => ({
    name: e,
    info: t
  }));
  t.sort((e, t) => t.info.totalEptCreep - e.info.totalEptCreep);
  console.log("[maint-scan] Rooms (desc by creep en/tick):");
  for (const e of t) {
    const t = e.info.towerExact ? "tower (actual)" : "tower (est. " + TOWER_FALLBACK_HPE + " hits/e)";
    const o = e.info.creepCost;
    const n = o ? " | creep workforce " + fmtE(o.total) + " en (" + o.liveCount + " live + " + o.spawningCount + " spawning, owner " + o.owner + ") | " + fmtE(o.perDay) + " en/day" : "";
    console.log("  - " + e.name + ": creep " + e.info.totalEptCreep + " (" + dailyCost(e.info.totalEptCreep) + "/day) | " + t + " " + e.info.totalEptTower + " (" + dailyCost(e.info.totalEptTower) + "/day) en/tick (structures " + e.info.count + ")" + n);
    const r = Object.entries(e.info.types).sort((e, t) => t[1].eptCreep - e[1].eptCreep);
    for (const [e, t] of r) console.log("      - " + e + ": creep " + t.eptCreep + " (" + dailyCost(t.eptCreep) + "/day) | tower " + t.eptTower + " (" + dailyCost(t.eptTower) + "/day) en/tick (count " + t.count + ")");
  }
}

function maintPrint(e) {
  if (e) {
    const t = Game.rooms[e];
    if (!t) {
      console.log("[maint-scan] " + e + " not visible. Use maintScanRoom('" + e + "') to observe it.");
      return;
    }
    const o = {
      totalEptCreep: 0,
      totalEptTower: 0,
      totalCreepCost: 0,
      totalCreepPerDay: 0,
      totalCreepCount: 0,
      totalSpawningCreeps: 0,
      rooms: {}
    };
    _mtScanRoom(t, e, (e, t, n, r, s) => _mtAdd(o, e, t, n, r, s));
    _mtAttachCreepCost(o, e, t);
    _mtPrint(_mtRound(o));
    return;
  }
  _mtPrint(maintScan());
}

function maintScanRoom(e) {
  if (!e || typeof e !== "string") return '[maint-scan] Usage: maintScanRoom("W1N1")';
  if (!Memory.maintScan) Memory.maintScan = {};
  if (!Memory.maintScan.pending) Memory.maintScan.pending = {};
  const t = Game.rooms[e];
  if (t) {
    _mtWipe(e);
    maintPrint(e);
    return null;
  }
  const o = findObserverInRange(e, _tickUsedSet());
  if (o) {
    if (_tickObserve(o, e)) {
      Memory.maintScan.pending[e] = {
        tick: Game.time,
        observerRoom: o.room.name
      };
      return "[maint-scan] 🔭 observing " + e + " from " + o.room.name + " — auto-completing next tick";
    }
    console.log("[maint-scan] Observer in " + o.room.name + " busy or failed — queued for the scheduler");
    Memory.maintScan.pending[e] = {
      tick: Game.time,
      observerRoom: o.room.name
    };
    return "[maint-scan] 🔭 queued " + e + " — the scheduler will observe it shortly";
  }
  const n = tryPowerObserver(e);
  if (n) {
    if (!Memory.maintScan.powerObs) Memory.maintScan.powerObs = {};
    Memory.maintScan.powerObs[e] = {
      operatorName: n.operatorName,
      operatorRoom: n.operatorRoom,
      tick: Game.time
    };
    Memory.maintScan.pending[e] = {
      tick: Game.time,
      observerRoom: n.operatorRoom,
      poweredObserver: true
    };
    return "[maint-scan] 🔭⚡ PWR_OPERATE_OBSERVER from " + n.operatorName + " — auto-completing when " + e + " is visible";
  }
  return "[maint-scan] ERROR: " + e + " not visible, no observer in range — send a scout";
}

function _mtWipe(e) {
  if (!Memory.maintScan) return;
  if (Memory.maintScan.pending) delete Memory.maintScan.pending[e];
  if (Memory.maintScan.powerObs) delete Memory.maintScan.powerObs[e];
}

function _processMaintPending() {
  if (!Memory.maintScan || !Memory.maintScan.pending) return;
  for (const e in Memory.maintScan.pending) {
    const t = Memory.maintScan.pending[e], o = Game.time - t.tick;
    if (Game.rooms[e]) {
      console.log("[maint-scan] 🔭 Auto-completing scan for " + e);
      _mtWipe(e);
      maintPrint(e);
    } else if (t.poweredObserver) {
      const t = Memory.maintScan.powerObs && Memory.maintScan.powerObs[e];
      if (t && Game.time - t.tick > 100) {
        console.log("[maint-scan] ⚠️  Power-observe timed out for " + e + ". Clearing.");
        _mtWipe(e);
      }
    } else if (o >= 5) {
      console.log("[maint-scan] ⚠️  Timed out waiting for " + e + " after " + o + " ticks.");
      _mtWipe(e);
    }
  }
}

function _getStructCost(e) {
  if (Object.keys(STRUCT_COST_MAP).length === 0) {
    STRUCT_COST_MAP[STRUCTURE_SPAWN] = 15e3;
    STRUCT_COST_MAP[STRUCTURE_EXTENSION] = 3e3;
    STRUCT_COST_MAP[STRUCTURE_ROAD] = 300;
    STRUCT_COST_MAP[STRUCTURE_LINK] = 5e3;
    STRUCT_COST_MAP[STRUCTURE_STORAGE] = 3e4;
    STRUCT_COST_MAP[STRUCTURE_TOWER] = 5e3;
    STRUCT_COST_MAP[STRUCTURE_OBSERVER] = 8e3;
    STRUCT_COST_MAP[STRUCTURE_POWER_SPAWN] = 1e5;
    STRUCT_COST_MAP[STRUCTURE_EXTRACTOR] = 5e3;
    STRUCT_COST_MAP[STRUCTURE_LAB] = 5e4;
    STRUCT_COST_MAP[STRUCTURE_TERMINAL] = 1e5;
    STRUCT_COST_MAP[STRUCTURE_CONTAINER] = 5e3;
    STRUCT_COST_MAP[STRUCTURE_NUKER] = 1e5;
    STRUCT_COST_MAP[STRUCTURE_FACTORY] = 1e5;
  }
  return STRUCT_COST_MAP[e] || 0;
}

function _roomFingerprint(e) {
  const t = e.name;
  if (!global.__fpCache || global.__fpCache.tick !== Game.time) {
    global.__fpCache = {
      tick: Game.time,
      byRoom: Object.create(null)
    };
  } else if (global.__fpCache.byRoom[t]) {
    return global.__fpCache.byRoom[t];
  }
  const o = {
    byType: Object.create(null),
    allStructures: e.find(FIND_STRUCTURES),
    creeps: e.find(FIND_CREEPS),
    myCreeps: e.find(FIND_MY_CREEPS),
    powerCreeps: e.find(FIND_POWER_CREEPS),
    hostiles: e.find(FIND_HOSTILE_CREEPS),
    hostilesByOwner: Object.create(null),
    sources: e.find(FIND_SOURCES),
    minerals: e.find(FIND_MINERALS),
    dropped: e.find(FIND_DROPPED_RESOURCES),
    nukes: e.find(FIND_NUKES),
    construction: e.find(FIND_CONSTRUCTION_SITES)
  };
  for (const e of o.allStructures) (o.byType[e.structureType] || (o.byType[e.structureType] = [])).push(e);
  for (const e of o.hostiles) (o.hostilesByOwner[e.owner.username] || (o.hostilesByOwner[e.owner.username] = [])).push(e);
  global.__fpCache.byRoom[t] = o;
  return o;
}

function _fpByType(e, t) {
  return e.byType[t] || EMPTY_ARR;
}

const EMPTY_ARR = [];
function _itTowerHPE(e) {
  if (e <= TOWER_OPTIMAL_RANGE) return TOWER_MAX_REPAIR / TOWER_ENERGY_COST;
  if (e >= TOWER_FALLOFF_RANGE) return TOWER_MIN_REPAIR / TOWER_ENERGY_COST;
  return (TOWER_MAX_REPAIR - (e - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE) * (TOWER_MAX_REPAIR - TOWER_MIN_REPAIR)) / TOWER_ENERGY_COST;
}

function _itTowerHPEForStruct(e, t) {
  if (!t || !t.length) return TOWER_FALLBACK_HPE;
  let o = Infinity;
  for (const n of t) {
    const t = Math.max(Math.abs(e.pos.x - n.pos.x), Math.abs(e.pos.y - n.pos.y));
    if (t < o) o = t;
  }
  return _itTowerHPE(o);
}

function _itCalcMaint(e) {
  const t = e.find(FIND_STRUCTURES, {
    filter: e => e.structureType === STRUCTURE_TOWER
  });
  const o = e.getTerrain(), n = !!(e.controller && e.controller.owner);
  let r = 0, s = 0;
  for (const a of e.find(FIND_STRUCTURES)) {
    let e = 0;
    if (a.structureType === STRUCTURE_ROAD) e = o.get(a.pos.x, a.pos.y) & TERRAIN_MASK_SWAMP ? ROAD_SWAMP_DPT : ROAD_PLAIN_DPT; else if (a.structureType === STRUCTURE_RAMPART) e = RAMPART_DPT; else if (a.structureType === STRUCTURE_CONTAINER) e = n ? CONTAINER_OWNED_DPT : CONTAINER_UNOWNED_DPT; else continue;
    r += e / CREEP_REPAIR_HITS;
    s += e / _itTowerHPEForStruct(a, t);
  }
  return {
    eptCreep: r2(r),
    eptTower: r2(s)
  };
}

function _itSourceMaxRate(e) {
  let t = (e.energyCapacity || SOURCE_ENERGY_CAPACITY) / ENERGY_REGEN_TIME;
  if (e.effects && e.effects.length) {
    for (const o of e.effects) {
      if (o.effect !== PWR_REGEN_SOURCE) continue;
      const e = typeof POWER_INFO !== "undefined" ? POWER_INFO[PWR_REGEN_SOURCE] : null;
      const n = o.level || 1;
      const r = e && e.effect && e.effect[n - 1] || 0;
      const s = e && e.period || 15;
      if (s > 0) t += r / s;
    }
  }
  return t;
}

function _itCalcEcoValue(e, t) {
  t = t || _roomFingerprint(e);
  const o = getMarketHistoryPrice(RESOURCE_ENERGY);
  const n = _fpByType(t, STRUCTURE_LAB);
  const r = _fpByType(t, STRUCTURE_FACTORY)[0];
  const s = _fpByType(t, STRUCTURE_LINK);
  const a = _fpByType(t, STRUCTURE_CONTAINER);
  const i = _fpByType(t, STRUCTURE_EXTRACTOR)[0];
  const l = e.storage;
  const c = _fpByType(t, STRUCTURE_TERMINAL)[0];
  const u = (i ? _getStructCost(STRUCTURE_EXTRACTOR) : 0) + n.length * _getStructCost(STRUCTURE_LAB) + (r ? _getStructCost(STRUCTURE_FACTORY) : 0) + s.length * _getStructCost(STRUCTURE_LINK) + a.length * _getStructCost(STRUCTURE_CONTAINER);
  const m = u * o;
  const f = new Set(INTEL_COMBAT_BOOSTS);
  let p = 0;
  for (const e of [ l && l.store, c && c.store, ...n.map(e => e.store), r && r.store ].filter(Boolean)) for (const t in e) if (t !== RESOURCE_ENERGY && !f.has(t) && e[t]) p += e[t] * getMarketHistoryPrice(t);
  return {
    total: Math.round(m + p),
    structureCredits: Math.round(m),
    resourceCredits: Math.round(p)
  };
}

function _itCalcMilValue(e, t) {
  t = t || _roomFingerprint(e);
  const o = getMarketHistoryPrice(RESOURCE_ENERGY);
  let n = 0, r = 0;
  const s = _fpByType(t, STRUCTURE_TOWER);
  const a = _fpByType(t, STRUCTURE_NUKER)[0];
  const i = _fpByType(t, STRUCTURE_RAMPART);
  const l = _fpByType(t, STRUCTURE_WALL);
  const c = e.storage;
  const u = _fpByType(t, STRUCTURE_TERMINAL)[0];
  const m = _fpByType(t, STRUCTURE_LAB);
  let f = s.length * _getStructCost(STRUCTURE_TOWER);
  for (const e of s) f += e.store && e.store[RESOURCE_ENERGY] || 0;
  n += f * o;
  if (a) {
    n += (_getStructCost(STRUCTURE_NUKER) + (a.store && a.store[RESOURCE_ENERGY] || 0)) * o;
    const e = a.store && a.store[RESOURCE_GHODIUM] || 0;
    if (e > 0) r += e * getMarketHistoryPrice(RESOURCE_GHODIUM);
  }
  let p = 0;
  for (const e of i) p += e.hits;
  for (const e of l) p += e.hits;
  n += p / 100 * o;
  const E = [ c && c.store, u && u.store, ...m.map(e => e.store) ].filter(Boolean);
  for (const e of INTEL_COMBAT_BOOSTS) {
    let t = 0;
    for (const o of E) if (o[e]) t += o[e];
    if (t > 0) r += t * getMarketHistoryPrice(e);
  }
  return {
    total: Math.round(n + r),
    structureCredits: Math.round(n),
    resourceCredits: Math.round(r)
  };
}

function _itCalcDPValue(e, t) {
  t = t || _roomFingerprint(e);
  const o = getMarketHistoryPrice(RESOURCE_ENERGY);
  const n = _fpByType(t, STRUCTURE_SPAWN);
  const r = _fpByType(t, STRUCTURE_EXTENSION);
  const s = _fpByType(t, STRUCTURE_POWER_SPAWN)[0];
  const a = _fpByType(t, STRUCTURE_TERMINAL)[0];
  const i = e.storage;
  const l = _fpByType(t, STRUCTURE_OBSERVER)[0];
  const c = (n.length * _getStructCost(STRUCTURE_SPAWN) + r.length * _getStructCost(STRUCTURE_EXTENSION) + (i ? _getStructCost(STRUCTURE_STORAGE) : 0) + (a ? _getStructCost(STRUCTURE_TERMINAL) : 0) + (s ? _getStructCost(STRUCTURE_POWER_SPAWN) : 0) + (l ? _getStructCost(STRUCTURE_OBSERVER) : 0)) * o;
  let u = 0, m = 0;
  for (const e of [ i, a, s ].filter(Boolean)) {
    u += e.store && e.store[RESOURCE_ENERGY] || 0;
    m += e.store && e.store[RESOURCE_POWER] || 0;
  }
  const f = u * o + (m > 0 ? m * getMarketHistoryPrice(RESOURCE_POWER) : 0);
  return {
    total: Math.round(c + f),
    structureCredits: Math.round(c),
    resourceCredits: Math.round(f)
  };
}

function _itTakeSnap(e) {
  const t = {
    sources: {},
    towers: {},
    labs: {},
    factory: null,
    terminal: null,
    spawns: {},
    creepPos: {},
    totalCreeps: 0
  };
  for (const o of e.find(FIND_SOURCES)) t.sources[o.id] = o.energy;
  for (const o of e.find(FIND_STRUCTURES)) {
    if (o.structureType === STRUCTURE_TOWER) t.towers[o.id] = o.store[RESOURCE_ENERGY]; else if (o.structureType === STRUCTURE_LAB) t.labs[o.id] = o.cooldown || 0; else if (o.structureType === STRUCTURE_FACTORY) t.factory = {
      cooldown: o.cooldown || 0
    }; else if (o.structureType === STRUCTURE_POWER_SPAWN) {} else if (o.structureType === STRUCTURE_TERMINAL) {
      const e = {};
      for (const t in o.store) if (o.store[t] > 0) e[t] = o.store[t];
      t.terminal = {
        cooldown: o.cooldown || 0,
        used: o.store.getUsedCapacity(),
        store: e
      };
    } else if (o.structureType === STRUCTURE_SPAWN) t.spawns[o.id] = o.spawning && o.spawning.body ? {
      body: o.spawning.body.slice()
    } : null;
  }
  const o = e.find(FIND_CREEPS);
  t.totalCreeps = o.length;
  for (const e of o) t.creepPos[e.id] = {
    x: e.pos.x,
    y: e.pos.y
  };
  return t;
}

function _itInitTotals() {
  return {
    ticksObserved: 0,
    invisibleTicks: 0,
    energyHarvested: 0,
    theoreticalMax: 0,
    towerEnergyFired: 0,
    spawnCostAccum: 0,
    upgradeEnergySpent: 0,
    creepMoves: 0,
    creepCountSum: 0,
    totalIntents: 0,
    productiveIntents: 0,
    buildTicks: 0,
    ev_harvest: 0,
    ev_upgradeController: 0,
    ev_build: 0,
    ev_transfer: 0,
    ev_repairAny: 0,
    ev_attack: 0,
    ev_heal: 0,
    ev_power: 0,
    terminalSends: 0,
    terminalFlux: 0,
    terminalIn: {},
    terminalOut: {},
    labReactions: 0,
    factoryProduces: 0,
    spawnEvents: 0,
    labCount: 0,
    hasLabs: false,
    hasFactory: false,
    hasTerminal: false,
    sourceCount: 0,
    sourcePositions: {},
    sourceStartEnergy: {},
    sourceExtracted: {},
    sourceRegen: {},
    sourceDepleted: {},
    sourceRegenTicks: {},
    sourceMaxRates: {},
    sourceHarvested: {},
    maintEptCreep: 0
  };
}

function _itAccumulate(e, t, o, n) {
  for (const o in n.sourcePositions) {
    const r = e.sources[o] !== undefined ? e.sources[o] : 0, s = t.sources[o] !== undefined ? t.sources[o] : 0;
    if (s > r) n.sourceRegenTicks[o] = (n.sourceRegenTicks[o] || 0) + 1; else n.sourceExtracted[o] = (n.sourceExtracted[o] || 0) + Math.max(0, r - s);
    if (s === 0 && r > 0) n.sourceDepleted[o] = true;
  }
  for (const o in t.towers) if (e.towers[o] !== undefined) n.towerEnergyFired += Math.max(0, e.towers[o] - t.towers[o]);
  for (const o in t.labs) if (e.labs[o] === 0 && t.labs[o] > 0) n.labReactions++;
  if (t.factory && e.factory && e.factory.cooldown === 0 && t.factory.cooldown > 0) n.factoryProduces++;
  if (t.terminal && e.terminal) {
    if (e.terminal.cooldown === 0 && t.terminal.cooldown > 0) n.terminalSends++;
    n.terminalFlux += Math.abs(t.terminal.used - e.terminal.used);
    const o = new Set([ ...Object.keys(e.terminal.store || {}), ...Object.keys(t.terminal.store || {}) ]);
    for (const r of o) {
      const o = (e.terminal.store || {})[r] || 0, s = (t.terminal.store || {})[r] || 0, a = s - o;
      if (a > 0) n.terminalIn[r] = (n.terminalIn[r] || 0) + a; else if (a < 0) n.terminalOut[r] = (n.terminalOut[r] || 0) + -a;
    }
  }
  for (const o in t.spawns) {
    if (t.spawns[o] && !e.spawns[o]) {
      n.spawnCostAccum += util.bodyCost(t.spawns[o].body);
      n.spawnEvents++;
    }
  }
  for (const o in t.creepPos) {
    const r = t.creepPos[o], s = e.creepPos[o];
    if (s && (r.x !== s.x || r.y !== s.y)) n.creepMoves++;
  }
  n.creepCountSum += t.totalCreeps;
  let r;
  try {
    r = JSON.parse(o.getEventLog(true));
  } catch (e) {
    r = o.getEventLog();
  }
  let s = false;
  if (r && r.length) for (const e of r) {
    switch (e.event) {
     case EV_HARVEST:
      n.ev_harvest++;
      n.totalIntents++;
      n.productiveIntents++;
      if (e.data && typeof e.data.amount === "number" && e.data.resourceType === RESOURCE_ENERGY) {
        n.energyHarvested += e.data.amount;
        const t = e.data.targetId;
        if (t && n.sourceMaxRates[t] !== undefined) n.sourceHarvested[t] = (n.sourceHarvested[t] || 0) + e.data.amount;
      }
      break;
     case EV_UPGRADE_CONTROLLER:
      n.ev_upgradeController++;
      n.totalIntents++;
      n.productiveIntents++;
      n.upgradeEnergySpent += e.data && typeof e.data.amount === "number" ? e.data.amount : 1;
      break;
     case EV_BUILD:
      n.ev_build++;
      n.totalIntents++;
      n.productiveIntents++;
      s = true;
      break;
     case EV_TRANSFER:
      n.ev_transfer++;
      n.totalIntents++;
      n.productiveIntents++;
      break;
     case EV_REPAIR:
      n.ev_repairAny++;
      n.totalIntents++;
      break;
     case EV_ATTACK:
      n.ev_attack++;
      n.totalIntents++;
      break;
     case EV_HEAL:
      n.ev_heal++;
      n.totalIntents++;
      break;
     case EV_POWER:
      n.ev_power++;
      n.totalIntents++;
      n.productiveIntents++;
      break;
     case EV_ATTACK_CONTROLLER:
     case EV_RESERVE_CONTROLLER:
      n.totalIntents++;
      break;
    }
  }
  if (s) n.buildTicks++;
  n.ticksObserved++;
  let a = 0;
  for (const e in n.sourceMaxRates) a += n.sourceMaxRates[e];
  n.theoreticalMax += a;
}

function _itGetPrev(e) {
  return global[INTEL_EFF_GLOBAL_PREV] && global[INTEL_EFF_GLOBAL_PREV][e] || null;
}

function _itSetPrev(e, t) {
  if (!global[INTEL_EFF_GLOBAL_PREV]) global[INTEL_EFF_GLOBAL_PREV] = {};
  global[INTEL_EFF_GLOBAL_PREV][e] = t;
}

function _itClearPrev(e) {
  if (global[INTEL_EFF_GLOBAL_PREV]) delete global[INTEL_EFF_GLOBAL_PREV][e];
}

function _itRoomOwner(e) {
  return e && e.controller && e.controller.owner && e.controller.owner.username;
}

function _itHasOwnerCreeps(e) {
  const t = _itRoomOwner(e);
  if (!t) return false;
  return e.find(FIND_CREEPS, {
    filter: e => e.owner && e.owner.username === t
  }).length > 0;
}

function _itClearProfile(e, t) {
  if (heap[INTEL_EFF_MEM_KEY]) delete heap[INTEL_EFF_MEM_KEY][e];
  _itClearPrev(e);
  if (t && Memory[INTEL_EFF_CACHE_KEY]) delete Memory[INTEL_EFF_CACHE_KEY][e];
}

function _itFireObservers(e) {
  const t = findObserversInRange(e);
  let o = 0;
  for (const n of t) {
    if (o >= 1) break;
    if (_tickObserve(n, e)) o++;
  }
  return o;
}

function _itStartProfile(e, t) {
  if (!_itRoomOwner(t) || !_itHasOwnerCreeps(t)) return false;
  if (!heap[INTEL_EFF_MEM_KEY]) heap[INTEL_EFF_MEM_KEY] = {};
  if (heap[INTEL_EFF_MEM_KEY][e] && heap[INTEL_EFF_MEM_KEY][e].active) return;
  const o = _itCalcMaint(t);
  const n = t.find(FIND_STRUCTURES, {
    filter: e => e.structureType === STRUCTURE_LAB
  });
  const r = t.find(FIND_STRUCTURES, {
    filter: e => e.structureType === STRUCTURE_FACTORY
  })[0];
  const s = t.find(FIND_STRUCTURES, {
    filter: e => e.structureType === STRUCTURE_TERMINAL
  })[0];
  const a = t.find(FIND_SOURCES);
  const i = _itInitTotals();
  i.maintEptCreep = o.eptCreep;
  i.labCount = n.length;
  i.hasLabs = n.length > 0;
  i.hasFactory = !!r;
  i.hasTerminal = !!s;
  i.sourceCount = a.length;
  for (const e of a) {
    i.sourcePositions[e.id] = {
      x: e.pos.x,
      y: e.pos.y
    };
    i.sourceStartEnergy[e.id] = e.energy;
    i.sourceExtracted[e.id] = 0;
    i.sourceDepleted[e.id] = false;
    i.sourceRegenTicks[e.id] = 0;
    i.sourceMaxRates[e.id] = _itSourceMaxRate(e);
    i.sourceHarvested[e.id] = 0;
  }
  heap[INTEL_EFF_MEM_KEY][e] = {
    active: true,
    roomName: e,
    startTick: Game.time,
    totals: i
  };
  _itFireObservers(e);
  console.log("[Intel] 📊 Efficiency profile started — " + e + " (" + INTEL_PROFILE_TICKS + " ticks)");
}

function _itProcessProfiles() {
  if (!heap[INTEL_EFF_MEM_KEY]) return;
  for (const e in heap[INTEL_EFF_MEM_KEY]) {
    const t = heap[INTEL_EFF_MEM_KEY][e];
    if (!t || !t.active) continue;
    if (!Game.rooms[e] || !(Game.rooms[e].controller && Game.rooms[e].controller.my)) _itFireObservers(e);
    const o = Game.rooms[e];
    if (!o) {
      t.totals.invisibleTicks++;
      continue;
    }
    if (!_itRoomOwner(o)) {
      _itClearProfile(e, true);
      _itPrintZeroIntel(o, "room is unowned");
      continue;
    }
    if (!_itHasOwnerCreeps(o)) {
      _itClearProfile(e, true);
      _itPrintNoOperations(o);
      continue;
    }
    const n = _itTakeSnap(o), r = _itGetPrev(e);
    if (!r) {
      _itSetPrev(e, n);
      continue;
    }
    _itAccumulate(r, n, o, t.totals);
    _itSetPrev(e, n);
    const s = t.totals.ticksObserved;
    if (s > 0 && s % 25 === 0 && s < INTEL_PROFILE_TICKS) console.log("[Intel] 📊 " + e + " efficiency: " + s + "/" + INTEL_PROFILE_TICKS + " ticks");
    if (s >= INTEL_PROFILE_TICKS) _itFinalise(e, t);
  }
}

function _itFinalise(e, t) {
  if (!Memory[INTEL_EFF_CACHE_KEY]) Memory[INTEL_EFF_CACHE_KEY] = {};
  Memory[INTEL_EFF_CACHE_KEY][e] = {
    totals: t.totals,
    completedTick: Game.time,
    expiresTick: Game.time + INTEL_EFF_EXPIRE
  };
  _itClearPrev(e);
  delete heap[INTEL_EFF_MEM_KEY][e];
  console.log("[Intel] 📊 Efficiency profile complete — " + e + " (" + t.totals.ticksObserved + " ticks). Generating full report...");
  if (Game.rooms[e]) intel(e); else console.log("[Intel] " + e + " not visible this tick — call intel('" + e + "') manually.");
}

function _itGetCachedEff(e) {
  if (!Memory[INTEL_EFF_CACHE_KEY] || !Memory[INTEL_EFF_CACHE_KEY][e]) return null;
  const t = Memory[INTEL_EFF_CACHE_KEY][e];
  if (t.expiresTick <= Game.time) {
    delete Memory[INTEL_EFF_CACHE_KEY][e];
    return null;
  }
  return t;
}

function _itIsProfileActive(e) {
  return !!(heap[INTEL_EFF_MEM_KEY] && heap[INTEL_EFF_MEM_KEY][e] && heap[INTEL_EFF_MEM_KEY][e].active);
}

function _itCalcEffCPU(e) {
  const t = .2, o = .4, n = .5;
  const r = (e.ev_harvest || 0) + (e.ev_upgradeController || 0) + (e.ev_build || 0) + (e.ev_transfer || 0) + (e.ev_power || 0) + (e.terminalSends || 0) + (e.factoryProduces || 0) + (e.spawnEvents || 0);
  const s = r * t + (e.labReactions || 0) * o + (e.ev_repairAny || 0) * o + ((e.ev_attack || 0) + (e.ev_heal || 0)) * t + (e.creepMoves || 0) * n;
  return {
    totalMid: s,
    cpuPerCreep: (e.creepCountSum || 0) > 0 ? s / e.creepCountSum : null
  };
}

function _itAnalyzeOperational(e, t) {
  let o = 0;
  const n = {}, r = {}, s = {};
  const a = t.totals, i = Math.max(1, a.ticksObserved);
  const l = a.sourceHarvested || {};
  const c = [], u = [];
  for (const e in a.sourcePositions) {
    const t = l[e] || 0, o = a.sourceMaxRates[e] || 10;
    c.push(Math.min(1, t / (i * o)));
    u.push(o);
  }
  const m = c.length > 0 ? c.reduce((e, t) => e + t, 0) / c.length : 0;
  const f = Math.min(25, m * 25);
  if (f > 0) {
    n.energyCaptureRate = r1(f);
    o += f;
  }
  const p = Object.values(l).reduce((e, t) => e + t, 0);
  const E = Object.values(a.sourceMaxRates).reduce((e, t) => e + t, 0);
  const d = Math.min(p / i, E);
  s.energyCaptureRate = r1(m * 100) + "%";
  s.incomePerTick = r1(d);
  s.maxIncomePerTick = r1(E);
  s.sourceFractions = c.map(e => r1(e * 100) + "%").join(", ");
  s.sourceMaxRates = u.map(e => r1(e) + " E/t").join(", ");
  s.energyHarvested = Math.round(p);
  s.sustainedUtilization = r1(E > 0 ? d / E * 100 : 0) + "%";
  const R = a.maintEptCreep + a.spawnCostAccum / i + a.upgradeEnergySpent / i + a.towerEnergyFired / i;
  const _ = d - R, g = d > 0 ? _ / d : 0;
  let y = 0;
  if (g >= 0) {
    if (g <= .5) y = 20; else if (g <= .8) y = 20 - (g - .5) / .3 * 10; else y = Math.max(4, 10 - (g - .8) / .2 * 6);
    n.incomeSurplus = r1(y);
    o += y;
  }
  s.spendPerTick = r2(R);
  s.surplusPerTick = r1(_);
  s.surplusFrac = r1(g * 100) + "%";
  s.maintPerTick = r2(a.maintEptCreep);
  s.spawnPerTick = r1(a.spawnCostAccum / i);
  s.upgradePerTick = r1(a.upgradeEnergySpent / i);
  s.towerCostPerTick = r1(a.towerEnergyFired / i);
  const T = _itCalcEffCPU(a), S = T.cpuPerCreep;
  if (S !== null) {
    const e = Math.max(0, 16 * (1 - S / .5));
    if (e > 0) {
      n.cpuEfficiency = r1(e);
      o += e;
    }
  }
  s.cpuPerCreep = S !== null ? r3(S) : "n/a";
  s.cpuTotalMid = S !== null ? r2(T.totalMid) : 0;
  const h = a.totalIntents + a.creepMoves, C = h > 0 ? a.productiveIntents / h : 0;
  const O = C * 13;
  if (O > 0) {
    n.productiveIntentRatio = r1(O);
    o += O;
  }
  s.productiveRatio = r1(C * 100) + "%";
  s.productiveIntents = a.productiveIntents;
  s.totalIntents = h;
  s.ev_harvest = a.ev_harvest || 0;
  s.ev_build = a.ev_build || 0;
  s.ev_upgradeController = a.ev_upgradeController || 0;
  s.ev_transfer = a.ev_transfer || 0;
  s.ev_repairAny = a.ev_repairAny || 0;
  s.ev_attack = a.ev_attack || 0;
  s.ev_heal = a.ev_heal || 0;
  s.ev_power = a.ev_power || 0;
  const N = Math.floor(a.towerEnergyFired / TOWER_ENERGY_COST), P = Math.max(0, a.ev_repairAny - N);
  let M;
  if (a.ev_repairAny === 0) {
    M = null;
    n.creepRepairShare = 6;
    o += 6;
  } else {
    M = P / a.ev_repairAny;
    const e = M * 13;
    if (e > 0) {
      n.creepRepairShare = r1(e);
      o += e;
    }
  }
  s.towerRepairActions = N;
  s.creepRepairActions = P;
  s.totalRepairEvents = a.ev_repairAny;
  s.creepRepairShare = M !== null ? r1(M * 100) + "%" : "N/A";
  const w = a.creepCountSum / i, A = w > 0 ? a.creepMoves / (w * i) : 0;
  const k = Math.max(0, 13 * (1 - A / 1));
  if (k > 0) {
    n.lowMovesPerCreep = r1(k);
    o += k;
  }
  if (A < .1) {
    n.efficientMovementBonus = 3;
    o += 3;
  }
  if (A > .7) {
    r.highMovesPerCreep = -10;
    o -= 10;
  } else if (A > .4) {
    r.moderateMovesPerCreep = -5;
    o -= 5;
  }
  s.movesPerCreepTick = r3(A);
  s.totalCreepMoves = a.creepMoves;
  s.avgCreeps = r1(w);
  s.buildRate = r3(a.ev_build / i) + "/tick";
  s.harvestRate = r3(a.ev_harvest / i) + "/tick";
  s.upgradeRate = r3(a.ev_upgradeController / i) + "/tick";
  s.transferRate = r3(a.ev_transfer / i) + "/tick";
  s.ticksObserved = a.ticksObserved;
  s.invisibleTicks = a.invisibleTicks;
  s.terminalIn = a.terminalIn || {};
  s.terminalOut = a.terminalOut || {};
  s.hasTerminal = a.hasTerminal;
  if (g < 0) {
    r.energyDeficit = -15;
    o -= 15;
  }
  if (S !== null && S >= .4) {
    r.highCpuPerCreep = -10;
    o -= 10;
  }
  if (a.ev_repairAny > 0 && M !== null && M < .3) {
    r.towerRepairDominant = -8;
    o -= 8;
  }
  if (a.buildTicks >= i * .95) {
    r.sustainedBuildActivity = -5;
    o -= 5;
  }
  return {
    score: Math.max(0, Math.min(100, o)),
    positives: n,
    negatives: r,
    details: s
  };
}

function _itAnalyzeEco(e, t, o) {
  o = o || _roomFingerprint(e);
  let n = 0;
  const r = {}, s = {}, a = {};
  const i = _fpByType(o, STRUCTURE_FACTORY)[0];
  const l = _fpByType(o, STRUCTURE_EXTRACTOR)[0];
  const c = e.storage, u = _fpByType(o, STRUCTURE_TERMINAL)[0];
  const m = _fpByType(o, STRUCTURE_LINK);
  const f = _fpByType(o, STRUCTURE_LAB);
  const p = _fpByType(o, STRUCTURE_CONTAINER);
  const E = o.sources, d = o.minerals[0];
  const R = new Set;
  if (c && c.store) Object.keys(c.store).filter(e => c.store[e] > 0).forEach(e => R.add(e));
  if (u && u.store) Object.keys(u.store).filter(e => u.store[e] > 0).forEach(e => R.add(e));
  if (i) {
    r.factoryExists = 5;
    n += 5;
    a.factoryExists = true;
    const e = i.level || 0;
    if (e >= 1) {
      r.factoryLeveled = 5;
      n += 5;
    }
    a.factoryLevel = e;
  } else {
    a.factoryExists = false;
    a.factoryLevel = 0;
  }
  if (l) {
    r.extractorExists = 3;
    n += 3;
    a.extractorExists = true;
    let e = false;
    if (d) e = d.mineralAmount === 0 || d.pos.findInRange(FIND_CREEPS, 1).length > 0;
    if (e) {
      r.extractorActive = 7;
      n += 7;
    }
    a.extractorActive = e;
  } else {
    a.extractorExists = false;
    a.extractorActive = false;
  }
  if (d) {
    a.mineralType = d.mineralType;
    a.mineralAmount = d.mineralAmount;
  }
  const _ = new Set;
  R.forEach(e => {
    if (e !== RESOURCE_ENERGY) _.add(e);
  });
  const g = _.size;
  if (g > 0) {
    const e = Math.min(25, g) / 25 * 13;
    r.storageDiversity = r1(e);
    n += e;
  }
  a.storageDiversityCount = g;
  if (m.length > 0) {
    const e = Math.min(m.length / 4, 1) * 13;
    r.linkCount = r1(e);
    n += e;
  }
  a.linkCount = m.length;
  if (f.length > 0) {
    const e = Math.min(f.length / 10, 1) * 5;
    r.labCount = r1(e);
    n += e;
  }
  const y = f.filter(e => e.cooldown > 0 || e.mineralType && e.store[e.mineralType] > 0);
  if (y.length > 0 && f.length > 0) {
    const e = Math.min(y.length / f.length, 1) * 5;
    r.labsActive = r1(e);
    n += e;
  }
  a.labCount = f.length;
  a.activeLabCount = y.length;
  const T = util.marketSnapshot().all.filter(t => t.roomName === e.name);
  const S = T.filter(e => e.type === ORDER_BUY), h = T.filter(e => e.type === ORDER_SELL);
  a.marketTotalOrders = T.length;
  a.marketBuyOrders = S.length;
  a.marketSellOrders = h.length;
  a.sellOrderDetails = h.map(e => ({
    resource: e.resourceType,
    amount: util.getOrderRemaining(e),
    price: e.price
  }));
  a.buyOrderDetails = S.map(e => ({
    resource: e.resourceType,
    amount: util.getOrderRemaining(e),
    price: e.price
  }));
  if (T.length > 0) {
    r.marketOrders = 10;
    n += 10;
  }
  const chk = (e, t, o) => {
    const s = e.some(e => R.has(e));
    a[t] = s;
    if (s) {
      r[t] = o;
      n += o;
    }
  };
  chk(HIGHWAY_DEPOSITS, "hasHighwayDeposits", 7);
  chk(COMPRESSED_COMMODITIES, "hasCompressedCommodities", 7);
  chk(REGIONAL_COMMODITIES, "hasRegionalCommodities", 7);
  chk(LEVEL_COMMODITIES, "hasLevelCommodities", 7);
  chk(LAB_PRODUCTS_LIST, "hasLabProducts", 6);
  if (t) {
    const e = t.totals, o = Math.max(1, e.ticksObserved);
    if (e.hasLabs && e.labCount > 0) {
      const t = e.labReactions / o / e.labCount;
      a.labUtilRate = r1(t * 100) + "%";
    } else {
      a.labUtilRate = "0%";
    }
    a.labReactions = e.labReactions;
    if (e.hasTerminal) {
      const t = e.terminalSends / o;
      a.terminalSendRate = r3(t) + "/tick";
      a.terminalFlux = Math.round(e.terminalFlux);
    } else {
      a.terminalSendRate = "0";
      a.terminalFlux = 0;
    }
    a.terminalSends = e.terminalSends;
    a.factoryProduces = e.factoryProduces;
  } else {
    a.labUtilRate = "n/a";
    a.labReactions = 0;
    a.terminalSendRate = "n/a";
    a.terminalFlux = 0;
    a.terminalSends = 0;
    a.factoryProduces = 0;
  }
  if (c && c.store) {
    const e = c.store.getUsedCapacity() / c.store.getCapacity() * 100;
    a.storageFillPercent = Math.round(e);
    if (e > 90) {
      s.storageNearlyFull = -10;
      n -= 10;
    }
  }
  const C = o.dropped.filter(e => e.resourceType === RESOURCE_ENERGY).reduce((e, t) => e + t.amount, 0);
  a.droppedEnergy = C;
  if (C > 1e3) {
    s.energyDecaying = -10;
    n -= 10;
  }
  if (m.length > 0 && m.every(e => e.store[RESOURCE_ENERGY] === 0)) {
    s.linksEmpty = -8;
    n -= 8;
    a.allLinksEmpty = true;
  } else {
    a.allLinksEmpty = false;
  }
  let O = 0;
  for (const e of E) if (e.pos.findInRange(m, 3).length > 0 || e.pos.findInRange(p, 3).length > 0) O++;
  a.sourcesWithInfrastructure = O;
  a.totalSources = E.length;
  if (E.length > 0 && O < E.length) {
    s.missingSourceInfrastructure = -12;
    n -= 12;
  }
  return {
    score: clamp(n),
    positives: r,
    negatives: s,
    details: a
  };
}

function _itCheckWallEff(e, t, o, n) {
  const r = _itBuildPathCtx(e, o.concat(n));
  const s = {
    top: [],
    bottom: [],
    left: [],
    right: []
  };
  for (let e = 0; e < r.entries.length; e++) {
    const t = r.entries[e];
    if (t.x === 0) s.left.push(t); else if (t.x === 49) s.right.push(t); else if (t.y === 0) s.top.push(t); else if (t.y === 49) s.bottom.push(t);
  }
  const a = [];
  for (const e in s) for (const o of s[e]) {
    const n = PathFinder.search(o, {
      pos: t.pos,
      range: 1
    }, {
      plainCost: 1,
      swampCost: 5,
      roomCallback: r.cf,
      maxRooms: 1
    });
    if (!n.incomplete && n.path.length > 0) {
      a.push(e);
      break;
    }
  }
  return a;
}

function _itBuildPathCtx(e, t) {
  const o = e.getTerrain(), n = [];
  for (let t = 1; t < 49; t += 5) {
    if (o.get(t, 0) !== TERRAIN_MASK_WALL) n.push(new RoomPosition(t, 0, e.name));
    if (o.get(t, 49) !== TERRAIN_MASK_WALL) n.push(new RoomPosition(t, 49, e.name));
    if (o.get(0, t) !== TERRAIN_MASK_WALL) n.push(new RoomPosition(0, t, e.name));
    if (o.get(49, t) !== TERRAIN_MASK_WALL) n.push(new RoomPosition(49, t, e.name));
  }
  const cf = o => {
    if (o !== e.name) return false;
    const n = new PathFinder.CostMatrix;
    for (const e of t) n.set(e.pos.x, e.pos.y, 255);
    return n;
  };
  const check = e => {
    for (const t of n) {
      const o = PathFinder.search(t, {
        pos: e.pos,
        range: 1
      }, {
        plainCost: 1,
        swampCost: 5,
        roomCallback: cf,
        maxRooms: 1
      });
      if (!o.incomplete && o.path.length > 0) return true;
    }
    return false;
  };
  return {
    check: check,
    entries: n,
    cf: cf
  };
}

function _itOwnerCreeps(e, t) {
  const o = e.controller && e.controller.owner && e.controller.owner.username;
  if (!o) return [];
  return t.creeps.filter(e => e.owner && e.owner.username === o);
}

function _itOwnerPowerCreeps(e, t) {
  const o = e.controller && e.controller.owner && e.controller.owner.username;
  if (!o) return [];
  return t.powerCreeps.filter(e => e.owner && e.owner.username === o);
}

function _itNukerCharge(e) {
  if (!e || !e.store) return {
    energy: 0,
    ghodium: 0,
    energyFraction: 0,
    ghodiumFraction: 0,
    fraction: 0,
    full: false
  };
  const t = e.store[RESOURCE_ENERGY] || 0;
  const o = e.store[RESOURCE_GHODIUM] || 0;
  const n = e.store.getCapacity(RESOURCE_ENERGY) || NUKE_ENERGY_COST_CONST;
  const r = e.store.getCapacity(RESOURCE_GHODIUM) || NUKE_GHODIUM_COST;
  const s = Math.min(1, t / Math.max(1, n));
  const a = Math.min(1, o / Math.max(1, r));
  return {
    energy: t,
    ghodium: o,
    energyFraction: s,
    ghodiumFraction: a,
    fraction: Math.min(s, a),
    full: s >= 1 && a >= 1
  };
}

function _itCombatBoostTotals(e, t, o) {
  let n = 0, r = 0, s = 0;
  const add = e => {
    if (!e) return;
    for (const t of INTEL_COMBAT_BOOSTS) {
      const o = e[t] || 0;
      n += o;
      if (T3_BOOSTS.includes(t)) {
        r += o * 3;
        s += o;
      } else r += o;
    }
  };
  add(e && e.store);
  add(t && t.store);
  for (const e of o) add(e.store);
  return {
    total: n,
    weighted: r,
    t3: s
  };
}

function _itAnalyzeDefense(e, t) {
  t = t || _roomFingerprint(e);
  let o = 0;
  const n = {}, r = {}, s = {};
  const a = _fpByType(t, STRUCTURE_TOWER);
  const i = _fpByType(t, STRUCTURE_NUKER)[0];
  const l = _fpByType(t, STRUCTURE_RAMPART);
  const c = _fpByType(t, STRUCTURE_WALL);
  const u = _fpByType(t, STRUCTURE_SPAWN);
  const m = e.storage;
  const f = _fpByType(t, STRUCTURE_TERMINAL)[0];
  const p = l.concat(c);
  const E = new Set;
  for (const e of l) if (e.hits >= 1e7) E.add(e.pos.x + "," + e.pos.y);
  const isRamped = e => !!e && E.has(e.pos.x + "," + e.pos.y);
  if (a.length > 0) {
    const e = a.reduce((e, t) => {
      const o = t.store.getCapacity(RESOURCE_ENERGY) || 1;
      return e + Math.min(1, (t.store[RESOURCE_ENERGY] || 0) / o);
    }, 0);
    const t = Math.min(e / 6, 1) * 21;
    if (t > 0) {
      n.towerReadiness = r1(t);
      o += t;
    }
    s.towerReadiness = r1(e / 6 * 100);
  } else {
    s.towerReadiness = 0;
  }
  s.towerCount = a.length;
  const d = a.some(isRamped);
  if (d) {
    n.towerProtected = 1;
    o += 1;
  }
  s.towerProtected = d;
  if (p.length > 0) {
    const e = p.reduce((e, t) => e + t.hits, 0) / p.length;
    const t = Math.min(...p.map(e => e.hits));
    const a = Math.max(...p.map(e => e.hits));
    const i = Math.min(e / 3e8, 1) * 15;
    n.avgDefenseStrength = r1(i);
    o += i;
    s.avgDefenseHits = Math.round(e);
    s.minDefenseHits = t;
    s.maxDefenseHits = a;
    if (t < 1e7) {
      const e = Math.min(10, (1 - t / 1e7) * 10);
      r.minDefenseWeakness = -r1(e);
      o -= e;
    }
  } else {
    s.avgDefenseHits = 0;
    s.minDefenseHits = 0;
    s.maxDefenseHits = 0;
  }
  s.rampartCount = l.length;
  s.wallCount = c.length;
  const R = u.some(isRamped);
  const _ = !!(m && isRamped(m));
  const g = !!(f && isRamped(f));
  if (R) {
    n.spawnProtected = 6;
    o += 6;
  }
  if (_) {
    n.storageProtected = 5;
    o += 5;
  }
  if (g) {
    n.terminalProtected = 5;
    o += 5;
  }
  s.spawnProtected = R;
  s.storageProtected = _;
  s.terminalProtected = g;
  if (e.controller && e.controller.safeModeAvailable > 0) {
    n.safeModeAvailable = 4;
    o += 4;
  }
  if (e.controller && !e.controller.safeModeCooldown) {
    n.safeModeReady = 5;
    o += 5;
  }
  s.safeModeAvailable = e.controller ? e.controller.safeModeAvailable : 0;
  s.safeModeCooldown = e.controller ? e.controller.safeModeCooldown : 0;
  s.safeModeActive = e.controller ? e.controller.safeMode : 0;
  const y = a.filter(e => (e.store[RESOURCE_ENERGY] || 0) === 0);
  const T = a.filter(e => {
    const t = e.store[RESOURCE_ENERGY] || 0;
    const o = e.store.getCapacity(RESOURCE_ENERGY) || 1;
    return t > 0 && t / o < .25;
  });
  s.emptyTowerCount = y.length;
  s.lowEnergyTowerCount = T.length;
  const S = l.filter(e => e.hits < 1e5);
  if (S.length > 0) {
    r.weakRamparts = -12;
    o -= 12;
  }
  s.weakRampartCount = S.length;
  s.totalDefenseCount = p.length;
  if (e.controller && e.controller.level >= 2) {
    if (c.length === 0 && l.length === 0) {
      r.noDefenses = -50;
      o -= 50;
    } else if (c.length > 0 && l.length === 0) {
      r.noRamparts = -25;
      o -= 25;
    }
  }
  if (m && p.length > 0) {
    const t = _itCheckWallEff(e, m, l, c);
    s.wallsEffective = t.length === 0;
    s.breachedEntrances = t.length;
    s.breachedDirections = t;
    if (t.length > 0) {
      r.wallsBreached = -15;
      o -= 15;
    }
  } else {
    s.wallsEffective = false;
    s.breachedEntrances = 0;
    s.breachedDirections = [];
  }
  const h = t.sources;
  if (e.controller && p.length > 0) {
    const t = _itBuildPathCtx(e, l.concat(c));
    s.controllerExposed = t.check(e.controller);
    if (s.controllerExposed) {
      r.controllerExposed = -10;
      o -= 10;
    }
    let n = 0;
    for (const e of h) if (t.check(e)) n++;
    s.exposedSourceCount = n;
    s.totalSourceCount = h.length;
    if (n > 0) {
      r.sourcesExposed = -10;
      o -= 10;
    }
  } else {
    s.controllerExposed = true;
    s.exposedSourceCount = h.length;
    s.totalSourceCount = h.length;
  }
  if (i) s.nukerProtected = isRamped(i); else s.nukerProtected = false;
  const C = _itNormalizeRubric(o, n, r, INTEL_DEFENSE_RAW_MAX);
  return {
    score: C.score,
    positives: C.positives,
    negatives: C.negatives,
    details: s
  };
}

function _itAnalyzeOffense(e, t) {
  t = t || _roomFingerprint(e);
  let o = 0;
  const n = {}, r = {}, s = {};
  const a = _fpByType(t, STRUCTURE_NUKER)[0];
  const i = e.storage;
  const l = _fpByType(t, STRUCTURE_TERMINAL)[0];
  const c = _fpByType(t, STRUCTURE_LAB);
  const u = _itOwnerCreeps(e, t);
  const m = u.filter(e => e.body.some(e => e.type === ATTACK || e.type === RANGED_ATTACK || e.type === HEAL));
  const f = u.filter(e => e.body.some(e => e.boost));
  const p = _itCombatBoostTotals(i, l, c);
  if (a) {
    const e = _itNukerCharge(a);
    const t = e.fraction * 6;
    n.nukerExists = 3;
    o += 3;
    if (t > 0) {
      n.nukerCharge = r1(t);
      o += t;
    }
    s.nukerExists = true;
    s.nukerReady = e.full;
    s.nukerCharging = !e.full && (e.energy > 0 || e.ghodium > 0);
    s.nukerEnergy = e.energy;
    s.nukerGhodium = e.ghodium;
    s.nukerEnergyPercent = r1(e.energyFraction * 100);
    s.nukerGhodiumPercent = r1(e.ghodiumFraction * 100);
    s.nukerChargePercent = r1(e.fraction * 100);
  } else {
    s.nukerExists = false;
    s.nukerReady = false;
    s.nukerCharging = false;
    s.nukerEnergy = 0;
    s.nukerGhodium = 0;
    s.nukerEnergyPercent = 0;
    s.nukerGhodiumPercent = 0;
    s.nukerChargePercent = 0;
  }
  if (f.length > 0) {
    n.boostedCreeps = 5;
    o += 5;
  }
  s.boostedCreepCount = f.length;
  if (p.weighted > 0) {
    const e = Math.min(p.weighted / 3e4, 1) * 15;
    n.combatBoostStockpile = r1(e);
    o += e;
  }
  s.combatBoostTotal = p.total;
  s.weightedCombatBoostTotal = p.weighted;
  s.t3CombatBoostTotal = p.t3;
  const E = Math.min(10, m.length * 2);
  if (E > 0) {
    n.militaryCreeps = r1(E);
    o += E;
  }
  s.militaryCreepCount = m.length;
  s.militaryPartCount = m.reduce((e, t) => e + t.body.filter(e => e.type === ATTACK || e.type === RANGED_ATTACK || e.type === HEAL).length, 0);
  if (i && i.store) {
    const e = i.store[RESOURCE_ENERGY] || 0;
    const t = Math.min(e / 1e6, 1) * 6;
    if (t > 0) {
      n.storageEnergy = r1(t);
      o += t;
    }
    s.storageEnergy = e;
  } else s.storageEnergy = 0;
  if (e.controller && e.controller.sign) {
    const t = e.controller.owner ? e.controller.owner.username : null;
    s.signByOwner = e.controller.sign.username && t && e.controller.sign.username === t;
    s.signText = e.controller.sign.text;
    if (s.signByOwner) {
      n.ownerSign = 2;
      o += 2;
    }
  } else s.signByOwner = false;
  const d = _itNormalizeRubric(o, n, r, INTEL_OFFENSE_RAW_MAX);
  return {
    score: d.score,
    positives: d.positives,
    negatives: d.negatives,
    details: s
  };
}

function _itMergeMilAnalyzers(e, t) {
  return {
    score: r1((e.score + t.score) / 2),
    positives: Object.assign({}, e.positives, t.positives),
    negatives: Object.assign({}, e.negatives, t.negatives),
    details: Object.assign({}, e.details, t.details)
  };
}

function _itAnalyzeDP(e, t) {
  t = t || _roomFingerprint(e);
  let o = 0;
  const n = {}, r = {}, s = {};
  const a = e.controller ? e.controller.level : 0;
  const i = _fpByType(t, STRUCTURE_SPAWN);
  const l = _fpByType(t, STRUCTURE_EXTENSION);
  const c = _fpByType(t, STRUCTURE_POWER_SPAWN)[0];
  const u = _fpByType(t, STRUCTURE_TERMINAL)[0];
  const m = e.storage, f = _fpByType(t, STRUCTURE_OBSERVER)[0];
  const p = t.creeps, E = _itOwnerCreeps(e, t), d = _itOwnerPowerCreeps(e, t);
  if (a > 0) {
    const e = a / 8 * 17;
    n.rcl = r1(e);
    o += e;
  }
  s.rcl = a;
  if (i.length > 0) {
    const e = Math.min(i.length / 3, 1) * 14;
    n.spawnCount = r1(e);
    o += e;
  }
  s.spawnCount = i.length;
  s.maxSpawns = INTEL_SPWN_BY_RCL[a] || 0;
  const R = INTEL_EXT_BY_RCL[a] || 0;
  if (R > 0 && l.length >= R) {
    n.maxExtensions = 10;
    o += 10;
  } else if (l.length > 0 && R > 0) {
    const e = l.length / R * 10;
    n.extensionProgress = r1(e);
    o += e;
  }
  s.extensionCount = l.length;
  s.expectedExtensions = R;
  if (c) {
    n.powerSpawnExists = 6;
    o += 6;
    s.powerSpawnExists = true;
    if (c.store[RESOURCE_ENERGY] > 0) {
      n.powerSpawnFueled = 3;
      o += 3;
    }
    s.powerSpawnEnergy = c.store[RESOURCE_ENERGY];
    s.powerSpawnPower = c.store[RESOURCE_POWER];
  } else {
    s.powerSpawnExists = false;
  }
  let _ = 0;
  if (m) _ += m.store[RESOURCE_POWER] || 0;
  if (u) _ += u.store[RESOURCE_POWER] || 0;
  if (c) _ += c.store[RESOURCE_POWER] || 0;
  if (_ > 0) {
    n.powerInRoom = 1;
    o += 1;
  }
  s.powerInRoom = _;
  if (u) {
    n.terminalExists = 8;
    o += 8;
    s.terminalExists = true;
    const e = u.store[RESOURCE_ENERGY] || 0;
    if (e >= 1e3) {
      n.terminalHasEnergy = 3;
      o += 3;
    }
    s.terminalEnergy = e;
    const t = Object.keys(u.store).filter(e => e !== RESOURCE_ENERGY && u.store[e] > 0);
    if (t.length > 0) {
      n.terminalHasResources = 5;
      o += 5;
    }
    s.terminalResourceCount = t.length;
  } else {
    s.terminalExists = false;
    s.terminalEnergy = 0;
    s.terminalResourceCount = 0;
  }
  if (m) {
    n.storageExists = 8;
    o += 8;
    s.storageExists = true;
    s.storageTotalUsed = m.store.getUsedCapacity();
  } else {
    s.storageExists = false;
    s.storageTotalUsed = 0;
  }
  const g = E.filter(e => e.body.length >= 30);
  if (g.length > 0) {
    n.largeCreeps = 8;
    o += 8;
  }
  s.largeCreepCount = g.length;
  s.maxCreepSize = E.length > 0 ? Math.max(...E.map(e => e.body.length)) : 0;
  if (d.length > 0) {
    n.powerCreeps = 6;
    o += 6;
  }
  s.powerCreepCount = d.length;
  if (f) {
    n.observer = 6;
    o += 6;
  }
  s.observerExists = !!f;
  const y = p.filter(e => e.body.length >= 30 && e.body.every(e => e.type === MOVE || e.type === CARRY));
  if (y.length > 0) {
    n.hasHauler = 5;
    o += 5;
  }
  s.haulerCount = y.length;
  s.myCreepCount = E.length;
  s.totalCreepCount = E.length;
  s.downgradeTimer = e.controller ? e.controller.ticksToDowngrade : 0;
  if (e.controller && e.controller.ticksToDowngrade) {
    if (e.controller.ticksToDowngrade < 5e4) {
      r.lowDowngradeTimer = -15;
      o -= 15;
    } else if (e.controller.ticksToDowngrade < 1e5) {
      r.mediumDowngradeTimer = -8;
      o -= 8;
    }
  }
  s.extensionEnergyPercent = 100;
  if (l.length > 0) {
    const e = l.reduce((e, t) => e + t.store[RESOURCE_ENERGY], 0), t = l.reduce((e, t) => e + t.store.getCapacity(RESOURCE_ENERGY), 0);
    const n = t > 0 ? e / t * 100 : 0;
    s.extensionEnergyPercent = Math.round(n);
    if (e === 0) {
      r.extensionsEmpty = -12;
      o -= 12;
    } else if (n < 25) {
      r.extensionsCritical = -8;
      o -= 8;
    } else if (n < 50) {
      r.extensionsLow = -5;
      o -= 5;
    }
  }
  const T = INTEL_SPWN_BY_RCL[a] || 0;
  if (i.length < T) {
    r.missingSpawns = -12;
    o -= 12;
  }
  if (l.length < R && R > 0) {
    r.missingExtensions = -10;
    o -= 10;
  }
  s.missingSpawns = Math.max(0, T - i.length);
  s.missingExtensions = Math.max(0, R - l.length);
  if (m && m.store.getUsedCapacity() < 1e4) {
    r.storageEmpty = -10;
    o -= 10;
  }
  if (a >= 4 && !m) {
    r.noStorage = -15;
    o -= 15;
  }
  return {
    score: clamp(o),
    positives: n,
    negatives: r,
    details: s
  };
}

function _itConfidence(e, t) {
  if (t && Game.rooms[e]) return 1;
  const o = _regMem();
  const n = o.rooms[e];
  if (!n || !n.t) return 0;
  const r = Math.max(0, Game.time - n.t);
  if (r <= 100) return 1;
  if (r <= 1e3) return 1 - (r - 100) / 900 * .1;
  if (r <= 5e3) return .9 - (r - 1e3) / 4e3 * .9;
  return 0;
}

function _itCombineScores(e, t, o, n, r, s, a, i) {
  const l = clamp(o.score);
  const c = clamp(n.score);
  const u = clamp(r.score);
  const m = clamp(s.score);
  const f = a ? clamp(a.score) : null;
  const p = (l + c) / 2;
  let E;
  if (i) {
    E = u * INTEL_W_FAST.economic + p * INTEL_W_FAST.military + m * INTEL_W_FAST.infrastructure;
  } else {
    E = (l * INTEL_W.defense + c * INTEL_W.offense + u * INTEL_W.economy + m * INTEL_W.infrastructure) / INTEL_W_COMPOSITE_TOTAL;
  }
  E = r1(E);
  return {
    defense: r1(l),
    offense: r1(c),
    economy: r1(u),
    infrastructure: r1(m),
    operations: f === null ? null : r1(f),
    composite: E,
    overall: E,
    economic: r1(u),
    military: r1(p),
    dualPurpose: r1(m),
    confidence: _itConfidence(e, t)
  };
}

function _itClassifyPurpose(e, t) {
  const o = Math.max(1, t.ticksObserved), n = e.controller ? e.controller.level : 0;
  const r = t.energyHarvested / o > 0 ? t.upgradeEnergySpent / o / (t.energyHarvested / o) : 0;
  const s = _itOwnerCreeps(e, _roomFingerprint(e)).filter(e => e.body.some(e => e.boost));
  if (t.ev_power > 10 && r < .4) return "Power Processing";
  if (r >= .6 && t.ev_upgradeController / o > .5) return n === 8 ? "GCL Push" : "RCL Push";
  if (s.length > 0 && t.ev_attack > 5) return "Combat Staging";
  if (t.hasFactory && t.factoryProduces > 2 && t.terminalSends / o > .03) return "Factory Hub";
  if (t.ev_build / o > .3 && r < .3) return "Active Expansion";
  if (t.ev_harvest / o > .5 && t.ev_transfer / o > .3 && !t.hasFactory && t.ev_upgradeController / o < .2) return "Source Room";
  return "Balanced Operation";
}

function _itBuildTerminalFlow(e, t) {
  if (!e.hasTerminal) return [ t + "   Terminal not present during profile." ];
  const o = new Set([ ...Object.keys(e.terminalIn || {}), ...Object.keys(e.terminalOut || {}) ]);
  if (o.size === 0) return [ t + "   No terminal movements detected over " + e.ticksObserved + " ticks." ];
  const n = [];
  for (const t of o) {
    const o = (e.terminalIn || {})[t] || 0, r = (e.terminalOut || {})[t] || 0, s = getMarketHistoryPrice(t);
    n.push({
      res: t,
      iA: o,
      oA: r,
      iV: o * s,
      oV: r * s,
      p: s,
      tot: o * s + r * s
    });
  }
  n.sort((e, t) => t.tot - e.tot);
  const r = [ t + "Terminal Flow (" + e.ticksObserved + "-tick window):" ];
  for (const e of n) {
    if (e.iA > 0) r.push(t + "  ▲ IN  " + e.res.padEnd(12) + " x" + fmtNum(e.iA).padStart(7) + " @" + r2(e.p) + "cr = " + fmtCr(e.iV).padStart(10));
    if (e.oA > 0) r.push(t + "  ▼ OUT " + e.res.padEnd(12) + " x" + fmtNum(e.oA).padStart(7) + " @" + r2(e.p) + "cr = " + fmtCr(e.oV).padStart(10));
  }
  const s = n.reduce((e, t) => e + t.iV, 0), a = n.reduce((e, t) => e + t.oV, 0);
  r.push(t + "  Total IN: " + fmtCr(s) + "  OUT: " + fmtCr(a) + "  Throughput: " + fmtCr(s + a));
  return r;
}

const INTEL_KEY_SHORT = {
  factoryExists: "Fac",
  factoryLeveled: "FacLvl",
  extractorExists: "Ext",
  extractorActive: "ExtAct",
  storageDiversity: "Div",
  linkCount: "Links",
  labCount: "Labs",
  labsActive: "LabAct",
  marketOrders: "Market",
  hasHighwayDeposits: "Highway",
  hasCompressedCommodities: "Compressed",
  hasRegionalCommodities: "Regional",
  hasLevelCommodities: "LvlCommod",
  hasLabProducts: "LabProd",
  labUtilization: "LabUtil",
  terminalSendRate: "TermSend",
  factoryUtilization: "FacUtil",
  storageNearlyFull: "StoFull",
  energyDecaying: "Decay",
  linksEmpty: "LinkEmpty",
  missingSourceInfrastructure: "NoSrcInf",
  towerCount: "Twr",
  towerProtected: "TwrProt",
  nukerExists: "Nuke",
  nukerReady: "NukeRdy",
  nukerProtected: "NukeProt",
  avgDefenseStrength: "DefStr",
  spawnProtected: "SpwnProt",
  storageProtected: "StoProt",
  terminalProtected: "TermProt",
  storageEnergy: "StoE",
  boostedCreeps: "Boost",
  combatBoostStockpile: "BoostStk",
  ownerSign: "Sign",
  safeModeAvailable: "SafeAvl",
  safeModeReady: "SafeRdy",
  towersEmpty: "TwrEmpty",
  towersLowEnergy: "TwrLow",
  weakRamparts: "WeakRamp",
  noDefenses: "NoDef",
  noRamparts: "NoRamp",
  wallsBreached: "Breached",
  controllerExposed: "CtrlExp",
  sourcesExposed: "SrcExp",
  rcl: "RCL",
  spawnCount: "Spwn",
  maxExtensions: "MaxExt",
  extensionProgress: "ExtProg",
  powerSpawnExists: "PSpwn",
  powerSpawnFueled: "PSpwnE",
  powerInRoom: "PwrInRoom",
  terminalExists: "Term",
  terminalHasEnergy: "TermE",
  terminalHasResources: "TermRes",
  storageExists: "Sto",
  largeCreeps: "BigCreep",
  powerCreeps: "PCreep",
  observer: "Obs",
  hasHauler: "Hauler",
  lowDowngradeTimer: "LowDg",
  mediumDowngradeTimer: "MedDg",
  missingSpawns: "NoSpwn",
  missingExtensions: "NoExt",
  storageEmpty: "StoEmpty",
  noStorage: "NoSto",
  extensionsEmpty: "ExtEmpty",
  extensionsCritical: "ExtCrit",
  extensionsLow: "ExtLow",
  energyCaptureRate: "Capture",
  incomeSurplus: "Surplus",
  cpuEfficiency: "CPU/Creep",
  productiveIntentRatio: "ProdInt",
  creepRepairShare: "CreepRep",
  lowMovesPerCreep: "LowMove",
  efficientMovementBonus: "MoveBonus",
  moderateMovesPerCreep: "ModMove",
  highMovesPerCreep: "HighMove",
  energyDeficit: "Deficit",
  highCpuPerCreep: "HighCPU",
  towerRepairDominant: "TwrRep",
  sustainedBuildActivity: "Building"
};
function _itFmtPN(e, t) {
  const o = Object.keys(e).map(t => (INTEL_KEY_SHORT[t] || t) + ":+" + e[t]).join(", ");
  const n = Object.keys(t).map(e => (INTEL_KEY_SHORT[e] || e) + ":" + t[e]).join(", ");
  return "Pos:[" + o + "]" + (n ? " Neg:[" + n + "]" : "");
}

function _itRating(e) {
  if (e >= 90) return "⭐ ELITE";
  if (e >= 75) return "🟢 STRONG";
  if (e >= 60) return "🟡 DEVELOPED";
  if (e >= 45) return "🟠 MODERATE";
  if (e >= 30) return "🔴 WEAK";
  if (e >= 15) return "⚫ STRUGGLING";
  return "💀 CRITICAL";
}

function _itSummary(e) {
  const t = e.defense || e.military, o = e.offense || e.military;
  const n = e.infrastructure || e.dualPurpose;
  const r = [ e.economic.score >= 70 ? "Strong economy" : e.economic.score >= 40 ? "Moderate economy" : "Weak economy", t.score >= 70 ? "well-defended" : t.score >= 40 ? "some defenses" : "poorly defended", o.score >= 70 ? "strong combat capability" : o.score >= 40 ? "some combat capability" : "limited combat capability", n.score >= 70 ? "mature infrastructure" : n.score >= 40 ? "developing infrastructure" : "limited infrastructure" ];
  if (e.noOperations) r.push("operations not measurable"); else if (e.operations) r.push(e.operations.score >= 70 ? "highly efficient" : e.operations.score >= 40 ? "moderate operations" : "inefficient operations");
  const s = Object.keys(e.economic.negatives || {}).length + Object.keys(e.defense && e.defense.negatives || {}).length + Object.keys(e.offense && e.offense.negatives || {}).length + Object.keys(n && n.negatives || {}).length + (e.operations ? Object.keys(e.operations.negatives || {}).length : 0);
  if (s > 5) r.push("MULTIPLE VULNERABILITIES"); else if (s > 2) r.push("some vulnerabilities");
  return r.join(", ");
}

function _itSecEco(e, t, o) {
  e.push("📊 ECONOMIC [" + o + "]: " + t.economic.score + "/100 | VALUE: " + fmtCr(t.economic.value.total) + " (structs: " + fmtCr(t.economic.value.structureCredits) + " | res: " + fmtCr(t.economic.value.resourceCredits) + ")");
  e.push("   " + _itFmtPN(t.economic.positives, t.economic.negatives));
  const n = t.economic.details;
  e.push("   Factory: Lvl " + (n.factoryLevel || 0) + " | Extractor: " + (n.extractorExists ? n.extractorActive ? "Active" : "Idle" : "None") + " | Mineral: " + (n.mineralType || "N/A") + " | Labs: " + n.labCount + "/10 (" + n.activeLabCount + " active) | Links: " + n.linkCount + "/4");
  e.push("   Diversity: " + n.storageDiversityCount + "/25 | Storage: " + (n.storageFillPercent || 0) + "% full | Dropped E: " + n.droppedEnergy + " | Market: " + (n.marketTotalOrders || 0) + " orders (" + (n.marketBuyOrders || 0) + "B/" + (n.marketSellOrders || 0) + "S)");
  if (n.sellOrderDetails && n.sellOrderDetails.length) e.push("   Selling: " + n.sellOrderDetails.map(e => e.resource + " x" + fmtNum(e.amount) + " @" + e.price).join(", "));
  if (n.buyOrderDetails && n.buyOrderDetails.length) e.push("   Buying:  " + n.buyOrderDetails.map(e => e.resource + " x" + fmtNum(e.amount) + " @" + e.price).join(", "));
  e.push("   Commodities: Highway:" + yn(n.hasHighwayDeposits) + " Compressed:" + yn(n.hasCompressedCommodities) + " Regional:" + yn(n.hasRegionalCommodities) + " LvlCommod:" + yn(n.hasLevelCommodities) + " LabProd:" + yn(n.hasLabProducts));
  if (t.fast) e.push("   Production rates unavailable — run intel('" + t.room + "') for full profile."); else e.push("   Production: Labs: " + n.labUtilRate + " (" + (n.labReactions || 0) + " rxns) | Terminal: " + n.terminalSendRate + " (" + (n.terminalSends || 0) + " sends) | Factory: " + (n.factoryProduces || 0) + " produces");
}

function _itSecDefense(e, t, o) {
  const n = t.defense, r = n.details;
  e.push("🛡️  DEFENSE [" + o + "]: " + n.score + "/100");
  e.push("   " + _itFmtPN(n.positives, n.negatives));
  e.push("   Towers: " + r.towerCount + "/6 (empty:" + r.emptyTowerCount + " low:" + r.lowEnergyTowerCount + ") | SafeMode: " + r.safeModeAvailable + " avail");
  e.push("   Walls: " + r.wallCount + " | Ramparts: " + r.rampartCount + " (weak<100k: " + r.weakRampartCount + ") | Def avg: " + fmtNum(r.avgDefenseHits) + " min: " + fmtNum(r.minDefenseHits));
  e.push("   Protected (10M+ ramp): Spawn:" + yn(r.spawnProtected) + " Storage:" + yn(r.storageProtected) + " Terminal:" + yn(r.terminalProtected) + " Tower:" + yn(r.towerProtected) + " Nuker:" + yn(r.nukerProtected));
  e.push("   Walls: " + (r.totalDefenseCount ? r.wallsEffective ? "Effective" : "BREACHED: " + r.breachedDirections.join(", ") : "no defenses") + " | Exposed: Ctrl:" + yn(r.controllerExposed) + " Sources:" + r.exposedSourceCount + "/" + r.totalSourceCount);
}

function _itSecOffense(e, t, o) {
  const n = t.offense, r = n.details;
  e.push("⚔️  OFFENSE [" + o + "]: " + n.score + "/100");
  e.push("   " + _itFmtPN(n.positives, n.negatives));
  e.push("   Military creeps: " + r.militaryCreepCount + " (" + r.militaryPartCount + " combat parts) | Boosted: " + r.boostedCreepCount);
  e.push("   Nuker: " + (r.nukerExists ? r.nukerReady ? "READY" : r.nukerCharging ? "Charging " + r.nukerChargePercent + "%" : "Empty" : "None") + " | Combat boosts: " + fmtNum(r.combatBoostTotal) + " raw / " + fmtNum(r.weightedCombatBoostTotal) + " weighted");
  e.push("   T3 combat boosts: " + fmtNum(r.t3CombatBoostTotal) + " | Storage energy: " + fmtNum(r.storageEnergy) + " | Signed: " + yn(r.signByOwner));
}

function _itSecDP(e, t, o) {
  const n = t.infrastructure || t.dualPurpose;
  e.push("🔧 INFRASTRUCTURE [" + o + "]: " + n.score + "/100");
  e.push("   " + _itFmtPN(n.positives, n.negatives));
  const r = n.details;
  e.push("   Spawns: " + r.spawnCount + "/" + r.maxSpawns + " | Extensions: " + r.extensionCount + "/" + r.expectedExtensions + " (" + (r.extensionEnergyPercent || 0) + "% E) | Downgrade: " + (r.downgradeTimer < 1e5 ? fmtNum(r.downgradeTimer) + " ⚠️" : "OK"));
  e.push("   Storage: " + fmtNum(r.storageTotalUsed) + " | Terminal: " + fmtNum(r.terminalEnergy) + "E, " + r.terminalResourceCount + " types | Power: " + fmtNum(r.powerInRoom));
  e.push("   PwrSpawn: " + (r.powerSpawnExists ? r.powerSpawnEnergy + "E/" + r.powerSpawnPower + "P" : "None") + " | Observer: " + yn(r.observerExists) + " | Creeps: " + r.myCreepCount + " | Haulers: " + r.haulerCount + " | PowerCreeps: " + r.powerCreepCount);
}

function _itPrintFull(e) {
  const t = "════════════════════════════════════════════════════════════════════════════════", o = [];
  o.push(t);
  o.push("ROOM INTEL: " + e.room + " | Owner: " + e.owner + " | RCL: " + e.rcl + " | " + _itRating(e.scores.composite) + " | COMPOSITE: " + e.scores.composite + "/100 | CONFIDENCE: " + r1(e.confidence * 100) + "% | TOTAL VALUE: " + fmtCr(e.totalValue) + " | Purpose: " + e.purpose);
  o.push(t);
  o.push("SCORES: Defense " + e.scores.defense + " | Offense " + e.scores.offense + " | Economy " + e.scores.economy + " | Infrastructure " + e.scores.infrastructure + " | Operations " + (e.scores.operations === null ? "n/a" : e.scores.operations) + " | Composite " + e.scores.composite);
  _itSecDefense(o, e, "30%");
  _itSecOffense(o, e, "20%");
  _itSecEco(o, e, "20%");
  _itSecDP(o, e, "20%");
  if (e.operations) {
    o.push("⚙️  OPERATIONS [reported separately]: " + e.operations.score + "/100");
    o.push("   " + _itFmtPN(e.operations.positives, e.operations.negatives));
    const t = e.operations.details;
    o.push("   Observed: " + t.ticksObserved + " ticks (" + t.invisibleTicks + " invisible)");
    o.push("   Energy: Income " + t.incomePerTick + "/" + t.maxIncomePerTick + " E/tick | Capture: " + t.energyCaptureRate + " | Source max: " + t.sourceMaxRates);
    o.push("   Spend: Upkeep " + t.maintPerTick + " | Spawn " + t.spawnPerTick + " | Upgrade " + t.upgradePerTick + " | Towers " + t.towerCostPerTick);
    o.push("   Repair: Creep share " + t.creepRepairShare + " | Tower actions " + t.towerRepairActions + " | Total " + t.totalRepairEvents);
    o.push("   Movement: " + t.movesPerCreepTick + " moves/creep/tick | Avg creeps: " + t.avgCreeps + " | CPU/creep: " + t.cpuPerCreep);
    const _p = e => t.totalIntents > 0 ? r1(e / t.totalIntents * 100) + "%" : "0%";
    o.push("   Intents (" + t.productiveRatio + " productive): Harvest " + _p(t.ev_harvest) + " Build " + _p(t.ev_build) + " Upgrade " + _p(t.ev_upgradeController) + " Transfer " + _p(t.ev_transfer) + " Repair " + _p(t.ev_repairAny) + " Attack " + _p(t.ev_attack) + " Power " + _p(t.ev_power));
    for (const e of _itBuildTerminalFlow({
      terminalIn: t.terminalIn,
      terminalOut: t.terminalOut,
      hasTerminal: t.hasTerminal,
      ticksObserved: t.ticksObserved
    }, "   ")) o.push(e);
  }
  o.push(t);
  o.push("SUMMARY: " + _itSummary(e));
  o.push(t);
  console.log(o.join("\n"));
}

function _itPrintFast(e) {
  const t = "════════════════════════════════════════════════════════════════════════════════", o = [];
  o.push(t);
  o.push("ROOM INTEL (FAST): " + e.room + " | Owner: " + e.owner + " | RCL: " + e.rcl + " | " + _itRating(e.scores.composite) + " | COMPOSITE: " + e.scores.composite + "/100 | CONFIDENCE: " + r1(e.confidence * 100) + "% | VALUE: " + fmtCr(e.totalValue) + "  [Economy·Military·Infrastructure blend]");
  o.push(t);
  o.push("SCORES: Defense " + e.scores.defense + " | Offense " + e.scores.offense + " | Economy " + e.scores.economy + " | Infrastructure " + e.scores.infrastructure + " | Operations " + (e.scores.operations === null ? "n/a" : e.scores.operations) + " | Composite " + e.scores.composite);
  _itSecDefense(o, e, "Military split");
  _itSecOffense(o, e, "Military split");
  _itSecEco(o, e, "25%");
  _itSecDP(o, e, "45%");
  o.push(e.noOperations ? "⚙️  OPERATIONS: 0/100  (not measurable: no owned creeps)" : "⚙️  OPERATIONS: not measured  ← call intel('" + e.room + "') to start 100-tick profile");
  o.push(t);
  o.push("SUMMARY (fast): " + _itSummary(e));
  o.push(t);
  console.log(o.join("\n"));
}

function _itHandleNotVisible(e, t) {
  if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
  const o = Memory.roomIntelPending[e];
  if (o && Game.time - o.tick <= 1) {
    console.log("[" + (t ? "IntelFast" : "Intel") + "] ERROR: " + e + " still not visible after observation attempt.");
    delete Memory.roomIntelPending[e];
    return;
  }
  if (Memory.intelPowerObserve && Memory.intelPowerObserve[e]) {
    const t = Memory.intelPowerObserve[e];
    if (Game.time - t.tick <= 50) {
      console.log("[Intel] PWR_OPERATE_OBSERVER in progress — " + t.operatorName + ", elapsed " + (Game.time - t.tick) + "t.");
      return;
    }
    delete Memory.intelPowerObserve[e];
  }
  const n = findObserverInRange(e, _tickUsedSet());
  if (n && _tickObserve(n, e)) {
    Memory.roomIntelPending[e] = {
      tick: Game.time,
      observerRoom: n.room.name,
      fast: t
    };
    console.log("[" + (t ? "IntelFast" : "Intel") + "] Observing " + e + " from " + n.room.name + ". Auto-completing next tick.");
    return;
  }
  const r = tryPowerObserver(e);
  if (r) {
    if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
    Memory.intelPowerObserve[e] = {
      operatorName: r.operatorName,
      operatorRoom: r.operatorRoom,
      tick: Game.time,
      fast: t
    };
    console.log("[Intel] PWR_OPERATE_OBSERVER from " + r.operatorName + " (" + r.operatorRoom + ")");
    return;
  }
  console.log("[" + (t ? "IntelFast" : "Intel") + "] ERROR: " + e + " not visible. No observer in range.");
}

function intel(e) {
  if (!e || typeof e !== "string") {
    console.log('[Intel] Usage: intel("W1N1")');
    return;
  }
  const t = Game.rooms[e];
  if (!t) {
    _itHandleNotVisible(e, false);
    return;
  }
  if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
  delete Memory.roomIntelPending[e];
  if (!_itRoomOwner(t)) {
    _itClearProfile(e, true);
    return _itPrintZeroIntel(t, "room is unowned", false, false);
  }
  if (!_itHasOwnerCreeps(t)) {
    _itClearProfile(e, true);
    console.log("[Intel] No owned creeps in " + e + " — skipping efficiency profile.");
    return _itPrintNoOperations(t, false, false);
  }
  const o = _itGetCachedEff(e);
  if (!o && !_itIsProfileActive(e)) {
    _itStartProfile(e, t);
    console.log("[Intel] Profile started for " + e + ". Full report in ~" + INTEL_PROFILE_TICKS + " ticks.");
    return;
  }
  if (!o && _itIsProfileActive(e)) {
    const t = heap[INTEL_EFF_MEM_KEY][e];
    console.log("[Intel] Profiling " + e + ": " + (t ? t.totals.ticksObserved : 0) + "/" + INTEL_PROFILE_TICKS + " ticks. Report auto-prints when complete.");
    return;
  }
  const n = _itBuildIntelResult(t, o, false, false);
  _itPrintFull(n);
  if (Memory[INTEL_EFF_CACHE_KEY]) delete Memory[INTEL_EFF_CACHE_KEY][e];
  return n;
}

function intelFast(e, t) {
  if (!e || typeof e !== "string") {
    console.log('[IntelFast] Usage: intelFast("W1N1")');
    return null;
  }
  const o = Game.rooms[e];
  if (!o) {
    _itHandleNotVisible(e, true);
    return null;
  }
  if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
  delete Memory.roomIntelPending[e];
  if (!_itRoomOwner(o)) {
    _itClearProfile(e, true);
    return _itPrintZeroIntel(o, "room is unowned", true, !!t);
  }
  const n = !_itHasOwnerCreeps(o);
  if (n) _itClearProfile(e, true);
  const r = n ? _itPrintNoOperations(o, true, true) : _itBuildIntelResult(o, null, true, false);
  if (!t) _itPrintFast(r);
  return r;
}

function listIntel() {
  const e = Memory[INTEL_EFF_CACHE_KEY], t = heap[INTEL_EFF_MEM_KEY];
  const o = e && Object.keys(e).length > 0, n = t && Object.keys(t).length > 0;
  if (!o && !n) {
    console.log("[Intel] No efficiency profiles cached or active.");
    return;
  }
  console.log("\n=== EFFICIENCY PROFILES ===");
  if (n) for (const e in t) {
    const o = t[e];
    console.log("  " + e + ": profiling " + o.totals.ticksObserved + "/" + INTEL_PROFILE_TICKS + " ticks");
  }
  if (o) for (const t in e) {
    const o = e[t];
    console.log("  " + t + ": complete | expires in " + (o.expiresTick - Game.time) + "t");
  }
  console.log("===========================\n");
}

function getCachedIntel(e) {
  if (!e || typeof e !== "string") {
    if (!Memory[INTEL_EFF_CACHE_KEY]) return null;
    const e = [];
    for (const t in Memory[INTEL_EFF_CACHE_KEY]) {
      const o = Memory[INTEL_EFF_CACHE_KEY][t];
      if (o.expiresTick <= Game.time) {
        delete Memory[INTEL_EFF_CACHE_KEY][t];
        continue;
      }
      e.push({
        room: t,
        completedTick: o.completedTick,
        expiresTick: o.expiresTick
      });
    }
    return e;
  }
  const t = Memory[INTEL_EFF_CACHE_KEY] && Memory[INTEL_EFF_CACHE_KEY][e];
  if (!t) return null;
  if (t.expiresTick <= Game.time) {
    delete Memory[INTEL_EFF_CACHE_KEY][e];
    return null;
  }
  return t;
}

function _itCleanExpired() {
  if (Memory[INTEL_EFF_CACHE_KEY]) for (const e in Memory[INTEL_EFF_CACHE_KEY]) if ((Memory[INTEL_EFF_CACHE_KEY][e].expiresTick || 0) <= Game.time) delete Memory[INTEL_EFF_CACHE_KEY][e];
  if (Memory.roomIntelPending) for (const e in Memory.roomIntelPending) if (Game.time - Memory.roomIntelPending[e].tick > 5) delete Memory.roomIntelPending[e];
  if (Memory.intelPowerObserve) for (const e in Memory.intelPowerObserve) if (Game.time - Memory.intelPowerObserve[e].tick > 50) delete Memory.intelPowerObserve[e];
}

function _processPendingIntel() {
  if (!Memory.roomIntelPending) return;
  for (const e in Memory.roomIntelPending) {
    const t = Memory.roomIntelPending[e];
    if (Game.time - t.tick === 1 && Game.rooms[e]) {
      if (t.fast) {
        console.log("[IntelFast] Auto-completing fast intel for " + e);
        intelFast(e);
      } else {
        console.log("[Intel] Auto-completing intel for " + e);
        intel(e);
      }
    }
  }
}

function _itZeroOperations() {
  return {
    score: 0,
    positives: {},
    negatives: {},
    details: {
      ticksObserved: 0,
      invisibleTicks: 0,
      incomePerTick: 0,
      maxIncomePerTick: 0,
      energyCaptureRate: "n/a",
      sourceMaxRates: "n/a",
      maintPerTick: 0,
      spawnPerTick: 0,
      upgradePerTick: 0,
      towerCostPerTick: 0,
      creepRepairShare: "N/A",
      towerRepairActions: 0,
      totalRepairEvents: 0,
      movesPerCreepTick: "n/a",
      avgCreeps: 0,
      cpuPerCreep: "n/a",
      totalIntents: 0,
      productiveRatio: "0%",
      ev_harvest: 0,
      ev_build: 0,
      ev_upgradeController: 0,
      ev_transfer: 0,
      ev_repairAny: 0,
      ev_attack: 0,
      ev_power: 0,
      terminalIn: {},
      terminalOut: {},
      hasTerminal: false
    }
  };
}

function _itBuildIntelResult(e, t, o, n) {
  const r = e.name;
  const s = _roomFingerprint(e);
  const a = _itAnalyzeEco(e, n ? null : t, s);
  const i = _itAnalyzeDefense(e, s);
  const l = _itAnalyzeOffense(e, s);
  const c = _itAnalyzeDP(e, s);
  const u = n ? _itZeroOperations() : o ? null : _itAnalyzeOperational(e, t);
  const m = _itMergeMilAnalyzers(i, l);
  const f = _itCombineScores(r, e, i, l, a, c, u, o);
  const p = _itCalcEcoValue(e, s), E = _itCalcMilValue(e, s), d = _itCalcDPValue(e, s);
  const R = n ? "No measurable operation" : t ? _itClassifyPurpose(e, t.totals) : "Balanced Operation";
  return {
    room: r,
    owner: _itRoomOwner(e) || "Unowned",
    rcl: e.controller ? e.controller.level : 0,
    tick: Game.time,
    overall: f.composite,
    confidence: f.confidence,
    scores: f,
    fast: !!o,
    noOperations: !!n,
    totalValue: p.total + E.total + d.total,
    purpose: R,
    economic: {
      score: f.economy,
      value: p,
      positives: a.positives,
      negatives: a.negatives,
      details: a.details
    },
    defense: {
      score: f.defense,
      positives: i.positives,
      negatives: i.negatives,
      details: i.details
    },
    offense: {
      score: f.offense,
      positives: l.positives,
      negatives: l.negatives,
      details: l.details
    },
    infrastructure: {
      score: f.infrastructure,
      value: d,
      positives: c.positives,
      negatives: c.negatives,
      details: c.details
    },
    operations: u ? {
      score: f.operations,
      positives: u.positives,
      negatives: u.negatives,
      details: u.details
    } : null,
    military: {
      score: f.military,
      value: E,
      positives: m.positives,
      negatives: m.negatives,
      details: m.details
    },
    dualPurpose: {
      score: f.infrastructure,
      value: d,
      positives: c.positives,
      negatives: c.negatives,
      details: c.details
    },
    operational: u ? {
      score: f.operations,
      positives: u.positives,
      negatives: u.negatives,
      details: u.details
    } : null
  };
}

function _itBuildZeroIntelResult(e, t, o) {
  const n = e ? 1 : 0;
  const r = {
    defense: 0,
    offense: 0,
    economy: 0,
    infrastructure: 0,
    operations: 0,
    composite: 0,
    overall: 0,
    economic: 0,
    military: 0,
    dualPurpose: 0,
    confidence: n
  };
  return {
    room: e ? e.name : "?",
    owner: "Unowned",
    rcl: e && e.controller ? e.controller.level : 0,
    tick: Game.time,
    overall: 0,
    confidence: n,
    scores: r,
    fast: !!t,
    zero: true,
    reason: o || "unowned",
    totalValue: 0,
    purpose: "No owned room",
    operations: null,
    operational: null
  };
}

function _itPrintZeroIntel(e, t, o, n) {
  const r = _itBuildZeroIntelResult(e, o, t);
  if (n) return r;
  const s = "════════════════════════════════════════════════════════════════════════════════";
  console.log(s + "\nROOM INTEL" + (o ? " (FAST)" : "") + ": " + r.room + " | Owner: Unowned | RCL: " + r.rcl + " | COMPOSITE: 0/100 | CONFIDENCE: " + r1(r.confidence * 100) + "%\n" + s + "\nSCORES: Defense 0 | Offense 0 | Economy 0 | Infrastructure 0 | Operations 0 | Composite 0\nUNOWNED ROOM: no player strength to measure. All scores are 0.\n" + s);
  return r;
}

function _itPrintNoOperations(e, t, o) {
  const n = _itBuildIntelResult(e, null, !!t, true);
  if (!o) {
    if (t) _itPrintFast(n); else _itPrintFull(n);
  }
  return n;
}

function _itRunSilent(e) {
  const t = _roomFingerprint(e);
  const o = _itAnalyzeEco(e, null, t), n = _itAnalyzeDefense(e, t), r = _itAnalyzeOffense(e, t), s = _itAnalyzeDP(e, t), a = _itMergeMilAnalyzers(n, r);
  const i = _itCombineScores(e.name, e, n, r, o, s, null, true);
  const l = _itCalcEcoValue(e, t), c = _itCalcMilValue(e, t), u = _itCalcDPValue(e, t);
  const m = _fpByType(t, STRUCTURE_TOWER);
  const f = _fpByType(t, STRUCTURE_NUKER)[0];
  const p = e.storage, E = _fpByType(t, STRUCTURE_TERMINAL)[0];
  const d = _fpByType(t, STRUCTURE_RAMPART);
  const R = _fpByType(t, STRUCTURE_WALL);
  const _ = d.concat(R);
  const g = d.filter(e => e.hits < 1e5);
  const y = _itOwnerCreeps(e, t);
  let T = false, S = false, h = 0, C = 0;
  let O = 0;
  if (f) {
    const e = _itNukerCharge(f);
    h = e.energy;
    C = e.ghodium;
    T = e.full;
    O = e.fraction * 100;
    S = !e.full && (e.energy > 0 || e.ghodium > 0);
  }
  const N = r.details.combatBoostTotal;
  const P = t.sources, M = t.minerals[0];
  const w = _fpByType(t, STRUCTURE_LINK), A = _fpByType(t, STRUCTURE_CONTAINER);
  let k = 0;
  for (const e of P) if (e.pos.findInRange(w, 3).length > 0 || e.pos.findInRange(A, 3).length > 0) k++;
  const b = _itOwnerPowerCreeps(e, t);
  const v = y.filter(e => e.body.some(e => e.boost));
  const I = y.filter(e => e.body.some(e => e.type === ATTACK || e.type === RANGED_ATTACK || e.type === HEAL));
  const U = new Set;
  if (p && p.store) Object.keys(p.store).filter(e => p.store[e] > 0).forEach(e => U.add(e));
  if (E && E.store) Object.keys(E.store).filter(e => E.store[e] > 0).forEach(e => U.add(e));
  const L = _fpByType(t, STRUCTURE_POWER_SPAWN)[0];
  const F = _fpByType(t, STRUCTURE_FACTORY)[0];
  return {
    room: e.name,
    owner: e.controller && e.controller.owner ? e.controller.owner.username : "Unowned",
    rcl: e.controller ? e.controller.level : 0,
    tick: Game.time,
    confidence: i.confidence,
    scores: i,
    structures: {
      spawns: _fpByType(t, STRUCTURE_SPAWN).length,
      extensions: _fpByType(t, STRUCTURE_EXTENSION).length,
      towers: m.length,
      storage: !!p,
      terminal: !!E,
      nuker: !!f,
      nukerReady: T,
      nukerCharging: S,
      nukerEnergy: h,
      nukerGhodium: C,
      nukerChargePercent: O,
      factory: !!F,
      factoryLevel: F && F.level || 0,
      labs: _fpByType(t, STRUCTURE_LAB).length,
      powerSpawn: !!L,
      observer: !!_fpByType(t, STRUCTURE_OBSERVER)[0],
      ramparts: d.length,
      walls: R.length,
      links: w.length,
      activeSpawns: _fpByType(t, STRUCTURE_SPAWN).filter(e => !!e.spawning).length
    },
    resources: {
      storageEnergy: p ? p.store[RESOURCE_ENERGY] || 0 : 0,
      storageTotal: p ? p.store.getUsedCapacity() : 0,
      terminalEnergy: E ? E.store[RESOURCE_ENERGY] || 0 : 0,
      terminalTotal: E ? E.store.getUsedCapacity() : 0,
      power: (p ? p.store[RESOURCE_POWER] || 0 : 0) + (E ? E.store[RESOURCE_POWER] || 0 : 0) + (L && L.store ? L.store[RESOURCE_POWER] || 0 : 0),
      combatBoosts: N,
      resourceDiversity: U.size
    },
    defense: {
      avgDefenseHits: _.length > 0 ? Math.round(_.reduce((e, t) => e + t.hits, 0) / _.length) : 0,
      minDefenseHits: _.length > 0 ? Math.min(..._.map(e => e.hits)) : 0,
      weakRamparts: g.length,
      safeModeAvailable: e.controller ? e.controller.safeModeAvailable || 0 : 0,
      safeModeCooldown: e.controller ? e.controller.safeModeCooldown || 0 : 0
    },
    creeps: {
      total: y.length,
      military: I.length,
      boosted: v.length,
      large: y.filter(e => e.body.length >= 30).length,
      maxSize: y.length > 0 ? Math.max(...y.map(e => e.body.length)) : 0,
      powerCreeps: b.length
    },
    controller: {
      level: e.controller ? e.controller.level : 0,
      progress: e.controller ? e.controller.progress : 0,
      progressTotal: e.controller ? e.controller.progressTotal : 0,
      progressPercent: e.controller && e.controller.progressTotal > 0 ? Math.round(e.controller.progress / e.controller.progressTotal * 1e3) / 10 : 0,
      downgradeTimer: e.controller ? e.controller.ticksToDowngrade : 0
    },
    economy: {
      energyAvailable: e.energyAvailable,
      energyCapacity: e.energyCapacityAvailable,
      sources: P.length,
      mineral: M ? M.mineralType : null,
      mineralAmount: M ? M.mineralAmount : 0
    }
  };
}

function _enGetPrev(e) {
  return global[ENERGY_EFF_GLOBAL_PREV] && global[ENERGY_EFF_GLOBAL_PREV][e] || null;
}

function _enSetPrev(e, t) {
  if (!global[ENERGY_EFF_GLOBAL_PREV]) global[ENERGY_EFF_GLOBAL_PREV] = {};
  global[ENERGY_EFF_GLOBAL_PREV][e] = t;
}

function _enClearPrev(e) {
  if (global[ENERGY_EFF_GLOBAL_PREV]) delete global[ENERGY_EFF_GLOBAL_PREV][e];
}

function _enClearAllPrev() {
  delete global[ENERGY_EFF_GLOBAL_PREV];
}

function _enTakeSnap(e) {
  const t = {
    sources: {},
    towers: {},
    labs: {},
    links: {},
    spawns: {},
    terminal: null,
    nuker: null,
    powerSpawn: null,
    tombstones: {},
    drops: {},
    creepIds: {},
    creepNames: {},
    roomTotal: 0
  };
  for (const o of e.find(FIND_SOURCES)) t.sources[o.id] = o.energy;
  for (const o of e.find(FIND_STRUCTURES)) {
    const e = o.store && o.store[RESOURCE_ENERGY] || 0;
    switch (o.structureType) {
     case STRUCTURE_TOWER:
      t.towers[o.id] = e;
      t.roomTotal += e;
      break;
     case STRUCTURE_LAB:
      t.labs[o.id] = e;
      t.roomTotal += e;
      break;
     case STRUCTURE_LINK:
      t.links[o.id] = e;
      t.roomTotal += e;
      break;
     case STRUCTURE_TERMINAL:
      t.terminal = {
        id: o.id,
        energy: e
      };
      t.roomTotal += e;
      break;
     case STRUCTURE_NUKER:
      t.nuker = {
        id: o.id,
        energy: e
      };
      t.roomTotal += e;
      break;
     case STRUCTURE_POWER_SPAWN:
      t.powerSpawn = {
        id: o.id,
        energy: e
      };
      t.roomTotal += e;
      break;
     case STRUCTURE_SPAWN:
      {
        const n = o.spawning;
        t.spawns[o.id] = n ? {
          name: n.name
        } : null;
        t.roomTotal += e;
        break;
      }
     default:
      if (o.store) t.roomTotal += e;
      break;
    }
  }
  for (const o of e.find(FIND_CREEPS)) {
    t.roomTotal += o.store && o.store[RESOURCE_ENERGY] || 0;
    t.creepIds[o.id] = {
      name: o.name,
      body: o.body,
      my: o.my
    };
    t.creepNames[o.name] = {
      id: o.id,
      body: o.body,
      my: o.my
    };
  }
  for (const o of e.find(FIND_POWER_CREEPS)) {
    t.roomTotal += o.store && o.store[RESOURCE_ENERGY] || 0;
  }
  for (const o of e.find(FIND_TOMBSTONES)) {
    const e = o.store && o.store[RESOURCE_ENERGY] || 0;
    t.tombstones[o.id] = {
      energy: e,
      creepName: o.creep ? o.creep.name : null,
      creepId: o.creep ? o.creep.id : null
    };
    t.roomTotal += e;
  }
  for (const o of e.find(FIND_RUINS)) {
    t.roomTotal += o.store && o.store[RESOURCE_ENERGY] || 0;
  }
  for (const o of e.find(FIND_DROPPED_RESOURCES, {
    filter: e => e.resourceType === RESOURCE_ENERGY
  })) {
    t.drops[o.id] = o.amount;
    t.roomTotal += o.amount;
  }
  return t;
}

function _enInitTotals() {
  return {
    ticksObserved: 0,
    invisibleTicks: 0,
    sourceMaxRates: {},
    sourceHarvested: {},
    sourceNames: {},
    towerSpend: {},
    labSpend: {},
    linkSpend: {},
    terminalSpend: 0,
    terminalReceived: 0,
    nukerSpend: 0,
    powerSpawnSpend: 0,
    linkDeposits: 0,
    linkWithdraws: 0,
    linkNetDelta: 0,
    creepToTerminal: 0,
    creepFromTerminal: 0,
    workSpawnCost: 0,
    nonWorkSpawnCost: 0,
    initialRoomTotal: 0,
    finalRoomTotal: 0
  };
}

function _enNewLedgerEntry(e, t, o, n, r, s) {
  return {
    id: e,
    name: t,
    role: n,
    bodySig: _bpSig(o),
    bodyCost: _bpCostOf(o),
    ticksFirstSeen: s,
    ticksLastSeen: s,
    harvested: 0,
    upgraded: 0,
    built: 0,
    repaired: 0,
    diedAtTick: null,
    diedLoaded: 0,
    tombstoneId: null,
    tombstoneFinalEnergy: null,
    tombstoneLooted: 0,
    tombstoneDespawned: null,
    preExisting: !!r
  };
}

function _enProcessEvents(e, t, o, n, r, s) {
  if (!e || !e.length) return;
  for (const a of e) {
    const e = a.objectId;
    const i = a.data || {};
    switch (a.event) {
     case EV_HARVEST:
      {
        const n = i.amount || 0;
        if (i.targetId && t.sourceMaxRates[i.targetId] !== undefined) {
          t.sourceHarvested[i.targetId] = (t.sourceHarvested[i.targetId] || 0) + n;
          if (e && o[e]) o[e].harvested += n;
        }
        break;
      }
     case EV_UPGRADE_CONTROLLER:
      {
        const t = i.amount || 0;
        if (e && o[e]) o[e].upgraded += t;
        break;
      }
     case EV_BUILD:
      {
        const t = typeof i.energySpent === "number" && i.energySpent > 0 ? i.energySpent : i.amount || 0;
        if (e && o[e]) o[e].built += t;
        break;
      }
     case EV_REPAIR:
      {
        if (n.has(e)) break;
        let t;
        if (typeof i.energySpent === "number") {
          t = i.energySpent;
        } else {
          t = (i.amount || 0) * (typeof REPAIR_COST !== "undefined" ? REPAIR_COST : .01);
        }
        if (e && o[e]) o[e].repaired += t;
        break;
      }
     case EV_TRANSFER:
      {
        if (i.resourceType !== RESOURCE_ENERGY) break;
        const o = i.amount || 0;
        if (r.has(i.targetId)) t.linkDeposits += o;
        if (r.has(e)) t.linkWithdraws += o;
        if (s && i.targetId === s) t.creepToTerminal += o;
        if (s && e === s) t.creepFromTerminal += o;
        break;
      }
     default:
      break;
    }
  }
}

function _enAccumulate(e, t, o, n) {
  const r = n.totals;
  const s = n.creepLedger;
  const a = new Set;
  for (const o in t.towers) {
    a.add(o);
    if (e.towers[o] !== undefined) {
      const n = Math.max(0, e.towers[o] - t.towers[o]);
      if (n > 0) r.towerSpend[o] = (r.towerSpend[o] || 0) + n;
    }
  }
  for (const o in t.labs) {
    if (e.labs[o] !== undefined) {
      const n = Math.max(0, e.labs[o] - t.labs[o]);
      if (n > 0) r.labSpend[o] = (r.labSpend[o] || 0) + n;
    }
  }
  const i = new Set;
  for (const o in t.links) {
    i.add(o);
    if (e.links[o] !== undefined) {
      const n = Math.max(0, e.links[o] - t.links[o]);
      if (n > 0) r.linkSpend[o] = (r.linkSpend[o] || 0) + n;
      r.linkNetDelta += t.links[o] - e.links[o];
    }
  }
  let l = null;
  if (t.terminal) {
    l = t.terminal.id;
    if (e.terminal) {
      const o = Math.max(0, e.terminal.energy - t.terminal.energy);
      const n = Math.max(0, t.terminal.energy - e.terminal.energy);
      r.terminalSpend += o;
      r.terminalReceived += n;
    }
  }
  if (t.nuker && e.nuker) {
    r.nukerSpend += Math.max(0, e.nuker.energy - t.nuker.energy);
  }
  if (t.powerSpawn && e.powerSpawn) {
    r.powerSpawnSpend += Math.max(0, e.powerSpawn.energy - t.powerSpawn.energy);
  }
  for (const o in t.spawns) {
    const s = t.spawns[o];
    const a = e.spawns[o];
    const i = s ? s.name : null;
    const l = a ? a.name : null;
    if (!i || i === l) continue;
    const c = t.creepNames[i];
    if (!c || !c.body || !c.body.length) {
      n.pendingSpawnNames = n.pendingSpawnNames || {};
      n.pendingSpawnNames[i] = Game.time;
      continue;
    }
    const u = _bpCostOf(c.body);
    const m = _bpHasWork(c.body);
    if (m) {
      r.workSpawnCost += u;
      n.spawnedNames[i] = {
        role: "pending",
        bodyCost: u,
        bodySig: _bpSig(c.body)
      };
    } else {
      r.nonWorkSpawnCost += u;
      n.nonWorkNames[i] = true;
    }
  }
  if (n.pendingSpawnNames) {
    for (const e in n.pendingSpawnNames) {
      const o = t.creepNames[e];
      if (!o || !o.body || !o.body.length) continue;
      const s = _bpCostOf(o.body);
      const a = _bpHasWork(o.body);
      if (a) {
        r.workSpawnCost += s;
        n.spawnedNames[e] = {
          role: "pending",
          bodyCost: s,
          bodySig: _bpSig(o.body)
        };
      } else {
        r.nonWorkSpawnCost += s;
        n.nonWorkNames[e] = true;
      }
      delete n.pendingSpawnNames[e];
    }
  }
  for (const e in t.creepIds) {
    const o = t.creepIds[e];
    if (s[e]) {
      s[e].ticksLastSeen = Game.time;
      continue;
    }
    if (n.nonWorkNames[o.name]) continue;
    if (!_bpHasWork(o.body)) continue;
    const r = n.spawnedNames[o.name];
    const a = !r;
    const i = _bpInferRole(o.body);
    s[e] = _enNewLedgerEntry(e, o.name, o.body, i, a, Game.time);
    if (r) delete n.spawnedNames[o.name];
  }
  for (const o in s) {
    const r = s[o];
    if (r.diedAtTick !== null) continue;
    if (t.creepIds[o]) continue;
    if (!e.creepIds[o]) continue;
    r.diedAtTick = Game.time;
    for (const e in t.tombstones) {
      const s = t.tombstones[e];
      if (s.creepId === o || s.creepName === r.name) {
        r.tombstoneId = e;
        r.diedLoaded = s.energy;
        n.tombstoneToLedger[e] = o;
        break;
      }
    }
  }
  for (const o in n.tombstoneToLedger) {
    const r = n.tombstoneToLedger[o];
    const a = s[r];
    if (!a) continue;
    const i = e.tombstones[o];
    const l = t.tombstones[o];
    if (l) {
      const e = i ? Math.max(0, i.energy - l.energy) : 0;
      a.tombstoneLooted += e;
      a.tombstoneFinalEnergy = l.energy;
    } else {
      if (i) {
        a.tombstoneFinalEnergy = 0;
        a.tombstoneDespawned = i.energy > 0;
      }
      delete n.tombstoneToLedger[o];
    }
  }
  let c;
  try {
    c = JSON.parse(o.getEventLog(true));
  } catch (e) {
    c = o.getEventLog();
  }
  _enProcessEvents(c, r, s, a, i, l);
  r.ticksObserved++;
  r.finalRoomTotal = t.roomTotal;
}

function _enEnsureObserved(e) {
  if (Game.rooms[e]) {
    const t = findObserverInRange(e, _tickUsedSet());
    if (t) _tickObserve(t, e);
    return;
  }
  if (Memory[ENERGY_POWER_OBS_KEY] && Memory[ENERGY_POWER_OBS_KEY][e]) {
    const t = Memory[ENERGY_POWER_OBS_KEY][e];
    if (Game.time - t.tick <= 50) return;
    delete Memory[ENERGY_POWER_OBS_KEY][e];
  }
  const t = findObserverInRange(e, _tickUsedSet());
  if (t && _tickObserve(t, e)) {
    if (!Memory[ENERGY_PENDING_KEY]) Memory[ENERGY_PENDING_KEY] = {};
    Memory[ENERGY_PENDING_KEY][e] = {
      tick: Game.time,
      observerRoom: t.room.name
    };
    return;
  }
  const o = tryPowerObserver(e);
  if (o) {
    if (!Memory[ENERGY_POWER_OBS_KEY]) Memory[ENERGY_POWER_OBS_KEY] = {};
    Memory[ENERGY_POWER_OBS_KEY][e] = {
      operatorName: o.operatorName,
      operatorRoom: o.operatorRoom,
      tick: Game.time
    };
  }
}

function _enRoomIsOwn(e) {
  const t = Game.rooms[e];
  return !!(t && t.controller && t.controller.my);
}

function _enStartProfile(e) {
  if (!e || typeof e !== "string" || !ENERGY_ROOM_NAME_RE.test(e)) {
    console.log('[EnergyProfiler] Usage: profileEnergy("W5N3")');
    return;
  }
  if (Memory[ENERGY_EFF_MEM_KEY] && Memory[ENERGY_EFF_MEM_KEY].active) {
    console.log("[EnergyProfiler] Already active for " + Memory[ENERGY_EFF_MEM_KEY].roomName + ". Call cancelEnergyProfile() first.");
    return;
  }
  if (heap[INTEL_EFF_MEM_KEY] && heap[INTEL_EFF_MEM_KEY][e] && heap[INTEL_EFF_MEM_KEY][e].active) {
    console.log("[EnergyProfiler] intel() is currently profiling " + e + " — cancel it first or pick a different room.");
    return;
  }
  const t = _enRoomIsOwn(e);
  if (t) {
    const t = Game.rooms[e];
    if (!t) {
      console.log("[EnergyProfiler] ERROR: " + e + " not visible.");
      return;
    }
    console.log("[EnergyProfiler] " + e + " is your room — no observer needed.");
    Memory[ENERGY_EFF_MEM_KEY] = {
      active: true,
      phase: "profiling",
      roomName: e,
      startTick: Game.time,
      ownRoom: true,
      observerCount: 0,
      totals: _enInitTotals(),
      creepLedger: {},
      spawnedNames: {},
      nonWorkNames: {},
      pendingSpawnNames: {},
      tombstoneToLedger: {},
      notifyQueue: [],
      notifySent: 0
    };
    const o = (ENERGY_PROFILE_TICKS / 3600).toFixed(1);
    console.log("[EnergyProfiler] Started — " + e + " for " + ENERGY_PROFILE_TICKS + " ticks (~" + o + " hours wall-clock).");
    return;
  }
  if (!obsInRange(e)) {
    console.log("[EnergyProfiler] ERROR: no observer within 10 rooms of " + e + ".");
    return;
  }
  console.log("[EnergyProfiler] " + e + " is foreign — observation handled by _enEnsureObserved each tick.");
  Memory[ENERGY_EFF_MEM_KEY] = {
    active: true,
    phase: "awaiting-visibility",
    roomName: e,
    startTick: Game.time,
    ownRoom: false,
    observerCount: 0,
    totals: _enInitTotals(),
    creepLedger: {},
    spawnedNames: {},
    nonWorkNames: {},
    pendingSpawnNames: {},
    tombstoneToLedger: {},
    notifyQueue: [],
    notifySent: 0
  };
}

function _enTickRoom(e) {
  const t = e.roomName;
  const o = e.ownRoom;
  if (!o) _enEnsureObserved(t);
  const n = Game.rooms[t];
  if (!n) {
    e.totals.invisibleTicks++;
    return false;
  }
  if (!o && e.totals.ticksObserved === 0 && Object.keys(e.totals.sourceMaxRates).length === 0) {
    const o = n.find(FIND_SOURCES);
    let r = 1;
    for (const t of o) {
      e.totals.sourceMaxRates[t.id] = _itSourceMaxRate(t);
      e.totals.sourceHarvested[t.id] = 0;
      e.totals.sourceNames[t.id] = "S" + r++;
    }
    const s = _enTakeSnap(n);
    e.totals.initialRoomTotal = s.roomTotal;
    e.totals.finalRoomTotal = s.roomTotal;
    _enSetPrev(t, s);
    e.phase = "profiling";
    console.log("[EnergyProfiler] Baseline — " + t + " @ tick " + Game.time);
    return false;
  }
  const r = _enTakeSnap(n);
  const s = _enGetPrev(t);
  if (!s) {
    _enSetPrev(t, r);
    console.log("[EnergyProfiler] Baseline — " + t + " @ tick " + Game.time);
    return false;
  }
  _enAccumulate(s, r, n, e);
  _enSetPrev(t, r);
  const a = e.totals.ticksObserved;
  if (a > 0 && a % ENERGY_LOG_INTERVAL === 0 && a < ENERGY_PROFILE_TICKS) {
    const o = Game.time - e.startTick;
    const n = Math.round(o * (ENERGY_PROFILE_TICKS - a) / Math.max(1, a));
    console.log("[EnergyProfiler] " + t + " — " + a + "/" + ENERGY_PROFILE_TICKS + " diff ticks  (elapsed " + o + ", ETA ~" + n + " ticks)");
  }
  return a >= ENERGY_PROFILE_TICKS;
}

function _enFinalise(e, t) {
  const o = _enPrintReport(e, t);
  e.phase = "notifying";
  e.notifyQueue = _enSplitNotifications(o, e.roomName);
  e.notifySent = 0;
  _enClearPrev(e.roomName);
  if (Memory[ENERGY_PENDING_KEY]) delete Memory[ENERGY_PENDING_KEY][e.roomName];
  if (Memory[ENERGY_POWER_OBS_KEY]) delete Memory[ENERGY_POWER_OBS_KEY][e.roomName];
}

function _enCleanExpired() {
  if (Memory[ENERGY_EFF_CACHE_KEY]) for (const e in Memory[ENERGY_EFF_CACHE_KEY]) if ((Memory[ENERGY_EFF_CACHE_KEY][e].expiresTick || 0) <= Game.time) delete Memory[ENERGY_EFF_CACHE_KEY][e];
  if (Memory[ENERGY_PENDING_KEY]) for (const e in Memory[ENERGY_PENDING_KEY]) if (Game.time - Memory[ENERGY_PENDING_KEY][e].tick > 5) delete Memory[ENERGY_PENDING_KEY][e];
  if (Memory[ENERGY_POWER_OBS_KEY]) for (const e in Memory[ENERGY_POWER_OBS_KEY]) if (Game.time - Memory[ENERGY_POWER_OBS_KEY][e].tick > 50) delete Memory[ENERGY_POWER_OBS_KEY][e];
}

function _enGetCached(e) {
  if (!Memory[ENERGY_EFF_CACHE_KEY] || !Memory[ENERGY_EFF_CACHE_KEY][e]) return null;
  const t = Memory[ENERGY_EFF_CACHE_KEY][e];
  if (t.expiresTick <= Game.time) {
    delete Memory[ENERGY_EFF_CACHE_KEY][e];
    return null;
  }
  return t;
}

function _enProcessProfiles() {
  const e = Memory[ENERGY_EFF_MEM_KEY];
  if (!e || !e.active) return;
  if (e.phase === "notifying") {
    _enRunNotifyPhase(e);
    return;
  }
  const t = _enTickRoom(e);
  if (t) _enFinalise(e, false);
}

function energyStart(e) {
  _enStartProfile(e);
}

function energyCancel() {
  const e = Memory[ENERGY_EFF_MEM_KEY];
  if (!e) {
    console.log("[EnergyProfiler] Nothing active.");
    return;
  }
  if (e.phase === "notifying") {
    console.log("[EnergyProfiler] Cancelling pending notifications (" + (e.notifyQueue.length - e.notifySent) + " remaining).");
    _enClearAllPrev();
    delete Memory[ENERGY_EFF_MEM_KEY];
    return;
  }
  console.log("[EnergyProfiler] Cancelling — printing partial results for " + e.roomName + " after " + e.totals.ticksObserved + " ticks.");
  if (e.totals.ticksObserved > 0) {
    const t = _enPrintReport(e, true);
    e.phase = "notifying";
    e.notifyQueue = _enSplitNotifications(t, e.roomName);
    e.notifySent = 0;
    _enClearAllPrev();
    return;
  }
  _enClearAllPrev();
  delete Memory[ENERGY_EFF_MEM_KEY];
}

function energyRun() {
  const e = Memory[ENERGY_EFF_MEM_KEY];
  if (!e || !e.active) return;
  if (e.phase === "notifying") {
    _enRunNotifyPhase(e);
    return;
  }
  const t = _enTickRoom(e);
  if (t) _enFinalise(e, false);
}

function energyStatus() {
  const e = Memory[ENERGY_EFF_MEM_KEY];
  if (!e || !e.active) {
    console.log("[EnergyProfiler] No active profile.");
    return null;
  }
  if (e.phase === "notifying") {
    const t = e.notifyQueue.length - e.notifySent;
    console.log("[EnergyProfiler] " + e.roomName + " — notifying: " + e.notifySent + "/" + e.notifyQueue.length + " sent (" + t + " remaining)");
    return e;
  }
  const t = e.totals;
  const o = t.ticksObserved;
  const n = (o / ENERGY_PROFILE_TICKS * 100).toFixed(1);
  const r = Game.time - e.startTick;
  const s = o > 0 ? Math.round(r * (ENERGY_PROFILE_TICKS - o) / o) : "?";
  const a = Object.keys(e.creepLedger).length;
  const i = Object.values(e.creepLedger).filter(e => e.diedAtTick === null).length;
  const l = Object.values(t.sourceHarvested).reduce((e, t) => e + t, 0);
  const c = o > 0 ? l / o : 0;
  const sumVals = e => Object.values(e).reduce((e, t) => e + t, 0);
  const u = sumVals(t.towerSpend) + sumVals(t.labSpend) + t.nukerSpend + t.powerSpawnSpend + Math.max(0, t.terminalSpend - t.creepFromTerminal);
  console.log("[EnergyProfiler] " + e.roomName + "  [" + (e.ownRoom ? "own" : "foreign") + "]");
  console.log("  Progress  : " + o + "/" + ENERGY_PROFILE_TICKS + " (" + n + "%)" + "   invis=" + t.invisibleTicks);
  console.log("  Elapsed   : " + r + " ticks   ETA " + s + " ticks");
  console.log("  Income    : ~" + c.toFixed(2) + " E/tick  (total " + Math.round(l) + ")");
  console.log("  Bldg spend: ~" + (o > 0 ? (u / o).toFixed(2) : "0") + " E/tick  (total " + Math.round(u) + ")");
  console.log("  WORK creeps: " + a + " tracked  (" + i + " alive)");
  console.log("  Spawn cost: work " + t.workSpawnCost + "   non-work " + t.nonWorkSpawnCost);
  return e;
}

function _enCommonPrefixLen(e, t) {
  const o = Math.min(e.length, t.length);
  let n = 0;
  while (n < o && e.charAt(n) === t.charAt(n)) n++;
  return n;
}

function _enGroupCreeps(e, t) {
  const o = t !== undefined ? t : ENERGY_SIMILARITY_THRESHOLD;
  const n = [];
  for (const t of e) {
    const e = t.name || t.id || "";
    if (!e) continue;
    let r = false;
    for (const s of n) {
      const n = _enCommonPrefixLen(e, s.prefix);
      const a = n / e.length;
      const i = n / s.prefix.length;
      if (a >= o && i >= o) {
        s.prefix = e.slice(0, n);
        s.members.push(t);
        r = true;
        break;
      }
    }
    if (!r) n.push({
      prefix: e,
      members: [ t ]
    });
  }
  for (const e of n) {
    const t = e.members.every(t => (t.name || t.id || "") === e.prefix);
    e.label = t ? e.prefix : e.prefix + "*";
  }
  return n;
}

function _enAggregateGroup(e) {
  const t = e.members;
  const o = t.reduce((e, t) => e + (t.harvested || 0), 0);
  const n = t.reduce((e, t) => e + (t.upgraded || 0), 0);
  const r = t.reduce((e, t) => e + (t.built || 0), 0);
  const s = t.reduce((e, t) => e + (t.repaired || 0), 0);
  const a = t.reduce((e, t) => e + (t.bodyCost || 0), 0);
  const i = o + n + r + s;
  const l = {}, c = {};
  for (const e of t) {
    l[e.bodySig || "?"] = (l[e.bodySig || "?"] || 0) + 1;
    c[e.role || "?"] = (c[e.role || "?"] || 0) + 1;
  }
  const u = Object.entries(l).sort((e, t) => t[1] - e[1]);
  const m = Object.entries(c).sort((e, t) => t[1] - e[1]);
  const f = u.length > 1 ? u[0][0] + "+" : u[0][0];
  const p = m.length > 1 ? m[0][0] + "+" : m[0][0];
  const E = t.filter(e => e.preExisting).length;
  const d = t.filter(e => e.diedAtTick !== null).length;
  const R = t.reduce((e, t) => e + (t.tombstoneDespawned ? Math.max(0, (t.diedLoaded || 0) - (t.tombstoneLooted || 0)) : 0), 0);
  return {
    label: e.label,
    count: t.length,
    bodySig: f,
    role: p,
    bodyCost: a,
    harvested: o,
    upgraded: n,
    built: r,
    repaired: s,
    total: i,
    numPreExisting: E,
    numDied: d,
    tombstoneLoss: R,
    members: t
  };
}

function _enF2(e) {
  return e.toFixed(2);
}

function _enPct(e) {
  return (e * 100).toFixed(1) + "%";
}

function _enFmtNum(e) {
  if (Math.abs(e) >= 1e6) return (e / 1e6).toFixed(2) + "M";
  if (Math.abs(e) >= 1e3) return (e / 1e3).toFixed(1) + "k";
  return Math.round(e).toString();
}

function _enFmtPctSafe(e, t) {
  if (t === 0) return "   —";
  return (e / t * 100).toFixed(1) + "%";
}

function _enShortId(e) {
  if (!e) return "?";
  return e.length > 6 ? e.slice(-6) : e;
}

function _enPadR(e, t) {
  e = String(e);
  return e.length >= t ? e.slice(0, t) : e + " ".repeat(t - e.length);
}

function _enPadL(e, t) {
  e = String(e);
  return e.length >= t ? e.slice(0, t) : " ".repeat(t - e.length) + e;
}

function _enBuildReport(e, t) {
  const o = e.totals;
  const n = Math.max(1, o.ticksObserved);
  const r = e.creepLedger;
  const s = e.ownRoom;
  const a = Game.time - e.startTick;
  const i = Object.values(o.sourceHarvested).reduce((e, t) => e + t, 0);
  const l = Object.values(o.sourceMaxRates).reduce((e, t) => e + t, 0);
  const c = Math.min(i / n, l);
  const u = [];
  for (const e in o.sourceMaxRates) {
    const t = o.sourceHarvested[e] || 0;
    const r = o.sourceMaxRates[e];
    const s = r > 0 ? Math.min(1, t / (n * r)) : 0;
    u.push({
      label: o.sourceNames[e] + " " + _enShortId(e),
      harvested: t,
      rate: t / n,
      maxRate: r,
      util: s
    });
  }
  u.sort((e, t) => t.harvested - e.harvested);
  const sumVals = e => Object.values(e).reduce((e, t) => e + t, 0);
  const m = Math.max(0, o.linkDeposits - o.linkWithdraws - o.linkNetDelta);
  const f = Math.max(0, o.terminalSpend - o.creepFromTerminal);
  const p = Math.max(0, o.terminalReceived - o.creepToTerminal);
  const E = sumVals(o.towerSpend);
  const d = sumVals(o.labSpend);
  const R = Object.values(r).map(e => {
    const t = e.upgraded + e.built + e.repaired;
    return Object.assign({}, e, {
      lifetimeSpend: t,
      netCost: e.preExisting ? t : e.bodyCost + t,
      roi: e.bodyCost > 0 ? (e.harvested + t) / e.bodyCost : 0,
      ticksAlive: (e.diedAtTick || Game.time) - e.ticksFirstSeen + 1
    });
  });
  const _ = R.reduce((e, t) => e + t.upgraded + t.built + t.repaired, 0);
  const g = R.reduce((e, t) => e + (t.tombstoneDespawned ? Math.max(0, t.diedLoaded - t.tombstoneLooted) : 0), 0);
  const y = _enGroupCreeps(R).map(_enAggregateGroup).sort((e, t) => t.total - e.total);
  const T = o.finalRoomTotal - o.initialRoomTotal;
  const S = E + d + m + f + o.nukerSpend + o.powerSpawnSpend + o.workSpawnCost + o.nonWorkSpawnCost + _;
  const h = i + p - T - S;
  const C = [];
  if (f > 0) C.push({
    label: "Terminal (export)",
    energy: f
  });
  C.push({
    label: "Loss (unattributed)",
    energy: h
  });
  if (_ > 0) C.push({
    label: "Creep work actions",
    energy: _
  });
  if (o.nonWorkSpawnCost > 0) C.push({
    label: "Non-WORK spawn cost",
    energy: o.nonWorkSpawnCost
  });
  if (o.workSpawnCost > 0) C.push({
    label: "WORK spawn cost",
    energy: o.workSpawnCost
  });
  if (m > 0) C.push({
    label: "Link network loss",
    energy: m
  });
  if (E > 0) C.push({
    label: "Towers",
    energy: E
  });
  if (d > 0) C.push({
    label: "Labs",
    energy: d
  });
  if (o.nukerSpend > 0) C.push({
    label: "Nuker",
    energy: o.nukerSpend
  });
  if (o.powerSpawnSpend > 0) C.push({
    label: "Power Spawn",
    energy: o.powerSpawnSpend
  });
  C.sort((e, t) => t.energy - e.energy);
  const O = C.filter(e => e.energy > 0).reduce((e, t) => e + t.energy, 0);
  const N = i + p - T;
  const P = h < 0;
  const M = Math.max(1, P ? O : N);
  const w = P ? "gross outflow" : "total";
  const A = 78;
  const k = "─".repeat(A);
  const b = [];
  b.push("╬" + "═".repeat(A) + "╬");
  b.push("  ENERGY PROFILE — " + e.roomName + "  [" + (s ? "OWN ROOM" : "FOREIGN ROOM") + "]" + (t ? "   ⚠ PARTIAL" : ""));
  b.push("  " + n + " / " + ENERGY_PROFILE_TICKS + " diff ticks   " + "(game " + e.startTick + "→" + (e.startTick + a) + ", invisible=" + o.invisibleTicks + ")");
  b.push(k);
  b.push("  ── INCOME ──");
  b.push("  Harvested: " + _enFmtNum(i) + " E   (" + _enF2(i / n) + "/tick, capped at " + _enF2(l) + "   util " + _enPct(l > 0 ? c / l : 0) + ")");
  for (const e of u) {
    b.push("    " + _enPadR(e.label, 18) + "  " + _enPadL(_enFmtNum(e.harvested), 8) + " E   " + _enPadL(_enF2(e.rate), 6) + " / " + _enF2(e.maxRate) + " E/t   " + _enPadL(_enPct(e.util), 7));
  }
  b.push(k);
  const v = P ? "gross outflow " + _enFmtNum(O) + " E (loss " + _enFmtNum(h) + " reconciles to net " + _enFmtNum(N) + ")" : _enFmtNum(N) + " E   (" + _enF2(N / n) + "/tick)";
  b.push("  ── TOTAL CONSUMPTION ── " + v);
  b.push("    " + _enPadR("Sink", 28) + _enPadL("Energy", 10) + "   " + _enPadL("% " + w, 14) + "   /tick");
  for (const e of C) {
    const t = e.label.indexOf("Loss") === 0;
    const o = t && P ? "reconciles" : _enFmtPctSafe(e.energy, M);
    b.push("    " + _enPadR(e.label, 28) + _enPadL(_enFmtNum(e.energy), 10) + "   " + _enPadL(o, 14) + "   " + _enPadL(_enF2(e.energy / n), 7));
  }
  b.push(k);
  const I = y.reduce((e, t) => e + t.total, 0);
  b.push("  ── CREEP GROUPS (50% name similarity) ──   " + y.length + " group(s), " + R.length + " creep(s) tracked, " + _enFmtNum(I) + " E contribution");
  if (!y.length) {
    b.push("    (no WORK creeps observed)");
  } else {
    b.push("    " + _enPadR("Group", 22) + _enPadL("Cnt", 4) + "  " + _enPadR("Body", 12) + _enPadR("Role", 14) + _enPadL("Harv", 7) + _enPadL("Upg", 7) + _enPadL("Bld", 6) + _enPadL("Rep", 6) + _enPadL("Total", 7) + "  Notes");
    for (const e of y) {
      const t = [];
      if (e.numPreExisting === e.count) t.push("all pre-existing"); else if (e.numPreExisting > 0) t.push(e.numPreExisting + " pre-existing");
      if (e.numDied > 0) t.push(e.numDied + " died");
      if (e.tombstoneLoss > 0) t.push("lost " + _enFmtNum(e.tombstoneLoss));
      b.push("    " + _enPadR(e.label, 22) + _enPadL(String(e.count), 4) + "  " + _enPadR(e.bodySig, 12) + _enPadR(e.role, 14) + _enPadL(_enFmtNum(e.harvested), 7) + _enPadL(_enFmtNum(e.upgraded), 7) + _enPadL(_enFmtNum(e.built), 6) + _enPadL(_enFmtNum(e.repaired), 6) + _enPadL(_enFmtNum(e.total), 7) + "  " + (t.join(", ") || ""));
    }
    b.push("    " + "┈".repeat(74));
    for (const e of y) {
      if (e.count <= 1 && e.label === e.members[0].name) continue;
      const t = e.members.map(e => {
        const t = e.diedAtTick !== null ? "†" : "";
        return (e.name || _enShortId(e.id)) + t;
      });
      const o = "      " + _enPadR(e.label + ":", 22) + t.join(", ");
      if (o.length <= 90) {
        b.push(o);
      } else {
        const o = "      " + _enPadR(e.label + ":", 22);
        let n = o;
        for (let e = 0; e < t.length; e++) {
          const r = t[e] + (e < t.length - 1 ? ", " : "");
          if (n.length + r.length > 90 && n !== o) {
            b.push(n);
            n = " ".repeat(o.length) + r;
          } else {
            n += r;
          }
        }
        if (n.trim().length > 0) b.push(n);
      }
    }
    b.push("    † = died during window");
  }
  b.push(k);
  const U = S + h;
  const L = i + p - T;
  b.push("  ── MASS BALANCE ──");
  b.push("    Income + extTermIn − ΔRoom            = " + _enFmtNum(L));
  b.push("    Accounted (consumption + loss)        = " + _enFmtNum(U));
  b.push("    Δ room non-source energy              = " + _enFmtNum(T) + "  (initial " + _enFmtNum(o.initialRoomTotal) + ", final " + _enFmtNum(o.finalRoomTotal) + ")");
  if (p > 0) {
    b.push("    External terminal IN                  = " + _enFmtNum(p));
  }
  if (Math.abs(h) > .05 * Math.max(1, i)) {
    b.push("    ⚠ Large residual: " + _enFmtNum(h) + " E (" + (Math.abs(h) / Math.max(1, i) * 100).toFixed(1) + "% of harvest) — attribution may be incomplete");
  }
  b.push("╩" + "═".repeat(A) + "╩");
  return {
    lines: b,
    summary: {
      obs: n,
      totalHarvested: i,
      incomePerTick: c,
      maxIncome: l,
      netConsumed: N,
      grossOutflow: O,
      usingGross: P,
      denomLabel: w,
      items: C,
      creepGroups: y,
      sourceLines: u,
      linkLoss: m,
      creepActionTotal: _,
      workSpawn: o.workSpawnCost,
      nonWorkSpawn: o.nonWorkSpawnCost,
      extTermIn: p,
      extTermOut: f,
      loss: h,
      deltaRoom: T,
      initialRoomTotal: o.initialRoomTotal,
      finalRoomTotal: o.finalRoomTotal,
      tombstoneDespawnLoss: g
    }
  };
}

function _enPrintReport(e, t) {
  const o = _enBuildReport(e, t);
  console.log(o.lines.join("\n"));
  return o.lines;
}

function _enStripBoxLines(e) {
  const t = [];
  for (const o of e) {
    if (ENERGY_BOX_DROP_RE.test(o)) continue;
    t.push(o);
  }
  return t;
}

function _enSplitNotifications(e, t) {
  const o = ENERGY_NOTIFY_TOTAL_MAX;
  const n = _enStripBoxLines(e);
  const r = [];
  for (const e of n) {
    if (e.length <= o) {
      r.push(e);
    } else {
      let t = e;
      while (t.length > o) {
        let e = t.lastIndexOf(" ", o);
        if (e <= 0) e = o;
        r.push(t.slice(0, e));
        t = t.slice(e).replace(/^\s+/, "");
      }
      if (t.length > 0) r.push(t);
    }
  }
  const s = [];
  let a = "";
  for (const e of r) {
    const t = a.length > 0 ? a.length + 1 + e.length : e.length;
    if (t > o && a.length > 0) {
      s.push(a);
      a = e;
    } else {
      a = a.length > 0 ? a + "\n" + e : e;
    }
  }
  if (a.length > 0) s.push(a);
  if (s.length === 0) s.push("(empty report)");
  const i = s.length;
  return s.map((e, o) => "[EnergyProfile: " + t + "] Part " + (o + 1) + "/" + i + "\n" + e);
}

function _enRunNotifyPhase(e) {
  const t = e.notifyQueue || [];
  const o = Math.min(ENERGY_NOTIFY_PER_TICK, t.length - e.notifySent);
  for (let n = 0; n < o; n++) {
    Game.notify(t[e.notifySent], 0);
    e.notifySent++;
  }
  if (e.notifySent >= t.length) {
    console.log("[EnergyProfiler] All " + e.notifySent + " notification chunk(s) sent for " + e.roomName + " (" + (Game.time - e.startTick) + " ticks total).");
    if (!Memory[ENERGY_EFF_CACHE_KEY]) Memory[ENERGY_EFF_CACHE_KEY] = {};
    Memory[ENERGY_EFF_CACHE_KEY][e.roomName] = {
      totals: e.totals,
      creepLedger: e.creepLedger,
      completedTick: Game.time,
      expiresTick: Game.time + ENERGY_EFF_EXPIRE
    };
    delete Memory[ENERGY_EFF_MEM_KEY];
  }
}

function _nkBuildPriceCache(e) {
  const t = {};
  const add = e => {
    if (!e) return;
    for (const o in e) if (t[o] === undefined) t[o] = getMarketBuyPrice(o);
  };
  e.find(FIND_STRUCTURES).forEach(e => add(e.store));
  if (t[RESOURCE_ENERGY] === undefined) t[RESOURCE_ENERGY] = getMarketBuyPrice(RESOURCE_ENERGY);
  if (t[RESOURCE_GHODIUM] === undefined) t[RESOURCE_GHODIUM] = getMarketBuyPrice(RESOURCE_GHODIUM);
  return t;
}

function _nkPriceCache(e) {
  let t = global.__nkPriceCache;
  if (!t || t.tick !== Game.time) {
    t = global.__nkPriceCache = {
      tick: Game.time,
      byRoom: {}
    };
  }
  return t.byRoom[e.name] || (t.byRoom[e.name] = _nkBuildPriceCache(e));
}

function _nkAnalyzeStrike(e, t, o, n) {
  const r = n[RESOURCE_ENERGY] || 0;
  let s = 0;
  const a = [], i = [], l = [];
  for (let c = -2; c <= 2; c++) for (let u = -2; u <= 2; u++) {
    const m = e + c, f = t + u;
    if (m < 0 || m > 49 || f < 0 || f > 49) continue;
    const p = c === 0 && u === 0 ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
    const E = o[m + "," + f];
    if (!E || !E.length) continue;
    const d = [], R = [];
    for (const e of E) {
      if (e.structureType === STRUCTURE_CONTROLLER) continue;
      if (e.structureType === STRUCTURE_RAMPART) d.push(e); else if (e.structureType !== STRUCTURE_ROAD && e.structureType !== STRUCTURE_WALL) R.push(e);
    }
    let _ = null;
    for (const e of d) if (!_ || e.hits > _.hits) _ = e;
    const g = _ && _.hits > p;
    for (const e of R) {
      if (g) {
        i.push({
          x: m,
          y: f,
          type: e.structureType
        });
      } else {
        const t = (NUKE_BUILD_COST[e.structureType] || 0) * r;
        let o = 0;
        if (e.store) for (const t in e.store) {
          const r = e.store[t] || 0;
          if (r > 0) o += r * (n[t] !== undefined ? n[t] : getMarketBuyPrice(t));
        }
        s += t + o;
        a.push({
          x: m,
          y: f,
          type: e.structureType,
          value: t + o,
          storedValue: o
        });
      }
    }
    if (_) {
      if (!g) {
        const e = _.hits / REPAIR_HITS_PER_ENERGY * r;
        s += e;
        a.push({
          x: m,
          y: f,
          type: STRUCTURE_RAMPART,
          value: e,
          storedValue: 0,
          hits: _.hits
        });
      } else {
        const e = p / REPAIR_HITS_PER_ENERGY * r;
        s += e;
        l.push({
          x: m,
          y: f,
          hits: _.hits,
          damage: p,
          repairCost: e
        });
      }
    }
  }
  return {
    totalCredits: s,
    destroyed: a,
    shielded: i,
    rampartsHit: l
  };
}

function _nkBuildSimState(e) {
  const t = {};
  for (const o of e.find(FIND_STRUCTURES)) {
    if (o.structureType === STRUCTURE_CONTROLLER) continue;
    const e = o.pos.x + "," + o.pos.y;
    if (!t[e]) t[e] = [];
    const n = {};
    if (o.store) for (const e in o.store) n[e] = o.store[e];
    t[e].push({
      structureType: o.structureType,
      hits: o.hits,
      store: n,
      destroyed: false
    });
  }
  return t;
}

function _nkSimStrike(e, t, o, n) {
  const r = n[RESOURCE_ENERGY] || 0;
  let s = 0;
  const a = [], i = [], l = [];
  for (let c = -2; c <= 2; c++) for (let u = -2; u <= 2; u++) {
    const m = e + c, f = t + u;
    if (m < 0 || m > 49 || f < 0 || f > 49) continue;
    const p = c === 0 && u === 0 ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
    const E = o[m + "," + f];
    if (!E || !E.length) continue;
    let d = null;
    const R = [];
    for (const e of E) {
      if (e.destroyed) continue;
      if (e.structureType === STRUCTURE_RAMPART) {
        if (!d || e.hits > d.hits) d = e;
      } else if (e.structureType !== STRUCTURE_ROAD && e.structureType !== STRUCTURE_WALL) R.push(e);
    }
    const _ = d && d.hits > p;
    for (const e of R) {
      if (_) {
        i.push({
          x: m,
          y: f,
          type: e.structureType
        });
      } else {
        const t = (NUKE_BUILD_COST[e.structureType] || 0) * r;
        let o = 0;
        for (const t in e.store) {
          const r = e.store[t] || 0;
          if (r > 0) o += r * (n[t] !== undefined ? n[t] : getMarketBuyPrice(t));
        }
        s += t + o;
        a.push({
          x: m,
          y: f,
          type: e.structureType,
          value: t + o,
          storedValue: o
        });
        e.destroyed = true;
      }
    }
    if (d) {
      if (!_) {
        const e = d.hits / REPAIR_HITS_PER_ENERGY * r;
        s += e;
        a.push({
          x: m,
          y: f,
          type: STRUCTURE_RAMPART,
          value: e,
          storedValue: 0,
          hits: d.hits
        });
        d.destroyed = true;
        d.hits = 0;
      } else {
        const e = p / REPAIR_HITS_PER_ENERGY * r;
        s += e;
        l.push({
          x: m,
          y: f,
          hits: d.hits,
          damage: p,
          repairCost: e
        });
        d.hits -= p;
      }
    }
  }
  return {
    totalCredits: s,
    destroyed: a,
    shielded: i,
    rampartsHit: l
  };
}

function _nkPreviewStrike(e, t, o, n) {
  const r = n[RESOURCE_ENERGY] || 0;
  let s = 0;
  const a = [], i = [], l = [];
  for (let c = -2; c <= 2; c++) for (let u = -2; u <= 2; u++) {
    const m = e + c, f = t + u;
    if (m < 0 || m > 49 || f < 0 || f > 49) continue;
    const p = c === 0 && u === 0 ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
    const E = o[m + "," + f];
    if (!E || !E.length) continue;
    let d = null;
    const R = [];
    for (const e of E) {
      if (e.destroyed) continue;
      if (e.structureType === STRUCTURE_RAMPART) {
        if (!d || e.hits > d.hits) d = e;
      } else if (e.structureType !== STRUCTURE_ROAD && e.structureType !== STRUCTURE_WALL) R.push(e);
    }
    const _ = d && d.hits > p;
    for (const e of R) {
      if (_) i.push({
        x: m,
        y: f,
        type: e.structureType
      }); else {
        const t = (NUKE_BUILD_COST[e.structureType] || 0) * r;
        let o = 0;
        for (const t in e.store) {
          const r = e.store[t] || 0;
          if (r > 0) o += r * (n[t] !== undefined ? n[t] : getMarketBuyPrice(t));
        }
        s += t + o;
        a.push({
          x: m,
          y: f,
          type: e.structureType,
          value: t + o,
          storedValue: o
        });
      }
    }
    if (d) {
      if (!_) {
        s += d.hits / REPAIR_HITS_PER_ENERGY * r;
        a.push({
          x: m,
          y: f,
          type: STRUCTURE_RAMPART,
          value: d.hits / REPAIR_HITS_PER_ENERGY * r,
          storedValue: 0,
          hits: d.hits
        });
      } else {
        const e = p / REPAIR_HITS_PER_ENERGY * r;
        s += e;
        l.push({
          x: m,
          y: f,
          hits: d.hits,
          damage: p,
          repairCost: e
        });
      }
    }
  }
  return {
    totalCredits: s,
    destroyed: a,
    shielded: i,
    rampartsHit: l
  };
}

function _nkFindBest(e, t) {
  let o = {
    totalCredits: 0,
    destroyed: [],
    shielded: [],
    rampartsHit: [],
    cx: 25,
    cy: 25
  };
  for (let n = 2; n <= 47; n++) for (let r = 2; r <= 47; r++) {
    const s = _nkPreviewStrike(n, r, e, t);
    if (s.totalCredits > o.totalCredits) {
      o = s;
      o.cx = n;
      o.cy = r;
    }
  }
  return o;
}

function _nkComputeBestStrike(e) {
  const t = _nkPriceCache(e);
  const o = t[RESOURCE_ENERGY] || 0, n = t[RESOURCE_GHODIUM] || 0;
  const r = NUKE_ENERGY_COST_CONST * o + NUKE_GHODIUM_COST * n;
  const s = {};
  e.find(FIND_STRUCTURES).forEach(e => {
    const t = e.pos.x + "," + e.pos.y;
    if (!s[t]) s[t] = [];
    s[t].push(e);
  });
  let a = 25, i = 25, l = 0;
  for (let e = 2; e <= 47; e++) for (let o = 2; o <= 47; o++) {
    const n = _nkAnalyzeStrike(e, o, s, t).totalCredits;
    if (n > l) {
      l = n;
      a = e;
      i = o;
    }
  }
  const c = [];
  for (let e = -2; e <= 2; e++) for (let t = -2; t <= 2; t++) {
    const o = a + e, n = i + t;
    if (o < 0 || o > 49 || n < 0 || n > 49) continue;
    const r = e === 0 && t === 0 ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
    const l = s[o + "," + n];
    if (!l) continue;
    const u = l.filter(e => e.structureType === STRUCTURE_RAMPART), m = l.filter(e => e.structureType !== STRUCTURE_RAMPART && e.structureType !== STRUCTURE_ROAD && e.structureType !== STRUCTURE_WALL);
    let f = null;
    for (const e of u) if (!f || e.hits > f.hits) f = e;
    if (!(f && f.hits > r)) for (const e of m) c.push(e.structureType);
  }
  const u = {};
  for (const e of c) u[e] = (u[e] || 0) + 1;
  return {
    x: a,
    y: i,
    damage: l,
    nukeCost: r,
    percent: r > 0 ? parseFloat((l / r * 100).toFixed(1)) : 0,
    destroyedSummary: Object.entries(u).map(([e, t]) => t > 1 ? t + "x " + e : e).join(", ") || "nothing killable"
  };
}

function _nkIsNukerOp(e) {
  if (!e || e.cooldown > 0) return false;
  return e.store[RESOURCE_GHODIUM] >= NUKE_GHODIUM_COST && e.store[RESOURCE_ENERGY] >= NUKE_ENERGY_COST_CONST;
}

function _nkHandleNotVisible(e, t, o) {
  if (!Memory.nukeAnalyzePending) Memory.nukeAnalyzePending = {};
  if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
  const n = Memory.nukeAnalyzePending[e];
  if (n && !n.costMode && !n.poweredObserver && Game.time - n.tick > 1) {
    console.log("[" + o + "] ERROR: " + e + " still not visible after observation attempt.");
    delete Memory.nukeAnalyzePending[e];
    return null;
  }
  if (Memory.intelPowerObserve[e]) {
    const n = Memory.intelPowerObserve[e];
    if (Game.time - n.tick <= 50) {
      if (!Memory.nukeAnalyzePending[e]) Memory.nukeAnalyzePending[e] = {
        tick: Game.time,
        observerRoom: n.operatorRoom,
        poweredObserver: true,
        ...t
      };
      console.log("[" + o + "] PWR_OPERATE_OBSERVER in progress — " + n.operatorName + ", elapsed " + (Game.time - n.tick) + "t.");
      return {
        status: "pending_power_observe",
        room: e
      };
    }
    delete Memory.intelPowerObserve[e];
  }
  const r = findObserverInRange(e, _tickUsedSet());
  if (r) {
    if (_tickObserve(r, e)) {
      Memory.nukeAnalyzePending[e] = {
        tick: Game.time,
        observerRoom: r.room.name,
        ...t
      };
      console.log("[" + o + "] Observing " + e + " via " + r.room.name + ". Auto-completing next tick.");
      return {
        status: "pending",
        room: e
      };
    }
    console.log("[" + o + "] Observer busy or failed");
  }
  const s = tryPowerObserver(e);
  if (s) {
    Memory.intelPowerObserve[e] = {
      operatorName: s.operatorName,
      operatorRoom: s.operatorRoom,
      observerId: s.observerId,
      tick: Game.time,
      purpose: "nukeAnalyze"
    };
    Memory.nukeAnalyzePending[e] = {
      tick: Game.time,
      observerRoom: s.operatorRoom,
      poweredObserver: true,
      ...t
    };
    console.log("[" + o + "] PWR_OPERATE_OBSERVER from " + s.operatorName + ".");
    return {
      status: "pending_power_observe",
      room: e
    };
  }
  console.log("[" + o + "] ERROR: " + e + " not visible. No observer. Send a scout.");
  return null;
}

function nukeAnalyze(e, t) {
  if (!e || typeof e !== "string") {
    console.log('[NukeAnalyze] Usage: nukeAnalyze("W1N1") or nukeAnalyze("W1N1", 3)');
    return null;
  }
  t = typeof t === "number" && t >= 1 ? Math.floor(t) : 1;
  if (!Memory.nukeAnalyzePending) Memory.nukeAnalyzePending = {};
  if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
  const o = Game.rooms[e];
  if (!o) return _nkHandleNotVisible(e, {
    numNukes: t
  }, "NukeAnalyze");
  delete Memory.nukeAnalyzePending[e];
  const n = _nkPriceCache(o), r = n[RESOURCE_ENERGY] || 0, s = n[RESOURCE_GHODIUM] || 0;
  const a = NUKE_ENERGY_COST_CONST * r + NUKE_GHODIUM_COST * s, i = a * t;
  const l = o.controller && o.controller.owner ? o.controller.owner.username : "Unowned", c = o.controller ? o.controller.level : 0;
  const u = _nkBuildSimState(o);
  const m = [];
  let f = 0;
  for (let e = 0; e < t; e++) {
    const e = _nkFindBest(u, n);
    if (e.totalCredits === 0) break;
    _nkSimStrike(e.cx, e.cy, u, n);
    f += e.totalCredits;
    m.push(e);
  }
  const p = i > 0 ? (f / i * 100).toFixed(1) : "inf";
  const E = "════════════════════════════════════════════════════════════════════════";
  const d = [];
  d.push(E);
  d.push("NUKE ANALYSIS: " + e + "  |  Owner: " + l + "  |  RCL: " + c + "  |  Nukes: " + t);
  d.push(E);
  d.push("Cost per nuke: " + fmtCr(a) + "  (" + fmtNum(NUKE_ENERGY_COST_CONST) + "e @" + r.toFixed(4) + "  +  " + NUKE_GHODIUM_COST + "G @" + s.toFixed(2) + "/G)" + (t > 1 ? "   Total: " + fmtCr(i) : ""));
  for (let e = 0; e < m.length; e++) {
    const t = m[e], o = a > 0 ? (t.totalCredits / a * 100).toFixed(1) : "inf";
    d.push("");
    d.push("  Strike " + (e + 1) + ":  (" + t.cx + ", " + t.cy + ")  ->  " + fmtCr(t.totalCredits) + "  (" + o + "% of 1 nuke cost)");
    if (t.destroyed.length > 0) {
      const e = {};
      for (const o of t.destroyed) {
        if (!e[o.type]) e[o.type] = {
          count: 0,
          value: 0,
          sv: 0
        };
        e[o.type].count++;
        e[o.type].value += o.value;
        e[o.type].sv += o.storedValue || 0;
      }
      for (const t in e) {
        const o = e[t];
        let n = "    " + t + " x" + o.count + "  ->  " + fmtCr(o.value);
        if (o.sv > 0) n += "  (build: " + fmtCr(o.value - o.sv) + " + stored: " + fmtCr(o.sv) + ")";
        d.push(n);
      }
    }
    if (t.rampartsHit.length > 0) {
      let e = 0;
      for (const o of t.rampartsHit) e += o.repairCost;
      d.push("    rampart repairs: " + t.rampartsHit.length + "  ->  " + fmtCr(e));
    }
    if (t.shielded.length > 0) d.push("    shielded (survived): " + t.shielded.length + " structure(s)");
  }
  if (m.length === 0) {
    d.push("");
    d.push("  No structures in blast range or all fully shielded.");
  }
  d.push("");
  d.push(E);
  if (t === 1) {
    const t = m[0] || {
      cx: 0,
      cy: 0
    };
    d.push("In '" + e + "', striking (" + t.cx + ", " + t.cy + ") does " + fmtCr(f) + " in damage (" + p + "% of nuke cost)");
  } else {
    d.push("Total damage (" + m.length + " nukes): " + fmtCr(f) + "  (" + p + "% of " + fmtCr(i) + ")");
    d.push("Targets: " + m.map(e => "(" + e.cx + ", " + e.cy + ")").join("  "));
  }
  d.push(E);
  console.log(d.join("\n"));
  return {
    room: e,
    numNukes: t,
    strikes: m.map(e => ({
      x: e.cx,
      y: e.cy,
      damage: e.totalCredits
    })),
    totalDamage: f,
    nukeCostOne: a,
    nukeCostAll: i,
    percent: parseFloat(p)
  };
}

function nukeAnalyzeSelf() {
  const e = [];
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (o.controller && o.controller.my) e.push(t);
  }
  if (!e.length) {
    console.log("[NukeAnalyze] No owned rooms visible.");
    return;
  }
  const t = getMarketBuyPrice(RESOURCE_ENERGY), o = getMarketBuyPrice(RESOURCE_GHODIUM);
  const n = NUKE_ENERGY_COST_CONST * t + NUKE_GHODIUM_COST * o;
  const r = [ "NUKE SELF-ANALYSIS  |  Nuke cost: " + fmtCr(n), "---" ];
  e.sort();
  for (const t of e) {
    const e = Game.rooms[t], o = _nkPriceCache(e), s = {};
    for (const t of e.find(FIND_STRUCTURES)) {
      if (t.structureType === STRUCTURE_CONTROLLER) continue;
      const e = t.pos.x + "," + t.pos.y;
      if (!s[e]) s[e] = [];
      s[e].push(t);
    }
    let a = {
      totalCredits: 0,
      cx: 25,
      cy: 25
    };
    for (let e = 2; e <= 47; e++) for (let t = 2; t <= 47; t++) {
      const n = _nkAnalyzeStrike(e, t, s, o);
      if (n.totalCredits > a.totalCredits) {
        a = n;
        a.cx = e;
        a.cy = t;
      }
    }
    const i = n > 0 ? (a.totalCredits / n * 100).toFixed(1) : "inf";
    r.push(t + " (RCL" + (e.controller ? e.controller.level : 0) + ")  -  Best: (" + a.cx + ", " + a.cy + ")  -  " + fmtCr(a.totalCredits) + "  (" + i + "% of nuke cost)");
  }
  console.log(r.join("\n"));
}

function nukeAnalyzeCost(e, t, o) {
  if (!e || typeof e !== "string") {
    console.log('[NukeAnalyzeCost] Usage: nukeAnalyzeCost("W1N1", x, y) or nukeAnalyzeCost("W1N1", [{x,y},...])');
    return null;
  }
  let n;
  if (Array.isArray(t)) {
    n = [];
    for (const e of t) {
      const t = parseInt(e.x, 10), o = parseInt(e.y, 10);
      if (isNaN(t) || isNaN(o) || t < 2 || t > 47 || o < 2 || o > 47) {
        console.log("[NukeAnalyzeCost] Skipping invalid: (" + e.x + ", " + e.y + ")");
        continue;
      }
      n.push({
        x: t,
        y: o
      });
    }
    if (!n.length) {
      console.log("[NukeAnalyzeCost] No valid coordinates.");
      return null;
    }
  } else {
    const e = parseInt(t, 10), r = parseInt(o, 10);
    if (isNaN(e) || isNaN(r) || e < 2 || e > 47 || r < 2 || r > 47) {
      console.log("[NukeAnalyzeCost] Coordinates must be 2-47.");
      return null;
    }
    n = [ {
      x: e,
      y: r
    } ];
  }
  if (!Memory.nukeAnalyzePending) Memory.nukeAnalyzePending = {};
  if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
  const r = Game.rooms[e];
  if (!r) return _nkHandleNotVisible(e, {
    costMode: true,
    strikes: n
  }, "NukeAnalyzeCost");
  const s = _nkPriceCache(r), a = s[RESOURCE_ENERGY] || 0;
  const i = r.find(FIND_STRUCTURES), l = {};
  for (const e of i) {
    const t = e.pos.x + "," + e.pos.y;
    if (!l[t]) l[t] = [];
    l[t].push(e);
  }
  function isIgnored(e) {
    return e === STRUCTURE_ROAD || e === STRUCTURE_WALL || e === STRUCTURE_CONTAINER || e === STRUCTURE_RAMPART || e === STRUCTURE_CONTROLLER;
  }
  const c = {};
  for (let e = 0; e < n.length; e++) {
    const t = n[e].x, o = n[e].y;
    for (let n = -2; n <= 2; n++) for (let r = -2; r <= 2; r++) {
      const s = t + n, a = o + r;
      if (s < 0 || s > 49 || a < 0 || a > 49) continue;
      const i = n === 0 && r === 0 ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
      const l = s + "," + a;
      if (!c[l]) c[l] = {
        total: 0,
        contributions: []
      };
      c[l].total += i;
      c[l].contributions.push({
        strikeIdx: e,
        dmg: i
      });
    }
  }
  let u = 0, m = 0, f = 0, p = 0, E = 0, d = 0;
  const R = [];
  for (const e in c) {
    const t = e.split(","), o = parseInt(t[0], 10), n = parseInt(t[1], 10), r = c[e], a = r.total;
    const i = l[e] || [];
    let _ = null;
    const g = [];
    for (const e of i) {
      if (e.structureType === STRUCTURE_RAMPART) {
        if (!_ || e.hits > _.hits) _ = e;
      } else if (!isIgnored(e.structureType)) g.push(e);
    }
    if (!g.length) continue;
    const y = _ ? _.hits : 0, T = _ && y > a, S = Math.max(0, a - y + 1), h = r.contributions.some(e => e.dmg === NUKE_DIRECT_DAMAGE);
    let C = 0, O = 0;
    const N = [];
    for (const e of g) {
      const t = NUKE_BUILD_COST[e.structureType] || 0;
      let o = 0;
      if (e.store) for (const t in e.store) {
        const n = e.store[t] || 0;
        if (n > 0) o += n * (s[t] !== undefined ? s[t] : getMarketBuyPrice(t));
      }
      C += t;
      O += o;
      N.push({
        type: e.structureType,
        buildEnergy: t,
        storedCredits: o
      });
    }
    u += C;
    m += O;
    let P = 0, M = 0, w = 0, A = 0;
    if (!_) {
      w = S / REPAIR_HITS_PER_ENERGY;
      E += w;
    } else if (!T) {
      P = y / REPAIR_HITS_PER_ENERGY;
      M = S / REPAIR_HITS_PER_ENERGY;
      f += P;
      p += M;
    } else {
      A = a / REPAIR_HITS_PER_ENERGY;
      d += A;
    }
    R.push({
      x: o,
      y: n,
      isCenter: h,
      nukeHits: a,
      contributions: r.contributions,
      currentRampartHP: y,
      rampartBlocks: T,
      hpShortfall: S,
      buildings: N,
      tileReplaceBuild: C,
      tileReplaceStored: O,
      rampartAtRiskEnergy: P,
      topupEnergy: M,
      fullRampartEnergy: w,
      forceRepairEnergy: A
    });
  }
  R.sort((e, t) => e.y !== t.y ? e.y - t.y : e.x - t.x);
  const _ = "════════════════════════════════════════════════════════════════════════", g = "────────────────────────────────────────────────────────────────────────";
  const y = [], T = r.controller && r.controller.owner ? r.controller.owner.username : "Unowned", S = r.controller ? r.controller.level : 0;
  y.push(_);
  y.push("NUKE COST ANALYSIS: " + e + " @ " + n.map(e => "(" + e.x + "," + e.y + ")").join(" + ") + "  |  Owner: " + T + "  |  RCL: " + S);
  if (n.length > 1) y.push("WARNING: " + n.length + " simultaneous strikes — damage STACKED per tile.");
  y.push(_);
  y.push("Energy price: " + a.toFixed(4) + " cr/e  |  Structures: " + i.length + "  |  Building tiles in blast: " + R.length);
  y.push("");
  y.push("PER-TILE BREAKDOWN:");
  y.push(g);
  for (const e of R) {
    const t = e.contributions.length === 1 ? e.isCenter ? "10M direct" : "5M area  " : e.contributions.map(e => fmtNum(e.dmg)).join("+") + "=" + fmtNum(e.nukeHits) + " stacked";
    const o = e.isCenter && e.contributions.length === 1 ? "  [CENTER] (" + e.x + "," + e.y + ")  " + t : "  [AREA]   (" + e.x + "," + e.y + ")   " + t;
    const n = e.currentRampartHP === 0 ? "no rampart" : e.rampartBlocks ? "rampart OK  " + fmtNum(e.currentRampartHP) + " HP" : "rampart WEAK  " + fmtNum(e.currentRampartHP) + " HP  (need >" + fmtNum(e.nukeHits) + ")";
    y.push(o + "  |  " + n);
    for (const t of e.buildings) {
      let o = "      " + t.type + "  rebuild: " + fmtNum(t.buildEnergy) + "e  (" + fmtCr(t.buildEnergy * a) + ")";
      if (t.storedCredits > 0) o += "  + stored: " + fmtCr(t.storedCredits);
      o += e.rampartBlocks ? "  protected" : "  at risk";
      y.push(o);
    }
    if (e.rampartBlocks) y.push("      Rampart repair after hit: " + fmtNum(e.forceRepairEnergy) + "e  (" + fmtCr(e.forceRepairEnergy * a) + ")"); else if (e.currentRampartHP > 0) {
      y.push("      Rampart at risk: " + fmtNum(e.currentRampartHP) + " HP  =  " + fmtNum(e.rampartAtRiskEnergy) + "e  (" + fmtCr(e.rampartAtRiskEnergy * a) + ")");
      y.push("      To protect: need " + fmtNum(e.hpShortfall) + " more HP  =  " + fmtNum(e.topupEnergy) + "e  (" + fmtCr(e.topupEnergy * a) + ")");
    } else y.push("      To protect (from scratch): need " + fmtNum(e.nukeHits + 1) + " HP  =  " + fmtNum(e.fullRampartEnergy) + "e  (" + fmtCr(e.fullRampartEnergy * a) + ")");
  }
  if (!R.length) y.push("  No meaningful structures in blast area.");
  const h = u * a + m, C = p + E, O = C * a, N = d * a;
  y.push("");
  y.push(_);
  y.push("REPLACEMENT COST:");
  y.push("  Build energy: " + fmtNum(u) + "e  (" + fmtCr(u * a) + ")");
  y.push("  Lost resources: " + fmtCr(m));
  y.push("  TOTAL: " + fmtCr(h));
  y.push("");
  y.push("DEFENSE COST (protect all building tiles):");
  if (p > 0) y.push("  Top up weak ramparts: " + fmtNum(p) + "e  (" + fmtCr(p * a) + ")");
  if (E > 0) y.push("  Build new ramparts: " + fmtNum(E) + "e  (" + fmtCr(E * a) + ")");
  y.push("  TOTAL to protect: " + fmtNum(C) + "e  (" + fmtCr(O) + ")");
  if (d > 0) y.push("  Post-strike repairs: " + fmtNum(d) + "e  (" + fmtCr(N) + ")");
  if (f > 0) {
    y.push("");
    y.push("SUNK COST AT RISK: " + fmtNum(f) + "e  (" + fmtCr(f * a) + ")");
  }
  y.push(_);
  console.log(y.join("\n"));
  return {
    room: e,
    strikes: n,
    totalReplaceBuildEnergy: u,
    totalReplaceStored: m,
    totalReplaceCredits: h,
    totalProtectEnergy: C,
    totalProtectCredits: O,
    tiles: R
  };
}

function nukeIncoming(e) {
  if (!Memory.nukeAnalyzePending) Memory.nukeAnalyzePending = {};
  if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
  if (e) {
    if (typeof e !== "string") {
      console.log('[NukeIncoming] Usage: nukeIncoming() or nukeIncoming("W1N1")');
      return null;
    }
    const t = Game.rooms[e];
    if (!t) return _nkHandleNotVisible(e, {
      incomingMode: true
    }, "NukeIncoming");
    return _nkScanIncoming(e, t);
  }
  const t = [], o = [];
  for (const e in Game.rooms) {
    const o = Game.rooms[e];
    if (o.controller && o.controller.my) t.push(e);
  }
  if (!t.length) {
    console.log("[NukeIncoming] No owned rooms visible.");
    return null;
  }
  let n = 0;
  t.sort();
  for (const e of t) n += _nkScanIncoming(e, Game.rooms[e]);
  if (!n) console.log("[NukeIncoming] No incoming nukes detected in any owned room.");
  return n;
}

function _nkScanIncoming(e, t) {
  const o = "════════════════════════════════════════════════════════════════════════", n = "────────────────────────────────────────────────────────────────────────";
  const r = t.find(FIND_NUKES);
  if (!r || !r.length) return 0;
  r.sort((e, t) => e.timeToLand - t.timeToLand);
  for (const t of r) {
    console.log(o);
    console.log("INCOMING NUKE -> " + e + "  |  Landing @ (" + t.pos.x + ", " + t.pos.y + ")" + "  |  " + t.timeToLand + " ticks remaining  (tick " + (Game.time + t.timeToLand) + ")" + "  |  From: " + (t.launchRoomName || "???"));
    console.log(n);
  }
  nukeAnalyzeCost(e, r.map(e => ({
    x: e.pos.x,
    y: e.pos.y
  })));
  return r.length;
}

function nukeThreat(e) {
  if (!e || typeof e !== "string") {
    console.log('[NukeThreat] Usage: nukeThreat("E1N1")');
    return;
  }
  const t = _nkEnsureThreatMem(e);
  console.log("[NukeThreat] Scanning " + Object.keys(t.roomsToScan).length + " rooms around " + e + ". Use nukeThreatStatus for progress.");
  _nkProcessThreatScan();
}

function nukeThreatStatus(e) {
  const t = Memory.nukeThreatScans ? Memory.nukeThreatScans[e] : null;
  if (!t) {
    console.log("[NukeThreat] No active scan for " + e + ".");
    return;
  }
  const o = Object.keys(t.roomsToScan).length, n = t.scannedCount + t.unscannableCount;
  console.log("[NukeThreat] Status for " + e + ": " + n + "/" + o + " rooms (" + t.scannedCount + " visible, " + t.unscannableCount + " unscannable). " + (t.scanComplete ? "Complete." : "In progress."));
  if (t.scanComplete && t.bestHostileOwner) console.log("[NukeThreat] Most threatening: " + t.bestHostileOwner + " with " + t.operationalNukeCount + " nukes. Can destroy key structures: " + (t.threatPossible ? "YES" : "NO"));
}

function nukeThreatCancel(e) {
  if (!e || typeof e !== "string") {
    console.log('[NukeThreatCancel] Usage: nukeThreatCancel("E1N1")');
    return;
  }
  if (Memory.nukeThreatScans && Memory.nukeThreatScans[e]) {
    delete Memory.nukeThreatScans[e];
    console.log("[NukeThreatCancel] Scan for " + e + " cancelled.");
  } else console.log("[NukeThreatCancel] No active scan found for " + e + ".");
}

function _nkEnsureThreatMem(e) {
  if (!Memory.nukeThreatScans) Memory.nukeThreatScans = {};
  let t = Memory.nukeThreatScans[e];
  if (!t || t.createdTick !== Game.time) {
    t = {
      target: e,
      started: Game.time,
      createdTick: Game.time,
      roomsToScan: {},
      unscannableCount: 0,
      scannedCount: 0,
      scanComplete: false,
      bestHostileOwner: null,
      operationalNukeCount: 0,
      threatPossible: false
    };
    const o = roomsInRange(e, OBSERVER_RANGE);
    for (const n of o) {
      if (n === e) continue;
      t.roomsToScan[n] = {
        status: "unscanned",
        data: {}
      };
    }
    Memory.nukeThreatScans[e] = t;
  }
  return t;
}

function _nkProcessThreatScan() {
  if (!Memory.nukeThreatScans) return;
  if (!Memory.nukeThreatPowerObserve) Memory.nukeThreatPowerObserve = {};
  const e = new Set;
  for (const t in Memory.nukeThreatScans) {
    const o = Memory.nukeThreatScans[t];
    if (!o || o.scanComplete) continue;
    for (const t in o.roomsToScan) {
      const n = o.roomsToScan[t];
      if (n.status === "visible" || n.status === "fail") continue;
      const r = Game.rooms[t];
      if (r) {
        n.status = "visible";
        n.data.owner = r.controller && r.controller.owner ? r.controller.owner.username : null;
        let e = 0;
        if (n.data.owner && !_isFriendlyUsername(n.data.owner)) {
          const t = r.find(FIND_STRUCTURES, {
            filter: e => e.structureType === STRUCTURE_NUKER && _nkIsNukerOp(e)
          });
          e = t.length;
        }
        n.data.opNukeCount = e;
        o.scannedCount++;
        delete Memory.nukeThreatPowerObserve[t];
        continue;
      }
      if (n.status === "unscanned") {
        if (tryObserveRoom(t, e)) {
          n.status = "pending";
          n.observeTick = Game.time;
          continue;
        }
        const r = tryPowerObserver(t);
        if (r) {
          Memory.nukeThreatPowerObserve[t] = {
            operatorName: r.operatorName,
            operatorRoom: r.operatorRoom,
            observerId: r.observerId,
            tick: Game.time
          };
          n.status = "pending";
          n.observeTick = Game.time;
          continue;
        }
        n.status = "fail";
        o.unscannableCount++;
      }
      if (n.status === "pending" && n.observeTick !== undefined && Game.time - n.observeTick > 100) {
        n.status = "fail";
        o.unscannableCount++;
        delete Memory.nukeThreatPowerObserve[t];
      }
    }
    let n = false;
    for (const e in o.roomsToScan) {
      const t = o.roomsToScan[e];
      if (t.status === "unscanned" || t.status === "pending") {
        n = true;
        break;
      }
    }
    if (!n) {
      o.scanComplete = true;
      _nkRunFinalThreat(t, o);
    }
  }
  for (const e in Memory.nukeThreatScans) {
    const t = Memory.nukeThreatScans[e];
    if (t && t.scanComplete && Game.time - t.started > 1e3) delete Memory.nukeThreatScans[e];
  }
  for (const e in Memory.nukeThreatPowerObserve) {
    if (Game.time - Memory.nukeThreatPowerObserve[e].tick > 100) delete Memory.nukeThreatPowerObserve[e];
  }
}

function _nkRunFinalThreat(e, t) {
  const o = {};
  for (const e in t.roomsToScan) {
    const n = t.roomsToScan[e];
    if (n.status !== "visible" || !n.data.owner) continue;
    const r = n.data.owner;
    if (_isFriendlyUsername(r)) continue;
    o[r] = (o[r] || 0) + (n.data.opNukeCount || 0);
  }
  let n = null, r = 0;
  for (const e in o) if (o[e] > r) {
    n = e;
    r = o[e];
  }
  t.bestHostileOwner = n;
  t.operationalNukeCount = r;
  const s = Object.keys(t.roomsToScan).length, a = s > 0 ? Math.round((t.scannedCount + t.unscannableCount) / s * 100) : 100;
  console.log("[NukeThreat] Scan complete. " + a + "% of " + s + " rooms processed (" + t.unscannableCount + " unscannable).");
  if (!n || !r) {
    console.log("[NukeThreat] No hostile player with operational nukers within range of " + e + ".");
    return;
  }
  console.log("[NukeThreat] Most threatening: " + n + " with " + r + " nuke(s) in range.");
  const i = Game.rooms[e];
  if (!i) {
    console.log("[NukeThreat] ERROR: Target room " + e + " not visible. Cannot run destruction test.");
    return;
  }
  const l = _nkPriceCache(i), c = _nkBuildSimState(i);
  for (let e = 0; e < r; e++) {
    const e = _nkFindBest(c, l);
    if (e.totalCredits === 0) break;
    _nkSimStrike(e.cx, e.cy, c, l);
  }
  let u = true, m = false, f = false, p = false, E = false;
  for (const e of i.find(FIND_STRUCTURES)) {
    const t = e.pos.x + "," + e.pos.y;
    const o = c[t] || [];
    const n = o.some(t => !t.destroyed && t.structureType === e.structureType);
    if (e.structureType === STRUCTURE_SPAWN && n) u = false;
    if (e.structureType === STRUCTURE_TERMINAL) {
      m = true;
      if (!n) f = true;
    }
    if (e.structureType === STRUCTURE_STORAGE) {
      p = true;
      if (!n) E = true;
    }
  }
  const d = !m || f, R = !p || E;
  if (u && d && R) {
    t.threatPossible = true;
    console.log("[NukeThreat] YES — " + n + " can destroy ALL spawns, terminal and storage in " + e + " with " + r + " nukes.");
  } else {
    let e = "";
    if (!u) e += "spawns, ";
    if (!d) e += "terminal, ";
    if (!R) e += "storage, ";
    e = e.slice(0, -2);
    console.log("[NukeThreat] NO — " + r + " nukes are NOT enough. Still standing: " + e + ".");
  }
  nukeAnalyze(e, r);
}

function _processPendingNukeAnalyze() {
  if (Memory.nukeAnalyzePending) {
    for (const e in Memory.nukeAnalyzePending) {
      const t = Memory.nukeAnalyzePending[e], o = Game.time - t.tick;
      if (Game.rooms[e]) {
        if (t.incomingMode) {
          console.log("[NukeIncoming] Auto-completing incoming scan for " + e);
          _nkScanIncoming(e, Game.rooms[e]);
        } else if (t.costMode) {
          console.log("[NukeAnalyzeCost] Auto-completing cost analysis for " + e);
          nukeAnalyzeCost(e, t.strikes);
        } else {
          console.log("[NukeAnalyze] Auto-completing analysis for " + e);
          nukeAnalyze(e, t.numNukes || 1);
        }
        delete Memory.nukeAnalyzePending[e];
      } else if (t.poweredObserver) {} else if (o >= 5) {
        console.log("[NukeAnalyze] Timed out waiting for visibility of " + e + " after " + o + " ticks.");
        delete Memory.nukeAnalyzePending[e];
      }
    }
  }
  if (Memory.intelPowerObserve) {
    for (const e in Memory.intelPowerObserve) {
      const t = Memory.intelPowerObserve[e];
      if (!t || !t.tick) continue;
      if (!Memory.nukeAnalyzePending || !Memory.nukeAnalyzePending[e]) continue;
      if (Game.time - t.tick > 100) {
        console.log("[NukeAnalyze] Power-observe timed out for " + e + ". Clearing.");
        delete Memory.intelPowerObserve[e];
        delete Memory.nukeAnalyzePending[e];
      }
    }
  }
  _nkProcessThreatScan();
}

function _paGetMyNukerRooms() {
  const e = [];
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (!o.controller || !o.controller.my) continue;
    const n = o.find(FIND_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_NUKER
    })[0];
    if (!n) continue;
    const r = n.store[RESOURCE_ENERGY] || 0, s = n.store[RESOURCE_GHODIUM] || 0;
    const a = n.store.getCapacity(RESOURCE_ENERGY), i = n.store.getCapacity(RESOURCE_GHODIUM);
    const l = r >= a && s >= i && !(n.cooldown || 0);
    e.push({
      room: t,
      ready: l,
      energy: r,
      ghodium: s,
      cooldown: n.cooldown || 0
    });
  }
  return e;
}

function _paGetMyRooms() {
  const e = [];
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (o.controller && o.controller.my) e.push(t);
  }
  return e;
}

function _paCategorizeCreep(e) {
  const t = e.body, o = t.length;
  if (t.some(e => e.type === ATTACK || e.type === RANGED_ATTACK || e.type === HEAL)) return "military";
  if (t.some(e => e.type === CLAIM)) return "claimer";
  const n = t.filter(e => e.type === WORK).length / o;
  if (n > .25) return "worker";
  if (t.every(e => e.type === MOVE)) return "scout";
  if (n < .1) return "supplier";
  return "other";
}

function _paFmtNum(e) {
  if (e === undefined || e === null) return "0";
  if (e >= 1e9) return (e / 1e9).toFixed(1) + "B";
  if (e >= 1e6) return (e / 1e6).toFixed(1) + "M";
  if (e >= 1e3) return (e / 1e3).toFixed(1) + "k";
  return String(e);
}

function startPlayerAnalysis(e) {
  if (!e || typeof e !== "string") {
    console.log('[PlayerAnalysis] Usage: player("PlayerName")');
    return;
  }
  if (Memory.playerAnalysis && Memory.playerAnalysis.active) {
    console.log("[PlayerAnalysis] Analysis already in progress for " + Memory.playerAnalysis.targetPlayer + ". Use playerCancel() first.");
    return;
  }
  const t = getObserverMap(), o = Object.keys(t);
  if (!o.length) {
    console.log("[PlayerAnalysis] No observers found.");
    return;
  }
  const n = [];
  for (const e of o) {
    const t = parseRoomCoords(e);
    if (!t) continue;
    for (let e = -OBSERVER_RANGE; e <= OBSERVER_RANGE; e++) for (let o = -OBSERVER_RANGE; o <= OBSERVER_RANGE; o++) {
      if (e === 0 && o === 0) continue;
      const r = toRoomName(t.x + e, t.y + o);
      n.push(r);
    }
  }
  const r = [ ...new Set(n) ].filter(e => {
    if (!isClaimableRoom(e)) return false;
    const t = Game.rooms[e];
    return !t || !t.controller || !t.controller.my;
  });
  console.log("[PlayerAnalysis] Starting analysis of: " + e);
  console.log("[PlayerAnalysis] Phase 1: Scanning " + r.length + " rooms...");
  Memory.playerAnalysis = {
    active: true,
    phase: "scanning",
    targetPlayer: e,
    startTick: Game.time,
    observerRooms: o,
    scanQueue: r.slice(),
    scannedCount: 0,
    totalScanRooms: r.length,
    foundRooms: [],
    lastObservedRoom: null,
    intelQueue: [],
    intelResults: [],
    intelCount: 0,
    totalIntelRooms: 0
  };
}

function cancelPlayerAnalysis() {
  if (Memory.playerAnalysis && Memory.playerAnalysis.active) {
    console.log("[PlayerAnalysis] Analysis cancelled.");
    delete Memory.playerAnalysis;
  } else console.log("[PlayerAnalysis] No active analysis.");
}

function getPlayerAnalysisStatus() {
  if (!Memory.playerAnalysis || !Memory.playerAnalysis.active) {
    console.log("[PlayerAnalysis] No active analysis.");
    return null;
  }
  const e = Memory.playerAnalysis, t = Game.time - e.startTick;
  console.log("[PlayerAnalysis] Target: " + e.targetPlayer + " | Phase: " + e.phase);
  if (e.phase === "scanning") {
    const t = (e.scannedCount / e.totalScanRooms * 100).toFixed(1);
    console.log("  Scan: " + e.scannedCount + "/" + e.totalScanRooms + " (" + t + "%) | Found: " + e.foundRooms.length);
  } else if (e.phase === "intel") console.log("  Intel: " + e.intelCount + "/" + e.totalIntelRooms);
  console.log("  Elapsed: " + t + " ticks");
  return e;
}

function _paRun() {
  if (Memory.lastPlayerAnalysis && Memory.lastPlayerAnalysis.expiresTick <= Game.time) delete Memory.lastPlayerAnalysis;
  if (Memory.playerAnalysis && Memory.playerAnalysis.active) {
    const e = Memory.playerAnalysis, t = getObserverMap();
    if (e.phase === "scanning") _paScanPhase(e, t); else if (e.phase === "intel") _paIntelPhase(e, t);
  }
  _paCreepScanTick();
}

function _paScanPhase(e, t) {
  if (e.lastObservedRoom) {
    const t = Game.rooms[e.lastObservedRoom];
    if (t && t.controller && t.controller.owner && t.controller.owner.username === e.targetPlayer) {
      if (!e.foundRooms.includes(e.lastObservedRoom)) {
        e.foundRooms.push(e.lastObservedRoom);
        console.log("[PlayerAnalysis] Found " + e.targetPlayer + "'s room: " + e.lastObservedRoom + " (RCL " + t.controller.level + ")");
      }
    }
    e.scannedCount++;
    e.lastObservedRoom = null;
  }
  if (!e.scanQueue.length) {
    console.log("[PlayerAnalysis] Phase 1 complete. Found " + e.foundRooms.length + " room(s).");
    if (!e.foundRooms.length) {
      console.log("[PlayerAnalysis] No rooms found for " + e.targetPlayer + " within observer range.");
      _paCompleteAnalysis(e);
      return;
    }
    e.phase = "intel";
    e.intelQueue = e.foundRooms.slice();
    e.totalIntelRooms = e.foundRooms.length;
    console.log("[PlayerAnalysis] Phase 2: Gathering intel on " + e.totalIntelRooms + " room(s)...");
    return;
  }
  const o = e.scanQueue[0];
  const n = findObserverForRoom(o, t);
  if (!n) {
    e.scanQueue.shift();
    e.scannedCount++;
  } else if (_tickObserve(n, o)) {
    e.scanQueue.shift();
    e.lastObservedRoom = o;
  }
  if (e.scannedCount > 0 && e.scannedCount % 100 === 0) console.log("[PlayerAnalysis] Scan progress: " + e.scannedCount + "/" + e.totalScanRooms + " (" + (e.scannedCount / e.totalScanRooms * 100).toFixed(1) + "%) - Found " + e.foundRooms.length);
}

function _paIntelPhase(e, t) {
  if (e.lastObservedRoom) {
    const t = Game.rooms[e.lastObservedRoom];
    if (t) e.intelResults.push(_itRunSilent(t));
    e.intelCount++;
    e.lastObservedRoom = null;
  }
  if (!e.intelQueue.length) {
    console.log("[PlayerAnalysis] Phase 2 complete. Intel on " + e.intelResults.length + " room(s).");
    _paCompleteAnalysis(e);
    return;
  }
  const o = e.intelQueue[0];
  const n = findObserverForRoom(o, t);
  if (!n) {
    e.intelQueue.shift();
    e.intelCount++;
  } else if (_tickObserve(n, o)) {
    e.intelQueue.shift();
    e.lastObservedRoom = o;
  }
}

function _paCompleteAnalysis(e) {
  const t = Game.time - e.startTick, o = e.intelResults, n = e.targetPlayer;
  const r = _paGetMyNukerRooms(), s = _paGetMyRooms();
  const a = [], i = [];
  for (const e of o) {
    if (e.structures.nuker) {
      const t = s.filter(t => canNuke(e.room, t));
      if (t.length > 0) a.push({
        enemyRoom: e.room,
        ready: e.structures.nukerReady,
        charging: e.structures.nukerCharging,
        threatens: t
      });
    }
    for (const t of r) {
      if (canNuke(t.room, e.room)) {
        const o = i.find(e => e.myRoom === t.room);
        if (o) o.canHit.push(e.room); else i.push({
          myRoom: t.room,
          ready: t.ready,
          canHit: [ e.room ]
        });
      }
    }
  }
  const l = o.filter(e => e.scores.overall < PA_THRESHOLDS.weak);
  const c = o.filter(e => e.scores.overall >= PA_THRESHOLDS.strong);
  const u = o.filter(e => e.scores.overall >= PA_THRESHOLDS.weak && e.scores.overall < PA_THRESHOLDS.strong);
  const avg = (e, t) => o.length > 0 ? o.reduce((o, n) => o + (typeof n.scores[e] === "number" ? n.scores[e] : t && typeof n.scores[t] === "number" ? n.scores[t] : 0), 0) / o.length : 0;
  const m = {
    playerName: n,
    elapsed: t,
    results: o,
    weakRooms: l,
    strongRooms: c,
    averageRooms: u,
    avgOverall: avg("overall"),
    avgDefense: avg("defense", "military"),
    avgOffense: avg("offense", "military"),
    avgEconomic: avg("economy", "economic"),
    avgInfrastructure: avg("infrastructure", "dualPurpose"),
    avgOperations: avg("operations"),
    avgMilitary: avg("military"),
    avgDualPurpose: avg("dualPurpose"),
    totalStorageEnergy: o.reduce((e, t) => e + t.resources.storageEnergy, 0),
    totalTerminalEnergy: o.reduce((e, t) => e + t.resources.terminalEnergy, 0),
    totalPower: o.reduce((e, t) => e + t.resources.power, 0),
    totalCombatBoosts: o.reduce((e, t) => e + t.resources.combatBoosts, 0),
    totalSpawns: o.reduce((e, t) => e + t.structures.spawns, 0),
    totalTowers: o.reduce((e, t) => e + t.structures.towers, 0),
    totalLabs: o.reduce((e, t) => e + (t.structures.labs || 0), 0),
    roomsWithNuker: o.filter(e => e.structures.nuker).length,
    roomsWithFactory: o.filter(e => e.structures.factory).length,
    roomsWithPowerSpawn: o.filter(e => e.structures.powerSpawn).length,
    enemyNukeThreats: a,
    myNukeTargets: i,
    myNukers: r
  };
  _paPrintReport(m);
  let f = n + " analysis complete.\nRooms: " + o.length + " (" + c.length + " strong, " + u.length + " avg, " + l.length + " weak)\nAvg Score: " + m.avgOverall.toFixed(1) + "/100";
  if (a.length > 0) f += "\nNUKE THREATS: " + a.length + " enemy nuker(s) can hit your rooms!";
  Game.notify(f, 0);
  delete Memory.playerAnalysis;
}

function _paPrintReport(e) {
  const t = "════════════════════════════════════════════════════════════════════════════════════════════════════", o = [];
  o.push(t);
  o.push("PLAYER ANALYSIS: " + e.playerName + " | Rooms: " + e.results.length + " | Analysis Time: " + e.elapsed + " ticks");
  o.push(t);
  o.push("");
  o.push("AVERAGE SCORES:");
  o.push("   Composite: " + e.avgOverall.toFixed(1) + "/100 | Defense: " + e.avgDefense.toFixed(1) + " | Offense: " + e.avgOffense.toFixed(1) + " | Economy: " + e.avgEconomic.toFixed(1) + " | Infrastructure: " + e.avgInfrastructure.toFixed(1));
  o.push("");
  o.push("ROOM CLASSIFICATIONS:");
  if (e.strongRooms.length > 0) o.push("   STRONG (" + e.strongRooms.length + "): " + e.strongRooms.map(e => e.room + "(" + e.scores.overall.toFixed(0) + ")").join(", "));
  if (e.averageRooms.length > 0) o.push("   AVERAGE (" + e.averageRooms.length + "): " + e.averageRooms.map(e => e.room + "(" + e.scores.overall.toFixed(0) + ")").join(", "));
  if (e.weakRooms.length > 0) o.push("   WEAK (" + e.weakRooms.length + "): " + e.weakRooms.map(e => e.room + "(" + e.scores.overall.toFixed(0) + ")").join(", "));
  o.push("");
  o.push("INFRASTRUCTURE TOTALS:");
  o.push("   Spawns: " + e.totalSpawns + " | Towers: " + e.totalTowers + " | Labs: " + e.totalLabs);
  o.push("   Nukers: " + e.roomsWithNuker + " | Factories: " + e.roomsWithFactory + " | Power Spawns: " + e.roomsWithPowerSpawn);
  o.push("");
  o.push("RESOURCE TOTALS:");
  o.push("   Storage Energy: " + _paFmtNum(e.totalStorageEnergy) + " | Terminal Energy: " + _paFmtNum(e.totalTerminalEnergy));
  o.push("   Power: " + _paFmtNum(e.totalPower) + " | Combat Boosts: " + _paFmtNum(e.totalCombatBoosts));
  o.push("");
  o.push("NUCLEAR ANALYSIS:");
  if (e.enemyNukeThreats.length > 0) {
    o.push("   ENEMY NUKE THREATS:");
    for (const t of e.enemyNukeThreats) {
      const e = t.ready ? "READY" : t.charging ? "CHARGING" : "EMPTY";
      o.push("      " + t.enemyRoom + " [" + e + "] threatens: " + t.threatens.join(", "));
    }
  } else o.push("   No enemy nukers can reach your rooms");
  if (e.myNukeTargets.length > 0) {
    o.push("   YOUR STRIKE CAPABILITY:");
    for (const t of e.myNukeTargets) o.push("      " + t.myRoom + " [" + (t.ready ? "READY" : "NOT READY") + "] can hit: " + t.canHit.join(", "));
  } else o.push("   None of your nukers can reach " + e.playerName + "'s rooms");
  o.push("");
  o.push("PER-ROOM DETAILS:");
  o.push("   Room         | RCL | Comp  | Def  | Off  | Eco  | Infra | Towers | Nuker    | Storage E  | Def Avg");
  o.push("   " + "-".repeat(105));
  const n = e.results.slice().sort((e, t) => t.scores.overall - e.scores.overall);
  for (const e of n) {
    const t = e.scores, n = e.room.padEnd(12), r = String(e.rcl).padStart(3), s = (t.composite === undefined ? t.overall : t.composite).toFixed(1).padStart(5), a = (t.defense === undefined ? t.military : t.defense).toFixed(1).padStart(5), i = (t.offense === undefined ? t.military : t.offense).toFixed(1).padStart(5), l = (t.economy === undefined ? t.economic : t.economy).toFixed(1).padStart(5), c = (t.infrastructure === undefined ? t.dualPurpose : t.infrastructure).toFixed(1).padStart(5), u = ((e.structures.towers || 0) + "/6").padStart(6), m = e.structures.nuker ? e.structures.nukerReady ? "READY" : e.structures.nukerCharging ? "Charging" : "Empty" : "None", f = m.padStart(8), p = _paFmtNum(e.resources.storageEnergy || 0).padStart(10), E = _paFmtNum(e.defense.avgDefenseHits || 0).padStart(9);
    o.push("   " + n + " | " + r + " | " + s + " | " + a + " | " + i + " | " + l + " | " + c + " | " + u + " | " + f + " | " + p + " | " + E);
  }
  o.push("");
  o.push("ATTACK RECOMMENDATIONS:");
  const r = n.filter(e => (e.scores.defense === undefined ? e.scores.military : e.scores.defense) < 50).sort((e, t) => (e.scores.defense === undefined ? e.scores.military : e.scores.defense) - (t.scores.defense === undefined ? t.scores.military : t.scores.defense)).slice(0, 5);
  if (r.length > 0) {
    o.push("   Most vulnerable (low defense score):");
    for (const e of r) {
      const t = [];
      if ((e.structures.towers || 0) < 3) t.push("few towers");
      if ((e.defense.avgDefenseHits || 0) < 1e6) t.push("weak walls");
      if ((e.defense.weakRamparts || 0) > 0) t.push("weak ramparts");
      if ((e.resources.storageEnergy || 0) < 1e5) t.push("low energy");
      const n = e.scores.defense === undefined ? e.scores.military : e.scores.defense;
      o.push("      " + e.room + " (Defense: " + n.toFixed(1) + ") - " + (t.length > 0 ? t.join(", ") : "general weakness"));
    }
  } else o.push("   No obviously vulnerable rooms found.");
  const s = e.myNukeTargets.filter(e => e.ready).map(e => ({
    myRoom: e.myRoom,
    targets: e.canHit.filter(e => {
      const t = n.find(t => t.room === e);
      return t && (t.scores.defense === undefined ? t.scores.military : t.scores.defense) < 50;
    })
  })).filter(e => e.targets.length > 0);
  if (s.length > 0) {
    o.push("");
    o.push("   NUKE-READY weak targets:");
    for (const e of s) o.push("      From " + e.myRoom + ": " + e.targets.join(", "));
  }
  o.push("");
  o.push(t);
  o.push("Analysis stored in Memory.lastPlayerAnalysis (expires in 10,000 ticks)");
  o.push(t);
  Memory.lastPlayerAnalysis = {
    player: e.playerName,
    tick: Game.time,
    expiresTick: Game.time + 1e4,
    roomCount: e.results.length,
    avgOverall: e.avgOverall,
    avgDefense: e.avgDefense,
    avgOffense: e.avgOffense,
    avgEconomic: e.avgEconomic,
    avgInfrastructure: e.avgInfrastructure,
    avgOperations: e.avgOperations,
    avgMilitary: e.avgMilitary,
    avgDualPurpose: e.avgDualPurpose,
    weakRooms: e.weakRooms.map(e => e.room),
    averageRooms: e.averageRooms.map(e => e.room),
    strongRooms: e.strongRooms.map(e => e.room),
    totalSpawns: e.totalSpawns,
    totalTowers: e.totalTowers,
    totalLabs: e.totalLabs,
    roomsWithNuker: e.roomsWithNuker,
    roomsWithFactory: e.roomsWithFactory,
    roomsWithPowerSpawn: e.roomsWithPowerSpawn,
    totalStorageEnergy: e.totalStorageEnergy,
    totalTerminalEnergy: e.totalTerminalEnergy,
    totalPower: e.totalPower,
    totalCombatBoosts: e.totalCombatBoosts,
    rooms: n.map(e => ({
      room: e.room,
      rcl: e.rcl,
      tick: e.tick,
      confidence: e.confidence,
      scores: e.scores,
      towers: e.structures.towers,
      nuker: e.structures.nuker,
      nukerReady: e.structures.nukerReady,
      nukerCharging: e.structures.nukerCharging,
      storageEnergy: e.resources.storageEnergy,
      avgDefenseHits: e.defense.avgDefenseHits,
      weakRamparts: e.defense.weakRamparts
    })),
    nukeThreats: e.enemyNukeThreats,
    myStrikes: e.myNukeTargets
  };
  console.log(o.join("\n"));
}

function getLastPlayerAnalysis() {
  if (!Memory.lastPlayerAnalysis) {
    console.log("[PlayerAnalysis] No previous analysis found.");
    return null;
  }
  const e = Memory.lastPlayerAnalysis;
  if (e.expiresTick <= Game.time) {
    console.log("[PlayerAnalysis] Previous analysis expired.");
    delete Memory.lastPlayerAnalysis;
    return null;
  }
  const t = Game.time - e.tick, o = e.expiresTick - Game.time;
  const n = [], r = "════════════════════════════════════════════════════════════════════════════════════════════════════";
  n.push(r);
  n.push("PLAYER ANALYSIS: " + e.player + " | Rooms: " + e.roomCount + " | " + t + " ticks ago (expires in " + o + "t)");
  n.push(r);
  n.push("Avg Composite: " + e.avgOverall.toFixed(1) + "/100 | Defense: " + (e.avgDefense === undefined ? "n/a" : e.avgDefense.toFixed(1)) + " | Offense: " + (e.avgOffense === undefined ? "n/a" : e.avgOffense.toFixed(1)) + " | Eco: " + e.avgEconomic.toFixed(1) + " | Infra: " + (e.avgInfrastructure === undefined ? e.avgDualPurpose.toFixed(1) : e.avgInfrastructure.toFixed(1)));
  if (e.strongRooms && e.strongRooms.length) n.push("STRONG (" + e.strongRooms.length + "): " + e.strongRooms.join(", "));
  if (e.averageRooms && e.averageRooms.length) n.push("AVERAGE (" + e.averageRooms.length + "): " + e.averageRooms.join(", "));
  if (e.weakRooms && e.weakRooms.length) n.push("WEAK (" + e.weakRooms.length + "): " + e.weakRooms.join(", "));
  if (e.nukeThreats && e.nukeThreats.length) {
    n.push("NUKE THREATS:");
    for (const t of e.nukeThreats) n.push("  " + t.enemyRoom + " [" + (t.ready ? "READY" : t.charging ? "CHARGING" : "EMPTY") + "] threatens: " + t.threatens.join(", "));
  }
  if (e.rooms && e.rooms.length && e.rooms[0].scores) {
    n.push("PER-ROOM: Room         | RCL | Comp  | Def  | Off  | Eco  | Infra | Storage E  | Nuker");
    for (const t of e.rooms) {
      const e = t.scores;
      n.push("  " + t.room.padEnd(12) + " | " + String(t.rcl).padStart(3) + " | " + (e.composite === undefined ? e.overall : e.composite).toFixed(1).padStart(5) + " | " + (e.defense === undefined ? "n/a" : e.defense.toFixed(1).padStart(5)) + " | " + (e.offense === undefined ? "n/a" : e.offense.toFixed(1).padStart(5)) + " | " + (e.economy === undefined ? e.economic : e.economy).toFixed(1).padStart(5) + " | " + (e.infrastructure === undefined ? e.dualPurpose : e.infrastructure).toFixed(1).padStart(5) + " | " + _paFmtNum(t.storageEnergy || 0).padStart(10) + " | " + (t.nuker ? t.nukerReady ? "READY" : t.nukerCharging ? "Charging" : "Empty" : "None"));
    }
  }
  n.push(r);
  console.log(n.join("\n"));
  return e;
}

function startPlayerScan(e, t) {
  if (!e || typeof e !== "string") {
    console.log('[PlayerScan] Usage: playerScan("PlayerName", "CREEPCOUNT")');
    return;
  }
  t = (t || "CREEPCOUNT").toUpperCase();
  if (!PA_SCAN_TYPES.includes(t)) {
    console.log('[PlayerScan] Unknown scan type "' + t + '". Available: ' + PA_SCAN_TYPES.join(", "));
    return;
  }
  if (Memory.playerScan && Memory.playerScan.active) {
    console.log("[PlayerScan] Scan already in progress for " + Memory.playerScan.targetPlayer + ". Use playerScanCancel().");
    return;
  }
  const o = getObserverMap(), n = Object.keys(o);
  if (!n.length) {
    console.log("[PlayerScan] No observers found.");
    return;
  }
  const r = [];
  for (const e of n) {
    const t = parseRoomCoords(e);
    if (!t) continue;
    for (let e = -OBSERVER_RANGE; e <= OBSERVER_RANGE; e++) for (let o = -OBSERVER_RANGE; o <= OBSERVER_RANGE; o++) {
      if (e === 0 && o === 0) continue;
      r.push(toRoomName(t.x + e, t.y + o));
    }
  }
  const s = [ ...new Set(r) ].filter(e => isClaimableRoom(e));
  console.log("[PlayerScan] Starting " + t + " scan for: " + e + " (" + s.length + " rooms)");
  Memory.playerScan = {
    active: true,
    type: t,
    targetPlayer: e,
    startTick: Game.time,
    scanQueue: s.slice(),
    scannedCount: 0,
    totalScanRooms: s.length,
    lastObservedRoom: null,
    creepCounts: {
      military: 0,
      claimer: 0,
      worker: 0,
      supplier: 0,
      scout: 0,
      other: 0,
      total: 0
    },
    roomBreakdown: {}
  };
}

function _paCreepScanTick() {
  if (!Memory.playerScan || !Memory.playerScan.active) return;
  const e = Memory.playerScan, t = getObserverMap();
  if (e.lastObservedRoom) {
    const t = Game.rooms[e.lastObservedRoom];
    if (t && t.controller && t.controller.owner && t.controller.owner.username === e.targetPlayer && e.type === "CREEPCOUNT") {
      const o = t.find(FIND_HOSTILE_CREEPS, {
        filter: t => t.owner && t.owner.username === e.targetPlayer
      });
      const n = {
        military: 0,
        claimer: 0,
        worker: 0,
        supplier: 0,
        scout: 0,
        other: 0,
        total: o.length
      };
      for (const t of o) {
        const o = _paCategorizeCreep(t);
        n[o]++;
        e.creepCounts[o]++;
        e.creepCounts.total++;
      }
      e.roomBreakdown[e.lastObservedRoom] = n;
    }
    e.scannedCount++;
    e.lastObservedRoom = null;
  }
  if (!e.scanQueue.length) {
    _paCompleteCreepScan(e);
    return;
  }
  const o = e.scanQueue[0];
  const n = findObserverForRoom(o, t);
  if (!n) {
    e.scanQueue.shift();
    e.scannedCount++;
  } else if (_tickObserve(n, o)) {
    e.scanQueue.shift();
    e.lastObservedRoom = o;
  }
  if (e.scannedCount > 0 && e.scannedCount % 200 === 0) console.log("[PlayerScan] " + e.scannedCount + "/" + e.totalScanRooms + " (" + (e.scannedCount / e.totalScanRooms * 100).toFixed(1) + "%)");
}

function _paCompleteCreepScan(e) {
  const t = Game.time - e.startTick, o = Object.keys(e.roomBreakdown).length, n = e.creepCounts;
  const r = "════════════════════════════════════════════════════════════════════════", s = [];
  s.push(r);
  s.push("CREEP COUNT: " + e.targetPlayer + "  |  Rooms found: " + o + "  |  Elapsed: " + t + " ticks");
  s.push(r);
  s.push("");
  s.push("  Total creeps:  " + n.total);
  s.push("");
  const a = [ {
    key: "military",
    label: "Military "
  }, {
    key: "worker",
    label: "Worker   "
  }, {
    key: "supplier",
    label: "Supplier "
  }, {
    key: "claimer",
    label: "Claimer  "
  }, {
    key: "scout",
    label: "Scout    "
  }, {
    key: "other",
    label: "Other    "
  } ];
  for (const e of a) {
    const t = n[e.key];
    if (!t) continue;
    const o = n.total > 0 ? (t / n.total * 100).toFixed(1) : "0.0";
    const r = "|".repeat(Math.round(t / Math.max(n.total, 1) * 20));
    s.push("  " + e.label + "  " + String(t).padStart(4) + "  (" + o.padStart(5) + "%)  " + r);
  }
  if (o > 1) {
    s.push("");
    s.push("  Per room:");
    s.push("  Room         | Total | Mil | Work | Sup | Claim | Scout | Other");
    s.push("  " + "-".repeat(64));
    const t = Object.entries(e.roomBreakdown).sort((e, t) => t[1].total - e[1].total);
    for (const [e, o] of t) s.push("  " + e.padEnd(12) + " | " + String(o.total).padStart(5) + " | " + String(o.military).padStart(3) + " | " + String(o.worker).padStart(4) + " | " + String(o.supplier).padStart(3) + " | " + String(o.claimer).padStart(5) + " | " + String(o.scout).padStart(5) + " | " + String(o.other).padStart(5));
  }
  s.push("");
  s.push(r);
  console.log(s.join("\n"));
  Game.notify("[PlayerScan] " + e.targetPlayer + ": Total " + n.total + " | Mil:" + n.military + " Work:" + n.worker + " Sup:" + n.supplier + (n.claimer ? " Claim:" + n.claimer : "") + (n.scout ? " Scout:" + n.scout : ""), 0);
  delete Memory.playerScan;
}

function cancelPlayerScan() {
  if (Memory.playerScan && Memory.playerScan.active) {
    console.log("[PlayerScan] Scan cancelled.");
    delete Memory.playerScan;
  } else console.log("[PlayerScan] No active scan.");
}

function getPlayerScanStatus() {
  if (!Memory.playerScan || !Memory.playerScan.active) {
    console.log("[PlayerScan] No active scan.");
    return null;
  }
  const e = Memory.playerScan, t = (e.scannedCount / e.totalScanRooms * 100).toFixed(1);
  console.log("[PlayerScan] Target: " + e.targetPlayer + " | Progress: " + e.scannedCount + "/" + e.totalScanRooms + " (" + t + "%) | Rooms found: " + Object.keys(e.roomBreakdown).length + " | Elapsed: " + (Game.time - e.startTick) + "t");
  if (e.type === "CREEPCOUNT" && e.creepCounts.total > 0) {
    const t = e.creepCounts;
    console.log("[PlayerScan] Creeps so far: " + t.total + " | Mil:" + t.military + " Work:" + t.worker + " Sup:" + t.supplier + " Claim:" + t.claimer + " Scout:" + t.scout + " Other:" + t.other);
  }
  return e;
}

function startWideScan(e) {
  if (!e || typeof e !== "string") {
    console.log('[WideScan] Usage: wideScan("PlayerName")');
    return;
  }
  const t = _regMem();
  if (_regFresh() && !(t.sweep && t.sweep.active)) {
    _wsReport(e);
    return;
  }
  Memory.wideScanReport = {
    player: e,
    started: Game.time
  };
  _regStartSweep();
  console.log("[WideScan] Registry sweep " + (t.sweep && t.sweep.active ? "in progress" : "started") + " — report for " + e + " prints on completion. (wideScanStatus for progress)");
}

function startWideScanPlayers() {
  const e = _regMem();
  if (_regFresh() && !(e.sweep && e.sweep.active)) {
    _wsReport(null);
    return;
  }
  Memory.wideScanReport = {
    player: null,
    started: Game.time
  };
  _regStartSweep();
  console.log("[WideScan] Registry sweep " + (e.sweep && e.sweep.active ? "in progress" : "started") + " — full player report prints on completion.");
}

function _wsReport(e) {
  const t = _regMem();
  const o = t.lastSweepEnd ? Game.time - t.lastSweepEnd + "t" : "never swept";
  console.log("================================================================");
  if (e) {
    const n = _regRoomsOf(e);
    if (n.length) console.log("[WideScan] " + e + " owns " + n.length + " room(s): " + n.map(e => e + "(RCL" + t.rooms[e].l + ")").join(", ") + "  [registry age: " + o + "]"); else console.log("[WideScan] " + e + " owns no rooms within observer range.  [registry age: " + o + "]");
  } else {
    const e = {};
    for (const o in t.rooms) {
      const n = t.rooms[o];
      if (!e[n.o]) e[n.o] = [];
      e[n.o].push(o + "(RCL" + n.l + ")");
    }
    const n = Object.keys(e).sort();
    console.log("[WideScan] Players found: " + n.length + "  [registry age: " + o + "]");
    for (const t of n) console.log("  " + t + ": " + e[t].sort().join(", "));
  }
  console.log("================================================================");
}

function _wsOnSweepComplete() {
  if (Memory.wideScanReport) {
    _wsReport(Memory.wideScanReport.player);
    delete Memory.wideScanReport;
  }
}

function cancelWideScan() {
  if (Memory.wideScanReport) {
    delete Memory.wideScanReport;
    console.log("[WideScan] Pending report cancelled. (The registry sweep continues — it serves the registry, not just this report.)");
  } else console.log("[WideScan] No pending wideScan report.");
}

function getWideScanStatus() {
  const e = _regMem();
  if (e.sweep && e.sweep.active) {
    const t = e.sweep, o = (t.scanned / Math.max(t.total, 1) * 100).toFixed(1);
    console.log("[WideScan] Sweep: " + t.scanned + "/" + t.total + " (" + o + "%) | Elapsed: " + (Game.time - t.started) + "t | Remaining: ~" + Math.ceil((t.total - t.scanned) / Math.max(Object.keys(t.queues).length, 1)) + "t" + (Memory.wideScanReport ? " | Report pending: " + (Memory.wideScanReport.player || "all players") : ""));
  } else {
    console.log("[WideScan] No sweep active. Registry age: " + (e.lastSweepEnd ? Game.time - e.lastSweepEnd + "t" : "never swept") + '. Use wideScan("Name") or registrySweep().');
  }
  return e.sweep || null;
}

function _wsRun() {}

function _weGetMyRooms() {
  const e = [];
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (o.controller && o.controller.my) e.push(t);
  }
  return e;
}

function _weGetEnemyRoomsFromCache(e) {
  if (!Memory.lastPlayerAnalysis || Memory.lastPlayerAnalysis.player !== e) return null;
  if (Memory.lastPlayerAnalysis.expiresTick <= Game.time) return null;
  const t = Memory.lastPlayerAnalysis.rooms;
  if (!t || !t.length) return null;
  return t.map(e => e.room);
}

function _weScore0to100(e, t) {
  return Math.min(100, e / t * 100);
}

function _weScore100to0(e, t) {
  return Math.max(0, 100 - e / t * 100);
}

function _weAvg(e) {
  return e.length > 0 ? e.reduce((e, t) => e + t, 0) / e.length : 0;
}

function gatherSnapshot(e) {
  const t = {
    tick: Game.time,
    rooms: {}
  };
  for (const o of e.enemyRooms || []) {
    const e = Game.rooms[o];
    if (!e) continue;
    const n = _roomFingerprint(e);
    const r = _fpByType(n, STRUCTURE_SPAWN);
    const s = _fpByType(n, STRUCTURE_TOWER);
    const a = _fpByType(n, STRUCTURE_LAB);
    const i = e.storage;
    const l = _fpByType(n, STRUCTURE_TERMINAL)[0];
    const c = _fpByType(n, STRUCTURE_FACTORY)[0];
    const u = _fpByType(n, STRUCTURE_POWER_SPAWN)[0];
    const m = _fpByType(n, STRUCTURE_NUKER)[0];
    const f = _fpByType(n, STRUCTURE_RAMPART);
    const p = _fpByType(n, STRUCTURE_WALL);
    const E = _itOwnerCreeps(e, n);
    const d = {};
    for (const e of ALL_COMBAT_BOOSTS) {
      let t = 0;
      if (i && i.store) t += i.store[e] || 0;
      if (l && l.store) t += l.store[e] || 0;
      for (const o of a) if (o.mineralType === e) t += o.store[e] || 0;
      if (t > 0) d[e] = t;
    }
    const R = {};
    for (const e of BASE_MINERALS) {
      let t = 0;
      if (i && i.store) t += i.store[e] || 0;
      if (l && l.store) t += l.store[e] || 0;
      if (t > 0) R[e] = t;
    }
    const _ = f.concat(p);
    const g = _.map(e => e.hits);
    const y = E.filter(e => {
      const t = e.body.filter(e => e.type === WORK).length;
      return t > 0 && t / e.body.length > .25;
    });
    const T = y.reduce((e, t) => e + t.body.filter(e => e.type === WORK).length * CREEP_REPAIR_HITS, 0);
    const S = _fpByType(n, STRUCTURE_EXTENSION);
    t.rooms[o] = {
      tick: Game.time,
      rcl: e.controller ? e.controller.level : 0,
      spawns: r.length,
      towers: s.length,
      labs: a.length,
      factory: !!c,
      factoryLevel: c ? c.level || 0 : 0,
      powerSpawn: !!u,
      hasNuker: !!m,
      nukerReady: m ? _nkIsNukerOp(m) : false,
      hasTerminal: !!l,
      hasStorage: !!i,
      storageEnergy: i ? i.store[RESOURCE_ENERGY] || 0 : 0,
      storageTotal: i ? i.store.getUsedCapacity() : 0,
      terminalEnergy: l ? l.store[RESOURCE_ENERGY] || 0 : 0,
      terminalTotal: l ? l.store.getUsedCapacity() : 0,
      terminalCooldown: l ? l.cooldown || 0 : 0,
      extensionCount: S.length,
      extensionFilled: S.filter(e => e.store[RESOURCE_ENERGY] > 0).length,
      safeModeAvailable: e.controller ? e.controller.safeModeAvailable || 0 : 0,
      safeMode: e.controller ? e.controller.safeMode || 0 : 0,
      safeModeCooldown: e.controller ? e.controller.safeModeCooldown || 0 : 0,
      powerCreeps: _itOwnerPowerCreeps(e, n).length,
      energyCapacity: e.energyCapacityAvailable,
      energyAvailable: e.energyAvailable,
      activeSpawning: r.filter(e => e.spawning).length,
      boosts: d,
      minerals: R,
      defHPCount: _.length,
      defHPMedian: g.length ? g.sort((e, t) => e - t)[Math.floor(g.length / 2)] : 0,
      defHPSum: g.reduce((e, t) => e + t, 0),
      weakRamparts: f.filter(e => e.hits < 1e5).length,
      repairCapacity: T,
      allCreepCount: E.length
    };
  }
  return t;
}

function gatherRoomWarData(e, t) {
  if (!t.roomData) t.roomData = {};
  const o = gatherSnapshot({
    enemyRooms: [ e.name ]
  });
  const n = o.rooms[e.name];
  if (!n) return;
  if (!t.roomData[e.name]) t.roomData[e.name] = {
    scans: [],
    nukeData: null
  };
  t.roomData[e.name].scans.push(n);
  try {
    const o = _nkComputeBestStrike(e);
    t.roomData[e.name].nukeData = o;
  } catch (e) {}
}

function computeWarEstimate(e) {
  const t = e.enemyRooms || [];
  const o = _weGetMyRooms();
  const n = e.roomData || {};
  const r = e.snapshots || [];
  const s = r.length > 0 ? r[r.length - 1] : null;
  const a = r.length > 0 ? r[0] : null;
  const i = [ "short", "medium", "long" ];
  function getLatest(e, t) {
    if (!s || !s.rooms[e]) return 0;
    return s.rooms[e][t] || 0;
  }
  function getFirst(e, t) {
    if (!a || !a.rooms[e]) return 0;
    return a.rooms[e][t] || 0;
  }
  function sumAllRooms(e) {
    return t.reduce((t, o) => t + getLatest(o, e), 0);
  }
  const l = new Set;
  for (const e of t) for (const o of t) if (e !== o && getRoomDistance(e, o) <= SUPPORT_RANGE) l.add(o);
  const c = new Set;
  for (const e of o) for (const o of t) if (getRoomDistance(e, o) <= OBSERVER_RANGE) c.add(o);
  const u = t.reduce((e, t) => e + ([ ...l ].includes(t) ? getLatest(t, "spawns") : 0), 0);
  const m = t.reduce((e, t) => e + (c.has(t) ? getLatest(t, "towers") : 0), 0);
  const f = t.filter(e => getLatest(e, "hasTerminal"));
  const p = t.filter(e => o.some(t => canNuke(e, t)));
  const E = t.length > 0 ? _weAvg(t.map(e => o.length > 0 ? Math.min(...o.map(t => getRoomDistance(e, t))) : 15)) : 15;
  const d = _weScore100to0(E, WE_CAPS.maxRoomSpread);
  const R = {
    distance: d,
    spawnsSupport: _weScore0to100(u, WE_CAPS.spawnsInTheater),
    towersTheater: _weScore0to100(m, WE_CAPS.towersInTheater),
    terminalRelay: _weScore0to100(f.length, t.length) * 100,
    nukeOverlap: _weScore0to100(p.length, Math.max(t.length, 1)) * 100,
    roomsSupport: _weScore0to100(l.size, WE_CAPS.roomsInSupport)
  };
  const _ = {};
  for (const e of i) {
    const t = WE_W.forceProjection[e];
    _[e] = clamp(Object.keys(t).reduce((e, o) => e + t[o] * (R[o] || 0), 0));
  }
  const g = sumAllRooms("energyCapacity");
  const y = sumAllRooms("activeSpawning");
  const T = sumAllRooms("extensionFilled"), S = sumAllRooms("extensionCount");
  const h = S > 0 ? T / S : 0;
  const C = t.some(e => getLatest(e, "powerSpawn"));
  const O = C ? 100 : 0;
  const N = sumAllRooms("allCreepCount");
  const P = {
    energyCap: _weScore0to100(g, WE_CAPS.energyCap),
    activeSpawns: _weScore0to100(y, WE_CAPS.activeSpawns),
    extensionFill: h * 100,
    operatorBoost: O,
    creepsPer100: _weScore0to100(N, 100)
  };
  const M = {};
  for (const e of i) {
    const t = WE_W.spawnThroughput[e];
    M[e] = clamp(Object.keys(t).reduce((e, o) => e + t[o] * (P[o] || 0), 0));
  }
  const w = sumAllRooms("storageEnergy") + sumAllRooms("terminalEnergy");
  const A = t.reduce((e, t) => {
    const o = n[t];
    if (!o || !o.scans || !o.scans.length) return e;
    const r = o.scans[o.scans.length - 1];
    if (!r || !r.minerals) return e;
    return e + Object.values(r.minerals).reduce((e, t) => e + t, 0);
  }, 0);
  const k = A > 0;
  const b = t.reduce((e, t) => e + getLatest(t, "towers") * (TOWER_ENERGY_COST * 1500 / TICKS_PER_DAY) + getLatest(t, "spawns") * 400, 0);
  const v = f.reduce((e, t) => e + getLatest(t, "terminalTotal"), 0) / Math.max(f.length, 1);
  let I = 100;
  if (r.length >= 2) {
    const e = t.reduce((e, t) => e + getFirst(t, "storageEnergy"), 0);
    const o = t.reduce((e, t) => e + getLatest(t, "storageEnergy"), 0);
    if (e > 0) I = clamp(o / e * 100);
  }
  const U = {
    warChest: _weScore0to100(w, WE_CAPS.warChest),
    baseIncome: _weScore0to100(t.length, WE_CAPS.economicTiers) * 100 / 100,
    econProduction: k ? 75 : 25,
    tradeLiquidity: _weScore0to100(f.length, WE_CAPS.marketScore / 10) * WE_CAPS.marketScore,
    burnRate: _weScore100to0(b, WE_CAPS.burnRate),
    terminalDepth: _weScore0to100(v, WE_CAPS.terminalDepth * 1e5),
    mineralPressure: k ? 75 : 25,
    depletion: I
  };
  const L = {};
  for (const e of i) {
    const t = WE_W.attrition[e];
    L[e] = clamp(Object.keys(t).reduce((e, o) => e + t[o] * (U[o] || 0), 0));
  }
  const F = {};
  for (const e of t) {
    const t = n[e];
    if (!t || !t.scans || !t.scans.length) continue;
    const o = t.scans[t.scans.length - 1];
    if (!o || !o.boosts) continue;
    for (const e in o.boosts) F[e] = (F[e] || 0) + o.boosts[e];
  }
  const G = Object.values(F).reduce((e, t) => e + t, 0);
  const x = T3_BOOSTS.filter(e => F[e] > 0).length;
  const D = sumAllRooms("labs");
  const W = t.reduce((e, t) => {
    const o = n[t];
    if (!o || !o.scans || !o.scans.length) return e;
    const r = o.scans[o.scans.length - 1];
    if (!r || !r.minerals) return e;
    for (const t of BASE_MINERALS) if (r.minerals[t] > 0) e.add(t);
    return e;
  }, new Set).size;
  const Y = COMBAT_BOOSTS_TUFF.filter(e => F[e] > 0).length;
  const B = {
    stockpile: _weScore0to100(G, WE_CAPS.combatBoosts),
    tierDistribution: _weScore0to100(x, 6) * 100 / 6,
    labCapacity: _weScore0to100(D, WE_CAPS.labCount),
    baseMinerals: _weScore0to100(W, WE_CAPS.baseMineralTypes),
    replenishment: A > 0 ? 75 : 20,
    defensiveBoosts: _weScore0to100(Y, 4) * 100 / 4
  };
  const H = {};
  for (const e of i) {
    const t = WE_W.boostCapacity[e];
    H[e] = clamp(Object.keys(t).reduce((e, o) => e + t[o] * (B[o] || 0), 0));
  }
  const K = sumAllRooms("repairCapacity");
  const V = t.map(e => getLatest(e, "defHPMedian")).filter(e => e > 0);
  const j = V.length > 0 ? V.sort((e, t) => e - t)[Math.floor(V.length / 2)] : 0;
  const z = sumAllRooms("safeModeAvailable");
  const X = t.reduce((e, t) => {
    const o = getLatest(t, "towers") * TOWER_ENERGY_COST * 1e3;
    const n = getLatest(t, "storageEnergy");
    return e + (o > 0 ? Math.min(n / o, 1) : 0);
  }, 0) / Math.max(t.length, 1);
  const Q = Game.gcl && Game.gcl.progress && Game.gcl.progressTotal ? Game.gcl.progress / Game.gcl.progressTotal : .5;
  const q = _weAvg(t.map(e => getLatest(e, "safeModeAvailable") > 0 ? 100 : getLatest(e, "safeModeCooldown") === 0 ? 50 : 0));
  const Z = {
    repairThroughput: _weScore0to100(K, WE_CAPS.repairPerTick),
    wallHPPool: _weScore0to100(j, WE_CAPS.wallHPMedian),
    safeModeInventory: _weScore0to100(z, 5),
    towerSustain: X * 100,
    gclHeadroom: Q * 100,
    rebuildCapacity: _weScore0to100(w, WE_CAPS.warChest / 2),
    controllerFort: q
  };
  const $ = {};
  for (const e of i) {
    const t = WE_W.defensiveDepth[e];
    $[e] = clamp(Object.keys(t).reduce((e, o) => e + t[o] * (Z[o] || 0), 0));
  }
  const J = y > 0 ? 1 : 0;
  const ee = f.length > 0 ? _weAvg(f.map(e => getLatest(e, "terminalCooldown") === 0 ? 100 : 50)) : 0;
  const te = _weScore100to0(avgDistanceBetweenRooms(t), WE_CAPS.maxRoomSpread);
  const oe = t.filter(e => getLatest(e, "safeMode") === 0 && getLatest(e, "activeSpawning") === 0).length;
  const ne = Math.max(o.length, 1) / Math.max(t.length, 1);
  const re = o.length > t.length * 1.5 ? 20 : 100;
  const se = {
    spawnAllocation: J * 100,
    terminalBandwidth: ee,
    geoSpread: te,
    reserveRooms: _weScore0to100(oe, WE_CAPS.roomsInSupport),
    perFrontRatio: clamp(ne * 100 / 2),
    ownStrain: re
  };
  const ae = {};
  for (const e of i) {
    const t = WE_W.multiFrontStrain[e];
    ae[e] = clamp(Object.keys(t).reduce((e, o) => e + t[o] * (se[o] || 0), 0));
  }
  const ie = {};
  for (const e of i) {
    const t = WE_CAT_WEIGHTS;
    ie[e] = clamp(t.forceProjection * _[e] + t.spawnThroughput * M[e] + t.attrition * L[e] + t.boostCapacity * H[e] + t.defensiveDepth * $[e] + t.multiFrontStrain * ae[e]);
  }
  const le = {};
  for (const e of t) {
    const t = n[e];
    if (t && t.nukeData) le[e] = t.nukeData;
  }
  return {
    forceProjection: _,
    spawnThroughput: M,
    attrition: L,
    boostCapacity: H,
    defensiveDepth: $,
    multiFrontStrain: ae,
    composite: ie,
    raw: {
      fp: R,
      st: P,
      at: U,
      bc: B,
      dd: Z,
      mf: se
    },
    nukeByRoom: le,
    warChest: w,
    totalBoosts: G,
    totalLabs: D,
    spawnsInSupport: u,
    towersInTheater: m,
    avgDist: E
  };
}

function startWarEstimate(e) {
  if (!e || typeof e !== "string") {
    console.log('[WarEstimate] Usage: warEstimate("PlayerName")');
    return;
  }
  if (Memory.warEstimate && Memory.warEstimate.active) {
    console.log("[WarEstimate] Estimate in progress for " + Memory.warEstimate.targetPlayer + ". Use warEstimateCancel().");
    return;
  }
  const t = _weGetEnemyRoomsFromCache(e);
  const o = {
    active: true,
    targetPlayer: e,
    startTick: Game.time,
    phase: "discovery",
    enemyRooms: t || [],
    roomData: {},
    snapshots: [],
    snapCount: 0,
    lastSnapTick: 0,
    notifyQueue: [],
    notifyIndex: 0,
    report: null
  };
  if (t && t.length) {
    o.phase = "intel";
    o.intelQueue = t.slice();
    o.intelCount = 0;
    o.totalIntelRooms = t.length;
    o.lastObservedRoom = null;
    console.log("[WarEstimate] Skipping discovery (fresh player() data). Proceeding to Intel phase. Enemy rooms: " + t.join(", "));
  } else {
    if (!_regFresh()) _regStartSweep();
    console.log("[WarEstimate] Phase 1: Discovery — reading the room registry for " + e + "'s rooms" + (_regFresh() ? "." : " (sweep running)."));
  }
  Memory.warEstimate = o;
}

function cancelWarEstimate() {
  if (Memory.warEstimate && Memory.warEstimate.active) {
    console.log("[WarEstimate] Estimate cancelled.");
    delete Memory.warEstimate;
  } else console.log("[WarEstimate] No active estimate.");
}

function getWarEstimateStatus() {
  if (!Memory.warEstimate || !Memory.warEstimate.active) {
    console.log("[WarEstimate] No active estimate.");
    return null;
  }
  const e = Memory.warEstimate, t = Game.time - e.startTick;
  console.log("[WarEstimate] Target: " + e.targetPlayer + " | Phase: " + e.phase + " | Elapsed: " + t + "t");
  if (e.phase === "discovery") {
    const e = _regMem();
    console.log("  Waiting on registry" + (e.sweep && e.sweep.active ? " sweep: " + e.sweep.scanned + "/" + e.sweep.total : ""));
  } else if (e.phase === "intel") console.log("  Intel: " + e.intelCount + "/" + e.totalIntelRooms + " | Enemy rooms: " + e.enemyRooms.join(", ")); else if (e.phase === "monitor") console.log("  Monitor: " + e.snapCount + "/" + WE_MONITOR_SAMPLES + " snapshots. Next in ~" + (e.lastSnapTick + WE_MONITOR_INTERVAL - Game.time) + "t"); else if (e.phase === "notify") console.log("  Notifying: " + (e.notifyIndex || 0) + "/" + (e.notifyQueue && e.notifyQueue.length || 0));
  return e;
}

function getLastWarEstimate() {
  if (!Memory.lastWarEstimate) {
    console.log("[WarEstimate] No previous estimate found.");
    return null;
  }
  const e = Memory.lastWarEstimate;
  if (e.expiresTick <= Game.time) {
    console.log("[WarEstimate] Previous estimate expired.");
    delete Memory.lastWarEstimate;
    return null;
  }
  _wePrintReport(e);
  return e;
}

function _weRun() {
  if (Memory.lastWarEstimate && Memory.lastWarEstimate.expiresTick <= Game.time) delete Memory.lastWarEstimate;
  if (!Memory.warEstimate || !Memory.warEstimate.active) return;
  const e = Memory.warEstimate;
  if (e.phase === "discovery") {
    const t = _regMem();
    if (t.sweep && t.sweep.active) return;
    if (!_regFresh()) {
      if (Game.time - e.startTick > 1e4) {
        console.log("[WarEstimate] Discovery failed — registry sweep never completed (no observers?). Cancelling.");
        delete Memory.warEstimate;
        return;
      }
      _regStartSweep();
      return;
    }
    const o = _regRoomsOf(e.targetPlayer);
    if (!o.length) {
      console.log("[WarEstimate] Discovery complete: no rooms found for " + e.targetPlayer + ".");
      delete Memory.warEstimate;
      return;
    }
    e.enemyRooms = o;
    e.phase = "intel";
    e.intelQueue = o.slice();
    e.intelCount = 0;
    e.totalIntelRooms = o.length;
    e.lastObservedRoom = null;
    console.log("[WarEstimate] Phase 2: Intel on " + o.length + " room(s): " + o.join(", "));
  } else if (e.phase === "intel") {
    _weIntelPhase(e);
  } else if (e.phase === "monitor") {
    _weMonitorPhase(e);
  } else if (e.phase === "compute") {
    _weComputePhase(e);
  } else if (e.phase === "notify") {
    _weNotifyPhase(e);
  }
}

function _weIntelPhase(e) {
  const t = getObserverMap();
  if (e.lastObservedRoom) {
    const t = Game.rooms[e.lastObservedRoom];
    if (t) {
      gatherRoomWarData(t, e);
      console.log("[WarEstimate] Intel gathered: " + e.lastObservedRoom);
    }
    e.intelCount++;
    e.lastObservedRoom = null;
  }
  if (!e.intelQueue || !e.intelQueue.length) {
    console.log("[WarEstimate] Phase 2: Intel complete. Starting monitor phase (" + WE_MONITOR_SAMPLES + " snapshots @ " + WE_MONITOR_INTERVAL + " tick intervals).");
    e.phase = "monitor";
    e.lastSnapTick = Game.time;
    e.snapCount = 0;
    return;
  }
  const o = e.intelQueue[0];
  const n = Game.rooms[o];
  if (n) {
    e.intelQueue.shift();
    gatherRoomWarData(n, e);
    e.intelCount++;
    console.log("[WarEstimate] Intel gathered: " + o);
    return;
  }
  const r = findObserverForRoom(o, t);
  if (!r) {
    e.intelQueue.shift();
    e.intelCount++;
  } else if (_tickObserve(r, o)) {
    e.intelQueue.shift();
    e.lastObservedRoom = o;
  }
}

function _weMonitorPhase(e) {
  const t = getObserverMap();
  for (const o of e.enemyRooms) {
    if (Game.rooms[o]) continue;
    const e = findObserverForRoom(o, t);
    if (e) _tickObserve(e, o);
  }
  if (Game.time - e.lastSnapTick >= WE_MONITOR_INTERVAL) {
    const t = gatherSnapshot(e);
    if (Object.keys(t.rooms).length > 0) {
      e.snapshots.push(t);
      e.snapCount++;
      e.lastSnapTick = Game.time;
      console.log("[WarEstimate] Monitor snapshot " + e.snapCount + "/" + WE_MONITOR_SAMPLES + " taken.");
    }
    if (e.snapCount >= WE_MONITOR_SAMPLES) {
      console.log("[WarEstimate] Phase 3: Monitor complete. Computing estimates...");
      e.phase = "compute";
    }
  }
}

function _weComputePhase(e) {
  try {
    const t = computeWarEstimate(e);
    const o = {
      player: e.targetPlayer,
      tick: Game.time,
      elapsed: Game.time - e.startTick,
      expiresTick: Game.time + 2e3,
      result: t
    };
    e.report = o;
    Memory.lastWarEstimate = o;
    _weGenerateNotifyQueue(e, t);
    e.phase = "notify";
    console.log("[WarEstimate] Phase 4: Compute complete. Sending notifications...");
  } catch (e) {
    console.log("[WarEstimate] ERROR in compute phase: " + e.message);
    delete Memory.warEstimate;
  }
}

function _weGenerateNotifyQueue(e, t) {
  const o = [];
  const n = t;
  const r = n.composite;
  o.push("[WarEstimate] " + e.targetPlayer);
  o.push("Score (Short/Med/Long):");
  o.push("  Overall: S:" + r.short.toFixed(0) + " M:" + r.medium.toFixed(0) + " L:" + r.long.toFixed(0));
  for (const e of [ "short", "medium", "long" ]) o.push(e.toUpperCase() + ": FP:" + n.forceProjection[e].toFixed(0) + " ST:" + n.spawnThroughput[e].toFixed(0) + " AT:" + n.attrition[e].toFixed(0) + " BC:" + n.boostCapacity[e].toFixed(0) + " DD:" + n.defensiveDepth[e].toFixed(0) + " MF:" + n.multiFrontStrain[e].toFixed(0));
  const s = [];
  let a = "";
  for (const e of o) {
    if ((a + "\n" + e).length > WE_NOTIFY_TOTAL_MAX) {
      if (a) s.push(a);
      a = e;
    } else a += "\n" + e;
  }
  if (a) s.push(a);
  e.notifyQueue = s;
  e.notifyIndex = 0;
}

function _weNotifyPhase(e) {
  if (!e.notifyQueue || e.notifyIndex >= e.notifyQueue.length) {
    console.log("[WarEstimate] Phase 5: Notifications sent. Estimate complete.");
    _wePrintReport(e.report);
    delete Memory.warEstimate;
    return;
  }
  let t = 0;
  while (e.notifyIndex < e.notifyQueue.length && t < WE_NOTIFY_PER_TICK) {
    const o = e.notifyQueue[e.notifyIndex];
    try {
      Game.notify(o, 0);
    } catch (e) {}
    e.notifyIndex++;
    t++;
  }
}

function _wePrintReport(e) {
  if (!e || !e.result) {
    console.log("[WarEstimate] No report data to print.");
    return;
  }
  const t = e.result, o = "════════════════════════════════════════════════════════════════════════", n = [];
  n.push(o);
  n.push("WAR ESTIMATE: " + e.player + "  |  Generated: " + e.tick + " (" + e.elapsed + " ticks)");
  n.push(o);
  const r = [ "short", "medium", "long" ], s = {
    short: "SHORT (0-50k)",
    medium: "MEDIUM (50k-200k)",
    long: "LONG (200k+)"
  };
  for (const e of r) {
    n.push("");
    n.push("-- " + s[e] + " --");
    n.push("  Overall: " + t.composite[e].toFixed(1) + "/100");
    n.push("  Force Projection: " + t.forceProjection[e].toFixed(1) + "/100  | Spawn Throughput: " + t.spawnThroughput[e].toFixed(1) + "/100");
    n.push("  Attrition:         " + t.attrition[e].toFixed(1) + "/100  | Boost Capacity:   " + t.boostCapacity[e].toFixed(1) + "/100");
    n.push("  Defensive Depth:   " + t.defensiveDepth[e].toFixed(1) + "/100  | Multi-Front:      " + t.multiFrontStrain[e].toFixed(1) + "/100");
  }
  n.push("");
  n.push("RAW DATA:");
  n.push("  War Chest: " + fmtE(t.warChest) + " energy | Combat Boosts: " + fmtNum(t.totalBoosts) + " | Labs: " + t.totalLabs);
  n.push("  Spawns in Support Range: " + t.spawnsInSupport + " | Towers in Theater: " + t.towersInTheater + " | Avg Distance: " + t.avgDist.toFixed(1));
  if (t.nukeByRoom && Object.keys(t.nukeByRoom).length > 0) {
    n.push("");
    n.push("NUKE STRIKE ANALYSIS:");
    for (const e in t.nukeByRoom) {
      const o = t.nukeByRoom[e];
      n.push("  " + e + ": Best strike (" + o.x + "," + o.y + ") = " + fmtCr(o.damage) + " damage (" + o.percent + "% of nuke cost). Destroys: " + o.destroyedSummary);
    }
  }
  n.push("");
  n.push(o);
  console.log(n.join("\n"));
}

function _schedMem() {
  if (!Memory.obsSched) Memory.obsSched = {
    req: {},
    held: {}
  };
  if (!Memory.obsSched.req) Memory.obsSched.req = {};
  if (!Memory.obsSched.held) Memory.obsSched.held = {};
  return Memory.obsSched;
}

function obsRequest(e, t, o, n) {
  if (!e || typeof e !== "string") return false;
  const r = t || "?";
  const s = n && (n.untilConsumed || n.holdTicks > 0);
  const a = findObserverInRange(e, null);
  if (!a) return !!Game.rooms[e];
  const i = _schedMem();
  if (s) {
    const t = Math.max(1, n.holdTicks || OBS_REQ_TIMEOUT);
    if (!i.held[e]) i.held[e] = {};
    const s = i.held[e][r];
    i.held[e][r] = {
      p: Math.max(o || 50, s ? s.p || 0 : 0),
      t: Game.time,
      e: Game.time + t,
      o: s ? s.o || null : null,
      d: s ? s.d || null : null
    };
    return true;
  }
  if (Game.rooms[e]) return true;
  const l = i.req[e];
  if (!l || (o || 50) > l.p) i.req[e] = {
    p: o || 50,
    src: r,
    t: Game.time
  }; else if (l.src === r) l.t = Game.time; else if ((o || 50) === l.p) l.t = Game.time;
  return true;
}

function obsCancel(e, t) {
  const o = _schedMem();
  if (!t || o.req[e] && o.req[e].src === t) delete o.req[e];
  if (!o.held[e]) return;
  if (t) delete o.held[e][t]; else delete o.held[e];
  if (o.held[e] && Object.keys(o.held[e]).length === 0) delete o.held[e];
}

function obsConsume(e, t) {
  obsCancel(e, t);
}

function obsInRange(e) {
  return !!findObserverInRange(e, null);
}

function _schedTick(e) {
  _regSweepRead();
  _monReadAwaiting();
  const t = _schedMem();
  for (const e in t.req) {
    if (Game.rooms[e]) {
      delete t.req[e];
      continue;
    }
    if (Game.time - t.req[e].t > OBS_REQ_TIMEOUT) delete t.req[e];
  }
  for (const e in t.held) {
    const o = t.held[e];
    for (const e in o) {
      if (!o[e] || Game.time > o[e].e) delete o[e];
    }
    if (Object.keys(o).length === 0) delete t.held[e];
  }
  if (e) _monSubmitPolls();
  const o = [];
  if (Memory.roomIntelPending) for (const e in Memory.roomIntelPending) {
    const t = Memory.roomIntelPending[e];
    if (!Game.rooms[e] && (!t.tick || Game.time - t.tick > 0)) o.push({
      p: OBS_PRI.ONESHOT,
      rn: e
    });
  }
  if (Memory.nukeAnalyzePending) for (const e in Memory.nukeAnalyzePending) if (!Game.rooms[e]) o.push({
    p: OBS_PRI.ONESHOT - 1,
    rn: e
  });
  if (Memory.maintScan && Memory.maintScan.pending) for (const e in Memory.maintScan.pending) if (!Game.rooms[e]) o.push({
    p: OBS_PRI.ONESHOT - 2,
    rn: e
  });
  for (const e in t.req) o.push({
    p: t.req[e].p,
    rn: e
  });
  for (const e in t.held) {
    let n = 0;
    let r = false;
    for (const o in t.held[e]) {
      const s = t.held[e][o];
      n = Math.max(n, s.p || 50);
      if (s.o) r = true;
    }
    o.push({
      p: n,
      rn: e,
      held: true,
      active: r
    });
  }
  const n = {};
  for (const e of o) if (!n[e.rn] || e.p > n[e.rn].p || e.p === n[e.rn].p && e.active && !n[e.rn].active) n[e.rn] = e;
  const r = Object.values(n).sort((e, t) => {
    if (e.p !== t.p) return t.p - e.p;
    if (!!e.active !== !!t.active) return e.active ? -1 : 1;
    return 0;
  });
  const s = _tickUsedSet();
  for (const e of r) {
    let o = null;
    if (e.held && t.held[e.rn]) {
      for (const n in t.held[e.rn]) {
        const r = t.held[e.rn][n].o;
        const a = r && Game.getObjectById(r);
        if (a && !s.has(a.id)) {
          o = a;
          break;
        }
      }
    }
    if (!o) o = findObserverInRange(e.rn, s);
    if (!_tickObserve(o, e.rn) || !e.held || !t.held[e.rn]) continue;
    for (const n in t.held[e.rn]) {
      t.held[e.rn][n].o = o.id;
      t.held[e.rn][n].d = Game.time;
    }
  }
}

//   Memory.roomRegistry.rooms = { 'E5N12': { o:'Player', l:7, t:tick } }
function _regMem() {
  if (!Memory.roomRegistry) Memory.roomRegistry = {
    rooms: {},
    lastSweepStart: 0,
    lastSweepEnd: 0,
    bootstrapped: false,
    sweep: null,
    interval: REG_SWEEP_INTERVAL
  };
  if (!Memory.roomRegistry.rooms) Memory.roomRegistry.rooms = {};
  return Memory.roomRegistry;
}

function _regFresh() {
  const e = _regMem();
  return e.lastSweepEnd > 0 && Game.time - e.lastSweepEnd < REG_FRESH_TICKS;
}

function _regRoomsOf(e) {
  const t = _regMem(), o = [];
  for (const n in t.rooms) if (t.rooms[n].o === e) o.push(n);
  return o.sort();
}

function _regRecord(e, t) {
  const o = _regMem();
  if (t.controller && t.controller.my) {
    delete o.rooms[e];
    if (Memory.playerMonitor) {
      if (Memory.playerMonitor.state) delete Memory.playerMonitor.state[e];
      if (Memory.playerMonitor.awaiting) delete Memory.playerMonitor.awaiting[e];
    }
    return;
  }
  const n = t.controller && t.controller.owner ? t.controller.owner.username : null;
  const r = o.rooms[e];
  const s = !o.bootstrapped;
  if (n) {
    const a = t.controller.level;
    if (!r) {
      if (!s) _monFire(n, e, "NEW_ROOM", n + " has claimed a new room: " + e);
    } else if (r.o !== n) {
      if (!s) {
        _monFire(r.o, e, "ROOM_LOST", "Room is no longer owned by " + r.o + " (now owned by " + n + ")");
        _monFire(n, e, "NEW_ROOM", n + " has claimed a new room: " + e);
      }
      if (Memory.playerMonitor && Memory.playerMonitor.state) delete Memory.playerMonitor.state[e];
    } else if (!s && r.t > 0 && r.l !== a) {
      const t = a > r.l ? "UPGRADED" : "DOWNGRADED";
      _monFire(n, e, "RCL_" + t, "RCL changed from " + r.l + " to " + a);
    }
    o.rooms[e] = {
      o: n,
      l: a,
      t: Game.time
    };
    _monAnalyzeIfTracked(t, n);
  } else {
    if (r) {
      if (!s) _monFire(r.o, e, "ROOM_LOST", "Room is no longer owned by " + r.o + " (unclaimed)");
      delete o.rooms[e];
      if (Memory.playerMonitor && Memory.playerMonitor.state) delete Memory.playerMonitor.state[e];
    }
  }
}

function _regStartSweep() {
  const e = _regMem();
  if (e.sweep && e.sweep.active) return false;
  const t = getObserverMap(), o = Object.keys(t);
  if (!o.length) {
    console.log("[Registry] No observers — cannot sweep.");
    return false;
  }
  const n = new Set;
  for (const e of o) {
    const t = parseRoomCoords(e);
    if (!t) continue;
    for (let e = -OBSERVER_RANGE; e <= OBSERVER_RANGE; e++) for (let o = -OBSERVER_RANGE; o <= OBSERVER_RANGE; o++) {
      const r = toRoomName(t.x + e, t.y + o);
      if (!isClaimableRoom(r)) continue;
      const s = Game.rooms[r];
      if (s && s.controller && s.controller.my) continue;
      n.add(r);
    }
  }
  const r = {}, s = {};
  for (const e of o) {
    r[e] = [];
    s[e] = 0;
  }
  for (const e of n) {
    const t = parseRoomCoords(e);
    if (!t) continue;
    let n = null, a = Infinity;
    for (const e of o) {
      const o = parseRoomCoords(e);
      if (!o) continue;
      const r = Math.max(Math.abs(t.x - o.x), Math.abs(t.y - o.y));
      if (r <= OBSERVER_RANGE && s[e] < a) {
        n = e;
        a = s[e];
      }
    }
    if (n) {
      r[n].push(e);
      s[n]++;
    }
  }
  e.sweep = {
    active: true,
    started: Game.time,
    queues: r,
    pending: {},
    scanned: 0,
    observed: 0,
    total: n.size
  };
  e.lastSweepStart = Game.time;
  console.log("[Registry] Sweep started: " + n.size + " claimable room(s) across " + o.length + " observer(s) (~" + Math.ceil(n.size / o.length) + " ticks).");
  return true;
}

function _regSweepRead() {
  const e = _regMem();
  const t = e.sweep;
  if (!t || !t.active) return;
  for (const e in t.pending) {
    const o = t.pending[e];
    const n = Game.rooms[o];
    if (n) {
      _regRecord(o, n);
      t.scanned++;
      t.observed++;
    } else if (t.queues[e]) {
      t.queues[e].unshift(o);
    }
    delete t.pending[e];
  }
}

function _regSweepFill() {
  const e = _regMem();
  const t = e.interval || REG_SWEEP_INTERVAL;
  const o = e.lastSweepEnd === 0 && e.lastSweepStart === 0;
  if ((!e.sweep || !e.sweep.active) && (o || Game.time - Math.max(e.lastSweepEnd, e.lastSweepStart) >= t)) _regStartSweep();
  const n = e.sweep;
  if (!n || !n.active) return;
  if (Game.time - n.started > REG_SWEEP_TIMEOUT) {
    console.log("[Registry] Sweep timed out — finalizing with " + n.scanned + "/" + n.total + " processed.");
    e.lastSweepEnd = Game.time;
    e.bootstrapped = true;
    e.sweep = null;
    _wsOnSweepComplete();
    return;
  }
  const r = _tickUsedSet();
  let s = 0;
  for (const e in n.queues) {
    const t = n.queues[e];
    if (!t.length) continue;
    while (t.length && Game.rooms[t[0]]) {
      const e = t.shift();
      _regRecord(e, Game.rooms[e]);
      n.scanned++;
      n.observed++;
    }
    if (!t.length) continue;
    const o = Game.rooms[e];
    let a = null;
    if (o && o.controller && o.controller.my) a = o.find(FIND_MY_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_OBSERVER
    })[0];
    if (a && !r.has(a.id) && !n.pending[e]) {
      const o = t.shift();
      if (a.observeRoom(o) === OK) {
        r.add(a.id);
        n.pending[e] = o;
      } else t.unshift(o);
    }
    s += t.length;
  }
  if (s === 0 && Object.keys(n.pending).length === 0) {
    e.lastSweepEnd = Game.time;
    e.bootstrapped = true;
    e.sweep = null;
    _regPruneUnreachable(e);
    console.log("[Registry] Sweep complete: " + n.scanned + "/" + n.total + " rooms processed (" + n.observed + " observed) in " + (Game.time - n.started) + " ticks. Registry holds " + Object.keys(e.rooms).length + " owned room(s).");
    _monPruneState(e);
    _wsOnSweepComplete();
  }
}

function _regPruneUnreachable(e) {
  for (const t in e.rooms) if (!findObserverInRange(t)) delete e.rooms[t];
}

function registrySweep() {
  const e = _regMem();
  if (e.sweep && e.sweep.active) {
    console.log("[Registry] Sweep already active: " + e.sweep.scanned + "/" + e.sweep.total);
    return;
  }
  _regStartSweep();
}

function registryStatus() {
  const e = _regMem();
  if (e.sweep && e.sweep.active) {
    const t = e.sweep, o = (t.scanned / Math.max(t.total, 1) * 100).toFixed(1);
    console.log("[Registry] Sweep ACTIVE: " + t.scanned + "/" + t.total + " (" + o + "%) | observed " + t.observed + " | elapsed " + (Game.time - t.started) + "t");
  } else {
    console.log("[Registry] No sweep active. Last sweep: " + (e.lastSweepEnd ? Game.time - e.lastSweepEnd + "t ago" : "never") + " | auto-interval: " + (e.interval || REG_SWEEP_INTERVAL) + "t (Memory.roomRegistry.interval to change)");
  }
  console.log("[Registry] Tracking " + Object.keys(e.rooms).length + ' owned room(s). registryList() / registryPlayer("name") for details.');
}

function registryPlayer(e) {
  if (!e || typeof e !== "string") {
    console.log('[Registry] Usage: registryPlayer("PlayerName")');
    return;
  }
  const t = _regMem(), o = _regRoomsOf(e);
  if (!o.length) {
    console.log("[Registry] No rooms recorded for " + e + ". (Registry age: " + (t.lastSweepEnd ? Game.time - t.lastSweepEnd + "t" : "never swept") + ")");
    return;
  }
  console.log("[Registry] " + e + " — " + o.length + " room(s):");
  for (const e of o) {
    const o = t.rooms[e];
    console.log("  " + e + "  RCL" + o.l + "  (seen " + (Game.time - o.t) + "t ago)");
  }
}

function registryList() {
  const e = _regMem(), t = {};
  for (const o in e.rooms) {
    const n = e.rooms[o];
    if (!t[n.o]) t[n.o] = [];
    t[n.o].push(o + "(RCL" + n.l + ")");
  }
  const o = Object.keys(t).sort();
  if (!o.length) {
    console.log("[Registry] Empty — run registrySweep().");
    return;
  }
  console.log("[Registry] " + o.length + " player(s), " + Object.keys(e.rooms).length + " room(s)  [age: " + (e.lastSweepEnd ? Game.time - e.lastSweepEnd + "t" : "sweeping") + "]:");
  for (const e of o) console.log("  " + e + " (" + t[e].length + "): " + t[e].sort().join(", "));
}

const MON_BOOLEAN_FIELDS = [ "safeMode", "hasNuker", "nukerHasG", "nukerHasE", "nukerReady", "hasCreeps", "hasMilitary", "hasBoosted", "spawnsDrained", "hasSpawnsEver", "hasPower", "terminalHasG", "towersLow" ];
function _monCompactState(e, t, o) {
  if (!e || typeof e !== "object") return e;
  delete e.owned;
  delete e.t;
  if (!t) delete e.rcl;
  e.b = 1;
  if (t) e.m = 1;
  if (!t) {
    const t = {
      b: 1,
      safeMode: 1,
      nukerReady: 1,
      incomingNukes: 1
    };
    if (o) {
      t.hasCreeps = 1;
      t.spawnExtEnergy = 1;
      t.storageEnergy = 1;
    }
    for (const o in e) if (!t[o]) delete e[o];
  }
  for (const t of MON_BOOLEAN_FIELDS) if (!e[t]) delete e[t];
  if (e.incomingNukes && Object.keys(e.incomingNukes).length === 0) delete e.incomingNukes;
  return e;
}

function _monMem() {
  if (!Memory.playerMonitor) Memory.playerMonitor = {
    players: {},
    state: {},
    awaiting: {},
    paused: false
  };
  const e = Memory.playerMonitor;
  if (!e.players) e.players = {};
  if (!e.state) e.state = {};
  if (!e.awaiting) e.awaiting = {};
  if (e.cycle !== undefined || e.rescanQueue !== undefined || e.pendingWideScan !== undefined || e.lastRescan !== undefined) {
    const t = _regMem();
    for (const o in e.players) {
      const n = e.players[o];
      if (n && Array.isArray(n.rooms)) {
        for (const r of n.rooms) {
          if (!t.rooms[r]) t.rooms[r] = {
            o: o,
            l: n.state && n.state[r] && n.state[r].rcl || 0,
            t: n.state && n.state[r] && n.state[r].t || 0
          };
          if (n.state && n.state[r]) e.state[r] = n.state[r];
        }
      }
      e.players[o] = {
        status: n && n.status || STATUS.ENEMY
      };
    }
    delete e.cycle;
    delete e.rescanQueue;
    delete e.lastRescan;
    delete e.pendingWideScan;
    console.log("[Monitor] Migrated old playerMonitor memory to the registry-backed format.");
  }
  if (e.schemaVersion === undefined || e.schemaVersion < MON_SCHEMA_VERSION) {
    const t = _regMem();
    for (const o in e.state) {
      const n = t.rooms[o];
      const r = !!(n && e.players[n.o]);
      _monCompactState(e.state[o], r, _isRemoteSupplyRoom(o));
    }
    for (const t in e.players) {
      const o = e.players[t];
      e.players[t] = {
        status: o && o.status || STATUS.ENEMY
      };
    }
    e.schemaVersion = MON_SCHEMA_VERSION;
    console.log("[Monitor] Compacted player monitor memory to schema v" + MON_SCHEMA_VERSION + ".");
  }
  return e;
}

function _monPruneState(e) {
  const t = Memory.playerMonitor;
  if (!t || !t.state) return;
  for (const o in t.state) if (!e.rooms[o]) delete t.state[o];
  if (t.awaiting) for (const o in t.awaiting) if (!e.rooms[o]) delete t.awaiting[o];
}

function _isRemoteSupplyRoom(e) {
  var t = Memory.remoteSupplyOrders;
  if (!t) return false;
  for (var o in t) {
    var n = t[o];
    if (n && n.active && n.recipientRoom === e) return true;
  }
  return false;
}

function _monFire(e, t, o, n) {
  const r = _monMem();
  const s = r.players[e];
  if (r.paused) return;
  if (!s && !UNMONITORED_ALERTS.includes(o)) return;
  const a = s ? ALERT_FILTER[s.status || STATUS.ENEMY] : UNMONITORED_ALERTS;
  if (a && !a.includes(o)) return;
  console.log("[Monitor][" + e + "][" + t + "] " + o + ": " + n);
  Game.notify("[Monitor] " + e + " | " + t + " | " + o + ": " + n, NOTIFY_COOLDOWN);
}

function analyzeRoom(e, t, o, n, r, s) {
  const a = e.name;
  const i = {};
  const l = !o.b || r && !o.m;
  const c = e.controller && e.controller.owner ? e.controller.owner.username : null;
  if (c !== t) {
    return _monCompactState(i, r, s);
  }
  if (r) {
    const n = e.controller ? e.controller.level : 0;
    i.rcl = n;
    if (!l && o.rcl !== undefined && o.rcl !== n) {
      const e = n > o.rcl ? "UPGRADED" : "DOWNGRADED";
      _monFire(t, a, "RCL_" + e, "RCL changed from " + o.rcl + " to " + n);
    }
  }
  i.safeMode = e.controller ? !!e.controller.safeMode : false;
  if (!l && !o.safeMode && i.safeMode) {
    _monFire(t, a, "SAFE_MODE", "Safe mode activated! " + e.controller.safeMode + " ticks remaining");
  }
  const u = e.find(FIND_HOSTILE_STRUCTURES);
  const m = Object.create(null);
  for (let e = 0; e < u.length; e++) {
    const t = u[e];
    const o = t.structureType;
    (m[o] || (m[o] = [])).push(t);
  }
  const f = m[STRUCTURE_NUKER] || [];
  i.hasNuker = f.length > 0;
  if (i.hasNuker) {
    const e = f[0];
    const n = e.store.getUsedCapacity(RESOURCE_GHODIUM) || 0;
    const r = e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    i.nukerHasG = n > 0;
    i.nukerHasE = r > 0;
    i.nukerReady = n >= 5e3 && r >= 3e5;
    if (!l) {
      if (!o.hasNuker) {
        _monFire(t, a, "NUKER_BUILT", "A nuker has been constructed!");
      }
      if (!o.nukerHasG && i.nukerHasG) {
        _monFire(t, a, "NUKER_FILLING_G", "Nuker ghodium filling started (now " + n + "/5000)");
      }
      if (!o.nukerHasE && i.nukerHasE) {
        _monFire(t, a, "NUKER_FILLING_E", "Nuker energy filling started (now " + r + "/300000)");
      }
      if (!o.nukerReady && i.nukerReady) {
        _monFire(t, a, "NUKER_READY", "Nuker is ready to launch (" + n + "/5000 G, " + r + "/300000 energy)");
      }
    }
  } else {
    i.nukerHasG = false;
    i.nukerHasE = false;
    i.nukerReady = false;
  }
  const p = e.find(FIND_NUKES);
  i.incomingNukes = {};
  for (const e of p) {
    i.incomingNukes[e.id] = {
      x: e.pos.x,
      y: e.pos.y,
      launchRoom: e.launchRoomName,
      landTick: Game.time + e.timeToLand
    };
    if (!o.incomingNukes || !o.incomingNukes[e.id]) {
      _monFire(t, a, "NUKE_INCOMING", "Incoming nuke will land at (" + e.pos.x + "," + e.pos.y + ") in " + e.timeToLand + " ticks. Launched from: " + e.launchRoomName);
    }
  }
  if (!r && !s) return _monCompactState(i, false, false);
  const E = e.find(FIND_HOSTILE_CREEPS, {
    filter: e => e.owner.username === t
  });
  i.hasCreeps = E.length > 0;
  i.hasSpawnsEver = !!(o.hasSpawnsEver || (m[STRUCTURE_SPAWN] || []).length > 0);
  const d = [ ATTACK, RANGED_ATTACK, HEAL ];
  const R = r ? E.filter(e => e.body.some(e => d.includes(e.type))) : [];
  if (r) i.hasMilitary = R.length > 0;
  if (r && !l && !o.hasMilitary && i.hasMilitary) {
    const e = R.map(e => {
      const t = {};
      for (const o of e.body) {
        if (d.includes(o.type)) {
          t[o.type] = (t[o.type] || 0) + 1;
        }
      }
      return Object.keys(t).map(e => t[e] + e.charAt(0).toUpperCase()).join("/");
    });
    _monFire(t, a, "MILITARY_CREEPS", R.length + " military creep(s) detected: " + e.join(", "));
  }
  const _ = r ? E.filter(e => e.body.some(e => e.boost)) : [];
  if (r) i.hasBoosted = _.length > 0;
  if (r && !l && !o.hasBoosted && i.hasBoosted) {
    const e = new Set;
    for (const t of _) {
      for (const o of t.body) {
        if (o.boost) e.add(o.boost);
      }
    }
    _monFire(t, a, "BOOSTED_CREEPS", _.length + " boosted creep(s). Boosts: " + Array.from(e).join(", "));
  }
  if (r && !l && o.hasCreeps && !i.hasCreeps) {
    if (o.hasSpawnsEver || i.hasSpawnsEver) {
      const e = m[STRUCTURE_SPAWN] || [];
      const o = e.some(e => e.spawning);
      if (!o) {
        _monFire(t, a, "NO_CREEPS", "No creeps detected and no spawns active — room may be abandoned or under attack");
      }
    }
  }
  const g = (m[STRUCTURE_SPAWN] || []).concat(m[STRUCTURE_EXTENSION] || []);
  if (g.length > 0) {
    const e = g.reduce((e, t) => e + (t.store ? t.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0), 0);
    if (r) i.spawnsDrained = e === 0;
    if (s) {
      i.spawnExtEnergy = e;
    }
  } else {
    if (r) i.spawnsDrained = true;
    if (s) {
      i.spawnExtEnergy = 0;
    }
  }
  if (r && !l && i.spawnsDrained && !o.spawnsDrained) {
    _monFire(t, a, "SPAWNS_DRAINED", "All spawns and extensions have 0 energy");
  }
  if (s) {
    const e = m[STRUCTURE_STORAGE] || [];
    i.storageEnergy = e.length > 0 && e[0].store ? e[0].store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
  }
  if (!r) return _monCompactState(i, false, true);
  if (n === STATUS.ENEMY || n === STATUS.WAR) {
    const e = m[STRUCTURE_POWER_SPAWN] || [];
    if (e.length > 0) {
      const t = e[0];
      i.hasPower = (t.store ? t.store.getUsedCapacity(RESOURCE_POWER) || 0 : 0) > 0;
    } else {
      i.hasPower = false;
    }
    if (!l && i.hasPower && !o.hasPower) {
      _monFire(t, a, "POWER_DETECTED", "Power loaded into power spawn");
    }
  }
  if (n === STATUS.WAR) {
    const e = m[STRUCTURE_TERMINAL] || [];
    if (e.length > 0) {
      const t = e[0].store.getUsedCapacity(RESOURCE_GHODIUM) || 0;
      i.terminalHasG = t > 0;
    } else {
      i.terminalHasG = false;
    }
    if (!l && !o.terminalHasG && i.terminalHasG) {
      _monFire(t, a, "TERMINAL_G", "Ghodium detected in terminal — possible nuke preparation");
    }
  }
  const y = m[STRUCTURE_TOWER] || [];
  if (y.length > 0) {
    i.towersLow = y.every(e => (e.store ? e.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0) < 10);
  } else {
    i.towersLow = false;
  }
  if (!l && i.towersLow && !o.towersLow) {
    _monFire(t, a, "TOWERS_EMPTY", "All " + y.length + " tower(s) have less than 10 energy");
  }
  return _monCompactState(i, r, s);
}

function _monAnalyzeIfTracked(e, t) {
  const o = _monMem();
  const n = o.players[t];
  const r = _isRemoteSupplyRoom(e.name);
  const s = o.state[e.name] || {};
  o.state[e.name] = analyzeRoom(e, t, s, n ? n.status || STATUS.ENEMY : STATUS.ENEMY, !!n, r);
  delete o.awaiting[e.name];
}

function _monSubmitPolls() {
  const e = _monMem();
  for (const t in e.awaiting) if (Game.time - e.awaiting[t] >= MON_AWAIT_TIMEOUT) delete e.awaiting[t];
  if (e.paused) return;
  const t = _regMem();
  for (const o in e.players) {
    const n = e.players[o];
    const r = n.status || STATUS.ENEMY;
    const s = POLL_INTERVAL[r] || 1e3;
    const a = r === STATUS.WAR ? OBS_PRI.WAR : OBS_PRI.MONITOR;
    for (const n in t.rooms) {
      if (t.rooms[n].o !== o) continue;
      const r = t.rooms[n].t || 0;
      if (Game.time - r < s) continue;
      if (e.awaiting[n] && Game.time - e.awaiting[n] < 50) continue;
      if (obsRequest(n, "monitor", a)) e.awaiting[n] = Game.time;
    }
  }
}

function _monReadAwaiting() {
  const e = _monMem();
  for (const t in e.awaiting) {
    const o = Game.rooms[t];
    if (o) {
      _regRecord(t, o);
      delete e.awaiting[t];
    }
  }
}

function _monSeedRooms(e, t) {
  const o = _regMem();
  let n = 0;
  for (const r of t) {
    if (typeof r !== "string" || !parseRoomCoords(r)) continue;
    if (!o.rooms[r]) {
      o.rooms[r] = {
        o: e,
        l: 0,
        t: 0
      };
      n++;
    }
  }
  if (n) console.log("[Monitor] Seeded " + n + " room(s) for " + e + " into the registry.");
  return n;
}

function monitor(e, t, o) {
  if (!e || typeof e !== "string") {
    console.log('[Monitor] Usage: monitor("PlayerName", "STATUS") or monitor("PlayerName", "STATUS", ["room1","room2"])');
    console.log("[Monitor] Valid statuses: ALLY, NEUTRAL, ENEMY, WAR");
    return;
  }
  const n = _monMem();
  let r = STATUS.ENEMY;
  let s = null;
  if (typeof t === "string" && STATUS[t.toUpperCase()]) {
    r = t.toUpperCase();
    if (o && Array.isArray(o) && o.length > 0) s = o;
  } else if (Array.isArray(t) && t.length > 0) {
    s = t;
  } else if (typeof t === "string") {
    console.log('[Monitor] Unknown status: "' + t + '". Valid: ALLY, NEUTRAL, ENEMY, WAR');
    return;
  }
  const a = n.players[e] ? n.players[e].status : null;
  n.players[e] = {
    status: r
  };
  if (s) _monSeedRooms(e, s);
  const i = _regRoomsOf(e);
  console.log("[Monitor] " + e + ": " + (a && a !== r ? a + " → " : "") + r + " (poll: " + POLL_INTERVAL[r] + "t). Registry knows " + i.length + " room(s)" + (i.length ? ": " + i.join(", ") : "") + ".");
  const l = _regMem();
  if (!i.length && !_regFresh() && !(l.sweep && l.sweep.active)) {
    _regStartSweep();
    console.log("[Monitor] Registry stale/empty — sweep started; rooms will appear as it completes.");
  }
}

function monitorAdd(e, t, o) {
  if (!e) {
    console.log('[Monitor] Usage: monitorAdd("PlayerName", "STATUS", ["room1","room2"])  // canonical');
    console.log('[Monitor]    or: monitorAdd("PlayerName", ["room1","room2"], "STATUS")  // legacy');
    return;
  }
  let n = null, r = null;
  if (typeof t === "string") {
    n = t;
    if (Array.isArray(o)) r = o;
  } else if (Array.isArray(t)) {
    r = t;
    if (typeof o === "string") n = o;
  }
  if (!r || r.length === 0) {
    console.log('[Monitor] Usage: monitorAdd("PlayerName", "STATUS", ["room1","room2"])');
    return;
  }
  const s = _monMem();
  const a = n && STATUS[n.toUpperCase()] ? n.toUpperCase() : null;
  if (!s.players[e]) {
    s.players[e] = {
      status: a || STATUS.ENEMY
    };
  } else if (a) {
    s.players[e].status = a;
  }
  _monSeedRooms(e, r);
  const i = s.players[e].status;
  console.log("[Monitor] " + e + " [" + i + "]: " + _regRoomsOf(e).length + " room(s) tracked (poll: " + POLL_INTERVAL[i] + " ticks).");
}

function monitorRemove(e) {
  const t = _monMem();
  if (!t.players[e]) {
    console.log("[Monitor] " + e + " has no monitor status.");
    return;
  }
  for (const o of _regRoomsOf(e)) {
    if (t.state[o]) _monCompactState(t.state[o], false, _isRemoteSupplyRoom(o));
    delete t.awaiting[o];
  }
  delete t.players[e];
  console.log("[Monitor] Removed monitor status for " + e + ". (The registry keeps critical ownership/safe-mode/nuker/nuke alerts.)");
}

function monitorSetStatus(e, t) {
  if (!e || !t) {
    console.log('[Monitor] Usage: monitorSetStatus("PlayerName", "STATUS")');
    console.log("[Monitor] Valid statuses: ALLY, NEUTRAL, ENEMY, WAR");
    return;
  }
  const o = t.toUpperCase();
  if (!STATUS[o]) {
    console.log('[Monitor] Unknown status: "' + t + '". Valid: ALLY, NEUTRAL, ENEMY, WAR');
    return;
  }
  const n = _monMem();
  if (!n.players[e]) {
    console.log("[Monitor] " + e + ' is not being monitored. Use monitor("' + e + '", "' + o + '").');
    return;
  }
  const r = n.players[e].status || STATUS.ENEMY;
  n.players[e].status = o;
  const s = ALERT_FILTER[o] ? ALERT_FILTER[o].length + " alert types" : "all alert types";
  console.log("[Monitor] " + e + ": " + r + " → " + o + " (poll: " + POLL_INTERVAL[o] + " ticks, tracking " + s + ")");
}

function monitorStatus() {
  const e = _monMem();
  const t = _regMem();
  const o = Object.keys(e.players);
  console.log("════════════════════ PLAYER MONITOR STATUS ════════════════════");
  console.log("  Paused: " + (e.paused ? "YES" : "no"));
  if (t.sweep && t.sweep.active) console.log("  Registry sweep: ACTIVE (" + t.sweep.scanned + "/" + t.sweep.total + ")"); else console.log("  Registry: " + Object.keys(t.rooms).length + " owned room(s) | last sweep " + (t.lastSweepEnd ? Game.time - t.lastSweepEnd + "t ago" : "never") + " | next auto-sweep in " + Math.max(0, (t.interval || REG_SWEEP_INTERVAL) - (Game.time - Math.max(t.lastSweepEnd, t.lastSweepStart))) + "t");
  const n = Object.keys(e.awaiting).length;
  if (n) console.log("  Awaiting observation: " + n + " room(s)");
  if (o.length === 0) {
    console.log("  No players have a monitor status. (The registry still tracks all rooms — registryList().)");
    console.log("════════════════════════════════════════════════════════════════");
    return;
  }
  console.log("");
  for (const n of o) {
    const o = e.players[n];
    const r = o.status || STATUS.ENEMY;
    const s = POLL_INTERVAL[r] || 1e3;
    const a = _regRoomsOf(n);
    console.log("  " + n + " [" + r + "] (poll: " + s + " ticks):");
    console.log("    Rooms (" + a.length + "): " + (a.join(", ") || "none in registry yet"));
    const i = [];
    for (const e of a) {
      const o = t.rooms[e];
      const n = o && o.t ? Game.time - o.t : null;
      if (n === null) i.push(e + " (never)"); else if (n > s * 3) i.push(e + " (" + n + "t ago)");
    }
    if (i.length) console.log("    Stale scans: " + i.join(", "));
  }
  console.log("════════════════════════════════════════════════════════════════");
}

function monitorPause() {
  _monMem().paused = true;
  console.log("[Monitor] Alerts and hot-polling paused. (Registry sweeps continue — they serve more than the monitor.)");
}

function monitorResume() {
  _monMem().paused = false;
  console.log("[Monitor] Resumed.");
}

const PST_TIMEOUT = 50;
const PST_ANCHOR_TTL = 1e5;
const PST_NAME_CATS = [ [ "upgrad", "upgrader" ], [ "build", "builder" ], [ "repair", "repairer" ], [ "maintain", "maintainer" ], [ "harvest", "worker" ], [ "miner", "worker" ], [ "mining", "worker" ], [ "drill", "worker" ], [ "haul", "hauler" ], [ "carr", "hauler" ], [ "courier", "hauler" ], [ "transport", "hauler" ], [ "suppl", "hauler" ], [ "fill", "hauler" ], [ "distribut", "hauler" ], [ "queen", "hauler" ], [ "extract", "extractor" ], [ "scout", "scout" ], [ "claim", "claimer" ], [ "reserv", "claimer" ], [ "dismantl", "demolisher" ], [ "demol", "demolisher" ] ];
const PST_NAME_BODY = {
  upgrader: "worker",
  builder: "worker",
  repairer: "worker",
  maintainer: "worker",
  worker: "worker",
  demolisher: "worker",
  extractor: "worker",
  hauler: "hauler",
  scout: "scout",
  claimer: "claimer"
};
function _pstCategorize(e) {
  const t = e.body, o = t.length;
  let n = 0, r = 0, s = 0, a = 0, i = 0, l = 0, c = false;
  for (const e of t) {
    if (e.boost) c = true;
    if (e.type === ATTACK) n++; else if (e.type === RANGED_ATTACK) r++; else if (e.type === HEAL) s++; else if (e.type === WORK) a++; else if (e.type === CLAIM) i++; else if (e.type === MOVE) l++;
  }
  if (n && n >= r && n >= s) return {
    cat: "melee",
    boosted: c
  };
  if (r && r >= s) return {
    cat: "ranged",
    boosted: c
  };
  if (s) return {
    cat: "healer",
    boosted: c
  };
  let u;
  if (i) u = "claimer"; else if (a / o > .25) u = "worker"; else if (l === o) u = "scout"; else if (a / o < .1) u = "hauler"; else u = "other";
  const m = e.name.toLowerCase();
  for (const [e, t] of PST_NAME_CATS) {
    if (m.indexOf(e) === -1) continue;
    if (PST_NAME_BODY[t] === u) return {
      cat: t,
      boosted: c
    };
    break;
  }
  return {
    cat: u,
    boosted: c
  };
}

function _pstCollectRoom(e, t) {
  const o = e.controller;
  const n = o && o.owner ? o.owner.username : null;
  if (n !== t) return {
    name: e.name,
    ok: true,
    lost: true,
    owner: n,
    t: Game.time
  };
  const r = e.find(FIND_HOSTILE_STRUCTURES);
  const s = Object.create(null);
  for (const e of r) (s[e.structureType] || (s[e.structureType] = [])).push(e);
  const a = s[STRUCTURE_TOWER] || [];
  const i = s[STRUCTURE_SPAWN] || [];
  const l = s[STRUCTURE_NUKER] || [];
  let c = 0, u = 0;
  for (const e of i.concat(s[STRUCTURE_EXTENSION] || [])) {
    if (!e.store) continue;
    c += e.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    u += e.store.getCapacity(RESOURCE_ENERGY) || 0;
  }
  const m = {};
  let f = 0, p = 0;
  for (const o of e.find(FIND_HOSTILE_CREEPS)) {
    if (!o.owner || o.owner.username !== t) continue;
    const e = _pstCategorize(o);
    m[e.cat] = (m[e.cat] || 0) + 1;
    p++;
    if (e.boosted) f++;
  }
  let E = 0;
  for (const o of e.find(FIND_HOSTILE_POWER_CREEPS)) if (o.owner && o.owner.username === t) E++;
  const d = {};
  const addStore = e => {
    if (!e) return;
    for (const t in e) {
      const o = e[t];
      if (o > 0) d[t] = (d[t] || 0) + o;
    }
  };
  if (e.storage) addStore(e.storage.store);
  if (e.terminal) addStore(e.terminal.store);
  return {
    name: e.name,
    ok: true,
    lost: false,
    owner: n,
    rcl: o.level,
    pct: o.level < 8 && o.progressTotal > 0 ? o.progress / o.progressTotal * 100 : null,
    safeMode: o.safeMode || 0,
    enAvail: c,
    enCap: u,
    storageE: e.storage ? e.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : null,
    terminalE: e.terminal ? e.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : null,
    towers: a.length,
    towersLow: a.length > 0 && a.every(e => (e.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < 10),
    spawns: i.length,
    spawning: i.filter(e => e.spawning).length,
    nuker: l.length > 0,
    nukerG: l.length ? l[0].store.getUsedCapacity(RESOURCE_GHODIUM) || 0 : 0,
    nukerE: l.length ? l[0].store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0,
    inventory: d,
    creeps: m,
    totalCreeps: p,
    boosted: f,
    power: E,
    t: Game.time
  };
}

function _pstProgress(e) {
  const t = Object.keys(e.results).length, o = t + Object.keys(e.pending).length;
  console.log("[Status] Scanning " + e.player + ": " + t + "/" + o + " room(s) (" + (Game.time - e.startTick) + "t elapsed).");
}

function startPlayerStatusScan(e) {
  if (!e || typeof e !== "string") {
    console.log('[Status] Usage: status("PlayerName")');
    return;
  }
  const t = Memory.playerStatusScan;
  if (t && t.active) {
    if (t.player === e) {
      _pstProgress(t);
      return;
    }
    console.log("[Status] A scan for " + t.player + " is already running (" + Object.keys(t.pending).length + " room(s) left).");
    return;
  }
  const o = _regRoomsOf(e);
  if (!o.length) {
    const t = _regMem();
    console.log('[Status] Registry has no rooms for "' + e + '".');
    if (t.sweep && t.sweep.active) console.log("[Status] Registry sweep in progress (" + t.sweep.scanned + "/" + t.sweep.total + ") — retry when it completes."); else if (!_regFresh()) {
      _regStartSweep();
      console.log('[Status] Registry stale — sweep started; re-run status("' + e + '") when it completes (registryStatus() for progress).');
    } else console.log("[Status] Registry is fresh — check the spelling (registryList() shows known players), or seed rooms with monitorAdd().");
    return;
  }
  if (Memory.playerStatusAnchors) for (const e in Memory.playerStatusAnchors) if (Game.time - Memory.playerStatusAnchors[e].t > PST_ANCHOR_TTL) delete Memory.playerStatusAnchors[e];
  const n = {
    active: true,
    player: e,
    startTick: Game.time,
    pending: {},
    results: {}
  };
  for (const t of o) {
    const o = Game.rooms[t];
    if (o) {
      n.results[t] = _pstCollectRoom(o, e);
      _regRecord(t, o);
    } else if (obsRequest(t, "status", OBS_PRI.ONESHOT)) n.pending[t] = Game.time; else n.results[t] = {
      name: t,
      ok: false,
      reason: "range"
    };
  }
  Memory.playerStatusScan = n;
  const r = Object.keys(n.pending).length;
  if (!r) {
    _pstComplete(n);
    return;
  }
  console.log("[Status] Scanning " + e + ": " + o.length + " room(s), " + r + " awaiting observers...");
}

function _pstTick() {
  const e = Memory.playerStatusScan;
  if (!e || !e.active) return;
  for (const t in e.pending) {
    const o = Game.rooms[t];
    if (o) {
      e.results[t] = _pstCollectRoom(o, e.player);
      _regRecord(t, o);
      obsCancel(t, "status");
      delete e.pending[t];
    } else if (Game.time - e.pending[t] > PST_TIMEOUT) {
      e.results[t] = {
        name: t,
        ok: false,
        reason: "timeout"
      };
      obsCancel(t, "status");
      delete e.pending[t];
    } else {
      obsRequest(t, "status", OBS_PRI.ONESHOT);
    }
  }
  if (!Object.keys(e.pending).length) _pstComplete(e);
}

function _pstComplete(e) {
  if (!Memory.playerStatusAnchors) Memory.playerStatusAnchors = {};
  const t = Memory.playerStatusAnchors[e.player];
  const o = {};
  const n = [];
  for (const r of Object.keys(e.results).sort()) {
    const s = e.results[r];
    if (s.ok && !s.lost) {
      s.etaTicks = null;
      const e = t && t.rooms && t.rooms[r];
      if (s.pct !== null && e && e.l === s.rcl && s.t - e.t >= 100 && s.pct > e.pct) s.etaTicks = Math.ceil((100 - s.pct) / ((s.pct - e.pct) / (s.t - e.t)));
      if (s.pct !== null) o[r] = {
        l: s.rcl,
        pct: s.pct,
        t: s.t
      };
    }
    n.push(s);
  }
  Memory.playerStatusAnchors[e.player] = {
    t: Game.time,
    rooms: o
  };
  const r = _monMem();
  const s = _regMem();
  const a = {
    player: e.player,
    status: r.players[e.player] ? r.players[e.player].status || STATUS.ENEMY : null,
    elapsed: Game.time - e.startTick,
    registryAge: s.lastSweepEnd ? Game.time - s.lastSweepEnd : null,
    rooms: n
  };
  delete Memory.playerStatusScan;
  require("statusReport").printPlayerStatus(a);
}

//   1. _schedTick      reads sweep/hot-poll results, dispatches queued
//                      observation requests by priority (shared booking)
//   2. module ticks    one-shots auto-complete; multi-tick scans advance
//                      one room each using leftover observers
//   3. _regSweepFill   registry sweep soaks up any observer still idle
function _hasEntries(e) {
  if (!e) return false;
  for (const t in e) return true;
  return false;
}

function _hasActiveThreatScan() {
  if (!Memory.nukeThreatScans) return false;
  for (const e in Memory.nukeThreatScans) {
    const t = Memory.nukeThreatScans[e];
    if (t && !t.scanComplete) return true;
  }
  return false;
}

function _hasUrgentWork() {
  const e = Memory.obsSched;
  const t = Memory.roomRegistry;
  const o = Memory.playerMonitor;
  const n = heap[INTEL_EFF_MEM_KEY];
  if (e && (_hasEntries(e.req) || _hasEntries(e.held))) return true;
  if (t && t.sweep && _hasEntries(t.sweep.pending)) return true;
  if (o && o.awaiting) {
    for (const e in o.awaiting) if (Game.rooms[e]) return true;
  }
  if (Memory.maintScan && _hasEntries(Memory.maintScan.pending)) return true;
  if (_hasEntries(Memory.roomIntelPending) || _hasEntries(Memory.nukeAnalyzePending)) return true;
  if (_hasActiveThreatScan()) return true;
  if (_hasEntries(n)) return true;
  if (Memory[ENERGY_EFF_MEM_KEY] && Memory[ENERGY_EFF_MEM_KEY].active) return true;
  if (Memory.playerAnalysis && Memory.playerAnalysis.active) return true;
  if (Memory.playerScan && Memory.playerScan.active) return true;
  if (Memory.warEstimate && Memory.warEstimate.active) return true;
  if (Memory.playerStatusScan && Memory.playerStatusScan.active) return true;
  return false;
}

function _backgroundInterval(e) {
  if (e >= .9) return SCAN_BACKGROUND_INTERVAL * 5;
  if (e >= .6) return SCAN_BACKGROUND_INTERVAL * 2;
  return SCAN_BACKGROUND_INTERVAL;
}

function getRunPlan(e) {
  const t = _hasUrgentWork();
  const o = _backgroundInterval(e || 0);
  const n = Memory.roomRegistry;
  const r = !!(n && n.sweep && n.sweep.active);
  const s = Math.max(SCAN_IDLE_INTERVAL, o);
  const a = storage.ensure("scanner.schedule", function() {
    return {
      lastBackgroundTick: null,
      lastIdleTick: null,
      lastCleanupTick: null
    };
  });
  const i = r && (typeof a.lastBackgroundTick !== "number" || a.lastBackgroundTick > Game.time || Game.time - a.lastBackgroundTick >= o);
  const l = typeof a.lastIdleTick !== "number" || a.lastIdleTick > Game.time || Game.time - a.lastIdleTick >= s;
  const c = typeof a.lastCleanupTick !== "number" || a.lastCleanupTick > Game.time || Game.time - a.lastCleanupTick >= 100;
  if (!t && !i && !l && !c) return null;
  return {
    background: i || l,
    cleanup: c,
    claimBackground: i,
    claimIdle: l,
    claimCleanup: c
  };
}

function _measurePhase(e, t, o) {
  const n = Game.cpu.getUsed();
  o();
  e[t] = Game.cpu.getUsed() - n;
}

function run(e) {
  e = e || {
    background: true,
    cleanup: false
  };
  const t = {};
  _measurePhase(t, "scanner.scheduler", function() {
    _schedTick(e.background);
  });
  _measurePhase(t, "scanner.profiles", function() {
    _itProcessProfiles();
    _enProcessProfiles();
  });
  _measurePhase(t, "scanner.oneShots", function() {
    _processMaintPending();
    _processPendingIntel();
    _processPendingNukeAnalyze();
  });
  _measurePhase(t, "scanner.activeScans", function() {
    _paRun();
    _weRun();
    _pstTick();
  });
  if (e.background) _measurePhase(t, "scanner.registry", _regSweepFill);
  if (e.cleanup) _measurePhase(t, "scanner.cleanup", function() {
    _itCleanExpired();
    _enCleanExpired();
  });
  if (e.claimBackground || e.claimIdle || e.claimCleanup) {
    const t = storage.ensure("scanner.schedule", function() {
      return {
        lastBackgroundTick: null,
        lastIdleTick: null,
        lastCleanupTick: null
      };
    });
    if (e.claimBackground) t.lastBackgroundTick = Game.time;
    if (e.claimIdle) t.lastIdleTick = Game.time;
    if (e.claimCleanup) t.lastCleanupTick = Game.time;
    memoryManager.requestSave();
  }
  return t;
}

const scanner = {
  run: run,
  getRunPlan: getRunPlan,
  observe: {
    request: obsRequest,
    cancel: obsCancel,
    consume: obsConsume,
    dispatch: _tickObserve,
    inRange: obsInRange,
    PRI: OBS_PRI
  },
  registry: {
    sweep: registrySweep,
    status: registryStatus,
    player: registryPlayer,
    list: registryList,
    roomsOf: _regRoomsOf,
    fresh: _regFresh,
    startSweep: _regStartSweep,
    record: _regRecord
  },
  monitor: {
    set: monitor,
    add: monitorAdd,
    remove: monitorRemove,
    setStatus: monitorSetStatus,
    status: monitorStatus,
    pause: monitorPause,
    resume: monitorResume,
    analyzeRoom: analyzeRoom
  },
  maint: {
    scan: maintScan,
    print: maintPrint,
    scanRoom: maintScanRoom,
    processPending: _processMaintPending
  },
  intel: {
    full: intel,
    fast: intelFast,
    list: listIntel,
    getCached: getCachedIntel,
    processProfiles: _itProcessProfiles,
    processPending: _processPendingIntel,
    cleanExpired: _itCleanExpired,
    runSilent: _itRunSilent,
    findObservers: findObserversInRange
  },
  energy: {
    start: energyStart,
    cancel: energyCancel,
    status: energyStatus,
    run: energyRun,
    processProfiles: _enProcessProfiles,
    getCached: _enGetCached,
    cleanExpired: _enCleanExpired
  },
  nuke: {
    analyze: nukeAnalyze,
    self: nukeAnalyzeSelf,
    cost: nukeAnalyzeCost,
    incoming: nukeIncoming,
    threat: nukeThreat,
    threatStatus: nukeThreatStatus,
    threatCancel: nukeThreatCancel,
    computeBestStrike: _nkComputeBestStrike,
    processPending: _processPendingNukeAnalyze
  },
  player: {
    start: startPlayerAnalysis,
    run: _paRun,
    cancel: cancelPlayerAnalysis,
    status: getPlayerAnalysisStatus,
    last: getLastPlayerAnalysis,
    scan: startPlayerScan,
    scanStatus: getPlayerScanStatus,
    scanCancel: cancelPlayerScan,
    statusScan: startPlayerStatusScan
  },
  wide: {
    start: startWideScan,
    startPlayers: startWideScanPlayers,
    run: _wsRun,
    cancel: cancelWideScan,
    status: getWideScanStatus,
    report: _wsReport
  },
  war: {
    start: startWarEstimate,
    run: _weRun,
    cancel: cancelWarEstimate,
    status: getWarEstimateStatus,
    last: getLastWarEstimate,
    compute: computeWarEstimate,
    gatherRoomData: gatherRoomWarData,
    gatherSnapshot: gatherSnapshot
  },
  utils: {
    parseRoomCoords: parseRoomCoords,
    toRoomName: toRoomName,
    roomsInRange: roomsInRange,
    getRoomDistance: getRoomDistance,
    canNuke: canNuke,
    isClaimableRoom: isClaimableRoom,
    getObserverMap: getObserverMap,
    findObserverInRange: findObserverInRange,
    findObserversInRange: findObserversInRange,
    findObserverForRoom: findObserverForRoom,
    findAllObserversForRoom: findAllObserversForRoom,
    tryObserveRoom: tryObserveRoom,
    tryPowerObserver: tryPowerObserver,
    getMarketBuyPrice: getMarketBuyPrice,
    getMarketHistoryPrice: getMarketHistoryPrice,
    fmtNum: fmtNum,
    fmtCr: fmtCr,
    fmtE: fmtE,
    r1: r1,
    r2: r2,
    r3: r3,
    yn: yn,
    clamp: clamp
  }
};
module.exports = scanner;
global.maintScan = () => maintPrint();
global.maintScanRoom = e => maintScanRoom(e);
global.intel = intel;
global.intelFast = intelFast;
global.listIntel = listIntel;
global.getCachedIntel = getCachedIntel;
global.nukeAnalyze = nukeAnalyze;
global.nukeAnalyzeSelf = nukeAnalyzeSelf;
global.nukeAnalyzeCost = nukeAnalyzeCost;
global.nukeIncoming = nukeIncoming;
global.nukeThreat = nukeThreat;
global.nukeThreatStatus = nukeThreatStatus;
global.nukeThreatCancel = nukeThreatCancel;
global.player = startPlayerAnalysis;
global.playerCancel = cancelPlayerAnalysis;
global.playerStatus = getPlayerAnalysisStatus;
global.playerLast = getLastPlayerAnalysis;
global.playerScan = startPlayerScan;
global.playerScanStatus = getPlayerScanStatus;
global.playerScanCancel = cancelPlayerScan;
global.wideScan = startWideScan;
global.wideScanPlayers = startWideScanPlayers;
global.wideScanCancel = cancelWideScan;
global.wideScanStatus = getWideScanStatus;
global.warEstimate = startWarEstimate;
global.warEstimateCancel = cancelWarEstimate;
global.warEstimateStatus = getWarEstimateStatus;
global.warEstimateLast = getLastWarEstimate;
global.registrySweep = registrySweep;
global.registryStatus = registryStatus;
global.registryPlayer = registryPlayer;
global.registryList = registryList;
global.monitor = monitor;
global.monitorAdd = monitorAdd;
global.monitorRemove = monitorRemove;
global.monitorSetStatus = monitorSetStatus;
global.monitorStatus = monitorStatus;
global.monitorPause = monitorPause;
global.monitorResume = monitorResume;
global.monitorUpdateRooms = monitorAdd;
global.profileEnergy = energyStart;
global.cancelEnergyProfile = energyCancel;
global.energyProfileStatus = energyStatus;
