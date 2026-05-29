// roleStaticDistributor.js
// ============================================================================
// Distributor — Stationary role for 1-source RCL 8 rooms.

var getRoomState = require('getRoomState');

// Neighbor cache per creep
var neighborCache = {};
var neighborCacheLastPrune = 0;

var TOWER_HIGH_THRESHOLD = 800;  // 80% of 1000

module.exports = {
    run: function(creep) {
        if (creep.spawning) return;
        if (Game.time % 3 !== 0) return;

        // Prune dead entries
        if (Game.time - neighborCacheLastPrune > 200) {
            neighborCacheLastPrune = Game.time;
            for (var name in neighborCache) {
                if (!Game.creeps[name]) delete neighborCache[name];
            }
        }

        var state = getRoomState.get(creep.room.name);
        if (!state) return;

        // === RENEWAL ===
        if (creep.ticksToLive < 200) {
            var spawn = this.getAdjacentSpawn(creep, state);
            if (spawn && !spawn.spawning) {
                var result = spawn.renewCreep(creep);
                if (result === OK) {
                    creep.say('♻️');
                    return;
                }
            }
        }

        var hood = this.getNeighbors(creep, state);
        var carrying = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;

        if (carrying > 0) {
            // === TRANSFER (priority order) ===
            var transferred = false;

            // Priority 1: Towers below 80%
            var lowestTower = null;
            var lowestEnergy = Infinity;
            for (var t = 0; t < hood.towers.length; t++) {
                var tower = hood.towers[t];
                var tEnergy = tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                if (tEnergy < TOWER_HIGH_THRESHOLD && tEnergy < lowestEnergy) {
                    lowestEnergy = tEnergy;
                    lowestTower = tower;
                }
            }
            if (lowestTower) {
                creep.transfer(lowestTower, RESOURCE_ENERGY);
                transferred = true;
            }

            // Priority 2: Spawn
            if (!transferred && hood.spawn) {
                var spawnFree = hood.spawn.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
                if (spawnFree > 0) {
                    creep.transfer(hood.spawn, RESOURCE_ENERGY);
                    transferred = true;
                }
            }

            // Priority 3: Extensions
            if (!transferred) {
                for (var e = 0; e < hood.extensions.length; e++) {
                    var ext = hood.extensions[e];
                    if (ext.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        creep.transfer(ext, RESOURCE_ENERGY);
                        transferred = true;
                        break;
                    }
                }
            }

            // Priority 4: Top off towers to 100%
            if (!transferred) {
                for (var t2 = 0; t2 < hood.towers.length; t2++) {
                    var tw = hood.towers[t2];
                    if (tw.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        creep.transfer(tw, RESOURCE_ENERGY);
                        transferred = true;
                        break;
                    }
                }
            }

            // ALSO withdraw from link to refill for next tick (separate intent)
            if (hood.link) {
                var linkEnergy = hood.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                var myFree = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
                if (linkEnergy > 0 && myFree > 0) {
                    creep.withdraw(hood.link, RESOURCE_ENERGY);
                }
            }
        } else {
            // === EMPTY: Withdraw from link ===
            if (hood.link) {
                var linkEnergy = hood.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                if (linkEnergy > 0) {
                    creep.withdraw(hood.link, RESOURCE_ENERGY);
                } else {
                    if (Game.time % 10 === 0) creep.say('⏳');
                }
            } else {
                if (Game.time % 10 === 0) creep.say('no link');
            }
        }
    },

    getAdjacentSpawn: function(creep, state) {
        var byType = state.structuresByType || {};
        var spawns = byType[STRUCTURE_SPAWN] || [];
        for (var i = 0; i < spawns.length; i++) {
            if (spawns[i].my && creep.pos.isNearTo(spawns[i])) return spawns[i];
        }
        return null;
    },

    getNeighbors: function(creep, state) {
        var cache = neighborCache[creep.name];

        if (!cache || (Game.time - cache.idsAt) >= 100) {
            var byType = state.structuresByType || {};
            var cx = creep.pos.x;
            var cy = creep.pos.y;

            function isAdj(s) {
                return Math.abs(cx - s.pos.x) <= 1 && Math.abs(cy - s.pos.y) <= 1;
            }

            var spawnId = null;
            var linkId = null;
            var towerIds = [];
            var extIds = [];

            var spawns = byType[STRUCTURE_SPAWN] || [];
            for (var i = 0; i < spawns.length; i++) {
                if (spawns[i].my && isAdj(spawns[i])) { spawnId = spawns[i].id; break; }
            }

            var links = byType[STRUCTURE_LINK] || [];
            for (var i = 0; i < links.length; i++) {
                if (links[i].my && isAdj(links[i])) { linkId = links[i].id; break; }
            }

            var towers = byType[STRUCTURE_TOWER] || [];
            for (var i = 0; i < towers.length; i++) {
                if (towers[i].my && isAdj(towers[i])) towerIds.push(towers[i].id);
            }

            var exts = byType[STRUCTURE_EXTENSION] || [];
            for (var i = 0; i < exts.length; i++) {
                if (exts[i].my && isAdj(exts[i])) extIds.push(exts[i].id);
            }

            cache = { spawnId: spawnId, linkId: linkId, towerIds: towerIds, extIds: extIds, idsAt: Game.time };
            neighborCache[creep.name] = cache;
        }

        if (cache.tick === Game.time) return cache.hood;

        var hood = {
            spawn: cache.spawnId ? Game.getObjectById(cache.spawnId) : null,
            link: cache.linkId ? Game.getObjectById(cache.linkId) : null,
            towers: [],
            extensions: []
        };

        for (var i = 0; i < cache.towerIds.length; i++) {
            var tw = Game.getObjectById(cache.towerIds[i]);
            if (tw) hood.towers.push(tw);
        }
        for (var i = 0; i < cache.extIds.length; i++) {
            var ext = Game.getObjectById(cache.extIds[i]);
            if (ext) hood.extensions.push(ext);
        }

        cache.hood = hood;
        cache.tick = Game.time;
        return hood;
    }
};