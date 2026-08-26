// LLM: Read docs/codex.js before reviewing or changing this file.
// roleThief.js
// Role dispatch: memory.role === 'thief' -> roleThief.run(creep).
// Console globals: orderThieves, cancelThiefOrder, updateThiefOrder, listThiefOrders
// Example: orderThieves('W1N1', 'W2N2', 2) - Dispatch thieves to loot resources from hostile room
// Example: cancelThiefOrder('W1N1') - Cancel active thief order
// Example: updateThiefOrder('W1N1', { count: 3 }) - Modify count or target for thief order
// Example: listThiefOrders() - List all active resource looting operations
// Example: require('roleThief').run(creep);
const roomNav = require("roomNavigation");
const getRoomStateCentral = require("getRoomState");
const util = require("util");
const DEBUG = false;
const normalizeRoom = e => String(e || "").trim().toUpperCase();
const BANNED_ROOMS = [ "E4N51", "E6N51", "E8N56", "E9N51" ].map(normalizeRoom);
const NEAR_EDGE_DIST = 5;
const MIN_ENERGY_DROP = 200;
const TRIP_TIME_BUFFER = 1;
const MAX_TRIP_SAMPLES = 10;
function ensureThiefTripMemory() {
  if (!Memory.thiefTripTimes) Memory.thiefTripTimes = {};
}

function recordTripTime(e, o, t) {
  if (!e || !o || typeof t !== "number" || t <= 0) return;
  ensureThiefTripMemory();
  if (!Memory.thiefTripTimes[e]) Memory.thiefTripTimes[e] = {};
  if (!Memory.thiefTripTimes[e][o]) Memory.thiefTripTimes[e][o] = [];
  const r = Memory.thiefTripTimes[e][o];
  r.push(Math.round(t));
  if (r.length > MAX_TRIP_SAMPLES) r.shift();
  if (DEBUG) {
    console.log("[Thief] Recorded round trip " + e + " -> " + o + ": " + Math.round(t) + " ticks (median now " + getRecordedTripTime(e, o) + ")");
  }
}

function getRecordedTripTime(e, o) {
  if (!Memory.thiefTripTimes || !Memory.thiefTripTimes[e] || !Memory.thiefTripTimes[e][o]) {
    return null;
  }
  const t = Memory.thiefTripTimes[e][o];
  if (!t || t.length === 0) return null;
  const r = t.slice().sort((e, o) => e - o);
  const n = Math.floor(r.length / 2);
  return r.length % 2 ? r[n] : Math.round((r[n - 1] + r[n]) / 2);
}

function shouldSuicideForLowTTL(e, o, t) {
  const r = getRecordedTripTime(o, t);
  if (!r || typeof e.ticksToLive !== "number") return false;
  return e.ticksToLive < Math.ceil(r * TRIP_TIME_BUFFER);
}

const CACHE_REFRESH_TICKS = 25;
if (!global._edgeAvoidCache) global._edgeAvoidCache = {};
function getEdgeAvoidCacheEntry(e) {
  if (!global._edgeAvoidCache[e]) {
    global._edgeAvoidCache[e] = {
      builtAt: 0,
      matrix: null
    };
  }
  return global._edgeAvoidCache[e];
}

function buildEdgeAvoidMatrixFor(e) {
  const o = new PathFinder.CostMatrix;
  if (!e) return o;
  let t = [];
  if (getRoomStateCentral && typeof getRoomStateCentral.get === "function") {
    const o = getRoomStateCentral.get(e.name);
    if (o && o.structuresByType) {
      for (var r in o.structuresByType) {
        const e = o.structuresByType[r];
        if (e && e.length) {
          for (var n = 0; n < e.length; n++) t.push(e[n]);
        }
      }
    }
  } else {
    t = e.find(FIND_STRUCTURES);
  }
  for (var s = 0; s < t.length; s++) {
    const e = t[s];
    if (e.structureType === STRUCTURE_ROAD) {
      o.set(e.pos.x, e.pos.y, 1);
    } else if (e.structureType !== STRUCTURE_CONTAINER && (e.structureType !== STRUCTURE_RAMPART || !e.my)) {
      o.set(e.pos.x, e.pos.y, 255);
    }
  }
  return o;
}

