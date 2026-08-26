// LLM: Read docs/codex.js before reviewing or changing this file.
// main.js
const profiler = require("screeps-profiler");
const memoryManager = require("memoryManager");
const heap = memoryManager.heap;
const creepProfiler = require("creepProfiler");
const taskScheduler = require("taskScheduler");
const cpuSchedulerPolicy = require("cpuSchedulerPolicy");
profiler.enable();
const ENABLE_CPU_LOGGING = false;
const DISABLE_CPU_CONSOLE = true;
const CPU_HUD_REFRESH_TICKS = 1;
const roadBuilder = require("roadBuilder");
const scanner = require("scanner");
const simscanQuery = require("simscanQuery");
const CPU_SAFETY_BUFFERS = {
  CRITICAL: 7,
  LOW: 3,
  NORMAL: 1,
  FLUSH: .1
};
const BUCKET_REFILL_TARGET = 8e3;
const FLUSH_BURST_LIMIT_RATIO = .5;
const SECTION_TIER = {
  CRITICAL: 3,
  HIGH: 2,
  NORMAL: 1,
  LOW: 0
};
const SECTION_TIERS = {
  runCreeps: SECTION_TIER.CRITICAL,
  "towerManager.run": SECTION_TIER.CRITICAL,
  "defenseMonitor.run": SECTION_TIER.CRITICAL,
  "getRoomState.init": SECTION_TIER.CRITICAL,
  "linkManager.run": SECTION_TIER.HIGH,
  terminalManager: SECTION_TIER.HIGH,
  labManager: SECTION_TIER.HIGH,
  "boostManager.run": SECTION_TIER.HIGH,
  "repairManager.run": SECTION_TIER.HIGH,
  "spawnManager.run": SECTION_TIER.CRITICAL,
  factoryManager: SECTION_TIER.NORMAL,
  roleTowerDrain: SECTION_TIER.HIGH,
  roleContestedDemolisher: SECTION_TIER.HIGH,
  "depositObserver.run": SECTION_TIER.NORMAL,
  "nukeLaunch.run": SECTION_TIER.NORMAL,
  "roleNukeFill.runAuto": SECTION_TIER.LOW,
  "roleNukeFill.consolidateCompletedOrders": SECTION_TIER.LOW,
  "roleSignbot.permanentSignCheck": SECTION_TIER.LOW,
  "claimbotRangeCheck.run": SECTION_TIER.LOW,
  "autoBuilder.run": SECTION_TIER.HIGH,
  "remoteSupplyManager.run": SECTION_TIER.NORMAL,
  roomBalance: SECTION_TIER.HIGH,
  autoEnergyBuyer: SECTION_TIER.HIGH,
  "energyManager.run": SECTION_TIER.LOW,
  marketUpdater: SECTION_TIER.LOW,
  "marketRefine.run": SECTION_TIER.LOW,
  "localRefine.run": SECTION_TIER.LOW,
  "stockpileManager.run": SECTION_TIER.LOW,
  "marketLab.run": SECTION_TIER.LOW,
  "marketBatchBuy.run": SECTION_TIER.LOW,
  "marketBuyer.run": SECTION_TIER.LOW,
  "marketSeller.run": SECTION_TIER.LOW,
  opportunisticBuy: SECTION_TIER.LOW,
  opportunisticSell: SECTION_TIER.LOW,
  "autoTrader.minerals": SECTION_TIER.NORMAL,
  "autoTrader.residue": SECTION_TIER.NORMAL,
  "autoTrader.run": SECTION_TIER.NORMAL,
  dailyFinance: SECTION_TIER.LOW,
  inventory: SECTION_TIER.LOW,
  "marketArbitrage.serviceActive": SECTION_TIER.HIGH,
  "marketArbitrage.scan": SECTION_TIER.LOW,
  "marketPriceAdjustment.run": SECTION_TIER.HIGH,
  "localMap.run": SECTION_TIER.LOW,
  statusReport: SECTION_TIER.NORMAL,
  "creepProfiler.run": SECTION_TIER.LOW,
  "creepProfiler.report": SECTION_TIER.LOW
};
const CREEP_PRIORITY = {
  harvester: 17,
  upgrader: 20,
  builder: 3,
  defender: 4,
  towerFiller: 2,
  staticDistributor: 5,
  supplier: 1,
  wallRepair: 20,
  repairer: 20,
  attacker: 1,
  harasser: 1,
  healer: 1,
  claimbot: 1,
  mineralCollector: 10,
  extractor: 10,
  depositHarvester: 10,
  powerBot: 20,
  maintainer: 2,
  rampartBot: 20,
  labBot: 17,
  remoteBuilder: 14,
  hd: 3,
  comboBot: 3,
  skAttacker: 3,
  signbot: 23,
  contestedDemolisher: 1,
  drainDemolisher: 1,
  nukeFill: 6,
  towerDrain: 1,
  demolition: 1,
  quad: 1,
  terminalBot: 5,
  defenseRepair: 4,
  scout: 27,
  thief: 15,
  scavenger: 15,
  default: 99,
  remoteSupplier: 5,
  controllerAttacker: 2,
  extractorAssistant: 20
};
const CREEP_THROTTLE_BANDS = [ {
  maxPriority: 5,
  maxInterval: 1
}, {
  maxPriority: 10,
  maxInterval: 2
}, {
  maxPriority: 15,
  maxInterval: 3
}, {
  maxPriority: 25,
  maxInterval: 4
}, {
  maxPriority: 99,
  maxInterval: 5
} ];
const SECTION_MAX_INTERVAL = {
  [SECTION_TIER.CRITICAL]: 1,
  [SECTION_TIER.HIGH]: 2,
  [SECTION_TIER.NORMAL]: 3,
  [SECTION_TIER.LOW]: 5
};
const SECTION_CPU_TARGET_RATIOS = {
  [SECTION_TIER.HIGH]: .15,
  [SECTION_TIER.NORMAL]: .075,
  [SECTION_TIER.LOW]: .04
};
const SECTION_COST_MAX_INTERVAL = {
  [SECTION_TIER.HIGH]: 2,
  [SECTION_TIER.NORMAL]: 5,
  [SECTION_TIER.LOW]: 10
};
const SECTION_BUDGET_START_RATIOS = {
  [SECTION_TIER.HIGH]: .9,
  [SECTION_TIER.NORMAL]: .8,
  [SECTION_TIER.LOW]: .7
};
const SECTION_MAX_BUDGET_DEFERRAL = {
  [SECTION_TIER.HIGH]: 2,
  [SECTION_TIER.NORMAL]: 5,
  [SECTION_TIER.LOW]: 10
};
const SECTION_HARD_MAX_DEFERRAL = {
  [SECTION_TIER.HIGH]: 10,
  [SECTION_TIER.NORMAL]: 25,
  [SECTION_TIER.LOW]: 50
};
const SECTION_BUCKET_BURSTS = {
  "autoTrader.run": {
    minBucket: 3e3,
    minDeferral: 25,
    maxBucketSpend: 100
  },
  "autoTrader.minerals": {
    minBucket: 3e3,
    minDeferral: 25,
    maxBucketSpend: 200
  },
  "autoTrader.residue": {
    minBucket: 3e3,
    minDeferral: 25,
    maxBucketSpend: 100
  }
};
const SECTION_CPU_SLICES = {
  "marketRefine.run": 2,
  "marketLab.run": 2
};
const SECTION_COST_EWMA_ALPHA = .25;
const SECTION_COST_PEAK_DECAY = .8;
// A legacy stat may not have an effective interval. Keep its decay conservative
// rather than treating the per-run factor as a per-tick factor.
const SECTION_COST_PEAK_DECAY_FALLBACK_INTERVAL = 50;
const PRE_CRITICAL_ALWAYS_RESERVE_RATIO = .15;
const CPU_BURST_MIN_BUCKET_BEFORE = 1e3;
const CPU_BURST_MIN_BUCKET_AFTER = 3e3;
const DEFERRED_SECTION_TAIL_RESERVE = 1;
const CRITICAL_SECTION_CPU_FLOORS = {
  "getRoomState.init": 1,
  "defenseMonitor.run": 1,
  "towerManager.run": 1,
  "spawnManager.run": 1,
  runCreeps: 4
};
require("marketQuery");
require("marketChaosQuery");
require("marketConditions");
require("marketAnalysis");
const roleHarvester = require("roleHarvester");
const roleUpgrader = require("roleUpgrader");
const roleBuilder = require("roleBuilder");
const roleScout = require("roleScout");
const roleDefender = require("roleDefender");
const roleSupplier = require("roleSupplier");
const roleClaimbot = require("roleClaimbot");
const roleAttacker = require("roleAttacker");
const roleHarasser = require("roleHarasser");
const roleHealer = require("roleHealer");
const roleExtractor = require("roleExtractor");
const iff = require("iff");
const roleThief = require("roleThief");
const roleScavenger = require("roleScavenger");
const scavengerPolicy = require("scavengerPolicy");
const scavengerLearning = require("scavengerLearning");
const roleSquad = require("roleSquad");
const roleTowerDrain = require("roleTowerDrain");
const roleDemolition = require("roleDemolition");
const roleMineralCollector = require("roleMineralCollector");
const terminalManager = require("terminalManager");
const roleSignbot = require("roleSignbot");
const factoryManager = require("factoryManager");
const labManager = require("labManager");
const roleLabBot = require("roleLabBot");
const roomBalance = require("roomBalance");
const getRoomState = require("getRoomState");
const towerManager = require("towerManager");
const linkManager = require("linkManager");
const marketSeller = require("marketSell");
const marketBuyer = require("marketBuy");
const marketUpdater = require("marketUpdate");
const opportunisticBuy = require("opportunisticBuy");
const marketRefine = require("marketRefine");
const localRefine = require("localRefine");
const marketLab = require("marketLab");
const stockpileManager = require("stockpileManager");
const marketBatchBuy = require("marketBatchBuy");
const roleNukeFill = require("roleNukeFill");
const nukeLaunch = require("nukeLaunch");
const marketRoomOrders = require("marketRoomOrders");
const roleRemoteBuilder = require("roleRemoteBuilder");
const depositObserver = require("depositObserver");
const roleDepositHarvester = require("roleDepositHarvester");
const rolePowerBot = require("rolePowerBot");
const powerManager = require("powerManager");
const roleOperator = require("roleOperator");
const marketReport = require("marketReport");
const roleMaintainer = require("roleMaintainer");
const roleContestedDemolisher = require("roleContestedDemolisher");
const roleDrainDemolisher = require("roleDrainDemolisher");
const autoEnergyBuyer = require("autoEnergyBuyer");
const autoTrader = require("autoTrader");
const roomNavigation = require("roomNavigation");
const memoryQuery = require("memoryQuery");
const dailyFinance = require("dailyFinance");
const economics = require("economics");
const inventory = require("inventory");
const marketAttribution = require("marketAttribution");
const marketSpendGuard = require("marketSpendGuard");
const marketEconomics = require("marketEconomics");
const marketPricing = require("marketPricing");
const marketArbitrage = require("marketArbitrage");
const marketSpeculator = require("marketSpeculator");
const marketPriceAdjustment = require("marketPriceAdjustment");
const roleSKAttacker = require("roleSKAttacker");
const defenseMonitor = require("defenseMonitor");
const singleSourceRoom = require("singleSourceRoom");
const roleHD = require("roleHD");
const roleStaticDistributor = require("roleStaticDistributor");
const roleComboBot = require("roleComboBot");
const opportunisticSell = require("opportunisticSell");
const statusReport = require("statusReport");
const storageManager = require("storageManager");
const boostManager = require("boostManager");
const roomCPUProfiler = require("roomCPUProfiler");
const roomSuspender = require("roomSuspender");
const localMap = require("localMap");
const spawnManager = require("spawnManager");
const remoteSupplyManager = require("remoteSupplyManager");
const roleRemoteSupplier = require("roleRemoteSupplier");
const roleControllerAttacker = require("roleControllerAttacker");
const roleExtractorAssistant = require("roleExtractorAssistant");
const claimbotRangeCheck = require("claimbotRangeCheck");
const roleTowerFiller = require("roleTowerFiller");
const repairManager = require("repairManager");
const roleRepairer = require("roleRepairer");
const energyManager = require("energyManager");
const autoBuilder = require("autoBuilder");
require("cpuQuery");
require("consoleQuery");
const compliance = require("compliance");
require("storageBuckets");
require("marketMap");
statusReport.init(ENABLE_CPU_LOGGING, DISABLE_CPU_CONSOLE);
profiler.registerObject(scanner, "scanner");
profiler.registerObject(roleHarvester, "roleHarvester");
profiler.registerObject(roleUpgrader, "roleUpgrader");
profiler.registerObject(roleTowerFiller, "roleTowerFiller");
profiler.registerObject(roleBuilder, "roleBuilder");
profiler.registerObject(roleScout, "roleScout");
profiler.registerObject(roleDefender, "roleDefender");
profiler.registerObject(roleSupplier, "roleSupplier");
profiler.registerObject(roleClaimbot, "roleClaimbot");
profiler.registerObject(roleAttacker, "roleAttacker");
profiler.registerObject(roleHealer, "roleHealer");
profiler.registerObject(roleExtractor, "roleExtractor");
profiler.registerObject(iff, "iff");
profiler.registerObject(roleThief, "roleThief");
profiler.registerObject(roleScavenger, "roleScavenger");
profiler.registerObject(scavengerPolicy, "scavengerPolicy");
profiler.registerObject(scavengerLearning, "scavengerLearning");
profiler.registerObject(roleSquad, "roleSquad");
profiler.registerObject(roleTowerDrain, "roleTowerDrain");
profiler.registerObject(roleDemolition, "roleDemolition");
profiler.registerObject(roleMineralCollector, "roleMineralCollector");
profiler.registerObject(roleSignbot, "roleSignbot");
profiler.registerObject(factoryManager, "factoryManager");
profiler.registerObject(labManager, "labManager");
profiler.registerObject(roleLabBot, "roleLabBot");
profiler.registerObject(roomBalance, "roomBalance");
profiler.registerObject(getRoomState, "getRoomState");
profiler.registerObject(towerManager, "towerManager");
profiler.registerObject(linkManager, "linkManager");
profiler.registerObject(spawnManager, "spawnManager");
profiler.registerObject(marketUpdater, "marketUpdater");
profiler.registerObject(opportunisticBuy, "opportunisticBuy");
profiler.registerObject(marketRefine, "marketRefine");
profiler.registerObject(localRefine, "localRefine");
profiler.registerObject(marketLab, "marketLab");
profiler.registerObject(marketBatchBuy, "marketBatchBuy");
profiler.registerObject(roleNukeFill, "roleNukeFill");
profiler.registerObject(nukeLaunch, "nukeLaunch");
profiler.registerObject(marketRoomOrders, "marketRoomOrders");
profiler.registerObject(roleRemoteBuilder, "roleRemoteBuilder");
profiler.registerObject(roleDepositHarvester, "roleDepositHarvester");
profiler.registerObject(depositObserver, "depositObserver");
profiler.registerObject(rolePowerBot, "rolePowerBot");
profiler.registerObject(powerManager, "powerManager");
profiler.registerObject(roleOperator, "roleOperator");
profiler.registerObject(roleMaintainer, "roleMaintainer");
profiler.registerObject(roleContestedDemolisher, "roleContestedDemolisher");
profiler.registerObject(roleDrainDemolisher, "roleDrainDemolisher");
profiler.registerObject(autoEnergyBuyer, "autoEnergyBuyer");
profiler.registerObject(autoTrader, "autoTrader");
profiler.registerObject(roomNavigation, "roomNavigation");
profiler.registerObject(dailyFinance, "dailyFinance");
profiler.registerObject(inventory, "inventory");
profiler.registerObject(marketPricing, "marketPricing");
profiler.registerObject(marketArbitrage, "marketArbitrage");
profiler.registerObject(marketSpeculator, "marketSpeculator");
profiler.registerObject(marketPriceAdjustment, "marketPriceAdjustment");
profiler.registerObject(roleSKAttacker, "roleSKAttacker");
profiler.registerObject(defenseMonitor, "defenseMonitor");
profiler.registerObject(singleSourceRoom, "singleSourceRoom");
profiler.registerObject(roleHD, "roleHD");
profiler.registerObject(roleStaticDistributor, "roleStaticDistributor");
profiler.registerObject(roleComboBot, "roleComboBot");
profiler.registerObject(creepProfiler, "creepProfiler");
profiler.registerObject(opportunisticSell, "opportunisticSell");
profiler.registerObject(statusReport, "statusReport");
profiler.registerObject(storageManager, "storageManager");
profiler.registerObject(boostManager, "boostManager");
profiler.registerObject(roomCPUProfiler, "roomCPUProfiler");
profiler.registerObject(remoteSupplyManager, "remoteSupplyManager");
profiler.registerObject(roleRemoteSupplier, "roleRemoteSupplier");
profiler.registerObject(roleControllerAttacker, "roleControllerAttacker");
profiler.registerObject(roleExtractorAssistant, "roleExtractorAssistant");
profiler.registerObject(claimbotRangeCheck, "claimbotRangeCheck");
profiler.registerObject(repairManager, "repairManager");
profiler.registerObject(roleRepairer, "roleRepairer");
profiler.registerObject(energyManager, "energyManager");
profiler.registerObject(autoBuilder, "autoBuilder");
let tickBudget = 0;
let tickCpuLimit = 0; // Account baseline used for policy budgets.
let tickExecutionLimit = 0; // Current-tick ceiling including bucket CPU.
let tickSerializationCost = 0;
let tickSerializationHitRate = 0;
let tickSafetyBuffer = CPU_SAFETY_BUFFERS.NORMAL;
let tickBudgetTier = "NORMAL";
let tickPressure = 0;
let sectionsThrottled = 0;
let sectionsDeferred = 0;
let sectionsCostThrottled = 0;
let sectionsBudgetDeferred = 0;
let sectionsBudgetLateRun = 0;
let sectionsBudgetBurstRun = 0;
let creepsThrottled = 0;
let creepsSuspended = 0;
let tickSectionCpu = {};
let tickCriticalReserve = 0;
let tickCriticalSectionReserve = {};
let tickDeferredSections = [];
const SECTION_NAME_HASHES = {};
for (const e in SECTION_TIERS) {
  SECTION_NAME_HASHES[e] = e.length + e.charCodeAt(0) + (e.charCodeAt(e.length - 1) || 0);
}
function nameHash(e) {
  if (SECTION_NAME_HASHES[e] !== undefined) {
    return SECTION_NAME_HASHES[e];
  }
  return e.length + e.charCodeAt(0) + (e.charCodeAt(e.length - 1) || 0);
}

