// LLM: Read docs/codex.js before reviewing or changing this file.
// marketLab.js
// Console globals: labForward, labReverse, stopAllLab, marketRefineComputeBidPrice, marketRefineShouldUseMarketBuy
// Example: labForward('E1N1', 'XGH2O', 3000) - Queue forward synthesis market lab order
// Example: labReverse('E1N1', 'XGH2O', 3000) - Queue reverse breakdown market lab order
// Example: stopAllLab('E1N1') - Cancel all market lab orders for room
// Example: marketRefineComputeBidPrice('XGH2O') - Compute maximum bid price for refinement
// Example: marketRefineShouldUseMarketBuy('XGH2O') - Evaluate whether to market buy vs produce
var opportunisticBuy = require("opportunisticBuy");
var getRoomState = require("getRoomState");
var marketBuyer = require("marketBuy");
var util = require("util");
var memoryManager = require("memoryManager");
var storageManager = require("storageManager");
var terminalManager = require("terminalManager");
var pricing = require("marketPricing");
var marketSeller = require("marketSell");
var marketBatchBuy = require("marketBatchBuy");
var labManager = require("labManager");
var roomSuspender = require("roomSuspender");
var labCommodityPolicy = require("labCommodityPolicy");
var labCommodityRouter = require("labCommodityRouter");
var labReactionPipeline = require("labReactionPipeline");
function labShouldUseMarketBuy(e, r, t) {
  if (typeof global.marketRefineShouldUseMarketBuy === "function") return !!global.marketRefineShouldUseMarketBuy(e, r, t);
  return false;
}

function labComputeBid(e, r) {
  if (typeof global.marketRefineComputeBidPrice === "function") return global.marketRefineComputeBidPrice(e, r);
  return typeof r === "number" && r > 0 ? r : .001;
}

var LAB_CAPACITY = 3e3;
var LAB_REACTION_AMOUNT = labCommodityPolicy.MIN_REACTION_AMOUNT;
var DEFAULT_BATCH_SIZE = 3e3;
var MAX_BATCH_SIZE = 3e3;
var STATE_BUYING = "BUYING";
var STATE_WAITING = "WAITING";
var STATE_PROCESSING = "PROCESSING";
var STATE_STAGING = "STAGING";
var STATE_SELLING = "SELLING";
var STATE_PENDING = "PENDING";
var DIR_FORWARD = "forward";
var DIR_REVERSE = "reverse";
var MEMORY_VERSION = 9;
var MAX_ACTIVE_OPS_PER_ROOM = 3;
var SELLING_GRACE_TICKS = 200;
var STAGING_GRACE_TICKS = 200;
var SELLING_REARM_GRACE_TICKS = 50;
var STALE_SELLING_TICKS = 1e5;
var SELLING_SETUP_TIMEOUT_TICKS = 5e3;
var PENDING_TTL_TICKS = 3e3;
var SELLING_NO_PRICE_RETRY_INTERVAL = 250;
var SELLING_NO_PRICE_LOG_INTERVAL = 500;
var BUYING_TIMEOUT_TICKS = 1e4;
var STALE_BUYING_TICKS = 5e3;
var MIN_PARTIAL_BATCH_RATIO = .25;
var WAITING_RUN_INTERVAL = 3;
var PROCESSING_RUN_INTERVAL = 3;
var STAGING_RUN_INTERVAL = 5;
var BUYING_POLL_INTERVAL = 5;
var SELLING_SETUP_INTERVAL = 5;
var SELLING_DRAIN_INTERVAL = 10;
var QUEUE_TRIM_INTERVAL = 100;
var LAB_MARKETBUY_TOPUP_GRACE_TICKS = 400;
function getLabMarketBuyTopUpGraceTicks() {
  var e = Memory.marketLabConfig && Memory.marketLabConfig.marketBuyTopUpGraceTicks;
  return typeof e === "number" && isFinite(e) && e >= 1 ? Math.floor(e) : LAB_MARKETBUY_TOPUP_GRACE_TICKS;
}

var tickCacheTick = -1;
var labsByRoomCache = {};
var roomReadyCache = {};
var creepResourceCache = {};
var ownedSellOrderCache = {};
var marketSellRequestsByResource = {};
var operationRunCache = {};
var buyLockWaitOwners = {};
var partialWaitReasons = {};
var queueTrimTick = -1;
var hydratedMemoryRoots = {};
var buyingOwnerCache = {};
var operationInputCache = null;
var directionRunTicks = {};
var legacyTickMarkersCleared = false;
var queuePromotionTick = -1;
var pendingWaitLogTick = {};
function getSchedulerState() {
  var e = memoryManager.heap;
  if (!e.marketLabScheduler) {
    e.marketLabScheduler = {
      nextDirection: DIR_FORWARD,
      nextOperation: {},
      lastCpu: 0,
      lastProcessed: 0,
      lastVisited: 0,
      lastYielded: false,
      totalYields: 0
    };
  }
  return e.marketLabScheduler;
}

function forgetOperation(e) {
  if (!e || !e.id) return;
  delete operationRunCache[e.id];
  var r = memoryManager.heap.marketLabScheduler;
  if (!r || !r.nextOperation) return;
  if (r.nextOperation[DIR_FORWARD] === e.id) delete r.nextOperation[DIR_FORWARD];
  if (r.nextOperation[DIR_REVERSE] === e.id) delete r.nextOperation[DIR_REVERSE];
}

function operationConsumesRoomSlot(e) {
  if (!e || e._completed || e._failed) return false;
  return !!(e.stockpile || e.state === STATE_PENDING || e.state !== STATE_SELLING);
}

function isStockpileOperation(e) {
  return !!(e && e.stockpile);
}

function countStockpileOperations(e, r) {
  var t = 0;
  if (!e) return t;
  var queues = Array.isArray(e) ? [ e ] : [ e.forward || [], e.reverse || [] ];
  for (var q = 0; q < queues.length; q++) {
    for (var a = 0; a < queues[q].length; a++) {
      var operation = queues[q][a];
      if (operation !== r && isStockpileOperation(operation) && operation.state !== STATE_PENDING && !operation._completed && !operation._failed) t++;
    }
  }
  return t;
}

function countPendingStockpileOperations(e, r) {
  var t = 0;
  if (!e) return t;
  var queues = Array.isArray(e) ? [ e ] : [ e.forward || [], e.reverse || [] ];
  for (var q = 0; q < queues.length; q++) {
    for (var a = 0; a < queues[q].length; a++) {
      var operation = queues[q][a];
      if (operation !== r && isStockpileOperation(operation) && operation.state === STATE_PENDING && !operation._completed && !operation._failed) t++;
    }
  }
  return t;
}

function countSlotOperations(e, r) {
  var t = 0;
  if (!e) return t;
  for (var a = 0; a < e.length; a++) {
    if (e[a] !== r && operationConsumesRoomSlot(e[a])) t++;
  }
  return t;
}

function countRoomSlotOperations(e, r) {
  return countSlotOperations(e.forward, r) + countSlotOperations(e.reverse, r);
}

function ensureTickCache() {
  if (tickCacheTick === Game.time) return;
  tickCacheTick = Game.time;
  labsByRoomCache = {};
  roomReadyCache = {};
  creepResourceCache = {};
  ownedSellOrderCache = {};
  marketSellRequestsByResource = {};
  buyingOwnerCache = {};
  operationInputCache = null;
}

function invalidateOwnedSellOrderCache() {
  ownedSellOrderCache = {};
  marketSellRequestsByResource = {};
}

function memKey(e) {
  return e === DIR_FORWARD ? "marketLabForward" : "marketLabReverse";
}

function ensureOperationIds(e, r) {
  if (!e || !e.rooms) return;
  var t = false;
  for (var a in e.rooms) {
    var n = e.rooms[a];
    if (!Array.isArray(n)) continue;
    for (var o = 0; o < n.length; o++) {
      var i = n[o];
      if (!i || i.id) continue;
      i.id = "marketLabLegacy_" + r + "_" + a + "_" + (i.targetCompound || "unknown") + "_" + (i.tickStarted || 0) + "_" + o;
      t = true;
    }
  }
  if (t) requestSave();
}

function migrateOperation(e, r) {
  if (!e || typeof e !== "object") return;
  if (e.buyRequestsCreated !== undefined && e.buyRequestCreated === undefined) {
    e.buyRequestCreated = e.buyRequestsCreated;
    delete e.buyRequestsCreated;
  }
  if (e.sellOrdersCreated !== undefined && e.sellOrderCreated === undefined) {
    e.sellOrderCreated = e.sellOrdersCreated;
    delete e.sellOrdersCreated;
  }
  if (e.breakdownStarted !== undefined && e.reactionStarted === undefined) {
    e.reactionStarted = e.breakdownStarted;
    delete e.breakdownStarted;
  }
  if (!e.direction) e.direction = r;
  delete e.active;
  delete e.roomName;
  delete e.sink;
  delete e._lastMarketLabRun;
  delete e._lastRunState;
  delete e.initialReagentAmounts;
  delete e.initialCompoundAmount;
  delete e.marketBuyLastCheck;
  if (!e.buyRequestCreated) delete e.buyRequestCreated;
  if (!e.reactionStarted) delete e.reactionStarted;
  if (!e.sellOrderCreated) delete e.sellOrderCreated;
  if (!e.salvageMode) delete e.salvageMode;
  if (e.state !== STATE_BUYING) {
    delete e.useMarketBuy;
    delete e.marketBuyCeilings;
    delete e.marketBuyToppedUp;
    delete e.lastTopUpCheck;
    delete e.buyingStartedTick;
    delete e.maxReagentPrices;
    delete e.maxBuyPrice;
  }
  if (e.state === STATE_STAGING || e.state === STATE_SELLING || e.state === STATE_PROCESSING && e.reactionStarted) {
    delete e.buyBaseAmounts;
    delete e.buyBaseCompoundAmount;
  }
  if (e.state !== STATE_STAGING) {
    delete e.stageReservationProgram;
    delete e.stageStartTick;
  }
  if (e.state !== STATE_SELLING && e.state !== STATE_STAGING) {
    delete e.sellReservationProgram;
  }
  if (e.state !== STATE_PENDING) delete e.pendingSince;
  if (e.state !== STATE_PENDING) delete e.batchPurchases;
}

function ensureMemory(e) {
  var r = memKey(e);
  if (!Memory[r]) {
    Memory[r] = {
      rooms: {},
      version: MEMORY_VERSION
    };
  }
  if (!Memory[r].rooms) {
    if (Memory[r].operations) {
      Memory[r].rooms = {};
      for (var t in Memory[r].operations) {
        var a = Memory[r].operations[t];
        if (a && a.active) {
          Memory[r].rooms[t] = [ a ];
        }
      }
      delete Memory[r].operations;
    } else {
      Memory[r].rooms = {};
    }
  }
  if (Memory[r].operations) {
    for (var n in Memory[r].operations) {
      var o = Memory[r].operations[n];
      if (!o) continue;
      if (!Array.isArray(Memory[r].rooms[n])) Memory[r].rooms[n] = [];
      var i = Array.isArray(o) ? o : [ o ];
      for (var u = 0; u < i.length; u++) {
        var a = i[u];
        if (a && typeof a === "object" && a.active !== false) {
          Memory[r].rooms[n].push(a);
        }
      }
    }
    delete Memory[r].operations;
  }
  if (Memory[r].version !== MEMORY_VERSION) {
    for (var l in Memory[r].rooms) {
      var s = Memory[r].rooms[l];
      if (!Array.isArray(s)) {
        delete Memory[r].rooms[l];
        continue;
      }
      for (var c = s.length - 1; c >= 0; c--) {
        if (!s[c] || typeof s[c] !== "object") s.splice(c, 1); else {
          migrateOperation(s[c], e);
          s[c] = memoryManager.compactMarketLabOperation(s[c], e);
        }
      }
      if (s.length === 0) delete Memory[r].rooms[l];
    }
    Memory[r].version = MEMORY_VERSION;
    requestSave();
  }
  // identity changed (for example after a console reset/replacement).
    if (hydratedMemoryRoots[e] !== Memory[r]) {
    memoryManager.hydrateMarketLabRoot(Memory[r], e);
    ensureOperationIds(Memory[r], e);
    hydratedMemoryRoots[e] = Memory[r];
  }
  return Memory[r];
}

function ensureRoomQueue(e, r) {
  var t = ensureMemory(e);
  if (!t.rooms[r]) t.rooms[r] = [];
  return t.rooms[r];
}

function getRoomQueues(e) {
  var r = Memory.marketLabForward && Memory.marketLabForward.rooms && Memory.marketLabForward.rooms[e] || [];
  var t = Memory.marketLabReverse && Memory.marketLabReverse.rooms && Memory.marketLabReverse.rooms[e] || [];
  return {
    forward: r,
    reverse: t
  };
}

function getLabsInRoom(e) {
  ensureTickCache();
  if (labsByRoomCache[e]) return labsByRoomCache[e];
  var r = getRoomState.get(e);
  if (r && r.structuresByType && r.structuresByType[STRUCTURE_LAB]) {
    labsByRoomCache[e] = r.structuresByType[STRUCTURE_LAB];
    return labsByRoomCache[e];
  }
  var t = Game.rooms[e];
  if (!t) {
    labsByRoomCache[e] = [];
    return labsByRoomCache[e];
  }
  labsByRoomCache[e] = t.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_LAB;
    }
  });
  return labsByRoomCache[e];
}

function checkLabsContaminated(e) {
  var r = getLabsInRoom(e);
  for (var t = 0; t < r.length; t++) {
    if ((r[t].mineralAmount || 0) > 0) return true;
  }
  return false;
}

function calculateBatchSize(e) {
  var r = getLabsInRoom(e);
  if (r.length < 3) {
    return {
      batchSize: DEFAULT_BATCH_SIZE,
      outputLabCount: 1
    };
  }
  var t = 0;
  for (var a = 0; a < r.length; a++) {
    for (var n = a + 1; n < r.length; n++) {
      var o = r[a];
      var i = r[n];
      var u = 0;
      for (var l = 0; l < r.length; l++) {
        if (l === a || l === n) continue;
        var s = r[l];
        if (o.pos.inRangeTo(s, 2) && i.pos.inRangeTo(s, 2)) u++;
      }
      if (u > t) t = u;
    }
  }
  if (t === 0) {
    return {
      batchSize: DEFAULT_BATCH_SIZE,
      outputLabCount: 1
    };
  }
  return {
    batchSize: Math.min(t * LAB_CAPACITY, MAX_BATCH_SIZE),
    outputLabCount: t
  };
}

function phaseJob(e, r) {
  if (!e || !e.jobId || e._economicsPhase === r) return;
  try {
    require("marketEconomics").phase(e.jobId, r);
    e._economicsPhase = r;
    requestSave();
  } catch (e) {}
}

function findReagents(e) {
  for (var r in REACTIONS) {
    for (var t in REACTIONS[r]) {
      if (REACTIONS[r][t] === e) return [ r, t ];
    }
  }
  return [];
}

function isValidCompound(e) {
  for (var r in REACTIONS) {
    for (var t in REACTIONS[r]) {
      if (REACTIONS[r][t] === e) return true;
    }
  }
  return false;
}

function pipelineInputResources(e) {
  var r = [];
  var t = e && e.pipelineInputs;
  if (!t || typeof t !== "object") return r;
  for (var a in t) {
    if (Object.prototype.hasOwnProperty.call(t, a) && t[a] > 0) {
      r.push(a);
    }
  }
  return r;
}

function pipelineInputRequired(e, r) {
  return e && e.pipelineInputs && e.pipelineInputs[r] > 0 ? e.pipelineInputs[r] : 0;
}

function operationInputResources(e) {
  if (e && e.pipelineId) return pipelineInputResources(e);
  if (!e) return [];
  return e.direction === DIR_FORWARD ? (e.reagents || []).slice() : [ e.targetCompound ];
}

function operationOutputResources(e) {
  var r = getExpectedOutputs(e);
  if (r) {
    var t = [];
    for (var a in r) {
      if (Object.prototype.hasOwnProperty.call(r, a) && r[a] > 0) {
        t.push(a);
      }
    }
    if (t.length > 0) return t;
  }
  return e && e.direction === DIR_FORWARD ? [ e.targetCompound ] : (e && e.reagents || []).slice();
}

function countInRoom(e, r) {
  var t = getRoomState.get(e);
  if (!t || !t.terminal) return 0;
  var a = t.terminal.store;
  if (!a) return 0;
  return a.getUsedCapacity(r) || 0;
}

function getUnreservedTerminalAmount(e, r) {
  var t = storageManager.storageFind(e, r);
  if (t && t.terminal && typeof t.terminal.available === "number") {
    return Math.max(0, t.terminal.available);
  }
  return countInRoom(e, r);
}

function forEachBatchJob(e, r) {
  if (!e || !Array.isArray(e.batchBuyIds)) return;
  for (var t = 0; t < e.batchBuyIds.length; t++) {
    var a = marketBatchBuy.find(e.batchBuyIds[t]);
    if (a) r(a);
  }
}

function getBatchReservationAmount(e, r) {
  var t = 0;
  var a = e && (e.state === STATE_BUYING || e.state === STATE_WAITING || e.state === STATE_PROCESSING && !e.reactionStarted);
  forEachBatchJob(e, function(e) {
    if (a && e.state === marketBatchBuy.STATE_DONE && !(marketBatchBuy.getReservationAmount(e.id) > 0)) {
      marketBatchBuy.reserve(e.id);
    }
    if (e.resourceType === r) {
      t += marketBatchBuy.getReservationAmount(e.id) || 0;
    }
  });
  return t;
}

function releaseBatchReservations(e, r) {
  var t = false;
  forEachBatchJob(e, function(e) {
    var a = marketBatchBuy.releaseReservation(e.id, r || "lab reservation handoff");
    if (a && a.removed > 0) t = true;
  });
  return t;
}

function restoreBatchReservations(e) {
  var r = true;
  forEachBatchJob(e, function(e) {
    if (e.state !== marketBatchBuy.STATE_DONE) return;
    var t = marketBatchBuy.reserve(e.id);
    if (!t || !t.ok) r = false;
  });
  return r;
}

function requestSave() {
  if (memoryManager && typeof memoryManager.requestSave === "function") memoryManager.requestSave();
}

function marketSellAccepted(e) {
  return typeof e === "string" && (e.indexOf("Created SELL order") >= 0 || e.indexOf("extended existing") >= 0 || e.indexOf("covered existing") >= 0);
}

function isNoCanonicalSellPrice(e) {
  return typeof e === "string" && e.indexOf("[MarketSell] No canonical SELL price is available for ") >= 0;
}

function recordSellAttemptResult(e, r) {
  if (!e) return;
  e._lastSellResult = typeof r === "string" ? r : String(r);
  if (isNoCanonicalSellPrice(r)) {
    e._sellNoPriceSeen = true;
    e._sellRetryTick = Game.time + SELLING_NO_PRICE_RETRY_INTERVAL;
    requestSave();
  } else if (marketSellAccepted(r) && !e._sellNoPriceSeen) {
    delete e._sellRetryTick;
  }
}

function estimateLegacyInputAmount(e, r, t) {
  var a = 0;
  if (e.jobId) {
    try {
      var n = require("marketEconomics").get(e.jobId);
      a = n && n.input && n.input[t] ? n.input[t].acquired || 0 : 0;
    } catch (e) {}
  }
  if (!(a > 0)) {
    var o = getManagedBuyRecord(e, r, t);
    if (o) {
      try {
        a = marketBuyer.getFulfilled(o) || 0;
      } catch (e) {}
    }
  }
  if (!(a > 0)) a = getUnreservedTotalAvailable(r, t);
  return Math.min(e.batchSize || DEFAULT_BATCH_SIZE, Math.max(0, a || 0));
}

function sellBackBoughtInputs(e, r) {
  if (isStockpileOperation(e)) return true;
  var t = e && (e.state === STATE_BUYING || e.state === STATE_WAITING || e.state === STATE_PROCESSING && !e.reactionStarted);
  if (!t || !marketSeller || typeof marketSeller.marketSell !== "function") return true;
  if (e._sellRetryTick && Game.time < e._sellRetryTick) return false;
  if (e._sellRetryTick) delete e._sellRetryTick;
  var a = operationInputResources(e);
  var n = e.direction === DIR_FORWARD ? e.buyBaseAmounts : [ e.buyBaseCompoundAmount ];
  var o = [];
  var i = true;
  if (!e.sellBackAmounts) e.sellBackAmounts = {};
  if (!e.sellBackListed) e.sellBackListed = {};
  marketSeller.beginReservationBatch();
  try {
    for (var u = 0; u < a.length; u++) {
      var l = n && typeof n[u] === "number";
      if (!l && !e._legacyQueueTrim) {
        if (!e._legacySellBackBlocked) e._legacySellBackBlocked = {};
        if (!e._legacySellBackBlocked[a[u]]) {
          e._legacySellBackBlocked[a[u]] = true;
          console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": cannot safely sell back legacy input " + a[u] + " without a buy baseline.");
          requestSave();
        }
        i = false;
        continue;
      }
      var s = e.sellBackAmounts[a[u]];
      if (typeof s !== "number") {
        s = l ? Math.min(e.batchSize || DEFAULT_BATCH_SIZE, Math.max(0, countInRoom(r, a[u]) - n[u])) : estimateLegacyInputAmount(e, r, a[u]);
        e.sellBackAmounts[a[u]] = s;
      }
      if (!(s > 0)) continue;
      if (e.sellBackListed[a[u]]) continue;
      var c = l ? Math.min(Math.max(0, countInRoom(r, a[u]) - n[u]), getUnreservedTerminalAmount(r, a[u])) : getUnreservedTotalAvailable(r, a[u]);
      var d = Math.min(s, c);
      if (!(d > 0)) {
        e.sellBackListed[a[u]] = true;
        console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": cancelled input " + s + " " + a[u] + " has no unreserved post-baseline terminal delta; releasing cleanup without a sell order.");
        continue;
      }
      if (labCommodityPolicy.isTwoLetterLabProduct(a[u])) {
        labCommodityRouter.enqueue(r, a[u], d, "marketLab cancelled input", e.id, e.jobId);
        e.sellBackListed[a[u]] = true;
        o.push(d + " " + a[u] + " conversion queued");
        continue;
      }
      var f = marketSeller.marketSell(r, a[u], d, undefined, e.jobId ? {
        jobId: e.jobId
      } : null);
      if (marketSellAccepted(f)) {
        e.sellBackListed[a[u]] = true;
        o.push(d + "/" + s + " " + a[u]);
      } else if (e._legacyQueueTrim && typeof f === "string" && f.indexOf("Not enough ") >= 0 && f.indexOf(" available") >= 0) {
        e.sellBackListed[a[u]] = true;
        console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": legacy estimated input " + s + " " + a[u] + " is unavailable; releasing cleanup.");
      } else {
        i = false;
        recordSellAttemptResult(e, f);
        var m = isNoCanonicalSellPrice(f);
        var g = e._lastSellNoPriceLog || 0;
        var p = !m || !g || Game.time - g >= SELLING_NO_PRICE_LOG_INTERVAL;
        if (p) {
          console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": unable to list cancelled input " + d + "/" + s + " " + a[u] + ": " + f);
          if (m) e._lastSellNoPriceLog = Game.time;
        }
      }
    }
  } finally {
    marketSeller.endReservationBatch();
  }
  if (o.length > 0) console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": listed cancelled inputs: " + o.join(", "));
  if (i) {
    delete e._sellRetryTick;
    delete e._sellNoPriceSeen;
    delete e._lastSellNoPriceLog;
  }
  return i;
}

