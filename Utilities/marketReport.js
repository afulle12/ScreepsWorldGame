/**
 * =============================================================================
 * MODULE: Market Report Generator with Reverse Reaction Calculator
 * =============================================================================
 * 
 * COMMANDS:
 * 
 *   transactionSummary(days)
 *     Generate a market report for the last N days.
 *     Example: transactionSummary(1)
 *     Example: transactionSummary(7)
 * 
 *   reverseReactionValue([resourceType])
 *     Calculate profit/loss from breaking down compounds and selling reagents.
 *     Example: reverseReactionValue()        // All compounds
 *     Example: reverseReactionValue('XGH2O') // Specific compound
 * 
 *   marketPrices([resourceType])
 *     Show current buy/sell prices for resources.
 *     Example: marketPrices()          // All resources with orders
 *     Example: marketPrices('energy')  // Specific resource
 * 
 * =============================================================================
 */

var TICKS_PER_DAY = 28800; // ~3 seconds per tick

// Max safe integer in JavaScript (2^53 - 1)
var MAX_SAFE_INT = 9007199254740991;

// =============================================================================
// PRICE LOOKUP HELPERS
// =============================================================================

/**
 * Get the best buy price (lowest sell order) for a resource
 * This is what you'd pay to acquire the resource
 * @param {string} resourceType
 * @returns {number|null} Best buy price or null if no orders
 */
function getBestBuyPrice(resourceType) {
    var orders = Game.market.getAllOrders({
        type: ORDER_SELL,
        resourceType: resourceType
    });
    
    if (!orders || orders.length === 0) return null;
    
    var best = null;
    for (var i = 0; i < orders.length; i++) {
        if (orders[i].amount > 0) {
            if (best === null || orders[i].price < best) {
                best = orders[i].price;
            }
        }
    }
    return best;
}

/**
 * Get the best sell price (highest buy order) for a resource
 * This is what you'd receive when selling the resource
 * @param {string} resourceType
 * @returns {number|null} Best sell price or null if no orders
 */
function getBestSellPrice(resourceType) {
    var orders = Game.market.getAllOrders({
        type: ORDER_BUY,
        resourceType: resourceType
    });
    
    if (!orders || orders.length === 0) return null;
    
    var best = null;
    for (var i = 0; i < orders.length; i++) {
        if (orders[i].amount > 0) {
            if (best === null || orders[i].price > best) {
                best = orders[i].price;
            }
        }
    }
    return best;
}

/**
 * Get average price from recent market history
 * @param {string} resourceType
 * @returns {number|null} Average price or null if no history
 */
function getAveragePrice(resourceType) {
    var history = Game.market.getHistory(resourceType);
    if (!history || history.length === 0) return null;
    
    // Use the most recent day's average
    return history[history.length - 1].avgPrice;
}

/**
 * Find the reagents that make up a compound
 * @param {string} compound
 * @returns {Object|null} {a: reagent1, b: reagent2} or null
 */
function findReagents(compound) {
    for (var left in REACTIONS) {
        var row = REACTIONS[left];
        for (var right in row) {
            if (row[right] === compound) {
                return { a: left, b: right };
            }
        }
    }
    return null;
}

/**
 * Get all compounds that can be broken down
 * @returns {Array} List of compound names
 */
function getAllCompounds() {
    var compounds = new Set();
    for (var left in REACTIONS) {
        var row = REACTIONS[left];
        for (var right in row) {
            compounds.add(row[right]);
        }
    }
    return Array.from(compounds);
}

/**
 * Clamp a value to a safe integer and floor it
 * @param {number} value
 * @returns {number} Integer clamped to MAX_SAFE_INT
 */
function toSafeInt(value) {
    var floored = Math.floor(value);
    if (floored > MAX_SAFE_INT) return MAX_SAFE_INT;
    if (floored < -MAX_SAFE_INT) return -MAX_SAFE_INT;
    return floored;
}

// =============================================================================
// REVERSE REACTION VALUE CALCULATOR
// =============================================================================

