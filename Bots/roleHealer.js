// LLM: Read docs/codex.js before reviewing or changing this file.
// roleHealer.js
// Role dispatch: memory.role === 'healer' -> roleHealer.run(creep).
// Console globals: orderHeal, cancelHealOrder, setHealCount, listHealOrders
// Example: orderHeal('W1N1', 'W2N2', 1) - Order dedicated healer creep to support assault
// Example: cancelHealOrder('W1N1') - Cancel heal order for room
// Example: setHealCount('W1N1', 2) - Update desired healer count for room
// Example: listHealOrders() - List active healer deployment orders
//   orderHeal(spawnRoom, targetRoom, count, ...options)
//     Optional flags: 'sustain'. Optional numeric X,Y set the target entry.
//   cancelHealOrder(targetRoomOrOrderId)
//   setHealCount(targetRoomOrOrderId, count)
//   listHealOrders()
const iff = require("iff");
const getRoomState = require("getRoomState");
const navigationCache = {
  tick: -1,
  structureMatrices: {},
  avoidancePaths: {},
  hostileTowers: {}
};
global.orderHeal = function(e, r, t) {
  if (!e || !r || !Number.isSafeInteger(t) || t < 1) {
    return "[Heal] Usage: orderHeal('spawnRoom', 'targetRoom', count, 'sustain'?, x?, y?)";
  }
  const o = Array.prototype.slice.call(arguments, 3);
  const a = [];
  const n = [];
  for (let e = 0; e < o.length; e++) {
    if (typeof o[e] === "number") n.push(o[e]); else a.push(o[e]);
  }
  const s = a.filter(e => e !== "sustain");
  if (s.length > 0) {
    return "[Heal] Unknown flag(s): " + s.join(", ") + ". Valid flags: 'sustain'.";
  }
  if (n.length !== 0 && n.length !== 2) {
    return "[Heal] Entry requires both X and Y. Example: orderHeal('" + e + "', '" + r + "', " + t + ", 1, 25).";
  }
  if (n.length === 2 && (!Number.isInteger(n[0]) || !Number.isInteger(n[1]) || n[0] < 0 || n[0] > 49 || n[1] < 0 || n[1] > 49)) {
    return "[Heal] Entry X and Y must be integers from 0 through 49.";
  }
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[Heal] Invalid spawn room: " + e + ". Must be a room you control.";
  }
  if (!Memory.healOrders) Memory.healOrders = [];
  const i = Memory.healOrders.find(e => e.targetRoom === r);
  if (i) {
    return "[Heal] Heal order already exists for " + r + " (" + i.orderId + ").";
  }
  Memory.healOrderSequence = (Memory.healOrderSequence || 0) + 1;
  const m = n.length === 2;
  const l = m ? {
    x: n[0],
    y: n[1]
  } : {
    x: 25,
    y: 25
  };
  const c = a.indexOf("sustain") !== -1;
  Memory.healOrders.push({
    orderId: "heal_" + Game.time + "_" + Memory.healOrderSequence,
    targetRoom: r,
    spawnRoom: e,
    count: t,
    spawned: 0,
    startTime: Game.time,
    entryPoint: l,
    entryRange: m ? 1 : 23,
    rallyPhase: "spawning",
    sustain: c
  });
  const u = "[Heal] Order created: " + t + " healers spawning in " + e + " -> " + r + (c ? " [sustained]" : "") + (m ? " [entry " + l.x + "," + l.y + "]" : "");
  console.log(u);
  return u;
};
function getNavigationCache() {
  if (navigationCache.tick !== Game.time) {
    navigationCache.tick = Game.time;
    navigationCache.structureMatrices = {};
    navigationCache.hostileTowers = {};
    Object.keys(navigationCache.avoidancePaths).forEach(e => {
      if (navigationCache.avoidancePaths[e].time < Game.time - 25) delete navigationCache.avoidancePaths[e];
    });
  }
  return navigationCache;
}

function getStructureMatrix(e) {
  const r = getNavigationCache();
  if (!r.structureMatrices[e]) {
    const t = new PathFinder.CostMatrix;
    const o = getRoomState.get(e);
    const a = o && o.structuresByType ? Object.values(o.structuresByType).flat() : [];
    if (a.length > 0) {
      a.forEach(e => {
        if (e.structureType !== STRUCTURE_ROAD && e.structureType !== STRUCTURE_CONTAINER && (e.structureType !== STRUCTURE_RAMPART || !e.my)) {
          t.set(e.pos.x, e.pos.y, 255);
        }
      });
    }
    r.structureMatrices[e] = t;
  }
  return r.structureMatrices[e].clone();
}

