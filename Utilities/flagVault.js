// LLM: Read docs/codex.js before reviewing or changing this file.
// flagVault.js
// Console globals: flagVault
// Example: flagVault('status') - Inspect, test, or manage flag vault storage
//   flagVault.test(1024)                One command: observe, write, read, cleanup
//   flagVault.status()                  Active test / write-queue progress
//   flagVault.list()                    List vault blocks
//   flagVault.remove(id, id)            Delete a block (confirmation must match id)
//   flagVault.config()                  Show room / geometry / reserve settings
//   flagVault.capacity()                Flag budget: used / free / vault / reserve
//   flagVault.put(key, value[, options]) Queue immutable cold write (multi-tick)
//   flagVault.get(key)                  Read by logical key (null if missing/evicted)
//   flagVault.has(key) / flagVault.keys()
//   flagVault.evictOldest(n)            Drop oldest index blocks to free flags
//   flagVault.test(1024)
//   // auto-advances over a few ticks via main.js
//   // prints PASS/FAIL and the example JSON, then removes the test flags
//   flagVault.put('demo', { x: 1 })
//   flagVault.get('demo')
//   // When free slots run low, put() evicts oldest unpinned blocks (FIFO by write tick)
//   flagVault.remove('1ckz74-v7-c8e3e085', '1ckz74-v7-c8e3e085')
const PREFIX = "__VB1.";
const BLOCK_ROOM = "E4N48";
const OBSERVE_SRC = "flagVault";
const TEST_TIMEOUT = 50;
const WRITE_TIMEOUT = 50;
const SHARD_BYTES = 48;
const DATA_SHARDS_PER_STRIPE = 9;
const ATTRIBUTE_BITS = 17;
const ATTRIBUTE_BYTES = Math.ceil((SHARD_BYTES * 8 - ATTRIBUTE_BITS) / 8);
const MAX_FLAG_NAME = 100;
const ORPHAN_TTL = 57600;
const ORPHAN_CAP = 20;
const ORPHAN_MESSAGE_MAX = 80;
const ORPHAN_SCAN_INTERVAL = 100;
// createFlag is a 0.2 CPU intent, so staging a whole block in one tick costs
// 0.2 * shardCount -- a multi-kilobyte block spiked ~20 CPU on the write tick.
// The write is already asynchronous, so spread the intents over several ticks.
const STAGE_FLAGS_PER_TICK = 20;
let lastOrphanPruneTick = 0;
const MAX_FLAGS = 1e4;
const CONVENTIONAL_RESERVE = 100;
const MAX_USED_FLAGS = MAX_FLAGS - CONVENTIONAL_RESERVE;
const MAX_LOGICAL_KEY = 64;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
let crcTable = null;
let flagIndexTick = -1;
let flagsByBlock = Object.create(null);
let flagScanTotal = 0;
let flagScanVault = 0;
const PARSED_NAME_CACHE_CAP = 3e4;
let parsedNameCache = Object.create(null);
let parsedNameCacheSize = 0;
const decodedBlockCache = Object.create(null);
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let e = 0; e < 256; e++) {
    let t = e;
    for (let e = 0; e < 8; e++) {
      t = t & 1 ? 3988292384 ^ t >>> 1 : t >>> 1;
    }
    crcTable[e] = t >>> 0;
  }
  return crcTable;
}

function crc32(e) {
  const t = getCrcTable();
  let r = 4294967295;
  for (let n = 0; n < e.length; n++) r = t[(r ^ e[n]) & 255] ^ r >>> 8;
  return (r ^ 4294967295) >>> 0;
}

function crcHex(e) {
  return crc32(e).toString(16).padStart(8, "0");
}

function utf8Encode(e) {
  const t = [];
  for (let r = 0; r < e.length; r++) {
    let n = e.charCodeAt(r);
    if (n < 128) {
      t.push(n);
    } else if (n < 2048) {
      t.push(192 | n >> 6, 128 | n & 63);
    } else if (n >= 55296 && n <= 56319 && r + 1 < e.length) {
      const o = e.charCodeAt(r + 1);
      if (o >= 56320 && o <= 57343) {
        r++;
        n = 65536 + ((n & 1023) << 10) + (o & 1023);
        t.push(240 | n >> 18, 128 | n >> 12 & 63, 128 | n >> 6 & 63, 128 | n & 63);
      } else {
        t.push(239, 191, 189);
      }
    } else if (n >= 56320 && n <= 57343) {
      t.push(239, 191, 189);
    } else {
      t.push(224 | n >> 12, 128 | n >> 6 & 63, 128 | n & 63);
    }
  }
  return new Uint8Array(t);
}

function utf8Decode(e) {
  let t = "";
  for (let r = 0; r < e.length; ) {
    const n = e[r++];
    let o;
    if (n < 128) {
      o = n;
    } else if ((n & 224) === 192 && r < e.length) {
      o = (n & 31) << 6 | e[r++] & 63;
    } else if ((n & 240) === 224 && r + 1 < e.length) {
      o = (n & 15) << 12 | (e[r++] & 63) << 6 | e[r++] & 63;
    } else if ((n & 248) === 240 && r + 2 < e.length) {
      o = (n & 7) << 18 | (e[r++] & 63) << 12 | (e[r++] & 63) << 6 | e[r++] & 63;
    } else {
      o = 65533;
    }
    if (o <= 65535) t += String.fromCharCode(o); else {
      o -= 65536;
      t += String.fromCharCode(55296 | o >> 10, 56320 | o & 1023);
    }
  }
  return t;
}

function encodeBase64url(e) {
  let t = "";
  for (let r = 0; r < e.length; r += 3) {
    const n = e[r];
    const o = r + 1 < e.length;
    const s = r + 2 < e.length;
    const a = o ? e[r + 1] : 0;
    const i = s ? e[r + 2] : 0;
    t += BASE64URL[n >> 2];
    t += BASE64URL[(n & 3) << 4 | a >> 4];
    if (o) t += BASE64URL[(a & 15) << 2 | i >> 6];
    if (s) t += BASE64URL[i & 63];
  }
  return t;
}

function decodeBase64url(e) {
  if (!/^[A-Za-z0-9_-]*$/.test(e)) throw new Error("invalid Base64url payload");
  const t = [];
  let r = 0;
  let n = 0;
  for (let o = 0; o < e.length; o++) {
    const s = BASE64URL.indexOf(e[o]);
    r = r << 6 | s;
    n += 6;
    if (n >= 8) {
      n -= 8;
      t.push(r >>> n & 255);
    }
  }
  const o = new Uint8Array(t);
  if (encodeBase64url(o) !== e) throw new Error("non-canonical Base64url payload");
  return o;
}

