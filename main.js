
// === PROFILER INTEGRATION ===
const profiler = require('screeps-profiler');

// Enable profiling - you can toggle this on/off
profiler.enable();

// === LAB SYSTEM TOGGLE ===
const LAB_LOGGING_ENABLED = false;
global.LAB_LOGGING_ENABLED = LAB_LOGGING_ENABLED;

// === CPU USAGE LOGGING TOGGLE VARIABLES ===
const ENABLE_CPU_LOGGING = false;
const DISABLE_CPU_CONSOLE = true;

// --- ROLE & UTILITY IMPORTS ---
require('marketQuery');
require('marketAnalysis');
require('roomObserver');
require('maintenanceScanner');
const roleHarvester = require('roleHarvester');
const roleUpgrader = require('roleUpgrader');
const roleBuilder = require('roleBuilder');
const roleScout = require('roleScout');
const roleDefender = require('roleDefender');
const roleSupplier = require('roleSupplier');
const roleClaimbot = require('roleClaimbot');
// const roleRemoteHarvester = require('roleRemoteHarvesters'); // disabled per request
const roleAttacker = require('roleAttacker');
const roleExtractor = require('roleExtractor');
const iff = require('iff');
const roleScavenger = require('roleScavenger');
const roleThief = require('roleThief');
const squad = require('squadModule');
const roleTowerDrain = require('roleTowerDrain');
const roleDemolition = require('roleDemolition');
const roleMineralCollector = require('roleMineralCollector');
const terminalManager = require('terminalManager');
const roleSignbot = require('roleSignbot');
const factoryManager = require('factoryManager');
const roleFactoryBot = require('roleFactoryBot');
const roleWallRepair = require('roleWallRepair');
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
const roleNukeFill = require('roleNukeFill');
const nukeUtils = require('nukeUtils');
const nukeLaunch = require('nukeLaunch'); // provides launchNuke(...) and run()

// === GLOBAL MODULE EXPOSURE FOR CONSOLE ACCESS ===
global.opportunisticBuy = opportunisticBuy;
global.nukeFill = roleNukeFill.order;
global.nukeInRange = nukeUtils.nukeInRange;
// Expose the console command: launchNuke('DonorRoom', 'RecipientRoom', 'structureType')
global.launchNuke = nukeLaunch.launchNuke;

// Centralized spawn manager
const spawnManager = require('spawnManager');

// Register modules with profiler
profiler.registerObject(roleHarvester, 'roleHarvester');
profiler.registerObject(roleUpgrader, 'roleUpgrader');
profiler.registerObject(roleBuilder, 'roleBuilder');
profiler.registerObject(roleScout, 'roleScout');
profiler.registerObject(roleDefender, 'roleDefender');
profiler.registerObject(roleSupplier, 'roleSupplier');
profiler.registerObject(roleClaimbot, 'roleClaimbot');
// profiler.registerObject(roleRemoteHarvester, 'roleRemoteHarvester'); // disabled
profiler.registerObject(roleAttacker, 'roleAttacker');
profiler.registerObject(roleExtractor, 'roleExtractor');
profiler.registerObject(iff, 'iff');
profiler.registerObject(roleScavenger, 'roleScavenger');
profiler.registerObject(roleThief, 'roleThief');
profiler.registerObject(squad, 'squad');
profiler.registerObject(roleTowerDrain, 'roleTowerDrain');
profiler.registerObject(roleDemolition, 'roleDemolition');
profiler.registerObject(roleMineralCollector, 'roleMineralCollector');
profiler.registerObject(roleSignbot, 'roleSignbot');
profiler.registerObject(factoryManager, 'factoryManager');
profiler.registerObject(roleFactoryBot, 'roleFactoryBot');
profiler.registerObject(roleWallRepair, 'roleWallRepair');
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
profiler.registerObject(roleNukeFill, 'roleNukeFill');
profiler.registerObject(nukeUtils, 'nukeUtils');
// Profiler registration for nukeLaunch
profiler.registerObject(nukeLaunch, 'nukeLaunch');

// =================================================================
/* === CREEP MANAGEMENT ============================================ */
// =================================================================

