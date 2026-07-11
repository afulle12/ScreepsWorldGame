// LLM: Read llmcontext.js before reviewing or changing this file.
// getRoomState.js
// Purpose: Build and expose per-tick room state for rooms you own OR have your creeps in.
// API:
//   - getRoomState.init()           -> build cache once per tick
//   - getRoomState.get(roomName)    -> get state for a room (or undefined)
//   - getRoomState.all()            -> get map of all cached rooms
//   - getRoomState.has(roomName)    -> boolean, whether room is cached this tick
//   - getRoomState.isOwned(roomName)-> boolean, whether we own the room this tick
//   - getRoomState.owned()          -> map of owned room names
//   - getRoomState.ownedNames()     -> array of owned room names
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
  // Hostiles have no TTL constant — they bypass the id cache entirely
  // and are found live every tick (see ensureCache below).

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

  function formatPos(pos) {
    if (!pos) return undefined;
    return {
      roomName: pos.roomName,
      x: pos.x,
      y: pos.y
    };
  }

  function summarizeStore(store) {
    if (!store) return undefined;
    var out = {};
    for (var resourceType in store) {
      if (!store.hasOwnProperty(resourceType)) continue;
      if (typeof store[resourceType] !== 'number') continue;
      if (store[resourceType] <= 0) continue;
      out[resourceType] = store[resourceType];
    }
    return out;
  }

  function summarizeRoomObject(obj) {
    if (!obj) return undefined;

    var out = {
      id: obj.id,
      pos: formatPos(obj.pos)
    };

    if (obj.name !== undefined) out.name = obj.name;
    if (obj.structureType !== undefined) out.structureType = obj.structureType;
    if (obj.resourceType !== undefined) out.resourceType = obj.resourceType;
    if (obj.amount !== undefined) out.amount = obj.amount;
    if (obj.energy !== undefined) out.energy = obj.energy;
    if (obj.energyCapacity !== undefined) out.energyCapacity = obj.energyCapacity;
    if (obj.hits !== undefined) out.hits = obj.hits;
    if (obj.hitsMax !== undefined) out.hitsMax = obj.hitsMax;
    if (obj.ticksToLive !== undefined) out.ticksToLive = obj.ticksToLive;
    if (obj.ticksToDecay !== undefined) out.ticksToDecay = obj.ticksToDecay;
    if (obj.ticksToRegeneration !== undefined) out.ticksToRegeneration = obj.ticksToRegeneration;
    if (obj.progress !== undefined) out.progress = obj.progress;
    if (obj.progressTotal !== undefined) out.progressTotal = obj.progressTotal;
    if (obj.owner && obj.owner.username !== undefined) out.owner = obj.owner.username;
    if (obj.controller && obj.controller.my !== undefined) out.my = obj.controller.my;
    if (obj.store) out.store = summarizeStore(obj.store);
    if (obj.memory && obj.memory.role !== undefined) out.role = obj.memory.role;

    return out;
  }

  function summarizeList(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push(summarizeRoomObject(list[i]));
    }
    return out;
  }

  function buildRoomStatePrint(roomState) {
    if (!roomState) return undefined;

    var controller = roomState.controller;
    var storage = roomState.storage;
    var terminal = roomState.terminal;
    var structuresByType = {};

    for (var type in roomState.structuresByType) {
      if (!roomState.structuresByType.hasOwnProperty(type)) continue;
      structuresByType[type] = summarizeList(roomState.structuresByType[type]);
    }

    return {
      name: roomState.name,
      time: roomState.time,
      owned: !!roomState.isOwned,
      controller: controller ? {
        id: controller.id,
        level: controller.level,
        progress: controller.progress,
        progressTotal: controller.progressTotal,
        safeMode: controller.safeMode,
        safeModeAvailable: controller.safeModeAvailable,
        reservation: controller.reservation ? {
          username: controller.reservation.username,
          ticksToEnd: controller.reservation.ticksToEnd
        } : undefined,
        owner: controller.owner ? controller.owner.username : undefined,
        pos: formatPos(controller.pos)
      } : undefined,
      storage: summarizeRoomObject(storage),
      terminal: summarizeRoomObject(terminal),
      counts: {
        myCreeps: roomState.myCreeps ? roomState.myCreeps.length : 0,
        myPowerCreeps: roomState.myPowerCreeps ? roomState.myPowerCreeps.length : 0,
        hostiles: roomState.hostiles ? roomState.hostiles.length : 0,
        dropped: roomState.dropped ? roomState.dropped.length : 0,
        tombstones: roomState.tombstones ? roomState.tombstones.length : 0,
        ruins: roomState.ruins ? roomState.ruins.length : 0,
        constructionSites: roomState.constructionSites ? roomState.constructionSites.length : 0,
        sources: roomState.sources ? roomState.sources.length : 0,
        minerals: roomState.minerals ? roomState.minerals.length : 0
      },
      myCreeps: summarizeList(roomState.myCreeps || []),
      myPowerCreeps: summarizeList(roomState.myPowerCreeps || []),
      hostiles: summarizeList(roomState.hostiles || []),
      dropped: summarizeList(roomState.dropped || []),
      tombstones: summarizeList(roomState.tombstones || []),
      ruins: summarizeList(roomState.ruins || []),
      constructionSites: summarizeList(roomState.constructionSites || []),
      sources: summarizeList(roomState.sources || []),
      minerals: summarizeList(roomState.minerals || []),
      structuresByType: structuresByType
    };
  }

  function printRoomState(roomState) {
    var snapshot = buildRoomStatePrint(roomState);
    if (!snapshot) return 'No room state to print.';
    console.log('getRoomState(' + roomState.name + ') =\n' + JSON.stringify(snapshot, null, 2));
    return 'Printed room state for ' + roomState.name + ' to console.';
  }

  // ─── PER-ROOM THROTTLED FIND (ID-BASED) ────────────────────────────────────
  // Screeps rebuilds the entire game-object graph every tick, so caching
  // live objects across ticks (the old approach) meant consumers read
  // stale store/hits/amount values, and destroyed objects lingered in the
  // cache until TTL expiry since a dead reference doesn't throw on access.
  //
  // Instead we cache only the IDs found by room.find(), and rehydrate to
  // live objects via Game.getObjectById() every tick regardless of TTL.
  // getObjectById is a cheap hash lookup, so this keeps the CPU savings
  // (avoiding room.find()) while every consumer always sees this tick's
  // real data. A destroyed object simply rehydrates to null and is
  // dropped — no separate staleness pruning needed.
  //
  // `store` is the per-room persistent cache object.
  // `key` is the cache slot name (e.g. "sources").
  // `room` is the Room object.
  // `findConst` is the FIND_* constant.
  // `ttl` is how many ticks to reuse the id list before re-finding.

  function rehydrate(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var obj = Game.getObjectById(ids[i]);
      if (obj) out.push(obj);
    }
    return out;
  }

  function cachedFindIds(store, key, room, findConst, ttl) {
    var entry = store[key];
    if (entry && (Game.time - entry.tick) < ttl) {
      return entry.ids;
    }
    var found = room.find(findConst);
    var ids = [];
    for (var i = 0; i < found.length; i++) ids.push(found[i].id);
    store[key] = { tick: Game.time, ids: ids };
    return ids;
  }

  // ─── CREEP INDEX ──────────────────────────────────────────────────────────
  // Built once per tick, shared across all rooms.

  function buildCreepsIndex() {
    var idx = { byRoom: {}, byHomeRoom: {}, byRole: {}, all: [] };
    var creeps = Game.creeps;
    for (var name in creeps) {
      var c = creeps[name];
      var rn = c.pos.roomName;   // cheaper than c.room.name — avoids room object lookup
      if (!idx.byRoom[rn]) idx.byRoom[rn] = [];
      idx.byRoom[rn].push(c);
      idx.all.push(c);

      var mem = c.memory || {};
      var home = mem.homeRoom || mem.assignedRoom || mem.orderRoom || rn;
      if (!idx.byHomeRoom[home]) idx.byHomeRoom[home] = [];
      idx.byHomeRoom[home].push(c);

      var role = mem.role || 'unknown';
      if (!idx.byRole[role]) idx.byRole[role] = [];
      idx.byRole[role].push(c);
    }
    return idx;
  }

  function buildPowerCreepsIndex() {
    var idx = {};
    var powerCreeps = Game.powerCreeps;
    for (var name in powerCreeps) {
      var pc = powerCreeps[name];
      if (!pc || !pc.ticksToLive || !pc.pos) continue;
      var rn = pc.pos.roomName;
      if (!idx[rn]) idx[rn] = [];
      idx[rn].push(pc);
    }
    return idx;
  }

  // ─── MAIN CACHE BUILD ────────────────────────────────────────────────────

  function ensureCache() {
    if (global.__roomState && global.__roomState.tick === Game.time) return;

    var rooms = Game.rooms;
    var byRoom = {};
    var ownedRooms = {};
    var ownedRoomNames = [];
    var creepsIdx = buildCreepsIndex();
    var powerCreepsIdx = buildPowerCreepsIndex();

    // Persistent per-room find caches (survive across ticks)
    if (!global.__rsFindCache) global.__rsFindCache = {};
    var findCache = global.__rsFindCache;

    for (var roomName in rooms) {
      if (!rooms.hasOwnProperty(roomName)) continue;
      var room = rooms[roomName];
      var owned = room.controller && room.controller.my;
      if (owned) {
        ownedRooms[roomName] = true;
        ownedRoomNames.push(roomName);
      }
      var myCreepsHere = creepsIdx.byRoom[roomName] || [];
      var myPowerCreepsHere = powerCreepsIdx[roomName] || [];

      // Only include rooms we own or where we currently have creeps/power creeps
      if (!owned && myCreepsHere.length === 0 && myPowerCreepsHere.length === 0) continue;

      // Ensure per-room find cache exists
      if (!findCache[roomName]) findCache[roomName] = {};
      var fc = findCache[roomName];

      // Throttled finds — each type on its own schedule. IDs are cached
      // per TTL; objects are rehydrated fresh every tick (see cachedFindIds).
      var structuresByType = groupStructuresByType(
        rehydrate(cachedFindIds(fc, "structures", room, FIND_STRUCTURES, TTL_STRUCTURES)));
      var sources          = rehydrate(cachedFindIds(fc, "sources",          room, FIND_SOURCES,    TTL_SOURCES));
      var minerals         = rehydrate(cachedFindIds(fc, "minerals",         room, FIND_MINERALS,   TTL_MINERALS));
      var constructionSites = rehydrate(cachedFindIds(fc, "constructionSites", room, FIND_CONSTRUCTION_SITES, TTL_CONSTRUCTION));
      var ruins            = rehydrate(cachedFindIds(fc, "ruins",            room, FIND_RUINS,      TTL_RUINS));
      var tombstones       = rehydrate(cachedFindIds(fc, "tombstones",       room, FIND_TOMBSTONES, TTL_TOMBSTONES));
      var dropped          = rehydrate(cachedFindIds(fc, "dropped",          room, FIND_DROPPED_RESOURCES, TTL_DROPPED));
      // Hostiles are safety-critical (TTL 1) — a direct find is simplest
      // and skips the id round-trip entirely since there's no reuse to gain.
      var hostiles         = room.find(FIND_HOSTILE_CREEPS);

      byRoom[roomName] = {
        name:               roomName,
        time:               Game.time,
        owned:              !!owned,
        isOwned:            !!owned,
        controller:         room.controller,
        storage:            room.storage,
        terminal:           room.terminal,
        myCreeps:           myCreepsHere,
        myPowerCreeps:      myPowerCreepsHere,
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

    global.__roomState = {
      tick: Game.time,
      rooms: byRoom,
      ownedRooms: ownedRooms,
      ownedRoomNames: ownedRoomNames,
      creepIndex: creepsIdx,
      powerCreepIndex: powerCreepsIdx
    };
  }

  function init() { ensureCache(); }
  function get(roomName, printDetailed) {
    ensureCache();
    var roomState = global.__roomState.rooms[roomName];
    if (printDetailed) {
      if (!roomState) return 'No cached room state for ' + roomName + '.';
      return printRoomState(roomState);
    }
    return roomState;
  }
  function all() { ensureCache(); return global.__roomState.rooms; }
  function has(roomName) { ensureCache(); return !!global.__roomState.rooms[roomName]; }
  function isOwned(roomName) { ensureCache(); return !!global.__roomState.ownedRooms[roomName]; }
  function owned() { ensureCache(); return global.__roomState.ownedRooms; }
  function ownedNames() { ensureCache(); return global.__roomState.ownedRoomNames; }
  function creepIndex() { ensureCache(); return global.__roomState.creepIndex; }
  function powerCreepIndex() { ensureCache(); return global.__roomState.powerCreepIndex; }

  return { init: init, get: get, all: all, has: has, isOwned: isOwned, owned: owned, ownedNames: ownedNames, print: printRoomState, creepIndex: creepIndex, powerCreepIndex: powerCreepIndex };
})();

module.exports = getRoomState;
