// LLM: Read docs/codex.js before reviewing or changing this file.
// test/room_navigation_harness.js
// Dependency-free contracts for the shared room navigation primitives.

var assert = require('assert');
var Module = require('module');
global.OK = 0;
global.ERR_NO_PATH = -2;
global.ERR_INVALID_ARGS = -10;
global.ERR_NOT_FOUND = -5;
global.ERR_TIRED = -11;
global.FIND_EXIT_TOP = 1;
global.FIND_EXIT_RIGHT = 3;
global.FIND_EXIT_BOTTOM = 5;
global.FIND_EXIT_LEFT = 7;
global.FIND_STRUCTURES = 101;
global.FIND_MY_STRUCTURES = 102;
global.FIND_HOSTILE_STRUCTURES = 103;
global.FIND_MY_CREEPS = 104;
global.FIND_MY_SPAWNS = 105;
global.FIND_CREEPS = 106;
global.STRUCTURE_WALL = 'constructedWall';
global.STRUCTURE_RAMPART = 'rampart';
global.STRUCTURE_ROAD = 'road';
global.STRUCTURE_OBSERVER = 'observer';
global.STRUCTURE_TOWER = 'tower';
global.TERRAIN_MASK_WALL = 1;
global.OBSTACLE_OBJECT_TYPES = ['constructedWall', 'tower'];
global.Memory = { roomRegistry: { rooms: {} } };
function CostMatrix() {
  this.values = {};
}

CostMatrix.prototype.set = function (x, y, value) {
  this.values[x + ':' + y] = value;
};
CostMatrix.prototype.get = function (x, y) {
  return this.values[x + ':' + y] || 0;
};
CostMatrix.prototype.clone = function () {
  var copy = new CostMatrix();
  for (var key in this.values) copy.values[key] = this.values[key];
  return copy;
};
function RoomPosition(x, y, roomName) {
  this.x = x;
  this.y = y;
  this.roomName = roomName;
}

RoomPosition.prototype.findClosestByPath = function () {
  return new RoomPosition(49, 25, this.roomName);
};
RoomPosition.prototype.findClosestByRange = function () {
  return new RoomPosition(49, 25, this.roomName);
};
global.RoomPosition = RoomPosition;
global.PathFinder = {
  CostMatrix: CostMatrix,
  search: function () {
    return { incomplete: false, path: [new RoomPosition(26, 25, 'W1N1')], ops: 1 };
  },
};
var exits = {
  W1N1: {
    1: 'W1N2',
    3: 'W2N1',
    5: 'W1N0',
    7: 'W0N1',
  },
  W1N2: { 5: 'W1N1' },
  W2N1: { 7: 'W1N1' },
  W1N0: { 1: 'W1N1' },
  W0N1: { 3: 'W1N1' },
};
function distance(a, b) {
  var parse = /^([WE])(\d+)([NS])(\d+)$/.exec(a);
  var other = /^([WE])(\d+)([NS])(\d+)$/.exec(b);
  if (!parse || !other) return Infinity;
  return Math.max(
    Math.abs(parseInt(parse[2], 10) - parseInt(other[2], 10)),
    Math.abs(parseInt(parse[4], 10) - parseInt(other[4], 10))
  );
}

function findRoute(from, to, options) {
  if (from === to) return [];
  var queue = [{ room: from, path: [] }];
  var visited = { [from]: true };
  while (queue.length > 0) {
    var current = queue.shift();
    var roomExits = exits[current.room] || {};
    for (var key in roomExits) {
      var next = roomExits[key];
      if (visited[next]) continue;
      if (
        options &&
        options.routeCallback &&
        options.routeCallback(next, current.room) === Infinity
      )
        continue;
      var step = current.path.concat([{ room: next, exit: parseInt(key, 10) }]);
      if (next === to) return step;
      visited[next] = true;
      queue.push({ room: next, path: step });
    }
  }
  return ERR_NO_PATH;
}

