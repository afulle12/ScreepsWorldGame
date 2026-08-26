// LLM: Read docs/codex.js before reviewing or changing this file.
// nukeLaunch.js
// Console globals: launchNuke, nukeStatus, nukeStatusCancel, nukeWipe, nukeWipeStatus, nukeWipeCancel, nukeInRange, nukeInRangeStatus, nukeInRangeCancel
// Example: launchNuke('E1N1', 'E2N2', 'spawn') - Launch at the first matching structure
// Example: launchNukeAt('E1N1', 'E2N2', 25, 25) - Launch at exact coordinates
// Example: nukeStatus() - Display readiness, cooldown, and energy of all silos
// Example: nukeStatusCancel() - Cancel an active player nuker scan
// Example: nukeWipe('E2N2') - Scan a room's structures and nuke capacity
// Example: nukeWipeStatus() - Display status of an active room wipe scan
// Example: nukeWipeCancel() - Cancel an active room wipe scan
// Example: nukeInRange('E2N2') - Find all silos within striking range of room
// Example: nukeInRangeStatus() - Display status of in-range silo scans
// Example: nukeInRangeCancel() - Cancel active in-range silo scan
//
// Console commands:
//   launchNuke('DonorRoom', 'RecipientRoom', 'structure type')
//   require('nukeLaunch').launchNukeAt('DonorRoom', 'RecipientRoom', x, y)
//   nukeWipe('W1N1')  Check all spawns in one room.
//   nukeWipe('W1N1', ['spawn','terminal','storage'])  Selected structure types.
//   nukeWipe('W1N1', ['spawn'], 2)  Require 2 ready nukes per spawn.
//   nukeWipe('PlayerName', ['spawn','link','factory','lab'], 2)  Every
//     in-range registry room for a player.
//   nukeWipeStatus() / nukeWipeCancel()  Progress / abort active wipe scan.
//   nukeStatus() / nukeStatus('PlayerName')  Cooldown/energy/ghodium for
//     every owned nuker, or another player's rooms from the scanner registry.
//   nukeStatusCancel()  Abort an active player nuker scan.
//   nukeInRange('W1N1')  Ready nukers that can hit a room, split between
//     your rooms and IFF allies; the report prints after observer scans finish.
//   nukeInRangeStatus() / nukeInRangeCancel()  Progress / abort.
//
// Behavior: 1) uses an available Observer within range for recipient vision if
// needed; 2) finds the target structure type's coordinates in the recipient
// room (launchNuke) or uses given coordinates directly (launchNukeAt);
// 3) fires the first Nuker found in the donor room at that position.
//
// Notes:
// - Observer vision appears the tick after observeRoom; this module schedules
//   and completes across ticks via Memory.
// - launchNuke target types include spawn, extension, road, wall, rampart,
//   keeperLair, portal, controller, link, storage, tower, observer,
//   powerBank, powerSpawn, extractor, lab, terminal, container, nuker,
//   factory, invaderCore -- STRUCTURE_* constants equal these strings.
// - launchNukeAt does not require vision (nuker.launchNuke() only needs a
//   RoomPosition); pass useObserver=true to wait for vision first. The
//   coordinate path itself never verifies what occupies that position.
// - Donor room needs a ready Nuker (loaded, no cooldown).
// - nukeWipe is a read-only capacity scan: one launch per requested structure
//   (nukesPerTarget launches when arg 3 is e.g. 2), each needing a distinct
//   ready Nuker in range. It does not simulate ramparts or combine targets in
//   one blast. Player scans only cover rooms currently under our Observers.
//   In the report "In range" can overlap between rooms; "Assigned" is the
//   global one-to-one allocation across the whole scan.
// - No optional chaining, per environment requirement.
//
// Memory: nukeOps = {[opId]: {donor, recipient, targetType, targetX,
//   targetY, state, scheduledAt}}; nukeStatusScan / nukeInRangeScan =
//   {player|target, phase:'discovery'|'scan', rooms:{[roomName]: data},
//   started, scanStarted}; nukeWipeScan adds scope, targetTypes,
//   nukesPerTarget. Pending observed launches live in nukeOps across ticks
//   but this module does not request an immediate save for it -- durability
//   follows the normal checkpoint cadence. A launch made while the recipient
//   is already visible fires immediately and is never entered in nukeOps.
var getRoomState = require("getRoomState");
var scanner = require("scanner");
var iff = require("iff");
var OBSERVE_TIMEOUT = 150;
var OBSERVE_HOLD_TICKS = 30;
var NUKE_STATUS_SCAN_TIMEOUT = 1500;
var NUKE_STATUS_DISCOVERY_TIMEOUT = 1e4;
var NUKE_GHODIUM_COST = 5e3;
var NUKE_ENERGY_COST = 3e5;
var NUKE_WIPE_SOURCE = "nukeWipe";
var NUKE_WIPE_SCAN_TIMEOUT = 1500;
function _ensureMemory() {
  if (!Memory.nukeOps) Memory.nukeOps = {};
}

function _myStructures(e, r) {
  var n = getRoomState.get(e);
  if (n && n.structuresByType && n.structuresByType[r]) {
    var t = [];
    var a = n.structuresByType[r];
    for (var o = 0; o < a.length; o++) {
      if (a[o].my) t.push(a[o]);
    }
    return t;
  }
  var s = _getRoom(e);
  if (!s) return [];
  return s.find(FIND_MY_STRUCTURES, {
    filter: function(e) {
      return e.structureType === r;
    }
  });
}

function _allStructures(e, r) {
  var n = getRoomState.get(e);
  if (n && n.structuresByType && n.structuresByType[r]) {
    return n.structuresByType[r];
  }
  var t = _getRoom(e);
  if (!t) return [];
  return t.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === r;
    }
  });
}

function _opId(e, r, n) {
  return e + "->" + r + ":" + n;
}