function getBit(e, t) {
  return e[t >> 3] >>> 7 - (t & 7) & 1;
}

function setBit(e, t, r) {
  if (r) e[t >> 3] |= 1 << 7 - (t & 7);
}

function encodeShard(e) {
  let t = 0;
  for (let r = 0; r < ATTRIBUTE_BITS; r++) t = t << 1 | getBit(e, r);
  const r = new Uint8Array(ATTRIBUTE_BYTES);
  for (let t = ATTRIBUTE_BITS; t < SHARD_BYTES * 8; t++) {
    setBit(r, t - ATTRIBUTE_BITS, getBit(e, t));
  }
  const n = t & 2047;
  const o = t >>> 11;
  return {
    x: n % 50,
    y: Math.floor(n / 50),
    color: Math.floor(o / 10) + 1,
    secondaryColor: o % 10 + 1,
    payload: encodeBase64url(r)
  };
}

function decodeShard(e, t, r) {
  if (!e || !e.pos || e.pos.roomName !== r) {
    throw new Error("flag is outside block room " + r);
  }
  const n = e.pos.y * 50 + e.pos.x;
  if (n < 0 || n >= 2048) throw new Error("flag position is outside the data table");
  const o = (e.color - 1) * 10 + (e.secondaryColor - 1);
  if (e.color < 1 || e.color > 7 || e.secondaryColor < 1 || e.secondaryColor > 10 || o >= 64) {
    throw new Error("flag colors are outside the data table");
  }
  const s = decodeBase64url(t);
  if (s.length !== ATTRIBUTE_BYTES) throw new Error("invalid packed shard length");
  const a = new Uint8Array(SHARD_BYTES);
  const i = o << 11 | n;
  for (let e = 0; e < ATTRIBUTE_BITS; e++) setBit(a, e, i >>> 16 - e & 1);
  for (let e = ATTRIBUTE_BITS; e < SHARD_BYTES * 8; e++) {
    setBit(a, e, getBit(s, e - ATTRIBUTE_BITS));
  }
  return a;
}

function getScanner() {
  try {
    return require("scanner");
  } catch (e) {
    return null;
  }
}

function requestVision(e) {
  const t = getScanner();
  if (!t || !t.observe) {
    return {
      room: e,
      visible: !!Game.rooms[e],
      requested: false,
      inRange: null,
      error: "scanner.observe unavailable"
    };
  }
  if (Game.rooms[e]) {
    return {
      room: e,
      visible: true,
      requested: false,
      inRange: true
    };
  }
  const r = !!t.observe.inRange(e);
  if (!r) {
    return {
      room: e,
      visible: false,
      requested: false,
      inRange: false,
      error: "no observer in range of " + e
    };
  }
  const n = t.observe.PRI && t.observe.PRI.ONESHOT || 100;
  const o = !!t.observe.request(e, OBSERVE_SRC, n);
  return {
    room: e,
    visible: false,
    requested: o,
    inRange: true,
    next: 'Retry next tick after scanner dispatches observeRoom("' + e + '").'
  };
}

function observe(e) {
  e = e == null || e === "" ? BLOCK_ROOM : e;
  if (typeof e !== "string" || !/^[WE]\d+[NS]\d+$/.test(e)) {
    throw new Error("invalid room name: " + e);
  }
  return requestVision(e);
}

function ready(e) {
  e = e == null || e === "" ? BLOCK_ROOM : e;
  const t = getScanner();
  const r = t && t.observe ? !!t.observe.inRange(e) : null;
  return {
    room: e,
    visible: !!Game.rooms[e],
    inRange: r,
    ready: !!Game.rooms[e],
    next: Game.rooms[e] ? "Room is visible. Run flagVault.stageTest(1024)." : "Run flagVault.observe() and wait one tick."
  };
}

function resolveRoom(e) {
  if (e == null || e === "") e = BLOCK_ROOM;
  if (typeof e !== "string" || !/^[WE]\d+[NS]\d+$/.test(e)) {
    throw new Error("invalid room name: " + e);
  }
  if (Game.rooms[e]) return e;
  const t = requestVision(e);
  if (t.inRange === false) {
    throw new Error("room is outside observer range: " + e);
  }
  if (t.error && t.inRange == null) {
    throw new Error(t.error);
  }
  throw new Error("room is not currently visible: " + e + ". Observer requested via scanner. Wait one tick, confirm flagVault.ready(), then retry.");
}

function blockRoom(e) {
  if (!e.length) throw new Error("block has no flags");
  const t = e[0].flag.pos && e[0].flag.pos.roomName;
  if (!t) throw new Error("block flag is missing position room");
  for (let r = 1; r < e.length; r++) {
    if (e[r].flag.pos.roomName !== t) {
      throw new Error("block flags span multiple rooms: " + t + " and " + e[r].flag.pos.roomName);
    }
  }
  return t;
}

function xorInto(e, t) {
  for (let r = 0; r < SHARD_BYTES; r++) e[r] ^= t[r];
}

function parseId(e) {
  const t = /^([0-9a-z]+)-([0-9a-z]+)-([0-9a-f]{8})$/.exec(e || "");
  if (!t) throw new Error("invalid block id");
  const r = parseInt(t[2], 36);
  if (!Number.isSafeInteger(r) || r < 0) throw new Error("invalid block length");
  return {
    id: e,
    tick: parseInt(t[1], 36),
    length: r,
    crc: t[3]
  };
}

function parseFlagName(e) {
  if (typeof e !== "string" || !e.startsWith(PREFIX)) return null;
  let t = /^__VB1\.([0-9a-z]+-[0-9a-z]+-[0-9a-f]{8})\.D\.([0-9a-z]+)\.([0-8])\.([A-Za-z0-9_-]+)$/.exec(e);
  if (t) return {
    id: t[1],
    type: "data",
    stripe: parseInt(t[2], 36),
    shard: parseInt(t[3], 10),
    payload: t[4]
  };
  t = /^__VB1\.([0-9a-z]+-[0-9a-z]+-[0-9a-f]{8})\.P\.([0-9a-z]+)\.([A-Za-z0-9_-]+)$/.exec(e);
  if (t) return {
    id: t[1],
    type: "parity",
    stripe: parseInt(t[2], 36),
    payload: t[3]
  };
  t = /^__VB1\.([0-9a-z]+-[0-9a-z]+-[0-9a-f]{8})\.C\.([0-9a-z]+)\.([0-9a-z]+)$/.exec(e);
  if (t) return {
    id: t[1],
    type: "commit",
    dataCount: parseInt(t[2], 36),
    stripeCount: parseInt(t[3], 36)
  };
  return {
    malformed: true,
    name: e
  };
}

