// LLM: Read docs/codex.js before reviewing or changing this file.
// compliance.js
// Console globals: compliance
// Example: compliance() - Audit empire-wide room layouts and structure compliance
//   compliance.help()                       Print help with examples.
//   compliance.maxEnergyCreeps()            Living creeps matching their spawn model.
//   compliance.maxEnergyCreeps({all:true})  Also show creeps below their model.
//   compliance.checkMaxEnergyCreeps()       Return the report object without printing.
//   compliance.retireUndersizedHarvesters() Retire one undersized harvester per room.
//   compliance.roomLayout("W1N1")           Print one RCL 8 room layout report.
//   compliance.roomLayout()                 Print reports for all visible owned rooms.
//   compliance.fixRampartCompliance("W1N1") Build missing rampart sites in one room.
//   compliance.fixRampartCompliance()       Build missing rampart sites in all RCL 8 rooms.
"use strict";
const spawnManager = require("spawnManager");
const ROOM_LAYOUT_RCL = 8;
const ROOM_LAYOUT_BUILDINGS = [ {
  type: STRUCTURE_SPAWN,
  label: "spawn",
  count: 3,
  protect: true
}, {
  type: STRUCTURE_LAB,
  label: "lab",
  count: 10,
  protect: true
}, {
  type: STRUCTURE_TOWER,
  label: "tower",
  count: 6,
  protect: true
}, {
  type: STRUCTURE_STORAGE,
  label: "storage",
  count: 1,
  protect: true
}, {
  type: STRUCTURE_TERMINAL,
  label: "terminal",
  count: 1,
  protect: true
}, {
  type: STRUCTURE_NUKER,
  label: "nuker",
  count: 1,
  protect: true
}, {
  type: STRUCTURE_OBSERVER,
  label: "observer",
  count: 1,
  protect: true
}, {
  type: STRUCTURE_POWER_SPAWN,
  label: "power spawn",
  count: 1,
  protect: true
}, {
  type: STRUCTURE_FACTORY,
  label: "factory",
  count: 1,
  protect: true
} ];
function roomLayoutPositionKey(o) {
  return o.x + "," + o.y;
}

function roomLayoutRange(o, e) {
  return Math.max(Math.abs(o.x - e.x), Math.abs(o.y - e.y));
}

function roomLayoutPosition(o) {
  return {
    x: o.x,
    y: o.y
  };
}

function roomLayoutSortByRange(o, e) {
  return o.slice().sort(function(o, r) {
    var t = roomLayoutRange(o.pos, e) - roomLayoutRange(r.pos, e);
    if (t !== 0) return t;
    if (o.pos.y !== r.pos.y) return o.pos.y - r.pos.y;
    return o.pos.x - r.pos.x;
  });
}

function roomLayoutIndexByType(o) {
  var e = {};
  for (var r = 0; r < o.length; r++) {
    var t = o[r];
    if (!e[t.structureType]) e[t.structureType] = [];
    e[t.structureType].push(t);
  }
  return e;
}

function roomLayoutIndexByPosition(o) {
  var e = {};
  for (var r = 0; r < o.length; r++) {
    var t = roomLayoutPositionKey(o[r].pos);
    if (!e[t]) e[t] = [];
    e[t].push(o[r]);
  }
  return e;
}

function roomLayoutAddProblem(o, e, r, t, n) {
  var a = !!(n && n.constructionStarted);
  var i = {
    code: e,
    severity: "error",
    message: a ? "(Construction Started) " + r : r,
    action: t
  };
  if (a) i.constructionStarted = true;
  if (n) {
    for (var s in n) {
      if (n.hasOwnProperty(s)) i[s] = n[s];
    }
  }
  o.problems.push(i);
  if (a) {
    o.pending.push({
      code: "constructionStarted",
      severity: "pending",
      problemCode: e,
      message: r,
      action: t
    });
  }
}

function roomLayoutAddPending(o, e, r, t) {
  var n = {
    code: "constructionPending",
    severity: "pending",
    label: r,
    structureType: e.structureType,
    position: roomLayoutPosition(e.pos),
    message: r + " is under construction at (" + e.pos.x + "," + e.pos.y + ").",
    action: 'Wait for the construction site to finish, then run compliance.roomLayout("' + o.roomName + '").'
  };
  if (t) {
    for (var a in t) {
      if (t.hasOwnProperty(a)) n[a] = t[a];
    }
  }
  o.pending.push(n);
}

