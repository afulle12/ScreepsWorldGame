// LLM: Read docs/codex.js before reviewing or changing this file.
// roadBuilder.js
// Console globals: buildRoad, removeRoad, removeAllRoads
// Example: buildRoad('E1N1', 'E2N2') - Plan and place construction sites for inter-room road
// Example: removeRoad('E1N1', 'E2N2') - Remove planned road construction sites between rooms
// Example: removeAllRoads('E1N1') - Remove all road construction sites in room
//   buildRoad('E2N46', 8, 36, 42, 2)
//   buildRoad('E2N46', 8, 36, 42, 2, { plainCost: 2, swampCost: 10 })  // optional overrides
//   removeRoad('E2N46', 8, 36, 42, 2)
//   removeRoad('E2N46', 8, 36, 42, 2, { plainCost: 2, swampCost: 10 }) // optional overrides
//   removeAllRoads('E2N46')
"use strict";
var getRoomState = require("getRoomState");
function _flattenStructures(o) {
  var e = [];
  for (var r in o) {
    if (!o.hasOwnProperty(r)) continue;
    var t = o[r];
    for (var n = 0; n < t.length; n++) e.push(t[n]);
  }
  return e;
}

function _roomCostMatrix(o) {
  var e = Game.rooms[o];
  if (!e) return;
  var r = new PathFinder.CostMatrix;
  var t = getRoomState.get(o);
  var n = t && t.structuresByType ? _flattenStructures(t.structuresByType) : e.find(FIND_STRUCTURES);
  for (var a = 0; a < n.length; a++) {
    var s = n[a];
    if (s.structureType === STRUCTURE_ROAD) {
      r.set(s.pos.x, s.pos.y, 1);
    } else if (s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART) {
      r.set(s.pos.x, s.pos.y, 255);
    }
  }
  var i = t && t.constructionSites ? t.constructionSites : e.find(FIND_CONSTRUCTION_SITES);
  for (var R = 0; R < i.length; R++) {
    var l = i[R];
    if (l.structureType !== STRUCTURE_ROAD && l.structureType !== STRUCTURE_CONTAINER && l.structureType !== STRUCTURE_RAMPART) {
      r.set(l.pos.x, l.pos.y, 255);
    }
  }
  return r;
}

function _findPath(o, e, r, t, n, a) {
  var s = new RoomPosition(e, r, o);
  var i = new RoomPosition(t, n, o);
  return PathFinder.search(s, {
    pos: i,
    range: a.range || 0
  }, {
    plainCost: a.plainCost || 1,
    swampCost: a.swampCost || 1,
    roomCallback: _roomCostMatrix
  });
}

function buildRoad(o, e, r, t, n, a) {
  a = a || {};
  var s = Game.rooms[o];
  if (!s) {
    console.log("[buildRoad] ERROR: No vision in room " + o + ". A creep or structure must be present there.");
    return;
  }
  console.log("[buildRoad] Searching path from (" + e + "," + r + ") to (" + t + "," + n + ") in " + o + "...");
  var i = _findPath(o, e, r, t, n, a);
  if (!i || i.path.length === 0) {
    console.log("[buildRoad] ERROR: No path found. incomplete=" + i.incomplete);
    return;
  }
  console.log("[buildRoad] Path found: " + i.path.length + " steps, cost=" + i.cost + ", incomplete=" + i.incomplete);
  var R = 0;
  var l = 0;
  var u = [];
  for (var c = 0; c < i.path.length; c++) {
    var d = i.path[c];
    var v = d.lookFor(LOOK_STRUCTURES).some(function(o) {
      return o.structureType === STRUCTURE_ROAD;
    });
    var p = d.lookFor(LOOK_CONSTRUCTION_SITES).some(function(o) {
      return o.structureType === STRUCTURE_ROAD;
    });
    if (v || p) {
      l++;
      continue;
    }
    var T = s.createConstructionSite(d.x, d.y, STRUCTURE_ROAD);
    if (T === OK) {
      R++;
    } else {
      var f = _errorCode(T);
      u.push("(" + d.x + "," + d.y + ") code=" + T + " (" + f + ")");
      if (T === ERR_FULL) {
        console.log("[buildRoad] Hit 100 construction site cap at step " + c + ". Stopping early.");
        break;
      }
    }
  }
  console.log("[buildRoad] Done. Placed=" + R + " Skipped=" + l + " Errors=" + u.length);
  if (u.length > 0) {
    console.log("[buildRoad] Error details: " + u.join(" | "));
  }
}