function runCreeps() {
  // Clean up memory first
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
    }
  }

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.spawning) continue;

    const role = creep.memory.role;
    let cpuBefore, cpuAfter;
    if (ENABLE_CPU_LOGGING) cpuBefore = Game.cpu.getUsed();

    switch (role) {
      case 'harvester':      roleHarvester.run(creep);       break;
      case 'upgrader':       roleUpgrader.run(creep);        break;
      case 'builder':        roleBuilder.run(creep);         break;
      case 'scout':          roleScout.run(creep);           break;
      case 'defender':       roleDefender.run(creep);        break;
      case 'supplier':       roleSupplier.run(creep);        break;
      case 'claimbot':       roleClaimbot.run(creep);        break;
      // case 'remoteHarvester':roleRemoteHarvester.run(creep); break; // disabled
      case 'attacker':       roleAttacker.run(creep);        break;
      case 'extractor':      roleExtractor.run(creep);       break;
      case 'scavenger':      roleScavenger.run(creep);       break;
      case 'thief':          roleThief.run(creep);           break;
      case 'towerDrain':     roleTowerDrain.run(creep);      break;
      case 'demolition':     roleDemolition.run(creep);      break;
      case 'squadMember':    squad.run(creep);               break;
      case 'mineralCollector': roleMineralCollector.run(creep); break;
      case 'terminalBot':    terminalManager.runTerminalBot(creep); break;
      case 'signbot':        roleSignbot.run(creep);         break;
      case 'factoryBot':     roleFactoryBot.run(creep);      break;
      case 'wallRepair':     roleWallRepair.run(creep);      break;
      case 'labBot':         roleLabBot.run(creep);          break;
      case 'nukeFill':      roleNukeFill.run(creep);         break;
      default:
        creep.memory.role = 'harvester';
        roleHarvester.run(creep);
        break;
    }

    if (ENABLE_CPU_LOGGING) {
      cpuAfter = Game.cpu.getUsed();
      if (!Memory.cpuProfileCreeps) Memory.cpuProfileCreeps = {};
      if (!Memory.cpuProfileCreeps[role]) Memory.cpuProfileCreeps[role] = [];
      Memory.cpuProfileCreeps[role].push(cpuAfter - cpuBefore);
      if (Memory.cpuProfileCreeps[role].length > 50) {
        Memory.cpuProfileCreeps[role].shift();
      }
    }
  }

  if (Game.time % 50 === 0 && ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
    for (const role in Memory.cpuProfileCreeps) {
      const arr = Memory.cpuProfileCreeps[role];
      const avg = arr.reduce(function(a, b){ return a + b; }, 0) / arr.length;
      console.log("Creep Role CPU: " + role + " avg: " + Math.round(avg));
    }
  }
}

// =================================================================
/* === HELPER & UTILITY FUNCTIONS (non-spawn) ====================== */
// =================================================================

function cleanMemory() {
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      const creepMemory = Memory.creeps[name];

      if (creepMemory.role === 'thief') {
        if (Memory.thiefOrders) {
          const orderIndex = Memory.thiefOrders.findIndex(function(o){
            return o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom;
          });
          if (orderIndex > -1) {
            console.log("[Thief] A thief for operation against " + creepMemory.targetRoom + " has died. Cancelling the operation.");
            Memory.thiefOrders.splice(orderIndex, 1);
          }
        }
      }

      if (creepMemory.role === 'demolition') {
        if (Memory.demolitionOrders) {
          const orderIndex = Memory.demolitionOrders.findIndex(function(o){
            return o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom;
          });
          if (orderIndex > -1 && creepMemory.demolitionRole === 'demolisher') {
            console.log("[Demolition] A demolisher for operation against " + creepMemory.targetRoom + " has died. Keeping operation active for respawn.");
          }
        }
      }

      if (creepMemory.role === 'towerDrain') {
        if (Memory.towerDrainOrders) {
          const orderIndex = Memory.towerDrainOrders.findIndex(function(o){
            return o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom;
          });
          if (orderIndex > -1) {
            console.log("[TowerDrain] A tower drain bot for " + creepMemory.targetRoom + " has died. Keeping operation active.");
          }
        }
      }

      if (creepMemory.role === 'squadMember') {
        if (Memory.squadPackingAreas && creepMemory.squadId) {
          const remainingMembers = _.filter(Game.creeps, function(c){
            return c.memory.role === 'squadMember' && c.memory.squadId === creepMemory.squadId;
          });
          if (remainingMembers.length <= 1) {
            delete Memory.squadPackingAreas[creepMemory.squadId];
            console.log("[Squad] Squad " + creepMemory.squadId + " eliminated. Cleaning up packing area.");
          }
        }
      }

      delete Memory.creeps[name];
    }
  }
}

