// LLM: Read docs/codex.js before reviewing or changing this file.
// test/spawn_recovery_harness.js
// Covers the spawn-failure recovery paths added for the E1N46 investigation:
//   - checkStalledSpawns() watchdog: warn, auto-cancel, prune
//   - manageHarvesterSpawns() falling back to an idle spawn when the nearest
//     spawn to the source is busy
//   - getCreepBody() returning null instead of an unaffordable body

const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- constants
global.OK = 0;
global.ERR_BUSY = -4;
global.ERR_NOT_ENOUGH_ENERGY = -6;
global.WORK = 'work';
global.CARRY = 'carry';
global.MOVE = 'move';
global.TOUGH = 'tough';
global.ATTACK = 'attack';
global.RANGED_ATTACK = 'ranged_attack';
global.HEAL = 'heal';
global.CLAIM = 'claim';
global.CREEP_SPAWN_TIME = 3;
global.RESOURCE_ENERGY = 'energy';
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_CONTAINER = 'container';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_TERMINAL = 'terminal';
global.FIND_SOURCES = 105;
global.FIND_MY_SPAWNS = 112;
global.LOOK_STRUCTURES = 'structure';
global.LOOK_CREEPS = 'creep';
global.TERRAIN_MASK_WALL = 1;
global.TOP = 1;
global.TOP_RIGHT = 2;
global.RIGHT = 3;
global.BOTTOM_RIGHT = 4;
global.BOTTOM = 5;
global.BOTTOM_LEFT = 6;
global.LEFT = 7;
global.TOP_LEFT = 8;
global.OBSTACLE_OBJECT_TYPES = [
  'spawn', 'constructedWall', 'extension', 'link', 'storage', 'tower',
  'observer', 'powerSpawn', 'powerBank', 'lab', 'terminal', 'nuker',
  'factory', 'invaderCore',
];

const bodyPartCosts = {};
bodyPartCosts[WORK] = 100;
bodyPartCosts[CARRY] = 50;
bodyPartCosts[MOVE] = 50;
bodyPartCosts[TOUGH] = 10;
bodyPartCosts[ATTACK] = 80;
bodyPartCosts[RANGED_ATTACK] = 150;
bodyPartCosts[HEAL] = 250;
bodyPartCosts[CLAIM] = 600;

function bodyCost(body) {
  return body.reduce(function (sum, part) {
    return sum + (bodyPartCosts[part] || 0);
  }, 0);
}

global.RoomPosition = function (x, y, roomName) {
  this.x = x;
  this.y = y;
  this.roomName = roomName;
};
global.RoomPosition.prototype.getRangeTo = function (other) {
  return Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y));
};

// ------------------------------------------------------------------- stubs
let liveCreeps = [];
const roomStateStub = {
  get: function (name) {
    return roomStateByRoom[name] || null;
  },
  creepIndex: function () {
    return { all: liveCreeps };
  },
};
let roomStateByRoom = {};

