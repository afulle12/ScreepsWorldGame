// roomObserver.js
// Provides global console commands to scan rooms using owned StructureObserver(s).
// Scans all rooms within linear distance 10 of a center room (via BFS over describeExits).
// Reports:
// - Rooms with a spawn but no creeps (any owner)
// - Rooms with power creeps (count)
// - Rooms with creeps that have ATTACK or RANGED_ATTACK parts (any owner)
// - Your owned rooms below RCL 6
// - Scanned rooms list
//
// Usage (in main):
//   require('roomObserver'); // registers the console API
//
// Console (observer-driven, multi-tick; no main loop changes):
//   scanRoomsStart('E3N46'); // start scan (fixed radius = 10); schedules the first batch immediately
//   scanRoomsStatus();       // compact status line
//   scanRoomsStep();         // call once per tick from the console to progress
//   scanRoomsPrint();        // pretty-print full results JSON when complete (auto-clears memory)
//   scanRoomsPrint(true);    // print results but keep data in memory
//   scanRoomsClear();        // manually clear memory
//
// Console (one-tick, visible-only; no observer):
//   scanRoomsNow('E3N46');   // scans currently visible rooms only and prints a summary
//
// Notes:
// - You can only analyze rooms visible this tick (present in Game.rooms). Visibility requires your presence or an Observer.
// - Target set is built using Game.map.describeExits and filtered by Game.map.getRoomLinearDistance(center, rn, true) <= 10.
// - Standard queries use Room.find with FIND_* constants and filters.

