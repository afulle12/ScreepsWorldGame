// LLM: Read docs/codex.js before reviewing or changing this file.
// test/spawn_repairer_harness.js
// Focused regression coverage for queued repairer request retention.

const assert = require('assert');
const Module = require('module');
global.OK = 0;
global.ERR_BUSY = -4;
global.ERR_NOT_ENOUGH_ENERGY = -6;
global.STRUCTURE_SPAWN = 'spawn';
global.RESOURCE_ENERGY = 'energy';
global.WORK = 'work';
global.CARRY = 'carry';
global.MOVE = 'move';
global.TOUGH = 'tough';
global.ATTACK = 'attack';
global.RANGED_ATTACK = 'ranged_attack';
global.HEAL = 'heal';
global.CLAIM = 'claim';
const bodyPartCosts = {};
bodyPartCosts[WORK] = 100;
bodyPartCosts[CARRY] = 50;
bodyPartCosts[MOVE] = 50;
const util = {
  bodyCost: function (body) {
    return body.reduce(function (sum, part) {
      return sum + (bodyPartCosts[part] || 0);
    }, 0);
  },
};
let state;
const roomState = {
  get: function () {
    return state;
  },
  creepIndex: function () {
    return { all: [] };
  },
};
const stubs = {
  getRoomState: roomState,
  roleTowerDrain: {},
  roleDrainDemolisher: {},
  singleSourceRoom: {},
  roomSuspender: {
    shouldAvoidRoomWork: function () {
      return false;
    },
  },
  util: util,
  roleScavenger: {
    SCAVENGER_POLICY_VERSION: 1,
    SCAVENGER_DENIED_SLEEP_TICKS: 10,
  },
  scavengerPolicy: {
    canEvaluate: function () {
      return false;
    },
  },
  scavengerLearning: {},
  memoryManager: {
    storage: { register: function () {} },
    requestImmediateSave: function (reason) {
      immediateSaveReasons.push(reason);
    },
  },
  repairManager: {
    shouldAttemptRepairerSpawn: function (roomName) {
      var hash = 0;
      for (var i = 0; i < roomName.length; i++) hash = (hash * 31 + roomName.charCodeAt(i)) >>> 0;
      return Game.time % 10 === hash % 10;
    },
  },
};
const originalLoad = Module._load;
const immediateSaveReasons = [];
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return originalLoad(request, parent, isMain);
};
global.Memory = {};
global.Game = { time: 1101, rooms: {} };
const spawnManager = require('../spawnManager');
const room = {
  name: 'E9N49',
  controller: { my: true },
  energyAvailable: 0,
  storage: null,
};
Game.rooms.E9N49 = room;

function makeRequest() {
  return {
    kind: 'extra',
    priority: 7,
    maxHeal: 1,
    at: 1000,
    ct: 1000,
    b: { work: 1, carry: 1, move: 1 },
    cost: 200,
  };
}

let lastSpawnCall = null;
function setSpawn(spawning, spawnResult) {
  const spawn = {
    my: true,
    spawning: spawning,
    room: room,
    spawnCreep: function (body, name, options) {
      lastSpawnCall = { body: body, name: name, options: options };
      return spawnResult;
    },
  };
  state = { structuresByType: {} };
  state.structuresByType[STRUCTURE_SPAWN] = [spawn];
}

Memory.repairSpawnRequests = { E9N49: [makeRequest()] };
setSpawn({ name: 'OtherCreep' }, OK);
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);

setSpawn(null, OK);
room.energyAvailable = 100;
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);

room.energyAvailable = 200;
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);
assert.strictEqual(Memory.repairSpawnLastTick.E9N49, Game.time);
assert.strictEqual(immediateSaveReasons.length, 1);
assert.strictEqual(immediateSaveReasons[0], 'spawnManager.spawnCreep');
assert.strictEqual(lastSpawnCall.options.memory.role, 'repairer');

Game.time += 10;
Memory.repairSpawnRequests = { E9N49: [makeRequest()] };
Memory.repairSpawnRequests.E9N49[0].ct = Game.time;
setSpawn(null, ERR_BUSY);
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
assert.strictEqual(immediateSaveReasons.length, 1);

Game.time += 10;
Memory.repairSpawnRequests = { E9N49: [makeRequest()] };
Memory.repairSpawnRequests.E9N49[0].ct = Game.time;
setSpawn(null, OK);
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);
assert.strictEqual(immediateSaveReasons.length, 2);

Game.time += 10;
Memory.repairSpawnRequests = { E9N49: [makeRequest(), makeRequest()] };
setSpawn(null, OK);
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);

setSpawn(null, OK);
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);

Game.time += 10;
setSpawn(null, OK);
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);

// blockedReason is diagnostic only. A reason left over from an earlier attempt
// must not outlive the tick that set it, or repairDispatch reports a gate that
// is no longer rejecting anything.
Game.time += 10;
Memory.repairSpawnRequests = { E9N49: [makeRequest()] };
Memory.repairSpawnRequests.E9N49[0].blockedReason = 'stale from an earlier tick';
setSpawn(null, OK);
room.energyAvailable = 100;
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].blockedReason, 'need 200 energy');

setSpawn({ name: 'OtherCreep' }, OK);
room.energyAvailable = 200;
spawnManager.manageRepairerSpawns();
assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].blockedReason, undefined);

Module._load = originalLoad;
console.log('Spawn repairer harness complete.');
