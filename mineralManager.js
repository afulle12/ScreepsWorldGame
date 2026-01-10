// mineralManager.js
// Automates processing minerals into bars and selling them.
// Behavior:
// - When a mineral vein depletes, orders the factory to process its stock into bars.
// - Once processing completes, immediately attempts to create a sell order via marketSell
//   if no ACTIVE sell order exists for the same bar in the same room.
// - If bars are present in the room (terminal/storage/factory) and no ACTIVE sell order exists,
//   create a new sell order via marketSell; bars will be moved to the terminal and wait to be sold.
// - Selling rules:
//   - Do not attempt direct buy-order deals here; rely on marketSell to create/price the sell order.
//   - Always call marketSell(roomName, resourceType, amount) to handle order creation.
//   - Pricing is delegated to marketSell’s dynamic pricing.
// Important note: marketSell creates NEW orders but does NOT maintain existing ones. 
// MineralManager only creates orders when needed (not on every tick).
// Safeguards:
// - Runs every 100 ticks.
// - No optional chaining used.
// - Exceptions in marketSell are caught and logged; selling stays active to retry next cycle.

var getRoomState = require('getRoomState');
// Ensure global.marketSell is available
require('marketSell');

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
            lastRunTick: 0
        };
    }
    if (!Memory.mineralManager.roomStates) Memory.mineralManager.roomStates = {};
    if (typeof Memory.mineralManager.lastRunTick !== 'number') Memory.mineralManager.lastRunTick = 0;
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

// Find an existing ACTIVE sell order for a given room and resource
function findActiveSellOrder(roomName, resourceType) {
    var mine = Game.market.orders || {};
    for (var id in mine) {
        var ord = mine[id];
        if (!ord) continue;
        if (ord.type !== ORDER_SELL) continue;
        if (ord.resourceType !== resourceType) continue;
        if (ord.roomName !== roomName) continue;
        if (ord.active === false) continue; // ignore inactive orders so they don't block new ones【1】
        if ((ord.remainingAmount || 0) <= 0) continue;
        return ord;
    }
    return null;
}

// One-shot attempt to create a sell order if conditions are met
function attemptAutoSell(roomName, rs, barType, state) {
    if (!barType) return;
    var terminal = rs.terminal;
    if (!terminal) return;

    var coolDownTicks = 300; // ~3 cycles at 100-tick cadence
    if (state.lastSellCreateTick && (Game.time - state.lastSellCreateTick) < coolDownTicks) return;

    var amount = getTotalResourceInRoomState(rs, barType);
    if (!amount || amount <= 0) return;

    var existing = findActiveSellOrder(roomName, barType);
    if (existing) return;

    if (typeof marketSell === 'function') {
        try {
            // 3-arg call: price delegated to marketSell
            var res = marketSell(roomName, barType, amount);
            if (typeof res === 'string' && res.indexOf('[MarketSell] Created SELL order') === 0) {
                console.log('[MineralManager] ' + res);
                state.lastSellCreateTick = Game.time;
            } else {
                // keep trying next cycle
                console.log('[MineralManager] marketSell did not create order in ' + roomName + ' for ' + barType + ': ' + res);
            }
        } catch (e) {
            console.log('[MineralManager] marketSell threw in ' + roomName + ' for ' + barType + ': ' + e);
        }
    } else {
        console.log('[MineralManager] marketSell helper not available; will retry next cycle for ' + barType + ' in ' + roomName);
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

        // Always attempt selling if bars exist and no ACTIVE order (general safety net).
        if (barTypeRoom) {
            attemptAutoSell(roomName, rs, barTypeRoom, state);
        }

        // Processing trigger only requires extractor; if not present, skip processing logic (but keep selling logic above).
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
                            //Game.notify('[MineralManager] Started processing ' + mineral.mineralType + ' into ' + barTypeRoom + ' in ' + roomName + ' (order ' + state.processingOrderId + ')');
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
                    //Game.notify('[MineralManager] Processing complete in ' + roomName + '; preparing to sell');
                    if (barTypeRoom) {
                        attemptAutoSell(roomName, rs, barTypeRoom, state);
                    }
                } else if (!found) {
                    // Order vanished; clear, selling will be handled by the general safety net above.
                    state.processingOrderId = null;
                }
            }
        }
    }
}

module.exports = { run: run };
