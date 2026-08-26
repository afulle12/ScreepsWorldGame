// LLM: Read docs/codex.js before reviewing or changing this file.
// marketEconomics.js
// Console globals: marketEconomics, marketEconomicsStatus, marketEconomicsJob, marketEconomicsArchiveStatus, marketEconomicsArchiveRetry, marketEconomicsArchivePurgePreview, marketEconomicsRetentionStatus
// Example: marketEconomics('status') - Show market trading profit, turnover, and volume
// Example: marketEconomicsStatus() - Display market economic metrics overview
// Example: marketEconomicsJob() - Trigger periodic market economics accounting job
// Example: marketEconomicsArchiveStatus() - Check status of archived trade history
// Example: marketEconomicsArchiveRetry() - Retry failed trade archive sync
// Example: marketEconomicsArchivePurgePreview() - Preview stale trade archives for purging
// Example: marketEconomicsRetentionStatus() - Display market data retention policies
//   marketEconomicsStatus()           - summary of active/closed jobs
//   marketEconomicsJob(jobId)         - detail for one job
//   marketEconomicsArchivePurgePreview() - preview final archives older than 48 hours
var memoryManager = require("memoryManager");
var util = require("util");
var pricing = require("marketPricing");
var storage = memoryManager.storage;
storage.register("marketEconomics", {
  path: "Memory.marketEconomics",
  owner: "marketEconomics.js",
  mutability: "mutable"
});
var VERSION = 10;
var HOT_CLOSED_JOB_CAP = 20;
var ARCHIVE_VERSION = 1;
var ARCHIVE_KEY_PREFIX = "me.job.v1:";
var SETTLEMENT_BASE_KEY_PREFIX = "me.job.base.v1:";
var ARCHIVE_RETRY_TICKS = 60;
var ARCHIVE_MAX_ATTEMPTS = 3;
var FINAL_ARCHIVE_RETENTION_TICKS = 57600;
var FINAL_ARCHIVE_SCAN_INTERVAL = 10;
var FINAL_ARCHIVE_DELETE_LIMIT = 5;
var ARCHIVE_FAILURE_TTL = 57600;
var ARCHIVE_FAILURE_CAP = 20;
var ARCHIVE_FAILURE_MESSAGE_MAX = 80;
var CLOSED_ORDER_WARN_INTERVAL = 5e3;
var lastClosedOrderWarnTick = 0;
var LEARNING_KEY_CAP = 128;
var ORPHAN_JOB_GRACE_TICKS = 100;
var ORPHAN_RECONCILE_INTERVAL = 30;
var STALE_ORDER_LOT_TICKS = 3e3;
var ORDER_LOT_CLEANUP_INTERVAL = 50;
var BUY_TOMBSTONE_SETTLEMENT_TICKS = 50;
var FEE_KINDS = {
  buyCreate: true,
  buyExtend: true,
  buyReprice: true,
  sellCreate: true,
  sellExtend: true,
  sellReprice: true
};
function getModule(e) {
  try {
    return require(e);
  } catch (e) {
    return null;
  }
}

function getRecords(e, r) {
  var t = getModule(e);
  return t && typeof t[r] === "function" ? t[r]() : [];
}

function roundCredits(e) {
  return Math.round(e || 0);
}

function roundRate(e) {
  return Math.round((e || 0) * 1e3) / 1e3;
}

function ensureMemory() {
  var e = storage.get("marketEconomics");
  if (!e || typeof e !== "object") {
    e = storage.set("marketEconomics", {
      v: VERSION,
      nextId: 1,
      jobs: {},
      settlements: {},
      orderLots: {},
      processedTransactions: {},
      learning: {},
      closedOrder: [],
      archive: {
        v: ARCHIVE_VERSION,
        active: null,
        archived: 0
      }
    });
  }
  if (!e.jobs) e.jobs = {};
  if (!e.settlements) e.settlements = {};
  if (!e.orderLots) e.orderLots = {};
  if (!e.processedTransactions) e.processedTransactions = {};
  if (!e.learning) e.learning = {};
  if (!Array.isArray(e.closedOrder)) e.closedOrder = [];
  if (!e.archive || typeof e.archive !== "object") {
    e.archive = {
      v: ARCHIVE_VERSION,
      active: null,
      archived: 0,
      failures: {}
    };
  }
  if (e.archive.v !== ARCHIVE_VERSION) e.archive.v = ARCHIVE_VERSION;
  if (typeof e.archive.archived !== "number") e.archive.archived = 0;
  if (!e.archive.failures || typeof e.archive.failures !== "object") e.archive.failures = {};
  if (typeof e.v !== "number" || e.v < 1) e.v = 1;
  if (typeof e.nextId !== "number" || e.nextId < 1) e.nextId = 1;
  if (e.v === 8) {
    memoryManager.hydrateMarketEconomicsRoot(e);
    delete e.migration;
    e.v = VERSION;
    memoryManager.requestSave();
  } else if (e.v >= VERSION && e.migration) {
    delete e.migration;
    memoryManager.requestSave();
  }
  return e;
}

function emptyResourceMap() {
  return {};
}

function emptyFees() {
  return {};
}

function emptyTotals() {
  return {};
}

function recomputeTotals(e) {
  if (!e.phase) return e.totals || {};
  var r = e.fees || emptyFees();
  var t = (r.buyCreate || 0) + (r.buyExtend || 0) + (r.buyReprice || 0) + (r.sellCreate || 0) + (r.sellExtend || 0) + (r.sellReprice || 0);
  if (t) r.total = t; else delete r.total;
  e.fees = r;
  var i = 0;
  var a = 0;
  var n = 0;
  for (var o in e.input) {
    if (!e.input.hasOwnProperty(o)) continue;
    var s = e.input[o];
    i += s.buyCredits || 0;
    a += s.ownedOpportunityCredits || 0;
    n += s.transferEnergy || 0;
  }
  var l = 0;
  for (var c in e.output) {
    if (!e.output.hasOwnProperty(c)) continue;
    var u = e.output[c];
    l += u.saleCredits || 0;
    n += u.transferEnergy || 0;
  }
  var d = 0;
  for (var f in e.input) {
    if (e.input.hasOwnProperty(f)) d += e.input[f].transferEnergyCredits || 0;
  }
  for (var m in e.output) {
    if (e.output.hasOwnProperty(m)) d += e.output[m].transferEnergyCredits || 0;
  }
  var v = l - i - t;
  var p = v - d - a;
  var g = null;
  if (typeof e.finishedTick === "number" && typeof e.createdTick === "number") {
    g = Math.max(1, e.finishedTick - e.createdTick);
  }
  var y = {};
  if (i) y.buyCredits = roundCredits(i);
  if (l) y.saleCredits = roundCredits(l);
  if (t) y.feeCredits = roundCredits(t);
  if (n) y.transferEnergy = n;
  if (d) y.transferEnergyCredits = roundCredits(d);
  if (a) y.ownedOpportunityCredits = roundCredits(a);
  if (v) y.realizedNetCredits = roundCredits(v);
  if (p) y.economicNetCredits = roundCredits(p);
  if (g) {
    y.realizedNetCreditsPerTick = roundRate(v / g);
    y.economicNetCreditsPerTick = roundRate(p / g);
  }
  e.totals = y;
  return e.totals;
}

function mintJobId() {
  var e = ensureMemory();
  var r = "at:" + Game.time + ":" + e.nextId;
  e.nextId += 1;
  memoryManager.requestSave();
  return r;
}

function start(e, r) {
  var t = ensureMemory();
  if (!e) e = mintJobId();
  r = r || {};
  if (t.jobs[e]) return t.jobs[e];
  if (t.settlements[e]) return composeSettlement(e, t.settlements[e]);
  if (memoryManager.storage.cold.has(archiveKey(e))) return getArchivedJob(e);
  var i = {
    id: e,
    kind: r.kind || "unknown",
    room: r.room || null,
    product: r.product || null,
    createdTick: Game.time,
    status: "active",
    partial: !!r.partial,
    links: {},
    expected: {},
    phase: {
      current: "queued",
      since: Game.time,
      durations: {}
    },
    input: emptyResourceMap(),
    output: emptyResourceMap(),
    fees: emptyFees(),
    totals: emptyTotals()
  };
  if (!i.partial) delete i.partial;
  if (r.expectedNetProfit != null) i.expected.netCredits = roundCredits(r.expectedNetProfit);
  if (r.expectedElapsedTicks != null) i.expected.elapsedTicks = r.expectedElapsedTicks;
  if (r.expectedCreditsPerTick != null) i.expected.creditsPerTick = roundRate(r.expectedCreditsPerTick);
  t.jobs[e] = memoryManager.compactMarketEconomicsJob(i);
  memoryManager.requestSave();
  return t.jobs[e];
}

function archiveKey(e) {
  return ARCHIVE_KEY_PREFIX + e;
}

function settlementBaseKey(e) {
  return SETTLEMENT_BASE_KEY_PREFIX + e;
}

function cloneJson(e) {
  return e == null ? e : JSON.parse(JSON.stringify(e));
}

function hydrateJobCopy(e, r) {
  if (!e) return null;
  e = cloneJson(e);
  if (Array.isArray(e) && !e[0]) e[0] = r;
  return memoryManager.compactMarketEconomicsJob(e);
}

var INPUT_DELTA_FIELDS = [ "acquired", "buyCredits", "transferEnergy", "transferEnergyCredits", "ownedOpportunityCredits", "consumed" ];
var OUTPUT_DELTA_FIELDS = [ "produced", "sold", "saleCredits", "transferEnergy", "transferEnergyCredits" ];
var FEE_DELTA_FIELDS = [ "buyCreate", "buyExtend", "buyReprice", "sellCreate", "sellExtend", "sellReprice" ];
function numericMapDelta(e, r, t) {
  var i = {};
  var a = {};
  e = e || {};
  r = r || {};
  for (var n in e) a[n] = true;
  for (var o in r) a[o] = true;
  for (var s in a) {
    var l = e[s] || {};
    var c = r[s] || {};
    var u = {};
    for (var d = 0; d < t.length; d++) {
      var f = t[d];
      var m = (l[f] || 0) - (c[f] || 0);
      if (m) u[f] = m;
    }
    if (Object.keys(u).length) i[s] = u;
  }
  return i;
}

