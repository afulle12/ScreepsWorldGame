// LLM: Read docs/codex.js before reviewing or changing this file.
// statusReport.js
// Console globals: status
// Example: status('playerName') - Show high-level empire & defense status overview
//   status()
//     Print the colony status board: CPU/bucket/GCL header, one row per
//     owned room (RCL, energy, storage, creep role emoji, RCL ETA),
//     total creep counts, energy summary, daily income, trade summary.
//   status('PlayerName')
const getRoomState = require("getRoomState");
const singleSourceRoom = require("singleSourceRoom");
const marketPricing = require("marketPricing");
const memoryManager = require("memoryManager");
const autoTrader = require("autoTrader");
const util = require("util");
let ENABLE_CPU_LOGGING = false;
let DISABLE_CPU_CONSOLE = true;
function getMarketOrderCounts() {
  let e = 0;
  let t = 0;
  if (Game.market && Game.market.orders) {
    for (const o in Game.market.orders) {
      const r = Game.market.orders[o];
      if (r && util.getOrderRemaining(r) > 0) {
        if (r.type === ORDER_BUY) e++; else if (r.type === ORDER_SELL) t++;
      }
    }
  }
  return {
    buys: e,
    sells: t
  };
}

function getSellOrderInventoryValue() {
  let e = 0;
  if (Game.market && Game.market.orders) {
    for (const t in Game.market.orders) {
      const o = Game.market.orders[t];
      if (o && util.getOrderRemaining(o) > 0 && o.type === ORDER_SELL) {
        e += util.getOrderRemaining(o) * o.price;
      }
    }
  }
  return e;
}

function getArbitrageBufferValue() {
  let e = 0;
  const t = Memory.marketArbitrage && Memory.marketArbitrage.buffered;
  if (t && Array.isArray(t)) {
    for (let o = 0; o < t.length; o++) {
      const r = t[o];
      if (r && r.amount > 0 && r.sellPrice > 0) {
        e += r.amount * r.sellPrice;
      }
    }
  }
  return e;
}

function init(e, t) {
  ENABLE_CPU_LOGGING = e;
  DISABLE_CPU_CONSOLE = t;
}

function formatTime(e) {
  const t = Math.floor(e / (24 * 60));
  const o = Math.floor(e % (24 * 60) / 60);
  const r = Math.floor(e % 60);
  if (t > 0) {
    return o > 0 ? t + "d " + o + "h " + r + "m" : t + "d " + r + "m";
  } else if (o > 0) {
    return o + "h " + r + "m";
  } else {
    return r + "m";
  }
}

function getPerformanceData() {
  let e = 0;
  let t = 0;
  let o = 0;
  const r = require("memoryManager").heap.cpuStats;
  if (r && r.history && r.history.length > 0) {
    const n = r.history;
    e = Math.min.apply(null, n);
    t = Math.max.apply(null, n);
    o = n.reduce(function(e, t) {
      return e + t;
    }, 0) / n.length;
  }
  return {
    cpuAverage: o,
    cpuMin: e,
    cpuMax: t
  };
}

function calculateTotalEnergy() {
  let e = 0;
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (!o.controller || !o.controller.my) continue;
    if (o.storage && o.storage.store) {
      e += o.storage.store.getUsedCapacity(RESOURCE_ENERGY);
    }
  }
  return e;
}

function emojiPadEnd(e, t) {
  let o = 0;
  for (let t = 0; t < e.length; t++) {
    const r = e.codePointAt(t);
    if (r > 65535) {
      o++;
      t++;
    }
  }
  const r = /[\u26CF\u26A1\u2692\u2694\u2699]/g;
  const n = e.match(r);
  if (n) o += n.length;
  return e.padEnd(Math.max(0, t - o));
}

function icon(e, t, o) {
  if (!o && (t || 0) === 0) return "";
  return " " + e + (t || 0);
}

function getStatusEnergyPrice() {
  return marketPricing.getStatusEnergyPrice();
}

