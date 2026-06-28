/**
 * scanner.js — Unified scanning and intelligence module
 *
 * Consolidates: maintenanceScanner, roomIntel, nukeAnalyze,
 *               playerAnalysis, wideScan, warEstimate, playerMonitor,
 *               observer scheduler, room registry
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — MAINTENANCE SCANNER
 * ═══════════════════════════════════════════════════════════════════
 *
 *   maintScan()
 *     Print energy/tick decay costs for all visible rooms.
 *     Columns: creep repair cost and tower repair cost per structure type.
 *
 *   maintScanRoom('W1N1')
 *     Scan one room. Uses observer fallback if not visible; auto-completes
 *     next tick via scanner.run(). PWR_OPERATE_OBSERVER attempted if no
 *     structural observer is in range.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — ROOM INTEL
 * ═══════════════════════════════════════════════════════════════════
 *
 *   intel('W1N1')
 *     Full report. Starts a 100-tick efficiency profile automatically;
 *     the report prints when the profile completes. Observer fallback
 *     included. Scores: Economic (20%), Military (25%), Infrastructure
 *     (30%), Operational Efficiency (25%).
 *
 *   intelFast('W1N1')
 *     Instant snapshot report — no profiling. Economic (27%), Military
 *     (33%), Infrastructure (40%). Observer fallback included.
 *
 *   listIntel()
 *     List rooms with active or cached efficiency profiles.
 *
 *   getCachedIntel('W1N1')   Return the cached profile for a room, or null
 *                            if missing/expired. With no argument, return a
 *                            list of {room, completedTick, expiresTick}
 *                            for every non-expired cached profile.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — NUKE ANALYSIS
 * ═══════════════════════════════════════════════════════════════════
 *
 *   nukeAnalyze('W1N1')              Best single strike position.
 *   nukeAnalyze('W1N1', 3)           Greedy best-3 strike combination.
 *   nukeAnalyzeSelf()                Analyze every room you own.
 *   nukeAnalyzeCost('W1N1', x, y)    Cost report for one coordinate.
 *   nukeAnalyzeCost('W1N1',[{x,y}])  Multi-strike stacked-damage report.
 *   nukeIncoming()                   Check all owned rooms for FIND_NUKES.
 *   nukeIncoming('W1N1')             Check one room.
 *   nukeThreat('W1N1')               Scan 10-room radius for hostile nukers;
 *                                    tests whether they can kill key structures.
 *   nukeThreatStatus('W1N1')         Progress of active threat scan.
 *   nukeThreatCancel('W1N1')         Cancel and clear threat scan.
 *   All commands use observer/PWR_OPERATE_OBSERVER fallback and auto-complete.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — PLAYER ANALYSIS
 * ═══════════════════════════════════════════════════════════════════
 *
 *   player('PlayerName')
 *     Full intelligence sweep. Phase 1: scan observer range for player bases.
 *     Phase 2: gather intel on each base. Report includes Eco/Mil/Infra scores,
 *     nuke threat matrix, strike capability, attack recommendations.
 *     Game.notify summary sent on completion.
 *
 *   playerStatus()         Progress: phase, %, rooms found.
 *   playerCancel()         Cancel active analysis.
 *   playerLast()           Reprint last report (10k tick TTL).
 *
 *   playerScan('Name','CREEPCOUNT')
 *     Creep census. Counts by category:
 *       Military  — ATTACK / RANGED_ATTACK / HEAL parts
 *       Worker    — >25% WORK parts
 *       Supplier  — <10% WORK, logistics haulers
 *       Claimer   — CLAIM parts
 *       Scout     — 100% MOVE
 *       Other     — 10-25% WORK hybrid
 *
 *   playerScanStatus()     Progress of active census.
 *   playerScanCancel()     Cancel active census.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — ROOM REGISTRY (sweep-based)
 * ═══════════════════════════════════════════════════════════════════
 *
 *   registrySweep()        Force a registry sweep now. Sweeps every
 *                          claimable room within observer range
 *                          (highways, SK rooms and sector centers are
 *                          skipped — they can never be player-owned).
 *                          Runs automatically every REG_SWEEP_INTERVAL
 *                          ticks using leftover observer capacity.
 *   registryStatus()       Sweep progress / registry age / room count.
 *   registryList()         Every player in the registry with their rooms.
 *   registryPlayer('Name') Rooms owned by one player, with RCL + age.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — WIDE SCAN  (registry views)
 * ═══════════════════════════════════════════════════════════════════
 *
 *   wideScan('PlayerName')  Rooms owned by player. Instant if the
 *                           registry is fresh; otherwise starts a sweep
 *                           and prints when it completes.
 *   wideScanPlayers()       Every player in observer range (same rules).
 *   wideScanStatus()        Sweep progress.
 *   wideScanCancel()        Cancel the pending report (sweep continues).
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — PLAYER MONITOR
 * ═══════════════════════════════════════════════════════════════════
 *
 *   monitor('Player', 'WAR')              Assign a status (alerts on).
 *   monitor('Player', 'ALLY', ['rooms'])  Assign status + seed known rooms.
 *   monitor('Player')                     Defaults to ENEMY status.
 *   monitorSetStatus('Player', 'WAR')     Change a player's status.
 *   monitorAdd('Player', ['rooms'], 'WAR') Seed rooms into the registry;
 *                                         optional 3rd arg assigns/changes
 *                                         status. (Arg order: name, rooms,
 *                                         status — opposite of monitor().)
 *   monitorRemove('Player')               Clear status (alerts off; the
 *                                         registry keeps tracking rooms).
 *   monitorStatus()                       Statuses, rooms, staleness.
 *   monitorPause() / monitorResume()      Pause/resume alerts + hot polls.
 *
 *   The registry sweep tracks EVERY room. Statuses only control alerts
 *   and hot-poll rates:
 *     ALLY/NEUTRAL/ENEMY — deep-analyzed every 1000 ticks
 *     WAR                — deep-analyzed every 100 ticks
 *   Unstatused players are tracked silently (ownership/RCL only).
 *
 *   Alerts (filtered by status, same matrix as the old playerMonitor):
 *     all statuses:      RCL_UPGRADED/DOWNGRADED, ROOM_LOST, NO_CREEPS,
 *                        SPAWNS_DRAINED, TOWERS_EMPTY, SAFE_MODE, NEW_ROOM
 *     NEUTRAL and above: NUKER_BUILT, NUKER_FILLING_G/E, MILITARY_CREEPS,
 *                        BOOSTED_CREEPS
 *     ENEMY and above:   POWER_DETECTED
 *     WAR only:          TERMINAL_G
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS — WAR ESTIMATE
 * ═══════════════════════════════════════════════════════════════════
 *
 *   warEstimate('PlayerName')
 *     Five-phase war outcome estimate:
 *       1. Discovery  — enemy rooms from registry (sweep started if stale;
 *                       skipped if fresh player() data exists)
 *       2. Intel      — observe each room, full 5x5 nuke sweep per room
 *       3. Monitor    — 10 snapshots at 1k-tick intervals
 *       4. Compute    — 6 categories x 3 time horizons
 *       5. Notify     — Game.notify report in chunks
 *     Categories: Force Projection (20%), Spawn Throughput (20%),
 *     Attrition (20%), Boost Capacity (15%), Defensive Depth (15%),
 *     Multi-Front Strain (10%).
 *
 *   warEstimateStatus()    Phase + sub-phase progress.
 *   warEstimateCancel()    Cancel active estimate.
 *   warEstimateLast()      View last report (2k tick TTL).
 *
 * ═══════════════════════════════════════════════════════════════════
 * OBSERVER ARCHITECTURE — THE SCHEDULER
 * ═══════════════════════════════════════════════════════════════════
 *
 * All observer use flows through one tick-scoped booking set
 * (global.__obsUsed) so no two consumers fire the same observer in the
 * same tick. The scheduler dispatches at the top of scanner.run():
 *
 *   p≈100  One-shot console commands (intel / nuke / maint pendings)
 *   p=80   WAR-status hot polls (every 100 ticks per room)
 *   p=55-60 depositObserver requests (route validation / deposit watch)
 *   p=50   ENEMY/NEUTRAL/ALLY hot polls (every 1000 ticks per room)
 *   sweep  Registry sweep fills every observer still idle at the END
 *          of scanner.run() — lowest priority, uses leftover capacity.
 *
 * External modules submit requests with:
 *     require('scanner').observe.request(roomName, 'src', priority)
 * and simply wait for Game.rooms[roomName] to become visible. Requests
 * persist in Memory.obsSched until fulfilled or timed out.
 *
 * Multi-tick scans (playerAnalysis, warEstimate) still pace themselves
 * one room per tick, but now book through the shared set and retry when
 * their observer was taken, instead of silently dropping rooms.
 *
 * ═══════════════════════════════════════════════════════════════════
 * MEMORY KEYS USED
 * ═══════════════════════════════════════════════════════════════════
 *
 *   Memory.maintScan             Pending maintenance scan queue
 *   Memory.roomEffProfile        Active 100-tick efficiency profiles
 *   Memory.roomEffCache          Completed efficiency profile cache
 *   Memory.roomIntelPending      Pending one-shot intel observations
 *   Memory.intelPowerObserve     PWR_OPERATE_OBSERVER for intel/nuke
 *   Memory.nukeAnalyzePending    Pending nuke analysis observations
 *   Memory.nukeThreatScans       Active nukeThreat scan state
 *   Memory.nukeThreatPowerObserve PWR_OPERATE_OBSERVER for threat scans
 *   Memory.playerAnalysis        Active playerAnalysis state machine
 *   Memory.playerScan            Active creep census state
 *   Memory.lastPlayerAnalysis    Cached player analysis (10k tick TTL)
 *   Memory.warEstimate           Active warEstimate state machine
 *   Memory.lastWarEstimate       Cached war estimate (2k tick TTL)
 *   Memory.obsSched              Observer scheduler request queue
 *   Memory.roomRegistry          Room ownership registry + sweep state
 *   Memory.wideScanReport        Pending wideScan report (sweep-backed)
 *   Memory.playerMonitor         Monitor statuses, per-room deep state
 *
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

// ════════════════════════════════════════════════════════════════════════════
// EXTERNAL DEPENDENCIES
// ════════════════════════════════════════════════════════════════════════════

let _isFriendlyUsername;
try {
    const _iff = require('iff');
    _isFriendlyUsername = (_iff && typeof _iff.isFriendlyUsername === 'function')
        ? (u) => _iff.isFriendlyUsername(u)
        : () => false;
} catch (e) { _isFriendlyUsername = () => false; }

// ════════════════════════════════════════════════════════════════════════════
// SHARED CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const OBSERVER_RANGE = 10;
const NUKE_RANGE     = 5;
const SUPPORT_RANGE  = 6;

// Tower repair
const TOWER_ENERGY_COST   = 10;
const TOWER_MAX_REPAIR    = 800;
const TOWER_MIN_REPAIR    = 200;
const TOWER_OPTIMAL_RANGE = 5;
const TOWER_FALLOFF_RANGE = 20;
const TOWER_FALLBACK_HPE  = 40;
const CREEP_REPAIR_HITS   = 100;

// Nuke
const NUKE_DIRECT_DAMAGE     = 10000000;
const NUKE_AREA_DAMAGE       =  5000000;
const NUKE_ENERGY_COST_CONST =   300000;
const NUKE_GHODIUM_COST      =     5000;
const REPAIR_HITS_PER_ENERGY =      100;

// Decay rates per tick
const ROAD_PLAIN_DPT        = 0.1;
const ROAD_SWAMP_DPT        = 0.5;
const RAMPART_DPT           = 3.0;
const CONTAINER_OWNED_DPT   = 10.0;
const CONTAINER_UNOWNED_DPT = 50.0;

// Nuke structure build costs (energy)
const NUKE_BUILD_COST = {
    spawn:15000, extension:3000, road:300, wall:1, rampart:1,
    link:5000, storage:30000, tower:5000, observer:8000,
    powerSpawn:100000, extractor:5000, lab:50000, terminal:100000,
    container:5000, nuker:100000, factory:100000
};

// roomIntel structure costs (energy) — uses Screeps constants as keys
const STRUCT_COST_MAP = {};

// Intel scoring weights
const INTEL_W      = { economic:0.20, military:0.25, dualPurpose:0.30, operational:0.25 };
const INTEL_W_FAST = { economic:0.20/0.75, military:0.25/0.75, dualPurpose:0.30/0.75 };
const INTEL_PROFILE_TICKS   = 100;
const INTEL_EFF_EXPIRE      = 5000;
const INTEL_EFF_MEM_KEY     = 'roomEffProfile';
const INTEL_EFF_CACHE_KEY   = 'roomEffCache';
const INTEL_EFF_GLOBAL_PREV = '__effPrev';
const INTEL_EXT_BY_RCL  = {0:0,1:0,2:5,3:10,4:20,5:30,6:40,7:50,8:60};
const INTEL_SPWN_BY_RCL = {0:0,1:1,2:1,3:1,4:1,5:1,6:1,7:2,8:3};

const BODYPART_COST_MAP = {
    move:50,work:100,carry:50,attack:80,ranged_attack:150,heal:250,claim:600,tough:10
};
const INTEL_COMBAT_BOOSTS = ['UH','UH2O','XUH2O','KO','KHO2','XKHO2','LO','LHO2','XLHO2'];

// Energy profiler — long-window energy-economy analysis
const ENERGY_PROFILE_TICKS    = 1500;
const ENERGY_EFF_EXPIRE       = 5000;
const ENERGY_EFF_MEM_KEY      = 'energyEffProfile';
const ENERGY_EFF_CACHE_KEY    = 'energyEffCache';
const ENERGY_EFF_GLOBAL_PREV  = '__energyPrev';
const ENERGY_PENDING_KEY      = 'energyEffPending';
const ENERGY_POWER_OBS_KEY    = 'energyEffPowerObs';
const ENERGY_LOG_INTERVAL     = 250;
const ENERGY_NOTIFY_TOTAL_MAX = 455; // Game.notify 500 limit minus ~45-char header
const ENERGY_NOTIFY_PER_TICK  = 10;
const ENERGY_NOTIFY_HEADER_MAX = 50;
const ENERGY_SIMILARITY_THRESHOLD = 0.5; // 50% common-prefix creep grouping
const ENERGY_ROOM_NAME_RE = /^[WE]\d+[NS]\d+$/;
const ENERGY_BOX_DROP_RE = /^[\s\u2500\u2508\u2550\u2569\u256C]+$/;

// Event log type constants
const EV_HARVEST=5,EV_HEAL=6,EV_REPAIR=7,EV_BUILD=4,
      EV_TRANSFER=12,EV_ATTACK=1,EV_POWER=11,
      EV_UPGRADE_CONTROLLER=9,EV_ATTACK_CONTROLLER=3,EV_RESERVE_CONTROLLER=8;

// ── Body part helpers (used by energy profile creep ledger) ──────────────
function _bpCostOf(body) {
    let cost = 0;
    for (const p of body) cost += BODYPART_COST_MAP[p.type || p] || 0;
    return cost;
}
function _bpHasWork(body) {
    for (const p of body) if ((p.type || p) === WORK) return true;
    return false;
}
function _bpSig(body) {
    const counts = {};
    for (const p of body) { const t = p.type || p; counts[t] = (counts[t] || 0) + 1; }
    const letter = { work:'W', carry:'C', move:'M', attack:'A', ranged_attack:'R', heal:'H', claim:'L', tough:'T' };
    let sig = '';
    for (const k of [WORK, CARRY, MOVE, ATTACK, RANGED_ATTACK, HEAL, CLAIM, TOUGH])
        if (counts[k]) sig += counts[k] + letter[k];
    return sig;
}
function _bpInferRole(body) {
    const counts = {};
    for (const p of body) counts[p.type || p] = (counts[p.type || p] || 0) + 1;
    const w  = counts.work || 0;
    const c  = counts.carry || 0;
    const a  = (counts.attack || 0) + (counts.ranged_attack || 0);
    const h  = counts.heal || 0;
    const cl = counts.claim || 0;
    if (cl)                 return 'claimer';
    if (a)                  return 'attacker';
    if (h)                  return 'healer';
    if (w === 0 && c === 0) return 'scout';
    if (w >= 5 && c <= 1)   return 'static-miner';
    if (w === 0 && c >= 5)  return 'hauler';
    if (c === 0 && w > 0)   return 'worker-no-carry';
    if (w > 0 && c > 0)     return 'worker';
    return 'unknown';
}

// playerAnalysis
const PA_THRESHOLDS = { weak:40, strong:70 };
const PA_SCAN_TYPES = ['CREEPCOUNT'];

// warEstimate
const WE_NOTIFY_TOTAL_MAX = 455; // 500 limit minus ~45 header
const WE_NOTIFY_PER_TICK  = 10;
const WE_MONITOR_SAMPLES  = 10;
const WE_MONITOR_INTERVAL = 1000;
const TICKS_PER_DAY       = 28800;

const COMBAT_BOOSTS_ATK  = ['UH','UH2O','XUH2O'];
const COMBAT_BOOSTS_RNG  = ['KO','KHO2','XKHO2'];
const COMBAT_BOOSTS_HEAL = ['LO','LHO2','XLHO2'];
const COMBAT_BOOSTS_TUFF = ['GO','GHO2','XGHO2'];
const ALL_COMBAT_BOOSTS  = [...COMBAT_BOOSTS_ATK,...COMBAT_BOOSTS_RNG,...COMBAT_BOOSTS_HEAL,...COMBAT_BOOSTS_TUFF];
const T3_BOOSTS          = ['XUH2O','XKHO2','XLHO2','XGHO2','XZH2O','XZHO2','XKH2O','XLH2O','XGH2O','XUHO2'];
const BASE_MINERALS      = ['H','O','U','L','K','Z','X','G'];

const HIGHWAY_DEPOSITS       = ['metal','biomass','silicon','mist'];
const COMPRESSED_COMMODITIES = ['utrium_bar','lemergium_bar','zynthium_bar','keanium_bar','ghodium_melt','oxidant','reductant','purifier','battery'];
const REGIONAL_COMMODITIES   = ['wire','cell','alloy','condensate'];
const LEVEL_COMMODITIES      = ['composite','crystal','liquid','switch','phlegm','tube','concentrate','transistor','tissue','fixtures','extract','microchip','muscle','frame','spirit','circuit','organoid','hydraulics','emanation','device','organism','machine','essence'];
const LAB_PRODUCTS_LIST      = ['OH','ZK','UL','UH','UO','KH','KO','LH','LO','ZH','ZO','GH','GO','UH2O','UHO2','KH2O','KHO2','LH2O','LHO2','ZH2O','ZHO2','GH2O','GHO2','XUH2O','XUHO2','XKH2O','XKHO2','XLH2O','XLHO2','XZH2O','XZHO2','XGH2O','XGHO2'];

const WE_CAT_WEIGHTS = {
    forceProjection:0.20, spawnThroughput:0.20, attrition:0.20,
    boostCapacity:0.15, defensiveDepth:0.15, multiFrontStrain:0.10
};

const WE_CAPS = {
    spawnsInTheater:18, towersInTheater:36, roomsInSupport:10,
    warChest:20000000, incomePerTick:120, economicTiers:8,
    marketScore:25, burnRate:800, terminalDepth:10,
    combatBoosts:60000, labCount:10, baseMineralTypes:8,
    repairPerTick:4800, wallHPMedian:1000000000, safeModeTicks:100000,
    maxRoomSpread:30, energyCap:12300, activeSpawns:18
};

const WE_W = {
    forceProjection: {
        short:{distance:0.15,spawnsSupport:0.20,towersTheater:0.15,terminalRelay:0.20,nukeOverlap:0.10,roomsSupport:0.20},
        medium:{distance:0.10,spawnsSupport:0.18,towersTheater:0.12,terminalRelay:0.22,nukeOverlap:0.15,roomsSupport:0.23},
        long:{distance:0.08,spawnsSupport:0.12,towersTheater:0.08,terminalRelay:0.25,nukeOverlap:0.20,roomsSupport:0.27}
    },
    spawnThroughput: {
        short:{energyCap:0.20,activeSpawns:0.25,extensionFill:0.15,operatorBoost:0.15,creepsPer100:0.25},
        medium:{energyCap:0.20,activeSpawns:0.20,extensionFill:0.15,operatorBoost:0.18,creepsPer100:0.27},
        long:{energyCap:0.15,activeSpawns:0.15,extensionFill:0.10,operatorBoost:0.20,creepsPer100:0.40}
    },
    attrition: {
        short:{warChest:0.25,baseIncome:0.08,econProduction:0.05,tradeLiquidity:0.07,burnRate:0.18,terminalDepth:0.12,mineralPressure:0.10,depletion:0.15},
        medium:{warChest:0.12,baseIncome:0.10,econProduction:0.15,tradeLiquidity:0.10,burnRate:0.15,terminalDepth:0.18,mineralPressure:0.08,depletion:0.12},
        long:{warChest:0.05,baseIncome:0.08,econProduction:0.25,tradeLiquidity:0.12,burnRate:0.12,terminalDepth:0.20,mineralPressure:0.06,depletion:0.12}
    },
    boostCapacity: {
        short:{stockpile:0.30,tierDistribution:0.15,labCapacity:0.10,baseMinerals:0.10,replenishment:0.10,defensiveBoosts:0.25},
        medium:{stockpile:0.15,tierDistribution:0.12,labCapacity:0.20,baseMinerals:0.18,replenishment:0.20,defensiveBoosts:0.15},
        long:{stockpile:0.08,tierDistribution:0.10,labCapacity:0.25,baseMinerals:0.22,replenishment:0.25,defensiveBoosts:0.10}
    },
    defensiveDepth: {
        short:{repairThroughput:0.20,wallHPPool:0.15,safeModeInventory:0.25,towerSustain:0.15,gclHeadroom:0.05,rebuildCapacity:0.05,controllerFort:0.15},
        medium:{repairThroughput:0.18,wallHPPool:0.20,safeModeInventory:0.15,towerSustain:0.20,gclHeadroom:0.10,rebuildCapacity:0.07,controllerFort:0.10},
        long:{repairThroughput:0.12,wallHPPool:0.15,safeModeInventory:0.10,towerSustain:0.20,gclHeadroom:0.18,rebuildCapacity:0.15,controllerFort:0.10}
    },
    multiFrontStrain: {
        short:{spawnAllocation:0.20,terminalBandwidth:0.15,geoSpread:0.20,reserveRooms:0.10,perFrontRatio:0.25,ownStrain:0.10},
        medium:{spawnAllocation:0.18,terminalBandwidth:0.20,geoSpread:0.18,reserveRooms:0.15,perFrontRatio:0.18,ownStrain:0.11},
        long:{spawnAllocation:0.15,terminalBandwidth:0.22,geoSpread:0.15,reserveRooms:0.22,perFrontRatio:0.13,ownStrain:0.13}
    }
};

// Observer scheduler priorities
const OBS_PRI = { ONESHOT:100, WAR:80, DEPOSIT:60, MONITOR:50, SWEEP:10 };
const OBS_REQ_TIMEOUT = 100;     // drop unfulfilled scheduler requests after this many ticks

// Room registry
const REG_SWEEP_INTERVAL = 2000; // ticks between automatic sweeps (override: Memory.roomRegistry.interval)
const REG_FRESH_TICKS    = 20000;// registry considered "fresh" within this window
const REG_SWEEP_TIMEOUT  = 8000; // force-finalize a sweep that can't finish (lost observer etc.)

// Player monitor
const STATUS = { ALLY:'ALLY', NEUTRAL:'NEUTRAL', ENEMY:'ENEMY', WAR:'WAR' };
const POLL_INTERVAL = { ALLY:1000, NEUTRAL:1000, ENEMY:1000, WAR:100 };
const NOTIFY_COOLDOWN = 30;      // Game.notify group interval (minutes)
const MON_AWAIT_TIMEOUT = 200;   // give up waiting for visibility on a hot-poll after this
const ALERT_FILTER = {
    ALLY: [
        'RCL_UPGRADED', 'RCL_DOWNGRADED', 'ROOM_LOST', 'NO_CREEPS',
        'SPAWNS_DRAINED', 'TOWERS_EMPTY', 'SAFE_MODE', 'NEW_ROOM'
    ],
    NEUTRAL: [
        'RCL_UPGRADED', 'RCL_DOWNGRADED', 'ROOM_LOST', 'NO_CREEPS',
        'SPAWNS_DRAINED', 'TOWERS_EMPTY', 'SAFE_MODE', 'NEW_ROOM',
        'NUKER_BUILT', 'NUKER_FILLING_G', 'NUKER_FILLING_E',
        'MILITARY_CREEPS', 'BOOSTED_CREEPS'
    ],
    ENEMY: null,   // null = all alerts
    WAR:   null    // null = all alerts
};

// ════════════════════════════════════════════════════════════════════════════
// SHARED: ROOM COORDINATES
// ════════════════════════════════════════════════════════════════════════════

function parseRoomCoords(roomName) {
    const m = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!m) return null;
    let x = parseInt(m[2], 10), y = parseInt(m[4], 10);
    if (m[1] === 'W') x = -x - 1;
    if (m[3] === 'S') y = -y - 1;
    return { x, y };
}

function toRoomName(wx, wy) {
    // Inverse of parseRoomCoords: W and S are the negative half-axes.
    // (The original mapped negative y to 'N', mirroring every generated room
    // name across the equator — roomsInRange / playerAnalysis / wideScan were
    // all scanning the wrong hemisphere.)
    return (wx<0?'W'+(-wx-1):'E'+wx) + (wy<0?'S'+(-wy-1):'N'+wy);
}

function roomsInRange(centerRoom, range) {
    const c = parseRoomCoords(centerRoom);
    if (!c) return [];
    const rooms = [];
    for (let dx = -range; dx <= range; dx++)
        for (let dy = -range; dy <= range; dy++)
            rooms.push(toRoomName(c.x+dx, c.y+dy));
    return rooms;
}

function getRoomDistance(room1, room2) {
    const c1 = parseRoomCoords(room1), c2 = parseRoomCoords(room2);
    if (!c1 || !c2) return Infinity;
    return Math.max(Math.abs(c1.x-c2.x), Math.abs(c1.y-c2.y));
}

function canNuke(fromRoom, toRoom) { return getRoomDistance(fromRoom, toRoom) <= NUKE_RANGE; }

function avgDistanceBetweenRooms(rooms) {
    if (rooms.length < 2) return 0;
    let total=0, count=0;
    for (let i=0;i<rooms.length;i++) for (let j=i+1;j<rooms.length;j++) { total+=getRoomDistance(rooms[i],rooms[j]); count++; }
    return count > 0 ? total/count : 0;
}

/** True if the room can ever be player-claimed (not highway / SK / sector center) */
function isClaimableRoom(roomName) {
    const m = roomName.match(/^[WE](\d+)[NS](\d+)$/);
    if (!m) return false;
    const x = parseInt(m[1], 10) % 10, y = parseInt(m[2], 10) % 10;
    if (x === 0 || y === 0) return false;                  // highway
    if (x >= 4 && x <= 6 && y >= 4 && y <= 6) return false; // SK ring + sector center
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED: OBSERVER MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Tick-scoped observer booking set, shared by EVERY consumer in this module
 * and by external modules going through the scheduler. Lives in global so it
 * resets naturally on global resets and costs nothing in Memory.
 */
function _tickUsedSet() {
    if (!global.__obsUsed || global.__obsUsed.tick !== Game.time)
        global.__obsUsed = { tick: Game.time, set: new Set() };
    return global.__obsUsed.set;
}

/** Observe roomName with obs iff the observer hasn't been booked this tick. */
function _tickObserve(obs, roomName) {
    const used = _tickUsedSet();
    if (!obs || used.has(obs.id)) return false;
    if (obs.observeRoom(roomName) === OK) { used.add(obs.id); return true; }
    return false;
}

/** { roomName → observer } for all owned rooms that have a structural observer.
 *  Per-tick memoized in global.__obsMapCache — all callers in a tick share one
 *  map (structures cannot appear/disappear mid-tick). Callers must not mutate
 *  the returned map. */
function getObserverMap() {
    if (global.__obsMapCache && global.__obsMapCache.tick === Game.time) {
        return global.__obsMapCache.map;
    }
    const map = {};
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        const obs = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_OBSERVER })[0];
        if (obs) map[roomName] = obs;
    }
    global.__obsMapCache = { tick: Game.time, map: map };
    return map;
}

/** Best single observer that can see targetRoom; optionally exclude a used Set.
 *  Iterates the per-tick memoized observer map (no per-owned-room find). In
 *  owned rooms FIND_STRUCTURES filtered by OBSERVER == FIND_MY_STRUCTURES
 *  filtered by OBSERVER (observers in your own rooms are always yours), so the
 *  cached map is equivalent to the previous per-room scan. */
function findObserverInRange(targetRoom, usedSet) {
    const tc = parseRoomCoords(targetRoom);
    if (!tc) return null;
    const obsMap = getObserverMap();
    let best=null, bestDist=Infinity;
    for (const roomName in obsMap) {
        const obs = obsMap[roomName];
        if (usedSet && usedSet.has(obs.id)) continue;
        const oc = parseRoomCoords(roomName);
        if (!oc) continue;
        const dist = Math.max(Math.abs(tc.x-oc.x), Math.abs(tc.y-oc.y));
        if (dist <= OBSERVER_RANGE && dist < bestDist) { best=obs; bestDist=dist; }
    }
    return best;
}

/** All observers in range sorted closest-first (returns array).
 *  Iterates the per-tick memoized observer map (no per-owned-room find). */
function findObserversInRange(targetRoom) {
    const tc = parseRoomCoords(targetRoom);
    if (!tc) return [];
    const obsMap = getObserverMap();
    const results = [];
    for (const roomName in obsMap) {
        const oc = parseRoomCoords(roomName);
        if (!oc) continue;
        const dist = Math.max(Math.abs(tc.x-oc.x), Math.abs(tc.y-oc.y));
        if (dist <= OBSERVER_RANGE) results.push({ obs: obsMap[roomName], dist });
    }
    results.sort((a,b) => a.dist-b.dist);
    return results.map(r => r.obs);
}

/** Find best observer using pre-built observerMap */
function findObserverForRoom(targetRoom, observerMap) {
    const tc = parseRoomCoords(targetRoom);
    if (!tc) return null;
    for (const obsRoom in observerMap) {
        const oc = parseRoomCoords(obsRoom);
        if (oc && Math.max(Math.abs(tc.x-oc.x), Math.abs(tc.y-oc.y)) <= OBSERVER_RANGE)
            return observerMap[obsRoom];
    }
    return null;
}

/** Find ALL observers that can see targetRoom using pre-built observerMap */
function findAllObserversForRoom(targetRoom, observerMap) {
    const tc = parseRoomCoords(targetRoom);
    if (!tc) return [];
    return Object.entries(observerMap)
        .filter(([obsRoom]) => { const oc=parseRoomCoords(obsRoom); return oc && Math.max(Math.abs(tc.x-oc.x),Math.abs(tc.y-oc.y))<=OBSERVER_RANGE; })
        .map(([,obs]) => obs);
}

/** Observe a room, tracking used observer IDs (caller's set AND the shared tick set) */
function tryObserveRoom(roomName, usedObservers) {
    const shared = _tickUsedSet();
    let exclude = shared;
    if (usedObservers && usedObservers.size > 0) {
        exclude = new Set(shared);
        for (const id of usedObservers) exclude.add(id);
    }
    const obs = findObserverInRange(roomName, exclude);
    if (!obs) return false;
    if (obs.observeRoom(roomName) === OK) {
        shared.add(obs.id);
        if (usedObservers) usedObservers.add(obs.id);
        return true;
    }
    return false;
}

/** Try PWR_OPERATE_OBSERVER via roleOperator; returns info object or null */
function tryPowerObserver(roomName) {
    try {
        const ro = require('roleOperator');
        if (ro && typeof ro.findPowerObserver === 'function') return ro.findPowerObserver(roomName);
    } catch (e) {}
    return null;
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED: MARKET PRICE HELPERS
// ════════════════════════════════════════════════════════════════════════════

/** Best-effort buy price: tries marketBuy.computeBuyPrice, then lowest sell order */
function getMarketBuyPrice(resource) {
    try { const mb=require('marketBuy'); if (mb&&typeof mb.computeBuyPrice==='function') return mb.computeBuyPrice(resource); } catch(e){}
    try {
        const orders=Game.market.getAllOrders({ type:ORDER_SELL, resourceType:resource });
        if (!orders||orders.length===0) return 0;
        return Math.min(...orders.map(o=>o.price));
    } catch(e) { return 0; }
}

/** 2-day historical average price (used by roomIntel scoring) */
function getMarketHistoryPrice(resourceType) {
    try {
        const hist=Game.market.getHistory(resourceType)||[];
        let count=0, sum=0;
        if (hist.length>=1){const h=hist[hist.length-1];if(h&&typeof h.avgPrice==='number'){sum+=h.avgPrice;count++;}}
        if (hist.length>=2){const h=hist[hist.length-2];if(h&&typeof h.avgPrice==='number'){sum+=h.avgPrice;count++;}}
        return count>0 ? sum/count : 0;
    } catch(e) { return 0; }
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED: FORMATTING
// ════════════════════════════════════════════════════════════════════════════

function fmtNum(n) {
    if (!n) return '0';
    if (n>=1000000) return (n/1000000).toFixed(1)+'M';
    if (n>=1000) return (n/1000).toFixed(1)+'k';
    return String(Math.round(n));
}
function fmtCr(n) {
    if (!n) return '0 cr';
    if (n>=1000000) return (n/1000000).toFixed(2)+'M cr';
    if (n>=1000) return (n/1000).toFixed(1)+'k cr';
    return Math.round(n)+' cr';
}
function fmtE(e) { return e>=1000000?(e/1000000).toFixed(2)+'M':e>=1000?(e/1000).toFixed(1)+'k':Math.round(e).toString(); }
function dailyCost(ept) { return fmtE(ept*TICKS_PER_DAY); }
function r1(n) { return Math.round(n*10)/10; }
function r2(n) { return Math.round(n*100)/100; }
function r3(n) { return Math.round(n*1000)/1000; }
function yn(v) { return v?'Y':'N'; }
function clamp(n) { return Math.max(0,Math.min(100,n)); }


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████  MAINTENANCE SCANNER  █████████████████████████████
// ════════════════════════════════════════════════════════════════════════════

function _mtTowerHPE(range) {
    if (range<=TOWER_OPTIMAL_RANGE) return TOWER_MAX_REPAIR/TOWER_ENERGY_COST;
    if (range>=TOWER_FALLOFF_RANGE) return TOWER_MIN_REPAIR/TOWER_ENERGY_COST;
    const t=(range-TOWER_OPTIMAL_RANGE)/(TOWER_FALLOFF_RANGE-TOWER_OPTIMAL_RANGE);
    return (TOWER_MAX_REPAIR-t*(TOWER_MAX_REPAIR-TOWER_MIN_REPAIR))/TOWER_ENERGY_COST;
}
function _mtTowerHPEForStruct(s, towers) {
    if (!towers||!towers.length) return TOWER_FALLBACK_HPE;
    let minR=Infinity;
    for (const t of towers) { const r=Math.max(Math.abs(s.pos.x-t.pos.x),Math.abs(s.pos.y-t.pos.y)); if(r<minR)minR=r; }
    return _mtTowerHPE(minR);
}
function _mtIsTunnel(s) {
    if (typeof STRUCTURE_TUNNEL!=='undefined'&&s.structureType===STRUCTURE_TUNNEL) return true;
    if (s.structureType==='tunnel') return true;
    return false;
}
function _mtScanRoom(room, roomName, addFn) {
    const towers=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TOWER});
    const hasTowers=towers.length>0;
    const claimed=!!(room.controller&&room.controller.owner);
    const terrain=room.getTerrain();
    for (const s of room.find(FIND_STRUCTURES)) {
        const hpe=_mtTowerHPEForStruct(s,towers);
        if (_mtIsTunnel(s)) { addFn(roomName,'tunnel',15.0/CREEP_REPAIR_HITS,15.0/hpe,hasTowers); continue; }
        if (s.structureType===STRUCTURE_ROAD) {
            const swamp=(terrain.get(s.pos.x,s.pos.y)&TERRAIN_MASK_SWAMP)===TERRAIN_MASK_SWAMP;
            const dpt=swamp?ROAD_SWAMP_DPT:ROAD_PLAIN_DPT;
            addFn(roomName,swamp?'road_swamp':'road_plain',dpt/CREEP_REPAIR_HITS,dpt/hpe,hasTowers);
            continue;
        }
        if (s.structureType===STRUCTURE_RAMPART) { addFn(roomName,'rampart',RAMPART_DPT/CREEP_REPAIR_HITS,RAMPART_DPT/hpe,hasTowers); continue; }
        if (s.structureType===STRUCTURE_CONTAINER) {
            const dpt=claimed?CONTAINER_OWNED_DPT:CONTAINER_UNOWNED_DPT;
            addFn(roomName,claimed?'container_claimed':'container_unclaimed',dpt/CREEP_REPAIR_HITS,dpt/hpe,hasTowers);
        }
    }
}
function _mtRound(summary) {
    summary.totalEptCreep=Math.round(summary.totalEptCreep*1000)/1000;
    summary.totalEptTower=Math.round(summary.totalEptTower*1000)/1000;
    for (const k in summary.rooms) {
        const r=summary.rooms[k];
        r.totalEptCreep=Math.round(r.totalEptCreep*1000)/1000;
        r.totalEptTower=Math.round(r.totalEptTower*1000)/1000;
        for (const tk in r.types) { r.types[tk].eptCreep=Math.round(r.types[tk].eptCreep*1000)/1000; r.types[tk].eptTower=Math.round(r.types[tk].eptTower*1000)/1000; }
    }
    return summary;
}
function _mtAdd(summary, roomName, typeKey, eptCreep, eptTower, towerExact) {
    if (!summary.rooms[roomName]) summary.rooms[roomName]={totalEptCreep:0,totalEptTower:0,towerExact:false,count:0,types:{}};
    const r=summary.rooms[roomName];
    r.totalEptCreep+=eptCreep; r.totalEptTower+=eptTower;
    if (towerExact) r.towerExact=true; r.count++;
    if (!r.types[typeKey]) r.types[typeKey]={eptCreep:0,eptTower:0,count:0};
    r.types[typeKey].eptCreep+=eptCreep; r.types[typeKey].eptTower+=eptTower; r.types[typeKey].count++;
    summary.totalEptCreep+=eptCreep; summary.totalEptTower+=eptTower;
}

