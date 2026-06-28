// marketAnalysis.js
// Factory, Lab, and Reverse Reaction profitability tables using live market data.
//
// PRICING (matches autoTrader.js):
// - Outputs (sell side):  ACTUAL_SELL = best external SELL order - 0.1
//                          (capped hist*1.5, fallback hist*1.05)
// - Inputs  (buy side):   vwAsk (volume-weighted ask) with fallback to ACTUAL_SELL
//                          when the book is empty. Energy still uses ACTUAL_BUY
//                          (best external BUY order + 0.1) because we source it
//                          via marketSell, not as a bought input.
//                          Own-inventory reagents/compounds use ACTUAL_SELL
//                          (opportunity cost of consuming stock).
// - The buy-side switch from ACTUAL_BUY to vwAsk was needed to fix a
//   cost-model mismatch with marketRefine: bestBid+0.1 is the price a posted
//   bid would be filled at, but it's starved in thin books where bestAsk is
//   much higher. marketRefine correctly refuses such bids, leaving autoTrader
//   with refused compress ops whose reported margins were inflated by the old
//   cost model. vwAsk matches what a deal()/real fill actually costs.
//
// Usage (console):
//   console.log(marketAnalysis())
//   console.log(reverseReactionAnalysis())
//   console.log(decompressionAnalysis())
//   console.log(orderBook('ZO'))
//   console.log(analyzeBreakdown('XGH2O'))
//   console.log(analyzeForward('XGH2O'))
//   console.log(analyzeDecompression('U'))
//   console.log(energyCost())
//   rawMarketData()

