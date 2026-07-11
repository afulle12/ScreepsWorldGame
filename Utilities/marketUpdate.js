// LLM: Read llmcontext.js before reviewing or changing this file.
// marketUpdate.js (v2)
//
// Managed BUY repricing is owned exclusively by marketBuy.js. This module keeps
// its run/forceRun/status console contracts and the disabled legacy sell pass.
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
var memoryManager = require('memoryManager');

// ===== CONFIGURATION =====
var UPDATE_INTERVAL = 100;

// ===== SELL SIDE (legacy, disabled) =====
var ENABLE_SELL_UPDATES = false;
var SELL_MIN_AVG_MULTIPLIER = 0.80; // floor = 80% of 48h avg (legacy behavior)

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
            memoryManager.requestSave();
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
        if (ENABLE_SELL_UPDATES) runSellSide();
    },

    status: function() {
        var lines = ['=== MARKET UPDATE STATUS ==='];
        lines.push('Managed BUY repricing: owned by marketBuy.js');
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

            var capStr = '-';
            if (rec.job && rec.job.product) {
                var rm = pricing.inputCeilings(rec.job.product, 20);
                if (rm && typeof rm[rec.resource] === 'number') {
                    var cap = rm[rec.resource];
                    if (typeof rec.jobCeiling === 'number' && rec.jobCeiling > 0) cap = Math.min(cap, rec.jobCeiling);
                    capStr = cap.toFixed(3);
                }
            }
            lines.push('  ' + id + ' | ' + rec.resource + ' | price ' + o.price.toFixed(3) +
                ' | hardCap ' + capStr +
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
