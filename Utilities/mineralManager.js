// mineralManager.js
// Automates processing minerals into bars and selling them.
// Behavior:
// - When a mineral vein depletes, orders the factory to process its stock into bars.
// - Once processing completes, immediately attempts to create a sell order via marketSell
//   if no ACTIVE sell order exists for the same bar in the same room.
// - Scans STORAGE for all bar types and sells any that aren't reserved by an active/queued factory order.
// - Every 5000 ticks, checks storage for highway deposits (mist, biomass, metal, silicon) and sells them.
// - Selling rules:
//   - Do not attempt direct buy-order deals here; rely on marketSell to create/price the sell order.
//   - Always call marketSell(roomName, resourceType, amount) to handle order creation.
//   - Pricing is delegated to marketSell's dynamic pricing.
// Important note: marketSell creates NEW orders but does NOT maintain existing ones. 
// MineralManager only creates orders when needed (not on every tick).
// Safeguards:
// - Runs every 100 ticks.
// - Highway deposit check runs every 5000 ticks.
// - No optional chaining used.
// - Exceptions in marketSell are caught and logged; selling stays active to retry next cycle.

var getRoomState = require('getRoomState');
// Ensure global.marketSell is available
require('marketSell');

// Highway deposit resource types
var HIGHWAY_DEPOSITS = [
    RESOURCE_MIST,
    RESOURCE_BIOMASS,
    RESOURCE_METAL,
    RESOURCE_SILICON
];

// All bar/compressed resource types we might want to sell from storage
var ALL_BAR_TYPES = [
    RESOURCE_UTRIUM_BAR,
    RESOURCE_LEMERGIUM_BAR,
    RESOURCE_KEANIUM_BAR,
    RESOURCE_ZYNTHIUM_BAR,
    RESOURCE_GHODIUM_MELT,
    RESOURCE_OXIDANT,
    RESOURCE_REDUCTANT,
    RESOURCE_PURIFIER
];

// Helper to map mineral to bar
function getBarTypeFromMineral(mineralType) {
    switch (mineralType) {
        case RESOURCE_UTRIUM: return RESOURCE_UTRIUM_BAR;
        case RESOURCE_LEMERGIUM: return RESOURCE_LEMERGIUM_BAR;
        case RESOURCE_KEANIUM: return RESOURCE_KEANIUM_BAR;
        case RESOURCE_ZYNTHIUM: return RESOURCE_ZYNTHIUM_BAR;
        case RESOURCE_GHODIUM: return RESOURCE_GHODIUM_MELT;
        case RESOURCE_OXYGEN: return RESOURCE_OXIDANT;
        case RESOURCE_HYDROGEN: return RESOURCE_REDUCTANT;
        case RESOURCE_CATALYST: return RESOURCE_PURIFIER;
        default: return null;
    }
}

function init() {
    if (!Memory.mineralManager) {
        Memory.mineralManager = {
            roomStates: {},
            lastRunTick: 0,
            lastDepositCheckTick: 0
        };
    }
    if (!Memory.mineralManager.roomStates) Memory.mineralManager.roomStates = {};
    if (typeof Memory.mineralManager.lastRunTick !== 'number') Memory.mineralManager.lastRunTick = 0;
    if (typeof Memory.mineralManager.lastDepositCheckTick !== 'number') Memory.mineralManager.lastDepositCheckTick = 0;
}

// Sum resource across terminal, storage, and factory in this room using room state
function getTotalResourceInRoomState(rs, resourceType) {
    var sum = 0;
    if (rs.terminal && rs.terminal.store) sum += (rs.terminal.store[resourceType] || 0);
    if (rs.storage && rs.storage.store) sum += (rs.storage.store[resourceType] || 0);

    var factories = (rs.structuresByType && rs.structuresByType[STRUCTURE_FACTORY]) ? rs.structuresByType[STRUCTURE_FACTORY] : [];
    for (var i = 0; i < factories.length; i++) {
        var fac = factories[i];
        if (fac && fac.my && fac.store) {
            sum += (fac.store[resourceType] || 0);
        }
    }
    return sum;
}

// Get resource amount in storage only
function getStorageAmount(rs, resourceType) {
    if (rs.storage && rs.storage.store) {
        return rs.storage.store[resourceType] || 0;
    }
    return 0;
}

