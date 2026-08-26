// LLM: Read docs/codex.js before reviewing or changing this file.
// test/supplier_lab_load_harness.js
// Dynamic route coverage for sequential multi-lab supplier loading.

const assert = require('assert');
const Module = require('module');
global.OK = 0;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_NOT_ENOUGH_RESOURCES = -6;
global.ERR_FULL = -8;
global.ERR_BUSY = -4;
global.ERR_TIRED = -11;
global.ERR_INVALID_TARGET = -7;
global.ERR_NO_PATH = -2;
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
global.STRUCTURE_ROAD = 'road';
global.STRUCTURE_RAMPART = 'rampart';
global.STRUCTURE_WALL = 'constructedWall';
global.FIND_STRUCTURES = 'structures';
global.TERRAIN_MASK_WALL = 1;
global.RoomPosition = function (x, y, roomName) {
  this.x = x;
  this.y = y;
  this.roomName = roomName;
};

const ROOM_NAME = 'W1N1';
const MINERAL = 'X';
const REACTION_AMOUNT = 5;
const STAGE_TARGET = 3000;
let fixture = null;
const roomStateStub = {
  init: function () {},
  get: function () {
    return fixture.roomState;
  },
};
const storageManagerStub = {
  storageFind: function () {
    const amount = fixture.source.state.amount;
    const terminalAmount = fixture.terminalState.amount;
    return {
      storage: { total: amount, reserved: 0, reservations: [] },
      terminal: { total: terminalAmount, reserved: 0, reservations: [] },
    };
  },
  consume: function () {
    return { ok: true };
  },
};
const labManagerStub = {
  getActiveOrder: function () {
    return fixture.order;
  },
  getSupplierLabTasks: function () {
    return fixture.buildSupplierTasks();
  },
  recordDelivery: function (roomName, resourceType, amount) {
    assert.strictEqual(roomName, ROOM_NAME);
    assert.strictEqual(resourceType, MINERAL);
    fixture.recorded += amount;
    if (fixture.order.type === 'breakdown') {
      fixture.order.remaining = Math.max(0, fixture.order.remaining - amount);
      fixture.order.compoundDelivered += amount;
    }
  },
};
const memoryManagerStub = {
  heap: { supplierWaypoints: {} },
  requestSave: function () {},
};
const factoryManagerStub = {};
const marketLabStub = {
  getRoomOperations: function () {
    return [];
  },
};
const terminalManagerStub = {};
const permanentRoomFactsStub = {};
const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const stubs = {
    getRoomState: roomStateStub,
    factoryManager: factoryManagerStub,
    labManager: labManagerStub,
    marketLab: marketLabStub,
    memoryManager: memoryManagerStub,
    storageManager: storageManagerStub,
    terminalManager: terminalManagerStub,
    permanentRoomFacts: permanentRoomFactsStub,
  };
  if (stubs[request]) return stubs[request];
  return originalModuleLoad.call(this, request, parent, isMain);
};
const roleSupplier = require('../roleSupplier');
Module._load = originalModuleLoad;

function makeStore(state, capacity, resource, rejectsWrongMineral) {
  const store = {};
  Object.defineProperty(store, resource, {
    enumerable: true,
    configurable: true,
    get: function () {
      return state.amount;
    },
    set: function (value) {
      state.amount = value;
    },
  });
  Object.defineProperties(store, {
    getUsedCapacity: {
      enumerable: false,
      value: function (resourceType) {
        if (!resourceType) return state.amount;
        if (rejectsWrongMineral && state.type && state.type !== resourceType) return 0;
        return resourceType === resource ? state.amount : 0;
      },
    },
    getFreeCapacity: {
      enumerable: false,
      value: function (resourceType) {
        if (rejectsWrongMineral && resourceType && state.type && state.type !== resourceType)
          return 0;
        return Math.max(0, capacity - state.amount);
      },
    },
    getCapacity: {
      enumerable: false,
      value: function () {
        return capacity;
      },
    },
  });
  return store;
}

