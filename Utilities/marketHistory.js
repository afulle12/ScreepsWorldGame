// LLM: Read docs/codex.js before reviewing or changing this file.
// marketHistory.js
// Console globals: marketHistoryStatus
// Example: marketHistoryStatus() - Display market historical price tracking status
// Example: marketHistoryStatus();
const memoryManager = require("memoryManager");
const storage = memoryManager.storage;
const pricing = require("marketPricing");
const util = require("util");
const TRACKED_MARKET_RESOURCES = [ "energy", "power", "H", "O", "U", "L", "K", "Z", "X", "G", "metal", "biomass", "silicon", "mist", "utrium_bar", "lemergium_bar", "zynthium_bar", "keanium_bar", "ghodium_melt", "oxidant", "reductant", "purifier", "battery", "wire", "cell", "alloy", "condensate", "composite", "tube", "phlegm", "switch", "concentrate", "OH", "ZK", "UL", "UH", "UO", "KH", "KO", "LH", "LO", "ZH", "ZO", "GH", "GO", "UH2O", "UHO2", "KH2O", "KHO2", "LH2O", "LHO2", "ZH2O", "ZHO2", "GH2O", "GHO2", "XUH2O", "XUHO2", "XKH2O", "XKHO2", "XLH2O", "XLHO2", "XZH2O", "XZHO2", "XGH2O", "XGHO2" ];
const TRANSACTION_RETENTION_DAYS = 30;
const MARKET_TARGET_DAYS = 60;
const MARKET_HARD_FLOOR_DAYS = 45;
const VERSION = 1;
const PRICE_SCALE = 1e3;
const RANGE_SCALE = 1e4;
const TX_PREFIX = "mh.t1:";
const MARKET_PREFIX = "mh.m1:";
const STATE_DATASET = "marketHistory.state";
storage.register(STATE_DATASET, {
  path: "Memory.marketHistory",
  owner: "marketHistory.js",
  mutability: "mutable"
});
function state() {
  const e = storage.ensure(STATE_DATASET, function() {
    return {
      v: VERSION,
      q: [],
      last: null,
      error: null
    };
  });
  let t = false;
  if (e.v !== VERSION) e.v = VERSION;
  if (!Array.isArray(e.q)) e.q = [];
  for (const r of [ "c", "m", "retry" ]) {
    if (Object.prototype.hasOwnProperty.call(e, r)) {
      delete e[r];
      t = true;
    }
  }
  if (t) saveState();
  return e;
}

function saveState() {
  memoryManager.requestSave();
}

function ymdKey(e) {
  return String(e || "").replace(/-/g, "");
}

function txKey(e) {
  return TX_PREFIX + ymdKey(e);
}

function marketKey(e, t) {
  return MARKET_PREFIX + ymdKey(e) + ":" + t;
}

function parseTxKey(e) {
  const t = /^mh\.t1:(\d{8})$/.exec(e || "");
  return t ? {
    key: e,
    date: t[1]
  } : null;
}

function parseMarketKey(e) {
  const t = /^mh\.m1:(\d{8})(?::(\d+))?$/.exec(e || "");
  if (!t) return null;
  return {
    key: e,
    date: t[1],
    generation: t[2] === undefined ? 0 : Number(t[2])
  };
}

function coldStatus(e) {
  try {
    return storage.cold.status(e);
  } catch (e) {
    return {
      state: "error",
      message: e && e.message ? e.message : String(e)
    };
  }
}

function publishIfMissing(e, t) {
  const r = coldStatus(e);
  if (r.state !== "missing") return r;
  try {
    return storage.cold.publish(e, t, {
      noEvict: true,
      pin: true
    });
  } catch (e) {
    return {
      state: "error",
      message: e && e.message ? e.message : String(e)
    };
  }
}

