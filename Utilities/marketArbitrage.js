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
 * - Only self-fulfills if purchase price ≤ oppBuy maxPrice.
 * - Picks whichever option yields more value.
 * - Updates the opportunisticBuy request progress when self-fulfilling.
 *
 * Accounts for energy costs on BOTH transaction legs (receiving and sending).
 * Energy is valued using marketBuy.computeBuyPrice(RESOURCE_ENERGY).
 *
 * Filters:
 * - Buy orders must have >= MIN_BUY_ORDER_AMOUNT remaining (filters scam/dust orders).
 * - Net profit must be >= MIN_PROFIT_MARGIN of total cost (credits + energy value).
 * - Only uses terminals in rooms RCL 7+.
 *
 * State machine per terminal:
 *   idle → pending_buy_verify → pending_sell → pending_verify → idle
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
 *   pending_sell → buffered (separate from active ops, terminal freed for new arb)
 *   buffered: checked every SCAN_INTERVAL ticks using same order books as new-opportunity scan
 *   buffered → sold (profitable buy order found) or marketSell (after BUFFER_TIMEOUT ticks)
 *
 * Usage:
 *   marketArbitrage.run()                 — call every tick from main loop
 *   marketArbitrage.status()              — view active operations + buffered entries
 *   marketArbitrage.cancel(roomName)      — abort an operation or buffered entry in a room
 *   marketArbitrage.setMargin(0.05)       — change minimum profit margin
 *   marketArbitrage.setMinBuyAmount(100)  — change min buy-order size filter
 *   marketArbitrage.setBufferTimeout(10000) — change buffer hold duration
 *
 * @module marketArbitrage
 */

var marketBuyer  = require('marketBuy');
var marketSeller = require('marketSell');

// === CONFIGURATION ===
var SCAN_INTERVAL        = 6;       // Ticks between scans for opportunities
var MIN_PROFIT_MARGIN    = 0.02;    // 2 % minimum profit over total cost
var MIN_BUY_ORDER_AMOUNT = 6;       // Filter out likely-scam buy orders below this size
var MAX_SELLS_PER_RESOURCE = 10;    // CPU guard: only inspect top N cheapest sells per resource
var BUFFER_TIMEOUT       = 50000;   // Ticks to hold buffered resources before falling back to marketSell
var VERIFY_TIMEOUT       = 18;      // Ticks to wait for transaction confirmation (3 scan cycles)
var MIN_AMOUNT_PER_TERMINAL = 500;  // Minimum share per terminal when splitting
var MAX_RESOURCE_EXPOSURE = 50000;   // Max total units of one resource in-flight across ALL terminals + buffered

var GHOST_SELL_COOLDOWN   = 100;    // Ticks to blacklist a sell order after a buy ghost

var MIN_SELF_ARB_PROFIT   = 1;      // Minimum absolute credit profit for self-arb (filters dust)