global.Game = {
  time: 100,
  rooms: {},
  map: {
    describeExits: function (roomName) {
      return exits[roomName] || null;
    },
    findExit: function (from, to) {
      var roomExits = exits[from] || {};
      for (var key in roomExits) if (roomExits[key] === to) return parseInt(key, 10);
      return ERR_NO_PATH;
    },
    findRoute: findRoute,
    getRoomLinearDistance: distance,
    getRoomTerrain: function () {
      return {
        get: function () {
          return 0;
        },
      };
    },
    getRoomStatus: function () {
      return { status: 'normal' };
    },
  },
};
var originalLoad = Module._load;
var projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
var projectUtil = require('../util');
Module._load = function (request, parent, isMain) {
  if (
    request === 'util' &&
    parent &&
    parent.filename &&
    parent.filename.indexOf(projectRoot) === 0
  ) {
    return projectUtil;
  }
  if (
    request === 'iff' &&
    parent &&
    parent.filename &&
    parent.filename.indexOf(projectRoot) === 0
  ) {
    return {
      isFriendlyUsername: function () {
        return false;
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
var roomNavigation = require('../roomNavigation');
function makeRoom(name, structures) {
  var room = {
    name: name,
    controller: null,
    getTerrain: function () {
      return {
        get: function () {
          return 0;
        },
      };
    },
    find: function (type) {
      if (type === FIND_STRUCTURES) return structures || [];
      if (type === FIND_MY_STRUCTURES) return [];
      if (type === FIND_HOSTILE_STRUCTURES) return [];
      if (type === FIND_MY_CREEPS || type === FIND_MY_SPAWNS || type === FIND_CREEPS) return [];
      if (type === FIND_EXIT_TOP) return [new RoomPosition(25, 0, name)];
      if (type === FIND_EXIT_RIGHT) return [new RoomPosition(49, 25, name)];
      if (type === FIND_EXIT_BOTTOM) return [new RoomPosition(25, 49, name)];
      if (type === FIND_EXIT_LEFT) return [new RoomPosition(0, 25, name)];
      return [];
    },
    findExitTo: function (roomName) {
      return Game.map.findExit(name, roomName);
    },
  };
  Game.rooms[name] = room;
  return room;
}

function test(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (error) {
    console.error('FAIL ' + name);
    throw error;
  }
}

test('classifies sectors and room types', function () {
  assert.strictEqual(roomNavigation.isHighwayRoom('W10N10'), true);
  assert.strictEqual(roomNavigation.isSourceKeeperRoom('W15N15'), true);
  assert.strictEqual(roomNavigation.areInSameSector('W1N1', 'W9N9'), true);
  assert.strictEqual(roomNavigation.areInSameSector('W1N1', 'W11N1'), false);
  assert.strictEqual(roomNavigation.getSectorName('E4N49'), 'E0N40');
});

test('uses map exits for topology and direction', function () {
  assert.strictEqual(roomNavigation.getAdjacentRoom('W1N1', 'E'), 'W2N1');
  assert.strictEqual(roomNavigation.getExitDirection('W1N1', 'W2N1'), 'E');
  assert.strictEqual(roomNavigation.getEntryDirection('W1N1', 'W2N1'), 'W');
  assert.strictEqual(roomNavigation.areRoomsAdjacent('W1N1', 'W2N1'), true);
  assert.strictEqual(roomNavigation.areRoomsAdjacent('W1N1', 'W2N2'), false);
});

test('builds policy-specific matrices', function () {
  var room = makeRoom('W1N1', [
    { structureType: STRUCTURE_WALL, pos: { x: 3, y: 3 } },
    { structureType: STRUCTURE_TOWER, pos: { x: 4, y: 4 } },
  ]);
  var basic = roomNavigation.buildCostMatrix(room, { blockObstacles: false, cacheTtl: 1 });
  var strict = roomNavigation.buildCostMatrix(room, { blockObstacles: true, cacheTtl: 1 });
  assert.strictEqual(basic.get(3, 3), 255);
  assert.strictEqual(basic.get(4, 4), 0);
  assert.strictEqual(strict.get(4, 4), 255);
});

test('checks one-room traversal and route validation', function () {
  makeRoom('W1N1', []);
  assert.strictEqual(
    roomNavigation.checkRoomTraversal('W1N1', 'W0N1', 'W2N1', {
      entryStrategy: 'random',
      swampCost: 2,
      blockObstacles: false,
    }),
    true
  );
  assert.deepStrictEqual(
    roomNavigation.validateRouteTraversal(['W0N1', 'W1N1', 'W2N1'], {
      entryStrategy: 'random',
      swampCost: 2,
      blockObstacles: false,
    }),
    []
  );
});

test('finds weighted routes and highway candidates', function () {
  assert.deepStrictEqual(roomNavigation.findLinearRoute('W1N1', 'W2N1', []), ['W1N1', 'W2N1']);
  assert.deepStrictEqual(roomNavigation.findLinearRoute('W1N1', 'W1N1', []), ['W1N1']);
  assert.strictEqual(
    roomNavigation.highwayRouteCost('W1N1', 'W0N1', { highwayCost: 1, interiorCost: 2.5 }),
    1
  );
  var paths = roomNavigation.bfsFindHighwayPaths('W1N1', 'W1N2', 4, {
    canReachRoom: function () {
      return true;
    },
  });
  assert.ok(paths.length > 0);
  assert.strictEqual(paths[0][0].room, 'W1N1');
  assert.strictEqual(paths[0][0].entryDir, null);
  assert.ok(
    paths[0][paths[0].length - 1].room === 'W0N1' || paths[0][paths[0].length - 1].room === 'W1N0'
  );
});

test('honors explicit route state and scan adapters', function () {
  var creep = { memory: {} };
  var requested = null;
  assert.strictEqual(
    roomNavigation.ensureRoute(creep, 'W1N1', 'W2N1', 'route', [], [], {
      roomStatus: {},
      blockedEdges: {},
      liveEdgeCheck: false,
      requestObserverScan: function (roomName) {
        requested = roomName;
        return true;
      },
    }),
    null
  );
  assert.strictEqual(requested, 'W1N1');
  assert.strictEqual(typeof roomNavigation.validateEdgeLive, 'function');
});

test('does not mutate routes and constrains corridor movement', function () {
  var room = makeRoom('W1N1', []);
  var route = ['W1N1', 'W2N1'];
  var moves = [];
  var creep = {
    room: room,
    pos: new RoomPosition(25, 25, 'W1N1'),
    memory: {},
    moveTo: function (target, options) {
      moves.push({ target: target, options: options });
      return OK;
    },
  };
  assert.strictEqual(roomNavigation.followRoomRoute(creep, route, { goalRoom: 'W2N1' }), OK);
  assert.deepStrictEqual(route, ['W1N1', 'W2N1']);
  assert.strictEqual(moves[0].options.maxRooms, 1);
  assert.strictEqual(creep.memory._exitTarget.nextRoom, 'W2N1');
});

test('does not let allowed targets bypass blocked edges', function () {
  assert.strictEqual(
    roomNavigation.findLinearRoute('W1N1', 'W2N1', {
      allowedRooms: ['W2N1'],
      allowTarget: true,
      blockedEdges: { 'W1N1:W2N1': true },
    }),
    null
  );
});

test('reuses matrices across the configured TTL', function () {
  Game.time = 200;
  var structures = [];
  var room = makeRoom('W2N1', structures);
  var first = roomNavigation.buildCostMatrix(room, { cacheTtl: 5 });
  structures.push({ structureType: STRUCTURE_WALL, pos: { x: 6, y: 6 } });
  Game.time = 201;
  assert.strictEqual(
    roomNavigation.buildCostMatrix(room, { cacheTtl: 5 }).get(6, 6),
    first.get(6, 6)
  );
  Game.time = 205;
  assert.strictEqual(roomNavigation.buildCostMatrix(room, { cacheTtl: 5 }).get(6, 6), 255);
});

test('reports any reachable exit when no destination is supplied', function () {
  var room = makeRoom('W1N1', []);
  var result = roomNavigation.checkRoomPassability(room, null, null, { blockObstacles: false });
  assert.strictEqual(result.passable, true);
  assert.ok(result.availableExits.length > 0);
  assert.strictEqual(
    roomNavigation.checkRoomPassability(room, 'W9N9', 'W2N1', {
      blockObstacles: false,
    }).reason,
    'no_entry_from_W9N9'
  );
});

test('peels a creep off a wrong exit edge before route movement', function () {
  var room = makeRoom('W1N1', []);
  var moves = [];
  var creep = {
    room: room,
    pos: new RoomPosition(25, 0, 'W1N1'),
    memory: {},
    moveTo: function (target, options) {
      moves.push({ target: target, options: options });
      return OK;
    },
  };
  assert.strictEqual(
    roomNavigation.followRoomRoute(creep, ['W1N1', 'W2N1'], {
      goalRoom: 'W2N1',
    }),
    OK
  );
  assert.strictEqual(moves[0].target.x, 25);
  assert.strictEqual(moves[0].target.y, 25);
  assert.strictEqual(creep.memory._exitTarget, undefined);
});

test('requires an observer adapter and supports explicit adapters', function () {
  Memory = {};
  assert.strictEqual(roomNavigation.requestObserverScan('W1N1'), false);
  assert.strictEqual(Memory.depositObserver, undefined);
  var requested = null;
  assert.strictEqual(
    roomNavigation.requestObserverScan('W1N1', function (roomName) {
      requested = roomName;
      return true;
    }),
    true
  );
  assert.strictEqual(requested, 'W1N1');
});

Module._load = originalLoad;
console.log('Room navigation harness complete.');
