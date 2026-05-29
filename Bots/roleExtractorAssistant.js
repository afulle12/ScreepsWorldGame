// roleExtractorAssistant.js

'use strict';

const FETCH_THRESHOLD  = 1800;   // container mineral units before hauling
const WAIT_RANGE       = 3;      // tiles from container while idle
const IDLE_SLEEP_TICKS = 10;     // ticks to skip while waiting below threshold
const CONTAINER_RESCAN = 1000;   // re-validate cached container ID every N ticks

var getRoomState = require('getRoomState');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns pathfinding options that block all edge squares (the entire border
 * ring at x=0, x=49, y=0, y=49) from being considered as passable terrain.
 * This prevents PathFinder from routing creeps through room borders.
 */
function edgeAvoidingOpts(base) {
    base = base || {};
    base.costCallback = function(roomName, costMatrix) {
        var m = costMatrix.clone();
        var w = 50; // rooms are always 50×50
        // First and last row — block every column on those rows
        for (var x = 0; x < w; x++) {
            m.set(x, 0,     255);
            m.set(x, w - 1, 255);
        }
        // First and last column — block every row on those columns
        // (corners already set to 255 above, but re-setting is harmless)
        for (var y = 0; y < w; y++) {
            m.set(0,     y, 255);
            m.set(w - 1, y, 255);
        }
        return m;
    };
    return base;
}

/** Sum of all non-energy resources in a store. Uses for..in to avoid Object.keys() alloc. */
function mineralAmountInStore(store) {
    var total = 0;
    for (var key in store) {
        if (key !== RESOURCE_ENERGY) total += store[key] || 0;
    }
    return total;
}

/** First non-energy resource type with quantity > 0, or null. */
function firstMineralType(store) {
    for (var key in store) {
        if (key !== RESOURCE_ENERGY && store[key] > 0) return key;
    }
    return null;
}

/**
 * Resolve and cache the mineral container ID in creep.memory.containerIdEA.
 * Re-scans every CONTAINER_RESCAN ticks or if the cached object is gone.
 */
function resolveContainer(creep, rs) {
    var cached = creep.memory.containerIdEA;
    var rescanDue = !creep.memory._containerScanTick ||
                    (Game.time - creep.memory._containerScanTick) >= CONTAINER_RESCAN;

    if (cached && !rescanDue) {
        var obj = Game.getObjectById(cached);
        if (obj) return obj;
        // Object gone — fall through to rescan
    }

    if (!rs || !rs.structuresByType) return null;

    var extractors = rs.structuresByType[STRUCTURE_EXTRACTOR] || [];
    var extractor = null;
    for (var i = 0; i < extractors.length; i++) {
        if (extractors[i].my) { extractor = extractors[i]; break; }
    }
    if (!extractor) return null;

    var containers = rs.structuresByType[STRUCTURE_CONTAINER] || [];
    for (var j = 0; j < containers.length; j++) {
        if (containers[j].pos.getRangeTo(extractor.pos) <= 1) {
            creep.memory.containerIdEA = containers[j].id;
            creep.memory._containerScanTick = Game.time;
            return containers[j];
        }
    }

    creep.memory.containerIdEA = null;
    creep.memory._containerScanTick = Game.time;
    return null;
}

/** Return the room's owned extractor, or null. */
function resolveExtractor(rs) {
    if (!rs || !rs.structuresByType) return null;
    var extractors = rs.structuresByType[STRUCTURE_EXTRACTOR] || [];
    for (var i = 0; i < extractors.length; i++) {
        if (extractors[i].my) return extractors[i];
    }
    return null;
}

/**
 * Safe moveTo wrapper — skips the call entirely while fatigued.
 * Saves PathFinder CPU on the 3 dead ticks between off-road steps.
 * Also routes around room edges by applying edge-avoiding cost penalties.
 */
function tryMove(creep, target, opts) {
    if (creep.fatigue > 0) return false;
    creep.moveTo(target, edgeAvoidingOpts(opts));
    return true;
}

// ── Role ────────────────────────────────────────────────────────────────────

