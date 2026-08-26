// LLM: Read docs/codex.js before reviewing or changing this file.
// scavengerPolicy.js
const marketPricing = require("marketPricing");
const learning = require("scavengerLearning");
const STORAGE_RANGE = 10;
const CARRY_CAPACITY = 50;
const CREEP_SPAWN_TICKS = typeof CREEP_SPAWN_TIME !== "undefined" && CREEP_SPAWN_TIME > 0 ? CREEP_SPAWN_TIME : 3;
const DROPPED_RESOURCE_DECAY = typeof ENERGY_DECAY !== "undefined" && ENERGY_DECAY > 0 ? ENERGY_DECAY : 1e3;
const MAX_DROP_LIFETIME_ESTIMATE = 5e3;
const MAX_PATH_OPS = 500;
const MATERIAL_AMOUNT_STEP = 25;
const MATERIAL_TTL_STEP = 10;
const MATERIAL_PRICE_STEP = 10;
const MAX_HOSTILE_RANGE = 10;
const CAPTURE_DISCOUNT = .35;
const MAX_CANDIDATES = 64;
const MAX_CREEP_LIFETIME = typeof CREEP_LIFE_TIME !== "undefined" && CREEP_LIFE_TIME > 0 ? CREEP_LIFE_TIME : 1500;
const MIN_NEURAL_BUCKET = 1e3;
const NEURAL_CPU_RESERVE = 2;
const RESOURCE_ENERGY_NAME = typeof RESOURCE_ENERGY !== "undefined" ? RESOURCE_ENERGY : "energy";
function clamp(e, t, r) {
  return e < t ? t : e > r ? r : e;
}

function finite(e, t) {
  return typeof e === "number" && isFinite(e) ? e : t;
}

function cheb(e, t) {
  if (!e || !t) return Infinity;
  var r = Math.abs((e.x || 0) - (t.x || 0));
  var a = Math.abs((e.y || 0) - (t.y || 0));
  return Math.max(r, a);
}

function logNorm(e, t) {
  e = Math.max(0, finite(e, 0));
  return clamp(Math.log1p(e) / (t || 10), 0, 1);
}

function signedLogNorm(e, t) {
  e = finite(e, 0);
  var r = e < 0 ? -1 : 1;
  return r * clamp(Math.log1p(Math.abs(e)) / (t || 10), 0, 1);
}

function priceProfile(e) {
  try {
    return marketPricing.getPriceProfile(e) || {};
  } catch (e) {
    return {};
  }
}

function priceFor(e) {
  return learning.canonicalPrice(e);
}

function normalizedProfilePrice(e) {
  if (!(typeof e === "number" && isFinite(e) && e > 0)) return 0;
  var t = 0;
  try {
    t = marketPricing.getStatusEnergyPrice();
  } catch (e) {
    return 0;
  }
  return t > 0 ? e / t : 0;
}

function cpuBudgetState() {
  if (typeof Game === "undefined" || !Game.cpu || typeof Game.cpu.getUsed !== "function" || typeof Game.cpu.limit !== "number" || typeof Game.cpu.bucket !== "number") return {
    verifiable: false,
    available: false
  };
  var e;
  try {
    e = Game.cpu.getUsed();
  } catch (e) {
    return {
      verifiable: false,
      available: false
    };
  }
  if (!isFinite(e)) return {
    verifiable: false,
    available: false
  };
  return {
    verifiable: true,
    available: e + NEURAL_CPU_RESERVE <= Game.cpu.limit && Game.cpu.bucket >= MIN_NEURAL_BUCKET
  };
}

function hasCpuBudget() {
  return cpuBudgetState().available;
}

function resourceFeatures(e) {
  var t = priceProfile(e);
  var r = priceFor(e);
  return {
    price: r,
    bestBid: normalizedProfilePrice(t.bestBid),
    reference: r,
    liquidity: Math.max(finite(t.bidVolume, 0), finite(t.askVolume, 0)),
    spread: finite(t.spreadRatio, 0),
    confidence: t.confidence || "none"
  };
}

function isEligibleRoom(e) {
  return !!(e && e.controller && e.controller.my && e.controller.level === 8 && e.storage);
}

