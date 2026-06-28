/**
 * Auto Energy Buyer Module
 * Automatically buys energy when room storage falls below threshold.
 *
 * Three independent buy tiers fire when their threshold is breached:
 *   Tier 1 (normal):    storage < 250k  →  buy 100k  [price-optimal: batteries or energy]
 *   Tier 2 (emergency): storage < 100k  →  buy 200k  [energy only — forceEnergy]
 *   Tier 3 (critical):  storage <  50k  →  buy 250k  [energy only — forceEnergy]
 *
 * ============================================================
 * CONSOLE COMMANDS
 * ============================================================
 *
 * compareEnergyCost(amount?)
 *   Compares the current market cost of buying energy directly vs buying
 *   batteries and converting them through factory production.
 *   Prints the computed buy price for each resource (mirrors what
 *   marketBuy.marketBuy() will actually pay: highest buy order + 0.1, or
 *   95% of 2-day historical average), the total credit cost to acquire
 *   `amount` energy via each route, and a verdict showing which is cheaper.
 *
 *   @param {number} [amount=100000] - Energy units to price up (default 100k).
 *                                     Battery equivalent is derived automatically
 *                                     (amount / 10 batteries needed).
 *
 *   Examples:
 *     compareEnergyCost()          // compare cost for 100k energy
 *     compareEnergyCost(500000)    // compare cost for 500k energy
 *
 *   Sample output:
 *     === Energy Cost Comparison (100k energy) ===
 *       Energy   (direct) : 0.0420/e    →  4,200.00 cr  (100,000 energy)
 *       Batteries (10e/bat): 0.0350/bat  →  3,500.00 cr  (10,000 batteries)
 *       ✓ Batteries are cheaper by 700.00 cr  (16.7% saving)
 *
 *
 * runAutoEnergyBuyer()
 *   Runs the auto-buyer immediately for all owned rooms, without waiting
 *   for the next scheduled tick. Useful for testing or responding to a
 *   sudden energy shortage. Identical to the automatic run() call.
 *
 *   Example:
 *     runAutoEnergyBuyer()
 *
 * ============================================================
 */

var marketBuyer = require('marketBuy');

// ── Buy tiers ───────────────────────────────────────────────────────────────
const TIERS = [
    { label: 'normal',    threshold: 250000, buyAmount: 100000, forceEnergy: false },
    { label: 'emergency', threshold: 100000, buyAmount: 200000, forceEnergy: true  },
    { label: 'critical',  threshold:  50000, buyAmount: 250000, forceEnergy: true  },
];

// Factory conversion constants (must match COMMODITIES: 50 batteries → 500 energy)
const ENERGY_PER_BATTERY  = 10;
const BATTERIES_PER_BATCH = 50;

// Ignore sell orders smaller than this when sampling the best price
const MIN_ORDER_AMOUNT = 500;

// ── Staleness detection ─────────────────────────────────────────────────────
// How many ticks between taking a snapshot and evaluating fill progress.
// If fewer than 25% of the snapshotted remainingAmount has been filled by
// the time this window elapses, the order is cancelled and repriced.
const STALE_CHECK_TICKS = 500;

// If an order's price is below this fraction of the current market price it is
// repriced immediately — no need to wait for the fill-rate window.
// 0.95 means "reprice if we are more than 5% below current market".
const PRICE_COMPETITIVE_RATIO = 0.95;

