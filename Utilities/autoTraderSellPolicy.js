// LLM: Read docs/codex.js before reviewing or changing this file.
// autoTraderSellPolicy.js
var pricing = require("marketPricing");
// below when needed. Resource keys use Screeps resource names, for example H,
const DEFAULT_SELL_PRICE_FLOOR = 0;
const SELL_PRICE_FLOORS = {
  metal: 1200,
  biomass: 1200,
  silicon: 1200,
  mist: 1200
};
function normalizeFloor(r) {
  if (typeof r !== "number" || !isFinite(r) || r <= 0) return 0;
  return Math.max(.001, Math.round(r * 1e3) / 1e3);
}

function getFloor(r) {
  var o = r && Object.prototype.hasOwnProperty.call(SELL_PRICE_FLOORS, r) ? SELL_PRICE_FLOORS[r] : DEFAULT_SELL_PRICE_FLOOR;
  var e = r && pricing && typeof pricing.getDerivedSellFloor === "function" ? pricing.getDerivedSellFloor(r) : 0;
  return normalizeFloor(Math.max(o || 0, e || 0));
}

function applyFloor(r, o) {
  var e = getFloor(r);
  if (!(e > 0) || !(typeof o === "number" && isFinite(o) && o > 0)) return o;
  return Math.max(o, e);
}

function hasConfiguredFloors() {
  if (normalizeFloor(DEFAULT_SELL_PRICE_FLOOR) > 0) return true;
  for (var r in SELL_PRICE_FLOORS) {
    if (normalizeFloor(SELL_PRICE_FLOORS[r]) > 0) return true;
  }
  return !!(pricing && typeof pricing.getDerivedProductOrder === "function" && pricing.getDerivedProductOrder().length > 0);
}

module.exports = {
  getFloor: getFloor,
  applyFloor: applyFloor,
  hasConfiguredFloors: hasConfiguredFloors,
  DEFAULT_SELL_PRICE_FLOOR: DEFAULT_SELL_PRICE_FLOOR,
  SELL_PRICE_FLOORS: SELL_PRICE_FLOORS
};
