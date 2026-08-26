// LLM: Read docs/codex.js before reviewing or changing this file.
// singleSourceRoom.js
// Console globals: detectAnchors, setAnchor, showAnchors, enableSingleSource, disableSingleSource
// Example: detectAnchors('W1N1') - Auto-detect and record base anchor tiles in room
// Example: setAnchor('W1N1', 25, 25) - Manually set room center anchor coordinates
// Example: showAnchors('W1N1') - Display stored anchor coordinates and status
// Example: enableSingleSource('W1N1') - Enable single-source room optimizations
// Example: disableSingleSource('W1N1') - Disable single-source room optimizations
//   detectAnchors('W1N1')     — auto-detect and store anchor tiles
//   setAnchor('W1N1', 'hd', 25, 30)  — manually set an anchor tile
//   showAnchors('W1N1')       — display current anchor config
//   enableSingleSource('W1N1') — mark room for single-source mode
//   disableSingleSource('W1N1') — revert to normal mode
var getRoomState = require("getRoomState");
var DIR_OFFSETS = {};
DIR_OFFSETS[TOP] = {
  dx: 0,
  dy: -1
};
DIR_OFFSETS[TOP_RIGHT] = {
  dx: 1,
  dy: -1
};
DIR_OFFSETS[RIGHT] = {
  dx: 1,
  dy: 0
};
DIR_OFFSETS[BOTTOM_RIGHT] = {
  dx: 1,
  dy: 1
};
DIR_OFFSETS[BOTTOM] = {
  dx: 0,
  dy: 1
};
DIR_OFFSETS[BOTTOM_LEFT] = {
  dx: -1,
  dy: 1
};
DIR_OFFSETS[LEFT] = {
  dx: -1,
  dy: 0
};
DIR_OFFSETS[TOP_LEFT] = {
  dx: -1,
  dy: -1
};
var REVERSE_DIR = {};
REVERSE_DIR["0,-1"] = TOP;
REVERSE_DIR["1,-1"] = TOP_RIGHT;
REVERSE_DIR["1,0"] = RIGHT;
REVERSE_DIR["1,1"] = BOTTOM_RIGHT;
REVERSE_DIR["0,1"] = BOTTOM;
REVERSE_DIR["-1,1"] = BOTTOM_LEFT;
REVERSE_DIR["-1,0"] = LEFT;
REVERSE_DIR["-1,-1"] = TOP_LEFT;
function getAnchorMemory(r) {
  if (!Memory.anchors) return null;
  return Memory.anchors[r] || null;
}

function setAnchorMemory(r, e) {
  if (!Memory.anchors) Memory.anchors = {};
  Memory.anchors[r] = e;
}

function isSingleSourceRoom(r) {
  if (!Memory.singleSourceRooms) return false;
  return !!Memory.singleSourceRooms[r];
}

function isSingleSourceActive(r) {
  if (!isSingleSourceRoom(r)) return false;
  var e = Game.rooms[r];
  if (!e || !e.controller || !e.controller.my) return false;
  if (e.controller.level < 8) return false;
  var n = getRoomState.get(r);
  if (!n || !n.sources || n.sources.length !== 1) return false;
  return true;
}

function getAdjacentTiles(r) {
  var e = [];
  for (var n = -1; n <= 1; n++) {
    for (var o = -1; o <= 1; o++) {
      if (n === 0 && o === 0) continue;
      var t = r.x + n;
      var i = r.y + o;
      if (t < 1 || t > 48 || i < 1 || i > 48) continue;
      e.push({
        x: t,
        y: i
      });
    }
  }
  return e;
}

function isWalkable(r, e, n) {
  var o = r.getTerrain();
  if (o.get(e, n) === TERRAIN_MASK_WALL) return false;
  var t = r.lookForAt(LOOK_STRUCTURES, e, n);
  for (var i = 0; i < t.length; i++) {
    var a = t[i].structureType;
    if (a === STRUCTURE_ROAD || a === STRUCTURE_CONTAINER || a === STRUCTURE_RAMPART) continue;
    if (OBSTACLE_OBJECT_TYPES.indexOf(a) !== -1) return false;
  }
  return true;
}

function inRange1(r, e, n) {
  return Math.abs(r - n.x) <= 1 && Math.abs(e - n.y) <= 1;
}

function findAnchorTile(r, e, n) {
  if (!e || e.length === 0) return null;
  var o = e[0].pos || e[0];
  var t = getAdjacentTiles(o);
  for (var i = 1; i < e.length; i++) {
    var a = e[i].pos || e[i];
    t = t.filter(function(r) {
      return inRange1(r.x, r.y, a);
    });
  }
  t = t.filter(function(e) {
    return isWalkable(r, e.x, e.y);
  });
  if (t.length === 0) return null;
  if (t.length === 1) return t[0];
  var l = t[0];
  var u = 0;
  for (var c = 0; c < t.length; c++) {
    var s = t[c];
    var f = 0;
    if (n) {
      for (var R = 0; R < n.length; R++) {
        var T = n[R].pos || n[R];
        if (inRange1(s.x, s.y, T)) f++;
      }
    }
    if (f > u) {
      u = f;
      l = s;
    }
  }
  return l;
}

