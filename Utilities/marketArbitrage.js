/**
 * Market Arbitrage Module
 *
 * Scans for profitable buy-sell spreads: buys resources cheaply from sell orders,
 * waits for terminal cooldown, then immediately sells to open buy orders at a profit.
 *
 * Self-arbitrage on OWN sell orders:
 * - Scans Game.market.orders for our active sell orders.
 * - If a buy order exists at a price above our asking price, and the spread
 *   covers energy costs, we deal() on the buy order directly from that terminal.
 * - This is better than waiting for natural fills when buyPrice - sellPrice > energyCost,
 *   because natural fills cost us nothing (buyer pays energy), but the buy order
 *   might disappear before anyone fills our sell order.
 * - After a verified sale, cancels the (now unfunded) sell order.
 * - Energy IS counted: profit = (buyPrice - ourSellPrice) * amount - energyCost * energyPrice.
 * - Uses MIN_SELF_ARB_PROFIT as a minimum credit threshold to avoid dust trades.
 *
 * Self-fulfill integration with opportunisticBuy:
 * - If an opportunisticBuy request exists for a resource we're about to sell,
 *   compares the value of self-fulfilling (terminal.send) vs external sale.
 * - Self-fulfill value = maxPrice * amount (credits saved) - send energy cost.
 * - Only self-fulfills if purchase price <= oppBuy maxPrice.
 * - Picks whichever option yields more value (with SELF_FULFILL_ADVANTAGE bias).
 * - Updates the opportunisticBuy request progress when self-fulfilling.
 *
 * Self-fulfill advantage (SELF_FULFILL_ADVANTAGE):
 * - When an opportunisticBuy request exists for a resource, arbitrage will only
 *   prefer selling externally if the buy order price exceeds our maxPrice by
 *   this factor (default 1.25 = 25%). Otherwise we buy it for ourselves.
 * - Applied both at opportunity scanning (skips arb if external isn't worth it)
 *   and at sell-time value comparison (biases toward self-fulfill).
 * - Example: oppBuy maxPrice=100, sell@90, external buy@110.
 *   Required external: 100*1.25=125. Since 110<125, we self-fulfill instead of arb.
 *
 * Floor sweep (FLOOR_SWEEP_PRICE):
 * - If any non-energy commodity is listed at or below FLOOR_SWEEP_PRICE (default 1 cr),
 *   it is purchased unconditionally even if no buy order currently exists for it.
 * - The purchase enters the normal state machine (pending_buy_verify -> pending_sell)
 *   and, if still no buyer is found, flows into the buffer where it waits and sells
 *   opportunistically -- identical to any other buffered entry.
 * - Only fires when a terminal has no regular arb opportunity, so it never
 *   displaces profitable trades.
 * - Full cost basis (purchase price + buy-leg energy cost) is computed upfront.
 *   If no buy order exists at or above that basis, the historical average cap
 *   (150%) must exceed it -- otherwise the sweep is skipped entirely since there
 *   is no realistic exit. At ~28 cr/energy, energy can easily dwarf the nominal
 *   purchase price for cheap commodities transacted across distant rooms.
 * - Respects all standard guards: exposure cap, buffered-resource skip,
 *   ghost-order blacklist, single-terminal restriction, energy availability.
 * - Use setFloorSweepPrice(0) to disable.
 *
 * Cost basis tracking (costBasis field):
 * - Every op and buffer entry stores costBasis = sellPrice + buyLegEnergy*energyPrice/amount.
 * - The buffer profitability check uses costBasis (not just sellPrice) as the floor,
 *   ensuring the sell-leg price covers both the original purchase AND the energy
 *   spent receiving the goods.
 * - The || sellPrice fallback handles legacy Memory entries without costBasis.
 *
 * Account-level resource arbitrage (pixel, cpuUnlock, accessKey):
 * - These resources go to your account, not a terminal.
 * - No energy costs on either leg, no terminal cooldown, no capacity checks.
 * - deal() is called without a room name.
 * - State machine: pending_buy_verify -> ready_to_sell -> pending_sell_verify -> complete.
 * - Buy verification and sell can happen in the same scan tick (no cooldown).
 * - Only one account-resource operation at a time (serialized).
 * - Verified via Game.resources balance check (buy) and outgoingTransactions (sell).
 * - If the target buy order disappears, searches for replacements or holds until
 *   BUFFER_TIMEOUT, then abandons.
 *
 * Accounts for energy costs on BOTH transaction legs (receiving and sending).
 * Energy is valued using marketBuy.computeBuyPrice(RESOURCE_ENERGY).
 *
 * PWR_OPERATE_TERMINAL awareness:
 * - All energy cost calculations check for an active PWR_OPERATE_TERMINAL effect
 *   on the terminal and apply the corresponding percentage reduction.
 * - POWER_INFO[PWR_OPERATE_TERMINAL].effect stores cost multipliers [0.9..0.5],
 *   meaning 90% to 50% of base cost at levels 0-4.
 * - This prevents overestimating energy costs on powered terminals, which would
 *   otherwise cause missed opportunities and undersized trades.
 * - Active operations in 'pending_sell' state are checked every tick (not just
 *   scan ticks) so powered terminals with shorter cooldowns can execute their
 *   sell leg as soon as cooldown clears. Only terminals with cooldown === 0
 *   are processed; other states wait for the next scan tick. Order book data
 *   is cached from the last scan tick for this inter-scan processing.
 *
 * Idle terminal processing order:
 * - Idle terminals are pre-scored by estimated profit and processed highest-first.
 * - This ensures the most profitable terminal-opportunity pairings execute before
 *   less profitable ones consume limited sell/buy order capacity.
 *
 * Single-terminal resources (SINGLE_TERMINAL_RESOURCES):
 * - Resources like 'ops' are restricted to one terminal at a time to avoid
 *   multiple low-value split trades clogging terminals.
 * - These resources skip the per-terminal share splitting and are blocked from
 *   new terminals if any terminal already has that resource in-flight.
 *
 * Adaptive scan interval:
 * - Every 100 ticks, reads Memory.cpuStats.history (same data as statusReport).
 * - If average CPU < CPU_TARGET (18), decreases SCAN_INTERVAL by 1 (more frequent).
 * - If average CPU > CPU_TARGET, increases SCAN_INTERVAL by 1 (less frequent).
 * - Clamped to [MIN_SCAN_INTERVAL, MAX_SCAN_INTERVAL].
 *
 * Filters:
 * - Buy orders must have >= MIN_BUY_ORDER_AMOUNT remaining (filters scam/dust orders).
 * - Net profit must be >= MIN_PROFIT_MARGIN of total cost (credits + energy value).
 * - Only uses terminals in rooms RCL 7+.
 *
 * State machine per terminal:
 *   idle -> pending_buy_verify -> pending_sell -> pending_verify -> idle
 *        (deal on sell order;  (confirmed buy;  (deal on buy order; (confirmed sale;
 *         verify resources      wait cooldown,    verify resources    decrement and
 *         arrived via           then sell)        left via            complete or
 *         incomingTransactions)                   outgoingTransactions) continue)
 *
 * Verification:
 *   Neither terminal.store nor Game.market.credits updates within the same tick
 *   after deal(). We use incomingTransactions / outgoingTransactions on the NEXT
 *   scan to confirm deals actually executed. This prevents "ghost deals" where
 *   deal() returns OK but the order was already filled by another player.
 *
 * If the sell target disappears:
 *   pending_sell -> buffered (separate from active ops, terminal freed for new arb)
 *   buffered: checked every SCAN_INTERVAL ticks using same order books as new-opportunity scan
 *   buffered -> sold (profitable buy order found) or marketSell (after BUFFER_TIMEOUT ticks)
 *
 * Usage:
 *   marketArbitrage.run()                 -- call every tick from main loop
 *   marketArbitrage.status()              -- view active operations + buffered entries
 *   marketArbitrage.cancel(roomName)      -- abort an operation or buffered entry in a room
 *   marketArbitrage.cancelAccount()       -- abort the active account-resource operation
 *   marketArbitrage.setEnabled(false)     -- suspend all arbitrage activity
 *   marketArbitrage.setEnabled(true)      -- resume arbitrage activity
 *   marketArbitrage.setMargin(0.05)       -- change minimum profit margin
 *   marketArbitrage.setMinBuyAmount(100)  -- change min buy-order size filter
 *   marketArbitrage.setBufferTimeout(10000) -- change buffer hold duration
 *   marketArbitrage.setSelfFulfillAdvantage(1.5) -- change self-fulfill bias (1.0 = no bias)
 *   marketArbitrage.setFloorSweepPrice(0.5) -- buy anything at or below this price (0 = disabled)
 *
 * @module marketArbitrage
 */

var marketBuyer  = require('marketBuy');
var marketSeller = require('marketSell');

// === CONFIGURATION ===
var ENABLED              = true;    // Set to false to suspend all arbitrage activity
var SCAN_INTERVAL        = 6;       // Ticks between scans for opportunities (adaptive)
var MIN_SCAN_INTERVAL    = 2;       // Floor for adaptive scan interval
var MAX_SCAN_INTERVAL    = 100;     // Ceiling for adaptive scan interval
var CPU_TARGET           = 18;      // Target CPU average -- interval adjusts around this
var MIN_PROFIT_MARGIN    = 0.005;   // Minimum profit over total cost
var MIN_BUY_ORDER_AMOUNT = 6;       // Filter out likely-scam buy orders below this size
var MAX_SELLS_PER_RESOURCE = 10;    // CPU guard: only inspect top N cheapest sells per resource
var BUFFER_TIMEOUT       = 50000;   // Ticks to hold buffered resources before falling back to marketSell
var VERIFY_TIMEOUT       = 6;       // Ticks to wait for transaction confirmation (3 scan cycles)
var ACCOUNT_VERIFY_TIMEOUT = 3;     // Account resources verify faster (no terminal involved)
var MIN_AMOUNT_PER_TERMINAL = 500;  // Minimum share per terminal when splitting
var MAX_RESOURCE_EXPOSURE = 50000;  // Max total units of one resource in-flight across ALL terminals + buffered

var GHOST_SELL_COOLDOWN   = 100;    // Ticks to blacklist a sell order after a buy ghost

// Resources restricted to a single terminal at a time to avoid low-value split trades
var SINGLE_TERMINAL_RESOURCES = { ops: true };

var MIN_SELF_ARB_PROFIT   = 1;      // Minimum absolute credit profit for self-arb (filters dust)

// Self-fulfill advantage: when an opportunisticBuy request exists for a resource,
// external buy orders must exceed our maxPrice by this factor to prefer arb over self-fulfill.
// 1.25 = external must pay 25% more than our own valuation, otherwise we buy it for ourselves.
var SELF_FULFILL_ADVANTAGE = 1.25;

// Floor sweep: unconditionally buy any commodity listed at or below this price,
// then buffer it and sell opportunistically. Set to 0 to disable.
// Note: full cost basis (purchase price + buy-leg energy) must be recoverable via
// an existing buy order or the historical average cap before the sweep is executed.
var FLOOR_SWEEP_PRICE = 7;

// Resources excluded from floor sweeps. Energy is always excluded separately.
// Add any resource type string to block it from being swept.
// Modify at runtime: marketArbitrage.addFloorSweepBan('Z') / removeFloorSweepBan('Z')
var FLOOR_SWEEP_BANNED = { Z: true, zynthium: true };

// Enable verbose logging for floor sweep to diagnose why opportunities are skipped.
// Toggle at runtime: marketArbitrage.setFloorSweepDebug(true)
var FLOOR_SWEEP_DEBUG = false;

// Account-level resources that go to your account, not a terminal
var ACCOUNT_RESOURCES = { pixel: true, cpuUnlock: true, accessKey: true };

/**
 * Check if a resource type is an account-level resource (no terminal needed).
 * @param {string} resourceType
 * @returns {boolean}
 */
function isAccountResource(resourceType) {
    return !!ACCOUNT_RESOURCES[resourceType];
}

