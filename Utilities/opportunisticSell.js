/**
 * Opportunistic Market Sell Module
 * 
 * Scans for open BUY orders on the market and fulfills them when prices are favorable,
 * selling resources from your terminals via Game.market.deal().
 * Supports both terminal-based resources and account-level resources (pixel, cpuUnlock, accessKey).
 * 
 * Usage:
 * 1. Call opportunisticSell.setup('ROOM#', RESOURCE, AMOUNT, MINPRICE) from console
 *    - For account resources (PIXEL, CPU_UNLOCK, ACCESS_KEY), the room name is used only as
 *      a key; no terminal is needed. You can use any string (e.g. your main room name).
 * 2. Call opportunisticSell.process() in your main loop (every tick is fine)
 * 3. Call opportunisticSell.listActiveRequests() to view current orders
 * 4. Call opportunisticSell.cancelRequest('ROOM', RESOURCE) to delete a request
 * 5. Call opportunisticSell.setup('ROOM', RESOURCE_ENERGY, 10000, true) to fulfill to the highest available order

/**
 * Opportunistic Market Sell Module
 * 
 * Scans for open BUY orders on the market and fulfills them when prices are favorable,
 * selling resources from your terminals via Game.market.deal().
 * Supports both terminal-based resources and account-level resources (pixel, cpuUnlock, accessKey).
 * 
 * Usage:
 * 1. Call opportunisticSell.setup('ROOM#', RESOURCE, AMOUNT, MINPRICE) from console
 *    - Pass a number as 4th arg to set a minimum price floor.
 *    - Pass true as 4th arg for best-offer mode: scores the top 10 orders by net profit
 *      per unit after subtracting energy transmission cost (valued at market energy price).
 *    - Optional 5th arg: reserve amount to keep in terminal and never sell below.
 *    - For account resources (PIXEL, CPU_UNLOCK, ACCESS_KEY), the room name is used only as
 *      a key; no terminal is needed. You can use any string (e.g. your main room name).
 * 2. Call opportunisticSell.process() in your main loop (every tick is fine)
 * 3. Call opportunisticSell.listActiveRequests() to view current orders
 * 4. Call opportunisticSell.cancelRequest('ROOM#', RESOURCE) to delete a request

 */

// Confirmation timeout in ticks for pending market deals
var CONFIRMATION_TIMEOUT_TICKS = 20;

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

// Initialize memory structure on first run
if (!Memory.opportunisticSell) {
    Memory.opportunisticSell = {
        requests: {}
    };
}

/**
 * Build a set of our owned room names
 * @returns {Object} - Map of roomName -> true for owned rooms
 */
function getMyRooms() {
    var myRooms = {};
    for (var rn in Game.rooms) {
        var r = Game.rooms[rn];
        if (r && r.controller && r.controller.my) {
            myRooms[rn] = true;
        }
    }
    return myRooms;
}

// Cache energy market price for one tick to avoid repeated scans
var _energyPriceCache = { tick: -1, price: 0 };

/**
 * Get the current market price of energy — what we would pay to buy it.
 * Looks at the cheapest external SELL orders for energy (>=1000 remaining),
 * falling back to 2-day historical average from Game.market.getHistory.
 * Result is cached per tick.
 * 
 * @returns {number} Energy price in credits per unit
 */
function getEnergyMarketPrice() {
    if (_energyPriceCache.tick === Game.time) return _energyPriceCache.price;

    var myRooms = getMyRooms();
    var orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: RESOURCE_ENERGY });

    var valid = [];
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (!o || !o.roomName) continue;
        if (myRooms[o.roomName]) continue;
        if (typeof o.amount !== 'number' || o.amount < 1000) continue;
        if (typeof o.price !== 'number') continue;
        valid.push(o);
    }

    valid.sort(function(a, b) { return a.price - b.price; });

    var price;
    if (valid.length > 0) {
        price = valid[0].price;
    } else {
        // Fall back to 2-day historical average
        var hist = Game.market.getHistory(RESOURCE_ENERGY) || [];
        var sum = 0;
        var count = 0;
        if (hist.length >= 1) {
            var h1 = hist[hist.length - 1];
            if (h1 && typeof h1.avgPrice === 'number') { sum += h1.avgPrice; count++; }
        }
        if (hist.length >= 2) {
            var h2 = hist[hist.length - 2];
            if (h2 && typeof h2.avgPrice === 'number') { sum += h2.avgPrice; count++; }
        }
        price = (count > 0) ? (sum / count) : 0.01;
    }

    _energyPriceCache = { tick: Game.time, price: price };
    return price;
}

