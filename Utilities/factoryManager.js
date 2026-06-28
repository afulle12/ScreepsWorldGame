// factoryManager.js
// ============================================================================
// FIFO per room factory order manager. Refuses orders unless full resources
// are present in the room (storage + terminal only). Orders in different
// rooms run concurrently.
//
// The supplier handles logistics (loading inputs, evacuating outputs).
// This manager handles production calls (factory.produce) and order lifecycle.
//
// getRecipe() falls back to the game's COMMODITIES constant for any product
// not in the hardcoded RECIPES table.
//
// Supports both compression (minerals -> bars) and decompression (bars -> minerals).
// ============================================================================
//
// CONSOLE COMMANDS
// ============================================================================
//
// orderFactory(roomName, product, amount)
//   Place a factory production order.
//   Orders are FIFO per room — a new order for the same room queues
//   behind any in-progress order. Refuses immediately if the room
//   lacks sufficient resources for the full order amount.
//   Examples:
//     orderFactory('W1N1', 'Oxidant', 1000)
//     orderFactory('W1N1', 'Zynthium bar', 500)   // queues after Oxidant
//     orderFactory('W2N3', RESOURCE_WIRE, 'max')   // concurrent in W2N3
//     orderFactory('W1N1', RESOURCE_ENERGY, 5000)  // batteries → energy
//     orderFactory('W1N1', 'Utrium', 1000)         // utrium bars → utrium
//     orderFactory('W1N1', RESOURCE_UTRIUM, 'max') // decompress max utrium bars
//
// ────────────────────────────────────────────────────────────
//
// cancelFactoryOrder(idOrRoom, product?)
//   Cancel one or more orders.
//
//   Examples:
//     cancelFactoryOrder('W1N1_XO_1234567')        // cancel by exact ID
//     cancelFactoryOrder('W1N1')                   // cancel all W1N1 orders
//     cancelFactoryOrder('W1N1', 'Oxidant')        // cancel W1N1 Oxidant only
//
// listFactoryOrders(roomName?)
//   Examples:
//     listFactoryOrders()          // all rooms
//     listFactoryOrders('W1N1')    // W1N1 only
//     factoryOrders('W1N1')        // backward-compatible alias
//
// ============================================================================

var storageManager = require('storageManager');
var getRoomState = require('getRoomState');

// ─── storageManager v2 feature flag ──────────────────────────────────────────
// Enabled for every owned room.
function v2Enabled(roomName) {
    var room = Game.rooms[roomName];
    return !!(room && room.controller && room.controller.my);
}

var FACTORY_BROKEN_ORDER_TICKS = 20000;

// Returns the amount of `resourceType` in room that is unreserved and
// physically present. When v2 is disabled for the room, returns raw countInRoom.
function effectiveAvailable(room, resourceType) {
    var raw = countInRoom(room, resourceType);
    if (!v2Enabled(room.name)) return raw;
    var info = storageManager.storageFind(room.name, resourceType);
    var factory = findFactory(room);
    if (factory && factory.store && (factory.store[resourceType] || 0) > 0) {
        raw = Math.max(0, raw - (factory.store[resourceType] || 0));
    }
    if (info && info.combined && typeof info.combined.reserved === 'number') {
        return Math.max(0, raw - info.combined.reserved);
    }
    return raw;
}

// Releases all v2 reservations associated with a given order's inputs.
function releaseOrderReservations(order) {
    if (!order || !order.reservationProgram) return;
    var recipe = getRecipe(order.product);
    if (!recipe) return;
    for (var r in recipe.inputs) {
        storageManager.unReserve(order.room, r, 'terminal', order.reservationProgram);
        storageManager.unReserve(order.room, r, 'storage',  order.reservationProgram);
    }
}

// ─── Recipes (cooldown included for bot sleep calculation) ───────────────────