function getEdgeAvoidMatrix(e) {
  const o = getEdgeAvoidCacheEntry(e);
  if (!o.matrix || Game.time - o.builtAt >= CACHE_REFRESH_TICKS) {
    o.matrix = buildEdgeAvoidMatrixFor(Game.rooms[e]);
    o.builtAt = Game.time;
  }
  return o.matrix;
}

const STUCK_THRESHOLD = 5;
function updateStuckCounter(e) {
  if (!e.memory._stk) {
    e.memory._stk = {
      x: e.pos.x,
      y: e.pos.y,
      r: e.pos.roomName,
      n: 0
    };
  }
  const o = e.memory._stk;
  if (o.x === e.pos.x && o.y === e.pos.y && o.r === e.pos.roomName) {
    o.n++;
  } else {
    o.x = e.pos.x;
    o.y = e.pos.y;
    o.r = e.pos.roomName;
    o.n = 0;
  }
  return o.n >= STUCK_THRESHOLD;
}

function consumeStuck(e) {
  const o = updateStuckCounter(e);
  if (o) e.memory._stk.n = 0;
  return o;
}

function edgeAvoidMoveOpts(e, o) {
  const t = o || e.room.name;
  const r = consumeStuck(e);
  return {
    reusePath: r ? 1 : 15,
    ignoreCreeps: !r,
    maxRooms: 1,
    plainCost: 20,
    swampCost: 40,
    roomCallback: function(e) {
      return e === t ? getEdgeAvoidMatrix(t) : false;
    }
  };
}

