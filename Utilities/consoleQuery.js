// LLM: Read llmcontext.js before reviewing or changing this file.
// consoleQuery.js
// Purpose: Register general console help commands.

var getRoomStateModule = require('getRoomState');

global.getRoomState = {
  get: function(roomName, printDetailed) {
    if (printDetailed === false) return getRoomStateModule.get(roomName);
    return getRoomStateModule.get(roomName, true);
  },
  raw: function(roomName) {
    return getRoomStateModule.get(roomName);
  },
  all: function() {
    return getRoomStateModule.all();
  },
  has: function(roomName) {
    return getRoomStateModule.has(roomName);
  },
  isOwned: function(roomName) {
    return getRoomStateModule.isOwned(roomName);
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
  print: function(roomName) {
    return getRoomStateModule.get(roomName, true);
  }
};

global.roomState = function(roomName, printDetailed) {
  if (printDetailed === false) return getRoomStateModule.get(roomName);
  return getRoomStateModule.get(roomName, true);
};

global.printRoomState = function(roomName) {
  return getRoomStateModule.get(roomName, true);
};

global.help = function() {
  console.log([
    'Console commands:',
    '  getRoomState.get("W1N1") Return cached room state',
    '  getRoomState.get("W1N1", true) Print detailed room state to console',
    '  getRoomState.raw("W1N1") Return raw cached room state',
    '  getRoomState.isOwned("W1N1") Return whether we own the room this tick',
    '  getRoomState.ownedNames() Return owned room names',
    '  roomState("W1N1")      Return cached room state',
    '  roomState("W1N1", true) Print detailed room state to console',
    '  printRoomState("W1N1")  Print detailed room state to console',
    '  marketMap()        Print room liquidity snapshot',
    '  marketUpdater.run()',
    '  ...'
  ].join('\n'));
};

module.exports = {};
