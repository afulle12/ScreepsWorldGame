// LLM: Read docs/codex.js before reviewing or changing this file.
// permanentRoomFacts.js
const memoryManager = require("memoryManager");
const storage = memoryManager.storage;
const DATASET_ID = "getRoomState.permanentFacts";
const VERSION = 1;
const SIGN_PREFIX = "CtrlAltDefeat! | ";
const CODEC_PREFIX = "CAD1:";
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const COORD_ALPHABET = CODE_ALPHABET.slice(0, 50);
const MINERAL_CODES = {
  H: "H",
  O: "O",
  U: "U",
  L: "L",
  K: "K",
  Z: "Z",
  X: "X",
  G: "G"
};
const CODE_MINERALS = {};
const MATRIX_SIZE = 45;
const UNREACHABLE_CODE = 63;
for (const t in MINERAL_CODES) CODE_MINERALS[MINERAL_CODES[t]] = t;
storage.register(DATASET_ID, {
  path: "heap.roomState.permanentFacts",
  owner: "permanentRoomFacts.js",
  mutability: "ephemeral",
  recomputable: true,
  resetLossOkay: true
});
function sectorFor(t) {
  return Math.min(2, Math.floor(t.y * 3 / 50)) * 3 + Math.min(2, Math.floor(t.x * 3 / 50));
}

function matrixIndex(t, e) {
  if (t > e) {
    const o = t;
    t = e;
    e = o;
  }
  return t * 9 - t * (t - 1) / 2 + (e - t);
}

function cheb(t, e) {
  return Math.max(Math.abs(t.x - e.x), Math.abs(t.y - e.y));
}

function encodePos(t) {
  if (!t || t.x < 0 || t.x >= 50 || t.y < 0 || t.y >= 50) return "--";
  return COORD_ALPHABET.charAt(t.x) + COORD_ALPHABET.charAt(t.y);
}

function decodePos(t, e) {
  const o = COORD_ALPHABET.indexOf(t.charAt(e));
  const n = COORD_ALPHABET.indexOf(t.charAt(e + 1));
  if (o < 0 || n < 0) return null;
  return {
    x: o,
    y: n
  };
}

function checksum(t) {
  let e = 0;
  for (let o = 0; o < t.length; o++) e = e * 31 + t.charCodeAt(o) & 4095;
  return CODE_ALPHABET.charAt(e >> 6 & 63) + CODE_ALPHABET.charAt(e & 63);
}

function encode(t) {
  if (!isValidFacts(t)) return null;
  const e = t.sources.slice(0, 3);
  let o = encodePos(t.controllerPos);
  o += MINERAL_CODES[t.mineral.type] || "?";
  o += encodePos(t.mineral.pos);
  for (let t = 0; t < 3; t++) o += encodePos(e[t]);
  for (let e = 0; e < MATRIX_SIZE; e++) o += CODE_ALPHABET.charAt(t.nav[e]);
  return SIGN_PREFIX + CODEC_PREFIX + o + checksum(o);
}

function parse(t) {
  if (typeof t !== "string" || t.indexOf(SIGN_PREFIX + CODEC_PREFIX) !== 0) return null;
  const e = 2 + 1 + 2 + 6 + MATRIX_SIZE;
  const o = SIGN_PREFIX.length + CODEC_PREFIX.length;
  const n = t.slice(o, o + e);
  const r = t.slice(o + e);
  if (n.length !== e || r.length !== 2 || checksum(n) !== r) return null;
  let s = 0;
  const c = decodePos(n, s);
  s += 2;
  const a = CODE_MINERALS[n.charAt(s++)];
  const l = decodePos(n, s);
  s += 2;
  if (!c || !a || !l) return null;
  const i = [];
  for (let t = 0; t < 3; t++) {
    const t = n.slice(s, s + 2);
    s += 2;
    if (t === "--") continue;
    const e = decodePos(t, 0);
    if (!e) return null;
    i.push(e);
  }
  const u = [];
  for (let t = 0; t < MATRIX_SIZE; t++) {
    const t = CODE_ALPHABET.indexOf(n.charAt(s++));
    if (t < 0) return null;
    u.push(t);
  }
  return {
    version: VERSION,
    controllerPos: c,
    mineral: {
      type: a,
      pos: l
    },
    sources: i,
    nav: u
  };
}

