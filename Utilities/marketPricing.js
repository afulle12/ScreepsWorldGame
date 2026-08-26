// LLM: Read docs/codex.js before reviewing or changing this file.
// marketPricing.js
// Console globals: priceProfile, prices, priceDiagnostics, marketPriceDiagnostics, conversionQuote
// Example: priceProfile(RESOURCE_ENERGY) - Display detailed pricing profile for resource
// Example: prices('all') - List current market pricing table for resources
// Example: priceDiagnostics() - Audit price profiles for anomalies or missing data
// Example: marketPriceDiagnostics() - Display detailed market pricing health diagnostics
// Example: conversionQuote(RESOURCE_ENERGY, RESOURCE_BATTERY) - Quote conversion cost between resources
var util = require("util");
var memoryManager = require("memoryManager");
var MIN_ORDER_REMAINING = 1e3;
var SUBSTANTIAL_BUY_REMAINING = 500;
var DEPTH_VOLUME = 2e4;
var FEE = .05;
var SPREAD_BUFFER = .02;
var DEFAULT_RANGE_GATE = .2;
var HIGH_RANGE_HURDLE_MULT = 3;
var TREND_THRESHOLD = .05;
var REFERENCE_LEVELS = 4;
var MIN_REFERENCE_COVERAGE = .25;
var HISTORY_ALIGNMENT_TOLERANCE = .25;
var MAX_REFERENCE_SPREAD = .25;
var ACTIVE_HISTORY_WEIGHT = .25;
var NON_DERIVABLE_THEORETICAL = {
  energy: true,
  U: true,
  L: true,
  Z: true,
  K: true,
  X: true,
  O: true,
  H: true,
  G: true
};
var ONE_SIDED_HISTORY_WEIGHT = .1;
var FACTORY_LEVEL_ZERO_MARKUP = .05;
var PROCESSING_LEVEL_MARKUP = .1;
var DERIVED_FLOOR_CACHE_INTERVAL = 5e3;
var DERIVED_FLOOR_CACHE_VERSION = 4;
var DERIVED_FLOOR_SCALE = 1e3;
var PASSIVE_PRICE_STEP = .1;
var PASSIVE_GAP = .001;
// ===== Manipulation-resistant BUY ceiling =====
// Every price we are willing to PAY is capped by the MINIMUM of the evidence
// sources below. Cornering one source can only lower the cap (we buy less);
// raising it means faking 14 days of shard-wide trade history, the whole
// cheap half of the ask book, and the competing bid side at the same time.
// Nothing here reads the top order alone -- that is the single number an
// attacker (or an emptied book) can set for free.
var CEILING_HISTORY_MULT = 10; // vs the 14-day volume-weighted median daily price
var CEILING_ASK_MULT = 5; // vs the median ask across the cheapest DEPTH_VOLUME
// Bids are NOT evidence of value on this shard. Sampling 45 books found real,
// unmanipulated bid sides sitting 2x-100x under the price the same resource
// actually trades at (condensate bid 46 against 2735 traded), because almost
// everyone lifts asks instead of posting bids. A bid reference is reported for
// diagnostics and used as a floor sanity check; it never caps what we pay.
var CEILING_LEVEL_GAP = 2; // consecutive levels further apart than this end the depth walk
// ===== Delivered (freight-inclusive) acquisition =====
// Taking a live ask makes US the dealer, so we pay the terminal transfer. For
// energy that freight is paid in energy, out of the same store we are filling,
// which makes sticker price meaningless: only credits per unit that actually
// lands can be compared against anything. Yield is exp(-distance/30) and
// independent of size, so an order too far away is refused rather than priced.
var DELIVERY_MIN_YIELD = .5; // stops the route at roughly 20 rooms
var DELIVERED_REFERENCE_AMOUNT = 25e3; // standard tranche used for valuation
var CEILING_MIN_HISTORY_DAYS = 3; // fewer traded days is not a price series
var CEILING_MIN_LEVELS = 3; // distinct price levels required inside the depth
var CEILING_MIN_ROOMS = 3; // distinct source rooms required inside the depth
var CEILING_MIN_VOLUME = 2e3; // minimum aggregated depth volume to count as evidence
var CEILING_LOG_GATE = 100; // ticks between repeats of the same clamp message
var _ceilingLogTick = {};
var _cache = null;
var HISTORY_TTL = 1e3;
var _reactionRecipes = null;
var _derivedProductOrder = null;
var _derivedFloorCache = null;
function getRawOrders() {
  return util.marketSnapshot().all;
}

var getMyRooms = util.getMyRooms;
function getReactionRecipes() {
  if (_reactionRecipes) return _reactionRecipes;
  var e = {};
  if (typeof REACTIONS !== "undefined" && REACTIONS) {
    for (var r in REACTIONS) {
      if (!REACTIONS.hasOwnProperty(r) || !REACTIONS[r]) continue;
      for (var t in REACTIONS[r]) {
        if (!REACTIONS[r].hasOwnProperty(t)) continue;
        var i = REACTIONS[r][t];
        if (!i || e[i]) continue;
        e[i] = {
          kind: "lab",
          components: function(e, r) {
            var t = {};
            t[e] = 1;
            t[r] = (t[r] || 0) + 1;
            return t;
          }(r, t),
          amount: 1
        };
      }
    }
  }
  _reactionRecipes = e;
  return e;
}

function getDerivedRecipe(e) {
  var r = getReactionRecipes();
  if (r[e]) return r[e];
  if (NON_DERIVABLE_THEORETICAL[e]) return null;
  if (typeof COMMODITIES === "undefined" || !COMMODITIES || !COMMODITIES[e]) return null;
  var t = COMMODITIES[e];
  if (!t.components) return null;
  return {
    kind: "factory",
    components: t.components,
    amount: typeof t.amount === "number" && t.amount > 0 ? t.amount : 1,
    level: typeof t.level === "number" && t.level >= 0 ? t.level : 0
  };
}

function getProcessingLevel(e, r) {
  var t = getDerivedRecipe(e);
  if (!t) return 0;
  if (t.kind === "factory") {
    return t.level > 0 ? t.level : 1;
  }
  r = r || {};
  if (r[e]) return 0;
  r[e] = true;
  var i = 0;
  for (var n in t.components) {
    if (!t.components.hasOwnProperty(n)) continue;
    i = Math.max(i, getProcessingLevel(n, r));
  }
  delete r[e];
  return i + 1;
}

function getRecipeMarkup(e, r) {
  if (!r) return 0;
  if (r.kind === "lab") {
    return getProcessingLevel(e, {}) * PROCESSING_LEVEL_MARKUP;
  }
  return r.level === 0 ? FACTORY_LEVEL_ZERO_MARKUP : r.level * PROCESSING_LEVEL_MARKUP;
}

function getDerivedProductOrder() {
  if (_derivedProductOrder) return _derivedProductOrder;
  var e = {};
  var r = getReactionRecipes();
  for (var t in r) e[t] = true;
  if (typeof COMMODITIES !== "undefined" && COMMODITIES) {
    for (var i in COMMODITIES) {
      if (getDerivedRecipe(i)) e[i] = true;
    }
  }
  _derivedProductOrder = Object.keys(e).sort();
  return _derivedProductOrder;
}

function buildCache() {
  var e = util.marketSnapshot();
  if (_cache && _cache.snapshotTick === e.tick) return _cache;
  var r = getMyRooms();
  var t = {}, i = {}, n = {};
  for (var a in e.idx) {
    var o = e.idx[a];
    for (var l = 0; l < 2; l++) {
      var u = l === 0 ? o.buy : o.sell;
      var s = [];
      var c = [];
      for (var v = 0; v < u.length; v++) {
        var f = u[v];
        var d = util.getOrderRemaining(f);
        if (l === 0 && d >= SUBSTANTIAL_BUY_REMAINING && (!f.roomName || !r[f.roomName])) {
          c.push(f);
        }
        if (d < MIN_ORDER_REMAINING) continue;
        if (f.roomName && r[f.roomName]) continue;
        s.push(f);
      }
      if (s.length) {
        if (l === 0) t[a] = s; else i[a] = s;
      }
      if (l === 0 && c.length) n[a] = c;
    }
  }
  _cache = {
    snapshotTick: e.tick,
    buys: t,
    sells: i,
    substantialBuys: n,
    books: {},
    profiles: {},
    theoretical: {},
    hist: {},
    passiveBuy: {},
    buyCeilings: {},
    delivered: {},
    acquisition: {},
    executableBuyQuotes: {},
    myRooms: r
  };
  return _cache;
}