// === MEMORY INIT ===
if (!Memory.marketArbitrage) {
    Memory.marketArbitrage = { operations: {}, buffered: [] };
}
if (!Memory.marketArbitrage.buffered) {
    Memory.marketArbitrage.buffered = [];
}
// ghostSellOrders: { orderId -> tick } -- sell orders that returned OK but no resources arrived
if (!Memory.marketArbitrage.ghostSellOrders) {
    Memory.marketArbitrage.ghostSellOrders = {};
}
// selfArbPending: { roomName -> { buyOrderId, amount, tick, resourceType, ourSellOrderId, ourSellPrice, buyPrice } }
// Tracks deal() calls on external buy orders from our own sell-order terminals, pending verification.
if (!Memory.marketArbitrage.selfArbPending) {
    Memory.marketArbitrage.selfArbPending = {};
}
// accountOp: tracks a single in-flight account-level resource arbitrage operation (or null).
// States: pending_buy_verify -> ready_to_sell -> pending_sell_verify -> (complete/deleted)
if (Memory.marketArbitrage.accountOp === undefined) {
    Memory.marketArbitrage.accountOp = null;
}
// Restore adaptive scan interval from Memory so it survives global resets
if (typeof Memory.marketArbitrage.scanInterval === 'number') {
    SCAN_INTERVAL = Math.max(MIN_SCAN_INTERVAL, Math.min(MAX_SCAN_INTERVAL, Memory.marketArbitrage.scanInterval));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getMyRooms() {
    var myRooms = {};
    for (var rn in Game.rooms) {
        var r = Game.rooms[rn];
        if (r && r.controller && r.controller.my) myRooms[rn] = true;
    }
    return myRooms;
}

// -----------------------------------------------------------------------------
// PWR_OPERATE_TERMINAL-aware energy cost calculation
// -----------------------------------------------------------------------------

/**
 * Returns the effective energy cost for a deal/send from a specific terminal,
 * accounting for PWR_OPERATE_TERMINAL if active.
 *
 * POWER_INFO[PWR_OPERATE_TERMINAL].effect contains cost multipliers:
 *   [0.9, 0.8, 0.7, 0.6, 0.5] -> 10% to 50% reduction at levels 0-4.
 *
 * Game.market.calcTransactionCost() always returns the BASE (unpowered) cost,
 * so we must apply the multiplier ourselves to predict actual deal() cost.
 *
 * Handles both formats defensively:
 *   < 1  -> multiplier (e.g. 0.5 = 50% of base)
 *   >= 1 -> percentage reduction (e.g. 50 = 50% off base)
 *
 * @param {number} amount - Number of resources to transfer
 * @param {string} fromRoom - Source room name
 * @param {string} toRoom - Destination room name
 * @param {StructureTerminal} [terminal] - If provided, checks for active power effect
 * @returns {number} Effective energy cost (reduced if powered)
 */
function calcEffectiveEnergyCost(amount, fromRoom, toRoom, terminal) {
    var base = Game.market.calcTransactionCost(amount, fromRoom, toRoom);
    if (!terminal || !terminal.effects) return base;

    for (var i = 0; i < terminal.effects.length; i++) {
        var eff = terminal.effects[i];
        if (eff.effect === PWR_OPERATE_TERMINAL && eff.ticksRemaining > 0) {
            var info = (typeof POWER_INFO !== 'undefined') ? POWER_INFO[PWR_OPERATE_TERMINAL] : null;
            if (info && info.effect && typeof info.effect[eff.level] === 'number') {
                var effectValue = info.effect[eff.level];
                if (effectValue > 0 && effectValue < 1) {
                    // Multiplier format: 0.9 = 90% of base cost (10% reduction)
                    return Math.ceil(base * effectValue);
                } else if (effectValue >= 1 && effectValue <= 100) {
                    // Percentage format fallback: 10 = 10% reduction
                    return Math.ceil(base * (1 - effectValue / 100));
                }
            }
            return base;
        }
    }
    return base;
}

/**
 * Binary-search the largest amount whose effective energy cost fits within energyAvail.
 * Accounts for PWR_OPERATE_TERMINAL if terminal is provided.
 */
function capByEnergy(desired, fromRoom, toRoom, energyAvail, terminal) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    var low = 0, high = desired;
    while (low < high) {
        var mid = low + Math.ceil((high - low) / 2);
        if (calcEffectiveEnergyCost(mid, fromRoom, toRoom, terminal) <= energyAvail) low = mid;
        else high = mid - 1;
    }
    return low;
}

/**
 * Binary-search largest amount whose combined effective energy for BOTH legs
 * fits within energyAvail. Accounts for PWR_OPERATE_TERMINAL.
 */
function capByEnergyBothLegs(desired, ourRoom, sellRoom, buyRoom, energyAvail, terminal) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    var low = 0, high = desired;
    while (low < high) {
        var mid = low + Math.ceil((high - low) / 2);
        var cost = calcEffectiveEnergyCost(mid, ourRoom, sellRoom, terminal)
                 + calcEffectiveEnergyCost(mid, ourRoom, buyRoom, terminal);
        if (cost <= energyAvail) low = mid;
        else high = mid - 1;
    }
    return low;
}

/**
 * Collect active opportunisticBuy requests indexed by resourceType.
 * Returns { resource: [ { roomName, remaining, maxPrice, key }, ... ] }
 * Sorted by maxPrice descending.
 *
 * IMPORTANT: callers must decrement opp.remaining in-place after each send()
 * to prevent multiple terminals/buffers from over-committing in the same tick.
 */
function getOppBuyRequests() {
    var result = {};
    if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) return result;
    var reqs = Memory.opportunisticBuy.requests;
    for (var key in reqs) {
        var req = reqs[key];
        if (!req || typeof req.remaining !== 'number' || req.remaining <= 0) continue;
        if (req.pending && typeof req.pending.expected === 'number') continue;
        var res = req.resourceType;
        if (!result[res]) result[res] = [];
        result[res].push({ roomName: req.roomName, remaining: req.remaining, maxPrice: req.maxPrice, key: key });
    }
    for (var res in result) {
        result[res].sort(function (a, b) { return b.maxPrice - a.maxPrice; });
    }
    return result;
}

/**
 * Search outgoingTransactions for a matching sell (resources LEFT our terminal).
 * deal(buyOrderId, amount, myRoom) -> tx.from === myRoom, tx.order.id === buyOrderId
 */
function findOutgoingTx(roomName, resourceType, orderId, sinceTime) {
    var txns = Game.market.outgoingTransactions;
    if (!txns) return null;
    for (var i = 0; i < txns.length; i++) {
        var tx = txns[i];
        if (tx.time < sinceTime) break;
        if (tx.from === roomName && tx.resourceType === resourceType &&
            tx.order && tx.order.id === orderId) return tx;
    }
    return null;
}

/**
 * Search incomingTransactions for a matching buy (resources ARRIVED in our terminal).
 * deal(sellOrderId, amount, myRoom) -> tx.to === myRoom, tx.order.id === sellOrderId
 */
function findIncomingTx(roomName, resourceType, orderId, sinceTime) {
    var txns = Game.market.incomingTransactions;
    if (!txns) return null;
    for (var i = 0; i < txns.length; i++) {
        var tx = txns[i];
        if (tx.time < sinceTime) break;
        if (tx.to === roomName && tx.resourceType === resourceType &&
            tx.order && tx.order.id === orderId) return tx;
    }
    return null;
}

/**
 * Search outgoingTransactions for an account-level resource sell.
 * Account resources have no terminal, so we match only by resourceType and orderId.
 */
function findAccountOutgoingTx(resourceType, orderId, sinceTime) {
    var txns = Game.market.outgoingTransactions;
    if (!txns) return null;
    for (var i = 0; i < txns.length; i++) {
        var tx = txns[i];
        if (tx.time < sinceTime) break;
        if (tx.resourceType === resourceType && tx.order && tx.order.id === orderId) return tx;
    }
    return null;
}

// -----------------------------------------------------------------------------
// History Cache (per-scan)
// -----------------------------------------------------------------------------

/** Scan-local cache for Game.market.getHistory(). Cleared every run(). */
var _historyCache = {};

/**
 * Module-level caches populated on scan ticks and reused between scans.
 * Allows active operation processing (especially pending_sell) to run every
 * tick instead of only on scan ticks, so powered terminals with shorter
 * cooldowns don't sit idle waiting for the next scan.
 *
 * The primary sell path uses Game.market.getOrderById() which is always live.
 * Cached data is only used for replacement order search and self-fulfill
 * comparison -- acceptable to be slightly stale between scans.
 */
var _cachedBuysByRes = {};
var _cachedOppBuyRequests = {};
var _cachedEnergyPrice = 0;
var _cachedMyRooms = {};

/**
 * Get the average-of-last-two-days price cap for a resource.
 * Uses a per-scan cache to avoid repeated getHistory() API calls.
 * @param {string} resource
 * @param {number} multiplier  -- e.g. 1.5 for normal, 1.0 for strict
 * @returns {number} maxBuyPrice (Infinity if no history and multiplier > 1)
 */
function getHistoryCap(resource, multiplier) {
    if (_historyCache[resource] === undefined) {
        var hist = Game.market.getHistory(resource) || [];
        var hC = 0, hS = 0;
        if (hist.length >= 1 && hist[hist.length-1] && typeof hist[hist.length-1].avgPrice === 'number') { hS += hist[hist.length-1].avgPrice; hC++; }
        if (hist.length >= 2 && hist[hist.length-2] && typeof hist[hist.length-2].avgPrice === 'number') { hS += hist[hist.length-2].avgPrice; hC++; }
        _historyCache[resource] = hC > 0 ? (hS / hC) : null;
    }
    var avg = _historyCache[resource];
    if (avg === null) return multiplier <= 1.0 ? 0 : Infinity;
    return avg * multiplier;
}

// -----------------------------------------------------------------------------
// Opportunity Scanner
// -----------------------------------------------------------------------------

/** Collect resource types for which we have active sell orders on the market. */
function getOwnSellResources() {
    var result = {};
    var myOrders = Game.market.orders;
    if (!myOrders) return result;
    for (var id in myOrders) {
        var o = myOrders[id];
        if (o && o.type === ORDER_SELL && o.active && (o.remainingAmount || 0) > 0) {
            result[o.resourceType] = true;
        }
    }
    return result;
}

/**
 * Build buy and sell order books.
 *
 * EFFICIENCY: Single pass over allOrders collects buys (building buysByRes and
 * viable) and pre-filters sells into a buffer in one sweep. The second pass only
 * iterates that sell buffer -- roughly half the size of allOrders -- to apply the
 * viable filter. This cuts total iterations from 2*N to ~1.5*N vs the naive
 * two-full-pass approach.
 */
function buildOrderBooks(myRooms, oppBuyRequests) {
    var allOrders  = Game.market.getAllOrders();
    var buysByRes  = {};
    var sellsByRes = {};
    var viable     = {};
    var sellBuffer = []; // pre-filtered sells awaiting viable check

    // Single pass: build buys + viable, collect candidate sells
    for (var i = 0; i < allOrders.length; i++) {
        var o = allOrders[i];
        if (!o || o.resourceType === RESOURCE_ENERGY) continue;

        if (o.type === ORDER_BUY) {
            if ((o.remainingAmount || o.amount || 0) < MIN_BUY_ORDER_AMOUNT) continue;
            if (o.roomName && myRooms[o.roomName]) continue;
            if (!buysByRes[o.resourceType]) buysByRes[o.resourceType] = [];
            buysByRes[o.resourceType].push(o);
            viable[o.resourceType] = true;
        } else if (o.type === ORDER_SELL && (o.amount || 0) > 0 && !(o.roomName && myRooms[o.roomName])) {
            sellBuffer.push(o);
        }
    }

    for (var r in oppBuyRequests) viable[r] = true;

    // Floor sweep: mark all resources with cheap sell orders as viable so they
    // appear in sellsByRes even when no buy order exists for that resource.
    if (FLOOR_SWEEP_PRICE > 0) {
        for (var j = 0; j < sellBuffer.length; j++) {
            if (sellBuffer[j].price <= FLOOR_SWEEP_PRICE) viable[sellBuffer[j].resourceType] = true;
        }
    }

    // Second pass over sell buffer only (~half of allOrders)
    for (var k = 0; k < sellBuffer.length; k++) {
        var so = sellBuffer[k];
        if (!viable[so.resourceType]) continue;
        if (!sellsByRes[so.resourceType]) sellsByRes[so.resourceType] = [];
        sellsByRes[so.resourceType].push(so);
    }

    for (var r1 in buysByRes) buysByRes[r1].sort(function(a, b) { return b.price - a.price; });
    for (var r2 in sellsByRes) {
        sellsByRes[r2].sort(function(a, b) { return a.price - b.price; });
        if (sellsByRes[r2].length > MAX_SELLS_PER_RESOURCE)
            sellsByRes[r2] = sellsByRes[r2].slice(0, MAX_SELLS_PER_RESOURCE);
    }

    return { sellsByRes: sellsByRes, buysByRes: buysByRes };
}

/** Find best arb opportunity for a terminal. Accounts for committed sell/buy amounts
 *  and global per-resource exposure limits. Caps per-terminal share for splitting.
 *  Uses calcEffectiveEnergyCost for PWR_OPERATE_TERMINAL awareness.
 *  Single-terminal resources (SINGLE_TERMINAL_RESOURCES) skip splitting and are
 *  blocked if another terminal already has that resource in-flight.
 *  Self-fulfill advantage: if an oppBuy request exists for this resource and the
 *  sell price is within our maxPrice, external buy orders must exceed our maxPrice
 *  by SELF_FULFILL_ADVANTAGE factor -- otherwise we skip the arb and let oppBuy
 *  purchase it for ourselves.
 *
 * EFFICIENCY: sell.price > maxBuyPrice uses break (not continue) because sells are
 * sorted ascending -- once one exceeds the cap all remaining ones do too. */
