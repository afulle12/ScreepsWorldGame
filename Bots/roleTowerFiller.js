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

const getRoomState = require('getRoomState');

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

        // ── Init state ────────────────────────────────────────────────────────
        if (!creep.memory.state) {
            creep.memory.state = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0
                ? 'fill'
                : 'collect';
        }

        // ── State transitions ─────────────────────────────────────────────────
        if (creep.memory.state === 'collect' && creep.store.getFreeCapacity() === 0) {
            creep.memory.state = 'fill';
            delete creep.memory.targetId;
        }
        if (creep.memory.state === 'fill' && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.state = 'collect';
            delete creep.memory.targetId;
        }

        // ── Dispatch ──────────────────────────────────────────────────────────
        if (creep.memory.state === 'collect') {
            _collect(creep);
        } else {
            _fill(creep);
        }
    }
};

// ============================================================================
// COLLECT — withdraw energy from the best available source
// ============================================================================

function _collect(creep) {
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

function _fill(creep) {
    // When TTL is short, skip the ratio gate and drain into every tower
    // in strict lowest-to-highest order so nothing is wasted.
    const finderFn = creep.ticksToLive < 100
        ? _findFillTargetAll
        : _findFillTarget;

    let tower = _resolveTarget(creep, finderFn);

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

    const result = creep.transfer(tower, RESOURCE_ENERGY);

    if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(tower, {
            visualizePathStyle: { stroke: '#ff4444', opacity: 0.6 },
            reusePath: 3
        });
    } else if (result === OK) {
        // Keep filling this tower until it reaches FILL_TARGET_RATIO (90%).
        // Previously targetId was always cleared here, which caused the creep
        // to re-evaluate next tick and abandon towers that only reached ~51%.
        const updatedTower = Game.getObjectById(creep.memory.targetId);
        if (!updatedTower) {
            delete creep.memory.targetId;
            return;
        }
        const ratio = updatedTower.store.getUsedCapacity(RESOURCE_ENERGY) /
                      updatedTower.store.getCapacity(RESOURCE_ENERGY);
        if (ratio >= FILL_TARGET_RATIO) {
            // Tower is adequately filled — re-evaluate for another needy tower
            delete creep.memory.targetId;
        }
        // else: keep targetId so we return to the same tower next tick
    }
}

// Normal operation: only towers below FILL_TRIGGER_RATIO
function _findFillTarget(creep) {
    const room = creep.room;
    const rs = getRoomState.get(room.name);
    let towers = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_TOWER]) {
        const tArr = rs.structuresByType[STRUCTURE_TOWER];
        for (let ti = 0; ti < tArr.length; ti++) {
            const s = tArr[ti];
            if (!s.my) continue;
            const ratio = s.store.getUsedCapacity(RESOURCE_ENERGY) /
                          s.store.getCapacity(RESOURCE_ENERGY);
            if (ratio < FILL_TRIGGER_RATIO) towers.push(s);
        }
    } else {
        towers = room.find(FIND_MY_STRUCTURES, {
            filter: s => {
                if (s.structureType !== STRUCTURE_TOWER) return false;
                const ratio = s.store.getUsedCapacity(RESOURCE_ENERGY) /
                              s.store.getCapacity(RESOURCE_ENERGY);
                return ratio < FILL_TRIGGER_RATIO;
            }
        });
    }

    if (towers.length === 0) return null;

    towers.sort((a, b) =>
        a.store.getUsedCapacity(RESOURCE_ENERGY) -
        b.store.getUsedCapacity(RESOURCE_ENERGY)
    );
    return towers[0];
}

// TTL < 100: target every tower that isn't completely full, lowest energy first
function _findFillTargetAll(creep) {
    const room = creep.room;
    const rs = getRoomState.get(room.name);
    let towers = [];
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_TOWER]) {
        const tArr = rs.structuresByType[STRUCTURE_TOWER];
        for (let ti = 0; ti < tArr.length; ti++) {
            const s = tArr[ti];
            if (!s.my) continue;
            if (s.store.getFreeCapacity(RESOURCE_ENERGY) > 0) towers.push(s);
        }
    } else {
        towers = room.find(FIND_MY_STRUCTURES, {
            filter: s => {
                if (s.structureType !== STRUCTURE_TOWER) return false;
                return s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
            }
        });
    }

    if (towers.length === 0) return null;

    towers.sort((a, b) =>
        a.store.getUsedCapacity(RESOURCE_ENERGY) -
        b.store.getUsedCapacity(RESOURCE_ENERGY)
    );
    return towers[0];
}

// ============================================================================
// Shared target helper — validates cache, calls finder on miss
// ============================================================================

function _resolveTarget(creep, finderFn) {
    if (creep.memory.targetId) {
        const cached = Game.getObjectById(creep.memory.targetId);
        if (cached) return cached;
        delete creep.memory.targetId;
    }

    const found = finderFn(creep);
    if (found) creep.memory.targetId = found.id;
    return found;
}