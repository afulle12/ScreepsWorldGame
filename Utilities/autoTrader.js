/**
 * autoTrader.js
 * pear
 * 
 * Automated trading module that periodically analyzes market opportunities
 * and executes profitable reverse reactions (lab breakdown), forward reactions
 * (lab combination), factory refinement jobs, and factory decompression jobs.
 *
 * 
 * CONSOLE COMMANDS:
 *   autoTrader()              - Show status and last run info
 *   autoTrader('run')         - Force immediate analysis and execution
 *   autoTrader('analyze')     - Run analysis only (no execution)
 *   autoTrader('active')      - Show in-flight jobs: inputs purchased / output produced
 *   autoTrader('history')     - Show full job history (all jobs in memory)
 *   autoTrader('reset')       - Reset memory
 *   autoTrader('enable')      - Enable automatic runs
 *   autoTrader('disable')     - Disable automatic runs
 *   autoTrader('rooms')       - Show per-room eligibility, active jobs, and why rooms are busy
 * 
 *   selling()                 - Compact: one line per resource with % filled, order count, avg price
 *   selling('compact')        - Same as no-arg (alias for default)
 *   selling('expanded')       - Expanded: per-room orders, each with % filled
 *   selling('OH')             - Show sell orders for specific resource (expanded)
 *   selling('compact', 'E0N0') - Compact view filtered to a specific room
 *   selling('expanded', 'E0N0')- Expanded view filtered to a specific room
 *   selling('OH', 'E0N0')      - Show sell orders for a resource in a specific room
 *   buying()                  - Compact view (same shape as selling())
 *   buying('compact')         - Same as no-arg
 *   buying('expanded')        - Expanded per-order view
 *   buying('K')               - Show buy orders for specific resource (expanded)
 *   buying('compact', 'E0N0')  - Compact view filtered to a specific room
 *   buying('expanded', 'E0N0') - Expanded view filtered to a specific room
 *   buying('K', 'E0N0')        - Show buy orders for a resource in a specific room
 *
 * JOB HISTORY STATUS TAGS (factory jobs, marketRefine-backed):
 *   [phase]       - op is still active in Memory.marketRefine.ops (buying/refining/selling)
 *   [done]        - op completed and actually produced+sold output (per
 *                   Memory.marketRefine.outcomes)
 *   [FAILED: ...] - op left the active list WITHOUT producing output (factory
 *                   refused, no output produced, expired/aborted, etc.) - reason shown.
 *                   Use marketRefineOutcomes() for more detail/history.
 *   [superseded]  - a newer job for this product/room has since started; this
 *                   entry isn't the latest, so its own outcome isn't shown.
 *   [unknown]     - op is gone and no matching outcome record was found (e.g.
 *                   outcomes ledger predates this job / memory was reset).
 */

var getRoomState = require('getRoomState');
var pricing = require('marketPricing');

// Configuration
var ENABLED = true;
var ENABLE_LAB_JOBS = true;                // Set to false to skip all lab reactions (reverse + forward)
var ENABLE_FACTORY_JOBS = true;            // Set to false to skip all factory compression jobs
var ENABLE_FACTORY_DECOMPRESSION = false;   // Set to false to skip all factory decompression jobs
var RUN_INTERVAL = 250;
var MARGIN_THRESHOLD = 40; // percent
var MAX_REVERSE_REACTIONS = 10;
var MAX_FORWARD_REACTIONS = 10;
var MAX_LAB_OPS_PER_ROOM = 10;   // queued buys allowed per room (forward+reverse combined); only 1 ever processes
var MAX_FACTORY_JOBS = 10;   // Shared pool covering both compression and decompression
var MAX_FACTORY_OPS_PER_ROOM = 3; // Concurrent factory jobs allowed per room
var MIN_STORAGE_ENERGY = 150000;
var REQUIRED_SOURCES = 1;
var MIN_LABS = 3;
var MAX_SELL_AMOUNT = 21000; // Don't start jobs if we're already selling this much of a reagent
var FACTORY_JOB_COOLDOWN = 100; // Don't re-start the same factory product within this many ticks
var SELF_ARB_PRICE_BOOST = 1.05; // When buying from own rooms, allow 5% above market sell price
var MIN_FILL_RATIO = 0.25; // Proceed if opportunisticBuy fills >=25%; sell/abort if <25%
var JOBS_HISTORY_CAP = 30; // Maximum number of jobs to retain in memory

// Products the autoTrader will never start, regardless of margin
var BANNED_FACTORY_PRODUCTS = [RESOURCE_ENERGY]; // battery -> energy conversion banned

var REACTION_TIME_TABLE = {
    OH: 20, ZK: 5, UL: 5, G: 5,
    UH: 10, UO: 10, KH: 10, KO: 10, LH: 15, LO: 10, ZH: 20, ZO: 20, GH: 10, GO: 10,
    UH2O:  5, UHO2:  5, KH2O:  5, KHO2:  5, LH2O: 10, LHO2:  5, ZH2O: 40, ZHO2:  5, GH2O: 15, GHO2: 10,
    XUH2O: 180, XUHO2:  45, XKH2O:  45, XKHO2:  45, XLH2O:  65, XLHO2:  45, XZH2O: 180, XZHO2:  45, XGH2O: 150, XGHO2: 150
};

var FACTORY_COOLDOWN_TABLE = {
    utrium_bar: 20, lemergium_bar: 20, zynthium_bar: 20, keanium_bar: 20, ghodium_melt: 20,
    oxidant: 20, reductant: 20, purifier: 20, battery: 10, wire: 8, cell: 8, alloy: 8, condensate: 8,
    U: 20, L: 20, Z: 20, K: 20, G: 20, O: 20, H: 20, X: 20, energy: 10,
    composite: 50, tube: 50, phlegm: 50, switch: 50, concentrate: 50,
    crystal: 100, fixtures: 100, tissue: 100, transistor: 100, extract: 100,
    liquid: 150, frame: 150, muscle: 150, microchip: 150, spirit: 150,
    hydraulics: 400, organoid: 400, circuit: 400, emanation: 400,
    machine: 600, organism: 600, device: 600, essence: 600
};

// localRefine integration
var LOCAL_REFINE_PRODUCTS = [RESOURCE_BATTERY];
var LOCAL_REFINE_ENERGY_RESERVE = 200000;

var LEVEL_0_FACTORY_PRODUCTS = [
    RESOURCE_UTRIUM_BAR, RESOURCE_LEMERGIUM_BAR, RESOURCE_ZYNTHIUM_BAR, RESOURCE_KEANIUM_BAR,
    RESOURCE_GHODIUM_MELT, RESOURCE_OXIDANT, RESOURCE_REDUCTANT, RESOURCE_PURIFIER,
    RESOURCE_BATTERY, RESOURCE_WIRE, RESOURCE_CELL, RESOURCE_ALLOY, RESOURCE_CONDENSATE
];
var LEVEL_1_FACTORY_PRODUCTS = [RESOURCE_COMPOSITE, RESOURCE_TUBE, RESOURCE_PHLEGM, RESOURCE_SWITCH, RESOURCE_CONCENTRATE];
var LEVEL_2_FACTORY_PRODUCTS = [RESOURCE_CRYSTAL, RESOURCE_FIXTURES, RESOURCE_TISSUE, RESOURCE_TRANSISTOR, RESOURCE_EXTRACT];
var LEVEL_3_FACTORY_PRODUCTS = [RESOURCE_LIQUID, RESOURCE_FRAME, RESOURCE_MUSCLE, RESOURCE_MICROCHIP, RESOURCE_SPIRIT];
var LEVEL_4_FACTORY_PRODUCTS = [RESOURCE_HYDRAULICS, RESOURCE_ORGANOID, RESOURCE_CIRCUIT, RESOURCE_EMANATION];
var LEVEL_5_FACTORY_PRODUCTS = [RESOURCE_MACHINE, RESOURCE_ORGANISM, RESOURCE_DEVICE, RESOURCE_ESSENCE];

