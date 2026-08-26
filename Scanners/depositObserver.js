// LLM: Read docs/codex.js before reviewing or changing this file.
// depositObserver.js
// Console globals: harvestResources, diagnoseDeposit
// Example: harvestResources('W1N1') - Scan and assign deposit harvesting targets
// Example: diagnoseDeposit('W1N1') - Diagnose observer deposit tracking in sector
// Example: harvestResources('E1N1'); diagnoseDeposit('E1N1');
var DEPOSIT_HARVESTING_ENABLED = true;
var DEPOSIT_TYPES = [ RESOURCE_BIOMASS, RESOURCE_METAL, RESOURCE_MIST, RESOURCE_SILICON ];
var BANNED_ROOMS = [ "E9N50" ];
var SCAN_INTERVAL = 100;
var OBSERVER_RANGE = 10;
var PASSABILITY_CACHE_TICKS = 1500;
var UNREACHABLE_CACHE_TICKS = 2e3;
var MAX_HARVESTERS = 2;
var MAX_COOLDOWN = 25;
var CREEP_LIFETIME = 1500;
var ROOM_TRAVEL_TICKS = 50;
var TRIP_SAFETY_TICKS = 75;
var spawnManager = require("spawnManager");
var roomNavigation = require("roomNavigation");
var roomManhattanDistance = roomNavigation.roomManhattanDistance;
var MAX_HOME_CANDIDATES = 3;
var HIGHWAY_COST = 1;
var INTERIOR_COST = 2.5;
var SCAN_REQUEST_TIMEOUT = 120;
var ROUTE_OBSERVER_SOURCE = "deposit.route";
var WATCH_OBSERVER_SOURCE = "deposit.watch";
var OBSERVER_HOLD_TICKS = 30;
var PRI_ROUTE_SCAN = 60;
var PRI_DEPOSIT_WATCH = 40;
var iff = require("iff");
var scanner = require("scanner");
var memoryManager = require("memoryManager");
function initMemory() {
  if (!Memory.depositObserver) {
    Memory.depositObserver = {
      rooms: {},
      jobs: {},
      roomStatus: {},
      blockedEdges: {},
      scanQueue: [],
      scanState: {},
      watchPending: {},
      unreachableRooms: {}
    };
  }
  if (!Memory.depositObserver.rooms) Memory.depositObserver.rooms = {};
  for (var e in Memory.depositObserver.rooms) {
    if (Memory.depositObserver.rooms[e] !== 1) Memory.depositObserver.rooms[e] = 1;
  }
  if (!Memory.depositObserver.nextSweepTick) Memory.depositObserver.nextSweepTick = 0;
  if (typeof Memory.depositObserver.nextCleanupTick !== "number") {
    Memory.depositObserver.nextCleanupTick = 0;
    memoryManager.requestSave();
  }
  if (!Memory.depositObserver.jobs) Memory.depositObserver.jobs = {};
  if (!Memory.depositObserver.roomStatus) Memory.depositObserver.roomStatus = {};
  if (!Memory.depositObserver.blockedEdges) Memory.depositObserver.blockedEdges = {};
  if (!Memory.depositObserver.scanQueue) Memory.depositObserver.scanQueue = [];
  if (!Memory.depositObserver.scanState) Memory.depositObserver.scanState = {
    activeRoom: null,
    requestedTick: 0
  };
  if (!Memory.depositObserver.watchPending) Memory.depositObserver.watchPending = {};
  if (!Memory.depositObserver.unreachableRooms) Memory.depositObserver.unreachableRooms = {};
  if (Array.isArray(Memory.observerQueue)) {
    for (var r = 0; r < Memory.observerQueue.length; r++) {
      var o = Memory.observerQueue[r];
      if (Memory.depositObserver.scanQueue.indexOf(o) === -1) {
        Memory.depositObserver.scanQueue.push(o);
      }
    }
    delete Memory.observerQueue;
  }
}

