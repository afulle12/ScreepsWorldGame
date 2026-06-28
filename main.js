// === PROFILER INTEGRATION ===
// test
const profiler = require('screeps-profiler');
const creepProfiler = require('creepProfiler');
const taskScheduler = require('taskScheduler');

profiler.enable();

// === CPU USAGE LOGGING TOGGLE VARIABLES ===
const ENABLE_CPU_LOGGING = false;
const DISABLE_CPU_CONSOLE = true;
const CPU_HUD_REFRESH_TICKS = 1;
const roadBuilder = require('roadBuilder');
const scanner = require('scanner');

// === CPU SCHEDULER CONFIGURATION (Shard3: 20 CPU limit) ===
// Serialization eats 0.3-0.7 CPU, so our effective ceiling is ~19.3-19.7.
// We define three budget tiers based on bucket health:
//   CRITICAL bucket (<2000): Aggressive shedding, keep economy alive
//   NORMAL   bucket (2000-8000): Standard operation
//   FLUSH    bucket (>8000): Spend freely, burn bucket on low-frequency work
const CPU_LIMITS = {
  HARD_CEILING: 19.3,   // Never exceed - leaves 0.7 for serialization worst-case
  NORMAL:       18.0,   // Comfortable cruising altitude
  CRITICAL:     14.0,   // Survival mode - economy + defense only
};

// Section importance tiers (higher = more important, always include in run)
const SECTION_TIER = {
  CRITICAL: 3,  // Must run every tick no matter what (towers, defense, creeps)
  HIGH:     2,  // Important infrastructure (links, terminals, labs)
  NORMAL:   1,  // Standard operations (market, finance, scans)
  LOW:      0,  // Deferrable (status reports, cleanup, profiling)
};

// Map each profiled section to a tier
const SECTION_TIERS = {
  'runCreeps':                SECTION_TIER.CRITICAL,
  'towerManager.run':         SECTION_TIER.CRITICAL,
  'defenseMonitor.run':       SECTION_TIER.CRITICAL,
  'getRoomState.init':        SECTION_TIER.CRITICAL,
  'manageTowerFiller':        SECTION_TIER.CRITICAL,
  'linkManager.run':          SECTION_TIER.HIGH,
  'terminalManager':          SECTION_TIER.HIGH,
  'labManager':               SECTION_TIER.HIGH,
  'boostManager.run':         SECTION_TIER.HIGH,
  'repairManager.run':        SECTION_TIER.HIGH,
  'spawnManager.run':         SECTION_TIER.HIGH,
  'factoryManager':           SECTION_TIER.HIGH,
  'mineralManager':           SECTION_TIER.HIGH,
  'powerManager':             SECTION_TIER.NORMAL,
  'roleTowerDrain':           SECTION_TIER.NORMAL,
  'roleContestedDemolisher':  SECTION_TIER.NORMAL,
  'depositObserver.run':      SECTION_TIER.NORMAL,
  'nukeLaunch.run':           SECTION_TIER.NORMAL,
  'scanRoomsStep':            SECTION_TIER.NORMAL,
  'claimbotRangeCheck.run':   SECTION_TIER.NORMAL,
  'remoteSupplyManager.run':  SECTION_TIER.NORMAL,
  'roomBalance':              SECTION_TIER.HIGH,
  'autoEnergyBuyer':          SECTION_TIER.HIGH,
  'marketUpdater':            SECTION_TIER.LOW,
  'marketRefine.run':         SECTION_TIER.LOW,
  'localRefine.run':          SECTION_TIER.LOW,
  'marketLab.run':            SECTION_TIER.LOW,

  'marketSeller.run':         SECTION_TIER.LOW,
  'opportunisticBuy':         SECTION_TIER.LOW,
  'opportunisticSell':        SECTION_TIER.LOW,
  'autoTrader.run':           SECTION_TIER.LOW,
  'dailyFinance':             SECTION_TIER.LOW,
  'marketArbitrage':          SECTION_TIER.LOW,
  'trackCPUUsage':            SECTION_TIER.LOW,
  'localMap.run':             SECTION_TIER.LOW,
  'statusReport':             SECTION_TIER.LOW,
  'creepProfiler.run':        SECTION_TIER.LOW,
  'creepProfiler.report':     SECTION_TIER.LOW,
  'roomCPUProfiler':          SECTION_TIER.LOW,
};

// === CREEP PRIORITY CONFIGURATION (lower number = higher priority) ===
// Tier 1 (1-5):  Always run, even under extreme CPU pressure
// Tier 2 (6-15): Run under normal budget, skipped under CRITICAL budget
// Tier 3 (16+):  First to be shed when over budget
const CREEP_PRIORITY = {
  'harvester':            17,
  'upgrader':             20,
  'builder':              3,
  'defender':             4,
  'towerFiller':          2,
  'staticDistributor':    5,
  'supplier':             1,
  'wallRepair':           20,
  'repairer':             20,
  'attacker':             1,
  'claimbot':             1,
  'mineralCollector':    10,
  'extractor':           10,
  'depositHarvester':    10,
  'powerBot':            20,
  'maintainer':          2,
  'repairBot':           20,
  'rampartBot':          20,
  'labBot':              17,
  'remoteBuilder':       14,
  'hd':                  3,
  'comboBot':            3,
  'skAttacker':          3,
  'signbot':             23,
  'contestedDemolisher': 1,
  'nukeFill':            6,
  'towerDrain':          1,
  'scout':               27,
  'thief':               28,
  'default':             99,
  'remoteSupplier': 5,
  'controllerAttacker':   2,
  'extractorAssistant':  20,
};

// Creep throttle: max tick-interval per priority band under full pressure.
// At zero pressure everything runs every tick. As pressure rises toward 1.0,
// the interval ramps linearly from 1 up to the band's max.
// A creep with interval N runs when (Game.time + nameHash) % N === 0,
// so different creeps of the same role stagger across ticks automatically.
const CREEP_THROTTLE_BANDS = [
  // { maxPriority, maxInterval }
  { maxPriority:  5, maxInterval: 1 },  // Economy core: NEVER throttled
  { maxPriority: 10, maxInterval: 2 },  // Combat + logistics: every other tick worst-case
  { maxPriority: 15, maxInterval: 3 },  // Infrastructure support
  { maxPriority: 25, maxInterval: 4 },  // Utility roles
  { maxPriority: 99, maxInterval: 5 },  // Nice-to-haves (scouts, thieves)
];

// Section throttle: max tick-interval each tier can be stretched to under pressure
const SECTION_MAX_INTERVAL = {
  [SECTION_TIER.CRITICAL]: 1,   // Always every tick
  [SECTION_TIER.HIGH]:     2,   // Every other tick worst-case
  [SECTION_TIER.NORMAL]:   3,   // Every 3 ticks worst-case
  [SECTION_TIER.LOW]:      5,   // Every 5 ticks worst-case
};

// === ERROR TRACKING ===
if (!Memory.errors) Memory.errors = [];