function operationClaimsInput(e, r) {
  if (!e || e._completed || e._failed || e._finalized) return false;
  if (e.state !== STATE_BUYING && e.state !== STATE_WAITING && !(e.state === STATE_PROCESSING && !e.reactionStarted)) return false;
  return operationInputResources(e).indexOf(r) >= 0;
}

function activeInputBuyerForRoom(e, r) {
  var t = getRoomQueues(e);
  var a = [ t.forward, t.reverse ];
  for (var n = 0; n < a.length; n++) {
    var o = a[n];
    for (var i = 0; i < o.length; i++) {
      if (operationClaimsInput(o[i], r)) return o[i];
    }
  }
  return null;
}

function canUseBatchRoom(e, r) {
  if (!Array.isArray(r)) return true;
  for (var t = 0; t < r.length; t++) {
    var a = r[t];
    if (!a || !a.resource) continue;
    if (activeInputBuyerForRoom(e, a.resource)) return false;
  }
  return true;
}

function getHandoffReservationAmountForProgram(r, t, program) {
  if (!program) return 0;
  var info = storageManager.storageFind(r, t);
  var amount = 0;
  var blocks = info ? [ info.terminal, info.storage ] : [];
  for (var index = 0; index < blocks.length; index++) {
    var reservations = blocks[index] && blocks[index].reservations || [];
    for (var reservationIndex = 0; reservationIndex < reservations.length; reservationIndex++) {
      if (reservations[reservationIndex] && reservations[reservationIndex].program === program) amount += reservations[reservationIndex].amount || 0;
    }
  }
  return amount;
}

function getHandoffReservationAmount(e, r, t) {
  if (!e) return 0;
  var program = e.handoffInputPrograms && e.handoffInputPrograms[t] || e.handoffInputProgram;
  return getHandoffReservationAmountForProgram(r, t, program);
}

function getHandoffReservationAmountForBuilding(e, r, t, a) {
  if (!e || !e.handoffInputProgram || !t) return 0;
  var n = storageManager.storageFind(r, t);
  var o = 0;
  var i = n ? a ? [ n[a] ] : [ n.terminal, n.storage ] : [];
  for (var u = 0; u < i.length; u++) {
    var l = i[u] && i[u].reservations || [];
    for (var s = 0; s < l.length; s++) {
      if (l[s] && l[s].program === e.handoffInputProgram) o += l[s].amount || 0;
    }
  }
  return o;
}

function releaseHandoffInputReservation(e, r, includeMapped) {
  if (!e) return 0;
  var released = 0;
  var seen = {};
  var release = function(resource, program) {
    if (!resource || !program || seen[resource + "|" + program]) return;
    seen[resource + "|" + program] = true;
    released += getHandoffReservationAmountForProgram(r, resource, program);
    storageManager.unReserve(r, resource, "terminal", program);
    storageManager.unReserve(r, resource, "storage", program);
  };
  if (e.handoffInputProgram && e.handoffInputResource) release(e.handoffInputResource, e.handoffInputProgram);
  if (includeMapped) {
    var programs = e.handoffInputPrograms || {};
    for (var resource in programs) release(resource, programs[resource]);
  }
  return released;
}

function reserveHandoffInput(e, r) {
  if (!e || !e.handoffInputProgram || !e.handoffInputResource || !(e.handoffInputAmount > 0)) return false;
  var t = storageManager.storageFind(r, e.handoffInputResource);
  var a = t ? [ t.terminal, t.storage ] : [];
  var n = a[0] || {}, o = a[1] || {};
  var i = getHandoffReservationAmountForBuilding(e, r, e.handoffInputResource, "terminal");
  var u = getHandoffReservationAmountForBuilding(e, r, e.handoffInputResource, "storage");
  var l = i + u;
  if (l >= e.handoffInputAmount) return true;
  var s = e.handoffInputAmount - l;
  var c = Math.max(0, (n.total || 0) - (n.reserved || 0));
  var d = Math.max(0, (o.total || 0) - (o.reserved || 0));
  if (c + d < s) return false;
  var f = Math.min(s, c);
  var m = s - f;
  if (f > 0 && !storageManager.reserve(r, e.handoffInputResource, "terminal", e.handoffInputProgram, i + f).ok) return false;
  if (m > 0 && !storageManager.reserve(r, e.handoffInputResource, "storage", e.handoffInputProgram, u + m).ok) {
    storageManager.unReserve(r, e.handoffInputResource, "terminal", e.handoffInputProgram);
    storageManager.unReserve(r, e.handoffInputResource, "storage", e.handoffInputProgram);
    if (i > 0) {
      storageManager.reserve(r, e.handoffInputResource, "terminal", e.handoffInputProgram, i);
    }
    if (u > 0) {
      storageManager.reserve(r, e.handoffInputResource, "storage", e.handoffInputProgram, u);
    }
    return false;
  }
  return true;
}

function getInputAvailableForOp(e, r, t) {
  if (operationInputCache && operationInputCache.op === e && operationInputCache.roomName === r && operationInputCache.values.hasOwnProperty(t)) {
    return operationInputCache.values[t];
  }
  var a = getRoomQueues(r);
  var n = 0;
  var o = [ a.forward, a.reverse ];
  var i = e.tickStarted || 0;
  var u = e.id || "";
  for (var l = 0; l < o.length; l++) {
    var s = o[l];
    for (var c = 0; c < s.length; c++) {
      var d = s[c];
      if (!operationClaimsInput(d, t) || d === e) continue;
      var f = d.tickStarted || 0;
      var m = d.id || "";
      if (f < i || f === i && m < u) {
        n += d.batchSize || DEFAULT_BATCH_SIZE;
      }
    }
  }
  var g;
  if (isStockpileOperation(e)) {
    var stockpileInfo = storageManager.storageFind(r, t);
    g = stockpileInfo && stockpileInfo.combined ? Math.max(0, stockpileInfo.combined.available || 0) : 0;
  } else {
    g = e && e.pipelineId ? getUnreservedTotalAvailable(r, t) : getUnreservedTerminalAmount(r, t);
  }
  var p = Math.max(0, g - n);
  p += getBatchReservationAmount(e, t);
  p += getHandoffReservationAmount(e, r, t);
  if (operationInputCache && operationInputCache.op === e && operationInputCache.roomName === r) {
    operationInputCache.values[t] = p;
  }
  return p;
}

function recordAutoTraderLabOutcome(e, r, t, a, n) {
  var o = require("autoTrader");
  if (o && typeof o.recordLabOutcome === "function") {
    o.recordLabOutcome(e, r, t, a, n);
  }
}

function getUnreservedTotalAvailable(e, r) {
  var t = Game.rooms[e];
  if (!t) return 0;
  var a = 0;
  if (t.terminal && t.terminal.store && t.terminal.store[r]) {
    a += t.terminal.store[r];
  }
  if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === "function") {
    a += terminalManager.getRoomAvailableOutsideTerminal(e, r) || 0;
  }
  var n = storageManager.storageFind(e, r);
  if (n && n.combined && typeof n.combined.reserved === "number") {
    a = Math.max(0, a - n.combined.reserved);
  }
  return a;
}

function findSuitableRoom() {
  var e = getRoomState.ownedNames();
  for (var r = 0; r < e.length; r++) {
    var t = e[r];
    var a = getRoomState.get(t);
    if (a.terminal && a.structuresByType && a.structuresByType[STRUCTURE_LAB] && a.structuresByType[STRUCTURE_LAB].length >= 3) {
      return t;
    }
  }
  return null;
}

function roomHasLabsAndTerminal(e) {
  ensureTickCache();
  if (roomReadyCache.hasOwnProperty(e)) return roomReadyCache[e];
  var r = getRoomState.get(e);
  var t = !!(r && r.isOwned && r.terminal && r.structuresByType && r.structuresByType[STRUCTURE_LAB] && r.structuresByType[STRUCTURE_LAB].length >= 3);
  roomReadyCache[e] = t;
  return t;
}

function labManagerBusy(e) {
  return !!(labManager && typeof labManager.roomHasPendingOrder === "function" && labManager.roomHasPendingOrder(e));
}

function isRoomProcessing(e) {
  var r = getRoomQueues(e);
  for (var t = 0; t < r.forward.length; t++) {
    if (r.forward[t].state === STATE_PROCESSING) return true;
  }
  for (var a = 0; a < r.reverse.length; a++) {
    if (r.reverse[a].state === STATE_PROCESSING) return true;
  }
  return false;
}

function isResourceReservedByOtherOp(e, r, t) {
  var a = getRoomQueues(e);
  var n = [ a.forward, a.reverse ];
  for (var o = 0; o < n.length; o++) {
    var i = n[o];
    for (var u = 0; u < i.length; u++) {
      var l = i[u];
      if (!l || l === t) continue;
      if (l.targetCompound === r) return true;
      if (l.reagents && (l.reagents[0] === r || l.reagents[1] === r)) return true;
    }
  }
  return false;
}

function isOutputEvacuated(e, r) {
  var t = Game.rooms[r];
  if (!t) return true;
  var a = operationOutputResources(e);
  var n = getLabsInRoom(r);
  for (var o = 0; o < n.length; o++) {
    var i = n[o].mineralType;
    if (i && a.indexOf(i) >= 0 && (n[o].mineralAmount || 0) > 0) {
      return false;
    }
  }
  for (var u = 0; u < a.length; u++) {
    if (countResourceInRoomCreeps(r, a[u]) > 0) return false;
  }
  return true;
}

function createOperation(e, r, t, a, n, o, initialState) {
  var i = calculateBatchSize(r);
  var u = tagFor(e) + "_" + r + "_" + t + "_" + Game.time + "_" + Math.random().toString(36).substr(2, 6);
  var l = {
    id: u,
    direction: e,
    origin: "marketLab",
    targetCompound: t,
    reagents: a,
    state: initialState || STATE_BUYING,
    tickStarted: Game.time,
    batchSize: i.batchSize,
    outputLabCount: i.outputLabCount,
    stockpile: !!(o && o.stockpile),
    batchMode: !!(o && o.batchMode),
    batchBuyIds: [],
    handoff: o && o.handoff ? o.handoff : null,
    handoffResource: o && o.handoffResource || null,
    handoffAmount: o && o.handoffAmount || 0,
    handoffReservationProgram: o && o.handoffReservationProgram || null,
    handoffInputResource: o && o.handoffInputResource || null,
    handoffInputAmount: o && o.handoffInputAmount || 0,
    handoffInputProgram: o && o.handoffInputProgram || null,
    handoffInputPrograms: o && o.handoffInputPrograms || null,
    conversionOnly: o && o.conversionOnly || false,
    conversionResource: o && o.conversionResource || null,
    conversionAllowPurchase: o && o.conversionAllowPurchase || false
  };
  if (o && o.conversionOnly && o.batchSize > 0) {
    l.batchSize = Math.floor(o.batchSize / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
    l.batchSize = Math.max(LAB_REACTION_AMOUNT, Math.min(i.batchSize, l.batchSize));
  }
  if (o && o.batchMode && o.batchSize > 0) {
    var s = Math.floor(o.batchSize / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
    l.batchSize = Math.max(LAB_REACTION_AMOUNT, Math.min(i.batchSize, s));
  }
  if (o && o.stockpile && o.batchSize > 0) {
    var stockpileBatch = Math.floor(o.batchSize / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
    l.batchSize = Math.max(LAB_REACTION_AMOUNT, Math.min(i.batchSize, stockpileBatch));
  }
  if (e === DIR_FORWARD) {
    l.buyBaseAmounts = [ countInRoom(r, a[0]), countInRoom(r, a[1]) ];
    if (n && typeof n === "object") {
      l.maxReagentPrices = n;
    }
  } else {
    l.buyBaseCompoundAmount = countInRoom(r, t);
    if (typeof n === "number" && n > 0) {
      l.maxBuyPrice = n;
    }
  }
  return memoryManager.compactMarketLabOperation(l, e);
}

function setupBatchPurchases(e, r, t) {
  if (!e || !Array.isArray(t)) return true;
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    if (typeof marketBuyer.cancelOrdersForProduct === "function") {
      marketBuyer.cancelOrdersForProduct(r, n.resource, e.targetCompound, "direct batch purchase superseded managed buy", "lab");
    }
    var o = marketBatchBuy.create({
      roomName: r,
      resourceType: n.resource,
      amount: n.amount,
      orderId: n.orderId,
      orderRoomName: n.orderRoomName,
      orderPrice: n.orderPrice,
      maxPrice: n.maxPrice || n.orderPrice,
      energyCost: n.energyCost,
      energyPrice: n.energyPrice,
      queue: "lab",
      ownerId: e.id,
      economicsJobId: e.jobId || null
    });
    if (!o.ok) {
      for (var i = 0; i < e.batchBuyIds.length; i++) marketBatchBuy.cancel(e.batchBuyIds[i], "lab batch setup rolled back");
      e._failed = true;
      e._failureReason = "failed to create batch purchase: " + o.reason;
      requestSave();
      return false;
    }
    e.batchBuyIds.push(o.id);
  }
  e.buyRequestCreated = true;
  delete e.batchPurchases;
  requestSave();
  return true;
}

function createPipelineOperation(e, r, t, a, n, o, initialState) {
  o = o || {};
  var i = tagFor(e) + "_pipeline_" + r + "_" + t + "_" + Game.time + "_" + Math.random().toString(36).substr(2, 6);
  var u = {};
  if (a.mode === "decompose") {
    u[t] = a.amount;
  } else {
    for (var l in a.leaves) {
      if (Object.prototype.hasOwnProperty.call(a.leaves, l)) u[l] = a.leaves[l];
    }
  }
  var s = {
    id: i,
    direction: e,
    origin: "marketLab",
    targetCompound: t,
    state: initialState || STATE_BUYING,
    tickStarted: Game.time,
    batchSize: a.amount,
    outputLabCount: 1,
    pipelineId: o.pipelineId || i,
    pipelineMode: a.mode,
    pipelineLeaves: a.leaves,
    pipelineInputs: u,
    pipelineEstimate: o.pipelineEstimate || 0,
    pipelineDeadline: o.pipelineDeadline || 0,
    expectedOutputs: a.finalOutputs,
    batchMode: false,
    batchBuyIds: [],
    conversionOnly: false
  };
  if (e === DIR_FORWARD) {
    s.buyBaseAmounts = [];
    for (var c in u) {
      if (Object.prototype.hasOwnProperty.call(u, c)) {
        s.buyBaseAmounts.push(countInRoom(r, c));
      }
    }
    if (n && typeof n === "object") s.maxReagentPrices = n;
  } else {
    s.buyBaseCompoundAmount = countInRoom(r, t);
    if (typeof n === "number" && n > 0) s.maxBuyPrice = n;
  }
  if (o.jobId) s.jobId = o.jobId;
  return memoryManager.compactMarketLabOperation(s, e);
}

function setExpectedOutputs(e, r) {
  e.expectedOutputs = r || null;
}

function getExpectedOutputs(e) {
  return e && e.expectedOutputs ? e.expectedOutputs : null;
}

function getSellRequestSoldAmount(e, r) {
  if (!e || !Array.isArray(e.sellRequestInfo)) return 0;
  var t = 0;
  for (var a = 0; a < e.sellRequestInfo.length; a++) {
    var n = e.sellRequestInfo[a];
    if (!n || n.resource !== r || !(n.amount > 0)) continue;
    if (n.orderId && Game.market && Game.market.orders && Game.market.orders[n.orderId]) {
      var o = Game.market.orders[n.orderId];
      var i = util.getOrderRemaining(o);
      if (typeof n.orderStartRemaining === "number") {
        t += Math.min(n.amount, Math.max(0, n.orderStartRemaining - i));
      } else {
        var u = 0;
        var l = Game.market.outgoingTransactions || [];
        for (var s = 0; s < l.length; s++) {
          var c = l[s];
          if (!c || !c.order || c.order.id !== n.orderId) continue;
          if (typeof c.time === "number" && c.time < (n.created || 0)) continue;
          u += c.amount || 0;
        }
        t += Math.min(n.amount, u);
      }
      continue;
    }
    if (n.orderId) {
      if (e.jobId) {
        var d = getSellLotRemainingForJob(n.orderId, e.jobId);
        if (d <= 0) t += n.amount;
      } else {
        var f = 0;
        var m = Game.market && Game.market.outgoingTransactions || [];
        for (var g = 0; g < m.length; g++) {
          var p = m[g];
          if (!p || !p.order || p.order.id !== n.orderId) continue;
          if (typeof p.time === "number" && p.time < (n.created || 0)) continue;
          f += p.amount || 0;
        }
        t += Math.min(n.amount, f);
      }
    }
  }
  return t;
}

function getCommittedSaleOutputs(e) {
  var r = {};
  var t = getRoomOperations(e);
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    if (!n || isStockpileOperation(n) || n._failed || n._completed || n.cancellationPending) continue;
    if (n.state === STATE_PENDING || n.state === STATE_BUYING) continue;
    if (typeof n.sellingStartTick === "number" && Game.time - n.sellingStartTick > SELLING_SETUP_TIMEOUT_TICKS) continue;
    var o = getExpectedOutputs(n);
    if (!o) continue;
    for (var i in o) {
      if (!Object.prototype.hasOwnProperty.call(o, i) || i === n.handoffResource) continue;
      var u = o[i] || 0;
      if (!(u > 0)) continue;
      var l = getJobSoldAmount(n, i);
      if (!(l > 0)) l = getSellRequestSoldAmount(n, i);
      var s = Math.max(0, u - Math.min(u, l));
      if (s > 0) r[i] = (r[i] || 0) + s;
    }
  }
  return r;
}

function routeRestrictedOutput(e, r, t, a, n) {
  if (!labCommodityPolicy.isTwoLetterLabProduct(t) || !(a > 0)) return false;
  labCommodityRouter.enqueue(r, t, a, n || "marketLab " + (e && e.direction || "unknown") + " output", e && e.id, e && e.jobId);
  if (!e.sellRequestInfo) e.sellRequestInfo = [];
  e.sellRequestInfo.push(makeSellTrackingEntry(r, t, 0, Game.time, null, false));
  return true;
}

function getSellTrackingTarget(e, r, t) {
  var a = getExpectedOutputs(e);
  var n = a && a[r];
  return n > 0 ? n : t;
}

function shouldLogSellCovered(e, r) {
  if (!e) return true;
  if (!e._lastSellCoveredLog) e._lastSellCoveredLog = {};
  var t = e._lastSellCoveredLog[r] || 0;
  if (Game.time - t < 50) return false;
  e._lastSellCoveredLog[r] = Game.time;
  return true;
}

function getRoomStorage(e) {
  var r = Game.rooms[e];
  return r && r.storage ? r.storage : null;
}

function reserveStagingOutputs(e, r) {
  if (!e || !e.stageReservationProgram) return true;
  var t = getRoomStorage(r);
  if (!t || !t.store) return false;
  var a = getExpectedOutputs(e);
  if (!a) return true;
  var n = Game.rooms[r] && Game.rooms[r].terminal ? Game.rooms[r].terminal : null;
  var o = true;
  for (var i in a) {
    if (!a.hasOwnProperty(i)) continue;
    var u = a[i] || 0;
    if (u <= 0) continue;
    var l = n && n.store ? n.store[i] || 0 : 0;
    var s = Math.max(0, u - l);
    if (s <= 0) {
      storageManager.unReserve(r, i, "storage", e.stageReservationProgram);
      continue;
    }
    var c = t.store[i] || 0;
    var d = Math.min(s, c);
    if (d <= 0) {
      storageManager.unReserve(r, i, "storage", e.stageReservationProgram);
      o = false;
      continue;
    }
    var f = storageManager.reserve(r, i, "storage", e.stageReservationProgram, d);
    if (!f || !f.ok) o = false;
  }
  return o;
}

function clearStagingReservations(e, r) {
  if (!e || !e.stageReservationProgram) return;
  var t = getExpectedOutputs(e);
  if (!t) return;
  for (var a in t) {
    if (!t.hasOwnProperty(a)) continue;
    storageManager.unReserve(r, a, "storage", e.stageReservationProgram);
  }
}

function ensureSellReservationProgram(e) {
  if (!e) return null;
  if (!e.sellReservationProgram) e.sellReservationProgram = "marketLabSell_" + e.id;
  return e.sellReservationProgram;
}

function getReservedByOthers(e, r, t) {
  var a = storageManager.storageFind(e, r);
  if (!a) return 0;
  var n = 0;
  var o = [ "terminal", "storage" ];
  for (var i = 0; i < o.length; i++) {
    var u = a[o[i]];
    if (!u || !Array.isArray(u.reservations)) continue;
    for (var l = 0; l < u.reservations.length; l++) {
      var s = u.reservations[l];
      if (!s) continue;
      if (t && s.program === t) continue;
      n += s.amount || 0;
    }
  }
  return n;
}

function getReservationBlockers(e, r, t) {
  var a = storageManager.storageFind(e, r);
  var n = [];
  if (!a) return n;
  var o = [ "terminal", "storage" ];
  for (var i = 0; i < o.length; i++) {
    var u = o[i];
    var l = a[u];
    if (!l || !Array.isArray(l.reservations)) continue;
    for (var s = 0; s < l.reservations.length; s++) {
      var c = l.reservations[s];
      if (!c || !(c.amount > 0)) continue;
      if (t && c.program === t) continue;
      n.push({
        building: u,
        program: c.program || "unknown",
        amount: c.amount
      });
    }
  }
  return n;
}

function getSellOrderLotSummary(e) {
  var r = require("marketEconomics");
  var t = r && typeof r.getOrderLots === "function" ? r.getOrderLots() : {};
  var a = t && t[e];
  if (!a || !Array.isArray(a.lots) || a.lots.length === 0) return "untracked";
  var n = [];
  for (var o = 0; o < a.lots.length; o++) {
    var i = a.lots[o];
    if (!i || !(i.remaining > 0)) continue;
    n.push((i.jobId || "unowned") + ":" + i.remaining);
  }
  return n.length > 0 ? n.join("|") : "no-live-lots";
}

function describeSellBlockers(e, r, t) {
  var a = [];
  var n = getReservationBlockers(e, r, t);
  for (var o = 0; o < n.length; o++) {
    var i = n[o];
    a.push(i.program + "@" + i.building + "=" + i.amount);
  }
  var u = marketSeller.getActiveOwnedSellOrders(e, r);
  for (var l = 0; l < u.length; l++) {
    var s = u[l];
    if (!s || !s.order) continue;
    a.push("order " + s.id + " remaining=" + util.getOrderRemaining(s.order) + " lots=" + getSellOrderLotSummary(s.id));
  }
  return a.length > 0 ? a.join("; ") : "no active reservation/order blocker";
}

function getAvailableForLabSell(e, r, t) {
  var a = Game.rooms[e];
  if (!a) return 0;
  var n = 0;
  if (a.terminal && a.terminal.store && a.terminal.store[r]) {
    n += a.terminal.store[r];
  }
  if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === "function") {
    n += terminalManager.getRoomAvailableOutsideTerminal(e, r) || 0;
  }
  return Math.max(0, n - getReservedByOthers(e, r, t));
}