function findLinearRoute(e, r) {
  return roomNavigation.findLinearRoute(e, r, {
    bannedRooms: BANNED_ROOMS,
    roomStatus: Memory.depositObserver.roomStatus || {},
    blockedEdges: Memory.depositObserver.blockedEdges || {},
    isCoverable: function(e) {
      var r = Game.rooms[e];
      if (r && r.controller && r.controller.my) return true;
      return scanner.observe.inRange(e);
    },
    isRoomAllowed: function(e) {
      var r = Game.map.getRoomStatus(e);
      return !r || r.status === "normal";
    }
  });
}

function validateRouteTraversal(e) {
  return roomNavigation.validateRouteTraversal(e, {
    plainCost: 2,
    swampCost: 10,
    maxOps: 4e3,
    entryStrategy: "random",
    blockObstacles: false,
    cacheTtl: 1
  });
}

function isRoomAdjacentToHighway(e) {
  return roomNavigation.isRoomAdjacentToHighway(e);
}

function isHighwayRoom(e) {
  return roomNavigation.isHighwayRoom(e);
}

function highwayRouteCost(e, r) {
  return roomNavigation.highwayRouteCost(e, r, {
    bannedRooms: BANNED_ROOMS,
    highwayCost: HIGHWAY_COST,
    interiorCost: INTERIOR_COST
  });
}

function isRoomUnreachableByObserver(e) {
  var r = Memory.depositObserver.unreachableRooms[e];
  if (!r) return false;
  if (Game.time > r.until) {
    delete Memory.depositObserver.unreachableRooms[e];
    return false;
  }
  return true;
}

function markRoomUnreachable(e) {
  Memory.depositObserver.unreachableRooms[e] = {
    until: Game.time + UNREACHABLE_CACHE_TICKS
  };
}

function harvestResources(e) {
  initMemory();
  if (!scanner.observe.inRange(e)) return ERR_NOT_FOUND;
  if (!Memory.depositObserver.rooms[e]) {
    Memory.depositObserver.rooms[e] = 1;
    Memory.depositObserver.nextSweepTick = 0;
    console.log("[DepositObserver] Watching " + e);
  }
  return OK;
}

function stopObservation(e) {
  if (Memory.depositObserver && Memory.depositObserver.rooms && Memory.depositObserver.rooms[e]) {
    delete Memory.depositObserver.rooms[e];
    scanner.observe.cancel(e, WATCH_OBSERVER_SOURCE);
    if (Memory.depositObserver.watchPending) delete Memory.depositObserver.watchPending[e];
    console.log("[DepositObserver] Stopped watching " + e);
    return OK;
  }
  return ERR_NOT_FOUND;
}

function cancelJobsInRoom(e) {
  var r = Memory.depositObserver.jobs;
  var o = 0;
  for (var a in r) {
    if (r[a].roomName === e && !r[a].completed) {
      r[a].completed = true;
      o++;
    }
  }
  if (o > 0) {
    console.log("[DepositObserver] Cancelled " + o + " jobs in " + e);
    return OK;
  }
  console.log("[DepositObserver] No active jobs found in " + e);
  return ERR_NOT_FOUND;
}

function checkRoomPassability(e, r, o) {
  var a = Game.rooms[e];
  if (!a) return true;
  var n = roomNavigation.checkRoomPassability(a, r, o, {
    plainCost: 2,
    swampCost: 10,
    maxOps: 4e3,
    blockObstacles: false,
    entryStrategy: "median",
    cacheTtl: 1
  });
  return n.passable;
}

function isRoomSafeForTravel(e) {
  var r = Game.rooms[e];
  if (!r) return true;
  var o = r.controller;
  if (!o || o.my) return true;
  var a = o.owner ? o.owner.username : o.reservation ? o.reservation.username : null;
  if (!a) return true;
  if (iff.IFF_WHITELIST && iff.IFF_WHITELIST.indexOf(a) !== -1) return true;
  return false;
}

