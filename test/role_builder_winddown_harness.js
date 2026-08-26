// LLM: Read docs/codex.js before reviewing or changing this file.
// test/role_builder_winddown_harness.js
// Focused mock coverage for builder low-TTL winddown behavior.

const assert = require('assert');
const Module = require('module');
global.OK = 0;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_FULL = -8;
global.RESOURCE_ENERGY = 'energy';
global.STRUCTURE_CONTAINER = 'container';
global.FIND_STRUCTURES = 'structures';
global.FIND_CONSTRUCTION_SITES = 'constructionSites';
const roomState = {
  init: function () {},
  get: function () {
    return {};
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'getRoomState') return roomState;
  if (request === 'util')
    return {
      nudgeOffRoomEdge: function () {
        return false;
      },
    };
  return originalLoad(request, parent, isMain);
};
const roleBuilder = require('../roleBuilder');
Module._load = originalLoad;
let objects = {};
global.Game = {
  getObjectById: function (id) {
    return objects[id] || null;
  },
  time: 1,
};
function makeTarget(structureType, free, x, y) {
  const target = {
    id: structureType + '_' + x + '_' + y,
    structureType: structureType,
    pos: { x: x, y: y, roomName: 'W1N1' },
    free: free,
  };
  target.store = {
    getFreeCapacity: function () {
      return target.free;
    },
  };
  return target;
}

function makeCreep(opts) {
  opts = opts || {};
  objects = {};
  const state = { energy: opts.energy || 0, capacity: opts.capacity || 100 };
  const calls = { transfer: [], moveTo: [], drop: 0, suicide: 0, build: 0 };
  const storage = opts.storage || null;
  const terminal = opts.terminal || null;
  const containers = opts.containers || [];
  const constructionSites = opts.constructionSites || [];
  const x = opts.x === undefined ? 10 : opts.x;
  const y = opts.y === undefined ? 10 : opts.y;
  const store = {};
  Object.defineProperty(store, RESOURCE_ENERGY, {
    enumerable: true,
    get: function () {
      return state.energy;
    },
    set: function (value) {
      state.energy = value;
    },
  });
  store.getUsedCapacity = function () {
    return state.energy;
  };
  store.getFreeCapacity = function () {
    return state.capacity - state.energy;
  };
  const pos = {
    x: x,
    y: y,
    roomName: 'W1N1',
    getRangeTo: function (target) {
      const targetPos = target.pos || target;
      return Math.max(Math.abs(x - targetPos.x), Math.abs(y - targetPos.y));
    },
    inRangeTo: function (target, range) {
      return this.getRangeTo(target) <= range;
    },
  };
  const room = {
    name: 'W1N1',
    storage: storage,
    terminal: terminal,
    find: function (findType, opts) {
      let list;
      if (findType === FIND_CONSTRUCTION_SITES) list = constructionSites;
      else if (findType === FIND_STRUCTURES) list = containers;
      else list = [];
      if (opts && opts.filter) return list.filter(opts.filter);
      return list;
    },
  };
  const task = opts.task;
  if (task && task.targetId && opts.taskTarget) objects[task.targetId] = opts.taskTarget;
  const creep = {
    id: opts.id || 'builder-id',
    name: opts.name || 'builder',
    memory: { role: opts.role || 'builder', filling: false },
    ticksToLive: opts.ticksToLive === undefined ? 50 : opts.ticksToLive,
    room: room,
    pos: pos,
    fatigue: 0,
    store: store,
    transfer: function (target, resourceType) {
      calls.transfer.push({ target: target, resourceType: resourceType });
      if (!pos.inRangeTo(target, 1)) return ERR_NOT_IN_RANGE;
      const free = target.store.getFreeCapacity(resourceType);
      if (free <= 0) return ERR_FULL;
      const amount = Math.min(state.energy, free);
      state.energy -= amount;
      target.free -= amount;
      return OK;
    },
    moveTo: function (target) {
      calls.moveTo.push(target);
      return OK;
    },
    drop: function () {
      calls.drop++;
      state.energy = 0;
      return OK;
    },
    suicide: function () {
      calls.suicide++;
      return OK;
    },
    build: function () {
      calls.build++;
      return OK;
    },
  };
  if (task) creep.memory.task = task;
  return { creep: creep, calls: calls, state: state, room: room };
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    passed++;
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err.stack || err);
    failed++;
  }
}

