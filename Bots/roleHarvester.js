// roleHarvester.js

const getRoomState = require('getRoomState');
const SUICIDE_TTL_THRESHOLD = 121;
const RENEW_TTL_THRESHOLD = 500;

// Module-level anchor cache — survives tick boundaries (game objects don't).
// Keyed by creep.name. Entries cleared when creep leaves anchor or dies.
var anchorCache = {};
var anchorCacheLastPrune = 0;

// Module-level stuck cache — heap memory, cleared on global reset.
// Keyed by creep.name. Tracks position + consecutive ticks without movement.
var stuckCache = {};

var roleHarvester = {
    run: function(creep) {
        // Prune dead creep entries from anchor cache (~once per 200 ticks)
        if (Game.time - anchorCacheLastPrune > 200) {
            anchorCacheLastPrune = Game.time;
            for (var name in anchorCache) {
                if (!Game.creeps[name]) delete anchorCache[name];
            }
            for (var name in stuckCache) {
                if (!Game.creeps[name]) delete stuckCache[name];
            }
        }

        var state = getRoomState.get(creep.room.name);
        if (!state) {
            console.log('[Harvester] ' + creep.name + ' no room state available for ' + creep.room.name + ' at tick ' + Game.time);
            return;
        }

        // ═══════════════════════════════════════════════════════
        // ANCHOR FAST-PATH — skip all preamble for confirmed-anchored creeps.
        // Once anchored, source/link IDs and creep position are invariant.
        // We only need two Game.getObjectById calls per tick.
        // Full revalidation (source exists, link exists, position correct)
        // happens every 100 ticks via the hood refresh.
        // ═══════════════════════════════════════════════════════
        var anchor = anchorCache[creep.name];
        if (anchor) {
            var source = Game.getObjectById(anchor.srcId);
            if (anchor.isContainerAnchor) {
                var sourceContainer = Game.getObjectById(anchor.ctnId);
                if (!source || !sourceContainer ||
                    (Game.time % 100 === 0 && (creep.pos.x !== anchor.cx || creep.pos.y !== anchor.cy))) {
                    delete anchorCache[creep.name];
                    // Fall through to full path
                } else {
                    this.runContainerAnchored(creep, source, sourceContainer, state, anchor.cx, anchor.cy);
                    return;
                }
            } else {
                var sourceLink = Game.getObjectById(anchor.lnkId);
                if (!source || !sourceLink || !sourceLink.my ||
                    (Game.time % 100 === 0 && (creep.pos.x !== anchor.cx || creep.pos.y !== anchor.cy))) {
                    delete anchorCache[creep.name];
                } else {
                    this.runAnchored(creep, source, sourceLink, state, anchor.cx, anchor.cy);
                    return;
                }
            }
        }

        // ── Full path: validate source, find link, check positions ──

        if (!creep.memory.sourceId) {
            console.log('[Harvester] ' + creep.name + ' has no sourceId assigned!');
            this.findNearestSource(creep, state);
            return;
        }

        var source = Game.getObjectById(creep.memory.sourceId);
        if (!source) {
            console.log('[Harvester] ' + creep.name + ' assigned source no longer exists!');
            this.findNearestSource(creep, state);
            return;
        }

        // ═══════════════════════════════════════════════════════
        // SOURCE-LINK ANCHOR — first-time detection and walk-in.
        // Once confirmed at anchor position, sets creep._anchor for fast-path.
        // ═══════════════════════════════════════════════════════
        var sourceLink = this.getSourceLink(creep, source, state);

        if (sourceLink) {
            var cx = creep.pos.x, cy = creep.pos.y;
            var dxS = Math.abs(cx - source.pos.x), dyS = Math.abs(cy - source.pos.y);
            var atSource = (dxS <= 1 && dyS <= 1);
            var dxL = Math.abs(cx - sourceLink.pos.x), dyL = Math.abs(cy - sourceLink.pos.y);
            var atLink = (dxL <= 1 && dyL <= 1);

            if (atSource && atLink) {
                // ★ Establish anchor fast-path for all future ticks
                anchorCache[creep.name] = {
                    srcId: source.id,
                    lnkId: sourceLink.id,
                    cx: cx,
                    cy: cy,
                    moveCleared: false
                };
                this.runAnchored(creep, source, sourceLink, state, cx, cy);
                return;
            } else {
                // ── NOT YET ANCHORED ──
                if (!atSource) {
                    if (creep.fatigue === 0) {
                        var move = this.clearIfStuck(creep);
                        creep.moveTo(source, {
                            reusePath: move.reusePath,
                            maxOps: move.maxOps,
                            ignoreCreeps: move.ignoreCreeps
                        });
                    }
                    return;
                }
                // atSource but not atLink — fall through to normal behavior below
            }
        } else {
            // No source link — try container anchor
            var sourceContainer = this.getSourceContainer(creep, source, state);
            if (sourceContainer) {
                if (creep.pos.x === sourceContainer.pos.x && creep.pos.y === sourceContainer.pos.y) {
                    // Standing on the container tile — establish anchor
                    anchorCache[creep.name] = {
                        srcId: source.id,
                        ctnId: sourceContainer.id,
                        isContainerAnchor: true,
                        cx: creep.pos.x,
                        cy: creep.pos.y,
                        moveCleared: false
                    };
                    this.runContainerAnchored(creep, source, sourceContainer, state, creep.pos.x, creep.pos.y);
                    return;
                } else {
                    // If another creep is already standing on the container tile,
                    // the anchor spot is taken — skip the container anchor entirely
                    // and fall through to normal harvesting behavior.
                    var occupants = sourceContainer.pos.lookFor(LOOK_CREEPS);
                    if (occupants.length > 0 && occupants[0].name !== creep.name) {
                        // Fall through to normal behavior below
                    } else {
                        // Walk onto the container tile (range: 0 targets the exact position)
                        if (creep.fatigue === 0) {
                            var move = this.clearIfStuck(creep);
                            creep.moveTo(sourceContainer.pos, { reusePath: move.reusePath, maxOps: move.maxOps, ignoreCreeps: true });
                        }
                        return;
                    }
                }
            }
            // No container either — fall through to normal delivery behavior
        }

        // ═══════════════════════════════════════════════════════
        // NORMAL (non-link) harvester behavior below
        // ═══════════════════════════════════════════════════════

        // Suicide flag if TTL low and source drained (last resort if renewal didn't save us)
        if (creep.ticksToLive <= SUICIDE_TTL_THRESHOLD && source.energy === 0) {
            creep.memory.suicideAfterDelivery = true;
            if (creep.memory.idleUntil) delete creep.memory.idleUntil;
        }

        // Handle pending suicide
        if (creep.memory.suicideAfterDelivery === true) {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                this.deliverEnergy(creep, source, state);
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    creep.say('💀');
                    creep.suicide();
                }
            } else {
                creep.say('💀');
                creep.suicide();
            }
            return;
        }

        // Idle window: 0 intents per tick; break idle early if capacity opens or buffers disappear
        if (creep.memory.idleUntil) {
            if (Game.time < creep.memory.idleUntil) {
                if (!this.shouldIdleAtSource(creep, source, state)) {
                    delete creep.memory.idleUntil;
                } else {
                    return;
                }
            } else {
                delete creep.memory.idleUntil;
            }
        }

        // Consolidated state management using cached used capacity
        const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
        const capEnergy = creep.store.getCapacity(RESOURCE_ENERGY);
        if (usedEnergy === capEnergy) {
            creep.memory.harvesting = false;
        } else if (usedEnergy === 0) {
            creep.memory.harvesting = true;
        }

        // Early exit: fatigued in delivery mode — only adjacent transfers, no movement
        if (creep.fatigue > 0 && !creep.memory.harvesting) {
            if (usedEnergy > 0) {
                this.attemptImmediateTransfer(creep, state);
            }
            return;
        }

        // Main behavior
        if (creep.memory.harvesting) {
            if (source.energy === 0) {
                this.handleDepletedSource(creep, source, state);
                return;
            }

            if (!creep.pos.isNearTo(source)) {
                if (creep.fatigue === 0) {
                    var move = this.clearIfStuck(creep);
                    creep.moveTo(source, {
                        reusePath: move.reusePath,
                        maxOps: move.maxOps,
                        ignoreCreeps: move.ignoreCreeps
                    });
                }
                return;
            }

            // Arrived at source - clear cached path to save memory
            if (creep.memory._move) delete creep.memory._move;

            var result = creep.harvest(source);
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                this.handleDepletedSource(creep, source, state);
            }
        } else {
            this.deliverEnergy(creep, source, state);
        }
    },