function queueSnapshot(e, t, r) {
  const n = coldStatus(t);
  if (n.state === "committed") return n;
  let s = null;
  for (let r = 0; r < e.q.length; r++) {
    if (e.q[r] && e.q[r].k === t) {
      s = e.q[r];
      break;
    }
  }
  if (!s) {
    s = {
      k: t,
      p: r,
      retry: 0
    };
    e.q.push(s);
  }
  if (n.state === "queued") return n;
  if (n.state === "failed") {
    if (Game.time < (s.retry || 0)) return n;
    try {
      storage.cold.discard(t);
    } catch (r) {
      e.error = "failed cold block cleanup for " + t + ": " + (r && r.message ? r.message : String(r));
    }
    s.retry = Game.time + 1;
    saveState();
    return n;
  }
  if (n.state === "missing" && Game.time >= (s.retry || 0)) {
    const n = publishIfMissing(t, r);
    if (n.state === "error" || n.state === "failed") {
      e.error = n.message || "cold write failed for " + t;
    }
    saveState();
    return n;
  }
  return n;
}

function servicePending(e) {
  for (let t = e.q.length - 1; t >= 0; t--) {
    const r = e.q[t];
    if (!r || !r.k) {
      e.q.splice(t, 1);
      continue;
    }
    const n = coldStatus(r.k);
    if (n.state === "committed") {
      e.q.splice(t, 1);
      saveState();
      continue;
    }
    queueSnapshot(e, r.k, r.p);
  }
}

function scalePrice(e) {
  return typeof e === "number" && isFinite(e) && e > 0 ? Math.round(e * PRICE_SCALE) : 0;
}

function scaleRange(e) {
  return typeof e === "number" && isFinite(e) && e >= 0 ? Math.round(e * RANGE_SCALE) : -1;
}

function compactFinance(e) {
  const t = {};
  const r = e.income || {};
  const n = e.expenses || {};
  const s = e.incomeUnits || {};
  const o = e.expenseUnits || {};
  for (const e in r) t[e] = true;
  for (const e in n) t[e] = true;
  const a = Object.keys(t).sort();
  const i = [];
  for (let e = 0; e < a.length; e++) {
    const t = a[e];
    const c = s[t] || 0;
    const u = o[t] || 0;
    if (!(c > 0) && !(u > 0)) continue;
    const l = r[t] || 0;
    const f = n[t] || 0;
    i.push([ t, Math.round(c), c > 0 ? Math.round(l / c * PRICE_SCALE) : 0, Math.round(u), u > 0 ? Math.round(f / u * PRICE_SCALE) : 0 ]);
  }
  let c = e.totalSalesTx || 0;
  let u = e.totalPurchasesTx || 0;
  const l = e.transfers || {};
  const f = e.txHistoryOverflows || {};
  const m = Math.round(e.totalFees || 0);
  const d = (e.startingBalance || 0) + (e.totalIncome || 0) - (e.totalExpenses || 0) - (e.totalFees || 0);
  const g = Math.round((Game.market.credits || 0) - d);
  const y = [ m, l.outgoing || 0, l.incoming || 0, f.outgoing || 0, f.incoming || 0, g ];
  const E = {
    v: VERSION,
    r: i
  };
  if (c || u) E.n = [ c, u ];
  if (y.some(function(e) {
    return e !== 0;
  })) E.q = y;
  return E;
}

function utcDateString() {
  return (new Date).toISOString().slice(0, 10);
}

function resourceList() {
  return TRACKED_MARKET_RESOURCES.slice();
}

function latestCompletedHistory(e, t) {
  let r = null;
  const n = {};
  for (let s = 0; s < e.length; s++) {
    const o = e[s];
    let a;
    try {
      a = pricing.getHistDays(o) || [];
    } catch (e) {
      a = [];
    }
    n[o] = a;
    for (let e = 0; e < a.length; e++) {
      const n = a[e];
      if (!n || typeof n.date !== "string" || n.date >= t) continue;
      if (typeof n.avgPrice !== "number" || typeof n.volume !== "number") continue;
      if (r === null || n.date > r) r = n.date;
    }
  }
  return {
    date: r,
    histories: n
  };
}

