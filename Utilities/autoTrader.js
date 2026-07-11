// LLM: Read llmcontext.js before reviewing or changing this file.
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
var roomSuspender = require('roomSuspender');
var util = require('util');
var memoryManager = require('memoryManager');

// Configuration
var ENABLED = true;
var ENABLE_LAB_JOBS = true;                // Set to false to skip all lab reactions (reverse + forward)
var ENABLE_FACTORY_JOBS = true;            // Set to false to skip all factory compression jobs
var ENABLE_FACTORY_DECOMPRESSION = false;   // Set to false to skip all factory decompression jobs
var RUN_INTERVAL = 100;
var MARGIN_THRESHOLD = 40; // percent
var MAX_REVERSE_REACTIONS = 10;
var MAX_FORWARD_REACTIONS = 10;
var MAX_LAB_OPS_PER_ROOM = 10;   // queued buys allowed per room (forward+reverse combined); only 1 ever processes
var MAX_FACTORY_JOBS = 10;   // Shared pool covering both compression and decompression
var MAX_FACTORY_OPS_PER_ROOM = 1; // factoryManager is FIFO: one runnable factory job per room
var MIN_STORAGE_ENERGY = 150000;
var REQUIRED_SOURCES = 1;
var MIN_LABS = 3;
var MAX_SELL_AMOUNT = 21000; // Cap existing orders plus active and newly selected output
var FACTORY_JOB_COOLDOWN = 100; // Don't re-start the same factory product within this many ticks
var JOBS_HISTORY_CAP = 30; // Maximum number of jobs to retain in memory
var MARKET_REFINE_BATCH_MULTIPLIER = 12;
var LAB_PROJECTED_OUTPUT = 3000; // marketLab caps each operation at this amount

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

function requestSave() {
    if (memoryManager && typeof memoryManager.requestSave === 'function') memoryManager.requestSave();
}

// ===== Price Helpers =====

