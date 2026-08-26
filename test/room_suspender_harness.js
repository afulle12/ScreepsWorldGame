// LLM: Read docs/codex.js before reviewing or changing this file.
// test/room_suspender_harness.js
// Focused coverage for structure health hysteresis and breach wakeups.

const assert = require('assert');
const Module = require('module');

const ROOM_NAME = 'E1N1';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_ROAD = 'road';
global.STRUCTURE_CONTAINER = 'container';
global.STRUCTURE_RAMPART = 'rampart';
global.STRUCTURE_POWER_SPAWN = 'powerSpawn';
global.STRUCTURE_EXTRACTOR = 'extractor';
global.RAMPART_HITS_MAX = [0, 0, 10000, 50000, 200000, 1000000, 3000000, 10000000, 50000000];

let roomState;
let breachState;
let breachCalls;
let testTick = 1000;

const memoryManager = {
  heap: {},
  requestSave: function () {},
};

const roomStateApi = {
  ownedNames: function () {
    return [ROOM_NAME];
  },
  get: function (roomName) {
    return roomName === ROOM_NAME ? roomState : undefined;
  },
  creepIndex: function () {
    return { all: [], byHomeRoom: {} };
  },
};

const repairManager = {
  isMaxHeal: function () {
    return false;
  },
  getBreachState: function (roomName, state, rcl) {
    breachCalls.push({ roomName: roomName, state: state, rcl: rcl });
    return Object.assign({}, breachState);
  },
};

const emptyOperations = {
  getOperations: function () {
    return [];
  },
  getOrders: function () {
    return [];
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'getRoomState') return roomStateApi;
  if (request === 'memoryManager') return memoryManager;
  if (request === 'repairManager') return repairManager;
  if (request === 'marketLab' || request === 'marketRefine' || request === 'localRefine' || request === 'factoryManager') return emptyOperations;
  return originalLoad(request, parent, isMain);
};

global.Memory = {};
global.Game = {
  time: testTick,
  rooms: {},
  powerCreeps: {},
  gpl: { level: 0 },
  cpu: {
    bucket: 1000,
    limit: 20,
    getUsed: function () {
      return 1;
    },
  },
};

const roomSuspender = require('../roomSuspender');

function makeTower(pct) {
  return {
    id: 'tower-1',
    my: true,
    hits: 300000 * pct,
    hitsMax: 300000,
  };
}

function makeContainer(pct, id) {
  return {
    id: id || 'container-1',
    hits: 250000 * pct,
    hitsMax: 250000,
  };
}

function makeRoad(pct, id) {
  return {
    id: id || 'road-1',
    hits: 5000 * pct,
    hitsMax: 5000,
  };
}

function makeRampart(hits, id) {
  return {
    id: id || 'rampart-1',
    my: true,
    hits: hits,
    hitsMax: 50000000,
    pos: { x: 20, y: 20, roomName: ROOM_NAME },
  };
}

function makeRoads(count, damagedIndex) {
  const roads = [];
  for (let i = 0; i < count; i++) roads.push(makeRoad(i === damagedIndex ? .2 : .8, 'road-' + i));
  return roads;
}

function reset(options) {
  options = options || {};
  testTick += 100;
  Game.time = testTick;
  Game.cpu.bucket = 1000;
  Game.rooms = {
    [ROOM_NAME]: {
      name: ROOM_NAME,
      controller: { my: true, level: options.rcl || 8, safeMode: 0 },
      energyCapacityAvailable: 3000,
      energyAvailable: 3000,
      storage: null,
      terminal: null,
    },
  };
  roomState = {
    name: ROOM_NAME,
    controller: Game.rooms[ROOM_NAME].controller,
    hostiles: [],
    minerals: [],
    myPowerCreeps: [],
    constructionSites: [],
    structuresByType: {
      [STRUCTURE_TOWER]: [makeTower(options.towerPct === undefined ? 1 : options.towerPct)],
      [STRUCTURE_CONTAINER]: [makeContainer(options.containerPct === undefined ? .8 : options.containerPct)],
      [STRUCTURE_ROAD]: options.roads || makeRoads(1),
      [STRUCTURE_RAMPART]: [makeRampart(options.rampartHits === undefined ? 100000 : options.rampartHits)],
    },
  };
  breachState = { breached: false };
  breachCalls = [];
  global.Memory = {
    suspendedRooms: {},
    roomSuspenderControl: {},
  };
  for (const key in memoryManager.heap) delete memoryManager.heap[key];
}

function advance(ticks) {
  Game.time += ticks || 25;
}

