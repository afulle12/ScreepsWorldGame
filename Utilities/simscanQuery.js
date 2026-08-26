// LLM: Read docs/codex.js before reviewing or changing this file.
// simscanQuery.js
// Console globals: simScanStart, simScanStatus, simScanAbort, simScanReset
// Example: simScanStart('E1N1') - Start background simulation scan for room
// Example: simScanStatus() - Display progress and results of sim scan
// Example: simScanAbort() - Abort currently running sim scan
// Example: simScanReset() - Clear cached sim scan data
//   simScanStart('E1N1')          Scan one room.
//   simScanStart('E1N1', 'block') Scan the room's 9x9 sector interior.
//   simScanStatus()               Print scan and export progress.
//   simScanAbort()                Stop the active scan and discard runtime data.
//   simScanReset()                Remove all simscan Memory and runtime data.
//   Memory.__simScan = {
//     enabled: true,
//     scope: 'rect',
//     sw: 'E1N41',
//     ne: 'E9N49',
//     command: 'start'
//   };
"use strict";
const memoryManager = require("memoryManager");
const scanner = require("scanner");
const SCHEMA_VERSION = "1.0.0";
const PROTOCOL = "simscan-console-v1";
const OBSERVER_PRIORITY = 99;
const CHUNK_SIZE = 8e3;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function runtime() {
  return memoryManager.heap.simscan;
}

function parseRoomName(e) {
  const o = /^([EW])(\d+)([NS])(\d+)$/.exec(e);
  if (!o) return null;
  return {
    x: (o[1] === "W" ? -1 : 1) * Number(o[2]),
    y: (o[3] === "S" ? -1 : 1) * Number(o[4])
  };
}

function formatRoomName(e) {
  const o = e.x < 0 ? "W" + Math.abs(e.x) : "E" + e.x;
  const t = e.y < 0 ? "S" + Math.abs(e.y) : "N" + e.y;
  return o + t;
}

function sectorBounds(e) {
  const o = parseRoomName(e);
  if (!o) return null;
  const t = Math.floor(o.x / 10) * 10;
  const n = Math.floor(o.y / 10) * 10;
  return {
    sw: formatRoomName({
      x: t + 1,
      y: n + 1
    }),
    ne: formatRoomName({
      x: t + 9,
      y: n + 9
    })
  };
}

function roomsInRect(e, o) {
  const t = parseRoomName(e);
  const n = parseRoomName(o);
  if (!t || !n) return [];
  const s = [];
  for (let e = Math.min(t.x, n.x); e <= Math.max(t.x, n.x); e++) {
    for (let o = Math.min(t.y, n.y); o <= Math.max(t.y, n.y); o++) {
      s.push(formatRoomName({
        x: e,
        y: o
      }));
    }
  }
  return s.sort((e, o) => e.localeCompare(o));
}

function resolveTargets(e, o, t) {
  if (o === "room") return {
    sw: e,
    ne: e,
    rooms: [ e ]
  };
  if (o === "block") {
    const o = sectorBounds(e);
    return {
      sw: o.sw,
      ne: o.ne,
      rooms: roomsInRect(o.sw, o.ne)
    };
  }
  if (o === "rect" && t && t.sw && t.ne) {
    return {
      sw: t.sw,
      ne: t.ne,
      rooms: roomsInRect(t.sw, t.ne)
    };
  }
  throw new Error('scope must be "room" or "block"');
}

function encodeBase64(e) {
  let o = "";
  for (let t = 0; t < e.length; t += 3) {
    const n = e[t];
    const s = t + 1 < e.length;
    const r = t + 2 < e.length;
    const a = s ? e[t + 1] : 0;
    const c = r ? e[t + 2] : 0;
    o += BASE64[n >> 2];
    o += BASE64[(n & 3) << 4 | a >> 4];
    o += s ? BASE64[(a & 15) << 2 | c >> 6] : "=";
    o += r ? BASE64[c & 63] : "=";
  }
  return o;
}

