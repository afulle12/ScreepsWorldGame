// nukeLaunch.js
// Console commands:
//   launchNuke('DonorRoom', 'RecipientRoom', 'structure to target')
//   require('nukeLaunch').launchNukeAt('DonorRoom', 'RecipientRoom', x, y)
//   nukeStatus()
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

var getRoomState = require('getRoomState');

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
  _ensureMemory();

  for (var opId in Memory.nukeOps) {
    var op = Memory.nukeOps[opId];
    if (!op) continue;
    if (op.state === 'done') continue;

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
// nukeStatus — reports cooldown, energy, and ghodium for every owned nuker
// ---------------------------------------------------------------------------
function nukeStatus() {
  var lines = [];

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var nukers = _myStructures(roomName, STRUCTURE_NUKER);

    if (!nukers || nukers.length === 0) continue;

    for (var i = 0; i < nukers.length; i++) {
      var n = nukers[i];
      var energyPct  = Math.floor((n.store[RESOURCE_ENERGY]  / n.store.getCapacity(RESOURCE_ENERGY))  * 100);
      var ghodiumPct = Math.floor((n.store[RESOURCE_GHODIUM] / n.store.getCapacity(RESOURCE_GHODIUM)) * 100);

      var readyMsg   = (n.cooldown === 0 && energyPct === 100 && ghodiumPct === 100) ? ' *** READY ***' : '';
      var coolMsg    = n.cooldown > 0 ? 'cooldown: ' + n.cooldown + ' ticks' : 'cooldown: ready';
      var energyMsg  = 'E: '  + n.store[RESOURCE_ENERGY]  + '/' + n.store.getCapacity(RESOURCE_ENERGY)  + ' (' + energyPct  + '%)';
      var ghodiumMsg = 'G: '  + n.store[RESOURCE_GHODIUM] + '/' + n.store.getCapacity(RESOURCE_GHODIUM) + ' (' + ghodiumPct + '%)';

      lines.push('[' + roomName + '] ' + coolMsg + ' | ' + energyMsg + ' | ' + ghodiumMsg + readyMsg);
    }
  }

  if (lines.length === 0) return 'No Nukers found in any owned room.';
  return lines.join('\n');
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

module.exports = {
  launchNuke:   launchNuke,
  launchNukeAt: launchNukeAt,
  run:          run,
  clearDoneOps: clearDoneOps,
  clearAllOps:  clearAllOps,
  listOps:      listOps,
  nukeStatus:   nukeStatus
};