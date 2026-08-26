// LLM: Read docs/codex.js before reviewing or changing this file.
// util.js
"use strict";
var ORDER_TTL = 30;
function marketSnapshot(e) {
  if (e === undefined) e = ORDER_TTL;
  var r = global.__marketOrders;
  if (!r || Game.time - r.tick > e) {
    var t = Game.market.getAllOrders() || [];
    var a = {};
    for (var n = 0; n < t.length; n++) {
      var i = t[n];
      if (!i || typeof i.price !== "number" || !isFinite(i.price) || i.price <= 0) continue;
      var o = a[i.resourceType];
      if (!o) o = a[i.resourceType] = {
        buy: [],
        sell: []
      };
      if (i.type === ORDER_BUY) o.buy.push(i); else if (i.type === ORDER_SELL) o.sell.push(i);
    }
    for (var u in a) {
      a[u].buy.sort(function(e, r) {
        return r.price - e.price;
      });
      a[u].sell.sort(function(e, r) {
        return e.price - r.price;
      });
    }
    r = global.__marketOrders = {
      tick: Game.time,
      all: t,
      idx: a
    };
  }
  return r;
}

function marketOrders(e, r, t) {
  var a = marketSnapshot(t);
  var n = a.idx[e];
  if (!n) return [];
  if (r === ORDER_BUY) return n.buy;
  if (r === ORDER_SELL) return n.sell;
  return n.buy.concat(n.sell);
}

function getOrderRemaining(e) {
  if (!e || typeof e !== "object") return 0;
  if (typeof e.remainingAmount === "number" && isFinite(e.remainingAmount)) {
    return Math.max(0, e.remainingAmount);
  }
  if (typeof e.amount === "number" && isFinite(e.amount)) {
    return Math.max(0, e.amount);
  }
  return 0;
}

function getMyRooms() {
  var e = require("getRoomState").owned();
  var r = {};
  for (var t in e) {
    if (e.hasOwnProperty(t)) r[t] = true;
  }
  return r;
}

function bodyCost(e) {
  var r = 0;
  for (var t = 0; t < e.length; t++) {
    var a = e[t];
    r += BODYPART_COST[a.type !== undefined ? a.type : a];
  }
  return r;
}

var _transactionCostFactorCache = {};
function calcTransactionCost(e, r, t) {
  var a = r + "|" + t;
  var n = _transactionCostFactorCache[a];
  if (n === undefined) {
    var i = Game.map.getRoomLinearDistance(r, t, true);
    n = 1 - Math.exp(-i / 30);
    _transactionCostFactorCache[a] = n;
  }
  return Math.ceil(e * n);
}

function capByEnergy(e, r, t, a, n) {
  if (a <= 0 || e <= 0) return 0;
  if (!t) return 0;
  var i = 0;
  var o = e;
  while (i < o) {
    var u = i + Math.ceil((o - i) / 2);
    var s = calcTransactionCost(u, r, t);
    var m = n ? u + s : s;
    if (m <= a) {
      i = u;
    } else {
      o = u - 1;
    }
  }
  return i;
}

function getTerminalIntentMap() {
  var e = global.__terminalIntents;
  if (!e || e.tick !== Game.time) {
    e = global.__terminalIntents = {
      tick: Game.time,
      rooms: {}
    };
  }
  return e.rooms;
}

function markTerminalUsed(e) {
  if (!e) return;
  getTerminalIntentMap()[e] = true;
}

function wasTerminalUsed(e) {
  if (!e) return false;
  return !!getTerminalIntentMap()[e];
}

function parseRoomXY(e) {
  var r = /^([WE])(\d+)([NS])(\d+)$/.exec(e);
  if (!r) return null;
  var t = parseInt(r[2], 10);
  var a = parseInt(r[4], 10);
  if (r[1] === "W") t = -t - 1;
  if (r[3] === "S") a = -a - 1;
  return {
    x: t,
    y: a
  };
}

function roomNameFromXY(e, r) {
  var t = e < 0 ? "W" + (-e - 1) : "E" + e;
  var a = r < 0 ? "S" + (-r - 1) : "N" + r;
  return t + a;
}

