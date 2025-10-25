// role.harvester.js
// Purpose: Harvester role that uses getRoomState cache instead of room.find()
// Dependency: getRoomState (see getRoomState.js)
// Intent/CPU notes (from your resources):
// - When an action method returns OK, it schedules an intent (typically ~0.2 CPU), plus engine checks.
// - Not every API method creates an intent; check the API "A" icon/CPU bars.
// - creep.say() does not create an intent.
// - Helpers like moveTo perform pathfinding; the actual intent is move.

const getRoomState = require('getRoomState');
const SUICIDE_TTL_THRESHOLD = 150;

var roleHarvester = {
    run: function(creep) {
        var state = getRoomState.get(creep.room.name);
        if (!state) {
            console.log('[Harvester] ' + creep.name + ' no room state available for ' + creep.room.name + ' at tick ' + Game.time);
            return;
        }

        // Validate source assignment
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

        // Suicide flag if TTL low and source drained
        if (creep.ticksToLive <= SUICIDE_TTL_THRESHOLD && source.energy === 0) {
            creep.memory.suicideAfterDelivery = true;
            if (creep.memory.idleUntil) delete creep.memory.idleUntil;
        }

        // Handle pending suicide
        if (creep.memory.suicideAfterDelivery === true) {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                this.deliverEnergy(creep, source, state);
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    creep.say('💀'); // no intent
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
                    // Idle in place; do nothing (no move/moveTo)
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

        // If we're next to the source and all adjacent (to the creep) buffers are full, start a short idle
        if (creep.pos.isNearTo(source) && this.shouldIdleAtSource(creep, source, state)) {
            this.startIdle(creep);
            return;
        }

        // Early exit optimization:
        // When fatigued and in delivery mode, allow only in-range transfers (no moves/pathing/target searches).
        if (creep.fatigue > 0 && !creep.memory.harvesting) {
            // Try a cheap, immediate adjacent transfer if possible; otherwise do nothing this tick.
            if (usedEnergy > 0) {
                if (this.attemptImmediateTransfer(creep, state)) {
                    // Either transferred or cleared invalid target; nothing else to do while fatigued.
                }
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
                    creep.moveTo(source, {
                        reusePath: 50,
                        // visualizePathStyle: { stroke: '#ffaa00' },
                        maxOps: 200,
                        ignoreCreeps: true
                    });
                }
                return;
            }

            var result = creep.harvest(source);
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                this.handleDepletedSource(creep, source, state);
            }
        } else {
            this.deliverEnergy(creep, source, state);
        }
    },

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
                    creep.moveTo(source, {
                        reusePath: 50,
                        // visualizePathStyle: { stroke: '#ffaa00' },
                        maxOps: 200,
                        ignoreCreeps: true
                    });
                }
            } else if (typeof source.ticksToRegeneration === 'number') {
                creep.say('⏳' + source.ticksToRegeneration);
            }
        }
    },

    // Intent-first: reuse target, avoid transfer when out of range, distance-only selection, high reusePath
    deliverEnergy: function(creep, source, state) {
        // If adjacent to source and all adjacent (to the creep) buffers are full, idle instead of walking energy away
        if (creep.pos.isNearTo(source) && this.shouldIdleAtSource(creep, source, state)) {
            this.startIdle(creep);
            return;
        }

        // Reuse an existing delivery target if it still wants energy
        let target = null;
        if (creep.memory.deliveryId) {
            target = Game.getObjectById(creep.memory.deliveryId);
            if (!target || this.freeEnergyCapacity(target) <= 0) {
                target = null;
                delete creep.memory.deliveryId;
            }
        }

        // Pick a new target only when needed
        if (!target) {
            target = this.pickDeliveryTargetQuick(creep, state, source);
            if (target) {
                creep.memory.deliveryId = target.id;
            }
        }

        // Nothing to deliver to: hover near source cheaply
        if (!target) {
            if (!creep.pos.inRangeTo(source, 3) && creep.fatigue === 0) {
                creep.moveTo(source, {
                    reusePath: 50,
                    // visualizePathStyle: { stroke: '#ffaa00' },
                    maxOps: 200,
                    ignoreCreeps: true
                });
            }
            return;
        }

        // If not in range, just move (do not call transfer yet to avoid extra engine checks)
        if (!creep.pos.isNearTo(target)) {
            if (creep.fatigue === 0) {
                creep.moveTo(target, {
                    reusePath: 50,
                    // visualizePathStyle: { stroke: '#ffffff' },
                    maxOps: 300,
                    ignoreCreeps: true
                });
            }
            return;
        }

        // In range: transfer once
        const tr = creep.transfer(target, RESOURCE_ENERGY);
        if (tr === OK) {
            if (this.freeEnergyCapacity(target) <= 0 || creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                delete creep.memory.deliveryId;
            }
            return;
        }

        // Target rejected energy; clear and retry next tick
        if (tr === ERR_FULL || tr === ERR_INVALID_TARGET || tr === ERR_NOT_ENOUGH_RESOURCES) {
            delete creep.memory.deliveryId;
        }
    },

    // Numeric free energy capacity across different structure types (store vs legacy)
    freeEnergyCapacity: function(s) {
        if (s.store && typeof s.store.getFreeCapacity === 'function') {
            return s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        }
        if (s.energyCapacity !== undefined && s.energy !== undefined) {
            return s.energyCapacity - s.energy;
        }
        return 0;
    },

    // Fast, distance-only picker that mirrors your priorities, no pathfinding
    pickDeliveryTargetQuick: function(creep, state, source) {
        const byType = state.structuresByType || {};
        const containers = byType[STRUCTURE_CONTAINER] || [];
        const links = byType[STRUCTURE_LINK] || [];
        const spawns = byType[STRUCTURE_SPAWN] || [];
        const extensions = byType[STRUCTURE_EXTENSION] || [];

        // Priority 1: buffer within 3 (containers/links)
        let best = null, bestRange = Infinity;

        for (let i = 0; i < containers.length; i++) {
            const s = containers[i];
            if (this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r <= 3 && r < bestRange) { best = s; bestRange = r; }
        }
        for (let i = 0; i < links.length; i++) {
            const s = links[i];
            if (!s.my) continue;
            if (this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r <= 3 && r < bestRange) { best = s; bestRange = r; }
        }
        if (best) return best;

        // Priority 2: spawns/extensions needing energy (closest by range)
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

        // Priority 3: storage (if it wants energy)
        if (state.storage && this.freeEnergyCapacity(state.storage) > 0) {
            return state.storage;
        }

        // Priority 4: any container with space (closest by range)
        best = null; bestRange = Infinity;
        for (let i = 0; i < containers.length; i++) {
            const s = containers[i];
            if (this.freeEnergyCapacity(s) <= 0) continue;
            const r = creep.pos.getRangeTo(s);
            if (r < bestRange) { best = s; bestRange = r; }
        }
        return best || null;
    },

    // Optimized and corrected:
    // - Check buffers within range 1 of the CREEP (not the source).
    // - Return true (idle) only if: creep is near the source AND at least one adjacent buffer exists AND all such buffers are full.
    // - Per-tick cache on the creep object to avoid duplicate work.
    shouldIdleAtSource: function(creep, source, state) {
        if (creep._idleCheckTick === Game.time) return !!creep._idleCheckResult;

        if (!creep.pos.isNearTo(source)) {
            creep._idleCheckTick = Game.time;
            creep._idleCheckResult = false;
            return false;
        }

        const byType = state.structuresByType || {};
        const containers = byType[STRUCTURE_CONTAINER] || [];
        const links = byType[STRUCTURE_LINK] || [];

        let sawAny = false;

        // Single loop combining both structure types
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
                creep._idleCheckTick = Game.time;
                creep._idleCheckResult = false;
                return false;
            }
        }

        const result = sawAny;
        creep._idleCheckTick = Game.time;
        creep._idleCheckResult = result;
        return result;
    },

    // Try a single, in-range transfer to any adjacent structure that can accept energy.
    // Returns true if we attempted a transfer (success or clear), false otherwise.
    attemptImmediateTransfer: function(creep, state) {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return false;

        // Reuse current target if it is adjacent and wants energy
        if (creep.memory.deliveryId) {
            const t = Game.getObjectById(creep.memory.deliveryId);
            if (t && creep.pos.isNearTo(t) && this.freeEnergyCapacity(t) > 0) {
                const tr = creep.transfer(t, RESOURCE_ENERGY);
                if (tr === OK) return true;
                if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) delete creep.memory.deliveryId;
                return true; // attempted
            }
        }

        const byType = state.structuresByType || {};
        const containers = byType[STRUCTURE_CONTAINER] || [];
        const links = byType[STRUCTURE_LINK] || [];
        const spawns = byType[STRUCTURE_SPAWN] || [];
        const extensions = byType[STRUCTURE_EXTENSION] || [];
        const candidates = [];

        // Priority: buffers first (adjacent), then spawns/extensions (adjacent), then storage (adjacent)
        for (let i = 0; i < containers.length; i++) {
            const s = containers[i];
            if (this.freeEnergyCapacity(s) > 0 && creep.pos.getRangeTo(s) <= 1) candidates.push(s);
        }
        for (let i = 0; i < links.length; i++) {
            const s = links[i];
            if (s.my && this.freeEnergyCapacity(s) > 0 && creep.pos.getRangeTo(s) <= 1) candidates.push(s);
        }
        for (let i = 0; i < spawns.length; i++) {
            const s = spawns[i];
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

        // Choose the first candidate (all are adjacent; picking order already reflects priority)
        const target = candidates[0];
        const tr = creep.transfer(target, RESOURCE_ENERGY);
        if (tr === OK) return true;
        if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
            if (creep.memory.deliveryId && creep.memory.deliveryId === target.id) delete creep.memory.deliveryId;
        }
        return true; // attempted
    },

    startIdle: function(creep) {
        if (!creep.memory.idleUntil || Game.time >= creep.memory.idleUntil) {
            creep.memory.idleUntil = Game.time + 5; // 5 ticks
            creep.say('😴'); // say once on idle start; no intent cost
        }
    },

    findNearestSource: function(creep, state) {
        // Emergency fallback - find closest source from cached state (range-only to avoid pathfinding cost)
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
