/**
 * Opportunistic Market Buy Module
 * 
 * Sets up requests to buy resources from the market when prices are favorable.
 * 
 * Usage:
 * 1. Call opportunisticBuy.setup('ROOM#', RESOURCE, AMOUNT, MAXPRICE) from console
 * 2. Call opportunisticBuy.process() in your main loop (every 10-100 ticks)
 * 3. Call opportunisticBuy.listActiveRequests() to view current orders
 * 4. Call opportunisticBuy.cancelRequest('ROOM#', RESOURCE) to delete a request
 * 
 * The system checks for suitable sell orders every 100 ticks and purchases resources
 * under the specified price until the requested amount is fulfilled.
 * 
 * @module opportunisticBuy
 */

// Initialize memory structure on first run
if (!Memory.opportunisticBuy) {
    Memory.opportunisticBuy = {
        requests: {}
    };
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
    const key = `${roomName}_${resourceType}`;

    // Store or update the buy request
    Memory.opportunisticBuy.requests[key] = {
        roomName: roomName,
        resourceType: resourceType,
        totalAmount: amount,
        remaining: amount,
        maxPrice: maxPrice,
        lastCheck: 0
    };

    const message = `Buy request for ${amount} ${resourceType} in ${roomName} created (max ${maxPrice} credits/unit)`;
    console.log(`[OpportunisticBuy] ${message}`);
    return message;
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
    let low = 0;
    let high = desired;
    while (low < high) {
        const mid = low + Math.ceil((high - low) / 2);
        const cost = Game.market.calcTransactionCost(mid, fromRoom, toRoom);
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
 */
function process() {
    if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) return;

    const requests = Memory.opportunisticBuy.requests;

    for (const key in requests) {
        const request = requests[key];

        // Skip completed requests
        if (request.remaining <= 0) continue;

        // Check if it's time to check the market (every 100 ticks)
        if (Game.time - request.lastCheck >= 100) {
            request.lastCheck = Game.time;

            // Get the terminal from the specified room
            const room = Game.rooms[request.roomName];
            const terminal = room && room.terminal;
            if (!room || !terminal) continue; // Room or terminal not available

            // Get all relevant sell orders below or equal to maxPrice
            const orders = Game.market.getAllOrders({
                type: ORDER_SELL,
                resourceType: request.resourceType
            }).filter(function(order) {
                return order.price <= request.maxPrice && order.amount > 0;
            }).sort(function(a, b) {
                return a.price - b.price; // Cheapest first
            });

            if (orders.length === 0) continue; // No suitable orders found

            // Track how much we bought and spent this check
            let boughtThisCheck = 0;
            let spentCreditsThisCheck = 0;

            // Current balances
            let availableEnergy = terminal.store[RESOURCE_ENERGY] || 0;

            // Process each order until we reach our target amount
            for (let i = 0; i < orders.length; i++) {
                const order = orders[i];
                if (boughtThisCheck >= request.remaining) break;

                // Max we still want
                let buyAmount = Math.min(order.amount, request.remaining - boughtThisCheck);
                if (buyAmount <= 0) continue;

                // Recompute credits left live each iteration to reduce race issues
                const creditsLeft = Game.market.credits - spentCreditsThisCheck;
                const maxAffordableByCredits = Math.floor(creditsLeft / order.price);
                if (maxAffordableByCredits <= 0) {
                    console.log(`[OpportunisticBuy] Insufficient credits to buy ${request.resourceType} at ${order.price} (balance: ${Game.market.credits.toFixed(3)})`);
                    break; // No more credits for any order at/under maxPrice
                }
                buyAmount = Math.min(buyAmount, maxAffordableByCredits);

                // Cap by terminal free capacity to avoid failed deals due to storage constraints
                const freeCapacity = terminal.store.getFreeCapacity();
                if (freeCapacity <= 0) {
                    console.log(`[OpportunisticBuy] Terminal is full in ${request.roomName}, cannot receive more ${request.resourceType}`);
                    break;
                }
                buyAmount = Math.min(buyAmount, freeCapacity);

                // Cap by exact energy cost using binary search
                buyAmount = capByEnergy(buyAmount, request.roomName, order.roomName, availableEnergy);
                if (buyAmount <= 0) {
                    console.log(`[OpportunisticBuy] Insufficient terminal energy for market transfer ${request.roomName} -> ${order.roomName} (energy: ${availableEnergy})`);
                    break;
                }

                // Execute the deal
                const result = Game.market.deal(order.id, buyAmount, request.roomName);

                // Game.market.deal returns OK on success; amount is transferred to your terminal, and energy is consumed based on calcTransactionCost. 
                if (result === OK) {
                    const energyCost = Game.market.calcTransactionCost(buyAmount, request.roomName, order.roomName);
                    const creditsCost = buyAmount * order.price;

                    boughtThisCheck += buyAmount;
                    spentCreditsThisCheck += creditsCost;
                    availableEnergy = Math.max(0, availableEnergy - energyCost);

                    console.log(`[OpportunisticBuy] Bought ${buyAmount} ${request.resourceType} from ${order.roomName} @ ${order.price} (credits: ${creditsCost.toFixed(3)}, energy: ${energyCost}).`);
                } else {
                    // Handle common errors
                    let errorMessage = `Unknown error: ${result}`;
                    if (result === ERR_NOT_ENOUGH_RESOURCES) {
                        // Market uses this code for insufficient credits or insufficient order resources.
                        errorMessage = 'Insufficient credits or order resources';
                    } else if (result === ERR_INVALID_ARGS) {
                        errorMessage = 'Invalid arguments';
                    } else if (result === ERR_NOT_ENOUGH_ENERGY) {
                        errorMessage = 'Insufficient terminal energy';
                    } else if (result === ERR_NOT_FOUND) {
                        errorMessage = 'Order no longer available';
                    }
                    console.log(`[OpportunisticBuy] Error buying from order ${order.id} (${order.roomName}): ${errorMessage}`);
                }
            }

            // Update remaining amount ONLY if we actually bought something
            if (boughtThisCheck > 0) {
                request.remaining -= boughtThisCheck;
                console.log(`[OpportunisticBuy] Total bought this check: ${boughtThisCheck} ${request.resourceType}. ${request.remaining} remaining.`);
            }

            // Clean up completed requests
            if (request.remaining <= 0) {
                delete requests[key];
                console.log(`[OpportunisticBuy] Completed buy request for ${request.resourceType} in ${request.roomName}`);
            }
        }
    }
}

/**
 * Displays all active buy requests in a readable format
 * 
 * @returns {string} Formatted list of active requests
 */
function listActiveRequests() {
    if (!Memory.opportunisticBuy || !Memory.opportunisticBuy.requests) {
        const message = "No active buy requests";
        console.log(`[OpportunisticBuy] ${message}`);
        return message;
    }

    const requests = Memory.opportunisticBuy.requests;
    let output = "Active buy requests:\n";

    for (const key in requests) {
        const req = requests[key];
        output += `- ${req.roomName}: ${req.remaining}/${req.totalAmount} ${req.resourceType} ` +
                 `(max ${req.maxPrice} credits) - ` +
                 `${req.remaining > 0 ? 'Active' : 'Completed'}\n`;
    }

    console.log(`[OpportunisticBuy] ${output}`);
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
    const key = `${roomName}_${resourceType}`;
    const requests = Memory.opportunisticBuy.requests;

    if (requests[key]) {
        // Store details for the confirmation message
        const request = requests[key];
        const remaining = request.remaining;
        const total = request.totalAmount;

        // Delete the request
        delete requests[key];

        const message = `Cancelled buy request for ${remaining}/${total} ${resourceType} in ${roomName}`;
        console.log(`[OpportunisticBuy] ${message}`);
        return message;
    } else {
        const message = `No active buy request found for ${resourceType} in ${roomName}`;
        console.log(`[OpportunisticBuy] ${message}`);
        return message;
    }
}

// Export functions for module system
module.exports = {
    setup: setup,
    process: process,
    listActiveRequests: listActiveRequests,
    cancelRequest: cancelRequest
};