function getLivePressure() {
  if (tickBudget <= 0) return 1;
  const e = Game.cpu.getUsed() / tickBudget;
  if (e < .7) return tickPressure;
  const r = (e - .7) / .3;
  if (tickBudgetTier === "FLUSH") return 0;
  return Math.min(1, Math.max(tickPressure, r));
}

function updateTickBudgetForSave() {
  const e = memoryManager.getSerializationReserveStats();
  const r = e.amortizedCpu;
  const t = Math.max(0, tickCpuLimit - r - tickSafetyBuffer);
  tickBudget = t;
  tickSerializationCost = r;
  tickSerializationHitRate = e.hitRate;
}

function calcTickBudget() {
  const e = Game.cpu.bucket;
  tickCpuLimit = Game.cpu.limit;
  tickExecutionLimit = typeof Game.cpu.tickLimit === "number" ? Math.max(tickCpuLimit, Game.cpu.tickLimit) : tickCpuLimit;
  if (e < 1e3) {
    tickBudgetTier = "CRITICAL";
    tickPressure = 1;
  } else if (e < 3e3) {
    tickBudgetTier = "LOW";
    tickPressure = 1 - (e - 1e3) / 2e3;
  } else if (e < BUCKET_REFILL_TARGET) {
    tickBudgetTier = "NORMAL";
    tickPressure = 0;
  } else {
    tickBudgetTier = "FLUSH";
    tickPressure = 0;
  }
  tickSafetyBuffer = CPU_SAFETY_BUFFERS[tickBudgetTier];
  updateTickBudgetForSave();
  sectionsThrottled = 0;
  sectionsDeferred = 0;
  sectionsCostThrottled = 0;
  sectionsBudgetDeferred = 0;
  sectionsBudgetLateRun = 0;
  sectionsBudgetBurstRun = 0;
  creepsThrottled = 0;
  creepsSuspended = 0;
  tickSectionCpu = {};
  tickCriticalReserve = 0;
  tickCriticalSectionReserve = {};
  tickDeferredSections = [];
  for (const e in CRITICAL_SECTION_CPU_FLOORS) {
    const r = heap.cpuSectionStats && heap.cpuSectionStats[e];
    const t = Math.max(CRITICAL_SECTION_CPU_FLOORS[e], estimateSectionCost(r));
    tickCriticalSectionReserve[e] = t;
    tickCriticalReserve += t;
  }
  const r = tickCpuLimit * PRE_CRITICAL_ALWAYS_RESERVE_RATIO;
  tickCriticalSectionReserve.__preCriticalAlways = r;
  tickCriticalReserve += r;
}