function orderAvailableAmount(e) {
  return util.getOrderRemaining(e);
}

function depthSlice(e) {
  var r = [], t = 0;
  for (var i = 0; i < e.length; i++) {
    r.push(e[i]);
    t += orderAvailableAmount(e[i]);
    if (t >= DEPTH_VOLUME) break;
  }
  return r;
}

function weightedPrice(e) {
  var r = 0, t = 0;
  for (var i = 0; i < e.length; i++) {
    var n = orderAvailableAmount(e[i]);
    r += e[i].price * n;
    t += n;
  }
  return t > 0 ? r / t : 0;
}

function executablePrice(e, r) {
  if (!(r > 0)) return null;
  var t = 0, i = 0;
  for (var n = 0; n < e.length && i < r; n++) {
    var a = Math.min(r - i, orderAvailableAmount(e[n]));
    if (!(a > 0)) continue;
    t += e[n].price * a;
    i += a;
  }
  return i >= r ? t / i : null;
}

function sumVolume(e) {
  var r = 0;
  for (var t = 0; t < e.length; t++) r += orderAvailableAmount(e[t]);
  return r;
}

function boundedReferencePrice(e, r) {
  if (!e || e.length === 0) return {
    price: null,
    volume: 0,
    levels: 0
  };
  var t = {};
  for (var i = 0; i < e.length; i++) {
    var n = e[i];
    var a = orderAvailableAmount(n);
    if (!(a > 0) || typeof n.price !== "number") continue;
    var o = String(n.price);
    if (!t[o]) t[o] = {
      price: n.price,
      volume: 0
    };
    t[o].volume += a;
  }
  var l = [];
  for (var o in t) {
    if (t[o].volume > 0) l.push(t[o]);
  }
  l.sort(function(e, t) {
    return r ? t.price - e.price : e.price - t.price;
  });
  var u = 0;
  for (var s = 0; s < l.length; s++) u += l[s].volume;
  if (!(u > 0)) return {
    price: null,
    volume: 0,
    levels: l.length,
    targetDepth: 0
  };
  var c = Math.min(DEPTH_VOLUME, u);
  var v = c * .25;
  var f = 0;
  var d = 0;
  for (var E = 0; E < l.length && d < c; E++) {
    var g = Math.min(l[E].volume, v, c - d);
    if (!(g > 0)) continue;
    f += l[E].price * g;
    d += g;
  }
  return {
    price: d > 0 ? f / d : null,
    volume: d,
    levels: l.length,
    targetDepth: c
  };
}

function liquidityQuality(e, r, t, i) {
  if (!(e > 0)) return "dead";
  var n = i > 0 ? i : Math.min(DEPTH_VOLUME, e);
  var a = n > 0 ? t / n : 0;
  if (e >= DEPTH_VOLUME * MIN_REFERENCE_COVERAGE && r >= REFERENCE_LEVELS && a >= .75) {
    return "deep";
  }
  return "thin";
}

function getBook(e) {
  var r = buildCache();
  if (r.books[e]) return r.books[e];
  var t = r.buys[e] || [];
  var i = r.sells[e] || [];
  var n;
  if (t.length === 0 && i.length === 0) {
    n = {
      bestBid: null,
      bestAsk: null,
      vwBid: null,
      vwAsk: null,
      wmp: null,
      bidVol: 0,
      askVol: 0,
      spread: null,
      spreadPct: null,
      oneSided: "empty",
      bidCount: 0,
      askCount: 0
    };
  } else if (t.length === 0 || i.length === 0) {
    var a = t.length > 0 ? t : i;
    var o = depthSlice(a);
    n = {
      bestBid: t.length > 0 ? t[0].price : null,
      bestAsk: i.length > 0 ? i[0].price : null,
      vwBid: t.length > 0 ? weightedPrice(o) : null,
      vwAsk: i.length > 0 ? weightedPrice(o) : null,
      wmp: null,
      bidVol: t.length > 0 ? sumVolume(o) : 0,
      askVol: i.length > 0 ? sumVolume(o) : 0,
      spread: null,
      spreadPct: null,
      oneSided: t.length > 0 ? "bid-only" : "ask-only",
      bidCount: t.length,
      askCount: i.length
    };
  } else {
    var l = depthSlice(t);
    var u = depthSlice(i);
    var s = weightedPrice(l);
    var c = weightedPrice(u);
    var v = sumVolume(l);
    var f = sumVolume(u);
    var d = (s * f + c * v) / (v + f);
    var E = l[0].price;
    var g = u[0].price;
    var p = g - E;
    var m = (g + E) / 2;
    n = {
      bestBid: E,
      bestAsk: g,
      vwBid: s,
      vwAsk: c,
      wmp: d,
      bidVol: v,
      askVol: f,
      spread: p,
      spreadPct: m > 0 ? p / m * 100 : 0,
      oneSided: null,
      bidCount: t.length,
      askCount: i.length
    };
  }
  var h = boundedReferencePrice(t, true);
  var P = boundedReferencePrice(i, false);
  n.referenceBid = h.price;
  n.referenceAsk = P.price;
  n.referenceBidVolume = h.volume;
  n.referenceAskVolume = P.volume;
  n.referenceBidTarget = h.targetDepth || 0;
  n.referenceAskTarget = P.targetDepth || 0;
  n.bidLevels = h.levels;
  n.askLevels = P.levels;
  n.totalBidVolume = sumVolume(t);
  n.totalAskVolume = sumVolume(i);
  n.bidLiquidity = liquidityQuality(n.totalBidVolume, h.levels, h.volume, h.targetDepth);
  n.askLiquidity = liquidityQuality(n.totalAskVolume, P.levels, P.volume, P.targetDepth);
  n.crossed = n.bestBid !== null && n.bestAsk !== null && n.bestBid >= n.bestAsk;
  n.referenceCrossed = n.referenceBid !== null && n.referenceAsk !== null && n.referenceBid >= n.referenceAsk;
  r.books[e] = n;
  return n;
}

function getSubstantialBuyPrice(e) {
  var r = buildCache();
  var t = r.substantialBuys[e] || [];
  return t.length > 0 && typeof t[0].price === "number" ? t[0].price : null;
}

function isEnergyResource(e) {
  return e === "energy" || typeof RESOURCE_ENERGY !== "undefined" && e === RESOURCE_ENERGY;
}

// Cheapest live ask priced per unit that actually lands in destinationRoom.
// Returns null when nothing qualifies: over the buy ceiling, under the yield
// floor, or too small to be worth an intent.
function deliveredBuyQuote(resource, amount, destinationRoom) {
  if (!(amount > 0) || !destinationRoom) return null;
  var c = buildCache();
  var key = resource + "|" + amount + "|" + destinationRoom;
  if (c.delivered.hasOwnProperty(key)) return c.delivered[key];
  var orders = c.sells[resource] || [];
  var ceiling = maxBuyPrice(resource);
  // Freight is always paid in energy, but it lands differently: buying ENERGY
  // it comes out of the shipment itself, so less arrives than we bought.
  // Buying anything else the full quantity arrives and the energy is a
  // separate cost, valued at what energy costs us.
  var consumesGood = isEnergyResource(resource);
  var energyUnit = consumesGood ? 0 : getStatusEnergyPrice();
  var best = null;
  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    if (!order || !order.roomName) continue;
    if (typeof order.price !== "number" || !(order.price > 0)) continue;
    if (ceiling !== null && order.price > ceiling) continue;
    var take = Math.min(amount, orderAvailableAmount(order));
    if (!(take > 0)) continue;
    var freight = 0;
    try {
      freight = util.calcTransactionCost(take, destinationRoom, order.roomName);
    } catch (e) {
      continue;
    }
    var net = take;
    var freightCredits = 0;
    var delivered;
    if (consumesGood) {
      net = take - freight;
      if (!(net > 0) || net / take < DELIVERY_MIN_YIELD) continue;
      delivered = order.price * take / net;
    } else {
      freightCredits = freight * energyUnit;
      delivered = order.price + freightCredits / take;
    }
    if (ceiling !== null && delivered > ceiling) continue;
    if (!best || delivered < best.delivered) {
      best = {
        resource: resource,
        orderId: order.id,
        sellerRoom: order.roomName,
        destinationRoom: destinationRoom,
        price: order.price,
        take: take,
        freight: freight,
        freightCredits: freightCredits,
        net: net,
        yield: net / take,
        delivered: delivered
      };
    }
  }
  c.delivered[key] = best;
  return best;
}

