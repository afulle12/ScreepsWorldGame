/**
 * marketBuy.js (v2.1)
 *
 * Standing BUY order management. THE single owner of Memory.marketBuy.
 *
 * Memory layout:
 *   Memory.marketBuy.operations  - legacy credit-gather ops (terminalManager hook)
 *   Memory.marketBuy.orders      - orderId -> managed order record
 *   Memory.marketBuy.pending     - awaiting async order-id capture
 *
 * IMPORTANT: Game.market.createOrder returns OK only; the order does NOT appear
 * in Game.market.orders until the NEXT tick. Order ids therefore CANNOT be
 * returned synchronously. Callers (marketRefine) must poll
 * getOrderRecordFor(room, resource) until rec.orderId is populated.
 *
 * Records:
 *   { orderId, room, resource, target, price, trancheTotal, feesPaid, repriceFees,
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
 *   getOrderRecordFor(room, res)  -> record | null  (includes pending + tombstones)
 *   getManagedOrders()            -> Memory.marketBuy.orders
 *   getFulfilled(rec)             -> units acquired so far (tombstone-aware)
 *   cancelOrderById(id[, reason]) -> bool
 *   cancelOrderFor(room, res[, reason]) -> count
 *   markPassiveFor(room, res[, job])    -> bool
 *   passivateOrder(orderId[, product])  -> bool      (compat alias, by id)
 *   addRepriceFee(orderId, fee) / repriceBudgetRemaining(orderId)
 *   getPriceRange(res)            -> compat alias for marketPricing.getRange7d
 *   run()                         - call every tick from main loop
 *
 * Requires: marketPricing.js, terminalManager.js
 */

var terminalManager = require('terminalManager');
var pricing = require('marketPricing');

// ===== Configuration =====
var TRANCHE_RATIO = 0.25;          // initial order size as a fraction of target
var MIN_TRANCHE = 2000;            // never create an order smaller than this (unless target is)
var EXTEND_TRIGGER_RATIO = 0.25;   // extend when remaining drops to this fraction of a tranche
var PASSIVE_STALL_TICKS = 20000;   // cancel passive orders with no fill progress for this long
var PASSIVE_MARGIN_FLOOR = 20;     // passive orders survive while this margin % is achievable
var PENDING_CAPTURE_TTL = 10;      // ticks to wait for a created order to appear
var REPRICE_BUDGET_RATIO = 0.05;   // max repricing fees as a fraction of order value
var TOMBSTONE_TTL = 5000;          // keep completed/cancelled records this long for callers

// ===== Reprice-UP config (v3) =====
// Standing BUY orders can be undercut by competing bidders. Without reprice-UP
// the order's lead over the book evaporates and the order stalls at the
// original price. These limits keep the fee budget bounded.
var MAX_UP_REPRICES     = 12;       // hard cap on reprice-up events per order (4 was too tight for 3x market moves)
var UP_REPRICE_GATE     = 10;       // min ticks between reprice-up attempts per order
var MAX_PRICE_OVER_BEST = 0.1;      // lead we try to maintain over bestBid

