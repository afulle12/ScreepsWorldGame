// LLM: Read docs/codex.js before reviewing or changing this file.
// test/scavenger_deposit_harness.js
// Regression coverage for delayed Screeps transfer-store updates.

const assert = require('assert');
const Module = require('module');
global.OK = 0;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_FULL = -8;
global.ERR_NOT_ENOUGH_RESOURCES = -6;
global.ERR_INVALID_TARGET = -7;
global.ERR_NO_PATH = -2;
global.MOVE = 'move';
global.CARRY = 'carry';
global.RESOURCE_ENERGY = 'energy';
global.ENERGY_DECAY = 1000;
global.CREEP_SPAWN_TIME = 3;
const deposits = [];
let pathFailures = 0;
const stubs = {
  getRoomState: {},
  marketPricing: {},
  economics: {
    value: function (resource, amount) {
      return resource === 'energy' ? amount : 0;
    },
    record: function () {},
  },
  util: {
    isOnRoomEdge: function () {
      return false;
    },
    nudgeOffRoomEdge: function () {
      return false;
    },
  },
  scavengerPolicy: {
    canonicalPrice: function () {
      return 1;
    },
    getPickupDecision: function () {
      return { valid: true, candidate: null };
    },
  },
  scavengerLearning: {
    DATASET_VERSION: 3,
    ARCHITECTURE_VERSION: 1,
    FEATURE_SCHEMA_VERSION: 1,
    recordDeposit: function (episodeId, resourceType, amount) {
      deposits.push({ episodeId: episodeId, resourceType: resourceType, amount: amount });
    },
    recordInvalidOutput: function () {},
    recordPathFailure: function () {
      pathFailures++;
    },
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad(request, parent, isMain);
};
function makeStore(amount) {
  const store = { energy: amount };
  store.getUsedCapacity = function () {
    return store.energy || 0;
  };
  store.getFreeCapacity = function () {
    return Math.max(0, 100 - store.getUsedCapacity());
  };
  return store;
}

global.Game = {
  time: 1,
  rooms: {},
  creeps: {},
  getObjectById: function () {
    return null;
  },
};
global.Memory = {};
const roleScavenger = require('../roleScavenger');
const storage = {
  pos: { roomName: 'W1N1', x: 25, y: 25 },
  store: {
    getFreeCapacity: function () {
      return 1000;
    },
  },
};
const room = {
  name: 'W1N1',
  controller: { my: true, level: 8 },
  storage: storage,
};
const creep = {
  name: 'Scavenger_test',
  room: room,
  pos: { roomName: 'W1N1', x: 25, y: 25 },
  memory: {
    role: 'scavenger',
    scavengerPolicy: {
      learningEligible: true,
      policyVersion: 3,
      architectureVersion: 1,
      featureSchemaVersion: 1,
      episodeId: 'episode-1',
    },
  },
  store: makeStore(100),
  transfer: function () {
    return OK;
  },
  suicide: function () {},
};
creep.memory.blockedTargets = { stale: true };
roleScavenger.runNeural(creep);
assert.strictEqual(deposits.length, 0);
assert.ok(creep.memory.scavengerPolicy.pendingDeposit);
assert.strictEqual(creep.memory.blockedTargets, undefined);
Game.time = 2;
creep.store.energy = 20;
roleScavenger.runNeural(creep);
assert.strictEqual(deposits.length, 1);
assert.deepStrictEqual(deposits[0], {
  episodeId: 'episode-1',
  resourceType: 'energy',
  amount: 80,
});
// A blocked path shelves the target and leaves the creep alive to re-decide,
// rather than suiciding a fully paid creep on the first failed step.
let suicided = false;
const loot = {
  id: 'drop1',
  amount: 500,
  resourceType: 'energy',
  pos: { roomName: 'W1N1', x: 40, y: 40 },
};
const stranded = {
  name: 'Scavenger_stranded',
  room: room,
  pos: { roomName: 'W1N1', x: 25, y: 25 },
  memory: {
    role: 'scavenger',
    homeRoom: 'W1N1',
    scavengerPolicy: {
      learningEligible: true,
      policyVersion: 3,
      architectureVersion: 1,
      featureSchemaVersion: 1,
      episodeId: 'episode-2',
    },
  },
  store: makeStore(0),
  moveTo: function () {
    return ERR_NO_PATH;
  },
  suicide: function () {
    suicided = true;
  },
};
stubs.scavengerPolicy.getPickupDecision = function () {
  return {
    valid: true,
    candidate: { object: loot, objectId: loot.id, resourceType: 'energy' },
  };
};

roleScavenger.runNeural(stranded);
assert.strictEqual(suicided, false);
assert.strictEqual(pathFailures, 1);
assert.strictEqual(stranded.memory.blockedTargets.drop1, true);
assert.strictEqual(stranded.memory.targetId, undefined);
assert.strictEqual(stranded.memory.targetResource, undefined);

// Chaining: a partially loaded creep keeps collecting instead of banking after
// every single pickup. It re-asks the policy each time capacity remains, so one
// trip can drain several drops or several commodities from one tombstone.
function makeChainCreep(carried, pos) {
  return {
    name: 'Scavenger_chain',
    room: room,
    pos: pos || { roomName: 'W1N1', x: 40, y: 40 },
    memory: {
      role: 'scavenger',
      homeRoom: 'W1N1',
      scavengerPolicy: {
        learningEligible: true,
        policyVersion: 3,
        architectureVersion: 1,
        featureSchemaVersion: 1,
        episodeId: 'episode-chain',
      },
    },
    store: makeStore(carried),
    transferred: false,
    movedTo: null,
    pickedUp: null,
    pickup: function (target) {
      this.pickedUp = target;
      return OK;
    },
    transfer: function () {
      this.transferred = true;
      return OK;
    },
    moveTo: function (target) {
      this.movedTo = target;
      return OK;
    },
    suicide: function () {},
  };
}

const nearLoot = {
  id: 'drop_near',
  amount: 500,
  resourceType: 'energy',
  pos: { roomName: 'W1N1', x: 41, y: 40 },
};
stubs.scavengerPolicy.getPickupDecision = function () {
  return {
    valid: true,
    candidate: { object: nearLoot, objectId: nearLoot.id, resourceType: 'energy' },
  };
};

// Half full and standing next to loot: pick up again, do not head for storage.
const chaining = makeChainCreep(50);
roleScavenger.runNeural(chaining);
assert.strictEqual(chaining.pickedUp, nearLoot);
assert.strictEqual(chaining.transferred, false);
assert.strictEqual(chaining.movedTo, null);
assert.strictEqual(chaining.memory.targetId, undefined);

// Half full with loot across the room: travel to the loot, not to storage.
const farLoot = {
  id: 'drop_far',
  amount: 500,
  resourceType: 'energy',
  pos: { roomName: 'W1N1', x: 10, y: 10 },
};
stubs.scavengerPolicy.getPickupDecision = function () {
  return {
    valid: true,
    candidate: { object: farLoot, objectId: farLoot.id, resourceType: 'energy' },
  };
};
const travelling = makeChainCreep(50);
roleScavenger.runNeural(travelling);
assert.strictEqual(travelling.movedTo, farLoot);
assert.strictEqual(travelling.transferred, false);
assert.strictEqual(travelling.pickedUp, null);

// Full creep ignores reachable loot and banks instead.
const full = makeChainCreep(100, { roomName: 'W1N1', x: 25, y: 25 });
roleScavenger.runNeural(full);
assert.strictEqual(full.transferred, true);
assert.strictEqual(full.pickedUp, null);

// Loaded creep with nothing left worth taking banks rather than retiring.
stubs.scavengerPolicy.getPickupDecision = function () {
  return { valid: true, candidate: null };
};
let chainSuicided = false;
const stuck = makeChainCreep(50, { roomName: 'W1N1', x: 25, y: 25 });
stuck.suicide = function () {
  chainSuicided = true;
};
Game.time += 100;
roleScavenger.runNeural(stuck);
assert.strictEqual(chainSuicided, false);
assert.strictEqual(stuck.transferred, true);

// A tick where the policy cannot decide (CPU gate shut, stale model) is not the
// same as a picked-clean room: the trip stays open instead of banking 17/200.
let lootPresent = true;
stubs.scavengerPolicy.roomHasLoot = function () {
  return lootPresent;
};
stubs.scavengerPolicy.getPickupDecision = function () {
  return { valid: true, candidate: null, reason: 'cpu' };
};
let stalledSuicided = false;
const stalled = makeChainCreep(50, { roomName: 'W1N1', x: 25, y: 25 });
stalled.suicide = function () {
  stalledSuicided = true;
};
Game.time = 1000;
roleScavenger.runNeural(stalled);
assert.strictEqual(stalled.memory.stallSince, 1000);
assert.strictEqual(stalled.transferred, false);
assert.strictEqual(stalledSuicided, false);
Game.time = 1019;
roleScavenger.runNeural(stalled);
assert.strictEqual(stalled.transferred, false);
// Once the stall window expires the load is banked rather than carried to death.
Game.time = 1020;
roleScavenger.runNeural(stalled);
assert.strictEqual(stalled.transferred, true);
assert.strictEqual(stalledSuicided, false);

// Empty creep, policy silent, loot still on the floor: wait, do not retire.
stubs.scavengerPolicy.getPickupDecision = function () {
  return { valid: true, candidate: null, reason: 'no-legal' };
};
lootPresent = true;
let idleSuicided = false;
const idle = makeChainCreep(0, { roomName: 'W1N1', x: 25, y: 25 });
idle.suicide = function () {
  idleSuicided = true;
};
Game.time = 2000;
roleScavenger.runNeural(idle);
assert.strictEqual(idle.memory.noTargetSince, 2000);
Game.time = 2010;
roleScavenger.runNeural(idle);
assert.strictEqual(idleSuicided, false);
Game.time = 2050;
roleScavenger.runNeural(idle);
assert.strictEqual(idleSuicided, true);

// Room actually picked clean: retire promptly, as before.
lootPresent = false;
let doneSuicided = false;
const done = makeChainCreep(0, { roomName: 'W1N1', x: 25, y: 25 });
done.suicide = function () {
  doneSuicided = true;
};
Game.time = 3000;
roleScavenger.runNeural(done);
assert.strictEqual(doneSuicided, false);
Game.time = 3005;
roleScavenger.runNeural(done);
assert.strictEqual(doneSuicided, true);

// Every sink full: hold the cargo. Dying here would drop banked loot back on the
// floor as a decaying tombstone.
const fullStorage = {
  pos: { roomName: 'W1N1', x: 25, y: 25 },
  store: {
    getFreeCapacity: function () {
      return 0;
    },
  },
};
const fullRoom = {
  name: 'W1N1',
  controller: { my: true, level: 8 },
  storage: fullStorage,
  terminal: null,
};
let blockedSuicided = false;
const blocked = makeChainCreep(50, { roomName: 'W1N1', x: 25, y: 25 });
blocked.room = fullRoom;
blocked.suicide = function () {
  blockedSuicided = true;
};
Game.time = 4000;
roleScavenger.runNeural(blocked);
assert.strictEqual(blocked.memory.depositBlockedSince, 4000);
Game.time = 4100;
roleScavenger.runNeural(blocked);
assert.strictEqual(blockedSuicided, false);
assert.strictEqual(blocked.transferred, false);

// Terminal absorbs the load when storage cannot.
const terminal = {
  my: true,
  pos: { roomName: 'W1N1', x: 26, y: 25 },
  store: {
    getFreeCapacity: function () {
      return 5000;
    },
  },
};
const overflowRoom = {
  name: 'W1N1',
  controller: { my: true, level: 8 },
  storage: fullStorage,
  terminal: terminal,
};
const overflow = makeChainCreep(50, { roomName: 'W1N1', x: 25, y: 25 });
overflow.room = overflowRoom;
overflow.transferTarget = null;
overflow.transfer = function (target) {
  overflow.transferTarget = target;
  return OK;
};
Game.time = 5000;
roleScavenger.runNeural(overflow);
assert.strictEqual(overflow.transferTarget, terminal);

// Schema version moving under a live creep banks the cargo first, then retires.
let staleSuicided = false;
const stale = makeChainCreep(50, { roomName: 'W1N1', x: 25, y: 25 });
stale.memory.scavengerPolicy.policyVersion = 1;
stale.suicide = function () {
  staleSuicided = true;
};
Game.time = 6000;
roleScavenger.run(stale);
assert.strictEqual(staleSuicided, false);
assert.strictEqual(stale.transferred, true);
assert.strictEqual(stale.memory.retire, true);
stale.store.energy = 0;
Game.time = 6001;
roleScavenger.run(stale);
assert.strictEqual(staleSuicided, true);

Module._load = originalLoad;
console.log('Scavenger deposit harness complete.');
