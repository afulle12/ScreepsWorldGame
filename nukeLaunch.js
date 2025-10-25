// nukeLaunch.js
// Console command: launchNuke('DonorRoom', 'RecipientRoom', 'structure to target')
// Behavior:
// 1) Uses an Observer in the donor room to gain vision of the recipient room if needed.
// 2) Once vision is available, finds the target structure type coordinates in the recipient room.
// 3) Fires the donor room's Nuker at that position.
// Notes:
// - Observer vision appears next tick after calling observeRoom; this module schedules and completes across ticks via Memory.
// - Target structure type should be a Screeps structure type string (e.g., 'spawn', 'tower', 'storage'; constants like STRUCTURE_SPAWN also equal these strings).
// - Ensure donor room has an Observer and a ready Nuker (loaded, no cooldown).
// - No optional chaining used, per your environment requirement.

// Memory layout: Memory.nukeOps = { [opId]: { donor, recipient, targetType, state, scheduledAt } }

function _ensureMemory() {
  if (!Memory.nukeOps) Memory.nukeOps = {};
}

function _opId(donor, recipient, targetType) {
  return donor + '->' + recipient + ':' + targetType;
}

function _getRoom(roomName) {
  // Returns the Room object if visible; otherwise null
  if (Game.rooms && Game.rooms[roomName]) return Game.rooms[roomName];
  return null;
}

function _findObserver(roomName) {
  var room = _getRoom(roomName);
  if (!room) return null;
  var observers = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_OBSERVER;
    }
  });
  if (observers && observers.length > 0) return observers[0];
  return null;
}

function _findNuker(roomName) {
  var room = _getRoom(roomName);
  if (!room) return null;
  var nukers = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_NUKER;
    }
  });
  if (nukers && nukers.length > 0) return nukers[0];
  return null;
}

function _normalizeTargetType(targetType) {
  // Accept either constants (STRUCTURE_SPAWN) or raw strings ('spawn')
  if (typeof targetType !== 'string') return null;
  // STRUCTURE_* constants are already strings like 'spawn', 'tower', etc.
  // Lowercase for safety, though constants already are lowercase values.
  return targetType.toLowerCase();
}

function _findTargetPosition(recipientRoomName, targetType) {
  var room = _getRoom(recipientRoomName);
  if (!room) return null;

  var targets = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === targetType;
    }
  });

  if (!targets || targets.length === 0) return null;

  // Selection policy: first found. Adjust if you prefer other criteria.
  var chosen = targets[0];
  return chosen.pos; // RoomPosition with x, y, roomName
}

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

  // If we already have an active op, just report its state
  if (existing && existing.state && existing.state !== 'done') {
    return 'Existing nuke op ' + opId + ' is in state: ' + existing.state + '.';
  }

  // If we already have vision of the recipient room, we can proceed immediately.
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
    // Optional readiness checks (uncomment if you want strict pre-checks):
    // if (nuker.cooldown > 0) return 'Nuker is on cooldown (' + nuker.cooldown + ').';
    // if (nuker.energy < nuker.energyCapacity) return 'Nuker lacks energy: ' + nuker.energy + '/' + nuker.energyCapacity + '.';
    // if (nuker.ghodium < nuker.ghodiumCapacity) return 'Nuker lacks ghodium: ' + nuker.ghodium + '/' + nuker.ghodiumCapacity + '.';

    var code = nuker.launchNuke(pos);
    return 'Immediate launch attempt result: ' + code + ' at (' + pos.x + ',' + pos.y + ',' + pos.roomName + ').';
  }

  // Otherwise, schedule an observation and store the op in Memory.
  var observer = _findObserver(donorRoomName);
  if (!observer) {
    return 'Donor room ' + donorRoomName + ' has no Observer, and recipient room is not visible. Cannot proceed.';
  }

  var obsCode = observer.observeRoom(recipientRoomName);
  Memory.nukeOps[opId] = {
    donor: donorRoomName,
    recipient: recipientRoomName,
    targetType: targetType,
    state: (obsCode === OK) ? 'observing' : 'observe_failed',
    scheduledAt: Game.time
  };

  if (obsCode === OK) {
    return 'Observation scheduled. Re-run next tick (or let run() process it). Op: ' + opId + '.';
  } else {
    return 'Observer.observeRoom returned ' + obsCode + ' for ' + recipientRoomName + '.';
  }
}

function run() {
  _ensureMemory();

  // Process all pending nuke operations
  for (var opId in Memory.nukeOps) {
    var op = Memory.nukeOps[opId];
    if (!op) continue;

    if (op.state === 'done') continue;

    // If observing, check if the room is now visible
    var room = _getRoom(op.recipient);
    if (!room) {
      // Try to re-schedule observation each tick to be safe
      var observer = _findObserver(op.donor);
      if (observer) {
        observer.observeRoom(op.recipient);
        op.state = 'observing';
      } else {
        op.state = 'no_observer';
      }
      continue;
    }

    // With vision available, attempt to find target and launch
    var pos = _findTargetPosition(op.recipient, op.targetType);
    if (!pos) {
      op.state = 'no_target_found';
      continue;
    }

    var nuker = _findNuker(op.donor);
    if (!nuker) {
      op.state = 'no_nuker';
      continue;
    }

    // Optional strict readiness checks (commented; enable if desired)
    // if (nuker.cooldown > 0) { op.state = 'cooldown_' + nuker.cooldown; continue; }
    // if (nuker.energy < nuker.energyCapacity) { op.state = 'insufficient_energy'; continue; }
    // if (nuker.ghodium < nuker.ghodiumCapacity) { op.state = 'insufficient_ghodium'; continue; }

    var code = nuker.launchNuke(pos);
    op.state = 'launch_' + code;
    if (code === OK) {
      op.state = 'done';
      // Optional: verify incoming nuke appears via FIND_NUKES in recipient room
      // var incoming = room.find(FIND_NUKES);
      // console.log('Incoming nukes found: ' + incoming.length);
    }
  }
}

module.exports = {
  launchNuke: launchNuke,
  run: run
};
