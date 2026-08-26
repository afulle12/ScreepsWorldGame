// LLM: Read docs/codex.js before reviewing or changing this file.
// claimbotRangeCheck.js
// Console globals: checkClaimbotRange
// Example: checkClaimbotRange('W1N1', 'W2N2') - Check claimbot path distance and tick viability
//          checkClaimbotRange('SpawnRoom', 'TargetRoom', ['R1','R2','TargetRoom'])
const iff = require("iff");
const scanner = require("scanner");
const BANNED_ROOMS = [ "E8N49", "W8N49" ];
const TTL_LIMIT = 600;
const HOP_ESTIMATE = 50;
const MEM_KEY = "claimbotRangeCheck";
const OBSERVER_SOURCE = "claimbotRangeCheck";
const OBSERVER_HOLD_TICKS = 60;
function isRoomBanned(e) {
  for (var o = 0; o < BANNED_ROOMS.length; o++) {
    if (BANNED_ROOMS[o] === e) return true;
  }
  return false;
}

function isOwnedRoom(e) {
  return !!(e && e.controller && e.controller.my);
}

function isAlliedRoom(e) {
  return !!(e && e.controller && e.controller.owner && !e.controller.my && iff.isFriendlyUsername(e.controller.owner.username));
}

function mirrorEdge(e, o) {
  if (e === 0) return {
    x: 49,
    y: o
  };
  if (e === 49) return {
    x: 0,
    y: o
  };
  if (o === 0) return {
    x: e,
    y: 49
  };
  if (o === 49) return {
    x: e,
    y: 0
  };
  return {
    x: e,
    y: o
  };
}

function buildCostMatrix(e) {
  var o = Game.map.getRoomTerrain(e);
  var n = new PathFinder.CostMatrix;
  for (var r = 0; r < 50; r++) {
    for (var s = 0; s < 50; s++) {
      var t = o.get(s, r);
      n.set(s, r, t === 0 ? 2 : t === 2 ? 10 : 255);
    }
  }
  var a = Game.rooms[e];
  if (a) {
    a.find(FIND_STRUCTURES).forEach(function(e) {
      if (e.structureType === STRUCTURE_ROAD) n.set(e.pos.x, e.pos.y, 1);
    });
  }
  return n;
}

function pathLen(e, o, n, r, s, t) {
  var a = buildCostMatrix(e);
  var i = PathFinder.search(new RoomPosition(o, n, e), {
    pos: new RoomPosition(r, s, e),
    range: t || 0
  }, {
    maxOps: 4e3,
    maxRooms: 1,
    roomCallback: function(o) {
      return o === e ? a : false;
    }
  });
  return i.incomplete ? null : i.path.length;
}

function findExitTile(e, o, n, r) {
  var s = Game.map.findExit(e, o);
  if (s < 0) return null;
  var t = Game.rooms[e];
  if (!t) return null;
  var a = t.find(s);
  if (!a || !a.length) return null;
  var i = null, l = Infinity;
  for (var m = 0; m < a.length; m++) {
    var c = a[m].x - n, R = a[m].y - r;
    var u = c * c + R * R;
    if (u < l) {
      l = u;
      i = a[m];
    }
  }
  return i;
}

function scheduleObserve(e, o) {
  if (e.observedRoom && e.observedRoom !== o) {
    scanner.observe.consume(e.observedRoom, OBSERVER_SOURCE);
  }
  if (!scanner.observe.request(o, OBSERVER_SOURCE, scanner.observe.PRI.ONESHOT, {
    untilConsumed: true,
    holdTicks: OBSERVER_HOLD_TICKS
  })) {
    console.log("[RangeCheck] No observer in range of " + o + ".");
    return false;
  }
  e.observedRoom = o;
  return true;
}

function releaseObservation(e) {
  if (!e || !e.observedRoom) return;
  scanner.observe.consume(e.observedRoom, OBSERVER_SOURCE);
  e.observedRoom = null;
}