function planPathForJob(e) {
  if (e.pathPlanned) return;
  if (e.planningRetryTick && Game.time < e.planningRetryTick) return;
  if (!e.storagePos) return;
  var r = new RoomPosition(e.storagePos.x, e.storagePos.y, e.storagePos.roomName);
  var o = new RoomPosition(e.x, e.y, e.roomName);
  var a = findLinearRoute(r.roomName, o.roomName);
  if (!a || a.length === 0) {
    console.log("[DepositObserverPlan] No route for job " + e.id + ". Retrying in 50 ticks.");
    e.planningRetryTick = Game.time + 50;
    return;
  }
  var n = false;
  for (var t = 0; t < a.length; t++) {
    var s = a[t];
    var i = Memory.depositObserver.roomStatus[s];
    var l = i && Game.time - i.lastScan < PASSABILITY_CACHE_TICKS;
    var m = Game.rooms[s];
    var v = m && m.controller && m.controller.my;
    if (!v && !l) {
      if (isRoomUnreachableByObserver(s)) {
        console.log("[DepositObserverPlan] Job " + e.id + " route passes through " + s + " which has no observer coverage. Retrying in 100 ticks.");
        e.planningRetryTick = Game.time + 100;
        return;
      }
      if (Memory.depositObserver.scanQueue.indexOf(s) === -1) {
        Memory.depositObserver.scanQueue.unshift(s);
      }
      n = true;
    }
  }
  if (n) {
    if (Game.time % 20 === 0) {
      console.log("[DepositObserverPlan] Verifying route (" + a.length + " rooms)...");
    }
    e.route = a;
    return;
  }
  var u = validateRouteTraversal(a);
  var c = 0;
  while (u.length > 0 && c < 5) {
    c++;
    for (var p = 0; p < u.length; p++) {
      var f = a.indexOf(u[p]);
      if (f > 0) {
        var d = a[f - 1] + ":" + u[p];
        Memory.depositObserver.blockedEdges[d] = true;
        console.log("[DepositObserverPlan] Blocked edge: " + d);
      }
      if (f >= 0 && f < a.length - 1) {
        var b = u[p] + ":" + a[f + 1];
        Memory.depositObserver.blockedEdges[b] = true;
        console.log("[DepositObserverPlan] Blocked edge: " + b);
      }
    }
    console.log("[DepositObserverPlan] Route for job " + e.id + " has impassable rooms: " + u.join(", ") + ". Recomputing (attempt " + c + ")…");
    a = findLinearRoute(r.roomName, o.roomName);
    if (!a || a.length === 0) {
      console.log("[DepositObserverPlan] No alternative route for job " + e.id + " after blocking impassable rooms.");
      e.planningRetryTick = Game.time + 50;
      return;
    }
    var R = false;
    for (var O = 0; O < a.length; O++) {
      var g = a[O];
      var h = Memory.depositObserver.roomStatus[g];
      var S = h && Game.time - h.lastScan < PASSABILITY_CACHE_TICKS;
      var y = Game.rooms[g];
      var E = y && y.controller && y.controller.my;
      if (!E && !S) {
        if (isRoomUnreachableByObserver(g)) {
          console.log("[DepositObserverPlan] Recomputed route for job " + e.id + " still passes through unobservable room " + g + ". Giving up for now.");
          e.planningRetryTick = Game.time + 100;
          return;
        }
        if (Memory.depositObserver.scanQueue.indexOf(g) === -1) {
          Memory.depositObserver.scanQueue.unshift(g);
        }
        R = true;
      }
    }
    if (R) {
      console.log("[DepositObserverPlan] New route has unscanned rooms. Queuing scans…");
      e.route = a;
      return;
    }
    u = validateRouteTraversal(a);
  }
  if (u.length > 0) {
    console.log("[DepositObserverPlan] Exhausted recompute attempts for job " + e.id + ". Still blocked: " + u.join(", "));
    e.planningRetryTick = Game.time + 100;
    return;
  }
  e.route = a;
  e.pathPlanned = true;
  e.routeValidated = true;
  delete e.planningRetryTick;
  console.log("[DepositObserverPlan] ✓ Job " + e.id + " route confirmed: " + a.join(" "));
}

