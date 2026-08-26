// LLM: Read docs/codex.js before reviewing or changing this file.
// roleHarasser.js
// Role dispatch: memory.role === 'harasser' -> roleHarasser.run(creep).
// Console globals: orderHarass, cancelHarassOrder, holdHarassFire, setHarassCount
// Example: orderHarass('W1N1', 'W2N2', 2) - Order harasser creeps to disrupt enemy room
// Example: cancelHarassOrder('W1N1') - Cancel harasser order for room
// Example: holdHarassFire('W1N1', true) - Toggle hold fire status for harassers
// Example: setHarassCount('W1N1', 3) - Update desired harasser count for room
const iff = require("iff");
global.orderHarass = function(e, r, t) {
  if (!e || !r || !Number.isInteger(t) || t <= 0) {
    return "[Harass] Usage: orderHarass('spawnRoom', 'targetRoom', count, 'sustain'?, x?, y?)";
  }
  const s = Array.prototype.slice.call(arguments, 3);
  const o = s.filter(e => typeof e !== "number");
  const a = s.filter(e => typeof e === "number");
  if (o.some(e => e !== "sustain")) return "[Harass] Valid flag: 'sustain'.";
  if (a.length !== 0 && a.length !== 2) return "[Harass] Entry requires both X and Y.";
  if (a.length === 2 && (!Number.isInteger(a[0]) || !Number.isInteger(a[1]) || a[0] < 0 || a[0] > 49 || a[1] < 0 || a[1] > 49)) {
    return "[Harass] Entry X and Y must be integers from 0 through 49.";
  }
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[Harass] Invalid spawn room: " + e + ".";
  }
  if (!Memory.harassOrders) Memory.harassOrders = [];
  if (Memory.harassOrders.some(e => e.targetRoom === r)) {
    return "[Harass] An order already exists for " + r + ".";
  }
  Memory.harassOrderSequence = (Memory.harassOrderSequence || 0) + 1;
  const n = a.length === 2 ? {
    x: a[0],
    y: a[1]
  } : {
    x: 25,
    y: 25
  };
  const i = {
    orderId: "harass_" + Game.time + "_" + Memory.harassOrderSequence,
    spawnRoom: e,
    targetRoom: r,
    count: t,
    spawned: 0,
    sustain: o.indexOf("sustain") !== -1,
    entryPoint: n,
    entryRange: a.length === 2 ? 1 : 23
  };
  Memory.harassOrders.push(i);
  const m = "[Harass] Order created: " + t + " harasser(s) " + e + " -> " + r + (i.sustain ? " [sustained]" : "");
  console.log(m);
  return m;
};
global.cancelHarassOrder = function(e) {
  if (!Memory.harassOrders) return "[Harass] No active orders.";
  const r = Memory.harassOrders.length;
  Memory.harassOrders = Memory.harassOrders.filter(r => r.targetRoom !== e);
  return r === Memory.harassOrders.length ? "[Harass] No order for " + e + "." : "[Harass] Cancelled order for " + e + ".";
};
global.setHarassCount = function(e, r) {
  const t = Memory.harassOrders && Memory.harassOrders.find(r => r.targetRoom === e);
  if (!t || !t.sustain || !Number.isInteger(r) || r <= 0) {
    return "[Harass] A positive count requires an existing sustained order.";
  }
  t.count = r;
  return "[Harass] Maintaining " + r + " harasser(s) in " + e + ".";
};
global.holdHarassFire = function(e, r) {
  if (typeof e !== "string" || !e) {
    return "[Harass] Usage: holdHarassFire('targetRoom', ticks?)";
  }
  if (r === undefined) r = 30;
  if (!Number.isInteger(r) || r < 0) {
    return "[Harass] Hold duration must be a non-negative integer.";
  }
  if (!Memory.harassHoldFire) Memory.harassHoldFire = {};
  if (r === 0) {
    delete Memory.harassHoldFire[e];
    return "[Harass] Fire resumed in " + e + ".";
  }
  const t = Game.time + r;
  Memory.harassHoldFire[e] = t;
  return "[Harass] Holding fire in " + e + " through tick " + t + ".";
};
function isHoldingFire(e) {
  if (!Memory.harassHoldFire) return false;
  const r = Memory.harassHoldFire[e];
  if (!r) return false;
  if (r < Game.time) {
    delete Memory.harassHoldFire[e];
    return false;
  }
  return true;
}