// === MEMORY INIT ===
if (!Memory.marketArbitrage) {
    Memory.marketArbitrage = { operations: {}, buffered: [] };
}
if (!Memory.marketArbitrage.buffered) {
    Memory.marketArbitrage.buffered = [];
}
// ghostSellOrders: { orderId → tick } — sell orders that returned OK but no resources arrived
if (!Memory.marketArbitrage.ghostSellOrders) {
    Memory.marketArbitrage.ghostSellOrders = {};
}
// selfArbPending: { roomName → { buyOrderId, amount, tick, resourceType, ourSellOrderId, ourSellPrice, buyPrice } }
// Tracks deal() calls on external buy orders from our own sell-order terminals, pending verification.
if (!Memory.marketArbitrage.selfArbPending) {
    Memory.marketArbitrage.selfArbPending = {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getMyRooms() {
    var myRooms = {};
    for (var rn in Game.rooms) {
        var r = Game.rooms[rn];
        if (r && r.controller && r.controller.my) myRooms[rn] = true;
    }
    return myRooms;
}

/** Binary-search the largest amount whose energy cost fits within energyAvail. */
function capByEnergy(desired, fromRoom, toRoom, energyAvail) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    var low = 0, high = desired;
    while (low < high) {
        var mid = low + Math.ceil((high - low) / 2);
        if (Game.market.calcTransactionCost(mid, fromRoom, toRoom) <= energyAvail) low = mid;
        else high = mid - 1;
    }
    return low;
}

/** Binary-search largest amount whose combined energy for BOTH legs fits within energyAvail. */
function capByEnergyBothLegs(desired, ourRoom, sellRoom, buyRoom, energyAvail) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    var low = 0, high = desired;
    while (low < high) {
        var mid = low + Math.ceil((high - low) / 2);
        var cost = Game.market.calcTransactionCost(mid, ourRoom, sellRoom)
                 + Game.market.calcTransactionCost(mid, ourRoom, buyRoom);
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
 * deal(buyOrderId, amount, myRoom) → tx.from === myRoom, tx.order.id === buyOrderId
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
 * deal(sellOrderId, amount, myRoom) → tx.to === myRoom, tx.order.id === sellOrderId
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

// ─────────────────────────────────────────────────────────────────────────────
// Opportunity Scanner
// ─────────────────────────────────────────────────────────────────────────────

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

/** Build indexed order books. Returns { sellsByRes, buysByRes }. */
function buildOrderBooks(myRooms, oppBuyRequests) {
    var allSells = Game.market.getAllOrders({ type: ORDER_SELL });
    var allBuys  = Game.market.getAllOrders({ type: ORDER_BUY });

    var buysByRes = {};
    for (var i = 0; i < allBuys.length; i++) {
        var bo = allBuys[i];
        if (!bo || bo.resourceType === RESOURCE_ENERGY) continue;
        if ((bo.remainingAmount || bo.amount || 0) < MIN_BUY_ORDER_AMOUNT) continue;
        if (bo.roomName && myRooms[bo.roomName]) continue;
        if (!buysByRes[bo.resourceType]) buysByRes[bo.resourceType] = [];
        buysByRes[bo.resourceType].push(bo);
    }
    for (var res in buysByRes) buysByRes[res].sort(function (a, b) { return b.price - a.price; });

    var viable = {};
    for (var r1 in buysByRes) viable[r1] = true;
    for (var r2 in oppBuyRequests) viable[r2] = true;

    var sellsByRes = {};
    for (var j = 0; j < allSells.length; j++) {
        var so = allSells[j];
        if (!so || so.resourceType === RESOURCE_ENERGY) continue;
        if ((so.amount || 0) <= 0) continue;
        if (so.roomName && myRooms[so.roomName]) continue;
        if (!viable[so.resourceType]) continue;
        if (!sellsByRes[so.resourceType]) sellsByRes[so.resourceType] = [];
        sellsByRes[so.resourceType].push(so);
    }
    for (var r3 in sellsByRes) {
        sellsByRes[r3].sort(function (a, b) { return a.price - b.price; });
        if (sellsByRes[r3].length > MAX_SELLS_PER_RESOURCE) sellsByRes[r3] = sellsByRes[r3].slice(0, MAX_SELLS_PER_RESOURCE);
    }
    return { sellsByRes: sellsByRes, buysByRes: buysByRes };
}

/** Find best arb opportunity for a terminal. Accounts for committed sell/buy amounts
 *  and global per-resource exposure limits. Caps per-terminal share for splitting. */
function findBestOpportunity(terminal, books, energyPrice, committedBuyAmounts, committedSellAmounts, numIdleTerminals, resourceExposure, bufferedResources, ownSellResources) {
    var roomName        = terminal.room.name;
    var availableEnergy = terminal.store[RESOURCE_ENERGY] || 0;
    var freeCapacity    = terminal.store.getFreeCapacity() || 0;
    var credits         = Game.market.credits;
    if (freeCapacity <= 0 || availableEnergy < 100 || credits < 1) return null;

    var bestOpp = null, bestProfit = 0;

    for (var resource in books.sellsByRes) {
        var sells = books.sellsByRes[resource];
        if (!sells || !sells.length) continue;

        // Don't buy more of a resource that's already stuck in buffer unsold
        if (bufferedResources[resource]) continue;

        // Don't buy resources we already have listed for sale — self-arb handles those
        if (ownSellResources && ownSellResources[resource]) continue;

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

        // Historical average cap (150 %)
        var hist = Game.market.getHistory(resource) || [];
        var hC = 0, hS = 0;
        if (hist.length >= 1 && hist[hist.length-1] && typeof hist[hist.length-1].avgPrice === 'number') { hS += hist[hist.length-1].avgPrice; hC++; }
        if (hist.length >= 2 && hist[hist.length-2] && typeof hist[hist.length-2].avgPrice === 'number') { hS += hist[hist.length-2].avgPrice; hC++; }
        var maxBuyPrice = hC > 0 ? (hS / hC) * 1.5 : Infinity;

        for (var s = 0; s < sells.length; s++) {
            var sell = sells[s];
            if (sell.price > maxBuyPrice) continue;
            if (!topBuy || sell.price >= topBuy.price) break;
            if (sell.roomName && topBuy.roomName && sell.roomName === topBuy.roomName) continue;

            // Account for other terminals already committed to this sell order
            var sellCommitted = committedSellAmounts[sell.id] || 0;
            var sellAvailable = sell.amount - sellCommitted;
            if (sellAvailable <= 0) continue;

            // Cap this terminal's share so other idle terminals can participate.
            var remainingTerminals = Math.max(1, numIdleTerminals);
            var perTerminalShare = Math.ceil(sellAvailable / remainingTerminals);
            if (perTerminalShare < MIN_AMOUNT_PER_TERMINAL) {
                if (sellAvailable >= MIN_AMOUNT_PER_TERMINAL * remainingTerminals) {
                    // Enough for everyone to get the minimum — bump up
                    perTerminalShare = MIN_AMOUNT_PER_TERMINAL;
                }
                // Otherwise, just let each terminal take its fair share even if small
            }

            // Cap by global resource exposure
            var maxAmt = Math.min(perTerminalShare, sellAvailable, topBuyAmt, freeCapacity, Math.floor(credits / sell.price), exposureRoom);
            if (maxAmt <= 0) continue;
            var feasible = capByEnergyBothLegs(maxAmt, roomName, sell.roomName, topBuy.roomName, availableEnergy);
            if (feasible <= 0) continue;

            var creditCost    = sell.price * feasible;
            var creditRevenue = topBuy.price * feasible;
            var buyEnergy     = Game.market.calcTransactionCost(feasible, roomName, sell.roomName);
            var sellEnergy    = Game.market.calcTransactionCost(feasible, roomName, topBuy.roomName);
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

// ─────────────────────────────────────────────────────────────────────────────
// Self-Arbitrage on Own Sell Orders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scans our own active sell orders for profitable external buy orders.
 *
 * When someone fills our sell order naturally, THEY pay energy and we get our
 * asking price for free. But if a buy order exists at a higher price, we can
 * capture the spread by dealing directly — at the cost of us paying energy.
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
 */
function processOwnSellOrders(energyPrice, myRooms, committedBuyAmounts) {
    var pending = Memory.marketArbitrage.selfArbPending;
    var ops = Memory.marketArbitrage.operations;

    // ── Verify pending self-arb deals ──
    for (var pRoom in pending) {
        var p = pending[pRoom];
        var tx = findOutgoingTx(pRoom, p.resourceType, p.buyOrderId, p.tick);
        if (tx) {
            var profit = (p.buyPrice - p.ourSellPrice) * tx.amount
                       - Game.market.calcTransactionCost(tx.amount, pRoom, p.buyOrderRoom) * energyPrice;
            console.log('[Arbitrage] ✓ SELF-ARB verified: sold ' + tx.amount + ' ' +
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
                    // Order still has remaining amount from other sources or partial fill.
                    // Terminal may not have enough to back it — cancel to be safe.
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
            console.log('[Arbitrage] ⚠ SELF-ARB ghost in ' + pRoom + ': ' + p.amount + ' ' +
                p.resourceType + ' — no outgoing tx. Cleaning up.');
            delete pending[pRoom];
        }
    }

    // ── Scan own sell orders for opportunities ──
    var myOrders = Game.market.orders;
    if (!myOrders) return;

    for (var orderId in myOrders) {
        var order = myOrders[orderId];
        if (!order || order.type !== ORDER_SELL || !order.active) continue;
        if (order.resourceType === RESOURCE_ENERGY) continue;
        var remaining = order.remainingAmount || 0;
        if (remaining <= 0) continue;

        var roomName = order.roomName;
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

        // Find external buy orders for this resource, sorted best-price first
        var buyOrders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: order.resourceType });
        if (!buyOrders || !buyOrders.length) continue;

        // Filter and sort
        var candidates = [];
        for (var bi = 0; bi < buyOrders.length; bi++) {
            var bo = buyOrders[bi];
            if (!bo || bo.price <= ourPrice) continue;                    // Must beat our asking price
            if (bo.roomName && myRooms[bo.roomName]) continue;           // Skip our own buy orders
            var effAmt = (bo.remainingAmount || bo.amount || 0) - (committedBuyAmounts[bo.id] || 0);
            if (effAmt < MIN_BUY_ORDER_AMOUNT) continue;
            candidates.push({ order: bo, effective: effAmt });
        }
        if (!candidates.length) continue;
        candidates.sort(function (a, b) { return b.order.price - a.order.price; });

        // Try best candidate
        var best = null, bestProfit = 0;
        for (var ci = 0; ci < candidates.length; ci++) {
            var cand = candidates[ci];
            var buyOrder = cand.order;
            var amount = Math.min(sellableAmount, cand.effective);
            var capped = capByEnergy(amount, roomName, buyOrder.roomName, availEnergy);
            if (capped <= 0) continue;

            var energyCost = Game.market.calcTransactionCost(capped, roomName, buyOrder.roomName);
            var energyCostCr = energyCost * energyPrice;
            var profit = (buyOrder.price - ourPrice) * capped - energyCostCr;

            if (profit > MIN_SELF_ARB_PROFIT && profit > bestProfit) {
                bestProfit = profit;
                best = { buyOrder: buyOrder, amount: capped, energyCost: energyCost, profit: profit };
            }
        }

        if (!best) continue;

        // Execute: deal on the external buy order from our terminal
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

            console.log('[Arbitrage] SELF-ARB deal() OK ' + best.amount + ' ' + order.resourceType +
                ' from ' + roomName + ' (listed @ ' + ourPrice + ') → buy order @ ' + best.buyOrder.price +
                ' in ' + best.buyOrder.roomName +
                ' | Spread profit: ' + best.profit.toFixed(2) +
                ' | Energy: ' + best.energyCost + ' (' + (best.energyCost * energyPrice).toFixed(2) + ' cr)' +
                ' | Verifying...');
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// State-Machine Processing
// ─────────────────────────────────────────────────────────────────────────────

/** Move op to buffered array, freeing the terminal for new arb deals. */
function enterBuffered(op, ops, roomName) {
    delete ops[roomName];
    if (!Memory.marketArbitrage.buffered) Memory.marketArbitrage.buffered = [];
    Memory.marketArbitrage.buffered.push({
        roomName: roomName, resourceType: op.resourceType,
        amount: op.amount, sellPrice: op.sellPrice, bufferedTick: Game.time
    });
    console.log('[Arbitrage] BUFFERED ' + op.amount + ' ' + op.resourceType +
        ' in ' + roomName + ' (bought @ ' + op.sellPrice.toFixed(3) +
        '). Watching for up to ' + BUFFER_TIMEOUT + ' ticks.');
}

/** Confirm initial buy arrived via incomingTransactions. Ghost → clean up. */
function processPendingBuyVerify(terminal, op, ops, roomName) {
    var tx = findIncomingTx(roomName, op.resourceType, op.sellOrderId, op.buyVerifyTick);
    if (tx) {
        var actual = tx.amount;
        if (actual < op.amount) {
            console.log('[Arbitrage] ⚠ Buy partial fill: expected ' + op.amount + ', got ' + actual + '. Adjusting.');
            op.amount = actual;
        }
        op.state = 'pending_sell';
        op.arrivedTick = Game.time;
        delete op.buyVerifyTick;
        console.log('[Arbitrage] ✓ Buy verified: ' + actual + ' ' + op.resourceType + ' in ' + roomName);
        return;
    }
    if (Game.time - op.buyVerifyTick >= VERIFY_TIMEOUT) {
        console.log('[Arbitrage] ⚠ BUY GHOST in ' + roomName + ': ' + op.amount + ' ' +
            op.resourceType + ' — no incoming transaction after ' + (Game.time - op.buyVerifyTick) +
            ' ticks. Cleaning up.');
        // Blacklist this sell order so other terminals don't waste time on it
        if (op.sellOrderId) {
            Memory.marketArbitrage.ghostSellOrders[op.sellOrderId] = Game.time;
        }
        delete ops[roomName];
    }
}

/** Confirm sell completed via outgoingTransactions. Ghost → back to pending_sell. */
function processPendingVerify(terminal, op, ops, roomName) {
    var tx = findOutgoingTx(roomName, op.resourceType, op.verifyOrderId, op.verifyTick);
    if (tx) {
        var actual = tx.amount;
        console.log('[Arbitrage] ✓ VERIFIED sale of ' + actual + ' ' + op.resourceType +
            ' from ' + roomName + ' @ ' + (tx.order ? tx.order.price : '?') +
            ' → ' + (tx.to || '?'));
        op.amount -= actual;
        if (op.amount <= 0) {
            console.log('[Arbitrage] ✓ Arbitrage complete in ' + roomName +
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
        console.log('[Arbitrage] ⚠ SELL GHOST in ' + roomName + ': ' + op.verifyAmount + ' ' +
            op.resourceType + ' — no outgoing tx after ' + (Game.time - op.verifyTick) + ' ticks.');
        op.state = 'pending_sell';
        op.buyOrderId = null; // force replacement search
        delete op.verifyTick; delete op.verifyOrderId; delete op.verifyAmount;
    }
}

/** Process buffered entries: verify pending deals, self-fulfill, or sell to buy orders. */
function processBufferedEntries(buffered, books, oppBuyRequests, myRooms, energyPrice, committedBuyAmounts) {
    for (var bi = buffered.length - 1; bi >= 0; bi--) {
        var buf = buffered[bi];
        var roomName = buf.roomName;
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal;
        if (!room || !terminal) continue;

        // ── Pending verification ──
        if (buf.pendingVerify) {
            var tx = findOutgoingTx(roomName, buf.resourceType, buf.pendingVerify.orderId, buf.pendingVerify.tick);
            if (tx) {
                console.log('[Arbitrage] ✓ VERIFIED BUFFER sale of ' + tx.amount + ' ' +
                    buf.resourceType + ' from ' + roomName + ' @ ' + (tx.order ? tx.order.price : '?'));
                buf.amount -= tx.amount;
                delete buf.pendingVerify;
                if (buf.amount <= 0) { buffered.splice(bi, 1); console.log('[Arbitrage] ✓ Buffer fully sold in ' + roomName); }
            } else if (Game.time - buf.pendingVerify.tick >= VERIFY_TIMEOUT) {
                console.log('[Arbitrage] ⚠ BUFFER ghost in ' + roomName + '. Retrying.');
                delete buf.pendingVerify;
            }
            continue;
        }

        if (terminal.cooldown > 0) continue;

        // Verify resources still present
        var store = terminal.store[buf.resourceType] || 0;
        if (store <= 0) {
            console.log('[Arbitrage] ✗ Buffered gone from ' + roomName + '. Removing.');
            buffered.splice(bi, 1); continue;
        }
        if (store < buf.amount) { buf.amount = store; }

        var availEnergy = terminal.store[RESOURCE_ENERGY] || 0;

        // ── Self-fulfill ──
        var oppList = oppBuyRequests[buf.resourceType];
        var handled = false;
        if (oppList) {
            for (var oi = 0; oi < oppList.length; oi++) {
                var opp = oppList[oi];
                if (opp.roomName === roomName || buf.sellPrice > opp.maxPrice || opp.remaining <= 0) continue;
                var sfAmt = capByEnergy(Math.min(buf.amount, opp.remaining), roomName, opp.roomName, availEnergy);
                if (sfAmt <= 0) continue;
                if (terminal.send(buf.resourceType, sfAmt, opp.roomName) === OK) {
                    console.log('[Arbitrage] BUFFER self-fulfill ' + sfAmt + ' ' + buf.resourceType + ' → ' + opp.roomName);
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

        // ── Sell to buy order ──
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
        var fillE = Game.market.calcTransactionCost(fillAmt, roomName, bestBuy.roomName);
        if (bestBuy.price - (fillE * energyPrice / fillAmt) <= buf.sellPrice) continue;

        // Allow selling full remainder even if small (min 1)
        var minFill = Math.min(buf.amount, Math.max(Math.ceil(buf.amount * 0.5), 100));
        var capped = capByEnergy(fillAmt, roomName, bestBuy.roomName, availEnergy);
        if (capped < minFill) continue;

        if (Game.market.deal(bestBuy.id, capped, roomName) === OK) {
            buf.pendingVerify = { tick: Game.time, orderId: bestBuy.id, amount: capped, price: bestBuy.price };
            committedBuyAmounts[bestBuy.id] = (committedBuyAmounts[bestBuy.id] || 0) + capped;
            console.log('[Arbitrage] BUFFER deal() OK ' + capped + ' ' + buf.resourceType +
                ' → ' + bestBuy.roomName + ' @ ' + bestBuy.price + ' | Verifying...');
        }
    }
}

/** Process pending_sell: self-fulfill check, then external sell via deal() → pending_verify. */
function processPendingSell(terminal, op, ops, roomName, myRooms, energyPrice) {
    if (terminal.cooldown > 0) return;
    var availEnergy = terminal.store[RESOURCE_ENERGY] || 0;

    // Verify resources present
    var store = terminal.store[op.resourceType] || 0;
    if (store <= 0) {
        console.log('[Arbitrage] ✗ Resources gone from ' + roomName + '. Aborting.');
        delete ops[roomName]; return;
    }
    if (store < op.amount) {
        console.log('[Arbitrage] ⚠ Expected ' + op.amount + ' ' + op.resourceType + ' in ' + roomName + ', found ' + store + '. Adjusting.');
        op.amount = store;
    }

    // ── Self-fulfill (terminal.send — no verification needed) ──
    var oppReqs = getOppBuyRequests();
    var oppList = oppReqs[op.resourceType];
    if (oppList) {
        for (var oi = 0; oi < oppList.length; oi++) {
            var opp = oppList[oi];
            if (opp.roomName === roomName || op.sellPrice > opp.maxPrice) continue;
            var sfAmt = capByEnergy(Math.min(op.amount, opp.remaining), roomName, opp.roomName, availEnergy);
            if (sfAmt <= 0) continue;

            var sfE = Game.market.calcTransactionCost(sfAmt, roomName, opp.roomName);
            var sfVal = opp.maxPrice * sfAmt - sfE * energyPrice;
            var extVal = 0;
            if (op.buyOrderId) {
                var eo = Game.market.getOrderById(op.buyOrderId);
                if (eo && (eo.remainingAmount || eo.amount || 0) > 0) {
                    var ec = capByEnergy(Math.min(sfAmt, eo.remainingAmount || eo.amount), roomName, eo.roomName, availEnergy);
                    extVal = eo.price * ec - Game.market.calcTransactionCost(ec, roomName, eo.roomName) * energyPrice;
                }
            }
            if (sfVal <= extVal) continue;

            if (terminal.send(op.resourceType, sfAmt, opp.roomName) === OK) {
                console.log('[Arbitrage] SELF-FULFILL ' + sfAmt + ' ' + op.resourceType +
                    ' → ' + opp.roomName + ' (maxPrice ' + opp.maxPrice + ')');
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

    // ── External buy order ──
    var buyOrder     = op.buyOrderId ? Game.market.getOrderById(op.buyOrderId) : null;
    var buyRemaining = buyOrder ? (buyOrder.remainingAmount || buyOrder.amount || 0) : 0;

    if (!buyOrder || buyRemaining <= 0) {
        console.log('[Arbitrage] Buy order ' + (op.buyOrderId || 'none') + ' gone. Searching replacement...');
        var repls = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: op.resourceType })
            .filter(function (o) {
                return (o.remainingAmount || o.amount || 0) >= MIN_BUY_ORDER_AMOUNT && !(o.roomName && myRooms[o.roomName]);
            }).sort(function (a, b) { return b.price - a.price; });

        var found = null;
        for (var ri = 0; ri < repls.length; ri++) {
            var c = repls[ri];
            var cAmt = Math.min(op.amount, c.remainingAmount || c.amount || 0);
            var cE = Game.market.calcTransactionCost(cAmt, roomName, c.roomName);
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
                    var fbAmt = capByEnergy(Math.min(op.amount, fb.remaining), roomName, fb.roomName, availEnergy);
                    if (fbAmt > 0 && terminal.send(op.resourceType, fbAmt, fb.roomName) === OK) {
                        console.log('[Arbitrage] FALLBACK self-fulfill ' + fbAmt + ' ' + op.resourceType + ' → ' + fb.roomName);
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

    // Execute sell → pending_verify
    var sellAmt = Math.min(op.amount, buyRemaining);
    var capped  = capByEnergy(sellAmt, roomName, buyOrder.roomName, availEnergy);
    if (capped <= 0) { console.log('[Arbitrage] Insufficient energy in ' + roomName + '.'); return; }

    if (Game.market.deal(buyOrder.id, capped, roomName) === OK) {
        op.state = 'pending_verify';
        op.verifyTick = Game.time; op.verifyOrderId = buyOrder.id; op.verifyAmount = capped;
        console.log('[Arbitrage] deal() OK ' + capped + ' ' + op.resourceType +
            ' → ' + buyOrder.roomName + ' @ ' + buyOrder.price + ' | Verifying...');
    } else {
        console.log('[Arbitrage] Sell failed in ' + roomName);
        if (!buyOrder || (Game.market.getOrderById(buyOrder.id) === null)) op.buyOrderId = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

function run() {
    if (Game.time % SCAN_INTERVAL !== 0) return;

    if (!Memory.marketArbitrage) Memory.marketArbitrage = { operations: {}, buffered: [], selfArbPending: {} };
    if (!Memory.marketArbitrage.selfArbPending) Memory.marketArbitrage.selfArbPending = {};
    var ops     = Memory.marketArbitrage.operations;
    var myRooms = getMyRooms();
    var energyPrice = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);

    var terminals = [];
    for (var rn in Game.rooms) {
        var room = Game.rooms[rn];
        if (room.controller && room.controller.my && room.controller.level >= 7 && room.terminal)
            terminals.push(room.terminal);
    }

    // ── PASS 1: process active operations ──
    var idleTerminals = [];
    var buffered = Memory.marketArbitrage.buffered || [];
    var roomsWithBuffer = {};
    for (var bf = 0; bf < buffered.length; bf++) roomsWithBuffer[buffered[bf].roomName] = true;

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
            else if (op.state === 'pending_sell')   processPendingSell(terminal, op, ops, roomName, myRooms, energyPrice);
        } else if (!roomsWithBuffer[roomName] && terminal.cooldown <= 0) {
            idleTerminals.push(terminal);
        }
    }

    // ── Buffer timeouts ──
    buffered = Memory.marketArbitrage.buffered;
    if (buffered) {
        for (var bt = buffered.length - 1; bt >= 0; bt--) {
            var b = buffered[bt];
            if (b.pendingVerify) continue;
            var age = Game.time - (b.bufferedTick || 0);
            if (age >= BUFFER_TIMEOUT) {
                var price = marketSeller.computePrice(b.resourceType);
                if (price < 0.001) price = 0.001;
                var breakEven = b.sellPrice * 1.05;
                if (price < breakEven) price = breakEven;
                var res = marketSeller.marketSell(b.roomName, b.resourceType, b.amount, price);
                console.log('[Arbitrage] BUFFER TIMEOUT ' + b.amount + ' ' + b.resourceType + ' in ' + b.roomName + ' after ' + age + ' ticks. ' + res);
                buffered.splice(bt, 1);
            }
        }
    }

    // ── PASS 1.5: Self-arbitrage on own sell orders ──
    // Build committedBuyAmounts early (needed by both self-arb and PASS 2).
    // We build it once here and share it.
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
    // Also count pending self-arb deals as committed
    var selfPending = Memory.marketArbitrage.selfArbPending;
    for (var spRoom in selfPending) {
        var sp = selfPending[spRoom];
        if (sp && sp.buyOrderId) {
            committedBuyAmounts[sp.buyOrderId] = (committedBuyAmounts[sp.buyOrderId] || 0) + sp.amount;
        }
    }

    processOwnSellOrders(energyPrice, myRooms, committedBuyAmounts);

    // ── PASS 2: unified scan ──
    var hasBuffered = buffered && buffered.length > 0;
    if (!hasBuffered && idleTerminals.length === 0) return;

    var oppBuyRequests = getOppBuyRequests();
    var books = buildOrderBooks(myRooms, oppBuyRequests);

    // Build committed sell amounts (against sell orders we're buying from).
    var committedSellAmounts = {};
    for (var csRoom in ops) {
        var csOp = ops[csRoom];
        if (!csOp || !csOp.sellOrderId) continue;
        if (csOp.state === 'pending_buy_verify') {
            committedSellAmounts[csOp.sellOrderId] = (committedSellAmounts[csOp.sellOrderId] || 0) + csOp.amount;
        }
    }

    // Build per-resource exposure: total amount in-flight + buffered.
    // This prevents buying 7000 power across 8 terminals from different sell orders.
    var resourceExposure = {};
    for (var exRoom in ops) {
        var exOp = ops[exRoom];
        if (exOp && exOp.resourceType) {
            resourceExposure[exOp.resourceType] = (resourceExposure[exOp.resourceType] || 0) + exOp.amount;
        }
    }
    // Track which resources have unsold buffer entries — don't buy more of these
    var bufferedResources = {};
    for (var exBuf = 0; exBuf < buffered.length; exBuf++) {
        var eb = buffered[exBuf];
        if (eb && eb.resourceType) {
            resourceExposure[eb.resourceType] = (resourceExposure[eb.resourceType] || 0) + eb.amount;
            bufferedResources[eb.resourceType] = true;
        }
    }

    // 2a: buffered
    if (hasBuffered) processBufferedEntries(buffered, books, oppBuyRequests, myRooms, energyPrice, committedBuyAmounts);

    // Clean up expired ghost sell order blacklist entries
    var ghosts = Memory.marketArbitrage.ghostSellOrders;
    if (ghosts) {
        for (var gId in ghosts) {
            if (Game.time - ghosts[gId] > GHOST_SELL_COOLDOWN) delete ghosts[gId];
        }
    }

    // 2b: new opportunities — multiple terminals can split the same sell order
    // Each terminal takes ceil(available / remaining idle terminals), updating committed
    // amounts so the next terminal sees reduced availability.
    var ownSellResources = getOwnSellResources();
    var remainingIdle = idleTerminals.length;
    for (var i = 0; i < idleTerminals.length; i++) {
        var term = idleTerminals[i];
        var tRoom = term.room.name;
        var opp = findBestOpportunity(term, books, energyPrice, committedBuyAmounts, committedSellAmounts, remainingIdle, resourceExposure, bufferedResources, ownSellResources);
        if (!opp) { remainingIdle--; continue; }

        // Skip sell orders that recently ghosted (already filled by another player)
        if (ghosts && ghosts[opp.sellOrder.id]) { remainingIdle--; continue; }

        if (Game.market.deal(opp.sellOrder.id, opp.amount, tRoom) === OK) {
            // Track committed amounts so next terminal sees reduced availability
            committedSellAmounts[opp.sellOrder.id] = (committedSellAmounts[opp.sellOrder.id] || 0) + opp.amount;
            if (opp.buyOrder) committedBuyAmounts[opp.buyOrder.id] = (committedBuyAmounts[opp.buyOrder.id] || 0) + opp.amount;
            // Track global resource exposure
            resourceExposure[opp.resourceType] = (resourceExposure[opp.resourceType] || 0) + opp.amount;

            ops[tRoom] = {
                state: 'pending_buy_verify', resourceType: opp.resourceType,
                amount: opp.amount, sellOrderId: opp.sellOrder.id, sellOrderRoom: opp.sellOrder.roomName,
                sellPrice: opp.sellOrder.price, buyOrderId: opp.buyOrder ? opp.buyOrder.id : null,
                buyOrderRoom: opp.buyOrder ? opp.buyOrder.roomName : null,
                buyPrice: opp.buyOrder ? opp.buyOrder.price : 0,
                profit: opp.profit, margin: opp.margin,
                buyEnergy: opp.buyEnergy, sellEnergy: opp.sellEnergy,
                buyVerifyTick: Game.time, tick: Game.time
            };

            var totalCommitted = committedSellAmounts[opp.sellOrder.id];
            var splitTag = totalCommitted > opp.amount
                ? ' | Split: ' + opp.amount + '/' + opp.sellOrder.amount + ' (committed: ' + totalCommitted + ')'
                : '';

            console.log('[Arbitrage] BUY ' + opp.amount + ' ' + opp.resourceType +
                ' from ' + opp.sellOrder.roomName + ' @ ' + opp.sellOrder.price +
                ' → sell to ' + opp.buyOrder.roomName + ' @ ' + opp.buyOrder.price +
                ' | Profit: ' + opp.profit.toFixed(2) + ' (' + (opp.margin * 100).toFixed(1) + '%)' +
                ' | Energy: ' + opp.buyEnergy + '+' + opp.sellEnergy +
                ' | Room: ' + tRoom + splitTag + ' | Verifying buy...');
        } else {
            console.log('[Arbitrage] Buy deal failed in ' + tRoom + ' for ' + opp.resourceType);
        }
        remainingIdle--;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console helpers
// ─────────────────────────────────────────────────────────────────────────────

function status() {
    if (!Memory.marketArbitrage) { var m = '[Arbitrage] No operations.'; console.log(m); return m; }
    var ops = Memory.marketArbitrage.operations || {};
    var buffered = Memory.marketArbitrage.buffered || [];
    var selfPending = Memory.marketArbitrage.selfArbPending || {};
    var out = '[Arbitrage] Active operations:\n';
    var count = 0;

    for (var room in ops) {
        var op = ops[room];
        var age = Game.time - op.tick;
        var st = op.state;
        if (op.state === 'pending_verify') st += ' (sell ' + op.verifyAmount + ', ' + (Game.time - op.verifyTick) + 't ago)';
        else if (op.state === 'pending_buy_verify') st += ' (buy ' + op.amount + ', ' + (Game.time - op.buyVerifyTick) + 't ago)';
        out += '  ' + room + ': ' + st + ' | ' + op.amount + ' ' + op.resourceType +
            ' | buy@' + op.sellPrice.toFixed(3) + ' → sell@' + (op.buyPrice || 0).toFixed(3) +
            ' | profit: ' + op.profit.toFixed(2) + ' (' + (op.margin * 100).toFixed(1) + '%)' +
            ' | age: ' + age + 't\n';
        count++;
    }
    if (buffered.length > 0) {
        out += '\nBuffered:\n';
        for (var bi = 0; bi < buffered.length; bi++) {
            var buf = buffered[bi];
            var bAge = Game.time - (buf.bufferedTick || 0);
            var vTag = buf.pendingVerify ? ' [VERIFYING ' + buf.pendingVerify.amount + ' @ ' + buf.pendingVerify.price + ']' : '';
            out += '  ' + buf.roomName + ': ' + buf.amount + ' ' + buf.resourceType +
                ' | paid@' + buf.sellPrice.toFixed(3) + ' | ' + bAge + '/' + BUFFER_TIMEOUT + 't' + vTag + '\n';
            count++;
        }
    }
    var selfCount = 0;
    for (var sr in selfPending) {
        if (!selfCount) out += '\nSelf-arb pending:\n';
        var sp = selfPending[sr];
        var spAge = Game.time - sp.tick;
        out += '  ' + sr + ': ' + sp.amount + ' ' + sp.resourceType +
            ' | own@' + sp.ourSellPrice.toFixed(3) + ' → ext@' + sp.buyPrice.toFixed(3) +
            ' | ' + spAge + 't ago\n';
        selfCount++; count++;
    }
    if (count === 0) out += '  (none)\n';
    out += '\nConfig: margin=' + (MIN_PROFIT_MARGIN * 100) + '%, minBuy=' + MIN_BUY_ORDER_AMOUNT +
        ', scan=' + SCAN_INTERVAL + ', bufTimeout=' + BUFFER_TIMEOUT + ', verifyTimeout=' + VERIFY_TIMEOUT +
        ', maxExposure=' + MAX_RESOURCE_EXPOSURE + ', minSelfArbProfit=' + MIN_SELF_ARB_PROFIT;
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

function setMargin(v) {
    if (typeof v !== 'number' || v < 0 || v > 1) return '[Arbitrage] Must be 0-1';
    MIN_PROFIT_MARGIN = v;
    var m = '[Arbitrage] Margin set to ' + (v * 100).toFixed(1) + '%'; console.log(m); return m;
}

function setMinBuyAmount(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be ≥ 1';
    MIN_BUY_ORDER_AMOUNT = v;
    var m = '[Arbitrage] Min buy amount set to ' + v; console.log(m); return m;
}

function setBufferTimeout(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be ≥ 1';
    BUFFER_TIMEOUT = v;
    var m = '[Arbitrage] Buffer timeout set to ' + v + ' ticks'; console.log(m); return m;
}

function setMaxExposure(v) {
    if (typeof v !== 'number' || v < 1) return '[Arbitrage] Must be ≥ 1';
    MAX_RESOURCE_EXPOSURE = v;
    var m = '[Arbitrage] Max resource exposure set to ' + v; console.log(m); return m;
}

function setMinSelfArbProfit(v) {
    if (typeof v !== 'number' || v < 0) return '[Arbitrage] Must be ≥ 0';
    MIN_SELF_ARB_PROFIT = v;
    var m = '[Arbitrage] Min self-arb profit set to ' + v; console.log(m); return m;
}

module.exports = {
    run: run, status: status, cancel: cancel,
    setMargin: setMargin, setMinBuyAmount: setMinBuyAmount,
    setBufferTimeout: setBufferTimeout, setMaxExposure: setMaxExposure,
    setMinSelfArbProfit: setMinSelfArbProfit
};