var roleExtractorAssistant = {
    run: function(creep) {

        // ── IDLE SLEEP GATE ────────────────────────────────────────────────
        if (creep.memory.sleepUntil && Game.time < creep.memory.sleepUntil) {
            return;
        }
        delete creep.memory.sleepUntil;

        // ── LOW TTL SUICIDE ────────────────────────────────────────────────
        if (creep.ticksToLive < 400 && mineralAmountInStore(creep.store) === 0) {
            creep.suicide();
            return;
        }

        var rs = getRoomState.get(creep.room.name);

        // ── Resolve world state ──────────────────────────────────────────────
        var container       = resolveContainer(creep, rs);
        var extractor       = resolveExtractor(rs);
        var mineral         = (rs && rs.minerals && rs.minerals.length > 0) ? rs.minerals[0] : null;
        var sourceExhausted = !mineral || mineral.mineralAmount === 0;
        var containerAmt    = container ? mineralAmountInStore(container.store) : 0;
        var creepAmt        = mineralAmountInStore(creep.store);

        // ── SUICIDE: source dead, container empty, hands empty ───────────────
        if (sourceExhausted && containerAmt === 0 && creepAmt === 0) {
            console.log('[ExtractorAssistant] ' + creep.name + ': work complete — suiciding.');
            creep.suicide();
            return;
        }

        // ── STATE TRANSITIONS ────────────────────────────────────────────────
        var state = creep.memory.state || 'waiting';

        if (creep.store.getFreeCapacity() === 0) {
            // Carry is full — must deliver regardless of current state
            state = 'delivering';
        } else if (state === 'delivering' && creepAmt === 0) {
            // Finished delivering all types — back to waiting
            state = 'waiting';
        }
        // NOTE: carrying minerals while NOT full stays in 'fetching' so we
        // can grab additional mineral types from the container in subsequent ticks.

        if (state === 'waiting') {
            var shouldFetch = container && (
                containerAmt >= FETCH_THRESHOLD ||
                (sourceExhausted && containerAmt > 0)
            );
            if (shouldFetch) state = 'fetching';
        }

        creep.memory.state = state;

        // ── STATE MACHINE ────────────────────────────────────────────────────
        switch (state) {

            // ── WAITING ───────────────────────────────────────────────────
            case 'waiting': {
                // Idle near the extractor so the creep is already close when
                // fetching starts. Fall back to the container if the extractor
                // isn't visible yet (e.g. still under construction).
                var idleAnchor = extractor || container;
                if (!idleAnchor) {
                    creep.memory.sleepUntil = Game.time + IDLE_SLEEP_TICKS * 3;
                    return;
                }
                if (creep.pos.getRangeTo(idleAnchor.pos) > WAIT_RANGE) {
                    tryMove(creep, idleAnchor.pos, { reusePath: 20, range: WAIT_RANGE });
                    // Still in transit — don't sleep, we need to move every tick
                    return;
                }
                // In position — safe to sleep until threshold check is needed
                creep.memory.sleepUntil = Game.time + IDLE_SLEEP_TICKS;
                return;
            }

            // ── FETCHING ──────────────────────────────────────────────────
            case 'fetching': {
                if (!container) { creep.memory.state = 'waiting'; return; }

                var free = creep.store.getFreeCapacity();
                if (free === 0) { creep.memory.state = 'delivering'; return; }

                // Find any mineral type still in the container.
                // Using for..in avoids an Object.keys() allocation.
                var resType = null;
                for (var key in container.store) {
                    if (key !== RESOURCE_ENERGY && (container.store[key] || 0) > 0) {
                        resType = key;
                        break;
                    }
                }

                if (!resType) {
                    // Container is empty of minerals — deliver what we have, or wait
                    creep.memory.state = creepAmt > 0 ? 'delivering' : 'waiting';
                    return;
                }

                if (!creep.pos.isNearTo(container.pos)) {
                    tryMove(creep, container.pos, { reusePath: 10 });
                    return;
                }

                // withdraw() without an amount takes as much as fits in free capacity
                var wRes = creep.withdraw(container, resType);
                if (wRes === OK) {
                    // Stay in 'fetching' — there may be more types next tick.
                    // The top-level transition will flip to 'delivering' once full.
                } else if (wRes === ERR_FULL) {
                    creep.memory.state = 'delivering';
                } else if (wRes === ERR_NOT_ENOUGH_RESOURCES) {
                    // That type was already gone — will pick a different one next tick
                } else if (wRes !== ERR_BUSY && wRes !== ERR_NOT_IN_RANGE) {
                    console.log('[ExtractorAssistant] ' + creep.name + ': withdraw err ' + wRes);
                    creep.memory.state = 'waiting';
                }
                break;
            }

            // ── DELIVERING ────────────────────────────────────────────────
            case 'delivering': {
                var storage = creep.room.storage;
                if (!storage) {
                    var dropType = firstMineralType(creep.store);
                    if (dropType) creep.drop(dropType);
                    creep.memory.state = 'waiting';
                    return;
                }

                // Find whichever mineral type we're still carrying this tick.
                // Iterates naturally as types are emptied one-per-tick.
                var carryType = firstMineralType(creep.store);
                if (!carryType) {
                    creep.memory.state = 'waiting';
                    return;
                }

                if (!creep.pos.isNearTo(storage.pos)) {
                    tryMove(creep, storage.pos, { reusePath: 10 });
                    return;
                }

                var tRes = creep.transfer(storage, carryType);
                if (tRes === OK) {
                    // Stay in 'delivering' — may have more types to deposit next tick.
                    // The top-level transition to 'waiting' fires when creepAmt hits 0.
                } else if (tRes === ERR_FULL) {
                    creep.drop(carryType);
                    // Don't give up — try remaining types next tick
                } else if (tRes !== ERR_BUSY && tRes !== ERR_NOT_IN_RANGE) {
                    console.log('[ExtractorAssistant] ' + creep.name + ': transfer err ' + tRes);
                    creep.memory.state = 'waiting';
                }
                break;
            }

            default:
                creep.memory.state = 'waiting';
                break;
        }
    }
};

module.exports = roleExtractorAssistant;