// --- ROLE & UTILITY IMPORTS ---
require('marketQuery');
require('marketAnalysis');
const roleHarvester = require('roleHarvester');
const roleUpgrader = require('roleUpgrader');
const roleBuilder = require('roleBuilder');
const roleScout = require('roleScout');
const roleDefender = require('roleDefender');
const roleSupplier = require('roleSupplier');
const roleClaimbot = require('roleClaimbot');
const roleAttacker = require('roleAttacker');
const roleExtractor = require('roleExtractor');
const iff = require('iff');
const roleThief = require('roleThief');
const roleSquad = require('roleSquad');
const roleTowerDrain = require('roleTowerDrain');
const roleDemolition = require('roleDemolition');
const roleMineralCollector = require('roleMineralCollector');
const terminalManager = require('terminalManager');
const roleSignbot = require('roleSignbot');
const factoryManager = require('factoryManager');
const labManager = require('labManager');
const roleLabBot = require('roleLabBot');
const roomBalance = require('roomBalance');
const mineralManager = require('mineralManager');
const getRoomState = require('getRoomState');
const towerManager = require('towerManager');
const linkManager = require('linkManager');
const globalOrders = require('globalOrders');
const marketSeller = require('marketSell');
const marketBuyer = require('marketBuy');
const marketUpdater = require('marketUpdate');
const opportunisticBuy = require('opportunisticBuy');
const marketRefine = require('marketRefine');
const localRefine = require('localRefine');
const marketLab = require('marketLab');
const roleNukeFill = require('roleNukeFill');
const nukeLaunch = require('nukeLaunch');
const marketRoomOrders = require('marketRoomOrders');
const roleRemoteBuilder = require('roleRemoteBuilder');
const memoryProfiler = require('memoryProfiler');
const depositObserver = require('depositObserver');
const roleDepositHarvester = require('roleDepositHarvester');
const rolePowerBot = require('rolePowerBot');
const powerManager = require('powerManager');
const roleOperator = require('roleOperator');
const marketReport = require('marketReport');
const roleMaintainer = require('roleMaintainer');
const roleContestedDemolisher = require('roleContestedDemolisher');
const autoEnergyBuyer = require('autoEnergyBuyer');
const autoTrader = require('autoTrader');
const roomNavigation = require('roomNavigation');
const memoryQuery = require('memoryQuery');
const dailyFinance = require('dailyFinance');
const marketPricing = require('marketPricing');
const marketArbitrage = require('marketArbitrage');
const roleSKAttacker = require('roleSKAttacker');
const defenseMonitor = require('defenseMonitor');
const singleSourceRoom = require('singleSourceRoom');
const roleHD = require('roleHD');
const roleStaticDistributor = require('roleStaticDistributor');
const roleComboBot = require('roleComboBot');
const opportunisticSell = require('opportunisticSell');
const statusReport = require('statusReport');
const storageManager = require('storageManager');
const boostManager = require('boostManager');
const roomCPUProfiler = require('roomCPUProfiler');
const localMap = require('localMap');
const spawnManager = require('spawnManager');
const remoteSupplyManager = require('remoteSupplyManager');
const roleRemoteSupplier  = require('roleRemoteSupplier');
const roleControllerAttacker = require('roleControllerAttacker');
const roleExtractorAssistant = require('roleExtractorAssistant');
const claimbotRangeCheck     = require('claimbotRangeCheck');
const roleTowerFiller = require('roleTowerFiller');
const repairManager = require('repairManager');
const roleRepairer = require('roleRepairer');

require("marketMap");


statusReport.init(ENABLE_CPU_LOGGING, DISABLE_CPU_CONSOLE);

// === GLOBAL MODULE EXPOSURE FOR CONSOLE ACCESS ===
global.opportunisticBuy = opportunisticBuy;
global.nukeFill = roleNukeFill.order;
global.launchNuke = nukeLaunch.launchNuke;
global.listRoomMarketOrders = marketRoomOrders.listRoomMarketOrders;
global.memoryProfile = memoryProfiler.profile;
global.harvestResources = depositObserver.harvestResources;
global.launchClaimbot = require('roleClaimbot').spawn;
global.orderThieves = require('roleThief').orderThieves;
global.cancelThiefOrder = require('roleThief').cancelThiefOrder;
global.listThiefOrders = require('roleThief').listThiefOrders;
global.financeReport = function (mode) { dailyFinance.report(mode); };
global.prices = marketPricing.printPrices;
global.marketArbitrage = marketArbitrage;
global.creepProfile = creepProfiler;
global.opportunisticSell = opportunisticSell;
global.storageFind = function(room, material) {
    storageManager.printFind(room, material);
};
global.getUnreserved = function(roomName) {
    storageManager.printUnreserved(roomName);
};
global.reserve = storageManager.reserve.bind(storageManager);
global.unReserve = storageManager.unReserve.bind(storageManager);
global.transfer = storageManager.transfer.bind(storageManager);
global.listReservations = storageManager.listReservations.bind(storageManager);
global.validateReservations = storageManager.validateReservations.bind(storageManager);
global.profileRoom       = roomCPUProfiler.start;
global.cancelRoomProfile = roomCPUProfiler.cancel;
global.roomProfileStatus  = roomCPUProfiler.status;
global.status = function() { statusReport.run(statusReport.getPerRoomRoleCounts()); };
global.buildRoad = roadBuilder.buildRoad;
global.removeRoad = roadBuilder.removeRoad;
global.removeAllRoads = roadBuilder.removeAllRoads;
global.schedule      = taskScheduler.schedule.bind(taskScheduler);
global.unschedule    = taskScheduler.unschedule.bind(taskScheduler);
global.listScheduled = taskScheduler.list.bind(taskScheduler);
global.runScheduled  = taskScheduler.forceRun.bind(taskScheduler);
global.nukeStatus   = nukeLaunch.nukeStatus;
global.checkClaimbotRange = function(s, t, r) { return claimbotRangeCheck.start(s, t, r); };
global.updateScheduled = (id, updates) => taskScheduler.update(id, updates);
global.marketMap = require("marketMap");

// Optional: keep your help list updated
global.help = function() {
    console.log([
        "Console commands:",
        "  marketMap()        Print room liquidity snapshot",
        "  marketUpdater.run()",
        "  ..."
    ].join("\n"));
};


// =================================================================
// === CPU SCHEDULER - CONSOLE COMMANDS ============================
// =================================================================

