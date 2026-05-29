/**
 * energyProfiler.js  (v2)
 * ===========================================================================
 * Profile a single room's energy economy over a creep-lifecycle window
 * (1500 ticks). Tracks income (per source), per-building expenditure,
 * per-creep expenditure (WORK creeps), and a mass-balance loss residual.
 *
 * USAGE
 * ─────
 *   profileEnergy('W5N3')        — start a 1500-tick profile (own or foreign)
 *   energyProfileStatus()        — check progress
 *   cancelEnergyProfile()        — abort (prints partial results)
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const PROFILE_TICKS   = 1500;
const MAX_OBSERVERS   = 2;
const LOG_INTERVAL    = 250;
const MEM_KEY         = 'energyProfile';
const GLOBAL_PREV     = '__energyProfilerPrev';

// ── Notification chunking (mirrors warEstimate.js) ────────────────────────
const NOTIFY_CHAR_LIMIT  = 500;   // body chars per chunk
const NOTIFY_HEADER_MAX  = 50;    // "[EnergyProfile: W12N34] Part 10/10\n"
const NOTIFY_TOTAL_MAX   = NOTIFY_CHAR_LIMIT - NOTIFY_HEADER_MAX;
const NOTIFY_PER_TICK    = 10;

// ── Creep grouping ────────────────────────────────────────────────────────
const SIMILARITY_THRESHOLD = 0.5; // 50% common-prefix match

// Event types
const EV_BUILD              = 4;
const EV_HARVEST            = 5;
const EV_REPAIR             = 7;
const EV_UPGRADE_CONTROLLER = 9;
const EV_TRANSFER           = 12;

// Body part costs (Screeps constants — duplicated here to be self-contained)
const BODYPART_COST = {
    move: 50, work: 100, carry: 50, attack: 80,
    ranged_attack: 150, heal: 250, claim: 600, tough: 10,
};

const ROOM_NAME_RE = /^[WE]\d+[NS]\d+$/;

// ═══════════════════════════════════════════════════════════════════════════
// ROOM / OBSERVER HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function isRoomName(s) { return ROOM_NAME_RE.test(s); }

function isOwnRoom(roomName) {
    const r = Game.rooms[roomName];
    return !!(r && r.controller && r.controller.my);
}

function findObservers(targetRoom) {
    const results = [];
    for (const rn in Game.rooms) {
        const room = Game.rooms[rn];
        if (!room.controller || !room.controller.my) continue;
        const obs = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER && s.isActive(),
        });
        if (!obs.length) continue;
        const dist = Game.map.getRoomLinearDistance(rn, targetRoom);
        if (dist <= 10) results.push({ observer: obs[0], dist, room: rn });
    }
    results.sort((a, b) => a.dist - b.dist);
    return results.slice(0, MAX_OBSERVERS);
}

function fireObservers(targetRoom) {
    const obs = findObservers(targetRoom);
    let fired = 0;
    for (const { observer } of obs) {
        if (observer.observeRoom(targetRoom) === OK) fired++;
    }
    return { count: obs.length, fired };
}

// ═══════════════════════════════════════════════════════════════════════════
// HEAP-ONLY PREV SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════

function getPrev(rn)    { return (global[GLOBAL_PREV] && global[GLOBAL_PREV][rn]) || null; }
function setPrev(rn, s) { if (!global[GLOBAL_PREV]) global[GLOBAL_PREV] = {}; global[GLOBAL_PREV][rn] = s; }
function clearPrev(rn)  { if (global[GLOBAL_PREV]) delete global[GLOBAL_PREV][rn]; }
function clearAllPrev() { delete global[GLOBAL_PREV]; }

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE MAX RATE  (mirrored from roomIntel.js)
// ═══════════════════════════════════════════════════════════════════════════

function getSourceMaxRate(source) {
    let maxRate = (source.energyCapacity || SOURCE_ENERGY_CAPACITY) / ENERGY_REGEN_TIME;
    if (source.effects && source.effects.length) {
        for (const eff of source.effects) {
            if (eff.effect !== PWR_REGEN_SOURCE) continue;
            const info     = (typeof POWER_INFO !== 'undefined') ? POWER_INFO[PWR_REGEN_SOURCE] : null;
            const level    = eff.level || 1;
            const perCycle = (info && info.effect && info.effect[level - 1]) || 0;
            const period   = (info && info.period) || 15;
            if (period > 0) maxRate += perCycle / period;
        }
    }
    return maxRate;
}

// ═══════════════════════════════════════════════════════════════════════════
// BODY UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function bodyCostOf(body) {
    let cost = 0;
    for (const p of body) cost += BODYPART_COST[p.type || p] || 0;
    return cost;
}

function hasWork(body) {
    for (const p of body) if ((p.type || p) === WORK) return true;
    return false;
}

function bodySig(body) {
    const counts = {};
    for (const p of body) {
        const t = p.type || p;
        counts[t] = (counts[t] || 0) + 1;
    }
    const order  = [WORK, CARRY, MOVE, ATTACK, RANGED_ATTACK, HEAL, CLAIM, TOUGH];
    const letter = { work: 'W', carry: 'C', move: 'M', attack: 'A',
                     ranged_attack: 'R', heal: 'H', claim: 'L', tough: 'T' };
    let sig = '';
    for (const k of order) if (counts[k]) sig += counts[k] + letter[k];
    return sig;
}

function inferRole(body) {
    const counts = {};
    for (const p of body) counts[p.type || p] = (counts[p.type || p] || 0) + 1;
    const w  = counts.work || 0;
    const c  = counts.carry || 0;
    const a  = (counts.attack || 0) + (counts.ranged_attack || 0);
    const h  = counts.heal || 0;
    const cl = counts.claim || 0;
    if (cl)                       return 'claimer';
    if (a)                        return 'attacker';
    if (h)                        return 'healer';
    if (w === 0 && c === 0)       return 'scout';
    if (w >= 5 && c <= 1)         return 'static-miner';
    if (w === 0 && c >= 5)        return 'hauler';
    if (c === 0 && w > 0)         return 'worker-no-carry';
    if (w > 0 && c > 0)           return 'worker';
    return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════
// NAME SIMILARITY  (50% common-prefix grouping)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Length of the longest common prefix between two strings.
 */
