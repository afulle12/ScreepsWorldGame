// LLM: Read docs/codex.js before reviewing or changing this file.
// marketSpeculator.js
// Console globals: marketSpeculator, marketSpeculatorStatus, marketSpeculatorConfig, marketSpeculatorJSON, marketSpeculatorScan, marketSpeculatorScanJSON, marketSpeculatorAnalyze
// Example: marketSpeculator('status') - Run or query market speculation engine
// Example: marketSpeculatorStatus() - Display speculation portfolio and position status
// Example: marketSpeculatorConfig({ maxCredits: 1000000 }) - Configure speculator parameters
// Example: marketSpeculatorJSON() - Export speculation state formatted as JSON
// Example: marketSpeculatorScan() - Run market scan for speculation entry opportunities
// Example: marketSpeculatorScanJSON() - Export speculation scan results as JSON
// Example: marketSpeculatorAnalyze(RESOURCE_OXYGEN) - Analyze speculation outlook for resource
//   marketSpeculator('XGH2O', 1000)             - readable simulation report
//   marketSpeculatorJSON('XGH2O', 1000)         - pretty JSON report
//   marketSpeculatorScan(1000)                  - ranked batch simulation report
//   marketSpeculatorScanJSON(1000)              - batch report as JSON
//   marketSpeculatorScan({ amount: 1000, includeWatch: true, limit: 50 })
//   marketSpeculatorConfig()                   - model defaults
//   {
//     horizons: [1, 3, 7],
//     conservativeQuantile: 0.25,
//     minWinRate: 0.60,
//     minConservativeNetPct: 0.05,
//     buyFeePct: 0.05,
//     sellFeePct: 0,
//     exitSlippagePct: 0.02,
//     energyCostPerUnit: 0
//   }
var pricing = require("marketPricing");
var util = require("util");
var DEFAULTS = {
  defaultAmount: 1e3,
  horizons: [ 1, 2, 3, 5, 7 ],
  minHistoryDays: 10,
  minRecentValidDays: 4,
  minForwardSamples: 5,
  conservativeQuantile: .25,
  minWinRate: .6,
  minConservativeNetPct: .05,
  maxCandidateRange: .2,
  maxAskToEntryMultiple: 1.5,
  buyFeePct: typeof pricing.FEE === "number" ? pricing.FEE : .05,
  sellFeePct: 0,
  exitSlippagePct: .02,
  energyCostPerUnit: 0
};
var ACCOUNT_RESOURCES = {
  energy: true,
  power: true,
  ops: true,
  pixel: true,
  cpu_unlock: true,
  cpuUnlock: true,
  access_key: true,
  accessKey: true,
  token: true
};
var BATCH_DEFAULTS = {
  amount: DEFAULTS.defaultAmount,
  limit: 20,
  includeWatch: false,
  includeRejected: false
};
function finiteNumber(e) {
  return typeof e === "number" && isFinite(e);
}

function cloneDefaults() {
  var e = {};
  for (var t in DEFAULTS) {
    if (!DEFAULTS.hasOwnProperty(t)) continue;
    e[t] = Array.isArray(DEFAULTS[t]) ? DEFAULTS[t].slice() : DEFAULTS[t];
  }
  return e;
}

function normalizeOptions(e) {
  var t = cloneDefaults();
  e = e || {};
  if (Array.isArray(e.horizons)) {
    t.horizons = e.horizons.filter(function(e) {
      return Number.isSafeInteger(e) && e > 0;
    }).sort(function(e, t) {
      return e - t;
    }).filter(function(e, t, r) {
      return t === 0 || e !== r[t - 1];
    });
  }
  if (!t.horizons.length) t.horizons = DEFAULTS.horizons.slice();
  var r = [ "minHistoryDays", "minRecentValidDays", "minForwardSamples", "conservativeQuantile", "minWinRate", "minConservativeNetPct", "maxCandidateRange", "maxAskToEntryMultiple", "buyFeePct", "sellFeePct", "exitSlippagePct", "energyCostPerUnit" ];
  for (var n = 0; n < r.length; n++) {
    var a = r[n];
    if (finiteNumber(e[a]) && e[a] >= 0) t[a] = e[a];
  }
  t.conservativeQuantile = Math.min(1, t.conservativeQuantile);
  t.minWinRate = Math.min(1, t.minWinRate);
  t.maxCandidateRange = Math.min(10, t.maxCandidateRange);
  t.maxAskToEntryMultiple = Math.max(1, t.maxAskToEntryMultiple);
  t.buyFeePct = Math.min(1, t.buyFeePct);
  t.sellFeePct = Math.min(.99, t.sellFeePct);
  t.exitSlippagePct = Math.min(.99, t.exitSlippagePct);
  return t;
}

