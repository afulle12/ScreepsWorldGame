// LLM: Read docs/codex.js before reviewing or changing this file.
// test/test_harness.js
// Dependency-free Screeps Mock Test Harness for Node.js

const path = require('path');
const assert = require('assert');
// 1. Setup Mock Screeps Environment Globals
global.OK = 0;
global.ERR_NOT_OWNER = -1;
global.ERR_NO_PATH = -2;
global.ERR_NAME_EXISTS = -3;
global.ERR_BUSY = -4;
global.ERR_NOT_FOUND = -5;
global.ERR_NOT_ENOUGH_RESOURCES = -6;
global.ERR_NOT_ENOUGH_ENERGY = -6;
global.ERR_INVALID_TARGET = -7;
global.ERR_FULL = -8;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_INVALID_ARGS = -10;
global.ERR_TIRED = -11;
global.ERR_NO_BODYPART = -12;
global.ERR_NOT_ENOUGH_EXTENSIONS = -6;
global.ERR_RCL_NOT_ENOUGH = -14;
global.ERR_GCL_NOT_ENOUGH = -15;
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_ROAD = 'road';
global.STRUCTURE_WALL = 'constructedWall';
global.STRUCTURE_RAMPART = 'rampart';
global.STRUCTURE_KEEPER_LAIR = 'keeperLair';
global.STRUCTURE_PORTAL = 'portal';
global.STRUCTURE_CONTROLLER = 'controller';
global.STRUCTURE_LINK = 'link';
global.STRUCTURE_STORAGE = 'storage';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_OBSERVER = 'observer';
global.STRUCTURE_POWER_BANK = 'powerBank';
global.STRUCTURE_POWER_SPAWN = 'powerSpawn';
global.STRUCTURE_EXTRACTOR = 'extractor';
global.STRUCTURE_LAB = 'lab';
global.STRUCTURE_TERMINAL = 'terminal';
global.STRUCTURE_CONTAINER = 'container';
global.STRUCTURE_NUKER = 'nuker';
global.STRUCTURE_FACTORY = 'factory';
global.STRUCTURE_INVADER_CORE = 'invaderCore';
global.RESOURCE_ENERGY = 'energy';
global.RESOURCE_POWER = 'power';
global.RESOURCE_OPS = 'ops';
global.RESOURCE_HYDROGEN = 'H';
global.RESOURCE_OXYGEN = 'O';
global.RESOURCE_UTRIUM = 'U';
global.RESOURCE_LEMERGIUM = 'L';
global.RESOURCE_KEANIUM = 'K';
global.RESOURCE_ZYNTHIUM = 'Z';
global.RESOURCE_CATALYST = 'X';
global.RESOURCE_GHODIUM = 'G';
global.RESOURCE_BATTERY = 'battery';
global.RESOURCE_REDUCTANT = 'UH';
global.RESOURCE_OXIDANT = 'OH';
global.RESOURCE_UTRIUM_BAR = 'UTRIUM_BAR';
global.RESOURCE_LEMERGIUM_BAR = 'LEMERGIUM_BAR';
global.RESOURCE_KEANIUM_BAR = 'KEANIUM_BAR';
global.RESOURCE_ZYNTHIUM_BAR = 'ZYNTHIUM_BAR';
global.RESOURCE_PURIFIER = 'PURIFIER';
global.RESOURCE_GHODIUM_MELT = 'GHODIUM_MELT';
global.RESOURCE_HYDROXIDE = 'OH';
global.RESOURCE_ZYNTHIUM_KEANITE = 'ZK';
global.RESOURCE_UTRIUM_LEMERGITE = 'UL';
global.RESOURCE_COMPOSITE = 'composite';
global.RESOURCE_CRYSTAL = 'crystal';
global.RESOURCE_LIQUID = 'liquid';
global.RESOURCE_WIRE = 'wire';
global.RESOURCE_SWITCH = 'switch';
global.RESOURCE_TRANSISTOR = 'transistor';
global.RESOURCE_MICROCHIP = 'microchip';
global.RESOURCE_CIRCUIT = 'circuit';
global.RESOURCE_DEVICE = 'device';
global.RESOURCE_CELL = 'cell';
global.RESOURCE_PHLEGM = 'phlegm';
global.RESOURCE_TISSUE = 'tissue';
global.RESOURCE_MUSCLE = 'muscle';
global.RESOURCE_ORGANOID = 'organoid';
global.RESOURCE_ORGANISM = 'organism';
global.RESOURCE_ALLOY = 'alloy';
global.RESOURCE_TUBE = 'tube';
global.RESOURCE_FIXTURES = 'fixtures';
global.RESOURCE_FRAME = 'frame';
global.RESOURCE_HYDRAULICS = 'hydraulics';
global.RESOURCE_MACHINE = 'machine';
global.RESOURCE_CONDENSATE = 'condensate';
global.RESOURCE_CONCENTRATE = 'concentrate';
global.RESOURCE_EXTRACT = 'extract';
global.RESOURCE_SPIRIT = 'spirit';
global.RESOURCE_EMANATION = 'emanation';
global.RESOURCE_ESSENCE = 'essence';
global.RESOURCE_MIST = 'mist';
global.RESOURCE_BIOMASS = 'biomass';
global.RESOURCE_METAL = 'metal';
global.RESOURCE_SILICON = 'silicon';
global.Memory = {};
global.Game = {
  time: 1000,
  rooms: {},
  _objects: {},
  getObjectById: (id) => global.Game._objects[id] || null,
  creeps: {},
  spawns: {},
  market: {
    orders: {},
  },
  cpu: {
    getUsed: () => 1.0,
    limit: 20,
    bucket: 10000,
  },
};
function resetTestEnv() {
  global.Memory = {};
  global.Game.time = 1000;
  global.Game.rooms = {};
  global.Game._objects = {};
  global.Game.creeps = {};
  delete global.__roomState;
  delete global.__rsFindCache;
  delete global.__permanentFactsBuildTick;
}

function createMockRoom(roomName, opts = {}) {
  const room = {
    name: roomName,
    controller: opts.controller || { my: true, level: 8 },
    storage: opts.storage
      ? {
          id: opts.storage.id || 'storage_' + roomName,
          structureType: STRUCTURE_STORAGE,
          store: opts.storage.store || {},
        }
      : null,
    terminal: opts.terminal
      ? {
          id: opts.terminal.id || 'terminal_' + roomName,
          structureType: STRUCTURE_TERMINAL,
          store: opts.terminal.store || {},
        }
      : null,
    minerals: opts.minerals || [{ mineralType: RESOURCE_OXYGEN }],
  };
  global.Game.rooms[roomName] = room;
  return room;
}

function createMockStructure(roomName, structureType, id, store) {
  const structure = {
    id: id,
    structureType: structureType,
    store: store || {},
  };
  global.Game._objects[id] = structure;
  return structure;
}

function createAllMountsRoom(roomName) {
  createMockRoom(roomName, {
    storage: { id: 'storage_' + roomName, store: { energy: 50000, X: 4000 } },
    terminal: { id: 'terminal_' + roomName, store: { energy: 30000, X: 2000 } },
  });
  createMockStructure(roomName, STRUCTURE_FACTORY, 'factory_' + roomName, { metal: 1200 });
  createMockStructure(roomName, STRUCTURE_LAB, 'lab_' + roomName, { X: 700 });
  createMockStructure(roomName, STRUCTURE_CONTAINER, 'container_' + roomName, { energy: 900 });
  createMockStructure(roomName, STRUCTURE_POWER_SPAWN, 'power_' + roomName, { power: 80 });
}

