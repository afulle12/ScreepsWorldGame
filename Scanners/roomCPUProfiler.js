/**
 * roomCPUProfiler.js  (v10 — neighbor rankings)
 * ==============================================
 * Profile a single room, a player, or ALL neighbors in observer range.
 *
 *   profileRoom('W5N3')        — single room (own or foreign)
 *   profileRoom('PlayerName')  — all rooms owned by that player
 *                                 (uses wideScan to discover, then
 *                                  profiles each room for 100 ticks
 *                                  sequentially, then aggregates)
 *   profileNeighbors()         — discover ALL players in observer range
 *                                 via wideScanPlayers, then profile every
 *                                 room for each player (including yourself).
 *                                 Prints ranked CPU comparison + Game.notify.
 *   roomProfileStatus()        — check progress of an active profile
 *                                 single mode: ticks done, running avg,
 *                                   current CPU breakdown
 *                                 player mode: wideScan progress or
 *                                   rooms completed, current room ticks,
 *                                   per-room results so far
 *                                 neighbors mode: scan progress, rooms
 *                                   profiled per player, running averages
 *   cancelRoomProfile()        — abort at any point
 */

'use strict';

const wideScan = require('wideScan');

const PROFILE_TICKS  = 100;
const MAX_OBSERVERS  = 2;
const LOG_INTERVAL   = 25;
const MEM_KEY        = 'roomCPUProfile';
const GLOBAL_PREV    = '__cpuProfilerPrev';  // heap-only, not serialized

// Cost constants
const CPU_SIMPLE     = 0.2;
const CPU_TOWER      = 0.4;
const CPU_LAB        = 0.4;
const MOVE_CPU_OPT   = 0.2;
const MOVE_CPU_TYP   = 0.5;
const MOVE_CPU_NAIVE = 2.0;

// Event constants
const EV_ATTACK             = 1;
const EV_OBJECT_DESTROYED   = 2;
const EV_ATTACK_CONTROLLER  = 3;
const EV_BUILD              = 4;
const EV_HARVEST            = 5;
const EV_HEAL               = 6;
const EV_REPAIR             = 7;
const EV_RESERVE_CONTROLLER = 8;
const EV_UPGRADE_CONTROLLER = 9;
const EV_EXIT               = 10;
const EV_POWER              = 11;
const EV_TRANSFER           = 12;
const EV_ATTACK_NUKE        = 6;
const EV_ATTACK_HIT_BACK    = 5;
const EV_ATTACK_RANGED      = 2;
const EV_ATTACK_RANGED_MASS = 3;
const EV_ATTACK_DISMANTLE   = 4;

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

const ROOM_NAME_RE = /^[WE]\d+[NS]\d+$/;
function isRoomName(s) { return ROOM_NAME_RE.test(s); }
function isOwnRoom(roomName) {
    const r = Game.rooms[roomName];
    return !!(r && r.controller && r.controller.my);
}

function findObservers(targetRoom) {
    const results = [];
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        const obs = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER && s.isActive()
        });
        if (!obs.length) continue;
        const dist = Game.map.getRoomLinearDistance(roomName, targetRoom);
        if (dist <= 10) results.push({ observer: obs[0], dist, room: roomName });
    }
    results.sort((a, b) => a.dist - b.dist);
    return results.slice(0, MAX_OBSERVERS);
}

function fireObservers(targetRoom) {
    const observers = findObservers(targetRoom);
    let fired = 0;
    for (const { observer } of observers) {
        if (observer.observeRoom(targetRoom) === OK) fired++;
    }
    return { count: observers.length, fired };
}

// ── Prev snapshot lives in global heap, not Memory ──────────────────────────
// Key is `roomName` so single and player modes don't collide.

function getPrev(roomName) {
    return (global[GLOBAL_PREV] && global[GLOBAL_PREV][roomName]) || null;
}

function setPrev(roomName, snap) {
    if (!global[GLOBAL_PREV]) global[GLOBAL_PREV] = {};
    global[GLOBAL_PREV][roomName] = snap;
}

function clearPrev(roomName) {
    if (global[GLOBAL_PREV]) delete global[GLOBAL_PREV][roomName];
}

function clearAllPrev() {
    delete global[GLOBAL_PREV];
}

// ═══════════════════════════════════════════════════════════════
// SNAPSHOT  (built fresh each tick, stored in global heap only)
// ═══════════════════════════════════════════════════════════════

function takeSnapshot(room) {
    const snap = {
        creepPos: {}, terminal: null, labs: {},
        factory: null, spawns: {}, nuker: null,
        powerSpawn: null, constructionSites: 0, controllerSafeMode: 0,
    };
    for (const c of room.find(FIND_CREEPS))
        snap.creepPos[c.id] = { x: c.pos.x, y: c.pos.y };
    for (const pc of room.find(FIND_POWER_CREEPS))
        snap.creepPos['pc_' + pc.id] = { x: pc.pos.x, y: pc.pos.y };
    for (const s of room.find(FIND_STRUCTURES)) {
        switch (s.structureType) {
            case STRUCTURE_TERMINAL:    snap.terminal   = { cooldown: s.cooldown || 0 };                           break;
            case STRUCTURE_LAB:         snap.labs[s.id] = { cooldown: s.cooldown || 0 };                           break;
            case STRUCTURE_FACTORY:     snap.factory    = { id: s.id, cooldown: s.cooldown || 0 };                 break;
            case STRUCTURE_SPAWN:       snap.spawns[s.id] = { spawning: !!s.spawning };                            break;
            case STRUCTURE_NUKER:       snap.nuker      = { id: s.id, cooldown: s.cooldown || 0 };                 break;
            case STRUCTURE_POWER_SPAWN: snap.powerSpawn = { id: s.id, power: s.store[RESOURCE_POWER] || 0 };       break;
            default: break;
        }
    }
    if (room.controller) snap.controllerSafeMode = room.controller.safeMode || 0;
    snap.constructionSites = room.find(FIND_CONSTRUCTION_SITES).length;
    return snap;
}

// ═══════════════════════════════════════════════════════════════
// EVENT LOG
// ═══════════════════════════════════════════════════════════════

function emptyEvDetail() {
    return {
        intents: 0,
        harvest: 0, build: 0, upgradeController: 0, reserveController: 0,
        attackController: 0, transfer: 0, attackMelee: 0, attackRangedMass: 0,
        dismantle: 0, healMelee: 0, powerAbility: 0,
        repairAny: 0, attackRangedAny: 0, healRangedAny: 0,
        objectsDestroyed: 0, nukeDetonations: 0, hitBacks: 0,
    };
}

function processEventLog(room) {
    let events;
    try { events = JSON.parse(room.getEventLog(true)); }
    catch (e) { events = room.getEventLog(); }
    if (!events || !events.length) return { intents: 0, detail: emptyEvDetail() };
    const d = emptyEvDetail();
    let intents = 0;
    for (const ev of events) {
        switch (ev.event) {
            case EV_ATTACK: {
                const at = ev.data && ev.data.attackType;
                if      (at === EV_ATTACK_NUKE)     { d.nukeDetonations++; }
                else if (at === EV_ATTACK_HIT_BACK)  { d.hitBacks++; }
                else {
                    intents++;
                    if      (at === EV_ATTACK_RANGED)       d.attackRangedAny++;
                    else if (at === EV_ATTACK_RANGED_MASS)  d.attackRangedMass++;
                    else if (at === EV_ATTACK_DISMANTLE)    d.dismantle++;
                    else                                    d.attackMelee++;
                }
                break;
            }
            case EV_OBJECT_DESTROYED:   d.objectsDestroyed++;                  break;
            case EV_ATTACK_CONTROLLER:  intents++; d.attackController++;        break;
            case EV_BUILD:              intents++; d.build++;                   break;
            case EV_HARVEST:            intents++; d.harvest++;                 break;
            case EV_HEAL: {
                intents++;
                if ((ev.data && ev.data.healType) === 2) d.healRangedAny++;
                else                                     d.healMelee++;
                break;
            }
            case EV_REPAIR:             intents++; d.repairAny++;               break;
            case EV_RESERVE_CONTROLLER: intents++; d.reserveController++;       break;
            case EV_UPGRADE_CONTROLLER: intents++; d.upgradeController++;       break;
            case EV_EXIT:                                                        break;
            case EV_POWER:              intents++; d.powerAbility++;            break;
            case EV_TRANSFER:           intents++; d.transfer++;                break;
            default: break;
        }
    }
    d.intents = intents;
    return { intents, detail: d };
}