function printResults(e) {
  var o = Object.keys(e.spawnLengths);
  var n = true;
  var r = [];
  for (var s = 0; s < o.length; s++) {
    var t = o[s];
    var a = e.spawnLengths[t];
    var i = a === null;
    if (i) a = HOP_ESTIMATE;
    var l = a + e.sharedLength;
    var m = l <= TTL_LIMIT;
    var c = TTL_LIMIT - l;
    if (!m) n = false;
    r.push("║  " + t + ": ~" + l + " ticks" + (i ? " (est)" : "       ") + (m ? "  ✅  margin +" + c : "  ❌  over by " + -c));
  }
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║        CLAIMBOT RANGE CHECK — RESULTS                     ║");
  console.log("╠════════════════════════════════════════════════════════════╣");
  console.log("║  Route : " + e.spawnRoom + " → " + e.route.join(" → "));
  console.log("║  Spawn room type : " + (e.spawnRoomAllied ? "Allied (IFF)" : "Owned"));
  console.log("║  Shared segment total (rooms 2+) : " + e.sharedLength + " tiles");
  console.log("╠════════════════════════════════════════════════════════════╣");
  for (var R = 0; R < r.length; R++) console.log(r[R]);
  console.log("╠════════════════════════════════════════════════════════════╣");
  console.log("║  TTL limit : " + TTL_LIMIT + "  |  Hops : " + e.route.length);
  if (e.estimatedRooms && e.estimatedRooms.length) {
    console.log("║  ⚠️  Hop-estimated rooms (" + HOP_ESTIMATE + " tiles each) : " + e.estimatedRooms.join(", "));
  }
  console.log("║  " + (n ? "✅  ALL SPAWNS WITHIN TTL LIMIT" : "⚠️   SOME SPAWNS EXCEED TTL LIMIT (" + TTL_LIMIT + ")"));
  console.log("╚════════════════════════════════════════════════════════════╝");
}