function currentPrice(e) {
  if (!e) return null;
  if (typeof e.wmp === "number" && isFinite(e.wmp) && e.wmp > 0) return e.wmp;
  if (typeof e.bestBid === "number" && isFinite(e.bestBid) && e.bestBid > 0) return e.bestBid;
  if (typeof e.bestAsk === "number" && isFinite(e.bestAsk) && e.bestAsk > 0) return e.bestAsk;
  return null;
}

function compactMarket() {
  const e = resourceList();
  const t = utcDateString();
  const r = latestCompletedHistory(e, t);
  if (!r.date) return null;
  const n = [];
  for (let t = 0; t < e.length; t++) {
    const s = e[t];
    const o = r.histories[s] || [];
    let a = null;
    for (let e = 0; e < o.length; e++) {
      if (o[e] && o[e].date === r.date) {
        a = o[e];
        break;
      }
    }
    if (!a) continue;
    let i;
    try {
      i = pricing.getBook(s);
    } catch (e) {
      i = null;
    }
    const c = currentPrice(i);
    const u = scalePrice(c);
    let l = null;
    try {
      l = pricing.getRange7d(s);
    } catch (e) {}
    n.push([ s, scalePrice(a.avgPrice), Math.round(a.volume), u, scalePrice(i && i.bestBid), scalePrice(i && i.bestAsk), scaleRange(l) ]);
  }
  if (n.length === 0) return null;
  return {
    date: r.date,
    payload: {
      v: VERSION,
      s: Game.time,
      r: n
    }
  };
}

function nextMarketGeneration(e) {
  let t = 0;
  const r = storage.cold.keys();
  for (let n = 0; n < r.length; n++) {
    const s = parseMarketKey(r[n]);
    if (s && s.date === ymdKey(e)) t = Math.max(t, s.generation + 1);
  }
  return t;
}

function archiveDay(e) {
  if (!e || !e.dateString) return {
    queued: false,
    reason: "missing finance day"
  };
  const t = state();
  const r = txKey(e.dateString);
  let n;
  try {
    const s = compactFinance(e);
    n = queueSnapshot(t, r, s);
  } catch (e) {
    t.error = "transaction snapshot failed: " + (e && e.message ? e.message : String(e));
    saveState();
    throw e;
  }
  let s = {
    state: "missing",
    message: "no completed market history"
  };
  try {
    const e = compactMarket();
    if (e) {
      const r = activeMarketEntries().filter(function(t) {
        return t.date === ymdKey(e.date);
      })[0];
      if (r) {
        s = {
          state: "committed",
          key: r.key,
          message: "already archived"
        };
      } else {
        const r = marketKey(e.date, nextMarketGeneration(e.date));
        s = queueSnapshot(t, r, e.payload);
      }
    }
  } catch (e) {
    t.error = "market snapshot failed: " + (e && e.message ? e.message : String(e));
    saveState();
    throw e;
  }
  const o = {
    transactionKey: r,
    transaction: n,
    market: s
  };
  t.last = {
    day: ymdKey(e.dateString),
    tick: Game.time
  };
  if (n.state === "error" || s.state === "error") {
    t.error = n.message || s.message || "archive queue error";
  }
  saveState();
  return o;
}

function coldKeys(e) {
  const t = storage.cold.keys();
  const r = [];
  for (let n = 0; n < t.length; n++) {
    const s = e(t[n]);
    if (s) r.push(s);
  }
  r.sort(function(e, t) {
    return e.date.localeCompare(t.date) || e.key.localeCompare(t.key);
  });
  return r;
}

function activeMarketEntries() {
  const e = {};
  const t = coldKeys(parseMarketKey);
  for (let r = 0; r < t.length; r++) {
    const n = t[r];
    if (!e[n.date] || n.generation > e[n.date].generation) e[n.date] = n;
  }
  return Object.keys(e).sort().map(function(t) {
    return e[t];
  });
}