function findBestOpportunity(terminal, books, energyPrice, committedBuyAmounts, committedSellAmounts, numIdleTerminals, resourceExposure, bufferedResources, ownSellResources, activeResourceTypes, oppBuyRequests) {
    var roomName        = terminal.room.name;
    var availableEnergy = terminal.store[RESOURCE_ENERGY] || 0;
    var freeCapacity    = terminal.store.getFreeCapacity() || 0;
    var credits         = Game.market.credits;
    if (freeCapacity <= 0 || availableEnergy < 100 || credits < 1) return null;

    var bestOpp = null, bestProfit = 0;

    for (var resource in books.sellsByRes) {
        var sells = books.sellsByRes[resource];
        if (!sells || !sells.length) continue;

        // Skip account-level resources -- handled by processAccountArbitrage
        if (isAccountResource(resource)) continue;

        // Don't buy more of a resource that's already stuck in buffer unsold
        if (bufferedResources[resource]) continue;

        // Don't buy resources we already have listed for sale -- self-arb handles those
        if (ownSellResources && ownSellResources[resource]) continue;

        // Single-terminal resources: skip if another terminal already has this in-flight
        if (SINGLE_TERMINAL_RESOURCES[resource] && activeResourceTypes[resource]) continue;

        // Global exposure cap: how much more of this resource can we take on?
        var currentExposure = resourceExposure[resource] || 0;
        var exposureRoom = MAX_RESOURCE_EXPOSURE - currentExposure;
        if (exposureRoom <= 0) continue;

        var topBuy = null, topBuyAmt = 0;
        if (books.buysByRes[resource]) {
            for (var bi = 0; bi < books.buysByRes[resource].length; bi++) {
                var cb = books.buysByRes[resource][bi];
                var eff = (cb.remainingAmount || cb.amount || 0) - (committedBuyAmounts[cb.id] || 0);
                if (eff > 0) { topBuy = cb; topBuyAmt = eff; break; }
            }
        }

        // -- Self-fulfill advantage --
        // If we have an active oppBuy request for this resource and the cheapest
        // sell order is affordable (within our maxPrice), only allow arb if the
        // external buy price exceeds our maxPrice by the SELF_FULFILL_ADVANTAGE
        // factor. Otherwise skip -- let oppBuy grab the cheap sell order instead.
        if (oppBuyRequests && oppBuyRequests[resource] && oppBuyRequests[resource].length > 0) {
            var bestOppMaxPrice = oppBuyRequests[resource][0].maxPrice; // sorted desc
            var cheapestSellPrice = sells[0].price;
            if (cheapestSellPrice <= bestOppMaxPrice) {
                if (!topBuy || topBuy.price < bestOppMaxPrice * SELF_FULFILL_ADVANTAGE) {
                    continue; // skip this resource -- self-fulfill is better
                }
            }
        }

        // Historical average cap (150%) -- uses per-scan cache
        var maxBuyPrice = getHistoryCap(resource, 1.5);

        for (var s = 0; s < sells.length; s++) {
            var sell = sells[s];
            // EFFICIENCY: break (not continue) -- sells are sorted ascending by price,
            // so once one exceeds maxBuyPrice all subsequent ones do too.
            if (sell.price > maxBuyPrice) break;
            if (!topBuy || sell.price >= topBuy.price) break;
            if (sell.roomName && topBuy.roomName && sell.roomName === topBuy.roomName) continue;

            // Account for other terminals already committed to this sell order
            var sellCommitted = committedSellAmounts[sell.id] || 0;
            var sellAvailable = sell.amount - sellCommitted;
            if (sellAvailable <= 0) continue;

            // Single-terminal resources or small orders (<50) get the full amount
            // to avoid spreading tiny trades across many terminals.
            var perTerminalShare;
            if (SINGLE_TERMINAL_RESOURCES[resource] || sellAvailable < 50) {
                perTerminalShare = sellAvailable;
            } else {
                var remainingTerminals = Math.max(1, numIdleTerminals);
                perTerminalShare = Math.ceil(sellAvailable / remainingTerminals);
                if (perTerminalShare < MIN_AMOUNT_PER_TERMINAL) {
                    if (sellAvailable >= MIN_AMOUNT_PER_TERMINAL * remainingTerminals) {
                        perTerminalShare = MIN_AMOUNT_PER_TERMINAL;
                    }
                }
            }

            // Cap by global resource exposure
            var maxAmt = Math.min(perTerminalShare, sellAvailable, topBuyAmt, freeCapacity, Math.floor(credits / sell.price), exposureRoom);
            if (maxAmt <= 0) continue;
            var feasible = capByEnergyBothLegs(maxAmt, roomName, sell.roomName, topBuy.roomName, availableEnergy, terminal);
            if (feasible <= 0) continue;

            var creditCost    = sell.price * feasible;
            var creditRevenue = topBuy.price * feasible;
            var buyEnergy     = calcEffectiveEnergyCost(feasible, roomName, sell.roomName, terminal);
            var sellEnergy    = calcEffectiveEnergyCost(feasible, roomName, topBuy.roomName, terminal);
            var energyCostCr  = (buyEnergy + sellEnergy) * energyPrice;
            var totalCost     = creditCost + energyCostCr;
            var profit        = creditRevenue - totalCost;
            var margin        = totalCost > 0 ? profit / totalCost : 0;

            if (margin >= MIN_PROFIT_MARGIN && profit > bestProfit) {
                bestProfit = profit;
                bestOpp = {
                    resourceType: resource,
                    sellOrder:    { id: sell.id, roomName: sell.roomName, price: sell.price, amount: sell.amount },
                    buyOrder:     { id: topBuy.id, roomName: topBuy.roomName, price: topBuy.price, amount: topBuyAmt },
                    amount: feasible, creditCost: creditCost, creditRevenue: creditRevenue,
                    buyEnergy: buyEnergy, sellEnergy: sellEnergy, energyCostCr: energyCostCr,
                    profit: profit, margin: margin
                };
            }
        }
    }
    return bestOpp;
}

// -----------------------------------------------------------------------------
// Floor Sweep Scanner
// -----------------------------------------------------------------------------

/**
 * Find a floor-price sweep opportunity for a terminal.
 *
 * Buys any non-energy commodity listed at <= FLOOR_SWEEP_PRICE with no buy
 * order required. The purchase enters the normal state machine:
 *   pending_buy_verify -> pending_sell -> (buffer if no buyer found)
 * and then sells opportunistically from the buffer just like any other entry.
 *
 * COST BASIS: At ~28 cr/energy, the buy-leg energy cost can far exceed the
 * nominal purchase price for cheap commodities (e.g. 0.5 cr/unit * 1000 units
 * = 500 cr, but 150 energy * 28 cr = 4200 cr in energy). We compute the full
 * cost basis (purchase price + buy-leg energy per unit) and require that either:
 *   a) an existing buy order covers cost basis + MIN_PROFIT_MARGIN, OR
 *   b) the 150% historical average cap exceeds cost basis + MIN_PROFIT_MARGIN.
 * If neither holds, the sweep is skipped -- there is no realistic exit.
 *
 * Picks the candidate with the largest feasible amount. Ties broken by cheapest
 * price (since sells are sorted ascending, first hit with highest feasible wins).
 *
 * @returns {object|null} sweep opportunity descriptor, or null if none found
 */
function findFloorSweepOpportunity(terminal, books, energyPrice, committedSellAmounts, resourceExposure, bufferedResources, ownSellResources, activeResourceTypes) {
    if (FLOOR_SWEEP_PRICE <= 0) return null;

    var roomName        = terminal.room.name;
    var availableEnergy = terminal.store[RESOURCE_ENERGY] || 0;
    var freeCapacity    = terminal.store.getFreeCapacity() || 0;
    var credits         = Game.market.credits;

    if (freeCapacity <= 0 || availableEnergy < 100 || credits < 1) {
        if (FLOOR_SWEEP_DEBUG) console.log('[Arbitrage][SweepDBG] ' + roomName +
            ': early exit cap=' + freeCapacity + ' energy=' + availableEnergy + ' cr=' + credits.toFixed(1));
        return null;
    }

    var bestOpp = null, bestAmount = 0;

    for (var resource in books.sellsByRes) {
        if (resource === RESOURCE_ENERGY) continue;
        if (isAccountResource(resource)) continue;
        if (FLOOR_SWEEP_BANNED[resource]) {
            if (FLOOR_SWEEP_DEBUG) console.log('[Arbitrage][SweepDBG] ' + resource + ': skip banned');
            continue;
        }

        // NOTE: bufferedResources is intentionally NOT checked here.
        // At <=1 cr/unit the downside of accumulating more is tiny, and stopping
        // purchases just because some is already buffered means we miss cheap stock.
        // The exposure cap (MAX_RESOURCE_EXPOSURE) still provides an upper bound.

        // NOTE: ownSellResources is intentionally NOT checked here.
        // We may have sell orders at 200 cr while someone lists at 0.001 cr.
        // Self-arb won't catch this (no external buy order), so sweep must.

        if (SINGLE_TERMINAL_RESOURCES[resource] && activeResourceTypes[resource]) {
            if (FLOOR_SWEEP_DEBUG) console.log('[Arbitrage][SweepDBG] ' + resource + ': skip single-terminal in-flight');
            continue;
        }

        var currentExposure = resourceExposure[resource] || 0;
        var exposureRoom    = MAX_RESOURCE_EXPOSURE - currentExposure;
        if (exposureRoom <= 0) {
            if (FLOOR_SWEEP_DEBUG) console.log('[Arbitrage][SweepDBG] ' + resource + ': skip exposure cap ' + currentExposure);
            continue;
        }

        var sells = books.sellsByRes[resource];
        if (!sells || !sells.length) continue;

        // Only bother logging resources that actually have cheap orders
        if (FLOOR_SWEEP_DEBUG && sells[0] && sells[0].price <= FLOOR_SWEEP_PRICE) {
            console.log('[Arbitrage][SweepDBG] ' + resource + ': cheapest=' + sells[0].price +
                ' room=' + sells[0].roomName + ' amt=' + sells[0].amount +
                (bufferedResources[resource] ? ' (already buffered)' : ''));
        }

        for (var s = 0; s < sells.length; s++) {
            var sell = sells[s];
            if (sell.price > FLOOR_SWEEP_PRICE) break; // sorted ascending

            var sellCommitted = committedSellAmounts[sell.id] || 0;
            var sellAvailable = (sell.amount || 0) - sellCommitted;
            if (sellAvailable <= 0) continue;

            var creditCap = sell.price > 0 ? Math.floor(credits / sell.price) : sellAvailable;
            var maxAmt    = Math.min(sellAvailable, freeCapacity, creditCap, exposureRoom);
            if (maxAmt <= 0) {
                if (FLOOR_SWEEP_DEBUG) console.log('[Arbitrage][SweepDBG] ' + resource +
                    ': maxAmt=0 avail=' + sellAvailable + ' cap=' + freeCapacity + ' creditCap=' + creditCap);
                continue;
            }

            var feasible = capByEnergy(maxAmt, roomName, sell.roomName, availableEnergy, terminal);
            if (feasible <= 0) {
                if (FLOOR_SWEEP_DEBUG) console.log('[Arbitrage][SweepDBG] ' + resource +
                    ': energy too low for any amount (avail=' + availableEnergy +
                    ' cost1=' + calcEffectiveEnergyCost(1, roomName, sell.roomName, terminal) + '/unit)');
                continue;
            }

            var buyLegEnergy    = calcEffectiveEnergyCost(feasible, roomName, sell.roomName, terminal);
            var costBasisPerUnit = sell.price + (buyLegEnergy * energyPrice / feasible);
            var minSellNeeded   = costBasisPerUnit * (1 + MIN_PROFIT_MARGIN);

            var hasBuyer = false;
            var existingBuys = books.buysByRes[resource];
            if (existingBuys) {
                for (var b = 0; b < existingBuys.length; b++) {
                    if (existingBuys[b].price >= minSellNeeded) { hasBuyer = true; break; }
                }
            }
            if (!hasBuyer) {
                var histCap = getHistoryCap(resource, 1.5);
                if (histCap < minSellNeeded) {
                    if (FLOOR_SWEEP_DEBUG) console.log('[Arbitrage][SweepDBG] ' + resource +
                        ': no exit: basis=' + costBasisPerUnit.toFixed(3) +
                        ' minSell=' + minSellNeeded.toFixed(3) +
                        ' histCap=' + (histCap === Infinity ? 'Inf' : histCap.toFixed(3)) +
                        ' energy=' + buyLegEnergy + '@' + energyPrice.toFixed(2) + 'cr');
                    continue;
                }
            }

            if (feasible > bestAmount) {
                bestAmount = feasible;
                bestOpp = {
                    resourceType: resource,
                    sellOrder:    { id: sell.id, roomName: sell.roomName, price: sell.price, amount: sell.amount },
                    amount:       feasible,
                    creditCost:   sell.price * feasible,
                    buyEnergy:    buyLegEnergy,
                    costBasis:    costBasisPerUnit
                };
            }
        }
    }

    if (FLOOR_SWEEP_DEBUG && !bestOpp) console.log('[Arbitrage][SweepDBG] ' + roomName + ': no sweep opportunity found');
    return bestOpp;
}

// -----------------------------------------------------------------------------
// Self-Arbitrage on Own Sell Orders
// -----------------------------------------------------------------------------

