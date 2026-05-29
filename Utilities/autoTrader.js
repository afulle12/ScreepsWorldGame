/**
 * autoTrader.js
 * 
 * Automated trading module that periodically analyzes market opportunities
 * and executes profitable reverse reactions (lab breakdown), forward reactions
 * (lab combination), factory refinement jobs, and factory decompression jobs.
 * 
 * RUNS EVERY 1000 TICKS:
 * 1. Analyzes Reverse Reaction profitability (buy compound -> break down -> sell reagents)
 * 2. Analyzes Forward Reaction profitability (buy reagents -> combine -> sell compound)
 * 3. Analyzes Factory Production profitability (buy minerals -> compress -> sell bars)
 * 4. Analyzes Factory Decompression profitability (buy bars -> decompress -> sell minerals)
 * 5. Filters for opportunities with >20% margin
 * 6. Skips any compound/product already being processed
 * 7. Matches jobs with eligible rooms (including factory level requirements)
 * 8. Executes up to 3 reverse reactions, 3 forward reactions, and 3 factory jobs per cycle
 *    (factory jobs pool covers both compression and decompression)
 * 
 * LAB JOB LIMIT: Each room may hold AT MOST 1 lab job (reverse OR forward) at a time.
 * A room with an active lab job is ineligible for new lab jobs until it finishes.
 * Factory jobs are unaffected by this limit.
 * 
 * PRICING ACCURACY:
 * This version uses actual marketBuy/marketSell pricing logic for profitability analysis:
 * - Buy prices: best BUY order + 0.1 (or hist*0.95 as fallback)
 * - Sell prices: best SELL order - 0.1, capped at hist*1.5 (or hist*1.05 fallback)
 * This matches the execution prices in marketBuy.js and marketSell.js, preventing
 * the phantom margin issues that occur when using raw order book prices.
 * 
 * CONSOLE COMMANDS:
 *   autoTrader()              - Show status and last run info
 *   autoTrader('run')         - Force immediate analysis and execution
 *   autoTrader('analyze')     - Run analysis only (no execution)
 *   autoTrader('reset')       - Reset memory
 *   autoTrader('enable')      - Enable automatic runs
 *   autoTrader('disable')     - Disable automatic runs
 *   autoTrader('rooms')       - Show per-room eligibility, active jobs, and why rooms are busy
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
var ENABLED = true;
var ENABLE_LAB_JOBS = true;                // Set to false to skip all lab reactions (reverse + forward)
var ENABLE_FACTORY_JOBS = true;            // Set to false to skip all factory compression jobs
var ENABLE_FACTORY_DECOMPRESSION = false;   // Set to false to skip all factory decompression jobs
var RUN_INTERVAL = 500;
var MARGIN_THRESHOLD = 40; // percent
var MAX_REVERSE_REACTIONS = 3;
var MAX_FORWARD_REACTIONS = 3;
var MAX_FACTORY_JOBS = 3;   // Shared pool covering both compression and decompression
var MIN_STORAGE_ENERGY = 150000;
var REQUIRED_SOURCES = 1;
var MIN_LABS = 3;
var MAX_SELL_AMOUNT = 21000; // Don't start jobs if we're already selling this much of a reagent
var FACTORY_JOB_COOLDOWN = 500; // Don't re-start the same factory product within this many ticks
var SELF_ARB_PRICE_BOOST = 1.05; // When buying from own rooms, allow 5% above market sell price

// Products the autoTrader will never start, regardless of margin
var BANNED_FACTORY_PRODUCTS = [RESOURCE_ENERGY]; // battery -> energy conversion banned

// localRefine integration: products that should use localRefine instead of marketRefine
var LOCAL_REFINE_PRODUCTS = [RESOURCE_BATTERY];
var LOCAL_REFINE_ENERGY_RESERVE = 200000;

// Supported factory compression products organized by level
var LEVEL_0_FACTORY_PRODUCTS = [
    RESOURCE_UTRIUM_BAR,
    RESOURCE_LEMERGIUM_BAR,
    RESOURCE_ZYNTHIUM_BAR,
    RESOURCE_KEANIUM_BAR,
    RESOURCE_GHODIUM_MELT,
    RESOURCE_OXIDANT,
    RESOURCE_REDUCTANT,
    RESOURCE_PURIFIER,
    RESOURCE_BATTERY,
    RESOURCE_WIRE,
    RESOURCE_CELL,
    RESOURCE_ALLOY,
    RESOURCE_CONDENSATE
];

var LEVEL_1_FACTORY_PRODUCTS = [
    RESOURCE_COMPOSITE,
    RESOURCE_TUBE,
    RESOURCE_PHLEGM,
    RESOURCE_SWITCH,
    RESOURCE_CONCENTRATE
];

var LEVEL_2_FACTORY_PRODUCTS = [
    RESOURCE_CRYSTAL,
    RESOURCE_FIXTURES,
    RESOURCE_TISSUE,
    RESOURCE_TRANSISTOR,
    RESOURCE_EXTRACT
];

var LEVEL_3_FACTORY_PRODUCTS = [
    RESOURCE_LIQUID,
    RESOURCE_FRAME,
    RESOURCE_MUSCLE,
    RESOURCE_MICROCHIP,
    RESOURCE_SPIRIT
];

var LEVEL_4_FACTORY_PRODUCTS = [
    RESOURCE_HYDRAULICS,
    RESOURCE_ORGANOID,
    RESOURCE_CIRCUIT,
    RESOURCE_EMANATION
];

var LEVEL_5_FACTORY_PRODUCTS = [
    RESOURCE_MACHINE,
    RESOURCE_ORGANISM,
    RESOURCE_DEVICE,
    RESOURCE_ESSENCE
];

// Combined list of all supported compression/production products
var SUPPORTED_FACTORY_PRODUCTS = LEVEL_0_FACTORY_PRODUCTS
    .concat(LEVEL_1_FACTORY_PRODUCTS)
    .concat(LEVEL_2_FACTORY_PRODUCTS)
    .concat(LEVEL_3_FACTORY_PRODUCTS)
    .concat(LEVEL_4_FACTORY_PRODUCTS)
    .concat(LEVEL_5_FACTORY_PRODUCTS);

// Decompression products: output is the raw mineral, input is the compressed bar.
// Recipes live in COMMODITIES (e.g. utrium_bar x100 + energy x200 -> utrium x500).
// All are any-level factory, cooldown 20 (battery->energy cooldown 10).
var DECOMPRESSION_PRODUCTS = [
    RESOURCE_UTRIUM,      // utrium_bar -> utrium
    RESOURCE_LEMERGIUM,   // lemergium_bar -> lemergium
    RESOURCE_ZYNTHIUM,    // zynthium_bar -> zynthium
    RESOURCE_KEANIUM,     // keanium_bar -> keanium
    RESOURCE_GHODIUM,     // ghodium_melt -> ghodium
    RESOURCE_OXYGEN,      // oxidant -> oxygen
    RESOURCE_HYDROGEN,    // reductant -> hydrogen
    RESOURCE_CATALYST,    // purifier -> catalyst
    RESOURCE_ENERGY       // battery -> energy
];

// ===== Memory Management =====

function ticksToTimeAgo(tickDiff) {
    var seconds = tickDiff * 3;
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);
    var days = Math.floor(hours / 24);
    if (days >= 1)   return days    + (days    === 1 ? ' day'  : ' days')  + ' ago';
    if (hours >= 1)  return hours   + (hours   === 1 ? ' hour' : ' hours') + ' ago';
    return               minutes + (minutes === 1 ? ' min'  : ' mins')  + ' ago';
}

function ensureMemory() {
    if (!Memory.autoTrader) {
        Memory.autoTrader = { enabled: true, lastRun: 0, lastAnalysis: null, jobsStarted: [] };
    }
    return Memory.autoTrader;
}

// ===== Price Helpers =====

function getOrderInfo(resource, orderType) {
    var orders = Game.market.getAllOrders({ resourceType: resource, type: orderType }) || [];
    var valid = [];
    var totalVolume = 0;
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        var amt = o.remainingAmount || o.amount || 0;
        if (amt > 0) { valid.push(o); totalVolume += amt; }
    }
    if (valid.length === 0) return { count: 0, totalVolume: 0, bestPrice: null, orders: [] };
    valid.sort(function(a, b) { return orderType === ORDER_BUY ? (b.price - a.price) : (a.price - b.price); });
    return { count: valid.length, totalVolume: totalVolume, bestPrice: valid[0].price, orders: valid };
}

function getAvg48h(resource) {
    var hist = Game.market.getHistory(resource) || [];
    if (!hist || hist.length === 0) return null;
    var last = hist[hist.length - 1];
    var prev = hist.length >= 2 ? hist[hist.length - 2] : null;
    var sumPV = 0, sumV = 0;
    if (last && typeof last.avgPrice === 'number' && typeof last.volume === 'number') { sumPV += last.avgPrice * last.volume; sumV += last.volume; }
    if (prev && typeof prev.avgPrice === 'number' && typeof prev.volume === 'number') { sumPV += prev.avgPrice * prev.volume; sumV += prev.volume; }
    if (sumV <= 0) return last && typeof last.avgPrice === 'number' ? last.avgPrice : null;
    return sumPV / sumV;
}

function getMyRooms() {
    var myRooms = {};
    for (var rn in Game.rooms) { var r = Game.rooms[rn]; if (r && r.controller && r.controller.my) myRooms[rn] = true; }
    return myRooms;
}

/**
 * Compute the actual price you'd pay when buying via marketBuy:
 * - If valid external BUY orders (>=1000 remaining) exist, use highest + 0.1
 * - Otherwise fall back to 95% of 48h average
 * Mirrors marketBuy.computeBuyPrice()
 */
