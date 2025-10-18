// marketQuery.js
// Provides a global console command to query Screeps market prices.
// - Default: 48-hour weighted average (approx.) using Game.market.getHistory
// - 'buy'  : Top 5 buy orders (highest price first)
// - 'sell' : Top 5 sell orders (lowest price first)
//
// Usage (in console):
//   marketPrice('energy')                // 48h avg (approx.)
//   marketPrice('RESOURCE_ENERGY')       // 48h avg (approx.)
//   marketPrice('UO', 'sell')            // Top 5 sells for UO
//   marketPrice('keanium', 'buy')        // Top 5 buys for keanium
//
// Notes:
// - The 48h average is approximated using the last two daily history entries,
//   weighted by volume, because Screeps history is daily granularity.
// - Orders listing shows: rank, price, remainingAmount, roomName, orderId.
// - Accepts either resource strings (e.g. 'energy', 'UO') or constant names
//   as strings (e.g. 'RESOURCE_ENERGY'). If you already pass the constant
//   value (e.g. RESOURCE_ENERGY), that works too.

(function registerMarketPriceGlobal() {
  function resolveResource(input) {
    // If the user passed the actual constant value (e.g. RESOURCE_ENERGY -> 'energy'), accept it.
    if (typeof input === 'string' && typeof RESOURCES_ALL !== 'undefined') {
      // If input is already a valid resource value (e.g. 'energy', 'UO'), accept it.
      if (RESOURCES_ALL.indexOf(input) !== -1) return input;

      // If input looks like a constant name (e.g. 'RESOURCE_ENERGY'), try to resolve through global.
      // In Screeps, constants are on the global object; this turns name -> value.
      var maybeConst = global[input];
      if (typeof maybeConst === 'string' && RESOURCES_ALL.indexOf(maybeConst) !== -1) {
        return maybeConst;
      }

      // Try lowercase normalization (e.g. 'Energy' -> 'energy')
      var lower = input.toLowerCase();
      if (RESOURCES_ALL.indexOf(lower) !== -1) return lower;

      // Common aliases
      if (lower === 'keanium') return RESOURCE_KEANIUM;
      if (lower === 'utrium') return RESOURCE_UTRIUM;
      if (lower === 'lemergium') return RESOURCE_LEMERGIUM;
      if (lower === 'zynthium') return RESOURCE_ZYNTHIUM;
      if (lower === 'oxygen') return RESOURCE_OXYGEN;
      if (lower === 'hydrogen') return RESOURCE_HYDROGEN;
      if (lower === 'catalyst') return RESOURCE_CATALYST;
      if (lower === 'power') return RESOURCE_POWER;

      // If not resolvable, return as-is and let API fail naturally.
      return input;
    }
    // If not a string (e.g. user typed RESOURCE_ENERGY without quotes), use it directly.
    return input;
  }

  function formatPrice(n) {
    return typeof n === 'number' ? n.toFixed(3) : String(n);
  }

  function formatOrderLine(order, rank) {
    var id = order.id;
    var price = formatPrice(order.price);
    var rem = order.remainingAmount || order.amount || 0;
    var room = order.roomName || 'N/A';
    return '#' + rank + ' ' + price + ' | amt=' + rem + ' | room=' + room + ' | ' + id;
  }

  function getAvg48hString(resource) {
    // Game.market.getHistory(resource) returns daily entries for ~last 14 days:
    // { resourceType, date, transactions, volume, avgPrice, stddevPrice }
    var hist = Game.market.getHistory(resource) || [];
    if (!hist || hist.length === 0) {
      return '[Market] No history for ' + resource;
    }

    // Take last two days (approx. 48h window).
    var last = hist[hist.length - 1];
    var prev = hist.length >= 2 ? hist[hist.length - 2] : null;

    var sumPV = 0;
    var sumV = 0;

    if (last && typeof last.avgPrice === 'number' && typeof last.volume === 'number') {
      sumPV += last.avgPrice * last.volume;
      sumV += last.volume;
    }
    if (prev && typeof prev.avgPrice === 'number' && typeof prev.volume === 'number') {
      sumPV += prev.avgPrice * prev.volume;
      sumV += prev.volume;
    }

    if (sumV <= 0) {
      // Fallback to last day avg if no volume or incomplete data
      if (last && typeof last.avgPrice === 'number') {
        return '[Market] ' + resource + ' 48h avg (approx): ' + formatPrice(last.avgPrice) +
               ' (volume: ' + (last.volume || 0) + ', days=1)';
      }
      return '[Market] No usable history for ' + resource;
    }

    var avg = sumPV / sumV;
    return '[Market] ' + resource + ' 48h avg (approx): ' + formatPrice(avg) +
           ' (volume: ' + sumV + ', days=' + (prev ? 2 : 1) + ')';
  }

  function getTopOrdersString(resource, mode) {
    var type = mode === 'buy' ? ORDER_BUY : ORDER_SELL;
    var all = Game.market.getAllOrders({ resourceType: resource, type: type }) || [];
    // Keep only orders with remaining amount
    var valid = [];
    for (var i = 0; i < all.length; i++) {
      var o = all[i];
      var rem = o.remainingAmount || o.amount || 0;
      if (rem > 0) valid.push(o);
    }

    // Sort by price
    valid.sort(function(a, b) {
      if (mode === 'buy') return b.price - a.price; // highest first
      return a.price - b.price; // lowest first
    });

    if (valid.length === 0) {
      return '[Market] No ' + mode + ' orders found for ' + resource;
    }

    var top = valid.slice(0, 5);
    var lines = [];
    lines.push('[Market] ' + resource + ' | top ' + (mode === 'buy' ? 'buy' : 'sell') + ' orders:');
    for (var j = 0; j < top.length; j++) {
      lines.push('  ' + formatOrderLine(top[j], j + 1));
    }
    return lines.join('\n');
  }

  global.marketPrice = function(resourceInput, queryType) {
    if (!resourceInput) {
      return "Usage: marketPrice('resource', mode)\n" +
             " - mode omitted or 'avg'  -> 48h avg price (approx.)\n" +
             " - mode 'buy'             -> top 5 buy orders (highest first)\n" +
             " - mode 'sell'            -> top 5 sell orders (lowest first)\n" +
             "Examples:\n" +
             "  marketPrice('energy')\n" +
             "  marketPrice('RESOURCE_ENERGY')\n" +
             "  marketPrice('UO', 'sell')\n" +
             "  marketPrice('keanium', 'buy')";
    }

    var resource = resolveResource(resourceInput);
    var mode = (queryType || 'avg') + '';
    mode = mode.toLowerCase();

    if (mode === 'avg' || mode === 'average' || mode === 'mean') {
      return getAvg48hString(resource);
    } else if (mode === 'buy') {
      return getTopOrdersString(resource, 'buy');
    } else if (mode === 'sell') {
      return getTopOrdersString(resource, 'sell');
    } else {
      return "[Market] Unknown mode '" + mode + "'. Use 'avg', 'buy', or 'sell'.";
    }
  };
})();
