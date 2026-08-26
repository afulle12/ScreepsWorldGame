// LLM: Read docs/codex.js before reviewing or changing this file.
// scavengerLearning.js
const memoryManager = require("memoryManager");
const marketPricing = require("marketPricing");
const DATASET_ID = "scavengerLearning";
const DATASET_VERSION = 3;
const ARCHITECTURE_VERSION = 1;
const FEATURE_SCHEMA_VERSION = 2;
const QUANTIZATION = 2048;
const MAX_BODY_SIZE = 6;
const BODY_PART_COST = 100;
const MAX_BODY_PARTS = 50;
const CONTEXT_SIZE = 32;
const BODY_ACTION_SIZE = 8;
const CONTEXT_HIDDEN_SIZE = 16;
const ACTION_HIDDEN_SIZE = 8;
const RESOURCE_UNKNOWN = "__unknown__";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BATCH_OPPORTUNITIES = 100;
const MIN_PER_VARIANT_PER_ROOM = 6;
const MIN_ELIGIBLE_ROOMS_FOR_GLOBAL_UPDATE = 3;
const PROMOTION_CONFIRMATION_BLOCKS = 2;
const PROMOTION_MARGIN = .02;
const LAMBDA_SKIP = .15;
const MUTATION_RATE = .08;
const MUTATION_STDDEV = .05;
const MAX_WEIGHT_ABS = 4;
const MAX_INVALID_OUTPUTS_FOR_PROMOTION = 0;
const MAX_EPISODE_TICKS = 2e3;
const MAX_PENDING_COHORTS = 8;
const ROOM_STATE_TTL = 2e4;
const FALLBACK_RESOURCES = [ "energy", "power", "ops", "H", "O", "U", "L", "K", "Z", "X", "G", "OH", "ZK", "UL", "GH", "UH", "UO", "KH", "KO", "LH", "LO", "ZH", "ZO", "GH2O", "GHO2", "UH2O", "UHO2", "KH2O", "KHO2", "LH2O", "LHO2", "ZH2O", "ZHO2", "XGH2O", "XGHO2", "XUH2O", "XUHO2", "XKH2O", "XKHO2", "XLH2O", "XLHO2", "XZHO2", "oxidant", "reductant", "zynthium_bar", "lemergium_bar", "utrium_bar", "keanium_bar", "purifier", "battery", "ghodium_melt", "alloy", "wire", "cell", "condensate", "composite", "tube", "phlegm", "switch", "concentrate", "crystal", "fixtures", "tissue", "transistor", "extract", "liquid", "frame", "muscle", "microchip", "spirit", "hydraulics", "organoid", "circuit", "emanation", "machine", "organism", "device", "essence", "mist", "biomass", "metal", "silicon" ];
function buildResourceVocabulary() {
  var e = typeof RESOURCES_ALL !== "undefined" && Array.isArray(RESOURCES_ALL) ? RESOURCES_ALL : FALLBACK_RESOURCES;
  var r = {};
  var t = [];
  for (var n = 0; n < e.length; n++) {
    var o = e[n];
    if (typeof o !== "string" || !o || r[o]) continue;
    r[o] = true;
    t.push(o);
  }
  if (!r[RESOURCE_UNKNOWN]) t.push(RESOURCE_UNKNOWN);
  return t;
}

const RESOURCE_VOCABULARY = buildResourceVocabulary();
const RESOURCE_INDEX = {};
for (let e = 0; e < RESOURCE_VOCABULARY.length; e++) {
  RESOURCE_INDEX[RESOURCE_VOCABULARY[e]] = e;
}
const RESOURCE_VECTOR_SIZE = RESOURCE_VOCABULARY.length;
const CANDIDATE_SIZE = RESOURCE_VECTOR_SIZE * 2 + 3 + 14;
const TENSOR_SPECS = [ {
  name: "contextW",
  length: CONTEXT_HIDDEN_SIZE * CONTEXT_SIZE
}, {
  name: "contextB",
  length: CONTEXT_HIDDEN_SIZE
}, {
  name: "actionW",
  length: ACTION_HIDDEN_SIZE * (CONTEXT_HIDDEN_SIZE + BODY_ACTION_SIZE)
}, {
  name: "actionB",
  length: ACTION_HIDDEN_SIZE
}, {
  name: "actionOutW",
  length: ACTION_HIDDEN_SIZE
}, {
  name: "actionOutB",
  length: 1
}, {
  name: "candidateW",
  length: ACTION_HIDDEN_SIZE * (CONTEXT_HIDDEN_SIZE + CANDIDATE_SIZE)
}, {
  name: "candidateB",
  length: ACTION_HIDDEN_SIZE
}, {
  name: "candidateOutW",
  length: ACTION_HIDDEN_SIZE
}, {
  name: "candidateOutB",
  length: 1
} ];
const storage = memoryManager.storage;
var validatedRoot = null;
if (storage && typeof storage.register === "function") {
  storage.register(DATASET_ID, {
    path: "Memory.scavengerLearning",
    owner: "scavengerLearning.js",
    mutability: "mutable"
  });
}
function now() {
  return typeof Game !== "undefined" && typeof Game.time === "number" ? Game.time : 0;
}