function _coordOpId(e, r, n, t) {
  return e + "->" + r + ":(" + n + "," + t + ")";
}

function _getRoom(e) {
  if (Game.rooms && Game.rooms[e]) return Game.rooms[e];
  return null;
}

function _isTerminalState(e) {
  if (!e) return false;
  if (e === "done") return true;
  if (e === "no_target_found") return true;
  if (e === "no_observer") return true;
  if (e === "no_nuker") return true;
  if (e === "invalid_op") return true;
  if (e === "observe_failed") return true;
  if (e === "observe_timeout") return true;
  if (e.indexOf("launch_") === 0) return true;
  return false;
}

function _findNuker(e) {
  var r = _myStructures(e, STRUCTURE_NUKER);
  if (r && r.length > 0) return r[0];
  return null;
}

function _observeSource(e) {
  return "nukeLaunch:" + e;
}

function _queueObservation(e, r) {
  var n = r.observeSource || _observeSource(e);
  r.observeSource = n;
  if (!r.observeDeadline) r.observeDeadline = Game.time + OBSERVE_TIMEOUT;
  return scanner.observe.request(r.recipient, n, scanner.observe.PRI.ONESHOT, {
    untilConsumed: true,
    holdTicks: OBSERVE_HOLD_TICKS
  });
}

function _releaseObservation(e, r) {
  if (!r || !r.recipient) return;
  scanner.observe.cancel(r.recipient, r.observeSource || _observeSource(e));
}

function _normalizeTargetType(e) {
  if (typeof e !== "string") return null;
  return e.toLowerCase();
}

function _findTargetPosition(e, r) {
  var n = _allStructures(e, r);
  if (!n || n.length === 0) return null;
  var t = n[0];
  return t.pos;
}

function launchNuke(e, r, n) {
  _ensureMemory();
  if (typeof e !== "string" || typeof r !== "string") {
    return "Invalid room name(s). Usage: launchNuke('DonorRoom', 'RecipientRoom', 'spawn|tower|storage|...')";
  }
  var t = _normalizeTargetType(n);
  if (!t) {
    return "Invalid target structure type. Pass a structure type string like 'spawn', 'tower', or the STRUCTURE_* constant.";
  }
  var a = _opId(e, r, t);
  var o = Memory.nukeOps[a];
  if (o && o.state && o.state !== "done") {
    return "Existing nuke op " + a + " is in state: " + o.state + ".";
  }
  var s = _getRoom(r);
  if (s) {
    var u = _findTargetPosition(r, t);
    if (!u) {
      return 'No structures of type "' + t + '" found in ' + r + ".";
    }
    var i = _findNuker(e);
    if (!i) {
      return "No Nuker found in donor room " + e + ".";
    }
    var l = i.launchNuke(u);
    return "Immediate launch attempt result: " + l + " at (" + u.x + "," + u.y + "," + u.roomName + ").";
  }
  Memory.nukeOps[a] = {
    donor: e,
    recipient: r,
    targetType: t,
    targetX: null,
    targetY: null,
    state: "observing",
    scheduledAt: Game.time,
    observeSource: _observeSource(a),
    observeDeadline: Game.time + OBSERVE_TIMEOUT
  };
  if (!_queueObservation(a, Memory.nukeOps[a])) {
    Memory.nukeOps[a].state = "no_observer";
    return "No observer can reach " + r + ".";
  }
  return "Observation queued. run() will process it when vision is delivered. Op: " + a + ".";
}

function launchNukeAt(e, r, n, t, a) {
  _ensureMemory();
  if (typeof e !== "string" || typeof r !== "string") {
    return "Invalid room name(s). Usage: launchNukeAt('DonorRoom', 'RecipientRoom', x, y)";
  }
  n = Number(n);
  t = Number(t);
  if (isNaN(n) || isNaN(t) || n < 0 || n > 49 || t < 0 || t > 49) {
    return "Invalid coordinates. x and y must be integers between 0 and 49.";
  }
  n = Math.floor(n);
  t = Math.floor(t);
  var o = _findNuker(e);
  if (!o) {
    return "No Nuker found in donor room " + e + ".";
  }
  if (a) {
    var s = _coordOpId(e, r, n, t);
    var u = Memory.nukeOps[s];
    if (u && u.state && u.state !== "done") {
      return "Existing nuke op " + s + " is in state: " + u.state + ".";
    }
    var i = _getRoom(r);
    if (i) {
      var l = new RoomPosition(n, t, r);
      var c = o.launchNuke(l);
      return "Immediate launch attempt result: " + c + " at (" + n + "," + t + "," + r + ").";
    }
    Memory.nukeOps[s] = {
      donor: e,
      recipient: r,
      targetType: null,
      targetX: n,
      targetY: t,
      state: "observing",
      scheduledAt: Game.time,
      observeSource: _observeSource(s),
      observeDeadline: Game.time + OBSERVE_TIMEOUT
    };
    if (!_queueObservation(s, Memory.nukeOps[s])) {
      Memory.nukeOps[s].state = "no_observer";
      return "No observer can reach " + r + ". Use without useObserver to fire blind.";
    }
    return "Observation queued. run() will fire at (" + n + "," + t + ") when vision is delivered. Op: " + s + ".";
  }
  var l = new RoomPosition(n, t, r);
  var c = o.launchNuke(l);
  return "Launch attempt result: " + c + " at (" + n + "," + t + "," + r + ").";
}

