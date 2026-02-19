/**
 * autoTrader.js
 * 
 * Automated trading module that periodically analyzes market opportunities
 * and executes profitable reverse reactions (lab breakdown) and factory
 * refinement jobs.
 * 
 * RUNS EVERY 100 TICKS:
 * 1. Analyzes Reverse Reaction profitability (buy compound -> break down -> sell reagents)
 * 2. Analyzes Factory Production profitability (buy minerals -> compress -> sell bars)
 * 3. Filters for opportunities with >50% margin
 * 4. Skips any compound/product already being processed
 * 5. Matches jobs with eligible rooms (including factory level requirements)
 * 6. Executes up to 3 reverse reactions and 1 factory job per cycle
 * 
 * CONSOLE COMMANDS:
 *   autoTrader()              - Show status and last run info
 *   autoTrader('run')         - Force immediate analysis and execution
 *   autoTrader('analyze')     - Run analysis only (no execution)
 *   autoTrader('reset')       - Reset memory
 *   autoTrader('enable')      - Enable automatic runs
 *   autoTrader('disable')     - Disable automatic runs
 * 
 *   selling()                 - Show all active sell orders by resource
 *   selling('compact')        - Compact view (one line per resource)
 *   selling('OH')             - Show sell orders for specific resource
 *   buying()                  - Show all active buy orders by resource
 *   buying('compact')         - Compact view
 *   buying('K')               - Show buy orders for specific resource
 */

var getRoomState = require('getRoomState');

// Configuration
var RUN_INTERVAL = 100;
var MARGIN_THRESHOLD = 20; // percent
var MAX_REVERSE_REACTIONS = 3;
var MAX_FACTORY_JOBS = 1;
var MIN_STORAGE_ENERGY = 150000;
var REQUIRED_SOURCES = 2;
var MIN_LABS = 3;
var MAX_SELL_AMOUNT = 100000; // Don't start jobs if we're already selling this much of a reagent
var FACTORY_JOB_COOLDOWN = 500; // Don't re-start the same factory product within this many ticks

// Supported factory products organized by level
var LEVEL_0_FACTORY_PRODUCTS = [
    // Compressed minerals
    RESOURCE_UTRIUM_BAR,
    RESOURCE_LEMERGIUM_BAR,
    RESOURCE_ZYNTHIUM_BAR,
    RESOURCE_KEANIUM_BAR,
    RESOURCE_GHODIUM_MELT,
    RESOURCE_OXIDANT,
    RESOURCE_REDUCTANT,
    RESOURCE_PURIFIER,
    RESOURCE_BATTERY,
    // Basic regional commodities (any level factory)
    RESOURCE_WIRE,        // from silicon
    RESOURCE_CELL,        // from biomass
    RESOURCE_ALLOY,       // from metal
    RESOURCE_CONDENSATE   // from mist
];

var LEVEL_1_FACTORY_PRODUCTS = [
    RESOURCE_COMPOSITE,   // common
    RESOURCE_TUBE,        // mechanical
    RESOURCE_PHLEGM,      // biological
    RESOURCE_SWITCH,      // electronical
    RESOURCE_CONCENTRATE  // mystical
];

var LEVEL_2_FACTORY_PRODUCTS = [
    RESOURCE_CRYSTAL,     // common
    RESOURCE_FIXTURES,    // mechanical
    RESOURCE_TISSUE,      // biological
    RESOURCE_TRANSISTOR,  // electronical
    RESOURCE_EXTRACT      // mystical
];

var LEVEL_3_FACTORY_PRODUCTS = [
    RESOURCE_LIQUID,      // common
    RESOURCE_FRAME,       // mechanical
    RESOURCE_MUSCLE,      // biological
    RESOURCE_MICROCHIP,   // electronical
    RESOURCE_SPIRIT       // mystical
];

var LEVEL_4_FACTORY_PRODUCTS = [
    RESOURCE_HYDRAULICS,  // mechanical
    RESOURCE_ORGANOID,    // biological
    RESOURCE_CIRCUIT,     // electronical
    RESOURCE_EMANATION    // mystical
];

var LEVEL_5_FACTORY_PRODUCTS = [
    RESOURCE_MACHINE,     // mechanical
    RESOURCE_ORGANISM,    // biological
    RESOURCE_DEVICE,      // electronical
    RESOURCE_ESSENCE      // mystical
];

// Combined list of all supported products
var SUPPORTED_FACTORY_PRODUCTS = LEVEL_0_FACTORY_PRODUCTS
    .concat(LEVEL_1_FACTORY_PRODUCTS)
    .concat(LEVEL_2_FACTORY_PRODUCTS)
    .concat(LEVEL_3_FACTORY_PRODUCTS)
    .concat(LEVEL_4_FACTORY_PRODUCTS)
    .concat(LEVEL_5_FACTORY_PRODUCTS);

// ===== Memory Management =====

function ticksToTimeAgo(tickDiff) {
    // Screeps ticks are approximately 3 seconds each
    var seconds = tickDiff * 3;
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);
    var days = Math.floor(hours / 24);
    
    if (days >= 1) {
        return days + (days === 1 ? ' day' : ' days') + ' ago';
    } else if (hours >= 1) {
        return hours + (hours === 1 ? ' hour' : ' hours') + ' ago';
    } else {
        return minutes + (minutes === 1 ? ' min' : ' mins') + ' ago';
    }
}

function ensureMemory() {
    if (!Memory.autoTrader) {
        Memory.autoTrader = {
            enabled: true,
            lastRun: 0,
            lastAnalysis: null,
            jobsStarted: []
        };
    }
    return Memory.autoTrader;
}

// ===== Price Helpers (duplicated from marketAnalysis for self-containment) =====

function getOrderInfo(resource, orderType) {
    var orders = Game.market.getAllOrders({ resourceType: resource, type: orderType }) || [];
    var valid = [];
    var totalVolume = 0;
    
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        var amt = o.remainingAmount || o.amount || 0;
        if (amt > 0) {
            valid.push(o);
            totalVolume += amt;
        }
    }
    
    if (valid.length === 0) {
        return { count: 0, totalVolume: 0, bestPrice: null, orders: [] };
    }
    
    valid.sort(function(a, b) {
        return orderType === ORDER_BUY ? (b.price - a.price) : (a.price - b.price);
    });
    
    return {
        count: valid.length,
        totalVolume: totalVolume,
        bestPrice: valid[0].price,
        orders: valid
    };
}

