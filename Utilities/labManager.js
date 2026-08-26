// LLM: Read docs/codex.js before reviewing or changing this file.
// labManager.js
// Console globals: showLabs, showAllLabs, orderLabs, cancelLabs, breakdownLabs, recomputeLabLayout, labsStats, labsPipelineDiagnose, labsPipelineDiagnoseJSON, labsPipelineSelfTest, labsDiagnoseRoom, labsDiagnoseBots, labsClearBotMemory, checkLabBots, labsDebugOn, labsDebugOff, marketSell
// Example: showLabs('E1N1') - Display lab layout, reagents, and active reaction in room
// Example: showAllLabs() - Display lab status across all rooms
// Example: orderLabs('E1N1', 'UL', 3000) - Queue lab compound reaction order
// Example: cancelLabs('E1N1') - Cancel active lab reaction order in room
// Example: breakdownLabs('E1N1', 'OH', 3000) - Queue reverse reaction breakdown order
// Example: recomputeLabLayout('E1N1') - Recompute booster and source lab assignments
// Example: labsStats() - Print lab production metrics and throughput stats
// Example: labsPipelineDiagnose('E1N1') - Run diagnostics on lab reaction pipeline
// Example: labsPipelineDiagnoseJSON('E1N1') - Export lab pipeline diagnostics as JSON
// Example: labsPipelineSelfTest() - Run self-test suite on lab pipeline logic
// Example: labsDiagnoseRoom('E1N1') - Run comprehensive lab diagnosis for room
// Example: labsDiagnoseBots('E1N1') - Inspect and diagnose labBot creep tasks
// Example: labsClearBotMemory('E1N1') - Reset memory for labBot creeps in room
// Example: checkLabBots('E1N1') - Verify labBot creep health and task assignments
// Example: labsDebugOn('E1N1') - Enable verbose lab logging for room
// Example: labsDebugOff('E1N1') - Disable verbose lab logging for room
// Example: marketSell('E1N1', RESOURCE_LEMERGIUM, 1000) - Dispatch labBot market sell transfer
var labManager = function() {
  var e = 50;
  var r = 1;
  var a = require("labCommodityPolicy").MIN_REACTION_AMOUNT;
  var t = 3e3;
  var n = 1e4;
  var o = 5e4;
  var i = 1e5;
  var u = 3e3;
  var s = 1e3;
  var l = require("storageManager");
  var d = require("getRoomState");
  var c = require("roomSuspender");
  var p = require("economics");
  var v = require("memoryManager");
  var m = require("labCommodityPolicy");
  var g = require("labCommodityRouter");
  var f = require("labReactionPipeline");
  function layoutMemory() {
    if (!v.heap.labLayout) {
      v.heap.labLayout = Memory.labLayout || {};
      if (Memory.labLayout) {
        delete Memory.labLayout;
        v.requestSave();
      }
    }
    return v.heap.labLayout;
  }
  function _getLabs(e) {
    if (!e) return [];
    var r = d.get(e.name);
    if (r && r.structuresByType && r.structuresByType[STRUCTURE_LAB]) {
      return r.structuresByType[STRUCTURE_LAB];
    }
    return e.find(FIND_STRUCTURES, {
      filter: function(e) {
        return e.structureType === STRUCTURE_LAB;
      }
    });
  }
  function v2Enabled(e) {
    var r = Game.rooms[e];
    return !!(r && r.controller && r.controller.my);
  }
  function releaseOrderReservations(e) {
    if (!e || !e.reservationProgram) return;
    var r = e.leafReagents || [];
    var a = e.room || e.roomName;
    for (var t = 0; t < r.length; t++) {
      var n = r[t].reagent;
      if (!a) continue;
      l.unReserve(a, n, "terminal", e.reservationProgram);
      l.unReserve(a, n, "storage", e.reservationProgram);
    }
  }
  function computeLeafReagents(e, r, a) {
    var t = {};
    function stepDose(r, a) {
      var n = findDirectReagents(r);
      if (!n) return;
      var o = false;
      for (var i = 0; i < e.length; i++) {
        if (e[i].product === n.a) {
          o = true;
          break;
        }
      }
      if (!o) {
        t[n.a] = (t[n.a] || 0) + a;
      }
      var u = false;
      for (var s = 0; s < e.length; s++) {
        if (e[s].product === n.b) {
          u = true;
          break;
        }
      }
      if (!u) {
        t[n.b] = (t[n.b] || 0) + a;
      }
    }
    for (var n = 0; n < e.length; n++) {
      var o = e[n];
      var i = findDirectReagents(o.product);
      if (!i) continue;
      var u = o.product === r ? a : Math.ceil(a * 1.2);
      var s = false, l = false;
      for (var d = 0; d < e.length; d++) {
        if (e[d].product === i.a) s = true;
        if (e[d].product === i.b) l = true;
      }
      if (!s) t[i.a] = (t[i.a] || 0) + u;
      if (!l) t[i.b] = (t[i.b] || 0) + u;
    }
    var c = [];
    for (var p in t) {
      c.push({
        reagent: p,
        amount: t[p]
      });
    }
    return c;
  }
  var b = {};
  var h = {};
  var y = 0;
  function debugLog(e) {
    if (!Memory.labManager) Memory.labManager = {};
    if (Memory.labManager.debug) {
      console.log(e);
    }
  }
  function ensureOrdersRoot() {
    if (!Memory.labOrders) Memory.labOrders = {};
  }
  function ensureRoomOrders(e) {
    ensureOrdersRoot();
    if (!Memory.labOrders[e]) {
      Memory.labOrders[e] = {
        active: null,
        queue: []
      };
    }
    return Memory.labOrders[e];
  }
  function snapshotOrder(e) {
    return e && typeof e === "object" ? Object.create(e) : null;
  }
  function getRoomOrderState(e) {
    var r = Memory.labOrders && Memory.labOrders[e];
    if (!r) return null;
    var a = Array.isArray(r.queue) ? r.queue : [];
    return {
      active: snapshotOrder(r.active),
      queue: a.map(function(e) {
        return snapshotOrder(e);
      })
    };
  }
  function migrateLegacyOrders() {
    if (!Memory.labOrders || Memory._labOrdersMigrated) return;
    for (var e in Memory.labOrders) {
      var r = Memory.labOrders[e];
      if (!r) continue;
      var a = typeof r === "object" && (r.product !== undefined || r.state !== undefined || r.amount !== undefined) && r.active === undefined && r.queue === undefined;
      if (a) {
        var t = r.product || "";
        var n = r.amount || 0;
        var o = r.createdAt || Game.time;
        var i = null;
        var u = null;
        if (t) {
          for (var s in REACTIONS) {
            var l = REACTIONS[s];
            for (var d in l) {
              if (l[d] === t) {
                i = s;
                u = d;
                break;
              }
            }
            if (i && u) break;
          }
        }
        Memory.labOrders[e] = {
          active: {
            product: t,
            amount: n,
            remaining: n,
            reag1: i,
            reag2: u,
            created: o
          },
          queue: []
        };
        console.log("[Labs] Migrated legacy lab order for " + e);
      } else if (typeof r !== "object" || r.active === undefined || r.queue === undefined) {
        Memory.labOrders[e] = {
          active: null,
          queue: []
        };
        console.log("[Labs] Reset malformed labOrders entry for " + e);
      }
    }
    Memory._labOrdersMigrated = true;
  }
  function pruneLabOrdersForUnownedRooms() {
    if (!Memory.labOrders) return;
    var e = d.owned();
    for (var r in Memory.labOrders) {
      if (!e[r]) delete Memory.labOrders[r];
    }
  }
  function ensureLayoutRoot() {
    layoutMemory();
  }
  function ensureManagerRoot() {
    if (!Memory.labManager) Memory.labManager = {};
  }
  function getCachedLayout(e) {
    if (Game.time > y) {
      b = {};
      h = {};
      y = Game.time + 10;
    }
    return b[e];
  }
  function getCachedBreakdownLayout(e) {
    if (Game.time > y) {
      b = {};
      h = {};
      y = Game.time + 10;
    }
    return h[e];
  }
  function setCachedLayout(e, r) {
    b[e] = r;
  }
  function setCachedBreakdownLayout(e, r) {
    h[e] = r;
  }
  function clearRoomCache(e, r) {
    delete b[e];
    delete h[e];
    var a = layoutMemory();
    if (a[e]) {
      if (r) {
        delete a[e];
      } else {
        delete a[e].validated;
        delete a[e].breakdownValidated;
      }
    }
  }
  function validateStoredLayout(r, a) {
    if (!a) return null;
    if (!a.groups || a.groups.length === 0) return null;
    if (a.validated && Game.time - a.validated < e) {
      var t = getCachedLayout(r.name);
      if (t) return t;
    }
    var n = [];
    for (var o = 0; o < a.groups.length; o++) {
      var i = a.groups[o];
      if (!i.in1Id || !i.in2Id || !i.outIds || i.outIds.length === 0) {
        continue;
      }
      var u = Game.getObjectById(i.in1Id);
      var s = Game.getObjectById(i.in2Id);
      if (!u || !s) continue;
      var l = [];
      for (var d = 0; d < i.outIds.length; d++) {
        var c = Game.getObjectById(i.outIds[d]);
        if (!c) continue;
        if (u.pos.inRangeTo(c, 2) && s.pos.inRangeTo(c, 2)) {
          l.push(c);
        }
      }
      if (l.length > 0) {
        n.push({
          in1: u,
          in2: s,
          outs: l
        });
      }
    }
    if (n.length === 0) return null;
    a.validated = Game.time;
    var p = {
      groups: n
    };
    setCachedLayout(r.name, p);
    return p;
  }
  function computeBestLayout(e) {
    var r = e._labsCache;
    if (!r || e._labsCacheTime !== Game.time) {
      r = _getLabs(e);
      e._labsCache = r;
      e._labsCacheTime = Game.time;
    }
    if (!r || r.length < 3) return null;
    var a = new Set;
    var t = [];
    var n = Math.floor(r.length / 3);
    for (var o = 0; o < n; o++) {
      var i = null;
      var u = null;
      var s = [];
      for (var l = 0; l < r.length; l++) {
        if (a.has(r[l].id)) continue;
        for (var d = l + 1; d < r.length; d++) {
          if (a.has(r[d].id)) continue;
          var c = r[l];
          var p = r[d];
          var v = [];
          for (var m = 0; m < r.length; m++) {
            if (m === l || m === d) continue;
            if (a.has(r[m].id)) continue;
            var g = r[m];
            if (c.pos.inRangeTo(g, 2) && p.pos.inRangeTo(g, 2)) {
              v.push(g);
            }
          }
          if (v.length > s.length) {
            i = c;
            u = p;
            s = v;
          }
        }
      }
      if (i && u && s.length > 0) {
        t.push({
          in1: i,
          in2: u,
          outs: s
        });
        a.add(i.id);
        a.add(u.id);
        for (var f = 0; f < s.length; f++) {
          a.add(s[f].id);
        }
        debugLog("[Labs] Found group " + t.length + ": in1=" + i.id.substr(-4) + " in2=" + u.id.substr(-4) + " outs=" + s.length);
      } else {
        break;
      }
    }
    if (t.length === 0) return null;
    var b = Memory.labOrders && Memory.labOrders[e.name] && Memory.labOrders[e.name].active;
    if (b) {
      ensureLayoutRoot();
      var h = [];
      for (var y = 0; y < t.length; y++) {
        h.push({
          in1Id: t[y].in1.id,
          in2Id: t[y].in2.id,
          outIds: t[y].outs.map(function(e) {
            return e.id;
          })
        });
      }
      layoutMemory()[e.name] = {
        groups: h,
        validated: Game.time
      };
    }
    var k = {
      groups: t
    };
    setCachedLayout(e.name, k);
    var L = 0;
    for (var O = 0; O < t.length; O++) {
      L += t[O].outs.length;
    }
    debugLog("[Labs] Computed layout for " + e.name + ": " + t.length + " groups, " + t.length * 2 + " inputs, " + L + " outputs");
    return k;
  }
  function resolveLayout(e) {
    var r = getCachedLayout(e.name);
    if (r) return r;
    ensureLayoutRoot();
    var a = layoutMemory()[e.name];
    var t = validateStoredLayout(e, a);
    if (t) return t;
    return computeBestLayout(e);
  }
  function getLayout(e) {
    return resolveLayout(e);
  }
  function computeBreakdownLayout(r) {
    var a = getCachedBreakdownLayout(r.name);
    if (a) return a;
    ensureLayoutRoot();
    var t = layoutMemory()[r.name];
    if (t && t.breakdownIn1Id && t.breakdownIn2Id && t.breakdownOutIds) {
      if (t.breakdownValidated && Game.time - t.breakdownValidated < e) {
        var n = Game.getObjectById(t.breakdownIn1Id);
        var o = Game.getObjectById(t.breakdownIn2Id);
        if (n && o) {
          var i = [];
          for (var u = 0; u < t.breakdownOutIds.length; u++) {
            var s = Game.getObjectById(t.breakdownOutIds[u]);
            if (s) i.push(s);
          }
          if (i.length > 0) {
            var l = {
              groups: [ {
                in1: n,
                in2: o,
                outs: i
              } ]
            };
            setCachedBreakdownLayout(r.name, l);
            return l;
          }
        }
      }
    }
    var d = _getLabs(r);
    if (!d || d.length < 3) return null;
    var c = null;
    var p = null;
    var v = [];
    for (var u = 0; u < d.length; u++) {
      for (var m = u + 1; m < d.length; m++) {
        var g = d[u];
        var f = d[m];
        var i = [];
        for (var b = 0; b < d.length; b++) {
          if (b === u || b === m) continue;
          var h = d[b];
          if (g.pos.inRangeTo(h, 2) && f.pos.inRangeTo(h, 2)) {
            i.push(h);
          }
        }
        if (i.length > v.length) {
          c = g;
          p = f;
          v = i;
        }
      }
    }
    if (!c || !p || v.length === 0) return null;
    var y = Memory.labOrders && Memory.labOrders[r.name] && Memory.labOrders[r.name].active;
    if (y) {
      var k = layoutMemory();
      if (!k[r.name]) {
        k[r.name] = {};
      }
      k[r.name].breakdownIn1Id = c.id;
      k[r.name].breakdownIn2Id = p.id;
      k[r.name].breakdownOutIds = v.map(function(e) {
        return e.id;
      });
      k[r.name].breakdownValidated = Game.time;
    }
    var l = {
      groups: [ {
        in1: c,
        in2: p,
        outs: v
      } ]
    };
    setCachedBreakdownLayout(r.name, l);
    return l;
  }
  function getBreakdownLayout(e) {
    return computeBreakdownLayout(e);
  }
  function pipelineReactionTime(e) {
    if (typeof REACTION_TIME !== "undefined" && REACTION_TIME && typeof REACTION_TIME[e] === "number") {
      return REACTION_TIME[e];
    }
    return 10;
  }
  function pipelineLabById(e, r) {
    if (!e || !r) return null;
    return Game.getObjectById(r);
  }
  function pipelineRangeValid(e, r) {
    if (!e || !r || r.length === 0) return false;
    for (var a = 0; a < r.length; a++) {
      if (!r[a] || !r[a].pos.inRangeTo(e, 2)) return false;
    }
    return true;
  }
  function pipelineStageOutputResources(e) {
    if (!e) return [];
    return e.mode === "decompose" ? e.outputs || [] : [ e.product ];
  }
  function pipelineStageSourceResources(e) {
    if (!e) return [];
    return e.mode === "decompose" ? [ e.product ] : e.inputs || [];
  }
  function computePipelineLayout(e, r) {
    if (!e || !r || !Array.isArray(r.stages) || r.stages.length === 0) {
      return {
        ok: false,
        reason: "pipeline has no stages"
      };
    }
    var a = _getLabs(e);
    var n = f.roomSupportsAdvanced(e, a);
    if (!n.ok) return n;
    if (r.requiresAdvancedRoom && a.length < 10) {
      return {
        ok: false,
        reason: "advanced pipeline requires 10 labs"
      };
    }
    for (var o = 0; o < r.stages.length; o++) {
      if (!(r.stages[o].amount > 0) || r.stages[o].amount > t) {
        return {
          ok: false,
          reason: "stage amount exceeds one lab wave"
        };
      }
    }
    var i = {};
    for (var u = 0; u < a.length; u++) i[a[u].id] = a[u];
    var s = {};
    var l = {};
    var d = [];
    var c = 0;
    var p = 5e4;
    var v = false;
    var m = null;
    function takeSearchNode() {
      if (v) return false;
      c++;
      if (c > p) {
        v = true;
        m = "node limit";
        return false;
      }
      if (typeof Game !== "undefined" && Game.cpu && typeof Game.cpu.getUsed === "function" && typeof Game.cpu.limit === "number" && Game.cpu.getUsed() >= Game.cpu.limit - 1) {
        v = true;
        m = "CPU budget";
        return false;
      }
      return true;
    }
    function availableLabs() {
      var e = [];
      for (var r = 0; r < a.length; r++) {
        if (!s[a[r].id]) e.push(a[r]);
      }
      return e;
    }
    function sourceCandidates(e) {
      if (l[e]) return [ l[e] ];
      return availableLabs();
    }
    function chooseInputLabs(e, r, a, t) {
      if (v) return false;
      if (r >= e.length) return t(a);
      var n = sourceCandidates(e[r]);
      if (e[r] === "X" && n.length > 1) {
        n.sort(function(e, r) {
          function adjacentChoices(e) {
            var r = 0;
            var a = availableLabs();
            for (var t = 0; t < a.length; t++) {
              if (a[t].id !== e.id && a[t].pos.inRangeTo(e, 1)) r++;
            }
            return r;
          }
          return adjacentChoices(r) - adjacentChoices(e);
        });
      }
      for (var o = 0; o < n.length; o++) {
        if (!takeSearchNode()) return false;
        var i = n[o];
        var u = false;
        for (var d = 0; d < a.length; d++) {
          if (a[d].id === i.id) {
            u = true;
            break;
          }
        }
        if (u) continue;
        var c = !!l[e[r]];
        if (!c) s[i.id] = true;
        a.push(i);
        if (chooseInputLabs(e, r + 1, a, t)) return true;
        a.pop();
        if (!c) delete s[i.id];
      }
      return false;
    }
    function chooseOutputs(e, r, a, t, n) {
      if (v) return false;
      var o = e.mode === "decompose" ? 2 : 1;
      if (a >= o) return n(t);
      var i = pipelineStageOutputResources(e);
      var u = availableLabs();
      var l = -1;
      var d = false;
      if (e.mode === "synthesis" && e.inputs) l = e.inputs.indexOf("X");
      if (l >= 0 && u.length > 1) {
        u.sort(function(e, a) {
          var t = e.pos.getRangeTo(r[l]);
          var n = a.pos.getRangeTo(r[l]);
          return t - n;
        });
        for (var c = 0; c < u.length; c++) {
          var p = u[c];
          if (p.pos.getRangeTo(r[l]) > 1 || !pipelineRangeValid(p, r.slice(0, e.mode === "decompose" ? 1 : r.length))) continue;
          var m = false;
          for (var g = 0; g < r.length; g++) {
            if (r[g].id === p.id) {
              m = true;
              break;
            }
          }
          if (!m && !s[p.id]) {
            d = true;
            break;
          }
        }
      }
      for (var f = 0; f < u.length; f++) {
        if (!takeSearchNode()) return false;
        var b = u[f];
        var h = false;
        for (var y = 0; y < r.length; y++) {
          if (r[y].id === b.id) {
            h = true;
            break;
          }
        }
        for (var k = 0; k < t.length; k++) {
          if (t[k].id === b.id) {
            h = true;
            break;
          }
        }
        if (h || !pipelineRangeValid(b, r.slice(0, e.mode === "decompose" ? 1 : r.length))) continue;
        if (d && b.pos.getRangeTo(r[l]) > 1) continue;
        s[b.id] = true;
        t.push({
          lab: b,
          resource: i[a]
        });
        if (chooseOutputs(e, r, a + 1, t, n)) return true;
        t.pop();
        delete s[b.id];
      }
      return false;
    }
    function placeStage(e) {
      if (!takeSearchNode()) return false;
      if (e >= r.stages.length) return true;
      var a = r.stages[e];
      var t = pipelineStageSourceResources(a);
      var n = false;
      chooseInputLabs(t, 0, [], function(r) {
        var o = [];
        if (!chooseOutputs(a, r, 0, o, function(o) {
          var i = {
            stageId: a.id,
            inputLabIds: r.map(function(e) {
              return e.id;
            }),
            inputResources: t.slice(),
            outputLabIds: o.map(function(e) {
              return e.lab.id;
            }),
            outputResources: o.map(function(e) {
              return e.resource;
            })
          };
          d.push(i);
          for (var u = 0; u < o.length; u++) {
            if (!l[o[u].resource]) {
              l[o[u].resource] = o[u].lab;
            }
          }
          if (placeStage(e + 1)) {
            n = true;
            return true;
          }
          for (var s = 0; s < o.length; s++) {
            if (l[o[s].resource] === o[s].lab) {
              delete l[o[s].resource];
            }
          }
          d.pop();
          return false;
        })) return true;
        return false;
      });
      return n;
    }
    if (!placeStage(0)) {
      return {
        ok: false,
        reason: m === "CPU budget" ? "pipeline lab layout search deferred by CPU budget" : m === "node limit" ? "pipeline lab layout search exceeded budget" : "no valid range-2 lab layout for pipeline"
      };
    }
    function assignSpareRootOutputLabs() {
      if (r.mode !== "synthesis") return;
      var e = null;
      for (var a = 0; a < r.stages.length; a++) {
        if (r.stages[a].product === r.root) {
          e = r.stages[a];
          break;
        }
      }
      if (!e) return;
      var t = null;
      for (var n = 0; n < d.length; n++) {
        if (d[n].stageId === e.id) {
          t = d[n];
          break;
        }
      }
      if (!t) return;
      var o = [];
      for (var u = 0; u < t.inputLabIds.length; u++) {
        var l = i[t.inputLabIds[u]];
        if (!l) return;
        o.push(l);
      }
      var c = e.inputs ? e.inputs.indexOf("X") : -1;
      var p = c >= 0 ? o[c] : null;
      var v = availableLabs();
      for (var m = 0; m < v.length; m++) {
        var g = v[m];
        if (s[g.id]) continue;
        if (!pipelineRangeValid(g, o)) continue;
        if (p && g.pos.getRangeTo(p) > 1) continue;
        s[g.id] = true;
        t.outputLabIds.push(g.id);
        t.outputResources.push(e.product);
      }
    }
    assignSpareRootOutputLabs();
    var g = {};
    for (var b = 0; b < d.length; b++) g[d[b].stageId] = d[b];
    return {
      ok: true,
      roomName: e.name,
      stages: d,
      stageMap: g,
      labIds: Object.keys(s),
      searchNodes: c
    };
  }
  function pipelineLayoutStage(e, r) {
    return e && e.stageMap ? e.stageMap[r] : null;
  }
  function pipelineStageDuration(e, r) {
    var t = pipelineLayoutStage(r, e.id);
    var n = e.mode === "decompose" ? 1 : t && t.outputLabIds ? t.outputLabIds.length : 1;
    return Math.ceil(e.amount / Math.max(1, a * n)) * pipelineReactionTime(e.product);
  }
  function estimatePipelineTicks(e, r) {
    if (!e || !r || !r.stageMap) return 0;
    var a = {};
    var t = 0;
    for (var n = 0; n < e.stages.length; n++) {
      var o = e.stages[n];
      var i = 0;
      if (e.mode === "synthesis") {
        var u = o.dependencies || [];
        for (var s = 0; s < u.length; s++) i = Math.max(i, a[u[s]] || 0);
      } else {
        for (var l = 0; l < e.stages.length; l++) {
          if (l === n) continue;
          if (pipelineStageOutputResources(e.stages[l]).indexOf(o.product) >= 0) {
            i = Math.max(i, a[e.stages[l].product] || 0);
          }
        }
      }
      a[o.product] = i + pipelineStageDuration(o, r);
      t = Math.max(t, a[o.product]);
    }
    var d = e.depth > 0 ? e.depth : 1;
    return t + d * 500 + 1e3;
  }
  function getUnreservedAmount(e, r) {
    var a = l.storageFind(e, r);
    if (!a) return 0;
    var t = 0;
    if (a.terminal) t += Math.max(0, (a.terminal.total || 0) - (a.terminal.reserved || 0));
    if (a.storage) t += Math.max(0, (a.storage.total || 0) - (a.storage.reserved || 0));
    return t;
  }
  function getProgramReservedAmount(e, r, a) {
    if (!a) return 0;
    var t = l.storageFind(e, r);
    if (!t) return 0;
    var n = 0;
    function addReservations(e) {
      var r = e && Array.isArray(e.reservations) ? e.reservations : [];
      for (var t = 0; t < r.length; t++) {
        if (r[t] && r[t].program === a) n += r[t].amount || 0;
      }
    }
    addReservations(t.terminal);
    addReservations(t.storage);
    return n;
  }
  function getAvailableForProductionOrder(e, r, a) {
    return getUnreservedAmount(e, r) + getProgramReservedAmount(e, r, a && a.reservationProgram);
  }
  function getSupplierCarriedAmount(e, r) {
    if (!e || !r) return 0;
    var a = 0;
    var t = d.creepIndex && d.creepIndex();
    var n = t && t.all ? t.all : [];
    for (var o = 0; o < n.length; o++) {
      var i = n[o];
      if (!i || !i.room || i.room.name !== e || !i.store || !i.memory || i.memory.role !== "supplier") continue;
      a += i.store[r] || 0;
    }
    return a;
  }
  function getProductionInputTarget(e, r) {
    if (!e || !e.groups || !r || r.type !== "production") return 0;
    var t = typeof r.remaining === "number" ? r.remaining : r.amount || 0;
    if (t <= 0) return 0;
    var n = 0;
    var o = 0;
    for (var i = 0; i < e.groups.length; i++) {
      var s = e.groups[i];
      for (var l = 0; l < s.outs.length; l++) {
        var d = s.outs[l];
        if (!d || !d.store) continue;
        o += d.store.getFreeCapacity(r.product) || 0;
        n += d.store[r.product] || 0;
      }
    }
    var c = Math.max(0, t - n);
    if (c <= 0) return 0;
    var p = Math.min(c, o);
    var v = Math.ceil(p / Math.max(1, e.groups.length));
    var m = Math.min(v, u);
    var g = m % a;
    if (g !== 0) {
      m += a - g;
    }
    return Math.min(m, u);
  }
  function getProductionInputLoadAge(e) {
    if (!e) return 0;
    if (!e.inputLoadStartedSince) e.inputLoadStartedSince = Game.time;
    return Game.time - e.inputLoadStartedSince;
  }
  function productionPartialStartAllowed(e) {
    return getProductionInputLoadAge(e) >= s;
  }
  function getProductionInputLoadState(e, r, a) {
    var t = {
      target: 0,
      totalLoaded: 0,
      reag1Available: 0,
      reag2Available: 0
    };
    if (!e || !r || !r.groups || !a || a.type !== "production") return t;
    t.target = getProductionInputTarget(r, a);
    if (t.target <= 0) return t;
    var n = 0;
    for (var o = 0; o < r.groups.length; o++) {
      var i = r.groups[o];
      var u = i.in1 && i.in1.mineralType === a.reag1 ? i.in1.mineralAmount || 0 : 0;
      var s = i.in2 && i.in2.mineralType === a.reag2 ? i.in2.mineralAmount || 0 : 0;
      n += u + s;
    }
    t.totalLoaded = n;
    t.reag1Available = getAvailableForProductionOrder(e.name, a.reag1, a);
    t.reag2Available = getAvailableForProductionOrder(e.name, a.reag2, a);
    getProductionInputLoadAge(a);
    return t;
  }
  function isMarketLabOrder(e) {
    return !!(e && (e.origin === "marketLab" || e.marketOpId));
  }
  function getMarketOperationOrder(e, r) {
    var a = getActiveOrder(e);
    if (!isMarketLabOrder(a)) return null;
    if (r && a.marketOpId !== r) return null;
    return snapshotOrder(a);
  }
  function getActiveOrder(e) {
    var r = Memory.labOrders && Memory.labOrders[e];
    return r ? snapshotOrder(r.active) : null;
  }
  function roomHasPendingOrder(e) {
    var r = Memory.labOrders && Memory.labOrders[e];
    return !!(r && (r.active || Array.isArray(r.queue) && r.queue.length > 0));
  }
  function productionInputsReady(e, r) {
    var t = getProductionInputTarget(e, r);
    if (t <= 0) return false;
    getProductionInputLoadAge(r);
    var n = true;
    var o = false;
    for (var i = 0; i < e.groups.length; i++) {
      var u = e.groups[i];
      var s = u.in1 && u.in1.mineralType === r.reag1 ? u.in1.mineralAmount || 0 : 0;
      var l = u.in2 && u.in2.mineralType === r.reag2 ? u.in2.mineralAmount || 0 : 0;
      if (s < t || l < t) n = false;
      if (s >= a && l >= a) o = true;
    }
    if (n) return true;
    if (isMarketLabOrder(r)) return o;
    return productionPartialStartAllowed(r) && o;
  }
  function getPipelineSupplierLabTasks(e, r) {
    var a = Game.rooms[e];
    if (!a || !a.terminal || !r || r.type !== "pipeline" || !Array.isArray(r.stages)) return [];
    var n = [];
    var o = {};
    var i = {};
    function emitUnload(e, t) {
      if (!e || !e.mineralType || (e.mineralAmount || 0) <= 0) return;
      var i = e.id + "|" + e.mineralType;
      if (o[i]) return;
      o[i] = true;
      var u = a.terminal.store.getFreeCapacity(e.mineralType) || 0;
      var s = Math.min(e.mineralAmount || 0, u);
      if (s <= 0) return;
      n.push({
        type: "lab_unload",
        taskId: "pipeline_unload:" + r.pipelineId + ":" + e.id + ":" + e.mineralType,
        targetId: a.terminal.id,
        amount: s,
        priority: 58,
        extra: "res=" + e.mineralType + ",lab=" + e.id + ",pipeline=" + r.pipelineId + ",reason=" + t
      });
    }
    function emitLoad(e, a, t, o, u) {
      if (!e || !a || !(t > 0)) return;
      var s = e.id + "|" + a;
      if (i[s]) return;
      i[s] = true;
      n.push({
        type: "lab_load",
        taskId: "pipeline_load:" + r.pipelineId + ":" + e.id + ":" + a,
        targetId: e.id,
        amount: t,
        priority: o || 57,
        extra: "res=" + a + ",lab=" + e.id + ",pipeline=" + r.pipelineId + (u ? ",record=1" : "") + (r.reservationProgram ? ",program=" + r.reservationProgram : "")
      });
    }
    var u = {};
    for (var s = 0; s < (r.layout && r.layout.labIds || []).length; s++) {
      u[r.layout.labIds[s]] = true;
    }
    for (var l = 0; l < r.stages.length; l++) {
      var d = r.stages[l];
      for (var c = 0; c < (d.inputLabIds || []).length; c++) u[d.inputLabIds[c]] = true;
      for (var p = 0; p < (d.outputLabIds || []).length; p++) u[d.outputLabIds[p]] = true;
    }
    if (r.needsPreEvacuation || r.evacuating) {
      for (var v in u) emitUnload(Game.getObjectById(v), r.needsPreEvacuation ? "pre-evacuation" : "pipeline-complete");
      return n;
    }
    for (var m = 0; m < r.stages.length; m++) {
      var g = r.stages[m];
      if ((g.produced || 0) >= (g.amount || 0)) continue;
      var f = g.inputResources || (g.mode === "decompose" ? [ g.product ] : g.inputs);
      for (var b = 0; b < f.length; b++) {
        var h = f[b];
        var y = Game.getObjectById((g.inputLabIds || [])[b]);
        if (!y || !h) continue;
        if (y.mineralType && y.mineralType !== h) {
          emitUnload(y, "wrong pipeline input");
          continue;
        }
        if (!r.inputRequirements || !(r.inputRequirements[h] > 0)) continue;
        var k = y.mineralType === h ? y.mineralAmount || 0 : 0;
        var L = y.store.getFreeCapacity(h) || 0;
        var O = Math.min(g.amount || t, t);
        if (k < O && L > 0) emitLoad(y, h, Math.min(O - k, L), 57, false);
      }
      var R = g.outputResources || pipelineStageOutputResources(g);
      for (var I = 0; I < (g.outputLabIds || []).length; I++) {
        var P = Game.getObjectById(g.outputLabIds[I]);
        var M = R[I];
        if (P && P.mineralType && P.mineralType !== M) {
          emitUnload(P, "wrong pipeline output");
        }
      }
    }
    return n;
  }
  function getSupplierLabTasks(e) {
    var r = Memory.labOrders && Memory.labOrders[e];
    if (!r || !r.active) return [];
    if (r.active.type === "pipeline") return getPipelineSupplierLabTasks(e, r.active);
    var t = Game.rooms[e];
    if (!t || !t.terminal) return [];
    var n = r.active;
    var o = [];
    function emitCleanupUnload(e) {
      if (!e || !e.mineralType || (e.mineralAmount || 0) <= 0) return;
      var r = Math.min(e.mineralAmount || 0, t.terminal.store.getFreeCapacity(e.mineralType) || 0);
      if (r <= 0) return;
      o.push({
        type: "lab_unload",
        taskId: "lab_unload:" + e.id + ":" + e.mineralType,
        targetId: t.terminal.id,
        amount: r,
        priority: 55,
        extra: "res=" + e.mineralType + ",lab=" + e.id + ",reason=cleanup"
      });
    }
    if (n.type === "cleanup") {
      var i = _getLabs(t);
      for (var s = 0; s < i.length; s++) {
        emitCleanupUnload(i[s]);
      }
      return o;
    }
    if (!isMarketLabOrder(n)) return [];
    if (n.type !== "production" && n.type !== "breakdown") return [];
    var l = n.type === "breakdown";
    var d = l ? getBreakdownLayout(t) : getLayout(t);
    if (!d || !d.groups || d.groups.length === 0) return [];
    function emitLabUnload(e, r) {
      if (!e || !e.mineralType || (e.mineralAmount || 0) <= 0) return;
      var a = Math.min(e.mineralAmount || 0, t.terminal.store.getFreeCapacity(e.mineralType) || 0);
      if (a <= 0) return;
      o.push({
        type: "lab_unload",
        taskId: "lab_unload:" + e.id + ":" + e.mineralType,
        targetId: t.terminal.id,
        amount: a,
        priority: 55,
        extra: "res=" + e.mineralType + ",lab=" + e.id + ",reason=" + r
      });
    }
    if (n.evacuating || n.needsPreEvacuation) {
      for (var c = 0; c < d.groups.length; c++) {
        var p = d.groups[c];
        if (!p) continue;
        emitLabUnload(p.in1, "evacuate");
        emitLabUnload(p.in2, "evacuate");
        for (var v = 0; v < p.outs.length; v++) {
          emitLabUnload(p.outs[v], "evacuate");
        }
      }
      return o;
    }
    if (l) {
      for (var m = 0; m < d.groups.length; m++) {
        var g = d.groups[m];
        if (!g) continue;
        if (g.in1 && g.in1.mineralType && g.in1.mineralType !== n.reag1) {
          emitLabUnload(g.in1, "wrong");
        }
        if (g.in2 && g.in2.mineralType && g.in2.mineralType !== n.reag2) {
          emitLabUnload(g.in2, "wrong");
        }
      }
      for (var f = 0; f < d.groups.length; f++) {
        var b = d.groups[f];
        if (!b) continue;
        var h = b.in1 && b.in1.mineralType === n.reag1;
        var y = b.in2 && b.in2.mineralType === n.reag2;
        if (h && (b.in1.mineralAmount || 0) >= a) {
          var k = b.in1.store.getFreeCapacity(n.reag1) || 0;
          if (k < a) emitLabUnload(b.in1, "full");
        }
        if (y && (b.in2.mineralAmount || 0) >= a) {
          var L = b.in2.store.getFreeCapacity(n.reag2) || 0;
          if (L < a) emitLabUnload(b.in2, "full");
        }
      }
      var O = getAvailableForProductionOrder(e, n.compound, n);
      var R = typeof n.remaining === "number" ? n.remaining : n.amount || 0;
      if (O > 0 && R > 0) {
        var I = [];
        for (var P = 0; P < d.groups.length; P++) {
          var M = d.groups[P];
          if (!M || !M.outs) continue;
          for (var T = 0; T < M.outs.length; T++) {
            var S = M.outs[T];
            if (!S || !S.store) continue;
            if (S.mineralType && S.mineralType !== n.compound) {
              emitLabUnload(S, "wrong");
              continue;
            }
            var A = S.mineralType === n.compound ? S.mineralAmount || 0 : 0;
            var C = S.store.getFreeCapacity(n.compound) || 0;
            if (C < a) continue;
            I.push({
              lab: S,
              free: C,
              have: A,
              amount: 0
            });
          }
        }
        var w = Math.min(R, O, u);
        w -= w % a;
        while (w >= a) {
          var G = null;
          for (var q = 0; q < I.length; q++) {
            var N = I[q];
            if (N.free - N.amount < a) continue;
            if (!G || N.have + N.amount < G.have + G.amount || N.have + N.amount === G.have + G.amount && N.lab.id < G.lab.id) {
              G = N;
            }
          }
          if (!G) break;
          G.amount += a;
          w -= a;
        }
        I.sort(function(e, r) {
          return r.amount - e.amount;
        });
        for (var E = 0; E < I.length; E++) {
          var B = I[E];
          var j = B.amount;
          if (j <= 0) continue;
          var _ = 56 - Math.min(j, u) / 1e5;
          o.push({
            type: "lab_load",
            taskId: "lab_load:" + n.created + ":" + B.lab.id + ":" + n.compound,
            targetId: B.lab.id,
            amount: j,
            priority: _,
            extra: "res=" + n.compound + ",lab=" + B.lab.id + ",target=" + (B.have + j) + ",need=" + j + ",record=1" + (n.reservationProgram ? ",program=" + n.reservationProgram : "")
          });
        }
      }
      return o;
    }
    var x = getProductionInputLoadState(t, d, n);
    var D = [];
    for (var U = 0; U < d.groups.length; U++) {
      var F = d.groups[U];
      var k = F.in1 && F.in1.store ? F.in1.store.getFreeCapacity(n.reag1) || 0 : 0;
      var L = F.in2 && F.in2.store ? F.in2.store.getFreeCapacity(n.reag2) || 0 : 0;
      var X = F.in1 && F.in1.mineralType === n.reag1 ? F.in1.mineralAmount || 0 : 0;
      var K = F.in2 && F.in2.mineralType === n.reag2 ? F.in2.mineralAmount || 0 : 0;
      if (F.in1 && X < x.target && x.reag1Available > 0 && k > 0) {
        D.push({
          lab: F.in1,
          reagent: n.reag1,
          deficit: x.target - X,
          free: k
        });
      }
      if (F.in2 && K < x.target && x.reag2Available > 0 && L > 0) {
        D.push({
          lab: F.in2,
          reagent: n.reag2,
          deficit: x.target - K,
          free: L
        });
      }
    }
    D.sort(function(e, r) {
      return r.deficit - e.deficit;
    });
    var V = {};
    V[n.reag1] = x.reag1Available;
    V[n.reag2] = x.reag2Available;
    for (var W = 0; W < D.length; W++) {
      var B = D[W];
      var H = V[B.reagent] || 0;
      var j = Math.min(B.deficit, B.free, H);
      if (j <= 0) continue;
      var Y = 56 - Math.min(B.deficit, u) / 1e5;
      o.push({
        type: "lab_load",
        taskId: "lab_load:" + n.created + ":" + B.lab.id + ":" + B.reagent,
        targetId: B.lab.id,
        amount: j,
        priority: Y,
        extra: "res=" + B.reagent + ",lab=" + B.lab.id + ",target=" + x.target + ",need=" + B.deficit + (n.reservationProgram ? ",program=" + n.reservationProgram : "")
      });
      V[B.reagent] = H - j;
    }
    return o;
  }
  function findDirectReagents(e) {
    for (var r in REACTIONS) {
      var a = REACTIONS[r];
      for (var t in a) {
        if (a[t] === e) {
          return {
            a: r,
            b: t
          };
        }
      }
    }
    return null;
  }
  function buildReactionChain(e, r) {
    var a = [];
    var t = new Set;
    function addToChain(e) {
      if (t.has(e)) return;
      t.add(e);
      var n = findDirectReagents(e);
      if (!n) return;
      var o = r.storage;
      var i = r.terminal;
      var u = true;
      var s = true;
      if (o || i) {
        var l = (o && o.store[n.a] || 0) + (i && i.store[n.a] || 0);
        var d = (o && o.store[n.b] || 0) + (i && i.store[n.b] || 0);
        u = l < 1e3;
        s = d < 1e3;
      }
      if (u) addToChain(n.a);
      if (s) addToChain(n.b);
      a.push({
        product: e,
        reag1: n.a,
        reag2: n.b,
        priority: a.length
      });
    }
    addToChain(e);
    return a.reverse();
  }
  function markBroken(e, r, a) {
    r.broken = true;
    r.evacuating = true;
    r.needsPreEvacuation = false;
    console.log("[Labs] Order BROKEN in " + e + " (" + a + ") — evacuating labs and selling associated resources.");
  }
  function resourceNeededByQueue(e, r, a) {
    if (!e.queue) return false;
    for (var t = 0; t < e.queue.length; t++) {
      var n = e.queue[t];
      if (n === a) continue;
      if (n.reag1 === r || n.reag2 === r || n.product === r || n.compound === r) return true;
    }
    return false;
  }
  function resourceOwnedByMarketOp(e, r) {
    var a = require("marketLab");
    var t = a && typeof a.getRoomOperations === "function" ? a.getRoomOperations(e) : [];
    for (var n = 0; n < t.length; n++) {
      var o = t[n];
      if (!o) continue;
      if (o.targetCompound === r) return true;
      if (o.reagents && (o.reagents[0] === r || o.reagents[1] === r)) return true;
    }
    return false;
  }
  function hasRecentMarketSellRequest(e, r, a) {
    var t = require("marketSell");
    var n = t && typeof t.getRequests === "function" ? t.getRequests() : [];
    for (var o = n.length - 1; o >= 0; o--) {
      var i = n[o];
      if (!i) continue;
      if (i.roomName !== e) continue;
      if (i.resourceType !== r) continue;
      if (i.amount !== a) continue;
      if (i.created !== Game.time) continue;
      return true;
    }
    return false;
  }
  function sellBrokenOrderResources(e, r, a) {
    if (a && a.stockpile) return;
    var t = Game.rooms[r];
    if (!t || !t.terminal) return;
    var n = a.type === "breakdown" ? [ a.compound, a.reag1, a.reag2 ] : [ a.product, a.reag1, a.reag2 ];
    var o = {};
    for (var i = 0; i < n.length; i++) {
      var u = n[i];
      if (!u || u === RESOURCE_ENERGY || o[u]) continue;
      o[u] = true;
      if (resourceNeededByQueue(e, u, a)) continue;
      if (resourceOwnedByMarketOp(r, u)) continue;
      var s = t.terminal.store[u] || 0;
      if (s > 0) {
        console.log("[Labs] Broken order — selling " + s + " " + u + " in " + r);
        if (m.isTwoLetterLabProduct(u)) {
          g.enqueue(r, u, s, "broken lab order cleanup");
          if (v2Enabled(r) && a.reservationProgram) {
            l.unReserve(r, u, "terminal", a.reservationProgram);
            l.unReserve(r, u, "storage", a.reservationProgram);
          }
        } else if (typeof global.marketSell === "function") {
          global.marketSell(r, u, s);
        }
        if (v2Enabled(r) && a.reservationProgram && hasRecentMarketSellRequest(r, u, s)) {
          l.unReserve(r, u, "terminal", a.reservationProgram);
          l.unReserve(r, u, "storage", a.reservationProgram);
        }
      }
    }
  }
  function reservePipelineLeaves(e, r, a) {
    var t = [];
    for (var n in r) {
      if (!Object.prototype.hasOwnProperty.call(r, n)) continue;
      var o = r[n] || 0;
      if (!(o > 0)) continue;
      var i = l.storageFind(e, n);
      if (!i || !i.terminal || !i.storage) {
        for (var u = 0; u < t.length; u++) {
          l.unReserve(e, t[u].resource, t[u].building, a);
        }
        return {
          ok: false,
          reason: "missing storage accounting for " + n
        };
      }
      var s = Math.max(0, (i.terminal.total || 0) - (i.terminal.reserved || 0));
      var d = Math.max(0, (i.storage.total || 0) - (i.storage.reserved || 0));
      if (s + d < o) {
        for (var c = 0; c < t.length; c++) {
          l.unReserve(e, t[c].resource, t[c].building, a);
        }
        return {
          ok: false,
          reason: "insufficient unreserved " + n
        };
      }
      var p = Math.min(o, s);
      var v = o - p;
      if (p > 0 && !l.reserve(e, n, "terminal", a, p).ok) {
        for (var m = 0; m < t.length; m++) {
          l.unReserve(e, t[m].resource, t[m].building, a);
        }
        return {
          ok: false,
          reason: "terminal reservation failed for " + n
        };
      }
      if (p > 0) t.push({
        resource: n,
        building: "terminal"
      });
      if (v > 0 && !l.reserve(e, n, "storage", a, v).ok) {
        l.unReserve(e, n, "terminal", a);
        for (var g = 0; g < t.length; g++) {
          l.unReserve(e, t[g].resource, t[g].building, a);
        }
        return {
          ok: false,
          reason: "storage reservation failed for " + n
        };
      }
      if (v > 0) t.push({
        resource: n,
        building: "storage"
      });
    }
    return {
      ok: true
    };
  }
  function pipelineStageFromOrder(e, r) {
    if (!e || !Array.isArray(e.stages)) return null;
    for (var a = 0; a < e.stages.length; a++) {
      if (e.stages[a] && e.stages[a].id === r) return e.stages[a];
    }
    return null;
  }
  function pipelineStageObjects(e) {
    var r = [];
    var a = [];
    for (var t = 0; t < (e.inputLabIds || []).length; t++) {
      var n = Game.getObjectById(e.inputLabIds[t]);
      if (n) r.push(n);
    }
    for (var o = 0; o < (e.outputLabIds || []).length; o++) {
      var i = Game.getObjectById(e.outputLabIds[o]);
      if (i) a.push(i);
    }
    return {
      inputs: r,
      outputs: a
    };
  }
  function pipelineStageProducedAmount(e, r) {
    if (!e || !r) return 0;
    var a = 0;
    var t = e.mode === "decompose" ? e.outputs || [] : [ e.product ];
    for (var n = 0; n < r.outputs.length; n++) {
      var o = r.outputs[n];
      for (var i = 0; i < t.length; i++) {
        if (o.mineralType === t[i]) a += o.mineralAmount || 0;
      }
    }
    return a;
  }
  function pipelineStageReady(e, r) {
    var t = e && e.mode === "decompose" ? 1 : 2;
    if (!e || !r || r.inputs.length !== t) return false;
    if (e.mode === "decompose") {
      if (r.outputs.length !== 2) return false;
    } else if (r.outputs.length < 1) return false;
    if (e.produced >= e.amount) return false;
    var n = e.mode === "decompose" ? e.outputs : [ e.product ];
    if (!n) return false;
    if (e.mode === "decompose" && r.outputs.length !== n.length) return false;
    var o = 0;
    for (var i = 0; i < r.outputs.length; i++) {
      var u = r.outputs[i];
      var s = e.mode === "decompose" ? n[i] : e.product;
      if (!u || u.mineralType && u.mineralType !== s) return false;
      var l = u.cooldown === 0 && (u.store.getFreeCapacity() || 0) >= a;
      if (e.mode === "decompose" && !l) return false;
      if (l) o++;
    }
    if (o < 1) return false;
    if (e.mode === "decompose") {
      var d = r.inputs[0];
      return d.mineralType === e.product && (d.mineralAmount || 0) >= a;
    }
    var c = r.inputs[0];
    var p = r.inputs[1];
    return c.mineralType === e.inputs[0] && p.mineralType === e.inputs[1] && (c.mineralAmount || 0) >= a && (p.mineralAmount || 0) >= a;
  }
  function pipelineRecordReaction(e, r, a) {
    r.produced = Math.min(r.amount, (r.produced || 0) + a);
    r.lastReactionTick = Game.time;
    r.lastProgressTick = Game.time;
    e.lastProgressTick = Game.time;
    e.lastReactionTick = Game.time;
    if (!e.jobId) return;
    try {
      var t = {};
      if (r.mode === "decompose") {
        t[r.product] = a;
        require("marketEconomics").recordProduction(e.jobId, r.outputs[0], a, t);
        require("marketEconomics").recordProduction(e.jobId, r.outputs[1], a, null);
      } else {
        t[r.inputs[0]] = a;
        t[r.inputs[1]] = a;
        require("marketEconomics").recordProduction(e.jobId, r.product, a, t);
      }
    } catch (e) {}
  }
  function runPipelineStage(e, r, t) {
    var n = pipelineStageObjects(t);
    if (!pipelineStageReady(t, n)) return false;
    var o = false;
    if (t.mode === "decompose") {
      var i = n.inputs[0];
      var u = i.reverseReaction(n.outputs[0], n.outputs[1]);
      if (u === OK) {
        pipelineRecordReaction(r, t, a);
        o = true;
      }
      return o;
    }
    for (var s = 0; s < n.outputs.length; s++) {
      var l = n.outputs[s];
      if (l.cooldown > 0 || (l.store.getFreeCapacity() || 0) < a) continue;
      var d = n.inputs[0];
      var c = n.inputs[1];
      if (d.mineralType !== t.inputs[0] || c.mineralType !== t.inputs[1] || (d.mineralAmount || 0) < a || (c.mineralAmount || 0) < a) continue;
      var p = l.runReaction(d, c);
      if (p !== OK) p = l.runReaction(c, d);
      if (p === OK) {
        pipelineRecordReaction(r, t, a);
        o = true;
      }
      if (t.produced >= t.amount) break;
    }
    return o;
  }
  function pipelineAllStagesProduced(e) {
    if (!e || !Array.isArray(e.stages)) return false;
    for (var r = 0; r < e.stages.length; r++) {
      if ((e.stages[r].produced || 0) < (e.stages[r].amount || 0)) return false;
    }
    return true;
  }
  function pipelineLabsEmpty(e) {
    var r = {};
    for (var a = 0; a < (e.layout && e.layout.labIds || []).length; a++) r[e.layout.labIds[a]] = true;
    for (var t = 0; t < (e.stages || []).length; t++) {
      var n = e.stages[t];
      for (var o = 0; o < (n.inputLabIds || []).length; o++) r[n.inputLabIds[o]] = true;
      for (var i = 0; i < (n.outputLabIds || []).length; i++) r[n.outputLabIds[i]] = true;
    }
    for (var u in r) {
      var s = Game.getObjectById(u);
      if (s && (s.mineralAmount || 0) > 0) return false;
    }
    return true;
  }
  function markPipelineBroken(e, r, a) {
    if (r.broken) return;
    r.broken = true;
    r.evacuating = true;
    r.pipelineFailureReason = a;
    r.lastProgressTick = Game.time;
    console.log("[Labs] Pipeline BROKEN in " + e + " (" + a + ") — evacuating pipeline labs.");
  }
  function recordPipelineOutcome(e, r, a) {
    if (!e || !e.pipelineId) return;
    if (!Memory.labPipelineOutcomes || typeof Memory.labPipelineOutcomes !== "object") {
      Memory.labPipelineOutcomes = {};
    }
    var t = {};
    for (var n = 0; n < (e.stages || []).length; n++) {
      var o = e.stages[n];
      t[o.id] = o.produced || 0;
    }
    Memory.labPipelineOutcomes[e.pipelineId] = {
      status: r,
      reason: a || null,
      roomName: e.room,
      mode: e.mode,
      root: e.root,
      amount: e.amount,
      produced: t,
      tick: Game.time
    };
    var i = Object.keys(Memory.labPipelineOutcomes);
    if (i.length > 50) {
      i.sort(function(e, r) {
        return (Memory.labPipelineOutcomes[e].tick || 0) - (Memory.labPipelineOutcomes[r].tick || 0);
      });
      while (i.length > 50) delete Memory.labPipelineOutcomes[i.shift()];
    }
    if (v && typeof v.requestSave === "function") v.requestSave();
  }
  function getPipelineOutcome(e) {
    if (!e || !Memory.labPipelineOutcomes || !Memory.labPipelineOutcomes[e]) return null;
    var r = Memory.labPipelineOutcomes[e];
    var a = {};
    for (var t in r) {
      if (Object.prototype.hasOwnProperty.call(r, t)) a[t] = r[t];
    }
    return a;
  }
  function maybeCompletePipelineOrder(e) {
    var r = ensureRoomOrders(e);
    var a = r.active;
    if (!a || a.type !== "pipeline") return;
    var t = Game.rooms[e];
    if (!t) return;
    if (!a.processingSince) a.processingSince = Game.time;
    if (!a.lastProgressTick) a.lastProgressTick = a.processingSince;
    var n = Game.time - a.processingSince;
    if (!a.warned && n >= o) {
      a.warned = true;
      console.log("[Labs] Pipeline warning in " + e + ": processing age " + n + " ticks.");
    }
    if (!a.broken && n > (a.pipelineDeadline || i)) {
      markPipelineBroken(e, a, "pipeline deadline exceeded");
    }
    if (!a.broken && pipelineAllStagesProduced(a)) a.evacuating = true;
    if (!a.evacuating || !pipelineLabsEmpty(a)) return;
    if (a.broken) sellBrokenOrderResources(r, e, a);
    recordPipelineOutcome(a, a.cancelled ? "cancelled" : a.broken ? "failed" : "completed", a.pipelineFailureReason || null);
    releaseOrderReservations(a);
    r.active = null;
    clearRoomCache(e);
    if (r.queue.length > 0) {
      r.active = r.queue.shift();
      r.active.needsPreEvacuation = true;
      r.active.processingSince = Game.time;
    }
  }
  function runPipeline(e, r) {
    if (!r || r.type !== "pipeline") return;
    if (r.needsPreEvacuation) {
      if (checkLabsClear(e, null, r)) {
        r.needsPreEvacuation = false;
        r.processingSince = Game.time;
        r.lastProgressTick = Game.time;
      }
      return;
    }
    if (r.evacuating) return;
    var a = false;
    for (var t = 0; t < r.stages.length; t++) {
      if (runPipelineStage(e, r, r.stages[t])) a = true;
    }
    if (!a) {
      r.lastBlockedReason = "waiting for inputs, energy, cooldown, or output space";
    } else {
      delete r.lastBlockedReason;
    }
  }
  function startPipelineOrder(e, r, a) {
    a = a || {};
    var t = Game.rooms[e];
    if (!t) return {
      ok: false,
      msg: "[Labs] No vision in room " + e
    };
    if (!r || !r.ok) return {
      ok: false,
      msg: "[Labs] Invalid reaction pipeline"
    };
    var n = f.validatePlan(r);
    if (!n.ok) return {
      ok: false,
      msg: "[Labs] " + n.errors.join("; ")
    };
    var o = _getLabs(t);
    if (r.requiresAdvancedRoom) {
      var u = f.roomSupportsAdvanced(t, o);
      if (!u.ok) return {
        ok: false,
        msg: "[Labs] " + u.reason
      };
    }
    var s = computePipelineLayout(t, r);
    if (!s.ok) return {
      ok: false,
      msg: "[Labs] " + s.reason
    };
    var l = ensureRoomOrders(e);
    if (l.active || l.queue && l.queue.length > 0) {
      return {
        ok: false,
        msg: "[Labs] Room " + e + " has a pending lab order; pipeline room lock is not available"
      };
    }
    var d = a.pipelineId || "labPipeline_" + e + "_" + Game.time + "_" + Math.random().toString(36).substr(2, 6);
    var c = a.reservationProgram || d;
    var p = {};
    if (r.mode === "decompose") {
      p[r.root] = r.amount;
    } else {
      for (var v in r.leaves) {
        if (Object.prototype.hasOwnProperty.call(r.leaves, v)) p[v] = r.leaves[v];
      }
    }
    var m = [];
    for (var g in p) {
      if (Object.prototype.hasOwnProperty.call(p, g)) {
        m.push({
          reagent: g,
          amount: p[g]
        });
      }
    }
    var b = reservePipelineLeaves(e, p, c);
    if (!b.ok) return {
      ok: false,
      msg: "[Labs] " + b.reason
    };
    var h = [];
    for (var y = 0; y < r.stages.length; y++) {
      var k = r.stages[y];
      var L = pipelineLayoutStage(s, k.id);
      if (!L) {
        releaseOrderReservations({
          room: e,
          reservationProgram: c,
          leafReagents: m
        });
        return {
          ok: false,
          msg: "[Labs] Missing layout assignment for " + k.id
        };
      }
      var O = {};
      for (var R in k) O[R] = k[R];
      O.inputLabIds = L.inputLabIds.slice();
      O.inputResources = L.inputResources.slice();
      O.outputLabIds = L.outputLabIds.slice();
      O.outputResources = L.outputResources.slice();
      O.produced = 0;
      O.lastProgressTick = Game.time;
      O.lastReactionTick = 0;
      h.push(O);
    }
    var I = f.normalizeAmount(r.amount) > 0 ? estimatePipelineTicks(r, s) : i;
    var P = Math.max(1e4, I * 2);
    if (P > i) {
      releaseOrderReservations({
        room: e,
        reservationProgram: c,
        leafReagents: m
      });
      return {
        ok: false,
        msg: "[Labs] Pipeline estimate exceeds " + i + " ticks"
      };
    }
    var M = {
      room: e,
      type: "pipeline",
      mode: r.mode,
      origin: a.origin || null,
      sink: a.sink || "terminal",
      stockpile: !!a.stockpile,
      marketOpId: a.marketOpId || null,
      jobId: a.jobId || null,
      pipelineId: d,
      root: r.root,
      amount: r.amount,
      remaining: r.amount,
      inputRequirements: p,
      leaves: r.leaves,
      finalOutputs: r.finalOutputs,
      stages: h,
      layout: {
        labIds: s.labIds.slice(),
        stages: s.stages.slice(),
        stageMap: s.stageMap
      },
      reservationProgram: c,
      leafReagents: m,
      created: Game.time,
      needsPreEvacuation: true,
      processingSince: Game.time,
      lastProgressTick: Game.time,
      pipelineEstimatedTicks: I,
      pipelineDeadline: P
    };
    clearRoomCache(e);
    if (!l.active) {
      l.active = M;
      return {
        ok: true,
        started: true,
        order: M,
        msg: "[Labs] Started full " + r.mode + " pipeline for " + r.root + " x" + r.amount
      };
    }
    l.queue.push(M);
    return {
      ok: true,
      started: false,
      order: M,
      msg: "[Labs] Queued full " + r.mode + " pipeline for " + r.root + " x" + r.amount
    };
  }
  function cancelPipelineOrder(e, r, a) {
    var t = ensureRoomOrders(e);
    var n = t.active;
    if (n && n.type === "pipeline" && n.pipelineId === r) {
      n.cancelled = true;
      n.pipelineFailureReason = a || "pipeline cancelled";
      n.needsPreEvacuation = false;
      n.evacuating = true;
      return {
        ok: true,
        active: true
      };
    }
    for (var o = t.queue.length - 1; o >= 0; o--) {
      var i = t.queue[o];
      if (!i || i.type !== "pipeline" || i.pipelineId !== r) continue;
      releaseOrderReservations(i);
      t.queue.splice(o, 1);
      clearRoomCache(e);
      return {
        ok: true,
        active: false
      };
    }
    return {
      ok: false,
      reason: "pipeline order not found"
    };
  }
  function startOrder(e, r, a, t) {
    t = t || {};
    var n = ensureRoomOrders(e);
    var o = Game.rooms[e];
    if (!o) {
      return {
        ok: false,
        msg: "[Labs] No vision in room " + e
      };
    }
    var layout = getLayout(o);
    if (!layout || !Array.isArray(layout.groups) || layout.groups.length === 0) {
      return {
        ok: false,
        msg: "[Labs] No valid lab layout in " + e
      };
    }
    var i = t.direct ? findDirectReagents(r) : null;
    var u = i ? [ {
      product: r,
      reag1: i.a,
      reag2: i.b,
      priority: 0
    } ] : buildReactionChain(r, o);
    if (u.length === 0) {
      return {
        ok: false,
        msg: "[Labs] Cannot produce " + r + " - no reaction found"
      };
    }
    var s = r.indexOf("X") >= 0;
    for (var d = 0; d < u.length; d++) {
      if (u[d].reag1 === "X" || u[d].reag2 === "X") s = true;
    }
    if (s) {
      var c = f.roomSupportsAdvanced(o, _getLabs(o));
      if (!c.ok) return {
        ok: false,
        msg: "[Labs] " + c.reason
      };
    }
      var p = null;
      var v = null;
      var claimedHandoffReservations = [];
      if (v2Enabled(e)) {
      p = computeLeafReagents(u, r, a);
      v = "labManager_" + r + "_" + Game.time + "_" + Math.random().toString(36).substr(2, 6);
      var m = true;
      var g = [];
      for (var b = 0; b < p.length; b++) {
        var h = p[b].reagent;
        var y = p[b].amount;
        if (t.stockpile) {
          var handoffProgram = t.handoffInputPrograms && t.handoffInputPrograms[h] || null;
          var claim = function(building) {
            if (!handoffProgram) return 0;
            var info = l.storageFind(e, h);
            var reservations = info && info[building] && info[building].reservations || [];
            var remaining = y;
            for (var index = reservations.length - 1; index >= 0 && remaining > 0; index--) {
              var reservation = reservations[index];
              if (!reservation || reservation.program !== handoffProgram) continue;
              var claimed = l.transfer(e, h, building, reservation.program, v, Math.min(remaining, reservation.amount || 0));
              if (claimed && claimed.ok && claimed.transferred > 0) {
                claimedHandoffReservations.push({
                  resource: h,
                  building: building,
                  program: reservation.program,
                  amount: claimed.transferred
                });
                remaining -= claimed.transferred;
              }
            }
            return y - remaining;
          };
          if (handoffProgram) {
            claim("terminal");
            claim("storage");
          }
        }
        var k = l.storageFind(e, h);
        var own = function(building) {
          var reservations = k && k[building] && k[building].reservations || [];
          var amount = 0;
          for (var index = 0; index < reservations.length; index++) {
            if (reservations[index] && reservations[index].program === v) amount += reservations[index].amount || 0;
          }
          return amount;
        };
        var terminalOwn = own("terminal");
        var storageOwn = own("storage");
        var L = Math.max(0, k.terminal.total - k.terminal.reserved + terminalOwn);
        var O = Math.max(0, k.storage.total - k.storage.reserved + storageOwn);
        if (L + O < y) {
          m = false;
          break;
        }
        var R = Math.min(y, L);
        var I = y - R;
        if (R > 0) {
          var P = l.reserve(e, h, "terminal", v, R);
          g.push({
            r: h,
            b: "terminal"
          });
          if (!P.ok) {
            m = false;
            break;
          }
        } else {
          l.unReserve(e, h, "terminal", v);
        }
        if (I > 0) {
          var M = l.reserve(e, h, "storage", v, I);
          g.push({
            r: h,
            b: "storage"
          });
          if (!M.ok) {
            m = false;
            break;
          }
        } else {
          l.unReserve(e, h, "storage", v);
        }
      }
      if (!m) {
        for (var U = claimedHandoffReservations.length - 1; U >= 0; U--) {
          var claimedReservation = claimedHandoffReservations[U];
          l.transfer(e, claimedReservation.resource, claimedReservation.building, v, claimedReservation.program, claimedReservation.amount);
        }
        for (var T = 0; T < g.length; T++) {
          l.unReserve(e, g[T].r, g[T].b, v);
        }
        return {
          ok: false,
          msg: "[Labs] Insufficient unreserved leaf reagents in " + e + " for " + r
        };
      }
    }
    var S = [];
    for (var A = 0; A < u.length; A++) {
      var C = u[A];
      var w = C.product === r ? a : Math.ceil(a * 1.2);
      var G = {
        room: e,
        type: "production",
        origin: t.origin || null,
        sink: t.sink || "storage",
        stockpile: !!t.stockpile,
        marketOpId: t.marketOpId || null,
        jobId: t.jobId || null,
        product: C.product,
        amount: w,
        remaining: w,
        reag1: C.reag1,
        reag2: C.reag2,
        created: Game.time,
        priority: C.priority,
        needsPreEvacuation: A === 0
      };
      if (v) {
        G.reservationProgram = v;
        G.leafReagents = p;
      }
      S.push(G);
    }
    clearRoomCache(e);
    if (!n.active) {
      n.active = S.shift();
      n.active.needsPreEvacuation = true;
      n.active.processingSince = Game.time;
      n.queue = S;
      return {
        ok: true,
        msg: "[Labs] Started reaction chain for " + r + " x" + a + " (" + (S.length + 1) + " steps)"
      };
    } else {
      n.queue = n.queue.concat(S);
      return {
        ok: true,
        msg: "[Labs] Queued reaction chain for " + r + " x" + a + " (" + S.length + " steps)"
      };
    }
  }
  function startBreakdownOrder(e, r, a, t) {
    t = t || {};
    var n = ensureRoomOrders(e);
    var o = Game.rooms[e];
    if (!o) {
      return {
        ok: false,
        msg: "[Labs] No vision in room " + e
      };
    }
    var i = findDirectReagents(r);
    if (!i) {
      return {
        ok: false,
        msg: "[Labs] Cannot break down " + r + " - not a compound (base mineral?)"
      };
    }
    if (r.indexOf("X") >= 0 || i.a === "X" || i.b === "X") {
      var u = f.roomSupportsAdvanced(o, _getLabs(o));
      if (!u.ok) return {
        ok: false,
        msg: "[Labs] " + u.reason
      };
    }
    var s = o.storage;
    var d = o.terminal;
    var c = (s && s.store[r] || 0) + (d && d.store[r] || 0);
    if (c < a) {
      debugLog("[Labs] Warning: Only " + c + " " + r + " available, requested " + a);
    }
    var p = null;
    if (v2Enabled(e)) {
      p = "labManager_" + r + "_" + Game.time + "_" + Math.random().toString(36).substr(2, 6);
      var v = l.storageFind(e, r);
      var m = v.terminal.total - v.terminal.reserved;
      var g = v.storage.total - v.storage.reserved;
      if (m + g < a) {
        return {
          ok: false,
          msg: "[Labs] Insufficient unreserved " + r + " in " + e + " for breakdown"
        };
      }
      var b = Math.min(a, m);
      var h = a - b;
      var y = false;
      if (b > 0) {
        var k = l.reserve(e, r, "terminal", p, b);
        if (!k.ok) y = true;
      }
      if (h > 0 && !y) {
        var L = l.reserve(e, r, "storage", p, h);
        if (!L.ok) y = true;
      }
      if (y) {
        l.unReserve(e, r, "terminal", p);
        l.unReserve(e, r, "storage", p);
        return {
          ok: false,
          msg: "[Labs] Reserve failed for " + r + " in " + e
        };
      }
    }
    var O = {
      room: e,
      type: "breakdown",
      origin: t.origin || null,
      sink: t.sink || "storage",
      stockpile: !!t.stockpile,
      marketOpId: t.marketOpId || null,
      jobId: t.jobId || null,
      compound: r,
      amount: a,
      remaining: a,
      compoundDelivered: 0,
      reag1: i.a,
      reag2: i.b,
      created: Game.time,
      evacuating: false,
      needsPreEvacuation: true
    };
    if (p) {
      O.reservationProgram = p;
      O.leafReagents = [ {
        reagent: r,
        amount: a
      } ];
    }
    clearRoomCache(e);
    if (!n.active) {
      O.processingSince = Game.time;
      n.active = O;
      return {
        ok: true,
        msg: "[Labs] Started breakdown of " + r + " x" + a + " -> " + i.a + " + " + i.b
      };
    } else {
      n.queue.push(O);
      return {
        ok: true,
        msg: "[Labs] Queued breakdown of " + r + " x" + a
      };
    }
  }
  function maybeCompleteOrder(e) {
    var r = ensureRoomOrders(e);
    if (!r.active) return;
    var t = Game.rooms[e];
    if (!t) return;
    if (r.active.type === "pipeline") {
      maybeCompletePipelineOrder(e);
      return;
    }
    if (r.active.type === "cleanup") {
      if (!r.active.needsPreEvacuation) {
        debugLog("[Labs] Cleanup complete in " + e);
        r.active = null;
        clearRoomCache(e);
        if (r.queue.length > 0) {
          r.active = r.queue.shift();
          r.active.needsPreEvacuation = true;
          var n = r.active.type === "breakdown" ? r.active.compound : r.active.type === "cleanup" ? "cleanup" : r.active.product;
          debugLog("[Labs] Started next order: " + r.active.type + " " + n);
        }
      }
      return;
    }
    var o = r.active.type === "breakdown";
    var i = o ? computeBreakdownLayout(t) : resolveLayout(t);
    var u = _getLabs(t);
    function checkLabsEmpty() {
      for (var e = 0; e < u.length; e++) {
        if ((u[e].mineralAmount || 0) > 0) return false;
      }
      return true;
    }
    if (o) {
      var s = t.storage;
      var l = t.terminal;
      var d = s && s.store[r.active.compound] || 0;
      var c = l && l.store[r.active.compound] || 0;
      var p = d + c;
      var v = getSupplierCarriedAmount(e, r.active.compound);
      var m = 0;
      var g = 0;
      var f = 0;
      for (var b = 0; b < u.length; b++) {
        if (u[b].mineralType === r.active.compound) {
          var h = u[b].mineralAmount || 0;
          m += h;
          if (h >= a) {
            g += h;
          }
        }
      }
      if (i && i.groups) {
        for (var y = 0; y < i.groups.length; y++) {
          var k = i.groups[y];
          f += k.in1.mineralAmount || 0;
          f += k.in2.mineralAmount || 0;
        }
      }
      var L = p + m + v;
      var O = checkLabsEmpty();
      var R = typeof r.active.compoundDelivered === "number" ? r.active.compoundDelivered : 0;
      var I = r.active.amount || 0;
      var P = (r.active.remaining <= 0 || R >= I) && v <= 0;
      if (r.active.evacuating && O && (r.active.broken || P)) {
        if (r.active.broken) sellBrokenOrderResources(r, e, r.active);
        if (!r.active.broken && R <= 0 && p >= a && m === 0 && f === 0) {
          debugLog("[Labs] Breakdown aborted: compound never processed, " + p + " still in terminal/storage");
          releaseOrderReservations(r.active);
          r.active = null;
          clearRoomCache(e);
          if (r.queue.length > 0) {
            r.active = r.queue.shift();
            r.active.needsPreEvacuation = true;
          }
          return;
        }
        debugLog("[Labs] Breakdown fully complete: " + r.active.compound + " in " + e + " (reagents: " + f + ")");
        releaseOrderReservations(r.active);
        r.active = null;
        clearRoomCache(e);
        if (r.queue.length > 0) {
          r.active = r.queue.shift();
          r.active.needsPreEvacuation = true;
          var n = r.active.type === "breakdown" ? r.active.compound : r.active.product;
          debugLog("[Labs] Started next order: " + r.active.type + " " + n);
        } else {
          debugLog("[Labs] Completed all lab orders in " + e);
        }
        return;
      }
      var M = p >= a && m === 0 && f < a && !r.active.evacuating;
      if (!M) {
        if (P && L === 0 && f < a) {
          debugLog("[Labs] Breakdown order complete - no compound or reagents remain anywhere.");
          releaseOrderReservations(r.active);
          r.active = null;
          clearRoomCache(e);
          if (r.queue.length > 0) {
            r.active = r.queue.shift();
            r.active.needsPreEvacuation = true;
            var n = r.active.type === "breakdown" ? r.active.compound : r.active.product;
            debugLog("[Labs] Started next order: " + r.active.type + " " + n);
          }
          return;
        }
        var T = g === 0;
        var S = f < a;
        if (P && T && S) {
          debugLog("[Labs] Breakdown fully complete: " + r.active.compound + " in " + e + " (compound remaining: " + L + ", reagents: " + f + ")");
          releaseOrderReservations(r.active);
          r.active = null;
          clearRoomCache(e);
          if (r.queue.length > 0) {
            r.active = r.queue.shift();
            r.active.needsPreEvacuation = true;
            var n = r.active.type === "breakdown" ? r.active.compound : r.active.product;
            debugLog("[Labs] Started next order: " + r.active.type + " " + n);
          } else {
            debugLog("[Labs] Completed all lab orders in " + e);
          }
          return;
        }
        if (P && T && !S) {
          if (!r.active.evacuating) {
            r.active.evacuating = true;
            debugLog("[Labs] Breakdown: delivery & reactions complete, entering evacuation phase (" + f + " reagents remaining)");
          }
        }
      }
    } else {
      var P = r.active.remaining <= 0;
      var O = checkLabsEmpty();
      if (r.active.evacuating && O) {
        if (r.active.broken) sellBrokenOrderResources(r, e, r.active);
        var A = r.active.product;
        debugLog("[Labs] Evacuation complete, labs empty — completing " + A + " in " + e);
        releaseOrderReservations(r.active);
        r.active = null;
        clearRoomCache(e);
        if (r.queue.length > 0) {
          r.active = r.queue.shift();
          r.active.needsPreEvacuation = true;
          var n = r.active.type === "breakdown" ? r.active.compound : r.active.product;
          debugLog("[Labs] Started next order: " + r.active.type + " " + n + " x" + r.active.remaining);
        } else {
          debugLog("[Labs] Completed all lab orders in " + e);
        }
        return;
      }
      var C = !isMarketLabOrder(r.active) || productionPartialStartAllowed(r.active);
      if (!r.active.evacuating && !P && C) {
        var w = t.storage;
        var G = t.terminal;
        var q = (w && w.store[r.active.reag1] || 0) + (G && G.store[r.active.reag1] || 0);
        var N = (w && w.store[r.active.reag2] || 0) + (G && G.store[r.active.reag2] || 0);
        if (i && i.groups) {
          for (var y = 0; y < i.groups.length; y++) {
            var E = i.groups[y];
            var B = E.in1.mineralAmount || 0;
            var j = E.in2.mineralAmount || 0;
            if (B > 0 && j < a && N === 0) {
              r.active.evacuating = true;
              debugLog("[Labs] Production stuck: " + r.active.reag1 + " loaded but no " + r.active.reag2 + " available — evacuating");
              break;
            }
            if (j > 0 && B < a && q === 0) {
              r.active.evacuating = true;
              debugLog("[Labs] Production stuck: " + r.active.reag2 + " loaded but no " + r.active.reag1 + " available — evacuating");
              break;
            }
          }
        }
      }
      if (i && i.groups) {
        for (var y = 0; y < i.groups.length && O; y++) {
          var k = i.groups[y];
          for (var _ = 0; _ < k.outs.length && O; _++) {
            var x = k.outs[_].store && k.outs[_].store[r.active.product] || 0;
            if (x > 0) {
              O = false;
              break;
            }
          }
          if (O && (k.in1.mineralAmount || 0) > 0) O = false;
          if (O && (k.in2.mineralAmount || 0) > 0) O = false;
        }
      }
      if (P && O) {
        var A = r.active.product;
        debugLog("[Labs] Completed " + A + " in " + e);
        releaseOrderReservations(r.active);
        r.active = null;
        clearRoomCache(e);
        if (r.queue.length > 0) {
          r.active = r.queue.shift();
          r.active.needsPreEvacuation = true;
          var n = r.active.type === "breakdown" ? r.active.compound : r.active.product;
          debugLog("[Labs] Started next order: " + r.active.type + " " + n + " x" + r.active.remaining);
        } else {
          debugLog("[Labs] Completed all lab orders in " + e);
        }
      } else if (P && !O) {
        r.active.evacuating = true;
        debugLog("[Labs] Delivery complete, entering evacuation phase");
      }
    }
  }
  function recordDelivery(e, r, a) {
    var t = ensureRoomOrders(e);
    if (!t.active) return;
    var n = t.active.type === "breakdown";
    if (n) {
      if (r !== t.active.compound) return;
    } else {
      if (r !== t.active.product) return;
    }
    if (typeof a !== "number" || a <= 0) return;
    t.active.remaining -= a;
    if (t.active.remaining < 0) t.active.remaining = 0;
    if (n) {
      if (typeof t.active.compoundDelivered !== "number") t.active.compoundDelivered = 0;
      t.active.compoundDelivered += a;
      debugLog("[Labs] Breakdown delivery tracked: " + a + " " + r + " to labs (remaining: " + t.active.remaining + ", total delivered: " + t.active.compoundDelivered + ")");
    }
  }
  function computeAndStoreLabLayout(e) {
    return computeBestLayout(e);
  }
  function repairActiveOrderIfNeeded(e) {
    var r = ensureRoomOrders(e);
    if (!r || !r.active) return;
    var a = r.active;
    var t = a.type === "breakdown" ? a.compound : a.product;
    if (!a.reag1 || !a.reag2) {
      var n = findDirectReagents(t);
      if (n) {
        a.reag1 = n.a;
        a.reag2 = n.b;
      }
    }
    if (typeof a.remaining !== "number" || a.remaining < 0) {
      a.remaining = a.amount || 0;
    }
    if (!a.type) {
      a.type = "production";
    }
    if (a.type === "breakdown" && typeof a.compoundDelivered !== "number") {
      a.compoundDelivered = 0;
    }
  }
  function checkLabsClear(e, r, a) {
    var t = _getLabs(e);
    for (var n = 0; n < t.length; n++) {
      var o = t[n];
      var i = o.mineralAmount || 0;
      if (i > 0) {
        debugLog("[Labs] Pre-evac needed: lab has " + i + " " + o.mineralType);
        return false;
      }
    }
    return true;
  }
  function queueCleanup(e) {
    var r = ensureRoomOrders(e);
    if (r.active) return false;
    var a = Game.rooms[e];
    if (!a) return false;
    var t = _getLabs(a);
    var n = false;
    for (var o = 0; o < t.length; o++) {
      if ((t[o].mineralAmount || 0) > 0) {
        n = true;
        break;
      }
    }
    if (!n) return false;
    r.active = {
      type: "cleanup",
      created: Game.time,
      needsPreEvacuation: true,
      evacuating: false,
      remaining: 0,
      reag1: null,
      reag2: null,
      product: null,
      compound: null
    };
    clearRoomCache(e);
    console.log("[Labs] Cleanup order queued for " + e);
    return true;
  }
  function runProduction(e, r, t) {
    var n = 0;
    for (var o = 0; o < r.groups.length; o++) {
      var i = r.groups[o];
      for (var u = 0; u < i.outs.length; u++) {
        var s = i.outs[u];
        if (!s || !s.store) continue;
        if (s.store[t.product]) {
          n += s.store[t.product];
        }
      }
    }
    var l = typeof t.remaining === "number" && t.remaining > 0 ? t.remaining : t.amount || 0;
    if (!t.evacuating && l > 0 && n >= l) {
      t.evacuating = true;
      debugLog("[Labs] Preemptive evacuate: outputs hold " + n + " " + t.product + " >= remaining " + l);
    }
    if (!t.evacuating && isMarketLabOrder(t) && !productionInputsReady(r, t)) {
      debugLog("[Labs] Waiting for marketLab staging before running " + t.product);
      return;
    }
    if (!t.evacuating) {
      for (var d = 0; d < r.groups.length; d++) {
        var c = r.groups[d];
        for (var v = 0; v < c.outs.length; v++) {
          var m = c.outs[v];
          if (m.cooldown > 0) continue;
          var g = m.runReaction(c.in1, c.in2);
          if (g !== OK) {
            g = m.runReaction(c.in2, c.in1);
          }
          if (g === OK) {
            var f = {};
            f[t.reag1] = a;
            f[t.reag2] = a;
            p.recordProduction("labsForward", e.name, t.product, a, f);
            if (t.jobId) {
              try {
                require("marketEconomics").recordProduction(t.jobId, t.product, a, f);
              } catch (e) {}
            }
          }
        }
      }
    }
  }
  function runBreakdown(e, r, t) {
    var n = _getLabs(e);
    var o = false;
    for (var i = 0; i < n.length; i++) {
      if (n[i].mineralType === t.compound && (n[i].mineralAmount || 0) >= a) {
        o = true;
        break;
      }
    }
    var u = (t.compoundDelivered || 0) > 0;
    var s = Game.time - (t.created || Game.time);
    var l = isMarketLabOrder(t) ? 1e3 : 100;
    var d = s > l;
    var c = getSupplierCarriedAmount(e.name, t.compound);
    var v = getAvailableForProductionOrder(e.name, t.compound, t) > 0 || c > 0;
    var m = typeof t.remaining === "number" ? t.remaining : t.amount || 0;
    var g = m <= 0;
    var f = typeof t.compoundDelivered === "number" ? t.compoundDelivered : 0;
    var b = t.amount || 0;
    var h = (m <= 0 || f >= b) && c <= 0;
    if (!o && !v && h && (g || u || d)) {
      t.evacuating = true;
      return;
    }
    if (t.evacuating) return;
    var y = r.groups[0].in1;
    var k = r.groups[0].in2;
    var L = y.store.getFreeCapacity(t.reag1) || 0;
    var O = k.store.getFreeCapacity(t.reag2) || 0;
    for (var R = 0; R < n.length; R++) {
      var I = n[R];
      if (I.cooldown > 0) continue;
      if (I.mineralType !== t.compound) continue;
      if ((I.mineralAmount || 0) < a) continue;
      if (I.id === y.id || I.id === k.id) continue;
      if (L < a || O < a) {
        continue;
      }
      if (!I.pos.inRangeTo(y, 2) || !I.pos.inRangeTo(k, 2)) {
        continue;
      }
      var P = I.reverseReaction(y, k);
      if (P === OK) {
        debugLog("[Labs] Breaking down " + t.compound + " from lab " + I.id.substr(-4));
      } else if (P !== ERR_TIRED) {
        P = I.reverseReaction(k, y);
      }
      if (P === OK) {
        L -= a;
        O -= a;
        p.record("labsReverse", e.name, t.compound, {
          out: p.value(t.reag1, a) + p.value(t.reag2, a),
          input: p.value(t.compound, a),
          qty: a
        });
        if (t.jobId) {
          try {
            var M = {};
            M[t.compound] = a;
            require("marketEconomics").recordProduction(t.jobId, t.reag1, a, M);
            require("marketEconomics").recordProduction(t.jobId, t.reag2, a, null);
          } catch (e) {}
        }
      }
    }
  }
  function labsNeedWork(e) {
    var r = Memory.labOrders && Memory.labOrders[e];
    if (!r || !r.active) return false;
    var t = Game.rooms[e];
    if (!t) return false;
    var n = r.active;
    if (n.type === "pipeline") {
      return getSupplierLabTasks(e).length > 0;
    }
    if (n.type === "cleanup") {
      return n.needsPreEvacuation === true;
    }
    var o = n.type === "breakdown";
    if (n.needsPreEvacuation) return true;
    if (n.evacuating) {
      var i = _getLabs(t);
      for (var u = 0; u < i.length; u++) {
        if ((i[u].mineralAmount || 0) > 0) {
          return true;
        }
      }
      return false;
    }
    var s = t.terminal;
    var l = t.storage;
    var d = 3e3;
    var i = _getLabs(t);
    for (var c = 0; c < i.length; c++) {
      var p = i[c];
      if ((p.mineralAmount || 0) === 0) continue;
      var v = p.mineralType;
      if (o) {
        if (v !== n.compound && v !== n.reag1 && v !== n.reag2) {
          return true;
        }
      } else {
        if (v !== n.product && v !== n.reag1 && v !== n.reag2) {
          return true;
        }
      }
    }
    if (o) {
      var m = (s && s.store[n.compound] || 0) + (l && l.store[n.compound] || 0);
      if (m >= a) return true;
      var g = computeBreakdownLayout(t);
      if (g && g.groups.length > 0) {
        for (var f = 0; f < g.groups.length; f++) {
          var b = g.groups[f];
          if ((b.in1.mineralAmount || 0) >= 1e3) return true;
          if ((b.in2.mineralAmount || 0) >= 1e3) return true;
        }
      }
    } else {
      var h = (s && s.store[n.reag1] || 0) + (l && l.store[n.reag1] || 0);
      var y = (s && s.store[n.reag2] || 0) + (l && l.store[n.reag2] || 0);
      var g = resolveLayout(t);
      if (g) {
        for (var f = 0; f < g.groups.length; f++) {
          var b = g.groups[f];
          var k = b.in1.mineralType === n.reag1 ? b.in1.mineralAmount || 0 : 0;
          var L = b.in2.mineralType === n.reag2 ? b.in2.mineralAmount || 0 : 0;
          if (d - k >= a && h >= a) return true;
          if (d - L >= a && y >= a) return true;
        }
        for (var f = 0; f < g.groups.length; f++) {
          var b = g.groups[f];
          for (var O = 0; O < b.outs.length; O++) {
            var R = b.outs[O];
            if (R.mineralType === n.product && (R.mineralAmount || 0) >= 2e3) {
              return true;
            }
          }
        }
        for (var f = 0; f < g.groups.length; f++) {
          var b = g.groups[f];
          var I = b.in1.mineralAmount || 0;
          var P = b.in2.mineralAmount || 0;
          if (I > 0 && P < a && y === 0) return true;
          if (P > 0 && I < a && h === 0) return true;
        }
      }
    }
    return false;
  }
  function runRoom(r) {
    var a = ensureRoomOrders(r.name);
    if (!a.active) {
      if (!a.queue || a.queue.length === 0) queueCleanup(r.name);
      return;
    }
    maybeCompleteOrder(r.name);
    a = ensureRoomOrders(r.name);
    if (!a.active) {
      if (!a.queue || a.queue.length === 0) queueCleanup(r.name);
      return;
    }
    if (a.active.type === "cleanup") {
      if (a.active.needsPreEvacuation) {
        if (checkLabsClear(r, null, a.active)) {
          a.active.needsPreEvacuation = false;
          debugLog("[Labs] Cleanup pre-evac complete for " + r.name);
        }
      }
      maybeCompleteOrder(r.name);
      return;
    }
    repairActiveOrderIfNeeded(r.name);
    if (a.active.type === "pipeline") {
      runPipeline(r, a.active);
      maybeCompleteOrder(r.name);
      return;
    }
    if (a.active.type !== "cleanup" && !a.active.broken) {
      if (!a.active.processingSince) a.active.processingSince = Game.time;
      if (Game.time - a.active.processingSince > n) {
        markBroken(r.name, a.active, "reacting > " + n + " ticks");
      }
    }
    var t = layoutMemory()[r.name] || null;
    if (t && t.validated && Game.time - t.validated > e) {
      delete b[r.name];
      delete t.validated;
    }
    if (t && t.breakdownValidated && Game.time - t.breakdownValidated > e) {
      delete h[r.name];
      delete t.breakdownValidated;
    }
    var o;
    if (a.active.type === "breakdown") {
      o = computeBreakdownLayout(r);
    } else {
      o = resolveLayout(r);
    }
    if (!o || !o.groups || o.groups.length === 0) return;
    if (a.active.needsPreEvacuation) {
      var i = checkLabsClear(r, o, a.active);
      if (i) {
        a.active.needsPreEvacuation = false;
        debugLog("[Labs] Pre-evacuation complete for " + r.name);
      } else {
        debugLog("[Labs] Waiting for pre-evacuation in " + r.name);
        return;
      }
    }
    if (a.active.type === "breakdown") {
      runBreakdown(r, o, a.active);
    } else {
      runProduction(r, o, a.active);
    }
    maybeCompleteOrder(r.name);
  }
  function run(e) {
    ensureManagerRoot();
    if (Memory.labManager.lastRun && Game.time - Memory.labManager.lastRun < r) {
      return;
    }
    Memory.labManager.lastRun = Game.time;
    if (e && e.name && e.find) {
      if (c.shouldAvoidRoomWork(e.name)) return;
      return runRoom(e);
    }
    for (var a in Memory.labOrders) {
      var t = Memory.labOrders[a];
      if (t && t.active) {
        if (c.shouldAvoidRoomWork(a)) continue;
        var n = Game.rooms[a];
        if (n) {
          runRoom(n);
        }
      }
    }
  }
  function pipelineInputRequirements(e) {
    var r = {};
    if (!e) return r;
    if (e.mode === "decompose") {
      r[e.root] = e.amount;
      return r;
    }
    for (var a in e.leaves) {
      if (Object.prototype.hasOwnProperty.call(e.leaves, a)) r[a] = e.leaves[a];
    }
    return r;
  }
  function pipelineOrderPreview(e, r, a) {
    var t = pipelineInputRequirements(r);
    var n = [];
    for (var o = 0; o < r.stages.length; o++) {
      var i = r.stages[o];
      var u = pipelineLayoutStage(a, i.id);
      if (!u) return null;
      var s = {};
      for (var l in i) s[l] = i[l];
      s.inputLabIds = u.inputLabIds.slice();
      s.inputResources = u.inputResources.slice();
      s.outputLabIds = u.outputLabIds.slice();
      s.outputResources = u.outputResources.slice();
      s.produced = 0;
      n.push(s);
    }
    return {
      room: e,
      type: "pipeline",
      mode: r.mode,
      root: r.root,
      amount: r.amount,
      pipelineId: "diagnostic",
      inputRequirements: t,
      leaves: r.leaves,
      finalOutputs: r.finalOutputs,
      stages: n,
      layout: {
        labIds: a.labIds.slice(),
        stages: a.stages.slice(),
        stageMap: a.stageMap
      },
      needsPreEvacuation: false,
      evacuating: false
    };
  }
  function findPipelineOrder(e, r, a, t) {
    var n = Memory.labOrders && Memory.labOrders[e];
    if (!n) return null;
    var o = [];
    if (n.active) o.push(n.active);
    if (Array.isArray(n.queue)) {
      for (var i = 0; i < n.queue.length; i++) o.push(n.queue[i]);
    }
    for (var u = 0; u < o.length; u++) {
      var s = o[u];
      if (s && s.type === "pipeline" && s.root === r && s.mode === a && s.amount === t) return s;
    }
    return null;
  }
  function pipelineRangeBetween(e, r) {
    if (!e || !r || !e.pos || !r.pos) return null;
    if (typeof e.pos.getRangeTo === "function") return e.pos.getRangeTo(r);
    return Math.max(Math.abs(e.pos.x - r.pos.x), Math.abs(e.pos.y - r.pos.y));
  }
  function pipelineDiagnostic(e, r, a, t) {
    a = a === "synth" || a === "full_synthesis" ? "synthesis" : a === "decomp" || a === "full_decompose" ? "decompose" : a;
    a = a || "synthesis";
    r = r || "XKH2O";
    t = Math.floor(Number(t) || 1500);
    var n = {
      ok: false,
      roomName: e || null,
      resource: r || "XKH2O",
      mode: a || "synthesis",
      amount: t,
      checks: [],
      errors: [],
      warnings: []
    };
    function check(e, r, a, t) {
      var o = {
        name: e,
        ok: !!r,
        warning: !!t,
        detail: a || ""
      };
      n.checks.push(o);
      if (!r) (t ? n.warnings : n.errors).push(e + ": " + (a || "failed"));
    }
    var u = e && Game.rooms[e];
    if (!u) {
      check("room vision", false, "no vision in " + e);
      return n;
    }
    var s = f.build(n.mode, n.resource, t);
    n.plan = s.ok ? {
      ok: true,
      root: s.root,
      amount: s.amount,
      depth: s.depth,
      stageCount: s.stageCount,
      leaves: s.leaves,
      finalOutputs: s.finalOutputs,
      stages: s.stages.map(function(e) {
        return {
          id: e.id,
          product: e.product,
          inputs: e.inputs,
          outputs: e.outputs,
          amount: e.amount,
          dependencies: e.dependencies
        };
      })
    } : {
      ok: false,
      reason: s.reason
    };
    check("reaction graph", !!s.ok, s.ok ? "valid runtime REACTIONS plan" : s.reason);
    if (!s.ok) return n;
    check("plan validation", !s.validation || s.validation.ok, s.validation && s.validation.errors ? s.validation.errors.join("; ") : "valid");
    var c = _getLabs(u);
    var p = f.roomSupportsAdvanced(u, c);
    n.room = {
      owned: !!(u.controller && u.controller.my),
      rcl: u.controller && u.controller.level || 0,
      labs: c.length,
      terminal: !!u.terminal,
      storage: !!u.storage,
      suppliers: 0
    };
    var v = d.creepIndex && d.creepIndex();
    var m = v && v.all ? v.all : [];
    for (var g = 0; g < m.length; g++) {
      var b = m[g];
      if (b && b.room && b.room.name === e && b.memory && b.memory.role === "supplier") n.room.suppliers++;
    }
    check("advanced room", !s.requiresAdvancedRoom || p.ok, s.requiresAdvancedRoom ? p.ok ? "owned RCL8 with 10 labs" : p.reason : "not required");
    check("terminal and storage", !!u.terminal && !!u.storage, u.terminal && u.storage ? "available" : "terminal and storage are both required");
    check("supplier presence", n.room.suppliers > 0, n.room.suppliers > 0 ? n.room.suppliers + " supplier creep(s)" : "no supplier creep is assigned to the room");
    var h = computePipelineLayout(u, s);
    n.layout = h.ok ? {
      ok: true,
      searchNodes: h.searchNodes,
      assignedLabs: h.labIds.length,
      stages: []
    } : {
      ok: false,
      reason: h.reason
    };
    check("range-2 layout", h.ok, h.ok ? h.searchNodes + " search nodes" : h.reason);
    if (!h.ok) return n;
    var y = findPipelineOrder(e, n.resource, n.mode, t);
    var k = y || pipelineOrderPreview(e, s, h);
    var L = y && y.layout ? y.layout : h;
    if (y && y.layout) {
      n.layout.activeAssignment = true;
      n.layout.assignedLabs = y.layout.labIds ? y.layout.labIds.length : n.layout.assignedLabs;
    }
    n.active = y ? {
      pipelineId: y.pipelineId,
      status: y.cancelled ? "cancelled" : y.broken ? "broken" : "active",
      produced: (y.stages || []).map(function(e) {
        return {
          id: e.id,
          produced: e.produced || 0,
          amount: e.amount || 0
        };
      }),
      lastProgressTick: y.lastProgressTick || 0,
      lastBlockedReason: y.lastBlockedReason || null,
      outcome: getPipelineOutcome(y.pipelineId)
    } : null;
    if (y) {
      check("market ownership", y.origin === "marketLab" && !!y.marketOpId, y.origin === "marketLab" && y.marketOpId ? "marketLab operation " + y.marketOpId : "active pipeline is not linked to a marketLab operation", true);
    }
    var O = Memory.labOrders && Memory.labOrders[e];
    var R = (O && O.active ? 1 : 0) + (O && Array.isArray(O.queue) ? O.queue.length : 0);
    check("pipeline room lock", !!y || R === 0, y ? "matching pipeline is active" : R === 0 ? "room is idle" : R + " pending lab orders", false);
    var I = {};
    var P = {};
    var M = true;
    var T = [];
    var S = null;
    var A = false;
    for (var C = 0; C < s.stages.length; C++) {
      var w = s.stages[C];
      var G = pipelineLayoutStage(L, w.id);
      var q = {
        id: w.id,
        product: w.product,
        inputs: [],
        outputs: [],
        rangeOk: true,
        handoffOk: true
      };
      if (!G) {
        q.rangeOk = false;
        q.handoffOk = false;
        n.layout.stages.push(q);
        M = false;
        continue;
      }
      var N = w.mode === "decompose" ? G.outputLabIds.length === 2 : G.outputLabIds.length >= 1;
      if (G.inputLabIds.length !== (w.mode === "decompose" ? 1 : 2) || !N) {
        q.rangeOk = false;
        q.handoffOk = false;
        M = false;
      }
      if (w.mode !== "decompose" && w.inputs.indexOf("X") >= 0) A = true;
      var E = [];
      for (var B = 0; B < G.inputLabIds.length; B++) {
        var j = Game.getObjectById(G.inputLabIds[B]);
        E.push(j);
        q.inputs.push({
          id: G.inputLabIds[B],
          resource: G.inputResources[B],
          present: !!j,
          mineral: j && j.mineralType || null,
          amount: j && j.mineralAmount || 0
        });
        if (j && j.mineralType && j.mineralType !== G.inputResources[B]) {
          T.push(G.inputLabIds[B] + ":" + j.mineralType);
        }
        var _ = I[G.inputResources[B]];
        if (_ && _ !== G.inputLabIds[B]) q.handoffOk = false;
      }
      var x = w.mode === "decompose" ? w.outputs : [ w.product ];
      for (var D = 0; D < G.outputLabIds.length; D++) {
        var U = Game.getObjectById(G.outputLabIds[D]);
        var F = G.outputResources[D] || x[D];
        P[G.outputLabIds[D]] = (P[G.outputLabIds[D]] || 0) + 1;
        var X = [];
        for (var K = 0; K < E.length; K++) X.push(pipelineRangeBetween(E[K], U));
        var V = !!U && X.every(function(e) {
          return e !== null && e <= 2;
        });
        if (!V) q.rangeOk = false;
        if (w.inputs.indexOf("X") >= 0) {
          var W = w.inputs.indexOf("X");
          var H = pipelineRangeBetween(E[W], U);
          if (H === null || S === null || H > S) {
            S = H;
          }
        }
        q.outputs.push({
          id: G.outputLabIds[D],
          resource: F,
          present: !!U,
          mineral: U && U.mineralType || null,
          amount: U && U.mineralAmount || 0,
          ranges: X,
          rangeOk: V
        });
        if (U && U.mineralType && U.mineralType !== F) {
          T.push(G.outputLabIds[D] + ":" + U.mineralType);
        }
      }
      for (var Y = 0; Y < x.length; Y++) I[x[Y]] = G.outputLabIds[Y];
      if (!q.rangeOk || !q.handoffOk) M = false;
      n.layout.stages.push(q);
    }
    var Q = [];
    for (var J in P) {
      if (P[J] > 1) Q.push(J);
    }
    check("assigned lab objects", M, M ? "all stage labs exist, are in range, and preserve handoffs" : "missing lab, invalid range, or broken direct handoff");
    check("output lab uniqueness", Q.length === 0, Q.length === 0 ? "no output lab is assigned twice" : Q.join(", "));
    check("current lab minerals", T.length === 0, T.length === 0 ? "no assigned lab has an unexpected mineral" : T.join(", "), true);
    if (A) {
      check("catalyst output adjacency", S !== null && S <= 1, S === null ? "X stage not assigned" : "X-to-output range " + S, true);
    }
    var z = pipelineInputRequirements(s);
    n.reservations = {};
    var Z = true;
    for (var $ in z) {
      if (!Object.prototype.hasOwnProperty.call(z, $)) continue;
      var ee = l.storageFind(e, $);
      var re = ee && ee.terminal ? Math.max(0, (ee.terminal.total || 0) - (ee.terminal.reserved || 0)) : 0;
      var ae = ee && ee.storage ? Math.max(0, (ee.storage.total || 0) - (ee.storage.reserved || 0)) : 0;
      var te = y ? getProgramReservedAmount(e, $, y.reservationProgram) : 0;
      var ne = re + ae + te;
      var oe = ne >= z[$];
      if (!oe) Z = false;
      n.reservations[$] = {
        required: z[$],
        available: ne,
        ownReserved: te,
        enough: oe
      };
    }
    check(y ? "leaf reservations" : "leaf input availability", Z, Z ? "all required inputs are available" : "one or more inputs are short");
    var ie = getPipelineSupplierLabTasks(e, k);
    var ue = [];
    var se = {};
    var le = 0;
    for (var de = 0; de < ie.length; de++) {
      var ce = ie[de];
      var pe = ce.extra && ce.extra.match(/(?:^|,)res=([^,]+)/);
      var ve = ce.targetId && Game.getObjectById(ce.targetId);
      if (!(ce.amount > 0) || !ve || !pe) ue.push(ce.taskId || "unknown");
      if (ce.type === "lab_load") se[pe ? pe[1] : "?"] = (se[pe ? pe[1] : "?"] || 0) + (ce.amount || 0);
      if (ce.type === "lab_unload") le++;
    }
    n.supplier = {
      taskCount: ie.length,
      loads: se,
      unloads: le,
      invalidTasks: ue
    };
    check("supplier tasks", ue.length === 0, ue.length === 0 ? ie.length + " valid tasks" : ue.join(", "));
    var me = estimatePipelineTicks(s, L);
    n.timing = {
      estimatedTicks: me,
      deadline: Math.max(1e4, me * 2),
      warningTicks: o,
      hardTicks: i
    };
    check("deadline", me > 0 && me * 2 <= i, me > 0 ? me + " estimated ticks" : "could not estimate pipeline");
    n.ok = n.errors.length === 0;
    return n;
  }
  function formatPipelineDiagnostic(e) {
    if (!e) return "[LabsPipeline] no report";
    var r = [ "[LabsPipeline] " + (e.ok ? "PASS" : "FAIL") + " " + (e.roomName || "?") + " " + (e.mode || "?") + " " + (e.resource || "?") + " x" + e.amount ];
    if (e.plan) r.push("Plan: " + (e.plan.ok ? "valid" : e.plan.reason) + (e.plan.stageCount ? ", stages=" + e.plan.stageCount + ", depth=" + e.plan.depth : ""));
    if (e.room) r.push("Room: RCL" + e.room.rcl + ", labs=" + e.room.labs + ", terminal=" + (e.room.terminal ? "yes" : "no") + ", storage=" + (e.room.storage ? "yes" : "no") + ", suppliers=" + e.room.suppliers);
    if (e.layout) r.push("Layout: " + (e.layout.ok ? "valid, assigned=" + e.layout.assignedLabs + ", search=" + e.layout.searchNodes : e.layout.reason));
    if (e.timing) r.push("Timing: estimate=" + e.timing.estimatedTicks + ", deadline=" + e.timing.deadline + ", hard=" + e.timing.hardTicks);
    if (e.reservations) {
      var a = [];
      for (var t in e.reservations) {
        var n = e.reservations[t];
        a.push(t + " " + n.available + "/" + n.required + (n.enough ? "" : " SHORT"));
      }
      r.push("Inputs: " + (a.join(", ") || "none"));
    }
    if (e.supplier) r.push("Supplier: tasks=" + e.supplier.taskCount + ", loads=" + JSON.stringify(e.supplier.loads) + ", unloads=" + e.supplier.unloads);
    for (var o = 0; o < e.checks.length; o++) {
      var i = e.checks[o];
      r.push((i.warning ? "WARN " : i.ok ? "PASS " : "FAIL ") + i.name + (i.detail ? ": " + i.detail : ""));
    }
    for (var u = 0; u < e.warnings.length; u++) r.push("WARN " + e.warnings[u]);
    return r.join("\n");
  }
  function pipelineGraphSelfTest() {
    return f.selfTest(a);
  }
  function installConsole() {
    global.labsPipelineDiagnose = function(e, r, a, t) {
      if (typeof e !== "string") {
        return "[LabsPipeline] Usage: labsPipelineDiagnose('roomName', 'XKH2O', 'synthesis', 1500)";
      }
      return formatPipelineDiagnostic(pipelineDiagnostic(e, r, a, t));
    };
    global.labsPipelineDiagnoseJSON = function(e, r, a, t) {
      if (typeof e !== "string") {
        return JSON.stringify({
          ok: false,
          reason: "roomName is required"
        });
      }
      return JSON.stringify(pipelineDiagnostic(e, r, a, t));
    };
    global.labsPipelineSelfTest = function() {
      var e = pipelineGraphSelfTest();
      return "[LabsPipeline] " + (e.ok ? "PASS" : "FAIL") + " products=" + e.products + (e.failures.length ? "\n" + e.failures.join("\n") : "");
    };
    global.labsDiagnoseRoom = function(e) {
      if (typeof e !== "string") return "[Labs] Usage: labsDiagnoseRoom(roomName)";
      var r = Game.rooms[e];
      if (!r) return "[Labs] No vision in " + e;
      var a = [];
      var t = ensureRoomOrders(e);
      var o = "none";
      if (t.active) {
        o = t.active.type === "pipeline" ? "pipeline " + t.active.mode + " " + t.active.root : t.active.type + " " + (t.active.product || t.active.compound);
      }
      a.push("Order: " + o);
      a.push("Queue: " + (t.queue && t.queue.length || 0));
      a.push("labsNeedWork: " + labsNeedWork(e));
      if (t.active && t.active.type === "pipeline") {
        var i = 0;
        var u = 0;
        for (var s = 0; s < (t.active.stages || []).length; s++) {
          i += t.active.stages[s].produced || 0;
          u += t.active.stages[s].amount || 0;
        }
        a.push("Pipeline progress: " + i + "/" + u + ", blocked=" + (t.active.lastBlockedReason || "none") + ", deadline=" + (t.active.pipelineDeadline || "unknown"));
      }
      var l = d.get(e) && d.get(e).myCreeps || r.find(FIND_MY_CREEPS);
      var c = [];
      for (var p = 0; p < l.length; p++) {
        if (/labbot/i.test(l[p].memory.role || "")) c.push(l[p]);
      }
      a.push("LabBots in room: " + c.length);
      for (var v = 0; v < c.length; v++) {
        var m = c[v];
        var g = {};
        for (var f in m.store) {
          if (m.store[f] > 0) g[f] = m.store[f];
        }
        a.push("  " + m.name + ": " + JSON.stringify({
          role: m.memory.role,
          phase: m.memory.phase,
          idleTicks: m.memory.idleTicks,
          suicidePending: m.memory.suicidePending,
          task: m.memory.task,
          targetId: m.memory.targetId,
          working: m.memory.working,
          carry: g
        }));
      }
      var b = resolveLayout(r);
      a.push("Layout: " + (b && b.groups && b.groups.length > 0 ? "valid " + b.groups.length + " groups" : "NONE"));
      if (t.active && t.active.needsPreEvacuation) a.push("WARNING: stuck in needsPreEvacuation");
      if (t.active && t.active.evacuating) a.push("Note: evacuating flag is set");
      if (t.active && t.active.broken) a.push("BROKEN: flagged for evacuate + sell");
      if (t.active) {
        var h = t.active.processingSince || t.active.created;
        if (h) {
          a.push("Processing age: " + (Game.time - h) + " / " + n + " ticks");
        }
      }
      return "[Labs] " + e + "\n" + a.join("\n");
    };
    global.labsDiagnoseBots = function() {
      var e = [];
      var r = d.creepIndex();
      var a = r && r.all ? r.all : [];
      for (var t = 0; t < a.length; t++) {
        var n = a[t];
        if (/labbot/i.test(n.memory.role || "")) {
          e.push(n.name + " | room: " + n.room.name + " | phase: " + (n.memory.phase || "none") + " | idleTicks: " + (n.memory.idleTicks || 0) + " | suicidePending: " + (n.memory.suicidePending || false));
        }
      }
      return e.length ? "[Labs] Global labbot census:\n" + e.join("\n") : "[Labs] No labbots found globally.";
    };
    global.labsClearBotMemory = function(e) {
      var r = Game.creeps[e];
      if (!r) return "[Labs] Creep not found: " + e;
      delete r.memory.phase;
      delete r.memory.idleTicks;
      delete r.memory.suicidePending;
      delete r.memory.lastAction;
      delete r.memory.lastResource;
      delete r.memory.depositReason;
      delete r.memory.wantedReagents;
      delete r.memory.task;
      delete r.memory.targetId;
      delete r.memory.working;
      delete r.memory.idle;
      return "[Labs] Reset sticky memory on " + e + " — manager should reclaim it next tick";
    };
    global.orderLabs = function(e, r, t, n) {
      if (typeof e !== "string" || typeof r !== "string") {
        return "[Labs] Usage: orderLabs(roomName, product, amount)";
      }
      var o = parseInt(t, 10);
      if (isNaN(o) || o < 0) o = 0;
      if (o > 0 && o % a !== 0) {
        return "[Labs] Reaction amount must be a multiple of " + a + ".";
      }
      var i = Game.rooms[e] || null;
      if (i) {
        var u = computeAndStoreLabLayout(i);
        if (u) {
          var s = 0;
          for (var l = 0; l < u.groups.length; l++) {
            s += u.groups[l].outs.length;
          }
          debugLog("[Labs] Computed lab layout for " + e + " — " + u.groups.length + " groups, " + s + " outputs");
        }
      }
      var d = startOrder(e, r, o, n);
      return d.msg;
    };
    global.breakdownLabs = function(e, r, t, n) {
      if (typeof e !== "string" || typeof r !== "string") {
        return "[Labs] Usage: breakdownLabs(roomName, compound, amount)";
      }
      var o = parseInt(t, 10);
      if (isNaN(o) || o < 0) o = 0;
      if (o > 0 && o % a !== 0) {
        return "[Labs] Reaction amount must be a multiple of " + a + ".";
      }
      var i = Game.rooms[e] || null;
      if (i) {
        var u = computeAndStoreLabLayout(i);
        if (u) {
          debugLog("[Labs] Computed lab layout for " + e + " — " + u.groups.length + " groups");
        }
      }
      var s = startBreakdownOrder(e, r, o, n);
      return s.msg;
    };
    global.showAllLabs = function() {
      pruneLabOrdersForUnownedRooms();
      var e = [];
      var r = d.ownedNames();
      for (var a = 0; a < r.length; a++) {
        var t = r[a];
        e.push(global.showLabs(t));
      }
      return e.length ? e.join("\n") : "[Labs] No owned rooms";
    };
    global.cancelLabs = function(e) {
      if (typeof e !== "string") return "[Labs] Usage: cancelLabs(roomName)";
      var r = ensureRoomOrders(e);
      if (r.active && r.active.reservationProgram) {
        releaseOrderReservations(r.active);
      }
      for (var a = 0; a < r.queue.length; a++) {
        if (r.queue[a] && r.queue[a].reservationProgram) {
          releaseOrderReservations(r.queue[a]);
        }
      }
      r.active = null;
      r.queue = [];
      return "[Labs] Cleared labs orders in " + e;
    };
    global.recomputeLabLayout = function(e) {
      if (typeof e !== "string") return "[Labs] Usage: recomputeLabLayout(roomName)";
      var r = Game.rooms[e];
      if (!r) return "[Labs] No vision in " + e;
      clearRoomCache(e, true);
      var a = computeBestLayout(r);
      if (!a) return "[Labs] Could not compute layout for " + e;
      var t = 0;
      var n = [];
      for (var o = 0; o < a.groups.length; o++) {
        t += a.groups[o].outs.length;
        n.push("Group " + (o + 1) + ": " + a.groups[o].outs.length + " outputs");
      }
      return "[Labs] Recomputed layout for " + e + ": " + a.groups.length + " groups, " + a.groups.length * 2 + " inputs, " + t + " outputs\n" + n.join("\n");
    };
    global.showLabs = function(e) {
      if (typeof e !== "string") return "[Labs] Usage: showLabs(roomName)";
      var r = ensureRoomOrders(e);
      if (!r || typeof r !== "object") {
        Memory.labOrders = Memory.labOrders && typeof Memory.labOrders === "object" ? Memory.labOrders : {};
        Memory.labOrders[e] = {
          active: null,
          queue: []
        };
        r = Memory.labOrders[e];
      }
      var a = [];
      if (r.active) {
        var t = r.active;
        if (t.type === "pipeline") {
          var o = 0;
          var i = 0;
          for (var u = 0; u < (t.stages || []).length; u++) {
            o += t.stages[u].produced || 0;
            i += t.stages[u].amount || 0;
          }
          var s = t.mode === "decompose" ? "FULL DECOMPOSITION" : "FULL SYNTHESIS";
          var l = "Active: " + s + " " + t.root + " [" + (t.evacuating ? "DELIVERING" : t.needsPreEvacuation ? "STAGING" : "PROCESSING") + "]" + " | progress " + o + "/" + i + " | deadline " + (t.pipelineDeadline || "?") + (t.lastBlockedReason ? " | blocked: " + t.lastBlockedReason : "") + (t.marketOpId ? " | market op " + t.marketOpId : "");
          if (t.broken || t.cancelled) l += " | " + (t.cancelled ? "CANCELLED" : "BROKEN");
          a.push(l);
          var d = getSupplierLabTasks(e);
          a.push("Needs supplier: " + (d.length > 0 ? "YES" : "NO") + " (tasks=" + d.length + ")");
        } else {
          var c = t.type === "breakdown" ? t.compound : t.product;
          if (!t.reag1 || !t.reag2) {
            var p = findDirectReagents(c);
            if (p) {
              t.reag1 = p.a;
              t.reag2 = p.b;
            }
          }
          if (typeof t.remaining !== "number") {
            t.remaining = t.amount || 0;
          }
          var v = null;
          if (t.type === "breakdown") {
            var m = Game.rooms[e];
            if (m) {
              var g = _getLabs(m);
              var f = 0;
              for (var b = 0; b < g.length; b++) {
                if (g[b].mineralType === t.compound) {
                  f += g[b].mineralAmount || 0;
                }
              }
              var h = (m.storage && m.storage.store[t.compound] || 0) + (m.terminal && m.terminal.store[t.compound] || 0);
              var y = typeof t.compoundDelivered === "number" ? t.compoundDelivered : 0;
              var k = y - f;
              if (k < 0) {
                var L = f + h;
                var O = (t.amount || 0) - L;
                if (O > 0) {
                  k = O;
                  y = L + k;
                } else {
                  k = 0;
                }
              }
              v = {
                staged: y,
                amount: t.amount || 0,
                converted: k,
                compoundInLabs: f,
                compoundOutside: h
              };
            }
          }
          var R = "PROCESSING";
          if (t.evacuating) {
            R = "DELIVERING";
          } else if (t.needsPreEvacuation) {
            R = "STAGING";
          } else if (t.type === "breakdown") {
            if (v && v.compoundInLabs > 0) {
              R = "PROCESSING";
            } else if (t.remaining > 0) {
              R = "STAGING";
            } else {
              R = "PROCESSING";
            }
          } else if (t.remaining <= 0) {
            R = "DELIVERING";
          }
          var I = t.evacuating ? " (evacuating)" : "";
          if (t.needsPreEvacuation) I += " (pre-evac)";
          if (t.broken) I += " (BROKEN)";
          var P = t.type === "breakdown" ? "BREAKDOWN" : "PRODUCTION";
          var M = "Active: " + P + " " + c + " [" + R + "]";
          if (t.type === "breakdown") {
            M += " ordered " + (t.amount || 0) + " " + c + " | remaining to stage " + t.remaining + " " + c + " | outputs " + t.reag1 + " + " + t.reag2 + I;
          } else {
            M += " remaining " + t.remaining + " reagents " + t.reag1 + " + " + t.reag2 + I;
          }
          if (t.type === "breakdown" && typeof t.compoundDelivered === "number") {
            M += " | staged to labs: " + t.compoundDelivered + "/" + (t.amount || 0);
            if (v) {
              if (v.compoundInLabs > 0) {
                M += " | in labs: " + v.compoundInLabs + " " + t.compound;
              }
              if (v.compoundOutside > 0) {
                M += " | outside labs: " + v.compoundOutside + " " + t.compound;
              }
            }
          }
          var T = t.processingSince || t.created;
          if (T) {
            M += " | age " + (Game.time - T) + "/" + n;
          }
          if (t.type === "production") {
            var S = typeof t.inputLoadStartedSince === "number" ? Game.time - t.inputLoadStartedSince + " ticks" : "not started";
            M += " | input load age " + S;
          }
          if (t.type === "breakdown") {
            var A = Game.rooms[e];
            var C = A ? getBreakdownLayout(A) : null;
            if (C && C.groups && C.groups.length > 0) {
              var w = C.groups[0];
              var G = w.in1.store.getFreeCapacity(t.reag1) || 0;
              var q = w.in2.store.getFreeCapacity(t.reag2) || 0;
              M += " | destination free " + t.reag1 + ":" + G + " + " + t.reag2 + ":" + q;
            }
          }
          var N = Memory.labManager && Memory.labManager.lastRun;
          if (typeof N === "number") {
            M += " | manager age " + (Game.time - N) + " ticks";
          }
          if (t.marketOpId) {
            M += " | market op " + t.marketOpId;
          }
          a.push(M);
          var E = labsNeedWork(e);
          var B = t.origin === "marketLab" || t.marketOpId;
          if (B) {
            var j = getSupplierLabTasks(e);
            a.push("Needs supplier: " + (j.length > 0 ? "YES" : "NO") + " (tasks=" + j.length + ")");
          } else {
            a.push("Needs labbot: " + (E ? "YES" : "NO"));
          }
        }
      } else {
        a.push("Active: none");
      }
      var _ = r.queue && r.queue.length ? r.queue.length : 0;
      a.push("Queue: " + _);
      var x = layoutMemory()[e] || null;
      if (!x || typeof x !== "object" || !x.groups) {
        a.push("Layout: none");
      } else {
        var D = x.groups.length;
        var U = D * 2;
        var F = 0;
        var X = 0;
        for (var K = 0; K < x.groups.length; K++) {
          var V = x.groups[K];
          F += V.outIds ? V.outIds.length : 0;
          var W = Game.getObjectById(V.in1Id);
          var H = Game.getObjectById(V.in2Id);
          if (W && H) {
            var Y = 0;
            for (var Q = 0; Q < (V.outIds || []).length; Q++) {
              var J = Game.getObjectById(V.outIds[Q]);
              if (J && W.pos.inRangeTo(J, 2) && H.pos.inRangeTo(J, 2)) {
                Y++;
              }
            }
            if (Y > 0) X++;
          }
        }
        var z = X === D ? "valid" : "partial";
        a.push("Layout: " + z + " groups=" + D + " inputs=" + U + " outputs=" + F + " validGroups=" + X);
      }
      return "[Labs] " + e + " — " + a.join(" | ");
    };
    global.labsDebugOn = function() {
      if (!Memory.labManager) Memory.labManager = {};
      Memory.labManager.debug = true;
      return "[Labs] Debug logging enabled";
    };
    global.labsDebugOff = function() {
      if (!Memory.labManager) Memory.labManager = {};
      Memory.labManager.debug = false;
      return "[Labs] Debug logging disabled";
    };
    global.labsStats = function() {
      var a = [];
      a.push("Layout cache size: " + Object.keys(b).length);
      a.push("Breakdown cache size: " + Object.keys(h).length);
      a.push("Cache valid until: " + y);
      a.push("Last run: " + (Memory.labManager.lastRun || "never"));
      a.push("Run interval: " + r + " ticks");
      a.push("Validation interval: " + e + " ticks");
      return "[Labs] " + a.join(" | ");
    };
  }
  function autoInstallConsoleOnce() {
    if (!global.__labsConsoleInstalled) {
      installConsole();
      global.__labsConsoleInstalled = true;
    }
  }
  autoInstallConsoleOnce();
  return {
    installConsole: installConsole,
    runRoom: runRoom,
    run: run,
    recordDelivery: recordDelivery,
    getLayout: getLayout,
    getBreakdownLayout: getBreakdownLayout,
    getPipelineLayout: function(e, r) {
      return computePipelineLayout(e, r);
    },
    estimatePipelineTicks: estimatePipelineTicks,
    startPipeline: startPipelineOrder,
    cancelPipeline: cancelPipelineOrder,
    getPipelineOutcome: getPipelineOutcome,
    diagnosePipeline: pipelineDiagnostic,
    pipelineSelfTest: pipelineGraphSelfTest,
    getSupplierLabTasks: getSupplierLabTasks,
    getProductionInputTarget: getProductionInputTarget,
    getActiveOrder: getActiveOrder,
    getRoomOrderState: getRoomOrderState,
    getMarketOperationOrder: getMarketOperationOrder,
    getSupplierCarriedAmount: getSupplierCarriedAmount,
    roomHasPendingOrder: roomHasPendingOrder,
    migrateLegacyOrders: migrateLegacyOrders,
    clearRoomCache: clearRoomCache,
    labsNeedWork: labsNeedWork,
    queueCleanup: queueCleanup
  };
}();
module.exports = labManager;
global.checkLabBots = function(e) {
  if (!e) {
    var r = [];
    for (var a in Game.rooms) {
      var t = Game.rooms[a];
      if (!t.controller || !t.controller.my) continue;
      var n = Memory.labOrders && Memory.labOrders[a];
      var o = n && (n.active || n.queue && n.queue.length > 0);
      var i = _.filter(getRoomState.creepIndex().all, function(e) {
        return e.memory.role === "labBot" && (e.memory.homeRoom === a || e.memory.assignedRoom === a || e.room.name === a);
      }).length;
      if (o || i > 0) {
        r.push(a + ": " + i + " bots, orders=" + (o ? "YES" : "NO"));
      }
    }
    return r.length > 0 ? r.join(" | ") : "No LabBots or lab orders found";
  } else {
    var t = Game.rooms[e];
    if (!t) return "No vision in " + e;
    var n = Memory.labOrders && Memory.labOrders[e];
    var o = n && (n.active || n.queue && n.length > 0);
    var u = _.filter(getRoomState.creepIndex().all, function(r) {
      return r.memory.role === "labBot" && (r.memory.homeRoom === e || r.memory.assignedRoom === e || r.room.name === e);
    });
    var s = [];
    s.push("Room: " + e);
    s.push("Active orders: " + (o ? "YES" : "NO"));
    s.push("LabBots: " + u.length);
    if (u.length > 0) {
      s.push("Names: " + u.map(function(e) {
        return e.name;
      }).join(", "));
    }
    return s.join(" | ");
  }
};
