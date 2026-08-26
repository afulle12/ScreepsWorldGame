// LLM: Read docs/codex.js before reviewing or changing this file.
// roleDepositHarvester.js
// Role dispatch: memory.role === 'depositHarvester' -> roleDepositHarvester.run(creep).
// Example: require('roleDepositHarvester').run(creep);
// Example: require('roleDepositHarvester').run(creep);
//   FIX 1: corridor-constrained movement (maxRooms:1 toward a concrete exit tile).
//   FIX 2: forward-biased off-route recovery (no backward snap on linear-distance ties).
//   FIX 4: peel off wrong-edge exit tiles before the engine's start-of-tick auto-transfer.
//   Spawned for a single highway Deposit job.
//   Loop:
//     1) travelToDeposit  - follow an authoritative sequence of rooms from homeRoom to targetRoom
//     2) harvesting       - harvest until full or deposit gone/exhausted
//     3) returning        - follow the same room sequence in reverse back to homeRoom
//     4) delivering       - transfer resources to storage
//   After delivering, the creep suicides so a fresh creep can be spawned for the next trip.
var economics = require("economics");
var roomNavigation = require("roomNavigation");
var ROOM_TRAVEL_TICKS = 50;
var RETURN_SAFETY_TICKS = 75;
function getJob(e) {
  if (!e.memory.depositId) return null;
  if (!Memory.depositObserver) return null;
  if (!Memory.depositObserver.jobs) return null;
  return Memory.depositObserver.jobs[e.memory.depositId] || null;
}

function getHomeRoom(e) {
  if (!e.memory.homeRoom) return null;
  return Game.rooms[e.memory.homeRoom] || null;
}

function getTargetPosition(e) {
  if (!e.memory.targetRoom) return null;
  if (typeof e.memory.depositX !== "number") return null;
  if (typeof e.memory.depositY !== "number") return null;
  return new RoomPosition(e.memory.depositX, e.memory.depositY, e.memory.targetRoom);
}

function getDeposit(e) {
  if (!e.memory.depositId) return null;
  return Game.getObjectById(e.memory.depositId);
}

function clearRouteData(e) {
  delete e.memory.depositRoute;
  delete e.memory.depositRouteBack;
  delete e.memory.depositRouteIndex;
  delete e.memory.depositRouteBackIndex;
  delete e.memory.depositRouteValidated;
  delete e.memory._exitTarget;
  delete e.memory._lastRoom;
}

function getRoute(e, o) {
  var t = getJob(e);
  if (t) {
    var r = o ? t.route : Array.isArray(t.route) ? t.route.slice().reverse() : null;
    if (Array.isArray(r) && r.length >= 2) return r;
  }
  var i = o ? e.memory.depositRoute : e.memory.depositRouteBack;
  return Array.isArray(i) && i.length >= 2 ? i : null;
}

function markJobCompleted(e, o, t) {
  var r = getJob(e);
  if (r && !r.completed) {
    r.completed = true;
    if (t) r.completionReason = t;
    console.log("[DepositHarvester] Marking job " + e.memory.depositId + " as completed.");
  }
  if (!o) {
    clearRouteData(e);
  }
}

function estimateRouteTicks(e, o) {
  var t = getRoute(e, o);
  if (!t || t.length < 2) return null;
  var r = t.indexOf(e.room.name);
  if (r !== -1) {
    return (t.length - 1 - r) * ROOM_TRAVEL_TICKS;
  }
  var i = o ? e.memory.targetRoom : e.memory.homeRoom;
  if (!i) return null;
  return Game.map.getRoomLinearDistance(e.room.name, i) * ROOM_TRAVEL_TICKS;
}

function estimateFullReturnTicks(e) {
  var o = getRoute(e, true);
  if (!o || o.length < 2) return null;
  return (o.length - 1) * ROOM_TRAVEL_TICKS;
}

function abandonInfeasibleJob(e) {
  var o = getJob(e);
  if (o && !o.completed) {
    o.completed = true;
    o.completionReason = "tripInfeasible";
    console.log("[DepositHarvester] Job " + o.id + " cannot complete a round trip within creep TTL.");
  }
  e.memory.state = "returning";
}