function getEligibleRooms() {
  var e = [];
  if (typeof Game === "undefined" || !Game.rooms) return e;
  for (var t in Game.rooms) {
    if (isEligibleRoom(Game.rooms[t])) e.push(Game.rooms[t]);
  }
  e.sort(function(e, t) {
    return e.name < t.name ? -1 : e.name > t.name ? 1 : 0;
  });
  return e;
}

function getFreeSpawns(e) {
  var t = [];
  if (!e) return t;
  if (typeof FIND_MY_SPAWNS !== "undefined" && typeof e.find === "function") {
    try {
      var r = e.find(FIND_MY_SPAWNS);
      for (var a = 0; a < r.length; a++) {
        if (r[a] && r[a].my && !r[a].spawning) t.push(r[a]);
      }
      return t;
    } catch (e) {}
  }
  if (typeof Game !== "undefined" && Game.spawns) {
    for (var n in Game.spawns) {
      var i = Game.spawns[n];
      if (i && i.room && i.room.name === e.name && i.my && !i.spawning) t.push(i);
    }
  }
  return t;
}

function findObjects(e, t) {
  if (!e || typeof e.find !== "function" || t === undefined) return [];
  try {
    return e.find(t) || [];
  } catch (e) {
    return [];
  }
}

function hasResources(e) {
  if (!e) return false;
  if (typeof e.amount === "number") return !!e.resourceType && e.amount > 0;
  if (!e.store) return false;
  for (var t in e.store) {
    if (e.store[t] > 0) return true;
  }
  return false;
}

function objectType(e) {
  if (e && e.amount !== undefined) return "drop";
  if (e && e.deathTime !== undefined) return "tombstone";
  return "ruin";
}

function objectIdentity(e) {
  if (!e) return "missing";
  if (e.id) return e.id;
  var t = objectType(e);
  var r = e.pos || {};
  return t + ":" + (r.roomName || "") + ":" + (r.x || 0) + ":" + (r.y || 0);
}

function getRemainingTtl(e) {
  if (!e) return Infinity;
  if (typeof e.ticksToDecay === "number") return Math.max(0, e.ticksToDecay);
  if (typeof e.decayTime === "number" && typeof Game !== "undefined") {
    return Math.max(0, e.decayTime - Game.time);
  }
  if (typeof e.amount === "number") return estimateDropLifetime(e.amount);
  return Infinity;
}

function estimateDropLifetime(e) {
  e = Math.floor(Math.max(0, e || 0));
  var t = 0;
  while (e > 0 && t < MAX_DROP_LIFETIME_ESTIMATE) {
    e -= Math.ceil(e / DROPPED_RESOURCE_DECAY);
    t++;
  }
  return t;
}

function storeVector(e) {
  var t = [];
  var r = learning.RESOURCE_VOCABULARY;
  var a = learning.RESOURCE_INDEX;
  for (var n = 0; n < r.length; n++) t.push(0);
  if (!e) return t;
  if (e.amount !== undefined) {
    var i = hasOwn(a, e.resourceType) ? a[e.resourceType] : a[learning.RESOURCE_UNKNOWN];
    t[i] = logNorm(e.amount, 12);
    return t;
  }
  if (!e.store) return t;
  for (var o in e.store) {
    var s = e.store[o] || 0;
    if (s <= 0) continue;
    var l = hasOwn(a, o) ? a[o] : a[learning.RESOURCE_UNKNOWN];
    t[l] = clamp(t[l] + logNorm(s, 12), 0, 1);
  }
  return t;
}

function hasOwn(e, t) {
  return Object.prototype.hasOwnProperty.call(e, t);
}

function resourceTypes(e) {
  if (!e) return [];
  if (e.amount !== undefined) return e.resourceType ? [ e.resourceType ] : [];
  var t = [];
  if (!e.store) return t;
  for (var r in e.store) if ((e.store[r] || 0) > 0) t.push(r);
  t.sort();
  return t;
}

function candidateAmount(e, t) {
  if (!e) return 0;
  if (e.amount !== undefined) return e.resourceType === t ? Math.max(0, e.amount) : 0;
  return e.store ? Math.max(0, e.store[t] || 0) : 0;
}

function getCandidateObjects(e) {
  var t = [];
  var r = findObjects(e, typeof FIND_DROPPED_RESOURCES !== "undefined" ? FIND_DROPPED_RESOURCES : undefined);
  var a = findObjects(e, typeof FIND_TOMBSTONES !== "undefined" ? FIND_TOMBSTONES : undefined);
  var n = findObjects(e, typeof FIND_RUINS !== "undefined" ? FIND_RUINS : undefined);
  for (var i = 0; i < r.length; i++) t.push(r[i]);
  for (var o = 0; o < a.length; o++) t.push(a[o]);
  for (var s = 0; s < n.length; s++) t.push(n[s]);
  return t;
}