function utf8Bytes(e) {
  const o = [];
  for (let t = 0; t < e.length; t++) {
    let n = e.charCodeAt(t);
    if (n < 128) {
      o.push(n);
    } else if (n < 2048) {
      o.push(192 | n >> 6, 128 | n & 63);
    } else if (n >= 55296 && n <= 56319 && t + 1 < e.length) {
      const s = e.charCodeAt(++t);
      n = 65536 + ((n & 1023) << 10) + (s & 1023);
      o.push(240 | n >> 18, 128 | n >> 12 & 63, 128 | n >> 6 & 63, 128 | n & 63);
    } else {
      o.push(224 | n >> 12, 128 | n >> 6 & 63, 128 | n & 63);
    }
  }
  return o;
}

function encodeTerrain(e) {
  const o = Game.map.getRoomTerrain(e);
  const t = new Uint8Array(2500);
  for (let e = 0; e < 50; e++) {
    for (let n = 0; n < 50; n++) {
      const s = o.get(n, e);
      t[e * 50 + n] = s & TERRAIN_MASK_WALL ? 1 : s & TERRAIN_MASK_SWAMP ? 2 : 0;
    }
  }
  return {
    encoding: "bytes-base64",
    width: 50,
    height: 50,
    data: encodeBase64(t)
  };
}

function put(e, o, t) {
  if (t !== undefined && t !== null) e[o] = t;
}

function position(e, o) {
  put(e, "id", o.id);
  e.x = o.pos.x;
  e.y = o.pos.y;
  return e;
}

function storeObject(e) {
  if (!e) return undefined;
  const o = {};
  for (const t of Object.keys(e)) {
    const n = e[t];
    if (typeof n === "number" && n !== 0) o[t] = n;
  }
  return o;
}

function addStore(e, o) {
  if (!o.store) return;
  e.store = storeObject(o.store);
  if (typeof o.store.getCapacity === "function") {
    const t = o.store.getCapacity();
    if (typeof t === "number") e.storeCapacity = t;
  }
}

function mapController(e) {
  if (!e) return null;
  const o = position({
    level: e.level || 0
  }, e);
  put(o, "progress", e.progress);
  put(o, "downgrade", e.ticksToDowngrade);
  put(o, "safeMode", e.safeMode);
  if (e.reservation) {
    o.reservation = {};
    put(o.reservation, "username", e.reservation.username);
    put(o.reservation, "ticksToEnd", e.reservation.ticksToEnd);
  }
  return o;
}

function mapSource(e) {
  const o = position({}, e);
  put(o, "energy", e.energy);
  put(o, "ticksToRegeneration", e.ticksToRegeneration);
  return o;
}

function mapMineral(e) {
  const o = position({
    mineralType: e.mineralType
  }, e);
  put(o, "density", e.density);
  put(o, "amount", e.mineralAmount);
  return o;
}

function mapStructure(e) {
  const o = position({
    structureType: e.structureType
  }, e);
  put(o, "hits", e.hits);
  put(o, "hitsMax", e.hitsMax);
  put(o, "cooldown", e.cooldown);
  addStore(o, e);
  return o;
}

function mapSite(e) {
  const o = position({
    structureType: e.structureType
  }, e);
  put(o, "progress", e.progress);
  put(o, "progressTotal", e.progressTotal);
  return o;
}

function mapTombstone(e) {
  const o = position({}, e);
  put(o, "deathTime", e.deathTime);
  if (e.creep) put(o, "creepId", e.creep.id);
  addStore(o, e);
  return o;
}

function mapRuin(e) {
  const o = position({}, e);
  if (e.structure) put(o, "structureType", e.structure.structureType);
  put(o, "destroyTime", e.destroyTime);
  addStore(o, e);
  return o;
}

function mapResource(e) {
  const o = position({
    resourceType: e.resourceType,
    amount: e.amount
  }, e);
  return o;
}

function portalDestination(e) {
  const o = e.destination;
  if (!o) return undefined;
  if (typeof o === "string") return o;
  if (o.roomName) return o.roomName + ":" + o.x + ":" + o.y;
  if (o.shard && o.room) return o.shard + ":" + o.room;
  return undefined;
}

function roomMode(e) {
  try {
    const o = Game.map.getRoomStatus(e);
    return o && o.status ? o.status : "normal";
  } catch (e) {
    return "normal";
  }
}