global.cpuHelp = function() {
  console.log('==============================================================');
  console.log('|         CPU SCHEDULER - CONSOLE COMMANDS            |');
  console.log('==============================================================');
  console.log('|  cpu()            Detailed scheduler status report  |');
  console.log('|                   Bucket, tier, budget, pressure,   |');
  console.log('|                   sparkline, section & role avgs.   |');
  console.log('==============================================================');
  console.log('|  cpuHud(\'W1N1\')   Enable live RoomVisual overlay   |');
  console.log('|                   CPU/bucket/pressure bars + chart  |');
  console.log('|  cpuHud()         Disable the HUD overlay           |');
  console.log('==============================================================');
  console.log('|  cpuJSON()        Dump stats as JSON for external   |');
  console.log('|                   dashboard (copy -> paste)          |');
  console.log('==============================================================');
  console.log('|  SCHEDULER TIERS:                                   |');
  console.log('|  Bucket < 1000  -> CRITICAL  14.0 CPU  100% pressure|');
  console.log('|  1000 - 3000    -> LOW       14-18 CPU ramp         |');
  console.log('|  3000 - 8000    -> NORMAL    18.0 CPU  0% pressure  |');
  console.log('|  > 8000         -> FLUSH     19.3 CPU  0% pressure  |');
  console.log('==============================================================');
  console.log('|  THROTTLE: Under pressure, low-priority items run   |');
  console.log('|  every 2-5 ticks instead of every tick. Priority    |');
  console.log('|  1-5 creeps and CRITICAL sections never throttle.   |');
  console.log('==============================================================');
};

global.cpu = function() {
  const s = Memory.cpuStats || {};
  console.log('==============================================================');
  console.log('|           CPU SCHEDULER STATUS               |');
  console.log('==============================================================');
  console.log('| Bucket:     ' + (s.bucket || '?') + ' / 10000');
  console.log('| Tier:       ' + (s.lastBudgetTier || '?'));
  console.log('| Budget:     ' + (s.lastBudget ? s.lastBudget.toFixed(1) : '?') + ' CPU');
  console.log('| Pressure:   ' + (s.lastPressure || 0) + '%');
  console.log('| Avg CPU:    ' + (s.average ? s.average.toFixed(2) : '?'));
  console.log('| Throttled:  ' + (s.lastSectionsThrottled || 0) + ' sections, '
    + (s.lastCreepsThrottled || 0) + ' creeps');
  console.log('==============================================================');

  if (s.history && s.history.length > 0) {
    const recent = s.history.slice(-20);
    const max = Math.max.apply(null, recent);
    const bars = recent.map(function(v) {
      const pct = v / max;
      if (pct > 0.875) return '█';
      if (pct > 0.75) return '▇';
      if (pct > 0.625) return '▆';
      if (pct > 0.5) return '▅';
      if (pct > 0.375) return '▄';
      if (pct > 0.25) return '▃';
      if (pct > 0.125) return '▂';
      return '▁';
    }).join('');
    console.log('| History:    ' + bars + ' (peak ' + max.toFixed(1) + ')');
  }

  if (Memory.cpuProfile) {
    console.log('========== SECTION AVERAGES ==========================');
    const entries = [];
    for (var key in Memory.cpuProfile) {
      var arr = Memory.cpuProfile[key];
      var avg = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
      entries.push({ name: key, avg: avg });
    }
    entries.sort(function(a, b) { return b.avg - a.avg; });
    for (var i = 0; i < Math.min(entries.length, 15); i++) {
      var e = entries[i];
      console.log('|  ' + e.name + ': ' + e.avg.toFixed(3) + ' CPU');
    }
  }

  if (Memory.cpuProfileCreeps) {
    console.log('========== CREEP ROLE AVERAGES ======================');
    var roleEntries = [];
    for (var role in Memory.cpuProfileCreeps) {
      var roleArr = Memory.cpuProfileCreeps[role];
      var roleAvg = roleArr.reduce(function(a, b) { return a + b; }, 0) / roleArr.length;
      roleEntries.push({ name: role, avg: roleAvg });
    }
    roleEntries.sort(function(a, b) { return b.avg - a.avg; });
    for (var j = 0; j < roleEntries.length; j++) {
      var r = roleEntries[j];
      console.log('|  ' + r.name + ': ' + r.avg.toFixed(3) + ' CPU');
    }
  }

  console.log('==============================================================');
};

global.cpuHud = function(roomName) {
  if (!roomName) {
    delete Memory.cpuHudRoom;
    console.log('[CPU HUD] Disabled.');
  } else {
    Memory.cpuHudRoom = roomName;
    console.log('[CPU HUD] Enabled on ' + roomName + '. Call cpuHud() to disable.');
  }
};

global.cpuJSON = function() {
  console.log(JSON.stringify(Memory.cpuStats || {}));
};

// === PROFILER REGISTRATION ===
profiler.registerObject(scanner, 'scanner');
profiler.registerObject(roleHarvester, 'roleHarvester');
profiler.registerObject(roleUpgrader, 'roleUpgrader');
profiler.registerObject(roleTowerFiller, 'roleTowerFiller');
profiler.registerObject(roleBuilder, 'roleBuilder');
profiler.registerObject(roleScout, 'roleScout');
profiler.registerObject(roleDefender, 'roleDefender');
profiler.registerObject(roleSupplier, 'roleSupplier');
profiler.registerObject(roleClaimbot, 'roleClaimbot');
profiler.registerObject(roleAttacker, 'roleAttacker');
profiler.registerObject(roleExtractor, 'roleExtractor');
profiler.registerObject(iff, 'iff');
profiler.registerObject(roleThief, 'roleThief');
profiler.registerObject(roleSquad, 'roleSquad');
profiler.registerObject(roleTowerDrain, 'roleTowerDrain');
profiler.registerObject(roleDemolition, 'roleDemolition');
profiler.registerObject(roleMineralCollector, 'roleMineralCollector');
profiler.registerObject(roleSignbot, 'roleSignbot');
profiler.registerObject(factoryManager, 'factoryManager');
profiler.registerObject(labManager, 'labManager');
profiler.registerObject(roleLabBot, 'roleLabBot');
profiler.registerObject(roomBalance, 'roomBalance');
profiler.registerObject(mineralManager, 'mineralManager');
profiler.registerObject(getRoomState, 'getRoomState');
profiler.registerObject(towerManager, 'towerManager');
profiler.registerObject(linkManager, 'linkManager');
profiler.registerObject(spawnManager, 'spawnManager');
profiler.registerObject(marketUpdater, 'marketUpdater');
profiler.registerObject(opportunisticBuy, 'opportunisticBuy');
profiler.registerObject(marketRefine, 'marketRefine');
profiler.registerObject(localRefine, 'localRefine');
profiler.registerObject(marketLab, 'marketLab');
profiler.registerObject(roleNukeFill, 'roleNukeFill');
profiler.registerObject(nukeLaunch, 'nukeLaunch');
profiler.registerObject(marketRoomOrders, 'marketRoomOrders');
profiler.registerObject(roleRemoteBuilder, 'roleRemoteBuilder');
profiler.registerObject(roleDepositHarvester, 'roleDepositHarvester');
profiler.registerObject(depositObserver, 'depositObserver');
profiler.registerObject(rolePowerBot, 'rolePowerBot');
profiler.registerObject(powerManager, 'powerManager');
profiler.registerObject(roleOperator, 'roleOperator');
profiler.registerObject(roleMaintainer, 'roleMaintainer');
profiler.registerObject(roleContestedDemolisher, 'roleContestedDemolisher');
profiler.registerObject(autoEnergyBuyer, 'autoEnergyBuyer');
profiler.registerObject(autoTrader, 'autoTrader');
profiler.registerObject(roomNavigation, 'roomNavigation');
profiler.registerObject(dailyFinance, 'dailyFinance');
profiler.registerObject(marketPricing, 'marketPricing');
profiler.registerObject(marketArbitrage, 'marketArbitrage');
profiler.registerObject(roleSKAttacker, 'roleSKAttacker');
profiler.registerObject(defenseMonitor, 'defenseMonitor');
profiler.registerObject(singleSourceRoom, 'singleSourceRoom');
profiler.registerObject(roleHD, 'roleHD');
profiler.registerObject(roleStaticDistributor, 'roleStaticDistributor');
profiler.registerObject(roleComboBot, 'roleComboBot');
profiler.registerObject(creepProfiler, 'creepProfiler');
profiler.registerObject(opportunisticSell, 'opportunisticSell');
profiler.registerObject(statusReport, 'statusReport');
profiler.registerObject(storageManager, 'storageManager');
profiler.registerObject(boostManager, 'boostManager');
profiler.registerObject(roomCPUProfiler, 'roomCPUProfiler');
profiler.registerObject(remoteSupplyManager, 'remoteSupplyManager');
profiler.registerObject(roleRemoteSupplier,  'roleRemoteSupplier');
profiler.registerObject(roleControllerAttacker, 'roleControllerAttacker');
profiler.registerObject(roleExtractorAssistant, 'roleExtractorAssistant');
profiler.registerObject(claimbotRangeCheck,     'claimbotRangeCheck');
profiler.registerObject(repairManager, 'repairManager');
profiler.registerObject(roleRepairer, 'roleRepairer');


