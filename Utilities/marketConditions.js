// LLM: Read docs/codex.js before reviewing or changing this file.
// marketConditions.js
// Console globals: marketVolume
// Example: marketVolume(RESOURCE_ENERGY) - Display 24h/7d trading volume and price momentum
//   marketVolume(days?)  - Daily non-energy, non-account market volume/value.
//   marketVolume()       - Last 7 days.
//   marketVolume(14)     - Last 14 days (the market-history API maximum).
//   marketVolume(7, true) - Include every non-account resource in the ranking.
(function registerMarketConditionsGlobals() {
  const e = require("marketPricing");
  // Constant values, not names: RESOURCE_CPU_UNLOCK is "cpuUnlock" and
  // RESOURCE_ACCESS_KEY is "accessKey". The snake_case spellings matched
  // nothing, so account goods were never actually excluded.
  const t = {
    power: true,
    ops: true,
    pixel: true,
    cpuUnlock: true,
    accessKey: true,
    token: true
  };
  const o = 14;
  const r = 30;
  const u = 50;
  function formatNumber(e) {
    if (typeof e !== "number" || !isFinite(e)) return "n/a";
    if (e >= 1e9) return (e / 1e9).toFixed(2) + "B";
    if (e >= 1e6) return (e / 1e6).toFixed(2) + "M";
    if (e >= 1e3) return (e / 1e3).toFixed(1) + "K";
    return e.toFixed(0);
  }
  function formatPrice(e) {
    return typeof e === "number" && isFinite(e) ? e.toFixed(3) : "n/a";
  }
  function formatChange(e) {
    if (e === null) return "new";
    return (e >= 0 ? "+" : "") + e.toFixed(1) + "%";
  }
  function padLeft(e, t) {
    e = String(e);
    while (e.length < t) e = " " + e;
    return e;
  }
  function marketResources(e) {
    if (typeof RESOURCES_ALL === "undefined") return [];
    return RESOURCES_ALL.filter(function(o) {
      return (e || o !== RESOURCE_ENERGY) && !t[o];
    });
  }
  function currentUtcDate() {
    return (new Date).toISOString().slice(0, 10);
  }
  function collectDailyTotals(t) {
    const o = {};
    const r = marketResources();
    const u = currentUtcDate();
    for (let t = 0; t < r.length; t++) {
      const n = e.getHistDays(r[t]) || [];
      for (let e = 0; e < n.length; e++) {
        const t = n[e];
        if (!t || typeof t.date !== "string" || typeof t.volume !== "number" || typeof t.avgPrice !== "number" || t.volume < 0 || t.avgPrice < 0 || t.date === u) continue;
        if (!o[t.date]) {
          o[t.date] = {
            date: t.date,
            volume: 0,
            value: 0
          };
        }
        o[t.date].volume += t.volume;
        o[t.date].value += t.volume * t.avgPrice;
      }
    }
    return Object.keys(o).sort().slice(-t).map(function(e) {
      const t = o[e];
      t.averageValuePerUnit = t.volume > 0 ? t.value / t.volume : null;
      return t;
    });
  }
  function collectCommodityTotals(t, o) {
    const r = {};
    const n = {};
    const a = marketResources(true);
    const l = t[0].date;
    const i = t[t.length - 1].date;
    for (let e = 0; e < t.length; e++) r[t[e].date] = true;
    for (let t = 0; t < a.length; t++) {
      const o = a[t];
      const u = e.getHistDays(o) || [];
      for (let e = 0; e < u.length; e++) {
        const t = u[e];
        if (!t || !r[t.date] || typeof t.volume !== "number" || typeof t.avgPrice !== "number" || t.volume < 0 || t.avgPrice < 0) continue;
        if (!n[o]) {
          n[o] = {
            resource: o,
            volume: 0,
            value: 0,
            firstDayVolume: 0,
            lastDayVolume: 0
          };
        }
        const a = n[o];
        a.volume += t.volume;
        a.value += t.volume * t.avgPrice;
        if (t.date === l) a.firstDayVolume = t.volume;
        if (t.date === i) a.lastDayVolume = t.volume;
      }
    }
    return Object.keys(n).map(function(e) {
      const t = n[e];
      t.averageValuePerUnit = t.volume > 0 ? t.value / t.volume : null;
      t.volumeChange = t.firstDayVolume > 0 ? (t.lastDayVolume - t.firstDayVolume) / t.firstDayVolume * 100 : t.lastDayVolume > 0 ? null : 0;
      return t;
    }).filter(function(e) {
      return e.volume > 0;
    }).sort(function(e, t) {
      return t.value - e.value || e.resource.localeCompare(t.resource);
    }).slice(0, o ? undefined : u);
  }
  global.marketVolume = function(e, t) {
    if (e === undefined) e = 7;
    if (typeof e !== "number" || !isFinite(e) || Math.floor(e) !== e || e < 1 || e > o) {
      return "Usage: marketVolume(days) where days is an integer from 1 to " + o + ".";
    }
    if (!Game.market || typeof Game.market.getHistory !== "function") {
      return "[Market] Market history is unavailable.";
    }
    const n = collectDailyTotals(e);
    if (!n.length) {
      return "[Market] No non-energy, non-account market history is available.";
    }
    let a = 0;
    let l = 0;
    let i = 0;
    for (let e = 0; e < n.length; e++) {
      a += n[e].volume;
      l += n[e].value;
      if (n[e].volume > i) i = n[e].volume;
    }
    const s = collectCommodityTotals(n, t === true);
    const c = [ "=== Market Volume: Last " + n.length + " Days ===", "Excludes energy and account resources (power, ops, pixel, cpu_unlock, access_key, token).", "Total volume: " + formatNumber(a) + " units", "Total value: " + formatNumber(l) + " credits", "Avg value/unit: " + formatPrice(a > 0 ? l / a : null) + " credits", "", "Daily volume" ];
    for (let e = 0; e < n.length; e++) {
      const t = n[e];
      const o = i > 0 ? Math.round(t.volume / i * r) : 0;
      c.push(t.date + " | " + Array(o + 1).join("#") + Array(r - o + 1).join(" ") + " " + formatNumber(t.volume));
    }
    c.push("");
    c.push("Date       Volume   Avg value/unit   Total value");
    for (let e = 0; e < n.length; e++) {
      const t = n[e];
      c.push(t.date + " " + padLeft(formatNumber(t.volume), 8) + " " + padLeft(formatPrice(t.averageValuePerUnit), 16) + " " + padLeft(formatNumber(t.value), 13));
    }
    c.push("");
    c.push((t === true ? "All" : "Top " + u) + " commodities by total value (includes energy)");
    c.push("Change compares the most recent full-day volume with the first full day.");
    c.push("Commodity          Volume     Change   Avg value/unit   Total value");
    for (let e = 0; e < s.length; e++) {
      const t = s[e];
      c.push((t.resource + Array(19).join(" ")).slice(0, 18) + " " + padLeft(formatNumber(t.volume), 8) + " " + padLeft(formatChange(t.volumeChange), 10) + " " + padLeft(formatPrice(t.averageValuePerUnit), 16) + " " + padLeft(formatNumber(t.value), 13));
    }
    return c.join("\n");
  };
})();