function requestSave() {
  if (memoryManager && typeof memoryManager.requestSave === "function") memoryManager.requestSave();
}

function requestImmediateSave(e) {
  if (memoryManager && typeof memoryManager.requestImmediateSave === "function") {
    memoryManager.requestImmediateSave(e || "scavengerLearning.promotion");
  } else {
    requestSave();
  }
}

function storageGet() {
  if (storage && typeof storage.get === "function") return storage.get(DATASET_ID);
  return typeof Memory !== "undefined" ? Memory.scavengerLearning : undefined;
}

function storageSet(e, r) {
  if (storage && typeof storage.set === "function") {
    var t = storage.set(DATASET_ID, e);
    if (r && r.durability === "immediate") requestImmediateSave(r.reason);
    return t;
  }
  if (typeof Memory !== "undefined") Memory.scavengerLearning = e;
  requestSave();
  return e;
}

function clamp(e, r, t) {
  return e < r ? r : e > t ? t : e;
}

function seedFrom(e) {
  var r = String(e || "scavenger");
  var t = 2166136261;
  for (var n = 0; n < r.length; n++) {
    t ^= r.charCodeAt(n);
    t = Math.imul(t, 16777619);
  }
  return t >>> 0;
}

function randomGenerator(e) {
  var r = e >>> 0;
  return function() {
    r = Math.imul(r, 1664525) + 1013904223 >>> 0;
    return r / 4294967296;
  };
}

function randomSigned(e, r) {
  return (e() * 2 - 1) * r;
}

function bytesToBase64(e) {
  var r = "";
  for (var t = 0; t < e.length; t += 3) {
    var n = e[t] || 0;
    var o = t + 1 < e.length ? e[t + 1] : 0;
    var a = t + 2 < e.length ? e[t + 2] : 0;
    var i = n << 16 | o << 8 | a;
    r += BASE64.charAt(i >> 18 & 63);
    r += BASE64.charAt(i >> 12 & 63);
    r += t + 1 < e.length ? BASE64.charAt(i >> 6 & 63) : "=";
    r += t + 2 < e.length ? BASE64.charAt(i & 63) : "=";
  }
  return r;
}

function base64ToBytes(e) {
  var r = String(e || "").replace(/-/g, "+").replace(/_/g, "/");
  while (r.length % 4) r += "=";
  var t = [];
  for (var n = 0; n < r.length; n += 4) {
    var o = BASE64.indexOf(r.charAt(n));
    var a = BASE64.indexOf(r.charAt(n + 1));
    var i = r.charAt(n + 2) === "=" ? 0 : BASE64.indexOf(r.charAt(n + 2));
    var s = r.charAt(n + 3) === "=" ? 0 : BASE64.indexOf(r.charAt(n + 3));
    if (o < 0 || a < 0 || i < 0 || s < 0) throw new Error("Invalid scavenger Base64URL tensor");
    var c = o << 18 | a << 12 | i << 6 | s;
    t.push(c >> 16 & 255);
    if (r.charAt(n + 2) !== "=") t.push(c >> 8 & 255);
    if (r.charAt(n + 3) !== "=") t.push(c & 255);
  }
  return t;
}

function tensorMap(e) {
  var r = {};
  for (var t = 0; t < TENSOR_SPECS.length; t++) r[TENSOR_SPECS[t].name] = e[t];
  return r;
}

function createRandomTensors(e, r) {
  var t = randomGenerator(e);
  var n = [];
  r = r === undefined ? .05 : r;
  for (var o = 0; o < TENSOR_SPECS.length; o++) {
    var a = [];
    for (var i = 0; i < TENSOR_SPECS[o].length; i++) a.push(randomSigned(t, r));
    n.push(a);
  }
  return n;
}

