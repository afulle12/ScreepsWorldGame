// marketAnalysis.js
// Factory, Lab, and Reverse Reaction profitability tables using live market data.
//
// IMPORTANT
// - No optional chaining (Screeps runtime limitation).
// - Output is returned as a single formatted string (no console.log here).
// - Recipes come from COMMODITIES (factory) and REACTIONS (labs). Batch size for
//   labs uses LAB_REACTION_AMOUNT. Costs/revenues are immediate (non-recursive).
//
// PRICING (matches autoTrader.js):
// - ACTUAL_BUY  (inputs/costs):   best external BUY order + 0.1, fallback hist*0.95
//                                  Mirrors marketBuy.computeBuyPrice()
// - ACTUAL_SELL (outputs/revenue): best external SELL order - 0.1, capped at hist*1.5,
//                                  fallback hist*1.05
//                                  Mirrors marketSell.computePrice()
// This means margin numbers here will match what autoTrader.js uses to decide whether
// to start a job, and represent prices achievable by actually posting orders.
//
// VERSION 3.0 CHANGES FROM 2.3:
// - Replaced raw order-book pricing with actual execution pricing (ACTUAL_BUY / ACTUAL_SELL)
// - Inputs now priced at best-BUY+0.1 (what you'd pay via marketBuy)
// - Outputs now priced at best-SELL-0.1 capped at 1.5x avg (what you'd get via marketSell)
// - Default modes updated to ACTUAL_SELL/ACTUAL_BUY across all entry points
// - Source indicators updated: ABUY = actual buy price, ASELL = actual sell price
// - Legacy 'buy'/'sell'/'avg' modes still work for manual override comparisons
//
// Usage (console):
//   console.log(marketAnalysis());            // default: accurate execution prices
//   console.log(marketAnalysis('avg','avg')); // both sides 48h volume-weighted avg
//   console.log(marketAnalysis('sell','sell'));
//
//   console.log(reverseReactionAnalysis());
//   console.log(decompressionAnalysis());
//   console.log(orderBook('ZO'));
//   console.log(analyzeBreakdown('XGH2O'));
//   console.log(analyzeDecompression('U'));
//
// Price Source Indicators:
//   ASELL = Actual sell price (best SELL order - 0.1, capped; mirrors marketSell)
//   ABUY  = Actual buy price  (best BUY order + 0.1; mirrors marketBuy)
//   LIVE  = Raw best order price (legacy modes)
//   HIST  = 48h historical average (fallback)
//   NONE  = No price data available
//
// Actionable Indicators:
//   ✓ = Both sides have live orders - can execute now
//   ~ = One side uses historical price - may not be achievable
//   ✗ = Missing critical price data

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
  function padLeft(s, w)  { s = String(s); while (s.length < w) s = ' ' + s; return s; }

  function fmtVol(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
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

  function resolveResource(input) {
    if (typeof input !== 'string') return input;
    if (typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(input) !== -1) return input;
    var maybeConst = global[input];
    if (typeof maybeConst === 'string' && typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(maybeConst) !== -1) return maybeConst;
    var lower = input.toLowerCase();
    if (typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(lower) !== -1) return lower;
    return input;
  }

  // ---------- order book helpers ----------

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

  function getMyRooms() {
    var myRooms = {};
    for (var rn in Game.rooms) {
      var r = Game.rooms[rn];
      if (r && r.controller && r.controller.my) myRooms[rn] = true;
    }
    return myRooms;
  }

  // ---------- accurate pricing (matches autoTrader.js) ----------

  /**
   * Price you'd actually pay when buying via marketBuy:
   * best external BUY order + 0.1, fallback hist * 0.95.
   * Mirrors marketBuy.computeBuyPrice().
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

    var totalVolume = 0;
    for (var j = 0; j < validOrders.length; j++) totalVolume += validOrders[j].remainingAmount || 0;

    if (validOrders.length > 0) {
      return {
        price: Math.max(validOrders[0].price + 0.1, 0.001),
        source: 'ABUY',
        orderCount: validOrders.length,
        volume: totalVolume
      };
    }

    var hist = Game.market.getHistory(resourceType) || [];
    var count = 0, sum = 0;
    if (hist.length >= 1 && typeof hist[hist.length - 1].avgPrice === 'number') { sum += hist[hist.length - 1].avgPrice; count++; }
    if (hist.length >= 2 && typeof hist[hist.length - 2].avgPrice === 'number') { sum += hist[hist.length - 2].avgPrice; count++; }
    var avg = count > 0 ? sum / count : 1;
    return { price: Math.max(avg * 0.95, 0.001), source: 'HIST', orderCount: 0, volume: 0 };
  }

  /**
   * Price you'd actually receive when selling via marketSell:
   * best external SELL order - 0.1, capped at hist * 1.5, fallback hist * 1.05.
   * Mirrors marketSell.computePrice().
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
      return {
        price: Math.max(Math.min(p, avg * 1.5), 0.001),
        source: 'ASELL',
        orderCount: validOrders.length,
        volume: validOrders.reduce(function(acc, o) { return acc + (o.remainingAmount || 0); }, 0)
      };
    }

    return { price: Math.max(avg * 1.05, 0.001), source: 'HIST', orderCount: 0, volume: 0 };
  }

  // Legacy helper kept for orderBook display and backward-compat modes
  function computeMarketBuyPrice(resourceType) {
    return computeActualBuyPrice(resourceType);
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

  /**
   * Unified pricing gateway.
   *
   * Modes:
   *   'ACTUAL_SELL' - accurate sell revenue  (use for outputs)
   *   'ACTUAL_BUY'  - accurate buy cost      (use for inputs)
   *   'buy'         - raw best buy-order price  (legacy)
   *   'sell'        - raw best sell-order price (legacy)
   *   'avg'         - 48h historical average    (legacy)
   */
  function priceOfWithSource(resource, mode) {
    resource = resolveResource(resource);

    if (mode === 'ACTUAL_SELL') return computeActualSellPrice(resource);
    if (mode === 'ACTUAL_BUY')  return computeActualBuyPrice(resource);

    // Legacy: energy as input cost uses accurate buy price
    if (resource === RESOURCE_ENERGY && mode === 'sell') return computeActualBuyPrice(resource);

    if (mode === 'avg') {
      var avg = getAvg48h(resource);
      if (avg !== null) return { price: avg, source: 'HIST', orderCount: 0, volume: 0 };
      var si = getOrderInfo(resource, ORDER_SELL);
      if (si.bestPrice !== null) return { price: si.bestPrice, source: 'LIVE', orderCount: si.count, volume: si.totalVolume };
      return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }

    if (mode === 'buy' || mode === 'sell') {
      var oi = getOrderInfo(resource, mode === 'buy' ? ORDER_BUY : ORDER_SELL);
      if (oi.bestPrice !== null) return { price: oi.bestPrice, source: 'LIVE', orderCount: oi.count, volume: oi.totalVolume };
      var hp = getAvg48h(resource);
      if (hp !== null) return { price: hp, source: 'HIST', orderCount: 0, volume: 0 };
      return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
    }

    return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
  }

  // Helper: is a source considered "live" for actionability?
  function isLiveSource(source) {
    return source === 'LIVE' || source === 'ABUY' || source === 'ASELL';
  }

  // ---------- factory production ----------

  function analyzeFactoryCommodity(resource, outputMode, inputMode) {
    var recipe = COMMODITIES && COMMODITIES[resource];
    if (!recipe) return { resource: resource, found: false };

    var outQty = number(recipe.amount) > 0 ? number(recipe.amount) : 1;
    var comps = recipe.components || {};
    var totalCost = 0;
    var allInputsLive = true;

    for (var res in comps) {
      if (!comps.hasOwnProperty(res)) continue;
      var qty = number(comps[res]);
      var pi = priceOfWithSource(res, inputMode);
      totalCost += pi.price === null ? 0 : pi.price * qty;
      if (!isLiveSource(pi.source)) allInputsLive = false;
    }

    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : revenue - totalCost;
    var profitPerUnit = profit === null ? null : profit / outQty;
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);

    var actionable = outputInfo.price !== null ? (isLiveSource(outputInfo.source) && allInputsLive ? '✓' : '~') : '✗';

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

  function analyzeFactoryDecompression(baseResource, outputMode, inputMode) {
    var recipe = COMMODITIES && COMMODITIES[baseResource];
    var outQty, components, barName;

    if (recipe && recipe.components) {
      outQty = number(recipe.amount) > 0 ? number(recipe.amount) : 1;
      components = recipe.components;
      barName = DECOMPRESSION_BAR_MAP[baseResource];
    } else {
      barName = DECOMPRESSION_BAR_MAP[baseResource];
      if (!barName) return { resource: baseResource, found: false };
      if (baseResource === 'energy') {
        outQty = 50; components = { 'battery': 1 };
      } else {
        outQty = 500; components = {}; components[barName] = 100; components['energy'] = 200;
      }
    }
    if (!barName) return { resource: baseResource, found: false };

    var totalCost = 0;
    var allInputsLive = true;
    var barInfo = null, energyInfo = null;

    for (var res in components) {
      if (!components.hasOwnProperty(res)) continue;
      var qty = number(components[res]);
      var pi = priceOfWithSource(res, inputMode);
      totalCost += pi.price === null ? 0 : pi.price * qty;
      if (res === barName) barInfo = pi;
      else if (res === 'energy') energyInfo = pi;
      if (!isLiveSource(pi.source)) allInputsLive = false;
    }

    var outputInfo = priceOfWithSource(baseResource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : revenue - totalCost;
    var profitPerUnit = profit === null ? null : profit / outQty;
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);

    var actionable = outputInfo.price !== null ? (isLiveSource(outputInfo.source) && allInputsLive ? '✓' : '~') : '✗';

    var warnings = [];
    if (barInfo && !isLiveSource(barInfo.source))   warnings.push('No orders for ' + barName + ' (using hist)');
    if (energyInfo && !isLiveSource(energyInfo.source)) warnings.push('Energy using historical price');
    if (!isLiveSource(outputInfo.source))           warnings.push('No orders for ' + baseResource + ' (using hist)');

    return {
      resource: baseResource, found: true,
      barName: barName, outQty: outQty,
      barQty: components[barName] || 0,
      energyQty: components['energy'] || 0,
      barPrice: barInfo ? barInfo.price : null,
      barSource: barInfo ? barInfo.source : 'NONE',
      barVolume: barInfo ? barInfo.volume : 0,
      energyPrice: energyInfo ? energyInfo.price : null,
      energySource: energyInfo ? energyInfo.source : 'NONE',
      inputCost: totalCost, unitPrice: unitPrice,
      outputSource: outputInfo.source, outputVolume: outputInfo.volume,
      revenue: revenue, profit: profit, profitPerUnit: profitPerUnit, marginPct: marginPct,
      allInputsLive: allInputsLive, actionable: actionable, warnings: warnings
    };
  }

  // ---------- lab production ----------

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

  function listAllLabProducts(reactionPairs) {
    var arr = [];
    for (var p in reactionPairs) if (reactionPairs.hasOwnProperty(p)) arr.push(p);
    arr.sort();
    return arr;
  }

  function analyzeLabProduct(resource, reactionPairs, outputMode, inputMode) {
    var pair = reactionPairs[resource];
    if (!pair) return { resource: resource, found: false };
    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;

    var a = pair[0], b = pair[1];
    var paInfo = priceOfWithSource(a, inputMode);
    var pbInfo = priceOfWithSource(b, inputMode);
    var totalCost = (paInfo.price === null ? 0 : paInfo.price * batch) +
                    (pbInfo.price === null ? 0 : pbInfo.price * batch);
    var allInputsLive = isLiveSource(paInfo.source) && isLiveSource(pbInfo.source);

    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice === null ? null : unitPrice * batch;
    var profit = revenue === null ? null : revenue - totalCost;
    var profitPerUnit = profit === null ? null : profit / batch;
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);

    var actionable = outputInfo.price !== null ? (isLiveSource(outputInfo.source) && allInputsLive ? '✓' : '~') : '✗';

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

  // ---------- reverse reactions ----------

  function analyzeReverseReaction(compound, reactionPairs, reagentSellMode, compoundBuyMode) {
    var pair = reactionPairs[compound];
    if (!pair) return { resource: compound, found: false };

    var batch = typeof LAB_REACTION_AMOUNT === 'number' && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    var reagentA = pair[0], reagentB = pair[1];

    // Cost: buying the compound
    var compoundInfo = priceOfWithSource(compound, compoundBuyMode);
    var compoundPrice = compoundInfo.price;
    var totalCost = compoundPrice === null ? null : compoundPrice * batch;

    // Revenue: selling the reagents
    var priceAInfo = priceOfWithSource(reagentA, reagentSellMode);
    var priceBInfo = priceOfWithSource(reagentB, reagentSellMode);
    var priceA = priceAInfo.price, priceB = priceBInfo.price;

    var revenueA = priceA === null ? null : priceA * batch;
    var revenueB = priceB === null ? null : priceB * batch;
    var totalRevenue = (revenueA !== null && revenueB !== null) ? revenueA + revenueB
                     : (revenueA !== null ? revenueA : revenueB);

    var profit = totalRevenue !== null && totalCost !== null ? totalRevenue - totalCost : null;
    var profitPerUnit = profit === null ? null : profit / batch;
    var marginPct = profit !== null && totalCost !== null && totalCost > 0 ? (profit / totalCost) * 100 : null;

    var compoundLive = isLiveSource(compoundInfo.source);
    var reagentALive = isLiveSource(priceAInfo.source);
    var reagentBLive = isLiveSource(priceBInfo.source);

    var actionable = '✗';
    var warnings = [];

    if (compoundLive && reagentALive && reagentBLive) {
      actionable = '✓';
    } else if (compoundPrice !== null && (priceA !== null || priceB !== null)) {
      actionable = '~';
    }

    if (!compoundLive && compoundInfo.source === 'HIST') warnings.push('No orders for ' + compound + ' (using hist)');
    if (!reagentALive && priceAInfo.source === 'HIST')   warnings.push('No orders for ' + reagentA + ' (using hist)');
    if (!reagentBLive && priceBInfo.source === 'HIST')   warnings.push('No orders for ' + reagentB + ' (using hist)');

    return {
      resource: compound, found: true,
      reagentA: reagentA, reagentB: reagentB, batch: batch,
      compoundPrice: compoundPrice, compoundSource: compoundInfo.source, compoundVolume: compoundInfo.volume,
      priceA: priceA, priceASource: priceAInfo.source, priceAVolume: priceAInfo.volume,
      priceB: priceB, priceBSource: priceBInfo.source, priceBVolume: priceBInfo.volume,
      inputCost: totalCost, revenueA: revenueA, revenueB: revenueB, revenue: totalRevenue,
      profit: profit, profitPerUnit: profitPerUnit, marginPct: marginPct,
      actionable: actionable, warnings: warnings
    };
  }

  // ---------- tables ----------

  function buildFactoryTable(rows, outMode, inMode) {
    var energyInfo = priceOfWithSource('energy', inMode);
    var header = [
      '=== Factory Production Profitability ===',
      '(out=' + outMode + ', in=' + inMode + ')',
      'Energy cost: ' + (energyInfo.price === null ? 'n/a' : fmt(energyInfo.price)) + ' [' + energyInfo.source + ']',
      'Pricing: ASELL=actual sell (best ask-0.1), ABUY=actual buy (best bid+0.1), HIST=48h avg fallback',
      'Legend: ✓=Actionable ~=Theoretical(HIST price used) ✗=Missing data',
      '',
      [
        padRight('Item', 14),
        padLeft('Sell@', 8),
        padRight('Src', 6),
        padLeft('Volume', 8),
        padLeft('Profit/u', 10),
        padLeft('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        padRight(r.resource, 14),
        padLeft(fmt(r.unitPrice), 8),
        padRight(r.outputSource, 6),
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
      'Buy bars (' + inMode + ') -> Decompress -> Sell base resource (' + outMode + ')',
      'Energy cost: ' + (energyInfo.price === null ? 'n/a' : fmt(energyInfo.price)) + ' [' + energyInfo.source + ']',
      'Formulas: 100 bar + 200 energy → 500 mineral | 1 battery → 50 energy',
      'Legend: ✓=Actionable ~=Theoretical ✗=Missing data',
      '',
      [
        padRight('Output', 8),
        padRight('Bar', 12),
        padRight('BarSrc', 7),
        padLeft('BarVol', 8),
        padLeft('Sell@', 8),
        padLeft('Profit/u', 10),
        padLeft('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        padRight(r.resource, 8),
        padRight(r.barName, 12),
        padRight(r.barSource, 7),
        padLeft(fmtVol(r.barVolume), 8),
        padLeft(fmt(r.unitPrice), 8),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8),
        padRight(r.actionable, 3)
      ].join(' '));
    }
    return lines.join('\n');
  }

  function buildLabTable(rows, outMode, inMode, circularSet) {
    circularSet = circularSet || {};
    var header = [
      '=== Lab Production Profitability ===',
      '(out=' + outMode + ', in=' + inMode + ', batch=' + (typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5) + ')',
      'Legend: ✓=Actionable ~=Theoretical ✗=Missing data  ⇄=CIRCULAR (reverse also profitable — large spread)',
      '',
      [
        padRight('Compound', 10),
        padLeft('Sell@', 8),
        padRight('Src', 6),
        padLeft('Volume', 8),
        padLeft('Profit/u', 10),
        padLeft('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var circularFlag = circularSet[r.resource] ? ' ⇄' : '';
      lines.push([
        padRight(r.resource, 10),
        padLeft(fmt(r.unitPrice), 8),
        padRight(r.outputSource, 6),
        padLeft(fmtVol(r.outputVolume), 8),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8),
        padRight(r.actionable, 3)
      ].join(' ') + circularFlag);
    }
    return lines.join('\n');
  }

  function buildReverseReactionTableCompact(rows, reagentSellMode, compoundBuyMode, circularSet) {
    circularSet = circularSet || {};
    var batch = typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5;
    var header = [
      '=== Reverse Reaction (Breakdown) Profitability ===',
      'Buy compound (' + compoundBuyMode + ') -> reverseReaction -> Sell reagents (' + reagentSellMode + ')',
      'Batch: ' + batch + ' | ✓=Actionable ~=Theoretical ✗=No data  ⇄=CIRCULAR (forward also profitable — large spread)',
      'BuyVol: Compound units available to purchase',
      '',
      [
        padRight('Compound', 10),
        padRight('BuySrc', 7),
        padLeft('BuyVol', 8),
        padRight('Reagents', 12),
        padRight('SellSrc', 8),
        padLeft('Profit/u', 10),
        padLeft('Margin%', 8),
        padRight('Act', 3)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var reagentStr = r.reagentA + '+' + r.reagentB;
      // Worst sell source across the two reagents
      var sellSrc = 'ASELL';
      if (r.priceASource === 'HIST' || r.priceBSource === 'HIST') sellSrc = 'HIST';
      if (r.priceASource === 'NONE' || r.priceBSource === 'NONE') sellSrc = 'NONE';
      var circularFlag = circularSet[r.resource] ? ' ⇄' : '';

      lines.push([
        padRight(r.resource, 10),
        padRight(r.compoundSource, 7),
        padLeft(fmtVol(r.compoundVolume), 8),
        padRight(reagentStr, 12),
        padRight(sellSrc, 8),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8),
        padRight(r.actionable, 3)
      ].join(' ') + circularFlag);
    }
    return lines.join('\n');
  }

  // ---------- time helpers ----------

  function getPacificTimeString() {
    var now = new Date();
    try {
      return now.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
      }) + ' PT';
    } catch (e) {
      var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      var month = now.getUTCMonth();
      var isDST = month >= 2 && month <= 10;
      var offset = isDST ? -7 : -8;
      var pacific = new Date(utc + (3600000 * offset));
      var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var hours = pacific.getHours();
      var ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12; if (hours === 0) hours = 12;
      var mins = pacific.getMinutes(), secs = pacific.getSeconds();
      return days[pacific.getDay()] + ', ' + months[pacific.getMonth()] + ' ' +
             pacific.getDate() + ', ' + pacific.getFullYear() + ', ' +
             hours + ':' + (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs +
             ' ' + ampm + ' ' + (isDST ? 'PDT' : 'PST');
    }
  }

  // ---------- global entry: main analysis ----------

  global.marketAnalysis = function(outputMode, inputMode) {
    // Default to accurate execution prices matching autoTrader.js
    var outMode = outputMode || 'ACTUAL_SELL';
    var inMode  = inputMode  || 'ACTUAL_BUY';

    var reactionPairs = buildReactionMap();
    var labList = listAllLabProducts(reactionPairs);

    var factoryRows = [];
    for (var i = 0; i < FACTORY_TARGETS.length; i++) {
      var row = analyzeFactoryCommodity(FACTORY_TARGETS[i], outMode, inMode);
      if (row && row.found) factoryRows.push(row);
    }
    factoryRows.sort(sortByMarginDescThenProfitDesc);

    var decompressionRows = [];
    for (var d = 0; d < FACTORY_DECOMPRESSION_TARGETS.length; d++) {
      var dRow = analyzeFactoryDecompression(FACTORY_DECOMPRESSION_TARGETS[d], outMode, inMode);
      if (dRow && dRow.found) decompressionRows.push(dRow);
    }
    decompressionRows.sort(sortByMarginDescThenProfitDesc);

    var labRows = [];
    for (var j = 0; j < labList.length; j++) {
      var lr = analyzeLabProduct(labList[j], reactionPairs, outMode, inMode);
      if (lr && lr.found) labRows.push(lr);
    }
    labRows.sort(sortByMarginDescThenProfitDesc);

    var reverseRows = [];
    for (var k = 0; k < labList.length; k++) {
      var rr = analyzeReverseReaction(labList[k], reactionPairs, outMode, inMode);
      if (rr && rr.found) reverseRows.push(rr);
    }
    reverseRows.sort(sortByMarginDescThenProfitDesc);

    // Identify compounds that are profitable in BOTH forward (lab production) AND reverse
    // simultaneously. This is a sign of a large bid-ask spread, not a genuine two-way
    // arbitrage — autoTrader will only pick the higher-margin direction. Flag them here
    // so the analysis output is not misleading.
    var profitableForward = {};
    for (var pf = 0; pf < labRows.length; pf++) {
      if (labRows[pf].profit !== null && labRows[pf].profit > 0) profitableForward[labRows[pf].resource] = true;
    }
    var profitableReverse = {};
    for (var pr = 0; pr < reverseRows.length; pr++) {
      if (reverseRows[pr].profit !== null && reverseRows[pr].profit > 0) profitableReverse[reverseRows[pr].resource] = true;
    }
    var circularSet = {};
    for (var cr in profitableForward) {
      if (profitableReverse[cr]) circularSet[cr] = true;
    }

    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('Pricing model: ACTUAL_SELL (best ask-0.1) / ACTUAL_BUY (best bid+0.1) — matches autoTrader.js');
    parts.push('');
    parts.push(buildFactoryTable(factoryRows, outMode, inMode));
    parts.push('');
    parts.push(buildDecompressionTable(decompressionRows, outMode, inMode));
    parts.push('');
    parts.push(buildLabTable(labRows, outMode, inMode, circularSet));
    parts.push('');
    parts.push(buildReverseReactionTableCompact(reverseRows, outMode, inMode, circularSet));

    // Circular warning section
    var circularKeys = Object.keys(circularSet).sort();
    if (circularKeys.length > 0) {
      parts.push('');
      parts.push('=== ⇄ CIRCULAR WARNINGS ===');
      parts.push('These compounds appear profitable in BOTH forward AND reverse directions.');
      parts.push('This is caused by a large bid-ask spread, not a genuine two-way opportunity.');
      parts.push('autoTrader will only start the higher-margin direction and suppress the other.');
      parts.push('');
      parts.push([
        padRight('Compound', 10),
        padLeft('Fwd margin', 11),
        padLeft('Rev margin', 11),
        padLeft('Bid(compound)', 14),
        padLeft('Ask(compound)', 14)
      ].join(' '));

      for (var ci = 0; ci < circularKeys.length; ci++) {
        var ck = circularKeys[ci];
        // Find matching rows
        var fwdRow = null, revRow = null;
        for (var fi2 = 0; fi2 < labRows.length; fi2++) { if (labRows[fi2].resource === ck) { fwdRow = labRows[fi2]; break; } }
        for (var ri2 = 0; ri2 < reverseRows.length; ri2++) { if (reverseRows[ri2].resource === ck) { revRow = reverseRows[ri2]; break; } }
        var fwdMargin = fwdRow && fwdRow.marginPct !== null ? fmtShort(fwdRow.marginPct) + '%' : 'n/a';
        var revMargin = revRow && revRow.marginPct !== null ? fmtShort(revRow.marginPct) + '%' : 'n/a';
        // bid = ACTUAL_BUY price = what revRow used as cost
        var bidPrice = revRow && revRow.compoundPrice !== null ? fmt(revRow.compoundPrice) : 'n/a';
        // ask = ACTUAL_SELL price = what fwdRow used as revenue
        var askPrice = fwdRow && fwdRow.unitPrice !== null ? fmt(fwdRow.unitPrice) : 'n/a';
        parts.push([
          padRight(ck, 10),
          padLeft(fwdMargin, 11),
          padLeft(revMargin, 11),
          padLeft(bidPrice, 14),
          padLeft(askPrice, 14)
        ].join(' '));
      }
    }

    return parts.join('\n');
  };

  // ---------- global entry: reverse reaction only ----------

  global.reverseReactionAnalysis = function(reagentSellMode, compoundBuyMode) {
    // Default: sell reagents at actual sell price, buy compound at actual buy price
    var sellMode = reagentSellMode || 'ACTUAL_SELL';
    var buyMode  = compoundBuyMode  || 'ACTUAL_BUY';

    var reactionPairs = buildReactionMap();
    var labList = listAllLabProducts(reactionPairs);

    var rows = [];
    for (var i = 0; i < labList.length; i++) {
      var rr = analyzeReverseReaction(labList[i], reactionPairs, sellMode, buyMode);
      if (rr && rr.found) rows.push(rr);
    }
    rows.sort(sortByMarginDescThenProfitDesc);

    var actionable = [], theoretical = [], unprofitable = [];
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (r.profit !== null && r.profit > 0) {
        if (r.actionable === '✓') actionable.push(r); else theoretical.push(r);
      } else { unprofitable.push(r); }
    }

    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('Pricing model: ACTUAL_SELL (best ask-0.1) / ACTUAL_BUY (best bid+0.1)');
    parts.push('');
    parts.push('=== Reverse Reaction Analysis ===');
    parts.push('Buy compound (' + buyMode + ') -> Break down -> Sell reagents (' + sellMode + ')');
    parts.push('Batch: ' + (typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5));
    parts.push('');

    if (actionable.length > 0) {
      parts.push('--- ✓ ACTIONABLE PROFITS ---');
      parts.push([
        padRight('Compound', 10), padRight('-> Reagents', 12),
        padLeft('BuyCost', 10), padLeft('SellRev', 10), padLeft('Profit', 10),
        padLeft('Margin%', 8), padLeft('BuyVol', 8), padLeft('SellVolA', 9), padLeft('SellVolB', 9)
      ].join(' '));
      for (var a = 0; a < actionable.length; a++) {
        var r = actionable[a];
        parts.push([
          padRight(r.resource, 10), padRight(r.reagentA + '+' + r.reagentB, 12),
          padLeft(fmt(r.inputCost), 10), padLeft(fmt(r.revenue), 10),
          padLeft('+' + fmt(r.profit), 10), padLeft(fmtShort(r.marginPct) + '%', 8),
          padLeft(fmtVol(r.compoundVolume), 8),
          padLeft(fmtVol(r.priceAVolume), 9), padLeft(fmtVol(r.priceBVolume), 9)
        ].join(' '));
      }
      parts.push('');
    }

    if (theoretical.length > 0) {
      parts.push('--- ~ THEORETICAL PROFITS (uses historical fallback prices) ---');
      parts.push([
        padRight('Compound', 10), padRight('-> Reagents', 12),
        padLeft('Profit', 10), padLeft('Margin%', 8), padLeft('BuyVol', 8), padRight('Warning', 40)
      ].join(' '));
      for (var t = 0; t < theoretical.length; t++) {
        var r = theoretical[t];
        parts.push([
          padRight(r.resource, 10), padRight(r.reagentA + '+' + r.reagentB, 12),
          padLeft('+' + fmt(r.profit), 10), padLeft(fmtShort(r.marginPct) + '%', 8),
          padLeft(fmtVol(r.compoundVolume), 8),
          padRight('⚠ ' + (r.warnings[0] || ''), 40)
        ].join(' '));
      }
      parts.push('');
    }

    if (actionable.length === 0 && theoretical.length === 0) {
      parts.push('--- No profitable breakdown opportunities found ---');
      parts.push('');
    }

    parts.push('--- TOP UNPROFITABLE (limit 10) ---');
    parts.push([
      padRight('Compound', 10), padRight('-> Reagents', 12),
      padLeft('Loss/unit', 10), padLeft('Margin%', 8)
    ].join(' '));
    var showCount = Math.min(10, unprofitable.length);
    for (var u = 0; u < showCount; u++) {
      var r = unprofitable[u];
      parts.push([
        padRight(r.resource, 10), padRight(r.reagentA + '+' + r.reagentB, 12),
        padLeft(fmt(r.profitPerUnit), 10),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8)
      ].join(' '));
    }
    return parts.join('\n');
  };

  // ---------- global entry: decompression only ----------

  global.decompressionAnalysis = function(outputMode, inputMode) {
    var outMode = outputMode || 'ACTUAL_SELL';
    var inMode  = inputMode  || 'ACTUAL_BUY';

    var rows = [];
    for (var i = 0; i < FACTORY_DECOMPRESSION_TARGETS.length; i++) {
      var row = analyzeFactoryDecompression(FACTORY_DECOMPRESSION_TARGETS[i], outMode, inMode);
      if (row && row.found) rows.push(row);
    }
    rows.sort(sortByMarginDescThenProfitDesc);

    var actionable = [], theoretical = [], unprofitable = [];
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (r.profit !== null && r.profit > 0) {
        if (r.actionable === '✓') actionable.push(r); else theoretical.push(r);
      } else { unprofitable.push(r); }
    }

    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('Pricing model: ACTUAL_SELL (best ask-0.1) / ACTUAL_BUY (best bid+0.1)');
    parts.push('');
    parts.push('=== Factory Decompression Analysis ===');
    parts.push('Buy bars (' + inMode + ') -> Decompress -> Sell base resource (' + outMode + ')');
    parts.push('Formulas: 100 bar + 200 energy → 500 mineral | 1 battery → 50 energy');
    parts.push('');

    if (actionable.length > 0) {
      parts.push('--- ✓ ACTIONABLE PROFITS ---');
      parts.push([
        padRight('Output', 8), padRight('From Bar', 12),
        padLeft('BarCost', 10), padLeft('EnergyCost', 11),
        padLeft('Revenue', 10), padLeft('Profit', 10),
        padLeft('Margin%', 8), padLeft('BarVol', 8)
      ].join(' '));
      for (var a = 0; a < actionable.length; a++) {
        var r = actionable[a];
        parts.push([
          padRight(r.resource, 8), padRight(r.barName, 12),
          padLeft(fmt(r.barPrice !== null ? r.barPrice * r.barQty : null), 10),
          padLeft(fmt(r.energyPrice !== null ? r.energyPrice * r.energyQty : null), 11),
          padLeft(fmt(r.revenue), 10),
          padLeft('+' + fmt(r.profit), 10),
          padLeft(fmtShort(r.marginPct) + '%', 8),
          padLeft(fmtVol(r.barVolume), 8)
        ].join(' '));
      }
      parts.push('');
    }

    if (theoretical.length > 0) {
      parts.push('--- ~ THEORETICAL PROFITS (historical fallback prices) ---');
      parts.push([
        padRight('Output', 8), padRight('From Bar', 12),
        padLeft('Profit', 10), padLeft('Margin%', 8), padRight('Warning', 40)
      ].join(' '));
      for (var t = 0; t < theoretical.length; t++) {
        var r = theoretical[t];
        parts.push([
          padRight(r.resource, 8), padRight(r.barName, 12),
          padLeft('+' + fmt(r.profit), 10), padLeft(fmtShort(r.marginPct) + '%', 8),
          padRight('⚠ ' + (r.warnings[0] || ''), 40)
        ].join(' '));
      }
      parts.push('');
    }

    if (actionable.length === 0 && theoretical.length === 0) {
      parts.push('--- No profitable decompression opportunities found ---');
      parts.push('');
    }

    parts.push('--- UNPROFITABLE (for reference) ---');
    parts.push([
      padRight('Output', 8), padRight('From Bar', 12),
      padLeft('Loss/batch', 12), padLeft('Margin%', 8)
    ].join(' '));
    for (var u = 0; u < unprofitable.length; u++) {
      var r = unprofitable[u];
      parts.push([
        padRight(r.resource, 8), padRight(r.barName, 12),
        padLeft(fmt(r.profit), 12),
        padLeft(r.marginPct === null ? 'n/a' : fmtShort(r.marginPct) + '%', 8)
      ].join(' '));
    }
    return parts.join('\n');
  };

  // ---------- global entry: analyze single compound breakdown ----------

  global.analyzeBreakdown = function(compound, reagentSellMode, compoundBuyMode) {
    if (!compound) return 'Usage: analyzeBreakdown("XGH2O") or analyzeBreakdown("XGH2O", "ACTUAL_SELL", "ACTUAL_BUY")';

    var sellMode = reagentSellMode || 'ACTUAL_SELL';
    var buyMode  = compoundBuyMode  || 'ACTUAL_BUY';

    var reactionPairs = buildReactionMap();
    var rr = analyzeReverseReaction(compound, reactionPairs, sellMode, buyMode);
    if (!rr || !rr.found) return 'Error: ' + compound + ' is not a valid compound (cannot be broken down)';

    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('Pricing model: ACTUAL_SELL (best ask-0.1) / ACTUAL_BUY (best bid+0.1)');
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
      for (var w = 0; w < rr.warnings.length; w++) parts.push('  - ' + rr.warnings[w]);
      parts.push('');
    }

    if (rr.profit !== null && rr.profit > 0 && rr.actionable === '✓') {
      parts.push('>>> ✓ ACTIONABLE — Execute reverseReaction now! <<<');
    } else if (rr.profit !== null && rr.profit > 0) {
      parts.push('>>> ~ THEORETICAL PROFIT — Verify orders exist before acting! <<<');
    } else {
      parts.push('Not profitable at current prices.');
    }
    return parts.join('\n');
  };

  // ---------- global entry: analyze single decompression ----------

  global.analyzeDecompression = function(baseResource, outputMode, inputMode) {
    if (!baseResource) return 'Usage: analyzeDecompression("U") or analyzeDecompression("Z", "ACTUAL_SELL", "ACTUAL_BUY")';

    var outMode = outputMode || 'ACTUAL_SELL';
    var inMode  = inputMode  || 'ACTUAL_BUY';

    var r = analyzeFactoryDecompression(baseResource, outMode, inMode);
    if (!r || !r.found) {
      return 'Error: ' + baseResource + ' is not a valid decompression target.\n' +
             'Valid targets: ' + FACTORY_DECOMPRESSION_TARGETS.join(', ');
    }

    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('Pricing model: ACTUAL_SELL (best ask-0.1) / ACTUAL_BUY (best bid+0.1)');
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
      for (var w = 0; w < r.warnings.length; w++) parts.push('  - ' + r.warnings[w]);
      parts.push('');
    }

    if (r.profit !== null && r.profit > 0 && r.actionable === '✓') {
      parts.push('>>> ✓ ACTIONABLE — Execute decompression now! <<<');
    } else if (r.profit !== null && r.profit > 0) {
      parts.push('>>> ~ THEORETICAL PROFIT — Verify orders exist before acting! <<<');
    } else {
      parts.push('Not profitable at current prices.');
    }
    return parts.join('\n');
  };

  // ---------- global entry: order book viewer (unchanged) ----------

  global.orderBook = function(resource) {
    if (!resource) return 'Usage: orderBook("ZO") or orderBook("energy")';
    resource = resolveResource(resource);

    var sellInfo = getOrderInfo(resource, ORDER_SELL);
    var buyInfo  = getOrderInfo(resource, ORDER_BUY);
    var histPrice = getAvg48h(resource);
    var actualBuy  = computeActualBuyPrice(resource);
    var actualSell = computeActualSellPrice(resource);

    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Order Book: ' + resource + ' ===');
    parts.push('');
    parts.push('Historical (48h avg): ' + (histPrice === null ? 'n/a' : fmt(histPrice)));
    parts.push('');
    parts.push('Execution prices (as used by autoTrader.js):');
    parts.push('  ACTUAL_BUY  (cost to acquire):  ' + fmt(actualBuy.price) +
               ' [' + actualBuy.source + '] — best bid + 0.1');
    parts.push('  ACTUAL_SELL (revenue if sold):  ' + fmt(actualSell.price) +
               ' [' + actualSell.source + '] — best ask - 0.1 (capped at hist*1.5)');
    parts.push('');

    parts.push('--- SELL ORDERS (you can BUY at these prices) ---');
    parts.push('Count: ' + sellInfo.count + ' | Total volume: ' + fmtVol(sellInfo.totalVolume) + ' (' + sellInfo.totalVolume + ')');
    if (sellInfo.count > 0) {
      parts.push('Best (lowest ask): ' + fmt(sellInfo.bestPrice));
      parts.push('');
      parts.push([padRight('Price', 12), padRight('Available', 12), padRight('Room', 10)].join(' '));
      var showSell = Math.min(10, sellInfo.orders.length);
      for (var s = 0; s < showSell; s++) {
        var o = sellInfo.orders[s];
        parts.push([padLeft(fmt(o.price), 12), padLeft(String(o.remainingAmount || o.amount), 12), padRight(o.roomName || 'N/A', 10)].join(' '));
      }
    } else {
      parts.push('  No sell orders.');
    }
    parts.push('');

    parts.push('--- BUY ORDERS (you can SELL at these prices) ---');
    parts.push('Count: ' + buyInfo.count + ' | Total volume: ' + fmtVol(buyInfo.totalVolume) + ' (' + buyInfo.totalVolume + ')');
    if (buyInfo.count > 0) {
      parts.push('Best (highest bid): ' + fmt(buyInfo.bestPrice));
      parts.push('');
      parts.push([padRight('Price', 12), padRight('Wanted', 12), padRight('Room', 10)].join(' '));
      var showBuy = Math.min(10, buyInfo.orders.length);
      for (var b = 0; b < showBuy; b++) {
        var o = buyInfo.orders[b];
        parts.push([padLeft(fmt(o.price), 12), padLeft(String(o.remainingAmount || o.amount), 12), padRight(o.roomName || 'N/A', 10)].join(' '));
      }
    } else {
      parts.push('  No buy orders.');
    }
    parts.push('');

    if (sellInfo.bestPrice !== null && buyInfo.bestPrice !== null) {
      var spread = sellInfo.bestPrice - buyInfo.bestPrice;
      var spreadPct = (spread / buyInfo.bestPrice) * 100;
      parts.push('--- SPREAD ANALYSIS ---');
      parts.push('Bid (best buy order): ' + fmt(buyInfo.bestPrice));
      parts.push('Ask (best sell order): ' + fmt(sellInfo.bestPrice));
      parts.push('Spread: ' + fmt(spread) + ' (' + fmtShort(spreadPct) + '%)');
      if (spreadPct > 100) parts.push('⚠ HUGE SPREAD — Market is illiquid or has stale orders!');
    }

    return parts.join('\n');
  };

  // ---------- global entry: energy cost helper ----------

  global.energyCost = function() {
    var info = computeActualBuyPrice(RESOURCE_ENERGY);
    var parts = [];
    parts.push('Generated: ' + getPacificTimeString());
    parts.push('');
    parts.push('=== Energy Cost (ACTUAL_BUY / marketBuy strategy) ===');
    parts.push('');
    parts.push('Price: ' + fmt(info.price) + ' credits/energy');
    parts.push('Source: ' + info.source);
    parts.push('');
    if (info.source === 'ABUY') {
      parts.push('Calculated as: highest external BUY order (≥1000 remaining) + 0.1');
      parts.push('Orders found: ' + info.orderCount + ' | Volume: ' + fmtVol(info.volume) + ' (' + info.volume + ')');
    } else {
      parts.push('No suitable BUY orders found (need ≥1000 remaining). Using hist * 0.95.');
    }
    return parts.join('\n');
  };

})();