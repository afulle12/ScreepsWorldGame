// LLM: Read docs/codex.js before reviewing or changing this file.
// test/scavenger_neural_harness.js
// Focused tests for neural scavenger policy and learning primitives.

const assert = require('assert');
const Module = require('module');
global.OK = 0;
global.ERR_BUSY = -4;
global.ERR_NOT_ENOUGH_ENERGY = -6;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_NO_PATH = -2;
global.ERR_NOT_ENOUGH_RESOURCES = -6;
global.ERR_INVALID_TARGET = -7;
global.ERR_FULL = -8;
global.MOVE = 'move';
global.CARRY = 'carry';
global.RESOURCE_ENERGY = 'energy';
global.FIND_MY_SPAWNS = 'mySpawns';
global.FIND_DROPPED_RESOURCES = 'drops';
global.FIND_TOMBSTONES = 'tombstones';
global.FIND_RUINS = 'ruins';
global.FIND_HOSTILE_CREEPS = 'hostiles';
global.FIND_MY_CREEPS = 'myCreeps';
global.BODYPART_COST = { move: 50, carry: 50 };
global.CREEP_SPAWN_TIME = 3;
global.ENERGY_DECAY = 1000;
global.RESOURCES_ALL = ['energy', 'power', 'ops', 'H', 'O', 'U', 'X', 'battery'];
const persisted = {};
const storage = {
  register: function () {},
  get: function (id) {
    return persisted[id];
  },
  set: function (id, value) {
    persisted[id] = value;
    return value;
  },
};
const memoryManager = {
  storage: storage,
  heap: {},
  requestSave: function () {},
  requestImmediateSave: function () {},
};
let energyMarketPrice = 1;
const marketPricing = {
  getStatusEnergyPrice: function () {
    return energyMarketPrice;
  },
  getPriceProfile: function (resource) {
    return {
      marketPrice: resource === 'energy' ? energyMarketPrice : resource === 'U' ? 2 : 0,
      bestBid: resource === 'U' ? 1.9 : 1,
      bidVolume: 10000,
      askVolume: 10000,
      spreadRatio: 0.05,
      confidence: 'high',
    };
  },
};
const roomState = {
  get: function () {
    return null;
  },
};
const stubs = {
  memoryManager: memoryManager,
  marketPricing: marketPricing,
  getRoomState: roomState,
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return originalLoad(request, parent, isMain);
};
global.Game = {
  time: 1000,
  rooms: {},
  creeps: {},
  spawns: {},
  cpu: {
    bucket: 10000,
    limit: 20,
    getUsed: function () {
      return 1;
    },
  },
};
global.Memory = {};
global.PathFinder = {
  search: function (from, target) {
    const distance = Math.max(Math.abs(from.x - target.pos.x), Math.abs(from.y - target.pos.y));
    return {
      incomplete: false,
      path: Array.from({ length: Math.max(0, distance - 1) }, function () {
        return { roomName: from.roomName, x: from.x, y: from.y };
      }),
    };
  },
};
const learning = require('../scavengerLearning');
const policy = require('../scavengerPolicy');
function makeStore(initial, capacity) {
  const store = Object.assign({}, initial || {});
  store.getUsedCapacity = function (resource) {
    if (resource) return store[resource] || 0;
    return Object.keys(store).reduce(function (sum, key) {
      return sum + (typeof store[key] === 'number' ? store[key] : 0);
    }, 0);
  };
  store.getFreeCapacity = function (resource) {
    return Math.max(0, capacity - (resource ? store[resource] || 0 : store.getUsedCapacity()));
  };
  return store;
}