function scanRoom(e, o) {
  const t = o.find(FIND_STRUCTURES);
  const n = [];
  const s = [];
  const r = [];
  const a = [];
  for (const e of t) {
    if (e.structureType === STRUCTURE_KEEPER_LAIR) {
      const o = position({}, e);
      put(o, "ticksToSpawn", e.ticksToSpawn);
      n.push(o);
    } else if (e.structureType === STRUCTURE_INVADER_CORE) {
      const o = position({}, e);
      put(o, "level", e.level);
      s.push(o);
    } else if (e.structureType === STRUCTURE_PORTAL) {
      const o = position({}, e);
      put(o, "destination", portalDestination(e));
      a.push(o);
    } else if (e.structureType === STRUCTURE_CONTROLLER) {
      continue;
    } else {
      r.push(mapStructure(e));
    }
  }
  const c = {
    name: e,
    mode: roomMode(e)
  };
  const i = o.controller;
  if (i && i.owner) c.owner = i.owner.username;
  if (i && i.reservation) c.reserved = i.reservation.username;
  return {
    schemaVersion: SCHEMA_VERSION,
    scannedAt: scanTimestamp(),
    room: c,
    visibility: "full",
    static: {
      terrain: encodeTerrain(e)
    },
    strategic: {
      controller: mapController(i),
      sources: o.find(FIND_SOURCES).map(mapSource),
      minerals: o.find(FIND_MINERALS).map(mapMineral),
      keeperLairs: n,
      invaderCores: s
    },
    ephemeral: {
      structures: r,
      constructionSites: o.find(FIND_CONSTRUCTION_SITES).map(mapSite),
      creeps: [],
      tombstones: o.find(FIND_TOMBSTONES).map(mapTombstone),
      ruins: o.find(FIND_RUINS).map(mapRuin),
      resources: o.find(FIND_DROPPED_RESOURCES).map(mapResource),
      portals: a
    },
    meta: {
      scanMethod: "console",
      checksum: null,
      notes: "Creeps and power creeps intentionally omitted."
    }
  };
}

function scanTimestamp() {
  let e = EPOCH_ISO;
  try {
    e = (new Date).toISOString();
  } catch (e) {}
  return {
    tick: Game.time,
    iso: e
  };
}

function fail(e) {
  const o = Memory.__simScan;
  if (o) {
    cancelRequests(o);
    o.enabled = false;
    o.status = "error";
    o.requested = {};
    o.error = e;
  }
  console.log("simscan: ERROR: " + e);
  return e;
}

function rejectStart(e) {
  console.log("simscan: ERROR: " + e);
  return e;
}

function cancelRequests(e) {
  if (!e || !e.requested) return;
  for (const o of Object.keys(e.requested)) scanner.observe.cancel(o, "simscan");
}

function skipBlockRoom(e, o, t) {
  if (e.completed[o]) return;
  e.completed[o] = Game.time;
  e.completedCount++;
  e.skipped.push(o);
  e.skipReasons[o] = t;
  delete e.requested[o];
  scanner.observe.cancel(o, "simscan");
  console.log("simscan: WARNING: skipping " + o + ": " + t);
}