function samePos(t, e) {
  return !!t && !!e && t.x === e.x && t.y === e.y;
}

function sortedPositions(t) {
  const e = [];
  for (let o = 0; o < t.length; o++) e.push({
    x: t[o].pos.x,
    y: t[o].pos.y
  });
  e.sort(function(t, e) {
    return t.y - e.y || t.x - e.x;
  });
  return e;
}

function isValidFacts(t) {
  if (!t || t.version !== VERSION || !t.controllerPos || !t.mineral || !t.mineral.pos) return false;
  if (!MINERAL_CODES[t.mineral.type] || !Array.isArray(t.sources) || t.sources.length > 3) return false;
  if (!Array.isArray(t.nav) || t.nav.length !== MATRIX_SIZE) return false;
  for (let e = 0; e < t.nav.length; e++) {
    if (typeof t.nav[e] !== "number" || t.nav[e] < 0 || t.nav[e] > 63) return false;
  }
  return true;
}

function matchesRoom(t, e, o, n) {
  if (!isValidFacts(t) || !e || !e.controller || !samePos(t.controllerPos, e.controller.pos)) return false;
  const r = n && n[0];
  if (!r || t.mineral.type !== r.mineralType || !samePos(t.mineral.pos, r.pos)) return false;
  const s = sortedPositions(o || []);
  if (t.sources.length !== s.length) return false;
  for (let e = 0; e < s.length; e++) {
    if (!samePos(t.sources[e], s[e])) return false;
  }
  return true;
}

function isWall(t, e, o) {
  return (t.get(e, o) & TERRAIN_MASK_WALL) !== 0;
}

function terrainCost(t, e, o) {
  return (t.get(e, o) & TERRAIN_MASK_SWAMP) !== 0 ? 5 : 1;
}

function sectorAnchor(t, e) {
  const o = e % 3;
  const n = Math.floor(e / 3);
  const r = Math.floor(o * 50 / 3);
  const s = Math.floor((o + 1) * 50 / 3) - 1;
  const c = Math.floor(n * 50 / 3);
  const a = Math.floor((n + 1) * 50 / 3) - 1;
  const l = Math.floor((r + s) / 2);
  const i = Math.floor((c + a) / 2);
  let u = null;
  let f = Infinity;
  for (let e = c; e <= a; e++) {
    for (let o = r; o <= s; o++) {
      if (isWall(t, o, e)) continue;
      const n = Math.max(Math.abs(o - l), Math.abs(e - i));
      if (n < f) {
        u = {
          x: o,
          y: e
        };
        f = n;
      }
    }
  }
  return u;
}

function weightedDistanceMap(t, e) {
  const o = new Array(2500).fill(Infinity);
  if (!e) return o;
  const n = [];
  function push(t) {
    n.push(t);
    let e = n.length - 1;
    while (e > 0) {
      const o = e - 1 >> 1;
      if (n[o].cost <= t.cost) break;
      n[e] = n[o];
      e = o;
    }
    n[e] = t;
  }
  function pop() {
    const t = n[0];
    const e = n.pop();
    if (n.length) {
      let t = 0;
      while (true) {
        let o = t * 2 + 1;
        if (o >= n.length) break;
        if (o + 1 < n.length && n[o + 1].cost < n[o].cost) o++;
        if (n[o].cost >= e.cost) break;
        n[t] = n[o];
        t = o;
      }
      n[t] = e;
    }
    return t;
  }
  const r = e.y * 50 + e.x;
  o[r] = 0;
  push({
    key: r,
    cost: 0
  });
  while (n.length) {
    const e = pop();
    if (e.cost !== o[e.key]) continue;
    const n = e.key % 50;
    const r = (e.key - n) / 50;
    for (let s = -1; s <= 1; s++) {
      for (let c = -1; c <= 1; c++) {
        if (s === 0 && c === 0) continue;
        const a = n + s;
        const l = r + c;
        if (a < 0 || a >= 50 || l < 0 || l >= 50 || isWall(t, a, l)) continue;
        const i = l * 50 + a;
        const u = e.cost + terrainCost(t, a, l);
        if (u >= o[i]) continue;
        o[i] = u;
        push({
          key: i,
          cost: u
        });
      }
    }
  }
  return o;
}