function run() {
  _processNukeStatusScan();
  _processNukeInRangeScan();
  _processNukeWipeScan();
  if (!Memory.nukeOps) return;
  for (var e in Memory.nukeOps) {
    var r = Memory.nukeOps[e];
    if (!r) continue;
    if (_isTerminalState(r.state)) {
      _releaseObservation(e, r);
      continue;
    }
    var n = _getRoom(r.recipient);
    if (!n) {
      if (!r.observeDeadline) r.observeDeadline = (r.scheduledAt || Game.time) + OBSERVE_TIMEOUT;
      if (Game.time > r.observeDeadline) {
        _releaseObservation(e, r);
        r.state = "observe_timeout";
      } else if (!_queueObservation(e, r)) {
        _releaseObservation(e, r);
        r.state = "no_observer";
      }
      continue;
    }
    _releaseObservation(e, r);
    r.observedAt = Game.time;
    var t = null;
    if (r.targetX !== null && r.targetX !== undefined && r.targetY !== null && r.targetY !== undefined) {
      t = new RoomPosition(r.targetX, r.targetY, r.recipient);
    } else if (r.targetType) {
      t = _findTargetPosition(r.recipient, r.targetType);
      if (!t) {
        r.state = "no_target_found";
        continue;
      }
      r.targetX = t.x;
      r.targetY = t.y;
    } else {
      r.state = "invalid_op";
      continue;
    }
    var a = _findNuker(r.donor);
    if (!a) {
      r.state = "no_nuker";
      continue;
    }
    var o = a.launchNuke(t);
    r.state = "launch_" + o;
    if (o === OK) {
      r.state = "done";
    }
  }
}

function _nukerLine(e, r, n, t, a, o) {
  var s = Math.floor(n / t * 100);
  var u = Math.floor(a / o * 100);
  var i = r === 0 && s === 100 && u === 100 ? " *** READY ***" : "";
  var l = r > 0 ? "cooldown: " + r + " ticks" : "cooldown: ready";
  var c = "E: " + n + "/" + t + " (" + s + "%)";
  var f = "G: " + a + "/" + o + " (" + u + "%)";
  return "[" + e + "] " + l + " | " + c + " | " + f + i;
}

function nukeStatus(e) {
  if (e === undefined || e === null) return _nukeStatusSelf();
  if (typeof e !== "string") return "Usage: nukeStatus() or nukeStatus('PlayerName')";
  return _nukeStatusPlayer(e);
}

function _nukeStatusSelf() {
  var e = [];
  for (var r in Game.rooms) {
    var n = Game.rooms[r];
    if (!n || !n.controller || !n.controller.my) continue;
    var t = _myStructures(r, STRUCTURE_NUKER);
    if (!t || t.length === 0) continue;
    for (var a = 0; a < t.length; a++) {
      var o = t[a];
      e.push(_nukerLine(r, o.cooldown, o.store[RESOURCE_ENERGY], o.store.getCapacity(RESOURCE_ENERGY), o.store[RESOURCE_GHODIUM], o.store.getCapacity(RESOURCE_GHODIUM)));
    }
  }
  if (e.length === 0) return "No Nukers found in any owned room.";
  return e.join("\n");
}

function _nukeStatusPlayer(e) {
  var r = Memory.nukeStatusScan;
  if (r && r.player === e) {
    if (r.phase === "discovery") {
      return "[NukeStatus] Scan for " + e + " already running: waiting on registry sweep to discover rooms. nukeStatusCancel() to abort.";
    }
    var n = 0;
    for (var t in r.rooms) if (r.rooms[t] === null) n++;
    return "[NukeStatus] Scan for " + e + " already running: " + n + " room(s) awaiting vision. Report prints on completion. nukeStatusCancel() to abort.";
  }
  if (r) _nukeStatusClear();
  var a = scanner.registry.roomsOf(e);
  if (scanner.registry.fresh() && a.length > 0) {
    _nukeStatusStartScanPhase(e, a, Game.time);
    return "[NukeStatus] Scanning " + a.length + " room(s) owned by " + e + " (from registry) — report prints when all rooms have been observed.";
  }
  if (scanner.registry.fresh() && a.length === 0) {
    return "[NukeStatus] " + e + " owns no rooms within observer range (registry is fresh).";
  }
  Memory.nukeStatusScan = {
    player: e,
    phase: "discovery",
    rooms: {},
    started: Game.time
  };
  scanner.registry.startSweep();
  return "[NukeStatus] Registry is stale — sweep started to discover " + e + "'s rooms. Report prints on completion.";
}

function _nukeStatusStartScanPhase(e, r, n) {
  var t = {
    player: e,
    phase: "scan",
    rooms: {},
    started: n,
    scanStarted: Game.time
  };
  for (var a = 0; a < r.length; a++) t.rooms[r[a]] = null;
  Memory.nukeStatusScan = t;
}

function _readNukerData(e) {
  var r = e.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_NUKER;
    }
  });
  if (!r.length) return {
    none: true
  };
  var n = r[0];
  return {
    cooldown: n.cooldown || 0,
    e: n.store[RESOURCE_ENERGY] || 0,
    eCap: n.store.getCapacity(RESOURCE_ENERGY),
    g: n.store[RESOURCE_GHODIUM] || 0,
    gCap: n.store.getCapacity(RESOURCE_GHODIUM)
  };
}

function _nukeStatusReport(e) {
  var r = [ "[NukeStatus] " + e.player + " — " + Object.keys(e.rooms).length + " room(s), completed in " + (Game.time - e.started) + " tick(s):" ];
  var n = Object.keys(e.rooms).sort();
  for (var t = 0; t < n.length; t++) {
    var a = n[t];
    var o = e.rooms[a];
    if (o.none) r.push("[" + a + "] no nuker"); else if (o.unreachable) r.push("[" + a + "] out of observer range"); else if (o.unseen) r.push("[" + a + "] scan timed out (no vision)"); else r.push(_nukerLine(a, o.cooldown, o.e, o.eCap, o.g, o.gCap));
  }
  console.log(r.join("\n"));
}

function _nukeStatusClear() {
  var e = Memory.nukeStatusScan;
  if (e && e.rooms) {
    for (var r in e.rooms) if (e.rooms[r] === null) scanner.observe.cancel(r, "nukeStatus");
  }
  delete Memory.nukeStatusScan;
}

