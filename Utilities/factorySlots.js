// LLM: Read docs/codex.js before reviewing or changing this file.
// factorySlots.js
var MAX_OPS_PER_ROOM = 3;
function isLiveOp(e) {
  return !!(e && e.phase !== "done" && e.phase !== "failed" && e.phase !== "error" && e.phase !== "cancelled");
}

function getRefineOperations() {
  var e = require("marketRefine");
  var r = require("localRefine");
  return {
    market: e && typeof e.getOperations === "function" ? e.getOperations() : [],
    local: r && typeof r.getOperations === "function" ? r.getOperations() : []
  };
}

function linkedFactoryOrderIds() {
  var e = {};
  var r = getRefineOperations();
  var a = [ r.market, r.local ];
  for (var t = 0; t < a.length; t++) {
    var n = a[t];
    for (var o = 0; o < n.length; o++) {
      if (n[o] && n[o].factoryOrderId) e[n[o].factoryOrderId] = true;
    }
  }
  return e;
}

function countRoom(e) {
  var r = 0;
  var a = getRefineOperations();
  var t = [ a.market, a.local ];
  for (var n = 0; n < t.length; n++) {
    var o = t[n];
    for (var i = 0; i < o.length; i++) {
      var l = o[i];
      if (l && l.room === e && isLiveOp(l) && l.phase !== "selling") r++;
    }
  }
  var s = linkedFactoryOrderIds();
  var f = require("factoryManager");
  var u = f && typeof f.getOrders === "function" ? f.getOrders() : [];
  for (var c = 0; c < u.length; c++) {
    var v = u[c];
    if (v && v.room === e && v.status !== "done" && v.status !== "cancelled" && v.status !== "failed" && v.status !== "error" && v.phase !== "done" && v.phase !== "cancelled" && v.phase !== "failed" && v.phase !== "error" && !(v.id && s[v.id])) r++;
  }
  return r;
}

function countSelling(e) {
  var r = 0;
  var a = getRefineOperations();
  var t = [ a.market, a.local ];
  for (var n = 0; n < t.length; n++) {
    var o = t[n];
    for (var i = 0; i < o.length; i++) {
      var l = o[i];
      if (l && l.room === e && isLiveOp(l) && l.phase === "selling") r++;
    }
  }
  return r;
}

function refusal(e, r) {
  var a = countRoom(e);
  if (a < MAX_OPS_PER_ROOM) return null;
  return "[" + r + "] Active operation limit reached in " + e + " (" + MAX_OPS_PER_ROOM + " operations)";
}

module.exports = {
  MAX_OPS_PER_ROOM: MAX_OPS_PER_ROOM,
  countRoom: countRoom,
  countSelling: countSelling,
  refusal: refusal
};
