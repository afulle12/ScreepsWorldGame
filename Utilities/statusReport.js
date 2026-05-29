// === statusReport.js ===
// Handles the 100-tick colony status console output.
// Emits a single console.log() call so the entire report appears under
// one timestamp in the Screeps console.

const getRoomState     = require('getRoomState');
const singleSourceRoom = require('singleSourceRoom');
const marketBuyer      = require('marketBuy');

let ENABLE_CPU_LOGGING  = false;
let DISABLE_CPU_CONSOLE = true;

function init(cpuLogging, disableCpuConsole) {
  ENABLE_CPU_LOGGING  = cpuLogging;
  DISABLE_CPU_CONSOLE = disableCpuConsole;
}

// ---------------------------------------------------------------

function formatTime(totalMinutes) {
  const days    = Math.floor(totalMinutes / (24 * 60));
  const hours   = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = Math.floor(totalMinutes % 60);
  if (days > 0) {
    return hours > 0
      ? (days + "d " + hours + "h " + minutes + "m")
      : (days + "d " + minutes + "m");
  } else if (hours > 0) {
    return hours + "h " + minutes + "m";
  } else {
    return minutes + "m";
  }
}

function getPerformanceData() {
  let cpuMin     = 0;
  let cpuMax     = 0;
  let cpuAverage = 0;

  if (Memory.cpuStats && Memory.cpuStats.history && Memory.cpuStats.history.length > 0) {
    const history = Memory.cpuStats.history;
    cpuMin     = Math.min.apply(null, history);
    cpuMax     = Math.max.apply(null, history);
    cpuAverage = history.reduce(function(sum, val) { return sum + val; }, 0) / history.length;
  }

  return { cpuAverage, cpuMin, cpuMax };
}