const storageObject = {
  id: 'storage1',
  pos: { roomName: 'W1N1', x: 25, y: 25 },
  store: makeStore({}, 100000),
};
let spawnCalls = 0;
const spawn = {
  id: 'spawn1',
  my: true,
  spawning: null,
  pos: { roomName: 'W1N1', x: 25, y: 24 },
  room: null,
  spawnCreep: function () {
    spawnCalls++;
    return OK;
  },
};
const drop = {
  id: 'drop1',
  amount: 1000,
  resourceType: 'energy',
  pos: { roomName: 'W1N1', x: 40, y: 40 },
  decayTime: 3000,
};
const ruin = {
  id: 'ruin1',
  pos: { roomName: 'W1N1', x: 38, y: 38 },
  ticksToDecay: 100,
  store: makeStore({ U: 200, energy: 100 }, 1000),
};
const room = {
  name: 'W1N1',
  controller: { my: true, level: 8 },
  storage: storageObject,
  energyAvailable: 1000,
  energyCapacityAvailable: 1000,
  find: function (type) {
    if (type === FIND_MY_SPAWNS) return [spawn];
    if (type === FIND_DROPPED_RESOURCES) return [drop];
    if (type === FIND_RUINS) return [ruin];
    if (type === FIND_MY_CREEPS) return [];
    if (type === FIND_TOMBSTONES || type === FIND_HOSTILE_CREEPS) return [];
    return [];
  },
};
spawn.room = room;
Game.rooms.W1N1 = room;
const config = learning.getConfig();
assert.strictEqual(config.maxBodySize, 6);
assert.strictEqual(config.bodyActionSize, 8);
assert.ok(config.candidateSize > config.resourceVocabulary.length * 2);
energyMarketPrice = 2;
assert.strictEqual(learning.canonicalPrice('energy'), 1);
assert.strictEqual(learning.canonicalPrice('U'), 1);
energyMarketPrice = 1;
const tensors = learning.createRandomTensors(12345, 0.05);
const encoded = learning.encodeTensors(tensors);
const decoded = learning.decodeTensors(encoded);
assert.strictEqual(decoded.length, tensors.length);
assert.strictEqual(decoded[0].length, tensors[0].length);
assert.ok(Math.abs(decoded[0][0] - tensors[0][0]) < 1 / config.quantization + 0.001);
let decision = policy.getSpawnDecision(room);
assert.strictEqual(decision.eligible, true);
assert.strictEqual(decision.controllable, true);
// 1500 of loot discounts to 525, which cannot pay for a 600-energy size 6
// body, so the profitability guard keeps that size off the menu entirely.
assert.deepStrictEqual(decision.legalSizes, [1, 2, 3, 4, 5]);
decision.legalSizes.forEach(function (size) {
  const estimate = decision.estimates[size];
  assert.ok(estimate.potentialNet > 0);
  assert.strictEqual(estimate.potentialNet, estimate.expectedProfit - estimate.spawnCost);
});
assert.ok(decision.candidates.length >= 3);
const model = learning.getModelForVariant('incumbent');
const action = policy.chooseBody(decision, model);
assert.ok(action.bodySize >= 0 && action.bodySize <= 6);
assert.strictEqual(
  learning.shouldEvaluateState(room.name, decision.lootFingerprint, decision.contextFingerprint),
  true
);
learning.markObservedState(room.name, decision.lootFingerprint, decision.contextFingerprint, true);
assert.strictEqual(
  learning.shouldEvaluateState(room.name, decision.lootFingerprint, decision.contextFingerprint),
  false
);
drop.amount -= 100;
const changed = policy.getSpawnDecision(room);
assert.strictEqual(
  learning.shouldEvaluateState(room.name, changed.lootFingerprint, changed.contextFingerprint),
  true
);
room.energyAvailable = 0;
const uncontrollable = policy.getSpawnDecision(room);
assert.strictEqual(uncontrollable.controllable, false);
room.energyAvailable = 1000;
assert.strictEqual(learning.canonicalPrice('missing-resource'), 0);
Game.cpu.bucket = 999;
assert.strictEqual(policy.getSpawnDecision(room).controllable, false);
Game.cpu.bucket = 10000;
const originalPathSearch = PathFinder.search;
PathFinder.search = function () {
  throw new Error('pathfinder unavailable');
};
Game.time++;
assert.strictEqual(policy.getSpawnDecision(room).controllable, false);
PathFinder.search = originalPathSearch;
Game.time++;
const opportunity = learning.startOpportunity(room.name, {
  fingerprint: changed.lootFingerprint,
  potentialProfit: 1000,
  bestPotentialNet: 700,
});
assert.ok(opportunity.episodeId);
learning.attachSpawn(opportunity.episodeId, 2, 200);
learning.recordDeposit(opportunity.episodeId, 'energy', 100);
assert.strictEqual(learning.finalizeEpisode(opportunity.episodeId, 'test'), true);
assert.strictEqual(learning.finalizeEpisode(opportunity.episodeId, 'duplicate'), false);
const persistedRoot = learning.ensureRoot();
const episodeStats = persistedRoot.cohorts.active.rooms[room.name][opportunity.variant];
assert.strictEqual(episodeStats.spawns, 1);
assert.strictEqual(episodeStats.actualProfit, 100);
assert.strictEqual(episodeStats.spawnCost, 200);
assert.strictEqual(episodeStats.actualNet, -100);
Module._load = originalLoad;
Object.assign(global, {
  WORK: 'work',
  TOUGH: 'tough',
  ATTACK: 'attack',
  RANGED_ATTACK: 'ranged_attack',
  HEAL: 'heal',
  CLAIM: 'claim',
  STRUCTURE_SPAWN: 'spawn',
});
const spawnManagerStubs = {
  getRoomState: {
    get: function () {
      return null;
    },
    creepIndex: function () {
      return { all: [] };
    },
  },
  roleTowerDrain: {},
  roleDrainDemolisher: {},
  singleSourceRoom: {},
  roomSuspender: {
    shouldAvoidRoomWork: function () {
      return false;
    },
  },
  util: {
    bodyCost: function (body) {
      return body.length * 50;
    },
  },
  roleScavenger: { SCAVENGER_POLICY_VERSION: 1, SCAVENGER_DENIED_SLEEP_TICKS: 10 },
  scavengerPolicy: policy,
  scavengerLearning: learning,
  memoryManager: {
    storage: { register: function () {} },
    requestImmediateSave: function () {},
  },
};
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(spawnManagerStubs, request)) {
    return spawnManagerStubs[request];
  }
  return originalLoad(request, parent, isMain);
};
global.Buffer = undefined;
const spawnManager = require('../spawnManager');
const opportunitiesBefore = learning.ensureRoot().cohorts.active.opportunities;
spawnManager.manageScavengerSpawns();
// Body choice is no longer pinned to the largest legal size, so assert the
// pipeline recorded exactly one decision rather than assuming it spawns.
assert.strictEqual(learning.ensureRoot().cohorts.active.opportunities, opportunitiesBefore + 1);
assert.ok(spawnCalls <= 1);
Module._load = originalLoad;
console.log('Scavenger neural harness complete.');
