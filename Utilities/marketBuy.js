// LLM: Read llmcontext.js before reviewing or changing this file.
/**
 * marketBuy.js (v2.1)
 *
 * Standing BUY order management. THE single owner of Memory.marketBuy.
 *
 * Memory layout:
 *   Memory.marketBuy.operations  - legacy data, cleaned without affecting logistics
 *   Memory.marketBuy.orders      - orderId -> managed order record
 *   Memory.marketBuy.pending     - awaiting async order-id capture
 *
 * IMPORTANT: Game.market.createOrder returns OK only; the order does NOT appear
 * in Game.market.orders until the NEXT tick. Order ids therefore CANNOT be
 * returned synchronously. Callers (marketRefine) must poll
 * getOrderRecordFor(room, resource) until rec.orderId is populated.
 *
 * Records:
 *   { orderId, room, resource, queue, opId, target, price, trancheTotal, feesPaid, repriceFees,
 *     job: {product, room}|null, created, lastRemaining, lastProgressTick,
 *     passive: bool, passiveSince,
 *     done: bool, cancelled: bool, fulfilledFinal, closedTick }   // tombstone fields
 *
 * Tombstones: completed/cancelled records are kept for TOMBSTONE_TTL ticks with
 * done/cancelled flags so marketRefine can read the final fill count instead of
 * guessing from room deltas.
 *
 * API (used by marketRefine / marketUpdate):
 *   marketBuy(room, res, amount[, price][, job])    -> string (console + programmatic)
 *   createBuyOrder(room, res, amount, price, opts)  -> {ok, orderId:null, message}  (compat;
 *                                                      orderId is ALWAYS null - poll the record)
 *   getOrderRecordFor(room, res[, queue][, opId]) -> record | null
 *   getManagedOrders()            -> Memory.marketBuy.orders
 *   getFulfilled(rec)             -> units acquired so far (tombstone-aware)
 *   cancelOrderById(id[, reason][, opId]) -> bool
 *   cancelOrderFor(room, res[, reason][, queue][, opId]) -> count
 *   markPassiveFor(room, res[, job][, opId]) -> bool
 *   passivateOrder(orderId[, product][, opId]) -> bool (compat alias, by id)
 *   addRepriceFee(orderId, fee) / repriceBudgetRemaining(orderId)
 *   getPriceRange(res)            -> compat alias for marketPricing.getRange7d
 *   run()                         - call every tick from main loop
 *
 * Requires: marketPricing.js, terminalManager.js
 */

var terminalManager = require('terminalManager');
var pricing = require('marketPricing');
var roomSuspender = require('roomSuspender');
var memoryManager = require('memoryManager');
var creditLedger = require('creditLedger');

// ===== Configuration =====
var TRANCHE_RATIO = 0.25;          // initial order size as a fraction of target
var MIN_TRANCHE = 2000;            // never create an order smaller than this (unless target is)
var EXTEND_TRIGGER_RATIO = 0.25;   // extend when remaining drops to this fraction of a tranche
var PASSIVE_STALL_TICKS = 20000;   // cancel passive orders with no fill progress for this long
var PASSIVE_MARGIN_FLOOR = 20;     // passive orders survive while this margin % is achievable
var PENDING_CAPTURE_TTL = 10;      // ticks to wait for a created order to appear
var PENDING_HARD_TTL = 5000;       // discard metadata once no matching live order can remain unresolved
var REPRICE_BUDGET_RATIO = 0.05;   // max repricing fees as a fraction of order value
var TOMBSTONE_TTL = 5000;          // keep completed/cancelled records this long for callers
var MANAGE_INTERVAL = 10;          // full order audit cadence; pending capture still runs every tick

// ===== Reprice-UP config (v3) =====
// Standing BUY orders can be undercut by competing bidders. Without reprice-UP
// the order's lead over the book evaporates and the order stalls at the
// original price. These limits keep the fee budget bounded.
var MAX_UP_REPRICES     = 12;       // hard cap on reprice-up events per order (4 was too tight for 3x market moves)
var UP_REPRICE_GATE     = 10;       // min ticks between reprice-up attempts per order
var MAX_PRICE_OVER_BEST = 0.1;      // lead we try to maintain over bestBid

function compactTombstone(rec) {
    delete rec.price;
    delete rec.trancheTotal;
    delete rec.repriceFees;
    delete rec.job;
    delete rec.jobCeiling;
    delete rec.upReprices;
    delete rec.lastUpRepriceTick;
    delete rec.created;
    delete rec.lastRemaining;
    delete rec.lastProgressTick;
    delete rec.passive;
    delete rec.passiveSince;
    delete rec.cancelRequested;
    delete rec.reason;
    delete rec.extendFailSince;
}

