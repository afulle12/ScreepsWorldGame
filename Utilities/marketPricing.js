/**
 * marketPricing.js (v2)
 *
 * Central market analytics for all trading modules. Replaces the hand-rolled
 * book scans in autoTrader, marketBuyer, and marketUpdate with one cached,
 * external-only view of the market.
 *
 * Key properties:
 *  - The order book is built AT MOST ONCE PER TICK (getAllOrders is expensive).
 *  - Our own rooms' orders are ALWAYS excluded from the book.
 *  - Dust orders (remainingAmount < MIN_ORDER_REMAINING) are excluded.
 *  - Depth is measured by cumulative VOLUME, not order count.
 *
 * API:
 *   getBook(res)                 -> { bestBid, bestAsk, vwBid, vwAsk, wmp, bidVol,
 *                                     askVol, spread, spreadPct, oneSided,
 *                                     bidCount, askCount }
 *   getAvg48h(res)               -> number | null   (volume-weighted, last 2 days)
 *   getRange7d(res)              -> number | null   ((max-min)/min of daily avg, volume-filtered)
 *   getTrend7d(res)              -> 'rising' | 'falling' | 'flat' | null
 *   getWeekLow(res)              -> number | null   (lowest valid daily avg in 7d)
 *   actualBuyPrice(res)          -> cost/unit when acquiring via a posted BUY order
 *   actualSellPrice(res)         -> revenue/unit when selling via a posted SELL order
 *   inputCeilings(product, marginPct) -> { res: maxPrice } | null
 *   chooseBuyMethod(res, ceiling, opts) -> { method, reason, suggestedBid, ... }
 *
 * Console:
 *   prices()           - dashboard (external orders only)
 *   prices('energy')   - single resource
 *   prices(null,'name')- sort alphabetically
 */

// ===== Configuration =====
var MIN_ORDER_REMAINING = 1000;   // dust filter: ignore orders with less remaining
var DEPTH_VOLUME = 20000;         // book depth per side, by cumulative volume
var FEE = 0.05;                   // market order creation/extension fee
var SPREAD_BUFFER = 0.02;         // extra hurdle on top of fee (repricing risk, energy uncertainty)
var DEFAULT_RANGE_GATE = 0.20;    // weekly range above this = "high range" regime
var HIGH_RANGE_HURDLE_MULT = 3;   // in high-range regimes, demand this multiple of the hurdle
var TREND_THRESHOLD = 0.05;       // +/-5% half-week drift = rising/falling

// ===== Per-tick cache =====
var _cache = null;

// ===== Shared raw orders cache =====
// getAllOrders() is expensive. This per-tick cache is shared across modules
// (marketArbitrage.buildOrderBooks calls pricing.getRawOrders() instead of
// its own getAllOrders()). Each module applies its own filtering on the
// shared raw array — neither mutates it. Lives in module scope (singleton
// via require cache); wiped on Screeps global resets, same as _cache.
var _rawOrdersCache = null;
function getRawOrders() {
    if (!_rawOrdersCache || _rawOrdersCache.tick !== Game.time) {
        _rawOrdersCache = { tick: Game.time, orders: Game.market.getAllOrders() || [] };
    }
    return _rawOrdersCache.orders;
}

function getMyRooms() {
    var myRooms = {};
    for (var rn in Game.rooms) {
        var r = Game.rooms[rn];
        if (r && r.controller && r.controller.my) myRooms[rn] = true;
    }
    return myRooms;
}

