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
// const squad = require('squadModule'); // Removed squad functionality
const roleSquad = require('roleSquad'); // <--- IMPORTANT: Squad Module Import
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
const localRefine = require('localRefine'); 
const marketLabReverse = require('marketLabReverse');
const marketLabForward = require('marketLabForward');
const roleNukeFill = require('roleNukeFill');
const nukeUtils = require('nukeUtils');
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
const roomIntel = require('roomIntel');
const roleMaintainer = require('roleMaintainer');
const roleContestedDemolisher = require('roleContestedDemolisher');
const autoEnergyBuyer = require('autoEnergyBuyer');
const wideScan = require('wideScan');
const playerAnalysis = require('playerAnalysis');
const autoTrader = require('autoTrader');
const roomNavigation = require('roomNavigation');
const memoryQuery = require('memoryQuery');
const dailyFinance = require('dailyFinance');
const marketPricing = require('marketPricing');
const marketArbitrage = require('marketArbitrage');


// === GLOBAL MODULE EXPOSURE FOR CONSOLE ACCESS ===
global.opportunisticBuy = opportunisticBuy;
global.intel = roomIntel.intel;
global.listIntel = roomIntel.listIntel;
global.getCachedIntel = roomIntel.getCachedIntel;
global.nukeFill = roleNukeFill.order;
global.nukeInRange = nukeUtils.nukeInRange;
// Expose the console command: launchNuke('DonorRoom', 'RecipientRoom', 'structureType')
global.launchNuke = nukeLaunch.launchNuke;
global.listRoomMarketOrders = marketRoomOrders.listRoomMarketOrders;
global.memoryProfile = memoryProfiler.profile;
global.harvestResources = depositObserver.harvestResources;
global.launchClaimbot = require('roleClaimbot').spawn;
global.orderClaim = require('roleClaimbot').orderClaim;
global.cancelClaimOrder = require('roleClaimbot').cancelClaimOrder;
global.listClaimOrders = require('roleClaimbot').listClaimOrders;

// Thief order commands
global.orderThieves = require('roleThief').orderThieves;
global.cancelThiefOrder = require('roleThief').cancelThiefOrder;
global.listThiefOrders = require('roleThief').listThiefOrders;
global.financeReport = dailyFinance.report;
global.prices = marketPricing.printPrices;
global.marketArbitrage = marketArbitrage;