function validateRoute(e) {
  return roomNavigation.validateRouteTraversal(e, {
    plainCost: 2,
    swampCost: 2,
    maxOps: 4e3,
    entryStrategy: "random",
    blockObstacles: false,
    cacheTtl: 1
  });
}

function computeRouteAvoiding(e, o, t) {
  return roomNavigation.findRawRoute(e, o, {
    routeCost: function(e) {
      return t.indexOf(e) !== -1 ? Infinity : 1;
    }
  });
}

function ensureRouteOnCreep(e) {
  var o = getJob(e);
  if (o && Array.isArray(o.route) && o.route.length >= 2 && o.routeValidated) {
    return;
  }
  if (!o && Array.isArray(e.memory.depositRoute) && e.memory.depositRoute.length >= 2 && Array.isArray(e.memory.depositRouteBack) && e.memory.depositRouteBack.length >= 2 && e.memory.depositRouteValidated) {
    return;
  }
  var t = o;
  var r = getHomeRoom(e);
  var i = e.memory.targetRoom;
  if (!r || !i) {
    console.log("[DepositHarvesterRoute] " + e.name + " cannot ensure route - missing homeRoom or targetRoom.");
    return;
  }
  var a = null;
  var n = false;
  if (t && Array.isArray(t.route) && t.route.length >= 2) {
    console.log("[DepositHarvesterRoute] " + e.name + " loading authoritative room route from job " + t.id + " (" + t.route.length + " rooms).");
    a = t.route;
    if (t.routeValidated) {
      n = true;
    }
  }
  if (!a) {
    a = buildRouteFromFindRoute(r.name, i);
    if (!a) {
      console.log("[DepositHarvesterRoute] " + e.name + " Game.map.findRoute could not find route from " + r.name + " to " + i + ".");
      return;
    }
  }
  if (!n) {
    var m = validateRoute(a);
    var s = 0;
    var u = [];
    while (m.length > 0 && s < 5) {
      s++;
      for (var l = 0; l < m.length; l++) {
        if (u.indexOf(m[l]) === -1) {
          u.push(m[l]);
        }
      }
      console.log("[DepositHarvesterRoute] " + e.name + " route validation FAILED — impassable rooms: " + m.join(", ") + ". Recomputing (attempt " + s + ")…");
      var d = computeRouteAvoiding(r.name, i, u);
      if (!d || d === ERR_NO_PATH || d.length === 0) {
        console.log("[DepositHarvesterRoute] " + e.name + " could not find alternative route avoiding " + u.join(", ") + ". Giving up.");
        return;
      }
      a = [ r.name ];
      for (var g = 0; g < d.length; g++) {
        if (d[g] && d[g].room) {
          a.push(d[g].room);
        }
      }
      m = validateRoute(a);
    }
    if (m.length > 0) {
      console.log("[DepositHarvesterRoute] " + e.name + " exhausted recompute attempts. Route still has blocked rooms: " + m.join(", "));
      return;
    }
  }
  if (t) {
    t.route = a;
    t.routePlanned = true;
    t.routeValidated = true;
    clearRouteData(e);
    console.log("[DepositHarvesterRoute] " + e.name + " stored VALIDATED room route into job " + t.id + " (" + a.length + " rooms): " + a.join(" → ") + ".");
  } else {
    var R = [];
    for (var c = a.length - 1; c >= 0; c--) R.push(a[c]);
    console.log("[DepositHarvesterRoute] " + e.name + " validated room route of " + a.length + " rooms: " + a.join(" → ") + " (no job to store it to).");
    e.memory.depositRoute = a;
    e.memory.depositRouteBack = R;
    e.memory.depositRouteValidated = true;
  }
}

function buildRouteFromFindRoute(e, o) {
  return roomNavigation.findLinearRoute(e, o, {});
}

