/*
 * Module: Market Report Generator (Safe Mode + Net Profit)
 * Author: Screeps Script
 *
 * Usage: transactionSummary(days)
 * Example: transactionSummary(1)
 */

var TICKS_PER_DAY = 28800; // 3 seconds per tick

global.transactionSummary = function(days) {
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

    var incoming = Game.market.incomingTransactions;
    var outgoing = Game.market.outgoingTransactions;
    
    // Track oldest transaction seen to warn about data limits
    var oldestSeen = Game.time;
    var partialData = false;

    // 1. Process Income
    if (incoming.length > 0) {
        var lastIn = incoming[incoming.length - 1];
        if (lastIn.time > cutoffTime) {
            partialData = true;
            if (lastIn.time < oldestSeen) oldestSeen = lastIn.time;
        }

        for (var i = 0; i < incoming.length; i++) {
            var t = incoming[i];
            if (t.time < cutoffTime) continue;

            var creditValue = t.amount * t.unitPrice;
            totalIncome = totalIncome + creditValue;

            var res = t.resourceType;
            if (incomeStats[res] === undefined) {
                incomeStats[res] = { count: 0, credits: 0, transactions: 0 };
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

    // 2. Process Expenses
    if (outgoing.length > 0) {
        var lastOut = outgoing[outgoing.length - 1];
        if (lastOut.time > cutoffTime) {
            partialData = true;
            if (lastOut.time < oldestSeen) oldestSeen = lastOut.time;
        }

        for (var j = 0; j < outgoing.length; j++) {
            var t = outgoing[j];
            if (t.time < cutoffTime) continue;

            var creditCost = t.amount * t.unitPrice;
            totalExpense = totalExpense + creditCost;

            var res = t.resourceType;
            if (expenseStats[res] === undefined) {
                expenseStats[res] = { count: 0, credits: 0, transactions: 0 };
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
    msg += '<strong>Net Profit: ' + netProfit.toFixed(0) + '</strong>';
    msg += '</p>';

    // Helper to make simple rows
    function makeRow(c1, c2, c3, c4) {
        var r = '<tr>';
        r += '<td>' + c1 + '</td>';
        r += '<td>' + c2 + '</td>';
        if (c3 !== undefined) r += '<td>' + c3 + '</td>';
        if (c4 !== undefined) r += '<td>' + c4 + '</td>';
        r += '</tr>';
        return r;
    }

    // Table 1: Income
    msg += '<h3>Income</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Resource</th><th>Sold</th><th>Credits</th><th>Trans</th></tr>';
    for (var iRes in incomeStats) {
        var d = incomeStats[iRes];
        msg += makeRow(iRes, d.count, d.credits.toFixed(0), d.transactions);
    }
    msg += '</table>';

    // Table 2: Expense
    msg += '<h3>Expenses</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Resource</th><th>Bought</th><th>Credits</th><th>Trans</th></tr>';
    for (var eRes in expenseStats) {
        var d = expenseStats[eRes];
        msg += makeRow(eRes, d.count, d.credits.toFixed(0), d.transactions);
    }
    msg += '</table>';

    // Sort Buyers
    var buyersArr = [];
    for (var bName in buyers) {
        buyersArr.push({ name: bName, total: buyers[bName] });
    }
    buyersArr.sort(function(a, b) { return b.total - a.total; });

    // Table 3: Top Buyers
    msg += '<h3>Top Buyers</h3>';
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
    msg += '<h3>Top Sellers</h3>';
    msg += '<table border="1" cellspacing="0" cellpadding="4">';
    msg += '<tr><th>Player</th><th>Earned</th></tr>';
    for (var m = 0; m < 10; m++) {
        if (m >= sellersArr.length) break;
        msg += makeRow(sellersArr[m].name, sellersArr[m].total.toFixed(0));
    }
    msg += '</table>';

    Game.notify(msg);
    return 'Report sent. Check email.';
};

module.exports = {};