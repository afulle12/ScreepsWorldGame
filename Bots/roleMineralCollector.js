// roleMineralCollector.
// Collects minerals from containers & buildings into storage, then suicides.
//orderMineralCollect('W8N3')
//orderMineralCollect('W8N3', { targetId: 'factoryId', resourceType: RESOURCE_ENERGY, amount: 1000, includeEnergy: true })
// roleMineralCollector.js
// Collects minerals from containers, terminals & labs into storage, then suicides.

var getRoomState = require('getRoomState');

function resourceAllowed(resourceType, opts) {
    if (!resourceType) return false;
    if (opts.resourceType && resourceType !== opts.resourceType) return false;
    if (resourceType === RESOURCE_ENERGY && !opts.includeEnergy) return false;
    return true;
}

function collectTargets(rs, opts) {
    var out = [];
    opts = opts || {};

    if (opts.targetId) {
        var target = Game.getObjectById(opts.targetId);
        if (target && hasCollectableResources(target, opts)) out.push(target);
        return out;
    }

    if (!rs || !rs.structuresByType) return out;
    var types = [STRUCTURE_CONTAINER, STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_FACTORY];
    for (var i = 0; i < types.length; i++) {
        var arr = rs.structuresByType[types[i]] || [];
        for (var j = 0; j < arr.length; j++) {
            if (hasCollectableResources(arr[j], opts)) out.push(arr[j]);
        }
    }
    return out;
}

function hasCollectableResources(structure, opts) {
    opts = opts || {};
    if (structure.store) {
        var keys = Object.keys(structure.store);
        for (var i = 0; i < keys.length; i++) {
            var r = keys[i];
            if (resourceAllowed(r, opts) && structure.store[r] > 0) return true;
        }
        return false;
    }
    if (structure.structureType === STRUCTURE_LAB) {
        return !!structure.mineralType && resourceAllowed(structure.mineralType, opts) && structure.mineralAmount > 0;
    }
    return false;
}

module.exports = {
    run: function (creep) {
        const home = Game.rooms[creep.memory.homeRoom];
        if (!home) { creep.suicide(); return; }

        const rs = getRoomState.get(home.name);

        // helper to unify store vs legacy lab API
        const opts = {
            targetId: creep.memory.targetId || null,
            resourceType: creep.memory.resourceType || null,
            includeEnergy: creep.memory.includeEnergy === true
        };

        function firstCollectableResource(structure) {
            if (structure.store) {
                const keys = Object.keys(structure.store);
                for (let i = 0; i < keys.length; i++) {
                    const r = keys[i];
                    if (resourceAllowed(r, opts) && structure.store[r] > 0) return r;
                }
                return null;
            }
            if (structure.structureType === STRUCTURE_LAB) {
                if (structure.mineralType && resourceAllowed(structure.mineralType, opts) && structure.mineralAmount > 0) return structure.mineralType;
                return null;
            }
            return null;
        }

        /* 1.  Initial scan – count minerals (exclude storage) */
        if (creep.memory.collectedSoFar === undefined) creep.memory.collectedSoFar = 0;
        if (creep.memory.totalToCollect === undefined) {
            let total = 0;
            const targets = collectTargets(rs, opts);
            for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                if (t.store) {
                    const keys = Object.keys(t.store);
                    for (let k = 0; k < keys.length; k++) {
                        const res = keys[k];
                        if (resourceAllowed(res, opts)) total += t.store[res];
                    }
                } else if (t.structureType === STRUCTURE_LAB) {
                    if (t.mineralType && resourceAllowed(t.mineralType, opts) && t.mineralAmount > 0) total += t.mineralAmount;
                }
            }
            creep.memory.totalToCollect = total;
            if (total === 0) { creep.suicide(); return; }   // nothing to do
        }

        /* 2.  Suicide when finished */
        if (creep.memory.collectedSoFar >= creep.memory.totalToCollect) {
            creep.suicide();
            return;
        }

        /* 3.  Pick-up phase */
        if (_.sum(creep.store) === 0) {
            const candidates = collectTargets(rs, opts);
            const target = candidates.length ? creep.pos.findClosestByRange(candidates) : null;
            if (!target) { creep.suicide(); return; }

            const res = firstCollectableResource(target);
            if (res) {
                const remaining = Math.max(0, creep.memory.totalToCollect - creep.memory.collectedSoFar);
                const amount = Math.min(remaining, creep.store.getFreeCapacity(), target.store ? (target.store[res] || 0) : remaining);
                const code = creep.withdraw(target, res, amount);
                if (code === ERR_NOT_IN_RANGE) {
                    creep.moveTo(target);
                } else if (code === ERR_INVALID_TARGET || code === ERR_NOT_ENOUGH_RESOURCES) {
                    // target became invalid; try again next tick
                }
            }
            return;
        }

        /* 4.  Drop-off phase */
        const storage = home.storage;
        if (!storage) { creep.suicide(); return; }

        const keys = Object.keys(creep.store);
        for (let i = 0; i < keys.length; i++) {
            const res = keys[i];
            if (resourceAllowed(res, opts) && creep.store[res] > 0) {
                const amount = creep.store[res]; // capture pre-transfer amount
                const code = creep.transfer(storage, res);
                if (code === ERR_NOT_IN_RANGE) {
                    creep.moveTo(storage);
                } else if (code === OK) {
                    creep.memory.collectedSoFar += amount;
                }
                break;
            }
        }
    }
};
