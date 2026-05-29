// claimbotRangeCheck.js
// Multi-tick TTL estimator for claimbot routing.
//
// Console: checkClaimbotRange('SpawnRoom', 'TargetRoom')
//          checkClaimbotRange('SpawnRoom', 'TargetRoom', ['R1','R2','TargetRoom'])

const iff = require('iff');

// == BANNED ROOMS (keep in sync with roleClaimbot.js and roleDemolition) ==
const BANNED_ROOMS = ['E8N49'];

const TTL_LIMIT    = 600;
const HOP_ESTIMATE = 50;   // fallback tiles-per-room when no observer is in range
const MEM_KEY      = 'claimbotRangeCheck';

// ---------------------------------------------------------------------------
// Room-type helpers
// ---------------------------------------------------------------------------

function isRoomBanned(r) {
  for (var i = 0; i < BANNED_ROOMS.length; i++) {
    if (BANNED_ROOMS[i] === r) return true;
  }
  return false;
}

/** True if the caller owns this room. */
function isOwnedRoom(room) {
  return !!(room && room.controller && room.controller.my);
}

/** True if the room belongs to an IFF-whitelisted player (and is not ours). */
function isAlliedRoom(room) {
  return !!(
    room &&
    room.controller &&
    room.controller.owner &&
    !room.controller.my &&
    iff.isFriendlyUsername(room.controller.owner.username)
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Mirror an exit tile on the edge of one room to the corresponding
 * entry tile on the edge of the adjacent room.
 *   x=0  → x=49   (left wall  → right wall  of neighbour)
 *   x=49 → x=0    (right wall → left wall   of neighbour)
 *   y=0  → y=49   (top wall   → bottom wall of neighbour)
 *   y=49 → y=0    (bottom wall→ top wall    of neighbour)
 */
function mirrorEdge(x, y) {
  if (x === 0)  return { x: 49, y: y  };
  if (x === 49) return { x: 0,  y: y  };
  if (y === 0)  return { x: x,  y: 49 };
  if (y === 49) return { x: x,  y: 0  };
  return { x: x, y: y };
}

/**
 * Build a travel-grade CostMatrix for a room:
 *   plain = 2, swamp = 10, wall = 255, road = 1.
 * Roads are overlaid via FIND_STRUCTURES only when the room is visible.
 * Border tiles intentionally NOT blocked — exit/entry tiles live there.
 */
function buildCostMatrix(roomName) {
  var terrain = Game.map.getRoomTerrain(roomName);
  var costs   = new PathFinder.CostMatrix();

  for (var y = 0; y < 50; y++) {
    for (var x = 0; x < 50; x++) {
      var t = terrain.get(x, y);
      costs.set(x, y, t === 0 ? 2 : t === 2 ? 10 : 255);
    }
  }

  var room = Game.rooms[roomName];
  if (room) {
    room.find(FIND_STRUCTURES).forEach(function(s) {
      if (s.structureType === STRUCTURE_ROAD) costs.set(s.pos.x, s.pos.y, 1);
    });
  }

  return costs;
}

/**
 * PathFinder within a single room. Returns tile count or null (incomplete path).
 * This creep body (MOVE×12, ATTACK, CLAIM) is never fatigued on any terrain,
 * so path length === ticks exactly.
 */
function pathLen(roomName, fromX, fromY, toX, toY, range) {
  var costs = buildCostMatrix(roomName);
  var res   = PathFinder.search(
    new RoomPosition(fromX, fromY, roomName),
    { pos: new RoomPosition(toX, toY, roomName), range: range || 0 },
    {
      maxOps:       4000,
      maxRooms:     1,
      roomCallback: function(rn) { return rn === roomName ? costs : false; }
    }
  );
  return res.incomplete ? null : res.path.length;
}

/**
 * Find the exit tile in roomName toward toRoomName,
 * closest to (nearX, nearY). Returns RoomPosition or null.
 * Requires roomName to be visible.
 */
function findExitTile(roomName, toRoomName, nearX, nearY) {
  var exitDir = Game.map.findExit(roomName, toRoomName);
  if (exitDir < 0) return null;

  var room = Game.rooms[roomName];
  if (!room) return null;

  var exits = room.find(exitDir);
  if (!exits || !exits.length) return null;

  var best = null, bestDist = Infinity;
  for (var i = 0; i < exits.length; i++) {
    var dx = exits[i].x - nearX, dy = exits[i].y - nearY;
    var d  = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = exits[i]; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Observer helpers
// ---------------------------------------------------------------------------

/**
 * Find an observer that can reach targetRoomName (linear distance ≤ 10).
 * Priority:
 *   1. Observer in preferRoomName (useful when that room is owned and nearby).
 *   2. Observer in the nearest owned room by distance to targetRoomName.
 * For allied spawn rooms, preferRoomName won't have our observer, so the
 * fallback search across all owned rooms always applies.
 */
function findObserver(preferRoomName, targetRoomName) {
  var prefRoom = Game.rooms[preferRoomName];
  if (prefRoom && isOwnedRoom(prefRoom)) {
    var prefObs = prefRoom.find(FIND_MY_STRUCTURES, {
      filter: { structureType: STRUCTURE_OBSERVER }
    });
    if (prefObs.length &&
        Game.map.getRoomLinearDistance(preferRoomName, targetRoomName) <= 10) {
      return prefObs[0];
    }
  }

  var best = null, bestDist = Infinity;
  for (var rn in Game.rooms) {
    var room = Game.rooms[rn];
    if (!room.controller || !room.controller.my) continue;
    var obs = room.find(FIND_MY_STRUCTURES, {
      filter: { structureType: STRUCTURE_OBSERVER }
    });
    if (!obs.length) continue;
    if (Game.map.getRoomLinearDistance(rn, targetRoomName) > 10) continue;
    var d = Game.map.getRoomLinearDistance(rn, targetRoomName);
    if (d < bestDist) { bestDist = d; best = obs[0]; }
  }
  return best;
}

/**
 * Schedule observation of targetRoomName.
 * preferRoomName is a hint for which room's observer to prefer.
 * Returns true if observation was scheduled.
 */
function scheduleObserve(preferRoomName, targetRoomName) {
  var obs = findObserver(preferRoomName, targetRoomName);
  if (!obs) {
    console.log('[RangeCheck] No observer in range of ' + targetRoomName + '.');
    return false;
  }
  var result = obs.observeRoom(targetRoomName);
  console.log('[RangeCheck] Observing ' + targetRoomName
    + ' from ' + obs.room.name
    + ' (result=' + result + ')');
  return true;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printResults(mem) {
  var spawnNames = Object.keys(mem.spawnLengths);
  var allOk      = true;
  var lines      = [];

  for (var i = 0; i < spawnNames.length; i++) {
    var name      = spawnNames[i];
    var firstLen  = mem.spawnLengths[name];
    var estimated = (firstLen === null);
    if (estimated) firstLen = HOP_ESTIMATE;
    var total  = firstLen + mem.sharedLength;
    var ok     = total <= TTL_LIMIT;
    var margin = TTL_LIMIT - total;
    if (!ok) allOk = false;
    lines.push('║  ' + name + ': ~' + total + ' ticks'
      + (estimated ? ' (est)' : '       ')
      + (ok ? '  ✅  margin +' + margin
            : '  ❌  over by ' + (-margin)));
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        CLAIMBOT RANGE CHECK — RESULTS                     ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Route : ' + mem.spawnRoom + ' → ' + mem.route.join(' → '));
  console.log('║  Spawn room type : ' + (mem.spawnRoomAllied ? 'Allied (IFF)' : 'Owned'));
  console.log('║  Shared segment total (rooms 2+) : ' + mem.sharedLength + ' tiles');
  console.log('╠════════════════════════════════════════════════════════════╣');
  for (var j = 0; j < lines.length; j++) console.log(lines[j]);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  TTL limit : ' + TTL_LIMIT + '  |  Hops : ' + mem.route.length);
  if (mem.estimatedRooms && mem.estimatedRooms.length) {
    console.log('║  ⚠️  Hop-estimated rooms (' + HOP_ESTIMATE + ' tiles each) : '
      + mem.estimatedRooms.join(', '));
  }
  console.log('║  ' + (allOk
    ? '✅  ALL SPAWNS WITHIN TTL LIMIT'
    : '⚠️   SOME SPAWNS EXCEED TTL LIMIT (' + TTL_LIMIT + ')'));
  console.log('╚════════════════════════════════════════════════════════════╝');
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

module.exports = {

  /**
   * Console entry point.
   *
   * Owned spawn room  → FIND_MY_SPAWNS. Phase 0 (same tick as start()).
   *
   * Allied spawn room, visible   → FIND_STRUCTURES for spawns. Phase 0 (same tick).
   * Allied spawn room, not visible → Spawns deferred. Phase -1.
   *                                  run() observes → discovers spawns →
   *                                  re-observes → phase 0 (two ticks later).
   */
  start: function(spawnRoomName, targetRoomName, hardcodedRoute) {
    if (!spawnRoomName || !targetRoomName) {
      return '❌ Usage: checkClaimbotRange("SpawnRoom", "TargetRoom", [optional route])';
    }
    if (Memory[MEM_KEY] && Memory[MEM_KEY].state === 'scanning') {
      return '⚠️  A range check is already running. Wait for it to finish.';
    }

    // ---- Resolve route ----
    var route;
    if (hardcodedRoute) {
      if (!Array.isArray(hardcodedRoute) || !hardcodedRoute.length) {
        return '❌ hardcodedRoute must be a non-empty array.';
      }
      if (hardcodedRoute[hardcodedRoute.length - 1] !== targetRoomName) {
        return '❌ hardcodedRoute must end with targetRoom "' + targetRoomName + '".';
      }
      for (var i = 0; i < hardcodedRoute.length; i++) {
        if (isRoomBanned(hardcodedRoute[i])) {
          return '⚠️  Route includes banned room: ' + hardcodedRoute[i];
        }
      }
      route = hardcodedRoute.slice();
    } else {
      var mapRoute = Game.map.findRoute(spawnRoomName, targetRoomName, {
        routeCallback: function(r) { return isRoomBanned(r) ? Infinity : 1; }
      });
      if (mapRoute === ERR_NO_PATH || !mapRoute || !mapRoute.length) {
        return '❌ No safe route to ' + targetRoomName + ' (all paths blocked or banned).';
      }
      route = mapRoute.map(function(r) { return r.room; });
    }

    // ---- Determine spawn room type ----
    var spawnRoom      = Game.rooms[spawnRoomName];
    var spawnRoomOwned = isOwnedRoom(spawnRoom);

    // Visible but neither owned nor allied → reject
    if (spawnRoom && !spawnRoomOwned && !isAlliedRoom(spawnRoom)) {
      return '❌ ' + spawnRoomName + ' is not owned by you or an IFF ally.';
    }

    // Owned rooms are always visible; if not visible it must be allied
    var spawnRoomAllied = !spawnRoomOwned;

    // ---- Discover spawns (if room currently visible) ----
    var spawns = [];
    if (spawnRoom) {
      if (spawnRoomOwned) {
        spawns = spawnRoom.find(FIND_MY_SPAWNS);
        if (!spawns.length) {
          return '❌ No spawns found in owned room ' + spawnRoomName + '.';
        }
      } else {
        spawns = spawnRoom.find(FIND_STRUCTURES, {
          filter: { structureType: STRUCTURE_SPAWN }
        });
        if (!spawns.length) {
          return '❌ No spawns found in allied room ' + spawnRoomName + '.';
        }
      }
    }
    // If spawnRoom is null (not visible), spawns stays [] — phase -1 will populate it.

    // ---- Initialise Memory ----
    var startPhase = (spawnRoomAllied && !spawnRoom) ? -1 : 0;

    Memory[MEM_KEY] = {
      state:           'scanning',
      spawnRoom:       spawnRoomName,
      spawnRoomAllied: spawnRoomAllied,
      targetRoom:      targetRoomName,
      route:           route,
      phase:           startPhase,
      spawns:          spawns.map(function(s) {
                         return { name: s.name, x: s.pos.x, y: s.pos.y };
                       }),
      spawnLengths:    {},
      sharedLength:    0,
      sharedEntry:     null,
      estimatedRooms:  []
    };

    var etaDesc = startPhase === -1
      ? 'Spawn room not visible — observing first. Results in ~' + (route.length + 2) + ' tick(s).'
      : 'Results in ~' + route.length + ' tick(s).';

    console.log('[RangeCheck] Initialized.');
    console.log('[RangeCheck] Spawn room : ' + spawnRoomName
      + ' (' + (spawnRoomOwned ? 'owned' : 'allied') + ')');
    console.log('[RangeCheck] Route : ' + spawnRoomName + ' → ' + route.join(' → '));
    console.log('[RangeCheck] ' + etaDesc);
    return '✅ Range check started.';
  },

  /**
   * Main loop hook — call every tick via profileSection.
   */
  run: function() {
    var mem = Memory[MEM_KEY];
    if (!mem || mem.state !== 'scanning') return;

    var phase = mem.phase;
    var route = mem.route;

    // ------------------------------------------------------------------
    // Phase -1: Allied spawn room not yet visible.
    //   Tick T   : not visible → schedule observation, return.
    //   Tick T+1 : visible     → discover spawns, re-observe (so findExitTile
    //              works on the phase 0 tick), advance to phase 0, return.
    //   Tick T+2 : phase 0 runs (spawn room visible from re-observation).
    // ------------------------------------------------------------------
    if (phase === -1) {
      var spawnRoomObj = Game.rooms[mem.spawnRoom];

      if (!spawnRoomObj) {
        console.log('[RangeCheck] Phase -1: ' + mem.spawnRoom
          + ' not yet visible. Scheduling observation...');
        var ok = scheduleObserve(mem.spawnRoom, mem.spawnRoom);
        if (!ok) {
          console.log('[RangeCheck] No observer can reach allied spawn room '
            + mem.spawnRoom + '. Aborting.');
          delete Memory[MEM_KEY];
        }
        return;
      }

      // Room now visible — discover spawns
      var foundSpawns = spawnRoomObj.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_SPAWN }
      });
      if (!foundSpawns.length) {
        console.log('[RangeCheck] ERROR: No spawns in allied room '
          + mem.spawnRoom + ' after observation. Aborting.');
        delete Memory[MEM_KEY];
        return;
      }

      mem.spawns = foundSpawns.map(function(s) {
        return { name: s.name, x: s.pos.x, y: s.pos.y };
      });
      console.log('[RangeCheck] Phase -1: found ' + mem.spawns.length
        + ' spawn(s) in ' + mem.spawnRoom + '.');

      // Re-observe spawn room so findExitTile is available for phase 0 next tick
      scheduleObserve(mem.spawnRoom, mem.spawnRoom);

      mem.phase = 0;
      console.log('[RangeCheck] Phase -1 done → phase 0 next tick.');
      return;
    }

    // ------------------------------------------------------------------
    // Phase 0: Spawn room visible (owned always; allied via re-observation).
    // ------------------------------------------------------------------
    if (phase === 0) {
      var firstHop = route[0];

      var exitTile = findExitTile(mem.spawnRoom, firstHop, 25, 25);
      if (!exitTile) {
        console.log('[RangeCheck] ERROR: No exit from ' + mem.spawnRoom
          + ' toward ' + firstHop + '. Aborting.');
        delete Memory[MEM_KEY];
        return;
      }

      for (var i = 0; i < mem.spawns.length; i++) {
        var s   = mem.spawns[i];
        var len = pathLen(mem.spawnRoom, s.x, s.y, exitTile.x, exitTile.y, 0);
        mem.spawnLengths[s.name] = len;
        console.log('[RangeCheck] Phase 0 | Spawn ' + s.name
          + ' → exit (' + exitTile.x + ',' + exitTile.y + ')'
          + ' : ' + (len !== null ? len + ' tiles' : 'INCOMPLETE (will estimate)'));
      }

      mem.sharedEntry = mirrorEdge(exitTile.x, exitTile.y);
      mem.phase       = 1;

      if (isOwnedRoom(Game.rooms[firstHop])) {
        console.log('[RangeCheck] Phase 0 done | ' + firstHop + ' is owned, processing next tick.');
      } else {
        var ok0 = scheduleObserve(mem.spawnRoom, firstHop);
        if (!ok0) {
          this._estimateRemaining(mem, 0);
          return;
        }
        console.log('[RangeCheck] Phase 0 done | observation of ' + firstHop + ' scheduled.');
      }
      return;
    }

    // ------------------------------------------------------------------
    // Phases 1..N: Process route[phase - 1]
    // ------------------------------------------------------------------
    var roomIdx     = phase - 1;
    var curRoomName = route[roomIdx];
    var curRoom     = Game.rooms[curRoomName];

    if (!curRoom) {
      console.log('[RangeCheck] Phase ' + phase + ': ' + curRoomName
        + ' not visible. Re-observing...');
      var okReobs = scheduleObserve(mem.spawnRoom, curRoomName);
      if (!okReobs) this._estimateRemaining(mem, roomIdx);
      return;
    }

    var isLast = (roomIdx === route.length - 1);

    if (isLast) {
      var ctrl = curRoom.controller;
      var lenFinal;

      if (!ctrl) {
        console.log('[RangeCheck] WARNING: No controller in ' + curRoomName + '. Using estimate.');
        lenFinal = HOP_ESTIMATE;
        mem.estimatedRooms.push(curRoomName);
      } else {
        lenFinal = pathLen(curRoomName,
          mem.sharedEntry.x, mem.sharedEntry.y,
          ctrl.pos.x, ctrl.pos.y, 1);
        if (lenFinal === null) {
          console.log('[RangeCheck] WARNING: PathFinder incomplete in ' + curRoomName + '. Using estimate.');
          lenFinal = HOP_ESTIMATE;
          mem.estimatedRooms.push(curRoomName);
        }
      }

      mem.sharedLength += lenFinal;
      console.log('[RangeCheck] Phase ' + phase + ' (' + curRoomName + ', final): '
        + lenFinal + ' tiles to controller.');

      printResults(mem);
      delete Memory[MEM_KEY];
      return;
    }

    var nextRoomName = route[roomIdx + 1];
    var exitTile2    = findExitTile(curRoomName, nextRoomName,
                         mem.sharedEntry.x, mem.sharedEntry.y);
    var lenMid;

    if (!exitTile2) {
      console.log('[RangeCheck] WARNING: No exit from ' + curRoomName
        + ' to ' + nextRoomName + '. Using estimate.');
      lenMid = HOP_ESTIMATE;
      mem.estimatedRooms.push(curRoomName);
    } else {
      lenMid = pathLen(curRoomName,
        mem.sharedEntry.x, mem.sharedEntry.y,
        exitTile2.x, exitTile2.y, 0);
      if (lenMid === null) {
        console.log('[RangeCheck] WARNING: PathFinder incomplete in ' + curRoomName + '. Using estimate.');
        lenMid = HOP_ESTIMATE;
        mem.estimatedRooms.push(curRoomName);
      }
    }

    mem.sharedLength += lenMid;
    mem.sharedEntry = exitTile2
      ? mirrorEdge(exitTile2.x, exitTile2.y)
      : { x: 25, y: 25 };

    console.log('[RangeCheck] Phase ' + phase + ' (' + curRoomName + '): '
      + lenMid + ' tiles'
      + (mem.estimatedRooms.indexOf(curRoomName) !== -1 ? ' (estimated)' : '')
      + ' → entering ' + nextRoomName
      + ' at (' + mem.sharedEntry.x + ',' + mem.sharedEntry.y + ')');

    mem.phase++;

    if (isOwnedRoom(Game.rooms[nextRoomName])) {
      console.log('[RangeCheck] ' + nextRoomName + ' is owned, processing next tick.');
    } else {
      var okNext = scheduleObserve(mem.spawnRoom, nextRoomName);
      if (!okNext) {
        this._estimateRemaining(mem, roomIdx + 1);
        return;
      }
    }
  },

  _estimateRemaining: function(mem, fromRoomIdx) {
    var remaining = mem.route.length - fromRoomIdx;
    console.log('[RangeCheck] No observer — estimating ' + remaining
      + ' remaining room(s) at ' + HOP_ESTIMATE + ' tiles each.');
    mem.sharedLength += remaining * HOP_ESTIMATE;
    for (var i = fromRoomIdx; i < mem.route.length; i++) {
      mem.estimatedRooms.push(mem.route[i]);
    }
    printResults(mem);
    delete Memory[MEM_KEY];
  }
};