function computeActualBuyPrice(resourceType) {
    var orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType }) || [];
    var myRooms = getMyRooms();
    var validOrders = [];
    
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o || typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
        if (o.roomName && myRooms[o.roomName]) continue;
        if (typeof o.price !== 'number') continue;
        validOrders.push(o);
    }
    
    validOrders.sort(function(a, b) { return b.price - a.price; });
    
    if (validOrders.length > 0) {
        return Math.max(validOrders[0].price + 0.1, 0.001);
    }
    
    var hist = Game.market.getHistory(resourceType) || [];
    var count = 0, sum = 0;
    if (hist.length >= 1 && typeof hist[hist.length - 1].avgPrice === 'number') { sum += hist[hist.length - 1].avgPrice; count++; }
    if (hist.length >= 2 && typeof hist[hist.length - 2].avgPrice === 'number') { sum += hist[hist.length - 2].avgPrice; count++; }
    var avg = count > 0 ? sum / count : 1;
    return Math.max(avg * 0.95, 0.001);
}

/**
 * Compute the actual price you'd receive when selling via marketSell:
 * - If valid external SELL orders (>=1000 remaining) exist, use lowest - 0.1, capped at 1.5x avg
 * - Otherwise fall back to 105% of 48h average
 * Mirrors marketSell.computePrice()
 */
function computeActualSellPrice(resourceType) {
    var orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType }) || [];
    var myRooms = getMyRooms();
    var validOrders = [];
    
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o || typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
        if (o.roomName && myRooms[o.roomName]) continue;
        if (typeof o.price !== 'number') continue;
        validOrders.push(o);
    }
    
    validOrders.sort(function(a, b) { return a.price - b.price; });
    
    var hist = Game.market.getHistory(resourceType) || [];
    var count = 0, sum = 0;
    if (hist.length >= 1 && typeof hist[hist.length - 1].avgPrice === 'number') { sum += hist[hist.length - 1].avgPrice; count++; }
    if (hist.length >= 2 && typeof hist[hist.length - 2].avgPrice === 'number') { sum += hist[hist.length - 2].avgPrice; count++; }
    var avg = count > 0 ? sum / count : 1;
    
    if (validOrders.length > 0) {
        var p = validOrders[0].price - 0.1;
        return Math.max(Math.min(p, avg * 1.5), 0.001);
    }
    return Math.max(avg * 1.05, 0.001);
}

function computeMarketBuyPrice(resource, mode) {
    // For energy sell price lookup
    if (resource === RESOURCE_ENERGY && mode === 'sell') return computeActualBuyPrice(resource);
    var orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resource }) || [];
    var myRooms = getMyRooms();
    var validOrders = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o || o.type !== ORDER_BUY) continue;
        if (typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
        if (o.roomName && myRooms[o.roomName]) continue;
        if (typeof o.price !== 'number') continue;
        validOrders.push(o);
    }
    validOrders.sort(function(a, b) { return b.price - a.price; });
    var totalVolume = 0;
    for (var j = 0; j < validOrders.length; j++) totalVolume += validOrders[j].remainingAmount || 0;
    if (validOrders.length > 0) {
        return { price: Math.max(validOrders[0].price + 0.1, 0.001), source: 'MBUY', orderCount: validOrders.length, volume: totalVolume };
    }
    var hist = Game.market.getHistory(resource) || [];
    var count = 0, sum = 0;
    if (hist.length >= 1) { var h1 = hist[hist.length - 1]; if (h1 && typeof h1.avgPrice === 'number') { sum += h1.avgPrice; count++; } }
    if (hist.length >= 2) { var h2 = hist[hist.length - 2]; if (h2 && typeof h2.avgPrice === 'number') { sum += h2.avgPrice; count++; } }
    return { price: Math.max((count > 0 ? sum / count : 1) * 0.95, 0.001), source: 'HIST', orderCount: 0, volume: 0 };
}

function priceOfWithSource(resource, mode) {
    // Use actual buy/sell prices (mirrors marketBuy.js and marketSell.js)
    if (mode === 'ACTUAL_BUY')  return { price: computeActualBuyPrice(resource),  source: 'ABUY',  orderCount: 0, volume: 0 };
    if (mode === 'ACTUAL_SELL') return { price: computeActualSellPrice(resource), source: 'ASELL', orderCount: 0, volume: 0 };
    
    // Legacy modes for backward compatibility
    if (resource === RESOURCE_ENERGY && mode === 'sell') return computeMarketBuyPrice(resource, 'sell');
    if (mode === 'avg') {
        var avg = getAvg48h(resource);
        if (avg !== null) return { price: avg, source: 'HIST', orderCount: 0, volume: 0 };
        var sellInfo = getOrderInfo(resource, ORDER_SELL);
        if (sellInfo.bestPrice !== null) return { price: sellInfo.bestPrice, source: 'LIVE', orderCount: sellInfo.count, volume: sellInfo.totalVolume };
        return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }
    if (mode === 'buy' || mode === 'sell') {
        var orderInfo = getOrderInfo(resource, mode === 'buy' ? ORDER_BUY : ORDER_SELL);
        if (orderInfo.bestPrice !== null) return { price: orderInfo.bestPrice, source: 'LIVE', orderCount: orderInfo.count, volume: orderInfo.totalVolume };
        var histPrice = getAvg48h(resource);
        if (histPrice !== null) return { price: histPrice, source: 'HIST', orderCount: 0, volume: 0 };
        return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }
    return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
}

// ===== Factory Level Helpers =====

function getProductFactoryLevel(product) {
    if (!COMMODITIES || !COMMODITIES[product]) return null;
    var recipe = COMMODITIES[product];
    return typeof recipe.level === 'number' ? recipe.level : 0;
}

function getRoomFactoryLevel(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.structuresByType || !state.structuresByType[STRUCTURE_FACTORY]) return null;
    var factories = state.structuresByType[STRUCTURE_FACTORY];
    if (factories.length === 0) return null;
    var factory = factories[0];
    return typeof factory.level === 'number' ? factory.level : 0;
}

function canRoomProduceProduct(roomName, product) {
    var requiredLevel = getProductFactoryLevel(product);
    if (requiredLevel === null) return false;
    var factoryLevel = getRoomFactoryLevel(roomName);
    if (factoryLevel === null) return false;
    if (requiredLevel === 0) return true;
    return factoryLevel === requiredLevel;
}

// ===== Opposite-Direction Conflict Detection =====

/**
 * Returns the product that is the direct opposite of this one:
 *   compression product  -> the decompression product whose input bar is this product
 *   decompression product -> the compression bar that this product decompresses into
 * Used to prevent starting both directions on the same resource pair simultaneously.
 */
function getOppositeFactoryProduct(product) {
    var isDecomp = DECOMPRESSION_PRODUCTS.indexOf(product) >= 0;
    var recipe = COMMODITIES && COMMODITIES[product];
    if (!recipe) return null;

    if (isDecomp) {
        // Decompression: the non-energy input component is the compression bar
        var comps = recipe.components || {};
        for (var res in comps) {
            if (comps.hasOwnProperty(res) && res !== RESOURCE_ENERGY) return res;
        }
    } else {
        // Compression: find which decompression product uses this bar as its input
        for (var i = 0; i < DECOMPRESSION_PRODUCTS.length; i++) {
            var decomp = DECOMPRESSION_PRODUCTS[i];
            var dr = COMMODITIES && COMMODITIES[decomp];
            if (!dr) continue;
            var dc = dr.components || {};
            if (dc.hasOwnProperty(product)) return decomp;
        }
    }
    return null;
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
            map[inner[b]] = [a, b];
        }
    }
    return map;
}

function analyzeReverseReaction(compound, reactionPairs, reagentSellMode, compoundBuyMode) {
    var pair = reactionPairs[compound];
    if (!pair) return null;
    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    var reagentA = pair[0], reagentB = pair[1];

    var compoundPrice, compoundInfo, compoundOpportunityCost;
    if (hasOwnRoomSellOrders(compound)) {
        var selfSellInfo = priceOfWithSource(compound, 'sell');
        var selfSellPrice = (selfSellInfo.price !== null) ? selfSellInfo.price : 0;
        compoundPrice = selfSellPrice > 0 ? selfSellPrice * SELF_ARB_PRICE_BOOST : 0;
        compoundInfo = { price: compoundPrice, source: 'OWN', volume: 0 };
        var oppInfo = priceOfWithSource(compound, compoundBuyMode);
        compoundOpportunityCost = (oppInfo.price !== null) ? oppInfo.price : 0;
    } else {
        compoundInfo = priceOfWithSource(compound, compoundBuyMode);
        compoundPrice = compoundInfo.price;
        compoundOpportunityCost = compoundPrice;
    }
    var totalCost = compoundOpportunityCost === null ? null : compoundOpportunityCost * batch;

    var priceAInfo = priceOfWithSource(reagentA, reagentSellMode);
    var priceBInfo = priceOfWithSource(reagentB, reagentSellMode);
    var revenueA = priceAInfo.price === null ? null : priceAInfo.price * batch;
    var revenueB = priceBInfo.price === null ? null : priceBInfo.price * batch;
    var totalRevenue = (revenueA !== null && revenueB !== null) ? revenueA + revenueB : (revenueA !== null ? revenueA : revenueB);

    var profit = (totalRevenue !== null && totalCost !== null) ? totalRevenue - totalCost : null;
    var marginPct = null;
    if (profit !== null && totalCost !== null && totalCost > 0) marginPct = (profit / totalCost) * 100;
    else if (profit !== null && totalCost === 0) marginPct = 9999;

    return { type: 'reverse', compound: compound, reagentA: reagentA, reagentB: reagentB, marginPct: marginPct, profit: profit, compoundPrice: compoundPrice, compoundVolume: compoundInfo.volume };
}

