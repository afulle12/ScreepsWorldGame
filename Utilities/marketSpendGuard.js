// LLM: Read docs/codex.js before reviewing or changing this file.
// marketSpendGuard.js
// Console globals: buyCeiling, marketGuardStatus
// Example: buyCeiling(RESOURCE_ENERGY) - Show the corroborated price ceiling and its evidence
// Example: marketGuardStatus() - List recent blocked buys and the ceilings that stopped them

// Last-line spend guard at the Game.market API boundary. Every credit we can
// spend leaves through createOrder(BUY) or deal() against a SELL order, so the
// two are wrapped once per tick and checked against marketPricing's
// corroborated buy ceiling (14-day trade history, ask depth median, bid depth
// median -- whichever binds tightest). Module-level policy still lives in
// marketBuy; this exists so a module that never learned about the ceiling --
// or one added later -- cannot pay 1000x for a resource because one order at
// the top of an emptied book said so.
var pricing = require("marketPricing");
var memoryManager = require("memoryManager");

var BLOCK_LOG_MAX = 10;

function mem() {
  if (!Memory.marketGuard || typeof Memory.marketGuard !== "object") {
    Memory.marketGuard = {
      blocked: [],
      blockedCount: 0
    };
  }
  if (!Array.isArray(Memory.marketGuard.blocked)) Memory.marketGuard.blocked = [];
  if (typeof Memory.marketGuard.blockedCount !== "number") Memory.marketGuard.blockedCount = 0;
  return Memory.marketGuard;
}

function recordBlock(resource, price, ceiling, source, reference, via) {
  var m = mem();
  m.blockedCount++;
  m.blocked.push({
    r: resource,
    p: Math.round(price * 1e3) / 1e3,
    c: Math.round(ceiling * 1e3) / 1e3,
    s: source,
    v: via,
    t: Game.time
  });
  while (m.blocked.length > BLOCK_LOG_MAX) m.blocked.shift();
  memoryManager.requestSave();
  console.log("[MarketGuard] BLOCKED " + via + " of " + resource + " at " + price.toFixed(3) + " -- ceiling " + ceiling.toFixed(3) + " (" + source + " reference " + reference.toFixed(3) + "). Nothing was bought.");
}

// Local lookup first: the shared order snapshot already holds every public
// order this tick, so the common path costs no extra API call.
function findOrder(orderId) {
  try {
    var snapshot = require("util").marketSnapshot();
    if (snapshot && Array.isArray(snapshot.all)) {
      if (!snapshot.byId || snapshot.byIdTick !== snapshot.tick) {
        var byId = {};
        for (var i = 0; i < snapshot.all.length; i++) {
          if (snapshot.all[i] && snapshot.all[i].id) byId[snapshot.all[i].id] = snapshot.all[i];
        }
        snapshot.byId = byId;
        snapshot.byIdTick = snapshot.tick;
      }
      if (snapshot.byId[orderId]) return snapshot.byId[orderId];
    }
  } catch (e) {}
  try {
    return Game.market.getOrderById(orderId);
  } catch (e) {
    return null;
  }
}

// Returns the ceiling when the price breaches it, otherwise null.
function breach(resource, price) {
  if (typeof price !== "number" || !(price > 0)) return null;
  var band;
  try {
    band = pricing.buyPriceCeiling(resource);
  } catch (e) {
    // A guard that throws would break every trade. Fail open here; marketBuy
    // still applies the ceiling as policy on the paths it owns.
    console.log("[MarketGuard] Ceiling lookup failed for " + resource + ": " + (e.message || e));
    return null;
  }
  if (!band || !(band.ceiling > 0)) return null; // no evidence: policy call, not a hard stop
  return price > band.ceiling ? band : null;
}

function install() {
  var market = Game.market;
  if (!market || market._spendGuardWrapped) return;
  var deal = market.deal;
  market.deal = function(orderId, amount, yourRoomName) {
    var order = findOrder(orderId);
    // Dealing against a SELL order means we are the buyer paying its price.
    if (order && order.type === ORDER_SELL) {
      var band = breach(order.resourceType, order.price);
      if (band) {
        recordBlock(order.resourceType, order.price, band.ceiling, band.source, band.reference, "deal");
        return ERR_INVALID_ARGS;
      }
    }
    return deal.apply(market, arguments);
  };
  var createOrder = market.createOrder;
  market.createOrder = function(params) {
    if (params && typeof params === "object" && params.type === ORDER_BUY) {
      var band = breach(params.resourceType, params.price);
      if (band) {
        recordBlock(params.resourceType, params.price, band.ceiling, band.source, band.reference, "createOrder");
        return ERR_INVALID_ARGS;
      }
    }
    return createOrder.apply(market, arguments);
  };
  market._spendGuardWrapped = true;
}

global.buyCeiling = function(resource) {
  var res = resource || RESOURCE_ENERGY;
  var band = pricing.buyPriceCeiling(res);
  var out = [ "=== Buy ceiling: " + res + " ===" ];
  if (!band || !band.sources.length) {
    out.push("  no corroborated evidence -- automated buys are refused for this resource");
    return out.join("\n");
  }
  for (var i = 0; i < band.sources.length; i++) {
    var s = band.sources[i];
    out.push("  " + (s.source === band.source ? "* " : "  ") + s.source + ": reference " + s.reference.toFixed(4) + " -> ceiling " + s.ceiling.toFixed(4));
  }
  out.push("  binding ceiling: " + band.ceiling.toFixed(4) + " (" + band.source + ")");
  var passive = pricing.passiveBuyPrice(res);
  out.push("  passive buy price now: " + (passive > 0 ? passive.toFixed(4) : "none"));
  return out.join("\n");
};

global.marketGuardStatus = function() {
  var m = mem();
  var out = [ "=== Market spend guard ===", "  blocked since reset: " + m.blockedCount ];
  if (m.blocked.length === 0) {
    out.push("  no recent blocks");
    return out.join("\n");
  }
  for (var i = 0; i < m.blocked.length; i++) {
    var b = m.blocked[i];
    out.push("  " + b.r + " " + b.v + " @ " + b.p + " vs ceiling " + b.c + " (" + b.s + ") tick " + b.t);
  }
  return out.join("\n");
};

module.exports = {
  install: install,
  findOrder: findOrder
};