function getAvg48h(resource) {
    var hist = Game.market.getHistory(resource) || [];
    if (!hist || hist.length === 0) return null;
    var last = hist[hist.length - 1];
    var prev = hist.length >= 2 ? hist[hist.length - 2] : null;
    var sumPV = 0;
    var sumV = 0;
    if (last && typeof last.avgPrice === 'number' && typeof last.volume === 'number') {
        sumPV += last.avgPrice * last.volume;
        sumV += last.volume;
    }
    if (prev && typeof prev.avgPrice === 'number' && typeof prev.volume === 'number') {
        sumPV += prev.avgPrice * prev.volume;
        sumV += prev.volume;
    }
    if (sumV <= 0) return last && typeof last.avgPrice === 'number' ? last.avgPrice : null;
    return sumPV / sumV;
}

function computeMarketBuyPrice(resourceType) {
    var orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType }) || [];
    
    var myRooms = {};
    for (var rn in Game.rooms) {
        var r = Game.rooms[rn];
        if (r && r.controller && r.controller.my) {
            myRooms[rn] = true;
        }
    }
    
    var validOrders = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o || o.type !== ORDER_BUY) continue;
        if (typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
        if (o.roomName && myRooms[o.roomName]) continue;
        if (typeof o.price !== 'number') continue;
        validOrders.push(o);
    }
    
    validOrders.sort(function(a, b) {
        return b.price - a.price;
    });
    
    var totalVolume = 0;
    for (var j = 0; j < validOrders.length; j++) {
        totalVolume += validOrders[j].remainingAmount || 0;
    }
    
    if (validOrders.length > 0) {
        var bestPrice = validOrders[0].price;
        var p = bestPrice + 0.1;
        return {
            price: Math.max(p, 0.001),
            source: 'MBUY',
            orderCount: validOrders.length,
            volume: totalVolume
        };
    }
    
    var hist = Game.market.getHistory(resourceType) || [];
    var count = 0;
    var sum = 0;
    
    if (hist.length >= 1) {
        var h1 = hist[hist.length - 1];
        if (h1 && typeof h1.avgPrice === 'number') { sum += h1.avgPrice; count++; }
    }
    if (hist.length >= 2) {
        var h2 = hist[hist.length - 2];
        if (h2 && typeof h2.avgPrice === 'number') { sum += h2.avgPrice; count++; }
    }
    
    var avg = (count > 0) ? (sum / count) : 1;
    var price = avg * 0.95;
    
    return {
        price: Math.max(price, 0.001),
        source: 'HIST',
        orderCount: 0,
        volume: 0
    };
}

function priceOfWithSource(resource, mode) {
    if (resource === RESOURCE_ENERGY && mode === 'sell') {
        return computeMarketBuyPrice(resource);
    }
    
    if (mode === 'avg') {
        var avg = getAvg48h(resource);
        if (avg !== null) {
            return { price: avg, source: 'HIST', orderCount: 0, volume: 0 };
        }
        var sellInfo = getOrderInfo(resource, ORDER_SELL);
        if (sellInfo.bestPrice !== null) {
            return { price: sellInfo.bestPrice, source: 'LIVE', orderCount: sellInfo.count, volume: sellInfo.totalVolume };
        }
        return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }
    
    if (mode === 'buy' || mode === 'sell') {
        var orderType = mode === 'buy' ? ORDER_BUY : ORDER_SELL;
        var orderInfo = getOrderInfo(resource, orderType);
        
        if (orderInfo.bestPrice !== null) {
            return {
                price: orderInfo.bestPrice,
                source: 'LIVE',
                orderCount: orderInfo.count,
                volume: orderInfo.totalVolume
            };
        }
        
        var histPrice = getAvg48h(resource);
        if (histPrice !== null) {
            return { price: histPrice, source: 'HIST', orderCount: 0, volume: 0 };
        }
        
        return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }
    
    return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
}

// ===== Factory Level Helpers =====

/**
 * Get the required factory level for a product
 * @param {string} product - The resource constant
 * @returns {number|null} - Required level (0-5) or null if not a commodity
 */
function getProductFactoryLevel(product) {
    if (!COMMODITIES || !COMMODITIES[product]) return null;
    var recipe = COMMODITIES[product];
    // Level 0 products don't have a level property, or have level: 0
    return typeof recipe.level === 'number' ? recipe.level : 0;
}

/**
 * Get the factory level for a room
 * @param {string} roomName - The room name
 * @returns {number|null} - Factory level (0-5) or null if no factory
 */
function getRoomFactoryLevel(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.structuresByType || !state.structuresByType[STRUCTURE_FACTORY]) return null;
    var factories = state.structuresByType[STRUCTURE_FACTORY];
    if (factories.length === 0) return null;
    var factory = factories[0];
    // Unleveled factories have level undefined, treat as 0
    return typeof factory.level === 'number' ? factory.level : 0;
}

/**
 * Check if a room can produce a specific product
 * @param {string} roomName - The room name
 * @param {string} product - The resource constant
 * @returns {boolean} - True if room's factory can produce this product
 */
function canRoomProduceProduct(roomName, product) {
    var requiredLevel = getProductFactoryLevel(product);
    if (requiredLevel === null) return false;
    
    var factoryLevel = getRoomFactoryLevel(roomName);
    if (factoryLevel === null) return false;
    
    // Level 0 products can be made by any factory
    // Level 1+ products require exact factory level match
    if (requiredLevel === 0) {
        return true;
    }
    return factoryLevel === requiredLevel;
}

// ===== Analysis Functions =====

function buildReactionMap() {
    var map = {};
    if (!REACTIONS) return map;
    for (var a in REACTIONS) {
        if (!REACTIONS.hasOwnProperty(a)) continue;
        var inner = REACTIONS[a];
        for (var b in inner) {
            if (!inner.hasOwnProperty(b)) continue;
            var prod = inner[b];
            map[prod] = [a, b];
        }
    }
    return map;
}

