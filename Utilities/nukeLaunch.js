// LLM: Read llmcontext.js before reviewing or changing this file.
// nukeLaunch.js
// Console commands:
//   launchNuke('DonorRoom', 'RecipientRoom', 'structure to target')
//   require('nukeLaunch').launchNukeAt('DonorRoom', 'RecipientRoom', x, y)
//   nukeStatus()              Cooldown/energy/ghodium for every owned nuker.
//   nukeStatus('PlayerName')  Same report for another player's rooms. Rooms
//                             come from the scanner room registry (fresh from
//                             monitoring) or a registry sweep if stale. All
//                             rooms are queued on the observer scheduler at
//                             once so they scan in parallel; the report prints
//                             when every room has been read.
//   nukeStatusCancel()        Abort an active player nuker scan.
//
// Behavior:
// 1) Uses an Observer in the donor room to gain vision of the recipient room if needed.
// 2) Once vision is available, finds the target structure type coordinates in the recipient room
//    (launchNuke) or uses the provided coordinates directly (launchNukeAt).
// 3) Fires the donor room's Nuker at that position.
//
// Notes:
// - Observer vision appears next tick after calling observeRoom; this module schedules
//   and completes across ticks via Memory.
// - Target structure type should be a Screeps structure type string
//   (e.g., 'spawn', 'tower', 'storage'; constants like STRUCTURE_SPAWN also equal these strings).
// - launchNukeAt does NOT require vision — nuker.launchNuke() only needs a RoomPosition.
//   However, if you want to verify the target first, pass useObserver=true.
// - Ensure donor room has a ready Nuker (loaded, no cooldown).
// - No optional chaining used, per your environment requirement.

// Memory layout:
//   Memory.nukeOps = { [opId]: { donor, recipient, targetType, targetX, targetY, state, scheduledAt } }
//   Memory.nukeStatusScan = { player, phase: 'discovery'|'scan', rooms: { [roomName]: null|data }, started, scanStarted }

var getRoomState = require('getRoomState');
var scanner = require('scanner');

var OBSERVE_TIMEOUT = 10;
var NUKE_STATUS_SCAN_TIMEOUT = 1500;       // ticks before unseen rooms are reported as timed out
var NUKE_STATUS_DISCOVERY_TIMEOUT = 10000; // ticks before an unfinished registry sweep aborts the scan

function _ensureMemory() {
  if (!Memory.nukeOps) Memory.nukeOps = {};
}

function _myStructures(roomName, type) {
  var rs = getRoomState.get(roomName);
  if (rs && rs.structuresByType && rs.structuresByType[type]) {
    var out = [];
    var arr = rs.structuresByType[type];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].my) out.push(arr[i]);
    }
    return out;
  }
  var room = _getRoom(roomName);
  if (!room) return [];
  return room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === type; }
  });
}

function _allStructures(roomName, type) {
  var rs = getRoomState.get(roomName);
  if (rs && rs.structuresByType && rs.structuresByType[type]) {
    return rs.structuresByType[type];
  }
  var room = _getRoom(roomName);
  if (!room) return [];
  return room.find(FIND_STRUCTURES, {
    filter: function (s) { return s.structureType === type; }
  });
}

function _opId(donor, recipient, targetType) {
  return donor + '->' + recipient + ':' + targetType;
}

function _coordOpId(donor, recipient, x, y) {
  return donor + '->' + recipient + ':(' + x + ',' + y + ')';
}

function _getRoom(roomName) {
  if (Game.rooms && Game.rooms[roomName]) return Game.rooms[roomName];
  return null;
}

function _isTerminalState(state) {
  if (!state) return false;
  if (state === 'done') return true;
  if (state === 'no_target_found') return true;
  if (state === 'no_observer') return true;
  if (state === 'no_nuker') return true;
  if (state === 'invalid_op') return true;
  if (state === 'observe_failed') return true;
  if (state === 'observe_timeout') return true;
  if (state.indexOf('launch_') === 0) return true;
  return false;
}

function _findObserver(roomName) {
  var observers = _myStructures(roomName, STRUCTURE_OBSERVER);
  if (observers && observers.length > 0) return observers[0];
  return null;
}

