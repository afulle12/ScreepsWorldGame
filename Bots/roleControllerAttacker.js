// LLM: Read docs/codex.js before reviewing or changing this file.
// roleControllerAttacker.js
// Role dispatch: memory.role === 'controllerAttacker' -> roleControllerAttacker.run(creep).
// Console globals: orderControllerAttack, cancelControllerAttack, listControllerAttackOrders
// Example: orderControllerAttack('W1N1', 'W2N2', 1) - Dispatch controller attacker to reserve/claim block
// Example: cancelControllerAttack('W1N1') - Cancel controller attack order
// Example: listControllerAttackOrders() - List all active controller attack orders
//       reduce downgrade or reservation timers.
//    orderControllerAttack('W1N1', 'W2N2')
//    (Spawns an attacker from W1N1 and sends it to W2N2)
//    orderControllerAttack('W1N1', 'W2N2', 'N')
//    (Creep will go north first before routing to W2N2)
//    listControllerAttackOrders()
const iff = require("iff");
function getRoomInDirection(e, o) {
  const t = e.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!t) return null;
  let [, r, n, m, a] = t;
  n = parseInt(n, 10);
  a = parseInt(a, 10);
  if (o === "N") {
    if (m === "N") {
      a++;
    } else if (a > 0) {
      a--;
    } else {
      m = "N";
      a = 1;
    }
  } else if (o === "S") {
    if (m === "S") {
      a++;
    } else if (a > 0) {
      a--;
    } else {
      m = "S";
      a = 1;
    }
  } else if (o === "E") {
    if (r === "E") {
      n++;
    } else if (n > 0) {
      n--;
    } else {
      r = "E";
      n = 1;
    }
  } else if (o === "W") {
    if (r === "W") {
      n++;
    } else if (n > 0) {
      n--;
    } else {
      r = "W";
      n = 1;
    }
  } else {
    return null;
  }
  return `${r}${n}${m}${a}`;
}