// Flag names are immutable, so the three regexes parseFlagName runs are pure
// per name and worth remembering across ticks; only the Flag object bindings
// have to be rebuilt.
function parseFlagNameCached(e) {
  let t = parsedNameCache[e];
  if (t !== undefined) return t;
  if (parsedNameCacheSize >= PARSED_NAME_CACHE_CAP) {
    parsedNameCache = Object.create(null);
    parsedNameCacheSize = 0;
  }
  t = parseFlagName(e);
  parsedNameCache[e] = t;
  parsedNameCacheSize++;
  return t;
}

// One pass over Game.flags per tick serves both the block index and the flag
// budget. capacity() used to walk the whole collection twice on its own, and
// the stage phase calls it three times in a tick.
function scanFlags() {
  if (flagIndexTick === Game.time) return;
  const e = Object.create(null);
  let t = 0;
  let r = 0;
  for (const n in Game.flags) {
    t++;
    if (n.charCodeAt(0) !== 95 || !n.startsWith(PREFIX)) continue;
    r++;
    const o = parseFlagNameCached(n);
    if (!o || !o.id) continue;
    if (!e[o.id]) e[o.id] = [];
    e[o.id].push({
      flag: Game.flags[n],
      parsed: o
    });
  }
  flagsByBlock = e;
  flagScanTotal = t;
  flagScanVault = r;
  flagIndexTick = Game.time;
}

// createFlag/remove are intents: Game.flags does not change until next tick, so
// a per-tick count is exact, not merely close.
function usedFlagCount() {
  scanFlags();
  return flagScanTotal;
}

function flagsForBlock(e) {
  scanFlags();
  return flagsByBlock[e] ? flagsByBlock[e].slice() : [];
}

function expectedGeometry(e) {
  const t = Math.ceil(e / SHARD_BYTES);
  return {
    dataCount: t,
    stripeCount: Math.ceil(t / DATA_SHARDS_PER_STRIPE)
  };
}

function decodeBlock(e, t, r) {
  const n = parseId(e);
  const o = expectedGeometry(n.length);
  const s = flagsForBlock(e);
  if (!s.length) throw new Error("block has no flags: " + e);
  const a = blockRoom(s);
  const i = {};
  const l = {};
  let u = 0;
  const c = [];
  for (let e = 0; e < s.length; e++) {
    const t = s[e];
    const r = t.parsed;
    if (r.type === "commit") {
      u++;
      if (r.dataCount !== o.dataCount || r.stripeCount !== o.stripeCount || t.flag.pos.roomName !== a || t.flag.pos.x !== 49 || t.flag.pos.y !== 49 || t.flag.color !== 10 || t.flag.secondaryColor !== 10) {
        c.push("invalid commit flag");
      }
    } else if (r.type === "data") {
      const e = r.stripe < o.stripeCount ? Math.min(DATA_SHARDS_PER_STRIPE, o.dataCount - r.stripe * DATA_SHARDS_PER_STRIPE) : 0;
      if (r.stripe < 0 || r.stripe >= o.stripeCount || r.shard >= e) {
        c.push("data shard outside expected geometry: " + r.stripe + ":" + r.shard);
        continue;
      }
      const n = r.stripe + ":" + r.shard;
      if (i[n]) c.push("duplicate data shard " + n); else i[n] = t;
    } else if (r.type === "parity") {
      if (r.stripe < 0 || r.stripe >= o.stripeCount) {
        c.push("parity shard outside expected geometry: " + r.stripe);
        continue;
      }
      if (l[r.stripe]) c.push("duplicate parity shard " + r.stripe); else l[r.stripe] = t;
    }
  }
  if (t && u !== 1) c.push(u ? "multiple commit flags" : "block is not committed");
  if (c.length) throw new Error(c.join("; "));
  const f = new Array(o.dataCount);
  let d = 0;
  for (let e = 0; e < o.stripeCount; e++) {
    const t = e * DATA_SHARDS_PER_STRIPE;
    const n = Math.min(DATA_SHARDS_PER_STRIPE, o.dataCount - t);
    const s = new Array(n);
    const u = [];
    for (let t = 0; t < n; t++) {
      const r = i[e + ":" + t];
      if (!r) {
        u.push(t);
        continue;
      }
      try {
        s[t] = decodeShard(r.flag, r.parsed.payload, a);
      } catch (e) {
        u.push(t);
      }
    }
    let c = null;
    if (l[e]) {
      try {
        c = decodeShard(l[e].flag, l[e].parsed.payload, a);
      } catch (e) {}
    }
    if (r && (u.length || !c)) {
      throw new Error("stripe " + e + " is incomplete and cannot be committed");
    }
    if (u.length > 1 || u.length === 1 && !c) {
      throw new Error("stripe " + e + " has " + u.length + " unavailable data shards and " + (c ? "valid" : "no valid") + " parity");
    }
    if (u.length === 1) {
      const e = new Uint8Array(c);
      for (let t = 0; t < n; t++) if (s[t]) xorInto(e, s[t]);
      s[u[0]] = e;
      d++;
    } else if (c) {
      const t = new Uint8Array(SHARD_BYTES);
      for (let e = 0; e < n; e++) xorInto(t, s[e]);
      for (let r = 0; r < SHARD_BYTES; r++) {
        if (t[r] !== c[r]) throw new Error("stripe " + e + " parity mismatch");
      }
    }
    for (let e = 0; e < n; e++) f[t + e] = s[e];
  }
  const m = new Uint8Array(n.length);
  let g = 0;
  for (let e = 0; e < f.length && g < m.length; e++) {
    const t = Math.min(SHARD_BYTES, m.length - g);
    m.set(f[e].subarray(0, t), g);
    g += t;
  }
  const h = crcHex(m);
  if (h !== n.crc) throw new Error("CRC mismatch: expected " + n.crc + ", got " + h);
  return {
    bytes: m,
    recovered: d,
    geometry: o,
    committed: u === 1,
    flagCount: s.length,
    room: a
  };
}

function makeFlagSpec(e, t) {
  if (e.length > MAX_FLAG_NAME) throw new Error("flag name is " + e.length + " characters: " + e);
  return {
    name: e,
    x: t.x,
    y: t.y,
    color: t.color,
    secondaryColor: t.secondaryColor
  };
}

function createSpecs(e, t) {
  const r = [];
  for (let n = 0; n < t.length; n++) {
    const o = t[n];
    let s;
    try {
      s = new RoomPosition(o.x, o.y, e).createFlag(o.name, o.color, o.secondaryColor);
    } catch (e) {
      s = e && e.message ? e.message : e;
    }
    r.push({
      name: o.name,
      result: s
    });
  }
  const n = r.filter(function(e) {
    return typeof e.result !== "string";
  });
  return {
    created: r.length - n.length,
    failed: n
  };
}