global.reverseReactionValue = function(specificResource) {
    var compounds = specificResource ? [specificResource] : getAllCompounds();
    var results = [];
    
    for (var i = 0; i < compounds.length; i++) {
        var compound = compounds[i];
        var reagents = findReagents(compound);
        
        if (!reagents) {
            if (specificResource) {
                return 'Error: ' + compound + ' is not a compound (cannot be broken down)';
            }
            continue;
        }
        
        // Get prices
        var compoundBuyPrice = getBestBuyPrice(compound);      // Cost to acquire compound
        var compoundAvgPrice = getAveragePrice(compound);      // Historical average
        var reagentASellPrice = getBestSellPrice(reagents.a);  // What we get for reagent A
        var reagentBSellPrice = getBestSellPrice(reagents.b);  // What we get for reagent B
        var reagentAAvgPrice = getAveragePrice(reagents.a);
        var reagentBAvgPrice = getAveragePrice(reagents.b);
        
        // Skip if we don't have enough price data
        if (compoundBuyPrice === null && compoundAvgPrice === null) continue;
        if (reagentASellPrice === null && reagentAAvgPrice === null) continue;
        if (reagentBSellPrice === null && reagentBAvgPrice === null) continue;
        
        // Use best available prices (prefer live market, fallback to average)
        var buyAt = compoundBuyPrice !== null ? compoundBuyPrice : compoundAvgPrice;
        var sellAAt = reagentASellPrice !== null ? reagentASellPrice : reagentAAvgPrice;
        var sellBAt = reagentBSellPrice !== null ? reagentBSellPrice : reagentBAvgPrice;
        
        // Calculate profit per unit broken down
        // Breaking down 1 compound yields 1 of each reagent (actually 5:5:5 ratio but same proportion)
        var revenuePerUnit = sellAAt + sellBAt;
        var costPerUnit = buyAt;
        var profitPerUnit = revenuePerUnit - costPerUnit;
        var profitPercent = costPerUnit > 0 ? (profitPerUnit / costPerUnit * 100) : 0;
        
        results.push({
            compound: compound,
            reagentA: reagents.a,
            reagentB: reagents.b,
            buyPrice: buyAt,
            sellAPrice: sellAAt,
            sellBPrice: sellBAt,
            revenue: revenuePerUnit,
            profit: profitPerUnit,
            profitPercent: profitPercent,
            // Flag if using historical vs live prices
            usingAvgCompound: compoundBuyPrice === null,
            usingAvgA: reagentASellPrice === null,
            usingAvgB: reagentBSellPrice === null
        });
    }
    
    // Sort by profit (most profitable first)
    results.sort(function(a, b) { return b.profit - a.profit; });
    
    // Generate output
    var output = [];
    output.push('=== Reverse Reaction Profitability ===');
    output.push('Buy compound -> Break down -> Sell reagents');
    output.push('(* = using historical avg price, no live orders)');
    output.push('');
    
    if (results.length === 0) {
        output.push('No price data available for compounds.');
        return output.join('\n');
    }
    
    // Show profitable opportunities first
    var profitable = results.filter(function(r) { return r.profit > 0; });
    var unprofitable = results.filter(function(r) { return r.profit <= 0; });
    
    if (profitable.length > 0) {
        output.push('--- PROFITABLE BREAKDOWNS ---');
        for (var j = 0; j < profitable.length; j++) {
            var r = profitable[j];
            var flags = '';
            if (r.usingAvgCompound) flags += '*';
            output.push(
                r.compound + flags + ' (' + r.buyPrice.toFixed(2) + ') -> ' +
                r.reagentA + (r.usingAvgA ? '*' : '') + ' (' + r.sellAPrice.toFixed(2) + ') + ' +
                r.reagentB + (r.usingAvgB ? '*' : '') + ' (' + r.sellBPrice.toFixed(2) + ') = ' +
                '+' + r.profit.toFixed(2) + ' (' + r.profitPercent.toFixed(1) + '%)'
            );
        }
        output.push('');
    }
    
    if (!specificResource && unprofitable.length > 0) {
        output.push('--- UNPROFITABLE (top 10) ---');
        for (var k = 0; k < Math.min(10, unprofitable.length); k++) {
            var r = unprofitable[k];
            var flags = '';
            if (r.usingAvgCompound) flags += '*';
            output.push(
                r.compound + flags + ' (' + r.buyPrice.toFixed(2) + ') -> ' +
                r.reagentA + (r.usingAvgA ? '*' : '') + ' (' + r.sellAPrice.toFixed(2) + ') + ' +
                r.reagentB + (r.usingAvgB ? '*' : '') + ' (' + r.sellBPrice.toFixed(2) + ') = ' +
                r.profit.toFixed(2) + ' (' + r.profitPercent.toFixed(1) + '%)'
            );
        }
    } else if (specificResource && unprofitable.length > 0) {
        var r = unprofitable[0];
        output.push('--- NOT PROFITABLE ---');
        output.push(
            r.compound + ' (' + r.buyPrice.toFixed(2) + ') -> ' +
            r.reagentA + ' (' + r.sellAPrice.toFixed(2) + ') + ' +
            r.reagentB + ' (' + r.sellBPrice.toFixed(2) + ') = ' +
            r.profit.toFixed(2) + ' (' + r.profitPercent.toFixed(1) + '%)'
        );
    }
    
    return output.join('\n');
};