/**
 * Scans our own active sell orders for profitable external buy orders or self-fulfill opportunities.
 *
 * When someone fills our sell order naturally, THEY pay energy and we get our
 * asking price for free. But if a buy order exists at a higher price, we can
 * capture the spread by dealing directly -- at the cost of us paying energy.
 *
 * Profit = (buyPrice - ourSellPrice) * amount - energyCost * energyPrice
 *
 * We only act when this is positive and above MIN_SELF_ARB_PROFIT, meaning the
 * spread is large enough to justify burning our own energy.
 *
 * Flow:
 *   1. Find our active sell orders (Game.market.orders)
 *   2. For each, find the best external buy order where buyPrice > ourSellPrice + energyCost
 *   3. deal() on the buy order from the sell order's terminal
 *   4. Track in selfArbPending for verification
 *   5. On verified sale, cancel the (now unfunded) sell order
 *
 * OPTIMIZATION: receives shared buysByRes from buildOrderBooks() instead of
 * calling Game.market.getAllOrders() per sell order.
 *
 * PWR_OPERATE_TERMINAL: uses calcEffectiveEnergyCost to account for powered terminals.
 */
function processOwnSellOrders(energyPrice, myRooms, committedBuyAmounts, buysByRes, oppBuyRequests, usedTerminals) {
    var pending = Memory.marketArbitrage.selfArbPending;
    var ops = Memory.marketArbitrage.operations;

    // -- Verify pending self-arb deals --
    for (var pRoom in pending) {
        var p = pending[pRoom];
        var tx = findOutgoingTx(pRoom, p.resourceType, p.buyOrderId, p.tick);
        if (tx) {
            var pTerminal = Game.rooms[pRoom] && Game.rooms[pRoom].terminal;
            var profit = (p.buyPrice - p.ourSellPrice) * tx.amount
                       - calcEffectiveEnergyCost(tx.amount, pRoom, p.buyOrderRoom, pTerminal) * energyPrice;
            console.log('[Arbitrage] SELF-ARB verified: sold ' + tx.amount + ' ' +
                p.resourceType + ' from ' + pRoom + ' @ ' + p.buyPrice +
                ' (was listed @ ' + p.ourSellPrice + ') | Profit: ' + profit.toFixed(2));

            // Cancel or adjust our sell order since resources are gone
            var ourOrder = Game.market.getOrderById(p.ourSellOrderId);
            if (ourOrder) {
                var newRemaining = (ourOrder.remainingAmount || 0) - tx.amount;
                if (newRemaining <= 0) {
                    Game.market.cancelOrder(p.ourSellOrderId);
                    console.log('[Arbitrage] Cancelled own sell order ' + p.ourSellOrderId + ' (fully sold via self-arb)');
                } else {
                    var term = Game.rooms[pRoom] && Game.rooms[pRoom].terminal;
                    var backed = term ? (term.store[p.resourceType] || 0) : 0;
                    if (backed < newRemaining) {
                        Game.market.cancelOrder(p.ourSellOrderId);
                        console.log('[Arbitrage] Cancelled own sell order ' + p.ourSellOrderId +
                            ' (only ' + backed + ' left, order wants ' + newRemaining + ')');
                    }
                }
            }
            delete pending[pRoom];
            continue;
        }
        if (Game.time - p.tick >= VERIFY_TIMEOUT) {
            console.log('[Arbitrage] SELF-ARB ghost in ' + pRoom + ': ' + p.amount + ' ' +
                p.resourceType + ' -- no outgoing tx. Cleaning up.');
            delete pending[pRoom];
        }
    }

    // -- Scan own sell orders for opportunities --
    var myOrders = Game.market.orders;
    if (!myOrders) return;

    for (var orderId in myOrders) {
        var order = myOrders[orderId];
        if (!order || order.type !== ORDER_SELL || !order.active) continue;
        if (order.resourceType === RESOURCE_ENERGY) continue;
        var remaining = order.remainingAmount || 0;
        if (remaining <= 0) continue;

        // Skip account-level resources -- self-arb requires terminal.store checks
        if (isAccountResource(order.resourceType)) continue;

        var roomName = order.roomName;

        // usedThisTick guard: prevents a terminal from both sending and dealing in the same invocation
        if (usedTerminals[roomName]) continue;

        var room = Game.rooms[roomName];
        var terminal = room && room.terminal;
        if (!terminal || terminal.cooldown > 0) continue;

        // Skip rooms with active arb operations or pending self-arb verification
        if (ops[roomName] || pending[roomName]) continue;

        // Verify the terminal actually has the resources
        var store = terminal.store[order.resourceType] || 0;
        if (store <= 0) continue;
        var sellableAmount = Math.min(remaining, store);

        var availEnergy = terminal.store[RESOURCE_ENERGY] || 0;
        if (availEnergy < 50) continue;

        var ourPrice = order.price;

        // -- Self-fulfill path (own inventory, no maxPrice constraint) --
        var oppList = oppBuyRequests[order.resourceType];
        if (oppList) {
            for (var oi = 0; oi < oppList.length; oi++) {
                var opp = oppList[oi];
                if (opp.roomName === roomName || opp.remaining <= 0) continue;

                var sfAmt = capByEnergy(Math.min(sellableAmount, opp.remaining), roomName, opp.roomName, availEnergy, terminal);
                if (sfAmt <= 0) continue;

                var sfE = calcEffectiveEnergyCost(sfAmt, roomName, opp.roomName, terminal);
                var sfVal = opp.maxPrice * sfAmt - sfE * energyPrice;

                // Check external buy orders to see if any significantly beat self-fulfill
                var buyOrders = buysByRes[order.resourceType];
                var bestExtVal = 0;
                if (buyOrders) {
                    for (var bi = 0; bi < buyOrders.length; bi++) {
                        var bo = buyOrders[bi];
                        if (bo.price <= ourPrice) break;
                        var effAmt = (bo.remainingAmount || bo.amount || 0) - (committedBuyAmounts[bo.id] || 0);
                        if (effAmt < MIN_BUY_ORDER_AMOUNT) continue;

                        var extAmt = Math.min(sellableAmount, effAmt);
                        var extE = calcEffectiveEnergyCost(extAmt, roomName, bo.roomName, terminal);
                        var extVal = bo.price * extAmt - extE * energyPrice;
                        if (extVal > bestExtVal) bestExtVal = extVal;
                    }
                }

                // Self-fulfill advantage: only skip self-fulfill if external value
                // exceeds our self-fulfill value by the advantage factor.
                if (sfVal * SELF_FULFILL_ADVANTAGE > bestExtVal) {
                    if (terminal.send(order.resourceType, sfAmt, opp.roomName) === OK) {
                        console.log('[Arbitrage] OWN-SELL self-fulfill ' + sfAmt + ' ' + order.resourceType +
                            ' -> ' + opp.roomName + ' (maxPrice ' + opp.maxPrice + ', listed @ ' + ourPrice + ')');
                        opp.remaining -= sfAmt;
                        if (Memory.opportunisticBuy && Memory.opportunisticBuy.requests && Memory.opportunisticBuy.requests[opp.key]) {
                            var or = Memory.opportunisticBuy.requests[opp.key];
                            or.fulfilled = (or.fulfilled || 0) + sfAmt; or.remaining -= sfAmt;
                            if (or.remaining <= 0) delete Memory.opportunisticBuy.requests[opp.key];
                        }
                        usedTerminals[roomName] = true;
                        var newRemaining = remaining - sfAmt;
                        if (newRemaining <= 0) {
                            Game.market.cancelOrder(orderId);
                            console.log('[Arbitrage] Cancelled own sell order ' + orderId + ' (fully sent via self-fulfill)');
                        }
                        break;
                    }
                }
            }
        }
        if (usedTerminals[roomName]) continue;

        // -- Use shared buysByRes instead of getAllOrders per sell order --
        var buyOrders = buysByRes[order.resourceType];
        if (!buyOrders || !buyOrders.length) continue;

        var best = null, bestProfit = 0;
        for (var bi = 0; bi < buyOrders.length; bi++) {
            var bo = buyOrders[bi];
            if (bo.price <= ourPrice) break;
            var effAmt = (bo.remainingAmount || bo.amount || 0) - (committedBuyAmounts[bo.id] || 0);
            if (effAmt < MIN_BUY_ORDER_AMOUNT) continue;

            var amount = Math.min(sellableAmount, effAmt);
            var capped = capByEnergy(amount, roomName, bo.roomName, availEnergy, terminal);
            if (capped <= 0) continue;

            var energyCost = calcEffectiveEnergyCost(capped, roomName, bo.roomName, terminal);
            var energyCostCr = energyCost * energyPrice;
            var profit = (bo.price - ourPrice) * capped - energyCostCr;

            if (profit > MIN_SELF_ARB_PROFIT && profit > bestProfit) {
                bestProfit = profit;
                best = { buyOrder: bo, amount: capped, energyCost: energyCost, profit: profit };
            }
        }

        if (!best) continue;

        if (Game.market.deal(best.buyOrder.id, best.amount, roomName) === OK) {
            pending[roomName] = {
                buyOrderId:    best.buyOrder.id,
                buyOrderRoom:  best.buyOrder.roomName,
                buyPrice:      best.buyOrder.price,
                ourSellOrderId: orderId,
                ourSellPrice:  ourPrice,
                resourceType:  order.resourceType,
                amount:        best.amount,
                tick:          Game.time
            };
            committedBuyAmounts[best.buyOrder.id] = (committedBuyAmounts[best.buyOrder.id] || 0) + best.amount;
            usedTerminals[roomName] = true;

            console.log('[Arbitrage] SELF-ARB deal() OK ' + best.amount + ' ' + order.resourceType +
                ' from ' + roomName + ' (listed @ ' + ourPrice + ') -> buy order @ ' + best.buyOrder.price +
                ' in ' + best.buyOrder.roomName +
                ' | Spread profit: ' + best.profit.toFixed(2) +
                ' | Energy: ' + best.energyCost + ' (' + (best.energyCost * energyPrice).toFixed(2) + ' cr)' +
                ' | Verifying...');
        }
    }
}

// -----------------------------------------------------------------------------
// Account-Level Resource Arbitrage (pixel, cpuUnlock, accessKey)
// -----------------------------------------------------------------------------

/**
 * Find best arbitrage opportunity for account-level resources.
 * No energy costs, no terminal constraints -- profit is pure credit spread.
 */
function findAccountOpportunity(books, committedBuyAmounts, committedSellAmounts, resourceExposure, ownSellResources) {
    var credits = Game.market.credits;
    if (credits < 1) return null;

    var bestOpp = null, bestProfit = 0;

    for (var resource in books.sellsByRes) {
        if (!isAccountResource(resource)) continue;

        var sells = books.sellsByRes[resource];
        if (!sells || !sells.length) continue;

        if (ownSellResources && ownSellResources[resource]) continue;

        var currentExposure = resourceExposure[resource] || 0;
        var exposureRoom = MAX_RESOURCE_EXPOSURE - currentExposure;
        if (exposureRoom <= 0) continue;

        var topBuy = null, topBuyAmt = 0;
        if (books.buysByRes[resource]) {
            for (var bi = 0; bi < books.buysByRes[resource].length; bi++) {
                var cb = books.buysByRes[resource][bi];
                var eff = (cb.remainingAmount || cb.amount || 0) - (committedBuyAmounts[cb.id] || 0);
                if (eff > 0) { topBuy = cb; topBuyAmt = eff; break; }
            }
        }
        if (!topBuy) continue;

        var histMultiplier = (resource === 'cpuUnlock' || resource === 'accessKey') ? 1.0 : 1.5;
        var maxBuyPrice = getHistoryCap(resource, histMultiplier);

        for (var s = 0; s < sells.length; s++) {
            var sell = sells[s];
            if (sell.price > maxBuyPrice) continue;
            if (sell.price >= topBuy.price) break;

            var sellCommitted = committedSellAmounts[sell.id] || 0;
            var sellAvailable = (sell.amount || 0) - sellCommitted;
            if (sellAvailable <= 0) continue;

            var maxAmt = Math.min(sellAvailable, topBuyAmt, Math.floor(credits / sell.price), exposureRoom);
            if (maxAmt <= 0) continue;

            var creditCost    = sell.price * maxAmt;
            var creditRevenue = topBuy.price * maxAmt;
            var profit        = creditRevenue - creditCost;
            var margin        = creditCost > 0 ? profit / creditCost : 0;

            if (margin >= MIN_PROFIT_MARGIN && profit > bestProfit) {
                bestProfit = profit;
                bestOpp = {
                    resourceType: resource,
                    sellOrder: { id: sell.id, roomName: sell.roomName, price: sell.price, amount: sell.amount },
                    buyOrder:  { id: topBuy.id, roomName: topBuy.roomName, price: topBuy.price, amount: topBuyAmt },
                    amount: maxAmt,
                    creditCost: creditCost,
                    creditRevenue: creditRevenue,
                    profit: profit,
                    margin: margin
                };
            }
        }
    }
    return bestOpp;
}

/**
 * Verify pending account-level operations (buy and sell confirmations).
 * Called early in run() before order books are needed.
 */
