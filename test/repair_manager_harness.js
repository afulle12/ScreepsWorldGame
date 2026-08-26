// LLM: Read docs/codex.js before reviewing or changing this file.
// test/repair_manager_harness.js
// Focused regression coverage for unified repair planning and dispatch.

const assert = require('assert');
const Module = require('module');
global.OK = 0;
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_ROAD = 'road';
global.STRUCTURE_WALL = 'constructedWall';
global.STRUCTURE_RAMPART = 'rampart';
global.STRUCTURE_LINK = 'link';
global.STRUCTURE_STORAGE = 'storage';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_NUKER = 'nuker';
global.STRUCTURE_FACTORY = 'factory';
global.STRUCTURE_LAB = 'lab';
global.STRUCTURE_TERMINAL = 'terminal';
global.STRUCTURE_EXTRACTOR = 'extractor';
global.STRUCTURE_POWER_SPAWN = 'powerSpawn';
global.STRUCTURE_OBSERVER = 'observer';
global.STRUCTURE_CONTAINER = 'container';
global.TERRAIN_MASK_WALL = 1;
global.TERRAIN_MASK_SWAMP = 2;
global.OBSTACLE_OBJECT_TYPES = ['spawn', 'extension', 'storage', 'terminal',
  'tower', 'lab', 'factory', 'nuker', 'powerSpawn', 'observer', 'link',
  'constructedWall', 'controller'];
global.RESOURCE_ENERGY = 'energy';
global.WORK = 'work';
global.CARRY = 'carry';
global.MOVE = 'move';
global.RAMPART_HITS_MAX = [0, 0, 10000, 50000, 200000, 1000000, 3000000, 10000000, 50000000];
global.FIND_NUKES = 'nukes';
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
let liveCreeps;
const terrainFixtures = {};
function makeTerrain(ascii) {
  const rows = String(ascii || '').replace(/\r/g, '').trim().split('\n');
  return {
    get: function (x, y) {
      const row = rows[y] || '';
      const cell = row[x];
      if (cell === '#') return TERRAIN_MASK_WALL;
      if (cell === '~') return TERRAIN_MASK_SWAMP;
      return 0;
    },
  };
}
const emptyTerrain = makeTerrain('');
const roomState = {
  get: function () {
    return state;
  },
  creepIndex: function () {
    return { all: liveCreeps };
  },
};
const defenseMonitor = {};
const roomSuspender = {
  shouldAvoidRoomWork: function () {
    return false;
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'getRoomState') return roomState;
  if (request === 'defenseMonitor') return defenseMonitor;
  if (request === 'roomSuspender') return roomSuspender;
  if (request === 'util') return util;
  return originalLoad(request, parent, isMain);
};
global.Memory = {};
global.Game = {
  time: 1000,
  rooms: {},
  creeps: {},
  _objects: {},
  map: {
    getRoomTerrain: function (roomName) {
      return terrainFixtures[roomName] || emptyTerrain;
    },
  },
  getObjectById: function (id) {
    return this._objects[id] || null;
  },
};
const repairManager = require('../repairManager');
Module._load = originalLoad;

function makeWall(hits, id, x, y) {
  return {
    id: id || 'wall-1',
    structureType: STRUCTURE_WALL,
    hits: hits,
    hitsMax: 300000000,
    pos: { x: x === undefined ? 20 : x, y: y === undefined ? 20 : y, roomName: 'E9N49' },
  };
}

function makeRampart(hits, id, x, y, isPublic) {
  const rampart = {
    id: id || 'rampart-1',
    structureType: STRUCTURE_RAMPART,
    my: true,
    hits: hits,
    hitsMax: 300000000,
    pos: { x: x === undefined ? 21 : x, y: y === undefined ? 20 : y, roomName: 'E9N49' },
  };
  if (isPublic !== undefined) rampart.isPublic = isPublic;
  return rampart;
}