function getCandidates(e) {
  var t = [];
  if (!isEligibleRoom(e)) return t;
  var r = e.storage;
  var a = getCandidateObjects(e);
  for (var n = 0; n < a.length; n++) {
    var i = a[n];
    if (!i || !i.pos || !hasResources(i)) continue;
    if (i.pos.roomName !== e.name) continue;
    if (cheb(i.pos, r.pos) <= STORAGE_RANGE) continue;
    var o = resourceTypes(i);
    for (var s = 0; s < o.length; s++) {
      var l = o[s];
      var c = candidateAmount(i, l);
      if (!(c > 0)) continue;
      t.push({
        object: i,
        objectId: objectIdentity(i),
        objectType: objectType(i),
        resourceType: l,
        amount: c,
        pos: i.pos,
        ttl: getRemainingTtl(i),
        distanceStorage: cheb(i.pos, r.pos),
        totalAmount: i.amount !== undefined ? i.amount : getStoreUsed(i.store),
        nonEmptyTypes: o.length,
        containerVector: storeVector(i)
      });
    }
  }
  t.sort(function(e, t) {
    var r = e.objectId + "|" + e.resourceType;
    var a = t.objectId + "|" + t.resourceType;
    return r < a ? -1 : r > a ? 1 : 0;
  });
  var u = Math.max(0, t.length - MAX_CANDIDATES);
  if (u > 0) t = t.slice(0, MAX_CANDIDATES);
  t.overflowCount = u;
  return t;
}

function getStoreUsed(e) {
  if (!e) return 0;
  if (typeof e.getUsedCapacity === "function") return e.getUsedCapacity();
  var t = 0;
  for (var r in e) {
    if (typeof e[r] === "number") t += e[r];
  }
  return t;
}

function getMyCreeps(e) {
  if (!e) return [];
  if (typeof FIND_MY_CREEPS !== "undefined" && typeof e.find === "function") {
    try {
      var t = e.find(FIND_MY_CREEPS);
      if (Array.isArray(t)) return t;
    } catch (e) {}
  }
  if (Array.isArray(e.myCreeps)) return e.myCreeps;
  var r = [];
  if (typeof Game !== "undefined" && Game.creeps) {
    for (var a in Game.creeps) {
      var n = Game.creeps[a];
      if (n && n.room && n.room.name === e.name) r.push(n);
    }
  }
  return r;
}

function getHostiles(e) {
  var t = typeof Game !== "undefined" && typeof Game.time === "number" ? Game.time : 0;
  var r = global.__scavengerHostileCache;
  if (!r || r.tick !== t) {
    r = global.__scavengerHostileCache = {
      tick: t,
      rooms: {}
    };
  }
  if (!e || typeof e.find !== "function" || typeof FIND_HOSTILE_CREEPS === "undefined") {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(r.rooms, e.name)) {
    try {
      var a = e.find(FIND_HOSTILE_CREEPS);
      r.rooms[e.name] = Array.isArray(a) ? a : null;
    } catch (t) {
      r.rooms[e.name] = null;
    }
  }
  return r.rooms[e.name];
}

function pathSearch(e, t) {
  if (!e || !t) return {
    distance: Infinity,
    path: null,
    valid: false
  };
  var r = global.__scavengerPathCache;
  var a = typeof Game !== "undefined" && typeof Game.time === "number" ? Game.time : 0;
  if (!r || r.tick !== a) {
    r = global.__scavengerPathCache = {
      tick: a,
      values: {}
    };
  }
  var n = [ e.roomName, e.x, e.y, t.roomName, t.x, t.y ].join(":");
  if (r.values[n] !== undefined) return r.values[n];
  var i = {
    distance: Infinity,
    path: null,
    valid: false
  };
  if (typeof PathFinder !== "undefined" && typeof PathFinder.search === "function") {
    try {
      var o = PathFinder.search(e, {
        pos: t,
        range: 1
      }, {
        maxOps: MAX_PATH_OPS,
        maxRooms: 1,
        roomCallback: function(t) {
          return t === e.roomName ? undefined : false;
        }
      });
      if (o && !o.incomplete && Array.isArray(o.path)) {
        i = {
          distance: o.path.length,
          path: o.path,
          valid: true
        };
      }
    } catch (e) {}
  }
  r.values[n] = i;
  return i;
}