function getOrderInfo(resource, orderType) {
    var orders = util.marketOrders(resource, orderType);
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

// Prices are gross market values. They intentionally omit terminal transaction
// energy and posted-order credit fees; the 40% margin threshold is the buffer.
// Volume-weighted ask for a non-energy resource: what it would cost to actually
// buy (e.g. via opportunisticBuy.deal()) given the real ask depth. Used as the
// cost basis in the analyses so reported margins reflect what marketRefine can
// actually fill at, not the cheap bestBid+0.1 used for a posted marketBuy bid.
// Falls back to ACTUAL_SELL (bestAsk-0.1) when the book is empty so margin
// calculations still have a number to work with.
function getVolumeWeightedBuyPrice(resource) {
    if (resource === RESOURCE_ENERGY) return { price: pricing.actualBuyPrice(resource), source: 'ABUY', orderCount: 0, volume: 0 };
    var book = pricing.getBook(resource);
    if (book && typeof book.vwAsk === 'number' && book.vwAsk > 0) {
        return { price: book.vwAsk, source: 'VWAP', orderCount: book.askCount || 0, volume: book.askVol || 0 };
    }
    return { price: pricing.actualSellPrice(resource), source: 'ASELL', orderCount: 0, volume: 0 };
}

function priceOfWithSource(resource, mode) {
    if (mode === 'ACTUAL_BUY')  return { price: pricing.actualBuyPrice(resource),  source: 'ABUY',  orderCount: 0, volume: 0 };
    if (mode === 'ACTUAL_SELL') return { price: pricing.actualSellPrice(resource), source: 'ASELL', orderCount: 0, volume: 0 };
    // Energy 'sell' means "what we'd pay to acquire it" (posted-buy cost), not the ask.
    if (resource === RESOURCE_ENERGY && mode === 'sell') return { price: pricing.actualBuyPrice(resource), source: 'ABUY', orderCount: 0, volume: 0 };
    if (mode === 'avg') {
        var avg = pricing.getAvg48h(resource);
        if (avg !== null) return { price: avg, source: 'HIST', orderCount: 0, volume: 0 };
        var sellInfo = getOrderInfo(resource, ORDER_SELL);
        if (sellInfo.bestPrice !== null) return { price: sellInfo.bestPrice, source: 'LIVE', orderCount: sellInfo.count, volume: sellInfo.totalVolume };
        return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }
    if (mode === 'buy' || mode === 'sell') {
        var orderInfo = getOrderInfo(resource, mode === 'buy' ? ORDER_BUY : ORDER_SELL);
        if (orderInfo.bestPrice !== null) return { price: orderInfo.bestPrice, source: 'LIVE', orderCount: orderInfo.count, volume: orderInfo.totalVolume };
        var histPrice = pricing.getAvg48h(resource);
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

function getRoomFactory(roomName) {
    var state = getRoomState.get(roomName);
    if (!state || !state.isOwned || !state.structuresByType || !state.structuresByType[STRUCTURE_FACTORY]) return null;
    var factories = state.structuresByType[STRUCTURE_FACTORY];
    return factories.length > 0 ? factories[0] : null;
}

function getLiveFactoryEffectLevel(roomName) {
    var factory = getRoomFactory(roomName);
    if (!factory || !factory.effects) return null;
    for (var i = 0; i < factory.effects.length; i++) {
        var effect = factory.effects[i];
        if (effect && effect.effect === PWR_OPERATE_FACTORY && (effect.ticksRemaining === undefined || effect.ticksRemaining > 0)) return effect.level;
    }
    return null;
}

function canRoomProduceProduct(roomName, product) {
    var requiredLevel = getProductFactoryLevel(product);
    if (requiredLevel === null) return false;
    if (!getRoomFactory(roomName)) return false;
    if (requiredLevel === 0) return true;
    return getLiveFactoryEffectLevel(roomName) === requiredLevel;
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
    // Stock is room-scoped, so colony-wide sell orders cannot prove that the
    // eventual execution room owns this input. Price external acquisition.
    var compoundInfo = getVolumeWeightedBuyPrice(compound);
    var compoundPrice = compoundInfo.price;
    var compoundOpportunityCost = compoundPrice;
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
    return { type: 'reverse', compound: compound, reagentA: reagentA, reagentB: reagentB, batchSize: batch, marginPct: marginPct, profit: profit, compoundPrice: compoundPrice, compoundVolume: compoundInfo.volume };
}

function analyzeForwardReaction(compound, reactionPairs, reagentBuyMode, compoundSellMode) {
    var pair = reactionPairs[compound];
    if (!pair) return null;
    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    var reagentA = pair[0], reagentB = pair[1];
    var pA = getVolumeWeightedBuyPrice(reagentA);
    var reagentAPrice = pA.price;
    var reagentAOpportunityCost = pA.price;
    var pB = getVolumeWeightedBuyPrice(reagentB);
    var reagentBPrice = pB.price;
    var reagentBOpportunityCost = pB.price;
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
    return { type: 'forward', compound: compound, reagentA: reagentA, reagentB: reagentB, batchSize: batch, marginPct: marginPct, profit: profit, reagentAPrice: reagentAPrice, reagentBPrice: reagentBPrice, compoundPrice: compoundInfo.price, compoundVolume: compoundInfo.volume };
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
    return { type: 'factory', product: resource, marginPct: marginPct, profit: profit, unitPrice: unitPrice, outputVolume: outputInfo.volume, expectedOutput: outQty * MARKET_REFINE_BATCH_MULTIPLIER, requiredLevel: getProductFactoryLevel(resource), inputPrices: inputPrices, isLocalRefine: isLocalRefineProduct, isDecompress: isDecompress, ingredientCost: ingredientCost, cooldown: cooldown };
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
    if (energyQty > 0) energyCost = pricing.actualBuyPrice(RESOURCE_ENERGY) * energyQty;
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

    // Scale the ceilings up to the full margin budget instead of handing back
    // the raw bids. marketBuy posts AT the bid either way (computeCompetitiveBid
    // caps at the bid, not the ceiling), but the headroom is what lets its
    // up-repricer chase a climbing bestBid and lets opportunisticBuy reach
    // deeper into the ask book. Worst case - every input fills exactly at its
    // ceiling - total cost is energyCost + remainingBudget = revenue/(1+margin),
    // so the MARGIN_THRESHOLD guarantee against the intended sell price holds.
    var scale = remainingBudget / naiveCost;
    var inputPrices = {};
    for (var res2 in comps) {
        if (!comps.hasOwnProperty(res2) || res2 === RESOURCE_ENERGY) continue;
        inputPrices[res2] = postedBids[res2] * scale;
    }
    return inputPrices;
}

// ===== Currently Processing Detection =====

function buildCurrentSellAmounts() {
    var totals = {};
    var orders = Game.market.orders;
    for (var id in orders) {
        var order = orders[id];
        if (order.type !== ORDER_SELL || order.remainingAmount <= 0) continue;
        totals[order.resourceType] = (totals[order.resourceType] || 0) + order.remainingAmount;
    }
    var dirs = [Memory.marketLabReverse, Memory.marketLabForward];
    for (var d = 0; d < dirs.length; d++) {
        var rooms = dirs[d] && dirs[d].rooms;
        if (!rooms) continue;
        for (var roomName in rooms) {
            var queue = rooms[roomName] || [];
            for (var q = 0; q < queue.length; q++) {
                var lop = queue[q];
                if (!lop || !lop.targetCompound) continue;
                var amount = lop.batchSize || 0;
                if (d === 1) totals[lop.targetCompound] = (totals[lop.targetCompound] || 0) + amount;
                else if (lop.reagents) {
                    for (var r = 0; r < lop.reagents.length; r++) totals[lop.reagents[r]] = (totals[lop.reagents[r]] || 0) + amount;
                }
            }
        }
    }
    var factoryOps = [];
    if (Memory.marketRefine && Array.isArray(Memory.marketRefine.ops)) factoryOps = factoryOps.concat(Memory.marketRefine.ops);
    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) factoryOps = factoryOps.concat(Memory.localRefine.ops);
    for (var f = 0; f < factoryOps.length; f++) {
        var fop = factoryOps[f];
        if (!fop || !fop.output || !isLiveRefineOp(fop)) continue;
        var expected = refineExpectedOutput(fop);
        if (expected === null && fop.requiredAmount) expected = recipeExpectedOutput(fop.output, fop.requiredAmount, fop.input);
        if (expected !== null) totals[fop.output] = (totals[fop.output] || 0) + expected;
    }
    var linkedFactoryOrders = collectRefineFactoryOrderIds();
    var standalone = Array.isArray(Memory.factoryOrders) ? Memory.factoryOrders : [];
    for (var so = 0; so < standalone.length; so++) {
        var factoryOrder = standalone[so];
        if (!factoryOrder || !factoryOrder.product || factoryOrder.status === 'done' || factoryOrder.status === 'cancelled') continue;
        if (factoryOrder.id && linkedFactoryOrders[factoryOrder.id]) continue;
        var remainingOutput = Math.max(0, (factoryOrder.requested || 0) - (factoryOrder.progressOut || 0));
        totals[factoryOrder.product] = (totals[factoryOrder.product] || 0) + remainingOutput;
    }
    return totals;
}

function addActive(map, key, entry) {
    if (!map[key]) map[key] = [];
    map[key].push(entry);
}

function firstActive(map, key) {
    return map[key] && map[key].length > 0 ? map[key][0] : null;
}

function firstBlockingActive(map, key) {
    var entries = map[key] || [];
    for (var i = 0; i < entries.length; i++) { if (entries[i].blocksProduction !== false) return entries[i]; }
    return null;
}

function isLiveRefineOp(op) {
    return !!(op && op.phase !== 'done' && op.phase !== 'failed' && op.phase !== 'error' && op.phase !== 'cancelled');
}

function getActiveReverseReactions() {
    var active = {};
    if (Memory.marketLabReverse && Memory.marketLabReverse.rooms) {
        for (var roomName in Memory.marketLabReverse.rooms) {
            var queue = Memory.marketLabReverse.rooms[roomName];
            if (!queue) continue;
            for (var i = 0; i < queue.length; i++) {
                var op = queue[i];
                if (op && op.targetCompound) addActive(active, op.targetCompound, { id: op.id, room: roomName, state: op.state, blocksProduction: op.state !== 'SELLING', displayPhase: getLabDisplayPhase(op, roomName) });
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
                if (op && op.targetCompound) addActive(active, op.targetCompound, { id: op.id, room: roomName, state: op.state, blocksProduction: op.state !== 'SELLING', displayPhase: getLabDisplayPhase(op, roomName) });
            }
        }
    }
    return active;
}

function getBuyingReverseReactions() {
    var active = {};
    if (Memory.marketLabReverse && Memory.marketLabReverse.rooms) {
        for (var roomName in Memory.marketLabReverse.rooms) {
            var queue = Memory.marketLabReverse.rooms[roomName];
            if (!queue) continue;
            for (var i = 0; i < queue.length; i++) {
                var op = queue[i];
                if (op && op.targetCompound && op.state === 'BUYING') addActive(active, op.targetCompound, { id: op.id, room: roomName, state: op.state });
            }
        }
    }
    return active;
}

function getBuyingForwardReactions() {
    var active = {};
    if (Memory.marketLabForward && Memory.marketLabForward.rooms) {
        for (var roomName in Memory.marketLabForward.rooms) {
            var queue = Memory.marketLabForward.rooms[roomName];
            if (!queue) continue;
            for (var i = 0; i < queue.length; i++) {
                var op = queue[i];
                if (op && op.targetCompound && op.state === 'BUYING') addActive(active, op.targetCompound, { id: op.id, room: roomName, state: op.state });
            }
        }
    }
    return active;
}

function getActiveFactoryJobs() {
    var active = {};
    var linkedFactoryOrders = collectRefineFactoryOrderIds();
    if (Memory.marketRefine && Memory.marketRefine.ops) {
        for (var i = 0; i < Memory.marketRefine.ops.length; i++) {
            var op = Memory.marketRefine.ops[i];
            if (op && op.output && isLiveRefineOp(op)) addActive(active, op.output, { id: op.id, room: op.room, phase: op.phase, displayPhase: getFactoryDisplayPhase(op, 'marketRefine') });
        }
    }
    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) {
        for (var lr = 0; lr < Memory.localRefine.ops.length; lr++) {
            var lrOp = Memory.localRefine.ops[lr];
            if (lrOp && lrOp.output && isLiveRefineOp(lrOp)) addActive(active, lrOp.output, { id: lrOp.id, room: lrOp.room, phase: lrOp.phase || 'localRefine', source: 'localRefine', displayPhase: getFactoryDisplayPhase(lrOp, 'localRefine') });
        }
    }
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (var j = 0; j < Memory.factoryOrders.length; j++) {
            var order = Memory.factoryOrders[j];
            if (order && order.product && order.status !== 'done' && order.status !== 'cancelled' && !(order.id && linkedFactoryOrders[order.id])) addActive(active, order.product, { id: order.id, room: order.room, phase: 'factoryOrder', source: 'factoryOrder', displayPhase: getFactoryDisplayPhase(order, 'factoryOrder') });
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
    var linkedFactoryOrders = collectRefineFactoryOrderIds();
    if (Memory.marketRefine && Memory.marketRefine.ops) {
        for (var i = 0; i < Memory.marketRefine.ops.length; i++) { var op = Memory.marketRefine.ops[i]; if (op && op.room === roomName && isLiveRefineOp(op)) count++; }
    }
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        for (var j = 0; j < Memory.factoryOrders.length; j++) { var order = Memory.factoryOrders[j]; if (order && order.room === roomName && order.status !== 'done' && order.status !== 'cancelled' && !(order.id && linkedFactoryOrders[order.id])) count++; }
    }
    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) {
        for (var lr = 0; lr < Memory.localRefine.ops.length; lr++) { var lrOp = Memory.localRefine.ops[lr]; if (lrOp && lrOp.room === roomName && isLiveRefineOp(lrOp)) count++; }
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
    var idx = getRoomState.creepIndex();
    var creeps = idx && idx.all ? idx.all : [];
    for (var i = 0; i < creeps.length; i++) { var creep = creeps[i]; if (creep.memory.role === 'supplier' && creep.room.name === roomName) return true; }
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
    if (LOCAL_REFINE_PRODUCTS.indexOf(product) >= 0 && getRoomStorageEnergy(roomName) < LOCAL_REFINE_ENERGY_RESERVE + 1000) return false;
    return canRoomProduceProduct(roomName, product);
}

function getEligibleLabReactionRooms() {
    var rooms = [];
    var roomNames = getRoomState.ownedNames();
    for (var i = 0; i < roomNames.length; i++) {
        var roomName = roomNames[i];
        if (roomSuspender.shouldAvoidRoomWork(roomName)) continue;
        if (!isEligibleForLabReaction(roomName)) continue;
        if (getRoomActiveLabCount(roomName) >= MAX_LAB_OPS_PER_ROOM) continue;
        var labOrders = Memory.labOrders && Memory.labOrders[roomName];
        var labManagerBusy = !!(labOrders && (labOrders.active || (labOrders.queue && labOrders.queue.length > 0)));
        rooms.push({
            name: roomName,
            labCount: getRoomLabCount(roomName),
            activeLabOps: getRoomActiveLabCount(roomName),
            labManagerBusy: labManagerBusy
        });
    }
    rooms.sort(function(a, b) {
        if (a.labManagerBusy !== b.labManagerBusy) return a.labManagerBusy ? 1 : -1;
        if (a.activeLabOps !== b.activeLabOps) return a.activeLabOps - b.activeLabOps;
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
    var roomNames = getRoomState.ownedNames();
    for (var i = 0; i < roomNames.length; i++) {
        var roomName = roomNames[i];
        if (roomSuspender.shouldAvoidRoomWork(roomName)) continue;
        if (isEligibleForFactory(roomName, product)) {
            var liveLevel = getLiveFactoryEffectLevel(roomName);
            rooms.push({ name: roomName, orderCount: getRoomActiveFactoryCount(roomName), storageEnergy: getRoomStorageEnergy(roomName), factoryLevel: liveLevel === null ? 0 : liveLevel });
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
    var roomNames = getRoomState.ownedNames();
    for (var i = 0; i < roomNames.length; i++) {
        var roomName = roomNames[i];
        if (roomSuspender.shouldAvoidRoomWork(roomName)) continue;
        var level = getLiveFactoryEffectLevel(roomName);
        if (level === null && getRoomFactory(roomName)) level = 0;
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
function getMarketBuyFulfilled(roomName, resource, queueName, opId) {
    var mb = global.marketBuy;
    if (!mb) { try { mb = require('marketBuy'); } catch (e) { mb = null; } }
    if (!mb || typeof mb.getOrderRecordFor !== 'function' || typeof mb.getFulfilled !== 'function') return null;
    try {
        var rec = mb.getOrderRecordFor(roomName, resource, queueName, opId);
        if (rec) return mb.getFulfilled(rec);
    } catch (e) {}
    return null;
}

function isMarketBuyOrderLive(roomName, resource, queueName, opId) {
    var mb = global.marketBuy;
    if (!mb) { try { mb = require('marketBuy'); } catch (e) { mb = null; } }
    if (!mb || typeof mb.getOrderRecordFor !== 'function') return true; // can't verify, assume live
    try {
        var rec = mb.getOrderRecordFor(roomName, resource, queueName, opId);
        if (!rec) return false;
        if (rec.done || rec.cancelled) return false;
        if (!rec.orderId) return false; // still pending id capture
        return !!Game.market.orders[rec.orderId];
    } catch (e) { return true; }
}

function refineInputAcquired(op, inp) {
    if (inp.useMarketBuy) {
        var f = getMarketBuyFulfilled(op.room, inp.resource, 'factory', op.id);
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
    var progress = getOrderProgress(o);
    if (!progress || progress.original <= 0) return null;
    return Math.max(0, Math.min(100, (progress.filled / progress.original) * 100));
}

function getOrderProgress(o) {
    if (!o) return null;
    var remaining = (typeof o.remainingAmount === 'number') ? o.remainingAmount : 0;
    var amount = (typeof o.amount === 'number') ? o.amount : 0;
    var total = (typeof o.totalAmount === 'number') ? o.totalAmount : 0;
    if (remaining < 0) remaining = 0;
    if (amount < 0) amount = 0;
    if (total < 0) total = 0;

    var original = Math.max(total, amount, remaining);
    var filled = Math.max(0, original - remaining);
    return { original: original, remaining: remaining, filled: filled };
}

function fmtPct(p) { return (p === null) ? '?' : p.toFixed(1) + '%'; }

function findFactoryOrderById(orderId) {
    if (!orderId || !Memory.factoryOrders || !Array.isArray(Memory.factoryOrders)) return null;
    for (var i = 0; i < Memory.factoryOrders.length; i++) {
        var order = Memory.factoryOrders[i];
        if (order && order.id === orderId) return order;
    }
    return null;
}

function getLabOrderForMarketOp(roomName, op) {
    var rm = Memory.labOrders && Memory.labOrders[roomName];
    if (!rm || !rm.active) return null;
    var active = rm.active;
    if (op && op.id && active.marketOpId === op.id) return active;
    if (active.origin === 'marketLab') return active;
    return null;
}

function getLabDisplayPhase(op, roomName) {
    if (!op || !op.state) return 'STAGING';
    if (op.state === 'BUYING') return 'BUYING';
    if (op.state === 'WAITING') return 'STAGING';
    if (op.state === 'STAGING') return 'DELIVERING';
    if (op.state === 'SELLING') return 'SELLING';
    if (op.state === 'PROCESSING') {
        if (!op.reactionStarted) return 'STAGING';
        var order = getLabOrderForMarketOp(roomName, op);
        if (order) {
            if (order.evacuating) return 'DELIVERING';
            if (order.needsPreEvacuation) return 'STAGING';
        }
        return 'PROCESSING';
    }
    return op.state;
}

function getFactoryDisplayPhase(op, source) {
    if (!op) return 'STAGING';

    if (source === 'marketRefine') {
        if (op.phase === 'buying') return 'BUYING';
        if (op.phase === 'selling') return 'SELLING';
        if (op.phase === 'refining') {
            var mOrder = findFactoryOrderById(op.factoryOrderId);
            if (!op.factoryStarted) return 'STAGING';
            if (mOrder && mOrder.phase === 'unloading') return 'DELIVERING';
            return 'PROCESSING';
        }
        return String(op.phase || 'STAGING').toUpperCase();
    }

    if (source === 'localRefine') {
        if (op.phase === 'selling') return 'SELLING';
        if (op.phase === 'refining') {
            var lOrder = findFactoryOrderById(op.factoryOrderId);
            if (!op.factoryStarted) return 'STAGING';
            if (lOrder && lOrder.phase === 'unloading') return 'DELIVERING';
            return 'PROCESSING';
        }
        return String(op.phase || 'STAGING').toUpperCase();
    }

    var phase = op.phase || 'loading';
    if (op.status === 'queued' || phase === 'loading') return 'STAGING';
    if (phase === 'processing') return 'PROCESSING';
    if (phase === 'unloading') return 'DELIVERING';
    return String(phase).toUpperCase();
}

function fmtExpectedOutputs(op, roomName) {
    var outputs = op && op.expectedOutputs;
    if (!outputs) return '';
    var parts = [];
    for (var res in outputs) {
        if (!outputs.hasOwnProperty(res)) continue;
        parts.push(fmtBought(res, terminalCount(roomName, res), outputs[res]));
    }
    return parts.join(', ');
}

function collectRefineFactoryOrderIds() {
    var ids = {};
    if (Memory.marketRefine && Array.isArray(Memory.marketRefine.ops)) {
        for (var i = 0; i < Memory.marketRefine.ops.length; i++) {
            var op = Memory.marketRefine.ops[i];
            if (op && op.factoryOrderId) ids[op.factoryOrderId] = true;
        }
    }
    if (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) {
        for (var j = 0; j < Memory.localRefine.ops.length; j++) {
            var lop = Memory.localRefine.ops[j];
            if (lop && lop.factoryOrderId) ids[lop.factoryOrderId] = true;
        }
    }
    return ids;
}

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
                if (!op || !op.targetCompound) continue;
                any = true;
                var reagentStr = op.reagents ? op.reagents.join('+') : '?';
                var arrow = isFwd ? (reagentStr + '->' + op.targetCompound) : (op.targetCompound + '->' + reagentStr);
                var labPhase = getLabDisplayPhase(op, room);
                lines.push((isFwd ? 'forward ' : 'reverse ') + op.targetCompound + ' in ' + room + ' [' + labPhase + '] (' + arrow + ')');

                if (op.state === 'BUYING') {
                    var bparts = [];
                    if (isFwd && op.reagents) {
                        for (var ri = 0; ri < op.reagents.length; ri++) bparts.push(fmtBought(op.reagents[ri], terminalCount(room, op.reagents[ri]), op.batchSize, ' (opportunisticBuy)'));
                    } else {
                        bparts.push(fmtBought(op.targetCompound, terminalCount(room, op.targetCompound), op.batchSize, ' (opportunisticBuy)'));
                    }
                    lines.push('    buying     ' + bparts.join(', '));
                } else if (labPhase === 'STAGING') {
                    lines.push('    staging    inputs acquired, ' + (op.state === 'WAITING' ? 'labs busy' : 'preparing lab order'));
                } else if (labPhase === 'PROCESSING') {
                    var pparts = [];
                    if (isFwd) {
                        pparts.push(fmtProduced(op.targetCompound, terminalCount(room, op.targetCompound), op.batchSize));
                    } else if (op.reagents) {
                        for (var ri2 = 0; ri2 < op.reagents.length; ri2++) pparts.push(fmtProduced(op.reagents[ri2], terminalCount(room, op.reagents[ri2]), op.batchSize));
                    }
                    lines.push('    producing  ' + pparts.join(', '));
                } else if (labPhase === 'DELIVERING') {
                    var delivering = fmtExpectedOutputs(op, room);
                    lines.push('    delivering ' + (delivering || 'outputs to terminal'));
                } else if (labPhase === 'SELLING') {
                    var selling = fmtExpectedOutputs(op, room);
                    lines.push('    selling    ' + (op.sellOrderCreated ? 'sell orders active' : 'preparing sell orders') + (selling ? ' | terminal: ' + selling : ''));
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
            var mPhase = getFactoryDisplayPhase(mop, 'marketRefine');
            lines.push('factory ' + mop.output + decompTag + ' in ' + mop.room + ' [' + mPhase + ']');
            if (mop.phase === 'buying') {
                var iparts = [];
                if (mop.inputs && mop.inputs.length) {
                    for (var ii = 0; ii < mop.inputs.length; ii++) {
                        var inp = mop.inputs[ii];
                        var via = inp.useMarketSell ? ' (marketSell)' : (inp.useMarketBuy ? ' (marketBuy)' : ' (roomStock)');
                        if (inp.useMarketBuy && !isMarketBuyOrderLive(mop.room, inp.resource, 'factory', mop.id)) {
                            via += ' [order missing/cancelled]';
                        }
                        iparts.push(fmtBought(inp.resource, refineInputAcquired(mop, inp), inp.amount, via));
                    }
                }
                lines.push('    buying     ' + (iparts.length ? iparts.join(', ') : '(no inputs)'));
            } else if (mPhase === 'STAGING') {
                lines.push('    staging    inputs acquired, preparing factory order');
            } else if (mPhase === 'DELIVERING') {
                lines.push('    delivering ' + fmtProduced(mop.output, producedSince(mop), refineExpectedOutput(mop)));
            } else if (mPhase === 'SELLING') {
                lines.push('    selling    ' + fmtProduced(mop.output, producedSince(mop), refineExpectedOutput(mop)));
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
            var lPhase = getFactoryDisplayPhase(lop, 'localRefine');
            lines.push('factory ' + lop.output + ' [local] in ' + lop.room + ' [' + lPhase + ']');
            if (lPhase === 'STAGING') {
                lines.push('    staging    inputs on hand, preparing factory order');
            } else if (lPhase === 'DELIVERING') {
                lines.push('    delivering ' + fmtProduced(lop.output, producedSince(lop), recipeExpectedOutput(lop.output, lop.requiredAmount, lop.input)));
            } else if (lPhase === 'SELLING') {
                lines.push('    selling    ' + fmtProduced(lop.output, producedSince(lop), recipeExpectedOutput(lop.output, lop.requiredAmount, lop.input)));
            } else {
                lines.push('    producing  ' + fmtProduced(lop.output, producedSince(lop), recipeExpectedOutput(lop.output, lop.requiredAmount, lop.input)));
            }
        }
    }

    // ---- standalone factoryManager orders ----
    if (Memory.factoryOrders && Array.isArray(Memory.factoryOrders)) {
        var linkedFactoryOrders = collectRefineFactoryOrderIds();
        for (var fi = 0; fi < Memory.factoryOrders.length; fi++) {
            var fop = Memory.factoryOrders[fi];
            if (!fop || !fop.product) continue;
            if (fop.status === 'done' || fop.status === 'cancelled') continue;
            if (fop.id && linkedFactoryOrders[fop.id]) continue;
            any = true;
            var fPhase = getFactoryDisplayPhase(fop, 'factoryOrder');
            lines.push('factory ' + fop.product + ' [order] in ' + fop.room + ' [' + fPhase + ']');
            var requested = typeof fop.requested === 'number' ? fop.requested : null;
            if (fPhase === 'STAGING') {
                lines.push('    staging    loading inputs | produced ' + (fop.progressOut || 0) + (requested !== null ? '/' + requested : ''));
            } else if (fPhase === 'PROCESSING') {
                lines.push('    producing  ' + fmtProduced(fop.product, fop.progressOut || 0, requested));
            } else if (fPhase === 'DELIVERING') {
                lines.push('    delivering ' + fmtProduced(fop.product, fop.progressOut || 0, requested));
            } else {
                lines.push('    status     phase=' + (fop.phase || 'unknown') + ', status=' + (fop.status || 'unknown'));
            }
        }
    }

    if (!any) lines.push('  No active jobs.');
    return lines.join('\n');
}

// ===== Room Status =====

function getRoomStatusDetail(roomName, activeReverse, activeForward, activeFactory) {
    var state = getRoomState.get(roomName);
    var result = { name: roomName, factory: null, lab: null };
    var factory = getRoomFactory(roomName);
    var factoryLevel = getLiveFactoryEffectLevel(roomName);
    if (factory && factoryLevel === null) factoryLevel = 0;
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
            for (var afi = 0; afi < activeFactory[prod].length; afi++) {
                var af = activeFactory[prod][afi];
                if (af.room === roomName) jobs.push({ product: prod, phase: af.displayPhase || af.phase, isDecompress: DECOMPRESSION_PRODUCTS.indexOf(prod) >= 0 });
            }
        }
        result.factory = { level: factoryLevel, storageEnergy: storageEnergy, hasTerminal: hasTerminal, hasSources: hasSources, eligible: blockers.length === 0, blockers: blockers, activeJobs: jobs };
    }
    var labCount = getRoomLabCount(roomName);
    if (labCount > 0) {
        var lBlockers = [];
        if (!(state && state.terminal)) lBlockers.push('no terminal');
        if (labCount < MIN_LABS)        lBlockers.push('too few labs (' + labCount + ' < ' + MIN_LABS + ')');
        if (getRoomActiveLabCount(roomName) >= MAX_LAB_OPS_PER_ROOM) lBlockers.push('lab queue full (' + MAX_LAB_OPS_PER_ROOM + '-job limit)');
        var reverseJobs = [], forwardJobs = [];
        for (var comp in activeReverse) {
            for (var ari = 0; ari < activeReverse[comp].length; ari++) {
                var ar = activeReverse[comp][ari];
                if (ar.room === roomName) reverseJobs.push({ compound: comp, state: ar.displayPhase || ar.state, blocksProduction: ar.blocksProduction });
            }
        }
        for (var fcomp in activeForward) {
            for (var awi = 0; awi < activeForward[fcomp].length; awi++) {
                var aw = activeForward[fcomp][awi];
                if (aw.room === roomName) forwardJobs.push({ compound: fcomp, state: aw.displayPhase || aw.state, blocksProduction: aw.blocksProduction });
            }
        }
        result.lab = { labCount: labCount, hasTerminal: !!(state && state.terminal), hasSupplier: roomHasSupplier(roomName), eligible: lBlockers.length === 0, blockers: lBlockers, activeReverse: reverseJobs, activeForward: forwardJobs };
    }
    return result;
}

function getRoomsReport(filter) {
    var activeReverse = getActiveReverseReactions();
    var activeForward = getActiveForwardReactions();
    var activeFactory = getActiveFactoryJobs();
    var roomNames = getRoomState.ownedNames().slice().sort();
    var lines = ['[autoTrader] Room Status (tick ' + Game.time + '):', ''];
    var shown = 0;
    for (var ri = 0; ri < roomNames.length; ri++) {
        var roomName = roomNames[ri];
        var state = getRoomState.get(roomName);
        if (!state || !state.isOwned) continue;
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
                for (var rvi = 0; rvi < l.activeReverse.length; rvi++) lines.push('      -> reverse: ' + l.activeReverse[rvi].compound + ' [' + l.activeReverse[rvi].state + ']' + (l.activeReverse[rvi].blocksProduction ? '' : ' (non-blocking)'));
                for (var fwi = 0; fwi < l.activeForward.length; fwi++) lines.push('      -> forward: ' + l.activeForward[fwi].compound + ' [' + l.activeForward[fwi].state + ']' + (l.activeForward[fwi].blocksProduction ? '' : ' (non-blocking)'));
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
        for (var ri = 0; ri < activeReverse[compound].length; ri++) {
            var rInfo = activeReverse[compound][ri];
            if (rInfo.state !== 'BUYING') continue;
            var ra = analyzeReverseReaction(compound, reactionPairs, 'ACTUAL_SELL', 'ACTUAL_BUY');
            if (!ra || (ra.marginPct !== null && ra.marginPct >= MARGIN_THRESHOLD)) continue;
            cancelled.push({ type: 'reverse', key: compound, id: rInfo.id, room: rInfo.room, marginPct: ra.marginPct });
            if (!dryRun) global.labReverse('stop', rInfo.room, compound);
        }
    }
    for (var fcompound in activeForward) {
        for (var fi = 0; fi < activeForward[fcompound].length; fi++) {
            var fInfo = activeForward[fcompound][fi];
            if (fInfo.state !== 'BUYING') continue;
            var fa = analyzeForwardReaction(fcompound, reactionPairs, 'ACTUAL_BUY', 'ACTUAL_SELL');
            if (!fa || (fa.marginPct !== null && fa.marginPct >= MARGIN_THRESHOLD)) continue;
            cancelled.push({ type: 'forward', key: fcompound, id: fInfo.id, room: fInfo.room, marginPct: fa.marginPct });
            if (!dryRun) global.labForward('stop', fInfo.room, fcompound);
        }
    }
    for (var product in activeFactory) {
        for (var pi = 0; pi < activeFactory[product].length; pi++) {
            var pInfo = activeFactory[product][pi];
            if (pInfo.phase !== 'buying') continue;
            var pa = analyzeFactoryProduct(product, 'ACTUAL_SELL', 'ACTUAL_BUY');
            if (!pa || (pa.marginPct !== null && pa.marginPct >= MARGIN_THRESHOLD)) continue;
            cancelled.push({ type: 'factory', key: product, id: pInfo.id, room: pInfo.room, marginPct: pa.marginPct, isDecompress: pa.isDecompress });
            if (!dryRun) global.abortMarketRefine(pInfo.id || pInfo.room, pInfo.id ? undefined : product);
        }
    }
    if (!dryRun && cancelled.length > 0) {
        var parts = cancelled.map(function(c) {
            var m = (c.marginPct === null) ? 'N/A' : c.marginPct.toFixed(0) + '%';
            return c.type + ':' + c.key + '(' + m + ')';
        });
        console.log('[autoTrader] Cancelled unprofitable (< ' + MARGIN_THRESHOLD + '%): ' + parts.join(', '));
        requestSave();
    }
    return cancelled;
}

// ===== Main Analysis & Execution =====

function runAnalysis() {
    var reactionPairs = buildReactionMap();
    var allCompounds = Object.keys(reactionPairs);
    var activeReverse = getActiveReverseReactions();
    var activeForward = getActiveForwardReactions();
    var buyingReverse = getBuyingReverseReactions();
    var buyingForward = getBuyingForwardReactions();
    var activeFactory = getActiveFactoryJobs();
    var currentSellAmounts = buildCurrentSellAmounts();
    var opportunities = { reverse: [], forward: [], factory: [] };
    var skippedReverse = [], skippedForward = [], skippedFactory = [], skippedSellLimit = [], skippedBudgetInfeasible = [];
    var skippedChoices = [];

    function rememberSkipped(kind, direction, name, marginPct, reason) {
        skippedChoices.push({ kind: kind, direction: direction, name: name, marginPct: marginPct, reason: reason });
    }

    function reserveSellExposure(resource, amount) {
        if ((currentSellAmounts[resource] || 0) + amount > MAX_SELL_AMOUNT) return false;
        currentSellAmounts[resource] = (currentSellAmounts[resource] || 0) + amount;
        return true;
    }

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
            var buyingRev = firstActive(buyingReverse, compound);
            var activeFwd = firstBlockingActive(activeForward, compound);
            if (buyingRev) { skippedReverse.push({ compound: compound, marginPct: analysis.marginPct, room: buyingRev.room, state: buyingRev.state }); rememberSkipped('lab', 'reverse', compound, analysis.marginPct, 'already buying reverse in ' + buyingRev.room); continue; }
            if (activeFwd) { rememberSkipped('lab', 'reverse', compound, analysis.marginPct, 'opposite forward active in ' + activeFwd.room); continue; }
            if (circularCompounds[compound]) { rememberSkipped('lab', 'reverse', compound, analysis.marginPct, 'circular spread: forward also profitable at ' + circularCompounds[compound].fwdMargin.toFixed(0) + '%'); continue; }
            if (analysis.marginPct === null || analysis.marginPct < MARGIN_THRESHOLD) { rememberSkipped('lab', 'reverse', compound, analysis.marginPct, 'below margin threshold'); continue; }
            if ((currentSellAmounts[analysis.reagentA] || 0) + LAB_PROJECTED_OUTPUT > MAX_SELL_AMOUNT || (currentSellAmounts[analysis.reagentB] || 0) + LAB_PROJECTED_OUTPUT > MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: compound, marginPct: analysis.marginPct, reason: 'projected reagent output exceeds sell limit' }); rememberSkipped('lab', 'reverse', compound, analysis.marginPct, 'projected reagent output exceeds sell limit'); continue; }
            reserveSellExposure(analysis.reagentA, LAB_PROJECTED_OUTPUT);
            reserveSellExposure(analysis.reagentB, LAB_PROJECTED_OUTPUT);
            opportunities.reverse.push(analysis);
        }
    }

    if (ENABLE_LAB_JOBS) {
        for (var fi = 0; fi < allCompounds.length; fi++) {
            var fCompound = allCompounds[fi];
            var fAnalysis = analyzeForwardReaction(fCompound, reactionPairs, 'ACTUAL_BUY', 'ACTUAL_SELL');
            if (!fAnalysis) continue;
            var buyingFwd = firstActive(buyingForward, fCompound);
            var activeRev = firstBlockingActive(activeReverse, fCompound);
            if (buyingFwd) { skippedForward.push({ compound: fCompound, marginPct: fAnalysis.marginPct, room: buyingFwd.room, state: buyingFwd.state }); rememberSkipped('lab', 'forward', fCompound, fAnalysis.marginPct, 'already buying forward in ' + buyingFwd.room); continue; }
            if (activeRev) { rememberSkipped('lab', 'forward', fCompound, fAnalysis.marginPct, 'opposite reverse active in ' + activeRev.room); continue; }
            if (circularCompounds[fCompound]) { rememberSkipped('lab', 'forward', fCompound, fAnalysis.marginPct, 'circular spread: reverse also profitable at ' + circularCompounds[fCompound].revMargin.toFixed(0) + '%'); continue; }
            if (fAnalysis.marginPct === null || fAnalysis.marginPct < MARGIN_THRESHOLD) { rememberSkipped('lab', 'forward', fCompound, fAnalysis.marginPct, 'below margin threshold'); continue; }
            if (!reserveSellExposure(fCompound, LAB_PROJECTED_OUTPUT)) { skippedSellLimit.push({ compound: fCompound, marginPct: fAnalysis.marginPct, reason: fCompound + ' projected above sell limit' }); rememberSkipped('lab', 'forward', fCompound, fAnalysis.marginPct, fCompound + ' projected above sell limit'); continue; }
            opportunities.forward.push(fAnalysis);
        }
    }

    function evalFactoryProduct(product) {
        if (BANNED_FACTORY_PRODUCTS.indexOf(product) >= 0) return;
        var fa = analyzeFactoryProduct(product, 'ACTUAL_SELL', 'ACTUAL_BUY');
        if (!fa) return;
        var activeProduct = firstActive(activeFactory, product);
        if (activeProduct) {
            skippedFactory.push({ product: product, marginPct: fa.marginPct, room: activeProduct.room, phase: activeProduct.phase, requiredLevel: fa.requiredLevel, isDecompress: fa.isDecompress });
            rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, 'already active in ' + activeProduct.room + ' (' + activeProduct.phase + ')');
            return;
        }
        if (isFactoryProductOnCooldown(product)) {
            skippedFactory.push({ product: product, marginPct: fa.marginPct, room: '?', phase: 'cooldown', requiredLevel: fa.requiredLevel, isDecompress: fa.isDecompress });
            rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, 'cooldown');
            return;
        }
        if (fa.marginPct === null || fa.marginPct < MARGIN_THRESHOLD) { rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, 'below margin threshold'); return; }
        // Budget-infeasibility check: vwAsk of inputs must fit the target-margin
        // budget. computeInputPricesForMargin returns null in that case, which
        // would lead to a marketRefine refusal. Skip here with a tagged log line.
        // localRefine products are exempt: they consume on-hand stock (no market
        // inputs), and their energy-only recipes make the gate return null always.
        if (!fa.isLocalRefine && computeInputPricesForMargin(product) === null) { skippedBudgetInfeasible.push({ product: product, marginPct: fa.marginPct, isDecompress: fa.isDecompress }); rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, 'budget infeasible'); return; }
        var eligibleFactoryRooms = getEligibleFactoryRooms(product);
        if (eligibleFactoryRooms.length === 0) { rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, 'no eligible factory room'); return; }
        if (fa.isLocalRefine) {
            var localInputAmount = eligibleFactoryRooms[0].storageEnergy - LOCAL_REFINE_ENERGY_RESERVE;
            fa.expectedOutput = recipeExpectedOutput(product, localInputAmount, RESOURCE_ENERGY) || 0;
        }
        if ((currentSellAmounts[product] || 0) + fa.expectedOutput > MAX_SELL_AMOUNT) { skippedSellLimit.push({ compound: product, marginPct: fa.marginPct, reason: product + ' projected above sell limit' }); rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, product + ' projected above sell limit'); return; }
        var opposite = getOppositeFactoryProduct(product);
        if (opposite) {
            var activeOpposite = firstActive(activeFactory, opposite);
            if (activeOpposite) {
                rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, 'opposite direction ' + opposite + ' active in ' + activeOpposite.room);
                return;
            }
            for (var oi = 0; oi < opportunities.factory.length; oi++) {
                if (opportunities.factory[oi].product !== opposite) continue;
                if ((fa.marginPct || 0) > (opportunities.factory[oi].marginPct || 0)) {
                    currentSellAmounts[opposite] = Math.max(0, (currentSellAmounts[opposite] || 0) - opportunities.factory[oi].expectedOutput);
                    rememberSkipped('factory', opportunities.factory[oi].isDecompress ? 'decompress' : 'compress', opposite, opportunities.factory[oi].marginPct, 'lower margin than opposite direction ' + product);
                    opportunities.factory.splice(oi, 1);
                } else {
                    rememberSkipped('factory', fa.isDecompress ? 'decompress' : 'compress', product, fa.marginPct, 'lower margin than opposite direction ' + opposite);
                    return;
                }
                break;
            }
        }
        reserveSellExposure(product, fa.expectedOutput);
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
    } else {
        var skippedFwd = skippedChoices.filter(function(x) { return x.kind === 'lab' && x.direction === 'forward' && typeof x.marginPct === 'number' && x.marginPct >= MARGIN_THRESHOLD; });
        if (skippedFwd.length > 0) {
            skippedFwd.sort(function(a, b) { return b.marginPct - a.marginPct; });
            var sfList = skippedFwd.slice(0, 3).map(function(x) { return x.name + '(' + x.marginPct.toFixed(0) + '%) - ' + x.reason; });
            console.log('[autoTrader] No NEW forward; top skipped: ' + sfList.join('; ') + (skippedFwd.length > 3 ? ' +' + (skippedFwd.length - 3) + ' more' : ''));
        }
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
    skippedChoices.sort(function(a, b) { return (b.marginPct || -9999) - (a.marginPct || -9999); });
    if (skippedChoices.length > 0) {
        var scList = skippedChoices.slice(0, 5).map(function(x) {
            var m = typeof x.marginPct === 'number' ? x.marginPct.toFixed(0) + '%' : 'n/a';
            return x.kind + ':' + x.direction + ':' + x.name + '(' + m + ') - ' + x.reason;
        });
        console.log('[autoTrader] Top skipped/rejected: ' + scList.join('; '));
    }

    return { reverse: opportunities.reverse, forward: opportunities.forward, factory: opportunities.factory, skippedReverse: skippedReverse, skippedForward: skippedForward, skippedFactory: skippedFactory, skippedSellLimit: skippedSellLimit, skippedBudgetInfeasible: skippedBudgetInfeasible, skippedChoices: skippedChoices };
}

