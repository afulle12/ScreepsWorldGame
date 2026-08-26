// LLM: Read docs/codex.js before reviewing or changing this file.
// test/opportunistic_buy_harness.js
// Dependency-free regression tests for opportunistic buy reconciliation.

const assert = require('assert');
const Module = require('module');
const path = require('path');
global.RESOURCE_ENERGY = 'energy';
global.Memory = {};
global.Game = {
  time: 1000,
  rooms: {},
  market: { incomingTransactions: [] },
};
const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;
let saveRequests = 0;
const memoryManagerStub = {
  heap: {},
  requestSave: function () {
    saveRequests++;
  },
  requestImmediateSave: function () {},
};
const dependencyStubs = {
  memoryManager: memoryManagerStub,
  roomSuspender: {
    shouldAvoidRoomWork: function () {
      return false;
    },
  },
  util: {
    getMyRooms: function () {
      return {};
    },
  },
  creditLedger: {
    available: function () {
      return 0;
    },
    commit: function () {},
  },
  marketBatchBuy: {},
};
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
const opportunisticBuy = require('../opportunisticBuy');
function resetTestEnv() {
  saveRequests = 0;
  memoryManagerStub.heap.opportunisticBuyReconcileTick = null;
  global.Memory = {
    opportunisticBuy: {
      requests: {
        request: {
          roomName: 'W1N1',
          resourceType: 'power',
          totalAmount: 200,
          remaining: 100,
          fulfilled: 0,
          pending: {
            pre: 0,
            expected: 100,
            tick: 1000,
            orderId: 'order1',
            orderRoom: 'W2N2',
            price: 1,
            energyCost: 0,
          },
        },
      },
    },
  };
  global.Game.time = 1000;
  global.Game.rooms = {
    W1N1: { terminal: { store: { power: 0 } } },
  };
  global.Game.market = { incomingTransactions: [] };
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    resetTestEnv();
    fn();
    console.log('  PASS ' + name);
    passed++;
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error(err);
    failed++;
  }
}

test('pending lock remains at the 1000-tick boundary', function () {
  Game.time = 2000;
  opportunisticBuy.reconcilePending();

  const request = Memory.opportunisticBuy.requests.request;
  assert.ok(request.pending);
  assert.strictEqual(request.pending.ambiguous, true);
  assert.strictEqual(request.remaining, 100);
});

test('expired unmarked pending lock is cleared before ambiguity is recorded', function () {
  Game.time = 2001;
  opportunisticBuy.reconcilePending();

  const request = Memory.opportunisticBuy.requests.request;
  assert.strictEqual(request.pending, null);
  assert.strictEqual(request.remaining, 100);
  assert.strictEqual(request.fulfilled, 0);
  assert.strictEqual(saveRequests, 1);
});

test('expired ambiguous pending lock is cleared', function () {
  Memory.opportunisticBuy.requests.request.pending.ambiguous = true;
  Game.time = 2001;
  opportunisticBuy.reconcilePending();

  assert.strictEqual(Memory.opportunisticBuy.requests.request.pending, null);
});

test('matching transaction is confirmed before expiration is considered', function () {
  Memory.opportunisticBuy.requests.request.totalAmount = 300;
  Memory.opportunisticBuy.requests.request.remaining = 200;
  Game.time = 2001;
  Game.market.incomingTransactions = [
    {
      time: 2001,
      to: 'W1N1',
      resourceType: 'power',
      amount: 100,
      order: { id: 'order1' },
    },
  ];
  opportunisticBuy.reconcilePending();

  const request = Memory.opportunisticBuy.requests.request;
  assert.strictEqual(request.pending, null);
  assert.strictEqual(request.fulfilled, 100);
  assert.strictEqual(request.remaining, 100);
});

test('account-resource pending records are not handled by terminal reconciliation', function () {
  Memory.opportunisticBuy.requests.request.resourceType = 'pixel';
  Game.time = 2001;
  opportunisticBuy.reconcilePending();

  assert.ok(Memory.opportunisticBuy.requests.request.pending);
});

Module._load = originalModuleLoad;
console.log(
  '\nOpportunistic Buy Test Suite Complete: ' + passed + ' passed, ' + failed + ' failed.'
);
if (failed > 0) process.exit(1);