function processAccountOpVerify() {
    var op = Memory.marketArbitrage.accountOp;
    if (!op) return;

    // -- Verify buy --
    if (op.state === 'pending_buy_verify') {
        var currentBalance = (Game.resources && Game.resources[op.resourceType]) || 0;
        var gained = currentBalance - (op.prevBalance || 0);
        if (gained > 0) {
            var actual = Math.min(gained, op.amount);
            if (actual < op.amount) {
                console.log('[Arbitrage] Account buy partial: expected ' + op.amount + ', got ' + actual + '. Adjusting.');
                op.amount = actual;
                op.profit = (op.buyPrice - op.sellPrice) * actual;
                op.margin = op.sellPrice > 0 ? (op.buyPrice - op.sellPrice) / op.sellPrice : 0;
            }
            op.state = 'ready_to_sell';
            delete op.buyVerifyTick;
            delete op.prevBalance;
            console.log('[Arbitrage] Account buy verified: ' + actual + ' ' + op.resourceType);
            return;
        }
        if (Game.time - op.buyVerifyTick >= ACCOUNT_VERIFY_TIMEOUT) {
            console.log('[Arbitrage] Account BUY GHOST: ' + op.amount + ' ' + op.resourceType +
                ' -- no balance increase after ' + (Game.time - op.buyVerifyTick) + ' ticks. Cleaning up.');
            if (op.sellOrderId) {
                Memory.marketArbitrage.ghostSellOrders[op.sellOrderId] = Game.time;
            }
            Memory.marketArbitrage.accountOp = null;
        }
        return;
    }

    // -- Verify sell --
    if (op.state === 'pending_sell_verify') {
        var curSellBalance = (Game.resources && Game.resources[op.resourceType]) || 0;
        var lost = (op.prevSellBalance || 0) - curSellBalance;
        if (lost > 0) {
            var soldAmount = Math.min(lost, op.sellVerifyAmount || op.amount);
            console.log('[Arbitrage] Account VERIFIED sale of ' + soldAmount + ' ' +
                op.resourceType + ' @ ' + (op.buyPrice || '?'));
            op.amount -= soldAmount;
            if (op.amount <= 0) {
                console.log('[Arbitrage] Account arbitrage complete for ' + op.resourceType +
                    '. Est. profit: ' + op.profit.toFixed(2) + ' (' + (op.margin * 100).toFixed(1) + '%)');
                Memory.marketArbitrage.accountOp = null;
            } else {
                op.state = 'ready_to_sell';
                delete op.sellVerifyTick;
                delete op.sellVerifyOrderId;
                delete op.sellVerifyAmount;
                delete op.prevSellBalance;
                console.log('[Arbitrage] Account partial verify, ' + op.amount + ' ' + op.resourceType + ' remaining to sell');
            }
            return;
        }
        if (Game.time - op.sellVerifyTick >= ACCOUNT_VERIFY_TIMEOUT) {
            console.log('[Arbitrage] Account SELL GHOST: ' + (op.sellVerifyAmount || '?') + ' ' +
                op.resourceType + ' -- no balance decrease after ' + (Game.time - op.sellVerifyTick) + ' ticks.');
            op.state = 'ready_to_sell';
            op.buyOrderId = null;
            delete op.sellVerifyTick;
            delete op.sellVerifyOrderId;
            delete op.sellVerifyAmount;
            delete op.prevSellBalance;
        }
        return;
    }
}

/**
 * Handle account-level selling (ready_to_sell) and scanning for new opportunities.
 * Called after order books are built in PASS 2.
 */
function processAccountOpSellAndScan(books, committedBuyAmounts, committedSellAmounts, resourceExposure, myRooms, ownSellResources) {
    var op = Memory.marketArbitrage.accountOp;

    // -- Sell if ready --
    if (op && op.state === 'ready_to_sell') {
        var accountBalance = (Game.resources && Game.resources[op.resourceType]) || 0;
        var sellAmt = Math.min(op.amount, accountBalance);
        if (sellAmt <= 0) {
            console.log('[Arbitrage] Account resources gone (' + op.resourceType + '). Abandoning.');
            Memory.marketArbitrage.accountOp = null;
            op = null;
        } else {
            if (sellAmt < op.amount) {
                console.log('[Arbitrage] Account has ' + accountBalance + ' ' + op.resourceType +
                    ', expected ' + op.amount + '. Adjusting.');
                op.amount = sellAmt;
            }

            var buyOrder     = op.buyOrderId ? Game.market.getOrderById(op.buyOrderId) : null;
            var buyRemaining = buyOrder ? (buyOrder.remainingAmount || buyOrder.amount || 0) : 0;

            if (!buyOrder || buyRemaining <= 0) {
                console.log('[Arbitrage] Account buy order ' + (op.buyOrderId || 'none') + ' gone. Searching replacement...');
                var repls = (books.buysByRes[op.resourceType] || []).filter(function(o) {
                    return (o.remainingAmount || o.amount || 0) >= MIN_BUY_ORDER_AMOUNT &&
                           !(o.roomName && myRooms[o.roomName]);
                });

                var found = null;
                for (var ri = 0; ri < repls.length; ri++) {
                    var c = repls[ri];
                    var cEff = (c.remainingAmount || c.amount || 0) - (committedBuyAmounts[c.id] || 0);
                    if (cEff <= 0) continue;
                    if (c.price > op.sellPrice) { found = c; break; }
                }
                if (found) {
                    buyOrder = found;
                    buyRemaining = (found.remainingAmount || found.amount || 0) - (committedBuyAmounts[found.id] || 0);
                    op.buyOrderId = found.id;
                    op.buyPrice   = found.price;
                    op.profit = (found.price - op.sellPrice) * op.amount;
                    op.margin = op.sellPrice > 0 ? (found.price - op.sellPrice) / op.sellPrice : 0;
                    console.log('[Arbitrage] Account replacement: ' + found.id + ' @ ' + found.price);
                } else {
                    var holdAge = Game.time - op.tick;
                    if (holdAge >= BUFFER_TIMEOUT) {
                        console.log('[Arbitrage] Account hold timeout for ' + op.amount + ' ' +
                            op.resourceType + ' after ' + holdAge + ' ticks. Abandoning.');
                        Memory.marketArbitrage.accountOp = null;
                    } else {
                        console.log('[Arbitrage] No account buyer for ' + op.resourceType +
                            '. Holding (' + holdAge + '/' + BUFFER_TIMEOUT + ' ticks)...');
                    }
                    return;
                }
            }

            var dealAmt = Math.min(op.amount, buyRemaining);
            if (dealAmt <= 0) return;

            if (Game.market.deal(buyOrder.id, dealAmt) === OK) {
                op.state = 'pending_sell_verify';
                op.sellVerifyTick    = Game.time;
                op.sellVerifyOrderId = buyOrder.id;
                op.sellVerifyAmount  = dealAmt;
                op.prevSellBalance   = (Game.resources && Game.resources[op.resourceType]) || 0;
                committedBuyAmounts[buyOrder.id] = (committedBuyAmounts[buyOrder.id] || 0) + dealAmt;

                console.log('[Arbitrage] Account deal() OK sell ' + dealAmt + ' ' + op.resourceType +
                    ' @ ' + buyOrder.price + ' | Verifying...');
            } else {
                console.log('[Arbitrage] Account sell deal failed for ' + op.resourceType);
                op.buyOrderId = null;
            }
            return;
        }
    }

    // -- Scan for new account-resource opportunity --
    if (!op) {
        var opp = findAccountOpportunity(books, committedBuyAmounts, committedSellAmounts, resourceExposure, ownSellResources);
        if (!opp) return;

        var ghosts = Memory.marketArbitrage.ghostSellOrders;
        if (ghosts && ghosts[opp.sellOrder.id]) return;

        if (Game.market.deal(opp.sellOrder.id, opp.amount) === OK) {
            committedSellAmounts[opp.sellOrder.id] = (committedSellAmounts[opp.sellOrder.id] || 0) + opp.amount;
            committedBuyAmounts[opp.buyOrder.id]   = (committedBuyAmounts[opp.buyOrder.id] || 0) + opp.amount;
            resourceExposure[opp.resourceType]      = (resourceExposure[opp.resourceType] || 0) + opp.amount;

            Memory.marketArbitrage.accountOp = {
                state:           'pending_buy_verify',
                resourceType:    opp.resourceType,
                amount:          opp.amount,
                sellOrderId:     opp.sellOrder.id,
                sellPrice:       opp.sellOrder.price,
                buyOrderId:      opp.buyOrder.id,
                buyPrice:        opp.buyOrder.price,
                profit:          opp.profit,
                margin:          opp.margin,
                buyVerifyTick:   Game.time,
                tick:            Game.time,
                prevBalance:     (Game.resources && Game.resources[opp.resourceType]) || 0
            };

            console.log('[Arbitrage] ACCOUNT BUY ' + opp.amount + ' ' + opp.resourceType +
                ' @ ' + opp.sellOrder.price +
                ' -> sell @ ' + opp.buyOrder.price +
                ' | Profit: ' + opp.profit.toFixed(2) + ' (' + (opp.margin * 100).toFixed(1) + '%)' +
                ' | Verifying buy...');
        } else {
            console.log('[Arbitrage] Account buy deal failed for ' + opp.resourceType);
        }
    }
}

// -----------------------------------------------------------------------------
// State-Machine Processing
// -----------------------------------------------------------------------------

/**
 * Move op to buffered array, freeing the terminal for new arb deals.
 * Stores costBasis (purchase price + buy-leg energy per unit) so the buffer
 * profitability check uses the true break-even floor, not just the credit price.
 */
function enterBuffered(op, ops, roomName) {
    delete ops[roomName];
    if (!Memory.marketArbitrage.buffered) Memory.marketArbitrage.buffered = [];

    if (typeof op.sellPrice !== 'number' || op.sellPrice <= 0) {
        console.log('[Arbitrage] enterBuffered: missing/invalid sellPrice for ' +
            op.resourceType + ' in ' + roomName + ' -- dropping entry to prevent loss sale.');
        return;
    }

    // costBasis carries the full cost per unit (credits + buy-leg energy).
    // Fall back to sellPrice for legacy ops that predate this field.
    var costBasis = (typeof op.costBasis === 'number' && op.costBasis >= op.sellPrice)
        ? op.costBasis
        : op.sellPrice;

    Memory.marketArbitrage.buffered.push({
        roomName: roomName, resourceType: op.resourceType,
        amount: op.amount, sellPrice: op.sellPrice,
        costBasis: costBasis,
        bufferedTick: Game.time
    });
    console.log('[Arbitrage] BUFFERED ' + op.amount + ' ' + op.resourceType +
        ' in ' + roomName + ' (paid ' + op.sellPrice.toFixed(3) +
        ', basis ' + costBasis.toFixed(3) +
        '). Watching for up to ' + BUFFER_TIMEOUT + ' ticks.');
}

/** Confirm initial buy arrived via incomingTransactions. Ghost -> clean up. */
function processPendingBuyVerify(terminal, op, ops, roomName) {
    var tx = findIncomingTx(roomName, op.resourceType, op.sellOrderId, op.buyVerifyTick);
    if (tx) {
        var actual = tx.amount;
        if (actual < op.amount) {
            console.log('[Arbitrage] Buy partial fill: expected ' + op.amount + ', got ' + actual + '. Adjusting.');
            op.amount = actual;
        }
        op.state = 'pending_sell';
        op.arrivedTick = Game.time;
        delete op.buyVerifyTick;
        console.log('[Arbitrage] Buy verified: ' + actual + ' ' + op.resourceType + ' in ' + roomName);
        return;
    }
    if (Game.time - op.buyVerifyTick >= VERIFY_TIMEOUT) {
        console.log('[Arbitrage] BUY GHOST in ' + roomName + ': ' + op.amount + ' ' +
            op.resourceType + ' -- no incoming transaction after ' + (Game.time - op.buyVerifyTick) +
            ' ticks. Cleaning up.');
        if (op.sellOrderId) {
            Memory.marketArbitrage.ghostSellOrders[op.sellOrderId] = Game.time;
        }
        delete ops[roomName];
    }
}

/** Confirm sell completed via outgoingTransactions. Ghost -> back to pending_sell. */
function processPendingVerify(terminal, op, ops, roomName) {
    var tx = findOutgoingTx(roomName, op.resourceType, op.verifyOrderId, op.verifyTick);
    if (tx) {
        var actual = tx.amount;
        console.log('[Arbitrage] VERIFIED sale of ' + actual + ' ' + op.resourceType +
            ' from ' + roomName + ' @ ' + (tx.order ? tx.order.price : '?') +
            ' -> ' + (tx.to || '?'));
        op.amount -= actual;
        if (op.amount <= 0) {
            console.log('[Arbitrage] Arbitrage complete in ' + roomName +
                '. Est. profit: ' + op.profit.toFixed(2) + ' (' + (op.margin * 100).toFixed(1) + '%)');
            delete ops[roomName];
        } else {
            op.state = 'pending_sell';
            delete op.verifyTick; delete op.verifyOrderId; delete op.verifyAmount;
            console.log('[Arbitrage] Partial verify, ' + op.amount + ' remaining in ' + roomName);
        }
        return;
    }
    if (Game.time - op.verifyTick >= VERIFY_TIMEOUT) {
        console.log('[Arbitrage] SELL GHOST in ' + roomName + ': ' + op.verifyAmount + ' ' +
            op.resourceType + ' -- no outgoing tx after ' + (Game.time - op.verifyTick) + ' ticks.');
        op.state = 'pending_sell';
        op.buyOrderId = null;
        delete op.verifyTick; delete op.verifyOrderId; delete op.verifyAmount;
    }
}

