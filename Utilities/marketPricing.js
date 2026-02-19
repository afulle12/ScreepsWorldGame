/**
 * marketPricing.js
 * 
 * Calculates the Weighted Mid-Price for every resource using the Screeps Market API.
 * 
 * Weighted Mid-Price formula:
 *   WMP = (bestBid * askVolume + bestAsk * bidVolume) / (bidVolume + askVolume)
 * 
 * This weights the midpoint toward the side with less liquidity,
 * giving a fairer "true" price than a simple (bid+ask)/2.
 *
 * Console commands:
 *   prices()              - Print all resources with active markets
 *   prices('energy')      - Print price for a single resource
 *   prices(null, 'tier')  - Sort by tier instead of price
 */

const RESOURCE_LIST = [
    // Base
    RESOURCE_ENERGY, RESOURCE_POWER,
    // Base minerals
    RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM,
    RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST,
    // Base compounds
    RESOURCE_HYDROXIDE, RESOURCE_ZYNTHIUM_KEANITE, RESOURCE_UTRIUM_LEMERGITE,
    RESOURCE_GHODIUM,
    // Tier 1 boosts
    RESOURCE_UTRIUM_HYDRIDE, RESOURCE_UTRIUM_OXIDE,
    RESOURCE_KEANIUM_HYDRIDE, RESOURCE_KEANIUM_OXIDE,
    RESOURCE_LEMERGIUM_HYDRIDE, RESOURCE_LEMERGIUM_OXIDE,
    RESOURCE_ZYNTHIUM_HYDRIDE, RESOURCE_ZYNTHIUM_OXIDE,
    RESOURCE_GHODIUM_HYDRIDE, RESOURCE_GHODIUM_OXIDE,
    // Tier 2 boosts
    RESOURCE_UTRIUM_ACID, RESOURCE_UTRIUM_ALKALIDE,
    RESOURCE_KEANIUM_ACID, RESOURCE_KEANIUM_ALKALIDE,
    RESOURCE_LEMERGIUM_ACID, RESOURCE_LEMERGIUM_ALKALIDE,
    RESOURCE_ZYNTHIUM_ACID, RESOURCE_ZYNTHIUM_ALKALIDE,
    RESOURCE_GHODIUM_ACID, RESOURCE_GHODIUM_ALKALIDE,
    // Tier 3 boosts
    RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
    RESOURCE_CATALYZED_KEANIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
    RESOURCE_CATALYZED_LEMERGIUM_ACID, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
    RESOURCE_CATALYZED_ZYNTHIUM_ACID, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
    RESOURCE_CATALYZED_GHODIUM_ACID, RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
    // Commodities
    RESOURCE_OPS,
    RESOURCE_SILICON, RESOURCE_METAL, RESOURCE_BIOMASS, RESOURCE_MIST,
    RESOURCE_UTRIUM_BAR, RESOURCE_LEMERGIUM_BAR, RESOURCE_ZYNTHIUM_BAR,
    RESOURCE_KEANIUM_BAR, RESOURCE_GHODIUM_MELT, RESOURCE_OXIDANT,
    RESOURCE_REDUCTANT, RESOURCE_PURIFIER, RESOURCE_BATTERY,
    RESOURCE_COMPOSITE, RESOURCE_CRYSTAL, RESOURCE_LIQUID,
    RESOURCE_WIRE, RESOURCE_SWITCH, RESOURCE_TRANSISTOR, RESOURCE_MICROCHIP, RESOURCE_CIRCUIT,
    RESOURCE_CELL, RESOURCE_PHLEGM, RESOURCE_TISSUE, RESOURCE_MUSCLE, RESOURCE_ORGANOID,
    RESOURCE_ALLOY, RESOURCE_TUBE, RESOURCE_FIXTURES, RESOURCE_FRAME, RESOURCE_HYDRAULICS,
    RESOURCE_CONDENSATE, RESOURCE_CONCENTRATE, RESOURCE_EXTRACT, RESOURCE_SPIRIT, RESOURCE_EMANATION,
    RESOURCE_DEVICE, RESOURCE_MACHINE, RESOURCE_ORGANISM, RESOURCE_ESSENCE
];

// Depth of book to consider (top N orders on each side)
const ORDER_DEPTH = 5;

/**
 * Fetch all orders once, bucket by resource, then compute WMP for each.
 * Returns { resourceType: { wmp, bestBid, bestAsk, bidVol, askVol, spread, spreadPct } }
 */