function commonPrefixLen(a, b) {
    const min = Math.min(a.length, b.length);
    let i = 0;
    while (i < min && a.charAt(i) === b.charAt(i)) i++;
    return i;
}

/**
 * Group creeps by name similarity. Two creeps share a group when their common
 * prefix is at least `threshold` of EACH name's length. The group's prefix is
 * iteratively refined as members are added — a new candidate must satisfy the
 * threshold against the current group prefix (which by construction is the
 * longest prefix shared by all current members).
 *
 * Group label = group prefix + '*' (if at least one member has a longer name)
 *             | exact prefix     (if all members share the prefix as full name)
 */
function groupCreepsByNameSimilarity(entries, threshold) {
    const t = (threshold !== undefined) ? threshold : SIMILARITY_THRESHOLD;
    const groups = [];
    for (const c of entries) {
        const name = c.name || c.id || '';
        if (!name) continue;
        let placed = false;
        for (const g of groups) {
            const cp = commonPrefixLen(name, g.prefix);
            const r1 = cp / name.length;
            const r2 = cp / g.prefix.length;
            if (r1 >= t && r2 >= t) {
                g.prefix = name.slice(0, cp);
                g.members.push(c);
                placed = true;
                break;
            }
        }
        if (!placed) groups.push({ prefix: name, members: [c] });
    }
    for (const g of groups) {
        const allExact = g.members.every(m => (m.name || m.id || '') === g.prefix);
        g.label = allExact ? g.prefix : g.prefix + '*';
    }
    return groups;
}

/**
 * Aggregate per-creep ledger entries into a group summary line.
 */