function dateOrdinal(e) {
  if (typeof e !== "string") return null;
  var t = Date.parse(e + "T00:00:00Z");
  return isFinite(t) ? Math.floor(t / 864e5) : null;
}

function validHistoryEntry(e) {
  return !!(e && typeof e.date === "string" && finiteNumber(e.avgPrice) && e.avgPrice > 0 && finiteNumber(e.volume) && e.volume > 0);
}

function getHistory(e) {
  var t = pricing.getHistDays(e) || [];
  var r = [];
  var n = {};
  for (var a = 0; a < t.length; a++) {
    var i = t[a];
    if (!validHistoryEntry(i)) continue;
    var o = dateOrdinal(i.date);
    if (o === null) continue;
    var l = {
      date: i.date,
      ordinal: o,
      avgPrice: i.avgPrice,
      volume: i.volume
    };
    r.push(l);
    n[o] = l;
  }
  r.sort(function(e, t) {
    return e.ordinal - t.ordinal;
  });
  var s = 0;
  var c = Math.max(0, t.length - 7);
  for (var u = c; u < t.length; u++) {
    if (validHistoryEntry(t[u]) && dateOrdinal(t[u].date) !== null) s++;
  }
  return {
    rawDays: t.length,
    validDays: r.length,
    recentValidDays: s,
    records: r,
    byOrdinal: n,
    firstDate: r.length ? r[0].date : null,
    lastDate: r.length ? r[r.length - 1].date : null,
    coverageDays: r.length > 1 ? r[r.length - 1].ordinal - r[0].ordinal + 1 : r.length
  };
}

function quantile(e, t) {
  if (!e.length) return null;
  var r = e.slice().sort(function(e, t) {
    return e - t;
  });
  var n = (r.length - 1) * t;
  var a = Math.floor(n);
  var i = Math.ceil(n);
  if (a === i) return r[a];
  return r[a] + (r[i] - r[a]) * (n - a);
}

function average(e) {
  if (!e.length) return null;
  var t = 0;
  for (var r = 0; r < e.length; r++) t += e[r];
  return t / e.length;
}

function forwardSamples(e, t) {
  var r = [];
  for (var n = 0; n < e.records.length; n++) {
    var a = e.records[n];
    var i = e.byOrdinal[a.ordinal + t];
    if (!i) continue;
    r.push({
      entryDate: a.date,
      exitDate: i.date,
      entryPrice: a.avgPrice,
      exitPrice: i.avgPrice,
      returnPct: (i.avgPrice - a.avgPrice) / a.avgPrice
    });
  }
  return r;
}

function currentEntry(e, t) {
  if (e && e.postedBuyPrice !== null && e.postedBuyPrice > 0) {
    return {
      price: Math.max(.001, Math.round(e.postedBuyPrice * 1e3) / 1e3),
      source: "canonical postedBuyPrice"
    };
  }
  return {
    price: null,
    source: "none"
  };
}

function breakEvenExit(e, t) {
  var r = e * (1 + t.buyFeePct) + t.energyCostPerUnit;
  return r / ((1 - t.sellFeePct) * (1 - t.exitSlippagePct));
}