(function registerMarketAnalysisGlobal() {

  // ===== Reaction time table =====
  var REACTION_TIME_TABLE = {
    OH: 20, ZK: 5, UL: 5, G: 5,
    UH: 10, UO: 10, KH: 10, KO: 10,
    LH: 15, LO: 10, ZH: 20, ZO: 20, GH: 10, GO: 10,
    UH2O:  5, UHO2:  5, KH2O:  5, KHO2:  5,
    LH2O: 10, LHO2:  5, ZH2O: 40, ZHO2:  5,
    GH2O: 15, GHO2: 10,
    XUH2O: 180, XUHO2:  45,
    XKH2O:  45, XKHO2:  45,
    XLH2O:  65, XLHO2:  45,
    XZH2O: 180, XZHO2:  45,
    XGH2O: 150, XGHO2: 150
  };

  // ===== Factory cooldown table =====
  var FACTORY_COOLDOWN_TABLE = {
    // Level 0 compression
    utrium_bar:    20, lemergium_bar: 20, zynthium_bar:  20, keanium_bar:   20,
    ghodium_melt:  20, oxidant:       20, reductant:     20, purifier:      20,
    battery:       10, wire:           8, cell:           8, alloy:          8, condensate: 8,
    // Level 0 decompression
    U:   20, L:   20, Z:   20, K:   20,
    G:   20, O:   20, H:   20, X:   20, energy: 10,
    // Level 1
    composite: 50, tube: 50, phlegm: 50, switch: 50, concentrate: 50,
    // Level 2
    crystal: 100, fixtures: 100, tissue: 100, transistor: 100, extract: 100,
    // Level 3
    liquid: 150, frame: 150, muscle: 150, microchip: 150, spirit: 150,
    // Level 4
    hydraulics: 400, organoid: 400, circuit: 400, emanation: 400,
    // Level 5
    machine: 600, organism: 600, device: 600, essence: 600
  };

  // ===== Target lists =====
    var FACTORY_TARGETS = [
      // Level 0
      'oxidant','reductant','zynthium_bar','lemergium_bar','utrium_bar',
      'keanium_bar','purifier','battery','ghodium_melt',
      'alloy','wire','cell','condensate',
      // Level 1
      'composite','tube','phlegm','switch','concentrate',
      // Level 2
      'crystal','fixtures','tissue','transistor','extract',
      // Level 3
      'liquid','frame','muscle','microchip','spirit',
      // Level 4
      'hydraulics','organoid','circuit','emanation',
      // Level 5
      'machine','organism','device','essence'
    ];



  var FACTORY_DECOMPRESSION_TARGETS = ['U','L','Z','K','O','H','G','energy'];

  var DECOMPRESSION_BAR_MAP = {
    U:'utrium_bar', L:'lemergium_bar', Z:'zynthium_bar', K:'keanium_bar',
    O:'oxidant',    H:'reductant',     G:'ghodium_melt', energy:'battery'
  };

  // ===== Utils =====
  function fmt(n)      { return typeof n === 'number' && isFinite(n) ? n.toFixed(2) : 'n/a'; }
  function fmtS(n)     { return typeof n === 'number' && isFinite(n) ? n.toFixed(1) : 'n/a'; }
  function padR(s, w)  { s = String(s); while (s.length < w) s += ' '; return s; }
  function padL(s, w)  { s = String(s); while (s.length < w) s = ' ' + s; return s; }
  function fmtVol(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0';
    if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
    if (n >= 1000)    return (n/1000).toFixed(1)+'K';
    return String(Math.floor(n));
  }
  function byMargin(a, b) {
    var am = a.marginPct === null ? -Infinity : a.marginPct;
    var bm = b.marginPct === null ? -Infinity : b.marginPct;
    if (bm !== am) return bm - am;
    var ap = a.profit === null ? -Infinity : a.profit;
    var bp = b.profit === null ? -Infinity : b.profit;
    return bp - ap;
  }
  function resolveResource(r) {
    if (typeof r !== 'string') return r;
    if (typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(r) !== -1) return r;
    var c = global[r];
    if (typeof c === 'string' && typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(c) !== -1) return c;
    var lo = r.toLowerCase();
    if (typeof RESOURCES_ALL !== 'undefined' && RESOURCES_ALL.indexOf(lo) !== -1) return lo;
    return r;
  }

  // ===== Market helpers =====
  function getOrderInfo(resource, orderType) {
    var orders = Game.market.getAllOrders({ resourceType: resource, type: orderType }) || [];
    var valid = [], vol = 0;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i], amt = o.remainingAmount || o.amount || 0;
      if (amt > 0) { valid.push(o); vol += amt; }
    }
    if (!valid.length) return { count: 0, totalVolume: 0, bestPrice: null, orders: [] };
    valid.sort(function(a,b){ return orderType===ORDER_BUY ? b.price-a.price : a.price-b.price; });
    return { count: valid.length, totalVolume: vol, bestPrice: valid[0].price, orders: valid };
  }

  function getMyRooms() {
    var m = {};
    for (var rn in Game.rooms) { var r = Game.rooms[rn]; if (r&&r.controller&&r.controller.my) m[rn]=true; }
    return m;
  }

  /**
   * Build a set of resource types for which we currently have active sell orders.
   * Uses Game.market.orders (our own orders only) -- no extra getAllOrders call needed.
   * Called once per analysis pass and shared across all compound evaluations.
   */
  function buildOwnSellResourceSet() {
    var set = {};
    var myOrders = Game.market.orders;
    if (!myOrders) return set;
    for (var id in myOrders) {
      var o = myOrders[id];
      if (o && o.type === ORDER_SELL && (o.remainingAmount || 0) > 0) {
        set[o.resourceType] = true;
      }
    }
    return set;
  }

  function computeActualBuyPrice(resourceType) {
    var orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resourceType }) || [];
    var myRooms = getMyRooms(), valid = [];
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (!o || typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
      if (o.roomName && myRooms[o.roomName]) continue;
      if (typeof o.price !== 'number') continue;
      valid.push(o);
    }
    valid.sort(function(a,b){ return b.price-a.price; });
    var vol = 0; for (var j=0;j<valid.length;j++) vol += valid[j].remainingAmount||0;
    if (valid.length > 0) return { price: Math.max(valid[0].price+0.1, 0.001), source:'ABUY', orderCount:valid.length, volume:vol };
    var hist = Game.market.getHistory(resourceType)||[], cnt=0, sum=0;
    if (hist.length>=1&&typeof hist[hist.length-1].avgPrice==='number'){sum+=hist[hist.length-1].avgPrice;cnt++;}
    if (hist.length>=2&&typeof hist[hist.length-2].avgPrice==='number'){sum+=hist[hist.length-2].avgPrice;cnt++;}
    return { price: Math.max((cnt>0?sum/cnt:1)*0.95, 0.001), source:'HIST', orderCount:0, volume:0 };
  }

  function computeActualSellPrice(resourceType) {
    var orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType }) || [];
    var myRooms = getMyRooms(), valid = [];
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (!o || typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
      if (o.roomName && myRooms[o.roomName]) continue;
      if (typeof o.price !== 'number') continue;
      valid.push(o);
    }
    valid.sort(function(a,b){ return a.price-b.price; });
    var hist = Game.market.getHistory(resourceType)||[], cnt=0, sum=0;
    if (hist.length>=1&&typeof hist[hist.length-1].avgPrice==='number'){sum+=hist[hist.length-1].avgPrice;cnt++;}
    if (hist.length>=2&&typeof hist[hist.length-2].avgPrice==='number'){sum+=hist[hist.length-2].avgPrice;cnt++;}
    var avg = cnt>0?sum/cnt:1;
    if (valid.length > 0) {
      var p = valid[0].price-0.1;
      var vol = valid.reduce(function(a,o){return a+(o.remainingAmount||0);},0);
      return { price: Math.max(Math.min(p, avg*1.5), 0.001), source:'ASELL', orderCount:valid.length, volume:vol };
    }
    return { price: Math.max(avg*1.05, 0.001), source:'HIST', orderCount:0, volume:0 };
  }

  /**
   * Volume-weighted ask for a resource: what it would actually cost to acquire
   * (e.g. via opportunisticBuy.deal() or to fill a real posted bid). Used as
   * the cost basis in the analyses so reported margins reflect what marketRefine
   * / marketLab can actually deliver. Excludes dust orders (<1000 remaining) and
   * own rooms. Falls back to ACTUAL_SELL (bestAsk-0.1) when the book is empty.
   * This mirrors marketPricing.getBook().vwAsk and is the fix for the cost-
   * model mismatch where ACTUAL_BUY (bestBid+0.1) over-stated margin in thin
   * books and marketRefine then refused at execution.
   */
  function getVolumeWeightedBuyPrice(resourceType) {
    if (resourceType === RESOURCE_ENERGY) return computeActualBuyPrice(resourceType);
    var book = buildBook(resourceType);
    if (book && typeof book.vwAsk === 'number' && book.vwAsk > 0) {
      return { price: book.vwAsk, source: 'VWAP', orderCount: book.askCount, volume: book.askVol };
    }
    var fb = computeActualSellPrice(resourceType);
    if (fb && typeof fb.price === 'number' && fb.price !== null) return fb;
    return { price: null, source: 'NONE', orderCount: 0, volume: 0 };
  }

  // Build a minimal book for one resource: bestBid, bestAsk, vwBid, vwAsk, depths.
  // Self-contained (doesn't require marketPricing) so this module stays portable.
  function buildBook(resourceType) {
    var buys  = Game.market.getAllOrders({ type: ORDER_BUY,  resourceType: resourceType }) || [];
    var sells = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType }) || [];
    var myRooms = getMyRooms();
    function clean(arr) {
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (!o || typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
        if (o.roomName && myRooms[o.roomName]) continue;
        if (typeof o.price !== 'number') continue;
        out.push(o);
      }
      return out;
    }
    function wPrice(orders) {
      if (!orders.length) return null;
      var sumPV = 0, sumV = 0;
      for (var i = 0; i < orders.length; i++) { sumPV += orders[i].price * orders[i].remainingAmount; sumV += orders[i].remainingAmount; }
      return sumV > 0 ? sumPV / sumV : null;
    }
    function sumVol(orders) { var v=0; for (var i=0;i<orders.length;i++) v += orders[i].remainingAmount; return v; }
    var cb = clean(buys), cs = clean(sells);
    cb.sort(function(a,b){ return b.price-a.price; });
    cs.sort(function(a,b){ return a.price-b.price; });
    return {
      bestBid: cb.length ? cb[0].price : null,
      bestAsk: cs.length ? cs[0].price : null,
      vwBid: wPrice(cb),
      vwAsk: wPrice(cs),
      bidVol: sumVol(cb),
      askVol: sumVol(cs),
      bidCount: cb.length,
      askCount: cs.length
    };
  }

  function getAvg48h(resource) {
    var hist = Game.market.getHistory(resource)||[];
    if (!hist||!hist.length) return null;
    var last=hist[hist.length-1], prev=hist.length>=2?hist[hist.length-2]:null;
    var spv=0,sv=0;
    if (last&&typeof last.avgPrice==='number'&&typeof last.volume==='number'){spv+=last.avgPrice*last.volume;sv+=last.volume;}
    if (prev&&typeof prev.avgPrice==='number'&&typeof prev.volume==='number'){spv+=prev.avgPrice*prev.volume;sv+=prev.volume;}
    if (sv<=0) return last&&typeof last.avgPrice==='number'?last.avgPrice:null;
    return spv/sv;
  }

  function priceOfWithSource(resource, mode) {
    resource = resolveResource(resource);
    if (mode==='ACTUAL_SELL') return computeActualSellPrice(resource);
    if (mode==='ACTUAL_BUY')  return computeActualBuyPrice(resource);
    if (resource===RESOURCE_ENERGY&&mode==='sell') return computeActualBuyPrice(resource);
    if (mode==='avg') {
      var avg=getAvg48h(resource);
      if (avg!==null) return {price:avg,source:'HIST',orderCount:0,volume:0};
      var si=getOrderInfo(resource,ORDER_SELL);
      if (si.bestPrice!==null) return {price:si.bestPrice,source:'LIVE',orderCount:si.count,volume:si.totalVolume};
      return {price:null,source:'NONE',orderCount:0,volume:0};
    }
    if (mode==='buy'||mode==='sell') {
      var oi=getOrderInfo(resource,mode==='buy'?ORDER_BUY:ORDER_SELL);
      if (oi.bestPrice!==null) return {price:oi.bestPrice,source:'LIVE',orderCount:oi.count,volume:oi.totalVolume};
      var hp=getAvg48h(resource);
      if (hp!==null) return {price:hp,source:'HIST',orderCount:0,volume:0};
      return {price:null,source:'NONE',orderCount:0,volume:0};
    }
    return {price:null,source:'NONE',orderCount:0,volume:0};
  }

  // OWN is live for actionable purposes: we have the inventory, the question is
  // only whether the reagent/output markets are liquid enough to execute.
  function isLive(src) { return src==='LIVE'||src==='ABUY'||src==='ASELL'||src==='OWN'; }

  // ===== Analysis: factory compression =====
  function analyzeFactoryCommodity(resource, outputMode, inputMode) {
    var recipe = COMMODITIES&&COMMODITIES[resource];
    if (!recipe) return { resource:resource, found:false };
    var outQty = (typeof recipe.amount==='number'&&recipe.amount>0)?recipe.amount:1;
    var comps = recipe.components||{};
    var ingredientCost=0, allInputsLive=true;

    for (var res in comps) {
      if (!comps.hasOwnProperty(res)) continue;
      var qty = typeof comps[res]==='number'?comps[res]:0;
      // Inputs are bought on the market. Use vwAsk (real cost to acquire) for
      // non-energy resources; energy uses ACTUAL_BUY (bestBid+0.1) because we
      // source it via marketSell, not as a bought input.
      var pi = (res === RESOURCE_ENERGY)
        ? priceOfWithSource(res, inputMode)
        : getVolumeWeightedBuyPrice(res);
      ingredientCost += pi.price===null?0:pi.price*qty;
      if (!isLive(pi.source)) allInputsLive=false;
    }

    var totalCost = ingredientCost;

    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice===null?null:unitPrice*outQty;
    var profit = revenue===null?null:revenue-totalCost;
    var profitPerUnit = profit===null?null:profit/outQty;
    var marginPct = profit===null?null:(totalCost>0?(profit/totalCost)*100:null);
    var actionable = outputInfo.price!==null?(isLive(outputInfo.source)&&allInputsLive?'✓':'~'):'✗';
    var cd = FACTORY_COOLDOWN_TABLE[resource]||null;

    return {
      resource:resource, found:true, outQty:outQty, unitPrice:unitPrice, revenue:revenue,
      ingredientCost:ingredientCost, inputCost:totalCost,
      profit:profit, profitPerUnit:profitPerUnit, marginPct:marginPct,
      outputSource:outputInfo.source, outputVolume:outputInfo.volume,
      outputOrderCount:outputInfo.orderCount, allInputsLive:allInputsLive,
      actionable:actionable, cooldown:cd
    };
  }

  // ===== Analysis: factory decompression =====
  function analyzeFactoryDecompression(baseResource, outputMode, inputMode) {
    var recipe = COMMODITIES&&COMMODITIES[baseResource];
    var outQty, components, barName;
    if (recipe&&recipe.components) {
      outQty = (typeof recipe.amount==='number'&&recipe.amount>0)?recipe.amount:1;
      components = recipe.components;
      barName = DECOMPRESSION_BAR_MAP[baseResource];
    } else {
      barName = DECOMPRESSION_BAR_MAP[baseResource];
      if (!barName) return { resource:baseResource, found:false };
      if (baseResource==='energy') { outQty=50; components={battery:1}; }
      else { outQty=500; components={}; components[barName]=100; components['energy']=200; }
    }
    if (!barName) return { resource:baseResource, found:false };

    var ingredientCost=0, allInputsLive=true, barInfo=null, energyInfo=null;
    for (var res in components) {
      if (!components.hasOwnProperty(res)) continue;
      var qty = typeof components[res]==='number'?components[res]:0;
      // Bar input is bought on the market; use vwAsk for the realistic cost.
      // Energy uses ACTUAL_BUY (bestBid+0.1) since we sell it via marketSell.
      var pi = (res === 'energy')
        ? priceOfWithSource(res, inputMode)
        : getVolumeWeightedBuyPrice(res);
      ingredientCost += pi.price===null?0:pi.price*qty;
      if (res===barName) barInfo=pi;
      else if (res==='energy') energyInfo=pi;
      if (!isLive(pi.source)) allInputsLive=false;
    }

    var totalCost = ingredientCost;

    var outputInfo = priceOfWithSource(baseResource, outputMode);
    var unitPrice = outputInfo.price;
    var revenue = unitPrice===null?null:unitPrice*outQty;
    var profit = revenue===null?null:revenue-totalCost;
    var profitPerUnit = profit===null?null:profit/outQty;
    var marginPct = profit===null?null:(totalCost>0?(profit/totalCost)*100:null);
    var actionable = outputInfo.price!==null?(isLive(outputInfo.source)&&allInputsLive?'✓':'~'):'✗';
    var warnings = [];
    if (barInfo&&!isLive(barInfo.source))      warnings.push('No orders for '+barName+' (using hist)');
    if (energyInfo&&!isLive(energyInfo.source)) warnings.push('Energy using historical price');
    if (!isLive(outputInfo.source))             warnings.push('No orders for '+baseResource+' (using hist)');
    var cd = FACTORY_COOLDOWN_TABLE[baseResource]||null;

    return {
      resource:baseResource, found:true, barName:barName, outQty:outQty,
      barQty:components[barName]||0, energyQty:components['energy']||0,
      barPrice:barInfo?barInfo.price:null, barSource:barInfo?barInfo.source:'NONE',
      barVolume:barInfo?barInfo.volume:0,
      energyPrice:energyInfo?energyInfo.price:null, energySource:energyInfo?energyInfo.source:'NONE',
      ingredientCost:ingredientCost, inputCost:totalCost,
      unitPrice:unitPrice, outputSource:outputInfo.source, outputVolume:outputInfo.volume,
      revenue:revenue, profit:profit, profitPerUnit:profitPerUnit, marginPct:marginPct,
      allInputsLive:allInputsLive, actionable:actionable, warnings:warnings,
      cooldown:cd
    };
  }

  // ===== Analysis: lab forward =====
  function buildReactionMap() {
    var map = {};
    if (!REACTIONS) return map;
    for (var a in REACTIONS) {
      if (!REACTIONS.hasOwnProperty(a)) continue;
      var inner = REACTIONS[a];
      for (var b in inner) { if (inner.hasOwnProperty(b)) map[inner[b]]=[a,b]; }
    }
    return map;
  }

  function listAllLabProducts(rp) {
    var arr=[]; for (var p in rp) if (rp.hasOwnProperty(p)) arr.push(p); arr.sort(); return arr;
  }

  /**
   * Analyze forward lab reaction profitability.
   *
   * OWN-INVENTORY FIX: If ownSellResources is provided and a reagent has an active
   * sell order, its cost is evaluated at ACTUAL_SELL (opportunity cost of consuming
   * own inventory) rather than ACTUAL_BUY. Matches autoTrader's analyzeForwardReaction
   * logic so the margins displayed here agree with what autoTrader will act on.
   * Rows with own-inventory reagents are tagged in inputAIsOwn / inputBIsOwn.
   *
   * @param {string}  resource
   * @param {Object}  reactionPairs
   * @param {string}  outputMode
   * @param {string}  inputMode
   * @param {Object}  [ownSellResources]  - set built by buildOwnSellResourceSet()
   */
  function analyzeLabProduct(resource, reactionPairs, outputMode, inputMode, ownSellResources) {
    var pair = reactionPairs[resource];
    if (!pair) return { resource:resource, found:false };
    var batch = typeof LAB_REACTION_AMOUNT==='number'&&LAB_REACTION_AMOUNT>0?LAB_REACTION_AMOUNT:5;
    var a=pair[0], b=pair[1];

    // Use ACTUAL_SELL as cost basis when the reagent comes from own inventory
    // (opportunity cost of consuming stock), matching autoTrader's
    // analyzeForwardReaction behavior. For non-own reagents, use vwAsk (real
    // cost to acquire on the market) so reported margins agree with what
    // marketLab can actually fill at.
    var aIsOwn = !!(ownSellResources && ownSellResources[a]);
    var bIsOwn = !!(ownSellResources && ownSellResources[b]);
    var paInfo = aIsOwn ? priceOfWithSource(a, 'ACTUAL_SELL') : getVolumeWeightedBuyPrice(a);
    var pbInfo = bIsOwn ? priceOfWithSource(b, 'ACTUAL_SELL') : getVolumeWeightedBuyPrice(b);

    var reagentCost = (paInfo.price===null?0:paInfo.price*batch) + (pbInfo.price===null?0:pbInfo.price*batch);
    var aDisplaySrc = aIsOwn ? 'OWN' : paInfo.source;
    var bDisplaySrc = bIsOwn ? 'OWN' : pbInfo.source;
    var allInputsLive = isLive(aDisplaySrc) && isLive(bDisplaySrc);
    var totalCost = reagentCost;
    var outputInfo = priceOfWithSource(resource, outputMode);
    var unitPrice=outputInfo.price;
    var revenue = unitPrice===null?null:unitPrice*batch;
    var profit = revenue===null?null:revenue-totalCost;
    var profitPerUnit = profit===null?null:profit/batch;
    var marginPct = profit===null?null:(totalCost>0?(profit/totalCost)*100:null);
    var actionable = outputInfo.price!==null?(isLive(outputInfo.source)&&allInputsLive?'✓':'~'):'✗';
    var rt=REACTION_TIME_TABLE[resource]||null;
    return {
      resource:resource, found:true, outQty:batch, unitPrice:unitPrice, revenue:revenue,
      reagentA:a, reagentB:b,
      reagentCost:reagentCost, inputCost:totalCost,
      profit:profit, profitPerUnit:profitPerUnit, marginPct:marginPct,
      outputSource:outputInfo.source, outputVolume:outputInfo.volume,
      outputOrderCount:outputInfo.orderCount,
      inputASource:aDisplaySrc, inputBSource:bDisplaySrc,
      inputAIsOwn:aIsOwn, inputBIsOwn:bIsOwn,
      allInputsLive:allInputsLive, actionable:actionable,
      reactionTime:rt
    };
  }

  // ===== Analysis: lab reverse =====
  /**
   * Analyze reverse reaction profitability.
   *
   * OWN-INVENTORY FIX: If ownSellResources is provided and we have an active sell
   * order for the compound, the cost basis is ACTUAL_SELL (what we give up by not
   * selling it whole) rather than ACTUAL_BUY (the cheap bid-to-acquire price).
   * This matches autoTrader's analyzeReverseReaction so the margins here agree with
   * what autoTrader will act on. Own-inventory rows show [OWN] in the BuySrc column.
   *
   * Example: ZH has no external sellers below 75 cr, so ACTUAL_BUY returns ~9.6 (top
   * valid bid + 0.1). Using 9.6 as cost makes ZH→Z+H look massively profitable but
   * external ZH can't actually be acquired at that price. With own inventory in play,
   * the true cost is ~75.8 (ACTUAL_SELL), giving a more realistic margin.
   *
   * @param {string}  compound
   * @param {Object}  reactionPairs
   * @param {string}  reagentSellMode
   * @param {string}  compoundBuyMode
   * @param {Object}  [ownSellResources]  - set built by buildOwnSellResourceSet()
   */
  function analyzeReverseReaction(compound, reactionPairs, reagentSellMode, compoundBuyMode, ownSellResources) {
    var pair = reactionPairs[compound];
    if (!pair) return { resource:compound, found:false };
    var batch = typeof LAB_REACTION_AMOUNT==='number'&&LAB_REACTION_AMOUNT>0?LAB_REACTION_AMOUNT:5;
    var reagentA=pair[0], reagentB=pair[1];

    // When we have own sell orders for the compound, consuming it in a reverse
    // reaction costs what we'd otherwise net selling it (ACTUAL_SELL), not the
    // cheap market bid price (compoundBuyMode / ACTUAL_BUY).
    // When buying from the market, use vwAsk (real cost to acquire) instead of
    // ACTUAL_BUY (bestBid+0.1, which is what a posted bid would fill at but is
    // starved in thin books). Matches the fix in marketAnalysis forward and
    // autoTrader so all three analyses agree.
    var isOwnInventory = !!(ownSellResources && ownSellResources[compound]);
    var compoundInfo;
    if (isOwnInventory) {
      compoundInfo = priceOfWithSource(compound, 'ACTUAL_SELL');
    } else {
      compoundInfo = getVolumeWeightedBuyPrice(compound);
    }
    var compoundPrice = compoundInfo.price;
    var totalCost = compoundPrice===null ? null : compoundPrice*batch;

    var paInfo=priceOfWithSource(reagentA,reagentSellMode), pbInfo=priceOfWithSource(reagentB,reagentSellMode);
    var priceA=paInfo.price, priceB=pbInfo.price;
    var revenueA=priceA===null?null:priceA*batch, revenueB=priceB===null?null:priceB*batch;
    var totalRevenue=(revenueA!==null&&revenueB!==null)?revenueA+revenueB:(revenueA!==null?revenueA:revenueB);
    var profit=totalRevenue!==null&&totalCost!==null?totalRevenue-totalCost:null;
    var profitPerUnit=profit===null?null:profit/batch;
    var marginPct=profit!==null&&totalCost!==null&&totalCost>0?(profit/totalCost)*100:null;

    // OWN counts as live for actionability: we have the stock, check reagent markets.
    var cSrc = isOwnInventory ? 'OWN' : compoundInfo.source;
    var cLive=isLive(cSrc), aLive=isLive(paInfo.source), bLive=isLive(pbInfo.source);
    var actionable='✗';
    var warnings=[];
    if (cLive&&aLive&&bLive) actionable='✓';
    else if (compoundPrice!==null&&(priceA!==null||priceB!==null)) actionable='~';

    if (isOwnInventory) {
      warnings.push('Cost = opportunity cost (own inventory priced at ACTUAL_SELL ~'+fmt(compoundPrice)+')');
    } else if (!cLive&&compoundInfo.source==='HIST') {
      warnings.push('No orders for '+compound+' (using hist)');
    }
    if (!aLive&&paInfo.source==='HIST') warnings.push('No orders for '+reagentA+' (using hist)');
    if (!bLive&&pbInfo.source==='HIST') warnings.push('No orders for '+reagentB+' (using hist)');

    return {
      resource:compound, found:true, reagentA:reagentA, reagentB:reagentB, batch:batch,
      isOwnInventory:isOwnInventory,
      compoundPrice:compoundPrice, compoundSource:cSrc, compoundVolume:compoundInfo.volume,
      priceA:priceA, priceASource:paInfo.source, priceAVolume:paInfo.volume,
      priceB:priceB, priceBSource:pbInfo.source, priceBVolume:pbInfo.volume,
      inputCost:totalCost, revenueA:revenueA, revenueB:revenueB, revenue:totalRevenue,
      profit:profit, profitPerUnit:profitPerUnit, marginPct:marginPct,
      actionable:actionable, warnings:warnings
    };
  }

  // ===== Table builders =====
  function buildFactoryTable(rows, outMode, inMode) {
    var eInfo = computeActualBuyPrice(RESOURCE_ENERGY);
    var lines = [
      '=== Factory Compression Profitability ===',
      '(out='+outMode+', in='+inMode+')',
      'Energy: '+fmt(eInfo.price)+' ['+eInfo.source+']',
      'Legend: ✓=Actionable ~=Theoretical ✗=Missing data',
      '',
      [padR('Item',14),padL('Sell@',8),padR('Src',6),padL('Volume',8),
       padL('Ingred',9),padL('Profit/u',10),padL('Margin%',8),
       padL('Cd/t',5),padR('Act',3)].join(' ')
    ];
    for (var i=0;i<rows.length;i++) {
      var r=rows[i];
      lines.push([
        padR(r.resource,14), padL(fmt(r.unitPrice),8), padR(r.outputSource,6),
        padL(fmtVol(r.outputVolume),8),
        padL(fmt(r.ingredientCost),9),
        padL(fmt(r.profitPerUnit),10),
        padL(r.marginPct===null?'n/a':fmtS(r.marginPct)+'%',8),
        padL(r.cooldown!==null?String(r.cooldown):'n/a',5),
        padR(r.actionable,3)
      ].join(' '));
    }
    return lines.join('\n');
  }

  function buildDecompressionTable(rows, outMode, inMode) {
    var eInfo = computeActualBuyPrice(RESOURCE_ENERGY);
    var lines = [
      '=== Factory Decompression Profitability ===',
      'Buy bars ('+inMode+') -> Decompress -> Sell base resource ('+outMode+')',
      'Energy: '+fmt(eInfo.price)+' ['+eInfo.source+'] | 100 bar+200e→500 mineral | 1 battery→50 energy',
      'Legend: ✓=Actionable ~=Theoretical ✗=Missing data',
      '',
      [padR('Output',8),padR('Bar',12),padR('BarSrc',7),padL('BarVol',8),
       padL('Sell@',8),padL('Ingred',9),padL('Profit/u',10),
       padL('Margin%',8),padL('Cd/t',5),padR('Act',3)].join(' ')
    ];
    for (var i=0;i<rows.length;i++) {
      var r=rows[i];
      lines.push([
        padR(r.resource,8), padR(r.barName,12), padR(r.barSource,7),
        padL(fmtVol(r.barVolume),8), padL(fmt(r.unitPrice),8),
        padL(fmt(r.ingredientCost),9),
        padL(fmt(r.profitPerUnit),10),
        padL(r.marginPct===null?'n/a':fmtS(r.marginPct)+'%',8),
        padL(r.cooldown!==null?String(r.cooldown):'n/a',5),
        padR(r.actionable,3)
      ].join(' '));
    }
    return lines.join('\n');
  }

  /**
   * Build the lab forward reaction table.
   * Rows where one or both reagents come from own inventory are annotated with
   * [OWN:reagentName] so it's clear which cost basis applies.
   */
  function buildLabTable(rows, outMode, inMode, circularSet) {
    circularSet = circularSet||{};
    var eInfo = computeActualBuyPrice(RESOURCE_ENERGY);
    var batch = typeof LAB_REACTION_AMOUNT==='number'?LAB_REACTION_AMOUNT:5;
    var lines = [
      '=== Lab Forward Reaction Profitability ===',
      '(out='+outMode+', in='+inMode+', batch='+batch+')',
      'Energy: '+fmt(eInfo.price)+' ['+eInfo.source+']',
      'Legend: ✓=Actionable ~=Theoretical ✗=Missing data  ⇄=CIRCULAR  [OWN]=own-inventory reagent cost',
      '',
      [padR('Compound',10),padL('Sell@',8),padR('Src',6),padL('Volume',8),
       padL('Reagent',9),padL('Profit/u',10),padL('Margin%',8),
       padL('Rxn/t',6),padR('Act',3)].join(' ')
    ];
    for (var i=0;i<rows.length;i++) {
      var r=rows[i];
      var suffix = '';
      if (circularSet[r.resource]) suffix += ' ⇄';
      // Annotate which reagents are priced at opportunity cost (own inventory)
      if (r.inputAIsOwn || r.inputBIsOwn) {
        var ownParts = [];
        if (r.inputAIsOwn && r.reagentA) ownParts.push(r.reagentA);
        if (r.inputBIsOwn && r.reagentB) ownParts.push(r.reagentB);
        suffix += ' [OWN:'+ownParts.join(',')+']';
      }
      lines.push([
        padR(r.resource,10), padL(fmt(r.unitPrice),8), padR(r.outputSource,6),
        padL(fmtVol(r.outputVolume),8),
        padL(fmt(r.reagentCost),9),
        padL(fmt(r.profitPerUnit),10),
        padL(r.marginPct===null?'n/a':fmtS(r.marginPct)+'%',8),
        padL(r.reactionTime!==null?String(r.reactionTime)+'t':'n/a',6),
        padR(r.actionable,3)
      ].join(' ') + suffix);
    }
    return lines.join('\n');
  }

  /**
   * Build the reverse reaction table.
   * Rows where the compound is from own inventory show [OWN] in the BuySrc column
   * and display the ACTUAL_SELL price as the cost basis.
   */
  function buildReverseTable(rows, sellMode, buyMode, circularSet) {
    circularSet = circularSet||{};
    var batch = typeof LAB_REACTION_AMOUNT==='number'?LAB_REACTION_AMOUNT:5;
    var lines = [
      '=== Reverse Reaction (Breakdown) Profitability ===',
      'Buy compound ('+buyMode+') -> reverseReaction -> Sell reagents ('+sellMode+')',
      'Batch: '+batch,
      '✓=Actionable ~=Theoretical ✗=No data  ⇄=CIRCULAR  [OWN]=cost is opportunity cost (ACTUAL_SELL)',
      '',
      [padR('Compound',10),padR('BuySrc',7),padL('BuyVol',8),padR('Reagents',12),
       padR('SellSrc',8),padL('Profit/u',10),padL('Margin%',8),padR('Act',3)].join(' ')
    ];
    for (var i=0;i<rows.length;i++) {
      var r=rows[i];
      var sellSrc = (r.priceASource==='NONE'||r.priceBSource==='NONE')?'NONE':
                   (r.priceASource==='HIST'||r.priceBSource==='HIST')?'HIST':'ASELL';
      var suffix = '';
      if (circularSet[r.resource]) suffix += ' ⇄';
      if (r.isOwnInventory) suffix += ' [OWN]';
      lines.push([
        padR(r.resource,10), padR(r.compoundSource,7), padL(fmtVol(r.compoundVolume),8),
        padR(r.reagentA+'+'+r.reagentB,12), padR(sellSrc,8),
        padL(fmt(r.profitPerUnit),10),
        padL(r.marginPct===null?'n/a':fmtS(r.marginPct)+'%',8),
        padR(r.actionable,3)
      ].join(' ') + suffix);
    }
    return lines.join('\n');
  }

  // ===== Time helper =====
  function getPT() {
    var now = new Date();
    try {
      return now.toLocaleString('en-US',{
        timeZone:'America/Los_Angeles', weekday:'short', year:'numeric', month:'short',
        day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true
      })+' PT';
    } catch(e) {
      return now.toUTCString()+' UTC';
    }
  }

  // ===== global.marketAnalysis =====
  global.marketAnalysis = function(outputMode, inputMode) {
    var outMode = outputMode||'ACTUAL_SELL';
    var inMode  = inputMode ||'ACTUAL_BUY';
    var rp = buildReactionMap();
    var labList = listAllLabProducts(rp);

    // Build once, share across all compound evaluations.
    var ownSellResources = buildOwnSellResourceSet();

    var factoryRows = [];
    for (var i=0;i<FACTORY_TARGETS.length;i++) {
      var r=analyzeFactoryCommodity(FACTORY_TARGETS[i],outMode,inMode);
      if (r&&r.found) factoryRows.push(r);
    }
    factoryRows.sort(byMargin);

    var decompRows = [];
    for (var d=0;d<FACTORY_DECOMPRESSION_TARGETS.length;d++) {
      var r=analyzeFactoryDecompression(FACTORY_DECOMPRESSION_TARGETS[d],outMode,inMode);
      if (r&&r.found) decompRows.push(r);
    }
    decompRows.sort(byMargin);

    var labRows = [];
    for (var j=0;j<labList.length;j++) {
      var r=analyzeLabProduct(labList[j],rp,outMode,inMode,ownSellResources);
      if (r&&r.found) labRows.push(r);
    }
    labRows.sort(byMargin);

    var revRows = [];
    for (var k=0;k<labList.length;k++) {
      var r=analyzeReverseReaction(labList[k],rp,outMode,inMode,ownSellResources);
      if (r&&r.found) revRows.push(r);
    }
    revRows.sort(byMargin);

    var pfwd={}, prev={}, circ={};
    for (var pf=0;pf<labRows.length;pf++)  if (labRows[pf].profit>0)  pfwd[labRows[pf].resource]=true;
    for (var pr=0;pr<revRows.length;pr++)  if (revRows[pr].profit>0)   prev[revRows[pr].resource]=true;
    for (var cr in pfwd) if (prev[cr]) circ[cr]=true;

    var parts = [
      'Generated: '+getPT(),
      'Pricing: ACTUAL_SELL / ACTUAL_BUY | Lab margins include creep cost (RCL 8)',
      'Factory margins include creep cost (compression + decompression)',
      'Own-inventory inputs priced at ACTUAL_SELL (opportunity cost) -- matches autoTrader',
      '',
      buildFactoryTable(factoryRows, outMode, inMode),
      '',
      buildDecompressionTable(decompRows, outMode, inMode),
      '',
      buildLabTable(labRows, outMode, inMode, circ),
      '',
      buildReverseTable(revRows, outMode, inMode, circ)
    ];

    var circKeys = Object.keys(circ).sort();
    if (circKeys.length > 0) {
      parts.push('');
      parts.push('=== ⇄ CIRCULAR WARNINGS (both dirs profitable — spread artifact) ===');
      parts.push('autoTrader skips these entirely.');
      parts.push('');
      parts.push([padR('Compound',10),padL('Fwd%',7),padL('Rev%',7),
                  padL('Bid',8),padL('Ask',8)].join(' '));
      for (var ci=0;ci<circKeys.length;ci++) {
        var ck=circKeys[ci];
        var fw=null,rv=null;
        for (var fi=0;fi<labRows.length;fi++) if (labRows[fi].resource===ck){fw=labRows[fi];break;}
        for (var ri=0;ri<revRows.length;ri++) if (revRows[ri].resource===ck){rv=revRows[ri];break;}
        parts.push([
          padR(ck,10),
          padL(fw&&fw.marginPct!==null?fmtS(fw.marginPct)+'%':'n/a',7),
          padL(rv&&rv.marginPct!==null?fmtS(rv.marginPct)+'%':'n/a',7),
          padL(rv&&rv.compoundPrice!==null?fmt(rv.compoundPrice):'n/a',8),
          padL(fw&&fw.unitPrice!==null?fmt(fw.unitPrice):'n/a',8)
        ].join(' '));
      }
    }
    return parts.join('\n');
  };

  // ===== global.reverseReactionAnalysis =====
  global.reverseReactionAnalysis = function(sellMode, buyMode) {
    sellMode = sellMode||'ACTUAL_SELL'; buyMode = buyMode||'ACTUAL_BUY';
    var rp=buildReactionMap(), list=listAllLabProducts(rp), rows=[];
    var ownSellResources = buildOwnSellResourceSet();
    for (var i=0;i<list.length;i++) {
      var r=analyzeReverseReaction(list[i],rp,sellMode,buyMode,ownSellResources);
      if (r&&r.found) rows.push(r);
    }
    rows.sort(byMargin);
    var ok=[],th=[],no=[];
    for (var j=0;j<rows.length;j++) {
      var r=rows[j];
      if (r.profit!==null&&r.profit>0) { if (r.actionable==='✓') ok.push(r); else th.push(r); } else no.push(r);
    }
    var batch=typeof LAB_REACTION_AMOUNT==='number'?LAB_REACTION_AMOUNT:5;
    var parts=['Generated: '+getPT(),'Reverse reactions use reagent cost only',
      'Own-inventory compounds priced at ACTUAL_SELL (opportunity cost) -- matches autoTrader','',
      '=== Reverse Reaction Analysis ===',
      'Buy compound ('+buyMode+') -> Break down -> Sell reagents ('+sellMode+')',
      'Batch: '+batch,''];
    if (ok.length) {
      parts.push('--- ✓ ACTIONABLE ---');
      parts.push([padR('Compound',10),padR('->Reagents',12),padL('BuyCost',10),padL('SellRev',10),padL('Profit',10),padL('Margin%',8),padL('BuyVol',8),padL('VolA',7),padL('VolB',7),padR('',5)].join(' '));
      for (var a=0;a<ok.length;a++) {
        var r=ok[a];
        var ownTag = r.isOwnInventory ? '[OWN]' : '';
        parts.push([padR(r.resource,10),padR(r.reagentA+'+'+r.reagentB,12),padL(fmt(r.inputCost),10),padL(fmt(r.revenue),10),padL('+'+fmt(r.profit),10),padL(fmtS(r.marginPct)+'%',8),padL(fmtVol(r.compoundVolume),8),padL(fmtVol(r.priceAVolume),7),padL(fmtVol(r.priceBVolume),7),' '+ownTag].join(' '));
      }
      parts.push('');
    }
    if (th.length) {
      parts.push('--- ~ THEORETICAL ---');
      parts.push([padR('Compound',10),padR('->Reagents',12),padL('Profit',10),padL('Margin%',8),padL('BuyVol',8),padR('Warning',35)].join(' '));
      for (var t=0;t<th.length;t++) {
        var r=th[t];
        var w = r.isOwnInventory ? '⚠ own-inv @ ACTUAL_SELL' : ('⚠ '+(r.warnings[0]||''));
        parts.push([padR(r.resource,10),padR(r.reagentA+'+'+r.reagentB,12),padL('+'+fmt(r.profit),10),padL(fmtS(r.marginPct)+'%',8),padL(fmtVol(r.compoundVolume),8),padR(w,35)].join(' '));
      }
      parts.push('');
    }
    if (!ok.length&&!th.length) { parts.push('--- No profitable breakdown opportunities ---'); parts.push(''); }
    parts.push('--- TOP UNPROFITABLE (limit 10) ---');
    parts.push([padR('Compound',10),padR('->Reagents',12),padL('Loss/unit',10),padL('Margin%',8)].join(' '));
    for (var u=0;u<Math.min(10,no.length);u++) { var r=no[u]; parts.push([padR(r.resource,10),padR(r.reagentA+'+'+r.reagentB,12),padL(fmt(r.profitPerUnit),10),padL(r.marginPct===null?'n/a':fmtS(r.marginPct)+'%',8)].join(' ')); }
    return parts.join('\n');
  };

  // ===== global.decompressionAnalysis =====
  global.decompressionAnalysis = function(outMode, inMode) {
    outMode=outMode||'ACTUAL_SELL'; inMode=inMode||'ACTUAL_BUY';
    var rows=[];
    for (var i=0;i<FACTORY_DECOMPRESSION_TARGETS.length;i++) { var r=analyzeFactoryDecompression(FACTORY_DECOMPRESSION_TARGETS[i],outMode,inMode); if (r&&r.found) rows.push(r); }
    rows.sort(byMargin);
    var ok=[],th=[],no=[];
    for (var j=0;j<rows.length;j++) { var r=rows[j]; if (r.profit!==null&&r.profit>0){if(r.actionable==='✓')ok.push(r);else th.push(r);}else no.push(r); }
    var parts=['Generated: '+getPT(),'Factory margins use ingredient cost only','',
      '=== Factory Decompression Analysis ===','100 bar + 200 energy → 500 mineral | 1 battery → 50 energy',''];
    if (ok.length) {
      parts.push('--- ✓ ACTIONABLE ---');
      parts.push([padR('Output',8),padR('FromBar',12),padL('Ingred',10),padL('Revenue',10),padL('Profit',10),padL('Margin%',8),padL('Cd/t',5),padL('BarVol',8)].join(' '));
      for (var a=0;a<ok.length;a++) { var r=ok[a]; parts.push([padR(r.resource,8),padR(r.barName,12),padL(fmt(r.ingredientCost),10),padL(fmt(r.revenue),10),padL('+'+fmt(r.profit),10),padL(fmtS(r.marginPct)+'%',8),padL(r.cooldown!==null?String(r.cooldown):'n/a',5),padL(fmtVol(r.barVolume),8)].join(' ')); }
      parts.push('');
    }
    if (!ok.length&&!th.length) { parts.push('--- No profitable decompression opportunities ---'); parts.push(''); }
    parts.push('--- ALL RESULTS ---');
    parts.push([padR('Output',8),padR('FromBar',12),padL('Ingred',10),padL('Profit',10),padL('Margin%',8),padL('Cd/t',5)].join(' '));
    for (var u=0;u<rows.length;u++) { var r=rows[u]; parts.push([padR(r.resource,8),padR(r.barName,12),padL(fmt(r.ingredientCost),10),padL(fmt(r.profit),10),padL(r.marginPct===null?'n/a':fmtS(r.marginPct)+'%',8),padL(r.cooldown!==null?String(r.cooldown):'n/a',5)].join(' ')); }
    return parts.join('\n');
  };

  // ===== global.analyzeBreakdown =====
  global.analyzeBreakdown = function(compound, sellMode, buyMode) {
    if (!compound) return 'Usage: analyzeBreakdown("XGH2O")';
    sellMode=sellMode||'ACTUAL_SELL'; buyMode=buyMode||'ACTUAL_BUY';
    var rp=buildReactionMap();
    var ownSellResources = buildOwnSellResourceSet();
    var rr=analyzeReverseReaction(compound,rp,sellMode,buyMode,ownSellResources);
    if (!rr||!rr.found) return 'Error: '+compound+' is not a valid compound';

    // Header label differs depending on whether cost is own-inventory opportunity cost
    var costLabel = rr.isOwnInventory
      ? 'Own inventory (opportunity cost @ ACTUAL_SELL): '+fmt(rr.compoundPrice)+' [OWN]'
      : 'Buy: '+fmt(rr.compoundPrice)+' ['+rr.compoundSource+']';

    var parts=['Generated: '+getPT(),'','=== Breakdown: '+compound+' ===','',
      costLabel+' | vol: '+fmtVol(rr.compoundVolume)+' | cost×'+rr.batch+': '+fmt(rr.inputCost),'',
      'Produces:',
      '  '+rr.reagentA+': sell @ '+fmt(rr.priceA)+' ['+rr.priceASource+'] vol:'+fmtVol(rr.priceAVolume)+' -> '+fmt(rr.revenueA),
      '  '+rr.reagentB+': sell @ '+fmt(rr.priceB)+' ['+rr.priceBSource+'] vol:'+fmtVol(rr.priceBVolume)+' -> '+fmt(rr.revenueB),
      '  Revenue: '+fmt(rr.revenue),'',
      'Profit/batch: '+fmt(rr.profit)+' | /unit: '+fmt(rr.profitPerUnit)+' | Margin: '+(rr.marginPct===null?'n/a':fmtS(rr.marginPct)+'%'),
      'Actionable: '+rr.actionable];
    if (rr.warnings.length){parts.push('');for(var w=0;w<rr.warnings.length;w++)parts.push('⚠ '+rr.warnings[w]);}
    parts.push('');
    if (rr.profit>0&&rr.actionable==='✓') parts.push('>>> ✓ ACTIONABLE <<<');
    else if (rr.profit>0) parts.push('>>> ~ THEORETICAL <<<');
    else parts.push('Not profitable.');
    return parts.join('\n');
  };

  // ===== global.analyzeForward =====
  global.analyzeForward = function(compound, outMode, inMode) {
    if (!compound) return 'Usage: analyzeForward("XGH2O")';
    outMode=outMode||'ACTUAL_SELL'; inMode=inMode||'ACTUAL_BUY';
    var rp=buildReactionMap();
    var ownSellResources = buildOwnSellResourceSet();
    var row=analyzeLabProduct(compound,rp,outMode,inMode,ownSellResources);
    if (!row||!row.found) return 'Error: '+compound+' not a valid lab product';
    var pair=rp[compound], eInfo=computeActualBuyPrice(RESOURCE_ENERGY);

    // Label reagent sources: OWN means priced at ACTUAL_SELL (opportunity cost)
    var aLabel = row.reagentA + (row.inputAIsOwn ? ' [OWN@ASELL]' : ' ['+row.inputASource+']');
    var bLabel = row.reagentB + (row.inputBIsOwn ? ' [OWN@ASELL]' : ' ['+row.inputBSource+']');

    var parts=['Generated: '+getPT(),'',
      '=== Forward Reaction: '+compound+' ===',
      'Reaction: '+pair[0]+' + '+pair[1]+' -> '+compound,
      'Cooldown: '+(row.reactionTime!==null?row.reactionTime+'t':'unknown'),'',
      'Energy:       '+fmt(eInfo.price)+' ['+eInfo.source+']','',
      'Costs (batch '+row.outQty+'):',
      '  '+aLabel+':'+Array(Math.max(1,14-aLabel.length)).join(' ')+'(per unit: ~'+fmt(row.reagentCost/row.outQty/2)+')',
      '  '+bLabel+':'+Array(Math.max(1,14-bLabel.length)).join(' ')+'(per unit: ~'+fmt(row.reagentCost/row.outQty/2)+')',
      '  Reagents:     '+fmt(row.reagentCost),
      '  Total:        '+fmt(row.inputCost),'',
      'Revenue: '+fmt(row.revenue)+' | Sell: '+fmt(row.unitPrice)+' ['+row.outputSource+'] vol:'+fmtVol(row.outputVolume),'',
      'Profit/batch: '+fmt(row.profit)+' | /unit: '+fmt(row.profitPerUnit)+' | Margin: '+(row.marginPct===null?'n/a':fmtS(row.marginPct)+'%'),
      'Actionable: '+row.actionable,''];
    if (row.inputAIsOwn||row.inputBIsOwn) {
      parts.push('Note: [OWN] reagents priced at ACTUAL_SELL (opportunity cost of own inventory).');
      parts.push('      Margins match what autoTrader will evaluate.');
      parts.push('');
    }
    if (row.profit>0&&row.actionable==='✓') parts.push('>>> ✓ ACTIONABLE <<<');
    else if (row.profit>0) parts.push('>>> ~ THEORETICAL <<<');
    else parts.push('Not profitable.');
    return parts.join('\n');
  };

  // ===== global.analyzeDecompression =====
  global.analyzeDecompression = function(baseResource, outMode, inMode) {
    if (!baseResource) return 'Usage: analyzeDecompression("U")';
    outMode=outMode||'ACTUAL_SELL'; inMode=inMode||'ACTUAL_BUY';
    var r=analyzeFactoryDecompression(baseResource,outMode,inMode);
    if (!r||!r.found) return 'Error: '+baseResource+' not valid. Options: '+FACTORY_DECOMPRESSION_TARGETS.join(', ');
    var parts=['Generated: '+getPT(),'',
      '=== Decompression: '+r.barName+' → '+r.resource+' ===',
      'Cooldown: '+(r.cooldown!==null?r.cooldown+'t':'n/a'),'',
      'Input bar: '+r.barName+' × '+r.barQty+' @ '+fmt(r.barPrice)+' ['+r.barSource+'] vol:'+fmtVol(r.barVolume)];
    if (r.energyQty>0) parts.push('Energy:    × '+r.energyQty+' @ '+fmt(r.energyPrice)+' ['+r.energySource+']');
    parts.push('Ingredient cost: '+fmt(r.ingredientCost));
    parts.push('Total cost:      '+fmt(r.inputCost),'');
    parts.push('Output: '+r.resource+' × '+r.outQty+' | Sell: '+fmt(r.unitPrice)+' ['+r.outputSource+'] vol:'+fmtVol(r.outputVolume));
    parts.push('Revenue: '+fmt(r.revenue),'');
    parts.push('Profit: '+fmt(r.profit)+' | /unit: '+fmt(r.profitPerUnit)+' | Margin: '+(r.marginPct===null?'n/a':fmtS(r.marginPct)+'%'));
    parts.push('Actionable: '+r.actionable);
    if (r.warnings.length){parts.push('');for(var w=0;w<r.warnings.length;w++)parts.push('⚠ '+r.warnings[w]);}
    parts.push('');
    if (r.profit>0&&r.actionable==='✓') parts.push('>>> ✓ ACTIONABLE <<<');
    else if (r.profit>0) parts.push('>>> ~ THEORETICAL <<<');
    else parts.push('Not profitable.');
    return parts.join('\n');
  };

  // ===== global.orderBook =====
  global.orderBook = function(resource) {
    if (!resource) return 'Usage: orderBook("ZO")';
    resource = resolveResource(resource);
    var si=getOrderInfo(resource,ORDER_SELL), bi=getOrderInfo(resource,ORDER_BUY);
    var hist=getAvg48h(resource), ab=computeActualBuyPrice(resource), as2=computeActualSellPrice(resource);
    var parts=['Generated: '+getPT(),'','=== Order Book: '+resource+' ===','',
      'Hist 48h: '+(hist===null?'n/a':fmt(hist)),'',
      'Execution prices:',
      '  ACTUAL_BUY:  '+fmt(ab.price)+' ['+ab.source+'] — best bid+0.1',
      '  ACTUAL_SELL: '+fmt(as2.price)+' ['+as2.source+'] — best ask-0.1 (cap hist×1.5)','',
      '--- SELL ORDERS ---','Count: '+si.count+' | Vol: '+fmtVol(si.totalVolume)];
    if (si.count>0){parts.push('Best ask: '+fmt(si.bestPrice),'');parts.push([padR('Price',12),padR('Available',12),padR('Room',10)].join(' '));for(var s=0;s<Math.min(10,si.orders.length);s++){var o=si.orders[s];parts.push([padL(fmt(o.price),12),padL(String(o.remainingAmount||o.amount),12),padR(o.roomName||'N/A',10)].join(' '));}}else{parts.push('  None.');}
    parts.push('','--- BUY ORDERS ---','Count: '+bi.count+' | Vol: '+fmtVol(bi.totalVolume));
    if (bi.count>0){parts.push('Best bid: '+fmt(bi.bestPrice),'');parts.push([padR('Price',12),padR('Wanted',12),padR('Room',10)].join(' '));for(var b=0;b<Math.min(10,bi.orders.length);b++){var o=bi.orders[b];parts.push([padL(fmt(o.price),12),padL(String(o.remainingAmount||o.amount),12),padR(o.roomName||'N/A',10)].join(' '));}}else{parts.push('  None.');}
    if (si.bestPrice!==null&&bi.bestPrice!==null){var sp=si.bestPrice-bi.bestPrice,spp=(sp/bi.bestPrice)*100;parts.push('','--- SPREAD ---','Bid: '+fmt(bi.bestPrice)+' | Ask: '+fmt(si.bestPrice),'Spread: '+fmt(sp)+' ('+fmtS(spp)+'%)'+(spp>100?' ⚠ ILLIQUID':''));}
    return parts.join('\n');
  };

  // ===== global.energyCost =====
  global.energyCost = function() {
    var eInfo = computeActualBuyPrice(RESOURCE_ENERGY);
    var parts=['Generated: '+getPT(),'','=== Energy Cost ===',
      'Price: '+fmt(eInfo.price)+' ['+eInfo.source+']'];
    return parts.join('\n');
  };