test('suicides when empty and a valid storage target exists', function () {
  const storage = makeTarget('storage', 1000, 10, 10);
  const fixture = makeCreep({ storage: storage, energy: 0 });
  roleBuilder.run(fixture.creep);
  assert.strictEqual(fixture.calls.suicide, 1);
  assert.strictEqual(fixture.calls.transfer.length, 0);
});

test('transfers energy to adjacent storage', function () {
  const storage = makeTarget('storage', 1000, 10, 10);
  const fixture = makeCreep({ storage: storage, energy: 50 });
  roleBuilder.run(fixture.creep);
  assert.strictEqual(fixture.calls.transfer.length, 1);
  assert.strictEqual(fixture.calls.transfer[0].resourceType, RESOURCE_ENERGY);
  assert.strictEqual(fixture.state.energy, 0);
  assert.strictEqual(fixture.calls.suicide, 0);
});

test('moves toward storage when out of range', function () {
  const storage = makeTarget('storage', 1000, 20, 10);
  const fixture = makeCreep({ storage: storage, energy: 50 });
  roleBuilder.run(fixture.creep);
  assert.strictEqual(fixture.calls.transfer.length, 1);
  assert.strictEqual(fixture.calls.moveTo.length, 1);
  assert.strictEqual(fixture.calls.moveTo[0], storage);
  assert.strictEqual(fixture.state.energy, 50);
});

test('uses an open container when storage and terminal are unavailable', function () {
  const container = makeTarget(STRUCTURE_CONTAINER, 1000, 10, 10);
  const fixture = makeCreep({ containers: [container], energy: 50 });
  roleBuilder.run(fixture.creep);
  assert.strictEqual(fixture.calls.transfer.length, 1);
  assert.strictEqual(fixture.calls.transfer[0].target, container);
});

test('ages out without dropping or suiciding when no target exists', function () {
  const carrying = makeCreep({ energy: 50 });
  roleBuilder.run(carrying.creep);
  assert.strictEqual(carrying.calls.drop, 0);
  assert.strictEqual(carrying.calls.suicide, 0);

  const empty = makeCreep({ energy: 0 });
  roleBuilder.run(empty.creep);
  assert.strictEqual(empty.calls.suicide, 0);
});

test('does not wind down while a construction site exists', function () {
  const site = {
    id: 'site-1',
    pos: { x: 10, y: 10, roomName: 'W1N1' },
    progress: 0,
    progressTotal: 100,
  };
  const fixture = makeCreep({
    energy: 50,
    constructionSites: [site],
    task: { type: 'build', targetId: site.id },
    taskTarget: site,
  });
  roleBuilder.run(fixture.creep);
  assert.strictEqual(fixture.calls.build, 1);
  assert.strictEqual(fixture.calls.suicide, 0);
});

test('never winds down a remoteBuilder', function () {
  const storage = makeTarget('storage', 1000, 10, 10);
  const site = {
    id: 'remote-site-1',
    pos: { x: 10, y: 10, roomName: 'W1N1' },
    progress: 0,
    progressTotal: 100,
  };
  const fixture = makeCreep({
    role: 'remoteBuilder',
    storage: storage,
    energy: 50,
    task: { type: 'build', targetId: site.id },
    taskTarget: site,
  });
  roleBuilder.run(fixture.creep);
  assert.strictEqual(fixture.calls.build, 1);
  assert.strictEqual(fixture.calls.transfer.length, 0);
  assert.strictEqual(fixture.calls.suicide, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
