// roleComboBot.js
// ============================================================================
// ComboBot — Stationary multi-role for 1-source RCL 8 rooms.
var getRoomState = require('getRoomState');

var LINK_FEED_THRESHOLD = 600;
var TERMINAL_LOW = 19000;
var TERMINAL_HIGH = 21000;

var neighborCache = {};
var neighborCacheLastPrune = 0;

// Per-tick caches (reset automatically when Game.time changes)
var _recipeCache = {};
var _factoryOrderCache = { tick: -1 };
var _termNeedCache = { tick: -1 };
var _toStorageCache = { tick: -1 };

function getRecipe(product) {
    if (!product) return null;
    if (_recipeCache[product] !== undefined) return _recipeCache[product];

    var result = null;
    if (typeof COMMODITIES !== 'undefined' && COMMODITIES[product]) {
        var c = COMMODITIES[product];
        var inputs = {};
        var components = c.components || {};
        for (var res in components) {
            if (components.hasOwnProperty(res)) inputs[res] = components[res];
        }
        result = { inputs: inputs, out: c.amount || 1 };
    }
    _recipeCache[product] = result;
    return result;
}

// Fallback lookups when getRoomState is missing structures
function findAdjacentSpawn(creep) {
    var nearSpawns = creep.pos.findInRange(FIND_MY_SPAWNS, 1);
    return nearSpawns.length > 0 ? nearSpawns[0] : null;
}

function findAdjacentMineral(creep) {
    var nearMinerals = creep.pos.findInRange(FIND_MINERALS, 1);
    return nearMinerals.length > 0 ? nearMinerals[0] : null;
}