/** Raw scan data for all visible rooms */
function maintScan() {
    const summary={totalEptCreep:0,totalEptTower:0,rooms:{}};
    for (const rn in Game.rooms) { const room=Game.rooms[rn]; if(room) _mtScanRoom(room,rn,(rn,tk,ec,et,te)=>_mtAdd(summary,rn,tk,ec,et,te)); }
    return _mtRound(summary);
}

function _mtPrint(data) {
    console.log('[maint-scan] Total — creep: '+data.totalEptCreep+' en/tick ('+dailyCost(data.totalEptCreep)+'/day) | tower: '+data.totalEptTower+' en/tick ('+dailyCost(data.totalEptTower)+'/day)');
    const rooms=Object.entries(data.rooms).map(([name,info])=>({name,info}));
    rooms.sort((a,b)=>b.info.totalEptCreep-a.info.totalEptCreep);
    console.log('[maint-scan] Rooms (desc by creep en/tick):');
    for (const r of rooms) {
        const tLabel=r.info.towerExact?'tower (actual)':'tower (est. '+TOWER_FALLBACK_HPE+' hits/e)';
        console.log('  - '+r.name+': creep '+r.info.totalEptCreep+' ('+dailyCost(r.info.totalEptCreep)+'/day) | '+tLabel+' '+r.info.totalEptTower+' ('+dailyCost(r.info.totalEptTower)+'/day) en/tick (structures '+r.info.count+')');
        const types=Object.entries(r.info.types).sort((a,b)=>b[1].eptCreep-a[1].eptCreep);
        for (const [tk,t] of types)
            console.log('      - '+tk+': creep '+t.eptCreep+' ('+dailyCost(t.eptCreep)+'/day) | tower '+t.eptTower+' ('+dailyCost(t.eptTower)+'/day) en/tick (count '+t.count+')');
    }
}

/** Print maintenance report for all visible rooms or one specific room */
function maintPrint(filterRoom) {
    if (filterRoom) {
        const room=Game.rooms[filterRoom];
        if (!room) { console.log('[maint-scan] '+filterRoom+' not visible. Use maintScanRoom(\''+filterRoom+'\') to observe it.'); return; }
        const summary={totalEptCreep:0,totalEptTower:0,rooms:{}};
        _mtScanRoom(room,filterRoom,(rn,tk,ec,et,te)=>_mtAdd(summary,rn,tk,ec,et,te));
        _mtPrint(_mtRound(summary)); return;
    }
    _mtPrint(maintScan());
}

/** Scan one room; uses observer fallback if not visible */
function maintScanRoom(roomName) {
    if (!roomName||typeof roomName!=='string') return '[maint-scan] Usage: maintScanRoom("W1N1")';
    if (!Memory.maintScan) Memory.maintScan={};
    if (!Memory.maintScan.pending) Memory.maintScan.pending={};
    const room=Game.rooms[roomName];
    if (room) { _mtWipe(roomName); maintPrint(roomName); return null; }

    const obs=findObserverInRange(roomName,_tickUsedSet());
    if (obs) {
        if (_tickObserve(obs,roomName)) { Memory.maintScan.pending[roomName]={tick:Game.time,observerRoom:obs.room.name}; return '[maint-scan] 🔭 observing '+roomName+' from '+obs.room.name+' — auto-completing next tick'; }
        console.log('[maint-scan] Observer in '+obs.room.name+' busy or failed — queued for the scheduler');
        Memory.maintScan.pending[roomName]={tick:Game.time,observerRoom:obs.room.name};
        return '[maint-scan] 🔭 queued '+roomName+' — the scheduler will observe it shortly';
    }
    const po=tryPowerObserver(roomName);
    if (po) {
        if (!Memory.maintScan.powerObs) Memory.maintScan.powerObs={};
        Memory.maintScan.powerObs[roomName]={operatorName:po.operatorName,operatorRoom:po.operatorRoom,tick:Game.time};
        Memory.maintScan.pending[roomName]={tick:Game.time,observerRoom:po.operatorRoom,poweredObserver:true};
        return '[maint-scan] 🔭⚡ PWR_OPERATE_OBSERVER from '+po.operatorName+' — auto-completing when '+roomName+' is visible';
    }
    return '[maint-scan] ERROR: '+roomName+' not visible, no observer in range — send a scout';
}
function _mtWipe(roomName) {
    if (!Memory.maintScan) return;
    if (Memory.maintScan.pending)  delete Memory.maintScan.pending[roomName];
    if (Memory.maintScan.powerObs) delete Memory.maintScan.powerObs[roomName];
}
function _processMaintPending() {
    if (!Memory.maintScan||!Memory.maintScan.pending) return;
    for (const roomName in Memory.maintScan.pending) {
        const p=Memory.maintScan.pending[roomName], age=Game.time-p.tick;
        if (Game.rooms[roomName]) { console.log('[maint-scan] 🔭 Auto-completing scan for '+roomName); _mtWipe(roomName); maintPrint(roomName); }
        else if (p.poweredObserver) { const po=Memory.maintScan.powerObs&&Memory.maintScan.powerObs[roomName]; if(po&&Game.time-po.tick>100){console.log('[maint-scan] ⚠️  Power-observe timed out for '+roomName+'. Clearing.');_mtWipe(roomName);} }
        else if (age>=5) { console.log('[maint-scan] ⚠️  Timed out waiting for '+roomName+' after '+age+' ticks.'); _mtWipe(roomName); }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████████  ROOM INTEL  ██████████████████████████████████
// ════════════════════════════════════════════════════════════════════════════

// Lazily populate STRUCT_COST_MAP on first use (needs Screeps constants)
function _getStructCost(type) {
    if (Object.keys(STRUCT_COST_MAP).length===0) {
        STRUCT_COST_MAP[STRUCTURE_SPAWN]=15000; STRUCT_COST_MAP[STRUCTURE_EXTENSION]=3000;
        STRUCT_COST_MAP[STRUCTURE_ROAD]=300;    STRUCT_COST_MAP[STRUCTURE_LINK]=5000;
        STRUCT_COST_MAP[STRUCTURE_STORAGE]=30000; STRUCT_COST_MAP[STRUCTURE_TOWER]=5000;
        STRUCT_COST_MAP[STRUCTURE_OBSERVER]=8000; STRUCT_COST_MAP[STRUCTURE_POWER_SPAWN]=100000;
        STRUCT_COST_MAP[STRUCTURE_EXTRACTOR]=5000; STRUCT_COST_MAP[STRUCTURE_LAB]=50000;
        STRUCT_COST_MAP[STRUCTURE_TERMINAL]=100000; STRUCT_COST_MAP[STRUCTURE_CONTAINER]=5000;
        STRUCT_COST_MAP[STRUCTURE_NUKER]=100000; STRUCT_COST_MAP[STRUCTURE_FACTORY]=100000;
    }
    return STRUCT_COST_MAP[type]||0;
}

/**
 * Single-pass room cache. Walks FIND_STRUCTURES / FIND_CREEPS / FIND_SOURCES / etc.
 * once, groups structures by type, and indexes hostiles by owner. Pass this
 * into the intel / value / analyze functions to avoid the ~10 redundant
 * room.find(FIND_STRUCTURES, ...) calls they would otherwise each make.
 *
 * Per-tick memoized in global.__fpCache keyed by room name: all callers in a
 * tick share one fingerprint per room (structures don't change mid-tick). The
 * dynamic finds (creeps/dropped/nukes) are also frozen at first-call time,
 * giving all callers a consistent snapshot rather than slightly-different
 * mid-tick views. Callers must not mutate the returned fp or its arrays.
 */
function _roomFingerprint(room) {
    const roomName = room.name;
    if (!global.__fpCache || global.__fpCache.tick !== Game.time) {
        global.__fpCache = { tick: Game.time, byRoom: Object.create(null) };
    } else if (global.__fpCache.byRoom[roomName]) {
        return global.__fpCache.byRoom[roomName];
    }
    const fp = {
        byType: Object.create(null),
        allStructures: room.find(FIND_STRUCTURES),
        creeps: room.find(FIND_CREEPS),
        myCreeps: room.find(FIND_MY_CREEPS),
        powerCreeps: room.find(FIND_POWER_CREEPS),
        hostiles: room.find(FIND_HOSTILE_CREEPS),
        hostilesByOwner: Object.create(null),
        sources: room.find(FIND_SOURCES),
        minerals: room.find(FIND_MINERALS),
        dropped: room.find(FIND_DROPPED_RESOURCES),
        nukes: room.find(FIND_NUKES),
        construction: room.find(FIND_CONSTRUCTION_SITES),
    };
    for (const s of fp.allStructures) (fp.byType[s.structureType] || (fp.byType[s.structureType] = [])).push(s);
    for (const c of fp.hostiles) (fp.hostilesByOwner[c.owner.username] || (fp.hostilesByOwner[c.owner.username] = [])).push(c);
    global.__fpCache.byRoom[roomName] = fp;
    return fp;
}
function _fpByType(fp, type) { return fp.byType[type] || EMPTY_ARR; }
const EMPTY_ARR = [];

function _itTowerHPE(range) {
    if (range<=TOWER_OPTIMAL_RANGE) return TOWER_MAX_REPAIR/TOWER_ENERGY_COST;
    if (range>=TOWER_FALLOFF_RANGE) return TOWER_MIN_REPAIR/TOWER_ENERGY_COST;
    return (TOWER_MAX_REPAIR-((range-TOWER_OPTIMAL_RANGE)/(TOWER_FALLOFF_RANGE-TOWER_OPTIMAL_RANGE))*(TOWER_MAX_REPAIR-TOWER_MIN_REPAIR))/TOWER_ENERGY_COST;
}
function _itTowerHPEForStruct(s, towers) {
    if (!towers||!towers.length) return TOWER_FALLBACK_HPE;
    let minR=Infinity;
    for (const t of towers) { const r=Math.max(Math.abs(s.pos.x-t.pos.x),Math.abs(s.pos.y-t.pos.y)); if(r<minR)minR=r; }
    return _itTowerHPE(minR);
}
function _itCalcMaint(room) {
    const towers=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TOWER});
    const terrain=room.getTerrain(), owned=!!(room.controller&&room.controller.owner);
    let eptCreep=0, eptTower=0;
    for (const s of room.find(FIND_STRUCTURES)) {
        let dpt=0;
        if (s.structureType===STRUCTURE_ROAD) dpt=(terrain.get(s.pos.x,s.pos.y)&TERRAIN_MASK_SWAMP)?ROAD_SWAMP_DPT:ROAD_PLAIN_DPT;
        else if (s.structureType===STRUCTURE_RAMPART) dpt=RAMPART_DPT;
        else if (s.structureType===STRUCTURE_CONTAINER) dpt=owned?CONTAINER_OWNED_DPT:CONTAINER_UNOWNED_DPT;
        else continue;
        eptCreep+=dpt/CREEP_REPAIR_HITS; eptTower+=dpt/_itTowerHPEForStruct(s,towers);
    }
    return {eptCreep:r2(eptCreep),eptTower:r2(eptTower)};
}
function _itSourceMaxRate(source) {
    let maxRate=(source.energyCapacity||SOURCE_ENERGY_CAPACITY)/ENERGY_REGEN_TIME;
    if (source.effects&&source.effects.length) {
        for (const eff of source.effects) {
            if (eff.effect!==PWR_REGEN_SOURCE) continue;
            const info=(typeof POWER_INFO!=='undefined')?POWER_INFO[PWR_REGEN_SOURCE]:null;
            const level=eff.level||1;
            const perCycle=(info&&info.effect&&info.effect[level-1])||0;
            const period=(info&&info.period)||15;
            if (period>0) maxRate+=perCycle/period;
        }
    }
    return maxRate;
}

// ── Intel: Value calculators ──────────────────────────────────────────────
function _itCalcEcoValue(room, fp) {
    fp = fp || _roomFingerprint(room);
    const ep=getMarketHistoryPrice(RESOURCE_ENERGY);
    const labs=_fpByType(fp,STRUCTURE_LAB);
    const factory=_fpByType(fp,STRUCTURE_FACTORY)[0];
    const links=_fpByType(fp,STRUCTURE_LINK);
    const containers=_fpByType(fp,STRUCTURE_CONTAINER);
    const extractor=_fpByType(fp,STRUCTURE_EXTRACTOR)[0];
    const storage=room.storage;
    const terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
    const structE=(extractor?_getStructCost(STRUCTURE_EXTRACTOR):0)+labs.length*_getStructCost(STRUCTURE_LAB)+(factory?_getStructCost(STRUCTURE_FACTORY):0)+links.length*_getStructCost(STRUCTURE_LINK)+containers.length*_getStructCost(STRUCTURE_CONTAINER);
    const structCr=structE*ep;
    const combatSet=new Set(INTEL_COMBAT_BOOSTS);
    let resCr=0;
    for (const store of [storage&&storage.store,terminal&&terminal.store,...labs.map(l=>l.store),factory&&factory.store].filter(Boolean))
        for (const res in store) if (res!==RESOURCE_ENERGY&&!combatSet.has(res)&&store[res]) resCr+=store[res]*getMarketHistoryPrice(res);
    return {total:Math.round(structCr+resCr),structureCredits:Math.round(structCr),resourceCredits:Math.round(resCr)};
}
function _itCalcMilValue(room, fp) {
    fp = fp || _roomFingerprint(room);
    const ep=getMarketHistoryPrice(RESOURCE_ENERGY);
    let structCr=0, resCr=0;
    const towers=_fpByType(fp,STRUCTURE_TOWER);
    const nuker=_fpByType(fp,STRUCTURE_NUKER)[0];
    const ramparts=_fpByType(fp,STRUCTURE_RAMPART);
    const walls=_fpByType(fp,STRUCTURE_WALL);
    const storage=room.storage;
    const terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
    const labs=_fpByType(fp,STRUCTURE_LAB);
    let tE=towers.length*_getStructCost(STRUCTURE_TOWER); for(const t of towers)tE+=(t.store&&t.store[RESOURCE_ENERGY])||0; structCr+=tE*ep;
    if (nuker){structCr+=(_getStructCost(STRUCTURE_NUKER)+((nuker.store&&nuker.store[RESOURCE_ENERGY])||0))*ep;const g=(nuker.store&&nuker.store[RESOURCE_GHODIUM])||0;if(g>0)resCr+=g*getMarketHistoryPrice(RESOURCE_GHODIUM);}
    let defHP=0; for(const d of ramparts)defHP+=d.hits; for(const d of walls)defHP+=d.hits; structCr+=(defHP/100)*ep;
    const stores=[storage&&storage.store,terminal&&terminal.store,...labs.map(l=>l.store)].filter(Boolean);
    for(const res of INTEL_COMBAT_BOOSTS){let amt=0;for(const s of stores)if(s[res])amt+=s[res];if(amt>0)resCr+=amt*getMarketHistoryPrice(res);}
    return {total:Math.round(structCr+resCr),structureCredits:Math.round(structCr),resourceCredits:Math.round(resCr)};
}
function _itCalcDPValue(room, fp) {
    fp = fp || _roomFingerprint(room);
    const ep=getMarketHistoryPrice(RESOURCE_ENERGY);
    const spawns=_fpByType(fp,STRUCTURE_SPAWN);
    const extensions=_fpByType(fp,STRUCTURE_EXTENSION);
    const powerSpawn=_fpByType(fp,STRUCTURE_POWER_SPAWN)[0];
    const terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
    const storage=room.storage;
    const observer=_fpByType(fp,STRUCTURE_OBSERVER)[0];
    const structCr=(spawns.length*_getStructCost(STRUCTURE_SPAWN)+extensions.length*_getStructCost(STRUCTURE_EXTENSION)+(storage?_getStructCost(STRUCTURE_STORAGE):0)+(terminal?_getStructCost(STRUCTURE_TERMINAL):0)+(powerSpawn?_getStructCost(STRUCTURE_POWER_SPAWN):0)+(observer?_getStructCost(STRUCTURE_OBSERVER):0))*ep;
    let totalE=0,totalP=0;
    for(const st of [storage,terminal,powerSpawn].filter(Boolean)){totalE+=(st.store&&st.store[RESOURCE_ENERGY])||0;totalP+=(st.store&&st.store[RESOURCE_POWER])||0;}
    const resCr=totalE*ep+(totalP>0?totalP*getMarketHistoryPrice(RESOURCE_POWER):0);
    return {total:Math.round(structCr+resCr),structureCredits:Math.round(structCr),resourceCredits:Math.round(resCr)};
}

// ── Intel: Efficiency profiler snapshots ─────────────────────────────────
function _itTakeSnap(room) {
    const snap={sources:{},towers:{},labs:{},factory:null,terminal:null,spawns:{},creepPos:{},totalCreeps:0};
    for(const s of room.find(FIND_SOURCES))snap.sources[s.id]=s.energy;
    for(const s of room.find(FIND_STRUCTURES)){
        if(s.structureType===STRUCTURE_TOWER)snap.towers[s.id]=s.store[RESOURCE_ENERGY];
        else if(s.structureType===STRUCTURE_LAB)snap.labs[s.id]=s.cooldown||0;
        else if(s.structureType===STRUCTURE_FACTORY)snap.factory={cooldown:s.cooldown||0};
        else if(s.structureType===STRUCTURE_POWER_SPAWN){}
        else if(s.structureType===STRUCTURE_TERMINAL){const st={};for(const r in s.store)if(s.store[r]>0)st[r]=s.store[r];snap.terminal={cooldown:s.cooldown||0,used:s.store.getUsedCapacity(),store:st};}
        else if(s.structureType===STRUCTURE_SPAWN)snap.spawns[s.id]=(s.spawning&&s.spawning.body)?{body:s.spawning.body.slice()}:null;
    }
    const creeps=room.find(FIND_CREEPS); snap.totalCreeps=creeps.length;
    for(const c of creeps)snap.creepPos[c.id]={x:c.pos.x,y:c.pos.y};
    return snap;
}
function _itInitTotals() {
    return {ticksObserved:0,invisibleTicks:0,energyHarvested:0,theoreticalMax:0,towerEnergyFired:0,spawnCostAccum:0,upgradeEnergySpent:0,creepMoves:0,creepCountSum:0,totalIntents:0,productiveIntents:0,buildTicks:0,ev_harvest:0,ev_upgradeController:0,ev_build:0,ev_transfer:0,ev_repairAny:0,ev_attack:0,ev_heal:0,ev_power:0,terminalSends:0,terminalFlux:0,terminalIn:{},terminalOut:{},labReactions:0,factoryProduces:0,spawnEvents:0,labCount:0,hasLabs:false,hasFactory:false,hasTerminal:false,sourceCount:0,sourcePositions:{},sourceStartEnergy:{},sourceExtracted:{},sourceRegen:{},sourceDepleted:{},sourceRegenTicks:{},sourceMaxRates:{},sourceHarvested:{},maintEptCreep:0};
}
function _itAccumulate(prev, curr, room, totals) {
    for(const srcId in totals.sourcePositions){
        const pE=prev.sources[srcId]!==undefined?prev.sources[srcId]:0,cE=curr.sources[srcId]!==undefined?curr.sources[srcId]:0;
        if(cE>pE)totals.sourceRegenTicks[srcId]=(totals.sourceRegenTicks[srcId]||0)+1;
        else totals.sourceExtracted[srcId]=(totals.sourceExtracted[srcId]||0)+Math.max(0,pE-cE);
        if(cE===0&&pE>0)totals.sourceDepleted[srcId]=true;
    }
    for(const id in curr.towers)if(prev.towers[id]!==undefined)totals.towerEnergyFired+=Math.max(0,prev.towers[id]-curr.towers[id]);
    for(const id in curr.labs)if(prev.labs[id]===0&&curr.labs[id]>0)totals.labReactions++;
    if(curr.factory&&prev.factory&&prev.factory.cooldown===0&&curr.factory.cooldown>0)totals.factoryProduces++;
    if(curr.terminal&&prev.terminal){
        if(prev.terminal.cooldown===0&&curr.terminal.cooldown>0)totals.terminalSends++;
        totals.terminalFlux+=Math.abs(curr.terminal.used-prev.terminal.used);
        const allR=new Set([...Object.keys(prev.terminal.store||{}),...Object.keys(curr.terminal.store||{})]);
        for(const res of allR){const pA=(prev.terminal.store||{})[res]||0,cA=(curr.terminal.store||{})[res]||0,d=cA-pA;if(d>0)totals.terminalIn[res]=(totals.terminalIn[res]||0)+d;else if(d<0)totals.terminalOut[res]=(totals.terminalOut[res]||0)+(-d);}
    }
    for(const id in curr.spawns){if(curr.spawns[id]&&!prev.spawns[id]){let cost=0;for(const p of curr.spawns[id].body)cost+=BODYPART_COST_MAP[p.type]||0;totals.spawnCostAccum+=cost;totals.spawnEvents++;}}
    for(const id in curr.creepPos){const c=curr.creepPos[id],p=prev.creepPos[id];if(p&&(c.x!==p.x||c.y!==p.y))totals.creepMoves++;}
    totals.creepCountSum+=curr.totalCreeps;
    let events; try{events=JSON.parse(room.getEventLog(true));}catch(e){events=room.getEventLog();}
    let hadBuild=false;
    if(events&&events.length)for(const ev of events){
        switch(ev.event){
            case EV_HARVEST:totals.ev_harvest++;totals.totalIntents++;totals.productiveIntents++;if(ev.data&&typeof ev.data.amount==='number'&&ev.data.resourceType===RESOURCE_ENERGY){totals.energyHarvested+=ev.data.amount;const tId=ev.data.targetId;if(tId&&totals.sourceMaxRates[tId]!==undefined)totals.sourceHarvested[tId]=(totals.sourceHarvested[tId]||0)+ev.data.amount;}break;
            case EV_UPGRADE_CONTROLLER:totals.ev_upgradeController++;totals.totalIntents++;totals.productiveIntents++;totals.upgradeEnergySpent+=(ev.data&&typeof ev.data.amount==='number')?ev.data.amount:1;break;
            case EV_BUILD:totals.ev_build++;totals.totalIntents++;totals.productiveIntents++;hadBuild=true;break;
            case EV_TRANSFER:totals.ev_transfer++;totals.totalIntents++;totals.productiveIntents++;break;
            case EV_REPAIR:totals.ev_repairAny++;totals.totalIntents++;break;
            case EV_ATTACK:totals.ev_attack++;totals.totalIntents++;break;
            case EV_HEAL:totals.ev_heal++;totals.totalIntents++;break;
            case EV_POWER:totals.ev_power++;totals.totalIntents++;totals.productiveIntents++;break;
            case EV_ATTACK_CONTROLLER:case EV_RESERVE_CONTROLLER:totals.totalIntents++;break;
        }
    }
    if(hadBuild)totals.buildTicks++;
    totals.ticksObserved++;
    let tickMax=0;for(const srcId in totals.sourceMaxRates)tickMax+=totals.sourceMaxRates[srcId];totals.theoreticalMax+=tickMax;
}

// ── Intel: Profile lifecycle ──────────────────────────────────────────────
function _itGetPrev(rn){return global[INTEL_EFF_GLOBAL_PREV]&&global[INTEL_EFF_GLOBAL_PREV][rn]||null;}
function _itSetPrev(rn,s){if(!global[INTEL_EFF_GLOBAL_PREV])global[INTEL_EFF_GLOBAL_PREV]={};global[INTEL_EFF_GLOBAL_PREV][rn]=s;}
function _itClearPrev(rn){if(global[INTEL_EFF_GLOBAL_PREV])delete global[INTEL_EFF_GLOBAL_PREV][rn];}

function _itFireObservers(roomName) {
    const obs=findObserversInRange(roomName);
    let fired=0;
    for(const o of obs){if(fired>=1)break;if(_tickObserve(o,roomName))fired++;}
    return fired;
}
function _itStartProfile(roomName, room) {
    if(!Memory[INTEL_EFF_MEM_KEY])Memory[INTEL_EFF_MEM_KEY]={};
    if(Memory[INTEL_EFF_MEM_KEY][roomName]&&Memory[INTEL_EFF_MEM_KEY][roomName].active)return;
    const maint=_itCalcMaint(room);
    const labs=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LAB});
    const factory=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_FACTORY})[0];
    const term=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];
    const sources=room.find(FIND_SOURCES);
    const totals=_itInitTotals();
    totals.maintEptCreep=maint.eptCreep;totals.labCount=labs.length;totals.hasLabs=labs.length>0;
    totals.hasFactory=!!factory;totals.hasTerminal=!!term;totals.sourceCount=sources.length;
    for(const s of sources){totals.sourcePositions[s.id]={x:s.pos.x,y:s.pos.y};totals.sourceStartEnergy[s.id]=s.energy;totals.sourceExtracted[s.id]=0;totals.sourceDepleted[s.id]=false;totals.sourceRegenTicks[s.id]=0;totals.sourceMaxRates[s.id]=_itSourceMaxRate(s);totals.sourceHarvested[s.id]=0;}
    Memory[INTEL_EFF_MEM_KEY][roomName]={active:true,roomName,startTick:Game.time,totals};
    _itFireObservers(roomName);
    console.log('[Intel] 📊 Efficiency profile started — '+roomName+' ('+INTEL_PROFILE_TICKS+' ticks)');
}
function _itProcessProfiles() {
    if(!Memory[INTEL_EFF_MEM_KEY])return;
    for(const roomName in Memory[INTEL_EFF_MEM_KEY]){
        const profile=Memory[INTEL_EFF_MEM_KEY][roomName];
        if(!profile||!profile.active)continue;
        if(!Game.rooms[roomName]||!(Game.rooms[roomName].controller&&Game.rooms[roomName].controller.my))_itFireObservers(roomName);
        const room=Game.rooms[roomName];
        if(!room){profile.totals.invisibleTicks++;continue;}
        const curr=_itTakeSnap(room),prev=_itGetPrev(roomName);
        if(!prev){_itSetPrev(roomName,curr);continue;}
        _itAccumulate(prev,curr,room,profile.totals);
        _itSetPrev(roomName,curr);
        const obs=profile.totals.ticksObserved;
        if(obs>0&&obs%25===0&&obs<INTEL_PROFILE_TICKS)console.log('[Intel] 📊 '+roomName+' efficiency: '+obs+'/'+INTEL_PROFILE_TICKS+' ticks');
        if(obs>=INTEL_PROFILE_TICKS)_itFinalise(roomName,profile);
    }
}
function _itFinalise(roomName, profile) {
    if(!Memory[INTEL_EFF_CACHE_KEY])Memory[INTEL_EFF_CACHE_KEY]={};
    Memory[INTEL_EFF_CACHE_KEY][roomName]={totals:profile.totals,completedTick:Game.time,expiresTick:Game.time+INTEL_EFF_EXPIRE};
    _itClearPrev(roomName);
    delete Memory[INTEL_EFF_MEM_KEY][roomName];
    console.log('[Intel] 📊 Efficiency profile complete — '+roomName+' ('+profile.totals.ticksObserved+' ticks). Generating full report...');
    if(Game.rooms[roomName])intel(roomName);
    else console.log('[Intel] '+roomName+' not visible this tick — call intel(\''+roomName+'\') manually.');
}
function _itGetCachedEff(roomName) {
    if(!Memory[INTEL_EFF_CACHE_KEY]||!Memory[INTEL_EFF_CACHE_KEY][roomName])return null;
    const c=Memory[INTEL_EFF_CACHE_KEY][roomName];
    if(c.expiresTick<=Game.time){delete Memory[INTEL_EFF_CACHE_KEY][roomName];return null;}
    return c;
}
function _itIsProfileActive(roomName){return !!(Memory[INTEL_EFF_MEM_KEY]&&Memory[INTEL_EFF_MEM_KEY][roomName]&&Memory[INTEL_EFF_MEM_KEY][roomName].active);}

function _itCalcEffCPU(t){
    const s=0.2,e=0.4,m=0.5;
    const sim=(t.ev_harvest||0)+(t.ev_upgradeController||0)+(t.ev_build||0)+(t.ev_transfer||0)+(t.ev_power||0)+(t.terminalSends||0)+(t.factoryProduces||0)+(t.spawnEvents||0);
    const total=sim*s+(t.labReactions||0)*e+(t.ev_repairAny||0)*e+((t.ev_attack||0)+(t.ev_heal||0))*s+(t.creepMoves||0)*m;
    return {totalMid:total,cpuPerCreep:(t.creepCountSum||0)>0?total/t.creepCountSum:null};
}


// ── Intel: Operational efficiency scoring ────────────────────────────────
function _itAnalyzeOperational(room, effCache) {
    let score=0;
    const pos={},neg={},det={};
    const t=effCache.totals, obs=Math.max(1,t.ticksObserved);
    const sourceHarv=t.sourceHarvested||{};
    const perFracs=[],perRates=[];
    for(const srcId in t.sourcePositions){const harv=sourceHarv[srcId]||0,maxR=t.sourceMaxRates[srcId]||10;perFracs.push(Math.min(1,harv/(obs*maxR)));perRates.push(maxR);}
    const avgFrac=perFracs.length>0?perFracs.reduce((s,v)=>s+v,0)/perFracs.length:0;
    const capScore=Math.min(25,avgFrac*25);
    if(capScore>0){pos.energyCaptureRate=r1(capScore);score+=capScore;}
    const totalHarv=Object.values(sourceHarv).reduce((s,v)=>s+v,0);
    const maxIncome=Object.values(t.sourceMaxRates).reduce((s,v)=>s+v,0);
    const incomeRate=Math.min(totalHarv/obs,maxIncome);
    det.energyCaptureRate=r1(avgFrac*100)+'%';det.incomePerTick=r1(incomeRate);det.maxIncomePerTick=r1(maxIncome);
    det.sourceFractions=perFracs.map(f=>r1(f*100)+'%').join(', ');det.sourceMaxRates=perRates.map(r=>r1(r)+' E/t').join(', ');
    det.energyHarvested=Math.round(totalHarv);det.sustainedUtilization=r1(maxIncome>0?incomeRate/maxIncome*100:0)+'%';

    const spendPT=t.maintEptCreep+t.spawnCostAccum/obs+t.upgradeEnergySpent/obs+t.towerEnergyFired/obs;
    const surplusPT=incomeRate-spendPT, surplusFrac=incomeRate>0?surplusPT/incomeRate:0;
    let surpScore=0;
    if(surplusFrac>=0){if(surplusFrac<=0.50)surpScore=20;else if(surplusFrac<=0.80)surpScore=20-((surplusFrac-0.50)/0.30)*10;else surpScore=Math.max(4,10-((surplusFrac-0.80)/0.20)*6);pos.incomeSurplus=r1(surpScore);score+=surpScore;}
    det.spendPerTick=r2(spendPT);det.surplusPerTick=r1(surplusPT);det.surplusFrac=r1(surplusFrac*100)+'%';
    det.maintPerTick=r2(t.maintEptCreep);det.spawnPerTick=r1(t.spawnCostAccum/obs);det.upgradePerTick=r1(t.upgradeEnergySpent/obs);det.towerCostPerTick=r1(t.towerEnergyFired/obs);

    const effCPU=_itCalcEffCPU(t),cpu=effCPU.cpuPerCreep;
    if(cpu!==null){const s=Math.max(0,16*(1-cpu/0.50));if(s>0){pos.cpuEfficiency=r1(s);score+=s;}}
    det.cpuPerCreep=cpu!==null?r3(cpu):'n/a';det.cpuTotalMid=cpu!==null?r2(effCPU.totalMid):0;

    const twm=t.totalIntents+t.creepMoves,prodR=twm>0?t.productiveIntents/twm:0;
    const prodS=prodR*13;if(prodS>0){pos.productiveIntentRatio=r1(prodS);score+=prodS;}
    det.productiveRatio=r1(prodR*100)+'%';det.productiveIntents=t.productiveIntents;det.totalIntents=twm;
    det.ev_harvest=t.ev_harvest||0;det.ev_build=t.ev_build||0;det.ev_upgradeController=t.ev_upgradeController||0;
    det.ev_transfer=t.ev_transfer||0;det.ev_repairAny=t.ev_repairAny||0;det.ev_attack=t.ev_attack||0;det.ev_heal=t.ev_heal||0;det.ev_power=t.ev_power||0;

    const towerRepA=Math.floor(t.towerEnergyFired/TOWER_ENERGY_COST),creepRepA=Math.max(0,t.ev_repairAny-towerRepA);
    let cRepShare;
    if(t.ev_repairAny===0){cRepShare=null;pos.creepRepairShare=6;score+=6;}
    else{cRepShare=creepRepA/t.ev_repairAny;const s=cRepShare*13;if(s>0){pos.creepRepairShare=r1(s);score+=s;}}
    det.towerRepairActions=towerRepA;det.creepRepairActions=creepRepA;det.totalRepairEvents=t.ev_repairAny;det.creepRepairShare=cRepShare!==null?r1(cRepShare*100)+'%':'N/A';

    const avgC=t.creepCountSum/obs,movePCT=avgC>0?t.creepMoves/(avgC*obs):0;
    const moveS=Math.max(0,13*(1-movePCT/1.0));if(moveS>0){pos.lowMovesPerCreep=r1(moveS);score+=moveS;}
    if(movePCT<0.1){pos.efficientMovementBonus=3;score+=3;}
    if(movePCT>0.7){neg.highMovesPerCreep=-10;score-=10;}else if(movePCT>0.4){neg.moderateMovesPerCreep=-5;score-=5;}
    det.movesPerCreepTick=r3(movePCT);det.totalCreepMoves=t.creepMoves;det.avgCreeps=r1(avgC);
    det.buildRate=r3(t.ev_build/obs)+'/tick';det.harvestRate=r3(t.ev_harvest/obs)+'/tick';
    det.upgradeRate=r3(t.ev_upgradeController/obs)+'/tick';det.transferRate=r3(t.ev_transfer/obs)+'/tick';
    det.ticksObserved=t.ticksObserved;det.invisibleTicks=t.invisibleTicks;
    det.terminalIn=t.terminalIn||{};det.terminalOut=t.terminalOut||{};det.hasTerminal=t.hasTerminal;

    if(surplusFrac<0){neg.energyDeficit=-15;score-=15;}
    if(cpu!==null&&cpu>=0.40){neg.highCpuPerCreep=-10;score-=10;}
    if(t.ev_repairAny>0&&cRepShare!==null&&cRepShare<0.30){neg.towerRepairDominant=-8;score-=8;}
    if(t.buildTicks>=obs*0.95){neg.sustainedBuildActivity=-5;score-=5;}
    return {score:Math.max(0,Math.min(100,score)),positives:pos,negatives:neg,details:det};
}

// ── Intel: Economic analyzer ──────────────────────────────────────────────
function _itAnalyzeEco(room, effCache, fp) {
    fp = fp || _roomFingerprint(room);
    let score=0;const pos={},neg={},det={};
    const factory=_fpByType(fp,STRUCTURE_FACTORY)[0];
    const extractor=_fpByType(fp,STRUCTURE_EXTRACTOR)[0];
    const storage=room.storage,terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
    const links=_fpByType(fp,STRUCTURE_LINK);
    const labs=_fpByType(fp,STRUCTURE_LAB);
    const containers=_fpByType(fp,STRUCTURE_CONTAINER);
    const sources=fp.sources,mineral=fp.minerals[0];
    const allRes=new Set();
    if(storage&&storage.store)Object.keys(storage.store).filter(k=>storage.store[k]>0).forEach(k=>allRes.add(k));
    if(terminal&&terminal.store)Object.keys(terminal.store).filter(k=>terminal.store[k]>0).forEach(k=>allRes.add(k));

    if(factory){pos.factoryExists=5;score+=5;det.factoryExists=true;const lvl=factory.level||0;if(lvl>=1){pos.factoryLeveled=5;score+=5;}det.factoryLevel=lvl;}else{det.factoryExists=false;det.factoryLevel=0;}
    if(extractor){pos.extractorExists=3;score+=3;det.extractorExists=true;let active=false;if(mineral)active=mineral.mineralAmount===0||mineral.pos.findInRange(FIND_CREEPS,1).length>0;if(active){pos.extractorActive=7;score+=7;}det.extractorActive=active;}else{det.extractorExists=false;det.extractorActive=false;}
    if(mineral){det.mineralType=mineral.mineralType;det.mineralAmount=mineral.mineralAmount;}
    const nonE=new Set();allRes.forEach(r=>{if(r!==RESOURCE_ENERGY)nonE.add(r);});
    const div=nonE.size;if(div>0){const ds=Math.min(25,div)/25*13;pos.storageDiversity=r1(ds);score+=ds;}det.storageDiversityCount=div;
    if(links.length>0){const ls=Math.min(links.length/4,1)*13;pos.linkCount=r1(ls);score+=ls;}det.linkCount=links.length;
    if(labs.length>0){const lbs=Math.min(labs.length/10,1)*5;pos.labCount=r1(lbs);score+=lbs;}
    const activeLabs=labs.filter(l=>l.cooldown>0||(l.mineralType&&l.store[l.mineralType]>0));
    if(activeLabs.length>0&&labs.length>0){const als=Math.min(activeLabs.length/labs.length,1)*5;pos.labsActive=r1(als);score+=als;}
    det.labCount=labs.length;det.activeLabCount=activeLabs.length;
    const roomOrders=Game.market.getAllOrders({roomName:room.name}).filter(o=>o.roomName===room.name);
    const buys=roomOrders.filter(o=>o.type===ORDER_BUY),sells=roomOrders.filter(o=>o.type===ORDER_SELL);
    det.marketTotalOrders=roomOrders.length;det.marketBuyOrders=buys.length;det.marketSellOrders=sells.length;
    det.sellOrderDetails=sells.map(o=>({resource:o.resourceType,amount:o.remainingAmount,price:o.price}));
    det.buyOrderDetails=buys.map(o=>({resource:o.resourceType,amount:o.remainingAmount,price:o.price}));
    if(roomOrders.length>0){pos.marketOrders=10;score+=10;}
    const chk=(list,key,pts)=>{const has=list.some(r=>allRes.has(r));det[key]=has;if(has){pos[key]=pts;score+=pts;}};
    chk(HIGHWAY_DEPOSITS,'hasHighwayDeposits',7);chk(COMPRESSED_COMMODITIES,'hasCompressedCommodities',7);
    chk(REGIONAL_COMMODITIES,'hasRegionalCommodities',7);chk(LEVEL_COMMODITIES,'hasLevelCommodities',7);chk(LAB_PRODUCTS_LIST,'hasLabProducts',6);
    if(effCache){
        const t=effCache.totals,obs=Math.max(1,t.ticksObserved);
        if(t.hasLabs&&t.labCount>0){const lu=t.labReactions/obs/t.labCount,ls=Math.min(1,lu/0.80)*8;if(ls>0){pos.labUtilization=r1(ls);score+=ls;}det.labUtilRate=r1(lu*100)+'%';}else{det.labUtilRate='0%';}
        det.labReactions=t.labReactions;
        if(t.hasTerminal){const sr=t.terminalSends/obs,ts=Math.min(1,sr/0.05)*5;if(ts>0){pos.terminalSendRate=r1(ts);score+=ts;}det.terminalSendRate=r3(sr)+'/tick';det.terminalFlux=Math.round(t.terminalFlux);}else{det.terminalSendRate='0';det.terminalFlux=0;}
        det.terminalSends=t.terminalSends;
        if(t.hasFactory){const fs=Math.min(5,t.factoryProduces);if(fs>0){pos.factoryUtilization=fs;score+=fs;}}det.factoryProduces=t.factoryProduces;
    }else{det.labUtilRate='n/a';det.labReactions=0;det.terminalSendRate='n/a';det.terminalFlux=0;det.terminalSends=0;det.factoryProduces=0;}
    if(storage&&storage.store){const fill=storage.store.getUsedCapacity()/storage.store.getCapacity()*100;det.storageFillPercent=Math.round(fill);if(fill>90){neg.storageNearlyFull=-10;score-=10;}}
    const dropped=fp.dropped.filter(r=>r.resourceType===RESOURCE_ENERGY).reduce((s,r)=>s+r.amount,0);
    det.droppedEnergy=dropped;if(dropped>1000){neg.energyDecaying=-10;score-=10;}
    if(links.length>0&&links.every(l=>l.store[RESOURCE_ENERGY]===0)){neg.linksEmpty=-8;score-=8;det.allLinksEmpty=true;}else{det.allLinksEmpty=false;}
    let srcInfra=0;for(const src of sources)if(src.pos.findInRange(links,3).length>0||src.pos.findInRange(containers,3).length>0)srcInfra++;
    det.sourcesWithInfrastructure=srcInfra;det.totalSources=sources.length;if(sources.length>0&&srcInfra<sources.length){neg.missingSourceInfrastructure=-12;score-=12;}
    return {score,positives:pos,negatives:neg,details:det};
}