function getBuildingFreeForProgram(e, r, t, a) {
  var n = Game.rooms[e];
  if (!n) return 0;
  var o = t === "terminal" ? n.terminal : n.storage;
  if (!o || !o.store) return 0;
  var i = o.store[r] || 0;
  if (i <= 0) return 0;
  var u = 0;
  var l = storageManager.storageFind(e, r);
  if (l && l[t] && Array.isArray(l[t].reservations)) {
    for (var s = 0; s < l[t].reservations.length; s++) {
      var c = l[t].reservations[s];
      if (!c) continue;
      if (a && c.program === a) continue;
      u += c.amount || 0;
    }
  }
  return Math.max(0, i - u);
}

function reserveSellOutputs(e, r) {
  if (!e || !e.id || e.origin !== "marketLab") return;
  var t = getExpectedOutputs(e);
  if (!t) return;
  var a = ensureSellReservationProgram(e);
  for (var n in t) {
    if (!t.hasOwnProperty(n)) continue;
    var o = t[n] || 0;
    if (o <= 0) {
      storageManager.unReserve(r, n, "terminal", a);
      storageManager.unReserve(r, n, "storage", a);
      continue;
    }
    var i = getBuildingFreeForProgram(r, n, "terminal", a);
    var u = Math.min(o, i);
    if (u > 0) {
      var l = storageManager.reserve(r, n, "terminal", a, u);
      if (!l || !l.ok) {
        storageManager.unReserve(r, n, "terminal", a);
        u = 0;
      }
    } else {
      storageManager.unReserve(r, n, "terminal", a);
    }
    var s = Math.max(0, o - u);
    var c = getBuildingFreeForProgram(r, n, "storage", a);
    var d = Math.min(s, c);
    if (d > 0) {
      var f = storageManager.reserve(r, n, "storage", a, d);
      if (!f || !f.ok) storageManager.unReserve(r, n, "storage", a);
    } else {
      storageManager.unReserve(r, n, "storage", a);
    }
  }
}

function releaseSellReservationForResource(e, r, t) {
  if (!e || !e.sellReservationProgram || !t) return;
  storageManager.unReserve(r, t, "terminal", e.sellReservationProgram);
  storageManager.unReserve(r, t, "storage", e.sellReservationProgram);
}

function handoffSellReservationForResource(e, r, t) {
  releaseSellReservationForResource(e, r, t);
  marketSeller.syncReservations();
}

function reserveSellOutputResource(e, r, t) {
  if (!e || !e.id || e.origin !== "marketLab" || !t) return;
  var a = ensureSellReservationProgram(e);
  var n = getExpectedOutputs(e);
  var o = n && n[t] ? n[t] : 0;
  if (o <= 0) o = countInRoom(r, t);
  if (o <= 0) {
    releaseSellReservationForResource(e, r, t);
    return;
  }
  var i = getBuildingFreeForProgram(r, t, "terminal", a);
  var u = Math.min(o, i);
  if (u > 0) {
    var l = storageManager.reserve(r, t, "terminal", a, u);
    if (!l || !l.ok) {
      storageManager.unReserve(r, t, "terminal", a);
      u = 0;
    }
  } else {
    storageManager.unReserve(r, t, "terminal", a);
  }
  var s = Math.max(0, o - u);
  var c = getBuildingFreeForProgram(r, t, "storage", a);
  var d = Math.min(s, c);
  if (d > 0) {
    var f = storageManager.reserve(r, t, "storage", a, d);
    if (!f || !f.ok) storageManager.unReserve(r, t, "storage", a);
  } else {
    storageManager.unReserve(r, t, "storage", a);
  }
}

function clearSellReservations(e, r) {
  if (!e || !e.sellReservationProgram) return;
  var t = e.sellReservationProgram;
  var a = {};
  function release(e) {
    if (!e || a[e]) return;
    a[e] = true;
    storageManager.unReserve(r, e, "terminal", t);
    storageManager.unReserve(r, e, "storage", t);
  }
  var n = getExpectedOutputs(e);
  if (n) {
    for (var o in n) {
      if (n.hasOwnProperty(o)) release(o);
    }
  }
  if (e.reagents) {
    for (var i = 0; i < e.reagents.length; i++) release(e.reagents[i]);
  }
  release(e.targetCompound);
  e.sellReservationProgram = null;
}

function getMarketSellRequestsFor(e, r) {
  ensureTickCache();
  var t = e + "|" + r;
  if (marketSellRequestsByResource.hasOwnProperty(t)) return marketSellRequestsByResource[t];
  var a = [];
  var n = require("marketSell");
  var o = n && typeof n.getRequests === "function" ? n.getRequests() : [];
  for (var i = 0; i < o.length; i++) {
    var u = o[i];
    if (!u) continue;
    if (u.roomName !== e) continue;
    if (u.resourceType !== r) continue;
    a.push(u);
  }
  marketSellRequestsByResource[t] = a;
  return a;
}

function sellOrderBaseline(e, r) {
  var t = Game.market && Game.market.orders;
  var a = t && t[e];
  if (!a) return null;
  var n = 0;
  var o = Game.market.outgoingTransactions || [];
  for (var i = 0; i < o.length; i++) {
    var u = o[i];
    if (!u || !u.order || u.order.id !== e) continue;
    if (typeof u.time === "number" && u.time < (r || 0)) continue;
    n += u.amount || 0;
  }
  return util.getOrderRemaining(a) + n;
}

function recoverLegacySellRequestIds(e, r) {
  if (!e || !Array.isArray(e.sellRequestInfo)) return false;
  var t = false;
  var a = Game.market && Game.market.orders || {};
  var n = require("marketEconomics");
  var o = n && typeof n.getOrderLots === "function" ? n.getOrderLots() : {};
  for (var i = 0; i < e.sellRequestInfo.length; i++) {
    var u = e.sellRequestInfo[i];
    if (!u || u.unavailable || !(u.amount > 0) || u.orderId) continue;
    var l = {};
    function add(e, t) {
      if (!e || !a[e]) return;
      var n = a[e];
      if (n.type !== ORDER_SELL || n.roomName !== r || n.resourceType !== u.resource || !(util.getOrderRemaining(n) > 0)) return;
      if (!l[e] || l[e].score < t) {
        l[e] = {
          id: e,
          score: t
        };
      }
    }
    for (var s in o) {
      var c = o[s];
      if (!c || !Array.isArray(c.lots)) continue;
      for (var d = 0; d < c.lots.length; d++) {
        if (c.lots[d] && c.lots[d].jobId === e.jobId && c.lots[d].remaining > 0) {
          add(s, 100);
          break;
        }
      }
    }
    var f = getMarketSellRequestsFor(r, u.resource);
    for (var m = 0; m < f.length; m++) {
      var g = f[m];
      if (!g || !g.orderId) continue;
      var p = 0;
      if (e.jobId && g.jobId === e.jobId) p += 100;
      if (g.created === u.created) p += 50; else if (u.created && Math.abs((g.created || 0) - u.created) <= 5) p += 20;
      if (g.amount === u.amount) p += 20; else if ((g.amount || 0) >= u.amount) p += 5;
      if (p > 0) add(g.orderId, p);
    }
    var v = null;
    var R = false;
    for (var y in l) {
      var b = l[y];
      if (!v || b.score > v.score) {
        v = b;
        R = false;
      } else if (b.score === v.score) {
        R = true;
      }
    }
    if (!v || R || v.score < 20) continue;
    u.orderId = v.id;
    var S = sellOrderBaseline(v.id, u.created);
    if (S !== null) u.orderStartRemaining = S;
    t = true;
  }
  if (t) {
    console.log("[marketLab] Recovered legacy sell order links for " + e.id);
    requestSave();
  }
  return t;
}

function hasOwnedSellLot(e) {
  if (!e) return false;
  try {
    var r = require("marketEconomics");
    return typeof r.hasSellLotForJob === "function" && r.hasSellLotForJob(e);
  } catch (e) {}
  return false;
}

function staleSellingWithoutLot(e) {
  if (!e || e.state !== STATE_SELLING) return false;
  if (isStockpileOperation(e)) return false;
  if (hasOwnedSellLot(e.jobId)) return false;
  return Game.time - (e.sellingStartTick || e.tickStarted || Game.time) >= STALE_SELLING_TICKS;
}

function isMarketSellRequestActive(e, r, t, a) {
  var n = getMarketSellRequestsFor(e, r);
  for (var o = 0; o < n.length; o++) {
    var i = n[o];
    if (i.orderId && Game.market && Game.market.orders && Game.market.orders[i.orderId]) {
      var u = Game.market.orders[i.orderId];
      if (util.getOrderRemaining(u) > 0) return true;
    }
    if (typeof t === "number" && (i.amount || 0) < t) continue;
    if (typeof a === "number" && i.created !== a) continue;
    return true;
  }
  return false;
}

function getActiveMarketSellRequest(e, r, t) {
  var a = getMarketSellRequestsFor(e, r);
  for (var n = 0; n < a.length; n++) {
    var o = a[n];
    if (o.orderId && Game.market && Game.market.orders && Game.market.orders[o.orderId]) {
      var i = Game.market.orders[o.orderId];
      if (util.getOrderRemaining(i) > 0) {
        if (typeof t !== "number" || util.getOrderRemaining(i) >= t || (o.amount || 0) >= t) {
          return o;
        }
      }
    }
    if (typeof t === "number" && (o.amount || 0) < t) continue;
    if (o.created === Game.time) return o;
  }
  return null;
}

function getMarketSellCoveredAmount(e, r) {
  var t = getMarketSellRequestsFor(e, r);
  var a = 0;
  var n = {};
  for (var o = 0; o < t.length; o++) {
    var i = t[o];
    if (i.orderId && Game.market && Game.market.orders && Game.market.orders[i.orderId]) {
      if (n[i.orderId]) continue;
      n[i.orderId] = true;
      var u = Game.market.orders[i.orderId];
      if (util.getOrderRemaining(u) > 0) {
        a += util.getOrderRemaining(u);
        continue;
      }
    }
    if (i.orderId) continue;
    if (i.created === Game.time && typeof i.amount === "number" && i.amount > 0) {
      a += i.amount;
    }
  }
  return a;
}

function getMarketSellCoveredAmountForJob(e, r, t) {
  if (!t) return getMarketSellCoveredAmount(e, r);
  var a = 0;
  var n = Game.market && Game.market.orders ? Game.market.orders : {};
  for (var o in n) {
    var i = n[o];
    if (!i || i.type !== ORDER_SELL || i.roomName !== e || i.resourceType !== r || !(util.getOrderRemaining(i) > 0)) continue;
    a += getSellLotRemainingForJob(o, t);
  }
  var u = getMarketSellRequestsFor(e, r);
  for (var l = 0; l < u.length; l++) {
    var s = u[l];
    if (!s.orderId && s.jobId === t && s.created === Game.time && s.amount > 0) {
      a += s.amount;
    }
  }
  return a;
}

function getSellLotRemainingForJob(e, r) {
  if (!e || !r) return 0;
  try {
    return require("marketEconomics").getSellLotRemaining(e, r) || 0;
  } catch (e) {}
  return 0;
}

function getActiveMarketSellRequestForJob(e, r, t, a) {
  if (!a) return getActiveMarketSellRequest(e, r, t);
  var n = getMarketSellRequestsFor(e, r);
  for (var o = 0; o < n.length; o++) {
    var i = n[o];
    if (i.jobId && i.jobId !== a) continue;
    if (i.orderId && Game.market && Game.market.orders && Game.market.orders[i.orderId]) {
      var u = Game.market.orders[i.orderId];
      if (util.getOrderRemaining(u) > 0) {
        if (typeof t !== "number" || util.getOrderRemaining(u) >= t || (i.amount || 0) >= t) {
          if (getSellLotRemainingForJob(i.orderId, a) >= (t || 0)) return i;
        }
      }
    }
    if (typeof t === "number" && (i.amount || 0) < t) continue;
    if (!i.orderId && i.jobId === a && i.created === Game.time) return i;
  }
  return null;
}

function findLiveOwnedSellOrderForJob(e, r, t, a) {
  if (!a) return findLiveOwnedSellOrder(e, r, t);
  if (!Game.market || !Game.market.orders) return null;
  ensureTickCache();
  var n = e + "|" + r + "|" + (typeof t === "number" ? t : "any") + "|" + a;
  if (ownedSellOrderCache.hasOwnProperty(n)) return ownedSellOrderCache[n];
  var o = null;
  var i = -1;
  for (var u in Game.market.orders) {
    var l = Game.market.orders[u];
    if (!l || l.type !== ORDER_SELL) continue;
    if (l.roomName !== e) continue;
    if (l.resourceType !== r) continue;
    var s = util.getOrderRemaining(l);
    if (!(s > 0)) continue;
    if (typeof t === "number" && s < t) continue;
    if (getSellLotRemainingForJob(u, a) < (t || 0)) continue;
    var c = Game.rooms[l.roomName];
    if (!c || !c.controller || !c.controller.my) continue;
    if (s > i) {
      i = s;
      o = u;
    }
  }
  ownedSellOrderCache[n] = o;
  return o;
}

function findLiveOwnedSellOrder(e, r, t) {
  if (!Game.market || !Game.market.orders) return null;
  ensureTickCache();
  var a = e + "|" + r + "|" + (typeof t === "number" ? t : "any");
  if (ownedSellOrderCache.hasOwnProperty(a)) return ownedSellOrderCache[a];
  var n = null;
  var o = -1;
  for (var i in Game.market.orders) {
    var u = Game.market.orders[i];
    if (!u || u.type !== ORDER_SELL) continue;
    if (u.roomName !== e) continue;
    if (u.resourceType !== r) continue;
    var l = util.getOrderRemaining(u);
    if (!(l > 0)) continue;
    if (typeof t === "number" && l < t) continue;
    var s = Game.rooms[u.roomName];
    if (!s || !s.controller || !s.controller.my) continue;
    if (l > o) {
      o = l;
      n = i;
    }
  }
  ownedSellOrderCache[a] = n;
  return n;
}

function getStagingNeed(e, r, t) {
  var a = getExpectedOutputs(e);
  if (!a || !a.hasOwnProperty(t)) return 0;
  var n = a[t] || 0;
  if (n <= 0) return 0;
  var o = Game.rooms[r];
  if (!o || !o.terminal) return n;
  var i = o.terminal.store[t] || 0;
  return Math.max(0, n - i);
}

function countResourceInLabs(e, r) {
  var t = getLabsInRoom(e);
  var a = 0;
  for (var n = 0; n < t.length; n++) {
    if (t[n].mineralType === r) a += t[n].mineralAmount || 0;
  }
  return a;
}

function countResourceInRoomCreeps(e, r) {
  ensureTickCache();
  var t = creepResourceCache[e];
  if (!t) {
    t = {};
    creepResourceCache[e] = t;
  }
  if (t.hasOwnProperty(r)) return t[r];
  var a = 0;
  var n = getRoomState.creepIndex();
  var o = n && n.all ? n.all : [];
  for (var i = 0; i < o.length; i++) {
    var u = o[i];
    if (!u || !u.room || u.room.name !== e || !u.store) continue;
    a += u.store[r] || 0;
  }
  t[r] = a;
  return a;
}

function getStagingAvailability(e, r) {
  var t = Game.rooms[e];
  var a = t && t.terminal && t.terminal.store ? t.terminal.store[r] || 0 : 0;
  var n = t && t.storage && t.storage.store ? t.storage.store[r] || 0 : 0;
  var o = countResourceInLabs(e, r);
  var i = countResourceInRoomCreeps(e, r);
  return {
    terminal: a,
    storage: n,
    labs: o,
    creeps: i,
    pending: n + o + i
  };
}

function getStorageReservationAmount(e, r, t) {
  if (!t) return 0;
  var a = storageManager.storageFind(e, r);
  var n = a && a.storage && Array.isArray(a.storage.reservations) ? a.storage.reservations : [];
  for (var o = 0; o < n.length; o++) {
    if (n[o] && n[o].program === t) return n[o].amount || 0;
  }
  return 0;
}

function tagFor(e) {
  return e === DIR_FORWARD ? "labForward" : "labReverse";
}

function shortTagFor(e) {
  return e === DIR_FORWARD ? "fwd" : "rev";
}

function runBuying(e, r) {
  var t = findBuyingOperation(e.direction, e.targetCompound);
  if (t && t.op !== e) {
    pauseActiveBuyingClock(e);
    var a = t.op.id || t.roomName + "/" + e.targetCompound;
    if (buyLockWaitOwners[e.id] !== a) {
      buyLockWaitOwners[e.id] = a;
      if (e.buyRequestCreated || e.useMarketBuy) cancelBuyForOp(e.direction, r, e);
      e.buyingStartedTick = Game.time;
      requestSave();
      console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": buy lock held by " + t.roomName + "/" + t.op.targetCompound + "; waiting without a buy request.");
    }
    return;
  }
  if (buyLockWaitOwners[e.id]) {
    console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": buy lock acquired; purchasing may resume.");
    delete buyLockWaitOwners[e.id];
    e.buyingStartedTick = Game.time;
    requestSave();
  }
  if (e.replacementPending) {
    if (operationHasPendingBuy(e, r)) return;
    if (getProcessableBuyingAmount(e, r) < getMinimumPartialAmount(e)) return;
    delete e.replacementPending;
    console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": replacement cancelled because settled input now qualifies for a partial batch.");
    requestSave();
  }
  if (e.buyCancellationPending) {
    pauseActiveBuyingClock(e);
    if (!cancelBuyForOp(e.direction, r, e)) return;
    delete e.buyCancellationPending;
    requestSave();
  }
  resumeActiveBuyingClock(e);
  phaseJob(e, "buying");
  if (!e.buyingStartedTick) {
    e.buyingStartedTick = e.tickStarted || Game.time;
    requestSave();
  }
  if (!e.pipelineId && maybePromotePartialBatch(e, r)) return;
  if (Game.time - e.buyingStartedTick > BUYING_TIMEOUT_TICKS) {
    e._failed = true;
    e._failureReason = "buying timed out after " + BUYING_TIMEOUT_TICKS + " ticks";
    requestSave();
    return;
  }
  if (e.batchMode) {
    runBatchBuying(e, r);
    return;
  }
  if (e.pipelineId) {
    runBuyingPipeline(e, r);
    return;
  }
  if (e.direction === DIR_FORWARD) {
    runBuyingForward(e, r);
  } else {
    runBuyingReverse(e, r);
  }
  if (!e._failed) maybeTopUpLabMarketBuy(e, r);
}

function getPipelineInputAmount(e, r, t) {
  var a = pipelineInputRequired(e, r);
  if (!(a > 0)) return 0;
  return Math.ceil(a * t / Math.max(1, e.batchSize || t));
}