// Load Modules
const memoryManager = require('../memoryManager');
const storageManager = require('../storageManager');
const storageVfs = require('../storageVfs');
console.log('Running test suite...');
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    resetTestEnv();
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

// === Storage manager contract tests ===
test('reserve() finite-number validation', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', NaN).ok, false);
  assert.strictEqual(
    storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', Infinity).ok,
    false
  );
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', -500).ok, false);
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 0).ok, false);
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', null).ok, false);
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', '100').ok, false);
  const valid = storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 1000);
  assert.strictEqual(valid.ok, true);
});
test('consume() finite-number validation', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 1000);
  assert.strictEqual(storageManager.consume('W1N1', 'energy', 'storage', 'prog1', NaN).ok, false);
  assert.strictEqual(
    storageManager.consume('W1N1', 'energy', 'storage', 'prog1', Infinity).ok,
    false
  );
  assert.strictEqual(storageManager.consume('W1N1', 'energy', 'storage', 'prog1', -50).ok, false);
  assert.strictEqual(storageManager.consume('W1N1', 'energy', 'storage', 'prog1', 0).ok, false);
  const res = storageManager.consume('W1N1', 'energy', 'storage', 'prog1', 200);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.consumed, 200);
  assert.strictEqual(res.remaining, 800);
});
test('transfer() explicit zero & invalid parameter semantics', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 1000);
  assert.strictEqual(
    storageManager.transfer('W1N1', 'energy', 'storage', 'prog1', 'prog2', NaN).ok,
    false
  );
  assert.strictEqual(
    storageManager.transfer('W1N1', 'energy', 'storage', 'prog1', 'prog2', Infinity).ok,
    false
  );
  assert.strictEqual(
    storageManager.transfer('W1N1', 'energy', 'storage', 'prog1', 'prog2', -100).ok,
    false
  );
  const zeroRes = storageManager.transfer('W1N1', 'energy', 'storage', 'prog1', 'prog2', 0);
  assert.strictEqual(zeroRes.ok, true);
  assert.strictEqual(zeroRes.transferred, 0);
  assert.strictEqual(zeroRes.fromRemaining, 1000);
  assert.strictEqual(zeroRes.toTotal, 0);
  const fullRes = storageManager.transfer('W1N1', 'energy', 'storage', 'prog1', 'prog2');
  assert.strictEqual(fullRes.ok, true);
  assert.strictEqual(fullRes.transferred, 1000);
  assert.strictEqual(fullRes.fromRemaining, 0);
  assert.strictEqual(fullRes.toTotal, 1000);
});
test('transfer() splice-index regression fix (fromIdx < toIdx & source drained)', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 500);
  storageManager.reserve('W1N1', 'energy', 'storage', 'prog2', 300);
  const res = storageManager.transfer('W1N1', 'energy', 'storage', 'prog1', 'prog2', 500);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.transferred, 500);
  assert.strictEqual(res.toTotal, 800);
});
test('Delta-based reservation resizing with existing reservation exclusion', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
  storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 600);
  storageManager.reserve('W1N1', 'energy', 'storage', 'prog2', 300);
  const resizeRes = storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 700);
  assert.strictEqual(resizeRes.ok, true);
  Game.rooms['W1N1'].storage.store.energy = 200;
  const downsize = storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 150);
  assert.strictEqual(downsize.ok, true);
});
test('unReserve() accumulated removal total', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  storageManager.reserve('W1N1', 'energy', 'storage', 'prog1', 400);
  const res = storageManager.unReserve('W1N1', 'energy', 'storage', 'prog1');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removed, 400);
  const res2 = storageManager.unReserve('W1N1', 'energy', 'storage', 'prog1');
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.removed, 0);
});
test('sanitizeReservations() removes expired V2 locks', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  const lock = storageVfs.lock('/rooms/W1N1/storage/energy', { program: 'staleProg', amount: 1000, ttl: 50 });
  assert.strictEqual(lock.ok, true);
  Game.time = 1050;
  assert.strictEqual(storageManager.sanitizeReservations('W1N1'), 1);
  assert.strictEqual(storageVfs.stat('/rooms/W1N1/storage/energy').reserved, 0);
});
test('V2 storage reservations use the long migration-safe TTL', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'longLivedProg', 1000).ok, true);
  const stat = storageVfs.stat('/rooms/W1N1/storage/energy');
  assert.strictEqual(stat.locks[0].expiryTick, Game.time + storageVfs.TTL_RESERVATION);
});
test('Sanitize persisted malformed records', () => {
  createMockRoom('W1N1', { storage: { store: { energy: 10000 } } });
  const path = '/rooms/W1N1/storage/energy';
  const good = storageVfs.lock(path, { program: 'p1', amount: 500 });
  const root = Memory.storageReservationsV2;
  root.locks.bad1 = { lockId: 'bad1', nodeKey: path, roomName: 'W1N1', structureType: 'storage', resourceType: 'energy', program: 'bad1', amount: NaN };
  root.locks.bad2 = { lockId: 'bad2', nodeKey: path, roomName: 'W1N1', structureType: 'storage', resourceType: 'energy', program: 'bad2', amount: -100 };
  root.locks.bad3 = { lockId: 'bad3', nodeKey: path, roomName: 'W1N1', structureType: 'storage', resourceType: 'energy', amount: 200 };
  root.lockIndex[path].push('bad1', 'bad2', 'bad3');
  assert.strictEqual(good.ok, true);
  assert.strictEqual(storageManager.sanitizeReservations(), 3);
  assert.deepStrictEqual(storageVfs.getReservationList('W1N1', 'storage', 'energy'), [
    { program: 'p1', amount: 500, time: Game.time },
  ]);
});
// === PHASE 3 & 4 TESTS: VFS Core & Compatibility ===
test('VFS path parsing and stat()', () => {
  createMockRoom('E2N46', {
    storage: { id: 's1', store: { energy: 50000 } },
    terminal: { id: 't1', store: { X: 10000 } },
  });
  const statStor = storageVfs.stat('/rooms/E2N46/storage/energy');
  assert.strictEqual(statStor.ok, true);
  assert.strictEqual(statStor.total, 50000);
  assert.strictEqual(statStor.available, 50000);
  const statTerm = storageVfs.stat('/rooms/E2N46/terminal/X');
  assert.strictEqual(statTerm.ok, true);
  assert.strictEqual(statTerm.total, 10000);
  assert.strictEqual(statTerm.available, 10000);
  // Nuker path explicitly rejected
  const statNuker = storageVfs.stat('/rooms/E2N46/nuker/nuker1/energy');
  assert.strictEqual(statNuker.ok, false);
});
test('VFS lock, touch, unlock, write, mv', () => {
  createMockRoom('E2N46', {
    storage: { id: 's1', store: { energy: 50000 } },
    terminal: { id: 't1', store: { energy: 10000 } },
  });
  const lock1 = storageVfs.lock('/rooms/E2N46/storage/energy', {
    program: 'testProg',
    amount: 5000,
    ttl: 1000,
  });
  assert.strictEqual(lock1.ok, true);
  assert.ok(lock1.lockId);
  const statAfter = storageVfs.stat('/rooms/E2N46/storage/energy');
  assert.strictEqual(statAfter.reserved, 5000);
  assert.strictEqual(statAfter.available, 45000);
  const wrongPathWrite = storageVfs.write('/rooms/E2N46/terminal/energy', lock1.lockId, 100);
  assert.strictEqual(wrongPathWrite.ok, false);
  assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 5000);
  const touchRes = storageVfs.touch(lock1.lockId, 1500);
  assert.strictEqual(touchRes.ok, true);
  assert.strictEqual(touchRes.expiryTick, Game.time + 1500);
  const mvRes = storageVfs.mv(lock1.lockId, '/rooms/E2N46/terminal/energy', {
    toProgram: 'termProg',
  });
  assert.strictEqual(mvRes.ok, true);
  const statStorMv = storageVfs.stat('/rooms/E2N46/storage/energy');
  assert.strictEqual(statStorMv.reserved, 0);
  const statTermMv = storageVfs.stat('/rooms/E2N46/terminal/energy');
  assert.strictEqual(statTermMv.reserved, 5000);
  const writeRes = storageVfs.write('/rooms/E2N46/terminal/energy', mvRes.lockId, 2000);
  assert.strictEqual(writeRes.ok, true);
  assert.strictEqual(writeRes.consumed, 2000);
  assert.strictEqual(writeRes.remaining, 3000);
  const unlockRes = storageVfs.unlock(mvRes.lockId);
  assert.strictEqual(unlockRes.ok, true);
  assert.strictEqual(storageVfs.stat('/rooms/E2N46/terminal/energy').reserved, 0);
});
test('VFS mv preserves source on destination failure and combines same-node ownership', () => {
  createMockRoom('E2N46', {
    storage: { id: 's1', store: { energy: 10000 } },
    terminal: { id: 't1', store: { energy: 0 } },
  });
  const source = storageVfs.lock('/rooms/E2N46/storage/energy', {
    program: 'source',
    ownerId: 'source',
    amount: 8000,
  });
  const failedMove = storageVfs.mv(source.lockId, '/rooms/E2N46/terminal/energy', {
    toProgram: 'destination',
    toOwnerId: 'destination',
  });
  assert.strictEqual(failedMove.ok, false);
  assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 8000);
  const sameNode = storageVfs.mv(source.lockId, '/rooms/E2N46/storage/energy', {
    toProgram: 'destination',
    toOwnerId: 'destination',
    amount: 3000,
  });
  assert.strictEqual(sameNode.ok, true);
  assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 8000);
  const sameNodeLocks = storageVfs.stat('/rooms/E2N46/storage/energy').locks;
  assert.strictEqual(sameNodeLocks.length, 2);
  assert.strictEqual(sameNodeLocks.filter((l) => l.program === 'source')[0].amount, 5000);
  assert.strictEqual(sameNodeLocks.filter((l) => l.program === 'destination')[0].amount, 3000);
});
test('VFS Capacity Lock allocation, reduction, and release', () => {
  createMockRoom('E2N46', {
    terminal: { id: 't1', store: { energy: 200000 } },
  });
  const capLock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
    program: 'marketBuy',
    ownerId: 'order_123',
    capacity: 30000,
    ttl: 1000,
  });
  assert.strictEqual(capLock.ok, true);
  assert.ok(capLock.capacityLockId);
  const reduceRes = storageVfs.reduceCapacity(capLock.capacityLockId, 10000);
  assert.strictEqual(reduceRes.ok, true);
  assert.strictEqual(reduceRes.remainingCapacity, 20000);
  assert.strictEqual(storageVfs.reduceCapacity(capLock.capacityLockId, NaN).ok, false);
  const sharedCapacity = storageVfs.lockCapacity('/rooms/E2N46/terminal/X', {
    program: 'otherBuy',
    ownerId: 'order_456',
    capacity: 281000,
  });
  assert.strictEqual(sharedCapacity.ok, false);
  const unlockCap = storageVfs.unlockCapacity(capLock.capacityLockId);
  assert.strictEqual(unlockCap.ok, true);
});
test('V2 reservations report the expected totals', () => {
  createMockRoom('W1N1', {
    storage: { id: 's1', store: { energy: 20000 } },
    terminal: { id: 't1', store: { energy: 10000 } },
  });
  storageManager.reserve('W1N1', 'energy', 'storage', 'progA', 5000);
  storageManager.reserve('W1N1', 'energy', 'terminal', 'progB', 2000);
  assert.strictEqual(storageVfs.getReserved('W1N1', 'storage', 'energy'), 5000);
  assert.strictEqual(storageVfs.getReserved('W1N1', 'terminal', 'energy'), 2000);
  assert.strictEqual(Memory.storageReservations, undefined);
});
test('V2 read accessors preserve the storageFind breakdown', () => {
  createMockRoom('W1N1', {
    storage: { id: 's1', store: { energy: 2000 } },
    terminal: { id: 't1', store: { energy: 1000 } },
  });
  storageManager.reserve('W1N1', 'energy', 'storage', 'storageProg', 500);
  storageManager.reserve('W1N1', 'energy', 'terminal', 'terminalProg', 200);
  const legacy = storageManager.storageFind('W1N1', 'energy');

  const v2 = storageManager.storageFind('W1N1', 'energy');
  assert.deepStrictEqual(v2, legacy);
  assert.deepStrictEqual(storageVfs.getReservationList('W1N1', 'storage', 'energy'), [
    { program: 'storageProg', amount: 500, time: Game.time },
  ]);
  assert.strictEqual(storageVfs.getReserved('W1N1', 'terminal', 'energy'), 200);
  assert.strictEqual(storageVfs.getAvailable('W1N1', 'terminal', 'energy'), 800);
});
test('V2-authoritative reserve rejects overcommitment using V2 locks', () => {
  createMockRoom('W1N1', { storage: { id: 's1', store: { energy: 1000 } } });
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'first', 600).ok, true);
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'second', 401).ok, false);
  assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'second', 400).ok, true);
});
// === PHASE 0 TESTS: migration observability ===
test('parity report catches equal-total divergence the totals check missed', () => {
  createMockRoom('W1N1', { storage: { id: 's1', store: { energy: 20000 } } });
  Memory.storageReservations = {
    W1N1: { storage: { energy: [{ program: 'progA', amount: 5000 }] } },
  };
  storageVfs.lock('/rooms/W1N1/storage/energy', { program: 'progA', amount: 5000 });

  // Same grand total, different owner: V1 now credits progB while V2 still
  // holds the lock for progA. The old totals-only report called this a match.
  Memory.storageReservations.W1N1.storage.energy[0].program = 'progB';

  const parity = storageVfs.getParityReport('W1N1');
  assert.strictEqual(parity.totalsMatch, true);
  assert.strictEqual(parity.isMatch, false);
  assert.strictEqual(parity.nodes.mismatched, 2);
  assert.strictEqual(parity.counts.legacyOnly, 1);
  assert.strictEqual(parity.counts.amountMismatch, 0);
  assert.strictEqual(parity.counts.v2Only, 1);
  const kinds = parity.mismatches.map((m) => m.kind).sort();
  assert.deepStrictEqual(kinds, ['legacyOnly', 'v2Only']);
});