function makeLab(id, index, fixtureState) {
  const state = { amount: 0, type: null, assigned: 0 };
  const lab = {
    id: id,
    structureType: STRUCTURE_LAB,
    my: true,
    pos: { x: 5 + index, y: 10, roomName: ROOM_NAME },
    state: state,
    store: makeStore(state, 3000, MINERAL, true),
  };
  Object.defineProperty(lab, 'mineralType', {
    enumerable: true,
    get: function () {
      return state.type;
    },
    set: function (value) {
      state.type = value;
    },
  });
  Object.defineProperty(lab, 'mineralAmount', {
    enumerable: true,
    get: function () {
      return state.amount;
    },
    set: function (value) {
      state.amount = value;
    },
  });
  fixtureState.objects[id] = lab;
  return lab;
}

function unpackAssignment(raw) {
  if (!raw) return null;
  const parts = raw.split('|');
  return {
    type: parts[0],
    taskId: parts[1],
    targetId: parts[2] || null,
    amount: +parts[3] || 0,
    extra: parts[5] || '',
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
  memoryManagerStub.heap = { supplierWaypoints: {} };
}

function createFixture(options) {
  resetRuntime();
  const config = Object.assign(
    {
      type: 'breakdown',
      processingAmount: 2450,
      labCount: 8,
      supplierCapacity: 1600,
      noTarget: false,
    },
    options || {}
  );
  const state = { objects: {} };
  const sourceState = { amount: config.processingAmount };
  const source = {
    id: 'storage_' + ROOM_NAME,
    structureType: 'storage',
    pos: { x: 10, y: 10, roomName: ROOM_NAME },
    state: sourceState,
    store: makeStore(sourceState, 10000, MINERAL, false),
  };
  state.objects[source.id] = source;
  const terminalState = { amount: 0 };
  const terminal = {
    id: 'terminal_' + ROOM_NAME,
    structureType: STRUCTURE_TERMINAL,
    pos: { x: 11, y: 10, roomName: ROOM_NAME },
    state: terminalState,
    store: makeStore(terminalState, 10000, MINERAL, false),
  };
  state.objects[terminal.id] = terminal;

  const labs = [];
  for (let i = 0; i < config.labCount; i++) labs.push(makeLab('lab' + (i + 1), i, state));

  const creepState = { amount: 0 };
  const creepStore = makeStore(creepState, config.supplierCapacity, MINERAL, false);
  const creep = {
    name: 'supplier1',
    id: 'supplier1',
    ticksToLive: 500,
    fatigue: 0,
    memory: { role: 'supplier', assignedRoom: ROOM_NAME, homeRoom: ROOM_NAME },
    room: null,
    pos: { x: source.pos.x, y: source.pos.y, roomName: ROOM_NAME },
    store: creepStore,
    intents: [],
    calls: { moveTo: [], transferAttempts: [], withdrawAttempts: [] },
    transfer: function (target, resourceType, amount) {
      const attempt = { target: target, resourceType: resourceType, amount: amount };
      this.calls.transferAttempts.push(attempt);
      if (fixture.failNextTransfer) {
        fixture.failNextTransfer = false;
        target.state.amount = 3000;
        target.state.type = resourceType;
        attempt.result = ERR_FULL;
        return ERR_FULL;
      }
      if ((target.store.getFreeCapacity(resourceType) || 0) <= 0) {
        attempt.result = ERR_FULL;
        return ERR_FULL;
      }
      attempt.result = OK;
      fixture.history.transfers.push({ targetId: target.id, amount: amount });
      this.intents.push({
        type: 'transfer',
        target: target,
        resourceType: resourceType,
        amount: amount,
      });
      return OK;
    },
    withdraw: function (target, resourceType, amount) {
      const attempt = { target: target, resourceType: resourceType, amount: amount };
      this.calls.withdrawAttempts.push(attempt);
      if (fixture.failNextWithdraw) {
        fixture.failNextWithdraw = false;
        if (fixture.drainSourceOnWithdrawRace) {
          fixture.sourceState.amount = 0;
          fixture.terminalState.amount = fixture.config.supplierCapacity;
        }
        attempt.result = ERR_NOT_ENOUGH_RESOURCES;
        return ERR_NOT_ENOUGH_RESOURCES;
      }
      if ((target.store.getUsedCapacity(resourceType) || 0) < amount) {
        attempt.result = ERR_NOT_ENOUGH_RESOURCES;
        return ERR_NOT_ENOUGH_RESOURCES;
      }
      if ((this.store.getFreeCapacity() || 0) < amount) {
        attempt.result = ERR_FULL;
        return ERR_FULL;
      }
      attempt.result = OK;
      fixture.history.withdraws.push({ amount: amount });
      this.intents.push({
        type: 'withdraw',
        target: target,
        resourceType: resourceType,
        amount: amount,
      });
      return OK;
    },
    moveTo: function (target) {
      this.calls.moveTo.push(target);
      return OK;
    },
    drop: function () {
      creepState.amount = 0;
      return OK;
    },
    suicide: function () {
      return OK;
    },
  };

  const room = {
    name: ROOM_NAME,
    controller: { my: true, level: 8 },
    memory: {},
    storage: source,
    terminal: terminal,
    getTerrain: function () {
      return {
        get: function () {
          return 0;
        },
      };
    },
    lookForAt: function () {
      return [];
    },
    find: function () {
      return [];
    },
    findExitTo: function () {
      return ERR_NO_PATH;
    },
  };
  creep.room = room;

  const order = {
    id: 'order1',
    type: config.type,
    origin: config.type === 'pipeline' ? null : 'marketLab',
    pipelineId: config.type === 'pipeline' ? 'pipeline1' : null,
    remaining: config.processingAmount,
    amount: config.processingAmount,
    compoundDelivered: 0,
    product: MINERAL,
    compound: MINERAL,
    evacuating: false,
    needsPreEvacuation: false,
  };

  fixture = {
    config: config,
    source: source,
    sourceState: sourceState,
    terminal: terminal,
    terminalState: terminalState,
    labs: labs,
    creep: creep,
    room: room,
    order: order,
    objects: state.objects,
    roomState: {
      structuresByType: { lab: labs },
      myCreeps: [creep],
      sources: [],
    },
    creepState: creepState,
    history: { transfers: [], withdraws: [] },
    recorded: 0,
    failNextTransfer: false,
    failNextWithdraw: false,
    drainSourceOnWithdrawRace: false,
    disableTasks: false,
  };

  fixture.buildSupplierTasks = function () {
    if (fixture.disableTasks) return [];
    const loaded = fixture.labs.reduce(function (total, lab) {
      return total + lab.state.amount;
    }, 0);
    const remaining = Math.max(0, config.processingAmount - loaded);
    let budget = Math.min(remaining, fixture.sourceState.amount, STAGE_TARGET);
    budget -= budget % REACTION_AMOUNT;
    if (budget <= 0) return [];

    const candidates = fixture.labs
      .filter(function (lab) {
        return (
          (!lab.mineralType || lab.mineralType === MINERAL) &&
          (lab.store.getFreeCapacity(MINERAL) || 0) > 0
        );
      })
      .map(function (lab) {
        return { lab: lab, amount: 0 };
      });
    while (budget >= REACTION_AMOUNT && candidates.length > 0) {
      candidates.sort(function (left, right) {
        const leftHave = left.lab.mineralAmount + left.amount;
        const rightHave = right.lab.mineralAmount + right.amount;
        return leftHave - rightHave || left.lab.id.localeCompare(right.lab.id);
      });
      candidates[0].amount += REACTION_AMOUNT;
      budget -= REACTION_AMOUNT;
    }

    return candidates
      .filter(function (candidate) {
        return candidate.amount > 0;
      })
      .map(function (candidate) {
        const target = candidate.lab.mineralAmount + candidate.amount;
        const extra =
          'res=' +
          MINERAL +
          ',lab=' +
          candidate.lab.id +
          (config.noTarget ? '' : ',target=' + target) +
          (config.noTarget ? ',pipeline=pipeline1' : ',record=1');
        return {
          type: 'lab_load',
          taskId: 'lab_load:' + order.id + ':' + candidate.lab.id,
          targetId: candidate.lab.id,
          amount: candidate.amount,
          priority: 56 - Math.min(candidate.amount, STAGE_TARGET) / 100000,
          extra: extra,
        };
      });
  };

  global.Memory = {};
  global.Game = {
    time: 1,
    rooms: { [ROOM_NAME]: room },
    creeps: { [creep.name]: creep },
    _objects: state.objects,
    gpl: { level: 0 },
    cpu: {
      getUsed: function () {
        return 1;
      },
      limit: 20,
      bucket: 10000,
    },
    getObjectById: function (id) {
      return state.objects[id] || null;
    },
  };
  return fixture;
}

function setCreepNear(target) {
  fixture.creep.pos.x = target.pos.x;
  fixture.creep.pos.y = target.pos.y;
  fixture.creep.pos.roomName = ROOM_NAME;
}

function applyIntents() {
  const intents = fixture.creep.intents.splice(0);
  for (let i = 0; i < intents.length; i++) {
    const intent = intents[i];
    if (intent.type === 'withdraw') {
      intent.target.state.amount -= intent.amount;
      fixture.creepState.amount += intent.amount;
    } else {
      intent.target.state.amount += intent.amount;
      intent.target.state.type = intent.resourceType;
      fixture.creepState.amount -= intent.amount;
    }
  }
}

function tick() {
  const assignment = unpackAssignment(fixture.creep.memory.a);
  const destination =
    fixture.creep.memory.s === 'delivering' && assignment
      ? fixture.objects[assignment.targetId]
      : fixture.source;
  if (destination) setCreepNear(destination);
  fixture.creep.intents = [];
  roleSupplier.run(fixture.creep);
  const result = {
    state: fixture.creep.memory.s,
    assignment: unpackAssignment(fixture.creep.memory.a),
    intent: fixture.creep.intents[0] || null,
  };
  applyIntents();
  Game.time++;
  return result;
}

function routeSnapshot() {
  const route = global._supHeap && global._supHeap[fixture.creep.name].labLoadRoute;
  return route
    ? route.map(function (entry) {
        return Object.assign({}, entry);
      })
    : [];
}

function total(values) {
  return values.reduce(function (sum, value) {
    return sum + value;
  }, 0);
}

function assertEvenDistribution(tasks) {
  const amounts = tasks.map(function (task) {
    return task.amount;
  });
  const smallest = Math.min.apply(Math, amounts);
  const largest = Math.max.apply(Math, amounts);
  assert.ok(largest - smallest <= REACTION_AMOUNT);
}

function testDynamicBreakdownRoute() {
  const processingAmount = 2450;
  const supplierCapacity = 1600;
  createFixture({
    type: 'breakdown',
    processingAmount: processingAmount,
    labCount: 8,
    supplierCapacity: supplierCapacity,
  });
  const initialTasks = fixture.buildSupplierTasks();
  assert.strictEqual(
    total(
      initialTasks.map(function (task) {
        return task.amount;
      })
    ),
    processingAmount
  );
  assertEvenDistribution(initialTasks);

  const firstFetch = tick();
  assert.strictEqual(firstFetch.intent.type, 'withdraw');
  assert.strictEqual(firstFetch.intent.amount, supplierCapacity);
  const initialRoute = routeSnapshot();
  assert.strictEqual(
    total(
      initialRoute.map(function (entry) {
        return entry.amount;
      })
    ),
    processingAmount
  );

  const expectedFirstTrip = [];
  let capacityLeft = supplierCapacity;
  for (let i = 0; i < initialRoute.length && capacityLeft > 0; i++) {
    const amount = Math.min(initialRoute[i].amount, capacityLeft);
    expectedFirstTrip.push({ targetId: initialRoute[i].targetId, amount: amount });
    capacityLeft -= amount;
  }

  const actualFirstTrip = [];
  let boundary = null;
  for (let guard = 0; guard < 30; guard++) {
    const result = tick();
    if (result.intent && result.intent.type === 'transfer') {
      actualFirstTrip.push({ targetId: result.intent.target.id, amount: result.intent.amount });
      if (result.state === 'fetching') {
        boundary = result;
        break;
      }
    }
  }
  assert.deepStrictEqual(actualFirstTrip, expectedFirstTrip);
  assert.strictEqual(
    total(
      actualFirstTrip.map(function (entry) {
        return entry.amount;
      })
    ),
    supplierCapacity
  );
  assert.strictEqual(boundary.state, 'fetching');
  const boundaryRoute = routeSnapshot();
  assert.ok(boundaryRoute.length > 0);
  assert.strictEqual(boundary.assignment.targetId, boundaryRoute[0].targetId);
  assert.strictEqual(boundary.assignment.amount, boundaryRoute[0].amount);
  assert.strictEqual(
    total(
      boundaryRoute.map(function (entry) {
        return entry.amount;
      })
    ),
    processingAmount - supplierCapacity
  );

  for (let guard = 0; guard < 30 && fixture.recorded < processingAmount; guard++) tick();
  assert.strictEqual(fixture.history.withdraws.length, 2);
  assert.strictEqual(fixture.recorded, processingAmount);
  assert.strictEqual(fixture.order.remaining, 0);
  assert.strictEqual(
    total(
      fixture.labs.map(function (lab) {
        return lab.mineralAmount;
      })
    ),
    processingAmount
  );
}

function testPipelineWithoutTarget() {
  const processingAmount = 2000;
  createFixture({
    type: 'pipeline',
    processingAmount: processingAmount,
    labCount: 2,
    supplierCapacity: 1600,
    noTarget: true,
  });
  const initialTasks = fixture.buildSupplierTasks();
  assert.strictEqual(
    total(
      initialTasks.map(function (task) {
        return task.amount;
      })
    ),
    processingAmount
  );
  assertEvenDistribution(initialTasks);
  tick();

  let boundary = null;
  for (let guard = 0; guard < 10; guard++) {
    const result = tick();
    if (result.intent && result.intent.type === 'transfer' && result.state === 'fetching') {
      boundary = result;
      break;
    }
  }
  assert.ok(boundary);
  assert.ok(boundary.assignment);
  assert.ok(boundary.assignment.amount > 0);
  assert.ok(routeSnapshot().length > 0);

  for (
    let guard = 0;
    guard < 20 &&
    total(
      fixture.labs.map(function (lab) {
        return lab.mineralAmount;
      })
    ) < processingAmount;
    guard++
  )
    tick();
  assert.strictEqual(fixture.history.withdraws.length, 2);
  assert.strictEqual(fixture.recorded, 0);
  assert.strictEqual(
    total(
      fixture.labs.map(function (lab) {
        return lab.mineralAmount;
      })
    ),
    processingAmount
  );
}

function testErrFullKeepsCargoAccountingClean() {
  createFixture({ type: 'breakdown', processingAmount: 1000, labCount: 2, supplierCapacity: 1600 });
  tick();
  const before = routeSnapshot();
  fixture.failNextTransfer = true;
  const failed = tick();
  const after = routeSnapshot();
  assert.strictEqual(failed.state, 'delivering');
  assert.strictEqual(fixture.recorded, 0);
  assert.strictEqual(after.length, before.length - 1);
  assert.strictEqual(unpackAssignment(fixture.creep.memory.a).targetId, after[0].targetId);
  assert.strictEqual(fixture.history.transfers.length, 0);
}

function testWithdrawRacePreservesRoute() {
  createFixture({ type: 'breakdown', processingAmount: 2450, labCount: 8, supplierCapacity: 1600 });
  fixture.failNextWithdraw = true;
  fixture.drainSourceOnWithdrawRace = true;
  const failed = tick();
  assert.strictEqual(failed.state, 'fetching');
  assert.ok(failed.assignment);
  assert.strictEqual(routeSnapshot().length, 8);
  assert.strictEqual(fixture.history.withdraws.length, 0);

  const retried = tick();
  assert.strictEqual(retried.intent.type, 'withdraw');
  assert.strictEqual(retried.intent.target.id, fixture.terminal.id);
  assert.strictEqual(fixture.history.withdraws.length, 1);
}

function testPipelineIdentityValidation() {
  createFixture({ type: 'pipeline', processingAmount: 2000, labCount: 2, supplierCapacity: 1600 });
  fixture.order.origin = 'marketLab';
  tick();
  assert.ok(routeSnapshot().length > 0);

  fixture.order.pipelineId = 'different-pipeline';
  fixture.disableTasks = true;
  const invalidated = tick();
  assert.strictEqual(invalidated.assignment, null);
  assert.strictEqual(routeSnapshot().length, 0);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  PASS ' + name);
    passed++;
  } catch (error) {
    console.error('  FAIL ' + name);
    console.error(error.stack || error);
    failed++;
  }
}

test(
  'dynamically distributes breakdown work and completes in two trips',
  testDynamicBreakdownRoute
);
test('partial pipeline load without target remains on the route', testPipelineWithoutTarget);
test('ERR_FULL advances without recording a delivery', testErrFullKeepsCargoAccountingClean);
test('withdraw races preserve the remaining lab route', testWithdrawRacePreservesRoute);
test('pipeline identity changes invalidate stale assignments', testPipelineIdentityValidation);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