// ═══════════════════════════════════════════════════════════════
// STATE DIFF
// ═══════════════════════════════════════════════════════════════

function emptyDiffDetail() {
    return {
        creepMoves: 0, powerCreepMoves: 0, terminalSends: 0, labReactions: 0,
        factoryProduces: 0, spawnEvents: 0, nukerFired: 0, powerProcessed: 0,
        constructionSites: 0, safeModeActivated: 0,
    };
}

function diffSnapshots(prev, curr) {
    const d = emptyDiffDetail();
    for (const id in curr.creepPos) {
        const c = curr.creepPos[id]; const p = prev.creepPos[id];
        if (!p) continue;
        if (c.x !== p.x || c.y !== p.y) {
            if (id.startsWith('pc_')) d.powerCreepMoves++;
            else                      d.creepMoves++;
        }
    }
    if (curr.terminal && prev.terminal &&
        prev.terminal.cooldown === 0 && curr.terminal.cooldown > 0) d.terminalSends++;
    for (const id in curr.labs) {
        const c = curr.labs[id]; const p = prev.labs[id];
        if (p && p.cooldown === 0 && c.cooldown > 0) d.labReactions++;
    }
    if (curr.factory && prev.factory &&
        prev.factory.cooldown === 0 && curr.factory.cooldown > 0) d.factoryProduces++;
    for (const id in curr.spawns) {
        const c = curr.spawns[id]; const p = prev.spawns[id];
        if (p && !p.spawning && c.spawning) d.spawnEvents++;
    }
    if (curr.nuker && prev.nuker && prev.nuker.cooldown === 0 && curr.nuker.cooldown > 0) {
        d.nukerFired++;
        const n = Game.getObjectById(curr.nuker.id);
        console.log('[RoomCPUProfiler] \u26A0 NUKE LAUNCHED from ' + (n ? n.room.name : '?') + ' tick ' + Game.time);
    }
    if (curr.powerSpawn && prev.powerSpawn) {
        const drop = prev.powerSpawn.power - curr.powerSpawn.power;
        if (drop > 0) d.powerProcessed += drop;
    }
    const newSites = curr.constructionSites - prev.constructionSites;
    if (newSites > 0) d.constructionSites += newSites;
    if (prev.controllerSafeMode === 0 && curr.controllerSafeMode > 0) {
        d.safeModeActivated++;
        console.log('[RoomCPUProfiler] \u26A0 SAFE MODE ACTIVATED tick ' + Game.time);
    }
    return { detail: d };
}

// ═══════════════════════════════════════════════════════════════
// CPU CALCULATION
// ═══════════════════════════════════════════════════════════════

function calcCPU(t) {
    const simpleIntents =
        t.ev_harvest + t.ev_build + t.ev_upgradeController + t.ev_reserveController +
        t.ev_attackController + t.ev_transfer + t.ev_attackMelee + t.ev_attackRangedMass +
        t.ev_dismantle + t.ev_healMelee + t.ev_powerAbility + t.diff_terminalSends +
        t.diff_factoryProduces + t.diff_spawnEvents + t.diff_nukerFired +
        t.diff_powerProcessed + t.diff_constructionSites + t.diff_safeModeActivated;
    const simpleCPU  = simpleIntents * CPU_SIMPLE;
    const labCPU     = t.diff_labReactions * CPU_LAB;
    const ambig      = t.ev_repairAny + t.ev_attackRangedAny + t.ev_healRangedAny;
    const moves      = t.diff_creepMoves + t.diff_powerCreepMoves;
    return {
        simpleIntents, simpleCPU, labCPU, ambig,
        ambigLow: ambig * CPU_SIMPLE, ambigHigh: ambig * CPU_TOWER,
        moves,
        moveLow:   moves * MOVE_CPU_OPT,
        moveMid:   moves * MOVE_CPU_TYP,
        moveHigh:  moves * MOVE_CPU_NAIVE,
        totalLow:  simpleCPU + labCPU + ambig * CPU_SIMPLE + moves * MOVE_CPU_OPT,
        totalMid:  simpleCPU + labCPU + ambig * CPU_TOWER  + moves * MOVE_CPU_TYP,
        totalHigh: simpleCPU + labCPU + ambig * CPU_TOWER  + moves * MOVE_CPU_NAIVE,
    };
}

// ═══════════════════════════════════════════════════════════════
// TOTALS
// ═══════════════════════════════════════════════════════════════

function initTotals() {
    return {
        ticksObserved: 0, creepCountSum: 0, invisibleTicks: 0,
        ev_harvest: 0, ev_build: 0, ev_upgradeController: 0, ev_reserveController: 0,
        ev_attackController: 0, ev_transfer: 0, ev_attackMelee: 0, ev_attackRangedMass: 0,
        ev_dismantle: 0, ev_healMelee: 0, ev_powerAbility: 0,
        ev_repairAny: 0, ev_attackRangedAny: 0, ev_healRangedAny: 0,
        ev_objectsDestroyed: 0, ev_nukeDetonations: 0,
        diff_creepMoves: 0, diff_powerCreepMoves: 0, diff_terminalSends: 0,
        diff_labReactions: 0, diff_factoryProduces: 0, diff_spawnEvents: 0,
        diff_nukerFired: 0, diff_powerProcessed: 0, diff_constructionSites: 0,
        diff_safeModeActivated: 0,
    };
}

function accumulateTotals(dst, src) {
    for (const k in src) {
        if (typeof src[k] === 'number') dst[k] = (dst[k] || 0) + src[k];
    }
}

function accumulateEventDetail(t, evD, dfD) {
    t.ev_harvest             += evD.harvest;
    t.ev_build               += evD.build;
    t.ev_upgradeController   += evD.upgradeController;
    t.ev_reserveController   += evD.reserveController;
    t.ev_attackController    += evD.attackController;
    t.ev_transfer            += evD.transfer;
    t.ev_attackMelee         += evD.attackMelee;
    t.ev_attackRangedMass    += evD.attackRangedMass;
    t.ev_dismantle           += evD.dismantle;
    t.ev_healMelee           += evD.healMelee;
    t.ev_powerAbility        += evD.powerAbility;
    t.ev_repairAny           += evD.repairAny;
    t.ev_attackRangedAny     += evD.attackRangedAny;
    t.ev_healRangedAny       += evD.healRangedAny;
    t.ev_objectsDestroyed    += evD.objectsDestroyed;
    t.ev_nukeDetonations     += evD.nukeDetonations;
    t.diff_creepMoves        += dfD.creepMoves;
    t.diff_powerCreepMoves   += dfD.powerCreepMoves;
    t.diff_terminalSends     += dfD.terminalSends;
    t.diff_labReactions      += dfD.labReactions;
    t.diff_factoryProduces   += dfD.factoryProduces;
    t.diff_spawnEvents       += dfD.spawnEvents;
    t.diff_nukerFired        += dfD.nukerFired;
    t.diff_powerProcessed    += dfD.powerProcessed;
    t.diff_constructionSites += dfD.constructionSites;
    t.diff_safeModeActivated += dfD.safeModeActivated;
}

// ═══════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════

