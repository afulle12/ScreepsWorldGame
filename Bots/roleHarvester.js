// LLM: Read docs/codex.js before reviewing or changing this file.
// roleHarvester.js
// Role dispatch: memory.role === 'harvester' -> roleHarvester.run(creep).
// Console globals: harvesterPathVis
// Example: harvesterPathVis(true) - Toggle visual path overlay for stationary harvesters
// Example: require('roleHarvester').run(creep);
//   harvesterPathVis('H_E1N46_63662b_81693190')  Draw path while this harvester moves
//   harvesterPathVis()                          Disable
// Project conventions: docs/codex.js. The console command is documented above.
const getRoomState = require("getRoomState");
const memoryManager = require("memoryManager");
const SUICIDE_TTL_THRESHOLD = 121;
const RENEW_TTL_THRESHOLD = 500;
const SUSPENDED_HARVESTER_RENEW_TTL = 600;
const WAYPOINT_SEGMENT_LENGTH = 40;
const WAYPOINT_MAX_PATH_OPS = 5e3;
const WAYPOINT_MAX_AGE = 2e3;
var anchorCache = {};
var anchorCacheLastPrune = 0;
function getStuckCache() {
  if (!memoryManager.heap.harvesterStuck) memoryManager.heap.harvesterStuck = {};
  return memoryManager.heap.harvesterStuck;
}

function drawHarvesterPath(e) {
  if (anchorCache[e.name]) return;
  if (!e.memory._move || !e.memory._move.path) return;
  try {
    var r = Room.deserializePath(e.memory._move.path);
    if (!r || r.length === 0) return;
    var t = [ e.pos ];
    for (var i = 0; i < r.length; i++) {
      t.push(new RoomPosition(r[i].x, r[i].y, e.room.name));
    }
    e.room.visual.poly(t, {
      fill: "transparent",
      stroke: "#ffff00",
      lineStyle: "dashed",
      strokeWidth: .1
    });
  } catch (e) {}
}