function getPerRoomRoleCounts() {
  const perRoomCounts = {};
  for(const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if(room.controller && room.controller.my) {
      perRoomCounts[roomName] = {
        harvester: 0, upgrader: 0, builder: 0, scout: 0, defender: 0, supplier: 0,
        claimbot: 0, attacker: 0, scavenger: 0, thief: 0, squadMember: 0, towerDrain: 0, demolition: 0, wallRepair: 0
      };
    }
  }
  for(const name in Game.creeps) {
    const creep = Game.creeps[name];
    const role = creep.memory.role;
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
    if(perRoomCounts[assignedRoom] && perRoomCounts[assignedRoom][role] !== undefined) {
      perRoomCounts[assignedRoom][role]++;
    }
  }
  return perRoomCounts;
}

function cacheRoomData() {
  if(!Memory.roomData) Memory.roomData = {};
  const cache = {};
  for(const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if(!room.controller || !room.controller.my) continue;

    var rs = getRoomState.get(roomName);

    const shouldUpdate = !Memory.roomData[roomName] || Game.time % 100 === 0;
    if(shouldUpdate) {
      if(!Memory.roomData[roomName]) Memory.roomData[roomName] = {};
      const roomMemory = Memory.roomData[roomName];

      var sources = (rs && rs.sources) ? rs.sources : room.find(FIND_SOURCES);
      roomMemory.sources = sources.map(function(s){ return s.id; });

      var constructionSitesCount = (rs && rs.constructionSites) ? rs.constructionSites.length : room.find(FIND_CONSTRUCTION_SITES).length;
      roomMemory.constructionSitesCount = constructionSitesCount;

      roomMemory.energyCapacity = room.energyCapacityAvailable;
      roomMemory.energyAvailable = room.energyAvailable;

      var spawns = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) ? rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; }) : room.find(FIND_MY_SPAWNS);
      roomMemory.spawnIds = spawns.map(function(s){ return s.id; });

      var extensions = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_EXTENSION]) ? rs.structuresByType[STRUCTURE_EXTENSION].filter(function(s){ return s.my; }) : room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_EXTENSION } });
      roomMemory.extensionIds = extensions.map(function(s){ return s.id; });

      const storage = rs ? rs.storage : room.storage;
      roomMemory.storageId = storage ? storage.id : null;

      var containers = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) ? rs.structuresByType[STRUCTURE_CONTAINER] : room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; } });
      roomMemory.containerIds = containers.map(function(s){ return s.id; });
    }
    cache[roomName] = Memory.roomData[roomName];
  }
  return cache;
}

// =================================================================
/* === STATUS & TRACKING FUNCTIONS ================================= */
// =================================================================