/**
 * Sets up an opportunistic sell request.
 * 
 * @param {string} roomName - The room name where the terminal is located.
 *   For account-level resources (pixel, cpuUnlock, accessKey), this is only used as a key.
 * @param {string} resourceType - RESOURCE_* constant for the resource to sell
 * @param {number} amount - Target amount to sell
 * @param {number|boolean} minPriceOrBestOffer - Minimum price per unit (number), or true
 *   to enable best-offer mode (scores top 10 orders by net profit after energy cost).
 * @param {number} [reserve=0] - Amount to keep in terminal and never sell below
 * @returns {string} Status message confirming request setup
 */
function setup(roomName, resourceType, amount, minPriceOrBestOffer, reserve) {
    var key = roomName + '_' + resourceType;
    var existing = Memory.opportunisticSell.requests[key];

    // Determine mode from 4th argument
    var bestOffer = (minPriceOrBestOffer === true);
    var minPrice = bestOffer ? 0 : minPriceOrBestOffer;

    // Preserve original createdAt if request already exists
    var createdAt = existing && typeof existing.createdAt === 'number' ? existing.createdAt : Game.time;

    // Store or update the sell request
    Memory.opportunisticSell.requests[key] = {
        roomName: roomName,
        resourceType: resourceType,
        totalAmount: amount,
        remaining: amount,
        minPrice: minPrice,
        reserve: (typeof reserve === 'number' && reserve >= 0) ? reserve : 0,
        bestOffer: bestOffer,
        lastCheck: 0,
        checkInterval: 1, // attempt every tick by default
        cachedOrderId: null,
        cachedOrderRoomName: null,
        createdAt: createdAt,
        fulfilled: 0,
        pending: null // { pre: number, expected: number, tick: number, orderId, orderRoom, price, energyCost }
    };

    var acctTag = isAccountResource(resourceType) ? ' [ACCOUNT RESOURCE]' : '';
    var reserveTag = (reserve && reserve > 0) ? ' (reserve ' + reserve + ')' : '';
    var modeTag = bestOffer ? ' [BEST OFFER MODE]' : ' (min ' + minPrice + ' credits/unit)';
    var message = 'Sell request for ' + amount + ' ' + resourceType + ' from ' + roomName + ' created' + modeTag + reserveTag + acctTag;
    console.log('[OpportunisticSell] ' + message);
    return message;
}

/**
 * Optionally adjust the check interval (ticks between attempts) for an existing request.
 * 
 * @param {string} roomName
 * @param {string} resourceType
 * @param {number} ticks - Minimum ticks between attempts (1 = every tick)
 * @returns {string} Status
 */
function setCheckInterval(roomName, resourceType, ticks) {
    var key = roomName + '_' + resourceType;
    var requests = Memory.opportunisticSell.requests;
    if (!requests || !requests[key]) {
        var msgMissing = 'No active sell request found for ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticSell] ' + msgMissing);
        return msgMissing;
    }
    if (typeof ticks !== 'number' || ticks < 1) {
        var msgBad = 'Invalid checkInterval ' + ticks + ' (must be number >= 1)';
        console.log('[OpportunisticSell] ' + msgBad);
        return msgBad;
    }
    requests[key].checkInterval = ticks;
    var msgOk = 'Set checkInterval for ' + roomName + ' ' + resourceType + ' to ' + ticks + ' ticks';
    console.log('[OpportunisticSell] ' + msgOk);
    return msgOk;
}

/**
 * Optionally adjust the reserve amount for an existing request.
 * 
 * @param {string} roomName
 * @param {string} resourceType
 * @param {number} amount - Amount to keep in terminal and never sell below
 * @returns {string} Status
 */