var SUPPORTED_FACTORY_PRODUCTS = LEVEL_0_FACTORY_PRODUCTS
    .concat(LEVEL_1_FACTORY_PRODUCTS).concat(LEVEL_2_FACTORY_PRODUCTS)
    .concat(LEVEL_3_FACTORY_PRODUCTS).concat(LEVEL_4_FACTORY_PRODUCTS).concat(LEVEL_5_FACTORY_PRODUCTS);

var DECOMPRESSION_PRODUCTS = [
    RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, RESOURCE_ZYNTHIUM, RESOURCE_KEANIUM, RESOURCE_GHODIUM,
    RESOURCE_OXYGEN, RESOURCE_HYDROGEN, RESOURCE_CATALYST, RESOURCE_ENERGY
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
    var hist = Game.market.getHistory(resourceType) || [];
    var count = 0, sum = 0;
    if (hist.length >= 1 && typeof hist[hist.length - 1].avgPrice === 'number') { sum += hist[hist.length - 1].avgPrice; count++; }
    if (hist.length >= 2 && typeof hist[hist.length - 2].avgPrice === 'number') { sum += hist[hist.length - 2].avgPrice; count++; }
    var avg = count > 0 ? sum / count : 1;
    if (validOrders.length > 0) {
        // Cap at 1.5x the 48h average so a lone manipulated bestBid can't inflate estimates.
        return Math.max(Math.min(validOrders[0].price + 0.1, avg * 1.5), 0.001);
    }
    return Math.max(avg * 0.95, 0.001);
}

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
    if (validOrders.length > 0) return { price: Math.max(validOrders[0].price + 0.1, 0.001), source: 'MBUY', orderCount: validOrders.length, volume: totalVolume };
    var hist = Game.market.getHistory(resource) || [];
    var count = 0, sum = 0;
    if (hist.length >= 1) { var h1 = hist[hist.length - 1]; if (h1 && typeof h1.avgPrice === 'number') { sum += h1.avgPrice; count++; } }
    if (hist.length >= 2) { var h2 = hist[hist.length - 2]; if (h2 && typeof h2.avgPrice === 'number') { sum += h2.avgPrice; count++; } }
    return { price: Math.max((count > 0 ? sum / count : 1) * 0.95, 0.001), source: 'HIST', orderCount: 0, volume: 0 };
}

// Volume-weighted ask for a non-energy resource: what it would cost to actually
// buy (e.g. via opportunisticBuy.deal()) given the real ask depth. Used as the
// cost basis in the analyses so reported margins reflect what marketRefine can
// actually fill at, not the cheap bestBid+0.1 used for a posted marketBuy bid.
// Falls back to ACTUAL_SELL (bestAsk-0.1) when the book is empty so margin
// calculations still have a number to work with.
function getVolumeWeightedBuyPrice(resource) {
    if (resource === RESOURCE_ENERGY) return computeActualBuyPrice(resource);
    var book = pricing.getBook(resource);
    if (book && typeof book.vwAsk === 'number' && book.vwAsk > 0) {
        return { price: book.vwAsk, source: 'VWAP', orderCount: book.askCount || 0, volume: book.askVol || 0 };
    }
    var fallback = computeActualSellPrice(resource);
    if (fallback && typeof fallback.price === 'number' && fallback.price !== null) return fallback;
    return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
}

