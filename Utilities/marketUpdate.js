// marketUpdate.js (v2)
//
// Buy-side repricing for managed BUY orders (created by marketBuy.js).
//
// POLICY (the anti-ratchet band):
//   changeOrderPrice charges a 5% fee on (newPrice - oldPrice) * remaining when
//   RAISING; lowering is free but raising back is not. So:
//
//   - NEVER chase the market down. If competing bids fall, our order becomes top
//     of book and fills at our price - which is still at/under the raise cap, so
//     every fill still clears the target margin. There is no reason to follow.
//   - RAISE rarely: only toward the top of book, only with hysteresis, only up to
//     raiseCap = inputCeilings(product, MARGIN_TARGET). The raiseCap is the
//     profitability ceiling and is the HARD upper bound on target.
//   - rec.jobCeiling (set by marketBuy at placement or by forceRaiseToTop) is
//     honored as a RAISE-ONLY FLOOR: target = max(target, rec.jobCeiling). A
//     manual raise never gets walked back down, and a low-placed order can
//     catch up to a market that has risen above its original ceiling.
//   - Fee budget is REPRICE_BUDGET_RATIO (= 5%) of the raiseCap value, NOT of
//     the current order price. This lets an order placed in a low-margin
//     moment catch up to the cap in a single pass instead of being stuck
//     behind a budget sized off its original low price.
//   - LOWER only on hard-floor breach: if order.price > hardCap =
//     inputCeilings(product, MARGIN_FLOOR), a fill would be unprofitable, so we
//     lower (free) back to raiseCap. Output-price chop between the two caps moves
//     nothing - that band is what kills the lower-free/raise-paid fee pump.
//   - If even the FLOOR margin is unachievable (inputCeilings returns null), the
//     job is dead: cancel the order. autoTrader's recheck aborts the op itself.
//
//   Orders without job linkage (rec.job missing) are never repriced: no ceiling,
//   no raise. Passive orders are never raised (no job urgency; marketBuy.js
//   audits them for stall/collapse) but the hard-floor lower still applies.
//
// Sell-side updating is intentionally OFF by default: lowering asks is free but
// re-raising them after the market recovers costs the fee on the delta, and that
// ratchet was measured to be a net loss. Enable ENABLE_SELL_UPDATES only if you
// also accept never re-raising.
//
// Usage:
//   marketUpdater.run() every tick from the main loop (self-throttles)
//   marketUpdateStatus()       - console status
//   marketUpdate.forceRun()    - immediate pass
//
// Requires: marketBuy.js, marketPricing.js

var marketBuyer = require('marketBuy');
var pricing = require('marketPricing');

// ===== CONFIGURATION =====
var UPDATE_INTERVAL    = 100;     // ticks between repricing passes
var MARGIN_TARGET      = 40;      // % - raise cap derives from this
var MARGIN_FLOOR       = 20;      // % - forced-lower / cancel line derives from this
var RAISE_HYSTERESIS   = 0.02;    // only raise when 2%+ below the top of book
var MIN_RAISE_ABS      = 0.001;   // ignore sub-noise raises
// Budget is computed against the raiseCap value, not the current (possibly low)
// order price, so an order placed in a low-margin moment can catch up to a
// rising market in a single pass. Total fee to reach raiseCap is always <=
// REPRICE_BUDGET_RATIO * raiseCap * remaining (proof: 0.05 * (raiseCap - start) *
// remaining <= 0.05 * raiseCap * remaining).
var REPRICE_BUDGET_RATIO = 0.05;

// ===== SELL SIDE (legacy, disabled) =====
var ENABLE_SELL_UPDATES = false;
var SELL_MIN_AVG_MULTIPLIER = 0.80; // floor = 80% of 48h avg (legacy behavior)

// ===== BUY-SIDE PASS =====

