// LLM: Read docs/codex.js before reviewing or changing this file.
// marketReport.js
// Console globals: marketPrices, reverseReactionValue, transactionSummary
// Example: marketPrices() - Generate summary of top traded resources and price trends
// Example: reverseReactionValue('XGH2O') - Calculate net value of breaking down compound
// Example: transactionSummary(100) - Print summary of recent market transactions
/**
 * =============================================================================
 * MODULE: Market Report Generator with Reverse Reaction Calculator
 * =============================================================================
 *
 * COMMANDS:
 *
 *   transactionSummary(days)
 *     Generate a market report for the last N days.
 *     Example: transactionSummary(1)
 *     Example: transactionSummary(7)
 *
 *   reverseReactionValue([resourceType])
 *     Calculate profit/loss from breaking down compounds and selling reagents.
 *     Example: reverseReactionValue()        // All compounds
 *     Example: reverseReactionValue('XGH2O') // Specific compound
 *
 *   marketPrices([resourceType])
 *     Show canonical market, immediate sell, and immediate buy prices.
 *     Dead commodities show recipe-derived theoretical values when available.
 *     Example: marketPrices()          // All known resources/commodities
 *     Example: marketPrices('energy')  // Specific resource
 *
 * =============================================================================
 */
var util = require("util");
var pricing = require("marketPricing");
var TICKS_PER_DAY = 28800;
var MAX_SAFE_INT = 9007199254740991;
function getBestSellPrice(e) {
  var r = pricing.getPriceProfile(e);
  return r && typeof r.sellPrice === "number" ? r.sellPrice : null;
}

function findReagents(e) {
  for (var r in REACTIONS) {
    var t = REACTIONS[r];
    for (var i in t) {
      if (t[i] === e) {
        return {
          a: r,
          b: i
        };
      }
    }
  }
  return null;
}

function getAllCompounds() {
  var e = new Set;
  for (var r in REACTIONS) {
    var t = REACTIONS[r];
    for (var i in t) {
      e.add(t[i]);
    }
  }
  return Array.from(e);
}

function toSafeInt(e) {
  var r = Math.floor(e);
  if (r > MAX_SAFE_INT) return MAX_SAFE_INT;
  if (r < -MAX_SAFE_INT) return -MAX_SAFE_INT;
  return r;
}

