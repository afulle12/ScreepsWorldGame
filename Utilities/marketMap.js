// LLM: Read docs/codex.js before reviewing or changing this file.
// marketMap.js
// Console globals: marketMap
// Example: marketMap(RESOURCE_ENERGY) - Map market order distribution and prices by sector
const util = require("util");
const ACCOUNT_RESOURCES = new Set([ SUBSCRIPTION_TOKEN, CPU_UNLOCK, PIXEL, ACCESS_KEY ].filter(Boolean));
function formatInt(t) {
  t = Math.floor(t);
  const e = t < 0;
  const o = Math.abs(t).toString();
  const s = [];
  for (let t = o.length; t > 0; t -= 3) {
    s.unshift(o.slice(Math.max(0, t - 3), t));
  }
  return (e ? "-" : "") + s.join(",");
}

function fmtNet(t) {
  return (t >= 0 ? "+" : "") + formatInt(t);
}

function padL(t, e) {
  const o = String(t);
  return " ".repeat(Math.max(0, e - o.length)) + o;
}

function padR(t, e) {
  const o = String(t);
  return o + " ".repeat(Math.max(0, e - o.length));
}

function marketMap() {
  const t = util.marketSnapshot(0).all;
  const e = {};
  let o = 0;
  for (const s of t) {
    if (s.active === false) {
      o++;
      continue;
    }
    if (ACCOUNT_RESOURCES.has(s.resourceType)) continue;
    if (!s.roomName) continue;
    if (!e[s.roomName]) {
      e[s.roomName] = {
        sells: 0,
        buys: 0,
        sellRes: {},
        buyRes: {}
      };
    }
    const t = e[s.roomName];
    const n = s.price * util.getOrderRemaining(s);
    if (s.type === ORDER_SELL) {
      t.sells += n;
      t.sellRes[s.resourceType] = (t.sellRes[s.resourceType] || 0) + n;
    } else {
      t.buys += n;
      t.buyRes[s.resourceType] = (t.buyRes[s.resourceType] || 0) + n;
    }
  }
  const s = [];
  for (const t in e) {
    const o = e[t];
    const n = o.sells + o.buys;
    if (n === 0) continue;
    const r = o.sells - o.buys;
    const a = new Set([ ...Object.keys(o.sellRes), ...Object.keys(o.buyRes) ]);
    const l = [ ...a ].sort().map(t => {
      const e = o.sellRes[t] > 0;
      const s = o.buyRes[t] > 0;
      if (e && s) return `${t}(B)`;
      if (e) return `${t}(^)`;
      return `${t}(v)`;
    }).join(" ");
    s.push({
      room: t,
      sells: o.sells,
      buys: o.buys,
      net: r,
      total: n,
      resources: l
    });
  }
  s.sort((t, e) => e.total - t.total);
  const n = Math.max(4, ...s.map(t => t.room.length), 4);
  const r = Math.max(5, ...s.map(t => formatInt(t.sells).length), 5);
  const a = Math.max(4, ...s.map(t => formatInt(t.buys).length), 4);
  const l = Math.max(3, ...s.map(t => fmtNet(t.net).length), 3);
  const c = [];
  const u = `${padR("Room", n)} | ${padL("Sells", r)} | ${padL("Buys", a)} | ${padL("Net", l)} | Resources`;
  c.push(u);
  c.push("-".repeat(u.length));
  for (const t of s) {
    const e = `${padR(t.room, n)} | ${padL(formatInt(t.sells), r)} | ${padL(formatInt(t.buys), a)} | ${padL(fmtNet(t.net), l)} | ${t.resources}`;
    c.push(e);
  }
  console.log(c.join("\n"));
  if (s.length === 0) {
    console.log(`[marketMap] No rooms mapped. Total orders scanned: ${t.length}. Skipped inactive: ${o}`);
  }
  return `${s.length} rooms mapped`;
}

global.marketMap = marketMap;
module.exports = marketMap;