function analyzeHorizon(e, t, r, n, a) {
  var i = e.map(function(e) {
    return e.returnPct;
  });
  var o = breakEvenExit(t, a);
  var l = o / t - 1;
  var s = quantile(i, a.conservativeQuantile);
  var c = quantile(i, .5);
  var u = 0;
  for (var d = 0; d < i.length; d++) {
    if (i[d] >= l) u++;
  }
  var m = i.length ? u / i.length : null;
  var v = s === null ? null : t * (1 + s);
  var p = c === null ? null : t * (1 + c);
  var g = v === null ? null : v * (1 - a.sellFeePct) * (1 - a.exitSlippagePct) - t * (1 + a.buyFeePct) - a.energyCostPerUnit;
  var f = p === null ? null : p * (1 - a.sellFeePct) * (1 - a.exitSlippagePct) - t * (1 + a.buyFeePct) - a.energyCostPerUnit;
  var h = g === null ? null : g / (t * (1 + a.buyFeePct) + a.energyCostPerUnit);
  var y = "INSUFFICIENT_SAMPLES";
  if (e.length >= a.minForwardSamples) {
    y = h >= a.minConservativeNetPct && m >= a.minWinRate ? "PASSIVE_CANDIDATE" : "WATCH";
  }
  return {
    horizonDays: n,
    samples: e.length,
    sampleWindow: e.length ? {
      firstEntry: e[0].entryDate,
      lastExit: e[e.length - 1].exitDate
    } : null,
    winRate: m,
    meanReturnPct: percent(average(i)),
    p25ReturnPct: percent(quantile(i, .25)),
    medianReturnPct: percent(c),
    p75ReturnPct: percent(quantile(i, .75)),
    minReturnPct: percent(i.length ? Math.min.apply(null, i) : null),
    maxReturnPct: percent(i.length ? Math.max.apply(null, i) : null),
    breakEvenExitPrice: o,
    breakEvenReturnPct: percent(l),
    conservativeExitPrice: v,
    medianExitPrice: p,
    conservativeNetPerUnit: g,
    conservativeNetTotal: g === null ? null : g * r,
    conservativeNetPct: percent(h),
    medianNetPerUnit: f,
    medianNetTotal: f === null ? null : f * r,
    status: y
  };
}

function percent(e) {
  return e === null || e === undefined ? null : e * 100;
}

