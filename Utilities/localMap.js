// LLM: Read docs/codex.js before reviewing or changing this file.
// localMap.js
// Console globals: localMap, localMapCancel
// Example: localMap('E1N1') - Render visual map of local room cluster and paths
// Example: localMapCancel() - Cancel active local map visual overlays
"use strict";
const util = require("util");
const scanner = require("scanner");
const OBSERVER_RANGE = 10;
const NOTIFY_CHUNK_MAX = 400;
function parseRoomName(o) {
  const e = util.parseRoomXY(o);
  return e ? {
    wx: e.x,
    wy: e.y
  } : null;
}

function toRoomName(o, e) {
  return util.roomNameFromXY(o, e);
}

function isValidRoom(o) {
  return !!parseRoomName(o);
}

//   Screeps sectors are 10×10 blocks of rooms.
//   - Highway/intersection: either displayed coordinate is divisible by 10
//   - Source Keeper:        both displayed coordinates mod-10 fall in [4, 5, 6]
//   - Normal:               everything else (claimed / unclaimed determined at scan time)
function getCoordRoomType(o) {
  return util.getRoomSectorType(o);
}

function getRoomsInRange(o) {
  const e = parseRoomName(o);
  if (!e) return [];
  const n = [];
  for (let o = -OBSERVER_RANGE; o <= OBSERVER_RANGE; o++) {
    for (let s = -OBSERVER_RANGE; s <= OBSERVER_RANGE; s++) {
      if (o === 0 && s === 0) continue;
      n.push(toRoomName(e.wx + o, e.wy + s));
    }
  }
  return n;
}

function findObserverForRoom(o, e) {
  const n = parseRoomName(o);
  if (!n) return null;
  for (const o in e) {
    const s = parseRoomName(o);
    if (!s) continue;
    const t = Math.max(Math.abs(n.wx - s.wx), Math.abs(n.wy - s.wy));
    if (t <= OBSERVER_RANGE) return e[o];
  }
  return null;
}

function collectRoomData(o, e) {
  const n = getCoordRoomType(o);
  const s = {
    room: o,
    type: n,
    scannedAt: Game.time,
    owner: null,
    rcl: 0,
    safeMode: false,
    sources: 0,
    mineral: null,
    towers: 0,
    spawns: 0,
    hasNuker: false,
    hasStorage: false,
    hasTerminal: false,
    avgDefenseHits: 0
  };
  if (e.controller) {
    if (e.controller.owner) {
      s.owner = e.controller.owner.username;
      s.rcl = e.controller.level;
      s.type = s.type || "claimed";
    } else {
      s.type = s.type || "unclaimed";
    }
    if (e.controller.safeMode) s.safeMode = true;
  } else {
    s.type = s.type || "unclaimed";
  }
  s.sources = e.find(FIND_SOURCES).length;
  const t = e.find(FIND_MINERALS);
  if (t.length > 0) s.mineral = t[0].mineralType;
  let a = 0;
  let l = 0;
  const r = e.find(FIND_STRUCTURES);
  for (const o of r) {
    switch (o.structureType) {
     case STRUCTURE_TOWER:
      s.towers++;
      break;
     case STRUCTURE_SPAWN:
      s.spawns++;
      break;
     case STRUCTURE_NUKER:
      s.hasNuker = true;
      break;
     case STRUCTURE_STORAGE:
      s.hasStorage = true;
      break;
     case STRUCTURE_TERMINAL:
      s.hasTerminal = true;
      break;
     case STRUCTURE_WALL:
     case STRUCTURE_RAMPART:
      a += o.hits;
      l++;
      break;
    }
  }
  if (l > 0) s.avgDefenseHits = Math.round(a / l);
  return s;
}

