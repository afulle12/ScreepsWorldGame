// LLM: Read docs/codex.js before reviewing or changing this file.
// storageVfs.js
// Console globals: vfsStatus, vfsLs, vfsParityReport, vfsMigrateLegacy
// Example: vfsStatus() - Display virtual file system mount and segment status
// Example: vfsLs() - List files and datasets stored in virtual file system
// Example: vfsParityReport() - Verify data parity and CRC consistency across segments
// Example: vfsMigrateLegacy() - Migrate legacy reservations into VFS storage
/**
 * storageVfs.js
 * ────────────
 * Virtual File System (VFS) core engine for Screeps resource and capacity reservations.
 *
 * Backed by Memory.storageReservationsV2.
 *
 * Paths:
 *   /rooms/<room>/storage/<resource>
 *   /rooms/<room>/terminal/<resource>
 *   /rooms/<room>/factory/<factoryId>/<resource>
 *   /rooms/<room>/lab/<labId>/<resource>
 *   /rooms/<room>/container/<containerId>/<resource>
 *   /rooms/<room>/powerSpawn/<powerSpawnId>/<resource>
 *
 * (Nuker paths are EXCLUDED from writable VFS mounts.)
 *
 * Usage: inspect reservations through the registered console helpers.
 * Example: vfsStatus(); vfsLs('/rooms/E1N1/storage/energy');
 */
const getRoomState = require("getRoomState");
const memoryManager = require("memoryManager");
const V2_VERSION = 1;
const TTL_SHORT = 500;
const TTL_NORMAL = 1e3;
const TTL_QUEUED = 2e3;
const TTL_RESERVATION = 1e5;
const STALE_RESERVATION_AGE = 2e4;
const ORPHAN_CAP = 20;
const ORPHAN_TTL = 2e4;
const ORPHAN_SCAN_INTERVAL = 100;
let lastOrphanPruneTick = 0;

function summarizeOrphanRecord(e) {
  if (!e || typeof e !== "object") return String(e);
  return (e.program || "?") + ":" + (e.amount === undefined ? "?" : e.amount);
}

function normalizeLegacyReservation(e) {
  if (!Array.isArray(e)) return e;
  return {
    program: e[0],
    amount: e[1],
    time: e[2]
  };
}

function pruneOrphans(e) {
  if (Game.time - lastOrphanPruneTick < ORPHAN_SCAN_INTERVAL) return 0;
  lastOrphanPruneTick = Game.time;
  if (!Array.isArray(e.orphans) || !e.orphans.length) return 0;
  const __before = e.orphans.length;
  e.orphans = e.orphans.filter(function(__o) {
    return __o && Game.time - (__o.importedAt || 0) <= ORPHAN_TTL;
  });
  if (e.orphans.length > ORPHAN_CAP) e.orphans = e.orphans.slice(-ORPHAN_CAP);
  const __removed = __before - e.orphans.length;
  if (__removed > 0) memoryManager.requestSave();
  return __removed;
}

const WRITABLE_STRUCTURE_TYPES = {
  storage: true,
  terminal: true,
  factory: true,
  lab: true,
  container: true,
  powerSpawn: true
};
function validSegment(e) {
  return typeof e === "string" && e.length > 0 && e !== "." && e !== ".." && e.indexOf("/") < 0 && e.indexOf("\\") < 0;
}

function validRoomName(e) {
  return validSegment(e) && /^[WE]\d+[NS]\d+$/.test(e);
}

function activeLock(e) {
  return !!(e && (e.expiryTick === undefined || e.expiryTick > Game.time) && typeof e.amount === "number" && Number.isFinite(e.amount) && e.amount > 0);
}

function normalizeTtl(e, t) {
  return typeof e === "number" && Number.isFinite(e) && e > 0 ? e : t;
}

function capacityNodeKey(e) {
  return `/rooms/${e.roomName}/${e.structureType}/${e.targetId}`;
}

function parsedCapacityRecord(e) {
  return {
    roomName: e.roomName,
    structureType: e.structureType,
    targetId: e.targetId,
    resourceType: e.resourceType
  };
}

function removeLockFromRoot(e, t) {
  const o = e.locks[t];
  if (!o) return null;
  delete e.locks[t];
  if (Array.isArray(e.lockIndex[o.nodeKey])) {
    e.lockIndex[o.nodeKey] = e.lockIndex[o.nodeKey].filter(function(e) {
      return e !== t;
    });
    if (e.lockIndex[o.nodeKey].length === 0) delete e.lockIndex[o.nodeKey];
  }
  return o;
}

function nextId(e, t) {
  let o;
  do {
    o = e + Game.time + "_" + Math.random().toString(36).substr(2, 8);
  } while (t[o]);
  return o;
}