var marketBuyer = {

    getQueue: function(job) {
        if (job && typeof job.queue === 'string' && job.queue) return job.queue;
        if (job && typeof job.scope === 'string' && job.scope) return job.scope;
        return 'default';
    },

    // ===== Memory =====
    ensureMemory: function() {
        if (!Memory.marketBuy) Memory.marketBuy = {};
        if (!Array.isArray(Memory.marketBuy.operations)) Memory.marketBuy.operations = [];
        if (!Memory.marketBuy.orders) Memory.marketBuy.orders = {};
        if (!Array.isArray(Memory.marketBuy.pending)) Memory.marketBuy.pending = [];
        if (Memory.marketBuy.version !== 2) {
            for (var id in Memory.marketBuy.orders) {
                var rec = Memory.marketBuy.orders[id];
                if (rec && (rec.done || rec.cancelled)) compactTombstone(rec);
            }
            Memory.marketBuy.version = 2;
            memoryManager.requestSave();
        }
    },

    // ===== Legacy compatibility =====
    installGetResourceNeededHook: function() {
        return;
    },

    createGatherOp: function(roomName, resourceType, amount, price) {
        this.ensureMemory();
        return null;
    },

    // ===== Order record helpers =====

    getManagedOrders: function() {
        this.ensureMemory();
        return Memory.marketBuy.orders;
    },

    // Returns the LIVE record first, then a pending-capture stub, then the most
    // recent tombstone. Callers should check rec.done / rec.cancelled.
    getOrderRecordFor: function(roomName, resourceType, queueName, opId) {
        this.ensureMemory();
        var orders = Memory.marketBuy.orders;
        var tombstone = null;
        for (var id in orders) {
            var rec = orders[id];
            if (!rec || rec.room !== roomName || rec.resource !== resourceType) continue;
            if (queueName && (rec.queue || 'default') !== queueName) continue;
            if (opId && rec.opId !== opId) continue;
            if (rec.done || rec.cancelled) {
                if (!tombstone || (rec.closedTick || 0) > (tombstone.closedTick || 0)) tombstone = rec;
                continue;
            }
            return rec; // live record
        }
        var pend = Memory.marketBuy.pending;
        for (var i = 0; i < pend.length; i++) {
            if (pend[i] && pend[i].room === roomName && pend[i].resource === resourceType &&
                (!queueName || (pend[i].queue || 'default') === queueName) && (!opId || pend[i].opId === opId)) return pend[i];
        }
        return tombstone;
    },

    // Units acquired so far. Tombstone-aware; safe to call with pending stubs (orderId null -> 0).
    getFulfilled: function(rec) {
        if (!rec) return 0;
        if (rec.done || rec.cancelled) return rec.fulfilledFinal || 0;
        if (!rec.orderId) return 0; // still pending capture
        var o = Game.market.orders[rec.orderId];
        if (!o) return rec.fulfilledFinal || (rec.trancheTotal || 0); // disappeared between audits
        return Math.max(0, (rec.trancheTotal || 0) - (o.remainingAmount || 0));
    },

    addRepriceFee: function(orderId, fee) {
        this.ensureMemory();
        var rec = Memory.marketBuy.orders[orderId];
        if (rec) {
            rec.feesPaid = (rec.feesPaid || 0) + fee;
            rec.repriceFees = (rec.repriceFees || 0) + fee;
            memoryManager.requestSave();
        }
    },

    repriceBudgetRemaining: function(orderId) {
        this.ensureMemory();
        var rec = Memory.marketBuy.orders[orderId];
        if (!rec) return 0;
        var budget = REPRICE_BUDGET_RATIO * rec.price * rec.target;
        return Math.max(0, budget - (rec.repriceFees || 0));
    },

    // ===== Cancellation =====

    _closeRecord: function(rec, asDone, fulfilledFinal) {
        rec.fulfilledFinal = typeof fulfilledFinal === 'number' ? fulfilledFinal : this.getFulfilled(rec);
        if (asDone) rec.done = true; else rec.cancelled = true;
        rec.closedTick = Game.time;

        // Callers locate tombstones by ownership and only consume final progress.
        compactTombstone(rec);
    },

    /**
     * Bump a standing BUY order's price UP to stay on top of the book.
     * Called from _manageOrders() for each live, non-passive record.
     *
     * Conditions to reprice up:
     *   - record is live, not passive/done/cancelled
     *   - order is found in Game.market.orders
     *   - market has a bestBid (someone is bidding against us)
     *   - target = min(bestBid + MAX_PRICE_OVER_BEST, ceiling) is strictly above
     *     current price, where ceiling is the FRESH inputCeilings(product,
     *     PASSIVE_MARGIN_FLOOR)[resource] recomputed each tick
     *   - at least UP_REPRICE_GATE ticks since last reprice-up
     *   - under MAX_UP_REPRICES cap
     *   - reprice-fee budget allows the changeOrderPrice fee
     *
     * rec.jobCeiling (if set by the caller at placement) is a hard upper bound.
     *
     * If the required new price exceeds the live ceiling, the order is
     * passivated (kept alive for partial fill) instead of repriced.
     */
    repriceUpIfNeeded: function(rec) {
        if (!rec || rec.passive || rec.done || rec.cancelled) return false;
        if (!rec.orderId) return false;
        var order = Game.market.orders[rec.orderId];
        if (!order || order.type !== ORDER_BUY) return false;
        if (Game.time - (rec.lastUpRepriceTick || rec.created || 0) < UP_REPRICE_GATE) return false;

        var ceiling = Infinity;
        // inputCeilings only understands COMMODITIES recipes, so this live-margin
        // recompute is only valid for factory-queue records (marketRefine always
        // buys a recipe input of job.product). Lab-queue jobs carry a reaction
        // compound as job.product - it never resolves as recipe+input there (not
        // even for G, which IS a COMMODITIES key but whose recipe input is
        // ghodium_melt, not the reagents being bought) - so rely on jobCeiling
        // (the frozen ceiling set at lab op creation) below instead.
        if (rec.job && rec.job.product && (rec.queue || 'default') === 'factory') {
            var map = pricing.inputCeilings(rec.job.product, PASSIVE_MARGIN_FLOOR);
            var live = map ? map[rec.resource] : null;
            if (typeof live !== 'number' || !(live > 0)) {
                this.cancelOrderById(rec.orderId, 'margin unachievable at floor ' + PASSIVE_MARGIN_FLOOR + '%', rec.opId || null);
                return false;
            }
            ceiling = live;
        }
        if (typeof rec.jobCeiling === 'number' && rec.jobCeiling > 0) {
            ceiling = Math.min(ceiling, rec.jobCeiling);
        }
        if (ceiling < 0.001) {
            this.cancelOrderById(rec.orderId, 'hard ceiling below market minimum price', rec.opId || null);
            return false;
        }
        if (ceiling < Infinity && order.price > ceiling + 0.0005) {
            var lowerResult = Game.market.changeOrderPrice(rec.orderId, Math.max(0.001, ceiling));
            if (lowerResult === OK) {
                rec.price = Math.max(0.001, ceiling);
                rec.lastUpRepriceTick = Game.time;
                memoryManager.requestSave();
                console.log('[MarketBuy] Lowered ' + rec.resource + ' in ' + rec.room +
                            ' to hard ceiling ' + rec.price.toFixed(3) + ' (order ' + rec.orderId + ')');
                return true;
            }
        }

        var b = pricing.getBook(rec.resource);
        if (!b || b.bestBid === null) return false;
        var target = Math.min(b.bestBid + MAX_PRICE_OVER_BEST, ceiling);
        if (target <= order.price + 0.0005) return false;

        if ((rec.upReprices || 0) >= MAX_UP_REPRICES) {
            this.passivateOrder(rec.orderId, rec.job && rec.job.product);
            console.log('[MarketBuy] Up-reprice cap hit for ' + rec.resource + ' in ' + rec.room +
                        ' (order ' + rec.orderId + '). Passivating at ' + order.price.toFixed(3));
            return false;
        }
        var fee = pricing.FEE * (target - order.price) * (order.remainingAmount || 0);
        var remaining = this.repriceBudgetRemaining(rec.orderId);
        if (fee > remaining) {
            this.passivateOrder(rec.orderId, rec.job && rec.job.product);
            console.log('[MarketBuy] Up-reprice fee ' + fee.toFixed(1) + ' exceeds budget ' +
                        remaining.toFixed(1) + ' for ' + rec.resource + ' in ' + rec.room + '. Passivating.');
            return false;
        }
        if (creditLedger.available() < fee) return false;

        var res = Game.market.changeOrderPrice(rec.orderId, target);
        if (res === OK) {
            creditLedger.commit(fee);
            rec.feesPaid = (rec.feesPaid || 0) + fee;
            rec.repriceFees = (rec.repriceFees || 0) + fee;
            rec.upReprices  = (rec.upReprices  || 0) + 1;
            rec.lastUpRepriceTick = Game.time;
            rec.price = target;
            memoryManager.requestSave();
            console.log('[MarketBuy] Up-repriced ' + rec.resource + ' in ' + rec.room +
                        ' to ' + target.toFixed(3) + ' (bestBid ' + b.bestBid.toFixed(3) +
                        ', order ' + rec.orderId + ', cap ' + MAX_UP_REPRICES + ')');
            return true;
        }
        return false;
    },

    /**
     * forceRaiseToTop: one-shot raise to lead the best external bid (filtered
     * to orders with >= minRemaining to ignore dust). Used to recover from a
     * stalled order where the regular reprice loop couldn't keep up.
     *
     * Bypasses the regular reprice caps and fee budget. Charge is the normal
     * 5% fee on the price delta, which we track in rec.repriceFees. The
     * profitability check uses pricing.inputCeilings(product, marginFloor) so
     * the operator can demand a margin floor (default 0 = break-even).
     *
     * Returns { ok, reason, from, to, bestBid, ceiling, fee, target }.
     */
    forceRaiseToTop: function(rec, opts) {
        if (!rec || rec.done || rec.cancelled) return {ok:false, reason:'inactive'};
        if (!rec.orderId) return {ok:false, reason:'no-orderId'};
        var order = Game.market.orders[rec.orderId];
        if (!order || order.type !== ORDER_BUY) return {ok:false, reason:'order-missing'};

        opts = opts || {};
        var edge         = typeof opts.edge === 'number'        ? opts.edge        : MAX_PRICE_OVER_BEST;
        var marginFloor  = typeof opts.marginFloor === 'number' ? opts.marginFloor : 0;

        // Best external bid - pricing cache already excludes our own rooms and
        // filters dust (< MIN_ORDER_REMAINING = 1000).
        var b = pricing.getBook(rec.resource);
        if (!b || b.bestBid === null) return {ok:false, reason:'no-competitor-bid'};

        var target = b.bestBid + edge;

        // Profitability check via fresh inputCeilings. marginFloor=0 = break-even.
        // Only factory-queue products resolve through inputCeilings (see
        // repriceUpIfNeeded); lab-queue orders fall back to jobCeiling alone.
        var ceil = null;
        if (rec.job && rec.job.product && (rec.queue || 'default') === 'factory') {
            var map = pricing.inputCeilings(rec.job.product, marginFloor);
            ceil = map ? map[rec.resource] : null;
            if (typeof ceil !== 'number' || !(ceil > 0)) {
                return {ok:false, reason:'no-ceiling', bestBid:b.bestBid, target:target,
                        msg:'inputCeilings null for ' + (rec.job && rec.job.product) +
                        ' at marginFloor=' + marginFloor};
            }
        }
        if (typeof rec.jobCeiling === 'number' && rec.jobCeiling > 0) {
            ceil = (typeof ceil === 'number' && ceil > 0) ? Math.min(ceil, rec.jobCeiling) : rec.jobCeiling;
        }
        if (typeof ceil !== 'number' || !(ceil > 0)) {
            return {ok:false, reason:'no-ceiling', bestBid:b.bestBid, target:target,
                    msg:'no margin ceiling or jobCeiling for ' + rec.resource};
        }
        if (target > ceil) {
            return {ok:false, reason:'unprofitable', bestBid:b.bestBid, target:target, ceiling:ceil,
                    msg:'target ' + target.toFixed(3) + ' > ceiling ' + ceil.toFixed(3) +
                    ' for ' + rec.resource};
        }

        if (target <= order.price + 0.0005) {
            return {ok:true, reason:'already-on-top', price:order.price, bestBid:b.bestBid, ceiling:ceil, target:target};
        }

        var fee = pricing.FEE * (target - order.price) * (order.remainingAmount || 0);
        if (creditLedger.available() < fee) {
            return {ok:false, reason:'insufficient-credits', target:target, fee:fee};
        }
        var res = Game.market.changeOrderPrice(rec.orderId, target);
        if (res !== OK) {
            return {ok:false, reason:'changeOrderPrice-failed:' + res, target:target, fee:fee};
        }
        creditLedger.commit(fee);
        rec.feesPaid = (rec.feesPaid || 0) + fee;
        rec.repriceFees = (rec.repriceFees || 0) + fee;
        rec.upReprices  = (rec.upReprices  || 0) + 1;
        rec.lastUpRepriceTick = Game.time;
        rec.price = target;
        memoryManager.requestSave();
        console.log('[MarketBuy] forceRaiseToTop ' + rec.resource + ' in ' + rec.room +
                    ' ' + order.price.toFixed(3) + ' -> ' + target.toFixed(3) +
                    ' (bestBid ' + b.bestBid.toFixed(3) + ', ceil ' + ceil.toFixed(3) +
                    ', fee ' + fee.toFixed(1) + ', marginFloor ' + marginFloor + '%)');
        return {ok:true, reason:'raised', from:order.price, to:target, bestBid:b.bestBid, ceiling:ceil, fee:fee, target:target};
    },

    cancelOrderById: function(orderId, reason, opId) {
        this.ensureMemory();
        var rec = Memory.marketBuy.orders[orderId];
        if (opId && (!rec || rec.opId !== opId)) return false;
        if (rec && (rec.done || rec.cancelled)) {
            memoryManager.requestSave();
            return true;
        }
        var result = Game.market.cancelOrder(orderId);
        if (result === OK || result === ERR_INVALID_ARGS /* already gone */) {
            if (rec) {
                this._closeRecord(rec, false);
                console.log('[MarketBuy] Cancelled order ' + orderId + ' (' + rec.resource + ' in ' + rec.room + ')' +
                    (reason ? ' - ' + reason : '') +
                    ' | filled ' + rec.fulfilledFinal + '/' + rec.target +
                    ' | fees paid ' + (rec.feesPaid || 0).toFixed(1) + ' (sunk)');
            } else {
                console.log('[MarketBuy] Cancelled untracked order ' + orderId + (reason ? ' - ' + reason : ''));
            }
            memoryManager.requestSave();
            return true;
        }
        console.log('[MarketBuy] Failed to cancel order ' + orderId + ': ' + result);
        return false;
    },

    cancelOrderFor: function(roomName, resourceType, reason, queueName, opId) {
        this.ensureMemory();
        var orders = Memory.marketBuy.orders;
        var cancelled = 0;
        for (var id in orders) {
            var rec = orders[id];
            if (rec && rec.room === roomName && rec.resource === resourceType && !rec.done && !rec.cancelled &&
                (!queueName || (rec.queue || 'default') === queueName) && (!opId || rec.opId === opId)) {
                if (this.cancelOrderById(id, reason, opId)) cancelled++;
            }
        }
        var pend = Memory.marketBuy.pending;
        for (var i = 0; i < pend.length; i++) {
            if (pend[i] && pend[i].room === roomName && pend[i].resource === resourceType &&
                (!queueName || (pend[i].queue || 'default') === queueName) && (!opId || pend[i].opId === opId)) {
                pend[i].cancelRequested = true;
                pend[i].reason = reason || 'cancel requested before order-id capture';
                cancelled++;
                memoryManager.requestSave();
            }
        }
        return cancelled;
    },

    // ===== Passive registry =====

    _passivate: function(rec, job) {
        rec.passive = true;
        rec.passiveSince = Game.time;
        if (job) rec.job = job;
        console.log('[MarketBuy] Order ' + rec.orderId + ' (' + rec.resource + ' in ' + rec.room +
            ') marked PASSIVE; cancels on margin collapse (<' + PASSIVE_MARGIN_FLOOR +
            '%) or ' + PASSIVE_STALL_TICKS + '-tick fill stall.');
    },

    markPassiveFor: function(roomName, resourceType, job, opId) {
        this.ensureMemory();
        var ownerOpId = opId || (job && job.opId) || null;
        var orders = Memory.marketBuy.orders;
        for (var id in orders) {
            var rec = orders[id];
            if (rec && rec.room === roomName && rec.resource === resourceType && !rec.done && !rec.cancelled &&
                (!ownerOpId || rec.opId === ownerOpId)) {
                this._passivate(rec, job);
                return true;
            }
        }
        return false;
    },

    // Compat alias used by marketRefine: passivate by order id.
    passivateOrder: function(orderId, product, opId) {
        this.ensureMemory();
        var rec = Memory.marketBuy.orders[orderId];
        if (!rec || rec.done || rec.cancelled || (opId && rec.opId !== opId)) return false;
        this._passivate(rec, product ? { product: product, room: rec.room } : rec.job);
        return true;
    },

    // Compat alias: dispatcher code may call marketBuyer.getPriceRange.
    getPriceRange: function(resourceType) {
        return pricing.getRange7d(resourceType);
    },

    // ===== v1 API compatibility shims =====
    // Methods from the old marketBuyer that other modules (marketArbitrage, etc.)
    // still call. Kept thin: real logic lives in marketPricing / this module.

    // v1: best external bid + 0.1, falling back to 95% of the 2-day average.
    computeBuyPrice: function(resourceType) {
        return pricing.actualBuyPrice(resourceType);
    },

    // v1: total of a resource in the room (terminal + everything outside it).
    getRoomTotalAvailable: function(roomName, resourceType) {
        var room = Game.rooms[roomName];
        if (!room) return 0;
        var total = 0;
        if (room.terminal && room.terminal.store && room.terminal.store[resourceType]) {
            total += room.terminal.store[resourceType];
        }
        if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === 'function') {
            total += terminalManager.getRoomAvailableOutsideTerminal(roomName, resourceType) || 0;
        }
        return total;
    },

    // v1: cancel fully-filled BUY orders. v2 closes its own tracked orders in
    // _manageOrders, so this only sweeps UNTRACKED leftovers (manual orders,
    // pre-v2 orders) to free order slots.
    cleanupFulfilledOrders: function() {
        this.ensureMemory();
        var tracked = Memory.marketBuy.orders;
        var cancelledCount = 0;
        for (var orderId in Game.market.orders) {
            if (tracked[orderId]) continue;
            var order = Game.market.orders[orderId];
            if (!order) continue;
            var pending = Memory.marketBuy.pending;
            var awaitingCapture = false;
            for (var i = 0; i < pending.length; i++) {
                var p = pending[i];
                if (p && order.roomName === p.room && order.resourceType === p.resource &&
                    order.created === p.createdTick && order.totalAmount === p.trancheTotal &&
                    Math.abs(order.price - p.price) < 0.001) {
                    awaitingCapture = true;
                    break;
                }
            }
            if (awaitingCapture) continue;
            if (order.type === ORDER_BUY && order.remainingAmount === 0) {
                if (Game.market.cancelOrder(orderId) === OK) {
                    cancelledCount++;
                    memoryManager.requestSave();
                    console.log('[MarketBuy] Auto-cancelled fulfilled untracked order: ' + orderId);
                }
            }
        }
        return cancelledCount;
    },

    // v1: cancel a credit-gather op by id.
    cancelGather: function(id) {
        this.ensureMemory();
        var ops = Memory.marketBuy.operations;
        for (var i = ops.length - 1; i >= 0; i--) {
            if (ops[i] && ops[i].id === id) {
                ops.splice(i, 1);
                return '[MarketBuy] Cancelled gather op: ' + id;
            }
        }
        return '[MarketBuy] Gather op not found: ' + id;
    },

    // ===== Main API =====

    /**
     * marketBuy(roomName, resourceType, amount[, price][, job])
     * job (optional): { product, room, ceiling, queue, opId } links ownership and
     * supplies the hard caller ceiling used by this module's repricer.
     */
    marketBuy: function(roomName, resourceType, amount, price, job) {
        this.installGetResourceNeededHook();
        this.ensureMemory();

        if (!terminalManager || typeof terminalManager.validateResource !== 'function' ||
            !terminalManager.validateResource(resourceType)) {
            return '[MarketBuy] Invalid resource type: ' + resourceType;
        }
        if (!amount || amount <= 0) return '[MarketBuy] Invalid amount: ' + amount;

        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) {
            return '[MarketBuy] Invalid room: ' + roomName + '. Must be a room you own.';
        }
        if (!room.terminal) return '[MarketBuy] Room ' + roomName + ' has no terminal.';

        var queueName = this.getQueue(job);
        var opId = job && job.opId ? job.opId : null;

        // One LIVE managed order per room+resource+queue (tombstones don't block).
        var existing = this.getOrderRecordFor(roomName, resourceType, queueName, opId);
        if (existing && !existing.done && !existing.cancelled) {
            // If the underlying order is empty (tranche consumed, extend stuck)
            // or gone entirely, reclaim it: close the record as partial-done and
            // let the new order proceed. Only a live order with stock remaining
            // still blocks.
            var liveOrder = existing.orderId ? Game.market.orders[existing.orderId] : null;
            var reclaimable = !!existing.orderId && (!liveOrder || liveOrder.remainingAmount === 0);
            if (reclaimable) {
                if (liveOrder && Game.market.cancelOrder(existing.orderId) === OK) memoryManager.requestSave();
                this._closeRecord(existing, true); // done w/ partial fill -> tombstone
                memoryManager.requestSave();
                console.log('[MarketBuy] Reclaimed stale order for ' + resourceType + ' in ' + roomName +
                    ' (0 remaining/missing); filled ' + (existing.fulfilledFinal || 0) + '/' + existing.target +
                    '. Creating fresh order.');
            } else {
                return '[MarketBuy] Managed order already exists for ' + resourceType + ' in ' + roomName + ' [' + queueName + ']' +
                       '. Cancel it first (cancelMarketBuyOrder).';
            }
        }

        var finalPrice = price;
        if (typeof finalPrice !== 'number') finalPrice = pricing.actualBuyPrice(resourceType);
        if (job && typeof job.ceiling === 'number' && job.ceiling > 0) {
            if (job.ceiling < 0.001) return '[MarketBuy] Job ceiling is below the minimum market price: ' + job.ceiling;
            finalPrice = Math.min(finalPrice, job.ceiling);
        }
        // The server stores prices in millicredits; an unrounded price (e.g. a
        // vwAsk-anchored bid) would never match the live order during id capture.
        finalPrice = Math.round(finalPrice * 1000) / 1000;
        if (finalPrice < 0.001) finalPrice = 0.001;

        // Tranche: create small, extend as it fills. The 5% fee is sunk on creation
        // (never refunded - not on cancel, not at 30-day expiry), so never expose
        // the whole target up front.
        var tranche = Math.min(amount, Math.max(MIN_TRANCHE, Math.ceil(amount * TRANCHE_RATIO)));
        var creationFee = pricing.FEE * finalPrice * tranche;
        // Fees settle at end-of-tick intent processing; check against the shared
        // per-tick ledger, or spends by other modules this tick (deal buys, sell
        // fees) can overdraw and this intent fails silently after returning OK.
        if (creditLedger.available() < creationFee) {
            return '[MarketBuy] Insufficient credits for BUY order fee: need ' + creationFee.toFixed(1) +
                   ', have ' + creditLedger.available().toFixed(1) +
                   ' (' + creditLedger.committedThisTick().toFixed(1) + ' committed this tick)';
        }

        var pending = Memory.marketBuy.pending;
        for (var pi = 0; pi < pending.length; pi++) {
            var same = pending[pi];
            if (same && same.room === roomName && same.resource === resourceType &&
                same.createdTick === Game.time && same.trancheTotal === tranche &&
                Math.abs(same.price - finalPrice) < 0.001) {
                return '[MarketBuy] Identical BUY order is already pending capture this tick; retry next tick.';
            }
        }

        var result = Game.market.createOrder({
            type: ORDER_BUY,
            resourceType: resourceType,
            price: finalPrice,
            totalAmount: tranche,
            roomName: roomName
        });

        if (result !== OK) {
            return '[MarketBuy] Failed to create BUY order: ' + result +
                   ' (room ' + roomName + ', ' + resourceType + ' x ' + tranche + ' @ ' + finalPrice + ')';
        }
        creditLedger.commit(creationFee);

        // The new order is NOT visible in Game.market.orders until next tick:
        // queue for id capture, resolved in run().
        Memory.marketBuy.pending.push({
            room: roomName, resource: resourceType,
            queue: queueName,
            opId: opId,
            target: amount, price: finalPrice,
            trancheTotal: tranche,
            feesPaid: creationFee,
            repriceFees: 0,
            job: job || null,
            jobCeiling: (job && typeof job.ceiling === 'number' && job.ceiling > 0) ? job.ceiling : null,
            upReprices: 0,
            lastUpRepriceTick: 0,
            createdTick: Game.time,
            orderId: null
        });
        memoryManager.requestSave();

        return '[MarketBuy] Created BUY order from ' + roomName + ': tranche ' + tranche + '/' + amount + ' ' +
               resourceType + ' @ ' + finalPrice.toFixed(3) +
               ' (fee ' + (pricing.FEE * finalPrice * tranche).toFixed(1) + ', extends on fills; id captured next tick)' +
               (job ? ' [job: ' + job.product + ']' : '');
    },

    /**
     * Compat wrapper for doc-7-style callers expecting {ok, orderId, message}.
     * orderId is ALWAYS null here (sync capture is impossible in Screeps) -
     * poll getOrderRecordFor(room, resource) for rec.orderId on later ticks.
     */
    createBuyOrder: function(roomName, resourceType, amount, maxPrice, opts) {
        var job = opts ? { product: opts.product || null, room: roomName, queue: opts.queue || opts.scope, opId: opts.opId || null,
                           ceiling: opts.ceiling } : null;
        var msg = this.marketBuy(roomName, resourceType, amount, maxPrice, job);
        var ok = typeof msg === 'string' && msg.indexOf('Created BUY order') >= 0;
        return { ok: ok, orderId: null, message: msg };
    },

    // ===== Per-tick management =====

    run: function() {
        this.installGetResourceNeededHook();
        this.ensureMemory();

        this._resolvePendingCaptures();
        if (Game.time % MANAGE_INTERVAL === 0) this._manageOrders();
        if (Game.time % 100 === 0) this._cleanupGatherOps();
        if (Game.time % 100 === 0) this.cleanupFulfilledOrders(); // sweep untracked empties
    },

    _resolvePendingCaptures: function() {
        var pend = Memory.marketBuy.pending;
        if (pend.length === 0) return;

        var tracked = Memory.marketBuy.orders;
        for (var i = pend.length - 1; i >= 0; i--) {
            var p = pend[i];
            if (!p) { pend.splice(i, 1); continue; }

            var matches = [];
            for (var id in Game.market.orders) {
                if (tracked[id]) continue;
                var o = Game.market.orders[id];
                if (!o || o.type !== ORDER_BUY) continue;
                if (o.resourceType !== p.resource || o.roomName !== p.room) continue;
                if (typeof o.created !== 'number' || o.created !== p.createdTick) continue;
                if (typeof o.totalAmount !== 'number' || o.totalAmount !== p.trancheTotal) continue;
                if (Math.abs(o.price - p.price) >= 0.001) continue; // server keeps 3 decimals; stub may hold an unrounded legacy price
                matches.push(o);
            }

            var found = matches.length === 1 ? matches[0] : null;
            if (found) {
                var competingPending = 0;
                for (var j = 0; j < pend.length; j++) {
                    var other = pend[j];
                    if (other && other.room === found.roomName && other.resource === found.resourceType &&
                        other.createdTick === found.created && other.trancheTotal === found.totalAmount &&
                        Math.abs(other.price - found.price) < 0.001) competingPending++;
                }
                if (competingPending !== 1) found = null;
            }

            if (found) {
                tracked[found.id] = {
                    orderId: found.id,
                    room: p.room, resource: p.resource,
                    queue: p.queue || 'default',
                    opId: p.opId || null,
                    target: p.target, price: found.price,
                    trancheTotal: p.trancheTotal,
                    feesPaid: p.feesPaid, repriceFees: p.repriceFees,
                    job: p.job,
                    jobCeiling: p.jobCeiling || null,
                    upReprices: p.upReprices || 0,
                    lastUpRepriceTick: p.lastUpRepriceTick || 0,
                    created: p.createdTick,
                    lastRemaining: found.remainingAmount,
                    lastProgressTick: Game.time,
                    passive: false,
                    done: false, cancelled: false,
                    cancelRequested: !!p.cancelRequested,
                    reason: p.reason || null
                };
                pend.splice(i, 1);
                memoryManager.requestSave();
                console.log('[MarketBuy] Captured order id ' + found.id + ' for ' + p.resource + ' in ' + p.room + ' [' + (p.queue || 'default') + ']');
                if (p.cancelRequested) this.cancelOrderById(found.id, p.reason, p.opId || null);
            } else if (Game.time - p.createdTick > PENDING_HARD_TTL) {
                console.log('[MarketBuy] Dropping unresolved capture metadata for ' + p.resource + ' in ' + p.room +
                    ' after ' + PENDING_HARD_TTL + ' ticks with no matching live order.');
                pend.splice(i, 1);
                memoryManager.requestSave();
            } else if (Game.time - p.createdTick > PENDING_CAPTURE_TTL) {
                // Field-by-field near-misses: shows WHICH fingerprint field
                // mismatched, or that the createOrder intent never materialized.
                var near = [];
                for (var nid in Game.market.orders) {
                    if (tracked[nid]) continue;
                    var no = Game.market.orders[nid];
                    if (!no || no.type !== ORDER_BUY) continue;
                    if (no.resourceType !== p.resource || no.roomName !== p.room) continue;
                    near.push(nid + ' created ' + no.created + ' vs ' + p.createdTick +
                        ', total ' + no.totalAmount + ' vs ' + p.trancheTotal +
                        ', price ' + no.price + ' vs ' + p.price);
                }
                if (near.length === 0 && Game.time - p.createdTick > PENDING_CAPTURE_TTL * 3) {
                    // No live order for this room+resource at all: the intent
                    // failed server-side after returning OK (credit overdraw).
                    // Drop the stub now so the caller can retry, instead of
                    // blocking the room+resource slot for PENDING_HARD_TTL.
                    console.log('[MarketBuy] Dropping phantom capture stub for ' + p.resource + ' in ' + p.room +
                        ' (age ' + (Game.time - p.createdTick) + '): no live order exists; the createOrder intent failed after returning OK.');
                    pend.splice(i, 1);
                    memoryManager.requestSave();
                } else if (!p.lastCaptureWarning || Game.time - p.lastCaptureWarning >= 1000) {
                    p.lastCaptureWarning = Game.time;
                    memoryManager.requestSave();
                    console.log('[MarketBuy] WARNING: pending id capture remains unresolved for ' + p.resource + ' in ' + p.room +
                        ' (age ' + (Game.time - p.createdTick) + '); near-miss untracked orders [live vs stub]: ' + near.join(' | '));
                }
            }
        }
    },

    _manageOrders: function() {
        var orders = Memory.marketBuy.orders;
        for (var id in orders) {
            var rec = orders[id];
            if (!rec) { delete orders[id]; continue; }

            // Tombstone lifecycle
            if (rec.done || rec.cancelled) {
                if (Game.time - (rec.closedTick || 0) > TOMBSTONE_TTL) delete orders[id];
                continue;
            }

            if (rec.cancelRequested) {
                this.cancelOrderById(id, rec.reason, rec.opId || null);
                continue;
            }

            var o = Game.market.orders[id];
            if (!o) {
                // Order gone outside our control (30-day expiry, manual cancel).
                if (!rec.cancelled && !rec.done) {
                    console.log('[MarketBuy] Order ' + id + ' (' + rec.resource + ' in ' + rec.room +
                        ') no longer exists; closing record. Filled ~' +
                        Math.max(0, (rec.trancheTotal || 0) - (rec.lastRemaining || 0)) + '/' + rec.target);
                    var finalFill = Math.max(0, (rec.trancheTotal || 0) - (rec.lastRemaining || 0));
                    this._closeRecord(rec, false, finalFill);
                }
                memoryManager.requestSave();
                continue;
            }

            // Fill progress tracking
            if (o.remainingAmount !== rec.lastRemaining) {
                rec.lastRemaining = o.remainingAmount;
                rec.lastProgressTick = Game.time;
            }
            rec.price = o.price; // keep in sync after reprices

            var fulfilled = Math.max(0, rec.trancheTotal - o.remainingAmount);

            // Target met -> close out as DONE (tombstone kept for marketRefine).
            if (fulfilled >= rec.target) {
                console.log('[MarketBuy] Order ' + id + ' COMPLETE: ' + fulfilled + '/' + rec.target + ' ' +
                    rec.resource + ' in ' + rec.room + ' | total fees ' + (rec.feesPaid || 0).toFixed(1));
                if (Game.market.cancelOrder(id) === OK) memoryManager.requestSave(); // close any residual capacity
                this._closeRecord(rec, true);
                rec.fulfilledFinal = fulfilled;
                memoryManager.requestSave();
                continue;
            }

            if (roomSuspender.shouldAvoidRoomWork(rec.room)) continue;

            // Extend when the current tranche is nearly consumed (active orders only -
            // passive orders run down what's already paid for, no new fees).
            if (!rec.passive && rec.trancheTotal < rec.target) {
                var trancheSize = Math.max(MIN_TRANCHE, Math.ceil(rec.target * TRANCHE_RATIO));
                if (o.remainingAmount <= Math.ceil(trancheSize * EXTEND_TRIGGER_RATIO)) {
                    var add = Math.min(trancheSize, rec.target - rec.trancheTotal);
                    if (add > 0) {
                        var fee = pricing.FEE * o.price * add;
                        var res = creditLedger.available() >= fee ? Game.market.extendOrder(id, add) : ERR_NOT_ENOUGH_RESOURCES;
                        if (res === OK) {
                            creditLedger.commit(fee);
                            rec.trancheTotal += add;
                            rec.feesPaid = (rec.feesPaid || 0) + fee;
                            rec.extendFailSince = null;
                            memoryManager.requestSave();
                            console.log('[MarketBuy] Extended order ' + id + ' by ' + add + ' (' + rec.resource +
                                ', fee ' + fee.toFixed(1) + '); capacity ' + rec.trancheTotal + '/' + rec.target);
                        } else {
                            if (!rec.extendFailSince) {
                                rec.extendFailSince = Game.time;
                                console.log('[MarketBuy] WARNING: extendOrder failed for ' + id + ' (' +
                                    rec.resource + ' in ' + rec.room + '): ' + res +
                                    ' - will close as partial-done if still failing in 1000 ticks');
                            } else if (Game.time - rec.extendFailSince > 1000 && o.remainingAmount === 0) {
                                // Tranche fully consumed and we can't extend: close out as DONE
                                // with the partial fill so marketRefine reads the tombstone
                                // instead of a live record blocking new ops forever.
                                console.log('[MarketBuy] Order ' + id + ' stuck (extend failing ' + res +
                                    ', 0 remaining); closing as partial: ' +
                                    Math.max(0, rec.trancheTotal - o.remainingAmount) + '/' + rec.target);
                                if (Game.market.cancelOrder(id) === OK) memoryManager.requestSave();
                                this._closeRecord(rec, true);
                                memoryManager.requestSave();
                                continue;
                            }
                        }
                    }
                }
            }

            // Up-reprice: stay on top of the book for standing BUY orders.
            // No-op for passive / done / cancelled / orders that have room
            // to grow on the existing tranche without repricing.
            this.repriceUpIfNeeded(rec);

            // Passive audit: margin collapse or fill stall -> cancel.
            if (rec.passive) {
                var kill = null;
                if (Game.time - (rec.lastProgressTick || rec.passiveSince || rec.created) > PASSIVE_STALL_TICKS) {
                    kill = 'passive fill stall (' + PASSIVE_STALL_TICKS + ' ticks, no progress)';
                } else if (rec.job && rec.job.product && (rec.queue || 'default') === 'factory') {
                    // Same factory-queue scoping as repriceUpIfNeeded: lab-queue
                    // job.product values (reaction compounds) never resolve through
                    // inputCeilings, so skip this recompute for them rather than
                    // false-killing on null.
                    var ceilings = pricing.inputCeilings(rec.job.product, PASSIVE_MARGIN_FLOOR);
                    var ceil = ceilings ? ceilings[rec.resource] : null;
                    if (typeof ceil === 'number' && ceil > 0 && typeof rec.jobCeiling === 'number' && rec.jobCeiling > 0) {
                        ceil = Math.min(ceil, rec.jobCeiling);
                    }
                    if (typeof ceil !== 'number' || !(ceil > 0) || o.price > ceil) {
                        kill = 'passive margin collapse (price ' + o.price.toFixed(3) +
                               ' vs floor ceiling ' + (typeof ceil === 'number' ? ceil.toFixed(3) : 'none') + ')';
                    }
                }
                if (kill) this.cancelOrderById(id, kill);
            }
        }
    },

    _cleanupGatherOps: function() {
        var ops = Memory.marketBuy.operations;
        if (ops.length > 0) ops.splice(0, ops.length);
    },

    // ===== Console =====

    status: function() {
        this.ensureMemory();
        var lines = ['=== MARKET BUY (managed orders) ==='];
        var orders = Memory.marketBuy.orders;
        var any = false;
        for (var id in orders) {
            var rec = orders[id];
            if (!rec) continue;
            any = true;
            if (rec.done || rec.cancelled) {
                lines.push('  ' + id + ' | ' + rec.resource + ' in ' + rec.room +
                    ' [' + (rec.queue || 'default') + ']' +
                    ' | ' + (rec.done ? 'DONE' : 'CANCELLED') + ' filled ' + (rec.fulfilledFinal || 0) + '/' + rec.target +
                    ' | fees ' + (rec.feesPaid || 0).toFixed(1) + ' | tombstone');
                continue;
            }
            var o = Game.market.orders[id];
            var fulfilled = o ? Math.max(0, rec.trancheTotal - o.remainingAmount) : '?';
            lines.push('  ' + id + ' | ' + rec.resource + ' in ' + rec.room +
                ' [' + (rec.queue || 'default') + ']' +
                ' | ' + fulfilled + '/' + rec.target + ' @ ' + rec.price.toFixed(3) +
                ' | capacity ' + rec.trancheTotal +
                ' | fees ' + (rec.feesPaid || 0).toFixed(1) +
                (rec.passive ? ' | PASSIVE since ' + rec.passiveSince : '') +
                (rec.job ? ' | job: ' + rec.job.product : ''));
        }
        if (!any) lines.push('  (none)');
        var pend = Memory.marketBuy.pending;
        if (pend.length > 0) lines.push('  pending id capture: ' + pend.length);
        var gops = Memory.marketBuy.operations;
        if (gops.length > 0) lines.push('  gather ops: ' + gops.length);
        console.log(lines.join('\n'));
        return '[MarketBuy] Status printed.';
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====
global.marketBuy = function(roomName, resourceType, amount, price, job) {
    return marketBuyer.marketBuy(roomName, resourceType, amount, price, job);
};
global.marketBuyStatus = function() { return marketBuyer.status(); };
global.cancelMarketBuyOrder = function(idOrRoom, resourceType) {
    if (resourceType !== undefined) {
        var n = marketBuyer.cancelOrderFor(idOrRoom, resourceType, 'console');
        return '[MarketBuy] Cancelled ' + n + ' order(s) for ' + resourceType + ' in ' + idOrRoom;
    }
    return marketBuyer.cancelOrderById(idOrRoom, 'console')
        ? '[MarketBuy] Cancelled ' + idOrRoom : '[MarketBuy] Cancel failed for ' + idOrRoom;
};
global.cancelMarketBuyGather = function(id) {
    marketBuyer.ensureMemory();
    var ops = Memory.marketBuy.operations;
    for (var i = ops.length - 1; i >= 0; i--) {
        if (ops[i] && ops[i].id === id) { ops.splice(i, 1); return '[MarketBuy] Cancelled gather op: ' + id; }
    }
    return '[MarketBuy] Gather op not found: ' + id;
};
// One-shot recovery: force a managed BUY order above the best external bid
// (>= 1000 remaining), gated by an inputCeilings-derived margin floor. Use to
// recover a stalled order that the regular reprice loop couldn't keep up with.
//   marketBuyForceRaiseToTop('W1N1', 'H')              -> break-even (0% margin)
//   marketBuyForceRaiseToTop('W1N1', 'H', {marginFloor: 20})  -> require 20% margin
//   marketBuyForceRaiseToTop('W1N1', 'H', {marginFloor: 40})  -> require 40% margin
global.marketBuyForceRaiseToTop = function(roomName, resourceType, opts) {
    marketBuyer.ensureMemory();
    var orders = Memory.marketBuy.orders;
    for (var id in orders) {
        var rec = orders[id];
        if (rec && rec.room === roomName && rec.resource === resourceType && !rec.done && !rec.cancelled) {
            return marketBuyer.forceRaiseToTop(rec, opts);
        }
    }
    return {ok:false, reason:'no-live-order', msg:'No live managed order for ' + resourceType + ' in ' + roomName};
};

module.exports = marketBuyer;
