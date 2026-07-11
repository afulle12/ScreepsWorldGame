// LLM: Read llmcontext.js before reviewing or changing this file.
// roleTowerFiller.js
// ============================================================================
// TTL behaviour:
//   < 100 ticks — fills ALL towers (no ratio gate), lowest energy first
//   <  10 ticks — suicides if carrying nothing
// ============================================================================

const FILL_TRIGGER_RATIO  = 0.50;  // Fill towers whose ratio is below this
const FILL_TARGET_RATIO   = 0.90;  // Stop filling a tower once it reaches this
const SPAWN_TRIGGER_RATIO = 0.75;  // Expose to spawnManager for spawn checks
const SUICIDE_GRACE_RATIO = 0.50;  // Suicide threshold: all towers ≥ this AND no hostiles
const MIN_FILL_AMOUNT     = 200;   // Minimum energy to transfer to a tower per trip

const getRoomState = require('getRoomState');
const _repairMgr = (() => { try { return require('repairManager'); } catch (e) { return null; } })();
const MAX_HEAL_FILL_TARGET = 0.95;

module.exports = {

    SPAWN_TRIGGER_RATIO,
    FILL_TRIGGER_RATIO,
    FILL_TARGET_RATIO,

    run(creep) {
        // ── TTL suicide ───────────────────────────────────────────────────────
        if (creep.ticksToLive < 10 &&
            creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.suicide();
            return;
        }

        // ── Max-heal mode uses a higher fill target ──────────────────────────
        const maxHealMode = _isMaxHealMode(creep);
        if (creep.memory.maxHeal !== undefined) delete creep.memory.maxHeal;

        // ── Init state (collect→fill flip is handled inside _collect on success) ──
        if (!creep.memory.state) {
            creep.memory.state = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                ? 'fill'
                : 'collect';
        }

        // Boot-recovery: landed in 'fill' with an empty store.
        if (creep.memory.state === 'fill' && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.state = 'collect';
            delete creep.memory.targetId;
        }

        // ── Dispatch ──────────────────────────────────────────────────────────
        if (creep.memory.state === 'collect') {
            _collect(creep, maxHealMode);
        } else {
            _fill(creep, maxHealMode);
        }
    }
};

function _isMaxHealMode(creep) {
    if (!_repairMgr || !_repairMgr.isMaxHeal) return false;
    return _repairMgr.isMaxHeal(creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name);
}

// ============================================================================
// COLLECT — withdraw energy from the best available source
// ============================================================================

function _collect(creep, maxHealMode) {
    let target = _resolveTarget(creep, _findCollectTarget);
    if (!target) {
        creep.say('⚡ wait');
        return;
    }

    const needed = creep.store.getFreeCapacity(RESOURCE_ENERGY);

    let result;
    if (target instanceof Resource) {
        result = creep.pickup(target);
    } else {
        result = creep.withdraw(target, RESOURCE_ENERGY, Math.min(needed, target.store.getUsedCapacity(RESOURCE_ENERGY)));
    }

    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {
            visualizePathStyle: { stroke: '#ffff00', opacity: 0.5 },
            reusePath: 4
        });
    } else if (result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_ARGS) {
        delete creep.memory.targetId;
    } else if (result === OK) {
        // Flip to 'fill' and let _fill() handle the trip next tick.
        // We previously tried to pipelining-deliver to a tower in the same
        // tick, but that caused the creep to "drop off then chase another
        // empty tower" instead of going back to collect. Instead, we just
        // mark the tower we want to service in the heap queue and return.
        creep.memory.state = 'fill';
        delete creep.memory.targetId;

        const ttlMode = creep.ticksToLive < 100;
        const mode = maxHealMode
            ? 'maxHeal'
            : (ttlMode ? 'ttl' : 'normal');
        _peekNextFillTower(creep, mode);
    }
}