function analyze(e, t, r) {
  if (typeof e !== "string" || !e) throw new Error("resource is required");
  t = t == null ? DEFAULTS.defaultAmount : Number(t);
  if (!finiteNumber(t) || t <= 0) throw new Error("amount must be greater than zero");
  t = Math.floor(t);
  r = normalizeOptions(r);
  var n = getHistory(e);
  var a = pricing.getBook(e);
  var i = pricing.getPriceProfile(e);
  var o = pricing.getAvg48h(e);
  var l = pricing.getAvg7d(e);
  var s = pricing.getRange7d(e);
  var c = pricing.getTrend7d(e);
  var u = pricing.getWeekLow(e);
  var d = currentEntry(i, r);
  var m = [];
  var v = null;
  var p = {
    rangeEligible: s !== null && s <= r.maxCandidateRange,
    askEligible: a.bestAsk !== null && d.price !== null && a.bestAsk <= d.price * r.maxAskToEntryMultiple,
    eligible: false,
    reasons: []
  };
  p.eligible = p.rangeEligible && p.askEligible;
  if (!p.rangeEligible) p.reasons.push("weekly range exceeds candidate gate");
  if (!p.askEligible) p.reasons.push("best ask is too far above passive entry");
  if (d.price !== null) {
    for (var g = 0; g < r.horizons.length; g++) {
      var f = r.horizons[g];
      var h = forwardSamples(n, f);
      var y = analyzeHorizon(h, d.price, t, f, r);
      m.push(y);
    }
  }
  if (!p.eligible) {
    for (var P = 0; P < m.length; P++) {
      if (m[P].status === "PASSIVE_CANDIDATE") m[P].status = "WATCH";
    }
  }
  for (var b = 0; b < m.length; b++) {
    if (m[b].status === "PASSIVE_CANDIDATE" && (!v || m[b].conservativeNetPct > v.conservativeNetPct)) {
      v = m[b];
    }
  }
  var S = [ "Forward returns use daily average prices, not executable historical bid/ask quotes.", "Passive entry is hypothetical; fill probability is not modeled.", "Current exit depth is a snapshot and may not exist at the future horizon." ];
  if (r.energyCostPerUnit === 0) {
    S.push("Transfer energy cost is set to zero; provide energyCostPerUnit for a landed estimate.");
  }
  if (s !== null && s > .2) {
    S.push("Weekly range exceeds the 20% high-range gate; treat candidates as high risk.");
  }
  if (a.bestAsk !== null && d.price !== null && a.bestAsk > d.price * 1.5) {
    S.push("Best ask is more than 1.5x the passive entry; the report does not recommend crossing it.");
  }
  if (a.bidVol < t) {
    S.push("Current external bid depth is below the requested amount.");
  }
  if (!p.eligible) {
    S.push("Candidate gate closed: " + p.reasons.join("; ") + ".");
  }
  var E = n.validDays >= r.minHistoryDays && n.recentValidDays >= r.minRecentValidDays;
  var R = "REJECT";
  if (!E) R = "INSUFFICIENT_HISTORY"; else if (!d.price) R = "NO_ENTRY_PRICE"; else if (v) R = "PASSIVE_CANDIDATE"; else if (m.some(function(e) {
    return e.status === "WATCH";
  })) R = "WATCH";
  return {
    version: 1,
    mode: "simulation-only",
    decision: R,
    resource: e,
    amount: t,
    entry: {
      mode: "passive",
      price: d.price,
      source: d.source,
      grossCreditCost: d.price === null ? null : d.price * t,
      modeledCreditCost: d.price === null ? null : d.price * t * (1 + r.buyFeePct),
      bestBid: a.bestBid,
      bestAsk: a.bestAsk,
      bidVolume: a.bidVol,
      askVolume: a.askVol,
      bidDepthSufficient: d.price !== null && a.bidVol >= t
    },
    market: {
      avg48h: o,
      avg7d: l,
      range7d: s,
      trend7d: c,
      weekLow: u,
      bestBid: a.bestBid,
      bestAsk: a.bestAsk,
      vwBid: a.vwBid,
      vwAsk: a.vwAsk,
      bidVol: a.bidVol,
      askVol: a.askVol,
      spread: a.spread,
      spreadPct: a.spreadPct
    },
    history: {
      rawDays: n.rawDays,
      validDays: n.validDays,
      recentValidDays: n.recentValidDays,
      firstDate: n.firstDate,
      lastDate: n.lastDate,
      coverageDays: n.coverageDays,
      ready: E
    },
    marketGate: p,
    model: {
      entrySource: "marketPricing.getPriceProfile().postedBuyPrice",
      horizons: r.horizons,
      conservativeQuantile: r.conservativeQuantile,
      minForwardSamples: r.minForwardSamples,
      minWinRatePct: percent(r.minWinRate),
      minConservativeNetPct: percent(r.minConservativeNetPct),
      maxCandidateRangePct: percent(r.maxCandidateRange),
      maxAskToEntryMultiple: r.maxAskToEntryMultiple,
      buyFeePct: percent(r.buyFeePct),
      sellFeePct: percent(r.sellFeePct),
      exitSlippagePct: percent(r.exitSlippagePct),
      energyCostPerUnit: r.energyCostPerUnit,
      breakEvenExitPrice: d.price === null ? null : breakEvenExit(d.price, r)
    },
    horizons: m,
    recommendedHorizon: v ? v.horizonDays : null,
    warnings: S
  };
}

function formatNumber(e, t) {
  if (e === null || e === undefined) return "-";
  if (!finiteNumber(e)) return "n/a";
  return e.toFixed(t == null ? 3 : t);
}

function formatPercent(e) {
  return e === null || e === undefined ? "-" : formatNumber(percent(e), 1) + "%";
}