const matrixCache = {
  tick: -1,
  matrices: {}
};
function structureMatrix(e, r) {
  if (matrixCache.tick !== Game.time) {
    matrixCache.tick = Game.time;
    matrixCache.matrices = {};
  }
  const t = e + ":" + r;
  if (matrixCache.matrices[t]) return matrixCache.matrices[t];
  const s = new PathFinder.CostMatrix;
  const o = Game.rooms[e];
  if (!o) return s;
  o.find(FIND_STRUCTURES).forEach(e => {
    if (e.structureType === STRUCTURE_ROAD || e.structureType === STRUCTURE_CONTAINER) return;
    if (e.structureType === STRUCTURE_RAMPART && (e.my || e.isPublic)) return;
    if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) {
      s.set(e.pos.x, e.pos.y, r);
    } else if (e.structureType !== STRUCTURE_EXTRACTOR) {
      s.set(e.pos.x, e.pos.y, 255);
    }
  });
  matrixCache.matrices[t] = s;
  return s;
}

function fleeFromHostiles(e, r, t, s) {
  const o = PathFinder.search(e.pos, r.map(e => ({
    pos: e.pos,
    range: t
  })), {
    flee: true,
    maxRooms: 1,
    maxOps: 1e3,
    roomCallback: e => {
      const r = structureMatrix(e, 255);
      if (!s) return r;
      const t = r.clone();
      for (let e = 0; e < 50; e++) {
        t.set(e, 0, 255);
        t.set(e, 49, 255);
        t.set(0, e, 255);
        t.set(49, e, 255);
      }
      return t;
    }
  });
  if (o.path.length) {
    e.move(e.pos.getDirectionTo(o.path[0]));
    return;
  }
  const a = e.pos.findClosestByRange(r);
  if (a && e.pos.inRangeTo(a, t)) {
    const r = e.pos.getDirectionTo(a);
    e.move(r > 4 ? r - 4 : r + 4);
  }
}

function isFriendlyRoom(e) {
  return e.controller && (e.controller.my || e.controller.owner && iff.isFriendlyUsername(e.controller.owner.username));
}