function startLocalMap() {
  const o = scanner.utils.getObserverMap();
  const e = [];
  for (const n in o) e.push(n);
  if (e.length === 0) {
    console.log("[LocalMap] Error: No observers found in any owned rooms.");
    return;
  }
  console.log(`[LocalMap] Found ${e.length} observer(s): ${e.join(", ")}`);
  const n = new Set;
  for (const o of e) {
    for (const e of getRoomsInRange(o)) {
      if (isValidRoom(e)) n.add(e);
    }
  }
  const s = Array.from(n);
  const t = Math.ceil(s.length / Math.max(1, e.length * 60));
  console.log(`[LocalMap] Rooms to scan: ${s.length} (~${t} min at 60 ticks/min)`);
  Memory.localMap = {
    active: true,
    roomsToScan: s,
    scannedCount: 0,
    totalRooms: s.length,
    results: {},
    startTick: Game.time,
    observerRooms: e,
    pendingRoom: null,
    skippedCount: 0,
    skipped: {}
  };
  console.log("[LocalMap] Scan started.");
}

function run() {
  if (!Memory.localMap || !Memory.localMap.active) return;
  const o = Memory.localMap;
  if (o.pendingRoom === undefined) o.pendingRoom = o.lastObservedRoom || null;
  if (!o.skipped) o.skipped = {};
  if (typeof o.skippedCount !== "number") o.skippedCount = 0;
  delete o.lastObservedRoom;
  if (o.pendingRoom) {
    const e = o.pendingRoom;
    const n = Game.rooms[e];
    if (n) {
      o.results[e] = collectRoomData(e, n);
      o.scannedCount++;
      scanner.observe.consume(e, "localMap");
      if (o.roomsToScan[0] === e) o.roomsToScan.shift(); else {
        const n = o.roomsToScan.indexOf(e);
        if (n !== -1) o.roomsToScan.splice(n, 1);
      }
      o.pendingRoom = null;
    } else if (!scanner.observe.request(e, "localMap", scanner.observe.PRI.SWEEP, {
      untilConsumed: true,
      holdTicks: 60
    })) {
      o.skipped[e] = "no observer coverage";
      o.skippedCount++;
      if (o.roomsToScan[0] === e) o.roomsToScan.shift();
      scanner.observe.cancel(e, "localMap");
      o.pendingRoom = null;
    } else {
      return;
    }
  }
  if (o.roomsToScan.length === 0) {
    completeScan();
    return;
  }
  const e = o.roomsToScan[0];
  if (scanner.observe.request(e, "localMap", scanner.observe.PRI.SWEEP, {
    untilConsumed: true,
    holdTicks: 60
  })) {
    o.pendingRoom = e;
  } else {
    o.skipped[e] = "no observer coverage";
    o.skippedCount++;
    o.roomsToScan.shift();
  }
  if (o.scannedCount > 0 && o.scannedCount % 100 === 0) {
    const e = (o.scannedCount / o.totalRooms * 100).toFixed(1);
    console.log(`[LocalMap] Progress: ${o.scannedCount}/${o.totalRooms} (${e}%)`);
  }
}

function cancelLocalMap() {
  if (Memory.localMap && Memory.localMap.active) {
    if (Memory.localMap.pendingRoom) scanner.observe.cancel(Memory.localMap.pendingRoom, "localMap");
    console.log("[LocalMap] Scan cancelled.");
    delete Memory.localMap;
  } else {
    console.log("[LocalMap] No active scan to cancel.");
  }
}

function getLocalMapStatus() {
  if (!Memory.localMap || !Memory.localMap.active) {
    console.log("[LocalMap] No active scan.");
    return null;
  }
  const o = Memory.localMap;
  const e = (o.scannedCount / o.totalRooms * 100).toFixed(1);
  const n = o.totalRooms - o.scannedCount;
  const s = Game.time - o.startTick;
  console.log("[LocalMap] Status:");
  console.log(`  Progress : ${o.scannedCount}/${o.totalRooms} (${e}%)`);
  console.log(`  Elapsed  : ${s} ticks`);
  console.log(`  Remaining: ~${n} ticks`);
  return o;
}

function formatHits(o) {
  if (!o || o === 0) return "-";
  if (o >= 1e6) return `${(o / 1e6).toFixed(1)}M`;
  if (o >= 1e3) return `${Math.round(o / 1e3)}K`;
  return String(o);
}

