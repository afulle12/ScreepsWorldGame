// LLM: Read docs/codex.js before reviewing or changing this file.
// roomCPUProfiler.js
// Console globals: profileRoom, cancelRoomProfile, roomProfileStatus, profileNeighbors
// Example: profileRoom('W5N3') - Run detailed per-tick CPU profiling on room
// Example: cancelRoomProfile() - Stop active room CPU profiling
// Example: roomProfileStatus() - Display room CPU profiling status and collected samples
// Example: profileNeighbors('W5N3') - Profile CPU for room and all neighboring rooms
/**
 * roomCPUProfiler.js  (v10 — room profiling with own-room fallback)
 * ==============================================
 * Profile a single room, visible rooms owned by the current player, or the
 * own-room fallback used when foreign-player scanning is unavailable.
 *
 *   profileRoom('W5N3')        — single room (own or foreign)
 *   profileRoom('PlayerName')  — own visible rooms when PlayerName is yours;
 *                                 foreign-player discovery is unavailable here
 *                                 because scanner wide scans are asynchronous.
 *   profileNeighbors()         — profile own visible rooms; foreign neighbor
 *                                 discovery is unavailable in this module.
 *                                 Prints the ranked report + Game.notify.
 *   roomProfileStatus()        — check progress of an active profile
 *                                 single mode: ticks done, running avg,
 *                                   current CPU breakdown
 *                                 player mode: rooms completed, current room
 *                                   ticks,
 *                                   per-room results so far
 *                                 neighbors mode: own-room fallback progress,
 *                                   profiled rooms, running averages
 *   cancelRoomProfile()        — abort at any point
 *
 * Usage: call the globals above from the Screeps console.
 * Example: profileRoom('W5N3'); roomProfileStatus();
 */
"use strict";
const scanner = require("scanner");
const wideScan = {
  start: function(e) {
    console.log('[RoomCPUProfiler] Foreign player scan for "' + e + '" is no longer supported in this file (wideScan was merged into scanner.js).');
  },
  startPlayers: function() {
    console.log("[RoomCPUProfiler] Neighbor scan is no longer supported in this file (wideScan was merged into scanner.js).");
  },
  cancel: function() {}
};
const PROFILE_TICKS = 100;
const MAX_OBSERVERS = 2;
const LOG_INTERVAL = 25;
const MEM_KEY = "roomCPUProfile";
const GLOBAL_PREV = "__cpuProfilerPrev";
const OBSERVER_SOURCE = "roomCPUProfiler";
const CPU_SIMPLE = .2;
const CPU_TOWER = .4;
const CPU_LAB = .4;
const MOVE_CPU_OPT = .2;
const MOVE_CPU_TYP = .5;
const MOVE_CPU_NAIVE = 2;
const EV_ATTACK = 1;
const EV_OBJECT_DESTROYED = 2;
const EV_ATTACK_CONTROLLER = 3;
const EV_BUILD = 4;
const EV_HARVEST = 5;
const EV_HEAL = 6;
const EV_REPAIR = 7;
const EV_RESERVE_CONTROLLER = 8;
const EV_UPGRADE_CONTROLLER = 9;
const EV_EXIT = 10;
const EV_POWER = 11;
const EV_TRANSFER = 12;
const EV_ATTACK_NUKE = 6;
const EV_ATTACK_HIT_BACK = 5;
const EV_ATTACK_RANGED = 2;
const EV_ATTACK_RANGED_MASS = 3;
const EV_ATTACK_DISMANTLE = 4;
const ROOM_NAME_RE = /^[WE]\d+[NS]\d+$/;
function isRoomName(e) {
  return ROOM_NAME_RE.test(e);
}

function isOwnRoom(e) {
  const o = Game.rooms[e];
  return !!(o && o.controller && o.controller.my);
}

function findObservers(e) {
  return scanner.utils.findObserversInRange(e).slice(0, MAX_OBSERVERS).map(o => ({
    observer: o,
    dist: Game.map.getRoomLinearDistance(o.room.name, e),
    room: o.room.name
  }));
}

function fireObservers(e) {
  const o = findObservers(e);
  const t = scanner.observe.request(e, OBSERVER_SOURCE, scanner.observe.PRI.MONITOR, {
    untilConsumed: true,
    holdTicks: 5
  }) ? 1 : 0;
  return {
    count: o.length,
    fired: t
  };
}

function getPrev(e) {
  return global[GLOBAL_PREV] && global[GLOBAL_PREV][e] || null;
}

function setPrev(e, o) {
  if (!global[GLOBAL_PREV]) global[GLOBAL_PREV] = {};
  global[GLOBAL_PREV][e] = o;
}

function clearPrev(e) {
  if (global[GLOBAL_PREV]) delete global[GLOBAL_PREV][e];
}

function clearAllPrev() {
  delete global[GLOBAL_PREV];
}

function takeSnapshot(e) {
  const o = {
    creepPos: {},
    terminal: null,
    labs: {},
    factory: null,
    spawns: {},
    nuker: null,
    powerSpawn: null,
    constructionSites: 0,
    controllerSafeMode: 0
  };
  for (const t of e.find(FIND_CREEPS)) o.creepPos[t.id] = {
    x: t.pos.x,
    y: t.pos.y
  };
  for (const t of e.find(FIND_POWER_CREEPS)) o.creepPos["pc_" + t.id] = {
    x: t.pos.x,
    y: t.pos.y
  };
  for (const t of e.find(FIND_STRUCTURES)) {
    switch (t.structureType) {
     case STRUCTURE_TERMINAL:
      o.terminal = {
        cooldown: t.cooldown || 0
      };
      break;
     case STRUCTURE_LAB:
      o.labs[t.id] = {
        cooldown: t.cooldown || 0
      };
      break;
     case STRUCTURE_FACTORY:
      o.factory = {
        id: t.id,
        cooldown: t.cooldown || 0
      };
      break;
     case STRUCTURE_SPAWN:
      o.spawns[t.id] = {
        spawning: !!t.spawning
      };
      break;
     case STRUCTURE_NUKER:
      o.nuker = {
        id: t.id,
        cooldown: t.cooldown || 0
      };
      break;
     case STRUCTURE_POWER_SPAWN:
      o.powerSpawn = {
        id: t.id,
        power: t.store[RESOURCE_POWER] || 0
      };
      break;
     default:
      break;
    }
  }
  if (e.controller) o.controllerSafeMode = e.controller.safeMode || 0;
  o.constructionSites = e.find(FIND_CONSTRUCTION_SITES).length;
  return o;
}

