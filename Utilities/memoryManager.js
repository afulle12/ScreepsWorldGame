// LLM: Read docs/codex.js before reviewing or changing this file.
// memoryManager.js
// Console globals: memorySave, memoryReload, Memory
// Example: memorySave() - Serialize and save heap memory state
// Example: memoryReload() - Force reload memory state from serialized storage
// Example: Memory - Global Screeps memory object reference
const SAVE_INTERVAL = 10;
const MAX_CHECKPOINT_AGE = 50;
const SERIALIZATION_SAMPLE_INTERVAL = 500;
const SERIALIZATION_SAMPLE_MIN_BUCKET = 2e3;
const SERIALIZATION_COLD_START_CPU = 1;
const SERIALIZATION_RESERVE_UPDATE_INTERVAL = 10;
const SERIALIZATION_HISTORY_LENGTH = 100;
const heap = {};
const MARKET_LAB_STATE_CODES = {
  BUYING: 0,
  WAITING: 1,
  PROCESSING: 2,
  STAGING: 3,
  SELLING: 4,
  PENDING: 5
};
const MARKET_LAB_STATES = [ "BUYING", "WAITING", "PROCESSING", "STAGING", "SELLING", "PENDING" ];
const MARKET_LAB_FLAGS = {
  reactionStarted: 1,
  sellOrderCreated: 2,
  salvageMode: 4,
  buyRequestCreated: 8,
  marketBuysCancelled: 16,
  _ownedInputsRecorded: 32,
  _failed: 64,
  _completed: 128,
  _finalized: 256,
  _legacyQueueTrim: 512,
  replacementPending: 1024,
  buyCancellationPending: 2048,
  cancellationPending: 4096,
  batchMode: 8192,
  conversionOnly: 16384,
  labOrderSubmitted: 32768,
  stockpile: 65536
};
const MARKET_LAB_EXTRAS = {
  outputLabCount: "l",
  reactionStartedTick: "r",
  sellingStartTick: "g",
  buyingStartedTick: "u",
  expectedOutputs: "o",
  jobId: "j",
  _economicsPhase: "p",
  maxReagentPrices: "m",
  maxBuyPrice: "b",
  buyBaseAmounts: "B",
  buyBaseCompoundAmount: "C",
  sellRequestInfo: "q",
  sellReservationProgram: "s",
  stageReservationProgram: "t",
  stageStartTick: "T",
  useMarketBuy: "M",
  marketBuyCeilings: "c",
  marketBuyToppedUp: "U",
  lastTopUpCheck: "L",
  _lastUnavailableLog: "n",
  _failureReason: "f",
  sellBackAmounts: "a",
  sellBackListed: "d",
  _legacySellBackBlocked: "k",
  _missingSellOutputs: "z",
  _unavailableSellOutputs: "v",
  _sellRetryTick: "y",
  _lastSellNoPriceLog: "w",
  partialBatchOriginal: "P",
  partialSurplusPending: "S",
  activeBuyingTicks: "A",
  buyingActiveSince: "I",
  replacementReason: "R",
  cancellationReason: "D",
  handoff: "h",
  handoffResource: "hr",
  handoffAmount: "ha",
  handoffReservationProgram: "hp",
  handoffInputResource: "hi",
  handoffInputAmount: "hm",
  handoffInputProgram: "hn",
  handoffInputPrograms: "ho",
  conversionResource: "cr",
  conversionAllowPurchase: "cp",
  marketBuyTopUpState: "V",
  handoffReady: "hy",
  batchBuyIds: "H",
  pipelineId: "pi",
  pipelineMode: "pm",
  pipelineLeaves: "pl",
  pipelineInputs: "pn",
  pipelineDeadline: "pd",
  pipelineEstimate: "pe",
  pendingSince: "Q",
  batchPurchases: "bp"
};
function marketLabReagents(e) {
  if (typeof REACTIONS === "undefined") return [];
  for (const t in REACTIONS) {
    if (!REACTIONS[t]) continue;
    for (const r in REACTIONS[t]) {
      if (REACTIONS[t][r] === e) return [ t, r ];
    }
  }
  return [];
}

function compactMarketLabExpected(e, t, r) {
  if (!e || typeof e !== "object") return null;
  const a = marketLabReagents(t);
  if (r === "forward") return e[t] || 0;
  const n = e[a[0]] || 0;
  const o = e[a[1]] || 0;
  return n === o ? n : [ n, o ];
}

function expandMarketLabExpected(e, t, r) {
  if (e === null || e === undefined) return null;
  const a = {};
  if (r === "forward") {
    a[t] = e || 0;
    return a;
  }
  const n = marketLabReagents(t);
  a[n[0]] = Array.isArray(e) ? e[0] || 0 : e || 0;
  a[n[1]] = Array.isArray(e) ? e[1] || 0 : e || 0;
  return a;
}

function compactMarketLabSellEntry(e, t, r) {
  if (Array.isArray(e)) return hydrateMarketLabSellEntry(e, t, r);
  const a = marketLabReagents(r);
  const n = t === "forward" || e.resource === r ? 0 : e.resource === a[1] ? 2 : 1;
  return hydrateMarketLabSellEntry([ n, e.amount || 0, e.created || 0, e.orderId || null, e.orderStartRemaining === undefined ? null : e.orderStartRemaining, e.unavailable ? 1 : 0, e.stockBaseline === undefined ? null : e.stockBaseline ], t, r);
}