function analyzeReverseReaction(compound, reactionPairs, reagentSellMode, compoundBuyMode) {
    var pair = reactionPairs[compound];
    if (!pair) return null;
    
    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    
    var reagentA = pair[0];
    var reagentB = pair[1];
    
    // If we have sell orders from our own rooms, the effective acquisition cost is 0
    // (credits cycle back), but the OPPORTUNITY cost is what we'd earn selling it instead.
    // Use opportunity cost for profitability analysis, but pass 0 as maxPrice for execution
    // so opportunisticBuy knows to buy from our own rooms at any price.
    var compoundPrice, compoundInfo, compoundOpportunityCost;
    if (hasOwnRoomSellOrders(compound)) {
        compoundPrice = 0; // execution price: buy from own room for free
        compoundInfo = { price: 0, source: 'OWN', volume: 0 };
        // Opportunity cost: what buyers would pay us (best buy order price)
        var oppInfo = priceOfWithSource(compound, 'buy');
        compoundOpportunityCost = (oppInfo.price !== null) ? oppInfo.price : 0;
    } else {
        compoundInfo = priceOfWithSource(compound, compoundBuyMode);
        compoundPrice = compoundInfo.price;
        compoundOpportunityCost = compoundPrice;
    }
    var totalCost = compoundOpportunityCost === null ? null : compoundOpportunityCost * batch;
    
    var priceAInfo = priceOfWithSource(reagentA, reagentSellMode);
    var priceBInfo = priceOfWithSource(reagentB, reagentSellMode);
    var priceA = priceAInfo.price;
    var priceB = priceBInfo.price;
    
    var revenueA = priceA === null ? null : priceA * batch;
    var revenueB = priceB === null ? null : priceB * batch;
    
    var totalRevenue = null;
    if (revenueA !== null && revenueB !== null) {
        totalRevenue = revenueA + revenueB;
    } else if (revenueA !== null) {
        totalRevenue = revenueA;
    } else if (revenueB !== null) {
        totalRevenue = revenueB;
    }
    
    var profit = null;
    if (totalRevenue !== null && totalCost !== null) {
        profit = totalRevenue - totalCost;
    }
    
    var marginPct = null;
    if (profit !== null && totalCost !== null && totalCost > 0) {
        marginPct = (profit / totalCost) * 100;
    } else if (profit !== null && totalCost === 0) {
        // No opportunity cost (nobody is buying the compound) but we can still profit
        marginPct = 9999;
    }
    
    return {
        type: 'reverse',
        compound: compound,
        reagentA: reagentA,
        reagentB: reagentB,
        marginPct: marginPct,
        profit: profit,
        compoundPrice: compoundPrice,
        compoundVolume: compoundInfo.volume
    };
}

function analyzeFactoryProduct(resource, outputMode, inputMode) {
    var recipe = COMMODITIES && COMMODITIES[resource];
    if (!recipe) return null;
    
    var outQty = (typeof recipe.amount === 'number' && recipe.amount > 0) ? recipe.amount : 1;
    var comps = recipe.components || {};
    var totalCost = 0;        // opportunity cost for profitability analysis
    var inputPrices = {};      // execution prices: 0 for own resources so opportunisticBuy buys from own rooms
    
    for (var res in comps) {
        if (!comps.hasOwnProperty(res)) continue;
        var qty = comps[res] || 0;
        
        // If sell orders from our own rooms exist for this input, we already have it.
        // Execution price = 0 (opportunisticBuy will buy from own room, credits cycle back).
        // But for profitability analysis, use opportunity cost = what we'd earn selling it instead.
        if (hasOwnRoomSellOrders(res)) {
            inputPrices[res] = 0; // tells opportunisticBuy to accept any price from own rooms
            // Opportunity cost: best buy order price (what buyers would pay us)
            var oppInfo = priceOfWithSource(res, 'buy');
            totalCost += (oppInfo.price !== null ? oppInfo.price * qty : 0);
            continue;
        }
        
        var priceInfo = priceOfWithSource(res, inputMode);
        totalCost += (priceInfo.price === null ? 0 : priceInfo.price * qty);
        if (priceInfo.price !== null) {
            inputPrices[res] = priceInfo.price;
        }
    }
    
    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : (revenue - totalCost);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);
    
    // If all inputs have zero opportunity cost (nobody is buying them), margin is effectively infinite
    if (profit !== null && totalCost === 0 && revenue > 0) {
        marginPct = 9999;
    }
    
    // Include the required factory level in the analysis
    var requiredLevel = getProductFactoryLevel(resource);
    
    return {
        type: 'factory',
        product: resource,
        marginPct: marginPct,
        profit: profit,
        unitPrice: unitPrice,
        outputVolume: outputInfo.volume,
        requiredLevel: requiredLevel,
        inputPrices: inputPrices
    };
}

// ===== Own-Room Detection =====

/**
 * Build a set of our owned room names
 * @returns {Object} - Map of roomName -> true for owned rooms
 */
function getMyRooms() {
    var myRooms = {};
    for (var rn in Game.rooms) {
        var r = Game.rooms[rn];
        if (r && r.controller && r.controller.my) {
            myRooms[rn] = true;
        }
    }
    return myRooms;
}

/**
 * Check if there are sell orders for a resource originating from our own rooms.
 * Uses Game.market.getAllOrders to check ALL sell orders, then filters by room ownership.
 * If we have our own sell orders, we already have the resource and can transfer it between
 * rooms at zero effective credit cost (credits cycle back).
 * 
 * autoTrader uses this to:
 * - Set inputPrices to 0 so opportunisticBuy accepts own-room orders at any price
 * - Separately compute opportunity cost (what we'd earn selling) for profitability analysis
 * 
 * @param {string} resourceType - The resource to check
 * @returns {boolean} - True if sell orders from our own rooms exist for this resource
 */
function hasOwnRoomSellOrders(resourceType) {
    var myRooms = getMyRooms();
    var allOrders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType }) || [];
    
    for (var i = 0; i < allOrders.length; i++) {
        var o = allOrders[i];
        if (o.roomName && myRooms[o.roomName] && (o.remainingAmount || o.amount || 0) > 0) {
            return true;
        }
    }
    return false;
}

// ===== Currently Processing Detection =====

function getCurrentSellAmount(resourceType) {
    var total = 0;
    var orders = Game.market.orders;
    for (var id in orders) {
        var order = orders[id];
        if (order.type === ORDER_SELL && order.resourceType === resourceType && order.remainingAmount > 0) {
            total += order.remainingAmount;
        }
    }
    return total;
}

function getActiveReverseReactions() {
    var active = {};
    
    if (Memory.marketLabReverse && Memory.marketLabReverse.rooms) {
        for (var roomName in Memory.marketLabReverse.rooms) {
            var queue = Memory.marketLabReverse.rooms[roomName];
            if (!queue) continue;
            for (var i = 0; i < queue.length; i++) {
                var op = queue[i];
                if (op && op.targetCompound && op.state !== 'SELLING') {
                    active[op.targetCompound] = {
                        room: roomName,
                        state: op.state
                    };
                }
            }
        }
    }
    
    return active;
}

