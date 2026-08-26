// LLM: Read docs/codex.js before reviewing or changing this file.
// test/market_lab_queue_harness.js
// Focused contract tests for marketLab room admission and promotion queues.

const assert = require('assert');
const Module = require('module');
const path = require('path');

global.OK = 0;
global.ORDER_BUY = 'buy';
global.ORDER_SELL = 'sell';
global.RESOURCE_ENERGY = 'energy';
global.STRUCTURE_LAB = 'lab';
global.REACTIONS = {
  H: { O: 'G', K: 'OH' },
  O: { H: 'G' },
  K: { H: 'OH' },
};
global.LAB_REACTION_AMOUNT = 5;

const roomStates = {};
const phaseCalls = [];
const dependencyStubs = {};
const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;

function makeStore(values) {
  const store = Object.assign({}, values || {});
  store.getUsedCapacity = function (resource) {
    if (resource) return store[resource] || 0;
    return Object.keys(store).reduce(function (total, key) {
      return typeof store[key] === 'number' ? total + store[key] : total;
    }, 0);
  };
  return store;
}

const memoryManager = {
  heap: {},
  requestSave: function () {},
  requestImmediateSave: function () {},
  compactMarketLabOperation: function (operation) {
    return operation;
  },
  hydrateMarketLabRoot: function () {},
};
const storageManager = {
  storageFind: function (roomName, resource) {
    const room = Game.rooms[roomName];
    const terminal = room && room.terminal;
    const storage = room && room.storage;
    return {
      terminal: { total: terminal && terminal.store[resource] || 0, reserved: 0, reservations: [] },
      storage: { total: storage && storage.store[resource] || 0, reserved: 0, reservations: [] },
      combined: { total: terminal && terminal.store[resource] || 0 + (storage && storage.store[resource] || 0), reserved: 0 },
    };
  },
  reserve: function () { return { ok: true }; },
  unReserve: function () { return { ok: true }; },
};
const getRoomState = {
  ownedNames: function () { return Object.keys(roomStates); },
  get: function (roomName) { return roomStates[roomName] || null; },
  creepIndex: function () { return { all: [] }; },
};
const opportunisticBuy = {
  getRequest: function () { return null; },
  cancelRequest: function () {},
};
const marketBuyer = {
  getOrderRecordFor: function () { return null; },
  getFulfilled: function () { return 0; },
  cancelOrdersForProduct: function () {},
  cancelOrderFor: function () {},
};
const marketSeller = {
  getActiveOwnedSellOrders: function () { return []; },
  getRequests: function () { return []; },
  syncReservations: function () {},
  beginReservationBatch: function () {},
  endReservationBatch: function () {},
  marketSell: function () { return '[MarketSell] Created SELL order'; },
};
const marketBatchBuy = {
  STATE_QUEUED: 'QUEUED',
  STATE_PENDING: 'PENDING',
  STATE_DONE: 'DONE',
  STATE_FAILED: 'FAILED',
  STATE_CANCELLED: 'CANCELLED',
  find: function () { return null; },
  cancel: function () { return true; },
  create: function () { return { ok: true, id: 'batch_1' }; },
};
const labManager = {
  getLayout: function () { return { groups: [{}] }; },
  roomHasPendingOrder: function () { return false; },
  getActiveOrder: function () { return null; },
};
const roomSuspender = {
  shouldAvoidRoomWork: function () { return false; },
};
const labCommodityPolicy = {
  MIN_REACTION_AMOUNT: 5,
  isTwoLetterLabProduct: function () { return false; },
};
const labCommodityRouter = {};
const labReactionPipeline = {
  roomSupportsAdvanced: function () { return { ok: true }; },
};
const pricing = {
  getAvg48h: function () { return 1; },
  passiveSellPrice: function () { return 1; },
};
const terminalManager = {
  getRoomAvailableOutsideTerminal: function () { return 0; },
};
const economics = {
  phase: function (jobId, phase) { phaseCalls.push({ jobId: jobId, phase: phase }); },
  get: function () { return null; },
  finish: function () {},
};