function makeSpawn(spawning, x, y) {
  return {
    id: 'spawn-1',
    structureType: STRUCTURE_SPAWN,
    my: true,
    spawning: spawning || null,
    pos: { x: x === undefined ? 25 : x, y: y === undefined ? 25 : y, roomName: 'E9N49' },
  };
}

function makeStorage(x, y, id) {
  return {
    id: id || 'storage-1',
    structureType: STRUCTURE_STORAGE,
    my: true,
    pos: { x: x, y: y, roomName: 'E9N49' },
  };
}

function squareRing(cx, cy, radius, omitX, omitY) {
  const ramps = [];
  let id = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x !== cx - radius && x !== cx + radius && y !== cy - radius && y !== cy + radius) continue;
      if (x === omitX && y === omitY) continue;
      ramps.push(makeRampart(50000000, 'ring-' + id++, x, y));
    }
  }
  return ramps;
}

function diamondRing(cx, cy, radius) {
  const ramps = [];
  let id = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) !== radius) continue;
      ramps.push(makeRampart(50000000, 'diamond-' + id++, x, y));
    }
  }
  return ramps;
}

function setPerimeter(ramparts, structures, level, safeMode) {
  const room = Game.rooms.E9N49;
  room.controller.level = level === undefined ? 8 : level;
  room.controller.safeMode = safeMode || 0;
  state.controller = room.controller;
  state.structuresByType = {};
  state.structuresByType[STRUCTURE_WALL] = [makeWall(50000000, 'perimeter-wall', 10, 10)];
  state.structuresByType[STRUCTURE_RAMPART] = ramparts || [];
  state.structuresByType[STRUCTURE_SPAWN] = structures || [makeSpawn(null, 25, 25)];
}

function reset(hits, spawns) {
  Game.time = 1000;
  Game.rooms = {};
  Game.creeps = {};
  Game._objects = {};
  liveCreeps = [];
  Memory = { creeps: {} };
  global._repairPlanCache = {};
  global._repairAssignmentTick = {};
  global._repairBreachCache = {};
  // Per-tick memos in repairManager. Real ticks advance the clock; this harness
  // pins Game.time, so they have to be dropped explicitly between cases.
  global._repairItemSetCache = null;
  global._repairOccupancyCache = null;
  global._repairRampartInfo = null;
  terrainFixtures.E9N49 = makeTerrain('');

  const room = {
    name: 'E9N49',
    controller: { my: true, level: 8 },
    energyCapacityAvailable: 3000,
    energyAvailable: 3000,
    storage: null,
    terminal: null,
    find: function (findType) {
      return findType === FIND_NUKES ? [] : [];
    },
  };
  Game.rooms.E9N49 = room;

  state = {
    name: 'E9N49',
    controller: room.controller,
    structuresByType: {},
    hostiles: [],
    minerals: [],
    myPowerCreeps: [],
    storage: null,
    terminal: null,
  };
  state.structuresByType[STRUCTURE_WALL] = [makeWall(hits, 'wall-1'), makeWall(hits, 'wall-2')];
  state.structuresByType[STRUCTURE_SPAWN] = spawns || [];
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

test('an intact rampart ring seals a spawn perimeter', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  setPerimeter(squareRing(25, 25, 2), [makeSpawn(null, 25, 25)]);

  const plan = repairManager.buildPlan('E9N49', true);
  const breach = repairManager.getBreachState('E9N49', state, 8);
  assert.strictEqual(plan.repairTier, 'PEACE');
  assert.strictEqual(breach.breached, false);
});

test('a missing rampart raises PEACE_EMERGENCY and reports an exit', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  setPerimeter(squareRing(25, 25, 2, 23, 25), [makeSpawn(null, 25, 25)]);

  const plan = repairManager.buildPlan('E9N49', true);
  const breach = repairManager.getBreachState('E9N49', state, 8);
  assert.strictEqual(plan.repairTier, 'PEACE_EMERGENCY');
  assert.strictEqual(breach.breached, true);
  assert(breach.x === 0 || breach.x === 49 || breach.y === 0 || breach.y === 49);
  assert(Memory.repairManager.rooms.E9N49.breachEmergencyUntil > Game.time);
  assert.strictEqual(Memory.repairManager.rooms.E9N49.peaceEmergencyUntil, undefined);
  assert(global.repairPlan('E9N49').indexOf('BREACH exit:') !== -1);
});

