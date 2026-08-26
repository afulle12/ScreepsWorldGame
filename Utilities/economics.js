// LLM: Read docs/codex.js before reviewing or changing this file.
// economics.js
// Console globals: econReport
// Example: econReport('summary') - Generate empire-wide resource and credit economic report
//   econReport()           -> per-activity contribution ranking (what produced value today)
//   econReport('room')     -> per-room contribution (operating performance by location)
//   econReport('resource') -> per-resource contribution (value created per resource type)
var memoryManager = require("memoryManager");
var pricing = require("marketPricing");
var util = require("util");
var VERSION = 6;
var ACTIVITY_CODES = {
  sourceHarvest: "h",
  controllerUpgrade: "u",
  construction: "c",
  repairs: "r",
  creepRenewal: "cr",
  marketSales: "s",
  marketPurchases: "b",
  factory: "f",
  labsForward: "l",
  labsReverse: "v",
  depositHarvest: "d",
  mineralHarvest: "mh",
  mineralCollection: "m",
  scavenger: "sc",
  powerProcessing: "pp"
};
var METRIC_CODES = {
  rev: "r",
  out: "o",
  input: "i",
  energy: "e",
  fee: "f",
  spawn: "s",
  powerQty: "pu",
  energyQty: "eu"
};
var SPAWN_ROLE_CODES = {
  harvester: "h",
  upgrader: "u",
  builder: "b",
  scout: "s",
  defender: "d",
  supplier: "p",
  claimbot: "c",
  attacker: "a",
  harasser: "x",
  healer: "l",
  extractor: "e",
  thief: "t",
  towerDrain: "td",
  demolition: "dm",
  quad: "q",
  mineralCollector: "mc",
  terminalBot: "tb",
  signbot: "sg",
  wallRepair: "wr",
  labBot: "lb",
  nukeFill: "nf",
  remoteBuilder: "rb",
  depositHarvester: "dh",
  powerBot: "pb",
  maintainer: "mt",
  contestedDemolisher: "cd",
  drainDemolisher: "dd",
  skAttacker: "sk",
  defenseRepair: "dr",
  hd: "hd",
  staticDistributor: "sd",
  comboBot: "cb",
  rampartBot: "rr",
  remoteSupplier: "rs",
  controllerAttacker: "ca",
  towerFiller: "tf",
  extractorAssistant: "ea",
  repairer: "rp",
  scavenger: "sv",
  unknown: "?"
};
var ACTIVITY_NAMES = {};
for (var activityName in ACTIVITY_CODES) {
  ACTIVITY_NAMES[ACTIVITY_CODES[activityName]] = activityName;
}
var SPAWN_ROLE_NAMES = {};
for (var roleName in SPAWN_ROLE_CODES) {
  SPAWN_ROLE_NAMES[SPAWN_ROLE_CODES[roleName]] = roleName;
}
var patchedSpawn = false;
var patchedRenewal = false;
var patchedCreeps = false;
var patchedPowerSpawn = false;
var priceCache = {};
var priceCacheTick = -1;
var powerProcessingSaveTick = -1;
var POWER_PROCESS_POWER = 1;
var POWER_PROCESS_ENERGY = 50;
function dayKey() {
  return util.pacificDayKey();
}

function emptyDay(e) {
  return {
    d: e,
    a: {},
    r: {},
    p: {}
  };
}

function roundMetrics(e) {
  if (!e || typeof e !== "object") return;
  for (var r in e) {
    if (!e.hasOwnProperty(r) || !e[r]) continue;
    for (var t in e[r]) {
      if (typeof e[r][t] === "number" && isFinite(e[r][t])) {
        e[r][t] = Math.round(e[r][t]);
      }
    }
  }
}

function activityCode(e) {
  if (ACTIVITY_CODES[e]) return ACTIVITY_CODES[e];
  if (e.indexOf("spawn:") === 0) return spawnActivityCode(e.slice(6));
  if (e.indexOf("z:") === 0) return spawnActivityCode(e.slice(2));
  if (e.indexOf("z~") === 0 || e.charAt(0) === "z" && SPAWN_ROLE_NAMES[e.slice(1)]) return e;
  return e;
}

function spawnActivityCode(e) {
  return SPAWN_ROLE_CODES[e] ? "z" + SPAWN_ROLE_CODES[e] : "z~" + e;
}

function displayActivity(e) {
  if (ACTIVITY_NAMES[e]) return ACTIVITY_NAMES[e];
  if (e.indexOf("z~") === 0) return "spawn:" + e.slice(2);
  if (e.charAt(0) === "z" && SPAWN_ROLE_NAMES[e.slice(1)]) {
    return "spawn:" + SPAWN_ROLE_NAMES[e.slice(1)];
  }
  if (e.indexOf("z:") === 0) return "spawn:" + e.slice(2);
  return e;
}