function rebuildRoute(e, o) {
  var t = o ? e.memory.targetRoom : e.memory.homeRoom;
  if (!t || e.room.name === t) return null;
  var r = roomNavigation.findLinearRoute(e.room.name, t, {});
  if (!Array.isArray(r) || r.length === 0) return null;
  if (o) {
    e.memory.depositRoute = r;
  } else {
    e.memory.depositRouteBack = r;
  }
  console.log("[DepositHarvester] " + e.name + " job route missing; rebuilt " + (o ? "forward" : "back") + " route (" + r.length + " rooms) from " + e.room.name + ".");
  return r;
}

//        maxRooms:1, so the engine can never wander into an off-route room.
//        room instead of snapping backward on a linear-distance tie.
//        inward first so the engine's start-of-tick exit-tile auto-transfer
//        cannot ping-pong the creep back across the border.
//   - reusePath: 20 for corridor hops (no dynamic obstacles are expected).
//   - maxOps: 2000 (allow pathing across the current room to the far exit).
//   - The chosen exit tile is cached in memory._exitTarget and invalidated on
//     room change, so findClosestByPath runs at most once per room.
function followRoomRoute(e, o) {
  var t = getRoute(e, o);
  if (!Array.isArray(t) || t.length === 0) {
    t = rebuildRoute(e, o);
    if (!t) return ERR_NOT_FOUND;
  }
  return roomNavigation.followRoomRoute(e, t, {
    goalRoom: o ? e.memory.targetRoom : e.memory.homeRoom,
    allowUnconstrainedRecovery: true,
    ignoreCreeps: true,
    exitTargetKey: "_exitTarget",
    reusePath: 20,
    maxOps: 2e3
  });
}

function run(e) {
  if (!e.memory.state) {
    e.memory.state = "travelToDeposit";
  }
  if (!e.memory.homeRoom || !e.memory.targetRoom) {
    console.log("[DepositHarvester] " + e.name + " missing homeRoom/targetRoom. Suicide.");
    markJobCompleted(e);
    e.suicide();
    return;
  }
  var o = getJob(e);
  if (o && o.completed && e.memory.state !== "returning" && e.memory.state !== "delivering") {
    e.memory.state = "returning";
  }
  switch (e.memory.state) {
   case "travelToDeposit":
    stateTravelToDeposit(e);
    break;
   case "harvesting":
    stateHarvesting(e);
    break;
   case "returning":
    stateReturning(e);
    break;
   case "delivering":
    stateDelivering(e);
    break;
   default:
    e.memory.state = "travelToDeposit";
    break;
  }
}

function stateTravelToDeposit(e) {
  var o = getTargetPosition(e);
  if (!o) {
    console.log("[DepositHarvester] " + e.name + " has no valid target position. Suicide.");
    markJobCompleted(e);
    e.suicide();
    return;
  }
  ensureRouteOnCreep(e);
  var t = estimateRouteTicks(e, true);
  var r = estimateFullReturnTicks(e);
  if (typeof e.ticksToLive === "number" && t !== null && r !== null && e.ticksToLive <= t + r + RETURN_SAFETY_TICKS) {
    abandonInfeasibleJob(e);
    return;
  }
  if (e.room.name !== e.memory.targetRoom) {
    var i = followRoomRoute(e, true);
    if (i !== OK && i !== ERR_TIRED) {
      console.log("[DepositHarvester] " + e.name + " followRoomRoute forward returned " + i + ", falling back to direct moveTo.");
      e.moveTo(new RoomPosition(25, 25, e.memory.targetRoom), {
        reusePath: 20
      });
    }
    return;
  }
  var a = getDeposit(e);
  if (!a) {
    console.log("[DepositHarvester] " + e.name + " reached target room but deposit not found. Completing job.");
    markJobCompleted(e);
    e.suicide();
    return;
  }
  if (!e.pos.isNearTo(a.pos)) {
    e.moveTo(a, {
      reusePath: 5
    });
    return;
  }
  e.memory.state = "harvesting";
}