function displayStatus(perRoomRoleCounts) {
  const GCL_WINDOW   = 5000;
  const GCL_INTERVAL = 50;
  const TICK_WINDOW  = 500;
  let gclEta = null;

  if (!Memory.gclTracker) Memory.gclTracker = { history: [] };

  if (Game.time % GCL_INTERVAL === 0) {
    const currentPercent = Game.gcl.progress / Game.gcl.progressTotal * 100;
    Memory.gclTracker.history.push({ tick: Game.time, percent: currentPercent });

    while (Memory.gclTracker.history.length > 0 && Memory.gclTracker.history[0].tick < Game.time - GCL_WINDOW) {
      Memory.gclTracker.history.shift();
    }

    if (Memory.gclTracker.history.length > 1) {
      const hist = Memory.gclTracker.history;
      const oldest  = hist[0];
      const newest  = hist[hist.length - 1];
      const dt      = newest.tick - oldest.tick;
      const dPerc   = newest.percent - oldest.percent;
      let etaString = '';

      if (dPerc > 0) {
        const rate      = dPerc / dt;
        const remaining = 100 - newest.percent;
        const etaTicks  = Math.ceil(remaining / rate);
        const totalSec  = etaTicks * 4;

        const days    = Math.floor(totalSec / 86400);
        const hours   = Math.floor((totalSec % 86400) / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);

        gclEta = { days: days, hours: hours, minutes: minutes };
        etaString = " | ETA: " + etaTicks + " ticks (~" + days + "d " + hours + "h " + minutes + "m)";
      } else {
        etaString = ' | ETA: ∞ (no progress)';
      }

      console.log(
        "Global Control Level: " + Game.gcl.level +
        " - Progress: " + newest.percent.toFixed(2) + "%" + etaString
      );
    } else {
      console.log(
        "Global Control Level: " + Game.gcl.level +
        " - Progress: " + currentPercent.toFixed(2) + "%"
      );
    }
  }

  const perRoomStats = {};
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;

    if (!perRoomStats[assignedRoom]) {
      perRoomStats[assignedRoom] = {
        totalBodyParts: 0,
        totalCreeps:    0,
        totalTTL:       0,
        oldestCreepTTL: Infinity
      };
    }

    const stats = perRoomStats[assignedRoom];
    stats.totalBodyParts += creep.body.length;
    stats.totalCreeps++;
    if (creep.ticksToLive) {
      stats.totalTTL += creep.ticksToLive;
      if (creep.ticksToLive < stats.oldestCreepTTL) {
        stats.oldestCreepTTL = creep.ticksToLive;
      }
    }
  }

  console.log("=== COLONY STATUS ===");
  for (const roomName in perRoomRoleCounts) {
    const counts = perRoomRoleCounts[roomName];
    const stats  = perRoomStats[roomName] || { totalBodyParts: 0, totalCreeps: 0, totalTTL: 0, oldestCreepTTL: 0 };

    const avgBodyParts = stats.totalCreeps > 0 ? (stats.totalBodyParts / stats.totalCreeps).toFixed(1) : 0;
    const avgTTL = stats.totalCreeps > 0 ? Math.round(stats.totalTTL / stats.totalCreeps) : 0;

    const roomObj = Game.rooms[roomName];
    let storageEnergy = 0;
    if (roomObj && roomObj.storage && roomObj.storage.store) {
      storageEnergy = roomObj.storage.store[RESOURCE_ENERGY] || 0;
    }

    console.log(
      roomName + ": 🧑‍🌾" + counts.harvester +
      " ⚡" + counts.upgrader +
      " 🔨" + counts.builder +
      " 🔭" + counts.scout +
      " 🛡" + counts.defender +
      " ⚔️" + counts.attacker +
      " 🦹" + counts.thief +
      " 🔋" + counts.supplier +
      " 🚀" + counts.squadMember +
      " | Avg Parts: " + avgBodyParts +
      " | Avg TTL: " + avgTTL +
      " | Storage: " + storageEnergy
    );
  }

  const perfData      = getPerformanceData();
  const currentEnergy = calculateTotalEnergy();

  if (!Memory.stats) Memory.stats = {};
  var prevEnergy = (typeof Memory.stats.lastTotalEnergy === 'number') ? Memory.stats.lastTotalEnergy : null;
  var deltaStr = '';
  if (prevEnergy !== null) {
    var delta = currentEnergy - prevEnergy;
    deltaStr = ' (' + (delta >= 0 ? '+' : '') + delta + ')';
  }
  Memory.stats.lastTotalEnergy = currentEnergy;

  if (!ENABLE_CPU_LOGGING || !DISABLE_CPU_CONSOLE) {
    const bucketPercent = Math.round((Game.cpu.bucket / 10000) * 100);
    const bucketStatus = Game.cpu.bucket >= 10000 ? '(FULL)' : '(' + bucketPercent + '%)';

    console.log(
      "🖥️ CPU: " + Math.round(perfData.cpuUsed) + "/" + perfData.cpuLimit +
      " (" + Math.round(perfData.cpuPercent) + "%) | Avg: " + Math.round(perfData.cpuAverage) +
      " | Bucket: " + Game.cpu.bucket + "/10000 " + bucketStatus +
      " | Tick Limit: " + Game.cpu.tickLimit
    );
  }

  if (!Memory.progressTracker) Memory.progressTracker = {};

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    const percent       = room.controller.progress / room.controller.progressTotal * 100;
    const energyPercent = room.energyAvailable / room.energyCapacityAvailable * 100;

    if (!Memory.progressTracker[roomName]) {
      Memory.progressTracker[roomName] = { level: room.controller.level, history: [] };
    }

    const tracker = Memory.progressTracker[roomName];
    if (tracker.level !== room.controller.level) {
      tracker.level   = room.controller.level;
      tracker.history = [{ tick: Game.time, percent: percent }];
    }

    tracker.history.push({ tick: Game.time, percent: percent });
    while (tracker.history.length > 0 && tracker.history[0].tick < Game.time - 500) {
      tracker.history.shift();
    }

    let etaString = '';
    if (tracker.history.length > 1) {
      const hist         = tracker.history;
      const oldest       = hist[0];
      const newest       = hist[hist.length - 1];
      const tickDelta    = newest.tick - oldest.tick;
      const percentDelta = newest.percent - oldest.percent;

      if (tickDelta >= 500 && percentDelta > 0) {
        const percentRemaining = 100 - newest.percent;
        const rate             = percentDelta / tickDelta;
        const etaTicks         = Math.ceil(percentRemaining / rate);
        const etaMinutes       = etaTicks * 4 / 60;
        etaString = " | ETA: " + etaTicks + " ticks (~" + formatTime(etaMinutes) + ")";
      }
      else if (tickDelta >= 500) {
        etaString = ' | ETA: ∞ (no progress)';
      }
    }

    console.log(
      "Room " + roomName + ": RCL " + room.controller.level +
      " - Progress: " + percent.toFixed(1) + "%" +
      " | Energy: " + room.energyAvailable + "/" + room.energyCapacityAvailable +
      " (" + energyPercent.toFixed(1) + "%)" + etaString
    );
  }

  if (Memory.exploration && Memory.exploration.rooms) {
    console.log("Explored rooms: " + Object.keys(Memory.exploration.rooms).length);
    console.log('==============================================================');
  }

  return gclEta;
}