var autoEnergyBuyer = {

    // ── Memory helpers ──────────────────────────────────────────────────────

    ensureMemory: function() {
        if (!Memory.autoEnergyBuyer) Memory.autoEnergyBuyer = {};
        if (!Memory.autoEnergyBuyer.orderSnapshots) Memory.autoEnergyBuyer.orderSnapshots = {};
    },

    // ── Staleness / price-competitiveness ──────────────────────────────────

    /**
     * Called by route handlers before getTotalOnOrder.
     * Scans active buy orders for the given room + resource and cancels any
     * that are either uncompetitive on price or have stalled on fill rate.
     *
     * Two reprice triggers (evaluated in order for each order):
     *   1. Price: order.price < currentMarketPrice * PRICE_COMPETITIVE_RATIO
     *      → cancel and reprice immediately regardless of age.
     *   2. Staleness: STALE_CHECK_TICKS have elapsed since the snapshot was
     *      taken AND fewer than 25% of the snapshotted amount was filled.
     *      → cancel and reprice; if progress is ≥25% roll the window forward.
     *
     * Snapshots are created on first encounter and pruned when orders vanish.
     */
    repriceStaleOrders: function(roomName, resourceType, currentMarketPrice) {
        this.ensureMemory();
        const snapshots = Memory.autoEnergyBuyer.orderSnapshots;
        const myOrders  = Game.market.orders;

        // Prune snapshots whose orders have disappeared
        for (const orderId in snapshots) {
            if (!myOrders[orderId]) delete snapshots[orderId];
        }

        for (const orderId in myOrders) {
            const order = myOrders[orderId];
            if (order.type         !== ORDER_BUY)    continue;
            if (order.roomName     !== roomName)      continue;
            if (order.resourceType !== resourceType)  continue;
            if (order.remainingAmount <= 0)            continue;

            // Ensure a snapshot baseline exists for this order
            if (!snapshots[orderId]) {
                snapshots[orderId] = {
                    remainingAmount: order.remainingAmount,
                    snapshotTick:    Game.time,
                };
            }
            const snap = snapshots[orderId];

            // ── Trigger 1: price uncompetitive ─────────────────────────────
            const priceThreshold = currentMarketPrice * PRICE_COMPETITIVE_RATIO;
            if (order.price < priceThreshold) {
                console.log('[AutoBuy] Uncompetitive order ' + orderId
                    + ' | ' + resourceType + ' | room: ' + roomName
                    + ' | price: ' + order.price.toFixed(4)
                    + ' < market threshold: ' + priceThreshold.toFixed(4)
                    + ' | repricing ' + order.remainingAmount + ' units');
                this._cancelAndReprice(orderId, order, snapshots);
                continue;
            }

            // ── Trigger 2: fill-rate staleness ─────────────────────────────
            if (Game.time - snap.snapshotTick < STALE_CHECK_TICKS) continue;

            const filled   = snap.remainingAmount - order.remainingAmount;
            const fillRate = filled / snap.remainingAmount;

            if (fillRate < 0.25) {
                console.log('[AutoBuy] Stale order ' + orderId
                    + ' | ' + resourceType + ' | room: ' + roomName
                    + ' | filled ' + (fillRate * 100).toFixed(1) + '%'
                    + ' over ' + STALE_CHECK_TICKS + ' ticks'
                    + ' | price: ' + order.price.toFixed(4)
                    + ' → new: '   + currentMarketPrice.toFixed(4)
                    + ' | repricing ' + order.remainingAmount + ' units');
                this._cancelAndReprice(orderId, order, snapshots);
            } else {
                // Good progress — roll the window forward
                console.log('[AutoBuy] Order ' + orderId
                    + ' (' + resourceType + ') filled '
                    + (fillRate * 100).toFixed(1) + '% — staleness window reset.');
                snap.remainingAmount = order.remainingAmount;
                snap.snapshotTick    = Game.time;
            }
        }
    },

    /**
     * Cancel an order and immediately recreate it at the current market price.
     * Cleans up the snapshot so the new order gets a fresh baseline next call.
     */
    _cancelAndReprice: function(orderId, order, snapshots) {
        const cancelResult = Game.market.cancelOrder(orderId);
        if (cancelResult === OK) {
            delete snapshots[orderId];
            const buyResult = marketBuyer.marketBuy(
                order.roomName,
                order.resourceType,
                order.remainingAmount
                // price omitted — marketBuy computes current market price
            );
            console.log('[AutoBuy] Reprice result → ' + buyResult);
        } else {
            console.log('[AutoBuy] Could not cancel order ' + orderId + ': ' + cancelResult);
        }
    },



    // ── Market helpers ──────────────────────────────────────────────────────

    /**
     * Find the lowest ask price for a resource, ignoring tiny orders.
     */
    getBestSellPrice: function(resourceType) {
        const orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType });
        if (!orders || orders.length === 0) return null;
        let best = Infinity;
        for (const o of orders) {
            if (o.amount >= MIN_ORDER_AMOUNT && o.price < best) best = o.price;
        }
        return best === Infinity ? null : best;
    },

    /**
     * Sum of remainingAmount across all of our active buy orders for a given
     * room + resource. Used to calculate the deficit without double-ordering.
     */
    getTotalOnOrder: function(roomName, resourceType) {
        let total = 0;
        for (const orderId in Game.market.orders) {
            const o = Game.market.orders[orderId];
            if (o.roomName     === roomName     &&
                o.resourceType === resourceType &&
                o.type         === ORDER_BUY    &&
                o.remainingAmount > 0) {
                total += o.remainingAmount;
            }
        }
        return total;
    },

    /**
     * Return true if an active or queued factory energy-production order
     * already exists for this room, to avoid stacking duplicates.
     */
    hasEnergyProductionOrder: function(roomName) {
        return !!(Memory.factoryOrders || []).find(function(o) {
            return o.room    === roomName        &&
                   o.product === RESOURCE_ENERGY &&
                   (o.status === 'active' || o.status === 'queued');
        });
    },

    /**
     * Returns true if the room has an active or queued factory production order
     * for something other than energy. While the factory is busy the energy
     * conversion cannot run, so buying batteries would just leave them sitting.
     */
    hasActiveProductionOrder: function(roomName) {
        return !!(Memory.factoryOrders || []).find(function(o) {
            return o.room    === roomName        &&
                   o.product !== RESOURCE_ENERGY &&
                   (o.status === 'active' || o.status === 'queued');
        });
    },

    // ── Per-room route handlers ─────────────────────────────────────────────

    /**
     * Battery route.
     * Triggers factory production (batteries → energy) for any batteries
     * already in storage/terminal, then buys enough batteries to cover the
     * total deficit (on-hand + on-order vs totalNeeded in battery units).
     */
    handleBatteryRoute: function(room, totalEnergyNeeded, batteryPrice, batteryCostPerUnit, energyPrice) {
        const roomName             = room.name;

        // Reprice any existing battery orders that are uncompetitive or stale
        this.repriceStaleOrders(roomName, RESOURCE_BATTERY, batteryPrice);

        const totalBatteriesNeeded = Math.ceil(totalEnergyNeeded / ENERGY_PER_BATTERY);

        const storageBatteries  = room.storage  ? (room.storage.store[RESOURCE_BATTERY]  || 0) : 0;
        const terminalBatteries = room.terminal  ? (room.terminal.store[RESOURCE_BATTERY] || 0) : 0;
        const alreadyOnOrder    = this.getTotalOnOrder(roomName, RESOURCE_BATTERY);
        const totalOnHand       = storageBatteries + terminalBatteries;
        const totalCovered      = totalOnHand + alreadyOnOrder;
        const deficit           = totalBatteriesNeeded - totalCovered;

        const savingStr = energyPrice != null
            ? ' vs ' + energyPrice.toFixed(4) + '/e direct'
              + ' (saving ' + (((energyPrice - batteryCostPerUnit) / energyPrice) * 100).toFixed(1) + '%)'
            : ' (no energy sell orders found)';

        console.log('[AutoBuy] ' + roomName + ': battery route'
            + ' | ' + batteryPrice.toFixed(4) + '/bat → ' + batteryCostPerUnit.toFixed(4) + '/e' + savingStr
            + ' | need ' + totalBatteriesNeeded + ' bat'
            + ' | storage: ' + storageBatteries + ' terminal: ' + terminalBatteries
            + ' | on order: ' + alreadyOnOrder
            + ' | deficit: ' + deficit);

        // ── Step 1: Trigger factory production if we have batteries ────────
        if (totalOnHand >= BATTERIES_PER_BATCH) {
            if (!this.hasEnergyProductionOrder(roomName)) {
                const result = global.orderFactory(roomName, RESOURCE_ENERGY, 'max');
                console.log('[AutoBuy] ' + roomName + ': factory energy order placed → ' + result);
            } else {
                console.log('[AutoBuy] ' + roomName + ': factory energy production already in progress.');
            }
        } else {
            console.log('[AutoBuy] ' + roomName + ': only ' + totalOnHand
                + ' batteries available (need ' + BATTERIES_PER_BATCH + ' per batch).');
        }

        // ── Step 2: Buy the battery deficit ──────────────────────────────
        if (deficit <= 0) {
            console.log('[AutoBuy] ' + roomName + ': battery supply fully covered — no market order needed.');
            return;
        }

        console.log('[AutoBuy] ' + roomName + ': buying ' + deficit + ' batteries'
            + ' (~' + Math.round(deficit * ENERGY_PER_BATTERY / 1000) + 'k energy equiv)'
            + ' at ' + batteryPrice.toFixed(4) + '/bat');

        const result = marketBuyer.marketBuy(roomName, RESOURCE_BATTERY, deficit);
        if (typeof result === 'number') {
            console.log('[AutoBuy] ' + roomName + ': marketBuy(BATTERY) → '
                + (result === OK ? 'OK' : 'ERR ' + result));
        } else {
            console.log('[AutoBuy] ' + roomName + ': marketBuy(BATTERY) → ' + result);
        }
    },

    /**
     * Energy route (direct buy).
     * Calculates the deficit between totalNeeded and already-committed buy
     * orders, then places a single top-up order for the difference.
     */
    handleEnergyRoute: function(room, totalNeeded, energyPrice) {
        const roomName       = room.name;

        // Reprice any existing energy orders that are uncompetitive or stale
        this.repriceStaleOrders(roomName, RESOURCE_ENERGY, energyPrice);

        const alreadyOnOrder = this.getTotalOnOrder(roomName, RESOURCE_ENERGY);
        const deficit        = totalNeeded - alreadyOnOrder;

        const priceStr = energyPrice != null ? energyPrice.toFixed(4) + '/e' : 'market price';
        console.log('[AutoBuy] ' + roomName + ': energy route'
            + ' | need '     + Math.round(totalNeeded    / 1000) + 'k'
            + ', on order '  + Math.round(alreadyOnOrder / 1000) + 'k'
            + ', deficit '   + Math.round(deficit        / 1000) + 'k'
            + ' at ' + priceStr);

        if (deficit <= 0) {
            console.log('[AutoBuy] ' + roomName + ': sufficient orders already active — skipping.');
            return;
        }

        const result = marketBuyer.marketBuy(roomName, RESOURCE_ENERGY, deficit);
        if (typeof result === 'number') {
            console.log('[AutoBuy] ' + roomName + ': marketBuy(ENERGY) → '
                + (result === OK ? 'OK' : 'ERR ' + result));
        } else {
            console.log('[AutoBuy] ' + roomName + ': marketBuy(ENERGY) → ' + result);
        }
    },

    // ── Main entry point ────────────────────────────────────────────────────

    /**
     * Check all owned rooms and place buy orders as needed.
     * Prices are sampled once globally; all rooms use the same strategy.
     */
    run: function() {
        if (!Game.market || Game.market.credits < 0.01) {
            console.log('[AutoBuy] ERROR: Market not available or insufficient credits');
            return;
        }

        // ── Sample market prices once ────────────────────────────────────────
        const energyPrice        = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);
        const batteryPrice       = marketBuyer.computeBuyPrice(RESOURCE_BATTERY);
        const batteryCostPerUnit = batteryPrice / ENERGY_PER_BATTERY;

        console.log('[AutoBuy] Computed buy prices:'
            + '  energy='  + energyPrice.toFixed(4)         + '/e'
            + '  battery=' + batteryPrice.toFixed(4)         + '/bat'
            + ' (effective ' + batteryCostPerUnit.toFixed(4) + '/e)');

        const useBatteries = batteryCostPerUnit <= energyPrice;
        console.log('[AutoBuy] Strategy: ' + (useBatteries ? 'BUY BATTERIES' : 'BUY ENERGY DIRECTLY'));

        // ── Per-room loop ────────────────────────────────────────────────────
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller || !room.controller.my || !room.storage) continue;

            if (!room.terminal) {
                console.log('[AutoBuy] WARNING: ' + roomName + ' has no terminal — skipping.');
                continue;
            }

            const storageEnergy = room.storage.store[RESOURCE_ENERGY] || 0;

            // Evaluate every tier independently
            let needEnergy  = 0;  // must buy as energy (forceEnergy tiers)
            let needOptimal = 0;  // price-strategy tiers (battery or energy)
            const triggeredLabels = [];
            for (const tier of TIERS) {
                if (storageEnergy < tier.threshold) {
                    if (tier.forceEnergy) {
                        needEnergy += tier.buyAmount;
                    } else {
                        needOptimal += tier.buyAmount;
                    }
                    triggeredLabels.push(tier.label
                        + ' (<' + Math.round(tier.threshold / 1000) + 'k → +'
                        + Math.round(tier.buyAmount  / 1000) + 'k'
                        + (tier.forceEnergy ? ' energy-only' : '') + ')');
                }
            }

            const totalNeeded = needEnergy + needOptimal;

            if (totalNeeded === 0) {
                // Energy is healthy — but still convert any idle batteries so
                // they don't accumulate indefinitely waiting for a low-energy event.
                const storageBats  = room.storage  ? (room.storage.store[RESOURCE_BATTERY]  || 0) : 0;
                const terminalBats = room.terminal ? (room.terminal.store[RESOURCE_BATTERY] || 0) : 0;
                const totalBats    = storageBats + terminalBats;
                if (totalBats >= BATTERIES_PER_BATCH && !this.hasEnergyProductionOrder(roomName)) {
                    const result = global.orderFactory(roomName, RESOURCE_ENERGY, 'max');
                    console.log('[AutoBuy] ' + roomName
                        + ' | storage: ' + Math.round(storageEnergy / 1000) + 'k — above thresholds'
                        + ' but ' + totalBats + ' idle batteries; factory conversion triggered → ' + result);
                } else {
                    console.log('[AutoBuy] ' + roomName
                        + ' | storage: ' + Math.round(storageEnergy / 1000) + 'k — above all thresholds, OK.');
                }
                continue;
            }

            console.log('[AutoBuy] ' + roomName
                + ' | storage: '         + Math.round(storageEnergy / 1000) + 'k'
                + ' | tiers triggered: ' + triggeredLabels.join(', ')
                + ' | energy-only: '     + Math.round(needEnergy  / 1000) + 'k'
                + ' | price-optimal: '   + Math.round(needOptimal / 1000) + 'k');

            // Energy-only portion: always direct regardless of price strategy
            if (needEnergy > 0) {
                this.handleEnergyRoute(room, needEnergy, energyPrice);
            }

            // Price-optimal portion: use whichever route is cheaper —
            // unless the factory is busy with another production order.
            if (needOptimal > 0) {
                const factoryBusy = this.hasActiveProductionOrder(roomName);
                if (useBatteries && !factoryBusy) {
                    this.handleBatteryRoute(room, needOptimal, batteryPrice, batteryCostPerUnit, energyPrice);
                } else {
                    if (factoryBusy && useBatteries) {
                        console.log('[AutoBuy] ' + roomName + ': factory busy with production order — buying energy directly instead of batteries.');
                    }
                    this.handleEnergyRoute(room, needOptimal, energyPrice);
                }
            }
        }
    }
};