function getSectionInterval(e) {
  const r = getLivePressure();
  if (r <= 0) return 1;
  const t = SECTION_MAX_INTERVAL[e] || 1;
  return Math.max(1, Math.ceil(r * t));
}

function getSectionCostStats(e) {
  if (!heap.cpuSectionStats) heap.cpuSectionStats = {};
  if (!heap.cpuSectionStats[e]) {
    heap.cpuSectionStats[e] = {
      runs: 0,
      average: 0,
      peak: 0,
      last: 0,
      lastRun: null,
      firstDue: null,
      pendingSince: null,
      budgetDeferrals: 0,
      costThrottles: 0
    };
  }
  return heap.cpuSectionStats[e];
}

function estimateSectionCost(e) {
  return cpuSchedulerPolicy.estimateSectionCost(e, Game.time, SECTION_COST_PEAK_DECAY, SECTION_COST_PEAK_DECAY_FALLBACK_INTERVAL);
}

function estimateSectionBudgetCost(e, r) {
  const t = estimateSectionCost(r);
  if (t > 0) return t;
  const o = SECTION_CPU_TARGET_RATIOS[e] || 0;
  return tickCpuLimit * o;
}

function getSectionCostInterval(e, r) {
  if (e === SECTION_TIER.CRITICAL) return 1;
  const t = SECTION_CPU_TARGET_RATIOS[e];
  const o = SECTION_COST_MAX_INTERVAL[e] || 1;
  const i = estimateSectionCost(r);
  if (!(t > 0) || !(i > 0) || !(tickCpuLimit > 0)) return 1;
  const n = tickCpuLimit * t;
  return Math.min(o, Math.max(1, Math.ceil(i / n)));
}

function canRunBucketBurst(e, r, t, o, i) {
  const n = SECTION_BUCKET_BURSTS[e];
  if (!n || !r || r.pendingSince === null) return false;
  if (Game.time - r.pendingSince < n.minDeferral) return false;
  const a = Math.max(0, o + DEFERRED_SECTION_TAIL_RESERVE - i);
  return t > 0 && a <= n.maxBucketSpend && cpuSchedulerPolicy.canUseBucketBurst({
    currentBucket: Game.cpu.bucket,
    accountLimit: tickCpuLimit,
    executionLimit: tickExecutionLimit,
    projectedCpu: o,
    tailReserve: DEFERRED_SECTION_TAIL_RESERVE,
    minBucket: n.minBucket,
    minBucketAfter: CPU_BURST_MIN_BUCKET_AFTER,
    maxBucketSpend: n.maxBucketSpend
  });
}