function hydrateMarketLabSellEntry(e, t, r) {
  if (e.__marketLabSellProxy) return e;
  const a = marketLabReagents(r);
  const n = [ "resource", "amount", "created", "orderId", "orderStartRemaining", "unavailable", "stockBaseline" ];
  return new Proxy(e, {
    get(e, t) {
      if (t === "__marketLabSellProxy") return true;
      if (t === "toJSON") return function() {
        return e;
      };
      if (t === "resource") return e[0] === 0 ? r : a[e[0] - 1];
      if (t === "unavailable") return !!e[5];
      const o = n.indexOf(t);
      return o >= 0 ? e[o] : e[t];
    },
    set(e, o, i) {
      if (o === "resource") {
        e[0] = t === "forward" || i === r ? 0 : i === a[1] ? 2 : 1;
        return true;
      }
      if (o === "unavailable") {
        e[5] = i ? 1 : 0;
        return true;
      }
      const s = n.indexOf(o);
      if (s >= 0) {
        e[s] = i === undefined ? null : i;
        return true;
      }
      e[o] = i;
      return true;
    }
  });
}

function hydrateMarketLabSellList(e, t, r) {
  if (!e) return e;
  if (e.__marketLabSellListProxy) return e;
  for (let a = 0; a < e.length; a++) e[a] = compactMarketLabSellEntry(e[a], t, r);
  return new Proxy(e, {
    get(e, t) {
      if (t === "__marketLabSellListProxy") return true;
      if (t === "toJSON") return function() {
        return e;
      };
      return e[t];
    },
    set(e, a, n) {
      if (/^\d+$/.test(a)) e[a] = compactMarketLabSellEntry(n, t, r); else e[a] = n;
      return true;
    }
  });
}

function compactMarketLabOperation(e, t) {
  if (Array.isArray(e)) return hydrateMarketLabOperation(e, t);
  let r = 0;
  for (const t in MARKET_LAB_FLAGS) if (e[t]) r |= MARKET_LAB_FLAGS[t];
  const a = {};
  for (const r in MARKET_LAB_EXTRAS) {
    if (e[r] === undefined || e[r] === null) continue;
    const n = MARKET_LAB_EXTRAS[r];
    if (r === "expectedOutputs") a[n] = e.pipelineId ? e[r] : compactMarketLabExpected(e[r], e.targetCompound, t); else if (r === "sellRequestInfo") a[n] = e[r].map(r => compactMarketLabSellEntry(r, t, e.targetCompound)); else if (r === "sellReservationProgram" || r === "stageReservationProgram") a[n] = 1; else a[n] = e[r];
  }
  return hydrateMarketLabOperation([ e.id, e.targetCompound, MARKET_LAB_STATE_CODES[e.state] === undefined ? 4 : MARKET_LAB_STATE_CODES[e.state], e.batchSize || 0, e.tickStarted || 0, r, a ], t);
}

function hydrateMarketLabOperation(e, t) {
  if (!Array.isArray(e) || e.__marketLabOperationProxy) return e;
  if (!e[6] || typeof e[6] !== "object") e[6] = {};
  return new Proxy(e, {
    get(e, r) {
      if (r === "__marketLabOperationProxy") return true;
      if (r === "toJSON") return function() {
        return e;
      };
      if (r === "id") return e[0];
      if (r === "targetCompound") return e[1];
      if (r === "state") return MARKET_LAB_STATES[e[2]] || "SELLING";
      if (r === "batchSize") return e[3];
      if (r === "tickStarted") return e[4];
      if (r === "direction") return t;
      if (r === "origin") return "marketLab";
      if (r === "reagents") return marketLabReagents(e[1]);
      if (r === "sink") return e[5] & MARKET_LAB_FLAGS.stockpile ? "storage" : "terminal";
      if (r === "noSell") return !!(e[5] & MARKET_LAB_FLAGS.stockpile);
      if (MARKET_LAB_FLAGS[r]) return !!(e[5] & MARKET_LAB_FLAGS[r]);
      const a = MARKET_LAB_EXTRAS[r];
      if (!a) return e[r];
      const n = e[6][a];
      if (r === "expectedOutputs") return e[6].pi ? n : expandMarketLabExpected(n, e[1], t);
      if (r === "sellRequestInfo") return n === undefined ? undefined : hydrateMarketLabSellList(n, t, e[1]);
      if (r === "sellReservationProgram") return n ? "marketLabSell_" + e[0] : null;
      if (r === "stageReservationProgram") return n ? "marketLabStage_" + e[0] : null;
      return n;
    },
    set(e, r, a) {
      if (r === "id") {
        e[0] = a;
        return true;
      }
      if (r === "targetCompound") {
        e[1] = a;
        return true;
      }
      if (r === "state") {
        e[2] = MARKET_LAB_STATE_CODES[a] === undefined ? 4 : MARKET_LAB_STATE_CODES[a];
        return true;
      }
      if (r === "batchSize") {
        e[3] = a || 0;
        return true;
      }
      if (r === "tickStarted") {
        e[4] = a || 0;
        return true;
      }
      if (r === "direction" || r === "origin" || r === "reagents" || r === "sink" || r === "noSell") return true;
      if (MARKET_LAB_FLAGS[r]) {
        e[5] = a ? e[5] | MARKET_LAB_FLAGS[r] : e[5] & ~MARKET_LAB_FLAGS[r];
        return true;
      }
      const n = MARKET_LAB_EXTRAS[r];
      if (!n) {
        e[r] = a;
        return true;
      }
      if (r === "expectedOutputs") a = e[6].pi ? a : compactMarketLabExpected(a, e[1], t); else if (r === "sellRequestInfo") a = a && hydrateMarketLabSellList(a, t, e[1]); else if (r === "sellReservationProgram" || r === "stageReservationProgram") a = a ? 1 : null;
      if (a === undefined || a === null) delete e[6][n]; else e[6][n] = a;
      return true;
    },
    deleteProperty(e, t) {
      if (MARKET_LAB_FLAGS[t]) {
        e[5] &= ~MARKET_LAB_FLAGS[t];
        return true;
      }
      if (t === "sink" || t === "noSell") return true;
      const r = MARKET_LAB_EXTRAS[t];
      if (r) delete e[6][r];
      return true;
    }
  });
}