// ── Intel: Military analyzer ──────────────────────────────────────────────
function _itCheckWallEff(room, storage, ramparts, walls) {
    const ctx=_itBuildPathCtx(room, ramparts.concat(walls));
    const dirs={top:[],bottom:[],left:[],right:[]};
    for(let i=0;i<ctx.entries.length;i++){const e=ctx.entries[i];if(e.x===0)dirs.left.push(e);else if(e.x===49)dirs.right.push(e);else if(e.y===0)dirs.top.push(e);else if(e.y===49)dirs.bottom.push(e);}
    const breached=[];
    for(const dir in dirs)for(const entry of dirs[dir]){const r=PathFinder.search(entry,{pos:storage.pos,range:1},{plainCost:1,swampCost:5,roomCallback:ctx.cf,maxRooms:1});if(!r.incomplete&&r.path.length>0){breached.push(dir);break;}}
    return breached;
}
function _itCheckPath(room, target, ramparts, walls) {
    return _itBuildPathCtx(room, ramparts.concat(walls)).check(target);
}
function _itBuildPathCtx(room, blockers) {
    const terrain=room.getTerrain(),entries=[];
    for(let i=1;i<49;i+=5){if(terrain.get(i,0)!==TERRAIN_MASK_WALL)entries.push(new RoomPosition(i,0,room.name));if(terrain.get(i,49)!==TERRAIN_MASK_WALL)entries.push(new RoomPosition(i,49,room.name));if(terrain.get(0,i)!==TERRAIN_MASK_WALL)entries.push(new RoomPosition(0,i,room.name));if(terrain.get(49,i)!==TERRAIN_MASK_WALL)entries.push(new RoomPosition(49,i,room.name));}
    const cf=(rn)=>{if(rn!==room.name)return false;const m=new PathFinder.CostMatrix();for(const s of blockers)m.set(s.pos.x,s.pos.y,255);return m;};
    const check=(target)=>{for(const entry of entries){const r=PathFinder.search(entry,{pos:target.pos,range:1},{plainCost:1,swampCost:5,roomCallback:cf,maxRooms:1});if(!r.incomplete&&r.path.length>0)return true;}return false;};
    return {check,entries,cf};
}
function _itAnalyzeMil(room, fp) {
    fp = fp || _roomFingerprint(room);
    let score=0;const pos={},neg={},det={};
    const towers=_fpByType(fp,STRUCTURE_TOWER);
    const nuker=_fpByType(fp,STRUCTURE_NUKER)[0];
    const ramparts=_fpByType(fp,STRUCTURE_RAMPART);
    const walls=_fpByType(fp,STRUCTURE_WALL);
    const spawns=_fpByType(fp,STRUCTURE_SPAWN);
    const storage=room.storage,terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
    const labs=_fpByType(fp,STRUCTURE_LAB);
    const allDef=ramparts.concat(walls),allCreeps=fp.creeps;
    const strongRamp=new Set();
    for(const r of ramparts)if(r.hits>=10000000)strongRamp.add(r.pos.x+','+r.pos.y);
    const isRamped=(obj)=>strongRamp.has(obj.pos.x+','+obj.pos.y);
    if(towers.length>0){const ts=Math.min(towers.length/6,1)*21;pos.towerCount=r1(ts);score+=ts;}det.towerCount=towers.length;
    const towersProtected=towers.some(t=>isRamped(t));
    if(towersProtected){pos.towerProtected=1;score+=1;}det.towerProtected=towersProtected;
    if(nuker){pos.nukerExists=3;score+=3;det.nukerExists=true;const nE=nuker.store[RESOURCE_ENERGY]||0,nG=nuker.store[RESOURCE_GHODIUM]||0;const full=nE>=nuker.store.getCapacity(RESOURCE_ENERGY)&&nG>=nuker.store.getCapacity(RESOURCE_GHODIUM);if(full){pos.nukerReady=6;score+=6;}det.nukerReady=full;det.nukerCharging=!full&&(nE>0||nG>0);det.nukerEnergy=nE;det.nukerGhodium=nG;const nukerProt=isRamped(nuker);if(nukerProt){pos.nukerProtected=1;score+=1;}det.nukerProtected=nukerProt;}else{det.nukerExists=false;det.nukerProtected=false;}
    if(allDef.length>0){const avg=allDef.reduce((s,d)=>s+d.hits,0)/allDef.length;pos.avgDefenseStrength=r1(Math.min(avg/300000000,1)*15);score+=Math.min(avg/300000000,1)*15;det.avgDefenseHits=Math.round(avg);det.minDefenseHits=Math.min(...allDef.map(d=>d.hits));det.maxDefenseHits=Math.max(...allDef.map(d=>d.hits));}
    det.rampartCount=ramparts.length;det.wallCount=walls.length;
    const spawnProt=spawns.some(s=>isRamped(s)),storageProt=storage&&isRamped(storage),termProt=terminal&&isRamped(terminal);
    if(spawnProt){pos.spawnProtected=6;score+=6;}if(storageProt){pos.storageProtected=5;score+=5;}if(termProt){pos.terminalProtected=5;score+=5;}
    det.spawnProtected=spawnProt;det.storageProtected=!!storageProt;det.terminalProtected=!!termProt;
    if(storage&&storage.store){const se=storage.store[RESOURCE_ENERGY]||0;pos.storageEnergy=r1(Math.min(se/1000000,1)*6);score+=Math.min(se/1000000,1)*6;det.storageEnergy=se;}
    const boosted=allCreeps.filter(c=>c.body.some(p=>p.boost));if(boosted.length>0){pos.boostedCreeps=5;score+=5;}det.boostedCreepCount=boosted.length;
    let totalBoosts=0;const addB=(s)=>{if(s)for(const b of INTEL_COMBAT_BOOSTS)totalBoosts+=s[b]||0;};addB(storage&&storage.store);addB(terminal&&terminal.store);for(const lab of labs)if(lab.mineralType&&INTEL_COMBAT_BOOSTS.includes(lab.mineralType))totalBoosts+=lab.store[lab.mineralType]||0;
    if(totalBoosts>0){pos.combatBoostStockpile=r1(Math.min(totalBoosts/30000,1)*15);score+=Math.min(totalBoosts/30000,1)*15;}det.combatBoostTotal=totalBoosts;
    if(room.controller&&room.controller.sign){const own=room.controller.owner?room.controller.owner.username:null,sig=room.controller.sign.username;det.signByOwner=sig&&own&&sig===own;det.signText=room.controller.sign.text;if(det.signByOwner){pos.ownerSign=2;score+=2;}}else{det.signByOwner=false;}
    if(room.controller&&room.controller.safeModeAvailable>0){pos.safeModeAvailable=4;score+=4;}if(room.controller&&!room.controller.safeModeCooldown){pos.safeModeReady=5;score+=5;}
    det.safeModeAvailable=room.controller?room.controller.safeModeAvailable:0;det.safeModeCooldown=room.controller?room.controller.safeModeCooldown:0;det.safeModeActive=room.controller?room.controller.safeMode:0;
    const emptyT=towers.filter(t=>t.store[RESOURCE_ENERGY]===0),lowT=towers.filter(t=>t.store[RESOURCE_ENERGY]/t.store.getCapacity(RESOURCE_ENERGY)<0.25&&t.store[RESOURCE_ENERGY]>0);
    if(emptyT.length>0){neg.towersEmpty=-15;score-=15;}if(lowT.length>0){neg.towersLowEnergy=-10;score-=10;}
    det.emptyTowerCount=emptyT.length;det.lowEnergyTowerCount=lowT.length;
    const weakR=ramparts.filter(r=>r.hits<100000);if(weakR.length>0){neg.weakRamparts=-12;score-=12;}det.weakRampartCount=weakR.length;det.totalDefenseCount=allDef.length;
    if(room.controller&&room.controller.level>=2){if(walls.length===0&&ramparts.length===0){neg.noDefenses=-50;score-=50;}else if(walls.length>0&&ramparts.length===0){neg.noRamparts=-25;score-=25;}}
    if(storage&&allDef.length>0){const br=_itCheckWallEff(room,storage,ramparts,walls);det.wallsEffective=br.length===0;det.breachedEntrances=br.length;det.breachedDirections=br;if(br.length>0){neg.wallsBreached=-15;score-=15;}}else{det.wallsEffective=false;det.breachedEntrances=0;det.breachedDirections=[];}
    const sources=fp.sources;
    if(room.controller&&allDef.length>0){
        const pathCtx=_itBuildPathCtx(room,ramparts.concat(walls));
        det.controllerExposed=pathCtx.check(room.controller);
        if(det.controllerExposed){neg.controllerExposed=-10;score-=10;}
        let expSrc=0;
        for(const src of sources)if(pathCtx.check(src))expSrc++;
        det.exposedSourceCount=expSrc;det.totalSourceCount=sources.length;
        if(expSrc>0){neg.sourcesExposed=-10;score-=10;}
    }else{det.controllerExposed=true;det.exposedSourceCount=sources.length;det.totalSourceCount=sources.length;}
    return {score,positives:pos,negatives:neg,details:det};
}

// ── Intel: Dual purpose analyzer ─────────────────────────────────────────
function _itAnalyzeDP(room, fp) {
    fp = fp || _roomFingerprint(room);
    let score=0;const pos={},neg={},det={};
    const rcl=room.controller?room.controller.level:0;
    const spawns=_fpByType(fp,STRUCTURE_SPAWN);
    const extensions=_fpByType(fp,STRUCTURE_EXTENSION);
    const powerSpawn=_fpByType(fp,STRUCTURE_POWER_SPAWN)[0];
    const terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
    const storage=room.storage,observer=_fpByType(fp,STRUCTURE_OBSERVER)[0];
    const allCreeps=fp.creeps,myCreeps=fp.myCreeps,powerCreeps=fp.powerCreeps;
    if(rcl>0){const rs=(rcl/8)*17;pos.rcl=r1(rs);score+=rs;}det.rcl=rcl;
    if(spawns.length>0){const ss=Math.min(spawns.length/3,1)*14;pos.spawnCount=r1(ss);score+=ss;}det.spawnCount=spawns.length;det.maxSpawns=INTEL_SPWN_BY_RCL[rcl]||0;
    const expExt=INTEL_EXT_BY_RCL[rcl]||0;
    if(expExt>0&&extensions.length>=expExt){pos.maxExtensions=10;score+=10;}else if(extensions.length>0&&expExt>0){const es=(extensions.length/expExt)*10;pos.extensionProgress=r1(es);score+=es;}
    det.extensionCount=extensions.length;det.expectedExtensions=expExt;
    if(powerSpawn){pos.powerSpawnExists=6;score+=6;det.powerSpawnExists=true;if(powerSpawn.store[RESOURCE_ENERGY]>0){pos.powerSpawnFueled=3;score+=3;}det.powerSpawnEnergy=powerSpawn.store[RESOURCE_ENERGY];det.powerSpawnPower=powerSpawn.store[RESOURCE_POWER];}else{det.powerSpawnExists=false;}
    let pwr=0;if(storage)pwr+=storage.store[RESOURCE_POWER]||0;if(terminal)pwr+=terminal.store[RESOURCE_POWER]||0;if(powerSpawn)pwr+=powerSpawn.store[RESOURCE_POWER]||0;if(pwr>0){pos.powerInRoom=1;score+=1;}det.powerInRoom=pwr;
    if(terminal){pos.terminalExists=8;score+=8;det.terminalExists=true;const te=terminal.store[RESOURCE_ENERGY]||0;if(te>=1000){pos.terminalHasEnergy=3;score+=3;}det.terminalEnergy=te;const tR=Object.keys(terminal.store).filter(r=>r!==RESOURCE_ENERGY&&terminal.store[r]>0);if(tR.length>0){pos.terminalHasResources=5;score+=5;}det.terminalResourceCount=tR.length;}else{det.terminalExists=false;det.terminalEnergy=0;det.terminalResourceCount=0;}
    if(storage){pos.storageExists=8;score+=8;det.storageExists=true;det.storageTotalUsed=storage.store.getUsedCapacity();}else{det.storageExists=false;det.storageTotalUsed=0;}
    const large=allCreeps.filter(c=>c.body.length>=30);if(large.length>0){pos.largeCreeps=8;score+=8;}det.largeCreepCount=large.length;det.maxCreepSize=allCreeps.length>0?Math.max(...allCreeps.map(c=>c.body.length)):0;
    if(powerCreeps.length>0){pos.powerCreeps=6;score+=6;}det.powerCreepCount=powerCreeps.length;
    if(observer){pos.observer=6;score+=6;}det.observerExists=!!observer;
    const haulers=allCreeps.filter(c=>c.body.length>=30&&c.body.every(p=>p.type===MOVE||p.type===CARRY));if(haulers.length>0){pos.hasHauler=5;score+=5;}
    det.haulerCount=haulers.length;det.myCreepCount=myCreeps.length;det.totalCreepCount=allCreeps.length;det.downgradeTimer=room.controller?room.controller.ticksToDowngrade:0;
    if(room.controller&&room.controller.ticksToDowngrade){if(room.controller.ticksToDowngrade<50000){neg.lowDowngradeTimer=-15;score-=15;}else if(room.controller.ticksToDowngrade<100000){neg.mediumDowngradeTimer=-8;score-=8;}}
    det.extensionEnergyPercent=100;
    if(extensions.length>0){const totE=extensions.reduce((s,e)=>s+e.store[RESOURCE_ENERGY],0),totC=extensions.reduce((s,e)=>s+e.store.getCapacity(RESOURCE_ENERGY),0);const pct=totC>0?(totE/totC)*100:0;det.extensionEnergyPercent=Math.round(pct);if(totE===0){neg.extensionsEmpty=-12;score-=12;}else if(pct<25){neg.extensionsCritical=-8;score-=8;}else if(pct<50){neg.extensionsLow=-5;score-=5;}}
    const expSpwn=INTEL_SPWN_BY_RCL[rcl]||0;
    if(spawns.length<expSpwn){neg.missingSpawns=-12;score-=12;}if(extensions.length<expExt&&expExt>0){neg.missingExtensions=-10;score-=10;}
    det.missingSpawns=Math.max(0,expSpwn-spawns.length);det.missingExtensions=Math.max(0,expExt-extensions.length);
    if(storage&&storage.store.getUsedCapacity()<10000){neg.storageEmpty=-10;score-=10;}if(rcl>=4&&!storage){neg.noStorage=-15;score-=15;}
    return {score,positives:pos,negatives:neg,details:det};
}

// ── Intel: Purpose classifier + terminal flow + print helpers ─────────────
function _itClassifyPurpose(room, t) {
    const obs=Math.max(1,t.ticksObserved),rcl=room.controller?room.controller.level:0;
    const upgFrac=(t.energyHarvested/obs)>0?(t.upgradeEnergySpent/obs)/(t.energyHarvested/obs):0;
    const boostedCreeps=room.find(FIND_CREEPS).filter(c=>c.body.some(p=>p.boost));
    if(t.ev_power>10&&upgFrac<0.40)return 'Power Processing';
    if(upgFrac>=0.60&&t.ev_upgradeController/obs>0.50)return rcl===8?'GCL Push':'RCL Push';
    if(boostedCreeps.length>0&&t.ev_attack>5)return 'Combat Staging';
    if(t.hasFactory&&t.factoryProduces>2&&t.terminalSends/obs>0.03)return 'Factory Hub';
    if(t.ev_build/obs>0.30&&upgFrac<0.30)return 'Active Expansion';
    if(t.ev_harvest/obs>0.50&&t.ev_transfer/obs>0.30&&!t.hasFactory&&t.ev_upgradeController/obs<0.20)return 'Source Room';
    return 'Balanced Operation';
}
function _itBuildTerminalFlow(t, prefix) {
    if(!t.hasTerminal)return[prefix+'   Terminal not present during profile.'];
    const allRes=new Set([...Object.keys(t.terminalIn||{}),...Object.keys(t.terminalOut||{})]);
    if(allRes.size===0)return[prefix+'   No terminal movements detected over '+t.ticksObserved+' ticks.'];
    const rows=[];
    for(const res of allRes){const iA=(t.terminalIn||{})[res]||0,oA=(t.terminalOut||{})[res]||0,p=getMarketHistoryPrice(res);rows.push({res,iA,oA,iV:iA*p,oV:oA*p,p,tot:iA*p+oA*p});}
    rows.sort((a,b)=>b.tot-a.tot);
    const lines=[prefix+'Terminal Flow ('+t.ticksObserved+'-tick window):'];
    for(const row of rows){if(row.iA>0)lines.push(prefix+'  ▲ IN  '+row.res.padEnd(12)+' x'+fmtNum(row.iA).padStart(7)+' @'+r2(row.p)+'cr = '+fmtCr(row.iV).padStart(10));if(row.oA>0)lines.push(prefix+'  ▼ OUT '+row.res.padEnd(12)+' x'+fmtNum(row.oA).padStart(7)+' @'+r2(row.p)+'cr = '+fmtCr(row.oV).padStart(10));}
    const tI=rows.reduce((s,r)=>s+r.iV,0),tO=rows.reduce((s,r)=>s+r.oV,0);
    lines.push(prefix+'  Total IN: '+fmtCr(tI)+'  OUT: '+fmtCr(tO)+'  Throughput: '+fmtCr(tI+tO));
    return lines;
}
const INTEL_KEY_SHORT={factoryExists:'Fac',factoryLeveled:'FacLvl',extractorExists:'Ext',extractorActive:'ExtAct',storageDiversity:'Div',linkCount:'Links',labCount:'Labs',labsActive:'LabAct',marketOrders:'Market',hasHighwayDeposits:'Highway',hasCompressedCommodities:'Compressed',hasRegionalCommodities:'Regional',hasLevelCommodities:'LvlCommod',hasLabProducts:'LabProd',labUtilization:'LabUtil',terminalSendRate:'TermSend',factoryUtilization:'FacUtil',storageNearlyFull:'StoFull',energyDecaying:'Decay',linksEmpty:'LinkEmpty',missingSourceInfrastructure:'NoSrcInf',towerCount:'Twr',towerProtected:'TwrProt',nukerExists:'Nuke',nukerReady:'NukeRdy',nukerProtected:'NukeProt',avgDefenseStrength:'DefStr',spawnProtected:'SpwnProt',storageProtected:'StoProt',terminalProtected:'TermProt',storageEnergy:'StoE',boostedCreeps:'Boost',combatBoostStockpile:'BoostStk',ownerSign:'Sign',safeModeAvailable:'SafeAvl',safeModeReady:'SafeRdy',towersEmpty:'TwrEmpty',towersLowEnergy:'TwrLow',weakRamparts:'WeakRamp',noDefenses:'NoDef',noRamparts:'NoRamp',wallsBreached:'Breached',controllerExposed:'CtrlExp',sourcesExposed:'SrcExp',rcl:'RCL',spawnCount:'Spwn',maxExtensions:'MaxExt',extensionProgress:'ExtProg',powerSpawnExists:'PSpwn',powerSpawnFueled:'PSpwnE',powerInRoom:'PwrInRoom',terminalExists:'Term',terminalHasEnergy:'TermE',terminalHasResources:'TermRes',storageExists:'Sto',largeCreeps:'BigCreep',powerCreeps:'PCreep',observer:'Obs',hasHauler:'Hauler',lowDowngradeTimer:'LowDg',mediumDowngradeTimer:'MedDg',missingSpawns:'NoSpwn',missingExtensions:'NoExt',storageEmpty:'StoEmpty',noStorage:'NoSto',extensionsEmpty:'ExtEmpty',extensionsCritical:'ExtCrit',extensionsLow:'ExtLow',energyCaptureRate:'Capture',incomeSurplus:'Surplus',cpuEfficiency:'CPU/Creep',productiveIntentRatio:'ProdInt',creepRepairShare:'CreepRep',lowMovesPerCreep:'LowMove',efficientMovementBonus:'MoveBonus',moderateMovesPerCreep:'ModMove',highMovesPerCreep:'HighMove',energyDeficit:'Deficit',highCpuPerCreep:'HighCPU',towerRepairDominant:'TwrRep',sustainedBuildActivity:'Building'};
function _itFmtPN(pos,neg){const p=Object.keys(pos).map(k=>(INTEL_KEY_SHORT[k]||k)+':+'+pos[k]).join(', ');const n=Object.keys(neg).map(k=>(INTEL_KEY_SHORT[k]||k)+':'+neg[k]).join(', ');return 'Pos:['+p+']'+(n?' Neg:['+n+']':'');}
function _itRating(s){if(s>=90)return'⭐ ELITE';if(s>=75)return'🟢 STRONG';if(s>=60)return'🟡 DEVELOPED';if(s>=45)return'🟠 MODERATE';if(s>=30)return'🔴 WEAK';if(s>=15)return'⚫ STRUGGLING';return'💀 CRITICAL';}
function _itSummary(res){const p=[res.economic.score>=70?'Strong economy':res.economic.score>=40?'Moderate economy':'Weak economy',res.military.score>=70?'well-defended':res.military.score>=40?'some defenses':'poorly defended',res.dualPurpose.score>=70?'mature infrastructure':res.dualPurpose.score>=40?'developing infrastructure':'limited infrastructure'];if(res.operational)p.push(res.operational.score>=70?'highly efficient':res.operational.score>=40?'moderate efficiency':'inefficient operation');const neg=Object.keys(res.economic.negatives).length+Object.keys(res.military.negatives).length+Object.keys(res.dualPurpose.negatives).length+(res.operational?Object.keys(res.operational.negatives).length:0);if(neg>5)p.push('MULTIPLE VULNERABILITIES');else if(neg>2)p.push('some vulnerabilities');return p.join(', ');}

function _itPrintFull(res) {
    const D='════════════════════════════════════════════════════════════════════════════════',L=[];
    L.push(D);L.push('ROOM INTEL: '+res.room+' | Owner: '+res.owner+' | RCL: '+res.rcl+' | '+_itRating(res.overall)+' | OVERALL: '+res.overall+'/100 | TOTAL VALUE: '+fmtCr(res.totalValue)+' | Purpose: '+res.purpose);L.push(D);
    L.push('📊 ECONOMIC [20%]: '+res.economic.score+'/100 | VALUE: '+fmtCr(res.economic.value.total)+' (structs: '+fmtCr(res.economic.value.structureCredits)+' | res: '+fmtCr(res.economic.value.resourceCredits)+')');
    L.push('   '+_itFmtPN(res.economic.positives,res.economic.negatives));
    const ed=res.economic.details;
    L.push('   Factory: Lvl '+(ed.factoryLevel||0)+' | Extractor: '+(ed.extractorExists?(ed.extractorActive?'Active':'Idle'):'None')+' | Mineral: '+(ed.mineralType||'N/A')+' | Labs: '+ed.labCount+'/10 ('+ed.activeLabCount+' active) | Links: '+ed.linkCount+'/4');
    L.push('   Diversity: '+ed.storageDiversityCount+'/25 | Storage: '+(ed.storageFillPercent||0)+'% full | Dropped E: '+ed.droppedEnergy+' | Market: '+(ed.marketTotalOrders||0)+' orders ('+(ed.marketBuyOrders||0)+'B/'+(ed.marketSellOrders||0)+'S)');
    if(ed.sellOrderDetails&&ed.sellOrderDetails.length)L.push('   Selling: '+ed.sellOrderDetails.map(o=>o.resource+' x'+fmtNum(o.amount)+' @'+o.price).join(', '));
    if(ed.buyOrderDetails&&ed.buyOrderDetails.length)L.push('   Buying:  '+ed.buyOrderDetails.map(o=>o.resource+' x'+fmtNum(o.amount)+' @'+o.price).join(', '));
    L.push('   Commodities: Highway:'+yn(ed.hasHighwayDeposits)+' Compressed:'+yn(ed.hasCompressedCommodities)+' Regional:'+yn(ed.hasRegionalCommodities)+' LvlCommod:'+yn(ed.hasLevelCommodities)+' LabProd:'+yn(ed.hasLabProducts));
    L.push('   Production: Labs: '+ed.labUtilRate+' ('+(ed.labReactions||0)+' rxns) | Terminal: '+ed.terminalSendRate+' ('+(ed.terminalSends||0)+' sends) | Factory: '+(ed.factoryProduces||0)+' produces');
    L.push('⚔️  MILITARY [25%]: '+res.military.score+'/100 | VALUE: '+fmtCr(res.military.value.total));
    L.push('   '+_itFmtPN(res.military.positives,res.military.negatives));
    const md=res.military.details;
    L.push('   Towers: '+md.towerCount+'/6 (empty:'+md.emptyTowerCount+' low:'+md.lowEnergyTowerCount+') | Nuker: '+(md.nukerExists?md.nukerReady?'READY':md.nukerCharging?'Charging ('+fmtNum(md.nukerEnergy)+'E/'+fmtNum(md.nukerGhodium)+'G)':'Empty':'None')+' | SafeMode: '+md.safeModeAvailable+' avail');
    L.push('   Walls: '+md.wallCount+' | Ramparts: '+md.rampartCount+' (weak<100k: '+md.weakRampartCount+') | Def avg: '+fmtNum(md.avgDefenseHits)+' min: '+fmtNum(md.minDefenseHits));
    L.push('   Protected (10M+ ramp): Spawn:'+yn(md.spawnProtected)+' Storage:'+yn(md.storageProtected)+' Terminal:'+yn(md.terminalProtected)+' Tower:'+yn(md.towerProtected)+' Nuker:'+yn(md.nukerProtected));
    L.push('   Boosted creeps: '+md.boostedCreepCount+' | Combat boosts: '+fmtNum(md.combatBoostTotal)+'/30k | Signed: '+yn(md.signByOwner));
    L.push('   Walls: '+(md.totalDefenseCount?md.wallsEffective?'Effective':'BREACHED: '+md.breachedDirections.join(', '):'no defenses')+' | Exposed: Ctrl:'+yn(md.controllerExposed)+' Sources:'+md.exposedSourceCount+'/'+md.totalSourceCount);
    L.push('🔧 DUAL PURPOSE [30%]: '+res.dualPurpose.score+'/100 | VALUE: '+fmtCr(res.dualPurpose.value.total));
    L.push('   '+_itFmtPN(res.dualPurpose.positives,res.dualPurpose.negatives));
    const dd=res.dualPurpose.details;
    L.push('   Spawns: '+dd.spawnCount+'/'+dd.maxSpawns+' | Extensions: '+dd.extensionCount+'/'+dd.expectedExtensions+' ('+(dd.extensionEnergyPercent||0)+'% E) | Downgrade: '+(dd.downgradeTimer<100000?fmtNum(dd.downgradeTimer)+' ⚠️':'OK'));
    L.push('   Storage: '+fmtNum(dd.storageTotalUsed)+' | Terminal: '+fmtNum(dd.terminalEnergy)+'E, '+dd.terminalResourceCount+' types | Power: '+fmtNum(dd.powerInRoom));
    L.push('   PwrSpawn: '+(dd.powerSpawnExists?dd.powerSpawnEnergy+'E/'+dd.powerSpawnPower+'P':'None')+' | Observer: '+yn(dd.observerExists)+' | Creeps: '+dd.myCreepCount+' | Haulers: '+dd.haulerCount+' | PowerCreeps: '+dd.powerCreepCount);
    if(res.operational){
        L.push('⚙️  OPERATIONAL [25%]: '+res.operational.score+'/100');L.push('   '+_itFmtPN(res.operational.positives,res.operational.negatives));
        const od=res.operational.details;
        L.push('   Observed: '+od.ticksObserved+' ticks ('+od.invisibleTicks+' invisible)');
        L.push('   Energy: Income '+od.incomePerTick+'/'+od.maxIncomePerTick+' E/tick | Capture: '+od.energyCaptureRate+' | Source max: '+od.sourceMaxRates);
        L.push('   Spend: Upkeep '+od.maintPerTick+' | Spawn '+od.spawnPerTick+' | Upgrade '+od.upgradePerTick+' | Towers '+od.towerCostPerTick);
        L.push('   Repair: Creep share '+od.creepRepairShare+' | Tower actions '+od.towerRepairActions+' | Total '+od.totalRepairEvents);
        L.push('   Movement: '+od.movesPerCreepTick+' moves/creep/tick | Avg creeps: '+od.avgCreeps+' | CPU/creep: '+od.cpuPerCreep);
        const _p=(n)=>od.totalIntents>0?r1(n/od.totalIntents*100)+'%':'0%';
        L.push('   Intents ('+od.productiveRatio+' productive): Harvest '+_p(od.ev_harvest)+' Build '+_p(od.ev_build)+' Upgrade '+_p(od.ev_upgradeController)+' Transfer '+_p(od.ev_transfer)+' Repair '+_p(od.ev_repairAny)+' Attack '+_p(od.ev_attack)+' Power '+_p(od.ev_power));
        for(const line of _itBuildTerminalFlow({terminalIn:od.terminalIn,terminalOut:od.terminalOut,hasTerminal:od.hasTerminal,ticksObserved:od.ticksObserved},'   '))L.push(line);
    }
    L.push(D);L.push('SUMMARY: '+_itSummary(res));L.push(D);
    console.log(L.join('\n'));
}
function _itPrintFast(res) {
    const D='════════════════════════════════════════════════════════════════════════════════',L=[];
    L.push(D);L.push('ROOM INTEL (FAST): '+res.room+' | Owner: '+res.owner+' | RCL: '+res.rcl+' | '+_itRating(res.overall)+' | OVERALL: '+res.overall+'/100 | VALUE: '+fmtCr(res.totalValue)+'  [Eco·Mil·DP only]');L.push(D);
    L.push('📊 ECONOMIC [27%]: '+res.economic.score+'/100 | VALUE: '+fmtCr(res.economic.value.total));L.push('   '+_itFmtPN(res.economic.positives,res.economic.negatives));
    const ed=res.economic.details;L.push('   Factory: Lvl '+(ed.factoryLevel||0)+' | Extractor: '+(ed.extractorExists?(ed.extractorActive?'Active':'Idle'):'None')+' | Labs: '+ed.labCount+'/10 | Diversity: '+ed.storageDiversityCount+'/25');
    L.push('   Commodities: Highway:'+yn(ed.hasHighwayDeposits)+' Compressed:'+yn(ed.hasCompressedCommodities)+' Regional:'+yn(ed.hasRegionalCommodities)+' LvlCommod:'+yn(ed.hasLevelCommodities));
    L.push('   Production rates unavailable — run intel(\''+res.room+'\') for full profile.');
    L.push('⚔️  MILITARY [33%]: '+res.military.score+'/100 | VALUE: '+fmtCr(res.military.value.total));L.push('   '+_itFmtPN(res.military.positives,res.military.negatives));
    const md=res.military.details;L.push('   Towers: '+md.towerCount+'/6 | Nuker: '+(md.nukerExists?md.nukerReady?'READY':'Charging':'None')+' | Def avg: '+fmtNum(md.avgDefenseHits)+' | Ramparts: '+md.rampartCount+' (weak: '+md.weakRampartCount+')');
    L.push('   Walls: '+(md.totalDefenseCount?md.wallsEffective?'Effective':'BREACHED: '+md.breachedDirections.join(', '):'no defenses'));
    L.push('🔧 DUAL PURPOSE [40%]: '+res.dualPurpose.score+'/100 | VALUE: '+fmtCr(res.dualPurpose.value.total));L.push('   '+_itFmtPN(res.dualPurpose.positives,res.dualPurpose.negatives));
    const dd=res.dualPurpose.details;L.push('   Spawns: '+dd.spawnCount+'/'+dd.maxSpawns+' | Extensions: '+dd.extensionCount+'/'+dd.expectedExtensions+' ('+(dd.extensionEnergyPercent||0)+'% E) | Storage: '+fmtNum(dd.storageTotalUsed));
    L.push('⚙️  OPERATIONAL: not measured  ← call intel(\''+res.room+'\') to start 100-tick profile');
    L.push(D);L.push('SUMMARY (fast): '+_itSummary(res));L.push(D);
    console.log(L.join('\n'));
}

// ── Intel: Observer fallback helper ──────────────────────────────────────
function _itHandleNotVisible(roomName, isFast) {
    if(!Memory.roomIntelPending)Memory.roomIntelPending={};
    const pending=Memory.roomIntelPending[roomName];
    if(pending&&Game.time-pending.tick<=1){console.log('['+(isFast?'IntelFast':'Intel')+'] ERROR: '+roomName+' still not visible after observation attempt.');delete Memory.roomIntelPending[roomName];return;}
    if(Memory.intelPowerObserve&&Memory.intelPowerObserve[roomName]){const po=Memory.intelPowerObserve[roomName];if(Game.time-po.tick<=50){console.log('[Intel] PWR_OPERATE_OBSERVER in progress — '+po.operatorName+', elapsed '+(Game.time-po.tick)+'t.');return;}delete Memory.intelPowerObserve[roomName];}
    const obs=findObserverInRange(roomName,_tickUsedSet());
    if(obs&&_tickObserve(obs,roomName)){Memory.roomIntelPending[roomName]={tick:Game.time,observerRoom:obs.room.name,fast:isFast};console.log('['+(isFast?'IntelFast':'Intel')+'] Observing '+roomName+' from '+obs.room.name+'. Auto-completing next tick.');return;}
    const po=tryPowerObserver(roomName);
    if(po){if(!Memory.intelPowerObserve)Memory.intelPowerObserve={};Memory.intelPowerObserve[roomName]={operatorName:po.operatorName,operatorRoom:po.operatorRoom,tick:Game.time,fast:isFast};console.log('[Intel] PWR_OPERATE_OBSERVER from '+po.operatorName+' ('+po.operatorRoom+')');return;}
    console.log('['+(isFast?'IntelFast':'Intel')+'] ERROR: '+roomName+' not visible. No observer in range.');
}

// ── Intel: Public API ─────────────────────────────────────────────────────
function intel(roomName) {
    if(!roomName||typeof roomName!=='string'){console.log('[Intel] Usage: intel("W1N1")');return;}
    const room=Game.rooms[roomName];
    if(!room){_itHandleNotVisible(roomName,false);return;}
    if(!Memory.roomIntelPending)Memory.roomIntelPending={};delete Memory.roomIntelPending[roomName];
    const effCache=_itGetCachedEff(roomName);
    if(!effCache&&!_itIsProfileActive(roomName)){_itStartProfile(roomName,room);console.log('[Intel] Profile started for '+roomName+'. Full report in ~'+INTEL_PROFILE_TICKS+' ticks.');return;}
    if(!effCache&&_itIsProfileActive(roomName)){const p=Memory[INTEL_EFF_MEM_KEY][roomName];console.log('[Intel] Profiling '+roomName+': '+(p?p.totals.ticksObserved:0)+'/'+INTEL_PROFILE_TICKS+' ticks. Report auto-prints when complete.');return;}
    const fp=_roomFingerprint(room);
    const ecoD=_itAnalyzeEco(room,effCache,fp),milD=_itAnalyzeMil(room,fp),dpD=_itAnalyzeDP(room,fp),opD=_itAnalyzeOperational(room,effCache);
    const purpose=_itClassifyPurpose(room,effCache.totals);
    const eS=clamp(ecoD.score),mS=clamp(milD.score),dS=clamp(dpD.score),oS=clamp(opD.score);
    const overall=eS*INTEL_W.economic+mS*INTEL_W.military+dS*INTEL_W.dualPurpose+oS*INTEL_W.operational;
    const eV=_itCalcEcoValue(room,fp),mV=_itCalcMilValue(room,fp),dV=_itCalcDPValue(room,fp);
    const result={room:roomName,owner:room.controller&&room.controller.owner?room.controller.owner.username:'Unowned',rcl:room.controller?room.controller.level:0,tick:Game.time,overall:r1(overall),totalValue:eV.total+mV.total+dV.total,purpose,economic:{score:r1(eS),value:eV,positives:ecoD.positives,negatives:ecoD.negatives,details:ecoD.details},military:{score:r1(mS),value:mV,positives:milD.positives,negatives:milD.negatives,details:milD.details},dualPurpose:{score:r1(dS),value:dV,positives:dpD.positives,negatives:dpD.negatives,details:dpD.details},operational:{score:r1(oS),positives:opD.positives,negatives:opD.negatives,details:opD.details}};
    _itPrintFull(result);
    if(Memory[INTEL_EFF_CACHE_KEY])delete Memory[INTEL_EFF_CACHE_KEY][roomName];
}