function runSafetyScanner() {
  var e = Memory.depositObserver;
  //    requested room; we read it whenever it shows up.
    if (e.scanState.activeRoom) {
    var r = e.scanState.activeRoom;
    var o = Game.rooms[r];
    if (o) {
      var a = isRoomSafeForTravel(r);
      var n = false;
      for (var t in e.jobs) {
        var s = e.jobs[t];
        if (!s.route) continue;
        var i = s.route.indexOf(r);
        if (i > -1 && i < s.route.length - 1) {
          var l = s.route[i + 1];
          var m = i > 0 ? s.route[i - 1] : null;
          if (!checkRoomPassability(r, m, l)) {
            n = true;
            e.blockedEdges[r + ":" + l] = true;
            console.log("[DepositObserver] Edge Blocked: " + r + " -> " + l);
          }
        }
      }
      e.roomStatus[r] = {
        lastScan: Game.time,
        blocked: !a
      };
      if (n || !a) {
        for (var t in e.jobs) {
          var s = e.jobs[t];
          if (s.route && s.route.indexOf(r) > -1) {
            console.log("[DepositObserver] Re-routing job " + t);
            s.pathPlanned = false;
            s.route = null;
            delete s.routeValidated;
            delete s.path;
          }
        }
      }
      scanner.observe.consume(r, ROUTE_OBSERVER_SOURCE);
      e.scanState.activeRoom = null;
      if (e.scanQueue.length > 0 && e.scanQueue[0] === r) {
        e.scanQueue.shift();
      }
    } else if (Game.time - (e.scanState.requestedTick || Game.time) > SCAN_REQUEST_TIMEOUT) {
      console.log("[DepositObserver] Timed out waiting for vision of " + r + ".");
      scanner.observe.cancel(r, ROUTE_OBSERVER_SOURCE);
      markRoomUnreachable(r);
      e.scanState.activeRoom = null;
      if (e.scanQueue[0] === r) e.scanQueue.shift();
    } else if (!scanner.observe.request(r, ROUTE_OBSERVER_SOURCE, PRI_ROUTE_SCAN, {
      untilConsumed: true,
      holdTicks: OBSERVER_HOLD_TICKS
    })) {
      console.log("[DepositObserver] Lost observer coverage for " + r + ".");
      scanner.observe.cancel(r, ROUTE_OBSERVER_SOURCE);
      markRoomUnreachable(r);
      e.scanState.activeRoom = null;
      if (e.scanQueue[0] === r) e.scanQueue.shift();
    }
  }
  if (e.scanQueue.length > 0 && !e.scanState.activeRoom) {
    var l = e.scanQueue[0];
    if (scanner.observe.request(l, ROUTE_OBSERVER_SOURCE, PRI_ROUTE_SCAN, {
      untilConsumed: true,
      holdTicks: OBSERVER_HOLD_TICKS
    })) {
      e.scanState.activeRoom = l;
      e.scanState.requestedTick = Game.time;
    } else {
      console.log("[DepositObserver] Skipping unreachable room " + l);
      markRoomUnreachable(l);
      e.scanQueue.shift();
    }
  }
}

function ensureJobForDeposit(e) {
  if ((e.lastCooldown || 0) >= MAX_COOLDOWN) {
    return false;
  }
  var r = Memory.depositObserver.jobs;
  if (r[e.id]) return false;
  var o = findNearestRcl7Home(e.room.name);
  if (!o) return false;
  var a = e.room.getTerrain();
  var n = 0;
  for (var t = -1; t <= 1; t++) {
    for (var s = -1; s <= 1; s++) {
      if (t === 0 && s === 0) continue;
      if (a.get(e.pos.x + t, e.pos.y + s) !== TERRAIN_MASK_WALL) {
        n++;
      }
    }
  }
  var i = Math.min(n, MAX_HARVESTERS);
  if (i < 1) i = 1;
  var l = {
    x: o.storage.pos.x,
    y: o.storage.pos.y,
    roomName: o.name
  };
  r[e.id] = {
    id: e.id,
    roomName: e.room.name,
    x: e.pos.x,
    y: e.pos.y,
    type: e.depositType,
    homeRoom: o.name,
    storagePos: l,
    creeps: [],
    maxHarvesters: i,
    completed: false,
    pathPlanned: false
  };
  console.log("[DepositObserver] Found new deposit " + e.id + ". Spots: " + n + ". Limit set to: " + i);
  return true;
}