function buildCache() {
    if (_cache && _cache.tick === Game.time) return _cache;

    var myRooms = getMyRooms();
    var all = getRawOrders();
    var buys = {}, sells = {};

    for (var i = 0; i < all.length; i++) {
        var o = all[i];
        if (!o) continue;
        if (typeof o.price !== 'number') continue;
        if (typeof o.remainingAmount !== 'number' || o.remainingAmount < MIN_ORDER_REMAINING) continue;
        if (typeof o.amount !== 'number' || o.amount <= 0) continue;          // not dealable right now
        if (o.roomName && myRooms[o.roomName]) continue;                       // EXTERNAL ONLY

        if (o.type === ORDER_BUY) {
            if (!buys[o.resourceType]) buys[o.resourceType] = [];
            buys[o.resourceType].push(o);
        } else {
            if (!sells[o.resourceType]) sells[o.resourceType] = [];
            sells[o.resourceType].push(o);
        }
    }
    for (var rb in buys)  buys[rb].sort(function(a, b) { return b.price - a.price; });
    for (var rs in sells) sells[rs].sort(function(a, b) { return a.price - b.price; });

    _cache = { tick: Game.time, buys: buys, sells: sells, books: {}, hist: {}, myRooms: myRooms };
    return _cache;
}

// Take orders from the top of the (already sorted) side until DEPTH_VOLUME is covered.
function depthSlice(orders) {
    var out = [], vol = 0;
    for (var i = 0; i < orders.length; i++) {
        out.push(orders[i]);
        vol += orders[i].amount;
        if (vol >= DEPTH_VOLUME) break;
    }
    return out;
}

function weightedPrice(orders) {
    var totalValue = 0, totalAmount = 0;
    for (var i = 0; i < orders.length; i++) {
        totalValue += orders[i].price * orders[i].amount;
        totalAmount += orders[i].amount;
    }
    return totalAmount > 0 ? totalValue / totalAmount : 0;
}

function sumVolume(orders) {
    var total = 0;
    for (var i = 0; i < orders.length; i++) total += orders[i].amount;
    return total;
}

// ===== Book accessor =====

function getBook(resource) {
    var c = buildCache();
    if (c.books[resource]) return c.books[resource];

    var buys = c.buys[resource] || [];
    var sells = c.sells[resource] || [];
    var book;

    if (buys.length === 0 && sells.length === 0) {
        book = { bestBid: null, bestAsk: null, vwBid: null, vwAsk: null, wmp: null,
                 bidVol: 0, askVol: 0, spread: null, spreadPct: null,
                 oneSided: 'empty', bidCount: 0, askCount: 0 };
    } else if (buys.length === 0 || sells.length === 0) {
        var side = buys.length > 0 ? buys : sells;
        var top = depthSlice(side);
        book = {
            bestBid: buys.length > 0 ? buys[0].price : null,
            bestAsk: sells.length > 0 ? sells[0].price : null,
            vwBid: buys.length > 0 ? weightedPrice(top) : null,
            vwAsk: sells.length > 0 ? weightedPrice(top) : null,
            wmp: null,
            bidVol: buys.length > 0 ? sumVolume(top) : 0,
            askVol: sells.length > 0 ? sumVolume(top) : 0,
            spread: null, spreadPct: null,
            oneSided: buys.length > 0 ? 'bid-only' : 'ask-only',
            bidCount: buys.length, askCount: sells.length
        };
    } else {
        var topBuys = depthSlice(buys);
        var topSells = depthSlice(sells);
        var vwBid = weightedPrice(topBuys);
        var vwAsk = weightedPrice(topSells);
        var bidVol = sumVolume(topBuys);
        var askVol = sumVolume(topSells);
        var wmp = (vwBid * askVol + vwAsk * bidVol) / (bidVol + askVol);
        var bestBid = topBuys[0].price;
        var bestAsk = topSells[0].price;
        var spread = bestAsk - bestBid;
        var mid = (bestAsk + bestBid) / 2;
        book = {
            bestBid: bestBid, bestAsk: bestAsk, vwBid: vwBid, vwAsk: vwAsk, wmp: wmp,
            bidVol: bidVol, askVol: askVol, spread: spread,
            spreadPct: mid > 0 ? (spread / mid) * 100 : 0,
            oneSided: null, bidCount: buys.length, askCount: sells.length
        };
    }
    c.books[resource] = book;
    return book;
}

// ===== History metrics =====

function getHistDays(resource) {
    var c = buildCache();
    if (c.hist[resource]) return c.hist[resource];
    var hist = Game.market.getHistory(resource) || [];
    c.hist[resource] = hist;
    return hist;
}