function nukeStatusCancel() {
  if (!Memory.nukeStatusScan) return "[NukeStatus] No active scan.";
  var e = Memory.nukeStatusScan.player;
  _nukeStatusClear();
  return "[NukeStatus] Scan for " + e + " cancelled.";
}

function _processNukeStatusScan() {
  var e = Memory.nukeStatusScan;
  if (!e) return;
  if (e.phase === "discovery") {
    if (scanner.registry.fresh()) {
      var r = scanner.registry.roomsOf(e.player);
      if (!r.length) {
        console.log("[NukeStatus] " + e.player + " owns no rooms within observer range.");
        delete Memory.nukeStatusScan;
        return;
      }
      console.log("[NukeStatus] Registry sweep done — scanning " + r.length + " room(s) owned by " + e.player + ".");
      _nukeStatusStartScanPhase(e.player, r, e.started);
      e = Memory.nukeStatusScan;
    } else if (Game.time - e.started > NUKE_STATUS_DISCOVERY_TIMEOUT) {
      console.log("[NukeStatus] Discovery failed — registry sweep never completed (no observers?). Cancelling scan for " + e.player + ".");
      delete Memory.nukeStatusScan;
      return;
    } else {
      return;
    }
  }
  var n = true;
  for (var t in e.rooms) {
    if (e.rooms[t] !== null) continue;
    var a = _getRoom(t);
    if (a) {
      e.rooms[t] = _readNukerData(a);
      scanner.observe.consume(t, "nukeStatus");
    } else if (Game.time - e.scanStarted > NUKE_STATUS_SCAN_TIMEOUT) {
      e.rooms[t] = {
        unseen: true
      };
      scanner.observe.cancel(t, "nukeStatus");
    } else if (!scanner.observe.request(t, "nukeStatus", scanner.observe.PRI.ONESHOT, {
      untilConsumed: true,
      holdTicks: OBSERVE_HOLD_TICKS
    })) {
      e.rooms[t] = {
        unreachable: true
      };
    } else {
      n = false;
    }
  }
  if (n) {
    _nukeStatusReport(e);
    _nukeStatusClear();
  }
}

function nukeInRange(e) {
  if (typeof e !== "string" || !scanner.utils.parseRoomCoords(e)) {
    return "Usage: nukeInRange('W1N1')";
  }
  var r = Memory.nukeInRangeScan;
  if (r && r.target === e) return _nukeInRangeProgress(r);
  if (r) _nukeInRangeClear();
  if (scanner.registry.fresh()) {
    var n = _nukeInRangeStartScan(e, Game.time);
    return "[NukeInRange] Scanning " + n + " possible launch room(s) for " + e + ". Report prints when all rooms have been read.";
  }
  Memory.nukeInRangeScan = {
    target: e,
    phase: "discovery",
    rooms: {},
    started: Game.time
  };
  scanner.registry.startSweep();
  return "[NukeInRange] Registry is stale — sweep started to discover IFF rooms near " + e + ". Report prints on completion.";
}

function _nukeInRangeMyPlayer() {
  for (var e in Game.rooms) {
    var r = Game.rooms[e];
    if (r && r.controller && r.controller.my && r.controller.owner) return r.controller.owner.username;
  }
  return "Me";
}

function _nukeInRangeStartScan(e, r) {
  var n = _nukeInRangeMyPlayer();
  var t = {
    target: e,
    phase: "scan",
    rooms: {},
    started: r,
    scanStarted: Game.time,
    myPlayer: n
  };
  function addRoom(r, n, a) {
    if (!scanner.utils.canNuke(r, e)) return;
    var o = t.rooms[r];
    if (o && o.kind === "me") return;
    t.rooms[r] = {
      player: n,
      kind: a,
      status: "pending",
      data: null
    };
  }
  for (var a in Game.rooms) {
    var o = Game.rooms[a];
    if (o && o.controller && o.controller.my) addRoom(a, n, "me");
  }
  var s = iff.IFF_WHITELIST || [];
  for (var u = 0; u < s.length; u++) {
    var i = s[u];
    if (i === n) continue;
    var l = scanner.registry.roomsOf(i);
    for (var c = 0; c < l.length; c++) addRoom(l[c], i, "ally");
  }
  Memory.nukeInRangeScan = t;
  return Object.keys(t.rooms).length;
}

function _readNukeInRangeData(e) {
  var r = e.find(FIND_STRUCTURES, {
    filter: function(e) {
      return e.structureType === STRUCTURE_NUKER;
    }
  });
  var n = {
    nukers: r.length,
    ready: 0,
    cooldown: 0,
    filling: 0,
    empty: 0
  };
  for (var t = 0; t < r.length; t++) {
    var a = r[t];
    var o = a.store[RESOURCE_ENERGY] || 0;
    var s = a.store[RESOURCE_GHODIUM] || 0;
    if (a.cooldown === 0 && o >= NUKE_ENERGY_COST && s >= NUKE_GHODIUM_COST) {
      n.ready++;
    } else if (a.cooldown > 0) {
      n.cooldown++;
    } else if (o > 0 || s > 0) {
      n.filling++;
    } else {
      n.empty++;
    }
  }
  return n;
}

function _nukeInRangePad(e, r, n) {
  var t = String(e);
  while (t.length < r) t = n ? " " + t : t + " ";
  return t;
}