function numericRecordDelta(e, r, t) {
  var i = {};
  e = e || {};
  r = r || {};
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    var o = (e[n] || 0) - (r[n] || 0);
    if (o) i[n] = o;
  }
  return i;
}

function settlementBasePayload(e, r) {
  return {
    v: ARCHIVE_VERSION,
    type: "marketEconomics.jobBase",
    id: e,
    job: cloneJson(r)
  };
}

function createSettlement(e, r, t, i) {
  var a = {
    baseKey: i,
    createdTick: r.createdTick,
    status: r.status,
    phase: {
      current: r.phase && r.phase.current,
      since: r.phase && r.phase.since,
      durations: cloneJson(r.phase && r.phase.durations || {})
    },
    links: {
      marketLabOpId: r.links && r.links.marketLabOpId,
      marketRefineOpId: r.links && r.links.marketRefineOpId,
      localRefineOpId: r.links && r.links.localRefineOpId,
      factoryOrderId: r.links && r.links.factoryOrderId
    },
    input: numericMapDelta(r.input, t.input, INPUT_DELTA_FIELDS),
    output: numericMapDelta(r.output, t.output, OUTPUT_DELTA_FIELDS),
    fees: numericRecordDelta(r.fees, t.fees, FEE_DELTA_FIELDS)
  };
  if (r.finishedTick != null) a.finishedTick = r.finishedTick;
  if (r.reason != null) a.reason = r.reason;
  if (r.reconciliation) a.reconciliation = cloneJson(r.reconciliation);
  if (!Object.keys(a.input).length) delete a.input;
  if (!Object.keys(a.output).length) delete a.output;
  if (!Object.keys(a.fees).length) delete a.fees;
  for (var n in a.links) if (a.links[n] == null) delete a.links[n];
  if (!Object.keys(a.links).length) delete a.links;
  return a;
}

function applyMapDelta(e, r, t) {
  if (!r) return;
  for (var i in r) {
    var a = e[i];
    if (!a) e[i] = a = {};
    for (var n = 0; n < t.length; n++) {
      var o = t[n];
      if (r[i][o]) a[o] = (a[o] || 0) + r[i][o];
    }
  }
}

function composeSettlement(e, r) {
  if (!r || !r.baseKey) return null;
  var t = memoryManager.storage.cold.get(r.baseKey);
  if (!t || t.v !== ARCHIVE_VERSION || t.type !== "marketEconomics.jobBase" || t.id !== e || !t.job) return null;
  var i = hydrateJobCopy(t.job, e);
  if (!i) return null;
  i.status = r.status || "selling";
  if (r.phase) i.phase = cloneJson(r.phase);
  if (r.links) i.links = cloneJson(r.links);
  applyMapDelta(i.input, r.input, INPUT_DELTA_FIELDS);
  applyMapDelta(i.output, r.output, OUTPUT_DELTA_FIELDS);
  if (r.fees) {
    for (var a = 0; a < FEE_DELTA_FIELDS.length; a++) {
      var n = FEE_DELTA_FIELDS[a];
      if (r.fees[n]) i.fees[n] = (i.fees[n] || 0) + r.fees[n];
    }
  }
  if (r.finishedTick != null) i.finishedTick = r.finishedTick; else delete i.finishedTick;
  if (r.reason != null) i.reason = r.reason; else delete i.reason;
  if (r.reconciliation) i.reconciliation = cloneJson(r.reconciliation);
  recomputeTotals(i);
  return i;
}

function archivePayload(e, r) {
  return {
    v: ARCHIVE_VERSION,
    type: "marketEconomics.job",
    id: e,
    job: JSON.parse(JSON.stringify(r))
  };
}

function getMutable(e) {
  if (!e) return null;
  var r = ensureMemory();
  return r.jobs[e] || null;
}

function getArchivedJob(e) {
  if (!e) return null;
  var r = memoryManager.storage.cold.get(archiveKey(e));
  if (!r || r.v !== ARCHIVE_VERSION || r.id !== e || !r.job) return null;
  if (Array.isArray(r.job) && !r.job[0]) r.job[0] = e;
  return memoryManager.compactMarketEconomicsJob(r.job);
}

function get(e) {
  var r = ensureMemory();
  return getMutable(e) || composeSettlement(e, r.settlements[e]) || getArchivedJob(e);
}

function link(e, r, t) {
  var i = getMutable(e);
  if (!i || !i.phase || !t) return i;
  if (!i.links) i.links = {};
  if (r === "marketLab") i.links.marketLabOpId = t; else if (r === "marketRefine") i.links.marketRefineOpId = t; else if (r === "localRefine") i.links.localRefineOpId = t; else if (r === "factory") i.links.factoryOrderId = t;
  memoryManager.requestSave();
  return i;
}

function phase(e, r) {
  var t = getMutable(e);
  if (!t || !r || t.status !== "active") return t;
  var i = t.phase.current;
  if (i === r) return t;
  if (i) {
    var a = Math.max(0, Game.time - (t.phase.since || Game.time));
    if (a) t.phase.durations[i] = (t.phase.durations[i] || 0) + a;
  }
  t.phase.current = r;
  t.phase.since = Game.time;
  if (r === "selling") t.status = "selling";
  memoryManager.requestSave();
  return t;
}

function ensureInput(e, r) {
  if (!e.input[r]) {
    e.input[r] = {};
  }
  return e.input[r];
}

function ensureOutput(e, r) {
  if (!e.output[r]) {
    e.output[r] = {};
  }
  return e.output[r];
}

function addSettlementMapValue(e, r, t, i, a) {
  if (!e[r]) e[r] = {};
  if (!e[r][t]) e[r][t] = {};
  e[r][t][i] = (e[r][t][i] || 0) + a;
}

function addSettlementFee(e, r, t) {
  if (!e.fees) e.fees = {};
  e.fees[r] = (e.fees[r] || 0) + t;
}

function recordBuy(e, r, t, i, a, n) {
  var o = getMutable(e);
  if (!o) {
    var s = ensureMemory().settlements[e];
    if (!s || !(t > 0)) return null;
    addSettlementMapValue(s, "input", r, "acquired", t);
    if (i > 0) addSettlementMapValue(s, "input", r, "buyCredits", roundCredits(i));
    if (a > 0) addSettlementMapValue(s, "input", r, "transferEnergy", a);
    if (n > 0) addSettlementMapValue(s, "input", r, "transferEnergyCredits", roundCredits(n));
    memoryManager.requestImmediateSave("marketEconomics.recordBuy");
    return s;
  }
  if (!o || !o.phase || !(t > 0)) return o;
  var l = ensureInput(o, r);
  l.acquired = (l.acquired || 0) + t;
  if (i > 0) l.buyCredits = roundCredits((l.buyCredits || 0) + i);
  if (a > 0) l.transferEnergy = (l.transferEnergy || 0) + a;
  if (n > 0) l.transferEnergyCredits = roundCredits((l.transferEnergyCredits || 0) + n);
  recomputeTotals(o);
  memoryManager.requestImmediateSave("marketEconomics.recordBuy");
  return o;
}

function recordOwnedOpportunity(e, r, t, i) {
  var a = getMutable(e);
  if (!a) {
    var n = ensureMemory().settlements[e];
    if (!n || !(t > 0) || !(i > 0)) return null;
    addSettlementMapValue(n, "input", r, "ownedOpportunityCredits", roundCredits(i));
    memoryManager.requestSave();
    return n;
  }
  if (!a || !a.phase || !(t > 0) || !(i > 0)) return a;
  var o = ensureInput(a, r);
  o.ownedOpportunityCredits = roundCredits((o.ownedOpportunityCredits || 0) + i);
  recomputeTotals(a);
  memoryManager.requestSave();
  return a;
}

function recordProduction(e, r, t, i) {
  var a = getMutable(e);
  if (!a) {
    var n = ensureMemory().settlements[e];
    if (!n) return null;
    if (r && t > 0) addSettlementMapValue(n, "output", r, "produced", t);
    if (i) {
      for (var o in i) {
        if (i[o] > 0) addSettlementMapValue(n, "input", o, "consumed", i[o]);
      }
    }
    memoryManager.requestSave();
    return n;
  }
  if (!a || !a.phase) return a;
  if (r && t > 0) {
    var s = ensureOutput(a, r);
    s.produced = (s.produced || 0) + t;
  }
  if (i) {
    for (var l in i) {
      if (!i.hasOwnProperty(l)) continue;
      var c = i[l] || 0;
      if (!(c > 0)) continue;
      var u = ensureInput(a, l);
      u.consumed = (u.consumed || 0) + c;
    }
  }
  memoryManager.requestSave();
  return a;
}

function recordSale(e, r, t, i, a, n) {
  var o = getMutable(e);
  if (!o) {
    var s = ensureMemory().settlements[e];
    if (!s || !(t > 0)) return null;
    addSettlementMapValue(s, "output", r, "sold", t);
    if (i > 0) addSettlementMapValue(s, "output", r, "saleCredits", roundCredits(i));
    if (a > 0) addSettlementMapValue(s, "output", r, "transferEnergy", a);
    if (n > 0) addSettlementMapValue(s, "output", r, "transferEnergyCredits", roundCredits(n));
    memoryManager.requestImmediateSave("marketEconomics.recordSale");
    return s;
  }
  if (!o || !o.phase || !(t > 0)) return o;
  var l = ensureOutput(o, r);
  l.sold = (l.sold || 0) + t;
  if (i > 0) l.saleCredits = roundCredits((l.saleCredits || 0) + i);
  if (a > 0) l.transferEnergy = (l.transferEnergy || 0) + a;
  if (n > 0) l.transferEnergyCredits = roundCredits((l.transferEnergyCredits || 0) + n);
  recomputeTotals(o);
  memoryManager.requestImmediateSave("marketEconomics.recordSale");
  return o;
}

function recordFee(e, r, t) {
  var i = getMutable(e);
  if (!i) {
    var a = ensureMemory().settlements[e];
    if (!a || !(t > 0) || !FEE_KINDS[r]) return null;
    addSettlementFee(a, r, roundCredits(t));
    memoryManager.requestImmediateSave("marketEconomics.recordFee");
    return a;
  }
  if (!i || !i.phase || !(t > 0)) return i;
  if (!FEE_KINDS[r]) return i;
  i.fees[r] = roundCredits((i.fees[r] || 0) + t);
  recomputeTotals(i);
  memoryManager.requestImmediateSave("marketEconomics.recordFee");
  return i;
}