function shouldDeferSectionForBudget(e, r, t) {
  if (r === SECTION_TIER.CRITICAL) return false;
  const o = estimateSectionBudgetCost(r, t);
  const i = SECTION_BUDGET_START_RATIOS[r];
  if (!(o > 0) || !(i > 0)) return false;
  const n = Game.cpu.getUsed() + o;
  const a = Math.max(0, tickBudget - tickCriticalReserve);
  const c = tickBudgetTier === "FLUSH" ? a : Math.min(tickBudget * i, a);
  if (n <= c) return false;
  if (canRunBucketBurst(e, t, o, n, a)) return false;
  const s = SECTION_MAX_BUDGET_DEFERRAL[r] || 1;
  if (t.pendingSince !== null && Game.time - t.pendingSince >= s && n <= a) return false;
  if (t.pendingSince === null) t.pendingSince = Game.time;
  t.budgetDeferrals = (t.budgetDeferrals || 0) + 1;
  return true;
}

function releaseCriticalReserve(e) {
  const r = tickCriticalSectionReserve[e] || 0;
  if (!(r > 0)) return;
  tickCriticalReserve = Math.max(0, tickCriticalReserve - r);
  delete tickCriticalSectionReserve[e];
  if (e === "runCreeps") {
    const e = tickCriticalSectionReserve.__preCriticalAlways || 0;
    tickCriticalReserve = Math.max(0, tickCriticalReserve - e);
    delete tickCriticalSectionReserve.__preCriticalAlways;
  }
}

function recordSectionCost(e, r, t, o) {
  if (e.runs > 0) {
    e.average += (r - e.average) * SECTION_COST_EWMA_ALPHA;
    e.peak = Math.max(r, cpuSchedulerPolicy.getDecayedPeak(e, Game.time, SECTION_COST_PEAK_DECAY, SECTION_COST_PEAK_DECAY_FALLBACK_INTERVAL));
  } else {
    e.average = r;
    e.peak = r;
  }
  e.runs++;
  e.last = r;
  e.lastRun = Game.time;
  e.firstDue = null;
  e.pendingSince = null;
  e.tier = t;
  e.effectiveInterval = o;
}

function executeProfileSection(e, r, t, o, i) {
  if (o === SECTION_TIER.CRITICAL) releaseCriticalReserve(e);
  const n = Game.cpu.getUsed();
  try {
    r(SECTION_CPU_SLICES[e]);
  } catch (r) {
    handleError(e, r);
  } finally {
    const r = Game.cpu.getUsed() - n;
    recordSectionCost(t, r, o, i);
    tickSectionCpu[e] = (tickSectionCpu[e] || 0) + r;
    if (ENABLE_CPU_LOGGING) {
      if (!heap.cpuProfile[e]) heap.cpuProfile[e] = [];
      heap.cpuProfile[e].push(r);
      if (heap.cpuProfile[e].length > 50) heap.cpuProfile[e].shift();
      if (!heap.cpuProfileLastUsed) heap.cpuProfileLastUsed = {};
      heap.cpuProfileLastUsed[e] = Game.time;
    }
  }
}

function runDeferredSections() {
  if (tickDeferredSections.length === 0) return;
  tickDeferredSections.sort(function(e, r) {
    const t = e.stats.pendingSince === null ? Game.time : e.stats.pendingSince;
    const o = r.stats.pendingSince === null ? Game.time : r.stats.pendingSince;
    return t - o;
  });
  const e = Math.max(0, Game.cpu.bucket - BUCKET_REFILL_TARGET);
  const r = tickBudget + Math.min(tickCpuLimit * FLUSH_BURST_LIMIT_RATIO, e);
  let t = false;
  for (let e = 0; e < tickDeferredSections.length; e++) {
    const o = tickDeferredSections[e];
    if (!o.stats || o.stats.lastRun === Game.time || o.stats.pendingSince === null) continue;
    const i = estimateSectionBudgetCost(o.sectionTier, o.stats);
    const n = Game.cpu.getUsed() + i;
    const d = n + DEFERRED_SECTION_TAIL_RESERVE;
    const a = n <= tickBudget;
    const c = !t && tickBudgetTier === "FLUSH" && d <= r && cpuSchedulerPolicy.canUseBucketBurst({
      currentBucket: Game.cpu.bucket,
      accountLimit: tickCpuLimit,
      executionLimit: tickExecutionLimit,
      projectedCpu: n,
      tailReserve: DEFERRED_SECTION_TAIL_RESERVE,
      minBucket: CPU_BURST_MIN_BUCKET_BEFORE,
      minBucketAfter: CPU_BURST_MIN_BUCKET_AFTER
    });
    const s = Game.time - o.stats.pendingSince;
    const l = SECTION_HARD_MAX_DEFERRAL[o.sectionTier] || 50;
    const u = d <= tickExecutionLimit;
    const p = !t && u && tickBudgetTier !== "CRITICAL" && s >= l && cpuSchedulerPolicy.canUseBucketBurst({
      currentBucket: Game.cpu.bucket,
      accountLimit: tickCpuLimit,
      executionLimit: tickExecutionLimit,
      projectedCpu: n,
      tailReserve: DEFERRED_SECTION_TAIL_RESERVE,
      minBucket: CPU_BURST_MIN_BUCKET_BEFORE,
      minBucketAfter: CPU_BURST_MIN_BUCKET_AFTER
    });
    const f = !t && canRunBucketBurst(o.name, o.stats, i, n, Math.max(0, tickBudget - tickCriticalReserve));
    if (!a && !c && !p && !f) continue;
    executeProfileSection(o.name, o.fn, o.stats, o.sectionTier, o.effectiveInterval);
    sectionsBudgetLateRun++;
    sectionsThrottled = Math.max(0, sectionsThrottled - 1);
    if (!a) {
      t = true;
      if (c || p || f) sectionsBudgetBurstRun++;
    }
  }
}

function getCreepInterval(e) {
  const r = getLivePressure();
  if (r <= 0) return 1;
  let t = 5;
  for (const r of CREEP_THROTTLE_BANDS) {
    if (e <= r.maxPriority) {
      t = r.maxInterval;
      break;
    }
  }
  if (t <= 1) return 1;
  return Math.max(1, Math.ceil(r * t));
}

function handleError(e, r) {
  console.log("ERROR IN " + e + ": " + r.stack);
  Game.notify("ERROR IN " + e + ": " + r.message);
  memoryManager.storage.update("errors", function(t) {
    const o = Array.isArray(t) ? t : [];
    o.push({
      tick: Game.time,
      section: e,
      error: r.toString(),
      timestamp: Date.now()
    });
    while (o.length > 10) o.shift();
    return o;
  });
}

function onCreepDeath(e, r) {
  if (r.role === "scout") {
    roleScout.handleCreepDeath(e, r);
  }
  if (r.role === "scavenger" && r.scavengerPolicy && r.scavengerPolicy.learningEligible) {
    scavengerLearning.finalizeCreepMemory(r, "creep-death");
  }
  if (r.role === "claimbot" && typeof roleClaimbot.clearCreepCache === "function") {
    roleClaimbot.clearCreepCache(e);
  }
  if (r.role === "towerDrain" && r.variant === "drainDemolisher" && typeof r.lastTTL === "number" && r.lastTTL > 9) {
    const t = "[DrainDemolisher] Worker " + e + " died with " + r.lastTTL + " TTL in " + (r.lastRoom || "unknown room") + " (target " + r.targetRoom + ")";
    console.log(t);
    Game.notify(t);
  }
  if (r.role === "demolition" && Array.isArray(Memory.demolitionOrders)) {
    const e = Memory.demolitionOrders.findIndex(function(e) {
      return e.targetRoom === r.targetRoom && e.homeRoom === r.homeRoom;
    });
    if (e > -1 && r.demolitionRole === "demolisher") {
      console.log("[Demolition] A demolisher for operation against " + r.targetRoom + " has died. Keeping operation active for respawn.");
    }
  }
}