// =================================================================
/* === CPU SCHEDULER =============================================== */
// =================================================================

// Per-tick state - reset at top of loop
let tickBudget = CPU_LIMITS.NORMAL;
let tickBudgetTier = 'NORMAL';
let tickPressure = 0;
let sectionsThrottled = 0;
let creepsThrottled = 0;
let tickSectionCpu = {};   // Live per-section CPU cost for this tick (used by HUD)

// FIX #1: Cache for live pressure - updated once per scope, reused
let cachedLivePressure = 0;
let pressureCacheTime = -1;

// FIX #1: Precomputed section name hashes to avoid string hashing every tick
const SECTION_NAME_HASHES = {};
for (const name in SECTION_TIERS) {
  SECTION_NAME_HASHES[name] = name.length + name.charCodeAt(0) + (name.charCodeAt(name.length-1) || 0);
}

/**
 * Simple deterministic hash - OPTIMIZED version using cached values where possible
 */
function nameHash(str) {
  // Use precomputed hash for section names
  if (SECTION_NAME_HASHES[str] !== undefined) {
    return SECTION_NAME_HASHES[str];
  }
  // Fast hash for creep names: use length + first/last char codes
  // Much faster than full character iteration for 50+ creeps
  return str.length + str.charCodeAt(0) + (str.charCodeAt(str.length-1) || 0);
}

/**
 * Cached version of getLivePressure - computes once per tick phase
 */
function getLivePressureCached() {
  if (pressureCacheTime !== Game.time) {
    const used = Game.cpu.getUsed();
    const usageRatio = used / tickBudget;

    if (usageRatio < 0.70) {
      cachedLivePressure = tickPressure;
    } else {
      const cpuPressure = (usageRatio - 0.70) / 0.30;
      cachedLivePressure = Math.min(1.0, Math.max(tickPressure, cpuPressure));
    }
    pressureCacheTime = Game.time;
  }
  return cachedLivePressure;
}

function calcTickBudget() {
  const bucket = Game.cpu.bucket;

  if (bucket < 1000) {
    tickBudget = CPU_LIMITS.CRITICAL;
    tickBudgetTier = 'CRITICAL';
    tickPressure = 1.0;
  } else if (bucket < 3000) {
    const ratio = (bucket - 1000) / 2000;
    tickBudget = CPU_LIMITS.CRITICAL + ratio * (CPU_LIMITS.NORMAL - CPU_LIMITS.CRITICAL);
    tickBudgetTier = 'LOW';
    tickPressure = 1.0 - ratio;
  } else if (bucket < 8000) {
    tickBudget = CPU_LIMITS.NORMAL;
    tickBudgetTier = 'NORMAL';
    tickPressure = 0;
  } else {
    tickBudget = CPU_LIMITS.HARD_CEILING;
    tickBudgetTier = 'FLUSH';
    tickPressure = 0;
  }

  sectionsThrottled = 0;
  creepsThrottled = 0;
  tickSectionCpu = {};
  // Reset pressure cache for new tick
  pressureCacheTime = -1;
}

/**
 * Get the throttle interval for a section based on its tier and CACHED live pressure.
 */
function getSectionInterval(tier) {
  const pressure = getLivePressureCached(); // FIX #1: Use cached version
  if (pressure <= 0) return 1;
  const maxInterval = SECTION_MAX_INTERVAL[tier] || 1;
  return Math.max(1, Math.ceil(pressure * maxInterval));
}

/**
 * Get the throttle interval for a creep based on priority and CACHED live pressure.
 */
function getCreepInterval(priority) {
  const pressure = getLivePressureCached(); // FIX #1: Use cached version
  if (pressure <= 0) return 1;

  let maxInterval = 5;
  for (const band of CREEP_THROTTLE_BANDS) {
    if (priority <= band.maxPriority) {
      maxInterval = band.maxInterval;
      break;
    }
  }

  if (maxInterval <= 1) return 1;
  return Math.max(1, Math.ceil(pressure * maxInterval));
}

// =================================================================
/* === HELPER & UTILITY FUNCTIONS ================================== */
// =================================================================

function handleError(sectionName, error) {
  console.log('ERROR IN ' + sectionName + ': ' + error.stack);
  Game.notify('ERROR IN ' + sectionName + ': ' + error.message);
  Memory.errors.push({
    tick: Game.time,
    section: sectionName,
    error: error.toString(),
    timestamp: Date.now()
  });
  if (Memory.errors.length > 10) Memory.errors.shift();
}

/**
 * Clean dead creep memory with role-specific order handling.
 */