// Find an existing ACTIVE sell order for a given room and resource
function findActiveSellOrder(roomName, resourceType) {
    var mine = Game.market.orders || {};
    for (var id in mine) {
        var ord = mine[id];
        if (!ord) continue;
        if (ord.type !== ORDER_SELL) continue;
        if (ord.resourceType !== resourceType) continue;
        if (ord.roomName !== roomName) continue;
        if (ord.active === false) continue; // ignore inactive orders so they don't block new ones
        if ((ord.remainingAmount || 0) <= 0) continue;
        return ord;
    }
    return null;
}

// Check if any active/queued factory order in this room uses the given resource as an input.
// If so, we should NOT sell it — the factory needs it.
function isReservedByFactoryOrder(roomName, resourceType) {
    var factoryOrders = Memory.factoryOrders || [];
    var factoryManager = null;
    try { factoryManager = require('factoryManager'); } catch (e) { /* not loaded */ }
    var recipes = (factoryManager && factoryManager.RECIPES) ? factoryManager.RECIPES : null;
    if (!recipes) return false;

    for (var i = 0; i < factoryOrders.length; i++) {
        var order = factoryOrders[i];
        if (order.room !== roomName) continue;
        if (order.status !== 'active' && order.status !== 'queued') continue;

        // Check if this bar type is an input to the ordered product
        var recipe = recipes[order.product];
        if (!recipe || !recipe.inputs) continue;

        if (recipe.inputs[resourceType] !== undefined && recipe.inputs[resourceType] > 0) {
            return true;
        }
    }
    return false;
}

// One-shot attempt to create a sell order if conditions are met
function attemptAutoSell(roomName, rs, resourceType, amount, state, skipCooldown) {
    if (!resourceType) return;
    var terminal = rs.terminal;
    if (!terminal) return;

    var coolDownTicks = 300; // ~3 cycles at 100-tick cadence
    if (!skipCooldown && state.lastSellCreateTick && (Game.time - state.lastSellCreateTick) < coolDownTicks) return;

    if (!amount || amount <= 0) return;

    var existing = findActiveSellOrder(roomName, resourceType);
    if (existing) return;

    if (typeof marketSell === 'function') {
        try {
            // 3-arg call: price delegated to marketSell
            var res = marketSell(roomName, resourceType, amount);
            if (typeof res === 'string' && res.indexOf('[MarketSell] Created SELL order') === 0) {
                console.log('[MineralManager] ' + res);
                state.lastSellCreateTick = Game.time;
            } else {
                // keep trying next cycle
                console.log('[MineralManager] marketSell did not create order in ' + roomName + ' for ' + resourceType + ': ' + res);
            }
        } catch (e) {
            console.log('[MineralManager] marketSell threw in ' + roomName + ' for ' + resourceType + ': ' + e);
        }
    } else {
        console.log('[MineralManager] marketSell helper not available; will retry next cycle for ' + resourceType + ' in ' + roomName);
    }
}

// Sell highway deposits from storage
function sellHighwayDeposits() {
    // Only run every 5000 ticks
    if (Game.time - Memory.mineralManager.lastDepositCheckTick < 5000) return;
    Memory.mineralManager.lastDepositCheckTick = Game.time;

    console.log('[MineralManager] Checking for highway deposits to sell...');

    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;

        var rs = getRoomState.get(roomName);
        if (!rs) continue;
        if (!rs.terminal) continue;

        // Ensure per-room memory exists
        if (!Memory.mineralManager.roomStates[roomName]) {
            Memory.mineralManager.roomStates[roomName] = {
                lastAmount: 0,
                processingOrderId: null,
                selling: false,
                lastSellCreateTick: 0
            };
        }
        var state = Memory.mineralManager.roomStates[roomName];

        // Check each highway deposit type
        for (var i = 0; i < HIGHWAY_DEPOSITS.length; i++) {
            var depositType = HIGHWAY_DEPOSITS[i];
            var amount = getTotalResourceInRoomState(rs, depositType);

            if (amount > 0) {
                console.log('[MineralManager] Found ' + amount + ' ' + depositType + ' in ' + roomName);
                // Skip cooldown for deposit selling since it runs infrequently
                attemptAutoSell(roomName, rs, depositType, amount, state, true);
            }
        }
    }
}

