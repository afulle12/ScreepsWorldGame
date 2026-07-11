// LLM: Read llmcontext.js before reviewing or changing this file.
// === statusReport.js ===
// Handles the 100-tick colony status console output.
// Emits a single console.log() call so the entire report appears under
// one timestamp in the Screeps console.
//
// CONSOLE COMMAND — status(playerName?)
//
//   status()
//     Print the colony status board: CPU/bucket/GCL header, one row per
//     owned room (RCL, energy, storage, creep role emoji, RCL ETA),
//     total creep counts, energy summary, daily income, trade summary.
//   status('PlayerName')

const getRoomState     = require('getRoomState');
const singleSourceRoom = require('singleSourceRoom');
const marketPricing    = require('marketPricing');

let ENABLE_CPU_LOGGING  = false;
let DISABLE_CPU_CONSOLE = true;

// ===== TRADE DATA HELPERS =====

const DECOMPRESSION_PRODUCTS = [
    RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, RESOURCE_ZYNTHIUM, RESOURCE_KEANIUM,
    RESOURCE_GHODIUM, RESOURCE_OXYGEN, RESOURCE_HYDROGEN, RESOURCE_CATALYST,
    RESOURCE_ENERGY
];

function getActiveReverseCount() {
    let count = 0;
    if (Memory.marketLabReverse && Memory.marketLabReverse.rooms) {
        for (const roomName in Memory.marketLabReverse.rooms) {
            const queue = Memory.marketLabReverse.rooms[roomName];
            if (!queue) continue;
            for (let i = 0; i < queue.length; i++) {
                if (queue[i] && queue[i].state !== 'SELLING') count++;
            }
        }
    }
    return count;
}

function getActiveForwardCount() {
    let count = 0;
    if (Memory.marketLabForward && Memory.marketLabForward.rooms) {
        for (const roomName in Memory.marketLabForward.rooms) {
            const queue = Memory.marketLabForward.rooms[roomName];
            if (!queue) continue;
            for (let i = 0; i < queue.length; i++) {
                if (queue[i] && queue[i].state !== 'SELLING') count++;
            }
        }
    }
    return count;
}

function getFactoryJobCounts() {
    let compression = 0;
    let decompression = 0;

    if (Memory.marketRefine && Memory.marketRefine.ops) {
        for (let i = 0; i < Memory.marketRefine.ops.length; i++) {
            const op = Memory.marketRefine.ops[i];
            if (op && op.output) {
                if (DECOMPRESSION_PRODUCTS.indexOf(op.output) >= 0) {
                    decompression++;
                } else {
                    compression++;
                }
            }
        }
    }

    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) {
        for (let i = 0; i < Memory.localRefine.ops.length; i++) {
            const op = Memory.localRefine.ops[i];
            if (op && op.output) compression++;
        }
    }

    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (let i = 0; i < Memory.factoryOrders.length; i++) {
            const order = Memory.factoryOrders[i];
            if (order && order.product) {
                if (DECOMPRESSION_PRODUCTS.indexOf(order.product) >= 0) {
                    decompression++;
                } else {
                    compression++;
                }
            }
        }
    }

    return { compression, decompression };
}

function getMarketOrderCounts() {
    let buys = 0;
    let sells = 0;

    if (Game.market && Game.market.orders) {
        for (const id in Game.market.orders) {
            const order = Game.market.orders[id];
            if (order && order.remainingAmount > 0) {
                if (order.type === ORDER_BUY) buys++;
                else if (order.type === ORDER_SELL) sells++;
            }
        }
    }

    return { buys, sells };
}

function getOpportunisticBuyCount() {
    let count = 0;
    if (Memory.opportunisticBuy && Memory.opportunisticBuy.requests) {
        for (const key in Memory.opportunisticBuy.requests) {
            const req = Memory.opportunisticBuy.requests[key];
            if (req && req.remaining > 0) count++;
        }
    }
    return count;
}

// Count labs currently in the active PROCESSING phase
function getActiveLabReactingCount() {
    let count = 0;
    // Reverse reactions
    if (Memory.marketLabReverse && Memory.marketLabReverse.rooms) {
        for (const roomName in Memory.marketLabReverse.rooms) {
            const queue = Memory.marketLabReverse.rooms[roomName];
            if (!queue) continue;
            for (let i = 0; i < queue.length; i++) {
                if (queue[i] && queue[i].state === 'PROCESSING') count++;
            }
        }
    }
    // Forward reactions
    if (Memory.marketLabForward && Memory.marketLabForward.rooms) {
        for (const roomName in Memory.marketLabForward.rooms) {
            const queue = Memory.marketLabForward.rooms[roomName];
            if (!queue) continue;
            for (let i = 0; i < queue.length; i++) {
                if (queue[i] && queue[i].state === 'PROCESSING') count++;
            }
        }
    }
    return count;
}