function analyzeForwardReaction(compound, reactionPairs, reagentBuyMode, compoundSellMode) {
    var pair = reactionPairs[compound];
    if (!pair) return null;
    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    var reagentA = pair[0], reagentB = pair[1];

    var reagentAPrice, reagentBPrice, reagentAOpportunityCost, reagentBOpportunityCost;

    if (hasOwnRoomSellOrders(reagentA)) {
        var ssA = priceOfWithSource(reagentA, 'sell'); reagentAPrice = (ssA.price !== null && ssA.price > 0) ? ssA.price * SELF_ARB_PRICE_BOOST : 0;
        var oA = priceOfWithSource(reagentA, reagentBuyMode); reagentAOpportunityCost = oA.price !== null ? oA.price : 0;
    } else { var pA = priceOfWithSource(reagentA, reagentBuyMode); reagentAPrice = pA.price; reagentAOpportunityCost = pA.price; }

    if (hasOwnRoomSellOrders(reagentB)) {
        var ssB = priceOfWithSource(reagentB, 'sell'); reagentBPrice = (ssB.price !== null && ssB.price > 0) ? ssB.price * SELF_ARB_PRICE_BOOST : 0;
        var oB = priceOfWithSource(reagentB, reagentBuyMode); reagentBOpportunityCost = oB.price !== null ? oB.price : 0;
    } else { var pB = priceOfWithSource(reagentB, reagentBuyMode); reagentBPrice = pB.price; reagentBOpportunityCost = pB.price; }

    var costA = reagentAOpportunityCost === null ? null : reagentAOpportunityCost * batch;
    var costB = reagentBOpportunityCost === null ? null : reagentBOpportunityCost * batch;
    var totalCost = (costA !== null && costB !== null) ? costA + costB : (costA !== null ? costA : costB);

    var compoundInfo = priceOfWithSource(compound, compoundSellMode);
    var totalRevenue = compoundInfo.price === null ? null : compoundInfo.price * batch;
    var profit = (totalRevenue !== null && totalCost !== null) ? totalRevenue - totalCost : null;
    var marginPct = null;
    if (profit !== null && totalCost !== null && totalCost > 0) marginPct = (profit / totalCost) * 100;
    else if (profit !== null && totalCost === 0) marginPct = 9999;

    return { type: 'forward', compound: compound, reagentA: reagentA, reagentB: reagentB, marginPct: marginPct, profit: profit, reagentAPrice: reagentAPrice, reagentBPrice: reagentBPrice, compoundPrice: compoundInfo.price, compoundVolume: compoundInfo.volume };
}

/**
 * Analyze profitability of a factory job: buy inputs -> produce -> sell output.
 * Works identically for compression (minerals -> bars) and decompression (bars -> minerals)
 * since both recipe types are in COMMODITIES and handled the same way by marketRefine.
 */
function analyzeFactoryProduct(resource, outputMode, inputMode) {
    var recipe = COMMODITIES && COMMODITIES[resource];
    if (!recipe) return null;

    var outQty = (typeof recipe.amount === 'number' && recipe.amount > 0) ? recipe.amount : 1;
    var comps = recipe.components || {};
    var totalCost = 0;
    var inputPrices = {};

    var isLocalRefineProduct = LOCAL_REFINE_PRODUCTS.indexOf(resource) >= 0;
    var isDecompress = DECOMPRESSION_PRODUCTS.indexOf(resource) >= 0;

    for (var res in comps) {
        if (!comps.hasOwnProperty(res)) continue;
        var qty = comps[res] || 0;

        if (isLocalRefineProduct) {
            inputPrices[res] = 0;
            var oppInfo = priceOfWithSource(res, inputMode);
            totalCost += (oppInfo.price !== null ? oppInfo.price * qty : 0);
            continue;
        }

        if (hasOwnRoomSellOrders(res)) {
            var selfSellInfo = priceOfWithSource(res, 'sell');
            var selfSellPrice = (selfSellInfo.price !== null) ? selfSellInfo.price : 0;
            inputPrices[res] = selfSellPrice > 0 ? selfSellPrice * SELF_ARB_PRICE_BOOST : 0;
            var oppInfo2 = priceOfWithSource(res, inputMode);
            var marketBuyPrice = (oppInfo2.price !== null) ? oppInfo2.price : 0;
            totalCost += Math.max(selfSellPrice, marketBuyPrice) * qty;
            continue;
        }

        var priceInfo = priceOfWithSource(res, inputMode);
        totalCost += (priceInfo.price === null ? 0 : priceInfo.price * qty);
        if (priceInfo.price !== null) inputPrices[res] = priceInfo.price;
    }

    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : (revenue - totalCost);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);
    if (profit !== null && totalCost === 0 && revenue > 0) marginPct = 9999;

    return {
        type: 'factory',
        product: resource,
        marginPct: marginPct,
        profit: profit,
        unitPrice: unitPrice,
        outputVolume: outputInfo.volume,
        requiredLevel: getProductFactoryLevel(resource),
        inputPrices: inputPrices,
        isLocalRefine: isLocalRefineProduct,
        isDecompress: isDecompress
    };
}

/**
 * Compute max buy prices for inputs to hit MARGIN_THRESHOLD% given the current
 * output sell price. Works identically for compression and decompression products.
 */
function computeInputPricesForMargin(product) {
    var recipe = COMMODITIES && COMMODITIES[product];
    if (!recipe) return null;
    var outQty = (typeof recipe.amount === 'number' && recipe.amount > 0) ? recipe.amount : 1;
    var comps = recipe.components || {};

    var sellInfo = priceOfWithSource(product, 'ACTUAL_SELL');
    if (sellInfo.price === null) return null;
    var revenue = sellInfo.price * outQty;
    var maxTotalCost = revenue / (1 + MARGIN_THRESHOLD / 100);

    var energyQty = comps[RESOURCE_ENERGY] || 0;
    var energyCost = 0;
    if (energyQty > 0) energyCost = computeActualBuyPrice(RESOURCE_ENERGY) * energyQty;

    var remainingBudget = maxTotalCost - energyCost;
    if (remainingBudget <= 0) return null;

    var naivePrices = {}, naiveCost = 0;
    for (var res in comps) {
        if (!comps.hasOwnProperty(res) || res === RESOURCE_ENERGY) continue;
        var priceInfo = priceOfWithSource(res, 'ACTUAL_SELL');
        naivePrices[res] = priceInfo.price !== null ? priceInfo.price : 0;
        naiveCost += naivePrices[res] * comps[res];
    }
    if (naiveCost <= 0) return null;

    var scaleFactor = Math.min(remainingBudget / naiveCost, 1.0);
    var inputPrices = {};
    for (var res2 in comps) {
        if (!comps.hasOwnProperty(res2) || res2 === RESOURCE_ENERGY) continue;
        inputPrices[res2] = naivePrices[res2] > 0 ? naivePrices[res2] * scaleFactor : 0;
    }
    return inputPrices;
}

// ===== Own-Room Detection =====

function hasOwnRoomSellOrders(resourceType) {
    var myRooms = getMyRooms();
    var allOrders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType }) || [];
    for (var i = 0; i < allOrders.length; i++) {
        var o = allOrders[i];
        if (o.roomName && myRooms[o.roomName] && (o.remainingAmount || o.amount || 0) > 0) return true;
    }
    return false;
}

// ===== Currently Processing Detection =====

function getCurrentSellAmount(resourceType) {
    var total = 0;
    var orders = Game.market.orders;
    for (var id in orders) {
        var order = orders[id];
        if (order.type === ORDER_SELL && order.resourceType === resourceType && order.remainingAmount > 0) total += order.remainingAmount;
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
                if (op && op.targetCompound && op.state !== 'SELLING') active[op.targetCompound] = { room: roomName, state: op.state };
            }
        }
    }
    return active;
}

function getActiveForwardReactions() {
    var active = {};
    if (Memory.marketLabForward && Memory.marketLabForward.rooms) {
        for (var roomName in Memory.marketLabForward.rooms) {
            var queue = Memory.marketLabForward.rooms[roomName];
            if (!queue) continue;
            for (var i = 0; i < queue.length; i++) {
                var op = queue[i];
                if (op && op.targetCompound && op.state !== 'SELLING') active[op.targetCompound] = { room: roomName, state: op.state };
            }
        }
    }
    return active;
}

function getActiveFactoryJobs() {
    var active = {};
    if (Memory.marketRefine && Memory.marketRefine.ops) {
        for (var i = 0; i < Memory.marketRefine.ops.length; i++) {
            var op = Memory.marketRefine.ops[i];
            if (op && op.output) active[op.output] = { room: op.room, phase: op.phase };
        }
    }
    // localRefine is authoritative for its products (checked before factoryOrders)
    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) {
        for (var lr = 0; lr < Memory.localRefine.ops.length; lr++) {
            var lrOp = Memory.localRefine.ops[lr];
            if (lrOp && lrOp.output) active[lrOp.output] = { room: lrOp.room, phase: lrOp.phase || 'localRefine' };
        }
    }
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (var j = 0; j < Memory.factoryOrders.length; j++) {
            var order = Memory.factoryOrders[j];
            if (order && order.product && !active[order.product]) active[order.product] = { room: order.room, phase: 'factoryOrder' };
        }
    }
    return active;
}

