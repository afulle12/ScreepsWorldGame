// mineralManager.js
// Automates processing minerals into bars and selling them.
// Behavior:
// - When a mineral vein depletes, orders the factory to process its stock into bars.
// - Once bars exist (or an order already exists), enters "selling" phase.
// - Selling rules:
//   - Attempt one direct deal with buy orders at/above target price.
//   - Always call marketSell(roomName, resourceType, amount, price) to handle order creation
//     (repricing and extending existing orders is not handled by marketSell - see note below)
// Pricing:
// - Soft cap: if terminal free capacity < 100,000, price at 50% of market average.
// - Otherwise: price at 85% of market average.
// - Market average is taken from your marketPrice helper if present, else last up-to-2-days history average.
// Important note: marketSell creates NEW orders but does NOT maintain existing ones. 
// MineralManager now only creates orders when needed (not on every tick).
// Safeguards:
// - Runs every 100 ticks.
// - No optional chaining used.
// - Exceptions in marketSell are caught and logged; selling stays active to retry next cycle.

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

// Try to sell immediately to the best buy orders at or above targetPrice.
// Returns the remaining amount not sold.
function trySellToBestBuyOrders(roomName, resourceType, targetPrice, availableAmount) {
    var room = Game.rooms[roomName];
    var terminal = room && room.terminal;
    if (!terminal) return availableAmount;

    var orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType }) || [];
    orders.sort(function(a, b) { return b.price - a.price; });

    var remaining = availableAmount;
    for (var i = 0; i < orders.length && remaining > 0; i++) {
        var o = orders[i];
        if (o.price < targetPrice) break;

        var amount = Math.min(o.remainingAmount, remaining);
        if (amount <= 0) continue;

        var energy = terminal.store[RESOURCE_ENERGY] || 0;
        if (energy <= 0) break;

        var cost = Game.market.calcTransactionCost(amount, roomName, o.roomName);
        while (amount > 0 && cost > energy) {
            amount = Math.floor(amount / 2);
            if (amount <= 0) break;
            cost = Game.market.calcTransactionCost(amount, roomName, o.roomName);
        }
        if (amount <= 0) continue;

        if (terminal.cooldown !== 0) break;

        var dealResult = Game.market.deal(o.id, amount, roomName);
        if (dealResult === OK) {
            remaining -= amount;
            break; // one deal per cycle to respect cooldown
        } else {
            console.log('[MineralManager] deal failed in ' + roomName + ' for ' + resourceType + ': ' + dealResult);
        }
    }
    return remaining;
}

// Find an active sell order for a given room and resource (to enter selling phase even without stock)
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

// ===== MAIN RUN FUNCTION =====
function run() {
    init();

    // Run only every 100 ticks as specified
    if (Game.time % 100 !== 0) return;

    // Global once-per-tick guard to prevent duplicate execution in the same tick
    if (Memory.mineralManager.lastRunTick === Game.time) return;
    Memory.mineralManager.lastRunTick = Game.time;

    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;

        // Check for extractor
        var extractor = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_EXTRACTOR }
        })[0];
        if (!extractor) continue;

        // Get mineral
        var mineral = room.find(FIND_MINERALS)[0];
        if (!mineral) continue;

        // Initialize room state if needed
        if (!Memory.mineralManager.roomStates[roomName]) {
            Memory.mineralManager.roomStates[roomName] = {
                lastAmount: mineral.mineralAmount,
                processingOrderId: null,
                selling: false
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
        var terminal = room.terminal;

        // Safety net: start selling if we have bars OR an active sell order exists
        if (!state.processingOrderId && !state.selling && terminal && barTypeRoom) {
            var hasBars = (terminal.store[barTypeRoom] || 0) > 0;
            var existingOrder = findActiveSellOrder(roomName, barTypeRoom);
            if (hasBars || existingOrder) {
                state.selling = true;
                if (hasBars) {
                    console.log('[MineralManager] Bars detected in terminal of ' + roomName + '; initiating sell for ' + barTypeRoom);
                } else {
                    console.log('[MineralManager] Active order exists in ' + roomName + '; initiating sell maintenance for ' + barTypeRoom);
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

            var targetPrice = computeDynamicSellPrice(barTypeRoom, terminal);
            if (targetPrice === null) {
                console.log('[MineralManager] No price history for ' + barTypeRoom + ' in ' + roomName + '; delegating price to marketSell');
            }

            // 1) Try one direct deal at or above target price (only if we have a numeric target)
            var available = terminal.store[barTypeRoom] || 0;
            var amountToSell = available;
            if (available > 0 && terminal.cooldown === 0 && targetPrice != null) {
                var remaining = trySellToBestBuyOrders(roomName, barTypeRoom, targetPrice, available);
                if (remaining < available) {
                    var soldAmt = available - remaining;
                    console.log('[MineralManager] Sold ' + soldAmt + ' ' + barTypeRoom + ' via buy orders from ' + roomName);
                }
                amountToSell = remaining;
            }

            // 2) Only create new order if we have something to sell and no active order exists
            if (amountToSell > 0 && typeof marketSell === 'function') {
                var existingOrder = findActiveSellOrder(roomName, barTypeRoom);
                if (!existingOrder) {
                    try {
                        var res = marketSell(roomName, barTypeRoom, amountToSell, targetPrice);
                        var priceStr;
                        if (targetPrice == null) {
                            priceStr = 'auto';
                        } else {
                            var rounded = Math.round(targetPrice * 1000) / 1000;
                            priceStr = rounded.toFixed(3);
                        }
                        console.log('[MineralManager] marketSell invoked in ' + roomName + ' for ' + barTypeRoom + ' at ' + priceStr + ' -> ' + res);
                        // Successful order creation; end selling phase
                        state.selling = false;
                    } catch (e) {
                        // Keep selling active; retry next cycle
                        console.log('[MineralManager] marketSell threw in ' + roomName + ' for ' + barTypeRoom + ': ' + e);
                        // Do not set selling=false; let it retry next run
                    }
                } else {
                    console.log('[MineralManager] Active order exists for ' + barTypeRoom + ' in ' + roomName + '; no new order created');
                    // End selling phase since order exists
                    state.selling = false;
                }
            } else if (typeof marketSell !== 'function') {
                console.log('[MineralManager] marketSell helper not available; skipping market order creation for ' + barTypeRoom + ' in ' + roomName);
                // Keep selling=true to retry when helper becomes available
            } else {
                console.log('[MineralManager] No bars left to sell for ' + barTypeRoom + ' in ' + roomName);
                state.selling = false;
            }
        }
    }
}

module.exports = { run: run };