module.exports = {
    run: function(creep) {
        if (creep.spawning) return;

        // Prune dead entries
        if (Game.time - neighborCacheLastPrune > 200) {
            neighborCacheLastPrune = Game.time;
            for (var name in neighborCache) {
                if (!Game.creeps[name]) delete neighborCache[name];
            }
        }

        var state = getRoomState.get(creep.room.name);
        if (!state) return;

        var hood = this.getNeighbors(creep, state);

        // === BODY TYPE (cached once) ===
        if (creep.memory._hasWork === undefined) {
            var hw = false;
            for (var bp = 0; bp < creep.body.length; bp++) {
                if (creep.body[bp].type === WORK) { hw = true; break; }
            }
            creep.memory._hasWork = hw;
        }
        var hasWorkParts = creep.memory._hasWork;

        // === MINERAL STATUS (with fallback lookup) ===
        var mineral = hood.mineral || findAdjacentMineral(creep);
        var mineralExhausted = false;
        var mineralCooldownHigh = false;
        if (mineral) {
            if (mineral.mineralAmount === 0) {
                mineralExhausted = true;
                if (mineral.ticksToRegeneration === undefined || mineral.ticksToRegeneration >= 300) {
                    mineralCooldownHigh = true;
                }
            }
        }

        // === LIFECYCLE: Mining body suicide when mineral exhausted ===
        if (hasWorkParts && mineralExhausted && mineralCooldownHigh) {
            // Deposit any non-energy resources first
            for (var res in creep.store) {
                if (res === RESOURCE_ENERGY) continue;
                if ((creep.store[res] || 0) <= 0) continue;
                if (hood.factory && hood.factory.store && hood.factory.store.getFreeCapacity() > 0) {
                    creep.transfer(hood.factory, res); return;
                }
                if (hood.terminal && hood.terminal.store && hood.terminal.store.getFreeCapacity() > 0) {
                    creep.transfer(hood.terminal, res); return;
                }
                if (hood.storage && hood.storage.store && hood.storage.store.getFreeCapacity() > 0) {
                    creep.transfer(hood.storage, res); return;
                }
            }
            // Dump energy
            if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                if (hood.storage && hood.storage.store && hood.storage.store.getFreeCapacity() > 0) {
                    creep.transfer(hood.storage, RESOURCE_ENERGY); return;
                }
                if (hood.link && hood.link.store && hood.link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    creep.transfer(hood.link, RESOURCE_ENERGY); return;
                }
            }
            console.log('[ComboBot] ' + creep.name + ' minerals exhausted, suiciding for carry-only respawn');
            creep.suicide();
            return;
        }

        // === LIFECYCLE: Renewal (mining body only, with fallback spawn lookup) ===
        if (hasWorkParts && creep.ticksToLive < 1400) {
            // Skip renewal if mineral will be exhausted within ~200 ticks
            var skipRenew = false;
            if (mineral && mineral.mineralAmount > 0) {
                var workCount = 0;
                for (var wp = 0; wp < creep.body.length; wp++) {
                    if (creep.body[wp].type === WORK && creep.body[wp].hits > 0) workCount++;
                }
                if (workCount > 0) {
                    // Extractor cooldown is 5 ticks, each WORK part harvests 1 per action
                    var ticksToDepletion = (mineral.mineralAmount * 5) / workCount;
                    if (ticksToDepletion <= 200) skipRenew = true;
                }
            }
            if (!skipRenew) {
                var renewSpawn = hood.spawn || findAdjacentSpawn(creep);
                if (renewSpawn && !renewSpawn.spawning) {
                    var renewResult = renewSpawn.renewCreep(creep);
                    if (renewResult === OK) creep.say('♻️');
                }
            }
            // fall through — creep harvests and keeps spawn fed on the same tick
        }
        // Carry-only body: never renews, dies naturally, respawns with correct body

        // ================================================================
        // MAIN LOGIC — identical for both body types
        // ================================================================

        var carrying = creep.store.getUsedCapacity() || 0;
        var carryingEnergy = creep.store[RESOURCE_ENERGY] || 0;
        var freeCapacity = creep.store.getFreeCapacity() || 0;

        var hasTerminal = !!(hood.terminal && hood.terminal.store);
        var hasStorage = !!(hood.storage && hood.storage.store);
        var hasFactory = !!(hood.factory && hood.factory.store);
        var hasLink = !!(hood.link && hood.link.store);

        var linkEnergy = hasLink ? (hood.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;
        var terminalEnergy = hasTerminal ? (hood.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0;

        var factoryOrder = this.getActiveFactoryOrder(creep.room.name);
        var factoryProduct = factoryOrder ? factoryOrder.product : null;

        // === HARVEST (only if work parts AND mineral available) ===
        if (hasWorkParts && mineral && hood.extractor && freeCapacity > 0) {
            if (mineral.mineralAmount > 0 && (!hood.extractor.cooldown || hood.extractor.cooldown === 0)) {
                creep.harvest(mineral);
            }
        }

        // === TRANSFER (one per tick, priority order) ===
        var transferred = false;

        // P1: Spawn needs energy
        if (!transferred && hood.spawn && carryingEnergy > 0) {
            if (hood.spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                creep.transfer(hood.spawn, RESOURCE_ENERGY);
                transferred = true;
            }
        }

        // P2: Extensions need energy
        if (!transferred && carryingEnergy > 0) {
            for (var e = 0; e < hood.extensions.length; e++) {
                if (hood.extensions[e].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    creep.transfer(hood.extensions[e], RESOURCE_ENERGY);
                    transferred = true;
                    break;
                }
            }
        }

        // P2b: Active transfer/toTerminal op — deposit to terminal immediately before P3/P7b can intercept
        if (!transferred && hasTerminal) {
            var termRes = this.getTerminalTransferNeed(creep.room.name);
            if (termRes && (creep.store[termRes] || 0) > 0 && hood.terminal.store.getFreeCapacity() > 0) {
                var p2bAmt = creep.store[termRes] || 0;
                var p2bResult = creep.transfer(hood.terminal, termRes);
                if (p2bResult === OK) {
                    this.recordLocalOpProgress(creep.room.name, 'toTerminal', termRes, p2bAmt);
                }
                transferred = true;
            }
        }

        // P3: Carrying mined mineral — deposit immediately so it doesn't clog carry
        if (!transferred) {
            var mineralType = mineral ? mineral.mineralType : null;
            if (mineralType && (creep.store[mineralType] || 0) > 0) {
                if (hasFactory && factoryOrder) {
                    var recipe = getRecipe(factoryProduct);
                    if (recipe && recipe.inputs[mineralType]) {
                        var factoryHas = hood.factory.store[mineralType] || 0;
                        if (factoryHas < recipe.inputs[mineralType]) {
                            creep.transfer(hood.factory, mineralType);
                            transferred = true;
                        }
                    }
                }
                if (!transferred) {
                    if (hasTerminal && hood.terminal.store.getFreeCapacity() > 0) {
                        creep.transfer(hood.terminal, mineralType);
                        transferred = true;
                    } else if (hasStorage && hood.storage.store.getFreeCapacity() > 0) {
                        creep.transfer(hood.storage, mineralType);
                        transferred = true;
                    }
                }
            }
        }

        // P4: Link below threshold — feed it
        if (!transferred && hasLink && carryingEnergy > 0 && linkEnergy < LINK_FEED_THRESHOLD) {
            creep.transfer(hood.link, RESOURCE_ENERGY);
            transferred = true;
        }

        // P5: Terminal below 19000 — feed it
        if (!transferred && hasTerminal && carryingEnergy > 0 && terminalEnergy < TERMINAL_LOW) {
            creep.transfer(hood.terminal, RESOURCE_ENERGY);
            transferred = true;
        }

        // P6: Factory needs input (active order)
        if (!transferred && hasFactory && factoryOrder) {
            if (this.tryTransferFactoryInput(creep, hood.factory, factoryOrder)) transferred = true;
        }

        // P7: Carrying factory product — deposit to storage (preferred) / terminal
        if (!transferred && hasFactory && factoryProduct && (creep.store[factoryProduct] || 0) > 0) {
            if (hasStorage && hood.storage.store.getFreeCapacity() > 0) {
                creep.transfer(hood.storage, factoryProduct);
                transferred = true;
            } else if (hasTerminal && hood.terminal.store.getFreeCapacity() > 0) {
                creep.transfer(hood.terminal, factoryProduct);
                transferred = true;
            }
        }

        // P7b: No active factory order — dump any leftover factory resources to storage
        if (!transferred && hasFactory && !factoryOrder && hasStorage) {
            for (var fCleanRes in creep.store) {
                if (fCleanRes === RESOURCE_ENERGY) continue;
                if ((creep.store[fCleanRes] || 0) <= 0) continue;
                if (hood.storage.store.getFreeCapacity() > 0) {
                    creep.transfer(hood.storage, fCleanRes);
                    transferred = true;
                    break;
                }
            }
        }

        // P8: toStorage op — deposit carried resource to storage
        if (!transferred && hasStorage) {
            var toStorageInfo = this.getTerminalToStorageNeed(creep.room.name);
            if (toStorageInfo && (creep.store[toStorageInfo.resource] || 0) > 0) {
                if (hood.storage.store.getFreeCapacity() > 0) {
                    var p8Amt = creep.store[toStorageInfo.resource] || 0;
                    var p8Result = creep.transfer(hood.storage, toStorageInfo.resource);
                    if (p8Result === OK) {
                        this.recordLocalOpProgress(creep.room.name, 'toStorage', toStorageInfo.resource, p8Amt);
                    }
                    transferred = true;
                }
            }
        }

        // P9: Dump misc resources to terminal/storage
        if (!transferred && carrying > carryingEnergy && carrying > 0) {
            for (var dumpRes in creep.store) {
                if (dumpRes === RESOURCE_ENERGY) continue;
                if ((creep.store[dumpRes] || 0) <= 0) continue;
                if (hasTerminal && hood.terminal.store.getFreeCapacity() > 0) {
                    creep.transfer(hood.terminal, dumpRes);
                } else if (hasStorage && hood.storage.store.getFreeCapacity() > 0) {
                    creep.transfer(hood.storage, dumpRes);
                }
                transferred = true;
                break;
            }
        }

        // P10: Excess energy — deposit to storage
        if (!transferred && hasStorage && carryingEnergy > 0) {
            if (hood.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                var p10Result = creep.transfer(hood.storage, RESOURCE_ENERGY);
                if (p10Result === OK) {
                    // Credit energy toStorage ops (e.g. autobalance) when W4 drains naturally
                    this.recordLocalOpProgress(creep.room.name, 'toStorage', RESOURCE_ENERGY, carryingEnergy);
                }
                transferred = true;
            }
        }

        // === WITHDRAW (one per tick, priority order) ===
        var withdrawn = false;

        // W1: Spawn/extensions need energy — withdraw from link (targeted amount)
        if (!withdrawn && hasLink && freeCapacity > 0) {
            var spawnNeed = (hood.spawn && hood.spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
                ? hood.spawn.store.getFreeCapacity(RESOURCE_ENERGY) : 0;
            var extNeed = 0;
            for (var we = 0; we < hood.extensions.length; we++) {
                extNeed += hood.extensions[we].store.getFreeCapacity(RESOURCE_ENERGY) || 0;
            }
            if (spawnNeed + extNeed > 0) {
                var linkHas = hood.link.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
                var pullAmount = Math.min(spawnNeed + extNeed, freeCapacity, linkHas);
                if (pullAmount > 0) {
                    creep.withdraw(hood.link, RESOURCE_ENERGY, pullAmount);
                    withdrawn = true;
                }
            }
        }

        // W2: Link has excess energy — drain overflow to storage
        if (!withdrawn && hasLink && freeCapacity > 0 && linkEnergy > LINK_FEED_THRESHOLD) {
            var pullAmt = Math.min(linkEnergy - LINK_FEED_THRESHOLD, freeCapacity);
            if (pullAmt > 0) {
                creep.withdraw(hood.link, RESOURCE_ENERGY, pullAmt);
                withdrawn = true;
            }
        }

        // W3: Link needs energy but storage has it — withdraw from storage
        if (!withdrawn && hasStorage && hasLink && linkEnergy < LINK_FEED_THRESHOLD && freeCapacity > 0) {
            if ((hood.storage.store[RESOURCE_ENERGY] || 0) > 0) {
                creep.withdraw(hood.storage, RESOURCE_ENERGY);
                withdrawn = true;
            }
        }

        // W4: Terminal above 21000 — drain excess (reserve space for link top-off)
        if (!withdrawn && hasTerminal && terminalEnergy > TERMINAL_HIGH && freeCapacity > 0) {
            var excess = terminalEnergy - TERMINAL_HIGH;
            var linkDeficit = (hasLink && linkEnergy < LINK_FEED_THRESHOLD)
                ? LINK_FEED_THRESHOLD - linkEnergy : 0;
            var toWithdraw = Math.min(excess, freeCapacity - linkDeficit);
            if (toWithdraw > 0) {
                creep.withdraw(hood.terminal, RESOURCE_ENERGY, toWithdraw);
                withdrawn = true;
            }
        }

        // W5: Factory has product — evacuate
        if (!withdrawn && hasFactory && factoryProduct && freeCapacity > 0) {
            var productInFactory = hood.factory.store[factoryProduct] || 0;
            if (productInFactory > 0) {
                creep.withdraw(hood.factory, factoryProduct);
                withdrawn = true;
            }
        }

        // W5b: No active factory order — evacuate any leftover resources
        if (!withdrawn && hasFactory && !factoryOrder && freeCapacity > 0) {
            for (var fEvacRes in hood.factory.store) {
                if (fEvacRes === RESOURCE_ENERGY) continue;
                if ((hood.factory.store[fEvacRes] || 0) <= 0) continue;
                creep.withdraw(hood.factory, fEvacRes);
                withdrawn = true;
                break;
            }
        }

        // W6: toStorage op — pull resource from terminal into creep
        if (!withdrawn && hasTerminal && freeCapacity > 0) {
            var toStorageW = this.getTerminalToStorageNeed(creep.room.name);
            if (toStorageW) {
                var termHasW = hood.terminal.store[toStorageW.resource] || 0;
                if (termHasW > 0) {
                    var w6Amt = Math.min(termHasW, freeCapacity, toStorageW.remaining);
                    if (w6Amt > 0) {
                        creep.withdraw(hood.terminal, toStorageW.resource, w6Amt);
                        withdrawn = true;
                    }
                }
            }
        }

        // W7: Transfer op needs resource — withdraw from storage (before energy band fill)
        if (!withdrawn && hasStorage && freeCapacity > 0) {
            var termRes2 = this.getTerminalTransferNeed(creep.room.name);
            if (termRes2 && (hood.storage.store[termRes2] || 0) > 0) {
                creep.withdraw(hood.storage, termRes2);
                withdrawn = true;
            }
        }

        // W8: Need energy for terminal — withdraw from storage
        if (!withdrawn && hasStorage && hasTerminal && terminalEnergy < TERMINAL_LOW && freeCapacity > 0) {
            if ((hood.storage.store[RESOURCE_ENERGY] || 0) > 0) {
                creep.withdraw(hood.storage, RESOURCE_ENERGY);
                withdrawn = true;
            }
        }

        // W9: Factory order needs input — withdraw from terminal/storage
        if (!withdrawn && factoryOrder && hasFactory && freeCapacity > 0) {
            if (this.tryWithdrawFactoryInput(creep, hood, factoryOrder)) withdrawn = true;
        }

        // === IDLE ===
        if (!transferred && !withdrawn) {
            if (Game.time % 20 === 0) creep.say('💤');
        }
    },

    // ============================================================================
    // Factory Helpers (with per-tick cache)
    // ============================================================================

    getActiveFactoryOrder: function(roomName) {
        if (_factoryOrderCache.tick === Game.time && _factoryOrderCache[roomName] !== undefined) {
            return _factoryOrderCache[roomName];
        }
        if (_factoryOrderCache.tick !== Game.time) {
            _factoryOrderCache = { tick: Game.time };
        }

        var orders = Memory.factoryOrders || [];
        var result = null;
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (o && o.room === roomName && o.status === 'active') { result = o; break; }
        }
        _factoryOrderCache[roomName] = result;
        return result;
    },

    tryTransferFactoryInput: function(creep, factory, order) {
        var recipe = getRecipe(order.product);
        if (!recipe || !recipe.inputs) return false;
        for (var res in recipe.inputs) {
            var need = recipe.inputs[res] || 0;
            var factoryHas = factory.store[res] || 0;
            var deficit = need - factoryHas;
            if (deficit <= 0) continue;
            var creepHas = creep.store[res] || 0;
            if (creepHas > 0) {
                creep.transfer(factory, res, Math.min(creepHas, deficit));
                return true;
            }
        }
        return false;
    },

    tryWithdrawFactoryInput: function(creep, hood, order) {
        var recipe = getRecipe(order.product);
        if (!recipe || !recipe.inputs) return false;
        var bestRes = null;
        var bestDeficit = 0;
        for (var res in recipe.inputs) {
            var need = recipe.inputs[res] || 0;
            var factoryHas = hood.factory ? (hood.factory.store[res] || 0) : 0;
            var deficit = need - factoryHas;
            if (deficit > bestDeficit) { bestDeficit = deficit; bestRes = res; }
        }
        if (!bestRes) return false;
        if (hood.terminal && hood.terminal.store && (hood.terminal.store[bestRes] || 0) > 0) {
            creep.withdraw(hood.terminal, bestRes); return true;
        }
        if (hood.storage && hood.storage.store && (hood.storage.store[bestRes] || 0) > 0) {
            creep.withdraw(hood.storage, bestRes); return true;
        }
        return false;
    },

    // ============================================================================
    // Terminal Transfer Helpers (with per-tick cache)
    // ============================================================================

    getTerminalTransferNeed: function(roomName) {
        if (_termNeedCache.tick === Game.time && _termNeedCache[roomName] !== undefined) {
            return _termNeedCache[roomName];
        }
        if (_termNeedCache.tick !== Game.time) {
            _termNeedCache = { tick: Game.time };
        }

        var ops = Memory.terminalManager && Memory.terminalManager.operations
            ? Memory.terminalManager.operations : [];
        var bestRes = null;
        var bestDeficit = 0;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op || op.status === 'completed' || op.status === 'failed') continue;
            if (op.type === 'transfer' && op.fromRoom === roomName) {
                var remaining = Math.max(0, op.amount - (op.amountTransferred || 0));
                if (remaining <= 0) continue;
                var room = Game.rooms[roomName];
                var terminal = room && room.terminal ? room.terminal : null;
                if (!terminal) continue;
                var have = terminal.store[op.resourceType] || 0;
                var deficit = Math.max(0, remaining - have);
                if (deficit > bestDeficit) { bestDeficit = deficit; bestRes = op.resourceType; }
                if (op.resourceType !== RESOURCE_ENERGY && remaining > 0) {
                    var cost = Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                    var termEnergy = terminal.store[RESOURCE_ENERGY] || 0;
                    var eDef = Math.max(0, cost - termEnergy);
                    if (eDef > bestDeficit) { bestDeficit = eDef; bestRes = RESOURCE_ENERGY; }
                }
            }
            if (op.type === 'toTerminal' && op.roomName === roomName) {
                var moved = op.amountMoved || 0;
                var rem = Math.max(0, op.amount - moved);
                if (rem > bestDeficit) { bestDeficit = rem; bestRes = op.resourceType; }
            }
        }
        _termNeedCache[roomName] = bestRes;
        return bestRes;
    },

    // Returns { resource, remaining } for the best active toStorage op, or null.
    // Prefers non-energy resources (no conflict with built-in terminal energy band).
    // Only returns energy when terminal is above TERMINAL_HIGH so W6b doesn't
    // fight P5/W8 which maintain the 19k-21k energy band.
    getTerminalToStorageNeed: function(roomName) {
        if (_toStorageCache.tick === Game.time && _toStorageCache[roomName] !== undefined) {
            return _toStorageCache[roomName];
        }
        if (_toStorageCache.tick !== Game.time) {
            _toStorageCache = { tick: Game.time };
        }

        var ops = Memory.terminalManager && Memory.terminalManager.operations
            ? Memory.terminalManager.operations : [];
        var bestNonEnergy = null;
        var bestNonEnergyRemaining = 0;
        var bestEnergyRemaining = 0;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op || op.status === 'completed' || op.status === 'failed') continue;
            if (op.type === 'toStorage' && op.roomName === roomName) {
                var moved = op.amountMoved || 0;
                var remaining = Math.max(0, op.amount - moved);
                if (remaining <= 0) continue;
                if (op.resourceType === RESOURCE_ENERGY) {
                    if (remaining > bestEnergyRemaining) bestEnergyRemaining = remaining;
                } else {
                    if (remaining > bestNonEnergyRemaining) {
                        bestNonEnergyRemaining = remaining;
                        bestNonEnergy = { resource: op.resourceType, remaining: remaining };
                    }
                }
            }
        }

        var result = null;
        if (bestNonEnergy) {
            // Non-energy ops never conflict with built-in terminal energy management
            result = bestNonEnergy;
        } else if (bestEnergyRemaining > 0) {
            // Only drain energy when terminal has excess above the high threshold;
            // below that, P5/W8 maintain the energy band and W4 handles natural drain
            var room = Game.rooms[roomName];
            var terminal = room && room.terminal ? room.terminal : null;
            var termE = (terminal && terminal.store) ? (terminal.store[RESOURCE_ENERGY] || 0) : 0;
            if (termE > TERMINAL_HIGH) {
                result = { resource: RESOURCE_ENERGY, remaining: bestEnergyRemaining };
            }
        }
        _toStorageCache[roomName] = result;
        return result;
    },

    // Update amountMoved on the first matching active local op (toTerminal or toStorage)
    recordLocalOpProgress: function(roomName, opType, resourceType, amount) {
        var ops = Memory.terminalManager && Memory.terminalManager.operations
            ? Memory.terminalManager.operations : [];
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op || op.status === 'completed' || op.status === 'failed') continue;
            if (op.type === opType && op.roomName === roomName && op.resourceType === resourceType) {
                if (typeof op.amountMoved !== 'number') op.amountMoved = 0;
                op.amountMoved += amount;
                return;
            }
        }
    },

    // ============================================================================
    // Neighbor Cache
    // ============================================================================

    getNeighbors: function(creep, state) {
        var cache = neighborCache[creep.name];

        if (!cache || (Game.time - cache.idsAt) >= 100) {
            var byType = state.structuresByType || {};
            var cx = creep.pos.x;
            var cy = creep.pos.y;

            function isAdj(s) {
                return Math.abs(cx - s.pos.x) <= 1 && Math.abs(cy - s.pos.y) <= 1;
            }

            var ids = {
                spawn: null, link: null, factory: null, terminal: null,
                storage: null, extractor: null, mineral: null, extensions: []
            };

            var spawns = byType[STRUCTURE_SPAWN] || [];
            for (var i = 0; i < spawns.length; i++) {
                if (spawns[i].my && isAdj(spawns[i])) { ids.spawn = spawns[i].id; break; }
            }
            var links = byType[STRUCTURE_LINK] || [];
            for (var i = 0; i < links.length; i++) {
                if (links[i].my && isAdj(links[i])) { ids.link = links[i].id; break; }
            }
            var factories = byType[STRUCTURE_FACTORY] || [];
            for (var i = 0; i < factories.length; i++) {
                if (isAdj(factories[i])) { ids.factory = factories[i].id; break; }
            }
            var terminals = byType[STRUCTURE_TERMINAL] || [];
            for (var i = 0; i < terminals.length; i++) {
                if (isAdj(terminals[i])) { ids.terminal = terminals[i].id; break; }
            }
            if (state.storage && isAdj(state.storage)) {
                ids.storage = state.storage.id;
            }
            var extractors = (byType[STRUCTURE_EXTRACTOR] || []).filter(function(s) { return s.my; });
            for (var i = 0; i < extractors.length; i++) {
                if (isAdj(extractors[i])) { ids.extractor = extractors[i].id; break; }
            }
            var minerals = state.minerals || [];
            for (var i = 0; i < minerals.length; i++) {
                if (isAdj(minerals[i])) { ids.mineral = minerals[i].id; break; }
            }
            var exts = byType[STRUCTURE_EXTENSION] || [];
            for (var i = 0; i < exts.length; i++) {
                if (exts[i].my && isAdj(exts[i])) ids.extensions.push(exts[i].id);
            }

            cache = { ids: ids, idsAt: Game.time };
            neighborCache[creep.name] = cache;
        }

        if (cache.tick === Game.time) return cache.hood;

        var ids = cache.ids;
        var hood = {
            spawn: ids.spawn ? Game.getObjectById(ids.spawn) : null,
            link: ids.link ? Game.getObjectById(ids.link) : null,
            factory: ids.factory ? Game.getObjectById(ids.factory) : null,
            terminal: ids.terminal ? Game.getObjectById(ids.terminal) : null,
            storage: ids.storage ? Game.getObjectById(ids.storage) : null,
            extractor: ids.extractor ? Game.getObjectById(ids.extractor) : null,
            mineral: ids.mineral ? Game.getObjectById(ids.mineral) : null,
            extensions: []
        };
        for (var i = 0; i < ids.extensions.length; i++) {
            var ext = Game.getObjectById(ids.extensions[i]);
            if (ext) hood.extensions.push(ext);
        }

        cache.hood = hood;
        cache.tick = Game.time;
        return hood;
    }
};