// options.id resumes an in-progress block (the id embeds the tick it was first
// staged on, so it must be carried across ticks rather than recomputed).
// options.budget caps how many flags this call creates; the caller re-enters on
// later ticks until remaining reaches 0. With neither option the behaviour is
// the original single-tick burst, which is what the console helpers still want.
function stage(e, t, r) {
  t = resolveRoom(t);
  r = r || {};
  const resumeId = r.id || null;
  const json = JSON.stringify(e);
  if (json === undefined) throw new Error("value is not JSON serializable");
  const n = utf8Encode(json);
  if (n.length === 0) throw new Error("empty payload");
  const o = resumeId || Game.time.toString(36) + "-" + n.length.toString(36) + "-" + crcHex(n);
  if (resumeId) {
    // Shard payloads are recomputed from the value on every resume tick, so the
    // value must still hash to the id the earlier shards were named after.
    const prior = parseId(resumeId);
    if (prior.length !== n.length || prior.crc !== crcHex(n)) {
      throw new Error("staged value changed since block " + resumeId + " was started");
    }
  } else if (flagsForBlock(o).length) throw new Error("block already exists: " + o);
  const s = expectedGeometry(n.length);
  const a = [];
  for (let e = 0; e < s.dataCount; e++) {
    const t = new Uint8Array(SHARD_BYTES);
    t.set(n.subarray(e * SHARD_BYTES, (e + 1) * SHARD_BYTES));
    a.push(t);
  }
  const i = [];
  for (let e = 0; e < s.stripeCount; e++) {
    const t = new Uint8Array(SHARD_BYTES);
    const r = Math.min(DATA_SHARDS_PER_STRIPE, s.dataCount - e * DATA_SHARDS_PER_STRIPE);
    for (let n = 0; n < r; n++) {
      const r = a[e * DATA_SHARDS_PER_STRIPE + n];
      const s = encodeShard(r);
      const l = PREFIX + o + ".D." + e.toString(36) + "." + n + "." + s.payload;
      i.push(makeFlagSpec(l, s));
      xorInto(t, r);
    }
    const n = encodeShard(t);
    i.push(makeFlagSpec(PREFIX + o + ".P." + e.toString(36) + "." + n.payload, n));
  }
  const l = new Set(i.map(function(e) {
    return e.name;
  }));
  if (l.size !== i.length) throw new Error("generated duplicate flag names");
  // On a resume, a name that already exists is a shard this queue item created
  // on an earlier tick; on a fresh stage the block-exists check above already
  // ruled that out, so any hit there is a genuine collision.
  const pending = [];
  for (let e = 0; e < i.length; e++) {
    if (Game.flags[i[e].name]) {
      if (resumeId) continue;
      throw new Error("flag name collision: " + i[e].name);
    }
    pending.push(i[e]);
  }
  if (usedFlagCount() + pending.length + 1 > MAX_USED_FLAGS) {
    throw new Error("write would consume the 100-flag conventional reserve");
  }
  const budget = typeof r.budget === "number" && r.budget > 0 ? Math.min(r.budget, pending.length) : pending.length;
  const batch = pending.slice(0, budget);
  const u = createSpecs(t, batch);
  const remaining = pending.length - batch.length;
  return {
    id: o,
    room: t,
    bytes: n.length,
    dataFlags: s.dataCount,
    parityFlags: s.stripeCount,
    totalFlags: i.length,
    created: u.created,
    remaining: remaining,
    failed: u.failed,
    next: u.failed.length ? "Inspect the partial block; do not commit it." : remaining ? "Staging continues over the next " + Math.ceil(remaining / (budget || 1)) + " tick(s)." : 'On a later tick run flagVault.commit("' + o + '")'
  };
}

function stageTest(e, t) {
  e = e == null ? 1024 : Number(e);
  if (!Number.isSafeInteger(e) || e < 128) throw new Error("targetBytes must be an integer of at least 128");
  let r = "";
  const n = "Flag vault test 0123456789 abcdefghijklmnopqrstuvwxyz | ";
  while (utf8Encode(r).length < e) r += n;
  return stage({
    type: "flag-vault-test",
    version: 1,
    unicode: "snowman ☃ rocket 🚀",
    body: r.slice(0, e)
  }, t);
}

function commit(e) {
  const t = decodeBlock(e, false, true);
  if (t.committed) return {
    id: e,
    committed: true,
    room: t.room,
    message: "Block was already committed."
  };
  JSON.parse(utf8Decode(t.bytes));
  if (usedFlagCount() + 1 > MAX_USED_FLAGS) throw new Error("commit would consume the 100-flag conventional reserve");
  if (!Game.rooms[t.room]) {
    requestVision(t.room);
    throw new Error("block room is not currently visible: " + t.room + '. Observer requested via scanner. Wait one tick, confirm flagVault.ready("' + t.room + '"), then retry flagVault.commit("' + e + '").');
  }
  const r = PREFIX + e + ".C." + t.geometry.dataCount.toString(36) + "." + t.geometry.stripeCount.toString(36);
  if (r.length > MAX_FLAG_NAME) throw new Error("commit flag name is too long");
  if (Game.flags[r]) return {
    id: e,
    committed: true,
    room: t.room,
    message: "Commit flag already exists."
  };
  let n;
  try {
    n = new RoomPosition(49, 49, t.room).createFlag(r, 10, 10);
  } catch (e) {
    throw new Error("commit createFlag failed in " + t.room + ": " + (e && e.message ? e.message : e));
  }
  if (typeof n !== "string") {
    throw new Error("commit createFlag failed in " + t.room + ": result=" + n);
  }
  return {
    id: e,
    room: t.room,
    creationResult: n,
    verifiedBytes: t.bytes.length,
    next: 'On a later tick run flagVault.read("' + e + '")'
  };
}

function readBlock(e) {
  const t = decodeBlock(e, true);
  const r = JSON.parse(utf8Decode(t.bytes));
  return {
    id: e,
    bytes: t.bytes.length,
    recoveredShards: t.recovered,
    value: r
  };
}