function getActiveFactoryJobs() {
    var active = {};
    
    // Check marketRefine ops
    if (Memory.marketRefine && Memory.marketRefine.ops) {
        for (var i = 0; i < Memory.marketRefine.ops.length; i++) {
            var op = Memory.marketRefine.ops[i];
            if (op && op.output) {
                active[op.output] = {
                    room: op.room,
                    phase: op.phase
                };
            }
        }
    }
    
    // Check factoryOrders
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (var j = 0; j < Memory.factoryOrders.length; j++) {
            var order = Memory.factoryOrders[j];
            if (order && order.product && !active[order.product]) {
                active[order.product] = {
                    room: order.room,
                    phase: 'factoryOrder'
                };
            }
        }
    }
    
    return active;
}

function getRoomActiveLabReverseCount(roomName) {
    if (!Memory.marketLabReverse || !Memory.marketLabReverse.rooms) return 0;
    var queue = Memory.marketLabReverse.rooms[roomName];
    return queue ? queue.length : 0;
}

function getRoomActiveFactoryCount(roomName) {
    var count = 0;
    
    if (Memory.marketRefine && Memory.marketRefine.ops) {
        for (var i = 0; i < Memory.marketRefine.ops.length; i++) {
            var op = Memory.marketRefine.ops[i];
            if (op && op.room === roomName) count++;
        }
    }
    
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (var j = 0; j < Memory.factoryOrders.length; j++) {
            var order = Memory.factoryOrders[j];
            if (order && order.room === roomName) count++;
        }
    }
    
    return count;
}

function roomHasActiveFactoryJob(roomName) {
    return getRoomActiveFactoryCount(roomName) > 0;
}

/**
 * Check if a factory product was recently started by autoTrader (self-tracking cooldown)
 * Prevents re-starting the same product if marketRefine memory detection fails
 * @param {string} product - The resource constant
 * @returns {boolean} - True if product is on cooldown
 */
function isFactoryProductOnCooldown(product) {
    var mem = ensureMemory();
    if (!mem.jobsStarted) return false;
    
    for (var i = mem.jobsStarted.length - 1; i >= 0; i--) {
        var job = mem.jobsStarted[i];
        if (job.type === 'factory' && job.product === product) {
            if ((Game.time - job.tick) < FACTORY_JOB_COOLDOWN) {
                return true;
            }
            // Jobs are in chronological order, older ones will also be past cooldown
            return false;
        }
    }
    return false;
}

// ===== Room Eligibility =====

function roomHasSupplier(roomName) {
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (creep.memory.role === 'supplier' && creep.room.name === roomName) {
            return true;
        }
    }
    return false;
}

function getRoomLabCount(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.structuresByType || !state.structuresByType[STRUCTURE_LAB]) return 0;
    return state.structuresByType[STRUCTURE_LAB].length;
}

function isEligibleForReverseReaction(roomName) {
    var state = getRoomState.get(roomName);
    if (!state) return false;
    if (!state.controller || !state.controller.my) return false;
    if (!state.terminal) return false;
    
    var labCount = getRoomLabCount(roomName);
    if (labCount < MIN_LABS) return false;
    
    if (!roomHasSupplier(roomName)) return false;
    
    return true;
}

/**
 * Check if a room is eligible for factory work (basic requirements)
 * @param {string} roomName - The room name
 * @returns {boolean} - True if room meets basic factory requirements
 */
function isEligibleForFactoryBasic(roomName) {
    var state = getRoomState.get(roomName);
    if (!state) return false;
    if (!state.controller || !state.controller.my) return false;
    if (!state.terminal) return false;
    
    // Check for factory
    if (!state.structuresByType || !state.structuresByType[STRUCTURE_FACTORY]) return false;
    if (state.structuresByType[STRUCTURE_FACTORY].length === 0) return false;
    
    // Check storage energy
    if (!state.storage) return false;
    var storageEnergy = state.storage.store ? (state.storage.store[RESOURCE_ENERGY] || 0) : 0;
    if (storageEnergy < MIN_STORAGE_ENERGY) return false;
    
    // Check sources
    if (!state.sources || state.sources.length < REQUIRED_SOURCES) return false;
    
    // Check no existing factory jobs
    if (roomHasActiveFactoryJob(roomName)) return false;
    
    return true;
}

/**
 * Check if a room is eligible for a specific factory product
 * @param {string} roomName - The room name
 * @param {string} product - The resource constant (optional, if not provided checks basic eligibility)
 * @returns {boolean} - True if room can produce this product
 */
function isEligibleForFactory(roomName, product) {
    if (!isEligibleForFactoryBasic(roomName)) return false;
    
    // If no specific product, just check basic eligibility
    if (!product) return true;
    
    // Check if this room's factory can produce this product
    return canRoomProduceProduct(roomName, product);
}

function getEligibleReverseReactionRooms() {
    var rooms = [];
    var allRooms = getRoomState.all();
    
    for (var roomName in allRooms) {
        if (isEligibleForReverseReaction(roomName)) {
            rooms.push({
                name: roomName,
                orderCount: getRoomActiveLabReverseCount(roomName),
                labCount: getRoomLabCount(roomName)
            });
        }
    }
    
    // Sort by: fewest orders first, then most labs, then random
    rooms.sort(function(a, b) {
        if (a.orderCount !== b.orderCount) return a.orderCount - b.orderCount;
        if (a.labCount !== b.labCount) return b.labCount - a.labCount;
        return Math.random() - 0.5;
    });
    
    return rooms;
}

function getRoomStorageEnergy(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.storage || !state.storage.store) return 0;
    return state.storage.store[RESOURCE_ENERGY] || 0;
}

/**
 * Get rooms eligible for a specific factory product
 * @param {string} product - The resource constant (optional)
 * @returns {Array} - List of eligible room objects
 */
function getEligibleFactoryRooms(product) {
    var rooms = [];
    var allRooms = getRoomState.all();
    
    for (var roomName in allRooms) {
        if (isEligibleForFactory(roomName, product)) {
            rooms.push({
                name: roomName,
                orderCount: getRoomActiveFactoryCount(roomName),
                storageEnergy: getRoomStorageEnergy(roomName),
                factoryLevel: getRoomFactoryLevel(roomName)
            });
        }
    }
    
    // Sort by: fewest orders first, then most storage energy
    rooms.sort(function(a, b) {
        if (a.orderCount !== b.orderCount) return a.orderCount - b.orderCount;
        return b.storageEnergy - a.storageEnergy;
    });
    
    return rooms;
}