function getAvg48h(resource) {
    var hist = getHistDays(resource);
    if (!hist || hist.length === 0) return null;
    var last = hist[hist.length - 1];
    var prev = hist.length >= 2 ? hist[hist.length - 2] : null;
    var sumPV = 0, sumV = 0;
    if (last && typeof last.avgPrice === 'number' && typeof last.volume === 'number') {
        sumPV += last.avgPrice * last.volume; sumV += last.volume;
    }
    if (prev && typeof prev.avgPrice === 'number' && typeof prev.volume === 'number') {
        sumPV += prev.avgPrice * prev.volume; sumV += prev.volume;
    }
    if (sumV <= 0) return last && typeof last.avgPrice === 'number' ? last.avgPrice : null;
    return sumPV / sumV;
}

// Valid days from the last 7: volume > 0, avgPrice > 0
function validWeekDays(resource) {
    var hist = getHistDays(resource);
    var days = [];
    var start = Math.max(0, hist.length - 7);
    for (var i = start; i < hist.length; i++) {
        var h = hist[i];
        if (h && typeof h.avgPrice === 'number' && h.avgPrice > 0 &&
            typeof h.volume === 'number' && h.volume > 0) {
            days.push(h);
        }
    }
    return days;
}

function medianVolume(days) {
    var vols = [];
    for (var i = 0; i < days.length; i++) vols.push(days[i].volume);
    vols.sort(function(a, b) { return a - b; });
    var mid = Math.floor(vols.length / 2);
    return vols.length % 2 === 1 ? vols[mid] : (vols[mid - 1] + vols[mid]) / 2;
}

/**
 * Weekly price range = (max - min) / min of daily avgPrice over the past 7 days.
 * Days with volume below 20% of the weekly median are dropped so a single
 * junk/low-volume day cannot trip the gate. Returns null with < 4 usable days.
 */
function getRange7d(resource) {
    var days = validWeekDays(resource);
    if (days.length < 4) return null;

    var med = medianVolume(days);
    var filtered = [];
    for (var i = 0; i < days.length; i++) {
        if (days[i].volume >= med * 0.2) filtered.push(days[i]);
    }
    if (filtered.length >= 4) days = filtered; // only apply filter if enough days survive

    var min = Infinity, max = 0;
    for (var j = 0; j < days.length; j++) {
        if (days[j].avgPrice < min) min = days[j].avgPrice;
        if (days[j].avgPrice > max) max = days[j].avgPrice;
    }
    if (!(min > 0)) return null;
    return (max - min) / min;
}

/**
 * Trend over the past week: first-half average vs second-half average.
 * 'rising' / 'falling' beyond +/- TREND_THRESHOLD, else 'flat'. null if sparse.
 */
function getTrend7d(resource) {
    var days = validWeekDays(resource);
    if (days.length < 4) return null;
    var half = Math.floor(days.length / 2);
    var firstSum = 0, secondSum = 0;
    for (var i = 0; i < half; i++) firstSum += days[i].avgPrice;
    for (var j = half; j < days.length; j++) secondSum += days[j].avgPrice;
    var firstAvg = firstSum / half;
    var secondAvg = secondSum / (days.length - half);
    if (!(firstAvg > 0)) return null;
    var drift = (secondAvg - firstAvg) / firstAvg;
    if (drift > TREND_THRESHOLD) return 'rising';
    if (drift < -TREND_THRESHOLD) return 'falling';
    return 'flat';
}

function getWeekLow(resource) {
    var days = validWeekDays(resource);
    if (days.length === 0) return null;
    var min = Infinity;
    for (var i = 0; i < days.length; i++) {
        if (days[i].avgPrice < min) min = days[i].avgPrice;
    }
    return min === Infinity ? null : min;
}

// ===== Posted-order price estimates =====
// (Same semantics as autoTrader's computeActualBuyPrice / computeActualSellPrice.)