function formatPercentValue(e) {
  return e === null || e === undefined ? "-" : formatNumber(e, 1) + "%";
}

function report(e, t, r) {
  var n = analyze(e, t, r);
  var a = [ "[marketSpeculator] SIMULATION ONLY " + n.resource + " x" + n.amount, "Decision: " + n.decision, "Passive entry: " + formatNumber(n.entry.price) + " (" + n.entry.source + ")" + " | best bid=" + formatNumber(n.entry.bestBid) + " ask=" + formatNumber(n.entry.bestAsk), "History: " + n.history.validDays + "/" + n.history.rawDays + " valid days | recent valid=" + n.history.recentValidDays + " | coverage=" + n.history.coverageDays + " days", "Reference: avg48h=" + formatNumber(n.market.avg48h) + " avg7d=" + formatNumber(n.market.avg7d) + " low=" + formatNumber(n.market.weekLow) + " range=" + formatPercent(n.market.range7d) + " trend=" + (n.market.trend7d || "-"), "Modeled break-even exit: " + formatNumber(n.model.breakEvenExitPrice) + " | current bid depth=" + formatNumber(n.entry.bidVolume, 0), "", "Horizon  samples  win@BE  p25 return  median return  conservative net  status" ];
  for (var i = 0; i < n.horizons.length; i++) {
    var o = n.horizons[i];
    a.push(String(o.horizonDays).padStart(8) + String(o.samples).padStart(9) + String(o.winRate === null ? "-" : formatPercent(o.winRate)).padStart(9) + String(formatPercentValue(o.p25ReturnPct)).padStart(12) + String(formatPercentValue(o.medianReturnPct)).padStart(15) + String(o.conservativeNetPerUnit === null ? "-" : formatNumber(o.conservativeNetPerUnit)).padStart(19) + "  " + o.status);
  }
  a.push("", "Warnings:");
  for (var l = 0; l < n.warnings.length; l++) a.push("- " + n.warnings[l]);
  var s = a.join("\n");
  return s;
}

function jsonReport(e, t, r) {
  return JSON.stringify(analyze(e, t, r), null, 2);
}

function cloneBatchDefaults() {
  var e = {};
  for (var t in BATCH_DEFAULTS) {
    if (BATCH_DEFAULTS.hasOwnProperty(t)) e[t] = BATCH_DEFAULTS[t];
  }
  return e;
}

function normalizeBatchOptions(e, t) {
  if (e && typeof e === "object") {
    t = e;
    e = t.amount;
  }
  t = t || {};
  var r = cloneBatchDefaults();
  r.amount = e == null ? BATCH_DEFAULTS.amount : Number(e);
  if (!finiteNumber(r.amount) || r.amount <= 0) throw new Error("amount must be greater than zero");
  r.amount = Math.floor(r.amount);
  if (finiteNumber(t.limit) && t.limit >= 1) r.limit = Math.floor(t.limit);
  r.includeWatch = !!t.includeWatch;
  r.includeRejected = !!t.includeRejected;
  return {
    batch: r,
    model: normalizeOptions(t)
  };
}

function isTradeableResource(e) {
  return typeof e === "string" && !!e && !ACCOUNT_RESOURCES[e];
}

function listBatchResources() {
  var e = {};
  if (typeof RESOURCES_ALL !== "undefined" && Array.isArray(RESOURCES_ALL)) {
    for (var t = 0; t < RESOURCES_ALL.length; t++) {
      if (isTradeableResource(RESOURCES_ALL[t])) e[RESOURCES_ALL[t]] = true;
    }
  }
  var r = typeof pricing.getRawOrders === "function" ? pricing.getRawOrders() : [];
  var n = {};
  for (var a = 0; a < r.length; a++) {
    var i = r[a];
    if (!i || !isTradeableResource(i.resourceType)) continue;
    if (Object.keys(e).length && !e[i.resourceType]) continue;
    var o = util.getOrderRemaining(i);
    if (!(o > 0)) continue;
    n[i.resourceType] = true;
  }
  var l = Object.keys(n);
  if (!l.length && Object.keys(e).length) l = Object.keys(e);
  return l.sort();
}