function classifyLinks(r) {
  var e = getRoomState.get(r);
  if (!e) return null;
  var n = Game.rooms[r];
  if (!n) return null;
  var o = e.structuresByType || {};
  var t = o[STRUCTURE_LINK] || [];
  var i = e.sources || [];
  var a = o[STRUCTURE_TOWER] || [];
  var l = o[STRUCTURE_FACTORY] && o[STRUCTURE_FACTORY].length > 0 ? o[STRUCTURE_FACTORY][0] : null;
  var u = o[STRUCTURE_TERMINAL] && o[STRUCTURE_TERMINAL].length > 0 ? o[STRUCTURE_TERMINAL][0] : null;
  var c = e.controller;
  var s = {
    source: null,
    factory: null,
    tower: null,
    controller: null
  };
  var f = {};
  for (var R = 0; R < t.length; R++) {
    var T = t[R];
    if (f[T.id]) continue;
    for (var h = 0; h < i.length; h++) {
      if (T.pos.getRangeTo(i[h]) <= 2) {
        s.source = T.id;
        f[T.id] = true;
        break;
      }
    }
    if (s.source) break;
  }
  for (var R = 0; R < t.length; R++) {
    var T = t[R];
    if (f[T.id]) continue;
    if (c && T.pos.getRangeTo(c) <= 3) {
      s.controller = T.id;
      f[T.id] = true;
      break;
    }
  }
  for (var R = 0; R < t.length; R++) {
    var T = t[R];
    if (f[T.id]) continue;
    var S = l && T.pos.getRangeTo(l) <= 2;
    var g = u && T.pos.getRangeTo(u) <= 2;
    if (S || g) {
      s.factory = T.id;
      f[T.id] = true;
      break;
    }
  }
  for (var R = 0; R < t.length; R++) {
    var T = t[R];
    if (f[T.id]) continue;
    for (var v = 0; v < a.length; v++) {
      if (T.pos.getRangeTo(a[v]) <= 2) {
        s.tower = T.id;
        f[T.id] = true;
        break;
      }
    }
    if (s.tower) break;
  }
  return s;
}

function detectAnchors(r) {
  var e = Game.rooms[r];
  if (!e) return "[SingleSource] Room not visible: " + r;
  var n = getRoomState.get(r);
  if (!n) return "[SingleSource] No room state for: " + r;
  var o = n.structuresByType || {};
  var t = n.sources || [];
  var i = (o[STRUCTURE_SPAWN] || []).filter(function(r) {
    return r.my;
  });
  var a = (o[STRUCTURE_LINK] || []).filter(function(r) {
    return r.my;
  });
  var l = (o[STRUCTURE_EXTENSION] || []).filter(function(r) {
    return r.my;
  });
  var u = (o[STRUCTURE_TOWER] || []).filter(function(r) {
    return r.my;
  });
  var c = o[STRUCTURE_FACTORY] || [];
  var s = o[STRUCTURE_TERMINAL] || [];
  var f = (o[STRUCTURE_EXTRACTOR] || []).filter(function(r) {
    return r.my;
  });
  var R = n.minerals || [];
  var T = n.storage;
  if (t.length !== 1) return "[SingleSource] Room has " + t.length + " sources, expected 1.";
  var h = classifyLinks(r);
  if (!h) return "[SingleSource] Could not classify links.";
  var S = h.source ? Game.getObjectById(h.source) : null;
  var g = h.factory ? Game.getObjectById(h.factory) : null;
  var v = h.tower ? Game.getObjectById(h.tower) : null;
  var E = h.controller ? Game.getObjectById(h.controller) : null;
  var d = [];
  var m = null;
  if (t[0] && S) {
    var y = i.filter(function(r) {
      return r.pos.getRangeTo(t[0]) <= 2;
    });
    if (y.length > 0) {
      var A = [ t[0], y[0], S ];
      m = findAnchorTile(e, A, l);
      if (m) {
        d.push("HD anchor: (" + m.x + "," + m.y + ") near source");
      } else {
        d.push("HD anchor: FAILED - no valid tile adjacent to source + spawn + link");
      }
    } else {
      d.push("HD anchor: FAILED - no spawn near source");
    }
  }
  var p = null;
  if (R.length > 0 && c.length > 0 && s.length > 0 && g && T) {
    var O = i.filter(function(r) {
      return r.pos.getRangeTo(c[0]) <= 2 || r.pos.getRangeTo(s[0]) <= 2;
    });
    if (O.length > 0) {
      var _ = [ R[0], c[0], s[0], g, O[0], T ];
      p = findAnchorTile(e, _, []);
      if (p) {
        d.push("ComboBot anchor: (" + p.x + "," + p.y + ") near factory/terminal");
      } else {
        var b = [ R[0], c[0], s[0], g, O[0] ];
        p = findAnchorTile(e, b, T ? [ T ] : []);
        if (p) {
          d.push("ComboBot anchor: (" + p.x + "," + p.y + ") near factory (storage range 2)");
        } else {
          d.push("ComboBot anchor: FAILED - no valid tile");
        }
      }
    } else {
      d.push("ComboBot anchor: FAILED - no spawn near factory area");
    }
  }
  var I = null;
  if (v && u.length > 0) {
    var C = i.filter(function(r) {
      for (var e = 0; e < u.length; e++) {
        if (r.pos.getRangeTo(u[e]) <= 2) return true;
      }
      return false;
    });
    if (C.length > 0) {
      var D = [ v, C[0], u[0] ];
      I = findAnchorTile(e, D, l.concat(u.slice(1)));
      if (I) {
        d.push("Distributor anchor: (" + I.x + "," + I.y + ") near towers");
      } else {
        d.push("Distributor anchor: FAILED - no valid tile adjacent to link + spawn + tower");
      }
    } else {
      d.push("Distributor anchor: FAILED - no spawn near towers");
    }
  }
  setAnchorMemory(r, {
    hd: m,
    distributor: I,
    comboBot: p,
    linkChain: h,
    hdSpawn: m ? findSpawnNear(i, t[0], 2) : null,
    distributorSpawn: I ? findSpawnNear(i, u[0], 3) : null,
    comboBotSpawn: p ? findSpawnNear(i, c[0] || s[0], 3) : null,
    detectedAt: Game.time
  });
  var U = "[SingleSource] Anchor detection for " + r + ":\n" + d.join("\n");
  return U;
}