/**
 * Process buffered entries: verify pending deals, self-fulfill, or sell to buy orders.
 *
 * Profitability check uses costBasis (purchase price + buy-leg energy per unit)
 * as the floor, not just the raw purchase price. This ensures the sell-leg
 * proceeds cover both the original credit cost AND the energy already spent
 * receiving the goods.
 */
function processBufferedEntries(buffered, books, oppBuyRequests, myRooms, energyPrice, committedBuyAmounts) {
    for (var bi = buffered.length - 1; bi >= 0; bi--) {
        var buf = buffered[bi];
        var roomName = buf.roomName;
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal;
        if (!room || !terminal) continue;

        // -- Pending verification --
        if (buf.pendingVerify) {
            var tx = findOutgoingTx(roomName, buf.resourceType, buf.pendingVerify.orderId, buf.pendingVerify.tick);
            if (tx) {
                console.log('[Arbitrage] VERIFIED BUFFER sale of ' + tx.amount + ' ' +
                    buf.resourceType + ' from ' + roomName + ' @ ' + (tx.order ? tx.order.price : '?'));
                buf.amount -= tx.amount;
                delete buf.pendingVerify;
                if (buf.amount <= 0) { buffered.splice(bi, 1); console.log('[Arbitrage] Buffer fully sold in ' + roomName); }
            } else if (Game.time - buf.pendingVerify.tick >= VERIFY_TIMEOUT) {
                console.log('[Arbitrage] BUFFER ghost in ' + roomName + '. Retrying.');
                delete buf.pendingVerify;
            }
            continue;
        }

        if (terminal.cooldown > 0) continue;

        // Verify resources still present
        var store = terminal.store[buf.resourceType] || 0;
        if (store <= 0) {
            console.log('[Arbitrage] Buffered gone from ' + roomName + '. Removing.');
            buffered.splice(bi, 1); continue;
        }
        if (store < buf.amount) { buf.amount = store; }

        // Guard: if cost basis is missing or invalid, drop the entry rather than
        // risk selling at a loss.
        if (typeof buf.sellPrice !== 'number' || buf.sellPrice <= 0) {
            console.log('[Arbitrage] BUFFER dropping ' + buf.amount + ' ' + buf.resourceType +
                ' in ' + roomName + ' -- invalid sellPrice (' + buf.sellPrice + '). Cannot verify profitability.');
            buffered.splice(bi, 1); continue;
        }

        // costBasis is the true break-even floor (credits + buy-leg energy per unit).
        // Fall back to sellPrice for legacy entries that predate this field.
        var costBasis = (typeof buf.costBasis === 'number' && buf.costBasis >= buf.sellPrice)
            ? buf.costBasis
            : buf.sellPrice;

        var availEnergy = terminal.store[RESOURCE_ENERGY] || 0;

        // -- Self-fulfill --
        // Use sellPrice (not costBasis) for self-fulfill check: buy-leg energy is a
        // sunk cost, and if someone is paying maxPrice >= sellPrice we should send.
        var oppList = oppBuyRequests[buf.resourceType];
        var handled = false;
        if (oppList) {
            for (var oi = 0; oi < oppList.length; oi++) {
                var opp = oppList[oi];
                if (opp.roomName === roomName || buf.sellPrice > opp.maxPrice || opp.remaining <= 0) continue;
                var sfAmt = capByEnergy(Math.min(buf.amount, opp.remaining), roomName, opp.roomName, availEnergy, terminal);
                if (sfAmt <= 0) continue;
                if (terminal.send(buf.resourceType, sfAmt, opp.roomName) === OK) {
                    console.log('[Arbitrage] BUFFER self-fulfill ' + sfAmt + ' ' + buf.resourceType + ' -> ' + opp.roomName);
                    opp.remaining -= sfAmt;
                    if (Memory.opportunisticBuy && Memory.opportunisticBuy.requests && Memory.opportunisticBuy.requests[opp.key]) {
                        var or = Memory.opportunisticBuy.requests[opp.key];
                        or.fulfilled = (or.fulfilled || 0) + sfAmt; or.remaining -= sfAmt;
                        if (or.remaining <= 0) delete Memory.opportunisticBuy.requests[opp.key];
                    }
                    buf.amount -= sfAmt;
                    if (buf.amount <= 0) { buffered.splice(bi, 1); }
                    handled = true; break;
                }
            }
        }
        if (handled) continue;

        // -- Sell to buy order --
        var buys = books.buysByRes[buf.resourceType];
        if (!buys || !buys.length) continue;
        var bestBuy = null, bestBuyEff = 0;
        for (var bk = 0; bk < buys.length; bk++) {
            var c = buys[bk];
            var e = (c.remainingAmount || c.amount || 0) - (committedBuyAmounts[c.id] || 0);
            if (e > 0) { bestBuy = c; bestBuyEff = e; break; }
        }
        if (!bestBuy) continue;

        var fillAmt = Math.min(buf.amount, bestBuyEff);
        var fillE = calcEffectiveEnergyCost(fillAmt, roomName, bestBuy.roomName, terminal);
        var netRevenuePerUnit = bestBuy.price - (fillE * energyPrice / fillAmt);

        // Use costBasis as the floor so we account for both the purchase price
        // AND the energy already spent on the buy leg.
        var minAcceptable = costBasis * (1 + MIN_PROFIT_MARGIN);
        if (netRevenuePerUnit <= minAcceptable) continue;

        var minFill = Math.min(buf.amount, Math.max(Math.ceil(buf.amount * 0.5), 100));
        var capped = capByEnergy(fillAmt, roomName, bestBuy.roomName, availEnergy, terminal);
        if (capped < minFill) continue;

        if (Game.market.deal(bestBuy.id, capped, roomName) === OK) {
            buf.pendingVerify = { tick: Game.time, orderId: bestBuy.id, amount: capped, price: bestBuy.price };
            committedBuyAmounts[bestBuy.id] = (committedBuyAmounts[bestBuy.id] || 0) + capped;
            console.log('[Arbitrage] BUFFER deal() OK ' + capped + ' ' + buf.resourceType +
                ' -> ' + bestBuy.roomName + ' @ ' + bestBuy.price +
                ' (basis ' + costBasis.toFixed(3) + ') | Verifying...');
        }
    }
}

/**
 * Process pending_sell: self-fulfill check, then external sell via deal() -> pending_verify.
 *
 * PWR_OPERATE_TERMINAL: uses calcEffectiveEnergyCost for all energy calculations.
 */
function processPendingSell(terminal, op, ops, roomName, myRooms, energyPrice, oppBuyRequests, buysByRes) {
    if (terminal.cooldown > 0) return;
    var availEnergy = terminal.store[RESOURCE_ENERGY] || 0;

    // Verify resources present
    var store = terminal.store[op.resourceType] || 0;
    if (store <= 0) {
        console.log('[Arbitrage] Resources gone from ' + roomName + '. Aborting.');
        delete ops[roomName]; return;
    }
    if (store < op.amount) {
        console.log('[Arbitrage] Expected ' + op.amount + ' ' + op.resourceType + ' in ' + roomName + ', found ' + store + '. Adjusting.');
        op.amount = store;
    }

    // -- Self-fulfill (terminal.send -- no verification needed) --
    var oppList = oppBuyRequests[op.resourceType];
    if (oppList) {
        for (var oi = 0; oi < oppList.length; oi++) {
            var opp = oppList[oi];
            if (opp.roomName === roomName || op.sellPrice > opp.maxPrice) continue;
            var sfAmt = capByEnergy(Math.min(op.amount, opp.remaining), roomName, opp.roomName, availEnergy, terminal);
            if (sfAmt <= 0) continue;

            var sfE = calcEffectiveEnergyCost(sfAmt, roomName, opp.roomName, terminal);
            var sfVal = opp.maxPrice * sfAmt - sfE * energyPrice;
            var extVal = 0;
            if (op.buyOrderId) {
                var eo = Game.market.getOrderById(op.buyOrderId);
                if (eo && (eo.remainingAmount || eo.amount || 0) > 0) {
                    var ec = capByEnergy(Math.min(sfAmt, eo.remainingAmount || eo.amount), roomName, eo.roomName, availEnergy, terminal);
                    extVal = eo.price * ec - calcEffectiveEnergyCost(ec, roomName, eo.roomName, terminal) * energyPrice;
                }
            }
            if (sfVal * SELF_FULFILL_ADVANTAGE <= extVal) continue;

            if (terminal.send(op.resourceType, sfAmt, opp.roomName) === OK) {
                console.log('[Arbitrage] SELF-FULFILL ' + sfAmt + ' ' + op.resourceType +
                    ' -> ' + opp.roomName + ' (maxPrice ' + opp.maxPrice + ')');
                if (Memory.opportunisticBuy && Memory.opportunisticBuy.requests && Memory.opportunisticBuy.requests[opp.key]) {
                    var or = Memory.opportunisticBuy.requests[opp.key];
                    or.fulfilled = (or.fulfilled || 0) + sfAmt; or.remaining -= sfAmt;
                    if (or.remaining <= 0) { delete Memory.opportunisticBuy.requests[opp.key]; }
                }
                op.amount -= sfAmt;
                if (op.amount <= 0) { delete ops[roomName]; }
                return;
            }
        }
    }

    // -- External buy order --
    var buyOrder     = op.buyOrderId ? Game.market.getOrderById(op.buyOrderId) : null;
    var buyRemaining = buyOrder ? (buyOrder.remainingAmount || buyOrder.amount || 0) : 0;

    if (!buyOrder || buyRemaining <= 0) {
        console.log('[Arbitrage] Buy order ' + (op.buyOrderId || 'none') + ' gone. Searching replacement...');

        var repls = buysByRes[op.resourceType] || [];

        var found = null;
        for (var ri = 0; ri < repls.length; ri++) {
            var c = repls[ri];
            var cAmt = Math.min(op.amount, c.remainingAmount || c.amount || 0);
            var cE = calcEffectiveEnergyCost(cAmt, roomName, c.roomName, terminal);
            if (c.price * cAmt > op.sellPrice * cAmt + cE * energyPrice) { found = c; break; }
        }
        if (found) {
            buyOrder = found; buyRemaining = found.remainingAmount || found.amount || 0;
            op.buyOrderId = found.id; op.buyOrderRoom = found.roomName; op.buyPrice = found.price;
            console.log('[Arbitrage] Replacement: ' + found.id + ' @ ' + found.price + ' in ' + found.roomName);
        } else {
            // Fallback: self-fulfill or buffer
            if (oppList) {
                for (var fi = 0; fi < oppList.length; fi++) {
                    var fb = oppList[fi];
                    if (fb.roomName === roomName || op.sellPrice > fb.maxPrice) continue;
                    var fbAmt = capByEnergy(Math.min(op.amount, fb.remaining), roomName, fb.roomName, availEnergy, terminal);
                    if (fbAmt > 0 && terminal.send(op.resourceType, fbAmt, fb.roomName) === OK) {
                        console.log('[Arbitrage] FALLBACK self-fulfill ' + fbAmt + ' ' + op.resourceType + ' -> ' + fb.roomName);
                        if (Memory.opportunisticBuy && Memory.opportunisticBuy.requests && Memory.opportunisticBuy.requests[fb.key]) {
                            var fr = Memory.opportunisticBuy.requests[fb.key];
                            fr.fulfilled = (fr.fulfilled || 0) + fbAmt; fr.remaining -= fbAmt;
                            if (fr.remaining <= 0) delete Memory.opportunisticBuy.requests[fb.key];
                        }
                        op.amount -= fbAmt;
                        if (op.amount <= 0) { delete ops[roomName]; }
                        return;
                    }
                }
            }
            enterBuffered(op, ops, roomName);
            return;
        }
    }

    // Execute sell -> pending_verify
    var sellAmt = Math.min(op.amount, buyRemaining);
    var capped  = capByEnergy(sellAmt, roomName, buyOrder.roomName, availEnergy, terminal);
    if (capped <= 0) { console.log('[Arbitrage] Insufficient energy in ' + roomName + '.'); return; }

    if (Game.market.deal(buyOrder.id, capped, roomName) === OK) {
        op.state = 'pending_verify';
        op.verifyTick = Game.time; op.verifyOrderId = buyOrder.id; op.verifyAmount = capped;
        console.log('[Arbitrage] deal() OK ' + capped + ' ' + op.resourceType +
            ' -> ' + buyOrder.roomName + ' @ ' + buyOrder.price + ' | Verifying...');
    } else {
        console.log('[Arbitrage] Sell failed in ' + roomName);
        if (!buyOrder || (Game.market.getOrderById(buyOrder.id) === null)) op.buyOrderId = null;
    }
}

// -----------------------------------------------------------------------------
// Adaptive Scan Interval
// -----------------------------------------------------------------------------