function compactRows(e, r) {
  var t = {};
  if (!e || typeof e !== "object") return t;
  for (var a in e) {
    if (!e.hasOwnProperty(a) || !e[a]) continue;
    var o = r ? activityCode(a) : a;
    if (!t[o]) t[o] = {};
    addMetrics(t[o], e[a]);
  }
  return t;
}

function migrateMemory(e) {
  if (e.v >= VERSION) return false;
  if (e.day) {
    roundMetrics(e.day.a);
    roundMetrics(e.day.r);
    roundMetrics(e.day.p);
    e.day.a = compactRows(e.day.a, true);
    e.day.r = compactRows(e.day.r, false);
    e.day.p = compactRows(e.day.p, false);
    removeQuantity(e.day.a);
    removeQuantity(e.day.r);
    removeQuantity(e.day.p);
  }
  delete e.history;
  e.v = VERSION;
  return true;
}

function removeQuantity(e) {
  if (!e || typeof e !== "object") return;
  for (var r in e) {
    if (!e.hasOwnProperty(r) || !e[r]) continue;
    delete e[r].q;
    delete e[r].qty;
  }
}

function ensureMemory() {
  var e = dayKey();
  if (!Memory.economics || typeof Memory.economics !== "object" || typeof Memory.economics.v === "number" && Memory.economics.v > VERSION) {
    Memory.economics = {
      v: VERSION,
      day: emptyDay(e)
    };
    memoryManager.requestSave();
  }
  var r = Memory.economics;
  if (typeof r.v !== "number") r.v = 1;
  if (migrateMemory(r)) memoryManager.requestSave();
  if (!r.day || r.day.d !== e) {
    r.day = emptyDay(e);
    memoryManager.requestImmediateSave("economics.rollover");
  }
  return r;
}

function addNumber(e, r, t) {
  if (typeof t !== "number" || !isFinite(t) || t === 0) return;
  e[r] = Math.round((e[r] || 0) + t);
}

function addMetrics(e, r) {
  for (var t in r) {
    if (t === "qty" || t === "q") continue;
    addNumber(e, METRIC_CODES[t] || t, r[t]);
  }
}

function record(e, r, t, a) {
  if (!e || !a) return;
  var o = ensureMemory().day;
  var n = activityCode(e);
  if (!o.a[n]) o.a[n] = {};
  addMetrics(o.a[n], a);
  if (r) {
    if (!o.r[r]) o.r[r] = {};
    addMetrics(o.r[r], a);
  }
  if (t) {
    if (!o.p[t]) o.p[t] = {};
    addMetrics(o.p[t], a);
  }
}

function resourcePrice(e) {
  if (!e) return 0;
  if (priceCacheTick !== Game.time) {
    priceCacheTick = Game.time;
    priceCache = {};
  }
  if (priceCache[e] !== undefined) return priceCache[e];
  var r = pricing.getPriceProfile(e);
  var t = e === RESOURCE_ENERGY ? pricing.getStatusEnergyPrice() : r && r.marketPrice;
  if (typeof t !== "number" || !isFinite(t) || t < 0) t = 0;
  if (!(t > 0) && pricing && typeof pricing.getDerivedSellFloor === "function") {
    t = pricing.getDerivedSellFloor(e) || 0;
  }
  priceCache[e] = t;
  return t;
}

function value(e, r) {
  return (r || 0) * resourcePrice(e);
}

function recordProduction(e, r, t, a, o) {
  var n = 0;
  var i = 0;
  for (var c in o) {
    var p = o[c] || 0;
    if (c === RESOURCE_ENERGY) i += p; else n += value(c, p);
  }
  record(e, r, t, {
    out: value(t, a),
    input: n,
    energy: value(RESOURCE_ENERGY, i),
    qty: a
  });
}

function recordMarket(e, r, t, a, o, n) {
  var i = {
    qty: a
  };
  if (e === "sale") i.rev = o; else i.input = o;
  if (n) i.energy = value(RESOURCE_ENERGY, n);
  record(e === "sale" ? "marketSales" : "marketPurchases", r, t, i);
}

function requestPowerProcessingSave() {
  if (powerProcessingSaveTick === Game.time) return;
  powerProcessingSaveTick = Game.time;
  if (typeof memoryManager.willSave !== "function" || !memoryManager.willSave()) {
    memoryManager.requestImmediateSave("economics.powerProcessing");
  }
}

function recordPowerProcessing(e) {
  record("powerProcessing", e, RESOURCE_POWER, {
    input: value(RESOURCE_POWER, POWER_PROCESS_POWER),
    powerQty: POWER_PROCESS_POWER
  });
  record("powerProcessing", e, RESOURCE_ENERGY, {
    energy: value(RESOURCE_ENERGY, POWER_PROCESS_ENERGY),
    energyQty: POWER_PROCESS_ENERGY
  });
  requestPowerProcessingSave();
}