function routeNearHostile(e, t) {
  if (!Array.isArray(e)) return true;
  for (var r = 0; r < e.length; r++) {
    for (var a = 0; a < t.length; a++) {
      if (t[a] && t[a].pos && cheb(e[r], t[a].pos) <= MAX_HOSTILE_RANGE) {
        return true;
      }
    }
  }
  return false;
}

function isHostileUnsafe(e, t, r, a) {
  var n = getHostiles(e);
  if (!Array.isArray(n)) return true;
  for (var i = 0; i < n.length; i++) {
    var o = n[i];
    if (!o || !o.pos) continue;
    if (cheb(o.pos, t.pos) <= MAX_HOSTILE_RANGE || cheb(o.pos, r.pos) <= MAX_HOSTILE_RANGE) return true;
  }
  var s = pathSearch(a || r.pos, t.pos);
  var l = pathSearch(t.pos, r.pos);
  if (!s.valid || !l.valid || routeNearHostile(s.path, n) || routeNearHostile(l.path, n)) return true;
  return false;
}

function pathDistance(e, t) {
  return pathSearch(e, t).distance;
}

function candidateTravel(e, t, r) {
  var a = e.storage;
  var n = pathDistance(r || a.pos, t.pos);
  var i = pathDistance(t.pos, a.pos);
  if (!isFinite(n) || !isFinite(i)) return Infinity;
  return n + i + 1;
}

function candidateSafe(e, t, r) {
  if (isHostileUnsafe(e, t, e.storage, r)) return false;
  var a = pathDistance(r || e.storage.pos, t.pos);
  if (!isFinite(a)) return false;
  return a < t.ttl;
}

function candidateStorageFree(e, t) {
  var r = e && e.storage;
  if (!r || !r.store || typeof r.store.getFreeCapacity !== "function") return false;
  try {
    return r.store.getFreeCapacity() > 0;
  } catch (e) {
    return false;
  }
}

function legalCandidates(e, t, r, a) {
  var n = [];
  for (var i = 0; i < t.length; i++) {
    if (!hasCpuBudget()) return [];
    var o = t[i];
    var s = a && hasOwn(a, o.resourceType) ? a[o.resourceType] : priceFor(o.resourceType);
    if (!(s > 0)) continue;
    if (!candidateStorageFree(e, o)) continue;
    if (!candidateSafe(e, o, r)) continue;
    n.push(o);
  }
  return n;
}

function getLegalBodySizes(e, t, r, a) {
  var n = [];
  if (!e || !t || t.length === 0) return n;
  for (var i = 1; i <= learning.MAX_BODY_SIZE; i++) {
    if (!hasCpuBudget()) return [];
    var o = learning.BODY_PART_COST * i;
    var s = i * 2;
    if (s > 50 || e.energyAvailable < o) continue;
    var l = s * CREEP_SPAWN_TICKS;
    var c = false;
    for (var u = 0; u < r.length; u++) {
      var f = r[u];
      var p = pathDistance(a || e.storage.pos, f.pos);
      if (isFinite(p) && l + p < f.ttl) {
        c = true;
        break;
      }
    }
    if (c) n.push(i);
  }
  return n;
}

function bodyCost(e) {
  return learning.BODY_PART_COST * e;
}