function buildReportLines(o, e) {
  const n = {};
  const s = [];
  const t = [];
  const a = [];
  for (const e in o) {
    const l = o[e];
    if (l.type === "highway" || l.type === "intersection") {
      a.push(l);
    } else if (l.type === "sourceKeeper") {
      t.push(l);
    } else if (l.owner) {
      if (!n[l.owner]) n[l.owner] = [];
      n[l.owner].push(l);
    } else {
      s.push(l);
    }
  }
  const l = [];
  l.push("================================================================");
  l.push("[LocalMap] SCAN COMPLETE");
  l.push(`  Rooms scanned : ${Object.keys(o).length}`);
  if (e !== undefined) l.push(`  Time elapsed  : ${e} ticks`);
  l.push("");
  const r = Object.keys(n).sort();
  if (r.length > 0) {
    l.push(`--- PLAYERS (${r.length} found) ---`);
    for (const o of r) {
      const e = n[o].sort((o, e) => o.room.localeCompare(e.room));
      for (const n of e) {
        const e = [ n.safeMode ? "SAFE" : "", n.hasNuker ? "NKR" : "", n.hasStorage ? "STR" : "", n.hasTerminal ? "TRM" : "" ].filter(Boolean).join("/");
        l.push(`  ${n.room.padEnd(8)} | ${o.padEnd(16)} | RCL${n.rcl}` + ` | T:${n.towers} Sp:${n.spawns}` + ` | Def:${formatHits(n.avgDefenseHits).padStart(6)}` + ` | Min:${(n.mineral || "-").padEnd(3)}` + (e ? ` | ${e}` : ""));
      }
    }
    l.push("");
  } else {
    l.push("--- PLAYERS: None found ---");
    l.push("");
  }
  if (t.length > 0) {
    l.push(`--- SOURCE KEEPER ROOMS (${t.length}) ---`);
    for (const o of t.sort((o, e) => o.room.localeCompare(e.room))) {
      l.push(`  ${o.room.padEnd(8)} | Src:${o.sources} | Min:${o.mineral || "-"}`);
    }
    l.push("");
  }
  if (a.length > 0) {
    l.push(`--- HIGHWAY / INTERSECTION ROOMS (${a.length}) ---`);
    l.push(`  ${a.length} highway/intersection rooms scanned.`);
    l.push("");
  }
  if (s.length > 0) {
    l.push(`--- UNCLAIMED ROOMS (${s.length}) ---`);
    for (const o of s.sort((o, e) => o.room.localeCompare(e.room))) {
      l.push(`  ${o.room.padEnd(8)} | Src:${o.sources} | Min:${o.mineral || "-"}`);
    }
    l.push("");
  }
  l.push("================================================================");
  return l;
}

function sendChunkedNotify(o) {
  const e = [];
  let n = "";
  for (const s of o) {
    const o = n.length === 0 ? s : n + "\n" + s;
    if (o.length > NOTIFY_CHUNK_MAX) {
      if (n.length > 0) e.push(n);
      n = s;
    } else {
      n = o;
    }
  }
  if (n.length > 0) e.push(n);
  const s = e.length;
  for (let o = 0; o < s; o++) {
    Game.notify(`[LocalMap ${o + 1}/${s}]\n${e[o]}`, 0);
  }
}

function completeScan() {
  const o = Memory.localMap;
  if (!o) return;
  const e = Game.time - o.startTick;
  const n = buildReportLines(o.results, e);
  for (const o of n) console.log(o);
  sendChunkedNotify(n);
  delete Memory.localMapResults;
  delete Memory.localMap;
}

module.exports = {
  start: startLocalMap,
  run: run,
  cancel: cancelLocalMap,
  status: getLocalMapStatus
};
global.localMap = startLocalMap;
global.localMap.start = startLocalMap;
global.localMap.run = run;
global.localMap.cancel = cancelLocalMap;
global.localMap.status = getLocalMapStatus;
global.localMapCancel = cancelLocalMap;