function emptyEvDetail() {
  return {
    intents: 0,
    harvest: 0,
    build: 0,
    upgradeController: 0,
    reserveController: 0,
    attackController: 0,
    transfer: 0,
    attackMelee: 0,
    attackRangedMass: 0,
    dismantle: 0,
    healMelee: 0,
    powerAbility: 0,
    repairAny: 0,
    attackRangedAny: 0,
    healRangedAny: 0,
    objectsDestroyed: 0,
    nukeDetonations: 0,
    hitBacks: 0
  };
}

function processEventLog(e) {
  let o;
  try {
    o = JSON.parse(e.getEventLog(true));
  } catch (t) {
    o = e.getEventLog();
  }
  if (!o || !o.length) return {
    intents: 0,
    detail: emptyEvDetail()
  };
  const t = emptyEvDetail();
  let r = 0;
  for (const e of o) {
    switch (e.event) {
     case EV_ATTACK:
      {
        const o = e.data && e.data.attackType;
        if (o === EV_ATTACK_NUKE) {
          t.nukeDetonations++;
        } else if (o === EV_ATTACK_HIT_BACK) {
          t.hitBacks++;
        } else {
          r++;
          if (o === EV_ATTACK_RANGED) t.attackRangedAny++; else if (o === EV_ATTACK_RANGED_MASS) t.attackRangedMass++; else if (o === EV_ATTACK_DISMANTLE) t.dismantle++; else t.attackMelee++;
        }
        break;
      }
     case EV_OBJECT_DESTROYED:
      t.objectsDestroyed++;
      break;
     case EV_ATTACK_CONTROLLER:
      r++;
      t.attackController++;
      break;
     case EV_BUILD:
      r++;
      t.build++;
      break;
     case EV_HARVEST:
      r++;
      t.harvest++;
      break;
     case EV_HEAL:
      {
        r++;
        if ((e.data && e.data.healType) === 2) t.healRangedAny++; else t.healMelee++;
        break;
      }
     case EV_REPAIR:
      r++;
      t.repairAny++;
      break;
     case EV_RESERVE_CONTROLLER:
      r++;
      t.reserveController++;
      break;
     case EV_UPGRADE_CONTROLLER:
      r++;
      t.upgradeController++;
      break;
     case EV_EXIT:
      break;
     case EV_POWER:
      r++;
      t.powerAbility++;
      break;
     case EV_TRANSFER:
      r++;
      t.transfer++;
      break;
     default:
      break;
    }
  }
  t.intents = r;
  return {
    intents: r,
    detail: t
  };
}

function emptyDiffDetail() {
  return {
    creepMoves: 0,
    powerCreepMoves: 0,
    terminalSends: 0,
    labReactions: 0,
    factoryProduces: 0,
    spawnEvents: 0,
    nukerFired: 0,
    powerProcessed: 0,
    constructionSites: 0,
    safeModeActivated: 0
  };
}

function diffSnapshots(e, o) {
  const t = emptyDiffDetail();
  for (const r in o.creepPos) {
    const n = o.creepPos[r];
    const s = e.creepPos[r];
    if (!s) continue;
    if (n.x !== s.x || n.y !== s.y) {
      if (r.startsWith("pc_")) t.powerCreepMoves++; else t.creepMoves++;
    }
  }
  if (o.terminal && e.terminal && e.terminal.cooldown === 0 && o.terminal.cooldown > 0) t.terminalSends++;
  for (const r in o.labs) {
    const n = o.labs[r];
    const s = e.labs[r];
    if (s && s.cooldown === 0 && n.cooldown > 0) t.labReactions++;
  }
  if (o.factory && e.factory && e.factory.cooldown === 0 && o.factory.cooldown > 0) t.factoryProduces++;
  for (const r in o.spawns) {
    const n = o.spawns[r];
    const s = e.spawns[r];
    if (s && !s.spawning && n.spawning) t.spawnEvents++;
  }
  if (o.nuker && e.nuker && e.nuker.cooldown === 0 && o.nuker.cooldown > 0) {
    t.nukerFired++;
    const e = Game.getObjectById(o.nuker.id);
    console.log("[RoomCPUProfiler] ⚠ NUKE LAUNCHED from " + (e ? e.room.name : "?") + " tick " + Game.time);
  }
  if (o.powerSpawn && e.powerSpawn) {
    const r = e.powerSpawn.power - o.powerSpawn.power;
    if (r > 0) t.powerProcessed += r;
  }
  const r = o.constructionSites - e.constructionSites;
  if (r > 0) t.constructionSites += r;
  if (e.controllerSafeMode === 0 && o.controllerSafeMode > 0) {
    t.safeModeActivated++;
    console.log("[RoomCPUProfiler] ⚠ SAFE MODE ACTIVATED tick " + Game.time);
  }
  return {
    detail: t
  };
}

function calcCPU(e) {
  const o = e.ev_harvest + e.ev_build + e.ev_upgradeController + e.ev_reserveController + e.ev_attackController + e.ev_transfer + e.ev_attackMelee + e.ev_attackRangedMass + e.ev_dismantle + e.ev_healMelee + e.ev_powerAbility + e.diff_terminalSends + e.diff_factoryProduces + e.diff_spawnEvents + e.diff_nukerFired + e.diff_powerProcessed + e.diff_constructionSites + e.diff_safeModeActivated;
  const t = o * CPU_SIMPLE;
  const r = e.diff_labReactions * CPU_LAB;
  const n = e.ev_repairAny + e.ev_attackRangedAny + e.ev_healRangedAny;
  const s = e.diff_creepMoves + e.diff_powerCreepMoves;
  return {
    simpleIntents: o,
    simpleCPU: t,
    labCPU: r,
    ambig: n,
    ambigLow: n * CPU_SIMPLE,
    ambigHigh: n * CPU_TOWER,
    moves: s,
    moveLow: s * MOVE_CPU_OPT,
    moveMid: s * MOVE_CPU_TYP,
    moveHigh: s * MOVE_CPU_NAIVE,
    totalLow: t + r + n * CPU_SIMPLE + s * MOVE_CPU_OPT,
    totalMid: t + r + n * CPU_TOWER + s * MOVE_CPU_TYP,
    totalHigh: t + r + n * CPU_TOWER + s * MOVE_CPU_NAIVE
  };
}

function initTotals() {
  return {
    ticksObserved: 0,
    creepCountSum: 0,
    invisibleTicks: 0,
    ev_harvest: 0,
    ev_build: 0,
    ev_upgradeController: 0,
    ev_reserveController: 0,
    ev_attackController: 0,
    ev_transfer: 0,
    ev_attackMelee: 0,
    ev_attackRangedMass: 0,
    ev_dismantle: 0,
    ev_healMelee: 0,
    ev_powerAbility: 0,
    ev_repairAny: 0,
    ev_attackRangedAny: 0,
    ev_healRangedAny: 0,
    ev_objectsDestroyed: 0,
    ev_nukeDetonations: 0,
    diff_creepMoves: 0,
    diff_powerCreepMoves: 0,
    diff_terminalSends: 0,
    diff_labReactions: 0,
    diff_factoryProduces: 0,
    diff_spawnEvents: 0,
    diff_nukerFired: 0,
    diff_powerProcessed: 0,
    diff_constructionSites: 0,
    diff_safeModeActivated: 0
  };
}