Object.assign(dependencyStubs, {
  memoryManager: memoryManager,
  storageManager: storageManager,
  getRoomState: getRoomState,
  opportunisticBuy: opportunisticBuy,
  marketBuy: marketBuyer,
  marketSell: marketSeller,
  marketBatchBuy: marketBatchBuy,
  labManager: labManager,
  roomSuspender: roomSuspender,
  labCommodityPolicy: labCommodityPolicy,
  labCommodityRouter: labCommodityRouter,
  labReactionPipeline: labReactionPipeline,
  marketPricing: pricing,
  terminalManager: terminalManager,
  marketEconomics: economics,
  autoTrader: {},
});

Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.indexOf(projectRoot) === 0 && dependencyStubs[request]) {
    return dependencyStubs[request];
  }
  if (request === 'util' && parent && parent.filename && parent.filename.indexOf(projectRoot) === 0) {
    return {
      getOrderRemaining: function (order) {
        return order && typeof order.remainingAmount === 'number' ? Math.max(0, order.remainingAmount) : 0;
      },
      calcTransactionCost: function () { return 0; },
    };
  }
  return originalModuleLoad.apply(this, arguments);
};

const marketLab = require('../marketLab');

let generation = 0;
function resetEnvironment(roomNames) {
  generation++;
  global.Memory = {};
  global.Game = {
    time: 1000 + generation * 100,
    rooms: {},
    market: { orders: {}, outgoingTransactions: [] },
    cpu: { getUsed: function () { return 1; }, limit: 20, bucket: 10000 },
  };
  for (const roomName in roomStates) delete roomStates[roomName];
  phaseCalls.length = 0;
  const names = roomNames || ['E4N49', 'E4N47'];
  for (let i = 0; i < names.length; i++) {
    const roomName = names[i];
    const labs = [];
    for (let n = 0; n < 3; n++) {
      labs.push({ pos: { inRangeTo: function () { return true; } } });
    }
    const room = {
      name: roomName,
      controller: { my: true, level: 8 },
      storage: { store: makeStore({ H: 10000, O: 10000, K: 10000, G: 0 }) },
      terminal: { store: makeStore({ H: 10000, O: 10000, K: 10000, G: 0 }) },
    };
    Game.rooms[roomName] = room;
    roomStates[roomName] = {
      isOwned: true,
      controller: { my: true, level: 8 },
      terminal: room.terminal,
      storage: room.storage,
      structuresByType: { lab: labs },
      hostiles: [],
    };
  }
}

function rawOperations(direction, roomName) {
  const root = direction === 'forward' ? Memory.marketLabForward : Memory.marketLabReverse;
  return root && root.rooms && root.rooms[roomName] || [];
}

function rawOperation(direction, roomName, id) {
  const operations = rawOperations(direction, roomName);
  for (let i = 0; i < operations.length; i++) if (operations[i] && operations[i].id === id) return operations[i];
  return null;
}

function startAuto(direction, roomName, compound, jobId) {
  const result = marketLab.startAutoOperation(direction, roomName, compound, {}, jobId || direction + '_' + compound + '_' + Game.time);
  assert.ok(typeof result === 'string' && result.indexOf('Queued:') >= 0, result);
  const operations = marketLab.getOperations(direction);
  for (let i = operations.length - 1; i >= 0; i--) {
    if (operations[i] && operations[i].room === roomName && operations[i].targetCompound === compound && operations[i].tickStarted === Game.time) return operations[i];
  }
  throw new Error('new market operation not found: ' + result);
}

function startStockpile(roomName, compound, jobId) {
  const result = marketLab.startStockpileOperation('forward', roomName, compound, {}, jobId || 'stockpile_' + compound + '_' + Game.time);
  assert.strictEqual(result.ok, true, result.message);
  return marketLab.getOperations('forward').filter(function (operation) {
    return operation && operation.id === result.operationId;
  })[0];
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  resetEnvironment();
  try {
    fn();
    console.log('  PASS ' + name);
    passed++;
  } catch (error) {
    console.error('  FAIL ' + name);
    console.error(error);
    failed++;
  }
}

