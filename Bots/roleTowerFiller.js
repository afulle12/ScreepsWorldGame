// LLM: Read docs/codex.js before reviewing or changing this file.
// roleTowerFiller.js
// Role dispatch: memory.role === 'towerFiller' -> roleTowerFiller.run(creep).
// Example: require('roleTowerFiller').run(creep);
// Example: require('roleTowerFiller').run(creep);
//   < 100 ticks — fills ALL towers (no ratio gate), lowest energy first
//   <  10 ticks — suicides if carrying nothing
const FILL_TRIGGER_RATIO = .5;
const FILL_TARGET_RATIO = .9;
const SPAWN_TRIGGER_RATIO = .75;
const SUICIDE_GRACE_RATIO = .5;
const MIN_FILL_AMOUNT = 200;
const getRoomState = require("getRoomState");
const _repairMgr = (() => {
  try {
    return require("repairManager");
  } catch (e) {
    return null;
  }
})();
const MAX_HEAL_FILL_TARGET = .95;
module.exports = {
  SPAWN_TRIGGER_RATIO: SPAWN_TRIGGER_RATIO,
  FILL_TRIGGER_RATIO: FILL_TRIGGER_RATIO,
  FILL_TARGET_RATIO: FILL_TARGET_RATIO,
  run(e) {
    if (e.ticksToLive < 10 && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.suicide();
      return;
    }
    const t = _isMaxHealMode(e);
    if (e.memory.maxHeal !== undefined) delete e.memory.maxHeal;
    if (!e.memory.state) {
      e.memory.state = e.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ? "fill" : "collect";
    }
    if (e.memory.state === "fill" && e.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      e.memory.state = "collect";
      delete e.memory.targetId;
    }
    if (e.memory.state === "collect" && e.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      e.memory.state = "fill";
      delete e.memory.targetId;
    }
    if (e.memory.state === "collect") {
      _collect(e, t);
    } else {
      _fill(e, t);
    }
  }
};
function _isMaxHealMode(e) {
  if (!_repairMgr || !_repairMgr.isMaxHeal) return false;
  return _repairMgr.isMaxHeal(e.memory.homeRoom || e.memory.assignedRoom || e.room.name);
}

function _collect(e, t) {
  let r = _resolveTarget(e, _findCollectTarget);
  if (!r) {
    e.say("⚡ wait");
    return;
  }
  const o = e.store.getFreeCapacity(RESOURCE_ENERGY);
  let s;
  if (r instanceof Resource) {
    s = e.pickup(r);
  } else {
    s = e.withdraw(r, RESOURCE_ENERGY, Math.min(o, r.store.getUsedCapacity(RESOURCE_ENERGY)));
  }
  if (s === ERR_NOT_IN_RANGE) {
    e.moveTo(r, {
      reusePath: 4
    });
  } else if (s === ERR_NOT_ENOUGH_RESOURCES || s === ERR_INVALID_ARGS) {
    delete e.memory.targetId;
  } else if (s === OK) {
    e.memory.state = "fill";
    delete e.memory.targetId;
    const r = e.ticksToLive < 100;
    const o = t ? "maxHeal" : r ? "ttl" : "normal";
    _peekNextFillTower(e, o);
  }
}

function _getAvailableEnergy(e, t) {
  const r = e[t];
  if (!r || !r.store) return 0;
  try {
    const r = require("storageVfs");
    const o = r.stat("/rooms/" + e.name + "/" + t + "/energy");
    if (o && o.ok) return o.available;
  } catch (error) {
    if (Game.time % 100 === 0) console.log("[TowerFiller] V2 storage read failed: " + ((error && error.message) || error));
  }
  return r.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
}

function _findCollectTarget(e) {
  const t = e.room;
  const r = getRoomState && typeof getRoomState.get === "function" ? getRoomState.get(t.name) : null;
  const o = _isMaxHealMode(e);
  if (t.storage) {
    const e = o ? t.storage.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : _getAvailableEnergy(t, "storage");
    if (e >= 200) return t.storage;
  }
  if (t.terminal) {
    const e = o ? t.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : _getAvailableEnergy(t, "terminal");
    if (e >= 200) return t.terminal;
  }
  let s = [];
  if (r && r.structuresByType && r.structuresByType[STRUCTURE_CONTAINER]) {
    const e = r.structuresByType[STRUCTURE_CONTAINER];
    for (let t = 0; t < e.length; t++) {
      if (e[t].store.getUsedCapacity(RESOURCE_ENERGY) >= 100) {
        s.push(e[t]);
      }
    }
  } else {
    s = t.find(FIND_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_CONTAINER && e.store.getUsedCapacity(RESOURCE_ENERGY) >= 100
    });
  }
  if (s.length > 0) {
    s.sort((e, t) => t.store.getUsedCapacity(RESOURCE_ENERGY) - e.store.getUsedCapacity(RESOURCE_ENERGY));
    return s[0];
  }
  let n = [];
  if (r && r.dropped) {
    const e = r.dropped;
    for (let t = 0; t < e.length; t++) {
      if (e[t].resourceType === RESOURCE_ENERGY && e[t].amount >= 50) {
        n.push(e[t]);
      }
    }
  } else {
    n = t.find(FIND_DROPPED_RESOURCES, {
      filter: e => e.resourceType === RESOURCE_ENERGY && e.amount >= 50
    });
  }
  if (n.length > 0) {
    n.sort((e, t) => t.amount - e.amount);
    return n[0];
  }
  return null;
}