function run(e) {
  const t = [];
  const o = getStatusEnergyPrice();
  const r = 5e3;
  const n = 100;
  if (!Memory.gclTracker) {
    Memory.gclTracker = {
      anchor: null,
      lastLevel: Game.gcl.level,
      etaString: "",
      lastSampleTick: null
    };
    memoryManager.requestSave();
  } else if (typeof Memory.gclTracker.lastSampleTick !== "number") {
    Memory.gclTracker.lastSampleTick = null;
    memoryManager.requestSave();
  }
  const a = Memory.gclTracker;
  const s = a.lastSampleTick === null || a.lastSampleTick > Game.time || Game.time - a.lastSampleTick >= n;
  if (s) {
    const e = Game.gcl.progress / Game.gcl.progressTotal * 100;
    const t = a;
    if (!t.anchor || t.lastLevel !== Game.gcl.level || Game.time - t.anchor.tick >= r) {
      t.anchor = {
        tick: Game.time,
        percent: e
      };
      t.lastLevel = Game.gcl.level;
      t.etaString = "";
    } else {
      const o = Game.time - t.anchor.tick;
      const r = e - t.anchor.percent;
      if (o >= n && r > 0) {
        const n = r / o;
        const a = 100 - e;
        const s = Math.ceil(a / n);
        const i = s * 4;
        const l = Math.floor(i / 86400);
        const c = Math.floor(i % 86400 / 3600);
        const m = Math.floor(i % 3600 / 60);
        t.etaString = l + "d " + c + "h " + m + "m";
      } else {
        t.etaString = "∞";
      }
    }
    a.lastSampleTick = Game.time;
    memoryManager.requestSave();
  }
  const i = (Game.gcl.progress / Game.gcl.progressTotal * 100).toFixed(1);
  const l = Memory.gclTracker.etaString ? " ETA: " + Memory.gclTracker.etaString : "";
  const c = "GCL " + Game.gcl.level + " " + i + "%" + l;
  const m = {};
  const f = getRoomState.creepIndex();
  const u = f && f.all ? f.all : [];
  for (let e = 0; e < u.length; e++) {
    const t = u[e];
    const o = t.memory.homeRoom || t.memory.assignedRoom || t.room.name;
    if (!m[o]) m[o] = {
      totalCreeps: 0,
      powerCreeps: 0
    };
    m[o].totalCreeps++;
  }
  for (const e in Game.powerCreeps) {
    const t = Game.powerCreeps[e];
    if (!t.room) continue;
    const o = t.room.name;
    if (!m[o]) m[o] = {
      totalCreeps: 0,
      powerCreeps: 0
    };
    m[o].powerCreeps++;
    m[o].totalCreeps++;
  }
  t.push("======================== COLONY STATUS =========================");
  const p = getPerformanceData();
  if (!ENABLE_CPU_LOGGING || !DISABLE_CPU_CONSOLE) {
    const e = Math.round(Game.cpu.bucket / 1e4 * 100);
    const o = Game.cpu.bucket >= 1e4 ? "FULL" : e + "%";
    const r = memoryManager.getSerializationReserveStats();
    const n = r.hitRate * 100;
    t.push("CPU Min: " + Math.round(p.cpuMin) + " Avg: " + Math.round(p.cpuAverage) + " Max: " + Math.round(p.cpuMax) + " Mem: " + r.amortizedCpu.toFixed(3) + " (" + (r.hitRate * 100).toFixed(1) + "% hit)" + " Save" + (r.recentTicks || 0) + ": " + n.toFixed(1) + "%" + " | Bucket: " + Game.cpu.bucket + " (" + o + ")" + " | " + c);
  } else {
    t.push(c);
  }
  t.push("----------------------------------------------------------------");
  if (!Memory.progressTracker) Memory.progressTracker = {};
  const g = Object.keys(Game.rooms).sort();
  for (const o of g) {
    const r = Game.rooms[o];
    if (!r.controller || !r.controller.my) continue;
    const n = r.controller.progress / r.controller.progressTotal * 100;
    if (!Memory.progressTracker[o]) {
      Memory.progressTracker[o] = {
        level: r.controller.level,
        anchor: {
          tick: Game.time,
          percent: n
        }
      };
    }
    const a = Memory.progressTracker[o];
    if (a.level !== r.controller.level || Game.time - a.anchor.tick >= 500) {
      a.level = r.controller.level;
      a.anchor = {
        tick: Game.time,
        percent: n
      };
    }
    let s = "";
    if (r.controller.level < 8) {
      const e = Game.time - a.anchor.tick;
      const t = n - a.anchor.percent;
      if (e >= 100 && t > 0) {
        const o = 100 - n;
        const r = t / e;
        const a = Math.ceil(o / r);
        const i = a * 4 / 60;
        s = "ETA: ~" + formatTime(i) + " (" + n.toFixed(1) + "%)";
      }
    }
    const i = e[o] || {};
    const l = m[o] || {
      totalCreeps: 0
    };
    const c = r.energyAvailable >= 1e3 ? (r.energyAvailable / 1e3).toFixed(1) + "k" : r.energyAvailable;
    const f = r.energyCapacityAvailable >= 1e3 ? (r.energyCapacityAvailable / 1e3).toFixed(1) + "k" : r.energyCapacityAvailable;
    let u = "NoSto";
    if (r.storage && r.storage.store) {
      const e = r.storage.store[RESOURCE_ENERGY];
      u = "Sto:" + (e >= 1e3 ? (e / 1e3).toFixed(0) + "k" : e);
    }
    let p = "";
    if (l.totalCreeps === 0) {
      p = "Idle";
    } else if (singleSourceRoom.isSingleSourceActive(o)) {
      p = icon("⛏", i.hd, true) + icon("🛠", i.maintainer, false) + icon("🔨", i.builder, false) + icon("🔧", i.comboBot, false) + icon("🔋", i.staticDistributor, true) + icon("🧪", i.labBot, false) + icon("📡", i.terminalBot, false) + icon("💎", i.extractor, false) + icon("🗼", i.towerFiller, false) + icon("💠", i.mineralCollector, false) + icon("🪣", i.extractorAssistant, false) + icon("🔩", i.defenseRepair, false) + icon("🌾", i.depositHarvester, false) + icon("☢️", i.nukeFill, false) + icon("🌀", i.towerDrain, false) + icon("🧨", i.drainDemolisher, false) + icon("🔭", i.scout, false) + icon("🚚", i.remoteSupplier, false) + icon("🪧", i.signbot, false) + icon("🗡️", i.defender, false) + icon("⚔️", i.attacker, false) + icon("🏹", i.harasser, false) + icon("💚", i.healer, false) + icon("💨", i.fastAttacker, false) + icon("🥷", i.skAttacker, false) + icon("🤖", i.quad, false) + icon("🔓", i.controllerAttacker, false) + icon("🦹", i.thief, false) + icon("🧹", i.scavenger, false) + icon("🚩", i.claimbot, false) + icon("💥", i.demolition, false) + icon("💣", i.contestedDemolisher, false) + icon("🪖", i.squad, false) + icon("🧠", i.operator, false) + icon("💢", l.powerCreeps, false);
    } else {
      p = icon("⛏", i.harvester, true) + icon("🛠", i.maintainer, false) + icon("🔨", i.builder, false) + icon("🏗️", i.remoteBuilder, false) + icon("⚡", i.upgrader, false) + icon("🔋", i.supplier, true) + icon("🔧", i.comboBot, false) + icon("🧪", i.labBot, false) + icon("🚧", i.repairer, false) + icon("🔩", i.defenseRepair, false) + icon("📡", i.terminalBot, false) + icon("💎", i.extractor, false) + icon("💠", i.mineralCollector, false) + icon("🪣", i.extractorAssistant, false) + icon("🌾", i.depositHarvester, false) + icon("🔌", i.powerBot, false) + icon("☢️", i.nukeFill, false) + icon("🌀", i.towerDrain, false) + icon("🧨", i.drainDemolisher, false) + icon("🔭", i.scout, false) + icon("🚚", i.remoteSupplier, false) + icon("🪧", i.signbot, false) + icon("🗡️", i.defender, false) + icon("⚔️", i.attacker, false) + icon("🏹", i.harasser, false) + icon("💚", i.healer, false) + icon("💨", i.fastAttacker, false) + icon("🥷", i.skAttacker, false) + icon("🤖", i.quad, false) + icon("🔓", i.controllerAttacker, false) + icon("🦹", i.thief, false) + icon("🧹", i.scavenger, false) + icon("🚩", i.claimbot, false) + icon("🗼", i.towerFiller, false) + icon("💥", i.demolition, false) + icon("💣", i.contestedDemolisher, false) + icon("🪖", i.squad, false) + icon("🧠", i.operator, false) + icon("💢", l.powerCreeps, false);
    }
    const g = (o + " RCL" + r.controller.level).padEnd(12);
    const d = ("En:" + c + "/" + f).padEnd(16);
    const h = u.padEnd(9);
    const y = emojiPadEnd(p, 20);
    const k = s ? " | " + s : "";
    t.push(g + " | " + d + " | " + h + " | " + y + k);
  }
  let d = 0;
  const h = {};
  for (let e = 0; e < u.length; e++) {
    const t = u[e];
    const o = t.memory.role;
    if (o) h[o] = (h[o] || 0) + 1;
    d++;
  }
  let y = 0;
  for (const e in Game.powerCreeps) {
    if (Game.powerCreeps[e].room) y++;
  }
  if (y > 0) d += y;
  const k = {
    harvester: "⛏",
    hd: "⛏",
    maintainer: "🛠",
    builder: "🔨",
    remoteBuilder: "🏗️",
    upgrader: "⚡",
    supplier: "🔋",
    staticDistributor: "🔋",
    comboBot: "🔧",
    repairer: "🚧",
    defenseRepair: "🔩",
    labBot: "🧪",
    terminalBot: "📡",
    extractor: "💎",
    mineralCollector: "💠",
    extractorAssistant: "🪣",
    depositHarvester: "🌾",
    powerBot: "🔌",
    towerFiller: "🗼",
    nukeFill: "☢️",
    towerDrain: "🌀",
    drainDemolisher: "🧨",
    scout: "🔭",
    remoteSupplier: "🚚",
    signbot: "🪧",
    defender: "🗡️",
    attacker: "⚔️",
    harasser: "🏹",
    healer: "💚",
    fastAttacker: "💨",
    skAttacker: "🥷",
    quad: "🤖",
    controllerAttacker: "🔓",
    thief: "🦹",
    scavenger: "🧹",
    claimbot: "🚩",
    demolition: "💥",
    contestedDemolisher: "💣",
    operator: "🧠",
    squad: "🪖"
  };
  if (h.hd) {
    h.harvester = (h.harvester || 0) + h.hd;
    delete h.hd;
  }
  if (h.staticDistributor) {
    h.supplier = (h.supplier || 0) + h.staticDistributor;
    delete h.staticDistributor;
  }
  if (y > 0) h["💢_powerCreep"] = y;
  const E = Object.entries(h).sort((e, t) => t[1] - e[1]).map(([e, t]) => {
    if (e === "💢_powerCreep") return "💢" + t;
    return (k[e] || e) + t;
  });
  const S = Memory.stats && typeof Memory.stats.kills === "number" ? Memory.stats.kills : 0;
  t.push("Total creeps: " + d + "  (" + E.join(" ") + ")" + " | Kills: " + S);
  const b = calculateTotalEnergy();
  const M = Object.keys(Game.rooms).filter(e => {
    const t = Game.rooms[e];
    return t.controller && t.controller.my;
  });
  const C = M.length > 0 ? Math.round(b / M.length) : 0;
  const v = b >= 1e6 ? (b / 1e6).toFixed(2) + "M" : b >= 1e3 ? (b / 1e3).toFixed(1) + "k" : b;
  const R = C >= 1e3 ? (C / 1e3).toFixed(1) + "k" : C;
  // ⚡ Mkt is replacement cost: the cheaper of resting the most competitive bid
  // (freight-free) or taking a live ask (we deal, so we pay the transfer). The
  // suffix names which route is winning and, for a direct take, where from.
  const A = o.toFixed(3);
  const q = marketPricing.energyAcquisitionQuote();
  let Q = "";
  if (q.route === "DIRECT" && q.direct) {
    Q = " (buy " + q.direct.sellerRoom + "→" + q.direct.destinationRoom + " @" + q.direct.price.toFixed(2) + " +" + Math.round((1 - q.direct.yield) * 100) + "% freight" + (q.bid ? ", bid " + q.bid.toFixed(2) : "") + ")";
  } else if (q.route === "BID") {
    Q = " (bid" + (q.direct ? ", direct " + q.direct.delivered.toFixed(2) : "") + ")";
  }
  t.push("Total energy: " + v + " | Avg/room: " + R + " | ⚡ Mkt: " + A + "/u" + Q);
  const G = Memory.dailyFinance;
  let x = "";
  if (G && G.totalIncome > 0) {
    const e = G.totalIncome >= 1e6 ? (G.totalIncome / 1e6).toFixed(2) + "M" : G.totalIncome >= 1e3 ? (G.totalIncome / 1e3).toFixed(1) + "k" : G.totalIncome;
    const t = (G.totalExpenses || 0) >= 1e6 ? ((G.totalExpenses || 0) / 1e6).toFixed(2) + "M" : (G.totalExpenses || 0) >= 1e3 ? ((G.totalExpenses || 0) / 1e3).toFixed(1) + "k" : G.totalExpenses || 0;
    const o = G.totalIncome - (G.totalExpenses || 0);
    const r = Math.abs(o);
    const n = r >= 1e6 ? (r / 1e6).toFixed(2) + "M" : r >= 1e3 ? (r / 1e3).toFixed(1) + "k" : r;
    const a = o >= 0 ? "+" : "-";
    const s = (G.totalSalesTx || 0) + (G.totalPurchasesTx || 0);
    const i = getSellOrderInventoryValue();
    const l = getArbitrageBufferValue();
    const c = i + l;
    const m = c >= 1e6 ? (c / 1e6).toFixed(2) + "M" : c >= 1e3 ? (c / 1e3).toFixed(1) + "k" : c;
    x = "Daily income: " + e + " | Expenses: " + t + " | Net: " + a + n + " | Inv: " + m + " | Tx: " + s + " (" + (G.totalSalesTx || 0) + "s/" + (G.totalPurchasesTx || 0) + "b)";
  } else if (G) {
    x = "Daily income: 0 | Inv: 0 | Tx: 0 (no transactions yet today)";
  }
  if (x) {
    t.push(x);
  }
  const T = autoTrader.getStatusSnapshot();
  const P = getMarketOrderCounts();
  const w = "[Trade] " + "🔬◀" + T.lab.reverse + " ▶" + T.lab.forward + " (B" + T.lab.buying + " W" + T.lab.waiting + " P" + T.lab.processing + ") | " + "🏭▼" + T.factory.compression + " ▲" + T.factory.decompression + " (B" + T.factory.buying + " Q" + T.factory.queued + " P" + T.factory.processing + ") | " + "📦⬇" + P.buys + " ⬆" + P.sells + " | " + "⌛ " + T.opportunistic;
  t.push(w);
  t.push("================================================================");
  console.log(t.join("\n"));
}

