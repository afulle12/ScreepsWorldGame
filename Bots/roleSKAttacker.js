// LLM: Read docs/codex.js before reviewing or changing this file.
// roleSKAttacker.js
// Role dispatch: memory.role === 'skAttacker' -> roleSKAttacker.run(creep).
// Console globals: orderSKAttack, cancelSKAttack
// Example: orderSKAttack('E1N1', 'E1N2', 1) - Dispatch SK attacker to clear source keeper room
// Example: cancelSKAttack('E1N1', 'E1N2') - Cancel source keeper attack order
var getRoomState = require("getRoomState");
global.orderSKAttack = function(e, t, r) {
  if (!e || !t) {
    return "[SKAttack] Usage: global.orderSKAttack('spawnRoom', 'targetRoom', count)";
  }
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[SKAttack] Invalid spawn room: " + e + ". Must be a room you control.";
  }
  r = r || 1;
  if (!Memory.skAttackOrders) Memory.skAttackOrders = [];
  var o = Memory.skAttackOrders.find(function(e) {
    return e.targetRoom === t;
  });
  if (o) {
    o.count = r;
    o.spawnRoom = e;
    return "[SKAttack] Updated existing order for " + t + ": " + r + " attackers from " + e;
  }
  Memory.skAttackOrders.push({
    spawnRoom: e,
    targetRoom: t,
    count: r,
    active: true
  });
  console.log("[SKAttack] Order created: " + r + " attacker(s) from " + e + " -> " + t);
  return "[SKAttack] Order created: " + r + " attacker(s) from " + e + " -> " + t;
};
global.cancelSKAttack = function(e) {
  if (!Memory.skAttackOrders || Memory.skAttackOrders.length === 0) {
    return "[SKAttack] No active orders.";
  }
  var t = false;
  for (var r = Memory.skAttackOrders.length - 1; r >= 0; r--) {
    if (Memory.skAttackOrders[r].targetRoom === e) {
      Memory.skAttackOrders.splice(r, 1);
      t = true;
    }
  }
  if (t) {
    var o = getRoomState.creepIndex();
    var a = o && o.all ? o.all : [];
    for (var m = 0; m < a.length; m++) {
      var i = a[m];
      if (i.memory && i.memory.role === "skAttacker" && i.memory.targetRoom === e) {
        i.memory.noReplace = true;
      }
    }
    return "[SKAttack] Cancelled operation for " + e + ". Existing creeps will finish their lifespan.";
  }
  return "[SKAttack] No order found for " + e;
};
const roleSKAttacker = {
  RETREAT_HP_RATIO: .5,
  REENGAGE_HP_RATIO: .9,
  FLEE_RANGE: 7,
  run: function(e) {
    var t = e.memory.targetRoom;
    if (!e.memory.state) e.memory.state = "moving";
    if (e.memory._move && e.memory._move.room !== e.room.name) {
      delete e.memory._move;
    }
    if (e.pos.x === 0 || e.pos.x === 49 || e.pos.y === 0 || e.pos.y === 49) {
      delete e.memory._move;
      e.moveTo(new RoomPosition(25, 25, e.room.name), {
        maxRooms: 1,
        reusePath: 0
      });
      if (e.hits < e.hitsMax) e.heal(e);
      return;
    }
    this.tryHeal(e);
    this.updateState(e);
    switch (e.memory.state) {
     case "moving":
      this.stateMoving(e);
      break;
     case "fighting":
      this.stateFighting(e);
      break;
     case "retreating":
      this.stateRetreating(e);
      break;
     case "waiting":
      this.stateWaiting(e);
      break;
    }
  },
  tryHeal: function(e) {
    if (e.hits >= e.hitsMax) return;
    var t = e.body.some(function(e) {
      return e.type === HEAL && e.hits > 0;
    });
    if (!t) return;
    if (e.memory.state === "retreating" || e.memory.state === "waiting" || e.memory.state === "moving") {
      e.heal(e);
    }
  },
  updateState: function(e) {
    var t = e.hits / e.hitsMax;
    var r = e.memory.state;
    if (e.room.name !== e.memory.targetRoom) {
      if (e.memory.state === "retreating") {
        if (t >= this.REENGAGE_HP_RATIO) {
          e.memory.state = "moving";
          delete e.memory._move;
        }
        return;
      }
      if (e.memory.state !== "moving") {
        e.memory.state = "moving";
        delete e.memory._move;
      }
      return;
    }
    if (e.memory.state === "fighting" && t < this.RETREAT_HP_RATIO) {
      e.memory.state = "retreating";
      delete e.memory._move;
      e.say("🏃 RETREAT");
      return;
    }
    if (e.memory.state === "retreating" && t >= this.REENGAGE_HP_RATIO) {
      e.memory.state = "fighting";
      delete e.memory._move;
      delete e.memory.fleeTarget;
      e.say("⚔️ CHARGE");
      return;
    }
    if (e.memory.state === "waiting") {
      var o = e.room.find(FIND_HOSTILE_CREEPS);
      if (o.length > 0 && t >= this.REENGAGE_HP_RATIO) {
        e.memory.state = "fighting";
        delete e.memory._move;
        e.say("⚔️ FIGHT");
        return;
      }
    }
    if (e.memory.state === "moving" && e.room.name === e.memory.targetRoom) {
      delete e.memory._move;
      if (t >= this.REENGAGE_HP_RATIO) {
        e.memory.state = "fighting";
        e.say("⚔️ FIGHT");
      } else {
        e.memory.state = "retreating";
        e.say("🩹 HEAL UP");
      }
      return;
    }
  },
  stateMoving: function(e) {
    var t = e.memory.targetRoom;
    if (e.room.name === t) {
      return;
    }
    e.moveTo(new RoomPosition(25, 25, t), {
      visualizePathStyle: {
        stroke: "#ffaa00",
        lineStyle: "dashed"
      },
      range: 20,
      reusePath: 10
    });
    e.say("🚶 " + t);
  },
  stateFighting: function(e) {
    if (e.room.name !== e.memory.targetRoom) {
      e.memory.state = "moving";
      delete e.memory._move;
      return;
    }
    var t = this.findTarget(e);
    if (!t) {
      e.memory.state = "waiting";
      delete e.memory.targetId;
      e.say("👁️ PATROL");
      return;
    }
    e.memory.targetId = t.id;
    var r = e.attack(t);
    if (r === ERR_NOT_IN_RANGE) {
      e.moveTo(t, {
        visualizePathStyle: {
          stroke: "#ff0000"
        },
        reusePath: 3,
        maxRooms: 1
      });
      e.say("⚔️ CLOSE");
      if (e.hits < e.hitsMax) {
        e.heal(e);
      }
    } else if (r === OK) {
      e.say("💥 " + Math.round(t.hits / t.hitsMax * 100) + "%");
      if (e.hits < e.hitsMax) {
        e.heal(e);
      }
    }
  },
  stateRetreating: function(e) {
    if (e.hits < e.hitsMax) {
      e.heal(e);
    }
    if (e.room.name !== e.memory.targetRoom) {
      var t = e.hits / e.hitsMax;
      e.moveTo(new RoomPosition(25, 25, e.memory.targetRoom), {
        visualizePathStyle: {
          stroke: "#ffaa00",
          lineStyle: "dotted"
        },
        range: 20,
        reusePath: 5
      });
      e.say("🩹 " + Math.round(t * 100) + "%");
      return;
    }
    var r = Math.min(e.pos.x, e.pos.y, 49 - e.pos.x, 49 - e.pos.y);
    if (r < 5) {
      e.moveTo(new RoomPosition(25, 25, e.room.name), {
        visualizePathStyle: {
          stroke: "#ffaa00",
          lineStyle: "dotted"
        },
        maxRooms: 1,
        reusePath: 1
      });
      var t = e.hits / e.hitsMax;
      e.say("🛡️ " + Math.round(t * 100) + "%");
      return;
    }
    var o = e.room.find(FIND_HOSTILE_CREEPS);
    if (o.length === 0) {
      var t = e.hits / e.hitsMax;
      e.say("🩹 " + Math.round(t * 100) + "%");
      return;
    }
    var a = o.map(function(e) {
      return {
        pos: e.pos,
        range: 7
      };
    });
    var m = PathFinder.search(e.pos, a, {
      flee: true,
      maxRooms: 1,
      plainCost: 1,
      swampCost: 5,
      roomCallback: function(e) {
        var t = Game.rooms[e];
        if (!t) return new PathFinder.CostMatrix;
        var r = new PathFinder.CostMatrix;
        t.find(FIND_STRUCTURES).forEach(function(e) {
          if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) {
            r.set(e.pos.x, e.pos.y, 255);
          }
        });
        for (var o = 0; o < 50; o++) {
          r.set(o, 0, 200);
          r.set(o, 49, 200);
          r.set(0, o, 200);
          r.set(49, o, 200);
        }
        for (var a = 1; a < 49; a++) {
          r.set(a, 1, 50);
          r.set(a, 48, 50);
          r.set(1, a, 50);
          r.set(48, a, 50);
        }
        return r;
      }
    });
    if (m.path && m.path.length > 0) {
      var i = m.path[0];
      if (i.roomName !== e.room.name) {
        e.moveTo(new RoomPosition(25, 25, e.room.name), {
          maxRooms: 1,
          reusePath: 1
        });
      } else {
        e.move(e.pos.getDirectionTo(i));
      }
    }
    var t = e.hits / e.hitsMax;
    e.say("🩹 " + Math.round(t * 100) + "%");
  },
  stateWaiting: function(e) {
    if (e.room.name !== e.memory.targetRoom) {
      e.memory.state = "moving";
      delete e.memory._move;
      return;
    }
    var t = this.findTarget(e);
    if (t) {
      e.memory.state = "fighting";
      e.say("⚔️ FIGHT");
      return;
    }
    var r = e.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(e) {
        return e.structureType === STRUCTURE_KEEPER_LAIR;
      }
    });
    if (r.length === 0) {
      e.say("❓ NO LAIRS");
      return;
    }
    var o = null;
    var a = Infinity;
    for (var m = 0; m < r.length; m++) {
      var i = r[m].ticksToSpawn;
      if (i !== undefined && i !== null && i < a) {
        a = i;
        o = r[m];
      }
    }
    if (!o) {
      o = e.pos.findClosestByRange(r);
    }
    if (o) {
      var n = e.pos.getRangeTo(o);
      if (n > 4) {
        e.moveTo(o, {
          visualizePathStyle: {
            stroke: "#00ff00",
            lineStyle: "dotted"
          },
          range: 3,
          maxRooms: 1,
          reusePath: 5
        });
      }
      if (a < Infinity) {
        e.say("⏳ " + a);
      } else {
        e.say("👁️ WAIT");
      }
    }
    if (e.hits < e.hitsMax) {
      e.heal(e);
    }
  },
  findTarget: function(e) {
    if (e.memory.targetId && Game.time % 3 !== 0) {
      var t = Game.getObjectById(e.memory.targetId);
      if (t && t.pos && t.pos.roomName === e.room.name) {
        return t;
      }
      delete e.memory.targetId;
    }
    var r = e.room.find(FIND_HOSTILE_CREEPS, {
      filter: function(e) {
        return e.owner.username === "Source Keeper";
      }
    });
    if (r.length > 0) {
      var o = r.reduce(function(e, t) {
        return t.hits < e.hits ? t : e;
      }, r[0]);
      return o;
    }
    var a = e.room.find(FIND_HOSTILE_CREEPS, {
      filter: function(e) {
        return e.owner.username === "Invader";
      }
    });
    if (a.length > 0) {
      return e.pos.findClosestByRange(a);
    }
    return null;
  }
};
module.exports = roleSKAttacker;
