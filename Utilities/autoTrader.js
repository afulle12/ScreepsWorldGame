// LLM: Read docs/codex.js before reviewing or changing this file.
// autoTrader.js
// Console globals: autoTrader, selling, buying, autoTraderPassiveScan, autoTraderPassiveScanJSON, showAllProduction
// Example: autoTrader('status') - Run automated market trading cycle or query status
// Example: selling('show', 'E1N1') - Query or configure sell policies for room
// Example: buying('show', 'E1N1') - Query or configure buy policies for room
// Example: autoTraderPassiveScan() - Print passive factory scan report for trading
// Example: autoTraderPassiveScanJSON() - Export passive factory scan results as JSON
// Example: showAllProduction() - Display comprehensive factory production status across rooms
const getRoomState = require("getRoomState");
const pricing = require("marketPricing");
const marketAnalysis = require("marketAnalysis");
const marketEconomics = require("marketEconomics");
const roomSuspender = require("roomSuspender");
const util = require("util");
const memoryManager = require("memoryManager");
const marketLab = require("marketLab");
const marketRefine = require("marketRefine");
const localRefine = require("localRefine");
const labManager = require("labManager");
const factoryManager = require("factoryManager");
const factorySlots = require("factorySlots");
const marketSeller = require("marketSell");
const marketBuyer = require("marketBuy");
const marketBatchBuy = require("marketBatchBuy");
const opportunisticBuy = require("opportunisticBuy");
const marketSales = require("marketSales");
const storageManager = require("storageManager");
const autoTraderSellPolicy = require("autoTraderSellPolicy");
const labCommodityPolicy = require("labCommodityPolicy");
const labCommodityRouter = require("labCommodityRouter");
const labReactionPipeline = require("labReactionPipeline");
const LAB_REACTION_AMOUNT = labCommodityPolicy.MIN_REACTION_AMOUNT;
const ENABLED = true;
const ENABLE_LAB_JOBS = true;
const ENABLE_FACTORY_JOBS = true;
const ENABLE_FACTORY_DECOMPRESSION = true;
const RUN_INTERVAL = 100;
const MAX_REVERSE_REACTIONS = 10;
const MAX_FORWARD_REACTIONS = 10;
const MAX_LAB_OPS_PER_ROOM = 3;
const MAX_FACTORY_JOBS = 10;
const MAX_FACTORY_OPS_PER_ROOM = factorySlots.MAX_OPS_PER_ROOM;
const MIN_STORAGE_ENERGY = 15e4;
const MIN_LAB_STORAGE_ENERGY = 5e4;
const REQUIRED_SOURCES = 1;
const MIN_LABS = 3;
const SELL_LIQUIDITY_DAYS = 14;
const SELL_LIQUIDITY_SHARE = .25;
const MIN_SELL_EXPOSURE = 10;
const MAX_SELL_EXPOSURE = 1e5;
const OUR_SHARE_SOFT_MAX = .2;
const MIN_SELL_HISTORY_DAYS = 4;
const FACTORY_JOB_COOLDOWN = 100;
const JOBS_HISTORY_CAP = 30;
const MARKET_REFINE_BATCH_MULTIPLIER = 12;
const LAB_PROJECTED_OUTPUT = 3e3;
const FULL_PIPELINE_OUTPUT = 1500;
const BATCH_LAB_MIN_OUTPUT = 500;
const BATCH_LAB_MAX_OUTPUT = 3e3;
const BATCH_FACTORY_MAX_OUTPUT = 5e3;
const BATCH_FACTORY_MAX_CYCLES = MARKET_REFINE_BATCH_MULTIPLIER;
const BATCH_ORDER_SCAN_LIMIT = 8;
const TWO_STEP_MAX_PRODUCERS_PER_OUTPUT = 3;
const TWO_STEP_MAX_CHAINS = 20;
const TWO_STEP_MAX_EXECUTIONS_PER_RUN = 2;
const TWO_STEP_MAX_ATTEMPTS = 3;
const TWO_STEP_RETRY_TICKS = 100;
const TWO_STEP_MAX_BREAKDOWN_DEPTH = 4;
const TWO_STEP_MAX_BREAKDOWN_NODES = 12;
const FULL_TWO_STEP_SCAN_INTERVAL = 1e3;
const CPU_EMERGENCY_BUCKET = 1e3;
const CPU_EMERGENCY_MIN_FREE_CPU = 2;
const BATCH_DISCOVERY_MIN_BUCKET = 2e3;
const BATCH_DISCOVERY_CPU_BUDGET = 2.5;
const BATCH_DISCOVERY_MIN_FREE_CPU = 2;
const FULL_PIPELINE_DIAGNOSTIC_MIN_BUCKET = 3e3;
const USE_LEARNED_DURATIONS = false;
const MIN_START_CREDITS_PER_TICK = 10;
const MINERAL_RUN_INTERVAL = 5e3;
const INVENTORY_SELL_COOLDOWN = 300;
const DEPOSIT_RUN_INTERVAL = INVENTORY_SELL_COOLDOWN;
const RESIDUE_RUN_INTERVAL = 5e3;
const OPS_RESERVE = 5e3;
const MINERAL_PER_BAR = 5;
const ENERGY_PER_BAR = 2;
let tickCache = null;
function shouldDeferAutoTraderCpu() {
  if (!Game || !Game.cpu) return false;
  const e = typeof Game.cpu.bucket === "number" ? Game.cpu.bucket : 1e4;
  if (e < CPU_EMERGENCY_BUCKET) return true;
  const t = typeof Game.cpu.limit === "number" ? Game.cpu.limit : 20;
  const r = typeof Game.cpu.getUsed === "function" ? Game.cpu.getUsed() : 0;
  return t - r < CPU_EMERGENCY_MIN_FREE_CPU;
}

function allowBatchDiscovery() {
  if (shouldDeferAutoTraderCpu()) return false;
  const e = typeof Game.cpu.bucket === "number" ? Game.cpu.bucket : 1e4;
  if (e < BATCH_DISCOVERY_MIN_BUCKET) return false;
  const t = typeof Game.cpu.limit === "number" ? Game.cpu.limit : 20;
  const r = typeof Game.cpu.getUsed === "function" ? Game.cpu.getUsed() : 0;
  return t - r >= BATCH_DISCOVERY_MIN_FREE_CPU;
}

function batchDiscoveryWithinBudget(e) {
  if (!Game || !Game.cpu || typeof Game.cpu.getUsed !== "function") return true;
  return Game.cpu.getUsed() - e < BATCH_DISCOVERY_CPU_BUDGET;
}

function getTickCache() {
  if (!tickCache || tickCache.tick !== Game.time) {
    tickCache = {
      tick: Game.time,
      sellExposureCaps: {},
      supplierRooms: null,
      labOperations: {},
      labOperationsByRoom: {},
      batchSellOrders: {},
      batchSellOrdersRaw: null
    };
  }
  return tickCache;
}

function getLabOperations(e) {
  const t = getTickCache();
  const r = e || "all";
  if (!Object.prototype.hasOwnProperty.call(t.labOperations, r)) {
    t.labOperations[r] = marketLab.getOperations(e);
  }
  return t.labOperations[r];
}

function getLabOperationsForRoom(e) {
  const t = getTickCache();
  if (!Object.prototype.hasOwnProperty.call(t.labOperationsByRoom, e)) {
    t.labOperationsByRoom[e] = getLabOperations().filter(function(t) {
      return t && t.room === e;
    });
  }
  return t.labOperationsByRoom[e];
}

function beginCpuProfile(e) {
  return {
    kind: e,
    tick: Game.time,
    start: Game.cpu.getUsed(),
    phases: {}
  };
}

function beginCpuPhase(e) {
  return e ? Game.cpu.getUsed() : 0;
}

function endCpuPhase(e, t, r) {
  if (!e) return;
  const o = Game.cpu.getUsed() - r;
  e.phases[t] = (e.phases[t] || 0) + o;
}

function finishCpuProfile(e) {
  if (!e || !memoryManager.heap) return;
  if (!memoryManager.heap.autoTraderCpu) memoryManager.heap.autoTraderCpu = {};
  memoryManager.heap.autoTraderCpu[e.kind] = {
    tick: e.tick,
    total: Game.cpu.getUsed() - e.start,
    phases: e.phases
  };
}

const MINERAL_ROUTES = [ {
  raw: RESOURCE_UTRIUM,
  bar: RESOURCE_UTRIUM_BAR
}, {
  raw: RESOURCE_LEMERGIUM,
  bar: RESOURCE_LEMERGIUM_BAR
}, {
  raw: RESOURCE_KEANIUM,
  bar: RESOURCE_KEANIUM_BAR
}, {
  raw: RESOURCE_ZYNTHIUM,
  bar: RESOURCE_ZYNTHIUM_BAR
}, {
  raw: RESOURCE_GHODIUM,
  bar: RESOURCE_GHODIUM_MELT
}, {
  raw: RESOURCE_OXYGEN,
  bar: RESOURCE_OXIDANT
}, {
  raw: RESOURCE_HYDROGEN,
  bar: RESOURCE_REDUCTANT
}, {
  raw: RESOURCE_CATALYST,
  bar: RESOURCE_PURIFIER
} ];
const HIGHWAY_DEPOSITS = [ RESOURCE_BIOMASS, RESOURCE_METAL, RESOURCE_MIST, RESOURCE_SILICON ];
const COMMODITY_RESIDUE_BLACKLIST = function() {
  const e = {};
  if (typeof RESOURCE_ENERGY !== "undefined") e[RESOURCE_ENERGY] = true;
  if (typeof RESOURCE_POWER !== "undefined") e[RESOURCE_POWER] = true;
  if (typeof RESOURCE_OPS !== "undefined") e[RESOURCE_OPS] = true;
  if (typeof RESOURCE_BATTERY !== "undefined") e[RESOURCE_BATTERY] = true;
  return e;
}();
const BASE_MINERAL_RAW_INPUTS = [ RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST, RESOURCE_GHODIUM ];
const COMPRESSED_BAR_RESOURCES = [ RESOURCE_REDUCTANT, RESOURCE_OXIDANT, RESOURCE_UTRIUM_BAR, RESOURCE_LEMERGIUM_BAR, RESOURCE_KEANIUM_BAR, RESOURCE_ZYNTHIUM_BAR, RESOURCE_PURIFIER, RESOURCE_GHODIUM_MELT ];
const MINERAL_RESIDUE_EXCLUSION = function() {
  const e = {};
  for (let t = 0; t < BASE_MINERAL_RAW_INPUTS.length; t++) e[BASE_MINERAL_RAW_INPUTS[t]] = true;
  for (let t = 0; t < COMPRESSED_BAR_RESOURCES.length; t++) e[COMPRESSED_BAR_RESOURCES[t]] = true;
  return e;
}();
const BANNED_FACTORY_PRODUCTS = [ RESOURCE_ENERGY ];
function reactionTimeFor(e) {
  if (marketAnalysis && typeof marketAnalysis.reactionTimeFor === "function") {
    return marketAnalysis.reactionTimeFor(e);
  }
  if (typeof REACTION_TIME !== "undefined" && REACTION_TIME && typeof REACTION_TIME[e] === "number") {
    return REACTION_TIME[e];
  }
  return 10;
}

function factoryCooldownFor(e) {
  if (marketAnalysis && typeof marketAnalysis.factoryCooldownFor === "function") {
    return marketAnalysis.factoryCooldownFor(e);
  }
  if (COMMODITIES && COMMODITIES[e] && typeof COMMODITIES[e].cooldown === "number") {
    return COMMODITIES[e].cooldown;
  }
  return 20;
}

const LOCAL_REFINE_PRODUCTS = [ RESOURCE_BATTERY ];
const LOCAL_REFINE_ENERGY_RESERVE = 2e5;
const LEVEL_0_FACTORY_PRODUCTS = [ RESOURCE_UTRIUM_BAR, RESOURCE_LEMERGIUM_BAR, RESOURCE_ZYNTHIUM_BAR, RESOURCE_KEANIUM_BAR, RESOURCE_GHODIUM_MELT, RESOURCE_OXIDANT, RESOURCE_REDUCTANT, RESOURCE_PURIFIER, RESOURCE_BATTERY, RESOURCE_WIRE, RESOURCE_CELL, RESOURCE_ALLOY, RESOURCE_CONDENSATE ];
const LEVEL_1_FACTORY_PRODUCTS = [ RESOURCE_COMPOSITE, RESOURCE_TUBE, RESOURCE_PHLEGM, RESOURCE_SWITCH, RESOURCE_CONCENTRATE ];
const LEVEL_2_FACTORY_PRODUCTS = [ RESOURCE_CRYSTAL, RESOURCE_FIXTURES, RESOURCE_TISSUE, RESOURCE_TRANSISTOR, RESOURCE_EXTRACT ];
const LEVEL_3_FACTORY_PRODUCTS = [ RESOURCE_LIQUID, RESOURCE_FRAME, RESOURCE_MUSCLE, RESOURCE_MICROCHIP, RESOURCE_SPIRIT ];
const LEVEL_4_FACTORY_PRODUCTS = [ RESOURCE_HYDRAULICS, RESOURCE_ORGANOID, RESOURCE_CIRCUIT, RESOURCE_EMANATION ];
const LEVEL_5_FACTORY_PRODUCTS = [ RESOURCE_MACHINE, RESOURCE_ORGANISM, RESOURCE_DEVICE, RESOURCE_ESSENCE ];
const SUPPORTED_FACTORY_PRODUCTS = LEVEL_0_FACTORY_PRODUCTS.concat(LEVEL_1_FACTORY_PRODUCTS).concat(LEVEL_2_FACTORY_PRODUCTS).concat(LEVEL_3_FACTORY_PRODUCTS).concat(LEVEL_4_FACTORY_PRODUCTS).concat(LEVEL_5_FACTORY_PRODUCTS);
const DECOMPRESSION_PRODUCTS = [ RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, RESOURCE_ZYNTHIUM, RESOURCE_KEANIUM, RESOURCE_GHODIUM, RESOURCE_OXYGEN, RESOURCE_HYDROGEN, RESOURCE_CATALYST, RESOURCE_ENERGY ];
function ticksToTimeAgo(e) {
  const t = e * 3;
  const r = Math.floor(t / 60);
  const o = Math.floor(r / 60);
  const n = Math.floor(o / 24);
  if (n >= 1) return n + (n === 1 ? " day" : " days") + " ago";
  if (o >= 1) return o + (o === 1 ? " hour" : " hours") + " ago";
  return r + (r === 1 ? " min" : " mins") + " ago";
}

function ensureMemory() {
  if (!Memory.autoTrader) {
    Memory.autoTrader = {
      enabled: true,
      lastRun: 0,
      lastAnalysis: null,
      jobsStarted: []
    };
  }
  if (!Array.isArray(Memory.autoTrader.jobsStarted)) Memory.autoTrader.jobsStarted = [];
  if (!Memory.autoTrader.minerals) {
    const e = Memory.mineralManager;
    Memory.autoTrader.minerals = e || {
      roomStates: {},
      lastRunTick: 0,
      lastDepositCheckTick: 0
    };
    requestSave();
  }
  if (Memory.mineralManager) {
    delete Memory.mineralManager;
    requestSave();
  }
  const e = Memory.autoTrader.minerals;
  if (!e.roomStates) e.roomStates = {};
  if (typeof e.lastRunTick !== "number") e.lastRunTick = 0;
  if (typeof e.lastDepositCheckTick !== "number") e.lastDepositCheckTick = 0;
  if (typeof e.lastResidueRunTick !== "number") e.lastResidueRunTick = 0;
  if (memoryManager.hydrateAutoTraderHistory(Memory)) requestSave();
  var t = Memory.autoTrader.factoryCooldowns;
  if (t) {
    for (var r in t) {
      if (Game.time - t[r] >= FACTORY_JOB_COOLDOWN) delete t[r];
    }
    if (Object.keys(t).length === 0) delete Memory.autoTrader.factoryCooldowns;
  }
  return Memory.autoTrader;
}

function requestSave() {
  if (memoryManager && typeof memoryManager.requestSave === "function") memoryManager.requestSave();
}

function getOrderInfo(e, t) {
  const r = util.marketOrders(e, t);
  const o = [];
  let n = 0;
  for (var i = 0; i < r.length; i++) {
    const e = r[i];
    const t = util.getOrderRemaining(e);
    if (t > 0) {
      o.push(e);
      n += t;
    }
  }
  if (o.length === 0) return {
    count: 0,
    totalVolume: 0,
    bestPrice: null,
    orders: []
  };
  o.sort(function(e, r) {
    return t === ORDER_BUY ? r.price - e.price : e.price - r.price;
  });
  return {
    count: o.length,
    totalVolume: n,
    bestPrice: o[0].price,
    orders: o
  };
}

function getCanonicalInputPrice(e, t) {
  const r = pricing.getInputBuyQuote(e, t || 0);
  if (r && r.price > 0) {
    const t = pricing.getPriceProfile(e);
    return {
      price: r.price,
      source: r.source || "NONE",
      orderCount: t.askLevels || 0,
      volume: t.referenceAskVolume || 0
    };
  }
  return {
    price: null,
    source: "NONE",
    orderCount: 0,
    volume: 0
  };
}

function getVolumeWeightedBuyPrice(e, t, r) {
  if (e === RESOURCE_ENERGY) {
    return getCanonicalInputPrice(e, 0);
  }
  const o = pricing.executableBuyQuote(e, t || LAB_PROJECTED_OUTPUT, r);
  const n = pricing.getBook(e);
  if (o && o.price > 0) {
    return {
      price: o.price,
      source: "DEAL",
      orderCount: n.askCount || 0,
      volume: o.amount || 0,
      transferEnergy: o.transferEnergy || 0
    };
  }
  return getCanonicalInputPrice(e, t);
}

function statusEnergyPrice() {
  const e = pricing.getStatusEnergyPrice();
  return typeof e === "number" && isFinite(e) && e > 0 ? e : null;
}

function passiveBuyPriceInfo(e) {
  const t = pricing.getPriceProfile(e);
  const r = e === RESOURCE_ENERGY;
  const o = r ? statusEnergyPrice() : t.postedBuyPrice;
  const n = o !== null && o > 0 ? r && !(t.postedBuyPrice > 0) ? "STATUS" : t.postedBuySource || "NONE" : "NONE";
  return {
    price: o,
    source: n,
    orderCount: 0,
    volume: 0
  };
}

function priceOfWithSource(e, t) {
  if (t === "PASSIVE_BUY") {
    return passiveBuyPriceInfo(e);
  }
  if (t === "PASSIVE_SELL") {
    const t = pricing.getPriceProfile(e);
    const r = t.postedSellPrice;
    const o = r > 0 ? t.postedSellSource || "NONE" : "NONE";
    return {
      price: r > 0 ? r : null,
      source: o,
      orderCount: 0,
      volume: 0
    };
  }
  if (e === RESOURCE_ENERGY && t === "sell") {
    return passiveBuyPriceInfo(e);
  }
  if (t === "avg") {
    const t = pricing.getAvg48h(e);
    return t !== null ? {
      price: t,
      source: "HIST",
      orderCount: 0,
      volume: 0
    } : {
      price: null,
      source: "NONE",
      orderCount: 0,
      volume: 0
    };
  }
  if (t === "buy" || t === "sell") {
    const r = pricing.getPriceProfile(e);
    const o = t === "buy" ? r.buyPrice : r.sellPrice;
    if (o !== null) {
      return {
        price: o,
        source: "LIVE",
        orderCount: t === "buy" ? r.askLevels : r.bidLevels,
        volume: t === "buy" ? r.referenceAskVolume : r.referenceBidVolume
      };
    }
    if (r.marketPriceSource === "THEORETICAL" && r.marketPrice !== null) {
      return {
        price: r.marketPrice,
        source: "THEORETICAL",
        orderCount: 0,
        volume: 0
      };
    }
    return {
      price: null,
      source: "NONE",
      orderCount: 0,
      volume: 0
    };
  }
  return {
    price: null,
    source: "NONE",
    orderCount: 0,
    volume: 0
  };
}

function getProductFactoryLevel(e) {
  if (!COMMODITIES || !COMMODITIES[e]) return null;
  const t = COMMODITIES[e];
  return typeof t.level === "number" ? t.level : 0;
}

function getRoomFactory(e) {
  const t = getRoomState.get(e);
  if (!t || !t.isOwned || !t.structuresByType || !t.structuresByType[STRUCTURE_FACTORY]) return null;
  const r = t.structuresByType[STRUCTURE_FACTORY];
  return r.length > 0 ? r[0] : null;
}

function getRoomFactoryLevel(e) {
  const t = getRoomFactory(e);
  return t ? t.level || 0 : null;
}

function canRoomProduceProduct(e, t) {
  const r = getProductFactoryLevel(t);
  if (r === null) return false;
  const o = getRoomFactoryLevel(e);
  if (o === null) return false;
  if (r === 0) return true;
  return o === r;
}

function getOppositeFactoryProduct(e) {
  const t = DECOMPRESSION_PRODUCTS.indexOf(e) >= 0;
  const r = COMMODITIES && COMMODITIES[e];
  if (!r) return null;
  if (t) {
    const e = r.components || {};
    for (var o in e) {
      if (e.hasOwnProperty(o) && o !== RESOURCE_ENERGY) return o;
    }
  } else {
    for (var n = 0; n < DECOMPRESSION_PRODUCTS.length; n++) {
      const t = DECOMPRESSION_PRODUCTS[n];
      const r = COMMODITIES && COMMODITIES[t];
      if (!r) continue;
      const o = r.components || {};
      if (o.hasOwnProperty(e)) return t;
    }
  }
  return null;
}

function buildReactionMap() {
  const e = {};
  if (!REACTIONS) return e;
  for (var t in REACTIONS) {
    if (!REACTIONS.hasOwnProperty(t)) continue;
    const o = REACTIONS[t];
    for (var r in o) {
      if (!o.hasOwnProperty(r)) continue;
      e[o[r]] = [ t, r ];
    }
  }
  return e;
}

function canRunFullPipelineDiscovery() {
  if (typeof Game === "undefined" || !Game.cpu) return true;
  const e = typeof Game.cpu.bucket === "number" ? Game.cpu.bucket : 1e4;
  if (e < FULL_PIPELINE_DIAGNOSTIC_MIN_BUCKET) return false;
  const t = typeof Game.cpu.limit === "number" ? Game.cpu.limit : 20;
  const r = typeof Game.cpu.getUsed === "function" ? Game.cpu.getUsed() : 0;
  return t - r >= BATCH_DISCOVERY_MIN_FREE_CPU;
}

function getConversionOutputInfo(e, t, r, o) {
  if (pricing && typeof pricing.getConversionExitQuote === "function" && r) {
    const o = pricing.getConversionExitQuote(e, t, r);
    if (o && o.price > 0) {
      return {
        price: o.price,
        source: o.source || o.method || "LIVE",
        volume: o.amount || 0,
        transferEnergy: o.transferEnergy || 0,
        method: o.method || "UNKNOWN",
        crossed: !!o.crossed
      };
    }
  }
  const n = priceOfWithSource(e, o || "PASSIVE_SELL");
  return {
    price: n.price,
    source: n.source,
    volume: n.volume || 0,
    transferEnergy: 0,
    method: n.source || "UNKNOWN",
    crossed: false
  };
}

function analyzeReverseReaction(e, t, r, o, n) {
  const i = t[e];
  if (!i) return null;
  const a = typeof LAB_REACTION_AMOUNT === "number" && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
  const s = i[0], c = i[1];
  const u = getVolumeWeightedBuyPrice(e, LAB_PROJECTED_OUTPUT);
  const l = u.price;
  const p = l;
  const d = p === null ? null : p * a;
  const f = r === "PASSIVE_SELL" ? getConversionOutputInfo(s, a, n, r) : priceOfWithSource(s, r);
  const m = r === "PASSIVE_SELL" ? getConversionOutputInfo(c, a, n, r) : priceOfWithSource(c, r);
  const g = f.price === null ? null : f.price * a;
  const R = m.price === null ? null : m.price * a;
  const E = g !== null && R !== null ? g + R : null;
  const S = E !== null && d !== null ? E - d : null;
  return {
    type: "reverse",
    compound: e,
    reagentA: s,
    reagentB: c,
    batchSize: a,
    profit: S,
    inputCost: d,
    revenue: E,
    compoundPrice: l,
    compoundVolume: u.volume,
    outputTransferEnergy: (f.transferEnergy || 0) + (m.transferEnergy || 0),
    outputQuotes: function() {
      var e = {};
      e[s] = f;
      e[c] = m;
      return e;
    }(),
    inputQuantities: function() {
      var t = {};
      t[e] = a;
      return t;
    }()
  };
}

function analyzeForwardReaction(e, t, r, o) {
  const n = t[e];
  if (!n) return null;
  const i = typeof LAB_REACTION_AMOUNT === "number" && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
  const a = n[0], s = n[1];
  const c = getVolumeWeightedBuyPrice(a, LAB_PROJECTED_OUTPUT);
  const u = c.price;
  const l = c.price;
  const p = getVolumeWeightedBuyPrice(s, LAB_PROJECTED_OUTPUT);
  const d = p.price;
  const f = p.price;
  const m = l === null ? null : l * i;
  const g = f === null ? null : f * i;
  const R = m !== null && g !== null ? m + g : null;
  const E = R;
  const S = priceOfWithSource(e, o);
  const y = S.price === null ? null : S.price * i;
  const h = y !== null && E !== null ? y - E : null;
  return {
    type: "forward",
    compound: e,
    reagentA: a,
    reagentB: s,
    batchSize: i,
    profit: h,
    inputCost: E,
    revenue: y,
    reagentAPrice: u,
    reagentBPrice: d,
    compoundPrice: S.price,
    compoundVolume: S.volume,
    inputQuantities: function() {
      var e = {};
      e[a] = i;
      e[s] = i;
      return e;
    }()
  };
}

function analyzeFactoryProduct(e, t, r) {
  const o = COMMODITIES && COMMODITIES[e];
  if (!o) return null;
  const n = typeof o.amount === "number" && o.amount > 0 ? o.amount : 1;
  const i = o.components || {};
  let a = 0;
  const s = {};
  const c = LOCAL_REFINE_PRODUCTS.indexOf(e) >= 0;
  const u = DECOMPRESSION_PRODUCTS.indexOf(e) >= 0;
  let l = false;
  for (var p in i) {
    if (!i.hasOwnProperty(p)) continue;
    const t = i[p] || 0;
    if (c) {
      const o = e === RESOURCE_BATTERY && p === RESOURCE_ENERGY;
      const n = o ? statusEnergyPrice() : priceOfWithSource(p, r).price;
      s[p] = o ? n : 0;
      if (n === null) {
        l = true;
        continue;
      }
      a += n * t;
      continue;
    }
    if (p === RESOURCE_ENERGY) {
      const e = getCanonicalInputPrice(p, t);
      if (!(e.price > 0)) {
        l = true;
        continue;
      }
      a += e.price * t;
      s[p] = e.price;
      continue;
    }
    const o = getVolumeWeightedBuyPrice(p, t * MARKET_REFINE_BATCH_MULTIPLIER);
    let n = o.price;
    if (n !== null) {
      const e = pricing.computePostedBid(p, Infinity);
      if (e !== null) n = Math.max(e, n);
    }
    if (n === null) {
      l = true;
      continue;
    }
    a += n * t;
    s[p] = o.price !== null ? o.price : n;
  }
  const d = l ? null : a;
  const f = priceOfWithSource(e, t);
  const m = f.price;
  const g = m === null ? null : m * n;
  const R = g === null || d === null ? null : g - d;
  const E = factoryCooldownFor(e);
  return {
    type: "factory",
    product: e,
    profit: R,
    inputCost: d,
    revenue: g,
    unitPrice: m,
    outputVolume: f.volume,
    expectedOutput: n * MARKET_REFINE_BATCH_MULTIPLIER,
    outputQuantity: n,
    requiredLevel: getProductFactoryLevel(e),
    inputPrices: s,
    inputQuantities: i,
    isLocalRefine: c,
    isDecompress: u,
    ingredientCost: l ? null : a,
    cooldown: E
  };
}

function getBatchSellOrders(e, t) {
  const r = getTickCache();
  const o = pricing.getRawOrders ? pricing.getRawOrders() : [];
  if (r.batchSellOrdersRaw !== o) {
    r.batchSellOrdersRaw = o;
    r.batchSellOrders = {};
  }
  const n = e || "";
  if (!Object.prototype.hasOwnProperty.call(r.batchSellOrders, n)) {
    const t = [];
    for (var i = 0; i < o.length; i++) {
      const r = o[i];
      if (!r || r.type !== ORDER_SELL || r.resourceType !== e || !r.roomName || !(r.price > 0)) continue;
      const n = util.getOrderRemaining(r);
      if (!(n > 0)) continue;
      t.push(r);
    }
    t.sort(function(e, t) {
      return e.price - t.price;
    });
    r.batchSellOrders[n] = t;
  }
  const a = t || "";
  const s = n + "|" + a;
  if (Object.prototype.hasOwnProperty.call(r.batchSellOrders, s)) {
    return r.batchSellOrders[s];
  }
  const c = r.batchSellOrders[n].filter(function(e) {
    return e.roomName !== t;
  }).slice(0, BATCH_ORDER_SCAN_LIMIT);
  r.batchSellOrders[s] = c;
  return c;
}

function batchPurchasesCanUseRoom(e, t) {
  if (!Array.isArray(e)) return true;
  for (var r = 0; r < e.length; r++) {
    if (e[r] && e[r].orderRoomName === t) return false;
  }
  if (typeof marketLab.canUseBatchRoom === "function" && !marketLab.canUseBatchRoom(t, e)) return false;
  return true;
}

function batchPurchasesCanUseAnyRoom(e, t) {
  return !!findBatchPurchaseRoom(e, t);
}

function findBatchPurchaseRoom(e, t) {
  if (!Array.isArray(t)) return null;
  for (var r = 0; r < t.length; r++) {
    if (t[r] && batchPurchasesCanUseRoom(e, t[r].name)) return t[r];
  }
  return null;
}

function makeBatchPurchase(e, t, r, o) {
  return {
    resource: t,
    amount: Math.floor(o),
    orderId: r.id,
    orderRoomName: r.roomName,
    orderPrice: r.price,
    maxPrice: r.price,
    energyCost: util.calcTransactionCost(Math.floor(o), e, r.roomName),
    energyPrice: statusEnergyPrice() || 0
  };
}