function hydrateMarketLabRoot(e, t) {
  if (!e || !e.rooms) return;
  for (const r in e.rooms) {
    const a = e.rooms[r];
    if (!Array.isArray(a)) continue;
    for (let e = 0; e < a.length; e++) {
      if (Array.isArray(a[e])) a[e] = hydrateMarketLabOperation(a[e], t);
    }
  }
}

function hydrateMarketLabMemory(e) {
  hydrateMarketLabRoot(e && e.marketLabForward, "forward");
  hydrateMarketLabRoot(e && e.marketLabReverse, "reverse");
}

function compactNamedRecord(e, t, r, a) {
  if (!e || typeof e !== "object") return e;
  if (Array.isArray(e)) return hydrateNamedRecord(e, t, r, a);
  const n = [];
  const o = {};
  for (let a = 0; a < t.length; a++) {
    const i = t[a];
    o[i] = true;
    let s = e[i];
    if (r && r[i]) s = r[i](s);
    n[a] = s === undefined ? null : s;
  }
  const i = {};
  for (const t in e) {
    if (!o[t] && e[t] !== undefined) i[t] = e[t];
  }
  n[t.length] = Object.keys(i).length ? i : null;
  while (n.length > 0 && n[n.length - 1] === null) n.pop();
  return hydrateNamedRecord(n, t, r, a);
}

function hydrateNamedRecord(e, t, r, a) {
  if (!Array.isArray(e) || e.__compactNamedRecord) return e;
  const n = {};
  for (let e = 0; e < t.length; e++) n[t[e]] = e;
  const o = t.length;
  if (r) {
    for (const t in r) {
      const a = n[t];
      if (e[a] !== undefined && e[a] !== null) e[a] = r[t](e[a]);
    }
  }
  return new Proxy(e, {
    get(e, t) {
      if (t === "__compactNamedRecord") return true;
      if (t === "toJSON") return function() {
        return a ? a(e) : e;
      };
      const r = n[t];
      if (r !== undefined) return e[r] === null ? undefined : e[r];
      const i = e[o];
      if (i && Object.prototype.hasOwnProperty.call(i, t)) return i[t];
      return e[t];
    },
    set(e, t, a) {
      const i = n[t];
      if (i !== undefined) {
        if (r && r[t]) a = r[t](a);
        e[i] = a === undefined ? null : a;
        return true;
      }
      if (typeof t === "symbol" || t in e) {
        e[t] = a;
        return true;
      }
      if (!e[o]) e[o] = {};
      e[o][t] = a;
      return true;
    },
    deleteProperty(e, t) {
      const r = n[t];
      if (r !== undefined) e[r] = null; else if (e[o]) delete e[o][t];
      return true;
    }
  });
}

const ECON_INPUT_FIELDS = [ "acquired", "buyCredits", "transferEnergy", "transferEnergyCredits", "ownedOpportunityCredits", "consumed" ];
const ECON_OUTPUT_FIELDS = [ "produced", "sold", "saleCredits", "transferEnergy", "transferEnergyCredits" ];
const ECON_LINK_FIELDS = [ "marketLabOpId", "marketRefineOpId", "localRefineOpId", "factoryOrderId" ];
const ECON_EXPECTED_FIELDS = [ "netCredits", "elapsedTicks", "creditsPerTick" ];
const ECON_PHASE_FIELDS = [ "current", "since", "durations" ];
const ECON_FEE_FIELDS = [ "buyCreate", "buyExtend", "buyReprice", "sellCreate", "sellExtend", "sellReprice", "total" ];
const ECON_TOTAL_FIELDS = [ "buyCredits", "saleCredits", "feeCredits", "transferEnergy", "transferEnergyCredits", "ownedOpportunityCredits", "realizedNetCredits", "economicNetCredits", "realizedNetCreditsPerTick", "economicNetCreditsPerTick" ];
const ECON_JOB_FIELDS = [ "id", "kind", "room", "product", "createdTick", "status", "partial", "links", "expected", "phase", "input", "output", "fees", "totals", "finishedTick", "reason" ];
const ECON_SETTLEMENT_FIELDS = [ "baseKey", "createdTick", "status", "phase", "links", "input", "output", "fees", "finishedTick", "reason", "reconciliation" ];
function compactResourceMap(e, t) {
  if (!e || typeof e !== "object") return e;
  if (e.__compactResourceMap) return e;
  for (const r in e) e[r] = compactNamedRecord(e[r], t);
  return new Proxy(e, {
    get(e, t) {
      if (t === "__compactResourceMap") return true;
      if (t === "toJSON") return function() {
        return e;
      };
      return e[t];
    },
    set(e, r, a) {
      e[r] = typeof r === "symbol" ? a : compactNamedRecord(a, t);
      return true;
    }
  });
}

const ECON_JOB_TRANSFORMS = {
  links: e => compactNamedRecord(e, ECON_LINK_FIELDS),
  expected: e => compactNamedRecord(e, ECON_EXPECTED_FIELDS),
  phase: e => compactNamedRecord(e, ECON_PHASE_FIELDS),
  input: e => compactResourceMap(e, ECON_INPUT_FIELDS),
  output: e => compactResourceMap(e, ECON_OUTPUT_FIELDS),
  fees: e => compactNamedRecord(e, ECON_FEE_FIELDS),
  totals: e => compactNamedRecord(e, ECON_TOTAL_FIELDS)
};
function compactMarketEconomicsJob(e) {
  return compactNamedRecord(e, ECON_JOB_FIELDS, ECON_JOB_TRANSFORMS, function(e) {
    const t = e.slice();
    t[0] = null;
    if (e[5] === "active" || e[5] === "selling") t[13] = null;
    while (t.length && t[t.length - 1] === null) t.pop();
    return t;
  });
}