test('V2 mutation failures are returned to callers', () => {
  createMockRoom('W1N1', { storage: { id: 's1', store: { energy: 20000 } } });
  const res = storageManager.consume('W1N1', 'energy', 'storage', 'missing', 1000);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'No matching reservation for program');
});

test('V2 reservation records enumerate all storage nodes', () => {
  createMockRoom('W1N1', {
    storage: { id: 's1', store: { energy: 20000, X: 4000 } },
    terminal: { id: 't1', store: { energy: 10000 } },
  });
  storageManager.reserve('W1N1', 'energy', 'storage', 'p', 1000);
  storageManager.reserve('W1N1', 'X', 'storage', 'p', 500);
  storageManager.reserve('W1N1', 'energy', 'terminal', 'p', 800);

  const records = storageManager.getReservationRecords('W1N1');
  assert.strictEqual(records.length, 3);
  assert.deepStrictEqual(records.map((record) => record.material).sort(), ['X', 'energy', 'energy']);
});

test('Nuker exclusion verification', () => {
  createMockRoom('W1N1', {
    storage: { id: 's1', store: { energy: 50000 } },
  });
  const res = storageVfs.stat('/rooms/W1N1/nuker/nuker1/energy');
  assert.strictEqual(res.ok, false);
  const lockRes = storageVfs.lock('/rooms/W1N1/nuker/nuker1/energy', {
    program: 'nukeFill',
    amount: 1000,
  });
  assert.strictEqual(lockRes.ok, false);
});
function registerParameterizedTests(prefix, cases) {
  cases.forEach((item, index) => {
    test(prefix + ' #' + (index + 1) + ': ' + item.name, item.run);
  });
}