function _nukeInRangeReport(e) {
  var r = {};
  var n = 0;
  var t = 0;
  var a = [];
  var o = 0;
  for (var s in e.rooms) {
    var u = e.rooms[s];
    if (u.status !== "done") {
      a.push(s + " (" + u.status + ")");
      continue;
    }
    o++;
    var i = r[u.player];
    if (!i) {
      i = {
        player: u.player,
        kind: u.kind,
        rooms: 0,
        nukers: 0,
        ready: 0,
        cooldown: 0,
        filling: 0,
        empty: 0
      };
      r[u.player] = i;
    }
    i.rooms++;
    i.nukers += u.data.nukers;
    i.ready += u.data.ready;
    i.cooldown += u.data.cooldown;
    i.filling += u.data.filling;
    i.empty += u.data.empty;
    if (u.kind === "me") n += u.data.ready; else t += u.data.ready;
  }
  var l = [];
  for (var c in r) l.push(r[c]);
  l.sort(function(e, r) {
    if (e.kind !== r.kind) return e.kind === "me" ? -1 : 1;
    return e.player < r.player ? -1 : e.player > r.player ? 1 : 0;
  });
  var f = {
    rooms: 0,
    nukers: 0,
    ready: 0,
    cooldown: 0,
    filling: 0,
    empty: 0
  };
  var p = [];
  p.push("[NukeInRange] Target: " + e.target + " | Launch range: <=10 rooms | Completed in " + (Game.time - e.started) + " tick(s)");
  p.push("  MY READY NUKES:    " + n);
  p.push("  ALLY READY NUKES:  " + t);
  p.push("  TOTAL READY NUKES: " + (n + t));
  p.push("  Scanned rooms: " + o + "/" + Object.keys(e.rooms).length);
  p.push("");
  p.push("  Player                 | Rooms | Nukers | Ready | Cooldown | Filling | Empty");
  p.push("  --------------------------------------------------------------------------");
  for (var m = 0; m < l.length; m++) {
    var i = l[m];
    f.rooms += i.rooms;
    f.nukers += i.nukers;
    f.ready += i.ready;
    f.cooldown += i.cooldown;
    f.filling += i.filling;
    f.empty += i.empty;
    p.push("  " + _nukeInRangePad(i.player, 22, false) + " | " + _nukeInRangePad(i.rooms, 5, true) + " | " + _nukeInRangePad(i.nukers, 6, true) + " | " + _nukeInRangePad(i.ready, 5, true) + " | " + _nukeInRangePad(i.cooldown, 8, true) + " | " + _nukeInRangePad(i.filling, 7, true) + " | " + _nukeInRangePad(i.empty, 5, true));
  }
  p.push("  --------------------------------------------------------------------------");
  p.push("  " + _nukeInRangePad("TOTAL", 22, false) + " | " + _nukeInRangePad(f.rooms, 5, true) + " | " + _nukeInRangePad(f.nukers, 6, true) + " | " + _nukeInRangePad(f.ready, 5, true) + " | " + _nukeInRangePad(f.cooldown, 8, true) + " | " + _nukeInRangePad(f.filling, 7, true) + " | " + _nukeInRangePad(f.empty, 5, true));
  if (a.length) p.push("  Not scanned: " + a.join(", "));
  console.log(p.join("\n"));
}

function _nukeInRangeClear() {
  var e = Memory.nukeInRangeScan;
  if (e && e.phase === "scan") {
    for (var r in e.rooms) {
      if (e.rooms[r].status === "pending") scanner.observe.cancel(r, "nukeInRange");
    }
  }
  delete Memory.nukeInRangeScan;
}

function _nukeInRangeProgress(e) {
  if (e.phase === "discovery") {
    return "[NukeInRange] Scan for " + e.target + " is waiting for the registry sweep to discover IFF rooms. nukeInRangeCancel() to abort.";
  }
  var r = 0;
  for (var n in e.rooms) if (e.rooms[n].status === "pending") r++;
  return "[NukeInRange] Scan for " + e.target + ": " + r + " room(s) awaiting vision. Report prints on completion. nukeInRangeCancel() to abort.";
}

function nukeInRangeStatus() {
  if (!Memory.nukeInRangeScan) return "[NukeInRange] No active scan.";
  return _nukeInRangeProgress(Memory.nukeInRangeScan);
}

function nukeInRangeCancel() {
  if (!Memory.nukeInRangeScan) return "[NukeInRange] No active scan.";
  var e = Memory.nukeInRangeScan.target;
  _nukeInRangeClear();
  return "[NukeInRange] Scan for " + e + " cancelled.";
}

function _processNukeInRangeScan() {
  var e = Memory.nukeInRangeScan;
  if (!e) return;
  if (e.phase === "discovery") {
    if (scanner.registry.fresh()) {
      var r = e.target;
      var n = e.started;
      var t = _nukeInRangeStartScan(r, n);
      console.log("[NukeInRange] Registry sweep done — scanning " + t + " possible launch room(s) for " + r + ".");
      e = Memory.nukeInRangeScan;
    } else if (Game.time - e.started > NUKE_STATUS_DISCOVERY_TIMEOUT) {
      console.log("[NukeInRange] Discovery failed — registry sweep never completed. Cancelling scan for " + e.target + ".");
      delete Memory.nukeInRangeScan;
      return;
    } else {
      return;
    }
  }
  var a = true;
  for (var o in e.rooms) {
    var s = e.rooms[o];
    if (s.status !== "pending") continue;
    var u = _getRoom(o);
    if (u) {
      var i = u.controller && u.controller.owner ? u.controller.owner.username : null;
      if (s.kind === "me" && !(u.controller && u.controller.my) || s.kind === "ally" && i !== s.player) {
        s.status = "ownership_changed";
      } else {
        s.data = _readNukeInRangeData(u);
        s.status = "done";
      }
      scanner.observe.consume(o, "nukeInRange");
    } else if (Game.time - e.scanStarted > NUKE_STATUS_SCAN_TIMEOUT) {
      s.status = "unseen";
      scanner.observe.cancel(o, "nukeInRange");
    } else if (!scanner.observe.request(o, "nukeInRange", scanner.observe.PRI.ONESHOT, {
      untilConsumed: true,
      holdTicks: OBSERVE_HOLD_TICKS
    })) {
      s.status = "unreachable";
    } else {
      a = false;
    }
  }
  if (a) {
    _nukeInRangeReport(e);
    _nukeInRangeClear();
  }
}