function cleanMemory() {
  let e = false;
  if (!Memory.thiefOrders) {
    Memory.thiefOrders = [];
    e = true;
  }
  if (!Memory.demolitionOrders) {
    Memory.demolitionOrders = [];
    e = true;
  }
  if (Memory.remoteMaintainerOrders) {
    delete Memory.remoteMaintainerOrders;
    e = true;
  }
  if (Memory.remoteMaintainerView) {
    delete Memory.remoteMaintainerView;
    e = true;
  }
  const r = [ "lastEnergyProfile", "scoutIntel", "localMapResults", "roomIntel", "roomState", "cpuStats", "cpuProfile", "cpuProfileLastUsed", "cpuProfileCreeps", "roomEffProfile" ];
  for (let t = 0; t < r.length; t++) {
    const o = r[t];
    if (Memory[o] !== undefined) {
      delete Memory[o];
      e = true;
    }
  }
  return e;
}

function trackCPUUsage() {
  if (!heap.cpuStats) {
    heap.cpuStats = {
      history: [],
      average: 0,
      snapshots: []
    };
  }
  const e = Game.cpu.getUsed();
  const r = getLivePressure();
  heap.cpuStats.history.push(e);
  if (heap.cpuStats.history.length > 50) heap.cpuStats.history.shift();
  heap.cpuStats.average = heap.cpuStats.history.reduce(function(e, r) {
    return e + r;
  }, 0) / heap.cpuStats.history.length;
  heap.cpuStats.lastBudgetTier = tickBudgetTier;
  heap.cpuStats.lastBudget = tickBudget;
  heap.cpuStats.lastCpuLimit = tickCpuLimit;
  heap.cpuStats.lastTickLimit = tickExecutionLimit;
  heap.cpuStats.lastSerializationCost = tickSerializationCost;
  heap.cpuStats.lastSerializationHitRate = tickSerializationHitRate;
  heap.cpuStats.lastSafetyBuffer = tickSafetyBuffer;
  heap.cpuStats.lastWillSave = memoryManager.willSave();
  heap.cpuStats.memorySaves = memoryManager.getSaveStats();
  heap.cpuStats.lastPressure = Math.round(r * 100);
  heap.cpuStats.lastBasePressure = Math.round(tickPressure * 100);
  heap.cpuStats.lastSectionsThrottled = sectionsThrottled;
  heap.cpuStats.lastSectionsDeferred = sectionsDeferred;
  heap.cpuStats.lastSectionsCostThrottled = sectionsCostThrottled;
  heap.cpuStats.lastSectionsBudgetDeferred = sectionsBudgetDeferred;
  heap.cpuStats.lastSectionsBudgetLateRun = sectionsBudgetLateRun;
  heap.cpuStats.lastSectionsBudgetBurstRun = sectionsBudgetBurstRun;
  heap.cpuStats.lastSectionsBudgetPending = sectionsBudgetDeferred - sectionsBudgetLateRun;
  heap.cpuStats.lastCreepsThrottled = creepsThrottled;
  heap.cpuStats.bucket = Game.cpu.bucket;
  if (Game.time % 5 === 0) {
    if (!heap.cpuStats.snapshots) heap.cpuStats.snapshots = [];
    heap.cpuStats.snapshots.push({
      t: Game.time,
      cpu: Math.round(e * 10) / 10,
      bkt: Game.cpu.bucket,
      psi: Math.round(r * 100),
      bPsi: Math.round(tickPressure * 100),
      bud: Math.round(tickBudget * 10) / 10,
      tier: tickBudgetTier.charAt(0),
      tSec: sectionsThrottled,
      dSec: sectionsDeferred,
      cSec: sectionsCostThrottled,
      bSec: sectionsBudgetDeferred,
      bRun: sectionsBudgetLateRun,
      bBurst: sectionsBudgetBurstRun,
      bPend: sectionsBudgetDeferred - sectionsBudgetLateRun,
      tCrp: creepsThrottled
    });
    if (heap.cpuStats.snapshots.length > 50) heap.cpuStats.snapshots.shift();
  }
}

function drawCpuHud() {
  if (!Memory.cpuHudRoom) return;
  const e = Game.rooms[Memory.cpuHudRoom];
  if (!e) return;
  const r = e.visual;
  const t = Game.cpu.getUsed();
  const o = tickBudget;
  const i = Game.cpu.bucket;
  const n = getLivePressure();
  r.rect(0, 0, 12, 5.8, {
    fill: "#000000",
    opacity: .7,
    stroke: "#333333"
  });
  r.text("CPU SCHEDULER", 6, .55, {
    color: "#ffffff",
    font: "bold 0.55 monospace",
    align: "center"
  });
  var a = Math.min(t / tickCpuLimit, 1);
  var c = a > .9 ? "#ff4444" : a > .7 ? "#ffaa00" : "#44ff44";
  r.text("CPU", .3, 1.45, {
    color: "#aaaaaa",
    font: "0.4 monospace",
    align: "left"
  });
  r.rect(2.2, 1.1, 8, .5, {
    fill: "#333333",
    opacity: .8
  });
  r.rect(2.2, 1.1, 8 * a, .5, {
    fill: c,
    opacity: .9
  });
  r.text(t.toFixed(1) + "/" + o.toFixed(1), 10.5, 1.45, {
    color: "#ffffff",
    font: "0.35 monospace",
    align: "left"
  });
  var s = i / 1e4;
  var l = s < .1 ? "#ff4444" : s < .3 ? "#ffaa00" : "#4488ff";
  r.text("BKT", .3, 2.15, {
    color: "#aaaaaa",
    font: "0.4 monospace",
    align: "left"
  });
  r.rect(2.2, 1.8, 8, .5, {
    fill: "#333333",
    opacity: .8
  });
  r.rect(2.2, 1.8, 8 * s, .5, {
    fill: l,
    opacity: .9
  });
  r.text(i.toString(), 10.5, 2.15, {
    color: "#ffffff",
    font: "0.35 monospace",
    align: "left"
  });
  var u = n > .7 ? "#ff4444" : n > .3 ? "#ffaa00" : "#44ff44";
  r.text("PSI", .3, 2.85, {
    color: "#aaaaaa",
    font: "0.4 monospace",
    align: "left"
  });
  r.rect(2.2, 2.5, 8, .5, {
    fill: "#333333",
    opacity: .8
  });
  r.rect(2.2, 2.5, 8 * Math.min(n, 1), .5, {
    fill: u,
    opacity: .9
  });
  r.text(Math.round(n * 100) + "%", 10.5, 2.85, {
    color: "#ffffff",
    font: "0.35 monospace",
    align: "left"
  });
  r.text("Tier: " + tickBudgetTier, .3, 3.65, {
    color: "#ffffff",
    font: "0.4 monospace",
    align: "left"
  });
  r.text("Avg: " + (heap.cpuStats && heap.cpuStats.average ? heap.cpuStats.average.toFixed(1) : "?"), 5.5, 3.65, {
    color: "#ffffff",
    font: "0.4 monospace",
    align: "left"
  });
  r.text("CPU gates:", .3, 4.35, {
    color: "#aaaaaa",
    font: "0.4 monospace",
    align: "left"
  });
  r.text(sectionsThrottled + " sec/" + creepsThrottled + " crp, " + sectionsDeferred + " scheduled", 3.8, 4.35, {
    color: sectionsThrottled + creepsThrottled > 0 ? "#ffaa00" : "#44ff44",
    font: "0.4 monospace",
    align: "left"
  });
  const p = roomSuspender.getSuspendedRooms();
  r.text("Suspended:", .3, 4.85, {
    color: "#aaaaaa",
    font: "0.4 monospace",
    align: "left"
  });
  r.text(p.length ? p.join(",") : "none", 3.8, 4.85, {
    color: p.length > 0 ? "#ffaa00" : "#44ff44",
    font: "0.4 monospace",
    align: "left"
  });
  if (heap.cpuStats && heap.cpuStats.history && heap.cpuStats.history.length > 1) {
    var f = heap.cpuStats.history.slice(-20);
    var m = tickCpuLimit;
    r.text("History:", .3, 5.25, {
      color: "#aaaaaa",
      font: "0.35 monospace",
      align: "left"
    });
    for (var S = 0; S < f.length; S++) {
      var g = f[S] / m * .7;
      var d = 3.5 + S * .4;
      var C = f[S] > o ? "#ff4444" : f[S] > o * .85 ? "#ffaa00" : "#44ff44";
      r.rect(d, 5.3 - g, .3, g, {
        fill: C,
        opacity: .8
      });
    }
  }
  const T = [];
  const h = [];
  let k = 0;
  let R = 0;
  for (const e in tickSectionCpu) {
    if (e === "runCreeps") {
      k = tickSectionCpu[e];
      R += tickSectionCpu[e];
    } else if (e.startsWith("creep:")) {
      h.push({
        name: e.slice(6),
        cpu: tickSectionCpu[e]
      });
    } else {
      T.push({
        name: e,
        cpu: tickSectionCpu[e]
      });
      R += tickSectionCpu[e];
    }
  }
  const E = Math.max(0, t - R);
  if (E >= .05) {
    T.push({
      name: "untracked/overhead",
      cpu: E
    });
  }
  T.sort(function(e, r) {
    return r.cpu - e.cpu;
  });
  h.sort(function(e, r) {
    return r.cpu - e.cpu;
  });
  const O = 10;
  const I = 10;
  const M = Math.min(T.length, O);
  const b = Math.min(h.length, I);
  if (M + b === 0) return;
  const y = 0;
  const B = 6.2;
  const _ = .52;
  const L = .52;
  const A = 14.5;
  const P = 5.8;
  const N = 6.2;
  const v = .65 + M * _ + (b > 0 ? L + b * _ : 0);
  r.rect(y, B, A, v, {
    fill: "#000000",
    opacity: .7,
    stroke: "#333333"
  });
  r.text("CPU — this tick", y + A / 2, B + .48, {
    color: "#aaaaff",
    font: "bold 0.38 monospace",
    align: "center"
  });
  const D = T.concat(h);
  const G = Math.max.apply(null, D.map(function(e) {
    return e.cpu;
  }).concat([ k, .1 ]));
  function drawRow(e, t, o) {
    const i = t / tickBudget;
    const n = i > .15 ? "#ff4444" : i > .07 ? "#ffaa00" : "#44cc44";
    const a = e.length > 18 ? e.slice(0, 17) + "…" : e;
    r.text(a, y + .2, o + .3, {
      color: "#cccccc",
      font: "0.31 monospace",
      align: "left"
    });
    r.rect(y + P, o, N, .38, {
      fill: "#2a2a2a",
      opacity: .8
    });
    r.rect(y + P, o, Math.max(t / G * N, .04), .38, {
      fill: n,
      opacity: .88
    });
    r.text(t.toFixed(3), y + P + N + .15, o + .3, {
      color: "#ffffff",
      font: "0.31 monospace",
      align: "left"
    });
  }
  for (let e = 0; e < M; e++) {
    drawRow(T[e].name, T[e].cpu, B + .75 + e * _);
  }
  if (b > 0) {
    const e = B + .75 + M * _;
    r.rect(y, e, A, L, {
      fill: "#111122",
      opacity: .9
    });
    r.text("CREEPS", y + .2, e + .36, {
      color: "#8888cc",
      font: "bold 0.32 monospace",
      align: "left"
    });
    const t = k / tickBudget;
    const o = t > .4 ? "#ff4444" : t > .2 ? "#ffaa00" : "#44cc44";
    r.rect(y + P, e + .07, N, .36, {
      fill: "#2a2a2a",
      opacity: .8
    });
    r.rect(y + P, e + .07, Math.max(k / G * N, .04), .36, {
      fill: o,
      opacity: .6
    });
    r.text(k.toFixed(3), y + P + N + .15, e + .36, {
      color: "#aaaaaa",
      font: "0.31 monospace",
      align: "left"
    });
    for (let r = 0; r < b; r++) {
      drawRow(h[r].name, h[r].cpu, e + L + r * _);
    }
  }
}

