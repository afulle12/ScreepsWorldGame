// LLM: Read docs/codex.js before reviewing or changing this file.
// storageManager.js
// Console globals: storageFind, getUnreserved, reserve, unReserve, transfer, listReservations, validateReservations, sanitizeReservations
// Example: storageFind('all', RESOURCE_ENERGY) - Find rooms with storage containing resource
// Example: getUnreserved('E1N1', RESOURCE_ENERGY) - Check unreserved storage amount
// Example: reserve('E1N1', RESOURCE_ENERGY, 5000, 'task') - Place storage reservation
// Example: unReserve('E1N1', 'reservationId') - Release a storage reservation
// Example: transfer('E1N1', 'fromId', 'toId', RESOURCE_ENERGY, 1000) - Execute storage transfer
// Example: listReservations('E1N1') - List active storage reservations
// Example: validateReservations() - Audit consistency of all storage reservations
// Example: sanitizeReservations() - Purge expired or orphan storage reservations
const MINERAL_TO_BAR = {
  [RESOURCE_HYDROGEN]: RESOURCE_REDUCTANT,
  [RESOURCE_OXYGEN]: RESOURCE_OXIDANT,
  [RESOURCE_UTRIUM]: RESOURCE_UTRIUM_BAR,
  [RESOURCE_LEMERGIUM]: RESOURCE_LEMERGIUM_BAR,
  [RESOURCE_KEANIUM]: RESOURCE_KEANIUM_BAR,
  [RESOURCE_ZYNTHIUM]: RESOURCE_ZYNTHIUM_BAR,
  [RESOURCE_CATALYST]: RESOURCE_PURIFIER
};
const BAR_TO_MINERAL = {};
for (const e in MINERAL_TO_BAR) {
  BAR_TO_MINERAL[MINERAL_TO_BAR[e]] = e;
}
const getRoomState = require("getRoomState");
function getRoomMineral(e) {
  const t = getRoomState.get(e);
  if (!t || !t.minerals || t.minerals.length === 0) return null;
  return t.minerals[0].mineralType;
}

const RESOURCE_NAME_MAP = {
  RESOURCE_HYDROGEN: RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN: RESOURCE_OXYGEN,
  RESOURCE_UTRIUM: RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM: RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM: RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM: RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST: RESOURCE_CATALYST,
  RESOURCE_ENERGY: RESOURCE_ENERGY,
  RESOURCE_POWER: RESOURCE_POWER,
  RESOURCE_OPS: RESOURCE_OPS,
  RESOURCE_GHODIUM: RESOURCE_GHODIUM,
  RESOURCE_REDUCTANT: RESOURCE_REDUCTANT,
  RESOURCE_OXIDANT: RESOURCE_OXIDANT,
  RESOURCE_UTRIUM_BAR: RESOURCE_UTRIUM_BAR,
  RESOURCE_LEMERGIUM_BAR: RESOURCE_LEMERGIUM_BAR,
  RESOURCE_KEANIUM_BAR: RESOURCE_KEANIUM_BAR,
  RESOURCE_ZYNTHIUM_BAR: RESOURCE_ZYNTHIUM_BAR,
  RESOURCE_PURIFIER: RESOURCE_PURIFIER,
  RESOURCE_GHODIUM_MELT: RESOURCE_GHODIUM_MELT,
  RESOURCE_HYDROXIDE: RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE: RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE: RESOURCE_UTRIUM_LEMERGITE,
  RESOURCE_COMPOSITE: RESOURCE_COMPOSITE,
  RESOURCE_CRYSTAL: RESOURCE_CRYSTAL,
  RESOURCE_LIQUID: RESOURCE_LIQUID,
  RESOURCE_WIRE: RESOURCE_WIRE,
  RESOURCE_SWITCH: RESOURCE_SWITCH,
  RESOURCE_TRANSISTOR: RESOURCE_TRANSISTOR,
  RESOURCE_MICROCHIP: RESOURCE_MICROCHIP,
  RESOURCE_CIRCUIT: RESOURCE_CIRCUIT,
  RESOURCE_DEVICE: RESOURCE_DEVICE,
  RESOURCE_CELL: RESOURCE_CELL,
  RESOURCE_PHLEGM: RESOURCE_PHLEGM,
  RESOURCE_TISSUE: RESOURCE_TISSUE,
  RESOURCE_MUSCLE: RESOURCE_MUSCLE,
  RESOURCE_ORGANOID: RESOURCE_ORGANOID,
  RESOURCE_ORGANISM: RESOURCE_ORGANISM,
  RESOURCE_ALLOY: RESOURCE_ALLOY,
  RESOURCE_TUBE: RESOURCE_TUBE,
  RESOURCE_FIXTURES: RESOURCE_FIXTURES,
  RESOURCE_FRAME: RESOURCE_FRAME,
  RESOURCE_HYDRAULICS: RESOURCE_HYDRAULICS,
  RESOURCE_MACHINE: RESOURCE_MACHINE,
  RESOURCE_CONDENSATE: RESOURCE_CONDENSATE,
  RESOURCE_CONCENTRATE: RESOURCE_CONCENTRATE,
  RESOURCE_EXTRACT: RESOURCE_EXTRACT,
  RESOURCE_SPIRIT: RESOURCE_SPIRIT,
  RESOURCE_EMANATION: RESOURCE_EMANATION,
  RESOURCE_ESSENCE: RESOURCE_ESSENCE,
  RESOURCE_MIST: RESOURCE_MIST,
  RESOURCE_BIOMASS: RESOURCE_BIOMASS,
  RESOURCE_METAL: RESOURCE_METAL,
  RESOURCE_SILICON: RESOURCE_SILICON
};
function resolveMaterial(e) {
  if (RESOURCE_NAME_MAP[e]) return RESOURCE_NAME_MAP[e];
  return e;
}