var roleHarvester = {
  runSuspended: function(e) {
    if (e.ticksToLive >= SUSPENDED_HARVESTER_RENEW_TTL) return;
    if (Memory.harvesterPathVisName === e.name) drawHarvesterPath(e);
    var r = getRoomState.get(e.room.name);
    if (!r) return;
    var t = r.structuresByType && r.structuresByType[STRUCTURE_SPAWN] || [];
    var i = null;
    var a = null;
    var o = Infinity;
    var s = Infinity;
    for (var n = 0; n < t.length; n++) {
      var f = t[n];
      if (!f || !f.my) continue;
      var m = e.pos.getRangeTo(f);
      if (m < s) {
        a = f;
        s = m;
      }
      if (!f.spawning && m < o) {
        i = f;
        o = m;
      }
    }
    i = i || a;
    if (!i) return;
    if (e.pos.isNearTo(i)) {
      if (e.memory._move) delete e.memory._move;
      if (!i.spawning) i.renewCreep(e);
      return;
    }
    delete anchorCache[e.name];
    if (e.fatigue === 0) {
      e.moveTo(i, {
        reusePath: 20,
        maxRooms: 1,
        maxOps: 300
      });
    }
  },
  run: function(e) {
    if (Memory.harvesterPathVisName === e.name) drawHarvesterPath(e);
    if (Game.time - anchorCacheLastPrune > 200) {
      anchorCacheLastPrune = Game.time;
      for (var r in anchorCache) {
        if (!Game.creeps[r]) delete anchorCache[r];
      }
      var t = getStuckCache();
      for (var r in t) {
        if (!Game.creeps[r]) delete t[r];
      }
    }
    var i = getRoomState.get(e.room.name);
    if (!i) {
      console.log("[Harvester] " + e.name + " no room state available for " + e.room.name + " at tick " + Game.time);
      return;
    }
    if (this.renewAtAdjacentSpawn(e, i)) return;
    var a = anchorCache[e.name];
    if (a) {
      if (e.memory.harvesterWaypoints) this.clearWaypoints(e);
      var o = Game.getObjectById(a.srcId);
      if (a.isContainerAnchor) {
        var s = Game.getObjectById(a.ctnId);
        if (!o || !s || Game.time % 100 === 0 && (e.pos.x !== a.cx || e.pos.y !== a.cy)) {
          delete anchorCache[e.name];
        } else {
          this.runContainerAnchored(e, o, s, i, a.cx, a.cy);
          return;
        }
      } else {
        var n = Game.getObjectById(a.lnkId);
        var f = false;
        if (o && n && n.my && Game.time % 100 === 0) {
          var m = this.getSourceContainer(e, o, i);
          f = m && m.pos.getRangeTo(n) <= 1 && (e.pos.x !== m.pos.x || e.pos.y !== m.pos.y);
        }
        if (!o || !n || !n.my || Game.time % 100 === 0 && (e.pos.x !== a.cx || e.pos.y !== a.cy) || f) {
          delete anchorCache[e.name];
        } else {
          this.runAnchored(e, o, n, i, a.cx, a.cy);
          return;
        }
      }
    }
    if (!e.memory.sourceId) {
      console.log("[Harvester] " + e.name + " has no sourceId assigned!");
      this.findNearestSource(e, i);
      return;
    }
    var o = Game.getObjectById(e.memory.sourceId);
    if (!o) {
      console.log("[Harvester] " + e.name + " assigned source no longer exists!");
      this.findNearestSource(e, i);
      return;
    }
    var n = this.getSourceLink(e, o, i);
    var s = this.getSourceContainer(e, o, i);
    if (n) {
      var c = e.pos.x, u = e.pos.y;
      var l = Math.abs(c - o.pos.x), y = Math.abs(u - o.pos.y);
      var h = l <= 1 && y <= 1;
      var p = Math.abs(c - n.pos.x), g = Math.abs(u - n.pos.y);
      var E = p <= 1 && g <= 1;
      var v = s && c === s.pos.x && u === s.pos.y;
      var R = s && s.pos.getRangeTo(n) <= 1;
      if (h && E && (!s || v)) {
        this.clearWaypoints(e);
        anchorCache[e.name] = {
          srcId: o.id,
          lnkId: n.id,
          cx: c,
          cy: u,
          moveCleared: false
        };
        this.runAnchored(e, o, n, i, c, u);
        return;
      }
      if (s && R && !v) {
        if (e.memory._move && e.memory._move.time < Game.time - 3) {
          delete e.memory._move;
        }
        if (e.fatigue === 0) {
          var d = this.clearIfStuck(e);
          if (this.moveToWithWaypoints(e, s.pos, {
            reusePath: d.reusePath,
            maxOps: d.maxOps,
            ignoreCreeps: d.ignoreCreeps,
            range: 0,
            costCallback: this.getHarvesterCostCallback
          })) {
            return;
          }
        }
        return;
      }
      if (!h) {
        if (e.fatigue === 0) {
          var C = this.clearIfStuck(e);
          if (this.moveToWithWaypoints(e, o.pos, {
            reusePath: C.reusePath,
            maxOps: C.maxOps,
            ignoreCreeps: C.ignoreCreeps
          })) {
            return;
          }
        }
        return;
      }
    } else {
      if (s) {
        if (e.pos.x === s.pos.x && e.pos.y === s.pos.y) {
          this.clearWaypoints(e);
          anchorCache[e.name] = {
            srcId: o.id,
            ctnId: s.id,
            isContainerAnchor: true,
            cx: e.pos.x,
            cy: e.pos.y,
            moveCleared: false
          };
          this.runContainerAnchored(e, o, s, i, e.pos.x, e.pos.y);
          return;
        } else {
          if (e.memory._move && e.memory._move.time < Game.time - 3) {
            delete e.memory._move;
          }
          if (e.fatigue === 0) {
            var C = this.clearIfStuck(e);
            if (this.moveToWithWaypoints(e, s.pos, {
              reusePath: C.reusePath,
              maxOps: C.maxOps,
              ignoreCreeps: C.ignoreCreeps,
              range: 0,
              costCallback: this.getHarvesterCostCallback
            })) {
              return;
            }
          }
          return;
        }
      }
    }
    if (e.ticksToLive <= SUICIDE_TTL_THRESHOLD && o.energy === 0) {
      e.memory.suicideAfterDelivery = true;
      if (e.memory.idleUntil) delete e.memory.idleUntil;
    }
    if (e.memory.suicideAfterDelivery === true) {
      if (e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        this.deliverEnergy(e, o, i);
        if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
          e.say("💀");
          e.suicide();
        }
      } else {
        e.say("💀");
        e.suicide();
      }
      return;
    }
    if (e.memory.idleUntil) {
      if (Game.time < e.memory.idleUntil) {
        if (!this.shouldIdleAtSource(e, o, i)) {
          delete e.memory.idleUntil;
        } else {
          return;
        }
      } else {
        delete e.memory.idleUntil;
      }
    }
    const T = e.store.getUsedCapacity(RESOURCE_ENERGY);
    const _ = e.store.getCapacity(RESOURCE_ENERGY);
    if (T === _) {
      e.memory.harvesting = false;
    } else if (T === 0) {
      e.memory.harvesting = true;
    }
    if (e.fatigue > 0 && !e.memory.harvesting) {
      if (T > 0) {
        this.attemptImmediateTransfer(e, i);
      }
      return;
    }
    if (e.memory.harvesting) {
      if (o.energy === 0) {
        this.handleDepletedSource(e, o, i);
        return;
      }
      if (!e.pos.isNearTo(o)) {
        if (e.fatigue === 0) {
          var C = this.clearIfStuck(e);
          if (this.moveToWithWaypoints(e, o.pos, {
            reusePath: C.reusePath,
            maxOps: C.maxOps,
            ignoreCreeps: C.ignoreCreeps
          })) {
            return;
          }
        }
        return;
      }
      if (e.memory._move) delete e.memory._move;
      if (e.memory.harvesterWaypoints) this.clearWaypoints(e);
      var S = e.harvest(o);
      if (S === ERR_NOT_ENOUGH_RESOURCES) {
        this.handleDepletedSource(e, o, i);
      }
    } else {
      this.deliverEnergy(e, o, i);
    }
  },
  runAnchored: function(e, r, t, i, a, o) {
    var s = anchorCache[e.name];
    if (s && !s.moveCleared) {
      if (e.memory._move) delete e.memory._move;
      s.moveCleared = true;
    }
    var n = this.getAnchorHood(e, r, t, i, a, o);
    if (e.ticksToLive <= SUICIDE_TTL_THRESHOLD && r.energy === 0 && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.suicide();
      return;
    }
    if (r.energy > 0 && e.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      e.harvest(r);
    }
    var f = e.store.getUsedCapacity(RESOURCE_ENERGY);
    if (f > 0) {
      var m = e.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
      var c = r.energy === 0;
      var u = m || c;
      if (!u) {
        for (var l = 0; l < n.spawns.length; l++) {
          if (n.spawns[l].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            u = true;
            break;
          }
        }
      }
      if (u) {
        var y = false;
        var h = false;
        for (var l = 0; l < n.spawns.length; l++) {
          var p = n.spawns[l];
          if (p.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            e.transfer(p, RESOURCE_ENERGY);
            y = true;
            break;
          }
        }
        if (!y) {
          for (var g = 0; g < n.containers.length; g++) {
            var E = n.containers[g];
            if (E.hits < 24e4) {
              e.repair(E);
              y = true;
              break;
            }
          }
        }
        if (!y) {
          if (t.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            e.transfer(t, RESOURCE_ENERGY);
            y = true;
          }
        }
        if (!y) {
          for (var v = 0; v < n.links.length; v++) {
            var R = n.links[v];
            if (R.id === t.id) continue;
            if (R.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
              e.transfer(R, RESOURCE_ENERGY);
              y = true;
              break;
            }
          }
        }
        if (!y) {
          for (var g = 0; g < n.containers.length; g++) {
            var E = n.containers[g];
            if (E.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
              e.transfer(E, RESOURCE_ENERGY);
              y = true;
              h = true;
              break;
            }
          }
        }
        if (r.energy === 0 && y && !h) {
          this.hoodWithdrawContainer(e, n);
        }
      }
    }
    if (r.energy === 0 && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      if (this.hoodTargetNeedsEnergy(n, t)) {
        this.hoodWithdrawContainer(e, n);
      }
      if (typeof r.ticksToRegeneration === "number" && Game.time % 10 === 0) {
        e.say("⏳" + r.ticksToRegeneration);
      }
    }
  },
  runContainerAnchored: function(e, r, t, i, a, o) {
    if (Game.time % 200 === 0) {
      if (e.memory.sourceLinkId === false) delete e.memory.sourceLinkId;
      var s = this.getSourceLink(e, r, i);
      if (s) {
        delete anchorCache[e.name];
        return;
      }
    }
    var n = anchorCache[e.name];
    if (n && !n.moveCleared) {
      if (e.memory._move) delete e.memory._move;
      n.moveCleared = true;
    }
    if (e.ticksToLive <= SUICIDE_TTL_THRESHOLD && r.energy === 0 && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.suicide();
      return;
    }
    if (r.energy > 0 && e.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      e.harvest(r);
    }
    var f = e.store.getUsedCapacity(RESOURCE_ENERGY);
    if (f > 0) {
      var m = e.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
      var c = r.energy === 0;
      var u = m || c;
      var l = this.getAnchorHood(e, r, null, i, a, o);
      if (!u) {
        for (var y = 0; y < l.spawns.length; y++) {
          if (l.spawns[y].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            u = true;
            break;
          }
        }
      }
      if (u) {
        var h = false;
        for (var y = 0; y < l.spawns.length; y++) {
          var p = l.spawns[y];
          if (p.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            e.transfer(p, RESOURCE_ENERGY);
            h = true;
            break;
          }
        }
        if (!h) {
          if (t.hits < 24e4) {
            e.repair(t);
          } else if (t.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            e.transfer(t, RESOURCE_ENERGY);
          }
        }
      }
    }
    if (r.energy === 0 && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      if (typeof r.ticksToRegeneration === "number" && Game.time % 10 === 0) {
        e.say("⏳" + r.ticksToRegeneration);
      }
    }
  },
  getAnchorHood: function(e, r, t, i, a, o) {
    var s = anchorCache[e.name];
    if (!s) return {
      tick: Game.time,
      spawns: [],
      links: [],
      containers: []
    };
    if (s.hoodTick === Game.time) {
      return s.hood;
    }
    if (!s.ids || Game.time - s.idsAt >= 50) {
      var n = i.structuresByType || {};
      var f = [], m = [], c = [];
      var u = n[STRUCTURE_SPAWN] || [];
      for (var l = 0; l < u.length; l++) {
        var y = u[l];
        if (!y.my) continue;
        if (Math.abs(a - y.pos.x) <= 1 && Math.abs(o - y.pos.y) <= 1) {
          f.push(y.id);
        }
      }
      var h = n[STRUCTURE_LINK] || [];
      for (var l = 0; l < h.length; l++) {
        var y = h[l];
        if (!y.my) continue;
        if (Math.abs(a - y.pos.x) <= 1 && Math.abs(o - y.pos.y) <= 1) {
          m.push(y.id);
        }
      }
      var p = n[STRUCTURE_CONTAINER] || [];
      for (var l = 0; l < p.length; l++) {
        var y = p[l];
        if (Math.abs(a - y.pos.x) <= 1 && Math.abs(o - y.pos.y) <= 1) {
          c.push(y.id);
        }
      }
      s.ids = {
        s: f,
        l: m,
        c: c
      };
      s.idsAt = Game.time;
    }
    var g = s.ids;
    var E = {
      spawns: [],
      links: [],
      containers: []
    };
    for (var l = 0; l < g.s.length; l++) {
      var v = Game.getObjectById(g.s[l]);
      if (v) E.spawns.push(v);
    }
    for (var l = 0; l < g.l.length; l++) {
      var v = Game.getObjectById(g.l[l]);
      if (v) E.links.push(v);
    }
    for (var l = 0; l < g.c.length; l++) {
      var v = Game.getObjectById(g.c[l]);
      if (v) E.containers.push(v);
    }
    s.hood = E;
    s.hoodTick = Game.time;
    return E;
  },
  renewAtAdjacentSpawn: function(e, r) {
    if (e.ticksToLive >= RENEW_TTL_THRESHOLD) return false;
    var t = r.structuresByType && r.structuresByType[STRUCTURE_SPAWN] || [];
    for (var i = 0; i < t.length; i++) {
      var a = t[i];
      if (!a || !a.my || a.spawning || !e.pos.isNearTo(a)) continue;
      if (a.renewCreep(e) === OK) {
        if (e.memory.suicideAfterDelivery) delete e.memory.suicideAfterDelivery;
        e.say("♻️");
        return true;
      }
    }
    return false;
  },
  hoodWithdrawContainer: function(e, r) {
    for (var t = 0; t < r.containers.length; t++) {
      var i = r.containers[t];
      if (i.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        e.withdraw(i, RESOURCE_ENERGY);
        return true;
      }
    }
    return false;
  },
  hoodTargetNeedsEnergy: function(e, r) {
    for (var t = 0; t < e.spawns.length; t++) {
      if (e.spawns[t].store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
    }
    if (r.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
    for (var t = 0; t < e.links.length; t++) {
      var i = e.links[t];
      if (i.id === r.id) continue;
      if (i.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
    }
    return false;
  },
  //                   ignoreCreeps false (one creep-aware path calculation)
  clearIfStuck: function(e) {
    var r = getStuckCache();
    var t = r[e.name];
    if (!t) {
      r[e.name] = {
        x: e.pos.x,
        y: e.pos.y,
        ticks: 0,
        repaths: 0,
        ignoreCreepsOverride: false
      };
      return {
        maxOps: 200,
        reusePath: 50,
        ignoreCreeps: true
      };
    }
    if (e.pos.x !== t.x || e.pos.y !== t.y) {
      t.x = e.pos.x;
      t.y = e.pos.y;
      t.ticks = 0;
      t.repaths = 0;
      t.ignoreCreepsOverride = false;
      return {
        maxOps: 200,
        reusePath: 50,
        ignoreCreeps: true
      };
    }
    t.ticks++;
    if (t.ticks >= 5) {
      if (e.memory._move) delete e.memory._move;
      t.repaths++;
      t.ticks = 0;
      t.ignoreCreepsOverride = true;
      var i = Math.min(1500 + t.repaths * 500, 5e3);
      return {
        maxOps: i,
        reusePath: 5,
        ignoreCreeps: false
      };
    }
    if (t.ignoreCreepsOverride) {
      t.ignoreCreepsOverride = false;
    }
    return {
      maxOps: 200,
      reusePath: 50,
      ignoreCreeps: true
    };
  },
  clearWaypoints: function(e) {
    delete e.memory.harvesterWaypoints;
    delete e.memory.harvesterWaypointsAt;
  },
  getCurrentWaypoint: function(e) {
    var r = e.memory.harvesterWaypoints;
    if (!r || !Array.isArray(r) || r.length === 0) return null;
    while (r.length > 0) {
      var t = r[0];
      if (!t || typeof t.x !== "number" || typeof t.y !== "number" || !t.roomName) {
        r.shift();
        continue;
      }
      var i = new RoomPosition(t.x, t.y, t.roomName);
      if (e.pos.isNearTo(i)) {
        r.shift();
        continue;
      }
      return i;
    }
    return null;
  },
  buildWaypointsAndMove: function(e, r, t) {
    var i = PathFinder.search(e.pos, {
      pos: r,
      range: 0
    }, {
      maxOps: WAYPOINT_MAX_PATH_OPS,
      plainCost: 2,
      swampCost: 10,
      roomCallback: this.getHarvesterCostCallback
    });
    if (i.incomplete || !i.path || i.path.length === 0) return false;
    if (i.path.length <= WAYPOINT_SEGMENT_LENGTH) return false;
    var a = [];
    for (var o = WAYPOINT_SEGMENT_LENGTH; o < i.path.length; o += WAYPOINT_SEGMENT_LENGTH) {
      var s = i.path[o];
      if (s.x === r.x && s.y === r.y && s.roomName === r.roomName) continue;
      a.push({
        x: s.x,
        y: s.y,
        roomName: s.roomName
      });
    }
    if (a.length === 0) return false;
    e.memory.harvesterWaypoints = a;
    e.memory.harvesterWaypointsAt = {
      x: e.pos.x,
      y: e.pos.y,
      roomName: e.room.name,
      time: Game.time
    };
    var n = this.getCurrentWaypoint(e);
    if (n) {
      if (e.fatigue === 0) this.moveToWaypoint(e, n, t);
      return true;
    }
    return false;
  },
  moveToWaypoint: function(e, r, t) {
    var i = {};
    for (var a in t) i[a] = t[a];
    i.reusePath = 5;
    i.maxOps = 500;
    i.range = 0;
    if (e.fatigue === 0) e.moveTo(r, i);
  },
  moveToWithWaypoints: function(e, r, t) {
    var i = e.memory.harvesterWaypoints;
    if (i && Array.isArray(i) && i.length > 0) {
      var a = e.memory.harvesterWaypointsAt;
      if (!a || Game.time - a.time > WAYPOINT_MAX_AGE) {
        this.clearWaypoints(e);
        return this.buildWaypointsAndMove(e, r, t) || this.fallbackMoveTo(e, r, t);
      }
      var o = this.getCurrentWaypoint(e);
      if (!o) {
        this.clearWaypoints(e);
        return this.fallbackMoveTo(e, r, t);
      }
      if (e.pos.getRangeTo(o) > WAYPOINT_SEGMENT_LENGTH * 2) {
        this.clearWaypoints(e);
        return this.buildWaypointsAndMove(e, r, t) || this.fallbackMoveTo(e, r, t);
      }
      if (e.fatigue === 0) this.moveToWaypoint(e, o, t);
      return true;
    }
    return this.buildWaypointsAndMove(e, r, t) || this.fallbackMoveTo(e, r, t);
  },
  fallbackMoveTo: function(e, r, t) {
    if (e.fatigue === 0) e.moveTo(r, t);
    return true;
  },
  getHarvesterCostCallback: function(e) {
    var r = new PathFinder.CostMatrix;
    var t = Game.rooms[e];
    if (t) {
      var i = t.getTerrain();
      for (var a = 0; a < 50; a++) {
        for (var o = 0; o < 50; o++) {
          if (i.get(a, o) === TERRAIN_MASK_WALL) {
            r.set(a, o, 255);
          }
        }
      }
    }
    var s = getRoomState.get(e);
    if (!s || !s.structuresByType) return r;
    var n = s.structuresByType;
    for (var f in n) {
      var m = n[f];
      if (!m) continue;
      for (var c = 0; c < m.length; c++) {
        var u = m[c];
        if (!u) continue;
        if (f === STRUCTURE_ROAD) {
          r.set(u.pos.x, u.pos.y, 1);
        } else if (f === STRUCTURE_CONTAINER) {} else if (f === STRUCTURE_RAMPART) {
          if (!u.my && !u.isPublic) r.set(u.pos.x, u.pos.y, 255);
        } else if (f === STRUCTURE_WALL || OBSTACLE_OBJECT_TYPES.indexOf(f) !== -1) {
          r.set(u.pos.x, u.pos.y, 255);
        }
      }
    }
    return r;
  },
  getSourceLink: function(e, r, t) {
    if (e._sourceLinkTick === Game.time) {
      return e._sourceLinkObj || null;
    }
    e._sourceLinkTick = Game.time;
    if (e.memory.sourceLinkId === false) {
      e._sourceLinkObj = null;
      return null;
    }
    if (e.memory.sourceLinkId) {
      var i = Game.getObjectById(e.memory.sourceLinkId);
      if (i && i.my) {
        e._sourceLinkObj = i;
        return i;
      }
      delete e.memory.sourceLinkId;
    }
    var a = t.structuresByType || {};
    var o = a[STRUCTURE_LINK] || [];
    var s = null, n = Infinity;
    for (var f = 0; f < o.length; f++) {
      var m = o[f];
      if (!m.my) continue;
      var c = r.pos.getRangeTo(m);
      if (c <= 2 && c < n) {
        s = m;
        n = c;
      }
    }
    if (s) {
      e.memory.sourceLinkId = s.id;
      e._sourceLinkObj = s;
      return s;
    }
    e.memory.sourceLinkId = false;
    e._sourceLinkObj = null;
    return null;
  },
  getSourceContainer: function(e, r, t) {
    if (e._sourceCtnTick === Game.time) {
      return e._sourceCtnObj || null;
    }
    e._sourceCtnTick = Game.time;
    if (e.memory.sourceCtnId) {
      var i = Game.getObjectById(e.memory.sourceCtnId);
      if (i && i.pos.roomName === r.pos.roomName && r.pos.getRangeTo(i) <= 1) {
        e._sourceCtnObj = i;
        return i;
      }
      delete e.memory.sourceCtnId;
    }
    var a = t.structuresByType || {};
    var o = a[STRUCTURE_CONTAINER] || [];
    var s = null, n = Infinity;
    for (var f = 0; f < o.length; f++) {
      var m = o[f];
      var c = r.pos.getRangeTo(m);
      if (c <= 1 && c < n) {
        s = m;
        n = c;
      }
    }
    if (s) {
      if (e.memory.sourceCtnId !== s.id) {
        if (e.memory._move) delete e.memory._move;
      }
      e.memory.sourceCtnId = s.id;
      e._sourceCtnObj = s;
      return s;
    }
    e._sourceCtnObj = null;
    return null;
  },
  hasRegenPower: function(e) {
    if (!e.effects || e.effects.length === 0) return false;
    for (var r = 0; r < e.effects.length; r++) {
      if (e.effects[r].effect === PWR_REGEN_SOURCE) return true;
    }
    return false;
  },
  handleDepletedSource: function(e, r, t) {
    if (e.ticksToLive <= SUICIDE_TTL_THRESHOLD) {
      e.memory.suicideAfterDelivery = true;
      if (e.memory.idleUntil) delete e.memory.idleUntil;
    }
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      this.deliverEnergy(e, r, t);
      if (e.memory.suicideAfterDelivery === true && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        e.say("💀");
        e.suicide();
      }
    } else {
      if (!e.pos.isNearTo(r)) {
        if (e.fatigue === 0) {
          var i = this.clearIfStuck(e);
          if (this.moveToWithWaypoints(e, r.pos, {
            reusePath: i.reusePath,
            maxOps: i.maxOps,
            ignoreCreeps: i.ignoreCreeps
          })) {
            return;
          }
        }
        return;
      } else {
        if (e.memory._move) delete e.memory._move;
        if (e.memory.harvesterWaypoints) this.clearWaypoints(e);
        if (typeof r.ticksToRegeneration === "number" && Game.time % 10 === 0) {
          e.say("⏳" + r.ticksToRegeneration);
        }
      }
    }
  },
  deliverEnergy: function(e, r, t) {
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      delete e.memory.deliveryId;
      delete e._deliveryTarget;
      return;
    }
    let i = null;
    if (e.memory.deliveryId) {
      if (e._deliveryTarget && e._deliveryTarget.id === e.memory.deliveryId) {
        i = e._deliveryTarget;
      } else {
        i = Game.getObjectById(e.memory.deliveryId);
        if (i) e._deliveryTarget = i;
      }
      if (!i || this.freeEnergyCapacity(i) <= 0) {
        i = null;
        delete e.memory.deliveryId;
        delete e._deliveryTarget;
      }
    }
    if (!i) {
      i = this.pickDeliveryTargetQuick(e, t, r);
      if (i) {
        e.memory.deliveryId = i.id;
        e._deliveryTarget = i;
      }
    }
    if (i) {
      const r = i.structureType;
      const a = e.pos.getRangeTo(i) <= 1 && (r === STRUCTURE_SPAWN || r === STRUCTURE_LINK);
      if (!a) {
        const r = this.findAdjacentHighPriority(e, t);
        if (r) {
          i = r;
          e.memory.deliveryId = i.id;
          e._deliveryTarget = i;
        }
      }
    }
    if (!i) {
      if (e.pos.isNearTo(r) && this.shouldIdleAtSource(e, r, t)) {
        this.startIdle(e);
        return;
      }
      if (!e.pos.inRangeTo(r, 3) && e.fatigue === 0) {
        if (this.moveToWithWaypoints(e, r.pos, {
          reusePath: 50,
          maxOps: 200,
          ignoreCreeps: false
        })) {
          return;
        }
      } else if (e.pos.inRangeTo(r, 3)) {
        if (e.memory._move) delete e.memory._move;
        if (e.memory.harvesterWaypoints) this.clearWaypoints(e);
      }
      return;
    }
    if (!e.pos.isNearTo(i)) {
      if (e.fatigue === 0) {
        if (this.moveToWithWaypoints(e, i.pos, {
          reusePath: 50,
          maxOps: 300,
          ignoreCreeps: false
        })) {
          return;
        }
      }
      return;
    }
    const a = e.transfer(i, RESOURCE_ENERGY);
    if (a === OK) {
      if (this.freeEnergyCapacity(i) <= 0 || e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        delete e.memory.deliveryId;
        delete e._deliveryTarget;
        if (e.memory._move) delete e.memory._move;
      }
      return;
    }
    if (a === ERR_FULL || a === ERR_INVALID_TARGET || a === ERR_NOT_ENOUGH_RESOURCES) {
      delete e.memory.deliveryId;
      delete e._deliveryTarget;
    }
  },
  freeEnergyCapacity: function(e) {
    if (e.structureType === STRUCTURE_POWER_SPAWN) return 0;
    var r = Game.getObjectById(e.id);
    if (!r) return 0;
    if (r.store && typeof r.store.getFreeCapacity === "function") {
      return r.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    }
    if (r.energyCapacity !== undefined && r.energy !== undefined) {
      return r.energyCapacity - r.energy;
    }
    return 0;
  },
  pickDeliveryTargetQuick: function(e, r, t) {
    const i = r.structuresByType || {};
    const a = i[STRUCTURE_CONTAINER] || [];
    const o = i[STRUCTURE_LINK] || [];
    const s = i[STRUCTURE_SPAWN] || [];
    const n = i[STRUCTURE_EXTENSION] || [];
    let f = null, m = Infinity;
    for (let r = 0; r < a.length; r++) {
      const t = a[r];
      if (this.freeEnergyCapacity(t) <= 0) continue;
      const i = e.pos.getRangeTo(t);
      if (i <= 3 && i < m) {
        f = t;
        m = i;
      }
    }
    for (let r = 0; r < o.length; r++) {
      const t = o[r];
      if (t.my && this.freeEnergyCapacity(t) <= 0) continue;
      const i = e.pos.getRangeTo(t);
      if (i <= 3 && i < m) {
        f = t;
        m = i;
      }
    }
    if (f) return f;
    for (let r = 0; r < s.length; r++) {
      const t = s[r];
      if (this.freeEnergyCapacity(t) <= 0) continue;
      if (e.pos.getRangeTo(t) <= 1) return t;
    }
    f = null;
    m = Infinity;
    for (let r = 0; r < s.length; r++) {
      const t = s[r];
      if (this.freeEnergyCapacity(t) <= 0) continue;
      const i = e.pos.getRangeTo(t);
      if (i < m) {
        f = t;
        m = i;
      }
    }
    for (let r = 0; r < n.length; r++) {
      const t = n[r];
      if (this.freeEnergyCapacity(t) <= 0) continue;
      const i = e.pos.getRangeTo(t);
      if (i < m) {
        f = t;
        m = i;
      }
    }
    if (f) return f;
    if (r.storage && this.freeEnergyCapacity(r.storage) > 0) {
      return r.storage;
    }
    f = null;
    m = Infinity;
    for (let r = 0; r < a.length; r++) {
      const t = a[r];
      if (this.freeEnergyCapacity(t) <= 0) continue;
      const i = e.pos.getRangeTo(t);
      if (i < m) {
        f = t;
        m = i;
      }
    }
    return f || null;
  },
  shouldIdleAtSource: function(e, r, t) {
    if (e._idleCheckTick === Game.time) {
      return !!e._idleCheckResult;
    }
    e._idleCheckTick = Game.time;
    if (!e.pos.isNearTo(r)) {
      e._idleCheckResult = false;
      return false;
    }
    const i = t.structuresByType || {};
    const a = i[STRUCTURE_CONTAINER] || [];
    const o = i[STRUCTURE_LINK] || [];
    const s = i[STRUCTURE_SPAWN] || [];
    const n = i[STRUCTURE_EXTENSION] || [];
    for (let r = 0; r < s.length; r++) {
      if (e.pos.getRangeTo(s[r]) <= 1 && this.freeEnergyCapacity(s[r]) > 0) {
        e._idleCheckResult = false;
        return false;
      }
    }
    for (let r = 0; r < n.length; r++) {
      if (e.pos.getRangeTo(n[r]) <= 1 && this.freeEnergyCapacity(n[r]) > 0) {
        e._idleCheckResult = false;
        return false;
      }
    }
    let f = false;
    const m = [];
    for (let e = 0; e < a.length; e++) m.push(a[e]);
    for (let e = 0; e < o.length; e++) {
      const r = o[e];
      if (r.my) m.push(r);
    }
    for (let r = 0; r < m.length; r++) {
      const t = m[r];
      if (e.pos.getRangeTo(t) > 1) continue;
      f = true;
      if (this.freeEnergyCapacity(t) > 0) {
        e._idleCheckResult = false;
        return false;
      }
    }
    e._idleCheckResult = f;
    return f;
  },
  attemptImmediateTransfer: function(e, r) {
    if (e.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return false;
    if (e.memory.deliveryId) {
      const r = Game.getObjectById(e.memory.deliveryId);
      if (r && e.pos.isNearTo(r) && this.freeEnergyCapacity(r) > 0) {
        const t = e.transfer(r, RESOURCE_ENERGY);
        if (t === OK) return true;
        if (t === ERR_FULL || t === ERR_INVALID_TARGET) delete e.memory.deliveryId;
        return true;
      }
    }
    const t = r.structuresByType || {};
    const i = t[STRUCTURE_CONTAINER] || [];
    const a = t[STRUCTURE_LINK] || [];
    const o = t[STRUCTURE_SPAWN] || [];
    const s = t[STRUCTURE_EXTENSION] || [];
    const n = [];
    for (let r = 0; r < o.length; r++) {
      const t = o[r];
      if (this.freeEnergyCapacity(t) > 0 && e.pos.getRangeTo(t) <= 1) n.push(t);
    }
    for (let r = 0; r < a.length; r++) {
      const t = a[r];
      if (t.my && this.freeEnergyCapacity(t) > 0 && e.pos.getRangeTo(t) <= 1) n.push(t);
    }
    for (let r = 0; r < i.length; r++) {
      const t = i[r];
      if (this.freeEnergyCapacity(t) > 0 && e.pos.getRangeTo(t) <= 1) n.push(t);
    }
    for (let r = 0; r < s.length; r++) {
      const t = s[r];
      if (this.freeEnergyCapacity(t) > 0 && e.pos.getRangeTo(t) <= 1) n.push(t);
    }
    if (r.storage && this.freeEnergyCapacity(r.storage) > 0 && e.pos.getRangeTo(r.storage) <= 1) {
      n.push(r.storage);
    }
    if (n.length === 0) return false;
    const f = n[0];
    const m = e.transfer(f, RESOURCE_ENERGY);
    if (m === OK) return true;
    if (m === ERR_FULL || m === ERR_INVALID_TARGET) {
      if (e.memory.deliveryId && e.memory.deliveryId === f.id) delete e.memory.deliveryId;
    }
    return true;
  },
  findAdjacentHighPriority: function(e, r) {
    const t = r.structuresByType || {};
    const i = t[STRUCTURE_SPAWN] || [];
    const a = t[STRUCTURE_LINK] || [];
    for (let r = 0; r < i.length; r++) {
      const t = i[r];
      if (e.pos.getRangeTo(t) <= 1 && this.freeEnergyCapacity(t) > 0) return t;
    }
    for (let r = 0; r < a.length; r++) {
      const t = a[r];
      if (t.my && e.pos.getRangeTo(t) <= 1 && this.freeEnergyCapacity(t) > 0) return t;
    }
    return null;
  },
  startIdle: function(e) {
    if (!e.memory.idleUntil || Game.time >= e.memory.idleUntil) {
      e.memory.idleUntil = Game.time + 5;
      if (e.memory._move) delete e.memory._move;
      e.say("😴");
    }
  },
  findNearestSource: function(e, r) {
    var t = r.sources || [];
    if (t.length === 0) return;
    var i = e.pos.findClosestByRange(t);
    if (i) {
      if (e.memory.sourceId !== i.id) {
        e.memory.sourceId = i.id;
        memoryManager.requestSave();
      }
      console.log("[Harvester] " + e.name + " assigned to emergency source: " + i.id);
    }
  }
};
//   harvesterPathVis(name?)  Enable / disable path overlay for one harvester.
//   Set a creep name to draw its movement path as a dashed yellow polyline.
//   Call with no argument to disable. See header comment for details.
global.harvesterPathVis = function(e) {
  if (!e) {
    delete Memory.harvesterPathVisName;
    console.log("[Harvester Paths] Disabled.");
  } else {
    Memory.harvesterPathVisName = e;
    console.log("[Harvester Paths] Enabled for " + e + ". Call harvesterPathVis() to disable.");
  }
};
module.exports = roleHarvester;