// Count active factory orders (rough analogue to lab PROCESSING state)
function getActiveFactoryProducingCount() {
    let count = 0;
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (let i = 0; i < Memory.factoryOrders.length; i++) {
            const order = Memory.factoryOrders[i];
            if (order && order.status === 'active') count++;
        }
    }
    return count;
}

function getSellOrderInventoryValue() {
    let totalValue = 0;
    if (Game.market && Game.market.orders) {
        for (const id in Game.market.orders) {
            const order = Game.market.orders[id];
            if (order && order.remainingAmount > 0 && order.type === ORDER_SELL) {
                totalValue += order.remainingAmount * order.price;
            }
        }
    }
    return totalValue;
}

function getArbitrageBufferValue() {
    let totalValue = 0;
    const buffered = Memory.marketArbitrage && Memory.marketArbitrage.buffered;
    if (buffered && Array.isArray(buffered)) {
        for (let i = 0; i < buffered.length; i++) {
            const buf = buffered[i];
            if (buf && buf.amount > 0 && buf.sellPrice > 0) {
                totalValue += buf.amount * buf.sellPrice;
            }
        }
    }
    return totalValue;
}

// ===== END TRADE DATA HELPERS =====

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

  const cpuStats = require('memoryManager').heap.cpuStats;
  if (cpuStats && cpuStats.history && cpuStats.history.length > 0) {
    const history = cpuStats.history;
    cpuMin     = Math.min.apply(null, history);
    cpuMax     = Math.max.apply(null, history);
    cpuAverage = history.reduce(function(sum, val) { return sum + val; }, 0) / history.length;
  }

  return { cpuAverage, cpuMin, cpuMax };
}