function accumulateTotals(e, o) {
  for (const t in o) {
    if (typeof o[t] === "number") e[t] = (e[t] || 0) + o[t];
  }
}

function accumulateEventDetail(e, o, t) {
  e.ev_harvest += o.harvest;
  e.ev_build += o.build;
  e.ev_upgradeController += o.upgradeController;
  e.ev_reserveController += o.reserveController;
  e.ev_attackController += o.attackController;
  e.ev_transfer += o.transfer;
  e.ev_attackMelee += o.attackMelee;
  e.ev_attackRangedMass += o.attackRangedMass;
  e.ev_dismantle += o.dismantle;
  e.ev_healMelee += o.healMelee;
  e.ev_powerAbility += o.powerAbility;
  e.ev_repairAny += o.repairAny;
  e.ev_attackRangedAny += o.attackRangedAny;
  e.ev_healRangedAny += o.healRangedAny;
  e.ev_objectsDestroyed += o.objectsDestroyed;
  e.ev_nukeDetonations += o.nukeDetonations;
  e.diff_creepMoves += t.creepMoves;
  e.diff_powerCreepMoves += t.powerCreepMoves;
  e.diff_terminalSends += t.terminalSends;
  e.diff_labReactions += t.labReactions;
  e.diff_factoryProduces += t.factoryProduces;
  e.diff_spawnEvents += t.spawnEvents;
  e.diff_nukerFired += t.nukerFired;
  e.diff_powerProcessed += t.powerProcessed;
  e.diff_constructionSites += t.constructionSites;
  e.diff_safeModeActivated += t.safeModeActivated;
}

function buildRoomReport(e, o, t, r) {
  const n = calcCPU(o);
  const s = o.ticksObserved;
  const i = s > 0 ? (o.creepCountSum / s).toFixed(1) : "0";
  const a = r ? "own" : t + " obs";
  function f(e) {
    return e.toFixed(2);
  }
  function fp(e) {
    return e.toFixed(3);
  }
  function row(e, o, t) {
    if (!o) return null;
    return "  │    " + e.padEnd(30) + ": " + String(o).padStart(5) + "  (" + f(o * t) + " CPU)";
  }
  const l = "─".repeat(62);
  const c = [ "  ┌" + l + "┐", "  │  " + e.padEnd(14) + " ticks=" + String(s).padStart(3) + "  creeps=" + i + "  invis=" + o.invisibleTicks + "  [" + a + "]", "  ├" + l + "┤" ];
  const m = [ row("harvest", o.ev_harvest, CPU_SIMPLE), row("build", o.ev_build, CPU_SIMPLE), row("upgradeController", o.ev_upgradeController, CPU_SIMPLE), row("reserveController", o.ev_reserveController, CPU_SIMPLE), row("attackController", o.ev_attackController, CPU_SIMPLE), row("transfer/withdraw", o.ev_transfer, CPU_SIMPLE), row("attackMelee", o.ev_attackMelee, CPU_SIMPLE), row("rangedMassAttack", o.ev_attackRangedMass, CPU_SIMPLE), row("dismantle", o.ev_dismantle, CPU_SIMPLE), row("healMelee", o.ev_healMelee, CPU_SIMPLE), row("powerAbility", o.ev_powerAbility, CPU_SIMPLE), row("terminal sends", o.diff_terminalSends, CPU_SIMPLE), row("factory produce", o.diff_factoryProduces, CPU_SIMPLE), row("spawn events", o.diff_spawnEvents, CPU_SIMPLE), row("nuker launches", o.diff_nukerFired, CPU_SIMPLE), row("power processed", o.diff_powerProcessed, CPU_SIMPLE), row("new construct sites", o.diff_constructionSites, CPU_SIMPLE), row("safe mode", o.diff_safeModeActivated, CPU_SIMPLE) ].filter(Boolean);
  if (m.length) {
    c.push("  │  simple intents (~0.2 each):");
    for (const e of m) c.push(e);
  }
  const d = [ o.diff_labReactions > 0 ? "  │    " + "lab reactions/boosts".padEnd(30) + ": " + String(o.diff_labReactions).padStart(5) + "  (" + f(o.diff_labReactions * CPU_LAB) + " CPU)" : null, o.ev_repairAny + o.ev_attackRangedAny + o.ev_healRangedAny > 0 ? "  │    " + "repair+rngdAtk+rngdHeal".padEnd(30) + ": " + String(o.ev_repairAny + o.ev_attackRangedAny + o.ev_healRangedAny).padStart(5) + "  (" + f(n.ambigLow) + "–" + f(n.ambigHigh) + " CPU, ambiguous)" : null ].filter(Boolean);
  if (d.length) {
    c.push("  │  elevated cost (~0.4+ each):");
    for (const e of d) c.push(e);
  }
  if (n.moves > 0) {
    c.push("  │  movement (" + n.moves + " moves):  " + "opt=" + f(n.moveLow) + "  typical=" + f(n.moveMid) + "  naive=" + f(n.moveHigh) + " CPU");
  }
  c.push("  ├" + l + "┤");
  c.push("  │  TOTAL  opt=" + f(n.totalLow) + "  typical=" + f(n.totalMid) + "  naive=" + f(n.totalHigh) + " CPU    (" + fp(n.totalMid / Math.max(1, s)) + "/tick typical)");
  c.push("  └" + l + "┘");
  return c;
}