test('a diagonal rampart ring is breached by 8-way movement', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  setPerimeter(diamondRing(25, 25, 2), [makeSpawn(null, 25, 25)]);

  const plan = repairManager.buildPlan('E9N49', true);
  assert.strictEqual(plan.repairTier, 'PEACE_EMERGENCY');
});

test('a public rampart does not seal the perimeter', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  const ring = squareRing(25, 25, 2);
  ring[0].isPublic = true;
  setPerimeter(ring, [makeSpawn(null, 25, 25)]);

  const plan = repairManager.buildPlan('E9N49', true);
  assert.strictEqual(plan.repairTier, 'PEACE_EMERGENCY');
});

test('a storage outside the ring contributes a breach seed', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  const storage = makeStorage(35, 25);
  setPerimeter(squareRing(25, 25, 2), [makeSpawn(null, 25, 25)]);
  state.structuresByType[STRUCTURE_STORAGE] = [storage];
  state.storage = storage;

  const plan = repairManager.buildPlan('E9N49', true);
  assert.strictEqual(plan.repairTier, 'PEACE_EMERGENCY');
});

test('RCL 2 skips breach detection', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  setPerimeter(squareRing(25, 25, 2, 23, 25), [makeSpawn(null, 25, 25)], 2);

  const plan = repairManager.buildPlan('E9N49', true);
  const breach = repairManager.getBreachState('E9N49', state, 2);
  assert.strictEqual(plan.repairTier, 'PEACE');
  assert.strictEqual(breach.skipped, 'rcl');
});

test('safe mode skips breach detection', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  setPerimeter(squareRing(25, 25, 2, 23, 25), [makeSpawn(null, 25, 25)], 8, 100);

  const plan = repairManager.buildPlan('E9N49', true);
  const breach = repairManager.getBreachState('E9N49', state, 8);
  assert.strictEqual(plan.repairTier, 'PEACE');
  assert.strictEqual(breach.skipped, 'safeMode');
});

test('a rampart carpet over every core tile has zero seeds', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  const spawn = makeSpawn(null, 25, 25);
  const carpet = [];
  let id = 0;
  for (let y = 24; y <= 26; y++) {
    for (let x = 24; x <= 26; x++) carpet.push(makeRampart(50000000, 'carpet-' + id++, x, y));
  }
  setPerimeter(carpet, [spawn]);

  const plan = repairManager.buildPlan('E9N49', true);
  const breach = repairManager.getBreachState('E9N49', state, 8);
  assert.strictEqual(plan.repairTier, 'PEACE');
  assert.strictEqual(breach.breached, false);
  assert.strictEqual(breach.seedCount, 0);
});

test('a persistent breach bypasses the plan cache only on its rising edge', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  setPerimeter(squareRing(25, 25, 2, 23, 25), [makeSpawn(null, 25, 25)]);

  const first = repairManager.shouldBypassPlanCache('E9N49', state, 8, false, null, false, null);
  Game.time = 1001;
  const second = repairManager.shouldBypassPlanCache('E9N49', state, 8, false, null, false, null);
  Game.time = 1025;
  const third = repairManager.shouldBypassPlanCache('E9N49', state, 8, false, null, false, null);
  assert.strictEqual(first, true);
  assert.strictEqual(second, false);
  assert.strictEqual(third, false);
});