function adaptScanInterval() {
    if (Game.time % 100 !== 0) return;
    if (!Memory.cpuStats || !Memory.cpuStats.history || Memory.cpuStats.history.length === 0) return;

    var history = Memory.cpuStats.history;
    var avg = history.reduce(function(sum, val) { return sum + val; }, 0) / history.length;

    var prev = SCAN_INTERVAL;
    if (avg < CPU_TARGET) {
        SCAN_INTERVAL = Math.max(MIN_SCAN_INTERVAL, SCAN_INTERVAL - 1);
    } else if (avg > CPU_TARGET) {
        SCAN_INTERVAL = Math.min(MAX_SCAN_INTERVAL, SCAN_INTERVAL + 1);
    }

    if (SCAN_INTERVAL !== prev) {
        Memory.marketArbitrage.scanInterval = SCAN_INTERVAL;
        console.log('[Arbitrage] Adaptive scan: CPU avg ' + avg.toFixed(1) +
            ' -> SCAN_INTERVAL ' + prev + ' -> ' + SCAN_INTERVAL);
    }
}

// -----------------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------------

function run() {
    if (!ENABLED) return;

    if (!Memory.marketArbitrage) Memory.marketArbitrage = { operations: {}, buffered: [], selfArbPending: {}, accountOp: null };
    if (!Memory.marketArbitrage.selfArbPending) Memory.marketArbitrage.selfArbPending = {};
    if (Memory.marketArbitrage.accountOp === undefined) Memory.marketArbitrage.accountOp = null;
    var ops = Memory.marketArbitrage.operations;

    adaptScanInterval();

    var isScanTick = (Game.time % SCAN_INTERVAL === 0);

    // -- INTER-SCAN: only process pending_sell terminals with cooldown cleared --
    if (!isScanTick) {
        for (var psRoom in ops) {
            var psOp = ops[psRoom];
            if (!psOp || psOp.state !== 'pending_sell') continue;
            var psTermRoom = Game.rooms[psRoom];
            var psTerminal = psTermRoom && psTermRoom.terminal;
            if (!psTerminal || psTerminal.cooldown > 0) continue;
            processPendingSell(psTerminal, psOp, ops, psRoom, _cachedMyRooms, _cachedEnergyPrice, _cachedOppBuyRequests, _cachedBuysByRes);
        }
        return;
    }

    // -- SCAN TICK: full processing --
    var myRooms = getMyRooms();
    var energyPrice = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);

    var terminals = [];
    for (var rn in Game.rooms) {
        var room = Game.rooms[rn];
        if (room.controller && room.controller.my && room.controller.level >= 6 && room.terminal)
            terminals.push(room.terminal);
    }

    // -- Clear per-scan caches --
    _historyCache = {};

    // -- Build shared data structures ONCE for the entire scan --
    var oppBuyRequests = getOppBuyRequests();
    var books = buildOrderBooks(myRooms, oppBuyRequests);

    // -- Update module-level caches for inter-scan active operation processing --
    _cachedBuysByRes = books.buysByRes;
    _cachedOppBuyRequests = oppBuyRequests;
    _cachedEnergyPrice = energyPrice;
    _cachedMyRooms = myRooms;

    // -- Build committed buy amounts ONCE (shared by self-arb and all passes) --
    var buffered = Memory.marketArbitrage.buffered || [];
    var committedBuyAmounts = {};
    for (var opRoom in ops) {
        var aOp = ops[opRoom];
        if (!aOp) continue;
        if (aOp.state === 'pending_verify' && aOp.verifyOrderId) {
            committedBuyAmounts[aOp.verifyOrderId] = (committedBuyAmounts[aOp.verifyOrderId] || 0) + aOp.amount;
        } else if (aOp.buyOrderId) {
            committedBuyAmounts[aOp.buyOrderId] = (committedBuyAmounts[aOp.buyOrderId] || 0) + aOp.amount;
        }
    }
    for (var bv = 0; bv < buffered.length; bv++) {
        if (buffered[bv].pendingVerify && buffered[bv].pendingVerify.orderId) {
            var pvId = buffered[bv].pendingVerify.orderId;
            committedBuyAmounts[pvId] = (committedBuyAmounts[pvId] || 0) + buffered[bv].pendingVerify.amount;
        }
    }
    var selfPending = Memory.marketArbitrage.selfArbPending;
    for (var spRoom in selfPending) {
        var sp = selfPending[spRoom];
        if (sp && sp.buyOrderId) {
            committedBuyAmounts[sp.buyOrderId] = (committedBuyAmounts[sp.buyOrderId] || 0) + sp.amount;
        }
    }
    var accountOp = Memory.marketArbitrage.accountOp;
    if (accountOp) {
        if (accountOp.buyOrderId) {
            committedBuyAmounts[accountOp.buyOrderId] = (committedBuyAmounts[accountOp.buyOrderId] || 0) + accountOp.amount;
        }
    }

    // -- PASS 1: process active operations --
    var idleTerminals = [];

    for (var t = 0; t < terminals.length; t++) {
        var terminal = terminals[t];
        var roomName = terminal.room.name;
        var op = ops[roomName];

        if (op) {
            // Legacy migration
            if (op.state === 'pending_buy') {
                op.state = 'pending_buy_verify'; op.buyVerifyTick = op.tick || Game.time;
            }
            if (op.state === 'pending_buy_verify')  processPendingBuyVerify(terminal, op, ops, roomName);
            else if (op.state === 'pending_verify') processPendingVerify(terminal, op, ops, roomName);
            else if (op.state === 'pending_sell')   processPendingSell(terminal, op, ops, roomName, myRooms, energyPrice, oppBuyRequests, books.buysByRes);
        } else if (terminal.cooldown <= 0) {
            idleTerminals.push(terminal);
        }
    }

    // -- PASS 1a: verify account-level operation --
    processAccountOpVerify();

    // -- Buffer timeouts --
    buffered = Memory.marketArbitrage.buffered;
    if (buffered) {
        for (var bt = buffered.length - 1; bt >= 0; bt--) {
            var b = buffered[bt];
            if (b.pendingVerify) continue;
            var age = Game.time - (b.bufferedTick || 0);
            if (age >= BUFFER_TIMEOUT) {
                var price = marketSeller.computePrice(b.resourceType);
                if (price < 0.001) price = 0.001;
                // Use costBasis as break-even floor (includes buy-leg energy cost)
                var costBasisFloor = (typeof b.costBasis === 'number' && b.costBasis >= b.sellPrice)
                    ? b.costBasis
                    : b.sellPrice;
                var breakEven = costBasisFloor * 1.05;
                if (price < breakEven) price = breakEven;
                var res = marketSeller.marketSell(b.roomName, b.resourceType, b.amount, price);
                console.log('[Arbitrage] BUFFER TIMEOUT ' + b.amount + ' ' + b.resourceType + ' in ' + b.roomName + ' after ' + age + ' ticks. ' + res);
                buffered.splice(bt, 1);
            }
        }
    }

    // -- PASS 1.5: Self-arbitrage on own sell orders --
    var usedTerminals = {};
    processOwnSellOrders(energyPrice, myRooms, committedBuyAmounts, books.buysByRes, oppBuyRequests, usedTerminals);

    // -- PASS 2: unified scan --

    var committedSellAmounts = {};
    for (var csRoom in ops) {
        var csOp = ops[csRoom];
        if (!csOp || !csOp.sellOrderId) continue;
        if (csOp.state === 'pending_buy_verify') {
            committedSellAmounts[csOp.sellOrderId] = (committedSellAmounts[csOp.sellOrderId] || 0) + csOp.amount;
        }
    }
    if (accountOp && accountOp.sellOrderId && accountOp.state === 'pending_buy_verify') {
        committedSellAmounts[accountOp.sellOrderId] = (committedSellAmounts[accountOp.sellOrderId] || 0) + accountOp.amount;
    }

    var resourceExposure = {};
    for (var exRoom in ops) {
        var exOp = ops[exRoom];
        if (exOp && exOp.resourceType) {
            resourceExposure[exOp.resourceType] = (resourceExposure[exOp.resourceType] || 0) + exOp.amount;
        }
    }
    var bufferedResources = {};
    for (var exBuf = 0; exBuf < buffered.length; exBuf++) {
        var eb = buffered[exBuf];
        if (eb && eb.resourceType) {
            resourceExposure[eb.resourceType] = (resourceExposure[eb.resourceType] || 0) + eb.amount;
            bufferedResources[eb.resourceType] = true;
        }
    }
    if (accountOp && accountOp.resourceType) {
        resourceExposure[accountOp.resourceType] = (resourceExposure[accountOp.resourceType] || 0) + accountOp.amount;
    }

    // 2a: buffered
    var hasBuffered = buffered && buffered.length > 0;
    if (hasBuffered) processBufferedEntries(buffered, books, oppBuyRequests, myRooms, energyPrice, committedBuyAmounts);

    // Clean up expired ghost sell order blacklist entries
    var ghosts = Memory.marketArbitrage.ghostSellOrders;
    if (ghosts) {
        for (var gId in ghosts) {
            if (Game.time - ghosts[gId] > GHOST_SELL_COOLDOWN) delete ghosts[gId];
        }
    }

    // 2b: account-level resource arbitrage
    var ownSellResources = getOwnSellResources();
    processAccountOpSellAndScan(books, committedBuyAmounts, committedSellAmounts, resourceExposure, myRooms, ownSellResources);

    // 2c: new terminal opportunities -- sorted by profitability
    var activeResourceTypes = {};
    for (var arRoom in ops) {
        if (ops[arRoom] && ops[arRoom].resourceType) {
            activeResourceTypes[ops[arRoom].resourceType] = true;
        }
    }

    var scoredIdle = [];
    for (var si = 0; si < idleTerminals.length; si++) {
        var sTerm = idleTerminals[si];
        var sOpp = findBestOpportunity(
            sTerm, books, energyPrice, committedBuyAmounts, committedSellAmounts,
            idleTerminals.length, resourceExposure, bufferedResources, ownSellResources, activeResourceTypes, oppBuyRequests
        );
        scoredIdle.push({ terminal: sTerm, opp: sOpp, profit: sOpp ? sOpp.profit : -1 });
    }
    scoredIdle.sort(function (a, b) { return b.profit - a.profit; });

    var remainingIdle = scoredIdle.length;
    var needsReeval = false;
    for (var i = 0; i < scoredIdle.length; i++) {
        var scored = scoredIdle[i];
        var term   = scored.terminal;
        var tRoom  = term.room.name;

        var opp = needsReeval
            ? findBestOpportunity(term, books, energyPrice, committedBuyAmounts, committedSellAmounts,
                  remainingIdle, resourceExposure, bufferedResources, ownSellResources, activeResourceTypes, oppBuyRequests)
            : scored.opp;
        needsReeval = false;

        if (!opp) {
            // No profitable arb -- try a floor sweep (buy cheap, buffer, sell later).
            // findFloorSweepOpportunity verifies a realistic exit exists accounting
            // for full cost basis (purchase price + buy-leg energy at ~28 cr/energy).
            var sweepOpp = findFloorSweepOpportunity(
                term, books, energyPrice, committedSellAmounts, resourceExposure,
                bufferedResources, ownSellResources, activeResourceTypes
            );
            if (sweepOpp && !(ghosts && ghosts[sweepOpp.sellOrder.id])) {
                if (Game.market.deal(sweepOpp.sellOrder.id, sweepOpp.amount, tRoom) === OK) {
                    committedSellAmounts[sweepOpp.sellOrder.id] = (committedSellAmounts[sweepOpp.sellOrder.id] || 0) + sweepOpp.amount;
                    resourceExposure[sweepOpp.resourceType]      = (resourceExposure[sweepOpp.resourceType] || 0) + sweepOpp.amount;

                    ops[tRoom] = {
                        state:         'pending_buy_verify',
                        resourceType:  sweepOpp.resourceType,
                        amount:        sweepOpp.amount,
                        sellOrderId:   sweepOpp.sellOrder.id,
                        sellOrderRoom: sweepOpp.sellOrder.roomName,
                        sellPrice:     sweepOpp.sellOrder.price,
                        costBasis:     sweepOpp.costBasis,
                        buyOrderId:    null,
                        buyOrderRoom:  null,
                        buyPrice:      0,
                        profit:        0,
                        margin:        0,
                        buyEnergy:     sweepOpp.buyEnergy,
                        sellEnergy:    0,
                        buyVerifyTick: Game.time,
                        tick:          Game.time,
                        isFloorSweep:  true
                    };

                    activeResourceTypes[sweepOpp.resourceType] = true;
                    needsReeval = true;

                    console.log('[Arbitrage] FLOOR SWEEP ' + sweepOpp.amount + ' ' + sweepOpp.resourceType +
                        ' from ' + sweepOpp.sellOrder.roomName + ' @ ' + sweepOpp.sellOrder.price +
                        ' cr | Basis: ' + sweepOpp.costBasis.toFixed(3) +
                        ' cr/unit (incl. ' + sweepOpp.buyEnergy + ' energy)' +
                        ' | Room: ' + tRoom + ' | Verifying buy...');
                } else {
                    console.log('[Arbitrage] Floor sweep deal failed in ' + tRoom + ' for ' + sweepOpp.resourceType);
                }
            }
            remainingIdle--; continue;
        }

        if (ghosts && ghosts[opp.sellOrder.id]) { remainingIdle--; continue; }

        if (Game.market.deal(opp.sellOrder.id, opp.amount, tRoom) === OK) {
            committedSellAmounts[opp.sellOrder.id] = (committedSellAmounts[opp.sellOrder.id] || 0) + opp.amount;
            if (opp.buyOrder) committedBuyAmounts[opp.buyOrder.id] = (committedBuyAmounts[opp.buyOrder.id] || 0) + opp.amount;
            resourceExposure[opp.resourceType] = (resourceExposure[opp.resourceType] || 0) + opp.amount;

            ops[tRoom] = {
                state: 'pending_buy_verify', resourceType: opp.resourceType,
                amount: opp.amount, sellOrderId: opp.sellOrder.id, sellOrderRoom: opp.sellOrder.roomName,
                sellPrice: opp.sellOrder.price,
                // Full cost basis: purchase price + buy-leg energy per unit
                costBasis: opp.sellOrder.price + (opp.buyEnergy * energyPrice / opp.amount),
                buyOrderId: opp.buyOrder ? opp.buyOrder.id : null,
                buyOrderRoom: opp.buyOrder ? opp.buyOrder.roomName : null,
                buyPrice: opp.buyOrder ? opp.buyOrder.price : 0,
                profit: opp.profit, margin: opp.margin,
                buyEnergy: opp.buyEnergy, sellEnergy: opp.sellEnergy,
                buyVerifyTick: Game.time, tick: Game.time
            };

            activeResourceTypes[opp.resourceType] = true;
            needsReeval = true;

            var totalCommitted = committedSellAmounts[opp.sellOrder.id];
            var splitTag = totalCommitted > opp.amount
                ? ' | Split: ' + opp.amount + '/' + opp.sellOrder.amount + ' (committed: ' + totalCommitted + ')'
                : '';

            console.log('[Arbitrage] BUY ' + opp.amount + ' ' + opp.resourceType +
                ' from ' + opp.sellOrder.roomName + ' @ ' + opp.sellOrder.price +
                ' -> sell to ' + opp.buyOrder.roomName + ' @ ' + opp.buyOrder.price +
                ' | Profit: ' + opp.profit.toFixed(2) + ' (' + (opp.margin * 100).toFixed(1) + '%)' +
                ' | Energy: ' + opp.buyEnergy + '+' + opp.sellEnergy +
                ' | Room: ' + tRoom + splitTag + ' | Verifying buy...');
        } else {
            console.log('[Arbitrage] Buy deal failed in ' + tRoom + ' for ' + opp.resourceType);
        }
        remainingIdle--;
    }
}

