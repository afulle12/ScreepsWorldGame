// LLM: Read docs/codex.js before reviewing or changing this file.
// roleAttacker.js
// Role dispatch: memory.role === 'attacker' -> roleAttacker.run(creep).
// Console globals: orderAttack, assignAttackTarget, cancelAttackOrder, setAttackCount
// Example: orderAttack('W1N1', 'W2N2', 2) - Spawn and dispatch attackers to target room
// Example: assignAttackTarget('W1N1', 'id123') - Focus attacker focus on target structure/creep
// Example: cancelAttackOrder('W1N1') - Cancel active attack orders for room
// Example: setAttackCount('W1N1', 3) - Update desired attacker count for room
//   orderAttack(spawnRoom, targetRoom, count, ...options)  Spawn `count`
//     attackers in spawnRoom, rally there, then attack targetRoom. Optional
//     numeric X,Y set the target-room entry square. Flags (any order):
//     'sustain' keeps `count` alive indefinitely -- replacements spawn as
//     creeps die and travel straight to the target (no group rally), runs
//     until cancelAttackOrder() with no automatic stop; 'fast' uses the
//     fastAttacker body instead of the standard one.
//     E.g. orderAttack('E3N45','E3N44',5) one-shot wave of 5;
//     orderAttack('E3N45','E3N44',5,1,25) enter near west edge;
//     orderAttack('E3N45','E3N44',3,'sustain') maintain 3 until cancelled;
//     orderAttack('E3N45','E3N44',5,'sustain','fast',48,20) custom entry.
//   cancelAttackOrder(targetRoom)  Remove the order; for sustained orders
//     this stops respawning, living attackers keep fighting until they die.
//   setAttackCount(targetRoom, count)  Update the maintained count for a
//     sustained attack. Living attackers above the new count keep
//     fighting; replacements pause until the live count drops below it.
//   assignAttackTarget(roomName, targetId)  Point every attacker whose
//     targetRoom is roomName at a specific structure/creep id.
const iff = require("iff");
const getRoomState = require("getRoomState");
const navigationCache = {
  tick: -1,
  restrictedTiles: {},
  restrictedCoordinates: {},
  structureMatrices: {},
  hostileTowers: {},
  avoidancePaths: {}
};
global.orderAttack = function(e, t, o) {
  if (!e || !t || !o || o <= 0) {
    return "[Attack] Usage: global.orderAttack('spawnRoom', 'targetRoom', count, 'sustain'?, 'fast'?, x?, y?)";
  }
  var r = Array.prototype.slice.call(arguments, 3);
  var a = [];
  var s = [];
  for (var i = 0; i < r.length; i++) {
    var n = r[i];
    if (typeof n === "number") s.push(n); else a.push(n);
  }
  var m = [ "sustain", "fast" ];
  var l = a.filter(function(e) {
    return m.indexOf(e) === -1;
  });
  if (l.length > 0) {
    return "[Attack] Unknown flag(s): " + l.join(", ") + ". Valid flags: 'sustain', 'fast'.";
  }
  if (s.length !== 0 && s.length !== 2) {
    return "[Attack] Entry requires both X and Y. Example: orderAttack('" + e + "', '" + t + "', " + o + ", 1, 25).";
  }
  if (s.length === 2 && (!Number.isInteger(s[0]) || !Number.isInteger(s[1]) || s[0] < 0 || s[0] > 49 || s[1] < 0 || s[1] > 49)) {
    return "[Attack] Entry X and Y must be integers from 0 through 49.";
  }
  var c = a.indexOf("sustain") !== -1;
  var f = a.indexOf("fast") !== -1;
  var u = s.length === 2;
  var d = u ? {
    x: s[0],
    y: s[1]
  } : {
    x: 25,
    y: 25
  };
  if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
    return "[Attack] Invalid spawn room: " + e + ". Must be a room you control.";
  }
  if (!Memory.attackOrders) Memory.attackOrders = [];
  var y = Memory.attackOrders.find(function(e) {
    return e.targetRoom === t && (e.rallyPhase === "spawning" || e.rallyPhase === "rallying");
  });
  if (y) {
    return "[Attack] Attack order for " + t + " already exists and is still forming (phase: " + y.rallyPhase + "). Wait until it reaches the attacking phase.";
  }
  Memory.attackOrderSequence = (Memory.attackOrderSequence || 0) + 1;
  Memory.attackOrders.push({
    orderId: "attack_" + Game.time + "_" + Memory.attackOrderSequence,
    targetRoom: t,
    spawnRoom: e,
    rallyRoom: e,
    count: o,
    spawned: 0,
    startTime: Game.time,
    rallyPoint: {
      x: 25,
      y: 25
    },
    entryPoint: d,
    entryRange: u ? 1 : 23,
    rallyPhase: "spawning",
    sustain: c,
    fast: f
  });
  var h = "[Attack] Order created: " + o + " attackers spawning in " + e + " -> " + t + (c ? " [sustained]" : "") + (f ? " [fast]" : "") + (u ? " [entry " + d.x + "," + d.y + "]" : "");
  console.log(h);
  return h;
};
const roleAttacker = {
  run: function(e) {
    const t = e.memory.targetRoom;
    const o = e.memory.rallyRoom;
    if (e.memory._path || e.memory.pathToTarget || e.memory.destination) {
      delete e.memory._path;
      delete e.memory.pathToTarget;
      delete e.memory.destination;
    }
    if (e.memory.forceNewPath) {
      delete e.memory.forceNewPath;
      console.log(`[Attack] ${e.name}: Forcing new pathfinding calculation`);
    }
    if (!e.memory.previousRoom) {
      e.memory.previousRoom = e.room.name;
    }
    if (e.memory.retreating) {
      return this.handleRetreat(e);
    }
    const r = this.checkForHostileTowers(e);
    if (r) {
      e.memory.retreating = true;
      e.memory.retreatTarget = e.memory.previousRoom || o;
      this.clearAllMovementCache(e);
      return this.handleRetreat(e);
    }
    if (e.memory.previousRoom !== e.room.name) {
      e.memory.previousRoom = e.room.name;
    }
    if (!e.memory.rallyComplete && e.room.name !== o) {
      this.moveSafely(e, new RoomPosition(25, 25, o), {
        visualizePathStyle: {
          stroke: "#00ff00",
          lineStyle: "dotted"
        },
        range: 23
      });
      return;
    }
    if (!e.memory.rallyComplete && e.room.name === o) {
      const t = this.handleRallyPhase(e);
      if (!t) return;
    }
    if (e.room.name !== t) {
      const o = e.memory.entryPoint || {
        x: 25,
        y: 25
      };
      this.moveSafely(e, new RoomPosition(o.x, o.y, t), {
        visualizePathStyle: {
          stroke: "#ff0000",
          lineStyle: "dashed"
        },
        range: e.memory.entryRange === undefined ? 23 : e.memory.entryRange
      });
      return;
    }
    const a = e.body.some(e => e.type === HEAL && e.hits > 0);
    let s = null;
    if (a && e.hits === e.hitsMax) {
      s = this.findDamagedFriendly(e);
    }
    let i = null;
    if (e.memory.assignedTargetId) {
      i = Game.getObjectById(e.memory.assignedTargetId);
      if (i && i.structureType === STRUCTURE_POWER_BANK) i = null;
      if (!i) delete e.memory.assignedTargetId;
      if (i) {
        e.memory.targetId = i.id;
        e.say("💥 ATTACK!");
        if (e.attack(i) === ERR_NOT_IN_RANGE) {
          this.healWhileClosing(e, s);
          this.moveSafely(e, i, {
            visualizePathStyle: {
              stroke: "#ff0000"
            }
          });
        }
        return;
      }
    }
    if (!i && e.memory.targetId) {
      i = Game.getObjectById(e.memory.targetId);
      if (i && i.structureType === STRUCTURE_POWER_BANK) {
        i = null;
        delete e.memory.targetId;
      }
      if (i && (i.structureType === STRUCTURE_WALL || i.structureType === STRUCTURE_RAMPART)) {
        i = e.pos.findClosestByPath(FIND_HOSTILE_CREEPS, {
          filter: e => iff.isHostileCreep(e)
        }) || this.findWeakestBarrier(e) || i;
        e.memory.targetId = i.id;
      }
      if (i) {
        e.say("💥 ATTACK!");
        const t = e.attack(i);
        if (t === ERR_NOT_IN_RANGE) {
          this.healWhileClosing(e, s);
          this.moveSafely(e, i, {
            visualizePathStyle: {
              stroke: "#ff0000"
            }
          });
        }
        return;
      } else {
        delete e.memory.targetId;
      }
    }
    if (!i) {
      i = e.pos.findClosestByPath(FIND_HOSTILE_CREEPS, {
        filter: e => iff.isHostileCreep(e)
      });
    }
    if (!i) {
      i = this.findWeakestBarrier(e);
    }
    if (!i) {
      i = e.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
        filter: e => {
          if (e.structureType === STRUCTURE_CONTROLLER || e.structureType === STRUCTURE_KEEPER_LAIR || e.structureType === STRUCTURE_POWER_BANK) return false;
          if (e.owner && iff.IFF_WHITELIST.includes(e.owner.username)) {
            return false;
          }
          return true;
        }
      });
    }
    if (!i) {
      i = e.pos.findClosestByPath(FIND_HOSTILE_CONSTRUCTION_SITES);
    }
    if (!i && s) {
      delete e.memory.targetId;
      this.healWhileClosing(e, s);
      const t = e.pos.getRangeTo(s);
      if (t > 3 || this.isRestrictedTile(e, e.pos.x, e.pos.y, e.room.name)) {
        this.moveSafely(e, s, {
          range: 3,
          visualizePathStyle: {
            stroke: "#00ff88"
          }
        });
      }
      return;
    }
    if (i && !e.pos.inRangeTo(i, 1)) {
      const t = PathFinder.search(e.pos, {
        pos: i.pos,
        range: 1
      }, {
        maxOps: 1e3,
        maxRooms: 1,
        plainCost: 1,
        swampCost: 5,
        roomCallback: e => this.getStructureMatrix(e, 255)
      });
      if (t.incomplete) {
        const t = PathFinder.search(e.pos, {
          pos: i.pos,
          range: 1
        }, {
          maxOps: 1e3,
          maxRooms: 1,
          plainCost: 1,
          swampCost: 5,
          roomCallback: e => this.getStructureMatrix(e, 1)
        });
        const o = [];
        for (const e of t.path) {
          const t = Game.rooms[e.roomName];
          const r = t ? t.lookForAt(LOOK_STRUCTURES, e.x, e.y) : [];
          for (const e of r) {
            if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) {
              o.push(e);
            }
          }
        }
        const r = e.room.controller && (e.room.controller.my || e.room.controller.owner && iff.IFF_WHITELIST.includes(e.room.controller.owner.username));
        if (o.length && !r) {
          i = o.reduce((e, t) => t.hits < e.hits ? t : e, o[0]);
        }
      }
    }
    if (i) {
      e.memory.targetId = i.id;
    }
    if (i) {
      e.say("💥 ATTACK!");
      const t = e.attack(i);
      if (t === ERR_NOT_IN_RANGE) {
        this.healWhileClosing(e, s);
        this.moveSafely(e, i, {
          visualizePathStyle: {
            stroke: "#ff0000"
          }
        });
      }
      return;
    }
    const n = e.room.controller && (e.room.controller.my || e.room.controller.owner && iff.IFF_WHITELIST.includes(e.room.controller.owner.username));
    const m = e.room.find(FIND_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART
    });
    if (m.length && !n) {
      const t = m.filter(e => e.pos.x === 0 || e.pos.x === 49 || e.pos.y === 0 || e.pos.y === 49);
      const o = t.length ? t : m;
      const r = o.reduce((e, t) => t.hits < e.hits ? t : e, o[0]);
      if (r) {
        e.memory.targetId = r.id;
        e.say("🪨 BUST");
        if (e.attack(r) === ERR_NOT_IN_RANGE) {
          this.healWhileClosing(e, s);
          this.moveSafely(e, r, {
            visualizePathStyle: {
              stroke: "#ffaa00"
            }
          });
        }
        return;
      }
    }
    this.healWhileClosing(e, s);
    if (!e.room.controller || !e.room.controller.my) {
      const t = e.pos.findClosestByRange(FIND_MY_CREEPS, {
        filter: t => t.name !== e.name
      });
      const o = e.memory.lastIdlePos;
      const r = o && o.x === e.pos.x && o.y === e.pos.y && o.roomName === e.room.name;
      e.memory.lastIdlePos = {
        x: e.pos.x,
        y: e.pos.y,
        roomName: e.room.name
      };
      if (t && r && !e.pos.inRangeTo(t, 5)) {
        this.moveSafely(e, t, {
          range: 5,
          visualizePathStyle: {
            stroke: "#00ffff"
          }
        });
        return;
      }
    } else {
      delete e.memory.lastIdlePos;
    }
    delete e.memory.targetId;
  },
  healWhileClosing: function(e, t) {
    if (e.getActiveBodyparts(HEAL) === 0) return;
    if (e.hits < e.hitsMax) {
      e.heal(e);
      return;
    }
    if (!t) return;
    const o = e.pos.getRangeTo(t);
    if (o <= 1) e.heal(t); else if (o <= 3) e.rangedHeal(t);
  },
  findWeakestBarrier: function(e) {
    const t = e.room.controller;
    if (t && (t.my || t.owner && iff.IFF_WHITELIST.includes(t.owner.username))) {
      return null;
    }
    const o = e.room.find(FIND_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART && !e.my && (!e.owner || !iff.IFF_WHITELIST.includes(e.owner.username))
    });
    if (o.length === 0) return null;
    return o.reduce((e, t) => t.hits < e.hits ? t : e, o[0]);
  },
  findDamagedFriendly: function(e) {
    const t = getRoomState.get(e.room.name);
    if (!t) return null;
    const o = t.myCreeps.filter(t => t.id !== e.id && t.hits < t.hitsMax);
    for (const e of t.hostiles) {
      if (e.hits < e.hitsMax && iff.isWhitelistedCreep(e)) o.push(e);
    }
    if (o.length === 0) return null;
    return e.pos.findClosestByRange(o);
  },
  getTowerDrainReservedTiles: function(e) {
    const t = this.getNavigationCache();
    const o = "base:" + e;
    if (t.restrictedTiles[o]) return t.restrictedTiles[o];
    const r = {};
    if (Memory.towerDrainOps && Memory.towerDrainOps.operations) {
      const t = Memory.towerDrainOps.operations;
      for (const o in t) {
        const a = t[o].lanes;
        if (!a) continue;
        for (const t in a) {
          const o = a[t];
          const s = [ o.attackEdgePos, o.attackRestPos, o.healEdgePos, o.healRestPos ];
          for (const t of s) {
            if (t && t.roomName === e) r[t.x + "," + t.y] = true;
          }
        }
      }
    }
    const a = getRoomState.creepIndex().all;
    for (const t of a) {
      if (!t.memory || t.memory.role !== "drainDemolisher" || !t.memory.healerParkPos) continue;
      const o = t.memory.healerParkPos;
      if (o.roomName === e) r[o.x + "," + o.y] = true;
    }
    t.restrictedTiles[o] = r;
    return r;
  },
  getRestrictedTiles: function(e, t) {
    const o = this.getNavigationCache();
    const r = t === e.memory.targetRoom;
    const a = t + ":" + r;
    if (o.restrictedTiles[a]) return o.restrictedTiles[a];
    const s = Object.assign({}, this.getTowerDrainReservedTiles(t));
    if (r) {
      for (let e = 0; e <= 49; e++) {
        s[e + ",0"] = true;
        s[e + ",49"] = true;
        s["0," + e] = true;
        s["49," + e] = true;
      }
    }
    o.restrictedTiles[a] = s;
    return s;
  },
  getRestrictedTileCoordinates: function(e, t) {
    const o = this.getNavigationCache();
    const r = t + ":" + (t === e.memory.targetRoom);
    if (!o.restrictedCoordinates[r]) {
      o.restrictedCoordinates[r] = Object.keys(this.getRestrictedTiles(e, t)).map(e => {
        const t = e.split(",");
        return {
          x: Number(t[0]),
          y: Number(t[1])
        };
      });
    }
    return o.restrictedCoordinates[r];
  },
  getNavigationCache: function() {
    if (navigationCache.tick !== Game.time) {
      navigationCache.tick = Game.time;
      navigationCache.restrictedTiles = {};
      navigationCache.restrictedCoordinates = {};
      navigationCache.structureMatrices = {};
      navigationCache.hostileTowers = {};
    }
    return navigationCache;
  },
  getStructureMatrix: function(e, t) {
    const o = this.getNavigationCache();
    const r = e + ":" + t;
    if (!o.structureMatrices[r]) {
      const a = new PathFinder.CostMatrix;
      const s = Game.rooms[e];
      if (s) {
        s.find(FIND_STRUCTURES).forEach(e => {
          if (e.structureType === STRUCTURE_WALL || e.structureType === STRUCTURE_RAMPART) {
            a.set(e.pos.x, e.pos.y, t);
          }
        });
      }
      o.structureMatrices[r] = a;
    }
    return o.structureMatrices[r].clone();
  },
  applyRestrictedTiles: function(e, t, o) {
    for (const r of this.getRestrictedTileCoordinates(t, o)) {
      e.set(r.x, r.y, 255);
    }
    return e;
  },
  isRestrictedTile: function(e, t, o, r) {
    return !!this.getRestrictedTiles(e, r)[t + "," + o];
  },
  moveSafely: function(e, t, o = {}) {
    const r = this.getRestrictedTiles(e, e.room.name);
    if (r[e.pos.x + "," + e.pos.y]) {
      const t = e.room.getTerrain();
      let o = null;
      for (let a = -1; a <= 1; a++) {
        for (let s = -1; s <= 1; s++) {
          if (a === 0 && s === 0) continue;
          const i = e.pos.x + a;
          const n = e.pos.y + s;
          if (i < 1 || i > 48 || n < 1 || n > 48) continue;
          if (r[i + "," + n]) continue;
          if (t.get(i, n) === TERRAIN_MASK_WALL) continue;
          if (e.room.lookForAt(LOOK_CREEPS, i, n).length > 0) continue;
          o = {
            x: i,
            y: n
          };
          break;
        }
        if (o) break;
      }
      if (o) {
        return e.move(e.pos.getDirectionTo(o.x, o.y));
      }
    }
    const a = o.costCallback;
    const s = Object.assign({}, o);
    delete s.visualizePathStyle;
    const i = t.pos || t;
    if (s.reusePath === undefined) s.reusePath = 10;
    s.costCallback = (t, o) => {
      if (a) a(t, o);
      this.applyRestrictedTiles(o, e, t);
    };
    if (!e.memory.blacklistedRooms || e.memory.blacklistedRooms.length === 0) {
      return e.moveTo(t, s);
    }
    const n = this.getNavigationCache();
    const m = e.memory.blacklistedRooms.join(",");
    const l = i.roomName + ":" + i.x + ":" + i.y + ":" + (s.range || 1) + ":" + m;
    let c = n.avoidancePaths[e.name];
    if (!c || c.key !== l) {
      c = null;
    } else if (c.path.length && e.pos.isEqualTo(c.path[0])) {
      c.path.shift();
    }
    if (c && c.path.length) {
      const t = c.path[0];
      if (!e.memory.blacklistedRooms.includes(t.roomName)) {
        return e.move(e.pos.getDirectionTo(t));
      }
      delete n.avoidancePaths[e.name];
    }
    const f = [ {
      pos: i,
      range: s.range || 1
    } ];
    const u = PathFinder.search(e.pos, f, {
      maxOps: s.maxOps || 4e3,
      maxRooms: s.maxRooms || 16,
      plainCost: s.plainCost || 1,
      swampCost: s.swampCost || 5,
      roomCallback: this.getAvoidanceRoomCallback(e)
    });
    if (u.path && u.path.length > 0) {
      n.avoidancePaths[e.name] = {
        key: l,
        path: u.path
      };
      const t = u.path[0];
      const o = e.pos.getDirectionTo(t);
      if (s.visualizePathStyle) {
        e.room.visual.poly(u.path, s.visualizePathStyle);
      }
      if (e.memory.blacklistedRooms.includes(t.roomName)) {
        console.log(`[Attack] ${e.name}: ERROR - PathFinder trying to go to blacklisted room ${t.roomName}!`);
        return ERR_NO_PATH;
      }
      return e.move(o);
    }
    if (u.incomplete && Game.time % 25 === 0) {
      console.log(`[Attack] ${e.name}: No complete path while avoiding ${m}`);
    }
    return ERR_NO_PATH;
  },
  clearAllMovementCache: function(e) {
    delete e.memory._move;
    delete e.memory._path;
    delete e.memory.pathToTarget;
    delete e.memory.destination;
    delete navigationCache.avoidancePaths[e.name];
    e.memory.forceNewPath = true;
    console.log(`[Attack] ${e.name}: Cleared all movement cache`);
  },
  handleRetreat: function(e) {
    const t = e.memory.targetRoom;
    const o = e.memory.rallyRoom;
    if (!e.memory.retreatTarget) {
      e.memory.retreatTarget = e.memory.previousRoom || o;
    }
    if (e.memory.blacklistedRooms && e.memory.blacklistedRooms.includes(e.room.name)) {
      const t = e.room.findExitTo(e.memory.retreatTarget);
      if (t !== ERR_NO_PATH && t !== ERR_INVALID_ARGS) {
        const o = e.pos.findClosestByPath(t);
        if (o) {
          this.moveSafely(e, o, {
            visualizePathStyle: {
              stroke: "#ff0000",
              lineStyle: "solid"
            }
          });
          return;
        }
      }
      const o = Game.map.describeExits(e.room.name);
      for (const t in o) {
        const r = o[t];
        if (e.memory.blacklistedRooms && e.memory.blacklistedRooms.includes(r)) {
          continue;
        }
        const a = parseInt(t);
        const s = e.pos.findClosestByPath(a);
        if (s) {
          this.moveSafely(e, s, {
            visualizePathStyle: {
              stroke: "#ff0000",
              lineStyle: "solid"
            }
          });
          return;
        }
      }
      return;
    }
    const r = Math.min(e.pos.x, e.pos.y, 49 - e.pos.x, 49 - e.pos.y);
    if (r < 2) {
      const t = new RoomPosition(25, 25, e.room.name);
      this.moveSafely(e, t, {
        visualizePathStyle: {
          stroke: "#ffaa00",
          lineStyle: "dotted"
        }
      });
      return;
    }
    const a = e.body.some(e => e.type === HEAL && e.hits > 0);
    if (a && e.hits < e.hitsMax) {
      e.heal(e);
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
      console.log(`[Attack] Creep ${e.name} finished retreating, blacklisted rooms: ${JSON.stringify(e.memory.blacklistedRooms)}`);
    }
  },
  checkForHostileTowers: function(e) {
    if (e.room.name === e.memory.targetRoom) {
      return false;
    }
    const t = this.getNavigationCache();
    let o = t.hostileTowers[e.room.name];
    if (!o) {
      o = e.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: e => {
          if (e.structureType !== STRUCTURE_TOWER) return false;
          return !e.owner || !iff.IFF_WHITELIST.includes(e.owner.username);
        }
      });
      t.hostileTowers[e.room.name] = o;
    }
    if (o.length > 0) {
      if (!e.memory.blacklistedRooms) {
        e.memory.blacklistedRooms = [];
      }
      if (!e.memory.blacklistedRooms.includes(e.room.name)) {
        e.memory.blacklistedRooms.push(e.room.name);
        this.clearAllMovementCache(e);
        console.log(`[Attack] Creep ${e.name} blacklisted room ${e.room.name} due to hostile towers`);
      }
      return true;
    }
    return false;
  },
  getAvoidanceRoomCallback: function(e) {
    const t = this;
    return function(o) {
      if (e.memory.blacklistedRooms && e.memory.blacklistedRooms.includes(o) && o !== e.memory.targetRoom) {
        return false;
      }
      return t.applyRestrictedTiles(t.getStructureMatrix(o, 255), e, o);
    };
  },
  handleRallyPhase: function(e) {
    const t = Memory.attackOrders && _.find(Memory.attackOrders, function(t) {
      if (!t) return false;
      if (e.memory.attackOrderId) return t.orderId === e.memory.attackOrderId;
      return t.targetRoom === e.memory.targetRoom && t.spawnRoom === e.memory.spawnRoom;
    });
    if (!t) {
      e.memory.rallyComplete = true;
      return true;
    }
    if (t.rallyPhase === "attacking") {
      e.memory.rallyComplete = true;
      return true;
    }
    return false;
  }
};
module.exports = roleAttacker;
global.assignAttackTarget = function(e, t) {
  if (!e || !t) {
    return "[Attack] Invalid command. Use global.assignAttackTarget('roomName', 'targetId').";
  }
  var o = _.filter(getRoomState.creepIndex().all, function(t) {
    return t.memory.role === "attacker" && t.memory.targetRoom === e;
  });
  if (o.length === 0) {
    return "[Attack] No attackers found for room " + e + ".";
  }
  var r = 0;
  for (var a = 0; a < o.length; a++) {
    var s = o[a];
    s.memory.assignedTargetId = t;
    r++;
  }
  return "[Attack] Assigned target " + t + " to " + r + " attackers in room " + e + ".";
};
global.cancelAttackOrder = function(e) {
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return "[Attack] No active attack orders.";
  var t = Memory.attackOrders.findIndex(function(t) {
    return t.targetRoom === e;
  });
  if (t === -1) return "[Attack] No attack order found for " + e + ".";
  var o = Memory.attackOrders[t].sustain === true;
  Memory.attackOrders.splice(t, 1);
  return "[Attack] Attack on " + e + " has been cancelled." + (o ? " Respawning stopped; living attackers will fight until they die." : "");
};
global.setAttackCount = function(e, t) {
  t = parseInt(t, 10);
  if (!e || !t || t < 1) {
    return "[Attack] Invalid command. Use global.setAttackCount('targetRoom', count).";
  }
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return "[Attack] No active attack orders.";
  var o = Memory.attackOrders.findIndex(function(t) {
    return t.targetRoom === e;
  });
  if (o === -1) return "[Attack] No attack order found for " + e + ".";
  var r = Memory.attackOrders[o];
  if (r.sustain !== true) {
    return "[Attack] Attack order for " + e + " is not sustained; count updates only apply to sustained attacks.";
  }
  var a = r.count || 0;
  r.count = t;
  var s = _.filter(getRoomState.creepIndex().all, function(t) {
    return t.memory.role === "attacker" && t.memory.targetRoom === e;
  }).length;
  return "[Attack] Updated sustained attack on " + e + " count " + a + " -> " + t + ". Currently alive: " + s + "/" + t + "." + (s > t ? " Extra attackers will keep fighting; replacements are paused until losses occur." : "");
};