// What it actually costs to add a unit of a resource, by the cheaper of the
// two routes available to us:
//   BID    rest the most competitive buy order. Freight-free -- whoever fills
//          it is the dealer and pays the transfer.
//   DIRECT take a live ask now. We deal, so we pay freight.
// Both legs are credits per unit landed, so the minimum is the honest cost of
// acquiring it. DIRECT is evaluated for every owned room and reports the
// cheapest, since that is where we would buy.
//
// Structural note: in an uncrossed book the posted bid sits under the best ask,
// so DIRECT can only win on a CROSSED book -- the normal state of energy, where
// distance segments the market and far bidders bid over near asks.
function acquisitionQuote(resource, amount) {
  var c = buildCache();
  var size = amount > 0 ? amount : DELIVERED_REFERENCE_AMOUNT;
  var key = resource + "|" + size;
  if (c.acquisition.hasOwnProperty(key)) return c.acquisition[key];
  var profile = getPriceProfile(resource);
  var bid = profile.postedBuyPrice !== null ? profile.postedBuyPrice : profile.marketPrice !== null ? profile.marketPrice : 0;
  if (bid > 0) bid = believableBuyPrice(resource, bid);
  var direct = null;
  var rooms = getMyRooms();
  for (var name in rooms) {
    if (!rooms.hasOwnProperty(name)) continue;
    var room = Game.rooms[name];
    if (room && !room.terminal) continue; // no terminal, no direct route
    var quote = deliveredBuyQuote(resource, size, name);
    if (quote && (!direct || quote.delivered < direct.delivered)) direct = quote;
  }
  var price = 0;
  var route = "NONE";
  if (bid > 0 && direct) {
    price = Math.min(bid, direct.delivered);
    route = direct.delivered < bid ? "DIRECT" : "BID";
  } else if (bid > 0) {
    price = bid;
    route = "BID";
  } else if (direct) {
    price = direct.delivered;
    route = "DIRECT";
  }
  var result = {
    resource: resource,
    price: price,
    route: route,
    bid: bid > 0 ? bid : null,
    direct: direct
  };
  c.acquisition[key] = result;
  return result;
}

function energyAcquisitionQuote() {
  return acquisitionQuote(RESOURCE_ENERGY, DELIVERED_REFERENCE_AMOUNT);
}

// Energy's canonical valuation: the cheaper of the two routes that can
// actually add a unit, freight included. The bid leg stays clamped to the
// corroborated ceiling, so a manipulated or emptied book cannot inflate every
// downstream valuation that quotes energy.
function getStatusEnergyPrice() {
  return energyAcquisitionQuote().price;
}

function executableBuyPrice(e, r) {
  var t = buildCache();
  return executablePrice(t.sells[e] || [], r);
}

function executableBuyQuote(e, r, t) {
  if (!(r > 0)) return null;
  var i = buildCache();
  var n = e + "|" + r + "|" + (t || "");
  if (i.executableBuyQuotes.hasOwnProperty(n)) return i.executableBuyQuotes[n];
  var a = i.sells[e] || [];
  var o = 0, l = 0, u = 0;
  for (var s = 0; s < a.length && l < r; s++) {
    var c = Math.min(r - l, orderAvailableAmount(a[s]));
    if (!(c > 0)) continue;
    if (!a[s].roomName) continue;
    o += a[s].price * c;
    if (t) {
      try {
        u += util.calcTransactionCost(c, t, a[s].roomName);
      } catch (e) {}
    }
    l += c;
  }
  var v = l >= r ? {
    price: o / l,
    transferEnergy: u,
    amount: l
  } : null;
  i.executableBuyQuotes[n] = v;
  return v;
}

function executableSellQuote(e, r, t) {
  if (!(r > 0)) return null;
  var i = buildCache();
  var n = i.buys[e] || [];
  var a = 0, o = 0, l = 0, u = 0;
  for (var s = 0; s < n.length && o < r; s++) {
    var c = orderAvailableAmount(n[s]);
    var v = Math.min(r - o, c);
    if (!(v > 0)) continue;
    a += n[s].price * v;
    if (t && n[s].roomName) {
      try {
        l += util.calcTransactionCost(v, t, n[s].roomName);
      } catch (e) {}
    }
    o += v;
    u++;
  }
  if (o < r) return null;
  var f = getBook(e);
  return {
    price: a / o,
    amount: o,
    orderCount: u,
    transferEnergy: l,
    bestBid: f.bestBid,
    bestAsk: f.bestAsk,
    crossed: f.bestBid !== null && f.bestAsk !== null && f.bestBid >= f.bestAsk,
    source: "LIVE_BID"
  };
}

function getRestrictedDirectQuote(e, r, t) {
  if (!(r > 0)) return null;
  var i = require("autoTraderSellPolicy");
  var n = i && typeof i.getFloor === "function" ? i.getFloor(e) : 0;
  var a = util.getMyRooms ? util.getMyRooms() : {};
  var o = buildCache();
  var l = o.buys[e] || [];
  var u = 0, s = 0, c = 0, v = 0;
  for (var f = 0; f < l.length && s < r; f++) {
    var d = l[f];
    if (!d || d.active === false) continue;
    if (d.roomName && a[d.roomName]) continue;
    if (typeof d.price === "number" && d.price < n) continue;
    var E = orderAvailableAmount(d);
    var g = Math.min(r - s, E);
    if (!(g > 0)) continue;
    u += d.price * g;
    if (t && d.roomName) {
      try {
        c += util.calcTransactionCost(g, t, d.roomName);
      } catch (e) {}
    }
    s += g;
    v++;
  }
  if (s === 0) return null;
  var p = getBook(e);
  return {
    executableAmount: s,
    price: u / s,
    totalValue: u,
    amount: s,
    orderCount: v,
    transferEnergy: c,
    bestBid: p.bestBid,
    bestAsk: p.bestAsk,
    crossed: p.bestBid !== null && p.bestAsk !== null && p.bestBid >= p.bestAsk,
    source: "LIVE_BID"
  };
}

function getHistDays(e) {
  var r = buildCache();
  if (r.hist[e]) return Array.isArray(r.hist[e]) ? r.hist[e] : [];
  if (!global.__marketPriceHistory) global.__marketPriceHistory = {};
  var t = global.__marketPriceHistory[e];
  if (!t || !Array.isArray(t.days) || Game.time - t.tick >= HISTORY_TTL) {
    var i = Game.market.getHistory(e);
    t = global.__marketPriceHistory[e] = {
      tick: Game.time,
      days: Array.isArray(i) ? i : []
    };
  }
  var n = t.days;
  r.hist[e] = n;
  return n;
}

function getAvg48h(e) {
  var r = getHistDays(e);
  if (!r || r.length === 0) return null;
  var t = r[r.length - 1];
  var i = r.length >= 2 ? r[r.length - 2] : null;
  var n = 0, a = 0;
  if (t && typeof t.avgPrice === "number" && typeof t.volume === "number") {
    n += t.avgPrice * t.volume;
    a += t.volume;
  }
  if (i && typeof i.avgPrice === "number" && typeof i.volume === "number") {
    n += i.avgPrice * i.volume;
    a += i.volume;
  }
  if (a <= 0) return t && typeof t.avgPrice === "number" ? t.avgPrice : null;
  return n / a;
}