function dateNumber(e) {
  return Date.UTC(Number(e.slice(0, 4)), Number(e.slice(4, 6)) - 1, Number(e.slice(6, 8)));
}

function ageDays(e, t) {
  return Math.floor((dateNumber(t) - dateNumber(e)) / 864e5);
}

function removeColdKey(e) {
  const t = storage.cold.meta(e);
  if (!t) return false;
  if (t.pinned) storage.cold.unpin(e);
  storage.cold.remove(e);
  return true;
}

function purgeRetention() {
  const e = util.pacificDayKey();
  const t = utcDateString().replace(/-/g, "");
  const r = coldKeys(parseTxKey);
  for (let t = 0; t < r.length; t++) {
    if (ageDays(r[t].date, e) > TRANSACTION_RETENTION_DAYS) {
      removeColdKey(r[t].key);
      return true;
    }
  }
  const n = activeMarketEntries();
  for (let e = 0; e < n.length; e++) {
    if (ageDays(n[e].date, t) > MARKET_TARGET_DAYS) {
      removeColdKey(n[e].key);
      return true;
    }
  }
  return false;
}

function pendingHistoryWrite() {
  const e = storage.cold.status();
  if (!e || !e.active || typeof e.key !== "string") return null;
  if (e.key.indexOf(TX_PREFIX) !== 0 && e.key.indexOf(MARKET_PREFIX) !== 0) return null;
  if (typeof e.estimatedFlags !== "number") return null;
  return e;
}

function purgeForPendingWrite() {
  const e = pendingHistoryWrite();
  if (!e) return false;
  const t = storage.cold.capacity();
  if (t.free >= e.estimatedFlags) return false;
  const r = util.pacificDayKey();
  const n = coldKeys(parseTxKey);
  const s = n.filter(function(e) {
    return ageDays(e.date, r) > TRANSACTION_RETENTION_DAYS;
  });
  if (s.length > 0) return removeColdKey(s[0].key);
  const o = utcDateString().replace(/-/g, "");
  const a = activeMarketEntries();
  for (let e = 0; e < a.length; e++) {
    if (ageDays(a[e].date, o) > MARKET_TARGET_DAYS) {
      return removeColdKey(a[e].key);
    }
  }
  for (let e = 0; e < a.length; e++) {
    if (ageDays(a[e].date, o) > MARKET_HARD_FLOOR_DAYS) {
      return removeColdKey(a[e].key);
    }
  }
  return false;
}

function tick() {
  const e = state();
  servicePending(e);
  purgeRetention();
  purgeForPendingWrite();
}

function status() {
  const e = state();
  const t = coldKeys(parseTxKey);
  const r = activeMarketEntries();
  const n = {
    trackedResources: TRACKED_MARKET_RESOURCES.length,
    marketRetentionDays: MARKET_TARGET_DAYS,
    marketHardFloorDays: MARKET_HARD_FLOOR_DAYS,
    transactionRecords: t.length,
    marketRecords: r.length,
    pendingWrites: e.q.length,
    oldestTransaction: t.length ? t[0].date : null,
    oldestMarket: r.length ? r[0].date : null,
    last: e.last || null,
    error: e.error || null,
    capacity: storage.cold.capacity()
  };
  console.log("[marketHistory] " + JSON.stringify(n));
  return n;
}

global.marketHistoryStatus = function() {
  return status();
};
module.exports = {
  archiveDay: archiveDay,
  tick: tick,
  status: status,
  TRACKED_MARKET_RESOURCES: TRACKED_MARKET_RESOURCES,
  TRANSACTION_RETENTION_DAYS: TRANSACTION_RETENTION_DAYS,
  MARKET_TARGET_DAYS: MARKET_TARGET_DAYS,
  MARKET_HARD_FLOOR_DAYS: MARKET_HARD_FLOOR_DAYS
};
