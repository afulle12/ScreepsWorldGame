// LLM: Read docs/codex.js before reviewing or changing this file.
// roleDemolition.js
// Role dispatch: memory.role === 'demolition' -> roleDemolition.run(creep).
// Console globals: orderDemolition, cancelDemolitionOrder, setDemolitionFocus, showDemolitionOrders
// Example: orderDemolition('W1N1', 'W2N2', 1) - Order demolition creep to dismantle structures
// Example: cancelDemolitionOrder('W1N1') - Cancel demolition order for room
// Example: setDemolitionFocus('W1N1', 'structureId') - Focus demolition on specific structure
// Example: showDemolitionOrders() - Display active demolition orders across rooms
// Example: require('roleDemolition').run(creep);
//    orderDemolition('E1S1', 'E2S2', 2) - Orders 2 demolition teams from E1S1 to demolish E2S2
//    orderDemolition('E1S1', 'E2S2', 2, 'controller') - Prioritize dismantling walls/ramparts within range 1 of the controller
//    orderDemolition('E1S1', 'E2S2', 2, 'wall') - Prioritize dismantling ALL STRUCTURE_WALL in the target room (mission ends when none remain)
//    orderDemolition('E1S1', 'E2S2', 2, 'rampart') - Prioritize dismantling ALL STRUCTURE_RAMPART in the target room (mission ends when none remain)
//    orderDemolition('E1S1', 'E2S2', 1, '2w2m') - Spawn a custom-body demolisher: 2 WORK, 2 MOVE
//    cancelDemolitionOrder('E2S2') - Cancels the demolition operation against E2S2
//    showDemolitionOrders() - Lists all active demolition orders in the console
//    setDemolitionFocus('E2S2', 'rampart')
//   - 'controller' -> dismantle ONLY walls/ramparts within range 1 of the target room controller; mission ends when the ring is clear.
//   - 'wall'       -> dismantle ONLY STRUCTURE_WALL in the target room; mission ends when the room has zero STRUCTURE_WALL.
//   - 'rampart'    -> dismantle ONLY STRUCTURE_RAMPART in the target room; mission ends when the room has zero STRUCTURE_RAMPART.
//   - Format is count + part alias, repeated with no separators: '2w2m', '5w3m1h', etc.
//   - Supported aliases: w=WORK, m=MOVE, c=CARRY, a=ATTACK, r=RANGED_ATTACK, h=HEAL, t=TOUGH, cl=CLAIM.
//   - Custom-body demolishers spawn exactly that body and do not wait for demolisher boosts.
const iff = require("iff");
const util = require("util");
const getRoomState = require("getRoomState");
const BANNED_ROOMS = [ "E8N49", "E9N51" ];
function isRoomBanned(e, o) {
  for (var r = 0; r < BANNED_ROOMS.length; r++) {
    if (BANNED_ROOMS[r] === e) return true;
  }
  if (o && o.memory.blacklistedRooms && o.memory.blacklistedRooms.indexOf(e) !== -1) {
    return true;
  }
  return false;
}

function logOnce(e, o, r) {
  if (!e.memory._logOnce) e.memory._logOnce = {};
  if (e.memory._logOnce[o]) return;
  e.memory._logOnce[o] = true;
  console.log(r);
}

function removeOrdersFromArray(e, o) {
  if (!e || !e.length) return false;
  var r = [];
  var t = false;
  for (var n = 0; n < e.length; n++) {
    var i = e[n];
    if (i && i.targetRoom === o) {
      t = true;
      continue;
    }
    r.push(i);
  }
  e.length = 0;
  for (var m = 0; m < r.length; m++) e.push(r[m]);
  return t;
}

