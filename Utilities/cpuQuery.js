// LLM: Read docs/codex.js before reviewing or changing this file.
// cpuQuery.js
// Console globals: cpu, cpuHelp, cpuHud, cpuJSON
// Example: cpu() - Display per-section CPU profiling breakdown
// Example: cpuHelp() - Show CPU profiling command reference
// Example: cpuHud('E1N1') - Enable or toggle room-level visual CPU HUD
// Example: cpuJSON() - Return CPU performance metrics formatted as JSON
const heap = require("memoryManager").heap;
const cpuSchedulerPolicy = require("cpuSchedulerPolicy");
global.cpuHelp = function() {
  console.log("==============================================================");
  console.log("|         CPU SCHEDULER - CONSOLE COMMANDS                  |");
  console.log("==============================================================");
  console.log("|  cpu()            Detailed scheduler status report         |");
  console.log("|  cpuHud('W1N1')   Enable live RoomVisual overlay          |");
  console.log("|  cpuHud()         Disable the HUD overlay                  |");
  console.log("|  cpuJSON()        Dump stats as JSON                       |");
  console.log("==============================================================");
};
global.cpu = function() {
  const e = heap.cpuStats || {};
  console.log("==============================================================");
  console.log("|           CPU SCHEDULER STATUS                            |");
  console.log("==============================================================");
  console.log("| Bucket:     " + (typeof e.bucket === "number" ? e.bucket : "?") + " / 10000");
  console.log("| Tier:       " + (e.lastBudgetTier || "?"));
  console.log("| Budget:     " + (typeof e.lastBudget === "number" ? e.lastBudget.toFixed(1) : "?") + " CPU");
  console.log("| CPU limit:  " + (typeof e.lastCpuLimit === "number" ? e.lastCpuLimit.toFixed(1) : "?") + " CPU");
  console.log("| Tick limit: " + (typeof e.lastTickLimit === "number" ? e.lastTickLimit.toFixed(1) : "?") + " CPU");
  console.log("| Serialize:  " + (e.lastWillSave ? "yes" : "no"));
  console.log("| Mem reserve:" + (e.lastSerializationCost || 0).toFixed(3) + " CPU amortized" + " (" + ((e.lastSerializationHitRate || 0) * 100).toFixed(1) + "% saves) + " + (e.lastSafetyBuffer || 0).toFixed(1) + " buffer");
  console.log("| Pressure:   " + (e.lastPressure || 0) + "%");
  console.log("| Base press: " + (e.lastBasePressure || 0) + "%");
  console.log("| Avg CPU:    " + (e.average ? e.average.toFixed(2) : "?"));
  console.log("| Throttled:  " + (e.lastSectionsThrottled || 0) + " sections, " + (e.lastCreepsThrottled || 0) + " creeps");
  console.log("| Scheduled:  " + (e.lastSectionsDeferred || 0) + " sections deferred");
  console.log("| Cost-gated: " + (e.lastSectionsCostThrottled || 0) + " sections");
  console.log("| Budget gate:" + (e.lastSectionsBudgetDeferred || 0) + " sections; " + (e.lastSectionsBudgetLateRun || 0) + " late, " + (e.lastSectionsBudgetBurstRun || 0) + " burst, " + (e.lastSectionsBudgetPending || 0) + " pending");
  console.log("==============================================================");
  const o = e.memorySaves;
  if (o && o.ticks) {
    const e = o.saves / o.ticks * 100;
    console.log("| Memory saves: " + o.saves + "/" + o.ticks + " ticks (" + e.toFixed(1) + "%)");
    console.log("| Save causes:  scheduled=" + (o.scheduled || 0) + " requested=" + (o.requested || 0) + " manual=" + (o.manual || 0));
    console.log("| Save now:     " + (o.currentReason || "none") + " (" + (o.currentRequestCalls || 0) + " requests)");
    console.log("==============================================================");
  }
  if (e.history && e.history.length > 0) {
    const o = e.history.slice(-20);
    const t = Math.max.apply(null, o);
    const s = o.map(function(e) {
      const o = t > 0 ? e / t : 0;
      if (o > .875) return "#";
      if (o > .75) return "8";
      if (o > .625) return "7";
      if (o > .5) return "6";
      if (o > .375) return "5";
      if (o > .25) return "4";
      if (o > .125) return "3";
      return ".";
    }).join("");
    console.log("| History:    " + s + " (peak " + t.toFixed(1) + ")");
  }
  if (heap.cpuSectionStats) {
    console.log("========== ADAPTIVE SECTION COSTS ===================");
    const e = [];
    for (const o in heap.cpuSectionStats) {
      const t = heap.cpuSectionStats[o];
      if (!t || !(t.runs > 0)) continue;
      e.push({
        name: o,
        estimate: cpuSchedulerPolicy.estimateSectionCost(t, Game.time),
        stat: t
      });
    }
    e.sort(function(e, o) {
      return o.estimate - e.estimate;
    });
    for (let o = 0; o < Math.min(e.length, 15); o++) {
      const t = e[o];
      const s = t.stat;
      const l = s.pendingSince !== null && s.pendingSince !== undefined ? " pending=" + (Game.time - s.pendingSince) + "t" : "";
      const c = t.estimate;
      console.log("|  " + t.name + ": est=" + c.toFixed(3) + " avg=" + (s.average || 0).toFixed(3) + " peak=" + (s.peak || 0).toFixed(3) + " last=" + (s.last || 0).toFixed(3) + " interval=" + (s.effectiveInterval || 1) + l);
    }
  }
  if (heap.marketLabScheduler) {
    const e = heap.marketLabScheduler;
    console.log("========== MARKETLAB SLICE ==========================");
    console.log("| Last:       " + (e.lastCpu || 0).toFixed(3) + " CPU, " + (e.lastProcessed || 0) + " processed / " + (e.lastVisited || 0) + " visited");
    console.log("| Yielded:    " + (e.lastYielded ? "yes" : "no") + " (" + (e.totalYields || 0) + " total)");
  }
  if (heap.autoTraderCpu) {
    console.log("========== AUTOTRADER PHASES ========================");
    const e = [ "analysis", "minerals", "residue" ];
    for (let o = 0; o < e.length; o++) {
      const t = e[o];
      const s = heap.autoTraderCpu[t];
      if (!s) continue;
      const l = [];
      for (const e in s.phases) {
        l.push(e + "=" + s.phases[e].toFixed(3));
      }
      console.log("|  " + t + ": total=" + (s.total || 0).toFixed(3) + " CPU" + " tick=" + s.tick + (l.length > 0 ? " | " + l.join(", ") : ""));
    }
  }
  if (heap.cpuProfile) {
    console.log("========== SECTION AVERAGES =========================");
    const e = [];
    for (var t in heap.cpuProfile) {
      var s = heap.cpuProfile[t];
      var l = s.reduce(function(e, o) {
        return e + o;
      }, 0) / s.length;
      e.push({
        name: t,
        avg: l
      });
    }
    e.sort(function(e, o) {
      return o.avg - e.avg;
    });
    for (var n = 0; n < Math.min(e.length, 15); n++) {
      var a = e[n];
      console.log("|  " + a.name + ": " + a.avg.toFixed(3) + " CPU");
    }
  }
  if (heap.cpuProfileCreeps) {
    console.log("========== CREEP ROLE AVERAGES =====================");
    var c = [];
    for (var r in heap.cpuProfileCreeps) {
      var i = heap.cpuProfileCreeps[r];
      var u = i.reduce(function(e, o) {
        return e + o;
      }, 0) / i.length;
      c.push({
        name: r,
        avg: u
      });
    }
    c.sort(function(e, o) {
      return o.avg - e.avg;
    });
    for (var g = 0; g < c.length; g++) {
      var d = c[g];
      console.log("|  " + d.name + ": " + d.avg.toFixed(3) + " CPU");
    }
  }
  console.log("==============================================================");
};
global.cpuHud = function(e) {
  if (!e) {
    delete Memory.cpuHudRoom;
    console.log("[CPU HUD] Disabled.");
  } else {
    Memory.cpuHudRoom = e;
    console.log("[CPU HUD] Enabled on " + e + ". Call cpuHud() to disable.");
  }
};
global.cpuJSON = function() {
  console.log(JSON.stringify({
    summary: heap.cpuStats || {},
    sections: heap.cpuSectionStats || {},
    marketLab: heap.marketLabScheduler || {},
    autoTrader: heap.autoTraderCpu || {}
  }));
};
module.exports = {};