function compactMarketEconomicsSettlement(e) {
  return compactNamedRecord(e, ECON_SETTLEMENT_FIELDS, {
    phase: e => compactNamedRecord(e, ECON_PHASE_FIELDS),
    links: e => compactNamedRecord(e, ECON_LINK_FIELDS),
    input: e => compactResourceMap(e, ECON_INPUT_FIELDS),
    output: e => compactResourceMap(e, ECON_OUTPUT_FIELDS),
    fees: e => compactNamedRecord(e, ECON_FEE_FIELDS)
  });
}

function hydrateMarketEconomicsRoot(e) {
  if (!e) return;
  if (e.jobs) {
    for (const t in e.jobs) {
      if (Array.isArray(e.jobs[t]) && !e.jobs[t][0]) e.jobs[t][0] = t;
      e.jobs[t] = compactMarketEconomicsJob(e.jobs[t]);
    }
  }
  if (e.settlements) {
    for (const t in e.settlements) e.settlements[t] = compactMarketEconomicsSettlement(e.settlements[t]);
  }
}

const REFINE_INPUT_FIELDS = [ "resource", "amount", "maxPrice", "baseCount", "baseAvailable", "useMarketSell", "useMarketBuy", "useBatch", "useOwned", "handoffReservationProgram", "batchBuyJobId", "marketBuyOrderId", "bidPrice" ];
const REFINE_OP_FIELDS = [ "id", "room", "output", "inputs", "phase", "started", "baseOutputCount", "targetOutput", "jobId", "handoff", "handoffResource", "handoffAmount", "handoffReservationProgram", "handoffInputResource", "handoffInputAmount", "handoffInputProgram", "handoffReady", "factoryOrderId", "factoryCreated", "factoryStarted", "factoryProgressOut", "outputBaseAtFactoryStart", "factoryRetryTick", "nextSellTick", "sellPosted", "sellAmount", "sellPostedTick", "sellOrderId", "sellOrderRemainingAtPost", "sellAttempts", "failReason", "failTick", "_phase", "_outcomeRecorded", "input", "targetBuy", "price", "baseInputCount", "useMarketBuy", "batchMode", "batchBuyIds" ];
function compactRefineInputs(e) {
  if (!Array.isArray(e)) return e;
  for (let t = 0; t < e.length; t++) e[t] = compactNamedRecord(e[t], REFINE_INPUT_FIELDS);
  return e;
}

function compactMarketRefineOperation(e) {
  return compactNamedRecord(e, REFINE_OP_FIELDS, {
    inputs: compactRefineInputs
  });
}

function hydrateMarketRefineRoot(e) {
  if (!e || !Array.isArray(e.ops)) return;
  for (let t = 0; t < e.ops.length; t++) e.ops[t] = compactMarketRefineOperation(e.ops[t]);
}

function hydrateCompactMarketMemory(e) {
  const t = e && e.marketEconomics;
  if (t && t.v >= 8) hydrateMarketEconomicsRoot(t);
  const r = e && e.marketRefine;
  if (r && r.v === 2) hydrateMarketRefineRoot(r);
  hydrateMarketSellRequests(e);
  hydrateMarketBatchBuyRoot(e && e.marketBatchBuy);
}

const MARKET_SELL_REQUEST_FIELDS = [ "roomName", "resourceType", "amount", "created", "orderId", "tmOpId", "jobId", "pendingExtendAmount", "pendingExtendTick", "liquidate" ];
function compactMarketSellRequest(e) {
  if (!e || e.__marketSellRequest) return e;
  const t = Array.isArray(e) ? e : MARKET_SELL_REQUEST_FIELDS.map(function(t) {
    return e[t] === undefined ? null : e[t];
  });
  return new Proxy(t, {
    get(e, t) {
      if (t === "__marketSellRequest") return true;
      if (t === "toJSON") return function() {
        return e;
      };
      const r = MARKET_SELL_REQUEST_FIELDS.indexOf(t);
      return r >= 0 ? e[r] === null ? undefined : e[r] : e[t];
    },
    set(e, t, r) {
      const a = MARKET_SELL_REQUEST_FIELDS.indexOf(t);
      if (a >= 0) e[a] = r === undefined ? null : r; else e[t] = r;
      return true;
    },
    deleteProperty(e, t) {
      const r = MARKET_SELL_REQUEST_FIELDS.indexOf(t);
      if (r >= 0) e[r] = null; else delete e[t];
      return true;
    }
  });
}

function hydrateMarketSellRequests(e) {
  const t = e && e.marketSell && e.marketSell.requests;
  if (!Array.isArray(t)) return false;
  let r = false;
  for (let e = 0; e < t.length; e++) {
    if (t[e] && !t[e].__marketSellRequest) r = true;
    t[e] = compactMarketSellRequest(t[e]);
  }
  return r;
}

const BATCH_BUY_PENDING_FIELDS = [ "tick", "preAmount", "expected", "confirmed" ];
const BATCH_BUY_JOB_FIELDS = [ "id", "state", "roomName", "resourceType", "amount", "orderId", "orderRoomName", "orderPrice", "maxPrice", "energyCost", "energyPrice", "totalCredits", "queue", "ownerId", "economicsJobId", "reservationProgram", "createdTick", "attempts", "capacityLockId", "capacityOwnerId", "capacityDelivered", "fulfilled", "deliveredAmount", "ownOrder", "pending", "reservationTick", "reservationPending", "reservationReason", "reservationReleasedTick", "reservationReleaseReason", "confirmedTick", "failedTick", "cancelledTick", "reason", "ambiguous", "cancelAfterPending", "requestedAmount", "blockedReason", "blockedSince", "blockedTick" ];
function compactMarketBatchBuyJob(e) {
  return compactNamedRecord(e, BATCH_BUY_JOB_FIELDS, {
    pending: e => compactNamedRecord(e, BATCH_BUY_PENDING_FIELDS)
  });
}