function _findNuker(roomName) {
  var nukers = _myStructures(roomName, STRUCTURE_NUKER);
  if (nukers && nukers.length > 0) return nukers[0];
  return null;
}

function _normalizeTargetType(targetType) {
  if (typeof targetType !== 'string') return null;
  return targetType.toLowerCase();
}

function _findTargetPosition(recipientRoomName, targetType) {
  var targets = _allStructures(recipientRoomName, targetType);
  if (!targets || targets.length === 0) return null;

  // Selection policy: first found. Adjust if you prefer other criteria.
  var chosen = targets[0];
  return chosen.pos;
}

// ---------------------------------------------------------------------------
// launchNuke — target by structure type (auto-finds coordinates)
// ---------------------------------------------------------------------------
function launchNuke(donorRoomName, recipientRoomName, targetStructureType) {
  _ensureMemory();

  if (typeof donorRoomName !== 'string' || typeof recipientRoomName !== 'string') {
    return 'Invalid room name(s). Usage: launchNuke(\'DonorRoom\', \'RecipientRoom\', \'spawn|tower|storage|...\')';
  }

  var targetType = _normalizeTargetType(targetStructureType);
  if (!targetType) {
    return 'Invalid target structure type. Pass a structure type string like \'spawn\', \'tower\', or the STRUCTURE_* constant.';
  }

  var opId = _opId(donorRoomName, recipientRoomName, targetType);
  var existing = Memory.nukeOps[opId];

  if (existing && existing.state && existing.state !== 'done') {
    return 'Existing nuke op ' + opId + ' is in state: ' + existing.state + '.';
  }

  var recipientRoom = _getRoom(recipientRoomName);
  if (recipientRoom) {
    var pos = _findTargetPosition(recipientRoomName, targetType);
    if (!pos) {
      return 'No structures of type "' + targetType + '" found in ' + recipientRoomName + '.';
    }
    var nuker = _findNuker(donorRoomName);
    if (!nuker) {
      return 'No Nuker found in donor room ' + donorRoomName + '.';
    }

    var code = nuker.launchNuke(pos);
    return 'Immediate launch attempt result: ' + code + ' at (' + pos.x + ',' + pos.y + ',' + pos.roomName + ').';
  }

  var observer = _findObserver(donorRoomName);
  if (!observer) {
    return 'Donor room ' + donorRoomName + ' has no Observer, and recipient room is not visible. Cannot proceed.';
  }

  var obsCode = observer.observeRoom(recipientRoomName);
  Memory.nukeOps[opId] = {
    donor: donorRoomName,
    recipient: recipientRoomName,
    targetType: targetType,
    targetX: null,
    targetY: null,
    state: (obsCode === OK) ? 'observing' : 'observe_failed',
    scheduledAt: Game.time
  };

  if (obsCode === OK) {
    return 'Observation scheduled. Re-run next tick (or let run() process it). Op: ' + opId + '.';
  } else {
    return 'Observer.observeRoom returned ' + obsCode + ' for ' + recipientRoomName + '.';
  }
}

