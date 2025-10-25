// mineralManager.js
// Automates processing minerals into bars and selling them.
// Behavior:
// - When a mineral vein depletes, orders the factory to process its stock into bars.
// - Once processing completes, immediately attempts to create a sell order via marketSell
//   if no active sell order exists for the same bar in the same room.
// - If bars are present in the room (terminal/storage/factory) and no sell order exists,
//   create a new sell order via marketSell; bars will be moved to the terminal and wait to be sold.
// - Selling rules:
//   - Do not attempt direct buy-order deals here; rely on marketSell to create/price the sell order.
//   - Always call marketSell(roomName, resourceType, amount, price) to handle order creation
//     (repricing and extending existing orders is not handled by marketSell - see note below).
// Pricing:
// - Soft cap: if terminal free capacity < 100,000, price at 50% of market average.
// - Otherwise: price at 85% of market average.
// - Market average is taken from your marketPrice helper if present, else last up-to-2-days history average.
// Important note: marketSell creates NEW orders but does NOT maintain existing ones. 
// MineralManager only creates orders when needed (not on every tick).
// Safeguards:
// - Runs every 100 ticks.
// - No optional chaining used.
// - Exceptions in marketSell are caught and logged; selling stays active to retry next cycle.

var getRoomState = require('getRoomState');

function init() {
    if (!Memory.mineralManager) {
        Memory.mineralManager = {
            roomStates: {},
            lastRunTick: 0
        };
    }
    if (!Memory.mineralManager.roomStates) Memory.mineralManager.roomStates = {};
    if (typeof Memory.mineralManager.lastRunTick !== 'number') Memory.mineralManager.lastRunTick = 0;
}

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

// ===== PRICING HELPERS =====

// Raw market average from helper or history
function computeMarketAvg(resourceType) {
    var price = null;

    // Prefer your helper if present
    if (typeof marketPrice === 'function') {
        var p = marketPrice(resourceType);
        if (typeof p === 'number' && isFinite(p)) {
            price = p;
        } else if (typeof p === 'string') {
            var m = p.match(/avg \(approx\): ([0-9.]+)/);
            if (m) price = parseFloat(m[1]);
        }
    }

    // Fallback: average of last up to 2 days using official market history
    if (price === null || isNaN(price)) {
        var history = Game.market.getHistory(resourceType);
        if (history && history.length > 0) {
            var count = Math.min(2, history.length);
            var sum = 0;
            for (var i = history.length - count; i < history.length; i++) {
                sum += history[i].avgPrice;
            }
            price = sum / count;
        }
    }

    return (price !== null && isFinite(price)) ? price : null;
}

function getTerminalFreeCapacityCompat(terminal, resourceType) {
    if (!terminal || !terminal.store) return 0;
    if (typeof terminal.store.getFreeCapacity === 'function') {
        return terminal.store.getFreeCapacity(resourceType);
    }
    var cap = terminal.storeCapacity || 0;
    var used = 0;
    for (var key in terminal.store) {
        used += terminal.store[key] || 0;
    }
    var free = cap - used;
    if (free < 0) free = 0;
    return free;
}

