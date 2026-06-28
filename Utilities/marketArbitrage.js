/**
 * Market Arbitrage Module
 *
 * Scans for profitable buy-sell spreads: buys resources cheaply from sell orders,
 * waits for terminal cooldown, then immediately sells to open buy orders at a profit.
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
 *   marketArbitrage.setMinBuyOrderPrice(10) -- change min buy-order price per unit
 *   marketArbitrage.setMinArbBuyVolume(49) -- change min total buy depth for arb candidates
 *   marketArbitrage.setBufferTimeout(10000) -- change buffer hold duration
 *   marketArbitrage.setSelfFulfillAdvantage(1.5) -- change self-fulfill bias (1.0 = no bias)
 *   marketArbitrage.setFloorSweepPrice(0.5) -- buy anything at or below this price (0 = disabled)
 *
 */

var marketBuyer  = require('marketBuy');
var marketSeller = require('marketSell');
var pricing      = require('marketPricing');

// === CONFIGURATION ===
var ENABLED              = true;    // Set to false to suspend all arbitrage activity
var SCAN_INTERVAL        = 6;       // Ticks between scans for opportunities (adaptive)
var MIN_SCAN_INTERVAL    = 2;       // Floor for adaptive scan interval
var MAX_SCAN_INTERVAL    = 100;     // Ceiling for adaptive scan interval
var CPU_TARGET           = 18;      // Target CPU average -- interval adjusts around this
var MIN_PROFIT_MARGIN    = 0.005;   // Minimum profit over total cost
var MIN_BUY_ORDER_AMOUNT = 6;       // Filter out likely-scam buy orders below this size
var MIN_BUY_ORDER_PRICE  = 10;      // Ignore buy orders below this price per unit
var MAX_SELLS_PER_RESOURCE = 10;    // CPU guard: only inspect top N cheapest sells per resource
var BUFFER_TIMEOUT       = 50000;   // Ticks to hold buffered resources before falling back to marketSell
var VERIFY_TIMEOUT       = 6;       // Ticks to wait for transaction confirmation (3 scan cycles)
var ACCOUNT_VERIFY_TIMEOUT = 3;     // Account resources verify faster (no terminal involved)
var MIN_AMOUNT_PER_TERMINAL = 500;  // Minimum share per terminal when splitting
var MAX_RESOURCE_EXPOSURE = 50000;  // Max total units of one resource in-flight across ALL terminals + buffered
var BUY_DEPTH = 3;                  // Number of top buyers to consider for depth-aware sizing/staged selling
var MIN_ARB_BUY_VOLUME = 49;        // Minimum total buy depth (sum of top BUY_DEPTH buyers) for a candidate to be considered

var GHOST_SELL_COOLDOWN   = 100;    // Ticks to blacklist a sell order after a buy ghost

// Grouped-logging tuning
var SELL_GHOST_FAIL_THRESHOLD = 3;  // mark a group member as failed after this many sell-verify ghosts
var GROUP_STALE_TICKS         = 200; // warn if a group hasn't fully resolved within this many ticks

// Resources restricted to a single terminal at a time to avoid low-value split trades
var SINGLE_TERMINAL_RESOURCES = { ops: true };

var MIN_SELF_ARB_PROFIT   = 1;      // Minimum absolute credit profit for self-arb (filters dust)

var SELF_FULFILL_ADVANTAGE = 1.25;

var FLOOR_SWEEP_PRICE = 7;

var FLOOR_SWEEP_BANNED = { Z: true, zynthium: true, ops: true};

var FLOOR_SWEEP_DEBUG = false;

var ACCOUNT_RESOURCES = { pixel: true, cpuUnlock: true, accessKey: true };


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
// groups: { groupKey -> { ... } } -- tracks split arbitrage operations for aggregated logging.
// See module header comment for structure and lifecycle.
if (!Memory.marketArbitrage.groups) {
    Memory.marketArbitrage.groups = {};
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
 *   [0.9, 0.7, 0.5, 0.35, 0.2] -> 10% to 80% reduction at levels 1-5.
 *   (90% to 20% of base cost, indexed by power level 1-5)
 *
 * Game.market.calcTransactionCost() always returns the BASE (unpowered) cost,
 * so we must apply the multiplier ourselves to predict actual deal() cost.
 *
 * FIX (2025-06-02): effect.level is 1-5 (not 0-4), so we must use
 * effect[level - 1] to index the POWER_INFO.effect array.
 * Previously effect[level] caused an off-by-one error:
 *   - Level 1 read effect[1]=0.7 instead of effect[0]=0.9
 *   - Level 5 read effect[5]=undefined, falling back to base (no reduction)
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
// Game.market.calcTransactionCost(amount, from, to) == ceil(amount * (1 - exp(-dist/30)))
// where dist = Game.map.getRoomLinearDistance(from, to, true).
// Room distances never change, so this cache is heap-persistent across ticks/scans.
var _costFactorCache = {};

function getCostFactor(fromRoom, toRoom) {
    var key = fromRoom + '|' + toRoom;
    var f = _costFactorCache[key];
    if (f === undefined) {
        var dist = Game.map.getRoomLinearDistance(fromRoom, toRoom, true);
        f = 1 - Math.exp(-dist / 30);
        _costFactorCache[key] = f;
    }
    return f;
}

/**
 * Returns the PWR_OPERATE_TERMINAL cost multiplier for a terminal (1 = no reduction).
 *
 * FIX (2025-06-02): effect.level is 1-5 (not 0-4), so we must use
 * effect[level - 1] to index the POWER_INFO.effect array.
 *
 * Per-scan cache: terminal effects do not change within a tick, so cache the
 * multiplier by terminal id to avoid re-scanning effects on every energy cost
 * calculation.
 */
var _powerMultiplierCache = {};

function getPowerMultiplier(terminal) {
    if (!terminal || !terminal.effects) return 1;
    var id = terminal.id;
    if (id && _powerMultiplierCache[id] !== undefined) return _powerMultiplierCache[id];
    for (var i = 0; i < terminal.effects.length; i++) {
        var eff = terminal.effects[i];
        if (eff.effect === PWR_OPERATE_TERMINAL && eff.ticksRemaining > 0) {
            var info = (typeof POWER_INFO !== 'undefined') ? POWER_INFO[PWR_OPERATE_TERMINAL] : null;
            if (info && info.effect) {
                // CRITICAL FIX: effect.level is 1-indexed (1-5), but array is 0-indexed (0-4)
                var lvlIndex = eff.level - 1;
                if (lvlIndex < 0 || lvlIndex >= info.effect.length) {
                    if (id) _powerMultiplierCache[id] = 1;
                    return 1;
                }
                var effectValue = info.effect[lvlIndex];
                if (typeof effectValue === 'number') {
                    var mult = 1;
                    if (effectValue > 0 && effectValue < 1) {
                        // Multiplier format: 0.9 = 90% of base cost (10% reduction)
                        mult = effectValue;
                    } else if (effectValue >= 1 && effectValue <= 100) {
                        // Percentage format fallback: 10 = 10% reduction
                        mult = 1 - effectValue / 100;
                    }
                    if (id) _powerMultiplierCache[id] = mult;
                    return mult;
                }
            }
            if (id) _powerMultiplierCache[id] = 1;
            return 1;
        }
    }
    if (id) _powerMultiplierCache[id] = 1;
    return 1;
}

/**
 * Effective energy cost for a deal/send, accounting for PWR_OPERATE_TERMINAL.
 * Closed-form -- no Game.market.calcTransactionCost() call.
 */
function calcEffectiveEnergyCost(amount, fromRoom, toRoom, terminal) {
    if (amount <= 0) return 0;
    var base = Math.ceil(amount * getCostFactor(fromRoom, toRoom));
    var mult = getPowerMultiplier(terminal);
    return mult < 1 ? Math.ceil(base * mult) : base;
}

/**
 * Largest amount whose effective energy cost fits within energyAvail.
 * Closed-form estimate (inverted cost factor) with a small linear correction
 * for ceil() rounding -- replaces the old O(log n) binary search.
 */
function capByEnergy(desired, fromRoom, toRoom, energyAvail, terminal) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    var f = getCostFactor(fromRoom, toRoom) * getPowerMultiplier(terminal);
    if (f <= 0) return desired;
    var amt = Math.min(desired, Math.floor(energyAvail / f));
    while (amt > 0 && calcEffectiveEnergyCost(amt, fromRoom, toRoom, terminal) > energyAvail) amt--;
    return amt;
}