function roomLayoutHasRampart(o, e) {
  return !!e[roomLayoutPositionKey(o.pos)];
}

function roomLayoutFinalize(o) {
  var e = 0;
  var r = 0;
  var t = 0;
  for (var n = 0; n < o.problems.length; n++) {
    var a = o.problems[n].code;
    if (a.indexOf("missing") === 0 || a === "rclMismatch" || a === "roomUnavailable") e++;
    if (a.indexOf("unprotected") !== -1) r++;
    if (a.toLowerCase().indexOf("source") !== -1) t++;
  }
  o.summary = {
    problems: o.problems.length,
    pending: o.pending.length,
    missing: e,
    unprotected: r,
    sourceProblems: t
  };
  o.compliant = o.problems.length === 0 && o.pending.length === 0;
  return o;
}

function checkRoomLayoutCounts(o, e, r) {
  for (var t = 0; t < ROOM_LAYOUT_BUILDINGS.length; t++) {
    var n = ROOM_LAYOUT_BUILDINGS[t];
    var a = e[n.type] || [];
    var i = r[n.type] || [];
    var s = a.length + i.length;
    if (s < n.count) {
      roomLayoutAddProblem(o, "missingBuilding", "Missing " + (n.count - s) + " " + n.label + "(s); RCL 8 requires " + n.count + ".", "Build " + (n.count - s) + " " + n.label + "(s) in the RCL 8 layout.", {
        structureType: n.type,
        expected: n.count,
        built: a.length,
        pending: i.length
      });
    }
    for (var l = 0; l < i.length; l++) {
      roomLayoutAddPending(o, i[l], n.label);
    }
  }
}

function checkRoomLayoutProtection(o, e, r, t) {
  for (var n = 0; n < ROOM_LAYOUT_BUILDINGS.length; n++) {
    var a = ROOM_LAYOUT_BUILDINGS[n];
    if (!a.protect) continue;
    var i = e[a.type] || [];
    for (var s = 0; s < i.length; s++) {
      var l = i[s];
      if (roomLayoutHasRampart(l, r)) continue;
      roomLayoutAddProblem(o, "unprotectedBuilding", a.label + " at (" + l.pos.x + "," + l.pos.y + ") has no rampart.", "Build a rampart on the same tile. Rampart hit points are handled separately.", {
        structureType: a.type,
        position: roomLayoutPosition(l.pos),
        structureId: l.id,
        constructionStarted: !!t[roomLayoutPositionKey(l.pos)]
      });
    }
  }
}

function roomLayoutNearby(o, e, r) {
  var t = [];
  for (var n = 0; n < o.length; n++) {
    if (roomLayoutRange(o[n].pos, e) <= r) t.push(o[n]);
  }
  return roomLayoutSortByRange(t, e);
}

function roomLayoutNearbySites(o, e, r) {
  var t = [];
  for (var n = 0; n < o.length; n++) {
    if (roomLayoutRange(o[n].pos, e) <= r) t.push(o[n]);
  }
  return roomLayoutSortByRange(t, e);
}

