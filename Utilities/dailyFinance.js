// dailyFinance.js — Daily market transaction tracker
// Resets at midnight Pacific Time. Console: financeReport()

const dailyFinance = {

    // ── Called every tick from main ──────────────────────────────────
    run: function () {
        this._ensureMemory();

        // Midnight reset check (every 100 ticks to save CPU)
        if (Game.time % 100 === 0) {
            this._checkMidnightReset();
        }

        // Process transactions every 100 ticks
        if (Game.time % 100 === 0) {
            this._processTransactions();
        }

        // Hourly time snapshot (~1200 ticks ≈ 1 hour at 3s/tick)
        if (Game.time % 1200 === 0) {
            this._recordHourlyCheck();
        }
    },

    // ── Console report command ──────────────────────────────────────
    report: function () {
        const fin = Memory.dailyFinance;
        if (!fin) {
            console.log('[DailyFinance] No data yet.');
            return;
        }

        const pt = dailyFinance._getPT();
        const timeStr = String(pt.hours).padStart(2, '0') + ':' +
                        String(pt.minutes).padStart(2, '0') + ' PT';
        const ticksToMidnight = dailyFinance._ticksUntilMidnight(pt);

        console.log('');
        console.log('============= DAILY FINANCE REPORT (' + fin.dateString + ') ==============');
        console.log('Time: ' + timeStr +
                     ' | Est. ticks to midnight: ' + ticksToMidnight +
                     ' (~' + dailyFinance._formatDuration(ticksToMidnight * 3) + ')');
        console.log('Credit Balance: ' + dailyFinance._fmtNum(Game.market.credits));
        console.log('');

        // ── Income ──
        console.log('--- INCOME (Sales) ---');
        const incomeKeys = Object.keys(fin.income).sort(function (a, b) {
            return fin.income[b] - fin.income[a];
        });
        if (incomeKeys.length === 0) {
            console.log('  (none)');
        } else {
            console.log('  ' +
                'Resource'.padEnd(26) + '| ' +
                'Credits'.padStart(12) + ' | ' +
                '% of Income'.padStart(11));
            console.log('  ' + '-'.repeat(55));
            for (let i = 0; i < incomeKeys.length; i++) {
                const res = incomeKeys[i];
                const amt = fin.income[res];
                const pct = fin.totalIncome > 0
                    ? (amt / fin.totalIncome * 100).toFixed(1) + '%'
                    : '0.0%';
                console.log('  ' +
                    res.padEnd(26) + '| ' +
                    dailyFinance._fmtNum(amt).padStart(12) + ' | ' +
                    pct.padStart(11));
            }
        }
        console.log('  TOTAL INCOME:' + dailyFinance._fmtNum(fin.totalIncome).padStart(41));
        console.log('');

        // ── Expenses ──
        console.log('--- EXPENSES (Purchases) ---');
        const expenseKeys = Object.keys(fin.expenses).sort(function (a, b) {
            return fin.expenses[b] - fin.expenses[a];
        });
        if (expenseKeys.length === 0) {
            console.log('  (none)');
        } else {
            console.log('  ' +
                'Resource'.padEnd(26) + '| ' +
                'Credits'.padStart(12) + ' | ' +
                '% of Expenses'.padStart(13));
            console.log('  ' + '-'.repeat(57));
            for (let i = 0; i < expenseKeys.length; i++) {
                const res = expenseKeys[i];
                const amt = fin.expenses[res];
                const pct = fin.totalExpenses > 0
                    ? (amt / fin.totalExpenses * 100).toFixed(1) + '%'
                    : '0.0%';
                console.log('  ' +
                    res.padEnd(26) + '| ' +
                    dailyFinance._fmtNum(amt).padStart(12) + ' | ' +
                    pct.padStart(13));
            }
        }
        console.log('  TOTAL EXPENSES:' + dailyFinance._fmtNum(fin.totalExpenses).padStart(39));
        console.log('');

        // ── Fees (derived from balance delta) ──
        var currentBalance = Math.round(Game.market.credits);
        var expectedBalance = fin.startingBalance + fin.totalIncome - fin.totalExpenses;
        var delta = expectedBalance - currentBalance;

        console.log('--- MARKET FEES ---');
        console.log('  Starting Balance:' + dailyFinance._fmtNum(fin.startingBalance).padStart(37));
        console.log('  Current Balance: ' + dailyFinance._fmtNum(currentBalance).padStart(37));
        console.log('  Expected Balance:' + dailyFinance._fmtNum(expectedBalance).padStart(37));
        if (delta >= 0) {
            console.log('  Fees/Untracked Losses:' + dailyFinance._fmtNum(delta).padStart(32));
        } else {
            console.log('  Untracked Gains:' + dailyFinance._fmtNum(Math.abs(delta)).padStart(38));
        }
        console.log('');

        // ── Net ──
        const net = fin.totalIncome - fin.totalExpenses - delta;
        const sign = net >= 0 ? '+' : '';
        console.log('  NET PROFIT/LOSS:' + (sign + dailyFinance._fmtNum(net)).padStart(38));

        // ── Hourly snapshots summary ──
        if (fin.hourlyChecks && fin.hourlyChecks.length > 0) {
            console.log('');
            console.log('  Hourly snapshots recorded: ' + fin.hourlyChecks.length + '/23');
            const last = fin.hourlyChecks[fin.hourlyChecks.length - 1];
            console.log('  Last snapshot: tick ' + last.tick +
                         ' (' + String(last.hour).padStart(2, '0') + ':' +
                         String(last.minute).padStart(2, '0') + ' PT)');
        }

        console.log('================================================================');
        console.log('');
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
                totalIncome:      0,
                totalExpenses:    0
            };
            // On first init, seed the tx IDs so we don't retroactively count
            // old history. We'll start tracking from the NEXT batch.
            this._seedTransactionIds();
        }
        // Migration: backfill startingBalance for existing installs
        if (Memory.dailyFinance.startingBalance === undefined) {
            Memory.dailyFinance.startingBalance = Math.round(Game.market.credits);
        }
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
    // Returns { hours, minutes, seconds, year, month, day }
    _getPT: function () {
        var now = new Date();
        // Attempt toLocaleString with timezone (works on public Screeps server / modern Node)
        try {
            var ptStr = now.toLocaleString('en-US', {
                timeZone: 'America/Los_Angeles',
                hour12: false
            });
            // Format: "M/D/YYYY, HH:MM:SS"
            var parts = ptStr.split(', ');
            var dateParts = parts[0].split('/');
            var timeParts = parts[1].split(':');
            return {
                year:    parseInt(dateParts[2]),
                month:   parseInt(dateParts[0]),
                day:     parseInt(dateParts[1]),
                hours:   parseInt(timeParts[0]) % 24, // handle "24" edge case
                minutes: parseInt(timeParts[1]),
                seconds: parseInt(timeParts[2])
            };
        } catch (e) {
            // Fallback: manual UTC-8 (PST). Off by 1hr during PDT — acceptable.
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
    _checkMidnightReset: function () {
        var pt = this._getPT();
        var today = this._dateString(pt);

        if (Memory.dailyFinance.dateString !== today) {
            console.log('[DailyFinance] ☀️ New day (' + today + '). Printing final report then resetting.');
            this.report();
            this._notifyReport();

            // Preserve transaction IDs so we don't re-read or skip anything
            var savedOutId = Memory.dailyFinance.lastOutgoingTxId;
            var savedInId  = Memory.dailyFinance.lastIncomingTxId;

            Memory.dailyFinance = {
                dateString:       today,
                lastIncomingTxId: savedInId,
                lastOutgoingTxId: savedOutId,
                startingBalance:  Math.round(Game.market.credits),
                hourlyChecks:     [],
                income:           {},
                expenses:         {},
                totalIncome:      0,
                totalExpenses:    0
            };
        }
    },

    // ── Email notification (compact, ≤500 chars per Game.notify) ───
    _notifyReport: function () {
        var fin = Memory.dailyFinance;
        if (!fin) return;
        var self = this;

        var LIMIT = 490;

        // Header
        var header = 'Finance ' + fin.dateString +
                     ' | Bal:' + this._shortNum(Game.market.credits);

        // Build "res:amt" pairs sorted by value desc
        function buildParts(obj) {
            var keys = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; });
            var parts = [];
            for (var i = 0; i < keys.length; i++) {
                parts.push(keys[i] + ':' + self._shortNum(obj[keys[i]]));
            }
            return parts;
        }

        var inParts  = buildParts(fin.income);
        var outParts = buildParts(fin.expenses);
        var expectedBal = fin.startingBalance + fin.totalIncome - fin.totalExpenses;
        var delta = expectedBal - Math.round(Game.market.credits);
        var net = fin.totalIncome - fin.totalExpenses - delta;
        var feeStr = delta >= 0 ? 'FEES:' + this._shortNum(delta) : 'EXTRA:+' + this._shortNum(Math.abs(delta));
        var netStr = 'NET:' + (net >= 0 ? '+' : '') + this._shortNum(net);

        // Assemble messages, splitting across multiple notifies if needed
        var messages = [];
        var current = header + '\n';

        // Income section
        if (inParts.length > 0) {
            var inLine = 'IN(' + this._shortNum(fin.totalIncome) + '): ';
            for (var i = 0; i < inParts.length; i++) {
                var add = (i > 0 ? ' ' : '') + inParts[i];
                if ((current + inLine + add).length > LIMIT) {
                    messages.push(current + inLine);
                    current = '';
                    inLine = '  ' + inParts[i];
                } else {
                    inLine += add;
                }
            }
            current += inLine + '\n';
        } else {
            current += 'IN: none\n';
        }

        // Expense section
        if (outParts.length > 0) {
            var outLine = 'OUT(' + this._shortNum(fin.totalExpenses) + '): ';
            for (var j = 0; j < outParts.length; j++) {
                var addOut = (j > 0 ? ' ' : '') + outParts[j];
                if ((current + outLine + addOut).length > LIMIT) {
                    messages.push(current + outLine);
                    current = '';
                    outLine = '  ' + outParts[j];
                } else {
                    outLine += addOut;
                }
            }
            current += outLine + '\n';
        } else {
            current += 'OUT: none\n';
        }

        current += feeStr + ' ' + netStr;
        messages.push(current);

        for (var m = 0; m < messages.length; m++) {
            Game.notify(messages[m], 0);
        }
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

        // Keep max 23 measurements (roughly one per hour in a day)
        while (checks.length > 23) {
            checks.shift();
        }
    },

    // ── Transaction processing ──────────────────────────────────────
    _processTransactions: function () {
        var fin = Memory.dailyFinance;

        // --- Outgoing = we sent resources out = SALES (income) ---
        var outgoing = Game.market.outgoingTransactions;
        var newLastOutId = fin.lastOutgoingTxId;
        var outProcessed = 0;

        for (var i = 0; i < outgoing.length; i++) {
            var tx = outgoing[i];
            // Stop at the last-seen boundary (don't include it)
            if (tx.transactionId === fin.lastOutgoingTxId) break;

            if (tx.order && tx.order.price > 0) {
                var resource = tx.resourceType;
                var credits = Math.round(tx.amount * tx.order.price);

                if (!fin.income[resource]) fin.income[resource] = 0;
                fin.income[resource] += credits;
                fin.totalIncome += credits;
                outProcessed++;
            }

            // The newest transaction becomes our new boundary
            if (i === 0) newLastOutId = tx.transactionId;
        }
        fin.lastOutgoingTxId = newLastOutId;

        // --- Incoming = we received resources = PURCHASES (expenses) ---
        var incoming = Game.market.incomingTransactions;
        var newLastInId = fin.lastIncomingTxId;
        var inProcessed = 0;

        for (var j = 0; j < incoming.length; j++) {
            var txIn = incoming[j];
            if (txIn.transactionId === fin.lastIncomingTxId) break;

            if (txIn.order && txIn.order.price > 0) {
                var resIn = txIn.resourceType;
                var creditsIn = Math.round(txIn.amount * txIn.order.price);

                if (!fin.expenses[resIn]) fin.expenses[resIn] = 0;
                fin.expenses[resIn] += creditsIn;
                fin.totalExpenses += creditsIn;
                inProcessed++;
            }

            if (j === 0) newLastInId = txIn.transactionId;
        }
        fin.lastIncomingTxId = newLastInId;

        if (outProcessed + inProcessed > 0) {
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
    }
};

module.exports = dailyFinance;