/**
 * Largest amount whose combined effective energy for BOTH legs fits within
 * energyAvail. Closed-form estimate with linear correction.
 */
function capByEnergyBothLegs(desired, ourRoom, sellRoom, buyRoom, energyAvail, terminal) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    var mult = getPowerMultiplier(terminal);
    var f = (getCostFactor(ourRoom, sellRoom) + getCostFactor(ourRoom, buyRoom)) * mult;
    if (f <= 0) return desired;
    var amt = Math.min(desired, Math.floor(energyAvail / f));
    while (amt > 0 &&
        (calcEffectiveEnergyCost(amt, ourRoom, sellRoom, terminal) +
         calcEffectiveEnergyCost(amt, ourRoom, buyRoom, terminal)) > energyAvail) amt--;
    return amt;
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
// Grouped-logging helpers
// -----------------------------------------------------------------------------

/**
 * Returns the number of group members that still need to reach the current
 * stage before the aggregate summary line for that stage can be printed.
 * (members minus anyone already recorded as failed)
 */
function groupExpectedCount(grp) {
    return grp.members.length - Object.keys(grp.failedRooms).length;
}

/**
 * Build the " | Failed: roomA(stage/reason,amount), roomB(...)" suffix for a
 * group summary line, or '' if nothing has failed.
 */
function groupFailedSuffix(grp) {
    var keys = Object.keys(grp.failedRooms);
    if (!keys.length) return '';
    return ' | Failed: ' + keys.map(function (r) {
        var f = grp.failedRooms[r];
        return r + '(' + f.stage + '/' + f.reason + ',' + f.amount + ')';
    }).join(', ');
}

/** Print the BUY CONFIRMED summary line for a group. */
function logBuyConfirmed(grp) {
    var total = 0;
    for (var r in grp.buyConfirmedRooms) total += grp.buyConfirmedRooms[r];
    console.log('[Arbitrage] BUY CONFIRMED ' + grp.resource + ' from ' + grp.sellRoom +
        ' | Total: ' + total + '/' + grp.totalAmount +
        ' across ' + Object.keys(grp.buyConfirmedRooms).length + ' rooms' +
        groupFailedSuffix(grp));
}

/** Print the SELL INITIATED summary line for a group. */
function logSellInitiated(grp) {
    var total = 0;
    for (var r in grp.sellInitRooms) total += grp.sellInitRooms[r];
    console.log('[Arbitrage] SELL INITIATED ' + grp.resource +
        ' | Total: ' + total + '/' + grp.totalAmount +
        ' -> (' + Object.keys(grp.sellRoomsActual).join(', ') + ')' +
        groupFailedSuffix(grp));
}

/** Print the SELL CONFIRMED summary line for a group. */
function logSellConfirmed(grp) {
    var totalAmt = 0, totalProfit = 0;
    for (var r in grp.sellConfirmedRooms) {
        totalAmt += grp.sellConfirmedRooms[r].amount;
        totalProfit += grp.sellConfirmedRooms[r].profit;
    }
    console.log('[Arbitrage] SELL CONFIRMED ' + grp.resource + ' -> ' + grp.buyRoom +
        ' | Total: ' + totalAmt + '/' + grp.totalAmount +
        ' | Realized Profit: ' + totalProfit.toFixed(2) +
        ' (' + (grp.margin * 100).toFixed(1) + '%)' +
        groupFailedSuffix(grp));
}

/**
 * Periodic watchdog: report groups that haven't fully resolved within
 * GROUP_STALE_TICKS, re-warning every 100 ticks thereafter, listing exactly
 * which rooms are still pending at which stage.
 */
