// LLM: Read docs/codex.js before reviewing or changing this file.
// test/terminal_recovery_harness.js
// Dependency-free regression tests for stale terminal-gather recovery.

const assert = require('assert');
const Module = require('module');
const path = require('path');
global.OK = 0;
global.ORDER_SELL = 'sell';
global.RESOURCE_ENERGY = 'energy';
global.RESOURCE_OPS = 'ops';
global.RESOURCE_BATTERY = 'battery';
global.RESOURCE_MIST = 'mist';
global.Memory = {};
global.Game = {
  time: 1000,
  rooms: {},
  market: { orders: {} },
};
const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;
const reservationsReleased = [];
const storageManagerStub = {
  storageFind: function (roomName, resourceType) {
    const room = Game.rooms[roomName];
    const amount =
      room && room.storage && room.storage.store ? room.storage.store[resourceType] || 0 : 0;
    return {
      terminal: {
        total: (room && room.terminal && room.terminal.store[resourceType]) || 0,
        available: 0,
      },
      storage: { total: amount, available: amount, reservations: [] },
    };
  },
  unReserve: function (roomName, resourceType, building, program) {
    reservationsReleased.push({ roomName, resourceType, building, program });
    return { ok: true };
  },
};
const memoryManagerStub = {
  compactMarketSellRequest: function (request) {
    request.__marketSellRequest = true;
    return request;
  },
  requestImmediateSave: function () {},
  requestSave: function () {},
};
const utilStub = {
  getOrderRemaining: function (order) {
    return typeof order.remainingAmount === 'number' ? order.remainingAmount : order.amount || 0;
  },
};
const terminalManagerDependencies = {
  getRoomState: {
    get: function () {
      return null;
    },
    init: function () {},
  },
  singleSourceRoom: {
    isSingleSourceActive: function () {
      return false;
    },
  },
  storageManager: storageManagerStub,
  spawnManager: {},
  roomSuspender: {
    shouldAvoidRoomWork: function () {
      return false;
    },
  },
  util: utilStub,
  memoryManager: memoryManagerStub,
};
const marketSellerDependencies = {
  terminalManager: null,
  pricing: { FEE: 0.05 },
  util: utilStub,
  storageManager: storageManagerStub,
  memoryManager: memoryManagerStub,
  creditLedger: {
    available: function () {
      return 1000000;
    },
    commit: function () {},
  },
  autoTraderSellPolicy: {
    getFloor: function () {
      return 0;
    },
    hasConfiguredFloors: function () {
      return false;
    },
    applyFloor: function (resourceType, price) {
      return price;
    },
  },
  labCommodityPolicy: {
    isTwoLetterLabProduct: function () {
      return false;
    },
  },
};
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.indexOf(projectRoot) === 0) {
    if (request === 'terminalManager') {
      if (marketSellerDependencies.terminalManager) return marketSellerDependencies.terminalManager;
      return terminalManagerDependencies[request];
    }
    if (terminalManagerDependencies[request]) return terminalManagerDependencies[request];
    if (marketSellerDependencies[request]) return marketSellerDependencies[request];
  }
  return originalModuleLoad.apply(this, arguments);
};
const terminalManager = require('../terminalManager');
marketSellerDependencies.terminalManager = terminalManager;
const marketSeller = require('../marketSell');
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  [32m[1mPASS[0m ' + name);
    passed++;
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err);
    failed++;
  }
}

test('active zero-progress local gathers become stale from their creation tick', function () {
  Game.time = 2500;
  const operation = {
    id: 'local_stale',
    type: 'toTerminal',
    status: 'active',
    amount: 100,
    amountMoved: 0,
    created: 1000,
  };

  assert.strictEqual(terminalManager.isOperationStale(operation, 1000), true);
});

test('progress resets the stale timer', function () {
  Game.time = 1000;
  const operation = {
    id: 'local_progress',
    type: 'toTerminal',
    status: 'active',
    amount: 100,
    amountMoved: 0,
    created: 0,
  };

  assert.strictEqual(terminalManager.isOperationStale(operation, 1000), true);

  Game.time = 1001;
  operation.amountMoved = 25;
  assert.strictEqual(terminalManager.isOperationStale(operation, 1000), false);

  Game.time = 2000;
  assert.strictEqual(terminalManager.isOperationStale(operation, 1000), false);
  Game.time = 2001;
  assert.strictEqual(terminalManager.isOperationStale(operation, 1000), true);
});