function attachSellLot(e, r, t) {
  if (!e || !(t > 0)) return null;
  var i = ensureMemory();
  if (r && (!i.jobs[r] || !i.jobs[r].phase) && !i.settlements[r]) {
    throw new Error("cannot attach sell lot to sealed or archived job: " + r);
  }
  if (!i.orderLots[e]) {
    i.orderLots[e] = {
      lots: [],
      lastTick: Game.time
    };
  }
  var a = i.orderLots[e];
  a.lastTick = Game.time;
  var n = a.lots.length > 0 ? a.lots[a.lots.length - 1] : null;
  if (n && n.jobId === r) {
    n.remaining += t;
  } else {
    a.lots.push({
      jobId: r || null,
      remaining: t
    });
  }
  memoryManager.requestImmediateSave("marketEconomics.attachSellLot");
  return a;
}

function moveSellLots(e, r) {
  if (!e || !r || e === r) return null;
  var t = ensureMemory();
  var i = t.orderLots[e];
  if (!i || !Array.isArray(i.lots) || i.lots.length === 0) return null;
  if (!t.orderLots[r]) t.orderLots[r] = {
    lots: [],
    lastTick: Game.time
  };
  var a = t.orderLots[r];
  for (var n = 0; n < i.lots.length; n++) {
    var o = i.lots[n];
    if (!o || !(o.remaining > 0)) continue;
    var s = a.lots.length > 0 ? a.lots[a.lots.length - 1] : null;
    if (s && s.jobId === o.jobId) s.remaining += o.remaining; else a.lots.push({
      jobId: o.jobId || null,
      remaining: o.remaining
    });
  }
  a.lastTick = Game.time;
  delete t.orderLots[e];
  memoryManager.requestImmediateSave("marketEconomics.moveSellLots");
  return a;
}

function seedUnownedSellLot(e, r) {
  if (!e || !(r > 0)) return null;
  var t = ensureMemory();
  if (t.orderLots[e] && Array.isArray(t.orderLots[e].lots)) {
    var i = t.orderLots[e];
    var a = 0;
    for (var n = 0; n < i.lots.length; n++) {
      a += Math.max(0, i.lots[n] && i.lots[n].remaining || 0);
    }
    if (a < r) {
      i.lots.push({
        jobId: null,
        remaining: r - a
      });
      i.lastTick = Game.time;
      memoryManager.requestImmediateSave("marketEconomics.seedUnownedSellLot");
    }
    return i;
  }
  t.orderLots[e] = {
    lots: [ {
      jobId: null,
      remaining: r
    } ],
    lastTick: Game.time
  };
  memoryManager.requestImmediateSave("marketEconomics.seedUnownedSellLot");
  return t.orderLots[e];
}

function claimUnownedSellLot(e, r, t) {
  if (!e || !r || !(t > 0)) return {
    claimed: 0,
    reason: "invalid claim"
  };
  var i = ensureMemory();
  if ((!i.jobs[r] || !i.jobs[r].phase) && !i.settlements[r]) {
    return {
      claimed: 0,
      reason: "job is sealed or missing"
    };
  }
  var a = Game.market && Game.market.orders ? Game.market.orders[e] : null;
  var n = util.getOrderRemaining(a);
  if (!a || !(n > 0) || n < t) {
    return {
      claimed: 0,
      reason: "live order has insufficient coverage"
    };
  }
  var o = i.orderLots[e];
  if (!o || !Array.isArray(o.lots) || o.lots.length === 0) {
    o = i.orderLots[e] = {
      lots: [ {
        jobId: null,
        remaining: n
      } ],
      lastTick: Game.time
    };
  } else {
    seedUnownedSellLot(e, n);
  }
  processSellTransactions(i, e, true);
  a = Game.market && Game.market.orders ? Game.market.orders[e] : null;
  n = util.getOrderRemaining(a);
  if (!a || !(n > 0) || n < t) {
    return {
      claimed: 0,
      reason: "live order has insufficient coverage after fill reconciliation"
    };
  }
  var s = 0;
  var l = 0;
  for (var c = 0; c < o.lots.length; c++) {
    var u = o.lots[c];
    var d = Math.max(0, u && u.remaining || 0);
    s += d;
    if (u && !u.jobId) l += d;
  }
  if (s > n) {
    return {
      claimed: 0,
      reason: "order lots exceed live remaining amount"
    };
  }
  l += n - s;
  if (l < t) return {
    claimed: 0,
    reason: "existing coverage is owned by another job"
  };
  if (s < n) {
    o.lots.push({
      jobId: null,
      remaining: n - s
    });
  }
  var f = t;
  var m = [];
  function appendLot(e, r) {
    if (!(r > 0)) return;
    var t = m.length > 0 ? m[m.length - 1] : null;
    if (t && t.jobId === e) t.remaining += r; else m.push({
      jobId: e || null,
      remaining: r
    });
  }
  for (var v = 0; v < o.lots.length; v++) {
    var p = o.lots[v];
    if (!p || !(p.remaining > 0)) continue;
    if (!p.jobId && f > 0) {
      var g = Math.min(f, p.remaining);
      appendLot(r, g);
      appendLot(null, p.remaining - g);
      f -= g;
    } else {
      appendLot(p.jobId, p.remaining);
    }
  }
  o.lots = m;
  o.lastTick = Game.time;
  memoryManager.requestImmediateSave("marketEconomics.claimUnownedSellLot");
  return {
    claimed: t,
    orderId: e
  };
}

function releaseClaimedSellLot(e, r, t) {
  if (!e || !r || !(t > 0)) return 0;
  var i = ensureMemory();
  var a = i.orderLots[e];
  if (!a || !Array.isArray(a.lots)) return 0;
  var n = t;
  var o = 0;
  var s = [];
  function appendRestored(e, r) {
    if (!(r > 0)) return;
    var t = s.length > 0 ? s[s.length - 1] : null;
    if (t && t.jobId === e) t.remaining += r; else s.push({
      jobId: e || null,
      remaining: r
    });
  }
  for (var l = 0; l < a.lots.length; l++) {
    var c = a.lots[l];
    if (!c || !(c.remaining > 0)) continue;
    if (c.jobId === r && n > 0) {
      var u = Math.min(n, c.remaining);
      appendRestored(null, u);
      appendRestored(r, c.remaining - u);
      o += u;
      n -= u;
    } else {
      appendRestored(c.jobId, c.remaining);
    }
  }
  if (o > 0) {
    a.lots = s;
    a.lastTick = Game.time;
    memoryManager.requestImmediateSave("marketEconomics.releaseClaimedSellLot");
  }
  return o;
}

function releaseSellOrderLots(e) {
  if (!e) return 0;
  var r = ensureMemory();
  var t = r.orderLots[e];
  if (!t || !Array.isArray(t.lots)) return 0;
  var i = 0;
  for (var a = 0; a < t.lots.length; a++) {
    if (t.lots[a]) i += Math.max(0, t.lots[a].remaining || 0);
  }
  delete r.orderLots[e];
  memoryManager.requestImmediateSave("marketEconomics.releaseSellOrderLots");
  return i;
}

function allocateSale(e, r, t, i, a, n) {
  if (!e || !(t > 0)) return [];
  var o = ensureMemory();
  var s = o.orderLots[e];
  if (!s || !s.lots || s.lots.length === 0) return [];
  var l = t;
  var c = [];
  while (l > 0 && s.lots.length > 0) {
    var u = s.lots[0];
    var d = Math.min(l, u.remaining);
    var f = (i || 0) * (d / t);
    var m = (a || 0) * (d / t);
    var v = (n || 0) * (d / t);
    if (u.jobId && r) {
      recordSale(u.jobId, r, d, f, m, v);
    }
    c.push({
      jobId: u.jobId,
      amount: d,
      credits: f,
      transferEnergy: m
    });
    u.remaining -= d;
    l -= d;
    if (u.remaining <= 0) s.lots.shift();
  }
  s.lastTick = Game.time;
  memoryManager.requestImmediateSave("marketEconomics.allocateSale");
  return c;
}

function recordLearning(e) {
  if (!e || e.status !== "done" || e.partial) return;
  var r = ensureMemory();
  var t = (e.kind || "unknown") + "|" + (e.product || "?");
  if (!r.learning[t]) {
    r.learning[t] = {
      n: 0,
      lastTick: Game.time,
      phases: {},
      total: {
        n: 0,
        ema: 0
      }
    };
  }
  var i = r.learning[t];
  i.n += 1;
  i.lastTick = Game.time;
  var a = .3;
  var n = 0;
  for (var o in e.phase.durations) {
    if (!e.phase.durations.hasOwnProperty(o)) continue;
    var s = e.phase.durations[o] || 0;
    n += s;
    if (!i.phases[o]) i.phases[o] = {
      n: 1,
      ema: s
    }; else {
      i.phases[o].ema = a * s + (1 - a) * i.phases[o].ema;
      i.phases[o].n += 1;
    }
  }
  if (i.total.n === 0) i.total.ema = n; else i.total.ema = a * n + (1 - a) * i.total.ema;
  i.total.n += 1;
  var l = Object.keys(r.learning);
  if (l.length > LEARNING_KEY_CAP) {
    l.sort(function(e, t) {
      return (r.learning[e].lastTick || 0) - (r.learning[t].lastTick || 0);
    });
    while (l.length > LEARNING_KEY_CAP) {
      delete r.learning[l.shift()];
    }
  }
}

function reconcileClosedJobs(e) {
  if (e.v >= 2) return false;
  var r = [];
  for (var t in e.jobs) {
    if (!e.jobs.hasOwnProperty(t)) continue;
    var i = e.jobs[t];
    if (i && i.status !== "active" && i.status !== "selling") r.push(t);
  }
  r.sort(function(r, t) {
    var i = e.jobs[r];
    var a = e.jobs[t];
    return (a.finishedTick || a.createdTick || 0) - (i.finishedTick || i.createdTick || 0);
  });
  e.closedOrder = r.reverse();
  e.v = 2;
  return true;
}

