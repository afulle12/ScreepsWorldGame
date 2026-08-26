// LLM: Read docs/codex.js before reviewing or changing this file.
// inventory.js
// Console globals: invReport
// Example: invReport('summary') - Print inventory summary across all rooms
//   invReport()        -> colony summary: net worth, liq/repl totals, per-resource table, 7-day history
//   invReport('rooms') -> per-room detail (live): liq/repl value, top 3 resources
const memoryManager = require("memoryManager");
const getRoomState = require("getRoomState");
const pricing = require("marketPricing");
const util = require("util");
const VERSION = 1;
const SCAN_INTERVAL = 100;
const HISTORY_DAYS = 30;
const SCANNED_STRUCTURES = [ STRUCTURE_FACTORY, STRUCTURE_LAB, STRUCTURE_POWER_SPAWN ];
function addStore(e, t) {
  if (!t || !t.store) return;
  for (const o in t.store) {
    const r = t.store[o];
    if (r > 0) e[o] = (e[o] || 0) + r;
  }
}

function scanRoom(e, t) {
  addStore(t, e.storage);
  addStore(t, e.terminal);
  const o = getRoomState.get(e.name);
  const r = o && o.structuresByType;
  if (!r) return;
  for (let e = 0; e < SCANNED_STRUCTURES.length; e++) {
    const o = r[SCANNED_STRUCTURES[e]] || [];
    for (let e = 0; e < o.length; e++) {
      if (o[e].my) addStore(t, o[e]);
    }
  }
}

function valueTotals(e) {
  let t = 0;
  let o = 0;
  for (const r in e) {
    t += e[r] * (pricing.passiveBuyPrice(r) || 0);
    o += e[r] * (pricing.liquidationPrice(r) || 0);
  }
  return {
    repl: Math.round(t),
    liq: Math.round(o)
  };
}

function financeDay() {
  return Memory.dailyFinance && Memory.dailyFinance.dateString || util.pacificDateString();
}

function snapshot() {
  const e = {};
  const t = {};
  const o = getRoomState.ownedNames();
  for (let t = 0; t < o.length; t++) {
    const r = Game.rooms[o[t]];
    if (r) scanRoom(r, e);
  }
  for (const o in Game.creeps) {
    addStore(e, Game.creeps[o]);
    addStore(t, Game.creeps[o]);
  }
  const r = {};
  let n = 0;
  const i = Game.market.orders || {};
  for (const e in i) {
    const t = i[e];
    const o = util.getOrderRemaining(t);
    if (!t || !(o > 0)) continue;
    if (t.type === ORDER_SELL) {
      r[t.resourceType] = (r[t.resourceType] || 0) + o;
    } else {
      n += o * t.price;
    }
  }
  const s = valueTotals(e);
  const a = Memory.inventory && Memory.inventory.v === VERSION ? Memory.inventory : null;
  Memory.inventory = {
    v: VERSION,
    tick: Game.time,
    res: e,
    transit: t,
    listed: r,
    buyCommitted: Math.round(n),
    repl: s.repl,
    liq: s.liq,
    openDay: a ? a.openDay : null,
    history: a ? a.history : []
  };
  if (!Memory.inventory.openDay) {
    Memory.inventory.openDay = {
      d: financeDay(),
      res: Object.assign({}, e),
      repl: s.repl,
      liq: s.liq
    };
    memoryManager.requestImmediateSave("inventory.openDay");
  }
  return Memory.inventory;
}

function rollover(e) {
  const t = snapshot();
  const o = t.openDay;
  if (o) {
    t.history.push({
      d: o.d,
      repl: t.repl,
      liq: t.liq,
      dLiq: t.liq - o.liq
    });
    while (t.history.length > HISTORY_DAYS) t.history.shift();
  }
  t.openDay = {
    d: e || financeDay(),
    res: Object.assign({}, t.res),
    repl: t.repl,
    liq: t.liq
  };
  memoryManager.requestImmediateSave("inventory.rollover");
}

function summary() {
  const e = Memory.inventory;
  if (!e || e.v !== VERSION || !e.openDay) return null;
  const t = valueTotals(e.openDay.res).liq;
  const o = e.liq - t;
  const r = t - e.openDay.liq;
  return {
    tick: e.tick,
    repl: e.repl,
    liq: e.liq,
    dLiq: e.liq - e.openDay.liq,
    dLiqQty: o,
    dLiqMark: r,
    dRepl: e.repl - e.openDay.repl,
    buyCommitted: e.buyCommitted,
    netWorth: Math.round(Game.market.credits) + e.liq
  };
}