function getAvg7d(e) {
  var r = validWeekDays(e);
  if (r.length === 0) return null;
  var t = 0, i = 0;
  for (var n = 0; n < r.length; n++) {
    t += r[n].avgPrice * r[n].volume;
    i += r[n].volume;
  }
  return i > 0 ? t / i : null;
}

function validWeekDays(e) {
  var r = getHistDays(e);
  var t = [];
  var i = Math.max(0, r.length - 7);
  for (var n = i; n < r.length; n++) {
    var a = r[n];
    if (a && typeof a.avgPrice === "number" && a.avgPrice > 0 && typeof a.volume === "number" && a.volume > 0) {
      t.push(a);
    }
  }
  return t;
}

function medianVolume(e) {
  var r = [];
  for (var t = 0; t < e.length; t++) r.push(e[t].volume);
  r.sort(function(e, r) {
    return e - r;
  });
  var i = Math.floor(r.length / 2);
  return r.length % 2 === 1 ? r[i] : (r[i - 1] + r[i]) / 2;
}

function getRange7d(e) {
  var r = validWeekDays(e);
  if (r.length < 4) return null;
  var t = medianVolume(r);
  var i = [];
  for (var n = 0; n < r.length; n++) {
    if (r[n].volume >= t * .2) i.push(r[n]);
  }
  if (i.length >= 4) r = i;
  var a = Infinity, o = 0;
  for (var l = 0; l < r.length; l++) {
    if (r[l].avgPrice < a) a = r[l].avgPrice;
    if (r[l].avgPrice > o) o = r[l].avgPrice;
  }
  if (!(a > 0)) return null;
  return (o - a) / a;
}

function getTrend7d(e) {
  var r = validWeekDays(e);
  if (r.length < 4) return null;
  var t = Math.floor(r.length / 2);
  var i = 0, n = 0;
  for (var a = 0; a < t; a++) i += r[a].avgPrice;
  for (var o = t; o < r.length; o++) n += r[o].avgPrice;
  var l = i / t;
  var u = n / (r.length - t);
  if (!(l > 0)) return null;
  var s = (u - l) / l;
  if (s > TREND_THRESHOLD) return "rising";
  if (s < -TREND_THRESHOLD) return "falling";
  return "flat";
}

function getWeekLow(e) {
  var r = validWeekDays(e);
  if (r.length === 0) return null;
  var t = Infinity;
  for (var i = 0; i < r.length; i++) {
    if (r[i].avgPrice < t) t = r[i].avgPrice;
  }
  return t === Infinity ? null : t;
}

function relativeDistance(e, r) {
  if (!(e > 0) || !(r > 0)) return Infinity;
  return Math.abs(e - r) / Math.max(e, r);
}

function historyAligned(e, r) {
  if (!(e > 0) || !r || r.length === 0) return false;
  for (var t = 0; t < r.length; t++) {
    if (relativeDistance(e, r[t]) > HISTORY_ALIGNMENT_TOLERANCE) return false;
  }
  return true;
}

function getInputBuyQuote(e, r, t) {
  var i = !(t && t.allowTheoretical === false);
  var n = !!(t && t.allowPassive);
  if (isEnergyResource(e)) {
    var a = getStatusEnergyPrice();
    return a > 0 ? {
      price: a,
      source: "STATUS"
    } : {
      price: 0,
      source: "NONE"
    };
  }
  var o = r > 0 ? executableBuyPrice(e, r) : null;
  if (o > 0) {
    return {
      price: o,
      source: "EXECUTABLE_ASK"
    };
  }
  var l = getBook(e);
  var u = l && l.referenceAsk > 0 ? l.referenceAsk : l && l.bestAsk > 0 ? l.bestAsk : 0;
  if (u > 0) return {
    price: u,
    source: "REFERENCE_ASK"
  };
  if (i) {
    var s = getTheoreticalPrice(e);
    if (s && s.price > 0) {
      return {
        price: s.price,
        source: "THEORETICAL"
      };
    }
    var c = getPriceProfile(e);
    if (c && c.postedBuyPrice > 0) {
      return {
        price: c.postedBuyPrice,
        source: "POSTED_BUY"
      };
    }
  }
  if (n && !getDerivedRecipe(e)) {
    var v = getPriceProfile(e);
    if (v && v.postedBuyPrice > 0) {
      return {
        price: v.postedBuyPrice,
        source: "POSTED_BUY"
      };
    }
  }
  return {
    price: 0,
    source: "NONE"
  };
}

function currentInputBuyPrice(e, r) {
  return getInputBuyQuote(e, r, {
    allowTheoretical: false,
    allowPassive: true
  }).price;
}

function decodeStoredDerivedFloors(e, r) {
  var t = {};
  if (!e || e.v !== DERIVED_FLOOR_CACHE_VERSION || !Array.isArray(e.p) || e.p.length !== r.length) return t;
  for (var i = 0; i < r.length; i++) {
    if (typeof e.p[i] === "number" && e.p[i] > 0) {
      t[r[i]] = e.p[i] / DERIVED_FLOOR_SCALE;
    }
  }
  return t;
}

function resolveDerivedPrice(e, r, t, i) {
  if (t.hasOwnProperty(e)) return t[e];
  var n = getDerivedRecipe(e);
  if (!n) return 0;
  if (i[e]) return 0;
  i[e] = true;
  var a = 0;
  var o = false;
  for (var l in n.components) {
    if (!n.components.hasOwnProperty(l)) continue;
    var u = typeof n.components[l] === "number" ? n.components[l] : 0;
    if (!(u > 0)) continue;
    var s = currentInputBuyPrice(l, u);
    if (!(s > 0) && getDerivedRecipe(l)) {
      s = resolveDerivedPrice(l, r, t, i);
    }
    if (!(s > 0)) {
      o = true;
      break;
    }
    a += s * u;
  }
  var c = 0;
  if (!o && a > 0) {
    var v = n.amount > 0 ? n.amount : 1;
    var f = a / v;
    var d = getRecipeMarkup(e, n);
    c = f * (1 + d) / (1 - FEE);
  }
  if (c > 0) c = Math.ceil(c * DERIVED_FLOOR_SCALE) / DERIVED_FLOOR_SCALE;
  delete i[e];
  t[e] = c;
  return c;
}

function refreshDerivedFloorCache(e, r) {
  var t = decodeStoredDerivedFloors(r, e);
  var i = {};
  var n = {};
  var a = [];
  for (var o = 0; o < e.length; o++) {
    var l = e[o];
    var u = resolveDerivedPrice(l, t, i, {});
    n[l] = u;
    a.push(u > 0 ? u * DERIVED_FLOOR_SCALE : 0);
  }
  Memory.marketPricingFloors = {
    v: DERIVED_FLOOR_CACHE_VERSION,
    t: Game.time,
    p: a
  };
  memoryManager.requestSave();
  _derivedFloorCache = {
    tick: Game.time,
    order: e,
    values: n
  };
  return _derivedFloorCache;
}

function ensureDerivedFloorCache() {
  var e = getDerivedProductOrder();
  var r = Memory.marketPricingFloors;
  if (_derivedFloorCache && _derivedFloorCache.order.length === e.length && _derivedFloorCache.tick <= Game.time && Game.time - _derivedFloorCache.tick < DERIVED_FLOOR_CACHE_INTERVAL) {
    return _derivedFloorCache;
  }
  if (r && r.v === DERIVED_FLOOR_CACHE_VERSION && typeof r.t === "number" && r.t <= Game.time && Game.time - r.t < DERIVED_FLOOR_CACHE_INTERVAL && Array.isArray(r.p) && r.p.length === e.length) {
    _derivedFloorCache = {
      tick: r.t,
      order: e,
      values: decodeStoredDerivedFloors(r, e)
    };
    return _derivedFloorCache;
  }
  return refreshDerivedFloorCache(e, r);
}

function getDerivedSellFloor(e) {
  var r = ensureDerivedFloorCache();
  return r.values[e] || 0;
}