// Expected cost/unit when acquiring via a posted BUY order: outbid best external bid,
// but clamped to 1.5x the 48h average so a lone overpriced dust/manipulation bid
// cannot inflate acquisition cost estimates.
function actualBuyPrice(resource) {
    var b = getBook(resource);
    var avg = getAvg48h(resource);
    var avgSafe = avg !== null ? avg : 1;
    if (b.bestBid !== null) {
        return Math.max(Math.min(b.bestBid + 0.1, avgSafe * 1.5), 0.001);
    }
    return Math.max(avgSafe * 0.95, 0.001);
}

// Competitive posted BUY bid for a given ceiling. Leads the best external bid by 0.1,
// floored by the volume-weighted ask, and ignores a bestBid that sits above the
// volume-weighted ask (crossed/manipulated book). Returns null if the resulting bid
// exceeds the supplied ceiling.
function computePostedBid(resource, ceiling) {
    var b = getBook(resource);
    var bestBid = (b && b.bestBid !== null) ? b.bestBid : 0;
    var vwAsk   = (b && b.vwAsk !== null)   ? b.vwAsk   : 0;
    var vwBid   = (b && b.vwBid !== null)   ? b.vwBid   : 0;

    // Robust bid base: ignore a bestBid that is above the volume-weighted ask
    // (crossed/manipulated book). Anchor off the volume-weighted bid instead.
    var baseBid;
    if (bestBid > 0 && bestBid <= vwAsk) {
        baseBid = bestBid;
    } else if (vwBid > 0) {
        baseBid = vwBid;
    } else if (vwAsk > 0) {
        baseBid = vwAsk;
    } else {
        baseBid = bestBid > 0 ? bestBid : 0;
    }

    var bid = baseBid + 0.1;
    if (vwAsk > 0) bid = Math.max(bid, vwAsk);

    if (typeof ceiling === 'number' && ceiling > 0) {
        if (bid > ceiling) return null;
        bid = Math.min(bid, ceiling);
    }
    return Math.max(bid, 0.001);
}

// Expected revenue/unit when selling via a posted SELL order: undercut best external ask,
// clamped to 1.5x the 48h average so a lone overpriced ask can't inflate revenue estimates.
function actualSellPrice(resource) {
    var b = getBook(resource);
    var avg = getAvg48h(resource);
    var avgSafe = avg !== null ? avg : 1;
    if (b.bestAsk !== null) {
        return Math.max(Math.min(b.bestAsk - 0.1, avgSafe * 1.5), 0.001);
    }
    return Math.max(avgSafe * 1.05, 0.001);
}

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

// ===== Margin-derived input ceilings =====
// (Lifted from autoTrader's computeInputPricesForMargin, parameterized by margin.)
// Returns the max price per input resource such that producing `product` and selling
// it via a posted sell order still clears `marginPct`. null if unachievable.

function inputCeilings(product, marginPct) {
    var recipe = COMMODITIES && COMMODITIES[product];
    if (!recipe) return null;
    var outQty = (typeof recipe.amount === 'number' && recipe.amount > 0) ? recipe.amount : 1;
    var comps = recipe.components || {};

    var revenue = actualSellPrice(product) * outQty;
    var maxTotalCost = revenue / (1 + marginPct / 100);

    var energyQty = comps[RESOURCE_ENERGY] || 0;
    var energyCost = energyQty > 0 ? actualBuyPrice(RESOURCE_ENERGY) * energyQty : 0;
    var remainingBudget = maxTotalCost - energyCost;
    if (remainingBudget <= 0) return null;

    var naivePrices = {}, naiveCost = 0;
    for (var res in comps) {
        if (!comps.hasOwnProperty(res) || res === RESOURCE_ENERGY) continue;
        var p = actualSellPrice(res);
        naivePrices[res] = p > 0 ? p : 0;
        naiveCost += naivePrices[res] * comps[res];
    }
    if (naiveCost <= 0) return null;

    var scale = Math.min(remainingBudget / naiveCost, 1.0);
    var out = {};
    for (var res2 in comps) {
        if (!comps.hasOwnProperty(res2) || res2 === RESOURCE_ENERGY) continue;
        out[res2] = naivePrices[res2] > 0 ? naivePrices[res2] * scale : 0;
    }
    return out;
}