function setReserve(roomName, resourceType, amount) {
    var key = roomName + '_' + resourceType;
    var requests = Memory.opportunisticSell.requests;
    if (!requests || !requests[key]) {
        var msgMissing = 'No active sell request found for ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticSell] ' + msgMissing);
        return msgMissing;
    }
    if (typeof amount !== 'number' || amount < 0) {
        var msgBad = 'Invalid reserve ' + amount + ' (must be number >= 0)';
        console.log('[OpportunisticSell] ' + msgBad);
        return msgBad;
    }
    requests[key].reserve = amount;
    var msgOk = 'Set reserve for ' + roomName + ' ' + resourceType + ' to ' + amount;
    console.log('[OpportunisticSell] ' + msgOk);
    return msgOk;
}

/**
 * Toggle best-offer mode for an existing request.
 * When enabled, scores the top 10 BUY orders by net profit per unit after subtracting
 * energy transmission cost (valued at current market energy price).
 * When disabled (default), among equally-priced orders prefers the largest feasible volume.
 * 
 * @param {string} roomName
 * @param {string} resourceType
 * @param {boolean} enabled - true to enable best-offer mode
 * @returns {string} Status
 */
function setBestOffer(roomName, resourceType, enabled) {
    var key = roomName + '_' + resourceType;
    var requests = Memory.opportunisticSell.requests;
    if (!requests || !requests[key]) {
        var msgMissing = 'No active sell request found for ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticSell] ' + msgMissing);
        return msgMissing;
    }
    requests[key].bestOffer = !!enabled;
    var msgOk = (enabled ? 'Enabled' : 'Disabled') + ' best-offer mode for ' + roomName + ' ' + resourceType;
    console.log('[OpportunisticSell] ' + msgOk);
    return msgOk;
}

/**
 * Helper: cap desired sell amount by available terminal energy using exact calcTransactionCost.
 * Uses binary search to find the largest amount whose transfer energy cost does not exceed energyAvail.
 * 
 * The seller (dealer) pays the energy cost when calling Game.market.deal() on a BUY order.
 * When selling energy itself, both the sold amount AND the transfer cost come from the same pool,
 * so the check becomes (amount + transferCost) <= energyAvail.
 * 
 * @param {number} desired - Desired units to sell
 * @param {string} fromRoom - Your room name (terminal that will send and pay energy)
 * @param {string} toRoom - Remote buyer's room name
 * @param {number} energyAvail - Energy currently available in your terminal
 * @param {boolean} [sellingEnergy=false] - True when the resource being sold is energy
 * @returns {number} Amount capped by energy
 */