var NUKE_WIPE_TARGET_ALIASES = {
  spawn: "spawn",
  spawns: "spawn",
  terminal: "terminal",
  terminals: "terminal",
  storage: "storage",
  storages: "storage",
  link: "link",
  links: "link",
  factory: "factory",
  factories: "factory",
  lab: "lab",
  labs: "lab"
};
function _normalizeNukeWipeTargets(e) {
  if (e === undefined || e === null) e = [ "spawn" ];
  if (!Array.isArray(e)) e = [ e ];
  if (e.length === 0) return {
    error: "At least one target structure type is required."
  };
  var r = {};
  for (var n = 0; n < e.length; n++) {
    if (typeof e[n] !== "string") {
      return {
        error: "Target structure types must be strings."
      };
    }
    var t = e[n].trim().toLowerCase();
    if (t.indexOf("structure_") === 0) t = t.substring(10);
    var a = NUKE_WIPE_TARGET_ALIASES[t];
    if (!a) {
      return {
        error: 'Unsupported wipe target "' + e[n] + '". Use spawn, terminal, storage, link, factory, or lab.'
      };
    }
    r[a] = true;
  }
  var o = [];
  for (var s in r) o.push(s);
  o.sort();
  return {
    types: o
  };
}

function _normalizeNukeWipeCount(e) {
  if (e === undefined || e === null) return 1;
  var r = Number(e);
  if (isNaN(r) || r < 1 || r > 100 || Math.floor(r) !== r) return null;
  return r;
}

function _nukeWipeScope(e) {
  return scanner.utils.parseRoomCoords(e) ? "room" : "player";
}

function _nukeWipeVisiblePlayerRooms(e) {
  var r = [];
  for (var n in Game.rooms) {
    var t = Game.rooms[n];
    var a = t && t.controller && t.controller.owner;
    if (a && a.username === e) r.push(n);
  }
  return r;
}

function _nukeWipeRoomsForPlayer(e) {
  var r = {};
  var n = [];
  var t = _nukeWipeVisiblePlayerRooms(e);
  var a = scanner.registry.roomsOf(e);
  var o = t.concat(a);
  for (var s = 0; s < o.length; s++) {
    if (r[o[s]]) continue;
    if (!scanner.observe.inRange(o[s])) continue;
    r[o[s]] = true;
    n.push(o[s]);
  }
  n.sort();
  return n;
}

function _nukeWipeStartScan(e, r, n, t, a, o) {
  var s = {
    target: e,
    scope: r,
    targetTypes: n,
    nukesPerTarget: t,
    phase: "scan",
    rooms: {},
    started: o,
    scanStarted: Game.time
  };
  for (var u = 0; u < a.length; u++) {
    s.rooms[a[u]] = {
      status: "pending",
      data: null
    };
  }
  Memory.nukeWipeScan = s;
  return a.length;
}

function _nukeWipeRequestMatches(e, r, n, t, a) {
  return e && e.target === r && e.scope === n && e.nukesPerTarget === a && e.targetTypes.join(",") === t.join(",");
}

function nukeWipe(e, r, n) {
  if (typeof e !== "string" || !e.trim()) {
    return "Usage: nukeWipe('W1N1' [, ['spawn', 'terminal']] [, nukesPerTarget])";
  }
  if (typeof r === "number" && n === undefined) {
    n = r;
    r = undefined;
  }
  var t = _normalizeNukeWipeTargets(r);
  if (t.error) return "[NukeWipe] " + t.error;
  var a = _normalizeNukeWipeCount(n);
  if (a === null) return "[NukeWipe] nukesPerTarget must be an integer from 1 to 100.";
  e = e.trim();
  var o = _nukeWipeScope(e);
  var s = Memory.nukeWipeScan;
  if (_nukeWipeRequestMatches(s, e, o, t.types, a)) {
    return _nukeWipeProgress(s);
  }
  if (s) _nukeWipeClear();
  if (o === "room") {
    if (!scanner.observe.inRange(e)) {
      return "[NukeWipe] Room " + e + " is outside observer range.";
    }
    _nukeWipeStartScan(e, o, t.types, a, [ e ], Game.time);
    return "[NukeWipe] Scanning room " + e + ". Report prints when complete.";
  }
  if (scanner.registry.fresh()) {
    var u = _nukeWipeRoomsForPlayer(e);
    if (!u.length) return "[NukeWipe] No rooms owned by " + e + " within observer range.";
    var i = _nukeWipeStartScan(e, o, t.types, a, u, Game.time);
    return "[NukeWipe] Scanning " + i + " room(s) owned by " + e + ". Report prints when complete.";
  }
  Memory.nukeWipeScan = {
    target: e,
    scope: o,
    targetTypes: t.types,
    nukesPerTarget: a,
    phase: "discovery",
    rooms: {},
    started: Game.time
  };
  var l = scanner.registry.startSweep();
  var c = scanner.utils.getObserverMap();
  if (!l && Object.keys(c).length === 0) {
    delete Memory.nukeWipeScan;
    return "[NukeWipe] Cannot discover rooms for " + e + ": no observer is available.";
  }
  return "[NukeWipe] Registry is stale — sweeping for rooms owned by " + e + ". Report prints when discovery and scanning complete.";
}

function _readNukeWipeRoomData(e, r) {
  var n = {};
  for (var t = 0; t < r.length; t++) n[r[t]] = 0;
  var a = e.find(FIND_STRUCTURES);
  for (var o = 0; o < a.length; o++) {
    if (n[a[o].structureType] !== undefined) {
      n[a[o].structureType]++;
    }
  }
  var s = 0;
  for (var u in n) s += n[u];
  var i = e.controller && e.controller.owner ? e.controller.owner.username : null;
  return {
    owner: i,
    counts: n,
    total: s
  };
}