function inspect(e) {
  parseId(e);
  const t = flagsForBlock(e);
  const r = {
    data: 0,
    parity: 0,
    commit: 0
  };
  const n = {};
  for (let e = 0; e < t.length; e++) {
    const o = t[e].parsed.type;
    if (r[o] != null) r[o]++;
    const s = t[e].flag.pos && t[e].flag.pos.roomName || "unknown";
    n[s] = (n[s] || 0) + 1;
  }
  let o = null;
  try {
    const t = decodeBlock(e, false);
    o = {
      ok: true,
      committed: t.committed,
      bytes: t.bytes.length,
      recoveredShards: t.recovered,
      room: t.room
    };
  } catch (e) {
    o = {
      ok: false,
      error: e.message
    };
  }
  return {
    id: e,
    flags: t.length,
    counts: r,
    rooms: n,
    verification: o
  };
}

function list() {
  const e = {};
  let t = 0;
  for (const r in Game.flags) {
    if (!r.startsWith(PREFIX)) continue;
    const n = parseFlagNameCached(r);
    if (!n || n.malformed) {
      t++;
      continue;
    }
    if (!e[n.id]) {
      e[n.id] = {
        id: n.id,
        data: 0,
        parity: 0,
        commit: 0,
        room: Game.flags[r].pos && Game.flags[r].pos.roomName || null
      };
    }
    e[n.id][n.type]++;
  }
  return {
    blocks: Object.keys(e).sort().map(function(t) {
      return e[t];
    }),
    malformedFlags: t
  };
}

function remove(e, t) {
  parseId(e);
  if (t !== e) throw new Error("destructive confirmation must exactly equal the block id");
  const r = flagsForBlock(e).sort(function(e, t) {
    return (e.parsed.type === "commit" ? -1 : 0) - (t.parsed.type === "commit" ? -1 : 0);
  });
  for (let e = 0; e < r.length; e++) r[e].flag.remove();
  const n = ensureStore();
  for (const t in n.index) {
    if (n.index[t] && n.index[t].id === e) delete n.index[t];
  }
  if (Array.isArray(n.orphans)) {
    n.orphans = n.orphans.filter(function(t) {
      return t && t.id !== e;
    });
  }
  delete decodedBlockCache[e];
  requestStoreSave("flagVault.remove");
  return {
    id: e,
    removalIntents: r.length,
    message: 'Verify removal on a later tick with flagVault.inspect("' + e + '").'
  };
}

function requestStoreSave(e) {
  try {
    const t = require("memoryManager");
    if (e && t && typeof t.requestImmediateSave === "function") {
      t.requestImmediateSave(e);
    } else if (t && typeof t.requestSave === "function") {
      t.requestSave();
    }
  } catch (e) {}
}

function ensureStore() {
  const e = require("memoryManager").storage.ensure("flagVault.manifest", function() {
    return {
      index: {},
      queue: [],
      orphans: []
    };
  });
  if (!e.index || typeof e.index !== "object") e.index = {};
  if (!Array.isArray(e.queue)) e.queue = [];
  if (!Array.isArray(e.orphans)) e.orphans = [];
  return e;
}

function estimateFlagCount(e) {
  const t = expectedGeometry(e);
  return t.dataCount + t.stripeCount + 1;
}

function capacity() {
  scanFlags();
  const e = flagScanVault;
  const t = flagScanTotal;
  const r = ensureStore();
  let n = 0;
  let o = 0;
  for (const e in r.index) {
    const t = r.index[e];
    if (!t) continue;
    n += t.bytes || 0;
    o += t.flags || 0;
  }
  return {
    usedFlags: t,
    vaultFlags: e,
    conventional: t - e,
    maxFlags: MAX_FLAGS,
    maxUsable: MAX_USED_FLAGS,
    free: MAX_USED_FLAGS - t,
    reserve: CONVENTIONAL_RESERVE,
    indexKeys: Object.keys(r.index).length,
    indexBytes: n,
    indexFlags: o,
    queueLength: r.queue.length,
    room: BLOCK_ROOM
  };
}

function validateLogicalKey(e) {
  if (typeof e !== "string" || !e.length) throw new Error("logical key must be a non-empty string");
  if (e.length > MAX_LOGICAL_KEY) throw new Error("logical key exceeds " + MAX_LOGICAL_KEY + " characters");
  if (!/^[A-Za-z0-9._:-]+$/.test(e)) throw new Error("logical key may only contain A-Za-z0-9._:-");
  return e;
}

function has(e) {
  validateLogicalKey(e);
  return !!ensureStore().index[e];
}

function keys() {
  return Object.keys(ensureStore().index).sort();
}

function get(e) {
  validateLogicalKey(e);
  const t = ensureStore();
  const r = t.index[e];
  if (!r || !r.id) return null;
  try {
    let e = decodedBlockCache[r.id];
    if (!e) {
      e = readBlock(r.id);
      decodedBlockCache[r.id] = e;
    }
    const t = r.lastError !== undefined || r.lastErrorTick !== undefined;
    delete r.lastError;
    delete r.lastErrorTick;
    if (t) requestStoreSave();
    return e.value;
  } catch (e) {
    r.lastError = e && e.message ? e.message : String(e);
    r.lastErrorTick = Game.time;
    requestStoreSave();
    return null;
  }
}

function getMeta(e) {
  validateLogicalKey(e);
  const t = ensureStore().index[e];
  if (!t) return null;
  return {
    key: e,
    id: t.id,
    tick: t.tick,
    bytes: t.bytes,
    flags: t.flags,
    room: t.room || BLOCK_ROOM,
    pinned: !!t.pinned
  };
}

function setPinned(e, t) {
  e = validateLogicalKey(e);
  const r = ensureStore().index[e];
  if (!r) return false;
  if (t) r.pinned = true; else delete r.pinned;
  requestStoreSave("flagVault.pin");
  return true;
}

function evictOldest(e) {
  e = e == null ? 1 : Number(e);
  if (!Number.isSafeInteger(e) || e < 1) throw new Error("n must be a positive integer");
  const t = ensureStore();
  const r = Object.keys(t.index).map(function(e) {
    return {
      key: e,
      entry: t.index[e]
    };
  }).filter(function(e) {
    return e.entry && e.entry.id && !e.entry.pinned;
  }).sort(function(e, t) {
    return (e.entry.tick || 0) - (t.entry.tick || 0) || String(e.entry.id).localeCompare(String(t.entry.id));
  });
  const n = [];
  for (let t = 0; t < r.length && n.length < e; t++) {
    const e = r[t];
    const o = remove(e.entry.id, e.entry.id);
    n.push({
      key: e.key,
      id: e.entry.id,
      flags: e.entry.flags || o.removalIntents,
      bytes: e.entry.bytes || 0
    });
  }
  return {
    removed: n,
    remainingKeys: Object.keys(t.index).length
  };
}