function start(e, o, t) {
  o = o || "room";
  t = t || {};
  if (o !== "room" && o !== "block" && o !== "rect") {
    return rejectStart('scope must be "room", "block", or "rect"');
  }
  if (o === "rect") {
    if (!parseRoomName(t.sw) || !parseRoomName(t.ne)) {
      return rejectStart("rect scope requires valid sw and ne room names");
    }
    e = parseRoomName(e) ? e : t.sw;
  } else if (!parseRoomName(e)) {
    return rejectStart("invalid room name: " + e);
  }
  let n;
  try {
    n = resolveTargets(e, o, t);
  } catch (e) {
    return rejectStart(e.message);
  }
  if (t.home && t.maxDistanceFromHome !== undefined) {
    const o = parseRoomName(t.home);
    const n = parseRoomName(e);
    const s = Number(t.maxDistanceFromHome);
    if (!o || !Number.isFinite(s) || s < 0) {
      return rejectStart("home and maxDistanceFromHome must be valid");
    }
    const r = Math.max(Math.abs(o.x - n.x), Math.abs(o.y - n.y));
    if (r > s) {
      return rejectStart(e + " is " + r + " rooms from " + t.home + ", beyond maxDistanceFromHome " + s);
    }
  }
  const s = n.rooms.filter(e => !Game.rooms[e] && !scanner.observe.inRange(e));
  if (s.length && o !== "block") {
    return rejectStart("no observer coverage for: " + s.join(", "));
  }
  if (s.length === n.rooms.length) {
    return rejectStart("no rooms in this block have observer coverage");
  }
  if (Memory.__simScan) cancelRequests(Memory.__simScan);
  const r = Game.time + ":" + e + ":" + o;
  Memory.__simScan = {
    enabled: true,
    scope: o,
    room: e,
    status: "scanning",
    roomNames: n.rooms,
    sw: n.sw,
    ne: n.ne,
    nextRoom: 0,
    requested: {},
    completed: {},
    completedCount: 0,
    skipped: [],
    skipReasons: {},
    startedTick: Game.time,
    token: r,
    export: null,
    error: null
  };
  if (Number(t.roomsPerTick) > 0) {
    Memory.__simScan.roomsPerTick = Math.floor(Number(t.roomsPerTick));
  }
  for (const e of s) {
    skipBlockRoom(Memory.__simScan, e, "no observer coverage");
  }
  memoryManager.heap.simscan = {
    token: r,
    rooms: {},
    payload: null,
    transfer: null
  };
  console.log("simscan: started " + o + " scan for " + e + " (" + n.rooms.length + " rooms)");
  if (s.length) {
    console.log("simscan: WARNING: partial block scan; " + s.length + " room(s) lack observer coverage");
  }
  return "simscan started";
}

function buildBlock(e, o) {
  const t = scanTimestamp();
  const n = e.roomNames.map(e => o.rooms[e]).filter(Boolean);
  const s = e.scope === "block" ? "sector" : e.scope === "rect" ? "rect" : "single";
  const r = e.skipped || [];
  const a = "Block scannedAt is export finalization time; creeps and power creeps are omitted." + (r.length ? " WARNING: partial scan; " + r.length + " room(s) were skipped." : "");
  return {
    schemaVersion: SCHEMA_VERSION,
    scannedAt: t,
    block: {
      mode: s,
      anchor: e.room,
      sw: e.sw,
      ne: e.ne,
      roomNames: e.roomNames.slice()
    },
    rooms: n,
    meta: {
      scanMethod: "console",
      scannerName: "screeps-bot-simscan",
      scannerVersion: "1.0.0",
      checksum: null,
      notes: a,
      skipped: r.slice()
    }
  };
}

function prepareExport(e, o) {
  o.payload = buildBlock(e, o);
  const t = JSON.stringify(o.payload);
  const n = utf8Bytes(t);
  const s = encodeBase64(n);
  const r = [];
  for (let e = 0; e < s.length; e += CHUNK_SIZE) r.push(s.slice(e, e + CHUNK_SIZE));
  const a = "blk_" + Game.time + "_" + e.sw + "_" + e.ne;
  o.transfer = {
    json: t,
    chunks: r,
    blockId: a,
    byteLength: n.length
  };
  e.export = {
    blockId: a,
    totalChunks: r.length
  };
  e.status = "exporting";
}

function emitExport(e, o) {
  const t = o.transfer;
  const n = e.export;
  if (!t || !n || t.blockId !== n.blockId) {
    fail("export payload was lost after a global reset; start a new scan");
    return;
  }
  const s = [];
  if (e.skipped && e.skipped.length) {
    const o = e.skipped.map(o => o + " (" + e.skipReasons[o] + ")");
    s.push("simscan: WARNING: partial block export; skipped rooms: " + o.join(", "));
  }
  s.push("###SIMSCAN_BEGIN### " + JSON.stringify({
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    blockId: t.blockId,
    totalChunks: t.chunks.length,
    byteLength: t.byteLength,
    contentEncoding: "utf8-json",
    transferEncoding: "base64"
  }));
  for (let e = 0; e < t.chunks.length; e++) {
    s.push("###SIMSCAN_CHUNK### " + JSON.stringify({
      blockId: t.blockId,
      index: e,
      total: t.chunks.length,
      data: t.chunks[e]
    }));
  }
  s.push("###SIMSCAN_END### " + JSON.stringify({
    blockId: t.blockId,
    totalChunks: t.chunks.length,
    ok: true
  }));
  console.log(s.join("\n"));
  delete Memory.__simScan;
  delete memoryManager.heap.simscan;
  memoryManager.requestImmediateSave("simscanQuery.complete");
}