function maintainJobs() {
  var e = [];
  var r = [];
  for (var o in Memory.depositObserver.jobs) {
    var a = Memory.depositObserver.jobs[o];
    if (a.creepName) {
      if (!a.creeps) a.creeps = [];
      a.creeps.push(a.creepName);
      delete a.creepName;
    }
    if (!a.creeps) a.creeps = [];
    delete a.routeBack;
    delete a.path;
    delete a.pathBack;
    delete a.pathRooms;
    delete a.exitDirections;
    delete a.exitDirectionsBack;
    var n = [];
    for (var t = 0; t < a.creeps.length; t++) {
      var s = a.creeps[t];
      if (Game.creeps[s] || isCreepSpawning(s)) {
        n.push(s);
      }
    }
    a.creeps = n;
    if (a.completed) {
      if (a.creeps.length === 0) {
        r.push(o);
      } else {
        e.push({
          room: a.roomName,
          status: "🏁 Done, " + a.creeps.length + " returning"
        });
      }
      continue;
    }
    var i = "Unknown";
    var l = a.maxHarvesters || MAX_HARVESTERS;
    if (!a.pathPlanned) {
      if (a.planningRetryTick && Game.time < a.planningRetryTick) {
        i = "❄️ Retry in " + (a.planningRetryTick - Game.time);
      } else {
        planPathForJob(a);
        if (a.pathPlanned) i = "✅ Planned"; else if (a.planningRetryTick) i = "❌ Failed"; else i = "⏳ Scanning";
      }
    } else if (a.creeps.length < l && DEPOSIT_HARVESTING_ENABLED) {
      var m = spawnHarvesterForJob(a);
      if (m === OK) i = "🚀 Spawning (" + a.creeps.length + "/" + l + ")"; else if (m === ERR_BUSY) i = "💤 Busy (" + a.creeps.length + "/" + l + ")"; else i = "❌ Err " + m;
    } else {
      if (a.creeps.length > 0) {
        var v = Game.creeps[a.creeps[0]];
        var u = v ? v.ticksToLive : "Spawning";
        i = "Working [" + a.creeps.length + "/" + l + "] (TTL: " + u + ")";
      } else {
        i = "Idle (Waiting)";
      }
    }
    e.push({
      room: a.roomName,
      status: i
    });
  }
  for (var t = 0; t < r.length; t++) {
    delete Memory.depositObserver.jobs[r[t]];
  }
  if (Game.time % 100 === 0 || Memory.depositObserver.printStatus) {
    if (e.length > 0) {
      console.log("--- DEPOSIT STATUS ---");
      e.forEach(function(e) {
        console.log("[" + e.room + "]: " + e.status);
      });
    }
    Memory.depositObserver.printStatus = false;
  }
}