function ensureSpace(e) {
  e = Number(e);
  if (!Number.isSafeInteger(e) || e < 1) throw new Error("need must be a positive integer");
  const t = capacity().free;
  if (t >= e) return {
    free: t,
    need: e,
    evicted: []
  };
  const r = [];
  let n = t;
  while (n < e) {
    const o = evictOldest(1);
    if (!o.removed.length) {
      throw new Error("cannot free " + e + " flag slots; free=" + t + " projected=" + n + " and no indexed vault blocks remain to evict");
    }
    const s = o.removed[0];
    const a = s.flags || 1;
    n += a;
    r.push(s);
  }
  throw new Error("eviction scheduled for " + r.length + " block(s) (removals apply next tick); retry ensureSpace later");
}

function put(e, t, r) {
  e = validateLogicalKey(e);
  if (t === undefined) throw new Error("value is required");
  r = r || {};
  const n = JSON.stringify(t);
  if (n === undefined) throw new Error("value is not JSON serializable");
  const o = utf8Encode(n);
  if (o.length === 0) throw new Error("empty payload");
  const s = JSON.parse(n);
  const a = ensureStore();
  if (a.index[e]) throw new Error("key already exists (immutable): " + e);
  for (let t = 0; t < a.queue.length; t++) {
    if (a.queue[t].key === e) throw new Error("key already queued: " + e);
  }
  const i = {
    key: e,
    value: s,
    bytes: o.length,
    estimatedFlags: estimateFlagCount(o.length),
    phase: "observe",
    room: BLOCK_ROOM,
    started: Game.time,
    activeStarted: null,
    lastTick: null,
    id: null,
    message: null,
    noEvict: r.noEvict === true,
    pin: r.pin === true
  };
  a.queue.push(i);
  requestStoreSave("flagVault.enqueue");
  advanceQueue();
  return {
    key: e,
    queued: true,
    bytes: i.bytes,
    estimatedFlags: i.estimatedFlags,
    queueLength: a.queue.length,
    next: "Write advances via flagVault.tick() each tick. Check flagVault.status()."
  };
}

function queueStatus(e) {
  const t = ensureStore();
  if (e !== undefined && e !== null) {
    e = validateLogicalKey(e);
    if (t.index[e]) {
      return {
        key: e,
        state: "committed",
        meta: getMeta(e)
      };
    }
    for (let r = 0; r < t.queue.length; r++) {
      const n = t.queue[r];
      if (n && n.key === e) {
        return {
          key: e,
          state: "queued",
          phase: n.phase,
          queuePosition: r,
          startedTick: n.started,
          id: n.id || null,
          message: n.message || null
        };
      }
    }
    for (let r = t.orphans.length - 1; r >= 0; r--) {
      const n = t.orphans[r];
      if (n && n.key === e) {
        return {
          key: e,
          state: "failed",
          id: n.id || null,
          failedTick: n.tick || null,
          message: n.message || null
        };
      }
    }
    return {
      key: e,
      state: "missing"
    };
  }
  if (!t.queue.length) {
    return {
      active: false,
      queueLength: 0,
      indexKeys: Object.keys(t.index).length,
      next: "flagVault.put(key, value) to queue a cold write."
    };
  }
  const r = t.queue[0];
  return {
    active: true,
    queueLength: t.queue.length,
    phase: r.phase,
    key: r.key,
    id: r.id || null,
    room: r.room,
    bytes: r.bytes,
    estimatedFlags: r.estimatedFlags,
    started: r.started,
    message: r.message || null,
    visible: !!Game.rooms[r.room],
    indexKeys: Object.keys(t.index).length
  };
}

function finishQueueItem(e, t, r, n) {
  t.phase = r ? "done" : "error";
  t.message = n;
  t.finished = Game.time;
  if (!r && t.id) {
    const r = e.orphans.some(function(e) {
      return e && e.id === t.id;
    });
    if (!r) e.orphans.push({
      id: t.id,
      key: t.key,
      tick: Game.time,
      message: String(n).slice(0, ORPHAN_MESSAGE_MAX)
    });
  }
  const o = getScanner();
  if (o && o.observe && typeof o.observe.cancel === "function") {
    o.observe.cancel(t.room, OBSERVE_SRC);
  }
  console.log("[flagVault] t" + Game.time + " put " + (r ? "OK" : "FAIL") + " key=" + t.key + " " + n);
  e.queue.shift();
  requestStoreSave(!r && t.id ? "flagVault.failPhysical" : null);
  return queueStatus();
}