global.setDemolitionFocus = function(e, o) {
  var r = [ "wall", "rampart", "controller" ];
  if (o && r.indexOf(o) === -1) {
    console.log('[Demolition] Invalid focus "' + o + '". Valid options: ' + r.join(", "));
    return;
  }
  var t = Memory.demolitionOrders;
  var n = false;
  if (t && t.length) {
    for (var i = 0; i < t.length; i++) {
      if (t[i] && t[i].targetRoom === e) {
        t[i].focus = o || null;
        n = true;
      }
    }
  }
  if (!n) {
    console.log("[Demolition] No active order found for " + e);
    return;
  }
  var m = 0;
  var a = getRoomState.creepIndex();
  var s = a && a.all ? a.all : [];
  for (var l = 0; l < s.length; l++) {
    var f = s[l];
    if (f.memory.role === "demolition" && f.memory.targetRoom === e) {
      f.memory.demolitionFocus = o || null;
      delete f.memory.targetId;
      m++;
    }
  }
  console.log("[Demolition] Focus for " + e + ' set to "' + (o || "default") + '" — ' + m + " creep(s) updated");
};
global.showDemolitionOrders = function() {
  var e = Memory.demolitionOrders;
  if (!e || !e.length) {
    console.log("[Demolition] No active demolition orders.");
    return;
  }
  console.log("[Demolition] Active orders (" + e.length + "):");
  for (var o = 0; o < e.length; o++) {
    var r = e[o];
    if (!r) continue;
    var t = [];
    var n = getRoomState.creepIndex();
    var i = n && n.all ? n.all : [];
    for (var m = 0; m < i.length; m++) {
      var a = i[m];
      if (a.memory.role === "demolition" && a.memory.targetRoom === r.targetRoom) {
        var s;
        if (a.memory.missionComplete) {
          s = "✅ done";
        } else if (a.memory.retreating) {
          s = "🏃 retreating";
        } else if (a.memory.needsBoost) {
          s = "⚗️ boosting";
        } else if (a.room.name === r.targetRoom) {
          var l = a.memory.targetId ? Game.getObjectById(a.memory.targetId) : null;
          s = "⚒️ " + (l ? l.structureType : "searching");
        } else {
          s = "🚶 " + a.room.name + " → " + r.targetRoom;
        }
        t.push(a.name + " [" + s + "]");
      }
    }
    var f = "  #" + (o + 1) + ": " + r.homeRoom + " → " + r.targetRoom;
    if (r.focus) f += " (focus: " + r.focus + ")";
    f += "\n       Creeps (" + t.length + "): ";
    f += t.length ? t.join(", ") : "none assigned";
    console.log(f);
  }
};
function purgeDemolitionMemory(e) {
  var o = false;
  if (Memory.demolitionOrders && Memory.demolitionOrders.length) {
    if (removeOrdersFromArray(Memory.demolitionOrders, e)) o = true;
  }
  return o;
}

function completeDemolitionMission(e, o, r) {
  e.memory.missionComplete = true;
  var t = o;
  if (!t) t = e.room.name;
  if (!Memory._demolitionCompleteLoggedAt) Memory._demolitionCompleteLoggedAt = {};
  if (Memory._demolitionCompleteLoggedAt[t] === Game.time) return;
  var n = purgeDemolitionMemory(t);
  if (n) {
    Memory._demolitionCompleteLoggedAt[t] = Game.time;
    var i = "[Demolition] Order complete: " + t;
    if (r) i = i + " (" + r + ")";
    console.log(i);
    var m = e.memory.homeRoom;
    if (m && Memory.boostManager && Memory.boostManager.orders && Memory.boostManager.orders[m] && Memory.boostManager.orders[m].demolisher) {
      var a = Memory.boostManager.orders[m].demolisher;
      a.stopping = true;
      a.active = false;
      console.log("[Demolition] Auto-stopping demolisher boost in " + m);
    }
  }
}

const isEdgeTile = util.isOnRoomEdge;
const nudgeOffRoomEdge = util.nudgeOffRoomEdge;
function getOrderForRoom(e) {
  var o = Memory.demolitionOrders;
  if (!o || !o.length) return null;
  for (var r = 0; r < o.length; r++) {
    var t = o[r];
    if (t && t.targetRoom === e) return t;
  }
  return null;
}

function parseDemolitionBodySpec(e) {
  if (typeof e !== "string") return null;
  var o = e.toLowerCase().replace(/\s+/g, "");
  if (!o) return null;
  var r = {
    w: WORK,
    m: MOVE,
    c: CARRY,
    a: ATTACK,
    r: RANGED_ATTACK,
    h: HEAL,
    t: TOUGH,
    cl: CLAIM
  };
  var t = [];
  var n = /(\d+)(cl|[wmcarht])/g;
  var i;
  var m = "";
  while ((i = n.exec(o)) !== null) {
    m += i[0];
    var a = parseInt(i[1], 10);
    var s = r[i[2]];
    if (!s || a <= 0) return null;
    for (var l = 0; l < a; l++) t.push(s);
    if (t.length > 50) return null;
  }
  if (m !== o || t.length === 0) return null;
  return t;
}