// Room navigation debug
global.setNavDebug = require('roomNavigation').setDebug;

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
// profiler.registerObject(squad, 'squad'); // Removed squad functionality
profiler.registerObject(roleSquad, 'roleSquad'); // <--- Register Profiler
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
profiler.registerObject(localRefine, 'localRefine'); 
profiler.registerObject(marketLabReverse, 'marketLabReverse');
profiler.registerObject(marketLabReverse, 'marketLabForward');
profiler.registerObject(roleNukeFill, 'roleNukeFill');
profiler.registerObject(nukeUtils, 'nukeUtils');
// Profiler registration for nukeLaunch
profiler.registerObject(nukeLaunch, 'nukeLaunch');
profiler.registerObject(marketRoomOrders, 'marketRoomOrders'); 
profiler.registerObject(roleRemoteBuilder, 'roleRemoteBuilder');
profiler.registerObject(roleDepositHarvester, 'roleDepositHarvester');
profiler.registerObject(depositObserver, 'depositObserver');
profiler.registerObject(rolePowerBot, 'rolePowerBot');
profiler.registerObject(powerManager, 'powerManager');
profiler.registerObject(roleOperator, 'roleOperator');
profiler.registerObject(roleMaintainer, 'roleMaintainer'); // <--- REGISTER MAINTAINER
profiler.registerObject(roleContestedDemolisher, 'roleContestedDemolisher'); // <--- REGISTER CONTESTED DEMOLISHER
profiler.registerObject(roomIntel, 'roomIntel');
profiler.registerObject(autoEnergyBuyer, 'autoEnergyBuyer');
profiler.registerObject(wideScan, 'wideScan');
profiler.registerObject(playerAnalysis, 'playerAnalysis');
profiler.registerObject(autoTrader, 'autoTrader');
profiler.registerObject(roomNavigation, 'roomNavigation');
profiler.registerObject(dailyFinance, 'dailyFinance');
profiler.registerObject(marketPricing, 'marketPricing');
profiler.registerObject(marketArbitrage, 'marketArbitrage');

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
      case 'harvester':      roleHarvester.run(creep);        break;
      case 'upgrader':       roleUpgrader.run(creep);         break;
      case 'builder':        roleBuilder.run(creep);          break;
      case 'scout':          roleScout.run(creep);            break;
      case 'defender':       roleDefender.run(creep);         break;
      case 'supplier':       roleSupplier.run(creep);         break;
      case 'claimbot':       roleClaimbot.run(creep);         break;
      // case 'remoteHarvester':roleRemoteHarvester.run(creep); break; // disabled
      case 'attacker':       roleAttacker.run(creep);         break;
      case 'extractor':      roleExtractor.run(creep);        break;
      case 'scavenger':      roleScavenger.run(creep);        break;
      case 'thief':          roleThief.run(creep);            break;
      case 'towerDrain':     roleTowerDrain.run(creep);       break;
      case 'demolition':     roleDemolition.run(creep);       break;
      // case 'squadMember':        squad.run(creep);                   break; // Removed squad functionality

      // --- Explicit case for 'quad' ---
      case 'quad':           roleSquad.run(creep);            break; 

      case 'mineralCollector': roleMineralCollector.run(creep); break;
      case 'terminalBot':    terminalManager.runTerminalBot(creep); break;
      case 'signbot':        roleSignbot.run(creep);          break;
      case 'factoryBot':     roleFactoryBot.run(creep);       break;
      case 'wallRepair':     roleWallRepair.run(creep);       break;
      case 'labBot':         roleLabBot.run(creep);           break;
      case 'nukeFill':       roleNukeFill.run(creep);         break;
      case 'remoteBuilder':  roleRemoteBuilder.run(creep);  break;
      case 'depositHarvester': roleDepositHarvester.run(creep); break;
      case 'powerBot':         rolePowerBot.run(creep);         break;

      // --- NEW ROLES ---
      case 'maintainer':       roleMaintainer.run(creep);       break;
      case 'contestedDemolisher': roleContestedDemolisher.run(creep); break;

      default:
        // Default fallback to harvester
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

  // --- POWER CREEPS (separate loop - they live in Game.powerCreeps, not Game.creeps) ---
  if (Memory.operators) {
    for (const name in Memory.operators) {
      const pc = Game.powerCreeps[name];
      if (!pc) continue;
      if (!pc.ticksToLive) {
        roleOperator.trySpawn(pc, Memory.operators[name].homeRoom);
        continue;
      }

      let cpuBefore;
      if (ENABLE_CPU_LOGGING) cpuBefore = Game.cpu.getUsed();

      roleOperator.runCreep(pc, Memory.operators[name]);

      if (ENABLE_CPU_LOGGING) {
        const cpuAfter = Game.cpu.getUsed();
        if (!Memory.cpuProfileCreeps) Memory.cpuProfileCreeps = {};
        if (!Memory.cpuProfileCreeps['operator']) Memory.cpuProfileCreeps['operator'] = [];
        Memory.cpuProfileCreeps['operator'].push(cpuAfter - cpuBefore);
        if (Memory.cpuProfileCreeps['operator'].length > 50) {
          Memory.cpuProfileCreeps['operator'].shift();
        }
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
        claimbot: 0, attacker: 0, scavenger: 0, thief: 0, towerDrain: 0, demolition: 0, 
        wallRepair: 0, depositHarvester: 0, powerBot: 0, quad: 0,
        maintainer: 0, contestedDemolisher: 0 // <--- ADDED MAINTAINER & CONTESTED DEMOLISHER TRACKING
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

// =================================================================
/* === STATUS & TRACKING FUNCTIONS ================================= */
// =================================================================

function displayStatus(perRoomRoleCounts) {
  const GCL_WINDOW   = 5000;
  const GCL_INTERVAL = 100;
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

  // --- CALCULATE CREEP STATS ---
  const perRoomStats = {};
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;

    if (!perRoomStats[assignedRoom]) {
      perRoomStats[assignedRoom] = { totalCreeps: 0 };
    }
    perRoomStats[assignedRoom].totalCreeps++;
  }

  console.log("======================== COLONY STATUS =========================");

  // --- CPU STATUS ---
  const perfData = getPerformanceData();
  if (!ENABLE_CPU_LOGGING || !DISABLE_CPU_CONSOLE) {
    const bucketPercent = Math.round((Game.cpu.bucket / 10000) * 100);
    const bucketStatus = Game.cpu.bucket >= 10000 ? '(FULL)' : '(' + bucketPercent + '%)';

    console.log(
      "🖥️ CPU: Min: " + Math.round(perfData.cpuMin) +
      " | Avg: " + Math.round(perfData.cpuAverage) +
      " | Max: " + Math.round(perfData.cpuMax) +
      " | Bucket: " + Game.cpu.bucket + "/10000 " + bucketStatus
    );
  }

  if (!Memory.progressTracker) Memory.progressTracker = {};

  const myRooms = Object.keys(Game.rooms).sort();

  for (const roomName of myRooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    // --- 1. PROGRESS & ETA CALCULATION ---
    const percent = room.controller.progress / room.controller.progressTotal * 100;

    if (!Memory.progressTracker[roomName]) {
      Memory.progressTracker[roomName] = { level: room.controller.level, history: [] };
    }

    const tracker = Memory.progressTracker[roomName];
    if (tracker.level !== room.controller.level) {
      tracker.level       = room.controller.level;
      tracker.history = [{ tick: Game.time, percent: percent }];
    }
    tracker.history.push({ tick: Game.time, percent: percent });
    while (tracker.history.length > 0 && tracker.history[0].tick < Game.time - 500) {
      tracker.history.shift();
    }

    let etaText = '';
    if (tracker.history.length > 1 && room.controller.level < 8) {
      const hist           = tracker.history;
      const oldest         = hist[0];
      const newest         = hist[hist.length - 1];
      const tickDelta      = newest.tick - oldest.tick;
      const percentDelta = newest.percent - oldest.percent;

      if (tickDelta >= 100 && percentDelta > 0) {
        const remaining = 100 - newest.percent;
        const rate      = percentDelta / tickDelta;
        const etaTicks  = Math.ceil(remaining / rate);
        const etaMinutes= etaTicks * 4 / 60;
        etaText = "ETA: ~" + formatTime(etaMinutes);
      }
    }

    // --- 2. GATHER DATA FOR LINE ---
    const counts = perRoomRoleCounts[roomName] || {};
    const stats  = perRoomStats[roomName] || { totalCreeps: 0 };

    // RCL String
    let rclDisplay = "RCL" + room.controller.level;

    // Energy String
    const enAvail = room.energyAvailable >= 1000 ? (room.energyAvailable/1000).toFixed(1) + 'k' : room.energyAvailable;
    const enCap = room.energyCapacityAvailable >= 1000 ? (room.energyCapacityAvailable/1000).toFixed(1) + 'k' : room.energyCapacityAvailable;
    const enDisplay = "Energy: " + enAvail + "/" + enCap;

    // Storage String
    let storageDisplay = "NoSto";
    if (room.storage && room.storage.store) {
      const sVal = room.storage.store[RESOURCE_ENERGY];
      storageDisplay = "Storage: " + (sVal >= 1000 ? (sVal/1000).toFixed(0) + 'k' : sVal);
    }

    // Wall/Rampart Progress with ETA (target: 299M average hits, RCL8 only)
    let wallEtaText = "";
    if (room.controller.level === 8) {
      const TARGET_HITS = 20000000;
      const WALL_INTERVAL = 50000;
      if (!Memory.wallTracker) Memory.wallTracker = {};
      if (!Memory.wallTracker[roomName]) Memory.wallTracker[roomName] = {};
      const wt = Memory.wallTracker[roomName];

      const walls = room.find(FIND_STRUCTURES, {
        filter: function(s) {
          return s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART;
        }
      });

      if (walls.length > 0) {
        let totalHits = 0;
        for (let i = 0; i < walls.length; i++) {
          totalHits += walls[i].hits;
        }
        const avgHits = totalHits / walls.length;
        const wallPercent = avgHits / TARGET_HITS * 100;

        // Take a new reading every WALL_INTERVAL ticks
        if (!wt.lastTick || Game.time - wt.lastTick >= WALL_INTERVAL) {
          wt.prevPercent = wt.currentPercent || null;
          wt.prevTick = wt.lastTick || null;
          wt.currentPercent = wallPercent;
          wt.lastTick = Game.time;
        }

        // Calculate ETA if we have two readings
        if (wt.prevPercent !== undefined && wt.prevPercent !== null && wt.prevTick !== null) {
          const dPerc = wt.currentPercent - wt.prevPercent;
          const dTicks = wt.lastTick - wt.prevTick;
          if (dPerc > 0 && dTicks > 0) {
            const rate = dPerc / dTicks;
            const remaining = 100 - wallPercent;
            const etaTicks = Math.ceil(remaining / rate);
            const etaMinutes = etaTicks * 4 / 60;
            wallEtaText = "ETA: ~" + formatTime(etaMinutes) + " (" + wallPercent.toFixed(2) + "%)";
          } else {
            wallEtaText = "ETA: ∞ (" + wallPercent.toFixed(2) + "%)";
          }
        } else {
          wallEtaText = "ETA: pending (" + wallPercent.toFixed(2) + "%)";
        }

      } else {
        // No walls in room
      }
    }

    // Creep Icons String
    let creepDisplay = "";
    if (stats.totalCreeps === 0) {
      creepDisplay = "Idle";
    } else {
      creepDisplay = 
        "🧑‍🌾" + (counts.harvester||0) +
        " ⚡" + (counts.upgrader||0) +
        " 🔨" + (counts.builder||0) +
        " 🔋" + (counts.supplier||0);
    }

    // --- 3. PAD COLUMNS FOR ALIGNMENT ---
    const col1 = (roomName + ": " + rclDisplay).padEnd(14);
    const col2 = enDisplay.padEnd(21);
    const col3 = storageDisplay.padEnd(15);
    const col4 = creepDisplay.padEnd(24);

    // --- 4. END OF LINE ---
    let endOfLine = "";
    if (room.controller.level < 8) {
        const percentStr = "(" + percent.toFixed(1) + "%)";
        if (etaText) {
            endOfLine = " | " + etaText + " " + percentStr;
        } else {
            endOfLine = " | " + percentStr;
        }
    } else if (wallEtaText) {
        endOfLine = " | " + wallEtaText;
    }

    // --- 5. PRINT UNIFIED LINE ---
    console.log(
        col1 + " | " + 
        col2 + " | " + 
        col3 + " | " + 
        col4 + 
        endOfLine
    );
  }

  // --- TOTAL ENERGY TRACKING (Background) ---
  const currentEnergy = calculateTotalEnergy();
  if (!Memory.stats) Memory.stats = {};
  Memory.stats.lastTotalEnergy = currentEnergy;

  console.log('================================================================');
  return gclEta;
}

// UPDATED: Now uses getRoomState live objects instead of cached Memory IDs
function calculateTotalEnergy() {
  let totalEnergy = 0;
  const allRooms = getRoomState.all();

  for (const roomName in allRooms) {
    const state = allRooms[roomName];
    // If we have no structure cache for this room yet, skip
    if (!state.structuresByType) continue;

    // Helper to sum up energy in a list of structure objects
    function sumStore(type) {
      const list = state.structuresByType[type];
      if (!list || list.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.store) {
          sum += s.store.getUsedCapacity(RESOURCE_ENERGY);
        }
      }
      return sum;
    }

    totalEnergy += sumStore(STRUCTURE_SPAWN);
    totalEnergy += sumStore(STRUCTURE_EXTENSION);
    totalEnergy += sumStore(STRUCTURE_CONTAINER);

    if (state.storage && state.storage.store) {
      totalEnergy += state.storage.store.getUsedCapacity(RESOURCE_ENERGY);
    }
  }
  return totalEnergy;
}

function getPerformanceData() {
  const cpuUsed = Game.cpu.getUsed();
  const cpuLimit = Game.cpu.limit;

  let cpuMin = cpuUsed;
  let cpuMax = cpuUsed;
  let cpuAverage = 0;

  if (Memory.cpuStats && Memory.cpuStats.history && Memory.cpuStats.history.length > 0) {
    const history = Memory.cpuStats.history;
    cpuMin = Math.min.apply(null, history);
    cpuMax = Math.max.apply(null, history);
    cpuAverage = history.reduce(function(sum, val){ return sum + val; }, 0) / history.length;
  }

  return { 
    cpuUsed: cpuUsed, 
    cpuAverage: cpuAverage, 
    cpuMin: cpuMin, 
    cpuMax: cpuMax, 
    cpuLimit: cpuLimit 
  };
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
  if(Memory.cpuStats.history.length > 100) Memory.cpuStats.history.shift();
  Memory.cpuStats.average = Memory.cpuStats.history.reduce(function(sum, cpu){ return sum + cpu; }, 0) / Memory.cpuStats.history.length;
}

// Initialize global orders with spawnManager helpers
globalOrders.init({
  getRoomState: getRoomState,
  iff: iff,
  // squad: squad, // Removed squad functionality
  getCreepBody: spawnManager.getCreepBody,
  bodyCost: spawnManager.bodyCost
});

// =================================================================
/* ========================= MAIN GAME LOOP ======================== */
// =================================================================

module.exports.loop = function() {
  profiler.wrap(function() {
    // --- GLOBAL CREEP CACHE BY ROLE ---
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
    if (Game.time % 30 === 0) roleScout.handleDeadCreeps();
    if (Game.time % 1000 === 0)   cleanMemory();
    if (Game.time % 1000 === 0) cleanCpuProfileMemory();


    // --- BUILD PER-TICK ROOM STATE EARLY ---
    // This builds the global.__roomState cache for the tick
    profileSection('getRoomState.init', function() { getRoomState.init(); });

    // --- CACHING & COUNTS ---
    const perRoomRoleCounts = getPerRoomRoleCounts();
    // REMOVED: const roomDataCache = cacheRoomData(); -- No longer using Memory cache

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
    if (Game.time % 100 === 0) {
      profileSection('roomBalance', function() { roomBalance.run(); });
    }

    profileSection('terminalManager', function(){ terminalManager.run(); });
    profileSection('roleTowerDrain', function(){ roleTowerDrain.run(); });
    profileSection('mineralManager', function(){ mineralManager.run(); });
    profileSection('factoryManager', function(){ factoryManager.run(); });
    profileSection('marketUpdater', function(){ marketUpdater.run(); });
    profileSection('marketRefine.run', function(){ marketRefine.run(); });
    profileSection('localRefine.run', function(){ localRefine.run(); }); 
    profileSection('marketLabReverse.run', function(){ marketLabReverse.run(); });
    profileSection('marketLabForward.run', function(){ marketLabForward.run(); });
    profileSection('playerAnalysis.run', function(){ playerAnalysis.run(); });
    profileSection('autoTrader.run', function(){ autoTrader.run(); });
    profileSection('roleContestedDemolisher', function(){ roleContestedDemolisher.run(); });
    profileSection('dailyFinance', function(){ dailyFinance.run(); });
    profileSection('marketArbitrage', function(){ marketArbitrage.run(); });
    if (Game.time % 10 === 0) profileSection('opportunisticBuy', function(){ opportunisticBuy.process(); });
    if (Game.time % 100 === 0) roomIntel.cleanExpiredIntel();
    if (Game.time % 1 === 0) roomIntel.processPendingIntel();
    
    profileSection('powerManager', function() {
        for (const roomName in Game.rooms) {
            if (Game.rooms[roomName].controller && Game.rooms[roomName].controller.my) {
                powerManager.run(roomName);
            }
        }
    });
    profileSection('depositObserver.run', function(){ depositObserver.run(); });

    // --- NUKE LAUNCH PIPELINE ---
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
        // UPDATED: Passing getRoomState module instead of the old ID cache
        spawnManager.run(perRoomRoleCounts, getRoomState);
      });
    }

    // --- CREEP ACTIONS (includes power creeps via roleOperator) ---
    profileSection('runCreeps', runCreeps);

    // --- TRACKING & VISUALS ---
    profileSection('trackCPUUsage', trackCPUUsage);
    profileSection('wideScan.run', function(){ wideScan.run(); });
    //profileSection('roomNavigation', function(){ roomNavigation; });
    // Auto energy buying - runs every 100 ticks
    if (Game.time % 1050 === 0) {
        profileSection('autoEnergyBuyer', function() {
            autoEnergyBuyer.run(); // Will scan all owned rooms
        });
    }

    // --- STATUS DISPLAY (LESS OFTEN) ---
    if (Game.time % 100 === 0) {
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