function removeRoad(o, e, r, t, n, a) {
  a = a || {};
  var s = Game.rooms[o];
  if (!s) {
    console.log("[removeRoad] ERROR: No vision in room " + o + ". A creep or structure must be present there.");
    return;
  }
  console.log("[removeRoad] Searching path from (" + e + "," + r + ") to (" + t + "," + n + ") in " + o + "...");
  var i = _findPath(o, e, r, t, n, a);
  if (!i || i.path.length === 0) {
    console.log("[removeRoad] ERROR: No path found. incomplete=" + i.incomplete);
    return;
  }
  console.log("[removeRoad] Path found: " + i.path.length + " steps, cost=" + i.cost + ", incomplete=" + i.incomplete);
  var R = 0;
  var l = 0;
  var u = 0;
  var c = [];
  for (var d = 0; d < i.path.length; d++) {
    var v = i.path[d];
    var p = v.lookFor(LOOK_STRUCTURES).filter(function(o) {
      return o.structureType === STRUCTURE_ROAD;
    });
    p.forEach(function(o) {
      var e = o.destroy();
      if (e === OK) {
        R++;
      } else {
        c.push("destroy (" + v.x + "," + v.y + ") code=" + e + " (" + _errorCode(e) + ")");
      }
    });
    var T = v.lookFor(LOOK_CONSTRUCTION_SITES).filter(function(o) {
      return o.structureType === STRUCTURE_ROAD;
    });
    T.forEach(function(o) {
      var e = o.remove();
      if (e === OK) {
        l++;
      } else {
        c.push("remove site (" + v.x + "," + v.y + ") code=" + e + " (" + _errorCode(e) + ")");
      }
    });
    if (p.length === 0 && T.length === 0) {
      u++;
    }
  }
  console.log("[removeRoad] Done. Demolished=" + R + " Cancelled=" + l + " Skipped=" + u + " Errors=" + c.length);
  if (c.length > 0) {
    console.log("[removeRoad] Error details: " + c.join(" | "));
  }
}

function removeAllRoads(o) {
  var e = Game.rooms[o];
  if (!e) {
    console.log("[removeAllRoads] ERROR: No vision in room " + o + ". A creep or structure must be present there.");
    return;
  }
  var r = 0;
  var t = 0;
  var n = [];
  var a = getRoomState.get(o);
  var s = a && a.structuresByType && a.structuresByType[STRUCTURE_ROAD] || [];
  if (s.length === 0) {
    e.find(FIND_STRUCTURES).forEach(function(o) {
      if (o.structureType === STRUCTURE_ROAD) s.push(o);
    });
  }
  for (var i = 0; i < s.length; i++) {
    var R = s[i];
    if (R.structureType !== STRUCTURE_ROAD) continue;
    var l = R.destroy();
    if (l === OK) {
      r++;
    } else {
      n.push("destroy (" + R.pos.x + "," + R.pos.y + ") code=" + l + " (" + _errorCode(l) + ")");
    }
  }
  var u = a && a.constructionSites ? a.constructionSites : e.find(FIND_CONSTRUCTION_SITES);
  for (var c = 0; c < u.length; c++) {
    var d = u[c];
    if (d.structureType !== STRUCTURE_ROAD) continue;
    var v = d.remove();
    if (v === OK) {
      t++;
    } else {
      n.push("remove site (" + d.pos.x + "," + d.pos.y + ") code=" + v + " (" + _errorCode(v) + ")");
    }
  }
  console.log("[removeAllRoads] Done in " + o + ". Demolished=" + r + " Cancelled=" + t + " Errors=" + n.length);
  if (n.length > 0) {
    console.log("[removeAllRoads] Error details: " + n.join(" | "));
  }
}

function _errorCode(o) {
  var e = {
    0: "OK",
    "-1": "ERR_NOT_OWNER",
    "-7": "ERR_INVALID_TARGET",
    "-8": "ERR_FULL",
    "-10": "ERR_INVALID_ARGS",
    "-14": "ERR_RCL_NOT_ENOUGH"
  };
  return e[String(o)] || "UNKNOWN";
}

global.buildRoad = buildRoad;
global.removeRoad = removeRoad;
global.removeAllRoads = removeAllRoads;
module.exports = {
  buildRoad: buildRoad,
  removeRoad: removeRoad,
  removeAllRoads: removeAllRoads
};