function reprice(orderId, rec) {
    var order = Game.market.orders[orderId];
    if (!order || order.type !== ORDER_BUY) return; // marketBuy.run() handles cleanup

    // No job linkage -> no ceiling -> never reprice. Raising blind is how an
    // updater outbids itself into a loss.
    if (!rec.job || !rec.job.product) return;

    var resource = rec.resource;
    var product = rec.job.product;
    var label = rec.passive ? 'PASSIVE' : 'ACTIVE';

    var raiseMap = pricing.inputCeilings(product, MARGIN_TARGET);
    var hardMap  = pricing.inputCeilings(product, MARGIN_FLOOR);
    var raiseCap = raiseMap ? raiseMap[resource] : null;
    var hardCap  = hardMap ? hardMap[resource] : null;

    // Even the floor margin is unachievable: the trade is dead. Cancel via
    // marketBuy so tracking/tombstones stay consistent. autoTrader's recheck
    // aborts the op; expireOp will find the tombstone.
    if (typeof hardCap !== 'number' || !(hardCap > 0)) {
        marketBuyer.cancelOrderById(orderId, 'margin unachievable even at floor ' + MARGIN_FLOOR + '%');
        return;
    }

    // 1) HARD-FLOOR BREACH -> lower (free) back to the raise cap.
    //    A fill above hardCap is a sub-floor-margin fill; we must not allow it.
    if (order.price > hardCap) {
        var lowerTo = (typeof raiseCap === 'number' && raiseCap > 0) ? raiseCap : hardCap;
        lowerTo = Math.max(lowerTo, 0.001);
        var resLower = Game.market.changeOrderPrice(orderId, lowerTo);
        if (resLower === OK) {
            console.log('[marketUpdate] ' + label + ' LOWERED (floor breach) ' + orderId + ' ' + resource +
                ' ' + order.price.toFixed(3) + ' -> ' + lowerTo.toFixed(3) +
                ' (hardCap ' + hardCap.toFixed(3) + ', free)');
        }
        return; // one move per pass
    }

    // 2) RAISES: active orders only, with hysteresis, capped, fee-budgeted.
    //    We never lower for competitiveness - see policy header.
    if (rec.passive) return;
    if (typeof raiseCap !== 'number' || !(raiseCap > 0)) return; // target margin not achievable: sit and wait
    if (order.price >= raiseCap) return;                          // already at cap

    var book = pricing.getBook(resource);
    if (book.bestBid === null) return; // alone on the book: nothing to outbid

    var target = Math.min(book.bestBid + 0.1, raiseCap);
    // rec.jobCeiling is a raise-only floor: never target below it. A manually
    // raised order (forceRaiseToTop) bumps it up, and the regular loop will not
    // walk it back down. The cap remains the profitability ceiling (raiseCap).
    if (typeof rec.jobCeiling === 'number' && rec.jobCeiling > 0 && rec.jobCeiling > target) {
        target = rec.jobCeiling;
    }
    var gap = target - order.price;
    if (gap < MIN_RAISE_ABS) return;
    if (gap / order.price < RAISE_HYSTERESIS) return; // close enough to the top

    var fee = pricing.FEE * gap * order.remainingAmount;
    // Budget against the raiseCap value, not the current price. This lets a
    // low-placed order catch up to the cap in one pass instead of being stuck
    // behind a budget sized off its original low price.
    var budgetBase = (typeof raiseCap === 'number' && raiseCap > 0) ? raiseCap : order.price;
    var budgetLeft = REPRICE_BUDGET_RATIO * budgetBase * order.remainingAmount - (rec.repriceFees || 0);
    if (fee > budgetLeft) {
        console.log('[marketUpdate] ' + label + ' SKIP raise ' + orderId + ' ' + resource +
            ': fee ' + fee.toFixed(1) + ' > budget left ' + budgetLeft.toFixed(1) +
            ' (order sits at ' + order.price.toFixed(3) + ' and waits)');
        return;
    }

    var resRaise = Game.market.changeOrderPrice(orderId, target);
    if (resRaise === OK) {
        marketBuyer.addRepriceFee(orderId, fee);
        console.log('[marketUpdate] ' + label + ' RAISED ' + orderId + ' ' + resource +
            ' ' + order.price.toFixed(3) + ' -> ' + target.toFixed(3) +
            ' (cap ' + raiseCap.toFixed(3) + ', fee ' + fee.toFixed(1) +
            ', budget left ' + (budgetLeft - fee).toFixed(1) + ')');
    } else {
        console.log('[marketUpdate] ' + label + ' raise failed ' + orderId + ': ' + resRaise);
    }
}

function runBuySide() {
    var orders = marketBuyer.getManagedOrders();
    for (var id in orders) {
        var rec = orders[id];
        if (!rec || rec.done || rec.cancelled) continue; // tombstones
        reprice(id, rec);
    }
}

// ===== SELL-SIDE PASS (legacy, off by default) =====