function setupLockRoom(storageAmount, terminalAmount) {
  createMockRoom('E2N46', {
    storage: {
      id: 's1',
      store: { energy: storageAmount === undefined ? 10000 : storageAmount, X: 500 },
    },
    terminal: {
      id: 't1',
      store: { energy: terminalAmount === undefined ? 10000 : terminalAmount, X: 500 },
    },
  });
}

// 25 path and mount-shape cases.
const invalidPathCases = [
  ['missing leading slash', 'rooms/E2N46/storage/energy'],
  ['empty string', ''],
  ['null path', null],
  ['root path', '/'],
  ['rooms root', '/rooms'],
  ['room root', '/rooms/E2N46'],
  ['structure root', '/rooms/E2N46/storage'],
  ['storage extra segment', '/rooms/E2N46/storage/energy/extra'],
  ['double slash after rooms', '/rooms/E2N46//storage/energy'],
  ['double slash before resource', '/rooms/E2N46/storage//energy'],
  ['trailing slash', '/rooms/E2N46/storage/energy/'],
  ['dot segment', '/rooms/E2N46/storage/./energy'],
  ['parent segment', '/rooms/E2N46/storage/../energy'],
  ['nuker path', '/rooms/E2N46/nuker/n1/energy'],
  ['unknown structure', '/rooms/E2N46/unknown/energy'],
  ['invalid room prefix', '/rooms/Q2N46/storage/energy'],
  ['factory missing id', '/rooms/E2N46/factory/energy'],
  ['factory missing resource', '/rooms/E2N46/factory/f1'],
  ['factory extra segment', '/rooms/E2N46/factory/f1/energy/extra'],
  ['lab missing id', '/rooms/E2N46/lab/X'],
].map(([name, path]) => ({
  name: name,
  run: () => {
    setupLockRoom();
    assert.strictEqual(storageVfs.stat(path).ok, false);
    assert.strictEqual(storageVfs.lock(path, { program: 'invalid', amount: 1 }).ok, false);
  },
}));
const validPathCases = [
  ['storage resource', '/rooms/E2N46/storage/energy', 50000],
  ['terminal resource', '/rooms/E2N46/terminal/X', 2000],
  ['factory resource', '/rooms/E2N46/factory/factory_E2N46/metal', 1200],
  ['lab resource', '/rooms/E2N46/lab/lab_E2N46/X', 700],
  ['container resource', '/rooms/E2N46/container/container_E2N46/energy', 900],
].map(([name, path, total]) => ({
  name: name,
  run: () => {
    createAllMountsRoom('E2N46');
    const stat = storageVfs.stat(path);
    assert.strictEqual(stat.ok, true);
    assert.strictEqual(stat.total, total);
  },
}));
registerParameterizedTests('VFS path validation', invalidPathCases);
registerParameterizedTests('VFS valid concrete mounts', validPathCases);
// 25 lock allocation, replacement, and expiry cases.
const invalidLockAmountCases = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['negative', -1],
  ['zero', 0],
  ['string', '1'],
  ['null', null],
  ['undefined', undefined],
  ['object', {}],
].map(([name, amount]) => ({
  name: name,
  run: () => {
    setupLockRoom();
    assert.strictEqual(
      storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'invalid',
        amount: amount,
      }).ok,
      false
    );
  },
}));
const lockBehaviorCases = [
  {
    name: 'replacement can reduce amount',
    run: () => {
      setupLockRoom(1000);
      const first = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 800 });
      const second = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 300 });
      assert.strictEqual(second.lockId, first.lockId);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 300);
    },
  },
  {
    name: 'replacement can increase within stock',
    run: () => {
      setupLockRoom(1000);
      storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 300 });
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 900 }).ok,
        true
      );
    },
  },
  {
    name: 'replacement excludes its existing amount from delta',
    run: () => {
      setupLockRoom(1000);
      storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 700 });
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 1000 }).ok,
        true
      );
    },
  },
  {
    name: 'replacement rejects only the positive delta over stock',
    run: () => {
      setupLockRoom(1000);
      storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 700 });
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 1001 }).ok,
        false
      );
    },
  },
  {
    name: 'different owners share available stock',
    run: () => {
      setupLockRoom(1000);
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'a', amount: 600 }).ok,
        true
      );
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'b', amount: 400 }).ok,
        true
      );
    },
  },
  {
    name: 'different owners cannot overbook',
    run: () => {
      setupLockRoom(1000);
      storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'a', amount: 600 });
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'b', amount: 401 }).ok,
        false
      );
    },
  },
  {
    name: 'same owner id replaces across program names',
    run: () => {
      setupLockRoom(1000);
      const first = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'a',
        ownerId: 'owner',
        amount: 400,
      });
      const second = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'b',
        ownerId: 'owner',
        amount: 500,
      });
      assert.strictEqual(second.replaced, true);
      assert.strictEqual(second.lockId, first.lockId);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').locks[0].program, 'b');
    },
  },
  {
    name: 'custom priority and preemptible metadata persist',
    run: () => {
      setupLockRoom(1000);
      const result = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'p',
        amount: 100,
        priority: 7,
        preemptible: true,
      });
      const lock = storageVfs.stat('/rooms/E2N46/storage/energy').locks[0];
      assert.strictEqual(result.ok, true);
      assert.strictEqual(lock.priority, 7);
      assert.strictEqual(lock.preemptible, true);
    },
  },
  {
    name: 'default program and owner are populated',
    run: () => {
      setupLockRoom(1000);
      storageVfs.lock('/rooms/E2N46/storage/energy', { amount: 100 });
      const lock = storageVfs.stat('/rooms/E2N46/storage/energy').locks[0];
      assert.strictEqual(lock.program, 'default');
      assert.strictEqual(lock.ownerId, 'default');
    },
  },
  {
    name: 'fractional amounts are supported',
    run: () => {
      setupLockRoom(1000);
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 0.5 }).ok,
        true
      );
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 0.5);
    },
  },
  {
    name: 'exact physical amount is allocatable',
    run: () => {
      setupLockRoom(1000);
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 1000 }).ok,
        true
      );
    },
  },
  {
    name: 'one unit over physical amount is rejected',
    run: () => {
      setupLockRoom(1000);
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 1001 }).ok,
        false
      );
    },
  },
  {
    name: 'expired locks are hidden from stat',
    run: () => {
      setupLockRoom(1000);
      storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 100, ttl: 10 });
      Game.time += 10;
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 0);
    },
  },
  {
    name: 'maintenance purges expired locks',
    run: () => {
      setupLockRoom(1000);
      for (let i = 0; i < 50; i++) {
        assert.strictEqual(
          storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'active' + i, amount: 1 }).ok,
          true
        );
      }
      const result = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'expired',
        amount: 1,
        ttl: 10,
      });
      Game.time += 10;
      assert.strictEqual(storageVfs.runMaintenance(50).expiredLocks, 0);
      assert.strictEqual(storageVfs.runMaintenance(50).expiredLocks, 1);
      assert.strictEqual(storageVfs.unlock(result.lockId).ok, false);
    },
  },
  {
    name: 'maintenance purges stale reservations',
    run: () => {
      setupLockRoom(1000);
      const result = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'stale',
        amount: 100,
        ttl: storageVfs.TTL_RESERVATION,
      });
      Memory.storageReservationsV2.locks[result.lockId].lastTouchTick = Game.time - storageVfs.STALE_RESERVATION_AGE;
      const maintenance = storageVfs.runMaintenance(50);
      assert.strictEqual(maintenance.staleLocks, 1);
      assert.strictEqual(storageVfs.unlock(result.lockId).ok, false);
    },
  },
  {
    name: 'expired lock no longer blocks a new owner',
    run: () => {
      setupLockRoom(1000);
      storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'old', amount: 1000, ttl: 10 });
      Game.time += 10;
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'new', amount: 1000 }).ok,
        true
      );
    },
  },
  {
    name: 'lock touch updates expiry and last touch',
    run: () => {
      setupLockRoom(1000);
      const result = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'p',
        amount: 100,
        ttl: 10,
      });
      Game.time += 3;
      const touched = storageVfs.touch(result.lockId, 50);
      const lock = storageVfs.stat('/rooms/E2N46/storage/energy').locks[0];
      assert.strictEqual(touched.expiryTick, 1053);
      assert.strictEqual(lock.lastTouchTick, 1003);
    },
  },
  {
    name: 'touching an expired lock is rejected',
    run: () => {
      setupLockRoom(1000);
      const result = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'p',
        amount: 100,
        ttl: 10,
      });
      Game.time += 10;
      assert.strictEqual(storageVfs.touch(result.lockId, 50).ok, false);
    },
  },
  {
    name: 'unlock removes reservation immediately',
    run: () => {
      setupLockRoom(1000);
      const result = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 100 });
      assert.strictEqual(storageVfs.unlock(result.lockId).released, 100);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 0);
    },
  },
].filter((_, index) => index !== 9);
registerParameterizedTests('VFS invalid lock amounts', invalidLockAmountCases);
registerParameterizedTests('VFS lock behavior', lockBehaviorCases);
// 20 write, move, and TTL cases.
const invalidWriteCases = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['zero', 0],
  ['negative', -1],
  ['string', '1'],
].map(([name, amount]) => ({
  name: name,
  run: () => {
    setupLockRoom(1000);
    const lock = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500 });
    assert.strictEqual(
      storageVfs.write('/rooms/E2N46/storage/energy', lock.lockId, amount).ok,
      false
    );
    assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 500);
  },
}));
const wrongWriteCases = [
  ['other structure', '/rooms/E2N46/terminal/energy'],
  ['other resource', '/rooms/E2N46/storage/X'],
  ['invalid path', '/rooms/E2N46/nuker/n1/energy'],
].map(([name, path]) => ({
  name: name,
  run: () => {
    setupLockRoom(1000);
    const lock = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500 });
    assert.strictEqual(storageVfs.write(path, lock.lockId, 100).ok, false);
    assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 500);
  },
}));
const invalidMoveCases = [
  ['NaN', NaN],
  ['negative', -1],
  ['string', '1'],
]
  .map(([name, amount]) => ({
    name: name,
    run: () => {
      setupLockRoom(1000, 1000);
      const lock = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500 });
      assert.strictEqual(
        storageVfs.mv(lock.lockId, '/rooms/E2N46/terminal/energy', { amount: amount }).ok,
        false
      );
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 500);
    },
  }))
  .slice(0, 2);
