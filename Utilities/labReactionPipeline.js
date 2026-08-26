// LLM: Read docs/codex.js before reviewing or changing this file.
// labReactionPipeline.js
var MIN_REACTION_AMOUNT = require("labCommodityPolicy").MIN_REACTION_AMOUNT;
function own(e, r) {
  return Object.prototype.hasOwnProperty.call(e, r);
}

function reactionMap() {
  var e = {};
  if (typeof REACTIONS === "undefined" || !REACTIONS) return e;
  for (var r in REACTIONS) {
    if (!own(REACTIONS, r) || !REACTIONS[r]) continue;
    for (var t in REACTIONS[r]) {
      if (!own(REACTIONS[r], t)) continue;
      var n = REACTIONS[r][t];
      if (!e[n]) e[n] = [ r, t ];
    }
  }
  return e;
}

function reactionInputs(e, r) {
  var t = r && r[e];
  return t ? [ t[0], t[1] ] : null;
}

function addAmount(e, r, t) {
  if (!r || !(t > 0)) return;
  e[r] = (e[r] || 0) + t;
}

function sortedKeys(e) {
  return Object.keys(e || {}).sort();
}

function makeStageId(e, r) {
  return (e === "synthesis" ? "synth:" : "decomp:") + r;
}

function buildSynthesis(e, r, t) {
  var n = {};
  var o = {};
  var a = {};
  var s = {};
  var i = 0;
  function expand(e, r, u) {
    if (!(r > 0)) return;
    var d = reactionInputs(e, t);
    if (!d) {
      addAmount(o, e, r);
      return;
    }
    if (a[e]) throw new Error("reaction cycle at " + e);
    a[e] = true;
    addAmount(n, e, r);
    s[e] = Math.max(s[e] || 0, u);
    i = Math.max(i, u);
    expand(d[0], r, u + 1);
    expand(d[1], r, u + 1);
    delete a[e];
  }
  expand(e, r, 1);
  var u = [];
  var d = sortedKeys(n);
  d.sort(function(e, r) {
    return (s[r] || 0) - (s[e] || 0) || e.localeCompare(r);
  });
  for (var l = 0; l < d.length; l++) {
    var c = d[l];
    var f = reactionInputs(c, t);
    var p = [];
    for (var m = 0; m < f.length; m++) {
      if (n[f[m]]) p.push(f[m]);
    }
    u.push({
      id: makeStageId("synthesis", c),
      mode: "synthesis",
      product: c,
      inputs: f,
      amount: n[c],
      dependencies: p,
      depth: s[c] || 1
    });
  }
  return {
    mode: "synthesis",
    root: e,
    amount: r,
    stages: u,
    leaves: o,
    finalOutputs: function() {
      var t = {};
      t[e] = r;
      return t;
    }(),
    depth: i
  };
}

function buildDecomposition(e, r, t) {
  var n = {};
  var o = {};
  var a = {};
  var s = {};
  var i = 0;
  var u = [];
  function expand(e, r, d) {
    if (!(r > 0)) return;
    var l = reactionInputs(e, t);
    if (!l) {
      addAmount(o, e, r);
      return;
    }
    if (a[e]) throw new Error("reaction cycle at " + e);
    a[e] = true;
    addAmount(n, e, r);
    s[e] = Math.max(s[e] || 0, d);
    i = Math.max(i, d);
    u.push(e);
    expand(l[0], r, d + 1);
    expand(l[1], r, d + 1);
    delete a[e];
  }
  expand(e, r, 1);
  var d = {};
  var l = [];
  for (var c = 0; c < u.length; c++) {
    var f = u[c];
    if (d[f]) continue;
    d[f] = true;
    var p = reactionInputs(f, t);
    var m = [];
    for (var v = 0; v < p.length; v++) {
      if (n[p[v]]) m.push(p[v]);
    }
    l.push({
      id: makeStageId("decompose", f),
      mode: "decompose",
      product: f,
      inputs: [ f ],
      outputs: p,
      amount: n[f],
      dependencies: m,
      depth: s[f] || 1
    });
  }
  return {
    mode: "decompose",
    root: e,
    amount: r,
    stages: l,
    leaves: o,
    finalOutputs: o,
    depth: i
  };
}

function containsResource(e, r) {
  if (!e || !r) return false;
  if (e.leaves && e.leaves[r] > 0) return true;
  if (e.stages) {
    for (var t = 0; t < e.stages.length; t++) {
      var n = e.stages[t];
      if (n.product === r) return true;
      if (n.inputs && n.inputs.indexOf(r) >= 0) return true;
      if (n.outputs && n.outputs.indexOf(r) >= 0) return true;
    }
  }
  return e.root === r;
}

function normalizeAmount(e) {
  e = Math.floor(Number(e) || 0);
  if (e <= 0 || e % MIN_REACTION_AMOUNT !== 0) return 0;
  return e;
}

function validatePlan(e) {
  var r = [];
  var t = {};
  var n = {};
  if (!e || !e.ok || !Array.isArray(e.stages) || e.stages.length === 0) {
    return {
      ok: false,
      errors: [ "plan has no stages" ]
    };
  }
  for (var o = 0; o < e.stages.length; o++) {
    var a = e.stages[o];
    if (!a || !a.id || t[a.id]) r.push("stage IDs must be unique");
    if (a && a.id) {
      t[a.id] = true;
      n[a.product] = o;
    }
    if (!a || !(a.amount > 0) || a.amount % MIN_REACTION_AMOUNT !== 0) {
      r.push("stage amounts must be positive multiples of " + MIN_REACTION_AMOUNT);
    }
    if (a && a.mode !== e.mode) r.push("stage mode does not match plan mode");
  }
  for (var s = 0; s < e.stages.length; s++) {
    var i = e.stages[s];
    var u = i.dependencies || [];
    for (var d = 0; d < u.length; d++) {
      var l = n[u[d]];
      if (l === undefined) {
        r.push("missing dependency stage " + u[d]);
      } else if (e.mode === "synthesis" && l >= s) {
        r.push("synthesis dependency order is not executable for " + i.product);
      } else if (e.mode === "decompose" && l <= s) {
        r.push("decomposition dependency order is not executable for " + i.product);
      }
    }
  }
  return {
    ok: r.length === 0,
    errors: r
  };
}

