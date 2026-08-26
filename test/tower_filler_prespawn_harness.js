// LLM: Read docs/codex.js before reviewing or changing this file.
// test/tower_filler_prespawn_harness.js
// Focused coverage for tower-filler prespawn timing and supplier coverage.

const assert = require('assert');
const Module = require('module');

global.OK = 0;
global.ERR_BUSY = -4;
global.ERR_NOT_ENOUGH_ENERGY = -6;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_NOT_ENOUGH_RESOURCES = -6;
global.ERR_FULL = -8;
global.ERR_TIRED = -11;
global.ERR_NO_PATH = -2;
global.ERR_INVALID_TARGET = -7;

global.WORK = 'work';
global.CARRY = 'carry';
global.MOVE = 'move';
global.TOUGH = 'tough';
global.ATTACK = 'attack';
global.RANGED_ATTACK = 'ranged_attack';
global.HEAL = 'heal';
global.CLAIM = 'claim';
global.RESOURCE_ENERGY = 'energy';
global.RESOURCE_POWER = 'power';

global.STRUCTURE_CONTAINER = 'container';
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_EXTRACTOR = 'extractor';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_LINK = 'link';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_LAB = 'lab';
global.STRUCTURE_POWER_SPAWN = 'powerSpawn';
global.STRUCTURE_NUKER = 'nuker';
global.STRUCTURE_FACTORY = 'factory';
global.STRUCTURE_TERMINAL = 'terminal';
global.STRUCTURE_STORAGE = 'storage';
global.STRUCTURE_ROAD = 'road';
global.STRUCTURE_RAMPART = 'rampart';
global.STRUCTURE_WALL = 'constructedWall';
global.FIND_STRUCTURES = 'structures';
global.FIND_HOSTILE_CREEPS = 'hostileCreeps';
global.OBSTACLE_OBJECT_TYPES = [];
global.TERRAIN_MASK_WALL = 1;
global.CREEP_SPAWN_TIME = 3;

const bodyPartCosts = {};
bodyPartCosts[WORK] = 100;
bodyPartCosts[CARRY] = 50;
bodyPartCosts[MOVE] = 50;
bodyPartCosts[TOUGH] = 10;
bodyPartCosts[ATTACK] = 80;
bodyPartCosts[RANGED_ATTACK] = 150;
bodyPartCosts[HEAL] = 250;
bodyPartCosts[CLAIM] = 600;

const util = {
  bodyCost: function (body) {
    return body.reduce(function (sum, part) {
      return sum + (bodyPartCosts[part] || 0);
    }, 0);
  },
};

const ROOM_NAME = 'W1N1';
let state;
let liveCreeps = [];
let maxHeal = false;
let spawnCalls = [];

const room = {
  name: ROOM_NAME,
  controller: { my: true, level: 7 },
  energyCapacityAvailable: 750,
  energyAvailable: 750,
  storage: null,
  terminal: null,
  memory: {},
};

const roomState = {
  init: function () {},
  get: function () {
    return state;
  },
  creepIndex: function () {
    return { all: liveCreeps };
  },
};

const memoryManager = {
  heap: { supplierWaypoints: {} },
  storage: { register: function () {} },
  requestSave: function () {},
  requestImmediateSave: function () {},
};