function getTheoreticalPrice(e) {
  var r = getDerivedRecipe(e);
  if (!r) {
    return {
      resource: e,
      cost: null,
      price: null,
      source: "UNRESOLVED",
      reason: NON_DERIVABLE_THEORETICAL[e] ? "base resource has no forward theoretical recipe" : "no recipe for dead market",
      unresolvedInputs: [ e ]
    };
  }
  var t = getDerivedSellFloor(e);
  if (!(t > 0)) {
    return {
      resource: e,
      cost: null,
      price: null,
      source: "UNRESOLVED",
      reason: "one or more recipe inputs have no value",
      unresolvedInputs: [ e ]
    };
  }
  var i = getRecipeMarkup(e, r);
  return {
    resource: e,
    cost: t * (1 - FEE) / (1 + i),
    price: t,
    marginPct: i * 100,
    feePct: FEE * 100,
    processingLevel: r.kind === "lab" ? getProcessingLevel(e, {}) : r.level,
    source: "THEORETICAL",
    unresolvedInputs: []
  };
}

function getPriceProfile(e) {
  var r = buildCache();
  if (r.profiles.hasOwnProperty(e)) return r.profiles[e];
  var t = getBook(e);
  var i = t.referenceBid;
  var n = t.referenceAsk;
  var a = t.bestBid;
  var o = t.bestAsk;
  var l = t.bidLiquidity === "deep";
  var u = t.askLiquidity === "deep";
  var s = i !== null && i > 0;
  var c = n !== null && n > 0;
  var v = s && c ? "active" : s ? "buyers-only" : c ? "sellers-only" : "empty";
  var f = l && u;
  var d = s ? i : null;
  var E = c ? n : null;
  var g = getAvg48h(e);
  var p = [];
  var m = i !== null && n !== null ? (i + n) / 2 : null;
  var h = m > 0 ? Math.abs(n - i) / m : null;
  var P = h !== null && h > MAX_REFERENCE_SPREAD;
  if (i !== null && i > 0 && l) p.push(i);
  if (n !== null && n > 0 && u) p.push(n);
  var R = v === "active" && f && !t.referenceCrossed && historyAligned(g, p);
  var y = null;
  var A = null;
  var _ = null;
  var S = "NONE";
  var I = "none";
  if (v === "active" && f) {
    _ = m;
    S = t.referenceCrossed ? "CROSSED_LIVE" : P ? "LIVE_WIDE_SPREAD" : "LIVE";
    I = t.referenceCrossed || P ? "low" : "high";
    if (!t.referenceCrossed && R) {
      _ = _ * (1 - ACTIVE_HISTORY_WEIGHT) + g * ACTIVE_HISTORY_WEIGHT;
      S = "LIVE_HISTORY";
    } else if (g !== null) {
      y = t.referenceCrossed ? "crossed-book-history-ignored" : "history-far-from-live-sides";
    }
  } else {
    A = getTheoreticalPrice(e);
    if (A.price !== null) {
      _ = A.price;
      S = "THEORETICAL";
      I = "derived";
      if (g !== null) y = v === "active" ? "insufficient-live-depth-theoretical-value-preferred" : "dead-market-theoretical-value-preferred";
    } else if (v === "buyers-only" && l && d !== null) {
      _ = d;
      S = "ONE_SIDED_LIVE";
      I = "low";
    } else if (v === "sellers-only" && u && E !== null) {
      _ = E;
      S = "ONE_SIDED_LIVE";
      I = "low";
    } else {
      if (v !== "empty") I = "low";
      if (g !== null) {
        y = v === "active" || v === "buyers-only" || v === "sellers-only" ? "insufficient-live-depth" : "no-theoretical-value-for-dead-market";
      }
    }
  }
  if (t.crossed || t.referenceCrossed) I = "low";
  if (!A && (v !== "active" || t.referenceCrossed)) {
    A = getTheoreticalPrice(e);
  }
  var b = null;
  var O = null;
  var C = "NONE";
  var k = "NONE";
  if (!t.crossed && !t.referenceCrossed) {
    if (v === "active" && f) {
      b = Math.min(i + PASSIVE_PRICE_STEP, n - PASSIVE_GAP);
      O = Math.max(o - PASSIVE_PRICE_STEP, a + PASSIVE_GAP);
      if (b >= O) {
        b = i;
        O = n;
      }
      C = "ABUY";
      k = "ASELL";
    } else if (v === "buyers-only" && (d !== null || a !== null)) {
      var T = d !== null ? d : a;
      var L = (a !== null ? a : T) + PASSIVE_GAP;
      b = T + PASSIVE_PRICE_STEP;
      C = "LIVE_THIN";
      O = Math.max(L, _ || L);
      if (O <= b) O = b + PASSIVE_GAP;
      k = A && A.price !== null && _ !== null && _ > L ? "THEORETICAL" : "LIVE_THIN";
    } else if (v === "sellers-only" && (E !== null || o !== null)) {
      var B = E !== null ? E : o;
      var D = B - PASSIVE_GAP;
      b = Math.min(D, _ || D);
      C = A && A.price !== null && _ !== null && _ < D ? "THEORETICAL" : "LIVE_THIN";
      O = o !== null ? Math.max(.001, o - PASSIVE_PRICE_STEP) : Math.max(.001, B - PASSIVE_PRICE_STEP);
      if (b >= O) b = Math.max(.001, O - PASSIVE_GAP);
      k = "LIVE_THIN";
    } else if (o !== null && o > 0) {
      O = Math.max(.001, o - PASSIVE_PRICE_STEP);
      k = "LIVE_THIN";
    } else if (A && A.price !== null) {
      b = A.cost;
      O = A.price;
      C = "THEORETICAL";
      k = "THEORETICAL";
    }
    if (O > 0 && a !== null && a > 0) {
      var V = Math.max(O, a + PASSIVE_GAP);
      if (V > O) k = "LIVE_BID_GUARD";
      O = V;
    }
    if (!(b > 0)) {
      b = null;
      C = "NONE";
    }
    if (!(O > 0)) {
      O = null;
      k = "NONE";
    }
  }
  var M = {
    resource: e,
    state: v,
    sellPrice: d,
    buyPrice: E,
    postedSellPrice: O,
    postedSellSource: k,
    postedBuyPrice: b,
    postedBuySource: C,
    marketPrice: _,
    marketPriceSource: S,
    confidence: I,
    historyPrice: g,
    historyUsed: R,
    historyIgnoredReason: y,
    theoreticalCost: A ? A.cost : null,
    theoreticalPrice: A ? A.price : null,
    theoreticalSource: A ? A.source : null,
    unresolvedInputs: A ? A.unresolvedInputs || [] : [],
    sellLiquidity: t.bidLiquidity,
    buyLiquidity: t.askLiquidity,
    bidVolume: t.totalBidVolume,
    askVolume: t.totalAskVolume,
    rawBidPrice: i,
    rawAskPrice: n,
    bestBid: a,
    bestAsk: o,
    crossed: !!t.crossed,
    referenceCrossed: !!t.referenceCrossed,
    referenceBidVolume: t.referenceBidVolume,
    referenceAskVolume: t.referenceAskVolume,
    referenceBidTarget: t.referenceBidTarget,
    referenceAskTarget: t.referenceAskTarget,
    bidLevels: t.bidLevels,
    askLevels: t.askLevels,
    snapshotTick: r.snapshotTick,
    spreadRatio: h,
    wideSpread: P
  };
  r.profiles[e] = M;
  return M;
}

// Volume-weighted median of the daily average price across the shard-wide
// trade history (up to 14 days). A pump moves a mean; it cannot move this
// median without carrying half of the fortnight's traded volume, which costs
// the attacker real resources on every other trader's terms.
function historyMedianPrice(e) {
  var r = getHistDays(e) || [];
  var t = [];
  var i = 0;
  for (var n = 0; n < r.length; n++) {
    var a = r[n];
    if (!a || typeof a.avgPrice !== "number" || !(a.avgPrice > 0)) continue;
    var o = typeof a.volume === "number" && a.volume > 0 ? a.volume : 0;
    if (!(o > 0)) continue;
    t.push({
      price: a.avgPrice,
      volume: o
    });
    i += o;
  }
  if (t.length < CEILING_MIN_HISTORY_DAYS || !(i > 0)) return null;
  t.sort(function(e, r) {
    return e.price - r.price;
  });
  var l = i / 2;
  var u = 0;
  for (var s = 0; s < t.length; s++) {
    u += t[s].volume;
    if (u >= l) return t[s].price;
  }
  return t[t.length - 1].price;
}