test('breach diagnostics report bounded nodes and CPU', function () {
  reset(50000000, [makeSpawn(null, 25, 25)]);
  setPerimeter(squareRing(25, 25, 2, 23, 25), [makeSpawn(null, 25, 25)]);

  const report = global.repairCheckBreach('E9N49');
  const nodes = report.match(/nodes:(\d+)\//);
  assert(nodes);
  assert(Number(nodes[1]) < repairManager.constants.BREACH_MAX_NODES);
  assert(report.indexOf('breached:true') !== -1);
  assert(report.indexOf('cpu:') !== -1);
});

test('severely damaged peaceful walls enter PEACE_EMERGENCY', function () {
  reset(0, []);
  const plan = repairManager.buildPlan('E9N49', true);

  assert.strictEqual(plan.repairTier, 'PEACE_EMERGENCY');
  assert.strictEqual(plan.requests[0].kind, 'baseline');
  assert.strictEqual(plan.requests[1].kind, 'extra');
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 2);
});

test('max-heal preview matches its three-creep dispatch', function () {
  reset(10000000, []);
  Memory.repairManager = { rooms: { E9N49: { maxHeal: true } } };
  const plan = repairManager.buildPlan('E9N49', true);

  assert.strictEqual(plan.maxHeal, true);
  assert.strictEqual(plan.requests[1].count, 2);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 3);
});

test('MAX_HEAL invalidates a cached normal plan and uses the fast cadence', function () {
  reset(10000000, []);
  const normal = repairManager.buildPlan('E9N49', true);
  assert.strictEqual(normal.maxHeal, false);

  Game.time = 1001;
  Memory.repairManager = { rooms: { E9N49: { maxHeal: true } } };
  const maxHeal = repairManager.buildPlan('E9N49', false);

  assert.strictEqual(maxHeal.tick, 1001);
  assert.strictEqual(maxHeal.maxHeal, true);
  assert.strictEqual(maxHeal.cadence, repairManager.constants.REPAIR_SPAWN_INTERVAL_TICKS);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 3);
});

test('MAX_HEAL plans refresh every ten ticks and expire cleanly', function () {
  reset(10000000, []);
  Memory.repairManager = { rooms: { E9N49: { maxHeal: true } } };
  const first = repairManager.buildPlan('E9N49', true);

  Game.time = 1009;
  const cached = repairManager.buildPlan('E9N49', false);
  assert.strictEqual(cached.tick, first.tick);

  Game.time = 1010;
  const refreshed = repairManager.buildPlan('E9N49', false);
  assert.strictEqual(refreshed.tick, 1010);
  assert.strictEqual(refreshed.maxHeal, true);

  reset(10000000, []);
  Memory.repairManager = { rooms: { E9N49: { maxHeal: true, maxHealUntil: 1005 } } };
  repairManager.buildPlan('E9N49', true);
  Game.time = 1005;
  const expired = repairManager.buildPlan('E9N49', false);
  assert.strictEqual(expired.tick, 1005);
  assert.strictEqual(expired.maxHeal, false);
});

test('active queued requests refresh instead of expiring', function () {
  reset(10000000, []);
  repairManager.buildPlan('E9N49', true);
  const request = Memory.repairSpawnRequests.E9N49[0];
  request.marker = 'keep';
  request.ct = 1000;

  Game.time = 1101;
  repairManager.buildPlan('E9N49', false);

  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].marker, 'keep');
  assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].ct, 1101);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].at, 1000);
});

test('an uncovered desired repairer slot bypasses the cached plan', function () {
  reset(10000000, []);
  repairManager.buildPlan('E9N49', true);
  Memory.repairSpawnRequests.E9N49 = [];

  Game.time = 1001;
  const refreshed = repairManager.buildPlan('E9N49', false);

  assert.strictEqual(refreshed.tick, 1001);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
});

test('a dead repairer opens a replacement slot on the next planner pass', function () {
  reset(10000000, []);
  const name = 'Repairer_E9N49_baseline_live';
  const creep = {
    name: name,
    spawning: false,
    ticksToLive: 500,
    memory: { role: 'repairer', homeRoom: 'E9N49' },
    room: Game.rooms.E9N49,
  };
  Game.creeps[name] = creep;
  liveCreeps = [creep];

  repairManager.buildPlan('E9N49', true);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);

  delete Game.creeps[name];
  liveCreeps = [];
  global._repairPlanCache = {};
  Game.time = 1001;
  repairManager.buildPlan('E9N49', false);

  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].kind, 'baseline');
});

