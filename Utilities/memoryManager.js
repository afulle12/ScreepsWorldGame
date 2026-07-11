// memoryManager.js
// Purpose: Heap-backed Memory. Keeps the parsed Memory object on the heap
// across ticks (skipping the per-tick JSON.parse) and only serializes it to
// the persistent store every SAVE_INTERVAL ticks or on demand, skipping the
// per-tick JSON.stringify the rest of the time.
//
// How it works: each tick the runtime defines global.Memory as a lazy getter
// that JSON.parses RawMemory on first access, records the result in
// RawMemory._parsed, and JSON.stringifies RawMemory._parsed at end of tick
// if it is set. run() replaces the getter with the heap object before
// anything touches Memory (no parse), and only sets RawMemory._parsed on
// save ticks — on other ticks the server rewrites the unchanged string with
// no serialization cost.
//
// The trade-off: a global reset discards the heap, so Memory rolls back to
// the last save (up to SAVE_INTERVAL - 1 ticks old). Code whose Memory
// mutations cannot afford that must call requestSave() the tick it writes.
// Edits made through the client's Memory UI are never read and get
// clobbered on the next save tick; use memoryReload() after such edits.
//
// SAVE_INTERVAL must divide spawnManager's 10-tick cadence so new creep
// memory (written by spawnCreep) is serialized the same tick it appears.
const SAVE_INTERVAL = 10;

// Shared namespace for transient cross-tick state (telemetry, profiling,
// caches). Lives on the heap only: never serialized, empty after every
// global reset. Anything that must survive a reset belongs in Memory.
// Usage: const heap = require('memoryManager').heap;
const heap = {};

let heapMemory = null;
let saveRequested = false;
let reloadRequested = false;

function run() {
  if (reloadRequested) {
    reloadRequested = false;
    heapMemory = null;
  }

  if (heapMemory) {
    delete global.Memory;
    global.Memory = heapMemory;
  } else {
    // Fresh global (or requested reload): the getter parses the store once.
    heapMemory = Memory;
    console.log('[memoryManager] Parsed Memory from the persistent store (tick ' + Game.time + ')');
  }

  if (saveRequested || Game.time % SAVE_INTERVAL === 0) {
    RawMemory._parsed = heapMemory;
    saveRequested = false;
  }
}

function requestSave() {
  saveRequested = true;
}

global.memorySave = function() {
  saveRequested = true;
  if (heapMemory) RawMemory._parsed = heapMemory;
  return 'Heap Memory will be serialized to the persistent store at end of tick.';
};

global.memoryReload = function() {
  reloadRequested = true;
  return 'Discarding heap Memory next tick and re-parsing from the persistent store. Heap changes since the last save will be lost.';
};

module.exports = {
  run: run,
  requestSave: requestSave,
  heap: heap,
  SAVE_INTERVAL: SAVE_INTERVAL,
};
