// LLM: Read docs/codex.js before reviewing or changing this file.
// marketAnalysis.js
// Console globals: marketAnalysis, orderBook, rawMarketData, energyCost, analyzeForward, analyzeBreakdown, analyzeDecompression, reverseReactionAnalysis, decompressionAnalysis
// Example: marketAnalysis(RESOURCE_CATALYZED_GHODIUM_ACID) - Analyze market spread, volume, and profit
// Example: orderBook(RESOURCE_ENERGY) - Display current order book for resource
// Example: rawMarketData(RESOURCE_HYDROGEN) - Inspect raw market pricing and volume records
// Example: energyCost('E1N1', 'E2N2') - Calculate terminal transfer energy cost between rooms
// Example: analyzeForward('XGH2O') - Analyze forward synthesis margins for compound
// Example: analyzeBreakdown('XGH2O') - Analyze reverse breakdown profitability for compound
// Example: analyzeDecompression('battery') - Analyze compression/decompression margins
// Example: reverseReactionAnalysis('GH2O') - Run full reverse reaction economic analysis
// Example: decompressionAnalysis() - Display empire-wide commodity decompression opportunities
//   marketAnalysis()  Factory and lab opportunity report. Hides rows with
//     no price data by default; pass 'all' or true to include them.
//   reverseReactionAnalysis(resource?)   Reverse-reaction report.
//   decompressionAnalysis(resource?)     Factory decompression report.
//   orderBook(resource)                  Live external order book.
//   analyzeBreakdown(compound)           Detailed reverse lab analysis.
//   analyzeForward(compound)             Detailed forward lab analysis.
//   analyzeDecompression(resource)       Detailed factory decompression analysis.
//   energyCost()                         Current energy reference price.
//   rawMarketData(resource?, includeAnalysis?)  JSON market diagnostic data.
(function registerMarketAnalysisGlobal() {
  const e = require("util");
  const t = require("marketPricing");
  const r = 3e3;
  const o = {
    OH: 20,
    ZK: 5,
    UL: 5,
    G: 5,
    UH: 10,
    UO: 10,
    KH: 10,
    KO: 10,
    LH: 15,
    LO: 10,
    ZH: 20,
    ZO: 20,
    GH: 10,
    GO: 10,
    UH2O: 5,
    UHO2: 5,
    KH2O: 5,
    KHO2: 5,
    LH2O: 10,
    LHO2: 5,
    ZH2O: 40,
    ZHO2: 5,
    GH2O: 15,
    GHO2: 30,
    XUH2O: 60,
    XUHO2: 60,
    XKH2O: 60,
    XKHO2: 60,
    XLH2O: 80,
    XLHO2: 60,
    XZH2O: 160,
    XZHO2: 60,
    XGH2O: 80,
    XGHO2: 150
  };
  function reactionTimeFor(e) {
    if (typeof REACTION_TIME !== "undefined" && REACTION_TIME && typeof REACTION_TIME[e] === "number") {
      return REACTION_TIME[e];
    }
    return o[e] || 10;
  }
  function factoryCooldownFor(e) {
    if (typeof COMMODITIES !== "undefined" && COMMODITIES && COMMODITIES[e] && typeof COMMODITIES[e].cooldown === "number") {
      return COMMODITIES[e].cooldown;
    }
    return 20;
  }
  const n = [ "oxidant", "reductant", "zynthium_bar", "lemergium_bar", "utrium_bar", "keanium_bar", "purifier", "battery", "ghodium_melt", "alloy", "wire", "cell", "condensate", "composite", "tube", "phlegm", "switch", "concentrate", "crystal", "fixtures", "tissue", "transistor", "extract", "liquid", "frame", "muscle", "microchip", "spirit", "hydraulics", "organoid", "circuit", "emanation", "machine", "organism", "device", "essence" ];
  const i = [ "U", "L", "Z", "K", "O", "H", "G", "energy" ];
  const c = {
    U: "utrium_bar",
    L: "lemergium_bar",
    Z: "zynthium_bar",
    K: "keanium_bar",
    O: "oxidant",
    H: "reductant",
    G: "ghodium_melt",
    energy: "battery"
  };
  function fmt(e) {
    return typeof e === "number" && isFinite(e) ? e.toFixed(2) : "n/a";
  }
  function fmtS(e) {
    return typeof e === "number" && isFinite(e) ? e.toFixed(1) : "n/a";
  }
  function padR(e, t) {
    e = String(e);
    while (e.length < t) e += " ";
    return e;
  }
  function padL(e, t) {
    e = String(e);
    while (e.length < t) e = " " + e;
    return e;
  }
  function fmtVol(e) {
    if (typeof e !== "number" || !isFinite(e) || e <= 0) return "0";
    if (e >= 1e6) return (e / 1e6).toFixed(1) + "M";
    if (e >= 1e3) return (e / 1e3).toFixed(1) + "K";
    return String(Math.floor(e));
  }
  function byCreditsPerTick(e, t) {
    const r = finiteNumber(e.creditsPerTick) ? e.creditsPerTick : -Infinity;
    const o = finiteNumber(t.creditsPerTick) ? t.creditsPerTick : -Infinity;
    if (o !== r) return o - r;
    const n = e.profit === null ? -Infinity : e.profit;
    const i = t.profit === null ? -Infinity : t.profit;
    return i - n;
  }
  function resolveResource(e) {
    if (typeof e !== "string") return e;
    if (typeof RESOURCES_ALL !== "undefined" && RESOURCES_ALL.indexOf(e) !== -1) return e;
    const t = global[e];
    if (typeof t === "string" && typeof RESOURCES_ALL !== "undefined" && RESOURCES_ALL.indexOf(t) !== -1) return t;
    const r = e.toLowerCase();
    if (typeof RESOURCES_ALL !== "undefined" && RESOURCES_ALL.indexOf(r) !== -1) return r;
    return e;
  }
  function finiteNumber(e) {
    return typeof e === "number" && isFinite(e);
  }
  function scoreProduction(e) {
    if (!e) return null;
    const t = finiteNumber(e.cycles) && e.cycles > 0 ? e.cycles : 1;
    if (!finiteNumber(e.materialCost) || !finiteNumber(e.revenue)) return null;
    if (e.materialCost < 0 || e.revenue < 0) return null;
    const r = e.materialCost * t;
    const o = e.revenue * t;
    const n = finiteNumber(e.terminalEnergyCost) ? Math.max(0, e.terminalEnergyCost) : 0;
    const i = finiteNumber(e.supportCost) ? Math.max(0, e.supportCost) : 0;
    const c = finiteNumber(e.repriceAllowance) ? Math.max(0, e.repriceAllowance) : e.skipInputFees ? 0 : r * .02;
    const u = finiteNumber(e.marketFees) ? Math.max(0, e.marketFees) : ((e.skipInputFees ? 0 : r) + o) * .05;
    const s = r + n + u + i + c;
    const a = o - s;
    const l = finiteNumber(e.cycleTicks) && e.cycleTicks > 0 ? e.cycleTicks : 1;
    const p = finiteNumber(e.parallelism) && e.parallelism > 0 ? e.parallelism : 1;
    const d = Math.max(1, l * t / p);
    const f = finiteNumber(e.expectedBuyTicks) ? Math.max(0, e.expectedBuyTicks) : 250;
    const m = finiteNumber(e.expectedStageTicks) ? Math.max(0, e.expectedStageTicks) : 50;
    const g = finiteNumber(e.expectedSellTicks) ? Math.max(0, e.expectedSellTicks) : 250;
    const y = finiteNumber(e.expectedQueueTicks) ? Math.max(0, e.expectedQueueTicks) : 0;
    const L = Math.max(1, y + f + m + d + g);
    return {
      materialCost: r,
      terminalEnergyCost: n,
      marketFees: u,
      repriceAllowance: c,
      supportCost: i,
      totalCost: s,
      expectedRevenue: o,
      expectedNetProfit: a,
      expectedProductionTicks: d,
      expectedBuyTicks: f,
      expectedStageTicks: m,
      expectedSellTicks: g,
      expectedQueueTicks: y,
      expectedElapsedTicks: L,
      productionCreditsPerTick: a / d,
      creditsPerTick: a / L,
      breakEven: a > 0
    };
  }
  function scoreRow(e, t) {
    const r = typeof LAB_REACTION_AMOUNT === "number" && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    const o = t === "factory" ? 12 : Math.ceil(3e3 / r);
    const n = scoreProduction({
      materialCost: e.inputCost,
      revenue: e.revenue,
      cycles: o,
      cycleTicks: t === "factory" ? factoryCooldownFor(e.resource) : reactionTimeFor(e.resource),
      parallelism: 1,
      expectedBuyTicks: 400,
      expectedStageTicks: t === "factory" ? 40 : 80,
      expectedSellTicks: 300,
      expectedQueueTicks: 0
    });
    if (n) for (var i in n) e[i] = n[i]; else {
      e.creditsPerTick = null;
      e.expectedNetProfit = null;
      e.expectedElapsedTicks = null;
      e.breakEven = false;
    }
    return e;
  }
  function getOrderInfo(t, r) {
    const o = e.marketOrders(t, r);
    const n = [];
    let i = 0;
    for (var c = 0; c < o.length; c++) {
      const t = o[c], r = e.getOrderRemaining(t);
      if (r > 0) {
        n.push(t);
        i += r;
      }
    }
    if (!n.length) return {
      count: 0,
      totalVolume: 0,
      bestPrice: null,
      orders: []
    };
    n.sort(function(e, t) {
      return r === ORDER_BUY ? t.price - e.price : e.price - t.price;
    });
    return {
      count: n.length,
      totalVolume: i,
      bestPrice: n[0].price,
      orders: n
    };
  }
  const u = e.getMyRooms;
  function buildOwnSellResourceSet() {
    const t = {};
    const r = Game.market.orders;
    if (!r) return t;
    for (var o in r) {
      const n = r[o];
      if (n && n.type === ORDER_SELL && e.getOrderRemaining(n) > 0) {
        t[n.resourceType] = true;
      }
    }
    return t;
  }
  function computePassiveBuyPrice(e) {
    const r = t.getPriceProfile(e);
    const o = e === RESOURCE_ENERGY;
    const n = o ? t.getStatusEnergyPrice() : r.postedBuyPrice;
    return {
      price: n > 0 ? n : null,
      source: n > 0 ? o && !(r.postedBuyPrice > 0) ? "STATUS" : r.postedBuySource || "NONE" : "NONE",
      orderCount: r.bidLevels || 0,
      volume: r.referenceBidVolume || 0
    };
  }
  function getInputBuyPrice(e, r, o) {
    const n = t.getInputBuyQuote(e, r || 0);
    const i = t.getPriceProfile(e);
    if (n && n.price > 0) {
      return {
        price: n.price,
        source: n.source || "NONE",
        orderCount: i.askLevels || 0,
        volume: i.referenceAskVolume || 0
      };
    }
    return {
      price: null,
      source: "NONE",
      orderCount: 0,
      volume: 0
    };
  }
  function computePassiveSellPrice(e) {
    const r = t.getPriceProfile(e);
    return {
      price: r.postedSellPrice,
      source: r.postedSellPrice > 0 ? r.postedSellSource || "NONE" : "NONE",
      orderCount: r.askLevels || 0,
      volume: r.referenceAskVolume || 0
    };
  }
  function getVolumeWeightedBuyPrice(e, o, n) {
    const i = t.executableBuyQuote(e, o || r, n);
    const c = t.getBook(e);
    if (i && i.price > 0) {
      return {
        price: i.price,
        source: "DEAL",
        orderCount: c.askCount || 0,
        volume: i.amount || 0,
        transferEnergy: i.transferEnergy || 0
      };
    }
    return getInputBuyPrice(e, o, n);
  }
  function buildBook(e) {
    return t.getBook(e);
  }
  function getAvg48h(e) {
    return t.getAvg48h(e);
  }
  function priceOfWithSource(e, r) {
    e = resolveResource(e);
    if (r === "PASSIVE_SELL" || r === "ACTUAL_SELL") return computePassiveSellPrice(e);
    if (r === "PASSIVE_BUY" || r === "ACTUAL_BUY") return computePassiveBuyPrice(e);
    if (e === RESOURCE_ENERGY && r === "sell") return computePassiveBuyPrice(e);
    if (r === "avg") {
      const t = getAvg48h(e);
      return t !== null ? {
        price: t,
        source: "HIST",
        orderCount: 0,
        volume: 0
      } : {
        price: null,
        source: "NONE",
        orderCount: 0,
        volume: 0
      };
    }
    if (r === "buy" || r === "sell") {
      const o = t.getPriceProfile(e);
      const n = r === "buy" ? o.buyPrice : o.sellPrice;
      if (n !== null) {
        const e = r === "buy" ? o.buyLiquidity : o.sellLiquidity;
        return {
          price: n,
          source: e === "deep" ? "LIVE" : "LIVE_THIN",
          orderCount: r === "buy" ? o.askLevels : o.bidLevels,
          volume: r === "buy" ? o.referenceAskVolume : o.referenceBidVolume
        };
      }
      if (o.marketPriceSource === "THEORETICAL" && o.marketPrice !== null) {
        return {
          price: o.marketPrice,
          source: "THEORETICAL",
          orderCount: 0,
          volume: 0
        };
      }
      return {
        price: null,
        source: "NONE",
        orderCount: 0,
        volume: 0
      };
    }
    return {
      price: null,
      source: "NONE",
      orderCount: 0,
      volume: 0
    };
  }
  function conversionSellPriceInfo(e, r) {
    if (t && typeof t.getConversionExitQuote === "function") {
      const o = t.getConversionExitQuote(e, r);
      if (o && o.price > 0) {
        return {
          price: o.price,
          source: o.source || o.method || "LIVE",
          orderCount: o.orderCount || 0,
          volume: o.amount || 0
        };
      }
    }
    return computePassiveSellPrice(e);
  }
  function isLive(e) {
    return e === "LIVE" || e === "ABUY" || e === "ASELL" || e === "OWN" || e === "LIVE_BID" || e === "CROSSED_BID" || e === "LIVE_ASK" || e === "DEAL";
  }
  function analyzeFactoryCommodity(e, t, r) {
    const o = COMMODITIES && COMMODITIES[e];
    if (!o) return {
      resource: e,
      found: false
    };
    const n = typeof o.amount === "number" && o.amount > 0 ? o.amount : 1;
    const i = o.components || {};
    let c = 0, u = true, s = false;
    for (var a in i) {
      if (!i.hasOwnProperty(a)) continue;
      const e = typeof i[a] === "number" ? i[a] : 0;
      const t = a === RESOURCE_ENERGY ? getInputBuyPrice(a, e) : getVolumeWeightedBuyPrice(a);
      if (!(t.price > 0)) {
        s = true;
        u = false;
        continue;
      }
      c += t.price * e;
      if (!isLive(t.source)) u = false;
    }
    const l = s ? null : c;
    const p = priceOfWithSource(e, t);
    const d = p.price;
    const f = d === null ? null : d * n;
    const m = f === null || l === null ? null : f - l;
    const g = m === null ? null : m / n;
    const y = p.price !== null ? isLive(p.source) && u ? "✓" : "~" : "✗";
    const L = factoryCooldownFor(e);
    return scoreRow({
      resource: e,
      found: true,
      outQty: n,
      unitPrice: d,
      revenue: f,
      ingredientCost: c,
      inputCost: l,
      profit: m,
      profitPerUnit: g,
      outputSource: p.source,
      outputVolume: p.volume,
      outputOrderCount: p.orderCount,
      allInputsLive: u,
      actionable: y,
      cooldown: L
    }, "factory");
  }
  function analyzeFactoryDecompression(e, t, r) {
    const o = COMMODITIES && COMMODITIES[e];
    let n, i, u;
    if (o && o.components) {
      n = typeof o.amount === "number" && o.amount > 0 ? o.amount : 1;
      i = o.components;
      u = c[e];
    } else {
      u = c[e];
      if (!u) return {
        resource: e,
        found: false
      };
      if (e === "energy") {
        n = 50;
        i = {
          battery: 1
        };
      } else {
        n = 500;
        i = {};
        i[u] = 100;
        i["energy"] = 200;
      }
    }
    if (!u) return {
      resource: e,
      found: false
    };
    let s = 0, a = true, l = false, p = null, d = null;
    for (var f in i) {
      if (!i.hasOwnProperty(f)) continue;
      const e = typeof i[f] === "number" ? i[f] : 0;
      const t = f === "energy" ? getInputBuyPrice(f, e) : getVolumeWeightedBuyPrice(f);
      if (!(t.price > 0)) l = true; else s += t.price * e;
      if (f === u) p = t; else if (f === "energy") d = t;
      if (!isLive(t.source)) a = false;
    }
    const m = l ? null : s;
    const g = priceOfWithSource(e, t);
    const y = g.price;
    const L = y === null ? null : y * n;
    const P = L === null ? null : L - m;
    const S = P === null ? null : P / n;
    const E = g.price !== null ? isLive(g.source) && a ? "✓" : "~" : "✗";
    const b = [];
    if (p && !isLive(p.source)) b.push("No executable orders for " + u + " (using theoretical/profile value)");
    if (d && !isLive(d.source)) b.push("Energy has no deep executable market side");
    if (!isLive(g.source)) b.push("No executable orders for " + e + " (using theoretical/profile value)");
    const h = factoryCooldownFor(e);
    return scoreRow({
      resource: e,
      found: true,
      barName: u,
      outQty: n,
      barQty: i[u] || 0,
      energyQty: i["energy"] || 0,
      barPrice: p ? p.price : null,
      barSource: p ? p.source : "NONE",
      barVolume: p ? p.volume : 0,
      energyPrice: d ? d.price : null,
      energySource: d ? d.source : "NONE",
      ingredientCost: s,
      inputCost: m,
      unitPrice: y,
      outputSource: g.source,
      outputVolume: g.volume,
      revenue: L,
      profit: P,
      profitPerUnit: S,
      allInputsLive: a,
      actionable: E,
      warnings: b,
      cooldown: h
    }, "factory");
  }
  function buildReactionMap() {
    const e = {};
    if (!REACTIONS) return e;
    for (var t in REACTIONS) {
      if (!REACTIONS.hasOwnProperty(t)) continue;
      const o = REACTIONS[t];
      for (var r in o) {
        if (o.hasOwnProperty(r)) e[o[r]] = [ t, r ];
      }
    }
    return e;
  }
  function listAllLabProducts(e) {
    const t = [];
    for (var r in e) if (e.hasOwnProperty(r)) t.push(r);
    t.sort();
    return t;
  }
  function analyzeLabProduct(e, t, r, o, n) {
    const i = t[e];
    if (!i) return {
      resource: e,
      found: false
    };
    const c = typeof LAB_REACTION_AMOUNT === "number" && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    const u = i[0], s = i[1];
    const a = !!(n && n[u]);
    const l = !!(n && n[s]);
    const p = a ? priceOfWithSource(u, "PASSIVE_SELL") : getVolumeWeightedBuyPrice(u);
    const d = l ? priceOfWithSource(s, "PASSIVE_SELL") : getVolumeWeightedBuyPrice(s);
    const f = p.price !== null && d.price !== null ? p.price * c + d.price * c : null;
    const m = a ? "OWN" : p.source;
    const g = l ? "OWN" : d.source;
    const y = isLive(m) && isLive(g) && f !== null;
    const L = f;
    const P = priceOfWithSource(e, r);
    const S = P.price;
    const E = S === null ? null : S * c;
    const b = E === null || L === null ? null : E - L;
    const h = b === null ? null : b / c;
    const R = P.price !== null ? isLive(P.source) && y ? "✓" : "~" : "✗";
    const v = reactionTimeFor(e);
    return scoreRow({
      resource: e,
      found: true,
      outQty: c,
      unitPrice: S,
      revenue: E,
      reagentA: u,
      reagentB: s,
      reagentCost: f,
      inputCost: L,
      profit: b,
      profitPerUnit: h,
      outputSource: P.source,
      outputVolume: P.volume,
      outputOrderCount: P.orderCount,
      inputASource: m,
      inputBSource: g,
      inputAIsOwn: a,
      inputBIsOwn: l,
      allInputsLive: y,
      actionable: R,
      reactionTime: v
    }, "lab");
  }
  function analyzeReverseReaction(e, t, r, o, n) {
    const i = t[e];
    if (!i) return {
      resource: e,
      found: false
    };
    const c = typeof LAB_REACTION_AMOUNT === "number" && LAB_REACTION_AMOUNT > 0 ? LAB_REACTION_AMOUNT : 5;
    const u = i[0], s = i[1];
    const a = !!(n && n[e]);
    let l;
    if (a) {
      l = conversionSellPriceInfo(e, c);
    } else {
      l = getVolumeWeightedBuyPrice(e);
    }
    const p = l.price;
    const d = p === null ? null : p * c;
    const f = r === "PASSIVE_SELL" || r === "ACTUAL_SELL";
    const m = f ? conversionSellPriceInfo(u, c) : priceOfWithSource(u, r);
    const g = f ? conversionSellPriceInfo(s, c) : priceOfWithSource(s, r);
    const y = m.price, L = g.price;
    const P = y === null ? null : y * c, S = L === null ? null : L * c;
    const E = P !== null && S !== null ? P + S : null;
    const b = E !== null && d !== null ? E - d : null;
    const h = b === null ? null : b / c;
    const R = a ? "OWN" : l.source;
    const v = isLive(R), O = isLive(m.source), T = isLive(g.source);
    let A = "✗";
    const C = [];
    if (v && O && T) A = "✓"; else if (p !== null && (y !== null || L !== null)) A = "~";
    if (a) {
      C.push("Cost = opportunity cost (own inventory priced at PASSIVE_SELL ~" + fmt(p) + ")");
    } else if (!v && l.source === "THEORETICAL") {
      C.push("No executable orders for " + e + " (using theoretical value)");
    }
    if (!O && m.source === "THEORETICAL") C.push("No executable orders for " + u + " (using theoretical value)");
    if (!T && g.source === "THEORETICAL") C.push("No executable orders for " + s + " (using theoretical value)");
    return scoreRow({
      resource: e,
      found: true,
      reagentA: u,
      reagentB: s,
      batch: c,
      isOwnInventory: a,
      compoundPrice: p,
      compoundSource: R,
      compoundVolume: l.volume,
      priceA: y,
      priceASource: m.source,
      priceAVolume: m.volume,
      priceB: L,
      priceBSource: g.source,
      priceBVolume: g.volume,
      inputCost: d,
      revenueA: P,
      revenueB: S,
      revenue: E,
      profit: b,
      profitPerUnit: h,
      actionable: A,
      warnings: C
    }, "lab");
  }
  function buildFactoryTable(e, t, r) {
    const o = getInputBuyPrice(RESOURCE_ENERGY, 0);
    const n = [ "=== Factory Compression Profitability ===", "(out=" + t + ", in=" + r + ")", "Energy: " + fmt(o.price) + " [" + o.source + "]", "Legend: ✓=Actionable ~=Theoretical ✗=Missing data", "", [ padR("Item", 14), padL("Sell@", 8), padR("Src", 6), padL("Volume", 8), padL("Ingred", 9), padL("Profit/u", 10), padL("cr/t", 9), padL("Cd/t", 5), padR("Act", 3) ].join(" ") ];
    for (var i = 0; i < e.length; i++) {
      const t = e[i];
      n.push([ padR(t.resource, 14), padL(fmt(t.unitPrice), 8), padR(t.outputSource, 6), padL(fmtVol(t.outputVolume), 8), padL(fmt(t.ingredientCost), 9), padL(fmt(t.profitPerUnit), 10), padL(t.creditsPerTick === null ? "n/a" : fmtS(t.creditsPerTick), 9), padL(t.cooldown !== null ? String(t.cooldown) : "n/a", 5), padR(t.actionable, 3) ].join(" "));
    }
    return n.join("\n");
  }
  function buildDecompressionTable(e, t, r) {
    const o = getInputBuyPrice(RESOURCE_ENERGY, 0);
    const n = [ "=== Factory Decompression Profitability ===", "Buy bars (" + r + ") -> Decompress -> Sell base resource (" + t + ")", "Energy: " + fmt(o.price) + " [" + o.source + "] | 100 bar+200e→500 mineral | 1 battery→50 energy", "Legend: ✓=Actionable ~=Theoretical ✗=Missing data", "", [ padR("Output", 8), padR("Bar", 12), padR("BarSrc", 7), padL("BarVol", 8), padL("Sell@", 8), padL("Ingred", 9), padL("Profit/u", 10), padL("cr/t", 9), padL("Cd/t", 5), padR("Act", 3) ].join(" ") ];
    for (var i = 0; i < e.length; i++) {
      const t = e[i];
      n.push([ padR(t.resource, 8), padR(t.barName, 12), padR(t.barSource, 7), padL(fmtVol(t.barVolume), 8), padL(fmt(t.unitPrice), 8), padL(fmt(t.ingredientCost), 9), padL(fmt(t.profitPerUnit), 10), padL(t.creditsPerTick === null ? "n/a" : fmtS(t.creditsPerTick), 9), padL(t.cooldown !== null ? String(t.cooldown) : "n/a", 5), padR(t.actionable, 3) ].join(" "));
    }
    return n.join("\n");
  }
  function buildLabTable(e, t, r, o) {
    o = o || {};
    const n = computePassiveBuyPrice(RESOURCE_ENERGY);
    const i = typeof LAB_REACTION_AMOUNT === "number" ? LAB_REACTION_AMOUNT : 5;
    const c = [ "=== Lab Forward Reaction Profitability ===", "(out=" + t + ", in=" + r + ", batch=" + i + ")", "Energy: " + fmt(n.price) + " [" + n.source + "]", "Legend: ✓=Actionable ~=Theoretical ✗=Missing data  ⇄=CIRCULAR  [OWN]=own-inventory reagent cost", "", [ padR("Compound", 10), padL("Sell@", 8), padR("Src", 6), padL("Volume", 8), padL("Reagent", 9), padL("Profit/u", 10), padL("cr/t", 9), padL("Rxn/t", 6), padR("Act", 3) ].join(" ") ];
    for (var u = 0; u < e.length; u++) {
      const t = e[u];
      let r = "";
      if (o[t.resource]) r += " ⇄";
      if (t.inputAIsOwn || t.inputBIsOwn) {
        const e = [];
        if (t.inputAIsOwn && t.reagentA) e.push(t.reagentA);
        if (t.inputBIsOwn && t.reagentB) e.push(t.reagentB);
        r += " [OWN:" + e.join(",") + "]";
      }
      c.push([ padR(t.resource, 10), padL(fmt(t.unitPrice), 8), padR(t.outputSource, 6), padL(fmtVol(t.outputVolume), 8), padL(fmt(t.reagentCost), 9), padL(fmt(t.profitPerUnit), 10), padL(t.creditsPerTick === null ? "n/a" : fmtS(t.creditsPerTick), 9), padL(t.reactionTime !== null ? String(t.reactionTime) + "t" : "n/a", 6), padR(t.actionable, 3) ].join(" ") + r);
    }
    return c.join("\n");
  }
  function buildReverseTable(e, t, r, o) {
    o = o || {};
    const n = typeof LAB_REACTION_AMOUNT === "number" ? LAB_REACTION_AMOUNT : 5;
    const i = [ "=== Reverse Reaction (Breakdown) Profitability ===", "Buy compound (" + r + ") -> reverseReaction -> Sell reagents (" + t + ")", "Batch: " + n, "✓=Actionable ~=Theoretical ✗=No data  ⇄=CIRCULAR  [OWN]=cost is opportunity cost (PASSIVE_SELL)", "", [ padR("Compound", 10), padR("BuySrc", 7), padL("BuyVol", 8), padR("Reagents", 12), padR("SellSrc", 8), padL("Profit/u", 10), padL("cr/t", 9), padR("Act", 3) ].join(" ") ];
    for (var c = 0; c < e.length; c++) {
      const t = e[c];
      const r = t.priceASource === "NONE" || t.priceBSource === "NONE" ? "NONE" : t.priceASource === "HIST" || t.priceBSource === "HIST" ? "HIST" : "ASELL";
      let n = "";
      if (o[t.resource]) n += " ⇄";
      if (t.isOwnInventory) n += " [OWN]";
      i.push([ padR(t.resource, 10), padR(t.compoundSource, 7), padL(fmtVol(t.compoundVolume), 8), padR(t.reagentA + "+" + t.reagentB, 12), padR(r, 8), padL(fmt(t.profitPerUnit), 10), padL(t.creditsPerTick === null ? "n/a" : fmtS(t.creditsPerTick), 9), padR(t.actionable, 3) ].join(" ") + n);
    }
    return i.join("\n");
  }
  function getPT() {
    const e = new Date;
    try {
      return e.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true
      }) + " PT";
    } catch (t) {
      return e.toUTCString() + " UTC";
    }
  }
  global.marketAnalysis = function(e, t) {
    let r = false, o, c;
    if (e === "all" || e === true) {
      r = true;
    } else {
      o = e;
      c = t;
    }
    const u = o || "PASSIVE_SELL";
    const s = c || "PASSIVE_BUY";
    const a = buildReactionMap();
    const l = listAllLabProducts(a);
    const p = buildOwnSellResourceSet();
    const d = [];
    for (var f = 0; f < n.length; f++) {
      const e = analyzeFactoryCommodity(n[f], u, s);
      if (e && e.found) d.push(e);
    }
    d.sort(byCreditsPerTick);
    const m = [];
    for (var g = 0; g < i.length; g++) {
      const e = analyzeFactoryDecompression(i[g], u, s);
      if (e && e.found) m.push(e);
    }
    m.sort(byCreditsPerTick);
    const y = [];
    for (var L = 0; L < l.length; L++) {
      const e = analyzeLabProduct(l[L], a, u, s, p);
      if (e && e.found) y.push(e);
    }
    y.sort(byCreditsPerTick);
    const P = [];
    for (var S = 0; S < l.length; S++) {
      const e = analyzeReverseReaction(l[S], a, u, s, p);
      if (e && e.found) P.push(e);
    }
    P.sort(byCreditsPerTick);
    const E = {}, b = {}, h = {};
    for (var R = 0; R < y.length; R++) if (y[R].breakEven) E[y[R].resource] = true;
    for (var v = 0; v < P.length; v++) if (P[v].breakEven) b[P[v].resource] = true;
    for (var O in E) if (b[O]) h[O] = true;
    function dropMissing(e) {
      return r ? e : e.filter(function(e) {
        return e.actionable !== "✗";
      });
    }
    const T = dropMissing(d);
    const A = dropMissing(m);
    const C = dropMissing(y);
    const I = dropMissing(P);
    const N = [ "Generated: " + getPT(), "Pricing: canonical market profiles | Rows ranked by expected net credits/tick", "PASSIVE_SELL/PASSIVE_BUY are compatibility mode names for passive-order prices", "Score includes market fees and reprice allowance; terminal/support costs are conservative defaults", "Own-inventory inputs priced at PASSIVE_SELL (opportunity cost) -- matches autoTrader", r ? "" : "Hiding ✗ (no output price) — pass 'all' to include", "" ];
    if (T.length) {
      N.push(buildFactoryTable(T, u, s));
      N.push("");
    }
    if (A.length) {
      N.push(buildDecompressionTable(A, u, s));
      N.push("");
    }
    if (C.length) {
      N.push(buildLabTable(C, u, s, h));
      N.push("");
    }
    if (I.length) {
      N.push(buildReverseTable(I, u, s, h));
    }
    const k = Object.keys(h).sort();
    if (k.length > 0) {
      N.push("");
      N.push("=== ⇄ CIRCULAR WARNINGS (both dirs profitable — spread artifact) ===");
      N.push("autoTrader skips these entirely.");
      N.push("");
      N.push([ padR("Compound", 10), padL("Fwd cr/t", 9), padL("Rev cr/t", 9), padL("Bid", 8), padL("Ask", 8) ].join(" "));
      for (var B = 0; B < k.length; B++) {
        const e = k[B];
        let t = null, r = null;
        for (var V = 0; V < y.length; V++) if (y[V].resource === e) {
          t = y[V];
          break;
        }
        for (var _ = 0; _ < P.length; _++) if (P[_].resource === e) {
          r = P[_];
          break;
        }
        N.push([ padR(e, 10), padL(t && t.creditsPerTick !== null ? fmtS(t.creditsPerTick) : "n/a", 9), padL(r && r.creditsPerTick !== null ? fmtS(r.creditsPerTick) : "n/a", 9), padL(r && r.compoundPrice !== null ? fmt(r.compoundPrice) : "n/a", 8), padL(t && t.unitPrice !== null ? fmt(t.unitPrice) : "n/a", 8) ].join(" "));
      }
    }
    return N.join("\n");
  };
  global.reverseReactionAnalysis = function(e, t) {
    e = e || "PASSIVE_SELL";
    t = t || "PASSIVE_BUY";
    const r = buildReactionMap(), o = listAllLabProducts(r), n = [];
    const i = buildOwnSellResourceSet();
    for (var c = 0; c < o.length; c++) {
      const u = analyzeReverseReaction(o[c], r, e, t, i);
      if (u && u.found) n.push(u);
    }
    n.sort(byCreditsPerTick);
    const u = [], s = [], a = [];
    for (var l = 0; l < n.length; l++) {
      const e = n[l];
      if (e.breakEven) {
        if (e.actionable === "✓") u.push(e); else s.push(e);
      } else a.push(e);
    }
    const p = typeof LAB_REACTION_AMOUNT === "number" ? LAB_REACTION_AMOUNT : 5;
    const d = [ "Generated: " + getPT(), "Reverse reactions use reagent cost only", "Own-inventory compounds priced at PASSIVE_SELL (opportunity cost) -- matches autoTrader", "", "=== Reverse Reaction Analysis ===", "Buy compound (" + t + ") -> Break down -> Sell reagents (" + e + ")", "Batch: " + p, "" ];
    if (u.length) {
      d.push("--- ✓ ACTIONABLE ---");
      d.push([ padR("Compound", 10), padR("->Reagents", 12), padL("BuyCost", 10), padL("SellRev", 10), padL("Profit", 10), padL("cr/t", 9), padL("BuyVol", 8), padL("VolA", 7), padL("VolB", 7), padR("", 5) ].join(" "));
      for (var f = 0; f < u.length; f++) {
        const e = u[f];
        const t = e.isOwnInventory ? "[OWN]" : "";
        d.push([ padR(e.resource, 10), padR(e.reagentA + "+" + e.reagentB, 12), padL(fmt(e.inputCost), 10), padL(fmt(e.revenue), 10), padL("+" + fmt(e.profit), 10), padL(fmtS(e.creditsPerTick), 9), padL(fmtVol(e.compoundVolume), 8), padL(fmtVol(e.priceAVolume), 7), padL(fmtVol(e.priceBVolume), 7), " " + t ].join(" "));
      }
      d.push("");
    }
    if (s.length) {
      d.push("--- ~ THEORETICAL ---");
      d.push([ padR("Compound", 10), padR("->Reagents", 12), padL("Profit", 10), padL("cr/t", 9), padL("BuyVol", 8), padR("Warning", 35) ].join(" "));
      for (var m = 0; m < s.length; m++) {
        const e = s[m];
        const t = e.isOwnInventory ? "⚠ own-inv @ PASSIVE_SELL" : "⚠ " + (e.warnings[0] || "");
        d.push([ padR(e.resource, 10), padR(e.reagentA + "+" + e.reagentB, 12), padL("+" + fmt(e.profit), 10), padL(fmtS(e.creditsPerTick), 9), padL(fmtVol(e.compoundVolume), 8), padR(t, 35) ].join(" "));
      }
      d.push("");
    }
    if (!u.length && !s.length) {
      d.push("--- No profitable breakdown opportunities ---");
      d.push("");
    }
    d.push("--- TOP UNPROFITABLE (limit 10) ---");
    d.push([ padR("Compound", 10), padR("->Reagents", 12), padL("Loss/unit", 10), padL("cr/t", 9) ].join(" "));
    for (var g = 0; g < Math.min(10, a.length); g++) {
      var y = a[g];
      d.push([ padR(y.resource, 10), padR(y.reagentA + "+" + y.reagentB, 12), padL(fmt(y.profitPerUnit), 10), padL(y.creditsPerTick === null ? "n/a" : fmtS(y.creditsPerTick), 9) ].join(" "));
    }
    return d.join("\n");
  };
  global.decompressionAnalysis = function(e, t) {
    e = e || "PASSIVE_SELL";
    t = t || "PASSIVE_BUY";
    const r = [];
    for (var o = 0; o < i.length; o++) {
      var n = analyzeFactoryDecompression(i[o], e, t);
      if (n && n.found) r.push(n);
    }
    r.sort(byCreditsPerTick);
    const c = [], u = [], s = [];
    for (var a = 0; a < r.length; a++) {
      var n = r[a];
      if (n.breakEven) {
        if (n.actionable === "✓") c.push(n); else u.push(n);
      } else s.push(n);
    }
    const l = [ "Generated: " + getPT(), "Factory rows ranked by expected net credits/tick", "", "=== Factory Decompression Analysis ===", "100 bar + 200 energy → 500 mineral | 1 battery → 50 energy", "" ];
    if (c.length) {
      l.push("--- ✓ ACTIONABLE ---");
      l.push([ padR("Output", 8), padR("FromBar", 12), padL("Ingred", 10), padL("Revenue", 10), padL("Profit", 10), padL("cr/t", 9), padL("Cd/t", 5), padL("BarVol", 8) ].join(" "));
      for (var p = 0; p < c.length; p++) {
        var n = c[p];
        l.push([ padR(n.resource, 8), padR(n.barName, 12), padL(fmt(n.ingredientCost), 10), padL(fmt(n.revenue), 10), padL("+" + fmt(n.profit), 10), padL(fmtS(n.creditsPerTick), 9), padL(n.cooldown !== null ? String(n.cooldown) : "n/a", 5), padL(fmtVol(n.barVolume), 8) ].join(" "));
      }
      l.push("");
    }
    if (!c.length && !u.length) {
      l.push("--- No profitable decompression opportunities ---");
      l.push("");
    }
    l.push("--- ALL RESULTS ---");
    l.push([ padR("Output", 8), padR("FromBar", 12), padL("Ingred", 10), padL("Profit", 10), padL("cr/t", 9), padL("Cd/t", 5) ].join(" "));
    for (var d = 0; d < r.length; d++) {
      var n = r[d];
      l.push([ padR(n.resource, 8), padR(n.barName, 12), padL(fmt(n.ingredientCost), 10), padL(fmt(n.profit), 10), padL(n.creditsPerTick === null ? "n/a" : fmtS(n.creditsPerTick), 9), padL(n.cooldown !== null ? String(n.cooldown) : "n/a", 5) ].join(" "));
    }
    return l.join("\n");
  };
  global.analyzeBreakdown = function(e, t, r) {
    if (!e) return 'Usage: analyzeBreakdown("XGH2O")';
    t = t || "PASSIVE_SELL";
    r = r || "PASSIVE_BUY";
    const o = buildReactionMap();
    const n = buildOwnSellResourceSet();
    const i = analyzeReverseReaction(e, o, t, r, n);
    if (!i || !i.found) return "Error: " + e + " is not a valid compound";
    const c = i.isOwnInventory ? "Own inventory (opportunity cost @ PASSIVE_SELL): " + fmt(i.compoundPrice) + " [OWN]" : "Buy: " + fmt(i.compoundPrice) + " [" + i.compoundSource + "]";
    const u = [ "Generated: " + getPT(), "", "=== Breakdown: " + e + " ===", "", c + " | vol: " + fmtVol(i.compoundVolume) + " | cost×" + i.batch + ": " + fmt(i.inputCost), "", "Produces:", "  " + i.reagentA + ": sell @ " + fmt(i.priceA) + " [" + i.priceASource + "] vol:" + fmtVol(i.priceAVolume) + " -> " + fmt(i.revenueA), "  " + i.reagentB + ": sell @ " + fmt(i.priceB) + " [" + i.priceBSource + "] vol:" + fmtVol(i.priceBVolume) + " -> " + fmt(i.revenueB), "  Revenue: " + fmt(i.revenue), "", "Profit/batch: " + fmt(i.profit) + " | /unit: " + fmt(i.profitPerUnit) + " | Expected: " + (i.creditsPerTick === null ? "n/a" : fmtS(i.creditsPerTick) + " cr/t"), "Actionable: " + i.actionable ];
    if (i.warnings.length) {
      u.push("");
      for (var s = 0; s < i.warnings.length; s++) u.push("⚠ " + i.warnings[s]);
    }
    u.push("");
    if (i.profit > 0 && i.actionable === "✓") u.push(">>> ✓ ACTIONABLE <<<"); else if (i.profit > 0) u.push(">>> ~ THEORETICAL <<<"); else u.push("Not profitable.");
    return u.join("\n");
  };
  global.analyzeForward = function(e, t, r) {
    if (!e) return 'Usage: analyzeForward("XGH2O")';
    t = t || "PASSIVE_SELL";
    r = r || "PASSIVE_BUY";
    const o = buildReactionMap();
    const n = buildOwnSellResourceSet();
    const i = analyzeLabProduct(e, o, t, r, n);
    if (!i || !i.found) return "Error: " + e + " not a valid lab product";
    const c = o[e], u = computePassiveBuyPrice(RESOURCE_ENERGY);
    const s = i.reagentA + (i.inputAIsOwn ? " [OWN@ASELL]" : " [" + i.inputASource + "]");
    const a = i.reagentB + (i.inputBIsOwn ? " [OWN@ASELL]" : " [" + i.inputBSource + "]");
    const l = [ "Generated: " + getPT(), "", "=== Forward Reaction: " + e + " ===", "Reaction: " + c[0] + " + " + c[1] + " -> " + e, "Cooldown: " + (i.reactionTime !== null ? i.reactionTime + "t" : "unknown"), "", "Energy:       " + fmt(u.price) + " [" + u.source + "]", "", "Costs (batch " + i.outQty + "):", "  " + s + ":" + Array(Math.max(1, 14 - s.length)).join(" ") + "(per unit: ~" + fmt(i.reagentCost / i.outQty / 2) + ")", "  " + a + ":" + Array(Math.max(1, 14 - a.length)).join(" ") + "(per unit: ~" + fmt(i.reagentCost / i.outQty / 2) + ")", "  Reagents:     " + fmt(i.reagentCost), "  Total:        " + fmt(i.inputCost), "", "Revenue: " + fmt(i.revenue) + " | Sell: " + fmt(i.unitPrice) + " [" + i.outputSource + "] vol:" + fmtVol(i.outputVolume), "", "Profit/batch: " + fmt(i.profit) + " | /unit: " + fmt(i.profitPerUnit) + " | Expected: " + (i.creditsPerTick === null ? "n/a" : fmtS(i.creditsPerTick) + " cr/t"), "Actionable: " + i.actionable, "" ];
    if (i.inputAIsOwn || i.inputBIsOwn) {
      l.push("Note: [OWN] reagents priced at PASSIVE_SELL (opportunity cost of own inventory).");
      l.push("      Credits/tick uses the same score contract as autoTrader.");
      l.push("");
    }
    if (i.profit > 0 && i.actionable === "✓") l.push(">>> ✓ ACTIONABLE <<<"); else if (i.profit > 0) l.push(">>> ~ THEORETICAL <<<"); else l.push("Not profitable.");
    return l.join("\n");
  };
  global.analyzeDecompression = function(e, t, r) {
    if (!e) return 'Usage: analyzeDecompression("U")';
    t = t || "PASSIVE_SELL";
    r = r || "PASSIVE_BUY";
    const o = analyzeFactoryDecompression(e, t, r);
    if (!o || !o.found) return "Error: " + e + " not valid. Options: " + i.join(", ");
    const n = [ "Generated: " + getPT(), "", "=== Decompression: " + o.barName + " → " + o.resource + " ===", "Cooldown: " + (o.cooldown !== null ? o.cooldown + "t" : "n/a"), "", "Input bar: " + o.barName + " × " + o.barQty + " @ " + fmt(o.barPrice) + " [" + o.barSource + "] vol:" + fmtVol(o.barVolume) ];
    if (o.energyQty > 0) n.push("Energy:    × " + o.energyQty + " @ " + fmt(o.energyPrice) + " [" + o.energySource + "]");
    n.push("Ingredient cost: " + fmt(o.ingredientCost));
    n.push("Total cost:      " + fmt(o.inputCost), "");
    n.push("Output: " + o.resource + " × " + o.outQty + " | Sell: " + fmt(o.unitPrice) + " [" + o.outputSource + "] vol:" + fmtVol(o.outputVolume));
    n.push("Revenue: " + fmt(o.revenue), "");
    n.push("Profit: " + fmt(o.profit) + " | /unit: " + fmt(o.profitPerUnit) + " | Expected: " + (o.creditsPerTick === null ? "n/a" : fmtS(o.creditsPerTick) + " cr/t"));
    n.push("Actionable: " + o.actionable);
    if (o.warnings.length) {
      n.push("");
      for (var c = 0; c < o.warnings.length; c++) n.push("⚠ " + o.warnings[c]);
    }
    n.push("");
    if (o.profit > 0 && o.actionable === "✓") n.push(">>> ✓ ACTIONABLE <<<"); else if (o.profit > 0) n.push(">>> ~ THEORETICAL <<<"); else n.push("Not profitable.");
    return n.join("\n");
  };
  global.orderBook = function(t) {
    if (!t) return 'Usage: orderBook("ZO")';
    t = resolveResource(t);
    const r = getOrderInfo(t, ORDER_SELL), o = getOrderInfo(t, ORDER_BUY);
    const n = getAvg48h(t), i = computePassiveBuyPrice(t), c = computePassiveSellPrice(t);
    const u = [ "Generated: " + getPT(), "", "=== Order Book: " + t + " ===", "", "Hist 48h: " + (n === null ? "n/a" : fmt(n)), "", "Execution prices:", "  POSTED_BUY:  " + fmt(i.price) + " [" + i.source + "] — canonical passive BUY price", "  POSTED_SELL: " + fmt(c.price) + " [" + c.source + "] — canonical passive SELL price", "", "--- SELL ORDERS ---", "Count: " + r.count + " | Vol: " + fmtVol(r.totalVolume) ];
    if (r.count > 0) {
      u.push("Best ask: " + fmt(r.bestPrice), "");
      u.push([ padR("Price", 12), padR("Available", 12), padR("Room", 10) ].join(" "));
      for (var s = 0; s < Math.min(10, r.orders.length); s++) {
        var a = r.orders[s];
        u.push([ padL(fmt(a.price), 12), padL(String(e.getOrderRemaining(a)), 12), padR(a.roomName || "N/A", 10) ].join(" "));
      }
    } else {
      u.push("  None.");
    }
    u.push("", "--- BUY ORDERS ---", "Count: " + o.count + " | Vol: " + fmtVol(o.totalVolume));
    if (o.count > 0) {
      u.push("Best bid: " + fmt(o.bestPrice), "");
      u.push([ padR("Price", 12), padR("Wanted", 12), padR("Room", 10) ].join(" "));
      for (var l = 0; l < Math.min(10, o.orders.length); l++) {
        var a = o.orders[l];
        u.push([ padL(fmt(a.price), 12), padL(String(e.getOrderRemaining(a)), 12), padR(a.roomName || "N/A", 10) ].join(" "));
      }
    } else {
      u.push("  None.");
    }
    if (r.bestPrice !== null && o.bestPrice !== null) {
      var p = r.bestPrice - o.bestPrice, d = p / o.bestPrice * 100;
      u.push("", "--- SPREAD ---", "Bid: " + fmt(o.bestPrice) + " | Ask: " + fmt(r.bestPrice), "Spread: " + fmt(p) + " (" + fmtS(d) + "%)" + (d > 100 ? " ⚠ ILLIQUID" : ""));
    }
    return u.join("\n");
  };
  global.energyCost = function() {
    const e = computePassiveBuyPrice(RESOURCE_ENERGY);
    const t = [ "Generated: " + getPT(), "", "=== Energy Cost ===", "Price: " + fmt(e.price) + " [" + e.source + "]" ];
    return t.join("\n");
  };
  global.rawMarketData = function(t, r) {
    const c = {};
    for (var u in o) {
      if (o.hasOwnProperty(u)) c[u] = true;
    }
    for (var s = 0; s < n.length; s++) c[n[s]] = true;
    for (var a = 0; a < i.length; a++) c[i[a]] = true;
    const l = [ "U", "L", "Z", "K", "O", "H", "G", "energy", "X" ];
    for (var p = 0; p < l.length; p++) c[l[p]] = true;
    let d = Object.keys(c).sort();
    if (t && t !== "all") {
      const e = resolveResource(t);
      if (d.indexOf(e) === -1) return JSON.stringify({
        error: "Unknown resource: " + t
      });
      d = [ e ];
    }
    const f = {
      generated: getPT(),
      timestamp: Date.now(),
      tick: Game.time,
      resources: {}
    };
    for (var m = 0; m < d.length; m++) {
      const t = d[m];
      const r = Game.market.getHistory(t) || [];
      const o = [];
      for (var g = 0; g < r.length; g++) {
        o.push({
          date: r[g].date,
          avgPrice: r[g].avgPrice,
          volume: r[g].volume
        });
      }
      const n = computePassiveBuyPrice(t);
      const i = computePassiveSellPrice(t);
      const c = getAvg48h(t);
      const u = getOrderInfo(t, ORDER_BUY);
      const s = getOrderInfo(t, ORDER_SELL);
      f.resources[t] = {
        history: o,
        avg48h: c,
        actualBuy: {
          price: n.price,
          source: n.source,
          volume: n.volume,
          orderCount: n.orderCount
        },
        actualSell: {
          price: i.price,
          source: i.source,
          volume: i.volume,
          orderCount: i.orderCount
        },
        spread: n.price !== null && i.price !== null ? i.price - n.price : null,
        spreadPct: n.price !== null && i.price !== null && n.price > 0 ? (i.price - n.price) / n.price * 100 : null,
        orderBook: {
          buys: {
            count: u.count,
            totalVolume: u.totalVolume,
            bestPrice: u.bestPrice,
            orders: u.orders.map(function(t) {
              return {
                id: t.id,
                price: t.price,
                amount: e.getOrderRemaining(t),
                roomName: t.roomName || null
              };
            })
          },
          sells: {
            count: s.count,
            totalVolume: s.totalVolume,
            bestPrice: s.bestPrice,
            orders: s.orders.map(function(t) {
              return {
                id: t.id,
                price: t.price,
                amount: e.getOrderRemaining(t),
                roomName: t.roomName || null
              };
            })
          }
        }
      };
    }
    const y = computePassiveBuyPrice(RESOURCE_ENERGY);
    f.energyPrice = y.price;
    f.energySource = y.source;
    if (r === true) {
      const e = buildReactionMap();
      const t = buildOwnSellResourceSet();
      f.analysis = {};
      f.factory = {};
      f.decompression = {};
      for (var L = 0; L < d.length; L++) {
        const r = d[L];
        const o = analyzeLabProduct(r, e, "PASSIVE_SELL", "PASSIVE_BUY", t);
        if (o && o.found) {
          f.analysis[r] = f.analysis[r] || {};
          f.analysis[r].forward = {
            reagents: [ o.reagentA, o.reagentB ],
            costPerBatch: o.reagentCost,
            totalCost: o.inputCost,
            revenue: o.revenue,
            profit: o.profit,
            profitPerUnit: o.profitPerUnit,
            creditsPerTick: o.creditsPerTick,
            expectedNetProfit: o.expectedNetProfit,
            expectedElapsedTicks: o.expectedElapsedTicks,
            breakEven: o.breakEven,
            reactionTime: o.reactionTime,
            actionable: o.actionable
          };
        }
        const n = analyzeReverseReaction(r, e, "PASSIVE_SELL", "PASSIVE_BUY", t);
        if (n && n.found) {
          f.analysis[r] = f.analysis[r] || {};
          f.analysis[r].reverse = {
            reagents: [ n.reagentA, n.reagentB ],
            compoundPrice: n.compoundPrice,
            isOwnInventory: n.isOwnInventory,
            revenue: n.revenue,
            profit: n.profit,
            profitPerUnit: n.profitPerUnit,
            creditsPerTick: n.creditsPerTick,
            expectedNetProfit: n.expectedNetProfit,
            expectedElapsedTicks: n.expectedElapsedTicks,
            breakEven: n.breakEven,
            actionable: n.actionable
          };
        }
        const i = analyzeFactoryCommodity(r, "PASSIVE_SELL", "PASSIVE_BUY");
        if (i && i.found) {
          f.factory[r] = {
            outputQty: i.outQty,
            unitPrice: i.unitPrice,
            ingredientCost: i.ingredientCost,
            totalCost: i.inputCost,
            revenue: i.revenue,
            profit: i.profit,
            profitPerUnit: i.profitPerUnit,
            creditsPerTick: i.creditsPerTick,
            expectedNetProfit: i.expectedNetProfit,
            expectedElapsedTicks: i.expectedElapsedTicks,
            breakEven: i.breakEven,
            cooldown: i.cooldown,
            actionable: i.actionable
          };
        }
        const c = analyzeFactoryDecompression(r, "PASSIVE_SELL", "PASSIVE_BUY");
        if (c && c.found) {
          f.decompression[r] = {
            barName: c.barName,
            outputQty: c.outQty,
            barPrice: c.barPrice,
            ingredientCost: c.ingredientCost,
            totalCost: c.inputCost,
            unitPrice: c.unitPrice,
            revenue: c.revenue,
            profit: c.profit,
            profitPerUnit: c.profitPerUnit,
            creditsPerTick: c.creditsPerTick,
            expectedNetProfit: c.expectedNetProfit,
            expectedElapsedTicks: c.expectedElapsedTicks,
            breakEven: c.breakEven,
            cooldown: c.cooldown,
            actionable: c.actionable
          };
        }
      }
    }
    return JSON.stringify(f, null, 2);
  };
  module.exports = {
    scoreProduction: scoreProduction,
    reactionTimeFor: reactionTimeFor,
    factoryCooldownFor: factoryCooldownFor,
    analyzeFactoryCommodity: analyzeFactoryCommodity,
    analyzeFactoryDecompression: analyzeFactoryDecompression,
    analyzeLabProduct: analyzeLabProduct,
    analyzeReverseReaction: analyzeReverseReaction,
    buildReactionMap: buildReactionMap
  };
})();
