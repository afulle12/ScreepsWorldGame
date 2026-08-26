// LLM: Read docs/codex.js before reviewing or changing this file.
// test/centralized_stockpile_harness.js
// Focused runtime contract tests for the centralized stockpile manager.

const assert = require('assert');
const Module = require('module');
const path = require('path');
global.RESOURCE_ENERGY = 'energy';
global.RESOURCE_OPS = 'ops';
global.RESOURCE_GHODIUM = 'G';
global.RESOURCE_BATTERY = 'battery';
global.STRUCTURE_NUKER = 'nuker';
global.STRUCTURE_FACTORY = 'factory';
global.STRUCTURE_LAB = 'lab';
global.OK = 0;
global.LAB_REACTION_AMOUNT = 5;
global.REACTIONS = {
  H: { O: 'OH' },
  O: { H: 'OH' },
};

function makeStore(values, capacity) {
  const store = Object.assign({}, values || {});
  const storeCapacity = capacity || 300000;
  store.getUsedCapacity = function (resource) {
    if (resource) return store[resource] || 0;
    return Object.keys(store).reduce(function (total, key) {
      return typeof store[key] === 'number' ? total + store[key] : total;
    }, 0);
  };
  store.getFreeCapacity = function () {
    return Math.max(0, storeCapacity - store.getUsedCapacity());
  };
  return store;
}

global.Memory = {};
global.Game = {
  time: 1000,
  rooms: {},
  market: { orders: {} },
  cpu: {
    getUsed: function () {
      return 1;
    },
  },
};

const roomStates = {};
const reservations = {};
const externalRequests = {};
const buyRecords = {};
let lastMarketBuyAmount = 0;
function reservationList(roomName, building, resource) {
  const key = roomName + '/' + building + '/' + resource;
  if (!reservations[key]) reservations[key] = [];
  return reservations[key];
}

function resourceInfo(roomName, resource) {
  const room = Game.rooms[roomName];
  function buildingInfo(building) {
    const object = room && room[building];
    const total = object && object.store ? object.store[resource] || 0 : 0;
    const list = reservationList(roomName, building, resource);
    const reserved = list.reduce(function (value, entry) {
      return value + (entry.amount || 0);
    }, 0);
    return { total: total, reserved: reserved, available: total - reserved, reservations: list };
  }
  const terminal = buildingInfo('terminal');
  const storage = buildingInfo('storage');
  return {
    terminal: terminal,
    storage: storage,
    combined: {
      total: terminal.total + storage.total,
      reserved: terminal.reserved + storage.reserved,
      available: terminal.available + storage.available,
    },
  };
}