function advanceQueue() {
  const e = ensureStore();
  if (!e.queue.length) return null;
  const t = e.queue[0];
  if (t.lastTick === Game.time) return queueStatus();
  t.lastTick = Game.time;
  if (t.activeStarted == null) t.activeStarted = Game.time;
  if (Game.time - t.activeStarted > WRITE_TIMEOUT) {
    return finishQueueItem(e, t, false, "timed out after " + WRITE_TIMEOUT + " ticks in phase " + t.phase);
  }
  try {
    if (t.phase === "observe") {
      if (Game.rooms[t.room]) {
        t.phase = "stage";
        t.message = "vision on " + t.room;
      } else {
        const r = requestVision(t.room);
        if (r.inRange === false) {
          return finishQueueItem(e, t, false, "no observer in range of " + t.room);
        }
        t.message = "waiting for observer vision on " + t.room;
        requestStoreSave();
        return queueStatus();
      }
    }
    if (t.phase === "stage") {
      if (!Game.rooms[t.room]) {
        requestVision(t.room);
        t.message = "lost vision before stage; re-requesting";
        requestStoreSave();
        return queueStatus();
      }
      // Space is reserved once, for the whole block, on the first stage tick.
      if (!t.id) {
        const free = capacity().free;
        if (t.noEvict && free < t.estimatedFlags) {
          t.message = "waiting for " + t.estimatedFlags + " free flags without eviction (free=" + free + ")";
          requestStoreSave();
          return queueStatus();
        }
        ensureSpace(t.estimatedFlags);
      }
      const resuming = !!t.id;
      const r = stage(t.value, t.room, {
        id: t.id,
        budget: STAGE_FLAGS_PER_TICK
      });
      t.id = r.id;
      t.bytes = r.bytes;
      t.flags = r.dataFlags + r.parityFlags + 1;
      if (r.failed && r.failed.length) {
        return finishQueueItem(e, t, false, "stage created only " + r.created + " flags; failed=" + r.failed.length);
      }
      if (r.remaining > 0) {
        // The timeout is a stall detector, so progress refreshes it; otherwise
        // a block wide enough to need more than WRITE_TIMEOUT ticks of budget
        // could never finish.
        if (r.created > 0) t.activeStarted = Game.time;
        t.message = "staging id=" + r.id + " " + (r.totalFlags - r.remaining) + "/" + r.totalFlags + " flags";
        // The block id must survive a global reset or the already-created flags
        // are orphaned; later batches re-derive their progress from Game.flags,
        // so a checkpoint save is enough for those.
        if (resuming) requestStoreSave(); else requestStoreSave("flagVault.stage");
        return queueStatus();
      }
      t.phase = "commit";
      t.stageTick = Game.time;
      t.message = "staged id=" + r.id;
      requestStoreSave("flagVault.stage");
      return queueStatus();
    }
    if (t.phase === "commit") {
      if (t.stageTick === Game.time) {
        requestStoreSave();
        return queueStatus();
      }
      if (!Game.rooms[t.room]) {
        requestVision(t.room);
        t.message = "waiting for vision to commit";
        requestStoreSave();
        return queueStatus();
      }
      const e = commit(t.id);
      t.phase = "confirm";
      t.commitTick = Game.time;
      t.message = "commit intent id=" + t.id + " creationResult=" + e.creationResult;
      requestStoreSave("flagVault.commit");
      return queueStatus();
    }
    if (t.phase === "confirm") {
      if (t.commitTick === Game.time) {
        requestStoreSave();
        return queueStatus();
      }
      const r = readBlock(t.id);
      if (JSON.stringify(r.value) !== JSON.stringify(t.value)) {
        return finishQueueItem(e, t, false, "confirmed block does not match queued value");
      }
      if (e.index[t.key] && e.index[t.key].id !== t.id) {
        return finishQueueItem(e, t, false, "logical key was committed to another block id=" + e.index[t.key].id);
      }
      e.index[t.key] = {
        id: t.id,
        tick: Game.time,
        bytes: t.bytes,
        flags: t.flags || estimateFlagCount(t.bytes),
        room: t.room
      };
      if (t.pin) e.index[t.key].pinned = true;
      requestStoreSave("flagVault.confirm");
      return finishQueueItem(e, t, true, "confirmed id=" + t.id + " bytes=" + t.bytes + " recoveredShards=" + r.recoveredShards);
    }
  } catch (r) {
    const n = r && r.message ? r.message : String(r);
    if (/not currently visible|Observer requested|eviction did not free|retry ensureSpace/i.test(n)) {
      requestVision(t.room);
      t.message = "waiting: " + n;
      requestStoreSave();
      return queueStatus();
    }
    return finishQueueItem(e, t, false, n);
  }
  requestStoreSave();
  return queueStatus();
}

function makeTestValue(e) {
  let t = "";
  const r = "Flag vault test 0123456789 abcdefghijklmnopqrstuvwxyz | ";
  while (utf8Encode(t).length < e) t += r;
  return {
    type: "flag-vault-test",
    version: 1,
    room: BLOCK_ROOM,
    unicode: "snowman ☃ rocket 🚀",
    body: t.slice(0, e)
  };
}

function getTestState() {
  return require("memoryManager").storage.get("flagVault.test") || null;
}

function setTestState(e) {
  const t = require("memoryManager").storage;
  if (e) t.set("flagVault.test", e); else t.remove("flagVault.test");
}

function logTest(e, t) {
  const r = "[flagVault] t" + Game.time + " " + t;
  if (!e.log) e.log = [];
  e.log.push(r);
  if (e.log.length > 20) e.log.shift();
  console.log(r);
}

function printExampleData(e) {
  console.log("[flagVault] example data:\n" + JSON.stringify(e, null, 2));
}

function finishTest(e, t, r, n) {
  e.phase = t ? "done" : "error";
  e.finished = Game.time;
  e.message = r;
  if (n) e.result = n;
  const o = getScanner();
  if (o && o.observe && typeof o.observe.cancel === "function") {
    o.observe.cancel(e.room, OBSERVE_SRC);
  }
  logTest(e, (t ? "PASS: " : "FAIL: ") + r);
  if (t && n && n.value) printExampleData(n.value); else if (e.value) printExampleData(e.value);
  if (t && e.id) {
    try {
      const t = remove(e.id, e.id);
      e.removed = t.removalIntents;
      logTest(e, "removed " + t.removalIntents + " test flag(s) for id=" + e.id);
    } catch (t) {
      e.removed = 0;
      logTest(e, "cleanup failed: " + (t && t.message ? t.message : t));
    }
  }
  delete e.value;
  if (e.result && e.result.value !== undefined) delete e.result.value;
  setTestState(e);
  return formatStatus(statusInfo());
}

function statusInfo() {
  const e = queueStatus();
  const t = getTestState();
  if (e.active) {
    return {
      active: true,
      kind: "put",
      phase: e.phase,
      key: e.key,
      room: e.room,
      id: e.id || null,
      started: e.started,
      message: e.message || null,
      visible: !!e.visible,
      queueLength: e.queueLength,
      indexKeys: e.indexKeys,
      next: null
    };
  }
  if (!t) {
    return {
      active: false,
      kind: "idle",
      room: BLOCK_ROOM,
      queueLength: e.queueLength,
      indexKeys: e.indexKeys,
      next: "Run flagVault.test(1024) or flagVault.put(key, value)."
    };
  }
  return {
    active: t.phase !== "done" && t.phase !== "error",
    kind: "test",
    phase: t.phase,
    room: t.room,
    id: t.id || null,
    started: t.started,
    finished: t.finished || null,
    message: t.message || null,
    visible: !!Game.rooms[t.room],
    result: t.result || null,
    log: t.log || [],
    queueLength: e.queueLength,
    indexKeys: e.indexKeys
  };
}

function formatStatus(e) {
  if (!e) return "[flagVault] no status";
  if (!e.active && !e.phase) {
    return "[flagVault] idle room=" + e.room + " index=" + (e.indexKeys || 0) + " queue=" + (e.queueLength || 0) + " | " + (e.next || "");
  }
  const t = [ "[flagVault]", e.kind ? "kind=" + e.kind : null, "phase=" + e.phase, "room=" + e.room, "visible=" + !!e.visible ].filter(Boolean);
  if (e.key) t.push("key=" + e.key);
  if (e.id) t.push("id=" + e.id);
  if (e.queueLength) t.push("queue=" + e.queueLength);
  if (e.message) t.push(e.message);
  return t.join(" ");
}

function status() {
  return formatStatus(statusInfo());
}