function roomManhattanDistance(e, r) {
  var t = parseRoomXY(e);
  var a = parseRoomXY(r);
  if (!t || !a) return Infinity;
  return Math.abs(t.x - a.x) + Math.abs(t.y - a.y);
}

function roomChebyshevDistance(e, r) {
  var t = parseRoomXY(e);
  var a = parseRoomXY(r);
  if (!t || !a) return Infinity;
  return Math.max(Math.abs(t.x - a.x), Math.abs(t.y - a.y));
}

//   'intersection' — both coords divisible by 10 (sector corner)
//   'highway'      — exactly one coord divisible by 10
//   'sourceKeeper'  — both coords' mod-10 remainder in [4, 6]
//   null           — normal room (claimed / unclaimed resolved from live data)
function getRoomSectorType(e) {
  var r = /^[WE](\d+)[NS](\d+)$/.exec(e);
  if (!r) return null;
  var t = parseInt(r[1], 10) % 10;
  var a = parseInt(r[2], 10) % 10;
  if (t === 0 && a === 0) return "intersection";
  if (t === 0 || a === 0) return "highway";
  if (t >= 4 && t <= 6 && a >= 4 && a <= 6) return "sourceKeeper";
  return null;
}

function isClaimableRoomCoord(e) {
  return getRoomSectorType(e) === null;
}

function isOnRoomEdge(e) {
  if (!e) return false;
  return e.x === 0 || e.x === 49 || e.y === 0 || e.y === 49;
}

function nudgeOffRoomEdge(e) {
  if (e.pos.y === 0) {
    if (e.move(BOTTOM) === OK) return true;
    if (e.pos.x > 0 && e.move(BOTTOM_LEFT) === OK) return true;
    if (e.pos.x < 49 && e.move(BOTTOM_RIGHT) === OK) return true;
  } else if (e.pos.y === 49) {
    if (e.move(TOP) === OK) return true;
    if (e.pos.x > 0 && e.move(TOP_LEFT) === OK) return true;
    if (e.pos.x < 49 && e.move(TOP_RIGHT) === OK) return true;
  } else if (e.pos.x === 0) {
    if (e.move(RIGHT) === OK) return true;
    if (e.pos.y > 0 && e.move(BOTTOM_RIGHT) === OK) return true;
    if (e.pos.y < 49 && e.move(TOP_RIGHT) === OK) return true;
  } else if (e.pos.x === 49) {
    if (e.move(LEFT) === OK) return true;
    if (e.pos.y > 0 && e.move(BOTTOM_LEFT) === OK) return true;
    if (e.pos.y < 49 && e.move(TOP_LEFT) === OK) return true;
  }
  return false;
}

function getOppositeEdge(e) {
  var r = {
    N: "S",
    S: "N",
    E: "W",
    W: "E"
  };
  return r[e] || null;
}

function getEdgeCoords(e) {
  switch (e) {
   case FIND_EXIT_TOP:
    return {
      axis: "y",
      value: 0,
      range: "x"
    };
   case FIND_EXIT_BOTTOM:
    return {
      axis: "y",
      value: 49,
      range: "x"
    };
   case FIND_EXIT_LEFT:
    return {
      axis: "x",
      value: 0,
      range: "y"
    };
   case FIND_EXIT_RIGHT:
    return {
      axis: "x",
      value: 49,
      range: "y"
    };
  }
  return null;
}

function getEntryDirection(e, r) {
  var t = Game.map.findExit(e, r);
  switch (t) {
   case FIND_EXIT_TOP:
    return FIND_EXIT_BOTTOM;
   case FIND_EXIT_BOTTOM:
    return FIND_EXIT_TOP;
   case FIND_EXIT_LEFT:
    return FIND_EXIT_RIGHT;
   case FIND_EXIT_RIGHT:
    return FIND_EXIT_LEFT;
  }
  return -1;
}

function edgeWalkableTiles(e, r) {
  var t = Game.map.getRoomTerrain(e);
  if (!t) return [];
  var a = getEdgeCoords(r);
  if (!a) return [];
  var n = [];
  for (var i = 0; i < 50; i++) {
    var o = a.axis === "x" ? a.value : i;
    var u = a.axis === "y" ? a.value : i;
    if (t.get(o, u) !== TERRAIN_MASK_WALL) {
      n.push({
        x: o,
        y: u
      });
    }
  }
  return n;
}