const isBannedRoom = e => BANNED_ROOMS.includes(normalizeRoom(e));
const isOnEdge = util.isOnRoomEdge;
const clearRoute = (e, o) => {
  delete e.memory[o];
  delete e.memory[o + "Index"];
};
const splitTargetsByNonEnergy = e => {
  const hasNonEnergy = e => {
    if (!e.store) return false;
    for (const o in e.store) {
      if (o !== RESOURCE_ENERGY && e.store[o] > 0) return true;
    }
    return false;
  };
  return {
    nonEnergyTargets: e.filter(e => hasNonEnergy(e)),
    energyOnlyTargets: e.filter(e => !hasNonEnergy(e))
  };
};
const hasResources = e => {
  if (!e) return false;
  if (e.amount !== undefined && e.amount > 0) return true;
  if (e.store && e.store.getUsedCapacity() > 0) return true;
  if (e.energy !== undefined && e.energy > 0) return true;
  return false;
};
const STORAGE_TYPES = [ STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_CONTAINER, STRUCTURE_LAB, STRUCTURE_TERMINAL, STRUCTURE_LINK ];
const getCachedRoomState = e => {
  if (!e) return null;
  if (getRoomStateCentral && typeof getRoomStateCentral.get === "function") {
    return getRoomStateCentral.get(e.name);
  }
  return null;
};
const getStructureStoreCandidates = (e, o) => {
  const t = o && normalizeRoom(o.memory.targetRoom) === normalizeRoom(e.name);
  const r = getCachedRoomState(e);
  if (r && r.structuresByType) {
    const e = r.isOwned;
    const o = e && !t;
    const n = [];
    for (let e = 0; e < STORAGE_TYPES.length; e++) {
      const t = r.structuresByType[STORAGE_TYPES[e]];
      if (!t) continue;
      for (let e = 0; e < t.length; e++) {
        const r = t[e];
        if (o && r.my) continue;
        n.push(r);
      }
    }
    return n;
  }
  return e.find(FIND_STRUCTURES, {
    filter: o => {
      if (!STORAGE_TYPES.includes(o.structureType)) return false;
      const r = e.controller && e.controller.my;
      const n = r && !t;
      return n ? !o.my : true;
    }
  });
};
const getLootPiles = e => {
  const o = getCachedRoomState(e);
  if (o) {
    const e = o.tombstones || [];
    const t = o.ruins || [];
    if (e.length || t.length) return e.concat(t);
  }
  return e.find(FIND_RUINS).concat(e.find(FIND_TOMBSTONES));
};
const hasEnemyRampartAt = (e, o) => {
  const t = getCachedRoomState(e);
  if (t && t.structuresByType && t.structuresByType[STRUCTURE_RAMPART]) {
    const e = t.structuresByType[STRUCTURE_RAMPART];
    for (let t = 0; t < e.length; t++) {
      const r = e[t];
      if (r.pos.x !== o.x || r.pos.y !== o.y) continue;
      if (r.owner && !r.my) return true;
      return false;
    }
    return false;
  }
  const r = e.lookForAt(LOOK_STRUCTURES, o);
  return r.some(e => e.structureType === STRUCTURE_RAMPART && e.owner && !e.my);
};
const roomHasNonEnergyResources = (e, o) => {
  const t = getStructureStoreCandidates(e, o);
  for (const o of t) {
    if (!o.store) continue;
    for (const t in o.store) {
      if (t !== RESOURCE_ENERGY && o.store[t] > 0) {
        if (!hasEnemyRampartAt(e, o.pos)) {
          return true;
        }
      }
    }
  }
  const r = getLootPiles(e);
  for (const o of r) {
    if (!o.store) continue;
    for (const t in o.store) {
      if (t !== RESOURCE_ENERGY && o.store[t] > 0) {
        if (!hasEnemyRampartAt(e, o.pos)) {
          return true;
        }
      }
    }
  }
  return false;
};
const getBestResourceToWithdraw = (e, o, t) => {
  if (!e || !e.store) return null;
  for (const o in e.store) {
    if (o !== RESOURCE_ENERGY && e.store[o] > 0) {
      return o;
    }
  }
  if (e.store[RESOURCE_ENERGY] > 0) {
    const r = typeof Ruin !== "undefined" && e instanceof Ruin;
    const n = typeof Tombstone !== "undefined" && e instanceof Tombstone;
    if (!r && !n && roomHasNonEnergyResources(o, t)) {
      return null;
    }
    return RESOURCE_ENERGY;
  }
  return null;
};
const clearStuckState = e => {
  if (e.memory._stk) {
    e.memory._stk.n = 0;
  }
  delete e.memory._move;
};
const smartMoveTo = (e, o, t) => {
  if (e.fatigue > 0) return ERR_TIRED;
  const r = edgeAvoidMoveOpts(e, e.room.name);
  if (t && t.range) r.range = t.range;
  const n = e.moveTo(o, r);
  if (n === ERR_NO_PATH) {
    if (DEBUG) console.log("[Thief] " + e.name + " ERR_NO_PATH to " + o);
    delete e.memory._move;
    return ERR_NO_PATH;
  }
  return n;
};
function stepInwardOffEdge(e) {
  if (e.fatigue > 0) return ERR_TIRED;
  const o = e.pos;
  if (!isOnEdge(o)) {
    delete e.memory._settlingInRoom;
    return false;
  }
  let t = o.x;
  let r = o.y;
  if (o.x === 0) t = 1; else if (o.x === 49) t = 48;
  if (o.y === 0) r = 1; else if (o.y === 49) r = 48;
  const n = new RoomPosition(t, r, e.room.name);
  delete e.memory._move;
  delete e.memory._moveDir;
  delete e.memory.routeToTarget;
  delete e.memory.routeToTargetIndex;
  delete e.memory.routeToHome;
  delete e.memory.routeToHomeIndex;
  e.memory._settlingInRoom = e.room.name;
  const s = o.getDirectionTo(n);
  const i = e.move(s);
  if (i === OK) {
    return true;
  }
  const m = e.moveTo(n, {
    reusePath: 0,
    maxRooms: 1,
    maxOps: 500,
    plainCost: 20,
    swampCost: 40,
    roomCallback: function(o) {
      return o === e.room.name ? getEdgeAvoidMatrix(o) : false;
    }
  });
  return true;
}