function getV2Root() {
  if (!Memory.storageReservationsV2) {
    Memory.storageReservationsV2 = {
      version: V2_VERSION,
      nodes: {},
      locks: {},
      lockIndex: {},
      capacities: {},
      orphans: [],
      lastMaintenanceTick: 0,
      importedLegacy: false,
      lockCursor: 0,
      capacityCursor: 0
    };
  }
  const e = Memory.storageReservationsV2;
  if (!e.nodes || typeof e.nodes !== "object") e.nodes = {};
  if (!e.locks || typeof e.locks !== "object") e.locks = {};
  if (!e.lockIndex || typeof e.lockIndex !== "object") e.lockIndex = {};
  if (!e.capacities || typeof e.capacities !== "object") e.capacities = {};
  if (!Array.isArray(e.orphans)) e.orphans = [];
  delete e.mode;
  if (typeof e.importedLegacy !== "boolean") e.importedLegacy = false;
  if (!Number.isFinite(e.lockCursor) || e.lockCursor < 0) e.lockCursor = 0;
  if (!Number.isFinite(e.capacityCursor) || e.capacityCursor < 0) e.capacityCursor = 0;
  delete e.divergence;
  for (const t in e.capacities) {
    const o = e.capacities[t];
    if (!o || typeof o !== "object" || typeof o.capacity !== "number" || !Number.isFinite(o.capacity) || o.capacity <= 0) {
      delete e.capacities[t];
      continue;
    }
    if (typeof o.received !== "number" || !Number.isFinite(o.received) || o.received < 0) {
      o.received = 0;
    }
    if (o.received > o.capacity) o.received = o.capacity;
    if (!o.capacityLockId) o.capacityLockId = t;
  }
  return e;
}

function parsePath(e) {
  if (!e || typeof e !== "string" || e[0] !== "/") return null;
  const t = e.split("/");
  if (t.some(function(e, t) {
    return t > 0 && e === "";
  })) return null;
  const o = t.filter(Boolean);
  if (o.length < 4 || o[0] !== "rooms") return null;
  const r = o[1];
  const n = o[2];
  if (!validRoomName(r) || !validSegment(n) || !validSegment(o[o.length - 1]) || !WRITABLE_STRUCTURE_TYPES[n]) {
    return null;
  }
  if (n === "nuker") return null;
  if (n === "storage" || n === "terminal") {
    if (o.length !== 4) return null;
    const e = o[3];
    if (!validSegment(e)) return null;
    return {
      roomName: r,
      structureType: n,
      targetId: n,
      resourceType: e,
      nodeKey: `/rooms/${r}/${n}/${e}`
    };
  } else if (o.length === 5) {
    const e = o[3];
    const t = o[4];
    if (!validSegment(e) || !validSegment(t)) return null;
    return {
      roomName: r,
      structureType: n,
      targetId: e,
      resourceType: t,
      nodeKey: `/rooms/${r}/${n}/${e}/${t}`
    };
  }
  return null;
}

function resolveStructure(e) {
  if (!e) return null;
  const t = Game.rooms[e.roomName];
  if (!t) return null;
  if (e.structureType === "storage") {
    return t.storage && t.storage.structureType === STRUCTURE_STORAGE ? t.storage : null;
  }
  if (e.structureType === "terminal") {
    return t.terminal && t.terminal.structureType === STRUCTURE_TERMINAL ? t.terminal : null;
  }
  if (Game.getObjectById) {
    const t = Game.getObjectById(e.targetId);
    if (t && t.structureType === e.structureType) return t;
  }
  return null;
}

function getPhysicalStock(e) {
  const t = resolveStructure(e);
  if (!t || !t.store) return 0;
  const o = typeof t.store.getUsedCapacity === "function" ? t.store.getUsedCapacity(e.resourceType) : t.store[e.resourceType];
  return typeof o === "number" && Number.isFinite(o) && o > 0 ? o : 0;
}

function getPhysicalFreeCapacity(e) {
  const t = resolveStructure(e);
  if (!t || !t.store) return 0;
  if (typeof t.store.getFreeCapacity === "function") {
    const e = t.store.getFreeCapacity();
    return typeof e === "number" && Number.isFinite(e) ? Math.max(0, e) : 0;
  }
  const o = typeof t.storeCapacity === "number" && Number.isFinite(t.storeCapacity) ? Math.max(0, t.storeCapacity) : 3e5;
  const r = typeof t.store.getUsedCapacity === "function" ? t.store.getUsedCapacity() : Object.keys(t.store).reduce(function(e, o) {
    const r = t.store[o];
    return e + (typeof r === "number" && Number.isFinite(r) ? r : 0);
  }, 0);
  return Math.max(0, o - r);
}