function hydrateMarketBatchBuyRoot(e) {
  if (!e || typeof e !== "object") return false;
  let t = false;
  const r = [ e.jobs, e.history ];
  for (let e = 0; e < r.length; e++) {
    const a = r[e];
    if (!Array.isArray(a)) continue;
    for (let e = 0; e < a.length; e++) {
      if (a[e] && !a[e].__compactNamedRecord) t = true;
      a[e] = compactMarketBatchBuyJob(a[e]);
    }
  }
  return t;
}

function hydrateStorageReservationsV2(e) {
  if (!e) return;
  if (!e.storageReservationsV2 || typeof e.storageReservationsV2 !== "object") {
    e.storageReservationsV2 = {
      version: 1,
      nodes: {},
      locks: {},
      lockIndex: {},
      capacities: {},
      orphans: [],
      lastMaintenanceTick: 0,
      importedLegacy: false,
      lockCursor: 0,
      capacityCursor: 0
    };
  }
  delete e.storageReservationsV2.mode;
}

const AUTO_TRADER_JOB_FIELDS = [ "type", "compound", "product", "room", "expectedCreditsPerTick", "tick", "jobId", "status", "finishedTick", "reason", "opId", "marketOpId", "expectedNetProfit", "expectedElapsedTicks", "maxPrice", "reagentAPrice", "reagentBPrice", "level", "method", "localRefineOpId", "amount", "isDecompress", "marketRefineOpId", "maxInputPrices" ];
function compactAutoTraderJob(e) {
  return compactNamedRecord(e, AUTO_TRADER_JOB_FIELDS);
}

function hydrateAutoTraderHistory(e) {
  const t = e && e.autoTrader && e.autoTrader.jobsStarted;
  if (!Array.isArray(t)) return false;
  let r = false;
  for (let e = 0; e < t.length; e++) {
    if (t[e] && !Array.isArray(t[e])) r = true;
    t[e] = compactAutoTraderJob(t[e]);
  }
  return r;
}

let heapMemory = null;
let saveRequested = false;
let saveRequestReason = null;
let checkpointRequested = false;
let checkpointRequestedAt = null;
let reloadRequested = false;
let willSaveThisTick = false;
let activeTick = -1;
let activeSaveReason = "none";
let lastCheckpointTick = -1;
let activeRequestCalls = 0;
let activeCheckpointCalls = 0;
let activeImmediateCalls = 0;
let activeImmediateReasons = null;
const datasetPolicies = {};
function selectDatasetBackend(e) {
  if (e.backend) return {
    backend: e.backend,
    reason: "explicit internal policy"
  };
  if (e.bucket) {
    return {
      backend: e.bucket === "flag" ? "cold" : e.bucket,
      reason: "legacy catalog placement"
    };
  }
  if (e.immutable === true && (e.access === "cold" || e.readFrequency === "low")) {
    return {
      backend: "cold",
      reason: "immutable low-frequency snapshot"
    };
  }
  if (e.resetLossOkay === true && (e.recomputable === true || e.mutability === "ephemeral")) {
    return {
      backend: "heap",
      reason: "recomputable transient state"
    };
  }
  return {
    backend: "serialized",
    reason: "mutable or durable state"
  };
}

function registerDataset(e, t) {
  if (e && typeof e === "object") {
    t = e;
    e = t.id;
  }
  if (typeof e !== "string" || !e) throw new Error("dataset id must be a non-empty string");
  t = t || {};
  const r = selectDatasetBackend(t);
  const a = r.backend;
  if (a !== "heap" && a !== "serialized" && a !== "cold") {
    throw new Error("invalid backend for dataset " + e + ": " + a);
  }
  let n = t.path || "";
  if (n.indexOf("Memory.") === 0) n = n.slice(7); else if (n.indexOf("heap.") === 0) n = n.slice(5); else if (n === "Memory" || n === "heap") n = "";
  const o = Object.assign({}, t, {
    id: e,
    backend: a,
    backendReason: r.reason,
    pathParts: n ? n.split(".") : []
  });
  const i = datasetPolicies[e];
  if (i && (i.backend !== o.backend || i.path !== o.path)) {
    throw new Error("dataset already registered with different policy: " + e);
  }
  datasetPolicies[e] = o;
  return o;
}

function datasetPolicy(e) {
  const t = datasetPolicies[e];
  if (!t) throw new Error("unregistered dataset: " + e);
  return t;
}

function dataRoot(e) {
  return e.backend === "heap" ? heap : heapMemory || Memory;
}

function dataPath(e, t) {
  const r = e.pathParts.slice();
  if (t !== undefined && t !== null) {
    if (Array.isArray(t)) return r.concat(t.map(String));
    r.push(String(t));
  }
  return r;
}

function pathGet(e, t) {
  let r = e;
  for (let e = 0; e < t.length; e++) {
    if (r == null || typeof r !== "object") return undefined;
    r = r[t[e]];
  }
  return r;
}

function pathSet(e, t, r) {
  if (!t.length) throw new Error("cannot replace a storage backend root");
  let a = e;
  for (let e = 0; e < t.length - 1; e++) {
    if (!a[t[e]] || typeof a[t[e]] !== "object") a[t[e]] = {};
    a = a[t[e]];
  }
  a[t[t.length - 1]] = r;
  return r;
}