function compactExistingJobs(e) {
  if (e.v >= 3) return false;
  for (var r in e.jobs) {
    if (!e.jobs.hasOwnProperty(r)) continue;
    var t = e.jobs[r];
    if (!t) continue;
    delete t.inputs;
    delete t.outputs;
    delete t.origin;
    if (!t.partial) delete t.partial;
    if (t.finishedTick == null) delete t.finishedTick;
    if (t.reason == null) delete t.reason;
    if (t.links) {
      for (var i in t.links) {
        if (t.links[i] == null) delete t.links[i];
      }
    }
    if (t.expected) {
      delete t.expected.snapshotTick;
      for (var a in t.expected) {
        if (t.expected[a] == null) delete t.expected[a];
      }
    }
    if (t.fees) {
      for (var n in t.fees) {
        if (!t.fees[n]) delete t.fees[n];
      }
    }
    recomputeTotals(t);
  }
  e.v = 3;
  return true;
}

function compactJobDefaults(e) {
  if (e.v >= 4) return false;
  for (var r in e.jobs) {
    if (!e.jobs.hasOwnProperty(r)) continue;
    var t = e.jobs[r];
    if (!t || !t.phase || !t.phase.durations) continue;
    for (var i in t.phase.durations) {
      if (!t.phase.durations[i]) delete t.phase.durations[i];
    }
  }
  e.v = 4;
  return true;
}

function compactResourceRecords(e) {
  if (e.v >= 5) return false;
  for (var r in e.jobs) {
    if (!e.jobs.hasOwnProperty(r)) continue;
    var t = e.jobs[r];
    if (!t) continue;
    var i = [ t.input, t.output ];
    for (var a = 0; a < i.length; a++) {
      var n = i[a];
      if (!n) continue;
      for (var o in n) {
        var s = n[o];
        if (!s) continue;
        for (var l in s) {
          if (!s[l]) delete s[l];
        }
      }
    }
    recomputeTotals(t);
  }
  e.v = 5;
  return true;
}

function compactOrderLots(e) {
  if (e.v >= 6) return false;
  for (var r in e.orderLots) {
    if (!e.orderLots.hasOwnProperty(r)) continue;
    var t = e.orderLots[r];
    if (!t) continue;
    delete t.side;
    if (!Array.isArray(t.lots)) continue;
    for (var i = 0; i < t.lots.length; i++) {
      if (t.lots[i]) delete t.lots[i].qty;
    }
  }
  e.v = 6;
  return true;
}

function compactCreditPrecision(e) {
  if (e.v >= 8) return false;
  for (var r in e.jobs) {
    if (!e.jobs.hasOwnProperty(r)) continue;
    var t = e.jobs[r];
    if (!t) continue;
    var i = [ t.input, t.output ];
    for (var a = 0; a < i.length; a++) {
      var n = i[a];
      if (!n) continue;
      for (var o in n) {
        var s = n[o];
        if (!s) continue;
        if (s.buyCredits != null) s.buyCredits = roundCredits(s.buyCredits);
        if (s.saleCredits != null) s.saleCredits = roundCredits(s.saleCredits);
        if (s.transferEnergyCredits != null) s.transferEnergyCredits = roundCredits(s.transferEnergyCredits);
        if (s.ownedOpportunityCredits != null) s.ownedOpportunityCredits = roundCredits(s.ownedOpportunityCredits);
      }
    }
    if (t.fees) {
      for (var l in t.fees) t.fees[l] = roundCredits(t.fees[l]);
    }
    if (t.expected) {
      if (t.expected.netCredits != null) t.expected.netCredits = roundCredits(t.expected.netCredits);
      if (t.expected.creditsPerTick != null) t.expected.creditsPerTick = roundRate(t.expected.creditsPerTick);
    }
    recomputeTotals(t);
  }
  e.v = 8;
  delete e.migration;
  return true;
}

function cleanupRefusedJobsAndUnownedLots(e) {
  if (e.v >= 7) return false;
  var r = false;
  for (var t in e.jobs) {
    if (!e.jobs.hasOwnProperty(t)) continue;
    var i = e.jobs[t];
    if (i && i.status === "refused") {
      delete e.jobs[t];
      r = true;
      continue;
    }
    if (i && i.expected) delete i.expected.snapshotTick;
  }
  e.closedOrder = e.closedOrder.filter(function(r) {
    return !!e.jobs[r];
  });
  for (var a in e.orderLots) {
    if (!e.orderLots.hasOwnProperty(a)) continue;
    var n = e.orderLots[a];
    var o = false;
    if (n && Array.isArray(n.lots)) {
      for (var s = 0; s < n.lots.length; s++) {
        if (n.lots[s] && n.lots[s].jobId) {
          o = true;
          break;
        }
      }
    }
    if (!o) {
      delete e.orderLots[a];
      r = true;
    }
  }
  e.v = 7;
  return true;
}

function finish(e, r, t) {
  var i = getMutable(e);
  if (!i) {
    var a = ensureMemory();
    var n = a.settlements[e];
    if (!n || n.status !== "active" && n.status !== "selling") return n || null;
    var o = n.phase;
    n.finishedTick = Game.time;
    n.status = r || "done";
    if (t) n.reason = t; else delete n.reason;
    if (o) {
      var s = o.current;
      if (s) {
        var l = Math.max(0, Game.time - (o.since || Game.time));
        if (l) o.durations[s] = (o.durations[s] || 0) + l;
      }
    }
    if (n.status === "done") {
      var c = composeSettlement(e, n);
      if (c) recordLearning(c);
    }
    if (a.closedOrder.indexOf(e) < 0) a.closedOrder.push(e);
    memoryManager.requestSave();
    return n;
  }
  if (i.status !== "active" && i.status !== "selling") return i;
  var u = i.phase.current;
  if (u) {
    var l = Math.max(0, Game.time - (i.phase.since || Game.time));
    if (l) i.phase.durations[u] = (i.phase.durations[u] || 0) + l;
  }
  i.finishedTick = Game.time;
  i.status = r || "done";
  i.reason = t || null;
  recomputeTotals(i);
  if (i.status === "done") recordLearning(i);
  var d = ensureMemory();
  if (i.status === "refused") {
    delete d.jobs[e];
    memoryManager.requestSave();
    return i;
  }
  if (d.closedOrder.indexOf(e) < 0) d.closedOrder.push(e);
  d.closedOrder = d.closedOrder.filter(function(e) {
    return !!d.jobs[e] || !!d.settlements[e];
  });
  memoryManager.requestSave();
  return i;
}

function getLearnedDuration(e, r, t) {
  var i = ensureMemory();
  var a = i.learning[(e || "") + "|" + (r || "")];
  if (a && a.phases && a.phases[t] && a.phases[t].n >= 3) {
    return a.phases[t].ema;
  }
  var n = null;
  for (var o in i.learning) {
    if (!i.learning.hasOwnProperty(o)) continue;
    if (o.indexOf((e || "") + "|") === 0) {
      var s = i.learning[o];
      if (s.phases && s.phases[t] && s.phases[t].n >= 3) {
        if (!n) n = s.phases[t].ema;
      }
    }
  }
  return n;
}

function status() {
  var e = ensureMemory();
  var r = 0, t = 0, i = 0, a = 0, n = 0, o = 0, s = 0;
  for (var l in e.jobs) {
    if (!e.jobs.hasOwnProperty(l)) continue;
    var c = e.jobs[l];
    var u = c.status;
    if (u === "active") r++; else if (u === "selling") t++; else if (u === "done") {
      i++;
      if (c.expected && typeof c.expected.creditsPerTick === "number" && c.totals && typeof c.totals.economicNetCreditsPerTick === "number") {
        o += c.expected.creditsPerTick;
        s += c.totals.economicNetCreditsPerTick;
        n++;
      }
    } else a++;
  }
  for (var d in e.settlements) {
    if (!e.settlements.hasOwnProperty(d)) continue;
    var f = e.settlements[d].status;
    if (f === "active") r++; else if (f === "selling") t++; else if (f === "done") {
      i++;
      var m = composeSettlement(d, e.settlements[d]);
      if (m && m.expected && typeof m.expected.creditsPerTick === "number" && m.totals && typeof m.totals.economicNetCreditsPerTick === "number") {
        o += m.expected.creditsPerTick;
        s += m.totals.economicNetCreditsPerTick;
        n++;
      }
    } else a++;
  }
  var v = "[marketEconomics] jobs active=" + r + " selling=" + t + " done=" + i + " other=" + a + " hotClosed=" + e.closedOrder.length + " hotTarget=" + HOT_CLOSED_JOB_CAP + " archived=" + e.archive.archived + " learningKeys=" + Object.keys(e.learning).length;
  if (n > 0) {
    v += " expected/realized avg=" + (o / n).toFixed(3) + "/" + (s / n).toFixed(3) + " cr/t (" + n + " jobs)";
  }
  return v;
}

function jobDetail(e) {
  var r = get(e);
  if (!r) {
    var t = "[marketEconomics] job not found: " + e;
    return t;
  }
  if (r.phase) recomputeTotals(r);
  var i = [];
  i.push("[marketEconomics] " + r.id + " " + r.kind + " " + (r.product || "?") + " @ " + (r.room || "?") + " [" + r.status + "]");
  i.push("  phase=" + (r.phase ? r.phase.current : "archived") + " expected=" + (r.expected && r.expected.creditsPerTick != null ? r.expected.creditsPerTick.toFixed(3) + " cr/t" : "n/a"));
  i.push("  cashNet=" + (r.totals.realizedNetCredits || 0).toFixed(1) + " economicNet=" + (r.totals.economicNetCredits || 0).toFixed(1) + " fees=" + (r.totals.feeCredits || 0).toFixed(1));
  if (r.totals.economicNetCreditsPerTick != null) {
    i.push("  realized economic cr/t=" + r.totals.economicNetCreditsPerTick.toFixed(3));
  }
  if (r.reconciliation && r.reconciliation.unpricedSaleAmount > 0) {
    i.push("  warning: reconciled " + r.reconciliation.unpricedSaleAmount + " sold units without visible transaction pricing (" + (r.reconciliation.unpricedSaleEvents || 0) + " event(s))");
  }
  if (r.reconciliation && r.reconciliation.unresolvedLotAmount > 0) {
    i.push("  warning: released " + r.reconciliation.unresolvedLotAmount + " unresolved owned lot units after the market order remained missing");
  }
  var a = i.join("\n");
  return a;
}