function potentialForBody(e, t, r, a) {
  var n = r * CARRY_CAPACITY;
  var i = r * 2 * CREEP_SPAWN_TICKS;
  var o = {};
  var s = 0;
  try {
    s = Math.max(0, e.storage.store.getFreeCapacity());
  } catch (e) {
    return {
      potentialProfit: 0,
      expectedProfit: 0,
      spawnCost: bodyCost(r),
      potentialNet: -bodyCost(r),
      capacity: n,
      collectable: 0,
      travelTicks: 0,
      pickupCount: 0,
      valuePerEnergy: 0,
      valuePerTick: 0
    };
  }
  for (var l = 0; l < t.length; l++) {
    var c = t[l];
    var u = c.objectId + "|" + c.resourceType;
    o[u] = c.amount;
  }
  var f = t.slice().sort(function(e, t) {
    var r = (a[e.resourceType] || 0) / Math.max(1, e.distanceStorage);
    var n = (a[t.resourceType] || 0) / Math.max(1, t.distanceStorage);
    return n - r;
  });
  var p = 0;
  var d = 0;
  var m = 0;
  var g = 0;
  for (var v = 0; v < f.length; v++) {
    var y = f[v];
    var E = y.objectId + "|" + y.resourceType;
    var h = o[E] || 0;
    if (!(h > 0)) continue;
    var _ = Math.min(y.ttl, MAX_CREEP_LIFETIME);
    var C = pathDistance(e.storage.pos, y.pos);
    var R = pathDistance(y.pos, e.storage.pos);
    if (!isFinite(C) || !isFinite(R)) continue;
    var A = i + C;
    if (A >= _) continue;
    var b = Math.max(1, C + R + 1);
    var T = !isFinite(y.ttl) || y.ttl > MAX_CREEP_LIFETIME;
    var S = isFinite(_) ? Math.floor(Math.max(0, _ - i) / b) : Math.ceil(h / n);
    if (T && S < 1) continue;
    S = Math.max(1, S);
    var M = Math.min(h, n * S, s);
    if (!(M > 0)) continue;
    o[E] -= M;
    s -= M;
    var N = a[y.resourceType] || 0;
    p += M * N;
    d += M;
    m += Math.min(_, b * S);
    g++;
  }
  var P = p * CAPTURE_DISCOUNT;
  return {
    potentialProfit: p,
    expectedProfit: P,
    spawnCost: bodyCost(r),
    potentialNet: P - bodyCost(r),
    capacity: n,
    collectable: d,
    travelTicks: m,
    pickupCount: g,
    valuePerEnergy: P / Math.max(1, bodyCost(r)),
    valuePerTick: P / Math.max(1, m)
  };
}

function marketMap(e) {
  var t = {};
  for (var r = 0; r < e.length; r++) {
    var a = e[r].resourceType;
    if (t[a] !== undefined) continue;
    t[a] = priceFor(a);
  }
  return t;
}

function marketSignature(e) {
  var t = {};
  for (var r = 0; r < e.length; r++) t[e[r].resourceType] = true;
  var a = Object.keys(t).sort();
  var n = [];
  for (var i = 0; i < a.length; i++) {
    var o = priceFor(a[i]);
    n.push(a[i] + ":" + Math.round(Math.log1p(o) * MATERIAL_PRICE_STEP));
  }
  var s = priceFor(RESOURCE_ENERGY_NAME);
  return "energy:" + Math.round(Math.log1p(s) * MATERIAL_PRICE_STEP) + "," + n.join(",");
}

function quantizedAmount(e) {
  return Math.floor(Math.max(0, e || 0) / MATERIAL_AMOUNT_STEP);
}

function quantizedTtl(e) {
  return isFinite(e) ? Math.floor(Math.max(0, e) / MATERIAL_TTL_STEP) : "inf";
}

function lootFingerprint(e) {
  var t = [];
  for (var r = 0; r < e.length; r++) {
    var a = e[r];
    t.push([ a.objectType, a.objectId, a.pos.x, a.pos.y, a.resourceType, quantizedAmount(a.amount), quantizedTtl(a.ttl) ].join(":"));
  }
  return t.join("|") + "|overflow:" + (e.overflowCount || 0);
}

function contextFingerprint(e, t, r, a, n) {
  var i = 0;
  try {
    i = e.storage.store.getFreeCapacity();
  } catch (e) {}
  var o = getHostiles(e);
  var s = Array.isArray(o) ? o.length : -1;
  return [ Math.floor(e.energyAvailable / 100), e.energyCapacityAvailable, n.length, r.join(","), Math.floor(i / 100), Math.round(Math.log1p(Math.max(0, a)) * MATERIAL_PRICE_STEP), s, t.overflowCount || 0, marketSignature(t) ].join("|");
}