function aggregateCreepGroup(g) {
    const ms = g.members;
    const harvested = ms.reduce((s, m) => s + (m.harvested || 0), 0);
    const upgraded  = ms.reduce((s, m) => s + (m.upgraded  || 0), 0);
    const built     = ms.reduce((s, m) => s + (m.built     || 0), 0);
    const repaired  = ms.reduce((s, m) => s + (m.repaired  || 0), 0);
    const bodyCost  = ms.reduce((s, m) => s + (m.bodyCost  || 0), 0);
    const total     = harvested + upgraded + built + repaired;

    // Dominant body sig and role (with diversity flag)
    const sigs = {}, roles = {};
    for (const m of ms) {
        sigs[m.bodySig || '?']  = (sigs[m.bodySig || '?']  || 0) + 1;
        roles[m.role || '?']    = (roles[m.role || '?']    || 0) + 1;
    }
    const sigEntries  = Object.entries(sigs).sort((a, b) => b[1] - a[1]);
    const roleEntries = Object.entries(roles).sort((a, b) => b[1] - a[1]);
    const bodySigStr  = sigEntries.length > 1 ? (sigEntries[0][0] + '+') : sigEntries[0][0];
    const roleStr     = roleEntries.length > 1 ? (roleEntries[0][0] + '+') : roleEntries[0][0];

    const numPreExisting = ms.filter(m => m.preExisting).length;
    const numDied        = ms.filter(m => m.diedAtTick !== null).length;
    const tombstoneLoss  = ms.reduce((s, m) =>
        s + (m.tombstoneDespawned ? Math.max(0, (m.diedLoaded || 0) - (m.tombstoneLooted || 0)) : 0), 0);

    return {
        label: g.label,
        count: ms.length,
        bodySig: bodySigStr,
        role: roleStr,
        bodyCost, harvested, upgraded, built, repaired, total,
        numPreExisting, numDied, tombstoneLoss,
        members: ms,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════

function takeSnapshot(room) {
    const snap = {
        sources:    {},
        towers:     {},
        labs:       {},
        links:      {},
        spawns:     {},
        creepNames: {},
        terminal:   null,
        nuker:      null,
        powerSpawn: null,
        tombstones: {},
        drops:      {},
        creepIds:   {},
        roomTotal:  0,
    };

    for (const s of room.find(FIND_SOURCES)) {
        snap.sources[s.id] = s.energy;
    }

    for (const s of room.find(FIND_STRUCTURES)) {
        const e = (s.store && s.store[RESOURCE_ENERGY]) || 0;
        switch (s.structureType) {
            case STRUCTURE_TOWER:       snap.towers[s.id] = e;  snap.roomTotal += e; break;
            case STRUCTURE_LAB:         snap.labs[s.id]   = e;  snap.roomTotal += e; break;
            case STRUCTURE_LINK:        snap.links[s.id]  = e;  snap.roomTotal += e; break;
            case STRUCTURE_TERMINAL:    snap.terminal     = { id: s.id, energy: e }; snap.roomTotal += e; break;
            case STRUCTURE_NUKER:       snap.nuker        = { id: s.id, energy: e }; snap.roomTotal += e; break;
            case STRUCTURE_POWER_SPAWN: snap.powerSpawn   = { id: s.id, energy: e }; snap.roomTotal += e; break;
            case STRUCTURE_SPAWN: {
                const sp = s.spawning;
                snap.spawns[s.id] = sp ? { name: sp.name } : null;
                snap.roomTotal += e;
                break;
            }
            default:
                if (s.store) snap.roomTotal += e;
                break;
        }
    }

    for (const c of room.find(FIND_CREEPS)) {
        snap.roomTotal += (c.store && c.store[RESOURCE_ENERGY]) || 0;
        snap.creepIds[c.id]     = { name: c.name, body: c.body, my: c.my };
        snap.creepNames[c.name] = { id: c.id, body: c.body, my: c.my };
    }
    for (const pc of room.find(FIND_POWER_CREEPS)) {
        snap.roomTotal += (pc.store && pc.store[RESOURCE_ENERGY]) || 0;
    }
    for (const t of room.find(FIND_TOMBSTONES)) {
        const e = (t.store && t.store[RESOURCE_ENERGY]) || 0;
        snap.tombstones[t.id] = {
            energy:    e,
            creepName: t.creep ? t.creep.name : null,
            creepId:   t.creep ? t.creep.id   : null,
        };
        snap.roomTotal += e;
    }
    for (const r of room.find(FIND_RUINS)) {
        snap.roomTotal += (r.store && r.store[RESOURCE_ENERGY]) || 0;
    }
    for (const d of room.find(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY,
    })) {
        snap.drops[d.id] = d.amount;
        snap.roomTotal  += d.amount;
    }

    return snap;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOTALS
// ═══════════════════════════════════════════════════════════════════════════

function initTotals() {
    return {
        ticksObserved:  0,
        invisibleTicks: 0,

        sourceMaxRates:  {},
        sourceHarvested: {},
        sourceNames:     {},

        towerSpend: {},
        labSpend:   {},
        linkSpend:  {},
        terminalSpend:    0,
        terminalReceived: 0,
        nukerSpend:       0,
        powerSpawnSpend:  0,

        linkDeposits:  0,
        linkWithdraws: 0,
        linkNetDelta:  0,

        creepToTerminal:   0,
        creepFromTerminal: 0,

        workSpawnCost:    0,
        nonWorkSpawnCost: 0,

        initialRoomTotal: 0,
        finalRoomTotal:   0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// CREEP LEDGER
// ═══════════════════════════════════════════════════════════════════════════

function newLedgerEntry(id, name, body, role, isPreExisting, tick) {
    return {
        id, name, role,
        bodySig:        bodySig(body),
        bodyCost:       bodyCostOf(body),
        ticksFirstSeen: tick,
        ticksLastSeen:  tick,
        harvested: 0, upgraded: 0, built: 0, repaired: 0,
        diedAtTick:           null,
        diedLoaded:           0,
        tombstoneId:          null,
        tombstoneFinalEnergy: null,
        tombstoneLooted:      0,
        tombstoneDespawned:   null,
        preExisting:          !!isPreExisting,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LOG PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

function processEvents(events, t, ledger, towerIds, linkIds, terminalId) {
    if (!events || !events.length) return;

    for (const ev of events) {
        const oid  = ev.objectId;
        const data = ev.data || {};
        switch (ev.event) {
            case EV_HARVEST: {
                const amt = data.amount || 0;
                if (data.targetId && t.sourceMaxRates[data.targetId] !== undefined) {
                    t.sourceHarvested[data.targetId] =
                        (t.sourceHarvested[data.targetId] || 0) + amt;
                    if (oid && ledger[oid]) ledger[oid].harvested += amt;
                }
                break;
            }
            case EV_UPGRADE_CONTROLLER: {
                const amt = data.amount || 0;
                if (oid && ledger[oid]) ledger[oid].upgraded += amt;
                break;
            }
            case EV_BUILD: {
                const amt = (typeof data.energySpent === 'number' && data.energySpent > 0)
                    ? data.energySpent
                    : (data.amount || 0);
                if (oid && ledger[oid]) ledger[oid].built += amt;
                break;
            }
            case EV_REPAIR: {
                if (towerIds.has(oid)) break;
                let amt;
                if (typeof data.energySpent === 'number') {
                    amt = data.energySpent;
                } else {
                    amt = (data.amount || 0) * (typeof REPAIR_COST !== 'undefined' ? REPAIR_COST : 0.01);
                }
                if (oid && ledger[oid]) ledger[oid].repaired += amt;
                break;
            }
            case EV_TRANSFER: {
                if (data.resourceType !== RESOURCE_ENERGY) break;
                const amt = data.amount || 0;
                if (linkIds.has(data.targetId)) t.linkDeposits  += amt;
                if (linkIds.has(oid))           t.linkWithdraws += amt;
                if (terminalId && data.targetId === terminalId) t.creepToTerminal   += amt;
                if (terminalId && oid === terminalId)            t.creepFromTerminal += amt;
                break;
            }
            default: break;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PER-TICK ACCUMULATE
// ═══════════════════════════════════════════════════════════════════════════

function accumulate(prev, curr, room, state) {
    const t      = state.totals;
    const ledger = state.creepLedger;

    // Towers
    const towerIds = new Set();
    for (const id in curr.towers) {
        towerIds.add(id);
        if (prev.towers[id] !== undefined) {
            const drop = Math.max(0, prev.towers[id] - curr.towers[id]);
            if (drop > 0) t.towerSpend[id] = (t.towerSpend[id] || 0) + drop;
        }
    }

    // Labs
    for (const id in curr.labs) {
        if (prev.labs[id] !== undefined) {
            const drop = Math.max(0, prev.labs[id] - curr.labs[id]);
            if (drop > 0) t.labSpend[id] = (t.labSpend[id] || 0) + drop;
        }
    }

    // Links
    const linkIds = new Set();
    for (const id in curr.links) {
        linkIds.add(id);
        if (prev.links[id] !== undefined) {
            const drop = Math.max(0, prev.links[id] - curr.links[id]);
            if (drop > 0) t.linkSpend[id] = (t.linkSpend[id] || 0) + drop;
            t.linkNetDelta += (curr.links[id] - prev.links[id]);
        }
    }

    // Terminal
    let terminalId = null;
    if (curr.terminal) {
        terminalId = curr.terminal.id;
        if (prev.terminal) {
            const drop = Math.max(0, prev.terminal.energy - curr.terminal.energy);
            const gain = Math.max(0, curr.terminal.energy - prev.terminal.energy);
            t.terminalSpend    += drop;
            t.terminalReceived += gain;
        }
    }

    // Nuker
    if (curr.nuker && prev.nuker) {
        t.nukerSpend += Math.max(0, prev.nuker.energy - curr.nuker.energy);
    }

    // Power spawn
    if (curr.powerSpawn && prev.powerSpawn) {
        t.powerSpawnSpend += Math.max(0, prev.powerSpawn.energy - curr.powerSpawn.energy);
    }

    // Spawn detection
    for (const id in curr.spawns) {
        const cs = curr.spawns[id];
        const ps = prev.spawns[id];
        const currName = cs ? cs.name : null;
        const prevName = ps ? ps.name : null;
        if (!currName || currName === prevName) continue;

        const info = curr.creepNames[currName];
        if (!info || !info.body || !info.body.length) {
            state.pendingSpawnNames = state.pendingSpawnNames || {};
            state.pendingSpawnNames[currName] = Game.time;
            continue;
        }

        const cost   = bodyCostOf(info.body);
        const isWork = hasWork(info.body);
        if (isWork) {
            t.workSpawnCost += cost;
            state.spawnedNames[currName] = {
                role:     'pending',
                bodyCost: cost,
                bodySig:  bodySig(info.body),
            };
        } else {
            t.nonWorkSpawnCost += cost;
            state.nonWorkNames[currName] = true;
        }
    }

    // Recover pending spawns
    if (state.pendingSpawnNames) {
        for (const name in state.pendingSpawnNames) {
            const info = curr.creepNames[name];
            if (!info || !info.body || !info.body.length) continue;
            const cost   = bodyCostOf(info.body);
            const isWork = hasWork(info.body);
            if (isWork) {
                t.workSpawnCost += cost;
                state.spawnedNames[name] = {
                    role:     'pending',
                    bodyCost: cost,
                    bodySig:  bodySig(info.body),
                };
            } else {
                t.nonWorkSpawnCost += cost;
                state.nonWorkNames[name] = true;
            }
            delete state.pendingSpawnNames[name];
        }
    }

    // Creep ledger maintenance
    for (const id in curr.creepIds) {
        const info = curr.creepIds[id];
        if (ledger[id]) {
            ledger[id].ticksLastSeen = Game.time;
            continue;
        }
        if (state.nonWorkNames[info.name]) continue;
        if (!hasWork(info.body))            continue;

        const spawnInfo  = state.spawnedNames[info.name];
        const preExisting = !spawnInfo;
        const role        = inferRole(info.body);
        ledger[id] = newLedgerEntry(id, info.name, info.body, role,
                                     preExisting, Game.time);
        if (spawnInfo) delete state.spawnedNames[info.name];
    }

    // Death detection
    for (const id in ledger) {
        const e = ledger[id];
        if (e.diedAtTick !== null) continue;
        if (curr.creepIds[id])     continue;
        if (!prev.creepIds[id])    continue;

        e.diedAtTick = Game.time;
        for (const tid in curr.tombstones) {
            const ts = curr.tombstones[tid];
            if (ts.creepId === id || ts.creepName === e.name) {
                e.tombstoneId = tid;
                e.diedLoaded  = ts.energy;
                state.tombstoneToLedger[tid] = id;
                break;
            }
        }
    }

    // Tombstone fate
    for (const tid in state.tombstoneToLedger) {
        const lid = state.tombstoneToLedger[tid];
        const e   = ledger[lid];
        if (!e) continue;
        const prevTs = prev.tombstones[tid];
        const currTs = curr.tombstones[tid];
        if (currTs) {
            const drop = prevTs ? Math.max(0, prevTs.energy - currTs.energy) : 0;
            e.tombstoneLooted     += drop;
            e.tombstoneFinalEnergy = currTs.energy;
        } else {
            if (prevTs) {
                e.tombstoneFinalEnergy = 0;
                e.tombstoneDespawned   = prevTs.energy > 0;
            }
            delete state.tombstoneToLedger[tid];
        }
    }

    // Event log
    let events;
    try   { events = JSON.parse(room.getEventLog(true)); }
    catch (e) { events = room.getEventLog(); }
    processEvents(events, t, ledger, towerIds, linkIds, terminalId);

    t.ticksObserved++;
    t.finalRoomTotal = curr.roomTotal;
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE TICK
// ═══════════════════════════════════════════════════════════════════════════

function tickRoom(state) {
    const name = state.roomName;
    const own  = state.ownRoom;

    if (!own) {
        const { count, fired } = fireObservers(name);
        state.observerCount = count;
        if (count > 0 && fired === 0 && Game.time % 50 === 0) {
            console.log('[EnergyProfiler] WARNING: all observers busy for ' + name);
        }
    }

    const room = Game.rooms[name];
    if (!room) {
        state.totals.invisibleTicks++;
        return false;
    }

    const snap = takeSnapshot(room);
    const prev = getPrev(name);

    if (!prev) {
        if (state.totals.initialRoomTotal === 0 &&
            Object.keys(state.totals.sourceMaxRates).length === 0) {
            let sIdx = 1;
            for (const src of room.find(FIND_SOURCES)) {
                state.totals.sourceMaxRates[src.id]  = getSourceMaxRate(src);
                state.totals.sourceHarvested[src.id] = 0;
                state.totals.sourceNames[src.id]     = 'S' + (sIdx++);
            }
            state.totals.initialRoomTotal = snap.roomTotal;
            state.totals.finalRoomTotal   = snap.roomTotal;
        }
        setPrev(name, snap);
        console.log('[EnergyProfiler] Baseline — ' + name + ' @ tick ' + Game.time);
        return false;
    }

    accumulate(prev, snap, room, state);
    setPrev(name, snap);

    const t = state.totals.ticksObserved;
    if (t > 0 && t % LOG_INTERVAL === 0 && t < PROFILE_TICKS) {
        const elapsed = Game.time - state.startTick;
        const eta     = Math.round(elapsed * (PROFILE_TICKS - t) / Math.max(1, t));
        console.log('[EnergyProfiler] ' + name + ' — ' + t + '/' + PROFILE_TICKS +
            ' diff ticks  (elapsed ' + elapsed + ', ETA ~' + eta + ' ticks)');
    }

    return t >= PROFILE_TICKS;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

function start(target) {
    if (!target || typeof target !== 'string' || !isRoomName(target)) {
        console.log('[EnergyProfiler] Usage: profileEnergy("W5N3")');
        return;
    }
    if (Memory[MEM_KEY] && Memory[MEM_KEY].active) {
        console.log('[EnergyProfiler] Already active for ' + Memory[MEM_KEY].roomName +
            '. Call cancelEnergyProfile() first.');
        return;
    }
    clearAllPrev();

    const own  = isOwnRoom(target);
    let obsCount = 0;
    if (own) {
        console.log('[EnergyProfiler] ' + target + ' is your room — no observer needed.');
    } else {
        const obs = findObservers(target);
        obsCount = obs.length;
        if (!obs.length) {
            console.log('[EnergyProfiler] WARNING: no observer within 10 rooms of ' + target);
        } else {
            console.log('[EnergyProfiler] ' + obs.length + ' observer(s): ' +
                obs.map(o => o.room + '(d' + o.dist + ')').join(', '));
            for (const { observer } of obs) observer.observeRoom(target);
        }
    }

    Memory[MEM_KEY] = {
        active:        true,
        phase:         'profiling',
        roomName:      target,
        startTick:     Game.time,
        ownRoom:       own,
        observerCount: obsCount,
        totals:        initTotals(),
        creepLedger:   {},
        spawnedNames:  {},
        nonWorkNames:  {},
        pendingSpawnNames: {},
        tombstoneToLedger: {},
        notifyQueue:   [],
        notifySent:    0,
    };

    const elapsedHrs = (PROFILE_TICKS / 3600).toFixed(1);
    console.log('[EnergyProfiler] Started — ' + target + ' for ' + PROFILE_TICKS +
        ' ticks (~' + elapsedHrs + ' hours wall-clock).');
}

function cancel() {
    if (!Memory[MEM_KEY]) {
        console.log('[EnergyProfiler] Nothing active.');
        return;
    }
    const state = Memory[MEM_KEY];
    if (state.phase === 'notifying') {
        console.log('[EnergyProfiler] Cancelling pending notifications (' +
            (state.notifyQueue.length - state.notifySent) + ' remaining).');
        clearAllPrev();
        delete Memory[MEM_KEY];
        return;
    }
    console.log('[EnergyProfiler] Cancelling — printing partial results for ' +
        state.roomName + ' after ' + state.totals.ticksObserved + ' ticks.');
    if (state.totals.ticksObserved > 0) {
        const lines = printReport(state, true);
        // Partial cancel: still queue notifications. clearAllPrev() now —
        // profiling is done; runNotifyPhase only needs state.notifyQueue.
        state.phase       = 'notifying';
        state.notifyQueue = splitNotifications(lines, state.roomName);
        state.notifySent  = 0;
        clearAllPrev();
        return;
    }
    clearAllPrev();
    delete Memory[MEM_KEY];
}

function run() {
    const state = Memory[MEM_KEY];
    if (!state || !state.active) return;

    if (state.phase === 'notifying') {
        runNotifyPhase(state);
        return;
    }

    // Default: profiling
    const done = tickRoom(state);
    if (done) {
        const lines = printReport(state, false);
        state.phase       = 'notifying';
        state.notifyQueue = splitNotifications(lines, state.roomName);
        state.notifySent  = 0;
        clearAllPrev();
    }
}

function status() {
    const state = Memory[MEM_KEY];
    if (!state || !state.active) {
        console.log('[EnergyProfiler] No active profile.');
        return null;
    }

    if (state.phase === 'notifying') {
        const remaining = state.notifyQueue.length - state.notifySent;
        console.log('[EnergyProfiler] ' + state.roomName + ' — notifying: ' +
            state.notifySent + '/' + state.notifyQueue.length +
            ' sent (' + remaining + ' remaining)');
        return state;
    }

    const t       = state.totals;
    const obs     = t.ticksObserved;
    const pct     = ((obs / PROFILE_TICKS) * 100).toFixed(1);
    const elapsed = Game.time - state.startTick;
    const eta     = obs > 0 ? Math.round(elapsed * (PROFILE_TICKS - obs) / obs) : '?';

    const ledgerCount     = Object.keys(state.creepLedger).length;
    const aliveCount      = Object.values(state.creepLedger).filter(e => e.diedAtTick === null).length;
    const totalHarvested  = Object.values(t.sourceHarvested).reduce((s, v) => s + v, 0);
    const incomePerTick   = obs > 0 ? totalHarvested / obs : 0;
    const buildingSpend   = Object.values(t.towerSpend).reduce((s, v) => s + v, 0)
                          + Object.values(t.labSpend).reduce((s, v) => s + v, 0)
                          + t.nukerSpend + t.powerSpawnSpend
                          + Math.max(0, t.terminalSpend - t.creepFromTerminal);

    console.log('[EnergyProfiler] ' + state.roomName +
        '  [' + (state.ownRoom ? 'own' : state.observerCount + ' obs') + ']');
    console.log('  Progress  : ' + obs + '/' + PROFILE_TICKS + ' (' + pct + '%)' +
        '   invis=' + t.invisibleTicks);
    console.log('  Elapsed   : ' + elapsed + ' ticks   ETA ' + eta + ' ticks');
    console.log('  Income    : ~' + incomePerTick.toFixed(2) + ' E/tick  (total ' +
        Math.round(totalHarvested) + ')');
    console.log('  Bldg spend: ~' + (obs > 0 ? (buildingSpend / obs).toFixed(2) : '0') +
        ' E/tick  (total ' + Math.round(buildingSpend) + ')');
    console.log('  WORK creeps: ' + ledgerCount + ' tracked  (' + aliveCount + ' alive)');
    console.log('  Spawn cost: work ' + t.workSpawnCost + '   non-work ' + t.nonWorkSpawnCost);

    return state;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════

function f0(n)  { return Math.round(n).toString(); }
function f1(n)  { return n.toFixed(1); }
function f2(n)  { return n.toFixed(2); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

function fmtNum(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n).toString();
}

function fmtPctSafe(num, denom) {
    if (denom === 0) return '   —';
    return (num / denom * 100).toFixed(1) + '%';
}

function shortId(id) {
    if (!id) return '?';
    return id.length > 6 ? id.slice(-6) : id;
}

function padR(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s; }

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════

function buildReport(state, partial) {
    const t       = state.totals;
    const obs     = Math.max(1, t.ticksObserved);
    const ledger  = state.creepLedger;
    const own     = state.ownRoom;
    const elapsed = Game.time - state.startTick;

    // ── Income ─────────────────────────────────────────────────────────────
    const totalHarvested = Object.values(t.sourceHarvested).reduce((s, v) => s + v, 0);
    const maxIncome      = Object.values(t.sourceMaxRates).reduce((s, v) => s + v, 0);
    const incomePerTick  = Math.min(totalHarvested / obs, maxIncome);
    const sourceLines    = [];
    for (const sid in t.sourceMaxRates) {
        const harv = t.sourceHarvested[sid] || 0;
        const max  = t.sourceMaxRates[sid];
        const frac = max > 0 ? Math.min(1, harv / (obs * max)) : 0;
        sourceLines.push({
            label:    t.sourceNames[sid] + ' ' + shortId(sid),
            harvested: harv,
            rate:     harv / obs,
            maxRate:  max,
            util:     frac,
        });
    }
    sourceLines.sort((a, b) => b.harvested - a.harvested);

    // ── Derived consumption components ─────────────────────────────────────
    const linkLoss   = Math.max(0, t.linkDeposits - t.linkWithdraws - t.linkNetDelta);
    const extTermOut = Math.max(0, t.terminalSpend    - t.creepFromTerminal);
    const extTermIn  = Math.max(0, t.terminalReceived - t.creepToTerminal);

    const sumVals = obj => Object.values(obj).reduce((s, v) => s + v, 0);
    const towerTotal = sumVals(t.towerSpend);
    const labTotal   = sumVals(t.labSpend);

    // ── Creeps + groups ────────────────────────────────────────────────────
    const creeps = Object.values(ledger).map(e => {
        const lifetimeSpend = e.upgraded + e.built + e.repaired;
        return Object.assign({}, e, {
            lifetimeSpend,
            netCost:    e.preExisting ? lifetimeSpend : e.bodyCost + lifetimeSpend,
            roi:        e.bodyCost > 0 ? (e.harvested + lifetimeSpend) / e.bodyCost : 0,
            ticksAlive: (e.diedAtTick || Game.time) - e.ticksFirstSeen + 1,
        });
    });

    const creepActionTotal = creeps.reduce((s, c) =>
        s + c.upgraded + c.built + c.repaired, 0);
    const tombstoneDespawnLoss = creeps.reduce((s, c) =>
        s + (c.tombstoneDespawned ? Math.max(0, c.diedLoaded - c.tombstoneLooted) : 0), 0);

    const creepGroups = groupCreepsByNameSimilarity(creeps, SIMILARITY_THRESHOLD)
        .map(aggregateCreepGroup)
        .sort((a, b) => b.total - a.total);

    // ── Mass balance ───────────────────────────────────────────────────────
    const deltaRoom = t.finalRoomTotal - t.initialRoomTotal;
    const knownConsumption =
          towerTotal + labTotal + linkLoss + extTermOut
        + t.nukerSpend + t.powerSpawnSpend
        + t.workSpawnCost + t.nonWorkSpawnCost
        + creepActionTotal;
    const loss = totalHarvested + extTermIn - deltaRoom - knownConsumption;

    // ── Consumption table items ────────────────────────────────────────────
    const items = [];
    if (extTermOut > 0)         items.push({ label: 'Terminal (export)',    energy: extTermOut });
    items.push({                                label: 'Loss (unattributed)', energy: loss });
    if (creepActionTotal > 0)   items.push({ label: 'Creep work actions',  energy: creepActionTotal });
    if (t.nonWorkSpawnCost > 0) items.push({ label: 'Non-WORK spawn cost', energy: t.nonWorkSpawnCost });
    if (t.workSpawnCost > 0)    items.push({ label: 'WORK spawn cost',     energy: t.workSpawnCost });
    if (linkLoss > 0)           items.push({ label: 'Link network loss',   energy: linkLoss });
    if (towerTotal > 0)         items.push({ label: 'Towers',              energy: towerTotal });
    if (labTotal > 0)           items.push({ label: 'Labs',                energy: labTotal });
    if (t.nukerSpend > 0)       items.push({ label: 'Nuker',               energy: t.nukerSpend });
    if (t.powerSpawnSpend > 0)  items.push({ label: 'Power Spawn',         energy: t.powerSpawnSpend });

    items.sort((a, b) => b.energy - a.energy);

    const grossOutflow = items.filter(i => i.energy > 0).reduce((s, i) => s + i.energy, 0);
    const netConsumed  = totalHarvested + extTermIn - deltaRoom;
    const usingGross   = loss < 0;
    const denom        = Math.max(1, usingGross ? grossOutflow : netConsumed);
    const denomLabel   = usingGross ? 'gross outflow' : 'total';

    // ── Format lines ───────────────────────────────────────────────────────
    const W   = 78;
    const sep = '\u2500'.repeat(W);
    const L   = [];

    L.push('\u256C' + '\u2550'.repeat(W) + '\u256C');
    L.push('  ENERGY PROFILE — ' + state.roomName +
        '  [' + (own ? 'OWN ROOM' : state.observerCount + ' observer(s)') + ']' +
        (partial ? '   ⚠ PARTIAL' : ''));
    L.push('  ' + obs + ' / ' + PROFILE_TICKS + ' diff ticks   ' +
        '(game ' + state.startTick + '→' + (state.startTick + elapsed) +
        ', invisible=' + t.invisibleTicks + ')');
    L.push(sep);

    // ── INCOME ──
    L.push('  ── INCOME ──');
    L.push('  Harvested: ' + fmtNum(totalHarvested) + ' E   (' +
        f2(totalHarvested / obs) + '/tick, capped at ' + f2(maxIncome) +
        '   util ' + pct(maxIncome > 0 ? incomePerTick / maxIncome : 0) + ')');
    for (const s of sourceLines) {
        L.push('    ' + padR(s.label, 18) + '  ' +
            padL(fmtNum(s.harvested), 8) + ' E   ' +
            padL(f2(s.rate), 6) + ' / ' + f2(s.maxRate) + ' E/t   ' +
            padL(pct(s.util), 7));
    }
    L.push(sep);

    // ── TOTAL CONSUMPTION ──
    const totalLabel = usingGross
        ? 'gross outflow ' + fmtNum(grossOutflow) + ' E (loss ' + fmtNum(loss) + ' reconciles to net ' + fmtNum(netConsumed) + ')'
        : fmtNum(netConsumed) + ' E   (' + f2(netConsumed / obs) + '/tick)';
    L.push('  ── TOTAL CONSUMPTION ── ' + totalLabel);
    L.push('    ' + padR('Sink', 28) + padL('Energy', 10) + '   ' + padL('% ' + denomLabel, 14) + '   /tick');
    for (const it of items) {
        const isLossRow = it.label.indexOf('Loss') === 0;
        const pctStr = (isLossRow && usingGross)
            ? 'reconciles'
            : fmtPctSafe(it.energy, denom);
        L.push('    ' + padR(it.label, 28) +
            padL(fmtNum(it.energy), 10) + '   ' +
            padL(pctStr, 14) + '   ' +
            padL(f2(it.energy / obs), 7));
    }
    L.push(sep);

    // ── CREEP GROUPS ──
    const totalGroupContribution = creepGroups.reduce((s, g) => s + g.total, 0);
    L.push('  ── CREEP GROUPS (50% name similarity) ──   ' +
        creepGroups.length + ' group(s), ' + creeps.length + ' creep(s) tracked, ' +
        fmtNum(totalGroupContribution) + ' E contribution');
    if (!creepGroups.length) {
        L.push('    (no WORK creeps observed)');
    } else {
        L.push('    ' + padR('Group', 22) + padL('Cnt', 4) + '  ' +
            padR('Body', 12) + padR('Role', 14) +
            padL('Harv', 7) + padL('Upg', 7) + padL('Bld', 6) +
            padL('Rep', 6) + padL('Total', 7) + '  Notes');
        for (const g of creepGroups) {
            const notes = [];
            if (g.numPreExisting === g.count) notes.push('all pre-existing');
            else if (g.numPreExisting > 0)    notes.push(g.numPreExisting + ' pre-existing');
            if (g.numDied > 0)                notes.push(g.numDied + ' died');
            if (g.tombstoneLoss > 0)          notes.push('lost ' + fmtNum(g.tombstoneLoss));
            L.push('    ' + padR(g.label, 22) + padL(String(g.count), 4) + '  ' +
                padR(g.bodySig, 12) + padR(g.role, 14) +
                padL(fmtNum(g.harvested), 7) + padL(fmtNum(g.upgraded), 7) +
                padL(fmtNum(g.built), 6) + padL(fmtNum(g.repaired), 6) +
                padL(fmtNum(g.total), 7) + '  ' + (notes.join(', ') || ''));
        }
        L.push('    ' + '\u2508'.repeat(74));
        // Members listing for groups with multiple creeps or non-trivial label
        for (const g of creepGroups) {
            if (g.count <= 1 && g.label === g.members[0].name) continue;
            const memberStrs = g.members.map(m => {
                const dead = m.diedAtTick !== null ? '†' : '';
                return (m.name || shortId(m.id)) + dead;
            });
            const line = '      ' + padR(g.label + ':', 22) + memberStrs.join(', ');
            // Wrap long member lines
            if (line.length <= 90) {
                L.push(line);
            } else {
                // split into multiple lines
                const head = '      ' + padR(g.label + ':', 22);
                let row = head;
                for (let i = 0; i < memberStrs.length; i++) {
                    const piece = memberStrs[i] + (i < memberStrs.length - 1 ? ', ' : '');
                    if (row.length + piece.length > 90 && row !== head) {
                        L.push(row);
                        row = ' '.repeat(head.length) + piece;
                    } else {
                        row += piece;
                    }
                }
                if (row.trim().length > 0) L.push(row);
            }
        }
        L.push('    † = died during window');
    }
    L.push(sep);

    // ── Mass balance check ──
    const accountedFor  = knownConsumption + loss;
    const expectedTotal = totalHarvested + extTermIn - deltaRoom;
    L.push('  ── MASS BALANCE ──');
    L.push('    Income + extTermIn − ΔRoom            = ' + fmtNum(expectedTotal));
    L.push('    Accounted (consumption + loss)        = ' + fmtNum(accountedFor));
    L.push('    Δ room non-source energy              = ' + fmtNum(deltaRoom) +
        '  (initial ' + fmtNum(t.initialRoomTotal) +
        ', final ' + fmtNum(t.finalRoomTotal) + ')');
    if (extTermIn > 0) {
        L.push('    External terminal IN                  = ' + fmtNum(extTermIn));
    }
    if (Math.abs(loss) > 0.05 * Math.max(1, totalHarvested)) {
        L.push('    ⚠ Large residual: ' + fmtNum(loss) + ' E (' +
            ((Math.abs(loss) / Math.max(1, totalHarvested)) * 100).toFixed(1) +
            '% of harvest) — attribution may be incomplete');
    }
    L.push('\u2569' + '\u2550'.repeat(W) + '\u2569');

    return {
        lines: L,
        summary: {
            obs, totalHarvested, incomePerTick, maxIncome,
            netConsumed, grossOutflow, usingGross, denomLabel,
            items, creepGroups, sourceLines,
            linkLoss, creepActionTotal,
            workSpawn: t.workSpawnCost, nonWorkSpawn: t.nonWorkSpawnCost,
            extTermIn, extTermOut,
            loss, deltaRoom,
            initialRoomTotal: t.initialRoomTotal,
            finalRoomTotal:   t.finalRoomTotal,
            tombstoneDespawnLoss,
        },
    };
}

function printReport(state, partial) {
    const r = buildReport(state, partial);
    console.log(r.lines.join('\n'));
    return r.lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION CHUNKING
//
// Mirrors warEstimate.js's splitNotifications: reserve ≈50 chars for the
// "[EnergyProfile: roomName] Part N/M\n" header, hard-wrap any single line
// longer than the budget, then greedily pack lines into chunks ≤ budget.
// Lines containing pure box-drawing characters are dropped to save bandwidth
// (the report retains them; notifications don't need them).
// ═══════════════════════════════════════════════════════════════════════════

const BOX_DROP_RE = /^[\s\u2500\u2508\u2550\u2569\u256C]+$/;

function stripBoxLines(lines) {
    const out = [];
    for (const line of lines) {
        if (BOX_DROP_RE.test(line)) continue;
        out.push(line);
    }
    return out;
}

function splitNotifications(lines, roomName) {
    const budget = NOTIFY_TOTAL_MAX;
    const cleaned = stripBoxLines(lines);

    // Hard-wrap any line longer than budget
    const expanded = [];
    for (const line of cleaned) {
        if (line.length <= budget) {
            expanded.push(line);
        } else {
            let remaining = line;
            while (remaining.length > budget) {
                let cut = remaining.lastIndexOf(' ', budget);
                if (cut <= 0) cut = budget;
                expanded.push(remaining.slice(0, cut));
                remaining = remaining.slice(cut).replace(/^\s+/, '');
            }
            if (remaining.length > 0) expanded.push(remaining);
        }
    }

    // Greedy packing
    const chunks = [];
    let current  = '';
    for (const line of expanded) {
        const needed = current.length > 0 ? current.length + 1 + line.length : line.length;
        if (needed > budget && current.length > 0) {
            chunks.push(current);
            current = line;
        } else {
            current = current.length > 0 ? current + '\n' + line : line;
        }
    }
    if (current.length > 0) chunks.push(current);
    if (chunks.length === 0) chunks.push('(empty report)');

    const total = chunks.length;
    return chunks.map((body, i) =>
        '[EnergyProfile: ' + roomName + '] Part ' + (i + 1) + '/' + total + '\n' + body
    );
}

function runNotifyPhase(state) {
    const queue = state.notifyQueue || [];
    const toSend = Math.min(NOTIFY_PER_TICK, queue.length - state.notifySent);
    for (let i = 0; i < toSend; i++) {
        Game.notify(queue[state.notifySent], 0);
        state.notifySent++;
    }
    if (state.notifySent >= queue.length) {
        console.log('[EnergyProfiler] All ' + state.notifySent +
            ' notification chunk(s) sent for ' + state.roomName +
            ' (' + (Game.time - state.startTick) + ' ticks total).');
        delete Memory[MEM_KEY];
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    start,
    cancel,
    run,
    status,
};