function cleanMemory() {
  // FIX #7: Initialize order arrays if they don't exist
  if (!Memory.thiefOrders) Memory.thiefOrders = [];
  if (!Memory.demolitionOrders) Memory.demolitionOrders = [];

  if (Memory.remoteMaintainerOrders) delete Memory.remoteMaintainerOrders;
  if (Memory.remoteMaintainerView)    delete Memory.remoteMaintainerView;

  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      const creepMemory = Memory.creeps[name];

      // FIX #7: Added Array.isArray guards
      if (creepMemory.role === 'thief' && Array.isArray(Memory.thiefOrders)) {
        const orderIndex = Memory.thiefOrders.findIndex(function(o) {
          return o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom;
        });
        if (orderIndex > -1) {
          console.log('[Thief] A thief for operation against ' + creepMemory.targetRoom + ' has died. Cancelling the operation.');
          Memory.thiefOrders.splice(orderIndex, 1);
        }
      }

      if (creepMemory.role === 'demolition' && Array.isArray(Memory.demolitionOrders)) {
        const orderIndex = Memory.demolitionOrders.findIndex(function(o) {
          return o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom;
        });
        if (orderIndex > -1 && creepMemory.demolitionRole === 'demolisher') {
          console.log('[Demolition] A demolisher for operation against ' + creepMemory.targetRoom + ' has died. Keeping operation active for respawn.');
        }
      }

      delete Memory.creeps[name];
    }
  }
}

function trackCPUUsage() {
  if (!Memory.cpuStats) {
    Memory.cpuStats = { history: [], average: 0, snapshots: [] };
  }
  const cpuUsed = Game.cpu.getUsed();
  Memory.cpuStats.history.push(cpuUsed);
  if (Memory.cpuStats.history.length > 50) Memory.cpuStats.history.shift();
  Memory.cpuStats.average = Memory.cpuStats.history.reduce(function(sum, cpu) { return sum + cpu; }, 0) / Memory.cpuStats.history.length;

  Memory.cpuStats.lastBudgetTier = tickBudgetTier;
  Memory.cpuStats.lastBudget = tickBudget;
  Memory.cpuStats.lastPressure = Math.round(tickPressure * 100);
  Memory.cpuStats.lastSectionsThrottled = sectionsThrottled;
  Memory.cpuStats.lastCreepsThrottled = creepsThrottled;
  Memory.cpuStats.bucket = Game.cpu.bucket;

  if (Game.time % 5 === 0) {
    if (!Memory.cpuStats.snapshots) Memory.cpuStats.snapshots = [];
    Memory.cpuStats.snapshots.push({
      t: Game.time,
      cpu: Math.round(cpuUsed * 10) / 10,
      bkt: Game.cpu.bucket,
      psi: Math.round(tickPressure * 100),
      bud: Math.round(tickBudget * 10) / 10,
      tier: tickBudgetTier.charAt(0),
      tSec: sectionsThrottled,
      tCrp: creepsThrottled,
    });
    if (Memory.cpuStats.snapshots.length > 50) Memory.cpuStats.snapshots.shift();
  }
}

