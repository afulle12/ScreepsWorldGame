// LLM: Read docs/codex.js before reviewing or changing this file.
// labCommodityPolicy.js
var TWO_LETTER_LAB_PRODUCTS = {
  OH: true,
  ZK: true,
  UL: true,
  UH: true,
  UO: true,
  KH: true,
  KO: true,
  LH: true,
  LO: true,
  ZH: true,
  ZO: true,
  GH: true,
  GO: true
};
var MIN_REACTION_AMOUNT = 5;
function isTwoLetterLabProduct(r) {
  return !!(r && TWO_LETTER_LAB_PRODUCTS[r]);
}

function reactionInputs(r) {
  if (typeof REACTIONS === "undefined" || !REACTIONS) return null;
  for (var t in REACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(REACTIONS, t)) continue;
    var e = REACTIONS[t];
    for (var n in e) {
      if (Object.prototype.hasOwnProperty.call(e, n) && e[n] === r) {
        return [ t, n ];
      }
    }
  }
  return null;
}

function forwardRoutes(r) {
  var t = [];
  if (typeof REACTIONS === "undefined" || !REACTIONS) return t;
  var e = {};
  for (var n in REACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(REACTIONS, n)) continue;
    var o = REACTIONS[n];
    for (var u in o) {
      if (!Object.prototype.hasOwnProperty.call(o, u)) continue;
      if (n !== r && u !== r) continue;
      var a = n === r ? u : n;
      var O = o[u];
      var i = O + "|" + a;
      if (e[i]) continue;
      e[i] = true;
      t.push({
        product: O,
        other: a,
        reagents: [ n, u ]
      });
    }
  }
  return t;
}

function processableAmount(r) {
  return Math.floor(Math.max(0, r || 0) / MIN_REACTION_AMOUNT) * MIN_REACTION_AMOUNT;
}

function remainderAmount(r) {
  return Math.max(0, r || 0) % MIN_REACTION_AMOUNT;
}

function isReactionRemainder(r) {
  return r > 0 && r < MIN_REACTION_AMOUNT;
}

module.exports = {
  TWO_LETTER_LAB_PRODUCTS: TWO_LETTER_LAB_PRODUCTS,
  MIN_REACTION_AMOUNT: MIN_REACTION_AMOUNT,
  isTwoLetterLabProduct: isTwoLetterLabProduct,
  reactionInputs: reactionInputs,
  forwardRoutes: forwardRoutes,
  processableAmount: processableAmount,
  remainderAmount: remainderAmount,
  isReactionRemainder: isReactionRemainder
};
