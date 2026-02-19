// marketAnalysis.js
// Factory, Lab, and Reverse Reaction profitability tables using live market data.
//
// IMPORTANT
// - No optional chaining (Screeps runtime limitation).
// - Prices prefer your existing global.marketPrice helper created earlier; if a
//   programmatic getter isn't exposed, this falls back to Screeps Market APIs.
// - Output is returned as a single formatted string (no console.log here).
// - Recipes come from COMMODITIES (factory) and REACTIONS (labs). Batch size for
//   labs uses LAB_REACTION_AMOUNT. Costs/revenues are immediate (non-recursive).
//
// VERSION 2.3 FEATURES:
// - Energy pricing now uses marketBuy-style computation (competitive buy price)
// - Price source tracking (LIVE vs HIST) - know if price is from real orders or historical avg
// - Order depth warnings - alerts when no buy/sell orders exist
// - Actionable vs Theoretical profits - only shows ✓ when both sides have live orders
// - Bid-ask spread detection - warns about suspicious spreads
// - Volume columns - shows available units at shown prices for profitable transactions
// - NEW: Factory Decompression analysis - profitability of breaking bars back to base resources
//
// Usage (console):
//   console.log(marketAnalysis());            // default: out='buy', in='sell'
//   console.log(marketAnalysis('avg','avg')); // both sides 48h volume-weighted avg
//   console.log(marketAnalysis('sell','sell'));
//
//   // Reverse reaction only (breakdown compounds to sell reagents):
//   console.log(reverseReactionAnalysis());          // default modes
//   console.log(reverseReactionAnalysis('sell','buy')); // custom modes
//
//   // Factory decompression only (bars → base resources):
//   console.log(decompressionAnalysis());            // default modes
//   console.log(decompressionAnalysis('buy','sell')); // custom modes
//
//   // Check order book for a resource:
//   console.log(orderBook('ZO'));
//
// SECTIONS:
// 1. Factory Production - cost to make commodities vs sell price
// 2. Factory Decompression - cost to BUY bars vs revenue from SELLING base resources
// 3. Lab Production - cost to make compounds vs sell price  
// 4. Reverse Reactions - cost to BUY compounds vs revenue from SELLING reagents
//    (useful for finding arbitrage opportunities via StructureLab.reverseReaction)
//
// Price Source Indicators:
//   LIVE = Price from actual market orders (actionable)
//   HIST = Price from historical average (may not be achievable)
//   NONE = No price data available
//   MBUY = Price computed using marketBuy strategy (competitive buy price)
//
// Actionable Indicators:
//   ✓ = Both buy and sell sides have live orders - can execute now
//   ~ = One side uses historical price - may not be achievable
//   ✗ = Missing critical price data or no orders exist
//
// Volume Column:
//   Shows available units at the displayed price
//   For outputs: how many you can sell at that price
//   For reverse reactions: how many compounds you can buy to break down
//
// References: Factory & resources overview; market system and APIs.