function getRoomActiveLabReverseCount(roomName) {
    if (!Memory.marketLabReverse || !Memory.marketLabReverse.rooms) return 0;
    var queue = Memory.marketLabReverse.rooms[roomName];
    if (!queue) return 0;
    var count = 0;
    for (var i = 0; i < queue.length; i++) {
        if (queue[i] && queue[i].state !== 'SELLING') count++;
    }
    return count;
}

function getRoomActiveLabForwardCount(roomName) {
    if (!Memory.marketLabForward || !Memory.marketLabForward.rooms) return 0;
    var queue = Memory.marketLabForward.rooms[roomName];
    if (!queue) return 0;
    var count = 0;
    for (var i = 0; i < queue.length; i++) {
        if (queue[i] && queue[i].state !== 'SELLING') count++;
    }
    return count;
}

function getRoomActiveLabCount(roomName) { return getRoomActiveLabReverseCount(roomName) + getRoomActiveLabForwardCount(roomName); }

function getRoomActiveFactoryCount(roomName) {
    var count = 0;
    if (Memory.marketRefine && Memory.marketRefine.ops) {
        for (var i = 0; i < Memory.marketRefine.ops.length; i++) { var op = Memory.marketRefine.ops[i]; if (op && op.room === roomName) count++; }
    }
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (var j = 0; j < Memory.factoryOrders.length; j++) { var order = Memory.factoryOrders[j]; if (order && order.room === roomName) count++; }
    }
    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) {
        for (var lr = 0; lr < Memory.localRefine.ops.length; lr++) { var lrOp = Memory.localRefine.ops[lr]; if (lrOp && lrOp.room === roomName) count++; }
    }
    return count;
}

function roomHasActiveFactoryJob(roomName) { return getRoomActiveFactoryCount(roomName) > 0; }

function isFactoryProductOnCooldown(product) {
    var mem = ensureMemory();
    if (!mem.jobsStarted) return false;
    for (var i = mem.jobsStarted.length - 1; i >= 0; i--) {
        var job = mem.jobsStarted[i];
        if (job.type === 'factory' && job.product === product) {
            return (Game.time - job.tick) < FACTORY_JOB_COOLDOWN;
        }
    }
    return false;
}

// ===== Room Eligibility =====

function roomHasSupplier(roomName) {
    for (var name in Game.creeps) { var creep = Game.creeps[name]; if (creep.memory.role === 'supplier' && creep.room.name === roomName) return true; }
    return false;
}

function getRoomLabCount(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.structuresByType || !state.structuresByType[STRUCTURE_LAB]) return 0;
    return state.structuresByType[STRUCTURE_LAB].length;
}

function isEligibleForLabReaction(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.controller || !state.controller.my || !state.terminal) return false;
    if (getRoomLabCount(roomName) < MIN_LABS) return false;
    if (!roomHasSupplier(roomName)) return false;
    return true;
}

var isEligibleForReverseReaction = isEligibleForLabReaction;

function isEligibleForFactoryBasic(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.controller || !state.controller.my || !state.terminal) return false;
    if (!state.structuresByType || !state.structuresByType[STRUCTURE_FACTORY] || state.structuresByType[STRUCTURE_FACTORY].length === 0) return false;
    if (!state.storage) return false;
    var storageEnergy = state.storage.store ? (state.storage.store[RESOURCE_ENERGY] || 0) : 0;
    if (storageEnergy < MIN_STORAGE_ENERGY) return false;
    if (!state.sources || state.sources.length < REQUIRED_SOURCES) return false;
    if (roomHasActiveFactoryJob(roomName)) return false;
    return true;
}

function isEligibleForFactory(roomName, product) {
    if (!isEligibleForFactoryBasic(roomName)) return false;
    if (!product) return true;
    return canRoomProduceProduct(roomName, product);
}

/**
 * Returns rooms eligible to receive a new lab job (reverse or forward).
 * KEY CHANGE: A room is only included if it has ZERO active lab jobs
 * (reverse + forward combined), enforcing the hard limit of 1 lab job per room.
 * Sorted by lab count descending so larger lab setups are preferred.
 */
function getEligibleLabReactionRooms() {
    var rooms = [];
    var allRooms = getRoomState.all();
    for (var roomName in allRooms) {
        if (!isEligibleForLabReaction(roomName)) continue;
        if (getRoomActiveLabCount(roomName) >= 1) continue; // hard cap: 1 job per room
        rooms.push({ name: roomName, labCount: getRoomLabCount(roomName) });
    }
    // Prefer rooms with more labs; random tiebreaking
    rooms.sort(function(a, b) {
        if (a.labCount !== b.labCount) return b.labCount - a.labCount;
        return Math.random() - 0.5;
    });
    return rooms;
}

var getEligibleReverseReactionRooms = getEligibleLabReactionRooms;

function getRoomStorageEnergy(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.storage || !state.storage.store) return 0;
    return state.storage.store[RESOURCE_ENERGY] || 0;
}

function getEligibleFactoryRooms(product) {
    var rooms = [];
    var allRooms = getRoomState.all();
    for (var roomName in allRooms) {
        if (isEligibleForFactory(roomName, product)) {
            rooms.push({ name: roomName, orderCount: getRoomActiveFactoryCount(roomName), storageEnergy: getRoomStorageEnergy(roomName), factoryLevel: getRoomFactoryLevel(roomName) });
        }
    }
    rooms.sort(function(a, b) {
        if (a.orderCount !== b.orderCount) return a.orderCount - b.orderCount;
        return b.storageEnergy - a.storageEnergy;
    });
    return rooms;
}

function getFactoryLevelSummary() {
    var summary = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    var allRooms = getRoomState.all();
    for (var roomName in allRooms) {
        var level = getRoomFactoryLevel(roomName);
        if (level !== null && isEligibleForFactoryBasic(roomName)) summary[level] = (summary[level] || 0) + 1;
    }
    return summary;
}

// ===== Room Status =====

function getRoomStatusDetail(roomName, activeReverse, activeForward, activeFactory) {
    var state = getRoomState.get(roomName);
    var result = { name: roomName, factory: null, lab: null };

    var factoryLevel = getRoomFactoryLevel(roomName);
    if (factoryLevel !== null) {
        var storageEnergy = getRoomStorageEnergy(roomName);
        var hasTerminal = !!(state && state.terminal);
        var hasSources = !!(state && state.sources && state.sources.length >= REQUIRED_SOURCES);
        var activeCount = getRoomActiveFactoryCount(roomName);
        var blockers = [];
        if (!hasTerminal) blockers.push('no terminal');
        if (!hasSources)  blockers.push('insufficient sources (need ' + REQUIRED_SOURCES + ')');
        if (storageEnergy < MIN_STORAGE_ENERGY) blockers.push('low energy (' + storageEnergy + ' < ' + MIN_STORAGE_ENERGY + ')');
        if (activeCount > 0) blockers.push('busy (' + activeCount + ' active job' + (activeCount > 1 ? 's' : '') + ')');

        var jobs = [];
        for (var prod in activeFactory) {
            if (activeFactory[prod].room === roomName) {
                jobs.push({ product: prod, phase: activeFactory[prod].phase, isDecompress: DECOMPRESSION_PRODUCTS.indexOf(prod) >= 0 });
            }
        }
        result.factory = { level: factoryLevel, storageEnergy: storageEnergy, hasTerminal: hasTerminal, hasSources: hasSources, eligible: blockers.length === 0, blockers: blockers, activeJobs: jobs };
    }

    var labCount = getRoomLabCount(roomName);
    if (labCount > 0) {
        var lBlockers = [];
        if (!(state && state.terminal)) lBlockers.push('no terminal');
        if (labCount < MIN_LABS)        lBlockers.push('too few labs (' + labCount + ' < ' + MIN_LABS + ')');
        if (!roomHasSupplier(roomName)) lBlockers.push('no supplier creep');
        if (getRoomActiveLabCount(roomName) >= 1) lBlockers.push('lab job in progress (1-job limit)');

        var reverseJobs = [], forwardJobs = [];
        for (var comp in activeReverse) { if (activeReverse[comp].room === roomName) reverseJobs.push({ compound: comp, state: activeReverse[comp].state }); }
        for (var fcomp in activeForward) { if (activeForward[fcomp].room === roomName) forwardJobs.push({ compound: fcomp, state: activeForward[fcomp].state }); }

        result.lab = { labCount: labCount, hasTerminal: !!(state && state.terminal), hasSupplier: roomHasSupplier(roomName), eligible: lBlockers.length === 0, blockers: lBlockers, activeReverse: reverseJobs, activeForward: forwardJobs };
    }

    return result;
}