function calculateTotalEnergy() {
  let totalEnergy = 0;
  if (!Memory.roomData) return 0;

  for (const roomName in Memory.roomData) {
    const roomCache = Memory.roomData[roomName];
    if (!roomCache) continue;
    const allIds = []
      .concat(roomCache.spawnIds || [])
      .concat(roomCache.extensionIds || [])
      .concat(roomCache.containerIds || []);
    if (roomCache.storageId) allIds.push(roomCache.storageId);

    totalEnergy += allIds.reduce(function(sum, id){
      const structure = Game.getObjectById(id);
      if (structure && structure.store) {
        return sum + structure.store.getUsedCapacity(RESOURCE_ENERGY);
      }
      return sum;
    }, 0);
  }
  return totalEnergy;
}

function getPerformanceData() {
  const cpuUsed    = Game.cpu.getUsed();
  const cpuAverage = (Memory.cpuStats && Memory.cpuStats.average) ? Memory.cpuStats.average : 0;
  const cpuLimit   = Game.cpu.limit;
  const cpuPercent = ((cpuUsed / cpuLimit) * 100).toFixed(1);

  return { cpuUsed: cpuUsed, cpuAverage: Math.round(cpuAverage), cpuPercent: cpuPercent, cpuLimit: cpuLimit };
}

function formatTime(totalMinutes) {
  const days    = Math.floor(totalMinutes / (24 * 60));
  const hours   = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = Math.floor(totalMinutes % 60);
  if (days > 0) {
    return hours > 0 ? (days + "d " + hours + "h " + minutes + "m") : (days + "d " + minutes + "m");
  } else if (hours > 0) {
    return hours + "h " + minutes + "m";
  } else {
    return minutes + "m";
  }
}

function trackCPUUsage() {
  if(!Memory.cpuStats) {
    Memory.cpuStats = { history: [], average: 0 };
  }
  const cpuUsed = Game.cpu.getUsed();
  Memory.cpuStats.history.push(cpuUsed);
  if(Memory.cpuStats.history.length > 50) Memory.cpuStats.history.shift();
  Memory.cpuStats.average = Memory.cpuStats.history.reduce(function(sum, cpu){ return sum + cpu; }, 0) / Memory.cpuStats.history.length;
}

// Initialize global orders with spawnManager helpers
globalOrders.init({
  getRoomState: getRoomState,
  iff: iff,
  squad: squad,
  getCreepBody: spawnManager.getCreepBody,
  bodyCost: spawnManager.bodyCost
});

// =================================================================
/* ========================= MAIN GAME LOOP ======================== */
// =================================================================