function drawCpuHud() {
  if (!Memory.cpuHudRoom) return;
  const room = Game.rooms[Memory.cpuHudRoom];
  if (!room) return;

  const v = room.visual;
  const used = Game.cpu.getUsed();
  const budget = tickBudget;
  const bucket = Game.cpu.bucket;
  const pressure = getLivePressureCached();

  // ---------------------------------------------------------------
  // PANEL 1 — Summary bars (unchanged)
  // ---------------------------------------------------------------
  v.rect(0, 0, 12, 5.8, { fill: '#000000', opacity: 0.7, stroke: '#333333' });
  v.text('CPU SCHEDULER', 6, 0.55, { color: '#ffffff', font: 'bold 0.55 monospace', align: 'center' });

  var cpuPct = Math.min(used / 20, 1);
  var cpuColor = cpuPct > 0.9 ? '#ff4444' : cpuPct > 0.7 ? '#ffaa00' : '#44ff44';
  v.text('CPU', 0.3, 1.45, { color: '#aaaaaa', font: '0.4 monospace', align: 'left' });
  v.rect(2.2, 1.1, 8, 0.5, { fill: '#333333', opacity: 0.8 });
  v.rect(2.2, 1.1, 8 * cpuPct, 0.5, { fill: cpuColor, opacity: 0.9 });
  v.text(used.toFixed(1) + '/' + budget.toFixed(1), 10.5, 1.45, { color: '#ffffff', font: '0.35 monospace', align: 'left' });

  var bucketPct = bucket / 10000;
  var bucketColor = bucketPct < 0.1 ? '#ff4444' : bucketPct < 0.3 ? '#ffaa00' : '#4488ff';
  v.text('BKT', 0.3, 2.15, { color: '#aaaaaa', font: '0.4 monospace', align: 'left' });
  v.rect(2.2, 1.8, 8, 0.5, { fill: '#333333', opacity: 0.8 });
  v.rect(2.2, 1.8, 8 * bucketPct, 0.5, { fill: bucketColor, opacity: 0.9 });
  v.text(bucket.toString(), 10.5, 2.15, { color: '#ffffff', font: '0.35 monospace', align: 'left' });

  var pressColor = pressure > 0.7 ? '#ff4444' : pressure > 0.3 ? '#ffaa00' : '#44ff44';
  v.text('PSI', 0.3, 2.85, { color: '#aaaaaa', font: '0.4 monospace', align: 'left' });
  v.rect(2.2, 2.5, 8, 0.5, { fill: '#333333', opacity: 0.8 });
  v.rect(2.2, 2.5, 8 * Math.min(pressure, 1), 0.5, { fill: pressColor, opacity: 0.9 });
  v.text(Math.round(pressure * 100) + '%', 10.5, 2.85, { color: '#ffffff', font: '0.35 monospace', align: 'left' });

  v.text('Tier: ' + tickBudgetTier, 0.3, 3.65, { color: '#ffffff', font: '0.4 monospace', align: 'left' });
  v.text('Avg: ' + (Memory.cpuStats && Memory.cpuStats.average ? Memory.cpuStats.average.toFixed(1) : '?'),
    5.5, 3.65, { color: '#ffffff', font: '0.4 monospace', align: 'left' });

  v.text('Throttled:', 0.3, 4.35, { color: '#aaaaaa', font: '0.4 monospace', align: 'left' });
  v.text(sectionsThrottled + ' sections  ' + creepsThrottled + ' creeps',
    3.8, 4.35, { color: sectionsThrottled + creepsThrottled > 0 ? '#ffaa00' : '#44ff44', font: '0.4 monospace', align: 'left' });

  if (Memory.cpuStats && Memory.cpuStats.history && Memory.cpuStats.history.length > 1) {
    var hist = Memory.cpuStats.history.slice(-20);
    var maxH = 20;
    v.text('History:', 0.3, 5.25, { color: '#aaaaaa', font: '0.35 monospace', align: 'left' });
    for (var hi = 0; hi < hist.length; hi++) {
      var barH = (hist[hi] / maxH) * 0.7;
      var barX = 3.5 + hi * 0.4;
      var barColor = hist[hi] > budget ? '#ff4444' : hist[hi] > budget * 0.85 ? '#ffaa00' : '#44ff44';
      v.rect(barX, 5.3 - barH, 0.3, barH, { fill: barColor, opacity: 0.8 });
    }
  }

  // ---------------------------------------------------------------
  // PANEL 2 — Per-module CPU breakdown (live, this tick)
  // runCreeps is the wrapper total for all creep:* entries — we use it
  // as a group header instead of a data row to avoid double-counting.
  // ---------------------------------------------------------------
  const moduleEntries = [];
  const creepEntries  = [];
  let   runCreepsTotal = 0;

  for (const key in tickSectionCpu) {
    if (key === 'runCreeps') {
      runCreepsTotal = tickSectionCpu[key];
    } else if (key.startsWith('creep:')) {
      creepEntries.push({ name: key.slice(6), cpu: tickSectionCpu[key] });
    } else {
      moduleEntries.push({ name: key, cpu: tickSectionCpu[key] });
    }
  }
  moduleEntries.sort(function(a, b) { return b.cpu - a.cpu; });
  creepEntries.sort(function(a, b)  { return b.cpu - a.cpu; });

  const maxModules = 10;
  const maxCreeps  = 10;
  const modShow    = Math.min(moduleEntries.length, maxModules);
  const crpShow    = Math.min(creepEntries.length,  maxCreeps);

  if (modShow + crpShow === 0) return;

  const pX      = 0;
  const pY      = 6.2;
  const rowH    = 0.52;
  const sepH    = 0.52;   // height of the creep group header separator
  const panelW  = 14.5;
  const labelW  = 5.8;
  const barMaxW = 6.2;

  // Total panel height: title + module rows + creep-header + creep rows
  const panelH = 0.65
    + modShow * rowH
    + (crpShow > 0 ? sepH + crpShow * rowH : 0);

  v.rect(pX, pY, panelW, panelH,
    { fill: '#000000', opacity: 0.70, stroke: '#333333' });
  v.text('CPU — this tick',
    pX + panelW / 2, pY + 0.48,
    { color: '#aaaaff', font: 'bold 0.38 monospace', align: 'center' });

  // Single scale across both groups so bars are directly comparable.
  // runCreepsTotal is the sum of all creep entries so it must anchor the scale —
  // otherwise the group-total bar overflows the panel width.
  const allCpu = moduleEntries.concat(creepEntries);
  const maxCpu = Math.max.apply(null,
    allCpu.map(function(e) { return e.cpu; }).concat([runCreepsTotal, 0.1]));

  // Helper: draw one data row
  function drawRow(label, cpu, y) {
    const pct      = cpu / tickBudget;
    const barColor = pct > 0.15 ? '#ff4444' : pct > 0.07 ? '#ffaa00' : '#44cc44';
    const shortLbl = label.length > 18 ? label.slice(0, 17) + '\u2026' : label;

    v.text(shortLbl, pX + 0.2, y + 0.30,
      { color: '#cccccc', font: '0.31 monospace', align: 'left' });
    v.rect(pX + labelW, y, barMaxW, 0.38,
      { fill: '#2a2a2a', opacity: 0.80 });
    v.rect(pX + labelW, y, Math.max((cpu / maxCpu) * barMaxW, 0.04), 0.38,
      { fill: barColor, opacity: 0.88 });
    v.text(cpu.toFixed(3), pX + labelW + barMaxW + 0.15, y + 0.30,
      { color: '#ffffff', font: '0.31 monospace', align: 'left' });
  }

  // --- MODULE rows ---
  for (let i = 0; i < modShow; i++) {
    drawRow(moduleEntries[i].name, moduleEntries[i].cpu, pY + 0.75 + i * rowH);
  }

  // --- CREEP group header (separator) ---
  if (crpShow > 0) {
    const sepY = pY + 0.75 + modShow * rowH;
    v.rect(pX, sepY, panelW, sepH,
      { fill: '#111122', opacity: 0.90 });
    v.text('CREEPS',
      pX + 0.2, sepY + 0.36,
      { color: '#8888cc', font: 'bold 0.32 monospace', align: 'left' });
    // Thin total bar across the full width
    const totalPct  = runCreepsTotal / tickBudget;
    const totalColor = totalPct > 0.40 ? '#ff4444' : totalPct > 0.20 ? '#ffaa00' : '#44cc44';
    v.rect(pX + labelW, sepY + 0.07, barMaxW, 0.36,
      { fill: '#2a2a2a', opacity: 0.80 });
    v.rect(pX + labelW, sepY + 0.07,
      Math.max((runCreepsTotal / maxCpu) * barMaxW, 0.04), 0.36,
      { fill: totalColor, opacity: 0.60 });
    v.text(runCreepsTotal.toFixed(3),
      pX + labelW + barMaxW + 0.15, sepY + 0.36,
      { color: '#aaaaaa', font: '0.31 monospace', align: 'left' });

    // --- CREEP rows ---
    for (let i = 0; i < crpShow; i++) {
      drawRow(creepEntries[i].name, creepEntries[i].cpu,
        sepY + sepH + i * rowH);
    }
  }
}

if (ENABLE_CPU_LOGGING && !Memory.cpuProfile) Memory.cpuProfile = {};

function profileSection(name, fn) {
  const sectionTier = SECTION_TIERS[name] !== undefined ? SECTION_TIERS[name] : SECTION_TIER.NORMAL;
  const interval = getSectionInterval(sectionTier);

  if (interval > 1) {
    // Use precomputed hash from SECTION_NAME_HASHES
    if ((Game.time + SECTION_NAME_HASHES[name]) % interval !== 0) {
      sectionsThrottled++;
      return;
    }
  }

  const start = Game.cpu.getUsed();
  try {
    fn();
  } catch (e) {
    handleError(name, e);
  } finally {
    const used = Game.cpu.getUsed() - start;

    // Always capture for the live HUD — no flag needed
    tickSectionCpu[name] = (tickSectionCpu[name] || 0) + used;

    if (ENABLE_CPU_LOGGING) {
      if (!Memory.cpuProfile[name]) Memory.cpuProfile[name] = [];
      Memory.cpuProfile[name].push(used);
      if (Memory.cpuProfile[name].length > 50) Memory.cpuProfile[name].shift();
      if (!Memory.cpuProfileLastUsed) Memory.cpuProfileLastUsed = {};
      Memory.cpuProfileLastUsed[name] = Game.time;
    }
  }
}

function cleanCpuProfileMemory(maxAge) {
  if (maxAge === undefined) maxAge = 5000;
  if (!Memory.cpuProfileLastUsed) return;
  const now = Game.time;
  for (const key in Memory.cpuProfileLastUsed) {
    if (now - Memory.cpuProfileLastUsed[key] > maxAge) {
      delete Memory.cpuProfile[key];
      delete Memory.cpuProfileLastUsed[key];
    }
  }
}

function cleanRepairBotCooldowns() {
  if (!Memory.repairBotCooldown) {
    for (const k in Memory) {
      if (k.indexOf('repairBotCooldown_') === 0) delete Memory[k];
    }
    return;
  }
  const now = Game.time;
  for (const k in Memory.repairBotCooldown) {
    if (now >= Memory.repairBotCooldown[k]) delete Memory.repairBotCooldown[k];
  }
  for (const k in Memory) {
    if (k.indexOf('repairBotCooldown_') === 0) delete Memory[k];
  }
}