if (ENABLE_CPU_LOGGING && !heap.cpuProfile) heap.cpuProfile = {};
function profileSection(e, r, t) {
  const o = SECTION_TIERS[e] !== undefined ? SECTION_TIERS[e] : SECTION_TIER.NORMAL;
  const i = Math.max(1, t || 1);
  const n = i * getSectionInterval(o);
  const a = getSectionCostStats(e);
  const c = a.pendingSince !== null;
  const s = tickBudgetTier === "FLUSH" ? 1 : getSectionCostInterval(o, a);
  const l = Math.max(n, s);
  const u = a.effectiveInterval;
  if (a.lastRun === null && a.firstDue !== null && u !== undefined && u !== l) {
    a.firstDue = null;
  }
  a.effectiveInterval = l;
  if (!c && l > 1) {
    const r = a.lastRun === null ? null : Game.time - a.lastRun;
    if (r === null && a.firstDue === null) {
      const r = (Game.time + SECTION_NAME_HASHES[e]) % l;
      a.firstDue = Game.time + (l - r) % l;
    }
    const t = r !== null || Game.time >= a.firstDue;
    if (r === null && !t || r !== null && r < l) {
      if (r !== null && s > n && r >= n) {
        a.costThrottles = (a.costThrottles || 0) + 1;
        sectionsCostThrottled++;
        sectionsThrottled++;
      } else if (i > 1 && (r === null || r < i)) {
        sectionsDeferred++;
      } else {
        sectionsThrottled++;
      }
      return;
    }
  }
  if (shouldDeferSectionForBudget(e, o, a)) {
    sectionsBudgetDeferred++;
    sectionsThrottled++;
    tickDeferredSections.push({
      name: e,
      fn: r,
      stats: a,
      sectionTier: o,
      effectiveInterval: l
    });
    return;
  }
  executeProfileSection(e, r, a, o, l);
}

function measureSection(e, r) {
  const t = Game.cpu.getUsed();
  try {
    return r();
  } catch (r) {
    handleError(e, r);
    return undefined;
  } finally {
    const r = Game.cpu.getUsed() - t;
    tickSectionCpu[e] = (tickSectionCpu[e] || 0) + r;
  }
}

function cleanCpuProfileMemory(e) {
  if (e === undefined) e = 5e3;
  if (!heap.cpuProfileLastUsed) return;
  const r = Game.time;
  for (const t in heap.cpuProfileLastUsed) {
    if (r - heap.cpuProfileLastUsed[t] > e) {
      delete heap.cpuProfile[t];
      delete heap.cpuProfileLastUsed[t];
    }
  }
}

const creepNameHashCache = {};
function getCreepNameHash(e) {
  if (!creepNameHashCache[e.name]) {
    creepNameHashCache[e.name] = e.name.length + e.name.charCodeAt(0) + (e.name.charCodeAt(e.name.length - 1) || 0);
  }
  return creepNameHashCache[e.name];
}