function runSellSide() {
    var myRooms = {};
    for (var rn in Game.rooms) {
        var r = Game.rooms[rn];
        if (r && r.controller && r.controller.my) myRooms[rn] = true;
    }

    var mine = Game.market.orders;
    for (var id in mine) {
        var order = mine[id];
        if (!order || order.type !== ORDER_SELL) continue;
        if (!order.roomName || !myRooms[order.roomName]) continue;
        if (order.remainingAmount <= 0) continue;

        var book = pricing.getBook(order.resourceType); // external-only, dust-filtered
        if (book.bestAsk === null) continue;

        var avg = pricing.getAvg48h(order.resourceType);
        var minAllowed = (typeof avg === 'number' && avg > 0)
            ? Math.max(0.001, avg * SELL_MIN_AVG_MULTIPLIER) : 0.001;

        var targetPrice = Math.max(book.bestAsk - 0.1, minAllowed);
        if (targetPrice < 0.001) targetPrice = 0.001;

        // Lower-only, same as the original module. NOTE: re-raising later costs
        // the fee on the delta - this is exactly the ratchet that motivated
        // disabling the sell side. Left here behind the flag for completeness.
        if (order.price <= targetPrice) continue;

        var res = Game.market.changeOrderPrice(id, targetPrice);
        if (res === OK) {
            console.log('[marketUpdate] SELL lowered ' + id + ' ' + order.resourceType +
                ' ' + order.price.toFixed(3) + ' -> ' + targetPrice.toFixed(3) +
                ' (floor ' + minAllowed.toFixed(3) + ')');
        }
    }
}

// ===== MAIN MODULE =====

var marketUpdater = {
    run: function() {
        if (Game.time % UPDATE_INTERVAL !== 0) return;
        this.forceRun();
    },

    forceRun: function() {
        runBuySide();
        if (ENABLE_SELL_UPDATES) runSellSide();
    },

    status: function() {
        var lines = ['=== MARKET UPDATE STATUS ==='];
        lines.push('Buy-side band: raise cap @ ' + MARGIN_TARGET + '% margin, hard floor @ ' + MARGIN_FLOOR + '% margin');
        lines.push('Sell-side updates: ' + (ENABLE_SELL_UPDATES ? 'ON' : 'OFF (re-raise ratchet)'));
        lines.push('Next pass in: ' + (UPDATE_INTERVAL - (Game.time % UPDATE_INTERVAL)) + ' ticks');
        lines.push('');

        var orders = marketBuyer.getManagedOrders();
        var shown = 0;
        for (var id in orders) {
            var rec = orders[id];
            if (!rec || rec.done || rec.cancelled) continue;
            var o = Game.market.orders[id];
            if (!o) { lines.push('  ' + id + ' | MISSING'); shown++; continue; }

            var capStr = '-', floorStr = '-';
            if (rec.job && rec.job.product) {
                var rm = pricing.inputCeilings(rec.job.product, MARGIN_TARGET);
                var hm = pricing.inputCeilings(rec.job.product, MARGIN_FLOOR);
                if (rm && typeof rm[rec.resource] === 'number') capStr = rm[rec.resource].toFixed(3);
                if (hm && typeof hm[rec.resource] === 'number') floorStr = hm[rec.resource].toFixed(3);
            }
            lines.push('  ' + id + ' | ' + rec.resource + ' | price ' + o.price.toFixed(3) +
                ' | raiseCap ' + capStr + ' | hardCap ' + floorStr +
                ' | rem ' + o.remainingAmount + '/' + rec.trancheTotal +
                ' | repriceFees ' + (rec.repriceFees || 0).toFixed(1) +
                ' (budget left ' + marketBuyer.repriceBudgetRemaining(id).toFixed(1) + ')' +
                ' | ' + (rec.passive ? 'PASSIVE' : 'active') +
                ' | product ' + (rec.job && rec.job.product ? rec.job.product : '-'));
            shown++;
        }
        if (shown === 0) lines.push('  (no managed buy orders)');
        console.log(lines.join('\n'));
        return '[marketUpdate] Status printed.';
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====
global.marketUpdate = {
    run: function() { return marketUpdater.run(); },
    forceRun: function() { return marketUpdater.forceRun(); },
    status: function() { return marketUpdater.status(); }
};
global.marketUpdateStatus = function() { return marketUpdater.status(); };

module.exports = marketUpdater;