function buildRoomReport(roomName, t, obsCount, ownRoom) {
    const cpu       = calcCPU(t);
    const obs       = t.ticksObserved;
    const avgCreeps = obs > 0 ? (t.creepCountSum / obs).toFixed(1) : '0';
    const obsLabel  = ownRoom ? 'own' : obsCount + ' obs';

    function f(n)  { return n.toFixed(2); }
    function fp(n) { return n.toFixed(3); }
    function row(label, n, cpuPer) {
        if (!n) return null;
        return '  \u2502    ' + label.padEnd(30) + ': ' + String(n).padStart(5) +
               '  (' + f(n * cpuPer) + ' CPU)';
    }

    const sep = '\u2500'.repeat(62);
    const lines = [
        '  \u250C' + sep + '\u2510',
        '  \u2502  ' + roomName.padEnd(14) +
            ' ticks=' + String(obs).padStart(3) +
            '  creeps=' + avgCreeps +
            '  invis=' + t.invisibleTicks +
            '  [' + obsLabel + ']',
        '  \u251C' + sep + '\u2524',
    ];

    // Simple rows — only non-zero
    const simpleRows = [
        row('harvest',             t.ev_harvest,             CPU_SIMPLE),
        row('build',               t.ev_build,               CPU_SIMPLE),
        row('upgradeController',   t.ev_upgradeController,   CPU_SIMPLE),
        row('reserveController',   t.ev_reserveController,   CPU_SIMPLE),
        row('attackController',    t.ev_attackController,    CPU_SIMPLE),
        row('transfer/withdraw',   t.ev_transfer,            CPU_SIMPLE),
        row('attackMelee',         t.ev_attackMelee,         CPU_SIMPLE),
        row('rangedMassAttack',    t.ev_attackRangedMass,    CPU_SIMPLE),
        row('dismantle',           t.ev_dismantle,           CPU_SIMPLE),
        row('healMelee',           t.ev_healMelee,           CPU_SIMPLE),
        row('powerAbility',        t.ev_powerAbility,        CPU_SIMPLE),
        row('terminal sends',      t.diff_terminalSends,     CPU_SIMPLE),
        row('factory produce',     t.diff_factoryProduces,   CPU_SIMPLE),
        row('spawn events',        t.diff_spawnEvents,       CPU_SIMPLE),
        row('nuker launches',      t.diff_nukerFired,        CPU_SIMPLE),
        row('power processed',     t.diff_powerProcessed,    CPU_SIMPLE),
        row('new construct sites', t.diff_constructionSites, CPU_SIMPLE),
        row('safe mode',           t.diff_safeModeActivated, CPU_SIMPLE),
    ].filter(Boolean);

    if (simpleRows.length) {
        lines.push('  \u2502  simple intents (~0.2 each):');
        for (const r of simpleRows) lines.push(r);
    }

    // Elevated
    const elevatedRows = [
        t.diff_labReactions > 0
            ? '  \u2502    ' + 'lab reactions/boosts'.padEnd(30) + ': ' +
              String(t.diff_labReactions).padStart(5) + '  (' + f(t.diff_labReactions * CPU_LAB) + ' CPU)'
            : null,
        (t.ev_repairAny + t.ev_attackRangedAny + t.ev_healRangedAny) > 0
            ? '  \u2502    ' + 'repair+rngdAtk+rngdHeal'.padEnd(30) + ': ' +
              String(t.ev_repairAny + t.ev_attackRangedAny + t.ev_healRangedAny).padStart(5) +
              '  (' + f(cpu.ambigLow) + '\u2013' + f(cpu.ambigHigh) + ' CPU, ambiguous)'
            : null,
    ].filter(Boolean);

    if (elevatedRows.length) {
        lines.push('  \u2502  elevated cost (~0.4+ each):');
        for (const r of elevatedRows) lines.push(r);
    }

    // Movement
    if (cpu.moves > 0) {
        lines.push('  \u2502  movement (' + cpu.moves + ' moves):  ' +
            'opt=' + f(cpu.moveLow) + '  typical=' + f(cpu.moveMid) + '  naive=' + f(cpu.moveHigh) + ' CPU');
    }

    lines.push('  \u251C' + sep + '\u2524');
    lines.push('  \u2502  TOTAL  opt=' + f(cpu.totalLow) +
        '  typical=' + f(cpu.totalMid) +
        '  naive=' + f(cpu.totalHigh) +
        ' CPU    (' + fp(cpu.totalMid / Math.max(1, obs)) + '/tick typical)');
    lines.push('  \u2514' + sep + '\u2518');

    return lines;
}

function printSingleReport(roomName, t, startTick, obsCount, ownRoom) {
    const obs = t.ticksObserved;
    if (!obs) { console.log('[RoomCPUProfiler] No data collected.'); return; }

    const cpu       = calcCPU(t);
    const modeLabel = ownRoom ? 'OWN ROOM' : 'FOREIGN ROOM';

    function f(n)  { return n.toFixed(2); }
    function fp(n) { return n.toFixed(3); }
    function row(label, n, cpuPer) {
        return '  ' + label.padEnd(32) + ': ' + String(n).padStart(5) +
               '  (' + f(n * cpuPer) + ' CPU @ ' + cpuPer + '/ea)';
    }

    const W   = 64;
    const sep = '\u2500'.repeat(W);
    const lines = [
        '\u256C' + '\u2550'.repeat(W) + '\u256C',
        '  ROOM CPU PROFILE \u2014 ' + roomName + '  [' + modeLabel + ']',
        '  Ticks: ' + obs + ' / ' + PROFILE_TICKS +
            '   (game ' + startTick + ' \u2013 ' + (startTick + obs + 1) + ')',
        sep,
        '  \u2500\u2500 SIMPLE INTENTS ~0.2 each \u2500\u2500',
        row('  Harvest',              t.ev_harvest,             CPU_SIMPLE),
        row('  Build',                t.ev_build,               CPU_SIMPLE),
        row('  Upgrade controller',   t.ev_upgradeController,   CPU_SIMPLE),
        row('  Reserve controller',   t.ev_reserveController,   CPU_SIMPLE),
        row('  Attack controller',    t.ev_attackController,    CPU_SIMPLE),
        row('  Transfer/Withdraw',    t.ev_transfer,            CPU_SIMPLE),
        row('  Attack melee',         t.ev_attackMelee,         CPU_SIMPLE),
        row('  Attack ranged mass',   t.ev_attackRangedMass,    CPU_SIMPLE),
        row('  Dismantle',            t.ev_dismantle,           CPU_SIMPLE),
        row('  Heal melee',           t.ev_healMelee,           CPU_SIMPLE),
        row('  Power creep ability',  t.ev_powerAbility,        CPU_SIMPLE),
        row('  Terminal sends/deals', t.diff_terminalSends,     CPU_SIMPLE),
        row('  Factory productions',  t.diff_factoryProduces,   CPU_SIMPLE),
        row('  Spawn events',         t.diff_spawnEvents,       CPU_SIMPLE),
        row('  Nuker launches',       t.diff_nukerFired,        CPU_SIMPLE),
        row('  Power processed',      t.diff_powerProcessed,    CPU_SIMPLE),
        row('  New construct sites',  t.diff_constructionSites, CPU_SIMPLE),
        row('  Safe mode activated',  t.diff_safeModeActivated, CPU_SIMPLE),
        '  ' + '\u2508'.repeat(W - 2),
        '  Simple CPU: ' + f(cpu.simpleCPU),
        sep,
        '  \u2500\u2500 ELEVATED COST ~0.4+ each \u2500\u2500',
        '  Lab reactions/boosts     : ' + t.diff_labReactions +
            '  (' + f(cpu.labCPU) + ' CPU)',
        '  Repair+RngdAtk+RngdHeal  : ' + t.ev_repairAny + '/' +
            t.ev_attackRangedAny + '/' + t.ev_healRangedAny +
            '  [' + f(cpu.ambigLow) + '\u2013' + f(cpu.ambigHigh) + ' CPU, ambiguous]',
        sep,
        '  \u2500\u2500 MOVEMENT \u2500\u2500',
        '  Moves: ' + cpu.moves + '  opt=' + f(cpu.moveLow) +
            '  typical=' + f(cpu.moveMid) + '  naive=' + f(cpu.moveHigh) + ' CPU',
        sep,
        '  TOTALS',
        '  Optimized        | ' + f(cpu.totalLow)  + '  | ' + fp(cpu.totalLow  / obs) + '/tick',
        '  Typical (moveTo) | ' + f(cpu.totalMid)  + '  | ' + fp(cpu.totalMid  / obs) + '/tick  \u2190',
        '  Naive (recalc)   | ' + f(cpu.totalHigh) + '  | ' + fp(cpu.totalHigh / obs) + '/tick',
        sep,
        '  avg creeps=' + (t.creepCountSum / obs).toFixed(1) +
            '   invisible=' + t.invisibleTicks +
            '   ' + (ownRoom ? 'own room' : obsCount + ' observer(s)'),
        '\u2569' + '\u2550'.repeat(W) + '\u2569',
    ];

    console.log(lines.join('\n'));

    Game.notify((
        '[RoomCPUProfiler] ' + roomName + ' | ' + obs + ' ticks' +
        ' | typical=' + fp(cpu.totalMid / obs) + '/tick' +
        ' | total=' + f(cpu.totalLow) + '-' + f(cpu.totalHigh) + ' CPU' +
        ' | moves=' + cpu.moves + ' creeps=' + (t.creepCountSum / obs).toFixed(1)
    ).slice(0, 398), 0);
}