function buildContext(e, t, r, a, n) {
  var i = [];
  for (var o = 0; o < learning.CONTEXT_SIZE; o++) i.push(0);
  var s = e.storage;
  var l = 0;
  var c = 0;
  for (var u in r) {
    l += r[u].potentialProfit;
    c = Math.max(c, r[u].potentialNet);
  }
  var f = getHostiles(e);
  var p = Array.isArray(f) ? f : [];
  var d = Infinity;
  var m = 0;
  for (var g = 0; g < p.length; g++) {
    d = Math.min(d, cheb(s.pos, p[g].pos));
    if (p[g].body && Array.isArray(p[g].body)) m += p[g].body.length;
  }
  var v = getFreeSpawns(e);
  var y = n && n.store ? n.store.getUsedCapacity() : 0;
  var E = n && n.store ? n.store.getFreeCapacity() : 0;
  i[0] = clamp(t.length / 64, 0, 1);
  i[1] = clamp(new Set(t.map(function(e) {
    return e.objectId;
  })).size / 32, 0, 1);
  i[2] = logNorm(l, 15);
  i[3] = signedLogNorm(c, 15);
  i[4] = clamp(s.store.getFreeCapacity() / 1e5, 0, 1);
  i[5] = clamp(e.energyAvailable / Math.max(1, e.energyCapacityAvailable), 0, 1);
  i[6] = clamp(e.energyCapacityAvailable / 12900, 0, 1);
  i[7] = clamp((e.controller && e.controller.level || 0) / 8, 0, 1);
  i[8] = clamp(p.length / 10, 0, 1);
  i[9] = isFinite(d) ? clamp(d / 50, 0, 1) : 1;
  i[10] = clamp(m / 100, 0, 1);
  i[11] = clamp(v.length / 3, 0, 1);
  i[12] = clamp(a.length / learning.MAX_BODY_SIZE, 0, 1);
  i[13] = clamp(getMyCreeps(e).length / 10, 0, 1);
  i[14] = n ? clamp((n.ticksToLive || 0) / 1500, 0, 1) : 0;
  i[15] = n ? clamp(n.pos.x / 49, 0, 1) : 0;
  i[16] = n ? clamp(n.pos.y / 49, 0, 1) : 0;
  i[17] = clamp(s.pos.x / 49, 0, 1);
  i[18] = clamp(s.pos.y / 49, 0, 1);
  i[19] = clamp(y / 300, 0, 1);
  i[20] = clamp(E / 300, 0, 1);
  i[21] = logNorm(l / Math.max(1, t.length), 12);
  i[22] = logNorm(c, 12);
  i[23] = clamp(e.energyAvailable / 12900, 0, 1);
  i[24] = clamp(t.length > 0 ? priceFor(t[0].resourceType) / 1e3 : 0, 0, 1);
  i[25] = clamp(t.length > 0 ? (priceProfile(t[0].resourceType).bidVolume || 0) / 1e5 : 0, 0, 1);
  i[26] = clamp(t.length > 0 ? priceProfile(t[0].resourceType).spreadRatio || 0 : 0, 0, 1);
  var h = typeof Game !== "undefined" && typeof Game.time === "number" ? Game.time : 0;
  i[27] = clamp(h % 1e3 / 1e3, 0, 1);
  i[28] = n && n.memory && n.memory.targetId ? 1 : 0;
  i[29] = n && n.memory && n.memory.targetResource ? 1 : 0;
  i[30] = clamp((e.storage.store.getUsedCapacity() || 0) / 1e6, 0, 1);
  i[31] = clamp((e.storage.store.getUsedCapacity(RESOURCE_ENERGY_NAME) || 0) / 1e6, 0, 1);
  return i;
}

function bodyActionFeatures(e, t) {
  if (!e) return [ 0, 0, 0, 0, 0, 0, 0, 0 ];
  var r = t ? t.potentialNet : 0;
  return [ logNorm(e.potentialProfit, 15), clamp(e.spawnCost / (learning.BODY_PART_COST * learning.MAX_BODY_SIZE), 0, 1), signedLogNorm(e.potentialNet, 15), clamp(e.collectable / Math.max(1, e.capacity), 0, 1), signedLogNorm(e.potentialNet - r, 15), clamp(e.pickupCount / 32, 0, 1), signedLogNorm(e.potentialNet / Math.max(1, e.spawnCost), 3), logNorm(e.valuePerTick, 10) ];
}