// =================================================================
/* === CREEP MANAGEMENT ============================================ */
// =================================================================

// FIX #1: Cache for creep name hashes to avoid recomputing every tick
const creepNameHashCache = {};

function getCreepNameHash(creep) {
  if (!creepNameHashCache[creep.name]) {
    // Fast hash: name length + first char + last char
    creepNameHashCache[creep.name] = creep.name.length + creep.name.charCodeAt(0) + 
      (creep.name.charCodeAt(creep.name.length-1) || 0);
  }
  return creepNameHashCache[creep.name];
}

function runCreeps() {
  // Fast memory prune
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
      // Clean hash cache entry too
      delete creepNameHashCache[name];
    }
  }

  // FIX #1: REMOVED Array.sort() - O(n log n) every tick was expensive
  // The throttle system handles priority scheduling; strict ordering isn't needed
  // Just process creeps in natural Object.values order

  for (const creep of Object.values(Game.creeps)) {
    if (creep.spawning) continue;

    const role = creep.memory.role;
    const priority = creep.memory.customPriority !== undefined
      ? creep.memory.customPriority
      : (CREEP_PRIORITY[role] || CREEP_PRIORITY.default);

    // Throttle gate: compute interval based on priority + live pressure
    const interval = getCreepInterval(priority);
    if (interval > 1) {
      // FIX #1: Use cached hash instead of computing every time
      const hash = getCreepNameHash(creep);
      if ((Game.time + hash) % interval !== 0) {
        creepsThrottled++;
        continue;
      }
    }

    // Always measure — feeds the live HUD regardless of ENABLE_CPU_LOGGING
    const cpuBefore = Game.cpu.getUsed();

    try {
      switch (role) {
        case 'harvester':           roleHarvester.run(creep);               break;
        case 'upgrader':            roleUpgrader.run(creep);                break;
        case 'builder':             roleBuilder.run(creep);                 break;
        case 'scout':               roleScout.run(creep);                   break;
        case 'defender':            roleDefender.run(creep);                break;
        case 'supplier':            roleSupplier.run(creep);                break;
        case 'claimbot':            roleClaimbot.run(creep);                break;
        case 'attacker':            roleAttacker.run(creep);                break;
        case 'extractor':           roleExtractor.run(creep);               break;
        case 'thief':               roleThief.run(creep);                   break;
        case 'towerDrain':          roleTowerDrain.run(creep);              break;
        case 'demolition':          roleDemolition.run(creep);              break;
        case 'quad':                roleSquad.run(creep);                   break;
        case 'mineralCollector':    roleMineralCollector.run(creep);        break;
        case 'terminalBot':         terminalManager.runTerminalBot(creep);  break;
        case 'signbot':             roleSignbot.run(creep);                 break;
        case 'wallRepair':          roleRepairer.run(creep);                break;
        case 'labBot':              roleLabBot.run(creep);                  break;
        case 'nukeFill':            roleNukeFill.run(creep);                break;
        case 'remoteBuilder':       roleRemoteBuilder.run(creep);           break;
        case 'depositHarvester':    roleDepositHarvester.run(creep);        break;
        case 'powerBot':            rolePowerBot.run(creep);                break;
        case 'maintainer':          roleMaintainer.run(creep);              break;
        case 'contestedDemolisher': roleContestedDemolisher.run(creep);     break;
        case 'skAttacker':          roleSKAttacker.run(creep);              break;
        case 'defenseRepair':       roleRepairer.run(creep);                break;
        case 'hd':                  roleHD.run(creep);                      break;
        case 'staticDistributor':   roleStaticDistributor.run(creep);       break;
        case 'comboBot':            roleComboBot.run(creep);                break;
        case 'repairBot':           roleRepairer.run(creep);                break;
        case 'rampartBot':          roleRepairer.run(creep);                break;
        case 'remoteSupplier': roleRemoteSupplier.run(creep);               break;
        case 'controllerAttacker':  roleControllerAttacker.run(creep);      break;
        case 'towerFiller':         roleTowerFiller.run(creep);             break;
        case 'extractorAssistant': roleExtractorAssistant.run(creep); break;
        case 'repairer':            roleRepairer.run(creep);                break;
        default:
          creep.memory.role = 'harvester';
          roleHarvester.run(creep);
          break;
      }
    } catch (e) {
      handleError('creep.run.' + role + '.' + creep.name, e);
    }

    const cpuUsed = Game.cpu.getUsed() - cpuBefore;

    // Always accumulate into live HUD breakdown under 'creep:<role>'
    const hudKey = 'creep:' + role;
    tickSectionCpu[hudKey] = (tickSectionCpu[hudKey] || 0) + cpuUsed;

    if (ENABLE_CPU_LOGGING) {
      if (!Memory.cpuProfileCreeps) Memory.cpuProfileCreeps = {};
      if (!Memory.cpuProfileCreeps[role]) Memory.cpuProfileCreeps[role] = [];
      Memory.cpuProfileCreeps[role].push(cpuUsed);
      if (Memory.cpuProfileCreeps[role].length > 50) {
        Memory.cpuProfileCreeps[role].shift();
      }
    }
  }

  // --- POWER CREEPS ---
  if (Memory.operators) {
    for (const name in Memory.operators) {
      const pc = Game.powerCreeps[name];
      if (!pc) continue;
      if (!pc.ticksToLive) {
        try {
          roleOperator.trySpawn(pc, Memory.operators[name].homeRoom);
        } catch (e) {
          handleError('powerCreep.trySpawn.' + name, e);
        }
        continue;
      }

      // Always measure — feeds the live HUD
      const pcCpuBefore = Game.cpu.getUsed();

      try {
        roleOperator.runCreep(pc, Memory.operators[name]);
      } catch (e) {
        handleError('powerCreep.run.operator.' + name, e);
      }

      const pcCpuUsed = Game.cpu.getUsed() - pcCpuBefore;
      tickSectionCpu['creep:operator'] = (tickSectionCpu['creep:operator'] || 0) + pcCpuUsed;

      if (ENABLE_CPU_LOGGING) {
        if (!Memory.cpuProfileCreeps) Memory.cpuProfileCreeps = {};
        if (!Memory.cpuProfileCreeps['operator']) Memory.cpuProfileCreeps['operator'] = [];
        Memory.cpuProfileCreeps['operator'].push(pcCpuUsed);
        if (Memory.cpuProfileCreeps['operator'].length > 50) {
          Memory.cpuProfileCreeps['operator'].shift();
        }
      }
    }
  }

  if (Game.time % 50 === 0 && ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
    for (const role in Memory.cpuProfileCreeps) {
      const arr = Memory.cpuProfileCreeps[role];
      const avg = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
      console.log('Creep Role CPU: ' + role + ' avg: ' + Math.round(avg));
    }
  }
}