/**
 * Get a summary of factory capabilities across all rooms
 * @returns {Object} - Map of factory level to room count
 */
function getFactoryLevelSummary() {
    var summary = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    var allRooms = getRoomState.all();
    
    for (var roomName in allRooms) {
        var level = getRoomFactoryLevel(roomName);
        if (level !== null && isEligibleForFactoryBasic(roomName)) {
            summary[level] = (summary[level] || 0) + 1;
        }
    }
    
    return summary;
}

// ===== Main Analysis & Execution =====

function runAnalysis() {
    var reactionPairs = buildReactionMap();
    var allCompounds = [];
    for (var prod in reactionPairs) {
        if (reactionPairs.hasOwnProperty(prod)) {
            allCompounds.push(prod);
        }
    }
    
    var activeReverse = getActiveReverseReactions();
    var activeFactory = getActiveFactoryJobs();
    
    var opportunities = {
        reverse: [],
        factory: []
    };
    
    var skippedReverse = [];
    var skippedFactory = [];
    var skippedSellLimit = [];
    
    // Analyze reverse reactions
    for (var i = 0; i < allCompounds.length; i++) {
        var compound = allCompounds[i];
        
        var analysis = analyzeReverseReaction(compound, reactionPairs, 'buy', 'sell');
        if (!analysis) continue;
        
        // Check if already processing (before margin filter so active jobs always show)
        if (activeReverse[compound]) {
            skippedReverse.push({
                compound: compound,
                marginPct: analysis.marginPct,
                room: activeReverse[compound].room,
                state: activeReverse[compound].state
            });
            continue;
        }
        
        if (analysis.marginPct === null || analysis.marginPct < MARGIN_THRESHOLD) {
            continue;
        }
        
        // Check if we're already selling too much of either reagent
        var sellAmountA = getCurrentSellAmount(analysis.reagentA);
        var sellAmountB = getCurrentSellAmount(analysis.reagentB);
        
        if (sellAmountA >= MAX_SELL_AMOUNT) {
            skippedSellLimit.push({
                compound: compound,
                marginPct: analysis.marginPct,
                reason: analysis.reagentA + ' at ' + sellAmountA
            });
            continue;
        }
        
        if (sellAmountB >= MAX_SELL_AMOUNT) {
            skippedSellLimit.push({
                compound: compound,
                marginPct: analysis.marginPct,
                reason: analysis.reagentB + ' at ' + sellAmountB
            });
            continue;
        }
        
        opportunities.reverse.push(analysis);
    }
    
    // Analyze factory products (both level 0 and level 1)
    for (var j = 0; j < SUPPORTED_FACTORY_PRODUCTS.length; j++) {
        var product = SUPPORTED_FACTORY_PRODUCTS[j];
        
        var factoryAnalysis = analyzeFactoryProduct(product, 'buy', 'sell');
        if (!factoryAnalysis) continue;
        
        // Check if already processing (before margin filter so active jobs always show)
        if (activeFactory[product]) {
            skippedFactory.push({
                product: product,
                marginPct: factoryAnalysis.marginPct,
                room: activeFactory[product].room,
                phase: activeFactory[product].phase,
                requiredLevel: factoryAnalysis.requiredLevel
            });
            continue;
        }
        
        // Check autoTrader's own cooldown (safety net if marketRefine memory detection fails)
        if (isFactoryProductOnCooldown(product)) {
            skippedFactory.push({
                product: product,
                marginPct: factoryAnalysis.marginPct,
                room: '?',
                phase: 'cooldown',
                requiredLevel: factoryAnalysis.requiredLevel
            });
            continue;
        }
        
        if (factoryAnalysis.marginPct === null || factoryAnalysis.marginPct < MARGIN_THRESHOLD) {
            continue;
        }
        
        // Check if we're already selling too much of this product
        var sellAmount = getCurrentSellAmount(product);
        if (sellAmount >= MAX_SELL_AMOUNT) {
            skippedSellLimit.push({
                compound: product,
                marginPct: factoryAnalysis.marginPct,
                reason: product + ' at ' + sellAmount
            });
            continue;
        }
        
        // Check if we have any room that can produce this
        var eligibleRooms = getEligibleFactoryRooms(product);
        if (eligibleRooms.length === 0) {
            // No room can produce this product, skip but don't add to skipped list
            continue;
        }
        
        opportunities.factory.push(factoryAnalysis);
    }
    
    // Sort by margin descending
    opportunities.reverse.sort(function(a, b) {
        return (b.marginPct || 0) - (a.marginPct || 0);
    });
    opportunities.factory.sort(function(a, b) {
        return (b.marginPct || 0) - (a.marginPct || 0);
    });
    
    // Only log if there are new opportunities to act on
    if (opportunities.reverse.length > 0) {
        var reverseList = [];
        for (var r = 0; r < Math.min(3, opportunities.reverse.length); r++) {
            var opp = opportunities.reverse[r];
            reverseList.push(opp.compound + '(' + opp.marginPct.toFixed(0) + '%)');
        }
        console.log('[autoTrader] NEW reverse: ' + reverseList.join(', ') + (opportunities.reverse.length > 3 ? ' +' + (opportunities.reverse.length - 3) + ' more' : ''));
    }
    
    if (opportunities.factory.length > 0) {
        var factoryList = [];
        for (var f = 0; f < opportunities.factory.length; f++) {
            var fOpp = opportunities.factory[f];
            var levelStr = fOpp.requiredLevel > 0 ? ' L' + fOpp.requiredLevel : '';
            factoryList.push(fOpp.product + levelStr + '(' + fOpp.marginPct.toFixed(0) + '%)');
        }
        console.log('[autoTrader] NEW factory: ' + factoryList.join(', '));
    }
    
    if (skippedSellLimit.length > 0) {
        var sellLimitList = [];
        for (var s = 0; s < Math.min(3, skippedSellLimit.length); s++) {
            sellLimitList.push(skippedSellLimit[s].compound);
        }
        console.log('[autoTrader] Skipped (sell limit): ' + sellLimitList.join(', ') + (skippedSellLimit.length > 3 ? ' +' + (skippedSellLimit.length - 3) + ' more' : ''));
    }
    
    return {
        reverse: opportunities.reverse,
        factory: opportunities.factory,
        skippedReverse: skippedReverse,
        skippedFactory: skippedFactory,
        skippedSellLimit: skippedSellLimit
    };
}