function capByEnergy(desired, fromRoom, toRoom, energyAvail, sellingEnergy) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    if (!toRoom) return 0; // guard against undefined room names
    var low = 0;
    var high = desired;
    while (low < high) {
        var mid = low + Math.ceil((high - low) / 2);
        var cost = Game.market.calcTransactionCost(mid, fromRoom, toRoom);
        // When selling energy, both the amount sent and the transfer fee come from the terminal's energy
        var totalNeeded = sellingEnergy ? (mid + cost) : cost;
        if (totalNeeded <= energyAvail) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

/**
 * Process a single account-level resource request (pixel, cpuUnlock, accessKey).
 * No terminal, energy, or capacity checks needed. deal() is called without a room name.
 * On OK, progress is counted immediately (no pending confirmation needed).
 *
 * @param {string} key_i - The request key in Memory
 * @param {Object} request - The request object
 * @param {Object} requests - Reference to Memory.opportunisticSell.requests
 * @param {Object} myRooms - Map of owned room names
 */
function processAccountResource(key_i, request, requests, myRooms) {
    // Check interval
    var interval = request.checkInterval || 1;
    if (Game.time - request.lastCheck < interval) return;
    request.lastCheck = Game.time;

    /**
     * Attempt a deal for an account-level resource.
     * No energy cost, no room name passed to deal().
     * Progress is counted immediately on OK.
     *
     * @param {Object} order - Market order to attempt
     * @returns {boolean} true if an attempt was made (success or consumed error), false if not feasible
     */
    function attemptAccountDeal(order) {
        var isOwnRoom = !!(order.roomName && myRooms[order.roomName]);

        var candidate = order.amount;
        if (candidate > request.remaining) candidate = request.remaining;
        if (candidate <= 0) return false;

        // Account-level resources: no room name in deal()
        var result = Game.market.deal(order.id, candidate);
        if (result === OK) {
            var creditsCost = candidate * order.price;
            request.fulfilled = (request.fulfilled || 0) + candidate;
            request.remaining -= candidate;

            // Cache this order for next attempts
            request.cachedOrderId = order.id;
            request.cachedOrderRoomName = order.roomName;

            var ownTag = isOwnRoom ? ' [OWN ROOM]' : '';
            console.log('[OpportunisticSell] Sold ' + candidate + ' ' + request.resourceType +
                ' (account resource) to ' + (order.roomName || 'market') + ownTag +
                ' @ ' + order.price + ' (credits earned: ' + creditsCost.toFixed(3) + '). Progress: ' +
                request.fulfilled + '/' + request.totalAmount);
            return true;
        } else {
            var errorMessage = 'Unknown error: ' + result;
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                errorMessage = 'Insufficient resources';
            } else if (result === ERR_INVALID_ARGS) {
                errorMessage = 'Invalid arguments';
            } else if (result === ERR_NOT_FOUND) {
                errorMessage = 'Order no longer available';
            }
            console.log('[OpportunisticSell] Error selling account resource to order ' +
                order.id + ' (' + (order.roomName || 'unknown') + '): ' + errorMessage);

            // Drop cache if the order failed
            request.cachedOrderId = null;
            request.cachedOrderRoomName = null;
            return true; // consume attempt
        }
    }

    var attempted = false;

    // 1) Try cached order first (fast path)
    if (request.cachedOrderId) {
        var cached = Game.market.getOrderById(request.cachedOrderId);
        var cachedIsOwn = !!(cached && cached.roomName && myRooms[cached.roomName]);
        if (cached &&
            cached.resourceType === request.resourceType &&
            (cached.price >= request.minPrice || cachedIsOwn) &&
            cached.amount > 0) {
            attempted = attemptAccountDeal(cached);
        } else {
            // Invalidate cache if not usable
            request.cachedOrderId = null;
            request.cachedOrderRoomName = null;
        }
    }

    // 2) If no attempt yet, scan orders for the best feasible one
    if (!attempted) {
        var orders = Game.market.getAllOrders({
            type: ORDER_BUY,
            resourceType: request.resourceType
        }).filter(function(order) {
            // Accept orders from our own rooms regardless of price
            if (order.roomName && myRooms[order.roomName]) return order.amount > 0;
            return order.price >= request.minPrice && order.amount > 0;
        }).sort(function(a, b) {
            // Prefer own-room orders first, then highest price
            var aOwn = (a.roomName && myRooms[a.roomName]) ? 1 : 0;
            var bOwn = (b.roomName && myRooms[b.roomName]) ? 1 : 0;
            if (aOwn !== bOwn) return bOwn - aOwn; // own rooms first
            return b.price - a.price; // then highest price
        });

        // Try each order in priority order until one succeeds
        for (var ai = 0; ai < orders.length && !attempted; ai++) {
            attempted = attemptAccountDeal(orders[ai]);
        }
    }

    // Clean up if fully fulfilled
    if (request.remaining <= 0) {
        delete requests[key_i];
        console.log('[OpportunisticSell] Completed sell request for ' + request.resourceType +
            ' (' + request.totalAmount + ' total)');
    }
}

/**
 * Processes all active opportunistic sell requests.
 * Should be called periodically in your main loop.
 * 
 * - Handles account-level resources (pixel, cpuUnlock, accessKey) without terminal logic.
 * - Confirms pending terminal deals by comparing terminal before/after counts.
 * - Executes at most one deal per terminal per tick.
 * - Among requests for the same terminal, the earlier created is processed first.
 * - Orders from our own rooms are accepted regardless of minPrice (credits cycle back).
 */