function getPipelineUsableAmount(e, r) {
  var t = e.batchSize || 0;
  var a = operationInputResources(e);
  for (var n = 0; n < a.length; n++) {
    var o = a[n];
    var i = pipelineInputRequired(e, o);
    if (!(i > 0)) continue;
    t = Math.min(t, Math.floor(getInputAvailableForOp(e, r, o) * (e.batchSize || 1) / i));
  }
  return Math.max(0, Math.floor(t / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT);
}

function runBuyingPipeline(e, r) {
  var t = operationInputResources(e);
  var a = getPipelineUsableAmount(e, r);
  if (a >= e.batchSize) {
    if (!cancelBuyForOp(e.direction, r, e)) {
      e.buyCancellationPending = true;
      requestSave();
      return;
    }
    recordOwnedInputs(e, t);
    moveToProcessingOrWaiting(e, r);
    return;
  }
  if (e.buyRequestCreated && recoverMissingPipelineBuyRequests(e, r, t)) return;
  var n = 0;
  for (var o = 0; o < t.length; o++) {
    var i = t[o];
    var u = getInputAvailableForOp(e, r, i);
    var l = getPipelineInputAmount(e, i, e.batchSize) - u;
    if (!(l > 0)) continue;
    if (isLiveManagedBuy(getManagedBuyRecord(e, r, i))) continue;
    var s = e.direction === DIR_FORWARD && e.maxReagentPrices && e.maxReagentPrices[i] > 0 ? e.maxReagentPrices[i] : e.direction === DIR_REVERSE && e.maxBuyPrice > 0 ? e.maxBuyPrice : pricing.getAvg48h(i);
    if (!(s > 0)) {
      e._failed = true;
      e._failureReason = "no profitable buy ceiling available for " + i;
      requestSave();
      return;
    }
    if (labShouldUseMarketBuy(e.targetCompound, i, s)) {
      var c = labComputeBid(i, s);
      if (c !== null) {
        var d = marketBuyer.marketBuy(r, i, l, c, {
          product: e.targetCompound,
          room: r,
          ceiling: s,
          queue: "lab",
          opId: e.id,
          jobId: e.jobId || null
        });
        if (marketBuyCreationAccepted(d)) {
          trackMarketBuyForLab(e, i, s);
          n++;
          requestSave();
        }
      }
    }
    if (!getActiveOpportunisticBuy(e, r, i) && !(e.useMarketBuy && e.useMarketBuy[i])) {
      if (createLabOpportunisticBuy(e, r, i, l, s)) n++;
    }
  }
  if (n > 0) {
    e.buyRequestCreated = true;
    requestSave();
  }
}

function recoverMissingPipelineBuyRequests(e, r, t) {
  var a = false;
  for (var n = 0; n < t.length; n++) {
    var o = t[n];
    if (getInputAvailableForOp(e, r, o) >= getPipelineInputAmount(e, o, e.batchSize)) continue;
    if (getActiveOpportunisticBuy(e, r, o) || isLiveManagedBuy(getManagedBuyRecord(e, r, o))) {
      a = true;
      continue;
    }
    if (e.useMarketBuy) e.useMarketBuy[o] = false;
    if (e.marketBuyToppedUp) e.marketBuyToppedUp[o] = false;
    delete e.buyRequestCreated;
    requestSave();
    return false;
  }
  return a;
}

function getBuyingUsableAmount(e, r) {
  if (!e) return 0;
  if (e.pipelineId) return getPipelineUsableAmount(e, r);
  if (e.direction === DIR_FORWARD) {
    return Math.min(getInputAvailableForOp(e, r, e.reagents[0]), getInputAvailableForOp(e, r, e.reagents[1]));
  }
  return getInputAvailableForOp(e, r, e.targetCompound);
}

function getProcessableBuyingAmount(e, r) {
  var t = getBuyingUsableAmount(e, r);
  return Math.floor(Math.max(0, t) / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
}

function getMinimumPartialAmount(e) {
  var r = e && e.batchSize ? e.batchSize : DEFAULT_BATCH_SIZE;
  return Math.ceil(r * MIN_PARTIAL_BATCH_RATIO / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
}

function hasPartialBatchPurchase(e) {
  if (!e || !e.batchMode || !Array.isArray(e.batchBuyIds)) return false;
  for (var r = 0; r < e.batchBuyIds.length; r++) {
    var t = marketBatchBuy.find(e.batchBuyIds[r]);
    if (t && t.state === marketBatchBuy.STATE_DONE && t.fulfilled > 0 && t.fulfilled < (t.requestedAmount || t.amount)) return true;
  }
  return false;
}

function getBuyingAge(e) {
  if (typeof e.activeBuyingTicks !== "number" && !e.buyingActiveSince) {
    return e.buyRequestCreated ? Math.max(0, Game.time - (e.buyingStartedTick || e.tickStarted || Game.time)) : 0;
  }
  return (e.activeBuyingTicks || 0) + (e.buyingActiveSince ? Game.time - e.buyingActiveSince : 0);
}

function pauseActiveBuyingClock(e) {
  if (!e || !e.buyingActiveSince) return;
  e.activeBuyingTicks = (e.activeBuyingTicks || 0) + Math.max(0, Game.time - e.buyingActiveSince);
  delete e.buyingActiveSince;
  requestSave();
}

function resumeActiveBuyingClock(e) {
  if (!e || e.buyingActiveSince) return;
  if (typeof e.activeBuyingTicks !== "number") {
    e.activeBuyingTicks = e.buyRequestCreated ? Math.max(0, Game.time - (e.buyingStartedTick || e.tickStarted || Game.time)) : 0;
  }
  e.buyingActiveSince = Game.time;
  requestSave();
}

function operationHasPendingBuy(e, r) {
  if (e && e.batchMode && Array.isArray(e.batchBuyIds)) {
    for (var t = 0; t < e.batchBuyIds.length; t++) {
      var a = marketBatchBuy.find(e.batchBuyIds[t]);
      if (a && (a.state === marketBatchBuy.STATE_QUEUED || a.state === marketBatchBuy.STATE_PENDING)) return true;
    }
  }
  var n = operationInputResources(e);
  for (var o = 0; o < n.length; o++) {
    var i = opportunisticBuy.getRequest(r, n[o], {
      queue: "lab",
      opId: e.id
    });
    if (i && i.pending && typeof i.pending.expected === "number") return true;
    var u = getManagedBuyRecord(e, r, n[o]);
    if (u && !u.done && !u.cancelled && !u.orderId) return true;
  }
  return false;
}

function operationHasUnsafePendingBuy(e, r) {
  if (e && e.batchMode && Array.isArray(e.batchBuyIds)) {
    for (var t = 0; t < e.batchBuyIds.length; t++) {
      var a = marketBatchBuy.find(e.batchBuyIds[t]);
      if (a && (a.state === marketBatchBuy.STATE_QUEUED || a.state === marketBatchBuy.STATE_PENDING)) return true;
    }
  }
  var n = operationInputResources(e);
  for (var o = 0; o < n.length; o++) {
    var i = opportunisticBuy.getRequest(r, n[o], {
      queue: "lab",
      opId: e.id
    });
    if (i && i.pending && typeof i.pending.expected === "number") return true;
  }
  return false;
}

function getActiveOpportunisticBuy(e, r, t) {
  var a = opportunisticBuy.getRequest(r, t, {
    queue: "lab",
    opId: e.id
  });
  if (!a) return null;
  if (a.remaining > 0) return a;
  if (a.pending && typeof a.pending.expected === "number") return a;
  return null;
}

function createLabOpportunisticBuy(e, r, t, a, n) {
  opportunisticBuy.setup(r, t, a, n, {
    queue: "lab",
    product: e.targetCompound,
    direction: e.direction,
    opId: e.id,
    jobId: e.jobId || null
  });
  return !!getActiveOpportunisticBuy(e, r, t);
}

function runBatchBuying(e, r) {
  if (!Array.isArray(e.batchBuyIds) || e.batchBuyIds.length === 0) {
    e._failed = true;
    e._failureReason = "batch operation has no purchase jobs";
    requestSave();
    return;
  }
  var t = false;
  for (var a = 0; a < e.batchBuyIds.length; a++) {
    var n = marketBatchBuy.find(e.batchBuyIds[a]);
    if (!n) {
      e._failed = true;
      e._failureReason = "batch purchase job disappeared: " + e.batchBuyIds[a];
      requestSave();
      return;
    }
    if (n.state === marketBatchBuy.STATE_FAILED || n.state === marketBatchBuy.STATE_CANCELLED) {
      e._failed = true;
      e._failureReason = "batch purchase failed for " + n.resourceType + ": " + (n.reason || n.state);
      requestSave();
      return;
    }
    if (n.state !== marketBatchBuy.STATE_DONE) t = true;
  }
  if (t) return;
  if (getBuyingUsableAmount(e, r) < e.batchSize) return;
  console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": batch purchases confirmed (" + e.batchSize + ").");
  moveToProcessingOrWaiting(e, r);
}

function partialBatchBlockedByRoomQueue(e, r, t) {
  var a = getRoomQueues(r);
  var n = a.forward.concat(a.reverse);
  var o = t / Math.max(1, e.batchSize || DEFAULT_BATCH_SIZE);
  for (var i = 0; i < n.length; i++) {
    var u = n[i];
    if (!u || u === e || u._failed || u._completed) continue;
    if (u.state === STATE_WAITING || u.state === STATE_PROCESSING) return u;
    if (u.state !== STATE_BUYING) continue;
    var l = getProcessableBuyingAmount(u, r);
    var s = l / Math.max(1, u.batchSize || DEFAULT_BATCH_SIZE);
    if (l >= (u.batchSize || DEFAULT_BATCH_SIZE) || s > o) return u;
  }
  return null;
}

function maybePromotePartialBatch(e, r) {
  if (!e || e.partialBatchOriginal || !hasPartialBatchPurchase(e) && getBuyingAge(e) < STALE_BUYING_TICKS) return false;
  var t = getProcessableBuyingAmount(e, r);
  if (t < getMinimumPartialAmount(e) || t >= e.batchSize) return false;
  var a = partialBatchBlockedByRoomQueue(e, r, t);
  var n = operationHasPendingBuy(e, r);
  if (a || n) {
    var o = n ? "pending buy settlement" : a.targetCompound + " is more ready (" + a.state + ")";
    if (partialWaitReasons[e.id] !== o) {
      partialWaitReasons[e.id] = o;
      console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": partial " + t + "/" + e.batchSize + " deferred; " + o + ".");
    }
    return false;
  }
  var i = e.batchSize;
  var u = getOperationAcquiredInputs(e, r);
  delete partialWaitReasons[e.id];
  if (!cancelBuyForOp(e.direction, r, e)) {
    e.buyCancellationPending = true;
    console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": partial promotion deferred until managed buy cancellation is confirmed.");
    requestSave();
    return true;
  }
  e.partialBatchOriginal = i;
  e.batchSize = t;
  var l = [];
  for (var s in u.amounts) {
    var c = Math.max(0, (u.amounts[s] || 0) - t);
    if (!(c > 0)) continue;
    if (labCommodityPolicy.isTwoLetterLabProduct(s)) {
      labCommodityRouter.enqueue(r, s, c, "marketLab partial purchased surplus", e.id, e.jobId);
      l.push(c + " " + s + " conversion queued");
      continue;
    }
    var d = marketSeller.marketSell(r, s, c, undefined, e.jobId ? {
      jobId: e.jobId
    } : null);
    if (marketSellAccepted(d)) l.push(c + " " + s); else {
      if (!e.partialSurplusPending) e.partialSurplusPending = {};
      e.partialSurplusPending[s] = c;
      console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": partial purchased surplus pending sale " + c + " " + s + ": " + d);
    }
  }
  console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": stale partial promoted at " + t + "/" + i + " (" + (t / i * 100).toFixed(1) + "%); remaining buys cancelled" + (l.length > 0 ? ", purchased surplus listed: " + l.join(", ") : "") + ".");
  recordOwnedInputs(e, e.direction === DIR_FORWARD ? e.reagents : [ e.targetCompound ]);
  moveToProcessingOrWaiting(e, r);
  return true;
}

function recordOwnedInputs(e, r) {
  if (!e.jobId || e._ownedInputsRecorded) return;
  try {
    var t = require("marketEconomics");
    var a = t.get(e.jobId);
    for (var n = 0; n < r.length; n++) {
      var o = r[n];
      var i = a && a.input && a.input[o] ? a.input[o].acquired || 0 : 0;
      var u = e.pipelineId ? pipelineInputRequired(e, o) : e.batchSize || 0;
      var l = Math.max(0, u - i);
      var s = pricing.passiveSellPrice(o) || 0;
      if (l > 0 && s > 0) t.recordOwnedOpportunity(e.jobId, o, l, l * s);
    }
    e._ownedInputsRecorded = true;
    requestSave();
  } catch (e) {}
}

function runBuyingForward(e, r) {
  var t = getInputAvailableForOp(e, r, e.reagents[0]);
  var a = getInputAvailableForOp(e, r, e.reagents[1]);
  if (e.conversionOnly && e.conversionResource) {
    var n = e.conversionResource === e.reagents[0] ? t : e.conversionResource === e.reagents[1] ? a : 0;
    if (n < e.batchSize) {
      e._conversionBlocked = true;
      return;
    }
    e._conversionBlocked = false;
  }
  if (t >= e.batchSize && a >= e.batchSize) {
    console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": reagents acquired.");
    if (!cancelBuyForOp(e.direction, r, e)) {
      e.buyCancellationPending = true;
      requestSave();
      return;
    }
    recordOwnedInputs(e, e.reagents);
    moveToProcessingOrWaiting(e, r);
    return;
  }
  recoverMissingBuyRequests(e, r, e.reagents);
  if (e.buyRequestCreated) return;
  var o = 0;
  for (var i = 0; i < e.reagents.length; i++) {
    var u = e.reagents[i];
    var l = getInputAvailableForOp(e, r, u);
    if (l >= e.batchSize) continue;
    if (e.conversionOnly && u === e.conversionResource && !e.conversionAllowPurchase) continue;
    var s = e.maxReagentPrices && e.maxReagentPrices[u] > 0 ? e.maxReagentPrices[u] : pricing.getAvg48h(u);
    if (!(s > 0)) {
      e._failed = true;
      e._failureReason = "no profitable buy ceiling available for " + u;
      requestSave();
      return;
    }
    var c = e.batchSize - l;
    if (labShouldUseMarketBuy(e.targetCompound, u, s)) {
      var d = labComputeBid(u, s);
      if (d === null) {
        console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": ask floor for " + u + " exceeds ceiling " + s.toFixed(3) + " - skipping marketBuy, falling back to opportunisticBuy");
        if (createLabOpportunisticBuy(e, r, u, c, s)) o++;
      } else {
        var f = marketBuyer.marketBuy(r, u, c, d, {
          product: e.targetCompound,
          room: r,
          ceiling: s,
          queue: "lab",
          opId: e.id,
          jobId: e.jobId || null
        });
        if (marketBuyCreationAccepted(f)) {
          trackMarketBuyForLab(e, u, s);
          o++;
          requestSave();
        } else {
          var m = getManagedBuyRecord(e, r, u);
          if (isLiveManagedBuy(m)) {
            trackMarketBuyForLab(e, u, s);
            o++;
          } else if (createLabOpportunisticBuy(e, r, u, c, s)) {
            o++;
            console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": marketBuy unavailable for " + u + "; using opportunisticBuy fallback.");
          }
        }
        console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": marketBuy for " + c + " " + u + " @ " + d.toFixed(3) + " (ceiling " + s.toFixed(3) + "): " + f);
      }
    } else {
      var g = createLabOpportunisticBuy(e, r, u, c, s);
      console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": opportunisticBuy for " + c + " " + u + " @ " + s.toFixed(3));
      if (g) o++;
    }
  }
  if (o > 0) {
    e.buyRequestCreated = true;
    requestSave();
  }
}

function runBuyingReverse(e, r) {
  var t = getInputAvailableForOp(e, r, e.targetCompound);
  if (e.conversionOnly && t < e.batchSize) {
    e._conversionBlocked = true;
    return;
  }
  e._conversionBlocked = false;
  if (t >= e.batchSize) {
    console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": batch acquired (" + t + ").");
    if (!cancelBuyForOp(e.direction, r, e)) {
      e.buyCancellationPending = true;
      requestSave();
      return;
    }
    recordOwnedInputs(e, [ e.targetCompound ]);
    moveToProcessingOrWaiting(e, r);
    return;
  }
  recoverMissingBuyRequests(e, r, [ e.targetCompound ]);
  if (e.buyRequestCreated) return;
  var a;
  if (e.maxBuyPrice) {
    a = e.maxBuyPrice;
  } else {
    a = pricing.getAvg48h(e.targetCompound);
  }
  if (!(a > 0)) {
    e._failed = true;
    e._failureReason = "no profitable buy ceiling available for " + e.targetCompound;
    requestSave();
    return;
  }
  var n = e.batchSize - t;
  if (labShouldUseMarketBuy(e.targetCompound, e.targetCompound, a)) {
    var o = labComputeBid(e.targetCompound, a);
    if (o === null) {
      console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": ask floor exceeds ceiling " + a.toFixed(3) + " - skipping marketBuy, falling back to opportunisticBuy");
      if (createLabOpportunisticBuy(e, r, e.targetCompound, n, a)) {
        e.buyRequestCreated = true;
        requestSave();
      }
    } else {
      var i = marketBuyer.marketBuy(r, e.targetCompound, n, o, {
        product: e.targetCompound,
        room: r,
        ceiling: a,
        queue: "lab",
        opId: e.id,
        jobId: e.jobId || null
      });
      if (marketBuyCreationAccepted(i)) {
        trackMarketBuyForLab(e, e.targetCompound, a);
        e.buyRequestCreated = true;
        requestSave();
      } else {
        var u = getManagedBuyRecord(e, r, e.targetCompound);
        if (isLiveManagedBuy(u)) {
          trackMarketBuyForLab(e, e.targetCompound, a);
          e.buyRequestCreated = true;
          requestSave();
        } else if (createLabOpportunisticBuy(e, r, e.targetCompound, n, a)) {
          e.buyRequestCreated = true;
          requestSave();
          console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": marketBuy unavailable; using opportunisticBuy fallback.");
        }
      }
      console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": marketBuy for " + n + " @ " + o.toFixed(3) + " (ceiling " + a.toFixed(3) + "): " + i);
    }
  } else {
    if (createLabOpportunisticBuy(e, r, e.targetCompound, n, a)) {
      e.buyRequestCreated = true;
      requestSave();
    }
    console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": opportunisticBuy for " + n + " @ " + a.toFixed(3));
  }
}

function marketBuyCreationAccepted(e) {
  if (e === OK || e === true || e === "queued") return true;
  if (e && typeof e === "object") return !!(e.ok || e.created || e.queued);
  if (typeof e !== "string") return false;
  var r = e.toLowerCase();
  if (r.indexOf("already") >= 0 || r.indexOf("exists") >= 0 || r.indexOf("refus") >= 0 || r.indexOf("fail") >= 0 || r.indexOf("error") >= 0 || r.indexOf("invalid") >= 0 || r.indexOf("cannot") >= 0) return false;
  return r.indexOf("created") >= 0 || r.indexOf("queued") >= 0 || r.indexOf("placed") >= 0;
}

function getManagedBuyRecord(e, r, t) {
  try {
    return marketBuyer.getOrderRecordFor(r, t, "lab", e.id);
  } catch (e) {
    return null;
  }
}

function isLiveManagedBuy(e) {
  return !!(e && !e.done && !e.cancelled && !e.cancelRequested);
}

function recoverMissingBuyRequests(e, r, t) {
  if (!e.buyRequestCreated) return;
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    if (getInputAvailableForOp(e, r, n) >= e.batchSize) continue;
    var o = getActiveOpportunisticBuy(e, r, n);
    var i = getManagedBuyRecord(e, r, n);
    if (o || isLiveManagedBuy(i)) continue;
    if (e.useMarketBuy) e.useMarketBuy[n] = false;
    if (e.marketBuyToppedUp) e.marketBuyToppedUp[n] = false;
    delete e.buyRequestCreated;
    requestSave();
    return;
  }
}

function trackMarketBuyForLab(e, r, t) {
  if (!e.useMarketBuy) e.useMarketBuy = {};
  if (!e.marketBuyCeilings) e.marketBuyCeilings = {};
  var a = false;
  if (!e.marketBuyTopUpState || typeof e.marketBuyTopUpState !== "object" || Array.isArray(e.marketBuyTopUpState)) {
    e.marketBuyTopUpState = {};
    a = true;
  }
  if (!e.marketBuyTopUpState[r]) {
    e.marketBuyTopUpState[r] = {
      firstSeenTick: Game.time,
      lastAttemptTick: null
    };
    a = true;
  }
  e.useMarketBuy[r] = true;
  e.marketBuyCeilings[r] = t;
  if (a) requestSave();
}

function cancelTrackedMarketBuyOrders(e, r, t) {
  if (!e.useMarketBuy || !e.useMarketBuy[t]) return true;
  try {
    marketBuyer.cancelOrderFor(r, t, "lab op acquired: " + e.targetCompound, "lab", e.id);
  } catch (e) {
    return false;
  }
  var a = getManagedBuyRecord(e, r, t);
  if (a && !a.done && !a.cancelled && !a.cancelRequested) return false;
  e.useMarketBuy[t] = false;
  return true;
}

function cancelAllTrackedMarketBuyOrders(e, r) {
  if (!e.useMarketBuy) return true;
  var t = true;
  for (var a in e.useMarketBuy) {
    if (!e.useMarketBuy.hasOwnProperty(a)) continue;
    if (e.useMarketBuy[a] && !cancelTrackedMarketBuyOrders(e, r, a)) t = false;
  }
  return t;
}

function hasPendingMarketBuyCapture(e, r, t) {
  if (!marketBuyer || typeof marketBuyer.getPendingOrders !== "function") return false;
  var a = marketBuyer.getPendingOrders() || [];
  for (var n = 0; n < a.length; n++) {
    var o = a[n];
    if (o && o.room === r && o.resource === t && (!o.opId || o.opId === e.id)) return true;
  }
  return false;
}

function maybeTopUpLabMarketBuy(e, r) {
  if (!e.useMarketBuy) return;
  if (!e.marketBuyToppedUp) e.marketBuyToppedUp = {};
  if (!e.marketBuyTopUpState || typeof e.marketBuyTopUpState !== "object" || Array.isArray(e.marketBuyTopUpState)) e.marketBuyTopUpState = {};
  var t = getLabMarketBuyTopUpGraceTicks();
  var a = {};
  for (var n in e.useMarketBuy) {
    if (e.useMarketBuy.hasOwnProperty(n)) a[n] = true;
  }
  for (var o in e.marketBuyTopUpState) {
    if (e.marketBuyTopUpState.hasOwnProperty(o)) a[o] = true;
  }
  for (var i in a) {
    if (e.marketBuyToppedUp[i]) continue;
    var u = e.marketBuyTopUpState[i];
    if (!u || typeof u !== "object" || Array.isArray(u)) {
      e.marketBuyTopUpState[i] = {
        firstSeenTick: Game.time,
        lastAttemptTick: null
      };
      requestSave();
      continue;
    }
    var l = !e.useMarketBuy[i] && typeof u.retryAfterTick === "number" && Game.time >= u.retryAfterTick;
    if (!e.useMarketBuy[i] && !l) continue;
    if (typeof u.firstSeenTick !== "number") {
      u.firstSeenTick = Game.time;
      u.lastAttemptTick = null;
      requestSave();
      continue;
    }
    var s = l ? null : getManagedBuyRecord(e, r, i);
    if (!l && !s) continue;
    if (!l && (s.done || s.cancelled)) {
      e.marketBuyToppedUp[i] = true;
      continue;
    }
    var c = Game.time;
    var d = Game.time;
    var f = 0;
    var m = 0;
    if (!l) {
      if (!s.orderId) continue;
      var g = Game.market && Game.market.orders ? Game.market.orders[s.orderId] : null;
      if (!g || g.type !== ORDER_BUY || !(util.getOrderRemaining(g) > 0)) continue;
      if (s.pending || s.pendingFill || s.pendingDeal || s.cancelRequested || hasPendingMarketBuyCapture(e, r, i)) continue;
      c = typeof s.created === "number" ? s.created : typeof g.created === "number" ? g.created : null;
      if (c === null) continue;
      d = typeof s.lastProgressTick === "number" ? s.lastProgressTick : c;
      f = Math.max(0, Game.time - c);
      m = Math.max(0, Game.time - d);
      if (f < t || m < t) continue;
    }
    if (typeof u.lastAttemptTick === "number" && Game.time - u.lastAttemptTick < t) continue;
    var p = getInputAvailableForOp(e, r, i);
    var v = s ? marketBuyer.getFulfilled(s) : 0;
    var R = Math.max(p, v);
    var y = Math.max(0, e.batchSize - R);
    if (y <= 0) {
      e.marketBuyToppedUp[i] = true;
      continue;
    }
    var b = pricing.getPriceProfile(i);
    var S = e.marketBuyCeilings && e.marketBuyCeilings[i] || b && b.marketPrice;
    if (!(S > 0)) continue;
    var h = l ? "retrying failed marketBuy top-up" : "stalled marketBuy order " + s.orderId + " created=" + c + ", age=" + f + " ticks, lastProgress=" + d + ", filled=" + v + ", covered=" + R;
    u.lastAttemptTick = Game.time;
    if (!l && !marketBuyer.cancelOrderById(s.orderId, h, e.id)) {
      requestSave();
      console.log("[marketLab] Could not cancel " + h + " before top-up.");
      continue;
    }
    e.useMarketBuy[i] = false;
    var k = createLabOpportunisticBuy(e, r, i, y, S);
    e.marketBuyToppedUp[i] = !!k;
    if (k) delete u.retryAfterTick; else u.retryAfterTick = Game.time + t;
    requestSave();
    console.log("[marketLab] " + r + "/" + e.targetCompound + " " + h + " - cancelled (" + (k ? "opportunistic top-up queued" : "top-up creation failed") + ") for " + y + " " + i + " @ " + S.toFixed(3));
  }
}

function moveToProcessingOrWaiting(e, r) {
  var t = shortTagFor(e.direction);
  pauseActiveBuyingClock(e);
  if (!isRoomProcessing(r) && !labManagerBusy(r)) {
    e.state = STATE_PROCESSING;
    console.log("[marketLab " + t + "] " + r + "/" + e.targetCompound + ": preparing processing.");
  } else {
    e.state = STATE_WAITING;
    console.log("[marketLab " + t + "] " + r + "/" + e.targetCompound + ": labs busy, waiting.");
  }
  requestSave();
}

function runStaging(e, r) {
  if (!e.stageStartTick) e.stageStartTick = Game.time;
  if (!e.stageReservationProgram) {
    e.stageReservationProgram = "marketLabStage_" + e.id;
  }
  if (isStockpileOperation(e)) {
    clearStagingReservations(e, r);
    delete e.stageReservationProgram;
    delete e.stageStartTick;
    clearSellReservations(e, r);
    e.state = STATE_SELLING;
    e.sellingStartTick = Game.time;
    requestSave();
    runSelling(e, r);
    return;
  }
  reserveStagingOutputs(e, r);
  reserveSellOutputs(e, r);
  var t = getExpectedOutputs(e);
  if (!t) {
    e.state = STATE_SELLING;
    e.salvageMode = true;
    e.sellingStartTick = Game.time;
    requestSave();
    runSelling(e, r);
    return;
  }
  var a = true;
  for (var n in t) {
    if (!t.hasOwnProperty(n)) continue;
    var o = getStagingNeed(e, r, n);
    if (o <= 0) continue;
    a = false;
  }
  if (!a) {
    if (Game.time - e.stageStartTick < STAGING_GRACE_TICKS) return;
    var i = Game.rooms[r];
    if (!i || !i.terminal || !i.terminal.store) return;
    for (var u in t) {
      if (!t.hasOwnProperty(u)) continue;
      var l = t[u] || 0;
      if (l <= 0) continue;
      var s = i.terminal.store[u] || 0;
      if (s < l) {
        console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": partial staging " + u + " " + s + "/" + l + " - staging grace elapsed, selling available terminal output.");
        t[u] = s;
      }
    }
    setExpectedOutputs(e, t);
  }
  clearStagingReservations(e, r);
  delete e.stageReservationProgram;
  delete e.stageStartTick;
  e.state = STATE_SELLING;
  e.sellingStartTick = Game.time;
  reserveSellOutputs(e, r);
  requestSave();
  runSelling(e, r);
}