function checkStaleGroups() {
    var groups = Memory.marketArbitrage.groups;
    if (!groups) return;
    for (var gk in groups) {
        var grp = groups[gk];
        var age = Game.time - grp.createdTick;
        if (age < GROUP_STALE_TICKS) continue;
        if ((age - GROUP_STALE_TICKS) % 100 !== 0) continue;

        var pendingBuy = [], pendingSell = [];
        for (var i = 0; i < grp.members.length; i++) {
            var rm = grp.members[i];
            if (grp.failedRooms[rm]) continue;
            if (!grp.buyConfirmedRooms[rm]) { pendingBuy.push(rm); continue; }
            if (!grp.sellConfirmedRooms[rm]) pendingSell.push(rm);
        }

        console.log('[Arbitrage] GROUP STALE (' + age + 't) ' + grp.resource + ' ' + grp.sellRoom + '->' + grp.buyRoom +
            (pendingBuy.length ? ' | Waiting on buy: (' + pendingBuy.join(', ') + ')' : '') +
            (pendingSell.length ? ' | Waiting on sell: (' + pendingSell.join(', ') + ')' : '') +
            groupFailedSuffix(grp));
    }
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
var _cachedOppBuyRequests = {};
var _cachedEnergyPrice = 0;
var _cachedMyRooms = {};
var _cachedBooks = null;

/**
 * Get the average-of-last-two-days price cap for a resource.
 * Uses a per-scan cache to avoid repeated getHistory() API calls.
 * @param {string} resource
 * @param {number} multiplier  -- e.g. 1.5 for normal, 1.0 for strict
 * @returns {number} maxBuyPrice (Infinity if no history and multiplier > 1)
 */
function getHistoryCap(resource, multiplier) {
    if (_historyCache[resource] === undefined) {
        // Use the shared per-tick history cache from marketPricing so
        // Game.market.getHistory(resource) is called at most once per resource
        // per tick across both modules. _historyCache still memoizes the
        // computed 2-day average within this scan.
        var hist = pricing.getHistDays(resource) || [];
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
    // Use the shared per-tick raw orders cache from marketPricing so
    // Game.market.getAllOrders() is called at most once per tick across both
    // modules. The derived books (buysByRes/sellsByRes) are built with this
    // module's own filtering logic on the shared raw array (read-only).
    var allOrders  = pricing.getRawOrders();
    var buysByRes  = {};
    var sellsByRes = {};
    var viable     = {};
    var sellBuffer = []; // pre-filtered sells awaiting viable check
    var maxBuyPriceByRes = {};   // highest external buy price per resource
    var hasFloorSweepSell = {};  // resources with a sell at/below FLOOR_SWEEP_PRICE
    var ghosts = Memory.marketArbitrage.ghostSellOrders;

    function keepCheapestSell(list, order) {
        if (list.length < MAX_SELLS_PER_RESOURCE) {
            list.push(order);
            return;
        }

        var worstIndex = 0;
        var worstPrice = list[0].price;
        for (var i = 1; i < list.length; i++) {
            if (list[i].price > worstPrice) {
                worstPrice = list[i].price;
                worstIndex = i;
            }
        }

        if (order.price < worstPrice) list[worstIndex] = order;
    }

    // Single pass: build buys, track best buy price, collect candidate sells
    for (var i = 0; i < allOrders.length; i++) {
        var o = allOrders[i];
        if (!o || o.resourceType === RESOURCE_ENERGY) continue;
        var isAcct = isAccountResource(o.resourceType);

        if (o.type === ORDER_BUY) {
            var buyAmt = o.remainingAmount || o.amount || 0;
            if (buyAmt < MIN_BUY_ORDER_AMOUNT) continue;
            if (o.roomName && myRooms[o.roomName]) continue;
            // Price floor applies to terminal resources only; account resources
            // have their own economics and are handled separately.
            if (!isAcct && o.price < MIN_BUY_ORDER_PRICE) continue;
            if (!buysByRes[o.resourceType]) buysByRes[o.resourceType] = [];
            buysByRes[o.resourceType].push(o);
            viable[o.resourceType] = true;
            if (o.price > (maxBuyPriceByRes[o.resourceType] || 0)) {
                maxBuyPriceByRes[o.resourceType] = o.price;
            }
        } else if (o.type === ORDER_SELL && (o.amount || 0) > 0 && !(o.roomName && myRooms[o.roomName])) {
            // Skip known-ghosted sell orders (terminal resources only).
            if (!isAcct && ghosts && ghosts[o.id] && Game.time - ghosts[o.id] <= GHOST_SELL_COOLDOWN) continue;
            sellBuffer.push(o);
            if (FLOOR_SWEEP_PRICE > 0 && o.price <= FLOOR_SWEEP_PRICE) {
                hasFloorSweepSell[o.resourceType] = true;
            }
        }
    }

    // Viability requires a real exit: external buyers, floor-sweep opportunity,
    // or an internal opportunistic buy request. Rebuild the set explicitly so
    // resources whose only buyers were filtered out (e.g. by MIN_BUY_ORDER_PRICE)
    // are not scanned as if they still had a market.
    viable = {};
    for (var r in maxBuyPriceByRes) viable[r] = true;
    for (var r2 in hasFloorSweepSell) viable[r2] = true;
    for (var r3 in oppBuyRequests) viable[r3] = true;

    // Second pass over sell buffer only (~half of allOrders)
    for (var k = 0; k < sellBuffer.length; k++) {
        var so = sellBuffer[k];
        if (!viable[so.resourceType]) continue;
        // Skip sells priced above the best buyer unless they are cheap enough
        // for floor sweep. Account resources bypass this cap.
        if (!isAccountResource(so.resourceType)) {
            var maxBuy = maxBuyPriceByRes[so.resourceType] || 0;
            if (so.price > maxBuy && so.price > FLOOR_SWEEP_PRICE) continue;
        }
        if (!sellsByRes[so.resourceType]) sellsByRes[so.resourceType] = [];
        keepCheapestSell(sellsByRes[so.resourceType], so);
    }

    // NOTE: buysByRes is intentionally left unsorted here. Sorting is deferred
    // to ensureSortedBuys() and paid only for resources that actually need
    // ordered iteration (i.e. resources with a viable sell, or resources we
    // own/buffer) -- most resources with buy orders never reach that point.
    for (var r2 in sellsByRes) {
        sellsByRes[r2].sort(function(a, b) { return a.price - b.price; });
    }

    return { sellsByRes: sellsByRes, buysByRes: buysByRes, _sortedBuys: {} };
}

/**
 * Sort books.buysByRes[resource] by price descending, on first access only.
 * Most resources in buysByRes never have a matching viable sell order, so
 * deferring the sort until something actually needs ordered iteration skips
 * the vast majority of sorts entirely.
 */
function ensureSortedBuys(books, resource) {
    if (!books) return null;
    var list = books.buysByRes[resource];
    if (!list || books._sortedBuys[resource]) return list;
    list.sort(function (a, b) { return b.price - a.price; });
    books._sortedBuys[resource] = true;
    return list;
}

var CANDIDATE_LIMIT = 25; // shortlist size scanned per idle terminal

/**
 * Build a per-scan shortlist of (sell, topBuy) candidates across all resources,
 * ranked by rough (pre-energy) margin. Replaces the old per-terminal O(R*S) scan
 * with a single O(R*S) pass, followed by O(T*C) per-terminal evaluation where
 * C = CANDIDATE_LIMIT.
 *
 * Only the single cheapest viable sell per resource enters the list -- if that
 * one isn't profitable for any terminal, deeper sells for the same resource
 * won't be either (sells are ascending, topBuy is fixed).
 */
function buildArbCandidates(books, oppBuyRequests, committedBuyAmounts, committedSellAmounts, resourceExposure, bufferedResources, ownSellResources, activeResourceTypes) {
    var candidates = [];

    for (var resource in books.sellsByRes) {
        if (isAccountResource(resource)) continue;
        if (bufferedResources[resource]) continue;
        if (ownSellResources && ownSellResources[resource]) continue;
        if (SINGLE_TERMINAL_RESOURCES[resource] && activeResourceTypes[resource]) continue;

        var currentExposure = resourceExposure[resource] || 0;
        var exposureRoom = MAX_RESOURCE_EXPOSURE - currentExposure;
        if (exposureRoom <= 0) continue;

        var sells = books.sellsByRes[resource];
        if (!sells || !sells.length) continue;

        var buys = ensureSortedBuys(books, resource);
        // Collect top 3 viable buyers for depth-aware sizing. No discount applied to
        // deeper buyers; each is independently checked against MIN_PROFIT_MARGIN later
        // (accounting for that buyer's per-unit energy cost).
        var buyDepth = [];
        if (buys) {
            for (var bi = 0; bi < buys.length && buyDepth.length < BUY_DEPTH; bi++) {
                var cb = buys[bi];
                var eff = (cb.remainingAmount || cb.amount || 0) - (committedBuyAmounts[cb.id] || 0);
                if (eff > 0) buyDepth.push({ order: cb, available: eff });
            }
        }
        if (buyDepth.length === 0) continue;
        var topBuy = buyDepth[0].order;
        var topBuyAmt = buyDepth[0].available;
        // buyAvailable is the sum across the depth window so evaluateCandidate can
        // size to total buyer depth, not just the top bid.
        var depthTotal = 0;
        for (var di = 0; di < buyDepth.length; di++) depthTotal += buyDepth[di].available;

        // -- Self-fulfill advantage --
        if (oppBuyRequests && oppBuyRequests[resource] && oppBuyRequests[resource].length > 0) {
            var bestOppMaxPrice = oppBuyRequests[resource][0].maxPrice; // sorted desc
            var cheapestSellPrice = sells[0].price;
            if (cheapestSellPrice <= bestOppMaxPrice) {
                if (topBuy.price < bestOppMaxPrice * SELF_FULFILL_ADVANTAGE) continue;
            }
        }

        // Historical average cap (150%) -- uses per-scan cache
        var maxBuyPrice = getHistoryCap(resource, 1.5);

        for (var s = 0; s < sells.length; s++) {
            var sell = sells[s];
            // EFFICIENCY: break (not continue) -- sells are sorted ascending by price,
            // so once one exceeds maxBuyPrice all subsequent ones do too.
            if (sell.price > maxBuyPrice) break;
            if (sell.price >= topBuy.price) break;
            if (sell.roomName && topBuy.roomName && sell.roomName === topBuy.roomName) continue;

            var sellCommitted = committedSellAmounts[sell.id] || 0;
            var sellAvailable = sell.amount - sellCommitted;
            if (sellAvailable <= 0) continue;

            var roughMargin = (topBuy.price - sell.price) / sell.price;
            // Safe filter: real margin is always strictly less than roughMargin
            // (energy costs reduce profit), so candidates below the gate can
            // never be profitable. Sells are ascending by price, so break.
            if (roughMargin <= MIN_PROFIT_MARGIN) break;
            // Pragmatic filter: skip tiny buy depths that aren't worth a
            // terminal cooldown and the evaluateCandidate CPU cost.
            if (depthTotal < MIN_ARB_BUY_VOLUME) break;

            candidates.push({
                resource: resource,
                sell: sell,
                buy: topBuy,
                buyDepth: buyDepth,
                sellAvailable: sellAvailable,
                buyAvailable: depthTotal,
                exposureRoom: exposureRoom,
                roughMargin: roughMargin
            });
            break; // cheapest viable sell for this resource only
        }
    }

    candidates.sort(function (a, b) { return b.roughMargin - a.roughMargin; });
    if (candidates.length > CANDIDATE_LIMIT) candidates.length = CANDIDATE_LIMIT;
    return candidates;
}

/**
 * Cheap per-terminal evaluation of a single candidate. Mirrors the inner-loop
 * math from the old findBestOpportunity, but operates on one (sell, buy) pair
 * instead of scanning all resources/sells. Uses calcEffectiveEnergyCost for
 * PWR_OPERATE_TERMINAL awareness.
 */
function evaluateCandidate(cand, terminal, energyPrice, numIdleTerminals, activeResourceTypes) {
    var resource = cand.resource;
    if (SINGLE_TERMINAL_RESOURCES[resource] && activeResourceTypes[resource]) return null;
    if (cand.sellAvailable <= 0 || cand.buyAvailable <= 0 || cand.exposureRoom <= 0) return null;

    var roomName        = terminal.room.name;
    var availableEnergy = terminal.store[RESOURCE_ENERGY] || 0;
    var freeCapacity    = terminal.store.getFreeCapacity() || 0;
    var credits         = Game.market.credits;
    if (freeCapacity <= 0 || availableEnergy < 100 || credits < 1) return null;

    var sell = cand.sell, topBuy = cand.buy;

    // Single-terminal resources or small orders (<50) get the full amount
    // to avoid spreading tiny trades across many terminals.
    var perTerminalShare;
    if (SINGLE_TERMINAL_RESOURCES[resource] || cand.sellAvailable < 50) {
        perTerminalShare = cand.sellAvailable;
    } else {
        var remainingTerminals = Math.max(1, numIdleTerminals);
        perTerminalShare = Math.ceil(cand.sellAvailable / remainingTerminals);
        if (perTerminalShare < MIN_AMOUNT_PER_TERMINAL) {
            if (cand.sellAvailable >= MIN_AMOUNT_PER_TERMINAL * remainingTerminals) {
                perTerminalShare = MIN_AMOUNT_PER_TERMINAL;
            }
        }
    }

    var maxAmt = Math.min(
        perTerminalShare, cand.sellAvailable, cand.buyAvailable,
        freeCapacity, Math.floor(credits / sell.price), cand.exposureRoom
    );
    if (maxAmt <= 0) return null;

    // Energy cap uses the TOP buyer's room as a conservative upper bound. Deeper
    // buyers in buyDepth may be closer (cheaper) so actual energy use will be
    // <= this estimate. This preserves the same closed-form math as before -- no
    // iterative solve -- and is safe.
    var energyCap = capByEnergyBothLegs(maxAmt, roomName, sell.roomName, topBuy.roomName, availableEnergy, terminal);
    if (energyCap <= 0) return null;

    // Greedily allocate energyCap across up to BUY_DEPTH buyers. Each buyer must
    // individually clear MIN_PROFIT_MARGIN accounting for its own per-unit energy
    // cost. No artificial discount for deeper buyers; if a deeper buyer's
    // per-unit economics fail the margin gate we stop and do not skip to the next.
    var depth = cand.buyDepth || [{ order: topBuy, available: topBuyAmt }];
    var remaining = energyCap;
    var totalRevenue = 0;
    var totalSellEnergy = 0;
    var totalCreditCost = 0;
    var allocation = [];
    var primaryBuyer = null;

    for (var bi2 = 0; bi2 < depth.length && remaining > 0; bi2++) {
        var bd = depth[bi2];
        var amtToBuyer = Math.min(remaining, bd.available);
        if (amtToBuyer <= 0) break;

        var energyToBuyer = calcEffectiveEnergyCost(amtToBuyer, roomName, bd.order.roomName, terminal);
        var ccThisBuyer = sell.price * amtToBuyer;
        var revThisBuyer = bd.order.price * amtToBuyer;
        var energyCrThisBuyer = energyToBuyer * energyPrice;
        var profitThisBuyer = revThisBuyer - ccThisBuyer - energyCrThisBuyer;
        var denom = ccThisBuyer + energyCrThisBuyer;
        var marginThisBuyer = denom > 0 ? profitThisBuyer / denom : 0;

        if (marginThisBuyer < MIN_PROFIT_MARGIN || profitThisBuyer <= 0) break;

        allocation.push({
            order: { id: bd.order.id, roomName: bd.order.roomName, price: bd.order.price },
            amount: amtToBuyer
        });
        if (!primaryBuyer) {
            primaryBuyer = { id: bd.order.id, roomName: bd.order.roomName, price: bd.order.price, amount: cand.buyAvailable };
        }
        totalRevenue += revThisBuyer;
        totalSellEnergy += energyToBuyer;
        totalCreditCost += ccThisBuyer;
        remaining -= amtToBuyer;
    }

    var feasible = energyCap - remaining;
    if (feasible <= 0 || !primaryBuyer) return null;

    var buyEnergy = calcEffectiveEnergyCost(feasible, roomName, sell.roomName, terminal);
    var energyCostCr = (buyEnergy + totalSellEnergy) * energyPrice;
    var totalCost = totalCreditCost + energyCostCr;
    var profit = totalRevenue - totalCost;
    var margin = totalCost > 0 ? profit / totalCost : 0;

    if (margin < MIN_PROFIT_MARGIN || profit <= 0) return null;

    return {
        resourceType: resource,
        sellOrder: { id: sell.id, roomName: sell.roomName, price: sell.price, amount: sell.amount },
        buyOrder: primaryBuyer,
        buyDepthAllocation: allocation,
        amount: feasible, creditCost: totalCreditCost, creditRevenue: totalRevenue,
        buyEnergy: buyEnergy, sellEnergy: totalSellEnergy, energyCostCr: energyCostCr,
        profit: profit, margin: margin
    };
}

function cachedOpportunityStillValid(cand, opp, ghosts, activeResourceTypes) {
    if (!cand || !opp) return false;
    if (ghosts && ghosts[cand.sell.id]) return false;
    if (SINGLE_TERMINAL_RESOURCES[cand.resource] && activeResourceTypes[cand.resource]) return false;
    if (cand.sellAvailable < opp.amount) return false;
    if (cand.buyAvailable < opp.amount) return false;
    if (cand.exposureRoom < opp.amount) return false;
    return true;
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
 *
 * SELF-FULFILL FIX: The comparison against external buy orders now uses per-unit
 * net values (not totals) and considers buyers at ANY price -- not just above ourPrice.
 * Previously `if (bo.price <= ourPrice) break` hid buyers between maxPrice and ourPrice,
 * causing self-fulfills that lost value relative to available external sales.
 */
function processOwnSellOrders(books, energyPrice, myRooms, committedBuyAmounts, oppBuyRequests, usedTerminals) {
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

        // -- Self-fulfill path (terminal.send -- no verification needed) --
        var oppList = oppBuyRequests[order.resourceType];
        if (oppList) {
            for (var oi = 0; oi < oppList.length; oi++) {
                var opp = oppList[oi];
                if (opp.roomName === roomName || opp.remaining <= 0) continue;

                var sfAmt = capByEnergy(Math.min(sellableAmount, opp.remaining), roomName, opp.roomName, availEnergy, terminal);
                if (sfAmt <= 0) continue;

                var sfE = calcEffectiveEnergyCost(sfAmt, roomName, opp.roomName, terminal);
                // Net per unit: what the opp request saves us vs energy cost.
                // Compared per-unit (not total) so quantity differences don't
                // distort the comparison against the best external disposal option.
                var sfNetPerUnit = opp.maxPrice - (sfAmt > 0 ? sfE * energyPrice / sfAmt : 0);

                // Check external buy orders at ANY price -- no break on ourPrice.
                // The true disposal value of our inventory may be below our listing.
                // We need the realistic best exit to decide if self-fulfilling beats selling.
                var buyOrders = ensureSortedBuys(books, order.resourceType);
                var bestExtNetPerUnit = 0;
                if (buyOrders) {
                    for (var bi = 0; bi < buyOrders.length; bi++) {
                        var bo = buyOrders[bi];
                        var effAmt = (bo.remainingAmount || bo.amount || 0) - (committedBuyAmounts[bo.id] || 0);
                        if (effAmt < MIN_BUY_ORDER_AMOUNT) continue;

                        var extAmt = Math.min(sellableAmount, effAmt);
                        if (extAmt <= 0) continue;
                        var extE = calcEffectiveEnergyCost(extAmt, roomName, bo.roomName, terminal);
                        var extNetPerUnit = bo.price - (extE * energyPrice / extAmt);
                        if (extNetPerUnit > bestExtNetPerUnit) bestExtNetPerUnit = extNetPerUnit;
                    }
                }

                // Compare per-unit: self-fulfill only when its avoided-acquisition
                // value (maxPrice) beats the best external disposal net per unit.
                if (sfNetPerUnit * SELF_FULFILL_ADVANTAGE > bestExtNetPerUnit) {
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

        // -- Use shared books instead of getAllOrders per sell order --
        var buyOrders = ensureSortedBuys(books, order.resourceType);
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
        var acctBuys = ensureSortedBuys(books, resource);
        if (acctBuys) {
            for (var bi = 0; bi < acctBuys.length; bi++) {
                var cb = acctBuys[bi];
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
                var repls = (ensureSortedBuys(books, op.resourceType) || []).filter(function(o) {
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

/**
 * Confirm initial buy arrived via incomingTransactions. Ghost -> clean up.
 *
 * GROUPED LOGGING: if op.groupKey is set, per-room "Buy verified"/"BUY GHOST"
 * messages are suppressed in favor of a single aggregate "BUY CONFIRMED" line
 * once every group member has either verified or failed. Members that ghost
 * are recorded in grp.failedRooms and reported in that summary.
 */
function processPendingBuyVerify(terminal, op, ops, roomName) {
    var tx = findIncomingTx(roomName, op.resourceType, op.sellOrderId, op.buyVerifyTick);
    var grp = op.groupKey && Memory.marketArbitrage.groups[op.groupKey];

    if (tx) {
        var actual = tx.amount;
        if (actual < op.amount) {
            console.log('[Arbitrage] Buy partial fill: expected ' + op.amount + ', got ' + actual + '. Adjusting.');
            op.amount = actual;
        }
        op.state = 'pending_sell';
        op.arrivedTick = Game.time;
        delete op.buyVerifyTick;

        if (grp) {
            grp.buyConfirmedRooms[roomName] = actual;
            if (Object.keys(grp.buyConfirmedRooms).length >= groupExpectedCount(grp)) {
                logBuyConfirmed(grp);
            }
        } else {
            console.log('[Arbitrage] Buy verified: ' + actual + ' ' + op.resourceType + ' in ' + roomName);
        }
        return;
    }
    if (Game.time - op.buyVerifyTick >= VERIFY_TIMEOUT) {
        console.log('[Arbitrage] BUY GHOST in ' + roomName + ': ' + op.amount + ' ' +
            op.resourceType + ' -- no incoming transaction after ' + (Game.time - op.buyVerifyTick) +
            ' ticks. Cleaning up.');
        if (op.sellOrderId) {
            Memory.marketArbitrage.ghostSellOrders[op.sellOrderId] = Game.time;
        }

        if (grp) {
            grp.failedRooms[roomName] = { stage: 'buy', reason: 'ghost', amount: op.amount, tick: Game.time };
            grp.totalAmount -= op.amount;
            console.log('[Arbitrage] GROUP ' + grp.resource + ' ' + grp.sellRoom + '->' + grp.buyRoom +
                ': ' + roomName + ' FAILED at buy stage (ghost), removed from group');

            var expected = groupExpectedCount(grp);
            if (expected <= 0 || Object.keys(grp.buyConfirmedRooms).length >= expected) {
                logBuyConfirmed(grp);
            }
            if (expected <= 0) delete Memory.marketArbitrage.groups[op.groupKey];
        }
        delete ops[roomName];
    }
}

/**
 * Confirm sell completed via outgoingTransactions. Ghost -> back to pending_sell.
 *
 * GROUPED LOGGING: if op.groupKey is set, per-room "VERIFIED sale"/"Arbitrage
 * complete" messages are suppressed in favor of a single aggregate "SELL
 * CONFIRMED" line once every group member has either verified or been marked
 * failed. Repeated sell-verify ghosts (>= SELL_GHOST_FAIL_THRESHOLD) mark a
 * member as failed so the group can still close out.
 */
function processPendingVerify(terminal, op, ops, roomName) {
    var tx = findOutgoingTx(roomName, op.resourceType, op.verifyOrderId, op.verifyTick);
    var grp = op.groupKey && Memory.marketArbitrage.groups[op.groupKey];

    if (tx) {
        var actual = tx.amount;
        if (!grp) {
            console.log('[Arbitrage] VERIFIED sale of ' + actual + ' ' + op.resourceType +
                ' from ' + roomName + ' @ ' + (tx.order ? tx.order.price : '?') +
                ' -> ' + (tx.to || '?'));
        }
        op.amount -= actual;
        // Track per-buyer consumption in the depth allocation. The current depth
        // entry is op.buyDepth[op.buyDepthIndex] -- the buyer we just dealt with.
        // If it is fully consumed, advance the pointer so processPendingSell picks
        // up the next buyer on the next tick.
        if (op.buyDepth && op.buyDepthIndex !== undefined && op.buyDepth[op.buyDepthIndex]) {
            op.buyDepth[op.buyDepthIndex].amount -= actual;
            if (op.buyDepth[op.buyDepthIndex].amount <= 0) {
                op.buyDepthIndex++;
            }
        }
        if (op.amount <= 0) {
            if (grp) {
                grp.sellConfirmedRooms[roomName] = { amount: actual, profit: op.profit };
                if (Object.keys(grp.sellConfirmedRooms).length >= groupExpectedCount(grp)) {
                    logSellConfirmed(grp);
                    delete Memory.marketArbitrage.groups[op.groupKey];
                }
            } else {
                console.log('[Arbitrage] Arbitrage complete in ' + roomName +
                    '. Est. profit: ' + op.profit.toFixed(2) + ' (' + (op.margin * 100).toFixed(1) + '%)');
            }
            delete ops[roomName];
        } else {
            op.state = 'pending_sell';
            delete op.verifyTick; delete op.verifyOrderId; delete op.verifyAmount;
            if (!grp) console.log('[Arbitrage] Partial verify, ' + op.amount + ' remaining in ' + roomName);
        }
        return;
    }
    if (Game.time - op.verifyTick >= VERIFY_TIMEOUT) {
        if (!grp) {
            console.log('[Arbitrage] SELL GHOST in ' + roomName + ': ' + op.verifyAmount + ' ' +
                op.resourceType + ' -- no outgoing tx after ' + (Game.time - op.verifyTick) + ' ticks.');
        }
        op.state = 'pending_sell';
        op.buyOrderId = null;
        // Advance depth pointer past the ghosted entry so the next processPendingSell
        // call tries a different buyer in the depth, not the same one.
        if (op.buyDepth && op.buyDepthIndex !== undefined && op.buyDepth[op.buyDepthIndex]) {
            op.buyDepth[op.buyDepthIndex].amount = 0;
            op.buyDepthIndex++;
        }
        delete op.verifyTick; delete op.verifyOrderId; delete op.verifyAmount;

        if (grp) {
            grp.sellGhostCounts[roomName] = (grp.sellGhostCounts[roomName] || 0) + 1;
            if (grp.sellGhostCounts[roomName] >= SELL_GHOST_FAIL_THRESHOLD && !grp.failedRooms[roomName]) {
                grp.failedRooms[roomName] = { stage: 'sell', reason: 'repeated-ghost', amount: op.amount, tick: Game.time };
                grp.totalAmount -= op.amount;
                console.log('[Arbitrage] GROUP ' + grp.resource + ' ' + grp.sellRoom + '->' + grp.buyRoom +
                    ': ' + roomName + ' FAILED at sell stage (' + grp.sellGhostCounts[roomName] +
                    ' ghosts), removed from group, ' + op.amount + ' left in terminal');

                // Hand the leftover resources to the buffer so they aren't stranded.
                enterBuffered(op, ops, roomName);

                var expected = groupExpectedCount(grp);
                if (expected <= 0 || Object.keys(grp.sellConfirmedRooms).length >= expected) {
                    logSellConfirmed(grp);
                    delete Memory.marketArbitrage.groups[op.groupKey];
                }
            }
        }
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
        var buys = ensureSortedBuys(books, buf.resourceType);
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
 *
 * GROUPED LOGGING: if op.groupKey is set, the per-room "deal() OK" message is
 * suppressed in favor of a single aggregate "SELL INITIATED" line once every
 * group member has placed its sell deal.
 */
function processPendingSell(terminal, op, ops, roomName, myRooms, energyPrice, oppBuyRequests, books) {
    if (terminal.cooldown > 0) return;
    var availEnergy = terminal.store[RESOURCE_ENERGY] || 0;
    var grp = op.groupKey && Memory.marketArbitrage.groups[op.groupKey];

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
                if (op.amount <= 0) {
                    if (grp) {
                        // Treat self-fulfill as a successful sell for this member, with
                        // zero realized "profit" tracked here (it left via send(), not
                        // a deal(), so there's no transaction price to report against
                        // the group's deal-based profit accounting).
                        grp.sellConfirmedRooms[roomName] = { amount: sfAmt, profit: 0 };
                        if (Object.keys(grp.sellConfirmedRooms).length >= groupExpectedCount(grp)) {
                            logSellConfirmed(grp);
                            delete Memory.marketArbitrage.groups[op.groupKey];
                        }
                    }
                    delete ops[roomName];
                }
                return;
            }
        }
    }

    // -- External buy order: walk op.buyDepth (depth-aware staged selling) --
    // Each tick we sell to ONE buyer in the depth (terminal cooldown). On the
    // next tick, after verification, we move to the next buyer in the list.
    // If a buyer is gone or empty, we skip it. If the entire depth is
    // exhausted, we fall back to a live replacement search.
    var depth = op.buyDepth;
    if (op.buyDepthIndex === undefined) op.buyDepthIndex = 0;
    var depthExhausted = false;

    if (depth && depth.length && op.buyDepthIndex < depth.length) {
        // Iterative walk: skip empty/gone entries until we find one to sell to,
        // or exhaust the depth. Capped at BUY_DEPTH iterations to bound CPU.
        for (var depthTries = 0; depthTries < BUY_DEPTH; depthTries++) {
            var di = op.buyDepthIndex;
            while (di < depth.length && depth[di].amount <= 0) di++;
            if (di >= depth.length) { depthExhausted = true; break; }

            var depthEntry = depth[di];
            var liveBuy = Game.market.getOrderById(depthEntry.order.id);
            var liveBuyAmt = liveBuy ? (liveBuy.remainingAmount || liveBuy.amount || 0) : 0;
            if (!liveBuy || liveBuyAmt <= 0) {
                // Buyer gone -- mark consumed and advance
                depth[di].amount = 0;
                op.buyDepthIndex = di + 1;
                continue;
            }

            var targetAmt = Math.min(op.amount, depthEntry.amount, liveBuyAmt);
            var capped = capByEnergy(targetAmt, roomName, depthEntry.order.roomName, availEnergy, terminal);
            if (capped <= 0) {
                // Insufficient energy for this buyer's distance -- stop trying
                console.log('[Arbitrage] Insufficient energy for depth buyer ' + depthEntry.order.id + ' in ' + roomName);
                return;
            }

            if (Game.market.deal(depthEntry.order.id, capped, roomName) === OK) {
                // Do NOT decrement op.amount or depth[di].amount here -- processPendingVerify
                // does that on the next scan when the outgoing tx is confirmed. This
                // matches the original single-buyer behavior where the verify step owns
                // the amount bookkeeping (to handle ghost deals cleanly).
                op.buyDepthIndex = di;
                op.state = 'pending_verify';
                op.verifyTick = Game.time;
                op.verifyOrderId = depthEntry.order.id;
                op.verifyAmount = capped;

                if (grp) {
                    grp.sellInitRooms[roomName] = capped;
                    grp.sellRoomsActual[depthEntry.order.roomName] = true;
                    if (Object.keys(grp.sellInitRooms).length >= groupExpectedCount(grp)) {
                        logSellInitiated(grp);
                    }
                } else {
                    console.log('[Arbitrage] deal() OK ' + capped + ' ' + op.resourceType +
                        ' -> ' + depthEntry.order.roomName + ' @ ' + depthEntry.order.price +
                        ' (depth ' + (di + 1) + '/' + depth.length + ') | Verifying...');
                }
                return;
            } else {
                // Deal failed with buyer still present -- likely energy/credits glitch.
                // Don't keep retrying this buyer; advance.
                console.log('[Arbitrage] deal() failed for depth buyer ' + depthEntry.order.id + ' in ' + roomName);
                depth[di].amount = 0;
                op.buyDepthIndex = di + 1;
                continue;
            }
        }
        if (!depthExhausted && op.buyDepthIndex >= depth.length) depthExhausted = true;
    } else {
        depthExhausted = true;
    }

    // -- Replacement search (depth exhausted or no depth on this op) --
    var buyOrder     = op.buyOrderId ? Game.market.getOrderById(op.buyOrderId) : null;
    var buyRemaining = buyOrder ? (buyOrder.remainingAmount || buyOrder.amount || 0) : 0;

    if (!buyOrder || buyRemaining <= 0) {
        if (!depthExhausted) {
            // Depth still has entries but we couldn't sell this tick (e.g. cooldown).
            // Don't go searching for replacements yet.
            return;
        }
        console.log('[Arbitrage] Buy order ' + (op.buyOrderId || 'none') + ' gone. Searching replacement...');

        var repls = ensureSortedBuys(books, op.resourceType) || [];

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
                        if (op.amount <= 0) {
                            if (grp) {
                                grp.sellConfirmedRooms[roomName] = { amount: fbAmt, profit: 0 };
                                if (Object.keys(grp.sellConfirmedRooms).length >= groupExpectedCount(grp)) {
                                    logSellConfirmed(grp);
                                    delete Memory.marketArbitrage.groups[op.groupKey];
                                }
                            }
                            delete ops[roomName];
                        }
                        return;
                    }
                }
            }
            enterBuffered(op, ops, roomName);
            if (grp) {
                // Member is leaving the group's deal-based flow for the buffer.
                // Mark it failed-but-buffered so the group can still close.
                grp.failedRooms[roomName] = { stage: 'sell', reason: 'buffered', amount: op.amount, tick: Game.time };
                grp.totalAmount -= op.amount;
                var expected = groupExpectedCount(grp);
                if (expected <= 0 || Object.keys(grp.sellConfirmedRooms).length >= expected) {
                    logSellConfirmed(grp);
                    delete Memory.marketArbitrage.groups[op.groupKey];
                }
            }
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

        if (grp) {
            grp.sellInitRooms[roomName] = capped;
            grp.sellRoomsActual[buyOrder.roomName] = true;
            if (Object.keys(grp.sellInitRooms).length >= groupExpectedCount(grp)) {
                logSellInitiated(grp);
            }
        } else {
            console.log('[Arbitrage] deal() OK ' + capped + ' ' + op.resourceType +
                ' -> ' + buyOrder.roomName + ' @ ' + buyOrder.price + ' | Verifying...');
        }
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

    // Clear per-scan caches at the start of every tick.
    _powerMultiplierCache = {};

    if (!Memory.marketArbitrage) Memory.marketArbitrage = { operations: {}, buffered: [], selfArbPending: {}, accountOp: null, groups: {} };
    if (!Memory.marketArbitrage.selfArbPending) Memory.marketArbitrage.selfArbPending = {};
    if (Memory.marketArbitrage.accountOp === undefined) Memory.marketArbitrage.accountOp = null;
    if (!Memory.marketArbitrage.groups) Memory.marketArbitrage.groups = {};
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
            processPendingSell(psTerminal, psOp, ops, psRoom, _cachedMyRooms, _cachedEnergyPrice, _cachedOppBuyRequests, _cachedBooks);
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
    _cachedOppBuyRequests = oppBuyRequests;
    _cachedEnergyPrice = energyPrice;
    _cachedMyRooms = myRooms;
    _cachedBooks = books;

    // -- Build committed buy amounts ONCE (shared by self-arb and all passes) --
    var buffered = Memory.marketArbitrage.buffered || [];
    var committedBuyAmounts = {};
    for (var opRoom in ops) {
        var aOp = ops[opRoom];
        if (!aOp) continue;
        if (aOp.state === 'pending_verify' && aOp.verifyOrderId) {
            committedBuyAmounts[aOp.verifyOrderId] = (committedBuyAmounts[aOp.verifyOrderId] || 0) + aOp.amount;
        } else if (aOp.buyOrderId && !aOp.buyDepth) {
            // Ops without a buyDepth (legacy, floor sweeps, single-buyer) use the
            // primary buyOrderId. Ops WITH buyDepth are handled by the loop below
            // which covers the primary buyer and every deeper buyer.
            committedBuyAmounts[aOp.buyOrderId] = (committedBuyAmounts[aOp.buyOrderId] || 0) + aOp.amount;
        }
        // Track per-buyer committed amounts across the buyDepth allocation so
        // buildArbCandidates excludes already-claimed volume from deeper buyers.
        if (aOp.buyDepth) {
            for (var dbi = 0; dbi < aOp.buyDepth.length; dbi++) {
                var dba = aOp.buyDepth[dbi];
                if (dba && dba.order && dba.order.id) {
                    committedBuyAmounts[dba.order.id] = (committedBuyAmounts[dba.order.id] || 0) + (dba.amount || 0);
                }
            }
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
            else if (op.state === 'pending_sell')   processPendingSell(terminal, op, ops, roomName, myRooms, energyPrice, oppBuyRequests, books);
        } else if (terminal.cooldown <= 0) {
            idleTerminals.push(terminal);
        }
    }

    // -- PASS 1a: verify account-level operation --
    processAccountOpVerify();

    // -- Stale group watchdog --
    checkStaleGroups();

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
    processOwnSellOrders(books, energyPrice, myRooms, committedBuyAmounts, oppBuyRequests, usedTerminals);

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

    var candidates = buildArbCandidates(
        books, oppBuyRequests, committedBuyAmounts, committedSellAmounts,
        resourceExposure, bufferedResources, ownSellResources, activeResourceTypes
    );

    // Rank terminals once by their best available candidate so high-value
    // terminals get first pick, same as the old profit-sorted scoredIdle.
    var rankedTerminals = [];
    for (var si = 0; si < idleTerminals.length; si++) {
        var sTerm = idleTerminals[si];
        var sBest = 0;
        var sBestOpp = null;
        var sBestCand = null;
        for (var sc = 0; sc < candidates.length; sc++) {
            var sCand = candidates[sc];
            var sOpp = evaluateCandidate(sCand, sTerm, energyPrice, idleTerminals.length, activeResourceTypes);
            if (sOpp && sOpp.profit > sBest) {
                sBest = sOpp.profit;
                sBestOpp = sOpp;
                sBestCand = sCand;
            }
        }
        rankedTerminals.push({ terminal: sTerm, profit: sBest, bestOpp: sBestOpp, bestCand: sBestCand });
    }
    rankedTerminals.sort(function (a, b) { return b.profit - a.profit; });

    // Accumulates split-buy legs by (sellOrder.id|buyOrder.id) so we can emit
    // a single "BUY INITIATED" summary line per group after this loop, and
    // seed Memory.marketArbitrage.groups for downstream aggregate logging.
    var buyLogGroups = {};

    var remainingIdle = rankedTerminals.length;
    for (var i = 0; i < rankedTerminals.length; i++) {
        var term  = rankedTerminals[i].terminal;
        var tRoom = term.room.name;

        var bestOpp = rankedTerminals[i].bestOpp;
        var bestCand = rankedTerminals[i].bestCand;
        var bestProfit = rankedTerminals[i].profit;

        if (!cachedOpportunityStillValid(bestCand, bestOpp, ghosts, activeResourceTypes)) {
            bestOpp = null; bestCand = null; bestProfit = 0;
            for (var ci = 0; ci < candidates.length; ci++) {
                var cand = candidates[ci];
                if (ghosts && ghosts[cand.sell.id]) continue;
                var opp = evaluateCandidate(cand, term, energyPrice, remainingIdle, activeResourceTypes);
                if (opp && opp.profit > bestProfit) {
                    bestProfit = opp.profit; bestOpp = opp; bestCand = cand;
                }
            }
        }

        if (!bestOpp) {
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
                        // Note: floor sweeps have no groupKey -- never split, never grouped.
                    };

                    activeResourceTypes[sweepOpp.resourceType] = true;

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

        if (Game.market.deal(bestOpp.sellOrder.id, bestOpp.amount, tRoom) === OK) {
            bestCand.sellAvailable -= bestOpp.amount;
            bestCand.buyAvailable  -= bestOpp.amount;
            bestCand.exposureRoom  -= bestOpp.amount;

            committedSellAmounts[bestOpp.sellOrder.id] = (committedSellAmounts[bestOpp.sellOrder.id] || 0) + bestOpp.amount;
            // Track every buyer in the depth allocation so processPendingSell walks
            // through them and so we don't double-count committed volume in later
            // evaluations of the same candidates.
            if (bestOpp.buyDepthAllocation) {
                for (var cbi = 0; cbi < bestOpp.buyDepthAllocation.length; cbi++) {
                    var cbd = bestOpp.buyDepthAllocation[cbi];
                    committedBuyAmounts[cbd.order.id] = (committedBuyAmounts[cbd.order.id] || 0) + cbd.amount;
                }
            } else if (bestOpp.buyOrder) {
                committedBuyAmounts[bestOpp.buyOrder.id] = (committedBuyAmounts[bestOpp.buyOrder.id] || 0) + bestOpp.amount;
            }
            resourceExposure[bestOpp.resourceType] = (resourceExposure[bestOpp.resourceType] || 0) + bestOpp.amount;

            var groupKey = bestOpp.sellOrder.id + '|' + (bestOpp.buyOrder ? bestOpp.buyOrder.id : '');

            ops[tRoom] = {
                state: 'pending_buy_verify', resourceType: bestOpp.resourceType,
                amount: bestOpp.amount, sellOrderId: bestOpp.sellOrder.id, sellOrderRoom: bestOpp.sellOrder.roomName,
                sellPrice: bestOpp.sellOrder.price,
                // Full cost basis: purchase price + buy-leg energy per unit
                costBasis: bestOpp.sellOrder.price + (bestOpp.buyEnergy * energyPrice / bestOpp.amount),
                buyOrderId: bestOpp.buyOrder ? bestOpp.buyOrder.id : null,
                buyOrderRoom: bestOpp.buyOrder ? bestOpp.buyOrder.roomName : null,
                buyPrice: bestOpp.buyOrder ? bestOpp.buyOrder.price : 0,
                buyDepth: bestOpp.buyDepthAllocation || null,
                buyDepthIndex: 0, // pointer into buyDepth for staged sell execution
                soldToPrimary: 0, // how much already sold to the top buyer (live tracking)
                profit: bestOpp.profit, margin: bestOpp.margin,
                buyEnergy: bestOpp.buyEnergy, sellEnergy: bestOpp.sellEnergy,
                buyVerifyTick: Game.time, tick: Game.time,
                groupKey: groupKey
            };

            activeResourceTypes[bestOpp.resourceType] = true;

            // Accumulate for the post-loop BUY INITIATED summary + group seed
            if (!buyLogGroups[groupKey]) {
                buyLogGroups[groupKey] = {
                    resource: bestOpp.resourceType,
                    sellRoom: bestOpp.sellOrder.roomName,
                    buyRoom: bestOpp.buyOrder ? bestOpp.buyOrder.roomName : '?',
                    margin: bestOpp.margin,
                    rooms: [],
                    totalAmount: 0,
                    totalProfit: 0
                };
            }
            var lg = buyLogGroups[groupKey];
            lg.rooms.push(tRoom);
            lg.totalAmount += bestOpp.amount;
            lg.totalProfit += bestOpp.profit;
            // Keep the worst (lowest) margin seen for the group, since margin
            // shrinks as committedSellAmounts grows across split legs.
            if (bestOpp.margin < lg.margin) lg.margin = bestOpp.margin;
        } else {
            console.log('[Arbitrage] Buy deal failed in ' + tRoom + ' for ' + bestOpp.resourceType);
        }
        remainingIdle--;
    }

    // -- Emit BUY INITIATED summaries and seed group tracking state --
    for (var gk in buyLogGroups) {
        var g = buyLogGroups[gk];

        Memory.marketArbitrage.groups[gk] = {
            resource: g.resource,
            sellRoom: g.sellRoom,
            buyRoom: g.buyRoom,
            margin: g.margin,
            members: g.rooms,
            totalAmount: g.totalAmount,
            totalProfit: g.totalProfit,
            createdTick: Game.time,

            buyConfirmedRooms: {},
            sellInitRooms: {},
            sellConfirmedRooms: {},
            failedRooms: {},
            sellGhostCounts: {},
            sellRoomsActual: {}
        };

        console.log('[Arbitrage] BUY INITIATED ' + g.resource + ' ' + g.sellRoom + ' -> My Rooms: (' + g.rooms.join(', ') + ') -> ' +
            g.buyRoom + ' | Margin: ' + (g.margin * 100).toFixed(1) + '%' +
            ' | Volume: ' + g.totalAmount +
            ' | Est. Profit: ' + g.totalProfit.toFixed(2));
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
    var groups = Memory.marketArbitrage.groups || {};
    var out = '[Arbitrage] Status: ' + (ENABLED ? 'ENABLED' : 'DISABLED') + '\nActive operations:\n';
    var count = 0;

    for (var room in ops) {
        var op = ops[room];
        var age = Game.time - op.tick;
        var st = op.state;
        if (op.isFloorSweep) st += ' [SWEEP]';
        if (op.groupKey) st += ' [GRP]';
        if (op.buyDepth && op.buyDepth.length) {
            var bdi = op.buyDepthIndex || 0;
            st += ' [DEPTH ' + (bdi + 1) + '/' + op.buyDepth.length + ']';
        }
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
    var groupKeys = Object.keys(groups);
    if (groupKeys.length > 0) {
        out += '\nActive groups:\n';
        for (var gi = 0; gi < groupKeys.length; gi++) {
            var grp = groups[groupKeys[gi]];
            var gAge = Game.time - grp.createdTick;
            var buyDone = Object.keys(grp.buyConfirmedRooms).length;
            var sellInitDone = Object.keys(grp.sellInitRooms).length;
            var sellDone = Object.keys(grp.sellConfirmedRooms).length;
            var failedCount = Object.keys(grp.failedRooms).length;
            var expected = groupExpectedCount(grp);
            out += '  ' + grp.resource + ' ' + grp.sellRoom + '->' + grp.buyRoom +
                ' | members: ' + grp.members.length +
                ' | buyConfirmed: ' + buyDone + '/' + expected +
                ' | sellInit: ' + sellInitDone + '/' + expected +
                ' | sellConfirmed: ' + sellDone + '/' + expected +
                ' | failed: ' + failedCount +
                ' | age: ' + gAge + 't\n';
        }
    }
    if (count === 0) out += '  (none)\n';
    out += '\nConfig: enabled=' + ENABLED + ', margin=' + (MIN_PROFIT_MARGIN * 100) + '%, minBuy=' + MIN_BUY_ORDER_AMOUNT +
        ', minBuyPrice=' + MIN_BUY_ORDER_PRICE +
        ', minArbBuyVol=' + MIN_ARB_BUY_VOLUME +
        ', scan=' + SCAN_INTERVAL + ', bufTimeout=' + BUFFER_TIMEOUT + ', verifyTimeout=' + VERIFY_TIMEOUT +
        ', acctVerifyTimeout=' + ACCOUNT_VERIFY_TIMEOUT +
        ', maxExposure=' + MAX_RESOURCE_EXPOSURE + ', minSelfArbProfit=' + MIN_SELF_ARB_PROFIT +
        ', selfFulfillAdvantage=' + (SELF_FULFILL_ADVANTAGE * 100).toFixed(0) + '%' +
        ', floorSweepPrice=' + FLOOR_SWEEP_PRICE +
        ', floorSweepBanned=[' + Object.keys(FLOOR_SWEEP_BANNED).join(',') + ']' +
        ', sellGhostFailThreshold=' + SELL_GHOST_FAIL_THRESHOLD +
        ', groupStaleTicks=' + GROUP_STALE_TICKS;
    console.log(out); return out;
}

function cancel(roomName) {
    if (!Memory.marketArbitrage) return '[Arbitrage] Nothing to cancel.';
    if (Memory.marketArbitrage.operations && Memory.marketArbitrage.operations[roomName]) {
        var op = Memory.marketArbitrage.operations[roomName];
        delete Memory.marketArbitrage.operations[roomName];

        // If this was the last active member of its group, clean up the group too.
        if (op.groupKey && Memory.marketArbitrage.groups && Memory.marketArbitrage.groups[op.groupKey]) {
            var grp = Memory.marketArbitrage.groups[op.groupKey];
            grp.failedRooms[roomName] = { stage: op.state, reason: 'cancelled', amount: op.amount, tick: Game.time };
            grp.totalAmount -= op.amount;
            var expected = groupExpectedCount(grp);
            if (expected <= 0) delete Memory.marketArbitrage.groups[op.groupKey];
        }

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

function setMinBuyOrderPrice(v) {
    if (typeof v !== 'number' || v < 0) return '[Arbitrage] Must be >= 0';
    MIN_BUY_ORDER_PRICE = v;
    var m = '[Arbitrage] Min buy order price set to ' + v; console.log(m); return m;
}

function setMinArbBuyVolume(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be >= 1';
    MIN_ARB_BUY_VOLUME = v;
    var m = '[Arbitrage] Min arbitrage buy volume set to ' + v; console.log(m); return m;
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

function setSellGhostFailThreshold(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be >= 1';
    SELL_GHOST_FAIL_THRESHOLD = v;
    var m = '[Arbitrage] Sell ghost fail threshold set to ' + v; console.log(m); return m;
}

function setGroupStaleTicks(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be >= 1';
    GROUP_STALE_TICKS = v;
    var m = '[Arbitrage] Group stale ticks set to ' + v; console.log(m); return m;
}

module.exports = {
    run: run, status: status, cancel: cancel, cancelAccount: cancelAccount,
    setEnabled: setEnabled,
    setMargin: setMargin, setMinBuyAmount: setMinBuyAmount, setMinBuyOrderPrice: setMinBuyOrderPrice, setMinArbBuyVolume: setMinArbBuyVolume,
    setBufferTimeout: setBufferTimeout, setMaxExposure: setMaxExposure,
    setMinSelfArbProfit: setMinSelfArbProfit, setSelfFulfillAdvantage: setSelfFulfillAdvantage,
    setFloorSweepPrice: setFloorSweepPrice, setFloorSweepDebug: setFloorSweepDebug,
    addFloorSweepBan: addFloorSweepBan, removeFloorSweepBan: removeFloorSweepBan,
    setSellGhostFailThreshold: setSellGhostFailThreshold, setGroupStaleTicks: setGroupStaleTicks
};