function executeJobs(opportunities, dryRun) {
    var labRooms = getEligibleLabReactionRooms();
    var jobsStarted = [], reverseStarted = 0, forwardStarted = 0, factoryStarted = 0;
    var labStartedThisRun = {};
    var refusalBuffer = Object.create(null);
    var refusedChoices = [];

    function bufferRefusal(op, compound, room, reason, marginPct) {
        // Strip the trailing "in <room>" suffix from the error string to
        // form a reusable reason template. Falls back to the full reason
        // if the room isn't embedded (unusual, but safer than dropping it).
        var reasonTemplate = '' + reason;
        var suffix = ' in ' + room;
        if (reasonTemplate.length > suffix.length &&
            reasonTemplate.slice(-suffix.length) === suffix) {
            reasonTemplate = reasonTemplate.slice(0, -suffix.length);
        }
        reasonTemplate = reasonTemplate.slice(0, 160);
        var key = op + '|' + compound + '|' + reasonTemplate;
        if (!refusalBuffer[key]) {
            refusalBuffer[key] = { op: op, compound: compound, reason: reasonTemplate, rooms: [] };
        }
        refusalBuffer[key].rooms.push(room);
        refusedChoices.push({ op: op, compound: compound, marginPct: marginPct, room: room, reason: reasonTemplate });
    }

    function flushRefusals() {
        var keys = Object.keys(refusalBuffer);
        for (var k = 0; k < keys.length; k++) {
            var e = refusalBuffer[keys[k]];
            if (e.rooms.length === 1) {
                console.log('[autoTrader] ' + e.op + ' REFUSED ' + e.compound + ' in ' + e.rooms[0] + ': ' + e.reason + ' in ' + e.rooms[0]);
            } else {
                console.log('[autoTrader] ' + e.op + ' REFUSED ' + e.compound + ' x' + e.rooms.length + ': ' + e.reason);
                console.log('[autoTrader]   ' + e.rooms.join(', '));
            }
        }
        refusalBuffer = Object.create(null);
    }

    function flushRefusedChoices() {
        if (refusedChoices.length === 0) return;
        var grouped = Object.create(null);
        var listAll = [];
        for (var ri = 0; ri < refusedChoices.length; ri++) {
            var r = refusedChoices[ri];
            var key = r.op + '|' + r.compound + '|' + r.reason;
            if (!grouped[key]) {
                grouped[key] = { op: r.op, compound: r.compound, marginPct: r.marginPct, reason: r.reason, count: 0 };
                listAll.push(grouped[key]);
            }
            grouped[key].count++;
        }
        listAll.sort(function(a, b) { return (b.marginPct || -9999) - (a.marginPct || -9999); });
        var list = listAll.slice(0, 5).map(function(x) {
            var m = x.marginPct === null || typeof x.marginPct !== 'number' ? 'n/a' : x.marginPct.toFixed(0) + '%';
            return x.op + ':' + x.compound + '(' + m + ')' + (x.count > 1 ? ' x' + x.count : '') + ' - ' + x.reason;
        });
        console.log('[autoTrader] Top execution refusals: ' + list.join('; '));
    }

    function labStartAccepted(result, tag) {
        return typeof result === 'string' && result.indexOf('[' + tag + '] Queued:') === 0;
    }

    function findNewestLabOpId(direction, roomName, compound) {
        var root = direction === 'reverse' ? Memory.marketLabReverse : Memory.marketLabForward;
        var queue = root && root.rooms && root.rooms[roomName];
        if (!queue) return null;
        for (var i = queue.length - 1; i >= 0; i--) {
            var op = queue[i];
            if (op && op.targetCompound === compound && op.tickStarted === Game.time) return op.id || null;
        }
        return null;
    }

    if (ENABLE_LAB_JOBS) {
        var labOpps = [];
        for (var i = 0; i < opportunities.reverse.length; i++) labOpps.push(opportunities.reverse[i]);
        for (var fi = 0; fi < opportunities.forward.length; fi++) labOpps.push(opportunities.forward[fi]);
        labOpps.sort(function(a, b) { return (b.marginPct || 0) - (a.marginPct || 0); });

        for (var li = 0; li < labOpps.length; li++) {
            if (labRooms.length === 0) break;
            var opp = labOpps[li];
            if (opp.type === 'reverse' && reverseStarted >= MAX_REVERSE_REACTIONS) continue;
            if (opp.type === 'forward' && forwardStarted >= MAX_FORWARD_REACTIONS) continue;

            var labKey = opp.type + ':' + opp.compound;
            if (labStartedThisRun[labKey]) continue;

            var targetRoom = labRooms[0];
            if (!dryRun) {
                if (opp.type === 'reverse') {
                    var maxPrice = opp.compoundPrice > 0 ? opp.compoundPrice : undefined;
                    var revResult = global.labReverse(targetRoom.name, opp.compound, maxPrice);
                    if (!labStartAccepted(revResult, 'labReverse')) {
                        bufferRefusal('labReverse', opp.compound, targetRoom.name, revResult, opp.marginPct);
                        labRooms.splice(0, 1);
                        li--;
                        continue;
                    }
                    console.log('[autoTrader] Started reverse ' + opp.compound + ' -> ' + opp.reagentA + '+' + opp.reagentB + ' (' + opp.marginPct.toFixed(0) + '%) in ' + targetRoom.name + (maxPrice ? ' (max ' + maxPrice.toFixed(3) + ')' : ' (no price ceiling)'));
                    jobsStarted.push({ type: 'reverse', compound: opp.compound, room: targetRoom.name, margin: opp.marginPct, maxPrice: opp.compoundPrice, opId: findNewestLabOpId('reverse', targetRoom.name, opp.compound), tick: Game.time });
                } else {
                    var reagentCeilings = {};
                    if (opp.reagentAPrice > 0) reagentCeilings[opp.reagentA] = opp.reagentAPrice;
                    if (opp.reagentBPrice > 0) reagentCeilings[opp.reagentB] = opp.reagentBPrice;
                    var fwdResult = global.labForward(targetRoom.name, opp.compound, reagentCeilings);
                    if (!labStartAccepted(fwdResult, 'labForward')) {
                        bufferRefusal('labForward', opp.compound, targetRoom.name, fwdResult, opp.marginPct);
                        labRooms.splice(0, 1);
                        li--;
                        continue;
                    }
                    console.log('[autoTrader] Started forward ' + opp.reagentA + '+' + opp.reagentB + ' -> ' + opp.compound + ' (' + opp.marginPct.toFixed(0) + '%) in ' + targetRoom.name);
                    jobsStarted.push({ type: 'forward', compound: opp.compound, room: targetRoom.name, margin: opp.marginPct, reagentAPrice: opp.reagentAPrice, reagentBPrice: opp.reagentBPrice, opId: findNewestLabOpId('forward', targetRoom.name, opp.compound), tick: Game.time });
                }
            }
            labStartedThisRun[labKey] = true;
            if (opp.type === 'reverse') reverseStarted++; else forwardStarted++;
            labRooms.splice(0, 1);
        }
    }
    flushRefusals();

    if (ENABLE_FACTORY_JOBS || ENABLE_FACTORY_DECOMPRESSION) {
        for (var j = 0; j < opportunities.factory.length && factoryStarted < MAX_FACTORY_JOBS; j++) {
            var factoryOpp = opportunities.factory[j];
            if (factoryOpp.isDecompress  && !ENABLE_FACTORY_DECOMPRESSION) continue;
            if (!factoryOpp.isDecompress && !factoryOpp.isLocalRefine && !ENABLE_FACTORY_JOBS) continue;
            var factoryRooms = getEligibleFactoryRooms(factoryOpp.product);
            if (factoryRooms.length === 0) {
                var roomNames = getRoomState.ownedNames();
                var busyRooms = [];
                for (var bri = 0; bri < roomNames.length; bri++) { var brn = roomNames[bri]; if (canRoomProduceProduct(brn, factoryOpp.product) && getRoomActiveFactoryCount(brn) >= MAX_FACTORY_OPS_PER_ROOM) busyRooms.push(brn); }
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
                    if (!localRefineOpId) {
                        bufferRefusal('localRefine', factoryOpp.product, factoryRoom.name, localResult, factoryOpp.marginPct);
                        continue;
                    }
                    console.log('[autoTrader] Started ' + factoryOpp.product + ' via localRefine (' + factoryOpp.marginPct.toFixed(0) + '%) in ' + factoryRoom.name + ' (' + refineAmount + ' energy)' + (localRefineOpId ? ' [' + localRefineOpId + ']' : ''));
                    jobsStarted.push({ type: 'factory', product: factoryOpp.product, room: factoryRoom.name, margin: factoryOpp.marginPct, level: factoryOpp.requiredLevel, method: 'localRefine', localRefineOpId: localRefineOpId, amount: refineAmount, tick: Game.time });
                } else {
                    var execInputPrices = computeInputPricesForMargin(factoryOpp.product);
                    if (!execInputPrices) {
                        bufferRefusal('marketRefine', factoryOpp.product, factoryRoom.name, 'margin no longer achievable at current posted-bid prices', factoryOpp.marginPct);
                        continue;
                    }
                    var mrResult = global.marketRefine(factoryRoom.name, factoryOpp.product, execInputPrices);
                    var mrMatch = typeof mrResult === 'string' ? mrResult.match(/Started (mref_[^\s|]+)/) : null;
                    var mrRefused = !mrMatch;
                    if (mrRefused) {
                        bufferRefusal('marketRefine', factoryOpp.product, factoryRoom.name, mrResult, factoryOpp.marginPct);
                        continue;
                    }
                    var levelStr = factoryOpp.requiredLevel > 0 ? ' [L' + factoryOpp.requiredLevel + ']' : '';
                    var decompStr = factoryOpp.isDecompress ? ' [decomp]' : '';
                    var priceEntries = [];
                    for (var res in execInputPrices) priceEntries.push(res + ':' + (execInputPrices[res] > 0 ? execInputPrices[res].toFixed(3) : 'N/A'));
                    console.log('[autoTrader] Started ' + factoryOpp.product + levelStr + decompStr + ' (' + factoryOpp.marginPct.toFixed(0) + '%) in ' + factoryRoom.name + ' (max ' + priceEntries.join(', ') + ')');
                    jobsStarted.push({ type: 'factory', product: factoryOpp.product, room: factoryRoom.name, margin: factoryOpp.marginPct, level: factoryOpp.requiredLevel, isDecompress: factoryOpp.isDecompress, marketRefineOpId: mrMatch[1], maxInputPrices: execInputPrices, tick: Game.time });
                }
            }
            factoryStarted++;
        }
    }
    flushRefusals();
    flushRefusedChoices();

    jobsStarted.refusals = refusedChoices.slice(-10);
    return jobsStarted;
}