function _findCollectTarget(creep) {
    const room = creep.room;

    // 1. Storage (fastest per-tick energy)
    if (room.storage && room.storage.store.getUsedCapacity(RESOURCE_ENERGY) >= 200) {
        return room.storage;
    }

    // 2. Terminal
    const rs = getRoomState.get(room.name);
    let terminals = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_TERMINAL]) {
        const tArr = rs.structuresByType[STRUCTURE_TERMINAL];
        for (let ti = 0; ti < tArr.length; ti++) {
            if (tArr[ti].my && tArr[ti].store.getUsedCapacity(RESOURCE_ENERGY) >= 200) {
                terminals.push(tArr[ti]);
            }
        }
    } else {
        terminals = room.find(FIND_MY_STRUCTURES, {
            filter: s =>
                s.structureType === STRUCTURE_TERMINAL &&
                s.store.getUsedCapacity(RESOURCE_ENERGY) >= 200
        });
    }
    if (terminals.length > 0) return terminals[0];

    // 3. Containers — prefer the one with the most energy
    let containers = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) {
        const cArr = rs.structuresByType[STRUCTURE_CONTAINER];
        for (let ci = 0; ci < cArr.length; ci++) {
            if (cArr[ci].store.getUsedCapacity(RESOURCE_ENERGY) >= 100) {
                containers.push(cArr[ci]);
            }
        }
    } else {
        containers = room.find(FIND_STRUCTURES, {
            filter: s =>
                s.structureType === STRUCTURE_CONTAINER &&
                s.store.getUsedCapacity(RESOURCE_ENERGY) >= 100
        });
    }
    if (containers.length > 0) {
        containers.sort((a, b) =>
            b.store.getUsedCapacity(RESOURCE_ENERGY) -
            a.store.getUsedCapacity(RESOURCE_ENERGY)
        );
        return containers[0];
    }

    // 4. Dropped energy
    let dropped = [];
    if (rs && rs.dropped) {
        const dArr = rs.dropped;
        for (let di = 0; di < dArr.length; di++) {
            if (dArr[di].resourceType === RESOURCE_ENERGY && dArr[di].amount >= 50) {
                dropped.push(dArr[di]);
            }
        }
    } else {
        dropped = room.find(FIND_DROPPED_RESOURCES, {
            filter: r => r.resourceType === RESOURCE_ENERGY && r.amount >= 50
        });
    }
    if (dropped.length > 0) {
        dropped.sort((a, b) => b.amount - a.amount);
        return dropped[0];
    }

    return null;
}

// ============================================================================
// FILL — transfer energy to the most critical tower
// ============================================================================

function _fill(creep, maxHealMode) {
    // When TTL is short, skip the ratio gate and drain into every tower
    // in strict lowest-to-highest order so nothing is wasted.
    const ttlMode = creep.ticksToLive < 100;
    const mode = maxHealMode
        ? 'maxHeal'
        : (ttlMode ? 'ttl' : 'normal');

    // Pull next tower from the heap queue (lowest-energy first, sorted once).
    // Rebuilds automatically when the queue is missing or exhausted.
    const tower = _nextFillTower(creep, mode);

    if (!tower) {
        // All towers are healthy — orbit near storage until next state change
        const storage = creep.room.storage;
        if (storage && creep.pos.getRangeTo(storage) > 3) {
            creep.moveTo(storage, {
                visualizePathStyle: { stroke: '#aaaaaa', opacity: 0.3 },
                reusePath: 10
            });
        }
        return;
    }

    const transferAmount = Math.min(
        creep.store.getUsedCapacity(RESOURCE_ENERGY),
        tower.store.getFreeCapacity(RESOURCE_ENERGY)
    );

    if (transferAmount < MIN_FILL_AMOUNT) {
        // Not enough to make a worthwhile fill — orbit near storage
        // and wait for a more critical target.
        const storage = creep.room.storage;
        if (storage && creep.pos.getRangeTo(storage) > 3) {
            creep.moveTo(storage, {
                visualizePathStyle: { stroke: '#aaaaaa', opacity: 0.3 },
                reusePath: 10
            });
        }
        return;
    }

    const result = creep.transfer(tower, RESOURCE_ENERGY, transferAmount);

    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(tower, {
            visualizePathStyle: { stroke: '#ff4444', opacity: 0.6 },
            reusePath: 3
        });
    } else if (result === OK) {
        // Advance the queue cursor so the next fill trip services
        // the next-lowest tower instead of refilling this one.
        _advanceFillQueue(creep.room.name, mode);

        // Immediately go back to collect — don't try to walk toward
        // another empty tower while carrying nothing.
        creep.memory.state = 'collect';
        delete creep.memory.targetId;
    } else if (result === ERR_FULL) {
        // Tower filled between sort and transfer; skip it and try next.
        _advanceFillQueue(creep.room.name, mode);
        const next = _nextFillTower(creep, mode);
        if (next && creep.pos.getRangeTo(next) > 1) {
            creep.moveTo(next, {
                visualizePathStyle: { stroke: '#ff4444', opacity: 0.6 },
                reusePath: 3
            });
        }
    }
}

