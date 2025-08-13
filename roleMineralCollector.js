// roleMineralCollector.
// Collects minerals from containers & buildings into storage, then suicides.
//orderMineralCollect('W8N3')
// roleMineralCollector.js
// Collects minerals from containers, terminals & labs into storage, then suicides.

module.exports = {
    run: function (creep) {
        const home = Game.rooms[creep.memory.homeRoom];

        /* 1.  Initial scan – count minerals (exclude storage) */
        if (!creep.memory.totalToCollect) {
            let total = 0;
            const targets = home.find(FIND_STRUCTURES, {
                filter: s =>
                    [STRUCTURE_CONTAINER, STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_FACTORY].includes(s.structureType) &&
                    s.store &&
                    Object.keys(s.store).some(r => r !== RESOURCE_ENERGY && s.store[r] > 0)
            });
            for (const t of targets) {
                for (const res of Object.keys(t.store)) {
                    if (res !== RESOURCE_ENERGY) total += t.store[res];
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
                    [STRUCTURE_CONTAINER, STRUCTURE_TERMINAL, STRUCTURE_LAB].includes(s.structureType) &&
                    s.store &&
                    Object.keys(s.store).some(r => r !== RESOURCE_ENERGY && s.store[r] > 0)
            });
            if (!target) { creep.suicide(); return; }

            for (const res of Object.keys(target.store)) {
                if (res !== RESOURCE_ENERGY && target.store[res] > 0) {
                    if (creep.withdraw(target, res) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(target);
                    }
                    break;
                }
            }
            return;
        }

        /* 4.  Drop-off phase */
        const storage = home.storage;
        if (!storage) { creep.suicide(); return; }

        for (const res of Object.keys(creep.store)) {
            if (res !== RESOURCE_ENERGY && creep.store[res] > 0) {
                if (creep.transfer(storage, res) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(storage);
                } else {
                    creep.memory.collectedSoFar += creep.store[res];
                }
                break;
            }
        }
    }
};