//   STAGE 1: gather all eligible homes (RCL7+, has storage + spawn, highway-adjacent)
//            and prune to the MAX_HOME_CANDIDATES nearest by Manhattan distance
//            (orthogonal-only travel => diagonal counts as 2).
//   STAGE 2: among the shortlist, pick the one with the cheapest *highway* route
//            (Game.map.findRoute weighted to prefer highway rooms over interior).
//   FALLBACKS: if no shortlisted room yields a highway route, widen to the rest of
//            the candidates; if still none, use the Manhattan-nearest home outright.
function findNearestRcl7Home(e) {
  var r = [];
  for (var o in Game.rooms) {
    var a = Game.rooms[o];
    if (!a.controller || !a.controller.my) continue;
    if (a.controller.level < 7) continue;
    if (!a.storage || a.find(FIND_MY_SPAWNS).length === 0) continue;
    if (!isRoomAdjacentToHighway(o)) continue;
    r.push({
      room: a,
      name: o,
      manhattan: roomManhattanDistance(o, e)
    });
  }
  if (r.length === 0) return null;
  r.sort(function(e, r) {
    return e.manhattan - r.manhattan;
  });
  var n = r.slice(0, MAX_HOME_CANDIDATES);
  var t = null;
  var s = Infinity;
  for (var i = 0; i < n.length; i++) {
    var l = highwayRouteCost(n[i].name, e);
    if (l < s) {
      s = l;
      t = n[i];
    }
  }
  if (!t) {
    for (var m = MAX_HOME_CANDIDATES; m < r.length; m++) {
      var v = highwayRouteCost(r[m].name, e);
      if (v < Infinity) {
        t = r[m];
        s = v;
        break;
      }
    }
  }
  if (!t) {
    console.log("[DepositObserver] No highway route to " + e + "; using Manhattan-nearest home.");
    t = r[0];
    s = Infinity;
  }
  console.log("[DepositObserver] Home for " + e + ": " + t.name + " (manhattan " + t.manhattan + ", highwayCost " + (s === Infinity ? "n/a" : s.toFixed(1)) + ")");
  return t.room;
}

function spawnHarvesterForJob(e) {
  var r = Game.rooms[e.homeRoom];
  if (!r) return ERR_NOT_FOUND;
  var o = r.find(FIND_MY_SPAWNS).find(function(e) {
    return !e.spawning;
  });
  if (!o) return ERR_BUSY;
  var a = 2 * BODYPART_COST[WORK] + 1 * BODYPART_COST[CARRY] + 3 * BODYPART_COST[MOVE];
  var n = Math.min(Math.floor(r.energyCapacityAvailable / a), 8);
  if (n < 1) n = 1;
  var t = [];
  for (var s = 0; s < n; s++) t.push(WORK, WORK, CARRY, MOVE, MOVE, MOVE);
  var i = Array.isArray(e.route) ? e.route.length - 1 : 0;
  var l = CREEP_LIFETIME - t.length * 3;
  var m = i * 2 * ROOM_TRAVEL_TICKS + TRIP_SAFETY_TICKS;
  if (i < 1 || l <= m) {
    e.completed = true;
    e.completionReason = "tripInfeasible";
    console.log("[DepositObserver] Completing job " + e.id + ": route needs about " + m + " ticks but a new creep has only " + l + ".");
    return ERR_NO_PATH;
  }
  var v = "depositHarvester_" + e.roomName + "_" + e.id + "_" + Game.time + "_" + e.creeps.length;
  var u = {
    role: "depositHarvester",
    homeRoom: e.homeRoom,
    targetRoom: e.roomName,
    depositId: e.id,
    depositX: e.x,
    depositY: e.y
  };
  var c = spawnManager.spawnCustomCreep(o, t, v, u);
  if (c === OK) {
    e.creeps.push(v);
    var p = e.maxHarvesters || MAX_HARVESTERS;
    console.log("[DepositObserver] Spawning " + v + " (" + e.creeps.length + "/" + p + ")");
  }
  return c;
}