(function installRoomObserver() {
  var RADIUS = 10;
  var MEM_KEY = 'roomObserverState';

  function ensureArray(a) { return Array.isArray(a) ? a : []; }
  function ensureObject(o) { return o && typeof o === 'object' ? o : {}; }

  function getState() {
    var s = Memory[MEM_KEY];
    if (!s || typeof s !== 'object') {
      s = {};
      Memory[MEM_KEY] = s;
    }
    if (typeof s.active !== 'boolean') s.active = false;
    if (typeof s.center !== 'string') s.center = null;
    if (typeof s.queueIndex !== 'number') s.queueIndex = 0;

    s.queue = ensureArray(s.queue);
    s.done = ensureObject(s.done);
    s.pending = ensureObject(s.pending);
    s.results = ensureObject(s.results);

    var r = s.results;
    r.scannedRooms = ensureArray(r.scannedRooms);
    r.spawnNoCreeps = ensureArray(r.spawnNoCreeps);
    r.powerCreepRooms = ensureArray(r.powerCreepRooms);
    r.armedCreepRooms = ensureArray(r.armedCreepRooms);
    r.myLowRCLRooms = ensureArray(r.myLowRCLRooms);

    return s;
  }

  function resetState() {
    Memory[MEM_KEY] = {
      active: false,
      center: null,
      queue: [],
      queueIndex: 0,
      done: {},
      pending: {},
      results: {
        scannedRooms: [],
        spawnNoCreeps: [],
        powerCreepRooms: [],
        armedCreepRooms: [],
        myLowRCLRooms: []
      }
    };
    return Memory[MEM_KEY];
  }

  function bfsRoomsWithin(center, radius) {
    var seen = {};
    var out = [];
    var q = [{ name: center, dist: 0 }];
    seen[center] = true;

    while (q.length > 0) {
      var cur = q.shift();
      out.push(cur.name);
      if (cur.dist >= radius) continue;

      var exits = Game.map.describeExits(cur.name) || {};
      for (var dir in exits) {
        var rn = exits[dir];
        if (rn && !seen[rn]) {
          seen[rn] = true;
          q.push({ name: rn, dist: cur.dist + 1 });
        }
      }
    }
    return out;
  }

  function getDistance(a, b) {
    return Game.map.getRoomLinearDistance(a, b, true);
  }

  function findMyObservers() {
    var obs = [];
    var roomNames = Object.keys(Game.rooms);
    for (var i = 0; i < roomNames.length; i++) {
      var room = Game.rooms[roomNames[i]];
      if (!room || !room.controller || room.controller.my !== true) continue;
      var found = room.find(FIND_MY_STRUCTURES, {
        filter: function (s) { return s.structureType === STRUCTURE_OBSERVER; }
      });
      for (var j = 0; j < found.length; j++) obs.push(found[j]);
    }
    return obs;
  }

  function analyzeRoom(center, roomName) {
    var room = Game.rooms[roomName];
    if (!room) return null;

    var dist = getDistance(center, roomName);

    var spawns = room.find(FIND_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
    });
    var creeps = room.find(FIND_CREEPS);

    var pcCount = 0;
    if (typeof FIND_POWER_CREEPS !== 'undefined') {
      pcCount = room.find(FIND_POWER_CREEPS).length;
    } else {
      var pcNames = Object.keys(Game.powerCreeps || {});
      for (var p = 0; p < pcNames.length; p++) {
        var pc = Game.powerCreeps[pcNames[p]];
        if (pc && pc.room && pc.room.name === roomName) pcCount++;
      }
      if (typeof FIND_HOSTILE_POWER_CREEPS !== 'undefined') {
        pcCount += room.find(FIND_HOSTILE_POWER_CREEPS).length;
      }
    }

    var armedNames = [];
    for (var c = 0; c < creeps.length; c++) {
      var cr = creeps[c];
      var hasAttack = false;
      for (var b = 0; b < cr.body.length; b++) {
        var t = cr.body[b].type;
        if (t === ATTACK || t === RANGED_ATTACK) { hasAttack = true; break; }
      }
      if (hasAttack) armedNames.push(cr.name);
    }

    var myRCL = (room.controller && room.controller.my === true) ? room.controller.level : undefined;

    return {
      room: roomName,
      dist: dist,
      spawns: spawns.length,
      creeps: creeps.length,
      powerCreeps: pcCount,
      armedCount: armedNames.length,
      armedNames: armedNames,
      myRCL: myRCL
    };
  }

  function recordAnalysis(state, analysis) {
    if (!analysis) return;
    var r = state.results;

    if (analysis.spawns > 0 && analysis.creeps === 0) {
      r.spawnNoCreeps.push({ room: analysis.room, spawns: analysis.spawns, dist: analysis.dist });
    }
    if (analysis.powerCreeps > 0) {
      r.powerCreepRooms.push({ room: analysis.room, powerCreeps: analysis.powerCreeps, dist: analysis.dist });
    }
    if (analysis.armedCount > 0) {
      r.armedCreepRooms.push({ room: analysis.room, count: analysis.armedCount, names: analysis.armedNames, dist: analysis.dist });
    }
    if (typeof analysis.myRCL === 'number' && analysis.myRCL < 6) {
      r.myLowRCLRooms.push({ room: analysis.room, rcl: analysis.myRCL, dist: analysis.dist });
    }
    r.scannedRooms.push(analysis.room);
    state.done[analysis.room] = true;
  }

  function runOneTick() {
    var state = getState();
    if (!state.active) return;

    var observers = findMyObservers();

    // 1) Analyze rooms that became visible this tick (pending)
    var analyzed = 0;
    var stillPending = {};
    var pendKeys = Object.keys(state.pending || {});
    for (var i = 0; i < pendKeys.length; i++) {
      var rnP = pendKeys[i];
      if (Game.rooms[rnP]) {
        var a1 = analyzeRoom(state.center, rnP);
        recordAnalysis(state, a1);
        analyzed++;
      } else {
        stillPending[rnP] = true;
      }
    }
    state.pending = stillPending;

    // 2) Opportunistically analyze any targets already visible and not done/pending
    for (var k = state.queueIndex; k < state.queue.length; k++) {
      var rnV = state.queue[k];
      if (state.done[rnV] || state.pending[rnV]) continue;
      if (Game.rooms[rnV]) {
        var a2 = analyzeRoom(state.center, rnV);
        recordAnalysis(state, a2);
        analyzed++;
      }
    }

    // 3) Schedule new observations this tick (one per observer)
    var scheduled = 0;
    for (var o = 0; o < observers.length; o++) {
      var target = null;
      while (state.queueIndex < state.queue.length) {
        var candidate = state.queue[state.queueIndex++];
        if (!state.done[candidate] && !state.pending[candidate]) { target = candidate; break; }
      }
      if (!target) break;
      observers[o].observeRoom(target);
      state.pending[target] = true;
      scheduled++;
    }

    // 4) Completion check
    var allScheduled = (state.queueIndex >= state.queue.length);
    var noPending = Object.keys(state.pending || {}).length === 0;
    var remaining = 0;
    if (allScheduled) {
      for (var i2 = 0; i2 < state.queue.length; i2++) {
        var rn = state.queue[i2];
        if (!state.done[rn]) remaining++;
      }
    }

    if (allScheduled && noPending && remaining === 0) {
      state.active = false;
      var r = state.results;
      console.log(
        'roomObserver: Scan complete from ' + state.center + ' radius ' + RADIUS + ' | ' +
        r.spawnNoCreeps.length + ' spawn-no-creeps, ' +
        r.powerCreepRooms.length + ' with power creeps, ' +
        r.armedCreepRooms.length + ' with armed creeps, ' +
        r.myLowRCLRooms.length + ' my rooms < RCL6. Scanned ' + r.scannedRooms.length + ' rooms.'
      );
      console.log('roomObserver: Scanned rooms (' + r.scannedRooms.length + '): ' +
        (r.scannedRooms.length ? r.scannedRooms.join(', ') : '(none)'));
      console.log('roomObserver: Call scanRoomsPrint() to view results and clear memory.');
    } else {
      console.log(
        'roomObserver: tick | analyzed ' + analyzed +
        ', scheduled ' + scheduled +
        ', progress ' + state.queueIndex + '/' + state.queue.length +
        ', pending ' + Object.keys(state.pending || {}).length
      );
    }
  }

  // Start scan and schedule the first batch immediately (one per observer)
  global.scanRoomsStart = function(centerRoomName) {
    if (!centerRoomName || typeof centerRoomName !== 'string') {
      return "Usage: scanRoomsStart('E3N46')  // fixed radius = 10";
    }

    var radiusRooms = bfsRoomsWithin(centerRoomName, RADIUS);
    var filtered = [];
    for (var i = 0; i < radiusRooms.length; i++) {
      var rn = radiusRooms[i];
      if (getDistance(centerRoomName, rn) <= RADIUS) filtered.push(rn);
    }

    var state = resetState();
    state.active = true;
    state.center = centerRoomName;
    state.queue = filtered;
    state.queueIndex = 0;

    var observers = findMyObservers();

    var scheduledNow = 0;
    for (var o = 0; o < observers.length && state.queueIndex < state.queue.length; o++) {
      var target = state.queue[state.queueIndex++];
      observers[o].observeRoom(target);
      state.pending[target] = true;
      scheduledNow++;
    }

    console.log(
      'roomObserver: Initialized from ' + centerRoomName +
      ' with ' + filtered.length + ' target rooms, using ' + observers.length + ' observers. ' +
      'Scheduled ' + scheduledNow + ' for next tick.'
    );
    console.log('No main loop changes: call scanRoomsStep() once per tick until complete, then scanRoomsPrint().');
  };

  global.scanRoomsStatus = function() {
    var state = getState();
    if (!state.active) {
      var r = state.results;
      return 'roomObserver: idle | last center ' + (state.center || 'N/A') +
             ' | scanned ' + r.scannedRooms.length +
             ' | results: spawnNoCreeps=' + r.spawnNoCreeps.length +
             ', power=' + r.powerCreepRooms.length +
             ', armed=' + r.armedCreepRooms.length +
             ', my<6=' + r.myLowRCLRooms.length;
    }
    return 'roomObserver: active | center ' + state.center +
           ' | progress ' + state.queueIndex + '/' + state.queue.length +
           ' | pending ' + Object.keys(state.pending || {}).length +
           ' | scanned ' + Object.keys(state.done || {}).length;
  };

  // Print results and auto-clear memory (pass true to keep data)
  global.scanRoomsPrint = function(keepData) {
    var state = getState();
    var output = JSON.stringify({
      center: state.center,
      radius: RADIUS,
      scannedCount: state.results.scannedRooms.length,
      results: {
        spawnNoCreeps: state.results.spawnNoCreeps,
        powerCreepRooms: state.results.powerCreepRooms,
        armedCreepRooms: state.results.armedCreepRooms,
        myLowRCLRooms: state.results.myLowRCLRooms
      }
    }, null, 2);

    if (!keepData) {
      delete Memory[MEM_KEY];
      console.log('roomObserver: Memory cleared.');
    }

    return output;
  };

  // Manually clear memory
  global.scanRoomsClear = function() {
    if (!Memory[MEM_KEY]) {
      return 'roomObserver: Memory already clear.';
    }
    delete Memory[MEM_KEY];
    return 'roomObserver: Memory cleared.';
  };

  global.scanRoomsStop = function() {
    var state = getState();
    if (!state.active) return 'roomObserver: no active scan.';
    state.active = false;
    state.pending = {};
    return 'roomObserver: scan canceled. Call scanRoomsClear() to free memory.';
  };

  // Manual single-tick progress (use this each tick if you won't change main)
  global.scanRoomsStep = function() {
    runOneTick();
    return 'roomObserver: step done.';
  };

  // One-tick, visible-only scan (no observer); logs and returns nothing.
  global.scanRoomsNow = function(centerRoomName) {
    var visibleRooms = Object.keys(Game.rooms);
    if (!centerRoomName || visibleRooms.indexOf(centerRoomName) === -1) {
      centerRoomName = visibleRooms.length > 0 ? visibleRooms[0] : null;
    }
    if (!centerRoomName) {
      console.log('scanRoomsNow: No visible rooms. Move a creep or use an observer first.');
      return;
    }

    var scanned = [];
    var tmp = { spawnNoCreeps: [], powerCreepRooms: [], armedCreepRooms: [], myLowRCLRooms: [] };

    for (var i = 0; i < visibleRooms.length; i++) {
      var rn = visibleRooms[i];
      var d = getDistance(centerRoomName, rn);
      if (d > RADIUS) continue;

      var a = analyzeRoom(centerRoomName, rn);
      if (!a) continue;
      scanned.push(rn);

      if (a.spawns > 0 && a.creeps === 0) tmp.spawnNoCreeps.push({ room: a.room, spawns: a.spawns, dist: a.dist });
      if (a.powerCreeps > 0) tmp.powerCreepRooms.push({ room: a.room, powerCreeps: a.powerCreeps, dist: a.dist });
      if (a.armedCount > 0) tmp.armedCreepRooms.push({ room: a.room, count: a.armedCount, names: a.armedNames, dist: a.dist });
      if (typeof a.myRCL === 'number' && a.myRCL < 6) tmp.myLowRCLRooms.push({ room: a.room, rcl: a.myRCL, dist: a.dist });
    }

    console.log(
      'scanRoomsNow: from ' + centerRoomName + ' radius ' + RADIUS + ' | ' +
      tmp.spawnNoCreeps.length + ' spawn-no-creeps, ' +
      tmp.powerCreepRooms.length + ' power, ' +
      tmp.armedCreepRooms.length + ' armed, ' +
      tmp.myLowRCLRooms.length + ' my<6.'
    );
    console.log('scanRoomsNow: Scanned rooms (' + scanned.length + '): ' +
      (scanned.length ? scanned.join(', ') : '(none)'));
  };
})();