function _nukeWipeReadyNukers() {
  var e = [];
  for (var r in Game.rooms) {
    var n = Game.rooms[r];
    if (!n || !n.controller || !n.controller.my) continue;
    var t = n.find(FIND_MY_STRUCTURES, {
      filter: function(e) {
        return e.structureType === STRUCTURE_NUKER;
      }
    });
    for (var a = 0; a < t.length; a++) {
      var o = t[a];
      var s = o.store[RESOURCE_ENERGY] || 0;
      var u = o.store[RESOURCE_GHODIUM] || 0;
      if (o.cooldown === 0 && s >= NUKE_ENERGY_COST && u >= NUKE_GHODIUM_COST) {
        e.push({
          id: o.id,
          room: r
        });
      }
    }
  }
  return e;
}

function _nukeWipeEvaluate(e) {
  var r = _nukeWipeReadyNukers();
  var n = [];
  var t = {};
  var a = [];
  var o = 0;
  for (var s in e.rooms) {
    var u = e.rooms[s];
    if (u.status !== "done") {
      a.push(s + " (" + u.status + ")");
      continue;
    }
    var i = u.data;
    var l = {
      owner: i.owner || "Unowned",
      counts: i.counts,
      required: i.total * e.nukesPerTarget,
      reachable: 0,
      allocated: 0
    };
    t[s] = l;
    o += l.required;
    for (var c = 0; c < e.targetTypes.length; c++) {
      var f = e.targetTypes[c];
      for (var p = 0; p < i.counts[f]; p++) {
        for (var m = 0; m < e.nukesPerTarget; m++) {
          n.push({
            room: s,
            type: f,
            candidates: []
          });
        }
      }
    }
  }
  var g = {};
  for (var v = 0; v < n.length; v++) {
    var k = n[v];
    for (var d = 0; d < r.length; d++) {
      if (scanner.utils.canNuke(r[d].room, k.room)) {
        k.candidates.push(d);
        g[d] = true;
      }
    }
  }
  for (var y in t) {
    for (var S = 0; S < r.length; S++) {
      if (scanner.utils.canNuke(r[S].room, y)) t[y].reachable++;
    }
  }
  n.sort(function(e, r) {
    if (e.candidates.length !== r.candidates.length) return e.candidates.length - r.candidates.length;
    if (e.room !== r.room) return e.room < r.room ? -1 : 1;
    return e.type < r.type ? -1 : e.type > r.type ? 1 : 0;
  });
  var _ = [];
  for (var R = 0; R < r.length; R++) _[R] = -1;
  function assign(e, r) {
    var t = n[e].candidates;
    for (var a = 0; a < t.length; a++) {
      var o = t[a];
      if (r[o]) continue;
      r[o] = true;
      var s = _[o];
      if (s === -1 || assign(s, r)) {
        _[o] = e;
        return true;
      }
    }
    return false;
  }
  var h = 0;
  for (var N = 0; N < n.length; N++) {
    if (assign(N, {})) h++;
  }
  for (var E = 0; E < _.length; E++) {
    var T = _[E];
    if (T !== -1) t[n[T].room].allocated++;
  }
  return {
    ready: r.length,
    inRange: Object.keys(g).length,
    required: o,
    matched: h,
    roomStats: t,
    unresolved: a
  };
}

function _nukeWipeTargetSummary(e, r) {
  var n = [];
  for (var t = 0; t < r.length; t++) {
    n.push(r[t] + "=" + e[r[t]]);
  }
  return n.join(", ");
}

function _nukeWipeReport(e) {
  var r = _nukeWipeEvaluate(e);
  var n = [];
  var t = r.unresolved.length ? "INCONCLUSIVE" : r.matched >= r.required ? "SUFFICIENT" : "INSUFFICIENT";
  n.push("[NukeWipe] " + e.target + " | scope: " + e.scope + " | targets: " + e.targetTypes.join(", ") + " | nukes per target: " + e.nukesPerTarget);
  n.push("  RESULT: " + t + " | required launches: " + r.required + " | range-valid assignments: " + r.matched + " | ready nukers: " + r.ready + " (" + r.inRange + " in range)");
  if (r.matched < r.required) {
    n.push("  SHORTFALL: " + (r.required - r.matched) + " launch(es) after sharing ready nukers across target rooms.");
  }
  if (e.scope === "player" && Object.keys(r.roomStats).length > 1) {
    n.push("  NOTE: In range counts are not additive; each ready Nuker can be assigned to only one launch.");
  }
  var a = Object.keys(r.roomStats).sort();
  if (a.length) {
    n.push("  Room        | Targets                         | Required | In range | Assigned");
    n.push("  ------------------------------------------------------------------------------");
    for (var o = 0; o < a.length; o++) {
      var s = a[o];
      var u = r.roomStats[s];
      n.push("  " + s + " | " + _nukeWipePad(_nukeWipeTargetSummary(u.counts, e.targetTypes), 31, false) + " | " + _nukeWipePad(u.required, 8, true) + " | " + _nukeWipePad(u.reachable, 8, true) + " | " + _nukeWipePad(u.allocated, 8, true));
    }
  }
  if (r.unresolved.length) n.push("  Not scanned: " + r.unresolved.join(", "));
  console.log(n.join("\n"));
}

function _nukeWipePad(e, r, n) {
  var t = String(e);
  while (t.length < r) t = n ? " " + t : t + " ";
  return t;
}

function _nukeWipeClear() {
  var e = Memory.nukeWipeScan;
  if (e && e.rooms) {
    for (var r in e.rooms) {
      var n = e.rooms[r];
      if (n && n.status === "pending") scanner.observe.cancel(r, NUKE_WIPE_SOURCE);
    }
  }
  delete Memory.nukeWipeScan;
}

