/**
 * Opportunistic Market Buy Module
 * 
 * Sets up requests to buy resources from the market when prices are favorable.
 * 
 * Usage:
 * 1. Call opportunisticBuy.setup('ROOM#', RESOURCE, AMOUNT, MAXPRICE) from console
 * 2. Call opportunisticBuy.process() in your main loop (every tick is fine)
 * 3. Call opportunisticBuy.listActiveRequests() to view current orders
 * 4. Call opportunisticBuy.cancelRequest('ROOM#', RESOURCE) to delete a request
 * 
 * Behavior:
 * - Attempts at most one market deal per terminal at a time.
 * - Among requests for the same terminal in the same tick, prefers the one created earlier.
 * - Attempts every tick by default (configurable via `checkInterval` on each request).
 * - Caches the last successful order to reduce scanning and speed follow-up purchases.
 * - Chooses the cheapest feasible order. Among equally cheap, prefers the one allowing
 *   the largest buy amount this tick (often closest, saving energy).
 * - Validates transfers by comparing terminal resource counts before and after a deal; 
 *   progress is updated only after the terminal reflects the transfer.
 * - Pending confirmations time out after 20 ticks; timed-out deals are not counted,
 *   the cached order is invalidated, and the module immediately retries new deals.
 * - Orders from our own rooms are always accepted regardless of maxPrice, since credits
 *   cycle back to us (only transfer energy is the real cost).
 * 
 * @module opportunisticBuy
 */

// Confirmation timeout in ticks for pending market deals
var CONFIRMATION_TIMEOUT_TICKS = 20;