function getRoomsReport(filter) {
    var allRooms = getRoomState.all();
    var activeReverse = getActiveReverseReactions();
    var activeForward = getActiveForwardReactions();
    var activeFactory = getActiveFactoryJobs();
    var roomNames = Object.keys(allRooms).sort();
    var lines = ['[autoTrader] Room Status (tick ' + Game.time + '):', ''];
    var shown = 0;

    for (var ri = 0; ri < roomNames.length; ri++) {
        var roomName = roomNames[ri];
        var state = getRoomState.get(roomName);
        if (!state || !state.controller || !state.controller.my) continue;
        if (filter && roomName.toLowerCase().indexOf(filter.toLowerCase()) < 0) continue;
        var d = getRoomStatusDetail(roomName, activeReverse, activeForward, activeFactory);
        shown++;
        lines.push('=== ' + roomName + ' ===');

        if (d.factory) {
            var f = d.factory;
            lines.push('  Factory [L' + f.level + '] ' + (f.eligible ? 'ELIGIBLE' : 'INELIGIBLE'));
            lines.push('    energy:   ' + f.storageEnergy + (f.storageEnergy < MIN_STORAGE_ENERGY ? ' (need ' + MIN_STORAGE_ENERGY + ')' : ' OK'));
            lines.push('    terminal: ' + (f.hasTerminal ? 'yes' : 'NO'));
            lines.push('    sources:  ' + (f.hasSources ? 'yes' : 'NO'));
            if (f.blockers.length > 0) lines.push('    BLOCKED:  ' + f.blockers.join('; '));
            if (f.activeJobs.length > 0) {
                lines.push('    Running:');
                for (var ji = 0; ji < f.activeJobs.length; ji++) {
                    var jTag = f.activeJobs[ji].isDecompress ? ' [decomp]' : '';
                    lines.push('      -> ' + f.activeJobs[ji].product + jTag + ' [' + f.activeJobs[ji].phase + ']');
                }
            } else { lines.push('    Running:  (none)'); }
        } else { lines.push('  Factory: none'); }

        if (d.lab) {
            var l = d.lab;
            lines.push('  Labs [' + l.labCount + '] ' + (l.eligible ? 'ELIGIBLE' : 'INELIGIBLE') + ' (max 1 job/room)');
            lines.push('    terminal: ' + (l.hasTerminal ? 'yes' : 'NO'));
            lines.push('    supplier: ' + (l.hasSupplier ? 'yes' : 'NO'));
            lines.push('    labs:     ' + l.labCount + (l.labCount < MIN_LABS ? ' (need ' + MIN_LABS + ')' : ' OK'));
            if (l.blockers.length > 0) lines.push('    BLOCKED:  ' + l.blockers.join('; '));
            if (l.activeReverse.length > 0 || l.activeForward.length > 0) {
                lines.push('    Running:');
                for (var rvi = 0; rvi < l.activeReverse.length; rvi++) lines.push('      -> reverse: ' + l.activeReverse[rvi].compound + ' [' + l.activeReverse[rvi].state + ']');
                for (var fwi = 0; fwi < l.activeForward.length; fwi++) lines.push('      -> forward: ' + l.activeForward[fwi].compound + ' [' + l.activeForward[fwi].state + ']');
            } else { lines.push('    Running:  (none)'); }
        } else { lines.push('  Labs: none'); }

        lines.push('');
    }

    if (shown === 0) lines.push(filter ? '  No owned rooms matching "' + filter + '"' : '  No owned rooms found.');
    return lines.join('\n');
}

// ===== Main Analysis & Execution =====

function runAnalysis() {
    var reactionPairs = buildReactionMap();
    var allCompounds = Object.keys(reactionPairs);

    var activeReverse = getActiveReverseReactions();
    var activeForward = getActiveForwardReactions();
    var activeFactory = getActiveFactoryJobs();

    var opportunities = { reverse: [], forward: [], factory: [] };
    var skippedReverse = [], skippedForward = [], skippedFactory = [], skippedSellLimit = [];

    // -- Reverse lab reactions
    // Use ACTUAL_SELL for reagent revenue and ACTUAL_BUY for compound cost.
    // Guard against both activeReverse AND activeForward for the same compound —
    // running forward and reverse on the same compound simultaneously is wasteful
    // and can arise from large bid-ask spreads making both directions look profitable.
    if (ENABLE_LAB_JOBS) {
        for (var i = 0; i < allCompounds.length; i++) {
            var compound = allCompounds[i];
            var analysis = analyzeReverseReaction(compound, reactionPairs, 'ACTUAL_SELL', 'ACTUAL_BUY');
            if (!analysis) continue;
            if (activeReverse[compound]) { skippedReverse.push({ compound: compound, marginPct: analysis.marginPct, room: activeReverse[compound].room, state: activeReverse[compound].state }); continue; }
            if (activeForward[compound]) { continue; } // don't reverse what we're already building
            if (analysis.marginPct === null || analysis.marginPct < MARGIN_THRESHOLD) continue;
            if (getCurrentSellAmount(analysis.reagentA) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: compound, marginPct: analysis.marginPct, reason: analysis.reagentA + ' at sell limit' }); continue; }
            if (getCurrentSellAmount(analysis.reagentB) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: compound, marginPct: analysis.marginPct, reason: analysis.reagentB + ' at sell limit' }); continue; }
            opportunities.reverse.push(analysis);
        }
    }

    // Build a lookup of compounds queued for reverse this cycle so forward can avoid
    // starting the opposite direction in the same run (even when neither is currently active).
    var reverseQueued = {};
    for (var rqi = 0; rqi < opportunities.reverse.length; rqi++) {
        reverseQueued[opportunities.reverse[rqi].compound] = true;
    }

    // -- Forward lab reactions
    // Use ACTUAL_BUY for reagent cost and ACTUAL_SELL for compound revenue.
    // Guards: skip if forward already active, reverse already active, OR reverse queued
    // this cycle (prevents same-run circular start when bid-ask spreads make both
    // directions look profitable simultaneously).
    if (ENABLE_LAB_JOBS) {
        for (var fi = 0; fi < allCompounds.length; fi++) {
            var fCompound = allCompounds[fi];
            var fAnalysis = analyzeForwardReaction(fCompound, reactionPairs, 'ACTUAL_BUY', 'ACTUAL_SELL');
            if (!fAnalysis) continue;
            if (activeForward[fCompound]) { skippedForward.push({ compound: fCompound, marginPct: fAnalysis.marginPct, room: activeForward[fCompound].room, state: activeForward[fCompound].state }); continue; }
            if (activeReverse[fCompound]) continue;
            if (reverseQueued[fCompound]) continue; // higher-margin direction already queued this cycle
            if (fAnalysis.marginPct === null || fAnalysis.marginPct < MARGIN_THRESHOLD) continue;
            if (getCurrentSellAmount(fCompound) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: fCompound, marginPct: fAnalysis.marginPct, reason: fCompound + ' at sell limit' }); continue; }
            opportunities.forward.push(fAnalysis);
        }
    }

    // -- Factory helper (shared by compression + decompression)
    function evalFactoryProduct(product) {
        if (BANNED_FACTORY_PRODUCTS.indexOf(product) >= 0) return;

        var fa = analyzeFactoryProduct(product, 'ACTUAL_SELL', 'ACTUAL_BUY');
        if (!fa) return;
        if (activeFactory[product]) {
            skippedFactory.push({ product: product, marginPct: fa.marginPct, room: activeFactory[product].room, phase: activeFactory[product].phase, requiredLevel: fa.requiredLevel, isDecompress: fa.isDecompress });
            return;
        }

        var opposite = getOppositeFactoryProduct(product);
        if (opposite) {
            if (activeFactory[opposite]) {
                console.log('[autoTrader] Skipped ' + product + (fa.isDecompress ? ' [decomp]' : '') +
                    ': opposite direction ' + opposite + ' already active in ' + activeFactory[opposite].room);
                return;
            }
            for (var oi = 0; oi < opportunities.factory.length; oi++) {
                if (opportunities.factory[oi].product === opposite) {
                    if ((fa.marginPct || 0) > (opportunities.factory[oi].marginPct || 0)) {
                        opportunities.factory.splice(oi, 1);
                    } else {
                        return;
                    }
                    break;
                }
            }
        }

        if (isFactoryProductOnCooldown(product)) {
            skippedFactory.push({ product: product, marginPct: fa.marginPct, room: '?', phase: 'cooldown', requiredLevel: fa.requiredLevel, isDecompress: fa.isDecompress });
            return;
        }
        if (fa.marginPct === null || fa.marginPct < MARGIN_THRESHOLD) return;
        if (getCurrentSellAmount(product) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: product, marginPct: fa.marginPct, reason: product + ' at sell limit' }); return; }
        if (getEligibleFactoryRooms(product).length === 0) return;
        opportunities.factory.push(fa);
    }

    // -- Compression
    if (ENABLE_FACTORY_JOBS) {
        for (var j = 0; j < SUPPORTED_FACTORY_PRODUCTS.length; j++) evalFactoryProduct(SUPPORTED_FACTORY_PRODUCTS[j]);
    }

    // -- Decompression
    if (ENABLE_FACTORY_DECOMPRESSION) {
        for (var d = 0; d < DECOMPRESSION_PRODUCTS.length; d++) evalFactoryProduct(DECOMPRESSION_PRODUCTS[d]);
    }

    opportunities.reverse.sort(function(a, b) { return (b.marginPct || 0) - (a.marginPct || 0); });
    opportunities.forward.sort(function(a, b) { return (b.marginPct || 0) - (a.marginPct || 0); });
    opportunities.factory.sort(function(a, b) { return (b.marginPct || 0) - (a.marginPct || 0); });

    if (opportunities.reverse.length > 0) {
        var list = opportunities.reverse.slice(0, 3).map(function(o) { return o.compound + '(' + o.marginPct.toFixed(0) + '%)'; });
        console.log('[autoTrader] NEW reverse: ' + list.join(', ') + (opportunities.reverse.length > 3 ? ' +' + (opportunities.reverse.length - 3) + ' more' : ''));
    }
    if (opportunities.forward.length > 0) {
        var flist = opportunities.forward.slice(0, 3).map(function(o) { return o.compound + '(' + o.marginPct.toFixed(0) + '%)'; });
        console.log('[autoTrader] NEW forward: ' + flist.join(', ') + (opportunities.forward.length > 3 ? ' +' + (opportunities.forward.length - 3) + ' more' : ''));
    }
    if (opportunities.factory.length > 0) {
        var compList = [], decompList = [];
        for (var f = 0; f < opportunities.factory.length; f++) {
            var fOpp = opportunities.factory[f];
            var entry = fOpp.product + (fOpp.requiredLevel > 0 ? ' L' + fOpp.requiredLevel : '') + '(' + fOpp.marginPct.toFixed(0) + '%)';
            if (fOpp.isDecompress) decompList.push(entry); else compList.push(entry);
        }
        if (compList.length > 0)   console.log('[autoTrader] NEW compress:   ' + compList.join(', '));
        if (decompList.length > 0) console.log('[autoTrader] NEW decompress: ' + decompList.join(', '));
    }
    if (skippedSellLimit.length > 0) {
        var slList = skippedSellLimit.slice(0, 3).map(function(x) { return x.compound; });
        console.log('[autoTrader] Skipped (sell limit): ' + slList.join(', ') + (skippedSellLimit.length > 3 ? ' +' + (skippedSellLimit.length - 3) + ' more' : ''));
    }

    return { reverse: opportunities.reverse, forward: opportunities.forward, factory: opportunities.factory, skippedReverse: skippedReverse, skippedForward: skippedForward, skippedFactory: skippedFactory, skippedSellLimit: skippedSellLimit };
}