function scanVisibleRoomsForDeposits() {
  var e = Memory.depositObserver;
  var r = e.rooms;
  var o = e.watchPending;
  if (Game.time >= e.nextSweepTick) {
    for (var a in r) {
      o[a] = Game.time;
      scanner.observe.request(a, WATCH_OBSERVER_SOURCE, PRI_DEPOSIT_WATCH, {
        untilConsumed: true,
        holdTicks: OBSERVER_HOLD_TICKS
      });
    }
    e.nextSweepTick = Game.time + SCAN_INTERVAL;
    memoryManager.requestSave();
  }
  for (var a in o) {
    if (!r[a]) {
      scanner.observe.cancel(a, WATCH_OBSERVER_SOURCE);
      delete o[a];
      continue;
    }
    var n = Game.rooms[a];
    if (!n) {
      if (!scanner.observe.request(a, WATCH_OBSERVER_SOURCE, PRI_DEPOSIT_WATCH, {
        untilConsumed: true,
        holdTicks: OBSERVER_HOLD_TICKS
      })) {
        delete o[a];
      }
      continue;
    }
    var t = n.find(FIND_DEPOSITS);
    var s = [];
    for (var i = 0; i < t.length; i++) {
      var l = t[i];
      s.push(l.id);
      if ((l.lastCooldown || 0) >= MAX_COOLDOWN) {
        var m = Memory.depositObserver.jobs[l.id];
        if (m && !m.completed) {
          console.log("[DepositObserver] Deposit " + l.id + " cooldown too high (" + l.lastCooldown + "). Completing job.");
          m.completed = true;
        }
      }
    }
    var v = Memory.depositObserver.jobs;
    for (var u in v) {
      if (v[u].roomName === a) {
        if (s.indexOf(u) === -1 && !v[u].completed) {
          console.log("[DepositObserver] Deposit " + u + " in " + a + " decayed. Completing job.");
          v[u].completed = true;
        }
      }
    }
    for (var c = 0; c < t.length; c++) {
      if (DEPOSIT_TYPES.indexOf(t[c].depositType) !== -1) {
        ensureJobForDeposit(t[c]);
      }
    }
    scanner.observe.consume(a, WATCH_OBSERVER_SOURCE);
    delete o[a];
  }
}

function cleanStaleMemory() {
  var e = Memory.depositObserver;
  if (Game.time < e.nextCleanupTick) return;
  var r = e.roomStatus;
  var o = Game.time;
  var a = 0;
  for (var n in r) {
    if (o - r[n].lastScan > PASSABILITY_CACHE_TICKS + 500) {
      delete r[n];
      a++;
    }
  }
  var t = e.unreachableRooms;
  var s = 0;
  for (var i in t) {
    if (o > t[i].until) {
      delete t[i];
      s++;
    }
  }
  if (a > 0) {
    console.log("[DepositObserver] Garbage collected " + a + " stale room records.");
  }
  if (s > 0) {
    console.log("[DepositObserver] Cleared " + s + " expired unreachable-room entries.");
  }
  e.nextCleanupTick = Game.time + 1e3;
  memoryManager.requestSave();
}

function isCreepSpawning(e) {
  for (var r in Game.rooms) {
    var o = Game.rooms[r];
    var a = o.find(FIND_MY_SPAWNS);
    for (var n = 0; n < a.length; n++) {
      if (a[n].spawning && a[n].spawning.name === e) return true;
    }
  }
  return false;
}

function getHomeEligibility(e) {
  var r = Game.rooms[e];
  if (!r || !r.controller || !r.controller.my) return "not an owned visible room";
  if (r.controller.level < 7) return "RCL " + r.controller.level + " (requires RCL 7)";
  if (!r.storage) return "no storage";
  if (r.find(FIND_MY_SPAWNS).length === 0) return "no spawn";
  if (!isRoomAdjacentToHighway(e)) return "not highway-adjacent";
  return null;
}

