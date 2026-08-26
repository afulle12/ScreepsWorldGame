// LLM: Read docs/codex.js before reviewing or changing this file.
// test/flag_vault_harness.js
// Covers the multi-tick cold write: incremental staging, resume, and round-trip.

const assert = require('assert');

global.OK = 0;
global.COLOR_RED = 1;

let flagStore = {};
let pendingFlags = [];
let removedFlags = [];

function makeFlag(name, x, y, roomName, color, secondaryColor) {
  return {
    name: name,
    color: color,
    secondaryColor: secondaryColor,
    pos: { x: x, y: y, roomName: roomName },
    remove: function () {
      removedFlags.push(name);
      return OK;
    },
  };
}

global.RoomPosition = function (x, y, roomName) {
  this.x = x;
  this.y = y;
  this.roomName = roomName;
};
// createFlag is an intent: the flag only appears in Game.flags on a later tick.
global.RoomPosition.prototype.createFlag = function (name, color, secondaryColor) {
  pendingFlags.push(makeFlag(name, this.x, this.y, this.roomName, color, secondaryColor));
  return name;
};

const ROOM = 'E4N48';

global.Memory = {};
global.Game = { time: 1000, flags: {}, rooms: {} };
global.Game.rooms[ROOM] = { name: ROOM };

// Minimal memoryManager stand-in: flagVault only uses storage.ensure and the
// save hooks, and requiring the real module would drag in the whole codebase.
const fakeStore = { index: {}, queue: [], orphans: [] };
require.cache[require.resolve('../memoryManager.js')] = {
  id: require.resolve('../memoryManager.js'),
  filename: require.resolve('../memoryManager.js'),
  loaded: true,
  exports: {
    storage: {
      ensure: function () {
        return fakeStore;
      },
      get: function () {
        return null;
      },
      set: function () {},
      remove: function () {},
    },
    requestSave: function () {},
    requestImmediateSave: function () {},
  },
};

const flagVault = require('../flagVault.js');

function endTick() {
  for (let i = 0; i < pendingFlags.length; i++) {
    flagStore[pendingFlags[i].name] = pendingFlags[i];
  }
  pendingFlags = [];
  Game.time++;
  Game.flags = flagStore;
}

function reset() {
  flagStore = {};
  pendingFlags = [];
  removedFlags = [];
  Game.time = 1000;
  Game.flags = flagStore;
  fakeStore.index = {};
  fakeStore.queue = [];
  fakeStore.orphans = [];
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}

const VALUE = {
  type: 'cold-snapshot',
  unicode: 'snowman ☃',
  rows: [],
};
for (let i = 0; i < 120; i++) VALUE.rows.push({ i: i, v: i * 7919, tag: 'row-' + i });

test('a queued put stages over many ticks and round-trips', function () {
  reset();
  flagVault.put('demo', VALUE);

  const estimated = flagVault.estimateFlagCount(
    Buffer.byteLength(JSON.stringify(VALUE), 'utf8')
  );
  assert(estimated > 40, 'test payload should need enough flags to span ticks');

  let stageTicks = 0;
  let maxFlagsPerTick = 0;
  let blockId = null;
  for (let i = 0; i < 60 && !fakeStore.index.demo; i++) {
    const before = pendingFlags.length;
    flagVault.tick();
    const created = pendingFlags.length - before;
    if (created > maxFlagsPerTick) maxFlagsPerTick = created;
    const q = fakeStore.queue[0];
    if (q && q.phase === 'stage') {
      stageTicks++;
      if (q.id) {
        if (blockId === null) blockId = q.id;
        // The id embeds the tick staging began; it must not drift on resume.
        assert.strictEqual(q.id, blockId);
      }
    }
    endTick();
  }

  assert(stageTicks > 1, 'staging should span more than one tick, got ' + stageTicks);
  assert(maxFlagsPerTick <= 20, 'per-tick flag intents should be capped, got ' + maxFlagsPerTick);
  assert(fakeStore.index.demo, 'write never committed');
  assert.deepStrictEqual(flagVault.get('demo'), VALUE);
});

test('a small direct stage still writes the whole block in one tick', function () {
  reset();
  const small = { hello: 'world' };
  const r = flagVault.stage(small, ROOM);

  assert.strictEqual(r.remaining, 0);
  assert.strictEqual(r.created, r.dataFlags + r.parityFlags);
  endTick();
  flagVault.commit(r.id);
  endTick();
  assert.deepStrictEqual(flagVault.read(r.id).value, small);
});

test('capacity counts vault and conventional flags from one scan', function () {
  reset();
  const r = flagVault.stage({ a: 1 }, ROOM);
  endTick();
  flagStore.myPlainFlag = makeFlag('myPlainFlag', 5, 5, ROOM, 1, 1);
  Game.flags = flagStore;
  Game.time++;

  const cap = flagVault.capacity();
  assert.strictEqual(cap.vaultFlags, r.dataFlags + r.parityFlags);
  assert.strictEqual(cap.usedFlags, cap.vaultFlags + 1);
  assert.strictEqual(cap.conventional, 1);
});

test('a resumed stage refuses a value that no longer matches the block id', function () {
  reset();
  const first = flagVault.stage(VALUE, ROOM, { budget: 5 });
  endTick();
  assert.throws(function () {
    flagVault.stage({ different: true }, ROOM, { id: first.id, budget: 5 });
  }, /staged value changed/);
});

console.log('Flag vault harness complete.');
process.exitCode = failures ? 1 : 0;