function executeJobs(opportunities, dryRun) {
    var labRooms = getEligibleLabReactionRooms();
    var jobsStarted = [], reverseStarted = 0, forwardStarted = 0, factoryStarted = 0;

    // -- Reverse lab reactions
    // Each room accepts at most 1 lab job total. After assigning a job the room
    // is spliced out so it cannot receive a second job this cycle.
    if (ENABLE_LAB_JOBS) {
        for (var i = 0; i < opportunities.reverse.length && reverseStarted < MAX_REVERSE_REACTIONS; i++) {
            if (labRooms.length === 0) break;
            var opp = opportunities.reverse[i];
            var targetRoom = labRooms[0];
            if (!dryRun) {
                var maxPrice = opp.compoundPrice > 0 ? opp.compoundPrice : undefined;
                global.labReverse(targetRoom.name, opp.compound, maxPrice);
                console.log('[autoTrader] Started reverse ' + opp.compound + ' -> ' + opp.reagentA + '+' + opp.reagentB + ' (' + opp.marginPct.toFixed(0) + '%) in ' + targetRoom.name + (maxPrice ? ' (max ' + maxPrice.toFixed(3) + ')' : ' (own stock)'));
                jobsStarted.push({ type: 'reverse', compound: opp.compound, room: targetRoom.name, margin: opp.marginPct, maxPrice: opp.compoundPrice, tick: Game.time });
            }
            reverseStarted++;
            labRooms.splice(0, 1); // room is now at its 1-job limit; remove from pool
        }
    }

    // -- Forward lab reactions
    if (ENABLE_LAB_JOBS) {
        for (var fi = 0; fi < opportunities.forward.length && forwardStarted < MAX_FORWARD_REACTIONS; fi++) {
            if (labRooms.length === 0) break;
            var fOpp = opportunities.forward[fi];
            var fTargetRoom = labRooms[0];
            if (!dryRun) {
                global.labForward(fTargetRoom.name, fOpp.compound);
                console.log('[autoTrader] Started forward ' + fOpp.reagentA + '+' + fOpp.reagentB + ' -> ' + fOpp.compound + ' (' + fOpp.marginPct.toFixed(0) + '%) in ' + fTargetRoom.name);
                jobsStarted.push({ type: 'forward', compound: fOpp.compound, room: fTargetRoom.name, margin: fOpp.marginPct, reagentAPrice: fOpp.reagentAPrice, reagentBPrice: fOpp.reagentBPrice, tick: Game.time });
            }
            forwardStarted++;
            labRooms.splice(0, 1); // room is now at its 1-job limit; remove from pool
        }
    }

    // -- Factory jobs (compression + decompression share MAX_FACTORY_JOBS)
    if (ENABLE_FACTORY_JOBS || ENABLE_FACTORY_DECOMPRESSION) {
        for (var j = 0; j < opportunities.factory.length && factoryStarted < MAX_FACTORY_JOBS; j++) {
            var factoryOpp = opportunities.factory[j];

            if (factoryOpp.isDecompress  && !ENABLE_FACTORY_DECOMPRESSION) continue;
            if (!factoryOpp.isDecompress && !factoryOpp.isLocalRefine && !ENABLE_FACTORY_JOBS) continue;

            var factoryRooms = getEligibleFactoryRooms(factoryOpp.product);
            if (factoryRooms.length === 0) {
                var allRooms = getRoomState.all();
                var busyRooms = [];
                for (var brn in allRooms) { if (canRoomProduceProduct(brn, factoryOpp.product) && roomHasActiveFactoryJob(brn)) busyRooms.push(brn); }
                var tag = factoryOpp.isDecompress ? ' [decomp]' : '';
                console.log('[autoTrader] Skipped ' + factoryOpp.product + tag + ' (' + factoryOpp.marginPct.toFixed(0) + '%): ' + (busyRooms.length > 0 ? 'rooms busy - ' + busyRooms.join(', ') : 'no eligible rooms'));
                continue;
            }

            var factoryRoom = factoryRooms[0];

            if (!dryRun) {
                var isLocalRefine = LOCAL_REFINE_PRODUCTS.indexOf(factoryOpp.product) >= 0;

                if (isLocalRefine) {
                    var currentEnergy = getRoomStorageEnergy(factoryRoom.name);
                    var refineAmount = currentEnergy - LOCAL_REFINE_ENERGY_RESERVE;
                    if (refineAmount < 1000) continue;
                    var localResult = global.localRefine(factoryRoom.name, factoryOpp.product, refineAmount);
                    var localRefineOpId = null;
                    if (typeof localResult === 'string') { var lrMatch = localResult.match(/Started (lref_[^\s|]+)/); if (lrMatch) localRefineOpId = lrMatch[1]; }
                    console.log('[autoTrader] Started ' + factoryOpp.product + ' via localRefine (' + factoryOpp.marginPct.toFixed(0) + '%) in ' + factoryRoom.name + ' (' + refineAmount + ' energy)' + (localRefineOpId ? ' [' + localRefineOpId + ']' : ''));
                    jobsStarted.push({ type: 'factory', product: factoryOpp.product, room: factoryRoom.name, margin: factoryOpp.marginPct, level: factoryOpp.requiredLevel, method: 'localRefine', localRefineOpId: localRefineOpId, amount: refineAmount, tick: Game.time });
                } else {
                    var execInputPrices = computeInputPricesForMargin(factoryOpp.product) || factoryOpp.inputPrices;
                    global.marketRefine(factoryRoom.name, factoryOpp.product, execInputPrices);
                    var levelStr = factoryOpp.requiredLevel > 0 ? ' [L' + factoryOpp.requiredLevel + ']' : '';
                    var decompStr = factoryOpp.isDecompress ? ' [decomp]' : '';
                    var priceEntries = [];
                    for (var res in execInputPrices) priceEntries.push(res + ':' + (execInputPrices[res] > 0 ? execInputPrices[res].toFixed(3) : 'OWN'));
                    console.log('[autoTrader] Started ' + factoryOpp.product + levelStr + decompStr + ' (' + factoryOpp.marginPct.toFixed(0) + '%) in ' + factoryRoom.name + ' (max ' + priceEntries.join(', ') + ')');
                    jobsStarted.push({ type: 'factory', product: factoryOpp.product, room: factoryRoom.name, margin: factoryOpp.marginPct, level: factoryOpp.requiredLevel, isDecompress: factoryOpp.isDecompress, maxInputPrices: execInputPrices, tick: Game.time });
                }
            }

            factoryStarted++;
        }
    }

    return jobsStarted;
}

// ===== Console API =====

function countFactoryOpps(factoryArr) {
    var c = 0, d = 0;
    for (var i = 0; i < factoryArr.length; i++) { if (factoryArr[i].isDecompress) d++; else c++; }
    return { compressCount: c, decompressCount: d };
}