function buildLiveLinkIndex() {
  var e = {
    marketLab: {},
    marketRefine: {},
    localRefine: {},
    factory: {}
  };
  var r = getRecords("marketLab", "getOperations");
  for (var t = 0; t < r.length; t++) {
    if (r[t] && r[t].id) {
      e.marketLab[r[t].id] = true;
    }
  }
  var i = [ {
    list: getRecords("marketRefine", "getOperations"),
    target: e.marketRefine,
    filterStatus: false
  }, {
    list: getRecords("localRefine", "getOperations"),
    target: e.localRefine,
    filterStatus: false
  }, {
    list: getRecords("factoryManager", "getOrders"),
    target: e.factory,
    filterStatus: true
  } ];
  for (var a = 0; a < i.length; a++) {
    var n = i[a].list;
    if (!Array.isArray(n)) continue;
    for (var o = 0; o < n.length; o++) {
      var s = n[o];
      if (s && s.id && (!i[a].filterStatus || s.status !== "done" && s.status !== "cancelled")) {
        i[a].target[s.id] = true;
      }
    }
  }
  return e;
}

function hasLiveJobLink(e, r) {
  var t = e && e.links;
  if (!t) return false;
  return !!(r.marketLab[t.marketLabOpId] || r.marketRefine[t.marketRefineOpId] || r.localRefine[t.localRefineOpId] || r.factory[t.factoryOrderId]);
}

function reconcileOrphanedJobs(e) {
  var r = buildLiveLinkIndex();
  var t = false;
  for (var i in e.jobs) {
    if (!e.jobs.hasOwnProperty(i)) continue;
    var a = e.jobs[i];
    if (!a || a.status !== "active" && a.status !== "selling") continue;
    if (Game.time - (a.createdTick || Game.time) < ORPHAN_JOB_GRACE_TICKS) continue;
    if (a.status === "selling") {
      if (!hasLiveJobLink(a, r) && !hasSellLotForJob(e, i) && !hasDelayedJobReference(e, i)) {
        finish(i, "done", "selling owner completed before economics finalization");
        t = true;
      }
    } else if (!hasLiveJobLink(a, r)) {
      finish(i, "failed", "linked operation no longer active");
      t = true;
    }
  }
  for (var n in e.settlements) {
    if (!e.settlements.hasOwnProperty(n)) continue;
    var o = e.settlements[n];
    if (!o || o.status !== "selling") continue;
    var s = o.createdTick || Game.time;
    if (Game.time - s < ORPHAN_JOB_GRACE_TICKS) continue;
    if (!hasLiveJobLink(o, r) && !hasSellLotForJob(e, n) && !hasDelayedJobReference(e, n)) {
      finish(n, "done", "selling owner completed before economics finalization");
      t = true;
    }
  }
  return t;
}

function transactionKey(e, r) {
  if (e.transactionId || e.id) return e.transactionId || e.id;
  var t = e.order || {};
  return [ r, e.time || 0, t.id || "", e.resourceType || "", e.amount || 0, t.price || 0, e.sender && e.sender.username || "", e.recipient && e.recipient.username || "" ].join(":");
}

function processSellTransactions(e, r, t) {
  var i = Game.market.outgoingTransactions || [];
  var a = false;
  for (var n = 0; n < i.length; n++) {
    var o = i[n];
    if (!o || !o.order || !o.order.id) continue;
    if (r && o.order.id !== r) continue;
    if (o.order.type !== "sell") continue;
    if (o.sender && o.sender.username && o.sender.username !== require("util").PLAYER_USERNAME()) continue;
    if (!t && !e.orderLots[o.order.id]) continue;
    var s = transactionKey(o, "out");
    if (e.processedTransactions[s]) continue;
    var l = (o.amount || 0) * (o.order.price || 0);
    var c = 0;
    if (o.from && o.to && o.amount > 0) {
      try {
        c = util.calcTransactionCost(o.amount, o.from, o.to);
      } catch (e) {}
    }
    var u = c * (pricing.getStatusEnergyPrice() || 0);
    allocateSale(o.order.id, o.resourceType || o.order && o.order.resourceType || null, o.amount || 0, l, c, u);
    e.processedTransactions[s] = Game.time;
    a = true;
  }
  if (a) memoryManager.requestImmediateSave("marketEconomics.processSellTransactions");
  return a;
}

function recordLotReconciliation(e, r, t, i, a, n) {
  if (!(t > 0) || !r || !r.jobId || !e.jobs[r.jobId] && !e.settlements[r.jobId]) return;
  var o = e.jobs[r.jobId] || e.settlements[r.jobId];
  if (!o.reconciliation) o.reconciliation = {};
  var s = n === "unpricedSale" ? "unpricedSaleAmount" : "unresolvedLotAmount";
  var l = n === "unpricedSale" ? "unpricedSaleEvents" : "unresolvedLotEvents";
  o.reconciliation[s] = (o.reconciliation[s] || 0) + t;
  o.reconciliation[l] = (o.reconciliation[l] || 0) + 1;
  o.reconciliation.lastTick = Game.time;
  o.reconciliation.lastOrderId = i;
  o.reconciliation.lastResource = a || null;
}

function getPendingSellExtension(e) {
  var r = getRecords("marketSell", "getRequests");
  var t = 0;
  for (var i = 0; i < r.length; i++) {
    var a = r[i];
    if (!a || a.orderId !== e || a.pendingExtendTick !== Game.time) continue;
    t = Math.max(t, a.pendingExtendAmount || 0);
  }
  return t;
}

function reconcileOrderLots(e) {
  var r = false;
  var t = false;
  var i = Game.market.orders || {};
  for (var a in e.orderLots) {
    var n = e.orderLots[a];
    var o = i[a];
    if (!n || !Array.isArray(n.lots) || n.lots.length === 0) {
      delete e.orderLots[a];
      r = true;
      continue;
    }
    var s = false;
    for (var l = 0; l < n.lots.length; l++) {
      if (n.lots[l] && n.lots[l].jobId) {
        s = true;
        break;
      }
    }
    if (!s) {
      delete e.orderLots[a];
      r = true;
      continue;
    }
    if (!o) {
      if ((n.lastTick || 0) < Game.time - STALE_ORDER_LOT_TICKS) {
        for (var c = 0; c < n.lots.length; c++) {
          recordLotReconciliation(e, n.lots[c], n.lots[c].remaining, a, null, "unresolvedLot");
        }
        delete e.orderLots[a];
        r = true;
        t = true;
      }
      continue;
    }
    var u = Math.max(0, util.getOrderRemaining(o) + getPendingSellExtension(a));
    var d = 0;
    for (var f = 0; f < n.lots.length; f++) d += Math.max(0, n.lots[f].remaining || 0);
    while (d > u && n.lots.length > 0) {
      var m = n.lots[0];
      var v = Math.min(d - u, m.remaining || 0);
      if (m.jobId && v > 0) t = true;
      recordLotReconciliation(e, m, v, a, o.resourceType, "unpricedSale");
      m.remaining -= v;
      d -= v;
      if (m.remaining <= 0) n.lots.shift();
      r = true;
    }
    if (d < u) {
      n.lots.push({
        jobId: null,
        remaining: u - d
      });
      r = true;
    }
  }
  if (t) memoryManager.requestImmediateSave("marketEconomics.reconcileOrderLots");
  return r;
}

function hasSellLotForJob(e, r) {
  for (var t in e.orderLots) {
    if (!e.orderLots.hasOwnProperty(t)) continue;
    var i = e.orderLots[t];
    if (!i || !Array.isArray(i.lots)) continue;
    for (var a = 0; a < i.lots.length; a++) {
      if (i.lots[a] && i.lots[a].jobId === r && i.lots[a].remaining > 0) return true;
    }
  }
  return false;
}

function getSellLotRemaining(e, r) {
  if (!e || !r) return 0;
  var t = ensureMemory().orderLots[e];
  if (!t || !Array.isArray(t.lots)) return 0;
  var i = 0;
  for (var a = 0; a < t.lots.length; a++) {
    var n = t.lots[a];
    if (n && n.jobId === r && n.remaining > 0) i += n.remaining;
  }
  return i;
}

function collectionHasJobId(e, r) {
  if (!e || typeof e !== "object") return false;
  for (var t in e) {
    if (!e.hasOwnProperty(t)) continue;
    if (e[t] && e[t].jobId === r) return true;
  }
  return false;
}

function hasDelayedMarketSellReference(e, r) {
  var t = getRecords("marketSell", "getRequests");
  if (!Array.isArray(t)) return false;
  var i = e.jobs[r] || e.settlements[r] || null;
  var a = i && i.status !== "active" && i.status !== "selling";
  for (var n = 0; n < t.length; n++) {
    var o = t[n];
    if (!o || o.jobId !== r) continue;
    if (!a || typeof o.created !== "number" || Game.time - o.created < BUY_TOMBSTONE_SETTLEMENT_TICKS) return true;
  }
  return false;
}

function hasUnprocessedIncomingForOrder(e, r) {
  var t = Game.market && Game.market.incomingTransactions || [];
  for (var i = 0; i < t.length; i++) {
    var a = t[i];
    if (a && a.order && a.order.id === r && !e.processedTransactions[transactionKey(a, "in")]) {
      return true;
    }
  }
  return false;
}

function hasDelayedJobReference(e, r) {
  var t = getModule("marketBuy");
  if (t) {
    var i = typeof t.getManagedOrderRecords === "function" ? t.getManagedOrderRecords() : {};
    for (var a in i) {
      var n = i[a];
      if (!n || n.jobId !== r) continue;
      if (!n.done && !n.cancelled) return true;
      if (Game.time - (n.closedTick || 0) < BUY_TOMBSTONE_SETTLEMENT_TICKS) return true;
      if (hasUnprocessedIncomingForOrder(e, a)) return true;
    }
    var o = typeof t.getPendingOrders === "function" ? t.getPendingOrders() : [];
    if (collectionHasJobId(o, r)) return true;
  }
  var s = getModule("opportunisticBuy");
  if (s && typeof s.getActiveRequestRecords === "function" && collectionHasJobId(s.getActiveRequestRecords(), r)) return true;
  if (hasDelayedMarketSellReference(e, r)) return true;
  if (collectionHasJobId(getRecords("factoryManager", "getOrders"), r)) return true;
  if (collectionHasJobId(getRecords("marketRefine", "getOperations"), r)) return true;
  if (collectionHasJobId(getRecords("localRefine", "getOperations"), r)) return true;
  if (collectionHasJobId(getRecords("marketLab", "getOperations"), r)) return true;
  return false;
}