function printSingleReport(e, o, t, r, n) {
  const s = o.ticksObserved;
  if (!s) {
    console.log("[RoomCPUProfiler] No data collected.");
    return;
  }
  const i = calcCPU(o);
  const a = n ? "OWN ROOM" : "FOREIGN ROOM";
  function f(e) {
    return e.toFixed(2);
  }
  function fp(e) {
    return e.toFixed(3);
  }
  function row(e, o, t) {
    return "  " + e.padEnd(32) + ": " + String(o).padStart(5) + "  (" + f(o * t) + " CPU @ " + t + "/ea)";
  }
  const l = 64;
  const c = "─".repeat(l);
  const m = [ "╬" + "═".repeat(l) + "╬", "  ROOM CPU PROFILE — " + e + "  [" + a + "]", "  Ticks: " + s + " / " + PROFILE_TICKS + "   (game " + t + " – " + (t + s + 1) + ")", c, "  ── SIMPLE INTENTS ~0.2 each ──", row("  Harvest", o.ev_harvest, CPU_SIMPLE), row("  Build", o.ev_build, CPU_SIMPLE), row("  Upgrade controller", o.ev_upgradeController, CPU_SIMPLE), row("  Reserve controller", o.ev_reserveController, CPU_SIMPLE), row("  Attack controller", o.ev_attackController, CPU_SIMPLE), row("  Transfer/Withdraw", o.ev_transfer, CPU_SIMPLE), row("  Attack melee", o.ev_attackMelee, CPU_SIMPLE), row("  Attack ranged mass", o.ev_attackRangedMass, CPU_SIMPLE), row("  Dismantle", o.ev_dismantle, CPU_SIMPLE), row("  Heal melee", o.ev_healMelee, CPU_SIMPLE), row("  Power creep ability", o.ev_powerAbility, CPU_SIMPLE), row("  Terminal sends/deals", o.diff_terminalSends, CPU_SIMPLE), row("  Factory productions", o.diff_factoryProduces, CPU_SIMPLE), row("  Spawn events", o.diff_spawnEvents, CPU_SIMPLE), row("  Nuker launches", o.diff_nukerFired, CPU_SIMPLE), row("  Power processed", o.diff_powerProcessed, CPU_SIMPLE), row("  New construct sites", o.diff_constructionSites, CPU_SIMPLE), row("  Safe mode activated", o.diff_safeModeActivated, CPU_SIMPLE), "  " + "┈".repeat(l - 2), "  Simple CPU: " + f(i.simpleCPU), c, "  ── ELEVATED COST ~0.4+ each ──", "  Lab reactions/boosts     : " + o.diff_labReactions + "  (" + f(i.labCPU) + " CPU)", "  Repair+RngdAtk+RngdHeal  : " + o.ev_repairAny + "/" + o.ev_attackRangedAny + "/" + o.ev_healRangedAny + "  [" + f(i.ambigLow) + "–" + f(i.ambigHigh) + " CPU, ambiguous]", c, "  ── MOVEMENT ──", "  Moves: " + i.moves + "  opt=" + f(i.moveLow) + "  typical=" + f(i.moveMid) + "  naive=" + f(i.moveHigh) + " CPU", c, "  TOTALS", "  Optimized        | " + f(i.totalLow) + "  | " + fp(i.totalLow / s) + "/tick", "  Typical (moveTo) | " + f(i.totalMid) + "  | " + fp(i.totalMid / s) + "/tick  ←", "  Naive (recalc)   | " + f(i.totalHigh) + "  | " + fp(i.totalHigh / s) + "/tick", c, "  avg creeps=" + (o.creepCountSum / s).toFixed(1) + "   invisible=" + o.invisibleTicks + "   " + (n ? "own room" : r + " observer(s)"), "╩" + "═".repeat(l) + "╩" ];
  console.log(m.join("\n"));
  Game.notify(("[RoomCPUProfiler] " + e + " | " + s + " ticks" + " | typical=" + fp(i.totalMid / s) + "/tick" + " | total=" + f(i.totalLow) + "-" + f(i.totalHigh) + " CPU" + " | moves=" + i.moves + " creeps=" + (o.creepCountSum / s).toFixed(1)).slice(0, 398), 0);
}

function printPlayerReport(e, o) {
  if (!o.length) {
    console.log("[RoomCPUProfiler] No rooms profiled for " + e + ".");
    return;
  }
  const t = initTotals();
  for (const e of o) accumulateTotals(t, e.totals);
  const r = calcCPU(t);
  const n = o.reduce((e, o) => e + o.totals.ticksObserved, 0);
  const s = n > 0 ? (t.creepCountSum / n).toFixed(1) : "0";
  function f(e) {
    return e.toFixed(2);
  }
  function fp(e) {
    return e.toFixed(3);
  }
  const i = 66;
  const a = "─".repeat(i);
  let l = 0, c = 0, m = 0, d = 0;
  for (const e of o) {
    const o = calcCPU(e.totals);
    const t = Math.max(1, e.totals.ticksObserved);
    l += o.totalLow / t;
    c += o.totalMid / t;
    m += o.totalHigh / t;
    d += e.totals.creepCountSum / t;
  }
  d = Math.round(d);
  const u = d * .2 + .5;
  const p = d * .35 + 1;
  const P = d * .65 + 1.5;
  const g = l + u;
  const _ = c + p;
  const v = m + P;
  function scaleBar(e, o) {
    const t = 24;
    const r = Math.min(t, Math.round(e / o * t));
    const n = Math.round(e / o * 100);
    const s = e > o;
    return "[" + "█".repeat(r) + "░".repeat(Math.max(0, t - r)) + "] " + f(e) + " CPU/tick" + (s ? " ⚠ OVER " + o : " (" + n + "% of " + o + ")");
  }
  const R = [ "╬" + "═".repeat(i) + "╬", "  PLAYER CPU PROFILE — " + e, "  Rooms profiled: " + o.length + "   Concurrent creeps: ~" + d + "   Avg creeps/room: " + s, a, "  ── CONCURRENT INTENT CPU (all rooms running simultaneously) ──", "  These are the per-tick intent costs when all rooms run in the same tick.", "  (Aggregate ÷ total ticks would undercount by " + o.length + "x for concurrent use.)", "", "  Optimized  (move cached)  : " + scaleBar(l, 20), "  Typical    (moveTo ~0.5)  : " + scaleBar(c, 20) + "  ←", "  Naive      (recalc/tick)  : " + scaleBar(m, 20), "", "  Breakdown: simple=" + f(r.simpleCPU / o.length) + "/room  labs=" + f(r.labCPU / o.length) + "/room  moves=" + f(l) + "-" + f(m) + " total", a, "  ── ESTIMATED TOTAL CPU (intents + script overhead) ──", "  Overhead = script logic per creep + Memory parse + game loop base.", "  ~" + d + " concurrent creeps  ×  0.3-1.0 CPU/creep  +  0.5-1.5 base", "", "  Low    (opt intents + lean script)   : " + scaleBar(g, 40), "  Mid    (typical intents + avg script): " + scaleBar(_, 40) + "  ←", "  Heavy  (naive intents + heavy script): " + scaleBar(v, 40), "", "  Intent share of estimated total (mid): " + Math.round(c / _ * 100) + "% from intents, " + Math.round(p / _ * 100) + "% from script overhead", a, "  ── PER-ROOM BREAKDOWN (sorted by typical CPU, highest first) ──", "" ];
  const E = o.slice().sort((e, o) => calcCPU(o.totals).totalMid - calcCPU(e.totals).totalMid);
  for (const e of E) {
    const o = buildRoomReport(e.roomName, e.totals, e.observerCount, e.ownRoom);
    for (const e of o) R.push(e);
    R.push("");
  }
  R.push("╩" + "═".repeat(i) + "╩");
  console.log(R.join("\n"));
  const C = E.map(e => {
    const o = calcCPU(e.totals);
    return e.roomName + "=" + fp(o.totalMid / Math.max(1, e.totals.ticksObserved)) + "/t";
  }).join(" ");
  Game.notify(("[RoomCPUProfiler] " + e + " | " + o.length + " rooms | " + "intents=" + f(c) + "CPU/tick | est.total=" + f(_) + "CPU/tick | " + C).slice(0, 398), 0);
}

