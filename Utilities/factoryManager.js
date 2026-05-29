// factoryManager.js
// ============================================================================
// FIFO per room factory order manager. Refuses orders unless full resources
// are present in the room (storage + terminal only). Spawns a stationary
// hauler (48 CARRY / 2 MOVE) that parks adjacent to storage, terminal, and
// factory. Orders in different rooms run concurrently.
//
// The factoryBot handles logistics (loading inputs, evacuating outputs).
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
//
//   @param {string}        roomName - Target room (e.g. 'W1N1').
//   @param {string}        product  - Product name or resource constant.
//                                     Accepts friendly names ('Oxidant',
//                                     'Zynthium bar', 'Utrium', 'Lemergium')
//                                     or resource constants
//                                     (RESOURCE_OXIDANT, RESOURCE_WIRE …).
//   @param {number|'max'}  amount   - Units to produce.  Use 'max' to produce
//                                     as much as current room resources allow.
//
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
//   @param {string}  idOrRoom - Order ID (e.g. 'W1N1_XO_1234567') OR a room
//                               name. Passing a room name without a product
//                               cancels ALL orders for that room.
//   @param {string}  [product]- Optional: restrict cancellation to a specific
//                               product in that room.
//
//   Examples:
//     cancelFactoryOrder('W1N1_XO_1234567')        // cancel by exact ID
//     cancelFactoryOrder('W1N1')                   // cancel all W1N1 orders
//     cancelFactoryOrder('W1N1', 'Oxidant')        // cancel W1N1 Oxidant only
//
// ────────────────────────────────────────────────────────────
//
// listFactoryOrders(roomName?)
//   List all orders globally, or filter to one room.
//   Alias: factoryOrders(roomName?)
//
//   @param {string} [roomName] - Optional room to filter by.
//
//   Examples:
//     listFactoryOrders()          // all rooms
//     listFactoryOrders('W1N1')    // W1N1 only
//     factoryOrders('W1N1')        // backward-compatible alias
//
// ============================================================================

var singleSourceRoom = require('singleSourceRoom');

const ROLE_NAME = 'factoryBot';

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
}

function findFactory(room) {
    return room.find(FIND_MY_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_FACTORY; }
    })[0];
}

function roomOwned(room) {
    return !!(room && room.controller && room.controller.my);
}

/**
 * Count a resource in storage + terminal + factory only.
 * Containers are excluded — the factoryBot only interacts with these three.
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

// ─── Parking tile: must be range ≤ 1 from storage, terminal, AND factory ─────

function findParkingTile(room) {
    var factory = findFactory(room);
    if (!factory || !room.storage || !room.terminal) return null;

    var terrain = Game.map.getRoomTerrain(room.name);

    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue; // factory's own tile

            var x = factory.pos.x + dx;
            var y = factory.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

            var pos = new RoomPosition(x, y, room.name);
            if (pos.getRangeTo(room.storage)  > 1) continue;
            if (pos.getRangeTo(room.terminal) > 1) continue;

            // Check for obstacle structures on the tile
            var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
            var blocked = false;
            for (var s = 0; s < structs.length; s++) {
                if (OBSTACLE_OBJECT_TYPES.indexOf(structs[s].structureType) !== -1) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;

            return { x: x, y: y };
        }
    }
    return null;
}

// ─── Spawn: 48 CARRY / 2 MOVE, closest spawn to storage ─────────────────────

function spawnFactoryBot(room, orderId) {
    if (!room.storage) return ERR_NOT_FOUND;

    var spawns = room.find(FIND_MY_SPAWNS);

    // Find the spawn closest to storage
    var bestSpawn = null;
    var bestRange = Infinity;
    for (var i = 0; i < spawns.length; i++) {
        var s = spawns[i];
        var r = s.pos.getRangeTo(room.storage);
        if (r < bestRange) { bestRange = r; bestSpawn = s; }
    }

    if (!bestSpawn) return ERR_NOT_FOUND;

    // Only use THIS spawn — if it's busy, wait
    if (bestSpawn.spawning) return ERR_BUSY;

    // Compute parking tile
    var parkPos = findParkingTile(room);
    if (!parkPos) {
        console.log('[Factory] No valid parking tile in ' + room.name
            + ' (need range 1 of storage + terminal + factory)');
        return ERR_NOT_FOUND;
    }

    // 48 CARRY + 2 MOVE = 2500 energy
    var body = [];
    for (var c = 0; c < 48; c++) body.push(CARRY);
    body.push(MOVE, MOVE);

    var cost = 2500;
    if (bestSpawn.room.energyAvailable < cost) return ERR_NOT_ENOUGH_ENERGY;

    var name = 'FactoryBot_' + room.name + '_' + Game.time;
    var order = (Memory.factoryOrders || []).find(function(o) { return o.id === orderId; });
    var memory = {
        role:     ROLE_NAME,
        orderId:  orderId,
        homeRoom: room.name,
        product:  order ? order.product : undefined,
        parkPos:  parkPos,
        state:    'park'
    };

    return bestSpawn.spawnCreep(body, name, { memory: memory });
}

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

function tryProduce(factory, order) {
    if (!factory || factory.cooldown) return false;
    if (!enoughForOneBatchInFactory(factory, order.product)) return false;
    var res = factory.produce(order.product);
    if (res === OK) {
        var recipe = getRecipe(order.product);
        order.batchesQueued = (order.batchesQueued || 0) + 1;
        order.progressOut = (order.batchesQueued * (recipe ? recipe.out : 1));
        order.lastProduceTick = Game.time;
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

function needBotForRoom(roomName) {
    if (singleSourceRoom.isSingleSourceActive(roomName)) return false;

    var existing = _.filter(Game.creeps, function(c) {
        return c.memory.role === ROLE_NAME && c.memory.homeRoom === roomName;
    });
    return existing.length === 0;
}

/**
 * Returns true if a factoryBot exists for this room and is actively working
 * (load or produce state). Used to prevent the auto-complete race condition
 * where inputs in the bot's carry are invisible to countInRoom.
 */