function prepareBatchLabAnalysis(e, t, r, o) {
  if (!e || !(r >= BATCH_LAB_MIN_OUTPUT) || r > BATCH_LAB_MAX_OUTPUT || !Array.isArray(o) || o.length === 0) return null;
  e.batchMode = true;
  e.targetOutput = Math.floor(r / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
  e.plannedOutput = e.targetOutput;
  e.batchPurchases = o;
  e.plannedRoom = t;
  e.scoredRoom = t;
  e.inputCost = null;
  e._batchPricingPending = true;
  return e;
}

function getBatchLabCandidates(e, t) {
  const r = [], o = [];
  const n = Game.cpu && typeof Game.cpu.getUsed === "function" ? Game.cpu.getUsed() : 0;
  if (!allowBatchDiscovery()) return {
    reverse: r,
    forward: o
  };
  if (!Array.isArray(t)) t = t ? [ t ] : [];
  if (t.length === 0) return {
    reverse: r,
    forward: o
  };
  const i = Object.keys(e);
  var a = false;
  function revenuePerUnit(e) {
    if (!e || !(e.revenue > 0)) return null;
    var t = e.targetOutput || e.plannedOutput;
    return t > 0 ? e.revenue / t : null;
  }
  for (var s = 0; s < i.length; s++) {
    if (!batchDiscoveryWithinBudget(n)) {
      a = true;
      break;
    }
    const E = i[s];
    var c = null;
    var u = null;
    const S = getBatchSellOrders(E, null);
    for (var l = 0; l < S.length; l++) {
      if (!batchDiscoveryWithinBudget(n)) {
        a = true;
        break;
      }
      const r = S[l];
      if (u !== null && r.price >= u) break;
      const o = Math.min(BATCH_LAB_MAX_OUTPUT, Math.floor(util.getOrderRemaining(r) / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT);
      if (o < BATCH_LAB_MIN_OUTPUT) continue;
      const i = findBatchPurchaseRoom([ makeBatchPurchase(t[0].name, E, r, o) ], t);
      if (!i) continue;
      const s = makeBatchPurchase(i.name, E, r, o);
      var p = prepareBatchLabAnalysis(analyzeReverseReaction(E, e, "PASSIVE_SELL", "PASSIVE_BUY", i.name), i.name, o, [ s ]);
      p = scoreOpportunity(p, i);
      if (u === null) u = revenuePerUnit(p);
      if (p && p.breakEven && meetsStartProfitThreshold(p) && (!c || p.creditsPerTick > c.creditsPerTick)) c = p;
    }
    if (c) r.push(c);
    const y = e[E];
    if (!y) continue;
    var d = null;
    var f = null;
    const h = getBatchSellOrders(y[0], null);
    const O = getBatchSellOrders(y[1], null);
    for (var m = 0; m < h.length; m++) {
      if (!batchDiscoveryWithinBudget(n)) {
        a = true;
        break;
      }
      if (f !== null && O.length && h[m].price + O[0].price >= f) break;
      for (var g = 0; g < O.length; g++) {
        if (!batchDiscoveryWithinBudget(n)) {
          a = true;
          break;
        }
        if (f !== null && h[m].price + O[g].price >= f) break;
        const r = util.getOrderRemaining(h[m]);
        const o = util.getOrderRemaining(O[g]);
        const i = Math.min(BATCH_LAB_MAX_OUTPUT, Math.floor(Math.min(r, o) / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT);
        if (i < BATCH_LAB_MIN_OUTPUT) continue;
        const s = [ makeBatchPurchase(t[0].name, y[0], h[m], i), makeBatchPurchase(t[0].name, y[1], O[g], i) ];
        const c = findBatchPurchaseRoom(s, t);
        if (!c) continue;
        const u = [ makeBatchPurchase(c.name, y[0], h[m], i), makeBatchPurchase(c.name, y[1], O[g], i) ];
        var R = prepareBatchLabAnalysis(analyzeForwardReaction(E, e, "PASSIVE_BUY", "PASSIVE_SELL"), c.name, i, u);
        R = scoreOpportunity(R, c);
        if (f === null) f = revenuePerUnit(R);
        if (R && R.breakEven && meetsStartProfitThreshold(R) && (!d || R.creditsPerTick > d.creditsPerTick)) d = R;
      }
    }
    if (d) o.push(d);
  }
  return {
    reverse: r,
    forward: o,
    truncated: a
  };
}

function getBatchFactoryCandidates(e, t) {
  const r = [];
  const o = Game.cpu && typeof Game.cpu.getUsed === "function" ? Game.cpu.getUsed() : 0;
  if (!allowBatchDiscovery() || !t || t.length === 0) return r;
  for (var n = 0; n < e.length; n++) {
    if (!batchDiscoveryWithinBudget(o)) break;
    const l = e[n];
    if (BANNED_FACTORY_PRODUCTS.indexOf(l) >= 0 || LOCAL_REFINE_PRODUCTS.indexOf(l) >= 0) continue;
    const p = COMMODITIES && COMMODITIES[l];
    if (!p || !p.components) continue;
    const d = getProductFactoryLevel(l);
    const f = t.filter(function(e) {
      return d === null || d === 0 || e.factoryLevel === d;
    });
    if (f.length === 0) continue;
    const m = [];
    for (var i in p.components) {
      if (p.components.hasOwnProperty(i) && i !== RESOURCE_ENERGY) m.push(i);
    }
    if (m.length === 0) continue;
    var a = null;
    for (var s = 0; s < f.length; s++) {
      if (!allowBatchDiscovery() || !batchDiscoveryWithinBudget(o)) break;
      const g = f[s];
      const R = [];
      var c = false;
      for (var u = 0; u < m.length; u++) {
        const E = getBatchSellOrders(m[u], g.name);
        if (E.length === 0) {
          c = true;
          break;
        }
        R.push(E.slice(0, 4));
      }
      if (c) continue;
      function visit(e, t) {
        if (!allowBatchDiscovery() || !batchDiscoveryWithinBudget(o)) return;
        if (e >= R.length) {
          var r = BATCH_FACTORY_MAX_CYCLES;
          for (var n = 0; n < m.length; n++) {
            const e = p.components[m[n]];
            const o = util.getOrderRemaining(t[n]);
            r = Math.min(r, Math.floor(o / e));
          }
          r = Math.min(r, Math.floor(BATCH_FACTORY_MAX_OUTPUT / (p.amount || 1)));
          if (r < 1) return;
          const e = [];
          for (var i = 0; i < m.length; i++) {
            e.push(makeBatchPurchase(g.name, m[i], t[i], r * p.components[m[i]]));
          }
          if (!batchPurchasesCanUseRoom(e, g.name)) return;
          var s = analyzeFactoryProduct(l, "PASSIVE_SELL", "PASSIVE_BUY");
          if (!s || s.revenue === null) return;
          s.batchMode = true;
          s.targetCycles = r;
          s.expectedOutput = r * (p.amount || 1);
          s.plannedOutput = s.expectedOutput;
          s.batchPurchases = e;
          s.plannedRoom = g.name;
          s.scoredRoom = g.name;
          s.inputCost = null;
          s._batchPricingPending = true;
          s = scoreOpportunity(s, g);
          if (s && s.breakEven && meetsStartProfitThreshold(s) && (!a || s.creditsPerTick > a.creditsPerTick)) a = s;
          return;
        }
        for (var c = 0; c < R[e].length; c++) {
          if (!allowBatchDiscovery() || !batchDiscoveryWithinBudget(o)) return;
          t.push(R[e][c]);
          visit(e + 1, t);
          t.pop();
        }
      }
      visit(0, []);
    }
    if (a) r.push(a);
  }
  return r;
}

function estimateLabParallelism(e) {
  if (!e) return 1;
  let t = e.labCount;
  if (!t && e.name) t = getRoomLabCount(e.name);
  if (!t) t = 3;
  return Math.max(1, Math.min(t - 2, Math.floor((t - 2) * .75) || 1));
}

function estimateQueueTicks(e) {
  if (!e) return 0;
  const t = getLabOperationsForRoom(e.name);
  let r = 0, o = estimateLabParallelism(e);
  for (var n = 0; n < t.length; n++) {
    const i = t[n];
    if (e.excludeOpId && i && i.id === e.excludeOpId) continue;
    if (!i || !i.targetCompound || i.state === "SELLING") continue;
    const a = i.batchSize || LAB_PROJECTED_OUTPUT;
    const s = typeof LAB_REACTION_AMOUNT === "number" && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    r += Math.ceil(a / s) * reactionTimeFor(i.targetCompound) / o;
    if (i.state === "BUYING" || i.state === "WAITING") r += 480;
    r += 300;
  }
  return Math.ceil(r);
}

function scoreOpportunity(e, t) {
  if (!e || !marketAnalysis || typeof marketAnalysis.scoreProduction !== "function") return e;
  let r = false;
  if (e.type === "reverse" && t && t.name) {
    const o = getRoomState.get(t.name);
    if (o && e.inputQuantities && e.inputQuantities[e.compound] > 0) {
      r = availableRoomResourceAmount(t.name, o, e.compound) > 0;
    }
  }
  if (e.revenue === null || e.inputCost === null && e.type !== "factory" && !e._batchPricingPending && !r) {
    e.breakEven = false;
    e.creditsPerTick = null;
    e.expectedNetProfit = null;
    return e;
  }
  let o;
  let n;
  let i = 1;
  let a;
  let s;
  let c;
  let u = 0;
  let l = false;
  const p = e.type === "factory" ? e.expectedOutput || e.outputQuantity || 1 : e.targetOutput || LAB_PROJECTED_OUTPUT;
  if (e.type === "factory") {
    o = e.targetCycles > 0 ? Math.floor(e.targetCycles) : Math.max(1, Math.floor(p / (e.outputQuantity || 1)));
    o = Math.max(1, o);
    e.expectedOutput = o * (e.outputQuantity || 1);
    if (e.isLocalRefine) {
      e.expectedOutput = o * (e.outputQuantity || 1);
    }
    n = e.cooldown || factoryCooldownFor(e.product) || 1;
    a = e.isLocalRefine ? 0 : e.batchMode ? 20 : 400;
    s = e.isLocalRefine ? 20 : 40;
    c = 300;
    l = !!e.isLocalRefine;
  } else {
    o = Math.max(1, Math.ceil(p / (e.batchSize || 5)));
    e.targetOutput = o * (e.batchSize || 5);
    n = reactionTimeFor(e.compound);
    i = estimateLabParallelism(t);
    a = e.batchMode ? 20 : 400;
    s = 80;
    c = 300;
    u = estimateQueueTicks(t);
  }
  const d = statusEnergyPrice();
  if ((e.type === "reverse" || e.type === "forward") && t && t.name && pricing && typeof pricing.getConversionExitQuote === "function") {
    if (e.type === "reverse") {
      const r = getConversionOutputInfo(e.reagentA, p, t.name, "PASSIVE_SELL");
      const o = getConversionOutputInfo(e.reagentB, p, t.name, "PASSIVE_SELL");
      if (r.price !== null && o.price !== null) {
        e.revenue = (r.price + o.price) * (e.batchSize || 5);
        e.outputTransferEnergy = (r.transferEnergy || 0) + (o.transferEnergy || 0);
        e.outputQuotes = {};
        e.outputQuotes[e.reagentA] = r;
        e.outputQuotes[e.reagentB] = o;
        e.outputQuoteSource = r.source + "+" + o.source;
      }
    } else {
      const r = getConversionOutputInfo(e.compound, p, t.name, "PASSIVE_SELL");
      if (r.price !== null) {
        e.compoundPrice = r.price;
        e.revenue = r.price * (e.batchSize || 5);
        e.outputTransferEnergy = r.transferEnergy || 0;
        e.outputQuotes = {};
        e.outputQuotes[e.compound] = r;
        e.outputQuoteSource = r.source || r.method || "UNKNOWN";
      }
    }
  }
  if (e.type === "factory" && t && t.name && pricing && typeof pricing.getConversionExitQuote === "function") {
    const r = getConversionOutputInfo(e.product, p, t.name, "PASSIVE_SELL");
    if (r.price !== null) {
      e.unitPrice = r.price;
      e.revenue = r.price * (e.outputQuantity || 1);
      e.outputTransferEnergy = r.transferEnergy || 0;
      e.outputQuotes = {};
      e.outputQuotes[e.product] = r;
      e.outputQuoteSource = r.source || r.method || "UNKNOWN";
    }
  }
  if (e.type === "forward" && t && t.name && labCommodityPolicy.isTwoLetterLabProduct(e.compound) && typeof labCommodityRouter.quoteExit === "function") {
    const r = e.targetOutput || p;
    const o = labCommodityRouter.quoteExit(t.name, e.compound, r);
    e.restrictedExitRoute = o ? o.type : null;
    e.restrictedExitNet = o ? o.net : null;
    e.restrictedStandaloneExit = !!(o && o.type === "direct");
  }
  const f = e.type === "factory" && !e.batchMode && !e.isLocalRefine ? pricing.breakEvenInputCeilings(e.product) : null;
  if (e.batchMode && !(d > 0)) {
    e.breakEven = false;
    e.creditsPerTick = null;
    return e;
  }
  let m = (e.outputTransferEnergy || 0) * (d || 0);
  if (!l && e.inputQuantities) {
    let r = 0;
    for (var g in e.inputQuantities) {
      if (!e.inputQuantities.hasOwnProperty(g)) continue;
      const n = e.inputQuantities[g] || 0;
      if (!(n > 0)) continue;
      if (g === RESOURCE_ENERGY) {
        const t = d;
        if (!(t > 0)) {
          e.breakEven = false;
          return e;
        }
        r += t * n;
        continue;
      }
      let i = null;
      let a = null;
      var R = null;
      if (e.batchMode && Array.isArray(e.batchPurchases)) {
        for (var E = 0; E < e.batchPurchases.length; E++) {
          if (e.batchPurchases[E] && e.batchPurchases[E].resource === g) {
            R = e.batchPurchases[E];
            break;
          }
        }
      }
      if (e._batchPricingPending && g !== RESOURCE_ENERGY && !R) {
        e.breakEven = false;
        e.creditsPerTick = null;
        e.expectedNetProfit = null;
        return e;
      }
      if (e.type === "reverse" && g === e.compound && !R && t && t.name) {
        const i = n * o;
        const a = getRoomState.get(t.name);
        const s = a ? Math.max(0, availableRoomResourceAmount(t.name, a, g)) : 0;
        const c = Math.min(i, s);
        const u = Math.max(0, i - c);
        let l = 0;
        if (c > 0) {
          const r = getConversionOutputInfo(g, c, t.name, "PASSIVE_SELL");
          if (!(r.price > 0)) {
            e.breakEven = false;
            e.creditsPerTick = null;
            return e;
          }
          l = r.price * c;
          m += (r.transferEnergy || 0) * (d || 0);
          if (!e.inputMethods) e.inputMethods = {};
          e.inputMethods[g] = u > 0 ? "mixed" : "roomStock";
        }
        let p = 0;
        if (u > 0) {
          const r = pricing.executableBuyQuote(g, u, t.name);
          if (!r) {
            e.breakEven = false;
            e.creditsPerTick = null;
            return e;
          }
          p = r.price * u;
          m += (r.transferEnergy || 0) * (d || 0);
          e.compoundPrice = r.price;
          if (!e.inputMethods) e.inputMethods = {};
          if (c <= 0) e.inputMethods[g] = "executableAsk";
        } else {
          e.compoundPrice = null;
        }
        r += (l + p) / o;
        continue;
      }
      if (R) {
        if (!(R.amount >= n * o) || !(R.orderPrice > 0)) {
          e.breakEven = false;
          e.creditsPerTick = null;
          return e;
        }
        a = R.orderPrice;
        if (t && t.name) {
          R.energyCost = util.calcTransactionCost(n * o, t.name, R.orderRoomName);
          R.energyPrice = d || 0;
        }
        m += t && t.name ? util.calcTransactionCost(n * o, t.name, R.orderRoomName) * (d || 0) : 0;
      } else if (e.type === "factory" && !e.batchMode) {
        var S = f && f[g];
        if (!(S > 0) || !t || !t.name) {
          e.breakEven = false;
          e.creditsPerTick = null;
          return e;
        }
        var y = passiveScanInputQuote(g, n * o, t.name, S);
        if (!y || !y.ok) {
          e.breakEven = false;
          e.creditsPerTick = null;
          return e;
        }
        a = y.price;
        m += (y.transferEnergy || 0) * (d || 0);
        if (!e.inputPrices) e.inputPrices = {};
        if (!e.inputAcquisitionPrices) e.inputAcquisitionPrices = {};
        if (!e.inputMethods) e.inputMethods = {};
        e.inputPrices[g] = S;
        e.inputAcquisitionPrices[g] = a;
        e.inputMethods[g] = y.method;
      } else {
        i = pricing.executableBuyQuote(g, n * o, t && t.name);
        if (!i) {
          e.breakEven = false;
          e.creditsPerTick = null;
          return e;
        }
        a = i.price;
        m += (i.transferEnergy || 0) * (d || 0);
      }
      if (e.type === "factory") {
        if (R) {
          const t = pricing.computePostedBid(g, Infinity);
          if (t !== null) a = Math.max(t, a);
          if (e.inputPrices) e.inputPrices[g] = a;
        }
      }
      r += a * n;
      if (e.type === "reverse") e.compoundPrice = a;
      if (e.type === "forward") {
        if (g === e.reagentA) e.reagentAPrice = a;
        if (g === e.reagentB) e.reagentBPrice = a;
      }
    }
    e.inputCost = r;
  }
  const h = e.type === "factory" ? e.isLocalRefine ? "factoryLocal" : "factoryMarket" : e.type === "reverse" ? "labReverse" : "labForward";
  let O = null, v = null, b = null, T = null, P = null;
  if (USE_LEARNED_DURATIONS) {
    const t = e.type === "factory" ? e.product : e.compound;
    O = marketEconomics.getLearnedDuration(h, t, "buying");
    v = marketEconomics.getLearnedDuration(h, t, "staging");
    b = marketEconomics.getLearnedDuration(h, t, "producing");
    T = marketEconomics.getLearnedDuration(h, t, "selling");
    P = marketEconomics.getLearnedDuration(h, t, "queued");
  }
  const C = O !== null || v !== null || b !== null || T !== null || P !== null;
  const A = {
    buy: a,
    stage: s,
    produce: n * o,
    sell: c,
    queue: u
  };
  if (USE_LEARNED_DURATIONS) {
    if (O !== null) a = O;
    if (v !== null) s = v;
    if (b !== null) n = Math.max(1, b / Math.max(1, o));
    if (T !== null) c = T;
    if (P !== null) u = P;
  }
  const _ = marketAnalysis.scoreProduction({
    materialCost: e.inputCost,
    revenue: e.revenue,
    cycles: o,
    cycleTicks: n,
    parallelism: i,
    expectedBuyTicks: a,
    expectedStageTicks: s,
    expectedSellTicks: c,
    expectedQueueTicks: u,
    terminalEnergyCost: m,
    skipInputFees: l,
    marketFees: (e.revenue + (l ? 0 : e.inputCost)) * o * .05,
    repriceAllowance: 0
  });
  if (!_) return e;
  for (var k in _) e[k] = _[k];
  e.usedLearnedDurations = C;
  e.learnedDurationsEnabled = USE_LEARNED_DURATIONS;
  e.staticDurations = A;
  e.learnedDurations = {
    buy: O,
    stage: v,
    produce: b,
    sell: T,
    queue: P
  };
  delete e._batchPricingPending;
  return e;
}

function meetsStartProfitThreshold(e) {
  return !!(e && typeof e.creditsPerTick === "number" && isFinite(e.creditsPerTick) && e.creditsPerTick >= MIN_START_CREDITS_PER_TICK);
}

function pipelineInputRequirements(e) {
  var t = {};
  if (!e) return t;
  if (e.mode === "decompose") {
    t[e.root] = e.amount;
    return t;
  }
  for (var r in e.leaves) {
    if (Object.prototype.hasOwnProperty.call(e.leaves, r)) t[r] = e.leaves[r];
  }
  return t;
}

function pipelineOutputLegs(e) {
  var t = [];
  for (var r in e.finalOutputs) {
    if (Object.prototype.hasOwnProperty.call(e.finalOutputs, r) && e.finalOutputs[r] > 0) {
      t.push({
        resource: r,
        amount: e.finalOutputs[r]
      });
    }
  }
  return t;
}

function analyzePipelineMarket(e, t, r) {
  function reject(e) {
    if (r) r.reason = e;
    return null;
  }
  if (!e || !e.ok || !t) return reject("no valid plan");
  var o = pipelineInputRequirements(e);
  var n = pipelineOutputLegs(e);
  var i = {};
  var a = {};
  var s = {};
  var c = 0;
  var u = 0;
  for (var l in o) {
    if (!Object.prototype.hasOwnProperty.call(o, l)) continue;
    var p = getVolumeWeightedBuyPrice(l, o[l], t.name);
    if (!p || !(p.price > 0)) return reject("no buy quote for " + o[l] + " " + l);
    i[l] = p.price;
    a[l] = p.price;
    s[l] = p.source || "NONE";
    c += p.price * o[l];
    u += p.transferEnergy || 0;
  }
  var d = 0;
  var f = 0;
  var m = {};
  var g = {};
  for (var R = 0; R < n.length; R++) {
    var E = n[R];
    var S = getConversionOutputInfo(E.resource, E.amount, t.name, "PASSIVE_SELL");
    if (!S || !(S.price > 0)) return reject("no sell quote for " + E.amount + " " + E.resource);
    m[E.resource] = S;
    g[E.resource] = S.source || "NONE";
    d += S.price * E.amount;
    f += S.transferEnergy || 0;
  }
  var y = 0;
  for (var h = 0; h < e.stages.length; h++) {
    y += Math.ceil(e.stages[h].amount / LAB_REACTION_AMOUNT);
  }
  var O = statusEnergyPrice() || 0;
  if (!(O > 0)) return reject("no energy price");
  var v = (u + f) * O;
  var b = typeof pricing.FEE === "number" ? pricing.FEE : .05;
  var T = (c + d) * b;
  var P = d - c - v - T;
  return {
    inputs: o,
    outputs: n,
    inputPrices: i,
    inputAcquisitionPrices: a,
    inputSources: s,
    inputCost: c,
    revenue: d,
    outputQuotes: m,
    outputSources: g,
    reactionCalls: y,
    transferEnergyCost: v,
    marketFees: T,
    net: P
  };
}

function analyzeFullPipeline(e, t, r, o, n) {
  function reject(e) {
    if (o) o.reason = e;
    return null;
  }
  if (!r || !r.ok) return reject("no valid layout");
  n = n || analyzePipelineMarket(e, t, o);
  if (!n) return null;
  var i = n.inputs;
  var a = n.outputs;
  var s = n.inputPrices;
  var c = n.inputAcquisitionPrices;
  var u = n.inputSources;
  var l = n.inputCost;
  var p = n.revenue;
  var d = n.outputQuotes;
  var f = n.outputSources;
  var m = n.reactionCalls;
  var g = n.transferEnergyCost;
  var R = n.marketFees;
  var E = n.net;
  var S = labManager.estimatePipelineTicks(e, r);
  var y = S + 400 + 40 + 300;
  if (!(y > 0) || !isFinite(y)) return reject("unusable tick estimate");
  var h = {
    type: e.mode === "synthesis" ? "forward" : "reverse",
    pipeline: true,
    pipelineMode: e.mode,
    compound: e.root,
    reagentA: e.stages[0] && e.stages[0].inputs ? e.stages[0].inputs[0] : null,
    reagentB: e.stages[0] && e.stages[0].inputs ? e.stages[0].inputs[1] : null,
    batchSize: e.amount,
    targetOutput: e.amount,
    plannedOutput: e.amount,
    inputQuantities: i,
    inputPrices: s,
    inputAcquisitionPrices: c,
    compoundPrice: e.mode === "decompose" ? s[e.root] : null,
    reagentAPrice: null,
    reagentBPrice: null,
    outputQuotes: d,
    outputLegs: a,
    finalOutputLegs: a,
    pipelineLeaves: e.leaves,
    pipelineDepth: e.depth,
    pipelineStageCount: e.stageCount,
    pipelineReactionCalls: m,
    inputCost: l,
    revenue: p,
    inputSources: u,
    outputSources: f,
    transferEnergyCost: g,
    marketFees: R,
    expectedNetProfit: E,
    expectedElapsedTicks: y,
    creditsPerTick: E / y,
    breakEven: E > 0,
    totalCost: l + g + R,
    plannedRoom: t.name,
    scoredRoom: t.name,
    layout: r
  };
  if (e.mode === "synthesis") {
    h.maxReagentPrices = s;
    h.reagentAPrice = s[h.reagentA] || null;
    h.reagentBPrice = s[h.reagentB] || null;
  } else {
    h.maxBuyPrice = s[e.root];
  }
  return h;
}

function notePipelineRejection(e, t, r, o, n) {
  var i = (r === "synthesis" ? "forward" : "reverse") + ": " + n;
  var a = e.rejections[i];
  if (!a) {
    a = e.rejections[i] = {
      count: 0,
      compounds: []
    };
  }
  a.count++;
  if (a.compounds.length < 6 && a.compounds.indexOf(t) < 0) {
    a.compounds.push(t);
  }
}

function recordPipelineLoss(e, t, r, o, n, i) {
  var a = r === "synthesis" ? "forward" : "reverse";
  for (var s = 0; s < e.losses.length; s++) {
    var c = e.losses[s];
    if (c.compound === t && c.direction === a && c.netProfit >= i.net) return;
  }
  e.losses.push({
    compound: t,
    direction: a,
    room: o,
    creditsPerTick: null,
    netProfit: i.net,
    elapsedTicks: null,
    inputCost: i.inputCost,
    revenue: i.revenue,
    transferEnergyCost: i.transferEnergyCost,
    marketFees: i.marketFees,
    inputQuantities: i.inputs,
    inputPrices: i.inputPrices,
    inputSources: i.inputSources,
    outputLegs: i.outputs,
    outputQuotes: i.outputQuotes,
    outputSources: i.outputSources
  });
}

function recordPipelineShortfall(e, t, r, o, n) {
  if (o || !n) return;
  e.shortfalls.push({
    compound: t,
    direction: r,
    room: n.plannedRoom || null,
    creditsPerTick: n.creditsPerTick,
    netProfit: n.expectedNetProfit,
    elapsedTicks: n.expectedElapsedTicks,
    inputCost: n.inputCost,
    revenue: n.revenue,
    transferEnergyCost: n.transferEnergyCost,
    marketFees: n.marketFees,
    inputQuantities: n.inputQuantities,
    inputPrices: n.inputPrices,
    inputSources: n.inputSources,
    outputLegs: n.outputLegs,
    outputQuotes: n.outputQuotes,
    outputSources: n.outputSources
  });
}

function getFullPipelineCandidates() {
  var e = {
    reverse: [],
    forward: [],
    advancedCompounds: {},
    rooms: [],
    shortfalls: [],
    losses: [],
    rejections: {},
    layoutSearches: 0
  };
  if (!ENABLE_LAB_JOBS || !labReactionPipeline || typeof labReactionPipeline.build !== "function") return e;
  if (!canRunFullPipelineDiscovery()) {
    e.deferred = true;
    return e;
  }
  var t = getRoomState.ownedNames();
  var r = [];
  for (var o = 0; o < t.length; o++) {
    var n = t[o];
    var i = Game.rooms[n];
    if (!i || !isEligibleForLabReaction(n) || getRoomLabCount(n) < 10) continue;
    if (getRoomActiveLabCount(n) >= MAX_LAB_OPS_PER_ROOM) continue;
    if (labManager.roomHasPendingOrder && labManager.roomHasPendingOrder(n)) continue;
    r.push({
      name: n,
      labCount: getRoomLabCount(n),
      activeLabOps: getRoomActiveLabCount(n),
      labManagerBusy: !!(labManager.roomHasPendingOrder && labManager.roomHasPendingOrder(n)),
      live: i
    });
    e.rooms.push({
      name: n,
      labCount: getRoomLabCount(n),
      activeLabOps: getRoomActiveLabCount(n)
    });
  }
  var a = buildReactionMap();
  var s = Object.keys(a);
  for (var c = 0; c < s.length; c++) {
    var u = s[c];
    var l = null;
    var p = null;
    var d = null;
    var f = null;
    for (var m = 0; m < 2; m++) {
      var g = m === 0 ? "synthesis" : "decompose";
      var R = labReactionPipeline.build(g, u, FULL_PIPELINE_OUTPUT);
      if (!R.ok || !R.requiresAdvancedRoom) continue;
      for (var E = 0; E < r.length; E++) {
        var S = {};
        var y = analyzePipelineMarket(R, r[E], S);
        if (!y) {
          notePipelineRejection(e, u, g, r[E].name, S.reason || "not analyzable");
          continue;
        }
        if (!(y.net > 0)) {
          recordPipelineLoss(e, u, g, r[E].name, R, y);
          continue;
        }
        e.layoutSearches++;
        var h = labManager.getPipelineLayout(r[E].live, R);
        if (!h || !h.ok) {
          notePipelineRejection(e, u, g, r[E].name, h && h.reason || "no layout");
          continue;
        }
        var O = analyzeFullPipeline(R, r[E], h, S, y);
        if (!O) {
          notePipelineRejection(e, u, g, r[E].name, S.reason || "not analyzable");
          continue;
        }
        if (g === "synthesis" && (!d || O.creditsPerTick > d.creditsPerTick)) d = O;
        if (g === "decompose" && (!f || O.creditsPerTick > f.creditsPerTick)) f = O;
        if (!meetsStartProfitThreshold(O)) continue;
        if (g === "synthesis" && (!l || O.creditsPerTick > l.creditsPerTick)) l = O;
        if (g === "decompose" && (!p || O.creditsPerTick > p.creditsPerTick)) p = O;
      }
    }
    if (l) {
      e.forward.push(l);
      e.advancedCompounds[u] = true;
    }
    if (p) {
      e.reverse.push(p);
      e.advancedCompounds[u] = true;
    }
    recordPipelineShortfall(e, u, "forward", l, d);
    recordPipelineShortfall(e, u, "reverse", p, f);
  }
  e.forward.sort(function(e, t) {
    return t.creditsPerTick - e.creditsPerTick;
  });
  e.reverse.sort(function(e, t) {
    return t.creditsPerTick - e.creditsPerTick;
  });
  return e;
}

function fullPipelineDiagnostic() {
  if (!canRunFullPipelineDiscovery()) {
    const e = typeof Game !== "undefined" && Game.cpu && typeof Game.cpu.bucket === "number" ? Game.cpu.bucket : 1e4;
    return {
      ok: false,
      deferred: true,
      advancedRooms: [],
      forward: [],
      reverse: [],
      advancedCompounds: [],
      reason: e < FULL_PIPELINE_DIAGNOSTIC_MIN_BUCKET ? "CPU bucket " + e + " is below the safe diagnostic threshold of " + FULL_PIPELINE_DIAGNOSTIC_MIN_BUCKET : "insufficient CPU headroom for the full pipeline diagnostic",
      note: "read-only; retry when the bucket recovers; no market orders, reservations, or production jobs were created"
    };
  }
  var e = Game.cpu.getUsed();
  var t = getFullPipelineCandidates();
  var r = Game.cpu.getUsed() - e;
  function summarize(e) {
    return {
      compound: e.compound,
      room: e.plannedRoom,
      amount: e.targetOutput,
      creditsPerTick: e.creditsPerTick,
      expectedNetProfit: e.expectedNetProfit,
      expectedElapsedTicks: e.expectedElapsedTicks,
      leaves: e.pipelineLeaves,
      outputs: e.outputLegs,
      reactionCalls: e.pipelineReactionCalls,
      transferEnergyCost: e.transferEnergyCost
    };
  }
  return {
    ok: true,
    amount: FULL_PIPELINE_OUTPUT,
    advancedRooms: t.rooms,
    forward: t.forward.map(summarize),
    reverse: t.reverse.map(summarize),
    advancedCompounds: Object.keys(t.advancedCompounds).sort(),
    startThreshold: MIN_START_CREDITS_PER_TICK,
    rejections: t.rejections,
    losses: t.losses.slice().sort(function(e, t) {
      return (t.netProfit || 0) - (e.netProfit || 0);
    }),
    layoutSearches: t.layoutSearches,
    cpuSpent: r,
    cpuLimit: Game.cpu.limit,
    shortfalls: t.shortfalls.slice().sort(function(e, t) {
      return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
    }),
    note: "read-only; no market orders, reservations, or production jobs are created"
  };
}

function formatPipelineLegs(e, t, r) {
  var o = [];
  for (var n in e) {
    if (!Object.prototype.hasOwnProperty.call(e, n)) continue;
    var i = t ? t[n] : null;
    o.push(n + " x" + e[n] + " @" + (typeof i === "number" ? i.toFixed(3) : "n/a") + "[" + (r && r[n] || "?") + "]");
  }
  return o.length ? o.join(", ") : "none";
}

function formatPipelineOutputLegs(e, t, r) {
  if (!Array.isArray(e) || !e.length) return "none";
  var o = [];
  for (var n = 0; n < e.length; n++) {
    var i = e[n].resource;
    var a = t ? t[i] : null;
    var s = a && typeof a.price === "number" ? a.price : null;
    o.push(i + " x" + e[n].amount + " @" + (s !== null ? s.toFixed(3) : "n/a") + "[" + (r && r[i] || a && a.source || "?") + "]");
  }
  return o.join(", ");
}

function appendPipelineEntries(e, t, r) {
  for (var o = 0; o < Math.min(t.length, r); o++) {
    var n = t[o];
    e.push("  " + n.compound + "/" + n.direction + "@" + n.room + " " + (typeof n.creditsPerTick === "number" ? n.creditsPerTick.toFixed(4) + " cr/t" : "untimed") + " | net " + Math.round(n.netProfit || 0) + " = revenue " + Math.round(n.revenue || 0) + " - inputs " + Math.round(n.inputCost || 0) + " - transferEnergy " + Math.round(n.transferEnergyCost || 0) + " - fees " + Math.round(n.marketFees || 0) + (n.elapsedTicks ? " over " + Math.round(n.elapsedTicks) + "t" : ""));
    e.push("    buy: " + formatPipelineLegs(n.inputQuantities, n.inputPrices, n.inputSources));
    e.push("    sell: " + formatPipelineOutputLegs(n.outputLegs, n.outputQuotes, n.outputSources));
  }
  if (t.length > r) e.push("  ... +" + (t.length - r) + " more");
}

function formatFullPipelineDiagnostic(e) {
  if (!e) return "[AutoTrader] Full pipeline diagnostic: no report";
  if (e.deferred) return "[AutoTrader] Full pipeline diagnostic: DEFERRED\n" + e.reason + "\n" + e.note;
  var t = [ "[AutoTrader] Full pipeline diagnostic: " + (e.advancedRooms.length ? e.advancedRooms.map(function(e) {
    return e.name + "(labs " + e.labCount + ")";
  }).join(", ") : "no eligible RCL8/10-lab rooms") ];
  function append(e, r) {
    if (!r.length) {
      t.push(e + ": none");
      return;
    }
    t.push(e + ": " + r.map(function(e) {
      return e.compound + "@" + e.room + " " + (typeof e.creditsPerTick === "number" ? e.creditsPerTick.toFixed(3) : "n/a") + " cr/t";
    }).join(", "));
  }
  append("Full synthesis", e.forward);
  append("Full decomposition", e.reverse);
  var r = e.shortfalls || [];
  if (r.length) {
    t.push("Scored but below the " + e.startThreshold + " cr/t start threshold:");
    appendPipelineEntries(t, r, 6);
  }
  var o = e.losses || [];
  if (o.length) {
    t.push("Unprofitable before timing (no layout searched):");
    appendPipelineEntries(t, o, 6);
  }
  var n = e.rejections || {};
  var i = Object.keys(n);
  if (i.length) {
    i.sort(function(e, t) {
      return n[t].count - n[e].count;
    });
    t.push("Not scored at all:");
    for (var a = 0; a < i.length; a++) {
      var s = n[i[a]];
      t.push("  " + s.count + "x " + i[a] + " (" + s.compounds.join(", ") + (s.count > s.compounds.length ? ", ..." : "") + ")");
    }
  }
  t.push("Layout searches: " + (e.layoutSearches || 0) + " | scan CPU " + (typeof e.cpuSpent === "number" ? e.cpuSpent.toFixed(1) : "n/a") + " of limit " + (e.cpuLimit || "n/a"));
  t.push("Advanced compounds withheld from one-step scheduling: " + e.advancedCompounds.length);
  t.push(e.note);
  return t.join("\n");
}

function findPipelineRoomIndex(e, t) {
  if (!Array.isArray(e) || !t) return -1;
  for (var r = 0; r < e.length; r++) {
    if (e[r] && e[r].name === t.plannedRoom && getRoomLabCount(e[r].name) >= 10) return r;
  }
  return -1;
}

function canScheduleStandaloneLabCandidate(e) {
  if (!e || e.type !== "forward" || !labCommodityPolicy.isTwoLetterLabProduct(e.compound)) return true;
  return e.restrictedStandaloneExit === true;
}

function buildTwoStepCandidates(e, t, r, o, n, i) {
  const a = [];
  if (!r && shouldDeferAutoTraderCpu()) {
    const e = [];
    e.completed = false;
    return e;
  }
  const s = [];
  const c = {};
  const u = {};
  const l = Object.keys(e || {});
  for (var p = 0; p < l.length; p++) {
    const t = e[l[p]] || {};
    if (t.forward) s.push(t.forward);
    if (t.reverse) s.push(t.reverse);
  }
  const d = Object.keys(t || {});
  for (var f = 0; f < d.length; f++) {
    if (t[d[f]]) s.push(t[d[f]]);
  }
  function outputLegs(e) {
    if (!e) return [];
    const t = e.type === "factory" ? e.expectedOutput || e.outputQuantity || 0 : e.targetOutput || e.batchSize || 0;
    if (!(t > 0)) return [];
    if (e.type === "reverse") {
      return [ {
        resource: e.reagentA,
        amount: t,
        price: e.outputQuotes && e.outputQuotes[e.reagentA] ? e.outputQuotes[e.reagentA].price : null
      }, {
        resource: e.reagentB,
        amount: t,
        price: e.outputQuotes && e.outputQuotes[e.reagentB] ? e.outputQuotes[e.reagentB].price : null
      } ];
    }
    const r = e.type === "factory" ? e.product : e.compound;
    return [ {
      resource: r,
      amount: t,
      price: e.unitPrice || e.compoundPrice || e.price || null
    } ];
  }
  function getBreakdownLeafQuote(e, t) {
    if (!(t > 0)) return null;
    if (n && pricing && typeof pricing.getConversionExitQuote === "function") {
      const r = pricing.getConversionExitQuote(e, t, n);
      if (r && r.price > 0) return r;
    }
    const r = priceOfWithSource(e, "PASSIVE_SELL");
    return r && r.price > 0 ? {
      price: r.price,
      amount: t
    } : null;
  }
  function elapsed(e) {
    return e && typeof e.expectedElapsedTicks === "number" && e.expectedElapsedTicks > 0 ? e.expectedElapsedTicks : Infinity;
  }
  function downstreamFinalLegs(e, t) {
    if (!e || !(t > 0)) return [];
    if (e.type === "reverse") {
      return [ {
        resource: e.reagentA,
        amount: t,
        price: e.outputQuotes && e.outputQuotes[e.reagentA] ? e.outputQuotes[e.reagentA].price : null
      }, {
        resource: e.reagentB,
        amount: t,
        price: e.outputQuotes && e.outputQuotes[e.reagentB] ? e.outputQuotes[e.reagentB].price : null
      } ];
    }
    const r = e.type === "factory" ? e.product : e.compound;
    return [ {
      resource: r,
      amount: t,
      price: e.unitPrice
    } ];
  }
  function hasSellHeadroomForLegs(e) {
    if (!o) return true;
    const t = {};
    for (var r = 0; r < e.length; r++) {
      const o = e[r];
      if (!o || !o.resource || !(o.amount > 0)) return false;
      t[o.resource] = (t[o.resource] || 0) + o.amount;
    }
    for (var n in t) {
      if (sellHeadroom(o, n) < t[n]) return false;
    }
    return true;
  }
  function hasDownstreamSellHeadroom(e, t) {
    return hasSellHeadroomForLegs(downstreamFinalLegs(e, t));
  }
  const m = [];
  for (var g = 0; g < d.length; g++) {
    const e = t[d[g]];
    if (!e || e.isLocalRefine || !e.inputQuantities || !(e.expectedOutput > 0) || !(e.expectedNetProfit !== undefined) || !(e.unitPrice > 0) || !isFinite(elapsed(e))) continue;
    m.push({
      type: "factory",
      product: e.product,
      inputQuantities: e.inputQuantities,
      expectedOutput: e.expectedOutput,
      outputQuantity: e.outputQuantity || 1,
      targetCycles: e.targetCycles > 0 ? e.targetCycles : MARKET_REFINE_BATCH_MULTIPLIER,
      totalCost: e.totalCost,
      expectedRevenue: e.expectedRevenue,
      unitPrice: e.unitPrice,
      expectedElapsedTicks: e.expectedElapsedTicks,
      inputAcquisitionPrices: e.inputAcquisitionPrices,
      inputPrices: e.inputPrices,
      plannedRoom: e.plannedRoom || null,
      isDecompress: !!e.isDecompress
    });
  }
  for (var R = 0; R < l.length; R++) {
    const t = e[l[R]] || {};
    if (t.forward) {
      const e = t.forward;
      const r = e.targetOutput || (e.batchSize || 5) * Math.max(1, Math.ceil((e.targetOutput || LAB_PROJECTED_OUTPUT) / (e.batchSize || 5)));
      const o = e.unitPrice || e.compoundPrice;
      if (e.inputQuantities && r > 0 && e.expectedNetProfit !== undefined && o > 0 && isFinite(elapsed(e))) {
        const t = Math.max(1, Math.ceil((e.targetOutput || LAB_PROJECTED_OUTPUT) / (e.batchSize || 5)));
        const n = {};
        if (e.inputAcquisitionPrices) {
          for (var E in e.inputAcquisitionPrices) {
            if (e.inputAcquisitionPrices.hasOwnProperty(E)) n[E] = e.inputAcquisitionPrices[E];
          }
        }
        if (e.reagentAPrice > 0) n[e.reagentA] = e.reagentAPrice;
        if (e.reagentBPrice > 0) n[e.reagentB] = e.reagentBPrice;
        m.push({
          type: "forward",
          compound: e.compound,
          inputQuantities: e.inputQuantities,
          expectedOutput: r,
          outputQuantity: e.batchSize || 5,
          targetCycles: t,
          totalCost: e.totalCost,
          expectedRevenue: e.expectedRevenue,
          unitPrice: o,
          expectedElapsedTicks: e.expectedElapsedTicks,
          inputAcquisitionPrices: n,
          inputPrices: e.inputPrices,
          plannedRoom: e.plannedRoom || null
        });
      }
    }
    if (t.reverse) {
      const e = t.reverse;
      const r = e.targetOutput || (e.batchSize || 5) * Math.max(1, Math.ceil((e.targetOutput || LAB_PROJECTED_OUTPUT) / (e.batchSize || 5)));
      const o = e.unitPrice || e.compoundPrice;
      if (e.inputQuantities && r > 0 && e.expectedNetProfit !== undefined && o > 0 && isFinite(elapsed(e))) {
        const t = Math.max(1, Math.ceil((e.targetOutput || LAB_PROJECTED_OUTPUT) / (e.batchSize || 5)));
        const n = {};
        if (e.inputAcquisitionPrices) {
          for (var S in e.inputAcquisitionPrices) {
            if (e.inputAcquisitionPrices.hasOwnProperty(S)) n[S] = e.inputAcquisitionPrices[S];
          }
        }
        if (e.compoundPrice > 0) n[e.compound] = e.compoundPrice;
        m.push({
          type: "reverse",
          compound: e.compound,
          inputQuantities: e.inputQuantities,
          expectedOutput: r,
          outputQuantity: e.batchSize || 5,
          targetCycles: t,
          totalCost: e.totalCost,
          expectedRevenue: e.expectedRevenue,
          unitPrice: o,
          expectedElapsedTicks: e.expectedElapsedTicks,
          inputAcquisitionPrices: n,
          inputPrices: e.inputPrices,
          plannedRoom: e.plannedRoom || null
        });
      }
    }
  }
  const y = {};
  const h = Object.keys(i || {});
  const O = {
    considered: 0,
    profitable: 0,
    sellBlocked: 0,
    details: []
  };
  const v = n ? {
    name: n,
    labCount: getRoomLabCount(n)
  } : null;
  function buildReverseProfile(t) {
    const r = i[t];
    if (!r || r.length !== 2) return null;
    const o = LAB_PROJECTED_OUTPUT;
    const a = e[t] && e[t].reverse;
    const s = a || (v ? scoreOpportunity(analyzeReverseReaction(t, i, "PASSIVE_SELL", "PASSIVE_BUY", n), v) : null);
    const c = [];
    for (var u = 0; u < r.length; u++) {
      const e = getBreakdownLeafQuote(r[u], o);
      if (!e || !(e.price > 0)) return null;
      c.push({
        resource: r[u],
        amount: o,
        price: e.price
      });
    }
    const l = c[0].price * o + c[1].price * o;
    let p = s && typeof s.materialCost === "number" && s.materialCost >= 0 ? s.materialCost : null;
    let d = s && typeof s.totalCost === "number" && s.totalCost >= 0 ? s.totalCost : null;
    if (!(p >= 0) || !(d >= p)) {
      const e = getVolumeWeightedBuyPrice(t, o, n);
      if (!e || !(e.price > 0)) return null;
      p = e.price * o;
      d = p + (p + l) * .05 + p * .02;
    }
    const f = s && isFinite(elapsed(s)) ? elapsed(s) : 400 + 80 + Math.ceil(o / Math.max(1, LAB_REACTION_AMOUNT || 5)) * reactionTimeFor(t) + 300;
    return {
      compound: t,
      amount: o,
      materialCost: p,
      totalCost: d,
      nonInputCost: Math.max(0, d - p),
      expectedRevenue: l,
      elapsed: f,
      legs: c
    };
  }
  for (var b = 0; b < h.length; b++) {
    const e = buildReverseProfile(h[b]);
    if (e) y[e.compound] = e;
  }
  function copyBreakdownPath(e, t) {
    const r = {};
    for (var o in e) {
      if (e.hasOwnProperty(o)) r[o] = true;
    }
    r[t] = true;
    return r;
  }
  function evaluateBreakdown(e, t, r, o) {
    const n = y[e];
    if (!n || t > TWO_STEP_MAX_BREAKDOWN_DEPTH || r[e]) return null;
    o.nodes++;
    if (o.nodes > TWO_STEP_MAX_BREAKDOWN_NODES) return null;
    const i = copyBreakdownPath(r, e);
    const a = [];
    const s = [];
    let c = n.expectedRevenue - n.nonInputCost;
    let u = n.elapsed;
    let l = 1;
    for (var p = 0; p < n.legs.length; p++) {
      const e = n.legs[p];
      const r = y[e.resource];
      const f = r ? r.amount : 0;
      const m = r && f > 0 && t < TWO_STEP_MAX_BREAKDOWN_DEPTH && !i[e.resource] ? Math.floor(e.amount / f) : 0;
      let g = null;
      if (m > 0) {
        g = evaluateBreakdown(e.resource, t + 1, i, o);
      }
      if (!g) {
        a.push({
          resource: e.resource,
          amount: e.amount,
          price: e.price
        });
        s.push({
          resource: e.resource,
          expanded: false
        });
        continue;
      }
      const R = m * f;
      c += g.freeInputNet * m - e.price * R;
      u += g.elapsedTicks * m;
      l += g.operationCount * m;
      for (var d = 0; d < g.leaves.length; d++) {
        a.push({
          resource: g.leaves[d].resource,
          amount: g.leaves[d].amount * m,
          price: g.leaves[d].price
        });
      }
      s.push({
        resource: e.resource,
        expanded: true,
        tree: g.tree
      });
      if (R < e.amount) {
        a.push({
          resource: e.resource,
          amount: e.amount - R,
          price: e.price
        });
      }
    }
    return {
      freeInputNet: c,
      elapsedTicks: u,
      operationCount: l,
      leaves: a,
      tree: {
        compound: e,
        children: s
      }
    };
  }
  const T = {};
  for (var P = 0; P < m.length && a.length < TWO_STEP_MAX_CHAINS; P++) {
    const e = m[P];
    const t = e.targetCycles > 0 ? e.targetCycles : MARKET_REFINE_BATCH_MULTIPLIER;
    const r = e.outputQuantity * t;
    const o = e.totalCost;
    const i = e.type + ":" + (e.product || e.compound);
    if (!hasDownstreamSellHeadroom(e, r)) continue;
    for (var C = 0; C < s.length; C++) {
      const a = s[C];
      if (!a || !(a.totalCost >= 0) || !isFinite(elapsed(a))) continue;
      if (a.type === e.type && (a.product || a.compound) === (e.product || e.compound)) continue;
      const l = outputLegs(a);
      for (var A = 0; A < l.length; A++) {
        const s = l[A];
        if (!s.resource || !(s.amount > 0)) continue;
        const p = e.inputQuantities[s.resource] || 0;
        if (!(p > 0)) continue;
        const d = p * t;
        const f = Math.max(1, Math.ceil(d / s.amount));
        const m = f * s.amount;
        const g = e.inputAcquisitionPrices && e.inputAcquisitionPrices[s.resource] > 0 ? e.inputAcquisitionPrices[s.resource] : e.inputPrices && e.inputPrices[s.resource] > 0 ? e.inputPrices[s.resource] : null;
        if (!(g > 0)) continue;
        const R = g * d;
        const E = a.totalCost / s.amount;
        const S = E * m;
        const y = o - R + S;
        if (!(y >= 0) || !isFinite(y)) continue;
        const h = e.expectedRevenue || e.unitPrice * r;
        const O = h - y;
        const v = elapsed(e) + elapsed(a) * f;
        const b = v > 0 ? O / v : null;
        if (!(O > 0) || !(v > 0) || !isFinite(O) || !isFinite(v) || !meetsStartProfitThreshold({
          creditsPerTick: b
        })) continue;
        const P = a.type + ":" + (a.compound || a.product) + ">" + i + ":" + s.resource;
        if (c[P]) continue;
        c[P] = true;
        const C = a.type + ":" + (a.compound || a.product);
        if (!u[i]) u[i] = {};
        if (u[i][C]) continue;
        if (Object.keys(u[i]).length >= TWO_STEP_MAX_PRODUCERS_PER_OUTPUT) continue;
        u[i][C] = true;
        const k = [];
        for (var _ = 0; _ < l.length; _++) {
          if (_ === A) continue;
          k.push({
            resource: l[_].resource,
            amount: l[_].amount * f,
            price: l[_].price
          });
        }
        const L = {
          type: "twoStep",
          intermediate: s.resource,
          upstream: a.type + ":" + (a.compound || a.product),
          downstream: e.product || e.compound,
          downstreamKind: e.type,
          room: a.plannedRoom || e.plannedRoom || n,
          finalOutput: r,
          intermediateNeeded: d,
          intermediateProduced: m,
          upstreamBatches: f,
          expectedNetProfit: O,
          expectedElapsedTicks: v,
          creditsPerTick: b,
          conservative: m > d,
          upstreamOpportunity: a,
          downstreamOpportunity: e,
          upstreamInputs: a.inputQuantities || {},
          upstreamOutputLegs: l,
          residualOutputLegs: k,
          downstreamInputs: e.inputQuantities || {},
          finalOutputLegs: downstreamFinalLegs(e, r)
        };
        const I = T[i];
        if (!I || L.creditsPerTick > I.creditsPerTick) {
          T[i] = L;
        }
      }
    }
  }
  for (var k in T) {
    if (T.hasOwnProperty(k)) a.push(T[k]);
  }
  for (var L in y) {
    if (!y.hasOwnProperty(L)) continue;
    const e = y[L];
    O.considered++;
    const t = {
      nodes: 0
    };
    const r = evaluateBreakdown(L, 0, {}, t);
    if (!r || r.leaves.length === 0) continue;
    const o = e.expectedRevenue - e.totalCost;
    const n = r.freeInputNet - e.materialCost;
    if (!(n > 0) || !(n > o)) continue;
    O.profitable++;
    const i = r.elapsedTicks;
    if (!(i > 0) || !isFinite(i)) continue;
    const s = hasSellHeadroomForLegs(r.leaves);
    if (!s) O.sellBlocked++;
    a.push({
      type: "breakdown",
      breakdown: true,
      upstream: "reverse:" + L,
      downstream: "sell leaves",
      intermediate: L,
      breakdownRoot: L,
      breakdownTree: r.tree,
      breakdownLeaves: r.leaves,
      directNetProfit: o,
      expectedNetProfit: n,
      expectedElapsedTicks: i,
      creditsPerTick: n / i,
      operationCount: r.operationCount,
      sellCapacityOk: s,
      advantage: n - o,
      conservative: true
    });
  }
  a.sort(function(e, t) {
    return t.creditsPerTick - e.creditsPerTick;
  });
  const I = a.slice(0, TWO_STEP_MAX_CHAINS);
  I.completed = true;
  I.breakdownStats = O;
  return I;
}

//   forward:GH2O [GH+O -> GH2O] => [GH2O+X -> XGH2O]
function renderTwoStepChain(e) {
  if (!e) return "";
  if (e.breakdown) {
    function renderTree(e) {
      if (!e) return "?";
      const t = [];
      for (var r = 0; r < (e.children || []).length; r++) {
        const o = e.children[r];
        t.push(o.expanded && o.tree ? renderTree(o.tree) : o.resource);
      }
      return e.compound + " -> " + (t.join(" + ") || "?");
    }
    const a = (e.breakdownLeaves || []).map(function(e) {
      return e.resource + "x" + Math.floor(e.amount);
    }).join(" + ") || "?";
    return "breakdown:" + (e.breakdownRoot || "?") + " [" + renderTree(e.breakdownTree) + "] => sell " + a + (e.sellCapacityOk ? "" : " [sell-cap blocked]") + " (+" + Math.floor(e.advantage || 0) + " net vs direct)";
  }
  const t = e.upstream || "?";
  const r = Object.keys(e.upstreamInputs || {}).join("+") || "?";
  const o = (e.upstreamOutputLegs || []).map(function(e) {
    return e.resource;
  }).join("+") || "?";
  const n = Object.keys(e.downstreamInputs || {}).join("+") || "?";
  const i = (e.finalOutputLegs || []).map(function(e) {
    return e.resource;
  }).join("+") || "?";
  return t + " [" + r + " -> " + o + "] => [" + n + " -> " + i + "]";
}

function reconcileNormalChains(e, t) {
  if (!t) return;
  if (!t.twoStepShadow) t.twoStepShadow = {
    lastScanTick: 0,
    chains: []
  };
  t.twoStepShadow.lastScanTick = Game.time;
  const r = [];
  const o = Math.min(10, e.length);
  for (var n = 0; n < o; n++) {
    const t = e[n];
    r.push({
      upstream: t.upstream,
      downstream: t.downstream,
      intermediate: t.intermediate,
      creditsPerTick: t.creditsPerTick,
      expectedNetProfit: t.expectedNetProfit
    });
  }
  t.twoStepShadow.chains = r;
  requestSave();
}

function twoStepQueueKey(e) {
  return e && e.upstream + ">" + e.downstream + ">" + e.intermediate + ">" + e.finalOutput;
}

function twoStepQueueMemory(e) {
  if (!e.twoStepQueue || typeof e.twoStepQueue !== "object") e.twoStepQueue = {};
  return e.twoStepQueue;
}

function twoStepStageLive(e) {
  if (!e || !e.operationId) return false;
  var t;
  if (e.system === "marketLab") t = getLabOperations(); else if (e.system === "marketRefine") t = marketRefine.getOperations ? marketRefine.getOperations() : []; else if (e.system === "localRefine") t = localRefine.getOperations ? localRefine.getOperations() : []; else return false;
  for (var r = 0; r < t.length; r++) {
    if (t[r] && t[r].id === e.operationId) return true;
  }
  return false;
}

function twoStepStageOutcome(e) {
  if (!e || !e.jobId || !marketEconomics || typeof marketEconomics.get !== "function") return null;
  var t = marketEconomics.get(e.jobId);
  if (!t || !t.status) return null;
  if (t.status === "done" || t.status === "failed" || t.status === "cancelled") return t;
  return null;
}

function releaseTwoStepReservation(e) {
  if (!e || !e.room || !e.reservationProgram || !e.intermediate) return;
  storageManager.unReserve(e.room, e.intermediate, "terminal", e.reservationProgram);
  storageManager.unReserve(e.room, e.intermediate, "storage", e.reservationProgram);
  e.reservationActive = false;
}

function twoStepIntermediatePresent(e) {
  if (!e || !e.room || !(e.intermediateAmount > 0)) return false;
  var t = getRoomState.get(e.room);
  return !!(t && roomWideCount(e.room, e.intermediate) >= e.intermediateAmount);
}

function twoStepFinalExposureAvailable(e, t) {
  if (!e || !t) return false;
  var r = {};
  var o = (e.finalOutputLegs || []).concat(e.residualOutputLegs || []);
  for (var n = 0; n < o.length; n++) {
    var i = o[n];
    if (!i || !i.resource || !(i.amount > 0)) continue;
    r[i.resource] = (r[i.resource] || 0) + i.amount;
  }
  for (var a in r) {
    if (sellHeadroom(t, a) < r[a]) return false;
  }
  for (var s in r) addSellExposure(t, "prospective", s, r[s]);
  return true;
}

function refreshTwoStepDownstreamQuote(e) {
  if (!e || !e.chain || !e.room || !pricing || typeof pricing.getConversionExitQuote !== "function") {
    return {
      ok: false,
      reason: "conversion exit quote unavailable"
    };
  }
  var t = e.chain;
  var r = t.downstreamOpportunity;
  var o = t.finalOutputLegs || [];
  if (!r || o.length === 0) {
    return {
      ok: false,
      reason: "downstream output legs unavailable"
    };
  }
  var n = 0;
  var i = 0;
  var a = 0;
  var s = [];
  for (var c = 0; c < o.length; c++) {
    var u = o[c];
    if (!u || !u.resource || !(u.amount > 0)) {
      return {
        ok: false,
        reason: "invalid downstream output leg"
      };
    }
    var l = pricing.getConversionExitQuote(u.resource, u.amount, e.room);
    if (!l || !(l.price > 0)) {
      return {
        ok: false,
        reason: "no current exit quote for " + u.resource
      };
    }
    if (l.source !== "LIVE_BID" && l.method !== "LIVE_BID" && l.source !== "CROSSED_BID" && l.method !== "CROSSED_BID") {
      return {
        ok: false,
        reason: "no executable bid for " + u.resource + " (" + (l.source || l.method || "unknown") + ")"
      };
    }
    var p = typeof u.price === "number" && u.price > 0 ? u.price : l.price;
    i += p * u.amount;
    n += l.price * u.amount;
    a += l.transferEnergy || 0;
    s.push({
      leg: u,
      quote: l
    });
  }
  var d = statusEnergyPrice() || 0;
  var f = r.outputTransferEnergy || 0;
  var m = (t.expectedNetProfit || 0) + (n - i) - (a - f) * d;
  var g = t.expectedElapsedTicks || 0;
  var R = g > 0 ? m / g : null;
  if (!meetsStartProfitThreshold({
    creditsPerTick: R
  })) {
    return {
      ok: false,
      reason: "current downstream exit quote lowers chain to " + (typeof R === "number" ? R.toFixed(3) : "n/a") + " cr/t"
    };
  }
  for (var E = 0; E < s.length; E++) {
    s[E].leg.price = s[E].quote.price;
  }
  r.outputTransferEnergy = a;
  if (r.type === "factory") r.unitPrice = s[0].quote.price; else r.compoundPrice = s[0].quote.price;
  t.expectedNetProfit = m;
  t.creditsPerTick = R;
  return {
    ok: true,
    quotes: s
  };
}

function startTwoStepStage(e, t) {
  var r = t === 1 ? e.chain.upstreamOpportunity : e.chain.downstreamOpportunity;
  if (!r || !e.room) return null;
  var o = marketEconomics.mintJobId();
  var n = r.compound || r.product;
  marketEconomics.start(o, {
    kind: "autoTraderTwoStep" + t,
    room: e.room,
    product: n,
    expectedNetProfit: r.expectedNetProfit,
    expectedElapsedTicks: r.expectedElapsedTicks,
    expectedCreditsPerTick: r.creditsPerTick
  });
  marketEconomics.phase(o, "queued");
  var i = null;
  var a = {
    system: null,
    operationId: null,
    jobId: o
  };
  if (r.type === "forward" || r.type === "reverse") {
    var s;
    var c = {};
    if (t === 1) {
      c.handoff = true;
      c.handoffResource = e.intermediate;
      c.handoffAmount = e.intermediateAmount;
      c.handoffReservationProgram = e.reservationProgram;
    } else {
      var u = e.chain.intermediateNeeded > 0 ? e.chain.intermediateNeeded : e.intermediateAmount;
      c.handoffInputResource = e.intermediate;
      c.handoffInputAmount = u;
      c.handoffInputProgram = e.reservationProgram;
    }
    if (r.type === "reverse") s = r.compoundPrice > 0 ? r.compoundPrice : undefined; else {
      s = {};
      if (r.reagentAPrice > 0) s[r.reagentA] = r.reagentAPrice;
      if (r.reagentBPrice > 0) s[r.reagentB] = r.reagentBPrice;
    }
    i = marketLab.startAutoOperation(r.type, e.room, r.compound, s, o, c);
    if (typeof i === "string" && i.indexOf("[" + (r.type === "forward" ? "labForward" : "labReverse") + "] Queued:") === 0) {
      a.system = "marketLab";
      a.operationId = marketLab.getNewestOperationId(r.type, e.room, r.compound, Game.time);
    }
  } else if (r.type === "factory" && !r.isLocalRefine) {
    var l = {
      jobId: o
    };
    if (t === 1) {
      l.handoff = {
        resource: e.intermediate,
        amount: e.intermediateAmount
      };
      l.handoffReservationProgram = e.reservationProgram;
    } else {
      l.handoffInput = {
        resource: e.intermediate,
        amount: e.intermediateAmount
      };
      l.handoffReservationProgram = e.reservationProgram;
    }
    i = marketRefine.start(e.room, r.product, r.inputPrices || r.inputAcquisitionPrices, l);
    var p = typeof i === "string" ? i.match(/Started (mref_[^\s|]+)/) : null;
    if (p) {
      a.system = "marketRefine";
      a.operationId = p[1];
    }
  }
  if (!a.system || !a.operationId) {
    marketEconomics.finish(o, "refused", "" + i);
    return null;
  }
  marketEconomics.link(o, a.system, a.operationId);
  if (a.system === "marketLab") {
    const labOps = typeof marketLab.getOperations === "function" ? marketLab.getOperations() : [];
    let pending = false;
    for (let e = 0; e < labOps.length; e++) {
      if (labOps[e] && labOps[e].id === a.operationId) {
        pending = labOps[e].state === "PENDING";
        break;
      }
    }
    marketEconomics.phase(o, pending ? "pending" : "buying");
  } else {
    marketEconomics.phase(o, "buying");
  }
  return a;
}

function recordTwoStepHistory(e, t, r, o) {
  if (!e || !t || !o || !o.jobId || t["historyStage" + r]) return;
  var n = r === 1 ? t.chain.upstreamOpportunity : t.chain.downstreamOpportunity;
  if (!n) return;
  var i = {
    type: n.type === "factory" ? "factory" : n.type,
    compound: n.compound,
    product: n.product,
    room: t.room,
    expectedCreditsPerTick: n.creditsPerTick,
    expectedNetProfit: n.expectedNetProfit,
    expectedElapsedTicks: n.expectedElapsedTicks,
    jobId: o.jobId,
    tick: Game.time,
    twoStepStage: r,
    twoStepRole: r === 1 ? "upstream" : "downstream",
    twoStepChain: t.chainKey,
    isDecompress: !!n.isDecompress
  };
  if (o.system === "marketLab") i.opId = o.operationId;
  if (o.system === "marketRefine") i.marketRefineOpId = o.operationId;
  if (!Array.isArray(e.jobsStarted)) e.jobsStarted = [];
  e.jobsStarted.push(memoryManager.compactAutoTraderJob(i));
  t["historyStage" + r] = true;
  if (e.jobsStarted.length > JOBS_HISTORY_CAP) e.jobsStarted = e.jobsStarted.slice(-JOBS_HISTORY_CAP);
  requestSave();
}

function pruneTwoStepQueue(e) {
  if (!e || !e.twoStepQueue || typeof e.twoStepQueue !== "object") return;
  var t = e.twoStepQueue;
  var r = Object.keys(t);
  for (var o = 0; o < r.length; o++) {
    var n = r[o];
    var i = t[n];
    if (!i) {
      delete t[n];
      continue;
    }
    var a = twoStepStageLive(i.stage1);
    var s = twoStepStageLive(i.stage2);
    if ((i.status === "done" || i.status === "failed") && !a && !s) {
      releaseTwoStepReservation(i);
      delete t[n];
      continue;
    }
    if (!a && !s) {
      if (i.status === "blocked" && i.nextRetryTick && Game.time > i.nextRetryTick + 500) {
        releaseTwoStepReservation(i);
        delete t[n];
        continue;
      }
      if (i.createdTick && Game.time - i.createdTick > 5e3) {
        releaseTwoStepReservation(i);
        delete t[n];
        continue;
      }
    }
  }
}

function processTwoStepQueue(e, t, r) {
  retireLegacyTwoStepQueue(e);
  return 0;
  /*
    if (!mem || !marketEconomics || typeof marketEconomics.mintJobId !== 'function') return 0;
    pruneTwoStepQueue(mem);
    var queue = twoStepQueueMemory(mem);
    var exposure = { listed: {}, activeLab: {}, activeFactory: {}, prospective: {} };
    buildCurrentSellAmounts(null, exposure);
    var added = 0;
    var source = Array.isArray(candidates) ? candidates : [];
    for (var ci = 0; ci < source.length && added < TWO_STEP_MAX_CHAINS; ci++) {
        var candidate = source[ci];
        if (!candidate || candidate.breakdown || !candidate.upstreamOpportunity || !candidate.downstreamOpportunity || !candidate.room ||
                candidate.upstreamOpportunity.isLocalRefine || candidate.downstreamOpportunity.isLocalRefine ||
                !meetsStartProfitThreshold(candidate)) continue;
        var candidateKey = twoStepQueueKey(candidate);
        if (!queue[candidateKey]) {
            queue[candidateKey] = {
                chain: candidate,
                room: candidate.room,
                chainKey: candidateKey,
                intermediate: candidate.intermediate,
                intermediateAmount: candidate.intermediateProduced,
                intermediateNeeded: candidate.intermediateNeeded || candidate.intermediateProduced,
                reservationProgram: 'autoTraderTwoStep_' + String(candidateKey).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80),
                reservationActive: false,
                stage: 1,
                attempts: 0,
                status: 'queued',
                createdTick: Game.time
            };
            added++;
        } else {
            // Prices in a candidate are a discovery snapshot. Keep a queued
            // chain's live stage/reservation identity, but refresh its economic
            // snapshot whenever a later scan finds the same chain again.
            var existing = queue[candidateKey];
            if (existing && !existing.stage2) {
                existing.chain = candidate;
                if (!existing.stage1) {
                    existing.intermediate = candidate.intermediate;
                    existing.intermediateAmount = candidate.intermediateProduced;
                    existing.intermediateNeeded = candidate.intermediateNeeded || candidate.intermediateProduced;
                }
            }
        }
    }
    var acted = 0;
    for (var key in queue) {
        var entry = queue[key];
        if (!entry || entry.status === 'done' || entry.status === 'failed') continue;
        if (entry.nextRetryTick && Game.time < entry.nextRetryTick) continue;
        if (entry.stage === 1) {
            if (!entry.stage1) {
                if (dryRun || entry.attempts >= TWO_STEP_MAX_ATTEMPTS) continue;
                entry.attempts++;
                entry.stage1 = startTwoStepStage(entry, 1);
                if (entry.stage1) {
                    entry.reservationActive = true;
                    recordTwoStepHistory(mem, entry, 1, entry.stage1);
                }
                if (!entry.stage1) entry.nextRetryTick = Game.time + TWO_STEP_RETRY_TICKS;
                else { entry.status = 'stage1'; entry.nextRetryTick = 0; acted++; }
                requestSave();
                continue;
            }
            var firstOutcome = twoStepStageOutcome(entry.stage1);
            if (!firstOutcome) {
                if (twoStepStageLive(entry.stage1)) continue;
                entry.nextRetryTick = Game.time + TWO_STEP_RETRY_TICKS;
                requestSave();
                continue;
            }
            if (firstOutcome.status !== 'done') {
                releaseTwoStepReservation(entry);
                if (entry.attempts < TWO_STEP_MAX_ATTEMPTS) {
                    delete entry.stage1;
                    entry.nextRetryTick = Game.time + TWO_STEP_RETRY_TICKS;
                } else { entry.status = 'failed'; entry.reason = firstOutcome.reason || 'stage 1 failed'; }
                requestSave();
                continue;
            }
            if (!twoStepIntermediatePresent(entry)) continue;
            // Stage 1 is complete only after its owned handoff amount is
            // physically present. Preserve the reservation through stage 2.
            entry.stage = 2;
            // The stage-1 reservation is intentionally retained and passed to
            // stage 2; the downstream releases it when its input is committed.
            entry.status = 'stage1-complete';
            entry.nextRetryTick = 0;
            requestSave();
        }
        if (entry.stage === 2) {
            if (entry.stage2) {
                var secondOutcome = twoStepStageOutcome(entry.stage2);
                if (secondOutcome) {
                    releaseTwoStepReservation(entry);
                    entry.status = secondOutcome.status === 'done' ? 'done' : 'failed';
                    entry.reason = secondOutcome.reason || null;
                    requestSave();
                }
                continue;
            }
            if (!twoStepIntermediatePresent(entry)) continue;
            var refreshedExit = refreshTwoStepDownstreamQuote(entry);
            if (!refreshedExit.ok) {
                // Do not strand the upstream output while the downstream market
                // is unexecutable or no longer clears the start threshold. The
                // downstream can re-reserve the input if conditions improve.
                releaseTwoStepReservation(entry);
                entry.status = 'blocked';
                entry.reason = refreshedExit.reason;
                entry.nextRetryTick = Game.time + TWO_STEP_RETRY_TICKS;
                requestSave();
                continue;
            }
            if (!twoStepFinalExposureAvailable(entry.chain, exposure)) {
                entry.reason = 'final output sell exposure limit';
                continue;
            }
            if (dryRun || entry.attempts >= TWO_STEP_MAX_ATTEMPTS || acted >= TWO_STEP_MAX_EXECUTIONS_PER_RUN) continue;
            entry.attempts++;
            entry.stage2 = startTwoStepStage(entry, 2);
            if (entry.stage2) {
                entry.reservationActive = true;
                recordTwoStepHistory(mem, entry, 2, entry.stage2);
            }
            if (!entry.stage2) entry.nextRetryTick = Game.time + TWO_STEP_RETRY_TICKS;
            else { entry.status = 'stage2'; entry.nextRetryTick = 0; acted++; }
            requestSave();
        }
    }
    return acted;
    */}

function retireLegacyTwoStepQueue(e) {
  if (!e || !e.twoStepQueue || typeof e.twoStepQueue !== "object") return;
  var t = e.twoStepQueue;
  var r = Object.keys(t);
  var o = false;
  for (var n = 0; n < r.length; n++) {
    var i = t[r[n]];
    if (!i) {
      delete t[r[n]];
      o = true;
      continue;
    }
    var a = twoStepStageLive(i.stage1);
    var s = twoStepStageLive(i.stage2);
    if (!a && !s) {
      releaseTwoStepReservation(i);
      delete t[r[n]];
      o = true;
    }
  }
  if (o) requestSave();
}

function suppressTwoStepNormalOpportunities(e) {
  if (!e || !Array.isArray(e.twoStep)) return;
  var t = {};
  for (var r = 0; r < e.twoStep.length; r++) {
    var o = e.twoStep[r];
    if (!o || o.breakdown) continue;
    if (o.upstreamOpportunity) t[o.upstreamOpportunity.type + ":" + (o.upstreamOpportunity.compound || o.upstreamOpportunity.product)] = true;
    if (o.downstreamOpportunity) t[o.downstreamOpportunity.type + ":" + (o.downstreamOpportunity.compound || o.downstreamOpportunity.product)] = true;
  }
  e.forward = e.forward.filter(function(e) {
    return !t["forward:" + e.compound];
  });
  e.reverse = e.reverse.filter(function(e) {
    return !t["reverse:" + e.compound];
  });
  e.factory = e.factory.filter(function(e) {
    return !t["factory:" + e.product];
  });
}

function getSellExposureLimit(e) {
  const t = pricing.getHistDays(e);
  const r = Array.isArray(t) ? t : [];
  const o = (new Date).toISOString().slice(0, 10);
  const n = r.filter(function(e) {
    return e && typeof e.date === "string" && e.date !== o && typeof e.volume === "number" && isFinite(e.volume) && e.volume >= 0;
  }).sort(function(e, t) {
    return e.date.localeCompare(t.date);
  }).slice(-SELL_LIQUIDITY_DAYS).map(function(e) {
    return e.volume;
  });
  const i = n.length;
  n.sort(function(e, t) {
    return e - t;
  });
  const a = Math.floor(i / 2);
  const s = i === 0 ? null : i % 2 === 1 ? n[a] : (n[a - 1] + n[a]) / 2;
  const c = i < MIN_SELL_HISTORY_DAYS;
  const u = marketSales.getOurSalesTarget(e);
  const l = u != null && s != null && s > 0 ? u / s : null;
  let p;
  if (c) {
    p = MIN_SELL_EXPOSURE;
  } else {
    p = Math.max(MIN_SELL_EXPOSURE, Math.min(MAX_SELL_EXPOSURE, Math.floor(s * SELL_LIQUIDITY_SHARE)));
  }
  if (u != null && u > 0 && l != null && l >= OUR_SHARE_SOFT_MAX) {
    p = Math.max(MIN_SELL_EXPOSURE, Math.min(MAX_SELL_EXPOSURE, u));
  }
  return {
    resource: e,
    historyDays: i,
    medianDailyVolume: s,
    cap: p,
    sparseHistory: c,
    ourDailySold: u,
    ourShare: l,
    ourShareShrunkCap: u != null && l != null && l >= OUR_SHARE_SOFT_MAX && p === u
  };
}

function getSellExposureCap(e) {
  const t = getTickCache().sellExposureCaps;
  if (!Object.prototype.hasOwnProperty.call(t, e)) {
    t[e] = getSellExposureLimit(e).cap;
  }
  return t[e];
}

function getMineralRouteByRaw(e) {
  for (var t = 0; t < MINERAL_ROUTES.length; t++) {
    if (MINERAL_ROUTES[t].raw === e) return MINERAL_ROUTES[t];
  }
  return null;
}

function roomResourceAmount(e, t) {
  let r = 0;
  if (e.storage && e.storage.store) r += e.storage.store[t] || 0;
  if (e.terminal && e.terminal.store) r += e.terminal.store[t] || 0;
  const o = e.structuresByType && e.structuresByType[STRUCTURE_FACTORY] || [];
  for (var n = 0; n < o.length; n++) {
    if (o[n] && o[n].my && o[n].store) r += o[n].store[t] || 0;
  }
  return r;
}

function availableRoomResourceAmount(e, t, r) {
  if (marketSeller && typeof marketSeller.getRoomUnlistedAvailable === "function") {
    return marketSeller.getRoomUnlistedAvailable(e, r);
  }
  if (marketSeller && typeof marketSeller.getRoomTotalAvailable === "function") {
    return marketSeller.getRoomTotalAvailable(e, r);
  }
  return roomResourceAmount(t, r);
}

let reactionProductSet = null;
function getReactionProductSet() {
  if (reactionProductSet) return reactionProductSet;
  reactionProductSet = {};
  if (typeof REACTIONS === "undefined" || !REACTIONS) return reactionProductSet;
  for (var e in REACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(REACTIONS, e)) continue;
    var t = REACTIONS[e];
    for (var r in t) {
      if (Object.prototype.hasOwnProperty.call(t, r)) {
        reactionProductSet[t[r]] = true;
      }
    }
  }
  return reactionProductSet;
}

function isCommodityClassResource(e, t) {
  if (!e) return false;
  if (COMMODITY_RESIDUE_BLACKLIST[e]) return false;
  if (MINERAL_RESIDUE_EXCLUSION[e]) return false;
  if (t && e === t) return false;
  if (getReactionProductSet()[e]) return true;
  if (typeof COMMODITIES !== "undefined" && COMMODITIES[e]) return true;
  return false;
}

function shouldHoldCompoundForReverse(e, t, r, o, n, i, a) {
  if (!ENABLE_LAB_JOBS || !(r > 0) || !n || !n[t]) return false;
  if (!isEligibleForLabReaction(e)) return false;
  if (getRoomActiveLabCount(e) >= MAX_LAB_OPS_PER_ROOM) return false;
  if (firstBlockingActive(i, t)) return false;
  if (firstBlockingActive(a, t)) return false;
  const s = {
    name: e,
    labCount: getRoomLabCount(e)
  };
  const c = scoreOpportunity(analyzeReverseReaction(t, n, "PASSIVE_SELL", "PASSIVE_BUY", e), s);
  if (!c || !c.breakEven || !meetsStartProfitThreshold(c)) return false;
  const u = c.targetOutput || LAB_PROJECTED_OUTPUT;
  if (o) {
    if (sellHeadroom(o, c.reagentA) < u || sellHeadroom(o, c.reagentB) < u) return false;
  }
  return true;
}

function ownedFactory(e) {
  const t = e.structuresByType && e.structuresByType[STRUCTURE_FACTORY] || [];
  for (var r = 0; r < t.length; r++) {
    if (t[r] && t[r].my) return t[r];
  }
  return null;
}

function ownedExtractor(e) {
  const t = e.structuresByType && e.structuresByType[STRUCTURE_EXTRACTOR] || [];
  for (var r = 0; r < t.length; r++) {
    if (t[r] && t[r].my) return t[r];
  }
  return null;
}

function pruneMineralRoomState(e) {
  delete e.selling;
  if (!e.lastSellCreateTicks) e.lastSellCreateTicks = {};
  for (var t in e.lastSellCreateTicks) {
    const r = e.lastSellCreateTicks[t];
    if (typeof r !== "number" || Game.time - r >= INVENTORY_SELL_COOLDOWN) {
      delete e.lastSellCreateTicks[t];
    }
  }
}

function sellHeadroom(e, t) {
  const r = (e.listed[t] || 0) + (e.activeLab[t] || 0) + (e.activeFactory[t] || 0) + (e.prospective[t] || 0);
  return Math.max(0, getSellExposureCap(t) - r);
}

function attemptInventorySell(e, t, r, o, n, i) {
  if (!r || !(o > 0)) return false;
  if (labCommodityPolicy.isTwoLetterLabProduct(r)) {
    labCommodityRouter.enqueue(e, r, o, "inventory liquidation");
    return false;
  }
  if (!t.lastSellCreateTicks) t.lastSellCreateTicks = {};
  const a = t.lastSellCreateTicks[r] || 0;
  const s = marketSeller && typeof marketSeller.getActiveOwnedSellOrders === "function" ? marketSeller.getActiveOwnedSellOrders(e, r) : [];
  if (s.length === 0 && Game.time - a < INVENTORY_SELL_COOLDOWN) return false;
  let c = Math.floor(o);
  if (!i) c = Math.min(c, Math.floor(sellHeadroom(n, r)));
  if (!(c > 0)) return false;
  try {
    const o = marketSeller.marketSell(e, r, c);
    const i = typeof o === "string" && (o.indexOf("Created SELL order") >= 0 || o.indexOf("extended existing") >= 0);
    if (!i) {
      console.log("[autoTrader] Inventory sell refused in " + e + " for " + r + ": " + o);
      return false;
    }
    t.lastSellCreateTicks[r] = Game.time;
    addSellExposure(n, "prospective", r, c);
    console.log("[autoTrader] Inventory sell requested in " + e + ": " + c + " " + r);
    requestSave();
    return true;
  } catch (t) {
    console.log("[autoTrader] Inventory sell threw in " + e + " for " + r + ": " + t);
    return false;
  }
}

function addBuyDemand(e, t, r) {
  if (t && r > 0) e[t] = (e[t] || 0) + r;
}

function getOutstandingBuyDemand() {
  const e = {};
  const t = {};
  const r = typeof marketBuyer.getManagedOrderRecords === "function" ? marketBuyer.getManagedOrderRecords() : {};
  for (var o in r) {
    const n = r[o];
    if (!n || n.done || n.cancelled) continue;
    if (n.orderId) t[n.orderId] = true;
    const i = typeof marketBuyer.getFulfilled === "function" ? marketBuyer.getFulfilled(n) : 0;
    let a = Math.max(0, (n.target || 0) - i);
    if (n.passive) {
      const e = n.orderId && Game.market.orders[n.orderId];
      a = e ? util.getOrderRemaining(e) : Math.max(0, (n.trancheTotal || 0) - i);
    }
    addBuyDemand(e, n.resource, a);
  }
  const n = typeof marketBuyer.getPendingOrders === "function" ? marketBuyer.getPendingOrders() : [];
  for (var i = 0; i < n.length; i++) {
    if (n[i]) addBuyDemand(e, n[i].resource, n[i].target || n[i].trancheTotal || 0);
  }
  const a = Game.market.orders || {};
  for (var s in a) {
    const r = a[s];
    if (!r || r.type !== ORDER_BUY || t[s]) continue;
    addBuyDemand(e, r.resourceType, util.getOrderRemaining(r));
  }
  const c = typeof opportunisticBuy.getActiveRequestRecords === "function" ? opportunisticBuy.getActiveRequestRecords() : [];
  for (var u = 0; u < c.length; u++) {
    const t = c[u];
    if (t && !t.stopAfterPending) addBuyDemand(e, t.resourceType, t.remaining || 0);
  }
  return e;
}

function colonyAvailableAmount(e) {
  let t = 0;
  const r = getRoomState.ownedNames();
  for (var o = 0; o < r.length; o++) {
    const n = r[o];
    const i = getRoomState.get(n);
    if (!i || !i.terminal && !i.storage) continue;
    t += availableRoomResourceAmount(n, i, e);
  }
  return t;
}

function cancelSellOrdersToReclaim(e, t) {
  if (!(t > 0)) return 0;
  const r = [];
  const o = Game.market.orders || {};
  for (var n in o) {
    const t = o[n];
    if (!t || t.type !== ORDER_SELL || t.resourceType !== e || !(util.getOrderRemaining(t) > 0)) continue;
    const i = t.roomName && Game.rooms[t.roomName];
    if (!i || !i.controller || !i.controller.my) continue;
    r.push({
      id: n,
      order: t
    });
  }
  r.sort(function(e, t) {
    return t.order.price - e.order.price;
  });
  let i = 0;
  for (var a = 0; a < r.length && i < t; a++) {
    const t = r[a];
    if (Game.market.cancelOrder(t.id) !== OK) continue;
    const o = util.getOrderRemaining(t.order);
    i += o;
    if (marketSeller && typeof marketSeller.cancelGather === "function") {
      marketSeller.cancelGather(t.id);
    }
    console.log("[autoTrader] Cancelled " + e + " sell order " + t.id + " to reclaim " + o + " units for outstanding buy demand.");
  }
  if (i > 0) requestSave();
  return i;
}

function reclaimListedInventoryForDemand(e) {
  let t = false;
  for (var r = 0; r < MINERAL_ROUTES.length; r++) {
    const o = MINERAL_ROUTES[r];
    const n = e[o.raw] || 0;
    const i = e[o.bar] || 0;
    let a = colonyAvailableAmount(o.bar);
    if (i > a) {
      const e = cancelSellOrdersToReclaim(o.bar, i - a);
      a += e;
      if (e > 0) t = true;
    }
    const s = n + Math.max(0, i - a) * MINERAL_PER_BAR;
    const c = colonyAvailableAmount(o.raw);
    if (s > c) {
      const e = cancelSellOrdersToReclaim(o.raw, s - c);
      if (e > 0) t = true;
    }
  }
  return t;
}

function refiningIsProfitable(e, t) {
  const r = pricing.passiveSellPrice(t);
  const o = pricing.passiveSellPrice(e);
  const n = statusEnergyPrice();
  if (!(r > 0) || !(o > 0) || !(n > 0)) {
    return {
      profitable: false,
      detail: "missing executable raw, bar, or energy price"
    };
  }
  const i = o * MINERAL_PER_BAR + n * ENERGY_PER_BAR;
  return {
    profitable: r > i,
    detail: t + " @ " + r.toFixed(3) + " vs raw+energy cost " + i.toFixed(3)
  };
}

function allocateAcrossRooms(e, t, r, o, n, i) {
  let a = Math.max(0, r);
  const s = e.slice();
  if (n) s.sort(function(e, t) {
    return n * ((t.convertible ? 1 : 0) - (e.convertible ? 1 : 0));
  });
  for (var c = 0; c < s.length && a > 0; c++) {
    const e = s[c];
    if (i && !e.convertible) continue;
    const r = (e.rawReserved || 0) + (e.barConversionRaw || 0);
    const n = Math.max(0, availableRoomResourceAmount(e.name, e.state, t) - r);
    const u = Math.min(n, a);
    e[o] = (e[o] || 0) + u;
    a -= u;
  }
  return a;
}

function buildMineralRoutingPlans(e) {
  const t = getRoomState.ownedNames();
  const r = [];
  for (var o = 0; o < t.length; o++) {
    const e = t[o];
    if (roomSuspender.shouldAvoidRoomWork(e)) continue;
    const n = getRoomState.get(e);
    if (!n || !n.terminal) continue;
    r.push({
      name: e,
      state: n,
      factory: ownedFactory(n),
      routes: {}
    });
  }
  for (var n = 0; n < MINERAL_ROUTES.length; n++) {
    const t = MINERAL_ROUTES[n];
    let o = 0;
    let s = 0;
    for (var i = 0; i < r.length; i++) {
      o += availableRoomResourceAmount(r[i].name, r[i].state, t.raw);
      s += availableRoomResourceAmount(r[i].name, r[i].state, t.bar);
      r[i].routes[t.raw] = {
        rawReserved: 0,
        barReserved: 0,
        barConversionRaw: 0
      };
    }
    const c = e[t.raw] || 0;
    const u = e[t.bar] || 0;
    const l = Math.min(s, u);
    const p = Math.max(0, u - l) * MINERAL_PER_BAR;
    const d = c + p;
    const f = Math.min(o, d);
    const m = d > 0 ? Math.floor(f * c / d) : 0;
    const g = f - m;
    let R = l;
    for (var a = 0; a < r.length && R > 0; a++) {
      const e = availableRoomResourceAmount(r[a].name, r[a].state, t.bar);
      const o = Math.min(e, R);
      r[a].routes[t.raw].barReserved = o;
      R -= o;
    }
    const E = r.map(function(e) {
      const r = e.routes[t.raw];
      const o = e.state.minerals && e.state.minerals[0];
      return {
        name: e.name,
        state: e.state,
        factory: e.factory,
        convertible: !!(e.factory && o && o.mineralType === t.raw && o.mineralAmount === 0 && ownedExtractor(e.state)),
        get rawReserved() {
          return r.rawReserved;
        },
        set rawReserved(e) {
          r.rawReserved = e;
        },
        get barConversionRaw() {
          return r.barConversionRaw;
        },
        set barConversionRaw(e) {
          r.barConversionRaw = e;
        }
      };
    });
    allocateAcrossRooms(E, t.raw, m, "rawReserved", -1, false);
    allocateAcrossRooms(E, t.raw, g, "barConversionRaw", 1, true);
  }
  return r;
}

function findFactoryOrder(e) {
  return factoryManager && typeof factoryManager.getOrderById === "function" ? factoryManager.getOrderById(e) : null;
}

function queueOwnedMineralCompression(e, t, r, o, n, i, a, s) {
  const c = r + o;
  if (c <= 0 || !e.factory || factorySlots.countRoom(e.name) >= factorySlots.MAX_OPS_PER_ROOM) return false;
  if (typeof global.orderFactory !== "function") return false;
  const u = c * 100;
  const l = global.orderFactory(e.name, t.bar, u);
  const p = typeof l === "string" ? l.match(/\[#([^\]]+)\]/) : null;
  if (!p) {
    console.log("[autoTrader] Owned mineral compression refused in " + e.name + ": " + l);
    return false;
  }
  a.processingOrderId = p[1];
  a.routePending = false;
  if (factoryManager && typeof factoryManager.annotateOrder === "function") {
    factoryManager.annotateOrder(a.processingOrderId, {
      autoTraderMinerals: {
        demandOutput: n,
        saleOutput: i
      }
    });
  }
  addSellExposure(s, "prospective", t.bar, i);
  console.log("[autoTrader] Queued owned " + t.raw + " -> " + t.bar + " in " + e.name + ": " + n + " demand output, " + i + " sale output [" + a.processingOrderId + "]");
  if (memoryManager && typeof memoryManager.requestImmediateSave === "function") {
    memoryManager.requestImmediateSave("autoTrader.mineralFactoryOrder");
  } else {
    requestSave();
  }
  return true;
}

function processOwnedMineralRoute(e, t, r, o, n) {
  const i = availableRoomResourceAmount(e.name, e.state, t.raw);
  const a = Math.min(i, r.rawReserved || 0);
  const s = Math.min(Math.max(0, i - a), r.barConversionRaw || 0);
  const c = Math.max(0, i - a - s);
  if (!(s > 0) && !(c > 0)) {
    o.routePending = false;
    return;
  }
  const u = sellHeadroom(n, t.raw);
  const l = sellHeadroom(n, t.bar);
  const p = u <= 0 && l <= 0;
  let d = false;
  let f = "";
  if (u <= 0 && l > 0) {
    d = true;
    f = "raw sell cap full";
  } else if (l <= 0 && u > 0) {
    f = "bar sell cap full";
  } else if (p) {
    f = "both sell caps full; raw fallback";
  } else {
    const e = refiningIsProfitable(t.raw, t.bar);
    d = e.profitable;
    f = e.detail;
  }
  const m = Math.ceil(s / MINERAL_PER_BAR);
  const g = Math.floor((s + c) / 500);
  let R = Math.min(Math.floor(m / 100), g);
  const E = m - R * 100;
  const S = E > 0 ? 100 - E : 0;
  if (E > 0 && g > R && S <= l) {
    R++;
  }
  const y = R * 100;
  const h = Math.min(m, y);
  const O = Math.max(0, y - h);
  const v = Math.max(0, R * 500 - s);
  const b = Math.max(0, c - v);
  const T = Math.max(0, l - O);
  const P = d ? Math.min(Math.floor(b / 500), Math.floor(T / 100)) : 0;
  const C = O + P * 100;
  if (R + P > 0 && queueOwnedMineralCompression(e, t, R, P, h, C, o, n)) {
    console.log("[autoTrader] Owned mineral route in " + e.name + ": compress (" + f + ")");
    return;
  }
  if (c > 0 && (!d || u > 0 || p)) {
    const r = attemptInventorySell(e.name, o, t.raw, c, n, p);
    if (r) {
      o.routePending = true;
      console.log("[autoTrader] Owned mineral route in " + e.name + ": sell raw (" + f + ")");
    }
  }
}

function runOwnedMineralTrading(e) {
  const t = e.minerals;
  const r = Game.time - t.lastRunTick >= MINERAL_RUN_INTERVAL;
  const o = Game.time - t.lastDepositCheckTick >= DEPOSIT_RUN_INTERVAL;
  if (!r && !o) return;
  getRoomState.init();
  if (!r) {
    t.lastDepositCheckTick = Game.time;
    const e = {
      listed: {},
      activeLab: {},
      activeFactory: {},
      prospective: {}
    };
    buildCurrentSellAmounts(null, e);
    const r = getRoomState.ownedNames();
    for (var n = 0; n < r.length; n++) {
      const o = r[n];
      if (roomSuspender.shouldAvoidRoomWork(o)) continue;
      const i = getRoomState.get(o);
      if (!i) continue;
      if (!t.roomStates[o]) {
        t.roomStates[o] = {
          lastAmount: 0,
          processingOrderId: null,
          lastSellCreateTicks: {}
        };
      }
      attemptInventorySell(o, t.roomStates[o], RESOURCE_BIOMASS, availableRoomResourceAmount(o, i, RESOURCE_BIOMASS), e, false);
      attemptInventorySell(o, t.roomStates[o], RESOURCE_METAL, availableRoomResourceAmount(o, i, RESOURCE_METAL), e, false);
      attemptInventorySell(o, t.roomStates[o], RESOURCE_MIST, availableRoomResourceAmount(o, i, RESOURCE_MIST), e, false);
      attemptInventorySell(o, t.roomStates[o], RESOURCE_SILICON, availableRoomResourceAmount(o, i, RESOURCE_SILICON), e, false);
    }
    requestSave();
    return;
  }
  t.lastRunTick = Game.time;
  const i = t.roomStates;
  for (var a in i) {
    if (!i[a] || !getRoomState.isOwned(a)) delete i[a]; else pruneMineralRoomState(i[a]);
  }
  const s = getOutstandingBuyDemand();
  if (reclaimListedInventoryForDemand(s)) return;
  const c = buildMineralRoutingPlans(s);
  const u = {
    listed: {},
    activeLab: {},
    activeFactory: {},
    prospective: {}
  };
  buildCurrentSellAmounts(null, u);
  for (var l = 0; l < c.length; l++) {
    const e = c[l];
    const t = e.name;
    const r = e.state;
    const o = r.minerals && r.minerals[0];
    if (!i[t]) {
      i[t] = {
        lastAmount: o ? o.mineralAmount : 0,
        processingOrderId: null,
        lastSellCreateTicks: {}
      };
    }
    const n = i[t];
    pruneMineralRoomState(n);
    for (var p = 0; p < MINERAL_ROUTES.length; p++) {
      const o = MINERAL_ROUTES[p];
      const i = e.routes[o.raw];
      const a = Math.max(0, availableRoomResourceAmount(t, r, o.bar) - (i.barReserved || 0));
      if (a > 0) {
        attemptInventorySell(t, n, o.bar, a, u, false);
      }
    }
    const a = Math.max(0, availableRoomResourceAmount(t, r, RESOURCE_OPS) - OPS_RESERVE);
    if (a > 0) {
      attemptInventorySell(t, n, RESOURCE_OPS, a, u, false);
    }
    if (o && ownedExtractor(r)) {
      if (n.lastAmount > 0 && o.mineralAmount === 0) n.routePending = true;
      n.lastAmount = o.mineralAmount;
      const t = getMineralRouteByRaw(o.mineralType);
      if (o.mineralAmount === 0 && t && roomResourceAmount(r, t.raw) > 0) n.routePending = true;
      if (n.processingOrderId) {
        const e = findFactoryOrder(n.processingOrderId);
        if (!e || e.status === "done" || e.status === "cancelled") {
          n.processingOrderId = null;
          n.routePending = true;
        }
      }
      if (n.routePending && !n.processingOrderId) {
        const r = t;
        if (r) processOwnedMineralRoute(e, r, e.routes[r.raw], n, u);
      }
    }
  }
  if (Game.time - t.lastDepositCheckTick >= DEPOSIT_RUN_INTERVAL) {
    t.lastDepositCheckTick = Game.time;
    for (var d = 0; d < c.length; d++) {
      const e = c[d];
      const t = i[e.name];
      for (var f = 0; f < HIGHWAY_DEPOSITS.length; f++) {
        const r = HIGHWAY_DEPOSITS[f];
        attemptInventorySell(e.name, t, r, availableRoomResourceAmount(e.name, e.state, r), u, false);
      }
    }
  }
  requestSave();
}

//   - 300-tick per-resource per-room cooldown via state.lastSellCreateTicks
//   - sell-cap headroom enforced (no bypassCap)
function runCommodityResidueSweep(e) {
  const t = e.minerals;
  labCommodityRouter.process();
  if (typeof t.lastResidueRunTick !== "number") t.lastResidueRunTick = 0;
  if (Game.time - t.lastResidueRunTick < RESIDUE_RUN_INTERVAL) return;
  t.lastResidueRunTick = Game.time;
  getRoomState.init();
  const r = getRoomState.ownedNames();
  const o = {
    listed: {},
    activeLab: {},
    activeFactory: {},
    prospective: {}
  };
  const n = require("storageManager");
  const i = buildReactionMap();
  const a = getActiveReverseReactions();
  const s = getActiveForwardReactions();
  buildCurrentSellAmounts(null, o);
  for (let e = 0; e < r.length; e++) {
    const n = r[e];
    if (roomSuspender.shouldAvoidRoomWork(n)) continue;
    const c = Game.rooms[n];
    if (!c) continue;
    const u = getRoomState.get(n);
    if (!u || !u.terminal && !u.storage) continue;
    if (!t.roomStates[n]) {
      t.roomStates[n] = {
        lastAmount: 0,
        processingOrderId: null,
        lastSellCreateTicks: {}
      };
    }
    const l = t.roomStates[n];
    pruneMineralRoomState(l);
    const p = u.minerals && u.minerals[0] && u.minerals[0].mineralType;
    const d = [ {
      name: "terminal",
      store: c.terminal && c.terminal.store
    }, {
      name: "storage",
      store: c.storage && c.storage.store
    } ];
    for (let e = 0; e < d.length; e++) {
      const t = d[e].store;
      if (!t) continue;
      for (const e in t) {
        if (!isCommodityClassResource(e, p)) continue;
        if (labCommodityPolicy.isTwoLetterLabProduct(e)) {
          const t = availableRoomResourceAmount(n, u, e);
          if (t > 0 && Number.isFinite(t)) {
            labCommodityRouter.enqueue(n, e, t, "residue inventory");
          }
          continue;
        }
        if (pricing.liquidationPrice(e) <= 0) continue;
        const t = availableRoomResourceAmount(n, u, e);
        if (t > 0 && Number.isFinite(t)) {
          if (shouldHoldCompoundForReverse(n, e, t, o, i, a, s)) {
            console.log("[autoTrader] Residue hold in " + n + ": keeping " + e + " for profitable reverse decomposition.");
            continue;
          }
          attemptInventorySell(n, l, e, t, o, false);
        }
      }
    }
  }
  requestSave();
}

function prioritizeExistingCommodityStock(e, t, r, o, n, i) {
  const a = ensureMemory();
  const s = a.minerals;
  const c = getRoomState.ownedNames();
  for (let a = 0; a < c.length; a++) {
    const u = c[a];
    if (roomSuspender.shouldAvoidRoomWork(u)) continue;
    const l = getRoomState.get(u);
    if (!l || !l.terminal) continue;
    if (!s.roomStates[u]) {
      s.roomStates[u] = {
        lastAmount: 0,
        processingOrderId: null,
        lastSellCreateTicks: {}
      };
    }
    const p = s.roomStates[u];
    pruneMineralRoomState(p);
    const d = l.minerals && l.minerals[0] && l.minerals[0].mineralType;
    const f = {};
    const m = [ l.terminal && l.terminal.store, l.storage && l.storage.store ];
    for (let a = 0; a < m.length; a++) {
      const s = m[a];
      if (!s) continue;
      for (const a in s) {
        if (f[a] || !n[a] || !isCommodityClassResource(a, d)) continue;
        f[a] = true;
        if (labCommodityPolicy.isTwoLetterLabProduct(a)) {
          const e = availableRoomResourceAmount(u, l, a);
          if (e > 0 && Number.isFinite(e)) {
            labCommodityRouter.enqueue(u, a, e, "analysis inventory priority");
          }
          continue;
        }
        if (pricing.liquidationPrice(a) <= 0) continue;
        const s = availableRoomResourceAmount(u, l, a);
        if (!(s > 0) || !Number.isFinite(s)) continue;
        if (!i[a] && shouldHoldCompoundForReverse(u, a, s, e, t, r, o)) continue;
        attemptInventorySell(u, p, a, s, e, false);
      }
    }
  }
}

function addSellExposure(e, t, r, o) {
  if (!e || !t || !r || !(o > 0)) return;
  if (!e[t]) e[t] = {};
  e[t][r] = (e[t][r] || 0) + o;
}

function getSellCoverage(e, t) {
  let r = 0;
  let o = 0;
  let n = 0;
  let i = 0;
  try {
    const a = require("storageVfs");
    const s = a.stat("/rooms/" + e + "/terminal/" + t);
    if (s && s.ok) {
      r = s.available || 0;
      const e = (s.locks || []).filter(e => e.program !== "marketSell");
      i += e.reduce((e, t) => e + (t.amount || 0), 0);
    }
    const c = a.stat("/rooms/" + e + "/storage/" + t);
    if (c && c.ok) {
      const e = (c.locks || []).find(e => e.program === "marketSell");
      if (e) o = e.amount || 0;
      const t = (c.locks || []).filter(e => e.program !== "marketSell");
      i += t.reduce((e, t) => e + (t.amount || 0), 0);
    }
    if (Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) {
      const r = Memory.terminalManager.operations;
      for (let o = 0; o < r.length; o++) {
        const i = r[o];
        const a = i && (i.roomName || i.room);
        const s = i && (i.resourceType || i.resource);
        if (i && a === e && s === t && i.status !== "completed" && i.status !== "failed" && i.status !== "cancelled") {
          n += i.amount || 0;
        }
      }
    }
  } catch (error) {
    if (Game.time % 100 === 0) console.log("[AutoTrader] V2 storage read failed: " + ((error && error.message) || error));
  }
  return {
    roomName: e,
    resourceType: t,
    terminalAvailable: Math.max(0, r),
    storageCovered: Math.max(0, o),
    stagingPending: Math.max(0, n),
    reservedByOthers: Math.max(0, i),
    totalSellBacking: Math.max(0, r + o + n)
  };
}

function getSellOrderBackedAmount(e, t) {
  const r = getSellCoverage(e, t);
  return r.totalSellBacking;
}

function buildCurrentSellAmounts(e, t) {
  const r = {};
  const o = {};
  const n = {};
  const i = Game.market.orders;
  for (var a in i) {
    const e = i[a];
    if (e.type !== ORDER_SELL || util.getOrderRemaining(e) <= 0) continue;
    const t = e.roomName + "|" + e.resourceType;
    if (!n[t]) {
      n[t] = {
        room: e.roomName,
        resource: e.resourceType,
        remaining: 0,
        orders: []
      };
    }
    n[t].remaining += util.getOrderRemaining(e);
    n[t].orders.push({
      id: a,
      order: e
    });
  }
  for (var s in n) {
    const i = n[s];
    const a = Math.min(i.remaining, getSellOrderBackedAmount(i.room, i.resource));
    r[i.resource] = (r[i.resource] || 0) + a;
    addSellExposure(t, "listed", i.resource, a);
    o[s] = a;
    let u = a;
    for (var c = 0; c < i.orders.length; c++) {
      const t = i.orders[c];
      const r = util.getOrderRemaining(t.order);
      const o = Math.min(r, u);
      if (e && o < r) {
        e.push({
          id: t.id,
          room: i.room,
          resource: i.resource,
          amount: r - o,
          backedAmount: o
        });
      }
      u = Math.max(0, u - o);
    }
  }
  const u = typeof marketSeller.getRequests === "function" ? marketSeller.getRequests() : [];
  for (var l = 0; l < u.length; l++) {
    const e = u[l];
    if (!e) continue;
    if (!e.orderId && e.created === Game.time && e.amount > 0) {
      r[e.resourceType] = (r[e.resourceType] || 0) + e.amount;
      addSellExposure(t, "listed", e.resourceType, e.amount);
    }
    if (e.pendingExtendTick === Game.time && e.pendingExtendAmount > 0) {
      r[e.resourceType] = (r[e.resourceType] || 0) + e.pendingExtendAmount;
      addSellExposure(t, "listed", e.resourceType, e.pendingExtendAmount);
    }
  }
  const p = getLabOperations();
  for (var d = 0; d < p.length; d++) {
    const e = p[d];
    if (!e || !e.targetCompound || e.stockpile || e._finalized || e._completed || e._failed) continue;
    if (e.partialSurplusPending) {
      for (var f in e.partialSurplusPending) {
        const r = e.partialSurplusPending[f] || 0;
        addSellExposure(t, "activeLab", f, r);
      }
    }
    const r = e.direction === "forward";
    const n = getLabPlannedOutputs(e, r);
    if (r) {
      const r = getUncoveredLabOutputAmount(e, e.room, e.targetCompound, n[e.targetCompound] || 0, o);
      addSellExposure(t, "activeLab", e.targetCompound, r);
    } else if (e.reagents) {
      for (var m = 0; m < e.reagents.length; m++) {
        const r = getUncoveredLabOutputAmount(e, e.room, e.reagents[m], n[e.reagents[m]] || 0, o);
        addSellExposure(t, "activeLab", e.reagents[m], r);
      }
    }
  }
  let g = [];
  if (marketRefine && typeof marketRefine.getOperations === "function") {
    g = g.concat(marketRefine.getOperations());
  }
  if (localRefine && typeof localRefine.getOperations === "function") {
    g = g.concat(localRefine.getOperations());
  }
  for (var R = 0; R < g.length; R++) {
    const e = g[R];
    if (!e || !e.output || !isLiveRefineOp(e)) continue;
    let r = refineExpectedOutput(e);
    if (r === null && typeof e.targetOutput === "number") r = e.targetOutput;
    if (r === null && e.requiredAmount) r = recipeExpectedOutput(e.output, e.requiredAmount, e.input);
    if (r !== null) {
      const n = getUncoveredFactoryOutputAmount(e, r, o);
      addSellExposure(t, "activeFactory", e.output, n);
    }
  }
  const E = collectRefineFactoryOrderIds();
  const S = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
  for (var y = 0; y < S.length; y++) {
    const e = S[y];
    if (!e || !e.product || e.status === "done" || e.status === "cancelled") continue;
    if (e.id && E[e.id]) continue;
    const r = e.autoTraderMinerals ? Math.max(0, e.autoTraderMinerals.saleOutput || 0) : Math.max(0, (e.requested || 0) - (e.progressOut || 0));
    addSellExposure(t, "activeFactory", e.product, r);
  }
  return r;
}

function getLabPlannedOutputs(e, t) {
  if (e.expectedOutputs && typeof e.expectedOutputs === "object") return e.expectedOutputs;
  const r = {};
  const o = e.batchSize || 0;
  if (t) {
    r[e.targetCompound] = o;
  } else if (e.reagents) {
    for (var n = 0; n < e.reagents.length; n++) r[e.reagents[n]] = o;
  }
  return r;
}

function getLabJobSellAllocation(e, t) {
  if (!e || !e.jobId || !t || !(t.amount > 0)) return null;
  let r = 0;
  let o = 0;
  try {
    const n = marketEconomics.get(e.jobId);
    r = n && n.output && n.output[t.resource] ? n.output[t.resource].sold || 0 : 0;
    if (t.orderId && typeof marketEconomics.getSellLotRemaining === "function") {
      o = marketEconomics.getSellLotRemaining(t.orderId, e.jobId) || 0;
    }
  } catch (e) {}
  if (!t.orderId && r <= 0) {
    const r = typeof marketSeller.getRequests === "function" ? marketSeller.getRequests() : [];
    for (var n = 0; n < r.length; n++) {
      const i = r[n];
      if (i && !i.orderId && i.jobId === e.jobId && i.resourceType === t.resource && i.created === t.created) {
        o = i.amount || 0;
        break;
      }
    }
  }
  return Math.min(t.amount, Math.max(0, r + o));
}

function getUncoveredLabOutputAmount(e, t, r, o, n) {
  var i = o;
  if (!e || e.state !== "SELLING" || !e.sellOrderCreated || !Array.isArray(e.sellRequestInfo)) return i;
  for (var a = 0; a < e.sellRequestInfo.length; a++) {
    const o = e.sellRequestInfo[a];
    if (!o || o.resource !== r || o.unavailable) continue;
    let s = 0;
    const c = getLabJobSellAllocation(e, o);
    if (o.orderId) {
      s = c === null ? o.amount || 0 : c;
      const i = Game.market && Game.market.orders && Game.market.orders[o.orderId];
      if (i && util.getOrderRemaining(i) > 0) {
        const a = t + "|" + r;
        const u = c === null ? s : typeof marketEconomics.getSellLotRemaining === "function" ? marketEconomics.getSellLotRemaining(o.orderId, e.jobId) || 0 : 0;
        const l = Math.min(u, util.getOrderRemaining(i), n[a] || 0);
        n[a] = Math.max(0, (n[a] || 0) - l);
      }
    } else {
      const e = t + "|" + r;
      if (c !== null) {
        s = c;
      } else {
        s = Math.min(o.amount || 0, n[e] || 0);
        n[e] = Math.max(0, (n[e] || 0) - s);
      }
    }
    i -= Math.min(i, s);
    if (i <= 0) break;
  }
  return Math.max(0, i);
}

function getUncoveredFactoryOutputAmount(e, t, r) {
  if (!e) return t;
  let o = t;
  if (e.phase === "selling") {
    if (typeof e.sellAmount === "number") o = e.sellAmount; else if (typeof e.factoryProgressOut === "number" && e.factoryProgressOut > 0) o = e.factoryProgressOut; else o = producedSince(e) || t;
  }
  o = Math.min(Math.max(0, o || 0), MAX_SELL_EXPOSURE);
  if (!e.sellPosted) return o;
  const n = e.sellAmount || o;
  if (e.sellOrderId) return Math.max(0, o - n);
  const i = e.room + "|" + e.output;
  const a = Math.min(n, r[i] || 0);
  r[i] = Math.max(0, (r[i] || 0) - a);
  return Math.max(0, o - a);
}

function addActive(e, t, r) {
  if (!e[t]) e[t] = [];
  e[t].push(r);
}

function firstActive(e, t) {
  return e[t] && e[t].length > 0 ? e[t][0] : null;
}

function firstBlockingActive(e, t) {
  const r = e[t] || [];
  for (var o = 0; o < r.length; o++) {
    if (r[o].blocksProduction !== false) return r[o];
  }
  return null;
}

function firstBuyingActive(e, t) {
  const r = e[t] || [];
  for (var o = 0; o < r.length; o++) {
    if (r[o].isBuying) return r[o];
  }
  return null;
}

function isLiveRefineOp(e) {
  return !!(e && e.phase !== "done" && e.phase !== "failed" && e.phase !== "error" && e.phase !== "cancelled");
}

function hasLiveLocalRefineInRoom(e, t) {
  const r = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
  for (var o = 0; o < r.length; o++) {
    if (r[o] && r[o].room === e && r[o].output === t && isLiveRefineOp(r[o])) return true;
  }
  return false;
}

function factoryJobFlags(e) {
  return {
    isBuying: e === "buying",
    blocksProduction: e !== "selling"
  };
}

function getActiveReverseReactions() {
  const e = {};
  const t = getLabOperations("reverse");
  for (var r = 0; r < t.length; r++) {
    const o = t[r];
    if (o && o.targetCompound) addActive(e, o.targetCompound, {
      id: o.id,
      room: o.room,
      state: o.state,
      stockpile: !!o.stockpile,
      cancellationPending: !!o.cancellationPending,
      blocksProduction: o.state !== "SELLING" && o.state !== "PENDING",
      displayPhase: getLabDisplayPhase(o, o.room)
    });
  }
  return e;
}

function getActiveForwardReactions() {
  const e = {};
  const t = getLabOperations("forward");
  for (var r = 0; r < t.length; r++) {
    const o = t[r];
    if (o && o.targetCompound) addActive(e, o.targetCompound, {
      id: o.id,
      room: o.room,
      state: o.state,
      stockpile: !!o.stockpile,
      cancellationPending: !!o.cancellationPending,
      blocksProduction: o.state !== "SELLING" && o.state !== "PENDING",
      displayPhase: getLabDisplayPhase(o, o.room)
    });
  }
  return e;
}

function getBuyingReverseReactions() {
  const e = {};
  const t = getLabOperations("reverse");
  for (var r = 0; r < t.length; r++) {
    const o = t[r];
    if (o && o.targetCompound && o.state === "BUYING") addActive(e, o.targetCompound, {
      id: o.id,
      room: o.room,
      state: o.state
    });
  }
  return e;
}

function getBuyingForwardReactions() {
  const e = {};
  const t = getLabOperations("forward");
  for (var r = 0; r < t.length; r++) {
    const o = t[r];
    if (o && o.targetCompound && o.state === "BUYING") addActive(e, o.targetCompound, {
      id: o.id,
      room: o.room,
      state: o.state
    });
  }
  return e;
}

function getActiveFactoryJobs() {
  const e = {};
  const t = collectRefineFactoryOrderIds();
  const r = marketRefine && typeof marketRefine.getOperations === "function" ? marketRefine.getOperations() : [];
  for (var o = 0; o < r.length; o++) {
    const t = r[o];
    if (t && t.output && isLiveRefineOp(t)) {
      const r = factoryJobFlags(t.phase);
      addActive(e, t.output, {
        id: t.id,
        room: t.room,
        phase: t.phase,
        displayPhase: getFactoryDisplayPhase(t, "marketRefine"),
        isBuying: r.isBuying,
        blocksProduction: r.blocksProduction
      });
    }
  }
  const n = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
  for (var i = 0; i < n.length; i++) {
    const t = n[i];
    if (t && t.output && isLiveRefineOp(t)) {
      const r = t.phase || "localRefine";
      const o = factoryJobFlags(r);
      addActive(e, t.output, {
        id: t.id,
        room: t.room,
        phase: r,
        source: "localRefine",
        displayPhase: getFactoryDisplayPhase(t, "localRefine"),
        isBuying: o.isBuying,
        blocksProduction: o.blocksProduction
      });
    }
  }
  const a = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
  for (var s = 0; s < a.length; s++) {
    const r = a[s];
    if (r && r.product && r.status !== "done" && r.status !== "cancelled" && !(r.id && t[r.id])) {
      const t = factoryJobFlags("factoryOrder");
      addActive(e, r.product, {
        id: r.id,
        room: r.room,
        phase: "factoryOrder",
        source: "factoryOrder",
        displayPhase: getFactoryDisplayPhase(r, "factoryOrder"),
        isBuying: t.isBuying,
        blocksProduction: t.blocksProduction
      });
    }
  }
  return e;
}

function getStatusSnapshot() {
  const e = {
    lab: {
      reverse: 0,
      forward: 0,
      buying: 0,
      waiting: 0,
      processing: 0
    },
    factory: {
      compression: 0,
      decompression: 0,
      buying: 0,
      queued: 0,
      processing: 0
    },
    opportunistic: 0
  };
  const t = typeof marketLab.getOperations === "function" ? marketLab.getOperations() : [];
  for (let r = 0; r < t.length; r++) {
    const o = t[r];
    if (!o || o.state === "SELLING") continue;
    if (o.direction === "reverse") e.lab.reverse++; else if (o.direction === "forward") e.lab.forward++;
    if (o.state === "BUYING") e.lab.buying++; else if (o.state === "WAITING") e.lab.waiting++; else if (o.state === "PROCESSING") e.lab.processing++;
  }
  const r = getActiveFactoryJobs();
  for (const t in r) {
    const o = r[t];
    for (let r = 0; r < o.length; r++) {
      const n = o[r];
      if (!n || n.displayPhase === "SELLING") continue;
      if (DECOMPRESSION_PRODUCTS.indexOf(t) >= 0) e.factory.decompression++; else e.factory.compression++;
      if (n.isBuying) e.factory.buying++; else if (n.displayPhase === "PROCESSING") e.factory.processing++; else e.factory.queued++;
    }
  }
  const o = {
    lab: {
      queued: 0,
      pending: 0
    }
  };
  const n = marketBatchBuy && typeof marketBatchBuy.getOpenJobs === "function" ? marketBatchBuy.getOpenJobs() : [];
  for (let e = 0; e < n.length; e++) {
    const t = n[e];
    if (!t || t.queue !== "lab") continue;
    if (t.state === marketBatchBuy.STATE_PENDING) o.lab.pending++; else o.lab.queued++;
  }
  const i = {
    lab: 0
  };
  const addProcurement = function(e) {
    if (e === "lab") i.lab++;
  };
  const a = opportunisticBuy && typeof opportunisticBuy.getActiveRequestRecords === "function" ? opportunisticBuy.getActiveRequestRecords() : [];
  for (let t = 0; t < a.length; t++) {
    const r = a[t];
    if (!r) continue;
    const o = r.pending && typeof r.pending.expected === "number";
    if (r.remaining > 0) e.opportunistic++;
    if (r.remaining > 0 || o) addProcurement(r.queue || "default");
  }
  const s = marketBuyer && typeof marketBuyer.getManagedOrderRecords === "function" ? marketBuyer.getManagedOrderRecords() : {};
  for (const e in s) {
    const t = s[e];
    if (t && !t.done && !t.cancelled && !t.cancelRequested) {
      addProcurement(t.queue || "default");
    }
  }
  const c = marketBuyer && typeof marketBuyer.getPendingOrders === "function" ? marketBuyer.getPendingOrders() : [];
  for (let e = 0; e < c.length; e++) {
    const t = c[e];
    if (t && !t.cancelRequested) addProcurement(t.queue || "default");
  }
  for (let e = 0; e < n.length; e++) {
    const t = n[e];
    if (t) addProcurement(t.queue || "default");
  }
  e.lab.buying += i.lab + o.lab.queued;
  e.lab.processing += o.lab.pending;
  return e;
}

function recordLabOutcome(e, t, r, o, n) {
  if (!r) return;
  const i = Memory && Memory.autoTrader;
  if (!i || !Array.isArray(i.jobsStarted)) return;
  const a = e === "forward" ? [ "forward", "full_synthesis" ] : [ "reverse", "full_decompose" ];
  const s = r.tickStarted || r.sellingStartTick || 0;
  let c = -1;
  let u = -1;
  for (let e = i.jobsStarted.length - 1; e >= 0; e--) {
    const o = i.jobsStarted[e];
    if (!o) continue;
    if (a.indexOf(o.type) < 0) continue;
    if (o.room !== t) continue;
    if (o.compound !== r.targetCompound) continue;
    if (o.status) continue;
    if (typeof o.tick !== "number") continue;
    let n = o.tick <= s ? 1e3 : 0;
    n += e;
    if (n > u) {
      u = n;
      c = e;
    }
  }
  if (c < 0) return;
  const l = i.jobsStarted[c];
  l.status = o;
  l.finishedTick = Game.time;
  if (n) l.reason = String(n).slice(0, 200);
  if (r.id) l.marketOpId = r.id;
}

function labOperationConsumesSlot(e) {
  return !!(e && (e.stockpile || e.state !== "SELLING"));
}

function getRoomLabOperationCount(e, t, r) {
  let o = 0;
  for (var n = 0; n < e.length; n++) {
    if (e[n] && e[n].room === t && r(e[n])) o++;
  }
  return o;
}

function getRoomActiveLabReverseCount(e) {
  return getRoomLabOperationCount(getLabOperations("reverse"), e, labOperationConsumesSlot);
}

function getRoomActiveLabForwardCount(e) {
  return getRoomLabOperationCount(getLabOperations("forward"), e, labOperationConsumesSlot);
}

function getRoomActiveLabCount(e) {
  return getRoomActiveLabReverseCount(e) + getRoomActiveLabForwardCount(e);
}

function getRoomSellingLabCount(e) {
  function isSelling(e) {
    return !!(e && e.state === "SELLING");
  }
  return getRoomLabOperationCount(getLabOperations("reverse"), e, isSelling) + getRoomLabOperationCount(getLabOperations("forward"), e, isSelling);
}

function getRoomLabJob(e, t, r) {
  const o = getLabOperationsForRoom(e);
  const queue = getLabQueueState(e);
  if (queue && queue.slotsFree > 0) return null;
  for (var n = 0; n < o.length; n++) {
    const e = o[n];
    if (e.direction !== t) continue;
    if (e && e.targetCompound === r && e.state !== "SELLING" && e.state !== "PENDING") return e;
  }
  return null;
}

function getLabQueueState(e) {
  try {
    return marketLab && typeof marketLab.getRoomQueueState === "function" ? marketLab.getRoomQueueState(e) : null;
  } catch (t) {
    return null;
  }
}

function findCompatibleLabRoomIndex(e, t, r, o) {
  for (var n = 0; n < e.length; n++) {
    if (!batchPurchasesCanUseRoom(o, e[n].name)) continue;
    var i = getLabQueueState(e[n].name);
    if (i && i.slotsFree <= 0) continue;
    if (!getRoomLabJob(e[n].name, t, r)) return n;
  }
  return -1;
}

function findStaleReplacementAssignment(e, t, r, o, n) {
  let i = null;
  for (var a = 0; a < e.length; a++) {
    const s = e[a];
    const c = s.roomName;
    if (t[c] || roomSuspender.shouldAvoidRoomWork(c)) continue;
    if (!batchPurchasesCanUseRoom(n, c)) continue;
    if (!isEligibleForLabReaction(c)) continue;
    if (getRoomActiveLabCount(c) < MAX_LAB_OPS_PER_ROOM) continue;
    if (getRoomLabJob(c, r, o)) continue;
    const u = {
      name: c,
      labCount: getRoomLabCount(c),
      activeLabOps: getRoomActiveLabCount(c),
      labManagerBusy: labManager && typeof labManager.roomHasPendingOrder === "function" ? labManager.roomHasPendingOrder(c) : false,
      excludeOpId: s.opId
    };
    if (!i || s.age > i.replacement.age || s.age === i.replacement.age && c < i.room.name) {
      i = {
        room: u,
        replacement: s
      };
    }
  }
  return i;
}

function getRoomActiveFactoryCount(e) {
  return factorySlots.countRoom(e);
}

function isFactoryProductOnCooldown(e) {
  const t = ensureMemory();
  if (t.factoryCooldowns && t.factoryCooldowns[e]) {
    return Game.time - t.factoryCooldowns[e] < FACTORY_JOB_COOLDOWN;
  }
  if (!t.jobsStarted) return false;
  for (var r = t.jobsStarted.length - 1; r >= 0; r--) {
    const o = t.jobsStarted[r];
    if (o.type === "factory" && o.product === e) return Game.time - o.tick < FACTORY_JOB_COOLDOWN;
  }
  return false;
}

function roomHasSupplier(e) {
  const t = getTickCache();
  if (!t.supplierRooms) {
    t.supplierRooms = {};
    const e = getRoomState.creepIndex();
    const o = e && e.all ? e.all : [];
    for (var r = 0; r < o.length; r++) {
      const e = o[r];
      if (e.memory.role === "supplier") t.supplierRooms[e.room.name] = true;
    }
  }
  return !!t.supplierRooms[e];
}

function getRoomLabCount(e) {
  const t = getRoomState.get(e);
  if (!t || !t.structuresByType || !t.structuresByType[STRUCTURE_LAB]) return 0;
  return t.structuresByType[STRUCTURE_LAB].length;
}

function isEligibleForLabReaction(e) {
  const t = getRoomState.get(e);
  if (!t || !t.controller || !t.controller.my || !t.terminal) return false;
  if (getRoomLabCount(e) < MIN_LABS) return false;
  if (!roomHasSupplier(e)) return false;
  if (getRoomStorageEnergy(e) < MIN_LAB_STORAGE_ENERGY) return false;
  return true;
}

const isEligibleForReverseReaction = isEligibleForLabReaction;
function isEligibleForFactoryBasic(e, t) {
  const r = getRoomState.get(e);
  if (!r || !r.controller || !r.controller.my || !r.terminal) return false;
  if (!r.structuresByType || !r.structuresByType[STRUCTURE_FACTORY] || r.structuresByType[STRUCTURE_FACTORY].length === 0) return false;
  if (!r.storage) return false;
  const o = r.storage.store ? r.storage.store[RESOURCE_ENERGY] || 0 : 0;
  if (o < MIN_STORAGE_ENERGY) return false;
  if (!r.sources || r.sources.length < REQUIRED_SOURCES) return false;
  const n = t ? t[e] || 0 : getRoomActiveFactoryCount(e);
  if (n >= MAX_FACTORY_OPS_PER_ROOM) return false;
  return true;
}

function isEligibleForFactory(e, t, r) {
  if (!isEligibleForFactoryBasic(e, r)) return false;
  if (!t) return true;
  if (LOCAL_REFINE_PRODUCTS.indexOf(t) >= 0) {
    if (hasLiveLocalRefineInRoom(e, t)) return false;
    if (getRoomStorageEnergy(e) < LOCAL_REFINE_ENERGY_RESERVE + 1e3) return false;
  }
  return canRoomProduceProduct(e, t);
}

function getEligibleLabReactionRooms() {
  const e = [];
  const t = getRoomState.ownedNames();
  for (var r = 0; r < t.length; r++) {
    const o = t[r];
    if (roomSuspender.shouldAvoidRoomWork(o)) continue;
    if (!isEligibleForLabReaction(o)) continue;
    if (getRoomActiveLabCount(o) >= MAX_LAB_OPS_PER_ROOM) continue;
    const n = labManager && typeof labManager.roomHasPendingOrder === "function" ? labManager.roomHasPendingOrder(o) : false;
    e.push({
      name: o,
      labCount: getRoomLabCount(o),
      activeLabOps: getRoomActiveLabCount(o),
      labManagerBusy: n
    });
  }
  e.sort(function(e, t) {
    if (e.activeLabOps !== t.activeLabOps) return e.activeLabOps - t.activeLabOps;
    if (e.labManagerBusy !== t.labManagerBusy) return e.labManagerBusy ? 1 : -1;
    if (e.labCount !== t.labCount) return t.labCount - e.labCount;
    return e.name < t.name ? -1 : e.name > t.name ? 1 : 0;
  });
  return e;
}

function logLabSchedulerLoads() {
  const e = {};
  let t = 0;
  let r = false;
  const o = getRoomState.ownedNames();
  for (var n = 0; n < o.length; n++) {
    const i = o[n];
    if (roomSuspender.shouldAvoidRoomWork(i) || !isEligibleForLabReaction(i)) continue;
    const a = getRoomActiveLabCount(i);
    const s = labManager && typeof labManager.roomHasPendingOrder === "function" ? labManager.roomHasPendingOrder(i) : false;
    const c = getRoomSellingLabCount(i);
    if (!e[a]) e[a] = [];
    e[a].push(i + (s ? "*" : ""));
    t += c;
    r = r || s;
  }
  const i = Object.keys(e).sort(function(e, t) {
    return Number(e) - Number(t);
  }).map(function(t) {
    e[t].sort();
    return t + "/" + MAX_LAB_OPS_PER_ROOM + " " + e[t].join(",");
  });
  console.log("[AutoTrader] Labs: " + (i.length > 0 ? i.join(" | ") + " | sell " + t + (r ? " (*busy)" : "") : "none eligible"));
}

const getEligibleReverseReactionRooms = getEligibleLabReactionRooms;
function getRoomStorageEnergy(e) {
  const t = getRoomState.get(e);
  if (!t || !t.storage || !t.storage.store) return 0;
  return t.storage.store[RESOURCE_ENERGY] || 0;
}

function getEligibleFactoryRooms(e, t) {
  const r = [];
  const o = getRoomState.ownedNames();
  for (var n = 0; n < o.length; n++) {
    const i = o[n];
    if (roomSuspender.shouldAvoidRoomWork(i)) continue;
    if (isEligibleForFactory(i, e, t)) {
      r.push({
        name: i,
        orderCount: t ? t[i] || 0 : getRoomActiveFactoryCount(i),
        storageEnergy: getRoomStorageEnergy(i),
        factoryLevel: getRoomFactoryLevel(i)
      });
    }
  }
  r.sort(function(e, t) {
    if (e.orderCount !== t.orderCount) return e.orderCount - t.orderCount;
    return t.storageEnergy - e.storageEnergy;
  });
  return r;
}

function getFactoryLevelSummary() {
  const e = {
    0: 0,
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0
  };
  const t = getRoomState.ownedNames();
  for (var r = 0; r < t.length; r++) {
    const o = t[r];
    if (roomSuspender.shouldAvoidRoomWork(o)) continue;
    const n = getRoomFactoryLevel(o);
    if (n !== null && isEligibleForFactoryBasic(o)) e[n] = (e[n] || 0) + 1;
  }
  return e;
}

function pctOf(e, t) {
  if (typeof e !== "number" || typeof t !== "number" || t <= 0) return null;
  return Math.max(0, Math.min(100, e / t * 100));
}

function terminalCount(e, t) {
  const r = getRoomState.get(e);
  if (!r || !r.terminal || !r.terminal.store) return 0;
  const o = r.terminal.store;
  return typeof o.getUsedCapacity === "function" ? o.getUsedCapacity(t) || 0 : o[t] || 0;
}

function labCount(e, t) {
  const r = getRoomState.get(e);
  const o = r && r.structuresByType && r.structuresByType[STRUCTURE_LAB];
  if (!o) return 0;
  let n = 0;
  for (var i = 0; i < o.length; i++) {
    const e = o[i] && o[i].store;
    if (e) n += e[t] || 0;
  }
  return n;
}

function labProcessingCount(e, t, r) {
  const o = getLabOrderForMarketOp(t, e);
  const n = e && e.direction === "forward" ? e.targetCompound : null;
  const i = e && e.direction === "reverse" ? e.targetCompound : null;
  if (o && (n && o.product === n || i && o.compound === i)) {
    const t = typeof o.amount === "number" ? o.amount : e.batchSize;
    const r = typeof o.remaining === "number" ? o.remaining : t;
    return Math.max(0, t - r);
  }
  return terminalCount(t, r) + labCount(t, r);
}

function roomWideCount(e, t) {
  const r = getRoomState.get(e);
  if (!r) return 0;
  let o = 0;
  function add(e) {
    if (e && e.store && e.store[t]) o += e.store[t];
  }
  add(r.storage);
  add(r.terminal);
  const n = r.structuresByType || {};
  const i = n[STRUCTURE_FACTORY] || [];
  if (i.length > 0) add(i[0]);
  return o;
}

function isMarketBuyOrderLive(e, t, r, o) {
  let n = global.marketBuy;
  if (!n) {
    try {
      n = require("marketBuy");
    } catch (e) {
      n = null;
    }
  }
  if (!n || typeof n.getOrderRecordFor !== "function") return true;
  try {
    const i = n.getOrderRecordFor(e, t, r, o);
    if (!i) return false;
    if (i.done || i.cancelled) return false;
    if (!i.orderId) return false;
    return !!Game.market.orders[i.orderId];
  } catch (e) {
    return true;
  }
}

function refineInputAcquired(e, t) {
  let r = roomWideCount(e.room, t.resource);
  if (t.useMarketBuy) {
    const o = require("storageManager");
    const n = o.storageFind(e.room, t.resource);
    if (n && n.combined && typeof n.combined.available === "number") r = Math.max(0, n.combined.available);
  }
  const o = t.useMarketBuy && typeof t.baseAvailable === "number" ? t.baseAvailable : typeof t.baseCount === "number" ? t.baseCount : 0;
  const n = r - o;
  return n > 0 ? n : 0;
}

function recipeExpectedOutput(e, t, r) {
  const o = COMMODITIES && COMMODITIES[e];
  if (!o) return null;
  const n = o.components || {};
  const i = n[r];
  if (!i || i <= 0) return null;
  const a = typeof o.amount === "number" && o.amount > 0 ? o.amount : 1;
  return t / i * a;
}

function refineExpectedOutput(e) {
  const t = COMMODITIES && COMMODITIES[e.output];
  if (!t || !e.inputs) return null;
  const r = t.components || {};
  const o = typeof t.amount === "number" && t.amount > 0 ? t.amount : 1;
  let n = null;
  for (var i = 0; i < e.inputs.length; i++) {
    const t = r[e.inputs[i].resource];
    if (!t || t <= 0) continue;
    const a = e.inputs[i].amount / t * o;
    if (n === null || a < n) n = a;
  }
  return n;
}

function producedSince(e) {
  const t = e.outputBaseAtFactoryStart !== null && e.outputBaseAtFactoryStart !== undefined ? e.outputBaseAtFactoryStart : e.baseOutputCount;
  const r = roomWideCount(e.room, e.output) - (t || 0);
  return r > 0 ? r : 0;
}

function fmtBought(e, t, r, o) {
  const n = typeof r === "number" && r > 0 ? e + ": " + t + "/" + r + (pctOf(t, r) !== null ? " (" + pctOf(t, r).toFixed(0) + "%)" : "") : e + ": " + t;
  return n + (o || "");
}

function fmtProduced(e, t, r) {
  if (typeof r === "number" && r > 0) {
    const o = pctOf(t, r);
    return e + ": " + (o !== null ? o.toFixed(0) + "%" : "?") + " produced (" + t + "/" + Math.round(r) + ")";
  }
  return e + ": " + t + " produced";
}

function orderFillPct(e) {
  const t = getOrderProgress(e);
  if (!t || t.original <= 0) return null;
  return Math.max(0, Math.min(100, t.filled / t.original * 100));
}

function getOrderProgress(e) {
  if (!e) return null;
  let t = util.getOrderRemaining(e);
  let r = typeof e.amount === "number" ? e.amount : 0;
  let o = typeof e.totalAmount === "number" ? e.totalAmount : 0;
  if (t < 0) t = 0;
  if (r < 0) r = 0;
  if (o < 0) o = 0;
  const n = Math.max(o, r, t);
  const i = Math.max(0, n - t);
  return {
    original: n,
    remaining: t,
    filled: i
  };
}

function fmtPct(e) {
  return e === null ? "?" : e.toFixed(1) + "%";
}

function findFactoryOrderById(e) {
  return factoryManager && typeof factoryManager.getOrderById === "function" ? factoryManager.getOrderById(e) : null;
}

function isLiveFactoryOrder(e) {
  return factoryManager && typeof factoryManager.isLiveOrder === "function" ? factoryManager.isLiveOrder(e) : !!(e && e.status !== "done" && e.status !== "cancelled");
}

function hasFactoryOrderAfter(e) {
  return !!(factoryManager && typeof factoryManager.hasOrderAfter === "function" && e && factoryManager.hasOrderAfter(e.room, e.output, e.factoryCreated || e.started));
}

function getFactoryOrderDisplayPhase(e) {
  if (!e) return "PROCESSING";
  if (e.phase === "processing") return "PROCESSING";
  if (e.phase === "unloading" || e.phase === "unloadingPending") return "DELIVERING";
  return "STAGING";
}

function getLabOrderForMarketOp(e, t) {
  if (!labManager || typeof labManager.getMarketOperationOrder !== "function") return null;
  return labManager.getMarketOperationOrder(e, t && t.id);
}

function getLabDisplayPhase(e, t) {
  if (!e || !e.state) return "STAGING";
  if (e.cancellationPending) return "CANCELLING";
  if (e.state === "PENDING") return "PENDING";
  if (e.state === "BUYING") return "BUYING";
  if (e.state === "WAITING") return "STAGING";
  if (e.state === "STAGING") return "DELIVERING";
  if (e.state === "SELLING") return "SELLING";
  if (e.state === "PROCESSING") {
    if (!e.reactionStarted) return "STAGING";
    const r = getLabOrderForMarketOp(t, e);
    if (r) {
      if (r.evacuating) return "DELIVERING";
      if (r.needsPreEvacuation) return "STAGING";
    }
    return "PROCESSING";
  }
  return e.state;
}

function isLabManagerOrderProcessing(e, t) {
  if (!e || e.type === "cleanup" || e.broken || e.evacuating || e.needsPreEvacuation) return false;
  const r = typeof e.remaining === "number" ? e.remaining : e.amount || 0;
  if (e.type !== "breakdown") return r > 0;
  return r <= 0 || labCount(t, e.compound) > 0;
}

function getFactoryDisplayPhase(e, t) {
  if (!e) return "STAGING";
  if (t === "marketRefine") {
    if (e.phase === "buying") return "BUYING";
    if (e.phase === "selling") return "SELLING";
    if (e.phase === "refining") {
      const t = findFactoryOrderById(e.factoryOrderId);
      if (!e.factoryStarted) return "STAGING";
      if (e.factoryOrderId ? !isLiveFactoryOrder(t) : !hasFactoryOrderAfter(e)) return "RECONCILING";
      return getFactoryOrderDisplayPhase(t);
    }
    return String(e.phase || "STAGING").toUpperCase();
  }
  if (t === "localRefine") {
    if (e.phase === "selling") return "SELLING";
    if (e.phase === "refining") {
      const t = findFactoryOrderById(e.factoryOrderId);
      if (!e.factoryStarted) return "STAGING";
      if (e.factoryOrderId ? !isLiveFactoryOrder(t) : !hasFactoryOrderAfter(e)) return "RECONCILING";
      return getFactoryOrderDisplayPhase(t);
    }
    return String(e.phase || "STAGING").toUpperCase();
  }
  const r = e.phase || "loading";
  if (e.status === "queued" || r === "loading") return "STAGING";
  if (r === "processing") return "PROCESSING";
  if (r === "unloading") return "DELIVERING";
  return String(r).toUpperCase();
}

function fmtExpectedOutputs(e, t) {
  const r = e && e.expectedOutputs;
  if (!r) return "";
  const o = [];
  for (var n in r) {
    if (!r.hasOwnProperty(n)) continue;
    o.push(fmtBought(n, terminalCount(t, n), r[n]));
  }
  return o.join(", ");
}

function collectRefineFactoryOrderIds() {
  const e = {};
  const t = marketRefine && typeof marketRefine.getOperations === "function" ? marketRefine.getOperations() : [];
  for (var r = 0; r < t.length; r++) {
    const o = t[r];
    if (o && o.factoryOrderId) e[o.factoryOrderId] = true;
  }
  const o = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
  for (var n = 0; n < o.length; n++) {
    const t = o[n];
    if (t && t.factoryOrderId) e[t.factoryOrderId] = true;
  }
  return e;
}

function getActiveReport() {
  const e = [ "[autoTrader] Active Jobs (tick " + Game.time + "):", "" ];
  let t = false;
  const r = getLabOperations();
  for (var o = 0; o < r.length; o++) {
    const a = r[o];
    if (!a || !a.targetCompound) continue;
    const s = a.room;
    const c = a.direction === "forward";
    t = true;
    const u = a.reagents ? a.reagents.join("+") : "?";
    const l = c ? u + "->" + a.targetCompound : a.targetCompound + "->" + u;
    const p = getLabDisplayPhase(a, s);
    e.push((c ? "forward " : "reverse ") + a.targetCompound + " in " + s + " [" + p + "] (" + l + ")");
    if (a.state === "BUYING") {
      const t = [];
      const r = a.batchMode ? "batchBuy" : a.useMarketBuy ? "marketBuy" : "opportunisticBuy";
      const o = " (" + r + ")";
      if (c && a.reagents) {
        for (var n = 0; n < a.reagents.length; n++) t.push(fmtBought(a.reagents[n], terminalCount(s, a.reagents[n]), a.batchSize, o));
      } else {
        t.push(fmtBought(a.targetCompound, terminalCount(s, a.targetCompound), a.batchSize, o));
      }
      e.push("    buying     " + t.join(", "));
    } else if (p === "STAGING") {
      e.push("    staging    inputs acquired, " + (a.state === "WAITING" ? "labs busy" : "preparing lab order"));
    } else if (p === "PROCESSING") {
      const t = [];
      if (c) {
        t.push(fmtProduced(a.targetCompound, labProcessingCount(a, s, a.targetCompound), a.batchSize));
      } else if (a.reagents) {
        for (var i = 0; i < a.reagents.length; i++) t.push(fmtProduced(a.reagents[i], labProcessingCount(a, s, a.reagents[i]), a.batchSize));
      }
      e.push("    producing  " + t.join(", "));
    } else if (p === "DELIVERING") {
      const t = fmtExpectedOutputs(a, s);
      e.push("    delivering " + (t || "outputs to terminal"));
    } else if (p === "SELLING") {
      const t = fmtExpectedOutputs(a, s);
      e.push("    selling    " + (a.sellOrderCreated ? "sell orders active" : "preparing sell orders") + (t ? " | terminal: " + t : ""));
    }
  }
  const a = marketRefine && typeof marketRefine.getOperations === "function" ? marketRefine.getOperations() : [];
  for (var s = 0; s < a.length; s++) {
    const r = a[s];
    if (!r || !r.output) continue;
    if (r.phase === "done" || r.phase === "failed" || r.phase === "error") continue;
    t = true;
    const o = DECOMPRESSION_PRODUCTS.indexOf(r.output) >= 0 ? " [decomp]" : "";
    const n = getFactoryDisplayPhase(r, "marketRefine");
    e.push("factory " + r.output + o + " in " + r.room + " [" + n + "]");
    if (r.phase === "buying") {
      const t = [];
      if (r.inputs && r.inputs.length) {
        for (var c = 0; c < r.inputs.length; c++) {
          const e = r.inputs[c];
          let o = e.useMarketSell ? " (marketSell)" : e.useMarketBuy ? " (marketBuy)" : " (roomStock)";
          if (e.useMarketBuy && !isMarketBuyOrderLive(r.room, e.resource, "factory", r.id)) {
            o += " [order missing/cancelled]";
          }
          t.push(fmtBought(e.resource, refineInputAcquired(r, e), e.amount, o));
        }
      }
      e.push("    buying     " + (t.length ? t.join(", ") : "(no inputs)"));
    } else if (n === "STAGING") {
      e.push("    staging    inputs acquired, preparing factory order");
    } else if (n === "DELIVERING") {
      e.push("    delivering " + fmtProduced(r.output, producedSince(r), refineExpectedOutput(r)));
    } else if (n === "RECONCILING") {
      e.push("    reconciling factory order state");
    } else if (n === "SELLING") {
      e.push("    selling    " + fmtProduced(r.output, producedSince(r), refineExpectedOutput(r)));
    } else {
      e.push("    producing  " + fmtProduced(r.output, producedSince(r), refineExpectedOutput(r)));
    }
  }
  const u = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
  for (var l = 0; l < u.length; l++) {
    const r = u[l];
    if (!r || !r.output) continue;
    if (r.phase === "done" || r.phase === "failed" || r.phase === "error") continue;
    t = true;
    const o = getFactoryDisplayPhase(r, "localRefine");
    e.push("factory " + r.output + " [local] in " + r.room + " [" + o + "]");
    if (o === "STAGING") {
      e.push("    staging    inputs on hand, preparing factory order");
    } else if (o === "DELIVERING") {
      e.push("    delivering " + fmtProduced(r.output, producedSince(r), recipeExpectedOutput(r.output, r.requiredAmount, r.input)));
    } else if (o === "RECONCILING") {
      e.push("    reconciling factory order state");
    } else if (o === "SELLING") {
      e.push("    selling    " + fmtProduced(r.output, producedSince(r), recipeExpectedOutput(r.output, r.requiredAmount, r.input)));
    } else {
      e.push("    producing  " + fmtProduced(r.output, producedSince(r), recipeExpectedOutput(r.output, r.requiredAmount, r.input)));
    }
  }
  const p = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
  if (p.length > 0) {
    const r = collectRefineFactoryOrderIds();
    for (var d = 0; d < p.length; d++) {
      const o = p[d];
      if (!o || !o.product) continue;
      if (o.status === "done" || o.status === "cancelled") continue;
      if (o.id && r[o.id]) continue;
      t = true;
      const n = getFactoryDisplayPhase(o, "factoryOrder");
      e.push("factory " + o.product + " [order] in " + o.room + " [" + n + "]");
      const i = typeof o.requested === "number" ? o.requested : null;
      if (n === "STAGING") {
        e.push("    staging    loading inputs | produced " + (o.progressOut || 0) + (i !== null ? "/" + i : ""));
      } else if (n === "PROCESSING") {
        e.push("    producing  " + fmtProduced(o.product, o.progressOut || 0, i));
      } else if (n === "DELIVERING") {
        e.push("    delivering " + fmtProduced(o.product, o.progressOut || 0, i));
      } else {
        e.push("    status     phase=" + (o.phase || "unknown") + ", status=" + (o.status || "unknown"));
      }
    }
  }
  if (!t) e.push("  No active jobs.");
  return e.join("\n");
}

function getProcessingProductionReport() {
  getRoomState.init();
  const e = [];
  const t = {};
  const r = getLabOperations();
  for (var o = 0; o < r.length; o++) {
    const n = r[o];
    if (!n || !n.targetCompound || getLabDisplayPhase(n, n.room) !== "PROCESSING") continue;
    const i = n.direction === "forward";
    const a = n.reagents ? n.reagents.join("+") : "?";
    const s = i ? a + "->" + n.targetCompound : n.targetCompound + "->" + a;
    e.push("  " + (i ? "forward " : "reverse ") + n.targetCompound + " in " + n.room + " [PROCESSING] (" + s + ")");
    if (n.id) t[n.id] = true;
  }
  const n = getRoomState.ownedNames();
  for (var i = 0; i < n.length; i++) {
    const r = n[i];
    const o = labManager && typeof labManager.getActiveOrder === "function" ? labManager.getActiveOrder(r) : null;
    if (!isLabManagerOrderProcessing(o, r)) continue;
    if (o.marketOpId && t[o.marketOpId]) continue;
    const a = o.type === "breakdown";
    const s = a ? o.compound : o.product;
    const c = o.reag1 && o.reag2 ? o.reag1 + "+" + o.reag2 : "?";
    const u = a ? s + "->" + c : c + "->" + s;
    e.push("  " + (a ? "reverse " : "forward ") + s + " in " + r + " [PROCESSING] (" + u + ")");
  }
  const a = [];
  const s = marketRefine && typeof marketRefine.getOperations === "function" ? marketRefine.getOperations() : [];
  for (var c = 0; c < s.length; c++) {
    const e = s[c];
    if (!e || !e.output || getFactoryDisplayPhase(e, "marketRefine") !== "PROCESSING") continue;
    const t = DECOMPRESSION_PRODUCTS.indexOf(e.output) >= 0 ? " [decomp]" : "";
    a.push("  factory " + e.output + t + " in " + e.room + " [PROCESSING] | " + fmtProduced(e.output, producedSince(e), refineExpectedOutput(e)));
  }
  const u = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
  for (var l = 0; l < u.length; l++) {
    const e = u[l];
    if (!e || !e.output || getFactoryDisplayPhase(e, "localRefine") !== "PROCESSING") continue;
    a.push("  factory " + e.output + " [local] in " + e.room + " [PROCESSING] | " + fmtProduced(e.output, producedSince(e), recipeExpectedOutput(e.output, e.requiredAmount, e.input)));
  }
  const p = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
  const d = collectRefineFactoryOrderIds();
  for (var f = 0; f < p.length; f++) {
    const e = p[f];
    if (!e || !e.product || e.status === "done" || e.status === "cancelled" || e.id && d[e.id] || getFactoryDisplayPhase(e, "factoryOrder") !== "PROCESSING") continue;
    const t = typeof e.requested === "number" ? e.requested : null;
    a.push("  factory " + e.product + " [order] in " + e.room + " [PROCESSING] | " + fmtProduced(e.product, e.progressOut || 0, t));
  }
  if (e.length === 0 && a.length === 0) {
    return "[Production] No factories or labs currently processing.";
  }
  const m = [ "[Production] Currently processing (tick " + Game.time + "):" ];
  if (e.length > 0) {
    m.push("", "Labs:");
    for (var g = 0; g < e.length; g++) m.push(e[g]);
  }
  if (a.length > 0) {
    m.push("", "Factories:");
    for (var R = 0; R < a.length; R++) m.push(a[R]);
  }
  return m.join("\n");
}

function getRoomStatusDetail(e, t, r, o) {
  const n = getRoomState.get(e);
  const i = {
    name: e,
    factory: null,
    lab: null
  };
  const a = getRoomFactoryLevel(e);
  if (a !== null) {
    const t = getRoomStorageEnergy(e);
    const r = !!(n && n.terminal);
    const u = !!(n && n.sources && n.sources.length >= REQUIRED_SOURCES);
    const l = getRoomActiveFactoryCount(e);
    const p = [];
    if (!r) p.push("no terminal");
    if (!u) p.push("insufficient sources (need " + REQUIRED_SOURCES + ")");
    if (t < MIN_STORAGE_ENERGY) p.push("low energy (" + t + " < " + MIN_STORAGE_ENERGY + ")");
    if (l >= MAX_FACTORY_OPS_PER_ROOM) p.push("busy (" + l + "/" + MAX_FACTORY_OPS_PER_ROOM + " active jobs)");
    const d = [];
    for (var s in o) {
      for (var c = 0; c < o[s].length; c++) {
        const t = o[s][c];
        if (t.room === e) d.push({
          product: s,
          phase: t.displayPhase || t.phase,
          isDecompress: DECOMPRESSION_PRODUCTS.indexOf(s) >= 0,
          isBuying: !!t.isBuying,
          blocksProduction: t.blocksProduction !== false
        });
      }
    }
    i.factory = {
      level: a,
      storageEnergy: t,
      hasTerminal: r,
      hasSources: u,
      eligible: p.length === 0,
      blockers: p,
      activeSlots: l,
      selling: factorySlots.countSelling(e),
      activeJobs: d
    };
  }
  const u = getRoomLabCount(e);
  if (u > 0) {
    const o = [];
    if (!(n && n.controller && n.controller.my)) o.push("not owned");
    if (!(n && n.terminal)) o.push("no terminal");
    if (u < MIN_LABS) o.push("too few labs (" + u + " < " + MIN_LABS + ")");
    const a = getRoomActiveLabCount(e);
    if (a >= MAX_LAB_OPS_PER_ROOM) o.push("lab slots full (" + MAX_LAB_OPS_PER_ROOM + "-job limit)");
    const s = [], c = [];
    for (var l in t) {
      for (var p = 0; p < t[l].length; p++) {
        const r = t[l][p];
        if (r.room === e) s.push({
          compound: l,
          state: r.displayPhase || r.state,
          blocksProduction: r.blocksProduction
        });
      }
    }
    for (var d in r) {
      for (var f = 0; f < r[d].length; f++) {
        const t = r[d][f];
        if (t.room === e) c.push({
          compound: d,
          state: t.displayPhase || t.state,
          blocksProduction: t.blocksProduction
        });
      }
    }
    i.lab = {
      labCount: u,
      hasTerminal: !!(n && n.terminal),
      hasSupplier: roomHasSupplier(e),
      eligible: o.length === 0,
      blockers: o,
      activeSlots: a,
      selling: getRoomSellingLabCount(e),
      activeReverse: s,
      activeForward: c
    };
  }
  return i;
}

function getRoomsReport(e) {
  const t = getActiveReverseReactions();
  const r = getActiveForwardReactions();
  const o = getActiveFactoryJobs();
  const n = {};
  const i = getRoomState.ownedNames();
  for (var a = 0; a < i.length; a++) {
    n[i[a]] = getRoomActiveFactoryCount(i[a]);
  }
  const s = getRoomState.ownedNames().slice().sort();
  const c = [ "[autoTrader] Room Status (tick " + Game.time + "):", "" ];
  let u = 0;
  for (var l = 0; l < s.length; l++) {
    const n = s[l];
    const i = getRoomState.get(n);
    if (!i || !i.isOwned) continue;
    if (e && n.toLowerCase().indexOf(e.toLowerCase()) < 0) continue;
    const a = getRoomStatusDetail(n, t, r, o);
    u++;
    c.push("=== " + n + " ===");
    if (a.factory) {
      const e = a.factory;
      c.push("  Factory [L" + e.level + "] " + (e.eligible ? "ELIGIBLE" : "INELIGIBLE") + " (slots " + e.activeSlots + "/" + MAX_FACTORY_OPS_PER_ROOM + ", selling " + e.selling + ", 1 processing)");
      c.push("    energy:   " + e.storageEnergy + (e.storageEnergy < MIN_STORAGE_ENERGY ? " (need " + MIN_STORAGE_ENERGY + ")" : " OK"));
      c.push("    terminal: " + (e.hasTerminal ? "yes" : "NO"));
      c.push("    sources:  " + (e.hasSources ? "yes" : "NO"));
      if (e.blockers.length > 0) c.push("    BLOCKED:  " + e.blockers.join("; "));
      if (e.activeJobs.length > 0) {
        c.push("    Running:");
        for (var p = 0; p < e.activeJobs.length; p++) {
          const t = e.activeJobs[p];
          const r = t.isDecompress ? " [decomp]" : "";
          const o = t.isBuying ? " (buying lock)" : t.blocksProduction ? "" : " (non-blocking)";
          c.push("      -> " + t.product + r + " [" + t.phase + "]" + o);
        }
      } else {
        c.push("    Running:  (none)");
      }
    } else {
      c.push("  Factory: none");
    }
    if (a.lab) {
      const e = a.lab;
      c.push("  Labs [" + e.labCount + "] " + (e.eligible ? "ELIGIBLE" : "INELIGIBLE") + " (slots " + e.activeSlots + "/" + MAX_LAB_OPS_PER_ROOM + ", selling " + e.selling + ", 1 processing)");
      c.push("    terminal: " + (e.hasTerminal ? "yes" : "NO"));
      c.push("    supplier: " + (e.hasSupplier ? "yes" : "NO"));
      c.push("    labs:     " + e.labCount + (e.labCount < MIN_LABS ? " (need " + MIN_LABS + ")" : " OK"));
      if (e.blockers.length > 0) c.push("    BLOCKED:  " + e.blockers.join("; "));
      if (e.activeReverse.length > 0 || e.activeForward.length > 0) {
        c.push("    Running:");
        for (var d = 0; d < e.activeReverse.length; d++) c.push("      -> reverse: " + e.activeReverse[d].compound + " [" + e.activeReverse[d].state + "]" + (e.activeReverse[d].blocksProduction ? "" : " (non-blocking)"));
        for (var f = 0; f < e.activeForward.length; f++) c.push("      -> forward: " + e.activeForward[f].compound + " [" + e.activeForward[f].state + "]" + (e.activeForward[f].blocksProduction ? "" : " (non-blocking)"));
      } else {
        c.push("    Running:  (none)");
      }
    } else {
      c.push("  Labs: none");
    }
    c.push("");
  }
  if (u === 0) c.push(e ? '  No owned rooms matching "' + e + '"' : "  No owned rooms found.");
  return c.join("\n");
}

function recheckActiveJobs(e) {
  const t = buildReactionMap();
  const r = [];
  const o = getActiveReverseReactions();
  const n = getActiveForwardReactions();
  const i = getActiveFactoryJobs();
  for (var a in o) {
    for (var s = 0; s < o[a].length; s++) {
      const n = o[a][s];
      if (n.state !== "BUYING" || n.cancellationPending || n.pipelineId || n.stockpile) continue;
      const i = scoreOpportunity(analyzeReverseReaction(a, t, "PASSIVE_SELL", "PASSIVE_BUY", n.room), {
        name: n.room,
        labCount: getRoomLabCount(n.room)
      });
      if (!i || i.breakEven) continue;
      const c = {
        type: "reverse",
        key: a,
        id: n.id,
        room: n.room,
        creditsPerTick: i.creditsPerTick
      };
      if (!e) c.cancelStatus = marketLab.cancelOperation("reverse", n.room, n.id, "no longer profitable (break-even failed)").status;
      r.push(c);
    }
  }
  for (var c in n) {
    for (var u = 0; u < n[c].length; u++) {
      const o = n[c][u];
      if (o.state !== "BUYING" || o.cancellationPending || o.pipelineId || o.stockpile) continue;
      let i = scoreOpportunity(analyzeForwardReaction(c, t, "PASSIVE_BUY", "PASSIVE_SELL"), {
        name: o.room,
        labCount: getRoomLabCount(o.room)
      });
      if (!i || i.breakEven) continue;
      const a = {
        type: "forward",
        key: c,
        id: o.id,
        room: o.room,
        creditsPerTick: i.creditsPerTick
      };
      if (!e) a.cancelStatus = marketLab.cancelOperation("forward", o.room, o.id, "no longer profitable (break-even failed)").status;
      r.push(a);
    }
  }
  for (var l in i) {
    for (var p = 0; p < i[l].length; p++) {
      const t = i[l][p];
      if (t.phase !== "buying") continue;
      const o = scoreOpportunity(analyzeFactoryProduct(l, "PASSIVE_SELL", "PASSIVE_BUY"), {
        name: t.room
      });
      if (!o || o.breakEven) continue;
      const n = {
        type: "factory",
        key: l,
        id: t.id,
        room: t.room,
        creditsPerTick: o.creditsPerTick,
        isDecompress: o.isDecompress
      };
      if (!e) {
        const e = marketRefine.abort(t.id || t.room, t.id ? undefined : l);
        n.cancelStatus = typeof e === "string" && e.indexOf("[MarketRefine] Aborted ") === 0 ? "cancelled" : "failed";
      }
      r.push(n);
    }
  }
  if (!e && r.length > 0) {
    const formatCancellation = function(e) {
      const t = typeof e.creditsPerTick === "number" ? e.creditsPerTick.toFixed(3) + " cr/t" : "N/A";
      return e.type + ":" + e.key + "(" + t + ")";
    };
    const e = r.filter(function(e) {
      return e.cancelStatus === "cancelled";
    });
    const t = r.filter(function(e) {
      return e.cancelStatus === "pending";
    });
    const o = r.filter(function(e) {
      return e.cancelStatus !== "cancelled" && e.cancelStatus !== "pending";
    });
    if (e.length > 0) console.log("[autoTrader] Cancelled break-even failures: " + e.map(formatCancellation).join(", "));
    if (t.length > 0) console.log("[autoTrader] Break-even cancellation cleanup pending: " + t.map(formatCancellation).join(", "));
    if (o.length > 0) console.log("[autoTrader] Failed to find break-even cancellation targets: " + o.map(formatCancellation).join(", "));
    requestSave();
  }
  return r;
}

function runAnalysis(e, t) {
  let r = beginCpuPhase(e);
  const o = buildReactionMap();
  const n = Object.keys(o);
  const i = ENABLE_LAB_JOBS ? getEligibleLabReactionRooms() : [];
  endCpuPhase(e, "setupRooms", r);
  r = beginCpuPhase(e);
  const a = ENABLE_LAB_JOBS && typeof marketLab.getStaleReplacementCandidates === "function" ? marketLab.getStaleReplacementCandidates() : [];
  const s = i.length > 0 || a.length > 0;
  const c = i[0] || null;
  endCpuPhase(e, "setupStale", r);
  r = beginCpuPhase(e);
  const u = getActiveReverseReactions();
  const l = getActiveForwardReactions();
  const p = getBuyingReverseReactions();
  const d = getBuyingForwardReactions();
  const f = getActiveFactoryJobs();
  endCpuPhase(e, "setupActive", r);
  r = beginCpuPhase(e);
  const m = {};
  const g = getRoomState.ownedNames();
  for (var R = 0; R < g.length; R++) {
    m[g[R]] = getRoomActiveFactoryCount(g[R]);
  }
  const E = [];
  for (var S = 0; S < g.length; S++) {
    const e = g[S];
    if (roomSuspender.shouldAvoidRoomWork(e) || !isEligibleForFactoryBasic(e, m)) continue;
    E.push({
      name: e,
      orderCount: m[e] || 0,
      storageEnergy: getRoomStorageEnergy(e),
      factoryLevel: getRoomFactoryLevel(e)
    });
  }
  E.sort(function(e, t) {
    if (e.orderCount !== t.orderCount) return e.orderCount - t.orderCount;
    return t.storageEnergy - e.storageEnergy;
  });
  endCpuPhase(e, "setupFactories", r);
  r = beginCpuPhase(e);
  const y = [];
  const h = {
    listed: {},
    activeLab: {},
    activeFactory: {},
    prospective: {}
  };
  buildCurrentSellAmounts(y, h);
  const O = {
    reverse: [],
    forward: [],
    factory: []
  };
  const v = [], b = [], T = [], P = [], C = [];
  const A = [];
  endCpuPhase(e, "setupExposure", r);
  r = beginCpuPhase(e);
  if (ENABLE_LAB_JOBS) logLabSchedulerLoads();
  endCpuPhase(e, "setupLog", r);
  function rememberSkipped(e, t, r, o, n) {
    A.push({
      kind: e,
      direction: t,
      name: r,
      score: o,
      reason: n
    });
  }
  function fmtScore(e) {
    return typeof e === "number" && isFinite(e) ? e.toFixed(3) + " cr/t" : "n/a";
  }
  function fmtCompactScore(e) {
    return typeof e === "number" && isFinite(e) ? String(Math.round(e)) : "n/a";
  }
  function compactReason(e) {
    return e.replace(/^\S+ live sell orders exceed limit$/, "sell-cap").replace(/^queued behind /, "queue@").replace(/^already buying forward in /, "buy@").replace(/^already buying reverse in /, "buy-rev@").replace(/^already buying in /, "buy@").replace(/^already processing in /, "active@").replace(/^already producing in /, "active@");
  }
  function reserveSellExposures(e) {
    const t = {};
    for (var r = 0; r < e.length; r++) {
      const o = e[r];
      if (!o || !(o.amount > 0)) continue;
      t[o.resource] = (t[o.resource] || 0) + o.amount;
    }
    for (const e in t) {
      const r = (h.listed[e] || 0) + (h.activeLab[e] || 0) + (h.activeFactory[e] || 0) + (h.prospective[e] || 0);
      if (r + t[e] > getSellExposureCap(e)) return false;
    }
    for (const e in t) {
      addSellExposure(h, "prospective", e, t[e]);
    }
    return true;
  }
  function reserveSellExposure(e, t) {
    return reserveSellExposures([ {
      resource: e,
      amount: t
    } ]);
  }
  function sellLimitDetail(e, t) {
    const r = h.listed[e] || 0;
    const o = h.activeLab[e] || 0;
    const n = h.activeFactory[e] || 0;
    const i = h.prospective[e] || 0;
    return {
      cap: getSellExposureCap(e),
      listed: r,
      activeLab: o,
      activeFactory: n,
      prospective: i,
      current: r + o + n + i,
      projected: t || 0,
      projectedTotal: r + o + n + i + (t || 0)
    };
  }
  const _ = beginCpuPhase(e);
  const k = {};
  const L = {};
  if (ENABLE_LAB_JOBS && s) {
    for (var I = 0; I < n.length; I++) {
      const e = n[I];
      const t = firstActive(p, e) || firstBlockingActive(l, e);
      const r = firstActive(d, e) || firstBlockingActive(u, e);
      const i = t && r;
      const a = i ? null : scoreOpportunity(analyzeReverseReaction(e, o, "PASSIVE_SELL", "PASSIVE_BUY", c && c.name), c);
      const s = i ? null : scoreOpportunity(analyzeForwardReaction(e, o, "PASSIVE_BUY", "PASSIVE_SELL"), c);
      L[e] = {
        reverse: a,
        forward: s
      };
      if (a && a.breakEven && s && s.breakEven) {
        k[e] = {
          revScore: a.creditsPerTick,
          fwdScore: s.creditsPerTick
        };
      }
    }
    const e = Object.keys(k);
    if (e.length > 0) {
      console.log("[autoTrader] Circular spreads (keeping better direction): " + e.map(function(e) {
        const t = k[e];
        return e + "(fwd " + t.fwdScore.toFixed(3) + " / rev " + t.revScore.toFixed(3) + " cr/t)";
      }).join(", "));
    }
  }
  const M = [];
  const N = [];
  const B = [];
  const U = {};
  const w = [];
  const F = [];
  const x = [];
  if (ENABLE_LAB_JOBS && s) {
    for (var D = 0; D < n.length; D++) {
      const e = n[D];
      const t = firstActive(p, e);
      const r = firstBlockingActive(l, e);
      if (r) {
        rememberSkipped("lab", "reverse", e, null, "opposite forward active in " + r.room);
        continue;
      }
      const o = L[e].reverse;
      if (!o) continue;
      if (k[e] && k[e].fwdScore >= k[e].revScore) {
        rememberSkipped("lab", "reverse", e, o.creditsPerTick, "lower credits/tick than forward direction");
        continue;
      }
      if (!o.breakEven) {
        rememberSkipped("lab", "reverse", e, o.creditsPerTick, "not break-even after fees");
        continue;
      }
      if (!meetsStartProfitThreshold(o)) {
        rememberSkipped("lab", "reverse", e, o.creditsPerTick, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold");
        continue;
      }
      M.push(o);
    }
  }
  if (ENABLE_LAB_JOBS && s) {
    for (var G = 0; G < n.length; G++) {
      const e = n[G];
      const t = firstActive(d, e);
      const r = firstBlockingActive(u, e);
      if (r) {
        rememberSkipped("lab", "forward", e, null, "opposite reverse active in " + r.room);
        continue;
      }
      const o = L[e].forward;
      if (!o) continue;
      if (k[e] && k[e].revScore > k[e].fwdScore) {
        rememberSkipped("lab", "forward", e, o.creditsPerTick, "lower credits/tick than reverse direction");
        continue;
      }
      if (!o.breakEven) {
        rememberSkipped("lab", "forward", e, o.creditsPerTick, "not break-even after fees");
        continue;
      }
      if (!meetsStartProfitThreshold(o)) {
        rememberSkipped("lab", "forward", e, o.creditsPerTick, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold");
        continue;
      }
      N.push(o);
    }
    const e = allowBatchDiscovery() ? getBatchLabCandidates(o, i) : {
      reverse: [],
      forward: [],
      deferred: true
    };
    if (e.deferred) {
      console.log("[autoTrader] Batch lab discovery skipped: bucket " + (Game.cpu.bucket || 0) + " (min " + BATCH_DISCOVERY_MIN_BUCKET + "), free CPU " + (Game.cpu.limit - Game.cpu.getUsed()).toFixed(1) + " (min " + BATCH_DISCOVERY_MIN_FREE_CPU + ")");
    } else if (e.truncated) {
      console.log("[autoTrader] Batch lab discovery truncated by the " + BATCH_DISCOVERY_CPU_BUDGET + " CPU scan budget; some compounds were not evaluated");
    }
    for (var Y = 0; Y < e.reverse.length; Y++) w.push(e.reverse[Y]);
    for (var j = 0; j < e.forward.length; j++) F.push(e.forward[j]);
    for (var q = 0; q < w.length; q++) {
      var V = M.findIndex(function(e) {
        return e.compound === w[q].compound;
      });
      if (V < 0) M.push(w[q]); else if ((w[q].creditsPerTick || 0) > (M[V].creditsPerTick || 0)) {
        M[V] = w[q];
      }
    }
    for (var Q = 0; Q < F.length; Q++) {
      var H = N.findIndex(function(e) {
        return e.compound === F[Q].compound;
      });
      if (H < 0) N.push(F[Q]); else if ((F[Q].creditsPerTick || 0) > (N[H].creditsPerTick || 0)) {
        N[H] = F[Q];
      }
    }
    const t = getFullPipelineCandidates();
    const r = t.advancedCompounds || {};
    for (var J = 0; J < M.length; J++) {
      if (r[M[J].compound]) {
        rememberSkipped("lab", "reverse", M[J].compound, M[J].creditsPerTick, "full pipeline required for advanced chemistry");
        M.splice(J, 1);
        J--;
      }
    }
    for (var W = 0; W < N.length; W++) {
      if (r[N[W].compound]) {
        rememberSkipped("lab", "forward", N[W].compound, N[W].creditsPerTick, "full pipeline required for advanced chemistry");
        N.splice(W, 1);
        W--;
      }
    }
    for (var X = 0; X < t.reverse.length; X++) M.push(t.reverse[X]);
    for (var K = 0; K < t.forward.length; K++) N.push(t.forward[K]);
    var z = t.shortfalls || [];
    for (var Z = 0; Z < z.length; Z++) {
      var $ = z[Z];
      rememberSkipped("pipeline", $.direction, $.compound, $.creditsPerTick, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold over " + Math.round($.elapsedTicks || 0) + " ticks");
    }
  }
  endCpuPhase(e, "labScoring", _);
  function getAnalysisFactoryRooms(e) {
    const t = [];
    const r = getProductFactoryLevel(e);
    for (var o = 0; o < E.length; o++) {
      const n = E[o];
      if (r === null || r > 0 && n.factoryLevel !== r) continue;
      if (LOCAL_REFINE_PRODUCTS.indexOf(e) >= 0 && (hasLiveLocalRefineInRoom(n.name, e) || n.storageEnergy < LOCAL_REFINE_ENERGY_RESERVE + 1e3)) continue;
      t.push(n);
    }
    return t;
  }
  function evalFactoryProduct(e) {
    if (BANNED_FACTORY_PRODUCTS.indexOf(e) >= 0) return;
    const t = DECOMPRESSION_PRODUCTS.indexOf(e) >= 0;
    const r = t ? "decompress" : "compress";
    const o = getProductFactoryLevel(e);
    const n = firstBuyingActive(f, e);
    if (n) {
      T.push({
        product: e,
        score: null,
        room: n.room,
        phase: n.phase,
        requiredLevel: o,
        isDecompress: t
      });
      rememberSkipped("factory", r, e, null, "already buying in " + n.room);
      return;
    }
    if (isFactoryProductOnCooldown(e)) {
      T.push({
        product: e,
        score: null,
        room: "?",
        phase: "cooldown",
        requiredLevel: o,
        isDecompress: t
      });
      rememberSkipped("factory", r, e, null, "cooldown");
      return;
    }
    const i = getOppositeFactoryProduct(e);
    if (i) {
      const t = firstBlockingActive(f, i);
      if (t) {
        rememberSkipped("factory", r, e, null, "opposite direction " + i + " active in " + t.room + " (" + t.phase + ")");
        return;
      }
    }
    const a = getAnalysisFactoryRooms(e);
    if (a.length === 0) {
      rememberSkipped("factory", r, e, null, "no eligible factory room");
      return;
    }
    const s = a[0];
    let c = scoreOpportunity(analyzeFactoryProduct(e, "PASSIVE_SELL", "PASSIVE_BUY"), s);
    if (!c) return;
    if (c.expectedNetProfit !== null && c.expectedNetProfit !== undefined) U[e] = c;
    if (!c.breakEven) {
      rememberSkipped("factory", c.isDecompress ? "decompress" : "compress", e, c.creditsPerTick, "not break-even after fees");
      return;
    }
    if (!meetsStartProfitThreshold(c)) {
      rememberSkipped("factory", c.isDecompress ? "decompress" : "compress", e, c.creditsPerTick, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold");
      return;
    }
    if (!c.isLocalRefine && !c.inputPrices) {
      C.push({
        product: e,
        score: c.creditsPerTick,
        isDecompress: c.isDecompress
      });
      rememberSkipped("factory", c.isDecompress ? "decompress" : "compress", e, c.creditsPerTick, "fee-aware budget infeasible");
      return;
    }
    if (c.isLocalRefine) {
      const t = a[0].storageEnergy - LOCAL_REFINE_ENERGY_RESERVE;
      c.expectedOutput = recipeExpectedOutput(e, t, RESOURCE_ENERGY) || 0;
      c = scoreOpportunity(c);
      if (!c.breakEven) {
        rememberSkipped("factory", "compress", e, c.creditsPerTick, "local refine not break-even at actual size");
        return;
      }
      if (!meetsStartProfitThreshold(c)) {
        rememberSkipped("factory", "compress", e, c.creditsPerTick, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold at actual size");
        return;
      }
    }
    c.plannedRoom = s.name;
    c.scoredRoom = s.name;
    U[e] = c;
    B.push(c);
  }
  const ee = beginCpuPhase(e);
  if (ENABLE_FACTORY_JOBS) {
    for (var te = 0; te < SUPPORTED_FACTORY_PRODUCTS.length; te++) evalFactoryProduct(SUPPORTED_FACTORY_PRODUCTS[te]);
  }
  if (ENABLE_FACTORY_DECOMPRESSION) {
    for (var re = 0; re < DECOMPRESSION_PRODUCTS.length; re++) evalFactoryProduct(DECOMPRESSION_PRODUCTS[re]);
  }
  const oe = [];
  if (ENABLE_FACTORY_JOBS) for (var ne = 0; ne < SUPPORTED_FACTORY_PRODUCTS.length; ne++) oe.push(SUPPORTED_FACTORY_PRODUCTS[ne]);
  if (ENABLE_FACTORY_DECOMPRESSION) for (var ie = 0; ie < DECOMPRESSION_PRODUCTS.length; ie++) oe.push(DECOMPRESSION_PRODUCTS[ie]);
  const ae = allowBatchDiscovery() ? getBatchFactoryCandidates(oe, E) : [];
  for (var se = 0; se < ae.length; se++) {
    const e = ae[se];
    if (firstBuyingActive(f, e.product) || isFactoryProductOnCooldown(e.product)) continue;
    const t = getProductFactoryLevel(e.product);
    var ce = E.filter(function(e) {
      return t === null || t === 0 || e.factoryLevel === t;
    });
    if (ce.length === 0) continue;
    e.batchMode = true;
    var ue = ce[0];
    for (var le = 0; le < ce.length; le++) {
      if (ce[le].name === e.plannedRoom) {
        ue = ce[le];
        break;
      }
    }
    e.plannedRoom = ue.name;
    e.scoredRoom = ue.name;
    x.push(e);
    var pe = B.findIndex(function(t) {
      return t.product === e.product;
    });
    if (pe < 0) B.push(e); else if ((e.creditsPerTick || 0) > (B[pe].creditsPerTick || 0)) {
      B[pe] = e;
    }
  }
  endCpuPhase(e, "factoryScoring", ee);
  const de = beginCpuPhase(e);
  const fe = Memory && Memory.autoTrader;
  const me = t || !fe || typeof fe.lastTwoStepScanTick !== "number" || Game.time - fe.lastTwoStepScanTick >= FULL_TWO_STEP_SCAN_INTERVAL;
  const ge = me ? buildTwoStepCandidates(L, U, !!t, h, c && c.name, o) : [];
  if (me && ge.completed) {
    reconcileNormalChains(ge, fe);
    if (fe) fe.lastTwoStepScanTick = Game.time;
  }
  if (ge.length > 0) {
    console.log("[autoTrader] Two-step candidates: " + ge.slice(0, 5).map(function(e) {
      return renderTwoStepChain(e) + " (" + e.creditsPerTick.toFixed(3) + " cr/t)";
    }).join(", "));
  } else if (ge.completed && ge.breakdownStats && ge.breakdownStats.considered > 0) {
    const e = ge.breakdownStats;
    console.log("[autoTrader] Breakdown diagnostics: considered " + e.considered + ", profitable " + e.profitable + ", sell-cap blocked " + e.sellBlocked);
  }
  endCpuPhase(e, "twoStepScan", de);
  const Re = beginCpuPhase(e);
  const Ee = {};
  const Se = {};
  const ye = {};
  function addInventoryPriorityResource(e) {
    if (e) Ee[e] = true;
  }
  function addInventorySellFirstResource(e) {
    if (e) {
      Ee[e] = true;
      Se[e] = true;
    }
  }
  for (var he = 0; he < M.length; he++) {
    const e = M[he].creditsPerTick || 0;
    const t = M[he].compound;
    if (ye[t] === undefined || e > ye[t]) {
      ye[t] = e;
    }
  }
  for (var Oe = 0; Oe < M.length; Oe++) {
    if (M[Oe].pipeline) {
      for (var ve = 0; ve < (M[Oe].outputLegs || []).length; ve++) {
        addInventorySellFirstResource(M[Oe].outputLegs[ve].resource);
      }
    } else {
      addInventorySellFirstResource(M[Oe].reagentA);
      addInventorySellFirstResource(M[Oe].reagentB);
    }
  }
  for (var be = 0; be < N.length; be++) {
    const e = N[be];
    const t = ye[e.compound];
    if (t === undefined || (e.creditsPerTick || 0) >= t) {
      addInventorySellFirstResource(e.compound);
    } else {
      addInventoryPriorityResource(e.compound);
    }
  }
  for (var Te = 0; Te < B.length; Te++) {
    addInventorySellFirstResource(B[Te].product);
  }
  for (var Pe in h.activeLab) {
    addInventorySellFirstResource(Pe);
  }
  for (var Ce in h.activeFactory) {
    addInventorySellFirstResource(Ce);
  }
  for (var Ae in l) {
    addInventorySellFirstResource(Ae);
  }
  const _e = beginCpuPhase(e);
  prioritizeExistingCommodityStock(h, o, u, l, Ee, Se);
  endCpuPhase(e, "inventoryPriority", _e);
  M.sort(function(e, t) {
    return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
  });
  N.sort(function(e, t) {
    return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
  });
  B.sort(function(e, t) {
    return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
  });
  const ke = [];
  for (var Le = 0; Le < M.length; Le++) ke.push(M[Le]);
  for (var Ie = 0; Ie < N.length; Ie++) ke.push(N[Ie]);
  ke.sort(function(e, t) {
    return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
  });
  const Me = i.slice();
  if (a.length > 0) {
    const e = a.map(function(e) {
      return e.roomName + "/" + e.direction + ":" + e.compound + "(age " + e.age + ", usable " + e.usable + "/" + e.batchSize + ", acquired " + e.acquiredTotal + ")";
    });
    console.log("[autoTrader] Stale lab slots available for replacement: " + e.join("; "));
  }
  const Ne = {};
  let Be = MAX_REVERSE_REACTIONS;
  let Ue = MAX_FORWARD_REACTIONS;
  for (var we = 0; we < ke.length; we++) {
    let e = ke[we];
    if (e.type === "reverse" && Be <= 0) continue;
    if (e.type === "forward" && Ue <= 0) continue;
    if (!e.pipeline && k[e.compound]) {
      const t = k[e.compound];
      if (e.type === "reverse" && t.fwdScore >= t.revScore || e.type === "forward" && t.revScore > t.fwdScore) continue;
    }
    const t = e.pipeline ? null : e.batchMode ? findStaleReplacementAssignment(a, Ne, e.type, e.compound) : null;
    const r = e.pipeline ? null : e.batchMode ? findStaleReplacementAssignment(a, Ne, e.type, e.compound, e.batchPurchases) : null;
    const o = !!(t && !r);
    const n = e.pipeline ? findPipelineRoomIndex(Me, e) : r || o ? -1 : findCompatibleLabRoomIndex(Me, e.type, e.compound, e.batchPurchases);
    const i = e.pipeline ? null : r || (!o && n < 0 ? findStaleReplacementAssignment(a, Ne, e.type, e.compound, e.batchPurchases) : null);
    if (n < 0 && !i) {
      rememberSkipped("lab", e.type, e.compound, e.creditsPerTick, o ? "stale same-compound job cannot receive this batch from its own room" : "no compatible room without the same active job");
      continue;
    }
    const s = n >= 0 ? Me[n] : i.room;
    const c = i ? i.replacement : null;
    e = e.pipeline ? Object.assign({}, e) : scoreOpportunity(Object.assign({}, e), s);
    e.scoredRoom = s.name;
    if (!e.breakEven) {
      rememberSkipped("lab", e.type, e.compound, e.creditsPerTick, "not break-even in compatible room " + s.name);
      continue;
    }
    if (!meetsStartProfitThreshold(e)) {
      rememberSkipped("lab", e.type, e.compound, e.creditsPerTick, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold in compatible room " + s.name);
      continue;
    }
    const u = e.pipeline ? e.plannedOutput || e.targetOutput || FULL_PIPELINE_OUTPUT : e.batchMode ? e.plannedOutput || e.targetOutput || LAB_PROJECTED_OUTPUT : LAB_PROJECTED_OUTPUT;
    if (e.type === "reverse") {
      const t = e.pipeline ? e.outputLegs : [ {
        resource: e.reagentA,
        amount: u
      }, {
        resource: e.reagentB,
        amount: u
      } ];
      if (!reserveSellExposures(t)) {
        const r = sellLimitDetail(t[0].resource, t[0].amount);
        const o = r.projectedTotal > r.cap ? t[0].resource : t[1].resource;
        P.push({
          compound: e.compound,
          resource: o,
          score: e.creditsPerTick,
          reason: "projected reagent sell exposure exceeds limit",
          exposure: sellLimitDetail(o, u)
        });
        rememberSkipped("lab", "reverse", e.compound, e.creditsPerTick, "projected reagent sell exposure exceeds limit");
        continue;
      }
      O.reverse.push(e);
      Be--;
    } else {
      if (!reserveSellExposure(e.compound, u)) {
        P.push({
          compound: e.compound,
          resource: e.compound,
          score: e.creditsPerTick,
          reason: e.compound + " live sell orders exceed limit",
          exposure: sellLimitDetail(e.compound, u)
        });
        rememberSkipped("lab", "forward", e.compound, e.creditsPerTick, e.compound + " live sell orders exceed limit");
        continue;
      }
      O.forward.push(e);
      Ue--;
    }
    e.plannedRoom = s.name;
    e.plannedRoomLoad = s.activeLabOps;
    if (c) {
      e.plannedReplacement = c;
      Ne[s.name] = true;
    } else {
      Me.splice(n, 1);
    }
  }
  O.reverse.sort(function(e, t) {
    return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
  });
  O.forward.sort(function(e, t) {
    return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
  });
  let Fe = MAX_FACTORY_JOBS;
  for (var xe = 0; xe < B.length && Fe > 0; xe++) {
    const e = B[xe];
    const t = getOppositeFactoryProduct(e.product);
    if (t) {
      let r = -1;
      for (var De = 0; De < O.factory.length; De++) {
        if (O.factory[De].product === t) {
          r = De;
          break;
        }
      }
      if (r >= 0) {
        const o = O.factory[r];
        if ((e.creditsPerTick || 0) > (o.creditsPerTick || 0)) {
          rememberSkipped("factory", o.isDecompress ? "decompress" : "compress", t, o.creditsPerTick, "lower credits/tick than opposite direction " + e.product);
          O.factory.splice(r, 1);
        } else {
          rememberSkipped("factory", e.isDecompress ? "decompress" : "compress", e.product, e.creditsPerTick, "lower credits/tick than opposite direction " + t);
          continue;
        }
      }
    }
    if (!reserveSellExposure(e.product, e.expectedOutput || 0)) {
      P.push({
        compound: e.product,
        resource: e.product,
        score: e.creditsPerTick,
        reason: e.product + " live sell orders exceed limit",
        exposure: sellLimitDetail(e.product, e.expectedOutput || 0)
      });
      rememberSkipped("factory", e.isDecompress ? "decompress" : "compress", e.product, e.creditsPerTick, e.product + " live sell orders exceed limit");
      continue;
    }
    O.factory.push(e);
    Fe--;
  }
  let Ge = false;
  if (O.reverse.length > 0) {
    const e = O.reverse.slice(0, 3).map(function(e) {
      return e.compound + (e.batchMode ? "[batch]" : "") + "(" + fmtScore(e.creditsPerTick) + ")";
    });
    console.log("[AutoTrader] NEW reverse: " + e.join(", ") + (O.reverse.length > 3 ? " +" + (O.reverse.length - 3) + " more" : ""));
  }
  if (O.forward.length > 0) {
    const e = O.forward.slice(0, 3).map(function(e) {
      return e.compound + (e.batchMode ? "[batch]" : "") + "(" + fmtScore(e.creditsPerTick) + ")";
    });
    console.log("[AutoTrader] NEW forward: " + e.join(", ") + (O.forward.length > 3 ? " +" + (O.forward.length - 3) + " more" : ""));
  } else {
    const e = A.filter(function(e) {
      return e.kind === "lab" && e.direction === "forward" && typeof e.score === "number" && e.score > 0;
    });
    if (e.length > 0) {
      e.sort(function(e, t) {
        return t.score - e.score;
      });
      const t = e.slice(0, 3).map(function(e) {
        return e.name + " " + fmtCompactScore(e.score) + " " + compactReason(e.reason);
      });
      console.log("[AutoTrader] No NEW forward: " + t.join(" | ") + (e.length > 3 ? " | +" + (e.length - 3) : ""));
      Ge = true;
    }
  }
  if (O.factory.length > 0) {
    const e = [], t = [];
    for (var Ye = 0; Ye < O.factory.length; Ye++) {
      const r = O.factory[Ye];
      const o = r.product + (r.requiredLevel > 0 ? " L" + r.requiredLevel : "") + (r.batchMode ? "[batch]" : "") + "(" + fmtScore(r.creditsPerTick) + ")";
      if (r.isDecompress) t.push(o); else e.push(o);
    }
    if (e.length > 0) console.log("[AutoTrader] NEW compress:   " + e.join(", "));
    if (t.length > 0) console.log("[AutoTrader] NEW decompress: " + t.join(", "));
  }
  A.sort(function(e, t) {
    return (t.score || -9999) - (e.score || -9999);
  });
  const je = Ge ? A.filter(function(e) {
    return e.kind !== "lab" || e.direction !== "forward";
  }) : A;
  if (je.length > 0) {
    const e = je.slice(0, 3).map(function(e) {
      const t = e.kind === "factory" ? "fac" : e.kind;
      const r = e.direction === "forward" ? "fwd" : e.direction === "reverse" ? "rev" : e.direction === "compress" ? "comp" : e.direction === "decompress" ? "decomp" : e.direction;
      return t + "/" + r + " " + e.name + " " + fmtCompactScore(e.score) + " " + compactReason(e.reason);
    });
    console.log("[AutoTrader] Rejects: " + e.join(" | ") + (je.length > 3 ? " | +" + (je.length - 3) : ""));
  }
  endCpuPhase(e, "selection", Re);
  return {
    reverse: O.reverse,
    forward: O.forward,
    factory: O.factory,
    twoStep: ge,
    twoStepDeferred: me && !ge.completed,
    skippedReverse: v,
    skippedForward: b,
    skippedFactory: T,
    skippedSellLimit: P,
    skippedBudgetInfeasible: C,
    skippedChoices: A,
    unbackedSellOrders: y,
    _labRooms: i
  };
}

var PASSIVE_SCAN_RANGE_GATE = .2;
var PASSIVE_SCAN_BUY_TICKS = 400;
var PASSIVE_SCAN_STAGE_TICKS = 40;
var PASSIVE_SCAN_SELL_TICKS = 300;
function passiveScanProducts() {
  var e = [];
  var t = {};
  var r = [ SUPPORTED_FACTORY_PRODUCTS, DECOMPRESSION_PRODUCTS ];
  for (var o = 0; o < r.length; o++) {
    var n = r[o] || [];
    for (var i = 0; i < n.length; i++) {
      var a = n[i];
      if (!t[a]) {
        t[a] = true;
        e.push(a);
      }
    }
  }
  return e;
}

function passiveScanCooldown(e) {
  var t = Memory && Memory.autoTrader;
  if (!t) return false;
  var r = t.factoryCooldowns;
  if (r && typeof r[e] === "number" && Game.time - r[e] < FACTORY_JOB_COOLDOWN) {
    return true;
  }
  var o = Array.isArray(t.jobsStarted) ? t.jobsStarted : [];
  for (var n = o.length - 1; n >= 0; n--) {
    var i = o[n];
    if (i && i.type === "factory" && i.product === e && typeof i.tick === "number" && Game.time - i.tick < FACTORY_JOB_COOLDOWN) {
      return true;
    }
  }
  return false;
}

function passiveScanFactoryRooms(e) {
  var t = [];
  var r = getRoomState.ownedNames();
  var o = {};
  for (var n = 0; n < r.length; n++) {
    o[r[n]] = getRoomActiveFactoryCount(r[n]);
  }
  for (var i = 0; i < r.length; i++) {
    var a = r[i];
    if (roomSuspender.shouldAvoidRoomWork(a)) continue;
    if (!isEligibleForFactoryBasic(a, o)) continue;
    if (!canRoomProduceProduct(a, e)) continue;
    t.push({
      name: a,
      orderCount: o[a] || 0,
      storageEnergy: getRoomStorageEnergy(a),
      factoryLevel: getRoomFactoryLevel(a)
    });
  }
  t.sort(function(e, t) {
    if (e.orderCount !== t.orderCount) return e.orderCount - t.orderCount;
    if (e.storageEnergy !== t.storageEnergy) return t.storageEnergy - e.storageEnergy;
    return e.name < t.name ? -1 : e.name > t.name ? 1 : 0;
  });
  return t;
}

function passiveScanInputQuote(e, t, r, o) {
  var n = pricing.getBook(e);
  var i = marketRefine && typeof marketRefine.isForceMarketBuy === "function" ? marketRefine.isForceMarketBuy(e) : false;
  var a = pricing.chooseBuyMethod(e, o, {
    rangeGate: PASSIVE_SCAN_RANGE_GATE,
    forceOrder: i,
    amount: t
  });
  var s = {
    resource: e,
    amount: t,
    ceiling: o,
    bestBid: n ? n.bestBid : null,
    bestAsk: n ? n.bestAsk : null,
    method: a.method,
    reason: a.reason,
    suggestedBid: a.suggestedBid
  };
  if (a.method === "order") {
    var c = a.suggestedBid;
    if (!(typeof c === "number" && c > 0 && c <= o + 5e-4)) {
      s.ok = false;
      s.reason = "passive bid unavailable below ceiling";
      return s;
    }
    s.ok = true;
    s.method = "marketBuy";
    s.price = Math.max(.001, Math.round(c * 1e3) / 1e3);
    s.transferEnergy = 0;
    return s;
  }
  var u = pricing.executableBuyQuote(e, t, r);
  if (!u || u.amount < t) {
    s.ok = false;
    s.reason = "no executable sell depth for requested amount";
    return s;
  }
  if (!(u.price > 0) || u.price > o + 5e-4) {
    s.ok = false;
    s.price = u.price;
    s.transferEnergy = u.transferEnergy || 0;
    s.reason = "executable ask exceeds ceiling";
    return s;
  }
  s.ok = true;
  s.method = "opportunisticBuy";
  s.price = u.price;
  s.transferEnergy = u.transferEnergy || 0;
  return s;
}

function passiveScanBlockers(e, t) {
  var r = [];
  var o = firstBuyingActive(t, e);
  if (o) r.push("already buying in " + o.room);
  if (passiveScanCooldown(e)) r.push("factory cooldown");
  var n = getOppositeFactoryProduct(e);
  if (n) {
    var i = firstBlockingActive(t, n);
    if (i) r.push("opposite direction " + n + " active in " + i.room);
  }
  return r;
}

function passiveScanProduct(e, t, r) {
  var o = {
    product: e,
    direction: DECOMPRESSION_PRODUCTS.indexOf(e) >= 0 ? "decompress" : "compress",
    status: "REJECTED",
    room: null,
    inputs: [],
    blockers: passiveScanBlockers(e, t)
  };
  if (BANNED_FACTORY_PRODUCTS.indexOf(e) >= 0) {
    o.reason = "banned factory product";
    return o;
  }
  var n = COMMODITIES && COMMODITIES[e];
  if (!n || !n.components) {
    o.status = "NO_DATA";
    o.reason = "commodity recipe unavailable";
    return o;
  }
  var i = passiveScanFactoryRooms(e);
  if (i.length === 0) {
    o.reason = "no eligible factory room";
    return o;
  }
  o.room = i[0].name;
  o.factoryLevel = i[0].factoryLevel;
  var a = pricing.passiveSellPrice(e);
  var s = pricing.getBook(e);
  o.outputPrice = a;
  o.outputAsk = s ? s.bestAsk : null;
  o.outputAmount = (n.amount || 1) * MARKET_REFINE_BATCH_MULTIPLIER;
  o.cycles = MARKET_REFINE_BATCH_MULTIPLIER;
  var c = r && r.listed ? r.listed[e] || 0 : 0;
  var u = r && r.activeLab ? r.activeLab[e] || 0 : 0;
  var l = r && r.activeFactory ? r.activeFactory[e] || 0 : 0;
  var p = r && r.prospective ? r.prospective[e] || 0 : 0;
  var d = getSellExposureCap(e);
  o.exposure = {
    cap: d,
    current: c + u + l + p,
    projected: o.outputAmount,
    projectedTotal: c + u + l + p + o.outputAmount
  };
  if (o.exposure.projectedTotal > d) {
    o.blockers.push("sell exposure " + o.exposure.projectedTotal + "/" + d);
  }
  if (!(a > 0)) {
    o.reason = "no executable output sell price";
    return o;
  }
  var f = pricing.breakEvenInputCeilings(e);
  if (!f) {
    o.reason = "no fee-aware input ceilings";
    return o;
  }
  var m = statusEnergyPrice() || 0;
  var g = 0;
  var R = 0;
  var E = null;
  for (var S in n.components) {
    if (!n.components.hasOwnProperty(S)) continue;
    var y = n.components[S] || 0;
    if (!(y > 0)) continue;
    var h = y * o.cycles;
    if (S === RESOURCE_ENERGY) {
      if (!(m > 0)) {
        E = "energy price unavailable";
        o.inputs.push({
          resource: S,
          amount: h,
          method: "on-hand",
          price: null
        });
        continue;
      }
      g += m * y;
      o.inputs.push({
        resource: S,
        amount: h,
        method: "on-hand",
        price: m,
        ceiling: null,
        reason: "energy is valued as an opportunity cost"
      });
      continue;
    }
    var O = f[S];
    if (!(O > 0)) {
      E = "no ceiling for " + S;
      o.inputs.push({
        resource: S,
        amount: h,
        method: "unpriced",
        price: null,
        ceiling: O
      });
      continue;
    }
    var v = passiveScanInputQuote(S, h, o.room, O);
    o.inputs.push(v);
    if (!v.ok) {
      E = v.reason;
      continue;
    }
    g += v.price * y;
    R += (v.transferEnergy || 0) * m;
  }
  if (E) {
    o.reason = E;
    return o;
  }
  var b = a * (n.amount || 1);
  var T = marketAnalysis.scoreProduction({
    materialCost: g,
    revenue: b,
    cycles: o.cycles,
    cycleTicks: factoryCooldownFor(e),
    parallelism: 1,
    expectedBuyTicks: PASSIVE_SCAN_BUY_TICKS,
    expectedStageTicks: PASSIVE_SCAN_STAGE_TICKS,
    expectedSellTicks: PASSIVE_SCAN_SELL_TICKS,
    expectedQueueTicks: 0,
    terminalEnergyCost: R,
    marketFees: (b + g) * o.cycles * pricing.FEE,
    repriceAllowance: 0
  });
  if (!T) {
    o.reason = "could not score production";
    return o;
  }
  for (var P in T) o[P] = T[P];
  o.materialCostPerCycle = g;
  o.outputRevenuePerCycle = b;
  o.terminalEnergyCost = R;
  if (!T.breakEven) o.reason = "not break-even after fees and timing"; else if (!meetsStartProfitThreshold(T)) o.reason = "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold"; else if (o.blockers.length > 0) o.reason = o.blockers.join("; "); else {
    o.status = "WOULD_BUY";
    o.reason = "profitable passive factory candidate";
    return o;
  }
  if (T.breakEven && meetsStartProfitThreshold(T)) o.status = "PROFITABLE_BLOCKED";
  return o;
}

function passiveFactoryScan() {
  var e = getActiveFactoryJobs();
  var t = {
    listed: {},
    activeLab: {},
    activeFactory: {},
    prospective: {}
  };
  buildCurrentSellAmounts([], t);
  var r = passiveScanProducts();
  var o = [];
  for (var n = 0; n < r.length; n++) {
    try {
      o.push(passiveScanProduct(r[n], e, t));
    } catch (e) {
      o.push({
        product: r[n],
        direction: DECOMPRESSION_PRODUCTS.indexOf(r[n]) >= 0 ? "decompress" : "compress",
        status: "ERROR",
        reason: e && e.message ? e.message : String(e),
        inputs: []
      });
    }
  }
  o.sort(function(e, t) {
    var r = typeof e.creditsPerTick === "number" ? e.creditsPerTick : -Infinity;
    var o = typeof t.creditsPerTick === "number" ? t.creditsPerTick : -Infinity;
    return o - r || e.product.localeCompare(t.product);
  });
  return {
    version: 1,
    mode: "passive-factory-diagnostic",
    simulationOnly: true,
    evaluated: o.length,
    wouldBuy: o.filter(function(e) {
      return e.status === "WOULD_BUY";
    }).length,
    profitableBlocked: o.filter(function(e) {
      return e.status === "PROFITABLE_BLOCKED";
    }).length,
    rejected: o.filter(function(e) {
      return e.status !== "WOULD_BUY" && e.status !== "PROFITABLE_BLOCKED";
    }).length,
    rows: o,
    warnings: [ "No market orders, production jobs, or buy requests are created.", "Passive fill probability is not modeled; buy timing uses the normal 400-tick factory estimate.", 'Global factory top-N selection is not applied; use autoTrader("analyze") for final scheduling.' ]
  };
}

function passiveScanPrice(e) {
  return typeof e === "number" && isFinite(e) ? e.toFixed(3) : "-";
}

function passiveFactoryScanReport() {
  var e = passiveFactoryScan();
  var t = [ "[autoTrader] PASSIVE FACTORY SCAN ONLY", "Evaluated " + e.evaluated + " products | WOULD_BUY " + e.wouldBuy + " | PROFITABLE_BLOCKED " + e.profitableBlocked + " | REJECTED " + e.rejected, "", "Status             Product        Room       cr/t       Output        Inputs" ];
  for (var r = 0; r < e.rows.length; r++) {
    var o = e.rows[r];
    var n = o.inputs && o.inputs.length > 0 ? o.inputs.map(function(e) {
      var t = e.method || "unpriced";
      var r = passiveScanPrice(e.price);
      var o = e.ceiling > 0 ? "/" + passiveScanPrice(e.ceiling) : "";
      var n = e.bestAsk > 0 ? ";ask=" + passiveScanPrice(e.bestAsk) : "";
      return e.resource + "@" + r + o + "[" + t + n + "]";
    }).join(",") : "-";
    var i = (o.product + "             ").slice(0, 14);
    var a = ((o.room || "-") + "          ").slice(0, 10);
    var s = (o.status + "                 ").slice(0, 18);
    var c = o.outputPrice > 0 ? o.outputAmount + "@" + passiveScanPrice(o.outputPrice) : "-";
    t.push(s + " " + i + " " + a + " " + (typeof o.creditsPerTick === "number" ? o.creditsPerTick.toFixed(3) : "-").padStart(9) + " " + (c + "             ").slice(0, 13) + " " + n);
    if (o.reason) t.push("  reason: " + o.reason);
  }
  t.push("", "Warnings:");
  for (var u = 0; u < e.warnings.length; u++) t.push("- " + e.warnings[u]);
  var l = t.join("\n");
  return l;
}

function passiveFactoryScanJSON() {
  return JSON.stringify(passiveFactoryScan(), null, 2);
}

function executeJobs(e, t) {
  const r = e._labRooms ? e._labRooms.slice() : getEligibleLabReactionRooms();
  let o = [], n = 0, i = 0, a = 0;
  const s = {};
  const c = {};
  const u = {};
  let l = Object.create(null);
  const p = [];
  const d = e.reverse.length + e.forward.length;
  if (d > 0) {
    const e = r.map(function(e) {
      return e.name + "(slots " + e.activeLabOps + "/" + MAX_LAB_OPS_PER_ROOM + ", selling " + getRoomSellingLabCount(e.name) + ", labs " + (e.labManagerBusy ? "busy" : "idle") + ")";
    });
    console.log("[autoTrader] Lab scheduler pool: " + (e.length > 0 ? e.join("; ") : "no eligible rooms"));
  }
  function selectLabRoom(e) {
    let t = -1;
    for (var o = 0; o < r.length; o++) {
      const n = getRoomLabJob(r[o].name, e.type, e.compound);
      if (n) {
        const t = e.type + ":" + e.compound + ":" + r[o].name;
        if (!u[t]) {
          u[t] = true;
          console.log("[autoTrader] Scheduler skipped " + r[o].name + " for " + e.type + " " + e.compound + ": same job already active (" + (n.state || "unknown") + "), load " + r[o].activeLabOps + "/" + MAX_LAB_OPS_PER_ROOM);
        }
        continue;
      }
      if (r[o].name === e.plannedRoom) t = o;
    }
    if (t >= 0) return t;
    return findCompatibleLabRoomIndex(r, e.type, e.compound, e.batchPurchases);
  }
  function bufferRefusal(e, t, r, o, n) {
    let i = "" + o;
    const a = " in " + r;
    if (i.length > a.length && i.slice(-a.length) === a) {
      i = i.slice(0, -a.length);
    }
    i = i.slice(0, 160);
    const s = e + "|" + t + "|" + i;
    if (!l[s]) {
      l[s] = {
        op: e,
        compound: t,
        reason: i,
        rooms: []
      };
    }
    l[s].rooms.push(r);
    p.push({
      op: e,
      compound: t,
      creditsPerTick: n,
      room: r,
      reason: i
    });
  }
  function flushRefusals() {
    const e = Object.keys(l);
    for (var t = 0; t < e.length; t++) {
      const r = l[e[t]];
      if (r.rooms.length === 1) {
        console.log("[autoTrader] " + r.op + " REFUSED " + r.compound + " in " + r.rooms[0] + ": " + r.reason + " in " + r.rooms[0]);
      } else {
        console.log("[autoTrader] " + r.op + " REFUSED " + r.compound + " x" + r.rooms.length + ": " + r.reason);
        console.log("[autoTrader]   " + r.rooms.join(", "));
      }
    }
    l = Object.create(null);
  }
  function flushRefusedChoices() {
    if (p.length === 0) return;
    const e = Object.create(null);
    const t = [];
    for (var r = 0; r < p.length; r++) {
      const o = p[r];
      const n = o.op + "|" + o.compound + "|" + o.reason;
      if (!e[n]) {
        e[n] = {
          op: o.op,
          compound: o.compound,
          creditsPerTick: o.creditsPerTick,
          reason: o.reason,
          count: 0
        };
        t.push(e[n]);
      }
      e[n].count++;
    }
    t.sort(function(e, t) {
      return (t.creditsPerTick || -Infinity) - (e.creditsPerTick || -Infinity);
    });
    const o = t.slice(0, 5).map(function(e) {
      const t = typeof e.creditsPerTick === "number" ? e.creditsPerTick.toFixed(3) + " cr/t" : "n/a";
      return e.op + ":" + e.compound + "(" + t + ")" + (e.count > 1 ? " x" + e.count : "") + " - " + e.reason;
    });
    console.log("[autoTrader] Top execution refusals: " + o.join("; "));
  }
  function labStartAccepted(e, t) {
    return typeof e === "string" && e.indexOf("[" + t + "] Queued:") === 0;
  }
  function findNewestLabOpId(e, t, r) {
    return marketLab && typeof marketLab.getNewestOperationId === "function" ? marketLab.getNewestOperationId(e, t, r, Game.time) : null;
  }
  function phaseLabAdmission(e, t) {
    const r = typeof marketLab.getOperations === "function" ? marketLab.getOperations() : [];
    let o = null;
    for (let n = 0; n < r.length; n++) {
      if (r[n] && r[n].id === t) {
        o = r[n];
        break;
      }
    }
    const n = o && o.state === "PENDING";
    marketEconomics.phase(e, n ? "pending" : "buying");
    if (n) console.log("[autoTrader] " + o.room + "/" + o.targetCompound + ": queued behind " + o.room);
    return n;
  }
  if (ENABLE_LAB_JOBS) {
    const a = [];
    for (var f = 0; f < e.reverse.length; f++) a.push(e.reverse[f]);
    for (var m = 0; m < e.forward.length; m++) a.push(e.forward[m]);
    a.sort(function(e, t) {
      return (t.creditsPerTick || 0) - (e.creditsPerTick || 0);
    });
    for (var g = 0; g < a.length; g++) {
      let e = a[g];
      if (e.type === "reverse" && n >= MAX_REVERSE_REACTIONS) continue;
      if (e.type === "forward" && i >= MAX_FORWARD_REACTIONS) continue;
      const u = e.type + ":" + e.compound;
      if (s[u]) continue;
      if (c[u]) continue;
      c[u] = true;
      let l = -1;
      let d = null;
      let f = false;
      if (e.plannedReplacement && typeof marketLab.getStaleReplacementCandidates === "function") {
        const t = marketLab.getStaleReplacementCandidates();
        let r = null;
        for (var R = 0; R < t.length; R++) {
          if (t[R].opId === e.plannedReplacement.opId && t[R].roomName === e.plannedReplacement.roomName) {
            r = t[R];
            break;
          }
        }
        if (!r) {
          const t = "planned stale slot is no longer safely replaceable";
          console.log("[autoTrader] Scheduler could not replace " + e.plannedReplacement.direction + " " + e.plannedReplacement.compound + " in " + e.plannedReplacement.roomName + ": " + t);
          p.push({
            op: e.type === "reverse" ? "labReverse" : "labForward",
            compound: e.compound,
            creditsPerTick: e.creditsPerTick,
            room: e.plannedReplacement.roomName,
            reason: t
          });
          continue;
        }
        const o = [];
        for (var E in r.acquired) {
          if (r.acquired[E] > 0) o.push(r.acquired[E] + " " + E);
        }
        console.log("[autoTrader] Replacing stale " + r.direction + " " + r.compound + " in " + r.roomName + " with " + e.type + " " + e.compound + ": age " + r.age + ", usable " + r.usable + "/" + r.batchSize + (o.length > 0 ? ", selling acquired " + o.join(" + ") : ", no acquired input"));
        d = {
          name: r.roomName,
          labCount: getRoomLabCount(r.roomName),
          activeLabOps: Math.max(0, getRoomActiveLabCount(r.roomName) - 1),
          labManagerBusy: labManager && typeof labManager.roomHasPendingOrder === "function" ? labManager.roomHasPendingOrder(r.roomName) : false,
          excludeOpId: r.opId
        };
        f = true;
        e.liveReplacement = r;
      } else {
        l = selectLabRoom(e);
        if (l >= 0) d = r[l];
      }
      if (!d) {
        const t = "no compatible room (same job active, room ineligible, or rooms at " + MAX_LAB_OPS_PER_ROOM + "-job cap)";
        console.log("[autoTrader] Scheduler could not place " + e.type + " " + e.compound + ": " + t);
        p.push({
          op: e.type === "reverse" ? "labReverse" : "labForward",
          compound: e.compound,
          creditsPerTick: e.creditsPerTick,
          room: null,
          reason: t
        });
        continue;
      }
      if (!e.pipeline && e.scoredRoom !== d.name) {
        e = scoreOpportunity(e, d);
        e.scoredRoom = d.name;
      }
      if (!canScheduleStandaloneLabCandidate(e)) {
        rememberSkipped("lab", "forward", e.compound, e.creditsPerTick, "best restricted-product exit requires a second conversion");
        continue;
      }
      if (!e.breakEven) {
        bufferRefusal(e.type === "reverse" ? "labReverse" : "labForward", e.compound, d.name, "not break-even at selected room price/queue", e.creditsPerTick);
        continue;
      }
      if (!meetsStartProfitThreshold(e)) {
        bufferRefusal(e.type === "reverse" ? "labReverse" : "labForward", e.compound, d.name, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold at selected room price/queue", e.creditsPerTick);
        continue;
      }
      console.log("[autoTrader] Scheduler assigned " + e.type + " " + e.compound + " to " + d.name + ": load " + d.activeLabOps + "/" + MAX_LAB_OPS_PER_ROOM + ", labs " + (d.labManagerBusy ? "busy" : "idle") + ", " + (d.activeLabOps === 0 ? "empty-room preference" : "lowest compatible load") + ", " + (typeof e.creditsPerTick === "number" ? e.creditsPerTick.toFixed(3) + " cr/t" : "score n/a"));
      if (!t) {
        if (e.pipeline) {
          const t = marketEconomics.mintJobId();
          const n = Object.keys(e.inputQuantities || {});
          const i = (e.outputLegs || []).map(function(e) {
            return e.resource;
          });
          marketEconomics.start(t, {
            kind: e.pipelineMode === "synthesis" ? "full_synthesis" : "full_decompose",
            room: d.name,
            product: e.compound,
            inputs: n,
            outputs: i,
            expectedNetProfit: e.expectedNetProfit,
            expectedElapsedTicks: e.expectedElapsedTicks,
            expectedCreditsPerTick: e.creditsPerTick
          });
          marketEconomics.phase(t, "queued");
          const a = e.type === "forward" ? e.inputPrices : e.maxBuyPrice;
          const s = marketLab.startAutoPipeline(e.type, d.name, e.compound, a, t, {
            amount: e.targetOutput || FULL_PIPELINE_OUTPUT
          });
          if (!labStartAccepted(s, e.type === "reverse" ? "labReverse" : "labForward")) {
            marketEconomics.finish(t, "refused", "" + s);
            bufferRefusal(e.type === "reverse" ? "labReverse" : "labForward", e.compound, d.name, s, e.creditsPerTick);
            r.splice(l, 1);
            g--;
            continue;
          }
          const c = findNewestLabOpId(e.type, d.name, e.compound);
          marketEconomics.link(t, "marketLab", c);
           phaseLabAdmission(t, c);
          console.log("[autoTrader] Started full " + e.pipelineMode + " " + e.compound + " x" + (e.targetOutput || FULL_PIPELINE_OUTPUT) + " in " + d.name + " (" + e.creditsPerTick.toFixed(3) + " cr/t) [" + t + "]");
          o.push({
            type: e.pipelineMode === "synthesis" ? "full_synthesis" : "full_decompose",
            compound: e.compound,
            room: d.name,
            expectedCreditsPerTick: e.creditsPerTick,
            expectedNetProfit: e.expectedNetProfit,
            expectedElapsedTicks: e.expectedElapsedTicks,
            opId: c,
            jobId: t,
            tick: Game.time
          });
        } else if (e.type === "reverse") {
          const t = e.compoundPrice > 0 ? e.compoundPrice : undefined;
          const n = marketEconomics.mintJobId();
          marketEconomics.start(n, {
            kind: "labReverse",
            room: d.name,
            product: e.compound,
            inputs: [ e.compound ],
            outputs: [ e.reagentA, e.reagentB ],
            expectedNetProfit: e.expectedNetProfit,
            expectedElapsedTicks: e.expectedElapsedTicks,
            expectedCreditsPerTick: e.creditsPerTick
          });
          marketEconomics.phase(n, "queued");
          const i = f ? marketLab.replaceOperation("reverse", d.name, e.liveReplacement.direction, e.liveReplacement.opId, e.compound, t, "replaced after " + e.liveReplacement.age + " buying ticks by reverse " + e.compound, n, e.batchMode ? {
            batchMode: true,
            batchSize: e.plannedOutput || e.targetOutput,
            batchPurchases: e.batchPurchases
          } : null) : marketLab.startAutoOperation("reverse", d.name, e.compound, t, n, e.batchMode ? {
            batchMode: true,
            batchSize: e.plannedOutput || e.targetOutput,
            batchPurchases: e.batchPurchases
          } : null);
          if (!labStartAccepted(i, "labReverse")) {
            marketEconomics.finish(n, "refused", "" + i);
            bufferRefusal("labReverse", e.compound, d.name, i, e.creditsPerTick);
            if (!f) {
              r.splice(l, 1);
              g--;
            }
            continue;
          }
          const a = findNewestLabOpId("reverse", d.name, e.compound);
          if (f) console.log("[autoTrader] Replacement committed in " + d.name + ": " + e.liveReplacement.compound + " -> reverse " + e.compound + ".");
          marketEconomics.link(n, "marketLab", a);
           phaseLabAdmission(n, a);
          console.log("[autoTrader] Started reverse " + e.compound + " -> " + e.reagentA + "+" + e.reagentB + " (" + e.creditsPerTick.toFixed(3) + " cr/t) in " + d.name + (t ? " (max " + t.toFixed(3) + ")" : " (no price ceiling)") + " [" + n + "]");
          o.push({
            type: "reverse",
            compound: e.compound,
            room: d.name,
            expectedCreditsPerTick: e.creditsPerTick,
            expectedNetProfit: e.expectedNetProfit,
            expectedElapsedTicks: e.expectedElapsedTicks,
            maxPrice: e.compoundPrice,
            opId: a,
            jobId: n,
            tick: Game.time
          });
        } else {
          const t = {};
          if (e.reagentAPrice > 0) t[e.reagentA] = e.reagentAPrice;
          if (e.reagentBPrice > 0) t[e.reagentB] = e.reagentBPrice;
          const n = marketEconomics.mintJobId();
          marketEconomics.start(n, {
            kind: "labForward",
            room: d.name,
            product: e.compound,
            inputs: [ e.reagentA, e.reagentB ],
            outputs: [ e.compound ],
            expectedNetProfit: e.expectedNetProfit,
            expectedElapsedTicks: e.expectedElapsedTicks,
            expectedCreditsPerTick: e.creditsPerTick
          });
          marketEconomics.phase(n, "queued");
          const i = f ? marketLab.replaceOperation("forward", d.name, e.liveReplacement.direction, e.liveReplacement.opId, e.compound, t, "replaced after " + e.liveReplacement.age + " buying ticks by forward " + e.compound, n, e.batchMode ? {
            batchMode: true,
            batchSize: e.plannedOutput || e.targetOutput,
            batchPurchases: e.batchPurchases
          } : null) : marketLab.startAutoOperation("forward", d.name, e.compound, t, n, e.batchMode ? {
            batchMode: true,
            batchSize: e.plannedOutput || e.targetOutput,
            batchPurchases: e.batchPurchases
          } : null);
          if (!labStartAccepted(i, "labForward")) {
            marketEconomics.finish(n, "refused", "" + i);
            bufferRefusal("labForward", e.compound, d.name, i, e.creditsPerTick);
            if (!f) {
              r.splice(l, 1);
              g--;
            }
            continue;
          }
          const a = findNewestLabOpId("forward", d.name, e.compound);
          if (f) console.log("[autoTrader] Replacement committed in " + d.name + ": " + e.liveReplacement.compound + " -> forward " + e.compound + ".");
          marketEconomics.link(n, "marketLab", a);
           phaseLabAdmission(n, a);
          console.log("[autoTrader] Started forward " + e.reagentA + "+" + e.reagentB + " -> " + e.compound + " (" + e.creditsPerTick.toFixed(3) + " cr/t) in " + d.name + " [" + n + "]");
          o.push({
            type: "forward",
            compound: e.compound,
            room: d.name,
            expectedCreditsPerTick: e.creditsPerTick,
            expectedNetProfit: e.expectedNetProfit,
            expectedElapsedTicks: e.expectedElapsedTicks,
            reagentAPrice: e.reagentAPrice,
            reagentBPrice: e.reagentBPrice,
            opId: a,
            jobId: n,
            tick: Game.time
          });
        }
      }
      s[u] = true;
      if (e.type === "reverse") n++; else i++;
      if (!f) r.splice(l, 1);
    }
  }
  flushRefusals();
  if (ENABLE_FACTORY_JOBS || ENABLE_FACTORY_DECOMPRESSION) {
    for (var S = 0; S < e.factory.length && a < MAX_FACTORY_JOBS; S++) {
      let r = e.factory[S];
      if (r.isDecompress && !ENABLE_FACTORY_DECOMPRESSION) continue;
      if (!r.isDecompress && !r.isLocalRefine && !ENABLE_FACTORY_JOBS) continue;
      const n = getEligibleFactoryRooms(r.product);
      if (n.length === 0) {
        const e = getRoomState.ownedNames();
        const t = [];
        for (var y = 0; y < e.length; y++) {
          var h = e[y];
          if (canRoomProduceProduct(h, r.product) && getRoomActiveFactoryCount(h) >= MAX_FACTORY_OPS_PER_ROOM) t.push(h);
        }
        const o = r.isDecompress ? " [decomp]" : "";
        console.log("[autoTrader] Skipped " + r.product + o + " (" + (typeof r.creditsPerTick === "number" ? r.creditsPerTick.toFixed(3) + " cr/t" : "n/a") + "): " + (t.length > 0 ? "rooms busy - " + t.join(", ") : "no eligible rooms"));
        continue;
      }
      let i = n[0];
      for (var O = 0; O < n.length; O++) {
        if (n[O].name === r.plannedRoom) {
          i = n[O];
          break;
        }
      }
      if (r.scoredRoom !== i.name) {
        r = scoreOpportunity(r, i);
        r.scoredRoom = i.name;
      }
      if (!r.breakEven) {
        bufferRefusal("marketRefine", r.product, i.name, "not break-even at selected room price", r.creditsPerTick);
        continue;
      }
      if (!meetsStartProfitThreshold(r)) {
        bufferRefusal("marketRefine", r.product, i.name, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold at selected room price", r.creditsPerTick);
        continue;
      }
      if (!t) {
        const e = LOCAL_REFINE_PRODUCTS.indexOf(r.product) >= 0;
        if (e) {
          const e = getRoomStorageEnergy(i.name);
          const t = e - LOCAL_REFINE_ENERGY_RESERVE;
          if (t < 1e3) continue;
          const n = COMMODITIES && COMMODITIES[r.product];
          const a = n && n.components ? n.components[RESOURCE_ENERGY] : null;
          if (!(typeof a === "number" && isFinite(a) && a > 0)) {
            bufferRefusal("localRefine", r.product, i.name, "missing valid energy component in COMMODITIES recipe", r.creditsPerTick);
            continue;
          }
          const s = Math.floor(t / a) * a;
          if (!(typeof s === "number" && isFinite(s) && s > 0)) {
            bufferRefusal("localRefine", r.product, i.name, "no valid refine amount from current energy and COMMODITIES recipe", r.creditsPerTick);
            continue;
          }
          const c = recipeExpectedOutput(r.product, s, RESOURCE_ENERGY);
          if (!(typeof c === "number" && isFinite(c) && c > 0)) {
            bufferRefusal("localRefine", r.product, i.name, "could not derive valid output from actual COMMODITIES recipe and refine amount", r.creditsPerTick);
            continue;
          }
          r.expectedOutput = c;
          r = scoreOpportunity(r);
          const u = statusEnergyPrice();
          if (!(u > 0)) {
            bufferRefusal("localRefine", r.product, i.name, "marketBuy energy opportunity price unavailable or invalid", r.creditsPerTick);
            continue;
          }
          let l = null;
          try {
            if (marketSeller && typeof marketSeller.computeLiquidationPrice === "function") {
              l = marketSeller.computeLiquidationPrice(r.product, c, i.name);
            }
          } catch (e) {}
          if (!(typeof l === "number" && isFinite(l) && l > 0)) {
            bufferRefusal("localRefine", r.product, i.name, "battery liquidation price unavailable or invalid", r.creditsPerTick);
            continue;
          }
          const p = Math.max(.05, pricing.FEE);
          const d = c * l * (1 - p);
          if (!(typeof d === "number" && isFinite(d) && d > 0)) {
            bufferRefusal("localRefine", r.product, i.name, "battery liquidation proceeds invalid after market fee", r.creditsPerTick);
            continue;
          }
          const f = s * u;
          const m = Math.max(.001, d * .01);
          if (!(typeof f === "number" && isFinite(f) && d > f + m)) {
            bufferRefusal("localRefine", r.product, i.name, "energy opportunity cost " + f.toFixed(3) + " exceeds post-fee battery liquidation proceeds " + d.toFixed(3) + " including margin " + m.toFixed(3), r.creditsPerTick);
            continue;
          }
          if (!r.breakEven) {
            bufferRefusal("localRefine", r.product, i.name, "not break-even at actual size", r.creditsPerTick);
            continue;
          }
          if (!meetsStartProfitThreshold(r)) {
            bufferRefusal("localRefine", r.product, i.name, "below " + MIN_START_CREDITS_PER_TICK + " cr/t start threshold at actual size", r.creditsPerTick);
            continue;
          }
          const g = marketEconomics.mintJobId();
          marketEconomics.start(g, {
            kind: "factoryLocal",
            room: i.name,
            product: r.product,
            inputs: [ RESOURCE_ENERGY ],
            outputs: [ r.product ],
            expectedNetProfit: r.expectedNetProfit,
            expectedElapsedTicks: r.expectedElapsedTicks,
            expectedCreditsPerTick: r.creditsPerTick
          });
          marketEconomics.phase(g, "queued");
          try {
            const e = statusEnergyPrice() || 0;
            if (e > 0 && s > 0) {
              marketEconomics.recordOwnedOpportunity(g, RESOURCE_ENERGY, s, s * e);
            }
          } catch (e) {}
          const R = localRefine.start(i.name, r.product, s, {
            jobId: g
          });
          let E = null;
          if (typeof R === "string") {
            var v = R.match(/Started (lref_[^\s|]+)/);
            if (v) E = v[1];
          }
          if (!E) {
            marketEconomics.finish(g, "refused", "" + R);
            bufferRefusal("localRefine", r.product, i.name, R, r.creditsPerTick);
            continue;
          }
          marketEconomics.link(g, "localRefine", E);
          marketEconomics.phase(g, "producing");
          console.log("[autoTrader] Started " + r.product + " via localRefine (" + r.creditsPerTick.toFixed(3) + " cr/t) in " + i.name + " (" + s + " energy) [" + g + "/" + E + "]");
          o.push({
            type: "factory",
            product: r.product,
            room: i.name,
            expectedCreditsPerTick: r.creditsPerTick,
            expectedNetProfit: r.expectedNetProfit,
            expectedElapsedTicks: r.expectedElapsedTicks,
            level: r.requiredLevel,
            method: "localRefine",
            localRefineOpId: E,
            jobId: g,
            amount: s,
            tick: Game.time
          });
        } else {
          const e = r.inputPrices;
          if (!e) {
            bufferRefusal("marketRefine", r.product, i.name, "break-even input ceiling no longer achievable", r.creditsPerTick);
            continue;
          }
          const t = marketEconomics.mintJobId();
          marketEconomics.start(t, {
            kind: "factoryMarket",
            room: i.name,
            product: r.product,
            outputs: [ r.product ],
            expectedNetProfit: r.expectedNetProfit,
            expectedElapsedTicks: r.expectedElapsedTicks,
            expectedCreditsPerTick: r.creditsPerTick
          });
          marketEconomics.phase(t, "queued");
          const n = {
            jobId: t
          };
          if (r.batchMode) {
            n.batchMode = true;
            n.batchPurchases = r.batchPurchases;
            n.batchInputAmounts = {};
            for (var b = 0; b < r.batchPurchases.length; b++) {
              const e = r.batchPurchases[b];
              n.batchInputAmounts[e.resource] = e.amount;
            }
          }
          const a = marketRefine.start(i.name, r.product, e, n);
          const s = typeof a === "string" ? a.match(/Started (mref_[^\s|]+)/) : null;
          const c = !s;
          if (c) {
            marketEconomics.finish(t, "refused", "" + a);
            bufferRefusal("marketRefine", r.product, i.name, a, r.creditsPerTick);
            continue;
          }
          marketEconomics.link(t, "marketRefine", s[1]);
          const u = COMMODITIES && COMMODITIES[r.product];
          const l = u && u.components ? (u.components[RESOURCE_ENERGY] || 0) * MARKET_REFINE_BATCH_MULTIPLIER : 0;
          if (l > 0 && r.product !== RESOURCE_BATTERY) {
            const e = statusEnergyPrice() || 0;
            if (e > 0) marketEconomics.recordOwnedOpportunity(t, RESOURCE_ENERGY, l, l * e);
          }
          marketEconomics.phase(t, "buying");
          const p = r.requiredLevel > 0 ? " [L" + r.requiredLevel + "]" : "";
          const d = r.isDecompress ? " [decomp]" : "";
          const f = [];
          for (var T in e) f.push(T + ":" + (e[T] > 0 ? e[T].toFixed(3) : "N/A"));
          console.log("[autoTrader] Started " + r.product + p + d + " (" + r.creditsPerTick.toFixed(3) + " cr/t) in " + i.name + " (max " + f.join(", ") + ") [" + t + "/" + s[1] + "]");
          o.push({
            type: "factory",
            product: r.product,
            room: i.name,
            expectedCreditsPerTick: r.creditsPerTick,
            expectedNetProfit: r.expectedNetProfit,
            expectedElapsedTicks: r.expectedElapsedTicks,
            level: r.requiredLevel,
            isDecompress: r.isDecompress,
            marketRefineOpId: s[1],
            jobId: t,
            maxInputPrices: e,
            tick: Game.time
          });
        }
      }
      a++;
    }
  }
  flushRefusals();
  flushRefusedChoices();
  o.refusals = p.slice(-10);
  return o;
}

function findActiveJobEntry(e, t, r, o) {
  const n = e[t] || [];
  for (var i = 0; i < n.length; i++) {
    if (r && n[i].id === r) return n[i];
    if (!r && n[i].room === o) return n[i];
  }
  return null;
}

function findOutcome(e, t, r, o, n) {
  if (!e) return null;
  if (t && !Array.isArray(e) && e[t]) return e[t];
  const i = Array.isArray(e) ? e : Object.keys(e).map(function(t) {
    return e[t];
  }).sort(function(e, t) {
    return (e.tick || 0) - (t.tick || 0);
  });
  for (var a = i.length - 1; a >= 0; a--) {
    const e = i[a];
    if (!e) continue;
    if (t && e.id === t) return e;
    if (!t && e.room === r && e.output === o && e.started >= n) return e;
  }
  return null;
}

function outcomeStage(e) {
  if (!e) return " [unknown]";
  if (e.status === "failed" || e.status === "refused") return " [FAILED: " + (e.reason || "no reason recorded") + "]";
  if (e.status === "cancelled") return " [CANCELLED: " + (e.reason || "no reason recorded") + "]";
  return " [done]";
}

function economicsOutcomeStage(e) {
  if (!e || !e.jobId || !marketEconomics || typeof marketEconomics.get !== "function") return null;
  var t = marketEconomics.get(e.jobId);
  if (!t || !t.status || t.status === "active" || t.status === "selling") return null;
  return outcomeStage({
    status: t.status,
    reason: t.reason
  });
}

function renderJobLines(e, t, r, o, n, i) {
  const a = [];
  for (var s = 0; s < e.length; s++) {
    const l = e[s];
    const p = l.type === "reverse" || l.type === "forward" ? l.compound : l.product;
    const d = l.level > 0 ? " [L" + l.level + "]" : "";
    const f = l.method === "localRefine" ? " [local]" : l.isDecompress ? " [decomp]" : "";
    const m = l.maxPrice ? " @" + l.maxPrice.toFixed(2) : "";
    const g = l.amount ? " (" + l.amount + ")" : "";
    const R = ticksToTimeAgo(Game.time - l.tick);
    let E = true;
    for (var c = r + s + 1; c < t.length; c++) {
      const e = t[c];
      const r = e.type === "reverse" || e.type === "forward" ? e.compound : e.product;
      if (e.type === l.type && r === p) {
        E = false;
        break;
      }
    }
    let S = "";
    if (l.status === "failed") {
      S = " [FAILED: " + (l.reason || "no reason recorded") + "]";
    } else if (l.status === "cancelled") {
      S = " [CANCELLED: " + (l.reason || "no reason recorded") + "]";
    } else if (l.status === "completed" || l.status === "done") {
      S = " [done]";
    } else if (l.type === "factory" && l.refused) {
      S = " [REFUSED: " + l.refused + "]";
    } else if (l.type === "factory" && l.method !== "localRefine") {
      const e = findActiveJobEntry(i, l.product, l.marketRefineOpId, l.room);
      if (e) {
        S = " [" + (e.displayPhase || e.phase) + "]";
      } else if (!l.marketRefineOpId && !E) {
        S = " [superseded]";
      } else {
        S = economicsOutcomeStage(l) || " [unknown]";
        const e = marketRefine && typeof marketRefine.getOutcomes === "function" ? marketRefine.getOutcomes() : [];
        const t = findOutcome(e, l.marketRefineOpId, l.room, l.product, l.tick);
        if (t) S = outcomeStage(t);
      }
    } else if (!l.opId && !l.localRefineOpId && !E) {
      S = " [done]";
    } else if (l.type === "reverse") {
      const e = findActiveJobEntry(o, l.compound, l.opId, l.room);
      S = e ? " [" + (e.displayPhase || e.state) + "]" : economicsOutcomeStage(l) || " [done]";
    } else if (l.type === "forward") {
      const e = findActiveJobEntry(n, l.compound, l.opId, l.room);
      S = e ? " [" + (e.displayPhase || e.state) + "]" : economicsOutcomeStage(l) || " [done]";
    } else if (l.type === "factory" && l.method === "localRefine") {
      const e = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
      const t = localRefine && typeof localRefine.getOutcomes === "function" ? localRefine.getOutcomes() : [];
      const r = findOutcome(t, l.localRefineOpId, l.room, l.product, l.tick);
      if (l.localRefineOpId) {
        let t = false;
        for (var u = 0; u < e.length; u++) {
          if (e[u] && e[u].id === l.localRefineOpId) {
            S = " [" + getFactoryDisplayPhase(e[u], "localRefine") + "]";
            t = true;
            break;
          }
        }
        if (!t && r) S = outcomeStage(r); else if (!t) S = economicsOutcomeStage(l) || " [unknown]";
      } else {
        const t = e.filter(function(e) {
          return e && e.room === l.room && e.output === l.product;
        });
        if (t.length === 1 && t[0].started <= l.tick) S = " [" + getFactoryDisplayPhase(t[0], "localRefine") + "]"; else if (r) S = outcomeStage(r); else S = economicsOutcomeStage(l) || " [unknown]";
      }
    } else {
      S = " [done]";
    }
    const y = typeof l.expectedCreditsPerTick === "number" ? " (" + l.expectedCreditsPerTick.toFixed(3) + " cr/t)" : "";
    a.push("    [" + R + "] " + l.type + ": " + p + d + f + m + g + " in " + l.room + y + S);
  }
  return a;
}

function countFactoryOpps(e) {
  let t = 0, r = 0;
  for (var o = 0; o < e.length; o++) {
    if (e[o].isDecompress) r++; else t++;
  }
  return {
    compressCount: t,
    decompressCount: r
  };
}

function formatLimitNumber(e) {
  if (typeof e !== "number" || !isFinite(e)) return "n/a";
  const t = e < 0 ? "-" : "";
  const r = Math.abs(e);
  if (r >= 1e9) return t + (r / 1e9).toFixed(2) + "B";
  if (r >= 1e6) return t + (r / 1e6).toFixed(2) + "M";
  if (r >= 1e3) return t + (r / 1e3).toFixed(1) + "K";
  return r % 1 === 0 ? t + String(r) : t + r.toFixed(1);
}

function padLimitValue(e, t) {
  e = String(e);
  while (e.length < t) e = " " + e;
  return e;
}

function getSellLimitsReport(e) {
  if (typeof RESOURCES_ALL === "undefined") return "[autoTrader] RESOURCES_ALL is unavailable.";
  let t = RESOURCES_ALL.slice();
  if (e) {
    const r = e.toLowerCase();
    t = t.filter(function(e) {
      return e.toLowerCase() === r;
    });
    if (t.length === 0) return "[autoTrader] Unknown commodity: " + e;
  }
  const r = {
    listed: {},
    activeLab: {},
    activeFactory: {},
    prospective: {}
  };
  buildCurrentSellAmounts(null, r);
  const o = t.map(function(e) {
    const t = getSellExposureLimit(e);
    t.listed = r.listed[e] || 0;
    t.pipeline = (r.activeLab[e] || 0) + (r.activeFactory[e] || 0);
    t.totalExposure = t.listed + t.pipeline;
    t.utilization = t.cap > 0 ? t.totalExposure / t.cap * 100 : 0;
    t.headroom = t.cap - t.totalExposure;
    return t;
  });
  o.sort(function(e, t) {
    return t.utilization - e.utilization || t.totalExposure - e.totalExposure || t.cap - e.cap || (t.medianDailyVolume || 0) - (e.medianDailyVolume || 0) || e.resource.localeCompare(t.resource);
  });
  const n = marketSales && typeof marketSales.getSnapshot === "function" ? marketSales.getSnapshot() : null;
  const i = n && n.ours ? Object.keys(n.ours).length : 0;
  const a = n && n.d ? n.d : "never";
  const s = [ "[autoTrader] Liquidity-Based Sell Exposure Limits", "Cap = " + (SELL_LIQUIDITY_SHARE * 100).toFixed(0) + "% of median daily volume over up to " + SELL_LIQUIDITY_DAYS + " completed days, clamped to " + MIN_SELL_EXPOSURE + "-" + MAX_SELL_EXPOSURE + ".", "When our share of flow >= " + (OUR_SHARE_SOFT_MAX * 100).toFixed(0) + "%, cap shrinks to yesterday's sold units (sales snapshot).", "Fewer than " + MIN_SELL_HISTORY_DAYS + " completed history days uses the " + MIN_SELL_EXPOSURE + "-unit floor.", "Exposure = listed sell orders + uncovered active lab/factory output. Sorted by utilization.", "Our-sales snapshot: " + a + " (" + i + " commodities; n/a means no snapshot yet - populated at next midnight-PT rollover).", "", "Commodity           Days   Median/day      Cap   Listed  Pipeline    Total     Use  Headroom  Ours/d   Share  Basis" ];
  for (var c = 0; c < o.length; c++) {
    const e = o[c];
    let t;
    if (e.ourShareShrunkCap) t = "our sales"; else if (e.sparseHistory) t = "floor (sparse history)"; else if (e.cap === MAX_SELL_EXPOSURE) t = "ceiling"; else if (e.cap === MIN_SELL_EXPOSURE) t = "floor (low volume)"; else t = "volume";
    const r = e.ourShare == null ? "n/a" : (e.ourShare * 100).toFixed(1) + "%";
    const n = e.ourDailySold == null ? "-" : formatLimitNumber(e.ourDailySold);
    s.push((e.resource + Array(21).join(" ")).slice(0, 19) + padLimitValue(e.historyDays, 5) + " " + padLimitValue(formatLimitNumber(e.medianDailyVolume), 12) + " " + padLimitValue(e.cap, 8) + "  " + padLimitValue(formatLimitNumber(e.listed), 7) + "  " + padLimitValue(formatLimitNumber(e.pipeline), 8) + "  " + padLimitValue(formatLimitNumber(e.totalExposure), 7) + "  " + padLimitValue(e.utilization.toFixed(1) + "%", 7) + "  " + padLimitValue(formatLimitNumber(e.headroom), 8) + "  " + padLimitValue(n, 7) + "  " + padLimitValue(r, 7) + "  " + t);
  }
  return s.join("\n");
}

function getStatus() {
  const e = ensureMemory();
  const t = [];
  t.push("[autoTrader] Status");
  t.push("  Enabled: " + (e.enabled ? "YES" : "NO"));
  t.push("  Lab jobs: " + (ENABLE_LAB_JOBS ? "ON" : "OFF") + " (max " + MAX_LAB_OPS_PER_ROOM + " pre-sale ops/room, SELLING excluded, 1 processing)");
  t.push("  Factory compression: " + (ENABLE_FACTORY_JOBS ? "ON" : "OFF"));
  t.push("  Factory decompression: " + (ENABLE_FACTORY_DECOMPRESSION ? "ON" : "OFF"));
  t.push("  Owned mineral routing: ON (demand reserve, sell caps, then profitability)");
  const r = autoTraderSellPolicy.getFloor(null);
  t.push("  Sell price floor: " + (r > 0 ? r.toFixed(3) + " default" : "disabled by default") + " (edit autoTraderSellPolicy.js)");
  const o = [];
  const n = autoTraderSellPolicy.SELL_PRICE_FLOORS || {};
  for (var i in n) {
    const e = autoTraderSellPolicy.getFloor(i);
    if (e > 0) o.push(i + "=" + e.toFixed(3));
  }
  if (o.length > 0) t.push("  Resource floor overrides: " + o.join(", "));
  t.push("  Banned factory products: " + (BANNED_FACTORY_PRODUCTS.length > 0 ? BANNED_FACTORY_PRODUCTS.join(", ") : "none"));
  t.push("  Run interval: " + RUN_INTERVAL + " ticks");
  t.push("  Last run: " + (e.lastRun ? Game.time - e.lastRun + " ticks ago (tick " + e.lastRun + ")" : "never"));
  t.push("  Last attempt: " + (e.lastAttempt ? Game.time - e.lastAttempt + " ticks ago (tick " + e.lastAttempt + ")" : "never"));
  if (e.lastError) {
    t.push("  Last error: " + (e.lastError.message || e.lastError));
  }
  t.push("  Next run in: " + (e.lastRun ? Math.max(0, RUN_INTERVAL - (Game.time - e.lastRun)) + " ticks" : "immediately"));
  t.push("");
  t.push("  Admission: expected net profit must remain positive after modeled order fees");
  t.push("  Sell exposure cap: " + (SELL_LIQUIDITY_SHARE * 100).toFixed(0) + "% of median daily volume over up to " + SELL_LIQUIDITY_DAYS + " completed days");
  t.push("  Sell exposure cap range: " + MIN_SELL_EXPOSURE + "-" + MAX_SELL_EXPOSURE + " (minimum " + MIN_SELL_HISTORY_DAYS + " history days)");
  t.push("  Ranking: expected end-to-end credits per tick; posted-order fees included");
  t.push("  Max reverse reactions per cycle: " + MAX_REVERSE_REACTIONS);
  t.push("  Max forward reactions per cycle: " + MAX_FORWARD_REACTIONS);
  t.push("  Max factory jobs per cycle: " + MAX_FACTORY_JOBS + " (shared: compression + decompression)");
  t.push("  Factory jobs: max " + MAX_FACTORY_OPS_PER_ROOM + " pre-sale ops/room, SELLING excluded, 1 processing");
  t.push("  localRefine products: " + LOCAL_REFINE_PRODUCTS.join(", "));
  t.push("  localRefine energy reserve: " + LOCAL_REFINE_ENERGY_RESERVE);
  const a = getFactoryLevelSummary();
  const s = [];
  for (var c = 0; c <= 5; c++) {
    if (a[c] > 0) s.push("L" + c + ":" + a[c]);
  }
  if (s.length > 0) t.push("  Available factories: " + s.join(", "));
  if (e.lastAnalysis) {
    t.push("");
    t.push("  Last analysis (tick " + e.lastAnalysis.tick + "):");
    t.push("    Reverse opportunities:    " + e.lastAnalysis.reverseCount);
    t.push("    Forward opportunities:    " + e.lastAnalysis.forwardCount);
    t.push("    Compress opportunities:   " + (e.lastAnalysis.compressCount || 0));
    t.push("    Decompress opportunities: " + (e.lastAnalysis.decompressCount || 0));
  }
  if (e.lastRefusals && e.lastRefusals.length > 0) {
    t.push("");
    t.push("  Last execution refusals:");
    for (var u = 0; u < Math.min(3, e.lastRefusals.length); u++) {
      const r = e.lastRefusals[u];
      t.push("    " + r.op + ":" + r.compound + " in " + r.room + " - " + r.reason);
    }
  }
  if (e.jobsStarted && e.jobsStarted.length > 0) {
    const r = getActiveReverseReactions();
    const o = getActiveForwardReactions();
    const n = getActiveFactoryJobs();
    const i = e.jobsStarted;
    const a = i.slice(-10);
    const s = i.length - a.length;
    t.push("");
    t.push("  Recent jobs started (last 10 of " + i.length + "; use autoTrader('history') for all):");
    const c = renderJobLines(a, i, s, r, o, n);
    for (var l = 0; l < c.length; l++) t.push(c[l]);
  }
  return t.join("\n");
}

global.showAllProduction = getProcessingProductionReport;
global.autoTrader = function(e) {
  if (e === "passiveScan") return passiveFactoryScanReport();
  if (e === "passiveScanJSON") return passiveFactoryScanJSON();
  if (e === "pipelines") return formatFullPipelineDiagnostic(fullPipelineDiagnostic());
  if (e === "pipelinesJSON") return JSON.stringify(fullPipelineDiagnostic());
  const t = ensureMemory();
  getRoomState.init();
  if (!e) return getStatus();
  if (e === "enable") {
    t.enabled = true;
    requestSave();
    return "[autoTrader] Enabled automatic runs.";
  }
  if (e === "disable") {
    t.enabled = false;
    requestSave();
    return "[autoTrader] Disabled automatic runs.";
  }
  if (e === "reset") {
    Memory.autoTrader = null;
    ensureMemory();
    requestSave();
    return "[autoTrader] Memory reset.";
  }
  if (typeof e === "string" && (e === "limits" || e.indexOf("limits ") === 0)) {
    return getSellLimitsReport(e === "limits" ? null : e.slice(7).trim() || null);
  }
  if (typeof e === "string" && e.indexOf("clearCooldown") === 0) {
    const n = e.split(" ")[1];
    if (!n) return '[autoTrader] Usage: autoTrader("clearCooldown composite")';
    const i = n.toLowerCase();
    let a = 0;
    if (t.jobsStarted) {
      for (var r = t.jobsStarted.length - 1; r >= 0; r--) {
        const e = t.jobsStarted[r];
        if (e.type === "factory" && e.product && e.product.toLowerCase().indexOf(i) >= 0) {
          t.jobsStarted.splice(r, 1);
          a++;
        }
      }
    }
    let s = 0;
    if (t.factoryCooldowns) {
      for (var o in t.factoryCooldowns) {
        if (o.toLowerCase().indexOf(i) >= 0) {
          delete t.factoryCooldowns[o];
          s++;
        }
      }
    }
    if (a > 0 || s > 0) requestSave();
    return "[autoTrader] Cleared " + s + " cooldown(s) and " + a + ' history job(s) matching "' + n + '".';
  }
  if (typeof e === "string" && (e === "rooms" || e.indexOf("rooms ") === 0)) {
    return getRoomsReport(e === "rooms" ? null : e.slice(6).trim() || null);
  }
  if (e === "active") return getActiveReport();
  if (e === "history") {
    if (!t.jobsStarted || t.jobsStarted.length === 0) return "[autoTrader] No job history recorded.";
    const e = getActiveReverseReactions();
    const r = getActiveForwardReactions();
    const o = getActiveFactoryJobs();
    const i = t.jobsStarted;
    const a = [ "[autoTrader] Full Job History (" + i.length + " of max " + JOBS_HISTORY_CAP + "):", "" ];
    const s = renderJobLines(i, i, 0, e, r, o);
    for (var n = 0; n < s.length; n++) a.push(s[n]);
    return a.join("\n");
  }
  if (e === "analyze") {
    const e = runAnalysis(null, true);
    const r = countFactoryOpps(e.factory);
    t.lastAnalysis = {
      tick: Game.time,
      reverseCount: e.reverse.length,
      forwardCount: e.forward.length,
      compressCount: r.compressCount,
      decompressCount: r.decompressCount
    };
    requestSave();
    const o = [ "[autoTrader] Analysis Results (expected net profit > 0; ranked by credits/tick):", "" ];
    const n = [];
    if (!ENABLE_LAB_JOBS) n.push("lab jobs");
    if (!ENABLE_FACTORY_JOBS) n.push("factory compression");
    if (!ENABLE_FACTORY_DECOMPRESSION) n.push("factory decompression");
    if (n.length > 0) {
      o.push("NOTE: " + n.join(", ") + " disabled");
      o.push("");
    }
    if (BANNED_FACTORY_PRODUCTS.length > 0) {
      o.push("NOTE: banned factory products: " + BANNED_FACTORY_PRODUCTS.join(", "));
      o.push("");
    }
    const T = getFactoryLevelSummary();
    const P = [];
    for (var i = 0; i <= 5; i++) {
      if (T[i] > 0) P.push("L" + i + ":" + T[i]);
    }
    if (P.length > 0) {
      o.push("Available factories: " + P.join(", "));
      o.push("");
    }
    if (e.reverse.length > 0) {
      o.push("NEW Reverse Reactions:");
      for (var a = 0; a < Math.min(10, e.reverse.length); a++) {
        const t = e.reverse[a];
        o.push("  " + t.compound + (t.compoundPrice > 0 ? " @" + t.compoundPrice.toFixed(2) : " (no external price)") + " -> " + t.reagentA + " + " + t.reagentB + " | " + (typeof t.creditsPerTick === "number" ? t.creditsPerTick.toFixed(3) : "n/a") + " cr/t");
      }
      if (e.reverse.length > 10) o.push("  ... and " + (e.reverse.length - 10) + " more");
    } else {
      o.push("NEW Reverse Reactions: None" + (!ENABLE_LAB_JOBS ? " (disabled)" : ""));
    }
    o.push("");
    if (e.forward.length > 0) {
      o.push("NEW Forward Reactions:");
      for (var s = 0; s < Math.min(10, e.forward.length); s++) {
        const t = e.forward[s];
        const r = " (buy " + t.reagentA + "@" + (t.reagentAPrice > 0 ? t.reagentAPrice.toFixed(2) : "N/A") + " + " + t.reagentB + "@" + (t.reagentBPrice > 0 ? t.reagentBPrice.toFixed(2) : "N/A") + ")";
        o.push("  " + t.reagentA + " + " + t.reagentB + " -> " + t.compound + r + " | " + (typeof t.creditsPerTick === "number" ? t.creditsPerTick.toFixed(3) : "n/a") + " cr/t");
      }
      if (e.forward.length > 10) o.push("  ... and " + (e.forward.length - 10) + " more");
    } else {
      o.push("NEW Forward Reactions: None" + (!ENABLE_LAB_JOBS ? " (disabled)" : ""));
    }
    o.push("");
    const C = e.factory.filter(function(e) {
      return !e.isDecompress;
    });
    if (C.length > 0) {
      o.push("NEW Factory Compression:");
      for (var c = 0; c < C.length; c++) {
        const e = C[c];
        o.push("  " + e.product + (e.requiredLevel > 0 ? " [L" + e.requiredLevel + "]" : " [L0]") + (e.isLocalRefine ? " [local]" : "") + " | " + (typeof e.creditsPerTick === "number" ? e.creditsPerTick.toFixed(3) : "n/a") + " cr/t");
      }
    } else {
      o.push("NEW Factory Compression: None" + (!ENABLE_FACTORY_JOBS ? " (disabled)" : ""));
    }
    o.push("");
    const A = e.factory.filter(function(e) {
      return e.isDecompress;
    });
    if (A.length > 0) {
      o.push("NEW Factory Decompression:");
      for (var u = 0; u < A.length; u++) {
        const e = A[u];
        const t = COMMODITIES[e.product] && COMMODITIES[e.product].components ? COMMODITIES[e.product].components : {};
        const r = Object.keys(t).filter(function(e) {
          return e !== RESOURCE_ENERGY;
        })[0] || "?";
        o.push("  " + r + " -> " + e.product + " [L0] | " + (typeof e.creditsPerTick === "number" ? e.creditsPerTick.toFixed(3) : "n/a") + " cr/t");
      }
    } else {
      o.push("NEW Factory Decompression: None" + (!ENABLE_FACTORY_DECOMPRESSION ? " (disabled)" : ""));
    }
    o.push("");
    if (e.twoStep && e.twoStep.length > 0) {
      o.push("TWO-STEP QUEUE / DISCOVERY:");
      for (var l = 0; l < Math.min(10, e.twoStep.length); l++) {
        const t = e.twoStep[l];
        o.push("  " + renderTwoStepChain(t) + " | " + t.creditsPerTick.toFixed(3) + " cr/t | net " + t.expectedNetProfit.toFixed(0) + " | " + t.expectedElapsedTicks.toFixed(0) + " ticks");
      }
      o.push("  Intermediate sell-cap is excluded; only final outputs and residual coproducts are capped.");
    } else if (e.twoStepDeferred) {
      o.push("TWO-STEP DISCOVERY: Deferred (CPU emergency; scan not run this tick)");
    } else if (e.twoStep && e.twoStep.breakdownStats && e.twoStep.breakdownStats.considered > 0) {
      const t = e.twoStep.breakdownStats;
      o.push("TWO-STEP DISCOVERY: None (scan completed; no linear candidates; recursive breakdowns considered " + t.considered + ", profitable " + t.profitable + ", sell-cap blocked " + t.sellBlocked + ")");
    } else {
      o.push("TWO-STEP DISCOVERY: None (scan completed; no candidates found)");
    }
    o.push("");
    if (e.skippedReverse.length > 0) {
      o.push("ALREADY PROCESSING Reverse:");
      for (var p = 0; p < e.skippedReverse.length; p++) {
        var d = e.skippedReverse[p];
        o.push("  " + d.compound + " @ " + (typeof d.score === "number" ? d.score.toFixed(3) + " cr/t" : "N/A") + " - in " + d.room + " (" + d.state + ")");
      }
    }
    if (e.skippedForward.length > 0) {
      o.push("ALREADY PROCESSING Forward:");
      for (var f = 0; f < e.skippedForward.length; f++) {
        var m = e.skippedForward[f];
        o.push("  " + m.compound + " @ " + (typeof m.score === "number" ? m.score.toFixed(3) + " cr/t" : "N/A") + " - in " + m.room + " (" + m.state + ")");
      }
    }
    if (e.skippedFactory.length > 0) {
      o.push("ALREADY PROCESSING Factory:");
      for (var g = 0; g < e.skippedFactory.length; g++) {
        const t = e.skippedFactory[g];
        o.push("  " + t.product + (t.requiredLevel > 0 ? " [L" + t.requiredLevel + "]" : "") + (t.isDecompress ? " [decomp]" : "") + " @ " + (typeof t.score === "number" ? t.score.toFixed(3) + " cr/t" : "N/A") + " - in " + t.room + " (" + t.phase + ")");
      }
    }
    if (e.skippedSellLimit && e.skippedSellLimit.length > 0) {
      o.push("");
      o.push("SKIPPED (liquidity-based sell exposure limit):");
      for (var R = 0; R < e.skippedSellLimit.length; R++) {
        var E = e.skippedSellLimit[R];
        var S = E.exposure;
        var y = S ? " | " + (E.resource || E.compound) + ": cap " + S.cap + "; listed " + S.listed + ", active lab " + S.activeLab + ", active factory " + S.activeFactory + ", selected " + S.prospective + ", candidate " + S.projected + ", projected total " + S.projectedTotal : "";
        o.push("  " + E.compound + " @ " + (typeof E.score === "number" ? E.score.toFixed(3) + " cr/t" : "N/A") + " - " + E.reason + y);
      }
    }
    if (e.unbackedSellOrders && e.unbackedSellOrders.length > 0) {
      const t = {};
      for (var h = 0; h < e.unbackedSellOrders.length; h++) {
        const r = e.unbackedSellOrders[h];
        const o = r.resource + " in " + r.room;
        if (!t[o]) t[o] = {
          amount: 0,
          backed: 0,
          count: 0
        };
        t[o].amount += r.amount;
        t[o].backed += r.backedAmount || 0;
        t[o].count++;
      }
      o.push("");
      o.push("UNBACKED LIVE SELL ORDERS (diagnostic only; not counted toward sell limit):");
      for (var O in t) {
        const e = t[O];
        o.push("  " + O + " - " + e.amount + " unbacked" + (e.backed > 0 ? " (" + e.backed + " backed)" : "") + " across " + e.count + " order(s)");
      }
    }
    if (e.skippedChoices && e.skippedChoices.length > 0) {
      o.push("");
      o.push("TOP SKIPPED/REJECTED:");
      for (var v = 0; v < Math.min(5, e.skippedChoices.length); v++) {
        const t = e.skippedChoices[v];
        const r = typeof t.score === "number" ? t.score.toFixed(3) + " cr/t" : "N/A";
        o.push("  " + t.kind + " " + t.direction + " " + t.name + " @ " + r + " - " + t.reason);
      }
    }
    const _ = recheckActiveJobs(true);
    if (_.length > 0) {
      o.push("");
      o.push("WOULD CANCEL (no longer break-even while still buying):");
      for (var b = 0; b < _.length; b++) {
        const e = _[b];
        const t = typeof e.creditsPerTick === "number" ? e.creditsPerTick.toFixed(3) + " cr/t" : "N/A";
        o.push("  " + e.type + ": " + e.key + (e.isDecompress ? " [decomp]" : "") + " in " + e.room + " @ " + t);
      }
    }
    return o.join("\n");
  }
  if (e === "run") {
    console.log("[autoTrader] Manual run triggered at tick " + Game.time);
    runOwnedMineralTrading(t);
    recheckActiveJobs(false);
    const e = runAnalysis(null, true);
    const o = countFactoryOpps(e.factory);
    t.lastAnalysis = {
      tick: Game.time,
      reverseCount: e.reverse.length,
      forwardCount: e.forward.length,
      compressCount: o.compressCount,
      decompressCount: o.decompressCount
    };
    suppressTwoStepNormalOpportunities(e);
    const n = executeJobs(e, false);
    const i = processTwoStepQueue(t, e.twoStep, false);
    t.lastTwoStepStarted = i;
    t.lastRun = Game.time;
    t.lastRefusals = n.refusals || [];
    if (n.length > 0) {
      if (!t.jobsStarted) t.jobsStarted = [];
      for (var T = 0; T < n.length; T++) t.jobsStarted.push(memoryManager.compactAutoTraderJob(n[T]));
      if (!t.factoryCooldowns) t.factoryCooldowns = {};
      for (var r = 0; r < n.length; r++) {
        if (n[r].type === "factory" && n[r].product) t.factoryCooldowns[n[r].product] = Game.time;
      }
      if (t.jobsStarted.length > JOBS_HISTORY_CAP) t.jobsStarted = t.jobsStarted.slice(-JOBS_HISTORY_CAP);
    }
    requestSave();
    const a = e.twoStep && Array.isArray(e.twoStep) ? e.twoStep.length : 0;
    return "[autoTrader] Run complete. Started " + n.length + " normal job(s) and " + i + " two-step stage(s). " + "Two-step queue candidates: " + a + " (stages are serialized and handoff-gated).";
  }
  return "[autoTrader] Unknown command: " + e + ". Use: run, analyze, passiveScan, passiveScanJSON, active, history, limits [resource], rooms [filter], enable, disable, reset, clearCooldown <product>";
};
global.autoTraderPassiveScan = passiveFactoryScanReport;
global.autoTraderPassiveScanJSON = passiveFactoryScanJSON;
function parseMarketCommandArgs(e, t) {
  const r = typeof t === "string" && t.trim() ? t.trim() : null;
  if (!e || e === "compact" || e === "expanded") {
    return {
      view: e === "expanded" ? "expanded" : "compact",
      resourceType: null,
      roomName: r
    };
  }
  return {
    view: "resource",
    resourceType: e,
    roomName: r
  };
}

function renderMarketOrders(e, t, r, o) {
  const n = parseMarketCommandArgs(r, o);
  let i = t;
  if (n.roomName) {
    i = i.filter(function(e) {
      return e.roomName === n.roomName;
    });
  }
  if (i.length === 0) {
    return n.roomName ? "[" + e + "] No active " + e + " orders in " + n.roomName + "." : "[" + e + "] No active " + e + " orders.";
  }
  if (n.resourceType) {
    const t = i.filter(function(e) {
      return e.resourceType === n.resourceType;
    });
    if (t.length === 0) return "[" + e + "] No " + e + " orders for " + n.resourceType + (n.roomName ? " in " + n.roomName : "");
    const r = [ "[" + e + "] " + n.resourceType + (n.roomName ? " in " + n.roomName : "") + ": " + t.length + " order(s)" ];
    let o = 0, s = 0;
    for (var a = 0; a < t.length; a++) {
      const e = t[a];
      const n = getOrderProgress(e);
      o += n.remaining;
      s += n.original;
      r.push("  " + e.roomName + ": " + n.filled + "/" + n.original + " filled (" + fmtPct(orderFillPct(e)) + ") @ " + e.price.toFixed(3));
    }
    const c = Math.max(0, s - o);
    const u = s > 0 ? c / s * 100 : 0;
    r.push("  Total: " + c + "/" + s + " filled (" + u.toFixed(1) + "%)");
    return r.join("\n");
  }
  const s = n.view === "expanded";
  const c = {};
  for (var u = 0; u < i.length; u++) {
    const e = i[u];
    const t = getOrderProgress(e);
    const r = e.resourceType;
    if (!c[r]) c[r] = {
      orders: [],
      remaining: 0,
      original: 0
    };
    c[r].orders.push(e);
    c[r].remaining += t.remaining;
    c[r].original += t.original;
  }
  const l = Object.keys(c).sort(function(e, t) {
    return c[t].remaining - c[e].remaining;
  });
  let p = "[" + e + "] " + i.length + " active " + e + " order(s) across " + l.length + " resource(s)";
  if (n.roomName) p += " in " + n.roomName;
  const d = [ p + ":", "" ];
  for (var f = 0; f < l.length; f++) {
    const t = l[f];
    var m = c[t];
    const r = Math.max(0, m.original - m.remaining);
    const o = m.original > 0 ? r / m.original * 100 : 0;
    if (s) {
      d.push(t + ": " + r + "/" + m.original + " filled (" + o.toFixed(1) + "%)");
      for (var g = 0; g < m.orders.length; g++) {
        const e = m.orders[g];
        const t = getOrderProgress(e);
        d.push("  " + e.roomName + ": " + t.filled + "/" + t.original + " filled (" + fmtPct(orderFillPct(e)) + ") @ " + e.price.toFixed(3));
      }
      d.push("");
    } else {
      let n = 0;
      for (var R = 0; R < m.orders.length; R++) n += m.orders[R].price;
      n = n / m.orders.length;
      if (e === "buying") {
        const e = {};
        for (var E = 0; E < m.orders.length; E++) {
          const t = m.orders[E].roomName;
          const r = getOrderProgress(m.orders[E]);
          e[t] = (e[t] || 0) + r.remaining;
        }
        const i = Object.keys(e).sort().map(function(t) {
          return t + " (" + e[t] + ")";
        }).join(", ");
        d.push("  " + t + ": " + r + "/" + m.original + " filled (" + o.toFixed(1) + "%) | " + m.orders.length + " orders | avg " + n.toFixed(3) + " | rooms: " + i);
      } else {
        d.push("  " + t + ": " + r + "/" + m.original + " filled (" + o.toFixed(1) + "%) | " + m.orders.length + " orders | avg " + n.toFixed(3));
      }
    }
  }
  return d.join("\n");
}

global.selling = function(e, t) {
  const r = Game.market.orders;
  const o = [];
  for (var n in r) {
    var i = r[n];
    if (i.type === ORDER_SELL && util.getOrderRemaining(i) > 0) o.push(i);
  }
  return renderMarketOrders("selling", o, e, t);
};
global.buying = function(e, t) {
  const r = Game.market.orders;
  const o = [];
  for (var n in r) {
    var i = r[n];
    if (i.type === ORDER_BUY && util.getOrderRemaining(i) > 0) o.push(i);
  }
  return renderMarketOrders("buying", o, e, t);
};
function isAnalysisDue() {
  if (!ENABLED) return false;
  const e = Memory.autoTrader;
  if (e && e.enabled === false) return false;
  const t = e && e.minerals;
  if (t && (t.lastRunTick === Game.time || t.lastResidueRunTick === Game.time)) return false;
  return !e || !e.lastRun || Game.time - e.lastRun >= RUN_INTERVAL;
}

function isMineralTradingDue() {
  if (!ENABLED) return false;
  const e = Memory.autoTrader && Memory.autoTrader.minerals;
  if (!e || typeof e.lastRunTick !== "number") return true;
  if (Game.time - e.lastRunTick >= MINERAL_RUN_INTERVAL) return true;
  return typeof e.lastDepositCheckTick !== "number" || Game.time - e.lastDepositCheckTick >= DEPOSIT_RUN_INTERVAL;
}

function isResidueSweepDue() {
  if (!ENABLED || isMineralTradingDue()) return false;
  const e = Memory.autoTrader && Memory.autoTrader.minerals;
  if (e && e.lastRunTick === Game.time) return false;
  return !e || typeof e.lastResidueRunTick !== "number" || Game.time - e.lastResidueRunTick >= RESIDUE_RUN_INTERVAL;
}

module.exports = {
  isAnalysisDue: isAnalysisDue,
  isMineralTradingDue: isMineralTradingDue,
  isResidueSweepDue: isResidueSweepDue,
  getStatusSnapshot: getStatusSnapshot,
  recordLabOutcome: recordLabOutcome,
  fullPipelineDiagnostic: fullPipelineDiagnostic,
  runMineralTrading: function() {
    if (!ENABLED) return;
    const e = beginCpuProfile("minerals");
    try {
      labCommodityRouter.process();
      runOwnedMineralTrading(ensureMemory());
    } finally {
      finishCpuProfile(e);
    }
  },
  runResidueSweep: function() {
    if (!ENABLED) return;
    const e = beginCpuProfile("residue");
    try {
      labCommodityRouter.process();
      runCommodityResidueSweep(ensureMemory());
    } finally {
      finishCpuProfile(e);
    }
  },
  run: function() {
    if (!ENABLED || shouldDeferAutoTraderCpu()) return;
    const e = beginCpuProfile("analysis");
    const t = ensureMemory();
    try {
      if (!t.enabled) return;
      labCommodityRouter.process();
      if (t.lastRun && Game.time - t.lastRun < RUN_INTERVAL) return;
      t.lastAttempt = Game.time;
      requestSave();
      getRoomState.init();
      const n = beginCpuPhase(e);
      recheckActiveJobs(false);
      endCpuPhase(e, "recheck", n);
      const i = runAnalysis(e);
      const a = countFactoryOpps(i.factory);
      t.lastAnalysis = {
        tick: Game.time,
        reverseCount: i.reverse.length,
        forwardCount: i.forward.length,
        compressCount: a.compressCount,
        decompressCount: a.decompressCount
      };
      const s = beginCpuPhase(e);
      suppressTwoStepNormalOpportunities(i);
      const c = executeJobs(i, false);
      const u = processTwoStepQueue(t, i.twoStep, false);
      t.lastTwoStepStarted = u;
      endCpuPhase(e, "execute", s);
      t.lastRun = Game.time;
      t.lastRefusals = c.refusals || [];
      t.lastError = null;
      if (c.length > 0) {
        if (!t.jobsStarted) t.jobsStarted = [];
        for (var r = 0; r < c.length; r++) t.jobsStarted.push(memoryManager.compactAutoTraderJob(c[r]));
        if (!t.factoryCooldowns) t.factoryCooldowns = {};
        for (var o = 0; o < c.length; o++) {
          if (c[o].type === "factory" && c[o].product) t.factoryCooldowns[c[o].product] = Game.time;
        }
        if (t.jobsStarted.length > JOBS_HISTORY_CAP) t.jobsStarted = t.jobsStarted.slice(-JOBS_HISTORY_CAP);
      }
      requestSave();
    } catch (e) {
      const r = e && e.stack ? e.stack : String(e);
      t.lastError = {
        tick: Game.time,
        message: r.slice(0, 500)
      };
      requestSave();
      throw e;
    } finally {
      finishCpuProfile(e);
    }
  }
};