// ===== Buy-method dispatcher =====
/**
 * Decide how to acquire `resource` given a price `ceiling`.
 *
 * Returns { method: 'opportunistic' | 'order',
 *           suggestedBid: number|null,    // only for 'order'
 *           defensive: bool,              // posted with reduced confidence (sparse data / high range)
 *           reason: string,
 *           book, range, trend }          // diagnostics
 *
 * Rules:
 *  - Rising trend + asks available  -> opportunistic (a posted bid won't fill at a sane price).
 *  - No external asks at/under the ceiling (thin market) -> order. If history is sparse
 *    or the weekly range exceeds the gate, post DEFENSIVELY (bid anchored near 48h avg /
 *    weekly low, never above the ceiling).
 *  - Liquid market -> order only if the spread (bestAsk vs our bid) beats the
 *    fee+buffer hurdle; in high-range regimes the hurdle is multiplied so only
 *    fat spreads qualify.
 *  - Falling trend -> anchor the bid near the weekly low; the market has shown it
 *    visits that level.
 */
function chooseBuyMethod(resource, ceiling, opts) {
    opts = opts || {};
    var rangeGate = typeof opts.rangeGate === 'number' ? opts.rangeGate : DEFAULT_RANGE_GATE;

    var book = getBook(resource);
    var range = getRange7d(resource);
    var trend = getTrend7d(resource);

    var result = { method: 'opportunistic', suggestedBid: null, defensive: false,
                   reason: '', book: book, range: range, trend: trend };

    var hasCeiling = typeof ceiling === 'number' && ceiling > 0;
    var noAsks = (book.bestAsk === null);
    var noTakeableAsks = noAsks || (hasCeiling && book.bestAsk > ceiling);

    // Proposed bid: outbid the best external bid, capped at the ceiling.
    var bid;
    if (book.bestBid !== null) bid = book.bestBid + 0.1;
    else {
        var avg = getAvg48h(resource);
        bid = (avg !== null ? avg : 1) * 0.95;
    }
    if (hasCeiling) bid = Math.min(bid, ceiling);
    bid = Math.max(bid, 0.001);

    // Rising market with takeable asks: take them; a posted bid chases upward (paid raises).
    if (trend === 'rising' && !noTakeableAsks) {
        result.reason = 'rising trend; take existing asks';
        return result;
    }

    // Falling market: anchor near the demonstrated weekly low (still capped by ceiling).
    if (trend === 'falling') {
        var low = getWeekLow(resource);
        if (low !== null) bid = Math.max(Math.min(bid, low * 1.02), 0.001);
    }

    // Thin market: nothing to take -> must post.
    if (noTakeableAsks) {
        result.method = 'order';
        if (range === null) {
            // Sparse history: post, but defensively off the 48h avg.
            var avg2 = getAvg48h(resource);
            if (avg2 !== null) bid = Math.min(bid, avg2);
            result.defensive = true;
            result.reason = (noAsks ? 'no external asks' : 'no asks under ceiling') + '; sparse history, defensive bid';
        } else if (range > rangeGate) {
            var low2 = getWeekLow(resource);
            if (low2 !== null) bid = Math.min(bid, low2 * 1.05);
            result.defensive = true;
            result.reason = 'thin market, weekly range ' + (range * 100).toFixed(0) + '% > gate; defensive bid';
        } else {
            result.reason = noAsks ? 'no external asks' : 'no asks under ceiling';
        }
        result.suggestedBid = Math.max(bid, 0.001);
        return result;
    }

    // Liquid market: spread economics. Hurdle = creation fee + buffer; multiplied in
    // high-range regimes so only fat spreads justify granting the market an option.
    var hurdle = FEE + SPREAD_BUFFER;
    if (range !== null && range > rangeGate) hurdle = hurdle * HIGH_RANGE_HURDLE_MULT;

    var spreadEdge = (book.bestAsk - bid) / bid;
    if (spreadEdge > hurdle) {
        result.method = 'order';
        result.suggestedBid = Math.max(bid, 0.001);
        result.reason = 'spread ' + (spreadEdge * 100).toFixed(0) + '% > hurdle ' + (hurdle * 100).toFixed(0) + '%';
        return result;
    }

    result.reason = 'spread ' + (spreadEdge * 100).toFixed(0) + '% below hurdle ' + (hurdle * 100).toFixed(0) + '%';
    return result;
}