function executeJobs(opportunities, dryRun) {
    var reverseRooms = getEligibleReverseReactionRooms();
    
    var jobsStarted = [];
    var reverseStarted = 0;
    var factoryStarted = 0;
    
    // Execute reverse reactions
    for (var i = 0; i < opportunities.reverse.length && reverseStarted < MAX_REVERSE_REACTIONS; i++) {
        if (reverseRooms.length === 0) break;
        
        var opp = opportunities.reverse[i];
        var targetRoom = reverseRooms[0];
        
        if (!dryRun) {
            // Pass the calculated compound price as max buy price to ensure profitability
            // If compoundPrice is 0 (we own the input), pass null/undefined so it uses existing stock
            var maxPrice = opp.compoundPrice > 0 ? opp.compoundPrice : undefined;
            var result = global.labReverse(targetRoom.name, opp.compound, maxPrice);
            console.log('[autoTrader] Started ' + opp.compound + ' -> ' + opp.reagentA + '+' + opp.reagentB + ' (' + opp.marginPct.toFixed(0) + '%) in ' + targetRoom.name + (maxPrice ? ' (max ' + maxPrice.toFixed(3) + ')' : ' (own stock)'));
            
            jobsStarted.push({
                type: 'reverse',
                compound: opp.compound,
                room: targetRoom.name,
                margin: opp.marginPct,
                maxPrice: opp.compoundPrice,
                tick: Game.time
            });
        }
        
        reverseStarted++;
        
        // Re-sort rooms after adding an order
        if (reverseRooms.length > 1) {
            targetRoom.orderCount++;
            reverseRooms.sort(function(a, b) {
                if (a.orderCount !== b.orderCount) return a.orderCount - b.orderCount;
                if (a.labCount !== b.labCount) return b.labCount - a.labCount;
                return 0;
            });
        }
    }
    
    // Execute factory jobs - now matching products to rooms with correct factory level
    for (var j = 0; j < opportunities.factory.length && factoryStarted < MAX_FACTORY_JOBS; j++) {
        var factoryOpp = opportunities.factory[j];
        
        // Get rooms eligible for THIS specific product
        var factoryRooms = getEligibleFactoryRooms(factoryOpp.product);
        if (factoryRooms.length === 0) continue;
        
        var factoryRoom = factoryRooms[0];
        
        if (!dryRun) {
            // Pass max input prices to ensure we only buy at profitable prices
            // Inputs with price 0 (we're already selling them) will signal to use existing stock
            var factoryResult = global.marketRefine(factoryRoom.name, factoryOpp.product, factoryOpp.inputPrices);
            var levelStr = factoryOpp.requiredLevel > 0 ? ' [L' + factoryOpp.requiredLevel + ']' : '';
            var priceEntries = [];
            for (var res in factoryOpp.inputPrices) {
                var p = factoryOpp.inputPrices[res];
                priceEntries.push(res + ':' + (p > 0 ? p.toFixed(3) : 'OWN'));
            }
            console.log('[autoTrader] Started ' + factoryOpp.product + levelStr + ' (' + factoryOpp.marginPct.toFixed(0) + '%) in ' + factoryRoom.name + ' (max ' + priceEntries.join(', ') + ')');
            
            jobsStarted.push({
                type: 'factory',
                product: factoryOpp.product,
                room: factoryRoom.name,
                margin: factoryOpp.marginPct,
                level: factoryOpp.requiredLevel,
                maxInputPrices: factoryOpp.inputPrices,
                tick: Game.time
            });
        }
        
        factoryStarted++;
    }
    
    return jobsStarted;
}

// ===== Console API =====

function getStatus() {
    var mem = ensureMemory();
    var lines = [];
    
    lines.push('[autoTrader] Status');
    lines.push('  Enabled: ' + (mem.enabled ? 'YES' : 'NO'));
    lines.push('  Run interval: ' + RUN_INTERVAL + ' ticks');
    lines.push('  Last run: ' + (mem.lastRun ? (Game.time - mem.lastRun) + ' ticks ago (tick ' + mem.lastRun + ')' : 'never'));
    lines.push('  Next run in: ' + (mem.lastRun ? Math.max(0, RUN_INTERVAL - (Game.time - mem.lastRun)) + ' ticks' : 'immediately'));
    lines.push('');
    lines.push('  Margin threshold: ' + MARGIN_THRESHOLD + '%');
    lines.push('  Max sell amount per resource: ' + MAX_SELL_AMOUNT);
    lines.push('  Max reverse reactions per cycle: ' + MAX_REVERSE_REACTIONS);
    lines.push('  Max factory jobs per cycle: ' + MAX_FACTORY_JOBS);
    
    // Show factory level summary
    var levelSummary = getFactoryLevelSummary();
    var levelParts = [];
    for (var lvl = 0; lvl <= 5; lvl++) {
        if (levelSummary[lvl] > 0) {
            levelParts.push('L' + lvl + ':' + levelSummary[lvl]);
        }
    }
    if (levelParts.length > 0) {
        lines.push('  Available factories: ' + levelParts.join(', '));
    }
    
    lines.push('');
    lines.push('  Supported products:');
    lines.push('    Level 0: ' + LEVEL_0_FACTORY_PRODUCTS.length + ' types (bars, compressed, basic regional)');
    lines.push('    Level 1: ' + LEVEL_1_FACTORY_PRODUCTS.length + ' types (composite, tube, phlegm, switch, concentrate)');
    lines.push('    Level 2: ' + LEVEL_2_FACTORY_PRODUCTS.length + ' types (crystal, fixtures, tissue, transistor, extract)');
    lines.push('    Level 3: ' + LEVEL_3_FACTORY_PRODUCTS.length + ' types (liquid, frame, muscle, microchip, spirit)');
    lines.push('    Level 4: ' + LEVEL_4_FACTORY_PRODUCTS.length + ' types (hydraulics, organoid, circuit, emanation)');
    lines.push('    Level 5: ' + LEVEL_5_FACTORY_PRODUCTS.length + ' types (machine, organism, device, essence)');
    
    if (mem.lastAnalysis) {
        lines.push('');
        lines.push('  Last analysis (tick ' + mem.lastAnalysis.tick + '):');
        lines.push('    Reverse opportunities found: ' + mem.lastAnalysis.reverseCount);
        lines.push('    Factory opportunities found: ' + mem.lastAnalysis.factoryCount);
    }
    
    if (mem.jobsStarted && mem.jobsStarted.length > 0) {
        lines.push('');
        lines.push('  Recent jobs started:');
        var recentJobs = mem.jobsStarted.slice(-10);
        for (var i = 0; i < recentJobs.length; i++) {
            var job = recentJobs[i];
            var desc = job.type === 'reverse' ? job.compound : job.product;
            var levelInfo = job.level > 0 ? ' [L' + job.level + ']' : '';
            var priceInfo = job.maxPrice ? ' @' + job.maxPrice.toFixed(2) : '';
            var timeAgo = ticksToTimeAgo(Game.time - job.tick);
            lines.push('    [' + timeAgo + '] ' + job.type + ': ' + desc + levelInfo + priceInfo + ' in ' + job.room + ' (' + job.margin.toFixed(1) + '%)');
        }
    }
    
    return lines.join('\n');
}