function clearMovementCache(e) {
  delete e.memory._move;
  delete e.memory._path;
  delete e.memory.pathToTarget;
  delete e.memory.destination;
  delete getNavigationCache().avoidancePaths[e.name];
}

function getBlacklistedRoomNames(e) {
  const r = e.memory.blacklistedRooms;
  if (!r || r.length === 0) return [];
  const t = Game.time;
  const o = r.map(e => typeof e === "string" ? {
    roomName: e,
    expires: t + 150
  } : e).filter(e => e && e.roomName && e.expires > t);
  e.memory.blacklistedRooms = o;
  return o.map(e => typeof e === "string" ? e : e.roomName);
}

function moveSafely(e, r, t) {
  const o = Object.assign({
    reusePath: 10
  }, t || {});
  delete o.visualizePathStyle;
  const a = r.pos || r;
  const n = getBlacklistedRoomNames(e);
  if (!n || n.length === 0) return e.moveTo(r, o);
  const s = getNavigationCache();
  const i = a.roomName + ":" + a.x + ":" + a.y + ":" + (o.range || 1) + ":" + n.join(",");
  let m = s.avoidancePaths[e.name];
  if (!m || m.key !== i) m = null; else if (m.path.length && e.pos.isEqualTo(m.path[0])) m.path.shift();
  if (m && m.path.length) {
    return e.move(e.pos.getDirectionTo(m.path[0]));
  }
  const l = PathFinder.search(e.pos, {
    pos: a,
    range: o.range || 1
  }, {
    maxOps: o.maxOps || 4e3,
    maxRooms: o.maxRooms || 16,
    plainCost: o.plainCost || 1,
    swampCost: o.swampCost || 5,
    roomCallback: r => {
      if (n.includes(r) && r !== e.memory.targetRoom && r !== e.room.name) return false;
      return getStructureMatrix(r);
    }
  });
  if (l.path.length === 0) return ERR_NO_PATH;
  s.avoidancePaths[e.name] = {
    key: i,
    path: l.path,
    time: Game.time
  };
  return e.move(e.pos.getDirectionTo(l.path[0]));
}

function hasActiveHostileTowers(e) {
  const r = getNavigationCache();
  let t = r.hostileTowers[e.name];
  if (!t) {
    t = e.find(FIND_HOSTILE_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_TOWER && (!e.owner || !iff.isFriendlyUsername(e.owner.username)) && e.store[RESOURCE_ENERGY] > 0
    });
    r.hostileTowers[e.name] = t;
  }
  return t.length > 0 && !(e.controller && e.controller.safeMode);
}

function checkForHostileTowers(e) {
  if (e.room.name === e.memory.targetRoom || !hasActiveHostileTowers(e.room)) return false;
  const r = getBlacklistedRoomNames(e);
  if (!r.includes(e.room.name)) {
    if (!e.memory.blacklistedRooms) e.memory.blacklistedRooms = [];
    e.memory.blacklistedRooms.push({
      roomName: e.room.name,
      expires: Game.time + 150
    });
    clearMovementCache(e);
    console.log("[Heal] " + e.name + " blacklisted " + e.room.name + " due to hostile towers");
  }
  return true;
}

function handleRetreat(e) {
  const r = e.memory.retreatTarget || e.memory.previousRoom || e.memory.spawnRoom;
  e.memory.retreatTarget = r;
  if (e.room.name !== r) {
    healNearby(e);
    moveSafely(e, new RoomPosition(25, 25, r), {
      range: 23,
      reusePath: 0
    });
    return;
  }
  if (e.hits < e.hitsMax) {
    e.heal(e);
    return;
  }
  e.memory.retreatTicks = (e.memory.retreatTicks || 0) + 1;
  if (e.memory.retreatTicks > 3) {
    delete e.memory.retreating;
    delete e.memory.retreatTarget;
    delete e.memory.retreatTicks;
    clearMovementCache(e);
  }
}

function getDamagedFriendlies(e, r) {
  const t = getRoomState.get(e.room.name);
  if (!t) return [];
  const o = t.myCreeps.filter(t => (r || t.id !== e.id) && t.hits < t.hitsMax);
  (t.myPowerCreeps || []).filter(e => e.hits < e.hitsMax).forEach(e => o.push(e));
  for (const e of t.hostiles) {
    if (e.hits < e.hitsMax && iff.isWhitelistedCreep(e)) o.push(e);
  }
  return o;
}

function findDamagedFriendly(e, r) {
  let t = null;
  let o = Infinity;
  let a = Infinity;
  getDamagedFriendlies(e, false).forEach(n => {
    const s = e.pos.getRangeTo(n);
    if (r !== undefined && s > r) return;
    const i = n.hits / n.hitsMax;
    if (i < o || i === o && s < a) {
      t = n;
      o = i;
      a = s;
    }
  });
  return t;
}