function pickRandomEdgeTile(e, r) {
  var t = edgeWalkableTiles(e, r);
  if (t.length === 0) return null;
  var a = t[Math.floor(Math.random() * t.length)];
  return new RoomPosition(a.x, a.y, e);
}

function getEdgeGoals(e, r) {
  var t = edgeWalkableTiles(e, r);
  var a = [];
  for (var n = 0; n < t.length; n++) {
    a.push({
      pos: new RoomPosition(t[n].x, t[n].y, e),
      range: 0
    });
  }
  return a;
}

function getPlayerUsername() {
  if (typeof Game === "undefined" || !Game.spawns) return undefined;
  var e = global.__playerUsername;
  if (e !== undefined) return e;
  var r = Object.keys(Game.spawns);
  for (var t = 0; t < r.length; t++) {
    var a = Game.spawns[r[t]];
    if (a && a.owner && a.owner.username) {
      global.__playerUsername = a.owner.username;
      return a.owner.username;
    }
  }
  return undefined;
}

function resetPlayerUsernameCache() {
  global.__playerUsername = undefined;
}

var _ptCacheTick = -1;
var _ptCache = null;
var _ptDateStr = null;
var _ptDayKey = null;
function getPacificTime(e) {
  if (e) return _computePacificTime(e);
  if (typeof Game !== "undefined" && Game.time === _ptCacheTick && _ptCache) {
    return _ptCache;
  }
  _ptCache = _computePacificTime(new Date);
  _ptDateStr = null;
  _ptDayKey = null;
  if (typeof Game !== "undefined") _ptCacheTick = Game.time;
  return _ptCache;
}

function _computePacificTime(e) {
  try {
    var r = e.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      hour12: false
    });
    var t = r.split(", ");
    var a = t[0].split("/");
    var n = t[1].split(":");
    return {
      year: parseInt(a[2], 10),
      month: parseInt(a[0], 10),
      day: parseInt(a[1], 10),
      hours: parseInt(n[0], 10) % 24,
      minutes: parseInt(n[1], 10),
      seconds: parseInt(n[2], 10)
    };
  } catch (r) {
    var i = new Date(e.getTime() - 8 * 36e5);
    return {
      year: i.getUTCFullYear(),
      month: i.getUTCMonth() + 1,
      day: i.getUTCDate(),
      hours: i.getUTCHours(),
      minutes: i.getUTCMinutes(),
      seconds: i.getUTCSeconds()
    };
  }
}

function pacificDateString(e) {
  if (!e && typeof Game !== "undefined" && Game.time === _ptCacheTick && _ptDateStr) {
    return _ptDateStr;
  }
  var r = getPacificTime(e);
  var t = r.year + "-" + String(r.month).padStart(2, "0") + "-" + String(r.day).padStart(2, "0");
  if (!e && typeof Game !== "undefined" && Game.time === _ptCacheTick) _ptDateStr = t;
  return t;
}

function pacificDayKey(e) {
  if (!e && typeof Game !== "undefined" && Game.time === _ptCacheTick && _ptDayKey) {
    return _ptDayKey;
  }
  var r = pacificDateString(e).replace(/-/g, "");
  if (!e && typeof Game !== "undefined" && Game.time === _ptCacheTick) _ptDayKey = r;
  return r;
}

module.exports = {
  marketSnapshot: marketSnapshot,
  marketOrders: marketOrders,
  getOrderRemaining: getOrderRemaining,
  getMyRooms: getMyRooms,
  bodyCost: bodyCost,
  calcTransactionCost: calcTransactionCost,
  capByEnergy: capByEnergy,
  parseRoomXY: parseRoomXY,
  roomNameFromXY: roomNameFromXY,
  roomManhattanDistance: roomManhattanDistance,
  roomChebyshevDistance: roomChebyshevDistance,
  getRoomSectorType: getRoomSectorType,
  isClaimableRoomCoord: isClaimableRoomCoord,
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
  getPacificTime: getPacificTime,
  pacificDateString: pacificDateString,
  pacificDayKey: pacificDayKey,
  ORDER_TTL: ORDER_TTL,
  PLAYER_USERNAME: getPlayerUsername,
  resetPlayerUsernameCache: resetPlayerUsernameCache
};