function findControllerRingTargets(e) {
  var o = [];
  if (!e || !e.controller) return o;
  var r = e.find(FIND_STRUCTURES, {
    filter: function(o) {
      if (o.structureType !== STRUCTURE_WALL && o.structureType !== STRUCTURE_RAMPART) return false;
      if (e.controller.pos.getRangeTo(o) <= 1) return true;
      return false;
    }
  });
  for (var t = 0; t < r.length; t++) o.push(r[t]);
  return o;
}

function findAllWalls(e) {
  var o = [];
  if (!e) return o;
  var r = e.find(FIND_STRUCTURES, {
    filter: function(e) {
      if (e.structureType === STRUCTURE_WALL) return true;
      return false;
    }
  });
  for (var t = 0; t < r.length; t++) o.push(r[t]);
  return o;
}

function findAllRamparts(e) {
  var o = [];
  if (!e) return o;
  var r = e.find(FIND_STRUCTURES, {
    filter: function(e) {
      if (e.structureType === STRUCTURE_RAMPART) return true;
      return false;
    }
  });
  for (var t = 0; t < r.length; t++) o.push(r[t]);
  return o;
}

function isFocusTarget(e, o) {
  if (!e) return true;
  if (e === "wall") return o.structureType === STRUCTURE_WALL;
  if (e === "rampart") return o.structureType === STRUCTURE_RAMPART;
  if (e === "controller") {
    return o.structureType === STRUCTURE_WALL || o.structureType === STRUCTURE_RAMPART;
  }
  return true;
}