//   prev is in global[GLOBAL_PREV][roomName] — not in Memory
function tickRoom(e) {
  const o = e.roomName;
  const t = e.ownRoom;
  if (!t) {
    const {count: t, fired: r} = fireObservers(o);
    e.observerCount = t;
    if (t > 0 && r === 0 && Game.time % 10 === 0) {
      console.log("[RoomCPUProfiler] WARNING: all observers busy for " + o);
    }
  }
  const r = Game.rooms[o];
  if (!r) {
    e.totals.invisibleTicks++;
    clearPrev(o);
    return false;
  }
  const n = takeSnapshot(r);
  const s = getPrev(o);
  if (!s) {
    setPrev(o, n);
    console.log("[RoomCPUProfiler] Baseline — " + o + " @ tick " + Game.time);
    return false;
  }
  const {intents: i, detail: a} = processEventLog(r);
  const {detail: l} = diffSnapshots(s, n);
  accumulateEventDetail(e.totals, a, l);
  e.totals.ticksObserved++;
  e.totals.creepCountSum += r.find(FIND_CREEPS).length;
  setPrev(o, n);
  const c = e.totals.ticksObserved;
  if (c % LOG_INTERVAL === 0 && c < PROFILE_TICKS) {
    const t = calcCPU(e.totals);
    console.log("[RoomCPUProfiler] " + o + " — " + c + "/" + PROFILE_TICKS + " | typical: ~" + (t.totalMid / c).toFixed(3) + " CPU/tick");
  }
  const m = c >= PROFILE_TICKS;
  if (m && !t) scanner.observe.consume(o, OBSERVER_SOURCE);
  return m;
}

function start(e) {
  if (!e || typeof e !== "string") {
    console.log('[RoomCPUProfiler] Usage: profileRoom("W5N3") or profileRoom("PlayerName")');
    return;
  }
  if (Memory[MEM_KEY] && Memory[MEM_KEY].active) {
    console.log("[RoomCPUProfiler] Already active. Call cancelRoomProfile() first.");
    return;
  }
  clearAllPrev();
  if (isRoomName(e)) {
    const o = isOwnRoom(e);
    let t = 0;
    if (o) {
      console.log("[RoomCPUProfiler] " + e + " is your room — no observer needed.");
    } else {
      const o = findObservers(e);
      t = o.length;
      if (!o.length) {
        console.log("[RoomCPUProfiler] No observer within 10 rooms of " + e + ".");
        return;
      } else {
        console.log("[RoomCPUProfiler] " + o.length + " observer(s): " + o.map(e => e.room + "(d" + e.dist + ")").join(", "));
        scanner.observe.request(e, OBSERVER_SOURCE, scanner.observe.PRI.MONITOR, {
          untilConsumed: true,
          holdTicks: 5
        });
      }
    }
    Memory[MEM_KEY] = {
      mode: "single",
      active: true,
      roomName: e,
      startTick: Game.time,
      ownRoom: o,
      observerCount: t,
      totals: initTotals()
    };
    console.log("[RoomCPUProfiler] Started — " + e + " for " + PROFILE_TICKS + " ticks.");
  } else {
    let o = null;
    for (const e in Game.rooms) {
      const t = Game.rooms[e];
      if (t.controller && t.controller.my && t.controller.owner) {
        o = t.controller.owner.username;
        break;
      }
    }
    const t = o && o.toLowerCase() === e.toLowerCase();
    if (t) {
      const o = [];
      for (const e in Game.rooms) {
        const t = Game.rooms[e];
        if (t.controller && t.controller.my) o.push(e);
      }
      if (!o.length) {
        console.log("[RoomCPUProfiler] No owned rooms found in Game.rooms.");
        return;
      }
      console.log("[RoomCPUProfiler] Self-profile — found " + o.length + " owned room(s): " + o.join(", "));
      console.log("[RoomCPUProfiler] Profiling each room for " + PROFILE_TICKS + " ticks. Est. " + o.length * (PROFILE_TICKS + 3) + " ticks total.");
      Memory[MEM_KEY] = {
        mode: "player",
        active: true,
        playerName: e,
        startTick: Game.time,
        phase: "profiling",
        roomQueue: o.slice(),
        completedRooms: [],
        current: null
      };
      advanceToNextRoom(Memory[MEM_KEY]);
    } else {
      console.log("[RoomCPUProfiler] Player mode — scanning for " + e + "'s rooms via wideScan...");
      wideScan.start(e);
      Memory[MEM_KEY] = {
        mode: "player",
        active: true,
        playerName: e,
        startTick: Game.time,
        phase: "scanning",
        roomQueue: [],
        completedRooms: [],
        current: null
      };
    }
  }
}

function cancel() {
  if (!Memory[MEM_KEY]) {
    console.log("[RoomCPUProfiler] Nothing active.");
    return;
  }
  const e = Memory[MEM_KEY];
  if ((e.mode === "player" || e.mode === "neighbors") && e.phase === "scanning" && Memory.wideScan && Memory.wideScan.active) {
    wideScan.cancel();
  }
  const o = e.mode === "player" ? e.playerName : e.mode === "neighbors" ? "neighbor scan" : e.roomName;
  const t = e.mode === "single" ? e.roomName : e.current && e.current.roomName;
  if (t) scanner.observe.cancel(t, OBSERVER_SOURCE);
  clearAllPrev();
  delete Memory[MEM_KEY];
  console.log("[RoomCPUProfiler] Cancelled. Memory wiped.");
  _ = o;
  console.log("[RoomCPUProfiler] Profile for " + o + " cancelled.");
}

function run() {
  const e = Memory[MEM_KEY];
  if (!e || !e.active) return;
  if (e.mode === "single") runSingle(e); else if (e.mode === "player") runPlayer(e); else if (e.mode === "neighbors") runNeighbors(e);
}