// ===== MAIN RUN FUNCTION =====
function run() {
    init();

    // Run only every 100 ticks as specified
    if (Game.time % 100 !== 0) return;

    // Global once-per-tick guard to prevent duplicate execution in the same tick
    if (Memory.mineralManager.lastRunTick === Game.time) return;
    Memory.mineralManager.lastRunTick = Game.time;

    // Build room state cache for this tick
    getRoomState.init();

    // Check and sell highway deposits every 5000 ticks
    sellHighwayDeposits();

    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;

        // Pull cached room state
        var rs = getRoomState.get(roomName);
        if (!rs) continue;

        // Get mineral via cached minerals list (needed to determine bar type)
        var mineral = (rs.minerals && rs.minerals.length > 0) ? rs.minerals[0] : null;
        var barTypeRoom = mineral ? getBarTypeFromMineral(mineral.mineralType) : null;

        // Ensure per-room memory
        if (!Memory.mineralManager.roomStates[roomName]) {
            Memory.mineralManager.roomStates[roomName] = {
                lastAmount: mineral ? mineral.mineralAmount : 0,
                processingOrderId: null,
                selling: false,
                lastSellCreateTick: 0
            };
        }
        var state = Memory.mineralManager.roomStates[roomName];

        // --- Scan STORAGE only for all bar types; sell any not reserved by factory orders ---
        if (rs.terminal && rs.storage) {
            for (var bi = 0; bi < ALL_BAR_TYPES.length; bi++) {
                var barType = ALL_BAR_TYPES[bi];
                var storageAmt = getStorageAmount(rs, barType);
                if (storageAmt <= 0) continue;

                // Don't sell if a factory order in this room needs it as input
                if (isReservedByFactoryOrder(roomName, barType)) continue;

                attemptAutoSell(roomName, rs, barType, storageAmt, state, false);
            }
        }

        // Processing trigger only requires extractor; if not present, skip processing logic.
        var extractorList = (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTRACTOR]) ? rs.structuresByType[STRUCTURE_EXTRACTOR] : [];
        var extractor = null;
        for (var ei = 0; ei < extractorList.length; ei++) {
            var ex = extractorList[ei];
            if (ex && ex.my) { extractor = ex; break; }
        }

        if (mineral && extractor) {
            // Detect depletion: last > 0 and now == 0
            if (state.lastAmount > 0 && mineral.mineralAmount === 0) {
                if (!state.processingOrderId && barTypeRoom) {
                    var orderResult = (typeof orderFactory === 'function')
                        ? orderFactory(roomName, barTypeRoom, 'max')
                        : 'error: orderFactory not available';

                    if (orderResult && orderResult.indexOf('accepted') !== -1) {
                        var idMatch = orderResult.match(/\[#([^\]]+)\]/);
                        if (idMatch) {
                            state.processingOrderId = idMatch[1];
                            console.log('[MineralManager] Started processing ' + mineral.mineralType + ' into ' + barTypeRoom + ' in ' + roomName + ' (order ' + state.processingOrderId + ')');
                        }
                    } else {
                        console.log('[MineralManager] Failed to order processing in ' + roomName + ': ' + orderResult);
                    }
                }
            }

            // Update last amount
            state.lastAmount = mineral.mineralAmount;

            // If processing, check if done; if done, try to sell immediately
            if (state.processingOrderId) {
                var ordersMem = Memory.factoryOrders || [];
                var found = null;
                for (var i = 0; i < ordersMem.length; i++) {
                    if (ordersMem[i].id === state.processingOrderId) { found = ordersMem[i]; break; }
                }
                if (found && found.status === 'done') {
                    state.processingOrderId = null;
                    console.log('[MineralManager] Processing complete in ' + roomName + '; preparing to sell');
                    if (barTypeRoom) {
                        var totalAmt = getTotalResourceInRoomState(rs, barTypeRoom);
                        attemptAutoSell(roomName, rs, barTypeRoom, totalAmt, state, false);
                    }
                } else if (!found) {
                    // Order vanished; clear, selling will be handled by the storage scan above.
                    state.processingOrderId = null;
                }
            }
        }
    }
}

module.exports = { run: run };