function getPerRoomRoleCounts() {
  const e = {};
  for (const t in Game.rooms) {
    const o = Game.rooms[t];
    if (o.controller && o.controller.my) {
      e[t] = {
        harvester: 0,
        upgrader: 0,
        builder: 0,
        remoteBuilder: 0,
        scout: 0,
        defender: 0,
        supplier: 0,
        claimbot: 0,
        attacker: 0,
        harasser: 0,
        healer: 0,
        fastAttacker: 0,
        thief: 0,
        scavenger: 0,
        towerDrain: 0,
        drainDemolisher: 0,
        demolition: 0,
        contestedDemolisher: 0,
        defenseRepair: 0,
        depositHarvester: 0,
        powerBot: 0,
        quad: 0,
        maintainer: 0,
        skAttacker: 0,
        labBot: 0,
        hd: 0,
        staticDistributor: 0,
        comboBot: 0,
        repairer: 0,
        terminalBot: 0,
        extractor: 0,
        nukeFill: 0,
        mineralCollector: 0,
        signbot: 0,
        remoteSupplier: 0,
        controllerAttacker: 0,
        extractorAssistant: 0,
        towerFiller: 0,
        operator: 0,
        squad: 0
      };
    }
  }
  const t = getRoomState.creepIndex();
  const o = t && t.all ? t.all : [];
  for (let t = 0; t < o.length; t++) {
    const r = o[t];
    const n = r.memory.role === "wallRepair" || r.memory.role === "rampartBot" ? "repairer" : r.memory.role;
    const a = r.memory.homeRoom || r.memory.assignedRoom || r.room.name;
    if (e[a] && e[a][n] !== undefined) {
      e[a][n]++;
    }
  }
  return e;
}