// ═══════════════════════════════════════════════════════
    // ANCHORED HARVESTER — extracted from run() for clarity.
    // The creep is adjacent to both source and sourceLink.
    // It never moves. Only interacts with structures in its
    // pre-computed neighborhood (range ≤ 1 from creep).
    //
    // BATCHED TRANSFERS: To avoid wasting an intent (~0.2 CPU)
    // every tick on tiny partial transfers, we only flush energy
    // when: (a) carry is full, (b) source is depleted, or
    // (c) an adjacent spawn needs energy. This cuts transfer
    // intents by ~80-90% on typical bodies.
    // ═══════════════════════════════════════════════════════
    runAnchored: function(creep, source, sourceLink, state, cx, cy) {
        // ── RENEWAL CHECK: leave anchor if needed ──
        if (source.energy === 0 &&
            creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 &&
            creep.ticksToLive < RENEW_TTL_THRESHOLD) {

            var hood = this.getAnchorHood(creep, source, sourceLink, state, cx, cy);

            // Try adjacent spawn first (stay anchored)
            for (var i = 0; i < hood.spawns.length; i++) {
                if (!hood.spawns[i].spawning) {
                    if (creep.memory.suicideAfterDelivery) delete creep.memory.suicideAfterDelivery;
                    hood.spawns[i].renewCreep(creep);
                    creep.say('♻️');
                    return;
                }
            }
            // If there's an adjacent spawn that's just busy spawning, wait at anchor
            if (hood.spawns.length > 0) {
                if (Game.time % 10 === 0) creep.say('♻️⏳');
                return;
            }
            // No adjacent spawn — fall through to normal anchored behavior
        }

        // ── ANCHORED: adjacent to both source and link. Never move. ──
        // Guard _move delete: only read memory once, then set flag in anchor cache
        var anchor = anchorCache[creep.name];
        if (anchor && !anchor.moveCleared) {
            if (creep.memory._move) delete creep.memory._move;
            anchor.moveCleared = true;
        }

        // Build neighborhood (cached per tick, IDs recomputed every 50 ticks)
        var hood = this.getAnchorHood(creep, source, sourceLink, state, cx, cy);

        // Suicide: TTL low, source drained, creep empty (last resort if renewal didn't save us)
        if (creep.ticksToLive <= SUICIDE_TTL_THRESHOLD && source.energy === 0 &&
            creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.suicide();
            return;
        }

        // Harvest if source has energy and we have room
        if (source.energy > 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.harvest(source);
        }

        // ── BATCHED Transfer: only flush when carry full, source empty, or spawn hungry ──
        var usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);

        if (usedEnergy > 0) {
            var carryFull = (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0);
            var sourceDepleted = (source.energy === 0);
            var shouldFlush = carryFull || sourceDepleted;

            // Even if carry isn't full, flush immediately if an adjacent spawn needs energy
            if (!shouldFlush) {
                for (var si = 0; si < hood.spawns.length; si++) {
                    if (hood.spawns[si].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        shouldFlush = true;
                        break;
                    }
                }
            }

            if (shouldFlush) {
                var transferred = false;
                var transferredToContainer = false;

                // Priority 1: adjacent spawns (hood is pre-filtered to range 1)
                for (var si = 0; si < hood.spawns.length; si++) {
                    var sp = hood.spawns[si];
                    if (sp.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        creep.transfer(sp, RESOURCE_ENERGY);
                        transferred = true;
                        break;
                    }
                }

                // Priority 2: repair adjacent containers before feeding the link.
                // repair() and transfer() share the same intent slot, so repairing
                // delays the link fill by one tick — worth it to keep containers healthy.
                // Cap at 240k: containers max at 250k but the last 10k isn't worth the CPU.
                if (!transferred) {
                    for (var ci = 0; ci < hood.containers.length; ci++) {
                        var ct = hood.containers[ci];
                        if (ct.hits < 240000) {
                            creep.repair(ct);
                            transferred = true;
                            break;
                        }
                    }
                }

                // Priority 3: primary source link
                if (!transferred) {
                    if (sourceLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        creep.transfer(sourceLink, RESOURCE_ENERGY);
                        transferred = true;
                    }
                }

                // Priority 4: any other adjacent owned link (already filtered to range 1 + my)
                if (!transferred) {
                    for (var li = 0; li < hood.links.length; li++) {
                        var lk = hood.links[li];
                        if (lk.id === sourceLink.id) continue;
                        if (lk.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                            creep.transfer(lk, RESOURCE_ENERGY);
                            transferred = true;
                            break;
                        }
                    }
                }

                // Priority 5: adjacent containers (last resort overflow)
                if (!transferred) {
                    for (var ci = 0; ci < hood.containers.length; ci++) {
                        var ct = hood.containers[ci];
                        if (ct.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                            creep.transfer(ct, RESOURCE_ENERGY);
                            transferred = true;
                            transferredToContainer = true;
                            break;
                        }
                    }
                }

                // Pipeline: if source is depleted and we just fed a high-priority
                // target (spawn/link), pre-withdraw from an adjacent container so
                // we have energy ready next tick.
                // withdraw() and transfer() are different intent pipelines,
                // so both can execute in the same tick.
                if (source.energy === 0 && transferred && !transferredToContainer) {
                    this.hoodWithdrawContainer(creep, hood);
                }
            }
        }

        // Source depleted, creep empty: shuttle container → spawn/link
        if (source.energy === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            // If any adjacent spawn or link still needs energy,
            // pull from a nearby container to keep them fed.
            if (this.hoodTargetNeedsEnergy(hood, sourceLink)) {
                this.hoodWithdrawContainer(creep, hood);
            }

            // Throttle idle say to every 10 ticks
            if (typeof source.ticksToRegeneration === 'number' && Game.time % 10 === 0) {
                creep.say('⏳' + source.ticksToRegeneration);
            }
        }
    },

    runContainerAnchored: function(creep, source, sourceContainer, state, cx, cy) {
        // If a source link has since been built, break anchor so next tick re-derives.
        // Recheck infrequently: links are built once and rarely change mid-game,
        // and the scan costs a loop through the links array.
        if (Game.time % 200 === 0) {
            if (creep.memory.sourceLinkId === false) delete creep.memory.sourceLinkId;
            var newLink = this.getSourceLink(creep, source, state);
            if (newLink) {
                delete anchorCache[creep.name];
                return;
            }
        }

        // Renewal check — same logic as runAnchored
        if (source.energy === 0 &&
            creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 &&
            creep.ticksToLive < RENEW_TTL_THRESHOLD) {

            var hood = this.getAnchorHood(creep, source, null, state, cx, cy);

            for (var i = 0; i < hood.spawns.length; i++) {
                if (!hood.spawns[i].spawning) {
                    if (creep.memory.suicideAfterDelivery) delete creep.memory.suicideAfterDelivery;
                    hood.spawns[i].renewCreep(creep);
                    creep.say('♻️');
                    return;
                }
            }
            if (hood.spawns.length > 0) {
                if (Game.time % 10 === 0) creep.say('♻️⏳');
                return;
            }
        }

        // Clear cached path once on first anchored tick
        var anchor = anchorCache[creep.name];
        if (anchor && !anchor.moveCleared) {
            if (creep.memory._move) delete creep.memory._move;
            anchor.moveCleared = true;
        }

        // Suicide: TTL low, source drained, carry empty
        if (creep.ticksToLive <= SUICIDE_TTL_THRESHOLD && source.energy === 0 &&
            creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.suicide();
            return;
        }

        // Harvest if possible
        if (source.energy > 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.harvest(source);
        }

        var usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);

        if (usedEnergy > 0) {
            var carryFull   = (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0);
            var sourceDepleted = (source.energy === 0);
            var shouldFlush = carryFull || sourceDepleted;

            var hood = this.getAnchorHood(creep, source, null, state, cx, cy);

            // Also flush immediately if an adjacent spawn is hungry
            if (!shouldFlush) {
                for (var si = 0; si < hood.spawns.length; si++) {
                    if (hood.spawns[si].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        shouldFlush = true;
                        break;
                    }
                }
            }

            if (shouldFlush) {
                var transferred = false;

                // Priority 1: adjacent spawns (urgent — they block colony production)
                for (var si = 0; si < hood.spawns.length; si++) {
                    var sp = hood.spawns[si];
                    if (sp.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        creep.transfer(sp, RESOURCE_ENERGY);
                        transferred = true;
                        break;
                    }
                }

                // Priority 2: repair or deposit into the container we're sitting on.
                // repair() and transfer() share the same intent slot, so we pick one.
                // Repair wins whenever the container is below max health; only deposit
                // once it is fully repaired.
                if (!transferred) {
                    if (sourceContainer.hits < 240000) {
                        creep.repair(sourceContainer);
                    } else if (sourceContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                        creep.transfer(sourceContainer, RESOURCE_ENERGY);
                    }
                }
            }
        }

        // Idle message while waiting on regen
        if (source.energy === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            if (typeof source.ticksToRegeneration === 'number' && Game.time % 10 === 0) {
                creep.say('⏳' + source.ticksToRegeneration);
            }
        }
    },

    // ───────────────────────────────────────────────
    // Anchor neighborhood: structures at range ≤ 1 from the creep.
    // ID sets recomputed every 50 ticks (catches construction/destruction).
    // Live objects resolved once per tick via Game.getObjectById.
    // Typical hood size: 0-4 structures total.
    // ───────────────────────────────────────────────
    getAnchorHood: function(creep, source, sourceLink, state, cx, cy) {
        var anchor = anchorCache[creep.name];
        if (!anchor) return { tick: Game.time, spawns: [], links: [], containers: [] };

        // Per-tick cache hit
        if (anchor.hoodTick === Game.time) {
            return anchor.hood;
        }

        // Recompute ID sets every 50 ticks or on first call
        if (!anchor.ids || (Game.time - anchor.idsAt) >= 50) {
            var byType = state.structuresByType || {};
            var sIds = [], lIds = [], cIds = [];

            var spawns = byType[STRUCTURE_SPAWN] || [];
            for (var i = 0; i < spawns.length; i++) {
                var s = spawns[i];
                if (!s.my) continue;
                if (Math.abs(cx - s.pos.x) <= 1 && Math.abs(cy - s.pos.y) <= 1) {
                    sIds.push(s.id);
                }
            }

            var links = byType[STRUCTURE_LINK] || [];
            for (var i = 0; i < links.length; i++) {
                var s = links[i];
                if (!s.my) continue;
                if (Math.abs(cx - s.pos.x) <= 1 && Math.abs(cy - s.pos.y) <= 1) {
                    lIds.push(s.id);
                }
            }

            var containers = byType[STRUCTURE_CONTAINER] || [];
            for (var i = 0; i < containers.length; i++) {
                var s = containers[i];
                if (Math.abs(cx - s.pos.x) <= 1 && Math.abs(cy - s.pos.y) <= 1) {
                    cIds.push(s.id);
                }
            }

            anchor.ids = { s: sIds, l: lIds, c: cIds };
            anchor.idsAt = Game.time;
        }

        // Resolve live objects once per tick
        var ids = anchor.ids;
        var hood = { spawns: [], links: [], containers: [] };

        for (var i = 0; i < ids.s.length; i++) {
            var o = Game.getObjectById(ids.s[i]);
            if (o) hood.spawns.push(o);
        }
        for (var i = 0; i < ids.l.length; i++) {
            var o = Game.getObjectById(ids.l[i]);
            if (o) hood.links.push(o);
        }
        for (var i = 0; i < ids.c.length; i++) {
            var o = Game.getObjectById(ids.c[i]);
            if (o) hood.containers.push(o);
        }

        anchor.hood = hood;
        anchor.hoodTick = Game.time;
        return hood;
    },

    // ───────────────────────────────────────────────
    // Hood helpers — no range checks needed, hood is pre-filtered.
    // Live objects already resolved, so no Game.getObjectById calls.
    // ───────────────────────────────────────────────

    // Withdraw from the first adjacent container that has energy.
    hoodWithdrawContainer: function(creep, hood) {
        for (var i = 0; i < hood.containers.length; i++) {
            var ct = hood.containers[i];
            if (ct.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                creep.withdraw(ct, RESOURCE_ENERGY);
                return true;
            }
        }
        return false;
    },

    // Check whether any adjacent spawn or link still has free energy capacity.
    hoodTargetNeedsEnergy: function(hood, sourceLink) {
        for (var i = 0; i < hood.spawns.length; i++) {
            if (hood.spawns[i].store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
        }
        if (sourceLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
        for (var i = 0; i < hood.links.length; i++) {
            var lk = hood.links[i];
            if (lk.id === sourceLink.id) continue;
            if (lk.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return true;
        }
        return false;
    },

    // ───────────────────────────────────────────────
    // Stuck detection — heap memory only, never touches creep.memory.
    // Returns { maxOps, reusePath, ignoreCreeps } to control the moveTo call.
    //
    // Normal:           maxOps 200,  reusePath 50, ignoreCreeps false
    // Stuck ≥3 ticks:   maxOps 1500, reusePath 5,  ignoreCreeps false  (route around)
    // Stuck ≥2 repaths: maxOps 1500, reusePath 3,  ignoreCreeps true   (push through)
    // Stuck ≥5 repaths: suicide — the path is permanently blocked
    // ───────────────────────────────────────────────
    clearIfStuck: function(creep) {
        var s = stuckCache[creep.name];
        if (!s) {
            stuckCache[creep.name] = { x: creep.pos.x, y: creep.pos.y, ticks: 0, repaths: 0 };
            return { maxOps: 200, reusePath: 50, ignoreCreeps: false };
        }
        if (creep.pos.x === s.x && creep.pos.y === s.y) {
            s.ticks++;
            if (s.ticks >= 3) {
                delete creep.memory._move;
                s.ticks = 0;
                s.repaths++;

                var ignoreCreeps = s.repaths >= 2;
                // Scale ops with each failed attempt: 1500, 2000, 2500, 3000 … capped at 5000
                var maxOps = Math.min(1500 + (s.repaths - 1) * 500, 5000);
                console.log('[Harvester] ' + creep.name + ' stuck at ' + creep.pos.x + ',' + creep.pos.y +
                    ' — repathing (attempt ' + s.repaths + ', maxOps ' + maxOps +
                    (ignoreCreeps ? ', pushing through' : '') + ')');
                return { maxOps: maxOps, reusePath: 3, ignoreCreeps: ignoreCreeps };
            }
        } else {
            s.x = creep.pos.x;
            s.y = creep.pos.y;
            s.ticks = 0;
            s.repaths = 0;
        }
        return { maxOps: 200, reusePath: 50, ignoreCreeps: false };
    },

    // ───────────────────────────────────────────────
    // Source-link detection: find an owned link within range 2 of the assigned source.
    // Cached in creep.memory.sourceLinkId and per-tick on the creep object.
    // ───────────────────────────────────────────────
    getSourceLink: function(creep, source, state) {
        if (creep._sourceLinkTick === Game.time) {
            return creep._sourceLinkObj || null;
        }
        creep._sourceLinkTick = Game.time;

        if (creep.memory.sourceLinkId === false) {
            creep._sourceLinkObj = null;
            return null;
        }

        if (creep.memory.sourceLinkId) {
            var cached = Game.getObjectById(creep.memory.sourceLinkId);
            if (cached && cached.my) {
                creep._sourceLinkObj = cached;
                return cached;
            }
            delete creep.memory.sourceLinkId;
        }

        var byType = state.structuresByType || {};
        var links = byType[STRUCTURE_LINK] || [];
        var best = null, bestRange = Infinity;

        for (var i = 0; i < links.length; i++) {
            var link = links[i];
            if (!link.my) continue;
            var r = source.pos.getRangeTo(link);
            if (r <= 2 && r < bestRange) {
                best = link;
                bestRange = r;
            }
        }

        if (best) {
            creep.memory.sourceLinkId = best.id;
            creep._sourceLinkObj = best;
            return best;
        }

        // Cache false sentinel — link infrastructure rarely changes
        creep.memory.sourceLinkId = false;
        creep._sourceLinkObj = null;
        return null;
    },

    // ── New: Container-at-source detection (analogous to getSourceLink) ──
    getSourceContainer: function(creep, source, state) {
        if (creep._sourceCtnTick === Game.time) {
            return creep._sourceCtnObj || null;
        }
        creep._sourceCtnTick = Game.time;

        // Don't cache false — containers are commonly placed during RCL 2-3
        // expansion, and we want to detect them promptly on the next tick.
        if (creep.memory.sourceCtnId) {
            var cached = Game.getObjectById(creep.memory.sourceCtnId);
            if (cached) {
                creep._sourceCtnObj = cached;
                return cached;
            }
            delete creep.memory.sourceCtnId;
        }

        var byType = state.structuresByType || {};
        var containers = byType[STRUCTURE_CONTAINER] || [];
        var best = null, bestRange = Infinity;

        for (var i = 0; i < containers.length; i++) {
            var c = containers[i];
            var r = source.pos.getRangeTo(c);
            // Must be range 1 so the creep sitting on it can still harvest
            if (r <= 1 && r < bestRange) {
                best = c;
                bestRange = r;
            }
        }

        if (best) {
            creep.memory.sourceCtnId = best.id;
            creep._sourceCtnObj = best;
            return best;
        }

        // Don't cache false — containers get built during expansion
        creep._sourceCtnObj = null;
        return null;
    },

    // ───────────────────────────────────────────────
    // PWR_REGEN_SOURCE detection
    // ───────────────────────────────────────────────
    hasRegenPower: function(source) {
        if (!source.effects || source.effects.length === 0) return false;
        for (var i = 0; i < source.effects.length; i++) {
            if (source.effects[i].effect === PWR_REGEN_SOURCE) return true;
        }
        return false;
    },

    // ───────────────────────────────────────────────

    handleDepletedSource: function(creep, source, state) {
        if (creep.ticksToLive <= SUICIDE_TTL_THRESHOLD) {
            creep.memory.suicideAfterDelivery = true;
            if (creep.memory.idleUntil) delete creep.memory.idleUntil;
        }

        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            this.deliverEnergy(creep, source, state);
            if (creep.memory.suicideAfterDelivery === true &&
                creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                creep.say('💀');
                creep.suicide();
            }
        } else {
            if (!creep.pos.isNearTo(source)) {
                if (creep.fatigue === 0) {
                    var move = this.clearIfStuck(creep);
                    creep.moveTo(source, {
                        reusePath: move.reusePath,
                        maxOps: move.maxOps,
                        ignoreCreeps: move.ignoreCreeps
                    });
                }
            } else {
                if (creep.memory._move) delete creep.memory._move;
                if (typeof source.ticksToRegeneration === 'number' && Game.time % 10 === 0) {
                    creep.say('⏳' + source.ticksToRegeneration);
                }
            }
        }
    },

    deliverEnergy: function(creep, source, state) {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            delete creep.memory.deliveryId;
            delete creep._deliveryTarget;
            return;
        }

        let target = null;

        if (creep.memory.deliveryId) {
            if (creep._deliveryTarget && creep._deliveryTarget.id === creep.memory.deliveryId) {
                target = creep._deliveryTarget;
            } else {
                target = Game.getObjectById(creep.memory.deliveryId);
                if (target) creep._deliveryTarget = target;
            }

            if (!target || this.freeEnergyCapacity(target) <= 0) {
                target = null;
                delete creep.memory.deliveryId;
                delete creep._deliveryTarget;
            }
        }

        if (!target) {
            target = this.pickDeliveryTargetQuick(creep, state, source);
            if (target) {
                creep.memory.deliveryId = target.id;
                creep._deliveryTarget = target;
            }
        }

        if (target) {
            const tType = target.structureType;
            const isAlreadyHighPri = (creep.pos.getRangeTo(target) <= 1 &&
                (tType === STRUCTURE_SPAWN || tType === STRUCTURE_LINK));
            if (!isAlreadyHighPri) {
                const override = this.findAdjacentHighPriority(creep, state);
                if (override) {
                    target = override;
                    creep.memory.deliveryId = target.id;
                    creep._deliveryTarget = target;
                }
            }
        }

        if (!target) {
            if (creep.pos.isNearTo(source) && this.shouldIdleAtSource(creep, source, state)) {
                this.startIdle(creep);
                return;
            }
            if (!creep.pos.inRangeTo(source, 3) && creep.fatigue === 0) {
                creep.moveTo(source, {
                    reusePath: 50,
                    maxOps: 200,
                    ignoreCreeps: false
                });
            } else if (creep.pos.inRangeTo(source, 3)) {
                if (creep.memory._move) delete creep.memory._move;
            }
            return;
        }

        if (!creep.pos.isNearTo(target)) {
            if (creep.fatigue === 0) {
                creep.moveTo(target, {
                    reusePath: 50,
                    maxOps: 300,
                    ignoreCreeps: false
                });
            }
            return;
        }

        const tr = creep.transfer(target, RESOURCE_ENERGY);
        if (tr === OK) {
            if (this.freeEnergyCapacity(target) <= 0 || creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                delete creep.memory.deliveryId;
                delete creep._deliveryTarget;
                if (creep.memory._move) delete creep.memory._move;
            }
            return;
        }

        if (tr === ERR_FULL || tr === ERR_INVALID_TARGET || tr === ERR_NOT_ENOUGH_RESOURCES) {
            delete creep.memory.deliveryId;
            delete creep._deliveryTarget;
        }
    },

    // Resolve live object via Game.getObjectById to avoid stale store data
    // from the structuresByType cache (which has a 25-tick TTL).
    // Used by the NON-ANCHORED path. Anchored path uses hood live objects directly.
    freeEnergyCapacity: function(s) {
        if (s.structureType === STRUCTURE_POWER_SPAWN) return 0;
        var live = Game.getObjectById(s.id);
        if (!live) return 0;
        if (live.store && typeof live.store.getFreeCapacity === 'function') {
            return live.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        }
        if (live.energyCapacity !== undefined && live.energy !== undefined) {
            return live.energyCapacity - live.energy;
        }
        return 0;
    },

    pickDeliveryTargetQuick: function(creep, state, source) {
        const byType = state.structuresByType || {};
        const containers = byType[STRUCTURE_CONTAINER] || [];
        const links = byType[STRUCTURE_LINK] || [];
        const spawns = byType[STRUCTURE_SPAWN] || [];
        const extensions = byType[STRUCTURE_EXTENSION] || [];

        let best = null, bestRange = Infinity;

        for (let i = 0; i < containers.length; i++) {
            const s = containers[i];
            if (this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r <= 3 && r < bestRange) { best = s; bestRange = r; }
        }
        for (let i = 0; i < links.length; i++) {
            const s = links[i];
            if (s.my && this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r <= 3 && r < bestRange) { best = s; bestRange = r; }
        }
        if (best) return best;

        for (let i = 0; i < spawns.length; i++) {
            const s = spawns[i];
            if (this.freeEnergyCapacity(s) <= 0) continue;
            if (creep.pos.getRangeTo(s) <= 1) return s;
        }

        best = null; bestRange = Infinity;
        for (let i = 0; i < spawns.length; i++) {
            const s = spawns[i];
            if (this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r < bestRange) { best = s; bestRange = r; }
        }
        for (let i = 0; i < extensions.length; i++) {
            const s = extensions[i];
            if (this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r < bestRange) { best = s; bestRange = r; }
        }
        if (best) return best;

        if (state.storage && this.freeEnergyCapacity(state.storage) > 0) {
            return state.storage;
        }

        best = null; bestRange = Infinity;
        for (let i = 0; i < containers.length; i++) {
            const s = containers[i];
            if (this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r < bestRange) { best = s; bestRange = r; }
        }
        return best || null;
    },

    shouldIdleAtSource: function(creep, source, state) {
        if (creep._idleCheckTick === Game.time) {
            return !!creep._idleCheckResult;
        }
        creep._idleCheckTick = Game.time;

        if (!creep.pos.isNearTo(source)) {
            creep._idleCheckResult = false;
            return false;
        }

        const byType = state.structuresByType || {};
        const containers = byType[STRUCTURE_CONTAINER] || [];
        const links = byType[STRUCTURE_LINK] || [];
        const spawns = byType[STRUCTURE_SPAWN] || [];
        const extensions = byType[STRUCTURE_EXTENSION] || [];

        for (let i = 0; i < spawns.length; i++) {
            if (creep.pos.getRangeTo(spawns[i]) <= 1 && this.freeEnergyCapacity(spawns[i]) > 0) {
                creep._idleCheckResult = false;
                return false;
            }
        }
        for (let i = 0; i < extensions.length; i++) {
            if (creep.pos.getRangeTo(extensions[i]) <= 1 && this.freeEnergyCapacity(extensions[i]) > 0) {
                creep._idleCheckResult = false;
                return false;
            }
        }

        let sawAny = false;
        const allBuffers = [];
        for (let i = 0; i < containers.length; i++) allBuffers.push(containers[i]);
        for (let i = 0; i < links.length; i++) {
            const s = links[i];
            if (s.my) allBuffers.push(s);
        }

        for (let i = 0; i < allBuffers.length; i++) {
            const s = allBuffers[i];
            if (creep.pos.getRangeTo(s) > 1) continue;
            sawAny = true;
            if (this.freeEnergyCapacity(s) > 0) {
                creep._idleCheckResult = false;
                return false;
            }
        }

        creep._idleCheckResult = sawAny;
        return sawAny;
    },

    attemptImmediateTransfer: function(creep, state) {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return false;

        if (creep.memory.deliveryId) {
            const t = Game.getObjectById(creep.memory.deliveryId);
            if (t && creep.pos.isNearTo(t) && this.freeEnergyCapacity(t) > 0) {
                const tr = creep.transfer(t, RESOURCE_ENERGY);
                if (tr === OK) return true;
                if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) delete creep.memory.deliveryId;
                return true;
            }
        }

        const byType = state.structuresByType || {};
        const containers = byType[STRUCTURE_CONTAINER] || [];
        const links = byType[STRUCTURE_LINK] || [];
        const spawns = byType[STRUCTURE_SPAWN] || [];
        const extensions = byType[STRUCTURE_EXTENSION] || [];
        const candidates = [];

        for (let i = 0; i < spawns.length; i++) {
            const s = spawns[i];
            if (this.freeEnergyCapacity(s) > 0 && creep.pos.getRangeTo(s) <= 1) candidates.push(s);
        }
        for (let i = 0; i < links.length; i++) {
            const s = links[i];
            if (s.my && this.freeEnergyCapacity(s) > 0 && creep.pos.getRangeTo(s) <= 1) candidates.push(s);
        }
        for (let i = 0; i < containers.length; i++) {
            const s = containers[i];
            if (this.freeEnergyCapacity(s) > 0 && creep.pos.getRangeTo(s) <= 1) candidates.push(s);
        }
        for (let i = 0; i < extensions.length; i++) {
            const s = extensions[i];
            if (this.freeEnergyCapacity(s) > 0 && creep.pos.getRangeTo(s) <= 1) candidates.push(s);
        }
        if (state.storage && this.freeEnergyCapacity(state.storage) > 0 && creep.pos.getRangeTo(state.storage) <= 1) {
            candidates.push(state.storage);
        }

        if (candidates.length === 0) return false;

        const target = candidates[0];
        const tr = creep.transfer(target, RESOURCE_ENERGY);
        if (tr === OK) return true;
        if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
            if (creep.memory.deliveryId && creep.memory.deliveryId === target.id) delete creep.memory.deliveryId;
        }
        return true;
    },

    findAdjacentHighPriority: function(creep, state) {
        const byType = state.structuresByType || {};
        const spawns = byType[STRUCTURE_SPAWN] || [];
        const links = byType[STRUCTURE_LINK] || [];

        for (let i = 0; i < spawns.length; i++) {
            const s = spawns[i];
            if (creep.pos.getRangeTo(s) <= 1 && this.freeEnergyCapacity(s) > 0) return s;
        }
        for (let i = 0; i < links.length; i++) {
            const s = links[i];
            if (s.my && creep.pos.getRangeTo(s) <= 1 && this.freeEnergyCapacity(s) > 0) return s;
        }
        return null;
    },

    startIdle: function(creep) {
        if (!creep.memory.idleUntil || Game.time >= creep.memory.idleUntil) {
            creep.memory.idleUntil = Game.time + 5;
            if (creep.memory._move) delete creep.memory._move;
            creep.say('😴');
        }
    },

    findNearestSource: function(creep, state) {
        var sources = state.sources || [];
        if (sources.length === 0) return;

        var closestSource = creep.pos.findClosestByRange(sources);
        if (closestSource) {
            creep.memory.sourceId = closestSource.id;
            console.log('[Harvester] ' + creep.name + ' assigned to emergency source: ' + closestSource.id);
        }
    }
};

module.exports = roleHarvester;