function printPlayerReport(playerName, completedRooms) {
    if (!completedRooms.length) {
        console.log('[RoomCPUProfiler] No rooms profiled for ' + playerName + '.');
        return;
    }

    const agg      = initTotals();
    for (const r of completedRooms) accumulateTotals(agg, r.totals);
    const aggCPU   = calcCPU(agg);
    const totalObs = completedRooms.reduce((s, r) => s + r.totals.ticksObserved, 0);
    const avgCreeps = totalObs > 0 ? (agg.creepCountSum / totalObs).toFixed(1) : '0';

    function f(n)  { return n.toFixed(2); }
    function fp(n) { return n.toFixed(3); }

    const W   = 66;
    const sep = '\u2500'.repeat(W);

    // ── Concurrent intent load: sum per-room per-tick rates ──────────────────
    // totalObs is sequential (5 rooms × 100 ticks = 500). That gives the
    // average across rooms, NOT what happens in a live tick where all rooms
    // run simultaneously. Sum each room's per-tick rate instead.
    let concLow = 0, concMid = 0, concHigh = 0, concCreeps = 0;
    for (const r of completedRooms) {
        const rc  = calcCPU(r.totals);
        const obs = Math.max(1, r.totals.ticksObserved);
        concLow    += rc.totalLow  / obs;
        concMid    += rc.totalMid  / obs;
        concHigh   += rc.totalHigh / obs;
        concCreeps += r.totals.creepCountSum / obs;
    }
    concCreeps = Math.round(concCreeps);

    // ── Overhead estimates (script logic + Memory — not captured by intent scan) ──
    // Script logic per creep: player code running conditionals, Memory reads,
    // find() calls, pathfinding computation (on top of moveTo intent cost).
    // Conservative: ~0.3 CPU/creep  Moderate: ~0.6  Heavy: ~1.0
    const overheadLow  = concCreeps * 0.20 + 0.5;  // throttled/cached scripts like yours
    const overheadMid  = concCreeps * 0.35 + 1.0;  // typical non-throttled optimized
    const overheadHigh = concCreeps * 0.65 + 1.5;  // unoptimized, naive, per-tick recalc
    const totalEstLow  = concLow  + overheadLow;
    const totalEstMid  = concMid  + overheadMid;
    const totalEstHigh = concHigh + overheadHigh;

    function scaleBar(val, maxVal) {
        const BAR    = 24;
        const filled = Math.min(BAR, Math.round((val / maxVal) * BAR));
        const pct    = Math.round((val / maxVal) * 100);
        const over   = val > maxVal;
        return '[' + '\u2588'.repeat(filled) +
               '\u2591'.repeat(Math.max(0, BAR - filled)) +
               '] ' + f(val) + ' CPU/tick' +
               (over ? ' \u26A0 OVER ' + maxVal : ' (' + pct + '% of ' + maxVal + ')');
    }

    const lines = [
        '\u256C' + '\u2550'.repeat(W) + '\u256C',
        '  PLAYER CPU PROFILE \u2014 ' + playerName,
        '  Rooms profiled: ' + completedRooms.length +
            '   Concurrent creeps: ~' + concCreeps +
            '   Avg creeps/room: ' + avgCreeps,
        sep,
        '  \u2500\u2500 CONCURRENT INTENT CPU (all rooms running simultaneously) \u2500\u2500',
        '  These are the per-tick intent costs when all rooms run in the same tick.',
        '  (Aggregate ÷ total ticks would undercount by ' + completedRooms.length + 'x for concurrent use.)',
        '',
        '  Optimized  (move cached)  : ' + scaleBar(concLow,  20),
        '  Typical    (moveTo ~0.5)  : ' + scaleBar(concMid,  20) + '  \u2190',
        '  Naive      (recalc/tick)  : ' + scaleBar(concHigh, 20),
        '',
        '  Breakdown: simple=' + f(aggCPU.simpleCPU / completedRooms.length) +
            '/room  labs=' + f(aggCPU.labCPU / completedRooms.length) +
            '/room  moves=' + f(concLow) + '-' + f(concHigh) + ' total',
        sep,
        '  \u2500\u2500 ESTIMATED TOTAL CPU (intents + script overhead) \u2500\u2500',
        '  Overhead = script logic per creep + Memory parse + game loop base.',
        '  ~' + concCreeps + ' concurrent creeps  ×  0.3-1.0 CPU/creep  +  0.5-1.5 base',
        '',
        '  Low    (opt intents + lean script)   : ' + scaleBar(totalEstLow,  40),
        '  Mid    (typical intents + avg script): ' + scaleBar(totalEstMid,  40) + '  \u2190',
        '  Heavy  (naive intents + heavy script): ' + scaleBar(totalEstHigh, 40),
        '',
        '  Intent share of estimated total (mid): ' +
            Math.round((concMid / totalEstMid) * 100) + '% from intents, ' +
            Math.round((overheadMid / totalEstMid) * 100) + '% from script overhead',
        sep,
        '  \u2500\u2500 PER-ROOM BREAKDOWN (sorted by typical CPU, highest first) \u2500\u2500',
        '',
    ];

    const sorted = completedRooms.slice().sort((a, b) =>
        calcCPU(b.totals).totalMid - calcCPU(a.totals).totalMid
    );

    for (const r of sorted) {
        const roomLines = buildRoomReport(r.roomName, r.totals, r.observerCount, r.ownRoom);
        for (const l of roomLines) lines.push(l);
        lines.push('');
    }

    lines.push('\u2569' + '\u2550'.repeat(W) + '\u2569');
    console.log(lines.join('\n'));

    const roomSummaries = sorted.map(r => {
        const c = calcCPU(r.totals);
        return r.roomName + '=' + fp(c.totalMid / Math.max(1, r.totals.ticksObserved)) + '/t';
    }).join(' ');

    Game.notify((
        '[RoomCPUProfiler] ' + playerName + ' | ' + completedRooms.length + ' rooms | ' +
        'intents=' + f(concMid) + 'CPU/tick | est.total=' + f(totalEstMid) + 'CPU/tick | ' +
        roomSummaries
    ).slice(0, 398), 0);
}

// ═══════════════════════════════════════════════════════════════
// CORE ROOM TICK  (shared by single and player modes)
// Returns true when 100 diff ticks have been collected.
// roomState = { roomName, ownRoom, observerCount, totals }
//   prev is in global[GLOBAL_PREV][roomName] — not in Memory
// ═══════════════════════════════════════════════════════════════