const stubs = {
  getRoomState: roomState,
  roleTowerFiller: {
    SPAWN_TRIGGER_RATIO: 0.75,
    FILL_TRIGGER_RATIO: 0.5,
  },
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
  scavengerPolicy: {},
  scavengerLearning: {},
  memoryManager: memoryManager,
  repairManager: {
    isMaxHeal: function () {
      return maxHeal;
    },
  },
  factoryManager: {},
  labManager: {},
  marketLab: {},
  storageManager: {},
  terminalManager: {},
  permanentRoomFacts: {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad(request, parent, isMain);
};

global.Memory = { creeps: {} };
global.Game = {
  time: 1000,
  rooms: {},
  creeps: {},
  getObjectById: function (id) {
    return objectsById[id] || null;
  },
};

const objectsById = {};
const spawnManager = require('../spawnManager');
const roleSupplier = require('../roleSupplier');

Game.rooms[ROOM_NAME] = room;

function makeStore(amount, capacity) {
  const store = {
    energy: amount,
    getUsedCapacity: function (resource) {
      return resource && resource !== RESOURCE_ENERGY ? 0 : this.energy;
    },
    getFreeCapacity: function (resource) {
      return resource && resource !== RESOURCE_ENERGY ? capacity : Math.max(0, capacity - this.energy);
    },
    getCapacity: function () {
      return capacity;
    },
  };
  return store;
}

function makeTower(id, amount) {
  const tower = {
    id: id,
    my: true,
    pos: { x: 2, y: 1 },
    store: makeStore(amount, 1000),
  };
  objectsById[id] = tower;
  return tower;
}

function makeSpawn(spawning) {
  return {
    id: 'spawn-' + ROOM_NAME,
    my: true,
    room: room,
    spawning: spawning || null,
    spawnCreep: function (body, name, options) {
      spawnCalls.push({ body: body, name: name, memory: options.memory });
      return OK;
    },
  };
}

function makeFiller(ticksToLive, spawning) {
  const filler = {
    name: 'filler-' + liveCreeps.length,
    memory: {
      role: 'towerFiller',
      homeRoom: ROOM_NAME,
      assignedRoom: ROOM_NAME,
    },
    ticksToLive: ticksToLive,
  };
  if (spawning) filler.spawning = true;
  return filler;
}

function makeHostile() {
  return {
    owner: { username: 'Enemy' },
    body: [{ type: ATTACK }],
  };
}

function resetRuntime() {
  delete global._supHeap;
  delete global._supHeapTick;
  delete global._scanTick;
  delete global._scanCache;
  delete global._rvTick;
  delete global._rvCache;
  delete global._taskClaimTick;
  delete global._taskClaimCache;
  delete global._extWpMapCache;
  memoryManager.heap = { supplierWaypoints: {} };
}

function setTowerScenario(options) {
  resetRuntime();
  Game.time += 1;
  maxHeal = !!options.maxHeal;
  spawnCalls = [];
  Memory.creeps = {};
  const tower = makeTower('tower-' + Game.time, options.towerEnergy);
  const spawning = options.spawnSpawning || null;
  const spawn = makeSpawn(spawning);
  const towers = [tower];
  const fillers = options.fillers || [];
  for (let i = 0; i < fillers.length; i++) {
    if (fillers[i].name) Game.creeps[fillers[i].name] = fillers[i];
  }
  if (spawning && spawning.name) {
    Memory.creeps[spawning.name] = {
      role: 'towerFiller',
      homeRoom: ROOM_NAME,
    };
  }
  room.energyAvailable = options.energyAvailable === undefined ? 750 : options.energyAvailable;
  state = {
    hostiles: options.hostiles || [],
    structuresByType: {},
  };
  state.structuresByType[STRUCTURE_TOWER] = towers;
  state.structuresByType[STRUCTURE_SPAWN] = [spawn];
  liveCreeps = fillers;
  return {
    tower: tower,
    spawn: spawn,
  };
}

function spawnCount(options) {
  setTowerScenario(options);
  spawnManager.manageTowerFillerSpawns();
  return spawnCalls.length;
}

// 1. A healthy maxHeal filler does not cause a replacement when towers are full.
assert.strictEqual(spawnCount({
  maxHeal: true,
  towerEnergy: 1000,
  fillers: [makeFiller(300)],
}), 0);

// 2. The maxHeal replacement starts at the exact calculated threshold.
assert.strictEqual(spawnCount({
  maxHeal: true,
  towerEnergy: 1000,
  fillers: [makeFiller(85)],
}), 1);

// 3. A hostile room also prespawns an expiring filler even with full towers.
assert.strictEqual(spawnCount({
  hostiles: [makeHostile()],
  towerEnergy: 1000,
  fillers: [makeFiller(85)],
}), 1);

// 4. The existing spawn-level guard prevents a second replacement.
assert.strictEqual(spawnCount({
  maxHeal: true,
  towerEnergy: 1000,
  fillers: [makeFiller(85)],
  spawnSpawning: { name: 'next-filler' },
}), 0);

// 5. Prespawn remains disabled after the siege/maxHeal condition ends.
assert.strictEqual(spawnCount({
  towerEnergy: 1000,
  fillers: [makeFiller(85)],
}), 0);

// 6. A healthy filler still suppresses the normal reactive replacement path.
assert.strictEqual(spawnCount({
  hostiles: [makeHostile()],
  towerEnergy: 500,
  fillers: [makeFiller(300)],
}), 0);

// 7. A room with no filler still reacts to a low tower during a siege.
assert.strictEqual(spawnCount({
  hostiles: [makeHostile()],
  towerEnergy: 500,
  fillers: [],
}), 1);

function makeSupplierStore(amount, capacity) {
  return makeStore(amount, capacity);
}

function makeSupplierFixture(spawning) {
  resetRuntime();
  Game.time += 1;
  const tower = makeTower('coverage-tower-' + Game.time, 500);
  const storage = {
    id: 'storage-' + Game.time,
    structureType: STRUCTURE_STORAGE,
    pos: { x: 1, y: 1 },
    store: makeSupplierStore(2000, 10000),
  };
  const supplier = {
    name: 'supplier-' + Game.time,
    memory: {
      role: 'supplier',
      homeRoom: ROOM_NAME,
      assignedRoom: ROOM_NAME,
    },
    room: room,
    pos: { x: 1, y: 1 },
    fatigue: 0,
    ticksToLive: 500,
    store: makeSupplierStore(0, 1000),
    moveTo: function () {},
    withdraw: function (source, resource, amount) {
      if (source.store.getUsedCapacity(resource) <= 0) return ERR_NOT_ENOUGH_RESOURCES;
      const moved = Math.min(amount || source.store.getUsedCapacity(resource), source.store.getUsedCapacity(resource), this.store.getFreeCapacity(resource));
      source.store.energy -= moved;
      this.store.energy += moved;
      return moved > 0 ? OK : ERR_FULL;
    },
  };
  const filler = makeFiller(300, spawning);
  Game.creeps = {};
  Game.creeps[supplier.name] = supplier;
  Game.creeps[filler.name] = filler;
  objectsById[tower.id] = tower;
  objectsById[storage.id] = storage;
  room.storage = storage;
  room.terminal = null;
  state = {
    myCreeps: [supplier, filler],
    hostiles: [],
    dropped: [],
    tombstones: [],
    ruins: [],
    sources: [],
    minerals: [],
    constructionSites: [],
    storage: storage,
    terminal: null,
    structuresByType: {},
  };
  state.structuresByType[STRUCTURE_TOWER] = [tower];
  state.structuresByType[STRUCTURE_SPAWN] = [];
  state.structuresByType[STRUCTURE_CONTAINER] = [];
  state.structuresByType[STRUCTURE_LINK] = [];
  state.structuresByType[STRUCTURE_EXTENSION] = [];
  state.structuresByType[STRUCTURE_LAB] = [];
  state.structuresByType[STRUCTURE_POWER_SPAWN] = [];
  state.structuresByType[STRUCTURE_NUKER] = [];
  state.structuresByType[STRUCTURE_FACTORY] = [];
  state.structuresByType[STRUCTURE_EXTRACTOR] = [];
  liveCreeps = [supplier, filler];
  return supplier;
}

function assignedTaskType(spawning) {
  const supplier = makeSupplierFixture(spawning);
  roleSupplier.run(supplier);
  if (!supplier.memory.a) return null;
  return supplier.memory.a.split('|')[0];
}

// Fix A: a spawning-only filler must not suppress supplier tower work.
assert.strictEqual(assignedTaskType(true), 'tower');

// Once the filler is live, the existing stand-down behavior remains.
assert.strictEqual(assignedTaskType(false), null);

Module._load = originalLoad;
console.log('Tower filler prespawn harness complete.');