const storageManager = {
  storageFind: resourceInfo,
  reserve: function (roomName, resource, building, program, amount) {
    const list = reservationList(roomName, building, resource);
    const existing = list.find(function (entry) {
      return entry.program === program;
    });
    const otherReserved = list.reduce(function (value, entry) {
      return value + (entry.program === program ? 0 : entry.amount || 0);
    }, 0);
    const room = Game.rooms[roomName];
    const actual =
      room && room[building] && room[building].store ? room[building].store[resource] || 0 : 0;
    if (amount > actual - otherReserved) return { ok: false, reason: 'overbooked' };
    if (existing) existing.amount = amount;
    else list.push({ program: program, amount: amount, time: Game.time });
    return { ok: true };
  },
  unReserve: function (roomName, resource, building, program) {
    const list = reservationList(roomName, building, resource);
    for (let index = list.length - 1; index >= 0; index--) {
      if (list[index].program === program) list.splice(index, 1);
    }
    return { ok: true };
  },
  getReservationRecords: function (roomName, program) {
    const records = [];
    for (const key in reservations) {
      const parts = key.split('/');
      if (roomName && parts[0] !== roomName) continue;
      const list = reservations[key] || [];
      for (let index = 0; index < list.length; index++) {
        const entry = list[index];
        if (program && entry.program !== program) continue;
        records.push({
          roomName: parts[0],
          building: parts[1],
          material: parts[2],
          program: entry.program,
          amount: entry.amount,
          time: entry.time,
        });
      }
    }
    return records;
  },
  getUnreserved: function (roomName) {
    const info = {};
    for (const building of ['terminal', 'storage']) {
      info[building] = {};
      const room = Game.rooms[roomName];
      const store = room && room[building] && room[building].store;
      if (!store) continue;
      for (const resource in store) {
        const value = resourceInfo(roomName, resource)[building].available;
        if (value > 0) info[building][resource] = value;
      }
    }
    return info;
  },
};
const memoryManager = {
  requestSave: function () {},
  requestImmediateSave: function () {},
  compactMarketLabOperation: function (operation) {
    return operation;
  },
  hydrateMarketLabRoot: function () {},
  heap: {},
};
const marketPricing = {
  executableBuyQuote: function (resource, amount) {
    if (resource === 'OH') return { price: 3, amount: amount, transferEnergy: 0 };
    if (resource === 'PARTIAL')
      return { price: 1, amount: Math.max(1, amount - 1), transferEnergy: 0 };
    return null;
  },
  passiveBuyPrice: function (resource) {
    return resource === 'U' ? 2 : 0;
  },
  getInputBuyQuote: function (resource) {
    return resource === 'H' || resource === 'O'
      ? { price: 1, source: 'REFERENCE_ASK' }
      : { price: 0, source: 'NONE' };
  },
  getStatusEnergyPrice: function () {
    return 1;
  },
};
const marketLab = {
  startStockpileOperation: function () {
    return { ok: true, operationId: 'op1' };
  },
  getCommittedSaleOutputs: function () {
    return {};
  },
  getRoomQueueState: function () {
    return { slotsFree: 3, pending: [] };
  },
  getOperations: function () {
    return [];
  },
};
const marketRefine = {
  getCommittedSaleOutputs: function () {
    return {};
  },
  getOperations: function () {
    return [];
  },
};
const economics = {
  mintJobId: function () {
    return 'econ1';
  },
  start: function () {},
  phase: function () {},
  link: function () {},
};
const marketBuy = {
  getOrderRecordFor: function (roomName, resource, queue, opId) {
    return buyRecords[opId] || null;
  },
  marketBuy: function (roomName, resource, amount) {
    lastMarketBuyAmount = amount;
    return '[MarketBuy] Created BUY order';
  },
  getFulfilled: function (record) {
    return (record && record.fulfilledFinal) || 0;
  },
};
const opportunisticBuy = {
  setup: function () {
    return 'queued';
  },
  getRequest: function (roomName, resource) {
    return externalRequests[roomName + '_' + resource] || null;
  },
};
const terminalManager = {
  transferStuff: function (fromRoom, toRoom, resource, amount, accountingSource) {
    if (!Memory.terminalManager) Memory.terminalManager = { operations: [] };
    Memory.terminalManager.operations.push({
      id: 'overflowOp_' + Game.time,
      type: 'transfer',
      fromRoom: fromRoom,
      toRoom: toRoom,
      resourceType: resource,
      amount: amount,
      status: 'pending',
      accountingSource: accountingSource,
    });
    return '[Terminal] Transfer order created';
  },
};
const roomSuspender = {
  shouldAvoidRoomWork: function () {
    return false;
  },
};
const terminalUtil = {
  wasTerminalUsed: function () {
    return false;
  },
  markTerminalUsed: function () {},
  calcTransactionCost: function () {
    return 10;
  },
};
const spawnManager = {};
const singleSourceRoom = {
  isSingleSourceActive: function () {
    return false;
  },
};
const labCommodityPolicy = {
  MIN_REACTION_AMOUNT: 5,
  isTwoLetterLabProduct: function () {
    return false;
  },
};
const labCommodityRouter = {};
const labReactionPipeline = {};
const marketBatchBuy = {};
const marketSell = {};
const labManager = {};
const dependencyStubs = {
  storageManager: storageManager,
  getRoomState: {
    ownedNames: function () {
      return Object.keys(roomStates);
    },
    get: function (roomName) {
      return roomStates[roomName] || null;
    },
  },
  marketPricing: marketPricing,
  memoryManager: memoryManager,
  marketLab: marketLab,
  marketRefine: marketRefine,
  terminalManager: terminalManager,
  marketEconomics: economics,
  marketBuy: marketBuy,
  opportunisticBuy: opportunisticBuy,
  roomSuspender: roomSuspender,
  util: terminalUtil,
  spawnManager: spawnManager,
  singleSourceRoom: singleSourceRoom,
  labCommodityPolicy: labCommodityPolicy,
  labCommodityRouter: labCommodityRouter,
  labReactionPipeline: labReactionPipeline,
  marketBatchBuy: marketBatchBuy,
  marketSell: marketSell,
  labManager: labManager,
};
const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (
    parent &&
    parent.filename &&
    parent.filename.indexOf(projectRoot) === 0 &&
    dependencyStubs[request]
  ) {
    return dependencyStubs[request];
  }
  return originalModuleLoad.apply(this, arguments);
};

function resetEnvironment() {
  global.Memory = {};
  global.Game.time = 1000;
  global.Game.rooms = {};
  for (const key in reservations) delete reservations[key];
  for (const key in externalRequests) delete externalRequests[key];
  for (const key in buyRecords) delete buyRecords[key];
  lastMarketBuyAmount = 0;
  for (const key in roomStates) delete roomStates[key];
  const store = { energy: 1000, H: 5, O: 5, U: 0, G: 10000 };
  global.Game.rooms.W1N1 = {
    name: 'W1N1',
    controller: { my: true, level: 8 },
    storage: { store: makeStore(store) },
    terminal: { store: makeStore({ energy: 1000 }) },
  };
  roomStates.W1N1 = {
    isOwned: true,
    controller: { level: 8 },
    terminal: global.Game.rooms.W1N1.terminal,
    structuresByType: {
      nuker: [{ store: makeStore({ G: 5000 }) }],
      lab: [],
    },
    hostiles: [],
  };
}