// =============================================================================
// MARKET PRICES HELPER
// =============================================================================

global.marketPrices = function(resourceType) {
    if (resourceType) {
        var buyPrice = getBestBuyPrice(resourceType);
        var sellPrice = getBestSellPrice(resourceType);
        var avgPrice = getAveragePrice(resourceType);
        
        var output = [];
        output.push('=== ' + resourceType + ' Prices ===');
        output.push('Best buy at (lowest sell order): ' + (buyPrice !== null ? buyPrice.toFixed(2) : 'N/A'));
        output.push('Best sell at (highest buy order): ' + (sellPrice !== null ? sellPrice.toFixed(2) : 'N/A'));
        output.push('Historical average: ' + (avgPrice !== null ? avgPrice.toFixed(2) : 'N/A'));
        return output.join('\n');
    }
    
    // Show all resources with orders
    var allOrders = Game.market.getAllOrders();
    var resources = {};
    
    for (var i = 0; i < allOrders.length; i++) {
        var order = allOrders[i];
        if (!resources[order.resourceType]) {
            resources[order.resourceType] = { buy: null, sell: null };
        }
        if (order.type === ORDER_SELL) {
            if (resources[order.resourceType].buy === null || order.price < resources[order.resourceType].buy) {
                resources[order.resourceType].buy = order.price;
            }
        } else {
            if (resources[order.resourceType].sell === null || order.price > resources[order.resourceType].sell) {
                resources[order.resourceType].sell = order.price;
            }
        }
    }
    
    var output = [];
    output.push('=== Market Prices (Buy/Sell) ===');
    var keys = Object.keys(resources).sort();
    for (var j = 0; j < keys.length; j++) {
        var res = keys[j];
        var data = resources[res];
        output.push(
            res + ': Buy@' + (data.buy !== null ? data.buy.toFixed(2) : 'N/A') +
            ' / Sell@' + (data.sell !== null ? data.sell.toFixed(2) : 'N/A')
        );
    }
    return output.join('\n');
};

// =============================================================================
// TRANSACTION SUMMARY (FIXED)
// =============================================================================