function pathRemove(e, t) {
  if (!t.length) throw new Error("cannot remove a storage backend root");
  let r = e;
  for (let e = 0; e < t.length - 1; e++) {
    if (!r || typeof r !== "object") return false;
    r = r[t[e]];
  }
  const a = t[t.length - 1];
  if (!r || !Object.prototype.hasOwnProperty.call(r, a)) return false;
  delete r[a];
  return true;
}

function flagBackend() {
  return require("flagVault");
}

function logicalColdKey(e, t) {
  if (e.rawKey) {
    if (t === undefined || t === null) throw new Error("cold key is required for " + e.id);
    return String(t);
  }
  return t === undefined || t === null ? e.id : e.id + ":" + String(t);
}

function applyDurability(e, t, r) {
  if (e.backend !== "serialized") return;
  t = t || {};
  const a = t.durability || e.durability || "checkpoint";
  if (a === "checkpoint") requestSave(); else if (a === "immediate") {
    const a = t.reason || e.reason;
    if (!a) throw new Error("immediate mutation requires a stable reason: " + e.id + "." + r);
    requestImmediateSave(a);
  } else if (a !== "none") {
    throw new Error("invalid durability for dataset " + e.id + ": " + a);
  }
}

function storageGet(e, t) {
  const r = datasetPolicy(e);
  if (r.backend === "cold") return flagBackend().get(logicalColdKey(r, t));
  return pathGet(dataRoot(r), dataPath(r, t));
}

function storageSet(e, t, r, a) {
  const n = datasetPolicy(e);
  if (arguments.length === 2) {
    r = t;
    t = undefined;
  }
  if (n.backend === "cold") return flagBackend().put(logicalColdKey(n, t), r);
  const o = pathSet(dataRoot(n), dataPath(n, t), r);
  applyDurability(n, a, "set");
  return o;
}

function storageEnsure(e, t, r, a) {
  if (typeof t === "function") {
    a = r;
    r = t;
    t = undefined;
  }
  const n = storageGet(e, t);
  if (n !== undefined && n !== null) return n;
  if (typeof r !== "function") throw new Error("storage.ensure requires a factory");
  const o = r();
  storageSet(e, t, o, a);
  return o;
}

function storageUpdate(e, t, r, a) {
  if (typeof t === "function") {
    a = r;
    r = t;
    t = undefined;
  }
  if (typeof r !== "function") throw new Error("storage.update requires an updater function");
  const n = datasetPolicy(e);
  if (n.backend === "cold") throw new Error("cold datasets are immutable; publish a new key: " + e);
  const o = storageGet(e, t);
  const i = r(o);
  if (i !== undefined && i !== o) pathSet(dataRoot(n), dataPath(n, t), i);
  applyDurability(n, a, "update");
  return i === undefined ? o : i;
}

function storageRemove(e, t, r) {
  const a = datasetPolicy(e);
  if (a.backend === "cold") {
    const e = flagBackend().getMeta(logicalColdKey(a, t));
    return e ? flagBackend().remove(e.id, e.id) : false;
  }
  if (t === undefined || t === null) {
    if (a.pathParts.length === 1) {
      const e = dataRoot(a);
      const t = a.pathParts[0];
      if (!e || !Object.prototype.hasOwnProperty.call(e, t)) return false;
      delete e[t];
      applyDurability(a, r, "remove");
      return true;
    }
    throw new Error("storage.remove requires an explicit key for multi-segment dataset: " + e);
  }
  const n = pathRemove(dataRoot(a), dataPath(a, t));
  if (n) applyDurability(a, r, "remove");
  return n;
}