const roleDemolition = {
  run: function(e) {
    this.runDemolisher(e);
  },
  runDemolisher: function(e) {
    var o = e.memory.targetRoom;
    var r = e.memory.homeRoom;
    if (e.memory._path || e.memory.pathToTarget || e.memory.destination) {
      delete e.memory._path;
      delete e.memory.pathToTarget;
      delete e.memory.destination;
    }
    if (e.memory.missionComplete) {
      if (isEdgeTile(e.pos)) nudgeOffRoomEdge(e);
      return;
    }
    if (e.memory.forceNewPath) {
      delete e.memory.forceNewPath;
      console.log(`[Demolition] ${e.name}: Forcing new pathfinding calculation`);
    }
    if (!e.memory.previousRoom) {
      e.memory.previousRoom = e.room.name;
    }
    if (isEdgeTile(e.pos) && e.room.name === o) {
      nudgeOffRoomEdge(e);
      return;
    }
    if (e.memory.retreating) {
      return this.handleRetreat(e);
    }
    const t = this.checkForHostileTowers(e);
    if (t) {
      e.say("🚨 RETREAT!");
      e.memory.retreating = true;
      e.memory.retreatTarget = e.memory.previousRoom || r;
      this.clearAllMovementCache(e);
      return this.handleRetreat(e);
    }
    if (e.memory.previousRoom !== e.room.name) {
      e.memory.previousRoom = e.room.name;
    }
    if (isRoomBanned(e.room.name, e) && e.room.name !== o) {
      e.say("BAN");
      e.memory.retreating = true;
      e.memory.retreatTarget = r;
      this.clearAllMovementCache(e);
      return this.handleRetreat(e);
    }
    var n = e.memory.demolitionFocus;
    if (!n) {
      var i = getOrderForRoom(o);
      if (i && i.focus) n = i.focus;
      if (n) e.memory.demolitionFocus = n;
    }
    if (o && e.room.name !== o) {
      this.moveToAvoidingBlacklist(e, new RoomPosition(25, 25, o), {
        range: 23
      });
      e.say(`⚒️ ${o}`);
      return;
    }
    var m = Game.rooms[o];
    if (m && m.controller && m.controller.owner) {
      if (m.controller.my) {
        logOnce(e, "abortOwn:" + o, "[Demolisher] " + e.name + ": Aborting - " + o + " is our own room");
        completeDemolitionMission(e, o, "target is now owned by us");
        e.suicide();
        return;
      }
      if (iff.IFF_WHITELIST && iff.IFF_WHITELIST.indexOf(m.controller.owner.username) !== -1) {
        logOnce(e, "abortAlly:" + o, "[Demolisher] " + e.name + ": Aborting - " + o + " is owned by ally " + m.controller.owner.username);
        completeDemolitionMission(e, o, "target is now owned by an ally");
        e.suicide();
        return;
      }
    }
    const a = e.body.some(e => e.type === HEAL && e.hits > 0);
    if (a && e.hits < e.hitsMax) {
      e.heal(e);
      e.say("🩹 HEAL");
    }
    if (e.memory.targetId && Game.time % 5 !== 0) {
      const o = Game.getObjectById(e.memory.targetId);
      if (o) {
        if (!isFocusTarget(n, o)) {
          delete e.memory.targetId;
        } else {
          this.dismantleTarget(e, o);
          return;
        }
      } else {
        delete e.memory.targetId;
      }
    }
    let s = null;
    if (n === "wall") {
      if (!m) {
        e.moveTo(new RoomPosition(25, 25, o), {
          maxRooms: 1,
          range: 20
        });
        e.say("WALL");
        return;
      }
      const r = findAllWalls(m);
      if (r.length > 0) {
        s = e.pos.findClosestByPath(r) || e.pos.findClosestByRange(r);
        if (s) {
          e.memory.targetId = s.id;
          e.say("WALL");
          this.dismantleTarget(e, s);
          return;
        }
      }
      completeDemolitionMission(e, o, "wall");
      e.say("DONE");
      return;
    }
    if (n === "rampart") {
      if (!m) {
        e.moveTo(new RoomPosition(25, 25, o), {
          maxRooms: 1,
          range: 20
        });
        e.say("RAMP");
        return;
      }
      const r = findAllRamparts(m);
      if (r.length > 0) {
        s = e.pos.findClosestByPath(r) || e.pos.findClosestByRange(r);
        if (s) {
          e.memory.targetId = s.id;
          e.say("🛡️ RAM");
          this.dismantleTarget(e, s);
          return;
        }
      }
      completeDemolitionMission(e, o, "rampart");
      e.say("DONE");
      return;
    }
    if (n === "controller") {
      if (!m) {
        e.moveTo(new RoomPosition(25, 25, o), {
          maxRooms: 1,
          range: 20
        });
        e.say("CTR");
        return;
      }
      const r = findControllerRingTargets(m);
      if (r.length > 0) {
        s = e.pos.findClosestByPath(r) || e.pos.findClosestByRange(r);
        if (s) {
          e.memory.targetId = s.id;
          e.say("CTR");
          this.dismantleTarget(e, s);
          return;
        }
      }
      completeDemolitionMission(e, o, "controller");
      e.say("DONE");
      return;
    }
    if (m) {
      const o = m.find(FIND_HOSTILE_STRUCTURES, {
        filter: e => e.structureType === STRUCTURE_RAMPART
      });
      if (o.length > 0) {
        s = e.pos.findClosestByPath(o) || e.pos.findClosestByRange(o);
        if (s) {
          e.memory.targetId = s.id;
          e.say("RAM");
          this.dismantleTarget(e, s);
          return;
        }
      }
      const r = m.find(FIND_HOSTILE_STRUCTURES, {
        filter: e => e.structureType !== STRUCTURE_CONTROLLER
      });
      if (r.length > 0) {
        s = e.pos.findClosestByPath(r) || e.pos.findClosestByRange(r);
        if (s) {
          e.memory.targetId = s.id;
          e.say("DIS");
          this.dismantleTarget(e, s);
          return;
        }
      }
    }
    completeDemolitionMission(e, o, "cleared");
    e.say("DONE");
  },
  dismantleTarget: function(e, o) {
    const r = e.dismantle(o);
    if (r === ERR_NOT_IN_RANGE) {
      const r = e.moveTo(o, {
        reusePath: 10,
        range: 1
      });
      if (r === ERR_NO_PATH) {
        const wallRoomCallback = () => {
          const o = new PathFinder.CostMatrix;
          const r = Game.rooms[e.room.name];
          if (r) {
            r.find(FIND_STRUCTURES).forEach(e => {
              if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) {
                o.set(e.pos.x, e.pos.y, 1);
              }
            });
          }
          return o;
        };
        const r = PathFinder.search(e.pos, {
          pos: o.pos,
          range: 1
        }, {
          maxOps: 1e3,
          plainCost: 1,
          swampCost: 5,
          roomCallback: wallRoomCallback
        });
        const t = [];
        for (const o of r.path) {
          const r = e.room.lookForAt(LOOK_STRUCTURES, o.x, o.y);
          for (const e of r) {
            if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) {
              t.push(e);
            }
          }
        }
        if (t.length) {
          o = t.reduce((e, o) => o.hits < e.hits ? o : e, t[0]);
          e.memory.targetId = o.id;
          e.say("🪨 BUST");
          e.moveTo(o, {
            reusePath: 10,
            range: 1
          });
        }
      }
    } else if (r === ERR_NO_BODYPART) {
      logOnce(e, "noWork:" + e.name, "[Demolition] " + e.name + ": Cannot dismantle (no WORK parts)");
      e.say("WORK");
    }
  },
  moveToAvoidingBlacklist: function(e, o, r = {}) {
    const t = e.memory.blacklistedRooms && e.memory.blacklistedRooms.length > 0;
    const n = BANNED_ROOMS && BANNED_ROOMS.length > 0;
    if (!t && !n) {
      return e.moveTo(o, r);
    }
    const i = o.pos || o;
    const m = [ {
      pos: i,
      range: r.range || 1
    } ];
    const a = PathFinder.search(e.pos, m, {
      maxOps: r.maxOps || 4e3,
      maxRooms: r.maxRooms || 16,
      plainCost: r.plainCost || 1,
      swampCost: r.swampCost || 5,
      roomCallback: this.getAvoidanceRoomCallback(e)
    });
    if (a.incomplete) {
      console.log(`[Demolition] ${e.name}: PathFinder incomplete, avoiding: ${JSON.stringify(e.memory.blacklistedRooms)} / ${JSON.stringify(BANNED_ROOMS)}`);
    }
    if (a.path && a.path.length > 0) {
      const o = a.path[0];
      const r = e.pos.getDirectionTo(o);
      if (isRoomBanned(o.roomName, e)) {
        console.log(`[Demolition] ${e.name}: ERROR - PathFinder trying to go to banned room ${o.roomName}!`);
        return ERR_NO_PATH;
      }
      return e.move(r);
    }
    return ERR_NO_PATH;
  },
  clearAllMovementCache: function(e) {
    delete e.memory._move;
    delete e.memory._path;
    delete e.memory.pathToTarget;
    delete e.memory.destination;
    e.memory.forceNewPath = true;
    console.log(`[Demolition] ${e.name}: Cleared all movement cache`);
  },
  handleRetreat: function(e) {
    if (!e.memory.retreatTarget) {
      e.memory.retreatTarget = e.memory.previousRoom || e.memory.homeRoom;
    }
    if (isRoomBanned(e.room.name, e)) {
      const o = e.room.findExitTo(e.memory.retreatTarget);
      if (o !== ERR_NO_PATH && o !== ERR_INVALID_ARGS) {
        const r = e.pos.findClosestByPath(o);
        if (r) {
          e.moveTo(r);
          e.say("🏃 FLEE!");
          return;
        }
      }
      const r = Game.map.describeExits(e.room.name);
      for (const o in r) {
        const t = r[o];
        if (isRoomBanned(t, e)) continue;
        const n = parseInt(o, 10);
        const i = e.pos.findClosestByPath(n);
        if (i) {
          e.moveTo(i);
          e.say("🏃 FLEE!");
          return;
        }
      }
      return;
    }
    const o = Math.min(e.pos.x, e.pos.y, 49 - e.pos.x, 49 - e.pos.y);
    if (o < 5) {
      const o = new RoomPosition(25, 25, e.room.name);
      e.moveTo(o);
      e.say("🛡️ SAFE");
      return;
    }
    const r = e.body.some(e => e.type === HEAL && e.hits > 0);
    if (r && e.hits < e.hitsMax) {
      e.heal(e);
      e.say("🩹 HEAL");
      return;
    }
    if (!e.memory.retreatTimer) {
      e.memory.retreatTimer = Game.time;
    }
    if (Game.time - e.memory.retreatTimer > 3) {
      delete e.memory.retreating;
      delete e.memory.retreatTarget;
      delete e.memory.retreatTimer;
      this.clearAllMovementCache(e);
      e.say("✅ READY");
      console.log(`[Demolition] Creep ${e.name} finished retreating.`);
    } else {
      e.say(`⏳ ${3 - (Game.time - e.memory.retreatTimer)}`);
    }
  },
  checkForHostileTowers: function(e) {
    if (e.room.name === e.memory.targetRoom) {
      return false;
    }
    const o = e.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: e => {
        if (e.structureType !== STRUCTURE_TOWER) return false;
        if (e.owner && iff.IFF_WHITELIST.includes(e.owner.username)) return false;
        return true;
      }
    });
    if (o.length > 0) {
      if (!e.memory.blacklistedRooms) {
        e.memory.blacklistedRooms = [];
      }
      if (e.memory.blacklistedRooms.indexOf(e.room.name) === -1) {
        e.memory.blacklistedRooms.push(e.room.name);
        this.clearAllMovementCache(e);
        console.log(`[Demolition] Creep ${e.name} blacklisted room ${e.room.name} due to hostile towers`);
      }
      return true;
    }
    return false;
  },
  getAvoidanceRoomCallback: function(e) {
    return function(o) {
      if (isRoomBanned(o, e) && o !== e.memory.targetRoom) {
        return false;
      }
      const r = new PathFinder.CostMatrix;
      const t = Game.rooms[o];
      if (t) {
        t.find(FIND_STRUCTURES).forEach(e => {
          if (e.structureType === STRUCTURE_ROAD) {
            r.set(e.pos.x, e.pos.y, 1);
            return;
          }
          if (e.structureType === STRUCTURE_CONTAINER) {
            return;
          }
          if (e.structureType === STRUCTURE_RAMPART) {
            if (e.my || e.isPublic) return;
            r.set(e.pos.x, e.pos.y, 255);
            return;
          }
          r.set(e.pos.x, e.pos.y, 255);
        });
      }
      return r;
    };
  }
};
module.exports = roleDemolition;
global.orderDemolition = function(e, o, r, t) {
  var n = r === undefined ? 1 : r;
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[Demolition] Invalid home room: " + e + ". Must be a room you own.";
  }
  if (!o || n <= 0) {
    return "[Demolition] Invalid order. Use: orderDemolition('homeRoomName', 'targetRoomName', teamCount, [focus])";
  }
  var i = Game.rooms[o];
  if (i && i.controller && i.controller.owner) {
    if (iff && typeof iff.isAlly === "function" && iff.isAlly(i.controller.owner.username)) {
      return "[Demolition] Cannot demolish " + o + " - it's owned by ally " + i.controller.owner.username;
    }
    if (i.controller.my) {
      return "[Demolition] Cannot demolish " + o + " - it's your own room!";
    }
  }
  if (!Memory.demolitionOrders) Memory.demolitionOrders = [];
  var m = Memory.demolitionOrders.find(function(e) {
    return e.targetRoom === o;
  });
  if (m) {
    return "[Demolition] An operation against " + o + " is already active. Cancel it first to create a new one.";
  }
  var a = null;
  var s = null;
  var l = null;
  if (typeof t === "string") {
    var f = t.toLowerCase();
    if (f === "controller") {
      a = "controller";
    } else if (f === "wall") {
      a = "wall";
    } else if (f === "rampart") {
      a = "rampart";
    } else {
      l = parseDemolitionBodySpec(t);
      if (!l) {
        return "[Demolition] Invalid focus/body spec '" + t + "'. Use focus: controller, wall, rampart; or body spec like '2w2m'.";
      }
      s = f.replace(/\s+/g, "");
    }
  }
  Memory.demolitionOrders.push({
    homeRoom: e,
    targetRoom: o,
    teamCount: parseInt(n, 10),
    teamsSpawned: 0,
    //           'wall' dismantles ONLY STRUCTURE_WALL until none remain
    focus: a,
    body: l,
    bodySpec: s
  });
  return "[Demolition] Order placed for " + n + " demolition team(s) to demolish " + o + " from " + e + (a ? " with focus='" + a + "'" : "") + (s ? " with body='" + s + "'" : "") + ".";
};
global.cancelDemolitionOrder = function(e) {
  if (!e) {
    return "[Demolition] Invalid command. Use: cancelDemolitionOrder('targetRoomName')";
  }
  if (!Memory.demolitionOrders || Memory.demolitionOrders.length === 0) {
    return "[Demolition] No active demolition orders to cancel.";
  }
  var o = Memory.demolitionOrders.findIndex(function(o) {
    return o.targetRoom === e;
  });
  if (o > -1) {
    Memory.demolitionOrders.splice(o, 1);
    return "[Demolition] Operation against " + e + " has been cancelled. Existing demolition teams will not be replaced.";
  } else {
    return "[Demolition] No active operation found for target room " + e + ".";
  }
};
