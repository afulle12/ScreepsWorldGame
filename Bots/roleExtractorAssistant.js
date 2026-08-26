// LLM: Read docs/codex.js before reviewing or changing this file.
// roleExtractorAssistant.js
// Role dispatch: memory.role === 'extractorAssistant' -> roleExtractorAssistant.run(creep).
// Example: require('roleExtractorAssistant').run(creep);
// Example: require('roleExtractorAssistant').run(creep);
"use strict";
const FETCH_THRESHOLD = 1800;
const WAIT_RANGE = 3;
const IDLE_SLEEP_TICKS = 10;
const CONTAINER_RESCAN = 1e3;
var getRoomState = require("getRoomState");
function edgeAvoidingOpts(e) {
  e = e || {};
  e.costCallback = function(e, r) {
    var t = r.clone();
    var n = 50;
    for (var i = 0; i < n; i++) {
      t.set(i, 0, 255);
      t.set(i, n - 1, 255);
    }
    for (var a = 0; a < n; a++) {
      t.set(0, a, 255);
      t.set(n - 1, a, 255);
    }
    return t;
  };
  return e;
}

function mineralAmountInStore(e) {
  var r = 0;
  for (var t in e) {
    if (t !== RESOURCE_ENERGY) r += e[t] || 0;
  }
  return r;
}

function firstMineralType(e) {
  for (var r in e) {
    if (r !== RESOURCE_ENERGY && e[r] > 0) return r;
  }
  return null;
}

function resolveContainer(e, r) {
  var t = e.memory.containerIdEA;
  var n = !e.memory._containerScanTick || Game.time - e.memory._containerScanTick >= CONTAINER_RESCAN;
  if (t && !n) {
    var i = Game.getObjectById(t);
    if (i) return i;
  }
  if (!r || !r.structuresByType) return null;
  var a = r.structuresByType[STRUCTURE_EXTRACTOR] || [];
  var o = null;
  for (var s = 0; s < a.length; s++) {
    if (a[s].my) {
      o = a[s];
      break;
    }
  }
  if (!o) return null;
  var m = r.structuresByType[STRUCTURE_CONTAINER] || [];
  for (var l = 0; l < m.length; l++) {
    if (m[l].pos.getRangeTo(o.pos) <= 1) {
      e.memory.containerIdEA = m[l].id;
      e.memory._containerScanTick = Game.time;
      return m[l];
    }
  }
  e.memory.containerIdEA = null;
  e.memory._containerScanTick = Game.time;
  return null;
}

function resolveExtractor(e) {
  if (!e || !e.structuresByType) return null;
  var r = e.structuresByType[STRUCTURE_EXTRACTOR] || [];
  for (var t = 0; t < r.length; t++) {
    if (r[t].my) return r[t];
  }
  return null;
}

function tryMove(e, r, t) {
  if (e.fatigue > 0) return false;
  e.moveTo(r, edgeAvoidingOpts(t));
  return true;
}

var roleExtractorAssistant = {
  run: function(e) {
    if (e.memory.sleepUntil && Game.time < e.memory.sleepUntil) {
      return;
    }
    delete e.memory.sleepUntil;
    if (e.ticksToLive < 400 && mineralAmountInStore(e.store) === 0) {
      e.suicide();
      return;
    }
    var r = getRoomState.get(e.room.name);
    var t = resolveContainer(e, r);
    var n = resolveExtractor(r);
    var i = r && r.minerals && r.minerals.length > 0 ? r.minerals[0] : null;
    var a = !i || i.mineralAmount === 0;
    var o = t ? mineralAmountInStore(t.store) : 0;
    var s = mineralAmountInStore(e.store);
    if (a && o === 0 && s === 0) {
      console.log("[ExtractorAssistant] " + e.name + ": work complete — suiciding.");
      e.suicide();
      return;
    }
    var m = e.memory.state || "waiting";
    if (e.store.getFreeCapacity() === 0) {
      m = "delivering";
    } else if (m === "delivering" && s === 0) {
      m = "waiting";
    }
    if (m === "waiting") {
      var l = t && (o >= FETCH_THRESHOLD || a && o > 0);
      if (l) m = "fetching";
    }
    e.memory.state = m;
    switch (m) {
     case "waiting":
      {
        var u = n || t;
        if (!u) {
          e.memory.sleepUntil = Game.time + IDLE_SLEEP_TICKS * 3;
          return;
        }
        if (e.pos.getRangeTo(u.pos) > WAIT_RANGE) {
          tryMove(e, u.pos, {
            reusePath: 20,
            range: WAIT_RANGE
          });
          return;
        }
        e.memory.sleepUntil = Game.time + IDLE_SLEEP_TICKS;
        return;
      }
     case "fetching":
      {
        if (!t) {
          e.memory.state = "waiting";
          return;
        }
        var f = e.store.getFreeCapacity();
        if (f === 0) {
          e.memory.state = "delivering";
          return;
        }
        var c = null;
        for (var E in t.store) {
          if (E !== RESOURCE_ENERGY && (t.store[E] || 0) > 0) {
            c = E;
            break;
          }
        }
        if (!c) {
          e.memory.state = s > 0 ? "delivering" : "waiting";
          return;
        }
        if (!e.pos.isNearTo(t.pos)) {
          tryMove(e, t.pos, {
            reusePath: 10
          });
          return;
        }
        var v = e.withdraw(t, c);
        if (v === OK) {} else if (v === ERR_FULL) {
          e.memory.state = "delivering";
        } else if (v === ERR_NOT_ENOUGH_RESOURCES) {} else if (v !== ERR_BUSY && v !== ERR_NOT_IN_RANGE) {
          console.log("[ExtractorAssistant] " + e.name + ": withdraw err " + v);
          e.memory.state = "waiting";
        }
        break;
      }
     case "delivering":
      {
        var R = e.room.storage;
        if (!R) {
          var g = firstMineralType(e.store);
          if (g) e.drop(g);
          e.memory.state = "waiting";
          return;
        }
        var y = firstMineralType(e.store);
        if (!y) {
          e.memory.state = "waiting";
          return;
        }
        if (!e.pos.isNearTo(R.pos)) {
          tryMove(e, R.pos, {
            reusePath: 10
          });
          return;
        }
        var T = e.transfer(R, y);
        if (T === OK) {} else if (T === ERR_FULL) {
          e.drop(y);
        } else if (T !== ERR_BUSY && T !== ERR_NOT_IN_RANGE) {
          console.log("[ExtractorAssistant] " + e.name + ": transfer err " + T);
          e.memory.state = "waiting";
        }
        break;
      }
     default:
      e.memory.state = "waiting";
      break;
    }
  }
};
module.exports = roleExtractorAssistant;