function expandMaterial(e, t) {
  if (e === "NATIVE_RESOURCES") {
    const e = getRoomMineral(t);
    if (!e) return [];
    const r = MINERAL_TO_BAR[e];
    return r ? [ e, r ] : [ e ];
  }
  return [ resolveMaterial(e) ];
}

function getActualAmount(e, t, r) {
  const o = Game.rooms[e];
  if (!o) return 0;
  let n = null;
  if (r === "terminal") {
    n = o.terminal;
  } else if (r === "storage") {
    n = o.storage;
  }
  if (!n) return 0;
  return n.store[t] || 0;
}

function getStorageVfs() {
  return require("storageVfs");
}

function getReservations(e, t, r) {
  return getStorageVfs().getReservationList(e, t, r);
}

function getTotalReserved(e, t, r) {
  return getStorageVfs().getReserved(e, t, r);
}

function sumReservations(e) {
  let total = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i]) total += e[i].amount || 0;
  }
  return total;
}

function getReservationRecords(e, t) {
  const result = [];
  const nodes = getStorageVfs().getReservationNodes(e);
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const reservations = getReservations(node.roomName, node.building, node.resource);
    for (let a = 0; a < reservations.length; a++) {
      const reservation = reservations[a];
      if (!reservation || t && reservation.program !== t) continue;
      result.push({
        roomName: node.roomName,
        building: node.building,
        material: node.resource,
        program: reservation.program,
        amount: reservation.amount,
        time: reservation.time
      });
    }
  }
  return result;
}