function shortNum(e) {
  if (e === undefined || e === null) return "0";
  const t = Math.abs(e);
  if (t >= 1e6) return (e / 1e6).toFixed(1) + "M";
  if (t >= 1e3) return (e / 1e3).toFixed(1) + "K";
  return String(Math.round(e));
}

function signedShort(e) {
  return (e >= 0 ? "+" : "") + shortNum(e);
}

function pad(e, t) {
  e = String(e);
  return e.length >= t ? e : e + " ".repeat(t - e.length);
}

function report(e) {
  if (e === "rooms") return reportRooms();
  const t = Memory.inventory;
  if (!t || t.v !== VERSION) {
    console.log("[Inventory] No snapshot yet.");
    return;
  }
  const o = Math.round(Game.market.credits);
  const r = [];
  r.push("============ INVENTORY (snapshot " + (Game.time - t.tick) + " ticks old) ============");
  r.push("Net Worth: " + shortNum(o + t.liq) + "  (credits " + shortNum(o) + " + inventory " + shortNum(t.liq) + " liq.)");
  r.push("Replacement value: " + shortNum(t.repl) + " | Committed to buy orders: " + shortNum(t.buyCommitted));
  if (t.openDay) {
    const e = valueTotals(t.openDay.res).liq;
    const o = t.liq - e;
    const n = e - t.openDay.liq;
    r.push("Today (since " + t.openDay.d + "): liq " + signedShort(t.liq - t.openDay.liq) + " | qty " + signedShort(o) + " | mark " + signedShort(n) + " | repl " + signedShort(t.repl - t.openDay.repl));
  }
  if (t.history.length > 0) {
    const e = t.history.slice(-7).reverse().map(function(e) {
      return e.d.slice(5) + " " + signedShort(e.dLiq);
    });
    r.push("History (liq Δ/day): " + e.join(" | "));
  }
  r.push("");
  r.push(pad("Resource", 18) + pad("Qty", 10) + pad("Transit", 10) + pad("Listed", 10) + pad("Liq/u", 10) + pad("Liq Value", 12) + "Repl Value");
  const n = Object.keys(t.res).sort(function(e, o) {
    return t.res[o] * pricing.liquidationPrice(o) - t.res[e] * pricing.liquidationPrice(e);
  });
  for (let e = 0; e < n.length; e++) {
    const o = n[e];
    const i = pricing.liquidationPrice(o) || 0;
    const s = pricing.passiveBuyPrice(o) || 0;
    r.push(pad(o, 18) + pad(shortNum(t.res[o]), 10) + pad(shortNum(t.transit[o] || 0), 10) + pad(shortNum(t.listed[o] || 0), 10) + pad(i.toFixed(3), 10) + pad(shortNum(t.res[o] * i), 12) + shortNum(t.res[o] * s));
  }
  const i = r.join("\n");
  console.log(i);
  return i;
}

function reportRooms() {
  const e = [ "============ INVENTORY BY ROOM (live) ============" ];
  const t = getRoomState.ownedNames();
  for (let o = 0; o < t.length; o++) {
    const r = Game.rooms[t[o]];
    if (!r) continue;
    const n = {};
    scanRoom(r, n);
    const i = valueTotals(n);
    const s = Object.keys(n).sort(function(e, t) {
      return n[t] * pricing.liquidationPrice(t) - n[e] * pricing.liquidationPrice(e);
    }).slice(0, 3).map(function(e) {
      return e + " " + shortNum(n[e]);
    });
    e.push(pad(r.name, 8) + " liq " + pad(shortNum(i.liq), 8) + " repl " + pad(shortNum(i.repl), 8) + " | " + s.join(", "));
  }
  const o = e.join("\n");
  console.log(o);
  return o;
}

function run() {
  const e = Memory.inventory;
  if (e && e.v === VERSION && typeof e.tick === "number" && e.tick <= Game.time && Game.time - e.tick < SCAN_INTERVAL) return;
  snapshot();
  memoryManager.requestSave();
}

global.invReport = function(e) {
  report(e);
};
module.exports = {
  run: run,
  snapshot: snapshot,
  rollover: rollover,
  summary: summary,
  report: report
};