(function registerMarketAnalysisGlobal() {
  // Factory targets requested (COMMODITIES keys)
  var FACTORY_TARGETS = [
    'oxidant',
    'reductant',
    'zynthium_bar',
    'lemergium_bar',
    'utrium_bar',
    'keanium_bar',
    'purifier',
    'battery',
    'ghodium_melt',
    'composite',
    'crystal',
    'liquid',
    'alloy',
    'wire',
    'cell',
    'condensate'
  ];

  // Factory DECOMPRESSION targets (base resources produced from bars)
  // These are in COMMODITIES with the base resource as the key
  // Decompression formulas:
  //   100 bar + 200 energy → 500 mineral (for U, L, Z, K, O, H, G)
  //   1 battery → 50 energy (no energy cost)
  var FACTORY_DECOMPRESSION_TARGETS = [
    'U',      // from utrium_bar + energy
    'L',      // from lemergium_bar + energy
    'Z',      // from zynthium_bar + energy
    'K',      // from keanium_bar + energy
    'O',      // from oxidant + energy
    'H',      // from reductant + energy
    'G',      // from ghodium_melt + energy
    'energy'  // from battery (special case: no energy input)
  ];

  // Mapping of base resource → bar name (for display and fallback)
  var DECOMPRESSION_BAR_MAP = {
    'U': 'utrium_bar',
    'L': 'lemergium_bar',
    'Z': 'zynthium_bar',
    'K': 'keanium_bar',
    'O': 'oxidant',
    'H': 'reductant',
    'G': 'ghodium_melt',
    'energy': 'battery'
  };

  // ---------- utils ----------
  function number(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
  function fmt(n) { return typeof n === 'number' && isFinite(n) ? n.toFixed(2) : 'n/a'; }
  function fmtShort(n) { return typeof n === 'number' && isFinite(n) ? n.toFixed(1) : 'n/a'; }
  function padRight(s, w) { s = String(s); while (s.length < w) s += ' '; return s; }
  function padLeft(s, w) { s = String(s); while (s.length < w) s = ' ' + s; return s; }
  
  // Format volume with K/M suffixes for readability
  function fmtVol(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.floor(n));
  }

  function sortByMarginDescThenProfitDesc(a, b) {
    var am = a.marginPct === null ? -Infinity : a.marginPct;
    var bm = b.marginPct === null ? -Infinity : b.marginPct;
    if (bm !== am) return bm - am;
    var ap = a.profit === null ? -Infinity : a.profit;
    var bp = b.profit === null ? -Infinity : b.profit;
    return bp - ap;
  }

  // Accept: 'RESOURCE_ENERGY' or 'energy' etc.
  function resolveResource(input) {
    if (typeof input !== 'string') return input;
    if (typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(input) !== -1) return input;
    var maybeConst = global[input];
    if (typeof maybeConst === 'string' && typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(maybeConst) !== -1) {
      return maybeConst;
    }
    var lower = input.toLowerCase();
    if (typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(lower) !== -1) return lower;
    return input;
  }

  // ---------- order book helpers ----------
  
  /**
   * Get detailed order information for a resource
   * @param {string} resource
   * @param {string} orderType - ORDER_BUY or ORDER_SELL
   * @returns {Object} {count, totalVolume, bestPrice, orders[]}
   */
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
    
    // Sort: buy orders descending (highest first), sell orders ascending (lowest first)
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

  // ---------- marketBuy-style pricing for energy ----------
  
  /**
   * Compute buy price using the same logic as marketBuyer.computeBuyPrice
   * This represents the realistic cost to acquire a resource without waiting forever.
   * 
   * Strategy:
   * - If a highest external BUY order with remaining >= 1000 exists, price = that.price + 0.1
   * - Else price = 95% * avgPrice over last 2 days from Market history
   * - Clamp to 0.001 minimum
   * 
   * @param {string} resourceType
   * @returns {Object} {price, source, orderCount, volume}
   */
  function computeMarketBuyPrice(resourceType) {
    // Get all buy orders for this resource
    var orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType }) || [];

    // Build set of our rooms to filter out our own orders
    var myRooms = {};
    for (var rn in Game.rooms) {
      var r = Game.rooms[rn];
      if (r && r.controller && r.controller.my) {
        myRooms[rn] = true;
      }
    }

    // Filter for valid external orders with ≥1000 remaining
    var validOrders = [];
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (!o || o.type !== ORDER_BUY) continue;
      if (typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
      if (o.roomName && myRooms[o.roomName]) continue;
      if (typeof o.price !== 'number') continue;

      validOrders.push(o);
    }

    // Sort by price (highest to lowest)
    validOrders.sort(function(a, b) {
      return b.price - a.price;
    });

    // Calculate total volume from valid orders
    var totalVolume = 0;
    for (var j = 0; j < validOrders.length; j++) {
      totalVolume += validOrders[j].remainingAmount || 0;
    }

    // If we found valid orders, use the highest price + 0.1
    if (validOrders.length > 0) {
      var bestPrice = validOrders[0].price;
      var p = bestPrice + 0.1;
      return {
        price: Math.max(p, 0.001),
        source: 'MBUY',  // marketBuy-style pricing
        orderCount: validOrders.length,
        volume: totalVolume
      };
    }

    // No valid orders with ≥1000 units - fall back to historical average
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
    var price = avg * 0.95; // 5% below average to be competitive
    
    return {
      price: Math.max(price, 0.001),
      source: 'HIST',
      orderCount: 0,
      volume: 0
    };
  }

  // ---------- pricing with source tracking ----------
  
  /**
   * @typedef {Object} PriceResult
   * @property {number|null} price - The price value
   * @property {string} source - 'LIVE', 'HIST', 'MBUY', or 'NONE'
   * @property {number} orderCount - Number of orders (0 if using historical)
   * @property {number} volume - Available volume (0 if using historical)
   */

  function getPriceViaMarketPrice(resource, mode) {
    try {
      if (global.marketPrice && typeof global.marketPrice === 'function') {
        if (typeof global.marketPrice.get === 'function') return global.marketPrice.get(resource, mode);
        if (typeof global.marketPrice.priceOf === 'function') return global.marketPrice.priceOf(resource, mode);
      }
    } catch (e) {}
    return null;
  }

  function getAvg48h(resource) {
    var hist = Game.market.getHistory(resource) || [];
    if (!hist || hist.length === 0) return null;
    var last = hist[hist.length - 1];
    var prev = hist.length >= 2 ? hist[hist.length - 2] : null;
    var sumPV = 0;
    var sumV = 0;
    if (last && typeof last.avgPrice === 'number' && typeof last.volume === 'number') {
      sumPV += last.avgPrice * last.volume; sumV += last.volume;
    }
    if (prev && typeof prev.avgPrice === 'number' && typeof prev.volume === 'number') {
      sumPV += prev.avgPrice * prev.volume; sumV += prev.volume;
    }
    if (sumV <= 0) return last && typeof last.avgPrice === 'number' ? last.avgPrice : null;
    return sumPV / sumV;
  }

  /**
   * Get price with source tracking
   * For energy with mode 'sell' (input costs), uses marketBuy-style pricing
   * @param {string} resource
   * @param {string} mode - 'buy', 'sell', or 'avg'
   * @returns {PriceResult}
   */
  function priceOfWithSource(resource, mode) {
    resource = resolveResource(resource);
    
    // SPECIAL CASE: For energy as an INPUT (mode='sell'), use marketBuy-style pricing
    // This represents the realistic cost to acquire energy quickly
    if (resource === RESOURCE_ENERGY && mode === 'sell') {
      return computeMarketBuyPrice(resource);
    }
    
    // Try external helper first (assume it's live data)
    var via = getPriceViaMarketPrice(resource, mode);
    if (typeof via === 'number' && isFinite(via)) {
      // We can't know for sure if marketPrice helper uses live or historical
      // Assume live for now, but check order book to verify
      var orderType = mode === 'buy' ? ORDER_BUY : ORDER_SELL;
      if (mode !== 'avg') {
        var info = getOrderInfo(resource, orderType);
        return {
          price: via,
          source: info.count > 0 ? 'LIVE' : 'HIST',
          orderCount: info.count,
          volume: info.totalVolume
        };
      }
      return { price: via, source: 'HIST', orderCount: 0, volume: 0 };
    }
    
    // Fallback logic with source tracking
    if (mode === 'avg') {
      var avg = getAvg48h(resource);
      if (avg !== null) {
        return { price: avg, source: 'HIST', orderCount: 0, volume: 0 };
      }
      // Try sell orders as fallback
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
      
      // Fallback to historical
      var histPrice = getAvg48h(resource);
      if (histPrice !== null) {
        return { price: histPrice, source: 'HIST', orderCount: 0, volume: 0 };
      }
      
      return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }
    
    return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
  }

  // Simple price getter (backwards compatible)
  function priceOf(resource, mode) {
    return priceOfWithSource(resource, mode).price;
  }

  // ---------- factory ----------
  function analyzeFactoryCommodity(resource, outputMode, inputMode) {
    var recipe = COMMODITIES && COMMODITIES[resource];
    if (!recipe) return { resource: resource, found: false };

    var outQty = number(recipe.amount) > 0 ? number(recipe.amount) : 1;
    var comps = recipe.components || {};
    var totalCost = 0;
    var inputSources = [];
    var allInputsLive = true;
    
    for (var res in comps) {
      if (!comps.hasOwnProperty(res)) continue;
      var qty = number(comps[res]);
      var priceInfo = priceOfWithSource(res, inputMode);
      totalCost += (priceInfo.price === null ? 0 : priceInfo.price * qty);
      inputSources.push(priceInfo.source);
      // MBUY counts as "live" for actionability since it's based on real orders
      if (priceInfo.source !== 'LIVE' && priceInfo.source !== 'MBUY') allInputsLive = false;
    }
    
    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : (revenue - totalCost);
    var profitPerUnit = profit === null ? null : (profit / outQty);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);
    
    // Determine actionability
    var actionable = '✗';
    if (outputInfo.source === 'LIVE' && allInputsLive) {
      actionable = '✓';
    } else if (outputInfo.price !== null) {
      actionable = '~';
    }

    return {
      resource: resource, found: true,
      outQty: outQty, unitPrice: unitPrice, revenue: revenue,
      inputCost: totalCost, profit: profit, profitPerUnit: profitPerUnit, marginPct: marginPct,
      outputSource: outputInfo.source,
      outputVolume: outputInfo.volume,
      outputOrderCount: outputInfo.orderCount,
      allInputsLive: allInputsLive,
      actionable: actionable
    };
  }

  // ---------- factory decompression ----------
  
  /**
   * Analyze decompression: buying bars to decompress back to base resources
   * Decompression recipes (from COMMODITIES):
   *   100 bar + 200 energy → 500 mineral (for U, L, Z, K, O, H, G)
   *   1 battery → 50 energy (no energy cost)
   * 
   * @param {string} baseResource - The output resource (U, L, Z, K, O, H, G, or energy)
   * @param {string} outputMode - 'buy' or 'sell' - how we'll sell the base resource
   * @param {string} inputMode - 'buy' or 'sell' - how we'll buy the bars
   */
  function analyzeFactoryDecompression(baseResource, outputMode, inputMode) {
    // Get the recipe from COMMODITIES
    var recipe = COMMODITIES && COMMODITIES[baseResource];
    
    // If no recipe found in COMMODITIES, use known defaults
    var outQty, components, barName;
    
    if (recipe && recipe.components) {
      outQty = number(recipe.amount) > 0 ? number(recipe.amount) : 1;
      components = recipe.components;
      // Find the bar in components
      barName = DECOMPRESSION_BAR_MAP[baseResource];
    } else {
      // Fallback to known decompression formulas
      barName = DECOMPRESSION_BAR_MAP[baseResource];
      if (!barName) return { resource: baseResource, found: false };
      
      if (baseResource === 'energy') {
        // 1 battery → 50 energy
        outQty = 50;
        components = { 'battery': 1 };
      } else {
        // 100 bar + 200 energy → 500 mineral
        outQty = 500;
        components = {};
        components[barName] = 100;
        components['energy'] = 200;
      }
    }
    
    if (!barName) return { resource: baseResource, found: false };
    
    // Calculate input costs
    var totalCost = 0;
    var allInputsLive = true;
    var barInfo = null;
    var energyInfo = null;
    
    for (var res in components) {
      if (!components.hasOwnProperty(res)) continue;
      var qty = number(components[res]);
      var priceInfo = priceOfWithSource(res, inputMode);
      totalCost += (priceInfo.price === null ? 0 : priceInfo.price * qty);
      
      // Track sources
      if (res === barName) {
        barInfo = priceInfo;
      } else if (res === 'energy') {
        energyInfo = priceInfo;
      }
      
      if (priceInfo.source !== 'LIVE' && priceInfo.source !== 'MBUY') {
        allInputsLive = false;
      }
    }
    
    // Calculate output revenue
    var outputInfo = priceOfWithSource(baseResource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : (revenue - totalCost);
    var profitPerUnit = profit === null ? null : (profit / outQty);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);
    
    // Determine actionability
    var actionable = '✗';
    if (outputInfo.source === 'LIVE' && allInputsLive) {
      actionable = '✓';
    } else if (outputInfo.price !== null) {
      actionable = '~';
    }
    
    // Warnings
    var warnings = [];
    if (barInfo && barInfo.source === 'HIST') {
      warnings.push('No sell orders for ' + barName);
    }
    if (energyInfo && energyInfo.source === 'HIST') {
      warnings.push('Energy using historical price');
    }
    if (outputInfo.source === 'HIST') {
      warnings.push('No buy orders for ' + baseResource);
    }
    
    return {
      resource: baseResource,
      found: true,
      barName: barName,
      outQty: outQty,
      barQty: components[barName] || 0,
      energyQty: components['energy'] || 0,
      barPrice: barInfo ? barInfo.price : null,
      barSource: barInfo ? barInfo.source : 'NONE',
      barVolume: barInfo ? barInfo.volume : 0,
      energyPrice: energyInfo ? energyInfo.price : null,
      energySource: energyInfo ? energyInfo.source : 'NONE',
      inputCost: totalCost,
      unitPrice: unitPrice,
      outputSource: outputInfo.source,
      outputVolume: outputInfo.volume,
      revenue: revenue,
      profit: profit,
      profitPerUnit: profitPerUnit,
      marginPct: marginPct,
      allInputsLive: allInputsLive,
      actionable: actionable,
      warnings: warnings
    };
  }

  // ---------- labs ----------
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

  function listAllLabProducts(reactionPairs) {
    var arr = [];
    for (var prod in reactionPairs) if (reactionPairs.hasOwnProperty(prod)) arr.push(prod);
    arr.sort();
    return arr;
  }

  function analyzeLabProduct(resource, reactionPairs, outputMode, inputMode) {
    var pair = reactionPairs[resource];
    if (!pair) return { resource: resource, found: false };
    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;

    var a = pair[0];
    var b = pair[1];
    var paInfo = priceOfWithSource(a, inputMode);
    var pbInfo = priceOfWithSource(b, inputMode);
    var pa = paInfo.price;
    var pb = pbInfo.price;
    var totalCost = (pa === null ? 0 : pa * batch) + (pb === null ? 0 : pb * batch);
    // MBUY counts as "live" for actionability
    var allInputsLive = (paInfo.source === 'LIVE' || paInfo.source === 'MBUY') && 
                        (pbInfo.source === 'LIVE' || pbInfo.source === 'MBUY');

    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * batch;
    var profit = revenue === null ? null : (revenue - totalCost);
    var profitPerUnit = profit === null ? null : (profit / batch);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);

    // Determine actionability
    var actionable = '✗';
    if (outputInfo.source === 'LIVE' && allInputsLive) {
      actionable = '✓';
    } else if (outputInfo.price !== null) {
      actionable = '~';
    }

    return {
      resource: resource, found: true,
      outQty: batch, unitPrice: unitPrice, revenue: revenue,
      inputCost: totalCost, profit: profit, profitPerUnit: profitPerUnit, marginPct: marginPct,
      outputSource: outputInfo.source,
      outputVolume: outputInfo.volume,
      outputOrderCount: outputInfo.orderCount,
      inputASource: paInfo.source,
      inputBSource: pbInfo.source,
      allInputsLive: allInputsLive,
      actionable: actionable
    };
  }

  // ---------- reverse reactions (breakdown) ----------
  
  function analyzeReverseReaction(compound, reactionPairs, reagentSellMode, compoundBuyMode) {
    var pair = reactionPairs[compound];
    if (!pair) return { resource: compound, found: false };
    
    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    
    var reagentA = pair[0];
    var reagentB = pair[1];
    
    // Cost: buying the compound
    var compoundInfo = priceOfWithSource(compound, compoundBuyMode);
    var compoundPrice = compoundInfo.price;
    var totalCost = compoundPrice === null ? null : compoundPrice * batch;
    
    // Revenue: selling the reagents
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
    
    var profitPerUnit = profit === null ? null : (profit / batch);
    var marginPct = null;
    if (profit !== null && totalCost !== null && totalCost > 0) {
      marginPct = (profit / totalCost) * 100;
    }
    
    // Determine actionability for reverse reaction:
    // - Need to BUY compound (compoundBuyMode) - need SELL orders to exist
    // - Need to SELL reagents (reagentSellMode) - need BUY orders to exist
    // MBUY counts as "live" for actionability
    var compoundBuyable = compoundInfo.source === 'LIVE' || compoundInfo.source === 'MBUY';
    var reagentASellable = priceAInfo.source === 'LIVE' || priceAInfo.source === 'MBUY';
    var reagentBSellable = priceBInfo.source === 'LIVE' || priceBInfo.source === 'MBUY';
    
    var actionable = '✗';
    var warnings = [];
    
    if (compoundBuyable && reagentASellable && reagentBSellable) {
      actionable = '✓';
    } else if (compoundPrice !== null && (priceA !== null || priceB !== null)) {
      actionable = '~';
    }
    
    // Generate warnings
    if (!compoundBuyable && compoundInfo.source === 'HIST') {
      warnings.push('No sell orders for ' + compound);
    }
    if (!reagentASellable && priceAInfo.source === 'HIST') {
      warnings.push('No buy orders for ' + reagentA);
    }
    if (!reagentBSellable && priceBInfo.source === 'HIST') {
      warnings.push('No buy orders for ' + reagentB);
    }
    
    return {
      resource: compound,
      found: true,
      reagentA: reagentA,
      reagentB: reagentB,
      batch: batch,
      compoundPrice: compoundPrice,
      compoundSource: compoundInfo.source,
      compoundVolume: compoundInfo.volume,
      priceA: priceA,
      priceASource: priceAInfo.source,
      priceAVolume: priceAInfo.volume,
      priceB: priceB,
      priceBSource: priceBInfo.source,
      priceBVolume: priceBInfo.volume,
      inputCost: totalCost,
      revenueA: revenueA,
      revenueB: revenueB,
      revenue: totalRevenue,
      profit: profit,
      profitPerUnit: profitPerUnit,
      marginPct: marginPct,
      actionable: actionable,
      warnings: warnings
    };
  }

  // ---------- tables ----------
  function buildFactoryTable(rows, outMode, inMode) {
    var energyInfo = priceOfWithSource('energy', inMode);
    var header = [
      '=== Factory Production Profitability ===',
      '(out=' + outMode + ', in=' + inMode + ')',
      'Energy cost: ' + (energyInfo.price === null ? 'n/a' : fmt(energyInfo.price)) + ' [' + energyInfo.source + ']' +
        (energyInfo.source === 'MBUY' ? ' (marketBuy-style: competitive buy price)' : ''),
      'Legend: ✓=Actionable ~=Theoretical(uses HIST) ✗=Missing data',
      'Source: LIVE=real orders, MBUY=marketBuy pricing, HIST=historical avg',
      'Volume: Available units at shown price (for selling output)',
      '',
      [
        padRight('Item', 14),
        padRight('Sell@', 8),
        padRight('Src', 4),
        padRight('Volume', 8),
        padRight('Profit/u', 10),
        padRight('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        padRight(r.resource, 14),
        padLeft(fmt(r.unitPrice), 8),
        padRight(r.outputSource, 4),
        padLeft(fmtVol(r.outputVolume), 8),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8),
        padRight(r.actionable, 3)
      ].join(' '));
    }
    return lines.join('\n');
  }

  function buildDecompressionTable(rows, outMode, inMode) {
    var energyInfo = priceOfWithSource('energy', inMode);
    var header = [
      '=== Factory Decompression Profitability ===',
      'Buy bars (from ' + inMode + ' orders) -> Decompress -> Sell base resource (to ' + outMode + ' orders)',
      'Energy cost: ' + (energyInfo.price === null ? 'n/a' : fmt(energyInfo.price)) + ' [' + energyInfo.source + ']',
      'Formulas: 100 bar + 200 energy → 500 mineral | 1 battery → 50 energy',
      'Legend: ✓=Actionable ~=Theoretical ✗=Missing data',
      '',
      [
        padRight('Output', 8),
        padRight('Bar', 12),
        padRight('BarSrc', 6),
        padRight('BarVol', 8),
        padRight('Sell@', 8),
        padRight('Profit/u', 10),
        padRight('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        padRight(r.resource, 8),
        padRight(r.barName, 12),
        padRight(r.barSource, 6),
        padLeft(fmtVol(r.barVolume), 8),
        padLeft(fmt(r.unitPrice), 8),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8),
        padRight(r.actionable, 3)
      ].join(' '));
    }
    return lines.join('\n');
  }

  function buildLabTable(rows, outMode, inMode) {
    var header = [
      '=== Lab Production Profitability ===',
      '(out=' + outMode + ', in=' + inMode + ', batch=' + (typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5) + ')',
      'Legend: ✓=Actionable ~=Theoretical(uses HIST) ✗=Missing data',
      'Volume: Available units at shown price (for selling output)',
      '',
      [
        padRight('Compound', 10),
        padRight('Sell@', 8),
        padRight('Src', 4),
        padRight('Volume', 8),
        padRight('Profit/u', 10),
        padRight('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        padRight(r.resource, 10),
        padLeft(fmt(r.unitPrice), 8),
        padRight(r.outputSource, 4),
        padLeft(fmtVol(r.outputVolume), 8),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8),
        padRight(r.actionable, 3)
      ].join(' '));
    }
    return lines.join('\n');
  }

  function buildReverseReactionTableCompact(rows, reagentSellMode, compoundBuyMode) {
    var batch = typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5;
    var header = [
      '=== Reverse Reaction (Breakdown) Profitability ===',
      'Buy compound (from ' + compoundBuyMode + ' orders) -> reverseReaction -> Sell reagents (to ' + reagentSellMode + ' orders)',
      'Batch: ' + batch + ' | ✓=Actionable ~=Theoretical ✗=No data',
      'BuyVol: Compound units available to purchase',
      '',
      [
        padRight('Compound', 10),
        padRight('BuySrc', 6),
        padRight('BuyVol', 8),
        padRight('Reagents', 10),
        padRight('SellSrc', 7),
        padRight('Profit/u', 10),
        padRight('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var reagentStr = r.reagentA + '+' + r.reagentB;
      // Show worst source of the two reagents
      var sellSrc = 'LIVE';
      if (r.priceASource === 'MBUY' || r.priceBSource === 'MBUY') sellSrc = 'MBUY';
      if (r.priceASource === 'HIST' || r.priceBSource === 'HIST') sellSrc = 'HIST';
      if (r.priceASource === 'NONE' || r.priceBSource === 'NONE') sellSrc = 'NONE';
      
      lines.push([
        padRight(r.resource, 10),
        padRight(r.compoundSource, 6),
        padLeft(fmtVol(r.compoundVolume), 8),
        padRight(reagentStr, 10),
        padRight(sellSrc, 7),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8),
        padRight(r.actionable, 3)
      ].join(' '));
    }
    return lines.join('\n');
  }

  // ---------- time helpers ----------
  function getPacificTimeString() {
    var now = new Date();
    // Format in Pacific time
    try {
      return now.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      }) + ' PT';
    } catch (e) {
      // Fallback if toLocaleString with timeZone isn't supported
      // Manual PST/PDT offset calculation
      var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      // Check for DST (rough approximation: March-November)
      var month = now.getUTCMonth();
      var isDST = month >= 2 && month <= 10; // March (2) through November (10)
      var offset = isDST ? -7 : -8; // PDT = UTC-7, PST = UTC-8
      var pacific = new Date(utc + (3600000 * offset));
      var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var hours = pacific.getHours();
      var ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      if (hours === 0) hours = 12;
      var mins = pacific.getMinutes();
      var secs = pacific.getSeconds();
      return days[pacific.getDay()] + ', ' +
             months[pacific.getMonth()] + ' ' +
             pacific.getDate() + ', ' +
             pacific.getFullYear() + ', ' +
             hours + ':' + (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs + ' ' +
             ampm + ' ' + (isDST ? 'PDT' : 'PST');
    }
  }

  // ---------- global entry: main analysis ----------
  global.marketAnalysis = function(outputMode, inputMode) {
    var outMode = (outputMode || 'buy') + '';
    var inMode  = (inputMode  || 'sell') + '';

    // FACTORY PRODUCTION
    var factoryRows = [];
    for (var i = 0; i < FACTORY_TARGETS.length; i++) {
      var res = FACTORY_TARGETS[i];
      var row = analyzeFactoryCommodity(res, outMode, inMode);
      if (row && row.found) factoryRows.push(row);
    }
    factoryRows.sort(sortByMarginDescThenProfitDesc);

    // FACTORY DECOMPRESSION
    var decompressionRows = [];
    for (var d = 0; d < FACTORY_DECOMPRESSION_TARGETS.length; d++) {
      var baseRes = FACTORY_DECOMPRESSION_TARGETS[d];
      var dRow = analyzeFactoryDecompression(baseRes, outMode, inMode);
      if (dRow && dRow.found) decompressionRows.push(dRow);
    }
    decompressionRows.sort(sortByMarginDescThenProfitDesc);

    // LABS (production)
    var reactionPairs = buildReactionMap();
    var labList = listAllLabProducts(reactionPairs);
    var labRows = [];
    for (var j = 0; j < labList.length; j++) {
      var prod = labList[j];
      var lr = analyzeLabProduct(prod, reactionPairs, outMode, inMode);
      if (lr && lr.found) labRows.push(lr);
    }
    labRows.sort(sortByMarginDescThenProfitDesc);

    // REVERSE REACTIONS (breakdown)
    var reverseRows = [];
    for (var k = 0; k < labList.length; k++) {
      var compound = labList[k];
      var rr = analyzeReverseReaction(compound, reactionPairs, outMode, inMode);
      if (rr && rr.found) reverseRows.push(rr);
    }
    reverseRows.sort(sortByMarginDescThenProfitDesc);

    // Compose output
    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push(buildFactoryTable(factoryRows, outMode, inMode));
    parts.push('');
    parts.push(buildDecompressionTable(decompressionRows, outMode, inMode));
    parts.push('');
    parts.push(buildLabTable(labRows, outMode, inMode));
    parts.push('');
    parts.push(buildReverseReactionTableCompact(reverseRows, outMode, inMode));
    
    return parts.join('\n');
  };

  // ---------- global entry: decompression only ----------
  global.decompressionAnalysis = function(outputMode, inputMode) {
    var outMode = (outputMode || 'buy') + '';
    var inMode  = (inputMode  || 'sell') + '';

    var rows = [];
    for (var i = 0; i < FACTORY_DECOMPRESSION_TARGETS.length; i++) {
      var baseRes = FACTORY_DECOMPRESSION_TARGETS[i];
      var row = analyzeFactoryDecompression(baseRes, outMode, inMode);
      if (row && row.found) rows.push(row);
    }
    rows.sort(sortByMarginDescThenProfitDesc);

    // Split by profitability and actionability
    var actionable = [];
    var theoretical = [];
    var unprofitable = [];
    
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (r.profit !== null && r.profit > 0) {
        if (r.actionable === '✓') {
          actionable.push(r);
        } else {
          theoretical.push(r);
        }
      } else {
        unprofitable.push(r);
      }
    }

    var parts = [];
    
    // Header
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Factory Decompression Analysis ===');
    parts.push('Buy bars (from ' + inMode + ' orders) -> Decompress -> Sell base resource (to ' + outMode + ' orders)');
    parts.push('Formulas: 100 bar + 200 energy → 500 mineral | 1 battery → 50 energy');
    parts.push('');

    // Actionable profitable section
    if (actionable.length > 0) {
      parts.push('--- ✓ ACTIONABLE PROFITS (all prices from live orders) ---');
      parts.push([
        padRight('Output', 8),
        padRight('From Bar', 12),
        padRight('BarCost', 10),
        padRight('EnergyCost', 10),
        padRight('Revenue', 10),
        padRight('Profit', 10),
        padRight('Margin%', 8),
        padRight('BarVol', 8)
      ].join(' '));
      
      for (var a = 0; a < actionable.length; a++) {
        var r = actionable[a];
        var barCost = r.barPrice !== null ? r.barPrice * r.barQty : null;
        var energyCost = r.energyPrice !== null ? r.energyPrice * r.energyQty : null;
        parts.push([
          padRight(r.resource, 8),
          padRight(r.barName, 12),
          padLeft(fmt(barCost), 10),
          padLeft(fmt(energyCost), 10),
          padLeft(fmt(r.revenue), 10),
          padLeft('+' + fmt(r.profit), 10),
          padLeft(fmtShort(r.marginPct) + '%', 8),
          padLeft(fmtVol(r.barVolume), 8)
        ].join(' '));
      }
      parts.push('');
    }

    // Theoretical profitable section
    if (theoretical.length > 0) {
      parts.push('--- ~ THEORETICAL PROFITS (uses historical prices - verify orders exist!) ---');
      parts.push([
        padRight('Output', 8),
        padRight('From Bar', 12),
        padRight('Profit', 10),
        padRight('Margin%', 8),
        padRight('Warning', 35)
      ].join(' '));
      
      for (var t = 0; t < theoretical.length; t++) {
        var r = theoretical[t];
        var warning = r.warnings.length > 0 ? r.warnings[0] : '';
        parts.push([
          padRight(r.resource, 8),
          padRight(r.barName, 12),
          padLeft('+' + fmt(r.profit), 10),
          padLeft(fmtShort(r.marginPct) + '%', 8),
          padRight('⚠ ' + warning, 35)
        ].join(' '));
      }
      parts.push('');
    }
    
    if (actionable.length === 0 && theoretical.length === 0) {
      parts.push('--- No profitable decompression opportunities found ---');
      parts.push('');
    }

    // Unprofitable section (for reference)
    parts.push('--- UNPROFITABLE (for reference) ---');
    parts.push([
      padRight('Output', 8),
      padRight('From Bar', 12),
      padRight('Loss/batch', 12),
      padRight('Margin%', 8)
    ].join(' '));
    
    for (var u = 0; u < unprofitable.length; u++) {
      var r = unprofitable[u];
      parts.push([
        padRight(r.resource, 8),
        padRight(r.barName, 12),
        padLeft(fmt(r.profit), 12),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8)
      ].join(' '));
    }

    return parts.join('\n');
  };

  // ---------- global entry: analyze single decompression ----------
  global.analyzeDecompression = function(baseResource, outputMode, inputMode) {
    if (!baseResource) return 'Usage: analyzeDecompression("U") or analyzeDecompression("Z", "buy", "sell")';
    
    var outMode = (outputMode || 'buy') + '';
    var inMode  = (inputMode || 'sell') + '';
    
    var r = analyzeFactoryDecompression(baseResource, outMode, inMode);
    
    if (!r || !r.found) {
      return 'Error: ' + baseResource + ' is not a valid decompression target.\n' +
             'Valid targets: ' + FACTORY_DECOMPRESSION_TARGETS.join(', ');
    }
    
    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Decompression Analysis: ' + r.barName + ' → ' + r.resource + ' ===');
    parts.push('');
    parts.push('Input Bar: ' + r.barName);
    parts.push('  Buy price (' + inMode + '): ' + fmt(r.barPrice) + ' per unit [' + r.barSource + ']');
    parts.push('  Quantity needed: ' + r.barQty);
    parts.push('  Available volume: ' + fmtVol(r.barVolume) + ' (' + (r.barVolume || 0) + ' units)');
    parts.push('  Bar cost: ' + fmt(r.barPrice !== null ? r.barPrice * r.barQty : null));
    parts.push('');
    if (r.energyQty > 0) {
      parts.push('Energy Input:');
      parts.push('  Price (' + inMode + '): ' + fmt(r.energyPrice) + ' per unit [' + r.energySource + ']');
      parts.push('  Quantity needed: ' + r.energyQty);
      parts.push('  Energy cost: ' + fmt(r.energyPrice !== null ? r.energyPrice * r.energyQty : null));
      parts.push('');
    }
    parts.push('Total Input Cost: ' + fmt(r.inputCost));
    parts.push('');
    parts.push('Output: ' + r.resource);
    parts.push('  Quantity produced: ' + r.outQty);
    parts.push('  Sell price (' + outMode + '): ' + fmt(r.unitPrice) + ' per unit [' + r.outputSource + ']');
    parts.push('  Total revenue: ' + fmt(r.revenue));
    parts.push('  Available sell volume: ' + fmtVol(r.outputVolume));
    parts.push('');
    parts.push('Result:');
    parts.push('  Profit per batch: ' + fmt(r.profit));
    parts.push('  Profit per unit output: ' + fmt(r.profitPerUnit));
    parts.push('  Margin: ' + (r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%'));
    parts.push('  Actionable: ' + r.actionable);
    parts.push('');
    
    // Volume-limited profit calculation
    if (r.profit !== null && r.profit > 0 && r.barVolume > 0 && r.barQty > 0) {
      var maxBatches = Math.floor(r.barVolume / r.barQty);
      var maxProfit = maxBatches * r.profit;
      parts.push('Volume Analysis:');
      parts.push('  Max batches at this price: ' + maxBatches);
      parts.push('  Max total profit: ' + fmt(maxProfit) + ' credits');
      parts.push('');
    }
    
    if (r.warnings.length > 0) {
      parts.push('⚠ WARNINGS:');
      for (var w = 0; w < r.warnings.length; w++) {
        parts.push('  - ' + r.warnings[w]);
      }
      parts.push('');
    }
    
    if (r.profit !== null && r.profit > 0 && r.actionable === '✓') {
      parts.push('>>> ✓ ACTIONABLE - Execute decompression now! <<<');
    } else if (r.profit !== null && r.profit > 0) {
      parts.push('>>> ~ THEORETICAL PROFIT - Verify orders exist before acting! <<<');
    } else {
      parts.push('Not profitable at current prices.');
    }
    
    return parts.join('\n');
  };

  // ---------- global entry: reverse reaction only ----------
  global.reverseReactionAnalysis = function(reagentSellMode, compoundBuyMode) {
    var sellMode = (reagentSellMode || 'buy') + '';
    var buyMode  = (compoundBuyMode || 'sell') + '';

    var reactionPairs = buildReactionMap();
    var labList = listAllLabProducts(reactionPairs);
    
    var rows = [];
    for (var i = 0; i < labList.length; i++) {
      var compound = labList[i];
      var rr = analyzeReverseReaction(compound, reactionPairs, sellMode, buyMode);
      if (rr && rr.found) rows.push(rr);
    }
    rows.sort(sortByMarginDescThenProfitDesc);

    // Split by actionability
    var actionable = [];
    var theoretical = [];
    var unprofitable = [];
    
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (r.profit !== null && r.profit > 0) {
        if (r.actionable === '✓') {
          actionable.push(r);
        } else {
          theoretical.push(r);
        }
      } else {
        unprofitable.push(r);
      }
    }

    var parts = [];
    
    // Header
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Reverse Reaction Analysis ===');
    parts.push('Buy compound (from ' + buyMode + ' orders) -> Break down -> Sell reagents (to ' + sellMode + ' orders)');
    parts.push('Batch: ' + (typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5));
    parts.push('');

    // Actionable profitable section
    if (actionable.length > 0) {
      parts.push('--- ✓ ACTIONABLE PROFITS (all prices from live orders) ---');
      parts.push([
        padRight('Compound', 10),
        padRight('-> Reagents', 12),
        padRight('BuyCost', 10),
        padRight('SellRev', 10),
        padRight('Profit', 10),
        padRight('Margin%', 8),
        padRight('BuyVol', 8),
        padRight('SellVolA', 8),
        padRight('SellVolB', 8)
      ].join(' '));
      
      for (var a = 0; a < actionable.length; a++) {
        var r = actionable[a];
        parts.push([
          padRight(r.resource, 10),
          padRight(r.reagentA + '+' + r.reagentB, 12),
          padLeft(fmt(r.inputCost), 10),
          padLeft(fmt(r.revenue), 10),
          padLeft('+' + fmt(r.profit), 10),
          padLeft(fmtShort(r.marginPct) + '%', 8),
          padLeft(fmtVol(r.compoundVolume), 8),
          padLeft(fmtVol(r.priceAVolume), 8),
          padLeft(fmtVol(r.priceBVolume), 8)
        ].join(' '));
      }
      parts.push('');
    }

    // Theoretical profitable section
    if (theoretical.length > 0) {
      parts.push('--- ~ THEORETICAL PROFITS (uses historical prices - verify orders exist!) ---');
      parts.push([
        padRight('Compound', 10),
        padRight('-> Reagents', 12),
        padRight('Profit', 10),
        padRight('Margin%', 8),
        padRight('BuyVol', 8),
        padRight('Warning', 35)
      ].join(' '));
      
      for (var t = 0; t < theoretical.length; t++) {
        var r = theoretical[t];
        var warning = r.warnings.length > 0 ? r.warnings[0] : '';
        parts.push([
          padRight(r.resource, 10),
          padRight(r.reagentA + '+' + r.reagentB, 12),
          padLeft('+' + fmt(r.profit), 10),
          padLeft(fmtShort(r.marginPct) + '%', 8),
          padLeft(fmtVol(r.compoundVolume), 8),
          padRight('⚠ ' + warning, 35)
        ].join(' '));
      }
      parts.push('');
    }
    
    if (actionable.length === 0 && theoretical.length === 0) {
      parts.push('--- No profitable breakdown opportunities found ---');
      parts.push('');
    }

    // Top unprofitable (for reference)
    parts.push('--- TOP UNPROFITABLE (for reference, limit 10) ---');
    parts.push([
      padRight('Compound', 10),
      padRight('-> Reagents', 12),
      padRight('Loss/unit', 10),
      padRight('Margin%', 8)
    ].join(' '));
    
    var showCount = Math.min(10, unprofitable.length);
    for (var u = 0; u < showCount; u++) {
      var r = unprofitable[u];
      parts.push([
        padRight(r.resource, 10),
        padRight(r.reagentA + '+' + r.reagentB, 12),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8)
      ].join(' '));
    }

    return parts.join('\n');
  };

  // ---------- global entry: analyze single compound breakdown ----------
  global.analyzeBreakdown = function(compound, reagentSellMode, compoundBuyMode) {
    if (!compound) return 'Usage: analyzeBreakdown("XGH2O") or analyzeBreakdown("XGH2O", "buy", "sell")';
    
    var sellMode = (reagentSellMode || 'buy') + '';
    var buyMode  = (compoundBuyMode || 'sell') + '';
    
    var reactionPairs = buildReactionMap();
    var rr = analyzeReverseReaction(compound, reactionPairs, sellMode, buyMode);
    
    if (!rr || !rr.found) {
      return 'Error: ' + compound + ' is not a valid compound (cannot be broken down)';
    }
    
    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Breakdown Analysis: ' + compound + ' ===');
    parts.push('');
    parts.push('Compound: ' + compound);
    parts.push('  Buy price (' + buyMode + '): ' + fmt(rr.compoundPrice) + ' per unit [' + rr.compoundSource + ']');
    parts.push('  Available volume: ' + fmtVol(rr.compoundVolume) + ' (' + (rr.compoundVolume || 0) + ' units)');
    parts.push('  Buy cost (batch ' + rr.batch + '): ' + fmt(rr.inputCost));
    parts.push('');
    parts.push('Breaks down into:');
    parts.push('  ' + rr.reagentA + ': sell @ ' + fmt(rr.priceA) + ' [' + rr.priceASource + '] vol:' + fmtVol(rr.priceAVolume) + ' -> rev: ' + fmt(rr.revenueA));
    parts.push('  ' + rr.reagentB + ': sell @ ' + fmt(rr.priceB) + ' [' + rr.priceBSource + '] vol:' + fmtVol(rr.priceBVolume) + ' -> rev: ' + fmt(rr.revenueB));
    parts.push('  Total revenue: ' + fmt(rr.revenue));
    parts.push('');
    parts.push('Result:');
    parts.push('  Profit per batch: ' + fmt(rr.profit));
    parts.push('  Profit per unit: ' + fmt(rr.profitPerUnit));
    parts.push('  Margin: ' + (rr.marginPct === null ? 'n/a' : fmtShort(rr.marginPct) + '%'));
    parts.push('  Actionable: ' + rr.actionable);
    parts.push('');
    
    // Volume-limited profit calculation
    if (rr.profit !== null && rr.profit > 0 && rr.compoundVolume > 0) {
      var maxBatches = Math.floor(rr.compoundVolume / rr.batch);
      var maxProfit = maxBatches * rr.profit;
      parts.push('Volume Analysis:');
      parts.push('  Max batches at this price: ' + maxBatches);
      parts.push('  Max total profit: ' + fmt(maxProfit) + ' credits');
      parts.push('');
    }
    
    if (rr.warnings.length > 0) {
      parts.push('⚠ WARNINGS:');
      for (var w = 0; w < rr.warnings.length; w++) {
        parts.push('  - ' + rr.warnings[w]);
      }
      parts.push('');
    }
    
    if (rr.profit !== null && rr.profit > 0 && rr.actionable === '✓') {
      parts.push('>>> ✓ ACTIONABLE - Execute reverseReaction now! <<<');
    } else if (rr.profit !== null && rr.profit > 0) {
      parts.push('>>> ~ THEORETICAL PROFIT - Verify orders exist before acting! <<<');
    } else {
      parts.push('Not profitable at current prices.');
    }
    
    return parts.join('\n');
  };

  // ---------- global entry: order book viewer ----------
  global.orderBook = function(resource) {
    if (!resource) return 'Usage: orderBook("ZO") or orderBook("energy")';
    
    resource = resolveResource(resource);
    
    var sellInfo = getOrderInfo(resource, ORDER_SELL);
    var buyInfo = getOrderInfo(resource, ORDER_BUY);
    var histPrice = getAvg48h(resource);
    var marketBuyPrice = computeMarketBuyPrice(resource);
    
    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Order Book: ' + resource + ' ===');
    parts.push('');
    
    // Historical
    parts.push('Historical (48h avg): ' + (histPrice === null ? 'n/a' : fmt(histPrice)));
    parts.push('MarketBuy price: ' + fmt(marketBuyPrice.price) + ' [' + marketBuyPrice.source + ']');
    parts.push('  (This is what you\'d pay to acquire ' + resource + ' quickly via marketBuy strategy)');
    parts.push('');
    
    // Sell orders (what you can buy at)
    parts.push('--- SELL ORDERS (you can BUY at these prices) ---');
    parts.push('Count: ' + sellInfo.count + ' | Total volume: ' + fmtVol(sellInfo.totalVolume) + ' (' + sellInfo.totalVolume + ')');
    if (sellInfo.count > 0) {
      parts.push('Best (lowest): ' + fmt(sellInfo.bestPrice));
      parts.push('');
      parts.push([
        padRight('Price', 12),
        padRight('Available', 12),
        padRight('Room', 10)
      ].join(' '));
      var showSell = Math.min(10, sellInfo.orders.length);
      for (var s = 0; s < showSell; s++) {
        var o = sellInfo.orders[s];
        parts.push([
          padLeft(fmt(o.price), 12),
          padLeft(String(o.remainingAmount || o.amount), 12),
          padRight(o.roomName || 'N/A', 10)
        ].join(' '));
      }
    } else {
      parts.push('  No sell orders - cannot buy this resource!');
    }
    parts.push('');
    
    // Buy orders (what you can sell at)
    parts.push('--- BUY ORDERS (you can SELL at these prices) ---');
    parts.push('Count: ' + buyInfo.count + ' | Total volume: ' + fmtVol(buyInfo.totalVolume) + ' (' + buyInfo.totalVolume + ')');
    if (buyInfo.count > 0) {
      parts.push('Best (highest): ' + fmt(buyInfo.bestPrice));
      parts.push('');
      parts.push([
        padRight('Price', 12),
        padRight('Wanted', 12),
        padRight('Room', 10)
      ].join(' '));
      var showBuy = Math.min(10, buyInfo.orders.length);
      for (var b = 0; b < showBuy; b++) {
        var o = buyInfo.orders[b];
        parts.push([
          padLeft(fmt(o.price), 12),
          padLeft(String(o.remainingAmount || o.amount), 12),
          padRight(o.roomName || 'N/A', 10)
        ].join(' '));
      }
    } else {
      parts.push('  No buy orders - cannot sell this resource!');
    }
    parts.push('');
    
    // Spread analysis
    if (sellInfo.bestPrice !== null && buyInfo.bestPrice !== null) {
      var spread = sellInfo.bestPrice - buyInfo.bestPrice;
      var spreadPct = (spread / buyInfo.bestPrice) * 100;
      parts.push('--- SPREAD ANALYSIS ---');
      parts.push('Bid (buy order): ' + fmt(buyInfo.bestPrice));
      parts.push('Ask (sell order): ' + fmt(sellInfo.bestPrice));
      parts.push('Spread: ' + fmt(spread) + ' (' + fmtShort(spreadPct) + '%)');
      if (spreadPct > 100) {
        parts.push('⚠ HUGE SPREAD - Market is illiquid or has stale orders!');
      }
    }
    
    return parts.join('\n');
  };

  // ---------- global entry: get energy cost using marketBuy strategy ----------
  global.energyCost = function() {
    var info = computeMarketBuyPrice(RESOURCE_ENERGY);
    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Energy Cost (marketBuy strategy) ===');
    parts.push('');
    parts.push('Price: ' + fmt(info.price) + ' credits/energy');
    parts.push('Source: ' + info.source);
    parts.push('');
    if (info.source === 'MBUY') {
      parts.push('Calculated as: highest external BUY order (with ≥1000 remaining) + 0.1');
      parts.push('This represents the competitive price to outbid existing buyers.');
      parts.push('Orders found: ' + info.orderCount + ' | Volume: ' + fmtVol(info.volume) + ' (' + info.volume + ')');
    } else {
      parts.push('No suitable BUY orders found (need ≥1000 remaining).');
      parts.push('Fell back to 95% of 48h average price.');
    }
    return parts.join('\n');
  };

})();