function candidateFeatures(e, t, r) {
  var a = t.containerVector.slice();
  var n = [];
  for (var i = 0; i < learning.RESOURCE_VECTOR_SIZE; i++) n.push(0);
  var o = hasOwn(learning.RESOURCE_INDEX, t.resourceType) ? learning.RESOURCE_INDEX[t.resourceType] : learning.RESOURCE_INDEX[learning.RESOURCE_UNKNOWN];
  n[o] = 1;
  var s = t.objectType === "drop" ? [ 1, 0, 0 ] : t.objectType === "tombstone" ? [ 0, 1, 0 ] : [ 0, 0, 1 ];
  var l = resourceFeatures(t.resourceType);
  var c = r ? cheb(r.pos, t.pos) : t.distanceStorage;
  var u = candidateTravel(e, t, r ? r.pos : e.storage.pos);
  var f = t.amount * l.price;
  var p = [ logNorm(t.amount, 12), logNorm(t.totalAmount, 12), clamp(t.nonEmptyTypes / 16, 0, 1), isFinite(t.ttl) ? clamp(t.ttl / 1500, 0, 1) : 1, clamp(t.distanceStorage / 50, 0, 1), clamp(c / 50, 0, 1), isFinite(u) ? clamp(u / 1e3, 0, 1) : 1, logNorm(l.bestBid, 10), logNorm(l.reference, 10), logNorm(l.liquidity, 12), clamp(l.spread, 0, 1), logNorm(f, 15), logNorm(f / Math.max(1, u), 12), clamp(e.storage.store.getFreeCapacity() / 1e5, 0, 1) ];
  return a.concat(n, s, p);
}

function getSpawnDecision(e) {
  var t = {
    room: e,
    eligible: isEligibleRoom(e),
    candidates: [],
    legalCandidates: [],
    freeSpawns: [],
    legalSizes: [],
    estimates: {},
    contextFeatures: [],
    lootFingerprint: "",
    contextFingerprint: "",
    controllable: false,
    cpuAvailable: false,
    valuationValid: false,
    bestPotentialNet: 0,
    potentialProfit: 0
  };
  if (!t.eligible) return t;
  if (!hasCpuBudget()) return t;
  t.cpuAvailable = true;
  t.candidates = getCandidates(e);
  t.freeSpawns = getFreeSpawns(e);
  var r = t.freeSpawns.length > 0 ? t.freeSpawns[0].pos : e.storage.pos;
  var a = marketMap(t.candidates);
  t.legalCandidates = legalCandidates(e, t.candidates, r, a);
  t.valuationValid = t.legalCandidates.length > 0;
  var n = getLegalBodySizes(e, t.freeSpawns, t.legalCandidates, r);
  for (var i = 0; i < n.length; i++) {
    var o = n[i];
    var s = potentialForBody(e, t.legalCandidates, o, a);
    if (!(s.potentialNet > 0)) continue;
    t.estimates[o] = s;
    t.legalSizes.push(o);
    t.potentialProfit = Math.max(t.potentialProfit, s.potentialProfit);
    t.bestPotentialNet = Math.max(t.bestPotentialNet, s.potentialNet);
  }
  t.lootFingerprint = lootFingerprint(t.candidates);
  t.contextFingerprint = contextFingerprint(e, t.legalCandidates, t.legalSizes, t.bestPotentialNet, t.freeSpawns);
  t.contextFeatures = buildContext(e, t.legalCandidates, t.estimates, t.legalSizes, null);
  t.controllable = t.valuationValid && t.legalCandidates.length > 0 && t.legalSizes.length > 0 && t.bestPotentialNet > 0;
  return t;
}

function chooseBody(e, t) {
  if (!e || !e.controllable || e.bestPotentialNet <= 0 || !t) {
    return {
      bodySize: 0,
      forced: true,
      invalid: !t
    };
  }
  var r = learning.encodeContext(t, e.contextFeatures);
  var a = 0;
  var n = learning.scoreAction(t, r, bodyActionFeatures(null));
  if (!isFinite(n)) return {
    bodySize: 0,
    forced: true,
    invalid: true
  };
  var i = null;
  for (var o = 1; o <= learning.MAX_BODY_SIZE; o++) {
    if (e.legalSizes.indexOf(o) === -1) continue;
    var s = e.estimates[o];
    var l = learning.scoreAction(t, r, bodyActionFeatures(s, i));
    i = s;
    if (!isFinite(l)) return {
      bodySize: 0,
      forced: true,
      invalid: true
    };
    if (l > n) {
      n = l;
      a = o;
    }
  }
  return {
    bodySize: a,
    forced: false,
    invalid: false,
    score: n,
    estimate: a > 0 ? e.estimates[a] : null
  };
}