function priceOfWithSource(resource, mode) {
    if (mode === 'ACTUAL_BUY')  return { price: computeActualBuyPrice(resource),  source: 'ABUY',  orderCount: 0, volume: 0 };
    if (mode === 'ACTUAL_SELL') return { price: computeActualSellPrice(resource), source: 'ASELL', orderCount: 0, volume: 0 };
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

function getOppositeFactoryProduct(product) {
    var isDecomp = DECOMPRESSION_PRODUCTS.indexOf(product) >= 0;
    var recipe = COMMODITIES && COMMODITIES[product];
    if (!recipe) return null;
    if (isDecomp) {
        var comps = recipe.components || {};
        for (var res in comps) { if (comps.hasOwnProperty(res) && res !== RESOURCE_ENERGY) return res; }
    } else {
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
        var oppInfo = priceOfWithSource(compound, 'ACTUAL_SELL');
        compoundOpportunityCost = (oppInfo.price !== null) ? oppInfo.price : 0;
    } else {
        // Compound cost: what we'd actually pay to acquire it. Use volume-weighted
        // ask (realistic cost) instead of bestBid+0.1 (price a posted bid would
        // fill at, but starved in thin books). matches the fix in
        // analyzeFactoryProduct so reverse/forward margins agree.
        compoundInfo = getVolumeWeightedBuyPrice(compound);
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
        var oA = priceOfWithSource(reagentA, 'ACTUAL_SELL'); reagentAOpportunityCost = oA.price !== null ? oA.price : 0;
    } else {
        // Reagent cost: what we'd actually pay to acquire. Use volume-weighted
        // ask (realistic cost via deal() or filled posted bid) instead of the
        // bestBid+0.1 reference that over-states margin in thin books.
        var pA = getVolumeWeightedBuyPrice(reagentA);
        reagentAPrice = pA.price;
        reagentAOpportunityCost = pA.price;
    }
    if (hasOwnRoomSellOrders(reagentB)) {
        var ssB = priceOfWithSource(reagentB, 'sell'); reagentBPrice = (ssB.price !== null && ssB.price > 0) ? ssB.price * SELF_ARB_PRICE_BOOST : 0;
        var oB = priceOfWithSource(reagentB, 'ACTUAL_SELL'); reagentBOpportunityCost = oB.price !== null ? oB.price : 0;
    } else {
        var pB = getVolumeWeightedBuyPrice(reagentB);
        reagentBPrice = pB.price;
        reagentBOpportunityCost = pB.price;
    }
    var costA = reagentAOpportunityCost === null ? null : reagentAOpportunityCost * batch;
    var costB = reagentBOpportunityCost === null ? null : reagentBOpportunityCost * batch;
    var reagentCost = (costA !== null && costB !== null) ? costA + costB : (costA !== null ? costA : costB);
    var totalCost = reagentCost;
    var compoundInfo = priceOfWithSource(compound, compoundSellMode);
    var totalRevenue = compoundInfo.price === null ? null : compoundInfo.price * batch;
    var profit = (totalRevenue !== null && totalCost !== null) ? totalRevenue - totalCost : null;
    var marginPct = null;
    if (profit !== null && totalCost !== null && totalCost > 0) marginPct = (profit / totalCost) * 100;
    else if (profit !== null && totalCost === 0) marginPct = 9999;
    return { type: 'forward', compound: compound, reagentA: reagentA, reagentB: reagentB, marginPct: marginPct, profit: profit, reagentAPrice: reagentAPrice, reagentBPrice: reagentBPrice, compoundPrice: compoundInfo.price, compoundVolume: compoundInfo.volume };
}

function analyzeFactoryProduct(resource, outputMode, inputMode) {
    var recipe = COMMODITIES && COMMODITIES[resource];
    if (!recipe) return null;
    var outQty = (typeof recipe.amount === 'number' && recipe.amount > 0) ? recipe.amount : 1;
    var comps = recipe.components || {};
    var ingredientCost = 0;
    var inputPrices = {};
    var isLocalRefineProduct = LOCAL_REFINE_PRODUCTS.indexOf(resource) >= 0;
    var isDecompress = DECOMPRESSION_PRODUCTS.indexOf(resource) >= 0;
    for (var res in comps) {
        if (!comps.hasOwnProperty(res)) continue;
        var qty = comps[res] || 0;
        if (isLocalRefineProduct) {
            inputPrices[res] = 0;
            var oppInfo = priceOfWithSource(res, inputMode);
            ingredientCost += (oppInfo.price !== null ? oppInfo.price * qty : 0);
            continue;
        }
        if (hasOwnRoomSellOrders(res)) {
            var selfSellInfo = priceOfWithSource(res, 'sell');
            var selfSellPrice = (selfSellInfo.price !== null) ? selfSellInfo.price : 0;
            inputPrices[res] = selfSellPrice > 0 ? selfSellPrice * SELF_ARB_PRICE_BOOST : 0;
            var oppInfo2 = priceOfWithSource(res, inputMode);
            var marketBuyPrice = (oppInfo2.price !== null) ? oppInfo2.price : 0;
            ingredientCost += Math.max(selfSellPrice, marketBuyPrice) * qty;
            continue;
        }
        // For non-energy inputs we're going to BUY on the market, use the
        // volume-weighted ask (real cost to acquire) instead of bestBid+0.1
        // (the price a posted marketBuy bid would be filled at). bestBid+0.1
        // underestimates cost in thin books and produces false-positive margins
        // that marketRefine then refuses.
        // Use max(bestBid+0.1, vwAsk) as the effective cost so the reported
        // margin matches what marketRefine will actually pay (its bid floor).
        if (res === RESOURCE_ENERGY) {
            var priceInfo = priceOfWithSource(res, inputMode);
            ingredientCost += (priceInfo.price === null ? 0 : priceInfo.price * qty);
            if (priceInfo.price !== null) inputPrices[res] = priceInfo.price;
            continue;
        }
        var vwBuy = getVolumeWeightedBuyPrice(res);
        // Match what marketRefine will actually pay: robust posted bid floored at vwAsk.
        var effectiveInputCost = vwBuy.price;
        if (effectiveInputCost !== null) {
            var postedBid = pricing.computePostedBid(res, Infinity);
            if (postedBid !== null) effectiveInputCost = Math.max(postedBid, effectiveInputCost);
        }
        ingredientCost += (effectiveInputCost === null ? 0 : effectiveInputCost * qty);
        if (vwBuy.price !== null) inputPrices[res] = vwBuy.price;
    }
    var totalCost = ingredientCost;
    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : (revenue - totalCost);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);
    if (profit !== null && totalCost === 0 && revenue > 0) marginPct = 9999;
    var cooldown = FACTORY_COOLDOWN_TABLE[resource] || null;
    return { type: 'factory', product: resource, marginPct: marginPct, profit: profit, unitPrice: unitPrice, outputVolume: outputInfo.volume, requiredLevel: getProductFactoryLevel(resource), inputPrices: inputPrices, isLocalRefine: isLocalRefineProduct, isDecompress: isDecompress, ingredientCost: ingredientCost, cooldown: cooldown };
}

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

    // Use the same robust posted-bid computation that marketRefine will use.
    // This ignores a lone manipulated bestBid and floors the bid at vwAsk.
    var postedBids = {}, naiveCost = 0;
    for (var res in comps) {
        if (!comps.hasOwnProperty(res) || res === RESOURCE_ENERGY) continue;
        var bid = pricing.computePostedBid(res, Infinity);
        if (bid === null || !(bid > 0)) return null;
        postedBids[res] = bid;
        naiveCost += bid * comps[res];
    }
    if (naiveCost <= 0) return null;
    if (naiveCost > remainingBudget) return null;

    var inputPrices = {};
    for (var res2 in comps) {
        if (!comps.hasOwnProperty(res2) || res2 === RESOURCE_ENERGY) continue;
        inputPrices[res2] = postedBids[res2];
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
    for (var i = 0; i < queue.length; i++) { if (queue[i] && queue[i].state !== 'SELLING') count++; }
    return count;
}