test('repairPlan is a read-only preview', function () {
  reset(0, []);
  const before = JSON.stringify(Memory);
  const output = global.repairPlan('E9N49');

  assert(output.indexOf('E9N49') !== -1);
  assert.strictEqual(JSON.stringify(Memory), before);
});

test('stale extras are trimmed and normalized after emergency ends', function () {
  reset(10000000, []);
  Memory.repairSpawnRequests = {
    E9N49: [
      { kind: 'extra', priority: 7, ct: 1000 },
      { kind: 'extra', priority: 7, ct: 1000 },
    ],
  };
  const plan = repairManager.buildPlan('E9N49', true);

  assert.strictEqual(plan.repairTier, 'PEACE');
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].kind, 'baseline');
});

test('peaceful rooms above the repair buffer do not queue repairers', function () {
  reset(50000000, []);
  state.structuresByType[STRUCTURE_RAMPART] = [makeRampart(50000000, 'rampart-1')];
  const plan = repairManager.buildPlan('E9N49', true);

  assert.strictEqual(plan.repairTier, 'PEACE');
  assert.strictEqual(plan.stats.creepHits, 0);
  assert.strictEqual(plan.maintenanceItems.length, 0);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);
});

test('normal repair work is assigned before buffered maintenance', function () {
  reset(47000000, []);
  state.structuresByType[STRUCTURE_WALL][0].hits = 10000000;
  const plan = repairManager.buildPlan('E9N49', true);

  assert.strictEqual(plan.workList[0].maintenance, undefined);
  assert.strictEqual(plan.workList[1].maintenance, true);
});

test('buffered maintenance assignments carry maintenance metadata', function () {
  reset(47000000, []);
  const creep = {
    name: 'Repairer_E9N49_baseline_maintenance',
    spawning: false,
    ticksToLive: 500,
    memory: { role: 'repairer', homeRoom: 'E9N49' },
    room: Game.rooms.E9N49,
  };
  Game.creeps[creep.name] = creep;
  liveCreeps = [creep];

  repairManager.buildPlan('E9N49', true);

  assert.strictEqual(creep.memory.targetId, 'wall-1');
  assert.strictEqual(creep.memory.repairMaintenance, 1);
});

test('a low-TTL repairer is not replaced above the repair buffer', function () {
  reset(50000000, []);
  const name = 'Repairer_E9N49_baseline_maintenance';
  const creep = {
    name: name,
    spawning: false,
    ticksToLive: repairManager.constants.REPAIRER_REPLACEMENT_TTL,
    memory: { role: 'repairer', homeRoom: 'E9N49' },
    room: Game.rooms.E9N49,
  };
  Game.creeps[name] = creep;
  liveCreeps = [creep];

  repairManager.buildPlan('E9N49', true);

  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);
});

test('stalled repairer requests downsize below a high room capacity', function () {
  reset(10000000, []);
  const room = Game.rooms.E9N49;
  room.energyCapacityAvailable = 12900;
  room.energyAvailable = 1000;
  repairManager.buildPlan('E9N49', true);
  const request = Memory.repairSpawnRequests.E9N49[0];
  const originalCost = request.cost;

  Game.time = 1021;
  repairManager.buildPlan('E9N49', false);

  assert.strictEqual(originalCost, 3000);
  assert(request.cost < originalCost);
});

test('a repairer currently spawning occupies its desired slot', function () {
  const spawning = makeSpawn({ name: 'Repairer_E9N49_baseline_1' });
  reset(10000000, [spawning]);
  setPerimeter(squareRing(25, 25, 2), [spawning]);
  Memory.creeps.Repairer_E9N49_baseline_1 = {
    role: 'repairer',
    homeRoom: 'E9N49',
  };
  const plan = repairManager.buildPlan('E9N49', true);

  assert.strictEqual(plan.repairTier, 'PEACE');
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);
});