// Median price of one side of the book by cumulative volume over the best
// DEPTH_VOLUME units. Orders arrive best-first from the snapshot, so this
// walks outward from the touch: half of the real depth has to be repriced to
// move it, where a top-of-book read moves for the price of one order. The
// depth only counts as evidence when it spans several price levels from
// several different rooms, so one player stacking one room proves nothing.
function depthMedianPrice(e, descending) {
  if (!e || e.length === 0) return null;
  var r = [];
  var t = {};
  var i = {};
  var n = 0;
  var a = 0;
  var previous = null;
  for (var o = 0; o < e.length && a < DEPTH_VOLUME; o++) {
    var l = e[o];
    if (!l || typeof l.price !== "number" || !(l.price > 0)) continue;
    var s = String(l.price);
    if (!t.hasOwnProperty(s)) {
      // Real books are bimodal: a tradeable cluster at the touch, a gap, then
      // orders nobody expects to fill (or a wall of fake size parked at 0.03
      // to catch a mistake). Averaging across the gap prices the wrong half of
      // the book, so the walk stops at the gap and only the contiguous cluster
      // counts as depth.
      if (previous !== null) {
        var ratio = l.price > previous ? l.price / previous : previous / l.price;
        if (ratio > CEILING_LEVEL_GAP) break;
      }
      t[s] = 0;
      r.push({
        key: s,
        price: l.price
      });
      previous = l.price;
    }
    var u = Math.min(orderAvailableAmount(l), DEPTH_VOLUME - a);
    if (!(u > 0)) continue;
    t[s] += u;
    if (l.roomName && !i[l.roomName]) {
      i[l.roomName] = true;
      n++;
    }
    a += u;
  }
  if (a < CEILING_MIN_VOLUME || r.length < CEILING_MIN_LEVELS || n < CEILING_MIN_ROOMS) return null;
  var c = a / 2;
  var d = 0;
  for (var v = 0; v < r.length; v++) {
    d += t[r[v].key];
    if (d >= c) return r[v].price;
  }
  return r[r.length - 1].price;
}

// The hard upper bound on any price we will PAY for a resource, corroborated
// by independent evidence and reported with the source that binds.
// { ceiling, reference, source, sources[] }; ceiling null means no source
// qualified -- callers must fail closed there, never fall back to the book.
function buyPriceCeiling(e) {
  var r = buildCache();
  if (r.buyCeilings.hasOwnProperty(e)) return r.buyCeilings[e];
  var t = [];
  var i = historyMedianPrice(e);
  if (i > 0) t.push({
    source: "HISTORY_14D",
    reference: i,
    ceiling: i * CEILING_HISTORY_MULT,
    caps: true
  });
  var n = depthMedianPrice(r.sells[e] || [], false);
  if (n > 0) t.push({
    source: "ASK_DEPTH",
    reference: n,
    ceiling: n * CEILING_ASK_MULT,
    caps: true
  });
  // Reported for diagnostics and disagreement, but never allowed to cap: on
  // this shard the bid side routinely sits far under the traded price.
  var a = depthMedianPrice(r.buys[e] || [], true);
  if (a > 0) t.push({
    source: "BID_DEPTH",
    reference: a,
    ceiling: null,
    caps: false
  });
  var o = null;
  for (var l = 0; l < t.length; l++) {
    if (!t[l].caps) continue;
    if (!o || t[l].ceiling < o.ceiling) o = t[l];
  }
  var c = o ? o.ceiling : null;
  var d = o ? o.reference : null;
  var v = o ? o.source : "NONE";
  // Floor: whatever else the book says, we can always pay what the shard has
  // actually been paying. Without this a single depressed source drags the cap
  // under the traded price and silently blocks legitimate buying.
  if (i > 0 && (c === null || c < i)) {
    c = i;
    d = i;
    v = "HISTORY_FLOOR";
  }
  var u = {
    resource: e,
    ceiling: c,
    reference: d,
    source: v,
    sources: t
  };
  r.buyCeilings[e] = u;
  return u;
}

function maxBuyPrice(e) {
  var r = buyPriceCeiling(e);
  return r && r.ceiling > 0 ? r.ceiling : null;
}

// What a book price is worth believing. Above the ceiling the live book is
// not evidence of anything, so fall back to the reference the binding source
// actually supports -- the 14-day median, or the median of real depth. Paying
// the ceiling itself would still mean paying the full 10x on purpose; paying
// the reference is fair value, and it is what a sane counterparty sells at.
function believableBuyPrice(e, r) {
  if (!(r > 0)) return r;
  var t = buyPriceCeiling(e);
  if (!t || !(t.ceiling > 0) || r <= t.ceiling) return r;
  if (Game.time - (_ceilingLogTick[e] || 0) >= CEILING_LOG_GATE) {
    _ceilingLogTick[e] = Game.time;
    console.log("[Pricing] " + e + " book price " + r.toFixed(3) + " is above the corroborated ceiling " + t.ceiling.toFixed(3) + "; using the " + t.source + " reference " + t.reference.toFixed(3) + " instead.");
  }
  return t.reference;
}

// The price to POST on a standing buy order -- a different question from what
// energy is worth. getStatusEnergyPrice() answers the valuation question and
// includes the direct route; posting at that number would rest a bid under the
// competing bids whenever a cheap ask exists, which wins nothing: the direct
// route is taken by acting, not by bidding low. So the posting price is the
// bid leg alone, still clamped to the corroborated ceiling.
function passiveBuyPrice(e) {
  var r = buildCache();
  if (r.passiveBuy.hasOwnProperty(e)) return r.passiveBuy[e];
  var t = getPriceProfile(e);
  var i = isEnergyResource(e) ? energyAcquisitionQuote().bid || 0 : t.postedBuyPrice;
  if (i > 0) i = believableBuyPrice(e, i);
  r.passiveBuy[e] = i;
  return i;
}

function actualBuyPrice(e) {
  return passiveBuyPrice(e);
}

function computePostedBid(e, r) {
  var t = getPriceProfile(e).postedBuyPrice;
  if (!(t > 0)) return null;
  if (typeof r === "number" && r > 0) {
    if (t > r) return null;
    t = Math.min(t, r);
  }
  return Math.max(t, .001);
}

function liquidationPrice(e) {
  var r = getPriceProfile(e);
  return r.sellLiquidity === "deep" && r.sellPrice !== null ? r.sellPrice : 0;
}

function passiveSellPrice(e) {
  return getPriceProfile(e).postedSellPrice;
}

function applyBestBidGap(e, r) {
  if (!(r > 0)) return r;
  var t = getBook(e);
  return t && t.bestBid !== null && t.bestBid > 0 ? Math.max(r, t.bestBid + PASSIVE_GAP) : r;
}

function actualSellPrice(e) {
  return passiveSellPrice(e);
}

function getConversionExitQuote(e, r, t) {
  if (!(r > 0)) return null;
  var i = getBook(e);
  var n = executableSellQuote(e, r, t);
  if (n) {
    n.method = n.crossed ? "CROSSED_BID" : "LIVE_BID";
    return n;
  }
  var a = executableBuyQuote(e, r, t);
  if (a && i.bestAsk !== null) {
    var o = getPriceProfile(e);
    var l = o.postedSellPrice;
    if (!(l > 0)) return null;
    var u = o.marketPriceSource === "THEORETICAL" ? "THEORETICAL" : "LIVE_ASK";
    return {
      price: l,
      amount: r,
      orderCount: i.askCount,
      transferEnergy: 0,
      bestBid: i.bestBid,
      bestAsk: i.bestAsk,
      crossed: i.crossed,
      source: u,
      method: u
    };
  }
  var s = getPriceProfile(e);
  if (!(s.postedSellPrice > 0)) return null;
  return {
    price: s.postedSellPrice,
    amount: r,
    orderCount: 0,
    transferEnergy: 0,
    bestBid: i.bestBid,
    bestAsk: i.bestAsk,
    crossed: !!i.crossed,
    source: s.marketPriceSource === "THEORETICAL" ? "THEORETICAL" : "PROFILE",
    method: s.marketPriceSource === "THEORETICAL" ? "THEORETICAL" : "PROFILE"
  };
}