module.exports = {
  start: function(e, o, n) {
    if (!e || !o) {
      return '❌ Usage: checkClaimbotRange("SpawnRoom", "TargetRoom", [optional route])';
    }
    if (Memory[MEM_KEY] && Memory[MEM_KEY].state === "scanning") {
      return "⚠️  A range check is already running. Wait for it to finish.";
    }
    var r;
    if (n) {
      if (!Array.isArray(n) || !n.length) {
        return "❌ hardcodedRoute must be a non-empty array.";
      }
      if (n[n.length - 1] !== o) {
        return '❌ hardcodedRoute must end with targetRoom "' + o + '".';
      }
      for (var s = 0; s < n.length; s++) {
        if (isRoomBanned(n[s])) {
          return "⚠️  Route includes banned room: " + n[s];
        }
      }
      r = n.slice();
    } else {
      var t = Game.map.findRoute(e, o, {
        routeCallback: function(e) {
          return isRoomBanned(e) ? Infinity : 1;
        }
      });
      if (t === ERR_NO_PATH || !t || !t.length) {
        return "❌ No safe route to " + o + " (all paths blocked or banned).";
      }
      r = t.map(function(e) {
        return e.room;
      });
    }
    var a = Game.rooms[e];
    var i = isOwnedRoom(a);
    if (a && !i && !isAlliedRoom(a)) {
      return "❌ " + e + " is not owned by you or an IFF ally.";
    }
    var l = !i;
    var m = [];
    if (a) {
      if (i) {
        m = a.find(FIND_MY_SPAWNS);
        if (!m.length) {
          return "❌ No spawns found in owned room " + e + ".";
        }
      } else {
        m = a.find(FIND_STRUCTURES, {
          filter: {
            structureType: STRUCTURE_SPAWN
          }
        });
        if (!m.length) {
          return "❌ No spawns found in allied room " + e + ".";
        }
      }
    }
    var c = l && !a ? -1 : 0;
    Memory[MEM_KEY] = {
      state: "scanning",
      spawnRoom: e,
      spawnRoomAllied: l,
      targetRoom: o,
      route: r,
      phase: c,
      spawns: m.map(function(e) {
        return {
          name: e.name,
          x: e.pos.x,
          y: e.pos.y
        };
      }),
      spawnLengths: {},
      sharedLength: 0,
      sharedEntry: null,
      estimatedRooms: []
    };
    var R = c === -1 ? "Spawn room not visible — observing first. Results in ~" + (r.length + 2) + " tick(s)." : "Results in ~" + r.length + " tick(s).";
    console.log("[RangeCheck] Initialized.");
    console.log("[RangeCheck] Spawn room : " + e + " (" + (i ? "owned" : "allied") + ")");
    console.log("[RangeCheck] Route : " + e + " → " + r.join(" → "));
    console.log("[RangeCheck] " + R);
    return "✅ Range check started.";
  },
  run: function() {
    var e = Memory[MEM_KEY];
    if (!e || e.state !== "scanning") return;
    var o = e.phase;
    var n = e.route;
    //   Tick T   : not visible → schedule observation, return.
    //   Tick T+1 : visible     → discover spawns, rely on the observer hold,
    //              advance to phase 0, return.
    //   Tick T+2 : phase 0 runs while the held observation keeps the spawn room
    //              visible; no second observation is requested.
        if (o === -1) {
      var r = Game.rooms[e.spawnRoom];
      if (!r) {
        console.log("[RangeCheck] Phase -1: " + e.spawnRoom + " not yet visible. Scheduling observation...");
        var s = scheduleObserve(e, e.spawnRoom);
        if (!s) {
          console.log("[RangeCheck] No observer can reach allied spawn room " + e.spawnRoom + ". Aborting.");
          releaseObservation(e);
          delete Memory[MEM_KEY];
        }
        return;
      }
      if (!isAlliedRoom(r)) {
        console.log("[RangeCheck] ERROR: " + e.spawnRoom + " is no longer IFF-allied. Aborting.");
        releaseObservation(e);
        delete Memory[MEM_KEY];
        return;
      }
      var t = r.find(FIND_STRUCTURES, {
        filter: {
          structureType: STRUCTURE_SPAWN
        }
      });
      if (!t.length) {
        console.log("[RangeCheck] ERROR: No spawns in allied room " + e.spawnRoom + " after observation. Aborting.");
        releaseObservation(e);
        delete Memory[MEM_KEY];
        return;
      }
      e.spawns = t.map(function(e) {
        return {
          name: e.name,
          x: e.pos.x,
          y: e.pos.y
        };
      });
      console.log("[RangeCheck] Phase -1: found " + e.spawns.length + " spawn(s) in " + e.spawnRoom + ".");
      e.phase = 0;
      console.log("[RangeCheck] Phase -1 done → phase 0 next tick.");
      return;
    }
    if (o === 0) {
      var a = n[0];
      if (!Game.rooms[e.spawnRoom]) {
        if (!scheduleObserve(e, e.spawnRoom)) this._estimateRemaining(e, 0);
        return;
      }
      var i = findExitTile(e.spawnRoom, a, 25, 25);
      if (!i) {
        console.log("[RangeCheck] ERROR: No exit from " + e.spawnRoom + " toward " + a + ". Aborting.");
        releaseObservation(e);
        delete Memory[MEM_KEY];
        return;
      }
      for (var l = 0; l < e.spawns.length; l++) {
        var m = e.spawns[l];
        var c = pathLen(e.spawnRoom, m.x, m.y, i.x, i.y, 0);
        e.spawnLengths[m.name] = c;
        console.log("[RangeCheck] Phase 0 | Spawn " + m.name + " → exit (" + i.x + "," + i.y + ")" + " : " + (c !== null ? c + " tiles" : "INCOMPLETE (will estimate)"));
      }
      e.sharedEntry = mirrorEdge(i.x, i.y);
      e.phase = 1;
      releaseObservation(e);
      if (isOwnedRoom(Game.rooms[a])) {
        console.log("[RangeCheck] Phase 0 done | " + a + " is owned, processing next tick.");
      } else {
        var R = scheduleObserve(e, a);
        if (!R) {
          this._estimateRemaining(e, 0);
          return;
        }
        console.log("[RangeCheck] Phase 0 done | observation of " + a + " scheduled.");
      }
      return;
    }
    var u = o - 1;
    var g = n[u];
    var h = Game.rooms[g];
    if (!h) {
      console.log("[RangeCheck] Phase " + o + ": " + g + " not visible. Re-observing...");
      var d = scheduleObserve(e, g);
      if (!d) this._estimateRemaining(e, u);
      return;
    }
    var f = u === n.length - 1;
    if (f) {
      var v = h.controller;
      var E;
      if (!v) {
        console.log("[RangeCheck] WARNING: No controller in " + g + ". Using estimate.");
        E = HOP_ESTIMATE;
        e.estimatedRooms.push(g);
      } else {
        E = pathLen(g, e.sharedEntry.x, e.sharedEntry.y, v.pos.x, v.pos.y, 1);
        if (E === null) {
          console.log("[RangeCheck] WARNING: PathFinder incomplete in " + g + ". Using estimate.");
          E = HOP_ESTIMATE;
          e.estimatedRooms.push(g);
        }
      }
      e.sharedLength += E;
      console.log("[RangeCheck] Phase " + o + " (" + g + ", final): " + E + " tiles to controller.");
      printResults(e);
      releaseObservation(e);
      delete Memory[MEM_KEY];
      return;
    }
    var p = n[u + 1];
    var T = findExitTile(g, p, e.sharedEntry.x, e.sharedEntry.y);
    var y;
    if (!T) {
      console.log("[RangeCheck] WARNING: No exit from " + g + " to " + p + ". Using estimate.");
      y = HOP_ESTIMATE;
      e.estimatedRooms.push(g);
    } else {
      y = pathLen(g, e.sharedEntry.x, e.sharedEntry.y, T.x, T.y, 0);
      if (y === null) {
        console.log("[RangeCheck] WARNING: PathFinder incomplete in " + g + ". Using estimate.");
        y = HOP_ESTIMATE;
        e.estimatedRooms.push(g);
      }
    }
    e.sharedLength += y;
    e.sharedEntry = T ? mirrorEdge(T.x, T.y) : {
      x: 25,
      y: 25
    };
    console.log("[RangeCheck] Phase " + o + " (" + g + "): " + y + " tiles" + (e.estimatedRooms.indexOf(g) !== -1 ? " (estimated)" : "") + " → entering " + p + " at (" + e.sharedEntry.x + "," + e.sharedEntry.y + ")");
    e.phase++;
    releaseObservation(e);
    if (isOwnedRoom(Game.rooms[p])) {
      console.log("[RangeCheck] " + p + " is owned, processing next tick.");
    } else {
      var O = scheduleObserve(e, p);
      if (!O) {
        this._estimateRemaining(e, u + 1);
        return;
      }
    }
  },
  _estimateRemaining: function(e, o) {
    var n = e.route.length - o;
    console.log("[RangeCheck] No observer — estimating " + n + " remaining room(s) at " + HOP_ESTIMATE + " tiles each.");
    e.sharedLength += n * HOP_ESTIMATE;
    for (var r = o; r < e.route.length; r++) {
      e.estimatedRooms.push(e.route[r]);
    }
    printResults(e);
    releaseObservation(e);
    delete Memory[MEM_KEY];
  }
};
global.checkClaimbotRange = function(e, o, n) {
  return module.exports.start(e, o, n);
};