// ---------------------------------------------------------------------------
// launchNukeAt — target by exact coordinates
// ---------------------------------------------------------------------------
// By default this fires immediately without needing vision, since
// nuker.launchNuke() only requires a RoomPosition. Set useObserver=true
// if you want to observe the room first (e.g. to verify the target exists).
function launchNukeAt(donorRoomName, recipientRoomName, x, y, useObserver) {
  _ensureMemory();

  if (typeof donorRoomName !== 'string' || typeof recipientRoomName !== 'string') {
    return 'Invalid room name(s). Usage: launchNukeAt(\'DonorRoom\', \'RecipientRoom\', x, y)';
  }

  x = Number(x);
  y = Number(y);
  if (isNaN(x) || isNaN(y) || x < 0 || x > 49 || y < 0 || y > 49) {
    return 'Invalid coordinates. x and y must be integers between 0 and 49.';
  }
  x = Math.floor(x);
  y = Math.floor(y);

  var nuker = _findNuker(donorRoomName);
  if (!nuker) {
    return 'No Nuker found in donor room ' + donorRoomName + '.';
  }

  // If useObserver is truthy, schedule an observation first so we can verify
  // the target next tick before firing.
  if (useObserver) {
    var opId = _coordOpId(donorRoomName, recipientRoomName, x, y);
    var existing = Memory.nukeOps[opId];

    if (existing && existing.state && existing.state !== 'done') {
      return 'Existing nuke op ' + opId + ' is in state: ' + existing.state + '.';
    }

    var recipientRoom = _getRoom(recipientRoomName);
    if (recipientRoom) {
      // We have vision — fire immediately
      var pos = new RoomPosition(x, y, recipientRoomName);
      var code = nuker.launchNuke(pos);
      return 'Immediate launch attempt result: ' + code + ' at (' + x + ',' + y + ',' + recipientRoomName + ').';
    }

    var observer = _findObserver(donorRoomName);
    if (!observer) {
      return 'Donor room has no Observer and recipient is not visible. Use without useObserver to fire blind.';
    }

    var obsCode = observer.observeRoom(recipientRoomName);
    Memory.nukeOps[opId] = {
      donor: donorRoomName,
      recipient: recipientRoomName,
      targetType: null,
      targetX: x,
      targetY: y,
      state: (obsCode === OK) ? 'observing' : 'observe_failed',
      scheduledAt: Game.time
    };

    if (obsCode === OK) {
      return 'Observation scheduled. run() will fire at (' + x + ',' + y + ') next tick. Op: ' + opId + '.';
    } else {
      return 'Observer.observeRoom returned ' + obsCode + ' for ' + recipientRoomName + '.';
    }
  }

  // Default: fire blind at the given coordinates (no vision needed)
  var pos = new RoomPosition(x, y, recipientRoomName);
  var code = nuker.launchNuke(pos);
  return 'Launch attempt result: ' + code + ' at (' + x + ',' + y + ',' + recipientRoomName + ').';
}

// ---------------------------------------------------------------------------
// run() — process pending nuke operations each tick
// ---------------------------------------------------------------------------
function run() {
  _processNukeStatusScan();

  if (!Memory.nukeOps) return;

  for (var opId in Memory.nukeOps) {
    var op = Memory.nukeOps[opId];
    if (!op) continue;
    if (_isTerminalState(op.state)) continue;

    if (op.state === 'observing' && op.scheduledAt !== undefined && Game.time - op.scheduledAt > OBSERVE_TIMEOUT) {
      op.state = 'observe_timeout';
      continue;
    }

    var room = _getRoom(op.recipient);
    if (!room) {
      var observer = _findObserver(op.donor);
      if (observer) {
        observer.observeRoom(op.recipient);
        op.state = 'observing';
      } else {
        op.state = 'no_observer';
      }
      continue;
    }

    // Determine the target position
    var pos = null;

    if (op.targetX !== null && op.targetX !== undefined &&
        op.targetY !== null && op.targetY !== undefined) {
      // Coordinate-based op
      pos = new RoomPosition(op.targetX, op.targetY, op.recipient);
    } else if (op.targetType) {
      // Structure-type-based op
      pos = _findTargetPosition(op.recipient, op.targetType);
      if (!pos) {
        op.state = 'no_target_found';
        continue;
      }
    } else {
      op.state = 'invalid_op';
      continue;
    }

    var nuker = _findNuker(op.donor);
    if (!nuker) {
      op.state = 'no_nuker';
      continue;
    }

    var code = nuker.launchNuke(pos);
    op.state = 'launch_' + code;
    if (code === OK) {
      op.state = 'done';
    }
  }
}

// ---------------------------------------------------------------------------
// nukeStatus — reports cooldown, energy, and ghodium for every owned nuker.
// With a player name, scans that player's rooms via the scanner observer
// scheduler (all rooms queued at once, so observers work in parallel) and
// prints the same report when every room has been read.
// ---------------------------------------------------------------------------
function _nukerLine(roomName, cooldown, e, eCap, g, gCap) {
  var energyPct  = Math.floor((e / eCap) * 100);
  var ghodiumPct = Math.floor((g / gCap) * 100);
  var readyMsg   = (cooldown === 0 && energyPct === 100 && ghodiumPct === 100) ? ' *** READY ***' : '';
  var coolMsg    = cooldown > 0 ? 'cooldown: ' + cooldown + ' ticks' : 'cooldown: ready';
  var energyMsg  = 'E: ' + e + '/' + eCap + ' (' + energyPct + '%)';
  var ghodiumMsg = 'G: ' + g + '/' + gCap + ' (' + ghodiumPct + '%)';
  return '[' + roomName + '] ' + coolMsg + ' | ' + energyMsg + ' | ' + ghodiumMsg + readyMsg;
}

