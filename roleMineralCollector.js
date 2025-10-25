// roleMineralCollector.
// Collects minerals from containers & buildings into storage, then suicides.
//orderMineralCollect('W8N3')
// roleMineralCollector.js
// Collects minerals from containers, terminals & labs into storage, then suicides.

module.exports = {
    run: function (creep) {
        const home = Game.rooms[creep.memory.homeRoom];
        if (!home) { creep.suicide(); return; }

        // helpers to unify store vs legacy lab API
        function hasNonEnergyResources(structure) {
            if (structure.store) {
                const keys = Object.keys(structure.store);
                for (let i = 0; i < keys.length; i++) {
                    const r = keys[i];
                    if (r !== RESOURCE_ENERGY && structure.store[r] > 0) return true;
                }
                return false;
            }
            // legacy labs: mineralType/mineralAmount
            if (structure.structureType === STRUCTURE_LAB) {
                return !!structure.mineralType && structure.mineralAmount > 0;
            }
            return false;
        }

        function firstNonEnergyResource(structure) {
            if (structure.store) {
                const keys = Object.keys(structure.store);
                for (let i = 0; i < keys.length; i++) {
                    const r = keys[i];
                    if (r !== RESOURCE_ENERGY && structure.store[r] > 0) return r;
                }
                return null;
            }
            if (structure.structureType === STRUCTURE_LAB) {
                if (structure.mineralType && structure.mineralAmount > 0) return structure.mineralType;
                return null;
            }
            return null;
        }

        /* 1.  Initial scan – count minerals (exclude storage) */
        if (!creep.memory.totalToCollect) {
            let total = 0;
            const targets = home.find(FIND_STRUCTURES, {
                filter: s =>
                    [STRUCTURE_CONTAINER, STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_FACTORY].includes(s.structureType) &&
                    hasNonEnergyResources(s)
            });
            for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                if (t.store) {
                    const keys = Object.keys(t.store);
                    for (let k = 0; k < keys.length; k++) {
                        const res = keys[k];
                        if (res !== RESOURCE_ENERGY) total += t.store[res];
                    }
                } else if (t.structureType === STRUCTURE_LAB) {
                    if (t.mineralType && t.mineralAmount > 0) total += t.mineralAmount;
                }
            }
            creep.memory.totalToCollect = total;
            creep.memory.collectedSoFar = 0;
            if (total === 0) { creep.suicide(); return; }   // nothing to do
        }

        /* 2.  Suicide when finished */
        if (creep.memory.collectedSoFar >= creep.memory.totalToCollect) {
            creep.suicide();
            return;
        }

        /* 3.  Pick-up phase */
        if (_.sum(creep.store) === 0) {
            const target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: s =>
                    [STRUCTURE_CONTAINER, STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_FACTORY].includes(s.structureType) &&
                    hasNonEnergyResources(s)
            });
            if (!target) { creep.suicide(); return; }

            const res = firstNonEnergyResource(target);
            if (res) {
                const code = creep.withdraw(target, res);
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
            if (res !== RESOURCE_ENERGY && creep.store[res] > 0) {
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