const RECIPES = Object.freeze({
    // ── Compression (minerals → bars, any level factory) ────────────────────
    [RESOURCE_OXIDANT]:       { inputs: { [RESOURCE_OXYGEN]: 500,   [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_REDUCTANT]:     { inputs: { [RESOURCE_HYDROGEN]: 500, [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_ZYNTHIUM_BAR]:  { inputs: { [RESOURCE_ZYNTHIUM]: 500, [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_LEMERGIUM_BAR]: { inputs: { [RESOURCE_LEMERGIUM]: 500,[RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_UTRIUM_BAR]:    { inputs: { [RESOURCE_UTRIUM]: 500,   [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_KEANIUM_BAR]:   { inputs: { [RESOURCE_KEANIUM]: 500,  [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_GHODIUM_MELT]:  { inputs: { [RESOURCE_GHODIUM]: 500,  [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_PURIFIER]:      { inputs: { [RESOURCE_CATALYST]: 500, [RESOURCE_ENERGY]: 200 }, out: 100, cooldown: 20 },
    [RESOURCE_BATTERY]:       { inputs: { [RESOURCE_ENERGY]: 600  }, out: 50,  cooldown: 10 },

    // ── Decompression (bars → minerals, any level factory) ──────────────────
    [RESOURCE_UTRIUM]:        { inputs: { [RESOURCE_UTRIUM_BAR]: 100,    [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    [RESOURCE_LEMERGIUM]:     { inputs: { [RESOURCE_LEMERGIUM_BAR]: 100, [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    [RESOURCE_ZYNTHIUM]:      { inputs: { [RESOURCE_ZYNTHIUM_BAR]: 100,  [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    [RESOURCE_KEANIUM]:       { inputs: { [RESOURCE_KEANIUM_BAR]: 100,   [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    [RESOURCE_GHODIUM]:       { inputs: { [RESOURCE_GHODIUM_MELT]: 100,  [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    [RESOURCE_OXYGEN]:        { inputs: { [RESOURCE_OXIDANT]: 100,       [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    [RESOURCE_HYDROGEN]:      { inputs: { [RESOURCE_REDUCTANT]: 100,     [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    [RESOURCE_CATALYST]:      { inputs: { [RESOURCE_PURIFIER]: 100,      [RESOURCE_ENERGY]: 200 }, out: 500, cooldown: 20 },
    // battery → energy (no energy cost, cooldown 10)
    [RESOURCE_ENERGY]:        { inputs: { [RESOURCE_BATTERY]: 50 },                                out: 500, cooldown: 10 },

    // ── Basic regional commodities (cooldown 8) ──────────────────────────────
    [RESOURCE_WIRE]:         { inputs: { [RESOURCE_UTRIUM_BAR]: 20,    [RESOURCE_SILICON]: 100, [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 },
    [RESOURCE_CELL]:         { inputs: { [RESOURCE_LEMERGIUM_BAR]: 20, [RESOURCE_BIOMASS]: 100, [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 },
    [RESOURCE_ALLOY]:        { inputs: { [RESOURCE_ZYNTHIUM_BAR]: 20,  [RESOURCE_METAL]: 100,   [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 },
    [RESOURCE_CONDENSATE]:   { inputs: { [RESOURCE_KEANIUM_BAR]: 20,   [RESOURCE_MIST]: 100,    [RESOURCE_ENERGY]: 40 }, out: 20, cooldown: 8 },

    // ── Common higher commodities ────────────────────────────────────────────
    [RESOURCE_COMPOSITE]: { level: 1, inputs: { [RESOURCE_UTRIUM_BAR]: 20, [RESOURCE_ZYNTHIUM_BAR]: 20, [RESOURCE_ENERGY]: 20 }, out: 20, cooldown: 50 },
    [RESOURCE_CRYSTAL]:   { level: 2, inputs: { [RESOURCE_LEMERGIUM_BAR]: 6, [RESOURCE_KEANIUM_BAR]: 6, [RESOURCE_PURIFIER]: 6, [RESOURCE_ENERGY]: 45 }, out: 6, cooldown: 21 },
    [RESOURCE_LIQUID]:    { level: 3, inputs: { [RESOURCE_OXIDANT]: 12, [RESOURCE_REDUCTANT]: 12, [RESOURCE_GHODIUM_MELT]: 12, [RESOURCE_ENERGY]: 90 }, out: 12, cooldown: 60 }
});

/**
 * Get the recipe for a product. Checks the hardcoded RECIPES first, then
 * falls back to the game's COMMODITIES constant.
 */
function getRecipe(product) {
    if (RECIPES[product]) return RECIPES[product];
    if (typeof COMMODITIES !== 'undefined' && COMMODITIES[product]) {
        var c = COMMODITIES[product];
        return {
            inputs: c.components || {},
            out: c.amount || 1,
            level: typeof c.level === 'number' ? c.level : undefined,
            cooldown: c.cooldown || 20
        };
    }
    return null;
}

function ensureMemory() {
    if (!Memory.factoryOrders) Memory.factoryOrders = [];
    if (!Array.isArray(Memory.factoryOrderHistory)) Memory.factoryOrderHistory = [];
}

function recordCompletedOrder(order) {
    ensureMemory();
    if (!order) return;
    Memory.factoryOrderHistory.push({
        id: order.id,
        room: order.room,
        product: order.product,
        requested: order.requested,
        progressOut: order.progressOut || 0,
        completedTick: Game.time
    });
    if (Memory.factoryOrderHistory.length > 50) {
        Memory.factoryOrderHistory = Memory.factoryOrderHistory.slice(-50);
    }
}

function findFactory(room) {
    if (!room) return null;
    var rs = getRoomState.get(room.name);
    var arr = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_FACTORY]) || [];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].my) return arr[i];
    }
    return null;
}

function roomOwned(room) {
    return !!(room && room.controller && room.controller.my);
}

/**
 * Count a resource in storage + terminal + factory only.
 * Containers are excluded — factory orders only interact with these three.
 */
function countInRoom(room, resourceType) {
    var total = 0;
    function add(s) { if (s && s.store) total += s.store[resourceType] || 0; }

    add(room.storage);
    add(room.terminal);
    add(findFactory(room));

    return total;
}

function normalizeProduct(p) {
    if (p && (RECIPES[p] || (typeof COMMODITIES !== 'undefined' && COMMODITIES[p]))) return p;
    if (typeof p === 'string') {
        var s = p.trim().toUpperCase();
        var map = {
            // Energy
            ENERGY:             RESOURCE_ENERGY,
            RESOURCE_ENERGY:    RESOURCE_ENERGY,

            // Compression outputs (bars)
            OXIDANT:            RESOURCE_OXIDANT,
            REDUCTANT:          RESOURCE_REDUCTANT,
            'ZYNTHIUM BAR':     RESOURCE_ZYNTHIUM_BAR,  ZYNTHIUM_BAR:     RESOURCE_ZYNTHIUM_BAR,
            'LEMERGIUM BAR':    RESOURCE_LEMERGIUM_BAR, LEMERGIUM_BAR:    RESOURCE_LEMERGIUM_BAR,
            'UTRIUM BAR':       RESOURCE_UTRIUM_BAR,    UTRIUM_BAR:       RESOURCE_UTRIUM_BAR,
            'KEANIUM BAR':      RESOURCE_KEANIUM_BAR,   KEANIUM_BAR:      RESOURCE_KEANIUM_BAR,
            'GHODIUM MELT':     RESOURCE_GHODIUM_MELT,  GHODIUM_MELT:     RESOURCE_GHODIUM_MELT,
            PURIFIER:           RESOURCE_PURIFIER,
            BATTERY:            RESOURCE_BATTERY,

            // Decompression outputs (raw minerals)
            UTRIUM:             RESOURCE_UTRIUM,
            LEMERGIUM:          RESOURCE_LEMERGIUM,
            ZYNTHIUM:           RESOURCE_ZYNTHIUM,
            KEANIUM:            RESOURCE_KEANIUM,
            GHODIUM:            RESOURCE_GHODIUM,
            OXYGEN:             RESOURCE_OXYGEN,
            HYDROGEN:           RESOURCE_HYDROGEN,
            CATALYST:           RESOURCE_CATALYST,

            // Basic regional commodities
            WIRE:               RESOURCE_WIRE,
            CELL:               RESOURCE_CELL,
            ALLOY:              RESOURCE_ALLOY,
            CONDENSATE:         RESOURCE_CONDENSATE,

            // Common higher commodities
            COMPOSITE:          RESOURCE_COMPOSITE,
            CRYSTAL:            RESOURCE_CRYSTAL,
            LIQUID:             RESOURCE_LIQUID
        };
        if (map[s]) return map[s];
        if (global[s]) return global[s];
    }
    return null;
}

function batchesFor(amount, recipe) { return Math.ceil(amount / recipe.out); }

function enoughForOneBatchInFactory(factory, product) {
    var rec = getRecipe(product);
    if (!rec) return false;

    if (rec.level) {
        if ((factory.level || 0) < rec.level) return false;

        // factory.level persists after the effect expires — check the effect is live
        var hasEffect = false;
        if (factory.effects) {
            for (var i = 0; i < factory.effects.length; i++) {
                if (factory.effects[i].effect === PWR_OPERATE_FACTORY) {
                    hasEffect = true;
                    break;
                }
            }
        }
        if (!hasEffect) return false;
    }

    for (var res in rec.inputs) {
        var need = rec.inputs[res] || 0;
        var have = (factory.store && factory.store[res]) || 0;
        if (have < need) return false;
    }
    return true;
}

function recipeInputTotal(recipe) {
    var total = 0;
    if (!recipe || !recipe.inputs) return total;
    for (var res in recipe.inputs) total += recipe.inputs[res] || 0;
    return total;
}

function factoryCapacity(factory) {
    if (!factory || !factory.store || typeof factory.store.getCapacity !== 'function') return 0;
    return factory.store.getCapacity() || 0;
}

function remainingBatchesForOrder(order, recipe) {
    if (!order || !recipe) return 0;
    return Math.ceil(Math.max(0, (order.requested || 0) - (order.progressOut || 0)) / Math.max(1, recipe.out || 1));
}

function maxBatchesPerCycle(factory, recipe, remainingBatches) {
    var cap = factoryCapacity(factory);
    var perBatchIn = recipeInputTotal(recipe);
    var perBatchOut = recipe ? (recipe.out || 0) : 0;
    if (cap <= 0 || perBatchIn <= 0 || perBatchOut <= 0) return 0;

    // Inputs are loaded before the first produce call, so reserve enough free
    // capacity for one output batch or a full input load can deadlock ERR_FULL.
    if (perBatchIn + perBatchOut > cap) return 0;
    var batches = Math.floor((cap - perBatchOut) / perBatchIn);
    if (remainingBatches != null) batches = Math.min(batches, remainingBatches);
    return batches;
}

function factoryHasNonInputStock(factory, recipe, product) {
    if (!factory || !factory.store) return false;
    var inputs = (recipe && recipe.inputs) ? recipe.inputs : {};
    for (var res in factory.store) {
        if ((factory.store[res] || 0) <= 0) continue;
        if (res === product) continue;
        if (inputs[res] !== undefined && inputs[res] > 0) continue;
        return true;
    }
    return false;
}

function factoryHasAnyStock(factory) {
    if (!factory || !factory.store) return false;
    for (var res in factory.store) {
        if ((factory.store[res] || 0) > 0) return true;
    }
    return false;
}

function prepareCycle(order, factory, recipe) {
    var remaining = remainingBatchesForOrder(order, recipe);
    if (remaining <= 0) return false;

    var cycleBatches = maxBatchesPerCycle(factory, recipe, remaining);
    if (cycleBatches <= 0) return false;

    order.phase = 'loading';
    order.cycleBatches = cycleBatches;
    order.cycleBatchesQueued = 0;
    order.cycleOutputTarget = cycleBatches * (recipe.out || 1);
    order.cycleStartedTick = Game.time;
    order.lastProgressTick = Game.time;
    return true;
}

function resizeCycleToFit(order, factory, recipe) {
    if (!order || !order.cycleBatches) return;
    var remaining = remainingBatchesForOrder(order, recipe);
    var cycleBatches = maxBatchesPerCycle(factory, recipe, remaining);
    if (cycleBatches <= 0 || cycleBatches >= order.cycleBatches) return;

    order.cycleBatches = cycleBatches;
    order.cycleOutputTarget = cycleBatches * (recipe.out || 1);
    if ((order.cycleBatchesQueued || 0) > cycleBatches) {
        order.cycleBatchesQueued = cycleBatches;
    }
}

function cycleInputsLoaded(factory, order, recipe) {
    if (!factory || !factory.store || !order || !recipe) return false;
    if (!order.cycleBatches) return false;
    if (factoryHasNonInputStock(factory, recipe, order.product)) return false;
    for (var res in recipe.inputs) {
        var need = (recipe.inputs[res] || 0) * order.cycleBatches;
        var have = factory.store[res] || 0;
        if (have < need) return false;
    }
    if (factory.store.getFreeCapacity && (factory.store.getFreeCapacity() || 0) < (recipe.out || 0)) return false;
    return true;
}

function tryProduce(factory, order) {
    if (!factory || factory.cooldown) return false;
    if (!enoughForOneBatchInFactory(factory, order.product)) return false;
    var res = factory.produce(order.product);
    if (res === OK) {
        var recipe = getRecipe(order.product);
        order.cycleBatchesQueued = (order.cycleBatchesQueued || 0) + 1;
        order.progressOut = (order.progressOut || 0) + (recipe ? recipe.out : 1);
        order.lastProduceTick = Game.time;
        order.lastProgressTick = Game.time;
        return true;
    }
    // Log unexpected failures — enoughForOneBatch passed but produce failed
    if (Game.time % 10 === 0) {
        console.log('[Factory] produce() failed for ' + order.product
            + ' in ' + order.room + ': ' + res
            + ' (cooldown=' + factory.cooldown + ', level=' + (factory.level || 0) + ')');
    }
    return false;
}

function markBrokenOrder(order, reason) {
    if (!order) return;
    order.broken = true;
    order.brokenReason = reason || 'stuck';
    order.phase = 'unloading';
    order.lastProgressTick = Game.time;
    releaseOrderReservations(order);
    console.log('[Factory] BROKEN order ' + order.id + ' in ' + order.room + ': ' + order.brokenReason);
}

function markActivePerRoom() {
    var byRoom = _.groupBy(Memory.factoryOrders, function(o) { return o.room; });
    for (var roomName in byRoom) {
        var activated = false;
        var list = byRoom[roomName];
        for (var i = 0; i < list.length; i++) {
            var order = list[i];
            if (order.status === 'done' || order.status === 'cancelled') continue;
            if (!activated) {
                if (order.status !== 'active') order.status = 'active';
                activated = true;
            } else {
                if (order.status !== 'queued') order.status = 'queued';
            }
        }
    }
}

/**
 * Returns true if a supplier is actively working on a factory task for this
 * room. Used to prevent the auto-complete race condition where inputs in the
 * supplier's carry are invisible to countInRoom.
 */
function supplierActiveForRoom(roomName) {
    return _.some(Game.creeps, function(c) {
        if (!c.memory || c.memory.role !== 'supplier') return false;
        if (c.memory.homeRoom !== roomName) return false;
        if (!c.memory.a) return false;
        return c.memory.a.indexOf('factory_input|') === 0
            || c.memory.a.indexOf('factory_output|') === 0
            || c.memory.a.indexOf('factory_drain|') === 0;
    });
}

function orderSummary(order) {
    return '[#' + order.id + '] ' + order.room + ' -> ' + order.product
        + ' | requested: ' + order.requested
        + ', producedOut: ' + (order.progressOut || 0)
        + ', phase: ' + (order.phase || 'unknown')
        + ', status: ' + order.status;
}

function maxBatchesForRoom(room, recipe) {
    var minBatches = Infinity;
    for (var res in recipe.inputs) {
        var perBatch = recipe.inputs[res] || 0;
        if (perBatch <= 0) continue;
        var have = effectiveAvailable(room, res);
        var possible = Math.floor(have / perBatch);
        if (possible < minBatches) minBatches = possible;
    }
    if (minBatches === Infinity) return 0;
    return minBatches;
}

function maxAmountForRoom(room, recipe) {
    var batches = maxBatchesForRoom(room, recipe);
    return batches * recipe.out;
}

// ─── Console commands ────────────────────────────────────────────────────────

global.orderFactory = function(roomName, productLike, amount) {
    ensureMemory();
    if (amount === undefined) amount = 100;

    var room = Game.rooms[roomName];
    if (!room || !roomOwned(room)) return '[Factory] Invalid or not-owned room: ' + roomName;

    var product = normalizeProduct(productLike);
    var recipe  = product ? getRecipe(product) : null;
    if (!recipe) return '[Factory] Unknown or unsupported product: ' + productLike;

    var factory = findFactory(room);
    if (!factory) return '[Factory] No Factory in ' + roomName + '. Build one at RCL7.';

    if (recipe.level && (factory.level || 0) < recipe.level) {
        return '[Factory] REFUSED: Factory level ' + (factory.level || 0) + ' in ' + roomName
            + ' is insufficient for ' + product + ' (requires level ' + recipe.level + ').';
    }

    var peakPerBatch = Math.max(recipeInputTotal(recipe), recipe.out || 0);
    if (factoryCapacity(factory) < peakPerBatch) {
        return '[Factory] REFUSED: Factory capacity in ' + roomName + ' is too small for one batch of ' + product;
    }

    var batches;
    var isMax = (typeof amount === 'string') && (amount.trim().toLowerCase() === 'max');
    if (isMax) {
        batches = maxBatchesForRoom(room, recipe);
        if (batches <= 0) {
            return '[Factory] REFUSED: Not enough inputs in ' + roomName
                + ' for one batch of ' + product;
        }
        amount = batches * recipe.out;
    } else {
        batches = batchesFor(amount, recipe);
    }

    var needMap = {};
    for (var res in recipe.inputs) needMap[res] = (recipe.inputs[res] || 0) * batches;

    var missing = [];
    for (var r in needMap) {
        var have = countInRoom(room, r);
        var need = needMap[r];
        if (have < need) missing.push(r + ' ' + have + '/' + need);
    }
    if (missing.length > 0) {
        return '[Factory] REFUSED: Missing inputs in ' + roomName + ' -> ' + missing.join(', ');
    }

    var id = roomName + '_' + product + '_' + Game.time;
    var order = {
        id: id, room: roomName, product: product, requested: amount,
        status: 'queued', created: Game.time,
        phase: 'loading',
        cycleBatches: 0, cycleBatchesQueued: 0, cycleOutputTarget: 0,
        progressOut: 0, lastProduceTick: 0, lastProgressTick: 0
    };

    // ── storageManager v2: reserve inputs against this order ───────────────
    // Each order gets a unique program name (including order id). This prevents
    // a queued order from replacing an active order's reservation and vice versa.
    // The memory cost is small (~60 bytes per reservation) and guarantees that
    // queued orders that eventually become active still hold their reservations.
    if (v2Enabled(roomName)) {
        order.reservationProgram = 'factoryManager_' + product + '_' + id + '_' + Math.random().toString(36).substr(2, 6);
        var reservedKeys = [];
        var reservedOk = true;
        for (var resR in needMap) {
            var info = storageManager.storageFind(roomName, resR);
            var termFree = info.terminal.total - info.terminal.reserved;
            var storFree = info.storage.total  - info.storage.reserved;
            var need = needMap[resR];
            if (termFree + storFree < need) {
                reservedOk = false;
                break;
            }
            var fromTerm = Math.min(need, termFree);
            var fromStor = need - fromTerm;
            if (fromTerm > 0) {
                var r1 = storageManager.reserve(roomName, resR, 'terminal', order.reservationProgram, fromTerm);
                reservedKeys.push({ r: resR, b: 'terminal' });
                if (!r1.ok) { reservedOk = false; break; }
            }
            if (fromStor > 0) {
                var r2 = storageManager.reserve(roomName, resR, 'storage', order.reservationProgram, fromStor);
                reservedKeys.push({ r: resR, b: 'storage' });
                if (!r2.ok) { reservedOk = false; break; }
            }
        }
        if (!reservedOk) {
            // Roll back partial reservations before refusing
            for (var k = 0; k < reservedKeys.length; k++) {
                storageManager.unReserve(roomName, reservedKeys[k].r, reservedKeys[k].b, order.reservationProgram);
            }
            delete order.reservationProgram;
            return '[Factory] REFUSED: Insufficient unreserved inputs in ' + roomName + ' for ' + product;
        }
    }

    Memory.factoryOrders.push(order);

    markActivePerRoom();

    return '[Factory] Order accepted. ' + orderSummary(order);
};

global.cancelFactoryOrder = function(idOrRoom, productLike) {
    ensureMemory();
    if (!Memory.factoryOrders.length) return '[Factory] No orders.';
    var removed = 0;

    function cancelOne(o) {
        if (o.reservationProgram) releaseOrderReservations(o);
        removed++;
    }

    if (productLike) {
        var product = normalizeProduct(productLike);
        Memory.factoryOrders = Memory.factoryOrders.filter(function(o) {
            var match = (o.id === idOrRoom || o.room === idOrRoom) && o.product === product;
            if (match) cancelOne(o);
            return !match;
        });
    } else {
        Memory.factoryOrders = Memory.factoryOrders.filter(function(o) {
            var match = (o.id === idOrRoom || o.room === idOrRoom);
            if (match) cancelOne(o);
            return !match;
        });
    }

    markActivePerRoom();
    return removed ? '[Factory] Cancelled ' + removed + ' order(s).' : '[Factory] No matching orders.';
};

global.factoryOrders = function(roomName) {
    return global.listFactoryOrders(roomName);
};

global.listFactoryOrders = function(roomName) {
    ensureMemory();
    var list = Memory.factoryOrders;
    if (!list.length) return '[Factory] No active orders.';
    if (roomName) {
        list = list.filter(function(o) { return o.room === roomName; });
        if (!list.length) return '[Factory] No active orders in ' + roomName + '.';
    }
    return list.map(orderSummary).join('\n');
};

// ─── Main tick ───────────────────────────────────────────────────────────────

function run() {
    ensureMemory();
    markActivePerRoom();

    var activeByRoom = _.groupBy(
        Memory.factoryOrders.filter(function(o) { return o.status === 'active'; }),
        function(o) { return o.room; }
    );

    for (var roomName in activeByRoom) {
        var room = Game.rooms[roomName];
        if (!room || !roomOwned(room)) continue;

        var order   = activeByRoom[roomName][0];
        var recipe  = getRecipe(order.product);
        var factory = findFactory(room);
        if (!factory) continue;

        if (!order.phase) order.phase = 'loading';
        if (!order.lastProgressTick) order.lastProgressTick = Game.time;

        if (!order.broken) {
            var stuckTicks = Game.time - (order.lastProgressTick || order.created || Game.time);
            if (stuckTicks > FACTORY_BROKEN_ORDER_TICKS) {
                markBrokenOrder(order, 'no progress for ' + stuckTicks + ' ticks');
            }
        }

        if (order.broken) {
            order.phase = 'unloading';
            if (!factoryHasAnyStock(factory)) {
                order.status = 'cancelled';
            }
            continue;
        }

        var remainingBatches = remainingBatchesForOrder(order, recipe);
        if (remainingBatches <= 0) {
            if (!factoryHasAnyStock(factory)) {
                order.status = 'done';
            } else {
                order.phase = 'unloading';
            }
            continue;
        }

        if (order.phase === 'loading') {
            if (!order.cycleBatches && !prepareCycle(order, factory, recipe)) {
                if (factoryHasAnyStock(factory)) {
                    order.phase = 'unloading';
                }
                continue;
            }

            resizeCycleToFit(order, factory, recipe);

            if (cycleInputsLoaded(factory, order, recipe)) {
                order.phase = 'processing';
            }
        }

        if (order.phase === 'processing') {
            if (factory.store.getFreeCapacity && (factory.store.getFreeCapacity() || 0) < (recipe.out || 0)) {
                order.phase = 'loading';
                continue;
            }

            tryProduce(factory, order);

            if ((order.cycleBatchesQueued || 0) >= (order.cycleBatches || 0)) {
                order.phase = 'unloading';
            }

            if (recipe && !supplierActiveForRoom(roomName)
                    && maxBatchesForRoom(room, recipe) <= 0
                    && !factoryHasAnyStock(factory)
                    && (order.progressOut || 0) > 0) {
                order.phase = 'unloading';
            }
        }

        if (order.phase === 'unloading') {
            if (!factoryHasAnyStock(factory)) {
                if ((order.progressOut || 0) >= order.requested) {
                    order.status = 'done';
                } else if (prepareCycle(order, factory, recipe)) {
                    order.phase = 'loading';
                } else {
                    order.status = 'done';
                }
            }
        }
    }

    // Cleanup completed orders — release v2 reservations before dropping
    var before = Memory.factoryOrders.length;
    Memory.factoryOrders = Memory.factoryOrders.filter(function(o) {
        if (o.status === 'done' || o.status === 'cancelled') {
            if (o.status === 'done') recordCompletedOrder(o);
            releaseOrderReservations(o);
            return false;
        }
        return true;
    });
    if (Memory.factoryOrders.length !== before) {
        markActivePerRoom();
    }
}

module.exports = { run: run, RECIPES: RECIPES, getRecipe: getRecipe };