function getStatus() {
    var mem = ensureMemory();
    var lines = [];
    lines.push('[autoTrader] Status');
    lines.push('  Enabled: ' + (mem.enabled ? 'YES' : 'NO'));
    lines.push('  Lab jobs: ' + (ENABLE_LAB_JOBS ? 'ON' : 'OFF') + ' (max 1 per room)');
    lines.push('  Factory compression: ' + (ENABLE_FACTORY_JOBS ? 'ON' : 'OFF'));
    lines.push('  Factory decompression: ' + (ENABLE_FACTORY_DECOMPRESSION ? 'ON' : 'OFF'));
    lines.push('  Banned factory products: ' + (BANNED_FACTORY_PRODUCTS.length > 0 ? BANNED_FACTORY_PRODUCTS.join(', ') : 'none'));
    lines.push('  Run interval: ' + RUN_INTERVAL + ' ticks');
    lines.push('  Last run: ' + (mem.lastRun ? (Game.time - mem.lastRun) + ' ticks ago (tick ' + mem.lastRun + ')' : 'never'));
    lines.push('  Next run in: ' + (mem.lastRun ? Math.max(0, RUN_INTERVAL - (Game.time - mem.lastRun)) + ' ticks' : 'immediately'));
    lines.push('');
    lines.push('  Margin threshold: ' + MARGIN_THRESHOLD + '%');
    lines.push('  Max sell amount per resource: ' + MAX_SELL_AMOUNT);
    lines.push('  Max reverse reactions per cycle: ' + MAX_REVERSE_REACTIONS);
    lines.push('  Max forward reactions per cycle: ' + MAX_FORWARD_REACTIONS);
    lines.push('  Max factory jobs per cycle: ' + MAX_FACTORY_JOBS + ' (shared: compression + decompression)');
    lines.push('  localRefine products: ' + LOCAL_REFINE_PRODUCTS.join(', '));
    lines.push('  localRefine energy reserve: ' + LOCAL_REFINE_ENERGY_RESERVE);

    var levelSummary = getFactoryLevelSummary();
    var levelParts = [];
    for (var lvl = 0; lvl <= 5; lvl++) { if (levelSummary[lvl] > 0) levelParts.push('L' + lvl + ':' + levelSummary[lvl]); }
    if (levelParts.length > 0) lines.push('  Available factories: ' + levelParts.join(', '));

    if (mem.lastAnalysis) {
        lines.push('');
        lines.push('  Last analysis (tick ' + mem.lastAnalysis.tick + '):');
        lines.push('    Reverse opportunities:    ' + mem.lastAnalysis.reverseCount);
        lines.push('    Forward opportunities:    ' + mem.lastAnalysis.forwardCount);
        lines.push('    Compress opportunities:   ' + (mem.lastAnalysis.compressCount || 0));
        lines.push('    Decompress opportunities: ' + (mem.lastAnalysis.decompressCount || 0));
    }

    if (mem.jobsStarted && mem.jobsStarted.length > 0) {
        var activeReverse = getActiveReverseReactions();
        var activeForward = getActiveForwardReactions();
        var activeFactory = getActiveFactoryJobs();
        lines.push('');
        lines.push('  Recent jobs started:');

        var allJobs = mem.jobsStarted;
        var recentJobs = allJobs.slice(-10);
        var recentStartIdx = allJobs.length - recentJobs.length;

        for (var i = 0; i < recentJobs.length; i++) {
            var job = recentJobs[i];
            var desc = (job.type === 'reverse' || job.type === 'forward') ? job.compound : job.product;
            var levelInfo = job.level > 0 ? ' [L' + job.level + ']' : '';
            var methodInfo = job.method === 'localRefine' ? ' [local]' : (job.isDecompress ? ' [decomp]' : '');
            var priceInfo = job.maxPrice ? ' @' + job.maxPrice.toFixed(2) : '';
            var amountInfo = job.amount ? ' (' + job.amount + ')' : '';
            var timeAgo = ticksToTimeAgo(Game.time - job.tick);

            var isLatestForKey = true;
            for (var li = recentStartIdx + i + 1; li < allJobs.length; li++) {
                var lj = allJobs[li];
                var ljKey = (lj.type === 'reverse' || lj.type === 'forward') ? lj.compound : lj.product;
                if (lj.type === job.type && ljKey === desc) { isLatestForKey = false; break; }
            }

            var stage = '';
            if (!isLatestForKey) {
                stage = ' [done]';
            } else if (job.type === 'reverse') {
                stage = (activeReverse[job.compound] && activeReverse[job.compound].room === job.room) ? ' [' + activeReverse[job.compound].state + ']' : ' [done]';
            } else if (job.type === 'forward') {
                stage = (activeForward[job.compound] && activeForward[job.compound].room === job.room) ? ' [' + activeForward[job.compound].state + ']' : ' [done]';
            } else if (job.type === 'factory' && job.method === 'localRefine') {
                var lrOps = (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) ? Memory.localRefine.ops : [];
                if (job.localRefineOpId) {
                    var found = false;
                    for (var lri = 0; lri < lrOps.length; lri++) { if (lrOps[lri] && lrOps[lri].id === job.localRefineOpId) { stage = ' [' + lrOps[lri].phase + ']'; found = true; break; } }
                    if (!found) stage = ' [done]';
                } else {
                    var matches = lrOps.filter(function(o) { return o && o.room === job.room && o.output === job.product; });
                    stage = matches.length === 0 ? ' [done]' : (matches.length === 1 ? (matches[0].started > job.tick ? ' [done]' : ' [' + matches[0].phase + ']') : ' [unknown]');
                }
            } else if (job.type === 'factory') {
                stage = (activeFactory[job.product] && activeFactory[job.product].room === job.room) ? ' [' + activeFactory[job.product].phase + ']' : ' [done]';
            } else {
                stage = ' [done]';
            }

            lines.push('    [' + timeAgo + '] ' + job.type + ': ' + desc + levelInfo + methodInfo + priceInfo + amountInfo + ' in ' + job.room + ' (' + job.margin.toFixed(1) + '%)' + stage);
        }
    }

    return lines.join('\n');
}