function _fill(e, t) {
  const r = e.ticksToLive < 100;
  const o = t ? "maxHeal" : r ? "ttl" : "normal";
  const s = _nextFillTower(e, o);
  if (!s) {
    const t = e.room.storage;
    if (t && e.pos.getRangeTo(t) > 3) {
      e.moveTo(t, {
        reusePath: 10
      });
    }
    return;
  }
  const n = Math.min(e.store.getUsedCapacity(RESOURCE_ENERGY), s.store.getFreeCapacity(RESOURCE_ENERGY));
  if (n <= 0) {
    e.memory.state = "collect";
    delete e.memory.targetId;
    return;
  }
  const i = e.transfer(s, RESOURCE_ENERGY, n);
  if (i === ERR_NOT_IN_RANGE) {
    e.moveTo(s, {
      reusePath: 3
    });
  } else if (i === OK) {
    _advanceFillQueue(e.room.name, o);
    e.memory.state = "collect";
    delete e.memory.targetId;
  } else if (i === ERR_FULL) {
    _advanceFillQueue(e.room.name, o);
    const t = _nextFillTower(e, o);
    if (t && e.pos.getRangeTo(t) > 1) {
      e.moveTo(t, {
        reusePath: 3
      });
    }
  }
}

function _resolveTarget(e, t, r) {
  if (e.memory.targetId) {
    const t = Game.getObjectById(e.memory.targetId);
    if (t && (!r || r(t))) return t;
    delete e.memory.targetId;
  }
  const o = t(e);
  if (o) e.memory.targetId = o.id;
  return o;
}

//   global.__towerFillerQueues[roomName][mode] = { ids: [...], cursor: N }
//   mode is 'normal' | 'ttl' | 'maxHeal'.
//   Sorted once when the queue is (re)built, lowest-energy to highest.
//   Not persisted to Memory — we rebuild from current tower energy when the
//   heap is gone. This avoids serialization overhead and prevents stale
//   cached orderings from leaking across resets.
function _getQueues() {
  if (!global.__towerFillerQueues) global.__towerFillerQueues = {};
  return global.__towerFillerQueues;
}

function _roomQueues(e) {
  const t = _getQueues();
  if (!t[e]) t[e] = {};
  return t[e];
}

function _buildFillQueue(e, t) {
  const r = Game.rooms[e];
  if (!r) return null;
  const o = getRoomState.get(e);
  const s = t === "ttl";
  const n = t === "maxHeal";
  const i = n ? MAX_HEAL_FILL_TARGET : FILL_TRIGGER_RATIO;
  let a = [];
  if (o && o.structuresByType && o.structuresByType[STRUCTURE_TOWER]) {
    a = o.structuresByType[STRUCTURE_TOWER].filter(e => e && e.my);
  } else {
    a = r.find(FIND_MY_STRUCTURES, {
      filter: e => e.structureType === STRUCTURE_TOWER
    });
  }
  const R = [];
  for (let e = 0; e < a.length; e++) {
    const t = a[e];
    if (!t) continue;
    const r = t.store.getFreeCapacity(RESOURCE_ENERGY);
    if (r < MIN_FILL_AMOUNT) continue;
    if (!s) {
      const e = t.store.getUsedCapacity(RESOURCE_ENERGY) / t.store.getCapacity(RESOURCE_ENERGY);
      if (e >= i) continue;
    }
    R.push({
      id: t.id,
      used: t.store.getUsedCapacity(RESOURCE_ENERGY)
    });
  }
  R.sort((e, t) => e.used - t.used);
  const l = _roomQueues(e);
  l[t] = {
    ids: R.map(e => e.id),
    cursor: 0
  };
  return l[t];
}

function _peekNextFillTower(e, t) {
  return _nextFillTower(e, t);
}

function _nextFillTower(e, t) {
  const r = _roomQueues(e.room.name);
  let o = r[t];
  if (o) {
    while (o.cursor < o.ids.length) {
      const e = Game.getObjectById(o.ids[o.cursor]);
      if (e && e.my && e.store.getFreeCapacity(RESOURCE_ENERGY) >= MIN_FILL_AMOUNT) {
        return e;
      }
      o.cursor++;
    }
  }
  o = _buildFillQueue(e.room.name, t);
  if (!o) return null;
  while (o.cursor < o.ids.length) {
    const e = Game.getObjectById(o.ids[o.cursor]);
    if (e && e.my && e.store.getFreeCapacity(RESOURCE_ENERGY) >= MIN_FILL_AMOUNT) {
      return e;
    }
    o.cursor++;
  }
  return null;
}

function _advanceFillQueue(e, t) {
  const r = _roomQueues(e);
  const o = r[t];
  if (o && o.cursor < o.ids.length) o.cursor++;
}