const PLAYER_CREEP_ICONS = [ [ "worker", "⛏" ], [ "upgrader", "⚡" ], [ "builder", "🔨" ], [ "repairer", "🚧" ], [ "maintainer", "🛠" ], [ "hauler", "🚚" ], [ "extractor", "💎" ], [ "claimer", "🚩" ], [ "scout", "🔭" ], [ "demolisher", "💥" ], [ "melee", "⚔️" ], [ "ranged", "🏹" ], [ "healer", "🩹" ], [ "other", "🔧" ] ];
function fmtK(e) {
  if (e >= 1e6) return (e / 1e6).toFixed(2) + "M";
  if (e >= 1e3) return (e / 1e3).toFixed(1) + "k";
  return String(e);
}

function printPlayerStatus(e) {
  const t = [];
  const o = " PLAYER STATUS: " + e.player + (e.status ? " [" + e.status + "]" : "") + " ";
  const r = Math.max(0, 64 - o.length);
  t.push("=".repeat(Math.ceil(r / 2)) + o + "=".repeat(Math.floor(r / 2)));
  t.push("Rooms: " + e.rooms.length + " | Scan: " + e.elapsed + "t" + (e.registryAge !== null ? " | Registry age: " + e.registryAge + "t" : ""));
  t.push("----------------------------------------------------------------");
  const n = {};
  for (const [e] of PLAYER_CREEP_ICONS) n[e] = 0;
  let a = 0, s = 0, i = 0, l = 0, c = 0;
  const m = {};
  const f = [], u = [], p = [], g = [], d = [];
  for (const o of e.rooms) {
    if (!o.ok) {
      d.push(o.name + (o.reason === "range" ? " (out of observer range)" : " (never became visible)"));
      continue;
    }
    if (o.lost) {
      g.push(o.name + " → " + (o.owner || "unowned"));
      continue;
    }
    c++;
    a += o.totalCreeps;
    s += o.boosted;
    i += o.power;
    l += (o.storageE || 0) + (o.terminalE || 0);
    for (const e in o.inventory || {}) {
      m[e] = (m[e] || 0) + o.inventory[e];
    }
    for (const [e] of PLAYER_CREEP_ICONS) n[e] += o.creeps[e] || 0;
    if (o.nuker) f.push(o.name + "(G:" + fmtK(o.nukerG) + " E:" + fmtK(o.nukerE) + ")");
    if (o.safeMode) u.push(o.name + "(" + o.safeMode + "t)");
    if (o.towersLow) p.push(o.name);
    let e = "";
    for (const [t, r] of PLAYER_CREEP_ICONS) e += icon(r, o.creeps[t], false);
    e += icon("💢", o.power, false);
    e += icon("💉", o.boosted, false);
    if (!e) e = "Idle";
    let r = "";
    if (o.pct !== null) {
      r = " | " + o.pct.toFixed(1) + "%";
      if (o.etaTicks) r += " ETA: ~" + formatTime(o.etaTicks * 4 / 60);
    }
    const h = (o.safeMode ? " 🛡️" : "") + (o.nuker ? " ☢️" : "") + (o.towersLow ? " 🗼!" : "");
    const y = (o.name + " RCL" + o.rcl).padEnd(12);
    const k = ("En:" + fmtK(o.enAvail) + "/" + fmtK(o.enCap)).padEnd(16);
    const E = (o.storageE === null ? "NoSto" : "Sto:" + fmtK(o.storageE)).padEnd(9);
    const S = emojiPadEnd(e, 20);
    t.push(y + " | " + k + " | " + E + " | " + S + r + h);
  }
  const h = {};
  for (const [e, t] of PLAYER_CREEP_ICONS) h[e] = t;
  const y = Object.entries(n).filter(([, e]) => e > 0).sort((e, t) => t[1] - e[1]).map(([e, t]) => h[e] + t);
  if (i > 0) y.push("💢" + i);
  t.push("Total creeps: " + a + (y.length ? "  (" + y.join(" ") + ")" : "") + (s ? " | 💉 " + s + " boosted" : ""));
  t.push("Total energy: " + fmtK(l) + " | Avg/room: " + fmtK(c > 0 ? Math.round(l / c) : 0) + " (storage + terminal)");
  let k = 0;
  for (const e in m) {
    k += m[e] * (marketPricing.liquidationPrice(e) || 0);
  }
  t.push("Est. inventory: ~" + fmtK(k) + " liq. | storage + terminal | " + c + "/" + e.rooms.length + " rooms visible");
  const E = [];
  if (f.length) E.push("☢️ " + f.join(", "));
  if (u.length) E.push("🛡️ " + u.join(", "));
  if (p.length) E.push("🗼 empty: " + p.join(", "));
  if (E.length) t.push("Threats: " + E.join(" | "));
  if (g.length) t.push("Lost rooms: " + g.join(", "));
  if (d.length) t.push("Not seen: " + d.join(", "));
  t.push("================================================================");
  console.log(t.join("\n"));
}

global.status = function(e) {
  if (typeof e === "string" && e.length > 0) {
    require("scanner").player.statusScan(e);
    return;
  }
  run(getPerRoomRoleCounts());
};
module.exports = {
  init: init,
  run: run,
  getPerRoomRoleCounts: getPerRoomRoleCounts,
  printPlayerStatus: printPlayerStatus
};