function runWaiting(e, r) {
  phaseJob(e, "staging");
  if (isRoomProcessing(r)) return;
  if (labManagerBusy(r)) return;
  if (checkLabsContaminated(r)) {
    var t = !!(labManager && typeof labManager.getActiveOrder === "function" && labManager.getActiveOrder(r));
    if (!t) {
      if (labManager.queueCleanup(r)) {
        console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": labs contaminated, cleanup queued — staying WAITING.");
      }
    }
    return;
  }
  e.state = STATE_PROCESSING;
  delete e.reactionStarted;
  delete e.labOrderSubmitted;
  requestSave();
  console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": labs free, preparing processing.");
}

function runPending(e, r) {
  if (typeof e.pendingSince !== "number") e.pendingSince = e.tickStarted || Game.time;
  if (Game.time - e.pendingSince > PENDING_TTL_TICKS) {
    e.cancellationPending = true;
    e.cancellationReason = "pending queue TTL";
    requestSave();
    return;
  }
  var t = getRoomState.get(r);
  var a = !!(t && Array.isArray(t.hostiles) && t.hostiles.length > 0);
  var n = roomSuspender && typeof roomSuspender.shouldAvoidRoomWork === "function" && roomSuspender.shouldAvoidRoomWork(r);
  if (!roomHasLabsAndTerminal(r) || a || n) {
    e.cancellationPending = true;
    e.cancellationReason = a || n ? "room became hostile or suspended while pending" : "room lost labs or terminal while pending";
    requestSave();
  }
}

function reverseLabOrderReady(e, r) {
  if (!e || e.direction !== DIR_REVERSE || !labManager || typeof labManager.getMarketOperationOrder !== "function") return false;
  var t = labManager.getMarketOperationOrder(r, e.id);
  if (!t || t.type !== "breakdown" || t.needsPreEvacuation) return false;
  var a = typeof t.remaining === "number" ? t.remaining : t.amount || 0;
  var n = typeof t.compoundDelivered === "number" ? t.compoundDelivered : 0;
  var o = t.amount || e.batchSize || 0;
  if (a > 0 && n < o) return false;
  var i = typeof labManager.getSupplierCarriedAmount === "function" ? labManager.getSupplierCarriedAmount(r, e.targetCompound) : 0;
  return i <= 0;
}

function markReverseLabOrderStarted(e, r) {
  if (!e || e.reactionStarted || !reverseLabOrderReady(e, r)) return false;
  phaseJob(e, "producing");
  e.reactionStarted = true;
  e.reactionStartedTick = Game.time;
  if (e.conversionOnly && labCommodityRouter && typeof labCommodityRouter.markConversionStarted === "function") {
    labCommodityRouter.markConversionStarted(e.id, e.jobId);
  }
  requestSave();
  console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": full breakdown load delivered; processing started.");
  return true;
}

function runProcessing(e, r) {
  var t = !!(labManager && typeof labManager.getActiveOrder === "function" && labManager.getActiveOrder(r));
  if (!e.labOrderSubmitted && !e.reactionStarted) {
    if (e.pipelineId) {
      startPipelineLabOrder(e, r);
      return;
    }
    if (e.direction === DIR_FORWARD) {
      startForwardLabOrder(e, r);
    } else {
      startReverseLabOrder(e, r);
    }
    return;
  }
  if (e.direction === DIR_REVERSE && e.labOrderSubmitted && !e.reactionStarted) {
    markReverseLabOrderStarted(e, r);
    if (!e.reactionStarted && (t || labManagerBusy(r))) return;
  }
  if (t) return;
  if (labManagerBusy(r)) return;
  if (e.pipelineId && labManager && typeof labManager.getPipelineOutcome === "function") {
    var a = labManager.getPipelineOutcome(e.pipelineId);
    if (a && a.status !== "completed") {
      e._failed = true;
      e._failureReason = a.reason || "pipeline " + a.status + " before completion";
      requestSave();
      return;
    }
  }
  var n = Game.time - (e.reactionStartedTick || e.tickStarted);
  if (n < 5) return;
  var o = shortTagFor(e.direction);
  console.log("[marketLab " + o + "] " + r + "/" + e.targetCompound + ": lab order complete, moving to staging.");
  e.state = STATE_STAGING;
  e.stageStartTick = Game.time;
  requestSave();
}

function startPipelineLabOrder(e, r) {
  var t = labReactionPipeline.build(e.pipelineMode, e.targetCompound, e.batchSize);
  if (!t.ok) {
    failLabOrderStart(e, r, "[Labs] " + t.reason);
    return;
  }
  var a;
  try {
    a = labManager.startPipeline(r, t, {
      origin: "marketLab",
      sink: isStockpileOperation(e) ? "storage" : "terminal",
      stockpile: isStockpileOperation(e),
      marketOpId: e.id,
      jobId: e.jobId || null,
      pipelineId: e.pipelineId,
      reservationProgram: "marketLabPipeline_" + e.id
    });
  } catch (t) {
    failLabOrderStart(e, r, "[Labs] " + t.message);
    return;
  }
  if (!a || !a.ok) {
    failLabOrderStart(e, r, a && a.msg ? a.msg : a);
    return;
  }
  e.reactionStarted = true;
  e.reactionStartedTick = Game.time;
  e.pipelineDeadline = a.order && a.order.pipelineDeadline || e.pipelineDeadline;
  e.pipelineLabOrderId = a.order && a.order.pipelineId || e.pipelineId;
  requestSave();
}

function labOrderStarted(e) {
  return typeof e === "string" && (e.indexOf("[Labs] Started") === 0 || e.indexOf("[Labs] Queued") === 0);
}

function retryLabOrderBuying(e, r, t) {
  e.state = STATE_BUYING;
  delete e.reactionStarted;
  delete e.labOrderSubmitted;
  delete e.buyRequestCreated;
  setExpectedOutputs(e, null);
  e.stageReservationProgram = null;
  console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": " + t + "; returning to buying.");
  requestSave();
}

function isTransientLabOrderFailure(e) {
  if (typeof e !== "string") return false;
  var r = e.toLowerCase();
  return r.indexOf("insufficient unreserved") >= 0 || r.indexOf("reserve failed") >= 0 || r.indexOf("reservation failed") >= 0;
}

function failLabOrderStart(e, r, t) {
  var a = "lab order start failed: " + (t || "no result");
  if (isTransientLabOrderFailure(t)) {
    retryLabOrderBuying(e, r, a);
    return;
  }
  e._failed = true;
  e._failureReason = a;
  console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": " + a + ". Op removed from queue.");
  requestSave();
}

function startForwardLabOrder(e, r) {
  phaseJob(e, "producing");
  var t = getInputAvailableForOp(e, r, e.reagents[0]);
  var a = getInputAvailableForOp(e, r, e.reagents[1]);
  if (e.handoffInputResource && !reserveHandoffInput(e, r)) {
    retryLabOrderBuying(e, r, "handoff input is not reserved");
    return;
  }
  if (t < e.batchSize || a < e.batchSize) {
    retryLabOrderBuying(e, r, "reagents no longer fully unreserved");
    return;
  }
  var n = e.batchSize;
  console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": starting reaction for " + n);
  var o = {};
  o[e.targetCompound] = n;
  setExpectedOutputs(e, o);
  e.stageReservationProgram = "marketLabStage_" + e.id;
  var i = releaseBatchReservations(e, "lab forward reservation handoff");
  releaseHandoffInputReservation(e, r);
  var u;
  try {
    u = global.orderLabs(r, e.targetCompound, n, {
      origin: "marketLab",
      sink: isStockpileOperation(e) ? "storage" : "terminal",
      stockpile: isStockpileOperation(e),
      marketOpId: e.id,
      jobId: e.jobId || null,
      direct: true,
      handoff: !!e.handoff,
      handoffReservationProgram: e.handoffReservationProgram || null,
      handoffInputPrograms: e.handoffInputPrograms || null
    });
  } catch (r) {
    if (i) restoreBatchReservations(e);
    throw r;
  }
  if (!labOrderStarted(u)) {
    if (i && isTransientLabOrderFailure(u)) {
      restoreBatchReservations(e);
    }
    failLabOrderStart(e, r, u);
    return;
  }
  e.reactionStarted = true;
  e.reactionStartedTick = Game.time;
  if (e.conversionOnly && labCommodityRouter && typeof labCommodityRouter.markConversionStarted === "function") {
    labCommodityRouter.markConversionStarted(e.id, e.jobId);
  }
  requestSave();
}

function startReverseLabOrder(e, r) {
  var t = getInputAvailableForOp(e, r, e.targetCompound);
  if (e.handoffInputResource && !reserveHandoffInput(e, r)) {
    retryLabOrderBuying(e, r, "handoff input is not reserved");
    return;
  }
  if (t < e.batchSize) {
    retryLabOrderBuying(e, r, "compound no longer fully unreserved");
    return;
  }
  t = e.batchSize;
  console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": queuing breakdown for " + t + " (awaiting full lab delivery).");
  var a = {};
  a[e.reagents[0]] = t;
  a[e.reagents[1]] = t;
  setExpectedOutputs(e, a);
  e.stageReservationProgram = "marketLabStage_" + e.id;
  var n = releaseBatchReservations(e, "lab reverse reservation handoff");
  releaseHandoffInputReservation(e, r);
  var o;
  try {
    o = global.breakdownLabs(r, e.targetCompound, t, {
      origin: "marketLab",
      sink: isStockpileOperation(e) ? "storage" : "terminal",
      stockpile: isStockpileOperation(e),
      marketOpId: e.id,
      jobId: e.jobId || null
    });
  } catch (r) {
    if (n) restoreBatchReservations(e);
    throw r;
  }
  if (!labOrderStarted(o)) {
    if (n && isTransientLabOrderFailure(o)) {
      restoreBatchReservations(e);
    }
    failLabOrderStart(e, r, o);
    return;
  }
  e.labOrderSubmitted = true;
  requestSave();
}

function trackedSellOrdersStillLive(e, r) {
  if (!e || !Array.isArray(e.sellRequestInfo) || e.sellRequestInfo.length === 0) return false;
  if (!Game.market || !Game.market.orders) return false;
  var t = 0;
  for (var a = 0; a < e.sellRequestInfo.length; a++) {
    var n = e.sellRequestInfo[a];
    if (!n || n.unavailable || (n.amount || 0) <= 0) continue;
    if (!n.orderId) return false;
    if (!isTrackedSellPending(e, n, r)) return false;
    t++;
  }
  return t > 0;
}

function runSelling(e, r) {
  phaseJob(e, "selling");
  if (!e.sellingStartTick) e.sellingStartTick = Game.time;
  if (isStockpileOperation(e)) {
    if (!e.marketBuysCancelled) {
      if (!cancelAllTrackedMarketBuyOrders(e, r)) return;
      e.marketBuysCancelled = true;
    }
    clearSellReservations(e, r);
    if (isOperationDrained(e, r)) {
      e._completed = true;
      console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": stockpile output delivered.");
      requestSave();
    }
    return;
  }
  recoverLegacySellRequestIds(e, r);
  if (!e.marketBuysCancelled) {
    if (!cancelAllTrackedMarketBuyOrders(e, r)) return;
    e.marketBuysCancelled = true;
    requestSave();
  }
  if (!e.sellOrderCreated) {
    if (e._sellRetryTick && Game.time < e._sellRetryTick) return;
    if (e._sellRetryTick) delete e._sellRetryTick;
    if (!isOutputEvacuated(e, r) && Game.time - e.sellingStartTick < SELLING_GRACE_TICKS) {
      reserveSellOutputs(e, r);
      return;
    }
    reserveSellOutputs(e, r);
    e.sellRequestInfo = [];
    e._sellNoPriceSeen = false;
    if (e.direction === DIR_FORWARD) {
      placeForwardSellOrders(e, r);
    } else {
      placeReverseSellOrders(e, r);
    }
    if (e.origin === "marketLab") {
      var t = getExpectedOutputs(e) || {};
      var a = 0;
      for (var n in t) {
        if (!t.hasOwnProperty(n)) continue;
        if (e.handoff && n === e.handoffResource) continue;
        if ((t[n] || 0) > 0) a++;
      }
      var o = 0;
      var i = 0;
      var u = false;
      if (Array.isArray(e.sellRequestInfo)) {
        for (var l = 0; l < e.sellRequestInfo.length; l++) {
          var s = e.sellRequestInfo[l];
          if (!s) continue;
          if (s.unavailable) {
            o++;
            i++;
            continue;
          }
          if ((s.amount || 0) <= 0) {
            o++;
            continue;
          }
          if (s.orderId) {
            o++;
            continue;
          }
          if (getActiveMarketSellRequestForJob(r, s.resource, s.amount, e.jobId)) {
            o++;
            continue;
          }
          if (findLiveOwnedSellOrderForJob(r, s.resource, s.amount, e.jobId)) {
            o++;
            continue;
          }
        }
      }
      if (o < a) {
        for (var c in t) {
          if (!t.hasOwnProperty(c)) continue;
          if ((t[c] || 0) <= 0) continue;
          var d = false;
          for (var f = 0; f < e.sellRequestInfo.length; f++) {
            if (e.sellRequestInfo[f] && e.sellRequestInfo[f].resource === c) {
              d = true;
              break;
            }
          }
          if (!d && countInRoom(r, c) <= 0) {
            if (e.conversionOnly) u = true; else o++;
          }
        }
      }
      if (o < a) {
        u = true;
      }
      if (i > 0) {
        var m = [];
        if (Array.isArray(e.sellRequestInfo)) {
          for (var g = 0; g < e.sellRequestInfo.length; g++) {
            var p = e.sellRequestInfo[g];
            if (p && p.unavailable) {
              m.push(p.resource + " [" + describeSellBlockers(r, p.resource, e.sellReservationProgram || null) + "]");
            }
          }
        }
        e._sellBlocked = true;
        var v = m.join(", ");
        if (failSellingSetupIfTimedOut(e, r, v)) return;
        if (!e._lastUnavailableLog || Game.time - e._lastUnavailableLog >= 50) {
          console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + " [" + (e.id || "unknown") + "]" + ": sell deferred — " + i + " resource(s) reserved by other program: " + v + ". Will retry.");
          e._lastUnavailableLog = Game.time;
          requestSave();
        }
        return;
      }
      if (u) {
        var R = e._lastSellResult || "no marketSell result captured";
        e._sellBlocked = true;
        if (failSellingSetupIfTimedOut(e, r, R)) return;
        var y = isNoCanonicalSellPrice(R);
        var b = e._lastSellNoPriceLog || 0;
        var S = !y || !b || Game.time - b >= SELLING_NO_PRICE_LOG_INTERVAL;
        if (S) {
          console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": sell order setup incomplete, will retry. last result: " + R);
          if (y) e._lastSellNoPriceLog = Game.time;
          requestSave();
        }
        return;
      }
      e._sellBlocked = false;
    }
    e.sellOrderCreated = true;
    delete e._sellRetryTick;
    delete e._lastSellNoPriceLog;
    clearSellReservations(e, r);
    requestSave();
    return;
  }
  if (trackedSellOrdersStillLive(e, r)) return;
  if (isOperationDrained(e, r)) {
    if (e.partialSurplusPending && Object.keys(e.partialSurplusPending).length > 0) return;
    console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + (e.salvageMode ? ": salvage complete." : ": complete."));
    e._completed = true;
    requestSave();
    return;
  }
  if (e.origin === "marketLab" && Array.isArray(e.sellRequestInfo) && e.sellRequestInfo.length > 0 && hasStockWithoutLiveOrder(e, r)) {
    var h = Game.time - (e.sellingStartTick || Game.time);
    if (h >= SELLING_REARM_GRACE_TICKS) {
      console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": all sell orders inactive but terminal still holds expected output. Rearming sell setup (age " + h + " ticks).");
      delete e.sellOrderCreated;
      e.sellRequestInfo = [];
      requestSave();
    }
  }
}

function hasStockWithoutLiveOrder(e, r) {
  if (!Array.isArray(e.sellRequestInfo) || e.sellRequestInfo.length === 0) return false;
  for (var t = 0; t < e.sellRequestInfo.length; t++) {
    var a = e.sellRequestInfo[t];
    if (!a) continue;
    if (isTrackedSellPending(e, a, r)) return false;
    if (getTrackedAllocationRemaining(e, a, r) <= 0) return false;
  }
  return true;
}

function makeSellTrackingEntry(e, r, t, a, n, o) {
  var i = n && Game.market && Game.market.orders ? Game.market.orders[n] : null;
  return {
    resource: r,
    amount: t,
    created: a,
    orderId: n || null,
    orderStartRemaining: i ? util.getOrderRemaining(i) : null,
    unavailable: !!o,
    stockBaseline: Math.max(0, countInRoom(e, r) - t)
  };
}

function getJobSoldAmount(e, r) {
  if (!e || !e.jobId) return 0;
  try {
    var t = require("marketEconomics").get(e.jobId);
    var a = t && t.output && t.output[r];
    return a && a.sold ? a.sold : 0;
  } catch (e) {}
  return 0;
}

function isTrackedSellPending(e, r, t) {
  if (!r || r.unavailable || (r.amount || 0) <= 0) return false;
  if (e && e.jobId) {
    if (getJobSoldAmount(e, r.resource) >= r.amount) return false;
    if (r.orderId) return getSellLotRemainingForJob(r.orderId, e.jobId) > 0;
    return !!getActiveMarketSellRequestForJob(t, r.resource, r.amount, e.jobId);
  }
  var a = r.orderId && Game.market && Game.market.orders ? Game.market.orders[r.orderId] : null;
  if (a && util.getOrderRemaining(a) > 0) {
    if (typeof r.orderStartRemaining === "number" && r.orderStartRemaining - util.getOrderRemaining(a) >= r.amount) return false;
    return true;
  }
  return isMarketSellRequestActive(t, r.resource, r.amount, r.created);
}

function getTrackedAllocationRemaining(e, r, t) {
  if (!r || (r.amount || 0) <= 0) return 0;
  if (e && e.jobId) {
    if (getJobSoldAmount(e, r.resource) >= r.amount) return 0;
    if (r.orderId && getSellLotRemainingForJob(r.orderId, e.jobId) > 0) return 0;
  }
  if (typeof r.stockBaseline !== "number") return countInRoom(t, r.resource);
  return Math.min(r.amount, Math.max(0, countInRoom(t, r.resource) - r.stockBaseline));
}

function recordHandoffSellEntry(e, r, t, a, n) {
  var o = e.jobId || null;
  var i = getActiveMarketSellRequestForJob(r, t, n, o);
  var u = i && i.orderId;
  if (!u) u = findLiveOwnedSellOrderForJob(r, t, n, o);
  if (!e.sellRequestInfo) e.sellRequestInfo = [];
  e.sellRequestInfo.push(makeSellTrackingEntry(r, t, a, i && i.created || Game.time, u || null, false));
  handoffSellReservationForResource(e, r, t);
}

function tryExistingMarketSellHandoff(e, r, t, a, n) {
  if (!(a > 0)) return {
    attempted: false,
    accepted: false,
    result: null
  };
  var o = marketSeller.getActiveOwnedSellOrders(r, t);
  if (o.length === 0) {
    var i = getReservationBlockers(r, t, e.sellReservationProgram || null);
    var u = false;
    for (var l = 0; l < i.length; l++) {
      if (i[l].program === "marketSell") {
        u = true;
        break;
      }
    }
    if (u) {
      marketSeller.cleanup();
      marketSeller.syncReservations();
      o = marketSeller.getActiveOwnedSellOrders(r, t);
    }
  }
  if (o.length === 0) return {
    attempted: false,
    accepted: false,
    result: null
  };
  var s = {
    allowExistingCoverage: true
  };
  if (e.jobId) s.jobId = e.jobId;
  var c = marketSeller.marketSell(r, t, a, undefined, s);
  invalidateOwnedSellOrderCache();
  recordSellAttemptResult(e, c);
  if (!marketSellAccepted(c)) {
    return {
      attempted: true,
      accepted: false,
      result: c
    };
  }
  recordHandoffSellEntry(e, r, t, n, a);
  e._sellBlocked = false;
  requestSave();
  return {
    attempted: true,
    accepted: true,
    result: c
  };
}

function failSellingSetupIfTimedOut(e, r, t) {
  var a = e.sellingStartTick || e.tickStarted || Game.time;
  var n = Math.max(0, Game.time - a);
  if (n < SELLING_SETUP_TIMEOUT_TICKS) return false;
  e._failed = true;
  e._failureReason = "sell setup blocked for " + n + " ticks: " + t;
  console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": selling setup timed out after " + n + " ticks; failing operation. " + t);
  requestSave();
  return true;
}

