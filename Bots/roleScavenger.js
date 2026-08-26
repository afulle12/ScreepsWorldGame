// LLM: Read docs/codex.js before reviewing or changing this file.
// roleScavenger.js
// Role dispatch: memory.role === 'scavenger' -> roleScavenger.run(creep).
// Example: require('roleScavenger').run(creep);
// Example: require('roleScavenger').run(creep);
const economics = require("economics");
const util = require("util");
const scavengerPolicy = require("scavengerPolicy");
const scavengerLearning = require("scavengerLearning");
const STORAGE_RANGE = 10;
// Retire only when the room is genuinely picked clean; when loot is still on the
// floor the creep waits far longer for the policy to become able to choose again.
const NO_TARGET_RETRY_TICKS = 5;
const LOOT_PRESENT_RETRY_TICKS = 50;
// Ticks to hold a trip open while the policy cannot decide (CPU gate, bad model).
const DECISION_STALL_TICKS = 20;
const RETURN_TRIP_MARGIN = 10;
function cheb(e, r) {
  var o = e.x - r.x;
  var t = e.y - r.y;
  if (o < 0) o = -o;
  if (t < 0) t = -t;
  return o > t ? o : t;
}

function moveTo(e, r) {
  if (!r || !r.pos || r.pos.roomName !== e.room.name) {
    return ERR_INVALID_TARGET;
  }
  if (e.fatigue > 0) return ERR_TIRED;
  if (util.isOnRoomEdge(e.pos) && util.nudgeOffRoomEdge(e)) return OK;
  var o = util.isOnRoomEdge(r.pos);
  var t = cheb(e.pos, r.pos);
  return e.moveTo(r, {
    reusePath: Math.min(10, Math.max(3, t >> 1)),
    maxOps: Math.min(2e3, Math.max(1e3, t * 50)),
    heuristicWeight: 1.2,
    range: 1,
    maxRooms: 1,
    roomCallback: function(r) {
      return r === e.room.name ? undefined : false;
    },
    costCallback: function(r, t) {
      if (r !== e.room.name || o) return;
      var n = t.clone();
      for (var i = 0; i < 50; i++) {
        n.set(i, 0, 255);
        n.set(i, 49, 255);
      }
      for (var a = 0; a < 50; a++) {
        n.set(0, a, 255);
        n.set(49, a, 255);
      }
      return n;
    }
  });
}

function returnHome(e, r) {
  var o = Game.rooms[r];
  var t = o && o.storage;
  if (!t && typeof RoomPosition !== "undefined") {
    t = new RoomPosition(25, 25, r);
  }
  if (t) e.moveTo(t, {
    reusePath: 20,
    maxOps: 1e3,
    maxRooms: 16
  });
}

function selectedTarget(e) {
  if (!e || !e.memory || !e.memory.targetId || typeof Game.getObjectById !== "function") return null;
  var r = Game.getObjectById(e.memory.targetId);
  if (!r || !r.pos || r.pos.roomName !== e.room.name) return null;
  if (cheb(r.pos, e.room.storage.pos) <= STORAGE_RANGE) return null;
  var o = e.memory.targetResource;
  if (!(scavengerPolicy.canonicalPrice(o) > 0)) return null;
  if (r.amount !== undefined) {
    return r.resourceType === o && r.amount > 0 ? r : null;
  }
  return r.store && o && (r.store[o] || 0) > 0 ? r : null;
}

function recordAcceptedDeposit(e, r, o) {
  if (!(o > 0)) return;
  var t = e.memory.scavengerPolicy && e.memory.scavengerPolicy.episodeId;
  if (t) scavengerLearning.recordDeposit(t, r, o);
  economics.record("scavenger", e.room.name, r, {
    out: economics.value(r, o),
    qty: o
  });
}