function checkRoomLayoutSource(o, e, r, t, n, a, i) {
  var s = "Source " + (r + 1) + " at (" + e.pos.x + "," + e.pos.y + ")";
  var l = [ {
    type: STRUCTURE_CONTAINER,
    label: "source container",
    count: 1
  }, {
    type: STRUCTURE_SPAWN,
    label: "source spawn",
    count: 1
  }, {
    type: STRUCTURE_LINK,
    label: "source link",
    count: 2
  } ];
  var u = {};
  for (var c = 0; c < l.length; c++) {
    var m = l[c];
    var p = roomLayoutNearby(t[m.type] || [], e.pos, 2);
    var y = roomLayoutNearbySites(n[m.type] || [], e.pos, 2);
    u[m.type] = p;
    if (p.length + y.length < m.count) {
      roomLayoutAddProblem(o, "missingSourceInfrastructure", s + " is missing " + (m.count - p.length - y.length) + " " + m.label + "(s) within range 2.", "Build the required " + m.label + "(s) within range 2 of the source.", {
        sourceId: e.id,
        sourceIndex: r,
        structureType: m.type,
        required: m.count,
        built: p.length,
        pending: y.length
      });
    }
    for (var d = 0; d < y.length; d++) {
      if (m.type !== STRUCTURE_SPAWN) {
        roomLayoutAddPending(o, y[d], m.label, {
          sourceId: e.id,
          sourceIndex: r
        });
      }
    }
  }
  var g = u[STRUCTURE_CONTAINER] || [];
  if (g.length > 0 && !g.some(function(o) {
    return roomLayoutHasRampart(o, a);
  })) {
    roomLayoutAddProblem(o, "unprotectedSourceContainer", s + " container(s) have no rampart.", "Build a rampart on the source container tile.", {
      sourceId: e.id,
      sourceIndex: r,
      positions: g.map(function(o) {
        return roomLayoutPosition(o.pos);
      }),
      constructionStarted: g.some(function(o) {
        return !!i[roomLayoutPositionKey(o.pos)];
      })
    });
  }
  var R = u[STRUCTURE_LINK] || [];
  if (R.length > 0 && !R.some(function(o) {
    return roomLayoutHasRampart(o, a);
  })) {
    roomLayoutAddProblem(o, "unprotectedSourceLink", s + " has no rampart-covered source link.", "Build a rampart on at least one source link tile.", {
      sourceId: e.id,
      sourceIndex: r,
      positions: R.map(function(o) {
        return roomLayoutPosition(o.pos);
      }),
      constructionStarted: R.some(function(o) {
        return !!i[roomLayoutPositionKey(o.pos)];
      })
    });
  }
}

function checkRoomLayoutStorageLink(o, e, r, t, n) {
  var a = (e[STRUCTURE_STORAGE] || [])[0];
  if (!a) return;
  var i = roomLayoutNearby(e[STRUCTURE_LINK] || [], a.pos, 2);
  var s = roomLayoutNearbySites(r[STRUCTURE_LINK] || [], a.pos, 2);
  if (i.length === 0 && s.length === 0) {
    roomLayoutAddProblem(o, "missingStorageLink", "Storage at (" + a.pos.x + "," + a.pos.y + ") has no link within range 2.", "Build the storage link within range 2 of storage.", {
      structureType: STRUCTURE_LINK,
      storageId: a.id,
      storagePosition: roomLayoutPosition(a.pos)
    });
  }
  for (var l = 0; l < s.length; l++) {
    roomLayoutAddPending(o, s[l], "storage link", {
      storageId: a.id
    });
  }
  if (i.length > 0 && !roomLayoutHasRampart(i[0], t)) {
    roomLayoutAddProblem(o, "unprotectedStorageLink", "Storage link at (" + i[0].pos.x + "," + i[0].pos.y + ") has no rampart.", "Build a rampart on the storage link tile.", {
      structureType: STRUCTURE_LINK,
      structureId: i[0].id,
      position: roomLayoutPosition(i[0].pos),
      storageId: a.id,
      constructionStarted: !!n[roomLayoutPositionKey(i[0].pos)]
    });
  }
}