function intelFast(roomName, silent) {
    if(!roomName||typeof roomName!=='string'){console.log('[IntelFast] Usage: intelFast("W1N1")');return null;}
    const room=Game.rooms[roomName];
    if(!room){_itHandleNotVisible(roomName,true);return null;}
    if(!Memory.roomIntelPending)Memory.roomIntelPending={};delete Memory.roomIntelPending[roomName];
    const fp=_roomFingerprint(room);
    const ecoD=_itAnalyzeEco(room,null,fp),milD=_itAnalyzeMil(room,fp),dpD=_itAnalyzeDP(room,fp);
    const eS=clamp(ecoD.score),mS=clamp(milD.score),dS=clamp(dpD.score);
    const overall=eS*INTEL_W_FAST.economic+mS*INTEL_W_FAST.military+dS*INTEL_W_FAST.dualPurpose;
    const eV=_itCalcEcoValue(room,fp),mV=_itCalcMilValue(room,fp),dV=_itCalcDPValue(room,fp);
    const result={room:roomName,owner:room.controller&&room.controller.owner?room.controller.owner.username:'Unowned',rcl:room.controller?room.controller.level:0,tick:Game.time,overall:r1(overall),fast:true,totalValue:eV.total+mV.total+dV.total,economic:{score:r1(eS),value:eV,positives:ecoD.positives,negatives:ecoD.negatives,details:ecoD.details},military:{score:r1(mS),value:mV,positives:milD.positives,negatives:milD.negatives,details:milD.details},dualPurpose:{score:r1(dS),value:dV,positives:dpD.positives,negatives:dpD.negatives,details:dpD.details}};
    if(!silent)_itPrintFast(result);
    return result;
}

function listIntel() {
    const cache=Memory[INTEL_EFF_CACHE_KEY],active=Memory[INTEL_EFF_MEM_KEY];
    const hasC=cache&&Object.keys(cache).length>0,hasA=active&&Object.keys(active).length>0;
    if(!hasC&&!hasA){console.log('[Intel] No efficiency profiles cached or active.');return;}
    console.log('\n=== EFFICIENCY PROFILES ===');
    if(hasA)for(const rn in active){const p=active[rn];console.log('  '+rn+': profiling '+p.totals.ticksObserved+'/'+INTEL_PROFILE_TICKS+' ticks');}
    if(hasC)for(const rn in cache){const c=cache[rn];console.log('  '+rn+': complete | expires in '+(c.expiresTick-Game.time)+'t');}
    console.log('===========================\n');
}
function getCachedIntel(roomName) {
    if (!roomName || typeof roomName !== 'string') {
        if (!Memory[INTEL_EFF_CACHE_KEY]) return null;
        const out = [];
        for (const rn in Memory[INTEL_EFF_CACHE_KEY]) {
            const c = Memory[INTEL_EFF_CACHE_KEY][rn];
            if (c.expiresTick <= Game.time) { delete Memory[INTEL_EFF_CACHE_KEY][rn]; continue; }
            out.push({ room: rn, completedTick: c.completedTick, expiresTick: c.expiresTick });
        }
        return out;
    }
    const c = Memory[INTEL_EFF_CACHE_KEY] && Memory[INTEL_EFF_CACHE_KEY][roomName];
    if (!c) return null;
    if (c.expiresTick <= Game.time) { delete Memory[INTEL_EFF_CACHE_KEY][roomName]; return null; }
    return c;
}
function _itCleanExpired(){
    if(Memory[INTEL_EFF_CACHE_KEY])for(const rn in Memory[INTEL_EFF_CACHE_KEY])if((Memory[INTEL_EFF_CACHE_KEY][rn].expiresTick||0)<=Game.time)delete Memory[INTEL_EFF_CACHE_KEY][rn];
    if(Memory.roomIntelPending)for(const rn in Memory.roomIntelPending)if(Game.time-Memory.roomIntelPending[rn].tick>5)delete Memory.roomIntelPending[rn];
    if(Memory.intelPowerObserve)for(const rn in Memory.intelPowerObserve)if(Game.time-Memory.intelPowerObserve[rn].tick>50)delete Memory.intelPowerObserve[rn];
}
function _processPendingIntel(){
    if(!Memory.roomIntelPending)return;
    for(const rn in Memory.roomIntelPending){const p=Memory.roomIntelPending[rn];if(Game.time-p.tick===1&&Game.rooms[rn]){if(p.fast){console.log('[IntelFast] Auto-completing fast intel for '+rn);intelFast(rn);}else{console.log('[Intel] Auto-completing intel for '+rn);intel(rn);}}}
}

/** Silent version for playerAnalysis internal use */
function _itRunSilent(room) {
    const fp = _roomFingerprint(room);
    const ecoD=_itAnalyzeEco(room,null,fp),milD=_itAnalyzeMil(room,fp),dpD=_itAnalyzeDP(room,fp);
    const eS=clamp(ecoD.score),mS=clamp(milD.score),dS=clamp(dpD.score);
    const overall=eS*INTEL_W_FAST.economic+mS*INTEL_W_FAST.military+dS*INTEL_W_FAST.dualPurpose;
    const eV=_itCalcEcoValue(room,fp),mV=_itCalcMilValue(room,fp),dV=_itCalcDPValue(room,fp);
    const towers=_fpByType(fp,STRUCTURE_TOWER);
    const nuker=_fpByType(fp,STRUCTURE_NUKER)[0];
    const storage=room.storage,terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
    const ramparts=_fpByType(fp,STRUCTURE_RAMPART);
    const walls=_fpByType(fp,STRUCTURE_WALL);
    const allDef=ramparts.concat(walls);
    const weakRamparts=ramparts.filter(r=>r.hits<100000);
    const allCreeps=fp.creeps;
    let nukerReady=false,nukerCharging=false,nukerEnergy=0,nukerGhodium=0;
    if(nuker){nukerEnergy=nuker.store[RESOURCE_ENERGY]||0;nukerGhodium=nuker.store[RESOURCE_GHODIUM]||0;nukerReady=nukerEnergy>=nuker.store.getCapacity(RESOURCE_ENERGY)&&nukerGhodium>=nuker.store.getCapacity(RESOURCE_GHODIUM)&&!(nuker.cooldown||0);nukerCharging=(nukerEnergy>0||nukerGhodium>0)&&!nukerReady;}
    let combatBoosts=0;const addB=(s)=>{if(s)for(const b of ALL_COMBAT_BOOSTS)combatBoosts+=s[b]||0;};addB(storage&&storage.store);addB(terminal&&terminal.store);
    const sources=fp.sources,mineral=fp.minerals[0];
    const links=_fpByType(fp,STRUCTURE_LINK),containers=_fpByType(fp,STRUCTURE_CONTAINER);
    let srcInfra=0;for(const s of sources)if(s.pos.findInRange(links,3).length>0||s.pos.findInRange(containers,3).length>0)srcInfra++;
    const powerCreeps=fp.powerCreeps;
    const boostedCreeps=allCreeps.filter(c=>c.body.some(p=>p.boost));
    const allRes=new Set();if(storage&&storage.store)Object.keys(storage.store).filter(k=>storage.store[k]>0).forEach(k=>allRes.add(k));if(terminal&&terminal.store)Object.keys(terminal.store).filter(k=>terminal.store[k]>0).forEach(k=>allRes.add(k));
    const powerSpawnObj=_fpByType(fp,STRUCTURE_POWER_SPAWN)[0];
    const factoryObj=_fpByType(fp,STRUCTURE_FACTORY)[0];
    return {
        room:room.name,owner:room.controller&&room.controller.owner?room.controller.owner.username:'Unowned',
        rcl:room.controller?room.controller.level:0,tick:Game.time,
        scores:{overall:r1(overall),economic:r1(eS),military:r1(mS),dualPurpose:r1(dS)},
        structures:{spawns:_fpByType(fp,STRUCTURE_SPAWN).length,extensions:_fpByType(fp,STRUCTURE_EXTENSION).length,towers:towers.length,storage:!!storage,terminal:!!terminal,nuker:!!nuker,nukerReady,nukerCharging,nukerEnergy,nukerGhodium,factory:!!factoryObj,factoryLevel:(factoryObj&&factoryObj.level)||0,labs:_fpByType(fp,STRUCTURE_LAB).length,powerSpawn:!!powerSpawnObj,observer:!!_fpByType(fp,STRUCTURE_OBSERVER)[0],ramparts:ramparts.length,walls:walls.length,links:links.length},
        resources:{storageEnergy:storage?(storage.store[RESOURCE_ENERGY]||0):0,storageTotal:storage?storage.store.getUsedCapacity():0,terminalEnergy:terminal?(terminal.store[RESOURCE_ENERGY]||0):0,terminalTotal:terminal?terminal.store.getUsedCapacity():0,power:(storage?storage.store[RESOURCE_POWER]||0:0)+(terminal?terminal.store[RESOURCE_POWER]||0:0)+(powerSpawnObj&&powerSpawnObj.store?powerSpawnObj.store[RESOURCE_POWER]||0:0),combatBoosts,resourceDiversity:allRes.size},
        defense:{avgDefenseHits:allDef.length>0?Math.round(allDef.reduce((s,d)=>s+d.hits,0)/allDef.length):0,minDefenseHits:allDef.length>0?Math.min(...allDef.map(d=>d.hits)):0,weakRamparts:weakRamparts.length,safeModeAvailable:room.controller?room.controller.safeModeAvailable||0:0,safeModeCooldown:room.controller?room.controller.safeModeCooldown||0:0},
        creeps:{total:allCreeps.length,boosted:boostedCreeps.length,large:allCreeps.filter(c=>c.body.length>=30).length,maxSize:allCreeps.length>0?Math.max(...allCreeps.map(c=>c.body.length)):0,powerCreeps:powerCreeps.length},
        controller:{level:room.controller?room.controller.level:0,progress:room.controller?room.controller.progress:0,progressTotal:room.controller?room.controller.progressTotal:0,progressPercent:room.controller&&room.controller.progressTotal>0?Math.round(room.controller.progress/room.controller.progressTotal*1000)/10:0,downgradeTimer:room.controller?room.controller.ticksToDowngrade:0},
        economy:{energyAvailable:room.energyAvailable,energyCapacity:room.energyCapacityAvailable,sources:sources.length,mineral:mineral?mineral.mineralType:null,mineralAmount:mineral?mineral.mineralAmount:0}
    };
}


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████  ENERGY PROFILE  ██████████████████████████████████
//
// Long-window (1500 tick) per-room energy economy analyzer. Tracks income per
// source, per-building spend, per-WORK-creep ledger with 50% name-similarity
// grouping, death/tombstone loss attribution, and a mass-balance residual.
// Quantitatively overlaps with intel()'s 100-tick efficiency profile but
// lives in a different time regime and adds per-creep diagnostics that the
// score-based intel report does not.
// ════════════════════════════════════════════════════════════════════════════

// ── Heap-only prev snapshot (per roomName) ────────────────────────────────
function _enGetPrev(rn) { return (global[ENERGY_EFF_GLOBAL_PREV] && global[ENERGY_EFF_GLOBAL_PREV][rn]) || null; }
function _enSetPrev(rn, s) { if (!global[ENERGY_EFF_GLOBAL_PREV]) global[ENERGY_EFF_GLOBAL_PREV] = {}; global[ENERGY_EFF_GLOBAL_PREV][rn] = s; }
function _enClearPrev(rn) { if (global[ENERGY_EFF_GLOBAL_PREV]) delete global[ENERGY_EFF_GLOBAL_PREV][rn]; }
function _enClearAllPrev() { delete global[ENERGY_EFF_GLOBAL_PREV]; }

// ── Snapshot ──────────────────────────────────────────────────────────────
function _enTakeSnap(room) {
    const snap = {
        sources:    {},
        towers:     {},
        labs:       {},
        links:      {},
        spawns:     {},
        terminal:   null,
        nuker:      null,
        powerSpawn: null,
        tombstones: {},
        drops:      {},
        creepIds:   {},
        creepNames: {},
        roomTotal:  0,
    };
    for (const s of room.find(FIND_SOURCES)) snap.sources[s.id] = s.energy;
    for (const s of room.find(FIND_STRUCTURES)) {
        const e = (s.store && s.store[RESOURCE_ENERGY]) || 0;
        switch (s.structureType) {
            case STRUCTURE_TOWER:       snap.towers[s.id] = e;  snap.roomTotal += e; break;
            case STRUCTURE_LAB:         snap.labs[s.id]   = e;  snap.roomTotal += e; break;
            case STRUCTURE_LINK:        snap.links[s.id]  = e;  snap.roomTotal += e; break;
            case STRUCTURE_TERMINAL:    snap.terminal   = { id: s.id, energy: e }; snap.roomTotal += e; break;
            case STRUCTURE_NUKER:       snap.nuker      = { id: s.id, energy: e }; snap.roomTotal += e; break;
            case STRUCTURE_POWER_SPAWN: snap.powerSpawn = { id: s.id, energy: e }; snap.roomTotal += e; break;
            case STRUCTURE_SPAWN: {
                const sp = s.spawning;
                snap.spawns[s.id] = sp ? { name: sp.name } : null;
                snap.roomTotal += e;
                break;
            }
            default:
                if (s.store) snap.roomTotal += e;
                break;
        }
    }
    for (const c of room.find(FIND_CREEPS)) {
        snap.roomTotal += (c.store && c.store[RESOURCE_ENERGY]) || 0;
        snap.creepIds[c.id]     = { name: c.name, body: c.body, my: c.my };
        snap.creepNames[c.name] = { id: c.id, body: c.body, my: c.my };
    }
    for (const pc of room.find(FIND_POWER_CREEPS)) {
        snap.roomTotal += (pc.store && pc.store[RESOURCE_ENERGY]) || 0;
    }
    for (const t of room.find(FIND_TOMBSTONES)) {
        const e = (t.store && t.store[RESOURCE_ENERGY]) || 0;
        snap.tombstones[t.id] = {
            energy:    e,
            creepName: t.creep ? t.creep.name : null,
            creepId:   t.creep ? t.creep.id   : null,
        };
        snap.roomTotal += e;
    }
    for (const r of room.find(FIND_RUINS)) {
        snap.roomTotal += (r.store && r.store[RESOURCE_ENERGY]) || 0;
    }
    for (const d of room.find(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY,
    })) {
        snap.drops[d.id] = d.amount;
        snap.roomTotal  += d.amount;
    }
    return snap;
}

// ── Totals ────────────────────────────────────────────────────────────────
function _enInitTotals() {
    return {
        ticksObserved:  0,
        invisibleTicks: 0,

        sourceMaxRates:  {},
        sourceHarvested: {},
        sourceNames:     {},

        towerSpend: {},
        labSpend:   {},
        linkSpend:  {},
        terminalSpend:    0,
        terminalReceived: 0,
        nukerSpend:       0,
        powerSpawnSpend:  0,

        linkDeposits:  0,
        linkWithdraws: 0,
        linkNetDelta:  0,

        creepToTerminal:   0,
        creepFromTerminal: 0,

        workSpawnCost:    0,
        nonWorkSpawnCost: 0,

        initialRoomTotal: 0,
        finalRoomTotal:   0,
    };
}

// ── Creep ledger entry factory ────────────────────────────────────────────
function _enNewLedgerEntry(id, name, body, role, isPreExisting, tick) {
    return {
        id, name, role,
        bodySig:        _bpSig(body),
        bodyCost:       _bpCostOf(body),
        ticksFirstSeen: tick,
        ticksLastSeen:  tick,
        harvested: 0, upgraded: 0, built: 0, repaired: 0,
        diedAtTick:           null,
        diedLoaded:           0,
        tombstoneId:          null,
        tombstoneFinalEnergy: null,
        tombstoneLooted:      0,
        tombstoneDespawned:   null,
        preExisting:          !!isPreExisting,
    };
}

// ── Event log processing ──────────────────────────────────────────────────
function _enProcessEvents(events, t, ledger, towerIds, linkIds, terminalId) {
    if (!events || !events.length) return;
    for (const ev of events) {
        const oid  = ev.objectId;
        const data = ev.data || {};
        switch (ev.event) {
            case EV_HARVEST: {
                const amt = data.amount || 0;
                if (data.targetId && t.sourceMaxRates[data.targetId] !== undefined) {
                    t.sourceHarvested[data.targetId] = (t.sourceHarvested[data.targetId] || 0) + amt;
                    if (oid && ledger[oid]) ledger[oid].harvested += amt;
                }
                break;
            }
            case EV_UPGRADE_CONTROLLER: {
                const amt = data.amount || 0;
                if (oid && ledger[oid]) ledger[oid].upgraded += amt;
                break;
            }
            case EV_BUILD: {
                const amt = (typeof data.energySpent === 'number' && data.energySpent > 0)
                    ? data.energySpent
                    : (data.amount || 0);
                if (oid && ledger[oid]) ledger[oid].built += amt;
                break;
            }
            case EV_REPAIR: {
                if (towerIds.has(oid)) break; // tower repairs — counted as tower spend, not creep
                let amt;
                if (typeof data.energySpent === 'number') {
                    amt = data.energySpent;
                } else {
                    amt = (data.amount || 0) * (typeof REPAIR_COST !== 'undefined' ? REPAIR_COST : 0.01);
                }
                if (oid && ledger[oid]) ledger[oid].repaired += amt;
                break;
            }
            case EV_TRANSFER: {
                if (data.resourceType !== RESOURCE_ENERGY) break;
                const amt = data.amount || 0;
                if (linkIds.has(data.targetId)) t.linkDeposits  += amt;
                if (linkIds.has(oid))           t.linkWithdraws += amt;
                if (terminalId && data.targetId === terminalId) t.creepToTerminal   += amt;
                if (terminalId && oid === terminalId)            t.creepFromTerminal += amt;
                break;
            }
            default: break;
        }
    }
}

// ── Per-tick accumulate ───────────────────────────────────────────────────
function _enAccumulate(prev, curr, room, state) {
    const t      = state.totals;
    const ledger = state.creepLedger;

    // Towers
    const towerIds = new Set();
    for (const id in curr.towers) {
        towerIds.add(id);
        if (prev.towers[id] !== undefined) {
            const drop = Math.max(0, prev.towers[id] - curr.towers[id]);
            if (drop > 0) t.towerSpend[id] = (t.towerSpend[id] || 0) + drop;
        }
    }

    // Labs
    for (const id in curr.labs) {
        if (prev.labs[id] !== undefined) {
            const drop = Math.max(0, prev.labs[id] - curr.labs[id]);
            if (drop > 0) t.labSpend[id] = (t.labSpend[id] || 0) + drop;
        }
    }

    // Links
    const linkIds = new Set();
    for (const id in curr.links) {
        linkIds.add(id);
        if (prev.links[id] !== undefined) {
            const drop = Math.max(0, prev.links[id] - curr.links[id]);
            if (drop > 0) t.linkSpend[id] = (t.linkSpend[id] || 0) + drop;
            t.linkNetDelta += (curr.links[id] - prev.links[id]);
        }
    }

    // Terminal
    let terminalId = null;
    if (curr.terminal) {
        terminalId = curr.terminal.id;
        if (prev.terminal) {
            const drop = Math.max(0, prev.terminal.energy - curr.terminal.energy);
            const gain = Math.max(0, curr.terminal.energy - prev.terminal.energy);
            t.terminalSpend    += drop;
            t.terminalReceived += gain;
        }
    }

    // Nuker
    if (curr.nuker && prev.nuker) {
        t.nukerSpend += Math.max(0, prev.nuker.energy - curr.nuker.energy);
    }

    // Power spawn
    if (curr.powerSpawn && prev.powerSpawn) {
        t.powerSpawnSpend += Math.max(0, prev.powerSpawn.energy - curr.powerSpawn.energy);
    }

    // Spawn detection
    for (const id in curr.spawns) {
        const cs = curr.spawns[id];
        const ps = prev.spawns[id];
        const currName = cs ? cs.name : null;
        const prevName = ps ? ps.name : null;
        if (!currName || currName === prevName) continue;

        const info = curr.creepNames[currName];
        if (!info || !info.body || !info.body.length) {
            state.pendingSpawnNames = state.pendingSpawnNames || {};
            state.pendingSpawnNames[currName] = Game.time;
            continue;
        }

        const cost   = _bpCostOf(info.body);
        const isWork = _bpHasWork(info.body);
        if (isWork) {
            t.workSpawnCost += cost;
            state.spawnedNames[currName] = { role: 'pending', bodyCost: cost, bodySig: _bpSig(info.body) };
        } else {
            t.nonWorkSpawnCost += cost;
            state.nonWorkNames[currName] = true;
        }
    }

    // Recover pending spawns
    if (state.pendingSpawnNames) {
        for (const name in state.pendingSpawnNames) {
            const info = curr.creepNames[name];
            if (!info || !info.body || !info.body.length) continue;
            const cost   = _bpCostOf(info.body);
            const isWork = _bpHasWork(info.body);
            if (isWork) {
                t.workSpawnCost += cost;
                state.spawnedNames[name] = { role: 'pending', bodyCost: cost, bodySig: _bpSig(info.body) };
            } else {
                t.nonWorkSpawnCost += cost;
                state.nonWorkNames[name] = true;
            }
            delete state.pendingSpawnNames[name];
        }
    }

    // Creep ledger maintenance
    for (const id in curr.creepIds) {
        const info = curr.creepIds[id];
        if (ledger[id]) { ledger[id].ticksLastSeen = Game.time; continue; }
        if (state.nonWorkNames[info.name]) continue;
        if (!_bpHasWork(info.body))        continue;

        const spawnInfo  = state.spawnedNames[info.name];
        const preExisting = !spawnInfo;
        const role        = _bpInferRole(info.body);
        ledger[id] = _enNewLedgerEntry(id, info.name, info.body, role, preExisting, Game.time);
        if (spawnInfo) delete state.spawnedNames[info.name];
    }

    // Death detection
    for (const id in ledger) {
        const e = ledger[id];
        if (e.diedAtTick !== null) continue;
        if (curr.creepIds[id])     continue;
        if (!prev.creepIds[id])    continue;

        e.diedAtTick = Game.time;
        for (const tid in curr.tombstones) {
            const ts = curr.tombstones[tid];
            if (ts.creepId === id || ts.creepName === e.name) {
                e.tombstoneId = tid;
                e.diedLoaded  = ts.energy;
                state.tombstoneToLedger[tid] = id;
                break;
            }
        }
    }

    // Tombstone fate
    for (const tid in state.tombstoneToLedger) {
        const lid = state.tombstoneToLedger[tid];
        const e   = ledger[lid];
        if (!e) continue;
        const prevTs = prev.tombstones[tid];
        const currTs = curr.tombstones[tid];
        if (currTs) {
            const drop = prevTs ? Math.max(0, prevTs.energy - currTs.energy) : 0;
            e.tombstoneLooted     += drop;
            e.tombstoneFinalEnergy = currTs.energy;
        } else {
            if (prevTs) {
                e.tombstoneFinalEnergy = 0;
                e.tombstoneDespawned   = prevTs.energy > 0;
            }
            delete state.tombstoneToLedger[tid];
        }
    }

    // Event log
    let events;
    try   { events = JSON.parse(room.getEventLog(true)); }
    catch (e) { events = room.getEventLog(); }
    _enProcessEvents(events, t, ledger, towerIds, linkIds, terminalId);

    t.ticksObserved++;
    t.finalRoomTotal = curr.roomTotal;
}

// ── Observer fallback (foreign room) ──────────────────────────────────────
function _enEnsureObserved(roomName) {
    // Foreign rooms go invisible the tick after the observer last fired. Re-fire
    // every tick through the shared booking set so we don't collide with
    // intel/nuke/registry sweeps in the same tick.
    if (Game.rooms[roomName]) {
        const obs = findObserverInRange(roomName, _tickUsedSet());
        if (obs) _tickObserve(obs, roomName);
        return;
    }
    // First time (or after a visibility gap): try the regular observer, then
    // PWR_OPERATE_OBSERVER.
    if (Memory[ENERGY_POWER_OBS_KEY] && Memory[ENERGY_POWER_OBS_KEY][roomName]) {
        const po = Memory[ENERGY_POWER_OBS_KEY][roomName];
        if (Game.time - po.tick <= 50) return;
        delete Memory[ENERGY_POWER_OBS_KEY][roomName];
    }
    const obs = findObserverInRange(roomName, _tickUsedSet());
    if (obs && _tickObserve(obs, roomName)) {
        if (!Memory[ENERGY_PENDING_KEY]) Memory[ENERGY_PENDING_KEY] = {};
        Memory[ENERGY_PENDING_KEY][roomName] = { tick: Game.time, observerRoom: obs.room.name };
        return;
    }
    const po = tryPowerObserver(roomName);
    if (po) {
        if (!Memory[ENERGY_POWER_OBS_KEY]) Memory[ENERGY_POWER_OBS_KEY] = {};
        Memory[ENERGY_POWER_OBS_KEY][roomName] = { operatorName: po.operatorName, operatorRoom: po.operatorRoom, tick: Game.time };
    }
}

function _enRoomIsOwn(roomName) {
    const r = Game.rooms[roomName];
    return !!(r && r.controller && r.controller.my);
}

// ── Profile lifecycle ─────────────────────────────────────────────────────
function _enStartProfile(target) {
    if (!target || typeof target !== 'string' || !ENERGY_ROOM_NAME_RE.test(target)) {
        console.log('[EnergyProfiler] Usage: profileEnergy("W5N3")');
        return;
    }
    if (Memory[ENERGY_EFF_MEM_KEY] && Memory[ENERGY_EFF_MEM_KEY].active) {
        console.log('[EnergyProfiler] Already active for ' + Memory[ENERGY_EFF_MEM_KEY].roomName + '. Call cancelEnergyProfile() first.');
        return;
    }
    // Don't fight an in-flight intel profile on the same room — observers are limited.
    if (Memory[INTEL_EFF_MEM_KEY] && Memory[INTEL_EFF_MEM_KEY][target] && Memory[INTEL_EFF_MEM_KEY][target].active) {
        console.log('[EnergyProfiler] intel() is currently profiling ' + target + ' — cancel it first or pick a different room.');
        return;
    }

    const own = _enRoomIsOwn(target);

    if (own) {
        const room = Game.rooms[target];
        if (!room) { console.log('[EnergyProfiler] ERROR: ' + target + ' not visible.'); return; }
        console.log('[EnergyProfiler] ' + target + ' is your room — no observer needed.');
        // Baseline is captured on the first _enTickRoom call (no eager prev set
        // here), so accumulation starts on tick 2 — same as the original.
        Memory[ENERGY_EFF_MEM_KEY] = {
            active:        true,
            phase:         'profiling',
            roomName:      target,
            startTick:     Game.time,
            ownRoom:       true,
            observerCount: 0,
            totals:        _enInitTotals(),
            creepLedger:   {},
            spawnedNames:  {},
            nonWorkNames:  {},
            pendingSpawnNames: {},
            tombstoneToLedger: {},
            notifyQueue:   [],
            notifySent:    0,
        };
        const elapsedHrs = (ENERGY_PROFILE_TICKS / 3600).toFixed(1);
        console.log('[EnergyProfiler] Started — ' + target + ' for ' + ENERGY_PROFILE_TICKS + ' ticks (~' + elapsedHrs + ' hours wall-clock).');
        return;
    }

    // Foreign room: defer state creation until visible. _enEnsureObserved
    // handles the actual observation every tick.
    if (!obsInRange(target)) {
        console.log('[EnergyProfiler] ERROR: no observer within 10 rooms of ' + target + '.');
        return;
    }
    console.log('[EnergyProfiler] ' + target + ' is foreign — observation handled by _enEnsureObserved each tick.');
    Memory[ENERGY_EFF_MEM_KEY] = {
        active:        true,
        phase:         'awaiting-visibility',
        roomName:      target,
        startTick:     Game.time,
        ownRoom:       false,
        observerCount: 0,
        totals:        _enInitTotals(),
        creepLedger:   {},
        spawnedNames:  {},
        nonWorkNames:  {},
        pendingSpawnNames: {},
        tombstoneToLedger: {},
        notifyQueue:   [],
        notifySent:    0,
    };
}

function _enTickRoom(state) {
    const name = state.roomName;
    const own  = state.ownRoom;

    if (!own) _enEnsureObserved(name);

    const room = Game.rooms[name];
    if (!room) { state.totals.invisibleTicks++; return false; }

    // Foreign room just became visible: take baseline snap + populate source state.
    if (!own && state.totals.ticksObserved === 0 && Object.keys(state.totals.sourceMaxRates).length === 0) {
        const sources = room.find(FIND_SOURCES);
        let sIdx = 1;
        for (const src of sources) {
            state.totals.sourceMaxRates[src.id]  = _itSourceMaxRate(src);
            state.totals.sourceHarvested[src.id] = 0;
            state.totals.sourceNames[src.id]     = 'S' + (sIdx++);
        }
        const baseline = _enTakeSnap(room);
        state.totals.initialRoomTotal = baseline.roomTotal;
        state.totals.finalRoomTotal   = baseline.roomTotal;
        _enSetPrev(name, baseline);
        state.phase = 'profiling';
        console.log('[EnergyProfiler] Baseline — ' + name + ' @ tick ' + Game.time);
        return false;
    }

    const snap = _enTakeSnap(room);
    const prev = _enGetPrev(name);

    if (!prev) {
        _enSetPrev(name, snap);
        console.log('[EnergyProfiler] Baseline — ' + name + ' @ tick ' + Game.time);
        return false;
    }

    _enAccumulate(prev, snap, room, state);
    _enSetPrev(name, snap);

    const t = state.totals.ticksObserved;
    if (t > 0 && t % ENERGY_LOG_INTERVAL === 0 && t < ENERGY_PROFILE_TICKS) {
        const elapsed = Game.time - state.startTick;
        const eta     = Math.round(elapsed * (ENERGY_PROFILE_TICKS - t) / Math.max(1, t));
        console.log('[EnergyProfiler] ' + name + ' — ' + t + '/' + ENERGY_PROFILE_TICKS + ' diff ticks  (elapsed ' + elapsed + ', ETA ~' + eta + ' ticks)');
    }

    return t >= ENERGY_PROFILE_TICKS;
}

function _enFinalise(state, partial) {
    const lines = _enPrintReport(state, partial);
    state.phase       = 'notifying';
    state.notifyQueue = _enSplitNotifications(lines, state.roomName);
    state.notifySent  = 0;
    _enClearPrev(state.roomName);
    if (Memory[ENERGY_PENDING_KEY]) delete Memory[ENERGY_PENDING_KEY][state.roomName];
    if (Memory[ENERGY_POWER_OBS_KEY]) delete Memory[ENERGY_POWER_OBS_KEY][state.roomName];
}

function _enCleanExpired() {
    if (Memory[ENERGY_EFF_CACHE_KEY])
        for (const rn in Memory[ENERGY_EFF_CACHE_KEY])
            if ((Memory[ENERGY_EFF_CACHE_KEY][rn].expiresTick || 0) <= Game.time)
                delete Memory[ENERGY_EFF_CACHE_KEY][rn];
    if (Memory[ENERGY_PENDING_KEY])
        for (const rn in Memory[ENERGY_PENDING_KEY])
            if (Game.time - Memory[ENERGY_PENDING_KEY][rn].tick > 5)
                delete Memory[ENERGY_PENDING_KEY][rn];
    if (Memory[ENERGY_POWER_OBS_KEY])
        for (const rn in Memory[ENERGY_POWER_OBS_KEY])
            if (Game.time - Memory[ENERGY_POWER_OBS_KEY][rn].tick > 50)
                delete Memory[ENERGY_POWER_OBS_KEY][rn];
}

function _enGetCached(roomName) {
    if (!Memory[ENERGY_EFF_CACHE_KEY] || !Memory[ENERGY_EFF_CACHE_KEY][roomName]) return null;
    const c = Memory[ENERGY_EFF_CACHE_KEY][roomName];
    if (c.expiresTick <= Game.time) { delete Memory[ENERGY_EFF_CACHE_KEY][roomName]; return null; }
    return c;
}

function _enProcessProfiles() {
    const state = Memory[ENERGY_EFF_MEM_KEY];
    if (!state || !state.active) return;
    if (state.phase === 'notifying') { _enRunNotifyPhase(state); return; }

    const done = _enTickRoom(state);
    if (done) _enFinalise(state, false);
}

// ── Public API ────────────────────────────────────────────────────────────
function energyStart(target) { _enStartProfile(target); }

function energyCancel() {
    const state = Memory[ENERGY_EFF_MEM_KEY];
    if (!state) { console.log('[EnergyProfiler] Nothing active.'); return; }
    if (state.phase === 'notifying') {
        console.log('[EnergyProfiler] Cancelling pending notifications (' +
            (state.notifyQueue.length - state.notifySent) + ' remaining).');
        _enClearAllPrev();
        delete Memory[ENERGY_EFF_MEM_KEY];
        return;
    }
    console.log('[EnergyProfiler] Cancelling — printing partial results for ' +
        state.roomName + ' after ' + state.totals.ticksObserved + ' ticks.');
    if (state.totals.ticksObserved > 0) {
        const lines = _enPrintReport(state, true);
        state.phase       = 'notifying';
        state.notifyQueue = _enSplitNotifications(lines, state.roomName);
        state.notifySent  = 0;
        _enClearAllPrev();
        return;
    }
    _enClearAllPrev();
    delete Memory[ENERGY_EFF_MEM_KEY];
}

function energyRun() {
    const state = Memory[ENERGY_EFF_MEM_KEY];
    if (!state || !state.active) return;
    if (state.phase === 'notifying') { _enRunNotifyPhase(state); return; }
    const done = _enTickRoom(state);
    if (done) _enFinalise(state, false);
}

function energyStatus() {
    const state = Memory[ENERGY_EFF_MEM_KEY];
    if (!state || !state.active) { console.log('[EnergyProfiler] No active profile.'); return null; }

    if (state.phase === 'notifying') {
        const remaining = state.notifyQueue.length - state.notifySent;
        console.log('[EnergyProfiler] ' + state.roomName + ' — notifying: ' +
            state.notifySent + '/' + state.notifyQueue.length +
            ' sent (' + remaining + ' remaining)');
        return state;
    }

    const t       = state.totals;
    const obs     = t.ticksObserved;
    const pct     = ((obs / ENERGY_PROFILE_TICKS) * 100).toFixed(1);
    const elapsed = Game.time - state.startTick;
    const eta     = obs > 0 ? Math.round(elapsed * (ENERGY_PROFILE_TICKS - obs) / obs) : '?';

    const ledgerCount     = Object.keys(state.creepLedger).length;
    const aliveCount      = Object.values(state.creepLedger).filter(e => e.diedAtTick === null).length;
    const totalHarvested  = Object.values(t.sourceHarvested).reduce((s, v) => s + v, 0);
    const incomePerTick   = obs > 0 ? totalHarvested / obs : 0;
    const sumVals         = obj => Object.values(obj).reduce((s, v) => s + v, 0);
    const buildingSpend   = sumVals(t.towerSpend) + sumVals(t.labSpend)
                          + t.nukerSpend + t.powerSpawnSpend
                          + Math.max(0, t.terminalSpend - t.creepFromTerminal);

    console.log('[EnergyProfiler] ' + state.roomName +
        '  [' + (state.ownRoom ? 'own' : 'foreign') + ']');
    console.log('  Progress  : ' + obs + '/' + ENERGY_PROFILE_TICKS + ' (' + pct + '%)' +
        '   invis=' + t.invisibleTicks);
    console.log('  Elapsed   : ' + elapsed + ' ticks   ETA ' + eta + ' ticks');
    console.log('  Income    : ~' + incomePerTick.toFixed(2) + ' E/tick  (total ' +
        Math.round(totalHarvested) + ')');
    console.log('  Bldg spend: ~' + (obs > 0 ? (buildingSpend / obs).toFixed(2) : '0') +
        ' E/tick  (total ' + Math.round(buildingSpend) + ')');
    console.log('  WORK creeps: ' + ledgerCount + ' tracked  (' + aliveCount + ' alive)');
    console.log('  Spawn cost: work ' + t.workSpawnCost + '   non-work ' + t.nonWorkSpawnCost);

    return state;
}

// ── Name-similarity creep grouping ────────────────────────────────────────
function _enCommonPrefixLen(a, b) {
    const min = Math.min(a.length, b.length);
    let i = 0;
    while (i < min && a.charAt(i) === b.charAt(i)) i++;
    return i;
}

function _enGroupCreeps(entries, threshold) {
    const t = (threshold !== undefined) ? threshold : ENERGY_SIMILARITY_THRESHOLD;
    const groups = [];
    for (const c of entries) {
        const name = c.name || c.id || '';
        if (!name) continue;
        let placed = false;
        for (const g of groups) {
            const cp = _enCommonPrefixLen(name, g.prefix);
            const r1 = cp / name.length;
            const r2 = cp / g.prefix.length;
            if (r1 >= t && r2 >= t) {
                g.prefix = name.slice(0, cp);
                g.members.push(c);
                placed = true;
                break;
            }
        }
        if (!placed) groups.push({ prefix: name, members: [c] });
    }
    for (const g of groups) {
        const allExact = g.members.every(m => (m.name || m.id || '') === g.prefix);
        g.label = allExact ? g.prefix : g.prefix + '*';
    }
    return groups;
}

function _enAggregateGroup(g) {
    const ms = g.members;
    const harvested = ms.reduce((s, m) => s + (m.harvested || 0), 0);
    const upgraded  = ms.reduce((s, m) => s + (m.upgraded  || 0), 0);
    const built     = ms.reduce((s, m) => s + (m.built     || 0), 0);
    const repaired  = ms.reduce((s, m) => s + (m.repaired  || 0), 0);
    const bodyCost  = ms.reduce((s, m) => s + (m.bodyCost  || 0), 0);
    const total     = harvested + upgraded + built + repaired;

    const sigs = {}, roles = {};
    for (const m of ms) {
        sigs[m.bodySig || '?']  = (sigs[m.bodySig || '?']  || 0) + 1;
        roles[m.role || '?']    = (roles[m.role || '?']    || 0) + 1;
    }
    const sigEntries  = Object.entries(sigs).sort((a, b) => b[1] - a[1]);
    const roleEntries = Object.entries(roles).sort((a, b) => b[1] - a[1]);
    const bodySigStr  = sigEntries.length > 1 ? (sigEntries[0][0] + '+') : sigEntries[0][0];
    const roleStr     = roleEntries.length > 1 ? (roleEntries[0][0] + '+') : roleEntries[0][0];

    const numPreExisting = ms.filter(m => m.preExisting).length;
    const numDied        = ms.filter(m => m.diedAtTick !== null).length;
    const tombstoneLoss  = ms.reduce((s, m) =>
        s + (m.tombstoneDespawned ? Math.max(0, (m.diedLoaded || 0) - (m.tombstoneLooted || 0)) : 0), 0);

    return {
        label: g.label,
        count: ms.length,
        bodySig: bodySigStr,
        role: roleStr,
        bodyCost, harvested, upgraded, built, repaired, total,
        numPreExisting, numDied, tombstoneLoss,
        members: ms,
    };
}