// ===== Job Display Helper =====
// Shared by getStatus() (shows last 10) and autoTrader('history') (shows all).
// jobList    = the slice of jobs to render
// allJobs    = the full mem.jobsStarted array (for "is this the latest?" check)
// startIndex = position of jobList[0] within allJobs

function findActiveJobEntry(active, key, id, room) {
    var entries = active[key] || [];
    for (var i = 0; i < entries.length; i++) {
        if (id && entries[i].id === id) return entries[i];
        if (!id && entries[i].room === room) return entries[i];
    }
    return null;
}

function findOutcome(outcomes, id, room, output, started) {
    if (!outcomes) return null;
    if (id && !Array.isArray(outcomes) && outcomes[id]) return outcomes[id];
    var list = Array.isArray(outcomes) ? outcomes : Object.keys(outcomes).map(function(key) { return outcomes[key]; }).sort(function(a, b) { return (a.tick || 0) - (b.tick || 0); });
    for (var i = list.length - 1; i >= 0; i--) {
        var outcome = list[i];
        if (!outcome) continue;
        if (id && outcome.id === id) return outcome;
        if (!id && outcome.room === room && outcome.output === output && outcome.started >= started) return outcome;
    }
    return null;
}

function outcomeStage(outcome) {
    if (!outcome) return ' [unknown]';
    if (outcome.status === 'failed') return ' [FAILED: ' + (outcome.reason || 'no reason recorded') + ']';
    if (outcome.status === 'cancelled') return ' [CANCELLED: ' + (outcome.reason || 'no reason recorded') + ']';
    return ' [done]';
}

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
        if (job.status === 'failed') {
            stage = ' [FAILED: ' + (job.reason || 'no reason recorded') + ']';
        } else if (job.status === 'cancelled') {
            stage = ' [CANCELLED: ' + (job.reason || 'no reason recorded') + ']';
        } else if (job.status === 'completed' || job.status === 'done') {
            stage = ' [done]';
        } else if (job.type === 'factory' && job.refused) {
            stage = ' [REFUSED: ' + job.refused + ']';
        } else if (job.type === 'factory' && job.method !== 'localRefine') {
            // Marketplace-refine factory job: check active ops first, then fall
            // back to marketRefine's outcomes ledger (Memory.marketRefine.outcomes)
            // to distinguish a real completion from a failed/aborted op that was
            // silently dropped from the active list.
            var activeMarketRefine = findActiveJobEntry(activeFactory, job.product, job.marketRefineOpId, job.room);
            if (activeMarketRefine) {
                stage = ' [' + (activeMarketRefine.displayPhase || activeMarketRefine.phase) + ']';
            } else if (!job.marketRefineOpId && !isLatestForKey) {
                stage = ' [superseded]';
            } else {
                stage = ' [unknown]';
                var outs = (Memory.marketRefine && Memory.marketRefine.outcomes) || [];
                var oc = findOutcome(outs, job.marketRefineOpId, job.room, job.product, job.tick);
                if (oc) stage = outcomeStage(oc);
            }
        } else if (!job.opId && !job.localRefineOpId && !isLatestForKey) {
            stage = ' [done]';
        } else if (job.type === 'reverse') {
            var activeReverseJob = findActiveJobEntry(activeReverse, job.compound, job.opId, job.room);
            stage = activeReverseJob ? ' [' + (activeReverseJob.displayPhase || activeReverseJob.state) + ']' : ' [done]';
        } else if (job.type === 'forward') {
            var activeForwardJob = findActiveJobEntry(activeForward, job.compound, job.opId, job.room);
            stage = activeForwardJob ? ' [' + (activeForwardJob.displayPhase || activeForwardJob.state) + ']' : ' [done]';
        } else if (job.type === 'factory' && job.method === 'localRefine') {
            var lrOps = (Memory.localRefine && Array.isArray(Memory.localRefine.ops)) ? Memory.localRefine.ops : [];
            var localOutcome = findOutcome(Memory.localRefine && Memory.localRefine.outcomes, job.localRefineOpId, job.room, job.product, job.tick);
            if (job.localRefineOpId) {
                var found = false;
                for (var lri = 0; lri < lrOps.length; lri++) { if (lrOps[lri] && lrOps[lri].id === job.localRefineOpId) { stage = ' [' + getFactoryDisplayPhase(lrOps[lri], 'localRefine') + ']'; found = true; break; } }
                if (!found && localOutcome) stage = outcomeStage(localOutcome);
                else if (!found) stage = ' [unknown]';
            } else {
                var matches = lrOps.filter(function(o) { return o && o.room === job.room && o.output === job.product; });
                if (matches.length === 1 && matches[0].started <= job.tick) stage = ' [' + getFactoryDisplayPhase(matches[0], 'localRefine') + ']';
                else if (localOutcome) stage = outcomeStage(localOutcome);
                else stage = ' [unknown]';
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
    lines.push('  Max sell amount per resource: ' + MAX_SELL_AMOUNT);
    lines.push('  Pricing: gross market prices; transaction energy and posted-order fees omitted');
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

    if (mem.lastRefusals && mem.lastRefusals.length > 0) {
        lines.push('');
        lines.push('  Last execution refusals:');
        for (var ri = 0; ri < Math.min(3, mem.lastRefusals.length); ri++) {
            var refusal = mem.lastRefusals[ri];
            lines.push('    ' + refusal.op + ':' + refusal.compound + ' in ' + refusal.room + ' - ' + refusal.reason);
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
    if (command === 'enable')  { mem.enabled = true; requestSave(); return '[autoTrader] Enabled automatic runs.'; }
    if (command === 'disable') { mem.enabled = false; requestSave(); return '[autoTrader] Disabled automatic runs.'; }
    if (command === 'reset')   { Memory.autoTrader = null; ensureMemory(); requestSave(); return '[autoTrader] Memory reset.'; }

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
        if (removed > 0) requestSave();
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
        requestSave();

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
                lines.push('  ' + r.compound + (r.compoundPrice > 0 ? ' @' + r.compoundPrice.toFixed(2) : ' (no external price)') + ' -> ' + r.reagentA + ' + ' + r.reagentB + ' | margin: ' + r.marginPct.toFixed(1) + '%');
            }
            if (results.reverse.length > 10) lines.push('  ... and ' + (results.reverse.length - 10) + ' more');
        } else { lines.push('NEW Reverse Reactions: None' + (!ENABLE_LAB_JOBS ? ' (disabled)' : '')); }
        lines.push('');

        if (results.forward.length > 0) {
            lines.push('NEW Forward Reactions:');
            for (var fwi = 0; fwi < Math.min(10, results.forward.length); fwi++) {
                var fw = results.forward[fwi];
                var rps = ' (buy ' + fw.reagentA + '@' + (fw.reagentAPrice > 0 ? fw.reagentAPrice.toFixed(2) : 'N/A') + ' + ' + fw.reagentB + '@' + (fw.reagentBPrice > 0 ? fw.reagentBPrice.toFixed(2) : 'N/A') + ')';
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
        if (results.skippedChoices && results.skippedChoices.length > 0) {
            lines.push(''); lines.push('TOP SKIPPED/REJECTED:');
            for (var tch = 0; tch < Math.min(5, results.skippedChoices.length); tch++) {
                var ch = results.skippedChoices[tch];
                var cm = typeof ch.marginPct === 'number' ? ch.marginPct.toFixed(1) + '%' : 'N/A';
                lines.push('  ' + ch.kind + ' ' + ch.direction + ' ' + ch.name + ' @ ' + cm + ' - ' + ch.reason);
            }
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
        if (jobs.refusals && jobs.refusals.length > 0) mem.lastRefusals = jobs.refusals;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) mem.jobsStarted.push(jobs[k]);
            if (mem.jobsStarted.length > JOBS_HISTORY_CAP) mem.jobsStarted = mem.jobsStarted.slice(-JOBS_HISTORY_CAP);
        }
        requestSave();
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
            var progress = getOrderProgress(o);
            totalRemaining += progress.remaining;
            totalOriginal  += progress.original;
            lines.push('  ' + o.roomName + ': ' + progress.filled + '/' + progress.original + ' filled (' + fmtPct(orderFillPct(o)) + ') @ ' + o.price.toFixed(3));
        }
        var totalFilled = Math.max(0, totalOriginal - totalRemaining);
        var aggPct = totalOriginal > 0 ? (totalFilled / totalOriginal) * 100 : 0;
        lines.push('  Total: ' + totalFilled + '/' + totalOriginal + ' filled (' + aggPct.toFixed(1) + '%)');
        return lines.join('\n');
    }

    var expanded = parsed.view === 'expanded';
    var byResource = {};
    for (var j = 0; j < scopedOrders.length; j++) {
        var order = scopedOrders[j];
        var orderProgress = getOrderProgress(order);
        var res = order.resourceType;
        if (!byResource[res]) byResource[res] = { orders: [], remaining: 0, original: 0 };
        byResource[res].orders.push(order);
        byResource[res].remaining += orderProgress.remaining;
        byResource[res].original  += orderProgress.original;
    }
    var resources = Object.keys(byResource).sort(function(a, b) { return byResource[b].remaining - byResource[a].remaining; });
    var header = '[' + label + '] ' + scopedOrders.length + ' active ' + label + ' order(s) across ' + resources.length + ' resource(s)';
    if (parsed.roomName) header += ' in ' + parsed.roomName;
    var lines2 = [header + ':', ''];
    for (var k = 0; k < resources.length; k++) {
        var resource = resources[k]; var data = byResource[resource];
        var dataFilled = Math.max(0, data.original - data.remaining);
        var aggPct2 = data.original > 0 ? (dataFilled / data.original) * 100 : 0;
        if (expanded) {
            lines2.push(resource + ': ' + dataFilled + '/' + data.original + ' filled (' + aggPct2.toFixed(1) + '%)');
            for (var m = 0; m < data.orders.length; m++) {
                var oo = data.orders[m];
                var progress2 = getOrderProgress(oo);
                lines2.push('  ' + oo.roomName + ': ' + progress2.filled + '/' + progress2.original + ' filled (' + fmtPct(orderFillPct(oo)) + ') @ ' + oo.price.toFixed(3));
            }
            lines2.push('');
        } else {
            var avg = 0; for (var n = 0; n < data.orders.length; n++) avg += data.orders[n].price; avg = avg / data.orders.length;
            if (label === 'buying') {
                var roomAmounts = {};
                for (var n2 = 0; n2 < data.orders.length; n2++) {
                    var rn = data.orders[n2].roomName;
                    var roomProgress = getOrderProgress(data.orders[n2]);
                    roomAmounts[rn] = (roomAmounts[rn] || 0) + roomProgress.remaining;
                }
                var rooms = Object.keys(roomAmounts).sort().map(function(r) { return r + ' (' + roomAmounts[r] + ')'; }).join(', ');
                lines2.push('  ' + resource + ': ' + dataFilled + '/' + data.original + ' filled (' + aggPct2.toFixed(1) + '%) | ' + data.orders.length + ' orders | avg ' + avg.toFixed(3) + ' | rooms: ' + rooms);
            } else {
                lines2.push('  ' + resource + ': ' + dataFilled + '/' + data.original + ' filled (' + aggPct2.toFixed(1) + '%) | ' + data.orders.length + ' orders | avg ' + avg.toFixed(3));
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
        if (jobs.refusals && jobs.refusals.length > 0) mem.lastRefusals = jobs.refusals;
        if (jobs.length > 0) {
            if (!mem.jobsStarted) mem.jobsStarted = [];
            for (var k = 0; k < jobs.length; k++) mem.jobsStarted.push(jobs[k]);
            if (mem.jobsStarted.length > JOBS_HISTORY_CAP) mem.jobsStarted = mem.jobsStarted.slice(-JOBS_HISTORY_CAP);
        }
        requestSave();
    }
};