function checkRoomLayout(o) {
  var e = {
    check: "roomLayout",
    roomName: o,
    tick: Game.time,
    rcl: null,
    expectedRcl: ROOM_LAYOUT_RCL,
    compliant: false,
    problems: [],
    pending: [],
    summary: {
      problems: 0,
      pending: 0,
      missing: 0,
      unprotected: 0,
      sourceProblems: 0
    }
  };
  if (!o || typeof o !== "string" || !Game.rooms[o]) {
    roomLayoutAddProblem(e, "roomUnavailable", "Room is not currently visible.", "Run the command while the room is visible or observe the room first.", {});
    return roomLayoutFinalize(e);
  }
  var r = Game.rooms[o];
  e.rcl = r.controller ? r.controller.level : null;
  if (!r.controller || !r.controller.my) {
    roomLayoutAddProblem(e, "roomNotOwned", "Room is not owned by you.", "Run room layout compliance only for an owned RCL 8 room.", {});
    return roomLayoutFinalize(e);
  }
  if (e.rcl !== ROOM_LAYOUT_RCL) {
    roomLayoutAddProblem(e, "rclMismatch", "Room is RCL " + e.rcl + "; this check only evaluates RCL 8 layouts.", "Run this check after the room reaches RCL 8.", {
      actualRcl: e.rcl,
      expectedRcl: ROOM_LAYOUT_RCL
    });
    return roomLayoutFinalize(e);
  }
  var t = r.find(FIND_MY_STRUCTURES);
  var n = t.slice();
  var a = {};
  for (var i = 0; i < t.length; i++) {
    a[t[i].id] = true;
  }
  var s = r.find(FIND_STRUCTURES);
  for (var l = 0; l < s.length; l++) {
    var u = s[l];
    if (u.structureType !== STRUCTURE_CONTAINER || a[u.id]) continue;
    n.push(u);
  }
  var c = roomLayoutIndexByType(n);
  var m = r.find(FIND_MY_CONSTRUCTION_SITES);
  var p = roomLayoutIndexByType(m);
  var y = roomLayoutIndexByPosition(m);
  var d = {};
  var g = c[STRUCTURE_RAMPART] || [];
  for (var R = 0; R < g.length; R++) {
    d[roomLayoutPositionKey(g[R].pos)] = g[R];
  }
  checkRoomLayoutCounts(e, c, p);
  checkRoomLayoutProtection(e, c, d, y);
  checkRoomLayoutStorageLink(e, c, p, d, y);
  var h = r.find(FIND_SOURCES);
  for (var f = 0; f < h.length; f++) {
    checkRoomLayoutSource(e, h[f], f, c, p, d, y);
  }
  return roomLayoutFinalize(e);
}

function appendRoomLayoutReport(o, e) {
  o.push("=== RCL 8 ROOM LAYOUT COMPLIANCE: " + e.roomName + " ===");
  o.push("Status: " + (e.compliant ? "COMPLIANT" : "NOT COMPLIANT") + " | problems=" + e.summary.problems + " | pending=" + e.summary.pending);
  if (e.problems.length > 0) {
    o.push("PROBLEMS");
    for (var r = 0; r < e.problems.length; r++) {
      var t = e.problems[r];
      var n = "(Construction Started) ";
      var a = t.message;
      if (a.indexOf(n) === 0) {
        var i = a.slice(n.length);
        a = n + i.charAt(0).toUpperCase() + i.slice(1);
      } else {
        a = a.charAt(0).toUpperCase() + a.slice(1);
      }
      o.push(a);
      o.push("    Fix: " + t.action);
    }
  }
  var s = e.pending.filter(function(o) {
    return o.code !== "constructionStarted";
  });
  if (s.length > 0) {
    o.push("PENDING");
    for (var l = 0; l < s.length; l++) {
      o.push("  [" + s[l].label + "] " + s[l].message);
    }
  }
  if (e.problems.length === 0 && e.pending.length === 0) {
    o.push("  RCL 8 building and rampart requirements are satisfied.");
  }
}

function printRoomLayout(o) {
  var e = [];
  if (o) {
    appendRoomLayoutReport(e, checkRoomLayout(o));
    console.log(e.join("\n"));
    return;
  }
  var r = Object.keys(Game.rooms).filter(function(o) {
    var e = Game.rooms[o];
    return e && e.controller && e.controller.my && e.controller.level === ROOM_LAYOUT_RCL;
  }).sort();
  e.push("=== RCL 8 ROOM LAYOUT COMPLIANCE: ALL VISIBLE OWNED RCL 8 ROOMS ===");
  if (r.length === 0) {
    e.push("No visible owned RCL 8 rooms.");
    console.log(e.join("\n"));
    return;
  }
  for (var t = 0; t < r.length; t++) {
    appendRoomLayoutReport(e, checkRoomLayout(r[t]));
  }
  console.log(e.join("\n"));
}

