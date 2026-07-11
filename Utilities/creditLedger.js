/**
 * creditLedger - shared per-tick credit spend tracker.
 *
 * Game.market.credits is a START-OF-TICK snapshot; deal() spends and
 * createOrder/extendOrder/changeOrderPrice fees all settle during end-of-tick
 * intent processing. Any module that checks the raw snapshot can overdraw when
 * other modules spent earlier in the same tick - the server then drops the
 * later intents SILENTLY even though the API call returned OK (observed as
 * marketBuy pending-capture stubs with no live order).
 *
 * Usage: check creditLedger.available() instead of Game.market.credits, and
 * call creditLedger.commit(amount) after every API call that spends credits
 * and returned OK. Earnings (selling into buy orders) are deliberately NOT
 * credited back - income also settles at end of tick and counting it could
 * overdraw if the earning intent fails.
 */

var tick = 0;
var committed = 0;

function roll() {
    if (tick !== Game.time) { tick = Game.time; committed = 0; }
}

module.exports = {
    available: function() {
        roll();
        return Game.market.credits - committed;
    },
    commit: function(amount) {
        roll();
        if (typeof amount === 'number' && amount > 0) committed += amount;
    },
    committedThisTick: function() {
        roll();
        return committed;
    }
};