// ===== Console dashboard (external-only book) =====

function fmtPrice(val) {
    if (val === null || val === undefined) return '-';
    if (val >= 1) return val.toFixed(3);
    if (val >= 0.01) return val.toFixed(4);
    return val.toFixed(6);
}

function fmtVol(val) {
    if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
    if (val >= 1000) return (val / 1000).toFixed(1) + 'k';
    return '' + val;
}

function pad(str, len) {
    str = '' + str;
    while (str.length < len) str += ' ';
    return str;
}

function printPrices(filterResource, sortBy) {
    if (sortBy === undefined) sortBy = 'price';
    var c = buildCache();

    // Derive the resource set from what's actually on the book.
    var resSet = {};
    for (var rb in c.buys) resSet[rb] = true;
    for (var rs in c.sells) resSet[rs] = true;

    var entries = [];
    for (var res in resSet) {
        if (filterResource && res !== filterResource) continue;
        entries.push({ resource: res, data: getBook(res) });
    }

    if (sortBy === 'price') {
        entries.sort(function(a, b) {
            var pa = a.data.wmp !== null ? a.data.wmp : (a.data.bestAsk !== null ? a.data.bestAsk : (a.data.bestBid || 0));
            var pb = b.data.wmp !== null ? b.data.wmp : (b.data.bestAsk !== null ? b.data.bestAsk : (b.data.bestBid || 0));
            return pb - pa;
        });
    } else {
        entries.sort(function(a, b) { return a.resource.localeCompare(b.resource); });
    }

    var header = pad('Resource', 18) + pad('WMP', 10) + pad('Bid', 10) + pad('Ask', 10) +
                 pad('Spread', 10) + pad('Sprd%', 8) + pad('BidVol', 10) + pad('AskVol', 10);
    console.log('=== MARKET WEIGHTED MID-PRICES (external orders only) ===');
    console.log(header);
    console.log(Array(97).join('-'));

    for (var i = 0; i < entries.length; i++) {
        var r = entries[i].resource;
        var d = entries[i].data;
        console.log(
            pad(r, 18) +
            pad(fmtPrice(d.wmp), 10) +
            pad(fmtPrice(d.bestBid), 10) +
            pad(fmtPrice(d.bestAsk), 10) +
            pad(fmtPrice(d.spread), 10) +
            pad(d.spreadPct !== null ? d.spreadPct.toFixed(1) + '%' : '-', 8) +
            pad(fmtVol(d.bidVol), 10) +
            pad(fmtVol(d.askVol), 10) +
            (d.oneSided ? '  (' + d.oneSided + ')' : '')
        );
    }
    console.log('Depth: top ' + fmtVol(DEPTH_VOLUME) + ' units/side | dust filter: remaining >= ' + MIN_ORDER_REMAINING + ' | ' + entries.length + ' resources');
    return 'OK - ' + entries.length + ' resources priced';
}

global.prices = function(filterResource, sortBy) {
    return printPrices(filterResource, sortBy);
};

module.exports = {
    getBook: getBook,
    getAvg48h: getAvg48h,
    getHistDays: getHistDays,
    getRange7d: getRange7d,
    getTrend7d: getTrend7d,
    getWeekLow: getWeekLow,
    getRawOrders: getRawOrders,
    actualBuyPrice: actualBuyPrice,
    actualSellPrice: actualSellPrice,
    computePostedBid: computePostedBid,
    inputCeilings: inputCeilings,
    chooseBuyMethod: chooseBuyMethod,
    printPrices: printPrices,
    FEE: FEE
};