function requestThiefRouteScan(e) {
  if (!Memory.depositObserver) Memory.depositObserver = {};
  if (!Array.isArray(Memory.depositObserver.scanQueue)) Memory.depositObserver.scanQueue = [];
  if (Memory.depositObserver.scanQueue.indexOf(e) === -1) {
    Memory.depositObserver.scanQueue.push(e);
  }
  return true;
}

function getThiefNavigationOptions() {
  const e = Memory.depositObserver || {};
  return {
    roomStatus: e.roomStatus || {},
    blockedEdges: e.blockedEdges || {},
    requestObserverScan: requestThiefRouteScan
  };
}

function travelToRoom(e, o, t, r) {
  o = normalizeRoom(o);
  const n = normalizeRoom(e.room.name);
  if (e.memory._move && e.memory._move.dest && normalizeRoom(e.memory._move.dest.room) !== n) {
    delete e.memory._move;
  }
  if (n === o) {
    if (isOnEdge(e.pos)) {
      stepInwardOffEdge(e);
      return ERR_TIRED;
    }
    delete e.memory._settlingInRoom;
    if (e.memory[t] !== undefined || e.memory[t + "Index"] !== undefined) {
      clearRoute(e, t);
      clearStuckState(e);
    }
    return OK;
  }
  const s = e.memory[t];
  if (s && Array.isArray(s)) {
    const o = s.map(normalizeRoom);
    const r = o.indexOf(n);
    const i = e.memory[t + "Index"] || 0;
    if (r !== -1 && r > i) {
      e.memory[t + "Index"] = r;
      delete e.memory._move;
    }
  }
  const i = roomNav.ensureRoute(e, n, o, t, BANNED_ROOMS, r, getThiefNavigationOptions());
  if (!i) {
    const t = Game.map.findRoute(n, o, {
      routeCallback: e => BANNED_ROOMS.includes(normalizeRoom(e)) ? Infinity : 1
    });
    if (t && t.length > 0) {
      let o = t[0].exit;
      const r = e.room.find(o);
      if (r.length > 0) {
        const o = e.pos.findClosestByRange(r);
        if (o) {
          if (e.fatigue > 0) return ERR_TIRED;
          const t = edgeAvoidMoveOpts(e, e.room.name);
          t.maxRooms = 2;
          e.moveTo(o, t);
          return ERR_TIRED;
        }
      }
    }
    return ERR_NO_PATH;
  }
  const m = e.pos;
  const a = m.x < NEAR_EDGE_DIST || m.x >= 50 - NEAR_EDGE_DIST || m.y < NEAR_EDGE_DIST || m.y >= 50 - NEAR_EDGE_DIST;
  if (a) {
    let r = null;
    const s = e.memory[t];
    const i = e.memory[t + "Index"] || 0;
    if (s && s[i + 1]) {
      const e = s[i + 1];
      const o = typeof e === "string" ? e : e.room || null;
      if (o) {
        r = Game.map.findExit(n, normalizeRoom(o));
      }
    }
    if (!r || r < 0) {
      const e = Game.map.findRoute(n, o, {
        routeCallback: function(e) {
          if (BANNED_ROOMS.includes(normalizeRoom(e))) return Infinity;
          return 1;
        }
      });
      if (e && e.length > 0) {
        r = e[0].exit;
      }
    }
    if (r && r > 0) {
      const o = e.room.find(r);
      const t = roomNav.filterPassableTiles(e.room, o);
      if (t.length > 0) {
        const o = e.pos.findClosestByPath(t, {
          maxRooms: 1,
          costCallback: o => o === e.room.name ? getEdgeAvoidMatrix(o) : false
        }) || e.pos.findClosestByRange(t);
        if (o) {
          if (e.fatigue > 0) return ERR_TIRED;
          const t = edgeAvoidMoveOpts(e, e.room.name);
          t.maxRooms = 2;
          const r = e.moveTo(o, t);
          if (r === OK || r === ERR_TIRED) {
            return ERR_TIRED;
          }
        }
      }
    }
  }
  updateStuckCounter(e);
  if (e.fatigue > 0) return ERR_TIRED;
  const l = roomNav.followRoomRoute(e, i, {
    routeKey: t,
    allowUnconstrainedRecovery: false,
    reusePath: 20,
    maxOps: 2e3
  });
  if (l !== OK && l !== ERR_TIRED) {
    clearRoute(e, t);
  }
  return l;
}