function diagnoseDeposit(e) {
  initMemory();
  var r = Memory.depositObserver;
  var o = [ "[DepositDiagnose] " + e ];
  var a = !!r.rooms[e];
  var n = scanner.observe.inRange(e);
  var t = Game.rooms[e];
  o.push("Watch: " + (a ? "enabled" : "not enabled") + " | Observer coverage: " + (n ? "yes" : "no") + " | Visibility: " + (t ? "yes" : "no"));
  if (r.unreachableRooms[e] && Game.time <= r.unreachableRooms[e].until) {
    o.push("Observer block: cached unreachable until tick " + r.unreachableRooms[e].until);
  }
  var s = t ? t.find(FIND_DEPOSITS) : [];
  if (!t) {
    o.push("Deposits: unavailable without vision.");
  } else if (s.length === 0) {
    o.push("Deposits: none visible.");
  } else {
    for (var i = 0; i < s.length; i++) {
      var l = s[i];
      var m = DEPOSIT_TYPES.indexOf(l.depositType) !== -1;
      o.push("Deposit " + l.id + ": " + l.depositType + " | cooldown " + (l.lastCooldown || 0) + " | supported " + (m ? "yes" : "no") + " | eligible " + (m && (l.lastCooldown || 0) < MAX_COOLDOWN ? "yes" : "no"));
    }
  }
  var v = [];
  for (var u in r.jobs) {
    if (r.jobs[u].roomName === e) v.push(r.jobs[u]);
  }
  if (v.length === 0) {
    o.push("Jobs: none. A visible eligible deposit needs an eligible home before a job can be created.");
  }
  for (var c = 0; c < v.length; c++) {
    var p = v[c];
    var f = p.creeps || [];
    var d = p.pathPlanned ? "planned" : "not planned";
    o.push("Job " + p.id + ": " + d + " | completed " + (p.completed ? "yes" : "no") + (p.completionReason ? " (" + p.completionReason + ")" : "") + " | creeps " + f.length + "/" + (p.maxHarvesters || MAX_HARVESTERS) + " | home " + p.homeRoom);
    if (p.planningRetryTick && Game.time < p.planningRetryTick) {
      o.push("  Planning retry: tick " + p.planningRetryTick + " (" + (p.planningRetryTick - Game.time) + " ticks remaining)");
    }
    if (Array.isArray(p.route)) {
      var b = [];
      for (var R = 0; R < p.route.length; R++) {
        var O = p.route[R];
        var g = Game.rooms[O];
        var h = g && g.controller && g.controller.my;
        var S = r.roomStatus[O];
        if (!h && !scanner.observe.inRange(O)) b.push(O + ": no observer"); else if (S && S.blocked) b.push(O + ": unsafe"); else if (!h && (!S || Game.time - S.lastScan >= PASSABILITY_CACHE_TICKS)) {
          b.push(O + ": needs scan");
        }
      }
      o.push("  Route (" + (p.route.length - 1) + " rooms): " + p.route.join(" "));
      if (b.length > 0) o.push("  Route blockers: " + b.join(", "));
    } else if (!p.completed) {
      o.push("  Route: not yet selected; waiting for a coverable, passable route.");
    }
    var y = Game.rooms[p.homeRoom];
    if (!y) {
      o.push("  Spawn: home room is not visible.");
    } else {
      var E = y.find(FIND_MY_SPAWNS).filter(function(e) {
        return !e.spawning;
      });
      var T = 2 * BODYPART_COST[WORK] + BODYPART_COST[CARRY] + 3 * BODYPART_COST[MOVE];
      var _ = Math.min(Math.floor(y.energyCapacityAvailable / T), 8);
      var M = Math.max(1, _) * T;
      o.push("  Spawn: " + E.length + " idle | energy " + y.energyAvailable + "/" + y.energyCapacityAvailable + " | body cost " + M + (y.energyAvailable >= M ? " | ready" : " | waiting for energy"));
    }
  }
  var C = [];
  var A = [];
  for (var D in Game.rooms) {
    var I = getHomeEligibility(D);
    var N = Game.rooms[D];
    if (!N.controller || !N.controller.my) continue;
    if (I) A.push(D + ": " + I); else C.push(D);
  }
  o.push("Eligible homes: " + (C.length ? C.join(", ") : "none"));
  if (C.length === 0 && A.length > 0) {
    o.push("Home exclusions: " + A.join("; "));
  }
  var P = o.join("\n");
  return P;
}

function run() {
  initMemory();
  runSafetyScanner();
  scanVisibleRoomsForDeposits();
  maintainJobs();
  cleanStaleMemory();
}

global.harvestResources = harvestResources;
global.diagnoseDeposit = diagnoseDeposit;
module.exports = {
  run: run,
  harvestResources: harvestResources,
  stopObservation: stopObservation,
  cancelJobsInRoom: cancelJobsInRoom,
  diagnoseDeposit: diagnoseDeposit
};