function runCreeps() {
  for (const e in Memory.creeps) {
    if (!Game.creeps[e]) {
      try {
        onCreepDeath(e, Memory.creeps[e]);
      } catch (r) {
        handleError("onCreepDeath." + e, r);
      }
      delete Memory.creeps[e];
      delete creepNameHashCache[e];
    }
  }
  const e = getRoomState.creepIndex();
  const r = e && e.all ? e.all : [];
  for (let e = 0; e < r.length; e++) {
    const t = r[e];
    if (t.spawning) continue;
    if (roomSuspender.shouldIdleCreep(t)) {
      creepsSuspended++;
      continue;
    }
    const o = t.memory.role;
    const i = t.memory.customPriority !== undefined ? t.memory.customPriority : CREEP_PRIORITY[o] || CREEP_PRIORITY.default;
    const n = roomSuspender.canRunSuspendedHarvester(t);
    const a = n ? 1 : getCreepInterval(i);
    if (a > 1) {
      const e = getCreepNameHash(t);
      if ((Game.time + e) % a !== 0) {
        creepsThrottled++;
        continue;
      }
    }
    const c = Game.cpu.getUsed();
    try {
      // Universal boost hook: a creep moving to a lab, boosting, or unboosting
      // spends the tick here and never reaches its role.
      if ((global.__boostActive || t.memory.boosted) && boostManager.handleCreep(t)) {} else if (n) {
        roleHarvester.runSuspended(t);
      } else switch (o) {
       case "harvester":
        roleHarvester.run(t);
        break;
       case "upgrader":
        roleUpgrader.run(t);
        break;
       case "builder":
        roleBuilder.run(t);
        break;
       case "scout":
        roleScout.run(t);
        break;
       case "defender":
        roleDefender.run(t);
        break;
       case "supplier":
        roleSupplier.run(t);
        break;
       case "claimbot":
        roleClaimbot.run(t);
        break;
       case "attacker":
        roleAttacker.run(t);
        break;
       case "harasser":
        roleHarasser.run(t);
        break;
       case "healer":
        roleHealer.run(t);
        break;
       case "extractor":
        roleExtractor.run(t);
        break;
       case "thief":
        roleThief.run(t);
        break;
       case "scavenger":
        roleScavenger.run(t);
        break;
       case "towerDrain":
        roleTowerDrain.runCreep(t);
        break;
       case "demolition":
        roleDemolition.run(t);
        break;
       case "quad":
        roleSquad.run(t);
        break;
       case "mineralCollector":
        roleMineralCollector.run(t);
        break;
       case "terminalBot":
        terminalManager.runTerminalBot(t);
        break;
       case "signbot":
        roleSignbot.run(t);
        break;
       case "wallRepair":
        roleRepairer.run(t);
        break;
       case "labBot":
        roleLabBot.run(t);
        break;
       case "nukeFill":
        roleNukeFill.run(t);
        break;
       case "remoteBuilder":
        roleRemoteBuilder.run(t);
        break;
       case "depositHarvester":
        roleDepositHarvester.run(t);
        break;
       case "powerBot":
        rolePowerBot.run(t);
        break;
       case "maintainer":
        roleMaintainer.run(t);
        break;
       case "contestedDemolisher":
        roleContestedDemolisher.run(t);
        break;
       case "drainDemolisher":
        roleDrainDemolisher.run(t);
        break;
       case "skAttacker":
        roleSKAttacker.run(t);
        break;
       case "defenseRepair":
        roleRepairer.run(t);
        break;
       case "hd":
        roleHD.run(t);
        break;
       case "staticDistributor":
        roleStaticDistributor.run(t);
        break;
       case "comboBot":
        roleComboBot.run(t);
        break;
       case "rampartBot":
        roleRepairer.run(t);
        break;
       case "remoteSupplier":
        roleRemoteSupplier.run(t);
        break;
       case "controllerAttacker":
        roleControllerAttacker.run(t);
        break;
       case "towerFiller":
        roleTowerFiller.run(t);
        break;
       case "extractorAssistant":
        roleExtractorAssistant.run(t);
        break;
       case "repairer":
        roleRepairer.run(t);
        break;
       default:
        t.memory.role = "harvester";
        roleHarvester.run(t);
        break;
      }
    } catch (e) {
      handleError("creep.run." + o + "." + t.name, e);
    }
    const s = Game.cpu.getUsed() - c;
    const l = "creep:" + o;
    tickSectionCpu[l] = (tickSectionCpu[l] || 0) + s;
    if (ENABLE_CPU_LOGGING) {
      if (!heap.cpuProfileCreeps) heap.cpuProfileCreeps = {};
      if (!heap.cpuProfileCreeps[o]) heap.cpuProfileCreeps[o] = [];
      heap.cpuProfileCreeps[o].push(s);
      if (heap.cpuProfileCreeps[o].length > 50) {
        heap.cpuProfileCreeps[o].shift();
      }
    }
  }
  if (Memory.operators) {
    for (const e in Memory.operators) {
      const r = Game.powerCreeps[e];
      if (!r) continue;
      if (roomSuspender.isSuspended(Memory.operators[e].homeRoom)) {
        creepsSuspended++;
        continue;
      }
      if (!r.ticksToLive) {
        try {
          roleOperator.trySpawn(r, Memory.operators[e].homeRoom);
        } catch (r) {
          handleError("powerCreep.trySpawn." + e, r);
        }
        continue;
      }
      const t = Game.cpu.getUsed();
      try {
        roleOperator.runCreep(r, Memory.operators[e]);
      } catch (r) {
        handleError("powerCreep.run.operator." + e, r);
      }
      const o = Game.cpu.getUsed() - t;
      tickSectionCpu["creep:operator"] = (tickSectionCpu["creep:operator"] || 0) + o;
      if (ENABLE_CPU_LOGGING) {
        if (!heap.cpuProfileCreeps) heap.cpuProfileCreeps = {};
        if (!heap.cpuProfileCreeps["operator"]) heap.cpuProfileCreeps["operator"] = [];
        heap.cpuProfileCreeps["operator"].push(o);
        if (heap.cpuProfileCreeps["operator"].length > 50) {
          heap.cpuProfileCreeps["operator"].shift();
        }
      }
    }
  }
  if (Game.time % 50 === 0 && ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
    for (const e in heap.cpuProfileCreeps) {
      const r = heap.cpuProfileCreeps[e];
      const t = r.reduce(function(e, r) {
        return e + r;
      }, 0) / r.length;
      console.log("Creep Role CPU: " + e + " avg: " + Math.round(t));
    }
  }
}

