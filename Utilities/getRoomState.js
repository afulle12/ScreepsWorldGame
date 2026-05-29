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
//   - Each find type is throttled independently based on rate of change.

var getRoomState = (function () {

  // ─── TTLs (ticks to reuse each cached find) ────────────────────────────────
  // Tune these: higher = less CPU, lower = fresher data.
  var TTL_STRUCTURES        = 25;  // walls/roads/etc rarely change
  var TTL_SOURCES           = 500; // sources never move; only need re-find if room is lost/regained
  var TTL_MINERALS          = 500; // same as sources
  var TTL_CONSTRUCTION      = 25;  // sites placed/completed occasionally
  var TTL_RUINS             = 50;  // ruins decay slowly
  var TTL_TOMBSTONES        = 10;  // tombstones appear after combat, decay in 100 ticks
  var TTL_DROPPED           = 5;   // resources appear/decay moderately fast
  var TTL_HOSTILES          = 1;   // always fresh — safety critical

  // ─── HELPERS ───────────────────────────────────────────────────────────────

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

  // ─── PER-ROOM THROTTLED FIND ──────────────────────────────────────────────
  // Returns cached result if within TTL, otherwise re-finds.
  // `store` is the per-room persistent cache object.
  // `key` is the cache slot name (e.g. "sources").
  // `room` is the Room object.
  // `findConst` is the FIND_* constant.
  // `ttl` is how many ticks to reuse the result.
  // `postProcess` is an optional transform (e.g. groupStructuresByType).

// ─── STRUCTURE STALENESS PRUNER ───────────────────────────────────────────
  function pruneDeadStructures(byType) {
    for (var type in byType) {
      var arr = byType[type];
      for (var i = arr.length - 1; i >= 0; i--) {
        var dead = false;
        try { var _ = arr[i].structureType; } catch(e) { dead = true; }
        if (dead) arr.splice(i, 1);
      }
      if (arr.length === 0) delete byType[type];
    }
  }

  function cachedFind(store, key, room, findConst, ttl, postProcess) {
    var entry = store[key];
    if (entry && (Game.time - entry.tick) < ttl) {
      if (key === 'structuresByType') pruneDeadStructures(entry.value);  // ← added
      return entry.value;
    }
    var raw = room.find(findConst);
    var value = postProcess ? postProcess(raw) : raw;
    store[key] = { tick: Game.time, value: value };
    return value;
  }

  // ─── CREEP INDEX ──────────────────────────────────────────────────────────
  // Built once per tick, shared across all rooms.

  function buildCreepsIndex() {
    var idx = {};
    var creeps = Game.creeps;
    for (var name in creeps) {
      var c = creeps[name];
      var rn = c.pos.roomName;   // cheaper than c.room.name — avoids room object lookup
      if (!idx[rn]) idx[rn] = [];
      idx[rn].push(c);
    }
    return idx;
  }

  // ─── MAIN CACHE BUILD ────────────────────────────────────────────────────

  function ensureCache() {
    if (global.__roomState && global.__roomState.tick === Game.time) return;

    var rooms = Game.rooms;
    var byRoom = {};
    var creepsIdx = buildCreepsIndex();

    // Persistent per-room find caches (survive across ticks)
    if (!global.__rsFindCache) global.__rsFindCache = {};
    var findCache = global.__rsFindCache;

    for (var roomName in rooms) {
      if (!rooms.hasOwnProperty(roomName)) continue;
      var room = rooms[roomName];
      var owned = room.controller && room.controller.my;
      var myCreepsHere = creepsIdx[roomName] || [];

      // Only include rooms we own or where we currently have creeps
      if (!owned && myCreepsHere.length === 0) continue;

      // Ensure per-room find cache exists
      if (!findCache[roomName]) findCache[roomName] = {};
      var fc = findCache[roomName];

      // Throttled finds — each type on its own schedule
      var structuresByType = cachedFind(fc, "structuresByType", room, FIND_STRUCTURES, TTL_STRUCTURES, groupStructuresByType);
      var sources          = cachedFind(fc, "sources",          room, FIND_SOURCES,    TTL_SOURCES);
      var minerals         = cachedFind(fc, "minerals",         room, FIND_MINERALS,   TTL_MINERALS);
      var constructionSites = cachedFind(fc, "constructionSites", room, FIND_CONSTRUCTION_SITES, TTL_CONSTRUCTION);
      var ruins            = cachedFind(fc, "ruins",            room, FIND_RUINS,      TTL_RUINS);
      var tombstones       = cachedFind(fc, "tombstones",       room, FIND_TOMBSTONES, TTL_TOMBSTONES);
      var dropped          = cachedFind(fc, "dropped",          room, FIND_DROPPED_RESOURCES, TTL_DROPPED);
      var hostiles         = cachedFind(fc, "hostiles",         room, FIND_HOSTILE_CREEPS, TTL_HOSTILES);

      byRoom[roomName] = {
        name:               roomName,
        time:               Game.time,
        controller:         room.controller,
        storage:            room.storage,
        terminal:           room.terminal,
        myCreeps:           myCreepsHere,
        hostiles:           hostiles,
        dropped:            dropped,
        tombstones:         tombstones,
        ruins:              ruins,
        constructionSites:  constructionSites,
        sources:            sources,
        minerals:           minerals,
        structuresByType:   structuresByType
      };
    }

    // Prune find caches for rooms we no longer see
    for (var cachedRoom in findCache) {
      if (!rooms[cachedRoom]) delete findCache[cachedRoom];
    }

    global.__roomState = { tick: Game.time, rooms: byRoom };
  }

  function init() { ensureCache(); }
  function get(roomName) { ensureCache(); return global.__roomState.rooms[roomName]; }
  function all() { ensureCache(); return global.__roomState.rooms; }
  function has(roomName) { ensureCache(); return !!global.__roomState.rooms[roomName]; }

  return { init: init, get: get, all: all, has: has };
})();

module.exports = getRoomState;