var FACTORY_COOLDOWN_TABLE = {
  utrium_bar: 20,
  lemergium_bar: 20,
  zynthium_bar: 20,
  keanium_bar: 20,
  ghodium_melt: 20,
  oxidant: 20,
  reductant: 20,
  purifier: 20,
  battery: 10,
  wire: 8,
  cell: 8,
  alloy: 8,
  condensate: 8,
  U: 20,
  L: 20,
  Z: 20,
  K: 20,
  G: 20,
  O: 20,
  H: 20,
  X: 20,
  energy: 10,
  composite: 50,
  tube: 50,
  phlegm: 50,
  switch: 50,
  concentrate: 50,
  crystal: 100,
  fixtures: 100,
  tissue: 100,
  transistor: 100,
  extract: 100,
  liquid: 150,
  frame: 150,
  muscle: 150,
  microchip: 150,
  spirit: 150,
  hydraulics: 400,
  organoid: 400,
  circuit: 400,
  emanation: 400,
  machine: 600,
  organism: 600,
  device: 600,
  essence: 600
};
function inputCeilings(e, r) {
  var t = COMMODITIES && COMMODITIES[e];
  if (!t) return null;
  var i = typeof t.amount === "number" && t.amount > 0 ? t.amount : 1;
  var n = t.components || {};
  var a = passiveSellPrice(e);
  if (!(a > 0)) return null;
  var o = a * i;
  var l = o / (1 + r / 100);
  var u = n[RESOURCE_ENERGY] || 0;
  var s = u > 0 ? getStatusEnergyPrice() : 0;
  if (u > 0 && !(s > 0)) return null;
  var c = u > 0 ? s * u : 0;
  var v = l - c;
  if (v <= 0) return null;
  var f = {}, d = 0;
  for (var E in n) {
    if (!n.hasOwnProperty(E) || E === RESOURCE_ENERGY) continue;
    var g = getInputBuyQuote(E, n[E]);
    var p = g && g.price > 0 ? g.price : 0;
    if (!(p > 0)) return null;
    f[E] = p;
    d += p * n[E];
  }
  if (d <= 0) return null;
  var m = Math.min(v / d, 1);
  var h = {};
  for (var P in n) {
    if (!n.hasOwnProperty(P) || P === RESOURCE_ENERGY) continue;
    h[P] = f[P] > 0 ? f[P] * m : 0;
  }
  return h;
}

function breakEvenInputCeilings(e) {
  var r = COMMODITIES && COMMODITIES[e];
  if (!r) return null;
  var t = typeof r.amount === "number" && r.amount > 0 ? r.amount : 1;
  var i = r.components || {};
  var n = passiveSellPrice(e);
  if (!(n > 0)) return null;
  var a = n * t;
  var o = i[RESOURCE_ENERGY] || 0;
  var l = o > 0 ? getStatusEnergyPrice() : 0;
  if (o > 0 && !(l > 0)) return null;
  var u = o > 0 ? l * o : 0;
  var s = Math.max(.001, a * (1 - FEE) * .01);
  var c = (a * (1 - FEE) - u - s) / (1 + FEE);
  if (!(c > 0)) return null;
  var v = {}, f = 0;
  for (var d in i) {
    if (!i.hasOwnProperty(d) || d === RESOURCE_ENERGY) continue;
    var E = getInputBuyQuote(d, i[d]);
    var g = E && E.price > 0 ? E.price : 0;
    if (!(g > 0)) return null;
    v[d] = g;
    f += g * i[d];
  }
  if (!(f > 0) || f > c) return null;
  var p = c / f;
  var m = {};
  for (var h in v) {
    m[h] = Math.floor(v[h] * p * 1e3) / 1e3;
    if (!(m[h] > 0)) return null;
  }
  return m;
}

function chooseBuyMethod(e, r, t) {
  t = t || {};
  var i = typeof t.rangeGate === "number" ? t.rangeGate : DEFAULT_RANGE_GATE;
  var n = getBook(e);
  var a = getRange7d(e);
  var o = getTrend7d(e);
  var l = {
    method: "opportunistic",
    suggestedBid: null,
    defensive: false,
    reason: "",
    book: n,
    range: a,
    trend: o
  };
  var u = typeof r === "number" && r > 0;
  var s = n.bestAsk === null;
  var c = typeof t.amount === "number" && t.amount > 0 ? t.amount : null;
  var v = c !== null && n.totalAskVolume < c;
  var f = s || v || u && n.bestAsk > r;
  var d = s ? "no external asks" : v ? "insufficient external ask depth" : "no asks under ceiling";
  var E = getPriceProfile(e);
  var g = E.postedBuyPrice;
  if (!(g > 0) && E.marketPrice !== null && E.marketPrice > 0) {
    g = E.marketPrice * .95;
  }
  if (u && g > 0) g = Math.min(g, r);
  if (!(g > 0)) {
    if (!t.forceOrder) {
      l.reason = "no canonical passive bid; wait for a takeable ask or better market data";
      return l;
    }
    g = .001;
  }
  g = Math.max(g, .001);
  if (t.forceOrder) {
    l.method = "order";
    l.suggestedBid = g;
    l.reason = "forced standing order";
    return l;
  }
  if (o === "rising" && !f) {
    l.reason = "rising trend; take existing asks";
    return l;
  }
  if (o === "falling") {
    var p = getWeekLow(e);
    if (p !== null) g = Math.max(Math.min(g, p * 1.02), .001);
  }
  if (f) {
    l.method = "order";
    if (a === null) {
      l.defensive = true;
      l.reason = d + "; sparse history, defensive profile bid";
    } else if (a > i) {
      var m = getWeekLow(e);
      if (m !== null) g = Math.min(g, m * 1.05);
      l.defensive = true;
      l.reason = "thin market, weekly range " + (a * 100).toFixed(0) + "% > gate; defensive bid";
    } else {
      l.reason = d;
    }
    l.suggestedBid = Math.max(g, .001);
    return l;
  }
  var h = FEE + SPREAD_BUFFER;
  if (a !== null && a > i) h = h * HIGH_RANGE_HURDLE_MULT;
  var P = (n.bestAsk - g) / g;
  if (P > h) {
    l.method = "order";
    l.suggestedBid = Math.max(g, .001);
    l.reason = "spread " + (P * 100).toFixed(0) + "% > hurdle " + (h * 100).toFixed(0) + "%";
    return l;
  }
  l.reason = "spread " + (P * 100).toFixed(0) + "% below hurdle " + (h * 100).toFixed(0) + "%";
  return l;
}

function fmtPrice(e) {
  if (e === null || e === undefined) return "-";
  if (e >= 1) return e.toFixed(3);
  if (e >= .01) return e.toFixed(4);
  return e.toFixed(6);
}

function fmtVol(e) {
  if (e >= 1e6) return (e / 1e6).toFixed(1) + "M";
  if (e >= 1e3) return (e / 1e3).toFixed(1) + "k";
  return "" + e;
}

function pad(e, r) {
  e = "" + e;
  while (e.length < r) e += " ";
  return e;
}

function fit(e, r) {
  e = "" + e;
  if (e.length > r) return e.slice(0, Math.max(0, r - 3)) + "...";
  return pad(e, r);
}