// Initialize memory structure on first run
if (!Memory.opportunisticBuy) {
    Memory.opportunisticBuy = {
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

/**
 * Sets up an opportunistic buy request.
 * 
 * @param {string} roomName - The room name where the terminal is located
 * @param {string} resourceType - RESOURCE_* constant for the resource to buy
 * @param {number} amount - Target amount to purchase
 * @param {number} maxPrice - Maximum price per unit willing to pay
 * @returns {string} Status message confirming request setup
 */
function setup(roomName, resourceType, amount, maxPrice) {
    var key = roomName + '_' + resourceType;
    var existing = Memory.opportunisticBuy.requests[key];

    // Preserve original createdAt if request already exists
    var createdAt = existing && typeof existing.createdAt === 'number' ? existing.createdAt : Game.time;

    // Store or update the buy request
    Memory.opportunisticBuy.requests[key] = {
        roomName: roomName,
        resourceType: resourceType,
        totalAmount: amount,
        remaining: amount,
        maxPrice: maxPrice,
        lastCheck: 0,
        checkInterval: 1, // attempt every tick by default
        cachedOrderId: null,
        cachedOrderRoomName: null,
        createdAt: createdAt,
        fulfilled: 0,
        pending: null // { pre: number, expected: number, tick: number, orderId, orderRoom, price, energyCost }
    };

    var message = 'Buy request for ' + amount + ' ' + resourceType + ' in ' + roomName + ' created (max ' + maxPrice + ' credits/unit)';
    console.log('[OpportunisticBuy] ' + message);
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
    var requests = Memory.opportunisticBuy.requests;
    if (!requests || !requests[key]) {
        var msgMissing = 'No active buy request found for ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticBuy] ' + msgMissing);
        return msgMissing;
    }
    if (typeof ticks !== 'number' || ticks < 1) {
        var msgBad = 'Invalid checkInterval ' + ticks + ' (must be number >= 1)';
        console.log('[OpportunisticBuy] ' + msgBad);
        return msgBad;
    }
    requests[key].checkInterval = ticks;
    var msgOk = 'Set checkInterval for ' + roomName + ' ' + resourceType + ' to ' + ticks + ' ticks';
    console.log('[OpportunisticBuy] ' + msgOk);
    return msgOk;
}

/**
 * Helper: cap desired buy amount by available terminal energy using exact calcTransactionCost.
 * Uses binary search to find the largest amount whose transfer energy cost does not exceed energyAvail.
 * 
 * @param {number} desired - Desired units to buy
 * @param {string} fromRoom - Your room name (terminal that will receive and pay energy)
 * @param {string} toRoom - Remote order room name
 * @param {number} energyAvail - Energy currently available in your terminal
 * @returns {number} Amount capped by energy
 */
function capByEnergy(desired, fromRoom, toRoom, energyAvail) {
    if (energyAvail <= 0 || desired <= 0) return 0;
    var low = 0;
    var high = desired;
    while (low < high) {
        var mid = low + Math.ceil((high - low) / 2);
        var cost = Game.market.calcTransactionCost(mid, fromRoom, toRoom);
        if (cost <= energyAvail) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

/**
 * Processes all active opportunistic buy requests.
 * Should be called periodically in your main loop.
 * 
 * - Confirms pending deals by comparing terminal before/after counts.
 * - Executes at most one deal per terminal per tick.
 * - Among requests for the same terminal, the earlier created is processed first.
 * - Orders from our own rooms are accepted regardless of maxPrice (credits cycle back).
 */
function process() {
    if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) return;

    var requests = Memory.opportunisticBuy.requests;

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

        var roomName = request.roomName;
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal;
        if (!room || !terminal) continue;

        // Always try to confirm a pending deal first; block new deals in this room until confirmed
        if (request.pending && typeof request.pending.expected === 'number') {
            var pre = request.pending.pre || 0;
            var curr = terminal.store[request.resourceType] || 0;
            var expected = request.pending.expected;
            var delta = curr - pre;

            if (delta >= expected) {
                // Confirm full expected receipt
                request.fulfilled = (request.fulfilled || 0) + expected;
                request.remaining -= expected;

                console.log('[OpportunisticBuy] Confirmed ' + expected + ' ' + request.resourceType + ' delivered to ' + roomName +
                    ' from ' + (request.pending.orderRoom || 'unknown') + '. Progress: ' +
                    request.fulfilled + '/' + request.totalAmount + ' ' + request.resourceType + ' purchased.');

                request.pending = null;

                if (request.remaining <= 0) {
                    delete requests[key_i];
                    console.log('[OpportunisticBuy] Completed buy request for ' + request.resourceType + ' in ' + roomName);
                }

                // Move to next request after confirmation
                continue;
            } else {
                // Timeout logic: if pending confirmation hasn't arrived within CONFIRMATION_TIMEOUT_TICKS, drop it and retry this tick
                var pendingTick = request.pending.tick || 0;
                var waited = Game.time - pendingTick; // tick-based timing
                if (waited > CONFIRMATION_TIMEOUT_TICKS) {
                    console.log('[OpportunisticBuy] Confirmation timeout after ' + waited + ' ticks for order ' +
                        (request.pending.orderId || 'unknown') + ' to ' + roomName + '. Clearing pending without counting ' +
                        expected + ' ' + request.resourceType + ' and retrying.');
                    // Do not count anything; just clear pending and allow new deals this tick
                    request.pending = null;

                    // Invalidate cache to avoid sticking to a possibly stale/unreliable order
                    request.cachedOrderId = null;
                    request.cachedOrderRoomName = null;

                    // Do not continue here; fall through to attempt new deals this tick
                } else {
                    // Still waiting; do not place new deals from this terminal until confirmed
                    roomAttemptedThisTick[roomName] = true;
                    // Move to next request while awaiting confirmation
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
        if (terminal.cooldown > 0) {
            //console.log('[OpportunisticBuy] Terminal in ' + roomName + ' is on cooldown (' + terminal.cooldown + '), skipping this tick.');
            continue;
        }

        // Current balances and capacity
        var availableEnergy = terminal.store[RESOURCE_ENERGY] || 0;
        var freeCapacity = terminal.store.getFreeCapacity();
        if (freeCapacity <= 0) {
            //console.log('[OpportunisticBuy] Terminal is full in ' + roomName + ', cannot receive more ' + request.resourceType);
            continue;
        }

        // Helper: attempt a single deal, but only mark progress after confirmation
        function attemptDeal(order) {
            var isOwnRoom = !!(order.roomName && myRooms[order.roomName]);
            var creditsLeft = Game.market.credits;
            var maxAffordableByCredits = Math.floor(creditsLeft / order.price);
            if (maxAffordableByCredits <= 0 && !isOwnRoom) {
                console.log('[OpportunisticBuy] Insufficient credits to buy ' + request.resourceType + ' at ' + order.price + ' (balance: ' + Game.market.credits.toFixed(3) + ')');
                return true; // consume attempt
            }

            var candidate = order.amount;
            if (candidate > request.remaining) candidate = request.remaining;
            if (!isOwnRoom && candidate > maxAffordableByCredits) candidate = maxAffordableByCredits;
            if (candidate > freeCapacity) candidate = freeCapacity;

            var cappedByEnergy = capByEnergy(candidate, roomName, order.roomName, availableEnergy);
            if (cappedByEnergy <= 0) {
                // Not feasible due to energy; try another order
                return false;
            }
            candidate = cappedByEnergy;

            var preStore = terminal.store[request.resourceType] || 0;

            var result = Game.market.deal(order.id, candidate, roomName);
            if (result === OK) {
                var energyCost = Game.market.calcTransactionCost(candidate, roomName, order.roomName);
                var creditsCost = candidate * order.price;

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
                console.log('[OpportunisticBuy] Placed deal for ' + candidate + ' ' + request.resourceType + ' from ' + order.roomName + ownTag +
                    ' @ ' + order.price + ' (credits: ' + creditsCost.toFixed(3) + ', energy: ' + energyCost + '). Awaiting terminal confirmation.');
                return true;
            } else {
                var errorMessage = 'Unknown error: ' + result;
                if (result === ERR_NOT_ENOUGH_RESOURCES) {
                    errorMessage = 'Insufficient credits or order resources';
                } else if (result === ERR_INVALID_ARGS) {
                    errorMessage = 'Invalid arguments';
                } else if (result === ERR_NOT_ENOUGH_ENERGY) {
                    errorMessage = 'Insufficient terminal energy';
                } else if (result === ERR_NOT_FOUND) {
                    errorMessage = 'Order no longer available';
                } else if (result === ERR_TIRED) {
                    errorMessage = 'Terminal cooldown';
                }
                console.log('[OpportunisticBuy] Error buying from order ' + order.id + ' (' + order.roomName + '): ' + errorMessage);

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
                (cached.price <= request.maxPrice || cachedIsOwn) &&
                cached.amount > 0) {
                attempted = attemptDeal(cached);
            } else {
                // Invalidate cache if not usable
                request.cachedOrderId = null;
                request.cachedOrderRoomName = null;
            }
        }

        // 2) If no attempt yet, scan orders for the best feasible one
        if (!attempted) {
            var orders = Game.market.getAllOrders({
                type: ORDER_SELL,
                resourceType: request.resourceType
            }).filter(function(order) {
                // Accept orders from our own rooms regardless of price,
                // since credits cycle back to us (only transfer energy is the real cost)
                if (order.roomName && myRooms[order.roomName]) return order.amount > 0;
                return order.price <= request.maxPrice && order.amount > 0;
            }).sort(function(a, b) {
                // Prefer own-room orders first (effective price = 0), then cheapest
                var aOwn = (a.roomName && myRooms[a.roomName]) ? 1 : 0;
                var bOwn = (b.roomName && myRooms[b.roomName]) ? 1 : 0;
                if (aOwn !== bOwn) return bOwn - aOwn; // own rooms first
                return a.price - b.price; // then cheapest
            });

            if (orders.length === 0) continue;

            // Check if the best order is from our own room — if so, just use it directly
            var bestIsOwn = !!(orders[0].roomName && myRooms[orders[0].roomName]);

            if (bestIsOwn) {
                // Prefer own-room orders: try each own-room order by feasible amount
                for (var oj = 0; oj < orders.length && !attempted; oj++) {
                    var ownOrd = orders[oj];
                    if (!(ownOrd.roomName && myRooms[ownOrd.roomName])) break; // past own-room orders

                    // Skip if the order is from the SAME room we're buying into (no self-transfer)
                    if (ownOrd.roomName === roomName) continue;

                    var candidate0 = ownOrd.amount;
                    if (candidate0 > request.remaining) candidate0 = request.remaining;
                    if (candidate0 > freeCapacity) candidate0 = freeCapacity;
                    candidate0 = capByEnergy(candidate0, roomName, ownOrd.roomName, availableEnergy);
                    if (candidate0 > 0) {
                        attempted = attemptDeal(ownOrd);
                    }
                }
            }

            // If own-room orders didn't work out, fall back to external orders
            if (!attempted) {
                // Among the cheapest external price, pick the one allowing the largest feasible buy this tick
                var externalOrders = [];
                for (var ei = 0; ei < orders.length; ei++) {
                    if (!(orders[ei].roomName && myRooms[orders[ei].roomName])) {
                        externalOrders.push(orders[ei]);
                    }
                }

                if (externalOrders.length > 0) {
                    var minPrice = externalOrders[0].price;
                    var bestOrder = null;
                    var bestFeasible = 0;

                    for (var j = 0; j < externalOrders.length; j++) {
                        var ord = externalOrders[j];
                        if (ord.price !== minPrice) break;

                        var creditsLeft2 = Game.market.credits;
                        var maxAffordableByCredits2 = Math.floor(creditsLeft2 / ord.price);
                        if (maxAffordableByCredits2 <= 0) break;

                        var candidate2 = ord.amount;
                        if (candidate2 > request.remaining) candidate2 = request.remaining;
                        if (candidate2 > maxAffordableByCredits2) candidate2 = maxAffordableByCredits2;
                        if (candidate2 > freeCapacity) candidate2 = freeCapacity;

                        candidate2 = capByEnergy(candidate2, roomName, ord.roomName, availableEnergy);
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

                            var creditsLeft3 = Game.market.credits;
                            var maxAffordableByCredits3 = Math.floor(creditsLeft3 / ord2.price);
                            if (maxAffordableByCredits3 <= 0) break;

                            var candidate3 = ord2.amount;
                            if (candidate3 > request.remaining) candidate3 = request.remaining;
                            if (candidate3 > maxAffordableByCredits3) candidate3 = maxAffordableByCredits3;
                            if (candidate3 > freeCapacity) candidate3 = freeCapacity;

                            candidate3 = capByEnergy(candidate3, roomName, ord2.roomName, availableEnergy);
                            if (candidate3 > 0) {
                                attempted = attemptDeal(ord2);
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
 * Displays all active buy requests in a readable format
 * 
 * @returns {string} Formatted list of active requests
 */
function listActiveRequests() {
    if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) {
        var message = 'No active buy requests';
        console.log('[OpportunisticBuy] ' + message);
        return message;
    }

    var requests = Memory.opportunisticBuy.requests;
    var output = 'Active buy requests:\n';

    for (var key in requests) {
        var req = requests[key];
        var fulfilled = req.fulfilled || 0;
        var pendingStr = req.pending && typeof req.pending.expected === 'number'
            ? ' (pending ' + req.pending.expected + ' awaiting confirmation)'
            : '';
        output += '- ' + req.roomName + ': ' + (req.remaining) + '/' + req.totalAmount + ' ' + req.resourceType +
                  ' (fulfilled ' + fulfilled + ')' + ' (max ' + req.maxPrice + ' credits)' + pendingStr + '\n';
    }

    console.log('[OpportunisticBuy] ' + output);
    return output;
}

/**
 * Cancels an active buy request.
 * 
 * @param {string} roomName - The room name where the terminal is located
 * @param {string} resourceType - RESOURCE_* constant for the resource to cancel
 * @returns {string} Status message confirming cancellation
 */
function cancelRequest(roomName, resourceType) {
    var key = roomName + '_' + resourceType;
    var requests = Memory.opportunisticBuy.requests;

    if (requests[key]) {
        // Store details for the confirmation message
        var request = requests[key];
        var remaining = request.remaining;
        var total = request.totalAmount;

        // Delete the request
        delete requests[key];

        var message = 'Cancelled buy request for ' + remaining + '/' + total + ' ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticBuy] ' + message);
        return message;
    } else {
        var message2 = 'No active buy request found for ' + resourceType + ' in ' + roomName;
        console.log('[OpportunisticBuy] ' + message2);
        return message2;
    }
}

// Export functions for module system
module.exports = {
    setup: setup,
    setCheckInterval: setCheckInterval,
    process: process,
    listActiveRequests: listActiveRequests,
    cancelRequest: cancelRequest
};