function fillObserverQueue(e) {
  const o = Number(e.roomsPerTick);
  const t = o > 0 ? Math.floor(o) : Infinity;
  let n = Object.keys(e.requested).length;
  for (const o of Object.keys(e.requested)) {
    if (!scanner.observe.request(o, "simscan", OBSERVER_PRIORITY)) {
      if (e.scope === "block") {
        skipBlockRoom(e, o, "observer coverage lost");
        continue;
      }
      fail("observer coverage lost for " + o);
      return;
    }
  }
  while (n < t && e.nextRoom < e.roomNames.length) {
    const o = e.roomNames[e.nextRoom++];
    if (e.completed[o]) continue;
    if (Game.rooms[o]) continue;
    if (!scanner.observe.request(o, "simscan", OBSERVER_PRIORITY)) {
      if (e.scope === "block") {
        skipBlockRoom(e, o, "observer coverage lost");
        continue;
      }
      fail("observer coverage lost for " + o);
      return;
    }
    e.requested[o] = Game.time;
    n++;
  }
}

function runScan(e, o) {
  for (const t of e.roomNames) {
    if (e.completed[t]) continue;
    const n = Game.rooms[t];
    if (!n) continue;
    try {
      o.rooms[t] = scanRoom(t, n);
    } catch (o) {
      if (e.scope === "block") {
        skipBlockRoom(e, t, "scan failed: " + (o.message || o));
        continue;
      }
      fail("failed to scan " + t + ": " + (o.stack || o.message || o));
      return;
    }
    e.completed[t] = Game.time;
    e.completedCount++;
    delete e.requested[t];
    console.log("simscan: " + t + " " + e.completedCount + "/" + e.roomNames.length);
  }
  if (e.completedCount === e.roomNames.length) {
    prepareExport(e, o);
    return;
  }
  fillObserverQueue(e);
}

function run() {
  const e = Memory.__simScan;
  if (!e || !e.enabled) return;
  if (!e.skipped) e.skipped = [];
  if (!e.skipReasons) e.skipReasons = {};
  if (e.command) {
    const o = e.command;
    delete e.command;
    if (o === "abort") return abort();
    if (o === "reset") return reset();
    if (o === "start") return start(e.room, e.scope, e);
  }
  const o = runtime();
  if ((e.status === "scanning" || e.status === "exporting") && (!o || o.token !== e.token)) {
    fail("runtime payload was lost after a global reset; start a new scan");
    return;
  }
  if (e.status === "scanning") runScan(e, o); else if (e.status === "exporting") emitExport(e, o);
}

function status() {
  const e = Memory.__simScan;
  if (!e) return "simscan: idle";
  const o = {
    status: e.status,
    scope: e.scope,
    room: e.room,
    completed: e.completedCount || 0,
    skipped: e.skipped ? e.skipped.length : 0,
    total: e.roomNames ? e.roomNames.length : 0,
    inFlight: e.requested ? Object.keys(e.requested).length : 0,
    export: e.export,
    error: e.error
  };
  console.log("simscan: " + JSON.stringify(o));
  return o;
}

function abort() {
  const e = Memory.__simScan;
  cancelRequests(e);
  if (e) {
    e.enabled = false;
    e.status = "idle";
    e.requested = {};
    e.error = null;
  }
  delete memoryManager.heap.simscan;
  return "simscan: aborted";
}

function reset() {
  cancelRequests(Memory.__simScan);
  delete Memory.__simScan;
  delete memoryManager.heap.simscan;
  return "simscan: reset";
}

global.simScanStart = start;
global.simScanStatus = status;
global.simScanAbort = abort;
global.simScanReset = reset;
module.exports = {
  run: run,
  start: start,
  status: status,
  abort: abort,
  reset: reset,
  parseRoomName: parseRoomName,
  formatRoomName: formatRoomName,
  sectorBounds: sectorBounds,
  roomsInRect: roomsInRect,
  encodeTerrain: encodeTerrain,
  scanRoom: scanRoom
};