function getOrderLots(e) {
  var r = ensureMemory();
  var t = r.orderLots || {};
  var copy = function(e) {
    if (!e || typeof e !== "object") return null;
    var r = Object.create(e);
    var t = Array.isArray(e.lots) ? e.lots : [];
    r.lots = t.map(function(e) {
      return e && typeof e === "object" ? Object.create(e) : null;
    });
    return r;
  };
  if (e) return copy(t[e]);
  var i = {};
  for (var a in t) {
    if (t[a]) i[a] = copy(t[a]);
  }
  return i;
}

function isArchiveEligible(e, r) {
  var t = e.settlements[r];
  if (t) {
    if (t.status === "active" || t.status === "selling" || t.status === "refused") return false;
    if (typeof t.finishedTick !== "number") return false;
    if (memoryManager.storage.cold.status(t.baseKey).state !== "committed") return false;
    return !hasSellLotForJob(e, r) && !hasDelayedJobReference(e, r);
  }
  var i = e.jobs[r];
  if (!i || i.phase) return false;
  if (i.status === "active" || i.status === "selling" || i.status === "refused") return false;
  if (typeof i.finishedTick !== "number") return false;
  return !hasSellLotForJob(e, r) && !hasDelayedJobReference(e, r);
}

function selectSettlementCandidate(e) {
  for (var r in e.jobs) {
    if (!e.jobs.hasOwnProperty(r)) continue;
    var t = e.jobs[r];
    if (!t || !t.phase || t.status !== "selling") continue;
    var i = settlementBaseKey(r);
    if (e.archive.failures[i]) continue;
    return r;
  }
  return null;
}

function selectArchiveCandidate(e) {
  if (e.closedOrder.length <= HOT_CLOSED_JOB_CAP) return null;
  var r = e.closedOrder.length - HOT_CLOSED_JOB_CAP;
  for (var t = 0; t < r; t++) {
    var i = e.closedOrder[t];
    if (e.archive.failures[i]) continue;
    if (isArchiveEligible(e, i)) return i;
  }
  return null;
}

function setArchiveError(e, r) {
  var t = e.archive.active;
  if (!t) return;
  console.log("[marketEconomics] archive quarantined id=" + t.jobId + ": " + r);
  var i = t.kind === "settlement" ? t.key : t.jobId;
  e.archive.failures[i] = {
    jobId: t.jobId,
    key: t.key,
    kind: t.kind || "final",
    attempts: t.attempts || 0,
    errorTick: Game.time,
    message: String(r).slice(0, ARCHIVE_FAILURE_MESSAGE_MAX)
  };
  e.archive.active = null;
  memoryManager.requestSave();
}

function payloadHash(e) {
  var r = JSON.stringify(e);
  var t = 2166136261;
  for (var i = 0; i < r.length; i++) {
    t ^= r.charCodeAt(i);
    t = Math.imul(t, 16777619);
  }
  return (t >>> 0).toString(36) + ":" + r.length;
}

function compactTerminalSnapshot(e, r) {
  var t = hydrateJobCopy(r, e);
  recomputeTotals(t);
  var i = t.expected && t.expected.creditsPerTick;
  if (i != null) t.expected = {
    creditsPerTick: i
  }; else delete t.expected;
  delete t.links;
  delete t.phase;
  delete t.input;
  delete t.output;
  delete t.fees;
  delete t.partial;
  delete t.reason;
  return t;
}

function processSettlementArchive(e, r) {
  var t = e.jobs[r.jobId];
  if (!t) {
    setArchiveError(e, "selling source job is missing before settlement handoff");
    return {
      state: "error",
      key: r.key
    };
  }
  var i = memoryManager.storage.cold.status(r.key);
  if (!t.phase) {
    if (i.state === "queued") return i;
    if (i.state === "failed") {
      memoryManager.storage.cold.discard(r.key);
      e.archive.active = null;
      memoryManager.requestSave();
      return {
        state: "superseded",
        key: r.key,
        jobId: r.jobId,
        discardedFailure: true
      };
    }
    if (i.state === "committed") memoryManager.storage.cold.remove(r.key);
    e.archive.active = null;
    memoryManager.requestSave();
    return {
      state: "superseded",
      key: r.key,
      jobId: r.jobId
    };
  }
  if (i.state === "queued") {
    r.state = "waiting";
    return i;
  }
  if (i.state === "failed") {
    setArchiveError(e, i.message || "physical settlement snapshot write failed");
    return i;
  }
  if (i.state === "committed") {
    var a = memoryManager.storage.cold.get(r.key);
    if (!a || a.type !== "marketEconomics.jobBase" || a.id !== r.jobId || r.snapshotHash && payloadHash(a) !== r.snapshotHash) {
      setArchiveError(e, "settlement snapshot read-back does not match the published source");
      return {
        state: "error",
        key: r.key
      };
    }
    if (!memoryManager.storage.cold.pin(r.key)) {
      setArchiveError(e, "could not pin settlement snapshot before hot handoff");
      return {
        state: "error",
        key: r.key
      };
    }
    var n = hydrateJobCopy(a.job, r.jobId);
    e.settlements[r.jobId] = memoryManager.compactMarketEconomicsSettlement(createSettlement(r.jobId, t, n, r.key));
    delete e.jobs[r.jobId];
    e.archive.settled = (e.archive.settled || 0) + 1;
    e.archive.lastSettlement = {
      jobId: r.jobId,
      key: r.key,
      tick: Game.time,
      bytes: i.meta && i.meta.bytes || 0
    };
    e.archive.active = null;
    memoryManager.requestImmediateSave("marketEconomics.settlementCommit");
    console.log("[marketEconomics] moved selling job to compact settlement id=" + r.jobId + " key=" + r.key + " bytes=" + e.archive.lastSettlement.bytes);
    return {
      state: "settled",
      key: r.key,
      jobId: r.jobId
    };
  }
  if (r.attempts >= ARCHIVE_MAX_ATTEMPTS) {
    setArchiveError(e, "settlement snapshot missing after " + r.attempts + " attempts");
    return {
      state: "error",
      key: r.key
    };
  }
  if (r.lastAttemptTick != null && Game.time - r.lastAttemptTick < ARCHIVE_RETRY_TICKS) {
    return {
      state: "waiting",
      key: r.key,
      retryTick: r.lastAttemptTick + ARCHIVE_RETRY_TICKS
    };
  }
  var o = settlementBasePayload(r.jobId, t);
  r.snapshotHash = payloadHash(o);
  r.attempts += 1;
  r.lastAttemptTick = Game.time;
  r.state = "waiting";
  memoryManager.requestSave();
  try {
    return memoryManager.storage.cold.publish(r.key, o);
  } catch (t) {
    setArchiveError(e, t && t.message ? t.message : String(t));
    return {
      state: "error",
      key: r.key
    };
  }
}

function archiveTick() {
  var e = ensureMemory();
  var r = e.archive.active;
  if (!r) {
    var t = selectArchiveCandidate(e);
    var i = "final";
    if (!t) {
      t = selectSettlementCandidate(e);
      i = "settlement";
    }
    if (!t) return null;
    r = e.archive.active = {
      jobId: t,
      key: i === "settlement" ? settlementBaseKey(t) : archiveKey(t),
      kind: i,
      state: "waiting",
      startedTick: Game.time,
      attempts: 0,
      lastAttemptTick: null,
      lastError: null
    };
    memoryManager.requestSave();
  }
  if (r.kind === "settlement") return processSettlementArchive(e, r);
  if (!r.kind) r.kind = "final";
  var a = e.settlements[r.jobId];
  var n = e.jobs[r.jobId] || composeSettlement(r.jobId, a);
  if (!n) {
    var o = memoryManager.storage.cold.status(r.key);
    if (o.state === "committed") {
      var s = memoryManager.storage.cold.get(r.key);
      if (!s || s.v !== ARCHIVE_VERSION || s.type !== "marketEconomics.job" || s.id !== r.jobId || !s.job) {
        setArchiveError(e, "committed final archive failed physical recovery validation");
        return {
          state: "error",
          key: r.key
        };
      }
      if (a) {
        delete e.settlements[r.jobId];
        if (a.baseKey) {
          memoryManager.storage.cold.unpin(a.baseKey);
          memoryManager.storage.cold.remove(a.baseKey);
        }
      }
      e.closedOrder = e.closedOrder.filter(function(e) {
        return e !== r.jobId;
      });
      e.archive.recovered = (e.archive.recovered || 0) + 1;
      e.archive.last = {
        jobId: r.jobId,
        key: r.key,
        tick: Game.time,
        recovered: true
      };
      e.archive.active = null;
      memoryManager.requestSave();
      return {
        state: "recovered",
        key: r.key
      };
    }
    setArchiveError(e, "source job is missing before verified archive commit");
    return {
      state: "error",
      key: r.key
    };
  }
  if (!isArchiveEligible(e, r.jobId)) {
    setArchiveError(e, "source job is no longer immutable or still owns a sell lot");
    return {
      state: "error",
      key: r.key
    };
  }
  var l = memoryManager.storage.cold.status(r.key);
  if (l.state === "queued") {
    r.state = "waiting";
    return l;
  }
  if (l.state === "failed") {
    setArchiveError(e, l.message || "physical cold write failed");
    return l;
  }
  if (l.state === "committed") {
    r.state = "verifying";
    var c = a ? compactTerminalSnapshot(r.jobId, n) : n;
    var u = archivePayload(r.jobId, c);
    var d = memoryManager.storage.cold.get(r.key);
    if (!d || JSON.stringify(d) !== JSON.stringify(u)) {
      setArchiveError(e, "cold read-back does not match the authoritative source");
      return {
        state: "error",
        key: r.key
      };
    }
    delete e.jobs[r.jobId];
    delete e.settlements[r.jobId];
    e.closedOrder = e.closedOrder.filter(function(e) {
      return e !== r.jobId;
    });
    e.archive.archived += 1;
    e.archive.last = {
      jobId: r.jobId,
      key: r.key,
      tick: Game.time,
      bytes: l.meta && l.meta.bytes || 0
    };
    e.archive.active = null;
    if (a && a.baseKey) {
      memoryManager.storage.cold.unpin(a.baseKey);
      memoryManager.storage.cold.remove(a.baseKey);
    }
    memoryManager.requestImmediateSave("marketEconomics.archiveCommit");
    console.log("[marketEconomics] archived and cleared hot job id=" + r.jobId + " key=" + r.key + " bytes=" + e.archive.last.bytes);
    return {
      state: "archived",
      key: r.key,
      jobId: r.jobId
    };
  }
  if (r.attempts >= ARCHIVE_MAX_ATTEMPTS) {
    setArchiveError(e, "cold write missing after " + r.attempts + " attempts");
    return {
      state: "error",
      key: r.key
    };
  }
  if (r.lastAttemptTick != null && Game.time - r.lastAttemptTick < ARCHIVE_RETRY_TICKS) {
    return {
      state: "waiting",
      key: r.key,
      retryTick: r.lastAttemptTick + ARCHIVE_RETRY_TICKS
    };
  }
  r.attempts += 1;
  r.lastAttemptTick = Game.time;
  r.state = "waiting";
  r.lastError = null;
  memoryManager.requestSave();
  try {
    var f = a ? compactTerminalSnapshot(r.jobId, n) : n;
    return memoryManager.storage.cold.publish(r.key, archivePayload(r.jobId, f));
  } catch (t) {
    var m = t && t.message ? t.message : String(t);
    setArchiveError(e, m);
    return {
      state: "error",
      key: r.key,
      message: m
    };
  }
}