test('maintenance cancels an active zero-progress local gather', function () {
  Game.time = 4000;
  Memory.terminalManager = {
    operations: [
      {
        id: 'local_active_stale',
        type: 'toTerminal',
        roomName: 'E9N49',
        resourceType: RESOURCE_MIST,
        amount: 814,
        amountMoved: 0,
        status: 'active',
        created: 2000,
      },
    ],
  };

  let cancelled = null;
  terminalManager.cancelOperation = function (operationId) {
    cancelled = operationId;
    Memory.terminalManager.operations = [];
  };
  terminalManager.checkAndCancelStuckWaits(5000);

  assert.strictEqual(cancelled, 'local_active_stale');
  assert.strictEqual(Memory.terminalManager.operations.length, 0);
});

test('stale market coverage keeps the order and relinks a replacement gather', function () {
  Game.time = 5000;
  reservationsReleased.length = 0;
  Game.rooms = {
    E9N47: {
      terminal: { store: { mist: 0 } },
      storage: { store: { mist: 4560 } },
    },
  };
  Game.market.orders = {
    order_mist: {
      id: 'order_mist',
      type: ORDER_SELL,
      roomName: 'E9N47',
      resourceType: RESOURCE_MIST,
      remainingAmount: 2687,
      totalAmount: 2687,
      active: false,
    },
  };
  Memory.marketSell = {
    v: 2,
    requests: [
      {
        __marketSellRequest: true,
        roomName: 'E9N47',
        resourceType: RESOURCE_MIST,
        amount: 2687,
        created: 1000,
        orderId: 'order_mist',
        tmOpId: 'local_stale',
      },
    ],
  };
  Memory.terminalManager = {
    operations: [
      {
        id: 'local_stale',
        type: 'toTerminal',
        roomName: 'E9N47',
        resourceType: RESOURCE_MIST,
        amount: 2687,
        amountMoved: 0,
        status: 'active',
        created: 1000,
      },
    ],
  };

  terminalManager.isOperationStale = function () {
    return true;
  };
  terminalManager.cancelOperation = function (operationId) {
    Memory.terminalManager.operations = Memory.terminalManager.operations.filter(function (op) {
      return op.id !== operationId;
    });
  };
  terminalManager.storageToTerminal = function (roomName, resourceType, amount) {
    Memory.terminalManager.operations.push({
      id: 'local_replacement',
      type: 'toTerminal',
      roomName: roomName,
      resourceType: resourceType,
      amount: amount,
      amountMoved: 0,
      status: 'pending',
      created: Game.time,
    });
    return '[Terminal] Local order queued';
  };

  const result = marketSeller.repairStaleTerminalCoverage();
  const request = Memory.marketSell.requests[0];
  const replacement = Memory.terminalManager.operations[0];

  assert.strictEqual(result, 1);
  assert.strictEqual(request.tmOpId, 'local_replacement');
  assert.strictEqual(replacement.amount, 2687);
  assert.deepStrictEqual(reservationsReleased[0], {
    roomName: 'E9N47',
    resourceType: RESOURCE_MIST,
    building: 'storage',
    program: 'marketSell',
  });
  assert.strictEqual(Game.market.orders.order_mist.remainingAmount, 2687);
});

test('understocked live orders without a link are restaged', function () {
  Game.time = 6000;
  reservationsReleased.length = 0;
  Game.rooms = {
    E9N49: {
      terminal: { store: { mist: 14609 } },
      storage: { store: { mist: 1000 } },
    },
  };
  Game.market.orders = {
    order_live: {
      id: 'order_live',
      type: ORDER_SELL,
      roomName: 'E9N49',
      resourceType: RESOURCE_MIST,
      remainingAmount: 15423,
      totalAmount: 16423,
      active: true,
    },
  };
  Memory.marketSell = {
    v: 2,
    requests: [
      {
        __marketSellRequest: true,
        roomName: 'E9N49',
        resourceType: RESOURCE_MIST,
        amount: 16423,
        created: 1000,
        orderId: 'order_live',
      },
    ],
  };
  Memory.terminalManager = { operations: [] };

  const result = marketSeller.repairStaleTerminalCoverage();
  assert.strictEqual(result, 1);
  assert.strictEqual(Memory.marketSell.requests[0].tmOpId, 'local_replacement');
  assert.strictEqual(Memory.terminalManager.operations[0].amount, 814);
});

Module._load = originalModuleLoad;
console.log(
  '\nTerminal Recovery Test Suite Complete: ' + passed + ' passed, ' + failed + ' failed.'
);
if (failed > 0) process.exit(1);