function process() {
    if (!Memory.opportunisticSell || !Memory.opportunisticSell.requests) return;

    var requests = Memory.opportunisticSell.requests;

    // Build owned room set once per tick for own-room order detection
    var myRooms = getMyRooms();

    // Build and order the request list by creation time (oldest first)
    var entries = [];
    for (var key in requests) {
        var req = requests[key];
        if (!req || typeof req.remaining !== 'number' || req.remaining <= 0) continue;
        entries.push({ key: key, req: req });
    }
    entries.sort(function(a, b) {
        var ca = (a.req.createdAt || 0) - (b.req.createdAt || 0);
        if (ca !== 0) return ca;
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return 0;
    });

    // Track terminals that already acted this tick to enforce one deal per terminal
    var roomAttemptedThisTick = {};

    for (var i = 0; i < entries.length; i++) {
        var key_i = entries[i].key;
        var request = entries[i].req;

        // Skip completed
        if (request.remaining <= 0) continue;

        // ======= ACCOUNT-LEVEL RESOURCE PATH =======
        if (isAccountResource(request.resourceType)) {
            processAccountResource(key_i, request, requests, myRooms);
            continue;
        }

        // ======= TERMINAL RESOURCE PATH =======
        var roomName = request.roomName;
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal;
        if (!room || !terminal) continue;

        // Always try to confirm a pending deal first; block new deals in this room until confirmed
        if (request.pending && typeof request.pending.expected === 'number') {
            var pre = request.pending.pre || 0;
            var curr = terminal.store[request.resourceType] || 0;
            var expected = request.pending.expected;
            // For selling, the resource should DECREASE by expected amount
            var delta = pre - curr;

            if (delta >= expected) {
                // Confirm full expected send
                request.fulfilled = (request.fulfilled || 0) + expected;
                request.remaining -= expected;

                console.log('[OpportunisticSell] Confirmed ' + expected + ' ' + request.resourceType + ' sent from ' + roomName +
                    ' to ' + (request.pending.orderRoom || 'unknown') + '. Progress: ' +
                    request.fulfilled + '/' + request.totalAmount + ' ' + request.resourceType + ' sold.');

                request.pending = null;

                if (request.remaining <= 0) {
                    delete requests[key_i];
                    console.log('[OpportunisticSell] Completed sell request for ' + request.resourceType + ' in ' + roomName);
                }

                // Move to next request after confirmation
                continue;
            } else {
                // Timeout logic
                var pendingTick = request.pending.tick || 0;
                var waited = Game.time - pendingTick;
                if (waited > CONFIRMATION_TIMEOUT_TICKS) {
                    // Assume the deal went through to avoid overselling
                    request.fulfilled = (request.fulfilled || 0) + expected;
                    request.remaining -= expected;
                    console.log('[OpportunisticSell] Confirmation timeout after ' + waited + ' ticks for order ' +
                        (request.pending.orderId || 'unknown') + ' from ' + roomName + '. Counting ' +
                        expected + ' ' + request.resourceType + ' as sold (conservative). Progress: ' +
                        request.fulfilled + '/' + request.totalAmount);
                    request.pending = null;
                    request.cachedOrderId = null;
                    request.cachedOrderRoomName = null;

                    if (request.remaining <= 0) {
                        delete requests[key_i];
                        console.log('[OpportunisticSell] Completed sell request for ' + request.resourceType + ' in ' + roomName);
                        continue;
                    }
                    // Fall through to attempt new deals this tick
                } else {
                    // Still waiting; block new deals from this terminal
                    roomAttemptedThisTick[roomName] = true;
                    continue;
                }
            }
        }

        // If another request from this terminal already acted this tick, skip
        if (roomAttemptedThisTick[roomName]) continue;

        var interval = request.checkInterval || 1;
        if (Game.time - request.lastCheck < interval) continue;
        request.lastCheck = Game.time;

        // Terminal cooldown gate
        if (terminal.cooldown > 0) continue;

        // Current resource balance and energy for transfer costs
        var availableResource = terminal.store[request.resourceType] || 0;
        var reserve = request.reserve || 0;
        var sellableResource = Math.max(0, availableResource - reserve);
        if (sellableResource <= 0) continue;

        var availableEnergy = terminal.store[RESOURCE_ENERGY] || 0;
        var isSellingEnergy = (request.resourceType === RESOURCE_ENERGY);

        // Helper: attempt a single deal, but only mark progress after confirmation
        function attemptDeal(order) {
            var isOwnRoom = !!(order.roomName && myRooms[order.roomName]);

            var candidate = order.amount;
            if (candidate > request.remaining) candidate = request.remaining;
            if (candidate > sellableResource) candidate = sellableResource;

            var cappedByEnergy = capByEnergy(candidate, roomName, order.roomName, availableEnergy, isSellingEnergy);
            if (cappedByEnergy <= 0) {
                // Not feasible due to energy; try another order
                return false;
            }
            candidate = cappedByEnergy;

            var preStore = terminal.store[request.resourceType] || 0;

            var result = Game.market.deal(order.id, candidate, roomName);
            if (result === OK) {
                var energyCost = Game.market.calcTransactionCost(candidate, roomName, order.roomName);
                var creditsEarned = candidate * order.price;

                // Defer progress update until terminal count reflects the transfer
                request.pending = {
                    pre: preStore,
                    expected: candidate,
                    tick: Game.time,
                    orderId: order.id,
                    orderRoom: order.roomName,
                    price: order.price,
                    energyCost: energyCost
                };

                // Cache this order for next attempts
                request.cachedOrderId = order.id;
                request.cachedOrderRoomName = order.roomName;

                // Only one deal per terminal this tick
                roomAttemptedThisTick[roomName] = true;

                var ownTag = isOwnRoom ? ' [OWN ROOM]' : '';
                console.log('[OpportunisticSell] Placed deal to sell ' + candidate + ' ' + request.resourceType + ' to ' + order.roomName + ownTag +
                    ' @ ' + order.price + ' (credits earned: ' + creditsEarned.toFixed(3) + ', energy: ' + energyCost + '). Awaiting terminal confirmation.');
                return true;
            } else {
                var errorMessage = 'Unknown error: ' + result;
                if (result === ERR_NOT_ENOUGH_RESOURCES) {
                    errorMessage = 'Insufficient resources in terminal';
                } else if (result === ERR_INVALID_ARGS) {
                    errorMessage = 'Invalid arguments';
                } else if (result === ERR_NOT_ENOUGH_ENERGY) {
                    errorMessage = 'Insufficient terminal energy';
                } else if (result === ERR_NOT_FOUND) {
                    errorMessage = 'Order no longer available';
                } else if (result === ERR_TIRED) {
                    errorMessage = 'Terminal cooldown';
                }
                console.log('[OpportunisticSell] Error selling to order ' + order.id + ' (' + order.roomName + '): ' + errorMessage);

                request.cachedOrderId = null;
                request.cachedOrderRoomName = null;

                return true; // consume attempt
            }
        }

        var attempted = false;

        // In bestOffer mode, skip cache — always re-evaluate which order is truly best
        // 1) Try cached order first (fast path) — only in default mode
        if (!request.bestOffer && request.cachedOrderId) {
            var cached = Game.market.getOrderById(request.cachedOrderId);
            var cachedIsOwn = !!(cached && cached.roomName && myRooms[cached.roomName]);
            if (cached &&
                cached.roomName &&
                cached.resourceType === request.resourceType &&
                (cached.price >= request.minPrice || cachedIsOwn) &&
                cached.amount > 0) {
                attempted = attemptDeal(cached);
            } else {
                request.cachedOrderId = null;
                request.cachedOrderRoomName = null;
            }
        }

        // 2) If no attempt yet, scan orders for the best feasible one
        if (!attempted) {
            var orders = Game.market.getAllOrders({
                type: ORDER_BUY,
                resourceType: request.resourceType
            }).filter(function(order) {
                // Skip orders with no roomName
                if (!order.roomName) return false;
                // Skip orders from ourselves buying in THIS room (no self-transfer)
                if (order.roomName === roomName) return false;
                // Accept orders from our own rooms regardless of price
                if (myRooms[order.roomName]) return order.amount > 0;
                return order.price >= request.minPrice && order.amount > 0;
            }).sort(function(a, b) {
                // Prefer own-room orders first, then highest price
                var aOwn = (a.roomName && myRooms[a.roomName]) ? 1 : 0;
                var bOwn = (b.roomName && myRooms[b.roomName]) ? 1 : 0;
                if (aOwn !== bOwn) return bOwn - aOwn; // own rooms first
                return b.price - a.price; // then highest price
            });

            if (orders.length === 0) continue;

            // Check if the best order is from our own room
            var bestIsOwn = !!(orders[0].roomName && myRooms[orders[0].roomName]);

            if (bestIsOwn) {
                // Prefer own-room orders: try each until one works
                for (var oj = 0; oj < orders.length && !attempted; oj++) {
                    var ownOrd = orders[oj];
                    if (!(ownOrd.roomName && myRooms[ownOrd.roomName])) break; // past own-room orders

                    // Skip self-room transfers
                    if (ownOrd.roomName === roomName) continue;

                    var candidate0 = ownOrd.amount;
                    if (candidate0 > request.remaining) candidate0 = request.remaining;
                    if (candidate0 > sellableResource) candidate0 = sellableResource;
                    candidate0 = capByEnergy(candidate0, roomName, ownOrd.roomName, availableEnergy, isSellingEnergy);
                    if (candidate0 > 0) {
                        attempted = attemptDeal(ownOrd);
                    }
                }
            }

            // If own-room orders didn't work out, fall back to external orders
            if (!attempted) {
                var externalOrders = [];
                for (var ei = 0; ei < orders.length; ei++) {
                    if (!(orders[ei].roomName && myRooms[orders[ei].roomName])) {
                        externalOrders.push(orders[ei]);
                    }
                }

                if (externalOrders.length > 0) {
                    if (request.bestOffer) {
                        // Best-offer mode: score the top 10 orders by net profit per unit.
                        // net = order.price - (energyCost / amount * energyMarketPrice)
                        // This accounts for distance: a far room at a high price may net less
                        // than a closer room at a slightly lower price.
                        var energyPrice = getEnergyMarketPrice();
                        var topOrders = externalOrders.slice(0, 10);
                        var scored = [];

                        for (var ti = 0; ti < topOrders.length; ti++) {
                            var tOrd = topOrders[ti];

                            var tCandidate = tOrd.amount;
                            if (tCandidate > request.remaining) tCandidate = request.remaining;
                            if (tCandidate > sellableResource) tCandidate = sellableResource;

                            tCandidate = capByEnergy(tCandidate, roomName, tOrd.roomName, availableEnergy, isSellingEnergy);
                            if (tCandidate <= 0) continue;

                            var tEnergyCost = Game.market.calcTransactionCost(tCandidate, roomName, tOrd.roomName);
                            var energyCostPerUnit = tEnergyCost / tCandidate;
                            // When selling energy, the resource itself has value (energyPrice per unit),
                            // so net must subtract both the transfer cost AND the replacement cost of the energy sold.
                            // For non-energy resources, only the transfer energy cost matters.
                            var netPerUnit = isSellingEnergy
                                ? tOrd.price - energyPrice - (energyCostPerUnit * energyPrice)
                                : tOrd.price - (energyCostPerUnit * energyPrice);

                            scored.push({
                                order: tOrd,
                                feasible: tCandidate,
                                netPerUnit: netPerUnit,
                                energyCost: tEnergyCost
                            });
                        }

                        // Sort by net profit per unit, highest first
                        scored.sort(function(a, b) { return b.netPerUnit - a.netPerUnit; });

                        // Try the best scoring order(s)
                        for (var si = 0; si < scored.length && !attempted; si++) {
                            if (scored[si].netPerUnit > 0) {
                                attempted = attemptDeal(scored[si].order);
                            }
                        }

                        // Log the top pick for visibility (only if we attempted)
                        if (attempted && scored.length > 0) {
                            var top = scored[0];
                            console.log('[OpportunisticSell] Best offer: ' + top.order.roomName +
                                ' @ ' + top.order.price + ' | net/unit: ' + top.netPerUnit.toFixed(4) +
                                ' (energy cost: ' + top.energyCost + ' @ ' + energyPrice.toFixed(4) + '/unit)' +
                                (scored.length > 1 ? ' | runner-up net/unit: ' + scored[1].netPerUnit.toFixed(4) : ''));
                        }
                    } else {
                        // Default mode: among the highest external price, pick the one allowing
                        // the largest feasible sell this tick (often closest, saving energy)
                        var maxPrice = externalOrders[0].price;
                        var bestOrder = null;
                        var bestFeasible = 0;

                        for (var j = 0; j < externalOrders.length; j++) {
                            var ord = externalOrders[j];
                            if (ord.price !== maxPrice) break;

                            var candidate2 = ord.amount;
                            if (candidate2 > request.remaining) candidate2 = request.remaining;
                            if (candidate2 > sellableResource) candidate2 = sellableResource;

                            candidate2 = capByEnergy(candidate2, roomName, ord.roomName, availableEnergy, isSellingEnergy);
                            if (candidate2 > bestFeasible) {
                                bestFeasible = candidate2;
                                bestOrder = ord;
                            }
                        }

                        if (bestOrder && bestFeasible > 0) {
                            attempted = attemptDeal(bestOrder);
                        } else {
                            // Fallback: first feasible across all filtered external orders
                            for (var k = 0; k < externalOrders.length && !attempted; k++) {
                                var ord2 = externalOrders[k];

                                var candidate3 = ord2.amount;
                                if (candidate3 > request.remaining) candidate3 = request.remaining;
                                if (candidate3 > sellableResource) candidate3 = sellableResource;

                                candidate3 = capByEnergy(candidate3, roomName, ord2.roomName, availableEnergy, isSellingEnergy);
                                if (candidate3 > 0) {
                                    attempted = attemptDeal(ord2);
                                }
                            }
                        }
                    }
                }
            }
        }

        // If nothing was feasible, no transaction this tick. Will try again next eligible tick.
    }
}

