// LLM: Read docs/codex.js before changing this file.
// test/harvester_source_recovery_harness.js
// Verifies that emergency source assignment is checkpointed once.

const assert = require('assert');
const Module = require('module');

const saves = [];
const stubs = {
  getRoomState: {},
  memoryManager: {
    heap: {},
    requestSave: function () {
      saves.push('checkpoint');
    },
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return originalLoad(request, parent, isMain);
};

const roleHarvester = require('../roleHarvester');
const source = { id: 'source-E9N49-1' };
const creep = {
  name: 'Repairer_E9N49_extra_2543',
  memory: {},
  pos: {
    findClosestByRange: function () {
      return source;
    },
  },
};

roleHarvester.findNearestSource(creep, { sources: [source] });
assert.strictEqual(creep.memory.sourceId, source.id);
assert.deepStrictEqual(saves, ['checkpoint']);

roleHarvester.findNearestSource(creep, { sources: [source] });
assert.deepStrictEqual(saves, ['checkpoint']);

creep.memory.sourceId = 'stale-source';
roleHarvester.findNearestSource(creep, { sources: [source] });
assert.deepStrictEqual(saves, ['checkpoint', 'checkpoint']);

Module._load = originalLoad;
console.log('Harvester source recovery harness complete.');