function advanceTest() {
  const e = getTestState();
  if (!e || e.phase === "done" || e.phase === "error") return null;
  if (e.lastTick === Game.time) return formatStatus(statusInfo());
  e.lastTick = Game.time;
  if (Game.time - e.started > TEST_TIMEOUT) {
    return finishTest(e, false, "timed out after " + TEST_TIMEOUT + " ticks in phase " + e.phase);
  }
  try {
    if (e.phase === "observe") {
      if (Game.rooms[e.room]) {
        e.phase = "stage";
        logTest(e, "vision on " + e.room + "; staging");
      } else {
        const t = requestVision(e.room);
        if (t.inRange === false) {
          return finishTest(e, false, "no observer in range of " + e.room);
        }
        logTest(e, "waiting for observer vision on " + e.room);
        setTestState(e);
        return formatStatus(statusInfo());
      }
    }
    if (e.phase === "stage") {
      if (!Game.rooms[e.room]) {
        requestVision(e.room);
        logTest(e, "lost vision before stage; re-requesting");
        setTestState(e);
        return formatStatus(statusInfo());
      }
      const t = stage(e.value, e.room);
      e.id = t.id;
      e.bytes = t.bytes;
      e.dataFlags = t.dataFlags;
      e.parityFlags = t.parityFlags;
      if (t.failed && t.failed.length) {
        return finishTest(e, false, "stage created only " + t.created + " flags; failed=" + t.failed.length);
      }
      e.phase = "commit";
      e.stageTick = Game.time;
      logTest(e, "staged id=" + t.id + " bytes=" + t.bytes + " flags=" + (t.dataFlags + t.parityFlags));
      setTestState(e);
      return formatStatus(statusInfo());
    }
    if (e.phase === "commit") {
      if (e.stageTick === Game.time) {
        setTestState(e);
        return formatStatus(statusInfo());
      }
      if (!Game.rooms[e.room]) {
        requestVision(e.room);
        logTest(e, "waiting for vision to commit");
        setTestState(e);
        return formatStatus(statusInfo());
      }
      const t = commit(e.id);
      e.phase = "read";
      e.commitTick = Game.time;
      logTest(e, "committed id=" + e.id + " creationResult=" + t.creationResult);
      setTestState(e);
      return formatStatus(statusInfo());
    }
    if (e.phase === "read") {
      if (e.commitTick === Game.time) {
        setTestState(e);
        return formatStatus(statusInfo());
      }
      const t = readBlock(e.id);
      const r = JSON.stringify(t.value) === JSON.stringify(e.value);
      if (!r) {
        return finishTest(e, false, "read value does not match staged value", t);
      }
      return finishTest(e, true, "round-trip ok id=" + e.id + " bytes=" + t.bytes + " recoveredShards=" + t.recoveredShards, t);
    }
  } catch (t) {
    const r = t && t.message ? t.message : String(t);
    if (/not currently visible|Observer requested/i.test(r)) {
      requestVision(e.room);
      logTest(e, "waiting for vision: " + r);
      setTestState(e);
      return formatStatus(statusInfo());
    }
    return finishTest(e, false, r);
  }
  setTestState(e);
  return formatStatus(statusInfo());
}

function test(e) {
  e = e == null ? 1024 : Number(e);
  if (!Number.isSafeInteger(e) || e < 128) {
    throw new Error("targetBytes must be an integer of at least 128");
  }
  const t = getTestState();
  if (t && t.phase !== "done" && t.phase !== "error") {
    logTest(t, "test already active in phase " + t.phase + "; advancing");
    return advanceTest();
  }
  if (t && t.phase === "error" && t.id) {
    return "[flagVault] previous failed test has block id=" + t.id + "; run flagVault.clearTest() before starting another test.";
  }
  const r = makeTestValue(e);
  const n = {
    phase: "observe",
    room: BLOCK_ROOM,
    targetBytes: e,
    value: r,
    started: Game.time,
    lastTick: null,
    id: null,
    log: []
  };
  setTestState(n);
  logTest(n, "started test bytes~" + e + " room=" + BLOCK_ROOM);
  printExampleData(r);
  return advanceTest();
}

function clearTest() {
  const e = getTestState();
  if (!e) return {
    cleared: false,
    message: "No flag vault test state."
  };
  if (e.phase !== "done" && e.phase !== "error") {
    throw new Error("cannot clear an active flag vault test in phase " + e.phase);
  }
  let t = 0;
  if (e.id && flagsForBlock(e.id).length) {
    t = remove(e.id, e.id).removalIntents;
  }
  setTestState(null);
  return {
    cleared: true,
    id: e.id || null,
    removalIntents: t
  };
}

function pruneOrphans() {
  if (Game.time - lastOrphanPruneTick < ORPHAN_SCAN_INTERVAL) return 0;
  lastOrphanPruneTick = Game.time;
  const __store = ensureStore();
  if (!Array.isArray(__store.orphans) || !__store.orphans.length) return 0;
  const __before = __store.orphans.length;
  __store.orphans = __store.orphans.filter(function(__o) {
    return __o && Game.time - (__o.tick || 0) <= ORPHAN_TTL;
  });
  if (__store.orphans.length > ORPHAN_CAP) {
    __store.orphans.sort(function(__x, __y) {
      return (__x.tick || 0) - (__y.tick || 0);
    });
    __store.orphans = __store.orphans.slice(-ORPHAN_CAP);
  }
  const __removed = __before - __store.orphans.length;
  if (__removed > 0) requestStoreSave("flagVault.pruneOrphans");
  return __removed;
}

function tick() {
  pruneOrphans();
  const e = advanceQueue();
  const t = getTestState();
  if (t && t.phase === "done" && t.finished != null && Game.time - t.finished > 100) {
    setTestState(null);
    return e;
  }
  if (t && t.phase !== "done" && t.phase !== "error") {
    return advanceTest() || e;
  }
  return e;
}

const api = {
  test: test,
  clearTest: clearTest,
  tick: tick,
  status: status,
  statusInfo: statusInfo,
  observe: observe,
  ready: ready,
  stage: stage,
  stageTest: stageTest,
  commit: commit,
  read: readBlock,
  inspect: inspect,
  list: list,
  remove: remove,
  capacity: capacity,
  put: put,
  get: get,
  getMeta: getMeta,
  setPinned: setPinned,
  has: has,
  keys: keys,
  evictOldest: evictOldest,
  ensureSpace: ensureSpace,
  queueStatus: queueStatus,
  estimateFlagCount: estimateFlagCount,
  config: function() {
    return {
      room: BLOCK_ROOM,
      requiresVision: true,
      observeSource: OBSERVE_SRC,
      shardBytes: SHARD_BYTES,
      dataShardsPerStripe: DATA_SHARDS_PER_STRIPE,
      conventionalReserve: CONVENTIONAL_RESERVE,
      maxFlags: MAX_FLAGS,
      maxUsable: MAX_USED_FLAGS,
      maxLogicalKey: MAX_LOGICAL_KEY
    };
  }
};
global.flagVault = api;
module.exports = api;
