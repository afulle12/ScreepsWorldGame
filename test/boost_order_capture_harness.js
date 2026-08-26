// LLM: Read docs/codex.js before reviewing or changing this file.
// test/boost_order_capture_harness.js
// Dependency-free regression test for delayed Game.market order visibility.

const assert = require('assert');
const Module = require('module');
const path = require('path');
global.OK = 0;
global.ORDER_BUY = 'buy';
global.ERR_NOT_ENOUGH_RESOURCES = -6;
global.RESOURCE_ENERGY = 'energy';
global.STRUCTURE_LAB = 'lab';
global.FIND_STRUCTURES = 'structures';
global.WORK = 'work';
global.CARRY = 'carry';
global.MOVE = 'move';
const projectRoot = path.resolve(__dirname, '..') + path.sep;
const originalModuleLoad = Module._load;
const createCalls = [];
const buyRequest = {
  remaining: 100,
  createdAt: 9700,
};
const memoryManagerStub = {
  requestSave: function () {},
  requestImmediateSave: function () {},
};
const dependencyStubs = {
  storageManager: {
    storageFind: function () {
      return null;
    },
    reserve: function () {
      return { ok: true };
    },
    unReserve: function () {},
    getProgramReserved: function () {
      return 0;
    },
    getReservationRecords: function () {
      return [];
    },
  },
  labManager: {},
  opportunisticBuy: {
    getRequestByKey: function () {
      return buyRequest;
    },
    setup: function () {},
    cancelRequest: function () {},
  },
  getRoomState: {
    get: function () {
      return { structuresByType: { lab: [{ id: 'lab1' }, { id: 'lab2' }] } };
    },
  },
  roomSuspender: {
    shouldAvoidRoomWork: function () {
      return false;
    },
  },
  util: {
    bodyCost: function () {
      return 0;
    },
    getOrderRemaining: function (order) {
      return order && typeof order.remainingAmount === 'number' ? order.remainingAmount : 0;
    },
  },
  marketPricing: {
    FEE: 0.05,
    getPriceProfile: function () {
      return { marketPrice: 1 };
    },
  },
  creditLedger: {
    available: function () {
      return 100000;
    },
    commit: function () {},
  },
  memoryManager: memoryManagerStub,
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
function resetTestEnv() {
  createCalls.length = 0;
  global.Memory = {
    boostManager: {
      _v2migration: true,
      lastReservationUpdateTick: 10000,
      orders: {
        W1N1: {
          upgrader: {
            active: true,
            stopping: false,
            boosts: { XGH2O: { parts: 1, labIds: ['lab1'] } },
            batchSize: 50,
            reorderAt: 5,
            purchaseSetup: {},
            buyOrderIds: {},
            pendingBuyOrders: {},
            lastPurchaseCheck: 0,
          },
        },
      },
    },
  };
  global.Game = {
    time: 10000,
    rooms: {
      W1N1: {
        controller: { my: true },
        terminal: { store: {} },
        storage: { store: {} },
      },
    },
    market: {
      orders: {},
      createOrder: function (params) {
        createCalls.push({ tick: Game.time, params: params });
        return OK;
      },
      getOrderById: function (id) {
        return Game.market.orders[id] || null;
      },
    },
    getObjectById: function () {
      return null;
    },
  };
  global.__boostActive = false;
}

resetTestEnv();
const boostManager = require('../boostManager');
resetTestEnv();
boostManager.run();
const order = Memory.boostManager.orders.W1N1.upgrader;
assert.strictEqual(createCalls.length, 1);
assert.strictEqual(order.buyOrderIds.XGH2O, undefined);
assert.strictEqual(order.pendingBuyOrders.XGH2O.totalAmount, 100);

// A later manager pass must not post a second order while the first intent is
// still absent from Game.market.orders.
Game.time += 101;
boostManager.run();
assert.strictEqual(createCalls.length, 1);

Game.market.orders.buy1 = {
  id: 'buy1',
  type: ORDER_BUY,
  resourceType: 'XGH2O',
  roomName: 'W1N1',
  price: 1.5,
  totalAmount: 100,
  remainingAmount: 100,
  active: true,
  created: 10000,
};
Game.time += 1;
boostManager.run();

assert.strictEqual(createCalls.length, 1);
assert.strictEqual(order.buyOrderIds.XGH2O, 'buy1');
assert.strictEqual(order.pendingBuyOrders.XGH2O, undefined);

Module._load = originalModuleLoad;
console.log('Boost order capture regression test passed.');
