// dailyFinance.js — Daily market transaction tracker
// Resets at midnight Pacific Time. Console: financeReport()

// ── Toggles ────────────────────────────────────────────────────────
const INCLUDE_ROOMS_IN_EMAIL = false;  // true = include ROOMS chunk in nightly email

const dailyFinance = {

    // ── Called every tick from main ──────────────────────────────────
    run: function () {
        // Re-register console shortcuts after every global reset
        if (!global.fR) {
            global.fR            = function (mode) { dailyFinance.report(mode || 'compact'); };
            global.financeReport = function (mode) { dailyFinance.report(mode); };
        }

        this._ensureMemory();

        // Every 100 ticks: midnight check, transaction processing, hourly snapshot
        if (Game.time % 100 === 0) {
            if (!this._checkMidnightReset()) {
                this._processTransactions();
            }
            this._maybeRecordHourlyCheck();
        }
    },

    // ── Console report command ──────────────────────────────────────
    report: function (mode) {
        if (mode === 'compact' || mode === 'c') {
            return this._reportCompact();
        }
        if (mode === 'vwap') {
            return this._reportVwap();
        }
        if (mode === 'json') {
            return this._reportJson();
        }
        const fin = Memory.dailyFinance;
        if (!fin) {
            console.log('[DailyFinance] No data yet.');
            return;
        }

        var L = [];
        const pt = dailyFinance._getPT();
        const timeStr = dailyFinance._fmt12hr(pt.hours, pt.minutes) + ' PT';
        const ticksToMidnight = dailyFinance._ticksUntilMidnight(pt);

        L.push('');
        L.push('============= DAILY FINANCE REPORT (' + fin.dateString + ') ==============');
        L.push('Time: ' + timeStr +
               ' | Est. ticks to midnight: ' + ticksToMidnight +
               ' (~' + dailyFinance._formatDuration(ticksToMidnight * 3) + ')');
        L.push('Credit Balance: ' + dailyFinance._fmtNum(Game.market.credits));
        L.push('');

        // ── Income ──
        L.push('--- INCOME (Sales) ---');
        const incomeKeys = Object.keys(fin.income).sort(function (a, b) {
            var profitA = fin.income[a] - (fin.expenses[a] || 0);
            var profitB = fin.income[b] - (fin.expenses[b] || 0);
            return profitB - profitA;
        });
        if (incomeKeys.length === 0) {
            L.push('  (none)');
        } else {
            L.push('  ' +
                'Resource'.padEnd(22) + '| ' +
                'Sold'.padStart(11) + ' | ' +
                'Bought'.padStart(11) + ' | ' +
                'Profit'.padStart(11) + ' | ' +
                '% Income'.padStart(9) + ' | ' +
                'Margin'.padStart(8));
            L.push('  ' + '-'.repeat(80));
            for (let i = 0; i < incomeKeys.length; i++) {
                const res = incomeKeys[i];
                const sold = fin.income[res];
                const bought = fin.expenses[res] || 0;
                const profit = sold - bought;
                const pct = fin.totalIncome > 0
                    ? (sold / fin.totalIncome * 100).toFixed(1) + '%'
                    : '0.0%';
                var margin;
                if (bought === 0) {
                    margin = ' Local';
                } else if (sold > 0) {
                    var m = ((sold - bought) / sold * 100).toFixed(1);
                    margin = (m >= 0 ? '+' : '') + m + '%';
                } else {
                    margin = '  N/A';
                }
                L.push('  ' +
                    res.padEnd(22) + '| ' +
                    dailyFinance._fmtNum(sold).padStart(11) + ' | ' +
                    dailyFinance._fmtNum(bought).padStart(11) + ' | ' +
                    dailyFinance._fmtNum(profit).padStart(11) + ' | ' +
                    pct.padStart(9) + ' | ' +
                    margin.padStart(8));
            }
        }
        var totalBoughtForSold = 0;
        for (let i = 0; i < incomeKeys.length; i++) {
            totalBoughtForSold += (fin.expenses[incomeKeys[i]] || 0);
        }
        var totalProfit = fin.totalIncome - totalBoughtForSold;
        var totalMargin = fin.totalIncome > 0
            ? ((fin.totalIncome - totalBoughtForSold) / fin.totalIncome * 100).toFixed(1) + '%'
            : 'N/A';
        var localIncome = 0;
        for (let i = 0; i < incomeKeys.length; i++) {
            if (!fin.expenses[incomeKeys[i]]) {
                localIncome += fin.income[incomeKeys[i]];
            }
        }
        var localPct = fin.totalIncome > 0
            ? (localIncome / fin.totalIncome * 100).toFixed(1) + '%'
            : 'N/A';
        var localProfit = localIncome;
        var localProfitPct = totalProfit > 0
            ? (localProfit / totalProfit * 100).toFixed(1) + '%'
            : 'N/A';
        L.push('  TOTAL INCOME: ' + dailyFinance._fmtNum(fin.totalIncome) +
               '   Bought: ' + dailyFinance._fmtNum(totalBoughtForSold) +
               '   Profit: ' + dailyFinance._fmtNum(totalProfit) +
               '   Avg Margin: ' + totalMargin +
               '   Local Income: ' + localPct +
               '   Local Profit: ' + localProfitPct);
        L.push('');

        // ── Expenses (only resources NOT already shown in income) ──
        L.push('--- BUFFER & NON-ARBITRAGE ACQUISITIONS ---');
        const expenseKeys = Object.keys(fin.expenses).sort(function (a, b) {
            return fin.expenses[b] - fin.expenses[a];
        }).filter(function (res) {
            return !fin.income[res];
        });
        if (expenseKeys.length === 0) {
            L.push('  (none)');
        } else {
            var bufferTotal = 0;
            for (let i = 0; i < expenseKeys.length; i++) {
                bufferTotal += fin.expenses[expenseKeys[i]];
            }
            L.push('  ' +
                'Resource'.padEnd(26) + '| ' +
                'Credits'.padStart(12) + ' | ' +
                '% of Buffer & Non-Arbitrage Acquisitions'.padStart(13));
            L.push('  ' + '-'.repeat(57));
            for (let i = 0; i < expenseKeys.length; i++) {
                const res = expenseKeys[i];
                const amt = fin.expenses[res];
                const pct = bufferTotal > 0
                    ? (amt / bufferTotal * 100).toFixed(1) + '%'
                    : '0.0%';
                L.push('  ' +
                    res.padEnd(26) + '| ' +
                    dailyFinance._fmtNum(amt).padStart(12) + ' | ' +
                    pct.padStart(13));
            }
        }
        var bufferTotal = 0;
        for (let i = 0; i < expenseKeys.length; i++) {
            bufferTotal += fin.expenses[expenseKeys[i]];
        }
        L.push('  Buffer & Non-Arbitrage Acquisitions: ' + dailyFinance._fmtNum(bufferTotal));
        L.push('  TOTAL EXPENSES:' + dailyFinance._fmtNum(fin.totalExpenses).padStart(39));
        L.push('');

        // ── Credit reconciliation (balance delta) ──
        var currentBalance = Math.round(Game.market.credits);
        var expectedBalance = fin.startingBalance + fin.totalIncome - fin.totalExpenses;
        var delta = expectedBalance - currentBalance;

        L.push('--- CREDIT RECONCILIATION ---');
        L.push('  Starting Balance:' + dailyFinance._fmtNum(fin.startingBalance).padStart(37));
        L.push('  Current Balance: ' + dailyFinance._fmtNum(currentBalance).padStart(37));
        L.push('  Expected Balance:' + dailyFinance._fmtNum(expectedBalance).padStart(37));
        if (delta >= 0) {
            L.push('  Untracked Credit Loss:' + dailyFinance._fmtNum(delta).padStart(33));
        } else {
            L.push('  Untracked Credit Gain:' + dailyFinance._fmtNum(Math.abs(delta)).padStart(33));
        }
        L.push('');

        // ── Net ──
        const net = fin.totalIncome - fin.totalExpenses - delta;
        const sign = net >= 0 ? '+' : '';
        L.push('  NET CREDIT CHANGE:' + (sign + dailyFinance._fmtNum(net)).padStart(38));
        L.push('  Transactions today: ' +
            dailyFinance._fmtNum(fin.totalSalesTx) + ' sales, ' +
            dailyFinance._fmtNum(fin.totalPurchasesTx) + ' purchases  ' +
            '(' + dailyFinance._fmtNum(fin.totalSalesTx + fin.totalPurchasesTx) + ' total)');

        // ── Null-order anomalies ──
        const nullOrder = fin.nullOrderTx;
        if (nullOrder && (nullOrder.incoming || nullOrder.outgoing)) {
            L.push('');
            L.push('  Anomalies: ' + nullOrder.outgoing + ' outgoing, ' +
                    nullOrder.incoming + ' incoming transactions had no order data');
        }

        // ── Room Trading Summary ──
        L.push('');
        L.push('--- ROOM TRADING SUMMARY (Counterparty & self-trade rooms) ---');
        L.push('  Legend: Room = room of the order you interacted with');
        L.push('          Sells = credits you received selling TO that room');
        L.push('          Buys  = credits you spent buying FROM that room');
        L.push('          Net   = net credit flow (positive = you earned more)');
        L.push('          (^) = sold there  (v) = bought there  (B) = both');
        const rooms = fin.rooms || {};
        const roomNames = Object.keys(rooms).sort(function (a, b) {
            return (rooms[b].sells + rooms[b].buys) - (rooms[a].sells + rooms[a].buys);
        });
        if (roomNames.length === 0) {
            L.push('  (no trades from counterparty or self-trade rooms today)');
        } else {
            L.push('  ' +
                'Room'.padEnd(10) + '| ' +
                'Sells'.padStart(13) + ' | ' +
                'Buys'.padStart(13) + ' | ' +
                'Net'.padStart(13) + ' | ' +
                'Resources');
            L.push('  ' + '-'.repeat(80));
            for (let ri = 0; ri < roomNames.length; ri++) {
                const rn = roomNames[ri];
                const r = rooms[rn];
                const netRoom = r.sells - r.buys;
                L.push('  ' +
                    rn.padEnd(10) + '| ' +
                    dailyFinance._fmtNum(r.sells).padStart(13) + ' | ' +
                    dailyFinance._fmtNum(r.buys).padStart(13) + ' | ' +
                    (netRoom >= 0 ? '+' : '') + dailyFinance._fmtNum(netRoom).padStart(12) + ' | ' +
                    dailyFinance._roomResStr(r.resources));
            }
        }

        // ── Hourly snapshots summary ──
        if (fin.hourlyChecks && fin.hourlyChecks.length > 0) {
            L.push('');
            L.push('  Hourly snapshots recorded: ' + fin.hourlyChecks.length + '/24');
            const last = fin.hourlyChecks[fin.hourlyChecks.length - 1];
            L.push('  Last snapshot: tick ' + last.tick +
                   ' (' + dailyFinance._fmt12hr(last.hour, last.minute) + ' PT)');
        }

        L.push('================================================================');
        L.push('');

        console.log(L.join('\n'));
    },

    // ═════════════════════════════════════════════════════════════════
    // COMPACT REPORT  —  fR()  or  financeReport('compact')
    // ═════════════════════════════════════════════════════════════════

    _reportCompact: function () {
        var fin = Memory.dailyFinance;
        if (!fin) { console.log('[DailyFinance] No data yet.'); return; }

        var self = this;
        var sn   = function (n) { return self._shortNum(n); };

        // ── Derived values ───────────────────────────────────────────
        var incomeKeys = Object.keys(fin.income);
        var totalBought = 0, localIncome = 0;
        for (var i = 0; i < incomeKeys.length; i++) {
            var bAmt = fin.expenses[incomeKeys[i]] || 0;
            totalBought += bAmt;
            if (bAmt === 0) localIncome += fin.income[incomeKeys[i]];
        }
        var totalProfit  = fin.totalIncome - totalBought;
        var avgMargin    = fin.totalIncome > 0
            ? ((totalProfit / fin.totalIncome) * 100).toFixed(1) + '%' : 'N/A';
        var localIncPct  = fin.totalIncome > 0
            ? ((localIncome / fin.totalIncome) * 100).toFixed(1) + '%' : 'N/A';
        var localProfPct = totalProfit > 0
            ? ((localIncome / totalProfit) * 100).toFixed(1) + '%' : 'N/A';

        var currentBal  = Math.round(Game.market.credits);
        var expectedBal = fin.startingBalance + fin.totalIncome - fin.totalExpenses;
        var fees        = expectedBal - currentBal;
        var net         = fin.totalIncome - fin.totalExpenses - fees;

        var bufferKeys = Object.keys(fin.expenses)
            .filter(function (r) { return !fin.income[r]; })
            .sort(function (a, b) { return fin.expenses[b] - fin.expenses[a]; });
        var bufferTotal = 0;
        for (var k = 0; k < bufferKeys.length; k++) bufferTotal += fin.expenses[bufferKeys[k]];

        var pt      = this._getPT();
        var ttm     = this._ticksUntilMidnight(pt);
        var timeStr = this._fmt12hr(pt.hours, pt.minutes) + ' PT';

        // ── Output ───────────────────────────────────────────────────
        var L = [];

        L.push('── ' + fin.dateString + '  ' + timeStr +
               '  ~' + this._formatDuration(ttm * 3) + ' left  Bal: ' + sn(currentBal) + ' ──');

        L.push('IN: ' + sn(fin.totalIncome) +
               '  Bought: ' + sn(totalBought) +
               '  Profit: ' + sn(totalProfit) +
               '  Margin: ' + avgMargin +
               '  Lcl: ' + localIncPct + ' inc / ' + localProfPct + ' profit');

        if (bufferKeys.length > 0) {
            var bufParts = [];
            for (var bi = 0; bi < bufferKeys.length; bi++) {
                bufParts.push(bufferKeys[bi] + ' ' + sn(fin.expenses[bufferKeys[bi]]));
            }
            L.push('BUFFER (' + sn(bufferTotal) + '): ' + bufParts.join('  '));
        }

        L.push('Expenses: ' + sn(fin.totalExpenses) +
               '  Delta: ' + sn(fees) +
               '  NET: ' + (net >= 0 ? '+' : '') + sn(net) +
               '  Tx: ' + fin.totalSalesTx + 's/' + fin.totalPurchasesTx + 'b');

        // ── Compact room summary ──────────────────────────────────────
        const rooms = fin.rooms || {};
        const roomNames = Object.keys(rooms).sort(function (a, b) {
            return (rooms[b].sells + rooms[b].buys) - (rooms[a].sells + rooms[a].buys);
        });
        if (roomNames.length > 0) {
            var roomParts = [];
            for (var ri = 0; ri < roomNames.length; ri++) {
                var rn = roomNames[ri];
                var r = rooms[rn];
                roomParts.push(rn + ':S' + sn(r.sells) + '/B' + sn(r.buys) +
                               ' [' + dailyFinance._roomResStr(r.resources) + ']');
            }
            L.push('Rooms: ' + roomParts.join('  '));
        }

        console.log(L.join('\n'));
    },

    // ═════════════════════════════════════════════════════════════════
    // INTERNAL METHODS
    // ═════════════════════════════════════════════════════════════════

    _ensureMemory: function () {
        if (!Memory.dailyFinance) {
            const pt = this._getPT();
            Memory.dailyFinance = {
                dateString:       this._dateString(pt),
                lastIncomingTxId: null,
                lastOutgoingTxId: null,
                startingBalance:  Math.round(Game.market.credits),
                hourlyChecks:     [],
                income:           {},
                expenses:         {},
                incomeUnits:      {},
                expenseUnits:     {},
                totalIncome:      0,
                totalExpenses:    0,
                totalSalesTx:     0,
                totalPurchasesTx: 0,
                rooms:            {},
                nullOrderTx:      { incoming: 0, outgoing: 0 },
                lastHourlyKey:    null,
                lastProcessLog:   0,
                legacyCleanupDone: true
            };
            this._seedTransactionIds();
        }
        // Migration: backfill startingBalance for existing installs
        if (Memory.dailyFinance.startingBalance === undefined) {
            Memory.dailyFinance.startingBalance = Math.round(Game.market.credits);
        }
        // Migration: backfill transaction counters for existing installs
        if (Memory.dailyFinance.totalSalesTx === undefined) {
            Memory.dailyFinance.totalSalesTx = 0;
        }
        if (Memory.dailyFinance.totalPurchasesTx === undefined) {
            Memory.dailyFinance.totalPurchasesTx = 0;
        }
        // Migration: backfill rooms
        if (!Memory.dailyFinance.rooms) {
            Memory.dailyFinance.rooms = {};
        }
        // Migration: backfill resources on existing room entries that predate this field
        var rooms = Memory.dailyFinance.rooms;
        for (var rn in rooms) {
            if (!rooms[rn].resources) rooms[rn].resources = {};
        }
        // Migration: drop legacy buyers/suppliers if still present from old installs
        if (!Memory.dailyFinance.legacyCleanupDone) {
            delete Memory.dailyFinance.buyers;
            delete Memory.dailyFinance.suppliers;
            Memory.dailyFinance.legacyCleanupDone = true;
        }
        // Migration: backfill incomeUnits, expenseUnits
        if (!Memory.dailyFinance.incomeUnits) Memory.dailyFinance.incomeUnits = {};
        if (!Memory.dailyFinance.expenseUnits) Memory.dailyFinance.expenseUnits = {};
        // Migration: backfill nullOrderTx counter
        if (!Memory.dailyFinance.nullOrderTx) {
            Memory.dailyFinance.nullOrderTx = { incoming: 0, outgoing: 0 };
        }
        // Migration: backfill lastHourlyKey & lastProcessLog
        if (Memory.dailyFinance.lastHourlyKey === undefined) Memory.dailyFinance.lastHourlyKey = null;
        if (Memory.dailyFinance.lastProcessLog === undefined) Memory.dailyFinance.lastProcessLog = 0;
    },

    // Set last-seen IDs to the newest available transactions so the first
    // real processing pass only picks up genuinely new transactions.
    _seedTransactionIds: function () {
        const out = Game.market.outgoingTransactions;
        if (out && out.length > 0) {
            Memory.dailyFinance.lastOutgoingTxId = out[0].transactionId;
        }
        const inc = Game.market.incomingTransactions;
        if (inc && inc.length > 0) {
            Memory.dailyFinance.lastIncomingTxId = inc[0].transactionId;
        }
    },

    // ── Pacific Time helpers ────────────────────────────────────────
    _getPT: function () {
        var now = new Date();
        try {
            var ptStr = now.toLocaleString('en-US', {
                timeZone: 'America/Los_Angeles',
                hour12: false
            });
            var parts = ptStr.split(', ');
            var dateParts = parts[0].split('/');
            var timeParts = parts[1].split(':');
            return {
                year:    parseInt(dateParts[2]),
                month:   parseInt(dateParts[0]),
                day:     parseInt(dateParts[1]),
                hours:   parseInt(timeParts[0]) % 24,
                minutes: parseInt(timeParts[1]),
                seconds: parseInt(timeParts[2])
            };
        } catch (e) {
            var utcMs = now.getTime();
            var ptDate = new Date(utcMs - 8 * 3600000);
            return {
                year:    ptDate.getUTCFullYear(),
                month:   ptDate.getUTCMonth() + 1,
                day:     ptDate.getUTCDate(),
                hours:   ptDate.getUTCHours(),
                minutes: ptDate.getUTCMinutes(),
                seconds: ptDate.getUTCSeconds()
            };
        }
    },

    _dateString: function (pt) {
        return pt.year + '-' +
               String(pt.month).padStart(2, '0') + '-' +
               String(pt.day).padStart(2, '0');
    },

    _ticksUntilMidnight: function (pt) {
        var secsLeft = (23 - pt.hours) * 3600 +
                       (59 - pt.minutes) * 60 +
                       (60 - pt.seconds);
        return Math.ceil(secsLeft / 3);
    },

    // ── Midnight reset ──────────────────────────────────────────────
    // Returns true if a reset occurred (caller should skip _processTransactions this tick)
    _checkMidnightReset: function () {
        var pt = this._getPT();
        var today = this._dateString(pt);

        if (Memory.dailyFinance.dateString !== today) {
            // Catch up any transactions not yet processed
            this._processTransactions();

            console.log('[DailyFinance] ☀️ New day (' + today + '). Printing final report then resetting.');
            this.report();
            this._notifyReport();

            Memory.dailyFinance = {
                dateString:       today,
                lastIncomingTxId: null,
                lastOutgoingTxId: null,
                startingBalance:  Math.round(Game.market.credits),
                hourlyChecks:     [],
                income:           {},
                expenses:         {},
                incomeUnits:      {},
                expenseUnits:     {},
                totalIncome:      0,
                totalExpenses:    0,
                totalSalesTx:     0,
                totalPurchasesTx: 0,
                rooms:            {},
                nullOrderTx:      { incoming: 0, outgoing: 0 },
                lastHourlyKey:    null,
                lastProcessLog:   0,
                legacyCleanupDone: true
            };

            // Seed transaction cursors so new-day processing starts fresh
            this._seedTransactionIds();

            return true;
        }
        return false;
    },

    // ── Email notification (compact, ≤400 chars per Game.notify) ───
    _notifyReport: function () {
        var fin = Memory.dailyFinance;
        if (!fin) return;
        var self = this;
        var LIMIT = 400;
        var msgs = [];

        var sn = function (n) { return self._shortNum(n); };

        // ── Compute derived values ──
        var incomeKeys = Object.keys(fin.income).sort(function (a, b) {
            var pa = fin.income[a] - (fin.expenses[a] || 0);
            var pb = fin.income[b] - (fin.expenses[b] || 0);
            return pb - pa;
        });
        var totalBought = 0;
        var localIncome = 0;
        for (var i = 0; i < incomeKeys.length; i++) {
            var b = fin.expenses[incomeKeys[i]] || 0;
            totalBought += b;
            if (b === 0) localIncome += fin.income[incomeKeys[i]];
        }
        var totalProfit = fin.totalIncome - totalBought;
        var localProfit = localIncome;
        var avgMargin = fin.totalIncome > 0
            ? ((totalProfit / fin.totalIncome) * 100).toFixed(1) + '%' : 'N/A';
        var localIncPct = fin.totalIncome > 0
            ? ((localIncome / fin.totalIncome) * 100).toFixed(1) + '%' : 'N/A';
        var localProfPct = totalProfit > 0
            ? ((localProfit / totalProfit) * 100).toFixed(1) + '%' : 'N/A';

        var expectedBal = fin.startingBalance + fin.totalIncome - fin.totalExpenses;
        var delta = expectedBal - Math.round(Game.market.credits);
        var net = fin.totalIncome - fin.totalExpenses - delta;

        // Buffer items (expenses not in income)
        var bufferKeys = Object.keys(fin.expenses).filter(function (r) { return !fin.income[r]; });
        bufferKeys.sort(function (a, b) { return fin.expenses[b] - fin.expenses[a]; });
        var bufferTotal = 0;
        for (var k = 0; k < bufferKeys.length; k++) bufferTotal += fin.expenses[bufferKeys[k]];

        // ── Block 1: Header + Summary ──
        var b1 = 'Finance ' + fin.dateString +
                 ' Bal:' + sn(Game.market.credits) + '\n' +
                 'IN:' + sn(fin.totalIncome) +
                 ' Bought:' + sn(totalBought) +
                 ' Profit:' + sn(totalProfit) +
                 ' Margin:' + avgMargin + '\n' +
                 'LocalInc:' + localIncPct +
                 ' LocalProfit:' + localProfPct + '\n' +
                 'OUT:' + sn(fin.totalExpenses) +
                 ' Delta:' + sn(delta) +
                 ' NET:' + (net >= 0 ? '+' : '') + sn(net) + '\n' +
                 'Tx:' + fin.totalSalesTx + 'sales/' + fin.totalPurchasesTx + 'buys';
        msgs.push(b1);

        // ── Block 2+: Income breakdown (by profit) ──
        var b2 = 'INCOME:\n';
        for (var j = 0; j < incomeKeys.length; j++) {
            var res = incomeKeys[j];
            var sold = fin.income[res];
            var bought = fin.expenses[res] || 0;
            var profit = sold - bought;
            var tag = bought === 0 ? 'L' : '';
            var line = res + ' Sold:' + sn(sold) + ' Bought:' + sn(bought) + ' Profit:' + sn(profit) + tag + '\n';
            if ((b2 + line).length > LIMIT) {
                msgs.push(b2);
                b2 = '';
            }
            b2 += line;
        }
        if (b2.length > 0) msgs.push(b2);

        // ── Block 3: Buffer items ──
        if (bufferKeys.length > 0) {
            var b3 = 'BUFFER(' + sn(bufferTotal) + '):\n';
            for (var m = 0; m < bufferKeys.length; m++) {
                var line2 = bufferKeys[m] + ':' + sn(fin.expenses[bufferKeys[m]]) + ' ';
                if ((b3 + line2).length > LIMIT) {
                    msgs.push(b3);
                    b3 = '';
                }
                b3 += line2;
            }
            if (b3.length > 0) msgs.push(b3);
        }

        // ── Block 4+: Rooms with resource symbols ──
        if (INCLUDE_ROOMS_IN_EMAIL) {
            var rooms = fin.rooms || {};
            var roomNames = Object.keys(rooms).sort(function (a, b) {
                return (rooms[b].sells + rooms[b].buys) - (rooms[a].sells + rooms[a].buys);
            });
            if (roomNames.length > 0) {
                var b4 = 'ROOMS:\n';
                for (var ri = 0; ri < roomNames.length; ri++) {
                    var rn = roomNames[ri];
                    var r = rooms[rn];
                    var netR = r.sells - r.buys;
                    var resStr = dailyFinance._roomResStr(r.resources);
                    var line3 = rn + ' S:' + sn(r.sells) + ' B:' + sn(r.buys) +
                                ' N:' + (netR >= 0 ? '+' : '') + sn(netR) +
                                ' [' + resStr + ']\n';
                    if ((b4 + line3).length > LIMIT) {
                        msgs.push(b4);
                        b4 = '';
                    }
                    b4 += line3;
                }
                if (b4.length > 0) msgs.push(b4);
            }
        }

        var total = msgs.length;
        for (var n = 0; n < total; n++) {
            Game.notify('[' + (n + 1) + '/' + total + '] ' + msgs[n], n * 10);
        }
    },

    // ── Room resource string: "energy(^) Z(v) X(B)" ────────────────
    // resources = { RES: { sells: N, buys: N }, ... }
    _roomResStr: function (resources) {
        if (!resources) return '';
        var keys = Object.keys(resources);
        if (keys.length === 0) return '';
        var parts = [];
        for (var i = 0; i < keys.length; i++) {
            var res = keys[i];
            var rv  = resources[res];
            var sym = (rv.sells > 0 && rv.buys > 0) ? '(B)' :
                      (rv.sells > 0 ? '(^)' : '(v)');
            parts.push(res + sym);
        }
        return parts.join(' ');
    },

    // Compact number: 1234567 → "1.23M", 45000 → "45.0K", 800 → "800"
    _shortNum: function (n) {
        if (n === undefined || n === null) return '0';
        var abs = Math.abs(Math.round(n));
        var sign = n < 0 ? '-' : '';
        if (abs >= 1000000) return sign + (abs / 1000000).toFixed(2) + 'M';
        if (abs >= 1000)    return sign + (abs / 1000).toFixed(1) + 'K';
        return sign + String(abs);
    },

    // ── Hourly snapshot ─────────────────────────────────────────────
    _recordHourlyCheck: function () {
        var pt = this._getPT();
        var checks = Memory.dailyFinance.hourlyChecks;

        checks.push({
            tick:     Game.time,
            hour:     pt.hours,
            minute:   pt.minutes,
            estimatedTicksToMidnight: this._ticksUntilMidnight(pt)
        });

        while (checks.length > 24) {
            checks.shift();
        }
    },

    // ── Wall-clock-hour dedup (once per hour regardless of tick timing) ──
    _maybeRecordHourlyCheck: function () {
        var pt = this._getPT();
        var key = this._dateString(pt) + ' ' + pt.hours;
        if (Memory.dailyFinance.lastHourlyKey === key) return;
        Memory.dailyFinance.lastHourlyKey = key;
        this._recordHourlyCheck();
    },

    // ═════════════════════════════════════════════════════════════════
    //  TRANSACTION PROCESSING
    // ═════════════════════════════════════════════════════════════════
    _processTransactions: function () {
        var fin = Memory.dailyFinance;

        // Quick lookup of your own active orders
        var ownOrders = Game.market.orders || {};
        var ownOrderIds = {};
        for (var oid in ownOrders) {
            ownOrderIds[oid] = true;
        }

        // --- Outgoing = we sent resources out = SALES (income) ---
        var outgoing = Game.market.outgoingTransactions;
        var newLastOutId = fin.lastOutgoingTxId;
        var outProcessed = 0;

        for (var i = 0; i < outgoing.length; i++) {
            var tx = outgoing[i];
            if (tx.transactionId === fin.lastOutgoingTxId) break;

            // Advance cursor to newest tx on first iteration (before any continue)
            if (i === 0) newLastOutId = tx.transactionId;

            if (!tx.order || tx.order.price <= 0) {
                fin.nullOrderTx.outgoing++;
                continue;
            }
            var resource = tx.resourceType;
            var credits = Math.round(tx.amount * tx.order.price);

            if (!fin.income[resource]) fin.income[resource] = 0;
            fin.income[resource] += credits;
            if (!fin.incomeUnits[resource]) fin.incomeUnits[resource] = 0;
            fin.incomeUnits[resource] += tx.amount;
            fin.totalIncome += credits;
            fin.totalSalesTx++;

            // Room tracking — use tx.to (counterparty room)
            // Skip if it's our own sell order being filled by us (pure self-trade, ignore)
            if (tx.to && (!ownOrderIds[tx.order.id] || tx.order.type === 'buy')) {
                var roomName = tx.to;
                if (!fin.rooms[roomName]) fin.rooms[roomName] = { sells: 0, buys: 0, resources: {} };
                if (!fin.rooms[roomName].resources) fin.rooms[roomName].resources = {};
                fin.rooms[roomName].sells += credits;
                if (!fin.rooms[roomName].resources[resource])
                    fin.rooms[roomName].resources[resource] = { sells: 0, buys: 0 };
                fin.rooms[roomName].resources[resource].sells += credits;
            }
            outProcessed++;
        }
        fin.lastOutgoingTxId = newLastOutId;

        // --- Incoming = we received resources = PURCHASES (expenses) ---
        var incoming = Game.market.incomingTransactions;
        var newLastInId = fin.lastIncomingTxId;
        var inProcessed = 0;

        for (var j = 0; j < incoming.length; j++) {
            var txIn = incoming[j];
            if (txIn.transactionId === fin.lastIncomingTxId) break;

            // Advance cursor to newest tx on first iteration (before any continue)
            if (j === 0) newLastInId = txIn.transactionId;

            if (!txIn.order || txIn.order.price <= 0) {
                fin.nullOrderTx.incoming++;
                continue;
            }
            var resIn = txIn.resourceType;
            var creditsIn = Math.round(txIn.amount * txIn.order.price);

            if (!fin.expenses[resIn]) fin.expenses[resIn] = 0;
            fin.expenses[resIn] += creditsIn;
            if (!fin.expenseUnits[resIn]) fin.expenseUnits[resIn] = 0;
            fin.expenseUnits[resIn] += txIn.amount;
            fin.totalExpenses += creditsIn;
            fin.totalPurchasesTx++;

            // Room tracking — use txIn.from (counterparty room)
            // Skip if it's our own buy order being filled by us (pure self-trade, ignore)
            if (txIn.from && (!ownOrderIds[txIn.order.id] || txIn.order.type === 'sell')) {
                var roomNameIn = txIn.from;
                if (!fin.rooms[roomNameIn]) fin.rooms[roomNameIn] = { sells: 0, buys: 0, resources: {} };
                if (!fin.rooms[roomNameIn].resources) fin.rooms[roomNameIn].resources = {};
                fin.rooms[roomNameIn].buys += creditsIn;
                if (!fin.rooms[roomNameIn].resources[resIn])
                    fin.rooms[roomNameIn].resources[resIn] = { sells: 0, buys: 0 };
                fin.rooms[roomNameIn].resources[resIn].buys += creditsIn;
            }
            inProcessed++;
        }
        fin.lastIncomingTxId = newLastInId;

        if (outProcessed + inProcessed > 0 &&
            (!fin.lastProcessLog || Game.time - fin.lastProcessLog >= 1000)) {
            fin.lastProcessLog = Game.time;
            console.log('[DailyFinance] Processed ' + outProcessed + ' sales, ' +
                        inProcessed + ' purchases. Running totals — Income: ' +
                        this._fmtNum(fin.totalIncome) + ' | Expenses: ' +
                        this._fmtNum(fin.totalExpenses));
        }
    },

    // ── Formatting helpers ──────────────────────────────────────────
    _fmtNum: function (n) {
        if (n === undefined || n === null) return '0';
        var neg = n < 0;
        var abs = Math.abs(Math.round(n));
        var str = String(abs);
        var result = '';
        for (var i = str.length - 1, count = 0; i >= 0; i--, count++) {
            if (count > 0 && count % 3 === 0) result = ',' + result;
            result = str[i] + result;
        }
        return neg ? '-' + result : result;
    },

    _formatDuration: function (totalSeconds) {
        var hours   = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        if (hours > 0) {
            return hours + 'h ' + minutes + 'm';
        }
        return minutes + 'm';
    },

    _fmt12hr: function (hours, minutes) {
        var suffix = hours >= 12 ? 'PM' : 'AM';
        var h = hours % 12;
        if (h === 0) h = 12;
        return h + ':' + String(minutes).padStart(2, '0') + ' ' + suffix;
    },

    // ── VWAP helpers ─────────────────────────────────────────────────
    _vwap: function (credits, units) {
        if (!units || units <= 0) return null;
        return credits / units;
    },

    _fmtPrice: function (n) {
        if (n === null || n === undefined) return 'N/A';
        if (n >= 1) return n.toFixed(3);
        if (n >= 0.01) return n.toFixed(4);
        return n.toFixed(6);
    },

    // ── VWAP Report ──────────────────────────────────────────────────
    _reportVwap: function () {
        var fin = Memory.dailyFinance;
        if (!fin) { console.log('[DailyFinance] No data yet.'); return; }

        var L = [];
        L.push('');
        L.push('============= DAILY VWAP REPORT (' + fin.dateString + ') ==============');
        L.push('');

        var resources = {};
        for (var res in fin.income) resources[res] = true;
        for (var res in fin.expenses) resources[res] = true;
        var resList = Object.keys(resources);

        if (resList.length === 0) {
            L.push('  (no data)');
        } else {
            L.push('  ' +
                'Resource'.padEnd(18) + '| ' +
                'Sold Units'.padStart(10) + ' | ' +
                'Sell VWAP'.padStart(10) + ' | ' +
                'Bought Units'.padStart(12) + ' | ' +
                'Buy VWAP'.padStart(10) + ' | ' +
                'Spread');
            L.push('  ' + '-'.repeat(83));
            for (var i = 0; i < resList.length; i++) {
                var res = resList[i];
                var soldCredits = fin.income[res] || 0;
                var soldUnits = fin.incomeUnits[res] || 0;
                var boughtCredits = fin.expenses[res] || 0;
                var boughtUnits = fin.expenseUnits[res] || 0;
                var sellVwap = soldUnits > 0 ? soldCredits / soldUnits : null;
                var buyVwap = boughtUnits > 0 ? boughtCredits / boughtUnits : null;
                var spread = sellVwap !== null && buyVwap !== null ? sellVwap - buyVwap : null;
                L.push('  ' +
                    res.padEnd(18) + '| ' +
                    this._fmtNum(soldUnits).padStart(10) + ' | ' +
                    (sellVwap !== null ? this._fmtPrice(sellVwap) : 'N/A').padStart(10) + ' | ' +
                    this._fmtNum(boughtUnits).padStart(12) + ' | ' +
                    (buyVwap !== null ? this._fmtPrice(buyVwap) : 'N/A').padStart(10) + ' | ' +
                    (spread !== null ? this._fmtPrice(spread) : 'N/A'));
            }
        }

        L.push('================================================================');
        L.push('');
        console.log(L.join('\n'));
    },

    // ── JSON Export ──────────────────────────────────────────────────
    _reportJson: function () {
        var fin = Memory.dailyFinance;
        if (!fin) { console.log('[DailyFinance] No data yet.'); return; }
        console.log(JSON.stringify(fin, null, 2));
    }
};

module.exports = dailyFinance;