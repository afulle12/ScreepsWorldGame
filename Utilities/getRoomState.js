// LLM: Read docs/codex.js before reviewing or changing this file.
// getRoomState.js
//   getRoomState.init()                build cache once per tick
//   getRoomState.get(roomName)         state for a room, or undefined
//   getRoomState.get(roomName, true)   print detailed state to console
//   getRoomState.get(roomName, {occupancy:true})  50x50 grid of every tile:
//     terrain (wall/swamp/plain) + room-edge exits + sources + minerals +
//     structures. No creeps, dropped, tombs, ruins, or construction sites.
//     Console wrapper prints one line per tile (x,y glyph type).
//   getRoomState.all()                 map of all cached rooms
//   getRoomState.has(roomName)         boolean, cached this tick
//   getRoomState.isOwned(roomName)     boolean, owned this tick
//   getRoomState.owned() / ownedNames()  map / array of owned room names
//   getRoomState.get(name).permanentFacts  immutable terrain/source/mineral/
//     controller capsule for owned rooms, or null
const permanentRoomFacts = require("permanentRoomFacts");
const getRoomState = function() {
  const e = 25;
  const r = 500;
  const t = 500;
  const n = 25;
  const o = 50;
  const s = 10;
  const i = 5;
  function groupStructuresByType(e) {
    const r = {};
    for (var t = 0; t < e.length; t++) {
      const n = e[t];
      const o = n.structureType;
      if (!r[o]) r[o] = [];
      r[o].push(n);
    }
    return r;
  }
  function formatPos(e) {
    if (!e) return undefined;
    return {
      roomName: e.roomName,
      x: e.x,
      y: e.y
    };
  }
  function summarizeStore(e) {
    if (!e) return undefined;
    const r = {};
    for (var t in e) {
      if (!e.hasOwnProperty(t)) continue;
      if (typeof e[t] !== "number") continue;
      if (e[t] <= 0) continue;
      r[t] = e[t];
    }
    return r;
  }
  function summarizeRoomObject(e) {
    if (!e) return undefined;
    const r = {
      id: e.id,
      pos: formatPos(e.pos)
    };
    if (e.name !== undefined) r.name = e.name;
    if (e.structureType !== undefined) r.structureType = e.structureType;
    if (e.resourceType !== undefined) r.resourceType = e.resourceType;
    if (e.amount !== undefined) r.amount = e.amount;
    if (e.energy !== undefined) r.energy = e.energy;
    if (e.energyCapacity !== undefined) r.energyCapacity = e.energyCapacity;
    if (e.hits !== undefined) r.hits = e.hits;
    if (e.hitsMax !== undefined) r.hitsMax = e.hitsMax;
    if (e.ticksToLive !== undefined) r.ticksToLive = e.ticksToLive;
    if (e.ticksToDecay !== undefined) r.ticksToDecay = e.ticksToDecay;
    if (e.ticksToRegeneration !== undefined) r.ticksToRegeneration = e.ticksToRegeneration;
    if (e.progress !== undefined) r.progress = e.progress;
    if (e.progressTotal !== undefined) r.progressTotal = e.progressTotal;
    if (e.owner && e.owner.username !== undefined) r.owner = e.owner.username;
    if (e.controller && e.controller.my !== undefined) r.my = e.controller.my;
    if (e.store) r.store = summarizeStore(e.store);
    if (e.memory && e.memory.role !== undefined) r.role = e.memory.role;
    return r;
  }
  function summarizeList(e) {
    const r = [];
    for (var t = 0; t < e.length; t++) {
      r.push(summarizeRoomObject(e[t]));
    }
    return r;
  }
  function buildRoomStatePrint(e) {
    if (!e) return undefined;
    const r = e.controller;
    const t = e.storage;
    const n = e.terminal;
    const o = {};
    for (var s in e.structuresByType) {
      if (!e.structuresByType.hasOwnProperty(s)) continue;
      o[s] = summarizeList(e.structuresByType[s]);
    }
    return {
      name: e.name,
      time: e.time,
      owned: !!e.isOwned,
      controller: r ? {
        id: r.id,
        level: r.level,
        progress: r.progress,
        progressTotal: r.progressTotal,
        safeMode: r.safeMode,
        safeModeAvailable: r.safeModeAvailable,
        reservation: r.reservation ? {
          username: r.reservation.username,
          ticksToEnd: r.reservation.ticksToEnd
        } : undefined,
        owner: r.owner ? r.owner.username : undefined,
        pos: formatPos(r.pos)
      } : undefined,
      storage: summarizeRoomObject(t),
      terminal: summarizeRoomObject(n),
      counts: {
        myCreeps: e.myCreeps ? e.myCreeps.length : 0,
        myPowerCreeps: e.myPowerCreeps ? e.myPowerCreeps.length : 0,
        hostiles: e.hostiles ? e.hostiles.length : 0,
        dropped: e.dropped ? e.dropped.length : 0,
        tombstones: e.tombstones ? e.tombstones.length : 0,
        ruins: e.ruins ? e.ruins.length : 0,
        constructionSites: e.constructionSites ? e.constructionSites.length : 0,
        sources: e.sources ? e.sources.length : 0,
        minerals: e.minerals ? e.minerals.length : 0
      },
      myCreeps: summarizeList(e.myCreeps || []),
      myPowerCreeps: summarizeList(e.myPowerCreeps || []),
      hostiles: summarizeList(e.hostiles || []),
      dropped: summarizeList(e.dropped || []),
      tombstones: summarizeList(e.tombstones || []),
      ruins: summarizeList(e.ruins || []),
      constructionSites: summarizeList(e.constructionSites || []),
      sources: summarizeList(e.sources || []),
      minerals: summarizeList(e.minerals || []),
      structuresByType: o
    };
  }
  function printRoomState(e) {
    const r = buildRoomStatePrint(e);
    if (!r) return "No room state to print.";
    console.log("getRoomState(" + e.name + ") =\n" + JSON.stringify(r, null, 2));
    return "Printed room state for " + e.name + " to console.";
  }
  function rehydrate(e) {
    const r = [];
    for (var t = 0; t < e.length; t++) {
      const n = Game.getObjectById(e[t]);
      if (n) r.push(n);
    }
    return r;
  }
  function cachedFindIds(e, r, t, n, o) {
    const s = e[r];
    if (s && Game.time - s.tick < o) {
      return s.ids;
    }
    const i = t.find(n);
    const a = [];
    for (var c = 0; c < i.length; c++) a.push(i[c].id);
    e[r] = {
      tick: Game.time,
      ids: a
    };
    return a;
  }
  function buildCreepsIndex() {
    const e = {
      byRoom: {},
      byHomeRoom: {},
      byRole: {},
      all: []
    };
    const r = Game.creeps;
    for (var t in r) {
      const n = r[t];
      const o = n.pos.roomName;
      if (!e.byRoom[o]) e.byRoom[o] = [];
      e.byRoom[o].push(n);
      e.all.push(n);
      const s = n.memory || {};
      const i = s.homeRoom || s.assignedRoom || s.orderRoom || o;
      if (!e.byHomeRoom[i]) e.byHomeRoom[i] = [];
      e.byHomeRoom[i].push(n);
      const a = s.role || "unknown";
      if (!e.byRole[a]) e.byRole[a] = [];
      e.byRole[a].push(n);
    }
    return e;
  }
  function buildPowerCreepsIndex() {
    const e = {};
    const r = Game.powerCreeps;
    for (var t in r) {
      const n = r[t];
      if (!n || !n.ticksToLive || !n.pos) continue;
      const o = n.pos.roomName;
      if (!e[o]) e[o] = [];
      e[o].push(n);
    }
    return e;
  }
  function ensurePermanentFacts(e, r, t) {
    if (!e || !e.controller) return null;
    var n = permanentRoomFacts.get(e.name);
    if (permanentRoomFacts.matchesRoom(n, e, r, t)) return n;
    var o = e.controller.sign;
    var s = e.controller.owner && e.controller.owner.username;
    if (e.controller.my && o && o.username === s) {
      var i = permanentRoomFacts.parse(o.text);
      if (permanentRoomFacts.matchesRoom(i, e, r, t)) {
        permanentRoomFacts.set(e.name, i);
        return i;
      }
    }
    if (global.__permanentFactsBuildTick === Game.time) return null;
    global.__permanentFactsBuildTick = Game.time;
    n = permanentRoomFacts.build(e, r, t);
    if (n) permanentRoomFacts.set(e.name, n);
    return n;
  }
  function ensureCache() {
    if (global.__roomState && global.__roomState.tick === Game.time) return;
    const a = Game.rooms;
    const c = {};
    const u = {};
    const m = [];
    const l = buildCreepsIndex();
    const f = buildPowerCreepsIndex();
    if (!global.__rsFindCache) global.__rsFindCache = {};
    const p = global.__rsFindCache;
    for (var d in a) {
      if (!a.hasOwnProperty(d)) continue;
      const y = a[d];
      const h = y.controller && y.controller.my;
      if (h) {
        u[d] = true;
        m.push(d);
      }
      const g = l.byRoom[d] || [];
      const R = f[d] || [];
      if (!h && g.length === 0 && R.length === 0) continue;
      if (!p[d]) p[d] = {};
      const b = p[d];
      const w = groupStructuresByType(rehydrate(cachedFindIds(b, "structures", y, FIND_STRUCTURES, e)));
      const T = rehydrate(cachedFindIds(b, "sources", y, FIND_SOURCES, r));
      const S = rehydrate(cachedFindIds(b, "minerals", y, FIND_MINERALS, t));
      const C = rehydrate(cachedFindIds(b, "constructionSites", y, FIND_CONSTRUCTION_SITES, n));
      const _ = rehydrate(cachedFindIds(b, "ruins", y, FIND_RUINS, o));
      const x = rehydrate(cachedFindIds(b, "tombstones", y, FIND_TOMBSTONES, s));
      const v = rehydrate(cachedFindIds(b, "dropped", y, FIND_DROPPED_RESOURCES, i));
      const I = y.find(FIND_HOSTILE_CREEPS);
      const F = h ? ensurePermanentFacts(y, T, S) : null;
      c[d] = {
        name: d,
        time: Game.time,
        owned: !!h,
        isOwned: !!h,
        controller: y.controller,
        storage: y.storage,
        terminal: y.terminal,
        myCreeps: g,
        myPowerCreeps: R,
        hostiles: I,
        dropped: v,
        tombstones: x,
        ruins: _,
        constructionSites: C,
        sources: T,
        minerals: S,
        permanentFacts: F,
        structuresByType: w
      };
    }
    for (var y in p) {
      if (!a[y]) delete p[y];
    }
    global.__roomState = {
      tick: Game.time,
      rooms: c,
      ownedRooms: u,
      ownedRoomNames: m,
      creepIndex: l,
      powerCreepIndex: f
    };
  }
  //   1. terrain baseline: wall, swamp, or plain (from Game.map.getRoomTerrain)
  //   2. exit overlay: any non-wall edge tile is re-marked as an exit
  //   3. objects overlay: sources, minerals, structures (these win)
    const a = 50;
  function buildOccupancyGrid(e, r) {
    const t = [];
    for (var n = 0; n < a; n++) {
      const e = new Array(a);
      for (var o = 0; o < a; o++) e[o] = null;
      t.push(e);
    }
    if (!e) return t;
    const s = typeof Game !== "undefined" && Game.map && Game.map.getRoomTerrain ? Game.map.getRoomTerrain(r) : null;
    if (s) {
      for (var i = 0; i < a; i++) {
        for (var c = 0; c < a; c++) {
          const e = s.get(c, i);
          if (e & TERRAIN_MASK_WALL) {
            t[i][c] = {
              type: "terrain",
              terrain: "wall"
            };
          } else if (e & TERRAIN_MASK_SWAMP) {
            t[i][c] = {
              type: "terrain",
              terrain: "swamp"
            };
          } else {
            t[i][c] = {
              type: "terrain",
              terrain: "plain"
            };
          }
        }
      }
    } else {}
    for (var u = 0; u < a; u++) {
      const e = t[0][u];
      if (e && e.terrain !== "wall") e.exit = "top";
      const r = t[a - 1][u];
      if (r && r.terrain !== "wall") r.exit = "bottom";
    }
    for (var m = 0; m < a; m++) {
      const e = t[m][0];
      if (e && e.terrain !== "wall") e.exit = "left";
      const r = t[m][a - 1];
      if (r && r.terrain !== "wall") r.exit = "right";
    }
    const place = function(e, r, n) {
      if (!e || !e.pos) return;
      const o = e.pos.x, s = e.pos.y;
      if (o < 0 || o >= a || s < 0 || s >= a) return;
      const i = {
        type: r,
        id: e.id
      };
      if (n) for (var c in n) i[c] = n[c];
      t[s][o] = i;
    };
    var l;
    const f = e.sources;
    for (l = 0; l < f.length; l++) {
      place(f[l], "source", {
        resourceType: "energy"
      });
    }
    const p = e.minerals;
    for (l = 0; l < p.length; l++) {
      place(p[l], "mineral", {
        resourceType: p[l].mineralType
      });
    }
    const d = e.structuresByType;
    for (var y in d) {
      if (!d.hasOwnProperty(y)) continue;
      const e = d[y];
      for (l = 0; l < e.length; l++) place(e[l], "structure", {
        structureType: y
      });
    }
    return t;
  }
  const c = {
    constructedWall: "#",
    rampart: "r",
    container: "C",
    controller: "@",
    spawn: "X",
    extension: "e",
    tower: "T",
    storage: "V",
    link: "L",
    terminal: "Y",
    extractor: "x",
    lab: "l",
    factory: "F",
    powerSpawn: "P",
    observer: "O",
    nuker: "N",
    road: "="
  };
  function glyphFor(e) {
    if (!e) return "?";
    if (e.type === "source") return "S";
    if (e.type === "mineral") return "M";
    if (e.type === "structure") return c[e.structureType] || "?";
    if (e.type === "terrain") {
      if (e.exit) {
        if (e.exit === "top") return "^";
        if (e.exit === "bottom") return "v";
        if (e.exit === "left") return "<";
        if (e.exit === "right") return ">";
      }
      if (e.terrain === "wall") return "W";
      if (e.terrain === "swamp") return "s";
      return ".";
    }
    return "?";
  }
  function describeCell(e) {
    if (e.type === "source") return "source";
    if (e.type === "mineral") return "mineral (" + e.resourceType + ")";
    if (e.type === "structure") return e.structureType;
    if (e.type === "terrain") {
      if (e.exit) return e.terrain + " (exit " + e.exit + ")";
      return e.terrain;
    }
    return "unknown";
  }
  function printOccupancyList(e, r) {
    if (!e) return "No data for " + r + ".";
    const t = [];
    t.push("Occupancy for " + r + " (50x50, all tiles):");
    let n = 0, o = 0, s = 0;
    for (var i = 0; i < a; i++) {
      for (var c = 0; c < a; c++) {
        const r = e[i][c];
        if (!r) {
          t.push("  " + c + "," + i + "  ?  unknown");
          continue;
        }
        if (r.type === "terrain") n++;
        if (r.exit) o++;
        if (r.type === "structure" || r.type === "source" || r.type === "mineral") s++;
        t.push("  " + c + "," + i + "  " + glyphFor(r) + "  " + describeCell(r));
      }
    }
    t.push("Summary: " + s + " object tile(s), " + o + " exit tile(s), " + n + " terrain tile(s) total.");
    console.log(t.join("\n"));
    return "Printed occupancy list for " + r + ".";
  }
  function init() {
    ensureCache();
  }
  function get(e, r) {
    ensureCache();
    const t = global.__roomState.rooms[e];
    if (r && r.occupancy) {
      return buildOccupancyGrid(t, e);
    }
    if (r === true) {
      if (!t) return "No cached room state for " + e + ".";
      return printRoomState(t);
    }
    return t;
  }
  function all() {
    ensureCache();
    return global.__roomState.rooms;
  }
  function has(e) {
    ensureCache();
    return !!global.__roomState.rooms[e];
  }
  function isOwned(e) {
    ensureCache();
    return !!global.__roomState.ownedRooms[e];
  }
  function owned() {
    ensureCache();
    return global.__roomState.ownedRooms;
  }
  function ownedNames() {
    ensureCache();
    return global.__roomState.ownedRoomNames;
  }
  function creepIndex() {
    ensureCache();
    return global.__roomState.creepIndex;
  }
  function powerCreepIndex() {
    ensureCache();
    return global.__roomState.powerCreepIndex;
  }
  return {
    init: init,
    get: get,
    all: all,
    has: has,
    isOwned: isOwned,
    owned: owned,
    ownedNames: ownedNames,
    print: printRoomState,
    printOccupancy: printOccupancyList,
    buildOccupancyGrid: buildOccupancyGrid,
    creepIndex: creepIndex,
    powerCreepIndex: powerCreepIndex
  };
}();
module.exports = getRoomState;