// ── Console commands ────────────────────────────────────────────────────────

global.compareEnergyCost = function(amount) {
    amount = (typeof amount === 'number' && amount > 0) ? Math.ceil(amount) : 100000;

    if (!Game.market) {
        console.log('[AutoBuy] Market not available.');
        return;
    }

    const energyPrice  = marketBuyer.computeBuyPrice(RESOURCE_ENERGY);
    const batteryPrice = marketBuyer.computeBuyPrice(RESOURCE_BATTERY);

    const batteriesNeeded    = Math.ceil(amount / ENERGY_PER_BATTERY);
    const energyCostTotal    = energyPrice  != null ? energyPrice  * amount           : null;
    const batteryCostTotal   = batteryPrice != null ? batteryPrice * batteriesNeeded  : null;
    const batteryCostPerUnit = batteryPrice != null ? batteryPrice / ENERGY_PER_BATTERY : null;

    const fmtPrice = n  => n  != null ? n.toFixed(4)         : 'no orders';
    const fmtCr    = n  => n  != null ? n.toFixed(2) + ' cr' : 'N/A';
    const fmtNum   = n  => n.toLocaleString();
    const amtLabel = Math.round(amount / 1000) + 'k';

    console.log('=== Energy Cost Comparison (' + amtLabel + ' energy) ===');
    console.log('  Energy    (direct) : ' + fmtPrice(energyPrice)
        + '/e'
        + '              →  ' + fmtCr(energyCostTotal)
        + '  (' + fmtNum(amount) + ' energy)');
    console.log('  Batteries (' + ENERGY_PER_BATTERY + 'e/bat) : ' + fmtPrice(batteryPrice)
        + '/bat (= ' + fmtPrice(batteryCostPerUnit) + '/e)'
        + '  →  ' + fmtCr(batteryCostTotal)
        + '  (' + fmtNum(batteriesNeeded) + ' batteries)');

    if (energyCostTotal != null && batteryCostTotal != null) {
        const diff   = energyCostTotal - batteryCostTotal;
        const pct    = Math.abs((diff / energyCostTotal) * 100).toFixed(1);
        const absDiff = Math.abs(diff).toFixed(2);
        if (diff > 0) {
            console.log('  ✓ Batteries cheaper by ' + absDiff + ' cr  (' + pct + '% saving)');
        } else if (diff < 0) {
            console.log('  ✓ Energy cheaper by ' + absDiff + ' cr  (' + pct + '% saving)');
        } else {
            console.log('  = Same cost either way.');
        }
    } else if (energyCostTotal == null && batteryCostTotal != null) {
        console.log('  ✓ Batteries only option (no energy market data found).');
    } else if (batteryCostTotal == null && energyCostTotal != null) {
        console.log('  ✓ Energy only option (no battery market data found).');
    } else {
        console.log('  ✗ No market data found for either resource.');
    }
};

global.runAutoEnergyBuyer = function() {
    autoEnergyBuyer.run();
};

module.exports = autoEnergyBuyer;