function placeForwardSellOrders(e, r) {
  if (e.handoff && e.handoffResource === e.targetCompound) return;
  var t = getExpectedOutputs(e);
  var a = t && t[e.targetCompound] ? t[e.targetCompound] : countInRoom(r, e.targetCompound);
  var n = e.sellReservationProgram || null;
  var o = e.jobId || null;
  if (a > 0 && labCommodityPolicy.isTwoLetterLabProduct(e.targetCompound)) {
    routeRestrictedOutput(e, r, e.targetCompound, a, "marketLab forward output");
    return;
  }
  if (a > 0) {
    var i = Math.min(a, MAX_BATCH_SIZE);
    var u = getSellTrackingTarget(e, e.targetCompound, i);
    var l = Math.min(i, Math.max(0, getJobSoldAmount(e, e.targetCompound)));
    var s = getMarketSellCoveredAmountForJob(r, e.targetCompound, o);
    var c = l + s;
    if (c >= i) {
      var d = Math.max(0, i - l);
      if (d <= 0) {
        if (!e.sellRequestInfo) e.sellRequestInfo = [];
        e.sellRequestInfo.push(makeSellTrackingEntry(r, e.targetCompound, 0, Game.time, null, false));
        return;
      }
      var f = getActiveMarketSellRequestForJob(r, e.targetCompound, d, o);
      var m = f && f.orderId;
      if (!m) m = findLiveOwnedSellOrderForJob(r, e.targetCompound, d, o);
      if (f || m) {
        e.sellRequestInfo = [ makeSellTrackingEntry(r, e.targetCompound, u, f && f.created || Game.time, m || null, false) ];
        handoffSellReservationForResource(e, r, e.targetCompound);
        if (shouldLogSellCovered(e, e.targetCompound)) {
          console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": sell " + i + " already covered by existing marketSell request(s).");
        }
        return;
      }
    }
    var g = getAvailableForLabSell(r, e.targetCompound, n);
    var p = s;
    var v = Math.max(0, i - l);
    var R = Math.max(0, g + p);
    if (p < v && R < v) {
      var y = tryExistingMarketSellHandoff(e, r, e.targetCompound, v - p, u);
      if (y.accepted) return;
      g = getAvailableForLabSell(r, e.targetCompound, n);
      p = getMarketSellCoveredAmountForJob(r, e.targetCompound, o);
      R = Math.max(0, g + p);
    }
    if (R < v) {
      if (!e.sellRequestInfo) e.sellRequestInfo = [];
      var b = countInRoom(r, e.targetCompound);
      if (b <= 0) {
        e.sellRequestInfo.push(makeSellTrackingEntry(r, e.targetCompound, 0, Game.time, null, false));
        console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": sell " + a + " skipped, no stock remaining.");
      } else {
        e._sellBlocked = true;
        e.sellRequestInfo.push(makeSellTrackingEntry(r, e.targetCompound, 0, Game.time, null, true));
        console.log("[marketLab fwd] " + r + "/" + e.targetCompound + " [" + (e.id || "unknown") + "]" + ": sell " + a + " deferred, sold " + l + ", only " + R + " available for remaining " + v + ". Blockers: " + describeSellBlockers(r, e.targetCompound, n));
      }
      return;
    }
    e._sellBlocked = false;
    if (p >= v) {
      var S = getActiveMarketSellRequestForJob(r, e.targetCompound, v, o);
      var h = S && S.orderId || findLiveOwnedSellOrderForJob(r, e.targetCompound, v, o);
      if (S || h) {
        e.sellRequestInfo = [ makeSellTrackingEntry(r, e.targetCompound, u, S && S.created || Game.time, h || null, false) ];
      }
      handoffSellReservationForResource(e, r, e.targetCompound);
      if (shouldLogSellCovered(e, e.targetCompound)) {
        console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": sell " + i + " already covered by existing marketSell request(s).");
      }
      return;
    }
    var k = v - p;
    console.log("[marketLab fwd] " + r + "/" + e.targetCompound + " [" + (e.id || "unknown") + "]" + ": sell order " + k + " (target " + i + ", sold " + l + ", covered " + (l + p) + ", expected " + a + ")");
    var I = getActiveMarketSellRequestForJob(r, e.targetCompound, k, o);
    if (I) {
      if (!e.sellRequestInfo) e.sellRequestInfo = [];
      e.sellRequestInfo.push(makeSellTrackingEntry(r, e.targetCompound, u, I.created || Game.time, I.orderId || null, false));
      handoffSellReservationForResource(e, r, e.targetCompound);
    } else {
      releaseSellReservationForResource(e, r, e.targetCompound);
      var O = {
        allowExistingCoverage: true
      };
      if (e.jobId) O.jobId = e.jobId;
      var T = global.marketSell(r, e.targetCompound, k, undefined, O);
      invalidateOwnedSellOrderCache();
      requestSave();
      recordSellAttemptResult(e, T);
      if (marketSellAccepted(T)) {
        recordHandoffSellEntry(e, r, e.targetCompound, u, k);
      } else {
        reserveSellOutputResource(e, r, e.targetCompound);
      }
    }
  }
  if (e.salvageMode && !isStockpileOperation(e) && e.origin !== "marketLab") {
    for (var A = 0; A < e.reagents.length; A++) {
      var B = e.reagents[A];
      if (isResourceReservedByOtherOp(r, B, e)) continue;
      var C = countInRoom(r, B);
      if (C <= 0) continue;
      var _ = Math.min(C, MAX_BATCH_SIZE);
      if (labCommodityPolicy.isTwoLetterLabProduct(B)) {
        labCommodityRouter.enqueue(r, B, _, "marketLab forward salvage", e.id, e.jobId);
        continue;
      }
      console.log("[marketLab fwd] " + r + "/" + e.targetCompound + ": salvage — sell " + _ + " surplus " + B);
      global.marketSell(r, B, _);
      invalidateOwnedSellOrderCache();
      requestSave();
    }
  }
}

function placeReverseSellOrders(e, r) {
  var t = getExpectedOutputs(e);
  var a = e.sellReservationProgram || null;
  var n = e.jobId || null;
  var o = operationOutputResources(e);
  marketSeller.beginReservationBatch();
  try {
    for (var i = 0; i < o.length; i++) {
      var u = o[i];
      if (e.handoff && u === e.handoffResource) continue;
      if (e.origin !== "marketLab" && isResourceReservedByOtherOp(r, u, e)) continue;
      var l = t && t[u] ? t[u] : countInRoom(r, u);
      if (l <= 0) continue;
      if (labCommodityPolicy.isTwoLetterLabProduct(u)) {
        routeRestrictedOutput(e, r, u, l, "marketLab reverse output");
        continue;
      }
      var s = Math.min(l, MAX_BATCH_SIZE);
      var c = getSellTrackingTarget(e, u, s);
      var d = Math.min(s, Math.max(0, getJobSoldAmount(e, u)));
      var f = getMarketSellCoveredAmountForJob(r, u, n);
      var m = d + f;
      if (m >= s) {
        var g = Math.max(0, s - d);
        if (g <= 0) {
          if (!e.sellRequestInfo) e.sellRequestInfo = [];
          e.sellRequestInfo.push(makeSellTrackingEntry(r, u, 0, Game.time, null, false));
          continue;
        }
        var p = getActiveMarketSellRequestForJob(r, u, g, n);
        var v = p && p.orderId || findLiveOwnedSellOrderForJob(r, u, g, n) || null;
        if (!e.sellRequestInfo) e.sellRequestInfo = [];
        e.sellRequestInfo.push(makeSellTrackingEntry(r, u, c, p && p.created || Game.time, v, false));
        handoffSellReservationForResource(e, r, u);
        if (shouldLogSellCovered(e, u)) {
          console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": sell " + s + " " + u + " already covered by existing marketSell request(s).");
        }
        continue;
      }
      var R = getAvailableForLabSell(r, u, a);
      var y = Math.max(0, s - d);
      var b = Math.max(0, R + f);
      if (f < y && b < y) {
        var S = tryExistingMarketSellHandoff(e, r, u, y - f, c);
        if (S.accepted) continue;
        R = getAvailableForLabSell(r, u, a);
        f = getMarketSellCoveredAmountForJob(r, u, n);
        b = Math.max(0, R + f);
      }
      if (b < y) {
        if (!e.sellRequestInfo) e.sellRequestInfo = [];
        var h = countInRoom(r, u);
        if (h <= 0) {
          e.sellRequestInfo.push(makeSellTrackingEntry(r, u, 0, Game.time, null, false));
          if (!e._missingSellOutputs) e._missingSellOutputs = {};
          if (!e._missingSellOutputs[u]) {
            e._missingSellOutputs[u] = true;
            console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": sell " + l + " " + u + " skipped, no stock remaining.");
            requestSave();
          }
        } else {
          e._sellBlocked = true;
          e.sellRequestInfo.push(makeSellTrackingEntry(r, u, 0, Game.time, null, true));
          if (!e._unavailableSellOutputs) e._unavailableSellOutputs = {};
          var k = e._unavailableSellOutputs[u] || 0;
          if (Game.time - k >= 50) {
            e._unavailableSellOutputs[u] = Game.time;
            console.log("[marketLab rev] " + r + "/" + e.targetCompound + " [" + (e.id || "unknown") + "]" + ": sell " + l + " " + u + " deferred, sold " + d + ", only " + b + " available for remaining " + y + ". Blockers: " + describeSellBlockers(r, u, a));
            requestSave();
          }
        }
        continue;
      }
      e._sellBlocked = false;
      if (f >= y) {
        var I = getActiveMarketSellRequestForJob(r, u, y, n);
        var O = I && I.orderId || findLiveOwnedSellOrderForJob(r, u, y, n) || null;
        if (!e.sellRequestInfo) e.sellRequestInfo = [];
        if (I || O) {
          e.sellRequestInfo.push(makeSellTrackingEntry(r, u, c, I && I.created || Game.time, O, false));
        }
        handoffSellReservationForResource(e, r, u);
        if (shouldLogSellCovered(e, u)) {
          console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": sell " + s + " " + u + " already covered by existing marketSell request(s).");
        }
        continue;
      }
      var T = y - f;
      console.log("[marketLab rev] " + r + "/" + e.targetCompound + " [" + (e.id || "unknown") + "]" + ": sell " + T + " " + u + " (target " + s + ", sold " + d + ", covered " + (d + f) + ", expected " + l + ")");
      var A = getActiveMarketSellRequestForJob(r, u, T, n);
      if (A) {
        if (!e.sellRequestInfo) e.sellRequestInfo = [];
        e.sellRequestInfo.push(makeSellTrackingEntry(r, u, c, A.created || Game.time, A.orderId || null, false));
        handoffSellReservationForResource(e, r, u);
      } else {
        releaseSellReservationForResource(e, r, u);
        var B = {
          allowExistingCoverage: true
        };
        if (e.jobId) B.jobId = e.jobId;
        var C = global.marketSell(r, u, T, undefined, B);
        invalidateOwnedSellOrderCache();
        requestSave();
        recordSellAttemptResult(e, C);
        if (marketSellAccepted(C)) {
          recordHandoffSellEntry(e, r, u, c, T);
        } else {
          reserveSellOutputResource(e, r, u);
        }
      }
    }
    if (e.salvageMode && !isStockpileOperation(e) && e.origin !== "marketLab") {
      var _ = countInRoom(r, e.targetCompound);
      if (_ > 0 && !isResourceReservedByOtherOp(r, e.targetCompound, e)) {
        var M = Math.min(_, MAX_BATCH_SIZE);
        if (labCommodityPolicy.isTwoLetterLabProduct(e.targetCompound)) {
          labCommodityRouter.enqueue(r, e.targetCompound, M, "marketLab reverse salvage");
          return;
        }
        console.log("[marketLab rev] " + r + "/" + e.targetCompound + ": salvage — sell " + M + " unbroken " + e.targetCompound);
        global.marketSell(r, e.targetCompound, M);
        invalidateOwnedSellOrderCache();
        requestSave();
      }
    }
  } finally {
    marketSeller.endReservationBatch();
  }
}

function isOperationDrained(e, r) {
  if (isStockpileOperation(e)) {
    var expected = getExpectedOutputs(e);
    var room = Game.rooms[r];
    if (!expected || !room) return false;
    for (var resource in expected) {
      if (!expected.hasOwnProperty(resource)) continue;
      var storageAmount = room.storage && room.storage.store ? room.storage.store[resource] || 0 : 0;
      var terminalAmount = room.terminal && room.terminal.store ? room.terminal.store[resource] || 0 : 0;
      if (storageAmount + terminalAmount < (expected[resource] || 0)) return false;
    }
    return true;
  }
  if (e && e.origin === "marketLab" && e.id && labCommodityRouter && typeof labCommodityRouter.hasPendingSource === "function" && labCommodityRouter.hasPendingSource(e.id)) return false;
  if (e.origin === "marketLab" && getExpectedOutputs(e) && (!Array.isArray(e.sellRequestInfo) || e.sellRequestInfo.length === 0)) return true;
  if (e.origin === "marketLab" && Array.isArray(e.sellRequestInfo) && e.sellRequestInfo.length > 0) {
    for (var t = 0; t < e.sellRequestInfo.length; t++) {
      var a = e.sellRequestInfo[t];
      if (!a) continue;
      if (e.jobId && (a.amount || 0) > 0) {
        if (getJobSoldAmount(e, a.resource) < a.amount) return false;
        continue;
      }
      if (isTrackedSellPending(e, a, r)) return false;
      if (getTrackedAllocationRemaining(e, a, r) > 0) return false;
    }
    return true;
  }
  var n = e.direction === DIR_FORWARD ? [ e.targetCompound ] : e.reagents.slice();
  for (var o = 0; o < n.length; o++) {
    if (countInRoom(r, n[o]) > 0) return false;
  }
  if (e.salvageMode) {
    var i = e.direction === DIR_FORWARD ? e.reagents : [ e.targetCompound ];
    for (var u = 0; u < i.length; u++) {
      var l = i[u];
      if (isResourceReservedByOtherOp(r, l, e)) continue;
      if (countInRoom(r, l) > 0) return false;
    }
  }
  return true;
}

function getOperationRunInterval(e) {
  if (!e || !e.state) return 1;
  if (e.state === STATE_PENDING) return 1;
  if (e.state === STATE_BUYING) return e.buyRequestCreated ? BUYING_POLL_INTERVAL : 1;
  if (e.state === STATE_WAITING) return WAITING_RUN_INTERVAL;
  if (e.state === STATE_PROCESSING) return e.reactionStarted ? PROCESSING_RUN_INTERVAL : 1;
  if (e.state === STATE_STAGING) return STAGING_RUN_INTERVAL;
  if (e.state === STATE_SELLING) {
    if (e.sellOrderCreated) return SELLING_DRAIN_INTERVAL;
    if (e._sellRetryTick && Game.time < e._sellRetryTick) {
      return Math.max(SELLING_SETUP_INTERVAL, SELLING_NO_PRICE_RETRY_INTERVAL);
    }
    if (e._sellBlocked) return Math.max(SELLING_SETUP_INTERVAL, 25);
    return SELLING_SETUP_INTERVAL;
  }
  return 1;
}

function shouldSkipOperationThisTick(e) {
  if (!e) return true;
  if (!e.state) return false;
  var r = operationRunCache[e.id];
  if (!r || r.state !== e.state) return false;
  var t = getOperationRunInterval(e);
  if (t <= 1) return false;
  return Game.time - r.tick < t;
}

function runOperation(e, r) {
  if (e._failed || e._completed) return false;
  if (shouldSkipOperationThisTick(e)) return false;
  operationRunCache[e.id] = {
    tick: Game.time,
    state: e.state
  };
  operationInputCache = {
    op: e,
    roomName: r,
    values: {}
  };
  try {
    if (!e.batchSize) {
      var t = calculateBatchSize(r);
      e.batchSize = t.batchSize;
      e.outputLabCount = t.outputLabCount;
      requestSave();
    }
    if (!e.direction) {
      e.direction = DIR_FORWARD;
      requestSave();
    }
    if (!isStockpileOperation(e) && e.state !== STATE_PENDING) retryPartialSurplusSales(e, r);
    switch (e.state) {
     case STATE_PENDING:
      runPending(e, r);
      break;
     case STATE_BUYING:
      runBuying(e, r);
      break;
     case STATE_WAITING:
      runWaiting(e, r);
      break;
     case STATE_PROCESSING:
      runProcessing(e, r);
      break;
     case STATE_STAGING:
      runStaging(e, r);
      break;
     case STATE_SELLING:
      runSelling(e, r);
      break;
     default:
      console.log("[marketLab] " + r + "/" + e.targetCompound + ": unknown state " + e.state + ", resetting to SELLING");
      e.state = STATE_SELLING;
      e.salvageMode = true;
      requestSave();
      break;
    }
    return true;
  } finally {
    operationInputCache = null;
  }
}

function retryPartialSurplusSales(e, r) {
  if (isStockpileOperation(e)) return;
  if (!e || !e.partialSurplusPending) return;
  var t = [];
  marketSeller.beginReservationBatch();
  try {
    for (var a in e.partialSurplusPending) {
      var n = e.partialSurplusPending[a] || 0;
      if (!(n > 0)) {
        delete e.partialSurplusPending[a];
        continue;
      }
      if (labCommodityPolicy.isTwoLetterLabProduct(a)) {
        labCommodityRouter.enqueue(r, a, n, "marketLab pending partial surplus", e.id, e.jobId);
        delete e.partialSurplusPending[a];
        continue;
      }
      var o = marketSeller.marketSell(r, a, n, undefined, e.jobId ? {
        jobId: e.jobId
      } : null);
      if (!marketSellAccepted(o)) continue;
      t.push(n + " " + a);
      delete e.partialSurplusPending[a];
    }
  } finally {
    marketSeller.endReservationBatch();
  }
  if (Object.keys(e.partialSurplusPending).length === 0) delete e.partialSurplusPending;
  if (t.length > 0) {
    console.log("[marketLab " + shortTagFor(e.direction) + "] " + r + "/" + e.targetCompound + ": listed pending partial surplus: " + t.join(", ") + ".");
    requestSave();
  }
}

function collectDirectionWork(e) {
  var r = ensureMemory(e);
  var t = [];
  var a = shortTagFor(e);
  for (var n in r.rooms) {
    var o = r.rooms[n];
    if (!o || o.length === 0) {
      delete r.rooms[n];
      continue;
    }
    var i = roomHasLabsAndTerminal(n);
    if (!i) {
      console.log("[marketLab " + a + "] room " + n + " lost critical structures, finalizing queue.");
    }
    for (var u = o.length - 1; u >= 0; u--) {
      if (o[u]) t.push({
        roomName: n,
        op: o[u],
        roomValid: i
      });
    }
  }
  return {
    mem: r,
    work: t
  };
}

function processOperationTransaction(e, r, t) {
  var a = t.roomName;
  var n = t.op;
  var o = r.rooms[a];
  if (!o || !n) return false;
  var i = o.indexOf(n);
  if (i < 0) return false;
  var u = shortTagFor(e);
  if (!t.roomValid) {
    if (!n.direction) n.direction = e;
    if (finalizeOperation(n, a, "failed", "room lost terminal or required labs") !== false) {
      o.splice(i, 1);
      forgetOperation(n);
    }
    if (o.length === 0) delete r.rooms[a];
    requestSave();
    return true;
  }
  var roomState = getRoomState.get(a);
  var roomBlocked = roomState && Array.isArray(roomState.hostiles) && roomState.hostiles.length > 0 || roomSuspender && typeof roomSuspender.shouldAvoidRoomWork === "function" && roomSuspender.shouldAvoidRoomWork(a);
  if (roomBlocked && n.state === STATE_PENDING) {
    var pendingCancelReason = "room became hostile or suspended while pending";
    var pendingCancel = finalizeOperation(n, a, "cancelled", pendingCancelReason);
    if (pendingCancel !== false) {
      o.splice(i, 1);
      forgetOperation(n);
      requestSave();
    }
    if (o.length === 0) delete r.rooms[a];
    return true;
  }
  if (roomBlocked) {
    n.lastBlockedReason = "room work suspended or hostile";
    return true;
  }
  if (n.handoff && n.state === STATE_SELLING) {
    if (handoffReady(n, a)) {
      n.handoffReady = true;
      n._completed = true;
      requestSave();
    } else {
      n._sellBlocked = true;
      return true;
    }
  }
  if (n.replacementPending || n.cancellationPending) {
    var l = n.replacementPending ? n.replacementReason || "replaced by scheduler" : n.cancellationReason || "cancellation requested";
    var s = finalizeOperation(n, a, "cancelled", l);
    if (s !== false) {
      o.splice(i, 1);
      forgetOperation(n);
      console.log("[marketLab " + u + "] " + a + "/" + n.targetCompound + ": " + (n.replacementPending ? "replacement" : "cancellation") + " cleanup complete; room slot released.");
      requestSave();
    }
    if (o.length === 0) delete r.rooms[a];
    return true;
  }
  if (n.state === STATE_SELLING) {
    recoverLegacySellRequestIds(n, a);
    if (staleSellingWithoutLot(n)) {
      var c = "selling state exceeded " + STALE_SELLING_TICKS + " ticks without an economics-owned sell lot";
      var d = finalizeOperation(n, a, "failed", c);
      if (d !== false) {
        o.splice(i, 1);
        forgetOperation(n);
        var f = Game.time - (n.sellingStartTick || n.tickStarted || Game.time);
        if (o.length === 0) delete r.rooms[a];
        console.log("[marketLab " + u + "] " + a + "/" + n.targetCompound + ": stale selling operation quarantined; op=" + (n.id || "unknown") + " jobId=" + (n.jobId || "none") + " removed=true finalized=" + (d !== false) + " after " + f + " ticks.");
        memoryManager.requestImmediateSave("marketLab.staleSellingQuarantine");
      }
      return true;
    }
  }
  var m = runOperation(n, a);
  if (n.cancellationPending) {
    var pendingReason = n.cancellationReason || "cancellation requested";
    var pendingResult = finalizeOperation(n, a, "cancelled", pendingReason);
    if (pendingResult !== false) {
      o.splice(i, 1);
      forgetOperation(n);
      requestSave();
    }
    m = true;
  } else if (n._completed || n._failed) {
    var g = finalizeOperation(n, a, n._completed ? "completed" : "failed", n._completed ? n.salvageMode ? "salvage" : "drained" : n._failureReason);
    if (g !== false) {
      o.splice(i, 1);
      forgetOperation(n);
      requestSave();
    }
    m = true;
  }
  if (o.length === 0) delete r.rooms[a];
  return m;
}

function processDirection(e, r) {
  var t = getSchedulerState();
  var a = collectDirectionWork(e);
  var n = a.work;
  if (n.length === 0) {
    delete t.nextOperation[e];
    return {
      processed: 0,
      visited: 0,
      yielded: false
    };
  }
  var o = 0;
  var i = t.nextOperation[e];
  if (i) {
    for (var u = 0; u < n.length; u++) {
      if (n[u].op.id === i) {
        o = u;
        break;
      }
    }
  }
  var l = 0;
  var s = 0;
  for (var c = 0; c < n.length; c++) {
    var d = (o + c) % n.length;
    var f = n[d];
    var m = n[(d + 1) % n.length];
    t.nextOperation[e] = m && m.op ? m.op.id : null;
    s++;
    if (processOperationTransaction(e, a.mem, f)) l++;
    if (typeof r === "number" && Game.cpu.getUsed() >= r && s < n.length) {
      return {
        processed: l,
        visited: s,
        yielded: true
      };
    }
  }
  return {
    processed: l,
    visited: s,
    yielded: false
  };
}

function trimLegacyQueues() {
  if (queueTrimTick >= 0 && Game.time - queueTrimTick < QUEUE_TRIM_INTERVAL) return;
  queueTrimTick = Game.time;
  var e = ensureMemory(DIR_FORWARD).rooms;
  var r = ensureMemory(DIR_REVERSE).rooms;
  var t = {};
  for (var a in e) t[a] = true;
  for (var n in r) t[n] = true;
  for (var o in t) {
    var i = [];
    var u = [ e[o] || [], r[o] || [] ];
    for (var l = 0; l < u.length; l++) {
      for (var s = 0; s < u[l].length; s++) {
        var c = u[l][s];
        if (c && c._failed && c._failureReason === "combined room queue limit" && !c._legacyQueueTrim) {
          c._legacyQueueTrim = true;
          requestSave();
        }
        if (operationConsumesRoomSlot(c)) i.push(c);
      }
    }
    if (i.length <= MAX_ACTIVE_OPS_PER_ROOM) continue;
    var d = 0;
    var f = [];
    for (var m = 0; m < i.length; m++) {
      var g = i[m];
      if (g.state === STATE_PROCESSING || g.state === STATE_STAGING) {
        d++;
      } else {
        f.push(g);
      }
    }
    f.sort(function(e, r) {
      return (e.tickStarted || 0) - (r.tickStarted || 0);
    });
    var p = Math.max(0, MAX_ACTIVE_OPS_PER_ROOM - d);
    var v = 0;
    for (var R = p; R < f.length; R++) {
      var y = f[R];
      y._legacyQueueTrim = true;
      y._failed = true;
      y._failureReason = "combined room queue limit";
      v++;
    }
    if (v > 0) {
      console.log("[marketLab] " + o + ": cancelling " + v + " surplus pre-production operation(s) to enforce active-operation limit " + MAX_ACTIVE_OPS_PER_ROOM + (d > MAX_ACTIVE_OPS_PER_ROOM ? "; " + d + " protected operation(s) will drain normally." : "."));
      requestSave();
    }
  }
}