function reconcilePendingDeposit(e) {
  var r = e && e.memory && e.memory.scavengerPolicy;
  var o = r && r.pendingDeposit;
  if (!o || o.issuedAt >= Game.time) return;
  var t = Number(o.before) || 0;
  var n = Number(e.store[o.resourceType]) || 0;
  var i = Math.max(0, Number(o.requested) || t);
  var a = Math.min(i, Math.max(0, t - n));
  recordAcceptedDeposit(e, o.resourceType, a);
  delete r.pendingDeposit;
}

function freeCapacityFor(e, r) {
  if (!e || !e.store || typeof e.store.getFreeCapacity !== "function") return 0;
  try {
    var o = e.store.getFreeCapacity(r);
    return typeof o === "number" && o > 0 ? o : 0;
  } catch (t) {
    return 0;
  }
}

function depositSink(e, r, o) {
  if (freeCapacityFor(r, o) > 0) return r;
  var t = e.room && e.room.terminal;
  if (t && t.my && freeCapacityFor(t, o) > 0) return t;
  return null;
}

function depositNeural(e, r) {
  if (!e || !r || !e.store) return false;
  reconcilePendingDeposit(e);
  var o = Object.keys(e.store);
  var t = true;
  for (var n = 0; n < o.length; n++) {
    var i = o[n];
    var a = e.store[i] || 0;
    if (!(a > 0)) continue;
    var m = depositSink(e, r, i);
    if (!m) continue;
    t = false;
    if (cheb(e.pos, m.pos) > 1) {
      moveTo(e, m);
      return true;
    }
    var c = e.transfer(m, i, a);
    if (c === OK) {
      e.memory.scavengerPolicy.pendingDeposit = {
        resourceType: i,
        before: a,
        requested: a,
        issuedAt: Game.time
      };
      delete e.memory.depositBlockedSince;
      delete e.memory.blockedTargets;
      delete e.memory.unblockedOnce;
      return true;
    }
    if (c === ERR_NOT_IN_RANGE) moveTo(e, m);
    return true;
  }
  if (t) {
    // Nothing left to bank means the trip is finished; carrying cargo means every
    // sink is full, and dying here would turn banked loot back into a decaying
    // tombstone, so wait next to storage until room frees up instead.
    if (e.store.getUsedCapacity() === 0) {
      delete e.memory.depositBlockedSince;
      e.suicide();
      return true;
    }
    if (!e.memory.depositBlockedSince) e.memory.depositBlockedSince = Game.time;
    if (cheb(e.pos, r.pos) > 1) moveTo(e, r);
    return true;
  }
  return false;
}

function clearTripState(e) {
  delete e.memory.noTargetSince;
  delete e.memory.stallSince;
}

// The policy declines to answer for reasons unrelated to the room being empty:
// the CPU gate closes mid-tick, or the model behind this creep went stale. Those
// must not end a trip that still has capacity left.
function isUndecided(e) {
  return e === "cpu" || e === "cpu-unverifiable" || e === "invalid" || e === "no-model" || e === "stale-model";
}

function roomHasLoot(e) {
  if (typeof scavengerPolicy.roomHasLoot !== "function") return false;
  try {
    return !!scavengerPolicy.roomHasLoot(e);
  } catch (r) {
    return false;
  }
}

function canFinishTrip(e, r) {
  var o = e.ticksToLive;
  if (typeof o !== "number") return true;
  return o > cheb(e.pos, r.pos) + RETURN_TRIP_MARGIN;
}

function blockTarget(e) {
  if (!e.memory.blockedTargets) e.memory.blockedTargets = {};
  if (e.memory.targetId) e.memory.blockedTargets[e.memory.targetId] = true;
  delete e.memory.targetId;
  delete e.memory.targetResource;
  delete e.memory._move;
  scavengerLearning.recordPathFailure(e.room.name);
}