// ===== global.rawMarketData =====
global.rawMarketData = function(resourceFilter, includeAnalysis) {
  // Collect ALL resources
  var allResources = {};

  // Lab commodities
  for (var r in REACTION_TIME_TABLE) {
    if (REACTION_TIME_TABLE.hasOwnProperty(r)) allResources[r] = true;
  }

  // Factory commodities
  for (var f in FACTORY_COOLDOWN_TABLE) {
    if (FACTORY_COOLDOWN_TABLE.hasOwnProperty(f)) allResources[f] = true;
  }

  // Base minerals + energy
  var bases = ['U','L','Z','K','O','H','G','energy','X'];
  for (var b=0;b<bases.length;b++) allResources[bases[b]] = true;

  var resList = Object.keys(allResources).sort();

  // Filter if requested
  if (resourceFilter && resourceFilter !== 'all') {
    var fr = resolveResource(resourceFilter);
    if (resList.indexOf(fr) === -1) return JSON.stringify({error: 'Unknown resource: '+resourceFilter});
    resList = [fr];
  }

  var data = {
    generated: getPT(),
    timestamp: Date.now(),
    tick: Game.time,
    resources: {}
  };

  for (var i=0;i<resList.length;i++) {
    var res = resList[i];
    var hist = Game.market.getHistory(res) || [];
    var histData = [];
    for (var h=0;h<hist.length;h++) {
      histData.push({
        date: hist[h].date,
        avgPrice: hist[h].avgPrice,
        volume: hist[h].volume
      });
    }
    var buyInfo = computeActualBuyPrice(res);
    var sellInfo = computeActualSellPrice(res);
    var avg48h = getAvg48h(res);
    var buyOrders = getOrderInfo(res, ORDER_BUY);
    var sellOrders = getOrderInfo(res, ORDER_SELL);

    data.resources[res] = {
      history: histData,
      avg48h: avg48h,
      actualBuy: { price: buyInfo.price, source: buyInfo.source, volume: buyInfo.volume, orderCount: buyInfo.orderCount },
      actualSell: { price: sellInfo.price, source: sellInfo.source, volume: sellInfo.volume, orderCount: sellInfo.orderCount },
      spread: (buyInfo.price !== null && sellInfo.price !== null) ? sellInfo.price - buyInfo.price : null,
      spreadPct: (buyInfo.price !== null && sellInfo.price !== null && buyInfo.price > 0) ? ((sellInfo.price - buyInfo.price) / buyInfo.price * 100) : null,
      orderBook: {
        buys: {
          count: buyOrders.count,
          totalVolume: buyOrders.totalVolume,
          bestPrice: buyOrders.bestPrice,
          orders: buyOrders.orders.map(function(o) {
            return {
              id: o.id,
              price: o.price,
              amount: o.remainingAmount || o.amount || 0,
              roomName: o.roomName || null
            };
          })
        },
        sells: {
          count: sellOrders.count,
          totalVolume: sellOrders.totalVolume,
          bestPrice: sellOrders.bestPrice,
          orders: sellOrders.orders.map(function(o) {
            return {
              id: o.id,
              price: o.price,
              amount: o.remainingAmount || o.amount || 0,
              roomName: o.roomName || null
            };
          })
        }
      }
    };
  }

  // Energy reference
  var eInfo = computeActualBuyPrice(RESOURCE_ENERGY);
  data.energyPrice = eInfo.price;
  data.energySource = eInfo.source;

  // Optional: full analysis (forward/reverse/factory/decompression)
  if (includeAnalysis === true) {
    var rp = buildReactionMap();
    var ownSell = buildOwnSellResourceSet();
    data.analysis = {};
    data.factory = {};
    data.decompression = {};

    for (var ri=0;ri<resList.length;ri++) {
      var res = resList[ri];
      // Forward
      var fwd = analyzeLabProduct(res, rp, 'ACTUAL_SELL', 'ACTUAL_BUY', ownSell);
      if (fwd && fwd.found) {
        data.analysis[res] = data.analysis[res] || {};
        data.analysis[res].forward = {
          reagents: [fwd.reagentA, fwd.reagentB],
          costPerBatch: fwd.reagentCost,
          totalCost: fwd.inputCost,
          revenue: fwd.revenue,
          profit: fwd.profit,
          profitPerUnit: fwd.profitPerUnit,
          marginPct: fwd.marginPct,
          reactionTime: fwd.reactionTime,
          actionable: fwd.actionable
        };
      }
      // Reverse
      var rev = analyzeReverseReaction(res, rp, 'ACTUAL_SELL', 'ACTUAL_BUY', ownSell);
      if (rev && rev.found) {
        data.analysis[res] = data.analysis[res] || {};
        data.analysis[res].reverse = {
          reagents: [rev.reagentA, rev.reagentB],
          compoundPrice: rev.compoundPrice,
          isOwnInventory: rev.isOwnInventory,
          revenue: rev.revenue,
          profit: rev.profit,
          profitPerUnit: rev.profitPerUnit,
          marginPct: rev.marginPct,
          actionable: rev.actionable
        };
      }
      // Factory compression
      var fc = analyzeFactoryCommodity(res, 'ACTUAL_SELL', 'ACTUAL_BUY');
      if (fc && fc.found) {
        data.factory[res] = {
          outputQty: fc.outQty,
          unitPrice: fc.unitPrice,
          ingredientCost: fc.ingredientCost,
          totalCost: fc.inputCost,
          revenue: fc.revenue,
          profit: fc.profit,
          profitPerUnit: fc.profitPerUnit,
          marginPct: fc.marginPct,
          cooldown: fc.cooldown,
          actionable: fc.actionable
        };
      }
      // Decompression
      var dc = analyzeFactoryDecompression(res, 'ACTUAL_SELL', 'ACTUAL_BUY');
      if (dc && dc.found) {
        data.decompression[res] = {
          barName: dc.barName,
          outputQty: dc.outQty,
          barPrice: dc.barPrice,
          ingredientCost: dc.ingredientCost,
          totalCost: dc.inputCost,
          unitPrice: dc.unitPrice,
          revenue: dc.revenue,
          profit: dc.profit,
          profitPerUnit: dc.profitPerUnit,
          marginPct: dc.marginPct,
          cooldown: dc.cooldown,
          actionable: dc.actionable
        };
      }
    }
  }

  return JSON.stringify(data, null, 2);
};


})();