test('a room buy-slot collision is admitted as PENDING', function () {
  const running = startAuto('forward', 'E4N49', 'G', 'auto_1');
  const queued = startAuto('forward', 'E4N49', 'G', 'auto_2');
  assert.strictEqual(running.state, 'BUYING');
  assert.strictEqual(queued.state, 'PENDING');
  assert.strictEqual(typeof queued.pendingSince, 'number');
});

test('one running operation and two same-compound pending operations coexist', function () {
  startAuto('forward', 'E4N49', 'G', 'auto_1');
  const stockpile = startStockpile('E4N49', 'G', 'stock_1');
  Game.time += 10;
  const auto = startAuto('forward', 'E4N49', 'G', 'auto_2');
  const state = marketLab.getRoomQueueState('E4N49');
  assert.strictEqual(state.slotsUsed, 3);
  assert.strictEqual(state.pending.length, 2);
  assert.strictEqual(state.pending[0].id, stockpile.id);
  assert.strictEqual(state.pending[1].id, auto.id);
});

test('a fourth operation is rejected when all three room slots are used', function () {
  startAuto('forward', 'E4N49', 'G', 'auto_1');
  startStockpile('E4N49', 'G', 'stock_1');
  startAuto('forward', 'E4N49', 'G', 'auto_2');
  const result = marketLab.startAutoOperation('forward', 'E4N49', 'G', {}, 'auto_3');
  assert.ok(result.indexOf('limit reached') >= 0, result);
  assert.strictEqual(marketLab.getRoomQueueState('E4N49').slotsUsed, 3);
});

test('FIFO promotes stockpile first when it queued first', function () {
  const running = startAuto('forward', 'E4N49', 'G', 'auto_running');
  rawOperation('forward', 'E4N49', running.id).state = 'PROCESSING';
  Game.time += 10;
  const stockpile = startStockpile('E4N49', 'G', 'stock_first');
  Game.time += 10;
  const auto = startAuto('forward', 'E4N49', 'G', 'auto_second');
  Game.time += 1;
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N49', stockpile.id).state, 'BUYING');
  assert.strictEqual(rawOperation('forward', 'E4N49', auto.id).state, 'PENDING');
  rawOperation('forward', 'E4N49', stockpile.id).state = 'PROCESSING';
  Game.time++;
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N49', auto.id).state, 'BUYING');
});

test('FIFO promotes autoTrader first when it queued first', function () {
  const running = startAuto('forward', 'E4N49', 'G', 'auto_running');
  rawOperation('forward', 'E4N49', running.id).state = 'PROCESSING';
  Game.time += 10;
  const auto = startAuto('forward', 'E4N49', 'G', 'auto_first');
  Game.time += 10;
  const stockpile = startStockpile('E4N49', 'G', 'stock_second');
  Game.time++;
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N49', auto.id).state, 'BUYING');
  assert.strictEqual(rawOperation('forward', 'E4N49', stockpile.id).state, 'PENDING');
});

test('a running operation is not preempted and only one operation promotes per room', function () {
  const running = startAuto('forward', 'E4N49', 'G', 'auto_running');
  const first = startStockpile('E4N49', 'G', 'stock_first');
  const second = startAuto('forward', 'E4N49', 'G', 'auto_second');
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N49', running.id).state, 'BUYING');
  assert.strictEqual(rawOperation('forward', 'E4N49', first.id).state, 'PENDING');
  assert.strictEqual(rawOperation('forward', 'E4N49', second.id).state, 'PENDING');
  rawOperation('forward', 'E4N49', running.id).state = 'PROCESSING';
  Game.time++;
  marketLab.promoteRoomQueues();
  const state = marketLab.getRoomQueueState('E4N49');
  assert.strictEqual(state.pending.length, 1);
  assert.strictEqual(state.buying !== null, true);
});

test('same-tick pending ties use lexical operation id', function () {
  const running = startAuto('forward', 'E4N49', 'G', 'auto_running');
  rawOperation('forward', 'E4N49', running.id).state = 'PROCESSING';
  const first = startAuto('forward', 'E4N49', 'G', 'auto_first');
  const second = startAuto('forward', 'E4N49', 'G', 'auto_second');
  const expected = [first.id, second.id].sort()[0];
  assert.strictEqual(marketLab.getRoomQueueState('E4N49').pending[0].id, expected);
});