const moveBehaviorCases = [
  {
    name: 'cross-structure full move',
    run: () => {
      setupLockRoom(1000, 1000);
      const source = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500 });
      const moved = storageVfs.mv(source.lockId, '/rooms/E2N46/terminal/energy');
      assert.strictEqual(moved.ok, true);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 0);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/terminal/energy').reserved, 500);
    },
  },
  {
    name: 'cross-structure partial move',
    run: () => {
      setupLockRoom(1000, 1000);
      const source = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500, ttl: 10 });
      Game.time += 3;
      const moved = storageVfs.mv(source.lockId, '/rooms/E2N46/terminal/energy', { amount: 200, ttl: 50 });
      assert.strictEqual(moved.fromRemaining, 300);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 300);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/terminal/energy').reserved, 200);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').locks[0].expiryTick, 1053);
    },
  },
  {
    name: 'same-node full ownership handoff reuses lock',
    run: () => {
      setupLockRoom(1000);
      const source = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'a', amount: 500 });
      const moved = storageVfs.mv(source.lockId, '/rooms/E2N46/storage/energy', { toProgram: 'b' });
      assert.strictEqual(moved.lockId, source.lockId);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').locks[0].program, 'b');
    },
  },
  {
    name: 'same-node partial move preserves total',
    run: () => {
      setupLockRoom(1000);
      const source = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'a', amount: 500, ttl: 10 });
      Game.time += 3;
      const moved = storageVfs.mv(source.lockId, '/rooms/E2N46/storage/energy', {
        toProgram: 'b',
        amount: 200,
        ttl: 50,
      });
      assert.strictEqual(moved.ok, true);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 500);
      const locks = storageVfs.stat('/rooms/E2N46/storage/energy').locks;
      assert.strictEqual(locks.find((lock) => lock.program === 'a').expiryTick, 1053);
    },
  },
  {
    name: 'same-node move combines destination owner',
    run: () => {
      setupLockRoom(1000);
      const source = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'a', amount: 500 });
      storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'b', amount: 100 });
      const moved = storageVfs.mv(source.lockId, '/rooms/E2N46/storage/energy', { toProgram: 'b' });
      const locks = storageVfs.stat('/rooms/E2N46/storage/energy').locks;
      assert.strictEqual(moved.ok, true);
      assert.strictEqual(locks.length, 1);
      assert.strictEqual(locks[0].amount, 600);
    },
  },
  {
    name: 'failed destination preserves source reservation',
    run: () => {
      setupLockRoom(1000, 0);
      const source = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'a', amount: 500 });
      assert.strictEqual(storageVfs.mv(source.lockId, '/rooms/E2N46/terminal/energy').ok, false);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 500);
    },
  },
  {
    name: 'resource type changes are rejected',
    run: () => {
      setupLockRoom(1000, 1000);
      const source = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'a', amount: 500 });
      assert.strictEqual(storageVfs.mv(source.lockId, '/rooms/E2N46/terminal/X').ok, false);
    },
  },
];
const touchBehaviorCases = [
  {
    name: 'write consumes only requested amount',
    run: () => {
      setupLockRoom(1000);
      const lock = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500 });
      const result = storageVfs.write('/rooms/E2N46/storage/energy', lock.lockId, 200);
      assert.strictEqual(result.consumed, 200);
      assert.strictEqual(result.remaining, 300);
    },
  },
  {
    name: 'write larger than lock drains it',
    run: () => {
      setupLockRoom(1000);
      const lock = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500 });
      assert.strictEqual(
        storageVfs.write('/rooms/E2N46/storage/energy', lock.lockId, 900).remaining,
        0
      );
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 0);
    },
  },
  {
    name: 'write renews a remaining lock',
    run: () => {
      setupLockRoom(1000);
      const lock = storageVfs.lock('/rooms/E2N46/storage/energy', {
        program: 'p',
        amount: 500,
        ttl: 10,
      });
      Game.time += 3;
      storageVfs.write('/rooms/E2N46/storage/energy', lock.lockId, 100);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').locks[0].expiryTick, 2003);
    },
  },
  {
    name: 'explicit zero move is a no-op',
    run: () => {
      setupLockRoom(1000, 1000);
      const lock = storageVfs.lock('/rooms/E2N46/storage/energy', { program: 'p', amount: 500 });
      const result = storageVfs.mv(lock.lockId, '/rooms/E2N46/terminal/energy', { amount: 0 });
      assert.strictEqual(result.transferred, 0);
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/storage/energy').reserved, 500);
    },
  },
  {
    name: 'missing lock ids are rejected by write',
    run: () => {
      setupLockRoom(1000);
      assert.strictEqual(storageVfs.write('/rooms/E2N46/storage/energy', null, 1).ok, false);
    },
  },
].slice(0, 3);
registerParameterizedTests('VFS invalid write amounts', invalidWriteCases);
registerParameterizedTests('VFS wrong-path writes', wrongWriteCases);
registerParameterizedTests('VFS invalid move amounts', invalidMoveCases);
registerParameterizedTests('VFS move behavior', moveBehaviorCases);
registerParameterizedTests('VFS write and no-op behavior', touchBehaviorCases);
// 20 capacity allocation and lifecycle cases.
const invalidCapacityCases = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['zero', 0],
  ['negative', -1],
  ['string', '1'],
].map(([name, capacity]) => ({
  name: name,
  run: () => {
    setupLockRoom();
    assert.strictEqual(
      storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        program: 'p',
        capacity: capacity,
      }).ok,
      false
    );
  },
}));
const capacityCases = [
  {
    name: 'exact fallback capacity is allocatable',
    run: () => {
      setupLockRoom();
      assert.strictEqual(
        storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 300000 }).ok,
        true
      );
    },
  },
  {
    name: 'capacity over fallback is rejected',
    run: () => {
      setupLockRoom();
      assert.strictEqual(
        storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 300001 }).ok,
        false
      );
    },
  },
  {
    name: 'different resource paths share structure capacity',
    run: () => {
      setupLockRoom();
      storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { program: 'a', capacity: 200000 });
      assert.strictEqual(
        storageVfs.lockCapacity('/rooms/E2N46/terminal/X', { program: 'b', capacity: 100001 }).ok,
        false
      );
    },
  },
  {
    name: 'multiple capacity locks sum outstanding units',
    run: () => {
      setupLockRoom();
      storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { program: 'a', capacity: 100000 });
      storageVfs.lockCapacity('/rooms/E2N46/terminal/X', { program: 'b', capacity: 100000 });
      assert.strictEqual(
        storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { program: 'c', capacity: 100001 })
          .ok,
        false
      );
    },
  },
  {
    name: 'expired capacity does not block allocation',
    run: () => {
      setupLockRoom();
      storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        program: 'old',
        capacity: 289500,
        ttl: 10,
      });
      Game.time += 10;
      assert.strictEqual(
        storageVfs.lockCapacity('/rooms/E2N46/terminal/X', { program: 'new', capacity: 289500 }).ok,
        true
      );
    },
  },
  {
    name: 'same owner capacity request replaces record',
    run: () => {
      setupLockRoom();
      const first = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        program: 'p',
        ownerId: 'o',
        capacity: 100,
      });
      const second = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        program: 'p',
        ownerId: 'o',
        capacity: 200,
      });
      assert.strictEqual(second.capacityLockId, first.capacityLockId);
      assert.strictEqual(second.replaced, true);
    },
  },
  {
    name: 'partial reduction reports remaining capacity',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 1000 });
      assert.strictEqual(
        storageVfs.reduceCapacity(lock.capacityLockId, 250).remainingCapacity,
        750
      );
    },
  },
  {
    name: 'zero reduction is a heartbeat no-op',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        capacity: 1000,
        ttl: 10,
      });
      Game.time += 2;
      assert.strictEqual(storageVfs.reduceCapacity(lock.capacityLockId, 0).remainingCapacity, 1000);
      assert.strictEqual(storageVfs.touchCapacity(lock.capacityLockId, 20).expiryTick, 1022);
    },
  },
  {
    name: 'NaN reduction is rejected',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 1000 });
      assert.strictEqual(storageVfs.reduceCapacity(lock.capacityLockId, NaN).ok, false);
    },
  },
  {
    name: 'negative reduction is rejected',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 1000 });
      assert.strictEqual(storageVfs.reduceCapacity(lock.capacityLockId, -1).ok, false);
    },
  },
  {
    name: 'overdelivery closes capacity lock',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 100 });
      assert.strictEqual(storageVfs.reduceCapacity(lock.capacityLockId, 200).remainingCapacity, 0);
      assert.strictEqual(storageVfs.unlockCapacity(lock.capacityLockId).ok, false);
    },
  },
  {
    name: 'capacity touch updates expiry',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        capacity: 100,
        ttl: 10,
      });
      Game.time += 3;
      assert.strictEqual(storageVfs.touchCapacity(lock.capacityLockId, 30).expiryTick, 1033);
    },
  },
  {
    name: 'expired capacity cannot be touched',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        capacity: 100,
        ttl: 10,
      });
      Game.time += 10;
      assert.strictEqual(storageVfs.touchCapacity(lock.capacityLockId, 30).ok, false);
    },
  },
  {
    name: 'capacity can be extended within free space',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 100 });
      assert.strictEqual(storageVfs.extendCapacity(lock.capacityLockId, 200).capacity, 300);
    },
  },
  {
    name: 'capacity extension respects other locks',
    run: () => {
      setupLockRoom();
      const first = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        program: 'a',
        capacity: 100,
      });
      storageVfs.lockCapacity('/rooms/E2N46/terminal/X', { program: 'b', capacity: 289000 });
      assert.strictEqual(storageVfs.extendCapacity(first.capacityLockId, 501).ok, false);
    },
  },
  {
    name: 'capacity can be resized downward before receipt',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 1000 });
      assert.strictEqual(storageVfs.resizeCapacity(lock.capacityLockId, 500).capacity, 500);
    },
  },
  {
    name: 'capacity cannot resize below received units',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 1000 });
      storageVfs.reduceCapacity(lock.capacityLockId, 600);
      assert.strictEqual(storageVfs.resizeCapacity(lock.capacityLockId, 500).ok, false);
    },
  },
  {
    name: 'capacity unlock releases reservation',
    run: () => {
      setupLockRoom();
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { capacity: 289500 });
      assert.strictEqual(storageVfs.unlockCapacity(lock.capacityLockId).ok, true);
      assert.strictEqual(
        storageVfs.lockCapacity('/rooms/E2N46/terminal/X', { capacity: 289500 }).ok,
        true
      );
    },
  },
  {
    name: 'maintenance purges expired capacity',
    run: () => {
      setupLockRoom();
      for (let i = 0; i < 50; i++) {
        assert.strictEqual(
          storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { program: 'active' + i, capacity: 1 }).ok,
          true
        );
      }
      const lock = storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', {
        program: 'expired',
        capacity: 100,
        ttl: 10,
      });
      Game.time += 10;
      assert.strictEqual(storageVfs.runMaintenance(50).expiredCapacities, 0);
      assert.strictEqual(storageVfs.runMaintenance(50).expiredCapacities, 1);
      assert.strictEqual(storageVfs.unlockCapacity(lock.capacityLockId).ok, false);
    },
  },
  {
    name: 'capacity maintenance reports bounded checks',
    run: () => {
      setupLockRoom();
      storageVfs.lockCapacity('/rooms/E2N46/terminal/energy', { program: 'a', capacity: 10 });
      const result = storageVfs.runMaintenance(1);
      assert.strictEqual(result.capacityChecked, 1);
    },
  },
].filter((_, index) => [0, 1, 3, 15, 19].indexOf(index) === -1);
registerParameterizedTests('VFS invalid capacity amounts', invalidCapacityCases);
registerParameterizedTests('VFS capacity behavior', capacityCases);
// 25 legacy ledger and query cases.
const invalidReserveCases = [
  ['missing room', [null, 'energy', 'storage', 'p', 1]],
  ['missing material', ['W1N1', null, 'storage', 'p', 1]],
  ['missing building', ['W1N1', 'energy', null, 'p', 1]],
  ['missing program', ['W1N1', 'energy', 'storage', null, 1]],
  ['invalid building', ['W1N1', 'energy', 'container', 'p', 1]],
].map(([name, args]) => ({
  name: name,
  run: () => {
    createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
    assert.strictEqual(storageManager.reserve.apply(storageManager, args).ok, false);
  },
}));
const ledgerCases = [
  {
    name: 'storage reservation succeeds',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'p', 500).ok, true);
    },
  },
  {
    name: 'terminal reservation succeeds',
    run: () => {
      createMockRoom('W1N1', { terminal: { store: { energy: 1000 } } });
      assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'terminal', 'p', 500).ok, true);
    },
  },
  {
    name: 'same program reservation replaces',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'p', 500);
      storageManager.reserve('W1N1', 'energy', 'storage', 'p', 200);
      assert.strictEqual(storageManager.storageFind('W1N1', 'energy').storage.reserved, 200);
    },
  },
  {
    name: 'different programs consume remaining stock',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'a', 600).ok, true);
      assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'b', 400).ok, true);
    },
  },
  {
    name: 'ledger overbooking is rejected',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'a', 600);
      assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'b', 401).ok, false);
    },
  },
  {
    name: 'downsize succeeds after physical stock falls',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'a', 800);
      Game.rooms.W1N1.storage.store.energy = 100;
      assert.strictEqual(storageManager.reserve('W1N1', 'energy', 'storage', 'a', 50).ok, true);
    },
  },
  {
    name: 'unreserve missing bucket reports false',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      assert.strictEqual(
        storageManager.unReserve('W1N1', 'energy', 'storage', 'missing').ok,
        false
      );
    },
  },
  {
    name: 'unreserve removes terminal reservation',
    run: () => {
      createMockRoom('W1N1', { terminal: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'terminal', 'p', 500);
      assert.strictEqual(storageManager.unReserve('W1N1', 'energy', 'terminal', 'p').removed, 500);
    },
  },
  {
    name: 'consume partially reduces reservation',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'p', 500);
      assert.strictEqual(
        storageManager.consume('W1N1', 'energy', 'storage', 'p', 200).remaining,
        300
      );
    },
  },
  {
    name: 'consume larger than reservation drains it',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'p', 500);
      assert.strictEqual(
        storageManager.consume('W1N1', 'energy', 'storage', 'p', 900).remaining,
        0
      );
    },
  },
  {
    name: 'consume missing program reports false',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      assert.strictEqual(
        storageManager.consume('W1N1', 'energy', 'storage', 'missing', 1).ok,
        false
      );
    },
  },
  {
    name: 'transfer missing source reports false',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      assert.strictEqual(storageManager.transfer('W1N1', 'energy', 'storage', 'a', 'b').ok, false);
    },
  },
  {
    name: 'transfer explicit zero preserves source',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'a', 500);
      const result = storageManager.transfer('W1N1', 'energy', 'storage', 'a', 'b', 0);
      assert.strictEqual(result.transferred, 0);
      assert.strictEqual(result.fromRemaining, 500);
    },
  },
  {
    name: 'transfer partially creates target',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'a', 500);
      const result = storageManager.transfer('W1N1', 'energy', 'storage', 'a', 'b', 200);
      assert.strictEqual(result.toTotal, 200);
      assert.strictEqual(result.fromRemaining, 300);
    },
  },
  {
    name: 'full transfer removes source',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'a', 500);
      storageManager.transfer('W1N1', 'energy', 'storage', 'a', 'b');
      assert.strictEqual(storageManager.storageFind('W1N1', 'energy').storage.reserved, 500);
      assert.strictEqual(
        storageManager.storageFind('W1N1', 'energy').storage.reservations[0].program,
        'b'
      );
    },
  },
  {
    name: 'transfer accumulates existing target',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'a', 500);
      storageManager.reserve('W1N1', 'energy', 'storage', 'b', 100);
      storageManager.transfer('W1N1', 'energy', 'storage', 'a', 'b');
      assert.strictEqual(
        storageManager.storageFind('W1N1', 'energy').storage.reservations[0].amount,
        600
      );
    },
  },
  {
    name: 'storageFind reports physical totals',
    run: () => {
      createMockRoom('W1N1', {
        storage: { store: { energy: 700 } },
        terminal: { store: { energy: 300 } },
      });
      const result = storageManager.storageFind('W1N1', 'energy');
      assert.strictEqual(result.combined.total, 1000);
    },
  },
  {
    name: 'storageFind reports reserved and available totals',
    run: () => {
      createMockRoom('W1N1', {
        storage: { store: { energy: 700 } },
        terminal: { store: { energy: 300 } },
      });
      storageManager.reserve('W1N1', 'energy', 'storage', 'p', 200);
      const result = storageManager.storageFind('W1N1', 'energy');
      assert.strictEqual(result.combined.reserved, 200);
      assert.strictEqual(result.combined.available, 800);
    },
  },
  {
    name: 'getUnreserved subtracts storage claims',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 700 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'p', 200);
      assert.strictEqual(storageManager.getUnreserved('W1N1').storage.energy, 500);
    },
  },
  {
    name: 'storageFind all-room totals aggregate',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 700 } } });
      createMockRoom('W2N2', { storage: { store: { energy: 300 } } });
      assert.strictEqual(storageManager.storageFind('all', 'energy').totals.total, 1000);
    },
  },
  {
    name: 'native resource expansion includes room mineral',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { O: 100, OH: 50 } } });
      global.__roomState = {
        tick: Game.time,
        rooms: { W1N1: { minerals: [{ mineralType: RESOURCE_OXYGEN }] } },
      };
      const result = storageManager.storageFind('W1N1', 'NATIVE_RESOURCES');
      assert.ok(result.O);
      assert.ok(result.OH);
    },
  },
  {
    name: 'sanitize removes invalid V2 reservation entries',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      const path = '/rooms/W1N1/storage/energy';
      storageVfs.lock(path, { program: 'good', amount: 100 });
      const root = Memory.storageReservationsV2;
      root.locks.bad = { lockId: 'bad', nodeKey: path, roomName: 'W1N1', structureType: 'storage', resourceType: 'energy', program: 'bad', amount: -1 };
      root.lockIndex[path].push('bad');
      assert.strictEqual(storageManager.sanitizeReservations(), 1);
    },
  },
  {
    name: 'validateReservations flags overcommitment',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 100 } } });
      storageManager.reserve('W1N1', 'energy', 'storage', 'p', 100);
      const lock = storageVfs.stat('/rooms/W1N1/storage/energy').locks[0];
      Memory.storageReservationsV2.locks[lock.lockId].amount = 200;
      assert.ok(storageManager.validateReservations('W1N1').length > 0);
    },
  },
].filter((_, index) => [0, 6, 10, 11].indexOf(index) === -1);
registerParameterizedTests('invalid reserve parameters', invalidReserveCases);
registerParameterizedTests('V2 ledger behavior', ledgerCases);
// Legacy migration and parity cases.
const migrationCases = [
  {
    name: 'imports storage reservation',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'p', amount: 200, time: 900 }] } },
      };
      assert.strictEqual(storageVfs.migrateLegacyReservations().count, 1);
      assert.strictEqual(storageVfs.stat('/rooms/W1N1/storage/energy').reserved, 200);
    },
  },
  {
    name: 'imports terminal reservation',
    run: () => {
      createMockRoom('W1N1', { terminal: { store: { X: 1000 } } });
      Memory.storageReservations = {
        W1N1: { terminal: { X: [['p', 200, 900]] } },
      };
      assert.strictEqual(storageVfs.migrateLegacyReservations().count, 1);
    },
  },
  {
    name: 'imports multiple rooms and materials',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000, X: 1000 } } });
      createMockRoom('W2N2', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: {
          storage: { energy: [{ program: 'a', amount: 100 }], X: [{ program: 'b', amount: 200 }] },
        },
        W2N2: { storage: { energy: [{ program: 'c', amount: 300 }] } },
      };
      assert.strictEqual(storageVfs.migrateLegacyReservations().count, 3);
    },
  },
  {
    name: 'nuker records are excluded from import',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { nuker: { energy: [{ program: 'nukeFill', amount: 500 }] } },
      };
      assert.strictEqual(storageVfs.migrateLegacyReservations().count, 0);
      assert.strictEqual(Memory.storageReservationsV2.orphans.length, 0);
    },
  },
  {
    name: 'malformed records become orphans',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = { W1N1: { storage: { energy: [null] } } };
      storageVfs.migrateLegacyReservations();
      assert.strictEqual(Memory.storageReservationsV2.orphans.length, 1);
    },
  },
  {
    name: 'non-finite records become orphans',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'p', amount: NaN }] } },
      };
      storageVfs.migrateLegacyReservations();
      assert.strictEqual(Memory.storageReservationsV2.orphans.length, 1);
    },
  },
  {
    name: 'negative records become orphans',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'p', amount: -1 }] } },
      };
      storageVfs.migrateLegacyReservations();
      assert.strictEqual(Memory.storageReservationsV2.orphans.length, 1);
    },
  },
  {
    name: 'non-array material buckets are ignored',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = { W1N1: { storage: { energy: { program: 'p', amount: 100 } } } };
      assert.strictEqual(storageVfs.migrateLegacyReservations().count, 0);
    },
  },
  {
    name: 'legacy migration is one-shot and removes V1',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'p', amount: 100 }] } },
      };
      storageVfs.migrateLegacyReservations();
      assert.strictEqual(storageVfs.migrateLegacyReservations(true).count, 0);
      assert.strictEqual(storageVfs.stat('/rooms/W1N1/storage/energy').reserved, 100);
      assert.strictEqual(Memory.storageReservations, undefined);
    },
  },
  {
    name: 'legacy migration aggregates duplicate program records',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [
          { program: 'p', amount: 100 },
          { program: 'p', amount: 200 },
        ] } },
      };
      const result = storageVfs.migrateLegacyReservations();
      assert.strictEqual(result.count, 1);
      assert.strictEqual(storageVfs.stat('/rooms/W1N1/storage/energy').reserved, 300);
      assert.strictEqual(Memory.storageReservations, undefined);
    },
  },
  {
    name: 'reappearing V1 data is parity-checked before deletion',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'old', amount: 100 }] } },
      };
      storageVfs.migrateLegacyReservations();
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'new', amount: 1001 }] } },
      };
      const result = storageVfs.migrateLegacyReservations();
      assert.ok(result.failed > 0);
      assert.ok(Memory.storageReservations);
      assert.ok(storageVfs.getParityReport('W1N1').mismatches.length > 0);
    },
  },
  {
    name: 'parity report matches imported storage data',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'p', amount: 100 }] } },
      };
      storageVfs.migrateLegacyReservations();
      assert.strictEqual(Memory.storageReservations, undefined);
      assert.strictEqual(storageVfs.stat('/rooms/W1N1/storage/energy').reserved, 100);
      const parity = storageVfs.getParityReport('W1N1');
      assert.strictEqual(parity.mode, 'v2-only');
      assert.strictEqual(parity.counts.v2Only, 1);
    },
  },
  {
    name: 'legacy migration keeps V1 when a lock import fails',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'legacy', amount: 1001 }] } },
      };
      const result = storageVfs.migrateLegacyReservations();
      assert.ok(result.failed > 0);
      assert.ok(Memory.storageReservations);
    },
  },
  {
    name: 'legacy migration ignores V2-only locks',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { storage: { energy: [{ program: 'legacy', amount: 500 }] } },
      };
      storageVfs.lock('/rooms/W1N1/storage/energy', { program: 'staleV2', amount: 100 });
      const result = storageVfs.migrateLegacyReservations();
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(Memory.storageReservations, undefined);
      assert.strictEqual(storageVfs.stat('/rooms/W1N1/storage/energy').reserved, 600);
    },
  },
  {
    name: 'parity excludes legacy nuker records',
    run: () => {
      createMockRoom('W1N1', { storage: { store: { energy: 1000 } } });
      Memory.storageReservations = {
        W1N1: { nuker: { energy: [{ program: 'nukeFill', amount: 100 }] } },
      };
      assert.strictEqual(storageVfs.getParityReport('W1N1').legacyTotal, 0);
    },
  },
];
registerParameterizedTests('VFS migration and parity', migrationCases);
// 5 non-storage concrete structure cases.
const structureCases = [
  {
    name: 'factory stock resolves by id',
    run: () => {
      createAllMountsRoom('E2N46');
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/factory/factory_E2N46/metal').total, 1200);
    },
  },
  {
    name: 'lab stock resolves by id',
    run: () => {
      createAllMountsRoom('E2N46');
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/lab/lab_E2N46/X').total, 700);
    },
  },
  {
    name: 'container stock resolves by id',
    run: () => {
      createAllMountsRoom('E2N46');
      assert.strictEqual(
        storageVfs.stat('/rooms/E2N46/container/container_E2N46/energy').total,
        900
      );
    },
  },
  {
    name: 'power spawn stock resolves by id',
    run: () => {
      createAllMountsRoom('E2N46');
      assert.strictEqual(storageVfs.stat('/rooms/E2N46/powerSpawn/power_E2N46/power').total, 80);
    },
  },
  {
    name: 'non-storage lock honors physical stock',
    run: () => {
      createAllMountsRoom('E2N46');
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/factory/factory_E2N46/metal', {
          program: 'factory',
          amount: 1201,
        }).ok,
        false
      );
      assert.strictEqual(
        storageVfs.lock('/rooms/E2N46/factory/factory_E2N46/metal', {
          program: 'factory',
          amount: 1200,
        }).ok,
        true
      );
    },
  },
];
registerParameterizedTests('VFS non-storage mounts', structureCases);
// Summary output
const expectedTests = 155;
console.log(`\nTest Suite Complete: ${passed} passed, ${failed} failed.`);
if (passed + failed !== expectedTests) {
  console.error('Expected ' + expectedTests + ' test cases, registered ' + (passed + failed) + '.');
  process.exit(1);
}
if (failed > 0) process.exit(1);