function healNearby(e) {
  let r = e.hits < e.hitsMax ? e : null;
  let t = r ? r.hits / r.hitsMax : Infinity;
  getDamagedFriendlies(e, false).forEach(o => {
    const a = e.pos.getRangeTo(o);
    if (a > 3) return;
    const n = o.hits / o.hitsMax;
    if (n < t) {
      r = o;
      t = n;
    }
  });
  if (!r) return false;
  if (r === e || e.pos.isNearTo(r)) e.heal(r); else e.rangedHeal(r);
  return true;
}

const roleHealer = {
  run: function(e) {
    if (e.spawning) return;
    const r = e.memory.targetRoom;
    const t = e.memory.spawnRoom;
    if (!r || !t) return;
    if (e.memory._path || e.memory.pathToTarget || e.memory.destination) clearMovementCache(e);
    if (!e.memory.previousRoom) e.memory.previousRoom = e.room.name;
    if (e.memory.retiring) {
      healNearby(e);
      if (e.room.name === t) e.suicide(); else moveSafely(e, new RoomPosition(25, 25, t), {
        range: 23
      });
      return;
    }
    if (e.memory.retreating) {
      handleRetreat(e);
      return;
    }
    if (checkForHostileTowers(e)) {
      e.memory.retreating = true;
      e.memory.retreatTarget = e.memory.previousRoom || t;
      clearMovementCache(e);
      handleRetreat(e);
      return;
    }
    e.memory.previousRoom = e.room.name;
    if (e.room.name !== r) {
      healNearby(e);
      const o = e.memory.entryPoint || {
        x: 25,
        y: 25
      };
      const a = moveSafely(e, new RoomPosition(o.x, o.y, r), {
        range: e.memory.entryRange === undefined ? 23 : e.memory.entryRange
      });
      if (a === ERR_NO_PATH) {
        e.memory.retreating = true;
        e.memory.retreatTarget = e.memory.previousRoom || t;
      }
      return;
    }
    const o = findDamagedFriendly(e);
    if (!o) {
      if (hasActiveHostileTowers(e.room)) {
        e.memory.retreating = true;
        e.memory.retreatTarget = e.memory.previousRoom || t;
        handleRetreat(e);
        return;
      }
      healNearby(e);
      return;
    }
    healNearby(e);
    const a = e.pos.getRangeTo(o);
    const n = o.hits / o.hitsMax < .3;
    const s = n ? 1 : 3;
    if (a > s) moveSafely(e, o, {
      range: s,
      reusePath: 2
    });
  }
};
module.exports = roleHealer;
global.cancelHealOrder = function(e) {
  if (!Memory.healOrders || Memory.healOrders.length === 0) return "[Heal] No active heal orders.";
  const r = Memory.healOrders.filter(r => r.orderId === e || r.targetRoom === e);
  if (r.length === 0) return "[Heal] No heal order found for " + e + ".";
  if (r.length > 1) return "[Heal] Multiple orders target " + e + ". Use an order ID from listHealOrders().";
  const t = Memory.healOrders.indexOf(r[0]);
  const o = Memory.healOrders[t].sustain === true;
  Memory.healOrders.splice(t, 1);
  return "[Heal] Heal order for " + e + " has been cancelled." + (o ? " Respawning stopped; living healers will continue supporting until they die." : "");
};
global.setHealCount = function(e, r) {
  if (!e || !Number.isSafeInteger(r) || r < 1) {
    return "[Heal] Invalid command. Use setHealCount('targetRoom', count).";
  }
  if (!Memory.healOrders || Memory.healOrders.length === 0) return "[Heal] No active heal orders.";
  const t = Memory.healOrders.filter(r => r.orderId === e || r.targetRoom === e);
  if (t.length === 0) return "[Heal] No heal order found for " + e + ".";
  if (t.length > 1) return "[Heal] Multiple orders target " + e + ". Use an order ID from listHealOrders().";
  const o = t[0];
  if (o.sustain !== true) return "[Heal] Count updates only apply to sustained heal orders.";
  const a = o.count;
  o.count = r;
  const n = _.filter(getRoomState.creepIndex().all, e => e.memory.role === "healer" && e.memory.healOrderId === o.orderId).length;
  return "[Heal] Updated sustained heal on " + e + " count " + a + " -> " + r + ". Currently alive: " + n + "/" + r + ".";
};
global.listHealOrders = function() {
  if (!Memory.healOrders || Memory.healOrders.length === 0) return "[Heal] No active heal orders.";
  return Memory.healOrders.map(e => e.orderId + ": " + e.spawnRoom + " -> " + e.targetRoom + " " + (e.rallyPhase || "spawning") + " " + (e.count || 0) + (e.sustain ? " [sustain]" : "")).join("\n");
};