function runSingle(e) {
  const o = {
    roomName: e.roomName,
    ownRoom: e.ownRoom,
    observerCount: e.observerCount,
    totals: e.totals
  };
  const t = tickRoom(o);
  e.observerCount = o.observerCount;
  if (t) {
    printSingleReport(e.roomName, e.totals, e.startTick, e.observerCount, e.ownRoom);
    clearPrev(e.roomName);
    delete Memory[MEM_KEY];
    console.log("[RoomCPUProfiler] Complete. Memory wiped.");
  }
}

function runPlayer(e) {
  if (e.phase === "scanning") {
    const o = Memory.wideScan;
    if (o && o.foundRooms && o.foundRooms.length) {
      e._foundRooms = o.foundRooms.slice();
    }
    if (o && o.active) return;
    const t = e._foundRooms && e._foundRooms.length ? e._foundRooms : [];
    delete e._foundRooms;
    if (!t.length) {
      console.log("[RoomCPUProfiler] wideScan found no rooms for " + e.playerName + ". Aborting.");
      clearAllPrev();
      delete Memory[MEM_KEY];
      return;
    }
    e.roomQueue = t.slice();
    e.phase = "profiling";
    console.log("[RoomCPUProfiler] Found " + t.length + " room(s) for " + e.playerName + ": " + t.join(", "));
    console.log("[RoomCPUProfiler] Profiling each room for " + PROFILE_TICKS + " ticks. Est. " + t.length * (PROFILE_TICKS + 3) + " ticks total.");
    advanceToNextRoom(e);
    return;
  }
  if (e.phase === "profiling") {
    if (!e.current) {
      e.phase = "done";
    } else {
      const o = e.current;
      const t = tickRoom(o);
      e.current = o;
      if (t) {
        e.completedRooms.push({
          roomName: o.roomName,
          totals: o.totals,
          observerCount: o.observerCount,
          ownRoom: o.ownRoom
        });
        clearPrev(o.roomName);
        console.log("[RoomCPUProfiler] " + o.roomName + " complete. " + e.roomQueue.length + " room(s) remaining.");
        advanceToNextRoom(e);
      }
    }
  }
  if (e.phase === "done") {
    printPlayerReport(e.playerName, e.completedRooms);
    clearAllPrev();
    delete Memory[MEM_KEY];
    console.log("[RoomCPUProfiler] Player profile complete. Memory wiped.");
  }
}

function advanceToNextRoom(e) {
  if (!e.roomQueue.length) {
    e.current = null;
    e.phase = "done";
    return;
  }
  const o = e.roomQueue.shift();
  const t = isOwnRoom(o);
  let r = 0;
  if (!t) {
    const t = findObservers(o);
    r = t.length;
    if (!t.length) {
      console.log("[RoomCPUProfiler] No observer for " + o + " — skipping.");
      advanceToNextRoom(e);
      return;
    }
    scanner.observe.request(o, OBSERVER_SOURCE, scanner.observe.PRI.MONITOR, {
      untilConsumed: true,
      holdTicks: 5
    });
    console.log("[RoomCPUProfiler] Now profiling " + o + " (" + t.length + " observer(s))");
  } else {
    console.log("[RoomCPUProfiler] Now profiling " + o + " (own room)");
  }
  e.current = {
    roomName: o,
    ownRoom: t,
    observerCount: r,
    totals: initTotals()
  };
}

//     supplied scan data, the mode falls back to the visible own rooms.
//     the shared tickRoom(). On completion, only 5 compact
//     numbers are kept per room (low/mid/high per-tick + creeps
//     + rcl). The full totals object is discarded immediately.
//   - current.totals  (~30 numbers, one room at a time)
//   - completed{}     (~5 numbers per finished room)
//   - playerRoomMap   (room names + rcl per player, read-only after scan)
//   - profileQueue    (shrinks as rooms are consumed)
function getMyUsername() {
  for (const e in Game.rooms) {
    const o = Game.rooms[e];
    if (o.controller && o.controller.my && o.controller.owner) {
      return o.controller.owner.username;
    }
  }
  return null;
}

function startNeighbors() {
  if (Memory[MEM_KEY] && Memory[MEM_KEY].active) {
    console.log("[NeighborProfile] Already active. Call cancelRoomProfile() first.");
    return;
  }
  clearAllPrev();
  const e = getMyUsername();
  wideScan.startPlayers();
  Memory[MEM_KEY] = {
    mode: "neighbors",
    active: true,
    phase: "scanning",
    startTick: Game.time,
    myName: e,
    playerRoomMap: {},
    profileQueue: [],
    currentPlayer: null,
    current: null,
    completed: {}
  };
  console.log("[NeighborProfile] Started. Scanning for all players in observer range...");
}

function runNeighbors(e) {
  if (e.phase === "scanning") runNeighborScanning(e); else if (e.phase === "profiling") runNeighborProfiling(e);
}

function runNeighborScanning(e) {
  const o = Memory.wideScan;
  if (!o && !e._cachedFound) {
    console.log("[NeighborProfile] No observers — profiling own rooms only.");
    buildNeighborQueue(e, {});
    return;
  }
  if (o && o.foundRooms && typeof o.foundRooms === "object" && !Array.isArray(o.foundRooms)) {
    const t = Object.keys(o.foundRooms).length;
    const r = e._cachedPlayerCount || 0;
    if (t !== r) {
      e._cachedFound = JSON.parse(JSON.stringify(o.foundRooms));
      e._cachedPlayerCount = t;
    }
  }
  if (o && o.active) return;
  const t = e._cachedFound || {};
  delete e._cachedFound;
  delete e._cachedPlayerCount;
  buildNeighborQueue(e, t);
}

function buildNeighborQueue(e, o) {
  const t = {};
  for (const e in o) {
    const r = o[e];
    if (!r || !r.length) continue;
    t[e] = {
      rooms: [],
      rcls: {}
    };
    for (const o of r) {
      t[e].rooms.push(o.room);
      t[e].rcls[o.room] = o.rcl;
    }
  }
  if (e.myName) {
    if (!t[e.myName]) {
      t[e.myName] = {
        rooms: [],
        rcls: {}
      };
    }
    const o = t[e.myName];
    for (const e in Game.rooms) {
      const t = Game.rooms[e];
      if (t.controller && t.controller.my) {
        if (o.rooms.indexOf(e) === -1) {
          o.rooms.push(e);
          o.rcls[e] = t.controller.level;
        }
      }
    }
  }
  e.playerRoomMap = t;
  const r = [];
  const n = Object.keys(t).sort();
  for (const e of n) {
    const o = t[e].rooms.slice().sort();
    for (const t of o) r.push({
      player: e,
      room: t
    });
  }
  if (!r.length) {
    console.log("[NeighborProfile] No rooms found. Aborting.");
    clearAllPrev();
    delete Memory[MEM_KEY];
    return;
  }
  e.profileQueue = r;
  e.completed = {};
  e.phase = "profiling";
  const s = r.length;
  console.log("[NeighborProfile] Found " + n.length + " player(s), " + s + " room(s): " + n.join(", "));
  console.log("[NeighborProfile] Est. " + s * (PROFILE_TICKS + 3) + " ticks.");
  advanceNeighborRoom(e);
}