/**
 * Displays all active sell requests in a readable format
 * 
 * @returns {string} Formatted list of active requests
 */
function listActiveRequests() {
    if (!Memory.opportunisticSell || !Memory.opportunisticSell.requests) {
        var message = 'No active sell requests';
        console.log('[OpportunisticSell] ' + message);
        return message;
    }

    var requests = Memory.opportunisticSell.requests;
    var output = 'Active sell requests:\n';

    for (var key in requests) {
        var req = requests[key];
        var fulfilled = req.fulfilled || 0;
        var acctTag = isAccountResource(req.resourceType) ? ' [ACCOUNT]' : '';
        var reserveTag = (req.reserve && req.reserve > 0) ? ' (reserve ' + req.reserve + ')' : '';
        var bestOfferTag = req.bestOffer ? ' [BEST OFFER]' : '';
        var priceTag = req.bestOffer ? '' : ' (min ' + req.minPrice + ' credits)';
        var pendingStr = req.pending && typeof req.pending.expected === 'number'
            ? ' (pending ' + req.pending.expected + ' awaiting confirmation)'
            : '';
        output += '- ' + req.roomName + ': ' + (req.remaining) + '/' + req.totalAmount + ' ' + req.resourceType +
                  acctTag + ' (fulfilled ' + fulfilled + ')' + priceTag + reserveTag + bestOfferTag + pendingStr + '\n';
    }

    console.log('[OpportunisticSell] ' + output);
    return output;
}

/**
 * Cancels an active sell request.
 * 
 * @param {string} roomName - The room name where the terminal is located
 * @param {string} resourceType - RESOURCE_* constant for the resource to cancel
 * @returns {string} Status message confirming cancellation
 */
function cancelRequest(roomName, resourceType) {
    var key = roomName + '_' + resourceType;
    var requests = Memory.opportunisticSell.requests;

    if (requests[key]) {
        var request = requests[key];
        var remaining = request.remaining;
        var total = request.totalAmount;

        delete requests[key];

        var message = 'Cancelled sell request for ' + remaining + '/' + total + ' ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticSell] ' + message);
        return message;
    } else {
        var message2 = 'No active sell request found for ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticSell] ' + message2);
        return message2;
    }
}

// Export functions for module system
module.exports = {
    setup: setup,
    setCheckInterval: setCheckInterval,
    setReserve: setReserve,
    setBestOffer: setBestOffer,
    process: process,
    listActiveRequests: listActiveRequests,
    cancelRequest: cancelRequest
};