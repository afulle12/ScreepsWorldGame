// LLM: Read llmcontext.js before reviewing or changing this file.
// util.js — shared helpers used across market/spawn/repair/boost modules.
// Heap caches live on `global` (wiped on global reset, same lifetime as
// every other global.* cache in this codebase).

'use strict';

// ─── Market order snapshot ───────────────────────────────────────────────
// Game.market.getAllOrders() is one of the most expensive API calls
// available. Previously it was called independently (and unfiltered, per
// side/resource) from 14 different modules, several of which run on
// different tick offsets — so no single per-tick cache could ever be
// shared between them. This snapshot is keyed by wall-clock TTL instead
// of tick equality, so it is actually shared across throttled modules.
var ORDER_TTL = 30; // ticks; order books don't move fast enough to need fresher data

function marketSnapshot(maxAge) {
  if (maxAge === undefined) maxAge = ORDER_TTL;
  var s = global.__marketOrders;
  if (!s || (Game.time - s.tick) > maxAge) {
    var all = Game.market.getAllOrders() || [];
    var idx = {};
    for (var i = 0; i < all.length; i++) {
      var o = all[i];
      if (!o || typeof o.price !== 'number') continue;
      var bucket = idx[o.resourceType];
      if (!bucket) bucket = idx[o.resourceType] = { buy: [], sell: [] };
      if (o.type === ORDER_BUY) bucket.buy.push(o);
      else if (o.type === ORDER_SELL) bucket.sell.push(o);
    }
    for (var res in idx) {
      idx[res].buy.sort(function(a, b) { return b.price - a.price; });   // best bid first
      idx[res].sell.sort(function(a, b) { return a.price - b.price; });  // best ask first
    }
    s = global.__marketOrders = { tick: Game.time, all: all, idx: idx };
  }
  return s;
}

// Drop-in-ish replacement for Game.market.getAllOrders({resourceType, type}).
// Returns a SHARED sorted array — callers must .slice() before sorting or
// mutating it, since other modules read the same reference.
function marketOrders(resourceType, type, maxAge) {
  var s = marketSnapshot(maxAge);
  var bucket = s.idx[resourceType];
  if (!bucket) return [];
  if (type === ORDER_BUY) return bucket.buy;
  if (type === ORDER_SELL) return bucket.sell;
  return bucket.buy.concat(bucket.sell);
}

// ─── Misc shared helpers (consolidates duplicated copies) ────────────────
function getMyRooms() {
  var owned = require('getRoomState').owned();
  var out = {};
  for (var rn in owned) {
    if (owned.hasOwnProperty(rn)) out[rn] = true;
  }
  return out;
}

function bodyCost(body) {
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    total += BODYPART_COST[part.type !== undefined ? part.type : part];
  }
  return total;
}

