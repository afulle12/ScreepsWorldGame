// LLM: Read docs/codex.js before reviewing or changing this file.
// roleSquad.js
// Role dispatch: memory.role === 'squad' -> roleSquad.run(creep).
// Console globals: orderSquad, cancelSquadOrders
// Example: orderSquad('W1N1', 'W2N2', 'quad') - Spawn and dispatch coordinated combat squad
// Example: cancelSquadOrders('W1N1') - Cancel active squad combat orders
// Example: require('roleSquad').run(creep);
/*
 * roleSquad.js
 */
var iff = require("iff");
var getRoomState = require("getRoomState");
var roleSquad = {
  formationVectors: [ {
    x: 0,
    y: 0
  }, {
    x: 1,
    y: 0
  }, {
    x: 0,
    y: 1
  }, {
    x: 1,
    y: 1
  } ],
  run: function(e) {
    if (!e.memory.squadId) return;
    if (!e.memory.spawnRoom) e.memory.spawnRoom = e.room.name;
    if (!e.memory.targetRoom) return;
    var r = this.getSquadMembers(e);
    var o = this.checkAllPresent(r);
    var a = e.room.name === e.memory.spawnRoom;
    if (a && !o) {
      if (Game.time % 5 === 0) e.say("Wait");
      return;
    }
    var t = this.getActingLeader(r);
    if (!t) return;
    if (e.id === t.id && Game.time % 10 === 0) {
      console.log("Squad " + e.memory.squadId + " Leader: " + t.name);
    }
    if (!this.checkAllSpawned(r)) {
      e.say("Spawn");
      return;
    }
    this.handleCombat(e, r, t);
    if (e.id === t.id) {
      this.handleLeaderLogic(e, r, o);
    } else {
      this.handleFollowerLogic(e, r, t, o);
    }
  },
  getActingLeader: function(e) {
    for (var r = 0; r < 4; r++) {
      if (e[r]) return e[r];
    }
    return null;
  },
  checkAllPresent: function(e) {
    for (var r = 0; r < 4; r++) {
      if (!e[r]) return false;
    }
    return true;
  },
  checkAllSpawned: function(e) {
    for (var r = 0; r < 4; r++) {
      if (e[r] && e[r].spawning) return false;
    }
    return true;
  },
  checkAllInSameRoom: function(e) {
    var r = null;
    for (var o = 0; o < 4; o++) {
      if (e[o]) {
        if (!r) r = e[o].room.name;
        if (e[o].room.name !== r) return false;
      }
    }
    return true;
  },
  getSquadMembers: function(e) {
    var r = [ null, null, null, null ];
    var o = getRoomState.creepIndex();
    var a = o && o.all ? o.all : [];
    for (var t = 0; t < a.length; t++) {
      var n = a[t];
      if (n.memory.squadId === e.memory.squadId && n.memory.quadPos !== undefined) {
        r[n.memory.quadPos] = n;
      }
    }
    return r;
  },
  getCreepAhead: function(e, r, o) {
    var a = [];
    for (var t = 0; t < 4; t++) {
      if (r[t]) a.push(r[t]);
    }
    for (var t = 0; t < a.length; t++) {
      if (a[t].id === e.id) {
        return t > 0 ? a[t - 1] : o;
      }
    }
    return o;
  },
  handleCombat: function(e, r, o) {
    var a = null;
    var t = Infinity;
    for (var n = 0; n < 4; n++) {
      var i = r[n];
      if (i && e.pos.getRangeTo(i) <= 1) {
        var s = this.getTowerDamageAt(i.pos, i.room.name);
        var f = i.hits - s;
        if (f < t) {
          t = f;
          a = i;
        }
      }
    }
    if (a && a.hits < a.hitsMax) {
      e.heal(a);
    } else if (e.hits < e.hitsMax) {
      e.heal(e);
    }
    var u = null;
    if (o && o.memory.breachId) {
      var m = Game.getObjectById(o.memory.breachId);
      if (m && e.pos.inRangeTo(m, 3)) {
        u = m;
      }
    }
    if (!u) {
      var v = e.room.find(FIND_HOSTILE_CREEPS, {
        filter: function(e) {
          return iff.isHostileCreep(e);
        }
      });
      u = e.pos.findClosestByRange(v);
    }
    if (!u) {
      var T = e.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(e) {
          return e.structureType !== STRUCTURE_CONTROLLER && e.structureType !== STRUCTURE_POWER_BANK;
        }
      });
      u = e.pos.findClosestByRange(T);
    }
    if (u) {
      var l = e.pos.getRangeTo(u);
      if (l <= 3) e.rangedAttack(u);
      if (l <= 1) {
        e.attack(u);
      }
    }
  },
  getTowerDamageAt: function(e, r) {
    var o = Game.rooms[r];
    if (!o) return 0;
    var a = o.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(e) {
        return e.structureType === STRUCTURE_TOWER;
      }
    });
    var t = 0;
    for (var n = 0; n < a.length; n++) {
      var i = a[n];
      var s = i.pos.getRangeTo(e);
      var f = 600;
      if (s > 5) f = 600 - 300 * ((s - 5) / 45);
      t += f;
    }
    return t;
  },
  isInSafeZone: function(e) {
    var r = e.pos;
    return r.x >= 3 && r.x <= 46 && r.y >= 3 && r.y <= 46;
  },
  isNearTargetExit: function(e, r) {
    var o = Game.map.findExit(e.room, r);
    if (o === ERR_NO_PATH) return false;
    var a = e.pos;
    if (o === TOP && a.y <= 3) return true;
    if (o === BOTTOM && a.y >= 46) return true;
    if (o === LEFT && a.x <= 3) return true;
    if (o === RIGHT && a.x >= 46) return true;
    return false;
  },
  findBestAttackTarget: function(e) {
    var r = e.room.find(FIND_HOSTILE_CREEPS, {
      filter: function(e) {
        return iff.isHostileCreep(e);
      }
    });
    if (r.length > 0) {
      return e.pos.findClosestByRange(r);
    }
    var o = e.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(e) {
        return e.structureType !== STRUCTURE_CONTROLLER && e.structureType !== STRUCTURE_POWER_BANK;
      }
    });
    if (o.length > 0) {
      return e.pos.findClosestByRange(o);
    }
    return null;
  },
  handleLeaderLogic: function(e, r, o) {
    if (e.memory.breachId) {
      var a = Game.getObjectById(e.memory.breachId);
      if (!a) delete e.memory.breachId;
    }
    var t = e.room.name === e.memory.spawnRoom;
    var n = e.memory.targetRoom;
    var i = e.room.name === n;
    var s = this.isNearTargetExit(e, n);
    var f = this.checkAllInSameRoom(r);
    var u = t || s && !i || !f && !i;
    e.memory.trainMode = u;
    if (!o && !t) {
      e.say("Broken");
      e.memory.trainMode = false;
      if (i) {
        var m = this.findBestAttackTarget(e);
        if (m) e.moveTo(m, {
          reusePath: 5
        });
      } else {
        e.moveTo(new RoomPosition(25, 25, n), {
          reusePath: 20
        });
      }
      return;
    }
    if (u) {
      if (this.moveAsTrain(e, r, n)) {
        if (t) e.say("Train"); else if (!f) e.say("Cross"); else e.say("Exit");
        return;
      }
      e.say("Detour");
    }
    if (!f && i) {
      e.say("Wait");
      if (!this.isInSafeZone(e)) {
        e.moveTo(new RoomPosition(25, 25, e.room.name), {
          reusePath: 5
        });
      }
      return;
    }
    for (var v = 0; v < 4; v++) {
      if (r[v] && r[v].fatigue > 0) {
        e.say("Tired");
        return;
      }
    }
    var T = this.isInSafeZone(e);
    var l = new RoomPosition(25, 25, e.room.name);
    if (!T && !s && !i) {
      e.say("Enter");
      for (var v = 0; v < 4; v++) {
        if (r[v]) r[v].moveTo(l, {
          reusePath: 0
        });
      }
      return;
    }
    if (!e.memory.snakeMode) {
      if (!this.checkFormation(r)) {
        if (this.isAreaClearForQuad(e, e.pos)) {
          e.say("Form");
          this.reformSquad(e, r);
        } else {
          e.say("Nudge");
          var d = this.findValidFormationSpot(e);
          if (d) {
            e.moveTo(d, {
              reusePath: 0
            });
          } else {
            e.say("ForceSnake");
            e.memory.snakeMode = true;
          }
        }
        return;
      }
    }
    if (i) {
      e.say("Attack");
      var R = this.findBestAttackTarget(e);
      if (R) {
        this.moveQuadWithPathfinding(e, r, R.pos, true);
      } else {
        e.say("Clear");
        e.memory.snakeMode = false;
      }
    } else {
      e.say("Move");
      var y = Game.map.findExit(e.room, n);
      if (y !== ERR_NO_PATH) {
        var h = e.pos.findClosestByPath(y);
        if (!h) h = e.pos.findClosestByRange(y);
        if (h) {
          this.moveQuadWithPathfinding(e, r, h, false);
        }
      }
    }
  },
  handleFollowerLogic: function(e, r, o, a) {
    if (!o) return;
    if (!a) {
      e.say("Follow");
      e.moveTo(o, {
        reusePath: 1
      });
      return;
    }
    var t = e.room.name !== o.room.name;
    var n = o.memory.trainMode;
    var i = o.memory.snakeMode;
    if (t) {
      if (n) {
        e.say("Fwd");
        e.moveTo(new RoomPosition(25, 25, e.memory.targetRoom), {
          reusePath: 0,
          ignoreCreeps: true
        });
      } else {
        e.say("Catch");
        var s = this.getCreepAhead(e, r, o);
        e.moveTo(s, {
          reusePath: 0,
          ignoreCreeps: true
        });
      }
      return;
    }
    if (n || i) {
      e.say(n ? "Train" : "Snake");
      var s = this.getCreepAhead(e, r, o);
      e.moveTo(s, {
        reusePath: 0,
        ignoreCreeps: true
      });
      return;
    }
    var f = o.pos.x >= 3 && o.pos.x <= 46 && o.pos.y >= 3 && o.pos.y <= 46;
    var u = e.room.name === e.memory.targetRoom;
    if (!f && !u) {
      e.say("Trail");
      e.moveTo(o, {
        reusePath: 0
      });
      return;
    }
    if (!this.isAreaClearForQuad(o, o.pos)) {
      e.say("Blocked");
      e.moveTo(o, {
        reusePath: 0
      });
      return;
    }
    var m = this.formationVectors[e.memory.quadPos];
    var v = o.pos.x + m.x;
    var T = o.pos.y + m.y;
    if (e.pos.x !== v || e.pos.y !== T) {
      e.say("Form");
      e.moveTo(new RoomPosition(v, T, o.room.name), {
        reusePath: 0
      });
    }
  },
  moveAsTrain: function(e, r, o) {
    e.memory.snakeMode = false;
    var a = Game.map.findExit(e.room, o);
    if (a === ERR_NO_PATH) {
      e.memory.trainMode = false;
      return false;
    }
    var t = e.pos;
    if (a === FIND_EXIT_TOP && t.y === 0 || a === FIND_EXIT_BOTTOM && t.y === 49 || a === FIND_EXIT_LEFT && t.x === 0 || a === FIND_EXIT_RIGHT && t.x === 49) {
      e.memory.trainMode = true;
      e.move(a);
      return true;
    }
    var n = e.moveTo(new RoomPosition(25, 25, o), {
      reusePath: 0,
      ignoreCreeps: true
    });
    if (n !== ERR_NO_PATH) {
      e.memory.trainMode = true;
      return true;
    }
    var i = e.pos.findClosestByPath(a);
    if (i) {
      e.memory.trainMode = true;
      e.moveTo(i, {
        reusePath: 0,
        ignoreCreeps: true
      });
      return true;
    }
    e.memory.trainMode = false;
    return false;
  },
  checkFormation: function(e) {
    var r = e[0];
    var o = e[1];
    var a = e[2];
    var t = e[3];
    if (!r || !o || !a || !t) return false;
    if (o.pos.x !== r.pos.x + 1 || o.pos.y !== r.pos.y) return false;
    if (a.pos.x !== r.pos.x || a.pos.y !== r.pos.y + 1) return false;
    if (t.pos.x !== r.pos.x + 1 || t.pos.y !== r.pos.y + 1) return false;
    if (o.pos.roomName !== r.pos.roomName) return false;
    return true;
  },
  reformSquad: function(e, r) {
    for (var o = 0; o < 4; o++) {
      var a = r[o];
      if (!a || a.id === e.id) continue;
      var t = this.formationVectors[o];
      var n = e.pos.x + t.x;
      var i = e.pos.y + t.y;
      if (a.pos.x !== n || a.pos.y !== i) {
        a.moveTo(new RoomPosition(n, i, e.room.name), {
          reusePath: 0
        });
      }
    }
  },
  isAreaClearForQuad: function(e, r) {
    if (!r) r = e.pos;
    var o = Game.map.getRoomTerrain(e.room.name);
    for (var a = 0; a < 4; a++) {
      var t = this.formationVectors[a];
      var n = r.x + t.x;
      var i = r.y + t.y;
      if (n < 1 || n > 48 || i < 1 || i > 48) return false;
      if (o.get(n, i) === TERRAIN_MASK_WALL) return false;
      var s = new RoomPosition(n, i, e.room.name);
      var f = s.lookFor(LOOK_STRUCTURES);
      for (var u = 0; u < f.length; u++) {
        var m = f[u];
        if (m.structureType !== STRUCTURE_ROAD && m.structureType !== STRUCTURE_CONTAINER && m.structureType !== STRUCTURE_RAMPART) {
          return false;
        }
      }
    }
    return true;
  },
  findValidFormationSpot: function(e) {
    var r = e.pos;
    for (var o = -1; o <= 1; o++) {
      for (var a = -1; a <= 1; a++) {
        if (o === 0 && a === 0) continue;
        var t = r.x + o;
        var n = r.y + a;
        if (t < 1 || t > 48 || n < 1 || n > 48) continue;
        var i = new RoomPosition(t, n, e.room.name);
        if (this.isAreaClearForQuad(e, i)) {
          return i;
        }
      }
    }
    return null;
  },
  moveQuadWithPathfinding: function(e, r, o, a) {
    if (e.pos.getRangeTo(o) <= 1) {
      e.say("AtGoal");
      return;
    }
    if (e.memory.snakeMode) {
      if (!this.isAreaClearForQuad(e, e.pos)) {
        e.say("Snaking");
        e.moveTo(o, {
          reusePath: 0
        });
        return;
      }
    }
    var t = this.getQuadCostMatrix(e.room.name, a);
    var n = PathFinder.search(e.pos, {
      pos: o,
      range: 1
    }, {
      plainCost: 1,
      swampCost: 5,
      maxRooms: 1,
      maxOps: 4e3,
      roomCallback: function(r) {
        if (r === e.room.name) return t;
        return false;
      }
    });
    if (!n.incomplete && n.path.length > 0) {
      e.memory.snakeMode = false;
      var i = n.path[0];
      var s = e.pos.getDirectionTo(i);
      if (this.canQuadMove(r, s)) {
        for (var f = 0; f < 4; f++) {
          if (r[f]) r[f].move(s);
        }
      } else {
        this.tryAlternativeMove(e, r, o);
      }
      return;
    }
    var u = PathFinder.search(e.pos, {
      pos: o,
      range: 1
    }, {
      plainCost: 1,
      swampCost: 5,
      maxRooms: 1,
      maxOps: 4e3
    });
    if (!u.incomplete) {
      e.say("Snake");
      e.memory.snakeMode = true;
      e.moveTo(o, {
        reusePath: 0
      });
    } else {
      e.say("Breach");
      e.memory.snakeMode = false;
      var m = u.path.length > 0 ? u.path[u.path.length - 1] : e.pos;
      var v = m.findInRange(FIND_STRUCTURES, 1, {
        filter: function(e) {
          return e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART;
        }
      });
      if (v.length > 0) {
        var T = v.sort(function(e, r) {
          return e.pos.getRangeTo(o) - r.pos.getRangeTo(o);
        })[0];
        e.memory.breachId = T.id;
        e.moveTo(T, {
          reusePath: 0
        });
      }
    }
  },
  tryAlternativeMove: function(e, r, o) {
    var a = [ TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT ];
    var t = null;
    var n = Infinity;
    for (var i = 0; i < a.length; i++) {
      var s = a[i];
      if (this.canQuadMove(r, s)) {
        var f = this.getPosInDirection(e.pos, s);
        if (f) {
          var u = f.getRangeTo(o);
          if (u < n) {
            n = u;
            t = s;
          }
        }
      }
    }
    if (t !== null) {
      for (var m = 0; m < 4; m++) {
        if (r[m]) r[m].move(t);
      }
    } else {
      e.say("Stuck");
    }
  },
  getQuadCostMatrix: function(e, r) {
    var o = Game.rooms[e];
    if (!o) return new PathFinder.CostMatrix;
    var a = new PathFinder.CostMatrix;
    var t = o.getTerrain();
    for (var n = 0; n < 50; n++) {
      for (var i = 0; i < 50; i++) {
        var s = t.get(n, i);
        if (s === TERRAIN_MASK_WALL) {
          a.set(n, i, 255);
        } else if (s === TERRAIN_MASK_SWAMP) {
          a.set(n, i, 5);
        } else {
          a.set(n, i, 1);
        }
      }
    }
    var f = o.find(FIND_STRUCTURES);
    for (var u = 0; u < f.length; u++) {
      var m = f[u];
      if (m.structureType !== STRUCTURE_ROAD && m.structureType !== STRUCTURE_CONTAINER && (m.structureType !== STRUCTURE_RAMPART || !m.my)) {
        a.set(m.pos.x, m.pos.y, 255);
      }
    }
    var v = new PathFinder.CostMatrix;
    for (var n = 0; n < 50; n++) {
      for (var i = 0; i < 50; i++) {
        if (a.get(n, i) === 255) {
          v.set(n, i, 255);
          continue;
        }
        if (n >= 49 || i >= 49) {
          v.set(n, i, 255);
          continue;
        }
        var T = a.get(n + 1, i);
        var l = a.get(n, i + 1);
        var d = a.get(n + 1, i + 1);
        if (T === 255 || l === 255 || d === 255) {
          v.set(n, i, 255);
        } else {
          var R = Math.max(a.get(n, i), T, l, d);
          v.set(n, i, R);
        }
      }
    }
    if (r) {
      for (var u = 0; u < 50; u++) {
        v.set(u, 0, 255);
        v.set(u, 49, 255);
        v.set(0, u, 255);
        v.set(49, u, 255);
      }
    }
    return v;
  },
  canQuadMove: function(e, r) {
    for (var o = 0; o < 4; o++) {
      var a = e[o];
      if (!a) continue;
      var t = this.getPosInDirection(a.pos, r);
      if (!t) return false;
      var n = Game.map.getRoomTerrain(a.room.name);
      if (n.get(t.x, t.y) === TERRAIN_MASK_WALL) return false;
      var i = t.lookFor(LOOK_STRUCTURES);
      for (var s = 0; s < i.length; s++) {
        var f = i[s];
        if (f.structureType !== STRUCTURE_ROAD && f.structureType !== STRUCTURE_CONTAINER && (f.structureType !== STRUCTURE_RAMPART || !f.my)) return false;
      }
      var u = t.lookFor(LOOK_CREEPS);
      for (var m = 0; m < u.length; m++) {
        var v = u[m];
        var T = false;
        for (var l = 0; l < 4; l++) {
          if (e[l] && e[l].id === v.id) T = true;
        }
        if (!T) return false;
      }
    }
    return true;
  },
  getPosInDirection: function(e, r) {
    var o = e.x;
    var a = e.y;
    var t = e.roomName;
    if (r === TOP) a--;
    if (r === TOP_RIGHT) {
      o++;
      a--;
    }
    if (r === RIGHT) o++;
    if (r === BOTTOM_RIGHT) {
      o++;
      a++;
    }
    if (r === BOTTOM) a++;
    if (r === BOTTOM_LEFT) {
      o--;
      a++;
    }
    if (r === LEFT) o--;
    if (r === TOP_LEFT) {
      o--;
      a--;
    }
    if (o < 0 || o > 49 || a < 0 || a > 49) return null;
    return new RoomPosition(o, a, t);
  }
};
module.exports = roleSquad;
global.orderSquad = function(e, r) {
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[Squad] Invalid form room: " + e;
  }
  if (!r) return "[Squad] Target room required.";
  if (!Memory.squadOrders) Memory.squadOrders = [];
  Memory.squadOrders.push({
    homeRoom: e,
    targetRoom: r,
    spawnedCount: 0,
    squadId: "Squad_" + r + "_" + Game.time
  });
  return "[Squad] Order placed: Quad from " + e + " to attack " + r;
};
global.cancelSquadOrders = function() {
  Memory.squadOrders = [];
  return "[Squad] All squad orders cleared.";
};