function pickupResult(e, t, r) {
  return {
    valid: e,
    invalid: !e,
    candidate: null,
    candidates: r || [],
    reason: t
  };
}

function getPickupDecision(e) {
  var t = e && e.room;
  if (!e || !isEligibleRoom(t)) return pickupResult(true, "ineligible");
  var a = cpuBudgetState();
  if (!a.verifiable) return pickupResult(false, "cpu-unverifiable");
  if (!a.available) return pickupResult(true, "cpu");
  var n = e.memory && e.memory.scavengerPolicy;
  if (!n || !n.modelId) return pickupResult(false, "no-model");
  var i = learning.getModelRecord(n.modelId);
  if (!i || i.version !== n.modelVersion) return pickupResult(false, "stale-model");
  var o = learning.getModel(n.modelId);
  if (!o) return pickupResult(false, "no-model");
  var s = getCandidates(t);
  var l = marketMap(s);
  var c = s.filter(function(e) {
    return l[e.resourceType] > 0;
  });
  if (s.length > 0 && c.length === 0) return pickupResult(false, "unpriced");
  var u = e.memory.blockedTargets || null;
  var b = 0;
  var f = legalCandidates(t, c, e.pos, l).filter(function(t) {
    if (u && u[t.objectId]) {
      b++;
      return false;
    }
    return e.store.getFreeCapacity(t.resourceType) > 0;
  });
  var r = pickupResult(true, "ok", f);
  if (!f.length) {
    r.reason = c.length === 0 ? "no-loot" : b > 0 ? "all-blocked" : "no-legal";
    return r;
  }
  var p = buildContext(t, f, {}, [], e);
  var d = learning.encodeContext(o, p);
  var m = null;
  var g = -Infinity;
  for (var v = 0; v < f.length; v++) {
    if (!hasCpuBudget()) {
      r.reason = "cpu";
      return r;
    }
    var y = learning.scoreCandidate(o, d, candidateFeatures(t, f[v], e));
    if (!isFinite(y)) return pickupResult(false, "invalid", f);
    if (!m || y > g) {
      m = f[v];
      g = y;
    }
  }
  r.candidate = m;
  r.score = g;
  return r;
}

function roomHasLoot(e) {
  if (!isEligibleRoom(e)) return false;
  var t = getCandidates(e);
  for (var r = 0; r < t.length; r++) {
    if (priceFor(t[r].resourceType) > 0) return true;
  }
  return false;
}

function isActiveScavenger(e) {
  if (typeof Game === "undefined" || !Game.creeps) return false;
  for (var t in Game.creeps) {
    var r = Game.creeps[t];
    if (!r || !r.memory || r.memory.role !== "scavenger") continue;
    if ((r.memory.homeRoom || r.memory.assignedRoom) === e) return true;
  }
  if (typeof Memory !== "undefined" && Memory.creeps) {
    for (var a in Memory.creeps) {
      var n = Memory.creeps[a];
      if (!n || n.role !== "scavenger") continue;
      if ((n.homeRoom || n.assignedRoom) === e) return true;
    }
  }
  return false;
}

function estimateBody(e) {
  return {
    bodySize: e,
    body: e > 0 ? buildBody(e) : [],
    cost: bodyCost(e),
    capacity: e * CARRY_CAPACITY
  };
}

function buildBody(e) {
  var t = [];
  for (var r = 0; r < e; r++) t.push(MOVE, CARRY);
  return t;
}

module.exports = {
  STORAGE_RANGE: STORAGE_RANGE,
  MAX_BODY_SIZE: learning.MAX_BODY_SIZE,
  canEvaluate: hasCpuBudget,
  isEligibleRoom: isEligibleRoom,
  getEligibleRooms: getEligibleRooms,
  getCandidates: getCandidates,
  getSpawnDecision: getSpawnDecision,
  chooseBody: chooseBody,
  getPickupDecision: getPickupDecision,
  roomHasLoot: roomHasLoot,
  isActiveScavenger: isActiveScavenger,
  estimateBody: estimateBody,
  buildBody: buildBody,
  lootFingerprint: lootFingerprint,
  contextFingerprint: contextFingerprint,
  candidateFeatures: candidateFeatures,
  getRemainingTtl: getRemainingTtl,
  canonicalPrice: priceFor
};