module.exports.loop = function() {
  profiler.wrap(function() {
    // --- GLOBAL CREEP CACHE BY ROLE (Problem #1 Fix) ---
    global.creepsByRole = {};
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (!creep.memory || !creep.memory.role) continue;

      const role = creep.memory.role;
      if (!global.creepsByRole[role]) {
        global.creepsByRole[role] = [];
      }
      global.creepsByRole[role].push(creep);
    }

    // Also cache by room and role for faster lookups
    global.creepsByRoomAndRole = {};
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (!creep.memory || !creep.memory.role) continue;

      const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
      const role = creep.memory.role;

      if (!global.creepsByRoomAndRole[assignedRoom]) {
        global.creepsByRoomAndRole[assignedRoom] = {};
      }
      if (!global.creepsByRoomAndRole[assignedRoom][role]) {
        global.creepsByRoomAndRole[assignedRoom][role] = [];
      }
      global.creepsByRoomAndRole[assignedRoom][role].push(creep);
    }

    // --- MEMORY & SYSTEM MANAGEMENT ---
    if (!Memory.stats) Memory.stats = {};
    if (Game.time % 5 === 0) roleScout.handleDeadCreeps();
    if (Game.time % 20 === 0)   cleanMemory();
    if (Game.time % 1000 === 0) cleanCpuProfileMemory();


    // --- BUILD PER-TICK ROOM STATE EARLY ---
    profileSection('getRoomState.init', function() { getRoomState.init(); });

    // --- CACHING & COUNTS ---
    const perRoomRoleCounts = getPerRoomRoleCounts();
    const roomDataCache     = cacheRoomData();

    // --- ROOM OBSERVER SCAN PROGRESSION ---
    if (Memory.roomObserverState && Memory.roomObserverState.active === true) {
      if (typeof roomObserverRun === 'function') {
        profileSection('roomObserverRun', function() { roomObserverRun(); });
      } else if (typeof scanRoomsStep === 'function') {
        profileSection('scanRoomsStep', function() { scanRoomsStep(); });
      } else if (Game.time % 50 === 0) {
        console.log('roomObserver: scan active but runner not found. Did you require("roomObserver")?');
      }
    }

    // --- STRUCTURES ---
    profileSection('towerManager.run', function(){ towerManager.run(); });
    if (Game.time % 3 === 0) profileSection('linkManager.run', function(){ linkManager.run(); });

    // --- MAINTENANCE & MANAGERS ---
    if (Game.time % 1000 === 0) {
      profileSection('roomBalance', function() { roomBalance.run(); });
    }

    profileSection('terminalManager', function(){ terminalManager.run(); });
    profileSection('mineralManager', function(){ mineralManager.run(); });
    profileSection('factoryManager', function(){ factoryManager.run(); });
    profileSection('marketUpdater', function(){ marketUpdater.run(); });
    profileSection('marketRefine.run', function(){ marketRefine.run(); });
    if (Game.time % 10 === 0) profileSection('opportunisticBuy', function(){ opportunisticBuy.process(); });

    // --- NUKE LAUNCH PIPELINE (runs every tick; observer vision is next-tick) ---
    profileSection('nukeLaunch.run', function(){ nukeLaunch.run(); });

    profileSection('labManager', function() {
      for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        labManager.run(roomName);
      }
    });

    // --- SPAWNING (centralized) ---
    if (Game.time % 10 === 0) {
      profileSection('spawnManager.run', function() {
        spawnManager.run(perRoomRoleCounts, roomDataCache);
      });
    }

    // --- CREEP ACTIONS ---
    profileSection('runCreeps', runCreeps);

    // --- TRACKING & VISUALS ---
    profileSection('trackCPUUsage', trackCPUUsage);

    // --- STATUS DISPLAY (LESS OFTEN) ---
    if (Game.time % 50 === 0) {
      profileSection('displayStatus', function(){ displayStatus(perRoomRoleCounts); });
      if (ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
        for (const key in Memory.cpuProfile) {
          const avg = Memory.cpuProfile[key].reduce(function(a, b){ return a + b; }, 0) / Memory.cpuProfile[key].length;
          console.log("CPU Profile: " + key + " avg: " + Math.round(avg));
        }
      }
    }
  });
};

// --- CPU PROFILING ---
if (ENABLE_CPU_LOGGING && !Memory.cpuProfile) Memory.cpuProfile = {};
function profileSection(name, fn) {
  if (!ENABLE_CPU_LOGGING) {
    fn();
    return;
  }
  const start = Game.cpu.getUsed();
  fn();
  const used = Game.cpu.getUsed() - start;
  if (!Memory.cpuProfile[name]) Memory.cpuProfile[name] = [];
  Memory.cpuProfile[name].push(used);
  if (Memory.cpuProfile[name].length > 50) Memory.cpuProfile[name].shift();
  if (!Memory.cpuProfileLastUsed) Memory.cpuProfileLastUsed = {};
  Memory.cpuProfileLastUsed[name] = Game.time;
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