const storageVfs = {
  TTL_SHORT: TTL_SHORT,
  TTL_NORMAL: TTL_NORMAL,
  TTL_QUEUED: TTL_QUEUED,
  TTL_RESERVATION: TTL_RESERVATION,
  STALE_RESERVATION_AGE: STALE_RESERVATION_AGE,
  stat: function(e) {
    const t = parsePath(e);
    if (!t) return {
      ok: false,
      reason: "Invalid or excluded path"
    };
    const o = getV2Root();
    const r = o.lockIndex[t.nodeKey] || [];
    let n = 0;
    const i = [];
    for (let e = 0; e < r.length; e++) {
      const t = o.locks[r[e]];
      if (activeLock(t)) {
        n += t.amount;
        i.push(t);
      }
    }
    const a = getPhysicalStock(t);
    const c = Math.max(0, a - n);
    return {
      ok: true,
      path: t.nodeKey,
      roomName: t.roomName,
      structureType: t.structureType,
      resourceType: t.resourceType,
      total: a,
      reserved: n,
      available: c,
      locks: i
    };
  },
  getReserved: function(e, t, o) {
    const r = this.stat("/rooms/" + e + "/" + t + "/" + o);
    return r && r.ok ? r.reserved : 0;
  },
  getAvailable: function(e, t, o) {
    const r = this.stat("/rooms/" + e + "/" + t + "/" + o);
    return r && r.ok ? r.available : 0;
  },
  getReservationList: function(e, t, o) {
    const r = this.stat("/rooms/" + e + "/" + t + "/" + o);
    if (!r || !r.ok) return [];
    return r.locks.map(function(e) {
      return {
        program: e.program || e.ownerId || "default",
        amount: e.amount,
        time: typeof e.lastTouchTick === "number" ? e.lastTouchTick : e.createdTick
      };
    });
  },
  getReservationNodes: function(e) {
    const t = getV2Root();
    const o = [];
    for (const r in t.lockIndex) {
      const n = parsePath(r);
      if (!n || (e && n.roomName !== e) || (n.structureType !== "terminal" && n.structureType !== "storage")) continue;
      o.push({
        roomName: n.roomName,
        building: n.structureType,
        resource: n.resourceType
      });
    }
    return o;
  },
  ls: function(e) {
    const t = getV2Root();
    if (!e || e === "/" || e === "/rooms") {
      return Object.keys(Game.rooms);
    }
    const o = e.split("/").filter(Boolean);
    if (o.length === 2 && o[0] === "rooms") {
      return [ "storage", "terminal", "factory", "lab", "container", "powerSpawn" ];
    }
    const r = [];
    const n = e.endsWith("/") ? e : e + "/";
    for (const e in t.lockIndex) {
      if (e.startsWith(n)) {
        r.push(e);
      }
    }
    return r;
  },
  lock: function(e, t) {
    const o = parsePath(e);
    if (!o) return {
      ok: false,
      reason: "Invalid or excluded path"
    };
    t = t || {};
    const r = t.program || "default";
    const n = t.ownerId || r;
    const i = t.amount;
    const a = normalizeTtl(t.ttl, TTL_NORMAL);
    const c = t.priority || 1;
    const s = !!t.preemptible;
    if (typeof i !== "number" || !Number.isFinite(i) || i <= 0) {
      return {
        ok: false,
        reason: "Amount must be a positive finite number"
      };
    }
    const u = getV2Root();
    const l = o.nodeKey;
    if (!u.lockIndex[l]) u.lockIndex[l] = [];
    const m = u.lockIndex[l];
    let f = null;
    let d = 0;
    for (let e = 0; e < m.length; e++) {
      const t = u.locks[m[e]];
      if (!t) continue;
      if (!activeLock(t)) continue;
      if (t.program === r || t.ownerId === n) {
        f = t;
      } else {
        d += t.amount || 0;
      }
    }
    const p = getPhysicalStock(o);
    const y = f ? f.amount : 0;
    const k = i - y;
    const g = p - d;
    if (k > 0 && i > g) {
      return {
        ok: false,
        reason: "Insufficient available resources. Requested: " + i + ", Available: " + g + " (actual: " + p + ", reserved by others: " + d + ")"
      };
    }
    if (f) {
      f.program = r;
      f.ownerId = n;
      f.amount = i;
      f.lastTouchTick = Game.time;
      f.expiryTick = Game.time + a;
      f.priority = c;
      f.preemptible = s;
      return {
        ok: true,
        lockId: f.lockId,
        replaced: true
      };
    }
    const T = "lock_" + Game.time + "_" + Math.random().toString(36).substr(2, 6);
    const h = {
      lockId: T,
      nodeKey: l,
      roomName: o.roomName,
      structureType: o.structureType,
      targetId: o.targetId,
      resourceType: o.resourceType,
      program: r,
      ownerId: n,
      amount: i,
      createdTick: Game.time,
      lastTouchTick: Game.time,
      expiryTick: Game.time + a,
      priority: c,
      preemptible: s,
      handoffMetadata: null
    };
    u.locks[T] = h;
    u.lockIndex[l].push(T);
    return {
      ok: true,
      lockId: T,
      replaced: false
    };
  },
  unlock: function(e) {
    if (!e) return {
      ok: false,
      reason: "Missing lockId"
    };
    const t = getV2Root();
    const o = t.locks[e];
    if (!o) return {
      ok: false,
      reason: "Lock not found"
    };
    delete t.locks[e];
    if (t.lockIndex[o.nodeKey]) {
      t.lockIndex[o.nodeKey] = t.lockIndex[o.nodeKey].filter(t => t !== e);
      if (t.lockIndex[o.nodeKey].length === 0) delete t.lockIndex[o.nodeKey];
    }
    return {
      ok: true,
      released: o.amount
    };
  },
  touch: function(e, t) {
    if (!e) return {
      ok: false,
      reason: "Missing lockId"
    };
    const o = getV2Root();
    const r = o.locks[e];
    if (!r) return {
      ok: false,
      reason: "Lock not found"
    };
    if (!activeLock(r)) return {
      ok: false,
      reason: "Lock expired"
    };
    const n = normalizeTtl(t, TTL_NORMAL);
    r.lastTouchTick = Game.time;
    r.expiryTick = Game.time + n;
    return {
      ok: true,
      expiryTick: r.expiryTick
    };
  },
  write: function(e, t, o, opts) {
    if (!t) return {
      ok: false,
      consumed: 0,
      remaining: 0,
      reason: "Missing lockId"
    };
    if (typeof o !== "number" || !Number.isFinite(o) || o <= 0) {
      return {
        ok: false,
        consumed: 0,
        remaining: 0,
        reason: "Amount must be positive finite number"
      };
    }
    const r = parsePath(e);
    if (!r) return {
      ok: false,
      consumed: 0,
      remaining: 0,
      reason: "Invalid or excluded path"
    };
    const n = getV2Root();
    const i = n.locks[t];
    if (!i) return {
      ok: false,
      consumed: 0,
      remaining: 0,
      reason: "Lock not found"
    };
    if (i.nodeKey !== r.nodeKey) {
      return {
        ok: false,
        consumed: 0,
        remaining: i.amount || 0,
        reason: "Lock does not belong to path"
      };
    }
    if (!activeLock(i)) {
      return {
        ok: false,
        consumed: 0,
        remaining: 0,
        reason: "Lock expired"
      };
    }
    const a = Math.min(o, i.amount);
    i.amount -= a;
    i.lastTouchTick = Game.time;
    i.expiryTick = Game.time + normalizeTtl(opts && opts.ttl, TTL_NORMAL);
    if (i.amount <= 0) {
      this.unlock(t);
      return {
        ok: true,
        consumed: a,
        remaining: 0
      };
    }
    return {
      ok: true,
      consumed: a,
      remaining: i.amount
    };
  },
  mv: function(e, t, o) {
    if (!e) return {
      ok: false,
      reason: "Missing lockId"
    };
    const r = parsePath(t);
    if (!r) return {
      ok: false,
      reason: "Invalid or excluded destination path"
    };
    const n = getV2Root();
    const i = n.locks[e];
    if (!i) return {
      ok: false,
      reason: "Source lock not found"
    };
    if (!activeLock(i)) return {
      ok: false,
      reason: "Source lock expired"
    };
    if (i.resourceType !== r.resourceType) {
      return {
        ok: false,
        reason: "Cannot move a lock between resource types"
      };
    }
    o = o || {};
    const a = o.toProgram || i.program;
    const c = o.toOwnerId || i.ownerId;
    if (o.amount !== undefined && (typeof o.amount !== "number" || !Number.isFinite(o.amount) || o.amount < 0)) {
      return {
        ok: false,
        reason: "Amount must be a non-negative finite number"
      };
    }
    const s = o.amount === undefined ? i.amount : Math.min(o.amount, i.amount);
    if (s === 0) {
      return {
        ok: true,
        lockId: e,
        transferred: 0,
        remaining: i.amount
      };
    }
    const u = normalizeTtl(o.ttl, TTL_NORMAL);
    const l = r.nodeKey;
    const m = n.lockIndex[l] || [];
    let f = null;
    for (let t = 0; t < m.length; t++) {
      const o = n.locks[m[t]];
      if (o && o.lockId !== e && activeLock(o) && (o.program === a || o.ownerId === c)) {
        f = o;
        break;
      }
    }
    if (i.nodeKey === l) {
      if (i.program === a && i.ownerId === c && !f) {
        return {
          ok: true,
          lockId: e,
          transferred: 0,
          remaining: i.amount
        };
      }
      if (f) {
        f.amount += s;
        f.lastTouchTick = Game.time;
        f.expiryTick = Game.time + u;
        i.amount -= s;
        i.lastTouchTick = Game.time;
        if (i.amount <= 0) removeLockFromRoot(n, e); else i.expiryTick = Game.time + u;
        return {
          ok: true,
          lockId: f.lockId,
          transferred: s,
          fromRemaining: Math.max(0, i.amount)
        };
      }
      if (s === i.amount) {
        i.program = a;
        i.ownerId = c;
        i.lastTouchTick = Game.time;
        i.expiryTick = Game.time + u;
        i.handoffMetadata = o.handoffMetadata || null;
        return {
          ok: true,
          lockId: e,
          transferred: s,
          fromRemaining: 0
        };
      }
    } else {
      let e = 0;
      for (let t = 0; t < m.length; t++) {
        const o = n.locks[m[t]];
        if (o && o.lockId !== (f && f.lockId) && activeLock(o)) {
          e += o.amount;
        }
      }
      const t = getPhysicalStock(r);
      const o = f ? f.amount : 0;
      if (o + s > t - e) {
        return {
          ok: false,
          reason: "Insufficient available resources at destination. Requested: " + (o + s) + ", Available: " + (t - e)
        };
      }
    }
    if (!f) {
      const e = nextId("lock_", n.locks);
      f = {
        lockId: e,
        nodeKey: l,
        roomName: r.roomName,
        structureType: r.structureType,
        targetId: r.targetId,
        resourceType: r.resourceType,
        program: a,
        ownerId: c,
        amount: s,
        createdTick: Game.time,
        lastTouchTick: Game.time,
        expiryTick: Game.time + u,
        priority: i.priority,
        preemptible: i.preemptible,
        handoffMetadata: o.handoffMetadata || null
      };
      n.locks[f.lockId] = f;
      if (!n.lockIndex[l]) n.lockIndex[l] = [];
      n.lockIndex[l].push(f.lockId);
    } else if (i.nodeKey !== l) {
      f.amount += s;
      f.lastTouchTick = Game.time;
      f.expiryTick = Game.time + u;
      f.handoffMetadata = o.handoffMetadata || null;
    }
    i.amount -= s;
    i.lastTouchTick = Game.time;
    if (i.amount <= 0) removeLockFromRoot(n, e); else i.expiryTick = Game.time + u;
    return {
      ok: true,
      lockId: f.lockId,
      transferred: s,
      fromRemaining: Math.max(0, i.amount)
    };
  },
  lockCapacity: function(e, t) {
    const o = parsePath(e);
    if (!o) return {
      ok: false,
      reason: "Invalid destination path"
    };
    t = t || {};
    const r = t.program || "capacity";
    const n = t.ownerId || r;
    const i = t.capacity;
    const a = normalizeTtl(t.ttl, TTL_QUEUED);
    if (typeof i !== "number" || !Number.isFinite(i) || i <= 0) {
      return {
        ok: false,
        reason: "Capacity must be positive finite number"
      };
    }
    const c = getPhysicalFreeCapacity(o);
    const s = getV2Root();
    const u = capacityNodeKey(o);
    let l = null;
    let m = 0;
    for (const e in s.capacities) {
      const t = s.capacities[e];
      if (!t || t.expiryTick <= Game.time) continue;
      const i = t.capacityNodeKey || `/rooms/${t.roomName}/${t.structureType}/${t.targetId}`;
      if (i !== u) continue;
      if (t.nodeKey === o.nodeKey && t.program === r && t.ownerId === n) {
        l = t;
        continue;
      }
      m += Math.max(0, t.capacity - t.received);
    }
    const f = c - m;
    const d = l ? Math.max(0, i - l.received) : i;
    if (d > f) {
      return {
        ok: false,
        reason: "Insufficient free capacity. Requested: " + i + ", Available: " + f
      };
    }
    if (l) {
      l.capacity = Math.max(i, l.received);
      l.lastTouchTick = Game.time;
      l.expiryTick = Game.time + a;
      return {
        ok: true,
        capacityLockId: l.capacityLockId,
        replaced: true
      };
    }
    const p = nextId("cap_", s.capacities);
    s.capacities[p] = {
      capacityLockId: p,
      nodeKey: o.nodeKey,
      capacityNodeKey: u,
      roomName: o.roomName,
      structureType: o.structureType,
      targetId: o.targetId,
      resourceType: o.resourceType,
      program: r,
      ownerId: n,
      capacity: i,
      received: 0,
      createdTick: Game.time,
      lastTouchTick: Game.time,
      expiryTick: Game.time + a
    };
    return {
      ok: true,
      capacityLockId: p
    };
  },
  reduceCapacity: function(e, t) {
    if (!e) return {
      ok: false,
      reason: "Missing capacityLockId"
    };
    const o = getV2Root();
    const r = o.capacities[e];
    if (!r) return {
      ok: false,
      reason: "Capacity lock not found"
    };
    if (r.expiryTick !== undefined && r.expiryTick <= Game.time) {
      return {
        ok: false,
        reason: "Capacity lock expired"
      };
    }
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
      return {
        ok: false,
        reason: "Amount must be a non-negative finite number"
      };
    }
    r.received = Math.min(r.capacity, r.received + t);
    r.lastTouchTick = Game.time;
    const n = Math.max(0, r.capacity - r.received);
    if (n <= 0) {
      delete o.capacities[e];
      return {
        ok: true,
        remainingCapacity: 0
      };
    }
    return {
      ok: true,
      remainingCapacity: n
    };
  },
  unlockCapacity: function(e) {
    if (!e) return {
      ok: false,
      reason: "Missing capacityLockId"
    };
    const t = getV2Root();
    if (!t.capacities[e]) return {
      ok: false,
      reason: "Capacity lock not found"
    };
    delete t.capacities[e];
    return {
      ok: true
    };
  },
  touchCapacity: function(e, t) {
    if (!e) return {
      ok: false,
      reason: "Missing capacityLockId"
    };
    const o = getV2Root();
    const r = o.capacities[e];
    if (!r) return {
      ok: false,
      reason: "Capacity lock not found"
    };
    if (r.expiryTick !== undefined && r.expiryTick <= Game.time) {
      return {
        ok: false,
        reason: "Capacity lock expired"
      };
    }
    r.lastTouchTick = Game.time;
    r.expiryTick = Game.time + normalizeTtl(t, TTL_QUEUED);
    return {
      ok: true,
      expiryTick: r.expiryTick
    };
  },
  resizeCapacity: function(e, t, o) {
    if (!e) return {
      ok: false,
      reason: "Missing capacityLockId"
    };
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
      return {
        ok: false,
        reason: "Capacity must be a positive finite number"
      };
    }
    const r = getV2Root();
    const n = r.capacities[e];
    if (!n) return {
      ok: false,
      reason: "Capacity lock not found"
    };
    if (n.expiryTick !== undefined && n.expiryTick <= Game.time) {
      return {
        ok: false,
        reason: "Capacity lock expired"
      };
    }
    if (t < n.received) {
      return {
        ok: false,
        reason: "Capacity cannot be below already received amount"
      };
    }
    if (t > n.capacity) {
      const o = parsedCapacityRecord(n);
      const i = getPhysicalFreeCapacity(o);
      const a = n.capacityNodeKey || `/rooms/${n.roomName}/${n.structureType}/${n.targetId}`;
      let c = 0;
      for (const t in r.capacities) {
        const o = r.capacities[t];
        if (!o || o.capacityLockId === e || o.expiryTick <= Game.time) continue;
        const n = o.capacityNodeKey || `/rooms/${o.roomName}/${o.structureType}/${o.targetId}`;
        if (n === a) c += Math.max(0, o.capacity - o.received);
      }
      if (t - n.capacity > i - c) {
        return {
          ok: false,
          reason: "Insufficient free capacity. Requested: " + (t - n.capacity) + ", Available: " + (i - c)
        };
      }
    }
    n.capacity = t;
    n.lastTouchTick = Game.time;
    n.expiryTick = Game.time + normalizeTtl(o, TTL_QUEUED);
    return {
      ok: true,
      capacity: n.capacity
    };
  },
  extendCapacity: function(e, t, o) {
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
      return {
        ok: false,
        reason: "Amount must be a positive finite number"
      };
    }
    const r = getV2Root();
    const n = r.capacities[e];
    if (!n) return {
      ok: false,
      reason: "Capacity lock not found"
    };
    return this.resizeCapacity(e, n.capacity + t, o);
  },
  sanitizeReservations: function(e) {
    const t = getV2Root();
    let removed = 0;
    const ids = Object.keys(t.locks);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const lock = t.locks[id];
      const path = lock && parsePath(lock.nodeKey);
      if (path && e && path.roomName !== e) continue;
      if (path && path.structureType !== "terminal" && path.structureType !== "storage") continue;
      if (lock && path && typeof lock.program === "string" && lock.program && activeLock(lock)) continue;
      if (lock && lock.nodeKey) {
        removeLockFromRoot(t, id);
      } else {
        delete t.locks[id];
        for (const nodeKey in t.lockIndex) {
          t.lockIndex[nodeKey] = t.lockIndex[nodeKey].filter(function(lockId) {
            return lockId !== id;
          });
          if (t.lockIndex[nodeKey].length === 0) delete t.lockIndex[nodeKey];
        }
      }
      removed++;
    }
    if (removed > 0) memoryManager.requestSave();
    return removed;
  },
  runMaintenance: function(e) {
    const t = getV2Root();
    const o = typeof e === "number" && Number.isFinite(e) && e > 0 ? Math.floor(e) : 50;
    let r = 0;
    let n = 0;
    let i = 0;
    let a = 0;
    let staleLocks = 0;
    const c = Object.keys(t.locks);
    if (c.length > 0) {
      const start = Math.floor(t.lockCursor) % c.length;
      const checks = Math.min(o, c.length);
      for (let e = 0; e < checks; e++) {
        const lock = t.locks[c[(start + e) % c.length]];
        const lastTouch = lock && (typeof lock.lastTouchTick === "number" ? lock.lastTouchTick : lock.createdTick);
        if (lock && lock.expiryTick !== undefined && lock.expiryTick <= Game.time) {
          console.log(`[StorageVFS] Purging expired VFS lock ${lock.lockId} (${lock.nodeKey} by ${lock.program})`);
          this.unlock(lock.lockId);
          i++;
        } else if (lock && typeof lastTouch === "number" && Game.time - lastTouch >= STALE_RESERVATION_AGE) {
          console.log(`[StorageVFS] Purging stale VFS lock ${lock.lockId} (${lock.nodeKey} by ${lock.program}, last touch ${lastTouch})`);
          this.unlock(lock.lockId);
          staleLocks++;
        }
      }
      r = checks;
      t.lockCursor = (start + checks) % c.length;
    } else {
      t.lockCursor = 0;
    }
    const s = Object.keys(t.capacities);
    if (s.length > 0) {
      const start = Math.floor(t.capacityCursor) % s.length;
      const checks = Math.min(o, s.length);
      for (let e = 0; e < checks; e++) {
        const id = s[(start + e) % s.length];
        const capacity = t.capacities[id];
        if (capacity && capacity.expiryTick <= Game.time) {
          delete t.capacities[id];
          a++;
        }
      }
      n = checks;
      t.capacityCursor = (start + checks) % s.length;
    } else {
      t.capacityCursor = 0;
    }
    pruneOrphans(t);
    t.lastMaintenanceTick = Game.time;
    return {
      checked: r,
      capacityChecked: n,
      expiredLocks: i,
      staleLocks: staleLocks,
      expiredCapacities: a
    };
  },
  migrateLegacyReservations: function(e) {
    const t = getV2Root();
    const hasLegacy = Object.prototype.hasOwnProperty.call(Memory, "storageReservations") && Memory.storageReservations !== undefined && Memory.storageReservations !== null;
    if (!hasLegacy) {
      if (!t.importedLegacy) {
        t.importedLegacy = true;
        memoryManager.requestSave();
      }
      return {
        count: 0,
        importedAmount: 0
      };
    }
    let o = 0;
    let r = 0;
    let failed = 0;
    const n = Memory.storageReservations && typeof Memory.storageReservations === "object" ? Memory.storageReservations : {};
    const pending = {};
    const i = Object.keys(n);
    for (let e = 0; e < i.length; e++) {
      const a = i[e];
      if (!n[a] || typeof n[a] !== "object") continue;
      const c = Object.keys(n[a]);
      for (let e = 0; e < c.length; e++) {
        const i = c[e];
        if (i !== "terminal" && i !== "storage") continue;
        if (!n[a][i] || typeof n[a][i] !== "object") continue;
        const s = Object.keys(n[a][i]);
        for (let e = 0; e < s.length; e++) {
          const c = s[e];
          const u = n[a][i][c];
          if (!Array.isArray(u)) continue;
          for (let e = 0; e < u.length; e++) {
            const legacy = normalizeLegacyReservation(u[e]);
            if (!legacy || typeof legacy.program !== "string" || !legacy.program || typeof legacy.amount !== "number" || !Number.isFinite(legacy.amount) || legacy.amount <= 0) {
              t.orphans.push({
                roomName: a,
                building: i,
                material: c,
                record: summarizeOrphanRecord(legacy),
                importedAt: Game.time
              });
              continue;
            }
            const s = "/rooms/" + a + "/" + i + "/" + c;
            const key = s + "\u0000" + legacy.program;
            const aggregate = pending[key];
            if (aggregate) {
              const amount = aggregate.amount + legacy.amount;
              if (!Number.isFinite(amount)) {
                t.orphans.push({
                  roomName: a,
                  building: i,
                  material: c,
                  record: summarizeOrphanRecord(legacy),
                  importedAt: Game.time
                });
                continue;
              }
              aggregate.amount = amount;
              if (typeof legacy.time === "number" && Number.isFinite(legacy.time) && (aggregate.time === undefined || legacy.time > aggregate.time)) {
                aggregate.time = legacy.time;
              }
              continue;
            }
            pending[key] = {
              path: s,
              program: legacy.program,
              amount: legacy.amount,
              time: typeof legacy.time === "number" && Number.isFinite(legacy.time) ? legacy.time : undefined
            };
          }
        }
      }
    }
    for (const key in pending) {
      const legacy = pending[key];
      const l = this.lock(legacy.path, {
        program: legacy.program,
        ownerId: legacy.program,
        amount: legacy.amount,
        ttl: TTL_RESERVATION
      });
      if (l.ok) {
        const lock = t.locks[l.lockId];
        if (lock) {
          if (typeof legacy.time === "number" && Number.isFinite(legacy.time)) {
            lock.createdTick = legacy.time;
            lock.lastTouchTick = legacy.time;
          }
          lock.expiryTick = Math.max(Game.time + TTL_RESERVATION, (legacy.time || Game.time) + TTL_RESERVATION);
        }
        o++;
        r += legacy.amount;
      } else {
        failed++;
      }
    }
    if (failed === 0) {
      const parity = this.getParityReport();
      const counts = parity.counts || {};
      const atRisk = (counts.legacyOnly || 0) + (counts.amountMismatch || 0);
      if (atRisk > 0) failed = atRisk;
    }
    if (failed > 0) {
      console.log(`[StorageVFS] Legacy reservation migration deferred: ${failed} lock(s) failed.`);
    } else {
      t.importedLegacy = true;
      delete Memory.storageReservations;
      memoryManager.requestSave();
      console.log(`[StorageVFS] Migrated ${o} legacy reservations (${r} units) into V2 VFS and removed V1.`);
    }
    return {
      count: o,
      importedAmount: r,
      failed: failed
    };
  },
  getParityReport: function(e, t) {
    const o = getV2Root();
    const cap = typeof t === "number" && t > 0 ? t : 100;
    const roomFilter = e;
    const skipped = { nuker: 0, unsupportedBuilding: 0, malformed: 0, notImported: 0 };
    const counts = { legacyOnly: 0, amountMismatch: 0, v2Only: 0 };
    const legacyByNode = {};
    let legacyTotal = 0;
    const hasLegacy = Object.prototype.hasOwnProperty.call(Memory, "storageReservations");
    if (!hasLegacy) {
      let v2Total = 0;
      let activeLocks = 0;
      for (const lockId in o.locks) {
        const lock = o.locks[lockId];
        if (!lock || !activeLock(lock) || roomFilter && lock.roomName !== roomFilter) continue;
        v2Total += lock.amount || 0;
        activeLocks++;
      }
      counts.v2Only = activeLocks;
      return {
        mode: "v2-only",
        roomName: e || "all",
        v2Total: v2Total,
        legacyTotal: 0,
        isMatch: true,
        totalsMatch: true,
        nodes: { compared: 0, matched: 0, mismatched: 0 },
        mismatches: [],
        truncated: 0,
        counts: counts,
        inventory: { activeLocks: activeLocks },
        skipped: { nuker: 0, unsupportedBuilding: 0, malformed: 0, notImported: 0, legacyRemoved: 1 }
      };
    }
    const legacyRoot = Memory.storageReservations || {};
    for (const roomName in legacyRoot) {
      if (roomFilter && roomName !== roomFilter) continue;
      const room = legacyRoot[roomName];
      if (!room || typeof room !== "object") continue;
      for (const building in room) {
        if (building === "nuker") {
          skipped.nuker++;
          continue;
        }
        if (!WRITABLE_STRUCTURE_TYPES[building]) {
          skipped.unsupportedBuilding++;
          continue;
        }
        const materials = room[building];
        if (!materials || typeof materials !== "object") continue;
        for (const resource in materials) {
          const records = materials[resource];
          if (!Array.isArray(records)) continue;
          const path = roomName + "/" + building + "/" + resource;
          for (let index = 0; index < records.length; index++) {
            const legacy = normalizeLegacyReservation(records[index]);
            if (!legacy || typeof legacy.program !== "string" || !legacy.program || typeof legacy.amount !== "number" || !Number.isFinite(legacy.amount) || legacy.amount <= 0) {
              skipped.malformed++;
              continue;
            }
            if (!legacyByNode[path]) legacyByNode[path] = {};
            legacyByNode[path][legacy.program] = (legacyByNode[path][legacy.program] || 0) + legacy.amount;
            legacyTotal += legacy.amount;
          }
        }
      }
    }
    const v2ByNode = {};
    let v2Total = 0;
    let activeLocks = 0;
    for (const lockId in o.locks) {
      const lock = o.locks[lockId];
      if (!lock || !activeLock(lock)) continue;
      if (roomFilter && lock.roomName !== roomFilter) continue;
      const path = lock.roomName + "/" + lock.structureType + "/" + lock.resourceType;
      const program = lock.program || lock.ownerId || "default";
      if (!v2ByNode[path]) v2ByNode[path] = {};
      v2ByNode[path][program] = (v2ByNode[path][program] || 0) + (lock.amount || 0);
      v2Total += lock.amount || 0;
      activeLocks++;
    }
    const mismatches = [];
    let compared = 0;
    let matched = 0;
    let mismatchCount = 0;
    function note(kind, path, program, legacy, v2) {
      mismatchCount++;
      counts[kind]++;
      if (mismatches.length < cap) mismatches.push({ kind: kind, path: "/rooms/" + path, program: program, legacy: legacy, v2: v2 });
    }
    for (const path in legacyByNode) {
      for (const program in legacyByNode[path]) {
        compared++;
        const legacyAmount = legacyByNode[path][program];
        const v2Amount = v2ByNode[path] ? v2ByNode[path][program] : undefined;
        if (v2Amount === undefined) note("legacyOnly", path, program, legacyAmount, v2Amount);
        else if (v2Amount !== legacyAmount) note("amountMismatch", path, program, legacyAmount, v2Amount);
        else matched++;
      }
    }
    for (const path in v2ByNode) {
      for (const program in v2ByNode[path]) {
        if (legacyByNode[path] && legacyByNode[path][program] !== undefined) continue;
        compared++;
        note("v2Only", path, program, 0, v2ByNode[path][program]);
      }
    }
    if (!o.importedLegacy && legacyTotal > 0) skipped.notImported = 1;
    return {
      mode: "comparison",
      roomName: e || "all",
      v2Total: v2Total,
      legacyTotal: legacyTotal,
      isMatch: mismatchCount === 0,
      totalsMatch: v2Total === legacyTotal,
      nodes: { compared: compared, matched: matched, mismatched: mismatchCount },
      mismatches: mismatches,
      truncated: Math.max(0, mismatchCount - mismatches.length),
      counts: counts,
      inventory: { activeLocks: activeLocks },
      skipped: skipped
    };
  }
};
global.vfsStatus = function() {
  const e = getV2Root();
  console.log(`[StorageVFS] Active Locks: ${Object.keys(e.locks).length}, Capacity Locks: ${Object.keys(e.capacities).length}`);
};
global.vfsLs = function(e) {
  console.log("[StorageVFS] ls(" + (e || "/") + "):", storageVfs.ls(e));
};
global.vfsParityReport = function(e) {
  const t = storageVfs.getParityReport(e);
  if (t.mode === "v2-only") {
    console.log(`[StorageVFS] V1 retired — parity comparison not applicable. Active V2 locks=${t.inventory.activeLocks}, V2=${t.v2Total}.`);
    return t;
  }
  console.log(`[StorageVFS] Parity Report (${t.roomName}): nodes=${t.nodes.matched}/${t.nodes.compared}, V2=${t.v2Total}, Legacy=${t.legacyTotal}, totalsMatch=${t.totalsMatch}, Match=${t.isMatch}`);
  console.log(`[StorageVFS] Mismatch counts: legacyOnly=${t.counts.legacyOnly}, amountMismatch=${t.counts.amountMismatch}, v2Only=${t.counts.v2Only}`);
  for (let o = 0; o < t.mismatches.length; o++) {
    const r = t.mismatches[o];
    console.log("  " + r.kind + ": " + r.path + " [" + r.program + "] legacy=" + r.legacy + " v2=" + r.v2);
  }
  if (t.truncated > 0) console.log("  ... " + t.truncated + " more mismatch(es) not shown");
  return t;
};
global.vfsMigrateLegacy = function(e) {
  return storageVfs.migrateLegacyReservations(e);
};
module.exports = storageVfs;