function encodeTensor(e) {
  var r = [];
  for (var t = 0; t < e.length; t++) {
    var n = Math.round(clamp(e[t], -MAX_WEIGHT_ABS, MAX_WEIGHT_ABS) * QUANTIZATION);
    n = clamp(n, -32768, 32767);
    if (n < 0) n += 65536;
    r.push(n & 255, n >> 8 & 255);
  }
  return bytesToBase64(r).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeTensor(e) {
  var r = base64ToBytes(e);
  if (r.length % 2 !== 0) throw new Error("Invalid scavenger tensor byte length");
  var t = [];
  for (var n = 0; n < r.length; n += 2) {
    var o = r[n] | r[n + 1] << 8;
    if (o & 32768) o -= 65536;
    t.push(o / QUANTIZATION);
  }
  return t;
}

function encodeTensors(e) {
  return e.map(encodeTensor);
}

function decodeTensors(e) {
  if (!Array.isArray(e) || e.length !== TENSOR_SPECS.length) {
    throw new Error("Invalid scavenger tensor count");
  }
  var r = [];
  for (var t = 0; t < e.length; t++) {
    var n = decodeTensor(e[t]);
    if (n.length !== TENSOR_SPECS[t].length) {
      throw new Error("Invalid scavenger tensor length for " + TENSOR_SPECS[t].name);
    }
    r.push(n);
  }
  return r;
}

function createModelRecord(e, r, t, n, o) {
  return {
    modelId: e,
    version: r,
    parent: t || null,
    seed: n >>> 0,
    architectureVersion: ARCHITECTURE_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    tensors: encodeTensors(o)
  };
}

function isCompatibleModelRecord(e, r) {
  if (!e || e.architectureVersion !== ARCHITECTURE_VERSION || e.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || !Array.isArray(e.tensors) || e.tensors.length !== TENSOR_SPECS.length) return false;
  if (!r) return true;
  try {
    decodeTensors(e.tensors);
    return true;
  } catch (e) {
    return false;
  }
}

function getModelRecord(e, r) {
  return e && e.models && e.models[r];
}

function getDecodedModel(e) {
  var r = ensureRoot();
  var t = getModelRecord(r, e);
  if (!isCompatibleModelRecord(t, false)) return null;
  var n = memoryManager.heap || (memoryManager.heap = {});
  if (!n.scavengerModels) n.scavengerModels = {};
  var o = n.scavengerModels[e];
  if (o && o.version === t.version) return o;
  var a;
  try {
    a = {
      modelId: e,
      version: t.version,
      tensors: tensorMap(decodeTensors(t.tensors))
    };
  } catch (e) {
    return null;
  }
  n.scavengerModels[e] = a;
  return a;
}

function invalidateModelCache(e) {
  var r = memoryManager.heap || (memoryManager.heap = {});
  if (r.scavengerModels) delete r.scavengerModels[e];
}

function mutateTensors(e, r) {
  var t = randomGenerator(r);
  var n = [];
  for (var o = 0; o < e.length; o++) {
    var a = e[o];
    var i = [];
    for (var s = 0; s < a.length; s++) {
      var c = a[s];
      if (t() < MUTATION_RATE) c += randomSigned(t, MUTATION_STDDEV);
      i.push(clamp(c, -MAX_WEIGHT_ABS, MAX_WEIGHT_ABS));
    }
    n.push(i);
  }
  return n;
}

function tanh(e) {
  return Math.tanh(e);
}

function dense(e, r, t, n, o, a) {
  var i = [];
  for (var s = 0; s < n; s++) {
    var c = t[s] || 0;
    var u = s * o;
    for (var d = 0; d < o; d++) c += (r[u + d] || 0) * (e[d] || 0);
    i.push(a ? a(c) : c);
  }
  return i;
}

function encodeContext(e, r) {
  return dense(r, e.tensors.contextW, e.tensors.contextB, CONTEXT_HIDDEN_SIZE, CONTEXT_SIZE, tanh);
}

function scoreAction(e, r, t) {
  var n = r.concat(t);
  var o = dense(n, e.tensors.actionW, e.tensors.actionB, ACTION_HIDDEN_SIZE, CONTEXT_HIDDEN_SIZE + BODY_ACTION_SIZE, tanh);
  var a = 0;
  for (var i = 0; i < ACTION_HIDDEN_SIZE; i++) a += o[i] * (e.tensors.actionOutW[i] || 0);
  return a + (e.tensors.actionOutB[0] || 0);
}

function scoreCandidate(e, r, t) {
  var n = r.concat(t);
  var o = dense(n, e.tensors.candidateW, e.tensors.candidateB, ACTION_HIDDEN_SIZE, CONTEXT_HIDDEN_SIZE + CANDIDATE_SIZE, tanh);
  var a = 0;
  for (var i = 0; i < ACTION_HIDDEN_SIZE; i++) a += o[i] * (e.tensors.candidateOutW[i] || 0);
  return a + (e.tensors.candidateOutB[0] || 0);
}

function hasOwn(e, r) {
  return Object.prototype.hasOwnProperty.call(e, r);
}

function emptyRoomState(e) {
  return {
    assignment: {
      pairId: e.pairId,
      incumbent: 0,
      challenger: 0,
      seed: seedFrom("scavenger-room|" + (e.roomName || "") + "|" + e.pairId)
    },
    siteState: null,
    diagnostics: {
      nonControllable: 0,
      invalidOutputs: 0,
      executionFailures: 0,
      pathFailures: 0
    },
    cumulative: {}
  };
}

function emptyStats() {
  return {
    opportunities: 0,
    spawns: 0,
    skips: 0,
    forcedSkips: 0,
    positive: 0,
    potentialProfit: 0,
    actualProfit: 0,
    spawnCost: 0,
    actualNet: 0,
    skipReward: 0,
    invalidOutputs: 0,
    executionFailures: 0,
    quantities: {}
  };
}

function emptyCohort(e, r) {
  return {
    id: e,
    pairId: r,
    opportunities: 0,
    unresolvedEpisodes: 0,
    closed: false,
    rooms: {}
  };
}

function newRoot() {
  var e = seedFrom("scavenger-initial-incumbent");
  var r = createRandomTensors(e, .05);
  var t = "scavenger-v1-incumbent";
  var n = "scavenger-v2-challenger";
  var o = seedFrom("scavenger-initial-challenger");
  var a = mutateTensors(r, o);
  var i = {
    v: DATASET_VERSION,
    arch: ARCHITECTURE_VERSION,
    featureSchema: FEATURE_SCHEMA_VERSION,
    quantization: QUANTIZATION,
    models: {},
    rooms: {},
    episodes: {},
    cohorts: {
      nextId: 1,
      active: null,
      pending: []
    },
    comparison: {
      pairId: 1,
      incumbentId: t,
      challengerId: n,
      evidence: {
        rooms: {},
        invalidOutputs: 0,
        executionFailures: 0,
        cohorts: 0
      },
      confirmationCount: 0
    },
    lastGood: t,
    nextModelVersion: 3,
    nextEpisodeSequence: 1,
    mutationSequence: 0,
    lastAppliedCohort: 0
  };
  i.models[t] = createModelRecord(t, 1, null, e, r);
  i.models[n] = createModelRecord(n, 2, t, o, a);
  return i;
}

function ensureRoot() {
  var e = storageGet();
  if (!e || typeof e !== "object" || e.v !== DATASET_VERSION || e.arch !== ARCHITECTURE_VERSION || e.featureSchema !== FEATURE_SCHEMA_VERSION || e.quantization !== QUANTIZATION || !e.models || !e.comparison || !e.models[e.comparison.incumbentId] || !e.models[e.comparison.challengerId] || e !== validatedRoot && (!isCompatibleModelRecord(e.models[e.comparison.incumbentId], true) || !isCompatibleModelRecord(e.models[e.comparison.challengerId], true))) {
    e = newRoot();
    storageSet(e, {
      durability: "checkpoint"
    });
  }
  if (!e.rooms) e.rooms = {};
  if (!e.episodes) e.episodes = {};
  if (!e.cohorts) e.cohorts = {
    nextId: 1,
    active: null,
    pending: []
  };
  if (!Array.isArray(e.cohorts.pending)) e.cohorts.pending = [];
  if (!e.nextEpisodeSequence) e.nextEpisodeSequence = 1;
  if (!e.nextModelVersion) e.nextModelVersion = 3;
  if (!e.mutationSequence) e.mutationSequence = 0;
  validatedRoot = e;
  return e;
}

function ensureRoom(e, r) {
  var t = e.comparison;
  var n = e.rooms[r];
  if (!n) {
    n = emptyRoomState({
      pairId: t.pairId,
      roomName: r
    });
    e.rooms[r] = n;
  }
  if (!n.assignment || n.assignment.pairId !== t.pairId) {
    n.assignment = {
      pairId: t.pairId,
      incumbent: 0,
      challenger: 0,
      seed: seedFrom("scavenger-room|" + r + "|" + t.pairId)
    };
  }
  if (!n.diagnostics) n.diagnostics = {
    nonControllable: 0,
    invalidOutputs: 0,
    executionFailures: 0
  };
  n.t = now();
  return n;
}

function ensureActiveCohort(e) {
  if (e.cohorts.active) return e.cohorts.active;
  var r = e.cohorts.nextId++;
  e.cohorts.active = emptyCohort(r, e.comparison.pairId);
  return e.cohorts.active;
}

function ensureRoomStats(e, r, t) {
  if (!e.rooms[r]) e.rooms[r] = {};
  if (!e.rooms[r][t]) e.rooms[r][t] = emptyStats();
  return e.rooms[r][t];
}

function mergeStats(e, r) {
  var t = [ "opportunities", "spawns", "skips", "forcedSkips", "positive", "potentialProfit", "actualProfit", "spawnCost", "actualNet", "skipReward", "invalidOutputs", "executionFailures" ];
  for (var n = 0; n < t.length; n++) e[t[n]] = (e[t[n]] || 0) + (r[t[n]] || 0);
  if (!e.quantities) e.quantities = {};
  if (r.quantities) {
    for (var o in r.quantities) {
      e.quantities[o] = (e.quantities[o] || 0) + (r.quantities[o] || 0);
    }
  }
  return e;
}

function nextRandom(e) {
  var r = Math.imul(e.assignment.seed >>> 0, 1664525) + 1013904223 >>> 0;
  e.assignment.seed = r;
  return r / 4294967296;
}

function chooseVariant(e, r) {
  var t = ensureRoom(e, r);
  var n = t.assignment;
  if (n.incumbent < n.challenger) {
    n.incumbent++;
    return "incumbent";
  }
  if (n.challenger < n.incumbent) {
    n.challenger++;
    return "challenger";
  }
  if (nextRandom(t) < .5) {
    n.incumbent++;
    return "incumbent";
  }
  n.challenger++;
  return "challenger";
}

function modelIdForVariant(e, r) {
  return r === "challenger" ? e.comparison.challengerId : e.comparison.incumbentId;
}

function roomStateKey(e, r, t) {
  return String(e || 0) + "|" + String(r || "") + "|" + String(t || "");
}

function shouldEvaluateState(e, r, t) {
  var n = ensureRoot();
  var o = ensureRoom(n, e);
  return !o.siteState || o.siteState.key !== roomStateKey(n.comparison.pairId, r, t);
}

function markObservedState(e, r, t, n) {
  var o = ensureRoot();
  var a = ensureRoom(o, e);
  a.siteState = {
    key: roomStateKey(o.comparison.pairId, r, t),
    fingerprint: r,
    contextFingerprint: t,
    observedAt: now(),
    controllable: !!n
  };
  requestSave();
}

function recordNonControllable(e) {
  var r = ensureRoot();
  var t = ensureRoom(r, e);
  t.diagnostics.nonControllable = (t.diagnostics.nonControllable || 0) + 1;
  requestSave();
}

function startOpportunity(e, r) {
  var t = ensureRoot();
  var n = ensureActiveCohort(t);
  if (n.opportunities >= BATCH_OPPORTUNITIES) {
    maintenance();
    n = ensureActiveCohort(t);
  }
  var o = r.variant || chooseVariant(t, e);
  var a = modelIdForVariant(t, o);
  var i = t.nextEpisodeSequence++;
  var s = e + "-" + now() + "-" + i;
  var c = ensureRoomStats(n, e, o);
  c.opportunities++;
  if (r.bestPotentialNet > 0) c.positive++;
  c.potentialProfit += r.potentialProfit || 0;
  n.opportunities++;
  t.episodes[s] = {
    id: s,
    roomName: e,
    cohortId: n.id,
    pairId: n.pairId,
    variant: o,
    modelId: a,
    modelVersion: getModelRecord(t, a).version,
    startedAt: now(),
    fingerprint: r.fingerprint || null,
    potentialProfit: r.potentialProfit || 0,
    bestPotentialNet: r.bestPotentialNet || 0,
    bodySize: 0,
    spawnCost: 0,
    actualProfit: 0,
    quantities: {},
    skipReward: 0,
    spawned: false,
    resolved: false,
    invalidOutput: false,
    executionFailure: false
  };
  requestSave();
  return {
    episodeId: s,
    cohortId: n.id,
    pairId: n.pairId,
    variant: o,
    modelId: a,
    modelVersion: getModelRecord(t, a).version
  };
}

function updateEpisodeStats(e, r) {
  var t = ensureRoot();
  var n = t.cohorts;
  var o = [];
  if (n.active && n.active.id === e.cohortId) o.push(n.active);
  for (var a = 0; a < n.pending.length; a++) {
    if (n.pending[a].id === e.cohortId) o.push(n.pending[a]);
  }
  for (var i = 0; i < o.length; i++) {
    var s = ensureRoomStats(o[i], e.roomName, e.variant);
    if (r.actual) {
      s.actualProfit += e.actualProfit;
      s.spawnCost += e.spawnCost;
      s.actualNet += e.actualProfit - e.spawnCost;
      s.spawns += e.spawned ? 1 : 0;
      s.skipReward += e.skipReward;
      if (e.quantities) {
        for (var c in e.quantities) {
          s.quantities[c] = (s.quantities[c] || 0) + e.quantities[c];
        }
      }
    }
    if (r.skip) s.skips++;
    if (r.forced) s.forcedSkips++;
    if (r.invalid || e.invalidOutput) s.invalidOutputs++;
    if (r.executionFailure) s.executionFailures++;
  }
  if (e.spawned) {
    var u = o[0];
    if (u && u.unresolvedEpisodes > 0) u.unresolvedEpisodes--;
  }
}

function resolveSkip(e, r, t) {
  var n = ensureRoot();
  var o = n.episodes[e];
  if (!o || o.resolved) return false;
  o.bodySize = 0;
  if (t === undefined) t = !r;
  o.skipReward = r ? -LAMBDA_SKIP * Math.max(0, o.bestPotentialNet) : 0;
  o.resolved = true;
  updateEpisodeStats(o, {
    actual: true,
    skip: true,
    forced: !!t
  });
  delete n.episodes[e];
  requestSave();
  return true;
}

function attachSpawn(e, r, t) {
  var n = ensureRoot();
  var o = n.episodes[e];
  if (!o || o.resolved || o.spawned) return false;
  o.bodySize = r;
  o.spawnCost = Math.max(0, t || 0);
  o.spawned = true;
  var a = n.cohorts.active && n.cohorts.active.id === o.cohortId ? n.cohorts.active : null;
  if (!a) {
    for (var i = 0; i < n.cohorts.pending.length; i++) {
      if (n.cohorts.pending[i].id === o.cohortId) {
        a = n.cohorts.pending[i];
        break;
      }
    }
  }
  if (a) a.unresolvedEpisodes++;
  requestImmediateSave("scavengerLearning.attachSpawn");
  return true;
}

function recordInvalidOutput(e) {
  var r = ensureRoot();
  var t = r.episodes[e];
  if (!t || t.resolved) return false;
  t.invalidOutput = true;
  var n = ensureRoom(r, t.roomName);
  n.diagnostics.invalidOutputs++;
  requestSave();
  return true;
}

function recordExecutionFailure(e) {
  var r = ensureRoot();
  var t = r.episodes[e];
  if (!t || t.resolved) return false;
  t.executionFailure = true;
  t.resolved = true;
  var n = ensureRoom(r, t.roomName);
  n.diagnostics.executionFailures++;
  updateEpisodeStats(t, {
    actual: true,
    executionFailure: true
  });
  delete r.episodes[e];
  requestImmediateSave("scavengerLearning.executionFailure");
  return true;
}

function recordPathFailure(e) {
  var r = ensureRoot();
  var t = ensureRoom(r, e);
  t.diagnostics.pathFailures = (t.diagnostics.pathFailures || 0) + 1;
  requestSave();
  return true;
}

function canonicalPrice(e) {
  var r = typeof RESOURCE_ENERGY !== "undefined" ? RESOURCE_ENERGY : "energy";
  if (e === r) return 1;
  try {
    var t = marketPricing.getPriceProfile(e);
    var n = marketPricing.getStatusEnergyPrice();
    var o = t && t.marketPrice;
    return typeof o === "number" && isFinite(o) && o > 0 && typeof n === "number" && isFinite(n) && n > 0 ? o / n : 0;
  } catch (e) {
    return 0;
  }
}

function recordDeposit(e, r, t) {
  var n = ensureRoot();
  var o = n.episodes[e];
  t = Number(t) || 0;
  if (!o || o.resolved || t <= 0) return 0;
  var a = t * canonicalPrice(r);
  o.actualProfit += a;
  o.quantities[r] = (o.quantities[r] || 0) + t;
  requestImmediateSave("scavengerLearning.recordDeposit");
  return a;
}

function finalizeEpisode(e, r) {
  var t = ensureRoot();
  var n = t.episodes[e];
  if (!n || n.resolved) return false;
  n.completedAt = now();
  n.completionReason = r || "complete";
  n.resolved = true;
  updateEpisodeStats(n, {
    actual: true
  });
  delete t.episodes[e];
  requestSave();
  return true;
}

function finalizeCreepMemory(e, r) {
  if (!e || !e.scavengerPolicy) return false;
  var t = e.scavengerPolicy;
  return finalizeEpisode(t.episodeId, r || "creep-death");
}

function promotionRoomObjective(e) {
  if (!e || !(e.opportunities > 0)) return 0;
  return ((e.actualNet || 0) + (e.skipReward || 0)) / Math.max(1, e.potentialProfit || 0);
}

function collectEvidence(e) {
  var r = e.comparison;
  if (!r.evidence) r.evidence = {
    rooms: {},
    invalidOutputs: 0,
    executionFailures: 0,
    cohorts: 0
  };
  e.cohorts.pending = e.cohorts.pending.filter(function(__c) {
    return __c && __c.pairId === r.pairId;
  });
  for (var t = 0; t < e.cohorts.pending.length; t++) {
    if (e.cohorts.pending[t].unresolvedEpisodes > 0) return false;
  }
  for (var o = 0; o < e.cohorts.pending.length; o++) {
    var a = e.cohorts.pending[o];
    if (a.pairId !== r.pairId) continue;
    r.evidence.cohorts++;
    for (var i in a.rooms) {
      if (!r.evidence.rooms[i]) r.evidence.rooms[i] = {};
      for (var s in a.rooms[i]) {
        if (!r.evidence.rooms[i][s]) r.evidence.rooms[i][s] = emptyStats();
        mergeStats(r.evidence.rooms[i][s], a.rooms[i][s]);
        r.evidence.invalidOutputs += a.rooms[i][s].invalidOutputs || 0;
        r.evidence.executionFailures += a.rooms[i][s].executionFailures || 0;
      }
    }
  }
  e.cohorts.pending = [];
  return true;
}

function evaluateEvidence(e) {
  var r = e.comparison.evidence;
  var t = [];
  var n = 0;
  var o = 0;
  for (var a in r.rooms) {
    var i = r.rooms[a];
    var s = i.incumbent;
    var c = i.challenger;
    if (!s || !c) continue;
    if (s.opportunities < MIN_PER_VARIANT_PER_ROOM || c.opportunities < MIN_PER_VARIANT_PER_ROOM) continue;
    if (!(s.positive > 0 || c.positive > 0)) continue;
    var u = promotionRoomObjective(c) - promotionRoomObjective(s);
    t.push(u);
    n++;
    if (u > 0) o++;
  }
  if (n < MIN_ELIGIBLE_ROOMS_FOR_GLOBAL_UPDATE) return {
    ready: false
  };
  t.sort(function(e, r) {
    return e - r;
  });
  var d = Math.floor(t.length / 2);
  var l = t.length % 2 ? t[d] : (t[d - 1] + t[d]) / 2;
  var v = r.invalidOutputs <= MAX_INVALID_OUTPUTS_FOR_PROMOTION;
  var m = o > n / 2;
  var E = v && m && l > PROMOTION_MARGIN;
  return {
    ready: true,
    passed: E,
    globalDelta: l,
    eligibleRooms: n,
    challengerWins: o,
    invalidOutputs: r.invalidOutputs
  };
}

function createNextChallenger(e, r, t) {
  var n = getModelRecord(e, r);
  if (!n) throw new Error("Cannot mutate missing scavenger model " + r);
  e.mutationSequence++;
  var o = e.nextModelVersion++;
  var a = seedFrom("scavenger-mutation|" + r + "|" + e.comparison.pairId + "|" + e.mutationSequence);
  var i = mutateTensors(decodeTensors(n.tensors), a);
  var s = "scavenger-v" + o + "-challenger";
  e.models[s] = createModelRecord(s, o, r, a, i);
  invalidateModelCache(s);
  return s;
}

function startNewComparison(e, r, t) {
  var n = e.comparison.pairId;
  var o = createNextChallenger(e, r, t);
  e.comparison = {
    pairId: n + 1,
    incumbentId: r,
    challengerId: o,
    evidence: {
      rooms: {},
      invalidOutputs: 0,
      executionFailures: 0,
      cohorts: 0
    },
    confirmationCount: 0
  };
  e.lastGood = r;
  e.cohorts.pending = [];
  for (var a in e.rooms) e.rooms[a].assignment = null;
  requestImmediateSave("scavengerLearning." + (t || "new-comparison"));
}

function processEvidenceAtBoundary(e) {
  if (!e.cohorts.pending.length) return;
  if (!collectEvidence(e)) return;
  var r = evaluateEvidence(e);
  if (!r.ready) return;
  if (!r.passed) {
    startNewComparison(e, e.comparison.incumbentId, "evidence-failed");
    return;
  }
  e.comparison.confirmationCount++;
  e.comparison.evidence = {
    rooms: {},
    invalidOutputs: 0,
    executionFailures: 0,
    cohorts: 0
  };
  if (e.comparison.confirmationCount >= PROMOTION_CONFIRMATION_BLOCKS) {
    var t = e.comparison.challengerId;
    startNewComparison(e, t, "challenger-promoted");
  }
}

function pruneModels(e) {
  var r = {};
  r[e.comparison.incumbentId] = true;
  r[e.comparison.challengerId] = true;
  r[e.lastGood] = true;
  for (var t in e.episodes) {
    var n = e.episodes[t];
    if (n && n.modelId) r[n.modelId] = true;
  }
  if (typeof Game !== "undefined" && Game.creeps) {
    for (var o in Game.creeps) {
      var a = Game.creeps[o] && Game.creeps[o].memory;
      if (a && a.scavengerPolicy && a.scavengerPolicy.modelId) {
        r[a.scavengerPolicy.modelId] = true;
      }
    }
  }
  if (typeof Memory !== "undefined" && Memory.creeps) {
    for (var i in Memory.creeps) {
      var s = Memory.creeps[i];
      if (s && s.scavengerPolicy && s.scavengerPolicy.modelId) {
        r[s.scavengerPolicy.modelId] = true;
      }
    }
  }
  for (var c in e.models) {
    if (!r[c]) {
      delete e.models[c];
      invalidateModelCache(c);
    }
  }
}

function closeActiveCohort(e) {
  var r = e.cohorts.active;
  if (!r || r.opportunities < BATCH_OPPORTUNITIES) return false;
  r.closed = true;
  e.cohorts.pending.push(r);
  e.lastAppliedCohort = r.id;
  e.cohorts.active = null;
  processEvidenceAtBoundary(e);
  ensureActiveCohort(e);
  requestSave();
  return true;
}

function pruneRoomStates(e, r) {
  var t = e.comparison.pairId;
  var __live = {};
  for (var __eid in e.episodes) {
    var __ep = e.episodes[__eid];
    if (__ep && !__ep.resolved && __ep.roomName) __live[__ep.roomName] = true;
  }
  var __removed = 0;
  for (var __rn in e.rooms) {
    var __room = e.rooms[__rn];
    if (!__room) {
      delete e.rooms[__rn];
      __removed++;
      continue;
    }
    if (__room.assignment && __room.assignment.pairId === t) continue;
    if (__live[__rn]) continue;
    var __touched = __room.t || (__room.siteState && __room.siteState.observedAt) || 0;
    if (r - __touched < ROOM_STATE_TTL) continue;
    delete e.rooms[__rn];
    __removed++;
  }
  return __removed;
}

function maintenance() {
  var e = ensureRoot();
  var r = now();
  for (var t in e.episodes) {
    var n = e.episodes[t];
    if (!n || n.resolved) continue;
    if (r - n.startedAt < MAX_EPISODE_TICKS) continue;
    if (n.spawned) finalizeEpisode(t, "timeout"); else recordExecutionFailure(t);
  }
  closeActiveCohort(e);
  ensureActiveCohort(e);
  pruneModels(e);
  pruneRoomStates(e, r);
  if (e.cohorts.pending.length > MAX_PENDING_COHORTS) {
    e.cohorts.pending = e.cohorts.pending.slice(-MAX_PENDING_COHORTS);
  }
  requestSave();
  return e;
}

function getCurrentPair() {
  return ensureRoot().comparison;
}

function getModelForVariant(e) {
  var r = ensureRoot();
  return getDecodedModel(modelIdForVariant(r, e));
}

function getModel(e) {
  return getDecodedModel(e);
}

function getModelRecordById(e) {
  return getModelRecord(ensureRoot(), e);
}

function getConfig() {
  return {
    datasetId: DATASET_ID,
    dataVersion: DATASET_VERSION,
    architectureVersion: ARCHITECTURE_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    quantization: QUANTIZATION,
    maxBodySize: MAX_BODY_SIZE,
    maxBodyParts: MAX_BODY_PARTS,
    bodyPartCost: BODY_PART_COST,
    contextSize: CONTEXT_SIZE,
    bodyActionSize: BODY_ACTION_SIZE,
    candidateSize: CANDIDATE_SIZE,
    contextHiddenSize: CONTEXT_HIDDEN_SIZE,
    actionHiddenSize: ACTION_HIDDEN_SIZE,
    resourceVocabulary: RESOURCE_VOCABULARY.slice(),
    resourceIndex: Object.assign({}, RESOURCE_INDEX),
    unknownResource: RESOURCE_UNKNOWN,
    batchOpportunities: BATCH_OPPORTUNITIES,
    minPerVariantPerRoom: MIN_PER_VARIANT_PER_ROOM,
    minEligibleRooms: MIN_ELIGIBLE_ROOMS_FOR_GLOBAL_UPDATE,
    promotionConfirmationBlocks: PROMOTION_CONFIRMATION_BLOCKS,
    promotionMargin: PROMOTION_MARGIN,
    lambdaSkip: LAMBDA_SKIP,
    mutationRate: MUTATION_RATE,
    mutationStddev: MUTATION_STDDEV,
    maxWeightAbs: MAX_WEIGHT_ABS
  };
}

module.exports = {
  DATASET_ID: DATASET_ID,
  DATASET_VERSION: DATASET_VERSION,
  ARCHITECTURE_VERSION: ARCHITECTURE_VERSION,
  FEATURE_SCHEMA_VERSION: FEATURE_SCHEMA_VERSION,
  MAX_BODY_SIZE: MAX_BODY_SIZE,
  BODY_PART_COST: BODY_PART_COST,
  CONTEXT_SIZE: CONTEXT_SIZE,
  BODY_ACTION_SIZE: BODY_ACTION_SIZE,
  CANDIDATE_SIZE: CANDIDATE_SIZE,
  RESOURCE_VOCABULARY: RESOURCE_VOCABULARY,
  RESOURCE_INDEX: RESOURCE_INDEX,
  RESOURCE_VECTOR_SIZE: RESOURCE_VECTOR_SIZE,
  RESOURCE_UNKNOWN: RESOURCE_UNKNOWN,
  getConfig: getConfig,
  getCurrentPair: getCurrentPair,
  getModelForVariant: getModelForVariant,
  getModel: getModel,
  getModelRecord: getModelRecordById,
  encodeContext: encodeContext,
  scoreAction: scoreAction,
  scoreCandidate: scoreCandidate,
  shouldEvaluateState: shouldEvaluateState,
  markObservedState: markObservedState,
  recordNonControllable: recordNonControllable,
  chooseVariant: function(e) {
    return chooseVariant(ensureRoot(), e);
  },
  startOpportunity: startOpportunity,
  resolveSkip: resolveSkip,
  attachSpawn: attachSpawn,
  recordInvalidOutput: recordInvalidOutput,
  recordExecutionFailure: recordExecutionFailure,
  recordPathFailure: recordPathFailure,
  recordDeposit: recordDeposit,
  finalizeEpisode: finalizeEpisode,
  finalizeCreepMemory: finalizeCreepMemory,
  maintenance: maintenance,
  ensureRoot: ensureRoot,
  encodeTensor: encodeTensor,
  decodeTensor: decodeTensor,
  encodeTensors: encodeTensors,
  decodeTensors: decodeTensors,
  createRandomTensors: createRandomTensors,
  mutateTensors: mutateTensors,
  canonicalPrice: canonicalPrice,
  emptyStats: emptyStats,
  promotionRoomObjective: promotionRoomObjective
};