const storage = {
  register: registerDataset,
  policy: function(e) {
    return Object.assign({}, datasetPolicy(e));
  },
  explain: function(e) {
    const t = datasetPolicy(e);
    return {
      id: e,
      backend: t.backend,
      reason: t.backendReason
    };
  },
  policies: function() {
    return Object.keys(datasetPolicies).sort().map(function(e) {
      return Object.assign({}, datasetPolicies[e]);
    });
  },
  get: storageGet,
  set: storageSet,
  ensure: storageEnsure,
  update: storageUpdate,
  remove: storageRemove,
  tick: function() {
    return flagBackend().tick();
  },
  cold: {
    publish: function(e, t, r) {
      return flagBackend().put(e, t, r);
    },
    get: function(e) {
      return flagBackend().get(e);
    },
    has: function(e) {
      return flagBackend().has(e);
    },
    keys: function() {
      return flagBackend().keys();
    },
    meta: function(e) {
      return flagBackend().getMeta(e);
    },
    pin: function(e) {
      return flagBackend().setPinned(e, true);
    },
    unpin: function(e) {
      return flagBackend().setPinned(e, false);
    },
    status: function(e) {
      return flagBackend().queueStatus(e);
    },
    capacity: function() {
      return flagBackend().capacity();
    },
    estimateFlags: function(e) {
      return flagBackend().estimateFlagCount(e);
    },
    list: function() {
      return flagBackend().list();
    },
    remove: function(e) {
      const t = flagBackend().getMeta(e);
      return t ? flagBackend().remove(t.id, t.id) : false;
    },
    discard: function(e) {
      const t = flagBackend().queueStatus(e);
      if (t.state === "committed" && t.meta) return flagBackend().remove(t.meta.id, t.meta.id);
      if (t.state === "failed" && t.id) return flagBackend().remove(t.id, t.id);
      return false;
    }
  }
};
registerDataset("errors", {
  backend: "serialized",
  path: "Memory.errors",
  owner: "main.js"
});
registerDataset("flagVault.manifest", {
  backend: "serialized",
  path: "Memory.flagVault",
  owner: "memoryManager.js"
});
registerDataset("flagVault.test", {
  backend: "serialized",
  path: "Memory.flagVaultTest",
  owner: "flagVault.js"
});
function finishSaveTelemetry() {
  if (activeTick < 0) return;
  if (!heap.memorySaveStats) {
    heap.memorySaveStats = {
      ticks: 0,
      saves: 0,
      scheduled: 0,
      requested: 0,
      manual: 0,
      skipped: 0,
      requestCalls: 0,
      checkpointCalls: 0,
      immediateCalls: 0
    };
  }
  const e = heap.memorySaveStats;
  if (typeof e.requestCalls !== "number") e.requestCalls = 0;
  if (typeof e.checkpointCalls !== "number") e.checkpointCalls = 0;
  if (typeof e.immediateCalls !== "number") e.immediateCalls = 0;
  e.ticks++;
  e.requestCalls += activeRequestCalls;
  e.checkpointCalls += activeCheckpointCalls;
  e.immediateCalls += activeImmediateCalls;
  e.lastRequestCalls = activeRequestCalls;
  e.lastCheckpointCalls = activeCheckpointCalls;
  e.lastImmediateCalls = activeImmediateCalls;
  e.lastImmediateReasons = activeImmediateReasons || {};
  if (!e.immediateReasons) e.immediateReasons = {};
  for (const t in activeImmediateReasons) {
    e.immediateReasons[t] = (e.immediateReasons[t] || 0) + activeImmediateReasons[t];
  }
  e.lastTick = activeTick;
  e.lastReason = activeSaveReason;
  if (activeSaveReason === "none") {
    e.skipped++;
  } else {
    e.saves++;
    e[activeSaveReason] = (e[activeSaveReason] || 0) + 1;
    e.lastSaveTick = activeTick;
  }
  if (!heap.memorySerialization) {
    heap.memorySerialization = {
      samples: [],
      saveHits: [],
      saveReasons: [],
      amortizedCpu: 0
    };
  }
  const t = heap.memorySerialization;
  if (!Array.isArray(t.saveHits)) t.saveHits = [];
  if (!Array.isArray(t.saveReasons)) t.saveReasons = [];
  t.saveHits.push(activeSaveReason === "none" ? 0 : 1);
  t.saveReasons.push(activeSaveReason === "immediate" ? Object.assign({}, activeImmediateReasons) : activeSaveReason);
  if (t.saveHits.length > SERIALIZATION_HISTORY_LENGTH) t.saveHits.shift();
  if (t.saveReasons.length > SERIALIZATION_HISTORY_LENGTH) t.saveReasons.shift();
}

function recordSerializationCost(e) {
  if (typeof e !== "number" || !isFinite(e) || e < 0) return;
  if (!heap.memorySerialization) heap.memorySerialization = {
    samples: [],
    saveHits: [],
    saveReasons: [],
    amortizedCpu: 0
  };
  const t = heap.memorySerialization;
  if (!Array.isArray(t.samples)) t.samples = [];
  t.cpu = e;
  t.sampledAt = Game.time;
  t.samples.push(e);
  if (t.samples.length > 10) t.samples.shift();
}

function refreshAmortizedSerializationCost() {
  const e = heap.memorySerialization;
  if (!e || e.lastReserveUpdate === Game.time) return;
  if (Game.time % SERIALIZATION_RESERVE_UPDATE_INTERVAL !== 0) return;
  const t = Array.isArray(e.samples) ? e.samples : [];
  const r = Array.isArray(e.saveHits) ? e.saveHits : [];
  const a = t.length ? t.reduce(function(e, t) {
    return e + t;
  }, 0) / t.length : e.cpu || SERIALIZATION_COLD_START_CPU;
  const n = r.length ? r.reduce(function(e, t) {
    return e + t;
  }, 0) / r.length : 1 / SAVE_INTERVAL;
  e.averageCpu = a;
  e.hitRate = n;
  e.amortizedCpu = a * n;
  e.lastReserveUpdate = Game.time;
}

function sampleSerializationCost() {
  if (Game.cpu && typeof Game.cpu.bucket === "number" && Game.cpu.bucket < SERIALIZATION_SAMPLE_MIN_BUCKET) return;
  const e = heap.memorySerialization;
  if (willSaveThisTick || e && Game.time - e.sampledAt < SERIALIZATION_SAMPLE_INTERVAL) return;
  const t = Game.cpu.getUsed();
  JSON.stringify(heapMemory);
  recordSerializationCost(Game.cpu.getUsed() - t);
}

function recentSaveTelemetry() {
  const e = heap.memorySerialization || {};
  const t = Array.isArray(e.saveHits) ? e.saveHits : [];
  const r = Array.isArray(e.saveReasons) ? e.saveReasons : [];
  const a = {};
  for (let e = 0; e < r.length; e++) {
    const t = r[e];
    if (!t || t === "none") continue;
    if (typeof t === "string") {
      a[t] = (a[t] || 0) + 1;
      continue;
    }
    for (const e in t) {
      a[e] = (a[e] || 0) + 1;
    }
  }
  return {
    recentTicks: t.length,
    recentSaves: t.reduce(function(e, t) {
      return e + t;
    }, 0),
    recentReasons: a
  };
}