function printPrices(e, r) {
  if (r === undefined) r = "price";
  var t = buildCache();
  var i = {};
  for (var n in t.buys) i[n] = true;
  for (var a in t.sells) i[a] = true;
  var o = getDerivedProductOrder();
  for (var l = 0; l < o.length; l++) i[o[l]] = true;
  var u = [];
  for (var s in i) {
    if (e && s !== e) continue;
    u.push({
      resource: s,
      data: getBook(s),
      profile: getPriceProfile(s)
    });
  }
  if (r === "price") {
    u.sort(function(e, r) {
      var t = e.profile.marketPrice !== null ? e.profile.marketPrice : 0;
      var i = r.profile.marketPrice !== null ? r.profile.marketPrice : 0;
      return i - t;
    });
  } else {
    u.sort(function(e, r) {
      return e.resource.localeCompare(r.resource);
    });
  }
  var c = pad("Resource", 18) + pad("Market", 10) + pad("Sell", 10) + pad("Buy", 10) + pad("State", 14) + pad("Source", 14) + pad("BidVol", 10) + pad("AskVol", 10);
  console.log("=== MARKET PRICES (external orders only) ===");
  console.log(c);
  console.log(Array(101).join("-"));
  for (var v = 0; v < u.length; v++) {
    var f = u[v].resource;
    var d = u[v].data;
    var E = u[v].profile;
    console.log(pad(f, 18) + pad(fmtPrice(E.marketPrice), 10) + pad(fmtPrice(E.sellPrice), 10) + pad(fmtPrice(E.buyPrice), 10) + pad(E.state + "/" + E.confidence, 14) + pad(E.marketPriceSource, 14) + pad(fmtVol(d.totalBidVolume), 10) + pad(fmtVol(d.totalAskVolume), 10));
  }
  console.log("Reference depth: up to " + fmtVol(DEPTH_VOLUME) + " units/side; level cap 25%; dust filter: remaining >= " + MIN_ORDER_REMAINING + " | " + u.length + " resources");
  return "OK - " + u.length + " resources priced";
}

function printPriceDiagnostics(e) {
  e = typeof e === "number" && isFinite(e) ? Math.floor(e) : 5;
  e = Math.max(1, Math.min(25, e));
  var r = getDerivedProductOrder().slice();
  if (r.length === 0) {
    var t = util.marketSnapshot();
    for (var i in t.idx) r.push(i);
  }
  if (r.length === 0) return "[priceDiagnostics] No commodity or market resources found.";
  for (var n = r.length - 1; n > 0; n--) {
    var a = Math.floor(Math.random() * (n + 1));
    var o = r[n];
    r[n] = r[a];
    r[a] = o;
  }
  var l = r.slice(0, Math.min(e, r.length));
  var u = [ "=== MARKET PRICE THRESHOLD DIAGNOSTICS ===", "Sample: " + l.length + " random forward commodity entries", "Resource | State | Source | Market | Sell | Buy | BestBid | BestAsk | Spread | BidVol | AskVol | Levels | History | Theory | Missing inputs" ];
  u.push(Array(150).join("-"));
  for (var s = 0; s < l.length; s++) {
    var c = l[s];
    var v = getPriceProfile(c);
    var f = v.spreadRatio === null ? "-" : (v.spreadRatio * 100).toFixed(1) + "%";
    var d = (v.bidLevels || 0) + "/" + (v.askLevels || 0);
    var E = v.unresolvedInputs && v.unresolvedInputs.length ? v.unresolvedInputs.slice(0, 3).join(",") : "-";
    if (E.length > 22) E = E.slice(0, 19) + "...";
    u.push([ c, v.state + "/" + v.confidence, v.marketPriceSource, fmtPrice(v.marketPrice), fmtPrice(v.sellPrice), fmtPrice(v.buyPrice), fmtPrice(v.bestBid), fmtPrice(v.bestAsk), f, fmtVol(v.bidVolume || 0), fmtVol(v.askVolume || 0), d, fmtPrice(v.historyPrice), fmtPrice(v.theoreticalPrice), E ].join(" | "));
  }
  u.push("");
  u.push("Thresholds: reference depth <= " + fmtVol(DEPTH_VOLUME) + ", minimum coverage " + (MIN_REFERENCE_COVERAGE * 100).toFixed(0) + "%" + ", minimum levels " + REFERENCE_LEVELS + ", maximum high-confidence spread " + (MAX_REFERENCE_SPREAD * 100).toFixed(0) + "%" + ", history tolerance " + (HISTORY_ALIGNMENT_TOLERANCE * 100).toFixed(0) + "%");
  u.push("Thin sides remain observable; only deep two-sided books receive high-confidence LIVE status.");
  return u.join("\n");
}

global.priceDiagnostics = function(e) {
  return printPriceDiagnostics(e);
};
global.marketPriceDiagnostics = global.priceDiagnostics;
function resolveResourceInput(e) {
  if (typeof e !== "string") return e;
  if (typeof RESOURCES_ALL !== "undefined") {
    if (RESOURCES_ALL.indexOf(e) !== -1) return e;
    var r = e.toLowerCase();
    if (RESOURCES_ALL.indexOf(r) !== -1) return r;
    var t = [ e, "RESOURCE_" + e.toUpperCase() ];
    for (var i = 0; i < t.length; i++) {
      var n = global[t[i]];
      if (typeof n === "string" && RESOURCES_ALL.indexOf(n) !== -1) return n;
    }
  }
  return e;
}

global.prices = function(e, r) {
  return printPrices(e ? resolveResourceInput(e) : e, r);
};
global.priceProfile = function(e) {
  if (!e) return 'Usage: priceProfile("purifier")';
  return JSON.stringify(getPriceProfile(resolveResourceInput(e)));
};
global.conversionQuote = function(e, r, t) {
  if (!e || !(r > 0)) return 'Usage: conversionQuote("H", 3000, "W1N1")';
  e = resolveResourceInput(e);
  var i = getConversionExitQuote(e, r, t);
  if (!i) return "[conversionQuote] No executable or canonical theoretical price for " + e;
  return JSON.stringify({
    resource: e,
    amount: r,
    room: t || null,
    method: i.method,
    source: i.source,
    price: i.price,
    bestBid: i.bestBid,
    bestAsk: i.bestAsk,
    crossed: i.crossed,
    orderCount: i.orderCount,
    transferEnergy: i.transferEnergy || 0
  });
};
module.exports = {
  getBook: getBook,
  getPriceProfile: getPriceProfile,
  getTheoreticalPrice: getTheoreticalPrice,
  getDerivedSellFloor: getDerivedSellFloor,
  getDerivedProductOrder: getDerivedProductOrder,
  getSubstantialBuyPrice: getSubstantialBuyPrice,
  getStatusEnergyPrice: getStatusEnergyPrice,
  getInputBuyQuote: getInputBuyQuote,
  executableBuyPrice: executableBuyPrice,
  executableBuyQuote: executableBuyQuote,
  executableSellQuote: executableSellQuote,
  getRestrictedDirectQuote: getRestrictedDirectQuote,
  getAvg48h: getAvg48h,
  getAvg7d: getAvg7d,
  getHistDays: getHistDays,
  getRange7d: getRange7d,
  getTrend7d: getTrend7d,
  getWeekLow: getWeekLow,
  getRawOrders: getRawOrders,
  buyPriceCeiling: buyPriceCeiling,
  maxBuyPrice: maxBuyPrice,
  believableBuyPrice: believableBuyPrice,
  deliveredBuyQuote: deliveredBuyQuote,
  energyAcquisitionQuote: energyAcquisitionQuote,
  acquisitionQuote: acquisitionQuote,
  DELIVERY_MIN_YIELD: DELIVERY_MIN_YIELD,
  DELIVERED_REFERENCE_AMOUNT: DELIVERED_REFERENCE_AMOUNT,
  historyMedianPrice: historyMedianPrice,
  depthMedianPrice: depthMedianPrice,
  passiveBuyPrice: passiveBuyPrice,
  passiveSellPrice: passiveSellPrice,
  applyBestBidGap: applyBestBidGap,
  actualBuyPrice: actualBuyPrice,
  actualSellPrice: actualSellPrice,
  getConversionExitQuote: getConversionExitQuote,
  liquidationPrice: liquidationPrice,
  computePostedBid: computePostedBid,
  inputCeilings: inputCeilings,
  breakEvenInputCeilings: breakEvenInputCeilings,
  chooseBuyMethod: chooseBuyMethod,
  printPrices: printPrices,
  FEE: FEE,
  DEPTH_VOLUME: DEPTH_VOLUME,
  MIN_ORDER_REMAINING: MIN_ORDER_REMAINING
};
