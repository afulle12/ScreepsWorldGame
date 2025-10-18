// getRoomState.js
// Purpose: Build and expose per-tick room state for rooms you own OR have your creeps in.
// API:
//   - getRoomState.init()           -> build cache once per tick
//   - getRoomState.get(roomName)    -> get state for a room (or undefined)
//   - getRoomState.all()            -> get map of all cached rooms
//   - getRoomState.has(roomName)    -> boolean, whether room is cached this tick
// Notes:
//   - Dynamic arrays/objects are for read-only consumption within the tick.
//   - No optional chaining used. Avoid mutating returned arrays.
//   - Structures-by-type are throttled and cached for a few ticks to reduce CPU.

var getRoomState = (function () {
  var STRUCTURES_TTL = 25; // ticks to reuse structuresByType cache

  function groupStructuresByType(list) {
    var map = {};
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var t = s.structureType;
      if (!map[t]) map[t] = [];
      map[t].push(s);
    }
    return map;
  }

  function buildCreepsIndex() {
    var idx = {};
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      var rname = c.room && c.room.name ? c.room.name : null;
      if (!rname) continue;
      if (!idx[rname]) idx[rname] = [];
      idx[rname].push(c);
    }
    return idx;
  }

  function ensureCache() {
    if (!global.__roomState || global.__roomState.tick !== Game.time) {
      var rooms = Game.rooms;
      var byRoom = {};
      var creepsIdx = buildCreepsIndex();

      // Cache semi-static structures for a few ticks
      if (!global.__roomStateStructures) {
        global.__roomStateStructures = { byRoom: {} };
      }

      for (var roomName in rooms) {
        if (!rooms.hasOwnProperty(roomName)) continue;
        var room = rooms[roomName];
        var owned = room.controller && room.controller.my;
        var myCreepsHere = creepsIdx[roomName] || [];

        // Only include rooms we own or where we currently have creeps
        if (!owned && myCreepsHere.length === 0) continue;

        // structuresByType with TTL
        var stData = global.__roomStateStructures.byRoom[roomName];
        var useCachedStructures = stData && (Game.time - stData.lastUpdate) < STRUCTURES_TTL;
        var structuresByType = useCachedStructures
          ? stData.structuresByType
          : groupStructuresByType(room.find(FIND_STRUCTURES));
        if (!useCachedStructures) {
          global.__roomStateStructures.byRoom[roomName] = {
            lastUpdate: Game.time,
            structuresByType: structuresByType
          };
        }

        byRoom[roomName] = {
          name: roomName,
          time: Game.time,

          // Static-ish references
          controller: room.controller,
          storage: room.storage,
          terminal: room.terminal,

          // Dynamic (refresh every tick)
          myCreeps: myCreepsHere,
          hostiles: room.find(FIND_HOSTILE_CREEPS),
          dropped: room.find(FIND_DROPPED_RESOURCES),
          tombstones: room.find(FIND_TOMBSTONES),
          ruins: room.find(FIND_RUINS),
          constructionSites: room.find(FIND_CONSTRUCTION_SITES),

          // Semi-static (okay to refresh each tick, or throttled via structures cache)
          sources: room.find(FIND_SOURCES),
          minerals: room.find(FIND_MINERALS),
          structuresByType: structuresByType
        };
      }

      global.__roomState = { tick: Game.time, rooms: byRoom };
    }
  }

  function init() { ensureCache(); }
  function get(roomName) { ensureCache(); return global.__roomState.rooms[roomName]; }
  function all() { ensureCache(); return global.__roomState.rooms; }
  function has(roomName) { ensureCache(); return !!global.__roomState.rooms[roomName]; }

  return { init: init, get: get, all: all, has: has };
})();

module.exports = getRoomState;