function botActiveForRoom(roomName) {
    return _.some(Game.creeps, function(c) {
        if (!c.memory || c.memory.role !== ROLE_NAME) return false;
        if (c.memory.homeRoom !== roomName) return false;
        var state = c.memory.state;
        if (state === 'produce') return true;
        if (state === 'load') return !c.memory.waitingForInputs;
        return false;
    });
}

function orderSummary(order) {
    return '[#' + order.id + '] ' + order.room + ' -> ' + order.product
        + ' | requested: ' + order.requested
        + ', queuedOut: ' + (order.progressOut || 0)
        + ', status: ' + order.status;
}

function maxBatchesForRoom(room, recipe) {
    var minBatches = Infinity;
    for (var res in recipe.inputs) {
        var perBatch = recipe.inputs[res] || 0;
        if (perBatch <= 0) continue;
        var have = countInRoom(room, res);
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

    // Validate parking tile for non-single-source rooms
    if (!singleSourceRoom.isSingleSourceActive(roomName)) {
        var parkPos = findParkingTile(room);
        if (!parkPos) {
            return '[Factory] REFUSED: No valid parking tile in ' + roomName
                + ' (need a walkable tile within range 1 of storage, terminal, and factory).';
        }
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
        batchesQueued: 0, progressOut: 0, lastProduceTick: 0
    };
    Memory.factoryOrders.push(order);

    markActivePerRoom();

    var isActive = Memory.factoryOrders.find(function(o) {
        return o.room === roomName && o.status === 'active' && o.id === id;
    });
    if (isActive && needBotForRoom(roomName)) spawnFactoryBot(room, id);

    return '[Factory] Order accepted. ' + orderSummary(order);
};

global.cancelFactoryOrder = function(idOrRoom, productLike) {
    ensureMemory();
    if (!Memory.factoryOrders.length) return '[Factory] No orders.';
    var removed = 0;

    if (productLike) {
        var product = normalizeProduct(productLike);
        Memory.factoryOrders = Memory.factoryOrders.filter(function(o) {
            var match = (o.id === idOrRoom || o.room === idOrRoom) && o.product === product;
            if (match) removed++;
            return !match;
        });
    } else {
        Memory.factoryOrders = Memory.factoryOrders.filter(function(o) {
            var match = (o.id === idOrRoom || o.room === idOrRoom);
            if (match) removed++;
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

        // Spawn bot if needed
        if (needBotForRoom(roomName)) spawnFactoryBot(room, order.id);

        // Produce whenever factory is ready
        tryProduce(factory, order);

        // Check completion
        if ((order.progressOut || 0) >= order.requested) {
            order.status = 'done';
        }

        // Auto-complete if no more inputs available anywhere.
        // IMPORTANT: Skip this check if a factoryBot is actively working —
        // inputs may be in the bot's carry (invisible to countInRoom) and
        // would cause a false "no more inputs" premature completion.
        if (order.status === 'active') {
            if (recipe && !enoughForOneBatchInFactory(factory, order.product)
                    && maxBatchesForRoom(room, recipe) <= 0
                    && !botActiveForRoom(roomName)) {
                console.log('[Factory] Auto-completing order ' + order.id
                    + ': not enough inputs remain for another batch ('
                    + (order.progressOut || 0) + '/' + order.requested + ' produced).');
                order.status = 'done';
            }
        }
    }

    // Cleanup completed orders
    var before = Memory.factoryOrders.length;
    Memory.factoryOrders = Memory.factoryOrders.filter(function(o) {
        return o.status !== 'done' && o.status !== 'cancelled';
    });
    if (Memory.factoryOrders.length !== before) {
        markActivePerRoom();
    }
}

module.exports = { run: run, RECIPES: RECIPES, getRecipe: getRecipe };