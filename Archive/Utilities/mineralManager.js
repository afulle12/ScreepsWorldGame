// mineralManager.js
// Automates processing minerals into bars and selling them.
// Behavior:
// - When a mineral vein depletes, checks whether refining into bars is profitable
//   by comparing (bar sell price) vs (mineral sell price + energy BUY price per bar).
//   Energy uses the buy price (replacement cost) since it's consumed by the factory.
//   Only orders factory processing if refining yields more credits.
//   If refining is NOT profitable, sells the raw mineral directly instead.
// - Once processing completes, immediately attempts to create a sell order via marketSell
//   if no ACTIVE sell order exists for the same bar in the same room.
// - Scans STORAGE for all bar types and sells any that aren't reserved by an active/queued factory order.
// - Every 5000 ticks, checks storage for highway deposits (mist, biomass, metal, silicon) and sells them.
// - Sells excess OPS from storage, keeping a 5000 reserve.
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
// Ensure global.marketSell is available AND get the module for computePrice access
var marketSeller = require('marketSell');
var marketBuyer = require('marketBuy');

// Highway deposit resource types
var HIGHWAY_DEPOSITS = [
    RESOURCE_MIST,
    //RESOURCE_BIOMASS,
    //RESOURCE_METAL,
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

// Factory recipes for mineral -> bar compression (Screeps constants):
// 500 mineral + 200 energy -> 100 bars
// Per unit of bar: 5 mineral + 2 energy
var MINERAL_PER_BAR = 5;
var ENERGY_PER_BAR = 2;

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

// Check whether refining mineralType into barType is profitable.
// Returns an object: { profitable: bool, barPrice, mineralPrice, energyPrice, costPerBar, detail }
function checkRefiningProfitability(mineralType, barType) {
    var result = {
        profitable: false,
        barPrice: 0,
        mineralPrice: 0,
        energyPrice: 0,
        costPerBar: 0,
        detail: ''
    };

    if (!barType || !mineralType) {
        result.detail = 'missing mineral or bar type';
        return result;
    }

    // Bar and mineral use SELL prices (what we'd earn on the market).
    // Energy uses the BUY price (what it costs to replace the energy consumed by the factory).
    if (!marketSeller || typeof marketSeller.computePrice !== 'function') {
        // Can't compute prices — default to refining so we don't break existing behavior
        result.profitable = true;
        result.detail = 'marketSeller.computePrice unavailable; defaulting to refine';
        return result;
    }

    var barPrice = marketSeller.computePrice(barType);
    var mineralPrice = marketSeller.computePrice(mineralType);

    // Energy is a consumed input — use the buy price (replacement cost).
    var energyPrice;
    if (marketBuyer && typeof marketBuyer.computeBuyPrice === 'function') {
        energyPrice = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);
    } else {
        // Fallback: use sell price if marketBuyer unavailable (conservative — buy >= sell)
        energyPrice = marketSeller.computePrice(RESOURCE_ENERGY);
    }

    result.barPrice = barPrice;
    result.mineralPrice = mineralPrice;
    result.energyPrice = energyPrice;

    // Cost to produce 1 bar = (MINERAL_PER_BAR * mineral sell price) + (ENERGY_PER_BAR * energy buy price)
    // mineral sell price = opportunity cost of not selling the raw mineral
    // energy buy price   = replacement cost of the energy consumed by the factory
    var costPerBar = (MINERAL_PER_BAR * mineralPrice) + (ENERGY_PER_BAR * energyPrice);
    result.costPerBar = costPerBar;

    result.profitable = (barPrice > costPerBar);
    result.detail = barType + ' @ ' + barPrice.toFixed(3) +
        ' vs cost ' + costPerBar.toFixed(3) +
        ' (mineral sell ' + mineralPrice.toFixed(3) + ' x' + MINERAL_PER_BAR +
        ' + energy buy ' + energyPrice.toFixed(3) + ' x' + ENERGY_PER_BAR + ')';

    return result;
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

// Find an existing sell order with remaining amount for a given room and resource.
// Does NOT filter on ord.active — an order waiting for terminal stock (active:false)
// should still block new orders since a bot is hauling resources to fulfill it.
function findActiveSellOrder(roomName, resourceType) {
    var mine = Game.market.orders || {};
    for (var id in mine) {
        var ord = mine[id];
        if (!ord) continue;
        if (ord.type !== ORDER_SELL) continue;
        if (ord.resourceType !== resourceType) continue;
        if (ord.roomName !== roomName) continue;
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

    // FIX 2: cooldown is tracked per-resource rather than per-room.
    // Previously, one successful sell order would set state.lastSellCreateTick and
    // block ALL other resource types in the same room for 300 ticks.
    if (!state.lastSellCreateTicks) state.lastSellCreateTicks = {};
    var lastTick = state.lastSellCreateTicks[resourceType] || 0;
    if (!skipCooldown && (Game.time - lastTick) < coolDownTicks) return;

    if (!amount || amount <= 0) return;

    var existing = findActiveSellOrder(roomName, resourceType);
    if (existing) return;

    // FIX 1: fall back to the already-required marketSeller module when the
    // global marketSell function hasn't been registered (e.g. not re-exported
    // from main.js as a global). Previously this check silently failed every
    // time marketSell wasn't a global, so no orders were ever created.
    var sellFn = (typeof marketSell === 'function')
        ? marketSell
        : (typeof marketSeller === 'function' ? marketSeller : null);

    if (sellFn) {
        try {
            // 3-arg call: price delegated to marketSell
            var res = sellFn(roomName, resourceType, amount);
            // FIX 1 (cont): Accept any truthy non-error response rather than
            // matching a specific log prefix string. A log format change in
            // marketSell would previously have silently stopped the cooldown
            // from being set, causing orders to be spammed every cycle.
            var failed = !res
                || (typeof res === 'string' && (
                    res.indexOf('error') !== -1 ||
                    res.indexOf('Error') !== -1 ||
                    res.indexOf('ERR') !== -1
                ));
            if (!failed) {
                console.log('[MineralManager] Sell order created in ' + roomName + ' for ' + resourceType + ': ' + res);
                state.lastSellCreateTicks[resourceType] = Game.time;
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
                lastSellCreateTicks: {}
            };
        }
        var state = Memory.mineralManager.roomStates[roomName];
        // Migrate old single-tick field to per-resource map if needed
        if (!state.lastSellCreateTicks) state.lastSellCreateTicks = {};

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
                lastSellCreateTicks: {}
            };
        }
        var state = Memory.mineralManager.roomStates[roomName];
        // Migrate old single-tick field to per-resource map if needed
        if (!state.lastSellCreateTicks) state.lastSellCreateTicks = {};

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

        // --- Sell excess OPS (keep 5000 reserve) ---
        if (rs.terminal && rs.storage) {
            var opsAmount = getStorageAmount(rs, RESOURCE_OPS);
            if (opsAmount > 5000) {
                var opsToSell = opsAmount - 5000;
                if (!isReservedByFactoryOrder(roomName, RESOURCE_OPS)) {
                    attemptAutoSell(roomName, rs, RESOURCE_OPS, opsToSell, state, false);
                }
            }
        }

        // Processing trigger only requires extractor; if not present, skip processing logic.
        var extractorList = (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTRACTOR]) ? rs.structuresByType[STRUCTURE_EXTRACTOR] : [];
        var extractor = null;
        for (var ei = 0; ei < extractorList.length; ei++) {
            var ex = extractorList[ei];
            if (ex && ex.my) { extractor = ex; break; }
        }

        // Check for an owned factory in this room
        var factoryList = (rs.structuresByType && rs.structuresByType[STRUCTURE_FACTORY]) ? rs.structuresByType[STRUCTURE_FACTORY] : [];
        var hasFactory = false;
        for (var fi = 0; fi < factoryList.length; fi++) {
            if (factoryList[fi] && factoryList[fi].my) { hasFactory = true; break; }
        }

        if (mineral && extractor) {
            // Detect depletion: last > 0 and now == 0
            if (state.lastAmount > 0 && mineral.mineralAmount === 0) {
                if (!state.processingOrderId && barTypeRoom) {

                    // No factory in room — can't refine, sell raw mineral directly
                    if (!hasFactory) {
                        console.log('[MineralManager] No factory in ' + roomName + '; selling raw ' + mineral.mineralType);
                        var rawAmountNoFac = getTotalResourceInRoomState(rs, mineral.mineralType);
                        if (rawAmountNoFac > 0) {
                            attemptAutoSell(roomName, rs, mineral.mineralType, rawAmountNoFac, state, true);
                        }
                    } else {
                        // === PROFITABILITY CHECK ===
                        // Compare bar sell price vs opportunity cost of selling raw mineral + energy.
                        var profCheck = checkRefiningProfitability(mineral.mineralType, barTypeRoom);
                        console.log('[MineralManager] Profitability check in ' + roomName + ': ' + profCheck.detail);

                        if (profCheck.profitable) {
                            // Refining is worth it — send to factory
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
                        } else {
                            // Refining is NOT profitable — sell raw mineral directly
                            console.log('[MineralManager] Skipping refining in ' + roomName + '; selling raw ' + mineral.mineralType + ' instead');
                            var rawAmount = getTotalResourceInRoomState(rs, mineral.mineralType);
                            if (rawAmount > 0) {
                                attemptAutoSell(roomName, rs, mineral.mineralType, rawAmount, state, true);
                            }
                        }
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