global.autoTrader = function(command) {
    var mem = ensureMemory();
    getRoomState.init();
    
    if (!command) {
        return getStatus();
    }
    
    if (command === 'enable') {
        mem.enabled = true;
        return '[autoTrader] Enabled automatic runs.';
    }
    
    if (command === 'disable') {
        mem.enabled = false;
        return '[autoTrader] Disabled automatic runs.';
    }
    
    if (command === 'reset') {
        Memory.autoTrader = null;
        ensureMemory();
        return '[autoTrader] Memory reset.';
    }
    
    if (typeof command === 'string' && command.indexOf('clearCooldown') === 0) {
        var product = command.split(' ')[1];
        if (!product) return '[autoTrader] Usage: autoTrader("clearCooldown composite")';
        var search = product.toLowerCase();
        if (!mem.jobsStarted) return '[autoTrader] No jobs in history.';
        var removed = 0;
        for (var ci = mem.jobsStarted.length - 1; ci >= 0; ci--) {
            var cj = mem.jobsStarted[ci];
            if (cj.type === 'factory' && cj.product && cj.product.toLowerCase().indexOf(search) >= 0) {
                mem.jobsStarted.splice(ci, 1);
                removed++;
            }
        }
        return '[autoTrader] Cleared ' + removed + ' job(s) matching "' + product + '" from history.';
    }
    
    if (command === 'analyze') {
        var results = runAnalysis();
        
        mem.lastAnalysis = {
            tick: Game.time,
            reverseCount: results.reverse.length,
            factoryCount: results.factory.length
        };
        
        var lines = ['[autoTrader] Analysis Results (margin >= ' + MARGIN_THRESHOLD + '%):', ''];
        
        // Show factory level summary
        var levelSummary = getFactoryLevelSummary();
        var levelParts = [];
        for (var lvl = 0; lvl <= 5; lvl++) {
            if (levelSummary[lvl] > 0) {
                levelParts.push('L' + lvl + ':' + levelSummary[lvl]);
            }
        }
        if (levelParts.length > 0) {
            lines.push('Available factories: ' + levelParts.join(', '));
            lines.push('');
        }
        
        // New opportunities
        if (results.reverse.length > 0) {
            lines.push('NEW Reverse Reactions:');
            for (var i = 0; i < Math.min(10, results.reverse.length); i++) {
                var r = results.reverse[i];
                var priceStr = r.compoundPrice > 0 ? ' @' + r.compoundPrice.toFixed(2) : ' (own stock)';
                lines.push('  ' + r.compound + priceStr + ' -> ' + r.reagentA + ' + ' + r.reagentB + ' | margin: ' + r.marginPct.toFixed(1) + '%');
            }
            if (results.reverse.length > 10) {
                lines.push('  ... and ' + (results.reverse.length - 10) + ' more');
            }
        } else {
            lines.push('NEW Reverse Reactions: None');
        }
        
        lines.push('');
        
        if (results.factory.length > 0) {
            lines.push('NEW Factory Products:');
            for (var j = 0; j < results.factory.length; j++) {
                var f = results.factory[j];
                var levelStr = f.requiredLevel > 0 ? ' [L' + f.requiredLevel + ']' : ' [L0]';
                lines.push('  ' + f.product + levelStr + ' | margin: ' + f.marginPct.toFixed(1) + '%');
            }
        } else {
            lines.push('NEW Factory Products: None');
        }
        
        lines.push('');
        
        // Skipped (already processing)
        if (results.skippedReverse.length > 0) {
            lines.push('ALREADY PROCESSING Reverse Reactions:');
            for (var sr = 0; sr < results.skippedReverse.length; sr++) {
                var skip = results.skippedReverse[sr];
                var marginStr = skip.marginPct !== null ? skip.marginPct.toFixed(1) + '%' : 'N/A';
                lines.push('  ' + skip.compound + ' @ ' + marginStr + ' - in ' + skip.room + ' (' + skip.state + ')');
            }
        }
        
        if (results.skippedFactory.length > 0) {
            lines.push('ALREADY PROCESSING Factory Products:');
            for (var sf = 0; sf < results.skippedFactory.length; sf++) {
                var skipF = results.skippedFactory[sf];
                var skipLevelStr = skipF.requiredLevel > 0 ? ' [L' + skipF.requiredLevel + ']' : '';
                var factoryMarginStr = skipF.marginPct !== null ? skipF.marginPct.toFixed(1) + '%' : 'N/A';
                lines.push('  ' + skipF.product + skipLevelStr + ' @ ' + factoryMarginStr + ' - in ' + skipF.room + ' (' + skipF.phase + ')');
            }
        }
        
        if (results.skippedSellLimit && results.skippedSellLimit.length > 0) {
            lines.push('');
            lines.push('SKIPPED (sell limit ' + MAX_SELL_AMOUNT + '):');
            for (var sl = 0; sl < results.skippedSellLimit.length; sl++) {
                var skipSell = results.skippedSellLimit[sl];
                lines.push('  ' + skipSell.compound + ' @ ' + skipSell.marginPct.toFixed(1) + '% - ' + skipSell.reason);
            }
        }
        
        return lines.join('\n');
    }
    
    if (command === 'run') {
        console.log('[autoTrader] Manual run triggered at tick ' + Game.time);
        
        var results = runAnalysis();
        
        mem.lastAnalysis = {
            tick: Game.time,
            reverseCount: results.reverse.length,
            factoryCount: results.factory.length
        };
        
        var jobs = executeJobs(results, false);
        
        mem.lastRun = Game.time;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) {
                mem.jobsStarted.push(jobs[k]);
            }
            // Keep only last 20 jobs
            if (mem.jobsStarted.length > 20) {
                mem.jobsStarted = mem.jobsStarted.slice(-20);
            }
        }
        
        return '[autoTrader] Run complete. Started ' + jobs.length + ' job(s).';
    }
    
    return '[autoTrader] Unknown command: ' + command + '. Use: run, analyze, enable, disable, reset, clearCooldown <product>';
};