function archiveRetentionTelemetry() {
  var e = memoryManager.heap.marketEconomicsArchiveRetention;
  if (!e) {
    e = memoryManager.heap.marketEconomicsArchiveRetention = {
      deleted: 0,
      lastDeleted: null,
      lastBatchCount: 0,
      lastError: null,
      lastScanTick: null
    };
  }
  return e;
}

function finalArchiveProtectionReason(e, r, t) {
  if (e.archive.active && e.archive.active.key === r) return "active";
  if (e.archive.failures[t] || e.archive.failures[r]) return "quarantined";
  if (e.jobs[t] || e.settlements[t]) return "live";
  if (hasSellLotForJob(e, t)) return "sellLot";
  if (hasDelayedJobReference(e, t)) return "reference";
  return null;
}

function collectFinalArchiveCandidates() {
  var e = Game.time;
  var r = {
    finalPresent: 0,
    finalBytes: 0,
    finalFlags: 0,
    ageEligible: 0,
    pinnedSkipped: 0,
    candidates: []
  };
  var t = storage.cold.keys();
  for (var i = 0; i < t.length; i++) {
    var a = t[i];
    if (a.indexOf(ARCHIVE_KEY_PREFIX) !== 0) continue;
    var n = storage.cold.meta(a);
    if (!n) continue;
    r.finalPresent++;
    r.finalBytes += n.bytes || 0;
    r.finalFlags += n.flags || 0;
    if (n.pinned) {
      r.pinnedSkipped++;
      continue;
    }
    if (typeof n.tick !== "number" || e - n.tick < FINAL_ARCHIVE_RETENTION_TICKS) continue;
    r.ageEligible++;
    r.candidates.push({
      key: a,
      jobId: a.slice(ARCHIVE_KEY_PREFIX.length),
      tick: n.tick,
      bytes: n.bytes || 0,
      flags: n.flags || 0
    });
  }
  r.candidates.sort(function(e, r) {
    return e.tick - r.tick || e.key.localeCompare(r.key);
  });
  return r;
}

function inspectFinalArchiveRetention(e) {
  var r = collectFinalArchiveCandidates();
  var t = {
    active: 0,
    quarantined: 0,
    live: 0,
    sellLot: 0,
    reference: 0
  };
  var i = 0;
  var a = 0;
  var n = [];
  for (var o = 0; o < r.candidates.length; o++) {
    var s = r.candidates[o];
    var l = finalArchiveProtectionReason(e, s.key, s.jobId);
    if (l) {
      t[l]++;
      continue;
    }
    n.push(s);
    i += s.bytes;
    a += s.flags;
  }
  return {
    finalPresent: r.finalPresent,
    finalBytes: r.finalBytes,
    finalFlags: r.finalFlags,
    ageEligible: r.ageEligible,
    eligibleForDeletion: n.length,
    eligibleBytes: i,
    eligibleFlags: a,
    oldestEligibleTick: n.length ? n[0].tick : null,
    pinnedSkipped: r.pinnedSkipped,
    protectedSkipped: t,
    candidates: n
  };
}

function pruneArchiveFailures(e) {
  var __f = e.archive.failures;
  var __ids = Object.keys(__f);
  if (!__ids.length) return 0;
  var __removed = 0;
  for (var __i = 0; __i < __ids.length; __i++) {
    var __rec = __f[__ids[__i]];
    if (!__rec || Game.time - (__rec.errorTick || 0) > ARCHIVE_FAILURE_TTL) {
      delete __f[__ids[__i]];
      __removed++;
    }
  }
  __ids = Object.keys(__f);
  if (__ids.length > ARCHIVE_FAILURE_CAP) {
    __ids.sort(function(__x, __y) {
      return (__f[__x].errorTick || 0) - (__f[__y].errorTick || 0);
    });
    while (__ids.length > ARCHIVE_FAILURE_CAP) {
      delete __f[__ids.shift()];
      __removed++;
    }
  }
  if (e.closedOrder.length > 3 * HOT_CLOSED_JOB_CAP && Game.time - lastClosedOrderWarnTick >= CLOSED_ORDER_WARN_INTERVAL) {
    lastClosedOrderWarnTick = Game.time;
    console.log("[marketEconomics] hot closedOrder=" + e.closedOrder.length + " over cap=" + HOT_CLOSED_JOB_CAP + " quarantined=" + Object.keys(__f).length + "; run marketEconomicsArchiveRetry()");
  }
  if (__removed > 0) memoryManager.requestSave();
  return __removed;
}

function archiveRetentionTick() {
  var e = archiveRetentionTelemetry();
  if (Game.cpu && typeof Game.cpu.bucket === "number" && Game.cpu.bucket < 1e3) {
    return {
      state: "deferred",
      reason: "low bucket"
    };
  }
  if (e.lastScanTick !== null && Game.time - e.lastScanTick < FINAL_ARCHIVE_SCAN_INTERVAL) {
    return {
      state: "deferred",
      reason: "scan interval"
    };
  }
  e.lastScanTick = Game.time;
  pruneArchiveFailures(ensureMemory());
  var r = storage.cold.status();
  if (r && r.active) return {
    state: "deferred",
    reason: "cold write active"
  };
  var t = ensureMemory();
  var i = collectFinalArchiveCandidates().candidates;
  var a = [];
  for (var n = 0; n < i.length; n++) {
    var o = i[n];
    var s = finalArchiveProtectionReason(t, o.key, o.jobId);
    if (s) continue;
    try {
      var l = storage.cold.remove(o.key);
      if (!l) continue;
      e.deleted++;
      a.push(o.key);
      e.lastDeleted = {
        key: o.key,
        jobId: o.jobId,
        tick: Game.time,
        bytes: o.bytes,
        flags: o.flags
      };
      e.lastError = null;
      if (a.length >= FINAL_ARCHIVE_DELETE_LIMIT) break;
    } catch (r) {
      e.lastError = r && r.message ? r.message : String(r);
      e.lastBatchCount = a.length;
      return {
        state: "error",
        key: o.key,
        deleted: a.length,
        message: e.lastError
      };
    }
  }
  if (a.length > 0) {
    e.lastBatchCount = a.length;
    if (Game.time % 100 === 0) {
      console.log("[marketEconomics] pruned " + a.length + " final archive(s); totalDeleted=" + e.deleted);
    }
    return {
      state: "deleted",
      count: a.length,
      keys: a
    };
  }
  return {
    state: "idle"
  };
}

function archivePurgePreview() {
  var e = inspectFinalArchiveRetention(ensureMemory());
  var r = {
    retentionTicks: FINAL_ARCHIVE_RETENTION_TICKS,
    retentionHours: FINAL_ARCHIVE_RETENTION_TICKS * 3 / 3600,
    scanIntervalTicks: FINAL_ARCHIVE_SCAN_INTERVAL,
    deleteLimitPerScan: FINAL_ARCHIVE_DELETE_LIMIT,
    finalPresent: e.finalPresent,
    finalBytes: e.finalBytes,
    finalFlags: e.finalFlags,
    ageEligible: e.ageEligible,
    eligibleForDeletion: e.eligibleForDeletion,
    eligibleBytes: e.eligibleBytes,
    eligibleFlags: e.eligibleFlags,
    oldestEligibleTick: e.oldestEligibleTick,
    pinnedSkipped: e.pinnedSkipped,
    protectedSkipped: e.protectedSkipped,
    sampleKeys: e.candidates.slice(0, 10).map(function(e) {
      return e.key;
    })
  };
  console.log("[marketEconomics] archive purge preview " + JSON.stringify(r));
  return r;
}

function archiveStatus() {
  var e = ensureMemory();
  var r = e.archive.active;
  var t = inspectFinalArchiveRetention(e);
  var i = t.finalPresent;
  var a = 0;
  var n = memoryManager.storage.cold.keys();
  for (var o = 0; o < n.length; o++) {
    if (n[o].indexOf(SETTLEMENT_BASE_KEY_PREFIX) === 0) a++;
  }
  var s = {
    hotClosed: e.closedOrder.length,
    hotTarget: HOT_CLOSED_JOB_CAP,
    archivedLifetime: e.archive.archived,
    archivedPresent: i,
    settlementsHot: Object.keys(e.settlements).length,
    settlementBasesPresent: a,
    settledLifetime: e.archive.settled || 0,
    quarantined: Object.keys(e.archive.failures).length,
    failures: e.archive.failures,
    active: r || null,
    last: e.archive.last || null
  };
  s.retention = {
    retentionTicks: FINAL_ARCHIVE_RETENTION_TICKS,
    retentionHours: FINAL_ARCHIVE_RETENTION_TICKS * 3 / 3600,
    scanIntervalTicks: FINAL_ARCHIVE_SCAN_INTERVAL,
    deleteLimitPerScan: FINAL_ARCHIVE_DELETE_LIMIT,
    finalBytes: t.finalBytes,
    finalFlags: t.finalFlags,
    ageEligible: t.ageEligible,
    eligibleForDeletion: t.eligibleForDeletion,
    eligibleBytes: t.eligibleBytes,
    eligibleFlags: t.eligibleFlags,
    oldestEligibleTick: t.oldestEligibleTick,
    pinnedSkipped: t.pinnedSkipped,
    protectedSkipped: t.protectedSkipped,
    lastDeleted: archiveRetentionTelemetry().lastDeleted,
    lastBatchCount: archiveRetentionTelemetry().lastBatchCount,
    lastScanTick: archiveRetentionTelemetry().lastScanTick,
    lastError: archiveRetentionTelemetry().lastError
  };
  console.log("[marketEconomics] archive " + JSON.stringify(s));
  return s;
}