globalOrders.init({
  getRoomState: getRoomState,
  iff: iff,
  getCreepBody: spawnManager.getCreepBody,
  bodyCost: spawnManager.bodyCost
});

// =================================================================
/* ========================= MAIN GAME LOOP ======================== */
// =================================================================

module.exports.loop = function() {
  try {
    profiler.wrap(function() {
      // --- TICK INIT: Calculate budget from bucket ---
      calcTickBudget();

      if (Game.time % 100 === 0 || tickBudgetTier === 'CRITICAL') {
        console.log('[CPU] Tick ' + Game.time
          + ' | Bucket: ' + Game.cpu.bucket
          + ' | Tier: ' + tickBudgetTier
          + ' | Budget: ' + tickBudget.toFixed(1)
          + ' | Pressure: ' + Math.round(tickPressure * 100) + '%');
      }

      // --- GLOBAL CREEP CACHE BY ROLE ---
      global.creepsByRole = {};
      for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep.memory || !creep.memory.role) continue;
        const role = creep.memory.role;
        if (!global.creepsByRole[role]) global.creepsByRole[role] = [];
        global.creepsByRole[role].push(creep);
      }

      global.creepsByRoomAndRole = {};
      for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (!creep.memory || !creep.memory.role) continue;
        const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
        const role = creep.memory.role;
        if (!global.creepsByRoomAndRole[assignedRoom]) global.creepsByRoomAndRole[assignedRoom] = {};
        if (!global.creepsByRoomAndRole[assignedRoom][role]) global.creepsByRoomAndRole[assignedRoom][role] = [];
        global.creepsByRoomAndRole[assignedRoom][role].push(creep);
      }

      // --- MEMORY & SYSTEM MANAGEMENT ---
      if (!Memory.stats) Memory.stats = {};
      if (Game.time % 30 === 0) roleScout.handleDeadCreeps();
      if (Game.time % 1000 === 0) cleanMemory();
      if (Game.time % 1000 === 0) cleanCpuProfileMemory();
      if (Game.time % 1000 === 0) cleanRepairBotCooldowns();

      profileSection('getRoomState.init', function() { getRoomState.init(); });
      profileSection('roomCPUProfiler', function() { roomCPUProfiler.run(); });

      const perRoomRoleCounts = statusReport.getPerRoomRoleCounts();
      profileSection('claimbotRangeCheck.run', function() { claimbotRangeCheck.run(); });

      // --- STRUCTURES (CRITICAL tier - always runs) ---
      profileSection('defenseMonitor.run', function() { defenseMonitor.run(); });
      profileSection('repairManager.run', function() { repairManager.run(); });
      profileSection('towerManager.run', function() { towerManager.run(); });
      if (Game.time % 3 === 0) profileSection('linkManager.run', function() { linkManager.run(); });

      // --- MAINTENANCE & MANAGERS ---
      if (Game.time % 100 === 0) profileSection('roomBalance', function() { roomBalance.run(); });
      profileSection('terminalManager', function() { terminalManager.run(); });
      profileSection('roleTowerDrain', function() { roleTowerDrain.run(); });
      profileSection('mineralManager', function() { mineralManager.run(); });
      profileSection('factoryManager', function() { factoryManager.run(); });
      profileSection('marketUpdater', function() { marketUpdater.run(); });
      profileSection('marketRefine.run', function() { marketRefine.run(); });
      profileSection('localRefine.run', function() { localRefine.run(); });
      profileSection('marketLab.run', function() { marketLab.run(); });
      if (Game.time % 100 === 0) marketBuyer.run();
      profileSection('autoTrader.run', function() { autoTrader.run(); });
      profileSection('roleContestedDemolisher', function() { roleContestedDemolisher.run(); });
      profileSection('dailyFinance', function() { dailyFinance.run(); });
      profileSection('marketArbitrage', function() { marketArbitrage.run(); });
      if (Game.time % 10 === 0) profileSection('opportunisticBuy', function() { opportunisticBuy.process(); });
      profileSection('remoteSupplyManager.run', function() {
        remoteSupplyManager.run();
      });
      scanner.run();

      if (Game.time % 10 === 0) profileSection('opportunisticSell', function() { opportunisticSell.process(); });
      if (Game.time % 1000 === 0) storageManager.cleanStale(20000);
      if (Game.time % 50 === 0) profileSection('marketSeller.run', function() { marketSeller.run(); });

      profileSection('powerManager', function() {
        for (const roomName in Game.rooms) {
          if (Game.rooms[roomName].controller && Game.rooms[roomName].controller.my) {
            powerManager.run(roomName);
          }
        }
      });

      profileSection('depositObserver.run', function() { depositObserver.run(); });
      profileSection('nukeLaunch.run', function() { nukeLaunch.run(); });

      profileSection('labManager', function() {
        for (const roomName in Game.rooms) {
          const room = Game.rooms[roomName];
          if (!room.controller || !room.controller.my) continue;
          labManager.run(roomName);
        }
      });

      if (Game.time % 3 === 0) profileSection('boostManager.run', function() { boostManager.run(); });

      if (Game.time % 10 === 0) {
        profileSection('spawnManager.run', function() {
          spawnManager.run(perRoomRoleCounts, getRoomState);
        });
      }

      // --- CREEP ACTIONS ---
      profileSection('runCreeps', runCreeps);
      profileSection('creepProfiler.run', function() { creepProfiler.run(); });
      profileSection('creepProfiler.report', function() { creepProfiler.report(); });
      profileSection('trackCPUUsage', trackCPUUsage);
      profileSection('localMap.run', function() { localMap.run(); });

      if (Game.time % 1050 === 0) {
        profileSection('autoEnergyBuyer', function() { autoEnergyBuyer.run(); });
      }
      taskScheduler.run();
      // --- STATUS DISPLAY ---
      if (Game.time % 100 === 0) {
        profileSection('statusReport', function() { statusReport.run(perRoomRoleCounts); });
        if (ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
          for (const key in Memory.cpuProfile) {
            const avg = Memory.cpuProfile[key].reduce(function(a, b) { return a + b; }, 0) / Memory.cpuProfile[key].length;
            console.log('CPU Profile: ' + key + ' avg: ' + Math.round(avg));
          }
        }
      }

      drawCpuHud();

      if ((Game.time % 10 === 0) && (sectionsThrottled > 0 || creepsThrottled > 0)) {
        console.log('[CPU] Throttled: ' + sectionsThrottled + ' sections, '
          + creepsThrottled + ' creeps | Pressure: '
          + Math.round(getLivePressureCached() * 100) + '% (base '
          + Math.round(tickPressure * 100) + '%) | Used: '
          + Game.cpu.getUsed().toFixed(1) + '/' + tickBudget.toFixed(1)
          + ' | Bucket: ' + Game.cpu.bucket);
      }
    });
  } catch (e) {
    handleError('mainLoop', e);
  }
};