function roomLayoutRampartTargets(o, e) {
  var r = {};
  function addTarget(o, t) {
    if (!o) return;
    var n = roomLayoutPositionKey(o);
    if (e[n]) return;
    if (!r[n]) {
      r[n] = {
        x: o.x,
        y: o.y,
        reason: t
      };
    }
  }
  for (var t = 0; t < o.problems.length; t++) {
    var n = o.problems[t];
    if (n.code === "unprotectedSourceLink") {
      var a = n.positions || [];
      var i = false;
      for (var s = 0; s < a.length; s++) {
        if (e[roomLayoutPositionKey(a[s])]) {
          i = true;
          break;
        }
      }
      if (!i && a.length > 0) addTarget(a[0], n.message);
      continue;
    }
    if (n.code === "unprotectedSourceContainer") {
      var l = n.positions || [];
      for (var u = 0; u < l.length; u++) {
        addTarget(l[u], n.message);
      }
      continue;
    }
    if (n.code === "unprotectedBuilding" || n.code === "unprotectedStorageLink") {
      addTarget(n.position, n.message);
    }
  }
  return r;
}

function fixRoomRampartComplianceForRoom(o) {
  var e = checkRoomLayout(o);
  var r = {
    roomName: o,
    report: e,
    created: [],
    pending: [],
    errors: [],
    skipped: false
  };
  var t = Game.rooms[o];
  if (!t || !t.controller || !t.controller.my || t.controller.level !== ROOM_LAYOUT_RCL) {
    r.skipped = true;
    r.errors.push(e.problems.length > 0 ? e.problems[0].message : "Room is not an owned RCL 8 room.");
    return r;
  }
  var n = t.find(FIND_MY_CONSTRUCTION_SITES);
  var a = roomLayoutIndexByPosition(n);
  var i = roomLayoutRampartTargets(e, a);
  var s = Object.keys(i);
  for (var l = 0; l < s.length; l++) {
    var u = i[s[l]];
    var c = t.createConstructionSite(u.x, u.y, STRUCTURE_RAMPART);
    if (c === OK) {
      r.created.push({
        x: u.x,
        y: u.y,
        reason: u.reason
      });
    } else {
      r.errors.push("Could not build rampart at (" + u.x + "," + u.y + "): " + c + ".");
    }
  }
  var m = e.pending.filter(function(o) {
    return o.code === "constructionStarted";
  });
  for (var p = 0; p < m.length; p++) {
    r.pending.push(m[p].message);
  }
  return r;
}

function printRampartComplianceFix(o) {
  var e;
  if (o) {
    e = [ o ];
  } else {
    e = Object.keys(Game.rooms).filter(function(o) {
      var e = Game.rooms[o];
      return e && e.controller && e.controller.my && e.controller.level === ROOM_LAYOUT_RCL;
    }).sort();
  }
  var r = [ "=== RAMPART COMPLIANCE FIX ===" ];
  if (e.length === 0) {
    r.push("No visible owned RCL 8 rooms.");
    console.log(r.join("\n"));
    return;
  }
  for (var t = 0; t < e.length; t++) {
    var n = fixRoomRampartComplianceForRoom(e[t]);
    if (n.skipped) {
      r.push(n.roomName + ": skipped - " + n.errors[0]);
      continue;
    }
    r.push(n.roomName + ": created=" + n.created.length + " pending=" + n.pending.length + " errors=" + n.errors.length);
    for (var a = 0; a < n.created.length; a++) {
      r.push("  Created rampart site at (" + n.created[a].x + "," + n.created[a].y + ").");
    }
    for (var i = 0; i < n.pending.length; i++) {
      r.push("  Pending: " + n.pending[i] + ".");
    }
    for (var s = 0; s < n.errors.length; s++) {
      r.push("  Error: " + n.errors[s]);
    }
    if (n.created.length === 0 && n.pending.length === 0 && n.errors.length === 0) {
      r.push("  No rampart sites needed.");
    }
  }
  console.log(r.join("\n"));
}

function getRclEnergyCapacity(o) {
  if (!Number.isInteger(o) || o < 1 || o > 8) return null;
  const e = CONTROLLER_STRUCTURES[STRUCTURE_SPAWN];
  const r = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION];
  const t = typeof EXTENSION_ENERGY_CAPACITY === "number" ? EXTENSION_ENERGY_CAPACITY : EXTENSION_ENERGY_CAPACITY[o];
  if (!e || !r || typeof t !== "number") return null;
  return (e[o] || 0) * SPAWN_ENERGY_CAPACITY + (r[o] || 0) * t;
}

