// LLM: Read docs/codex.js before reviewing or changing this file.
// consoleQuery.js
// Console globals: roomState, printRoomState, getRoomState, help
// Example: roomState('E1N1', true) - Display detailed state summary for room
// Example: printRoomState('E1N1') - Print formatted room state report
// Example: getRoomState('E1N1') - Retrieve raw room state cache object
// Example: help() - Print list of available console commands
// Example: roomState('E1N1'); help();
var getRoomStateModule = require("getRoomState");
global.getRoomState = {
  get: function(e, t) {
    // console wrapper thin — new option modes added in getRoomState.js
    if (t === undefined || t === null) {
      return getRoomStateModule.get(e);
    }
    if (t === false) return getRoomStateModule.get(e);
    if (t === true) return getRoomStateModule.get(e, true);
    if (t && t.occupancy) {
      const t = getRoomStateModule.get(e, {
        occupancy: true
      });
      return getRoomStateModule.printOccupancy(t, e);
    }
    return getRoomStateModule.get(e, t);
  },
  raw: function(e) {
    return getRoomStateModule.get(e);
  },
  all: function() {
    return getRoomStateModule.all();
  },
  has: function(e) {
    return getRoomStateModule.has(e);
  },
  isOwned: function(e) {
    return getRoomStateModule.isOwned(e);
  },
  owned: function() {
    return getRoomStateModule.owned();
  },
  ownedNames: function() {
    return getRoomStateModule.ownedNames();
  },
  init: function() {
    return getRoomStateModule.init();
  },
  print: function(e) {
    return getRoomStateModule.get(e, true);
  }
};
global.roomState = function(e, t) {
  if (t === false) return getRoomStateModule.get(e);
  return getRoomStateModule.get(e, true);
};
global.printRoomState = function(e) {
  return getRoomStateModule.get(e, true);
};
global.help = function() {
  console.log([ "Console commands:", '  getRoomState.get("W1N1") Return cached room state', '  getRoomState.get("W1N1", true) Print detailed room state to console', '  getRoomState.get("W1N1", {occupancy:true}) Print one line per tile (x,y glyph type) — terrain + exits + sources + minerals + structures', '  getRoomState.raw("W1N1") Return raw cached room state', '  getRoomState.isOwned("W1N1") Return whether we own the room this tick', "  getRoomState.ownedNames() Return owned room names", '  roomState("W1N1")      Return cached room state', '  roomState("W1N1", true) Print detailed room state to console', '  printRoomState("W1N1")  Print detailed room state to console', "  flagVault.test(1024)              Observe, write, read E4N48 flag vault test", "  flagVault.status()                Active flag vault test / put queue progress", "  flagVault.clearTest()             Clear terminal test state and failed test flags", "  flagVault.capacity()              Flag budget used/free/vault/reserve", "  flagVault.put(key, value)         Queue immutable cold write", "  flagVault.get(key)                Read cold value by logical key", "  storageOverview()                 Heap / Memory / flag / sign summary", "  datasetList()                     Registered storage datasets", "  datasetInspect(id)                Drill into one registered dataset", "  marketEconomicsArchiveStatus()    Hot/cold job archive progress", "  marketEconomicsArchivePurgePreview()  Preview 48h final-archive cleanup", "  marketEconomicsArchiveRetry()     Retry after resolving an archive error", "  marketEconomicsRetentionStatus()  Ledger bytes and compaction blockers", "  marketHistoryStatus()              Daily archive retention and capacity status", "  powerUpgradeToLevel(level)         Set the account-wide GPL target", "  cancelPowerUpgrade()               Stop GPL processing and purchases", "  powerStatus()                      Show GPL allocation and purchase status", "  freePowerLevels()                  Count GPL slots without an assigned Power Creep", "  compliance.maxEnergyCreeps()       Show living creeps matching their spawn body model", "  compliance.maxEnergyCreeps({all:true}) Include creeps below their spawn model", "  marketMap()        Print room liquidity snapshot", "  marketChaos(5)     Chaos report for 5 randomly sampled resources (order book, 3-day prints, concentration)", "  mineralMiningStatus()      Show mineral spawn scans and profitability timing", '  mineralMiningStatus("W1N1") Show one room\'s mineral spawn timing', "  spawnStatus()                      Spawn gates, stalls, supplier handoff (all owned rooms)", '  spawnStatus("W1N1")                Spawn diagnostics for one room', "  marketUpdater.run()", "  ..." ].join("\n"));
};
module.exports = {};