// ── Report formatting helpers ─────────────────────────────────────────────
function _enF0(n)  { return Math.round(n).toString(); }
function _enF1(n)  { return n.toFixed(1); }
function _enF2(n)  { return n.toFixed(2); }
function _enPct(n) { return (n * 100).toFixed(1) + '%'; }
function _enFmtNum(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n).toString();
}
function _enFmtPctSafe(num, denom) {
    if (denom === 0) return '   —';
    return (num / denom * 100).toFixed(1) + '%';
}
function _enShortId(id) {
    if (!id) return '?';
    return id.length > 6 ? id.slice(-6) : id;
}
function _enPadR(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function _enPadL(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s; }

// ── Report builder ────────────────────────────────────────────────────────
function _enBuildReport(state, partial) {
    const t       = state.totals;
    const obs     = Math.max(1, t.ticksObserved);
    const ledger  = state.creepLedger;
    const own     = state.ownRoom;
    const elapsed = Game.time - state.startTick;

    // Income
    const totalHarvested = Object.values(t.sourceHarvested).reduce((s, v) => s + v, 0);
    const maxIncome      = Object.values(t.sourceMaxRates).reduce((s, v) => s + v, 0);
    const incomePerTick  = Math.min(totalHarvested / obs, maxIncome);
    const sourceLines    = [];
    for (const sid in t.sourceMaxRates) {
        const harv = t.sourceHarvested[sid] || 0;
        const max  = t.sourceMaxRates[sid];
        const frac = max > 0 ? Math.min(1, harv / (obs * max)) : 0;
        sourceLines.push({
            label:    t.sourceNames[sid] + ' ' + _enShortId(sid),
            harvested: harv,
            rate:     harv / obs,
            maxRate:  max,
            util:     frac,
        });
    }
    sourceLines.sort((a, b) => b.harvested - a.harvested);

    // Derived consumption
    const sumVals    = obj => Object.values(obj).reduce((s, v) => s + v, 0);
    const linkLoss   = Math.max(0, t.linkDeposits - t.linkWithdraws - t.linkNetDelta);
    const extTermOut = Math.max(0, t.terminalSpend    - t.creepFromTerminal);
    const extTermIn  = Math.max(0, t.terminalReceived - t.creepToTerminal);
    const towerTotal = sumVals(t.towerSpend);
    const labTotal   = sumVals(t.labSpend);

    // Creeps + groups
    const creeps = Object.values(ledger).map(e => {
        const lifetimeSpend = e.upgraded + e.built + e.repaired;
        return Object.assign({}, e, {
            lifetimeSpend,
            netCost:    e.preExisting ? lifetimeSpend : e.bodyCost + lifetimeSpend,
            roi:        e.bodyCost > 0 ? (e.harvested + lifetimeSpend) / e.bodyCost : 0,
            ticksAlive: (e.diedAtTick || Game.time) - e.ticksFirstSeen + 1,
        });
    });

    const creepActionTotal = creeps.reduce((s, c) => s + c.upgraded + c.built + c.repaired, 0);
    const tombstoneDespawnLoss = creeps.reduce((s, c) =>
        s + (c.tombstoneDespawned ? Math.max(0, c.diedLoaded - c.tombstoneLooted) : 0), 0);

    const creepGroups = _enGroupCreeps(creeps)
        .map(_enAggregateGroup)
        .sort((a, b) => b.total - a.total);

    // Mass balance
    const deltaRoom = t.finalRoomTotal - t.initialRoomTotal;
    const knownConsumption =
          towerTotal + labTotal + linkLoss + extTermOut
        + t.nukerSpend + t.powerSpawnSpend
        + t.workSpawnCost + t.nonWorkSpawnCost
        + creepActionTotal;
    const loss = totalHarvested + extTermIn - deltaRoom - knownConsumption;

    // Consumption table
    const items = [];
    if (extTermOut > 0)         items.push({ label: 'Terminal (export)',    energy: extTermOut });
    items.push({                                label: 'Loss (unattributed)', energy: loss });
    if (creepActionTotal > 0)   items.push({ label: 'Creep work actions',  energy: creepActionTotal });
    if (t.nonWorkSpawnCost > 0) items.push({ label: 'Non-WORK spawn cost', energy: t.nonWorkSpawnCost });
    if (t.workSpawnCost > 0)    items.push({ label: 'WORK spawn cost',     energy: t.workSpawnCost });
    if (linkLoss > 0)           items.push({ label: 'Link network loss',   energy: linkLoss });
    if (towerTotal > 0)         items.push({ label: 'Towers',              energy: towerTotal });
    if (labTotal > 0)           items.push({ label: 'Labs',                energy: labTotal });
    if (t.nukerSpend > 0)       items.push({ label: 'Nuker',               energy: t.nukerSpend });
    if (t.powerSpawnSpend > 0)  items.push({ label: 'Power Spawn',         energy: t.powerSpawnSpend });

    items.sort((a, b) => b.energy - a.energy);

    const grossOutflow = items.filter(i => i.energy > 0).reduce((s, i) => s + i.energy, 0);
    const netConsumed  = totalHarvested + extTermIn - deltaRoom;
    const usingGross   = loss < 0;
    const denom        = Math.max(1, usingGross ? grossOutflow : netConsumed);
    const denomLabel   = usingGross ? 'gross outflow' : 'total';

    // Format
    const W   = 78;
    const sep = '\u2500'.repeat(W);
    const L   = [];

    L.push('\u256C' + '\u2550'.repeat(W) + '\u256C');
    L.push('  ENERGY PROFILE — ' + state.roomName +
        '  [' + (own ? 'OWN ROOM' : 'FOREIGN ROOM') + ']' +
        (partial ? '   ⚠ PARTIAL' : ''));
    L.push('  ' + obs + ' / ' + ENERGY_PROFILE_TICKS + ' diff ticks   ' +
        '(game ' + state.startTick + '\u2192' + (state.startTick + elapsed) +
        ', invisible=' + t.invisibleTicks + ')');
    L.push(sep);

    // Income
    L.push('  \u2500\u2500 INCOME \u2500\u2500');
    L.push('  Harvested: ' + _enFmtNum(totalHarvested) + ' E   (' +
        _enF2(totalHarvested / obs) + '/tick, capped at ' + _enF2(maxIncome) +
        '   util ' + _enPct(maxIncome > 0 ? incomePerTick / maxIncome : 0) + ')');
    for (const s of sourceLines) {
        L.push('    ' + _enPadR(s.label, 18) + '  ' +
            _enPadL(_enFmtNum(s.harvested), 8) + ' E   ' +
            _enPadL(_enF2(s.rate), 6) + ' / ' + _enF2(s.maxRate) + ' E/t   ' +
            _enPadL(_enPct(s.util), 7));
    }
    L.push(sep);

    // Consumption
    const totalLabel = usingGross
        ? 'gross outflow ' + _enFmtNum(grossOutflow) + ' E (loss ' + _enFmtNum(loss) + ' reconciles to net ' + _enFmtNum(netConsumed) + ')'
        : _enFmtNum(netConsumed) + ' E   (' + _enF2(netConsumed / obs) + '/tick)';
    L.push('  \u2500\u2500 TOTAL CONSUMPTION \u2500\u2500 ' + totalLabel);
    L.push('    ' + _enPadR('Sink', 28) + _enPadL('Energy', 10) + '   ' + _enPadL('% ' + denomLabel, 14) + '   /tick');
    for (const it of items) {
        const isLossRow = it.label.indexOf('Loss') === 0;
        const pctStr = (isLossRow && usingGross)
            ? 'reconciles'
            : _enFmtPctSafe(it.energy, denom);
        L.push('    ' + _enPadR(it.label, 28) +
            _enPadL(_enFmtNum(it.energy), 10) + '   ' +
            _enPadL(pctStr, 14) + '   ' +
            _enPadL(_enF2(it.energy / obs), 7));
    }
    L.push(sep);

    // Creep groups
    const totalGroupContribution = creepGroups.reduce((s, g) => s + g.total, 0);
    L.push('  \u2500\u2500 CREEP GROUPS (50% name similarity) \u2500\u2500   ' +
        creepGroups.length + ' group(s), ' + creeps.length + ' creep(s) tracked, ' +
        _enFmtNum(totalGroupContribution) + ' E contribution');
    if (!creepGroups.length) {
        L.push('    (no WORK creeps observed)');
    } else {
        L.push('    ' + _enPadR('Group', 22) + _enPadL('Cnt', 4) + '  ' +
            _enPadR('Body', 12) + _enPadR('Role', 14) +
            _enPadL('Harv', 7) + _enPadL('Upg', 7) + _enPadL('Bld', 6) +
            _enPadL('Rep', 6) + _enPadL('Total', 7) + '  Notes');
        for (const g of creepGroups) {
            const notes = [];
            if (g.numPreExisting === g.count) notes.push('all pre-existing');
            else if (g.numPreExisting > 0)    notes.push(g.numPreExisting + ' pre-existing');
            if (g.numDied > 0)                notes.push(g.numDied + ' died');
            if (g.tombstoneLoss > 0)          notes.push('lost ' + _enFmtNum(g.tombstoneLoss));
            L.push('    ' + _enPadR(g.label, 22) + _enPadL(String(g.count), 4) + '  ' +
                _enPadR(g.bodySig, 12) + _enPadR(g.role, 14) +
                _enPadL(_enFmtNum(g.harvested), 7) + _enPadL(_enFmtNum(g.upgraded), 7) +
                _enPadL(_enFmtNum(g.built), 6) + _enPadL(_enFmtNum(g.repaired), 6) +
                _enPadL(_enFmtNum(g.total), 7) + '  ' + (notes.join(', ') || ''));
        }
        L.push('    ' + '\u2508'.repeat(74));
        for (const g of creepGroups) {
            if (g.count <= 1 && g.label === g.members[0].name) continue;
            const memberStrs = g.members.map(m => {
                const dead = m.diedAtTick !== null ? '\u2020' : '';
                return (m.name || _enShortId(m.id)) + dead;
            });
            const line = '      ' + _enPadR(g.label + ':', 22) + memberStrs.join(', ');
            if (line.length <= 90) {
                L.push(line);
            } else {
                const head = '      ' + _enPadR(g.label + ':', 22);
                let row = head;
                for (let i = 0; i < memberStrs.length; i++) {
                    const piece = memberStrs[i] + (i < memberStrs.length - 1 ? ', ' : '');
                    if (row.length + piece.length > 90 && row !== head) {
                        L.push(row);
                        row = ' '.repeat(head.length) + piece;
                    } else {
                        row += piece;
                    }
                }
                if (row.trim().length > 0) L.push(row);
            }
        }
        L.push('    \u2020 = died during window');
    }
    L.push(sep);

    // Mass balance
    const accountedFor  = knownConsumption + loss;
    const expectedTotal = totalHarvested + extTermIn - deltaRoom;
    L.push('  \u2500\u2500 MASS BALANCE \u2500\u2500');
    L.push('    Income + extTermIn \u2212 \u0394Room            = ' + _enFmtNum(expectedTotal));
    L.push('    Accounted (consumption + loss)        = ' + _enFmtNum(accountedFor));
    L.push('    \u0394 room non-source energy              = ' + _enFmtNum(deltaRoom) +
        '  (initial ' + _enFmtNum(t.initialRoomTotal) +
        ', final ' + _enFmtNum(t.finalRoomTotal) + ')');
    if (extTermIn > 0) {
        L.push('    External terminal IN                  = ' + _enFmtNum(extTermIn));
    }
    if (Math.abs(loss) > 0.05 * Math.max(1, totalHarvested)) {
        L.push('    \u26A0 Large residual: ' + _enFmtNum(loss) + ' E (' +
            ((Math.abs(loss) / Math.max(1, totalHarvested)) * 100).toFixed(1) +
            '% of harvest) \u2014 attribution may be incomplete');
    }
    L.push('\u2569' + '\u2550'.repeat(W) + '\u2569');

    return {
        lines: L,
        summary: {
            obs, totalHarvested, incomePerTick, maxIncome,
            netConsumed, grossOutflow, usingGross, denomLabel,
            items, creepGroups, sourceLines,
            linkLoss, creepActionTotal,
            workSpawn: t.workSpawnCost, nonWorkSpawn: t.nonWorkSpawnCost,
            extTermIn, extTermOut,
            loss, deltaRoom,
            initialRoomTotal: t.initialRoomTotal,
            finalRoomTotal:   t.finalRoomTotal,
            tombstoneDespawnLoss,
        },
    };
}

function _enPrintReport(state, partial) {
    const r = _enBuildReport(state, partial);
    console.log(r.lines.join('\n'));
    return r.lines;
}

// ── Notification chunking (mirrors warEstimate.js) ────────────────────────
function _enStripBoxLines(lines) {
    const out = [];
    for (const line of lines) {
        if (ENERGY_BOX_DROP_RE.test(line)) continue;
        out.push(line);
    }
    return out;
}

function _enSplitNotifications(lines, roomName) {
    const budget = ENERGY_NOTIFY_TOTAL_MAX;
    const cleaned = _enStripBoxLines(lines);

    const expanded = [];
    for (const line of cleaned) {
        if (line.length <= budget) {
            expanded.push(line);
        } else {
            let remaining = line;
            while (remaining.length > budget) {
                let cut = remaining.lastIndexOf(' ', budget);
                if (cut <= 0) cut = budget;
                expanded.push(remaining.slice(0, cut));
                remaining = remaining.slice(cut).replace(/^\s+/, '');
            }
            if (remaining.length > 0) expanded.push(remaining);
        }
    }

    const chunks = [];
    let current  = '';
    for (const line of expanded) {
        const needed = current.length > 0 ? current.length + 1 + line.length : line.length;
        if (needed > budget && current.length > 0) {
            chunks.push(current);
            current = line;
        } else {
            current = current.length > 0 ? current + '\n' + line : line;
        }
    }
    if (current.length > 0) chunks.push(current);
    if (chunks.length === 0) chunks.push('(empty report)');

    const total = chunks.length;
    return chunks.map((body, i) =>
        '[EnergyProfile: ' + roomName + '] Part ' + (i + 1) + '/' + total + '\n' + body
    );
}

function _enRunNotifyPhase(state) {
    const queue = state.notifyQueue || [];
    const toSend = Math.min(ENERGY_NOTIFY_PER_TICK, queue.length - state.notifySent);
    for (let i = 0; i < toSend; i++) {
        Game.notify(queue[state.notifySent], 0);
        state.notifySent++;
    }
    if (state.notifySent >= queue.length) {
        console.log('[EnergyProfiler] All ' + state.notifySent +
            ' notification chunk(s) sent for ' + state.roomName +
            ' (' + (Game.time - state.startTick) + ' ticks total).');
        // Cache the final report for downstream consumers (5000-tick TTL).
        if (!Memory[ENERGY_EFF_CACHE_KEY]) Memory[ENERGY_EFF_CACHE_KEY] = {};
        Memory[ENERGY_EFF_CACHE_KEY][state.roomName] = {
            totals:        state.totals,
            creepLedger:   state.creepLedger,
            completedTick: Game.time,
            expiresTick:   Game.time + ENERGY_EFF_EXPIRE,
        };
        delete Memory[ENERGY_EFF_MEM_KEY];
    }
}


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████████  NUKE ANALYSIS  ████████████████████████████████
// ════════════════════════════════════════════════════════════════════════════

function _nkBuildPriceCache(room) {
    const cache={};
    const add=(store)=>{if(!store)return;for(const res in store)if(cache[res]===undefined)cache[res]=getMarketBuyPrice(res);};
    room.find(FIND_STRUCTURES).forEach(s=>add(s.store));
    if(cache[RESOURCE_ENERGY]===undefined)cache[RESOURCE_ENERGY]=getMarketBuyPrice(RESOURCE_ENERGY);
    if(cache[RESOURCE_GHODIUM]===undefined)cache[RESOURCE_GHODIUM]=getMarketBuyPrice(RESOURCE_GHODIUM);
    return cache;
}
/** Per-tick memo: same room analyzed multiple times in one tick gets the same cache. */
function _nkPriceCache(room) {
    let g=global.__nkPriceCache;
    if (!g || g.tick !== Game.time) { g = global.__nkPriceCache = { tick: Game.time, byRoom: {} }; }
    return g.byRoom[room.name] || (g.byRoom[room.name] = _nkBuildPriceCache(room));
}
function _nkAnalyzeStrike(cx,cy,structMap,pc) {
    const ep=pc[RESOURCE_ENERGY]||0;let total=0;const dest=[],shld=[],rHit=[];
    for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){
        const x=cx+dx,y=cy+dy;if(x<0||x>49||y<0||y>49)continue;
        const nh=(dx===0&&dy===0)?NUKE_DIRECT_DAMAGE:NUKE_AREA_DAMAGE;
        const structs=structMap[x+','+y];if(!structs||!structs.length)continue;
        const ramps=[],blds=[];
        for(const s of structs){if(s.structureType===STRUCTURE_CONTROLLER)continue;if(s.structureType===STRUCTURE_RAMPART)ramps.push(s);else if(s.structureType!==STRUCTURE_ROAD&&s.structureType!==STRUCTURE_WALL)blds.push(s);}
        let bestR=null;for(const r of ramps)if(!bestR||r.hits>bestR.hits)bestR=r;
        const blocks=bestR&&(bestR.hits>nh);
        for(const b of blds){if(blocks){shld.push({x,y,type:b.structureType});}else{const bc=(NUKE_BUILD_COST[b.structureType]||0)*ep;let sv=0;if(b.store)for(const res in b.store){const a=b.store[res]||0;if(a>0)sv+=a*(pc[res]!==undefined?pc[res]:getMarketBuyPrice(res));}total+=bc+sv;dest.push({x,y,type:b.structureType,value:bc+sv,storedValue:sv});}}
        if(bestR){if(!blocks){const rv=(bestR.hits/REPAIR_HITS_PER_ENERGY)*ep;total+=rv;dest.push({x,y,type:STRUCTURE_RAMPART,value:rv,storedValue:0,hits:bestR.hits});}else{const rc=(nh/REPAIR_HITS_PER_ENERGY)*ep;total+=rc;rHit.push({x,y,hits:bestR.hits,damage:nh,repairCost:rc});}}
    }
    return {totalCredits:total,destroyed:dest,shielded:shld,rampartsHit:rHit};
}
function _nkBuildSimState(room) {
    const ss={};
    for(const s of room.find(FIND_STRUCTURES)){if(s.structureType===STRUCTURE_CONTROLLER)continue;const k=s.pos.x+','+s.pos.y;if(!ss[k])ss[k]=[];const sc={};if(s.store)for(const r in s.store)sc[r]=s.store[r];ss[k].push({structureType:s.structureType,hits:s.hits,store:sc,destroyed:false});}
    return ss;
}
function _nkSimStrike(cx,cy,ss,pc) {
    const ep=pc[RESOURCE_ENERGY]||0;let total=0;const dest=[],shld=[],rHit=[];
    for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){
        const x=cx+dx,y=cy+dy;if(x<0||x>49||y<0||y>49)continue;
        const nh=(dx===0&&dy===0)?NUKE_DIRECT_DAMAGE:NUKE_AREA_DAMAGE;
        const entries=ss[x+','+y];if(!entries||!entries.length)continue;
        let bestR=null;const blds=[];
        for(const e of entries){if(e.destroyed)continue;if(e.structureType===STRUCTURE_RAMPART){if(!bestR||e.hits>bestR.hits)bestR=e;}else if(e.structureType!==STRUCTURE_ROAD&&e.structureType!==STRUCTURE_WALL)blds.push(e);}
        const blocks=bestR&&(bestR.hits>nh);
        for(const b of blds){if(blocks){shld.push({x,y,type:b.structureType});}else{const bc=(NUKE_BUILD_COST[b.structureType]||0)*ep;let sv=0;for(const r in b.store){const a=b.store[r]||0;if(a>0)sv+=a*(pc[r]!==undefined?pc[r]:getMarketBuyPrice(r));}total+=bc+sv;dest.push({x,y,type:b.structureType,value:bc+sv,storedValue:sv});b.destroyed=true;}}
        if(bestR){if(!blocks){const rv=(bestR.hits/REPAIR_HITS_PER_ENERGY)*ep;total+=rv;dest.push({x,y,type:STRUCTURE_RAMPART,value:rv,storedValue:0,hits:bestR.hits});bestR.destroyed=true;bestR.hits=0;}else{const rc=(nh/REPAIR_HITS_PER_ENERGY)*ep;total+=rc;rHit.push({x,y,hits:bestR.hits,damage:nh,repairCost:rc});bestR.hits-=nh;}}
    }
    return {totalCredits:total,destroyed:dest,shielded:shld,rampartsHit:rHit};
}
function _nkPreviewStrike(cx,cy,ss,pc) {
    const ep=pc[RESOURCE_ENERGY]||0;let total=0;const dest=[],shld=[],rHit=[];
    for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){
        const x=cx+dx,y=cy+dy;if(x<0||x>49||y<0||y>49)continue;
        const nh=(dx===0&&dy===0)?NUKE_DIRECT_DAMAGE:NUKE_AREA_DAMAGE;
        const entries=ss[x+','+y];if(!entries||!entries.length)continue;
        let bestR=null;const blds=[];
        for(const e of entries){if(e.destroyed)continue;if(e.structureType===STRUCTURE_RAMPART){if(!bestR||e.hits>bestR.hits)bestR=e;}else if(e.structureType!==STRUCTURE_ROAD&&e.structureType!==STRUCTURE_WALL)blds.push(e);}
        const blocks=bestR&&(bestR.hits>nh);
        for(const b of blds){if(blocks)shld.push({x,y,type:b.structureType});else{const bc=(NUKE_BUILD_COST[b.structureType]||0)*ep;let sv=0;for(const r in b.store){const a=b.store[r]||0;if(a>0)sv+=a*(pc[r]!==undefined?pc[r]:getMarketBuyPrice(r));}total+=bc+sv;dest.push({x,y,type:b.structureType,value:bc+sv,storedValue:sv});}}
        if(bestR){if(!blocks){total+=(bestR.hits/REPAIR_HITS_PER_ENERGY)*ep;dest.push({x,y,type:STRUCTURE_RAMPART,value:(bestR.hits/REPAIR_HITS_PER_ENERGY)*ep,storedValue:0,hits:bestR.hits});}else{const rc=(nh/REPAIR_HITS_PER_ENERGY)*ep;total+=rc;rHit.push({x,y,hits:bestR.hits,damage:nh,repairCost:rc});}}
    }
    return {totalCredits:total,destroyed:dest,shielded:shld,rampartsHit:rHit};
}
function _nkFindBest(ss,pc) {
    let best={totalCredits:0,destroyed:[],shielded:[],rampartsHit:[],cx:25,cy:25};
    for(let cx=2;cx<=47;cx++)for(let cy=2;cy<=47;cy++){const r=_nkPreviewStrike(cx,cy,ss,pc);if(r.totalCredits>best.totalCredits){best=r;best.cx=cx;best.cy=cy;}}
    return best;
}
/** Full 5x5 sweep returning best strike with credit damage + destroyed summary */
function _nkComputeBestStrike(room) {
    const pc=_nkPriceCache(room);
    const ep=pc[RESOURCE_ENERGY]||0,ghP=pc[RESOURCE_GHODIUM]||0;
    const nukeCost=(NUKE_ENERGY_COST_CONST*ep)+(NUKE_GHODIUM_COST*ghP);
    const structMap={};
    room.find(FIND_STRUCTURES).forEach(s=>{const k=s.pos.x+','+s.pos.y;if(!structMap[k])structMap[k]=[];structMap[k].push(s);});
    let bestX=25,bestY=25,bestDmg=0;
    for(let cx=2;cx<=47;cx++)for(let cy=2;cy<=47;cy++){const dmg=_nkAnalyzeStrike(cx,cy,structMap,pc).totalCredits;if(dmg>bestDmg){bestDmg=dmg;bestX=cx;bestY=cy;}}
    const dest=[];
    for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){const x=bestX+dx,y=bestY+dy;if(x<0||x>49||y<0||y>49)continue;const nh=(dx===0&&dy===0)?NUKE_DIRECT_DAMAGE:NUKE_AREA_DAMAGE;const s=structMap[x+','+y];if(!s)continue;const rs=s.filter(st=>st.structureType===STRUCTURE_RAMPART),blds=s.filter(st=>st.structureType!==STRUCTURE_RAMPART&&st.structureType!==STRUCTURE_ROAD&&st.structureType!==STRUCTURE_WALL);let bR=null;for(const r of rs)if(!bR||r.hits>bR.hits)bR=r;if(!(bR&&bR.hits>nh))for(const b of blds)dest.push(b.structureType);}
    const byType={};for(const t of dest)byType[t]=(byType[t]||0)+1;
    return {x:bestX,y:bestY,damage:bestDmg,nukeCost,percent:nukeCost>0?parseFloat((bestDmg/nukeCost*100).toFixed(1)):0,destroyedSummary:Object.entries(byType).map(([t,n])=>n>1?n+'x '+t:t).join(', ')||'nothing killable'};
}
function _nkIsNukerOp(nuker){if(!nuker||nuker.cooldown>0)return false;return nuker.store[RESOURCE_GHODIUM]>=NUKE_GHODIUM_COST&&nuker.store[RESOURCE_ENERGY]>=NUKE_ENERGY_COST_CONST;}

// ── Nuke: observer fallback helper ────────────────────────────────────────
function _nkHandleNotVisible(roomName, pendingData, prefix) {
    if(!Memory.nukeAnalyzePending)Memory.nukeAnalyzePending={};
    if(!Memory.intelPowerObserve)Memory.intelPowerObserve={};
    const pending=Memory.nukeAnalyzePending[roomName];
    if(pending&&!pending.costMode&&!pending.poweredObserver&&Game.time-pending.tick>1){console.log('['+prefix+'] ERROR: '+roomName+' still not visible after observation attempt.');delete Memory.nukeAnalyzePending[roomName];return null;}
    if(Memory.intelPowerObserve[roomName]){const po=Memory.intelPowerObserve[roomName];if(Game.time-po.tick<=50){console.log('['+prefix+'] PWR_OPERATE_OBSERVER in progress — '+po.operatorName+', elapsed '+(Game.time-po.tick)+'t.');return {status:'pending_power_observe',room:roomName};}delete Memory.intelPowerObserve[roomName];}
    const obs=findObserverInRange(roomName,_tickUsedSet());
    if(obs){if(_tickObserve(obs,roomName)){Memory.nukeAnalyzePending[roomName]={tick:Game.time,observerRoom:obs.room.name,...pendingData};console.log('['+prefix+'] Observing '+roomName+' via '+obs.room.name+'. Auto-completing next tick.');return {status:'pending',room:roomName};}console.log('['+prefix+'] Observer busy or failed');}
    const po=tryPowerObserver(roomName);
    if(po){Memory.intelPowerObserve[roomName]={operatorName:po.operatorName,operatorRoom:po.operatorRoom,observerId:po.observerId,tick:Game.time};Memory.nukeAnalyzePending[roomName]={tick:Game.time,observerRoom:po.operatorRoom,poweredObserver:true,...pendingData};console.log('['+prefix+'] PWR_OPERATE_OBSERVER from '+po.operatorName+'.');return {status:'pending_power_observe',room:roomName};}
    console.log('['+prefix+'] ERROR: '+roomName+' not visible. No observer. Send a scout.');return null;
}

// ── Nuke: Public analysis functions ──────────────────────────────────────
function nukeAnalyze(roomName, numNukes) {
    if(!roomName||typeof roomName!=='string'){console.log('[NukeAnalyze] Usage: nukeAnalyze("W1N1") or nukeAnalyze("W1N1", 3)');return null;}
    numNukes=(typeof numNukes==='number'&&numNukes>=1)?Math.floor(numNukes):1;
    if(!Memory.nukeAnalyzePending)Memory.nukeAnalyzePending={};if(!Memory.intelPowerObserve)Memory.intelPowerObserve={};
    const room=Game.rooms[roomName];if(!room)return _nkHandleNotVisible(roomName,{numNukes},'NukeAnalyze');
    delete Memory.nukeAnalyzePending[roomName];
    const pc=_nkPriceCache(room),ep=pc[RESOURCE_ENERGY]||0,ghP=pc[RESOURCE_GHODIUM]||0;
    const c1=(NUKE_ENERGY_COST_CONST*ep)+(NUKE_GHODIUM_COST*ghP),cAll=c1*numNukes;
    const owner=room.controller&&room.controller.owner?room.controller.owner.username:'Unowned',rcl=room.controller?room.controller.level:0;
    const ss=_nkBuildSimState(room);const strikes=[];let totalDmg=0;
    for(let n=0;n<numNukes;n++){const best=_nkFindBest(ss,pc);if(best.totalCredits===0)break;_nkSimStrike(best.cx,best.cy,ss,pc);totalDmg+=best.totalCredits;strikes.push(best);}
    const pct=cAll>0?(totalDmg/cAll*100).toFixed(1):'inf';
    const D='════════════════════════════════════════════════════════════════════════';const L=[];
    L.push(D);L.push('NUKE ANALYSIS: '+roomName+'  |  Owner: '+owner+'  |  RCL: '+rcl+'  |  Nukes: '+numNukes);L.push(D);
    L.push('Cost per nuke: '+fmtCr(c1)+'  ('+fmtNum(NUKE_ENERGY_COST_CONST)+'e @'+ep.toFixed(4)+'  +  '+NUKE_GHODIUM_COST+'G @'+ghP.toFixed(2)+'/G)'+(numNukes>1?'   Total: '+fmtCr(cAll):''));
    for(let s=0;s<strikes.length;s++){const st=strikes[s],mp=c1>0?(st.totalCredits/c1*100).toFixed(1):'inf';L.push('');L.push('  Strike '+(s+1)+':  ('+st.cx+', '+st.cy+')  ->  '+fmtCr(st.totalCredits)+'  ('+mp+'% of 1 nuke cost)');if(st.destroyed.length>0){const bt={};for(const d of st.destroyed){if(!bt[d.type])bt[d.type]={count:0,value:0,sv:0};bt[d.type].count++;bt[d.type].value+=d.value;bt[d.type].sv+=(d.storedValue||0);}for(const t in bt){const g=bt[t];let row='    '+t+' x'+g.count+'  ->  '+fmtCr(g.value);if(g.sv>0)row+='  (build: '+fmtCr(g.value-g.sv)+' + stored: '+fmtCr(g.sv)+')';L.push(row);}}if(st.rampartsHit.length>0){let rT=0;for(const ri of st.rampartsHit)rT+=ri.repairCost;L.push('    rampart repairs: '+st.rampartsHit.length+'  ->  '+fmtCr(rT));}if(st.shielded.length>0)L.push('    shielded (survived): '+st.shielded.length+' structure(s)');}
    if(strikes.length===0){L.push('');L.push('  No structures in blast range or all fully shielded.');}
    L.push('');L.push(D);
    if(numNukes===1){const sp=strikes[0]||{cx:0,cy:0};L.push('In \''+roomName+'\', striking ('+sp.cx+', '+sp.cy+') does '+fmtCr(totalDmg)+' in damage ('+pct+'% of nuke cost)');}
    else{L.push('Total damage ('+strikes.length+' nukes): '+fmtCr(totalDmg)+'  ('+pct+'% of '+fmtCr(cAll)+')');L.push('Targets: '+strikes.map(st=>'('+st.cx+', '+st.cy+')').join('  '));}
    L.push(D);console.log(L.join('\n'));
    return {room:roomName,numNukes,strikes:strikes.map(st=>({x:st.cx,y:st.cy,damage:st.totalCredits})),totalDamage:totalDmg,nukeCostOne:c1,nukeCostAll:cAll,percent:parseFloat(pct)};
}

function nukeAnalyzeSelf() {
    const myRooms=[];for(const rn in Game.rooms){const r=Game.rooms[rn];if(r.controller&&r.controller.my)myRooms.push(rn);}
    if(!myRooms.length){console.log('[NukeAnalyze] No owned rooms visible.');return;}
    const ep=getMarketBuyPrice(RESOURCE_ENERGY),ghP=getMarketBuyPrice(RESOURCE_GHODIUM);
    const nukeCost=(NUKE_ENERGY_COST_CONST*ep)+(NUKE_GHODIUM_COST*ghP);
    const lines=['NUKE SELF-ANALYSIS  |  Nuke cost: '+fmtCr(nukeCost),'---'];
    myRooms.sort();
    for(const rn of myRooms){const room=Game.rooms[rn],pc=_nkPriceCache(room),sm={};for(const s of room.find(FIND_STRUCTURES)){if(s.structureType===STRUCTURE_CONTROLLER)continue;const k=s.pos.x+','+s.pos.y;if(!sm[k])sm[k]=[];sm[k].push(s);}let best={totalCredits:0,cx:25,cy:25};for(let cx=2;cx<=47;cx++)for(let cy=2;cy<=47;cy++){const r=_nkAnalyzeStrike(cx,cy,sm,pc);if(r.totalCredits>best.totalCredits){best=r;best.cx=cx;best.cy=cy;}}const pct=nukeCost>0?(best.totalCredits/nukeCost*100).toFixed(1):'inf';lines.push(rn+' (RCL'+(room.controller?room.controller.level:0)+')  -  Best: ('+best.cx+', '+best.cy+')  -  '+fmtCr(best.totalCredits)+'  ('+pct+'% of nuke cost)');}
    console.log(lines.join('\n'));
}

function nukeAnalyzeCost(roomName, cxOrStrikes, cy) {
    if(!roomName||typeof roomName!=='string'){console.log('[NukeAnalyzeCost] Usage: nukeAnalyzeCost("W1N1", x, y) or nukeAnalyzeCost("W1N1", [{x,y},...])');return null;}
    let strikes;
    if(Array.isArray(cxOrStrikes)){strikes=[];for(const vi of cxOrStrikes){const sx=parseInt(vi.x,10),sy=parseInt(vi.y,10);if(isNaN(sx)||isNaN(sy)||sx<2||sx>47||sy<2||sy>47){console.log('[NukeAnalyzeCost] Skipping invalid: ('+vi.x+', '+vi.y+')');continue;}strikes.push({x:sx,y:sy});}if(!strikes.length){console.log('[NukeAnalyzeCost] No valid coordinates.');return null;}}
    else{const cx2=parseInt(cxOrStrikes,10),cy2=parseInt(cy,10);if(isNaN(cx2)||isNaN(cy2)||cx2<2||cx2>47||cy2<2||cy2>47){console.log('[NukeAnalyzeCost] Coordinates must be 2-47.');return null;}strikes=[{x:cx2,y:cy2}];}
    if(!Memory.nukeAnalyzePending)Memory.nukeAnalyzePending={};if(!Memory.intelPowerObserve)Memory.intelPowerObserve={};
    const room=Game.rooms[roomName];if(!room)return _nkHandleNotVisible(roomName,{costMode:true,strikes},'NukeAnalyzeCost');
    const pc=_nkPriceCache(room),ep=pc[RESOURCE_ENERGY]||0;
    const allS=room.find(FIND_STRUCTURES),sm={};for(const s of allS){const k=s.pos.x+','+s.pos.y;if(!sm[k])sm[k]=[];sm[k].push(s);}
    function isIgnored(t){return t===STRUCTURE_ROAD||t===STRUCTURE_WALL||t===STRUCTURE_CONTAINER||t===STRUCTURE_RAMPART||t===STRUCTURE_CONTROLLER;}
    const tileDmg={};
    for(let ni=0;ni<strikes.length;ni++){const sx=strikes[ni].x,sy=strikes[ni].y;for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){const tx=sx+dx,ty=sy+dy;if(tx<0||tx>49||ty<0||ty>49)continue;const dmg=(dx===0&&dy===0)?NUKE_DIRECT_DAMAGE:NUKE_AREA_DAMAGE;const tk=tx+','+ty;if(!tileDmg[tk])tileDmg[tk]={total:0,contributions:[]};tileDmg[tk].total+=dmg;tileDmg[tk].contributions.push({strikeIdx:ni,dmg});}}
    let totReplaceBE=0,totReplaceS=0,totRampAtRisk=0,totTopup=0,totFullRamp=0,totForceRep=0;const tileRes=[];
    for(const tkey in tileDmg){const tp=tkey.split(','),x=parseInt(tp[0],10),y=parseInt(tp[1],10),tInfo=tileDmg[tkey],nh=tInfo.total;
        const structs=sm[tkey]||[];let bR=null;const blds=[];for(const s of structs){if(s.structureType===STRUCTURE_RAMPART){if(!bR||s.hits>bR.hits)bR=s;}else if(!isIgnored(s.structureType))blds.push(s);}if(!blds.length)continue;
        const curHP=bR?bR.hits:0,blocks=bR&&(curHP>nh),hpShort=Math.max(0,nh-curHP+1),isCenter=tInfo.contributions.some(c=>c.dmg===NUKE_DIRECT_DAMAGE);
        let tRB=0,tRS=0;const bDets=[];for(const b of blds){const be=NUKE_BUILD_COST[b.structureType]||0;let sc=0;if(b.store)for(const res in b.store){const a=b.store[res]||0;if(a>0)sc+=a*(pc[res]!==undefined?pc[res]:getMarketBuyPrice(res));}tRB+=be;tRS+=sc;bDets.push({type:b.structureType,buildEnergy:be,storedCredits:sc});}
        totReplaceBE+=tRB;totReplaceS+=tRS;
        let rAR=0,topup=0,fullR=0,forceR=0;
        if(!bR){fullR=hpShort/REPAIR_HITS_PER_ENERGY;totFullRamp+=fullR;}else if(!blocks){rAR=curHP/REPAIR_HITS_PER_ENERGY;topup=hpShort/REPAIR_HITS_PER_ENERGY;totRampAtRisk+=rAR;totTopup+=topup;}else{forceR=nh/REPAIR_HITS_PER_ENERGY;totForceRep+=forceR;}
        tileRes.push({x,y,isCenter,nukeHits:nh,contributions:tInfo.contributions,currentRampartHP:curHP,rampartBlocks:blocks,hpShortfall:hpShort,buildings:bDets,tileReplaceBuild:tRB,tileReplaceStored:tRS,rampartAtRiskEnergy:rAR,topupEnergy:topup,fullRampartEnergy:fullR,forceRepairEnergy:forceR});
    }
    tileRes.sort((a,b)=>a.y!==b.y?a.y-b.y:a.x-b.x);
    const D='════════════════════════════════════════════════════════════════════════',D2='────────────────────────────────────────────────────────────────────────';
    const L=[],owner=room.controller&&room.controller.owner?room.controller.owner.username:'Unowned',rcl=room.controller?room.controller.level:0;
    L.push(D);L.push('NUKE COST ANALYSIS: '+roomName+' @ '+strikes.map(s=>'('+s.x+','+s.y+')').join(' + ')+'  |  Owner: '+owner+'  |  RCL: '+rcl);
    if(strikes.length>1)L.push('WARNING: '+strikes.length+' simultaneous strikes — damage STACKED per tile.');
    L.push(D);L.push('Energy price: '+ep.toFixed(4)+' cr/e  |  Structures: '+allS.length+'  |  Building tiles in blast: '+tileRes.length);L.push('');L.push('PER-TILE BREAKDOWN:');L.push(D2);
    for(const tile of tileRes){const dL=tile.contributions.length===1?(tile.isCenter?'10M direct':'5M area  '):(tile.contributions.map(c=>fmtNum(c.dmg)).join('+')+'='+fmtNum(tile.nukeHits)+' stacked');const lbl=(tile.isCenter&&tile.contributions.length===1)?'  [CENTER] ('+tile.x+','+tile.y+')  '+dL:'  [AREA]   ('+tile.x+','+tile.y+')   '+dL;const rt=tile.currentRampartHP===0?'no rampart':tile.rampartBlocks?'rampart OK  '+fmtNum(tile.currentRampartHP)+' HP':'rampart WEAK  '+fmtNum(tile.currentRampartHP)+' HP  (need >'+fmtNum(tile.nukeHits)+')';L.push(lbl+'  |  '+rt);for(const b of tile.buildings){let row='      '+b.type+'  rebuild: '+fmtNum(b.buildEnergy)+'e  ('+fmtCr(b.buildEnergy*ep)+')';if(b.storedCredits>0)row+='  + stored: '+fmtCr(b.storedCredits);row+=tile.rampartBlocks?'  protected':'  at risk';L.push(row);}if(tile.rampartBlocks)L.push('      Rampart repair after hit: '+fmtNum(tile.forceRepairEnergy)+'e  ('+fmtCr(tile.forceRepairEnergy*ep)+')');else if(tile.currentRampartHP>0){L.push('      Rampart at risk: '+fmtNum(tile.currentRampartHP)+' HP  =  '+fmtNum(tile.rampartAtRiskEnergy)+'e  ('+fmtCr(tile.rampartAtRiskEnergy*ep)+')');L.push('      To protect: need '+fmtNum(tile.hpShortfall)+' more HP  =  '+fmtNum(tile.topupEnergy)+'e  ('+fmtCr(tile.topupEnergy*ep)+')');}else L.push('      To protect (from scratch): need '+fmtNum(tile.nukeHits+1)+' HP  =  '+fmtNum(tile.fullRampartEnergy)+'e  ('+fmtCr(tile.fullRampartEnergy*ep)+')');}
    if(!tileRes.length)L.push('  No meaningful structures in blast area.');
    const totRC=(totReplaceBE*ep)+totReplaceS,totPE=totTopup+totFullRamp,totPC=totPE*ep,totFRC=totForceRep*ep;
    L.push('');L.push(D);L.push('REPLACEMENT COST:');L.push('  Build energy: '+fmtNum(totReplaceBE)+'e  ('+fmtCr(totReplaceBE*ep)+')');L.push('  Lost resources: '+fmtCr(totReplaceS));L.push('  TOTAL: '+fmtCr(totRC));
    L.push('');L.push('DEFENSE COST (protect all building tiles):');if(totTopup>0)L.push('  Top up weak ramparts: '+fmtNum(totTopup)+'e  ('+fmtCr(totTopup*ep)+')');if(totFullRamp>0)L.push('  Build new ramparts: '+fmtNum(totFullRamp)+'e  ('+fmtCr(totFullRamp*ep)+')');L.push('  TOTAL to protect: '+fmtNum(totPE)+'e  ('+fmtCr(totPC)+')');if(totForceRep>0)L.push('  Post-strike repairs: '+fmtNum(totForceRep)+'e  ('+fmtCr(totFRC)+')');if(totRampAtRisk>0){L.push('');L.push('SUNK COST AT RISK: '+fmtNum(totRampAtRisk)+'e  ('+fmtCr(totRampAtRisk*ep)+')');}L.push(D);console.log(L.join('\n'));
    return {room:roomName,strikes,totalReplaceBuildEnergy:totReplaceBE,totalReplaceStored:totReplaceS,totalReplaceCredits:totRC,totalProtectEnergy:totPE,totalProtectCredits:totPC,tiles:tileRes};
}