function _nukeWipeProgress(e) {
  if (e.phase === "discovery") {
    return "[NukeWipe] Scan for " + e.target + " is waiting for the registry sweep. nukeWipeCancel() to abort.";
  }
  var r = 0;
  for (var n in e.rooms) if (e.rooms[n].status === "pending") r++;
  return "[NukeWipe] Scan for " + e.target + ": " + r + " room(s) awaiting vision. Report prints on completion. nukeWipeCancel() to abort.";
}

function nukeWipeStatus() {
  if (!Memory.nukeWipeScan) return "[NukeWipe] No active scan.";
  return _nukeWipeProgress(Memory.nukeWipeScan);
}

function nukeWipeCancel() {
  if (!Memory.nukeWipeScan) return "[NukeWipe] No active scan.";
  var e = Memory.nukeWipeScan.target;
  _nukeWipeClear();
  return "[NukeWipe] Scan for " + e + " cancelled.";
}

function _processNukeWipeScan() {
  var e = Memory.nukeWipeScan;
  if (!e) return;
  if (e.phase === "discovery") {
    if (scanner.registry.fresh()) {
      var r = _nukeWipeRoomsForPlayer(e.target);
      if (!r.length) {
        console.log("[NukeWipe] No rooms owned by " + e.target + " within observer range.");
        delete Memory.nukeWipeScan;
        return;
      }
      console.log("[NukeWipe] Registry sweep done — scanning " + r.length + " room(s) owned by " + e.target + ".");
      _nukeWipeStartScan(e.target, e.scope, e.targetTypes, e.nukesPerTarget, r, e.started);
      e = Memory.nukeWipeScan;
    } else if (Game.time - e.started > NUKE_STATUS_DISCOVERY_TIMEOUT) {
      console.log("[NukeWipe] Discovery failed — registry sweep never completed. Cancelling scan for " + e.target + ".");
      delete Memory.nukeWipeScan;
      return;
    } else {
      return;
    }
  }
  var n = true;
  for (var t in e.rooms) {
    var a = e.rooms[t];
    if (a.status !== "pending") continue;
    var o = _getRoom(t);
    if (o) {
      var s = o.controller && o.controller.owner ? o.controller.owner.username : null;
      if (e.scope === "player" && s !== e.target) {
        a.status = "ownership_changed";
        a.data = {
          owner: s,
          counts: {}
        };
      } else {
        a.data = _readNukeWipeRoomData(o, e.targetTypes);
        a.status = "done";
      }
      scanner.observe.consume(t, NUKE_WIPE_SOURCE);
    } else if (Game.time - e.scanStarted > NUKE_WIPE_SCAN_TIMEOUT) {
      a.status = "unseen";
      scanner.observe.cancel(t, NUKE_WIPE_SOURCE);
    } else if (!scanner.observe.request(t, NUKE_WIPE_SOURCE, scanner.observe.PRI.ONESHOT, {
      untilConsumed: true,
      holdTicks: OBSERVE_HOLD_TICKS
    })) {
      a.status = "unreachable";
    } else {
      n = false;
    }
  }
  if (n) {
    _nukeWipeReport(e);
    _nukeWipeClear();
  }
}

function clearDoneOps() {
  _ensureMemory();
  var e = 0;
  for (var r in Memory.nukeOps) {
    if (Memory.nukeOps[r] && Memory.nukeOps[r].state === "done") {
      _releaseObservation(r, Memory.nukeOps[r]);
      delete Memory.nukeOps[r];
      e++;
    }
  }
  return "Cleared " + e + " completed nuke op(s).";
}

function clearTerminalOps() {
  _ensureMemory();
  var e = 0;
  for (var r in Memory.nukeOps) {
    if (Memory.nukeOps[r] && _isTerminalState(Memory.nukeOps[r].state)) {
      _releaseObservation(r, Memory.nukeOps[r]);
      delete Memory.nukeOps[r];
      e++;
    }
  }
  return "Cleared " + e + " terminal nuke op(s).";
}

function clearAllOps() {
  _ensureMemory();
  for (var e in Memory.nukeOps) _releaseObservation(e, Memory.nukeOps[e]);
  Memory.nukeOps = {};
  return "All nuke ops cleared.";
}

function listOps() {
  _ensureMemory();
  var e = [];
  for (var r in Memory.nukeOps) {
    var n = Memory.nukeOps[r];
    if (!n) continue;
    e.push(r + " -> " + n.state + " (tick " + n.scheduledAt + ")");
  }
  if (e.length === 0) return "No pending nuke ops.";
  return e.join("\n");
}

global.launchNuke = launchNuke;
global.nukeWipe = nukeWipe;
global.nukeWipeStatus = nukeWipeStatus;
global.nukeWipeCancel = nukeWipeCancel;
global.nukeStatus = nukeStatus;
global.nukeStatusCancel = nukeStatusCancel;
global.nukeInRange = nukeInRange;
global.nukeInRangeStatus = nukeInRangeStatus;
global.nukeInRangeCancel = nukeInRangeCancel;
module.exports = {
  launchNuke: launchNuke,
  launchNukeAt: launchNukeAt,
  run: run,
  nukeWipe: nukeWipe,
  nukeWipeStatus: nukeWipeStatus,
  nukeWipeCancel: nukeWipeCancel,
  clearDoneOps: clearDoneOps,
  clearTerminalOps: clearTerminalOps,
  clearAllOps: clearAllOps,
  listOps: listOps,
  nukeStatus: nukeStatus,
  nukeStatusCancel: nukeStatusCancel,
  nukeInRange: nukeInRange,
  nukeInRangeStatus: nukeInRangeStatus,
  nukeInRangeCancel: nukeInRangeCancel
};
