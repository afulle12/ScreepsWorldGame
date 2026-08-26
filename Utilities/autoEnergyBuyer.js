// LLM: Read docs/codex.js before reviewing or changing this file.
// autoEnergyBuyer.js
// Console globals: compareEnergyCost, runAutoEnergyBuyer
// Example: compareEnergyCost(100000) - Compare buying energy directly vs refinement
// Example: runAutoEnergyBuyer() - Trigger automated energy buyer cycle across rooms
const marketBuyer = require("marketBuy");
const util = require("util");
const pricing = require("marketPricing");
const creditLedger = require("creditLedger");
const storageManager = require("storageManager");
const factoryManager = require("factoryManager");
const localRefine = require("localRefine");
const marketBatchBuy = require("marketBatchBuy");
const TIERS = [ {
  label: "normal",
  threshold: 25e4,
  buyAmount: 1e5,
  forceEnergy: false
}, {
  label: "emergency",
  threshold: 1e5,
  buyAmount: 2e5,
  forceEnergy: true
}, {
  label: "critical",
  threshold: 5e4,
  buyAmount: 25e4,
  forceEnergy: true
} ];
const ENERGY_PER_BATTERY = 10;
const BATTERIES_PER_BATCH = 50;
const MAX_ENERGY_PER_RUN = 3e5;
// Direct purchase (dealing against a live SELL order) versus a standing bid.
// The two are not priced on the same basis: when someone fills OUR buy order
// they call deal() and pay the terminal transfer, but when we take THEIR ask we
// are the dealer and pay it ourselves -- in energy, the very thing we are
// buying. A seller 60 rooms away costs ~86% of the shipment in freight, so the
// only meaningful comparison is credits per unit that actually lands.
const MIN_DIRECT_TAKE = 1e3; // ignore dust asks; one deal should be worth the intent
const DIRECT_PREMIUM = {
  normal: 1,
  urgent: 1.5
};
const ENERGY_QUEUE = "energy";
const ENERGY_JOB = {
  queue: ENERGY_QUEUE
};
const autoEnergyBuyer = {
  getBestSellPrice: function(e) {
    const o = pricing.getPriceProfile(e);
    return o && typeof o.buyPrice === "number" ? o.buyPrice : null;
  },
  getTotalOnOrder: function(e, o) {
    let t = 0;
    for (const r in Game.market.orders) {
      const n = Game.market.orders[r];
      const a = util.getOrderRemaining(n);
      if (n.roomName === e && n.resourceType === o && n.type === ORDER_BUY && a > 0) {
        t += a;
      }
    }
    return t;
  },
  // Amount already committed through direct purchase jobs, so the passive
  // order is sized against the real outstanding total for this resource.
  getDirectOnOrder: function(e, o) {
    var t = marketBatchBuy && typeof marketBatchBuy.getOpenJobs === "function" ? marketBatchBuy.getOpenJobs() : [];
    var r = 0;
    for (var n = 0; n < t.length; n++) {
      var a = t[n];
      if (a && a.roomName === e && a.resourceType === o) {
        r += Math.max(0, (a.amount || 0) - (a.fulfilled || 0));
      }
    }
    return r;
  },
  // Cheapest live ask in credits per unit delivered here. The freight math and
  // the yield floor belong to marketPricing; this only adds the execution
  // constraint that is ours -- an order big enough to be worth an intent.
  bestDirectOffer: function(e, o, t) {
    var r = pricing.deliveredBuyQuote(o, t, e);
    if (!r || r.take < MIN_DIRECT_TAKE) return null;
    return r;
  },
  bestDirectEnergyOffer: function(e, o) {
    return this.bestDirectOffer(e, RESOURCE_ENERGY, o);
  },
  // Take the cheapest delivered ask when it beats resting a bid. The bid leg
  // is the comparison, never the blended acquisition price -- that already
  // contains this route, and comparing it against itself always ties.
  // Returns the NET amount committed so the passive order can be sized around
  // it (for energy, freight comes out of the shipment).
  tryDirectPurchase: function(e, o, t, r, n) {
    var a = e.name;
    var l = this.bestDirectOffer(a, o, t);
    if (!l) return 0;
    var s = o === RESOURCE_ENERGY ? "/e" : "/u";
    var i = n ? DIRECT_PREMIUM.urgent : DIRECT_PREMIUM.normal;
    var c = typeof r === "number" && r > 0 ? r * i : null;
    if (c !== null && l.delivered > c) {
      console.log("[AutoBuy] " + a + ": best direct " + o + " ask " + l.price.toFixed(3) + " from " + l.sellerRoom + " delivers at " + l.delivered.toFixed(3) + s + " after " + l.freight + " freight — above the " + r.toFixed(3) + " standing bid" + (n ? " x" + i : "") + "; staying passive.");
      return 0;
    }
    var d = e.terminal ? e.terminal.store[RESOURCE_ENERGY] || 0 : 0;
    if (d < l.freight) {
      console.log("[AutoBuy] " + a + ": direct " + o + " purchase needs " + l.freight + " terminal energy for freight, have " + d + "; staying passive.");
      return 0;
    }
    var u = marketBatchBuy.create({
      roomName: a,
      resourceType: o,
      amount: l.take,
      orderId: l.orderId,
      orderRoomName: l.sellerRoom,
      orderPrice: l.price,
      maxPrice: l.price,
      energyCost: l.freight,
      queue: ENERGY_QUEUE,
      ownerId: "autoEnergyBuyer_" + a + "_" + o
    });
    if (!u.ok) {
      console.log("[AutoBuy] " + a + ": direct " + o + " purchase refused — " + u.reason);
      return 0;
    }
    console.log("[AutoBuy] " + a + ": buying " + l.take + " " + o + " directly from " + l.sellerRoom + " at " + l.price.toFixed(3) + " (freight " + l.freight + ", net " + l.net + ", delivered " + l.delivered.toFixed(3) + s + " vs " + (typeof r === "number" && r > 0 ? r.toFixed(3) : "n/a") + " standing bid)" + (u.existing ? " [existing job]" : ""));
    return u.existing ? 0 : l.net;
  },
  tryDirectEnergyPurchase: function(e, o, t, r) {
    return this.tryDirectPurchase(e, RESOURCE_ENERGY, o, t, r);
  },
  hasEnergyProductionOrder: function(e) {
    var o = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
    return !!o.find(function(o) {
      return o.room === e && o.product === RESOURCE_ENERGY && (o.status === "active" || o.status === "queued");
    });
  },
  hasActiveProductionOrder: function(e) {
    var o = factoryManager && typeof factoryManager.getOrders === "function" ? factoryManager.getOrders() : [];
    return !!o.find(function(o) {
      return o.room === e && o.product !== RESOURCE_ENERGY && (o.status === "active" || o.status === "queued");
    });
  },
  hasActiveLocalRefineBatteryOp: function(e) {
    var o = localRefine && typeof localRefine.getOperations === "function" ? localRefine.getOperations() : [];
    return !!o.find(function(o) {
      return o && o.room === e && o.output === RESOURCE_BATTERY && o.phase !== "done" && o.phase !== "failed" && o.phase !== "error" && o.phase !== "cancelled";
    });
  },
  getUnreservedBatteries: function(e) {
    const o = storageManager.storageFind(e, RESOURCE_BATTERY);
    return o && o.combined ? Math.max(0, o.combined.available || 0) : 0;
  },
  handleBatteryRoute: function(e, o, t, r, n) {
    const a = e.name;
    const l = Math.ceil(o / ENERGY_PER_BATTERY);
    const s = e.storage ? e.storage.store[RESOURCE_BATTERY] || 0 : 0;
    const u = e.terminal ? e.terminal.store[RESOURCE_BATTERY] || 0 : 0;
    const i = this.getTotalOnOrder(a, RESOURCE_BATTERY) + this.getDirectOnOrder(a, RESOURCE_BATTERY);
    const c = this.getUnreservedBatteries(a);
    const E = c + i;
    let y = l - E;
    const g = n != null ? " vs " + n.toFixed(4) + "/e direct" + " (saving " + ((n - r) / n * 100).toFixed(1) + "%)" : " (no energy sell orders found)";
    console.log("[AutoBuy] " + a + ": battery route" + " | " + (t != null ? t.toFixed(4) : "n/a") + "/bat → " + (r != null ? r.toFixed(4) : "n/a") + "/e" + g + " | need " + l + " bat" + " | storage: " + s + " terminal: " + u + " | on order: " + i + " | deficit: " + y);
    if (this.hasActiveLocalRefineBatteryOp(a)) {
      console.log("[AutoBuy] " + a + ": active localRefine battery sale; not converting its output back to energy.");
    } else if (c >= BATTERIES_PER_BATCH) {
      if (!this.hasEnergyProductionOrder(a)) {
        const e = global.orderFactory(a, RESOURCE_ENERGY, "max");
        console.log("[AutoBuy] " + a + ": factory energy order placed → " + e);
      } else {
        console.log("[AutoBuy] " + a + ": factory energy production already in progress.");
      }
    } else {
      console.log("[AutoBuy] " + a + ": only " + c + " batteries available (need " + BATTERIES_PER_BATCH + " per batch).");
    }
    if (y <= 0) {
      console.log("[AutoBuy] " + a + ": battery supply fully covered — no market order needed.");
      return;
    }
    // Batteries take the same two routes as energy. Their freight does not
    // come out of the shipment -- the full count arrives and the energy is a
    // separate cost -- but it is a cost, and deliveredBuyQuote prices it.
    y -= this.tryDirectPurchase(e, RESOURCE_BATTERY, y, this.batteryBid, false);
    if (y <= 0) {
      console.log("[AutoBuy] " + a + ": battery deficit covered by the direct purchase — no standing order needed.");
      return;
    }
    console.log("[AutoBuy] " + a + ": buying " + y + " batteries" + " (~" + Math.round(y * ENERGY_PER_BATTERY / 1e3) + "k energy equiv)" + " at " + t.toFixed(4) + "/bat");
    const R = marketBuyer.marketBuy(a, RESOURCE_BATTERY, y, undefined, ENERGY_JOB);
    if (typeof R === "number") {
      console.log("[AutoBuy] " + a + ": marketBuy(BATTERY) → " + (R === OK ? "OK" : "ERR " + R));
    } else {
      console.log("[AutoBuy] " + a + ": marketBuy(BATTERY) → " + R);
    }
  },
  handleEnergyRoute: function(e, o, t, i) {
    const r = e.name;
    const n = this.getTotalOnOrder(r, RESOURCE_ENERGY) + this.getDirectOnOrder(r, RESOURCE_ENERGY);
    let a = o - n;
    const l = t != null ? t.toFixed(4) + "/e" : "market price";
    console.log("[AutoBuy] " + r + ": energy route" + " | need " + Math.round(o / 1e3) + "k" + ", on order " + Math.round(n / 1e3) + "k" + ", deficit " + Math.round(a / 1e3) + "k" + " at " + l);
    if (a <= 0) {
      console.log("[AutoBuy] " + r + ": sufficient orders already active — skipping.");
      return;
    }
    // Take a cheap ask outright before resting a bid nobody has to fill.
    a -= this.tryDirectEnergyPurchase(e, a, this.energyBid, !!i);
    if (a <= 0) {
      console.log("[AutoBuy] " + r + ": deficit covered by the direct purchase — no standing order needed.");
      return;
    }
    const s = marketBuyer.marketBuy(r, RESOURCE_ENERGY, a, undefined, ENERGY_JOB);
    if (typeof s === "number") {
      console.log("[AutoBuy] " + r + ": marketBuy(ENERGY) → " + (s === OK ? "OK" : "ERR " + s));
    } else {
      console.log("[AutoBuy] " + r + ": marketBuy(ENERGY) → " + s);
    }
  },
  run: function() {
    if (!Game.market || creditLedger.available() < .01) {
      console.log("[AutoBuy] ERROR: Market not available or insufficient credits");
      return;
    }
    if (Memory.autoEnergyBuyer) {
      delete Memory.autoEnergyBuyer.orderSnapshots;
      if (Object.keys(Memory.autoEnergyBuyer).length === 0) delete Memory.autoEnergyBuyer;
    }
    // Route choice compares acquisition cost, not book price: each resource is
    // priced at the cheaper of resting a bid or taking a live ask with freight
    // included, so the battery detour is only chosen when it is genuinely
    // cheaper per unit of energy than simply buying energy.
    const q = pricing.acquisitionQuote(RESOURCE_ENERGY);
    const Q = pricing.acquisitionQuote(RESOURCE_BATTERY);
    const e = q.price > 0 ? q.price : null;
    const o = Q.price > 0 ? Q.price : null;
    // The bid legs are what the direct route is measured against per room.
    this.energyBid = q.bid;
    this.batteryBid = Q.bid;
    const t = o != null ? o / ENERGY_PER_BATTERY : null;
    const r = t != null && (e == null || t <= e);
    console.log("[AutoBuy] energy " + (e != null ? e.toFixed(4) : "n/a") + "/e [" + q.route + (q.direct ? " " + q.direct.sellerRoom + " +" + Math.round((1 - q.direct.yield) * 100) + "% freight" : "") + "]" + " | battery " + (o != null ? o.toFixed(4) : "n/a") + "/bat [" + Q.route + "] = " + (t != null ? t.toFixed(4) : "n/a") + "/e" + " | route: " + (r ? "BATTERY" : "ENERGY"));
    let n = 0;
    for (const a in Game.rooms) {
      const l = Game.rooms[a];
      if (!l.controller || !l.controller.my || !l.storage) continue;
      if (!l.terminal) {
        if (l.controller.level >= 6 && Game.time % 1e3 === 0) {
          console.log("[AutoBuy] WARNING: " + a + " has no terminal — skipping.");
        }
        continue;
      }
      const s = l.storage.store[RESOURCE_ENERGY] || 0;
      let u = 0;
      let i = 0;
      const c = [];
      for (const e of TIERS) {
        if (s < e.threshold) {
          if (e.forceEnergy) {
            u += e.buyAmount;
          } else {
            i += e.buyAmount;
          }
          c.push(e.label + " (<" + Math.round(e.threshold / 1e3) + "k → +" + Math.round(e.buyAmount / 1e3) + "k" + (e.forceEnergy ? " energy-only" : "") + ")");
        }
      }
      const E = u + i;
      const y = Math.min(E, MAX_ENERGY_PER_RUN);
      const g = E > MAX_ENERGY_PER_RUN;
      if (E === 0) {
        const e = this.getUnreservedBatteries(a);
        if (this.hasActiveLocalRefineBatteryOp(a)) {
          console.log("[AutoBuy] " + a + ": active localRefine battery sale; leaving produced batteries for marketSell.");
        } else if (e >= BATTERIES_PER_BATCH && !this.hasEnergyProductionOrder(a)) {
          const o = global.orderFactory(a, RESOURCE_ENERGY, "max");
          console.log("[AutoBuy] " + a + " | storage: " + Math.round(s / 1e3) + "k — above thresholds" + " but " + e + " idle batteries; factory conversion triggered → " + o);
        }
        continue;
      }
      n++;
      console.log("[AutoBuy] " + a + " | storage: " + Math.round(s / 1e3) + "k" + " | tiers triggered: " + c.join(", ") + " | energy-only: " + Math.round(u / 1e3) + "k" + " | price-optimal: " + Math.round(i / 1e3) + "k" + (g ? " | cap applied: " + Math.round(y / 1e3) + "k of " + Math.round(E / 1e3) + "k" : ""));
      let R = u;
      let d = i;
      if (g) {
        R = Math.min(u, MAX_ENERGY_PER_RUN);
        d = Math.max(0, Math.min(i, MAX_ENERGY_PER_RUN - R));
      }
      if (R > 0) {
        this.handleEnergyRoute(l, R, e, true);
      }
      if (d > 0) {
        const n = this.hasActiveLocalRefineBatteryOp(a);
        const s = this.hasActiveProductionOrder(a);
        if (r && !n) {
          if (s) {
            console.log("[AutoBuy] " + a + ": factory busy with another order; queueing battery conversion behind it.");
          }
          this.handleBatteryRoute(l, d, o, t, e);
        } else {
          if (n && r) {
            console.log("[AutoBuy] " + a + ": localRefine battery sale active — buying energy directly instead of reclaiming sale output.");
          }
          this.handleEnergyRoute(l, d, e, false);
        }
      }
    }
    if (n === 0) {
      console.log("[AutoBuy] Checked all rooms; no rooms needed energy.");
    }
  }
};
global.compareEnergyCost = function(e) {
  e = typeof e === "number" && e > 0 ? Math.ceil(e) : 1e5;
  if (!Game.market) {
    console.log("[AutoBuy] Market not available.");
    return;
  }
  const q = pricing.acquisitionQuote(RESOURCE_ENERGY, e);
  const Q = pricing.acquisitionQuote(RESOURCE_BATTERY, Math.ceil(e / ENERGY_PER_BATTERY));
  const o = q.price > 0 ? q.price : null;
  const t = Q.price > 0 ? Q.price : null;
  const r = Math.ceil(e / ENERGY_PER_BATTERY);
  const n = o != null ? o * e : null;
  const a = t != null ? t * r : null;
  const l = t != null ? t / ENERGY_PER_BATTERY : null;
  const fmtPrice = e => e != null ? e.toFixed(4) : "no orders";
  const fmtCr = e => e != null ? e.toFixed(2) + " cr" : "N/A";
  const fmtNum = e => e.toLocaleString();
  const s = Math.round(e / 1e3) + "k";
  const leg = (quote, unit) => {
    const rows = [];
    rows.push("      rest a bid   : " + (quote.bid != null ? fmtPrice(quote.bid) + unit : "no canonical bid") + "  (freight-free — the filler deals)");
    if (quote.direct) {
      rows.push("      take an ask  : " + fmtPrice(quote.direct.delivered) + unit + "  (" + quote.direct.price.toFixed(4) + " from " + quote.direct.sellerRoom + " → " + quote.direct.destinationRoom + ", freight " + fmtNum(quote.direct.freight) + " energy" + (quote.direct.resource === RESOURCE_ENERGY ? ", " + Math.round(quote.direct.yield * 100) + "% lands" : "") + ")");
    } else {
      rows.push("      take an ask  : none reachable (over the ceiling, or freight eats the shipment)");
    }
    rows.push("      → cheaper route: " + quote.route);
    return rows.join("\n");
  };
  console.log("=== Energy Cost Comparison (" + s + " energy) ===");
  console.log("  Energy    (direct) : " + fmtPrice(o) + "/e" + "              →  " + fmtCr(n) + "  (" + fmtNum(e) + " energy)");
  console.log(leg(q, "/e"));
  console.log("  Batteries (" + ENERGY_PER_BATTERY + "e/bat) : " + fmtPrice(t) + "/bat (= " + fmtPrice(l) + "/e)" + "  →  " + fmtCr(a) + "  (" + fmtNum(r) + " batteries)");
  console.log(leg(Q, "/bat"));
  if (n != null && a != null) {
    const e = n - a;
    const o = Math.abs(e / n * 100).toFixed(1);
    const t = Math.abs(e).toFixed(2);
    if (e > 0) {
      console.log("  ✓ Batteries cheaper by " + t + " cr  (" + o + "% saving)");
    } else if (e < 0) {
      console.log("  ✓ Energy cheaper by " + t + " cr  (" + o + "% saving)");
    } else {
      console.log("  = Same cost either way.");
    }
  } else if (n == null && a != null) {
    console.log("  ✓ Batteries only option (no energy market data found).");
  } else if (a == null && n != null) {
    console.log("  ✓ Energy only option (no battery market data found).");
  } else {
    console.log("  ✗ No market data found for either resource.");
  }
};
global.runAutoEnergyBuyer = function() {
  autoEnergyBuyer.run();
};
module.exports = autoEnergyBuyer;