resetEnvironment();
const stockpileManager = require('../stockpileManager');
let actualMarketLab = null;
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    resetEnvironment();
    fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (error) {
    console.error('  ✗ ' + name);
    console.error(error);
    failed++;
  }
}

test('cheapestRoute prefers existing inventory and then low-cost production', function () {
  const inventory = stockpileManager.cheapestRoute('H', 5, 'W1N1');
  assert.strictEqual(inventory.kind, 'inventory');
  const route = stockpileManager.cheapestRoute('OH', 5, 'W1N1');
  assert.strictEqual(route.kind, 'make');
  assert.strictEqual(route.inputs[0].kind, 'inventory');
  assert.strictEqual(route.inputs[1].kind, 'inventory');
});

test('thin market depth does not become an executable quote', function () {
  const route = stockpileManager.cheapestRoute('U', 5, 'W1N1');
  assert.strictEqual(route.kind, 'buy');
  assert.strictEqual(route.pending, true);
  assert.strictEqual(route.quote.source, 'POSTED_BUY');
  assert.strictEqual(route.quote.complete, false);
});

test('partial executable depth does not become a complete route', function () {
  const route = stockpileManager.cheapestRoute('PARTIAL', 5, 'W1N1');
  assert.strictEqual(route.kind, 'unavailable');
});

test('active boost demand and pending purchase are not double-counted', function () {
  Memory.boostManager = {
    orders: {
      W1N1: {
        upgrader: {
          active: true,
          batchSize: 1,
          boosts: { XGHO2: { parts: 1, labIds: [] } },
        },
      },
    },
  };
  externalRequests.W1N1_XGHO2 = { remaining: 30 };
  const deficits = stockpileManager.calculateDeficits().filter(function (entry) {
    return entry.resource === 'XGHO2';
  });
  assert.strictEqual(deficits.length, 1);
  assert.strictEqual(deficits[0].deficit, 11970);
});

test('closed partial buy records are retried for only the remaining amount', function () {
  Memory.stockpileManager = {
    v: 1,
    enabled: true,
    mode: 'active',
    targets: {},
    requests: {},
    jobs: {
      job1: {
        id: 'job1',
        resource: 'U',
        amount: 5,
        roomName: 'W1N1',
        baseline: 0,
        fulfilled: 0,
        state: 'buying',
        purchaseQueue: 'marketBuy',
        route: { kind: 'buy', quote: { price: 1, effectivePrice: 1 } },
        children: [],
      },
    },
    nextId: 1,
    lastRun: 0,
    lastPlan: Game.time,
  };
  buyRecords.job1 = { done: true, fulfilledFinal: 2 };
  stockpileManager.run();
  assert.strictEqual(Memory.stockpileManager.jobs.job1.state, 'buying');
  assert.strictEqual(lastMarketBuyAmount, 3);
});

test('failed parent jobs release descendant handoff reservations', function () {
  Memory.stockpileManager = {
    v: 1,
    enabled: true,
    mode: 'active',
    targets: {},
    requests: {},
    jobs: {
      parent: {
        id: 'parent',
        resource: 'OH',
        amount: 5,
        roomName: 'W1N1',
        state: 'queued',
        route: { kind: 'make', inputs: [] },
        children: ['child'],
      },
      child: {
        id: 'child',
        resource: 'H',
        amount: 5,
        roomName: 'W1N1',
        parentId: 'parent',
        state: 'failed',
        route: { kind: 'buy' },
        children: [],
      },
    },
    nextId: 1,
    lastRun: 0,
    lastPlan: 0,
  };
  storageManager.reserve('W1N1', 'H', 'storage', 'stockpileHandoff_child', 5);
  stockpileManager.processJob(Memory.stockpileManager.jobs.parent);
  assert.strictEqual(Memory.stockpileManager.jobs.parent.state, 'failed');
  assert.strictEqual(
    (reservations['W1N1/storage/H'] || []).some(function (entry) {
      return entry.program === 'stockpileHandoff_child';
    }),
    false
  );
});