function runNeighborProfiling(e) {
  if (!e.current) {
    finishNeighborProfile(e);
    return;
  }
  const o = e.current;
  const t = tickRoom(o);
  e.current = o;
  if (t) {
    const t = o.totals;
    const r = Math.max(1, t.ticksObserved);
    const n = calcCPU(t);
    const s = e.currentPlayer;
    if (!e.completed[s]) e.completed[s] = [];
    e.completed[s].push({
      room: o.roomName,
      low: n.totalLow / r,
      mid: n.totalMid / r,
      high: n.totalHigh / r,
      creeps: t.creepCountSum / r
    });
    clearPrev(o.roomName);
    const i = e.profileQueue.length;
    const a = Object.values(e.completed).reduce(function(e, o) {
      return e + o.length;
    }, 0);
    console.log("[NeighborProfile] " + o.roomName + " (" + s + ") done — " + a + " profiled, " + i + " queued.");
    advanceNeighborRoom(e);
    if (!e.current) {
      finishNeighborProfile(e);
    }
  }
}

function advanceNeighborRoom(e) {
  while (e.profileQueue.length) {
    const o = e.profileQueue.shift();
    e.currentPlayer = o.player;
    const t = isOwnRoom(o.room);
    let r = 0;
    if (!t) {
      const e = findObservers(o.room);
      r = e.length;
      if (!e.length) {
        console.log("[NeighborProfile] No observer for " + o.room + " — skipping.");
        continue;
      }
      scanner.observe.request(o.room, OBSERVER_SOURCE, scanner.observe.PRI.MONITOR, {
        untilConsumed: true,
        holdTicks: 5
      });
      console.log("[NeighborProfile] Profiling " + o.room + " (" + o.player + ", " + e.length + " obs)");
    } else {
      console.log("[NeighborProfile] Profiling " + o.room + " (" + o.player + ", own)");
    }
    e.current = {
      roomName: o.room,
      ownRoom: t,
      observerCount: r,
      totals: initTotals()
    };
    return;
  }
  e.current = null;
  e.currentPlayer = null;
}

function finishNeighborProfile(e) {
  printNeighborReport(e);
  clearAllPrev();
  delete Memory[MEM_KEY];
  console.log("[NeighborProfile] Complete. Memory wiped.");
}

function printNeighborReport(e) {
  const o = Game.time - e.startTick;
  const t = e.myName;
  function f2(e) {
    return e.toFixed(2);
  }
  function f3(e) {
    return e.toFixed(3);
  }
  const r = [];
  for (const o in e.completed) {
    const n = e.completed[o];
    if (!n.length) continue;
    let s = 0, i = 0, a = 0, l = 0;
    for (const e of n) {
      s += e.low;
      i += e.mid;
      a += e.high;
      l += e.creeps;
    }
    l = Math.round(l);
    const c = l * .35 + 1;
    const m = [];
    const d = e.playerRoomMap[o];
    if (d) {
      for (const e of n) m.push(d.rcls[e.room] || "?");
    }
    m.sort(function(e, o) {
      return o - e;
    });
    r.push({
      player: o,
      roomCount: n.length,
      creeps: l,
      intentPerTick: i,
      cpuPerRoom: i / n.length,
      cpuPerCreep: l > 0 ? i / l : 0,
      estTotal: i + c,
      rcls: m,
      roomDetails: n.slice().sort(function(e, o) {
        return o.mid - e.mid;
      }),
      isSelf: o === t
    });
  }
  r.sort(function(e, o) {
    return o.intentPerTick - e.intentPerTick;
  });
  const n = r.length;
  const s = r.reduce(function(e, o) {
    return e + o.roomCount;
  }, 0);
  const i = 82;
  const a = "─".repeat(i);
  const l = [ "╬" + "═".repeat(i) + "╬", "  NEIGHBOR CPU RANKINGS — " + n + " players, " + s + " rooms, " + o + " ticks elapsed", a, "  #  Player            Rooms  Creeps  Intent/tick  CPU/room  CPU/creep  Est.Total" ];
  for (var c = 0; c < r.length; c++) {
    var m = r[c];
    var d = m.isSelf ? " ★" : "  ";
    var u = String(c + 1).padStart(2);
    l.push("  " + u + " " + (m.player + d).padEnd(18) + String(m.roomCount).padStart(4) + String(m.creeps).padStart(8) + f3(m.intentPerTick).padStart(12) + f3(m.cpuPerRoom).padStart(10) + f3(m.cpuPerCreep).padStart(10) + f2(m.estTotal).padStart(10));
  }
  l.push(a);
  l.push("  ★ = you    Intent = observer-measured    Est.Total = intents + overhead");
  l.push("  CPU/room = intent CPU per room    CPU/creep = intent CPU per concurrent creep");
  l.push("");
  for (c = 0; c < r.length; c++) {
    m = r[c];
    d = m.isSelf ? " ★" : "";
    var p = m.rcls.join("/");
    l.push("  " + m.player + d + " (" + m.roomCount + " rooms, ~" + m.creeps + " creeps, RCL " + p + "):");
    var P = m.roomDetails.map(function(e) {
      return e.room + "  " + f3(e.mid) + "/t";
    });
    l.push("    " + P.join("  "));
    l.push("");
  }
  l.push("╩" + "═".repeat(i) + "╩");
  console.log(l.join("\n"));
  //   - RCLs grouped: "8×12,7×2,6×2" instead of "8/8/8/8/8/8/8/8/8/8/8/8/7/7/6/6"
  //   - Room values 2 decimals, no "/t" suffix
  //   - Room details capped at 6, remainder shown as "(+N)"
  //   - Summary + rooms on ONE line per player (no separate indented line)
    function compactRcls(e) {
    if (!e.length) return "?";
    var o = {}, t = [];
    for (var r = 0; r < e.length; r++) {
      var n = e[r];
      if (!o[n]) {
        o[n] = 0;
        t.push(n);
      }
      o[n]++;
    }
    return t.map(function(e) {
      return o[e] > 1 ? e + "×" + o[e] : String(e);
    }).join(",");
  }
  var g = 6;
  var _ = [ "[NeighborProfile] " + n + " players, " + s + " rooms, " + o + " ticks" ];
  for (c = 0; c < r.length; c++) {
    m = r[c];
    d = m.isSelf ? " ★" : "";
    var v = m.roomDetails.slice(0, g);
    var R = v.map(function(e) {
      return e.room + "=" + f2(e.mid);
    }).join(" ");
    var E = m.roomDetails.length - g;
    if (E > 0) R += " (+" + E + ")";
    _.push("#" + (c + 1) + " " + m.player + d + ": " + m.roomCount + "rm(RCL" + compactRcls(m.rcls) + ") ~" + m.creeps + "cr " + f3(m.intentPerTick) + "int/t " + f3(m.cpuPerRoom) + "/rm " + f3(m.cpuPerCreep) + "/cr ~" + f2(m.estTotal) + "est/t | " + R);
  }
  var C = "";
  for (var h = 0; h < _.length; h++) {
    var M = _[h];
    if (C && C.length + M.length + 1 > 998) {
      Game.notify(C, 0);
      C = M;
    } else {
      C += (C ? "\n" : "") + M;
    }
  }
  if (C) Game.notify(C, 0);
}

