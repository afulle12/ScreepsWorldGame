// LLM: Read docs/codex.js before reviewing or changing this file.
// test/supplier_prespawn_harness.js
// Focused coverage for supplier prespawn timing and spawning-creep accounting.

const assert = require('assert');
const Module = require('module');

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

const bodyPartCosts = {};
bodyPartCosts[WORK] = 100;
bodyPartCosts[CARRY] = 50;
bodyPartCosts[MOVE] = 50;
bodyPartCosts[TOUGH] = 10;
bodyPartCosts[ATTACK] = 80;
bodyPartCosts[RANGED_ATTACK] = 150;
bodyPartCosts[HEAL] = 250;
bodyPartCosts[CLAIM] = 600;

let liveCreeps = [];
const roomState = {
  creepIndex: function () {
    return { all: liveCreeps };
  },
};
const stubs = {
  getRoomState: roomState,
  roleTowerDrain: {},
  roleDrainDemolisher: {},
  singleSourceRoom: {},
  roomSuspender: {
    shouldAvoidRoomWork: function () {
      return false;
    },
  },
  util: {
    bodyCost: function (body) {
      return body.reduce(function (sum, part) {
        return sum + (bodyPartCosts[part] || 0);
      }, 0);
    },
  },
  scavengerPolicy: {},
  scavengerLearning: {},
  marketPricing: {},
  autoTrader: {},
  memoryManager: {
    storage: { register: function () {} },
    requestImmediateSave: function () {},
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad(request, parent, isMain);
};

global.Memory = {};
global.Game = { time: 1000, rooms: {} };

const spawnManager = require('../spawnManager');
const statusReport = require('../statusReport');
const ROOM_NAME = 'W1N1';
const room = {
  name: ROOM_NAME,
  controller: { my: true, level: 7 },
  energyCapacityAvailable: 5600,
  energyAvailable: 2400,
};
Game.rooms[ROOM_NAME] = room;

function makeSupplier(ticksToLive, options) {
  options = options || {};
  const creep = {
    memory: {
      role: 'supplier',
      homeRoom: ROOM_NAME,
    },
    room: room,
    ticksToLive: ticksToLive,
  };
  if (options.spawning) creep.spawning = true;
  if (options.omitTicksToLive) delete creep.ticksToLive;
  return creep;
}

function setScenario(level, energy, creeps) {
  room.controller.level = level;
  room.energyAvailable = energy;
  liveCreeps = creeps;
}

function assertDue(expected, level, energy, creeps) {
  setScenario(level, energy, creeps);
  assert.strictEqual(spawnManager.isSupplierPrespawnDue(ROOM_NAME, room), expected);
}

assertDue(false, 7, 2400, [makeSupplier(300)]);
assertDue(true, 7, 2400, [makeSupplier(239)]);
assertDue(false, 7, 2400, [makeSupplier(240)]);
assertDue(false, 7, 2000, [makeSupplier(239)]);
assertDue(true, 8, 2400, [makeSupplier(200)]);
assertDue(false, 7, 2400, [makeSupplier(200), makeSupplier(undefined, { spawning: true, omitTicksToLive: true })]);
assertDue(false, 7, 2400, [makeSupplier(100), makeSupplier(1400)]);
assertDue(false, 6, 2400, [makeSupplier(100)]);
assertDue(false, 7, 2400, []);
assertDue(false, 7, 2400, [makeSupplier(100), makeSupplier(90)]);

// C12 -- the prespawn used to decline outright whenever the room could not
// afford a full-capacity body, so a room below full energy never started the
// replacement until the incumbent was already dead. It now downgrades instead,
// but only at the point where waiting any longer would leave a gap.
//
// Room capacity is 5600, so the full body is 48 parts / 2400 energy / 144
// ticks to spawn. At 2000 energy the affordable body is 40 parts / 2000
// energy / 120 ticks, giving a downgrade threshold of 40*3 + 10 = 130 ticks.

// Still time for the room to refill and build a full-size body: keep waiting.
assertDue(false, 7, 2000, [makeSupplier(239)]);
assertDue(false, 7, 2000, [makeSupplier(131)]);
// Past the point where the affordable body would still finish in time:
// downgrade rather than leave the room supplierless.
assertDue(true, 7, 2000, [makeSupplier(130)]);
assertDue(true, 7, 2000, [makeSupplier(60)]);
// Full energy is unaffected -- the full-size body is used as before.
assertDue(true, 7, 2400, [makeSupplier(60)]);
// Below the smallest supplier tier there is no body to build at all.
assertDue(false, 7, 150, [makeSupplier(60)]);

setScenario(7, 2400, [makeSupplier(undefined, { spawning: true, omitTicksToLive: true })]);
const counts = statusReport.getPerRoomRoleCounts();
assert.strictEqual(counts[ROOM_NAME].supplier, 1);

Module._load = originalLoad;
console.log('Supplier prespawn harness complete.');