function findBuyingOperation(e, r) {
  ensureTickCache();
  var t = e + "|" + r;
  if (buyingOwnerCache.hasOwnProperty(t)) {
    var a = buyingOwnerCache[t];
    if (a.op && !a.op._failed && !a.op._completed && a.op.state === STATE_BUYING && a.op.targetCompound === r) {
      return a;
    }
    delete buyingOwnerCache[t];
  }
  var n = ensureMemory(e);
  var o = null;
  for (var i in n.rooms) {
    var u = n.rooms[i];
    if (!u) continue;
    for (var l = 0; l < u.length; l++) {
      var s = u[l];
      if (!s || s._failed || s._completed || s.targetCompound !== r || s.state !== STATE_BUYING) continue;
      if (!o) {
        o = {
          roomName: i,
          op: s
        };
        continue;
      }
      var c = (s.tickStarted || 0) - (o.op.tickStarted || 0);
      var d = s.id || "";
      var f = o.op.id || "";
      if (c < 0 || c === 0 && d < f) o = {
        roomName: i,
        op: s
      };
    }
  }
  if (o) buyingOwnerCache[t] = o;
  return o;
}

function getOperationAcquiredInputs(e, r) {
  var t = operationInputResources(e);
  var a = e.direction === DIR_FORWARD ? e.buyBaseAmounts : [ e.buyBaseCompoundAmount ];
  var n = {};
  var o = 0;
  var i = false;
  var u = null;
  if (e.jobId) {
    try {
      u = require("marketEconomics").get(e.jobId);
    } catch (e) {}
  }
  if (u) i = true;
  for (var l = 0; l < t.length; l++) {
    var s = t[l];
    var c = u && u.input && u.input[s] ? u.input[s].acquired || 0 : 0;
    var d = getManagedBuyRecord(e, r, s);
    if (d) {
      i = true;
      try {
        c = Math.max(c, marketBuyer.getFulfilled(d) || 0);
      } catch (e) {}
    }
    var f = opportunisticBuy.getRequest(r, s, {
      queue: "lab",
      opId: e.id
    });
    if (f) {
      i = true;
      c = Math.max(c, f.fulfilled || 0);
      if (f.pending && typeof f.pending.expected === "number") {
        c = Math.max(c, (f.fulfilled || 0) + f.pending.expected);
      }
    }
    if (e.batchMode && Array.isArray(e.batchBuyIds)) {
      for (var m = 0; m < e.batchBuyIds.length; m++) {
        var g = marketBatchBuy.find(e.batchBuyIds[m]);
        if (g && g.resourceType === s && g.state === marketBatchBuy.STATE_DONE) {
          i = true;
          c = Math.max(c, g.fulfilled || g.amount || 0);
        }
      }
    }
    if (!u && a && typeof a[l] === "number") {
      c = Math.max(c, countInRoom(r, s) - a[l]);
    }
    var p = e.pipelineId ? pipelineInputRequired(e, s) : e.batchSize || DEFAULT_BATCH_SIZE;
    c = Math.max(0, Math.min(p, c));
    n[s] = c;
    o += c;
  }
  return {
    amounts: n,
    total: o,
    tracked: i
  };
}

function getStaleReplacementCandidates() {
  var e = [];
  var r = [ DIR_FORWARD, DIR_REVERSE ];
  for (var t = 0; t < r.length; t++) {
    var a = r[t];
    var n = ensureMemory(a);
    for (var o in n.rooms) {
      var i = n.rooms[o] || [];
      for (var u = 0; u < i.length; u++) {
        var l = i[u];
        if (!l || l.pipelineId || l._failed || l._completed || l.partialBatchOriginal || l.replacementPending || l.cancellationPending || l.state !== STATE_BUYING) continue;
        var s = getBuyingAge(l);
        if (s < STALE_BUYING_TICKS || operationHasUnsafePendingBuy(l, o)) continue;
        var c = getProcessableBuyingAmount(l, o);
        var d = getMinimumPartialAmount(l);
        if (l.batchMode && c >= d) continue;
        var f = getOperationAcquiredInputs(l, o);
        e.push({
          direction: a,
          roomName: o,
          opId: l.id,
          compound: l.targetCompound,
          reagents: l.reagents ? l.reagents.slice() : [],
          age: s,
          usable: c,
          minimum: d,
          batchSize: l.batchSize || DEFAULT_BATCH_SIZE,
          acquired: f.amounts,
          acquiredTotal: f.total
        });
      }
    }
  }
  e.sort(function(e, r) {
    if (e.age !== r.age) return r.age - e.age;
    var t = e.opId || "";
    var a = r.opId || "";
    return t < a ? -1 : t > a ? 1 : 0;
  });
  return e;
}

function startOperation(e, r, t, a, n, o, i) {
  if (!isValidCompound(t)) {
    return "[" + tagFor(e) + "] Invalid compound: " + t;
  }
  var u = findReagents(t);
  if (u.length !== 2) {
    return "[" + tagFor(e) + "] Could not find reagents for " + t;
  }
  if (!r) r = findSuitableRoom();
  if (!r) {
    return "[" + tagFor(e) + "] No suitable room (need terminal + 3 labs)";
  }
  if (!roomHasLabsAndTerminal(r)) {
    return "[" + tagFor(e) + "] Room " + r + " lacks terminal + 3 labs";
  }
  if (labManager && typeof labManager.getLayout === "function") {
    var layout = labManager.getLayout(Game.rooms[r]);
    if (!layout || !Array.isArray(layout.groups) || layout.groups.length === 0) {
      return "[" + tagFor(e) + "] Room " + r + " has no valid lab layout";
    }
  }
  if (t.indexOf("X") >= 0 || u.indexOf("X") >= 0) {
    var l = labReactionPipeline.roomSupportsAdvanced(Game.rooms[r], getLabsInRoom(r));
    if (!l.ok) return "[" + tagFor(e) + "] " + l.reason;
  }
  var s = i && i.batchMode && Array.isArray(i.batchPurchases) ? i.batchPurchases : null;
  if (s && !canUseBatchRoom(r, s)) {
    return "[" + tagFor(e) + "] Batch purchase conflicts with an existing input buy in " + r;
  }
  var c = ensureRoomQueue(e, r);
  var d = getRoomQueues(r);
  if (countSlotOperations(c) >= MAX_ACTIVE_OPS_PER_ROOM) {
    return "[" + tagFor(e) + "] Active operation limit reached in " + r + " (" + MAX_ACTIVE_OPS_PER_ROOM + " operations)";
  }
  var f = countRoomSlotOperations(d);
  if (f >= MAX_ACTIVE_OPS_PER_ROOM) {
    return "[" + tagFor(e) + "] Combined active operation limit reached in " + r + " (" + MAX_ACTIVE_OPS_PER_ROOM + " operations)";
  }
  if (i && i.stockpile && countStockpileOperations(d) >= 2) {
    return "[" + tagFor(e) + "] Stockpile lab slot already occupied in " + r;
  }
  if (i && i.stockpile && countPendingStockpileOperations(d) >= 1) {
    return "[" + tagFor(e) + "] Pending stockpile lab slot already occupied in " + r;
  }
  var roomBusy = !!roomHasBuyingOperation(r);
  var roomQueueState = getRoomQueueState(r);
  var roomOccupied = roomQueueState.slotsUsed > 0;
  var roomQueued = roomQueueState.pending.length > 0;
  for (var m = 0; m < c.length; m++) {
    if (c[m].targetCompound === t && c[m].state !== STATE_PENDING && !roomOccupied && (c[m].state !== STATE_SELLING || !o)) {
      return "[" + tagFor(e) + "] " + t + " is already active in " + r;
    }
  }
  var g = findBuyingOperation(e, t);
  var initialState = g || roomBusy || roomOccupied || roomQueued ? STATE_PENDING : STATE_BUYING;
  var p = createOperation(e, r, t, u, a, i, initialState);
  if (n) p.jobId = n;
  if (initialState === STATE_PENDING) {
    p.pendingSince = Game.time;
    delete p.buyRequestCreated;
    phaseJob(p, "pending");
  }
  if (i && i.batchMode) {
    s = Array.isArray(i.batchPurchases) ? i.batchPurchases : [];
    if (initialState === STATE_PENDING) {
      p.batchPurchases = s;
    } else if (!setupBatchPurchases(p, r, s)) {
      return "[" + tagFor(e) + "] Failed to create batch purchase: " + (p._failureReason || "unknown error");
    }
  }
  c.push(p);
  requestSave();
  var S = e === DIR_FORWARD ? u.join(" + ") + " -> " + t : t + " -> " + u.join(" + ");
  var h = p.maxBuyPrice ? " (max " + p.maxBuyPrice.toFixed(3) + ")" : "";
  return "[" + tagFor(e) + "] Queued: " + S + " in " + r + " (batch: " + p.batchSize + ", position: " + c.length + ")" + h;
}

function startAutoOperation(e, r, t, a, n, o) {
  if (!n) return "[" + tagFor(e) + "] Auto operation requires an economics job ID";
  if (o && o.batchMode) {
    var i = findBuyingOperation(e, t);
    var u = i && i.op;
    var l = true;
    var s = Array.isArray(o.batchPurchases) ? o.batchPurchases : [];
    for (var c = 0; c < s.length; c++) {
      if (s[c] && s[c].orderRoomName === (i && i.roomName)) {
        l = false;
        break;
      }
    }
    var d = u ? getProcessableBuyingAmount(u, i.roomName) : 0;
    var f = u && (!u.batchMode || d < getMinimumPartialAmount(u));
    if (u && l && getBuyingAge(u) >= STALE_BUYING_TICKS && f && !operationHasUnsafePendingBuy(u, i.roomName)) {
      return replaceOperation(e, i.roomName, e, u.id, t, a, "replaced stale buying job by batch " + t, n, o);
    }
  }
  return startOperation(e, r, t, a, n, true, o);
}

function startStockpileOperation(e, r, t, a, n, o) {
  if (!n) return { ok: false, message: "[marketLab] Stockpile operation requires an economics job ID" };
  o = Object.assign({}, o || {}, {
    stockpile: true
  });
  var i = startOperation(e, r, t, a, n, true, o);
  if (typeof i !== "string" || i.indexOf(" Queued:") < 0) return { ok: false, message: i };
  var u = getNewestOperationId(e, r, t);
  var l = u ? getMutableRoomOperation(r, e, u) : null;
  return {
    ok: !!u,
    operationId: u,
    state: l ? l.state : null,
    message: i
  };
}

function startAutoPipeline(e, r, t, a, n, o) {
  o = o || {};
  if (!n) return "[" + tagFor(e) + "] Full pipeline requires an economics job ID";
  if (e !== DIR_FORWARD && e !== DIR_REVERSE) {
    return "[marketLab] Invalid pipeline direction: " + e;
  }
  var i = Math.floor(o.amount || o.batchSize || 0);
  if (i > 3e3) return "[" + tagFor(e) + "] Full pipeline amount cannot exceed 3000 until wave scheduling is available";
  var u = e === DIR_FORWARD ? "synthesis" : "decompose";
  var l = labReactionPipeline.build(u, t, i);
  if (!l.ok) return "[" + tagFor(e) + "] " + l.reason;
  if (!l.requiresAdvancedRoom) {
    return "[" + tagFor(e) + "] Full pipeline requires depth greater than one or catalyst use";
  }
  var s = r ? [ r ] : getRoomState.ownedNames();
  var c = null;
  var d = null;
  for (var f = 0; f < s.length; f++) {
    var m = s[f];
    if (!roomHasLabsAndTerminal(m)) continue;
    var g = Game.rooms[m];
    var p = getRoomQueueState(m);
    if (p && p.slotsFree <= 0) continue;
    var y = getLabsInRoom(m);
    var b = labReactionPipeline.roomSupportsAdvanced(g, y);
    if (!b.ok) continue;
    if (!labManager || typeof labManager.getPipelineLayout !== "function") continue;
    var S = labManager.getPipelineLayout(g, l);
    if (!S || !S.ok) continue;
    c = m;
    d = S;
    break;
  }
  if (!c) {
    return "[" + tagFor(e) + "] No RCL8 room with 10 labs and a valid pipeline layout";
  }
  r = c;
  var h = getRoomQueues(r);
  if (countSlotOperations(h[e]) >= MAX_ACTIVE_OPS_PER_ROOM) {
    return "[" + tagFor(e) + "] Active operation limit reached in " + r + " (" + MAX_ACTIVE_OPS_PER_ROOM + " operations)";
  }
  var k = countRoomSlotOperations(h);
  if (k >= MAX_ACTIVE_OPS_PER_ROOM) {
    return "[" + tagFor(e) + "] Combined active operation limit reached in " + r;
  }
  var roomQueueState = getRoomQueueState(r);
  var roomBusy = !!roomHasBuyingOperation(r);
  var roomOccupied = roomQueueState.slotsUsed > 0;
  for (var I = 0; I < h[e].length; I++) {
    if (h[e][I] && h[e][I].targetCompound === t && h[e][I].state !== STATE_PENDING && !roomOccupied && h[e][I].state !== STATE_SELLING) {
      return "[" + tagFor(e) + "] " + t + " pipeline is already active in " + r;
    }
  }
  var O = findBuyingOperation(e, t);
  var roomQueued = roomQueueState.pending.length > 0;
  var initialState = O || roomBusy || roomOccupied || roomQueued ? STATE_PENDING : STATE_BUYING;
  var T = typeof labManager.estimatePipelineTicks === "function" ? labManager.estimatePipelineTicks(l, d) : 0;
  if (T > 0 && T * 2 > 1e5) {
    return "[" + tagFor(e) + "] Pipeline estimate exceeds 100000 ticks";
  }
  var A = createPipelineOperation(e, r, t, l, a, {
    jobId: n,
    amount: i,
    pipelineEstimate: T,
    pipelineDeadline: Math.max(1e4, T * 2)
  }, initialState);
  if (initialState === STATE_PENDING) {
    A.pendingSince = Game.time;
    phaseJob(A, "pending");
  }
  h[e].push(A);
  requestSave();
  return "[" + tagFor(e) + "] Queued: " + (u === "synthesis" ? "full synthesis -> " : "full decomposition <- ") + t + " in " + r + " (batch: " + i + ", position: " + h[e].length + ")";
}

function cancelBuyForOp(e, r, t) {
  var a = {
    queue: "lab",
    opId: t.id,
    settlePending: true
  };
  var n = true;
  if (t.batchMode && Array.isArray(t.batchBuyIds)) {
    for (var o = 0; o < t.batchBuyIds.length; o++) {
      var i = marketBatchBuy.find(t.batchBuyIds[o]);
      if (i && (i.state === marketBatchBuy.STATE_QUEUED || i.state === marketBatchBuy.STATE_PENDING)) {
        if (!marketBatchBuy.cancel(t.batchBuyIds[o], "lab operation cancelled")) {
          n = false;
        }
      }
    }
  }
  var u = operationInputResources(t);
  for (var l = 0; l < u.length; l++) {
    var s = u[l];
    if (opportunisticBuy.getRequest(r, s, a)) {
      opportunisticBuy.cancelRequest(r, s, a);
    }
  }
  for (var c = 0; c < u.length; c++) {
    var d = opportunisticBuy.getRequest(r, u[c], a);
    if (d && d.pending && typeof d.pending.expected === "number") n = false;
  }
  if (!cancelAllTrackedMarketBuyOrders(t, r)) n = false;
  if (n) delete t.buyRequestCreated;
  return n;
}

function releaseHandoffReservation(e, r) {
  if (!e || !e.handoffReservationProgram) return;
  var t = e.handoffReservationProgram;
  var a = e.handoffResource || null;
  if (a) {
    storageManager.unReserve(r, a, "terminal", t);
    storageManager.unReserve(r, a, "storage", t);
  }
  e.handoffReservationProgram = null;
}

function cancelStagingForOp(e, r) {
  if (!r) return;
  if (r.stageReservationProgram) {
    clearStagingReservations(r, e);
    r.stageReservationProgram = null;
  }
  clearSellReservations(r, e);
}

function reserveHandoffResource(e, r) {
  if (!e || !e.handoff || !e.handoffResource || !(e.handoffAmount > 0)) return false;
  if (!e.handoffReservationProgram) e.handoffReservationProgram = "marketLabHandoff_" + e.id;
  var t = storageManager.storageFind(r, e.handoffResource);
  var program = e.handoffReservationProgram;
  var own = function(block) {
    var reservations = block && block.reservations || [];
    var amount = 0;
    for (var index = 0; index < reservations.length; index++) {
      if (reservations[index] && reservations[index].program === program) amount += reservations[index].amount || 0;
    }
    return amount;
  };
  var terminalOwn = own(t && t.terminal);
  var storageOwn = own(t && t.storage);
  var a = t && t.terminal ? Math.max(0, t.terminal.total - t.terminal.reserved + terminalOwn) : 0;
  var n = t && t.storage ? Math.max(0, t.storage.total - t.storage.reserved + storageOwn) : 0;
  var o = e.handoffAmount;
  if (a + n < o) return false;
  var i = Math.min(o, a);
  var u = o - i;
  if (u > n) {
    u = n;
    i = o - u;
  }
  var terminalResult = i > 0 ? storageManager.reserve(r, e.handoffResource, "terminal", program, i) : { ok: true };
  if (i === 0) storageManager.unReserve(r, e.handoffResource, "terminal", program);
  if (!terminalResult.ok) return false;
  var storageResult = u > 0 ? storageManager.reserve(r, e.handoffResource, "storage", program, u) : { ok: true };
  if (u === 0) storageManager.unReserve(r, e.handoffResource, "storage", program);
  if (!storageResult.ok) {
    if (terminalOwn > 0) storageManager.reserve(r, e.handoffResource, "terminal", program, terminalOwn); else storageManager.unReserve(r, e.handoffResource, "terminal", program);
    if (storageOwn > 0) storageManager.reserve(r, e.handoffResource, "storage", program, storageOwn); else storageManager.unReserve(r, e.handoffResource, "storage", program);
    return false;
  }
  return true;
}

function handoffReady(e, r) {
  if (!e || !e.handoff) return false;
  var t = e.handoffAmount || 0;
  if (!(t > 0)) return false;
  var a = Game.rooms[r];
  var n = a && a.terminal && a.terminal.store ? a.terminal.store[e.handoffResource] || 0 : 0;
  var o = a && a.storage && a.storage.store ? a.storage.store[e.handoffResource] || 0 : 0;
  if (n + o < t) return false;
  clearSellReservations(e, r);
  return reserveHandoffResource(e, r);
}

function finalizeOperation(e, r, t, a) {
  if (!e || e._finalized) return;
  delete buyLockWaitOwners[e.id];
  delete partialWaitReasons[e.id];
  if (e.pipelineId && labManager && typeof labManager.cancelPipeline === "function") {
    labManager.cancelPipeline(r, e.pipelineId, a || "market operation cancelled");
  }
  if (!isStockpileOperation(e) && t !== "completed" && e.partialSurplusPending) {
    retryPartialSurplusSales(e, r);
    if (e.partialSurplusPending) {
      requestSave();
      return false;
    }
  }
  if (t !== "completed" && e.jobId && (e.state === STATE_BUYING || e.state === STATE_WAITING || e.state === STATE_PROCESSING && !e.reactionStarted)) {
    var n = getOperationAcquiredInputs(e, r);
    if (n.tracked) {
      if (!e.sellBackAmounts) e.sellBackAmounts = {};
      for (var o in n.amounts) {
        e.sellBackAmounts[o] = Math.max(e.sellBackAmounts[o] || 0, n.amounts[o] || 0);
      }
    }
  }
  if (!cancelBuyForOp(e.direction || DIR_FORWARD, r, e)) {
    requestSave();
    return false;
  }
  releaseBatchReservations(e, "marketLab finalization");
  releaseHandoffInputReservation(e, r, true);
  if (t !== "completed" && !sellBackBoughtInputs(e, r)) {
    requestSave();
    return false;
  }
  if (e.conversionOnly && labCommodityRouter && typeof labCommodityRouter.settleConversion === "function") {
    labCommodityRouter.settleConversion(e, r, t);
  }
  e._finalized = true;
  if (e.handoff && t === "completed" && !e.handoffConsumed) {
    requestSave();
  } else {
    releaseHandoffReservation(e, r);
  }
  cancelStagingForOp(r, e);
  if (t === "completed") {
    e._completed = true;
    recordAutoTraderLabOutcome(e.direction, r, e, "completed", a);
  } else {
    e._failed = t === "failed";
    recordAutoTraderLabOutcome(e.direction, r, e, t === "cancelled" ? "cancelled" : "failed", a);
  }
  if (e.jobId) {
    try {
      var i = require("marketEconomics");
      i.finish(e.jobId, t === "completed" ? "done" : t === "cancelled" ? "cancelled" : "failed", a || null);
    } catch (e) {}
  }
  requestSave();
  return true;
}

function cancelOperation(e, r, t, a) {
  var n = ensureMemory(e);
  var o = n.rooms[r];
  if (!o || o.length === 0) return {
    status: "missing",
    opId: t
  };
  for (var i = o.length - 1; i >= 0; i--) {
    var u = o[i];
    if (!u || u.id !== t) continue;
    if (!u.direction) u.direction = e;
    var l = a || "cancellation requested";
    if (finalizeOperation(u, r, "cancelled", l) === false) {
      u.cancellationPending = true;
      u.cancellationReason = l;
      requestSave();
      return {
        status: "pending",
        opId: t
      };
    }
    o.splice(i, 1);
    if (o.length === 0) delete n.rooms[r];
    forgetOperation(u);
    requestSave();
    return {
      status: "cancelled",
      opId: t
    };
  }
  return {
    status: "missing",
    opId: t
  };
}

function stopOperation(e, r, t) {
  var a = ensureMemory(e);
  var n = tagFor(e);
  if (!r) {
    var o = 0;
    var i = 0;
    for (var u in a.rooms) {
      var l = a.rooms[u];
      for (var s = l.length - 1; s >= 0; s--) {
        if (!l[s].direction) l[s].direction = e;
        if (finalizeOperation(l[s], u, "cancelled", "stopped by operator") === false) {
          l[s].cancellationPending = true;
          l[s].cancellationReason = "stopped by operator";
          i++;
        } else {
          forgetOperation(l[s]);
          l.splice(s, 1);
          o++;
        }
      }
      if (l.length === 0) delete a.rooms[u];
    }
    requestSave();
    return "[" + n + "] Stopped " + o + " op(s) in all rooms" + (i > 0 ? "; " + i + " cleanup(s) pending." : ".");
  }
  var c = a.rooms[r];
  if (!c || c.length === 0) {
    return "[" + n + "] No operations in " + r;
  }
  if (!t) {
    var d = 0;
    var f = 0;
    for (var m = c.length - 1; m >= 0; m--) {
      if (!c[m].direction) c[m].direction = e;
      if (finalizeOperation(c[m], r, "cancelled", "stopped by operator") === false) {
        c[m].cancellationPending = true;
        c[m].cancellationReason = "stopped by operator";
        f++;
      } else {
        forgetOperation(c[m]);
        c.splice(m, 1);
        d++;
      }
    }
    if (c.length === 0) delete a.rooms[r];
    requestSave();
    return "[" + n + "] Stopped " + d + " op(s) in " + r + (f > 0 ? "; " + f + " cleanup(s) pending." : ".");
  }
  for (var g = c.length - 1; g >= 0; g--) {
    if (c[g].targetCompound === t) {
      if (!c[g].direction) c[g].direction = e;
      if (finalizeOperation(c[g], r, "cancelled", "stopped by operator") === false) {
        c[g].cancellationPending = true;
        c[g].cancellationReason = "stopped by operator";
        requestSave();
        return "[" + n + "] Could not stop " + t + " in " + r + ": input sell-back is pending.";
      }
      forgetOperation(c[g]);
      c.splice(g, 1);
      requestSave();
      return "[" + n + "] Stopped " + t + " in " + r;
    }
  }
  return "[" + n + "] " + t + " not found in " + r;
}