function tickRoom(roomState) {
    const name = roomState.roomName;
    const own  = roomState.ownRoom;

    if (!own) {
        const { count, fired } = fireObservers(name);
        roomState.observerCount = count;
        if (count > 0 && fired === 0 && Game.time % 10 === 0) {
            console.log('[RoomCPUProfiler] WARNING: all observers busy for ' + name);
        }
    }

    const room = Game.rooms[name];
    if (!room) {
        roomState.totals.invisibleTicks++;
        return false;
    }

    const snap = takeSnapshot(room);
    const prev = getPrev(name);

    if (!prev) {
        // First visible tick — store baseline in global heap, nothing in Memory
        setPrev(name, snap);
        console.log('[RoomCPUProfiler] Baseline \u2014 ' + name + ' @ tick ' + Game.time);
        return false;
    }

    const { intents: evI, detail: evD } = processEventLog(room);
    const { detail: dfD }               = diffSnapshots(prev, snap);

    accumulateEventDetail(roomState.totals, evD, dfD);
    roomState.totals.ticksObserved++;
    roomState.totals.creepCountSum += room.find(FIND_CREEPS).length;

    // Update prev in global heap — zero Memory cost
    setPrev(name, snap);

    const t = roomState.totals.ticksObserved;
    if (t % LOG_INTERVAL === 0 && t < PROFILE_TICKS) {
        const cpu = calcCPU(roomState.totals);
        console.log('[RoomCPUProfiler] ' + name + ' \u2014 ' + t + '/' + PROFILE_TICKS +
            ' | typical: ~' + (cpu.totalMid / t).toFixed(3) + ' CPU/tick');
    }

    return t >= PROFILE_TICKS;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

function start(target) {
    if (!target || typeof target !== 'string') {
        console.log('[RoomCPUProfiler] Usage: profileRoom("W5N3") or profileRoom("PlayerName")');
        return;
    }
    if (Memory[MEM_KEY] && Memory[MEM_KEY].active) {
        console.log('[RoomCPUProfiler] Already active. Call cancelRoomProfile() first.');
        return;
    }
    clearAllPrev();

    if (isRoomName(target)) {
        // ── Single room mode ──────────────────────────────────────────────────
        const own = isOwnRoom(target);
        let obsCount = 0;
        if (own) {
            console.log('[RoomCPUProfiler] ' + target + ' is your room \u2014 no observer needed.');
        } else {
            const obs = findObservers(target);
            obsCount = obs.length;
            if (!obs.length) {
                console.log('[RoomCPUProfiler] WARNING: no observer within 10 rooms of ' + target);
            } else {
                console.log('[RoomCPUProfiler] ' + obs.length + ' observer(s): ' +
                    obs.map(o => o.room + '(d' + o.dist + ')').join(', '));
                // Fire immediately — eliminates the guaranteed 1-tick visibility delay
                for (const { observer } of obs) observer.observeRoom(target);
            }
        }

        Memory[MEM_KEY] = {
            mode: 'single', active: true,
            roomName: target, startTick: Game.time,
            ownRoom: own, observerCount: obsCount,
            totals: initTotals(),
            // NOTE: no 'prev' here — it lives in global[GLOBAL_PREV][target]
        };
        console.log('[RoomCPUProfiler] Started \u2014 ' + target + ' for ' + PROFILE_TICKS + ' ticks.');

    } else {
        // ── Player mode ───────────────────────────────────────────────────────

        // Detect if the target is ourselves — if so, all owned rooms are already
        // visible in Game.rooms. No wideScan needed, and wideScan would miss rooms
        // outside observer range anyway.
        let myName = null;
        for (const rn in Game.rooms) {
            const r = Game.rooms[rn];
            if (r.controller && r.controller.my && r.controller.owner) {
                myName = r.controller.owner.username;
                break;
            }
        }
        const isSelf = myName && myName.toLowerCase() === target.toLowerCase();

        if (isSelf) {
            // Own rooms — collect directly from Game.rooms, no scanning required
            const ownRooms = [];
            for (const rn in Game.rooms) {
                const r = Game.rooms[rn];
                if (r.controller && r.controller.my) ownRooms.push(rn);
            }
            if (!ownRooms.length) {
                console.log('[RoomCPUProfiler] No owned rooms found in Game.rooms.');
                return;
            }
            console.log('[RoomCPUProfiler] Self-profile \u2014 found ' + ownRooms.length +
                ' owned room(s): ' + ownRooms.join(', '));
            console.log('[RoomCPUProfiler] Profiling each room for ' + PROFILE_TICKS +
                ' ticks. Est. ' + (ownRooms.length * (PROFILE_TICKS + 3)) + ' ticks total.');
            Memory[MEM_KEY] = {
                mode: 'player', active: true,
                playerName: target, startTick: Game.time,
                phase: 'profiling',   // skip scanning entirely
                roomQueue: ownRooms.slice(),
                completedRooms: [],
                current: null,
            };
            // Advance to first room immediately
            advanceToNextRoom(Memory[MEM_KEY]);

        } else {
            // Foreign player — use wideScan to discover rooms
            console.log('[RoomCPUProfiler] Player mode \u2014 scanning for ' + target + '\'s rooms via wideScan...');
            wideScan.start(target);
            Memory[MEM_KEY] = {
                mode: 'player', active: true,
                playerName: target, startTick: Game.time,
                phase: 'scanning',
                roomQueue: [], completedRooms: [],
                current: null,
            };
        }
    }
}

function cancel() {
    if (!Memory[MEM_KEY]) { console.log('[RoomCPUProfiler] Nothing active.'); return; }
    const state = Memory[MEM_KEY];
    if ((state.mode === 'player' || state.mode === 'neighbors') &&
        state.phase === 'scanning' && Memory.wideScan && Memory.wideScan.active) {
        wideScan.cancel();
    }
    const label = state.mode === 'player' ? state.playerName :
                  state.mode === 'neighbors' ? 'neighbor scan' : state.roomName;
    clearAllPrev();
    delete Memory[MEM_KEY];
    console.log('[RoomCPUProfiler] Cancelled. Memory wiped.');
    _ = label; // suppress lint
    console.log('[RoomCPUProfiler] Profile for ' + label + ' cancelled.');
}

function run() {
    const state = Memory[MEM_KEY];
    if (!state || !state.active) return;
    if (state.mode === 'single')         runSingle(state);
    else if (state.mode === 'player')    runPlayer(state);
    else if (state.mode === 'neighbors') runNeighbors(state);
}

// ── Single mode ──────────────────────────────────────────────────────────────

function runSingle(state) {
    // Reconstruct transient roomState from Memory fields + global prev
    const roomState = {
        roomName:      state.roomName,
        ownRoom:       state.ownRoom,
        observerCount: state.observerCount,
        totals:        state.totals,
    };

    const done = tickRoom(roomState);

    // Sync observerCount back (tickRoom may update it)
    state.observerCount = roomState.observerCount;

    if (done) {
        printSingleReport(state.roomName, state.totals, state.startTick,
                          state.observerCount, state.ownRoom);
        clearPrev(state.roomName);
        delete Memory[MEM_KEY];
        console.log('[RoomCPUProfiler] Complete. Memory wiped.');
    }
}

// ── Player mode ──────────────────────────────────────────────────────────────

function runPlayer(state) {
    if (state.phase === 'scanning') {
        const ws = Memory.wideScan;

        // Mirror foundRooms into our own state every tick while wideScan is active.
        // wideScan.completeScan() calls delete Memory.wideScan before returning,
        // so by the time we run on the following tick ws is already undefined.
        // Caching progressively ensures we never lose the list.
        if (ws && ws.foundRooms && ws.foundRooms.length) {
            state._foundRooms = ws.foundRooms.slice();
        }

        // Still scanning — wait
        if (ws && ws.active) return;

        // wideScan has finished (Memory.wideScan is gone — use our cached copy)
        const found = (state._foundRooms && state._foundRooms.length)
            ? state._foundRooms
            : [];
        delete state._foundRooms;

        if (!found.length) {
            console.log('[RoomCPUProfiler] wideScan found no rooms for ' + state.playerName + '. Aborting.');
            clearAllPrev();
            delete Memory[MEM_KEY];
            return;
        }

        state.roomQueue = found.slice();
        state.phase     = 'profiling';
        console.log('[RoomCPUProfiler] Found ' + found.length + ' room(s) for ' +
            state.playerName + ': ' + found.join(', '));
        console.log('[RoomCPUProfiler] Profiling each room for ' + PROFILE_TICKS +
            ' ticks. Est. ' + (found.length * (PROFILE_TICKS + 3)) + ' ticks total.');
        advanceToNextRoom(state);
        return;
    }

    if (state.phase === 'profiling') {
        if (!state.current) {
            state.phase = 'done';
        } else {
            const roomState = state.current; // already the right shape
            const done = tickRoom(roomState);
            state.current = roomState;       // sync back (observerCount may have changed)

            if (done) {
                // Save completed — only totals, no prev (that's in global heap and gets cleared)
                state.completedRooms.push({
                    roomName:      roomState.roomName,
                    totals:        roomState.totals,
                    observerCount: roomState.observerCount,
                    ownRoom:       roomState.ownRoom,
                });
                clearPrev(roomState.roomName);
                console.log('[RoomCPUProfiler] ' + roomState.roomName + ' complete. ' +
                    state.roomQueue.length + ' room(s) remaining.');
                advanceToNextRoom(state);
            }
        }
    }

    if (state.phase === 'done') {
        printPlayerReport(state.playerName, state.completedRooms);
        clearAllPrev();
        delete Memory[MEM_KEY];
        console.log('[RoomCPUProfiler] Player profile complete. Memory wiped.');
    }
}

function advanceToNextRoom(state) {
    if (!state.roomQueue.length) {
        state.current = null;
        state.phase   = 'done';
        return;
    }
    const next   = state.roomQueue.shift();
    const own    = isOwnRoom(next);
    let obsCount = 0;

    if (!own) {
        const obs = findObservers(next);
        obsCount = obs.length;
        if (!obs.length) {
            console.log('[RoomCPUProfiler] No observer for ' + next + ' \u2014 skipping.');
            advanceToNextRoom(state);
            return;
        }
        // Fire immediately to avoid first-tick visibility gap
        for (const { observer } of obs) observer.observeRoom(next);
        console.log('[RoomCPUProfiler] Now profiling ' + next +
            ' (' + obs.length + ' observer(s))');
    } else {
        console.log('[RoomCPUProfiler] Now profiling ' + next + ' (own room)');
    }

    state.current = {
        roomName: next, ownRoom: own, observerCount: obsCount,
        totals: initTotals(),
        // prev lives in global[GLOBAL_PREV][next] — not here
    };
}

// ═══════════════════════════════════════════════════════════════
// NEIGHBORS MODE
// ═══════════════════════════════════════════════════════════════
//
// Phase 1 (scanning):  wideScanPlayers() discovers all foreign
//     players + rooms.  Own rooms are added when scanning ends.
//
// Phase 2 (profiling): Each room profiled for PROFILE_TICKS via
//     the shared tickRoom(). On completion, only 5 compact
//     numbers are kept per room (low/mid/high per-tick + creeps
//     + rcl). The full totals object is discarded immediately.
//
// Phase 3 (done):      Ranked report printed + Game.notify.
//
// Memory footprint during profiling:
//   - current.totals  (~30 numbers, one room at a time)
//   - completed{}     (~5 numbers per finished room)
//   - playerRoomMap   (room names + rcl per player, read-only after scan)
//   - profileQueue    (shrinks as rooms are consumed)
//
// ═══════════════════════════════════════════════════════════════

function getMyUsername() {
    for (const rn in Game.rooms) {
        const r = Game.rooms[rn];
        if (r.controller && r.controller.my && r.controller.owner) {
            return r.controller.owner.username;
        }
    }
    return null;
}

function startNeighbors() {
    if (Memory[MEM_KEY] && Memory[MEM_KEY].active) {
        console.log('[NeighborProfile] Already active. Call cancelRoomProfile() first.');
        return;
    }
    clearAllPrev();

    const myName = getMyUsername();

    wideScan.startPlayers();
    // wideScan.startPlayers → initScan(null). If no observers exist,
    // Memory.wideScan will NOT be created (initScan returns false).
    // We handle that gracefully in runNeighborScanning.

    Memory[MEM_KEY] = {
        mode: 'neighbors', active: true,
        phase: 'scanning',
        startTick: Game.time,
        myName: myName,
        // Populated after scan completes:
        playerRoomMap: {},  // player -> { rooms:[], rcls:{room:level} }
        profileQueue:  [],  // [{ player, room }]
        currentPlayer: null,
        current:       null, // { roomName, ownRoom, observerCount, totals }
        completed:     {},   // player -> [{ room, low, mid, high, creeps }]
    };

    console.log('[NeighborProfile] Started. Scanning for all players in observer range...');
}

function runNeighbors(state) {
    if (state.phase === 'scanning')       runNeighborScanning(state);
    else if (state.phase === 'profiling') runNeighborProfiling(state);
    // phase 'done' is handled at the end of runNeighborProfiling
}

// ── Phase 1: scanning ─────────────────────────────────────────

function runNeighborScanning(state) {
    const ws = Memory.wideScan;

    // If wideScan never started (no observers), go straight to own rooms
    if (!ws && !state._cachedFound) {
        console.log('[NeighborProfile] No observers — profiling own rooms only.');
        buildNeighborQueue(state, {});
        return;
    }

    // Cache wideScan results progressively.
    // wideScanPlayers stores foundRooms as { player: [{ room, rcl }] }
    // We must cache because wideScan deletes Memory.wideScan on completion.
    if (ws && ws.foundRooms && typeof ws.foundRooms === 'object' &&
        !Array.isArray(ws.foundRooms)) {
        // Only re-cache when the number of players has changed (cheap check)
        const newCount = Object.keys(ws.foundRooms).length;
        const oldCount = state._cachedPlayerCount || 0;
        if (newCount !== oldCount) {
            state._cachedFound = JSON.parse(JSON.stringify(ws.foundRooms));
            state._cachedPlayerCount = newCount;
        }
    }

    // Still scanning — wait
    if (ws && ws.active) return;

    // wideScan has finished
    const found = state._cachedFound || {};
    delete state._cachedFound;
    delete state._cachedPlayerCount;

    buildNeighborQueue(state, found);
}

function buildNeighborQueue(state, wideScanFound) {
    const playerRoomMap = {};

    // Add foreign players from wideScan
    for (const player in wideScanFound) {
        const entries = wideScanFound[player];
        if (!entries || !entries.length) continue;
        playerRoomMap[player] = { rooms: [], rcls: {} };
        for (const e of entries) {
            playerRoomMap[player].rooms.push(e.room);
            playerRoomMap[player].rcls[e.room] = e.rcl;
        }
    }

    // Add own rooms (wideScan excludes rooms we own)
    if (state.myName) {
        if (!playerRoomMap[state.myName]) {
            playerRoomMap[state.myName] = { rooms: [], rcls: {} };
        }
        const me = playerRoomMap[state.myName];
        for (const rn in Game.rooms) {
            const r = Game.rooms[rn];
            if (r.controller && r.controller.my) {
                if (me.rooms.indexOf(rn) === -1) {
                    me.rooms.push(rn);
                    me.rcls[rn] = r.controller.level;
                }
            }
        }
    }

    state.playerRoomMap = playerRoomMap;

    // Build flat profiling queue sorted alphabetically
    const queue   = [];
    const players = Object.keys(playerRoomMap).sort();
    for (const player of players) {
        const rooms = playerRoomMap[player].rooms.slice().sort();
        for (const room of rooms) queue.push({ player: player, room: room });
    }

    if (!queue.length) {
        console.log('[NeighborProfile] No rooms found. Aborting.');
        clearAllPrev();
        delete Memory[MEM_KEY];
        return;
    }

    state.profileQueue = queue;
    state.completed    = {};
    state.phase        = 'profiling';

    const totalRooms = queue.length;
    console.log('[NeighborProfile] Found ' + players.length + ' player(s), ' +
        totalRooms + ' room(s): ' + players.join(', '));
    console.log('[NeighborProfile] Est. ' + (totalRooms * (PROFILE_TICKS + 3)) + ' ticks.');

    advanceNeighborRoom(state);
}

// ── Phase 2: profiling ────────────────────────────────────────

function runNeighborProfiling(state) {
    if (!state.current) {
        finishNeighborProfile(state);
        return;
    }

    const roomState = state.current;
    const done = tickRoom(roomState);
    state.current = roomState; // sync back

    if (done) {
        // Extract only the compact stats we need, discard bulky totals
        const t   = roomState.totals;
        const obs = Math.max(1, t.ticksObserved);
        const cpu = calcCPU(t);

        const player = state.currentPlayer;
        if (!state.completed[player]) state.completed[player] = [];
        state.completed[player].push({
            room:   roomState.roomName,
            low:    cpu.totalLow  / obs,
            mid:    cpu.totalMid  / obs,
            high:   cpu.totalHigh / obs,
            creeps: t.creepCountSum / obs,
        });

        clearPrev(roomState.roomName);

        const remaining = state.profileQueue.length;
        const doneCount = Object.values(state.completed)
            .reduce(function (s, arr) { return s + arr.length; }, 0);
        console.log('[NeighborProfile] ' + roomState.roomName + ' (' + player +
            ') done — ' + doneCount + ' profiled, ' + remaining + ' queued.');

        advanceNeighborRoom(state);

        // If queue is exhausted, finish immediately this tick
        if (!state.current) {
            finishNeighborProfile(state);
        }
    }
}

function advanceNeighborRoom(state) {
    while (state.profileQueue.length) {
        const next = state.profileQueue.shift();
        state.currentPlayer = next.player;

        const own = isOwnRoom(next.room);
        let obsCount = 0;

        if (!own) {
            const obs = findObservers(next.room);
            obsCount = obs.length;
            if (!obs.length) {
                console.log('[NeighborProfile] No observer for ' + next.room + ' — skipping.');
                continue; // try next in queue
            }
            for (const { observer } of obs) observer.observeRoom(next.room);
            console.log('[NeighborProfile] Profiling ' + next.room +
                ' (' + next.player + ', ' + obs.length + ' obs)');
        } else {
            console.log('[NeighborProfile] Profiling ' + next.room +
                ' (' + next.player + ', own)');
        }

        state.current = {
            roomName: next.room, ownRoom: own, observerCount: obsCount,
            totals: initTotals(),
        };
        return;
    }

    // Queue exhausted
    state.current       = null;
    state.currentPlayer = null;
}

// ── Phase 3: report ───────────────────────────────────────────

function finishNeighborProfile(state) {
    printNeighborReport(state);
    clearAllPrev();
    delete Memory[MEM_KEY];
    console.log('[NeighborProfile] Complete. Memory wiped.');
}

function printNeighborReport(state) {
    const elapsed  = Game.time - state.startTick;
    const myName   = state.myName;

    function f2(n) { return n.toFixed(2); }
    function f3(n) { return n.toFixed(3); }

    // ── Build per-player summaries ──────────────────────────────────────
    const summaries = [];
    for (const player in state.completed) {
        const rooms = state.completed[player];
        if (!rooms.length) continue;

        let concLow = 0, concMid = 0, concHigh = 0, concCreeps = 0;
        for (const r of rooms) {
            concLow    += r.low;
            concMid    += r.mid;
            concHigh   += r.high;
            concCreeps += r.creeps;
        }
        concCreeps = Math.round(concCreeps);

        const overheadMid = concCreeps * 0.35 + 1.0;

        // RCLs from playerRoomMap
        const rcls = [];
        const pMap = state.playerRoomMap[player];
        if (pMap) {
            for (const r of rooms) rcls.push(pMap.rcls[r.room] || '?');
        }
        rcls.sort(function (a, b) { return b - a; });

        summaries.push({
            player:        player,
            roomCount:     rooms.length,
            creeps:        concCreeps,
            intentPerTick: concMid,
            cpuPerRoom:    concMid / rooms.length,
            cpuPerCreep:   concCreeps > 0 ? concMid / concCreeps : 0,
            estTotal:      concMid + overheadMid,
            rcls:          rcls,
            roomDetails:   rooms.slice().sort(function (a, b) { return b.mid - a.mid; }),
            isSelf:        player === myName,
        });
    }

    // Sort by intent/tick descending (highest load first)
    summaries.sort(function (a, b) { return b.intentPerTick - a.intentPerTick; });

    const totalPlayers = summaries.length;
    const totalRooms   = summaries.reduce(function (s, p) { return s + p.roomCount; }, 0);

    // ── Console output ──────────────────────────────────────────────────
    const W   = 82;
    const sep = '\u2500'.repeat(W);

    const lines = [
        '\u256C' + '\u2550'.repeat(W) + '\u256C',
        '  NEIGHBOR CPU RANKINGS \u2014 ' + totalPlayers + ' players, ' +
            totalRooms + ' rooms, ' + elapsed + ' ticks elapsed',
        sep,
        '  #  Player            Rooms  Creeps  Intent/tick  CPU/room  CPU/creep  Est.Total',
    ];

    for (var i = 0; i < summaries.length; i++) {
        var p    = summaries[i];
        var star = p.isSelf ? ' \u2605' : '  ';
        var rank = String(i + 1).padStart(2);
        lines.push(
            '  ' + rank + ' ' + (p.player + star).padEnd(18) +
            String(p.roomCount).padStart(4) +
            String(p.creeps).padStart(8) +
            f3(p.intentPerTick).padStart(12) +
            f3(p.cpuPerRoom).padStart(10) +
            f3(p.cpuPerCreep).padStart(10) +
            f2(p.estTotal).padStart(10)
        );
    }

    lines.push(sep);
    lines.push('  \u2605 = you    Intent = observer-measured    Est.Total = intents + overhead');
    lines.push('  CPU/room = intent CPU per room    CPU/creep = intent CPU per concurrent creep');
    lines.push('');

    // Per-player room detail
    for (i = 0; i < summaries.length; i++) {
        p    = summaries[i];
        star = p.isSelf ? ' \u2605' : '';
        var rclStr = p.rcls.join('/');
        lines.push('  ' + p.player + star + ' (' + p.roomCount + ' rooms, ~' +
            p.creeps + ' creeps, RCL ' + rclStr + '):');
        var roomStrs = p.roomDetails.map(function (r) {
            return r.room + '  ' + f3(r.mid) + '/t';
        });
        lines.push('    ' + roomStrs.join('  '));
        lines.push('');
    }

    lines.push('\u2569' + '\u2550'.repeat(W) + '\u2569');
    console.log(lines.join('\n'));

    // ── Game.notify — compact format, batched under 1000 chars ─────────
    //
    // Compression vs old format:
    //   - RCLs grouped: "8×12,7×2,6×2" instead of "8/8/8/8/8/8/8/8/8/8/8/8/7/7/6/6"
    //   - Room values 2 decimals, no "/t" suffix
    //   - Room details capped at 6, remainder shown as "(+N)"
    //   - Summary + rooms on ONE line per player (no separate indented line)

    function compactRcls(rcls) {
        if (!rcls.length) return '?';
        var counts = {}, order = [];
        for (var r = 0; r < rcls.length; r++) {
            var v = rcls[r];
            if (!counts[v]) { counts[v] = 0; order.push(v); }
            counts[v]++;
        }
        return order.map(function (v) {
            return counts[v] > 1 ? v + '\u00D7' + counts[v] : String(v);
        }).join(',');
    }

    var MAX_NOTIFY_ROOMS = 6;

    var notifyLines = [
        '[NeighborProfile] ' + totalPlayers + ' players, ' +
            totalRooms + ' rooms, ' + elapsed + ' ticks'
    ];

    for (i = 0; i < summaries.length; i++) {
        p    = summaries[i];
        star = p.isSelf ? ' \u2605' : '';

        // Room details: top N rooms, compressed
        var topRooms = p.roomDetails.slice(0, MAX_NOTIFY_ROOMS);
        var roomStr = topRooms.map(function (r) {
            return r.room + '=' + f2(r.mid);
        }).join(' ');
        var extra = p.roomDetails.length - MAX_NOTIFY_ROOMS;
        if (extra > 0) roomStr += ' (+' + extra + ')';

        notifyLines.push(
            '#' + (i + 1) + ' ' + p.player + star + ': ' +
            p.roomCount + 'rm(RCL' + compactRcls(p.rcls) + ') ~' + p.creeps + 'cr ' +
            f3(p.intentPerTick) + 'int/t ' +
            f3(p.cpuPerRoom) + '/rm ' +
            f3(p.cpuPerCreep) + '/cr ~' + f2(p.estTotal) + 'est/t | ' +
            roomStr
        );
    }

    // Batch into ≤998-char notifications.
    // If a single line exceeds 998 it is sent alone (truncated by the server,
    // but this should no longer happen with the compression above).
    var batch = '';
    for (var j = 0; j < notifyLines.length; j++) {
        var line = notifyLines[j];
        if (batch && batch.length + line.length + 1 > 998) {
            Game.notify(batch, 0);
            batch = line;
        } else {
            batch += (batch ? '\n' : '') + line;
        }
    }
    if (batch) Game.notify(batch, 0);
}

// ═══════════════════════════════════════════════════════════════
// STATUS  (handles single, player, AND neighbors modes)
// ═══════════════════════════════════════════════════════════════

function status() {
    const state = Memory[MEM_KEY];
    if (!state || !state.active) {
        console.log('[RoomCPUProfiler] No active profile.');
        return null;
    }

    const elapsed = Game.time - state.startTick;

    if (state.mode === 'single') {
        const t   = state.totals;
        const obs = t.ticksObserved;
        const pct = ((obs / PROFILE_TICKS) * 100).toFixed(1);
        const cpu = calcCPU(t);
        console.log('[RoomCPUProfiler] SINGLE \u2014 ' + state.roomName);
        console.log('  Progress  : ' + obs + ' / ' + PROFILE_TICKS + ' ticks (' + pct + '%)');
        console.log('  Elapsed   : ' + elapsed + ' ticks');
        console.log('  Invisible : ' + t.invisibleTicks);
        console.log('  Observers : ' + (state.ownRoom ? 'own room' : state.observerCount));
        if (obs > 0) {
            console.log('  Running avg (typical): ~' +
                (cpu.totalMid / obs).toFixed(3) + ' CPU/tick');
            console.log('  Simple CPU so far    : ' + cpu.simpleCPU.toFixed(2));
            console.log('  Move range so far    : ' +
                cpu.moveLow.toFixed(2) + '\u2013' + cpu.moveHigh.toFixed(2) + ' CPU');
        }

    } else if (state.mode === 'player') {
        // Player mode
        const phase = state.phase;
        console.log('[RoomCPUProfiler] PLAYER \u2014 ' + state.playerName +
            '  [phase: ' + phase + ']');
        console.log('  Elapsed     : ' + elapsed + ' ticks');

        if (phase === 'scanning') {
            const ws = Memory.wideScan;
            if (ws && ws.active) {
                const pct = ((ws.scannedCount / Math.max(1, ws.totalRooms)) * 100).toFixed(1);
                console.log('  wideScan    : ' + ws.scannedCount + '/' + ws.totalRooms +
                    ' (' + pct + '%)  found ' + ws.foundRooms.length + ' room(s) so far');
            } else {
                console.log('  wideScan    : finishing up...');
            }

        } else if (phase === 'profiling') {
            const done  = state.completedRooms.length;
            const total = done + state.roomQueue.length + (state.current ? 1 : 0);
            console.log('  Rooms done  : ' + done + ' / ' + total);
            if (state.roomQueue.length) {
                console.log('  Queue       : ' + state.roomQueue.join(', '));
            }
            if (state.current) {
                const cur = state.current;
                const t   = cur.totals;
                const pct = ((t.ticksObserved / PROFILE_TICKS) * 100).toFixed(1);
                const cpu = calcCPU(t);
                console.log('  Current     : ' + cur.roomName +
                    '  ' + t.ticksObserved + '/' + PROFILE_TICKS + ' ticks (' + pct + '%)' +
                    '  invis=' + t.invisibleTicks);
                if (t.ticksObserved > 0) {
                    console.log('  Running avg : ~' + (cpu.totalMid / t.ticksObserved).toFixed(3) + ' CPU/tick');
                }
            }
            if (done > 0) {
                console.log('  Completed rooms:');
                for (const r of state.completedRooms) {
                    const c = calcCPU(r.totals);
                    const obs = r.totals.ticksObserved;
                    console.log('    ' + r.roomName.padEnd(10) +
                        ' typical=' + (c.totalMid / Math.max(1, obs)).toFixed(3) + '/tick' +
                        '  total=' + c.totalLow.toFixed(2) + '-' + c.totalHigh.toFixed(2) + ' CPU');
                }
            }
        }

    } else if (state.mode === 'neighbors') {
        console.log('[NeighborProfile] NEIGHBORS  [phase: ' + state.phase + ']');
        console.log('  Elapsed     : ' + elapsed + ' ticks');

        if (state.phase === 'scanning') {
            const ws = Memory.wideScan;
            if (ws && ws.active) {
                const pct = ((ws.scannedCount / Math.max(1, ws.totalRooms)) * 100).toFixed(1);
                const playerCount = typeof ws.foundRooms === 'object' && !Array.isArray(ws.foundRooms)
                    ? Object.keys(ws.foundRooms).length : 0;
                console.log('  wideScan    : ' + ws.scannedCount + '/' + ws.totalRooms +
                    ' (' + pct + '%)  ' + playerCount + ' player(s) found');
            } else {
                console.log('  wideScan    : finishing...');
            }

        } else if (state.phase === 'profiling') {
            const doneCount = Object.values(state.completed)
                .reduce(function (s, arr) { return s + arr.length; }, 0);
            const totalRooms = doneCount + state.profileQueue.length +
                (state.current ? 1 : 0);
            const players = Object.keys(state.playerRoomMap).length;

            console.log('  Players     : ' + players);
            console.log('  Rooms       : ' + doneCount + '/' + totalRooms + ' profiled');

            if (state.current) {
                const cur = state.current;
                const t   = cur.totals;
                const pct = ((t.ticksObserved / PROFILE_TICKS) * 100).toFixed(1);
                console.log('  Current     : ' + cur.roomName + ' (' + state.currentPlayer +
                    ')  ' + t.ticksObserved + '/' + PROFILE_TICKS + ' (' + pct + '%)' +
                    '  invis=' + t.invisibleTicks);
                if (t.ticksObserved > 0) {
                    const cpu = calcCPU(t);
                    console.log('  Running avg : ~' + (cpu.totalMid / t.ticksObserved).toFixed(3) + ' CPU/tick');
                }
            }

            // Show completed players with compact stats
            for (const player in state.completed) {
                const rooms = state.completed[player];
                if (!rooms.length) continue;
                const mid = rooms.reduce(function (s, r) { return s + r.mid; }, 0);
                const roomStr = rooms.map(function (r) {
                    return r.room + '=' + r.mid.toFixed(3) + '/t';
                }).join(' ');
                console.log('  ' + player.padEnd(16) + ' ' + mid.toFixed(3) +
                    ' intent/t  [' + roomStr + ']');
            }
        }
    }

    return state;
}

module.exports = { start, cancel, run, status, startNeighbors: startNeighbors };

global.profileRoom          = start;
global.cancelRoomProfile    = cancel;
global.roomProfileStatus    = status;
global.profileNeighbors     = startNeighbors;