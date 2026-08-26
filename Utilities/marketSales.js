// LLM: Read docs/codex.js before reviewing or changing this file.
// marketSales.js
const memoryManager = require("memoryManager");
const VERSION = 1;
const MAX_TRACKED = 30;
function _ensure() {
  if (!Memory.marketSales || Memory.marketSales.v !== VERSION) {
    Memory.marketSales = {
      v: VERSION,
      d: null,
      ours: {}
    };
  }
  return Memory.marketSales;
}

function rollover(e) {
  const n = Memory.dailyFinance;
  const r = _ensure();
  const t = {};
  let o = 0;
  if (n && n.incomeUnits) {
    const e = Object.keys(n.incomeUnits).filter(function(e) {
      return typeof n.incomeUnits[e] === "number" && n.incomeUnits[e] > 0;
    }).sort(function(e, r) {
      return n.incomeUnits[r] - n.incomeUnits[e];
    });
    for (let r = 0; r < e.length && o < MAX_TRACKED; r++) {
      t[e[r]] = Math.floor(n.incomeUnits[e[r]]);
      o++;
    }
  }
  r.d = e;
  r.ours = t;
  memoryManager.requestImmediateSave("marketSales.rollover");
}

function getOurSalesTarget(e) {
  const n = _ensure();
  const r = n.ours[e];
  return typeof r === "number" && r > 0 ? r : null;
}

function getSnapshot() {
  const e = _ensure();
  return {
    v: e.v,
    d: e.d,
    ours: Object.assign({}, e.ours)
  };
}

module.exports = {
  rollover: rollover,
  getOurSalesTarget: getOurSalesTarget,
  getSnapshot: getSnapshot,
  VERSION: VERSION
};