function tick() {
  const e = Game.cpu.getUsed();
  calcTickBudget();
  tickSectionCpu["calcTickBudget"] = Game.cpu.getUsed() - e;
  measureSection("economics.run", function() {
    economics.run();
  });
  measureSection("cpuTickLog", function() {
    if (Game.time % 100 === 0 || tickBudgetTier === "CRITICAL") {
      console.log("[CPU] Tick " + Game.time + " | Bucket: " + Game.cpu.bucket + " | Tier: " + tickBudgetTier + " | Budget: " + tickBudget.toFixed(1) + " | Pressure: " + Math.round(tickPressure * 100) + "%");
    }
  });
  measureSection("memoryMaintenance", function() {
    let e = false;
    if (!Memory.stats) {
      Memory.stats = {};
      e = true;
    }
    if (typeof Memory.stats.kills !== "number") {
      Memory.stats.kills = 0;
      e = true;
    }
    if (Memory.stats.killResetDate !== undefined) {
      delete Memory.stats.killResetDate;
      e = true;
    }
    if (Memory.stats.lastTotalEnergy !== undefined) {
      delete Memory.stats.lastTotalEnergy;
      e = true;
    }
    if (Array.isArray(Memory.errors) && Memory.errors.length > 10) {
      Memory.errors = Memory.errors.slice(-10);
      e = true;
    }
    if (Game.time % 30 === 0) roleScout.handleDeadCreeps();
    if (Game.time % 1e3 === 0 && cleanMemory()) e = true;
    if (Game.time % 1e3 === 0) cleanCpuProfileMemory();
    if (e) memoryManager.requestSave();
  });
  profileSection("getRoomState.init", function() {
    getRoomState.init();
  });
  // Wrap the market API before any module can spend credits this tick.
  measureSection("marketSpendGuard.install", function() {
    marketSpendGuard.install();
  });
  measureSection("marketAttribution.run", function() {
    marketAttribution.run();
  });
  measureSection("dailyFinance.boundary", function() {
    try {
      dailyFinance.beforeMarket();
    } catch (e) {
      handleError("dailyFinance.boundary", e);
    }
  });
  profileSection("marketPriceAdjustment.run", function() {
    marketPriceAdjustment.run();
  });
  profileSection("energyManager.run", function() {
    energyManager.run();
  }, 10);
  measureSection("roomSuspender.run", function() {
    roomSuspender.run();
  });
  // Computed every tick, not on a %10 cadence: needsNewCreeps() gates the
  // emergency recovery path (and manageHarvesterSpawns with it), so stale or
  // absent counts meant a wiped room waited up to 10 ticks to rebuild.
  // Deliberately not cached across ticks -- a dead creep still counted would
  // block its own replacement.
  let r = measureSection("statusReport.getPerRoomRoleCounts", function() {
    return statusReport.getPerRoomRoleCounts();
  });
  profileSection("claimbotRangeCheck.run", function() {
    claimbotRangeCheck.run();
  });
  profileSection("defenseMonitor.run", function() {
    defenseMonitor.run();
  });
  profileSection("repairManager.run", function() {
    repairManager.run();
  }, 10);
  profileSection("towerManager.run", function() {
    towerManager.run();
  });
  profileSection("linkManager.run", function() {
    linkManager.run();
  }, 3);
  profileSection("roomBalance", function() {
    roomBalance.run();
  }, 100);
  profileSection("roleSignbot.permanentSignCheck", function() {
    roleSignbot.runPermanentSignCheck();
  });
  measureSection("storageVfs.migration", function() {
    try {
      require("storageVfs").migrateLegacyReservations();
    } catch (e) {
      handleError("storageVfs.migration", e);
    }
  });
  profileSection("terminalManager", function() {
    terminalManager.run();
  });
  profileSection("roleTowerDrain", function() {
    roleTowerDrain.run();
  });
  profileSection("factoryManager", function() {
    factoryManager.run();
  });
  profileSection("marketUpdater", function() {
    marketUpdater.run();
  });
  profileSection("marketBatchBuy.run", function() {
    marketBatchBuy.run();
  });
  profileSection("marketRefine.run", function(e) {
    marketRefine.run(e);
  });
  profileSection("localRefine.run", function() {
    localRefine.run();
  });
  measureSection("opportunisticBuy.reconcilePending", function() {
    opportunisticBuy.reconcilePending();
  });
  measureSection("opportunisticSell.reconcilePending", function() {
    opportunisticSell.reconcilePending();
  });
  measureSection("marketArbitrage.reconcilePending", function() {
    marketArbitrage.reconcilePending();
  });
  profileSection("stockpileManager.run", function(e) {
    stockpileManager.run(e);
  });
  profileSection("marketLab.run", function(e) {
    marketLab.run(e);
  });
  profileSection("marketBuyer.run", function() {
    marketBuyer.run();
  });
  if (Game.time % 10 === 0) measureSection("marketEconomics.run", function() {
    marketEconomics.run();
  });
  if (autoTrader.isMineralTradingDue()) {
    profileSection("autoTrader.minerals", function() {
      autoTrader.runMineralTrading();
    });
  } else if (autoTrader.isResidueSweepDue()) {
    profileSection("autoTrader.residue", function() {
      autoTrader.runResidueSweep();
    });
  } else if (autoTrader.isAnalysisDue()) {
    profileSection("autoTrader.run", function() {
      autoTrader.run();
    });
  }
  profileSection("roleContestedDemolisher", function() {
    roleContestedDemolisher.run();
  });
  profileSection("dailyFinance", function() {
    dailyFinance.run();
  });
  profileSection("inventory", function() {
    inventory.run();
  });
  profileSection("marketArbitrage.serviceActive", function() {
    marketArbitrage.serviceActive();
  });
  profileSection("marketArbitrage.scan", function() {
    marketArbitrage.scan();
  }, 2);
  profileSection("opportunisticBuy", function() {
    opportunisticBuy.process();
  }, 10);
  profileSection("remoteSupplyManager.run", function() {
    remoteSupplyManager.run();
  });
  measureSection("simscanQuery.run", function() {
    simscanQuery.run();
  });
  const t = scanner.getRunPlan(getLivePressure());
  if (t) {
    try {
      const e = scanner.run(t);
      for (const r in e) {
        tickSectionCpu[r] = (tickSectionCpu[r] || 0) + e[r];
      }
    } catch (e) {
      handleError("scanner.run", e);
    }
  }
  measureSection("flagVault.tick", function() {
    try {
      memoryManager.storage.tick();
    } catch (e) {
      handleError("flagVault.tick", e);
    }
  });
  measureSection("marketEconomics.archiveTick", function() {
    try {
      marketEconomics.archiveTick();
    } catch (e) {
      handleError("marketEconomics.archiveTick", e);
    }
  });
  measureSection("marketEconomics.archiveRetention", function() {
    try {
      marketEconomics.archiveRetentionTick();
    } catch (e) {
      handleError("marketEconomics.archiveRetention", e);
    }
  });
  profileSection("opportunisticSell", function() {
    opportunisticSell.process();
  }, 10);
  profileSection("marketSeller.run", function() {
    marketSeller.run();
  }, 50);
  measureSection("powerManager.run", function() {
    powerManager.run();
  });
  profileSection("depositObserver.run", function() {
    depositObserver.run();
  });
  profileSection("nukeLaunch.run", function() {
    nukeLaunch.run();
  });
  profileSection("roleNukeFill.runAuto", function() {
    roleNukeFill.runAuto();
  });
  profileSection("roleNukeFill.consolidateCompletedOrders", function() {
    roleNukeFill.consolidateCompletedOrders();
  });
  profileSection("labManager", function() {
    labManager.run();
  });
  profileSection("boostManager.run", function() {
    boostManager.run();
  }, 3);
  if (Game.time % 5e3 === 0) {
    try {
      compliance.retireUndersizedHarvesters();
    } catch (e) {
      handleError("compliance.retireUndersizedHarvesters", e);
    }
  }
  profileSection("spawnManager.run", function() {
    spawnManager.run(r, getRoomState);
  });
  profileSection("autoBuilder.run", function() {
    autoBuilder.run();
  });
  profileSection("runCreeps", runCreeps);
  measureSection("storageVfs.maintenance", function() {
    try {
      require("storageVfs").runMaintenance(50);
    } catch (e) {
      handleError("storageVfs.maintenance", e);
    }
  });
  if (Memory.roomCPUProfile && Memory.roomCPUProfile.active) {
    measureSection("roomCPUProfiler", function() {
      roomCPUProfiler.run();
    });
  }
  profileSection("creepProfiler.run", function() {
    creepProfiler.run();
  });
  profileSection("creepProfiler.report", function() {
    creepProfiler.report();
  });
  profileSection("localMap.run", function() {
    localMap.run();
  });
  profileSection("autoEnergyBuyer", function() {
    autoEnergyBuyer.run();
  }, 1050);
  measureSection("taskScheduler.run", function() {
    taskScheduler.run();
  });
  profileSection("statusReport", function() {
    if (!r) r = statusReport.getPerRoomRoleCounts();
    statusReport.run(r);
  }, 100);
  if (Game.time % 100 === 0 && ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
    measureSection("cpuProfileConsole", function() {
      for (const e in heap.cpuProfile) {
        const r = heap.cpuProfile[e].reduce(function(e, r) {
          return e + r;
        }, 0) / heap.cpuProfile[e].length;
        console.log("CPU Profile: " + e + " avg: " + Math.round(r));
      }
    });
  }
  runDeferredSections();
  measureSection("cpuThrottleLog", function() {
    const e = roomSuspender.getSuspendedRooms();
    if (ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE && (sectionsThrottled > 0 || creepsThrottled > 0 || e.length > 0)) {
      console.log("[CPU] Throttled: " + sectionsThrottled + " sections, " + creepsThrottled + " creeps, " + creepsSuspended + " suspended; scheduled: " + sectionsDeferred + " sections; cost-gated: " + sectionsCostThrottled + "; budget-gated: " + sectionsBudgetDeferred + " (late: " + sectionsBudgetLateRun + ", burst: " + sectionsBudgetBurstRun + ", pending: " + (sectionsBudgetDeferred - sectionsBudgetLateRun) + ")" + " (rooms: " + (e.length ? e.join(",") : "none") + ") | Pressure: " + Math.round(getLivePressure() * 100) + "% (base " + Math.round(tickPressure * 100) + "%) | Used: " + Game.cpu.getUsed().toFixed(1) + "/" + tickBudget.toFixed(1) + " | Bucket: " + Game.cpu.bucket);
    }
  });
  measureSection("memorySerializationSample", function() {
    memoryManager.sampleSerializationCost();
  });
  measureSection("trackCPUUsage", trackCPUUsage);
  drawCpuHud();
}

module.exports.loop = function() {
  try {
    memoryManager.run();
    profiler.wrap(tick);
  } catch (e) {
    handleError("mainLoop", e);
  }
};