function getCreepBodyCost(o) {
  if (!o || !Array.isArray(o.body)) return null;
  let e = 0;
  for (let r = 0; r < o.body.length; r++) {
    const t = o.body[r];
    const n = t && t.type !== undefined ? t.type : t;
    const a = BODYPART_COST[n];
    if (typeof a !== "number") return null;
    e += a;
  }
  return e;
}

function getModelRole(o) {
  if (o.memory && o.memory.role === "attacker" && o.memory.fast) {
    return "fastAttacker";
  }
  return o.memory && o.memory.role;
}

function getExpectedBody(o, e, r, t) {
  if (!r || typeof spawnManager.getComplianceBody !== "function") return null;
  try {
    const n = spawnManager.getComplianceBody(r, t, {
      homeRoom: e,
      sourceId: o.memory && o.memory.sourceId
    });
    return Array.isArray(n) ? n : null;
  } catch (o) {
    return null;
  }
}

function resolveHomeRoom(o) {
  const e = o.memory || {};
  const r = [ [ "memory.homeRoom", e.homeRoom ], [ "memory.spawnRoom", e.spawnRoom ], [ "memory.originRoom", e.originRoom ], [ "memory.assignedRoom", e.assignedRoom ], [ "memory.roomName", e.roomName ], [ "currentRoom", o.room && o.room.name ] ];
  const t = {};
  for (let o = 0; o < r.length; o++) {
    const e = r[o][0];
    const n = r[o][1];
    if (typeof n !== "string" || t[n]) continue;
    t[n] = true;
    const a = Game.rooms[n];
    if (a && a.controller && a.controller.my) {
      return {
        room: a,
        source: e
      };
    }
  }
  return null;
}

function compareEntries(o, e) {
  if (o.homeRoom !== e.homeRoom) return o.homeRoom < e.homeRoom ? -1 : 1;
  if (o.role !== e.role) return o.role < e.role ? -1 : 1;
  return o.name < e.name ? -1 : o.name > e.name ? 1 : 0;
}

function checkMaxEnergyCreeps() {
  const o = {
    check: "maxEnergyCreeps",
    tick: Game.time,
    totalLiving: 0,
    atMax: [],
    belowMax: [],
    aboveMax: [],
    unresolved: []
  };
  const e = Object.keys(Game.creeps).sort();
  o.totalLiving = e.length;
  for (let r = 0; r < e.length; r++) {
    const t = Game.creeps[e[r]];
    const n = t.memory && t.memory.role || "unknown";
    const a = resolveHomeRoom(t);
    const i = getCreepBodyCost(t);
    if (!a) {
      o.unresolved.push({
        name: t.name,
        role: n,
        reason: "owned home room could not be resolved"
      });
      continue;
    }
    const s = a.room.controller.level;
    const l = getRclEnergyCapacity(s);
    const u = getModelRole(t);
    const c = l === null ? null : getExpectedBody(t, a.room.name, u, l);
    const m = c === null ? null : getCreepBodyCost({
      body: c
    });
    if (i === null || l === null || m === null) {
      o.unresolved.push({
        name: t.name,
        role: n,
        homeRoom: a.room.name,
        reason: i === null ? "body cost could not be calculated" : l === null ? "RCL budget could not be calculated" : "spawn model is unavailable for this role"
      });
      continue;
    }
    const p = {
      name: t.name,
      role: n,
      homeRoom: a.room.name,
      homeSource: a.source,
      rcl: s,
      modelRole: u,
      bodyCost: i,
      modelCost: m,
      difference: i - m
    };
    if (i === m) o.atMax.push(p); else if (i < m) o.belowMax.push(p); else o.aboveMax.push(p);
  }
  o.atMax.sort(compareEntries);
  o.belowMax.sort(compareEntries);
  o.aboveMax.sort(compareEntries);
  return o;
}