function runNeural(e) {
  reconcilePendingDeposit(e);
  var r = e.room;
  var o = e.memory.homeRoom || e.memory.assignedRoom;
  if (o && r && r.name !== o) {
    returnHome(e, o);
    return;
  }
  var t = r && r.storage;
  if (!t || !r.controller || !r.controller.my || r.controller.level !== 8) {
    if (e.store.getUsedCapacity() === 0) e.suicide(); else returnHome(e, o || r.name);
    return;
  }
  if (e.memory.retire) {
    depositNeural(e, t);
    return;
  }
  if (e.store.getUsedCapacity() > 0 && !canFinishTrip(e, t)) {
    e.memory.retire = true;
    depositNeural(e, t);
    return;
  }
  if (e.store.getFreeCapacity() <= 0) {
    clearTripState(e);
    depositNeural(e, t);
    return;
  }
  var n = selectedTarget(e);
  var d = "ok";
  if (!n) {
    delete e.memory.targetId;
    delete e.memory.targetResource;
    var i = scavengerPolicy.getPickupDecision(e);
    d = i.reason || (i.valid ? "no-loot" : "invalid");
    if (!i.valid) {
      if (!e.memory._invalidPolicyRecorded) {
        scavengerLearning.recordInvalidOutput(e.memory.scavengerPolicy.episodeId);
        e.memory._invalidPolicyRecorded = true;
      }
    } else if (i.candidate) {
      n = i.candidate.object;
      e.memory.targetId = i.candidate.objectId;
      e.memory.targetResource = i.candidate.resourceType;
      d = "ok";
    }
  }
  if (!n) {
    if (isUndecided(d)) {
      if (!e.memory.stallSince) e.memory.stallSince = Game.time;
      if (Game.time - e.memory.stallSince < DECISION_STALL_TICKS) return;
    } else if (d === "all-blocked" && e.memory.blockedTargets && !e.memory.unblockedOnce) {
      // One failed step shelved every pile; give them a single second chance per
      // trip before ending a trip that still has capacity. Retrying without the
      // latch would livelock against a genuinely unreachable pile.
      delete e.memory.blockedTargets;
      delete e.memory.stallSince;
      e.memory.unblockedOnce = true;
      return;
    }
    delete e.memory.stallSince;
    if (e.store.getUsedCapacity() > 0) {
      delete e.memory.noTargetSince;
      depositNeural(e, t);
      return;
    }
    if (!e.memory.noTargetSince) e.memory.noTargetSince = Game.time;
    var s = roomHasLoot(r) ? LOOT_PRESENT_RETRY_TICKS : NO_TARGET_RETRY_TICKS;
    if (Game.time - e.memory.noTargetSince >= s) {
      delete e.memory.noTargetSince;
      e.suicide();
    }
    return;
  }
  clearTripState(e);
  var a = e.memory.targetResource;
  if (cheb(e.pos, n.pos) > 1) {
    if (moveTo(e, n) === ERR_NO_PATH) blockTarget(e);
    return;
  }
  delete e.memory._move;
  var m;
  if (n.amount !== undefined) {
    m = e.pickup(n);
  } else {
    var c = Math.min(e.store.getFreeCapacity(a), n.store[a] || 0);
    m = c > 0 ? e.withdraw(n, a, c) : ERR_NOT_ENOUGH_RESOURCES;
  }
  if (m === OK || m === ERR_FULL) {
    delete e.memory.targetId;
    delete e.memory.targetResource;
    return;
  }
  if (m === ERR_NOT_ENOUGH_RESOURCES || m === ERR_INVALID_TARGET) {
    delete e.memory.targetId;
    delete e.memory.targetResource;
  }
}

function run(e) {
  if (!e || !e.memory) return;
  var r = e.memory.scavengerPolicy;
  if (!r) {
    e.memory.scavengerPolicy = {};
  } else if (r.learningEligible && (r.policyVersion !== scavengerLearning.DATASET_VERSION || r.architectureVersion !== scavengerLearning.ARCHITECTURE_VERSION || r.featureSchemaVersion !== scavengerLearning.FEATURE_SCHEMA_VERSION)) {
    // Schema moved under a live creep: bank what it is carrying, then retire.
    if (!r.retireRecorded) {
      scavengerLearning.recordInvalidOutput(r.episodeId);
      r.retireRecorded = true;
    }
    e.memory.retire = true;
  }
  return runNeural(e);
}

module.exports = {
  run: run,
  runNeural: runNeural
};