function calculateAllPrices() {
    const allOrders = Game.market.getAllOrders();
    
    // Bucket orders by resource
    const buyByResource = {};
    const sellByResource = {};
    
    for (let i = 0; i < allOrders.length; i++) {
        const order = allOrders[i];
        if (order.amount <= 0) continue;
        
        if (order.type === ORDER_BUY) {
            if (!buyByResource[order.resourceType]) buyByResource[order.resourceType] = [];
            buyByResource[order.resourceType].push(order);
        } else {
            if (!sellByResource[order.resourceType]) sellByResource[order.resourceType] = [];
            sellByResource[order.resourceType].push(order);
        }
    }
    
    const results = {};
    
    for (let r = 0; r < RESOURCE_LIST.length; r++) {
        const res = RESOURCE_LIST[r];
        const buys = buyByResource[res];
        const sells = sellByResource[res];
        
        if (!buys || buys.length === 0 || !sells || sells.length === 0) {
            // Can't compute WMP without both sides
            if (buys && buys.length > 0) {
                buys.sort(function(a, b) { return b.price - a.price; });
                results[res] = {
                    wmp: null,
                    bestBid: buys[0].price,
                    bestAsk: null,
                    bidVol: sumVolume(buys, ORDER_DEPTH),
                    askVol: 0,
                    spread: null,
                    spreadPct: null,
                    oneSided: 'bid-only'
                };
            } else if (sells && sells.length > 0) {
                sells.sort(function(a, b) { return a.price - b.price; });
                results[res] = {
                    wmp: null,
                    bestBid: null,
                    bestAsk: sells[0].price,
                    bidVol: 0,
                    askVol: sumVolume(sells, ORDER_DEPTH),
                    spread: null,
                    spreadPct: null,
                    oneSided: 'ask-only'
                };
            }
            continue;
        }
        
        // Sort: buys descending (best bid first), sells ascending (best ask first)
        buys.sort(function(a, b) { return b.price - a.price; });
        sells.sort(function(a, b) { return a.price - b.price; });
        
        const topBuys = buys.slice(0, ORDER_DEPTH);
        const topSells = sells.slice(0, ORDER_DEPTH);
        
        // Volume-weighted best bid & ask
        const vwBid = weightedPrice(topBuys);
        const vwAsk = weightedPrice(topSells);
        const bidVol = sumVolume(topBuys, ORDER_DEPTH);
        const askVol = sumVolume(topSells, ORDER_DEPTH);
        
        // Weighted Mid-Price
        const wmp = (vwBid * askVol + vwAsk * bidVol) / (bidVol + askVol);
        
        const bestBid = topBuys[0].price;
        const bestAsk = topSells[0].price;
        const spread = bestAsk - bestBid;
        const mid = (bestAsk + bestBid) / 2;
        const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;
        
        results[res] = {
            wmp: wmp,
            bestBid: bestBid,
            bestAsk: bestAsk,
            bidVol: bidVol,
            askVol: askVol,
            spread: spread,
            spreadPct: spreadPct,
            vwBid: vwBid,
            vwAsk: vwAsk
        };
    }
    
    return results;
}

function weightedPrice(orders) {
    let totalValue = 0;
    let totalAmount = 0;
    for (let i = 0; i < orders.length; i++) {
        totalValue += orders[i].price * orders[i].amount;
        totalAmount += orders[i].amount;
    }
    return totalAmount > 0 ? totalValue / totalAmount : 0;
}

function sumVolume(orders, depth) {
    let total = 0;
    const limit = Math.min(orders.length, depth);
    for (let i = 0; i < limit; i++) {
        total += orders[i].amount;
    }
    return total;
}

/**
 * Pretty-print prices to console.
 * @param {string|null} filterResource - If set, only show this resource
 * @param {string} sortBy - 'price' (default) or 'name'
 */
function printPrices(filterResource, sortBy) {
    if (sortBy === undefined) sortBy = 'price';
    
    const prices = calculateAllPrices();
    
    const header = 
        pad('Resource', 18) +
        pad('WMP', 10) +
        pad('Bid', 10) +
        pad('Ask', 10) +
        pad('Spread', 10) +
        pad('Sprd%', 8) +
        pad('BidVol', 10) +
        pad('AskVol', 10);
    
    console.log('╔══════════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                          MARKET WEIGHTED MID-PRICES                                    ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════════════════╣');
    console.log(header);
    console.log('─'.repeat(96));
    
    // Build sorted list
    let entries = [];
    for (const res in prices) {
        if (filterResource && res !== filterResource) continue;
        entries.push({ resource: res, data: prices[res] });
    }
    
    if (sortBy === 'price') {
        entries.sort(function(a, b) {
            const pa = a.data.wmp || 0;
            const pb = b.data.wmp || 0;
            return pb - pa; // descending by price
        });
    } else {
        entries.sort(function(a, b) {
            return a.resource.localeCompare(b.resource);
        });
    }
    
    for (let i = 0; i < entries.length; i++) {
        const res = entries[i].resource;
        const d = entries[i].data;
        
        if (d.oneSided) {
            console.log(
                pad(res, 18) +
                pad('N/A', 10) +
                pad(d.bestBid !== null ? fmtPrice(d.bestBid) : '-', 10) +
                pad(d.bestAsk !== null ? fmtPrice(d.bestAsk) : '-', 10) +
                pad('-', 10) +
                pad('-', 8) +
                pad(fmtVol(d.bidVol), 10) +
                pad(fmtVol(d.askVol), 10) +
                '  (' + d.oneSided + ')'
            );
            continue;
        }
        
        console.log(
            pad(res, 18) +
            pad(fmtPrice(d.wmp), 10) +
            pad(fmtPrice(d.bestBid), 10) +
            pad(fmtPrice(d.bestAsk), 10) +
            pad(fmtPrice(d.spread), 10) +
            pad(d.spreadPct.toFixed(1) + '%', 8) +
            pad(fmtVol(d.bidVol), 10) +
            pad(fmtVol(d.askVol), 10)
        );
    }
    
    console.log('╚══════════════════════════════════════════════════════════════════════════════════════════╝');
    console.log('Order depth: top ' + ORDER_DEPTH + ' on each side | ' + entries.length + ' resources shown');
    
    return 'OK - ' + entries.length + ' resources priced';
}

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

module.exports = {
    calculateAllPrices: calculateAllPrices,
    printPrices: printPrices
};