test('a low-TTL repairer gets a replacement baseline request', function () {
  reset(10000000, []);
  const name = 'Repairer_E9N49_baseline_old';
  const creep = {
    name: name,
    spawning: false,
    ticksToLive: repairManager.constants.REPAIRER_REPLACEMENT_TTL,
    memory: { role: 'repairer', homeRoom: 'E9N49' },
    room: Game.rooms.E9N49,
  };
  Game.creeps[name] = creep;
  liveCreeps = [creep];

  repairManager.buildPlan('E9N49', true);

  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].kind, 'baseline');
});

test('repair spawn phases are deterministic and room-specific', function () {
  reset(10000000, []);
  const interval = repairManager.constants.REPAIR_SPAWN_INTERVAL_TICKS;
  const rooms = ['E1N46', 'E2N46', 'E3N47', 'E4N49', 'W9N49'];
  const phases = rooms.map(function (roomName) {
    return repairManager.repairerSpawnPhase(roomName);
  });
  const uniquePhases = phases.filter(function (phase, index) {
    return phases.indexOf(phase) === index;
  });

  assert(uniquePhases.length > 1);
  for (let i = 0; i < rooms.length; i++) {
    Game.time = 1000 + phases[i];
    assert.strictEqual(repairManager.shouldAttemptRepairerSpawn(rooms[i]), true);
  }
  assert.strictEqual(interval, 10);
});

test('a cached plan never retires a pending repairer request', function () {
  reset(50000000, []);
  repairManager.buildPlan('E9N49', true);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);

  // A request that outlived the work that justified it. Only a freshly built
  // plan may retire it; a cached plan can be a whole cadence out of date, and
  // wiping on its say-so resets request age and starves the spawn-phase
  // age fallback.
  Memory.repairSpawnRequests.E9N49 = [
    {
      id: 'E9N49_baseline_0',
      role: 'repairer',
      kind: 'baseline',
      priority: 6,
      b: { work: 1, carry: 1, move: 1 },
      cost: 200,
      at: Game.time,
      ct: Game.time,
      r: 'E9N49',
      task: { k: 'target', r: 'E9N49', i: ['wall-1'] },
    },
  ];

  Game.time += 5;
  repairManager.buildPlan('E9N49', false);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49[0].at, 1000);

  // A forced rebuild still retires it.
  repairManager.buildPlan('E9N49', true);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);
});

test('a stale wartime plan is rebuilt when live damage appears', function () {
  reset(50000000, []);
  repairManager.buildPlan('E9N49', true);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);

  // Damage lands after the plan was cached, and the room is now contested, so
  // the wartime cadence would otherwise hold the stale plan for 50 ticks.
  state.structuresByType[STRUCTURE_WALL] = [
    makeWall(10000000, 'wall-1'),
    makeWall(10000000, 'wall-2'),
  ];
  state.hostiles = [{ owner: { username: 'Enemy' }, body: [{ type: WORK }] }];

  Game.time += 5;
  repairManager.buildPlan('E9N49', false);

  assert(Memory.repairSpawnRequests.E9N49.length >= 1);
});

test('defense repair orders are visible to the plan cache bypass', function () {
  reset(50000000, []);
  repairManager.buildPlan('E9N49', true);
  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 0);

  // medianRequests drive hasAnyWork, so the bypass check must weigh them too or
  // the plan never rebuilds and the request is never written.
  Memory.defense = { repairOrders: { E9N49: [{ clusterIds: ['wall-1'] }] } };

  Game.time += 5;
  repairManager.buildPlan('E9N49', false);

  assert.strictEqual(Memory.repairSpawnRequests.E9N49.length, 1);
});

console.log('Repair manager harness complete.');