// -----------------------------------------------------------------------------
// Console helpers
// -----------------------------------------------------------------------------

function status() {
    if (!Memory.marketArbitrage) { var m = '[Arbitrage] No operations.'; console.log(m); return m; }
    var ops = Memory.marketArbitrage.operations || {};
    var buffered = Memory.marketArbitrage.buffered || [];
    var selfPending = Memory.marketArbitrage.selfArbPending || {};
    var accountOp = Memory.marketArbitrage.accountOp;
    var out = '[Arbitrage] Status: ' + (ENABLED ? 'ENABLED' : 'DISABLED') + '\nActive operations:\n';
    var count = 0;

    for (var room in ops) {
        var op = ops[room];
        var age = Game.time - op.tick;
        var st = op.state;
        if (op.isFloorSweep) st += ' [SWEEP]';
        if (op.state === 'pending_verify') st += ' (sell ' + op.verifyAmount + ', ' + (Game.time - op.verifyTick) + 't ago)';
        else if (op.state === 'pending_buy_verify') st += ' (buy ' + op.amount + ', ' + (Game.time - op.buyVerifyTick) + 't ago)';
        var basisStr = (typeof op.costBasis === 'number') ? ' basis@' + op.costBasis.toFixed(3) : '';
        out += '  ' + room + ': ' + st + ' | ' + op.amount + ' ' + op.resourceType +
            ' | paid@' + op.sellPrice.toFixed(3) + basisStr + ' -> sell@' + (op.buyPrice || 0).toFixed(3) +
            ' | profit: ' + op.profit.toFixed(2) + ' (' + (op.margin * 100).toFixed(1) + '%)' +
            ' | age: ' + age + 't\n';
        count++;
    }
    if (accountOp) {
        var aAge = Game.time - accountOp.tick;
        var aSt = accountOp.state;
        if (accountOp.state === 'pending_buy_verify') aSt += ' (buy ' + accountOp.amount + ', ' + (Game.time - accountOp.buyVerifyTick) + 't ago)';
        else if (accountOp.state === 'pending_sell_verify') aSt += ' (sell ' + accountOp.sellVerifyAmount + ', ' + (Game.time - accountOp.sellVerifyTick) + 't ago)';
        else if (accountOp.state === 'ready_to_sell') aSt += ' (holding ' + accountOp.amount + ')';
        out += '\nAccount resource op:\n';
        out += '  [ACCOUNT] ' + aSt + ' | ' + accountOp.amount + ' ' + accountOp.resourceType +
            ' | buy@' + accountOp.sellPrice.toFixed(3) + ' -> sell@' + (accountOp.buyPrice || 0).toFixed(3) +
            ' | profit: ' + accountOp.profit.toFixed(2) + ' (' + (accountOp.margin * 100).toFixed(1) + '%)' +
            ' | age: ' + aAge + 't\n';
        count++;
    }
    if (buffered.length > 0) {
        out += '\nBuffered:\n';
        for (var bi = 0; bi < buffered.length; bi++) {
            var buf = buffered[bi];
            var bAge = Game.time - (buf.bufferedTick || 0);
            var vTag = buf.pendingVerify ? ' [VERIFYING ' + buf.pendingVerify.amount + ' @ ' + buf.pendingVerify.price + ']' : '';
            var basisTag = (typeof buf.costBasis === 'number' && buf.costBasis > buf.sellPrice)
                ? ' basis@' + buf.costBasis.toFixed(3) : '';
            out += '  ' + buf.roomName + ': ' + buf.amount + ' ' + buf.resourceType +
                ' | paid@' + buf.sellPrice.toFixed(3) + basisTag + ' | ' + bAge + '/' + BUFFER_TIMEOUT + 't' + vTag + '\n';
            count++;
        }
    }
    var selfCount = 0;
    for (var sr in selfPending) {
        if (!selfCount) out += '\nSelf-arb pending:\n';
        var sp = selfPending[sr];
        var spAge = Game.time - sp.tick;
        out += '  ' + sr + ': ' + sp.amount + ' ' + sp.resourceType +
            ' | own@' + sp.ourSellPrice.toFixed(3) + ' -> ext@' + sp.buyPrice.toFixed(3) +
            ' | ' + spAge + 't ago\n';
        selfCount++; count++;
    }
    if (count === 0) out += '  (none)\n';
    out += '\nConfig: enabled=' + ENABLED + ', margin=' + (MIN_PROFIT_MARGIN * 100) + '%, minBuy=' + MIN_BUY_ORDER_AMOUNT +
        ', scan=' + SCAN_INTERVAL + ', bufTimeout=' + BUFFER_TIMEOUT + ', verifyTimeout=' + VERIFY_TIMEOUT +
        ', acctVerifyTimeout=' + ACCOUNT_VERIFY_TIMEOUT +
        ', maxExposure=' + MAX_RESOURCE_EXPOSURE + ', minSelfArbProfit=' + MIN_SELF_ARB_PROFIT +
        ', selfFulfillAdvantage=' + (SELF_FULFILL_ADVANTAGE * 100).toFixed(0) + '%' +
        ', floorSweepPrice=' + FLOOR_SWEEP_PRICE +
        ', floorSweepBanned=[' + Object.keys(FLOOR_SWEEP_BANNED).join(',') + ']';
    console.log(out); return out;
}

function cancel(roomName) {
    if (!Memory.marketArbitrage) return '[Arbitrage] Nothing to cancel.';
    if (Memory.marketArbitrage.operations && Memory.marketArbitrage.operations[roomName]) {
        var op = Memory.marketArbitrage.operations[roomName];
        delete Memory.marketArbitrage.operations[roomName];
        var m = '[Arbitrage] Cancelled ' + roomName + ' (' + op.amount + ' ' + op.resourceType + ' ' + op.state + ')';
        console.log(m); return m;
    }
    if (Memory.marketArbitrage.selfArbPending && Memory.marketArbitrage.selfArbPending[roomName]) {
        var sp = Memory.marketArbitrage.selfArbPending[roomName];
        delete Memory.marketArbitrage.selfArbPending[roomName];
        var m3 = '[Arbitrage] Cancelled self-arb pending ' + sp.amount + ' ' + sp.resourceType + ' in ' + roomName;
        console.log(m3); return m3;
    }
    var buf = Memory.marketArbitrage.buffered || [];
    for (var i = buf.length - 1; i >= 0; i--) {
        if (buf[i].roomName === roomName) {
            var b = buf[i]; buf.splice(i, 1);
            var m2 = '[Arbitrage] Cancelled buffered ' + b.amount + ' ' + b.resourceType + ' in ' + roomName;
            console.log(m2); return m2;
        }
    }
    return '[Arbitrage] No op in ' + roomName;
}

function cancelAccount() {
    if (!Memory.marketArbitrage || !Memory.marketArbitrage.accountOp) {
        var m = '[Arbitrage] No active account operation.';
        console.log(m); return m;
    }
    var op = Memory.marketArbitrage.accountOp;
    Memory.marketArbitrage.accountOp = null;
    var m2 = '[Arbitrage] Cancelled account op: ' + op.amount + ' ' + op.resourceType + ' (' + op.state + ')';
    console.log(m2); return m2;
}

function setEnabled(v) {
    ENABLED = !!v;
    var m = '[Arbitrage] ' + (ENABLED ? 'ENABLED' : 'DISABLED');
    console.log(m); return m;
}

function setMargin(v) {
    if (typeof v !== 'number' || v < 0 || v > 1) return '[Arbitrage] Must be 0-1';
    MIN_PROFIT_MARGIN = v;
    var m = '[Arbitrage] Margin set to ' + (v * 100).toFixed(1) + '%'; console.log(m); return m;
}

function setMinBuyAmount(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be >= 1';
    MIN_BUY_ORDER_AMOUNT = v;
    var m = '[Arbitrage] Min buy amount set to ' + v; console.log(m); return m;
}

function setBufferTimeout(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be >= 1';
    BUFFER_TIMEOUT = v;
    var m = '[Arbitrage] Buffer timeout set to ' + v + ' ticks'; console.log(m); return m;
}

function setMaxExposure(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be >= 1';
    MAX_RESOURCE_EXPOSURE = v;
    var m = '[Arbitrage] Max resource exposure set to ' + v; console.log(m); return m;
}

function setMinSelfArbProfit(v) {
    if (typeof v !== 'number' || v < 0) return '[Arbitrage] Must be >= 0';
    MIN_SELF_ARB_PROFIT = v;
    var m = '[Arbitrage] Min self-arb profit set to ' + v; console.log(m); return m;
}

function setSelfFulfillAdvantage(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be >= 1.0 (1.0 = no advantage)';
    SELF_FULFILL_ADVANTAGE = v;
    var m = '[Arbitrage] Self-fulfill advantage set to ' + (v * 100).toFixed(0) + '%'; console.log(m); return m;
}

function setFloorSweepPrice(v) {
    if (typeof v !== 'number' || v < 0) return '[Arbitrage] Must be >= 0 (0 = disabled)';
    FLOOR_SWEEP_PRICE = v;
    var m = '[Arbitrage] Floor sweep price set to ' + v + ' cr' + (v === 0 ? ' (disabled)' : '');
    console.log(m); return m;
}

function setFloorSweepDebug(v) {
    FLOOR_SWEEP_DEBUG = !!v;
    var m = '[Arbitrage] Floor sweep debug ' + (FLOOR_SWEEP_DEBUG ? 'ENABLED' : 'DISABLED');
    console.log(m); return m;
}

function addFloorSweepBan(resource) {
    if (typeof resource !== 'string' || !resource) return '[Arbitrage] Must be a resource type string';
    FLOOR_SWEEP_BANNED[resource] = true;
    var m = '[Arbitrage] Floor sweep ban added: ' + resource + ' (banned: ' + Object.keys(FLOOR_SWEEP_BANNED).join(', ') + ')';
    console.log(m); return m;
}

function removeFloorSweepBan(resource) {
    if (!FLOOR_SWEEP_BANNED[resource]) return '[Arbitrage] ' + resource + ' is not banned';
    delete FLOOR_SWEEP_BANNED[resource];
    var m = '[Arbitrage] Floor sweep ban removed: ' + resource + ' (remaining: ' + (Object.keys(FLOOR_SWEEP_BANNED).join(', ') || 'none') + ')';
    console.log(m); return m;
}

module.exports = {
    run: run, status: status, cancel: cancel, cancelAccount: cancelAccount,
    setEnabled: setEnabled,
    setMargin: setMargin, setMinBuyAmount: setMinBuyAmount,
    setBufferTimeout: setBufferTimeout, setMaxExposure: setMaxExposure,
    setMinSelfArbProfit: setMinSelfArbProfit, setSelfFulfillAdvantage: setSelfFulfillAdvantage,
    setFloorSweepPrice: setFloorSweepPrice, setFloorSweepDebug: setFloorSweepDebug,
    addFloorSweepBan: addFloorSweepBan, removeFloorSweepBan: removeFloorSweepBan
};