test('empire buying ownership holds a same-compound operation in PENDING', function () {
  const owner = startAuto('forward', 'E4N49', 'G', 'owner');
  const waiting = startAuto('forward', 'E4N47', 'G', 'waiting');
  assert.strictEqual(rawOperation('forward', 'E4N49', owner.id).state, 'BUYING');
  assert.strictEqual(rawOperation('forward', 'E4N47', waiting.id).state, 'PENDING');
  Game.time++;
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N47', waiting.id).state, 'PENDING');
  rawOperation('forward', 'E4N49', owner.id).state = 'PROCESSING';
  Game.time++;
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N47', waiting.id).state, 'BUYING');
});

test('skip-ahead promotes an unblocked compound behind a blocked head', function () {
  const owner = startAuto('forward', 'E4N49', 'G', 'owner');
  const blocked = startAuto('forward', 'E4N47', 'G', 'blocked');
  const other = startAuto('forward', 'E4N47', 'OH', 'other');
  assert.strictEqual(marketLab.getRoomQueueState('E4N47').pending[0].id, blocked.id);
  Game.time++;
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N47', blocked.id).state, 'PENDING');
  assert.strictEqual(rawOperation('forward', 'E4N47', other.id).state, 'BUYING');
  rawOperation('forward', 'E4N47', other.id).state = 'PROCESSING';
  rawOperation('forward', 'E4N49', owner.id).state = 'PROCESSING';
  Game.time++;
  marketLab.promoteRoomQueues();
  assert.strictEqual(rawOperation('forward', 'E4N47', blocked.id).state, 'BUYING');
});

test('buying age remains paused while PENDING and starts on promotion', function () {
  const running = startAuto('forward', 'E4N49', 'G', 'auto_running');
  const queued = startAuto('forward', 'E4N49', 'G', 'auto_queued');
  Game.time += 100;
  assert.strictEqual(marketLab.getBuyingAge(queued), 0);
  rawOperation('forward', 'E4N49', running.id).state = 'PROCESSING';
  Game.time++;
  marketLab.promoteRoomQueues();
  const promoted = marketLab.getOperations('forward').filter(function (operation) { return operation.id === queued.id; })[0];
  assert.strictEqual(promoted.state, 'BUYING');
  Game.time += 10;
  assert.strictEqual(marketLab.getBuyingAge(promoted), 10);
});

test('pending TTL cancels an expired operation instead of promoting it', function () {
  const operation = {
    id: 'expired',
    direction: 'forward',
    origin: 'marketLab',
    targetCompound: 'G',
    reagents: ['H', 'O'],
    state: 'PENDING',
    tickStarted: Game.time - 4000,
    pendingSince: Game.time - 3001,
    batchSize: 3000,
    outputLabCount: 1,
    batchBuyIds: [],
  };
  Memory.marketLabForward = { version: 9, rooms: { E4N49: [operation] } };
  Memory.marketLabReverse = { version: 9, rooms: {} };
  Game.time += 1;
  marketLab.runForward();
  assert.strictEqual(marketLab.getOperations('forward').some(function (entry) { return entry.id === 'expired'; }), false);
});

test('PENDING survives compact and hydrate with its appended state code', function () {
  const actualMemoryManager = require('../memoryManager');
  const compacted = actualMemoryManager.compactMarketLabOperation({
    id: 'pending-op',
    targetCompound: 'G',
    state: 'PENDING',
    batchSize: 3000,
    tickStarted: Game.time,
    pendingSince: Game.time,
  }, 'forward');
  assert.strictEqual(compacted.state, 'PENDING');
  const root = { rooms: { E4N49: [compacted.toJSON()] } };
  actualMemoryManager.hydrateMarketLabRoot(root, 'forward');
  assert.strictEqual(root.rooms.E4N49[0].state, 'PENDING');
});

Module._load = originalModuleLoad;
console.log('\nMarket lab queue harness: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) process.exitCode = 1;