global.reverseReactionValue = function(e) {
  var r = e ? [ e ] : getAllCompounds();
  var t = [];
  for (var i = 0; i < r.length; i++) {
    var a = r[i];
    var n = findReagents(a);
    if (!n) {
      if (e) {
        return "Error: " + a + " is not a compound (cannot be broken down)";
      }
      continue;
    }
    var o = pricing.getPriceProfile(a);
    var c = pricing.getPriceProfile(n.a);
    var l = pricing.getPriceProfile(n.b);
    var u = o.buyPrice !== null ? o.buyPrice : o.marketPriceSource === "THEORETICAL" ? o.marketPrice : null;
    var s = c.sellPrice !== null ? c.sellPrice : c.marketPriceSource === "THEORETICAL" ? c.marketPrice : null;
    var d = l.sellPrice !== null ? l.sellPrice : l.marketPriceSource === "THEORETICAL" ? l.marketPrice : null;
    if (u === null || s === null || d === null) continue;
    var f = u;
    var h = s;
    var v = d;
    var m = h + v;
    var p = f;
    var P = m - p;
    var g = p > 0 ? P / p * 100 : 0;
    t.push({
      compound: a,
      reagentA: n.a,
      reagentB: n.b,
      buyPrice: f,
      sellAPrice: h,
      sellBPrice: v,
      revenue: m,
      profit: P,
      profitPercent: g,
      usingTheoreticalCompound: o.marketPriceSource === "THEORETICAL",
      usingTheoreticalA: c.marketPriceSource === "THEORETICAL",
      usingTheoreticalB: l.marketPriceSource === "THEORETICAL"
    });
  }
  t.sort(function(e, r) {
    return r.profit - e.profit;
  });
  var T = [];
  T.push("=== Reverse Reaction Profitability ===");
  T.push("Buy compound -> Break down -> Sell reagents");
  T.push("(* = using a recipe-derived theoretical value; no reliable live side)");
  T.push("");
  if (t.length === 0) {
    T.push("No price data available for compounds.");
    return T.join("\n");
  }
  var A = t.filter(function(e) {
    return e.profit > 0;
  });
  var b = t.filter(function(e) {
    return e.profit <= 0;
  });
  if (A.length > 0) {
    T.push("--- PROFITABLE BREAKDOWNS ---");
    for (var y = 0; y < A.length; y++) {
      var S = A[y];
      var F = "";
      if (S.usingTheoreticalCompound) F += "*";
      T.push(S.compound + F + " (" + S.buyPrice.toFixed(2) + ") -> " + S.reagentA + (S.usingTheoreticalA ? "*" : "") + " (" + S.sellAPrice.toFixed(2) + ") + " + S.reagentB + (S.usingTheoreticalB ? "*" : "") + " (" + S.sellBPrice.toFixed(2) + ") = " + "+" + S.profit.toFixed(2) + " (" + S.profitPercent.toFixed(1) + "%)");
    }
    T.push("");
  }
  if (!e && b.length > 0) {
    T.push("--- UNPROFITABLE (top 10) ---");
    for (var I = 0; I < Math.min(10, b.length); I++) {
      var S = b[I];
      var F = "";
      if (S.usingTheoreticalCompound) F += "*";
      T.push(S.compound + F + " (" + S.buyPrice.toFixed(2) + ") -> " + S.reagentA + (S.usingTheoreticalA ? "*" : "") + " (" + S.sellAPrice.toFixed(2) + ") + " + S.reagentB + (S.usingTheoreticalB ? "*" : "") + " (" + S.sellBPrice.toFixed(2) + ") = " + S.profit.toFixed(2) + " (" + S.profitPercent.toFixed(1) + "%)");
    }
  } else if (e && b.length > 0) {
    var S = b[0];
    T.push("--- NOT PROFITABLE ---");
    T.push(S.compound + " (" + S.buyPrice.toFixed(2) + ") -> " + S.reagentA + " (" + S.sellAPrice.toFixed(2) + ") + " + S.reagentB + " (" + S.sellBPrice.toFixed(2) + ") = " + S.profit.toFixed(2) + " (" + S.profitPercent.toFixed(1) + "%)");
  }
  return T.join("\n");
};
global.marketPrices = function(e) {
  function formatProfile(e) {
    var r = pricing.getPriceProfile(e);
    var t = [];
    t.push("=== " + e + " Prices ===");
    t.push("Market price: " + (r.marketPrice !== null ? r.marketPrice.toFixed(3) : "N/A") + " [" + r.marketPriceSource + ", " + r.confidence + "]");
    t.push("Sell now: " + (r.sellPrice !== null ? r.sellPrice.toFixed(3) : "N/A") + " [" + r.sellLiquidity + "]");
    t.push("Buy now: " + (r.buyPrice !== null ? r.buyPrice.toFixed(3) : "N/A") + " [" + r.buyLiquidity + "]");
    t.push("State: " + r.state);
    t.push("Passive sell: " + (r.postedSellPrice !== null ? r.postedSellPrice.toFixed(3) : "N/A"));
    t.push("Passive buy: " + (r.postedBuyPrice !== null ? r.postedBuyPrice.toFixed(3) : "N/A"));
    if (r.historyPrice !== null) {
      t.push("48h history: " + r.historyPrice.toFixed(3) + (r.historyIgnoredReason ? " [" + r.historyIgnoredReason + "]" : ""));
    }
    if (r.theoreticalPrice !== null) {
      t.push("Theoretical: " + r.theoreticalPrice.toFixed(3) + " (cost " + r.theoreticalCost.toFixed(3) + ")");
    }
    return t.join("\n");
  }
  if (e) return formatProfile(e);
  var r = {};
  var t = util.marketSnapshot().all;
  for (var i = 0; i < t.length; i++) r[t[i].resourceType] = true;
  if (typeof COMMODITIES !== "undefined" && COMMODITIES) {
    for (var a in COMMODITIES) r[a] = true;
  }
  var n = [ "=== Market Prices ===" ];
  var o = Object.keys(r).sort();
  for (var c = 0; c < o.length; c++) {
    var l = pricing.getPriceProfile(o[c]);
    n.push(o[c] + ": market@" + (l.marketPrice !== null ? l.marketPrice.toFixed(3) : "N/A") + " / sell@" + (l.sellPrice !== null ? l.sellPrice.toFixed(3) : "N/A") + " / buy@" + (l.buyPrice !== null ? l.buyPrice.toFixed(3) : "N/A") + " [" + l.state + "/" + l.marketPriceSource + "]");
  }
  return n.join("\n");
};
global.transactionSummary = function(e) {
  if (e === undefined) e = 1;
  if (typeof e !== "number") {
    return "Error: input days as integer.";
  }
  var r = e * TICKS_PER_DAY;
  var t = Game.time - r;
  var i = {};
  var a = {};
  var n = {};
  var o = {};
  var c = 0;
  var l = 0;
  var u = {};
  var s = Game.market.incomingTransactions;
  var d = Game.market.outgoingTransactions;
  var f = Game.time;
  var h = false;
  var v = 0;
  if (s.length > 0) {
    var m = s[s.length - 1];
    if (m.time > t) {
      h = true;
      if (m.time < f) f = m.time;
    }
    for (var p = 0; p < s.length; p++) {
      var P = s[p];
      if (P.time < t) continue;
      v++;
      var g = Game.time - P.time;
      var T = Math.floor(g / TICKS_PER_DAY);
      if (u[T] === undefined) {
        u[T] = 0;
      }
      u[T]++;
      var A = 0;
      if (P.order && typeof P.order.price === "number") {
        A = P.order.price;
      }
      var b = P.amount * A;
      c = c + b;
      var y = P.resourceType;
      if (i[y] === undefined) {
        i[y] = {
          count: 0,
          credits: 0,
          transactions: 0,
          avgPrice: 0
        };
      }
      i[y].count = i[y].count + P.amount;
      i[y].credits = i[y].credits + b;
      i[y].transactions = i[y].transactions + 1;
      var S = "Unknown";
      if (P.sender && P.sender.username) {
        S = P.sender.username;
      }
      if (n[S] === undefined) n[S] = 0;
      n[S] = n[S] + b;
    }
  }
  for (var F in i) {
    if (i[F].count > 0) {
      i[F].avgPrice = i[F].credits / i[F].count;
    }
  }
  if (d.length > 0) {
    var I = d[d.length - 1];
    if (I.time > t) {
      h = true;
      if (I.time < f) f = I.time;
    }
    for (var k = 0; k < d.length; k++) {
      var P = d[k];
      if (P.time < t) continue;
      v++;
      var g = Game.time - P.time;
      var T = Math.floor(g / TICKS_PER_DAY);
      if (u[T] === undefined) {
        u[T] = 0;
      }
      u[T]++;
      var A = 0;
      if (P.order && typeof P.order.price === "number") {
        A = P.order.price;
      }
      var x = P.amount * A;
      l = l + x;
      var y = P.resourceType;
      if (a[y] === undefined) {
        a[y] = {
          count: 0,
          credits: 0,
          transactions: 0,
          avgPrice: 0
        };
      }
      a[y].count = a[y].count + P.amount;
      a[y].credits = a[y].credits + x;
      a[y].transactions = a[y].transactions + 1;
      var E = "Unknown";
      if (P.recipient && P.recipient.username) {
        E = P.recipient.username;
      }
      if (o[E] === undefined) o[E] = 0;
      o[E] = o[E] + x;
    }
  }
  for (var R in a) {
    if (a[R].count > 0) {
      a[R].avgPrice = a[R].credits / a[R].count;
    }
  }
  var C = Game.time - TICKS_PER_DAY;
  var N = 0;
  for (var B = 0; B < s.length; B++) {
    if (s[B].time >= C) N++;
  }
  for (var O = 0; O < d.length; O++) {
    if (d[O].time >= C) N++;
  }
  Memory.marketStats = {
    transactions24h: toSafeInt(N),
    recordedAtTick: toSafeInt(Game.time)
  };
  var _ = "<h1>Market Report (" + e + " Days)</h1>";
  if (h) {
    var M = (Game.time - f) / TICKS_PER_DAY;
    _ += "<p><strong>WARNING: Limited Data.</strong><br>";
    _ += "Server history limit reached. Report covers last " + M.toFixed(2) + " days.</p>";
  }
  var w = c - l;
  _ += "<p>";
  _ += "Total Income: " + c.toFixed(0) + "<br>";
  _ += "Total Expense: " + l.toFixed(0) + "<br>";
  _ += "<strong>Net Profit: " + w.toFixed(0) + "</strong><br>";
  _ += "Total Transactions: " + toSafeInt(v) + "<br>";
  _ += "Transactions (last 24h): " + toSafeInt(N);
  _ += "</p>";
  _ += "<h3>Transactions Per 24h Period</h3>";
  _ += '<table border="1" cellspacing="0" cellpadding="4">';
  _ += "<tr><th>Period</th><th>Transactions</th></tr>";
  var D = Object.keys(u).map(Number).sort(function(e, r) {
    return e - r;
  });
  for (var L = 0; L < D.length; L++) {
    var G = D[L];
    var K = G === 0 ? "Today (last 24h)" : G + " day" + (G > 1 ? "s" : "") + " ago";
    _ += "<tr><td>" + K + "</td><td>" + toSafeInt(u[G]) + "</td></tr>";
  }
  _ += "</table>";
  function makeRow(e, r, t, i, a) {
    var n = "<tr>";
    n += "<td>" + e + "</td>";
    n += "<td>" + r + "</td>";
    if (t !== undefined) n += "<td>" + t + "</td>";
    if (i !== undefined) n += "<td>" + i + "</td>";
    if (a !== undefined) n += "<td>" + a + "</td>";
    n += "</tr>";
    return n;
  }
  _ += "<h3>Income (Sold)</h3>";
  _ += '<table border="1" cellspacing="0" cellpadding="4">';
  _ += "<tr><th>Resource</th><th>Amount</th><th>Credits</th><th>Avg Price</th><th>Trans</th></tr>";
  for (var F in i) {
    var L = i[F];
    _ += makeRow(F, L.count, L.credits.toFixed(0), L.avgPrice.toFixed(2), L.transactions);
  }
  _ += "</table>";
  _ += "<h3>Expenses (Bought)</h3>";
  _ += '<table border="1" cellspacing="0" cellpadding="4">';
  _ += "<tr><th>Resource</th><th>Amount</th><th>Credits</th><th>Avg Price</th><th>Trans</th></tr>";
  for (var R in a) {
    var L = a[R];
    _ += makeRow(R, L.count, L.credits.toFixed(0), L.avgPrice.toFixed(2), L.transactions);
  }
  _ += "</table>";
  var j = [];
  for (var H in n) {
    j.push({
      name: H,
      total: n[H]
    });
  }
  j.sort(function(e, r) {
    return r.total - e.total;
  });
  _ += "<h3>Top Buyers (bought from you)</h3>";
  _ += '<table border="1" cellspacing="0" cellpadding="4">';
  _ += "<tr><th>Player</th><th>Spent</th></tr>";
  for (var Y = 0; Y < 10; Y++) {
    if (Y >= j.length) break;
    _ += makeRow(j[Y].name, j[Y].total.toFixed(0));
  }
  _ += "</table>";
  var X = [];
  for (var q in o) {
    X.push({
      name: q,
      total: o[q]
    });
  }
  X.sort(function(e, r) {
    return r.total - e.total;
  });
  _ += "<h3>Top Sellers (you bought from)</h3>";
  _ += '<table border="1" cellspacing="0" cellpadding="4">';
  _ += "<tr><th>Player</th><th>Earned</th></tr>";
  for (var U = 0; U < 10; U++) {
    if (U >= X.length) break;
    _ += makeRow(X[U].name, X[U].total.toFixed(0));
  }
  _ += "</table>";
  _ += "<p><em>24h transaction count saved to Memory.marketStats.transactions24h (wiped each run)</em></p>";
  Game.notify(_);
  return "Report sent. Check email. 24h transactions: " + toSafeInt(N);
};
module.exports = {};