function bestHorizon(e) {
  var t = e.horizons.filter(function(t) {
    return t.samples >= e.model.minForwardSamples;
  });
  if (!t.length) return null;
  t.sort(function(e, t) {
    var r = e.status === "PASSIVE_CANDIDATE" ? 1 : 0;
    var n = t.status === "PASSIVE_CANDIDATE" ? 1 : 0;
    if (r !== n) return n - r;
    var a = e.conservativeNetPct == null ? -Infinity : e.conservativeNetPct;
    var i = t.conservativeNetPct == null ? -Infinity : t.conservativeNetPct;
    return i - a || t.samples - e.samples || e.horizonDays - t.horizonDays;
  });
  return t[0];
}

function batchRow(e) {
  var t = bestHorizon(e);
  var r = e.entry.source.indexOf("passive ") === 0;
  var n = e.decision;
  if (n === "PASSIVE_CANDIDATE" && !r) n = "WATCH";
  return {
    resource: e.resource,
    decision: n,
    horizonDays: t ? t.horizonDays : null,
    samples: t ? t.samples : 0,
    winRatePct: t && t.winRate !== null ? t.winRate * 100 : null,
    p25ReturnPct: t ? t.p25ReturnPct : null,
    medianReturnPct: t ? t.medianReturnPct : null,
    conservativeNetPct: t ? t.conservativeNetPct : null,
    conservativeNetPerUnit: t ? t.conservativeNetPerUnit : null,
    medianNetPerUnit: t ? t.medianNetPerUnit : null,
    entryPrice: e.entry.price,
    bestAsk: e.market.bestAsk,
    avg48h: e.market.avg48h,
    range7dPct: e.market.range7d === null ? null : e.market.range7d * 100,
    trend7d: e.market.trend7d,
    bidVolume: e.entry.bidVolume,
    historyReady: e.history.ready,
    livePassiveEntry: r,
    marketGateEligible: e.marketGate.eligible,
    marketGateReasons: e.marketGate.reasons
  };
}

function batchRank(e) {
  var t = e.decision === "PASSIVE_CANDIDATE" ? 3 : e.decision === "WATCH" ? 2 : 1;
  var r = e.conservativeNetPct == null ? -Infinity : e.conservativeNetPct;
  var n = e.winRatePct == null ? -Infinity : e.winRatePct;
  return {
    decisionRank: t,
    net: r,
    win: n
  };
}

function compareBatchRows(e, t) {
  var r = batchRank(e);
  var n = batchRank(t);
  return n.decisionRank - r.decisionRank || n.net - r.net || n.win - r.win || e.resource.localeCompare(t.resource);
}