function replaceOperation(e, r, t, a, n, o, i, u, l) {
  if (!isValidCompound(n)) return "[" + tagFor(e) + "] Invalid compound: " + n;
  var s = findReagents(n);
  if (s.length !== 2) return "[" + tagFor(e) + "] Could not find reagents for " + n;
  if (!roomHasLabsAndTerminal(r)) return "[" + tagFor(e) + "] Room " + r + " lacks terminal + 3 labs";
  var c = ensureMemory(t);
  var d = c.rooms[r];
  var f = -1;
  if (d) {
    for (var m = 0; m < d.length; m++) {
      if (d[m] && d[m].id === a) {
        f = m;
        break;
      }
    }
  }
  if (f < 0) return "[" + tagFor(e) + "] Replacement victim not found in " + r;
  var g = d[f];
  var p = l && l.batchMode && Array.isArray(l.batchPurchases) ? l.batchPurchases : null;
  if (p && !canUseBatchRoom(r, p)) {
    return "[" + tagFor(e) + "] Batch purchase conflicts with an existing input buy in " + r;
  }
  var v = getProcessableBuyingAmount(g, r);
  var R = !g.batchMode || v < getMinimumPartialAmount(g);
  if (g.replacementPending || g.cancellationPending || g.state !== STATE_BUYING || getBuyingAge(g) < STALE_BUYING_TICKS || !R || operationHasUnsafePendingBuy(g, r)) {
    return "[" + tagFor(e) + "] Replacement victim is no longer safely replaceable in " + r;
  }
  var y = ensureRoomQueue(e, r);
  for (var b = 0; b < y.length; b++) {
    if (y[b] !== g && y[b].targetCompound === n && y[b].state !== STATE_SELLING && y[b].state !== STATE_PENDING) {
      return "[" + tagFor(e) + "] " + n + " is already active in " + r;
    }
  }
  var h = getRoomQueues(r);
  if (countRoomSlotOperations(h, g) >= MAX_ACTIVE_OPS_PER_ROOM) {
    return "[" + tagFor(e) + "] Combined active operation limit reached in " + r + " (" + MAX_ACTIVE_OPS_PER_ROOM + " operations)";
  }
  pauseActiveBuyingClock(g);
  g.replacementPending = true;
  g.replacementReason = i || "replaced by scheduler";
  requestSave();
  if (finalizeOperation(g, r, "cancelled", g.replacementReason) === false) {
    console.log("[marketLab " + shortTagFor(g.direction) + "] " + r + "/" + g.targetCompound + ": replacement cleanup pending; buying remains stopped until the room slot is safely released.");
    requestSave();
    return "[" + tagFor(e) + "] Replacement victim cleanup is pending in " + r;
  }
  forgetOperation(g);
  d.splice(f, 1);
  if (d.length === 0) delete c.rooms[r];
  delete buyingOwnerCache[e + "|" + n];
  delete buyingOwnerCache[t + "|" + g.targetCompound];
  var k = startOperation(e, r, n, o, u, true, l || null);
  if (typeof k !== "string" || k.indexOf(" Queued:") < 0) return k;
  return k + " (replaced: " + g.targetCompound + ")";
}

function makeOperationSnapshot(e, r, t) {
  if (!e || typeof e !== "object") return null;
  var a = Object.create(e);
  a.room = r;
  a.direction = e.direction || t;
  return a;
}

function getOperations(e) {
  var r = e === DIR_FORWARD || e === DIR_REVERSE ? [ e ] : [ DIR_FORWARD, DIR_REVERSE ];
  var t = [];
  for (var a = 0; a < r.length; a++) {
    var n = r[a];
    var o = ensureMemory(n);
    for (var i in o.rooms) {
      var u = o.rooms[i];
      if (!Array.isArray(u)) continue;
      for (var l = 0; l < u.length; l++) {
        var s = u[l];
        if (!s) continue;
        t.push(makeOperationSnapshot(s, i, n));
      }
    }
  }
  return t;
}

function getRoomOperations(e) {
  var r = [];
  var t = [ DIR_FORWARD, DIR_REVERSE ];
  for (var a = 0; a < t.length; a++) {
    var n = t[a];
    var o = ensureMemory(n);
    var i = o.rooms[e];
    if (!Array.isArray(i)) continue;
    for (var u = 0; u < i.length; u++) {
      if (i[u]) r.push(makeOperationSnapshot(i[u], e, n));
    }
  }
  return r;
}

function getMutableRoomOperation(e, r, t) {
  if (!e || !r || !t) return null;
  var a = ensureMemory(r).rooms[e];
  if (!Array.isArray(a)) return null;
  for (var n = 0; n < a.length; n++) {
    if (a[n] && a[n].id === t) return a[n];
  }
  return null;
}

function roomHasBuyingOperation(e) {
  var r = getRoomOperations(e);
  for (var t = 0; t < r.length; t++) {
    if (r[t] && !r[t]._failed && !r[t]._completed && r[t].state === STATE_BUYING) return r[t];
  }
  return null;
}

function getRoomQueueState(e) {
  var r = getRoomOperations(e);
  var t = 0;
  var a = null;
  var n = [];
  var o = false;
  for (var i = 0; i < r.length; i++) {
    var u = r[i];
    if (!u || u._failed || u._completed || u.cancellationPending) continue;
    if (operationConsumesRoomSlot(u)) t++;
    if (u.state === STATE_BUYING && !a) {
      a = {
        id: u.id,
        compound: u.targetCompound,
        direction: u.direction
      };
    }
    if (u.state === STATE_PENDING) {
      n.push({
        id: u.id,
        compound: u.targetCompound,
        direction: u.direction,
        pendingSince: u.pendingSince,
        stockpile: !!u.stockpile
      });
      if (u.stockpile) o = true;
    }
  }
  n.sort(function(e, r) {
    var t = typeof e.pendingSince === "number" ? e.pendingSince : 0;
    var a = typeof r.pendingSince === "number" ? r.pendingSince : 0;
    if (t !== a) return t - a;
    var n = e.id || "";
    var o = r.id || "";
    return n < o ? -1 : n > o ? 1 : 0;
  });
  return {
    slotsUsed: t,
    slotsFree: Math.max(0, MAX_ACTIVE_OPS_PER_ROOM - t),
    buying: a,
    pending: n,
    stockpilePending: o
  };
}

function promoteRoomQueues() {
  if (queuePromotionTick === Game.time) return 0;
  queuePromotionTick = Game.time;
  var e = getRoomState.ownedNames();
  var r = 0;
  for (var t = 0; t < e.length; t++) {
    var a = e[t];
    var roomState = getRoomState.get(a);
    var roomBlocked = roomState && Array.isArray(roomState.hostiles) && roomState.hostiles.length > 0 || roomSuspender && typeof roomSuspender.shouldAvoidRoomWork === "function" && roomSuspender.shouldAvoidRoomWork(a);
    if (!roomHasLabsAndTerminal(a) || roomBlocked || roomHasBuyingOperation(a)) continue;
    var n = getRoomQueueState(a).pending;
    for (var o = 0; o < n.length; o++) {
      var i = n[o];
      if (typeof i.pendingSince === "number" && Game.time - i.pendingSince > PENDING_TTL_TICKS) continue;
      var u = findBuyingOperation(i.direction, i.compound);
      if (u) {
        if (!pendingWaitLogTick[i.id] || Game.time - pendingWaitLogTick[i.id] >= 50) {
          pendingWaitLogTick[i.id] = Game.time;
          console.log("[marketLab " + shortTagFor(i.direction) + "] " + a + "/" + i.compound + ": pending behind empire buy " + u.roomName + "/" + u.op.targetCompound + ".");
        }
        continue;
      }
      var l = getMutableRoomOperation(a, i.direction, i.id);
      if (!l || l.state !== STATE_PENDING) continue;
      var s = typeof l.pendingSince === "number" ? l.pendingSince : Game.time;
      l.state = STATE_BUYING;
      l.buyingStartedTick = Game.time;
      l.activeBuyingTicks = 0;
      l.buyingActiveSince = Game.time;
      delete l.buyRequestCreated;
      delete l.pendingSince;
      if (l.batchMode && Array.isArray(l.batchPurchases) && !setupBatchPurchases(l, a, l.batchPurchases)) continue;
      phaseJob(l, "buying");
      delete pendingWaitLogTick[l.id];
      requestSave();
      console.log("[marketLab " + shortTagFor(l.direction) + "] " + a + "/" + l.targetCompound + ": promoted from queue (waited " + Math.max(0, Game.time - s) + " ticks).");
      r++;
      break;
    }
  }
  return r;
}

function getNewestOperationId(e, r, t, a) {
  var n = getOperations(e);
  for (var o = n.length - 1; o >= 0; o--) {
    var i = n[o];
    if (i.room === r && i.targetCompound === t && (a === undefined || i.tickStarted === a)) {
      return i.id || null;
    }
  }
  return null;
}

function resetMemory(e) {
  var r = ensureMemory(e);
  var t = 0;
  for (var a in r.rooms) {
    var n = r.rooms[a];
    for (var o = n.length - 1; o >= 0; o--) {
      if (!n[o].direction) n[o].direction = e;
      if (finalizeOperation(n[o], a, "cancelled", "memory reset by operator") === false) {
        n[o].cancellationPending = true;
        n[o].cancellationReason = "memory reset by operator";
        t++;
      } else {
        forgetOperation(n[o]);
        n.splice(o, 1);
      }
    }
    if (n.length === 0) delete r.rooms[a];
  }
  if (t > 0) {
    requestSave();
    return "[" + tagFor(e) + "] Reset deferred; " + t + " cleanup(s) pending.";
  }
  Memory[memKey(e)] = {
    rooms: {},
    version: MEMORY_VERSION
  };
  requestSave();
  return "[" + tagFor(e) + "] Memory reset.";
}

function getStatusForRoom(e, r) {
  ensureMemory(e);
  var t = Memory[memKey(e)].rooms[r];
  var a = tagFor(e);
  if (!t || t.length === 0) {
    return "[" + a + "] No active operations in " + r;
  }
  var n = [];
  n.push("[" + a + "] " + r + ": " + t.length + " operation(s)");
  for (var o = 0; o < t.length; o++) {
    var i = t[o];
    var u = e === DIR_FORWARD ? i.reagents.join(" + ") + " -> " + i.targetCompound : i.targetCompound + " -> " + i.reagents.join(" + ");
    n.push("");
    n.push("  [" + (o + 1) + "] " + u + " (" + i.state + ")");
    n.push("      Batch: " + i.batchSize + " (" + i.outputLabCount + " labs)");
    if (i.partialBatchOriginal) n.push("      Partial: " + i.batchSize + "/" + i.partialBatchOriginal);
    n.push("      Age:   " + (Game.time - i.tickStarted) + " ticks");
    if (i.salvageMode) n.push("      Salvage: yes");
    if (i.maxBuyPrice) n.push("      Max buy: " + i.maxBuyPrice.toFixed(3));
    if (i.maxReagentPrices) {
      var l = [];
      for (var s in i.maxReagentPrices) {
        if (!i.maxReagentPrices.hasOwnProperty(s)) continue;
        l.push(s + ":" + i.maxReagentPrices[s].toFixed(3));
      }
      if (l.length > 0) n.push("      Max buys: " + l.join(", "));
    }
    if (i.state === STATE_PENDING) {
      n.push("      Queued: pending " + (typeof i.pendingSince === "number" ? Game.time - i.pendingSince : 0) + " ticks");
    } else if (i.state === STATE_BUYING) {
      if (i.batchMode && Array.isArray(i.batchBuyIds)) {
        var c = [];
        for (var d = 0; d < i.batchBuyIds.length; d++) {
          var f = marketBatchBuy.find(i.batchBuyIds[d]);
          c.push(i.batchBuyIds[d] + ":" + (f ? f.state : "MISSING"));
        }
        n.push("      Batch purchases: " + c.join(", "));
      }
      if (e === DIR_FORWARD) {
        n.push("      " + i.reagents[0] + ": " + countInRoom(r, i.reagents[0]) + "/" + i.batchSize);
        n.push("      " + i.reagents[1] + ": " + countInRoom(r, i.reagents[1]) + "/" + i.batchSize);
      } else {
        n.push("      Progress: " + countInRoom(r, i.targetCompound) + "/" + i.batchSize);
      }
    } else if (i.state === STATE_WAITING) {
      n.push("      Waiting for labs to be free...");
    } else if (i.state === STATE_PROCESSING) {
      var m = !!(labManager && typeof labManager.getActiveOrder === "function" && labManager.getActiveOrder(r));
      n.push("      Lab order:      " + (m ? "active" : "NONE"));
      n.push("      reactionStarted: " + (i.reactionStarted ? "YES" : "NO"));
      if (e === DIR_FORWARD) {
        n.push("      " + i.reagents[0] + ": " + countInRoom(r, i.reagents[0]));
        n.push("      " + i.reagents[1] + ": " + countInRoom(r, i.reagents[1]));
        n.push("      " + i.targetCompound + ": " + countInRoom(r, i.targetCompound));
      } else {
        n.push("      " + i.targetCompound + ": " + countInRoom(r, i.targetCompound));
        n.push("      " + i.reagents[0] + ": " + countInRoom(r, i.reagents[0]));
        n.push("      " + i.reagents[1] + ": " + countInRoom(r, i.reagents[1]));
      }
    } else if (i.state === STATE_STAGING) {
      var g = getExpectedOutputs(i);
      n.push("      Staging to terminal");
      if (g) {
        for (var p in g) {
          if (!g.hasOwnProperty(p)) continue;
          var v = getStagingAvailability(r, p);
          var R = Math.max(0, (g[p] || 0) - v.terminal);
          var y = getStorageReservationAmount(r, p, i.stageReservationProgram);
          n.push("      " + p + ": storage " + v.storage + ", terminal " + v.terminal + " / " + g[p] + ", labs " + v.labs + ", creeps " + v.creeps + ", missing " + R + ", reserved " + y);
        }
      }
      if (i.stageStartTick) n.push("      Staging age: " + (Game.time - i.stageStartTick) + "/" + STAGING_GRACE_TICKS + " ticks");
      if (i.stageReservationProgram) n.push("      Stage reserve: " + i.stageReservationProgram);
      if (i.sellReservationProgram) n.push("      Sell reserve: " + i.sellReservationProgram);
    } else if (i.state === STATE_SELLING) {
      var b = Game.time - (i.sellingStartTick || Game.time);
      var S = isOutputEvacuated(i, r);
      n.push("      " + i.targetCompound + ": " + countInRoom(r, i.targetCompound));
      n.push("      " + i.reagents[0] + ": " + countInRoom(r, i.reagents[0]));
      n.push("      " + i.reagents[1] + ": " + countInRoom(r, i.reagents[1]));
      n.push("      Evacuation complete: " + (S ? "yes" : "no (waiting up to " + (SELLING_GRACE_TICKS - b) + " more ticks)"));
      n.push("      Sell order placed: " + (i.sellOrderCreated ? "yes" : "no"));
      if (i.sellReservationProgram) n.push("      Sell reserve: " + i.sellReservationProgram);
      n.push("      Waiting in sell: " + b + " ticks");
      if (Array.isArray(i.sellRequestInfo) && i.sellRequestInfo.length > 0) {
        for (var h = 0; h < i.sellRequestInfo.length; h++) {
          var k = i.sellRequestInfo[h];
          if (!k) continue;
          var I = "";
          if (k.orderId && Game.market && Game.market.orders && Game.market.orders[k.orderId]) {
            var O = Game.market.orders[k.orderId];
            I = " live=" + util.getOrderRemaining(O) + "/" + (O.totalAmount || "?");
          } else {
            I = " no-live-order";
          }
          n.push("      Sell req: " + k.resource + " x " + k.amount + " orderId=" + (k.orderId || "null") + I);
        }
      } else {
        n.push("      Sell req: <none>");
      }
    }
  }
  return n.join("\n");
}

function getAllStatus(e) {
  ensureMemory(e);
  var r = Memory[memKey(e)].rooms;
  var t = tagFor(e);
  var a = [];
  for (var n in r) {
    if (r[n] && r[n].length > 0) a.push(n);
  }
  if (a.length === 0) return "[" + t + "] No active operations.";
  var o = [ "[" + t + "] " + a.length + " room(s) with operations:" ];
  for (var i = 0; i < a.length; i++) {
    o.push("");
    o.push(getStatusForRoom(e, a[i]));
  }
  return o.join("\n");
}

function makeCommand(e) {
  var r = tagFor(e);
  return function(t, a, n) {
    ensureMemory(e);
    if (!t) return getAllStatus(e);
    if (t === "stop") return stopOperation(e, a, n);
    if (t === "reset") return resetMemory(e);
    if (t === "check") {
      if (!a) return "[" + r + "] Usage: " + r + "('check', 'roomName')";
      var o = calculateBatchSize(a);
      return "[" + r + "] " + a + ": " + o.outputLabCount + " output labs, batch size = " + o.batchSize;
    }
    var i = Game.rooms[t] !== undefined || /^[EW]\d+[NS]\d+$/.test(t);
    if (i && !a) {
      return getStatusForRoom(e, t);
    }
    if (i && a) {
      var u = typeof n === "number" || n && typeof n === "object" ? n : null;
      return startOperation(e, t, a, u);
    }
    return startOperation(e, null, t, null);
  };
}

var labForward = makeCommand(DIR_FORWARD);
var labReverse = makeCommand(DIR_REVERSE);
global.labForward = labForward;
global.labReverse = labReverse;
global.stopAllLab = function() {
  var e = labForward("stop");
  var r = labReverse("stop");
  return e + "\n" + r;
};

global.marketLabDrainQueue = function() {
  var e = 0;
  var r = [ DIR_FORWARD, DIR_REVERSE ];
  for (var t = 0; t < r.length; t++) {
    var a = ensureMemory(r[t]);
    for (var n in a.rooms) {
      var o = a.rooms[n] || [];
      for (var i = 0; i < o.length; i++) {
        var u = o[i];
        if (!u || u.state !== STATE_PENDING) continue;
        u.state = STATE_BUYING;
        u.buyingStartedTick = Game.time;
        u.activeBuyingTicks = 0;
        u.buyingActiveSince = Game.time;
        delete u.buyRequestCreated;
        if (u.batchMode && Array.isArray(u.batchPurchases)) setupBatchPurchases(u, n, u.batchPurchases);
        delete u.pendingSince;
        delete pendingWaitLogTick[u.id];
        phaseJob(u, "buying");
        e++;
      }
    }
  }
  if (e > 0) requestSave();
  return "[marketLab] force-promoted " + e + " pending operation(s)";
};
//                 stub so the CPU profiler attributes correctly).
function clearLegacyDirectionTickMarkers() {
  if (legacyTickMarkersCleared) return;
  legacyTickMarkersCleared = true;
  var e = false;
  if (Memory._marketLabFwdTick !== undefined) {
    delete Memory._marketLabFwdTick;
    e = true;
  }
  if (Memory._marketLabRevTick !== undefined) {
    delete Memory._marketLabRevTick;
    e = true;
  }
  if (e) requestSave();
}

function runDirections(e, r) {
  var t = getSchedulerState();
  var a = t.sliceTick !== Game.time;
  if (a) {
    t.sliceTick = Game.time;
    t.sliceStart = Game.cpu.getUsed();
    t.sliceAllowance = typeof r === "number" && isFinite(r) ? Math.max(0, r) : null;
    t.lastProcessed = 0;
    t.lastVisited = 0;
    t.lastYielded = false;
  } else if (t.sliceAllowance !== null && typeof r === "number" && isFinite(r)) {
    t.sliceAllowance = Math.min(t.sliceAllowance, Math.max(0, r));
  }
  clearLegacyDirectionTickMarkers();
  trimLegacyQueues();
  promoteRoomQueues();
  var n = t.sliceAllowance === null ? null : t.sliceStart + t.sliceAllowance;
  var o = 0;
  var i = 0;
  var u = false;
  for (var l = 0; l < e.length; l++) {
    var s = e[l];
    if (directionRunTicks[s] === Game.time) continue;
    if (n !== null && Game.cpu.getUsed() >= n) {
      u = true;
      break;
    }
    directionRunTicks[s] = Game.time;
    var c = processDirection(s, n);
    o += c.processed;
    i += c.visited;
    if (c.yielded) {
      u = true;
      break;
    }
    if (n !== null && Game.cpu.getUsed() >= n && l + 1 < e.length) {
      u = true;
      break;
    }
  }
  t.lastCpu = Game.cpu.getUsed() - t.sliceStart;
  t.lastProcessed += o;
  t.lastVisited += i;
  var d = u && !t.lastYielded;
  t.lastYielded = t.lastYielded || u;
  t.lastTick = Game.time;
  t.totalProcessed = (t.totalProcessed || 0) + o;
  if (d) t.totalYields = (t.totalYields || 0) + 1;
  return t;
}

module.exports = {
  run: function(e) {
    var r = getSchedulerState();
    if (r.directionOrderTick !== Game.time) {
      var t = r.nextDirection === DIR_REVERSE ? DIR_REVERSE : DIR_FORWARD;
      var a = t === DIR_FORWARD ? DIR_REVERSE : DIR_FORWARD;
      r.directionOrderTick = Game.time;
      r.directionOrder = [ t, a ];
      r.nextDirection = a;
    }
    return runDirections(r.directionOrder, e);
  },
  runForward: function(e) {
    return runDirections([ DIR_FORWARD ], e);
  },
  runReverse: function(e) {
    return runDirections([ DIR_REVERSE ], e);
  },
  labForward: labForward,
  labReverse: labReverse,
  startAutoOperation: startAutoOperation,
  startStockpileOperation: startStockpileOperation,
  startAutoPipeline: startAutoPipeline,
  cancelOperation: cancelOperation,
  getStaleReplacementCandidates: getStaleReplacementCandidates,
  replaceOperation: replaceOperation,
  canUseBatchRoom: canUseBatchRoom,
  getOperations: getOperations,
  getCommittedSaleOutputs: getCommittedSaleOutputs,
  getRoomOperations: getRoomOperations,
  getRoomQueueState: getRoomQueueState,
  promoteRoomQueues: promoteRoomQueues,
  getBuyingAge: getBuyingAge,
  STATE_PENDING: STATE_PENDING,
  PENDING_TTL_TICKS: PENDING_TTL_TICKS,
  getNewestOperationId: getNewestOperationId
};