test('overflow queues bounded non-energy transfers and persists reconciliation state', function () {
  Game.rooms.W1N1.storage.store = makeStore({ energy: 1000, Z: 805000 }, 1000000);
  Game.rooms.W2N2 = {
    name: 'W2N2',
    controller: { my: true, level: 8 },
    storage: { store: makeStore({}, 1000000) },
    terminal: { store: makeStore({ energy: 1000 }, 300000) },
  };
  roomStates.W2N2 = {
    isOwned: true,
    controller: { level: 8 },
    terminal: Game.rooms.W2N2.terminal,
    structuresByType: { nuker: [], lab: [], factory: [] },
    hostiles: [],
  };
  assert.strictEqual(stockpileManager.processOverflow(), 1);
  const transferIds = Object.keys(Memory.stockpileManager.transfers);
  assert.strictEqual(transferIds.length, 1);
  const transfer = Memory.stockpileManager.transfers[transferIds[0]];
  assert.strictEqual(transfer.resource, 'Z');
  assert.strictEqual(transfer.amount, 6000);
  assert.strictEqual(stockpileManager.processOverflow(), 0);
  Memory.terminalManager.operations[0].status = 'completed';
  Game.rooms.W1N1.storage.store.Z = 0;
  stockpileManager.processOverflow();
  assert.strictEqual(Object.keys(Memory.stockpileManager.transfers).length, 0);
});

test('GHODIUM target accounts for nuker stock while reserving external floor', function () {
  stockpileManager.reconcileReservations();
  const reservation = reservations['W1N1/storage/G'].find(function (entry) {
    return entry.program === 'stockpileManager';
  });
  assert.strictEqual(reservation.amount, 10000);
  assert.strictEqual(
    stockpileManager.calculateDeficits().some(function (entry) {
      return entry.resource === 'G';
    }),
    false
  );
});

test('factory-held batteries count toward the room target', function () {
  roomStates.W1N1.structuresByType.factory = [{ store: makeStore({ battery: 10000 }) }];
  const deficits = stockpileManager.calculateDeficits().filter(function (entry) {
    return entry.resource === 'battery';
  });
  assert.strictEqual(deficits.length, 0);
});

test('room and empire reservations are additive for overlapping targets', function () {
  Game.rooms.W1N1.storage.store.XGHO2 = 12000;
  stockpileManager.requestBoost('W1N1', 'XGHO2', 3000);
  stockpileManager.reconcileReservations();
  const entries = reservations['W1N1/storage/XGHO2'];
  assert.strictEqual(
    entries.reduce(function (total, entry) {
      return total + entry.amount;
    }, 0),
    12000
  );
  assert.strictEqual(
    entries.some(function (entry) {
      return entry.program === 'stockpileManager';
    }),
    true
  );
  assert.strictEqual(
    entries.some(function (entry) {
      return entry.program === 'stockpileManagerEmpire';
    }),
    true
  );
});

test('MarketLab compaction preserves stockpile mode and derives a storage sink', function () {
  const actualMemoryManager = require('../memoryManager');
  const operation = actualMemoryManager.compactMarketLabOperation(
    {
      id: 'op1',
      targetCompound: 'OH',
      state: 'BUYING',
      batchSize: 5,
      tickStarted: Game.time,
      stockpile: true,
      handoffInputPrograms: { H: 'stockpileHandoff_child' },
    },
    'forward'
  );
  assert.strictEqual(operation.stockpile, true);
  assert.strictEqual(operation.origin, 'marketLab');
  assert.strictEqual(operation.sink, 'storage');
  assert.strictEqual(operation.noSell, true);
  assert.strictEqual(operation.handoffInputPrograms.H, 'stockpileHandoff_child');
});