function retireUndersizedHarvesters() {
  const o = checkMaxEnergyCreeps();
  const e = {};
  for (let r = 0; r < o.belowMax.length; r++) {
    const t = o.belowMax[r];
    if (t.role !== "harvester") continue;
    const n = e[t.homeRoom];
    const a = t.modelCost - t.bodyCost;
    const i = n && n.modelCost - n.bodyCost;
    if (!n || a > i || a === i && t.name < n.name) {
      e[t.homeRoom] = t;
    }
  }
  const r = [];
  const t = Object.keys(e).sort();
  for (let o = 0; o < t.length; o++) {
    const n = e[t[o]];
    const a = Game.rooms[n.homeRoom];
    if (!a || a.energyCapacityAvailable <= 0 || a.energyAvailable < a.energyCapacityAvailable / 2) continue;
    const i = Game.creeps[n.name];
    if (!i || !i.memory || i.memory.role !== "harvester") continue;
    if (i.suicide() !== OK) continue;
    const s = "[Compliance] Retired undersized harvester " + n.name + " in " + n.homeRoom + " (" + n.bodyCost + "/" + n.modelCost + " energy).";
    console.log(s);
    r.push(n);
  }
  return r;
}

function printEntries(o, e) {
  console.log(o + " (" + e.length + ")");
  for (let o = 0; o < e.length; o++) {
    const r = e[o];
    console.log("  " + r.name + " | " + r.role + " | " + r.homeRoom + " RCL" + r.rcl + " | " + r.bodyCost + "/" + r.modelCost);
  }
}

function printMaxEnergyCreeps(o) {
  const e = checkMaxEnergyCreeps();
  const r = !!(o && o.all);
  console.log("=== LIVE CREEP SPAWN-MODEL COMPLIANCE ===");
  console.log("Tick " + e.tick + " | living=" + e.totalLiving + " | atMax=" + e.atMax.length + " | below=" + e.belowMax.length + " | above=" + e.aboveMax.length + " | unresolved=" + e.unresolved.length);
  console.log("Expected cost comes from spawnManager.getComplianceBody(role, home-room RCL budget).");
  printEntries("MATCH SPAWN MODEL", e.atMax);
  if (r) printEntries("BELOW SPAWN MODEL", e.belowMax);
  if (e.aboveMax.length > 0) printEntries("ABOVE SPAWN MODEL", e.aboveMax);
  if (e.unresolved.length > 0) {
    console.log("UNRESOLVED (" + e.unresolved.length + ")");
    for (let o = 0; o < e.unresolved.length; o++) {
      const r = e.unresolved[o];
      console.log("  " + r.name + " | " + r.role + " | " + r.reason);
    }
  }
  return e;
}

function printHelp() {
  console.log([ "Compliance console commands:", "  compliance.maxEnergyCreeps()             Show living creeps matching their spawn model", "  compliance.maxEnergyCreeps({all:true})    Also show creeps below their spawn model", "  compliance.checkMaxEnergyCreeps()         Return the report without printing", "  compliance.retireUndersizedHarvesters()   Retire one undersized harvester per room", '  compliance.roomLayout("W1N1")             Show one RCL 8 layout report', "  compliance.roomLayout()                   Show reports for all visible owned rooms", '  compliance.fixRampartCompliance("W1N1")   Build missing rampart sites in one room', "  compliance.fixRampartCompliance()         Build missing rampart sites in all RCL 8 rooms" ].join("\n"));
  return "See console for compliance usage.";
}

global.compliance = {
  help: printHelp,
  maxEnergyCreeps: printMaxEnergyCreeps,
  checkMaxEnergyCreeps: checkMaxEnergyCreeps,
  retireUndersizedHarvesters: retireUndersizedHarvesters,
  roomLayout: printRoomLayout,
  fixRampartCompliance: printRampartComplianceFix
};
module.exports = {
  getRclEnergyCapacity: getRclEnergyCapacity,
  getCreepBodyCost: getCreepBodyCost,
  getModelRole: getModelRole,
  getExpectedBody: getExpectedBody,
  resolveHomeRoom: resolveHomeRoom,
  checkMaxEnergyCreeps: checkMaxEnergyCreeps,
  retireUndersizedHarvesters: retireUndersizedHarvesters,
  printMaxEnergyCreeps: printMaxEnergyCreeps,
  checkRoomLayout: checkRoomLayout,
  printRoomLayout: printRoomLayout,
  fixRampartCompliance: printRampartComplianceFix
};