function scan(e, t) {
  var r = normalizeBatchOptions(e, t);
  var n = r.batch;
  var a = r.model;
  var i = listBatchResources();
  var o = [];
  var l = [];
  for (var s = 0; s < i.length; s++) {
    var c = i[s];
    try {
      var u = analyze(c, n.amount, a);
      o.push(batchRow(u));
    } catch (e) {
      l.push({
        resource: c,
        error: e && e.message ? e.message : String(e)
      });
    }
  }
  o.sort(compareBatchRows);
  var d = o.filter(function(e) {
    return e.decision === "PASSIVE_CANDIDATE";
  });
  var m = o.filter(function(e) {
    return e.decision === "WATCH";
  });
  var v;
  if (n.includeRejected) v = o.slice(); else if (n.includeWatch) v = d.concat(m); else v = d.slice();
  v.sort(compareBatchRows);
  var p = !v.length && !n.includeRejected ? m.slice() : [];
  p.sort(compareBatchRows);
  var g = v.length ? v.slice(0, n.limit) : p.slice(0, n.limit);
  return {
    version: 1,
    mode: "simulation-only-batch",
    scope: "all tradeable non-account resources with current market orders",
    amount: n.amount,
    evaluated: o.length,
    candidates: d.length,
    watches: m.length,
    rejected: o.filter(function(e) {
      return e.decision !== "PASSIVE_CANDIDATE" && e.decision !== "WATCH";
    }).length,
    showingFallbackWatch: !v.length && p.length > 0,
    rows: g,
    errors: l,
    model: {
      horizons: a.horizons,
      minForwardSamples: a.minForwardSamples,
      minWinRatePct: a.minWinRate * 100,
      minConservativeNetPct: a.minConservativeNetPct * 100,
      maxCandidateRangePct: a.maxCandidateRange * 100,
      maxAskToEntryMultiple: a.maxAskToEntryMultiple,
      buyFeePct: a.buyFeePct * 100,
      sellFeePct: a.sellFeePct * 100,
      exitSlippagePct: a.exitSlippagePct * 100,
      energyCostPerUnit: a.energyCostPerUnit
    },
    warnings: [ "Batch rows use daily-average historical returns, not executable historical bid/ask quotes.", "Passive fill probability and adverse selection are not modeled.", "Zero energy cost is optimistic; provide energyCostPerUnit for a landed comparison.", g.length < v.length ? "Output is limited; increase limit to see more rows." : null, !d.length && p.length ? "No resource cleared the candidate thresholds; showing the best WATCH rows." : null ].filter(Boolean)
  };
}

function formatBatchRow(e) {
  return [ (e.resource + "                ").slice(0, 16), (e.decision + "                 ").slice(0, 17), String(e.horizonDays == null ? "-" : e.horizonDays).padStart(3), String(e.samples).padStart(7), String(e.winRatePct == null ? "-" : formatNumber(e.winRatePct, 1) + "%").padStart(9), String(e.p25ReturnPct == null ? "-" : formatNumber(e.p25ReturnPct, 1) + "%").padStart(10), String(e.conservativeNetPct == null ? "-" : formatNumber(e.conservativeNetPct, 1) + "%").padStart(12), String(e.conservativeNetPerUnit == null ? "-" : formatNumber(e.conservativeNetPerUnit, 1)).padStart(11), String(e.medianNetPerUnit == null ? "-" : formatNumber(e.medianNetPerUnit, 1)).padStart(12), String(e.entryPrice == null ? "-" : formatNumber(e.entryPrice, 2)).padStart(11), e.trend7d || "-" ].join(" ");
}

function scanReport(e, t) {
  var r = scan(e, t);
  var n = [ "[marketSpeculator] BATCH SIMULATION ONLY", "Scope: " + r.scope, "Amount: " + r.amount + " | Evaluated: " + r.evaluated + " | Candidates: " + r.candidates + " | Watch: " + r.watches + " | Rejected: " + r.rejected, "", "Resource         Decision           Hzn Samples   Win@BE    P25Ret     P25Net%  P25Net/u  MedianNet/u   Entry       Trend" ];
  for (var a = 0; a < r.rows.length; a++) n.push(formatBatchRow(r.rows[a]));
  if (!r.rows.length) n.push("(no rows matched the selected output mode)");
  n.push("", "Warnings:");
  for (var i = 0; i < r.warnings.length; i++) n.push("- " + r.warnings[i]);
  if (r.errors.length) n.push("- Errors: " + r.errors.length);
  var o = n.join("\n");
  return o;
}

function scanJSON(e, t) {
  return JSON.stringify(scan(e, t), null, 2);
}

global.marketSpeculator = report;
global.marketSpeculatorJSON = jsonReport;
global.marketSpeculatorAnalyze = analyze;
global.marketSpeculatorScan = scanReport;
global.marketSpeculatorScanJSON = scanJSON;
global.marketSpeculatorConfig = function() {
  return JSON.stringify({
    model: cloneDefaults(),
    batch: cloneBatchDefaults()
  }, null, 2);
};
module.exports = {
  analyze: analyze,
  report: report,
  json: jsonReport,
  scan: scan,
  scanReport: scanReport,
  scanJSON: scanJSON,
  defaults: cloneDefaults
};