function nukeStatus(playerName) {
  if (playerName === undefined || playerName === null) return _nukeStatusSelf();
  if (typeof playerName !== 'string') return 'Usage: nukeStatus() or nukeStatus(\'PlayerName\')';
  return _nukeStatusPlayer(playerName);
}

function _nukeStatusSelf() {
  var lines = [];

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var nukers = _myStructures(roomName, STRUCTURE_NUKER);

    if (!nukers || nukers.length === 0) continue;

    for (var i = 0; i < nukers.length; i++) {
      var n = nukers[i];
      lines.push(_nukerLine(roomName, n.cooldown, n.store[RESOURCE_ENERGY], n.store.getCapacity(RESOURCE_ENERGY), n.store[RESOURCE_GHODIUM], n.store.getCapacity(RESOURCE_GHODIUM)));
    }
  }

  if (lines.length === 0) return 'No Nukers found in any owned room.';
  return lines.join('\n');
}

function _nukeStatusPlayer(playerName) {
  var scan = Memory.nukeStatusScan;
  if (scan && scan.player === playerName) {
    if (scan.phase === 'discovery') {
      return '[NukeStatus] Scan for ' + playerName + ' already running: waiting on registry sweep to discover rooms. nukeStatusCancel() to abort.';
    }
    var pending = 0;
    for (var rn in scan.rooms) if (scan.rooms[rn] === null) pending++;
    return '[NukeStatus] Scan for ' + playerName + ' already running: ' + pending + ' room(s) awaiting vision. Report prints on completion. nukeStatusCancel() to abort.';
  }
  if (scan) _nukeStatusClear();

  var rooms = scanner.registry.roomsOf(playerName);
  if (scanner.registry.fresh() && rooms.length > 0) {
    _nukeStatusStartScanPhase(playerName, rooms, Game.time);
    return '[NukeStatus] Scanning ' + rooms.length + ' room(s) owned by ' + playerName + ' (from registry) — report prints when all rooms have been observed.';
  }
  if (scanner.registry.fresh() && rooms.length === 0) {
    return '[NukeStatus] ' + playerName + ' owns no rooms within observer range (registry is fresh).';
  }

  Memory.nukeStatusScan = { player: playerName, phase: 'discovery', rooms: {}, started: Game.time };
  scanner.registry.startSweep();
  return '[NukeStatus] Registry is stale — sweep started to discover ' + playerName + '\'s rooms. Report prints on completion.';
}

function _nukeStatusStartScanPhase(playerName, rooms, started) {
  var scan = { player: playerName, phase: 'scan', rooms: {}, started: started, scanStarted: Game.time };
  for (var i = 0; i < rooms.length; i++) scan.rooms[rooms[i]] = null;
  Memory.nukeStatusScan = scan;
}

function _readNukerData(room) {
  var nukers = room.find(FIND_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_NUKER; }
  });
  if (!nukers.length) return { none: true };
  var n = nukers[0];
  return {
    cooldown: n.cooldown || 0,
    e: n.store[RESOURCE_ENERGY] || 0,
    eCap: n.store.getCapacity(RESOURCE_ENERGY),
    g: n.store[RESOURCE_GHODIUM] || 0,
    gCap: n.store.getCapacity(RESOURCE_GHODIUM)
  };
}

function _nukeStatusReport(scan) {
  var lines = ['[NukeStatus] ' + scan.player + ' — ' + Object.keys(scan.rooms).length + ' room(s), completed in ' + (Game.time - scan.started) + ' tick(s):'];
  var roomNames = Object.keys(scan.rooms).sort();
  for (var i = 0; i < roomNames.length; i++) {
    var rn = roomNames[i];
    var d = scan.rooms[rn];
    if (d.none)             lines.push('[' + rn + '] no nuker');
    else if (d.unreachable) lines.push('[' + rn + '] out of observer range');
    else if (d.unseen)      lines.push('[' + rn + '] scan timed out (no vision)');
    else                    lines.push(_nukerLine(rn, d.cooldown, d.e, d.eCap, d.g, d.gCap));
  }
  console.log(lines.join('\n'));
}