global.transactionSummary = function(days) {
    if (days === undefined) days = 1;
    if (typeof days !== 'number') {
        return 'Error: input days as integer.';
    }

    var timeWindow = days * TICKS_PER_DAY;
    var cutoffTime = Game.time - timeWindow;

    // --- Data Processing ---
    var incomeStats = {};
    var expenseStats = {};
    var buyers = {};
    var sellers = {};
    
    // Totals for Net Profit
    var totalIncome = 0;
    var totalExpense = 0;

    // Per-day transaction counters (keyed by day number offset from now)
    var dailyTransactions = {};

    var incoming = Game.market.incomingTransactions;
    var outgoing = Game.market.outgoingTransactions;
    
    // Track oldest transaction seen to warn about data limits
    var oldestSeen = Game.time;
    var partialData = false;

    // Total transaction count within window
    var totalTransactionCount = 0;

    // 1. Process Income (YOU SOLD something, money coming in)
    if (incoming.length > 0) {
        var lastIn = incoming[incoming.length - 1];
        if (lastIn.time > cutoffTime) {
            partialData = true;
            if (lastIn.time < oldestSeen) oldestSeen = lastIn.time;
        }

        for (var i = 0; i < incoming.length; i++) {
            var t = incoming[i];
            if (t.time < cutoffTime) continue;

            totalTransactionCount++;

            // Determine which day bucket this transaction falls into
            var ticksAgo = Game.time - t.time;
            var dayIndex = Math.floor(ticksAgo / TICKS_PER_DAY);
            if (dailyTransactions[dayIndex] === undefined) {
                dailyTransactions[dayIndex] = 0;
            }
            dailyTransactions[dayIndex]++;

            // BUG FIX: Price is in t.order.price, not t.unitPrice
            var unitPrice = 0;
            if (t.order && typeof t.order.price === 'number') {
                unitPrice = t.order.price;
            }
            
            var creditValue = t.amount * unitPrice;
            totalIncome = totalIncome + creditValue;

            var res = t.resourceType;
            if (incomeStats[res] === undefined) {
                incomeStats[res] = { count: 0, credits: 0, transactions: 0, avgPrice: 0 };
            }
            incomeStats[res].count = incomeStats[res].count + t.amount;
            incomeStats[res].credits = incomeStats[res].credits + creditValue;
            incomeStats[res].transactions = incomeStats[res].transactions + 1;

            var buyerName = 'Unknown';
            if (t.sender && t.sender.username) {
                buyerName = t.sender.username;
            }
            if (buyers[buyerName] === undefined) buyers[buyerName] = 0;
            buyers[buyerName] = buyers[buyerName] + creditValue;
        }
    }
    
    // Calculate average prices for income
    for (var iRes in incomeStats) {
        if (incomeStats[iRes].count > 0) {
            incomeStats[iRes].avgPrice = incomeStats[iRes].credits / incomeStats[iRes].count;
        }
    }

    // 2. Process Expenses (YOU BOUGHT something, money going out)
    if (outgoing.length > 0) {
        var lastOut = outgoing[outgoing.length - 1];
        if (lastOut.time > cutoffTime) {
            partialData = true;
            if (lastOut.time < oldestSeen) oldestSeen = lastOut.time;
        }

        for (var j = 0; j < outgoing.length; j++) {
            var t = outgoing[j];
            if (t.time < cutoffTime) continue;

            totalTransactionCount++;

            // Determine which day bucket this transaction falls into
            var ticksAgo = Game.time - t.time;
            var dayIndex = Math.floor(ticksAgo / TICKS_PER_DAY);
            if (dailyTransactions[dayIndex] === undefined) {
                dailyTransactions[dayIndex] = 0;
            }
            dailyTransactions[dayIndex]++;

            // BUG FIX: Price is in t.order.price, not t.unitPrice
            var unitPrice = 0;
            if (t.order && typeof t.order.price === 'number') {
                unitPrice = t.order.price;
            }
            
            var creditCost = t.amount * unitPrice;
            totalExpense = totalExpense + creditCost;

            var res = t.resourceType;
            if (expenseStats[res] === undefined) {
                expenseStats[res] = { count: 0, credits: 0, transactions: 0, avgPrice: 0 };
            }
            expenseStats[res].count = expenseStats[res].count + t.amount;
            expenseStats[res].credits = expenseStats[res].credits + creditCost;
            expenseStats[res].transactions = expenseStats[res].transactions + 1;

            var sellerName = 'Unknown';
            if (t.recipient && t.recipient.username) {
                sellerName = t.recipient.username;
            }
            if (sellers[sellerName] === undefined) sellers[sellerName] = 0;
            sellers[sellerName] = sellers[sellerName] + creditCost;
        }
    }
    
    // Calculate average prices for expenses
    for (var eRes in expenseStats) {
        if (expenseStats[eRes].count > 0) {
            expenseStats[eRes].avgPrice = expenseStats[eRes].credits / expenseStats[eRes].count;
        }
    }

    // --- Save ONLY last 24h transaction count to Memory (wipe stale data) ---
    // Count transactions from just the last 24h regardless of report window
    var last24hCutoff = Game.time - TICKS_PER_DAY;
    var last24hCount = 0;

    for (var ii = 0; ii < incoming.length; ii++) {
        if (incoming[ii].time >= last24hCutoff) last24hCount++;
    }
    for (var jj = 0; jj < outgoing.length; jj++) {
        if (outgoing[jj].time >= last24hCutoff) last24hCount++;
    }

    // Wipe and replace — only the current 24h window is stored
    Memory.marketStats = {
        transactions24h: toSafeInt(last24hCount),
        recordedAtTick: toSafeInt(Game.time)
    };

    // --- HTML Generation (Table-Safe Mode) ---
    var msg = '<h1>Market Report (' + days + ' Days)</h1>';

    if (partialData) {
        var actualDays = (Game.time - oldestSeen) / TICKS_PER_DAY;
        msg += '<p><strong>WARNING: Limited Data.</strong><br>';
        msg += 'Server history limit reached. Report covers last ' + actualDays.toFixed(2) + ' days.</p>';
    }

    // Summary Section
    var netProfit = totalIncome - totalExpense;
    msg += '<p>';
    msg += 'Total Income: ' + totalIncome.toFixed(0) + '<br>';
    msg += 'Total Expense: ' + totalExpense.toFixed(0) + '<br>';
    msg += '<strong>Net Profit: ' + netProfit.toFixed(0) + '</strong><br>';
    msg += 'Total Transactions: ' + toSafeInt(totalTransactionCount) + '<br>';
    msg += 'Transactions (last 24h): ' + toSafeInt(last24hCount);
    msg += '</p>';

    // Table: Transactions Per 24h Period
    msg += '<h3>Transactions Per 24h Period</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Period</th><th>Transactions</th></tr>';
    var sortedDayKeys = Object.keys(dailyTransactions).map(Number).sort(function(a, b) { return a - b; });
    for (var d = 0; d < sortedDayKeys.length; d++) {
        var dk = sortedDayKeys[d];
        var label = dk === 0 ? 'Today (last 24h)' : dk + ' day' + (dk > 1 ? 's' : '') + ' ago';
        msg += '<tr><td>' + label + '</td><td>' + toSafeInt(dailyTransactions[dk]) + '</td></tr>';
    }
    msg += '</table>';

    // Helper to make simple rows
    function makeRow(c1, c2, c3, c4, c5) {
        var r = '<tr>';
        r += '<td>' + c1 + '</td>';
        r += '<td>' + c2 + '</td>';
        if (c3 !== undefined) r += '<td>' + c3 + '</td>';
        if (c4 !== undefined) r += '<td>' + c4 + '</td>';
        if (c5 !== undefined) r += '<td>' + c5 + '</td>';
        r += '</tr>';
        return r;
    }

    // Table 1: Income
    msg += '<h3>Income (Sold)</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Resource</th><th>Amount</th><th>Credits</th><th>Avg Price</th><th>Trans</th></tr>';
    for (var iRes in incomeStats) {
        var d = incomeStats[iRes];
        msg += makeRow(iRes, d.count, d.credits.toFixed(0), d.avgPrice.toFixed(2), d.transactions);
    }
    msg += '</table>';

    // Table 2: Expense
    msg += '<h3>Expenses (Bought)</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Resource</th><th>Amount</th><th>Credits</th><th>Avg Price</th><th>Trans</th></tr>';
    for (var eRes in expenseStats) {
        var d = expenseStats[eRes];
        msg += makeRow(eRes, d.count, d.credits.toFixed(0), d.avgPrice.toFixed(2), d.transactions);
    }
    msg += '</table>';

    // Sort Buyers
    var buyersArr = [];
    for (var bName in buyers) {
        buyersArr.push({ name: bName, total: buyers[bName] });
    }
    buyersArr.sort(function(a, b) { return b.total - a.total; });

    // Table 3: Top Buyers
    msg += '<h3>Top Buyers (bought from you)</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Player</th><th>Spent</th></tr>';
    for (var k = 0; k < 10; k++) {
        if (k >= buyersArr.length) break;
        msg += makeRow(buyersArr[k].name, buyersArr[k].total.toFixed(0));
    }
    msg += '</table>';

    // Sort Sellers
    var sellersArr = [];
    for (var sName in sellers) {
        sellersArr.push({ name: sName, total: sellers[sName] });
    }
    sellersArr.sort(function(a, b) { return b.total - a.total; });

    // Table 4: Top Sellers
    msg += '<h3>Top Sellers (you bought from)</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Player</th><th>Earned</th></tr>';
    for (var m = 0; m < 10; m++) {
        if (m >= sellersArr.length) break;
        msg += makeRow(sellersArr[m].name, sellersArr[m].total.toFixed(0));
    }
    msg += '</table>';

    // Saved stats note
    msg += '<p><em>24h transaction count saved to Memory.marketStats.transactions24h (wiped each run)</em></p>';

    Game.notify(msg);
    return 'Report sent. Check email. 24h transactions: ' + toSafeInt(last24hCount);
};

module.exports = {};