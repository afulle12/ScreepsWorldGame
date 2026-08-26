// LLM: Read docs/codex.js before reviewing or changing this file.
// marketChaosQuery.js
// Console globals: marketChaos
// Example: marketChaos() - Chaos report for 5 randomly sampled market resources
// Example: marketChaos(3) - Sample 3 resources
// Example: marketChaos(2, 5) - Sample 2 resources, 5 order levels per side
// Example: marketChaos(['energy', 'battery']) - Report on an explicit list

// Read-only diagnostic. Samples resources at random (or takes an explicit
// list) and, for each, prints the competitive end of both sides of the book,
// the last three daily prints with their stddev, and the numbers that say
// whether the visible price is backed by anything: the screen price against
// the 14-day median, how far the volume-weighted reference sits from the
// touch, how much of the depth one room or one price level controls, and how
// far the independent references disagree. Ranked by a composite chaos score,
// highest first; "dead" means no book at all.
//
// Sides come from the RAW snapshot, not marketPricing's filtered book, so our
// own orders (*) and sub-dust orders (.) are visible rather than silently
// dropped -- reading the book as the pricing path sees it is what hid the
// 12555 energy print. Costs one getHistory call per sampled resource
// (cached ~1000 ticks), so keep the sample small on a tight bucket.
(function registerMarketChaosGlobal() {
  var util = require("util");
  var pricing = require("marketPricing");

  var DEFAULT_SAMPLE = 5;
  var DEFAULT_DEPTH = 10;
  var MAX_SAMPLE = 25;
  var MAX_DEPTH = 25;
  var HISTORY_DAYS = 3;
  var TOUCH_BAND = .25; // price area counted as "at the touch", either side
  // Subscription/account goods trade on their own logic and are not commodities.
  // Constant values, not the constant names: RESOURCE_CPU_UNLOCK is
  // "cpuUnlock" and RESOURCE_ACCESS_KEY is "accessKey". Spelling these
  // snake_case silently matches nothing and account goods leak into the pool.
  var NOT_A_COMMODITY = {
    pixel: true,
    cpuUnlock: true,
    accessKey: true,
    token: true
  };
  // Chaos score weights. Each component is a 0..1 ratio scaled by its own
  // saturation point, so the printed components always add up to the score.
  var W_SPREAD = 25;
  var SPREAD_SATURATION = 50; // percent spread that counts as maximal
  var W_DRIFT = 25; // the screen price against the 14-day median
  var DRIFT_SATURATION = 4; // ratio beyond 1.0 that counts as maximal
  var W_DISAGREE = 20;
  var DISAGREE_SATURATION = 4; // reference max/min beyond 1.0 that counts as maximal
  var W_ROOM = 12;
  var W_LEVEL = 8;
  var W_DISPERSION = 10;
  var DISPERSION_SATURATION = .5; // daily stddev/avg that counts as maximal

  function pad(value, width, right) {
    var text = String(value);
    while (text.length < width) text = right ? text + " " : " " + text;
    return text;
  }

  function fmt(value, digits) {
    if (typeof value !== "number" || !isFinite(value)) return "n/a";
    return value.toFixed(digits === undefined ? 3 : digits);
  }

  function fmtVol(value) {
    if (typeof value !== "number" || !isFinite(value)) return "n/a";
    if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
    if (value >= 1e3) return (value / 1e3).toFixed(1) + "k";
    return String(Math.round(value));
  }

  function fmtScore(score) {
    return score === null ? "dead" : score.toFixed(0);
  }

  function clamp01(value) {
    if (!(value > 0)) return 0;
    return value > 1 ? 1 : value;
  }

  // Candidate pool: everything with a live order, plus every factory recipe
  // output, so dead commodity markets can be sampled too.
  function candidatePool() {
    var seen = {};
    var snapshot = util.marketSnapshot();
    for (var i = 0; i < snapshot.all.length; i++) {
      var resource = snapshot.all[i] && snapshot.all[i].resourceType;
      if (resource && !NOT_A_COMMODITY[resource]) seen[resource] = true;
    }
    if (typeof COMMODITIES !== "undefined" && COMMODITIES) {
      for (var commodity in COMMODITIES) {
        if (!NOT_A_COMMODITY[commodity]) seen[commodity] = true;
      }
    }
    return Object.keys(seen).sort();
  }

  // Partial Fisher-Yates: uniform sample without replacement.
  function sample(pool, count) {
    var picked = pool.slice();
    var taken = Math.min(count, picked.length);
    for (var i = 0; i < taken; i++) {
      var j = i + Math.floor(Math.random() * (picked.length - i));
      var swap = picked[i];
      picked[i] = picked[j];
      picked[j] = swap;
    }
    return picked.slice(0, taken).sort();
  }

  // The competing book: what marketPricing's filtered view sees. Our own
  // orders and sub-dust orders stay in the printed listing but must not
  // colour the metrics, or our own standing bid reads as 100% concentration.
  function competing(orders, myRooms) {
    var out = [];
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      if (!order || typeof order.price !== "number") continue;
      if (order.roomName && myRooms[order.roomName]) continue;
      if (util.getOrderRemaining(order) < pricing.MIN_ORDER_REMAINING) continue;
      out.push(order);
    }
    return out;
  }

  // How much of the tradeable price area one room, and one price level,
  // control. Measured over every competing order within TOUCH_BAND of the best
  // price rather than a fixed volume window: order sizes span four orders of
  // magnitude across resources, so a 20k window reads "one room, 100%" for
  // energy (where a single ask is 50k) while spanning the entire book for a
  // lab compound. Distance from the touch is the scale-free question.
  function concentration(orders) {
    if (!orders || orders.length === 0) return null;
    var best = orders[0].price;
    if (!(best > 0)) return null;
    var limit = best > 0 ? best * (1 + TOUCH_BAND) : 0;
    var floor = best * (1 - TOUCH_BAND);
    var byRoom = {};
    var byLevel = {};
    var used = 0;
    var rooms = 0;
    var levels = 0;
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      if (!order || typeof order.price !== "number") continue;
      // Orders arrive best-first, so the first one outside the band ends it.
      if (order.price > limit || order.price < floor) break;
      var take = util.getOrderRemaining(order);
      if (!(take > 0)) continue;
      var room = order.roomName || "?";
      if (byRoom[room] === undefined) {
        byRoom[room] = 0;
        rooms++;
      }
      byRoom[room] += take;
      var level = String(order.price);
      if (byLevel[level] === undefined) {
        byLevel[level] = 0;
        levels++;
      }
      byLevel[level] += take;
      used += take;
    }
    if (!(used > 0)) return null;
    var topRoom = 0;
    for (var r in byRoom) if (byRoom[r] > topRoom) topRoom = byRoom[r];
    var topLevel = 0;
    for (var l in byLevel) if (byLevel[l] > topLevel) topLevel = byLevel[l];
    return {
      volume: used,
      rooms: rooms,
      levels: levels,
      roomShare: topRoom / used,
      levelShare: topLevel / used
    };
  }

  // Spread between the independent references marketPricing would trust.
  // Disagreement is the honest measure of how little the book is telling us.
  function referenceSpread(band) {
    if (!band || !band.sources || band.sources.length < 2) return null;
    var low = null;
    var high = null;
    for (var i = 0; i < band.sources.length; i++) {
      var reference = band.sources[i].reference;
      if (!(reference > 0)) continue;
      if (low === null || reference < low) low = reference;
      if (high === null || reference > high) high = reference;
    }
    return low > 0 && high > 0 ? high / low : null;
  }

  function collect(resource, depth) {
    var myRooms = util.getMyRooms();
    var asks = util.marketOrders(resource, ORDER_SELL);
    var bids = util.marketOrders(resource, ORDER_BUY);
    var liveAsks = competing(asks, myRooms);
    var liveBids = competing(bids, myRooms);
    var profile = pricing.getPriceProfile(resource);
    var band = pricing.buyPriceCeiling(resource);
    var days = (pricing.getHistDays(resource) || []).slice(-HISTORY_DAYS);
    var askConc = concentration(liveAsks);
    var bidConc = concentration(liveBids);
    var bestAsk = liveAsks.length ? liveAsks[0].price : null;
    var bestBid = liveBids.length ? liveBids[0].price : null;
    var mid = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
    var spreadPct = mid > 0 ? (bestAsk - bestBid) / mid * 100 : null;
    // Distance from the touch to the volume-weighted reference: large means
    // the best price is an outlier rather than the market. rawAskPrice and
    // rawBidPrice are the profile's bounded reference prices.
    var askDrift =
      profile.rawAskPrice > 0 && bestAsk > 0
        ? Math.abs(profile.rawAskPrice - bestAsk) / profile.rawAskPrice * 100
        : null;
    var bidDrift =
      profile.rawBidPrice > 0 && bestBid > 0
        ? Math.abs(profile.rawBidPrice - bestBid) / profile.rawBidPrice * 100
        : null;
    var latest = days.length ? days[days.length - 1] : null;
    var dispersion =
      latest && latest.avgPrice > 0 && typeof latest.stddevPrice === "number"
        ? latest.stddevPrice / latest.avgPrice
        : null;
    var disagree = referenceSpread(band);
    // How far the price on the screen sits from what the shard actually
    // traded at. Symmetric, so a collapsed book scores like an inflated one.
    var historyMedian = pricing.historyMedianPrice(resource);
    var touch = bestAsk !== null ? bestAsk : bestBid;
    var drift = null;
    if (historyMedian > 0 && touch > 0) {
      drift = touch >= historyMedian ? touch / historyMedian : historyMedian / touch;
    }
    // Score only what can be measured, then scale to the weight actually
    // used. An unmeasurable dimension is missing information, not evidence of
    // calm -- but inventing a maximal value for it would rank a dead market
    // above a manipulated one.
    var weighted = 0;
    var available = 0;
    var hasBook = bestAsk !== null || bestBid !== null;
    if (hasBook) {
      // A one-sided book is the state that produced the 12555 print: there is
      // a price on the screen and nothing on the other side to contradict it.
      // Unmeasurable spread there means maximal distrust, not missing data.
      weighted += W_SPREAD * (spreadPct === null ? 1 : clamp01(spreadPct / SPREAD_SATURATION));
      available += W_SPREAD;
    }
    if (drift !== null) {
      weighted += W_DRIFT * clamp01((drift - 1) / DRIFT_SATURATION);
      available += W_DRIFT;
    }
    if (disagree !== null) {
      weighted += W_DISAGREE * clamp01((disagree - 1) / DISAGREE_SATURATION);
      available += W_DISAGREE;
    }
    if (askConc) {
      weighted += W_ROOM * askConc.roomShare + W_LEVEL * askConc.levelShare;
      available += W_ROOM + W_LEVEL;
    }
    if (dispersion !== null) {
      weighted += W_DISPERSION * clamp01(dispersion / DISPERSION_SATURATION);
      available += W_DISPERSION;
    }
    return {
      resource: resource,
      asks: asks,
      bids: bids,
      liveAsks: liveAsks,
      liveBids: liveBids,
      profile: profile,
      band: band,
      days: days,
      askConc: askConc,
      bidConc: bidConc,
      bestAsk: bestAsk,
      bestBid: bestBid,
      spreadPct: spreadPct,
      askDrift: askDrift,
      bidDrift: bidDrift,
      dispersion: dispersion,
      disagree: disagree,
      drift: drift,
      historyMedian: historyMedian,
      score: hasBook && available > 0 ? weighted / available * 100 : null,
      measured: available,
      depth: depth,
      myRooms: myRooms
    };
  }

  function sideLines(report, orders, label, quantityHeader) {
    var out = [];
    out.push("  " + label + " (" + orders.length + " orders)");
    if (!orders.length) {
      out.push("    none");
      return out;
    }
    out.push(
      "    " +
        pad("Price", 14) +
        " " +
        pad(quantityHeader, 11) +
        " " +
        pad("Room", 8, true) +
        "  flag"
    );
    for (var i = 0; i < Math.min(report.depth, orders.length); i++) {
      var order = orders[i];
      var remaining = util.getOrderRemaining(order);
      var flags = [];
      if (order.roomName && report.myRooms[order.roomName]) flags.push("* ours");
      if (remaining < pricing.MIN_ORDER_REMAINING) flags.push(". dust");
      out.push(
        "    " +
          pad(fmt(order.price), 14) +
          " " +
          pad(fmtVol(remaining), 11) +
          " " +
          pad(order.roomName || "?", 8, true) +
          "  " +
          flags.join(" ")
      );
    }
    return out;
  }

  function detail(report) {
    var out = [];
    var profile = report.profile;
    out.push("");
    out.push(
      "=== " +
        report.resource +
        " === chaos " +
        fmtScore(report.score) +
        (report.score === null ? "" : "/100") +
        " | " +
        profile.state +
        " | confidence " +
        profile.confidence +
        " | bid depth " +
        profile.sellLiquidity +
        ", ask depth " +
        profile.buyLiquidity
    );
    out = out.concat(sideLines(report, report.asks, "ASKS (cheapest first)", "Available"));
    out = out.concat(sideLines(report, report.bids, "BIDS (richest first)", "Wanted"));
    out.push(
      "  Competing touch (ours and dust excluded): bid " +
        fmt(report.bestBid) +
        " / ask " +
        fmt(report.bestAsk) +
        (report.spreadPct !== null
          ? "  spread " + fmt(report.spreadPct, 1) + "%"
          : report.bestAsk === null && report.bestBid === null
            ? "  no competing book"
            : "  spread n/a (one-sided)")
    );
    out.push(
      "  Reference (volume-weighted): bid " +
        fmt(profile.rawBidPrice) +
        " / ask " +
        fmt(profile.rawAskPrice) +
        "  drift from touch: bid " +
        (report.bidDrift === null ? "n/a" : fmt(report.bidDrift, 1) + "%") +
        ", ask " +
        (report.askDrift === null ? "n/a" : fmt(report.askDrift, 1) + "%")
    );
    if (report.drift !== null) {
      out.push(
        "  Screen vs traded: touch " +
          fmt(report.bestAsk !== null ? report.bestAsk : report.bestBid) +
          " against the 14-day median " +
          fmt(report.historyMedian) +
          " = " +
          report.drift.toFixed(2) +
          "x"
      );
    }
    if (report.askConc) {
      out.push(
        "  Ask liquidity within " +
          (TOUCH_BAND * 100).toFixed(0) +
          "% of the touch: " +
          fmtVol(report.askConc.volume) +
          " across " +
          report.askConc.levels +
          " levels / " +
          report.askConc.rooms +
          " rooms; largest room " +
          (report.askConc.roomShare * 100).toFixed(0) +
          "%, largest level " +
          (report.askConc.levelShare * 100).toFixed(0) +
          "%"
      );
    }
    if (report.bidConc) {
      out.push(
        "  Bid liquidity within " +
          (TOUCH_BAND * 100).toFixed(0) +
          "% of the touch: " +
          fmtVol(report.bidConc.volume) +
          " across " +
          report.bidConc.levels +
          " levels / " +
          report.bidConc.rooms +
          " rooms; largest room " +
          (report.bidConc.roomShare * 100).toFixed(0) +
          "%, largest level " +
          (report.bidConc.levelShare * 100).toFixed(0) +
          "%"
      );
    }
    out.push("  Last " + HISTORY_DAYS + " days");
    if (!report.days.length) {
      out.push("    no trade history");
    } else {
      out.push(
        "    " +
          pad("Date", 12, true) +
          pad("Avg", 12) +
          pad("Stddev", 12) +
          pad("Sd/Avg", 9) +
          pad("Volume", 10) +
          pad("Trades", 9)
      );
      for (var i = 0; i < report.days.length; i++) {
        var day = report.days[i];
        var cv = day.avgPrice > 0 && typeof day.stddevPrice === "number" ? day.stddevPrice / day.avgPrice : null;
        out.push(
          "    " +
            pad(day.date || "?", 12, true) +
            pad(fmt(day.avgPrice), 12) +
            pad(fmt(day.stddevPrice), 12) +
            pad(cv === null ? "n/a" : (cv * 100).toFixed(0) + "%", 9) +
            pad(fmtVol(day.volume), 10) +
            pad(fmtVol(day.transactions), 9)
        );
      }
    }
    var band = report.band;
    if (band && band.sources && band.sources.length) {
      var parts = [];
      for (var s = 0; s < band.sources.length; s++) {
        parts.push(band.sources[s].source + " " + fmt(band.sources[s].reference));
      }
      out.push(
        "  Independent references: " +
          parts.join(" | ") +
          (report.disagree === null ? "" : "  -> disagree " + report.disagree.toFixed(2) + "x")
      );
      out.push("  Buy ceiling: " + fmt(band.ceiling) + " (" + band.source + ")");
    } else {
      out.push("  Independent references: none qualified -- automated buys are refused");
    }
    if (profile.theoreticalPrice !== null) {
      out.push("  Theoretical: " + fmt(profile.theoreticalPrice) + " (cost " + fmt(profile.theoreticalCost) + ")");
    }
    return out;
  }

  global.marketChaos = function (count, depth) {
    if (!Game.market || typeof Game.market.getAllOrders !== "function") {
      return "[MarketChaos] Market is unavailable.";
    }
    var explicit = null;
    if (Array.isArray(count)) {
      explicit = count;
    } else if (typeof count === "string") {
      explicit = [ count ];
    }
    var wanted = explicit ? explicit.length : typeof count === "number" ? Math.floor(count) : DEFAULT_SAMPLE;
    if (!explicit && (!(wanted > 0) || wanted > MAX_SAMPLE)) {
      return "Usage: marketChaos(count[, depth]) where count is 1-" + MAX_SAMPLE + ", or marketChaos([resources]).";
    }
    var levels = typeof depth === "number" && depth > 0 ? Math.min(Math.floor(depth), MAX_DEPTH) : DEFAULT_DEPTH;
    var pool = candidatePool();
    if (!pool.length) return "[MarketChaos] No market resources are visible this tick.";
    var chosen = explicit || sample(pool, wanted);
    var reports = [];
    for (var i = 0; i < chosen.length; i++) {
      reports.push(collect(chosen[i], levels));
    }
    var ranked = reports.slice().sort(function (a, b) {
      if (a.score === null && b.score === null) return a.resource < b.resource ? -1 : 1;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    });
    var out = [
      "=== Market chaos: " +
        reports.length +
        (explicit ? " requested" : " of " + pool.length + " sampled at random") +
        ", top " +
        levels +
        " levels per side, tick " +
        Game.time +
        " ===",
      "Score = spread(" + W_SPREAD + ") + touch vs 14d median(" + W_DRIFT + ") + reference disagreement(" + W_DISAGREE + ") + room concentration(" + W_ROOM + ") + level concentration(" + W_LEVEL + ") + daily dispersion(" + W_DISPERSION + "), scaled to the dimensions actually measurable. Higher is less trustworthy; \"dead\" is no book at all.",
      "",
      "  " + pad("Resource", 22, true) + pad("Chaos", 7) + pad("Spread%", 10) + pad("vs Hist", 10) + pad("Disagree", 10) + pad("Room%", 8) + pad("Level%", 8) + pad("Sd/Avg", 9) + "  state",
    ];
    for (var r = 0; r < ranked.length; r++) {
      var report = ranked[r];
      out.push(
        "  " +
          pad(report.resource, 22, true) +
          pad(fmtScore(report.score), 7) +
          pad(report.spreadPct === null ? "n/a" : fmt(report.spreadPct, 1), 10) +
          pad(report.drift === null ? "n/a" : report.drift.toFixed(2) + "x", 10) +
          pad(report.disagree === null ? "n/a" : report.disagree.toFixed(2) + "x", 10) +
          pad(report.askConc ? (report.askConc.roomShare * 100).toFixed(0) : "n/a", 8) +
          pad(report.askConc ? (report.askConc.levelShare * 100).toFixed(0) : "n/a", 8) +
          pad(report.dispersion === null ? "n/a" : (report.dispersion * 100).toFixed(0) + "%", 9) +
          "  " +
          report.profile.state
      );
    }
    for (var d = 0; d < ranked.length; d++) {
      out = out.concat(detail(ranked[d]));
    }
    out.push("");
    out.push("Flags: * our own order, . below the " + pricing.MIN_ORDER_REMAINING + "-unit dust filter the pricing book drops.");
    return out.join("\n");
  };
})();