function nukeIncoming(filterRoom) {
    if(!Memory.nukeAnalyzePending)Memory.nukeAnalyzePending={};if(!Memory.intelPowerObserve)Memory.intelPowerObserve={};
    if(filterRoom){if(typeof filterRoom!=='string'){console.log('[NukeIncoming] Usage: nukeIncoming() or nukeIncoming("W1N1")');return null;}const room=Game.rooms[filterRoom];if(!room)return _nkHandleNotVisible(filterRoom,{incomingMode:true},'NukeIncoming');return _nkScanIncoming(filterRoom,room);}
    const myRooms=[],res=[];for(const rn in Game.rooms){const r=Game.rooms[rn];if(r.controller&&r.controller.my)myRooms.push(rn);}
    if(!myRooms.length){console.log('[NukeIncoming] No owned rooms visible.');return null;}
    let total=0;myRooms.sort();for(const rn of myRooms)total+=_nkScanIncoming(rn,Game.rooms[rn]);
    if(!total)console.log('[NukeIncoming] No incoming nukes detected in any owned room.');
    return total;
}
function _nkScanIncoming(roomName, room) {
    const D='════════════════════════════════════════════════════════════════════════',D2='────────────────────────────────────────────────────────────────────────';
    const nukes=room.find(FIND_NUKES);if(!nukes||!nukes.length)return 0;
    nukes.sort((a,b)=>a.timeToLand-b.timeToLand);
    for(const nuke of nukes){console.log(D);console.log('INCOMING NUKE -> '+roomName+'  |  Landing @ ('+nuke.pos.x+', '+nuke.pos.y+')'+'  |  '+nuke.timeToLand+' ticks remaining  (tick '+(Game.time+nuke.timeToLand)+')'+'  |  From: '+(nuke.launchRoomName||'???'));console.log(D2);}
    nukeAnalyzeCost(roomName,nukes.map(nk=>({x:nk.pos.x,y:nk.pos.y})));
    return nukes.length;
}

// ── Nuke: Threat scanner ──────────────────────────────────────────────────
function nukeThreat(targetRoom) {
    if(!targetRoom||typeof targetRoom!=='string'){console.log('[NukeThreat] Usage: nukeThreat("E1N1")');return;}
    const scan=_nkEnsureThreatMem(targetRoom);
    console.log('[NukeThreat] Scanning '+Object.keys(scan.roomsToScan).length+' rooms around '+targetRoom+'. Use nukeThreatStatus for progress.');
    _nkProcessThreatScan();
}
function nukeThreatStatus(targetRoom) {
    const scan=Memory.nukeThreatScans?Memory.nukeThreatScans[targetRoom]:null;
    if(!scan){console.log('[NukeThreat] No active scan for '+targetRoom+'.');return;}
    const total=Object.keys(scan.roomsToScan).length,done=scan.scannedCount+scan.unscannableCount;
    console.log('[NukeThreat] Status for '+targetRoom+': '+done+'/'+total+' rooms ('+scan.scannedCount+' visible, '+scan.unscannableCount+' unscannable). '+(scan.scanComplete?'Complete.':'In progress.'));
    if(scan.scanComplete&&scan.bestHostileOwner)console.log('[NukeThreat] Most threatening: '+scan.bestHostileOwner+' with '+scan.operationalNukeCount+' nukes. Can destroy key structures: '+(scan.threatPossible?'YES':'NO'));
}
function nukeThreatCancel(targetRoom) {
    if(!targetRoom||typeof targetRoom!=='string'){console.log('[NukeThreatCancel] Usage: nukeThreatCancel("E1N1")');return;}
    if(Memory.nukeThreatScans&&Memory.nukeThreatScans[targetRoom]){delete Memory.nukeThreatScans[targetRoom];console.log('[NukeThreatCancel] Scan for '+targetRoom+' cancelled.');}
    else console.log('[NukeThreatCancel] No active scan found for '+targetRoom+'.');
}
function _nkEnsureThreatMem(targetRoom) {
    if(!Memory.nukeThreatScans)Memory.nukeThreatScans={};
    let scan=Memory.nukeThreatScans[targetRoom];
    if(!scan||scan.createdTick!==Game.time){
        scan={target:targetRoom,started:Game.time,createdTick:Game.time,roomsToScan:{},unscannableCount:0,scannedCount:0,scanComplete:false,bestHostileOwner:null,operationalNukeCount:0,threatPossible:false};
        const rng=roomsInRange(targetRoom,OBSERVER_RANGE);
        for(const rn of rng){if(rn===targetRoom)continue;scan.roomsToScan[rn]={status:'unscanned',data:{}};}
        Memory.nukeThreatScans[targetRoom]=scan;
    }
    return scan;
}
function _nkProcessThreatScan() {
    if(!Memory.nukeThreatScans)return;
    if(!Memory.nukeThreatPowerObserve)Memory.nukeThreatPowerObserve={};
    const usedObs=new Set();
    for(const targetRoom in Memory.nukeThreatScans){
        const scan=Memory.nukeThreatScans[targetRoom];if(!scan||scan.scanComplete)continue;
        for(const rn in scan.roomsToScan){
            const entry=scan.roomsToScan[rn];if(entry.status==='visible'||entry.status==='fail')continue;
            const room=Game.rooms[rn];
            if(room){entry.status='visible';entry.data.owner=(room.controller&&room.controller.owner)?room.controller.owner.username:null;let opN=0;if(entry.data.owner&&!_isFriendlyUsername(entry.data.owner)){const nukers=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_NUKER&&_nkIsNukerOp(s)});opN=nukers.length;}entry.data.opNukeCount=opN;scan.scannedCount++;delete Memory.nukeThreatPowerObserve[rn];continue;}
            if(entry.status==='unscanned'){if(tryObserveRoom(rn,usedObs)){entry.status='pending';entry.observeTick=Game.time;continue;}const po=tryPowerObserver(rn);if(po){Memory.nukeThreatPowerObserve[rn]={operatorName:po.operatorName,operatorRoom:po.operatorRoom,observerId:po.observerId,tick:Game.time};entry.status='pending';entry.observeTick=Game.time;continue;}entry.status='fail';scan.unscannableCount++;}
            if(entry.status==='pending'&&entry.observeTick!==undefined&&Game.time-entry.observeTick>10){entry.status='fail';scan.unscannableCount++;delete Memory.nukeThreatPowerObserve[rn];}
        }
        let unfinished=false;for(const rn2 in scan.roomsToScan){const e=scan.roomsToScan[rn2];if(e.status==='unscanned'||e.status==='pending'){unfinished=true;break;}}
        if(!unfinished){scan.scanComplete=true;_nkRunFinalThreat(targetRoom,scan);}
    }
    for(const tr in Memory.nukeThreatScans){const ts=Memory.nukeThreatScans[tr];if(ts&&ts.scanComplete&&Game.time-ts.started>1000)delete Memory.nukeThreatScans[tr];}
    for(const pr in Memory.nukeThreatPowerObserve){if(Game.time-Memory.nukeThreatPowerObserve[pr].tick>100)delete Memory.nukeThreatPowerObserve[pr];}
}
function _nkRunFinalThreat(targetRoom, scan) {
    const nukeCountByOwner={};
    for(const rn in scan.roomsToScan){const entry=scan.roomsToScan[rn];if(entry.status!=='visible'||!entry.data.owner)continue;const owner=entry.data.owner;if(_isFriendlyUsername(owner))continue;nukeCountByOwner[owner]=(nukeCountByOwner[owner]||0)+(entry.data.opNukeCount||0);}
    let bestOwner=null,bestNukes=0;for(const o in nukeCountByOwner)if(nukeCountByOwner[o]>bestNukes){bestOwner=o;bestNukes=nukeCountByOwner[o];}
    scan.bestHostileOwner=bestOwner;scan.operationalNukeCount=bestNukes;
    const total=Object.keys(scan.roomsToScan).length,pct=total>0?Math.round((scan.scannedCount+scan.unscannableCount)/total*100):100;
    console.log('[NukeThreat] Scan complete. '+pct+'% of '+total+' rooms processed ('+scan.unscannableCount+' unscannable).');
    if(!bestOwner||!bestNukes){console.log('[NukeThreat] No hostile player with operational nukers within range of '+targetRoom+'.');return;}
    console.log('[NukeThreat] Most threatening: '+bestOwner+' with '+bestNukes+' nuke(s) in range.');
    const targetRoomObj=Game.rooms[targetRoom];
    if(!targetRoomObj){console.log('[NukeThreat] ERROR: Target room '+targetRoom+' not visible. Cannot run destruction test.');return;}
    const pc=_nkPriceCache(targetRoomObj),ss=_nkBuildSimState(targetRoomObj);
    for(let n=0;n<bestNukes;n++){const best=_nkFindBest(ss,pc);if(best.totalCredits===0)break;_nkSimStrike(best.cx,best.cy,ss,pc);}
    let spawnsDestroyed=true,termExists=false,termDestroyed=false,storExists=false,storDestroyed=false;
    for(const s of targetRoomObj.find(FIND_STRUCTURES)){const k=s.pos.x+','+s.pos.y;const tile=ss[k]||[];const alive=tile.some(e=>!e.destroyed&&e.structureType===s.structureType);if(s.structureType===STRUCTURE_SPAWN&&alive)spawnsDestroyed=false;if(s.structureType===STRUCTURE_TERMINAL){termExists=true;if(!alive)termDestroyed=true;}if(s.structureType===STRUCTURE_STORAGE){storExists=true;if(!alive)storDestroyed=true;}}
    const termGone=!termExists||termDestroyed,storGone=!storExists||storDestroyed;
    if(spawnsDestroyed&&termGone&&storGone){scan.threatPossible=true;console.log('[NukeThreat] YES — '+bestOwner+' can destroy ALL spawns, terminal and storage in '+targetRoom+' with '+bestNukes+' nukes.');}
    else{let reason='';if(!spawnsDestroyed)reason+='spawns, ';if(!termGone)reason+='terminal, ';if(!storGone)reason+='storage, ';reason=reason.slice(0,-2);console.log('[NukeThreat] NO — '+bestNukes+' nukes are NOT enough. Still standing: '+reason+'.');}
    nukeAnalyze(targetRoom,bestNukes);
}

// ── Nuke: processPending ──────────────────────────────────────────────────
function _processPendingNukeAnalyze() {
    if(!Memory.nukeAnalyzePending)return;
    for(const roomName in Memory.nukeAnalyzePending){
        const pending=Memory.nukeAnalyzePending[roomName],age=Game.time-pending.tick;
        if(Game.rooms[roomName]){
            if(pending.incomingMode){console.log('[NukeIncoming] Auto-completing incoming scan for '+roomName);_nkScanIncoming(roomName,Game.rooms[roomName]);}
            else if(pending.costMode){console.log('[NukeAnalyzeCost] Auto-completing cost analysis for '+roomName);nukeAnalyzeCost(roomName,pending.strikes);}
            else{console.log('[NukeAnalyze] Auto-completing analysis for '+roomName);nukeAnalyze(roomName,pending.numNukes||1);}
            delete Memory.nukeAnalyzePending[roomName];
        }else if(pending.poweredObserver){}
        else if(age>=5){console.log('[NukeAnalyze] Timed out waiting for visibility of '+roomName+' after '+age+' ticks.');delete Memory.nukeAnalyzePending[roomName];}
    }
    if(Memory.intelPowerObserve){for(const poRoom in Memory.intelPowerObserve){const poReq=Memory.intelPowerObserve[poRoom];if(!poReq||!poReq.tick)continue;if(!Memory.nukeAnalyzePending||!Memory.nukeAnalyzePending[poRoom])continue;if(Game.time-poReq.tick>100){console.log('[NukeAnalyze] Power-observe timed out for '+poRoom+'. Clearing.');delete Memory.intelPowerObserve[poRoom];delete Memory.nukeAnalyzePending[poRoom];}}}
    _nkProcessThreatScan();
}


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████  PLAYER ANALYSIS  █████████████████████████████████
// ════════════════════════════════════════════════════════════════════════════

function _paGetMyNukerRooms() {
    const res=[];
    for(const rn in Game.rooms){const room=Game.rooms[rn];if(!room.controller||!room.controller.my)continue;const nuker=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_NUKER})[0];if(!nuker)continue;const nE=nuker.store[RESOURCE_ENERGY]||0,nG=nuker.store[RESOURCE_GHODIUM]||0;const maxE=nuker.store.getCapacity(RESOURCE_ENERGY),maxG=nuker.store.getCapacity(RESOURCE_GHODIUM);const ready=nE>=maxE&&nG>=maxG&&!(nuker.cooldown||0);res.push({room:rn,ready,energy:nE,ghodium:nG,cooldown:nuker.cooldown||0});}
    return res;
}
function _paGetMyRooms(){const r=[];for(const rn in Game.rooms){const room=Game.rooms[rn];if(room.controller&&room.controller.my)r.push(rn);}return r;}

/** Classify a creep by body composition */
function _paCategorizeCreep(creep) {
    const body=creep.body,total=body.length;
    if(body.some(p=>p.type===ATTACK||p.type===RANGED_ATTACK||p.type===HEAL))return 'military';
    if(body.some(p=>p.type===CLAIM))return 'claimer';
    const wp=body.filter(p=>p.type===WORK).length/total;
    if(wp>0.25)return 'worker';
    if(body.every(p=>p.type===MOVE))return 'scout';
    if(wp<0.10)return 'supplier';
    return 'other';
}

function _paFmtNum(num){if(num===undefined||num===null)return '0';if(num>=1000000000)return(num/1000000000).toFixed(1)+'B';if(num>=1000000)return(num/1000000).toFixed(1)+'M';if(num>=1000)return(num/1000).toFixed(1)+'k';return String(num);}

/** Start full player analysis */
function startPlayerAnalysis(playerName) {
    if(!playerName||typeof playerName!=='string'){console.log('[PlayerAnalysis] Usage: player("PlayerName")');return;}
    if(Memory.playerAnalysis&&Memory.playerAnalysis.active){console.log('[PlayerAnalysis] Analysis already in progress for '+Memory.playerAnalysis.targetPlayer+'. Use playerCancel() first.');return;}
    const obsMap=getObserverMap(),obsRooms=Object.keys(obsMap);
    if(!obsRooms.length){console.log('[PlayerAnalysis] No observers found.');return;}
    const allRooms=[];
    for(const oRn of obsRooms){const oc=parseRoomCoords(oRn);if(!oc)continue;for(let dx=-OBSERVER_RANGE;dx<=OBSERVER_RANGE;dx++)for(let dy=-OBSERVER_RANGE;dy<=OBSERVER_RANGE;dy++){if(dx===0&&dy===0)continue;const rn=toRoomName(oc.x+dx,oc.y+dy);allRooms.push(rn);}}
    const unique=[...new Set(allRooms)].filter(rn=>{if(!isClaimableRoom(rn))return false;const r=Game.rooms[rn];return !r||!r.controller||!r.controller.my;});
    console.log('[PlayerAnalysis] Starting analysis of: '+playerName);console.log('[PlayerAnalysis] Phase 1: Scanning '+unique.length+' rooms...');
    Memory.playerAnalysis={active:true,phase:'scanning',targetPlayer:playerName,startTick:Game.time,observerRooms:obsRooms,scanQueue:unique.slice(),scannedCount:0,totalScanRooms:unique.length,foundRooms:[],lastObservedRoom:null,intelQueue:[],intelResults:[],intelCount:0,totalIntelRooms:0};
}

function cancelPlayerAnalysis() {
    if(Memory.playerAnalysis&&Memory.playerAnalysis.active){console.log('[PlayerAnalysis] Analysis cancelled.');delete Memory.playerAnalysis;}else console.log('[PlayerAnalysis] No active analysis.');
}

function getPlayerAnalysisStatus() {
    if(!Memory.playerAnalysis||!Memory.playerAnalysis.active){console.log('[PlayerAnalysis] No active analysis.');return null;}
    const s=Memory.playerAnalysis,elapsed=Game.time-s.startTick;
    console.log('[PlayerAnalysis] Target: '+s.targetPlayer+' | Phase: '+s.phase);
    if(s.phase==='scanning'){const pct=((s.scannedCount/s.totalScanRooms)*100).toFixed(1);console.log('  Scan: '+s.scannedCount+'/'+s.totalScanRooms+' ('+pct+'%) | Found: '+s.foundRooms.length);}
    else if(s.phase==='intel')console.log('  Intel: '+s.intelCount+'/'+s.totalIntelRooms);
    console.log('  Elapsed: '+elapsed+' ticks');return s;
}

function _paRun() {
    if(Memory.lastPlayerAnalysis&&Memory.lastPlayerAnalysis.expiresTick<=Game.time)delete Memory.lastPlayerAnalysis;
    if(Memory.playerAnalysis&&Memory.playerAnalysis.active){
        const state=Memory.playerAnalysis,obsMap=getObserverMap();
        if(state.phase==='scanning')_paScanPhase(state,obsMap);
        else if(state.phase==='intel')_paIntelPhase(state,obsMap);
    }
    _paCreepScanTick();
}

function _paScanPhase(state, obsMap) {
    if(state.lastObservedRoom){
        const room=Game.rooms[state.lastObservedRoom];
        if(room&&room.controller&&room.controller.owner&&room.controller.owner.username===state.targetPlayer){if(!state.foundRooms.includes(state.lastObservedRoom)){state.foundRooms.push(state.lastObservedRoom);console.log('[PlayerAnalysis] Found '+state.targetPlayer+'\'s room: '+state.lastObservedRoom+' (RCL '+room.controller.level+')');}}
        state.scannedCount++;state.lastObservedRoom=null;
    }
    if(!state.scanQueue.length){
        console.log('[PlayerAnalysis] Phase 1 complete. Found '+state.foundRooms.length+' room(s).');
        if(!state.foundRooms.length){console.log('[PlayerAnalysis] No rooms found for '+state.targetPlayer+' within observer range.');_paCompleteAnalysis(state);return;}
        state.phase='intel';state.intelQueue=state.foundRooms.slice();state.totalIntelRooms=state.foundRooms.length;
        console.log('[PlayerAnalysis] Phase 2: Gathering intel on '+state.totalIntelRooms+' room(s)...');return;
    }
    const nextRoom=state.scanQueue[0];
    const obs=findObserverForRoom(nextRoom,obsMap);
    if(!obs){state.scanQueue.shift();state.scannedCount++;}
    else if(_tickObserve(obs,nextRoom)){state.scanQueue.shift();state.lastObservedRoom=nextRoom;}
    // else: observer booked by a higher-priority consumer this tick — retry next tick
    if(state.scannedCount>0&&state.scannedCount%100===0)console.log('[PlayerAnalysis] Scan progress: '+state.scannedCount+'/'+state.totalScanRooms+' ('+((state.scannedCount/state.totalScanRooms)*100).toFixed(1)+'%) - Found '+state.foundRooms.length);
}

function _paIntelPhase(state, obsMap) {
    if(state.lastObservedRoom){
        const room=Game.rooms[state.lastObservedRoom];
        if(room)state.intelResults.push(_itRunSilent(room));
        state.intelCount++;state.lastObservedRoom=null;
    }
    if(!state.intelQueue.length){console.log('[PlayerAnalysis] Phase 2 complete. Intel on '+state.intelResults.length+' room(s).');_paCompleteAnalysis(state);return;}
    const nextRoom=state.intelQueue[0];
    const obs=findObserverForRoom(nextRoom,obsMap);
    if(!obs){state.intelQueue.shift();state.intelCount++;}
    else if(_tickObserve(obs,nextRoom)){state.intelQueue.shift();state.lastObservedRoom=nextRoom;}
}

function _paCompleteAnalysis(state) {
    const elapsed=Game.time-state.startTick,results=state.intelResults,pName=state.targetPlayer;
    const myNukers=_paGetMyNukerRooms(),myRooms=_paGetMyRooms();
    const enemyNukeThreats=[],myNukeTargets=[];
    for(const intel of results){
        if(intel.structures.nuker){const threatened=myRooms.filter(r=>canNuke(intel.room,r));if(threatened.length>0)enemyNukeThreats.push({enemyRoom:intel.room,ready:intel.structures.nukerReady,charging:intel.structures.nukerCharging,threatens:threatened});}
        for(const mn of myNukers){if(canNuke(mn.room,intel.room)){const ex=myNukeTargets.find(t=>t.myRoom===mn.room);if(ex)ex.canHit.push(intel.room);else myNukeTargets.push({myRoom:mn.room,ready:mn.ready,canHit:[intel.room]});}}
    }
    const weakRooms=results.filter(r=>r.scores.overall<PA_THRESHOLDS.weak);
    const strongRooms=results.filter(r=>r.scores.overall>=PA_THRESHOLDS.strong);
    const averageRooms=results.filter(r=>r.scores.overall>=PA_THRESHOLDS.weak&&r.scores.overall<PA_THRESHOLDS.strong);
    const avg=(key)=>results.length>0?results.reduce((s,r)=>s+r.scores[key],0)/results.length:0;
    const data={playerName:pName,elapsed,results,weakRooms,strongRooms,averageRooms,avgOverall:avg('overall'),avgEconomic:avg('economic'),avgMilitary:avg('military'),avgDualPurpose:avg('dualPurpose'),totalStorageEnergy:results.reduce((s,r)=>s+r.resources.storageEnergy,0),totalTerminalEnergy:results.reduce((s,r)=>s+r.resources.terminalEnergy,0),totalPower:results.reduce((s,r)=>s+r.resources.power,0),totalCombatBoosts:results.reduce((s,r)=>s+r.resources.combatBoosts,0),totalSpawns:results.reduce((s,r)=>s+r.structures.spawns,0),totalTowers:results.reduce((s,r)=>s+r.structures.towers,0),totalLabs:results.reduce((s,r)=>s+(r.structures.labs||0),0),roomsWithNuker:results.filter(r=>r.structures.nuker).length,roomsWithFactory:results.filter(r=>r.structures.factory).length,roomsWithPowerSpawn:results.filter(r=>r.structures.powerSpawn).length,enemyNukeThreats,myNukeTargets,myNukers};
    _paPrintReport(data);
    let notifyMsg=pName+' analysis complete.\nRooms: '+results.length+' ('+strongRooms.length+' strong, '+averageRooms.length+' avg, '+weakRooms.length+' weak)\nAvg Score: '+data.avgOverall.toFixed(1)+'/100';
    if(enemyNukeThreats.length>0)notifyMsg+='\nNUKE THREATS: '+enemyNukeThreats.length+' enemy nuker(s) can hit your rooms!';
    Game.notify(notifyMsg,0);
    delete Memory.playerAnalysis;
}

function _paPrintReport(data) {
    const D='════════════════════════════════════════════════════════════════════════════════════════════════════',L=[];
    L.push(D);L.push('PLAYER ANALYSIS: '+data.playerName+' | Rooms: '+data.results.length+' | Analysis Time: '+data.elapsed+' ticks');L.push(D);
    L.push('');L.push('AVERAGE SCORES:');L.push('   Overall: '+data.avgOverall.toFixed(1)+'/100 | Economic: '+data.avgEconomic.toFixed(1)+'/100 | Military: '+data.avgMilitary.toFixed(1)+'/100 | Infrastructure: '+data.avgDualPurpose.toFixed(1)+'/100');
    L.push('');L.push('ROOM CLASSIFICATIONS:');
    if(data.strongRooms.length>0)L.push('   STRONG ('+data.strongRooms.length+'): '+data.strongRooms.map(r=>r.room+'('+r.scores.overall.toFixed(0)+')').join(', '));
    if(data.averageRooms.length>0)L.push('   AVERAGE ('+data.averageRooms.length+'): '+data.averageRooms.map(r=>r.room+'('+r.scores.overall.toFixed(0)+')').join(', '));
    if(data.weakRooms.length>0)L.push('   WEAK ('+data.weakRooms.length+'): '+data.weakRooms.map(r=>r.room+'('+r.scores.overall.toFixed(0)+')').join(', '));
    L.push('');L.push('INFRASTRUCTURE TOTALS:');L.push('   Spawns: '+data.totalSpawns+' | Towers: '+data.totalTowers+' | Labs: '+data.totalLabs);L.push('   Nukers: '+data.roomsWithNuker+' | Factories: '+data.roomsWithFactory+' | Power Spawns: '+data.roomsWithPowerSpawn);
    L.push('');L.push('RESOURCE TOTALS:');L.push('   Storage Energy: '+_paFmtNum(data.totalStorageEnergy)+' | Terminal Energy: '+_paFmtNum(data.totalTerminalEnergy));L.push('   Power: '+_paFmtNum(data.totalPower)+' | Combat Boosts: '+_paFmtNum(data.totalCombatBoosts));
    L.push('');L.push('NUCLEAR ANALYSIS:');
    if(data.enemyNukeThreats.length>0){L.push('   ENEMY NUKE THREATS:');for(const t of data.enemyNukeThreats){const st=t.ready?'READY':t.charging?'CHARGING':'EMPTY';L.push('      '+t.enemyRoom+' ['+st+'] threatens: '+t.threatens.join(', '));}}else L.push('   No enemy nukers can reach your rooms');
    if(data.myNukeTargets.length>0){L.push('   YOUR STRIKE CAPABILITY:');for(const t of data.myNukeTargets)L.push('      '+t.myRoom+' ['+(t.ready?'READY':'NOT READY')+'] can hit: '+t.canHit.join(', '));}else L.push('   None of your nukers can reach '+data.playerName+'\'s rooms');
    L.push('');L.push('PER-ROOM DETAILS:');L.push('   Room         | RCL | Overall | Eco  | Mil  | Infra | Towers | Nuker    | Storage E  | Def Avg');L.push('   '+'-'.repeat(95));
    const sorted=data.results.slice().sort((a,b)=>b.scores.overall-a.scores.overall);
    for(const r of sorted){const np=r.room.padEnd(12),rclP=String(r.rcl).padStart(3),ovP=r.scores.overall.toFixed(1).padStart(7),eP=r.scores.economic.toFixed(1).padStart(5),mP=r.scores.military.toFixed(1).padStart(5),dP=r.scores.dualPurpose.toFixed(1).padStart(5),tP=((r.structures.towers||0)+'/6').padStart(6),ns=r.structures.nuker?r.structures.nukerReady?'READY':r.structures.nukerCharging?'Charging':'Empty':'None',nP=ns.padStart(8),sP=_paFmtNum(r.resources.storageEnergy||0).padStart(10),dAP=_paFmtNum(r.defense.avgDefenseHits||0).padStart(9);L.push('   '+np+' | '+rclP+' | '+ovP+' | '+eP+' | '+mP+' | '+dP+' | '+tP+' | '+nP+' | '+sP+' | '+dAP);}
    L.push('');L.push('ATTACK RECOMMENDATIONS:');
    const vuln=sorted.filter(r=>r.scores.military<50).sort((a,b)=>a.scores.military-b.scores.military).slice(0,5);
    if(vuln.length>0){L.push('   Most vulnerable (low military score):');for(const r of vuln){const issues=[];if((r.structures.towers||0)<3)issues.push('few towers');if((r.defense.avgDefenseHits||0)<1000000)issues.push('weak walls');if((r.defense.weakRamparts||0)>0)issues.push('weak ramparts');if((r.resources.storageEnergy||0)<100000)issues.push('low energy');L.push('      '+r.room+' (Mil: '+r.scores.military.toFixed(1)+') - '+(issues.length>0?issues.join(', '):'general weakness'));}}else L.push('   No obviously vulnerable rooms found.');
    const nukeableWeak=data.myNukeTargets.filter(t=>t.ready).map(t=>({myRoom:t.myRoom,targets:t.canHit.filter(tr=>{const intel=sorted.find(r=>r.room===tr);return intel&&intel.scores.military<50;})})).filter(t=>t.targets.length>0);
    if(nukeableWeak.length>0){L.push('');L.push('   NUKE-READY weak targets:');for(const n of nukeableWeak)L.push('      From '+n.myRoom+': '+n.targets.join(', '));}
    L.push('');L.push(D);L.push('Analysis stored in Memory.lastPlayerAnalysis (expires in 10,000 ticks)');L.push(D);
    Memory.lastPlayerAnalysis={player:data.playerName,tick:Game.time,expiresTick:Game.time+10000,roomCount:data.results.length,avgOverall:data.avgOverall,avgEconomic:data.avgEconomic,avgMilitary:data.avgMilitary,avgDualPurpose:data.avgDualPurpose,weakRooms:data.weakRooms.map(r=>r.room),averageRooms:data.averageRooms.map(r=>r.room),strongRooms:data.strongRooms.map(r=>r.room),totalSpawns:data.totalSpawns,totalTowers:data.totalTowers,totalLabs:data.totalLabs,roomsWithNuker:data.roomsWithNuker,roomsWithFactory:data.roomsWithFactory,roomsWithPowerSpawn:data.roomsWithPowerSpawn,totalStorageEnergy:data.totalStorageEnergy,totalTerminalEnergy:data.totalTerminalEnergy,totalPower:data.totalPower,totalCombatBoosts:data.totalCombatBoosts,rooms:sorted.map(r=>({room:r.room,rcl:r.rcl,scores:r.scores,towers:r.structures.towers,nuker:r.structures.nuker,nukerReady:r.structures.nukerReady,nukerCharging:r.structures.nukerCharging,storageEnergy:r.resources.storageEnergy,avgDefenseHits:r.defense.avgDefenseHits,weakRamparts:r.defense.weakRamparts})),nukeThreats:data.enemyNukeThreats,myStrikes:data.myNukeTargets};
    console.log(L.join('\n'));
}

function getLastPlayerAnalysis() {
    if(!Memory.lastPlayerAnalysis){console.log('[PlayerAnalysis] No previous analysis found.');return null;}
    const data=Memory.lastPlayerAnalysis;
    if(data.expiresTick<=Game.time){console.log('[PlayerAnalysis] Previous analysis expired.');delete Memory.lastPlayerAnalysis;return null;}
    const ticksAgo=Game.time-data.tick,ticksLeft=data.expiresTick-Game.time;
    const L=[],D='════════════════════════════════════════════════════════════════════════════════════════════════════';
    L.push(D);L.push('PLAYER ANALYSIS: '+data.player+' | Rooms: '+data.roomCount+' | '+ticksAgo+' ticks ago (expires in '+ticksLeft+'t)');L.push(D);
    L.push('Avg Overall: '+data.avgOverall.toFixed(1)+'/100 | Eco: '+data.avgEconomic.toFixed(1)+' | Mil: '+data.avgMilitary.toFixed(1)+' | Infra: '+data.avgDualPurpose.toFixed(1));
    if(data.strongRooms&&data.strongRooms.length)L.push('STRONG ('+data.strongRooms.length+'): '+data.strongRooms.join(', '));
    if(data.averageRooms&&data.averageRooms.length)L.push('AVERAGE ('+data.averageRooms.length+'): '+data.averageRooms.join(', '));
    if(data.weakRooms&&data.weakRooms.length)L.push('WEAK ('+data.weakRooms.length+'): '+data.weakRooms.join(', '));
    if(data.nukeThreats&&data.nukeThreats.length){L.push('NUKE THREATS:');for(const t of data.nukeThreats)L.push('  '+t.enemyRoom+' ['+(t.ready?'READY':t.charging?'CHARGING':'EMPTY')+'] threatens: '+t.threatens.join(', '));}
    if(data.rooms&&data.rooms.length&&data.rooms[0].scores){L.push('PER-ROOM: Room         | RCL | Overall | Eco  | Mil  | Infra | Storage E  | Nuker');for(const r of data.rooms)L.push('  '+r.room.padEnd(12)+' | '+String(r.rcl).padStart(3)+' | '+r.scores.overall.toFixed(1).padStart(7)+' | '+r.scores.economic.toFixed(1).padStart(5)+' | '+r.scores.military.toFixed(1).padStart(5)+' | '+r.scores.dualPurpose.toFixed(1).padStart(5)+' | '+_paFmtNum(r.storageEnergy||0).padStart(10)+' | '+(r.nuker?r.nukerReady?'READY':r.nukerCharging?'Charging':'Empty':'None'));}
    L.push(D);console.log(L.join('\n'));return data;
}

// ── Player: Creep census ──────────────────────────────────────────────────
function startPlayerScan(playerName, scanType) {
    if(!playerName||typeof playerName!=='string'){console.log('[PlayerScan] Usage: playerScan("PlayerName", "CREEPCOUNT")');return;}
    scanType=(scanType||'CREEPCOUNT').toUpperCase();
    if(!PA_SCAN_TYPES.includes(scanType)){console.log('[PlayerScan] Unknown scan type "'+scanType+'". Available: '+PA_SCAN_TYPES.join(', '));return;}
    if(Memory.playerScan&&Memory.playerScan.active){console.log('[PlayerScan] Scan already in progress for '+Memory.playerScan.targetPlayer+'. Use playerScanCancel().');return;}
    const obsMap=getObserverMap(),obsRooms=Object.keys(obsMap);
    if(!obsRooms.length){console.log('[PlayerScan] No observers found.');return;}
    const allRooms=[];for(const oRn of obsRooms){const oc=parseRoomCoords(oRn);if(!oc)continue;for(let dx=-OBSERVER_RANGE;dx<=OBSERVER_RANGE;dx++)for(let dy=-OBSERVER_RANGE;dy<=OBSERVER_RANGE;dy++){if(dx===0&&dy===0)continue;allRooms.push(toRoomName(oc.x+dx,oc.y+dy));}}
    const unique=[...new Set(allRooms)].filter(rn=>isClaimableRoom(rn));
    console.log('[PlayerScan] Starting '+scanType+' scan for: '+playerName+' ('+unique.length+' rooms)');
    Memory.playerScan={active:true,type:scanType,targetPlayer:playerName,startTick:Game.time,scanQueue:unique.slice(),scannedCount:0,totalScanRooms:unique.length,lastObservedRoom:null,creepCounts:{military:0,claimer:0,worker:0,supplier:0,scout:0,other:0,total:0},roomBreakdown:{}};
}