function findSpawnNear(r, e, n) {
  if (!e || !r) return null;
  for (var o = 0; o < r.length; o++) {
    if (r[o].pos.getRangeTo(e) <= n) return r[o].id;
  }
  return null;
}

function getAnchorSpawnDirection(r, e) {
  var n = e.x - r.x;
  var o = e.y - r.y;
  n = n === 0 ? 0 : n > 0 ? 1 : -1;
  o = o === 0 ? 0 : o > 0 ? 1 : -1;
  var t = n + "," + o;
  var i = REVERSE_DIR[t];
  if (i !== undefined) return [ i ];
  return undefined;
}

function getAnchors(r) {
  return getAnchorMemory(r);
}

function getLinkChain(r) {
  var e = getAnchors(r);
  if (!e || !e.linkChain) return null;
  var n = e.linkChain;
  var o = [];
  if (n.source) o.push(n.source);
  if (n.factory) o.push(n.factory);
  if (n.tower) o.push(n.tower);
  if (n.controller) o.push(n.controller);
  return o.length >= 2 ? o : null;
}

global.detectAnchors = function(r) {
  getRoomState.init();
  return detectAnchors(r);
};
global.setAnchor = function(r, e, n, o) {
  if (!Memory.anchors) Memory.anchors = {};
  if (!Memory.anchors[r]) Memory.anchors[r] = {};
  Memory.anchors[r][e] = {
    x: n,
    y: o
  };
  return "[SingleSource] Set " + e + " anchor in " + r + " to (" + n + "," + o + ")";
};
global.showAnchors = function(r) {
  var e = getAnchors(r);
  if (!e) return "[SingleSource] No anchors configured for " + r;
  var n = [ "=== ANCHORS FOR " + r + " ===" ];
  if (e.hd) n.push("HD: (" + e.hd.x + "," + e.hd.y + ")"); else n.push("HD: NOT SET");
  if (e.distributor) n.push("Distributor: (" + e.distributor.x + "," + e.distributor.y + ")"); else n.push("Distributor: NOT SET");
  if (e.comboBot) n.push("ComboBot: (" + e.comboBot.x + "," + e.comboBot.y + ")"); else n.push("ComboBot: NOT SET");
  if (e.linkChain) {
    var o = e.linkChain;
    n.push("Link chain: source=" + (o.source || "N/A") + " factory=" + (o.factory || "N/A") + " tower=" + (o.tower || "N/A") + " controller=" + (o.controller || "N/A"));
  }
  n.push("Detected at tick: " + (e.detectedAt || "manual"));
  var t = n.join("\n");
  return t;
};
global.enableSingleSource = function(r) {
  if (!Memory.singleSourceRooms) Memory.singleSourceRooms = {};
  Memory.singleSourceRooms[r] = true;
  return "[SingleSource] Enabled for " + r + ". Run detectAnchors('" + r + "') to configure.";
};
global.disableSingleSource = function(r) {
  if (Memory.singleSourceRooms) delete Memory.singleSourceRooms[r];
  return "[SingleSource] Disabled for " + r + ". Room will use normal creep roles.";
};
module.exports = {
  isSingleSourceRoom: isSingleSourceRoom,
  isSingleSourceActive: isSingleSourceActive,
  getAnchors: getAnchors,
  getLinkChain: getLinkChain,
  getAnchorSpawnDirection: getAnchorSpawnDirection,
  classifyLinks: classifyLinks,
  detectAnchors: detectAnchors
};