const storageManager = {
  reserve: function(e, t, r, o, n) {
    if (!e || !t || !r || !o) {
      return {
        ok: false,
        reason: "Missing required parameter"
      };
    }
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        reason: "Amount must be a positive finite number"
      };
    }
    if (r !== "terminal" && r !== "storage") {
      return {
        ok: false,
        reason: 'Building must be "terminal" or "storage"'
      };
    }
    const vfs = getStorageVfs();
    const result = vfs.lock("/rooms/" + e + "/" + r + "/" + t, {
      program: o,
      ownerId: o,
      amount: n,
      ttl: vfs.TTL_RESERVATION
    });
    if (!result || !result.ok) return result || { ok: false, reason: "VFS lock failed" };
    return {
      ok: true
    };
  },
  transfer: function(e, t, r, o, n, a) {
    if (!e || !t || !r || !o || !n) {
      return {
        ok: false,
        reason: "Missing required parameter"
      };
    }
    if (r !== "terminal" && r !== "storage") {
      return {
        ok: false,
        reason: 'Building must be "terminal" or "storage"'
      };
    }
    if (a !== undefined) {
      if (typeof a !== "number" || !Number.isFinite(a) || a < 0) {
        return {
          ok: false,
          reason: "Amount must be a non-negative finite number"
        };
      }
    }
    if (o === n) {
      return {
        ok: true,
        transferred: 0,
        fromRemaining: 0,
        toTotal: 0
      };
    }
    const vfs = getStorageVfs();
    const path = "/rooms/" + e + "/" + r + "/" + t;
    const stat = vfs.stat(path);
    const locks = stat && stat.ok ? stat.locks || [] : [];
    const source = locks.find(function(e) {
      return e && e.program === o;
    });
    const target = locks.find(function(e) {
      return e && e.program === n;
    });
    if (!source) {
      return {
        ok: false,
        reason: "No source reservation for " + o
      };
    }
    if (a === 0) {
      return {
        ok: true,
        transferred: 0,
        fromRemaining: source.amount || 0,
        toTotal: target ? target.amount || 0 : 0
      };
    }
    const E = typeof a === "number" && a > 0 ? Math.min(a, source.amount) : source.amount;
    if (E <= 0) {
      return {
        ok: true,
        transferred: 0,
        fromRemaining: source.amount || 0,
        toTotal: target ? target.amount || 0 : 0
      };
    }
    const result = vfs.mv(source.lockId, path, {
      toProgram: n,
      toOwnerId: n,
      amount: E,
      ttl: vfs.TTL_RESERVATION
    });
    if (!result || !result.ok) return result || { ok: false, reason: "VFS transfer failed" };
    const updatedReservations = vfs.getReservationList(e, r, t);
    let toTotal = 0;
    for (let i = 0; i < updatedReservations.length; i++) {
      if (updatedReservations[i] && updatedReservations[i].program === n) toTotal += updatedReservations[i].amount || 0;
    }
    return {
      ok: true,
      transferred: E,
      fromRemaining: result.fromRemaining === undefined ? 0 : result.fromRemaining,
      toTotal: toTotal
    };
  },
  unReserve: function(e, t, r, o) {
    const vfs = getStorageVfs();
    const path = "/rooms/" + e + "/" + r + "/" + t;
    const stat = vfs.stat(path);
    const locks = stat && stat.ok ? stat.locks || [] : [];
    let removed = 0;
    let found = false;
    for (let i = 0; i < locks.length; i++) {
      if (!locks[i] || locks[i].program !== o) continue;
      found = true;
      const result = vfs.unlock(locks[i].lockId);
      if (!result || !result.ok) return result || { ok: false, removed: removed };
      removed += result.released || 0;
    }
    return {
      ok: found,
      removed: removed
    };
  },
  consume: function(e, t, r, o, n) {
    if (!e || !t || !r || !o) {
      return {
        ok: false,
        consumed: 0,
        remaining: 0,
        reason: "Missing required parameter"
      };
    }
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        consumed: 0,
        remaining: 0,
        reason: "Amount must be a positive finite number"
      };
    }
    const vfs = getStorageVfs();
    const path = "/rooms/" + e + "/" + r + "/" + t;
    const stat = vfs.stat(path);
    const lock = stat && stat.ok && (stat.locks || []).find(function(e) {
      return e && e.program === o;
    });
    if (!lock) {
      return {
        ok: false,
        consumed: 0,
        remaining: 0,
        reason: "No matching reservation for program"
      };
    }
    const result = vfs.write(path, lock.lockId, n, { ttl: vfs.TTL_RESERVATION });
    if (!result || !result.ok) return result || { ok: false, consumed: 0, remaining: 0, reason: "VFS write failed" };
    return {
      ok: true,
      consumed: result.consumed,
      remaining: result.remaining
    };
  },
  storageFind: function(e, t) {
    if (e === "all") {
      return this._findAll(t);
    }
    return this._findRoom(e, t);
  },
  _findRoom: function(e, t) {
    const r = expandMaterial(t, e);
    if (r.length === 0) {
      return {
        error: "Could not resolve materials for " + e
      };
    }
    if (r.length === 1 && t !== "NATIVE_RESOURCES") {
      return this._buildingBreakdown(e, r[0]);
    }
    const o = {};
    for (let t = 0; t < r.length; t++) {
      o[r[t]] = this._buildingBreakdown(e, r[t]);
    }
    return o;
  },
  _buildingBreakdown: function(e, t) {
    const r = getReservations(e, "terminal", t);
    const o = getReservations(e, "storage", t);
    const n = getActualAmount(e, t, "terminal");
    const a = getActualAmount(e, t, "storage");
    const s = sumReservations(r);
    const i = sumReservations(o);
    return {
      terminal: {
        total: n,
        reserved: s,
        available: n - s,
        reservations: r
      },
      storage: {
        total: a,
        reserved: i,
        available: a - i,
        reservations: o
      },
      combined: {
        total: n + a,
        reserved: s + i,
        available: n - s + (a - i)
      }
    };
  },
  _findAll: function(e) {
    const t = {};
    let r = 0, o = 0;
    for (const n in Game.rooms) {
      const a = Game.rooms[n];
      if (!a.controller || !a.controller.my) continue;
      const s = this._findRoom(n, e);
      t[n] = s;
      if (s.combined) {
        r += s.combined.total;
        o += s.combined.reserved;
      } else {
        for (const e in s) {
          if (s[e].combined) {
            r += s[e].combined.total;
            o += s[e].combined.reserved;
          }
        }
      }
    }
    t.totals = {
      total: r,
      reserved: o,
      available: r - o
    };
    return t;
  },
  getUnreserved: function(e) {
    const t = Game.rooms[e];
    const r = {
      terminal: {},
      storage: {}
    };
    if (!t) return r;
    const scanBuilding = function(t, o) {
      if (!o || !o.store) return;
      for (const n in o.store) {
        const a = o.store[n] || 0;
        if (a <= 0) continue;
        const s = getTotalReserved(e, t, n);
        const i = a - s;
        if (i > 0) {
          r[t][n] = i;
        }
      }
    };
    scanBuilding("terminal", t.terminal);
    scanBuilding("storage", t.storage);
    return r;
  },
  printUnreserved: function(e) {
    const t = this.getUnreserved(e);
    const padRight = function(e, t) {
      e = String(e);
      while (e.length < t) e = e + " ";
      return e;
    };
    const fmt = function(e) {
      return e.toLocaleString ? e.toLocaleString() : String(e);
    };
    const printSection = function(e, t) {
      const r = Object.keys(t).sort();
      console.log(e + ":");
      if (r.length === 0) {
        console.log("  none");
        return;
      }
      for (let e = 0; e < r.length; e++) {
        const o = r[e];
        console.log("  " + padRight(o, 24) + fmt(t[o]));
      }
    };
    console.log("═══ " + e + " Unreserved ═══");
    printSection("terminal", t.terminal);
    printSection("storage", t.storage);
  },
  getReservationRecords: function(e, t) {
    return getReservationRecords(e, t);
  },
  getProgramReserved: function(e, t, r, o) {
    const n = getReservations(e, t, r);
    let total = 0;
    for (let e = 0; e < n.length; e++) {
      if (n[e] && n[e].program === o) total += n[e].amount || 0;
    }
    return total;
  },
  listReservations: function(e, t) {
    const o = getReservationRecords(e, t);
    const a = [];
    const s = e ? e : "*";
    const i = t ? t : "*";
    a.push("[StorageManager] Reservations room=" + s + " program=" + i);
    if (o.length === 0) {
      a.push("  none");
      a.push("Total reservations: 0");
      console.log(a.join("\n"));
      return o;
    }
    o.sort(function(e, t) {
      if (e.roomName !== t.roomName) return e.roomName < t.roomName ? -1 : 1;
      if (e.building !== t.building) return e.building < t.building ? -1 : 1;
      if (e.material !== t.material) return e.material < t.material ? -1 : 1;
      if (e.program !== t.program) return e.program < t.program ? -1 : 1;
      return (e.time || 0) - (t.time || 0);
    });
    function padRight(e, t) {
      e = String(e);
      while (e.length < t) e += " ";
      return e;
    }
    a.push("room        building  material                program       amount   tick       age");
    for (let e = 0; e < o.length; e++) {
      const t = o[e];
      const r = typeof t.time === "number" && typeof Game.time === "number" ? Game.time - t.time : "-";
      a.push(padRight(t.roomName, 11) + " " + padRight(t.building, 9) + " " + padRight(t.material, 23) + " " + padRight(t.program, 12) + " " + padRight(t.amount, 8) + " " + padRight(t.time, 10) + " " + r);
    }
    a.push("Total reservations: " + o.length);
    console.log(a.join("\n"));
    return o;
  },
  validateReservations: function(e) {
    const warnings = [];
    const addWarn = function(message) {
      warnings.push(message);
      console.log("[StorageManager] " + message);
    };
    const nodes = getStorageVfs().getReservationNodes(e);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const reservations = getReservations(node.roomName, node.building, node.resource);
      const seen = {};
      let total = 0;
      for (let r = 0; r < reservations.length; r++) {
        const reservation = reservations[r];
        if (!reservation) continue;
        total += reservation.amount || 0;
        if (seen[reservation.program]) {
          addWarn(node.roomName + " | " + node.building + " | " + node.resource + " has duplicate reservation program " + reservation.program);
        }
        seen[reservation.program] = true;
      }
      const actual = getActualAmount(node.roomName, node.resource, node.building);
      if (total > actual) {
        addWarn(node.roomName + " | " + node.building + " | " + node.resource + " reserved " + total + " > actual " + actual);
      }
    }
    if (warnings.length === 0) {
      console.log("[StorageManager] Reservation validation passed.");
    }
    return warnings;
  },
  sanitizeReservations: function(e) {
    return getStorageVfs().sanitizeReservations(e);
  },
  printFind: function(e, t) {
    var r = resolveMaterial(t);
    var o = this.storageFind(e, t);
    if (o.error) {
      console.log("[StorageManager] " + o.error);
      return;
    }
    var pad = function(e, t) {
      e = String(e);
      while (e.length < t) e = " " + e;
      return e;
    };
    var fmt = function(e) {
      return pad(e.toLocaleString ? e.toLocaleString() : String(e), 9);
    };
    var rpad = function(e, t) {
      e = String(e);
      while (e.length < t) e = e + " ";
      return e;
    };
    var n = {
      reductant: "H_bar",
      oxidant: "O_bar",
      utrium_bar: "U_bar",
      lemergium_bar: "L_bar",
      keanium_bar: "K_bar",
      zynthium_bar: "Z_bar",
      purifier: "X_bar"
    };
    var shortName = function(e) {
      return n[e] || e;
    };
    var printRow = function(e, t) {
      var r = t.combined;
      var o = r.reserved > 0 ? " (rsv:" + r.reserved + ")" : "";
      return rpad(shortName(e) + ":", 8) + fmt(r.available) + o;
    };
    if (o.totals) {
      console.log("═══ Storage Inventory ═══");
      for (var a in o) {
        if (a === "totals") continue;
        var s = o[a];
        var i = [];
        if (s.combined) {
          i.push(printRow(r, s));
        } else {
          for (var R in s) {
            if (s[R].combined) i.push(printRow(R, s[R]));
          }
        }
        if (i.length > 0) {
          var l = false;
          for (var E in s) {
            var m = s[E].combined || s[E];
            if ((m.total || 0) > 0) {
              l = true;
              break;
            }
          }
          if (s.combined && s.combined.total > 0) l = true;
          if (l) {
            console.log(rpad(a, 10) + "  " + i.join("  |  "));
          }
        }
      }
      var g = o.totals;
      var c = g.reserved > 0 ? " (reserved: " + g.reserved + ")" : "";
      console.log("─── Total: " + fmt(g.available).trim() + c + " ───");
    } else if (o.combined) {
      var u = o.combined;
      console.log(e + "  " + r + ":  total=" + u.total + "  reserved=" + u.reserved + "  available=" + u.available);
      if (o.terminal.reservations.length > 0 || o.storage.reservations.length > 0) {
        var f = o.terminal.reservations.concat(o.storage.reservations);
        for (var S = 0; S < f.length; S++) {
          var O = f[S];
          console.log("  └─ " + O.program + ": " + O.amount);
        }
      }
    } else {
      console.log("═══ " + e + " Native Resources ═══");
      for (var v in o) {
        if (o[v].combined) {
          console.log("  " + printRow(v, o[v]));
        }
      }
    }
  },
  MINERAL_TO_BAR: MINERAL_TO_BAR,
  BAR_TO_MINERAL: BAR_TO_MINERAL
};
global.storageFind = function(e, t) {
  storageManager.printFind(e, t);
};
global.getUnreserved = function(e) {
  storageManager.printUnreserved(e);
};
global.reserve = storageManager.reserve.bind(storageManager);
global.unReserve = storageManager.unReserve.bind(storageManager);
global.transfer = storageManager.transfer.bind(storageManager);
global.listReservations = storageManager.listReservations.bind(storageManager);
global.validateReservations = storageManager.validateReservations.bind(storageManager);
global.sanitizeReservations = storageManager.sanitizeReservations.bind(storageManager);
module.exports = storageManager;