function calculateTotalEnergy() {
  let totalEnergy = 0;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;
    if (room.storage && room.storage.store) {
      totalEnergy += room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
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

/**
 * Display-only energy price: raw bestBid + 0.1 (what a posted BUY order would
 * cost to lead the book right now). Bypasses marketPricing.actualBuyPrice's
 * avg*1.5 cap because the cap is buyer-math defense, not a true market signal —
 * showing it in status would mislead the operator about actual acquisition cost.
 *
 * Falls back to the volume-weighted ask when no bid exists, else 0.
 */
function getStatusEnergyPrice() {
  const book = marketPricing.getBook(RESOURCE_ENERGY);
  if (book && book.bestBid !== null) return book.bestBid + 0.1;
  if (book && book.vwAsk !== null)   return book.vwAsk;
  return 0;
}

function run(perRoomRoleCounts) {
  const lines = [];

  // ---------------------------------------------------------------
  // ENERGY MARKET PRICE
  // ---------------------------------------------------------------
  const energyMktPrice = getStatusEnergyPrice();

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
  const creepIndex = getRoomState.creepIndex();
  const creeps = creepIndex && creepIndex.all ? creepIndex.all : [];
  for (let i = 0; i < creeps.length; i++) {
    const creep        = creeps[i];
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
        icon('💎',  counts.extractor,             false) +
        icon('🗼',  counts.towerFiller,           false) +
        icon('💠',  counts.mineralCollector,      false) +
        icon('🪣',  counts.extractorAssistant,    false) +
        icon('🔩',  counts.defenseRepair,         false) +
        icon('🌾',  counts.depositHarvester,      false) +
        icon('☢️',  counts.nukeFill,              false) +
        icon('🌀',  counts.towerDrain,            false) +
        icon('🧨',  counts.drainDemolisher,       false) +
        icon('🔭',  counts.scout,                 false) +
        icon('🚚',  counts.remoteSupplier,        false) +
        icon('🪧',  counts.signbot,               false) +
        icon('🗡️', counts.defender,               false) +
        icon('⚔️',  counts.attacker,              false) +
        icon('💨',  counts.fastAttacker,          false) +
        icon('🥷',  counts.skAttacker,            false) +
        icon('🤖',  counts.quad,                  false) +
        icon('🔓',  counts.controllerAttacker,    false) +
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
        icon('🚧',  counts.repairer,              false) +
        icon('🔩',  counts.defenseRepair,         false) +
        icon('📡',  counts.terminalBot,           false) +
        icon('💎',  counts.extractor,             false) +
        icon('💠',  counts.mineralCollector,      false) +
        icon('🪣',  counts.extractorAssistant,    false) +
        icon('🌾',  counts.depositHarvester,      false) +
        icon('🔌',  counts.powerBot,              false) +
        icon('☢️',  counts.nukeFill,              false) +
        icon('🌀',  counts.towerDrain,            false) +
        icon('🧨',  counts.drainDemolisher,       false) +
        icon('🔭',  counts.scout,                 false) +
        icon('🚚',  counts.remoteSupplier,        false) +
        icon('🪧',  counts.signbot,               false) +
        icon('🗡️', counts.defender,               false) +
        icon('⚔️',  counts.attacker,              false) +
        icon('💨',  counts.fastAttacker,          false) +
        icon('🥷',  counts.skAttacker,            false) +
        icon('🤖',  counts.quad,                  false) +
        icon('🔓',  counts.controllerAttacker,    false) +
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
  for (let i = 0; i < creeps.length; i++) {
    const creep = creeps[i];
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
    repairer:            '🚧',
    defenseRepair:       '🔩',
    labBot:              '🧪',
    terminalBot:         '📡',
    extractor:           '💎',
    mineralCollector:    '💠',
    extractorAssistant:  '🪣',
    depositHarvester:    '🌾',
    powerBot:            '🔌',
    towerFiller:         '🗼',
    nukeFill:            '☢️',
    towerDrain:          '🌀',
    drainDemolisher:     '🧨',
    scout:               '🔭',
    remoteSupplier:      '🚚',
    signbot:             '🪧',
    defender:            '🗡️',
    attacker:            '⚔️',
    fastAttacker:        '💨',
    skAttacker:          '🥷',
    quad:                '🤖',
    controllerAttacker:  '🔓',
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

  const kills = Memory.stats && typeof Memory.stats.kills === 'number'
    ? Memory.stats.kills
    : 0;

  lines.push(
    "Total creeps: " + totalAll +
    "  (" + roleParts.join(' ') + ")" +
    " | Kills: " + kills
  );

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
  lines.push("Total energy: " + totalEnergyStr + " | Avg/room: " + avgEnergyStr + " | ⚡ Mkt: " + priceStr + "/u");

  // ---------------------------------------------------------------
  // DAILY INCOME (from dailyFinance) + INVENTORY VALUE
  // ---------------------------------------------------------------
  const df = Memory.dailyFinance;
  let dailyIncomeStr = '';
  if (df && df.totalIncome > 0) {
    const income = df.totalIncome >= 1000000 ? (df.totalIncome / 1000000).toFixed(2) + 'M' :
                   df.totalIncome >= 1000    ? (df.totalIncome / 1000).toFixed(1) + 'k' :
                   df.totalIncome;
    const bought = (df.totalExpenses || 0) >= 1000000 ? ((df.totalExpenses || 0) / 1000000).toFixed(2) + 'M' :
                   (df.totalExpenses || 0) >= 1000    ? ((df.totalExpenses || 0) / 1000).toFixed(1) + 'k' :
                   (df.totalExpenses || 0);
    const profit = df.totalIncome - (df.totalExpenses || 0);
    const profitAbs = Math.abs(profit);
    const profitStr = profitAbs >= 1000000 ? (profitAbs / 1000000).toFixed(2) + 'M' :
                      profitAbs >= 1000    ? (profitAbs / 1000).toFixed(1) + 'k' :
                      profitAbs;
    const profitSign = profit >= 0 ? '+' : '-';
    const tx = (df.totalSalesTx || 0) + (df.totalPurchasesTx || 0);

    // Inventory value: sell orders + arbitrage buffer
    const invSellOrders = getSellOrderInventoryValue();
    const invArbitrage  = getArbitrageBufferValue();
    const invTotal      = invSellOrders + invArbitrage;
    const invStr = invTotal >= 1000000 ? (invTotal / 1000000).toFixed(2) + 'M' :
                   invTotal >= 1000    ? (invTotal / 1000).toFixed(1) + 'k' :
                   invTotal;

    dailyIncomeStr = 'Daily income: ' + income + ' | Expenses: ' + bought +
      ' | Net: ' + profitSign + profitStr + ' | Inv: ' + invStr + ' | Tx: ' + tx +
      ' (' + (df.totalSalesTx || 0) + 's/' + (df.totalPurchasesTx || 0) + 'b)';
  } else if (df) {
    dailyIncomeStr = 'Daily income: 0 | Inv: 0 | Tx: 0 (no transactions yet today)';
  }
  if (dailyIncomeStr) {
    lines.push(dailyIncomeStr);
  }

  // ---------------------------------------------------------------
  // TRADE SUMMARY LINE
  // ---------------------------------------------------------------
  const revCount   = getActiveReverseCount();
  const fwdCount   = getActiveForwardCount();
  const facCounts  = getFactoryJobCounts();
  const orderCount = getMarketOrderCounts();
  const oppCount   = getOpportunisticBuyCount();
  const labActive  = getActiveLabReactingCount();
  const facActive  = getActiveFactoryProducingCount();

  const tradeLine =
    '[Trade] ' +
    '🔬◀' + revCount + ' ▶' + fwdCount + ' (' + labActive + ') | ' +
    '🏭▼' + facCounts.compression + ' ▲' + facCounts.decompression + ' (' + facActive + ') | ' +
    '📦⬇' + orderCount.buys + ' ⬆' + orderCount.sells + ' | ' +
    '⌛ ' + oppCount;

  lines.push(tradeLine);

  lines.push("================================================================");

  // Single console.log — one timestamp for the whole block
  console.log(lines.join('\n'));
}

function getPerRoomRoleCounts() {
  const perRoomCounts = {};
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller && room.controller.my) {
      perRoomCounts[roomName] = {
        harvester: 0, upgrader: 0, builder: 0, remoteBuilder: 0,
        scout: 0, defender: 0, supplier: 0,
        claimbot: 0, attacker: 0, fastAttacker: 0,
        thief: 0, towerDrain: 0, drainDemolisher: 0, demolition: 0, contestedDemolisher: 0,
        defenseRepair: 0, depositHarvester: 0,
        powerBot: 0, quad: 0, maintainer: 0, skAttacker: 0,
        labBot: 0,
        hd: 0, staticDistributor: 0, comboBot: 0,
        repairer: 0,
        terminalBot: 0, extractor: 0, nukeFill: 0,
        mineralCollector: 0, signbot: 0, remoteSupplier: 0,
        controllerAttacker: 0, extractorAssistant: 0, towerFiller: 0,
      };
    }
  }
  const idx = getRoomState.creepIndex();
  const creeps = idx && idx.all ? idx.all : [];
  for (let i = 0; i < creeps.length; i++) {
    const creep = creeps[i];
    const role = creep.memory.role;
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
    if (perRoomCounts[assignedRoom] && perRoomCounts[assignedRoom][role] !== undefined) {
      perRoomCounts[assignedRoom][role]++;
    }
  }
  return perRoomCounts;
}

// ---------------------------------------------------------------
// PLAYER STATUS BOARD — pretty printer for scanner's status('Player') scan.
// scanner.js gathers the data (observer scheduler, one room per observer
// per tick) and calls printPlayerStatus(payload) when the scan completes.
// ---------------------------------------------------------------

const PLAYER_CREEP_ICONS = [
  ['worker',     '⛏'],
  ['upgrader',   '⚡'],
  ['builder',    '🔨'],
  ['repairer',   '🚧'],
  ['maintainer', '🛠'],
  ['hauler',     '🚚'],
  ['extractor',  '💎'],
  ['claimer',    '🚩'],
  ['scout',      '🔭'],
  ['demolisher', '💥'],
  ['melee',      '⚔️'],
  ['ranged',     '🏹'],
  ['healer',     '🩹'],
  ['other',      '🔧'],
];

function fmtK(v) {
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
  if (v >= 1000)    return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

function printPlayerStatus(data) {
  const lines = [];
  const title = ' PLAYER STATUS: ' + data.player + (data.status ? ' [' + data.status + ']' : '') + ' ';
  const pad = Math.max(0, 64 - title.length);
  lines.push('='.repeat(Math.ceil(pad / 2)) + title + '='.repeat(Math.floor(pad / 2)));
  lines.push('Rooms: ' + data.rooms.length + ' | Scan: ' + data.elapsed + 't' +
             (data.registryAge !== null ? ' | Registry age: ' + data.registryAge + 't' : ''));
  lines.push('----------------------------------------------------------------');

  const totals = {};
  for (const [key] of PLAYER_CREEP_ICONS) totals[key] = 0;
  let totalCreeps = 0, totalBoosted = 0, totalPower = 0, totalEnergy = 0, ownedRooms = 0;
  const nukerRooms = [], safeModeRooms = [], towersLowRooms = [], lostRooms = [], unseenRooms = [];

  for (const r of data.rooms) {
    if (!r.ok) {
      unseenRooms.push(r.name + (r.reason === 'range' ? ' (out of observer range)' : ' (never became visible)'));
      continue;
    }
    if (r.lost) {
      lostRooms.push(r.name + ' → ' + (r.owner || 'unowned'));
      continue;
    }

    ownedRooms++;
    totalCreeps  += r.totalCreeps;
    totalBoosted += r.boosted;
    totalPower   += r.power;
    totalEnergy  += (r.storageE || 0) + (r.terminalE || 0);
    for (const [key] of PLAYER_CREEP_ICONS) totals[key] += r.creeps[key] || 0;

    if (r.nuker)     nukerRooms.push(r.name + '(G:' + fmtK(r.nukerG) + ' E:' + fmtK(r.nukerE) + ')');
    if (r.safeMode)  safeModeRooms.push(r.name + '(' + r.safeMode + 't)');
    if (r.towersLow) towersLowRooms.push(r.name);

    let creepDisplay = '';
    for (const [key, emoji] of PLAYER_CREEP_ICONS) creepDisplay += icon(emoji, r.creeps[key], false);
    creepDisplay += icon('💢', r.power, false);
    creepDisplay += icon('💉', r.boosted, false);
    if (!creepDisplay) creepDisplay = 'Idle';

    let endOfLine = '';
    if (r.pct !== null) {
      endOfLine = ' | ' + r.pct.toFixed(1) + '%';
      if (r.etaTicks) endOfLine += ' ETA: ~' + formatTime(r.etaTicks * 4 / 60);
    }
    const flags = (r.safeMode ? ' 🛡️' : '') + (r.nuker ? ' ☢️' : '') + (r.towersLow ? ' 🗼!' : '');

    const col1 = (r.name + ' RCL' + r.rcl).padEnd(12);
    const col2 = ('En:' + fmtK(r.enAvail) + '/' + fmtK(r.enCap)).padEnd(16);
    const col3 = (r.storageE === null ? 'NoSto' : 'Sto:' + fmtK(r.storageE)).padEnd(9);
    const col4 = emojiPadEnd(creepDisplay, 20);

    lines.push(col1 + ' | ' + col2 + ' | ' + col3 + ' | ' + col4 + endOfLine + flags);
  }

  const iconMap = {};
  for (const [key, emoji] of PLAYER_CREEP_ICONS) iconMap[key] = emoji;
  const roleParts = Object.entries(totals)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => iconMap[key] + count);
  if (totalPower > 0) roleParts.push('💢' + totalPower);

  lines.push('Total creeps: ' + totalCreeps +
             (roleParts.length ? '  (' + roleParts.join(' ') + ')' : '') +
             (totalBoosted ? ' | 💉 ' + totalBoosted + ' boosted' : ''));
  lines.push('Total energy: ' + fmtK(totalEnergy) + ' | Avg/room: ' +
             fmtK(ownedRooms > 0 ? Math.round(totalEnergy / ownedRooms) : 0) +
             ' (storage + terminal)');

  const threatParts = [];
  if (nukerRooms.length)     threatParts.push('☢️ ' + nukerRooms.join(', '));
  if (safeModeRooms.length)  threatParts.push('🛡️ ' + safeModeRooms.join(', '));
  if (towersLowRooms.length) threatParts.push('🗼 empty: ' + towersLowRooms.join(', '));
  if (threatParts.length) lines.push('Threats: ' + threatParts.join(' | '));
  if (lostRooms.length)   lines.push('Lost rooms: ' + lostRooms.join(', '));
  if (unseenRooms.length) lines.push('Not seen: ' + unseenRooms.join(', '));

  lines.push('================================================================');
  console.log(lines.join('\n'));
}

global.status = function(playerName) {
  if (typeof playerName === 'string' && playerName.length > 0) {
    require('scanner').player.statusScan(playerName);
    return;
  }
  run(getPerRoomRoleCounts());
};

module.exports = { init, run, getPerRoomRoleCounts, printPlayerStatus };
