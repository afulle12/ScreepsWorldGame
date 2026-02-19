/**
 * Auto Energy Buyer Module
 * Automatically buys energy when room storage falls below threshold
 */

var marketBuyer = require('marketBuy');

const DEFAULT_THRESHOLD = 300000;
const DEFAULT_BUY_AMOUNT = 50000;

var autoEnergyBuyer = {

    /**
     * Check all owned rooms and automatically buy energy if below threshold
     * @param {number} threshold - Energy threshold to trigger buying (default: 100k)
     * @param {number} buyAmount - Amount of energy to buy (default: 20k)
     */
    run: function(threshold = DEFAULT_THRESHOLD, buyAmount = DEFAULT_BUY_AMOUNT) {
        // Ensure market is unlocked and we have credits
        if (!Game.market || Game.market.credits < 0.01) {
            console.log('[AutoBuy] ERROR: Market not available or insufficient credits');
            return;
        }

        for (let roomName in Game.rooms) {
            const room = Game.rooms[roomName];

            // Only process owned rooms with BOTH storage and terminal
            // Terminal is required to create market orders【1】
            if (room.controller && room.controller.my && room.storage && room.terminal) {

                // Check STORAGE energy only - terminal energy is for fulfilling orders
                const storageEnergy = room.storage.store[RESOURCE_ENERGY] || 0;

                console.log('[AutoBuy] Checking room:', roomName, 
                          '| Storage energy:', Math.round(storageEnergy/1000)+'k',
                          '| Threshold:', Math.round(threshold/1000)+'k');

                // Only trigger if STORAGE energy is below threshold
                if (storageEnergy < threshold) {

                    // Check for existing active buy orders on the market
                    const existingOrders = Game.market.orders;
                    let hasActiveBuyOrder = false;
                    let activeOrderId = null;

                    for (const orderId in existingOrders) {
                        const order = existingOrders[orderId];
                        if (order.roomName === roomName && 
                            order.resourceType === RESOURCE_ENERGY && 
                            order.type === ORDER_BUY &&
                            order.remainingAmount > 0) {
                            hasActiveBuyOrder = true;
                            activeOrderId = orderId;
                            console.log('[AutoBuy] Found existing buy order for', roomName, 
                                      '| Remaining:', order.remainingAmount,
                                      '| Price:', order.price.toFixed(3));
                            break;
                        }
                    }

                    // Only create a new order if there isn't already one
                    if (!hasActiveBuyOrder) {
                        console.log('[AutoBuy] Storage energy in ' + roomName + ' is ' + Math.round(storageEnergy/1000) + 'k, below threshold ' + Math.round(threshold/1000) + 'k. Creating buy order for ' + Math.round(buyAmount/1000) + 'k energy.');

                        var result = marketBuyer.marketBuy(roomName, RESOURCE_ENERGY, buyAmount);

                        // Handle numeric error codes properly
                        if (typeof result === 'number') {
                            if (result === OK) {
                                console.log('[AutoBuy] Successfully created buy order for', roomName);
                            } else {
                                console.log('[AutoBuy] ERROR: marketBuy returned error code', result, 'for room', roomName);
                            }
                        } else {
                            // Handle string results (backward compatibility)
                            console.log('[AutoBuy] marketBuy result:', result);
                        }
                    } else {
                        console.log('[AutoBuy] SKIPPED', roomName, '- Active buy order already exists:', activeOrderId);
                    }
                }
            } else if (room.controller && room.controller.my && room.storage && !room.terminal) {
                console.log('[AutoBuy] WARNING: Room', roomName, 'has storage but no terminal. Market operations require a terminal.');
            }
        }
    }
};

module.exports = autoEnergyBuyer;