function status() {
  const e = Memory[MEM_KEY];
  if (!e || !e.active) {
    console.log("[RoomCPUProfiler] No active profile.");
    return null;
  }
  const o = Game.time - e.startTick;
  if (e.mode === "single") {
    const t = e.totals;
    const r = t.ticksObserved;
    const n = (r / PROFILE_TICKS * 100).toFixed(1);
    const s = calcCPU(t);
    console.log("[RoomCPUProfiler] SINGLE — " + e.roomName);
    console.log("  Progress  : " + r + " / " + PROFILE_TICKS + " ticks (" + n + "%)");
    console.log("  Elapsed   : " + o + " ticks");
    console.log("  Invisible : " + t.invisibleTicks);
    console.log("  Observers : " + (e.ownRoom ? "own room" : e.observerCount));
    if (r > 0) {
      console.log("  Running avg (typical): ~" + (s.totalMid / r).toFixed(3) + " CPU/tick");
      console.log("  Simple CPU so far    : " + s.simpleCPU.toFixed(2));
      console.log("  Move range so far    : " + s.moveLow.toFixed(2) + "–" + s.moveHigh.toFixed(2) + " CPU");
    }
  } else if (e.mode === "player") {
    const t = e.phase;
    console.log("[RoomCPUProfiler] PLAYER — " + e.playerName + "  [phase: " + t + "]");
    console.log("  Elapsed     : " + o + " ticks");
    if (t === "scanning") {
      const e = Memory.wideScan;
      if (e && e.active) {
        const o = (e.scannedCount / Math.max(1, e.totalRooms) * 100).toFixed(1);
        console.log("  wideScan    : " + e.scannedCount + "/" + e.totalRooms + " (" + o + "%)  found " + e.foundRooms.length + " room(s) so far");
      } else {
        console.log("  wideScan    : finishing up...");
      }
    } else if (t === "profiling") {
      const o = e.completedRooms.length;
      const t = o + e.roomQueue.length + (e.current ? 1 : 0);
      console.log("  Rooms done  : " + o + " / " + t);
      if (e.roomQueue.length) {
        console.log("  Queue       : " + e.roomQueue.join(", "));
      }
      if (e.current) {
        const o = e.current;
        const t = o.totals;
        const r = (t.ticksObserved / PROFILE_TICKS * 100).toFixed(1);
        const n = calcCPU(t);
        console.log("  Current     : " + o.roomName + "  " + t.ticksObserved + "/" + PROFILE_TICKS + " ticks (" + r + "%)" + "  invis=" + t.invisibleTicks);
        if (t.ticksObserved > 0) {
          console.log("  Running avg : ~" + (n.totalMid / t.ticksObserved).toFixed(3) + " CPU/tick");
        }
      }
      if (o > 0) {
        console.log("  Completed rooms:");
        for (const o of e.completedRooms) {
          const e = calcCPU(o.totals);
          const t = o.totals.ticksObserved;
          console.log("    " + o.roomName.padEnd(10) + " typical=" + (e.totalMid / Math.max(1, t)).toFixed(3) + "/tick" + "  total=" + e.totalLow.toFixed(2) + "-" + e.totalHigh.toFixed(2) + " CPU");
        }
      }
    }
  } else if (e.mode === "neighbors") {
    console.log("[NeighborProfile] NEIGHBORS  [phase: " + e.phase + "]");
    console.log("  Elapsed     : " + o + " ticks");
    if (e.phase === "scanning") {
      const e = Memory.wideScan;
      if (e && e.active) {
        const o = (e.scannedCount / Math.max(1, e.totalRooms) * 100).toFixed(1);
        const t = typeof e.foundRooms === "object" && !Array.isArray(e.foundRooms) ? Object.keys(e.foundRooms).length : 0;
        console.log("  wideScan    : " + e.scannedCount + "/" + e.totalRooms + " (" + o + "%)  " + t + " player(s) found");
      } else {
        console.log("  wideScan    : finishing...");
      }
    } else if (e.phase === "profiling") {
      const o = Object.values(e.completed).reduce(function(e, o) {
        return e + o.length;
      }, 0);
      const t = o + e.profileQueue.length + (e.current ? 1 : 0);
      const r = Object.keys(e.playerRoomMap).length;
      console.log("  Players     : " + r);
      console.log("  Rooms       : " + o + "/" + t + " profiled");
      if (e.current) {
        const o = e.current;
        const t = o.totals;
        const r = (t.ticksObserved / PROFILE_TICKS * 100).toFixed(1);
        console.log("  Current     : " + o.roomName + " (" + e.currentPlayer + ")  " + t.ticksObserved + "/" + PROFILE_TICKS + " (" + r + "%)" + "  invis=" + t.invisibleTicks);
        if (t.ticksObserved > 0) {
          const e = calcCPU(t);
          console.log("  Running avg : ~" + (e.totalMid / t.ticksObserved).toFixed(3) + " CPU/tick");
        }
      }
      for (const o in e.completed) {
        const t = e.completed[o];
        if (!t.length) continue;
        const r = t.reduce(function(e, o) {
          return e + o.mid;
        }, 0);
        const n = t.map(function(e) {
          return e.room + "=" + e.mid.toFixed(3) + "/t";
        }).join(" ");
        console.log("  " + o.padEnd(16) + " " + r.toFixed(3) + " intent/t  [" + n + "]");
      }
    }
  }
  return e;
}

module.exports = {
  start: start,
  cancel: cancel,
  run: run,
  status: status,
  startNeighbors: startNeighbors
};
global.profileRoom = start;
global.cancelRoomProfile = cancel;
global.roomProfileStatus = status;
global.profileNeighbors = startNeighbors;
