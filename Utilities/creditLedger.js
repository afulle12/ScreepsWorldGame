// LLM: Read docs/codex.js before reviewing or changing this file.
// creditLedger.js
var tick = 0;
var committed = 0;
function roll() {
  if (tick !== Game.time) {
    tick = Game.time;
    committed = 0;
  }
}

module.exports = {
  available: function() {
    roll();
    return Game.market.credits - committed;
  },
  commit: function(t) {
    roll();
    if (typeof t === "number" && isFinite(t) && t > 0) committed += t;
  },
  committedThisTick: function() {
    roll();
    return committed;
  }
};