function getRoomActiveLabForwardCount(roomName) {
    if (!Memory.marketLabForward || !Memory.marketLabForward.rooms) return 0;
    var queue = Memory.marketLabForward.rooms[roomName];
    if (!queue) return 0;
    var count = 0;
    for (var i = 0; i < queue.length; i++) { if (queue[i] && queue[i].state !== 'SELLING') count++; }
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

function isFactoryProductOnCooldown(product) {
    var mem = ensureMemory();
    if (!mem.jobsStarted) return false;
    for (var i = mem.jobsStarted.length - 1; i >= 0; i--) {
        var job = mem.jobsStarted[i];
        if (job.type === 'factory' && job.product === product) return (Game.time - job.tick) < FACTORY_JOB_COOLDOWN;
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
    if (state.controller.level < 8) return false;
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
    if (getRoomActiveFactoryCount(roomName) >= MAX_FACTORY_OPS_PER_ROOM) return false;
    return true;
}

function isEligibleForFactory(roomName, product) {
    if (!isEligibleForFactoryBasic(roomName)) return false;
    if (!product) return true;
    return canRoomProduceProduct(roomName, product);
}

function getEligibleLabReactionRooms() {
    var rooms = [];
    var allRooms = getRoomState.all();
    for (var roomName in allRooms) {
        if (!isEligibleForLabReaction(roomName)) continue;
        if (getRoomActiveLabCount(roomName) >= MAX_LAB_OPS_PER_ROOM) continue;
        rooms.push({ name: roomName, labCount: getRoomLabCount(roomName) });
    }
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

// ===== Active Job Progress Helpers =====
// Progress isn't stored on the ops - it's derived from room stores the same way
// the owning modules derive it: marketLab reads the terminal; marketRefine/
// localRefine read storage+terminal+factory+containers; marketBuy fills come
// from marketBuy's own order record.

function pctOf(have, target) {
    if (typeof have !== 'number' || typeof target !== 'number' || target <= 0) return null;
    return Math.max(0, Math.min(100, (have / target) * 100));
}

// Terminal-only count (matches marketLab.countInRoom).
function terminalCount(roomName, res) {
    var state = getRoomState.get(roomName);
    if (!state || !state.terminal || !state.terminal.store) return 0;
    var store = state.terminal.store;
    return (typeof store.getUsedCapacity === 'function') ? (store.getUsedCapacity(res) || 0) : (store[res] || 0);
}

// Storage+terminal+factory+containers (matches marketRefine/localRefine.countInRoom).
function roomWideCount(roomName, res) {
    var state = getRoomState.get(roomName);
    if (!state) return 0;
    var total = 0;
    function add(s) { if (s && s.store && s.store[res]) total += s.store[res]; }
    add(state.storage);
    add(state.terminal);
    var stMap = state.structuresByType || {};
    var facs = stMap[STRUCTURE_FACTORY] || [];
    if (facs.length > 0) add(facs[0]);
    var cons = stMap[STRUCTURE_CONTAINER] || [];
    for (var i = 0; i < cons.length; i++) add(cons[i]);
    return total;
}

// Mirror of marketRefine.getInputAcquired (marketBuy-aware, else room delta).
function getMarketBuyFulfilled(roomName, resource) {
    var mb = global.marketBuy;
    if (!mb) { try { mb = require('marketBuy'); } catch (e) { mb = null; } }
    if (!mb || typeof mb.getOrderRecordFor !== 'function' || typeof mb.getFulfilled !== 'function') return null;
    try {
        var rec = mb.getOrderRecordFor(roomName, resource);
        if (rec) return mb.getFulfilled(rec);
    } catch (e) {}
    return null;
}

function isMarketBuyOrderLive(roomName, resource) {
    var mb = global.marketBuy;
    if (!mb) { try { mb = require('marketBuy'); } catch (e) { mb = null; } }
    if (!mb || typeof mb.getOrderRecordFor !== 'function') return true; // can't verify, assume live
    try {
        var rec = mb.getOrderRecordFor(roomName, resource);
        if (!rec) return false;
        if (rec.done || rec.cancelled) return false;
        if (!rec.orderId) return false; // still pending id capture
        return !!Game.market.orders[rec.orderId];
    } catch (e) { return true; }
}

function refineInputAcquired(op, inp) {
    if (inp.useMarketBuy) {
        var f = getMarketBuyFulfilled(op.room, inp.resource);
        if (f !== null) return f;
    }
    var acq = roomWideCount(op.room, inp.resource) - (typeof inp.baseCount === 'number' ? inp.baseCount : 0);
    return acq > 0 ? acq : 0;
}

// Expected output from the limiting input (input.amount / recipe ratio * recipe.amount).
function recipeExpectedOutput(output, inputAmount, inputResource) {
    var recipe = COMMODITIES && COMMODITIES[output];
    if (!recipe) return null;
    var comps = recipe.components || {};
    var per = comps[inputResource];
    if (!per || per <= 0) return null;
    var outQty = (typeof recipe.amount === 'number' && recipe.amount > 0) ? recipe.amount : 1;
    return (inputAmount / per) * outQty;
}

function refineExpectedOutput(op) {
    var recipe = COMMODITIES && COMMODITIES[op.output];
    if (!recipe || !op.inputs) return null;
    var comps = recipe.components || {};
    var outQty = (typeof recipe.amount === 'number' && recipe.amount > 0) ? recipe.amount : 1;
    var best = null;
    for (var i = 0; i < op.inputs.length; i++) {
        var per = comps[op.inputs[i].resource];
        if (!per || per <= 0) continue;
        var e = (op.inputs[i].amount / per) * outQty;
        if (best === null || e < best) best = e;
    }
    return best;
}

function producedSince(op) {
    var baseline = (op.outputBaseAtFactoryStart !== null && op.outputBaseAtFactoryStart !== undefined)
        ? op.outputBaseAtFactoryStart : op.baseOutputCount;
    var d = roomWideCount(op.room, op.output) - (baseline || 0);
    return d > 0 ? d : 0;
}

function fmtBought(res, have, target, suffix) {
    var s = (typeof target === 'number' && target > 0)
        ? (res + ': ' + have + '/' + target + (pctOf(have, target) !== null ? ' (' + pctOf(have, target).toFixed(0) + '%)' : ''))
        : (res + ': ' + have);
    return s + (suffix || '');
}

function fmtProduced(res, produced, expected) {
    if (typeof expected === 'number' && expected > 0) {
        var p = pctOf(produced, expected);
        return res + ': ' + (p !== null ? p.toFixed(0) + '%' : '?') + ' produced (' + produced + '/' + Math.round(expected) + ')';
    }
    return res + ': ' + produced + ' produced';
}

function orderFillPct(o) {
    if (!o || typeof o.amount !== 'number' || o.amount <= 0) return null;
    var filled = o.amount - (typeof o.remainingAmount === 'number' ? o.remainingAmount : 0);
    return Math.max(0, Math.min(100, (filled / o.amount) * 100));
}

function fmtPct(p) { return (p === null) ? '?' : p.toFixed(1) + '%'; }

function getActiveReport() {
    var lines = ['[autoTrader] Active Jobs (tick ' + Game.time + '):', ''];
    var any = false;

    // ---- Lab ops (forward + reverse) ----
    var dirs = [
        { mem: Memory.marketLabForward, fwd: true },
        { mem: Memory.marketLabReverse, fwd: false }
    ];
    for (var di = 0; di < dirs.length; di++) {
        var dmem = dirs[di].mem, isFwd = dirs[di].fwd;
        if (!dmem || !dmem.rooms) continue;
        for (var room in dmem.rooms) {
            var queue = dmem.rooms[room] || [];
            for (var qi = 0; qi < queue.length; qi++) {
                var op = queue[qi];
                if (!op || !op.targetCompound || op.state === 'SELLING') continue;
                any = true;
                var reagentStr = op.reagents ? op.reagents.join('+') : '?';
                var arrow = isFwd ? (reagentStr + '->' + op.targetCompound) : (op.targetCompound + '->' + reagentStr);
                lines.push((isFwd ? 'forward ' : 'reverse ') + op.targetCompound + ' in ' + room + ' [' + op.state + '] (' + arrow + ')');

                if (op.state === 'BUYING') {
                    var bparts = [];
                    if (isFwd && op.reagents) {
                        for (var ri = 0; ri < op.reagents.length; ri++) bparts.push(fmtBought(op.reagents[ri], terminalCount(room, op.reagents[ri]), op.batchSize, ' (opportunisticBuy)'));
                    } else {
                        bparts.push(fmtBought(op.targetCompound, terminalCount(room, op.targetCompound), op.batchSize, ' (opportunisticBuy)'));
                    }
                    lines.push('    buying     ' + bparts.join(', '));
                } else if (op.state === 'WAITING') {
                    lines.push('    waiting    inputs acquired, labs busy');
                } else if (op.state === 'PROCESSING') {
                    var pparts = [];
                    if (isFwd) {
                        pparts.push(fmtProduced(op.targetCompound, terminalCount(room, op.targetCompound), op.batchSize));
                    } else if (op.reagents) {
                        for (var ri2 = 0; ri2 < op.reagents.length; ri2++) pparts.push(fmtProduced(op.reagents[ri2], terminalCount(room, op.reagents[ri2]), op.batchSize));
                    }
                    lines.push('    producing  ' + pparts.join(', '));
                }
            }
        }
    }

    // ---- marketRefine factory ops ----
    if (Memory.marketRefine && Array.isArray(Memory.marketRefine.ops)) {
        for (var mi = 0; mi < Memory.marketRefine.ops.length; mi++) {
            var mop = Memory.marketRefine.ops[mi];
            if (!mop || !mop.output) continue;
            if (mop.phase === 'done' || mop.phase === 'failed' || mop.phase === 'error') continue;
            any = true;
            var decompTag = DECOMPRESSION_PRODUCTS.indexOf(mop.output) >= 0 ? ' [decomp]' : '';
            lines.push('factory ' + mop.output + decompTag + ' in ' + mop.room + ' [' + mop.phase + ']');
            if (mop.phase === 'buying') {
                var iparts = [];
                if (mop.inputs && mop.inputs.length) {
                    for (var ii = 0; ii < mop.inputs.length; ii++) {
                        var inp = mop.inputs[ii];
                        var via = inp.useMarketSell ? ' (marketSell)' : (inp.useMarketBuy ? ' (marketBuy)' : ' (roomStock)');
                        if (inp.useMarketBuy && !isMarketBuyOrderLive(mop.room, inp.resource)) {
                            via += ' [order missing/cancelled]';
                        }
                        iparts.push(fmtBought(inp.resource, refineInputAcquired(mop, inp), inp.amount, via));
                    }
                }
                lines.push('    buying     ' + (iparts.length ? iparts.join(', ') : '(no inputs)'));
            } else {
                lines.push('    producing  ' + fmtProduced(mop.output, producedSince(mop), refineExpectedOutput(mop)));
            }
        }
    }

    // ---- localRefine factory ops (no buying phase - inputs assumed on hand) ----
    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) {
        for (var li = 0; li < Memory.localRefine.ops.length; li++) {
            var lop = Memory.localRefine.ops[li];
            if (!lop || !lop.output) continue;
            if (lop.phase === 'done' || lop.phase === 'failed' || lop.phase === 'error') continue;
            any = true;
            lines.push('factory ' + lop.output + ' [local] in ' + lop.room + ' [' + lop.phase + ']');
            lines.push('    producing  ' + fmtProduced(lop.output, producedSince(lop), recipeExpectedOutput(lop.output, lop.requiredAmount, lop.input)));
        }
    }

    if (!any) lines.push('  No active jobs.');
    return lines.join('\n');
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
        if (activeCount >= MAX_FACTORY_OPS_PER_ROOM) blockers.push('busy (' + activeCount + '/' + MAX_FACTORY_OPS_PER_ROOM + ' active jobs)');
        var jobs = [];
        for (var prod in activeFactory) {
            if (activeFactory[prod].room === roomName) jobs.push({ product: prod, phase: activeFactory[prod].phase, isDecompress: DECOMPRESSION_PRODUCTS.indexOf(prod) >= 0 });
        }
        result.factory = { level: factoryLevel, storageEnergy: storageEnergy, hasTerminal: hasTerminal, hasSources: hasSources, eligible: blockers.length === 0, blockers: blockers, activeJobs: jobs };
    }
    var labCount = getRoomLabCount(roomName);
    if (labCount > 0) {
        var lBlockers = [];
        if (!(state && state.terminal)) lBlockers.push('no terminal');
        if (labCount < MIN_LABS)        lBlockers.push('too few labs (' + labCount + ' < ' + MIN_LABS + ')');
        if (!roomHasSupplier(roomName)) lBlockers.push('no supplier creep');
        if (getRoomActiveLabCount(roomName) >= MAX_LAB_OPS_PER_ROOM) lBlockers.push('lab queue full (' + MAX_LAB_OPS_PER_ROOM + '-job limit)');
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
            lines.push('  Labs [' + l.labCount + '] ' + (l.eligible ? 'ELIGIBLE' : 'INELIGIBLE') + ' (max ' + MAX_LAB_OPS_PER_ROOM + ' ops/room, 1 processing)');
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

// ===== Profitability Recheck =====

function recheckActiveJobs(dryRun) {
    var reactionPairs = buildReactionMap();
    var cancelled = [];
    var activeReverse = getActiveReverseReactions();
    var activeForward = getActiveForwardReactions();
    var activeFactory = getActiveFactoryJobs();
    for (var compound in activeReverse) {
        var rInfo = activeReverse[compound];
        if (rInfo.state !== 'BUYING') continue;
        var ra = analyzeReverseReaction(compound, reactionPairs, 'ACTUAL_SELL', 'ACTUAL_BUY');
        if (!ra) continue;
        if (ra.marginPct !== null && ra.marginPct >= MARGIN_THRESHOLD) continue;
        cancelled.push({ type: 'reverse', key: compound, room: rInfo.room, marginPct: ra.marginPct });
        if (!dryRun) global.labReverse('stop', rInfo.room, compound);
    }
    for (var fcompound in activeForward) {
        var fInfo = activeForward[fcompound];
        if (fInfo.state !== 'BUYING') continue;
        var fa = analyzeForwardReaction(fcompound, reactionPairs, 'ACTUAL_BUY', 'ACTUAL_SELL');
        if (!fa) continue;
        if (fa.marginPct !== null && fa.marginPct >= MARGIN_THRESHOLD) continue;
        cancelled.push({ type: 'forward', key: fcompound, room: fInfo.room, marginPct: fa.marginPct });
        if (!dryRun) global.labForward('stop', fInfo.room, fcompound);
    }
    for (var product in activeFactory) {
        var pInfo = activeFactory[product];
        if (pInfo.phase !== 'buying') continue;
        var pa = analyzeFactoryProduct(product, 'ACTUAL_SELL', 'ACTUAL_BUY');
        if (!pa) continue;
        if (pa.marginPct !== null && pa.marginPct >= MARGIN_THRESHOLD) continue;
        cancelled.push({ type: 'factory', key: product, room: pInfo.room, marginPct: pa.marginPct, isDecompress: pa.isDecompress });
        if (!dryRun) global.abortMarketRefine(pInfo.room, product);
    }
    if (!dryRun && cancelled.length > 0) {
        var parts = cancelled.map(function(c) {
            var m = (c.marginPct === null) ? 'N/A' : c.marginPct.toFixed(0) + '%';
            return c.type + ':' + c.key + '(' + m + ')';
        });
        console.log('[autoTrader] Cancelled unprofitable (< ' + MARGIN_THRESHOLD + '%): ' + parts.join(', '));
    }
    return cancelled;
}

// ===== Main Analysis & Execution =====

function runAnalysis() {
    var reactionPairs = buildReactionMap();
    var allCompounds = Object.keys(reactionPairs);
    var activeReverse = getActiveReverseReactions();
    var activeForward = getActiveForwardReactions();
    var activeFactory = getActiveFactoryJobs();
    var opportunities = { reverse: [], forward: [], factory: [] };
    var skippedReverse = [], skippedForward = [], skippedFactory = [], skippedSellLimit = [], skippedBudgetInfeasible = [];

    var circularCompounds = {};
    if (ENABLE_LAB_JOBS) {
        var preReverseMargins = {}, preForwardMargins = {};
        for (var ci = 0; ci < allCompounds.length; ci++) {
            var cc = allCompounds[ci];
            var preRev = analyzeReverseReaction(cc, reactionPairs, 'ACTUAL_SELL', 'ACTUAL_BUY');
            var preFwd = analyzeForwardReaction(cc, reactionPairs, 'ACTUAL_BUY', 'ACTUAL_SELL');
            if (preRev && preRev.marginPct !== null && preRev.marginPct >= MARGIN_THRESHOLD) preReverseMargins[cc] = preRev.marginPct;
            if (preFwd && preFwd.marginPct !== null && preFwd.marginPct >= MARGIN_THRESHOLD) preForwardMargins[cc] = preFwd.marginPct;
            if (preReverseMargins[cc] && preForwardMargins[cc]) circularCompounds[cc] = { revMargin: preReverseMargins[cc], fwdMargin: preForwardMargins[cc] };
        }
        var circularKeys = Object.keys(circularCompounds);
        if (circularKeys.length > 0) {
            console.log('[autoTrader] Skipped (circular spread): ' + circularKeys.map(function(k) {
                var c = circularCompounds[k]; return k + '(fwd ' + c.fwdMargin.toFixed(0) + '% / rev ' + c.revMargin.toFixed(0) + '%)';
            }).join(', '));
        }
    }

    if (ENABLE_LAB_JOBS) {
        for (var i = 0; i < allCompounds.length; i++) {
            var compound = allCompounds[i];
            var analysis = analyzeReverseReaction(compound, reactionPairs, 'ACTUAL_SELL', 'ACTUAL_BUY');
            if (!analysis) continue;
            if (activeReverse[compound]) { skippedReverse.push({ compound: compound, marginPct: analysis.marginPct, room: activeReverse[compound].room, state: activeReverse[compound].state }); continue; }
            if (activeForward[compound]) continue;
            if (circularCompounds[compound]) continue;
            if (analysis.marginPct === null || analysis.marginPct < MARGIN_THRESHOLD) continue;
            if (getCurrentSellAmount(analysis.reagentA) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: compound, marginPct: analysis.marginPct, reason: analysis.reagentA + ' at sell limit' }); continue; }
            if (getCurrentSellAmount(analysis.reagentB) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: compound, marginPct: analysis.marginPct, reason: analysis.reagentB + ' at sell limit' }); continue; }
            opportunities.reverse.push(analysis);
        }
    }

    if (ENABLE_LAB_JOBS) {
        for (var fi = 0; fi < allCompounds.length; fi++) {
            var fCompound = allCompounds[fi];
            var fAnalysis = analyzeForwardReaction(fCompound, reactionPairs, 'ACTUAL_BUY', 'ACTUAL_SELL');
            if (!fAnalysis) continue;
            if (activeForward[fCompound]) { skippedForward.push({ compound: fCompound, marginPct: fAnalysis.marginPct, room: activeForward[fCompound].room, state: activeForward[fCompound].state }); continue; }
            if (activeReverse[fCompound]) continue;
            if (circularCompounds[fCompound]) continue;
            if (fAnalysis.marginPct === null || fAnalysis.marginPct < MARGIN_THRESHOLD) continue;
            if (getCurrentSellAmount(fCompound) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: fCompound, marginPct: fAnalysis.marginPct, reason: fCompound + ' at sell limit' }); continue; }
            opportunities.forward.push(fAnalysis);
        }
    }

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
                console.log('[autoTrader] Skipped ' + product + (fa.isDecompress ? ' [decomp]' : '') + ': opposite direction ' + opposite + ' already active in ' + activeFactory[opposite].room);
                return;
            }
            for (var oi = 0; oi < opportunities.factory.length; oi++) {
                if (opportunities.factory[oi].product === opposite) {
                    if ((fa.marginPct || 0) > (opportunities.factory[oi].marginPct || 0)) { opportunities.factory.splice(oi, 1); } else { return; }
                    break;
                }
            }
        }
        if (isFactoryProductOnCooldown(product)) {
            skippedFactory.push({ product: product, marginPct: fa.marginPct, room: '?', phase: 'cooldown', requiredLevel: fa.requiredLevel, isDecompress: fa.isDecompress });
            return;
        }
        if (fa.marginPct === null || fa.marginPct < MARGIN_THRESHOLD) return;
        // Budget-infeasibility check: vwAsk of inputs must fit the target-margin
        // budget. computeInputPricesForMargin returns null in that case, which
        // would lead to a marketRefine refusal. Skip here with a tagged log line.
        if (computeInputPricesForMargin(product) === null) { skippedBudgetInfeasible.push({ product: product, marginPct: fa.marginPct, isDecompress: fa.isDecompress }); return; }
        if (getCurrentSellAmount(product) >= MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: product, marginPct: fa.marginPct, reason: product + ' at sell limit' }); return; }
        if (getEligibleFactoryRooms(product).length === 0) return;
        opportunities.factory.push(fa);
    }

    if (ENABLE_FACTORY_JOBS) { for (var j = 0; j < SUPPORTED_FACTORY_PRODUCTS.length; j++) evalFactoryProduct(SUPPORTED_FACTORY_PRODUCTS[j]); }
    if (ENABLE_FACTORY_DECOMPRESSION) { for (var d = 0; d < DECOMPRESSION_PRODUCTS.length; d++) evalFactoryProduct(DECOMPRESSION_PRODUCTS[d]); }

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
    if (skippedBudgetInfeasible.length > 0) {
        var biList = skippedBudgetInfeasible.slice(0, 3).map(function(x) { return x.product + '(' + (x.marginPct !== null ? x.marginPct.toFixed(0) : 'n/a') + '%)'; });
        console.log('[autoTrader] Skipped (budget infeasible): ' + biList.join(', ') + (skippedBudgetInfeasible.length > 3 ? ' +' + (skippedBudgetInfeasible.length - 3) + ' more' : ''));
    }

    return { reverse: opportunities.reverse, forward: opportunities.forward, factory: opportunities.factory, skippedReverse: skippedReverse, skippedForward: skippedForward, skippedFactory: skippedFactory, skippedSellLimit: skippedSellLimit, skippedBudgetInfeasible: skippedBudgetInfeasible };
}