function selfTest(e) {
  e = normalizeAmount(e || MIN_REACTION_AMOUNT);
  var r = {
    ok: true,
    products: 0,
    failures: [],
    invalidProducts: []
  };
  var t = reactionMap();
  if (Object.keys(t).length === 0) {
    r.ok = false;
    r.failures.push("REACTIONS is unavailable or empty");
    return r;
  }
  if (t.XK) r.invalidProducts.push("XK");
  if (t.H2O) r.invalidProducts.push("H2O");
  if (r.invalidProducts.length > 0) {
    r.ok = false;
    r.failures.push("invalid products present: " + r.invalidProducts.join(", "));
  }
  for (var n in t) {
    if (!own(t, n)) continue;
    r.products++;
    var o = build("synthesis", n, e);
    var a = build("decompose", n, e);
    if (!o.ok) r.failures.push("synthesis " + n + ": " + o.reason);
    if (!a.ok) r.failures.push("decomposition " + n + ": " + a.reason);
  }
  if (t.XKH2O) {
    var s = normalizeAmount(e || 1500);
    var i = build("synthesis", "XKH2O", s);
    var u = build("decompose", "XKH2O", s);
    var d = {
      K: s,
      H: s * 2,
      O: s,
      X: s
    };
    function sameAmounts(e, r) {
      var t = Object.keys(r);
      for (var n = 0; n < t.length; n++) {
        if ((e && e[t[n]]) !== r[t[n]]) return false;
      }
      return e && Object.keys(e).length === t.length;
    }
    function sameProducts(e, r) {
      if (!e || e.length !== r.length) return false;
      var t = e.slice().sort();
      var n = r.slice().sort();
      for (var o = 0; o < n.length; o++) {
        if (t[o] !== n[o]) return false;
      }
      return true;
    }
    function expectedDecompositionOrder(e, r, n) {
      var o = t[e];
      if (!o || n[e]) return;
      n[e] = true;
      r.push(e);
      expectedDecompositionOrder(o[0], r, n);
      expectedDecompositionOrder(o[1], r, n);
    }
    var l = [];
    expectedDecompositionOrder("XKH2O", l, {});
    if (!i.ok || !sameAmounts(i.leaves, d) || !sameProducts(i.stages.map(function(e) {
      return e.product;
    }), [ "KH", "OH", "KH2O", "XKH2O" ])) {
      r.failures.push("XKH2O synthesis graph does not match K/H/O/X waterfall");
    }
    if (!u.ok || !sameAmounts(u.finalOutputs, d) || u.stages.map(function(e) {
      return e.product;
    }).join(",") !== l.join(",")) {
      r.failures.push("XKH2O decomposition graph does not match reverse waterfall");
    }
  }
  r.ok = r.ok && r.failures.length === 0;
  return r;
}

function build(e, r, t) {
  var n = normalizeAmount(t);
  if (!r || n <= 0) {
    return {
      ok: false,
      reason: "amount must be a positive multiple of " + MIN_REACTION_AMOUNT
    };
  }
  if (e !== "synthesis" && e !== "decompose") {
    return {
      ok: false,
      reason: "mode must be synthesis or decompose"
    };
  }
  var o = reactionMap();
  if (!o[r]) return {
    ok: false,
    reason: "no reaction found for " + r
  };
  var a;
  try {
    a = e === "decompose" ? buildDecomposition(r, n, o) : buildSynthesis(r, n, o);
  } catch (e) {
    return {
      ok: false,
      reason: e && e.message ? e.message : String(e)
    };
  }
  a.ok = true;
  a.requiresAdvancedRoom = a.depth > 1 || containsResource(a, "X");
  a.requiresCatalystRoom = containsResource(a, "X");
  a.stageCount = a.stages.length;
  a.validation = validatePlan(a);
  if (!a.validation.ok) {
    return {
      ok: false,
      reason: a.validation.errors.join("; "),
      validation: a.validation
    };
  }
  return a;
}

function roomSupportsAdvanced(e, r) {
  if (!e || !e.controller || !e.controller.my || e.controller.level < 8) {
    return {
      ok: false,
      reason: "requires an owned RCL8 room"
    };
  }
  var t = Array.isArray(r) ? r.length : 0;
  if (t < 10) return {
    ok: false,
    reason: "requires 10 built labs"
  };
  return {
    ok: true,
    reason: null
  };
}

module.exports = {
  MIN_REACTION_AMOUNT: MIN_REACTION_AMOUNT,
  reactionMap: reactionMap,
  reactionInputs: reactionInputs,
  build: build,
  buildSynthesis: function(e, r) {
    return build("synthesis", e, r);
  },
  buildDecomposition: function(e, r) {
    return build("decompose", e, r);
  },
  containsResource: containsResource,
  normalizeAmount: normalizeAmount,
  validatePlan: validatePlan,
  selfTest: selfTest,
  roomSupportsAdvanced: roomSupportsAdvanced
};