function orderThieves(e, o, t) {
  if (!e || !o || !t || t <= 0) {
    return ERR_INVALID_ARGS;
  }
  e = normalizeRoom(e);
  o = normalizeRoom(o);
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return ERR_INVALID_TARGET;
  }
  if (isBannedRoom(o)) {
    return ERR_INVALID_TARGET;
  }
  if (!Memory.thiefOrders) Memory.thiefOrders = [];
  const r = Memory.thiefOrders.find(e => normalizeRoom(e.targetRoom) === o);
  if (r) {
    return ERR_NAME_EXISTS;
  }
  Memory.thiefOrders.push({
    homeRoom: e,
    targetRoom: o,
    count: parseInt(t, 10)
  });
  return OK;
}

function cancelThiefOrder(e) {
  if (!e) return ERR_INVALID_ARGS;
  e = normalizeRoom(e);
  if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) return ERR_NOT_FOUND;
  const o = Memory.thiefOrders.length;
  Memory.thiefOrders = Memory.thiefOrders.filter(o => normalizeRoom(o.targetRoom) !== e);
  return o - Memory.thiefOrders.length > 0 ? OK : ERR_NOT_FOUND;
}

function updateThiefOrder(e, o) {
  if (!e || !o || o <= 0) return ERR_INVALID_ARGS;
  e = normalizeRoom(e);
  if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) return ERR_NOT_FOUND;
  const t = Memory.thiefOrders.find(o => normalizeRoom(o.targetRoom) === e);
  if (!t) return ERR_NOT_FOUND;
  t.count = parseInt(o, 10);
  return OK;
}

function listThiefOrders() {
  if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) {
    console.log("[Thief] No active orders.");
    return;
  }
  console.log("[Thief] Active Orders:");
  console.log("─────────────────────────────────────────");
  Memory.thiefOrders.forEach(e => {
    const o = _.filter(getRoomStateCentral.creepIndex().all, o => o.memory.role === "thief" && normalizeRoom(o.memory.homeRoom) === normalizeRoom(e.homeRoom) && normalizeRoom(o.memory.targetRoom) === normalizeRoom(e.targetRoom));
    console.log("  " + e.homeRoom + " -> " + e.targetRoom + ": " + o.length + "/" + e.count);
  });
}