function stateHarvesting(e) {
  var o = estimateRouteTicks(e, false);
  if (typeof e.ticksToLive === "number" && o !== null && e.ticksToLive <= o + RETURN_SAFETY_TICKS) {
    e.memory.state = "returning";
    return;
  }
  if (e.store.getFreeCapacity() === 0) {
    e.memory.state = "returning";
    return;
  }
  var t = getDeposit(e);
  if (!t) {
    console.log("[DepositHarvester] " + e.name + " deposit gone while harvesting. Returning with cargo.");
    markJobCompleted(e, true);
    e.memory.state = "returning";
    return;
  }
  if (typeof t.cooldown === "number" && t.cooldown >= 100) {
    console.log("[DepositHarvester] " + e.name + " deposit cooldown >= 100; treating as exhausted and completing job.");
    markJobCompleted(e, true);
    e.memory.state = "returning";
    return;
  }
  if (typeof t.cooldown === "number" && t.cooldown > 0) {
    if (!e.pos.isNearTo(t.pos)) {
      e.moveTo(t, {
        reusePath: 5
      });
    }
    return;
  }
  var r = e.harvest(t);
  if (r === OK) {
    return;
  }
  if (r === ERR_NOT_IN_RANGE) {
    e.moveTo(t, {
      reusePath: 5
    });
    return;
  }
  if (r === ERR_TIRED) {
    if (!e.pos.isNearTo(t.pos)) {
      e.moveTo(t, {
        reusePath: 5
      });
    }
    return;
  }
  console.log("[DepositHarvester] " + e.name + " harvest error " + r + ". Completing job.");
  markJobCompleted(e, true);
  e.memory.state = "returning";
}

function stateReturning(e) {
  var o = getHomeRoom(e);
  if (!o) {
    console.log("[DepositHarvester] " + e.name + " cannot see home room " + e.memory.homeRoom + ". Suicide.");
    markJobCompleted(e);
    e.suicide();
    return;
  }
  if (e.store.getUsedCapacity() === 0) {
    e.suicide();
    return;
  }
  var t = o.storage;
  if (!t) {
    console.log("[DepositHarvester] " + e.name + " home room has no storage. Suicide.");
    markJobCompleted(e);
    e.suicide();
    return;
  }
  if (e.room.name !== o.name) {
    var r = followRoomRoute(e, false);
    if (r !== OK && r !== ERR_TIRED) {
      console.log("[DepositHarvester] " + e.name + " followRoomRoute back returned " + r + ", falling back to moveTo home room center.");
      e.moveTo(new RoomPosition(25, 25, o.name), {
        reusePath: 20
      });
    }
    return;
  }
  if (!e.pos.isNearTo(t.pos)) {
    e.moveTo(t, {
      reusePath: 5
    });
    return;
  }
  e.memory.state = "delivering";
}

function stateDelivering(e) {
  var o = getHomeRoom(e);
  if (!o || !o.storage) {
    console.log("[DepositHarvester] " + e.name + " cannot deliver: no home storage. Suicide.");
    markJobCompleted(e);
    e.suicide();
    return;
  }
  var t = o.storage;
  var r = t;
  if (t && t.store.getFreeCapacity() === 0 && o.terminal && o.terminal.store.getFreeCapacity() > 0) {
    r = o.terminal;
  }
  var i = false;
  for (var a in e.store) {
    if (e.store[a] > 0) {
      var n = e.store[a];
      var m = e.transfer(r, a);
      if (m === OK) {
        economics.record("depositHarvest", o.name, a, {
          out: economics.value(a, n),
          qty: n
        });
      } else if (m === ERR_FULL && r === t && o.terminal && o.terminal.store.getFreeCapacity() > 0) {
        r = o.terminal;
        m = e.transfer(r, a);
      }
      if (m === OK || m === ERR_NOT_IN_RANGE) {
        i = true;
        if (m === ERR_NOT_IN_RANGE) {
          e.moveTo(r, {
            reusePath: 5
          });
        }
        break;
      }
    }
  }
  if (!i || e.store.getUsedCapacity() === 0) {
    e.suicide();
  }
}

module.exports = {
  run: run
};