global.autoTrader = function(command) {
    var mem = ensureMemory();
    getRoomState.init();

    if (!command) return getStatus();
    if (command === 'enable')  { mem.enabled = true;  return '[autoTrader] Enabled automatic runs.'; }
    if (command === 'disable') { mem.enabled = false; return '[autoTrader] Disabled automatic runs.'; }
    if (command === 'reset')   { Memory.autoTrader = null; ensureMemory(); return '[autoTrader] Memory reset.'; }

    if (typeof command === 'string' && command.indexOf('clearCooldown') === 0) {
        var product = command.split(' ')[1];
        if (!product) return '[autoTrader] Usage: autoTrader("clearCooldown composite")';
        var search = product.toLowerCase();
        if (!mem.jobsStarted) return '[autoTrader] No jobs in history.';
        var removed = 0;
        for (var ci = mem.jobsStarted.length - 1; ci >= 0; ci--) {
            var cj = mem.jobsStarted[ci];
            if (cj.type === 'factory' && cj.product && cj.product.toLowerCase().indexOf(search) >= 0) { mem.jobsStarted.splice(ci, 1); removed++; }
        }
        return '[autoTrader] Cleared ' + removed + ' job(s) matching "' + product + '" from history.';
    }

    if (typeof command === 'string' && (command === 'rooms' || command.indexOf('rooms ') === 0)) {
        return getRoomsReport(command === 'rooms' ? null : command.slice(6).trim() || null);
    }

    if (command === 'analyze') {
        var results = runAnalysis();
        var counts = countFactoryOpps(results.factory);
        mem.lastAnalysis = { tick: Game.time, reverseCount: results.reverse.length, forwardCount: results.forward.length, compressCount: counts.compressCount, decompressCount: counts.decompressCount };

        var lines = ['[autoTrader] Analysis Results (margin >= ' + MARGIN_THRESHOLD + '%):', ''];

        var disabledParts = [];
        if (!ENABLE_LAB_JOBS)              disabledParts.push('lab jobs');
        if (!ENABLE_FACTORY_JOBS)          disabledParts.push('factory compression');
        if (!ENABLE_FACTORY_DECOMPRESSION) disabledParts.push('factory decompression');
        if (disabledParts.length > 0) { lines.push('NOTE: ' + disabledParts.join(', ') + ' disabled'); lines.push(''); }

        if (BANNED_FACTORY_PRODUCTS.length > 0) { lines.push('NOTE: banned factory products: ' + BANNED_FACTORY_PRODUCTS.join(', ')); lines.push(''); }

        var levelSummary = getFactoryLevelSummary();
        var levelParts = [];
        for (var lvl = 0; lvl <= 5; lvl++) { if (levelSummary[lvl] > 0) levelParts.push('L' + lvl + ':' + levelSummary[lvl]); }
        if (levelParts.length > 0) { lines.push('Available factories: ' + levelParts.join(', ')); lines.push(''); }

        if (results.reverse.length > 0) {
            lines.push('NEW Reverse Reactions:');
            for (var i = 0; i < Math.min(10, results.reverse.length); i++) {
                var r = results.reverse[i];
                lines.push('  ' + r.compound + (r.compoundPrice > 0 ? ' @' + r.compoundPrice.toFixed(2) : ' (own stock)') + ' -> ' + r.reagentA + ' + ' + r.reagentB + ' | margin: ' + r.marginPct.toFixed(1) + '%');
            }
            if (results.reverse.length > 10) lines.push('  ... and ' + (results.reverse.length - 10) + ' more');
        } else { lines.push('NEW Reverse Reactions: None' + (!ENABLE_LAB_JOBS ? ' (disabled)' : '')); }
        lines.push('');

        if (results.forward.length > 0) {
            lines.push('NEW Forward Reactions:');
            for (var fwi = 0; fwi < Math.min(10, results.forward.length); fwi++) {
                var fw = results.forward[fwi];
                var rps = (fw.reagentAPrice > 0 || fw.reagentBPrice > 0) ? ' (buy ' + fw.reagentA + '@' + (fw.reagentAPrice > 0 ? fw.reagentAPrice.toFixed(2) : 'OWN') + ' + ' + fw.reagentB + '@' + (fw.reagentBPrice > 0 ? fw.reagentBPrice.toFixed(2) : 'OWN') + ')' : ' (own stock)';
                lines.push('  ' + fw.reagentA + ' + ' + fw.reagentB + ' -> ' + fw.compound + rps + ' | margin: ' + fw.marginPct.toFixed(1) + '%');
            }
            if (results.forward.length > 10) lines.push('  ... and ' + (results.forward.length - 10) + ' more');
        } else { lines.push('NEW Forward Reactions: None' + (!ENABLE_LAB_JOBS ? ' (disabled)' : '')); }
        lines.push('');

        var compressOpps = results.factory.filter(function(x) { return !x.isDecompress; });
        if (compressOpps.length > 0) {
            lines.push('NEW Factory Compression:');
            for (var j = 0; j < compressOpps.length; j++) {
                var f = compressOpps[j];
                lines.push('  ' + f.product + (f.requiredLevel > 0 ? ' [L' + f.requiredLevel + ']' : ' [L0]') + (f.isLocalRefine ? ' [local]' : '') + ' | margin: ' + f.marginPct.toFixed(1) + '%');
            }
        } else { lines.push('NEW Factory Compression: None' + (!ENABLE_FACTORY_JOBS ? ' (disabled)' : '')); }
        lines.push('');

        var decompressOpps = results.factory.filter(function(x) { return x.isDecompress; });
        if (decompressOpps.length > 0) {
            lines.push('NEW Factory Decompression:');
            for (var dj = 0; dj < decompressOpps.length; dj++) {
                var df = decompressOpps[dj];
                var comps = COMMODITIES[df.product] && COMMODITIES[df.product].components ? COMMODITIES[df.product].components : {};
                var inputBar = Object.keys(comps).filter(function(k) { return k !== RESOURCE_ENERGY; })[0] || '?';
                lines.push('  ' + inputBar + ' -> ' + df.product + ' [L0] | margin: ' + df.marginPct.toFixed(1) + '%');
            }
        } else { lines.push('NEW Factory Decompression: None' + (!ENABLE_FACTORY_DECOMPRESSION ? ' (disabled)' : '')); }
        lines.push('');

        if (results.skippedReverse.length > 0) {
            lines.push('ALREADY PROCESSING Reverse:');
            for (var sr = 0; sr < results.skippedReverse.length; sr++) { var sk = results.skippedReverse[sr]; lines.push('  ' + sk.compound + ' @ ' + (sk.marginPct !== null ? sk.marginPct.toFixed(1) + '%' : 'N/A') + ' - in ' + sk.room + ' (' + sk.state + ')'); }
        }
        if (results.skippedForward.length > 0) {
            lines.push('ALREADY PROCESSING Forward:');
            for (var sfwd = 0; sfwd < results.skippedForward.length; sfwd++) { var skf = results.skippedForward[sfwd]; lines.push('  ' + skf.compound + ' @ ' + (skf.marginPct !== null ? skf.marginPct.toFixed(1) + '%' : 'N/A') + ' - in ' + skf.room + ' (' + skf.state + ')'); }
        }
        if (results.skippedFactory.length > 0) {
            lines.push('ALREADY PROCESSING Factory:');
            for (var sf = 0; sf < results.skippedFactory.length; sf++) {
                var skfa = results.skippedFactory[sf];
                lines.push('  ' + skfa.product + (skfa.requiredLevel > 0 ? ' [L' + skfa.requiredLevel + ']' : '') + (skfa.isDecompress ? ' [decomp]' : '') + ' @ ' + (skfa.marginPct !== null ? skfa.marginPct.toFixed(1) + '%' : 'N/A') + ' - in ' + skfa.room + ' (' + skfa.phase + ')');
            }
        }
        if (results.skippedSellLimit && results.skippedSellLimit.length > 0) {
            lines.push(''); lines.push('SKIPPED (sell limit ' + MAX_SELL_AMOUNT + '):');
            for (var sl = 0; sl < results.skippedSellLimit.length; sl++) { var sks = results.skippedSellLimit[sl]; lines.push('  ' + sks.compound + ' @ ' + sks.marginPct.toFixed(1) + '% - ' + sks.reason); }
        }

        return lines.join('\n');
    }

    if (command === 'run') {
        console.log('[autoTrader] Manual run triggered at tick ' + Game.time);
        var results = runAnalysis();
        var counts = countFactoryOpps(results.factory);
        mem.lastAnalysis = { tick: Game.time, reverseCount: results.reverse.length, forwardCount: results.forward.length, compressCount: counts.compressCount, decompressCount: counts.decompressCount };
        var jobs = executeJobs(results, false);
        mem.lastRun = Game.time;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) mem.jobsStarted.push(jobs[k]);
            if (mem.jobsStarted.length > 20) mem.jobsStarted = mem.jobsStarted.slice(-20);
        }
        return '[autoTrader] Run complete. Started ' + jobs.length + ' job(s).';
    }

    return '[autoTrader] Unknown command: ' + command + '. Use: run, analyze, rooms [filter], enable, disable, reset, clearCooldown <product>';
};

// ===== Market Status Commands =====

global.selling = function(arg) {
    var orders = Game.market.orders;
    var sellOrders = [];
    for (var id in orders) { var o = orders[id]; if (o.type === ORDER_SELL && o.remainingAmount > 0) sellOrders.push(o); }
    if (sellOrders.length === 0) return '[selling] No active sell orders.';
    if (arg && arg !== 'compact') {
        var filtered = sellOrders.filter(function(o) { return o.resourceType === arg; });
        if (filtered.length === 0) return '[selling] No sell orders for ' + arg;
        var lines = ['[selling] ' + arg + ': ' + filtered.length + ' order(s)'], total = 0;
        for (var i = 0; i < filtered.length; i++) { var o = filtered[i]; total += o.remainingAmount; lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3)); }
        lines.push('  Total: ' + total);
        return lines.join('\n');
    }
    var byResource = {};
    for (var i = 0; i < sellOrders.length; i++) { var o = sellOrders[i]; var res = o.resourceType; if (!byResource[res]) byResource[res] = { orders: [], total: 0 }; byResource[res].orders.push(o); byResource[res].total += o.remainingAmount; }
    var resources = Object.keys(byResource).sort(function(a, b) { return byResource[b].total - byResource[a].total; });
    var lines = ['[selling] ' + sellOrders.length + ' active sell order(s) across ' + resources.length + ' resource(s):', ''];
    for (var j = 0; j < resources.length; j++) {
        var res = resources[j]; var data = byResource[res];
        if (arg === 'compact') {
            var avg = 0; for (var k = 0; k < data.orders.length; k++) avg += data.orders[k].price; avg = avg / data.orders.length;
            lines.push('  ' + res + ': ' + data.total + ' (' + data.orders.length + ' orders, avg ' + avg.toFixed(3) + ')');
        } else {
            lines.push(res + ': ' + data.total + ' total');
            for (var k = 0; k < data.orders.length; k++) { var o = data.orders[k]; lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3)); }
            lines.push('');
        }
    }
    return lines.join('\n');
};

global.buying = function(arg) {
    var orders = Game.market.orders;
    var buyOrders = [];
    for (var id in orders) { var o = orders[id]; if (o.type === ORDER_BUY && o.remainingAmount > 0) buyOrders.push(o); }
    if (buyOrders.length === 0) return '[buying] No active buy orders.';
    if (arg && arg !== 'compact') {
        var filtered = buyOrders.filter(function(o) { return o.resourceType === arg; });
        if (filtered.length === 0) return '[buying] No buy orders for ' + arg;
        var lines = ['[buying] ' + arg + ': ' + filtered.length + ' order(s)'], total = 0;
        for (var i = 0; i < filtered.length; i++) { var o = filtered[i]; total += o.remainingAmount; lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3)); }
        lines.push('  Total: ' + total);
        return lines.join('\n');
    }
    var byResource = {};
    for (var i = 0; i < buyOrders.length; i++) { var o = buyOrders[i]; var res = o.resourceType; if (!byResource[res]) byResource[res] = { orders: [], total: 0 }; byResource[res].orders.push(o); byResource[res].total += o.remainingAmount; }
    var resources = Object.keys(byResource).sort(function(a, b) { return byResource[b].total - byResource[a].total; });
    var lines = ['[buying] ' + buyOrders.length + ' active buy order(s) across ' + resources.length + ' resource(s):', ''];
    for (var j = 0; j < resources.length; j++) {
        var res = resources[j]; var data = byResource[res];
        if (arg === 'compact') {
            var avg = 0; for (var k = 0; k < data.orders.length; k++) avg += data.orders[k].price; avg = avg / data.orders.length;
            lines.push('  ' + res + ': ' + data.total + ' (' + data.orders.length + ' orders, avg ' + avg.toFixed(3) + ')');
        } else {
            lines.push(res + ': ' + data.total + ' total');
            for (var k = 0; k < data.orders.length; k++) { var o = data.orders[k]; lines.push('  ' + o.roomName + ': ' + o.remainingAmount + ' @ ' + o.price.toFixed(3)); }
            lines.push('');
        }
    }
    return lines.join('\n');
};

// ===== Main Module Export =====

module.exports = {
    run: function() {
        if (!ENABLED) return;
        var mem = ensureMemory();
        if (!mem.enabled) return;
        if (mem.lastRun && (Game.time - mem.lastRun) < RUN_INTERVAL) return;

        getRoomState.init();
        var results = runAnalysis();
        var counts = countFactoryOpps(results.factory);
        mem.lastAnalysis = { tick: Game.time, reverseCount: results.reverse.length, forwardCount: results.forward.length, compressCount: counts.compressCount, decompressCount: counts.decompressCount };

        var jobs = executeJobs(results, false);
        mem.lastRun = Game.time;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) mem.jobsStarted.push(jobs[k]);
            if (mem.jobsStarted.length > 20) mem.jobsStarted = mem.jobsStarted.slice(-20);
        }
    }
};