function executeJobs(opportunities, dryRun) {
    var labRooms = getEligibleLabReactionRooms();
    var jobsStarted = [], reverseStarted = 0, forwardStarted = 0, factoryStarted = 0;

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
            labRooms.splice(0, 1);
        }
    }

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
            labRooms.splice(0, 1);
        }
    }

    if (ENABLE_FACTORY_JOBS || ENABLE_FACTORY_DECOMPRESSION) {
        for (var j = 0; j < opportunities.factory.length && factoryStarted < MAX_FACTORY_JOBS; j++) {
            var factoryOpp = opportunities.factory[j];
            if (factoryOpp.isDecompress  && !ENABLE_FACTORY_DECOMPRESSION) continue;
            if (!factoryOpp.isDecompress && !factoryOpp.isLocalRefine && !ENABLE_FACTORY_JOBS) continue;
            var factoryRooms = getEligibleFactoryRooms(factoryOpp.product);
            if (factoryRooms.length === 0) {
                var allRooms = getRoomState.all();
                var busyRooms = [];
                for (var brn in allRooms) { if (canRoomProduceProduct(brn, factoryOpp.product) && getRoomActiveFactoryCount(brn) >= MAX_FACTORY_OPS_PER_ROOM) busyRooms.push(brn); }
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
                    var mrResult = global.marketRefine(factoryRoom.name, factoryOpp.product, execInputPrices);
                    var mrRefused = typeof mrResult !== 'string' || mrResult.indexOf('Started') < 0;
                    if (mrRefused) {
                        console.log('[autoTrader] marketRefine REFUSED ' + factoryOpp.product + ' in ' + factoryRoom.name + ': ' + mrResult);
                        jobsStarted.push({ type: 'factory', product: factoryOpp.product, room: factoryRoom.name, margin: factoryOpp.marginPct, level: factoryOpp.requiredLevel, isDecompress: factoryOpp.isDecompress, refused: ('' + mrResult).slice(0, 120), tick: Game.time });
                        factoryStarted++;
                        continue;
                    }
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

// ===== Job Display Helper =====
// Shared by getStatus() (shows last 10) and autoTrader('history') (shows all).
// jobList    = the slice of jobs to render
// allJobs    = the full mem.jobsStarted array (for "is this the latest?" check)
// startIndex = position of jobList[0] within allJobs

function renderJobLines(jobList, allJobs, startIndex, activeReverse, activeForward, activeFactory) {
    var lines = [];
    for (var hi = 0; hi < jobList.length; hi++) {
        var job = jobList[hi];
        var desc = (job.type === 'reverse' || job.type === 'forward') ? job.compound : job.product;
        var levelInfo = job.level > 0 ? ' [L' + job.level + ']' : '';
        var methodInfo = job.method === 'localRefine' ? ' [local]' : (job.isDecompress ? ' [decomp]' : '');
        var priceInfo = job.maxPrice ? ' @' + job.maxPrice.toFixed(2) : '';
        var amountInfo = job.amount ? ' (' + job.amount + ')' : '';
        var timeAgo = ticksToTimeAgo(Game.time - job.tick);

        var isLatestForKey = true;
        for (var li = startIndex + hi + 1; li < allJobs.length; li++) {
            var lj = allJobs[li];
            var ljKey = (lj.type === 'reverse' || lj.type === 'forward') ? lj.compound : lj.product;
            if (lj.type === job.type && ljKey === desc) { isLatestForKey = false; break; }
        }

        var stage = '';
        if (job.type === 'factory' && job.refused) {
            stage = ' [REFUSED: ' + job.refused + ']';
        } else if (job.type === 'factory' && job.method !== 'localRefine') {
            // Marketplace-refine factory job: check active ops first, then fall
            // back to marketRefine's outcomes ledger (Memory.marketRefine.outcomes)
            // to distinguish a real completion from a failed/aborted op that was
            // silently dropped from the active list.
            if (activeFactory[job.product] && activeFactory[job.product].room === job.room) {
                stage = ' [' + activeFactory[job.product].phase + ']';
            } else if (!isLatestForKey) {
                stage = ' [superseded]';
            } else {
                stage = ' [unknown]';
                var outs = (Memory.marketRefine && Memory.marketRefine.outcomes) || [];
                for (var oi2 = outs.length - 1; oi2 >= 0; oi2--) {
                    var oc = outs[oi2];
                    if (oc.room === job.room && oc.output === job.product && oc.started >= job.tick) {
                        stage = (oc.status === 'failed') ? ' [FAILED: ' + oc.reason + ']' : ' [done]';
                        break;
                    }
                }
            }
        } else if (!isLatestForKey) {
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
        } else {
            stage = ' [done]';
        }

        lines.push('    [' + timeAgo + '] ' + job.type + ': ' + desc + levelInfo + methodInfo + priceInfo + amountInfo + ' in ' + job.room + ' (' + job.margin.toFixed(1) + '%)' + stage);
    }
    return lines;
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
    lines.push('  Lab jobs: ' + (ENABLE_LAB_JOBS ? 'ON' : 'OFF') + ' (max ' + MAX_LAB_OPS_PER_ROOM + ' ops/room, 1 processing)');
    lines.push('  Factory compression: ' + (ENABLE_FACTORY_JOBS ? 'ON' : 'OFF'));
    lines.push('  Factory decompression: ' + (ENABLE_FACTORY_DECOMPRESSION ? 'ON' : 'OFF'));
    lines.push('  Banned factory products: ' + (BANNED_FACTORY_PRODUCTS.length > 0 ? BANNED_FACTORY_PRODUCTS.join(', ') : 'none'));
    lines.push('  Run interval: ' + RUN_INTERVAL + ' ticks');
    lines.push('  Last run: ' + (mem.lastRun ? (Game.time - mem.lastRun) + ' ticks ago (tick ' + mem.lastRun + ')' : 'never'));
    lines.push('  Next run in: ' + (mem.lastRun ? Math.max(0, RUN_INTERVAL - (Game.time - mem.lastRun)) + ' ticks' : 'immediately'));
    lines.push('');
    lines.push('  Margin threshold: ' + MARGIN_THRESHOLD + '%');
    lines.push('  Min fill ratio: ' + (MIN_FILL_RATIO * 100) + '% (proceed if >=' + (MIN_FILL_RATIO * 100) + '% of inputs acquired)');
    lines.push('  Max sell amount per resource: ' + MAX_SELL_AMOUNT);
    lines.push('  Max reverse reactions per cycle: ' + MAX_REVERSE_REACTIONS);
    lines.push('  Max forward reactions per cycle: ' + MAX_FORWARD_REACTIONS);
    lines.push('  Max factory jobs per cycle: ' + MAX_FACTORY_JOBS + ' (shared: compression + decompression)');
    lines.push('  Max factory jobs per room: ' + MAX_FACTORY_OPS_PER_ROOM);
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

    // Refused-job aggregation: scan the last few started jobs (newest first)
    // for factory entries that marketRefine refused at execution. Surfaces the
    // class of failure that used to be invisible (the job would be logged once
    // and then sit in history as [REFUSED: ...] without aggregation).
    if (mem.jobsStarted && mem.jobsStarted.length > 0) {
        var refusedByProduct = {};
        var refusedCount = 0;
        for (var ri = mem.jobsStarted.length - 1; ri >= 0; ri--) {
            var rj = mem.jobsStarted[ri];
            if (rj && rj.type === 'factory' && rj.refused) {
                refusedCount++;
                var key = rj.product || '?';
                if (!refusedByProduct[key]) refusedByProduct[key] = { count: 0, lastReason: rj.refused, lastRoom: rj.room, lastTick: rj.tick };
                refusedByProduct[key].count++;
                if (!refusedByProduct[key].lastReason) refusedByProduct[key].lastReason = rj.refused;
            }
        }
        if (refusedCount > 0) {
            lines.push('');
            lines.push('  Refused factory jobs (lifetime): ' + refusedCount);
            var rKeys = Object.keys(refusedByProduct);
            var rShown = 0;
            for (var rki = 0; rki < rKeys.length && rShown < 3; rki++) {
                var rk = rKeys[rki];
                var re = refusedByProduct[rk];
                var ago = ticksToTimeAgo(Game.time - re.lastTick);
                lines.push('    ' + rk + ' x' + re.count + ' (last: ' + re.lastRoom + ' ' + ago + ', reason: ' + re.lastReason + ')');
                rShown++;
            }
            if (rKeys.length > rShown) lines.push('    +' + (rKeys.length - rShown) + ' more products refused');
        }
    }

    if (mem.jobsStarted && mem.jobsStarted.length > 0) {
        var activeReverse = getActiveReverseReactions();
        var activeForward = getActiveForwardReactions();
        var activeFactory = getActiveFactoryJobs();
        var allJobs = mem.jobsStarted;
        var recentJobs = allJobs.slice(-10);
        var recentStartIdx = allJobs.length - recentJobs.length;

        lines.push('');
        lines.push('  Recent jobs started (last 10 of ' + allJobs.length + '; use autoTrader(\'history\') for all):');
        var jobLines = renderJobLines(recentJobs, allJobs, recentStartIdx, activeReverse, activeForward, activeFactory);
        for (var i = 0; i < jobLines.length; i++) lines.push(jobLines[i]);
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

    if (command === 'active') return getActiveReport();

    if (command === 'history') {
        if (!mem.jobsStarted || mem.jobsStarted.length === 0) return '[autoTrader] No job history recorded.';
        var activeReverse = getActiveReverseReactions();
        var activeForward = getActiveForwardReactions();
        var activeFactory = getActiveFactoryJobs();
        var allJobs = mem.jobsStarted;
        var lines = ['[autoTrader] Full Job History (' + allJobs.length + ' of max ' + JOBS_HISTORY_CAP + '):', ''];
        var jobLines = renderJobLines(allJobs, allJobs, 0, activeReverse, activeForward, activeFactory);
        for (var hi = 0; hi < jobLines.length; hi++) lines.push(jobLines[hi]);
        return lines.join('\n');
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

        var wouldCancel = recheckActiveJobs(true);
        if (wouldCancel.length > 0) {
            lines.push('');
            lines.push('WOULD CANCEL (now < ' + MARGIN_THRESHOLD + '%, still buying):');
            for (var wc = 0; wc < wouldCancel.length; wc++) {
                var c = wouldCancel[wc];
                var m = (c.marginPct === null) ? 'N/A' : c.marginPct.toFixed(1) + '%';
                lines.push('  ' + c.type + ': ' + c.key + (c.isDecompress ? ' [decomp]' : '') + ' in ' + c.room + ' @ ' + m);
            }
        }

        return lines.join('\n');
    }

    if (command === 'run') {
        console.log('[autoTrader] Manual run triggered at tick ' + Game.time);
        recheckActiveJobs(false);
        var results = runAnalysis();
        var counts = countFactoryOpps(results.factory);
        mem.lastAnalysis = { tick: Game.time, reverseCount: results.reverse.length, forwardCount: results.forward.length, compressCount: counts.compressCount, decompressCount: counts.decompressCount };
        var jobs = executeJobs(results, false);
        mem.lastRun = Game.time;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) mem.jobsStarted.push(jobs[k]);
            if (mem.jobsStarted.length > JOBS_HISTORY_CAP) mem.jobsStarted = mem.jobsStarted.slice(-JOBS_HISTORY_CAP);
        }
        return '[autoTrader] Run complete. Started ' + jobs.length + ' job(s).';
    }

    return '[autoTrader] Unknown command: ' + command + '. Use: run, analyze, active, history, rooms [filter], enable, disable, reset, clearCooldown <product>';
};

// ===== Market Status Commands =====

function parseMarketCommandArgs(mode, roomName) {
    var room = (typeof roomName === 'string' && roomName.trim()) ? roomName.trim() : null;
    if (!mode || mode === 'compact' || mode === 'expanded') {
        return { view: mode === 'expanded' ? 'expanded' : 'compact', resourceType: null, roomName: room };
    }
    return { view: 'resource', resourceType: mode, roomName: room };
}

function renderMarketOrders(label, orders, mode, roomName) {
    var parsed = parseMarketCommandArgs(mode, roomName);
    var scopedOrders = orders;
    if (parsed.roomName) {
        scopedOrders = scopedOrders.filter(function(o) { return o.roomName === parsed.roomName; });
    }
    if (scopedOrders.length === 0) {
        return parsed.roomName ? '[' + label + '] No active ' + label + ' orders in ' + parsed.roomName + '.' : '[' + label + '] No active ' + label + ' orders.';
    }

    if (parsed.resourceType) {
        var filtered = scopedOrders.filter(function(o) { return o.resourceType === parsed.resourceType; });
        if (filtered.length === 0) return '[' + label + '] No ' + label + ' orders for ' + parsed.resourceType + (parsed.roomName ? ' in ' + parsed.roomName : '');
        var lines = ['[' + label + '] ' + parsed.resourceType + (parsed.roomName ? ' in ' + parsed.roomName : '') + ': ' + filtered.length + ' order(s)'];
        var totalRemaining = 0, totalOriginal = 0;
        for (var i = 0; i < filtered.length; i++) {
            var o = filtered[i];
            totalRemaining += o.remainingAmount;
            totalOriginal  += o.amount;
            var orderFilled = o.amount - o.remainingAmount;
            lines.push('  ' + o.roomName + ': ' + orderFilled + '/' + o.amount + ' filled (' + fmtPct(orderFillPct(o)) + ') @ ' + o.price.toFixed(3));
        }
        var aggPct = totalOriginal > 0 ? ((totalOriginal - totalRemaining) / totalOriginal) * 100 : 0;
        var totalFilled = totalOriginal - totalRemaining;
        lines.push('  Total: ' + totalFilled + '/' + totalOriginal + ' filled (' + aggPct.toFixed(1) + '%)');
        return lines.join('\n');
    }

    var expanded = parsed.view === 'expanded';
    var byResource = {};
    for (var j = 0; j < scopedOrders.length; j++) {
        var order = scopedOrders[j];
        var res = order.resourceType;
        if (!byResource[res]) byResource[res] = { orders: [], remaining: 0, original: 0 };
        byResource[res].orders.push(order);
        byResource[res].remaining += order.remainingAmount;
        byResource[res].original  += order.amount;
    }
    var resources = Object.keys(byResource).sort(function(a, b) { return byResource[b].remaining - byResource[a].remaining; });
    var header = '[' + label + '] ' + scopedOrders.length + ' active ' + label + ' order(s) across ' + resources.length + ' resource(s)';
    if (parsed.roomName) header += ' in ' + parsed.roomName;
    var lines2 = [header + ':', ''];
    for (var k = 0; k < resources.length; k++) {
        var resource = resources[k]; var data = byResource[resource];
        var aggPct2 = data.original > 0 ? ((data.original - data.remaining) / data.original) * 100 : 0;
        if (expanded) {
            var filledExpanded = data.original - data.remaining;
            lines2.push(resource + ': ' + filledExpanded + '/' + data.original + ' filled (' + aggPct2.toFixed(1) + '%)');
            for (var m = 0; m < data.orders.length; m++) {
                var oo = data.orders[m];
                var orderFilled2 = oo.amount - oo.remainingAmount;
                lines2.push('  ' + oo.roomName + ': ' + orderFilled2 + '/' + oo.amount + ' filled (' + fmtPct(orderFillPct(oo)) + ') @ ' + oo.price.toFixed(3));
            }
            lines2.push('');
        } else {
            var avg = 0; for (var n = 0; n < data.orders.length; n++) avg += data.orders[n].price; avg = avg / data.orders.length;
            var filledCompact = data.original - data.remaining;
            if (label === 'buying') {
                var roomAmounts = {};
                for (var n2 = 0; n2 < data.orders.length; n2++) {
                    var rn = data.orders[n2].roomName;
                    roomAmounts[rn] = (roomAmounts[rn] || 0) + data.orders[n2].remainingAmount;
                }
                var rooms = Object.keys(roomAmounts).sort().map(function(r) { return r + ' (' + roomAmounts[r] + ')'; }).join(', ');
                lines2.push('  ' + resource + ': ' + filledCompact + '/' + data.original + ' filled (' + aggPct2.toFixed(1) + '%) | ' + data.orders.length + ' orders | avg ' + avg.toFixed(3) + ' | rooms: ' + rooms);
            } else {
                lines2.push('  ' + resource + ': ' + filledCompact + '/' + data.original + ' filled (' + aggPct2.toFixed(1) + '%) | ' + data.orders.length + ' orders | avg ' + avg.toFixed(3));
            }
        }
    }
    return lines2.join('\n');
}

global.selling = function(mode, roomName) {
    var orders = Game.market.orders;
    var sellOrders = [];
    for (var id in orders) { var o = orders[id]; if (o.type === ORDER_SELL && o.remainingAmount > 0) sellOrders.push(o); }
    return renderMarketOrders('selling', sellOrders, mode, roomName);
};

global.buying = function(mode, roomName) {
    var orders = Game.market.orders;
    var buyOrders = [];
    for (var id in orders) { var o = orders[id]; if (o.type === ORDER_BUY && o.remainingAmount > 0) buyOrders.push(o); }
    return renderMarketOrders('buying', buyOrders, mode, roomName);
};

// ===== Main Module Export =====

module.exports = {
    run: function() {
        if (!ENABLED) return;
        var mem = ensureMemory();
        if (!mem.enabled) return;
        if (mem.lastRun && (Game.time - mem.lastRun) < RUN_INTERVAL) return;

        getRoomState.init();
        recheckActiveJobs(false);
        var results = runAnalysis();
        var counts = countFactoryOpps(results.factory);
        mem.lastAnalysis = { tick: Game.time, reverseCount: results.reverse.length, forwardCount: results.forward.length, compressCount: counts.compressCount, decompressCount: counts.decompressCount };

        var jobs = executeJobs(results, false);
        mem.lastRun = Game.time;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) mem.jobsStarted.push(jobs[k]);
            if (mem.jobsStarted.length > JOBS_HISTORY_CAP) mem.jobsStarted = mem.jobsStarted.slice(-JOBS_HISTORY_CAP);
        }
    }
};