function sectorTerrainFactor(t, e) {
  const o = e % 3;
  const n = Math.floor(e / 3);
  const r = Math.floor(o * 50 / 3);
  const s = Math.floor((o + 1) * 50 / 3) - 1;
  const c = Math.floor(n * 50 / 3);
  const a = Math.floor((n + 1) * 50 / 3) - 1;
  let l = 0;
  let i = 0;
  for (let e = c; e <= a; e++) {
    for (let o = r; o <= s; o++) {
      if (isWall(t, o, e)) continue;
      l += terrainCost(t, o, e);
      i++;
    }
  }
  return i ? l / i : 15.5;
}

function encodeFactor(t) {
  if (!isFinite(t)) return UNREACHABLE_CODE;
  return Math.min(62, Math.max(4, Math.round(t * 4)));
}

function build(t, e, o) {
  if (!t || !t.controller || !t.controller.pos) return null;
  const n = o && o[0];
  if (!n || !MINERAL_CODES[n.mineralType]) return null;
  const r = Game.map.getRoomTerrain(t.name);
  if (!r) return null;
  const s = [];
  const c = [];
  for (let t = 0; t < 9; t++) s.push(sectorAnchor(r, t));
  for (let t = 0; t < 9; t++) c.push(weightedDistanceMap(r, s[t]));
  const a = [];
  for (let t = 0; t < 9; t++) {
    for (let e = t; e < 9; e++) {
      if (t === e) {
        a.push(encodeFactor(sectorTerrainFactor(r, t)));
        continue;
      }
      if (!s[t] || !s[e]) {
        a.push(UNREACHABLE_CODE);
        continue;
      }
      const o = c[t][s[e].y * 50 + s[e].x];
      const n = cheb(s[t], s[e]);
      a.push(encodeFactor(o / Math.max(1, n)));
    }
  }
  return {
    version: VERSION,
    controllerPos: {
      x: t.controller.pos.x,
      y: t.controller.pos.y
    },
    mineral: {
      type: n.mineralType,
      pos: {
        x: n.pos.x,
        y: n.pos.y
      }
    },
    sources: sortedPositions(e || []),
    nav: a
  };
}

function estimateTravel(t, e, o) {
  const n = cheb(e, o);
  if (!isValidFacts(t) || !e || !o || n <= 1) return n;
  const r = t.nav[matrixIndex(sectorFor(e), sectorFor(o))];
  if (r === UNREACHABLE_CODE) return n * 4;
  return Math.ceil(n * Math.max(1, r / 4));
}

function get(t) {
  return storage.get(DATASET_ID, t) || null;
}

function set(t, e) {
  return storage.set(DATASET_ID, t, e);
}

module.exports = {
  DATASET_ID: DATASET_ID,
  VERSION: VERSION,
  SIGN_PREFIX: SIGN_PREFIX,
  CODEC_PREFIX: CODEC_PREFIX,
  build: build,
  encode: encode,
  parse: parse,
  get: get,
  set: set,
  isValidFacts: isValidFacts,
  matchesRoom: matchesRoom,
  estimateTravel: estimateTravel,
  sectorFor: sectorFor
};