const stubs = {
  getRoomState: roomStateStub,
  roleTowerDrain: {},
  roleDrainDemolisher: {},
  singleSourceRoom: {
    isSingleSourceActive: function () {
      return false;
    },
  },
  roomSuspender: {
    shouldAvoidRoomWork: function () {
      return false;
    },
  },
  util: { bodyCost: bodyCost },
  scavengerPolicy: {},
  scavengerLearning: {},
  marketPricing: {},
  autoTrader: {},
  memoryManager: {
    storage: { register: function () {} },
    requestImmediateSave: function () {},
    requestSave: function () {},
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad(request, parent, isMain);
};

global.Memory = {};
global.Game = {
  time: 1000,
  rooms: {},
  spawns: {},
  cpu: { bucket: 10000, getUsed: function () { return 0; } },
  map: {
    getRoomTerrain: function () {
      return { get: function () { return 0; } };
    },
  },
};

const spawnManager = require('../spawnManager');

// --------------------------------------------------------- console capture
const realLog = console.log;
let logs = [];
function captureLogs(fn) {
  logs = [];
  console.log = function (msg) { logs.push(String(msg)); };
  try {
    fn();
  } finally {
    console.log = realLog;
  }
  return logs;
}
function logsMatching(pattern) {
  return logs.filter(function (l) { return l.indexOf(pattern) !== -1; });
}

// =====================================================================
// 1. getCreepBody returns null rather than an unaffordable body
// =====================================================================
assert.strictEqual(
  spawnManager.getCreepBody('supplier', 150), null,
  'supplier below the 200 tier should return null, not the 200 body'
);
assert.ok(
  Array.isArray(spawnManager.getCreepBody('supplier', 200)),
  'supplier at exactly the 200 tier should still return a body'
);
assert.strictEqual(
  spawnManager.getCreepBody('towerFiller', 100), null,
  'towerFiller below the 150 tier should return null'
);
assert.ok(
  Array.isArray(spawnManager.getCreepBody('towerFiller', 150)),
  'towerFiller at exactly the 150 tier should still return a body'
);
// Roles that short-circuit before the tier table must be unaffected.
assert.ok(
  Array.isArray(spawnManager.getCreepBody('harvester', 250)),
  'harvester below 300 still returns the basic body'
);
realLog('  [1/3] getCreepBody null-below-tier: ok');

// =====================================================================
// 2. checkStalledSpawns watchdog
// =====================================================================
function makeRoomForStall(name) {
  return {
    name: name,
    lookForAt: function () { return []; },
  };
}

let cancelled = 0;
const stallRoom = makeRoomForStall('W1N1');
const stalledSpawn = {
  name: 'Spawn1',
  my: true,
  room: stallRoom,
  pos: { x: 10, y: 10 },
  spawning: {
    name: 'H_W1N1_abc_1000',
    remainingTime: 0,
    needTime: 50,
    directions: [TOP],
    cancel: function () { cancelled++; },
  },
};
Game.spawns = { Spawn1: stalledSpawn };
Memory.spawnStallWatch = undefined;

// First sighting records the tick and stays quiet.
Game.time = 1000;
captureLogs(function () { spawnManager.checkStalledSpawns(); });
assert.strictEqual(logsMatching('[SpawnStall]').length, 0, 'no warning on first sighting');
assert.strictEqual(Memory.spawnStallWatch['W1N1|Spawn1'], 1000, 'watch entry recorded');

// Below the warn threshold: still quiet.
Game.time = 1004;
captureLogs(function () { spawnManager.checkStalledSpawns(); });
assert.strictEqual(logsMatching('[SpawnStall]').length, 0, 'quiet at 4 ticks stuck');

// At the warn threshold: warns and dumps the blocked exits.
Game.time = 1005;
captureLogs(function () { spawnManager.checkStalledSpawns(); });
assert.ok(logsMatching('[SpawnStall]').length > 0, 'warns at 5 ticks stuck');
assert.ok(
  logsMatching('blocked 5 ticks').length === 1,
  'warning names the stall duration'
);
assert.strictEqual(cancelled, 0, 'no cancel before the cancel threshold');

// At the cancel threshold: cancels and forgets the spawn.
Game.time = 1025;
captureLogs(function () { spawnManager.checkStalledSpawns(); });
assert.strictEqual(cancelled, 1, 'cancels at 25 ticks stuck');
assert.ok(logsMatching('cancelled').length === 1, 'cancel is logged');
assert.strictEqual(
  Memory.spawnStallWatch['W1N1|Spawn1'], undefined,
  'watch entry cleared after cancel'
);

// A spawn that recovers on its own is pruned rather than left in memory.
Memory.spawnStallWatch = { 'W1N1|Spawn1': 900 };
stalledSpawn.spawning = null;
Game.time = 1030;
captureLogs(function () { spawnManager.checkStalledSpawns(); });
assert.deepStrictEqual(Memory.spawnStallWatch, {}, 'stale watch entries pruned');

// A spawn mid-build (remainingTime > 0) is never treated as stalled.
stalledSpawn.spawning = { name: 'x', remainingTime: 12, needTime: 50, cancel: function () { cancelled++; } };
Game.time = 1031;
captureLogs(function () { spawnManager.checkStalledSpawns(); });
assert.deepStrictEqual(Memory.spawnStallWatch, {}, 'healthy spawn is not watched');
assert.strictEqual(cancelled, 1, 'healthy spawn is never cancelled');
realLog('  [2/3] checkStalledSpawns watchdog: ok');

// =====================================================================
// 3. manageHarvesterSpawns falls back to an idle spawn
// =====================================================================
Game.spawns = {};
const HARVEST_ROOM = 'W2N2';

function makeSpawn(name, x, y, busy, room) {
  return {
    name: name,
    my: true,
    room: room,
    spawning: busy ? { name: 'other', remainingTime: 20 } : null,
    pos: new RoomPosition(x, y, HARVEST_ROOM),
    spawnCreep: function (body, creepName, opts) {
      this.calls.push({ body: body, name: creepName, opts: opts });
      return OK;
    },
    calls: [],
  };
}

function setupHarvestScenario(nearBusy, farBusy) {
  const room = {
    name: HARVEST_ROOM,
    controller: { my: true, level: 7 },
    energyAvailable: 1000,
    energyCapacityAvailable: 1300,
    lookForAt: function () { return []; },
    find: function () { return []; },
  };
  const near = makeSpawn('SpawnNear', 6, 6, nearBusy, room);
  const far = makeSpawn('SpawnFar', 20, 20, farBusy, room);
  Game.rooms = {};
  Game.rooms[HARVEST_ROOM] = room;
  roomStateByRoom = {};
  roomStateByRoom[HARVEST_ROOM] = {
    storage: null,
    structuresByType: { spawn: [near, far] },
    sources: [],
  };
  liveCreeps = [];
  Memory.sourceMeta = {};
  Memory.sourceMeta[HARVEST_ROOM] = {
    lastScan: Game.time,
    byId: {
      'source-aaaaaa': { pos: { x: 5, y: 5, roomName: HARVEST_ROOM }, range: 1 },
    },
  };
  return { room: room, near: near, far: far };
}

// Nearest spawn busy, farther spawn idle -> the farther spawn is used.
Game.time = 2000;
let scenario = setupHarvestScenario(true, false);
captureLogs(function () { spawnManager.manageHarvesterSpawns(); });
assert.strictEqual(scenario.near.calls.length, 0, 'busy nearest spawn is not used');
assert.strictEqual(
  scenario.far.calls.length, 1,
  'idle farther spawn is used instead of skipping the source'
);
assert.strictEqual(
  scenario.far.calls[0].opts.memory.sourceId, 'source-aaaaaa',
  'spawned harvester is assigned to the uncovered source'
);

// Every spawn busy -> nothing is spawned, and nothing throws.
Game.time = 2001;
scenario = setupHarvestScenario(true, true);
captureLogs(function () { spawnManager.manageHarvesterSpawns(); });
assert.strictEqual(scenario.near.calls.length, 0, 'no spawn attempt when all spawns are busy');
assert.strictEqual(scenario.far.calls.length, 0, 'no spawn attempt when all spawns are busy');

// Nearest spawn idle -> unchanged behaviour, nearest is preferred.
Game.time = 2002;
scenario = setupHarvestScenario(false, false);
captureLogs(function () { spawnManager.manageHarvesterSpawns(); });
assert.strictEqual(scenario.near.calls.length, 1, 'idle nearest spawn is still preferred');
assert.strictEqual(scenario.far.calls.length, 0, 'farther spawn untouched when nearest is free');
realLog('  [3/3] manageHarvesterSpawns idle-spawn fallback: ok');

Module._load = originalLoad;
realLog('Spawn recovery harness complete.');
