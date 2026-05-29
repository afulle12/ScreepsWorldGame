// roleHD.js
// ============================================================================
// Harvester/Distributor — Stationary role for 1-source RCL 8 rooms.
//
// Has NO MOVE parts. Spawned onto an anchor tile adjacent to:
//   - Source (harvest)
//   - Spawn (fill)
//   - Link (dump energy into link network)
//   - Extensions (fill 2 local extensions)
//
// Tick logic (pipeline: harvest + transfer each tick):
//   1. Renewal check (TTL < 200)
//   2. harvest(source) — if source has energy and carry has room
//   3. ONE transfer (priority order, only when carry full or source empty):
//      a. Spawn (if not full)
//      b. Extension with most free capacity (if any not full)
//      c. Link (dump the rest)
//   4. Idle if source depleted and carry empty
//
// Stops harvesting when room storage >= 350k energy (link still drains carry).
//
// Body: 5 WORK + 4 CARRY = 700 energy (9 parts)
//   - 5 WORK saturates a single source (10 energy/tick)
//   - 4 CARRY = 200 buffer (2 harvest ticks)
// ============================================================================

var getRoomState = require('getRoomState');
var singleSource = require('singleSourceRoom');

// Cache neighbor structure IDs per creep (recompute every 100 ticks)
var neighborCache = {};
var neighborCacheLastPrune = 0;

module.exports = {
    run: function(creep) {
        if (creep.spawning) return;

        // Prune dead creep entries
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
                    return; // renewCreep blocks other creep actions this tick
                }
            }
            // If spawn is busy, continue working — 200 ticks of buffer
        }

        // === HARVEST ===
        var source = Game.getObjectById(creep.memory.sourceId);
        if (!source) {
            // Try to find source in range 1
            var sources = state.sources || [];
            for (var i = 0; i < sources.length; i++) {
                if (creep.pos.isNearTo(sources[i])) {
                    creep.memory.sourceId = sources[i].id;
                    source = sources[i];
                    break;
                }
            }
            if (!source) {
                creep.say('no src');
                return;
            }
        }

        // Check storage threshold — stop harvesting if storage >= 350k
        var shouldHarvest = true;
        if (state.storage && state.storage.store) {
            var storageEnergy = state.storage.store[RESOURCE_ENERGY] || 0;
            if (storageEnergy >= 350000) {
                shouldHarvest = false;
            }
        }

        if (shouldHarvest && source.energy > 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.harvest(source);
        }

        // === TRANSFER (one per tick, priority order) ===
        // Only transfer when carry is full or source is depleted (batch transfers)
        var carrying = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        if (carrying <= 0) {
            // Nothing to transfer — idle
            if (source.energy === 0 && typeof source.ticksToRegeneration === 'number') {
                if (Game.time % 10 === 0) creep.say('⏳' + source.ticksToRegeneration);
            }
            return;
        }

        var carryFull = creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
        var sourceDepleted = !source || source.energy === 0;
        if (!carryFull && !sourceDepleted) return;

        var hood = this.getNeighbors(creep, state);

        // Priority 1: Fill spawn
        if (hood.spawn && hood.spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.transfer(hood.spawn, RESOURCE_ENERGY);
            return;
        }

        // Priority 2: Fill extensions (pick the one with most free capacity)
        var bestExt = null;
        var bestFree = 0;
        for (var e = 0; e < hood.extensions.length; e++) {
            var ext = hood.extensions[e];
            var free = ext.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
            if (free > bestFree) {
                bestFree = free;
                bestExt = ext;
            }
        }
        if (bestExt) {
            creep.transfer(bestExt, RESOURCE_ENERGY);
            return;
        }

        // Priority 3: Dump into link (any amount — clear carry before next harvest)
        if (hood.link && hood.link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.transfer(hood.link, RESOURCE_ENERGY);
            return;
        }
        // Everything full — idle
        if (Game.time % 10 === 0) creep.say('full');
    },

    /**
     * Get adjacent spawn (range 1, owned, for renewal).
     */
    getAdjacentSpawn: function(creep, state) {
        var byType = state.structuresByType || {};
        var spawns = byType[STRUCTURE_SPAWN] || [];
        for (var i = 0; i < spawns.length; i++) {
            if (spawns[i].my && creep.pos.isNearTo(spawns[i])) return spawns[i];
        }
        return null;
    },

    /**
     * Get neighbor structures (range 1) with caching.
     * Returns { spawn, link, extensions: [], containers: [] }
     */
    getNeighbors: function(creep, state) {
        var cache = neighborCache[creep.name];

        // Recompute IDs every 100 ticks or on first call
        if (!cache || (Game.time - cache.idsAt) >= 100) {
            var byType = state.structuresByType || {};
            var cx = creep.pos.x;
            var cy = creep.pos.y;

            var spawnId = null;
            var linkId = null;
            var extIds = [];

            var spawns = byType[STRUCTURE_SPAWN] || [];
            for (var i = 0; i < spawns.length; i++) {
                if (spawns[i].my && Math.abs(cx - spawns[i].pos.x) <= 1 && Math.abs(cy - spawns[i].pos.y) <= 1) {
                    spawnId = spawns[i].id;
                    break;
                }
            }

            var links = byType[STRUCTURE_LINK] || [];
            for (var i = 0; i < links.length; i++) {
                if (links[i].my && Math.abs(cx - links[i].pos.x) <= 1 && Math.abs(cy - links[i].pos.y) <= 1) {
                    linkId = links[i].id;
                    break;
                }
            }

            var exts = byType[STRUCTURE_EXTENSION] || [];
            for (var i = 0; i < exts.length; i++) {
                if (exts[i].my && Math.abs(cx - exts[i].pos.x) <= 1 && Math.abs(cy - exts[i].pos.y) <= 1) {
                    extIds.push(exts[i].id);
                }
            }

            cache = {
                spawnId: spawnId,
                linkId: linkId,
                extIds: extIds,
                idsAt: Game.time
            };
            neighborCache[creep.name] = cache;
        }

        // Resolve live objects (once per tick via per-tick cache)
        if (cache.tick === Game.time) return cache.hood;

        var hood = {
            spawn: cache.spawnId ? Game.getObjectById(cache.spawnId) : null,
            link: cache.linkId ? Game.getObjectById(cache.linkId) : null,
            extensions: []
        };

        for (var i = 0; i < cache.extIds.length; i++) {
            var ext = Game.getObjectById(cache.extIds[i]);
            if (ext) hood.extensions.push(ext);
        }

        cache.hood = hood;
        cache.tick = Game.time;
        return hood;
    }
};