test('MarketLab stockpile adapter persists the flag and allows one queued slot', function () {
  roomStates.W1N1.structuresByType.lab = [
    {
      pos: {
        inRangeTo: function () {
          return true;
        },
      },
    },
    {
      pos: {
        inRangeTo: function () {
          return true;
        },
      },
    },
    {
      pos: {
        inRangeTo: function () {
          return true;
        },
      },
    },
  ];
  const stub = dependencyStubs.marketLab;
  delete dependencyStubs.marketLab;
  actualMarketLab = require('../marketLab');
  dependencyStubs.marketLab = stub;
  const first = actualMarketLab.startStockpileOperation('forward', 'W1N1', 'OH', {}, 'job1', {
    batchSize: 5,
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(actualMarketLab.getOperations()[0].stockpile, true);
  const second = actualMarketLab.startStockpileOperation('forward', 'W1N1', 'OH', {}, 'job2', {
    batchSize: 5,
  });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.state, 'PENDING');
  const third = actualMarketLab.startStockpileOperation('forward', 'W1N1', 'OH', {}, 'job3', {
    batchSize: 5,
  });
  assert.strictEqual(third.ok, false);
});

function setMarketLabCommitment(operation) {
  Memory.marketLabForward = { version: 9, rooms: { W1N1: [operation] } };
  Memory.marketLabReverse = { version: 9, rooms: {} };
  dependencyStubs.marketLab = actualMarketLab;
}

test('market sale commitments shield only the unreserved output from the stockpile floor', function () {
  setMarketLabCommitment({
    id: 'sale-op',
    direction: 'forward',
    targetCompound: 'G',
    reagents: ['H', 'O'],
    state: 'SELLING',
    origin: 'marketLab',
    expectedOutputs: { G: 1090 },
    sellingStartTick: Game.time,
  });
  stockpileManager.reconcileReservations();
  const reservation = reservations['W1N1/storage/G'].find(function (entry) {
    return entry.program === 'stockpileManager';
  });
  assert.strictEqual(reservation.amount, 8910);
  dependencyStubs.marketLab = marketLab;
});

test('market sell reservations are not double-counted in the floor shield', function () {
  setMarketLabCommitment({
    id: 'sale-op',
    direction: 'forward',
    targetCompound: 'G',
    reagents: ['H', 'O'],
    state: 'SELLING',
    origin: 'marketLab',
    expectedOutputs: { G: 1090 },
    sellingStartTick: Game.time,
  });
  storageManager.reserve('W1N1', 'G', 'storage', 'marketLabSell_sale-op', 1090);
  stockpileManager.reconcileReservations();
  const reservation = reservations['W1N1/storage/G'].find(function (entry) {
    return entry.program === 'stockpileManager';
  });
  assert.strictEqual(reservation.amount, 8910);
  dependencyStubs.marketLab = marketLab;
});

test('stockpile, handoff, stale, pending, and buying operations do not shield a floor', function () {
  const cases = [
    { stockpile: true },
    { handoffResource: 'G' },
    { sellingStartTick: Game.time - 5001 },
    { state: 'PENDING' },
    { state: 'BUYING' },
  ];
  for (let i = 0; i < cases.length; i++) {
    resetEnvironment();
    const operation = Object.assign({
      id: 'sale-op-' + i,
      direction: 'forward',
      targetCompound: 'G',
      reagents: ['H', 'O'],
      state: 'SELLING',
      origin: 'marketLab',
      expectedOutputs: { G: 1090 },
      sellingStartTick: Game.time,
    }, cases[i]);
    setMarketLabCommitment(operation);
    stockpileManager.reconcileReservations();
    const reservation = reservations['W1N1/storage/G'].find(function (entry) {
      return entry.program === 'stockpileManager';
    });
    assert.strictEqual(reservation.amount, 10000);
  }
  dependencyStubs.marketLab = marketLab;
});

test('reverse market operations commit their reagent outputs', function () {
  setMarketLabCommitment({
    id: 'reverse-op',
    direction: 'reverse',
    targetCompound: 'G',
    reagents: ['H', 'O'],
    state: 'SELLING',
    origin: 'marketLab',
    expectedOutputs: { H: 1090, O: 1090 },
    sellingStartTick: Game.time,
  });
  assert.deepStrictEqual(actualMarketLab.getCommittedSaleOutputs('W1N1'), { H: 1090, O: 1090 });
  dependencyStubs.marketLab = marketLab;
});

test('stockpile jobs report their queue position when production is pending', function () {
  const oldStart = marketLab.startStockpileOperation;
  const oldQueueState = marketLab.getRoomQueueState;
  marketLab.startStockpileOperation = function () {
    return { ok: true, operationId: 'pending-op', state: 'PENDING' };
  };
  marketLab.getRoomQueueState = function () {
    return { slotsFree: 1, pending: [{ id: 'pending-op' }, { id: 'later-op' }] };
  };
  const job = {
    id: 'job-pending',
    resource: 'OH',
    amount: 5,
    roomName: 'W1N1',
    state: 'queued',
    route: { kind: 'make', inputs: [] },
  };
  stockpileManager.processJob(job);
  assert.strictEqual(job.state, 'producing');
  assert.strictEqual(job.lastResult, 'queued in W1N1 behind 0 op(s)');
  marketLab.startStockpileOperation = oldStart;
  marketLab.getRoomQueueState = oldQueueState;
});

test('terminal transfer rechecks hostile source state immediately before send', function () {
  const terminalManager = require('../terminalManager');
  let sends = 0;
  Game.rooms.W1N1.terminal.store.U = 100;
  Game.rooms.W1N1.terminal.send = function () {
    sends++;
    return OK;
  };
  const operation = {
    type: 'transfer',
    fromRoom: 'W1N1',
    toRoom: 'W2N2',
    resourceType: 'U',
    amount: 100,
    amountTransferred: 0,
    status: 'pending',
  };
  roomStates.W1N1.hostiles = [{}];
  terminalManager.processTransfer(operation);
  assert.strictEqual(sends, 0);
  assert.strictEqual(operation.status, 'waiting');
  roomStates.W1N1.hostiles = [];
  roomStates.W2N2 = { hostiles: [{}] };
  terminalManager.processTransfer(operation);
  assert.strictEqual(sends, 0);
  assert.strictEqual(operation.error, 'Transfer paused while destination room has hostiles');
  roomStates.W2N2.hostiles = [];
  terminalManager.processTransfer(operation);
  assert.strictEqual(sends, 1);
  assert.strictEqual(operation.status, 'completed');
});

test('v1 job memory migrates to the compact v2 schema', function () {
  // A v1 route: every node carried the full recipe subtree plus a fat market quote,
  // and every child job stored its own copy of the same subtree.
  function legacyRoute(resource, depth) {
    const quote = {
      amount: 12000,
      requested: 12000,
      complete: true,
      price: 0.42,
      total: 5040,
      rawTotal: 5040,
      effectivePrice: 0.44,
      transferEnergy: 120,
      source: 'EXECUTABLE_ASK',
    };
    if (depth <= 0) {
      return { kind: 'buy', resource: resource, amount: 12000, cost: 5040, quote: quote };
    }
    return {
      kind: 'make',
      resource: resource,
      amount: 12000,
      cost: 10080,
      inputs: [legacyRoute(resource + 'a', depth - 1), legacyRoute(resource + 'b', depth - 1)],
    };
  }
  function legacyJob(id, resource, parentId, depth) {
    const route = legacyRoute(resource, depth);
    const job = {
      id: id,
      resource: resource,
      amount: 12000,
      roomName: 'W1N1',
      scope: 'empire',
      parentId: parentId || null,
      handoffProgram: parentId ? 'stockpileHandoff_' + id : null,
      route: route,
      state: 'queued',
      baseline: 0,
      fulfilled: 0,
      children: [],
      created: Game.time,
      updated: Game.time,
    };
    jobs[id] = job;
    if (depth > 0) {
      for (let i = 0; i < route.inputs.length; i++) {
        const childId = id + '_' + i;
        const child = legacyJob(childId, route.inputs[i].resource, id, depth - 1);
        job.children.push(child.id);
        route.inputs[i].childId = child.id;
        route.inputs[i].handoffProgram = child.handoffProgram;
      }
    }
    return job;
  }

  const jobs = {};
  legacyJob('stockpileJob_50000000_1', 'XGHO2', null, 3);
  Memory.stockpileManager = {
    v: 1,
    enabled: false,
    mode: 'observe',
    targets: { XGHO2: 12000, XZH2O: 12000 },
    requests: {},
    jobs: jobs,
    transfers: {},
    nextId: 99,
    lastRun: 0,
    lastPlan: 0,
  };
  const before = JSON.stringify(Memory.stockpileManager).length;

  stockpileManager.calculateDeficits();

  const mem = Memory.stockpileManager;
  const after = JSON.stringify(mem).length;
  assert.strictEqual(mem.v, 3);
  assert.strictEqual(mem.targets, undefined);
  const root = mem.jobs['stockpileJob_50000000_1'];
  assert.strictEqual(root.scope, undefined, 'empire scope is the omitted default');
  assert.strictEqual(root.route.quote, undefined, 'fat quotes are dropped');
  assert.strictEqual(root.route.inputs.length, 2);
  assert.strictEqual(root.route.inputs[0].inputs, undefined, 'nested subtrees are dropped');
  assert.strictEqual(root.route.inputs[0].childId, 'stockpileJob_50000000_1_0');
  assert.strictEqual(root.route.inputs[0].handoffProgram, undefined);
  const leaf = mem.jobs['stockpileJob_50000000_1_0_0_0'];
  assert.strictEqual(leaf.handoffProgram, undefined, 'handoff programs are derived from the job id');
  assert.strictEqual(leaf.route.price, 0.42);
  assert.strictEqual(leaf.route.effectivePrice, 0.44);
  assert.strictEqual(leaf.fulfilled, undefined);
  assert.strictEqual(leaf.created, undefined, 'the job id already encodes the creation tick');
  assert.strictEqual(leaf.children, undefined);
  assert.ok(after * 2 < before, 'v2 schema is at least 2x smaller (' + before + ' -> ' + after + ')');
  console.log('    v1 ' + before + ' bytes -> v2 ' + after + ' bytes (' +
    (100 - Math.round((after / before) * 100)) + '% smaller)');
});

test('v2 migration keeps room scope and inherits it for scopeless children', function () {
  Memory.stockpileManager = {
    v: 1,
    enabled: false,
    mode: 'observe',
    targets: {},
    requests: {},
    jobs: {
      root: { id: 'root', resource: 'OH', amount: 5, roomName: 'W1N1', scope: 'room', state: 'queued', route: { kind: 'make', inputs: [] }, children: ['kid'] },
      kid: { id: 'kid', resource: 'H', amount: 5, roomName: 'W1N1', parentId: 'root', state: 'queued', route: { kind: 'buy' }, children: [] },
      loner: { id: 'loner', resource: 'K', amount: 5, roomName: 'W1N1', scope: 'empire', state: 'queued', route: { kind: 'buy' }, children: [] },
    },
    transfers: {},
    nextId: 1,
    lastRun: 0,
    lastPlan: 0,
  };
  stockpileManager.calculateDeficits();
  const jobs = Memory.stockpileManager.jobs;
  assert.strictEqual(jobs.root.scope, 'room');
  assert.strictEqual(jobs.kid.scope, 'room', 'a scopeless child inherits its parent scope');
  assert.strictEqual(jobs.loner.scope, undefined, 'empire is the omitted default');
});

test('v3 upgrade does not re-infer scopes that v2 already resolved to empire', function () {
  Memory.stockpileManager = {
    v: 2,
    enabled: false,
    mode: 'observe',
    // An active request for the same room+resource is what inferLegacyJobScope keys
    // off; a v2 job that already settled on empire must not be dragged back to room.
    requests: { 'W1N1|U': { roomName: 'W1N1', compound: 'U', amount: 100, active: true } },
    jobs: {
      settled: { id: 'settled', resource: 'U', amount: 5, roomName: 'W1N1', state: 'queued', route: { kind: 'buy', price: 1 }, created: 123, updated: Game.time },
    },
    transfers: {},
    nextId: 1,
    lastRun: 0,
    lastPlan: 0,
  };
  stockpileManager.calculateDeficits();
  const job = Memory.stockpileManager.jobs.settled;
  assert.strictEqual(Memory.stockpileManager.v, 3);
  assert.strictEqual(job.scope, undefined, 'empire stays empire across the v3 upgrade');
  assert.strictEqual(job.created, undefined);
  assert.strictEqual(job.route.price, 1, 'an already-trimmed route survives untouched');
});

test('failed jobs keep releasing derived handoff reservations after migration', function () {
  Memory.stockpileManager = {
    v: 1,
    enabled: true,
    mode: 'active',
    jobs: {
      parent: {
        id: 'parent',
        resource: 'OH',
        amount: 5,
        roomName: 'W1N1',
        state: 'queued',
        route: { kind: 'make', inputs: [{ resource: 'H', childId: 'child', quote: { price: 2 } }] },
        children: ['child'],
      },
      child: {
        id: 'child',
        resource: 'H',
        amount: 5,
        roomName: 'W1N1',
        parentId: 'parent',
        handoffProgram: 'stockpileHandoff_child',
        state: 'failed',
        route: { kind: 'buy' },
        children: [],
      },
    },
    requests: {},
    transfers: {},
    nextId: 1,
    lastRun: 0,
    lastPlan: 0,
  };
  storageManager.reserve('W1N1', 'H', 'storage', 'stockpileHandoff_child', 5);
  stockpileManager.processJob(Memory.stockpileManager.jobs.parent);
  assert.strictEqual(Memory.stockpileManager.jobs.child.handoffProgram, undefined);
  assert.strictEqual(
    (reservations['W1N1/storage/H'] || []).some(function (entry) {
      return entry.program === 'stockpileHandoff_child';
    }),
    false
  );
});

test('terminal jobs shed their execution payload once they go quiet', function () {
  Memory.stockpileManager = {
    v: 2,
    enabled: true,
    mode: 'active',
    jobs: {
      old: {
        id: 'old',
        resource: 'U',
        amount: 5,
        roomName: 'W1N1',
        state: 'done',
        baseline: 10,
        fulfilled: 5,
        created: Game.time - 400,
        updated: Game.time - 400,
        economicsJobId: 'econ_1',
        operationId: 'op_1',
        purchaseQueue: 'marketBuy',
        lastResult: 'ok',
        route: { kind: 'buy', price: 1 },
      },
      fresh: {
        id: 'fresh',
        resource: 'K',
        amount: 5,
        roomName: 'W1N1',
        state: 'failed',
        baseline: 0,
        updated: Game.time - 1,
        operationId: 'op_2',
        route: { kind: 'buy', price: 1 },
      },
    },
    requests: {},
    transfers: {},
    nextId: 1,
    lastRun: 0,
    lastPlan: Game.time,
  };
  stockpileManager.run();
  const jobs = Memory.stockpileManager.jobs;
  assert.strictEqual(jobs.old.route, undefined);
  assert.strictEqual(jobs.old.operationId, undefined);
  assert.strictEqual(jobs.old.economicsJobId, undefined);
  assert.strictEqual(jobs.old.lastResult, undefined);
  assert.strictEqual(jobs.old.state, 'done', 'the pruning trail itself survives');
  assert.strictEqual(jobs.fresh.route.kind, 'buy', 'recently failed jobs stay intact');
  assert.strictEqual(jobs.fresh.operationId, 'op_2');
});

test('the root job backlog is capped so deficits cannot outrun the drain rate', function () {
  // Fillers sit in a hostile room: they count as active roots but processExistingJobs
  // skips them, so only the intake cap decides whether W1N1 gets new work.
  roomStates.W3N3 = { isOwned: true, hostiles: [{}], structuresByType: {} };
  function seedRoots(count) {
    const jobs = {};
    for (let i = 0; i < count; i++) {
      jobs['filler' + i] = {
        id: 'filler' + i,
        resource: 'XGHO2',
        amount: 3000,
        roomName: 'W3N3',
        state: 'buying',
        route: { kind: 'buy', price: 1 },
        updated: Game.time,
      };
    }
    Memory.stockpileManager = {
      v: 2,
      enabled: true,
      mode: 'active',
      requests: {},
      jobs: jobs,
      transfers: {},
      nextId: 1,
      lastRun: 0,
      lastPlan: 0,
    };
    return count;
  }

  const atCap = seedRoots(16);
  stockpileManager.run();
  assert.strictEqual(Object.keys(Memory.stockpileManager.jobs).length, atCap,
    'no new roots are started while the backlog is at the cap');

  seedRoots(15);
  stockpileManager.run();
  assert.ok(Object.keys(Memory.stockpileManager.jobs).length > 15,
    'a freed slot lets the next deficit start work');
});

test('stockpileJobs reports idle state when memory has no active work', function () {
  resetEnvironment();
  Memory.stockpileManager = {
    v: 3,
    enabled: true,
    mode: 'observe',
    requests: {},
    jobs: {},
    transfers: {},
    nextId: 1,
    lastRun: 0,
    lastPlan: 0,
  };

  const output = stockpileManager.jobs();
  assert.ok(output.includes('[Stockpile Active Work] mode=observe'));
  assert.ok(output.includes('0 active root jobs'));
  assert.ok(output.includes('No active jobs or transfers.'));
});

test('stockpileJobs formats active reaction trees, lab operations, and sub-job dependencies', function () {
  resetEnvironment();
  Memory.stockpileManager = {
    v: 3,
    enabled: true,
    mode: 'active',
    requests: {},
    jobs: {
      sj1: {
        id: 'sj1',
        resource: 'XGHO2',
        amount: 3000,
        roomName: 'W1N1',
        state: 'queued',
        children: ['sj2', 'sj3'],
        updated: 1000,
      },
      sj2: {
        id: 'sj2',
        resource: 'GHO2',
        amount: 3000,
        roomName: 'W1N1',
        state: 'producing',
        parentId: 'sj1',
        operationId: '42',
        updated: 1000,
      },
      sj3: {
        id: 'sj3',
        resource: 'X',
        amount: 3000,
        roomName: 'W1N1',
        state: 'buying',
        parentId: 'sj1',
        purchaseQueue: ['ord1'],
        updated: 1000,
      },
    },
    transfers: {},
    nextId: 4,
    lastRun: 1000,
    lastPlan: 1000,
  };

  const output = global.stockpileJobs();
  assert.ok(output.includes('* sj1 [QUEUED] 3,000 XGHO2 @ W1N1 (waiting on 2 sub-jobs)'), 'formats root job with waiting info');
  assert.ok(output.includes('sj2 [PRODUCING] 3,000 GHO2 @ W1N1 (lab op #42)'), 'formats producing child with lab op');
  assert.ok(output.includes('sj3 [BUYING] 3,000 X @ W1N1 (1 buy order)'), 'formats buying child with buy order count');
});

test('stockpileJobs formats active transfers and boost requests, and stockpileStatus(true) appends jobs', function () {
  resetEnvironment();
  Memory.stockpileManager = {
    v: 3,
    enabled: true,
    mode: 'active',
    requests: {
      'W1N1|XGHO2': {
        roomName: 'W1N1',
        compound: 'XGHO2',
        amount: 3000,
        priority: 'high',
        active: true,
        updated: 1000,
      },
    },
    jobs: {},
    transfers: {
      ov1: {
        fromRoom: 'W1N1',
        toRoom: 'W2N2',
        resource: 'Z',
        amount: 10000,
        status: 'queued',
        terminalOpId: 99,
        created: 1000,
      },
    },
    nextId: 2,
    lastRun: 1000,
    lastPlan: 1000,
  };

  const output = global.stockpileJobs();
  assert.ok(output.includes('-- Inter-Room Transfers --'));
  assert.ok(output.includes('* ov1 [QUEUED] 10,000 Z: W1N1 -> W2N2 (terminal op: #99)'));
  assert.ok(output.includes('-- Boost Requests --'));
  assert.ok(output.includes('* W1N1: 3,000 XGHO2 (active: true, priority: high)'));

  const statusVerbose = global.stockpileStatus(true);
  assert.ok(statusVerbose.includes('[Stockpile] enabled=true'));
  assert.ok(statusVerbose.includes('[Stockpile Active Work]'));
});

Module._load = originalModuleLoad;
console.log('\nCentralized stockpile harness: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) process.exitCode = 1;