// Largest amount whose terminal transfer fee fits in energyAvail (binary
// search over Game.market.calcTransactionCost). When sellingEnergy is true,
// the amount sent and the fee both come from the same terminal energy pool.
function capByEnergy(desired, fromRoom, toRoom, energyAvail, sellingEnergy) {
  if (energyAvail <= 0 || desired <= 0) return 0;
  if (!toRoom) return 0; // guard against undefined room names
  var low = 0;
  var high = desired;
  while (low < high) {
    var mid = low + Math.ceil((high - low) / 2);
    var cost = Game.market.calcTransactionCost(mid, fromRoom, toRoom);
    var totalNeeded = sellingEnergy ? (mid + cost) : cost;
    if (totalNeeded <= energyAvail) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function getTerminalIntentMap() {
  var m = global.__terminalIntents;
  if (!m || m.tick !== Game.time) {
    m = global.__terminalIntents = { tick: Game.time, rooms: {} };
  }
  return m.rooms;
}

function markTerminalUsed(roomName) {
  if (!roomName) return;
  getTerminalIntentMap()[roomName] = true;
}

function wasTerminalUsed(roomName) {
  if (!roomName) return false;
  return !!getTerminalIntentMap()[roomName];
}

// ─── Room-edge helpers ────────────────────────────────────────────────────
function isOnRoomEdge(pos) {
  if (!pos) return false;
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

// Single-step inward off a room edge, with diagonal fallbacks.
function nudgeOffRoomEdge(creep) {
  if (creep.pos.y === 0) {
    if (creep.move(BOTTOM) === OK) return true;
    if (creep.pos.x > 0 && creep.move(BOTTOM_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(BOTTOM_RIGHT) === OK) return true;
  } else if (creep.pos.y === 49) {
    if (creep.move(TOP) === OK) return true;
    if (creep.pos.x > 0 && creep.move(TOP_LEFT) === OK) return true;
    if (creep.pos.x < 49 && creep.move(TOP_RIGHT) === OK) return true;
  } else if (creep.pos.x === 0) {
    if (creep.move(RIGHT) === OK) return true;
    if (creep.pos.y > 0 && creep.move(BOTTOM_RIGHT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(TOP_RIGHT) === OK) return true;
  } else if (creep.pos.x === 49) {
    if (creep.move(LEFT) === OK) return true;
    if (creep.pos.y > 0 && creep.move(BOTTOM_LEFT) === OK) return true;
    if (creep.pos.y < 49 && creep.move(TOP_LEFT) === OK) return true;
  }
  return false;
}

// Opposite of an 'N'/'S'/'E'/'W' edge label.
function getOppositeEdge(edge) {
  var map = { N: 'S', S: 'N', E: 'W', W: 'E' };
  return map[edge] || null;
}

function getEdgeCoords(exitDir) {
  switch (exitDir) {
    case FIND_EXIT_TOP:    return { axis: 'y', value: 0,  range: 'x' };
    case FIND_EXIT_BOTTOM: return { axis: 'y', value: 49, range: 'x' };
    case FIND_EXIT_LEFT:   return { axis: 'x', value: 0,  range: 'y' };
    case FIND_EXIT_RIGHT:  return { axis: 'x', value: 49, range: 'y' };
  }
  return null;
}

// Get the opposite exit direction (entry edge when arriving from prevRoom).
function getEntryDirection(prevRoom, thisRoom) {
  var exitDir = Game.map.findExit(prevRoom, thisRoom);
  switch (exitDir) {
    case FIND_EXIT_TOP:    return FIND_EXIT_BOTTOM;
    case FIND_EXIT_BOTTOM: return FIND_EXIT_TOP;
    case FIND_EXIT_LEFT:   return FIND_EXIT_RIGHT;
    case FIND_EXIT_RIGHT:  return FIND_EXIT_LEFT;
  }
  return -1;
}

// All walkable {x, y} tiles on the given edge of a room (terrain only).
function edgeWalkableTiles(roomName, edgeDir) {
  var terrain = Game.map.getRoomTerrain(roomName);
  if (!terrain) return [];
  var coords = getEdgeCoords(edgeDir);
  if (!coords) return [];
  var walkable = [];
  for (var i = 0; i < 50; i++) {
    var x = coords.axis === 'x' ? coords.value : i;
    var y = coords.axis === 'y' ? coords.value : i;
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
      walkable.push({ x: x, y: y });
    }
  }
  return walkable;
}

// Pick a random walkable tile on the given edge of a room using terrain data.
function pickRandomEdgeTile(roomName, edgeDir) {
  var walkable = edgeWalkableTiles(roomName, edgeDir);
  if (walkable.length === 0) return null;
  var pick = walkable[Math.floor(Math.random() * walkable.length)];
  return new RoomPosition(pick.x, pick.y, roomName);
}

// Get all walkable tiles on the given edge as PathFinder goals.
function getEdgeGoals(roomName, edgeDir) {
  var walkable = edgeWalkableTiles(roomName, edgeDir);
  var goals = [];
  for (var i = 0; i < walkable.length; i++) {
    goals.push({ pos: new RoomPosition(walkable[i].x, walkable[i].y, roomName), range: 0 });
  }
  return goals;
}

module.exports = {
  marketSnapshot: marketSnapshot,
  marketOrders: marketOrders,
  getMyRooms: getMyRooms,
  bodyCost: bodyCost,
  capByEnergy: capByEnergy,
  markTerminalUsed: markTerminalUsed,
  wasTerminalUsed: wasTerminalUsed,
  isOnRoomEdge: isOnRoomEdge,
  nudgeOffRoomEdge: nudgeOffRoomEdge,
  getOppositeEdge: getOppositeEdge,
  getEdgeCoords: getEdgeCoords,
  getEntryDirection: getEntryDirection,
  edgeWalkableTiles: edgeWalkableTiles,
  pickRandomEdgeTile: pickRandomEdgeTile,
  getEdgeGoals: getEdgeGoals,
  ORDER_TTL: ORDER_TTL,
};