function patchSpawnCreep() {
  if (patchedSpawn || typeof StructureSpawn === "undefined") return;
  var e = StructureSpawn.prototype.spawnCreep;
  if (!e || e._economicsWrapped) {
    patchedSpawn = true;
    return;
  }
  var wrapped = function(r, t, a) {
    var o = e.call(this, r, t, a);
    if (o === OK) {
      var n = a && a.memory || {};
      var i = n.role || "unknown";
      var c = n.homeRoom || n.assignedRoom || this.room.name;
      var p = util.bodyCost(r);
      record("spawn:" + i, c, RESOURCE_ENERGY, {
        spawn: value(RESOURCE_ENERGY, p),
        qty: 1
      });
    }
    return o;
  };
  wrapped._economicsWrapped = true;
  StructureSpawn.prototype.spawnCreep = wrapped;
  patchedSpawn = true;
}

function patchSpawnRenewCreep() {
  if (patchedRenewal || typeof StructureSpawn === "undefined") return;
  var e = StructureSpawn.prototype.renewCreep;
  if (!e || e._economicsWrapped) {
    patchedRenewal = true;
    return;
  }
  var wrapped = function(r) {
    var t = e.apply(this, arguments);
    if (t === OK && r && r.memory && r.memory.role === "harvester" && r.body && r.body.length > 0) {
      var a = Math.ceil(SPAWN_RENEW_RATIO * util.bodyCost(r.body) / CREEP_SPAWN_TIME / r.body.length);
      if (a > 0) {
        record("creepRenewal", this.room && this.room.name, RESOURCE_ENERGY, {
          energy: value(RESOURCE_ENERGY, a)
        });
      }
    }
    return t;
  };
  wrapped._economicsWrapped = true;
  StructureSpawn.prototype.renewCreep = wrapped;
  patchedRenewal = true;
}

function patchPowerSpawnProcess() {
  if (patchedPowerSpawn || typeof StructurePowerSpawn === "undefined") return;
  var e = StructurePowerSpawn.prototype.processPower;
  if (!e || e._economicsWrapped) {
    patchedPowerSpawn = true;
    return;
  }
  var wrapped = function() {
    var r = e.apply(this, arguments);
    if (r === OK) {
      recordPowerProcessing(this.room && this.room.name);
    }
    return r;
  };
  wrapped._economicsWrapped = true;
  StructurePowerSpawn.prototype.processPower = wrapped;
  patchedPowerSpawn = true;
}

function activeWork(e) {
  return e.getActiveBodyparts(WORK);
}

function wrapCreepAction(e, r, t) {
  var a = Creep.prototype[e];
  if (!a || a._economicsWrapped) return;
  var wrapped = function(e) {
    var o = a.apply(this, arguments);
    if (o === OK) {
      var n = t(this, e);
      if (n > 0) record(r, this.room.name, RESOURCE_ENERGY, {
        energy: value(RESOURCE_ENERGY, n),
        qty: n
      });
    }
    return o;
  };
  wrapped._economicsWrapped = true;
  Creep.prototype[e] = wrapped;
}

function patchCreepActions() {
  if (patchedCreeps || typeof Creep === "undefined") return;
  var e = Creep.prototype.harvest;
  if (e && !e._economicsWrapped) {
    var wrappedHarvest = function(r) {
      var t = r && (typeof r.energy === "number" ? r.energy : typeof r.mineralAmount === "number" ? r.mineralAmount : null);
      var a = e.apply(this, arguments);
      if (a === OK && typeof t === "number") {
        var o = typeof r.mineralAmount === "number";
        if (o) {
          var n = Math.min(t, activeWork(this) * HARVEST_MINERAL_POWER);
          if (n > 0 && r.mineralType) {
            record("mineralHarvest", this.room.name, r.mineralType, {
              out: value(r.mineralType, n),
              qty: n
            });
          }
        } else {
          var i = Math.min(t, activeWork(this) * HARVEST_POWER, this.store.getFreeCapacity(RESOURCE_ENERGY));
          if (i > 0) record("sourceHarvest", this.room.name, RESOURCE_ENERGY, {
            out: value(RESOURCE_ENERGY, i),
            qty: i
          });
        }
      }
      return a;
    };
    wrappedHarvest._economicsWrapped = true;
    Creep.prototype.harvest = wrappedHarvest;
  }
  wrapCreepAction("upgradeController", "controllerUpgrade", function(e) {
    return Math.min(activeWork(e) * UPGRADE_CONTROLLER_POWER, e.store[RESOURCE_ENERGY] || 0);
  });
  wrapCreepAction("build", "construction", function(e, r) {
    var t = r ? r.progressTotal - r.progress : 0;
    return Math.min(activeWork(e), e.store[RESOURCE_ENERGY] || 0, Math.ceil(t / BUILD_POWER));
  });
  wrapCreepAction("repair", "repairs", function(e, r) {
    var t = r ? r.hitsMax - r.hits : 0;
    return Math.min(activeWork(e), e.store[RESOURCE_ENERGY] || 0, Math.ceil(t / REPAIR_POWER));
  });
  patchedCreeps = true;
}