global.orderControllerAttack = function(e, o, t = null) {
  if (!Memory.controllerAttackOrders) Memory.controllerAttackOrders = [];
  const r = {
    homeRoom: e,
    targetRoom: o,
    time: Game.time
  };
  if (t) {
    const o = t.toUpperCase();
    if (![ "N", "S", "E", "W" ].includes(o)) {
      return `Invalid exit direction "${t}". Use N, S, E, or W.`;
    }
    const n = getRoomInDirection(e, o);
    if (!n) {
      return `Could not resolve room to the ${o} of ${e}.`;
    }
    r.waypointRoom = n;
  }
  Memory.controllerAttackOrders.push(r);
  return `Controller attack ordered from ${e} targeting ${o}` + (r.waypointRoom ? ` via ${r.waypointRoom} (exit ${t.toUpperCase()})` : "");
};
global.listControllerAttackOrders = function() {
  if (!Memory.controllerAttackOrders || Memory.controllerAttackOrders.length === 0) {
    return "No active controller attack orders.";
  }
  return JSON.stringify(Memory.controllerAttackOrders, null, 2);
};
global.cancelControllerAttack = function(e) {
  if (!Memory.controllerAttackOrders || Memory.controllerAttackOrders.length === 0) {
    return "No active controller attack orders.";
  }
  const o = Memory.controllerAttackOrders.length;
  Memory.controllerAttackOrders = Memory.controllerAttackOrders.filter(function(o) {
    return !o || o.targetRoom !== e;
  });
  const t = o - Memory.controllerAttackOrders.length;
  return t ? "Cancelled " + t + " controller attack order(s) for " + e + "." : "No controller attack order found for " + e + ".";
};
const roleControllerAttacker = {
  run: function(e) {
    const o = e.memory.targetRoom;
    if (e.memory._path || e.memory.pathToTarget || e.memory.destination) {
      delete e.memory._path;
      delete e.memory.pathToTarget;
      delete e.memory.destination;
    }
    if (!e.memory.previousRoom) {
      e.memory.previousRoom = e.room.name;
    }
    if (e.memory.retreating) {
      return this.handleRetreat(e);
    }
    const t = this.checkForHostileTowers(e);
    if (t) {
      e.say("🚨 RETREAT!");
      e.memory.retreating = true;
      e.memory.retreatTarget = e.memory.previousRoom || e.memory.homeRoom;
      return this.handleRetreat(e);
    }
    if (e.memory.previousRoom !== e.room.name) {
      e.memory.previousRoom = e.room.name;
    }
    if (e.memory.waypointRoom && e.room.name !== e.memory.waypointRoom) {
      this.moveToAvoidingBlacklist(e, new RoomPosition(25, 25, e.memory.waypointRoom), {
        visualizePathStyle: {
          stroke: "#ffaa00",
          lineStyle: "dotted"
        },
        range: 23
      });
      e.say("📍 WP");
      return;
    }
    if (e.memory.waypointRoom && e.room.name === e.memory.waypointRoom) {
      delete e.memory.waypointRoom;
    }
    if (e.room.name !== o) {
      this.moveToAvoidingBlacklist(e, new RoomPosition(25, 25, o), {
        visualizePathStyle: {
          stroke: "#ff0000",
          lineStyle: "dashed"
        },
        range: 23
      });
      return;
    }
    const r = e.room.controller;
    if (!r || r.my || !r.owner && !r.reservation) {
      if (r && !e.pos.isNearTo(r)) {
        e.moveTo(r, {
          reusePath: 50,
          maxRooms: 1
        });
      }
      return;
    }
    if (!e.pos.isNearTo(r)) {
      e.moveTo(r, {
        reusePath: 50,
        maxRooms: 1,
        visualizePathStyle: {
          stroke: "#ff0000"
        }
      });
      return;
    }
    const n = e.attackController(r);
    if (n === OK) {
      if (r.owner) {
        e.say("💥 Strike!");
        e.suicide();
      } else if (r.reservation) {
        e.say("⚔️ Unreserve");
      }
    }
  },
  moveToAvoidingBlacklist: function(e, o, t = {}) {
    if (!e.memory.blacklistedRooms || e.memory.blacklistedRooms.length === 0) {
      return e.moveTo(o, t);
    }
    const r = [ {
      pos: o,
      range: t.range || 1
    } ];
    const n = PathFinder.search(e.pos, r, {
      maxOps: t.maxOps || 4e3,
      maxRooms: t.maxRooms || 16,
      plainCost: t.plainCost || 1,
      swampCost: t.swampCost || 5,
      roomCallback: this.getAvoidanceRoomCallback(e)
    });
    if (n.incomplete || !n.path || n.path.length === 0) {
      console.log(`[ControllerAttack] ${e.name}: Blacklist-aware path to ${o.roomName} incomplete, ` + `retrying with higher maxOps. Blacklisted: ${JSON.stringify(e.memory.blacklistedRooms)}`);
      const n = PathFinder.search(e.pos, r, {
        maxOps: 2e4,
        maxRooms: t.maxRooms || 16,
        plainCost: t.plainCost || 1,
        swampCost: t.swampCost || 5,
        roomCallback: this.getAvoidanceRoomCallback(e)
      });
      if (!n.incomplete && n.path && n.path.length > 0) {
        if (t.visualizePathStyle) e.room.visual.poly(n.path, t.visualizePathStyle);
        return e.move(e.pos.getDirectionTo(n.path[0]));
      }
      console.log(`[ControllerAttack] ${e.name}: No path to ${o.roomName} avoiding blacklist — holding position.`);
      return ERR_NO_PATH;
    }
    if (t.visualizePathStyle) {
      e.room.visual.poly(n.path, t.visualizePathStyle);
    }
    const m = n.path[0];
    if (e.memory.blacklistedRooms.includes(m.roomName)) {
      console.log(`[ControllerAttack] ${e.name}: ERROR — PathFinder routing through blacklisted room ${m.roomName}!`);
    }
    return e.move(e.pos.getDirectionTo(m));
  },
  clearAllMovementCache: function(e) {
    delete e.memory._move;
    delete e.memory._path;
    delete e.memory.pathToTarget;
    delete e.memory.destination;
    console.log(`[ControllerAttack] ${e.name}: Cleared all movement cache`);
  },
  handleRetreat: function(e) {
    if (!e.memory.retreatTarget) {
      e.memory.retreatTarget = e.memory.previousRoom || e.memory.homeRoom;
    }
    if (e.memory.blacklistedRooms && e.memory.blacklistedRooms.includes(e.room.name)) {
      const o = e.room.findExitTo(e.memory.retreatTarget);
      if (o !== ERR_NO_PATH && o !== ERR_INVALID_ARGS) {
        const t = e.pos.findClosestByPath(o);
        if (t) {
          e.moveTo(t, {
            visualizePathStyle: {
              stroke: "#ff0000",
              lineStyle: "solid"
            }
          });
          e.say("🏃 FLEE!");
          return;
        }
      }
      const t = Game.map.describeExits(e.room.name);
      for (const o in t) {
        const r = t[o];
        if (e.memory.blacklistedRooms && e.memory.blacklistedRooms.includes(r)) {
          continue;
        }
        const n = parseInt(o, 10);
        const m = e.pos.findClosestByPath(n);
        if (m) {
          e.moveTo(m, {
            visualizePathStyle: {
              stroke: "#ff0000",
              lineStyle: "solid"
            }
          });
          e.say("🏃 FLEE!");
          return;
        }
      }
      return;
    }
    const o = Math.min(e.pos.x, e.pos.y, 49 - e.pos.x, 49 - e.pos.y);
    if (o < 5) {
      e.moveTo(new RoomPosition(25, 25, e.room.name), {
        visualizePathStyle: {
          stroke: "#ffaa00",
          lineStyle: "dotted"
        }
      });
      e.say("🛡️ SAFE");
      return;
    }
    const t = e.body.some(e => e.type === HEAL && e.hits > 0);
    if (t && e.hits < e.hitsMax) {
      e.heal(e);
      e.say("🩹 HEAL");
      return;
    }
    if (!e.memory.retreatTimer) {
      e.memory.retreatTimer = Game.time;
    }
    const r = Game.time - e.memory.retreatTimer;
    if (r > 3) {
      delete e.memory.retreating;
      delete e.memory.retreatTarget;
      delete e.memory.retreatTimer;
      this.clearAllMovementCache(e);
      e.say("✅ REROUTE");
      console.log(`[ControllerAttack] ${e.name}: Retreat complete, rerouting to ${e.memory.targetRoom}. ` + `Blacklisted rooms: ${JSON.stringify(e.memory.blacklistedRooms)}`);
      this.moveToAvoidingBlacklist(e, new RoomPosition(25, 25, e.memory.targetRoom), {
        visualizePathStyle: {
          stroke: "#ff0000",
          lineStyle: "dashed"
        },
        range: 23
      });
    } else {
      e.say(`⏳ ${3 - r}`);
    }
  },
  checkForHostileTowers: function(e) {
    if (e.room.name === e.memory.targetRoom) {
      return false;
    }
    const o = e.room.controller;
    if (o) {
      if (o.owner && iff.isFriendlyUsername(o.owner.username)) {
        return false;
      }
      if (o.reservation && iff.isFriendlyUsername(o.reservation.username)) {
        return false;
      }
    }
    const t = e.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: e => {
        if (e.structureType !== STRUCTURE_TOWER) return false;
        return !iff.isFriendlyUsername(e.owner && e.owner.username);
      }
    });
    if (t.length > 0) {
      if (!e.memory.blacklistedRooms) {
        e.memory.blacklistedRooms = [];
      }
      if (!e.memory.blacklistedRooms.includes(e.room.name)) {
        e.memory.blacklistedRooms.push(e.room.name);
        this.clearAllMovementCache(e);
        const r = o && o.owner ? o.owner.username : "(none)";
        const n = o && o.reservation ? o.reservation.username : "(none)";
        const m = t.map(e => e.owner && e.owner.username || "(no owner)").join(", ");
        console.log(`[ControllerAttack] ${e.name}: Blacklisted room ${e.room.name} — hostile towers detected`);
        console.log(`[ControllerAttack]   ctrl.owner="${r}" ctrl.reservation="${n}"`);
        console.log(`[ControllerAttack]   hostile tower owners: [${m}]`);
      }
      return true;
    }
    return false;
  },
  getAvoidanceRoomCallback: function(e) {
    return function(o) {
      if (e.memory.blacklistedRooms && e.memory.blacklistedRooms.includes(o) && o !== e.memory.targetRoom) {
        console.log(`[ControllerAttack] ${e.name}: Blocking pathfinding through blacklisted room ${o}`);
        return false;
      }
      const t = new PathFinder.CostMatrix;
      const r = Game.rooms[o];
      if (r) {
        r.find(FIND_STRUCTURES).forEach(e => {
          if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) {
            t.set(e.pos.x, e.pos.y, 255);
          }
        });
      }
      return t;
    };
  }
};
module.exports = roleControllerAttacker;