function retentionStatus() {
  var e = ensureMemory();
  var r = {};
  for (var t in e) {
    try {
      r[t] = JSON.stringify(e[t]).length;
    } catch (e) {
      r[t] = -1;
    }
  }
  var i = {
    total: 0,
    settlement: 0,
    active: 0,
    selling: 0,
    terminalDetailed: 0,
    terminalCompact: 0,
    sellLotBlocked: 0,
    referencedActive: 0,
    referencedSelling: 0,
    terminalDelayedBlocked: 0,
    archiveEligible: 0,
    unpricedReconciled: 0,
    unresolvedLotsReleased: 0
  };
  for (var a in e.jobs) {
    if (!e.jobs.hasOwnProperty(a) || !e.jobs[a]) continue;
    var n = e.jobs[a];
    i.total++;
    if (n.status === "active") i.active++; else if (n.status === "selling") i.selling++; else if (n.phase) i.terminalDetailed++; else i.terminalCompact++;
    if (hasSellLotForJob(e, a)) i.sellLotBlocked++;
    var o = hasDelayedJobReference(e, a);
    if (o && n.status === "active") i.referencedActive++; else if (o && n.status === "selling") i.referencedSelling++; else if (o && n.phase && !hasSellLotForJob(e, a)) i.terminalDelayedBlocked++;
    if (isArchiveEligible(e, a)) i.archiveEligible++;
    if (n.reconciliation && n.reconciliation.unpricedSaleAmount > 0) i.unpricedReconciled++;
    if (n.reconciliation && n.reconciliation.unresolvedLotAmount > 0) i.unresolvedLotsReleased++;
  }
  for (var s in e.settlements) {
    if (!e.settlements.hasOwnProperty(s) || !e.settlements[s]) continue;
    var l = e.settlements[s];
    i.total++;
    i.settlement = (i.settlement || 0) + 1;
    if (l.status === "active") i.active++; else if (l.status === "selling") i.selling++; else i.terminalCompact++;
    if (hasSellLotForJob(e, s)) i.sellLotBlocked++;
    var c = hasDelayedJobReference(e, s);
    if (c && l.status === "selling") i.referencedSelling++; else if (c && l.status !== "active") i.terminalDelayedBlocked++;
    if (isArchiveEligible(e, s)) i.archiveEligible++;
    if (l.reconciliation && l.reconciliation.unpricedSaleAmount > 0) i.unpricedReconciled++;
    if (l.reconciliation && l.reconciliation.unresolvedLotAmount > 0) i.unresolvedLotsReleased++;
  }
  var u = 0;
  var d = 0;
  var f = 0;
  for (var m in e.orderLots) {
    if (!e.orderLots.hasOwnProperty(m) || !e.orderLots[m]) continue;
    u++;
    var v = e.orderLots[m].lots || [];
    d += v.length;
    for (var p = 0; p < v.length; p++) if (v[p] && v[p].jobId) f++;
  }
  var g = {
    bytes: r,
    jobs: i,
    closedOrder: e.closedOrder.length,
    processedTransactions: Object.keys(e.processedTransactions).length,
    orderLots: {
      records: u,
      lots: d,
      ownedLots: f
    },
    archive: {
      active: e.archive.active || null,
      quarantined: Object.keys(e.archive.failures).length,
      archivedLifetime: e.archive.archived
    }
  };
  console.log("[marketEconomics] retention " + JSON.stringify(g));
  return g;
}

function retryArchive(e) {
  var r = ensureMemory();
  var t = r.archive.failures;
  if (!e) e = Object.keys(t)[0];
  var i = e && t[e];
  if (!i && e) i = t[settlementBaseKey(e)];
  if (!i) return "[marketEconomics] no quarantined archive to retry";
  if (r.archive.active) return "[marketEconomics] wait for the active archive before retrying";
  var a = memoryManager.storage.cold.status(i.key);
  if (a.state === "failed") {
    return "[marketEconomics] remove failed block " + a.id + " with flagVault.remove(id, id), then retry";
  }
  if (a.state === "committed") {
    return '[marketEconomics] immutable key is committed; remove it with require("memoryManager").storage.cold.remove("' + i.key + '"), wait one tick, then retry';
  }
  r.archive.active = {
    jobId: i.jobId,
    key: i.key,
    kind: i.kind || "final",
    state: "waiting",
    startedTick: Game.time,
    attempts: 0,
    lastAttemptTick: null,
    lastError: null
  };
  delete t[e];
  delete t[i.key];
  memoryManager.requestSave();
  return "[marketEconomics] archive retry armed for " + i.key;
}

function compactTerminalJobs(e) {
  var r = false;
  for (var t in e.jobs) {
    if (!e.jobs.hasOwnProperty(t)) continue;
    var i = e.jobs[t];
    if (!i || !i.phase || i.status === "active" || i.status === "selling") continue;
    if (hasSellLotForJob(e, t) || hasDelayedJobReference(e, t)) continue;
    var a = i.expected && i.expected.creditsPerTick;
    if (a != null) i.expected = {
      creditsPerTick: a
    }; else delete i.expected;
    delete i.links;
    delete i.phase;
    delete i.input;
    delete i.output;
    delete i.fees;
    delete i.partial;
    delete i.reason;
    r = true;
  }
  return r;
}

function normalizeSellingStatuses(e) {
  var r = false;
  for (var t in e.jobs) {
    if (!e.jobs.hasOwnProperty(t)) continue;
    var i = e.jobs[t];
    if (i && i.status === "active" && i.phase && i.phase.current === "selling") {
      i.status = "selling";
      r = true;
    }
  }
  return r;
}

function pruneProcessedTransactions(e) {
  var r = {};
  var t = Game.market.outgoingTransactions || [];
  var i = Game.market.incomingTransactions || [];
  for (var a = 0; a < t.length; a++) {
    r[transactionKey(t[a], "out")] = true;
  }
  for (var n = 0; n < i.length; n++) {
    r[transactionKey(i[n], "in")] = true;
  }
  var o = false;
  for (var s in e.processedTransactions) {
    if (!r[s]) {
      delete e.processedTransactions[s];
      o = true;
    }
  }
  return o;
}

function run() {
  var e = ensureMemory();
  var r = reconcileClosedJobs(e);
  if (normalizeSellingStatuses(e)) r = true;
  if (compactExistingJobs(e)) r = true;
  if (compactJobDefaults(e)) r = true;
  if (compactResourceRecords(e)) r = true;
  if (compactOrderLots(e)) r = true;
  if (cleanupRefusedJobsAndUnownedLots(e)) r = true;
  if (compactCreditPrecision(e)) r = true;
  if (e.v < VERSION) {
    memoryManager.hydrateMarketEconomicsRoot(e);
    e.v = VERSION;
    r = true;
  }
  if (!Game.market || !Game.market.orders) {
    if (r) memoryManager.requestSave();
    return;
  }
  if (Game.time % ORPHAN_RECONCILE_INTERVAL === 0 && reconcileOrphanedJobs(e)) r = true;
  if (processSellTransactions(e)) r = true;
  var t = Game.market.incomingTransactions || [];
  var i = getModule("marketBuy");
  var a = i && typeof i.getManagedOrderRecords === "function" ? i.getManagedOrderRecords() : {};
  for (var n = 0; n < t.length; n++) {
    var o = t[n];
    if (!o || !o.order || !o.order.id) continue;
    var s = transactionKey(o, "in");
    if (e.processedTransactions[s]) continue;
    var l = a[o.order.id];
    if (!l || !l.jobId) continue;
    recordBuy(l.jobId, o.resourceType, o.amount || 0, (o.amount || 0) * (o.order.price || 0), 0, 0);
    e.processedTransactions[s] = Game.time;
    r = true;
  }
  if (compactTerminalJobs(e)) r = true;
  if (pruneProcessedTransactions(e)) r = true;
  if (Game.time % ORDER_LOT_CLEANUP_INTERVAL === 0) {
    if (reconcileOrderLots(e)) r = true;
  }
  if (r) memoryManager.requestSave();
}

global.marketEconomicsStatus = function() {
  return status();
};
global.marketEconomicsJob = function(e) {
  return jobDetail(e);
};
global.marketEconomicsArchiveStatus = function() {
  archiveStatus();
  return "[marketEconomics] archive status printed";
};
global.marketEconomicsArchivePurgePreview = function() {
  archivePurgePreview();
  return "[marketEconomics] archive purge preview printed";
};
global.marketEconomicsArchiveRetry = function(e) {
  return retryArchive(e);
};
global.marketEconomicsRetentionStatus = function() {
  retentionStatus();
  return "[marketEconomics] retention status printed";
};
module.exports = {
  ensureMemory: ensureMemory,
  mintJobId: mintJobId,
  start: start,
  get: get,
  link: link,
  phase: phase,
  recordBuy: recordBuy,
  recordOwnedOpportunity: recordOwnedOpportunity,
  recordProduction: recordProduction,
  recordSale: recordSale,
  recordFee: recordFee,
  attachSellLot: attachSellLot,
  moveSellLots: moveSellLots,
  seedUnownedSellLot: seedUnownedSellLot,
  claimUnownedSellLot: claimUnownedSellLot,
  releaseClaimedSellLot: releaseClaimedSellLot,
  releaseSellOrderLots: releaseSellOrderLots,
  getSellLotRemaining: getSellLotRemaining,
  getOrderLots: getOrderLots,
  hasSellLotForJob: function(e) {
    return hasSellLotForJob(ensureMemory(), e);
  },
  allocateSale: allocateSale,
  finish: finish,
  getLearnedDuration: getLearnedDuration,
  status: status,
  jobDetail: jobDetail,
  archiveTick: archiveTick,
  archiveRetentionTick: archiveRetentionTick,
  archiveStatus: archiveStatus,
  archivePurgePreview: archivePurgePreview,
  retryArchive: retryArchive,
  retentionStatus: retentionStatus,
  run: run
};