function _paCreepScanTick() {
    if(!Memory.playerScan||!Memory.playerScan.active)return;
    const state=Memory.playerScan,obsMap=getObserverMap();
    if(state.lastObservedRoom){
        const room=Game.rooms[state.lastObservedRoom];
        if(room&&room.controller&&room.controller.owner&&room.controller.owner.username===state.targetPlayer&&state.type==='CREEPCOUNT'){
            const hostiles=room.find(FIND_HOSTILE_CREEPS);const rc={military:0,claimer:0,worker:0,supplier:0,scout:0,other:0,total:hostiles.length};
            for(const creep of hostiles){const cat=_paCategorizeCreep(creep);rc[cat]++;state.creepCounts[cat]++;state.creepCounts.total++;}
            state.roomBreakdown[state.lastObservedRoom]=rc;
        }
        state.scannedCount++;state.lastObservedRoom=null;
    }
    if(!state.scanQueue.length){_paCompleteCreepScan(state);return;}
    const nextRoom=state.scanQueue[0];
    const obs=findObserverForRoom(nextRoom,obsMap);
    if(!obs){state.scanQueue.shift();state.scannedCount++;}
    else if(_tickObserve(obs,nextRoom)){state.scanQueue.shift();state.lastObservedRoom=nextRoom;}
    if(state.scannedCount>0&&state.scannedCount%200===0)console.log('[PlayerScan] '+state.scannedCount+'/'+state.totalScanRooms+' ('+((state.scannedCount/state.totalScanRooms)*100).toFixed(1)+'%)');
}

function _paCompleteCreepScan(state) {
    const elapsed=Game.time-state.startTick,roomCount=Object.keys(state.roomBreakdown).length,c=state.creepCounts;
    const D='════════════════════════════════════════════════════════════════════════',L=[];
    L.push(D);L.push('CREEP COUNT: '+state.targetPlayer+'  |  Rooms found: '+roomCount+'  |  Elapsed: '+elapsed+' ticks');L.push(D);L.push('');L.push('  Total creeps:  '+c.total);L.push('');
    const cats=[{key:'military',label:'Military '},{key:'worker',label:'Worker   '},{key:'supplier',label:'Supplier '},{key:'claimer',label:'Claimer  '},{key:'scout',label:'Scout    '},{key:'other',label:'Other    '}];
    for(const cat of cats){const count=c[cat.key];if(!count)continue;const pct=c.total>0?((count/c.total)*100).toFixed(1):'0.0';const bar='|'.repeat(Math.round(count/Math.max(c.total,1)*20));L.push('  '+cat.label+'  '+String(count).padStart(4)+'  ('+pct.padStart(5)+'%)  '+bar);}
    if(roomCount>1){L.push('');L.push('  Per room:');L.push('  Room         | Total | Mil | Work | Sup | Claim | Scout | Other');L.push('  '+'-'.repeat(64));const sorted=Object.entries(state.roomBreakdown).sort((a,b)=>b[1].total-a[1].total);for(const [room,rc] of sorted)L.push('  '+room.padEnd(12)+' | '+String(rc.total).padStart(5)+' | '+String(rc.military).padStart(3)+' | '+String(rc.worker).padStart(4)+' | '+String(rc.supplier).padStart(3)+' | '+String(rc.claimer).padStart(5)+' | '+String(rc.scout).padStart(5)+' | '+String(rc.other).padStart(5));}
    L.push('');L.push(D);console.log(L.join('\n'));
    Game.notify('[PlayerScan] '+state.targetPlayer+': Total '+c.total+' | Mil:'+c.military+' Work:'+c.worker+' Sup:'+c.supplier+(c.claimer?' Claim:'+c.claimer:'')+(c.scout?' Scout:'+c.scout:''),0);
    delete Memory.playerScan;
}

function cancelPlayerScan(){if(Memory.playerScan&&Memory.playerScan.active){console.log('[PlayerScan] Scan cancelled.');delete Memory.playerScan;}else console.log('[PlayerScan] No active scan.');}
function getPlayerScanStatus(){
    if(!Memory.playerScan||!Memory.playerScan.active){console.log('[PlayerScan] No active scan.');return null;}
    const s=Memory.playerScan,pct=((s.scannedCount/s.totalScanRooms)*100).toFixed(1);
    console.log('[PlayerScan] Target: '+s.targetPlayer+' | Progress: '+s.scannedCount+'/'+s.totalScanRooms+' ('+pct+'%) | Rooms found: '+Object.keys(s.roomBreakdown).length+' | Elapsed: '+(Game.time-s.startTick)+'t');
    if(s.type==='CREEPCOUNT'&&s.creepCounts.total>0){const c=s.creepCounts;console.log('[PlayerScan] Creeps so far: '+c.total+' | Mil:'+c.military+' Work:'+c.worker+' Sup:'+c.supplier+' Claim:'+c.claimer+' Scout:'+c.scout+' Other:'+c.other);}
    return s;
}

// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████████  WIDE SCAN  ████████████████████████████████████
// Registry-backed views. wideScan no longer runs its own observer loop:
// it reads the registry if fresh, otherwise starts a sweep and prints when
// the sweep completes.
// ════════════════════════════════════════════════════════════════════════════

function startWideScan(playerName) {
    if(!playerName||typeof playerName!=='string'){console.log('[WideScan] Usage: wideScan("PlayerName")');return;}
    const reg=_regMem();
    if(_regFresh()&&!(reg.sweep&&reg.sweep.active)){_wsReport(playerName);return;}
    Memory.wideScanReport={player:playerName,started:Game.time};
    _regStartSweep();
    console.log('[WideScan] Registry sweep '+(reg.sweep&&reg.sweep.active?'in progress':'started')+' — report for '+playerName+' prints on completion. (wideScanStatus for progress)');
}
function startWideScanPlayers() {
    const reg=_regMem();
    if(_regFresh()&&!(reg.sweep&&reg.sweep.active)){_wsReport(null);return;}
    Memory.wideScanReport={player:null,started:Game.time};
    _regStartSweep();
    console.log('[WideScan] Registry sweep '+(reg.sweep&&reg.sweep.active?'in progress':'started')+' — full player report prints on completion.');
}
function _wsReport(playerName) {
    const reg=_regMem();
    const age=reg.lastSweepEnd?(Game.time-reg.lastSweepEnd)+'t':'never swept';
    console.log('================================================================');
    if(playerName){
        const rooms=_regRoomsOf(playerName);
        if(rooms.length)console.log('[WideScan] '+playerName+' owns '+rooms.length+' room(s): '+rooms.map(rn=>rn+'(RCL'+reg.rooms[rn].l+')').join(', ')+'  [registry age: '+age+']');
        else console.log('[WideScan] '+playerName+' owns no rooms within observer range.  [registry age: '+age+']');
    } else {
        const byOwner={};
        for(const rn in reg.rooms){const e=reg.rooms[rn];if(!byOwner[e.o])byOwner[e.o]=[];byOwner[e.o].push(rn+'(RCL'+e.l+')');}
        const players=Object.keys(byOwner).sort();
        console.log('[WideScan] Players found: '+players.length+'  [registry age: '+age+']');
        for(const p of players)console.log('  '+p+': '+byOwner[p].sort().join(', '));
    }
    console.log('================================================================');
}
function _wsOnSweepComplete() {
    if(Memory.wideScanReport){_wsReport(Memory.wideScanReport.player);delete Memory.wideScanReport;}
}
function cancelWideScan() {
    if(Memory.wideScanReport){delete Memory.wideScanReport;console.log('[WideScan] Pending report cancelled. (The registry sweep continues — it serves the registry, not just this report.)');}
    else console.log('[WideScan] No pending wideScan report.');
}
function getWideScanStatus() {
    const reg=_regMem();
    if(reg.sweep&&reg.sweep.active){
        const s=reg.sweep,pct=((s.scanned/Math.max(s.total,1))*100).toFixed(1);
        console.log('[WideScan] Sweep: '+s.scanned+'/'+s.total+' ('+pct+'%) | Elapsed: '+(Game.time-s.started)+'t | Remaining: ~'+Math.ceil((s.total-s.scanned)/Math.max(Object.keys(s.queues).length,1))+'t'+(Memory.wideScanReport?' | Report pending: '+(Memory.wideScanReport.player||'all players'):''));
    } else {
        console.log('[WideScan] No sweep active. Registry age: '+(reg.lastSweepEnd?(Game.time-reg.lastSweepEnd)+'t':'never swept')+'. Use wideScan("Name") or registrySweep().');
    }
    return reg.sweep||null;
}
/** Legacy per-tick hook — sweeping is now driven by the scheduler (_regSweepRead/_regSweepFill). */
function _wsRun() {}


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████████  WAR ESTIMATE  █████████████████████████████████
// ════════════════════════════════════════════════════════════════════════════

// ── WarEstimate: Helpers ──────────────────────────────────────────────────
function _weGetMyRooms(){const r=[];for(const rn in Game.rooms){const room=Game.rooms[rn];if(room.controller&&room.controller.my)r.push(rn);}return r;}

function _weGetEnemyRoomsFromCache(playerName) {
    if(!Memory.lastPlayerAnalysis||Memory.lastPlayerAnalysis.player!==playerName)return null;
    if(Memory.lastPlayerAnalysis.expiresTick<=Game.time)return null;
    const rooms=Memory.lastPlayerAnalysis.rooms;if(!rooms||!rooms.length)return null;
    return rooms.map(r=>r.room);
}

function _weScore0to100(val, cap) { return Math.min(100, val/cap*100); }
function _weScore100to0(val, cap) { return Math.max(0, 100 - val/cap*100); }

function _weAvg(arr) { return arr.length>0?arr.reduce((s,v)=>s+v,0)/arr.length:0; }

/** Build a snapshot of the current war state from all visible enemy rooms */
function gatherSnapshot(state) {
    const snap={tick:Game.time,rooms:{}};
    for(const rn of (state.enemyRooms||[])){
        const room=Game.rooms[rn];if(!room)continue;
        const fp=_roomFingerprint(room);
        const spawns=_fpByType(fp,STRUCTURE_SPAWN);
        const towers=_fpByType(fp,STRUCTURE_TOWER);
        const labs=_fpByType(fp,STRUCTURE_LAB);
        const storage=room.storage;
        const terminal=_fpByType(fp,STRUCTURE_TERMINAL)[0];
        const factory=_fpByType(fp,STRUCTURE_FACTORY)[0];
        const powerSpawn=_fpByType(fp,STRUCTURE_POWER_SPAWN)[0];
        const nuker=_fpByType(fp,STRUCTURE_NUKER)[0];
        const ramparts=_fpByType(fp,STRUCTURE_RAMPART);
        const walls=_fpByType(fp,STRUCTURE_WALL);
        const allCreeps=fp.creeps;
        const boosts={};
        for(const boost of ALL_COMBAT_BOOSTS){let amt=0;if(storage&&storage.store)amt+=storage.store[boost]||0;if(terminal&&terminal.store)amt+=terminal.store[boost]||0;for(const lab of labs)if(lab.mineralType===boost)amt+=lab.store[boost]||0;if(amt>0)boosts[boost]=amt;}
        const minerals={};
        for(const res of BASE_MINERALS){let amt=0;if(storage&&storage.store)amt+=storage.store[res]||0;if(terminal&&terminal.store)amt+=terminal.store[res]||0;if(amt>0)minerals[res]=amt;}
        const allDef=ramparts.concat(walls);
        const defHPAll=allDef.map(d=>d.hits);
        const repairerCreeps=allCreeps.filter(c=>{const wb=c.body.filter(p=>p.type===WORK).length;return wb>0&&wb/c.body.length>0.25;});
        const repairCapacity=repairerCreeps.reduce((s,c)=>s+c.body.filter(p=>p.type===WORK).length*CREEP_REPAIR_HITS,0);
        const extensions=_fpByType(fp,STRUCTURE_EXTENSION);
        snap.rooms[rn]={tick:Game.time,rcl:room.controller?room.controller.level:0,spawns:spawns.length,towers:towers.length,labs:labs.length,factory:!!factory,factoryLevel:factory?factory.level||0:0,powerSpawn:!!powerSpawn,hasNuker:!!nuker,nukerReady:nuker?_nkIsNukerOp(nuker):false,hasTerminal:!!terminal,hasStorage:!!storage,storageEnergy:storage?storage.store[RESOURCE_ENERGY]||0:0,storageTotal:storage?storage.store.getUsedCapacity():0,terminalEnergy:terminal?terminal.store[RESOURCE_ENERGY]||0:0,terminalTotal:terminal?terminal.store.getUsedCapacity():0,terminalCooldown:terminal?terminal.cooldown||0:0,extensionCount:extensions.length,extensionFilled:extensions.filter(e=>e.store[RESOURCE_ENERGY]>0).length,safeModeAvailable:room.controller?room.controller.safeModeAvailable||0:0,safeMode:room.controller?room.controller.safeMode||0:0,safeModeCooldown:room.controller?room.controller.safeModeCooldown||0:0,powerCreeps:fp.powerCreeps.length,energyCapacity:room.energyCapacityAvailable,energyAvailable:room.energyAvailable,activeSpawning:spawns.filter(s=>s.spawning).length,boosts,minerals,defHPCount:allDef.length,defHPMedian:defHPAll.length?defHPAll.sort((a,b)=>a-b)[Math.floor(defHPAll.length/2)]:0,defHPSum:defHPAll.reduce((s,v)=>s+v,0),weakRamparts:ramparts.filter(r=>r.hits<100000).length,repairCapacity,allCreepCount:allCreeps.length};
    }
    return snap;
}

/** Gather room-level war data (single tick, for Phase 2 intel) */
function gatherRoomWarData(room, state) {
    if(!state.roomData)state.roomData={};
    const snap=gatherSnapshot({enemyRooms:[room.name]});
    const roomSnap=snap.rooms[room.name];
    if(!roomSnap)return;
    if(!state.roomData[room.name])state.roomData[room.name]={scans:[],nukeData:null};
    state.roomData[room.name].scans.push(roomSnap);
    // collect nuke data
    try {
        const nd=_nkComputeBestStrike(room);
        state.roomData[room.name].nukeData=nd;
    } catch(e){}
}

/** Compute all 6 categories x 3 horizons from accumulated state */
function computeWarEstimate(state) {
    const enemyRooms=state.enemyRooms||[];const myRooms=_weGetMyRooms();
    const roomData=state.roomData||{};const snaps=state.snapshots||[];const latestSnap=snaps.length>0?snaps[snaps.length-1]:null;
    const firstSnap=snaps.length>0?snaps[0]:null;
    const horizons=['short','medium','long'];

    // --- Helper: get latest value from snapshots for a room key ---
    function getLatest(roomName, key) {
        if(!latestSnap||!latestSnap.rooms[roomName])return 0;
        return latestSnap.rooms[roomName][key]||0;
    }
    function getFirst(roomName, key) {
        if(!firstSnap||!firstSnap.rooms[roomName])return 0;
        return firstSnap.rooms[roomName][key]||0;
    }
    function sumAllRooms(key) { return enemyRooms.reduce((s,rn)=>s+getLatest(rn,key),0); }

    // Support rooms: enemy rooms within SUPPORT_RANGE of any enemy room
    const supportSet=new Set();
    for(const rn of enemyRooms)for(const rn2 of enemyRooms)if(rn!==rn2&&getRoomDistance(rn,rn2)<=SUPPORT_RANGE)supportSet.add(rn2);

    // Theater: all rooms within OBSERVER_RANGE of any of our rooms
    const theaterSet=new Set();
    for(const rn of myRooms)for(const ern of enemyRooms)if(getRoomDistance(rn,ern)<=OBSERVER_RANGE)theaterSet.add(ern);

    // --- 1. Force Projection ---
    const spawnsInSupport=enemyRooms.reduce((s,rn)=>s+([...supportSet].includes(rn)?getLatest(rn,'spawns'):0),0);
    const towersInTheater=enemyRooms.reduce((s,rn)=>s+(theaterSet.has(rn)?getLatest(rn,'towers'):0),0);
    const terminalRooms=enemyRooms.filter(rn=>getLatest(rn,'hasTerminal'));
    const nukeOverlapRooms=enemyRooms.filter(rn=>myRooms.some(mr=>canNuke(rn,mr)));
    const avgDist=enemyRooms.length>0?_weAvg(enemyRooms.map(rn=>myRooms.length>0?Math.min(...myRooms.map(mr=>getRoomDistance(rn,mr))):15)):15;
    const distScore=_weScore100to0(avgDist,WE_CAPS.maxRoomSpread);
    const fpRaw={distance:distScore,spawnsSupport:_weScore0to100(spawnsInSupport,WE_CAPS.spawnsInTheater),towersTheater:_weScore0to100(towersInTheater,WE_CAPS.towersInTheater),terminalRelay:_weScore0to100(terminalRooms.length,enemyRooms.length)*100,nukeOverlap:_weScore0to100(nukeOverlapRooms.length,Math.max(enemyRooms.length,1))*100,roomsSupport:_weScore0to100(supportSet.size,WE_CAPS.roomsInSupport)};
    const fp={};for(const h of horizons){const w=WE_W.forceProjection[h];fp[h]=clamp(Object.keys(w).reduce((s,k)=>s+w[k]*(fpRaw[k]||0),0));}

    // --- 2. Spawn Throughput ---
    const energyCap=sumAllRooms('energyCapacity');
    const activeSpawns=sumAllRooms('activeSpawning');
    const extFilled=sumAllRooms('extensionFilled'),extCount=sumAllRooms('extensionCount');
    const extFill=extCount>0?extFilled/extCount:0;
    const hasPowerSpawn=enemyRooms.some(rn=>getLatest(rn,'powerSpawn'));
    const operatorBoost=hasPowerSpawn?100:0;
    const totalCreeps=sumAllRooms('allCreepCount');
    const stRaw={energyCap:_weScore0to100(energyCap,WE_CAPS.energyCap),activeSpawns:_weScore0to100(activeSpawns,WE_CAPS.activeSpawns),extensionFill:extFill*100,operatorBoost,creepsPer100:_weScore0to100(totalCreeps,100)};
    const st={};for(const h of horizons){const w=WE_W.spawnThroughput[h];st[h]=clamp(Object.keys(w).reduce((s,k)=>s+w[k]*(stRaw[k]||0),0));}

    // --- 3. Attrition ---
    const warChest=sumAllRooms('storageEnergy')+sumAllRooms('terminalEnergy');
    const totalMinerals=enemyRooms.reduce((s,rn)=>{const d=roomData[rn];if(!d||!d.scans||!d.scans.length)return s;const scan=d.scans[d.scans.length-1];if(!scan||!scan.minerals)return s;return s+Object.values(scan.minerals).reduce((ms,v)=>ms+v,0);},0);
    const hasMinSources=totalMinerals>0;
    const burnRateEst=enemyRooms.reduce((s,rn)=>s+getLatest(rn,'towers')*(TOWER_ENERGY_COST*1500/TICKS_PER_DAY)+getLatest(rn,'spawns')*400,0);
    const termDepth=terminalRooms.reduce((s,rn)=>s+getLatest(rn,'terminalTotal'),0)/Math.max(terminalRooms.length,1);
    let depletionScore=100;if(snaps.length>=2){const eFirst=enemyRooms.reduce((s,rn)=>s+getFirst(rn,'storageEnergy'),0);const eLast=enemyRooms.reduce((s,rn)=>s+getLatest(rn,'storageEnergy'),0);if(eFirst>0)depletionScore=clamp(eLast/eFirst*100);}
    const atRaw={warChest:_weScore0to100(warChest,WE_CAPS.warChest),baseIncome:_weScore0to100(enemyRooms.length,WE_CAPS.economicTiers)*100/100,econProduction:hasMinSources?75:25,tradeLiquidity:_weScore0to100(terminalRooms.length,WE_CAPS.marketScore/10)*WE_CAPS.marketScore,burnRate:_weScore100to0(burnRateEst,WE_CAPS.burnRate),terminalDepth:_weScore0to100(termDepth,WE_CAPS.terminalDepth*100000),mineralPressure:hasMinSources?75:25,depletion:depletionScore};
    const at={};for(const h of horizons){const w=WE_W.attrition[h];at[h]=clamp(Object.keys(w).reduce((s,k)=>s+w[k]*(atRaw[k]||0),0));}

    // --- 4. Boost Capacity ---
    const allBoostTotals={};for(const rn of enemyRooms){const d=roomData[rn];if(!d||!d.scans||!d.scans.length)continue;const scan=d.scans[d.scans.length-1];if(!scan||!scan.boosts)continue;for(const b in scan.boosts)allBoostTotals[b]=(allBoostTotals[b]||0)+scan.boosts[b];}
    const totalBoosts=Object.values(allBoostTotals).reduce((s,v)=>s+v,0);
    const t3Count=T3_BOOSTS.filter(b=>allBoostTotals[b]>0).length;
    const totalLabs=sumAllRooms('labs');
    const mineralTypes=enemyRooms.reduce((s,rn)=>{const d=roomData[rn];if(!d||!d.scans||!d.scans.length)return s;const scan=d.scans[d.scans.length-1];if(!scan||!scan.minerals)return s;for(const m of BASE_MINERALS)if(scan.minerals[m]>0)s.add(m);return s;},new Set()).size;
    const defensiveBoostTypes=COMBAT_BOOSTS_TUFF.filter(b=>allBoostTotals[b]>0).length;
    const bcRaw={stockpile:_weScore0to100(totalBoosts,WE_CAPS.combatBoosts),tierDistribution:_weScore0to100(t3Count,6)*100/6,labCapacity:_weScore0to100(totalLabs,WE_CAPS.labCount),baseMinerals:_weScore0to100(mineralTypes,WE_CAPS.baseMineralTypes),replenishment:totalMinerals>0?75:20,defensiveBoosts:_weScore0to100(defensiveBoostTypes,4)*100/4};
    const bc={};for(const h of horizons){const w=WE_W.boostCapacity[h];bc[h]=clamp(Object.keys(w).reduce((s,k)=>s+w[k]*(bcRaw[k]||0),0));}

    // --- 5. Defensive Depth ---
    const repairTotal=sumAllRooms('repairCapacity');
    const wallHPs=enemyRooms.map(rn=>getLatest(rn,'defHPMedian')).filter(v=>v>0);
    const wallHPMed=wallHPs.length>0?wallHPs.sort((a,b)=>a-b)[Math.floor(wallHPs.length/2)]:0;
    const safeModes=sumAllRooms('safeModeAvailable');
    const towerEnergy=enemyRooms.reduce((s,rn)=>{const cap=getLatest(rn,'towers')*TOWER_ENERGY_COST*1000;const avail=getLatest(rn,'storageEnergy');return s+(cap>0?Math.min(avail/cap,1):0);},0)/Math.max(enemyRooms.length,1);
    const gclPct=Game.gcl&&Game.gcl.progress&&Game.gcl.progressTotal?Game.gcl.progress/Game.gcl.progressTotal:0.5;
    const ctrlFort=_weAvg(enemyRooms.map(rn=>getLatest(rn,'safeModeAvailable')>0?100:getLatest(rn,'safeModeCooldown')===0?50:0));
    const ddRaw={repairThroughput:_weScore0to100(repairTotal,WE_CAPS.repairPerTick),wallHPPool:_weScore0to100(wallHPMed,WE_CAPS.wallHPMedian),safeModeInventory:_weScore0to100(safeModes,5),towerSustain:towerEnergy*100,gclHeadroom:gclPct*100,rebuildCapacity:_weScore0to100(warChest,WE_CAPS.warChest/2),controllerFort:ctrlFort};
    const dd={};for(const h of horizons){const w=WE_W.defensiveDepth[h];dd[h]=clamp(Object.keys(w).reduce((s,k)=>s+w[k]*(ddRaw[k]||0),0));}

    // --- 6. Multi-Front Strain ---
    const spawnAlloc=activeSpawns>0?1:0;
    const termBW=terminalRooms.length>0?_weAvg(terminalRooms.map(rn=>getLatest(rn,'terminalCooldown')===0?100:50)):0;
    const geoSpread=_weScore100to0(avgDistanceBetweenRooms(enemyRooms),WE_CAPS.maxRoomSpread);
    const reserveRooms=enemyRooms.filter(rn=>getLatest(rn,'safeMode')===0&&getLatest(rn,'activeSpawning')===0).length;
    const perFrontRatio=Math.max(myRooms.length,1)/Math.max(enemyRooms.length,1);
    const ownStrain=myRooms.length>enemyRooms.length*1.5?20:100;
    const mfRaw={spawnAllocation:spawnAlloc*100,terminalBandwidth:termBW,geoSpread,reserveRooms:_weScore0to100(reserveRooms,WE_CAPS.roomsInSupport),perFrontRatio:clamp(perFrontRatio*100/2),ownStrain};
    const mf={};for(const h of horizons){const w=WE_W.multiFrontStrain[h];mf[h]=clamp(Object.keys(w).reduce((s,k)=>s+w[k]*(mfRaw[k]||0),0));}

    // --- Composite ---
    const composite={};
    for(const h of horizons){const W=WE_CAT_WEIGHTS;composite[h]=clamp(W.forceProjection*fp[h]+W.spawnThroughput*st[h]+W.attrition*at[h]+W.boostCapacity*bc[h]+W.defensiveDepth*dd[h]+W.multiFrontStrain*mf[h]);}

    // --- Nuke data summary ---
    const nukeByRoom={};for(const rn of enemyRooms){const d=roomData[rn];if(d&&d.nukeData)nukeByRoom[rn]=d.nukeData;}

    return {forceProjection:fp,spawnThroughput:st,attrition:at,boostCapacity:bc,defensiveDepth:dd,multiFrontStrain:mf,composite,raw:{fp:fpRaw,st:stRaw,at:atRaw,bc:bcRaw,dd:ddRaw,mf:mfRaw},nukeByRoom,warChest,totalBoosts,totalLabs,spawnsInSupport,towersInTheater,avgDist};
}

/** Start war estimate for a player */
function startWarEstimate(playerName) {
    if(!playerName||typeof playerName!=='string'){console.log('[WarEstimate] Usage: warEstimate("PlayerName")');return;}
    if(Memory.warEstimate&&Memory.warEstimate.active){console.log('[WarEstimate] Estimate in progress for '+Memory.warEstimate.targetPlayer+'. Use warEstimateCancel().');return;}
    const cachedRooms=_weGetEnemyRoomsFromCache(playerName);
    const state={active:true,targetPlayer:playerName,startTick:Game.time,phase:'discovery',enemyRooms:cachedRooms||[],roomData:{},snapshots:[],snapCount:0,lastSnapTick:0,notifyQueue:[],notifyIndex:0,report:null};
    if(cachedRooms&&cachedRooms.length){state.phase='intel';state.intelQueue=cachedRooms.slice();state.intelCount=0;state.totalIntelRooms=cachedRooms.length;state.lastObservedRoom=null;console.log('[WarEstimate] Skipping discovery (fresh player() data). Proceeding to Intel phase. Enemy rooms: '+cachedRooms.join(', '));} else {
        // Discovery via the room registry — start a sweep if it isn't fresh
        if(!_regFresh())_regStartSweep();
        console.log('[WarEstimate] Phase 1: Discovery — reading the room registry for '+playerName+'\'s rooms'+(_regFresh()?'.':' (sweep running).'));
    }
    Memory.warEstimate=state;
}

function cancelWarEstimate(){if(Memory.warEstimate&&Memory.warEstimate.active){console.log('[WarEstimate] Estimate cancelled.');delete Memory.warEstimate;}else console.log('[WarEstimate] No active estimate.');}
function getWarEstimateStatus(){
    if(!Memory.warEstimate||!Memory.warEstimate.active){console.log('[WarEstimate] No active estimate.');return null;}
    const s=Memory.warEstimate,elapsed=Game.time-s.startTick;
    console.log('[WarEstimate] Target: '+s.targetPlayer+' | Phase: '+s.phase+' | Elapsed: '+elapsed+'t');
    if(s.phase==='discovery'){const reg=_regMem();console.log('  Waiting on registry'+(reg.sweep&&reg.sweep.active?' sweep: '+reg.sweep.scanned+'/'+reg.sweep.total:''));}
    else if(s.phase==='intel')console.log('  Intel: '+s.intelCount+'/'+s.totalIntelRooms+' | Enemy rooms: '+s.enemyRooms.join(', '));
    else if(s.phase==='monitor')console.log('  Monitor: '+s.snapCount+'/'+WE_MONITOR_SAMPLES+' snapshots. Next in ~'+(s.lastSnapTick+WE_MONITOR_INTERVAL-Game.time)+'t');
    else if(s.phase==='notify')console.log('  Notifying: '+(s.notifyIndex||0)+'/'+((s.notifyQueue&&s.notifyQueue.length)||0));
    return s;
}
function getLastWarEstimate(){
    if(!Memory.lastWarEstimate){console.log('[WarEstimate] No previous estimate found.');return null;}
    const d=Memory.lastWarEstimate;if(d.expiresTick<=Game.time){console.log('[WarEstimate] Previous estimate expired.');delete Memory.lastWarEstimate;return null;}
    _wePrintReport(d);return d;
}

function _weRun() {
    if(Memory.lastWarEstimate&&Memory.lastWarEstimate.expiresTick<=Game.time)delete Memory.lastWarEstimate;
    if(!Memory.warEstimate||!Memory.warEstimate.active)return;
    const state=Memory.warEstimate;
    if(state.phase==='discovery'){
        const reg=_regMem();
        if(reg.sweep&&reg.sweep.active)return; // sweep in progress — wait for it
        if(!_regFresh()){
            if(Game.time-state.startTick>10000){console.log('[WarEstimate] Discovery failed — registry sweep never completed (no observers?). Cancelling.');delete Memory.warEstimate;return;}
            _regStartSweep();return;
        }
        const rooms=_regRoomsOf(state.targetPlayer);
        if(!rooms.length){console.log('[WarEstimate] Discovery complete: no rooms found for '+state.targetPlayer+'.');delete Memory.warEstimate;return;}
        state.enemyRooms=rooms;state.phase='intel';state.intelQueue=rooms.slice();state.intelCount=0;state.totalIntelRooms=rooms.length;state.lastObservedRoom=null;
        console.log('[WarEstimate] Phase 2: Intel on '+rooms.length+' room(s): '+rooms.join(', '));
    } else if(state.phase==='intel'){
        _weIntelPhase(state);
    } else if(state.phase==='monitor'){
        _weMonitorPhase(state);
    } else if(state.phase==='compute'){
        _weComputePhase(state);
    } else if(state.phase==='notify'){
        _weNotifyPhase(state);
    }
}

function _weIntelPhase(state) {
    const obsMap=getObserverMap();
    if(state.lastObservedRoom){
        const room=Game.rooms[state.lastObservedRoom];
        if(room){gatherRoomWarData(room,state);console.log('[WarEstimate] Intel gathered: '+state.lastObservedRoom);}
        state.intelCount++;state.lastObservedRoom=null;
    }
    if(!state.intelQueue||!state.intelQueue.length){
        console.log('[WarEstimate] Phase 2: Intel complete. Starting monitor phase ('+WE_MONITOR_SAMPLES+' snapshots @ '+WE_MONITOR_INTERVAL+' tick intervals).');
        state.phase='monitor';state.lastSnapTick=Game.time;state.snapCount=0;return;
    }
    const nextRoom=state.intelQueue[0];
    const visRoom=Game.rooms[nextRoom];
    if(visRoom){state.intelQueue.shift();gatherRoomWarData(visRoom,state);state.intelCount++;console.log('[WarEstimate] Intel gathered: '+nextRoom);return;}
    const obs=findObserverForRoom(nextRoom,obsMap);
    if(!obs){state.intelQueue.shift();state.intelCount++;}
    else if(_tickObserve(obs,nextRoom)){state.intelQueue.shift();state.lastObservedRoom=nextRoom;}
    // else: observer booked this tick — retry next tick
}

function _weMonitorPhase(state) {
    // Observe all enemy rooms this tick for fresh data (skip already-visible, book shared)
    const obsMap=getObserverMap();
    for(const rn of state.enemyRooms){
        if(Game.rooms[rn])continue;
        const obs=findObserverForRoom(rn,obsMap);
        if(obs)_tickObserve(obs,rn);
    }
    if(Game.time-state.lastSnapTick>=WE_MONITOR_INTERVAL){
        // Take snapshot of all visible enemy rooms
        const snap=gatherSnapshot(state);
        if(Object.keys(snap.rooms).length>0){state.snapshots.push(snap);state.snapCount++;state.lastSnapTick=Game.time;console.log('[WarEstimate] Monitor snapshot '+state.snapCount+'/'+WE_MONITOR_SAMPLES+' taken.');}
        if(state.snapCount>=WE_MONITOR_SAMPLES){console.log('[WarEstimate] Phase 3: Monitor complete. Computing estimates...');state.phase='compute';}
    }
}

function _weComputePhase(state) {
    try{const result=computeWarEstimate(state);const report={player:state.targetPlayer,tick:Game.time,elapsed:Game.time-state.startTick,expiresTick:Game.time+2000,result};state.report=report;Memory.lastWarEstimate=report;_weGenerateNotifyQueue(state,result);state.phase='notify';console.log('[WarEstimate] Phase 4: Compute complete. Sending notifications...');    }catch(e){console.log('[WarEstimate] ERROR in compute phase: '+e.message);delete Memory.warEstimate;}
}

function _weGenerateNotifyQueue(state, result) {
    const lines=[];const r=result;const comp=r.composite;
    lines.push('[WarEstimate] '+state.targetPlayer);
    lines.push('Score (Short/Med/Long):');
    lines.push('  Overall: S:'+comp.short.toFixed(0)+' M:'+comp.medium.toFixed(0)+' L:'+comp.long.toFixed(0));
    for(const h of['short','medium','long'])lines.push(h.toUpperCase()+': FP:'+r.forceProjection[h].toFixed(0)+' ST:'+r.spawnThroughput[h].toFixed(0)+' AT:'+r.attrition[h].toFixed(0)+' BC:'+r.boostCapacity[h].toFixed(0)+' DD:'+r.defensiveDepth[h].toFixed(0)+' MF:'+r.multiFrontStrain[h].toFixed(0));
    // Chunk into <=WE_NOTIFY_TOTAL_MAX char pieces
    const queue=[];let buf='';
    for(const line of lines){if((buf+'\n'+line).length>WE_NOTIFY_TOTAL_MAX){if(buf)queue.push(buf);buf=line;}else buf+='\n'+line;}
    if(buf)queue.push(buf);
    state.notifyQueue=queue;state.notifyIndex=0;
}

function _weNotifyPhase(state) {
    if(!state.notifyQueue||state.notifyIndex>=state.notifyQueue.length){
        console.log('[WarEstimate] Phase 5: Notifications sent. Estimate complete.');
        _wePrintReport(state.report);delete Memory.warEstimate;return;
    }
    let sent=0;
    while(state.notifyIndex<state.notifyQueue.length&&sent<WE_NOTIFY_PER_TICK){
        const chunk=state.notifyQueue[state.notifyIndex];try{Game.notify(chunk,0);}catch(e){}state.notifyIndex++;sent++;
    }
}

function _wePrintReport(report) {
    if(!report||!report.result){console.log('[WarEstimate] No report data to print.');return;}
    const r=report.result,D='════════════════════════════════════════════════════════════════════════',L=[];
    L.push(D);L.push('WAR ESTIMATE: '+report.player+'  |  Generated: '+report.tick+' ('+report.elapsed+' ticks)');L.push(D);
    const horizons=['short','medium','long'],hLabels={short:'SHORT (0-50k)',medium:'MEDIUM (50k-200k)',long:'LONG (200k+)'};
    for(const h of horizons){L.push('');L.push('-- '+hLabels[h]+' --');L.push('  Overall: '+r.composite[h].toFixed(1)+'/100');L.push('  Force Projection: '+r.forceProjection[h].toFixed(1)+'/100  | Spawn Throughput: '+r.spawnThroughput[h].toFixed(1)+'/100');L.push('  Attrition:         '+r.attrition[h].toFixed(1)+'/100  | Boost Capacity:   '+r.boostCapacity[h].toFixed(1)+'/100');L.push('  Defensive Depth:   '+r.defensiveDepth[h].toFixed(1)+'/100  | Multi-Front:      '+r.multiFrontStrain[h].toFixed(1)+'/100');}
    L.push('');L.push('RAW DATA:');L.push('  War Chest: '+fmtE(r.warChest)+' energy | Combat Boosts: '+fmtNum(r.totalBoosts)+' | Labs: '+r.totalLabs);L.push('  Spawns in Support Range: '+r.spawnsInSupport+' | Towers in Theater: '+r.towersInTheater+' | Avg Distance: '+r.avgDist.toFixed(1));
    if(r.nukeByRoom&&Object.keys(r.nukeByRoom).length>0){L.push('');L.push('NUKE STRIKE ANALYSIS:');for(const rn in r.nukeByRoom){const nd=r.nukeByRoom[rn];L.push('  '+rn+': Best strike ('+nd.x+','+nd.y+') = '+fmtCr(nd.damage)+' damage ('+nd.percent+'% of nuke cost). Destroys: '+nd.destroyedSummary);}}
    L.push('');L.push(D);console.log(L.join('\n'));
}


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████  OBSERVER SCHEDULER  ██████████████████████████████████
// Persistent request queue for observer time. External modules call
// scanner.observe.request(roomName, src, priority) and wait for visibility.
// Dispatch happens at the top of scanner.run(); the registry sweep consumes
// whatever observers remain at the END of scanner.run().
// ════════════════════════════════════════════════════════════════════════════

function _schedMem() {
    if (!Memory.obsSched) Memory.obsSched = { req: {} };
    if (!Memory.obsSched.req) Memory.obsSched.req = {};
    return Memory.obsSched;
}

/**
 * Queue a room for observation. Returns false if NO observer can ever reach
 * the room (callers should treat that as "unreachable" and stop retrying).
 * Re-requesting an already-queued room is free; the higher priority wins.
 */
function obsRequest(roomName, src, priority) {
    if (!roomName || typeof roomName !== 'string') return false;
    if (Game.rooms[roomName]) return true;              // already visible — nothing to do
    if (!findObserverInRange(roomName, null)) return false;
    const m = _schedMem();
    const ex = m.req[roomName];
    if (!ex || (priority || 50) > ex.p)
        m.req[roomName] = { p: priority || 50, src: src || '?', t: (ex && ex.t) || Game.time };
    return true;
}

function obsCancel(roomName) { const m = _schedMem(); delete m.req[roomName]; }

/** True if any of our observers can reach this room. */
function obsInRange(roomName) { return !!findObserverInRange(roomName, null); }

/**
 * Scheduler tick — call FIRST in scanner.run().
 *   1. Read phase: harvest sweep results + monitor hot-poll results
 *   2. Clear fulfilled / timed-out requests
 *   3. Submit monitor hot-polls
 *   4. Dispatch: legacy one-shot pendings (intel/nuke/maint) + queued
 *      requests, highest priority first, booking through the shared set
 */