// ===== Market Status Commands =====

global.selling = function(arg) {
    var orders = Game.market.orders;
    var sellOrders = [];
    
    for (var id in orders) {
        var order = orders[id];
        if (order.type === ORDER_SELL && order.remainingAmount > 0) {
            sellOrders.push(order);
        }
    }
    
    if (sellOrders.length === 0) {
        return '[selling] No active sell orders.';
    }
    
    // If arg is a resource type, filter to just that
    if (arg && arg !== 'compact') {
        var filtered = sellOrders.filter(function(o) { return o.resourceType === arg; });
        if (filtered.length === 0) {
            return '[selling] No sell orders for ' + arg;
        }
        
        var lines = ['[selling] ' + arg + ': ' + filtered.length + ' order(s)'];
        var total = 0;
        for (var i = 0; i < filtered.length; i++) {
            var o = filtered[i];
            total += o.remainingAmount;
            lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3));
        }
        lines.push('  Total: ' + total);
        return lines.join('\n');
    }
    
    // Group by resource
    var byResource = {};
    for (var i = 0; i < sellOrders.length; i++) {
        var order = sellOrders[i];
        var res = order.resourceType;
        if (!byResource[res]) {
            byResource[res] = { orders: [], total: 0 };
        }
        byResource[res].orders.push(order);
        byResource[res].total += order.remainingAmount;
    }
    
    // Sort resources by total amount descending
    var resources = Object.keys(byResource).sort(function(a, b) {
        return byResource[b].total - byResource[a].total;
    });
    
    var lines = ['[selling] ' + sellOrders.length + ' active sell order(s) across ' + resources.length + ' resource(s):', ''];
    
    if (arg === 'compact') {
        for (var j = 0; j < resources.length; j++) {
            var res = resources[j];
            var data = byResource[res];
            var avgPrice = 0;
            for (var k = 0; k < data.orders.length; k++) {
                avgPrice += data.orders[k].price;
            }
            avgPrice = avgPrice / data.orders.length;
            lines.push('  ' + res + ': ' + data.total + ' (' + data.orders.length + ' orders, avg ' + avgPrice.toFixed(3) + ')');
        }
    } else {
        for (var j = 0; j < resources.length; j++) {
            var res = resources[j];
            var data = byResource[res];
            lines.push(res + ': ' + data.total + ' total');
            for (var k = 0; k < data.orders.length; k++) {
                var o = data.orders[k];
                lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3));
            }
            lines.push('');
        }
    }
    
    return lines.join('\n');
};

global.buying = function(arg) {
    var orders = Game.market.orders;
    var buyOrders = [];
    
    for (var id in orders) {
        var order = orders[id];
        if (order.type === ORDER_BUY && order.remainingAmount > 0) {
            buyOrders.push(order);
        }
    }
    
    if (buyOrders.length === 0) {
        return '[buying] No active buy orders.';
    }
    
    // If arg is a resource type, filter to just that
    if (arg && arg !== 'compact') {
        var filtered = buyOrders.filter(function(o) { return o.resourceType === arg; });
        if (filtered.length === 0) {
            return '[buying] No buy orders for ' + arg;
        }
        
        var lines = ['[buying] ' + arg + ': ' + filtered.length + ' order(s)'];
        var total = 0;
        for (var i = 0; i < filtered.length; i++) {
            var o = filtered[i];
            total += o.remainingAmount;
            lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3));
        }
        lines.push('  Total: ' + total);
        return lines.join('\n');
    }
    
    // Group by resource
    var byResource = {};
    for (var i = 0; i < buyOrders.length; i++) {
        var order = buyOrders[i];
        var res = order.resourceType;
        if (!byResource[res]) {
            byResource[res] = { orders: [], total: 0 };
        }
        byResource[res].orders.push(order);
        byResource[res].total += order.remainingAmount;
    }
    
    // Sort resources by total amount descending
    var resources = Object.keys(byResource).sort(function(a, b) {
        return byResource[b].total - byResource[a].total;
    });
    
    var lines = ['[buying] ' + buyOrders.length + ' active buy order(s) across ' + resources.length + ' resource(s):', ''];
    
    if (arg === 'compact') {
        for (var j = 0; j < resources.length; j++) {
            var res = resources[j];
            var data = byResource[res];
            var avgPrice = 0;
            for (var k = 0; k < data.orders.length; k++) {
                avgPrice += data.orders[k].price;
            }
            avgPrice = avgPrice / data.orders.length;
            lines.push('  ' + res + ': ' + data.total + ' (' + data.orders.length + ' orders, avg ' + avgPrice.toFixed(3) + ')');
        }
    } else {
        for (var j = 0; j < resources.length; j++) {
            var res = resources[j];
            var data = byResource[res];
            lines.push(res + ': ' + data.total + ' total');
            for (var k = 0; k < data.orders.length; k++) {
                var o = data.orders[k];
                lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3));
            }
            lines.push('');
        }
    }
    
    return lines.join('\n');
};

// ===== Main Module Export =====

module.exports = {
    run: function() {
        var mem = ensureMemory();
        
        if (!mem.enabled) return;
        
        // Check if it's time to run
        if (mem.lastRun && (Game.time - mem.lastRun) < RUN_INTERVAL) {
            return;
        }
        
        getRoomState.init();
        
        var results = runAnalysis();
        
        mem.lastAnalysis = {
            tick: Game.time,
            reverseCount: results.reverse.length,
            factoryCount: results.factory.length
        };
        
        var jobs = executeJobs(results, false);
        
        mem.lastRun = Game.time;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) {
                mem.jobsStarted.push(jobs[k]);
            }
            if (mem.jobsStarted.length > 20) {
                mem.jobsStarted = mem.jobsStarted.slice(-20);
            }
        }
    }
};