function calculateTotalEnergy() {
  let totalEnergy = 0;
  const allRooms  = getRoomState.all();

  for (const roomName in allRooms) {
    const state = allRooms[roomName];
    if (!state.structuresByType) continue;

    function sumStore(type) {
      const list = state.structuresByType[type];
      if (!list || list.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.store) sum += s.store.getUsedCapacity(RESOURCE_ENERGY);
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

// Emoji-aware padEnd: emoji render 2 columns wide in the Screeps console
// but JS counts them as 1-2 code units, so plain padEnd undershoots.
function emojiPadEnd(str, targetLen) {
  let extraWidth = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    if (cp > 0xFFFF) { extraWidth++; i++; }
  }
  const bmpWide = /[\u26CF\u26A1\u2692\u2694\u2699]/g;
  const bmpMatches = str.match(bmpWide);
  if (bmpMatches) extraWidth += bmpMatches.length;
  return str.padEnd(Math.max(0, targetLen - extraWidth));
}

// Show a role icon only when count > 0 (or always, if alwaysShow is true)
function icon(emoji, count, alwaysShow) {
  if (!alwaysShow && (count || 0) === 0) return '';
  return ' ' + emoji + (count || 0);
}

function run(perRoomRoleCounts) {
  const lines = [];

  // ---------------------------------------------------------------
  // ENERGY MARKET PRICE
  // ---------------------------------------------------------------
  const energyMktPrice = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);

  // ---------------------------------------------------------------
  // GCL TRACKING — cache ETA in Memory so status() always shows it
  // ---------------------------------------------------------------
  const GCL_WINDOW   = 5000;
  const GCL_INTERVAL = 100;

  if (!Memory.gclTracker) Memory.gclTracker = { anchor: null, lastLevel: Game.gcl.level, etaString: '' };

  if (Game.time % GCL_INTERVAL === 0) {
    const currentPercent = Game.gcl.progress / Game.gcl.progressTotal * 100;
    const tracker        = Memory.gclTracker;

    // Reset anchor on level-up or if window has expired
    if (!tracker.anchor ||
        tracker.lastLevel !== Game.gcl.level ||
        Game.time - tracker.anchor.tick >= GCL_WINDOW) {
      tracker.anchor    = { tick: Game.time, percent: currentPercent };
      tracker.lastLevel = Game.gcl.level;
    } else {
      const dt    = Game.time - tracker.anchor.tick;
      const dPerc = currentPercent - tracker.anchor.percent;

      if (dt >= GCL_INTERVAL && dPerc > 0) {
        const rate      = dPerc / dt;
        const remaining = 100 - currentPercent;
        const etaTicks  = Math.ceil(remaining / rate);
        const totalSec  = etaTicks * 4;
        const days    = Math.floor(totalSec / 86400);
        const hours   = Math.floor((totalSec % 86400) / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        tracker.etaString = days + "d " + hours + "h " + minutes + "m";
      } else {
        tracker.etaString = '∞';
      }
    }
  }

  const gclPercent = (Game.gcl.progress / Game.gcl.progressTotal * 100).toFixed(1);
  const gclEtaPart = Memory.gclTracker.etaString
    ? " ETA: " + Memory.gclTracker.etaString
    : '';
  const gclString = "GCL " + Game.gcl.level + " " + gclPercent + "%" + gclEtaPart;

  // ---------------------------------------------------------------
  // CREEP COUNTS PER ROOM
  // ---------------------------------------------------------------
  const perRoomStats = {};
  for (const name in Game.creeps) {
    const creep        = Game.creeps[name];
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
    if (!perRoomStats[assignedRoom]) perRoomStats[assignedRoom] = { totalCreeps: 0, powerCreeps: 0 };
    perRoomStats[assignedRoom].totalCreeps++;
  }
  for (const name in Game.powerCreeps) {
    const pc = Game.powerCreeps[name];
    if (!pc.room) continue;
    const roomName = pc.room.name;
    if (!perRoomStats[roomName]) perRoomStats[roomName] = { totalCreeps: 0, powerCreeps: 0 };
    perRoomStats[roomName].powerCreeps++;
    perRoomStats[roomName].totalCreeps++;
  }

  // ---------------------------------------------------------------
  // HEADER
  // ---------------------------------------------------------------
  lines.push("======================== COLONY STATUS =========================");

  // ---------------------------------------------------------------
  // CPU + GCL LINE
  // ---------------------------------------------------------------
  const perfData = getPerformanceData();
  if (!ENABLE_CPU_LOGGING || !DISABLE_CPU_CONSOLE) {
    const bucketPercent = Math.round((Game.cpu.bucket / 10000) * 100);
    const bucketStatus  = Game.cpu.bucket >= 10000 ? 'FULL' : bucketPercent + '%';
    lines.push(
      "CPU Min: "    + Math.round(perfData.cpuMin) +
      " Avg: "       + Math.round(perfData.cpuAverage) +
      " Max: "       + Math.round(perfData.cpuMax) +
      " | Bucket: "  + Game.cpu.bucket + " (" + bucketStatus + ")" +
      " | "          + gclString
    );
  } else {
    lines.push(gclString);
  }

  lines.push("----------------------------------------------------------------");

  // ---------------------------------------------------------------
  // ROOM ROWS
  // ---------------------------------------------------------------
  if (!Memory.progressTracker) Memory.progressTracker = {};

  const myRooms = Object.keys(Game.rooms).sort();

  for (const roomName of myRooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    // RCL progress & ETA
    const percent = room.controller.progress / room.controller.progressTotal * 100;

    if (!Memory.progressTracker[roomName]) {
      Memory.progressTracker[roomName] = { level: room.controller.level, anchor: { tick: Game.time, percent } };
    }

    const tracker = Memory.progressTracker[roomName];

    // Reset anchor on level-up or if window has expired
    if (tracker.level !== room.controller.level ||
        Game.time - tracker.anchor.tick >= 500) {
      tracker.level  = room.controller.level;
      tracker.anchor = { tick: Game.time, percent };
    }

    let etaText = '';
    if (room.controller.level < 8) {
      const tickDelta    = Game.time - tracker.anchor.tick;
      const percentDelta = percent - tracker.anchor.percent;

      if (tickDelta >= 100 && percentDelta > 0) {
        const remaining  = 100 - percent;
        const rate       = percentDelta / tickDelta;
        const etaTicks   = Math.ceil(remaining / rate);
        const etaMinutes = etaTicks * 4 / 60;
        etaText = "ETA: ~" + formatTime(etaMinutes) + " (" + percent.toFixed(1) + "%)";
      }
    }

    const counts = perRoomRoleCounts[roomName] || {};
    const stats  = perRoomStats[roomName]      || { totalCreeps: 0 };

    // Energy
    const enAvail = room.energyAvailable >= 1000
      ? (room.energyAvailable / 1000).toFixed(1) + 'k' : room.energyAvailable;
    const enCap = room.energyCapacityAvailable >= 1000
      ? (room.energyCapacityAvailable / 1000).toFixed(1) + 'k' : room.energyCapacityAvailable;

    // Storage
    let stoDisplay = "NoSto";
    if (room.storage && room.storage.store) {
      const sVal = room.storage.store[RESOURCE_ENERGY];
      stoDisplay = "Sto:" + (sVal >= 1000 ? (sVal / 1000).toFixed(0) + 'k' : sVal);
    }

    // Creep icons — only show non-zero counts, except core roles always shown
    let creepDisplay = "";
    if (stats.totalCreeps === 0) {
      creepDisplay = "Idle";
    } else if (singleSourceRoom.isSingleSourceActive(roomName)) {
      creepDisplay =
        icon('⛏',  counts.hd,                    true)  +
        icon('🛠',  counts.maintainer,             false) +
        icon('🔨',  counts.builder,               false) +
        icon('🔧',  counts.comboBot,              false) +
        icon('🔋',  counts.staticDistributor,     true)  +
        icon('🧪',  counts.labBot,                false) +
        icon('📡',  counts.terminalBot,           false) +
        icon('🏭',  counts.factoryBot,            false) +
        icon('💎',  counts.extractor,             false) +
        icon('🗼',  counts.towerFiller,           false) +
        icon('💠',  counts.mineralCollector,      false) +
        icon('🪣',  counts.extractorAssistant,    false) +
        icon('🛡️', counts.rampartBot,             false) +
        icon('🧱',  counts.wallRepair,            false) +
        icon('🔩',  counts.defenseRepair,         false) +
        icon('🌾',  counts.depositHarvester,      false) +
        icon('☢️',  counts.nukeFill,              false) +
        icon('🌀',  counts.towerDrain,            false) +
        icon('🔭',  counts.scout,                 false) +
        icon('🚚',  counts.remoteSupplier,        false) +
        icon('🪧',  counts.signbot,               false) +
        icon('🗡️', counts.defender,               false) +
        icon('⚔️',  counts.attacker,              false) +
        icon('💨',  counts.fastAttacker,          false) +
        icon('🥷',  counts.skAttacker,            false) +
        icon('🤖',  counts.quad,                  false) +
        icon('🔓',  counts.controllerAttacker,    false) +
        icon('♻️',  counts.scavenger,             false) +
        icon('🦹',  counts.thief,                 false) +
        icon('🚩',  counts.claimbot,              false) +
        icon('💥',  counts.demolition,            false) +
        icon('💣',  counts.contestedDemolisher,   false) +
        icon('💢',  stats.powerCreeps,            false);
    } else {
      creepDisplay =
        icon('⛏',  counts.harvester,             true)  +
        icon('🛠',  counts.maintainer,            false) +
        icon('🔨',  counts.builder,               false) +
        icon('🏗️', counts.remoteBuilder,          false) +
        icon('⚡',  counts.upgrader,              false) +
        icon('🔋',  counts.supplier,              true)  +
        icon('🔧',  counts.comboBot,              false) +
        icon('🧪',  counts.labBot,                false) +
        icon('🚧',  counts.repairBot,             false) +
        icon('🧱',  counts.wallRepair,            false) +
        icon('🔩',  counts.defenseRepair,         false) +
        icon('🛡️', counts.rampartBot,             false) +
        icon('📡',  counts.terminalBot,           false) +
        icon('🏭',  counts.factoryBot,            false) +
        icon('💎',  counts.extractor,             false) +
        icon('💠',  counts.mineralCollector,      false) +
        icon('🪣',  counts.extractorAssistant,    false) +
        icon('🌾',  counts.depositHarvester,      false) +
        icon('🔌',  counts.powerBot,              false) +
        icon('☢️',  counts.nukeFill,              false) +
        icon('🌀',  counts.towerDrain,            false) +
        icon('🔭',  counts.scout,                 false) +
        icon('🚚',  counts.remoteSupplier,        false) +
        icon('🪧',  counts.signbot,               false) +
        icon('🗡️', counts.defender,               false) +
        icon('⚔️',  counts.attacker,              false) +
        icon('💨',  counts.fastAttacker,          false) +
        icon('🥷',  counts.skAttacker,            false) +
        icon('🤖',  counts.quad,                  false) +
        icon('🔓',  counts.controllerAttacker,    false) +
        icon('♻️',  counts.scavenger,             false) +
        icon('🦹',  counts.thief,                 false) +
        icon('🚩',  counts.claimbot,              false) +
        icon('🗼',  counts.towerFiller,           false) +
        icon('💥',  counts.demolition,            false) +
        icon('💣',  counts.contestedDemolisher,   false) +
        icon('💢',  stats.powerCreeps,            false);
    }

    const col1 = (roomName + " RCL" + room.controller.level).padEnd(12);
    const col2 = ("En:" + enAvail + "/" + enCap).padEnd(16);
    const col3 = stoDisplay.padEnd(9);
    const col4 = emojiPadEnd(creepDisplay, 20);

    const endOfLine = etaText ? " | " + etaText : "";

    lines.push(col1 + " | " + col2 + " | " + col3 + " | " + col4 + endOfLine);
  }

  // ---------------------------------------------------------------
  // TOTAL CREEP COUNTS
  // ---------------------------------------------------------------
  let totalAll = 0;
  const totalCounts = {};
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const role  = creep.memory.role;
    if (role) totalCounts[role] = (totalCounts[role] || 0) + 1;
    totalAll++;
  }
  let totalPowerCreeps = 0;
  for (const name in Game.powerCreeps) {
    if (Game.powerCreeps[name].room) totalPowerCreeps++;
  }
  if (totalPowerCreeps > 0) totalAll += totalPowerCreeps;

  const ROLE_ICONS = {
    harvester:           '⛏',
    hd:                  '⛏',
    maintainer:          '🛠',
    builder:             '🔨',
    remoteBuilder:       '🏗️',
    upgrader:            '⚡',
    supplier:            '🔋',
    staticDistributor:   '🔋',
    comboBot:            '🔧',
    repairBot:           '🚧',
    wallRepair:          '🧱',
    defenseRepair:       '🔩',
    rampartBot:          '🛡️',
    labBot:              '🧪',
    terminalBot:         '📡',
    factoryBot:          '🏭',
    extractor:           '💎',
    mineralCollector:    '💠',
    extractorAssistant:  '🪣',
    depositHarvester:    '🌾',
    powerBot:            '🔌',
    towerFiller:         '🗼',
    nukeFill:            '☢️',
    towerDrain:          '🌀',
    scout:               '🔭',
    remoteSupplier:      '🚚',
    signbot:             '🪧',
    defender:            '🗡️',
    attacker:            '⚔️',
    fastAttacker:        '💨',
    skAttacker:          '🥷',
    quad:                '🤖',
    controllerAttacker:  '🔓',
    scavenger:           '♻️',
    thief:               '🦹',
    claimbot:            '🚩',
    demolition:          '💥',
    contestedDemolisher: '💣',
  };

  // Merge hd into harvester so both mining roles share one ⛏ icon
  if (totalCounts.hd) {
    totalCounts.harvester = (totalCounts.harvester || 0) + totalCounts.hd;
    delete totalCounts.hd;
  }
  // Merge staticDistributor into supplier so both share one 🔋 icon
  if (totalCounts.staticDistributor) {
    totalCounts.supplier = (totalCounts.supplier || 0) + totalCounts.staticDistributor;
    delete totalCounts.staticDistributor;
  }
  if (totalPowerCreeps > 0) totalCounts['💢_powerCreep'] = totalPowerCreeps;

  const roleParts = Object.entries(totalCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => {
      if (role === '💢_powerCreep') return '💢' + count;
      return (ROLE_ICONS[role] || role) + count;
    });

  lines.push("Total creeps: " + totalAll + "  (" + roleParts.join(' ') + ")");

  // ---------------------------------------------------------------
  // ENERGY SUMMARY + MARKET PRICE (plain text)
  // ---------------------------------------------------------------
  const totalEnergy = calculateTotalEnergy();
  const ownedRoomNames = Object.keys(Game.rooms).filter(rn => {
    const r = Game.rooms[rn];
    return r.controller && r.controller.my;
  });
  const avgEnergy = ownedRoomNames.length > 0 ? Math.round(totalEnergy / ownedRoomNames.length) : 0;

  const totalEnergyStr = totalEnergy >= 1000000 ? (totalEnergy / 1000000).toFixed(2) + 'M' :
                         totalEnergy >= 1000    ? (totalEnergy / 1000).toFixed(1) + 'k' :
                         totalEnergy;
  const avgEnergyStr   = avgEnergy >= 1000    ? (avgEnergy / 1000).toFixed(1) + 'k' :
                         avgEnergy;

  const priceStr = energyMktPrice.toFixed(3);
  lines.push("Total energy: " + totalEnergyStr + " | Avg/room: " + avgEnergyStr + " | \u26A1 Mkt: " + priceStr + "/u");

  lines.push("================================================================");

  // Single console.log — one timestamp for the whole block
  console.log(lines.join('\n'));

  // Background: track total energy
  if (!Memory.stats) Memory.stats = {};
  Memory.stats.lastTotalEnergy = totalEnergy;
}

function getPerRoomRoleCounts() {
  const perRoomCounts = {};
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller && room.controller.my) {
      perRoomCounts[roomName] = {
        harvester: 0, upgrader: 0, builder: 0, remoteBuilder: 0,
        scout: 0, defender: 0, supplier: 0,
        claimbot: 0, attacker: 0, fastAttacker: 0, scavenger: 0,
        thief: 0, towerDrain: 0, demolition: 0, contestedDemolisher: 0,
        wallRepair: 0, defenseRepair: 0, depositHarvester: 0,
        powerBot: 0, quad: 0, maintainer: 0, skAttacker: 0,
        labBot: 0,
        hd: 0, staticDistributor: 0, comboBot: 0,
        repairBot: 0, rampartBot: 0,
        terminalBot: 0, factoryBot: 0, extractor: 0, nukeFill: 0,
        mineralCollector: 0, signbot: 0, remoteSupplier: 0,
        controllerAttacker: 0, extractorAssistant: 0, towerFiller: 0,
      };
    }
  }
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const role = creep.memory.role;
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
    if (perRoomCounts[assignedRoom] && perRoomCounts[assignedRoom][role] !== undefined) {
      perRoomCounts[assignedRoom][role]++;
    }
  }
  return perRoomCounts;
}


module.exports = { init, run, getPerRoomRoleCounts };