function run() {
  ensureMemory();
  patchSpawnCreep();
  patchSpawnRenewCreep();
  patchPowerSpawnProcess();
  patchCreepActions();
}

function contribution(e) {
  return (e.r || 0) + (e.o || 0) - (e.i || 0) - (e.e || 0) - (e.f || 0) - (e.s || 0);
}

function shortNum(e) {
  if (!e) return "0";
  var r = Math.abs(Math.round(e));
  var t = e < 0 ? "-" : "";
  if (r >= 1e6) return t + (r / 1e6).toFixed(2) + "M";
  if (r >= 1e3) return t + (r / 1e3).toFixed(1) + "K";
  return t + String(r);
}

function padLeft(e, r) {
  e = String(e);
  return e.length >= r ? e : " ".repeat(r - e.length) + e;
}

function padRight(e, r) {
  e = String(e);
  return e.length >= r ? e : e + " ".repeat(r - e.length);
}

var COLUMNS = [ [ "Revenue", "r" ], [ "Output", "o" ], [ "Inputs", "i" ], [ "Energy", "e" ], [ "Fees", "f" ], [ "Spawn", "s" ] ];
var USAGE_COLUMNS = [ [ "GPLPwr", "pu" ], [ "GPLEng", "eu" ] ];
function report(e) {
  var r = ensureMemory();
  var t = e === "room" ? "r" : e === "resource" ? "p" : "a";
  var a = r.day[t];
  var o = Object.keys(a).sort(function(e, r) {
    return contribution(a[r]) - contribution(a[e]);
  });
  var n = padRight("Name", 26);
  for (var i = 0; i < COLUMNS.length; i++) n += padLeft(COLUMNS[i][0], 9);
  n += padLeft("Contrib", 10);
  for (var c = 0; c < USAGE_COLUMNS.length; c++) {
    n += padLeft(USAGE_COLUMNS[c][0], 9);
  }
  var p = [ "======== ECONOMICS " + r.day.d + " BY " + (e || "activity").toUpperCase() + " ========", "Costs use event-time replacement prices; GPLPwr/GPLEng are raw processing inputs.", n ];
  var u = {};
  var s = {};
  var d = 0;
  for (var f = 0; f < o.length; f++) {
    var E = o[f], v = a[E];
    var m = t === "a" ? displayActivity(E) : E;
    var S = padRight(m, 26);
    for (var y = 0; y < COLUMNS.length; y++) {
      var R = COLUMNS[y][1];
      S += padLeft(shortNum(v[R]), 9);
      u[R] = (u[R] || 0) + (v[R] || 0);
    }
    var l = contribution(v);
    d += l;
    S += padLeft((l >= 0 ? "+" : "") + shortNum(l), 10);
    for (var C = 0; C < USAGE_COLUMNS.length; C++) {
      var O = USAGE_COLUMNS[C][1];
      S += padLeft(shortNum(v[O]), 9);
      s[O] = (s[O] || 0) + (v[O] || 0);
    }
    p.push(S);
  }
  var h = padRight("TOTAL", 26);
  for (var P = 0; P < COLUMNS.length; P++) h += padLeft(shortNum(u[COLUMNS[P][1]]), 9);
  h += padLeft((d >= 0 ? "+" : "") + shortNum(d), 10);
  for (var w = 0; w < USAGE_COLUMNS.length; w++) {
    h += padLeft(shortNum(s[USAGE_COLUMNS[w][1]]), 9);
  }
  p.push(h);
  console.log(p.join("\n"));
}

function powerProcessingSummary() {
  var e = ensureMemory().day;
  var r = e.a[activityCode("powerProcessing")] || {};
  return {
    day: e.d,
    power: r.pu || 0,
    energy: r.eu || 0,
    powerCost: r.i || 0,
    energyCost: r.e || 0,
    cost: (r.i || 0) + (r.e || 0)
  };
}

module.exports = {
  run: run,
  record: record,
  recordProduction: recordProduction,
  recordMarket: recordMarket,
  recordPowerProcessing: recordPowerProcessing,
  value: value,
  report: report,
  resourcePrice: resourcePrice,
  powerProcessingSummary: powerProcessingSummary,
  POWER_PROCESS_POWER: POWER_PROCESS_POWER,
  POWER_PROCESS_ENERGY: POWER_PROCESS_ENERGY
};
global.econReport = function(e) {
  report(e);
};