// Dynamic sell price: 50% avg if terminal free space < 100k, else 85% avg
function computeDynamicSellPrice(resourceType, terminal) {
    var avg = computeMarketAvg(resourceType);
    if (avg === null) return null;
    var free = getTerminalFreeCapacityCompat(terminal, resourceType);
    var factor = (free < 100000) ? 0.50 : 0.85;
    return avg * factor;
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

// Find an existing sell order for a given room and resource
function findActiveSellOrder(roomName, resourceType) {
    var mine = Game.market.orders || {};
    for (var id in mine) {
        var ord = mine[id];
        if (!ord) continue;
        if (ord.type !== ORDER_SELL) continue;
        if (ord.resourceType !== resourceType) continue;
        if (ord.roomName !== roomName) continue;
        // Do NOT filter out inactive orders; they still represent an existing order
        // if (ord.active === false) continue;
        if ((ord.remainingAmount || 0) <= 0) continue;
        return ord;
    }
    return null;
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

    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;

        // Pull cached room state
        var rs = getRoomState.get(roomName);
        if (!rs) continue;

        // Check for extractor via cached structures; mirror FIND_MY_STRUCTURES by filtering .my
        var extractorList = (rs.structuresByType && rs.structuresByType[STRUCTURE_EXTRACTOR]) ? rs.structuresByType[STRUCTURE_EXTRACTOR] : [];
        var extractor = null;
        for (var ei = 0; ei < extractorList.length; ei++) {
            var ex = extractorList[ei];
            if (ex && ex.my) { extractor = ex; break; }
        }
        if (!extractor) continue;

        // Get mineral via cached minerals list
        var mineral = (rs.minerals && rs.minerals.length > 0) ? rs.minerals[0] : null;
        if (!mineral) continue;

        // Initialize room state if needed
        if (!Memory.mineralManager.roomStates[roomName]) {
            Memory.mineralManager.roomStates[roomName] = {
                lastAmount: mineral.mineralAmount,
                processingOrderId: null,
                selling: false,
                lastSellCreateTick: 0
            };
        }
        var state = Memory.mineralManager.roomStates[roomName];

        // Detect depletion: last > 0 and now == 0
        if (state.lastAmount > 0 && mineral.mineralAmount === 0) {
            if (!state.processingOrderId) {
                var mineralType = mineral.mineralType;
                var barType = getBarTypeFromMineral(mineralType);
                if (!barType) {
                    console.log('[MineralManager] Unsupported mineral type in ' + roomName + ': ' + mineralType);
                } else {
                    var orderResult = (typeof orderFactory === 'function')
                        ? orderFactory(roomName, barType, 'max')
                        : 'error: orderFactory not available';

                    if (orderResult && orderResult.indexOf('accepted') !== -1) {
                        var idMatch = orderResult.match(/\[#([^\]]+)\]/);
                        if (idMatch) {
                            state.processingOrderId = idMatch[1];
                            console.log('[MineralManager] Started processing ' + mineralType + ' into ' + barType + ' in ' + roomName + ' (order ' + state.processingOrderId + ')');
                            Game.notify('[MineralManager] Started processing ' + mineralType + ' into ' + barType + ' in ' + roomName + ' (order ' + state.processingOrderId + ')');
                        }
                    } else {
                        console.log('[MineralManager] Failed to order processing in ' + roomName + ': ' + orderResult);
                    }
                }
            }
        }

        // Update last amount
        state.lastAmount = mineral.mineralAmount;

        // If processing, check if done
        if (state.processingOrderId) {
            var ordersMem = Memory.factoryOrders || [];
            var found = null;
            for (var i = 0; i < ordersMem.length; i++) {
                if (ordersMem[i].id === state.processingOrderId) { found = ordersMem[i]; break; }
            }
            if (found && found.status === 'done') {
                state.processingOrderId = null;
                state.selling = true;
                console.log('[MineralManager] Processing complete in ' + roomName + '; preparing to sell');
                Game.notify('[MineralManager] Processing complete in ' + roomName + '; preparing to sell');
            } else if (!found) {
                state.processingOrderId = null;
            }
        }

        // Determine bar type once
        var barTypeRoom = getBarTypeFromMineral(mineral.mineralType);
        var terminal = rs.terminal;

        // Safety net: start selling only if we have bars in the room and no existing order exists
        if (!state.processingOrderId && !state.selling && terminal && barTypeRoom) {
            // Cooldown to avoid rapid re-creation if helper delays activation/visibility
            var coolDownTicks = 300; // ~3 cycles at 100-tick cadence
            if (state.lastSellCreateTick && (Game.time - state.lastSellCreateTick) < coolDownTicks) {
                // Skip re-init during cooldown
            } else {
                var existingOrder = findActiveSellOrder(roomName, barTypeRoom);
                var hasBarsInRoom = getTotalResourceInRoomState(rs, barTypeRoom) > 0;
                if (!existingOrder && hasBarsInRoom) {
                    state.selling = true;
                    console.log('[MineralManager] Bars detected in ' + roomName + '; initiating sell for ' + barTypeRoom);
                }
            }
        }

        // Selling phase
        if (state.selling && barTypeRoom) {
            if (!terminal) {
                console.log('[MineralManager] No terminal in ' + roomName + '; cannot sell ' + barTypeRoom);
                state.selling = false;
                continue;
            }

            // If an existing order already exists (active or inactive), do nothing (avoid duplicates)
            var existingOrder2 = findActiveSellOrder(roomName, barTypeRoom);
            if (existingOrder2) {
                console.log('[MineralManager] Existing order found for ' + barTypeRoom + ' in ' + roomName + '; no new order created');
                state.selling = false;
                continue;
            }

            // Price: compute target; allow helper to auto-price if null
            var targetPrice = computeDynamicSellPrice(barTypeRoom, terminal);
            if (targetPrice === null) {
                console.log('[MineralManager] No price history for ' + barTypeRoom + ' in ' + roomName + '; delegating price to marketSell');
            }

            // Amount: total bars present across terminal/storage/factory
            var amountDesired = getTotalResourceInRoomState(rs, barTypeRoom);

            if (typeof marketSell === 'function') {
                try {
                    // marketSell should create the order and request bars be moved to the terminal.
                    var res = marketSell(roomName, barTypeRoom, amountDesired, targetPrice);
                    var priceStr;
                    if (targetPrice == null) {
                        priceStr = 'auto';
                    } else {
                        var rounded = Math.round(targetPrice * 1000) / 1000;
                        priceStr = rounded.toFixed(3);
                    }
                    console.log('[MineralManager] marketSell invoked in ' + roomName + ' for ' + barTypeRoom + ' amount ' + amountDesired + ' at ' + priceStr + ' -> ' + res);
                    // Successful invoke; set cooldown and let the bars wait to be sold
                    state.selling = false;
                    state.lastSellCreateTick = Game.time;
                } catch (e) {
                    // Keep selling active; retry next cycle
                    console.log('[MineralManager] marketSell threw in ' + roomName + ' for ' + barTypeRoom + ': ' + e);
                    // Do not set selling=false; let it retry next run
                }
            } else {
                console.log('[MineralManager] marketSell helper not available; will retry next cycle for ' + barTypeRoom + ' in ' + roomName);
                // Keep selling=true to retry when helper becomes available
            }
        }
    }
}

module.exports = { run: run };
