// marketAnalysis.js
// Factory & Lab profitability tables using live market data.
// IMPORTANT
// - No optional chaining (Screeps runtime limitation).
// - Prices prefer your existing global.marketPrice helper created earlier; if a
//   programmatic getter isn't exposed, this falls back to Screeps Market APIs.
// - Output is returned as a single formatted string (no console.log here).
// - Recipes come from COMMODITIES (factory) and REACTIONS (labs). Batch size for
//   labs uses LAB_REACTION_AMOUNT. Costs/revenues are immediate (non-recursive).
//
// Usage (console):
//   console.log(marketAnalysis());            // default: out='buy', in='sell'
//   console.log(marketAnalysis('avg','avg')); // both sides 48h volume-weighted avg
//   console.log(marketAnalysis('sell','sell'));
//
// Notes/assumptions:
// - Costs = sum of immediate recipe inputs at chosen inputMode (including energy where applicable).
// - Revenues = outputMode price × batch amount (COMMODITIES.amount or LAB_REACTION_AMOUNT).
// - Market transfer energy costs/logistics are excluded (can be added later).
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

  // ---------- utils ----------
  function number(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
  function fmt(n) { return typeof n === 'number' && isFinite(n) ? n.toFixed(3) : 'n/a'; }
  function padRight(s, w) { s = String(s); while (s.length < w) s += ' '; return s; }

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

  // ---------- pricing: prefer your marketPrice helper ----------
  function getPriceViaMarketPrice(resource, mode) {
    try {
      if (global.marketPrice && typeof global.marketPrice === 'function') {
        if (typeof global.marketPrice.get === 'function') return global.marketPrice.get(resource, mode);
        if (typeof global.marketPrice.priceOf === 'function') return global.marketPrice.priceOf(resource, mode);
      }
    } catch (e) {}
    return null;
  }

  // Fallback to Screeps market data if helper not available
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

  function getOrderPrice(resource, mode) {
    var type = mode === 'buy' ? ORDER_BUY : ORDER_SELL;
    var orders = Game.market.getAllOrders({ resourceType: resource, type: type }) || [];
    var valid = [];
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var rem = o.remainingAmount || o.amount || 0;
      if (rem > 0) valid.push(o);
    }
    if (valid.length === 0) return null;
    valid.sort(function(a, b) { return mode === 'buy' ? (b.price - a.price) : (a.price - b.price); });
    return valid[0].price;
  }

  function fallbackPrice(resource, mode) {
    if (mode === 'avg') {
      var avg = getAvg48h(resource);
      if (avg !== null) return avg;
      var fb = getOrderPrice(resource, 'sell');
      if (fb !== null) return fb;
      return null;
    }
    if (mode === 'buy' || mode === 'sell') {
      var p = getOrderPrice(resource, mode);
      if (p !== null) return p;
      var a = getAvg48h(resource);
      if (a !== null) return a;
      return null;
    }
    return null;
  }

  function priceOf(resource, mode) {
    resource = resolveResource(resource);
    var via = getPriceViaMarketPrice(resource, mode);
    if (typeof via === 'number' && isFinite(via)) return via;
    return fallbackPrice(resource, mode);
  }

  // ---------- factory ----------
  function analyzeFactoryCommodity(resource, outputMode, inputMode) {
    var recipe = COMMODITIES && COMMODITIES[resource];
    if (!recipe) return { resource: resource, found: false };

    var outQty = number(recipe.amount) > 0 ? number(recipe.amount) : 1;
    var comps = recipe.components || {};
    var totalCost = 0;
    for (var res in comps) {
      if (!comps.hasOwnProperty(res)) continue;
      var qty = number(comps[res]);
      var pp = priceOf(res, inputMode);
      totalCost += (pp === null ? 0 : pp * qty);
    }
    var unitPrice = priceOf(resource, outputMode);
    var revenue = unitPrice === null ? null : unitPrice * outQty;
    var profit = revenue === null ? null : (revenue - totalCost);
    var profitPerUnit = profit === null ? null : (profit / outQty);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);

    return {
      resource: resource, found: true,
      outQty: outQty, unitPrice: unitPrice, revenue: revenue,
      inputCost: totalCost, profit: profit, profitPerUnit: profitPerUnit, marginPct: marginPct
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

    // Each reaction consumes batch of A and batch of B to produce batch of product.
    var a = pair[0];
    var b = pair[1];
    var pa = priceOf(a, inputMode);
    var pb = priceOf(b, inputMode);
    var totalCost = (pa === null ? 0 : pa * batch) + (pb === null ? 0 : pb * batch);

    var unitPrice = priceOf(resource, outputMode);
    var revenue = unitPrice === null ? null : unitPrice * batch;
    var profit = revenue === null ? null : (revenue - totalCost);
    var profitPerUnit = profit === null ? null : (profit / batch);
    var marginPct = profit === null ? null : (totalCost > 0 ? (profit / totalCost) * 100 : null);

    return {
      resource: resource, found: true,
      outQty: batch, unitPrice: unitPrice, revenue: revenue,
      inputCost: totalCost, profit: profit, profitPerUnit: profitPerUnit, marginPct: marginPct
    };
  }

  // ---------- tables ----------
  function buildFactoryTable(rows, outMode, inMode) {
    var header = [
      '=== Factory Production and Profitability ===',
      '(out=' + outMode + ', in=' + inMode + ')',
      [
        padRight('Item', 16),
        padRight('OutQty', 6),
        padRight('Out$/u', 10),
        padRight('Revenue', 12),
        padRight('InputCost', 12),
        padRight('Profit', 12),
        padRight('Profit/u', 10),
        padRight('Margin%', 8)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        padRight(r.resource, 16),
        padRight(String(r.outQty), 6),
        padRight(fmt(r.unitPrice), 10),
        padRight(fmt(r.revenue), 12),
        padRight(fmt(r.inputCost), 12),
        padRight(fmt(r.profit), 12),
        padRight(fmt(r.profitPerUnit), 10),
        padRight(r.marginPct === null ? 'n/a' : fmt(r.marginPct), 8)
      ].join(' '));
    }
    return lines.join('\n');
  }

  function buildLabTable(rows, outMode, inMode) {
    var header = [
      '=== Lab Production and Profitability ===',
      '(out=' + outMode + ', in=' + inMode + ', batch=' + (typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5) + ')',
      [
        padRight('Compound', 16),
        padRight('OutQty', 6),
        padRight('Out$/u', 10),
        padRight('Revenue', 12),
        padRight('InputCost', 12),
        padRight('Profit', 12),
        padRight('Profit/u', 10),
        padRight('Margin%', 8)
      ].join(' ')
    ].join('\n');

    var lines = [header];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        padRight(r.resource, 16),
        padRight(String(r.outQty), 6),
        padRight(fmt(r.unitPrice), 10),
        padRight(fmt(r.revenue), 12),
        padRight(fmt(r.inputCost), 12),
        padRight(fmt(r.profit), 12),
        padRight(fmt(r.profitPerUnit), 10),
        padRight(r.marginPct === null ? 'n/a' : fmt(r.marginPct), 8)
      ].join(' '));
    }
    return lines.join('\n');
  }

  // ---------- global entry ----------
  global.marketAnalysis = function(outputMode, inputMode) {
    var outMode = (outputMode || 'buy') + '';
    var inMode  = (inputMode  || 'sell') + '';

    // FACTORY
    var factoryRows = [];
    for (var i = 0; i < FACTORY_TARGETS.length; i++) {
      var res = FACTORY_TARGETS[i];
      var row = analyzeFactoryCommodity(res, outMode, inMode);
      if (row && row.found) factoryRows.push(row);
    }
    factoryRows.sort(sortByMarginDescThenProfitDesc);

    // LABS
    var reactionPairs = buildReactionMap();
    var labList = listAllLabProducts(reactionPairs);
    var labRows = [];
    for (var j = 0; j < labList.length; j++) {
      var prod = labList[j];
      var lr = analyzeLabProduct(prod, reactionPairs, outMode, inMode);
      if (lr && lr.found) labRows.push(lr);
    }
    labRows.sort(sortByMarginDescThenProfitDesc);

    // Compose (no console.log here to avoid duplicate console echo)
    var parts = [];
    parts.push(buildFactoryTable(factoryRows, outMode, inMode));
    parts.push('');
    parts.push(buildLabTable(labRows, outMode, inMode));
    return parts.join('\n');
  };
})();