const roleHarasser = {
  run: function(e) {
    this.heal(e);
    if (e.room.name !== e.memory.targetRoom) {
      const r = e.memory.entryPoint || {
        x: 25,
        y: 25
      };
      e.moveTo(new RoomPosition(r.x, r.y, e.memory.targetRoom), {
        range: e.memory.entryRange === undefined ? 23 : e.memory.entryRange,
        reusePath: 5,
        maxRooms: 16
      });
      return;
    }
    const r = e.room.find(FIND_HOSTILE_CREEPS, {
      filter: iff.isHostileCreep
    });
    if (e.memory.withdrawing && e.hits >= e.hitsMax * .9) {
      delete e.memory.withdrawing;
    } else if (e.hits < e.hitsMax * .5) {
      e.memory.withdrawing = true;
    }
    if (e.memory.withdrawing) {
      const t = r.filter(r => e.pos.inRangeTo(r, 5));
      const s = t.length ? e.pos.findClosestByRange(t) : null;
      if (!isHoldingFire(e.memory.targetRoom) && s && e.pos.inRangeTo(s, 3)) e.rangedAttack(s);
      if (t.length) fleeFromHostiles(e, t, 5, true);
      return;
    }
    const t = r.filter(r => e.pos.inRangeTo(r, 3));
    if (t.length) {
      const s = e.pos.findClosestByRange(t);
      return this.harassTarget(e, s, r);
    }
    const s = this.findProtectedTargetRampart(e, r);
    if (s) return this.attackBarrier(e, s);
    const o = this.findStrategicBarrier(e, r);
    if (o) return this.attackBarrier(e, o);
    const a = this.findReachableTarget(e, r);
    if (a) return this.harassTarget(e, a, r);
    delete e.memory.targetId;
  },
  heal: function(e) {
    if (e.hits < e.hitsMax) {
      e.heal(e);
      return;
    }
    const r = e.pos.findClosestByRange(FIND_MY_CREEPS, {
      filter: r => r.id !== e.id && r.hits < r.hitsMax
    });
    if (r && e.pos.inRangeTo(r, 1)) e.heal(r);
  },
  findReachableTarget: function(e, r) {
    const t = r.slice().sort((r, t) => e.pos.getRangeTo(r) - e.pos.getRangeTo(t));
    for (let r = 0; r < t.length; r++) {
      const s = PathFinder.search(e.pos, {
        pos: t[r].pos,
        range: 3
      }, {
        maxRooms: 1,
        maxOps: 1e3,
        roomCallback: e => structureMatrix(e, 255)
      });
      if (!s.incomplete) return t[r];
    }
    return null;
  },
  harassTarget: function(e, r, t) {
    e.memory.targetId = r.id;
    const s = e.pos.getRangeTo(r);
    if (!isHoldingFire(e.memory.targetRoom) && s <= 3) e.rangedAttack(r);
    if (s <= 2) {
      const r = t.filter(r => e.pos.inRangeTo(r, 2));
      fleeFromHostiles(e, r, 3, false);
    } else if (s > 3) {
      e.moveTo(r, {
        range: 3,
        reusePath: 0,
        maxRooms: 1,
        costCallback: e => structureMatrix(e, 255)
      });
    }
  },
  findStrategicBarrier: function(e, r) {
    if (!r.length || isFriendlyRoom(e.room)) return null;
    const t = [];
    for (let s = 0; s < r.length; s++) {
      const o = PathFinder.search(e.pos, {
        pos: r[s].pos,
        range: 3
      }, {
        maxRooms: 1,
        maxOps: 1e3,
        roomCallback: e => structureMatrix(e, 1)
      });
      if (o.incomplete) continue;
      for (let r = 0; r < o.path.length; r++) {
        const s = e.room.lookForAt(LOOK_STRUCTURES, o.path[r].x, o.path[r].y);
        const a = s.find(e => e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic && (!e.owner || !iff.isFriendlyUsername(e.owner.username)));
        if (a) t.push(a);
      }
    }
    if (!t.length) return null;
    return t.reduce((e, r) => r.hits < e.hits ? r : e, t[0]);
  },
  findProtectedTargetRampart: function(e, r) {
    if (isFriendlyRoom(e.room)) return null;
    const t = [];
    for (let s = 0; s < r.length; s++) {
      const o = e.room.lookForAt(LOOK_STRUCTURES, r[s].pos.x, r[s].pos.y);
      const a = o.find(e => e.structureType === STRUCTURE_RAMPART && !e.my && !e.isPublic && (!e.owner || !iff.isFriendlyUsername(e.owner.username)));
      if (!a) continue;
      const n = PathFinder.search(e.pos, {
        pos: a.pos,
        range: 3
      }, {
        maxRooms: 1,
        maxOps: 1e3,
        roomCallback: e => structureMatrix(e, 255)
      });
      if (!n.incomplete) t.push(a);
    }
    if (!t.length) return null;
    return t.reduce((e, r) => r.hits < e.hits ? r : e, t[0]);
  },
  attackBarrier: function(e, r) {
    e.memory.targetId = r.id;
    if (!isHoldingFire(e.memory.targetRoom) && e.pos.inRangeTo(r, 3)) e.rangedAttack(r); else e.moveTo(r, {
      range: 3,
      reusePath: 0,
      maxRooms: 1,
      costCallback: e => structureMatrix(e, 255)
    });
  }
};
module.exports = roleHarasser;