global.orderThieves = orderThieves;
global.cancelThiefOrder = cancelThiefOrder;
global.updateThiefOrder = updateThiefOrder;
global.listThiefOrders = listThiefOrders;
const roleThief = {
  run: function(e) {
    const o = normalizeRoom(e.room.name);
    const t = normalizeRoom(e.memory.targetRoom);
    const r = normalizeRoom(e.memory.homeRoom);
    const n = o === t;
    const s = o === r;
    if (e.memory._settlingInRoom === o) {
      if (isOnEdge(e.pos)) {
        stepInwardOffEdge(e);
        return;
      } else {
        delete e.memory._settlingInRoom;
      }
    }
    if (e.memory.stealing && n && isOnEdge(e.pos)) {
      stepInwardOffEdge(e);
      return;
    }
    if (!e.memory.stealing && s && isOnEdge(e.pos)) {
      stepInwardOffEdge(e);
      return;
    }
    const i = n && !isOnEdge(e.pos);
    const m = s && !isOnEdge(e.pos);
    if (e.memory._lastRoom && normalizeRoom(e.memory._lastRoom) !== o) {
      delete e.memory._move;
      clearStuckState(e);
    }
    e.memory._lastRoom = o;
    if (isBannedRoom(t)) {
      e.memory.stealing = false;
    }
    if (e.memory.stealing && e.store.getFreeCapacity() === 0) {
      e.memory.stealing = false;
      delete e.memory.theftTarget;
      delete e.memory.depositTarget;
      delete e.memory._move;
      clearStuckState(e);
      clearRoute(e, "routeToTarget");
    }
    if (!e.memory.stealing && e.store.getUsedCapacity() === 0) {
      if (!isBannedRoom(t)) {
        e.memory.stealing = true;
        e.memory._tripStartTick = Game.time;
        delete e.memory._suicideAfterDeposit;
        delete e.memory.depositTarget;
        delete e.memory.theftTarget;
        delete e.memory._move;
        clearStuckState(e);
        clearRoute(e, "routeToHome");
      }
    }
    if (isBannedRoom(o)) {
      const o = e.memory.stealing ? t : r;
      travelToRoom(e, o, e.memory.stealing ? "routeToTarget" : "routeToHome");
      return;
    }
    if (e.memory.stealing) {
      if (!i) {
        travelToRoom(e, t, "routeToTarget", [ t ]);
        return;
      }
      if (e.memory.routeToTargetIndex !== undefined) {
        delete e.memory._move;
        delete e.memory.routeToTargetIndex;
        clearStuckState(e);
      }
      let n = e.memory.theftTarget ? Game.getObjectById(e.memory.theftTarget) : null;
      if (n && n.amount === undefined) {
        let o = getBestResourceToWithdraw(n, e.room, e);
        if (!o) {
          delete e.memory.theftTarget;
          delete e.memory._move;
          clearStuckState(e);
          n = null;
        }
      }
      if (!n || !hasResources(n)) {
        delete e.memory.theftTarget;
        delete e.memory._move;
        clearStuckState(e);
        const t = getCachedRoomState(e.room);
        const r = t ? t.dropped || [] : e.room.find(FIND_DROPPED_RESOURCES);
        const s = r.filter(e => e.resourceType !== RESOURCE_ENERGY);
        const i = r.filter(e => e.resourceType === RESOURCE_ENERGY && e.amount >= MIN_ENERGY_DROP);
        const m = getStructureStoreCandidates(e.room, e).filter(hasResources);
        const a = m.filter(e => !e.my);
        const l = t ? t.isOwned : e.room.controller && e.room.controller.my;
        const c = normalizeRoom(e.memory.targetRoom) === o;
        const f = l && !c ? a : m;
        const u = f.filter(o => !hasEnemyRampartAt(e.room, o.pos));
        const R = splitTargetsByNonEnergy(u);
        const d = (t ? t.tombstones || [] : e.room.find(FIND_TOMBSTONES, {
          filter: e => e.store && e.store.getUsedCapacity() > 0
        })).filter(e => e.store && e.store.getUsedCapacity() > 0).filter(o => !hasEnemyRampartAt(e.room, o.pos));
        const T = splitTargetsByNonEnergy(d);
        const y = t ? t.ruins || [] : e.room.find(FIND_RUINS, {
          filter: e => e.store && e.store.getUsedCapacity() > 0
        });
        const g = y.filter(e => e.store && e.store.getUsedCapacity() > 0).filter(o => !hasEnemyRampartAt(e.room, o.pos));
        const E = splitTargetsByNonEnergy(g);
        const closestByPath = o => o.length ? e.pos.findClosestByPath(o, {
          maxRooms: 1,
          costCallback: o => o === e.room.name ? getEdgeAvoidMatrix(o) : false
        }) || e.pos.findClosestByRange(o) : null;
        const _ = !roomHasNonEnergyResources(e.room, e);
        n = closestByPath(s) || closestByPath(i) || closestByPath(T.nonEnergyTargets) || closestByPath(T.energyOnlyTargets) || closestByPath(E.nonEnergyTargets) || closestByPath(E.energyOnlyTargets) || closestByPath(R.nonEnergyTargets) || _ && closestByPath(R.energyOnlyTargets) || null;
        if (n) e.memory.theftTarget = n.id;
      }
      if (n && hasResources(n)) {
        const o = n.amount !== undefined;
        if (o) {
          const o = e.pickup(n);
          if (o === ERR_NOT_IN_RANGE) {
            const o = smartMoveTo(e, n);
            if (o === ERR_NO_PATH) {
              delete e.memory.theftTarget;
              delete e.memory._move;
            }
          } else if (o === OK) {
            clearStuckState(e);
            if (!hasResources(n)) delete e.memory.theftTarget;
          }
        } else {
          const o = getBestResourceToWithdraw(n, e.room, e);
          if (o) {
            const t = e.withdraw(n, o);
            if (t === ERR_NOT_IN_RANGE) {
              const o = smartMoveTo(e, n);
              if (o === ERR_NO_PATH) {
                delete e.memory.theftTarget;
                delete e.memory._move;
              }
            } else if (t === OK) {
              clearStuckState(e);
              if (!getBestResourceToWithdraw(n, e.room, e)) {
                delete e.memory.theftTarget;
              }
            }
          } else {
            delete e.memory.theftTarget;
            delete e.memory._move;
            clearStuckState(e);
          }
        }
      } else {
        e.memory.stealing = false;
        delete e.memory.theftTarget;
        delete e.memory.depositTarget;
        delete e.memory._move;
        clearStuckState(e);
        clearRoute(e, "routeToTarget");
        travelToRoom(e, r, "routeToHome");
        return;
      }
    } else {
      if (!m) {
        travelToRoom(e, r, "routeToHome");
        return;
      }
      if (e.memory.routeToHomeIndex !== undefined) {
        delete e.memory._move;
        delete e.memory.routeToHomeIndex;
        clearStuckState(e);
      }
      if (e.memory._tripStartTick && typeof e.memory._tripStartTick === "number") {
        const o = Game.time - e.memory._tripStartTick;
        if (o > 0 && o < CREEP_LIFE_TIME) {
          recordTripTime(r, t, o);
        }
        delete e.memory._tripStartTick;
      }
      if (e.store.getUsedCapacity() > 0 && shouldSuicideForLowTTL(e, r, t)) {
        if (!e.memory._suicideAfterDeposit) {
          console.log("[Thief] " + e.name + " (" + r + " -> " + t + ") TTL too low (" + e.ticksToLive + ") for another round trip. " + "Depositing cargo and suiciding.");
        }
        e.memory._suicideAfterDeposit = true;
      }
      let o = e.memory.depositTarget ? Game.getObjectById(e.memory.depositTarget) : null;
      if (!o || !o.store || o.store.getFreeCapacity() === 0) {
        delete e.memory.depositTarget;
        delete e.memory._move;
        clearStuckState(e);
        const t = getCachedRoomState(e.room);
        const r = t ? (t.structuresByType[STRUCTURE_STORAGE] || []).filter(e => e.my && e.store && e.store.getFreeCapacity() > 0) : e.room.find(FIND_STRUCTURES, {
          filter: e => e.structureType === STRUCTURE_STORAGE && e.my && e.store && e.store.getFreeCapacity() > 0
        });
        if (r.length) {
          o = e.pos.findClosestByPath(r, {
            maxRooms: 1,
            costCallback: function(o) {
              return o === e.room.name ? getEdgeAvoidMatrix(o) : false;
            }
          }) || e.pos.findClosestByRange(r);
          if (o) e.memory.depositTarget = o.id;
        }
      }
      if (o && o.store && o.store.getFreeCapacity() > 0) {
        for (const t in e.store) {
          const r = e.transfer(o, t);
          if (r === ERR_NOT_IN_RANGE) {
            const t = smartMoveTo(e, o);
            if (t === ERR_NO_PATH) {
              delete e.memory.depositTarget;
              delete e.memory._move;
            }
          } else if (r === OK) {
            clearStuckState(e);
          }
          break;
        }
        if (o.store.getFreeCapacity() === 0) {
          delete e.memory.depositTarget;
        }
      }
      if (e.memory._suicideAfterDeposit && e.store.getUsedCapacity() === 0) {
        delete e.memory._suicideAfterDeposit;
        if (DEBUG) console.log("[Thief] " + e.name + " cargo deposited; suiciding.");
        e.suicide();
        return;
      }
    }
  }
};
module.exports = {
  run: roleThief.run,
  BANNED_ROOMS: BANNED_ROOMS,
  orderThieves: orderThieves,
  cancelThiefOrder: cancelThiefOrder,
  updateThiefOrder: updateThiefOrder,
  listThiefOrders: listThiefOrders
};