function _schedTick() {
    _regSweepRead();
    _monReadAwaiting();

    const m = _schedMem();
    for (const rn in m.req) {
        if (Game.rooms[rn]) { delete m.req[rn]; continue; }       // fulfilled — consumer reads it this tick
        if (Game.time - m.req[rn].t > OBS_REQ_TIMEOUT) delete m.req[rn];
    }

    _monSubmitPolls();

    const requests = [];
    // Legacy one-shot pendings keep top priority so console commands stay snappy
    if (Memory.roomIntelPending)
        for (const rn in Memory.roomIntelPending) {
            const p = Memory.roomIntelPending[rn];
            if (!Game.rooms[rn] && (!p.tick || Game.time - p.tick > 0))
                requests.push({ p: OBS_PRI.ONESHOT, rn });
        }
    if (Memory.nukeAnalyzePending)
        for (const rn in Memory.nukeAnalyzePending)
            if (!Game.rooms[rn]) requests.push({ p: OBS_PRI.ONESHOT - 1, rn });
    if (Memory.maintScan && Memory.maintScan.pending)
        for (const rn in Memory.maintScan.pending)
            if (!Game.rooms[rn]) requests.push({ p: OBS_PRI.ONESHOT - 2, rn });
    // Queued requests (depositObserver, monitor hot-polls, anything external)
    for (const rn in m.req) requests.push({ p: m.req[rn].p, rn });

    // Dedupe by room, keep highest priority
    const best = {};
    for (const r of requests)
        if (!best[r.rn] || r.p > best[r.rn].p) best[r.rn] = r;
    const list = Object.values(best).sort((a, b) => b.p - a.p);

    const used = _tickUsedSet();
    for (const r of list) {
        const obs = findObserverInRange(r.rn, used);
        if (obs && obs.observeRoom(r.rn) === OK) used.add(obs.id);
    }
}


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████  ROOM REGISTRY  ███████████████████████████████████
// Minimal ownership registry of every claimable room within observer range.
// Populated by periodic parallel sweeps that consume leftover observer time.
//   Memory.roomRegistry.rooms = { 'E5N12': { o:'Player', l:7, t:tick } }
// Unowned rooms are represented by ABSENCE (plus the sweep timestamp).
// ════════════════════════════════════════════════════════════════════════════

function _regMem() {
    if (!Memory.roomRegistry)
        Memory.roomRegistry = { rooms: {}, lastSweepStart: 0, lastSweepEnd: 0, bootstrapped: false, sweep: null, interval: REG_SWEEP_INTERVAL };
    if (!Memory.roomRegistry.rooms) Memory.roomRegistry.rooms = {};
    return Memory.roomRegistry;
}

function _regFresh() {
    const reg = _regMem();
    return reg.lastSweepEnd > 0 && Game.time - reg.lastSweepEnd < REG_FRESH_TICKS;
}

/** All registry rooms owned by `player`, sorted. */
function _regRoomsOf(player) {
    const reg = _regMem(), out = [];
    for (const rn in reg.rooms) if (reg.rooms[rn].o === player) out.push(rn);
    return out.sort();
}

/**
 * Record a VISIBLE room into the registry. Fires ownership alerts
 * (NEW_ROOM / ROOM_LOST) for statused players and runs the deep monitor
 * analysis if the owner is statused. Silent during the bootstrap sweep.
 */
function _regRecord(roomName, room) {
    const reg = _regMem();
    if (room.controller && room.controller.my) return;   // we don't track ourselves
    const owner = (room.controller && room.controller.owner) ? room.controller.owner.username : null;
    const prev = reg.rooms[roomName];
    const silent = !reg.bootstrapped;
    if (owner) {
        const rcl = room.controller.level;
        if (!prev) {
            if (!silent) _monFire(owner, roomName, 'NEW_ROOM', owner + ' has claimed a new room: ' + roomName);
        } else if (prev.o !== owner) {
            if (!silent) {
                _monFire(prev.o, roomName, 'ROOM_LOST', 'Room is no longer owned by ' + prev.o + ' (now owned by ' + owner + ')');
                _monFire(owner, roomName, 'NEW_ROOM', owner + ' has claimed a new room: ' + roomName);
            }
            if (Memory.playerMonitor && Memory.playerMonitor.state) delete Memory.playerMonitor.state[roomName];
        }
        reg.rooms[roomName] = { o: owner, l: rcl, t: Game.time };
        _monAnalyzeIfTracked(room, owner);
    } else {
        if (prev) {
            if (!silent) _monFire(prev.o, roomName, 'ROOM_LOST', 'Room is no longer owned by ' + prev.o + ' (unclaimed)');
            delete reg.rooms[roomName];
            if (Memory.playerMonitor && Memory.playerMonitor.state) delete Memory.playerMonitor.state[roomName];
        }
    }
}

/** Build per-observer queues of every claimable room in range and start sweeping. */
function _regStartSweep() {
    const reg = _regMem();
    if (reg.sweep && reg.sweep.active) return false;
    const obsMap = getObserverMap(), obsRooms = Object.keys(obsMap);
    if (!obsRooms.length) { console.log('[Registry] No observers — cannot sweep.'); return false; }

    const targets = new Set();
    for (const oRn of obsRooms) {
        const oc = parseRoomCoords(oRn);
        if (!oc) continue;
        for (let dx = -OBSERVER_RANGE; dx <= OBSERVER_RANGE; dx++)
            for (let dy = -OBSERVER_RANGE; dy <= OBSERVER_RANGE; dy++) {
                const rn = toRoomName(oc.x + dx, oc.y + dy);
                if (!isClaimableRoom(rn)) continue;            // highway / SK / center can't be owned
                const r = Game.rooms[rn];
                if (r && r.controller && r.controller.my) continue;
                targets.add(rn);
            }
    }

    // Assign each target to the least-loaded capable observer so the sweep
    // runs in parallel across all observers (~total/observers ticks).
    const queues = {}, loads = {};
    for (const oRn of obsRooms) { queues[oRn] = []; loads[oRn] = 0; }
    for (const rn of targets) {
        const tc = parseRoomCoords(rn);
        if (!tc) continue;
        let bestObs = null, bestLoad = Infinity;
        for (const oRn of obsRooms) {
            const oc = parseRoomCoords(oRn);
            if (!oc) continue;
            const d = Math.max(Math.abs(tc.x - oc.x), Math.abs(tc.y - oc.y));
            if (d <= OBSERVER_RANGE && loads[oRn] < bestLoad) { bestObs = oRn; bestLoad = loads[oRn]; }
        }
        if (bestObs) { queues[bestObs].push(rn); loads[bestObs]++; }
    }

    reg.sweep = { active: true, started: Game.time, queues, pending: {}, scanned: 0, observed: 0, total: targets.size };
    reg.lastSweepStart = Game.time;
    console.log('[Registry] Sweep started: ' + targets.size + ' claimable room(s) across ' + obsRooms.length + ' observer(s) (~' + Math.ceil(targets.size / obsRooms.length) + ' ticks).');
    return true;
}

/** Read phase — harvest what the sweep observed LAST tick. Runs in _schedTick. */
function _regSweepRead() {
    const reg = _regMem();
    const sweep = reg.sweep;
    if (!sweep || !sweep.active) return;
    for (const oRn in sweep.pending) {
        const rn = sweep.pending[oRn];
        const room = Game.rooms[rn];
        if (room) { _regRecord(rn, room); sweep.observed++; }
        sweep.scanned++;
        delete sweep.pending[oRn];
    }
}

/** Fill phase — leftover observers advance the sweep. Runs LAST in scanner.run(). */
function _regSweepFill() {
    const reg = _regMem();
    const interval = reg.interval || REG_SWEEP_INTERVAL;
    const neverSwept = reg.lastSweepEnd === 0 && reg.lastSweepStart === 0;
    if ((!reg.sweep || !reg.sweep.active) &&
        (neverSwept || Game.time - Math.max(reg.lastSweepEnd, reg.lastSweepStart) >= interval))
        _regStartSweep();

    const sweep = reg.sweep;
    if (!sweep || !sweep.active) return;

    // Safety valve: a lost observer room can strand its queue
    if (Game.time - sweep.started > REG_SWEEP_TIMEOUT) {
        console.log('[Registry] Sweep timed out — finalizing with ' + sweep.scanned + '/' + sweep.total + ' processed.');
        reg.lastSweepEnd = Game.time; reg.bootstrapped = true; reg.sweep = null;
        _wsOnSweepComplete();
        return;
    }

    const used = _tickUsedSet();
    let remaining = 0;
    for (const oRn in sweep.queues) {
        const q = sweep.queues[oRn];
        if (!q.length) continue;
        // Drain targets that are already visible without spending the observer
        while (q.length && Game.rooms[q[0]]) {
            const rn = q.shift();
            _regRecord(rn, Game.rooms[rn]);
            sweep.scanned++; sweep.observed++;
        }
        if (!q.length) continue;
        const room = Game.rooms[oRn];
        let obs = null;
        if (room && room.controller && room.controller.my)
            obs = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_OBSERVER })[0];
        if (obs && !used.has(obs.id) && !sweep.pending[oRn]) {
            const target = q.shift();
            if (obs.observeRoom(target) === OK) { used.add(obs.id); sweep.pending[oRn] = target; }
            else q.unshift(target);
        }
        remaining += q.length;
    }

    if (remaining === 0 && Object.keys(sweep.pending).length === 0) {
        reg.lastSweepEnd = Game.time; reg.bootstrapped = true; reg.sweep = null;
        console.log('[Registry] Sweep complete: ' + sweep.scanned + '/' + sweep.total + ' rooms processed (' + sweep.observed + ' observed) in ' + (Game.time - sweep.started) + ' ticks. Registry holds ' + Object.keys(reg.rooms).length + ' owned room(s).');
        _wsOnSweepComplete();
    }
}

// ── Registry: console commands ────────────────────────────────────────────
function registrySweep() {
    const reg = _regMem();
    if (reg.sweep && reg.sweep.active) { console.log('[Registry] Sweep already active: ' + reg.sweep.scanned + '/' + reg.sweep.total); return; }
    _regStartSweep();
}
function registryStatus() {
    const reg = _regMem();
    if (reg.sweep && reg.sweep.active) {
        const s = reg.sweep, pct = ((s.scanned / Math.max(s.total, 1)) * 100).toFixed(1);
        console.log('[Registry] Sweep ACTIVE: ' + s.scanned + '/' + s.total + ' (' + pct + '%) | observed ' + s.observed + ' | elapsed ' + (Game.time - s.started) + 't');
    } else {
        console.log('[Registry] No sweep active. Last sweep: ' + (reg.lastSweepEnd ? (Game.time - reg.lastSweepEnd) + 't ago' : 'never') + ' | auto-interval: ' + (reg.interval || REG_SWEEP_INTERVAL) + 't (Memory.roomRegistry.interval to change)');
    }
    console.log('[Registry] Tracking ' + Object.keys(reg.rooms).length + ' owned room(s). registryList() / registryPlayer("name") for details.');
}
function registryPlayer(name) {
    if (!name || typeof name !== 'string') { console.log('[Registry] Usage: registryPlayer("PlayerName")'); return; }
    const reg = _regMem(), rooms = _regRoomsOf(name);
    if (!rooms.length) { console.log('[Registry] No rooms recorded for ' + name + '. (Registry age: ' + (reg.lastSweepEnd ? (Game.time - reg.lastSweepEnd) + 't' : 'never swept') + ')'); return; }
    console.log('[Registry] ' + name + ' — ' + rooms.length + ' room(s):');
    for (const rn of rooms) { const e = reg.rooms[rn]; console.log('  ' + rn + '  RCL' + e.l + '  (seen ' + (Game.time - e.t) + 't ago)'); }
}
function registryList() {
    const reg = _regMem(), byOwner = {};
    for (const rn in reg.rooms) { const e = reg.rooms[rn]; if (!byOwner[e.o]) byOwner[e.o] = []; byOwner[e.o].push(rn + '(RCL' + e.l + ')'); }
    const players = Object.keys(byOwner).sort();
    if (!players.length) { console.log('[Registry] Empty — run registrySweep().'); return; }
    console.log('[Registry] ' + players.length + ' player(s), ' + Object.keys(reg.rooms).length + ' room(s)  [age: ' + (reg.lastSweepEnd ? (Game.time - reg.lastSweepEnd) + 't' : 'sweeping') + ']:');
    for (const p of players) console.log('  ' + p + ' (' + byOwner[p].length + '): ' + byOwner[p].sort().join(', '));
}


// ════════════════════════════════════════════════════════════════════════════
// ████████████████████████  PLAYER MONITOR  ██████████████████████████████████
// Registry-driven. Player rooms come from the registry (no per-player room
// lists or observer assignments). Statuses control alert filtering and
// hot-poll rates; the periodic sweep deep-analyzes statused players' rooms
// for free as it passes through.
// ════════════════════════════════════════════════════════════════════════════

function _monMem() {
    if (!Memory.playerMonitor) Memory.playerMonitor = { players: {}, state: {}, awaiting: {}, paused: false };
    const mem = Memory.playerMonitor;
    if (!mem.players) mem.players = {};
    if (!mem.state) mem.state = {};
    if (!mem.awaiting) mem.awaiting = {};
    // One-time migration from the old playerMonitor.js format
    if (mem.cycle !== undefined || mem.rescanQueue !== undefined || mem.pendingWideScan !== undefined || mem.lastRescan !== undefined) {
        const reg = _regMem();
        for (const pName in mem.players) {
            const pd = mem.players[pName];
            if (pd && pd.rooms) {
                for (const rn of pd.rooms) {
                    if (!reg.rooms[rn]) reg.rooms[rn] = { o: pName, l: (pd.state && pd.state[rn] && pd.state[rn].rcl) || 0, t: (pd.state && pd.state[rn] && pd.state[rn].t) || 0 };
                    if (pd.state && pd.state[rn]) mem.state[rn] = pd.state[rn];
                }
            }
            mem.players[pName] = { status: (pd && pd.status) || STATUS.ENEMY };
        }
        delete mem.cycle; delete mem.rescanQueue; delete mem.lastRescan; delete mem.pendingWideScan;
        console.log('[Monitor] Migrated old playerMonitor memory to the registry-backed format.');
    }
    return mem;
}

// ── RemoteSupply integration helper ──────────────────────────────────────
/**
 * Returns true if remoteSupplyManager has an active order watching
 * roomName as its recipient. Reads Memory directly — no require(),
 * no object allocation, O(orders) which is typically 1–3 entries.
 */
function _isRemoteSupplyRoom(roomName) {
    var orders = Memory.remoteSupplyOrders;
    if (!orders) return false;
    for (var key in orders) {
        var o = orders[key];
        if (o && o.active && o.recipientRoom === roomName) return true;
    }
    return false;
}

// ── Alerts ────────────────────────────────────────────────────────────────
function _monFire(playerName, room, type, message) {
    const mem = _monMem();
    const pd = mem.players[playerName];
    if (!pd) return;                       // unstatused players are tracked silently
    if (mem.paused) return;
    const filter = ALERT_FILTER[pd.status || STATUS.ENEMY];
    if (filter && !filter.includes(type)) return;
    console.log('[Monitor][' + playerName + '][' + room + '] ' + type + ': ' + message);
    Game.notify('[Monitor] ' + playerName + ' | ' + room + ' | ' + type + ': ' + message, NOTIFY_COOLDOWN);
}

// ── Room analysis (ported intact from playerMonitor.js) ───────────────────
/**
 * Analyze a visible room and fire alerts based on state changes.
 * Ownership changes (ROOM_LOST / NEW_ROOM) are handled by the registry
 * layer — this function no longer fires ROOM_LOST itself.
 *
 * State fields:
 *   owned, rcl, safeMode, hasNuker, nukerHasG, nukerHasE, hasMilitary,
 *   hasBoosted, hasCreeps, spawnsDrained,
 *   spawnExtEnergy / storageEnergy (only for remoteSupply-watched rooms),
 *   hasPower (ENEMY/WAR), towersLow, terminalHasG (WAR), t
 */
function analyzeRoom(room, playerName, prev, status) {
    const roomName = room.name;
    const s = {};
    const first = Object.keys(prev).length === 0;

    // ── Owner check (alerting handled by the registry layer) ────
    const owner = (room.controller && room.controller.owner)
                ? room.controller.owner.username : null;

    if (owner !== playerName) {
        s.owned = false;
        s.t = Game.time;
        return s;
    }
    s.owned = true;

    // ── Controller / RCL ────────────────────────────────────────
    const rcl = room.controller ? room.controller.level : 0;
    s.rcl = rcl;

    if (!first && prev.rcl !== undefined && prev.rcl !== rcl) {
        const dir = rcl > prev.rcl ? 'UPGRADED' : 'DOWNGRADED';
        _monFire(playerName, roomName, 'RCL_' + dir,
                 'RCL changed from ' + prev.rcl + ' to ' + rcl);
    }

    // ── Safe mode ───────────────────────────────────────────────
    s.safeMode = room.controller ? !!room.controller.safeMode : false;

    if (!first && !prev.safeMode && s.safeMode) {
        _monFire(playerName, roomName, 'SAFE_MODE',
                 'Safe mode activated! ' + room.controller.safeMode + ' ticks remaining');
    }

    // ── Hostile structures (one unfiltered find, grouped by type) ──
    // Replaces 7 separate filtered FIND_HOSTILE_STRUCTURES calls. Each filtered
    // find re-walks the structure list with a callback; one unfiltered find +
    // JS grouping is cheaper even when some conditional branches don't fire.
    const _hostileStructs = room.find(FIND_HOSTILE_STRUCTURES);
    const _hostileByType = Object.create(null);
    for (let i = 0; i < _hostileStructs.length; i++) {
        const _st = _hostileStructs[i];
        const _t = _st.structureType;
        (_hostileByType[_t] || (_hostileByType[_t] = [])).push(_st);
    }

    // ── Nuker ───────────────────────────────────────────────────
    const nukers = _hostileByType[STRUCTURE_NUKER] || [];
    s.hasNuker = nukers.length > 0;

    if (s.hasNuker) {
        const nuker = nukers[0];
        const gAmt = nuker.store.getUsedCapacity(RESOURCE_GHODIUM) || 0;
        const eAmt = nuker.store.getUsedCapacity(RESOURCE_ENERGY)  || 0;
        s.nukerHasG = gAmt > 0;
        s.nukerHasE = eAmt > 0;

        if (!first) {
            if (!prev.hasNuker) {
                _monFire(playerName, roomName, 'NUKER_BUILT',
                         'A nuker has been constructed!');
            }
            if (!prev.nukerHasG && s.nukerHasG) {
                _monFire(playerName, roomName, 'NUKER_FILLING_G',
                         'Nuker ghodium filling started (now ' + gAmt + '/5000)');
            }
            if (!prev.nukerHasE && s.nukerHasE) {
                _monFire(playerName, roomName, 'NUKER_FILLING_E',
                         'Nuker energy filling started (now ' + eAmt + '/300000)');
            }
        }
    } else {
        s.nukerHasG = false;
        s.nukerHasE = false;
    }

    // ── Creeps ──────────────────────────────────────────────────
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS, {
        filter: c => c.owner.username === playerName
    });

    s.hasCreeps = hostileCreeps.length > 0;

    const militaryParts = [ATTACK, RANGED_ATTACK, HEAL];
    const militaryCreeps = hostileCreeps.filter(c =>
        c.body.some(p => militaryParts.includes(p.type))
    );
    s.hasMilitary = militaryCreeps.length > 0;

    if (!first && !prev.hasMilitary && s.hasMilitary) {
        const summary = militaryCreeps.map(c => {
            const parts = {};
            for (const p of c.body) {
                if (militaryParts.includes(p.type)) {
                    parts[p.type] = (parts[p.type] || 0) + 1;
                }
            }
            return Object.keys(parts).map(k => parts[k] + k.charAt(0).toUpperCase()).join('/');
        });
        _monFire(playerName, roomName, 'MILITARY_CREEPS',
                 militaryCreeps.length + ' military creep(s) detected: ' +
                 summary.join(', '));
    }

    const boostedCreeps = hostileCreeps.filter(c =>
        c.body.some(p => p.boost)
    );
    s.hasBoosted = boostedCreeps.length > 0;

    if (!first && !prev.hasBoosted && s.hasBoosted) {
        const boostSet = new Set();
        for (const c of boostedCreeps) {
            for (const p of c.body) {
                if (p.boost) boostSet.add(p.boost);
            }
        }
        _monFire(playerName, roomName, 'BOOSTED_CREEPS',
                 boostedCreeps.length + ' boosted creep(s). Boosts: ' +
                 Array.from(boostSet).join(', '));
    }

    if (!first && prev.hasCreeps && !s.hasCreeps) {
        const spawns = _hostileByType[STRUCTURE_SPAWN] || [];
        const anySpawning = spawns.some(sp => sp.spawning);
        if (!anySpawning) {
            _monFire(playerName, roomName, 'NO_CREEPS',
                     'No creeps detected and no spawns active — room may be abandoned or under attack');
        }
    }

    // ── Spawns & extensions ─────────────────────────────────────
    const spawnExtensions = (_hostileByType[STRUCTURE_SPAWN] || [])
        .concat(_hostileByType[STRUCTURE_EXTENSION] || []);

    if (spawnExtensions.length > 0) {
        const totalEnergy = spawnExtensions.reduce((sum, st) => {
            return sum + (st.store ? st.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0);
        }, 0);
        s.spawnsDrained = totalEnergy === 0;

        // Only store the exact figure if remoteSupplyManager watches this room.
        if (_isRemoteSupplyRoom(roomName)) {
            s.spawnExtEnergy = totalEnergy;
        }
    } else {
        s.spawnsDrained = true;
        if (_isRemoteSupplyRoom(roomName)) {
            s.spawnExtEnergy = 0;
        }
    }

    if (!first && s.spawnsDrained && !prev.spawnsDrained) {
        _monFire(playerName, roomName, 'SPAWNS_DRAINED',
                 'All spawns and extensions have 0 energy');
    }

    // ── Storage energy (remoteSupply rooms only) ─────────────────
    if (_isRemoteSupplyRoom(roomName)) {
        const storages = _hostileByType[STRUCTURE_STORAGE] || [];
        s.storageEnergy = (storages.length > 0 && storages[0].store)
            ? (storages[0].store.getUsedCapacity(RESOURCE_ENERGY) || 0)
            : 0;
    }

    // ── Power spawn (ENEMY/WAR only) ─────────────────────────────
    if (status === STATUS.ENEMY || status === STATUS.WAR) {
        const powerSpawns = _hostileByType[STRUCTURE_POWER_SPAWN] || [];

        if (powerSpawns.length > 0) {
            const ps = powerSpawns[0];
            s.hasPower = (ps.store ? (ps.store.getUsedCapacity(RESOURCE_POWER) || 0) : 0) > 0;
        } else {
            s.hasPower = false;
        }

        if (!first && s.hasPower && !prev.hasPower) {
            _monFire(playerName, roomName, 'POWER_DETECTED',
                     'Power loaded into power spawn');
        }
    }

    // ── Terminal ghodium (WAR only) ──────────────────────────────
    if (status === STATUS.WAR) {
        const terminals = _hostileByType[STRUCTURE_TERMINAL] || [];

        if (terminals.length > 0) {
            const gAmt = terminals[0].store.getUsedCapacity(RESOURCE_GHODIUM) || 0;
            s.terminalHasG = gAmt > 0;
        } else {
            s.terminalHasG = false;
        }

        if (!first && !prev.terminalHasG && s.terminalHasG) {
            _monFire(playerName, roomName, 'TERMINAL_G',
                     'Ghodium detected in terminal — possible nuke preparation');
        }
    }

    // ── Towers ──────────────────────────────────────────────────
    const towers = _hostileByType[STRUCTURE_TOWER] || [];

    if (towers.length > 0) {
        s.towersLow = towers.every(t => {
            return (t.store ? (t.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0) < 10;
        });
    } else {
        s.towersLow = false;
    }

    if (!first && s.towersLow && !prev.towersLow) {
        _monFire(playerName, roomName, 'TOWERS_EMPTY',
                 'All ' + towers.length + ' tower(s) have less than 10 energy');
    }

    s.t = Game.time;
    return s;
}

/** Deep-analyze a visible room if its owner has a monitor status. */
function _monAnalyzeIfTracked(room, owner) {
    const mem = _monMem();
    const pd = mem.players[owner];
    if (!pd) return;
    const prev = mem.state[room.name] || {};
    mem.state[room.name] = analyzeRoom(room, owner, prev, pd.status || STATUS.ENEMY);
    delete mem.awaiting[room.name];
}

/** Submit hot-poll observation requests for statused players' rooms. */
function _monSubmitPolls() {
    const mem = _monMem();
    if (mem.paused) return;
    if (Game.time % 5 !== 0) return;       // checking every 5 ticks is plenty (WAR interval is 100)
    const reg = _regMem();
    for (const playerName in mem.players) {
        const pd = mem.players[playerName];
        const status = pd.status || STATUS.ENEMY;
        const interval = POLL_INTERVAL[status] || 1000;
        const pri = status === STATUS.WAR ? OBS_PRI.WAR : OBS_PRI.MONITOR;
        for (const rn in reg.rooms) {
            if (reg.rooms[rn].o !== playerName) continue;
            const st = mem.state[rn];
            const last = (st && st.t) || 0;
            if (Game.time - last < interval) continue;
            if (mem.awaiting[rn] && Game.time - mem.awaiting[rn] < 50) continue;
            if (obsRequest(rn, 'monitor', pri)) mem.awaiting[rn] = Game.time;
        }
    }
    for (const rn in mem.awaiting)
        if (Game.time - mem.awaiting[rn] >= MON_AWAIT_TIMEOUT) delete mem.awaiting[rn];
}

/** Read phase — analyze hot-polled rooms that became visible. Runs in _schedTick. */
function _monReadAwaiting() {
    const mem = _monMem();
    for (const rn in mem.awaiting) {
        const room = Game.rooms[rn];
        if (room) { _regRecord(rn, room); delete mem.awaiting[rn]; }
    }
}

// ── Monitor: console commands ─────────────────────────────────────────────
function _monSeedRooms(playerName, roomsArr) {
    const reg = _regMem();
    let added = 0;
    for (const rn of roomsArr) {
        if (typeof rn !== 'string' || !parseRoomCoords(rn)) continue;
        if (!reg.rooms[rn]) { reg.rooms[rn] = { o: playerName, l: 0, t: 0 }; added++; }
    }
    if (added) console.log('[Monitor] Seeded ' + added + ' room(s) for ' + playerName + ' into the registry.');
    return added;
}

function monitor(playerName, statusOrRooms, rooms) {
    if (!playerName || typeof playerName !== 'string') {
        console.log('[Monitor] Usage: monitor("PlayerName", "STATUS") or monitor("PlayerName", "STATUS", ["room1","room2"])');
        console.log('[Monitor] Valid statuses: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }
    const mem = _monMem();

    let status = STATUS.ENEMY;
    let roomList = null;
    if (typeof statusOrRooms === 'string' && STATUS[statusOrRooms.toUpperCase()]) {
        status = statusOrRooms.toUpperCase();
        if (rooms && Array.isArray(rooms) && rooms.length > 0) roomList = rooms;
    } else if (Array.isArray(statusOrRooms) && statusOrRooms.length > 0) {
        roomList = statusOrRooms;
    } else if (typeof statusOrRooms === 'string') {
        console.log('[Monitor] Unknown status: "' + statusOrRooms + '". Valid: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }

    const old = mem.players[playerName] ? mem.players[playerName].status : null;
    mem.players[playerName] = { status };
    if (roomList) _monSeedRooms(playerName, roomList);

    const known = _regRoomsOf(playerName);
    console.log('[Monitor] ' + playerName + ': ' + (old && old !== status ? old + ' → ' : '') + status +
                ' (poll: ' + POLL_INTERVAL[status] + 't). Registry knows ' + known.length + ' room(s)' +
                (known.length ? ': ' + known.join(', ') : '') + '.');

    const reg = _regMem();
    if (!known.length && !_regFresh() && !(reg.sweep && reg.sweep.active)) {
        _regStartSweep();
        console.log('[Monitor] Registry stale/empty — sweep started; rooms will appear as it completes.');
    }
}

function monitorAdd(playerName, statusOrRooms, roomsArg) {
    if (!playerName) {
        console.log('[Monitor] Usage: monitorAdd("PlayerName", "STATUS", ["room1","room2"])  // canonical');
        console.log('[Monitor]    or: monitorAdd("PlayerName", ["room1","room2"], "STATUS")  // legacy');
        return;
    }
    let status = null, roomsArr = null;
    if (typeof statusOrRooms === 'string') {
        status = statusOrRooms;
        if (Array.isArray(roomsArg)) roomsArr = roomsArg;
    } else if (Array.isArray(statusOrRooms)) {
        roomsArr = statusOrRooms;
        if (typeof roomsArg === 'string') status = roomsArg;
    }
    if (!roomsArr || roomsArr.length === 0) {
        console.log('[Monitor] Usage: monitorAdd("PlayerName", "STATUS", ["room1","room2"])');
        return;
    }
    const mem = _monMem();
    const upper = status && STATUS[status.toUpperCase()] ? status.toUpperCase() : null;
    if (!mem.players[playerName]) {
        mem.players[playerName] = { status: upper || STATUS.ENEMY };
    } else if (upper) {
        mem.players[playerName].status = upper;
    }
    _monSeedRooms(playerName, roomsArr);
    const playerStatus = mem.players[playerName].status;
    console.log('[Monitor] ' + playerName + ' [' + playerStatus + ']: ' + _regRoomsOf(playerName).length +
                ' room(s) tracked (poll: ' + POLL_INTERVAL[playerStatus] + ' ticks).');
}

function monitorRemove(playerName) {
    const mem = _monMem();
    if (!mem.players[playerName]) {
        console.log('[Monitor] ' + playerName + ' has no monitor status.');
        return;
    }
    for (const rn of _regRoomsOf(playerName)) { delete mem.state[rn]; delete mem.awaiting[rn]; }
    delete mem.players[playerName];
    console.log('[Monitor] Removed monitor status for ' + playerName + '. (The registry keeps tracking their rooms silently; no alerts will fire.)');
}

function monitorSetStatus(playerName, newStatus) {
    if (!playerName || !newStatus) {
        console.log('[Monitor] Usage: monitorSetStatus("PlayerName", "STATUS")');
        console.log('[Monitor] Valid statuses: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }
    const upper = newStatus.toUpperCase();
    if (!STATUS[upper]) {
        console.log('[Monitor] Unknown status: "' + newStatus + '". Valid: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }
    const mem = _monMem();
    if (!mem.players[playerName]) {
        console.log('[Monitor] ' + playerName + ' is not being monitored. Use monitor("' + playerName + '", "' + upper + '").');
        return;
    }
    const oldStatus = mem.players[playerName].status || STATUS.ENEMY;
    mem.players[playerName].status = upper;
    const alerts = ALERT_FILTER[upper] ? ALERT_FILTER[upper].length + ' alert types' : 'all alert types';
    console.log('[Monitor] ' + playerName + ': ' + oldStatus + ' → ' + upper +
                ' (poll: ' + POLL_INTERVAL[upper] + ' ticks, tracking ' + alerts + ')');
}

function monitorStatus() {
    const mem = _monMem();
    const reg = _regMem();
    const players = Object.keys(mem.players);

    console.log('════════════════════ PLAYER MONITOR STATUS ════════════════════');
    console.log('  Paused: ' + (mem.paused ? 'YES' : 'no'));
    if (reg.sweep && reg.sweep.active)
        console.log('  Registry sweep: ACTIVE (' + reg.sweep.scanned + '/' + reg.sweep.total + ')');
    else
        console.log('  Registry: ' + Object.keys(reg.rooms).length + ' owned room(s) | last sweep ' +
                    (reg.lastSweepEnd ? (Game.time - reg.lastSweepEnd) + 't ago' : 'never') +
                    ' | next auto-sweep in ' + Math.max(0, (reg.interval || REG_SWEEP_INTERVAL) - (Game.time - Math.max(reg.lastSweepEnd, reg.lastSweepStart))) + 't');
    const awaiting = Object.keys(mem.awaiting).length;
    if (awaiting) console.log('  Awaiting observation: ' + awaiting + ' room(s)');

    if (players.length === 0) {
        console.log('  No players have a monitor status. (The registry still tracks all rooms — registryList().)');
        console.log('════════════════════════════════════════════════════════════════');
        return;
    }
    console.log('');
    for (const playerName of players) {
        const pd = mem.players[playerName];
        const status = pd.status || STATUS.ENEMY;
        const interval = POLL_INTERVAL[status] || 1000;
        const playerRooms = _regRoomsOf(playerName);
        console.log('  ' + playerName + ' [' + status + '] (poll: ' + interval + ' ticks):');
        console.log('    Rooms (' + playerRooms.length + '): ' + (playerRooms.join(', ') || 'none in registry yet'));
        const stale = [];
        for (const rn of playerRooms) {
            const st = mem.state[rn];
            const age = st && st.t ? Game.time - st.t : null;
            if (age === null) stale.push(rn + ' (never)');
            else if (age > interval * 3) stale.push(rn + ' (' + age + 't ago)');
        }
        if (stale.length) console.log('    Stale scans: ' + stale.join(', '));
    }
    console.log('════════════════════════════════════════════════════════════════');
}

function monitorPause() {
    _monMem().paused = true;
    console.log('[Monitor] Alerts and hot-polling paused. (Registry sweeps continue — they serve more than the monitor.)');
}
function monitorResume() {
    _monMem().paused = false;
    console.log('[Monitor] Resumed.');
}


// ════════════════════════════════════════════════════════════════════════════
// MAIN LOOP PROCESSOR
// Call scanner.run() every tick from main.js — no modulo needed.
// Tick order:
//   1. _schedTick      reads sweep/hot-poll results, dispatches queued
//                      observation requests by priority (shared booking)
//   2. module ticks    one-shots auto-complete; multi-tick scans advance
//                      one room each using leftover observers
//   3. _regSweepFill   registry sweep soaks up any observer still idle
// ════════════════════════════════════════════════════════════════════════════

function run() {
    _schedTick();

    _processMaintPending();
    _itProcessProfiles();
    _enProcessProfiles();
    _processPendingIntel();
    _processPendingNukeAnalyze();
    _paRun();
    _weRun();

    _regSweepFill();

    if (Game.time % 100 === 0) { _itCleanExpired(); _enCleanExpired(); }
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORTS & GLOBALS
// All console commands are set as globals at require() time.
// No global assignments needed in main.js.
// ════════════════════════════════════════════════════════════════════════════

const scanner = {
    run,

    // Observer scheduler — external modules (e.g. depositObserver) use this
    observe: {
        request: obsRequest,
        cancel: obsCancel,
        inRange: obsInRange,
        PRI: OBS_PRI,
    },

    // Room registry
    registry: {
        sweep: registrySweep,
        status: registryStatus,
        player: registryPlayer,
        list: registryList,
        roomsOf: _regRoomsOf,
        fresh: _regFresh,
        startSweep: _regStartSweep,
        record: _regRecord,
    },

    // Player monitor
    monitor: {
        set: monitor,
        add: monitorAdd,
        remove: monitorRemove,
        setStatus: monitorSetStatus,
        status: monitorStatus,
        pause: monitorPause,
        resume: monitorResume,
        analyzeRoom: analyzeRoom,
    },

    // Sub-namespaces for programmatic use
    maint: {
        scan: maintScan,
        print: maintPrint,
        scanRoom: maintScanRoom,
        processPending: _processMaintPending,
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
        findObservers: findObserversInRange,
    },
    energy: {
        start:           energyStart,
        cancel:          energyCancel,
        status:          energyStatus,
        run:             energyRun,
        processProfiles: _enProcessProfiles,
        getCached:       _enGetCached,
        cleanExpired:    _enCleanExpired,
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
        processPending: _processPendingNukeAnalyze,
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
    },
    wide: {
        start: startWideScan,
        startPlayers: startWideScanPlayers,
        run: _wsRun,
        cancel: cancelWideScan,
        status: getWideScanStatus,
        report: _wsReport,
    },
    war: {
        start: startWarEstimate,
        run: _weRun,
        cancel: cancelWarEstimate,
        status: getWarEstimateStatus,
        last: getLastWarEstimate,
        compute: computeWarEstimate,
        gatherRoomData: gatherRoomWarData,
        gatherSnapshot: gatherSnapshot,
    },

    // Shared utilities (for other modules that may depend on these)
    utils: {
        parseRoomCoords,
        toRoomName,
        roomsInRange,
        getRoomDistance,
        canNuke,
        isClaimableRoom,
        getObserverMap,
        findObserverInRange,
        findObserversInRange,
        findObserverForRoom,
        findAllObserversForRoom,
        tryObserveRoom,
        tryPowerObserver,
        getMarketBuyPrice,
        getMarketHistoryPrice,
        fmtNum, fmtCr, fmtE, r1, r2, r3, yn, clamp,
    },
};

module.exports = scanner;

// ── Globals — set at require() time, available in the Screeps console ─────
global.maintScan       = () => maintPrint();
global.maintScanRoom   = (r) => maintScanRoom(r);

global.intel           = intel;
global.intelFast       = intelFast;
global.listIntel       = listIntel;
global.getCachedIntel  = getCachedIntel;

global.nukeAnalyze     = nukeAnalyze;
global.nukeAnalyzeSelf = nukeAnalyzeSelf;
global.nukeAnalyzeCost = nukeAnalyzeCost;
global.nukeIncoming    = nukeIncoming;
global.nukeThreat      = nukeThreat;
global.nukeThreatStatus= nukeThreatStatus;
global.nukeThreatCancel= nukeThreatCancel;

global.player          = startPlayerAnalysis;
global.playerCancel    = cancelPlayerAnalysis;
global.playerStatus    = getPlayerAnalysisStatus;
global.playerLast      = getLastPlayerAnalysis;
global.playerScan      = startPlayerScan;
global.playerScanStatus= getPlayerScanStatus;
global.playerScanCancel= cancelPlayerScan;

global.wideScan        = startWideScan;
global.wideScanPlayers = startWideScanPlayers;
global.wideScanCancel  = cancelWideScan;
global.wideScanStatus  = getWideScanStatus;

global.warEstimate     = startWarEstimate;
global.warEstimateCancel = cancelWarEstimate;
global.warEstimateStatus = getWarEstimateStatus;
global.warEstimateLast = getLastWarEstimate;

global.registrySweep   = registrySweep;
global.registryStatus  = registryStatus;
global.registryPlayer  = registryPlayer;
global.registryList    = registryList;

global.monitor            = monitor;
global.monitorAdd         = monitorAdd;
global.monitorRemove      = monitorRemove;
global.monitorSetStatus   = monitorSetStatus;
global.monitorStatus      = monitorStatus;
global.monitorPause       = monitorPause;
global.monitorResume      = monitorResume;
global.monitorUpdateRooms = monitorAdd;   // legacy alias (room lists are now registry seeds)

global.profileEnergy        = energyStart;
global.cancelEnergyProfile  = energyCancel;
global.energyProfileStatus  = energyStatus;