// ============================================================================
// Shared target helper — validates cache, calls finder on miss
// ============================================================================

function _resolveTarget(creep, finderFn, validatorFn) {
    if (creep.memory.targetId) {
        const cached = Game.getObjectById(creep.memory.targetId);
        if (cached && (!validatorFn || validatorFn(cached))) return cached;
        delete creep.memory.targetId;
    }

    const found = finderFn(creep);
    if (found) creep.memory.targetId = found.id;
    return found;
}

// ============================================================================
// HEAP-ONLY FILL QUEUE
// ----------------------------------------------------------------------------
//   global.__towerFillerQueues[roomName][mode] = { ids: [...], cursor: N }
//   mode is 'normal' | 'ttl' | 'maxHeal'.
//   Sorted once when the queue is (re)built, lowest-energy to highest.
//   Not persisted to Memory — we rebuild from current tower energy when the
//   heap is gone. This avoids serialization overhead and prevents stale
//   cached orderings from leaking across resets.
// ============================================================================

function _getQueues() {
    if (!global.__towerFillerQueues) global.__towerFillerQueues = {};
    return global.__towerFillerQueues;
}

function _roomQueues(roomName) {
    const all = _getQueues();
    if (!all[roomName]) all[roomName] = {};
    return all[roomName];
}

function _buildFillQueue(roomName, mode) {
    const room = Game.rooms[roomName];
    if (!room) return null;
    const rs = getRoomState.get(roomName);
    const isTtl = mode === 'ttl';
    const isMaxHeal = mode === 'maxHeal';
    const trigger = isMaxHeal ? MAX_HEAL_FILL_TARGET : FILL_TRIGGER_RATIO;

    let towers = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_TOWER]) {
        towers = rs.structuresByType[STRUCTURE_TOWER].filter(s => s && s.my);
    } else {
        towers = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        });
    }

    const candidates = [];
    for (let i = 0; i < towers.length; i++) {
        const t = towers[i];
        if (!t) continue;
        const free = t.store.getFreeCapacity(RESOURCE_ENERGY);
        if (free < MIN_FILL_AMOUNT) continue;
        if (!isTtl) {
            const ratio = t.store.getUsedCapacity(RESOURCE_ENERGY) /
                          t.store.getCapacity(RESOURCE_ENERGY);
            if (ratio >= trigger) continue;
        }
        candidates.push({ id: t.id, used: t.store.getUsedCapacity(RESOURCE_ENERGY) });
    }

    candidates.sort((a, b) => a.used - b.used);

    const q = _roomQueues(roomName);
    q[mode] = { ids: candidates.map(c => c.id), cursor: 0 };
    return q[mode];
}

function _queueKey(roomName, mode) {
    return roomName + '::' + mode;
}

function _peekNextFillTower(creep, mode) {
    return _nextFillTower(creep, mode);
}

function _nextFillTower(creep, mode) {
    const rq = _roomQueues(creep.room.name);
    let q = rq[mode];

    if (q) {
        // Walk forward through any now-invalid entries (full / destroyed /
        // no longer mine). Don't rebuild yet — only when we hit the end.
        while (q.cursor < q.ids.length) {
            const t = Game.getObjectById(q.ids[q.cursor]);
            if (t && t.my && t.store.getFreeCapacity(RESOURCE_ENERGY) >= MIN_FILL_AMOUNT) {
                return t;
            }
            q.cursor++;
        }
    }

    // Queue exhausted or missing — build a fresh one and try once more.
    q = _buildFillQueue(creep.room.name, mode);
    if (!q) return null;
    while (q.cursor < q.ids.length) {
        const t = Game.getObjectById(q.ids[q.cursor]);
        if (t && t.my && t.store.getFreeCapacity(RESOURCE_ENERGY) >= MIN_FILL_AMOUNT) {
            return t;
        }
        q.cursor++;
    }
    return null;
}

function _advanceFillQueue(roomName, mode) {
    const rq = _roomQueues(roomName);
    const q = rq[mode];
    if (q && q.cursor < q.ids.length) q.cursor++;
}