function runUnderPressure() {
  roomSuspender.run();
  return roomSuspender.isSuspended(ROOM_NAME);
}

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}

test('healthy structures enter suspension under CPU pressure', function () {
  reset();
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), null);
  assert.strictEqual(runUnderPressure(), true);
  const vitals = roomSuspender.getVitals(ROOM_NAME);
  assert.strictEqual(vitals.containerMinHits, 200000);
  assert.strictEqual(vitals.containerMinPct, .8);
  assert.strictEqual(vitals.rampartMinHits, 100000);
  assert.strictEqual(vitals.roadMinPct, .8);
  assert(breachCalls.some(function (call) {
    return call.roomName === ROOM_NAME && call.state === roomState && call.rcl === 8;
  }));
});

test('a decaying container wakes a suspended room', function () {
  reset();
  assert.strictEqual(runUnderPressure(), true);
  roomState.structuresByType[STRUCTURE_CONTAINER][0] = makeContainer(.36);
  advance();
  roomSuspender.run();
  assert.strictEqual(roomSuspender.isSuspended(ROOM_NAME), false);
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), 'containerDamage');
});

test('a weak rampart wakes a suspended room', function () {
  reset();
  assert.strictEqual(runUnderPressure(), true);
  roomState.structuresByType[STRUCTURE_RAMPART][0] = makeRampart(20000);
  advance();
  roomSuspender.run();
  assert.strictEqual(roomSuspender.isSuspended(ROOM_NAME), false);
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), 'rampartDamage');
});

test('a damaged road after the first 100 roads is monitored', function () {
  reset({ roads: makeRoads(101) });
  assert.strictEqual(runUnderPressure(), true);
  roomState.structuresByType[STRUCTURE_ROAD][100] = makeRoad(.2, 'road-100');
  advance();
  roomSuspender.run();
  assert.strictEqual(roomSuspender.isSuspended(ROOM_NAME), false);
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), 'roadDamage');
  assert.strictEqual(roomSuspender.getVitals(ROOM_NAME).roadMinPct, .2);
});

test('hysteresis holds active rooms until the healthy threshold', function () {
  reset({ containerPct: .45 });
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), 'containerDamage');
  assert.strictEqual(runUnderPressure(), false);

  roomState.structuresByType[STRUCTURE_CONTAINER][0] = makeContainer(.7);
  advance();
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), 'containerDamage');
  assert.strictEqual(runUnderPressure(), false);

  roomState.structuresByType[STRUCTURE_CONTAINER][0] = makeContainer(.76);
  advance();
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), null);
  assert.strictEqual(runUnderPressure(), true);

  roomState.structuresByType[STRUCTURE_CONTAINER][0] = makeContainer(.7);
  advance();
  roomSuspender.run();
  assert.strictEqual(roomSuspender.isSuspended(ROOM_NAME), true);

  roomState.structuresByType[STRUCTURE_CONTAINER][0] = makeContainer(.35);
  advance();
  roomSuspender.run();
  assert.strictEqual(roomSuspender.isSuspended(ROOM_NAME), false);
});

test('a perimeter breach blocks suspension and wakes a suspended room', function () {
  reset();
  breachState = { breached: true, x: 0, y: 20 };
  assert.strictEqual(roomSuspender.getIneligibilityReason(ROOM_NAME), 'breach');
  assert.strictEqual(runUnderPressure(), false);

  breachState = { breached: false };
  advance();
  assert.strictEqual(runUnderPressure(), true);
  breachState = { breached: true, x: 0, y: 20 };
  advance();
  roomSuspender.run();
  assert.strictEqual(roomSuspender.isSuspended(ROOM_NAME), false);
});

test('priority penalizes healthy but degraded structures', function () {
  reset({ containerPct: 1, roads: makeRoads(1) });
  const pristine = roomSuspender.getSuspensionPriority(ROOM_NAME);
  roomState.structuresByType[STRUCTURE_CONTAINER][0] = makeContainer(.8);
  advance();
  const degraded = roomSuspender.getSuspensionPriority(ROOM_NAME);
  assert(degraded > pristine);
});

test('status and plan expose structure and breach vitals', function () {
  reset();
  runUnderPressure();
  const status = global.roomSuspendStatus();
  const plan = global.roomSuspendPlan();
  for (const output of [status, plan]) {
    assert(output.indexOf('container=') !== -1);
    assert(output.indexOf('rampart=') !== -1);
    assert(output.indexOf('road=') !== -1);
    assert(output.indexOf('breach=') !== -1);
  }
});

console.log('Room suspender harness complete.');
Module._load = originalLoad;