var marketBuyer = {

    // ===== Memory =====
    ensureMemory: function() {
        if (!Memory.marketBuy) Memory.marketBuy = {};
        if (!Array.isArray(Memory.marketBuy.operations)) Memory.marketBuy.operations = [];
        if (!Memory.marketBuy.orders) Memory.marketBuy.orders = {};
        if (!Array.isArray(Memory.marketBuy.pending)) Memory.marketBuy.pending = [];
    },

    // ===== Legacy terminalManager hook (unchanged behavior) =====
    installGetResourceNeededHook: function() {
        if (!terminalManager) return;
        if (terminalManager._marketBuyHookInstalled) return;
        if (typeof terminalManager.getResourceNeeded !== 'function') return;

        terminalManager._marketBuy_originalGetResourceNeeded = terminalManager.getResourceNeeded;
        terminalManager.getResourceNeeded = function(roomName, resourceType) {
            var base = terminalManager._marketBuy_originalGetResourceNeeded(roomName, resourceType);
            var extra = 0;
            var ops = (Memory.marketBuy && Array.isArray(Memory.marketBuy.operations)) ? Memory.marketBuy.operations : [];
            for (var i = 0; i < ops.length; i++) {
                var op = ops[i];
                if (!op) continue;
                if (op.roomName !== roomName) continue;
                if (op.status === 'completed' || op.status === 'cancelled') continue;
                if (typeof op.expires === 'number' && Game.time > op.expires) continue;
                if (resourceType === RESOURCE_ENERGY) {
                    var room = Game.rooms[roomName];
                    var haveCredits = 0;
                    if (room && room.terminal && room.terminal.store && room.terminal.store[RESOURCE_ENERGY]) {
                        haveCredits = room.terminal.store[RESOURCE_ENERGY];
                    }
                    var need = Math.max(0, op.targetCredits - haveCredits);
                    if (need > 0) extra += need;
                }
            }
            return base + extra;
        };
        terminalManager._marketBuyHookInstalled = true;
    },

    createGatherOp: function(roomName, resourceType, amount, price) {
        this.ensureMemory();
        var targetCredits = amount * price;
        var ops = Memory.marketBuy.operations;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;
            if (op.roomName === roomName && op.status !== 'cancelled' && op.status !== 'completed') {
                op.targetCredits = Math.max(op.targetCredits || 0, targetCredits);
                op.expires = Game.time + 10000;
                return op.id;
            }
        }
        var newOp = {
            id: 'marketbuy_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName, resourceType: resourceType,
            amount: amount, price: price, targetCredits: targetCredits,
            status: 'active', created: Game.time, expires: Game.time + 10000
        };
        ops.push(newOp);
        return newOp.id;
    },

    // ===== Order record helpers =====

    getManagedOrders: function() {
        this.ensureMemory();
        return Memory.marketBuy.orders;
    },

    // Returns the LIVE record first, then a pending-capture stub, then the most
    // recent tombstone. Callers should check rec.done / rec.cancelled.
    getOrderRecordFor: function(roomName, resourceType) {
        this.ensureMemory();
        var orders = Memory.marketBuy.orders;
        var tombstone = null;
        for (var id in orders) {
            var rec = orders[id];
            if (!rec || rec.room !== roomName || rec.resource !== resourceType) continue;
            if (rec.done || rec.cancelled) {
                if (!tombstone || (rec.closedTick || 0) > (tombstone.closedTick || 0)) tombstone = rec;
                continue;
            }
            return rec; // live record
        }
        var pend = Memory.marketBuy.pending;
        for (var i = 0; i < pend.length; i++) {
            if (pend[i] && pend[i].room === roomName && pend[i].resource === resourceType) return pend[i];
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

    _closeRecord: function(rec, asDone) {
        rec.fulfilledFinal = this.getFulfilled(rec);
        if (asDone) rec.done = true; else rec.cancelled = true;
        rec.closedTick = Game.time;
        rec.passive = false;
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
     * rec.jobCeiling (if set by the caller at placement) is kept as a raise-only
     * floor: a manual raise via forceRaiseToTop bumps it up, and the regular
     * reprice loop will never lower it.
     *
     * If the required new price exceeds the live ceiling, the order is
     * passivated (kept alive for partial fill) instead of repriced.
     */
    repriceUpIfNeeded: function(rec) {
        if (!rec || rec.passive || rec.done || rec.cancelled) return false;
        if (!rec.orderId) return false;
        var order = Game.market.orders[rec.orderId];
        if (!order || order.type !== ORDER_BUY) return false;

        var b = pricing.getBook(rec.resource);
        if (!b || b.bestBid === null) return false;

        // Ceiling is recomputed each tick from current market state, not frozen
        // at placement. A frozen ceiling from a low-margin moment prevents us
        // from following a rising market; recomputing lets the order chase the
        // book up to whatever the current product margin allows. rec.jobCeiling
        // (if set by the caller) is kept as a raise-only floor so manual raises
        // via forceRaiseToTop are never lost.
        var ceiling = Infinity;
        if (rec.job && rec.job.product) {
            var map = pricing.inputCeilings(rec.job.product, PASSIVE_MARGIN_FLOOR);
            var live = map ? map[rec.resource] : null;
            if (typeof live === 'number' && live > 0) ceiling = live;
        }
        if (typeof rec.jobCeiling === 'number' && rec.jobCeiling > 0 && rec.jobCeiling > ceiling) {
            ceiling = rec.jobCeiling;
        }
        var target = Math.min(b.bestBid + MAX_PRICE_OVER_BEST, ceiling);
        if (target <= order.price + 0.0005) return false;

        if ((rec.upReprices || 0) >= MAX_UP_REPRICES) {
            this.passivateOrder(rec.orderId, rec.job && rec.job.product);
            console.log('[MarketBuy] Up-reprice cap hit for ' + rec.resource + ' in ' + rec.room +
                        ' (order ' + rec.orderId + '). Passivating at ' + order.price.toFixed(3));
            return false;
        }
        if (Game.time - (rec.lastUpRepriceTick || rec.created || 0) < UP_REPRICE_GATE) return false;

        var fee = pricing.FEE * target * (order.remainingAmount || 0);
        var remaining = this.repriceBudgetRemaining(rec.orderId);
        if (fee > remaining) {
            this.passivateOrder(rec.orderId, rec.job && rec.job.product);
            console.log('[MarketBuy] Up-reprice fee ' + fee.toFixed(1) + ' exceeds budget ' +
                        remaining.toFixed(1) + ' for ' + rec.resource + ' in ' + rec.room + '. Passivating.');
            return false;
        }

        var res = Game.market.changeOrderPrice(rec.orderId, target);
        if (res === OK) {
            rec.repriceFees = (rec.repriceFees || 0) + fee;
            rec.upReprices  = (rec.upReprices  || 0) + 1;
            rec.lastUpRepriceTick = Game.time;
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
     * stalled order where the regular reprice loop couldn't keep up (capped by
     * 4-reprice / 50-tick gate / 2% budget, or by a frozen jobCeiling).
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
        var ceil = null;
        if (rec.job && rec.job.product) {
            var map = pricing.inputCeilings(rec.job.product, marginFloor);
            ceil = map ? map[rec.resource] : null;
        }
        if (typeof ceil !== 'number' || !(ceil > 0)) {
            return {ok:false, reason:'no-ceiling', bestBid:b.bestBid, target:target,
                    msg:'inputCeilings null for ' + (rec.job && rec.job.product) +
                    ' at marginFloor=' + marginFloor};
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
        var res = Game.market.changeOrderPrice(rec.orderId, target);
        if (res !== OK) {
            return {ok:false, reason:'changeOrderPrice-failed:' + res, target:target, fee:fee};
        }
        rec.repriceFees = (rec.repriceFees || 0) + fee;
        rec.upReprices  = (rec.upReprices  || 0) + 1;
        rec.lastUpRepriceTick = Game.time;
        rec.price = target;
        // Raise-only: never lower the floor, just bump it up so the regular
        // reprice loop doesn't try to passivate the freshly-raised order.
        if (typeof rec.jobCeiling !== 'number' || rec.jobCeiling < target) rec.jobCeiling = target;
        console.log('[MarketBuy] forceRaiseToTop ' + rec.resource + ' in ' + rec.room +
                    ' ' + order.price.toFixed(3) + ' -> ' + target.toFixed(3) +
                    ' (bestBid ' + b.bestBid.toFixed(3) + ', ceil ' + ceil.toFixed(3) +
                    ', fee ' + fee.toFixed(1) + ', marginFloor ' + marginFloor + '%)');
        return {ok:true, reason:'raised', from:order.price, to:target, bestBid:b.bestBid, ceiling:ceil, fee:fee, target:target};
    },

    cancelOrderById: function(orderId, reason) {
        this.ensureMemory();
        var rec = Memory.marketBuy.orders[orderId];
        var result = Game.market.cancelOrder(orderId);
        if (result === OK || result === ERR_INVALID_ARGS /* already gone */) {
            if (rec && !rec.done && !rec.cancelled) {
                this._closeRecord(rec, false);
                console.log('[MarketBuy] Cancelled order ' + orderId + ' (' + rec.resource + ' in ' + rec.room + ')' +
                    (reason ? ' - ' + reason : '') +
                    ' | filled ' + rec.fulfilledFinal + '/' + rec.target +
                    ' | fees paid ' + (rec.feesPaid || 0).toFixed(1) + ' (sunk)');
            } else if (!rec) {
                console.log('[MarketBuy] Cancelled untracked order ' + orderId + (reason ? ' - ' + reason : ''));
            }
            return true;
        }
        console.log('[MarketBuy] Failed to cancel order ' + orderId + ': ' + result);
        return false;
    },

    cancelOrderFor: function(roomName, resourceType, reason) {
        this.ensureMemory();
        var orders = Memory.marketBuy.orders;
        var cancelled = 0;
        for (var id in orders) {
            var rec = orders[id];
            if (rec && rec.room === roomName && rec.resource === resourceType && !rec.done && !rec.cancelled) {
                if (this.cancelOrderById(id, reason)) cancelled++;
            }
        }
        var pend = Memory.marketBuy.pending;
        for (var i = pend.length - 1; i >= 0; i--) {
            if (pend[i] && pend[i].room === roomName && pend[i].resource === resourceType) pend.splice(i, 1);
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

    markPassiveFor: function(roomName, resourceType, job) {
        this.ensureMemory();
        var orders = Memory.marketBuy.orders;
        for (var id in orders) {
            var rec = orders[id];
            if (rec && rec.room === roomName && rec.resource === resourceType && !rec.done && !rec.cancelled) {
                this._passivate(rec, job);
                return true;
            }
        }
        return false;
    },

    // Compat alias used by marketRefine: passivate by order id.
    passivateOrder: function(orderId, product) {
        this.ensureMemory();
        var rec = Memory.marketBuy.orders[orderId];
        if (!rec || rec.done || rec.cancelled) return false;
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
            if (order.type === ORDER_BUY && order.remainingAmount === 0) {
                if (Game.market.cancelOrder(orderId) === OK) {
                    cancelledCount++;
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
     * job (optional): { product: RESOURCE_X, room: roomName } - links the order to a
     * marketRefine op so marketUpdate can derive ceilings and expiry can find it.
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

        // One LIVE managed order per room+resource (tombstones don't block).
        var existing = this.getOrderRecordFor(roomName, resourceType);
        if (existing && !existing.done && !existing.cancelled) {
            // If the underlying order is empty (tranche consumed, extend stuck)
            // or gone entirely, reclaim it: close the record as partial-done and
            // let the new order proceed. Only a live order with stock remaining
            // still blocks.
            var liveOrder = existing.orderId ? Game.market.orders[existing.orderId] : null;
            var reclaimable = !liveOrder || liveOrder.remainingAmount === 0;
            if (reclaimable) {
                if (liveOrder) Game.market.cancelOrder(existing.orderId);
                this._closeRecord(existing, true); // done w/ partial fill -> tombstone
                console.log('[MarketBuy] Reclaimed stale order for ' + resourceType + ' in ' + roomName +
                    ' (0 remaining/missing); filled ' + (existing.fulfilledFinal || 0) + '/' + existing.target +
                    '. Creating fresh order.');
            } else {
                return '[MarketBuy] Managed order already exists for ' + resourceType + ' in ' + roomName +
                       '. Cancel it first (cancelMarketBuyOrder).';
            }
        }

        var finalPrice = price;
        if (typeof finalPrice !== 'number') finalPrice = pricing.actualBuyPrice(resourceType);
        if (finalPrice < 0.001) finalPrice = 0.001;

        // Tranche: create small, extend as it fills. The 5% fee is sunk on creation
        // (never refunded - not on cancel, not at 30-day expiry), so never expose
        // the whole target up front.
        var tranche = Math.min(amount, Math.max(MIN_TRANCHE, Math.ceil(amount * TRANCHE_RATIO)));

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

        // The new order is NOT visible in Game.market.orders until next tick:
        // queue for id capture, resolved in run().
        Memory.marketBuy.pending.push({
            room: roomName, resource: resourceType,
            target: amount, price: finalPrice,
            trancheTotal: tranche,
            feesPaid: pricing.FEE * finalPrice * tranche,
            repriceFees: 0,
            job: job || null,
            jobCeiling: (job && typeof job.ceiling === 'number' && job.ceiling > 0) ? job.ceiling : null,
            upReprices: 0,
            lastUpRepriceTick: 0,
            createdTick: Game.time,
            orderId: null
        });

        // Schedule credit gathering (legacy behavior).
        var targetCredits = amount * finalPrice;
        var haveCredits = (room.terminal.store && room.terminal.store[RESOURCE_ENERGY]) ? room.terminal.store[RESOURCE_ENERGY] : 0;
        if (haveCredits < targetCredits) this.createGatherOp(roomName, resourceType, amount, finalPrice);

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
        var job = (opts && opts.product) ? { product: opts.product, room: roomName } : null;
        var msg = this.marketBuy(roomName, resourceType, amount, maxPrice, job);
        var ok = typeof msg === 'string' && msg.indexOf('Created BUY order') >= 0;
        return { ok: ok, orderId: null, message: msg };
    },

    // ===== Per-tick management =====

    run: function() {
        this.installGetResourceNeededHook();
        this.ensureMemory();

        this._resolvePendingCaptures();
        this._manageOrders();
        this._cleanupGatherOps();
        if (Game.time % 100 === 0) this.cleanupFulfilledOrders(); // sweep untracked empties
    },

    _resolvePendingCaptures: function() {
        var pend = Memory.marketBuy.pending;
        if (pend.length === 0) return;

        var tracked = Memory.marketBuy.orders;
        for (var i = pend.length - 1; i >= 0; i--) {
            var p = pend[i];
            if (!p) { pend.splice(i, 1); continue; }

            var found = null;
            for (var id in Game.market.orders) {
                if (tracked[id]) continue;
                var o = Game.market.orders[id];
                if (!o || o.type !== ORDER_BUY) continue;
                if (o.resourceType !== p.resource || o.roomName !== p.room) continue;
                if (typeof o.created === 'number' && o.created < p.createdTick) continue;
                found = o;
                break;
            }

            if (found) {
                tracked[found.id] = {
                    orderId: found.id,
                    room: p.room, resource: p.resource,
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
                    done: false, cancelled: false
                };
                pend.splice(i, 1);
                console.log('[MarketBuy] Captured order id ' + found.id + ' for ' + p.resource + ' in ' + p.room);
            } else if (Game.time - p.createdTick > PENDING_CAPTURE_TTL) {
                console.log('[MarketBuy] WARNING: could not capture order id for ' + p.resource + ' in ' + p.room +
                    ' after ' + PENDING_CAPTURE_TTL + ' ticks; order is UNTRACKED. Check Game.market.orders manually.');
                pend.splice(i, 1);
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

            var o = Game.market.orders[id];
            if (!o) {
                // Order gone outside our control (30-day expiry, manual cancel).
                console.log('[MarketBuy] Order ' + id + ' (' + rec.resource + ' in ' + rec.room +
                    ') no longer exists; closing record. Filled ~' +
                    Math.max(0, (rec.trancheTotal || 0) - (rec.lastRemaining || 0)) + '/' + rec.target);
                rec.fulfilledFinal = Math.max(0, (rec.trancheTotal || 0) - (rec.lastRemaining || 0));
                rec.cancelled = true;
                rec.closedTick = Game.time;
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
                Game.market.cancelOrder(id); // close any residual capacity
                this._closeRecord(rec, true);
                rec.fulfilledFinal = fulfilled;
                continue;
            }

            // Extend when the current tranche is nearly consumed (active orders only -
            // passive orders run down what's already paid for, no new fees).
            if (!rec.passive && rec.trancheTotal < rec.target) {
                var trancheSize = Math.max(MIN_TRANCHE, Math.ceil(rec.target * TRANCHE_RATIO));
                if (o.remainingAmount <= Math.ceil(trancheSize * EXTEND_TRIGGER_RATIO)) {
                    var add = Math.min(trancheSize, rec.target - rec.trancheTotal);
                    if (add > 0) {
                        var res = Game.market.extendOrder(id, add);
                        if (res === OK) {
                            var fee = pricing.FEE * o.price * add;
                            rec.trancheTotal += add;
                            rec.feesPaid = (rec.feesPaid || 0) + fee;
                            rec.extendFailSince = null;
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
                                Game.market.cancelOrder(id);
                                this._closeRecord(rec, true);
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
                } else if (rec.job && rec.job.product) {
                    var ceilings = pricing.inputCeilings(rec.job.product, PASSIVE_MARGIN_FLOOR);
                    var ceil = ceilings ? ceilings[rec.resource] : null;
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
        for (var i = ops.length - 1; i >= 0; i--) {
            var op = ops[i];
            if (!op) { ops.splice(i, 1); continue; }
            var remove = false;
            if (typeof op.expires === 'number' && Game.time > op.expires) remove = true;
            if (!remove) {
                var room = Game.rooms[op.roomName];
                var haveCredits = 0;
                if (room && room.terminal && room.terminal.store && room.terminal.store[RESOURCE_ENERGY]) {
                    haveCredits = room.terminal.store[RESOURCE_ENERGY];
                }
                if (haveCredits >= (op.targetCredits || 0)) remove = true;
            }
            if (remove) ops.splice(i, 1);
        }
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
                    ' | ' + (rec.done ? 'DONE' : 'CANCELLED') + ' filled ' + (rec.fulfilledFinal || 0) + '/' + rec.target +
                    ' | fees ' + (rec.feesPaid || 0).toFixed(1) + ' | tombstone');
                continue;
            }
            var o = Game.market.orders[id];
            var fulfilled = o ? Math.max(0, rec.trancheTotal - o.remainingAmount) : '?';
            lines.push('  ' + id + ' | ' + rec.resource + ' in ' + rec.room +
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