function run() {
  finishSaveTelemetry();
  activeTick = Game.time;
  activeRequestCalls = 0;
  activeCheckpointCalls = 0;
  activeImmediateCalls = 0;
  activeImmediateReasons = {};
  if (reloadRequested) {
    reloadRequested = false;
    heapMemory = null;
  }
  if (heapMemory) {
    delete global.Memory;
    global.Memory = heapMemory;
  } else {
    heapMemory = Memory;
    hydrateMarketLabMemory(heapMemory);
    hydrateCompactMarketMemory(heapMemory);
    hydrateStorageReservationsV2(heapMemory);
    console.log("[memoryManager] Parsed Memory from the persistent store (tick " + Game.time + ")");
  }
  const t = Game.time % SAVE_INTERVAL === 0;
  const r = saveRequested;
  const a = lastCheckpointTick < 0 || Game.time - lastCheckpointTick >= MAX_CHECKPOINT_AGE;
  const n = t && (checkpointRequested || a);
  willSaveThisTick = r || n;
  activeSaveReason = r ? saveRequestReason || "requested" : n ? "checkpoint" : "none";
  if (willSaveThisTick) {
    RawMemory._parsed = heapMemory;
    lastCheckpointTick = Game.time;
    saveRequested = false;
    if (r || n) {
      saveRequestReason = null;
      checkpointRequested = false;
      checkpointRequestedAt = null;
    }
  } else {
    delete RawMemory._parsed;
  }
  refreshAmortizedSerializationCost();
}

function requestSave() {
  activeRequestCalls++;
  activeCheckpointCalls++;
  if (activeTick === Game.time && activeSaveReason === "immediate") return;
  checkpointRequested = true;
  if (checkpointRequestedAt === null) checkpointRequestedAt = Game.time;
}

function requestImmediateSave(e) {
  e = e || "unspecified";
  if (activeTick === Game.time) {
    activeRequestCalls++;
    activeImmediateCalls++;
    activeImmediateReasons[e] = (activeImmediateReasons[e] || 0) + 1;
    willSaveThisTick = true;
    if (activeSaveReason === "none" || activeSaveReason === "checkpoint") {
      activeSaveReason = "immediate";
    }
    if (heapMemory) RawMemory._parsed = heapMemory;
    lastCheckpointTick = Game.time;
    checkpointRequested = false;
    checkpointRequestedAt = null;
    return;
  }
  saveRequested = true;
  saveRequestReason = "immediate";
}

global.memorySave = function() {
  if (activeTick === Game.time) {
    activeRequestCalls++;
    willSaveThisTick = true;
    if (activeSaveReason === "none") activeSaveReason = "manual";
    if (heapMemory) RawMemory._parsed = heapMemory;
    lastCheckpointTick = Game.time;
  } else {
    saveRequested = true;
    saveRequestReason = "manual";
  }
  return "Heap Memory will be serialized to the persistent store at end of tick.";
};
global.memoryReload = function() {
  reloadRequested = true;
  return "Discarding heap Memory next tick and re-parsing from the persistent store. Heap changes since the last save will be lost.";
};
module.exports = {
  run: run,
  requestSave: requestSave,
  requestCheckpoint: requestSave,
  requestImmediateSave: requestImmediateSave,
  willSave: function() {
    return willSaveThisTick;
  },
  getSerializationCost: function() {
    return heap.memorySerialization ? heap.memorySerialization.cpu : 0;
  },
  getAmortizedSerializationCost: function() {
    return heap.memorySerialization ? heap.memorySerialization.amortizedCpu || 0 : 0;
  },
  getSerializationReserveStats: function() {
    const e = heap.memorySerialization || {};
    return Object.assign({
      averageCpu: e.averageCpu || e.cpu || 0,
      hitRate: e.hitRate || 0,
      amortizedCpu: e.amortizedCpu || 0,
      sampledAt: e.sampledAt || 0,
      updatedAt: e.lastReserveUpdate || 0
    }, recentSaveTelemetry());
  },
  getSaveStats: function() {
    const e = heap.memorySaveStats || {};
    return Object.assign({}, e, {
      currentTick: activeTick,
      currentReason: activeSaveReason,
      currentRequestCalls: activeRequestCalls,
      currentCheckpointCalls: activeCheckpointCalls,
      currentImmediateCalls: activeImmediateCalls,
      currentImmediateReasons: Object.assign({}, activeImmediateReasons || {}),
      currentWillSave: willSaveThisTick,
      lastCheckpointTick: lastCheckpointTick,
      lastCheckpointAge: lastCheckpointTick < 0 ? null : Math.max(0, Game.time - lastCheckpointTick),
      checkpointPending: checkpointRequested,
      checkpointRequestedAt: checkpointRequestedAt,
      checkpointAge: checkpointRequestedAt === null ? 0 : Math.max(0, Game.time - checkpointRequestedAt)
    }, recentSaveTelemetry());
  },
  recordSerializationCost: recordSerializationCost,
  sampleSerializationCost: sampleSerializationCost,
  storage: storage,
  heap: heap,
  compactMarketLabOperation: compactMarketLabOperation,
  compactMarketSellRequest: compactMarketSellRequest,
  hydrateMarketSellRequests: hydrateMarketSellRequests,
  compactMarketBatchBuyJob: compactMarketBatchBuyJob,
  hydrateMarketBatchBuyRoot: hydrateMarketBatchBuyRoot,
  hydrateMarketLabRoot: hydrateMarketLabRoot,
  compactMarketEconomicsJob: compactMarketEconomicsJob,
  compactMarketEconomicsSettlement: compactMarketEconomicsSettlement,
  hydrateMarketEconomicsRoot: hydrateMarketEconomicsRoot,
  compactMarketRefineOperation: compactMarketRefineOperation,
  hydrateMarketRefineRoot: hydrateMarketRefineRoot,
  compactAutoTraderJob: compactAutoTraderJob,
  hydrateAutoTraderHistory: hydrateAutoTraderHistory,
  SAVE_INTERVAL: SAVE_INTERVAL,
  SERIALIZATION_SAMPLE_INTERVAL: SERIALIZATION_SAMPLE_INTERVAL
};