function _nukeStatusClear() {
  var scan = Memory.nukeStatusScan;
  if (scan && scan.rooms) {
    for (var rn in scan.rooms) if (scan.rooms[rn] === null) scanner.observe.cancel(rn);
  }
  delete Memory.nukeStatusScan;
}

function nukeStatusCancel() {
  if (!Memory.nukeStatusScan) return '[NukeStatus] No active scan.';
  var player = Memory.nukeStatusScan.player;
  _nukeStatusClear();
  return '[NukeStatus] Scan for ' + player + ' cancelled.';
}

function _processNukeStatusScan() {
  var scan = Memory.nukeStatusScan;
  if (!scan) return;

  if (scan.phase === 'discovery') {
    if (Game.time - scan.started > NUKE_STATUS_DISCOVERY_TIMEOUT) {
      console.log('[NukeStatus] Discovery failed — registry sweep never completed (no observers?). Cancelling scan for ' + scan.player + '.');
      delete Memory.nukeStatusScan;
      return;
    }
    if (!scanner.registry.fresh()) return;
    var rooms = scanner.registry.roomsOf(scan.player);
    if (!rooms.length) {
      console.log('[NukeStatus] ' + scan.player + ' owns no rooms within observer range.');
      delete Memory.nukeStatusScan;
      return;
    }
    console.log('[NukeStatus] Registry sweep done — scanning ' + rooms.length + ' room(s) owned by ' + scan.player + '.');
    _nukeStatusStartScanPhase(scan.player, rooms, scan.started);
    scan = Memory.nukeStatusScan;
  }

  var allDone = true;
  for (var rn in scan.rooms) {
    if (scan.rooms[rn] !== null) continue;
    var room = _getRoom(rn);
    if (room) {
      scan.rooms[rn] = _readNukerData(room);
    } else if (Game.time - scan.scanStarted > NUKE_STATUS_SCAN_TIMEOUT) {
      scan.rooms[rn] = { unseen: true };
    } else if (!scanner.observe.request(rn, 'nukeStatus', scanner.observe.PRI.ONESHOT)) {
      scan.rooms[rn] = { unreachable: true };
    } else {
      allDone = false;
    }
  }

  if (allDone) {
    _nukeStatusReport(scan);
    delete Memory.nukeStatusScan;
  }
}

// ---------------------------------------------------------------------------
// Utility — clean up completed ops from Memory
// ---------------------------------------------------------------------------
function clearDoneOps() {
  _ensureMemory();
  var count = 0;
  for (var opId in Memory.nukeOps) {
    if (Memory.nukeOps[opId] && Memory.nukeOps[opId].state === 'done') {
      delete Memory.nukeOps[opId];
      count++;
    }
  }
  return 'Cleared ' + count + ' completed nuke op(s).';
}

function clearTerminalOps() {
  _ensureMemory();
  var count = 0;
  for (var opId in Memory.nukeOps) {
    if (Memory.nukeOps[opId] && _isTerminalState(Memory.nukeOps[opId].state)) {
      delete Memory.nukeOps[opId];
      count++;
    }
  }
  return 'Cleared ' + count + ' terminal nuke op(s).';
}

function clearAllOps() {
  Memory.nukeOps = {};
  return 'All nuke ops cleared.';
}

function listOps() {
  _ensureMemory();
  var result = [];
  for (var opId in Memory.nukeOps) {
    var op = Memory.nukeOps[opId];
    if (!op) continue;
    result.push(opId + ' -> ' + op.state + ' (tick ' + op.scheduledAt + ')');
  }
  if (result.length === 0) return 'No pending nuke ops.';
  return result.join('\n');
}

global.launchNuke = launchNuke;
global.nukeStatus = nukeStatus;
global.nukeStatusCancel = nukeStatusCancel;

module.exports = {
  launchNuke:   launchNuke,
  launchNukeAt: launchNukeAt,
  run:          run,
  clearDoneOps: clearDoneOps,
  clearTerminalOps: clearTerminalOps,
  clearAllOps:  clearAllOps,
  listOps:      listOps,
  nukeStatus:   nukeStatus,
  nukeStatusCancel: nukeStatusCancel
};
