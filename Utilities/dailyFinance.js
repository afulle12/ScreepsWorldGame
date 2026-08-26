// LLM: Read docs/codex.js before reviewing or changing this file.
// dailyFinance.js
// Console globals: financeReport, fR
// Example: financeReport('summary') - Print daily credit, mineral & trade finance report
// Example: fR('summary') - Short alias for financeReport
//   financeReport()                                   -> full detailed report
//   fR() or financeReport('c')                        -> one-line summary
//   fR('vwap')                                        -> recent-trade VWAP report
//   fR('json')                                        -> machine-readable daily-finance data
const INCLUDE_ROOMS_IN_EMAIL = false;
const util = require("util");
const memoryManager = require("memoryManager");
const DAILY_FINANCE_VERSION = 2;
const dailyFinance = {
  beforeMarket: function() {
    this._ensureMemory();
    return this._checkMidnightReset();
  },
  run: function() {
    this._ensureMemory();
    var e = Memory.dailyFinance;
    var t = Game.time;
    var r = e._lastProcessTick;
    if (r === undefined || r === null || t - r >= 100) {
      if (!this._checkMidnightReset()) {
        this._processTransactions();
      }
      Memory.dailyFinance._lastProcessTick = t;
    }
    try {
      require("marketHistory").tick();
    } catch (e) {
      console.log("[DailyFinance] marketHistory tick failed: " + e);
    }
    this._maybeRecordHourlyCheck();
  },
  report: function(e) {
    if (e === "compact" || e === "c") {
      return this._reportCompact();
    }
    if (e === "vwap") {
      return this._reportVwap();
    }
    if (e === "json") {
      return this._reportJson();
    }
    const t = Memory.dailyFinance;
    if (!t) {
      console.log("[DailyFinance] No data yet.");
      return;
    }
    var r = [];
    const n = dailyFinance._getPT();
    const a = dailyFinance._fmt12hr(n.hours, n.minutes) + " PT";
    const i = dailyFinance._ticksUntilMidnight(n);
    r.push("");
    const o = {};
    for (var s in t.income) o[s] = true;
    for (var c in t.expenses) o[c] = true;
    const l = Object.keys(o).sort(function(e, r) {
      var n = (t.income[e] || 0) - (t.expenses[e] || 0);
      var a = (t.income[r] || 0) - (t.expenses[r] || 0);
      return a - n;
    });
    const u = dailyFinance._sourceRows(t);
    var m = Math.round(Game.market.credits);
    var d = t.totalIncome - t.totalExpenses;
    var y = t.totalFees || 0;
    var f = t.startingBalance + d - y;
    var h = m - f;
    const p = m - t.startingBalance;
    const g = p >= 0 ? "+" : "";
    r.push("============= DAILY FINANCE REPORT (" + t.dateString + ") ==============");
    r.push("Time: " + a + " | Est. ticks to midnight: " + i + " (~" + dailyFinance._formatDuration(i * 3) + ")" + " | Balance: " + dailyFinance._fmtNum(m));
    r.push("");
    r.push("--- SUMMARY ---");
    r.push("  Starting Balance:" + dailyFinance._fmtNum(t.startingBalance).padStart(37));
    r.push("  Current Balance: " + dailyFinance._fmtNum(m).padStart(37));
    r.push("  Net Credit Change:" + (g + dailyFinance._fmtNum(p)).padStart(36));
    r.push("");
    r.push("  Income:" + dailyFinance._fmtNum(t.totalIncome).padStart(47));
    r.push("  Expenses:" + dailyFinance._fmtNum(t.totalExpenses).padStart(45));
    r.push("  Tracked Profit:" + dailyFinance._fmtNum(d).padStart(39));
    r.push("  Market Order Fees:" + dailyFinance._fmtNum(y).padStart(35));
    if (h !== 0) {
      r.push("  Unexplained Credit " + (h >= 0 ? "Gain:" : "Loss:") + dailyFinance._fmtNum(Math.abs(h)).padStart(28));
    }
    var v = require("inventory").summary();
    if (v) {
      var F = p + v.dLiqQty;
      r.push("");
      r.push("  Inventory (liq.):" + dailyFinance._fmtNum(v.liq).padStart(37));
      r.push("  Inventory Δ (qty):" + ((v.dLiqQty >= 0 ? "+" : "") + dailyFinance._fmtNum(v.dLiqQty)).padStart(34));
      r.push("  Inventory Δ (mark):" + ((v.dLiqMark >= 0 ? "+" : "") + dailyFinance._fmtNum(v.dLiqMark)).padStart(33));
      r.push("  Open Buy Orders:" + dailyFinance._fmtNum(v.buyCommitted).padStart(39) + " face value (not escrowed)");
      r.push("  Net Worth:" + dailyFinance._fmtNum(m + v.liq).padStart(44));
      r.push("  Economic Profit:" + ((F >= 0 ? "+" : "") + dailyFinance._fmtNum(F)).padStart(38));
    }
    r.push("  Transactions: " + dailyFinance._fmtNum(t.totalSalesTx) + " sales, " + dailyFinance._fmtNum(t.totalPurchasesTx) + " purchases " + "(" + dailyFinance._fmtNum(t.totalSalesTx + t.totalPurchasesTx) + " total)");
    r.push("");
    r.push("--- BY SOURCE ---");
    if (u.length === 0) {
      r.push("  (no transactions yet)");
    } else {
      r.push("  " + "Source".padEnd(22) + "| " + "Income".padStart(11) + " | " + "Expenses".padStart(11) + " | " + "Fees".padStart(11) + " | " + "Net".padStart(11));
      r.push("  " + "-".repeat(78));
      for (let e = 0; e < u.length; e++) {
        const t = u[e];
        const n = t.inc - t.exp - t.fee;
        r.push("  " + t.src.padEnd(22) + "| " + dailyFinance._fmtNum(t.inc).padStart(11) + " | " + dailyFinance._fmtNum(t.exp).padStart(11) + " | " + dailyFinance._fmtNum(t.fee).padStart(11) + " | " + ((n >= 0 ? "+" : "") + dailyFinance._fmtNum(n)).padStart(11));
      }
    }
    r.push("");
    r.push("--- BY RESOURCE ---");
    if (l.length === 0) {
      r.push("  (none)");
    } else {
      r.push("  " + "Resource".padEnd(22) + "| " + "Sold u".padStart(9) + " | " + "Sold".padStart(11) + " | " + "Sell VWAP".padStart(9) + " | " + "Bought u".padStart(9) + " | " + "Bought".padStart(11) + " | " + "Buy VWAP".padStart(9) + " | " + "Net".padStart(11) + " | " + "% In".padStart(6) + " | " + "% Out".padStart(6));
      r.push("  " + "-".repeat(118));
      for (let e = 0; e < l.length; e++) {
        const n = l[e];
        const a = t.income[n] || 0;
        const i = t.expenses[n] || 0;
        const o = a - i;
        const s = t.incomeUnits[n] || 0;
        const c = t.expenseUnits[n] || 0;
        const u = t.totalIncome > 0 ? (a / t.totalIncome * 100).toFixed(1) + "%" : "0.0%";
        const m = t.totalExpenses > 0 ? (i / t.totalExpenses * 100).toFixed(1) + "%" : "0.0%";
        r.push("  " + n.padEnd(22) + "| " + dailyFinance._fmtNum(s).padStart(9) + " | " + dailyFinance._fmtNum(a).padStart(11) + " | " + dailyFinance._fmtPrice(dailyFinance._vwap(a, s)).padStart(9) + " | " + dailyFinance._fmtNum(c).padStart(9) + " | " + dailyFinance._fmtNum(i).padStart(11) + " | " + dailyFinance._fmtPrice(dailyFinance._vwap(i, c)).padStart(9) + " | " + ((o >= 0 ? "+" : "") + dailyFinance._fmtNum(o)).padStart(11) + " | " + u.padStart(6) + " | " + m.padStart(6));
      }
    }
    r.push("  TOTAL INCOME: " + dailyFinance._fmtNum(t.totalIncome) + "   TOTAL EXPENSES: " + dailyFinance._fmtNum(t.totalExpenses) + "   NET: " + (d >= 0 ? "+" : "") + dailyFinance._fmtNum(d));
    r.push("");
    if (e === "rooms") {
      r.push("");
      r.push("--- ROOM TRADING SUMMARY (Counterparty & self-trade rooms) ---");
      r.push("  Legend: Room = room of the order you interacted with");
      r.push("          Sells = credits you received selling TO that room");
      r.push("          Buys  = credits you spent buying FROM that room");
      r.push("          Net   = net credit flow (positive = you earned more)");
      r.push("          (^) = sold there  (v) = bought there  (B) = both");
      const e = t.rooms || {};
      const n = Object.keys(e).sort(function(t, r) {
        return e[r].sells + e[r].buys - (e[t].sells + e[t].buys);
      });
      if (n.length === 0) {
        r.push("  (no trades from counterparty or self-trade rooms today)");
      } else {
        r.push("  " + "Room".padEnd(10) + "| " + "Sells".padStart(13) + " | " + "Buys".padStart(13) + " | " + "Net".padStart(13) + " | " + "Resources");
        r.push("  " + "-".repeat(80));
        for (let t = 0; t < n.length; t++) {
          const a = n[t];
          const i = e[a];
          const o = i.sells - i.buys;
          r.push("  " + a.padEnd(10) + "| " + dailyFinance._fmtNum(i.sells).padStart(13) + " | " + dailyFinance._fmtNum(i.buys).padStart(13) + " | " + (o >= 0 ? "+" : "") + dailyFinance._fmtNum(o).padStart(12) + " | " + dailyFinance._roomResStr(i.resources));
        }
      }
    }
    if (h !== 0 || t.transfers && (t.transfers.incoming || t.transfers.outgoing) || t.txHistoryOverflows && (t.txHistoryOverflows.incoming || t.txHistoryOverflows.outgoing) || t.hourlyChecks && t.hourlyChecks.length > 0) {
      r.push("");
      r.push("--- REPORT HEALTH ---");
      if (h !== 0) {
        r.push("  Reconciliation gap: " + (h >= 0 ? "+" : "") + dailyFinance._fmtNum(h));
      }
      if (t.transfers && (t.transfers.incoming || t.transfers.outgoing)) {
        r.push("  Non-market transfers ignored: " + t.transfers.outgoing + " outgoing, " + t.transfers.incoming + " incoming (no credits)");
      }
      if (t.txHistoryOverflows && (t.txHistoryOverflows.incoming || t.txHistoryOverflows.outgoing)) {
        r.push("  Transaction history overflow: " + t.txHistoryOverflows.outgoing + " outgoing, " + t.txHistoryOverflows.incoming + " incoming cursor losses");
      }
      if (t.hourlyChecks && t.hourlyChecks.length > 0) {
        var S = Math.min(24, n.hours + 1);
        r.push("  Hourly snapshots: " + t.hourlyChecks.length + " recorded / " + S + " expected so far (24 at close)");
        const e = t.hourlyChecks[t.hourlyChecks.length - 1];
        const a = Array.isArray(e) ? e[0] : e.tick;
        const i = Array.isArray(e) ? e[1] : e.hour;
        const o = Array.isArray(e) ? e[2] : e.minute;
        const s = Array.isArray(e) ? e[3] : e.reconciliationGap;
        r.push("  Last snapshot: tick " + a + " (" + dailyFinance._fmt12hr(i, o) + " PT)" + (s === undefined ? "" : ", gap " + (s >= 0 ? "+" : "") + dailyFinance._fmtNum(s)));
      }
    }
    r.push("================================================================");
    r.push("");
    console.log(r.join("\n"));
  },
  _reportCompact: function() {
    var e = Memory.dailyFinance;
    if (!e) {
      console.log("[DailyFinance] No data yet.");
      return;
    }
    var t = this;
    var sn = function(e) {
      return t._shortNum(e);
    };
    var r = this._sourceRows(e);
    var n = Object.keys(e.expenses).sort(function(t, r) {
      return e.expenses[r] - e.expenses[t];
    }).slice(0, 4);
    var a = Math.round(Game.market.credits);
    var i = e.totalFees || 0;
    var o = e.startingBalance + e.totalIncome - e.totalExpenses - i;
    var s = a - o;
    var c = a - e.startingBalance;
    var l = this._getPT();
    var u = this._ticksUntilMidnight(l);
    var m = this._fmt12hr(l.hours, l.minutes) + " PT";
    var d = [];
    d.push("── " + e.dateString + "  " + m + "  ~" + this._formatDuration(u * 3) + " left  Bal: " + sn(a) + " ──");
    d.push("IN: " + sn(e.totalIncome) + "  OUT: " + sn(e.totalExpenses));
    if (r.length > 0) {
      var y = [];
      for (var f = 0; f < Math.min(r.length, 4); f++) {
        var h = r[f].inc - r[f].exp - r[f].fee;
        y.push(r[f].src + " " + (h >= 0 ? "+" : "") + sn(h));
      }
      d.push("Src: " + y.join("  "));
    }
    if (n.length > 0) {
      var p = [];
      for (var g = 0; g < n.length; g++) {
        p.push(n[g] + " " + sn(e.expenses[n[g]]));
      }
      d.push("Top buys: " + p.join("  "));
    }
    d.push("Expenses: " + sn(e.totalExpenses) + "  Fees: " + sn(i) + "  Gap: " + (s >= 0 ? "+" : "") + sn(s) + "  NET: " + (c >= 0 ? "+" : "") + sn(c) + "  Tx: " + e.totalSalesTx + "s/" + e.totalPurchasesTx + "b");
    var v = require("inventory").summary();
    if (v) {
      var F = c + v.dLiqQty;
      d.push("Inv: " + sn(v.liq) + " qty " + (v.dLiqQty >= 0 ? "+" : "") + sn(v.dLiqQty) + " mark " + (v.dLiqMark >= 0 ? "+" : "") + sn(v.dLiqMark) + "  NetWorth: " + sn(a + v.liq) + "  EconNET: " + (F >= 0 ? "+" : "") + sn(F));
    }
    const S = e.rooms || {};
    const _ = Object.keys(S).sort(function(e, t) {
      return S[t].sells + S[t].buys - (S[e].sells + S[e].buys);
    });
    if (_.length > 0) {
      var x = [];
      for (var M = 0; M < _.length; M++) {
        var N = _[M];
        var T = S[N];
        x.push(N + ":S" + sn(T.sells) + "/B" + sn(T.buys) + " [" + dailyFinance._roomResStr(T.resources) + "]");
      }
      d.push("Rooms: " + x.join("  "));
    }
    console.log(d.join("\n"));
  },
  _ensureMemory: function() {
    if (!Memory.dailyFinance) {
      const e = this._getPT();
      Memory.dailyFinance = {
        v: DAILY_FINANCE_VERSION,
        dateString: this._dateString(e),
        lastIncomingTxId: null,
        lastOutgoingTxId: null,
        startingBalance: Math.round(Game.market.credits),
        hourlyChecks: [],
        income: {},
        expenses: {},
        incomeUnits: {},
        expenseUnits: {},
        totalIncome: 0,
        totalExpenses: 0,
        totalSalesTx: 0,
        totalPurchasesTx: 0,
        rooms: {},
        bySource: {},
        totalFees: 0,
        feesBySource: {},
        transfers: {
          incoming: 0,
          outgoing: 0
        },
        txHistoryOverflows: {
          incoming: 0,
          outgoing: 0
        },
        lastHourlyKey: null,
        lastProcessLog: 0
      };
      this._seedTransactionIds();
    }
    this._migrateMemory(Memory.dailyFinance);
    if (Memory.dailyFinance.startingBalance === undefined) {
      Memory.dailyFinance.startingBalance = Math.round(Game.market.credits);
    }
    if (Memory.dailyFinance.totalSalesTx === undefined) {
      Memory.dailyFinance.totalSalesTx = 0;
    }
    if (Memory.dailyFinance.totalPurchasesTx === undefined) {
      Memory.dailyFinance.totalPurchasesTx = 0;
    }
    if (!Memory.dailyFinance.rooms) {
      Memory.dailyFinance.rooms = {};
    }
    var e = Memory.dailyFinance.rooms;
    for (var t in e) {
      if (!e[t].resources) e[t].resources = {};
    }
    delete Memory.dailyFinance.buyers;
    delete Memory.dailyFinance.suppliers;
    delete Memory.dailyFinance.legacyCleanupDone;
    if (!Memory.dailyFinance.incomeUnits) Memory.dailyFinance.incomeUnits = {};
    if (!Memory.dailyFinance.expenseUnits) Memory.dailyFinance.expenseUnits = {};
    if (Memory.dailyFinance.lastHourlyKey === undefined) Memory.dailyFinance.lastHourlyKey = null;
    if (Memory.dailyFinance.lastProcessLog === undefined) Memory.dailyFinance.lastProcessLog = 0;
    if (Memory.dailyFinance._lastProcessTick === undefined) Memory.dailyFinance._lastProcessTick = null;
    if (!Memory.dailyFinance.bySource) Memory.dailyFinance.bySource = {};
    if (Memory.dailyFinance.totalFees === undefined) Memory.dailyFinance.totalFees = 0;
    if (!Memory.dailyFinance.feesBySource) Memory.dailyFinance.feesBySource = {};
    if (!Memory.dailyFinance.transfers) Memory.dailyFinance.transfers = {
      incoming: 0,
      outgoing: 0
    };
    if (!Memory.dailyFinance.txHistoryOverflows) {
      Memory.dailyFinance.txHistoryOverflows = {
        incoming: 0,
        outgoing: 0
      };
    }
  },
  _migrateMemory: function(e) {
    if (!e || e.v >= DAILY_FINANCE_VERSION) return;
    var t = e.rooms || {};
    for (var r in t) {
      var n = t[r] && t[r].resources;
      if (!n) continue;
      for (var a in n) {
        var i = n[a];
        if (typeof i === "number") continue;
        n[a] = (i && i.sells > 0 ? 1 : 0) | (i && i.buys > 0 ? 2 : 0);
      }
    }
    var o = Array.isArray(e.hourlyChecks) ? e.hourlyChecks : [];
    for (var s = 0; s < o.length; s++) {
      var c = o[s];
      if (c && !Array.isArray(c)) {
        o[s] = [ c.tick, c.hour, c.minute, c.reconciliationGap ];
      }
    }
    e.hourlyChecks = o;
    delete e.nullOrderTx;
    delete e.legacyCleanupDone;
    e.v = DAILY_FINANCE_VERSION;
  },
  _seedTransactionIds: function() {
    const e = Game.market.outgoingTransactions;
    if (e && e.length > 0) {
      Memory.dailyFinance.lastOutgoingTxId = e[0].transactionId;
    }
    const t = Game.market.incomingTransactions;
    if (t && t.length > 0) {
      Memory.dailyFinance.lastIncomingTxId = t[0].transactionId;
    }
  },
  _getPT: function() {
    return require("util").getPacificTime();
  },
  _dateString: function(e) {
    if (e) {
      return e.year + "-" + String(e.month).padStart(2, "0") + "-" + String(e.day).padStart(2, "0");
    }
    return require("util").pacificDateString();
  },
  _ticksUntilMidnight: function(e) {
    var t = (23 - e.hours) * 3600 + (59 - e.minutes) * 60 + (60 - e.seconds);
    return Math.ceil(t / 3);
  },
  _checkMidnightReset: function() {
    var e = this._getPT();
    var t = this._dateString(e);
    if (Memory.dailyFinance.dateString !== t) {
      this._processTransactions();
      try {
        require("marketHistory").archiveDay(Memory.dailyFinance);
      } catch (e) {
        console.log("[DailyFinance] marketHistory archive failed: " + e);
        return false;
      }
      console.log("[DailyFinance] ☀️ New day (" + t + "). Printing final report then resetting.");
      this.report();
      this._notifyReport();
      try {
        require("inventory").rollover(t);
      } catch (e) {
        console.log("[DailyFinance] inventory rollover failed: " + e);
      }
      try {
        require("marketSales").rollover(t);
      } catch (e) {
        console.log("[DailyFinance] marketSales rollover failed: " + e);
      }
      Memory.dailyFinance = {
        v: DAILY_FINANCE_VERSION,
        dateString: t,
        lastIncomingTxId: null,
        lastOutgoingTxId: null,
        startingBalance: Math.round(Game.market.credits),
        hourlyChecks: [],
        income: {},
        expenses: {},
        incomeUnits: {},
        expenseUnits: {},
        totalIncome: 0,
        totalExpenses: 0,
        totalSalesTx: 0,
        totalPurchasesTx: 0,
        rooms: {},
        bySource: {},
        totalFees: 0,
        feesBySource: {},
        transfers: {
          incoming: 0,
          outgoing: 0
        },
        txHistoryOverflows: {
          incoming: 0,
          outgoing: 0
        },
        lastHourlyKey: null,
        lastProcessLog: 0
      };
      this._seedTransactionIds();
      if (!Memory.stats) Memory.stats = {};
      Memory.stats.kills = 0;
      memoryManager.requestImmediateSave("dailyFinance.rollover");
      return true;
    }
    return false;
  },
  _notifyReport: function() {
    var e = Memory.dailyFinance;
    if (!e) return;
    var t = this;
    var r = 400;
    var n = [];
    var sn = function(e) {
      return t._shortNum(e);
    };
    var a = Object.keys(e.income).sort(function(t, r) {
      return e.income[r] - e.income[t];
    });
    var i = this._sourceRows(e);
    var o = e.totalFees || 0;
    var s = e.startingBalance + e.totalIncome - e.totalExpenses - o;
    var c = Math.round(Game.market.credits) - s;
    var l = Math.round(Game.market.credits) - e.startingBalance;
    var u = "Finance " + e.dateString + " Bal:" + sn(Game.market.credits) + "\n" + "IN:" + sn(e.totalIncome) + " OUT:" + sn(e.totalExpenses) + " Fees:" + sn(o) + " Gap:" + (c >= 0 ? "+" : "") + sn(c) + " NET:" + (l >= 0 ? "+" : "") + sn(l) + "\n" + "Tx:" + e.totalSalesTx + "sales/" + e.totalPurchasesTx + "buys";
    n.push(u);
    if (i.length > 0) {
      var m = "SRC:\n";
      for (var d = 0; d < i.length; d++) {
        var y = i[d].inc - i[d].exp - i[d].fee;
        var f = i[d].src + " In:" + sn(i[d].inc) + " Out:" + sn(i[d].exp) + " Fee:" + sn(i[d].fee) + " Net:" + (y >= 0 ? "+" : "") + sn(y) + "\n";
        if ((m + f).length > r) {
          n.push(m);
          m = "";
        }
        m += f;
      }
      if (m.length > 0) n.push(m);
    }
    var h = "INCOME:\n";
    for (var p = 0; p < a.length; p++) {
      var g = a[p];
      var v = e.income[g];
      var F = e.expenses[g] || 0;
      var S = g + " Sold:" + sn(v) + " Bought:" + sn(F) + " Net:" + sn(v - F) + "\n";
      if ((h + S).length > r) {
        n.push(h);
        h = "";
      }
      h += S;
    }
    if (h.length > 0) n.push(h);
    if (INCLUDE_ROOMS_IN_EMAIL) {
      var _ = e.rooms || {};
      var x = Object.keys(_).sort(function(e, t) {
        return _[t].sells + _[t].buys - (_[e].sells + _[e].buys);
      });
      if (x.length > 0) {
        var M = "ROOMS:\n";
        for (var N = 0; N < x.length; N++) {
          var T = x[N];
          var I = _[T];
          var k = I.sells - I.buys;
          var E = dailyFinance._roomResStr(I.resources);
          var O = T + " S:" + sn(I.sells) + " B:" + sn(I.buys) + " N:" + (k >= 0 ? "+" : "") + sn(k) + " [" + E + "]\n";
          if ((M + O).length > r) {
            n.push(M);
            M = "";
          }
          M += O;
        }
        if (M.length > 0) n.push(M);
      }
    }
    var b = n.length;
    for (var P = 0; P < b; P++) {
      Game.notify("[" + (P + 1) + "/" + b + "] " + n[P], P * 10);
    }
  },
  _roomResStr: function(e) {
    if (!e) return "";
    var t = Object.keys(e);
    if (t.length === 0) return "";
    var r = [];
    for (var n = 0; n < t.length; n++) {
      var a = t[n];
      var i = e[a];
      var o = typeof i === "number" ? i & 1 : i && i.sells > 0;
      var s = typeof i === "number" ? i & 2 : i && i.buys > 0;
      var c = o && s ? "(B)" : o ? "(^)" : "(v)";
      r.push(a + c);
    }
    return r.join(" ");
  },
  _shortNum: function(e) {
    if (e === undefined || e === null) return "0";
    var t = Math.abs(Math.round(e));
    var r = e < 0 ? "-" : "";
    if (t >= 1e6) return r + (t / 1e6).toFixed(2) + "M";
    if (t >= 1e3) return r + (t / 1e3).toFixed(1) + "K";
    return r + String(t);
  },
  _recordHourlyCheck: function() {
    var e = this._getPT();
    var t = Memory.dailyFinance.hourlyChecks;
    var r = Memory.dailyFinance;
    var n = Math.round(Game.market.credits);
    var a = r.startingBalance + r.totalIncome - r.totalExpenses - (r.totalFees || 0);
    t.push([ Game.time, e.hours, e.minutes, n - a ]);
    while (t.length > 24) {
      t.shift();
    }
  },
  _maybeRecordHourlyCheck: function() {
    var e = this._getPT();
    var t = this._dateString(e) + " " + e.hours;
    if (Memory.dailyFinance.lastHourlyKey === t) return;
    Memory.dailyFinance.lastHourlyKey = t;
    this._recordHourlyCheck();
  },
  //  TRANSACTION PROCESSING
  _sourceRows: function(e) {
    var t = e.bySource || {};
    var r = e.feesBySource || {};
    var n = [];
    var a = 0, i = 0;
    var o = {};
    for (var s in t) o[s] = true;
    for (var c in r) o[c] = true;
    for (var l in o) {
      var u = t[l] || {
        inc: 0,
        exp: 0
      };
      n.push({
        src: l,
        inc: u.inc || 0,
        exp: u.exp || 0,
        fee: r[l] || 0
      });
      a += u.inc || 0;
      i += u.exp || 0;
    }
    var m = e.totalIncome - a;
    var d = e.totalExpenses - i;
    if (m > .5 || d > .5) {
      n.push({
        src: "(unattributed/legacy)",
        inc: Math.max(m, 0),
        exp: Math.max(d, 0),
        fee: 0
      });
    }
    n.sort(function(e, t) {
      return t.inc - t.exp - t.fee - (e.inc - e.exp - e.fee);
    });
    return n;
  },
  recordFee: function(e, t) {
    this._ensureMemory();
    var r = Memory.dailyFinance;
    if (!r || !(t > 0) || !isFinite(t)) return;
    if (r.totalFees === undefined) r.totalFees = 0;
    if (!r.feesBySource) r.feesBySource = {};
    r.totalFees += t;
    r.feesBySource[e || "untagged"] = (r.feesBySource[e || "untagged"] || 0) + t;
    memoryManager.requestImmediateSave("dailyFinance.recordFee");
  },
  _addSource: function(e, t, r, n, a) {
    var i = require("marketAttribution").attribute(t, a, r === "inc" ? "sell" : "buy");
    if (!e.bySource) e.bySource = {};
    if (!e.bySource[i]) e.bySource[i] = {
      inc: 0,
      exp: 0
    };
    e.bySource[i][r] += n;
  },
  _isAdjustmentSelfTrade: function(e) {
    return require("marketPriceAdjustment").isSelfTradeTransaction(e);
  },
  _processTransactions: function() {
    var e = Memory.dailyFinance;
    var t = require("economics");
    if (!e.transfers) e.transfers = {
      incoming: 0,
      outgoing: 0
    };
    if (!e.txHistoryOverflows) e.txHistoryOverflows = {
      incoming: 0,
      outgoing: 0
    };
    if (!e.bySource) e.bySource = {};
    if (e.totalFees === undefined) e.totalFees = 0;
    if (!e.feesBySource) e.feesBySource = {};
    var r = Game.market.orders || {};
    var n = {};
    for (var a in r) {
      n[a] = true;
    }
    var i = Game.market.outgoingTransactions || [];
    var o = e.lastOutgoingTxId;
    var s = 0;
    var c = !e.lastOutgoingTxId;
    for (var l = 0; l < i.length; l++) {
      var u = i[l];
      if (u.transactionId === e.lastOutgoingTxId) {
        c = true;
        break;
      }
      if (l === 0) o = u.transactionId;
      if (this._isAdjustmentSelfTrade(u)) {
        var m = u.from && u.to ? util.calcTransactionCost(u.amount, u.from, u.to) : 0;
        if (m > 0) {
          t.record("marketPriceAdjustment", u.to || u.from, u.resourceType, {
            energy: t.value(RESOURCE_ENERGY, m)
          });
        }
        continue;
      }
      if (!u.order || u.order.price <= 0) {
        e.transfers.outgoing++;
        continue;
      }
      var d = u.resourceType;
      var y = u.amount * u.order.price;
      if (!e.income[d]) e.income[d] = 0;
      e.income[d] += y;
      if (!e.incomeUnits[d]) e.incomeUnits[d] = 0;
      e.incomeUnits[d] += u.amount;
      e.totalIncome += y;
      e.totalSalesTx++;
      this._addSource(e, u.order.id, "inc", y, d);
      var f = u.from && u.to ? util.calcTransactionCost(u.amount, u.from, u.to) : 0;
      t.recordMarket("sale", u.from, d, u.amount, y, f);
      if (u.to && (!n[u.order.id] || u.order.type === "buy")) {
        var h = u.to;
        if (!e.rooms[h]) e.rooms[h] = {
          sells: 0,
          buys: 0,
          resources: {}
        };
        if (!e.rooms[h].resources) e.rooms[h].resources = {};
        e.rooms[h].sells += y;
        if (!e.rooms[h].resources[d]) e.rooms[h].resources[d] = 0;
        e.rooms[h].resources[d] |= 1;
      }
      s++;
    }
    e.lastOutgoingTxId = o;
    if (!c && i.length >= 100) e.txHistoryOverflows.outgoing++;
    var p = Game.market.incomingTransactions || [];
    var g = e.lastIncomingTxId;
    var v = 0;
    var F = !e.lastIncomingTxId;
    for (var S = 0; S < p.length; S++) {
      var _ = p[S];
      if (_.transactionId === e.lastIncomingTxId) {
        F = true;
        break;
      }
      if (S === 0) g = _.transactionId;
      if (this._isAdjustmentSelfTrade(_)) continue;
      if (!_.order || _.order.price <= 0) {
        e.transfers.incoming++;
        continue;
      }
      var x = _.resourceType;
      var M = _.amount * _.order.price;
      if (!e.expenses[x]) e.expenses[x] = 0;
      e.expenses[x] += M;
      if (!e.expenseUnits[x]) e.expenseUnits[x] = 0;
      e.expenseUnits[x] += _.amount;
      e.totalExpenses += M;
      e.totalPurchasesTx++;
      this._addSource(e, _.order.id, "exp", M, x);
      var N = _.from && _.to ? util.calcTransactionCost(_.amount, _.from, _.to) : 0;
      t.recordMarket("purchase", _.to, x, _.amount, M, N);
      if (_.from && (!n[_.order.id] || _.order.type === "sell")) {
        var T = _.from;
        if (!e.rooms[T]) e.rooms[T] = {
          sells: 0,
          buys: 0,
          resources: {}
        };
        if (!e.rooms[T].resources) e.rooms[T].resources = {};
        e.rooms[T].buys += M;
        if (!e.rooms[T].resources[x]) e.rooms[T].resources[x] = 0;
        e.rooms[T].resources[x] |= 2;
      }
      v++;
    }
    e.lastIncomingTxId = g;
    if (!F && p.length >= 100) e.txHistoryOverflows.incoming++;
    if (s + v > 0 && (!e.lastProcessLog || Game.time - e.lastProcessLog >= 1e3)) {
      e.lastProcessLog = Game.time;
      console.log("[DailyFinance] Processed " + s + " sales, " + v + " purchases. Running totals — Income: " + this._fmtNum(e.totalIncome) + " | Expenses: " + this._fmtNum(e.totalExpenses));
    }
    memoryManager.requestImmediateSave("dailyFinance.transactions");
  },
  _fmtNum: function(e) {
    if (e === undefined || e === null) return "0";
    var t = e < 0;
    var r = Math.abs(Math.round(e));
    var n = String(r);
    var a = "";
    for (var i = n.length - 1, o = 0; i >= 0; i--, o++) {
      if (o > 0 && o % 3 === 0) a = "," + a;
      a = n[i] + a;
    }
    return t ? "-" + a : a;
  },
  _formatDuration: function(e) {
    var t = Math.floor(e / 3600);
    var r = Math.floor(e % 3600 / 60);
    if (t > 0) {
      return t + "h " + r + "m";
    }
    return r + "m";
  },
  _fmt12hr: function(e, t) {
    var r = e >= 12 ? "PM" : "AM";
    var n = e % 12;
    if (n === 0) n = 12;
    return n + ":" + String(t).padStart(2, "0") + " " + r;
  },
  _vwap: function(e, t) {
    if (!t || t <= 0) return null;
    return e / t;
  },
  _fmtPrice: function(e) {
    if (e === null || e === undefined) return "N/A";
    if (e >= 1) return e.toFixed(3);
    if (e >= .01) return e.toFixed(4);
    return e.toFixed(6);
  },
  _reportVwap: function() {
    var e = Memory.dailyFinance;
    if (!e) {
      console.log("[DailyFinance] No data yet.");
      return;
    }
    var t = [];
    t.push("");
    t.push("============= DAILY VWAP REPORT (" + e.dateString + ") ==============");
    t.push("");
    var r = {};
    for (var n in e.income) r[n] = true;
    for (var n in e.expenses) r[n] = true;
    var a = Object.keys(r);
    if (a.length === 0) {
      t.push("  (no data)");
    } else {
      t.push("  " + "Resource".padEnd(18) + "| " + "Sold Units".padStart(10) + " | " + "Sell VWAP".padStart(10) + " | " + "Bought Units".padStart(12) + " | " + "Buy VWAP".padStart(10) + " | " + "Spread");
      t.push("  " + "-".repeat(83));
      for (var i = 0; i < a.length; i++) {
        var n = a[i];
        var o = e.income[n] || 0;
        var s = e.incomeUnits[n] || 0;
        var c = e.expenses[n] || 0;
        var l = e.expenseUnits[n] || 0;
        var u = s > 0 ? o / s : null;
        var m = l > 0 ? c / l : null;
        var d = u !== null && m !== null ? u - m : null;
        t.push("  " + n.padEnd(18) + "| " + this._fmtNum(s).padStart(10) + " | " + (u !== null ? this._fmtPrice(u) : "N/A").padStart(10) + " | " + this._fmtNum(l).padStart(12) + " | " + (m !== null ? this._fmtPrice(m) : "N/A").padStart(10) + " | " + (d !== null ? this._fmtPrice(d) : "N/A"));
      }
    }
    t.push("================================================================");
    t.push("");
    console.log(t.join("\n"));
  },
  _reportJson: function() {
    var e = Memory.dailyFinance;
    if (!e) {
      console.log("[DailyFinance] No data yet.");
      return;
    }
    console.log(JSON.stringify(e, null, 2));
  }
};
global.fR = function(e) {
  dailyFinance.report(e || "compact");
};
global.financeReport = function(e) {
  dailyFinance.report(e);
};
module.exports = dailyFinance;
